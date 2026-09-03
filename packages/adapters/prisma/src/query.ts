// =============================================================================
// Prisma query compiler — turns a BlockRequest into the argument objects a
// Prisma Client delegate consumes (`prisma.order.findMany(arg)` /
// `prisma.order.groupBy(arg)`).
//
// Prisma is unusual among the adapters here: it is not a query builder that
// composes SQL fragments, it is a client that takes one plain JSON-ish
// argument object per call. That makes the compiler's output trivially
// assertable in a test — the compiled value IS the argument — and it makes
// the whole adapter dependency-free, because we never touch Prisma's runtime.
//
// Two decisions worth stating.
//
// 1. Pagination uses Prisma's `cursor` + `take` + `skip: 1`, not `skip: N`.
//    Prisma's `skip` is OFFSET, with OFFSET's cost curve: the database still
//    walks and discards every skipped row, so scrolling to row 500 000 costs
//    500 000 rows of work. `cursor` re-anchors the scan on an indexed unique
//    value and `skip: 1` steps past the anchor itself. `take: -n` walks
//    backwards from the anchor, which is how the `before` direction is served
//    without inverting the sort by hand.
//
// 2. Grouping is pushed into `groupBy`, not computed after a `findMany`.
//    Prisma's `groupBy` compiles to a real SQL GROUP BY with the aggregate
//    functions inside it, so a group over 200 000 rows returns one row rather
//    than 200 000. The response then needs un-nesting: Prisma answers
//    `{ status: 'active', _sum: { revenue: 1 }, _count: { _all: 2 } }`, and
//    oneGrid's contract is the flat `{ status, sum_revenue, __count__ }`.
//
// Every field id is validated against the model descriptor before it lands in
// an argument object. Prisma throws on unknown fields rather than ignoring
// them, so this is about producing a clear error at the adapter boundary
// instead of a Prisma validation stack trace three layers down.
// =============================================================================

import type {
  Aggregation,
  BlockRequest,
  ComparisonFilter,
  FilterModel,
  FilterNode,
  KeysetCursor,
  SortModel,
} from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Model descriptor
// -----------------------------------------------------------------------------

export interface PrismaModelDescriptor {
  /** Prisma model name as it appears on the client, e.g. `order`. */
  readonly model: string;
  /** Scalar field ids that may appear in where / orderBy / select. */
  readonly field: ReadonlyArray<string>;
  /** Unique scalar used as the pagination cursor and keyset tiebreaker. */
  readonly primaryKey: string;
  /**
   * Relation field names. They are addressable in `select` but never in
   * `orderBy` or a scalar comparison — Prisma needs a nested filter shape for
   * those, which the grid's flat column model cannot express.
   */
  readonly relationField?: ReadonlyArray<string>;
}

// -----------------------------------------------------------------------------
// Compiled shapes
// -----------------------------------------------------------------------------

/** Prisma `where` argument. Recursive by construction (AND / OR / NOT). */
export type PrismaWhere = Record<string, unknown>;

/** One `orderBy` entry. Prisma takes an array of single-key objects. */
export type PrismaOrderBy = Record<string, 'asc' | 'desc'>;

export interface PrismaFindManyArg {
  readonly where?: PrismaWhere;
  readonly orderBy: ReadonlyArray<PrismaOrderBy>;
  /** Negative when paging backwards from the cursor. */
  readonly take: number;
  /** Always 1 when a cursor is set — step past the anchor row. */
  readonly skip?: number;
  readonly cursor?: Record<string, unknown>;
  readonly select?: Record<string, boolean>;
}

export interface PrismaGroupByArg {
  readonly by: ReadonlyArray<string>;
  readonly where?: PrismaWhere;
  readonly orderBy: ReadonlyArray<PrismaOrderBy>;
  readonly take: number;
  readonly skip?: number;
  readonly _count?: Record<string, boolean>;
  readonly _sum?: Record<string, boolean>;
  readonly _avg?: Record<string, boolean>;
  readonly _min?: Record<string, boolean>;
  readonly _max?: Record<string, boolean>;
}

/** Which Prisma aggregate bucket an output alias came from. */
export interface CompiledMetric {
  readonly alias: string;
  readonly bucket: '_sum' | '_avg' | '_min' | '_max' | '_count';
  readonly columnId: string;
}

export interface CompiledFindManyQuery {
  readonly kind: 'findMany';
  readonly arg: PrismaFindManyArg;
}

export interface CompiledGroupByQuery {
  readonly kind: 'groupBy';
  readonly arg: PrismaGroupByArg;
  readonly groupColumn: ReadonlyArray<string>;
  readonly metric: ReadonlyArray<CompiledMetric>;
}

export type CompiledPrismaQuery = CompiledFindManyQuery | CompiledGroupByQuery;

/** Per-group row count key, matching the protocol's documented contract. */
export const GROUP_COUNT_KEY = '__count__';

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export function compilePrismaQuery(
  req: BlockRequest,
  descriptor: PrismaModelDescriptor,
  cursor: KeysetCursor | null = null,
): CompiledPrismaQuery {
  if (req.grouping && req.grouping.columns.length > 0) {
    return compileGroupBy(req, descriptor);
  }
  return compileFindMany(req, descriptor, cursor);
}

function compileFindMany(
  req: BlockRequest,
  descriptor: PrismaModelDescriptor,
  cursor: KeysetCursor | null,
): CompiledFindManyQuery {
  const where = compileWhere(req.filter, descriptor);
  const orderBy = compileOrderBy(req.sort, descriptor);
  const select = compileSelect(req.columns, descriptor);
  const backwards = req.direction === 'before';

  const arg: Mutable<PrismaFindManyArg> = {
    orderBy,
    take: backwards ? -req.limit : req.limit,
  };
  if (where) arg.where = where;
  if (select) arg.select = select;
  if (cursor) {
    arg.cursor = { [descriptor.primaryKey]: cursor.rowId };
    // Without `skip: 1` the anchor row comes back again as the first row of
    // the next block, which the grid renders as a duplicate.
    arg.skip = 1;
  }
  return { kind: 'findMany', arg };
}

function compileGroupBy(
  req: BlockRequest,
  descriptor: PrismaModelDescriptor,
): CompiledGroupByQuery {
  const groupColumn = req.grouping!.columns;
  for (const id of groupColumn) requireField(id, descriptor);

  const bucket: Record<string, Record<string, boolean>> = {
    // `_count._all` is the group's row count. It is always requested: the
    // protocol promises `__count__` on every grouped row so the client can
    // draw the group header without a second round-trip.
    _count: { _all: true },
  };
  const metric: CompiledMetric[] = [];

  for (const aggregation of req.aggregations ?? []) {
    const alias = aliasOf(aggregation);
    const name = prismaBucketFor(aggregation);
    if (aggregation.columnId === '*') {
      // COUNT(*) is already in `_count._all`; alias it rather than asking
      // Prisma for the same number twice.
      metric.push({ alias, bucket: '_count', columnId: '_all' });
      continue;
    }
    requireField(aggregation.columnId, descriptor);
    const slot = bucket[name] ?? {};
    slot[aggregation.columnId] = true;
    bucket[name] = slot;
    metric.push({ alias, bucket: name, columnId: aggregation.columnId });
  }

  const arg: Mutable<PrismaGroupByArg> = {
    by: groupColumn,
    // Prisma requires groupBy's orderBy to reference a grouped field, so the
    // primary-key tiebreaker used on the flat path is not available here.
    orderBy: groupColumn.map((id) => ({ [id]: 'asc' as const })),
    take: req.limit,
  };
  const where = compileWhere(req.filter, descriptor);
  if (where) arg.where = where;
  for (const [name, slot] of Object.entries(bucket)) {
    (arg as Record<string, unknown>)[name] = slot;
  }

  return { kind: 'groupBy', arg, groupColumn, metric };
}

function prismaBucketFor(aggregation: Aggregation): CompiledMetric['bucket'] {
  switch (aggregation.fn) {
    case 'sum':
      return '_sum';
    case 'avg':
      return '_avg';
    case 'min':
      return '_min';
    case 'max':
      return '_max';
    case 'count':
      return '_count';
    case 'countDistinct':
      // Prisma's groupBy has no distinct-count aggregate — `_count` on a
      // field counts non-null rows, not distinct values. Saying so is better
      // than returning a plain count that quietly answers a different
      // question; adopters needing it drop to `$queryRaw`.
      throw new Error(
        "@onegrid/prisma: 'countDistinct' has no groupBy equivalent in Prisma Client. Use $queryRaw with COUNT(DISTINCT …) for that column.",
      );
    default:
      throw new Error(
        `@onegrid/prisma: unsupported aggregation fn "${aggregation.fn}". Supported: sum, avg, min, max, count.`,
      );
  }
}

/** Default alias matches the protocol's documented `${fn}_${columnId}`. */
export function aliasOf(aggregation: Aggregation): string {
  return aggregation.alias ?? `${aggregation.fn}_${aggregation.columnId}`;
}

/**
 * Flatten Prisma's nested groupBy rows into oneGrid's one-row-per-group shape.
 */
export function parseGroupByResult(
  compiled: CompiledGroupByQuery,
  result: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return result.map((raw) => {
    const out: Record<string, unknown> = {};
    for (const id of compiled.groupColumn) out[id] = raw[id] ?? null;
    const count = raw._count as Record<string, unknown> | undefined;
    out[GROUP_COUNT_KEY] = count?._all ?? null;
    for (const entry of compiled.metric) {
      const slot = raw[entry.bucket] as Record<string, unknown> | undefined;
      out[entry.alias] = slot?.[entry.columnId] ?? null;
    }
    return out;
  });
}

// -----------------------------------------------------------------------------
// where
// -----------------------------------------------------------------------------

export function compileWhere(
  filter: FilterModel,
  descriptor: PrismaModelDescriptor,
): PrismaWhere | undefined {
  if (!filter) return undefined;
  return compileNode(filter, descriptor);
}

function compileNode(node: FilterNode, descriptor: PrismaModelDescriptor): PrismaWhere {
  if (node.type === 'logical') {
    if (node.op === 'not') {
      const inner = node.filters[0];
      if (!inner) return {};
      return { NOT: compileNode(inner, descriptor) };
    }
    if (node.filters.length === 0) return {};
    const child = node.filters.map((f) => compileNode(f, descriptor));
    return node.op === 'and' ? { AND: child } : { OR: child };
  }
  requireField(node.columnId, descriptor);
  return { [node.columnId]: compileComparison(node) };
}

function compileComparison(node: ComparisonFilter): Record<string, unknown> {
  // Prisma spells case-insensitivity as `mode: 'insensitive'` on string
  // filters. It is a Postgres/Mongo-only feature; on MySQL and SQLite the
  // collation decides, and Prisma rejects the key outright. We only emit it
  // when the request explicitly asked for insensitive matching.
  const mode = node.caseSensitive === false ? { mode: 'insensitive' as const } : {};
  switch (node.op) {
    case 'eq':
      return { equals: node.value };
    case 'neq':
      return { not: node.value };
    case 'lt':
      return { lt: node.value };
    case 'lte':
      return { lte: node.value };
    case 'gt':
      return { gt: node.value };
    case 'gte':
      return { gte: node.value };
    case 'in':
      return { in: [...(node.values ?? [])] };
    case 'notIn':
      return { notIn: [...(node.values ?? [])] };
    case 'isNull':
      return { equals: null };
    case 'isNotNull':
      return { not: null };
    case 'contains':
      return { contains: str(node.value), ...mode };
    case 'notContains':
      return { not: { contains: str(node.value), ...mode } };
    case 'startsWith':
      return { startsWith: str(node.value), ...mode };
    case 'endsWith':
      return { endsWith: str(node.value), ...mode };
    case 'between': {
      const [lo, hi] = node.values ?? [];
      return { gte: lo, lte: hi };
    }
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      // Prisma has no NOT BETWEEN; the negation of a closed interval is the
      // union of the two open half-lines, expressed as a nested NOT so the
      // whole thing stays inside this column's filter object.
      return { NOT: { gte: lo, lte: hi } };
    }
  }
}

// -----------------------------------------------------------------------------
// orderBy / select
// -----------------------------------------------------------------------------

export function compileOrderBy(
  sort: SortModel,
  descriptor: PrismaModelDescriptor,
): ReadonlyArray<PrismaOrderBy> {
  const out: PrismaOrderBy[] = [];
  for (const entry of sort) {
    requireField(entry.columnId, descriptor);
    if (descriptor.relationField?.includes(entry.columnId)) {
      throw new Error(
        `@onegrid/prisma: cannot sort by relation field "${entry.columnId}" — order by a scalar on this model instead.`,
      );
    }
    out.push({ [entry.columnId]: entry.direction });
  }
  // The tiebreaker. Prisma's cursor pagination is only well-defined when the
  // ordering is total: with a tie at the cursor row, the database is free to
  // place the anchor anywhere inside the tie and `skip: 1` then lands
  // somewhere arbitrary. Ordering on the unique key last removes the tie.
  //
  // Direction never flips here. `take: -n` is what walks backwards; flipping
  // the order as well would cancel it out and re-read the same block.
  out.push({ [descriptor.primaryKey]: 'asc' });
  return out;
}

export function compileSelect(
  column: ReadonlyArray<string> | undefined,
  descriptor: PrismaModelDescriptor,
): Record<string, boolean> | undefined {
  if (!column || column.length === 0) return undefined;
  const out: Record<string, boolean> = {};
  for (const id of column) {
    requireField(id, descriptor);
    out[id] = true;
  }
  // Without the primary key the datasource cannot build the next cursor, so
  // pagination would silently stop after one block.
  out[descriptor.primaryKey] = true;
  return out;
}

// -----------------------------------------------------------------------------
// Cursor codec — the `ks:` wire format every oneGrid adapter emits
// -----------------------------------------------------------------------------

const KEYSET_PREFIX = 'ks:';

export function isKeysetCursor(cursor: string): boolean {
  return cursor.startsWith(KEYSET_PREFIX);
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  const json = JSON.stringify({ s: cursor.sortValues, r: cursor.rowId });
  const b64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(json)
      : Buffer.from(json, 'utf-8').toString('base64');
  return KEYSET_PREFIX + b64;
}

export function decodeKeysetCursor(cursor: string): KeysetCursor {
  const b64 = cursor.startsWith(KEYSET_PREFIX) ? cursor.slice(KEYSET_PREFIX.length) : cursor;
  const json =
    typeof globalThis.atob === 'function'
      ? globalThis.atob(b64)
      : Buffer.from(b64, 'base64').toString('utf-8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('@onegrid/prisma: malformed keyset cursor.');
  }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.s) && 'r' in obj) {
    return { sortValues: obj.s, rowId: obj.r as string | number };
  }
  if (Array.isArray(obj.sortValues) && 'rowId' in obj) {
    return { sortValues: obj.sortValues, rowId: obj.rowId as string | number };
  }
  throw new Error('@onegrid/prisma: malformed keyset cursor.');
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function requireField(id: string, descriptor: PrismaModelDescriptor): void {
  if (id === descriptor.primaryKey) return;
  if (descriptor.field.includes(id)) return;
  if (descriptor.relationField?.includes(id)) return;
  throw new Error(`@onegrid/prisma: unknown field "${id}" on model "${descriptor.model}".`);
}
