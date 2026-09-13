// =============================================================================
// @onegrid/protocol
//
// Wire-format and database-adapter contract types for oneGrid. Pure types —
// no runtime code. Every oneGrid package consumes only these symbols when
// crossing the network or adapter boundary.
//
// Stability: this is the load-bearing schema. Breaking changes here force
// every downstream package and every adapter to bump versions. Treat it as
// frozen once v0.1.0 ships.
// =============================================================================

// -----------------------------------------------------------------------------
// Versioning
// -----------------------------------------------------------------------------

/** @public */
export const PROTOCOL_VERSION = '0.0.1' as const;
/** @public */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// -----------------------------------------------------------------------------
// Cursors
// -----------------------------------------------------------------------------

/**
 * Opaque cursor. The server defines its own format and bytes; the client only
 * ever round-trips the string back. This is the canonical cursor shape — keep
 * clients ignorant of internal encoding.
 *
 * The canonical wire encoding is the keyset cursor produced by
 * `encodeKeysetCursor` in `@onegrid/ssrm`, which prefixes the payload with
 * `ks:` so future cursor formats can ship behind a different prefix without
 * breaking existing clients. The legacy `offset:N` encoding (used by
 * `SsrmRowSource`'s synchronous random-access bridge and the v0.0.7 mock
 * server) is supported during the v0.0.8 migration window via
 * `parseLegacyOffsetCursor`; new database adapters should NOT emit it.
 * @public
 */
export type Cursor = string;

/**
 * Structured cursor shape for keyset pagination. Adapters MUST encode this as
 * an opaque string via `encodeKeysetCursor` from `@onegrid/ssrm` before
 * sending it across the wire — that codec produces the canonical `ks:`-
 * prefixed format described above.
 *
 * Keyset semantics: (sortValues, rowId) uniquely identifies a position in the
 * current sorted view. The tiebreaker rowId guarantees a stable resume point
 * across volatile data — without it, two rows whose sort values tie would
 * collide and clients would skip or duplicate rows when paginating across an
 * insertion or deletion.
 * @public
 */
export interface KeysetCursor {
  readonly sortValues: ReadonlyArray<unknown>;
  readonly rowId: string | number;
}

// -----------------------------------------------------------------------------
// Sort
// -----------------------------------------------------------------------------

/** @public */
export type SortDirection = 'asc' | 'desc';

/** @public */
export type SortNullHandling = 'first' | 'last';

/** @public */
export interface SortField {
  readonly columnId: string;
  readonly direction: SortDirection;
  /** How to order nulls; default 'last'. */
  readonly nulls?: SortNullHandling;
}

/**
 * Multi-column sort, ordered by priority (leftmost = highest priority).
 * @public
 */
export type SortModel = ReadonlyArray<SortField>;

// -----------------------------------------------------------------------------
// Filters
// -----------------------------------------------------------------------------

/** @public */
export type ComparisonOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull'
  | 'between'
  | 'notBetween';

/** @public */
export interface ComparisonFilter {
  readonly type: 'comparison';
  readonly columnId: string;
  readonly op: ComparisonOperator;
  /** Used for unary scalar ops (eq, neq, lt, …). */
  readonly value?: unknown;
  /** Used for in/notIn/between/notBetween. */
  readonly values?: ReadonlyArray<unknown>;
  /** String ops only; default false. */
  readonly caseSensitive?: boolean;
}

/** @public */
export interface LogicalFilter {
  readonly type: 'logical';
  readonly op: 'and' | 'or' | 'not';
  readonly filters: ReadonlyArray<FilterNode>;
}

/** @public */
export type FilterNode = ComparisonFilter | LogicalFilter;

/**
 * Null = no filter applied.
 * @public
 */
export type FilterModel = FilterNode | null;

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

/** @public */
export interface GroupingModel {
  /** Columns to group by, in nesting order (outer → inner). */
  readonly columns: ReadonlyArray<string>;
  /** Currently expanded group keys. Empty = collapsed top level only. */
  readonly openKeys: ReadonlyArray<ReadonlyArray<unknown>>;
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------

/** @public */
export type AggregationType =
  | 'sum'
  | 'avg'
  | 'count'
  | 'countDistinct'
  | 'min'
  | 'max'
  | 'first'
  | 'last';

/** @public */
export interface Aggregation {
  readonly columnId: string;
  /** Built-in type or a string key registered as a custom aggregator. */
  readonly fn: AggregationType | (string & {});
  readonly alias?: string;
}

/** @public */
export type AggregationModel = ReadonlyArray<Aggregation>;

// -----------------------------------------------------------------------------
// Pivot
// -----------------------------------------------------------------------------

/** @public */
export interface PivotModel {
  readonly rows: ReadonlyArray<string>;
  readonly columns: ReadonlyArray<string>;
  readonly measures: AggregationModel;
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/** @public */
export type ColumnType =
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'float32'
  | 'float64'
  | 'decimal'
  | 'utf8'
  | 'binary'
  | 'bool'
  | 'date32'
  | 'date64'
  | 'timestamp'
  | 'timestamp_tz'
  | 'time32'
  | 'time64'
  | 'list'
  | 'struct'
  | 'map'
  | 'json'
  | 'unknown';

/** @public */
export interface ColumnSchema {
  readonly id: string;
  readonly type: ColumnType;
  readonly nullable?: boolean;
  readonly displayName?: string;
  /** For decimal types. */
  readonly precision?: number;
  readonly scale?: number;
  /** For timestamp_tz: IANA timezone string. */
  readonly timezone?: string;
  /** Child fields for list/struct/map. */
  readonly children?: ReadonlyArray<ColumnSchema>;
}

/** @public */
export type Schema = ReadonlyArray<ColumnSchema>;

// -----------------------------------------------------------------------------
// SSRM block fetch (the central contract)
// -----------------------------------------------------------------------------

/** @public */
export type FetchDirection = 'after' | 'before';

/** @public */
export interface BlockRequest {
  /** Null = first block. Server-defined opaque string otherwise. */
  readonly cursor: Cursor | null;
  readonly direction: FetchDirection;
  /** Maximum rows to return. Server may return fewer. */
  readonly limit: number;
  readonly sort: SortModel;
  readonly filter: FilterModel;
  readonly grouping?: GroupingModel;
  /**
   * Aggregations to compute per group when `grouping` is set. The server
   * SHOULD pushdown the rollup (`SUM`/`AVG`/`COUNT`/etc.) so it can return
   * one row per distinct group key combination instead of every raw row in
   * the group — that's the entire point of pushdown.
   *
   * Aliases name the output columns: each `Aggregation`'s `alias` (defaulting
   * to `${fn}_${columnId}` when omitted) becomes a key on every grouped
   * response row alongside the group-key columns. Without `grouping`,
   * `aggregations` is ignored; the server returns flat rows.
   *
   * Example request: group by `status`, compute `sum(revenue)` and
   * `avg(score)`. Response rows look like
   * `{ status: 'active', sum_revenue: 9.99e9, avg_score: 49.5, __count__: 200000 }`.
   * The `__count__` field carries the per-group row count so the client can
   * render the group header chevron + count without a second round-trip.
   */
  readonly aggregations?: AggregationModel;
  readonly pivot?: PivotModel;
  /** Subset of columns the client wants materialised. Server may return more. */
  readonly columns?: ReadonlyArray<string>;
  /** Per-block correlation id; server should echo for telemetry/cancel. */
  readonly requestId?: string;
  /**
   * Hierarchical (tree) fetch. Null/undefined = root level. When set, the
   * server returns the children of the named parent node, paginated by
   * cursor / limit. Distinct `parentId`s use independent cursor spaces:
   * a cursor returned for parent A is NOT valid against parent B.
   *
   * Cache fingerprint includes `parentId` so blocks fetched under one
   * parent never collide with blocks fetched under another.
   */
  readonly parentId?: string | null;
}

/**
 * Per-row hierarchy metadata for tree responses. Indexed parallel to
 * `BlockResponse.rows`. Servers populate this on hierarchical fetches
 * (where `BlockRequest.parentId` semantics are in play); flat responses
 * may omit it.
 * @public
 */
export interface HierarchyEntry {
  /** Stable node id; passed back as `parentId` to fetch this node's children. */
  readonly id: string;
  /** Whether this node has children that can be expanded. */
  readonly hasChildren: boolean;
}

/**
 * Wire encoding for row data. Arrow IPC is canonical (zero-copy on the client);
 * JSON is the fallback for non-binary transports and debugging.
 * @public
 */
export type RowEncoding = 'arrow-ipc' | 'json';

/** @public */
export type EncodedRows<TEncoding extends RowEncoding> = TEncoding extends 'arrow-ipc'
  ? Uint8Array
  : ReadonlyArray<Record<string, unknown>>;

/** @public */
export interface BlockResponse<TEncoding extends RowEncoding = RowEncoding> {
  readonly encoding: TEncoding;
  readonly rows: EncodedRows<TEncoding>;
  /** Cursor to fetch the block AFTER the last row in `rows`; null = end. */
  readonly nextCursor: Cursor | null;
  /** Cursor to fetch the block BEFORE the first row in `rows`; null = start. */
  readonly prevCursor: Cursor | null;
  /**
   * Total row count if cheap to compute. Omit for ∞-scroll semantics; clients
   * that need scrollbars fall back to estimated heights.
   */
  readonly totalRowCount?: number;
  readonly requestId?: string;
  /**
   * Per-row hierarchy info, parallel to `rows`. Present on hierarchical
   * fetches (where the request carried `parentId`); absent on flat fetches.
   * Clients MUST tolerate missing entries — e.g. a server that doesn't
   * support trees just leaves this undefined.
   */
  readonly hierarchy?: ReadonlyArray<HierarchyEntry>;
}

// -----------------------------------------------------------------------------
// DataSource interface
// -----------------------------------------------------------------------------

/** @public */
export interface FetchOptions {
  /** Cancel in-flight requests on scroll/filter change. */
  readonly signal?: AbortSignal;
}

/** @public */
export type Unsubscribe = () => void;

/** @public */
export interface DataSource {
  /** Schema is required up-front; the grid binds columns to fields. */
  readonly schema: () => Promise<Schema> | Schema;
  /** Server-side row model fetch — the central contract. */
  readonly fetchBlock: (req: BlockRequest, opts?: FetchOptions) => Promise<BlockResponse>;
  /** Optional live update stream. Adapters without push leave this undefined. */
  readonly subscribe?: (onPatch: (patch: Patch) => void, opts?: FetchOptions) => Unsubscribe;
  /** Optional write-back. Adapters may be read-only. */
  readonly mutate?: (
    mutations: ReadonlyArray<Mutation>,
    opts?: FetchOptions,
  ) => Promise<MutationResult>;
  /**
   * Optional distinct values + counts for one column — what a set-filter
   * popover lists. Adapters that cannot answer leave this undefined or
   * resolve `{ kind: 'unsupported' }`.
   */
  readonly fetchDistinct?: (req: DistinctRequest, opts?: FetchOptions) => Promise<DistinctResult>;
}

// -----------------------------------------------------------------------------
// Distinct values (set-filter lists)
// -----------------------------------------------------------------------------

/** @public */
export interface DistinctRequest {
  readonly columnId: string;
  /**
   * Filter applied before counting. A set-filter UI passes the active filter
   * WITHOUT the column's own set rule, so unticked values stay listed.
   */
  readonly filter: FilterModel;
  /** Case-insensitive prefix on the value's string form. */
  readonly search?: string;
  /** Maximum distinct values to return. */
  readonly limit: number;
  readonly requestId?: string;
}

/** @public */
export interface DistinctEntry {
  readonly value: unknown;
  readonly count: number;
}

/** @public */
export interface DistinctResponse {
  readonly kind: 'distinct';
  /** Ordered by count descending, then value ascending. */
  readonly entry: ReadonlyArray<DistinctEntry>;
  /** True when more distinct values matched than `limit` allowed. */
  readonly truncated: boolean;
  readonly requestId?: string;
}

/** @public */
export interface DistinctUnsupported {
  readonly kind: 'unsupported';
  readonly reason: string;
}

/** @public */
export type DistinctResult = DistinctResponse | DistinctUnsupported;

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

/** @public */
export type MutationKind = 'insert' | 'update' | 'delete';

/** @public */
export interface InsertMutation {
  readonly kind: 'insert';
  /** Client-generated id; server echoes back in MutationResult for reconciliation. */
  readonly clientId: string;
  readonly row: Record<string, unknown>;
}

/** @public */
export interface UpdateMutation {
  readonly kind: 'update';
  readonly clientId: string;
  readonly rowId: string | number;
  readonly fields: Record<string, unknown>;
  /** Optional optimistic-concurrency check: previous values seen by client. */
  readonly expected?: Record<string, unknown>;
}

/** @public */
export interface DeleteMutation {
  readonly kind: 'delete';
  readonly clientId: string;
  readonly rowId: string | number;
}

/** @public */
export type Mutation = InsertMutation | UpdateMutation | DeleteMutation;

/** @public */
export interface MutationOk {
  readonly kind: 'ok';
  readonly clientId: string;
  readonly rowId: string | number;
}

/** @public */
export interface MutationConflict {
  readonly kind: 'conflict';
  readonly clientId: string;
  readonly rowId: string | number;
  readonly server: Record<string, unknown>;
}

/** @public */
export interface MutationError {
  readonly kind: 'error';
  readonly clientId: string;
  readonly message: string;
  readonly code?: string;
}

/** @public */
export type MutationResultEntry = MutationOk | MutationConflict | MutationError;

/** @public */
export type MutationResult = ReadonlyArray<MutationResultEntry>;

// -----------------------------------------------------------------------------
// Patches (live updates)
// -----------------------------------------------------------------------------

/** @public */
export interface RowInsertPatch {
  readonly kind: 'rowInsert';
  /** Position to insert after. Null = append. */
  readonly afterCursor: Cursor | null;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** @public */
export interface RowUpdatePatch {
  readonly kind: 'rowUpdate';
  readonly rowId: string | number;
  readonly fields: Record<string, unknown>;
}

/** @public */
export interface RowDeletePatch {
  readonly kind: 'rowDelete';
  readonly rowId: string | number;
}

/** @public */
export interface SchemaPatch {
  readonly kind: 'schema';
  readonly schema: Schema;
}

/** @public */
export interface InvalidatePatch {
  readonly kind: 'invalidate';
  /** Null = invalidate entire cache. */
  readonly scope: { columnId: string } | null;
}

/** @public */
export type Patch =
  | RowInsertPatch
  | RowUpdatePatch
  | RowDeletePatch
  | SchemaPatch
  | InvalidatePatch;

// -----------------------------------------------------------------------------
// Real-time row-diff stream
// -----------------------------------------------------------------------------

/**
 * Single versioned row-diff event. Servers emit one for every
 * insert / update / delete on any row a client could have cached.
 * `version` is monotonically increasing per source — a client tracks
 * the last seen value to detect a gap (e.g. after a WebSocket
 * reconnect) and trigger a resync request.
 *
 * Wire shape is deliberately flat (no nested `patch`) so the
 * envelope cost is minimal — high-throughput change streams may emit
 * thousands of these per second.
 * @public
 */
export interface RowDiff {
  readonly kind: 'insert' | 'update' | 'delete';
  /** Monotonic per-source counter. Strictly increasing across emits. */
  readonly version: number;
  /** Primary key value identifying the row across its lifecycle. */
  readonly pkey: string | number;
  /** Cell values for insert / update; omitted for delete. Servers
   *  MAY send a partial map for update (only changed fields) — the
   *  client's reconciliation policy decides whether to merge against
   *  cached state or refetch the row. */
  readonly fields?: Record<string, unknown>;
}

/**
 * Client → server: replay row-diffs from `fromVersion` (exclusive)
 * onwards. Sent when the client detects a version gap (last seen
 * version + 1 ≠ next received version) or after a transport
 * reconnect.
 * @public
 */
export interface ResyncRequest {
  readonly fromVersion: number;
}

/**
 * Server → client response to a `ResyncRequest`. When the gap is
 * small enough to replay (`diffs` populated, `snapshot` absent),
 * the client merges them in version order. When the gap is too
 * large to keep history for (`snapshot: true`), the client MUST
 * drop its cache and re-fetch from scratch — the server is telling
 * it that a coherent replay isn't possible.
 * @public
 */
export interface ResyncResponse {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly diffs: ReadonlyArray<RowDiff>;
  /** When true, the client should treat its cache as invalid and
   *  re-issue the original `BlockRequest`s from scratch. `diffs` is
   *  empty in this case. */
  readonly snapshot?: true;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** @public */
export type ProtocolErrorCode =
  | 'INVALID_CURSOR'
  | 'INVALID_FILTER'
  | 'INVALID_SORT'
  | 'INVALID_SCHEMA'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'CANCELED'
  | 'INTERNAL';

/** @public */
export interface ProtocolError {
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}
