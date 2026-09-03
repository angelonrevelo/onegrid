// =============================================================================
// BigQuery-backed SsrmDataSource.
//
// The adapter takes an INJECTABLE queryable rather than depending on
// `@google-cloud/bigquery`. That package pulls in the whole Google
// auth stack, and plenty of deployments reach BigQuery a different way
// (the REST API behind a service-account proxy, BigQuery Storage Read,
// a Cloud Run shim). All of them collapse to "run this SQL with these
// typed named parameters, hand back rows", which is `BigQueryQueryable`.
//
// Two BigQuery-specific behaviours live here rather than in the
// compiler:
//
//   * COST CONTROLS travel with the request. `maximumBytesBilled` is
//     forwarded on every job because an unbounded grid query against a
//     petabyte table is a billing incident, not a slow render. The
//     adapter defaults it off (opt-in), but plumbs it so a caller can
//     set it once.
//
//   * INT64 VALUES STAY EXACT. The client library returns INT64 as a
//     `BigQueryInt` wrapper or a BigInt precisely because BigQuery's
//     only integer type is 64-bit and exceeds float64's exact range.
//     Row ids are stringified, never `Number()`-ed: a rounded cursor
//     silently skips or repeats rows. Same call the Postgres adapter
//     makes for int8.
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
  type BqPartitionFilter,
  type BqTableDescriptor,
} from './sql';

/** A query job: GoogleSQL text plus its typed named parameters. */
export interface BigQueryJobRequest {
  readonly sql: string;
  /** Parameter name → value. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Parameter name → declared BigQuery type. Required: BigQuery
   *  rejects a job whose parameters carry no type. */
  readonly paramType: Readonly<Record<string, string>>;
  /** Dataset location (`US`, `EU`, `asia-northeast1`, …). */
  readonly location?: string;
  /** Hard byte ceiling; the job fails rather than overrunning it. */
  readonly maximumBytesBilled?: string;
  /** Per-block correlation id, echoed from the BlockRequest. */
  readonly requestId?: string;
}

export interface BigQueryResult {
  readonly row: ReadonlyArray<Record<string, unknown>>;
  /** Bytes the job actually scanned, when the transport reports it —
   *  worth surfacing, since it is what the query cost. */
  readonly totalBytesProcessed?: number;
}

/**
 * The one thing an adopter must supply.
 * `bigquery.query({ query, params, types })` adapts to this in a few
 * lines; so does a `fetch` against the REST `jobs.query` endpoint.
 */
export interface BigQueryQueryable {
  query(req: BigQueryJobRequest): Promise<BigQueryResult>;
}

export interface BigQueryDataSourceOptions {
  readonly client: BigQueryQueryable;
  readonly table: BqTableDescriptor;
  /** Static schema returned by `dataSource.schema()`. Build it from a
   *  table's field list with `buildBqSchema` in `type.ts`. */
  readonly schema: Schema;
  /** Dataset location, forwarded on every job. */
  readonly location?: string;
  /** Byte ceiling forwarded on every job. Set it: a grid should never
   *  be able to run a five-figure query by scrolling. */
  readonly maximumBytesBilled?: string;
  /** Ingestion-time partition bounds applied to every block, so an
   *  unfiltered grid still prunes instead of scanning all history. */
  readonly partitionFilter?: BqPartitionFilter;
}

export function createBigQueryDataSource(opts: BigQueryDataSourceOptions): DataSource {
  const { client, table, schema } = opts;

  return {
    schema: () => schema,
    async fetchBlock(req: BlockRequest): Promise<BlockResponse> {
      const cursor = parseCursor(req.cursor);
      const { sql, params, paramType } = compileBlockQuery(
        req,
        table,
        cursor,
        opts.partitionFilter ? { partitionFilter: opts.partitionFilter } : {},
      );
      const result = await client.query({
        sql,
        params,
        paramType,
        ...(opts.location === undefined ? {} : { location: opts.location }),
        ...(opts.maximumBytesBilled === undefined
          ? {}
          : { maximumBytesBilled: opts.maximumBytesBilled }),
        ...(req.requestId === undefined ? {} : { requestId: req.requestId }),
      });
      const row = result.row;

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
  const sortValues = sort.map((field) => normalizeValue(row[field.columnId]) ?? null);
  return { sortValues, rowId: toRowId(row[primaryKey], primaryKey) };
}

/**
 * Unwrap the value shapes `@google-cloud/bigquery` returns for types
 * that do not fit a JS primitive: `BigQueryInt`, `BigQueryDate`,
 * `BigQueryTimestamp` and friends are all objects carrying a `value`
 * string. Leaving them wrapped would put an object into a cursor,
 * where it would serialise to `{}` and paginate nowhere.
 */
function normalizeValue(raw: unknown): unknown {
  if (typeof raw === 'bigint') return raw.toString();
  if (raw !== null && typeof raw === 'object' && 'value' in raw) {
    const inner = (raw).value;
    if (typeof inner === 'string' || typeof inner === 'number') return inner;
  }
  return raw;
}

/**
 * Coerce a primary-key value into the cursor's `string | number`.
 * INT64 arrives as a BigInt or a wrapper holding a decimal string;
 * both become strings, because BigQuery's only integer type reaches
 * 2^63 and the float64 path would round the low digits away.
 */
function toRowId(raw: unknown, primaryKey: string): string | number {
  const value = normalizeValue(raw);
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new Error(
    `@onegrid/bigquery: primary key "${primaryKey}" produced ${typeof raw}; expected string, number, bigint, or a { value } wrapper.`,
  );
}
