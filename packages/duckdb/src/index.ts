// =============================================================================
// @onegrid/duckdb
//
// DuckDB-WASM-backed DataSource for oneGrid. Translates BlockRequest into
// SQL, runs it against an existing AsyncDuckDB instance, and returns rows
// in oneGrid's protocol shape.
//
// Two construction modes:
//
//   createDuckDbDataSource({ db, source: 'SELECT * FROM events' })
//   createDuckDbDataSource({ db, source: 'events', idColumn: 'id' })
//
// `source` can be a table name, view, or arbitrary SELECT. The adapter
// wraps it as `(SELECT * FROM source)` so DDL stays unaffected.
//
// DuckDB is declared as an *optional* peer dependency (`@duckdb/duckdb-wasm`).
// Consumers who don't pass a `db` won't pull SheetJS-style imports — the
// types are imported via `import type` so they erase at runtime.
//
// What's wired:
//   - schema()       — DESCRIBE-derived ColumnSchema[]; user can override.
//   - fetchBlock()   — sort + filter + offset pagination, plus a parallel
//                      COUNT(*) for totalRowCount on every fetch (lets the
//                      grid resize the scroll spacer when filters narrow).
//   - fetchDistinct() — GROUP BY + COUNT(*) for set-filter value lists.
//
// Not yet:
//   - subscribe / live updates (DuckDB doesn't push)
//   - mutate (DuckDB write paths exist but the demo is read-only)
//   - GROUP BY / pivot via the protocol (the SQL is open if a caller pre-
//     wraps `source` with their own aggregation)
// =============================================================================

import type {
  AsyncDuckDB,
  AsyncDuckDBConnection,
} from '@duckdb/duckdb-wasm';
import type {
  BlockRequest,
  BlockResponse,
  ColumnSchema,
  ColumnType,
  DataSource,
  DistinctRequest,
  DistinctResult,
  FetchOptions,
  Schema,
} from '@onegrid/protocol';

import {
  buildBlockSql,
  buildCountSql,
  buildDistinctSql,
  buildSchemaSql,
  encodeOffsetCursor,
  parseOffsetCursor,
} from './sql';

/** @public */
export interface DuckDbDataSourceOptions {
  /**
   * AsyncDuckDB instance. The adapter doesn't construct DuckDB itself —
   * it accepts whatever the caller has bootstrapped.
   */
  readonly db: AsyncDuckDB;
  /**
   * Either a table/view name (`"events"`) or a parenthesizable SELECT
   * (`"(SELECT * FROM events WHERE region='emea')"`). The adapter wraps
   * this as `(SELECT * FROM source)` for nesting safety.
   */
  readonly source: string;
  /**
   * Column id used as a stable secondary order. Required for deterministic
   * pagination when the active sort has ties.
   */
  readonly idColumn?: string;
  /**
   * Override the auto-derived schema. Useful when DESCRIBE doesn't carry
   * the precision/timezone you want oneGrid to expose, or when the source
   * is too dynamic for static introspection.
   */
  readonly schema?: Schema;
  /** Default page size if a request omits `limit`. Default 200. */
  readonly defaultLimit?: number;
}

/** @public */
export interface DuckDbDataSourceHandle extends DataSource {
  /** Current schema (cached after first resolution). */
  readonly schema: () => Promise<Schema>;
  /** Force-close the underlying connection. Idempotent. */
  readonly close: () => Promise<void>;
}

/** @public */
export function createDuckDbDataSource(
  options: DuckDbDataSourceOptions,
): DuckDbDataSourceHandle {
  const defaultLimit = options.defaultLimit ?? 200;
  const wrappedSource = `(SELECT * FROM ${options.source})`;

  let connection: AsyncDuckDBConnection | null = null;
  let schemaCache: Schema | null = options.schema ?? null;
  let closed = false;

  async function getConnection(): Promise<AsyncDuckDBConnection> {
    if (closed) throw new Error('@onegrid/duckdb: data source is closed.');
    if (connection) return connection;
    connection = await options.db.connect();
    return connection;
  }

  async function schema(): Promise<Schema> {
    if (schemaCache) return schemaCache;
    const conn = await getConnection();
    const sql = buildSchemaSql(wrappedSource);
    const result = await runQuery(conn, sql, []);
    schemaCache = arrowSchemaResultToSchema(result);
    return schemaCache;
  }

  async function fetchBlock(
    req: BlockRequest,
    opts?: FetchOptions,
  ): Promise<BlockResponse<'json'>> {
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    const conn = await getConnection();

    const blockSqlPart = buildBlockSql({
      source: wrappedSource,
      request: req,
      defaultLimit,
      ...(options.idColumn !== undefined ? { idColumn: options.idColumn } : {}),
    });
    const countSqlPart = buildCountSql({ source: wrappedSource, request: req });

    // DuckDB-WASM's `Connection.query()` takes raw SQL with no parameters;
    // for parameterized queries we go through `prepare()` + the prepared
    // statement's `query()` method. Running data + count in parallel saves
    // one round-trip's latency.
    const [dataResult, countResult] = await Promise.all([
      runQuery(conn, blockSqlPart.sql, blockSqlPart.params),
      runQuery(conn, countSqlPart.sql, countSqlPart.params),
    ]);
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }

    const limit = req.limit > 0 ? req.limit : defaultLimit;
    const startOffset =
      req.direction === 'after'
        ? parseOffsetCursor(req.cursor)
        : Math.max(0, parseOffsetCursor(req.cursor) - limit);

    const allRows = arrowResultToJsonRows(dataResult);
    const hasMore = allRows.length > limit;
    let rows = hasMore ? allRows.slice(0, limit) : allRows;
    if (req.direction === 'before') rows = rows.slice().reverse();

    const totalRowCount = readCount(countResult);

    const nextOffsetVal = startOffset + rows.length;
    const nextCursor = hasMore ? encodeOffsetCursor(nextOffsetVal) : null;
    const prevCursor = startOffset > 0 ? encodeOffsetCursor(startOffset) : null;

    return {
      encoding: 'json',
      rows,
      nextCursor: req.direction === 'after' ? nextCursor : prevCursor,
      prevCursor: req.direction === 'after' ? prevCursor : nextCursor,
      totalRowCount,
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (connection) {
      try {
        await connection.close();
      } catch {
        // best effort — surface upstream errors via the next op
      }
      connection = null;
    }
  }

  async function fetchDistinct(
    req: DistinctRequest,
    opts?: FetchOptions,
  ): Promise<DistinctResult> {
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    const conn = await getConnection();
    const part = buildDistinctSql({ source: wrappedSource, request: req });
    const result = await runQuery(conn, part.sql, part.params);
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    const rows = arrowResultToJsonRows(result);
    const limit = Math.max(0, Math.floor(req.limit));
    return {
      kind: 'distinct',
      entry: rows.slice(0, limit).map((row) => ({
        value: row['value'] ?? null,
        // COUNT(*) is BIGINT in DuckDB and arrives as a bigint.
        count: Number(row['count']),
      })),
      truncated: rows.length > limit,
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
    };
  }

  return { schema, fetchBlock, fetchDistinct, close };
}

/**
 * Run a SQL query against a connection. If params is empty, calls
 * `connection.query()` directly (no prepared-statement overhead). Otherwise
 * uses `prepare()` → execute → close.
 */
async function runQuery(
  conn: AsyncDuckDBConnection,
  sql: string,
  params: ReadonlyArray<unknown>,
): Promise<unknown> {
  if (params.length === 0) {
    return conn.query(sql);
  }
  const stmt = await conn.prepare(sql);
  try {
    return await stmt.query(...(params as unknown[]));
  } finally {
    try {
      await stmt.close();
    } catch {
      // best effort
    }
  }
}

// -----------------------------------------------------------------------------
// Arrow result helpers
//
// DuckDB-WASM returns Apache Arrow `Table` objects from `query`. We don't
// take a hard dep on apache-arrow — DuckDB's table is structurally a
// JavaScript iterable of row objects with a `.schema.fields` array.
// -----------------------------------------------------------------------------

interface ArrowFieldShape {
  readonly name: string;
  readonly type?: { readonly typeId?: number; toString: () => string };
}

interface ArrowSchemaShape {
  readonly fields: ReadonlyArray<ArrowFieldShape>;
}

interface ArrowTableShape {
  readonly schema: ArrowSchemaShape;
  readonly numRows: number;
  toArray: () => ReadonlyArray<Record<string, unknown>>;
}

function arrowResultToJsonRows(
  result: unknown,
): Record<string, unknown>[] {
  const table = result as ArrowTableShape;
  const rows = table.toArray();
  // Defensive copy — toArray sometimes returns a view that shares memory
  // with Arrow vectors. Materialize to plain objects so consumers can
  // serialize / mutate freely.
  return rows.map((row) => ({ ...row }));
}

function readCount(result: unknown): number {
  const table = result as ArrowTableShape;
  const arr = table.toArray() as ReadonlyArray<Record<string, unknown>>;
  const first = arr[0];
  if (!first) return 0;
  const value = (first as Record<string, unknown>)['c'] ?? Object.values(first)[0];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

function arrowSchemaResultToSchema(result: unknown): Schema {
  const table = result as ArrowTableShape;
  const rows = table.toArray() as ReadonlyArray<{
    column_name?: string;
    column_type?: string;
    null?: string;
  }>;
  const out: ColumnSchema[] = [];
  for (const row of rows) {
    const id = row.column_name ?? '';
    if (!id) continue;
    out.push({
      id,
      type: duckdbTypeToOneGrid(row.column_type ?? ''),
      nullable: row.null !== 'NO',
    });
  }
  return out;
}

function duckdbTypeToOneGrid(raw: string): ColumnType {
  const t = raw.toUpperCase();
  if (t.startsWith('TINYINT')) return 'int8';
  if (t.startsWith('SMALLINT')) return 'int16';
  if (t.startsWith('INTEGER') || t === 'INT' || t === 'INT4') return 'int32';
  if (t.startsWith('BIGINT') || t === 'INT8') return 'int64';
  if (t.startsWith('UTINYINT')) return 'uint8';
  if (t.startsWith('USMALLINT')) return 'uint16';
  if (t.startsWith('UINTEGER')) return 'uint32';
  if (t.startsWith('UBIGINT')) return 'uint64';
  if (t === 'FLOAT' || t === 'REAL' || t === 'FLOAT4') return 'float32';
  if (t === 'DOUBLE' || t === 'FLOAT8') return 'float64';
  if (t.startsWith('DECIMAL') || t.startsWith('NUMERIC')) return 'decimal';
  if (t === 'BOOLEAN' || t === 'BOOL') return 'bool';
  if (t === 'DATE') return 'date32';
  if (t.startsWith('TIMESTAMP_TZ') || t.includes('WITH TIME ZONE')) return 'timestamp_tz';
  if (t.startsWith('TIMESTAMP')) return 'timestamp';
  if (t.startsWith('TIME')) return 'time64';
  if (t.startsWith('VARCHAR') || t === 'TEXT' || t === 'STRING') return 'utf8';
  if (t === 'BLOB' || t === 'BYTEA' || t === 'BINARY') return 'binary';
  if (t === 'JSON') return 'json';
  if (t.startsWith('STRUCT')) return 'struct';
  if (t.startsWith('LIST') || t.endsWith('[]')) return 'list';
  if (t.startsWith('MAP')) return 'map';
  return 'unknown';
}

export {
  buildBlockSql,
  buildCountSql,
  buildDistinctSql,
  buildSchemaSql,
  parseOffsetCursor,
  encodeOffsetCursor,
} from './sql';
export type { SqlPart, BuildBlockSqlOptions, BuildDistinctSqlOptions } from './sql';
