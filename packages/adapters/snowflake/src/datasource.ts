// =============================================================================
// Snowflake-backed SsrmDataSource.
//
// The adapter takes an INJECTABLE queryable rather than depending on
// `snowflake-sdk`. Two reasons, both load-bearing: the official driver
// is a heavyweight native-ish package that has no business in a grid
// library's dependency tree, and Snowflake is reached three different
// ways in practice (the Node driver, the SQL REST API, a serverless
// proxy). All three collapse to "give me SQL + positional binds, hand
// back rows", which is exactly `SnowflakeQueryable`.
//
// Value normalisation is the other half of the job. Snowflake's Node
// driver returns NUMBER(38,0) as a string (and, with
// `jsTreatIntegerAsBigInt`, as a BigInt) precisely because those
// values exceed float64's exact range. The adapter keeps them on that
// safe path: a BigInt row id is stringified, never `Number()`-ed, so a
// keyset cursor round-trips a 19-digit id without silently rounding
// it. That matches the Postgres adapter, whose driver hands back int8
// as a string for the same reason.
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  DataSource,
  KeysetCursor,
  Schema,
  SortField,
} from '@onegrid/protocol';
import {
  compileBlockQuery,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
  type SnowflakeTableDescriptor,
} from './sql';

/** A statement plus its positional binds, in emission order. */
export interface SnowflakeStatement {
  readonly sql: string;
  readonly bind: ReadonlyArray<unknown>;
}

export interface SnowflakeResult {
  /** Result rows, keyed by the column names Snowflake returned —
   *  upper case unless the table was created with quoted DDL. */
  readonly row: ReadonlyArray<Record<string, unknown>>;
  /** Optional query id, echoed for telemetry / cancellation. */
  readonly queryId?: string;
}

/**
 * The one thing an adopter must supply. `snowflake-sdk`'s
 * `connection.execute({ sqlText, binds, complete })` adapts to this in
 * a dozen lines; so does a `fetch` against the SQL REST API.
 */
export interface SnowflakeQueryable {
  execute(statement: SnowflakeStatement): Promise<SnowflakeResult>;
}

export interface SnowflakeDataSourceOptions {
  readonly client: SnowflakeQueryable;
  readonly table: SnowflakeTableDescriptor;
  /** Static schema returned by `dataSource.schema()`. Build it from a
   *  `DESCRIBE TABLE` with `buildSnowflakeSchema` in `type.ts`. */
  readonly schema: Schema;
}

export function createSnowflakeDataSource(opts: SnowflakeDataSourceOptions): DataSource {
  const { client, table, schema } = opts;

  return {
    schema: () => schema,
    async fetchBlock(req: BlockRequest): Promise<BlockResponse> {
      const cursor = parseCursor(req.cursor);
      const { sql, bind } = compileBlockQuery(req, table, cursor);
      const result = await client.execute({ sql, bind });
      const row = result.row;

      // A short block means the scan hit the end of the range, so
      // there is no next cursor to hand out. A full block always gets
      // one: the compiler ordered the result so the last row's
      // (sortValues, rowId) is exactly the resume point.
      const nextCursor =
        row.length === req.limit
          ? encodeKeysetCursor(cursorFromRow(row[row.length - 1]!, req.sort, table.primaryKey))
          : null;
      const prevCursor =
        row.length > 0 && req.cursor
          ? encodeKeysetCursor(cursorFromRow(row[0]!, req.sort, table.primaryKey))
          : null;

      return {
        encoding: 'json',
        rows: row,
        nextCursor,
        prevCursor,
        ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
      };
    },
  };
}

function parseCursor(cursor: string | null | undefined): KeysetCursor | null {
  if (cursor === null || cursor === undefined) return null;
  if (isKeysetCursor(cursor) || (!isLegacyOffsetCursor(cursor) && cursor.length > 0)) {
    try {
      return decodeKeysetCursor(cursor);
    } catch {
      return null;
    }
  }
  // Legacy offset cursors: this adapter is keyset-only, so an offset
  // cursor degrades to "first block" rather than erroring the grid.
  return null;
}

function cursorFromRow(
  row: Record<string, unknown>,
  sort: ReadonlyArray<SortField>,
  primaryKey: string,
): KeysetCursor {
  // Snowflake returns column names upper-cased for unquoted DDL, and
  // the caller's column ids are usually lower case, so the lookup
  // falls back to the upper-cased key before giving up.
  const sortValues = sort.map((field) => readField(row, field.columnId) ?? null);
  return { sortValues, rowId: toRowId(readField(row, primaryKey), primaryKey) };
}

function readField(row: Record<string, unknown>, columnId: string): unknown {
  if (columnId in row) return row[columnId];
  const upper = columnId.toUpperCase();
  if (upper in row) return row[upper];
  return undefined;
}

/**
 * Coerce a primary-key value into the cursor's `string | number`.
 * BigInt becomes a decimal string rather than a `Number()` — a
 * NUMBER(38,0) id would lose its low digits on the float64 path, and
 * a silently-wrong cursor skips or repeats rows forever.
 */
function toRowId(raw: unknown, primaryKey: string): string | number {
  if (typeof raw === 'bigint') return raw.toString();
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  throw new Error(
    `@onegrid/snowflake: primary key "${primaryKey}" produced ${typeof raw}; expected string, number, or bigint.`,
  );
}
