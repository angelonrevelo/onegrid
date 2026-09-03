// =============================================================================
// Identifier + literal quoting.
//
// Every string that reaches a DDL statement in this package passes through
// one of these functions. The idiom matches
// `packages/adapters/postgres/src/sql.ts` — double-quote the identifier and
// double any embedded quote — but the studio has a harder problem than the
// block-query compiler does.
//
// The block-query compiler could whitelist every identifier against a table
// descriptor supplied by the adopter, because it never invents names. A table
// editor DOES invent names: the whole point is that a human types "user_note"
// into a New Table dialog and a CREATE TABLE comes out. So the identifier IS
// user input, and the guard has to hold on its own rather than leaning on a
// whitelist.
//
// Two layers:
//
//   1. `sqlSafeIdentifier` rejects what quoting cannot save us from — an
//      empty name, a NUL byte (Postgres strings are NUL-terminated on the
//      wire, so an embedded NUL truncates the statement), and a name past
//      NAMEDATALEN-1 = 63 bytes (Postgres silently TRUNCATES longer names,
//      which can collapse two distinct columns into one — a correctness bug,
//      not a style nit).
//   2. Everything that survives is emitted double-quoted with `"` doubled.
//      A quoted identifier in Postgres ends only at an unpaired `"`, so once
//      the doubling is applied there is no byte sequence that closes the
//      quote early. `"; DROP TABLE x; --` becomes the single identifier
//      """; DROP TABLE x; --" — a column with a silly name, not a statement
//      boundary.
//
// Literals are a separate problem. Postgres does NOT accept bind parameters
// in utility (DDL) statements — `COMMENT ON TABLE t IS $1` is a syntax error,
// and there is no plan to make it work. So DDL literals go through
// `sqlLiteral`, which doubles `'` and switches to the E'' escape-string form
// when a backslash is present (because `standard_conforming_strings` can be
// off on an old server, and E'' is unambiguous under both settings). DML is a
// plannable statement, so it uses real `$n` binds everywhere — see `dml.ts`.
// =============================================================================

/** Postgres NAMEDATALEN is 64; the usable identifier length is 63 bytes. */
const MAX_IDENTIFIER_BYTE = 63;

const NUL = '\u0000';

const UTF8 = new TextEncoder();

/**
 * Validate and double-quote a single SQL identifier.
 *
 * Throws on an empty name, a name containing a NUL byte, and a name longer
 * than Postgres' 63-byte identifier limit. Everything else is quoted, with
 * embedded `"` doubled, and is therefore inert.
 *
 * @param name - the raw identifier, exactly as a human typed it
 * @returns the quoted identifier, including the surrounding double quotes
 * @public
 */
export function sqlSafeIdentifier(name: string): string {
  if (typeof name !== 'string') {
    throw new Error('@onegrid/studio: identifier must be a string.');
  }
  if (name.length === 0) {
    throw new Error('@onegrid/studio: identifier must not be empty.');
  }
  if (name.includes(NUL)) {
    // A NUL truncates the statement at the protocol layer, so no amount of
    // quoting downstream contains it. Reject rather than strip — silently
    // renaming a column is worse than failing loudly.
    throw new Error('@onegrid/studio: identifier must not contain a NUL byte.');
  }
  const byteLength = UTF8.encode(name).length;
  if (byteLength > MAX_IDENTIFIER_BYTE) {
    throw new Error(
      `@onegrid/studio: identifier "${name}" is ${String(byteLength)} bytes; Postgres truncates past ${String(MAX_IDENTIFIER_BYTE)}.`,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a schema-qualified name. Each segment is validated and quoted
 * independently, so a dot inside a name is data, not a separator — pass
 * `qualifiedIdentifier('public', 'a.b')` and you get `"public"."a.b"`.
 * Omit the schema to emit a bare identifier and let `search_path` resolve it.
 * @public
 */
export function qualifiedIdentifier(
  schema: string | null | undefined,
  name: string,
): string {
  const quotedName = sqlSafeIdentifier(name);
  if (schema === null || schema === undefined || schema === '') return quotedName;
  return `${sqlSafeIdentifier(schema)}.${quotedName}`;
}

/**
 * Quote a string literal for a statement position that cannot take a bind
 * parameter — which, in Postgres, is every DDL position.
 *
 * Uses the E'' escape-string form when the value contains a backslash so the
 * result is unambiguous whether or not `standard_conforming_strings` is on.
 * @public
 */
export function sqlLiteral(value: string): string {
  if (value.includes(NUL)) {
    throw new Error('@onegrid/studio: string literal must not contain a NUL byte.');
  }
  const doubled = value.replace(/'/g, "''");
  if (doubled.includes('\\')) {
    return `E'${doubled.replace(/\\/g, '\\\\')}'`;
  }
  return `'${doubled}'`;
}

/**
 * True when the identifier could legally be written unquoted in Postgres —
 * lowercase ASCII start, then lowercase/digit/underscore/dollar, and not a
 * reserved word. Purely informational: this package always quotes. A UI uses
 * it to warn that naming a table `Order` means quoting it forever after.
 * @public
 */
export function isBareIdentifier(name: string): boolean {
  if (!/^[a-z_][a-z0-9_$]*$/.test(name)) return false;
  return !RESERVED_WORD.has(name);
}

// The subset of Postgres reserved words a table editor realistically collides
// with. Deliberately not exhaustive — `isBareIdentifier` is advisory, and the
// quoting is what makes the emitted statement correct.
const RESERVED_WORD = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'authorization',
  'between', 'binary', 'both', 'case', 'cast', 'check', 'collate', 'column',
  'constraint', 'create', 'cross', 'current_date', 'current_role', 'current_time',
  'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct',
  'do', 'else', 'end', 'except', 'false', 'for', 'foreign', 'freeze', 'from',
  'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner',
  'intersect', 'into', 'is', 'isnull', 'join', 'leading', 'left', 'like', 'limit',
  'localtime', 'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset',
  'on', 'only', 'or', 'order', 'outer', 'overlaps', 'placing', 'primary',
  'references', 'returning', 'right', 'select', 'session_user', 'similar', 'some',
  'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique',
  'user', 'using', 'verbose', 'when', 'where', 'window', 'with',
]);

/**
 * Validate a raw SQL fragment the adopter supplies for a position where
 * Postgres requires an expression rather than a value — a CHECK body, an RLS
 * `USING` clause, a column default, an index predicate, a `USING` cast.
 *
 * These positions are neither parameterisable nor quotable: a check
 * constraint is an expression by definition, so no encoding makes arbitrary
 * text safe there. The only honest contract is that the fragment is trusted
 * code. This function enforces the floor — no statement terminator, no
 * comment introducer, no NUL — so a fragment cannot smuggle a second
 * statement into a simple-query round trip even when the caller is careless.
 * @public
 */
export function sqlSafeExpression(expression: string): string {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new Error('@onegrid/studio: SQL expression must not be empty.');
  }
  if (trimmed.includes(NUL)) {
    throw new Error('@onegrid/studio: SQL expression must not contain a NUL byte.');
  }
  if (trimmed.includes(';')) {
    throw new Error(
      `@onegrid/studio: SQL expression must not contain ";" (it would open a second statement): ${trimmed}`,
    );
  }
  if (trimmed.includes('--') || trimmed.includes('/*')) {
    throw new Error(
      `@onegrid/studio: SQL expression must not contain a comment introducer: ${trimmed}`,
    );
  }
  return trimmed;
}

/**
 * Validate a Postgres type name written as it appears in DDL — `text`,
 * `numeric(10,2)`, `timestamptz`, `public.mood`, `text[]`, `varchar(255)[]`.
 *
 * A type name is a third position that is neither a plain identifier (it may
 * carry a modifier and array brackets) nor free expression text. It is
 * matched against a grammar rather than quoted, because quoting
 * `numeric(10,2)` would produce a type that does not exist.
 * @public
 */
export function sqlSafeTypeName(typeName: string): string {
  const trimmed = typeName.trim();
  if (trimmed.length === 0) {
    throw new Error('@onegrid/studio: type name must not be empty.');
  }
  // schema-qualified base name, optional (n) or (p,s) modifier, optional
  // whitespace-separated words (`double precision`, `with time zone`),
  // optional array brackets.
  const ok =
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?(\( *\d+ *(, *\d+ *)?\))?( +[A-Za-z][A-Za-z ]*[A-Za-z])?(\( *\d+ *(, *\d+ *)?\))?( *\[ *\d* *\])*$/.test(
      trimmed,
    );
  if (!ok) {
    throw new Error(`@onegrid/studio: invalid Postgres type name: ${trimmed}`);
  }
  return trimmed;
}
