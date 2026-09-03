// =============================================================================
// Snowflake SQL compiler — translates a BlockRequest into a Snowflake
// SELECT. Pure: no driver dependency, no I/O. `datasource.ts` executes
// the resulting `{ sql, bind }` against whatever queryable the adopter
// supplies.
//
// Four things make Snowflake different from the Postgres/ClickHouse
// compilers, and each one is a deliberate divergence rather than a
// protocol leak:
//
//   1. IDENTIFIER RESOLUTION. Snowflake folds unquoted identifiers to
//      UPPER CASE at parse time, but a *quoted* identifier is matched
//      byte-for-byte. Emitting `"order_id"` against a table created as
//      `order_id` (unquoted, therefore stored as ORDER_ID) fails with
//      "invalid identifier". So the compiler resolves every descriptor
//      identifier to upper case before quoting, unless the descriptor
//      sets `preserveCase: true` — which is what a table created with
//      quoted lower-case DDL needs. Getting this wrong is the single
//      most common Snowflake integration failure, so it is explicit.
//
//   2. BINDS. Snowflake's drivers take positional `?` binds with a
//      parallel array, not `$1` (Postgres) or `{p0:Type}`
//      (ClickHouse). Emission order therefore *is* bind order.
//
//   3. NO ROW-VALUE COMPARISON. Snowflake rejects `(a, b) > (?, ?)` —
//      row constructors are only comparable with `=` and `IN`. The
//      keyset predicate is therefore compiled to the expanded
//      lexicographic chain `(a > ? OR (a = ? AND b > ?))`, which also
//      buys correct MIXED-direction sorts (one key ASC, the next DESC)
//      that the tuple form cannot express at all.
//
//   4. LIMIT TAKES A LITERAL. Snowflake will not accept a bind in
//      `LIMIT`, so the row count is inlined — after being validated as
//      a non-negative safe integer. That validation is part of the
//      injection guard, not a formality: it is the only place a
//      caller-supplied number reaches the SQL text.
//
// QUALIFY: Snowflake's post-window filter. Warehouse tables are
// routinely append-only change logs where the grid should show only
// the newest row per key; `dedupe` on the descriptor compiles the
// idiomatic `QUALIFY ROW_NUMBER() OVER (PARTITION BY … ORDER BY …
// DESC) = 1` instead of forcing the adopter to wrap the table in a
// view.
//
// Injection guard: every table/column identifier that reaches the SQL
// string is first checked against the descriptor's allowlist
// (`requireColumn`) and then quoted with embedded `"` doubled. A
// column id that is not in the descriptor throws — it never reaches
// the string. Values only ever travel as binds.
// =============================================================================

import type {
  Aggregation,
  BlockRequest,
  ComparisonOperator,
  FilterNode,
  KeysetCursor,
  SortField,
} from '@onegrid/protocol';

export interface SnowflakeDedupe {
  /** Partition key(s) — usually the table's logical primary key. */
  readonly partition: ReadonlyArray<string>;
  /** Recency column; the highest value wins. */
  readonly recency: string;
}

export interface SnowflakeTableDescriptor {
  /** Fully-qualified table identifier, e.g. `ANALYTICS.PUBLIC.ORDER`.
   *  Each dot-separated part is resolved and quoted independently. */
  readonly table: string;
  /** Column ids that exist in the table. Every projected, filtered,
   *  sorted, grouped and aggregated column is checked against this
   *  allowlist before it can reach the SQL text. */
  readonly columns: ReadonlyArray<string>;
  /** Primary-key column id used as the keyset tiebreaker. */
  readonly primaryKey: string;
  /** Set when the table was created with QUOTED identifiers, so the
   *  stored names are case-sensitive and must NOT be upper-cased. */
  readonly preserveCase?: boolean;
  /** Optional `QUALIFY ROW_NUMBER() … = 1` deduplication, for
   *  append-only tables where the grid wants the latest row per key. */
  readonly dedupe?: SnowflakeDedupe;
}

export interface CompiledQuery {
  readonly sql: string;
  /** Positional `?` bind values, in emission order. */
  readonly bind: ReadonlyArray<unknown>;
}

const KEYSET_PREFIX = 'ks:';

/**
 * Compile a BlockRequest into a Snowflake SELECT. Grouped requests
 * take the aggregation-pushdown path (one row per distinct group key);
 * everything else takes the keyset-paginated flat path.
 */
export function compileBlockQuery(
  req: BlockRequest,
  table: SnowflakeTableDescriptor,
  cursor: KeysetCursor | null,
): CompiledQuery {
  if (req.grouping && req.grouping.columns.length > 0) {
    return compileGroupedQuery(req, table);
  }
  return compileFlatQuery(req, table, cursor);
}

function compileFlatQuery(
  req: BlockRequest,
  table: SnowflakeTableDescriptor,
  cursor: KeysetCursor | null,
): CompiledQuery {
  const bind: unknown[] = [];
  const projection = projectColumn(req.columns, table);

  const predicate: string[] = [];
  if (req.filter) predicate.push(compileFilter(req.filter, bind, table));
  if (cursor) {
    predicate.push(compileKeysetPredicate(req.sort, cursor, bind, table, req.direction));
  }
  const where = predicate.length > 0 ? ` WHERE ${predicate.join(' AND ')}` : '';
  const qualify = compileQualify(table);
  const orderBy = compileOrderBy(req.sort, table, req.direction);
  const limit = ` LIMIT ${literalRowCount(req.limit)}`;

  const sql = `SELECT ${projection} FROM ${quoteQualifiedIdent(table.table, table)}${where}${qualify}${orderBy}${limit}`;
  return { sql, bind };
}

function compileGroupedQuery(
  req: BlockRequest,
  table: SnowflakeTableDescriptor,
): CompiledQuery {
  const bind: unknown[] = [];
  const groupCol = req.grouping!.columns.map((c) => {
    requireColumn(c, table);
    return quoteIdent(c, table);
  });

  const predicate: string[] = [];
  if (req.filter) predicate.push(compileFilter(req.filter, bind, table));
  const where = predicate.length > 0 ? ` WHERE ${predicate.join(' AND ')}` : '';

  // `__count__` is always projected so the grid can render the group
  // header's chevron + count without a second round-trip. Snowflake's
  // COUNT(*) is a NUMBER(18,0); the driver returns a JS number for
  // values under 2^53, which any realistic group count is.
  const aggregationProjection = (req.aggregations ?? [])
    .map((agg) => compileAggregation(agg, table))
    .join(', ');
  const projection = [
    ...groupCol,
    'COUNT(*) AS "__count__"',
    ...(aggregationProjection ? [aggregationProjection] : []),
  ].join(', ');

  const orderBy = ` ORDER BY ${groupCol.map((c) => `${c} ASC`).join(', ')}`;
  const qualify = compileQualify(table);
  const sql = `SELECT ${projection} FROM ${quoteQualifiedIdent(table.table, table)}${where}${qualify} GROUP BY ${groupCol.join(', ')}${orderBy}`;
  return { sql, bind };
}

/**
 * `QUALIFY ROW_NUMBER() OVER (PARTITION BY … ORDER BY … DESC) = 1` —
 * Snowflake's post-window filter, which lets an append-only table be
 * read as its latest-row-per-key projection without a subquery.
 */
function compileQualify(table: SnowflakeTableDescriptor): string {
  const dedupe = table.dedupe;
  if (!dedupe) return '';
  if (dedupe.partition.length === 0) {
    throw new Error('@onegrid/snowflake: dedupe.partition must name at least one column.');
  }
  const partition = dedupe.partition
    .map((c) => {
      requireColumn(c, table);
      return quoteIdent(c, table);
    })
    .join(', ');
  requireColumn(dedupe.recency, table);
  const recency = quoteIdent(dedupe.recency, table);
  return ` QUALIFY ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${recency} DESC) = 1`;
}

function compileAggregation(agg: Aggregation, table: SnowflakeTableDescriptor): string {
  const alias = agg.alias ?? `${agg.fn}_${agg.columnId}`;
  if (agg.columnId !== '*') requireColumn(agg.columnId, table);
  const col = agg.columnId === '*' ? '*' : quoteIdent(agg.columnId, table);
  let fnExpr: string;
  switch (agg.fn) {
    case 'sum':
      // Snowflake's SUM returns NULL over an empty group; the grid
      // wants 0. The ::FLOAT cast keeps a NUMBER(38,x) result off the
      // string path the driver otherwise uses for wide numerics.
      fnExpr = `COALESCE(SUM(${col})::FLOAT, 0)`;
      break;
    case 'avg':
      fnExpr = `AVG(${col})::FLOAT`;
      break;
    case 'count':
      fnExpr = `COUNT(${col})`;
      break;
    case 'countDistinct':
      fnExpr = `COUNT(DISTINCT ${col})`;
      break;
    case 'min':
      fnExpr = `MIN(${col})`;
      break;
    case 'max':
      fnExpr = `MAX(${col})`;
      break;
    default:
      throw new Error(`@onegrid/snowflake: unsupported aggregation fn "${agg.fn}".`);
  }
  // The alias is adopter-supplied rather than allowlisted, so it is
  // quoted with its embedded quotes doubled exactly like a column.
  return `${fnExpr} AS ${quoteIdent(alias, table)}`;
}

function compileFilter(
  node: FilterNode,
  bind: unknown[],
  table: SnowflakeTableDescriptor,
): string {
  if (node.type === 'logical') {
    if (node.op === 'not') {
      const inner = node.filters[0];
      if (!inner) return 'TRUE';
      return `(NOT ${compileFilter(inner, bind, table)})`;
    }
    if (node.filters.length === 0) return 'TRUE';
    const joiner = node.op === 'and' ? ' AND ' : ' OR ';
    return `(${node.filters.map((f) => compileFilter(f, bind, table)).join(joiner)})`;
  }
  requireColumn(node.columnId, table);
  return compileComparison(node, bind, table);
}

function compileComparison(
  node: {
    columnId: string;
    op: ComparisonOperator;
    value?: unknown;
    values?: ReadonlyArray<unknown>;
    caseSensitive?: boolean;
  },
  bind: unknown[],
  table: SnowflakeTableDescriptor,
): string {
  const col = quoteIdent(node.columnId, table);
  const cs = node.caseSensitive !== false;
  switch (node.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      bind.push(node.value);
      const op = { eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[node.op];
      return `${col} ${op} ?`;
    }
    case 'in':
    case 'notIn': {
      if (!node.values || node.values.length === 0) {
        return node.op === 'in' ? 'FALSE' : 'TRUE';
      }
      const placeholder = node.values.map((v) => {
        bind.push(v);
        return '?';
      });
      return `${col} ${node.op === 'in' ? 'IN' : 'NOT IN'} (${placeholder.join(', ')})`;
    }
    case 'isNull':
      return `${col} IS NULL`;
    case 'isNotNull':
      return `${col} IS NOT NULL`;
    case 'contains':
    case 'notContains': {
      bind.push(`%${escapeLike(String(node.value ?? ''))}%`);
      const not = node.op === 'notContains' ? 'NOT ' : '';
      // Snowflake's LIKE is case-sensitive; ILIKE is the case-folding
      // form, and it beats LOWER() on both sides because it leaves the
      // column bare for micro-partition pruning.
      return `${col} ${not}${cs ? 'LIKE' : 'ILIKE'} ? ESCAPE '\\\\'`;
    }
    case 'startsWith': {
      bind.push(`${escapeLike(String(node.value ?? ''))}%`);
      return `${col} ${cs ? 'LIKE' : 'ILIKE'} ? ESCAPE '\\\\'`;
    }
    case 'endsWith': {
      bind.push(`%${escapeLike(String(node.value ?? ''))}`);
      return `${col} ${cs ? 'LIKE' : 'ILIKE'} ? ESCAPE '\\\\'`;
    }
    case 'between':
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      bind.push(lo);
      bind.push(hi);
      const not = node.op === 'notBetween' ? 'NOT ' : '';
      return `${col} ${not}BETWEEN ? AND ?`;
    }
  }
}

/**
 * Effective sort direction for a field. A `before` fetch walks the
 * index backwards, so every key — not just the tiebreaker — flips and
 * the caller re-reverses the block client-side. Flipping ALL keys is
 * what keeps the ORDER BY in agreement with the keyset predicate.
 */
function effectiveAscending(field: SortField, reqBefore: boolean): boolean {
  return (field.direction === 'asc') !== reqBefore;
}

function compileOrderBy(
  sort: ReadonlyArray<SortField>,
  table: SnowflakeTableDescriptor,
  direction: BlockRequest['direction'],
): string {
  const reqBefore = direction === 'before';
  const field = sort.map((s) => {
    requireColumn(s.columnId, table);
    const asc = effectiveAscending(s, reqBefore);
    const nulls = (s.nulls ?? 'last').toUpperCase();
    return `${quoteIdent(s.columnId, table)} ${asc ? 'ASC' : 'DESC'} NULLS ${nulls}`;
  });
  const tieAsc = tiebreakerAscending(sort, reqBefore);
  field.push(`${quoteIdent(table.primaryKey, table)} ${tieAsc ? 'ASC' : 'DESC'}`);
  return ` ORDER BY ${field.join(', ')}`;
}

function tiebreakerAscending(sort: ReadonlyArray<SortField>, reqBefore: boolean): boolean {
  const lead = sort[0];
  const asc = lead ? lead.direction === 'asc' : true;
  return asc !== reqBefore;
}

/**
 * Lexicographic keyset predicate, expanded because Snowflake has no
 * row-value comparison. For sort keys (a ASC, b DESC) and tiebreaker
 * `id` the emitted shape is
 *
 *   ("A" > ? OR ("A" = ? AND ("B" < ? OR ("B" = ? AND "ID" > ?))))
 *
 * Every level re-binds its value, which is why the bind array is
 * longer than the sort-key count. The leading conjunct stays a bare
 * range predicate on the first sort column, so Snowflake can still
 * prune micro-partitions — the whole reason to use keyset rather than
 * OFFSET against a warehouse.
 */
function compileKeysetPredicate(
  sort: ReadonlyArray<SortField>,
  cursor: KeysetCursor,
  bind: unknown[],
  table: SnowflakeTableDescriptor,
  direction: BlockRequest['direction'],
): string {
  const reqBefore = direction === 'before';
  const level: { col: string; value: unknown; asc: boolean }[] = [];
  for (let i = 0; i < sort.length; i++) {
    const field = sort[i] as SortField;
    requireColumn(field.columnId, table);
    level.push({
      col: quoteIdent(field.columnId, table),
      value: cursor.sortValues[i] ?? null,
      asc: effectiveAscending(field, reqBefore),
    });
  }
  level.push({
    col: quoteIdent(table.primaryKey, table),
    value: cursor.rowId,
    asc: tiebreakerAscending(sort, reqBefore),
  });
  return buildChain(level, 0, bind);
}

function buildChain(
  level: ReadonlyArray<{ col: string; value: unknown; asc: boolean }>,
  index: number,
  bind: unknown[],
): string {
  const current = level[index];
  if (!current) return 'TRUE';
  const op = current.asc ? '>' : '<';
  bind.push(current.value);
  const strict = `${current.col} ${op} ?`;
  if (index === level.length - 1) return strict;
  bind.push(current.value);
  const tie = `${current.col} = ?`;
  return `(${strict} OR (${tie} AND ${buildChain(level, index + 1, bind)}))`;
}

function projectColumn(
  col: ReadonlyArray<string> | undefined,
  table: SnowflakeTableDescriptor,
): string {
  if (!col || col.length === 0) {
    return table.columns.map((c) => quoteIdent(c, table)).join(', ');
  }
  return col
    .map((c) => {
      requireColumn(c, table);
      return quoteIdent(c, table);
    })
    .join(', ');
}

/**
 * Resolve an identifier the way Snowflake's parser would: unquoted
 * names fold to upper case, so a descriptor naming `order_id` against
 * unquoted DDL must be emitted as `"ORDER_ID"`. Tables built with
 * quoted (case-sensitive) DDL set `preserveCase`.
 */
export function resolveIdent(id: string, table: SnowflakeTableDescriptor): string {
  return table.preserveCase ? id : id.toUpperCase();
}

function quoteIdent(id: string, table: SnowflakeTableDescriptor): string {
  return `"${resolveIdent(id, table).replace(/"/g, '""')}"`;
}

function quoteQualifiedIdent(id: string, table: SnowflakeTableDescriptor): string {
  return id
    .split('.')
    .map((part) => quoteIdent(part, table))
    .join('.');
}

/**
 * Snowflake rejects a bind in LIMIT, so the count is inlined — the one
 * place a caller-supplied number reaches the SQL text. Anything that
 * is not a non-negative safe integer is refused outright.
 */
function literalRowCount(limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(
      `@onegrid/snowflake: limit must be a non-negative safe integer, got ${String(limit)}.`,
    );
  }
  return String(limit);
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function requireColumn(columnId: string, table: SnowflakeTableDescriptor): void {
  if (columnId === table.primaryKey) return;
  if (!table.columns.includes(columnId)) {
    throw new Error(
      `@onegrid/snowflake: unknown column "${columnId}" (not in table descriptor).`,
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
