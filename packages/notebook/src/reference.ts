// =============================================================================
// Reference extraction
//
// A cell depends on another cell by NAME, so the dependency graph is only as
// good as the scan that finds those names in a source string. A full parser
// per language is not on the table — the notebook must work with a DuckDB
// kernel and a GPU kernel it has never seen. What IS reliable is lexical
// structure that every one of these languages shares:
//
//   - identifiers are `[A-Za-z_][A-Za-z0-9_]*`
//   - string literals ('..', "..", `..`) contain no references
//   - comments (--, //, #, /* */) contain no references
//   - an identifier immediately followed by `(` is a call, not a reference
//     (this is what keeps a cell named `sum` from being "referenced" by
//     every `SUM(...)` in the notebook)
//
// We then intersect the harvested identifiers with the set of names that
// actually exist in the document. Anything unknown is simply not a
// dependency — the kernel decides whether it is an error.
//
// Markdown is the exception: prose is full of words, so a markdown cell
// references others only through explicit `{{name}}` interpolation.
// =============================================================================

import type { CellKind } from './types';

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

/** `{{ name }}` — the markdown interpolation form. */
const MUSTACHE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Name syntax a cell must satisfy to be referenceable. Deliberately
 * conservative: it is the intersection of what SQL, JS and the formula
 * grammar all accept as a bare identifier.
 */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True if `name` can be used as a cell name (and therefore referenced). */
export function isValidCellName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Every identifier in `source` that is not inside a string or comment and
 * is not the callee of a call expression. Order-preserving, deduplicated.
 */
export function scanIdentifier(source: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i]!;

    // --- string literals -----------------------------------------------
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(source, i, c);
      continue;
    }

    // --- comments ------------------------------------------------------
    if (c === '-' && source[i + 1] === '-') {
      i = skipToLineEnd(source, i);
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      i = skipToLineEnd(source, i);
      continue;
    }
    if (c === '#') {
      i = skipToLineEnd(source, i);
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // --- identifiers ---------------------------------------------------
    if (IDENTIFIER_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENTIFIER_PART.test(source[j]!)) j++;
      const word = source.slice(i, j);
      // A `.` before the identifier makes it a member access (`row.total`),
      // and a `(` after it makes it a callee. Neither is a cell reference.
      const isMember = i > 0 && source[i - 1] === '.';
      let k = j;
      while (k < n && (source[k] === ' ' || source[k] === '\t')) k++;
      const isCallee = source[k] === '(';
      if (!isMember && !isCallee && !seen.has(word)) {
        seen.add(word);
        found.push(word);
      }
      i = j;
      continue;
    }

    i++;
  }
  return found;
}

/** Every `{{name}}` interpolation in `source`, deduplicated, in order. */
export function scanMustache(source: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  MUSTACHE.lastIndex = 0;
  let m = MUSTACHE.exec(source);
  while (m !== null) {
    const word = m[1]!;
    if (!seen.has(word)) {
      seen.add(word);
      found.push(word);
    }
    m = MUSTACHE.exec(source);
  }
  return found;
}

/**
 * The names `source` references, restricted to names that exist.
 * A cell never depends on itself even if it mentions its own name — that
 * would be a trivial one-node cycle and it is always a typo.
 *
 * @public
 */
export function findReference(
  source: string,
  kind: CellKind,
  knownName: ReadonlySet<string>,
  selfName?: string,
): string[] {
  const candidate = kind === 'markdown' ? scanMustache(source) : scanIdentifier(source);
  return candidate.filter((name) => name !== selfName && knownName.has(name));
}

/** Substitute `{{name}}` with a resolved value. Unknown names are left alone. */
export function interpolate(source: string, resolve: (name: string) => unknown): string {
  return source.replace(MUSTACHE, (whole, name: string) => {
    const value = resolve(name);
    if (value === undefined) return whole;
    return formatValue(value);
  });
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function skipString(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    // SQL escapes a quote by doubling it.
    if (c === quote && source[i + 1] === quote) {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return source.length;
}

function skipToLineEnd(source: string, start: number): number {
  const end = source.indexOf('\n', start);
  return end === -1 ? source.length : end + 1;
}
