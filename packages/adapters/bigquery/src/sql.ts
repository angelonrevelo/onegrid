// =============================================================================
// BigQuery SQL compiler — translates a BlockRequest into GoogleSQL
// (BigQuery's standard SQL). Pure: no `@google-cloud/bigquery`
// dependency, no I/O. `datasource.ts` executes the resulting
// `{ sql, params, paramType }` against whatever queryable the adopter
// supplies.
//
// Five deliberate divergences from the Postgres/ClickHouse compilers:
//
//   1. TABLE IDENTIFIERS ARE ONE BACKTICKED PATH. BigQuery addresses a
//      table as `` `project.dataset.table` `` — the WHOLE path inside a
//      single pair of backticks, not per-segment quoting. Splitting it
//      the way the Postgres adapter splits `schema.table` produces
//      `` `project`.`dataset`.`table` ``, which BigQuery parses as a
//      field access and rejects. Column identifiers keep their own
//      backticks.
//
//   2. TYPED NAMED PARAMETERS. BigQuery takes `@name` parameters, and
//      the API requires each one's TYPE to be declared alongside the
//      value — an untyped parameter is a job-level error, not a
//      coercion. So the compiler emits `paramType` in parallel with
//      `params`, preferring the descriptor's declared column types and
//      falling back to inference from the JS value.
//
//   3. PARTITION- AND CLUSTER-AWARE PREDICATE ORDERING. BigQuery bills
//      by bytes scanned, and a partition filter is what stops a query
//      reading five years of history to render one screen. The
//      compiler reorders the conjuncts of a top-level AND so partition
//      predicates come first, then clustering columns in the order
//      they were declared, then everything else. The reorder happens
//      BEFORE compilation so parameter numbering follows the emitted
//      text — `@p0` is always the partition predicate's value.
//
//   4. `_PARTITIONTIME` PRUNING. Ingestion-time-partitioned tables have
//      no real partition column; the pseudo-column is the only way to
//      prune them. `partitionFilter` compiles a bounded
//      `_PARTITIONTIME >= TIMESTAMP(@p) AND _PARTITIONTIME < TIMESTAMP(@p)`
//      predicate at the very front of the WHERE clause.
//
//   5. NO ROW-VALUE COMPARISON. Like Snowflake, BigQuery only compares
//      STRUCTs with `=`; `(a, b) > (@p0, @p1)` is a type error. The
//      keyset predicate compiles to the expanded lexicographic chain,
//      which additionally gets mixed-direction multi-sort right.
//
// Injection guard: every column identifier is checked against the
// descriptor's allowlist before it is quoted, the table path is
// validated against BigQuery's own identifier grammar, and `LIMIT`'s
// row count is validated as a non-negative safe integer. Values only
// ever travel as named parameters.
// =============================================================================

import type {
  Aggregation,
  BlockRequest,
  ComparisonOperator,
  FilterNode,
  KeysetCursor,
  SortField,
} from '@onegrid/protocol';

/** Ingestion-time pseudo-column used to prune a partitioned table. */
export type BqPartitionPseudoColumn = '_PARTITIONTIME' | '_PARTITIONDATE';

export interface BqTableDescriptor {
  /** GCP project id, e.g. `acme-analytics`. */
  readonly project: string;
  /** Dataset id, e.g. `warehouse`. */
  readonly dataset: string;
  /** Table id, e.g. `order`. */
  readonly table: string;
  /** Column ids that exist in the table. Every projected, filtered,
   *  sorted, grouped and aggregated column is checked against this
   *  allowlist before it can reach the SQL text. */
  readonly columns: ReadonlyArray<string>;
  /** Primary-key column id used as the keyset tiebreaker. */
  readonly primaryKey: string;
  /** BigQuery type per column (`INT64`, `TIMESTAMP`, `NUMERIC`, …).
   *  Used to declare parameter types; missing entries fall back to
   *  inference from the JS value. */
  readonly columnType?: Readonly<Record<string, string>>;
  /** Column the table is PARTITION BY'd on. Predicates against it sort
   *  to the front of the WHERE clause. */
  readonly partitionColumn?: string;
  /** Ingestion-time pseudo-column, for tables partitioned by load time
   *  rather than by a field. */
  readonly partitionPseudoColumn?: BqPartitionPseudoColumn;
  /** CLUSTER BY columns, in declaration order — which is significant:
   *  BigQuery only prunes blocks on a prefix of the clustering key. */
  readonly clusterColumn?: ReadonlyArray<string>;
}

/** Bounds for `_PARTITIONTIME` / `_PARTITIONDATE` pruning. Half-open:
 *  `from` inclusive, `to` exclusive. */
export interface BqPartitionFilter {
  readonly from?: string | Date;
  readonly to?: string | Date;
}

export interface BqCompileOption {
  readonly partitionFilter?: BqPartitionFilter;
}

export interface CompiledQuery {
  readonly sql: string;
  /** Parameter name → value, e.g. `{ p0: 'shipped' }`. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Parameter name → declared BigQuery type, e.g. `{ p0: 'STRING' }`.
   *  BigQuery rejects a job whose parameters are untyped. */
  readonly paramType: Readonly<Record<string, string>>;
}

const KEYSET_PREFIX = 'ks:';

interface CompileCtx {
  readonly params: Record<string, unknown>;
  readonly paramType: Record<string, string>;
  index: number;
  readonly table: BqTableDescriptor;
}

/**
 * Compile a BlockRequest into a BigQuery SELECT. Grouped requests take
 * the aggregation-pushdown path (one row per distinct group key);
 * everything else takes the keyset-paginated flat path.
 */
export function compileBlockQuery(
  req: BlockRequest,
  table: BqTableDescriptor,
  cursor: KeysetCursor | null,
  option: BqCompileOption = {},
): CompiledQuery {
  if (req.grouping && req.grouping.columns.length > 0) {
    return compileGroupedQuery(req, table, option);
  }
  return compileFlatQuery(req, table, cursor, option);
}

function compileFlatQuery(
  req: BlockRequest,
  table: BqTableDescriptor,
  cursor: KeysetCursor | null,
  option: BqCompileOption,
): CompiledQuery {
  const ctx = newCtx(table);
  const projection = projectColumn(req.columns, table);

  const predicate: string[] = [
    ...compilePartitionFilter(option.partitionFilter, ctx),
    ...(req.filter ? [compileFilter(req.filter, ctx)] : []),
  ];
  if (cursor) {
    predicate.push(compileKeysetPredicate(req.sort, cursor, ctx, req.direction));
  }
  const where = predicate.length > 0 ? ` WHERE ${predicate.join(' AND ')}` : '';
  const orderBy = compileOrderBy(req.sort, table, req.direction);
  const limit = ` LIMIT ${literalRowCount(req.limit)}`;

  const sql = `SELECT ${projection} FROM ${quoteTable(table)}${where}${orderBy}${limit}`;
  return { sql, params: ctx.params, paramType: ctx.paramType };
}

function compileGroupedQuery(
  req: BlockRequest,
  table: BqTableDescriptor,
  option: BqCompileOption,
): CompiledQuery {
  const ctx = newCtx(table);
  const groupCol = req.grouping!.columns.map((c) => {
    requireColumn(c, table);
    return quoteIdent(c);
  });

  const predicate: string[] = [
    ...compilePartitionFilter(option.partitionFilter, ctx),
    ...(req.filter ? [compileFilter(req.filter, ctx)] : []),
  ];
  const where = predicate.length > 0 ? ` WHERE ${predicate.join(' AND ')}` : '';

  // `__count__` is always projected so the grid renders the group
  // header's chevron + count without a second (billed) query.
  const aggregationProjection = (req.aggregations ?? [])
    .map((agg) => compileAggregation(agg, table))
    .join(', ');
  const projection = [
    ...groupCol,
    'COUNT(*) AS `__count__`',
    ...(aggregationProjection ? [aggregationProjection] : []),
  ].join(', ');

  const orderBy = ` ORDER BY ${groupCol.map((c) => `${c} ASC`).join(', ')}`;
  const sql = `SELECT ${projection} FROM ${quoteTable(table)}${where} GROUP BY ${groupCol.join(', ')}${orderBy}`;
  return { sql, params: ctx.params, paramType: ctx.paramType };
}

/**
 * Ingestion-time partition pruning. The pseudo-column is a fixed
 * string from a closed union — never adopter text — so it is safe to
 * inline; the bounds are parameters.
 */
function compilePartitionFilter(
  filter: BqPartitionFilter | undefined,
  ctx: CompileCtx,
): string[] {
  if (!filter) return [];
  const pseudo = ctx.table.partitionPseudoColumn;
  if (!pseudo) {
    throw new Error(
      '@onegrid/bigquery: partitionFilter needs the descriptor to declare partitionPseudoColumn.',
    );
  }
  const wrap = pseudo === '_PARTITIONTIME' ? 'TIMESTAMP' : 'DATE';
  const type = pseudo === '_PARTITIONTIME' ? 'TIMESTAMP' : 'DATE';
  const out: string[] = [];
  if (filter.from !== undefined) {
    out.push(`${pseudo} >= ${wrap}(${addParam(ctx, toParamValue(filter.from), type)})`);
  }
  if (filter.to !== undefined) {
    out.push(`${pseudo} < ${wrap}(${addParam(ctx, toParamValue(filter.to), type)})`);
  }
  return out;
}

function compileAggregation(agg: Aggregation, table: BqTableDescriptor): string {
  const alias = agg.alias ?? `${agg.fn}_${agg.columnId}`;
  if (agg.columnId !== '*') requireColumn(agg.columnId, table);
  const col = agg.columnId === '*' ? '*' : quoteIdent(agg.columnId);
  let fnExpr: string;
  switch (agg.fn) {
    case 'sum':
      // SUM over an empty group is NULL in GoogleSQL; the grid wants
      // 0. CAST keeps a NUMERIC sum off the string path the client
      // library uses for exact decimals.
      fnExpr = `IFNULL(CAST(SUM(${col}) AS FLOAT64), 0)`;
      break;
    case 'avg':
      fnExpr = `CAST(AVG(${col}) AS FLOAT64)`;
      break;
    case 'count':
      fnExpr = `COUNT(${col})`;
      break;
    case 'countDistinct':
      // Exact, not APPROX_COUNT_DISTINCT: a grid showing "1,204,881
      // customers" must not show a different number on the next
      // scroll. Adopters who want the cheap sketch can alias their own.
      fnExpr = `COUNT(DISTINCT ${col})`;
      break;
    case 'min':
      fnExpr = `MIN(${col})`;
      break;
    case 'max':
      fnExpr = `MAX(${col})`;
      break;
    default:
      throw new Error(`@onegrid/bigquery: unsupported aggregation fn "${agg.fn}".`);
  }
  return `${fnExpr} AS ${quoteIdent(alias)}`;
}

function compileFilter(node: FilterNode, ctx: CompileCtx): string {
  if (node.type === 'logical') {
    if (node.op === 'not') {
      const inner = node.filters[0];
      if (!inner) return 'TRUE';
      return `(NOT ${compileFilter(inner, ctx)})`;
    }
    if (node.filters.length === 0) return 'TRUE';
    if (node.op === 'and') {
      // Only an AND may be reordered — reordering an OR changes
      // nothing about pruning and would just churn parameter names.
      const ordered = orderByPruningValue(node.filters, ctx.table);
      return `(${ordered.map((f) => compileFilter(f, ctx)).join(' AND ')})`;
    }
    return `(${node.filters.map((f) => compileFilter(f, ctx)).join(' OR ')})`;
  }
  requireColumn(node.columnId, ctx.table);
  return compileComparison(node, ctx);
}

/**
 * Sort AND-conjuncts by how much scanning they can eliminate:
 * partition column first, then clustering columns in declaration
 * order, then the rest. Stable, so predicates of equal rank keep the
 * caller's order — a grid's filter chips stay recognisable in the
 * query log.
 */
export function orderByPruningValue(
  node: ReadonlyArray<FilterNode>,
  table: BqTableDescriptor,
): ReadonlyArray<FilterNode> {
  return node
    .map((n, i) => ({ n, i, rank: pruningRank(n, table) }))
    .sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank))
    .map((entry) => entry.n);
}

function pruningRank(node: FilterNode, table: BqTableDescriptor): number {
  if (node.type !== 'comparison') return 1_000;
  if (node.columnId === table.partitionColumn) return 0;
  const clusterIndex = table.clusterColumn?.indexOf(node.columnId) ?? -1;
  if (clusterIndex >= 0) return 1 + clusterIndex;
  return 1_000;
}

function compileComparison(
  node: {
    columnId: string;
    op: ComparisonOperator;
    value?: unknown;
    values?: ReadonlyArray<unknown>;
    caseSensitive?: boolean;
  },
  ctx: CompileCtx,
): string {
  const col = quoteIdent(node.columnId);
  const cs = node.caseSensitive !== false;
  const type = paramTypeFor(node.columnId, ctx.table);
  switch (node.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const op = { eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[node.op];
      return `${col} ${op} ${addParam(ctx, toParamValue(node.value), type)}`;
    }
    case 'in':
    case 'notIn': {
      if (!node.values || node.values.length === 0) {
        return node.op === 'in' ? 'FALSE' : 'TRUE';
      }
      // UNNEST(@p) over one ARRAY parameter, not a parameter per value:
      // BigQuery caps a job's parameter count, and an IN list from a
      // set filter routinely runs to thousands of values.
      const placeholder = addParam(ctx, node.values.map(toParamValue), `ARRAY<${type}>`);
      return `${col} ${node.op === 'in' ? 'IN' : 'NOT IN'} UNNEST(${placeholder})`;
    }
    case 'isNull':
      return `${col} IS NULL`;
    case 'isNotNull':
      return `${col} IS NOT NULL`;
    case 'contains':
    case 'notContains': {
      const not = node.op === 'notContains' ? 'NOT ' : '';
      const value = String(node.value ?? '');
      // GoogleSQL's LIKE is always case-sensitive and has no ILIKE, so
      // case-insensitive matching folds both sides with LOWER().
      if (cs) {
        return `${col} ${not}LIKE ${addParam(ctx, `%${escapeLike(value)}%`, 'STRING')}`;
      }
      return `LOWER(${col}) ${not}LIKE LOWER(${addParam(ctx, `%${escapeLike(value)}%`, 'STRING')})`;
    }
    case 'startsWith':
    case 'endsWith': {
      const value = String(node.value ?? '');
      const pattern =
        node.op === 'startsWith' ? `${escapeLike(value)}%` : `%${escapeLike(value)}`;
      if (cs) return `${col} LIKE ${addParam(ctx, pattern, 'STRING')}`;
      return `LOWER(${col}) LIKE LOWER(${addParam(ctx, pattern, 'STRING')})`;
    }
    case 'between':
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      const not = node.op === 'notBetween' ? 'NOT ' : '';
      const loPh = addParam(ctx, toParamValue(lo), type);
      const hiPh = addParam(ctx, toParamValue(hi), type);
      return `${col} ${not}BETWEEN ${loPh} AND ${hiPh}`;
    }
  }
}

/**
 * Effective sort direction for a field. A `before` fetch walks the
 * ordering backwards, so every key — not just the tiebreaker — flips
 * and the caller re-reverses the block client-side.
 */
function effectiveAscending(field: SortField, reqBefore: boolean): boolean {
  return (field.direction === 'asc') !== reqBefore;
}

function compileOrderBy(
  sort: ReadonlyArray<SortField>,
  table: BqTableDescriptor,
  direction: BlockRequest['direction'],
): string {
  const reqBefore = direction === 'before';
  const field = sort.map((s) => {
    requireColumn(s.columnId, table);
    const asc = effectiveAscending(s, reqBefore);
    const nulls = (s.nulls ?? 'last').toUpperCase();
    return `${quoteIdent(s.columnId)} ${asc ? 'ASC' : 'DESC'} NULLS ${nulls}`;
  });
  const tieAsc = tiebreakerAscending(sort, reqBefore);
  field.push(`${quoteIdent(table.primaryKey)} ${tieAsc ? 'ASC' : 'DESC'}`);
  return ` ORDER BY ${field.join(', ')}`;
}

function tiebreakerAscending(sort: ReadonlyArray<SortField>, reqBefore: boolean): boolean {
  const lead = sort[0];
  const asc = lead ? lead.direction === 'asc' : true;
  return asc !== reqBefore;
}

/**
 * Lexicographic keyset predicate, expanded because GoogleSQL compares
 * STRUCTs only for equality. For sort keys (a ASC, b DESC) and
 * tiebreaker `id`:
 *
 *   (`a` > @p0 OR (`a` = @p1 AND (`b` < @p2 OR (`b` = @p3 AND `id` > @p4))))
 *
 * The leading conjunct is a bare range predicate on the first sort
 * column, so a table clustered on it still prunes blocks — the reason
 * to page by key rather than by OFFSET, which re-scans and re-bills
 * every earlier row.
 */
function compileKeysetPredicate(
  sort: ReadonlyArray<SortField>,
  cursor: KeysetCursor,
  ctx: CompileCtx,
  direction: BlockRequest['direction'],
): string {
  const reqBefore = direction === 'before';
  const level: { col: string; value: unknown; type: string; asc: boolean }[] = [];
  for (let i = 0; i < sort.length; i++) {
    const field = sort[i] as SortField;
    requireColumn(field.columnId, ctx.table);
    level.push({
      col: quoteIdent(field.columnId),
      value: toParamValue(cursor.sortValues[i] ?? null),
      type: paramTypeFor(field.columnId, ctx.table),
      asc: effectiveAscending(field, reqBefore),
    });
  }
  level.push({
    col: quoteIdent(ctx.table.primaryKey),
    value: toParamValue(cursor.rowId),
    type: paramTypeFor(ctx.table.primaryKey, ctx.table),
    asc: tiebreakerAscending(sort, reqBefore),
  });
  return buildChain(level, 0, ctx);
}

function buildChain(
  level: ReadonlyArray<{ col: string; value: unknown; type: string; asc: boolean }>,
  index: number,
  ctx: CompileCtx,
): string {
  const current = level[index];
  if (!current) return 'TRUE';
  const op = current.asc ? '>' : '<';
  const strict = `${current.col} ${op} ${addParam(ctx, current.value, current.type)}`;
  if (index === level.length - 1) return strict;
  const tie = `${current.col} = ${addParam(ctx, current.value, current.type)}`;
  return `(${strict} OR (${tie} AND ${buildChain(level, index + 1, ctx)}))`;
}

function projectColumn(
  col: ReadonlyArray<string> | undefined,
  table: BqTableDescriptor,
): string {
  if (!col || col.length === 0) {
    return table.columns.map((c) => quoteIdent(c)).join(', ');
  }
  return col
    .map((c) => {
      requireColumn(c, table);
      return quoteIdent(c);
    })
    .join(', ');
}

function newCtx(table: BqTableDescriptor): CompileCtx {
  return { params: {}, paramType: {}, index: 0, table };
}

function addParam(ctx: CompileCtx, value: unknown, type: string): string {
  const name = `p${String(ctx.index++)}`;
  ctx.params[name] = value;
  ctx.paramType[name] = type;
  return `@${name}`;
}

/**
 * Declared parameter type for a column. The descriptor's own BigQuery
 * types win; otherwise STRING, which BigQuery coerces for the common
 * cases and which never mis-declares a value's type outright.
 */
function paramTypeFor(columnId: string, table: BqTableDescriptor): string {
  const declared = table.columnType?.[columnId];
  return declared ? normalizeParamType(declared) : 'STRING';
}

/** Reduce a schema type to the parameter type BigQuery accepts —
 *  parameterised forms like `NUMERIC(38,9)` are declared bare. */
function normalizeParamType(raw: string): string {
  const base = raw.trim().toUpperCase().split('(')[0] ?? 'STRING';
  switch (base) {
    case 'INTEGER':
      return 'INT64';
    case 'FLOAT':
      return 'FLOAT64';
    case 'BOOLEAN':
      return 'BOOL';
    case 'RECORD':
      return 'STRUCT';
    default:
      return base;
  }
}

/**
 * BigQuery's REST API carries INT64 / NUMERIC parameters as strings
 * precisely because they exceed float64's exact range, so a BigInt is
 * stringified rather than coerced. Dates go over as ISO-8601.
 */
function toParamValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Backtick-quote a column identifier, doubling nothing: BigQuery
 *  forbids a backtick inside an identifier outright, so one is
 *  rejected rather than escaped. */
function quoteIdent(id: string): string {
  if (id.includes('`')) {
    throw new Error(`@onegrid/bigquery: identifier "${id}" contains a backtick.`);
  }
  return `\`${id}\``;
}

const PATH_PART = /^[A-Za-z0-9_-]+$/;

/**
 * `` `project.dataset.table` `` — one backticked path, not three
 * quoted segments. Each part is validated against BigQuery's own
 * identifier grammar (letters, digits, underscore, and the hyphen
 * project ids famously allow) before it reaches the SQL text.
 */
export function quoteTable(table: BqTableDescriptor): string {
  for (const [label, part] of [
    ['project', table.project],
    ['dataset', table.dataset],
    ['table', table.table],
  ] as const) {
    if (!PATH_PART.test(part)) {
      throw new Error(
        `@onegrid/bigquery: ${label} "${part}" is not a valid BigQuery identifier.`,
      );
    }
  }
  return `\`${table.project}.${table.dataset}.${table.table}\``;
}

/**
 * BigQuery accepts a parameter in LIMIT only in some job shapes, so
 * the count is inlined — validated first as a non-negative safe
 * integer, which makes this the compiler's one numeric guard.
 */
function literalRowCount(limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(
      `@onegrid/bigquery: limit must be a non-negative safe integer, got ${String(limit)}.`,
    );
  }
  return String(limit);
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function requireColumn(columnId: string, table: BqTableDescriptor): void {
  if (columnId === table.primaryKey) return;
  if (!table.columns.includes(columnId)) {
    throw new Error(
      `@onegrid/bigquery: unknown column "${columnId}" (not in table descriptor).`,
    );
  }
}

export function isLegacyOffsetCursor(cursor: string): boolean {
  return cursor.startsWith('offset:');
}

export function isKeysetCursor(cursor: string): boolean {
  return cursor.startsWith(KEYSET_PREFIX);
}

/** Decode a canonical `ks:`-prefixed keyset cursor. Byte-compatible
 *  with the other adapters' cursors — adapters depend only on
 *  @onegrid/protocol, so the codec is duplicated, not imported. */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
  const b64 = cursor.startsWith(KEYSET_PREFIX) ? cursor.slice(KEYSET_PREFIX.length) : cursor;
  const json =
    typeof globalThis.atob === 'function'
      ? globalThis.atob(b64)
      : Buffer.from(b64, 'base64').toString('utf-8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('decodeKeysetCursor: malformed payload.');
  }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.s) && 'r' in obj) {
    return { sortValues: obj.s, rowId: obj.r as string | number };
  }
  if (Array.isArray(obj.sortValues) && 'rowId' in obj) {
    return { sortValues: obj.sortValues, rowId: obj.rowId as string | number };
  }
  throw new Error('decodeKeysetCursor: malformed payload.');
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  const json = JSON.stringify({ s: cursor.sortValues, r: cursor.rowId });
  const b64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(json)
      : Buffer.from(json, 'utf-8').toString('base64');
  return KEYSET_PREFIX + b64;
}
