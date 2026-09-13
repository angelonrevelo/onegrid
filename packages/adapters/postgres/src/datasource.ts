// =============================================================================
// Postgres-backed SsrmDataSource.
//
// Compiles BlockRequest into parameterized SQL via `compileBlockQuery`
// and executes against a `pg`-compatible client/pool. The caller owns
// the `pg` lifecycle (we don't open or close the pool); this adapter
// only borrows it long enough to run a query.
//
// Schema: Postgres column types map to the protocol's `ColumnType`
// via a small static table. Adapter authors who want richer mapping
// (e.g. JSONB→json) can pass `inferColumnType` in opts.
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  DataSource,
  DistinctRequest,
  DistinctResult,
  Schema,
  SortField,
} from '@onegrid/protocol';
import {
  compileBlockQuery,
  compileDistinctQuery,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
  type PgTableDescriptor,
} from './sql';

/**
 * Minimal `pg`-compatible client surface. Anything that exposes
 * `query(sql, params)` returning rows is acceptable — node-postgres
 * `Client`, `Pool`, or any wrapper.
 */
export interface PgQueryable {
  query(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

export interface PgDataSourceOptions {
  /** Postgres client / pool. */
  readonly client: PgQueryable;
  /** Table descriptor (table name, columns, primary key). */
  readonly table: PgTableDescriptor;
  /** Static schema returned by `dataSource.schema()`. The adapter
   *  doesn't introspect the live database — that's a v0.0.8 item 12
   *  follow-up via the schema-introspection helper. */
  readonly schema: Schema;
}

export function createPgDataSource(opts: PgDataSourceOptions): DataSource {
  const { client, table, schema } = opts;

  return {
    schema: () => schema,
    async fetchBlock(req: BlockRequest): Promise<BlockResponse> {
      const cursor = parseCursor(req.cursor);
      const { sql, params } = compileBlockQuery(req, table, cursor);
      const result = await client.query(sql, params);
      const rows = result.rows;
      const totalRowCount = rows.length < req.limit ? undefined : undefined;
      // Build next/prev keyset cursors from the first / last result
      // rows. The compiler ordered the results so the last row's
      // (sortValues, rowId) is the resume point.
      const nextCursor =
        rows.length === req.limit
          ? encodeKeysetCursor(cursorFromRow(rows[rows.length - 1]!, req.sort, table.primaryKey))
          : null;
      const prevCursor =
        rows.length > 0 && req.cursor
          ? encodeKeysetCursor(cursorFromRow(rows[0]!, req.sort, table.primaryKey))
          : null;
      return {
        encoding: 'json',
        rows,
        nextCursor,
        prevCursor,
        ...(totalRowCount !== undefined ? { totalRowCount } : {}),
      };
    },
    async fetchDistinct(req: DistinctRequest): Promise<DistinctResult> {
      const { sql, params } = compileDistinctQuery(req, table);
      const result = await client.query(sql, params);
      const limit = Math.max(0, Math.floor(req.limit));
      const rows = result.rows;
      return {
        kind: 'distinct',
        entry: rows.slice(0, limit).map((row) => ({
          value: row['value'] ?? null,
          // node-postgres returns int4 as number but some drivers stringify.
          count: Number(row['count']),
        })),
        truncated: rows.length > limit,
        ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
      };
    },
  };
}

function parseCursor(
  cursor: string | null | undefined,
): ReturnType<typeof decodeKeysetCursor> | null {
  if (cursor === null || cursor === undefined) return null;
  if (isKeysetCursor(cursor) || (!isLegacyOffsetCursor(cursor) && cursor.length > 0)) {
    try {
      return decodeKeysetCursor(cursor);
    } catch {
      return null;
    }
  }
  // Legacy offset cursors: this adapter is keyset-only. Drop the
  // cursor → treats the request as "first block."
  return null;
}

function cursorFromRow(
  row: Record<string, unknown>,
  sort: ReadonlyArray<SortField>,
  primaryKey: string,
): { sortValues: ReadonlyArray<unknown>; rowId: string | number } {
  const sortValues = sort.map((field) => row[field.columnId] ?? null);
  const rawId = row[primaryKey];
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new Error(
      `@onegrid/postgres: primary key "${primaryKey}" produced ${typeof rawId}; expected string or number.`,
    );
  }
  return { sortValues, rowId: rawId };
}
