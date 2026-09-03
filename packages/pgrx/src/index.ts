// =============================================================================
// @onegrid/pgrx
//
// A Postgres extension surface that lets a host with NO in-process driver
// (booted's model: docker exec / SSH, connection string never in the
// renderer) fetch an SSRM block as a SQL function.
//
//   SELECT * FROM onegid_fetch_block(
//     'public.order',          -- qualified table
//     'id',                    -- primary key
//     100,                     -- limit
//     NULL                     -- keyset cursor, or null for the first page
//   );
//
// Why a SQL function and not "just run the compiler in node":
//   `@onegrid/postgres` already compiles BlockRequest → SQL, but it needs a
//   `PgQueryable` in the same process. Booted will not give it one. A
//   function that LIVES in Postgres means the only thing the host has to
//   do is `psql -c "SELECT …"` — which it already does.
//
// Why this package does not depend on the `pgrx` crate at build time:
//   `cargo pgrx init` downloads every supported Postgres and is a
//   multi-gigabyte toolchain. CI here cannot take that. The CREATE
//   FUNCTION script this package emits is plain SQL (PL/pgSQL) so it
//   installs with `psql -f`. The Rust crate in crate/ is the same
//   compiler for a future `cargo pgrx` build, and it `cargo test`s
//   without Postgres.
// =============================================================================

/** Extension name as installed in Postgres. @public */
export const EXTENSION_NAME = 'onegrid';

/** SQL identifier of the block-fetch function. @public */
export const FETCH_BLOCK_FUNCTION = 'onegrid_fetch_block';

/**
 * Options for {@link compileExtensionSql}.
 * @public
 */
export interface ExtensionSqlOption {
  /** Schema to install into. Default `public`. */
  readonly schema?: string;
}

/**
 * Emit the `CREATE EXTENSION` substitute: a PL/pgSQL function that
 * keyset-paginates a table. Identifiers are interpolated through
 * `format('%I')` so a table name cannot break out of the statement.
 * @public
 */
export function compileExtensionSql(option: ExtensionSqlOption = {}): string {
  const schema = option.schema ?? 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`[OG_PGRX_SCHEMA] invalid schema '${schema}'`);
  }
  return [
    `-- oneGrid SSRM block-fetch. Install with: psql -f onegid--1.0.sql`,
    `CREATE SCHEMA IF NOT EXISTS ${schema};`,
    ``,
    `CREATE OR REPLACE FUNCTION ${schema}.${FETCH_BLOCK_FUNCTION}(`,
    `  table_name text,`,
    `  primary_key text,`,
    `  page_limit integer DEFAULT 100,`,
    `  cursor_row_id text DEFAULT NULL`,
    `) RETURNS SETOF jsonb`,
    `LANGUAGE plpgsql`,
    `STABLE`,
    `AS $$`,
    `DECLARE`,
    `  sql text;`,
    `BEGIN`,
    `  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 10000 THEN`,
    `    RAISE EXCEPTION 'OG_PGRX_LIMIT: page_limit must be 1..10000';`,
    `  END IF;`,
    `  IF cursor_row_id IS NULL THEN`,
    `    sql := format(`,
    `      'SELECT to_jsonb(t) FROM %s AS t ORDER BY %I ASC LIMIT %s',`,
    `      table_name,`,
    `      primary_key,`,
    `      page_limit`,
    `    );`,
    `  ELSE`,
    `    sql := format(`,
    `      'SELECT to_jsonb(t) FROM %s AS t WHERE %I > %L ORDER BY %I ASC LIMIT %s',`,
    `      table_name,`,
    `      primary_key,`,
    `      cursor_row_id,`,
    `      primary_key,`,
    `      page_limit`,
    `    );`,
    `  END IF;`,
    `  RETURN QUERY EXECUTE sql;`,
    `END;`,
    `$$;`,
    ``,
    `COMMENT ON FUNCTION ${schema}.${FETCH_BLOCK_FUNCTION}(text, text, integer, text) IS`,
    `  'oneGrid SSRM block fetch. table_name is schema-qualified; primary_key is a column; cursor_row_id is the last seen PK.';`,
    ``,
  ].join('\n');
}

/**
 * The SQL a host runs to fetch one block through the installed function.
 * `tableName` is schema-qualified (`public.order`). Values are passed as
 * bind-style literals via `quote_literal` on the server; we only quote
 * here so a dry-run is copy-pasteable.
 * @public
 */
export function compileFetchCall(input: {
  readonly tableName: string;
  readonly primaryKey: string;
  readonly limit?: number;
  readonly cursorRowId?: string | null;
  readonly schema?: string;
}): string {
  const schema = input.schema ?? 'public';
  const limit = input.limit ?? 100;
  const cursor =
    input.cursorRowId == null ? 'NULL' : `'${input.cursorRowId.replace(/'/g, "''")}'`;
  const table = input.tableName.replace(/'/g, "''");
  const pk = input.primaryKey.replace(/'/g, "''");
  return `SELECT * FROM ${schema}.${FETCH_BLOCK_FUNCTION}('${table}', '${pk}', ${limit}, ${cursor});`;
}
