// =============================================================================
// SQL editor support.
//
// Splitting a script on `;` is wrong, and it is wrong in ways that bite
// exactly when a user pastes something real. The lexer below is a single
// forward pass with an explicit mode, handling every construct in which a
// semicolon is NOT a statement boundary:
//
//   'literal'       — a single-quoted string; `''` is an escaped quote, and
//                     Postgres also lets a string continue across a newline
//                     when two literals are separated by whitespace
//                     containing a newline. We do not need to merge those,
//                     because each is scanned as its own literal and neither
//                     contains a boundary.
//   E'literal'      — escape-string syntax, where `\'` also escapes a quote.
//                     Handled by tracking whether the literal was introduced
//                     by E/e, because in a standard-conforming literal a
//                     backslash is an ordinary character and treating it as
//                     an escape would desynchronise the scanner.
//   "identifier"    — `""` is an escaped quote.
//   $$ ... $$       — a dollar-quoted body, which is how every function,
//   $tag$ ... $tag$   procedure and DO block is written. This is the case
//                     that makes naive splitters fail on real migrations:
//                     the body is full of semicolons and the terminator is a
//                     tag chosen by the author. A dollar quote ends ONLY at
//                     its exact matching tag, so `$$ ... $x$ ... $$` is one
//                     literal, and `$1` is a bind parameter rather than an
//                     opening tag (a tag body may not start with a digit).
//   -- comment      — to end of line.
//   /* comment */   — and these NEST in Postgres, unlike C. A depth counter
//                     is required; a scan for the first `*/` gets
//                     `/* a /* b */ c */` wrong.
//
// The splitter returns byte offsets alongside the text so an editor can map
// a statement back to a selection, and a 1-based line number so an error
// from the server can be attributed to the right statement.
// =============================================================================

/** One statement located inside a script.
 * @public
 */
export interface SqlStatement {
  /** Statement text with surrounding whitespace trimmed and the trailing
   *  semicolon removed. */
  readonly text: string;
  /** Offset of the first character of `text` within the original script. */
  readonly start: number;
  /** Offset one past the last character of `text`. */
  readonly end: number;
  /** 1-based line on which the statement starts. */
  readonly line: number;
}

/**
 * Split a SQL script into statements.
 *
 * Whitespace-only and comment-only segments are dropped — a trailing
 * semicolon at the end of a file must not produce an empty statement that a
 * runner then sends to the server. A statement whose text is entirely
 * comments is also dropped, for the same reason.
 * @public
 */
export function splitStatement(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let segmentStart = 0;
  let i = 0;
  const n = sql.length;

  const push = (endExclusive: number): void => {
    const raw = sql.slice(segmentStart, endExclusive);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) return;
    if (isCommentOnly(text)) return;
    const start = segmentStart + leading;
    out.push({
      text,
      start,
      end: start + text.length,
      line: lineOf(sql, start),
    });
  };

  while (i < n) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i);
      if (i === -1) i = n;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest, so count depth rather than scanning
      // for the first terminator.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }

    if (ch === "'") {
      // A leading E/e turns the literal into escape-string syntax, in which
      // a backslash escapes the following character.
      const escapeString = isEscapeStringIntroducer(sql, i);
      i++;
      while (i < n) {
        const c = sql[i];
        if (escapeString && c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '$') {
      const tag = readDollarTag(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        // An unterminated dollar quote runs to end of script. Consuming the
        // rest is the right recovery: it keeps the half-typed function body
        // in one statement instead of shattering it on every semicolon.
        i = close === -1 ? n : close + tag.length;
        continue;
      }
      i++;
      continue;
    }

    if (ch === ';') {
      push(i);
      i++;
      segmentStart = i;
      continue;
    }

    i++;
  }

  push(n);
  return out;
}

/** Read a dollar-quote opening tag at `index`, or null when the `$` is not
 *  one — `$1` is a bind parameter, and `$` followed by a digit can never
 *  start a tag. */
function readDollarTag(sql: string, index: number): string | null {
  let j = index + 1;
  while (j < sql.length) {
    const c = sql[j] ?? '';
    if (c === '$') return sql.slice(index, j + 1);
    // A tag body is an identifier: letter or underscore first, then
    // alphanumerics and underscores.
    const isFirst = j === index + 1;
    const ok = isFirst
      ? /[A-Za-z_\u0080-\uffff]/.test(c)
      : /[A-Za-z0-9_\u0080-\uffff]/.test(c);
    if (!ok) return null;
    j++;
  }
  return null;
}

function isEscapeStringIntroducer(sql: string, quoteIndex: number): boolean {
  const previous = sql[quoteIndex - 1];
  if (previous !== 'E' && previous !== 'e') return false;
  // Only an E that is not itself part of a longer identifier introduces an
  // escape string: `name='x'` must not be read as escape syntax.
  const beforeE = sql[quoteIndex - 2];
  if (beforeE === undefined) return true;
  return !/[A-Za-z0-9_]/.test(beforeE);
}

function isCommentOnly(text: string): boolean {
  return stripComment(text).trim().length === 0;
}

function lineOf(sql: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === '\n') line++;
  }
  return line;
}

/**
 * Remove comments from a SQL fragment, leaving string and dollar-quoted
 * literals untouched. Exported because a UI that wants to show "what will
 * actually run" needs the same lexer the splitter uses.
 * @public
 */
export function stripComment(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] ?? '';
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const escapeString = quote === "'" && isEscapeStringIntroducer(sql, i);
      out += ch;
      i++;
      while (i < n) {
        const c = sql[i] ?? '';
        if (escapeString && c === '\\') {
          out += c + (sql[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += c;
        if (c === quote) {
          if (sql[i + 1] === quote) {
            out += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '$') {
      const tag = readDollarTag(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

/** What a statement does to the database.
 *
 *  - `read`    — returns rows and changes nothing.
 *  - `write`   — changes rows.
 *  - `ddl`     — changes the schema (or grants, or transaction state).
 *  - `unknown` — not recognised; a UI should treat it as a write, since
 *                assuming read is the assumption that loses data.
 * @public
 */
export type StatementClass = 'read' | 'write' | 'ddl' | 'unknown';

const READ_KEYWORD = new Set(['select', 'table', 'values', 'show', 'fetch']);

const WRITE_KEYWORD = new Set([
  'insert', 'update', 'delete', 'merge', 'truncate', 'copy', 'call', 'do', 'refresh',
]);

const DDL_KEYWORD = new Set([
  'create', 'alter', 'drop', 'comment', 'grant', 'revoke', 'begin', 'commit',
  'rollback', 'savepoint', 'start', 'set', 'reset', 'vacuum', 'analyze',
  'analyse', 'reindex', 'cluster', 'lock', 'listen', 'notify', 'unlisten',
  'prepare', 'deallocate', 'discard', 'security', 'import', 'checkpoint',
]);

/**
 * Classify a statement so a UI can warn before it runs something that
 * writes.
 *
 * Three cases are worth more than a keyword table:
 *
 *   - **`WITH ... ` is not automatically a read.** A data-modifying CTE
 *     (`WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d`) is a write
 *     wearing a SELECT's clothes, and it is the single most common way a
 *     "this is just a query" assumption destroys data. The CTE body is
 *     scanned for a modifying keyword.
 *   - **`EXPLAIN ANALYZE` executes the statement.** Plain `EXPLAIN` does
 *     not. So `EXPLAIN` is classified by recursing on its payload only when
 *     `ANALYZE` is present; otherwise it is a read.
 *   - **`SELECT ... INTO`** creates a table, so it is DDL, not a read.
 *
 * Comments and leading whitespace are stripped first, so a statement that
 * opens with a licence header still classifies correctly.
 * @public
 */
export function classifyStatement(sql: string): StatementClass {
  const text = stripComment(sql).trim();
  if (text.length === 0) return 'unknown';

  const first = firstWord(text);
  if (first === '') return 'unknown';

  if (first === 'explain') {
    const rest = text.trimStart().slice(first.length).trim();
    // EXPLAIN ANALYZE actually runs the statement; EXPLAIN alone does not.
    if (/^(analyze|analyse|\([^)]*\banaly[sz]e\b)/i.test(rest)) {
      return classifyStatement(stripExplainOption(rest));
    }
    return 'read';
  }

  if (first === 'with') {
    // A CTE list can contain INSERT / UPDATE / DELETE / MERGE, which makes
    // the whole statement a write regardless of what follows the CTE.
    if (/\b(insert|update|delete|merge)\b/i.test(text)) return 'write';
    return 'read';
  }

  if (first === 'select') {
    // SELECT ... INTO new_table creates a relation.
    if (/\binto\b/i.test(text) && !/\binto\s+strict\b/i.test(text)) return 'ddl';
    return 'read';
  }

  if (READ_KEYWORD.has(first)) return 'read';
  if (WRITE_KEYWORD.has(first)) return 'write';
  if (DDL_KEYWORD.has(first)) return 'ddl';
  return 'unknown';
}

function stripExplainOption(rest: string): string {
  if (rest.startsWith('(')) {
    const close = rest.indexOf(')');
    return close === -1 ? rest : rest.slice(close + 1).trim();
  }
  return rest.replace(/^(analyze|analyse|verbose|costs|buffers|\s)+/i, '').trim();
}

function firstWord(text: string): string {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.trimStart());
  return match === null ? '' : match[0].toLowerCase();
}

/** Split a script and classify every statement in one pass — what a SQL
 *  editor calls before showing "this script contains 2 writes".
 * @public
 */
export function classifyScript(
  sql: string,
): { readonly statement: SqlStatement; readonly kind: StatementClass }[] {
  return splitStatement(sql).map((statement) => ({
    statement,
    kind: classifyStatement(statement.text),
  }));
}
