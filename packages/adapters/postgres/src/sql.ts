// =============================================================================
// SQL compiler — translates a BlockRequest into a parameterized SELECT
// against a Postgres table. Pure: no `pg` dependency, no I/O. The
// `datasource.ts` wrapper executes the resulting `{ sql, params }`
// against a real pg pool.
//
// Supports:
//   - column projection (BlockRequest.columns)
//   - filter (BlockRequest.filter): comparison + logical AND/OR/NOT
//   - sort (BlockRequest.sort): multi-column with ASC/DESC + nulls
//     first/last
//   - limit (BlockRequest.limit), direction
//   - keyset cursor pagination (canonical `ks:` cursor from
//     @onegrid/ssrm wire format) with the (sortValues, rowId) > ?
//     predicate the database's covering index can seek directly
//   - aggregations (BlockRequest.aggregations) when grouping is set
//
// Identifiers are double-quoted; values flow through `$1, $2, ...`
// placeholders. SQL injection is impossible if the consumer never
// passes user-supplied identifiers as table/column names — and the
// adapter requires the table descriptor up-front.
// =============================================================================

import type {
  AggregationModel,
  BlockRequest,
  ComparisonOperator,
  DistinctRequest,
  FilterNode,
  KeysetCursor,
  SortField,
} from '@onegrid/protocol';

export interface PgTableDescriptor {
  /** Schema-qualified table identifier, e.g. `public.orders`. The
   *  compiler quotes it as-is — pass the literal name, not a
   *  string with user input. */
  readonly table: string;
  /** Column ids that exist in the table. The compiler whitelists
   *  every projected / filtered / sorted column against this set so
   *  unknown columns can never reach the SQL string. */
  readonly columns: ReadonlyArray<string>;
  /** Primary-key column id used as the keyset tiebreaker. */
  readonly primaryKey: string;
}

export interface CompiledQuery {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

const KEYSET_PREFIX = 'ks:';

/**
 * Compile the BlockRequest into a parameterized SELECT. The caller
 * passes the table descriptor + already-decoded keyset cursor (or
 * null) so the compiler stays purely string-shaping logic.
 */
export function compileBlockQuery(
  req: BlockRequest,
  table: PgTableDescriptor,
  cursor: KeysetCursor | null,
): CompiledQuery {
  if (req.grouping && req.grouping.columns.length > 0) {
    return compileGroupedQuery(req, table);
  }
  return compileFlatQuery(req, table, cursor);
}

/**
 * Compile a DistinctRequest into a GROUP BY + COUNT(*) over one column,
 * ordered by count descending. It asks for `limit + 1` rows: the extra row
 * only exists to tell the caller the list was truncated.
 */
export function compileDistinctQuery(
  req: DistinctRequest,
  table: PgTableDescriptor,
): CompiledQuery {
  requireColumn(req.columnId, table);
  const col = quoteIdent(req.columnId);
  const params: unknown[] = [];
  const whereClauses: string[] = [];
  if (req.filter) {
    whereClauses.push(compileFilter(req.filter, params, table));
  }
  if (req.search) {
    params.push(`${escapeLike(req.search)}%`);
    whereClauses.push(`LOWER(CAST(${col} AS TEXT)) LIKE LOWER($${String(params.length)})`);
  }
  const where = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
  params.push(Math.max(0, Math.floor(req.limit)) + 1);
  const sql =
    `SELECT ${col} AS "value", COUNT(*)::int AS "count" FROM ${quoteIdent(table.table)}${where}` +
    ` GROUP BY ${col} ORDER BY "count" DESC, ${col} ASC NULLS LAST LIMIT $${String(params.length)}`;
  return { sql, params };
}

function compileFlatQuery(
  req: BlockRequest,
  table: PgTableDescriptor,
  cursor: KeysetCursor | null,
): CompiledQuery {
  const projection = projectColumns(req.columns, table);
  const params: unknown[] = [];

  const whereClauses: string[] = [];
  if (req.filter) {
    const filterSql = compileFilter(req.filter, params, table);
    whereClauses.push(filterSql);
  }
  if (cursor) {
    const cursorSql = compileKeysetPredicate(req.sort, cursor, params, table);
    if (cursorSql) whereClauses.push(cursorSql);
  }
  const where = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';

  const orderBy = compileOrderBy(req.sort, table, req.direction);

  params.push(req.limit);
  const limit = ` LIMIT $${String(params.length)}`;

  const sql = `SELECT ${projection} FROM ${quoteIdent(table.table)}${where}${orderBy}${limit}`;
  return { sql, params };
}

function compileGroupedQuery(
  req: BlockRequest,
  table: PgTableDescriptor,
): CompiledQuery {
  const groupCols = req.grouping!.columns.map((c) => {
    requireColumn(c, table);
    return quoteIdent(c);
  });
  const params: unknown[] = [];
  const whereClauses: string[] = [];
  if (req.filter) {
    whereClauses.push(compileFilter(req.filter, params, table));
  }
  const where = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';

  // Group columns project as themselves; aggregations project as
  // their alias-or-default name. `__count__` is always emitted so
  // the renderer's chevron+count badge has its data without a
  // second query.
  const aggregationProjections = (req.aggregations ?? [])
    .map((agg) => compileAggregation(agg, table))
    .join(', ');
  const projection =
    [
      ...groupCols,
      'COUNT(*)::int AS "__count__"',
      ...(aggregationProjections ? [aggregationProjections] : []),
    ].join(', ');

  const orderBy = ` ORDER BY ${groupCols.map((c) => `${c} ASC`).join(', ')}`;

  const sql = `SELECT ${projection} FROM ${quoteIdent(table.table)}${where} GROUP BY ${groupCols.join(', ')}${orderBy}`;
  return { sql, params };
}

function compileAggregation(
  agg: { columnId: string; fn: string; alias?: string },
  table: PgTableDescriptor,
): string {
  const alias = agg.alias ?? `${agg.fn}_${agg.columnId}`;
  if (agg.columnId !== '*') requireColumn(agg.columnId, table);
  const col = agg.columnId === '*' ? '*' : quoteIdent(agg.columnId);
  let fnExpr: string;
  switch (agg.fn) {
    case 'sum':
      fnExpr = `COALESCE(SUM(${col})::float, 0)`;
      break;
    case 'avg':
      fnExpr = `AVG(${col})::float`;
      break;
    case 'count':
      fnExpr = `COUNT(${col})::int`;
      break;
    case 'countDistinct':
      fnExpr = `COUNT(DISTINCT ${col})::int`;
      break;
    case 'min':
      fnExpr = `MIN(${col})`;
      break;
    case 'max':
      fnExpr = `MAX(${col})`;
      break;
    default:
      throw new Error(`@onegrid/postgres: unsupported aggregation fn "${agg.fn}".`);
  }
  return `${fnExpr} AS ${quoteIdent(alias)}`;
}

function compileFilter(
  node: FilterNode,
  params: unknown[],
  table: PgTableDescriptor,
): string {
  if (node.type === 'logical') {
    if (node.op === 'not') {
      const inner = node.filters[0];
      if (!inner) return 'TRUE';
      return `(NOT ${compileFilter(inner, params, table)})`;
    }
    if (node.filters.length === 0) return 'TRUE';
    const joiner = node.op === 'and' ? ' AND ' : ' OR ';
    return `(${node.filters
      .map((f) => compileFilter(f, params, table))
      .join(joiner)})`;
  }
  requireColumn(node.columnId, table);
  return compileComparison(node, params);
}

function compileComparison(
  node: { columnId: string; op: ComparisonOperator; value?: unknown; values?: ReadonlyArray<unknown>; caseSensitive?: boolean },
  params: unknown[],
): string {
  const col = quoteIdent(node.columnId);
  const cs = node.caseSensitive !== false; // default sensitive
  const wrap = cs ? (s: string): string => s : (s: string): string => `LOWER(${s})`;
  switch (node.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      params.push(node.value);
      const op = { eq: '=', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[node.op];
      return `${col} ${op} $${String(params.length)}`;
    }
    case 'in':
    case 'notIn': {
      if (!node.values || node.values.length === 0) {
        return node.op === 'in' ? 'FALSE' : 'TRUE';
      }
      const placeholders = node.values.map((v) => {
        params.push(v);
        return `$${String(params.length)}`;
      });
      return `${col} ${node.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`;
    }
    case 'isNull':
      return `${col} IS NULL`;
    case 'isNotNull':
      return `${col} IS NOT NULL`;
    case 'contains':
    case 'notContains': {
      params.push(`%${escapeLike(String(node.value ?? ''))}%`);
      const not = node.op === 'notContains' ? 'NOT ' : '';
      return `${wrap(col)} ${not}LIKE ${wrap(`$${String(params.length)}`)}`;
    }
    case 'startsWith': {
      params.push(`${escapeLike(String(node.value ?? ''))}%`);
      return `${wrap(col)} LIKE ${wrap(`$${String(params.length)}`)}`;
    }
    case 'endsWith': {
      params.push(`%${escapeLike(String(node.value ?? ''))}`);
      return `${wrap(col)} LIKE ${wrap(`$${String(params.length)}`)}`;
    }
    case 'between':
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      params.push(lo);
      params.push(hi);
      const not = node.op === 'notBetween' ? 'NOT ' : '';
      return `${col} ${not}BETWEEN $${String(params.length - 1)} AND $${String(params.length)}`;
    }
  }
}

function compileOrderBy(
  sort: ReadonlyArray<SortField>,
  table: PgTableDescriptor,
  direction: BlockRequest['direction'],
): string {
  const fields = sort.map((field) => {
    requireColumn(field.columnId, table);
    const dir = field.direction === 'asc' ? 'ASC' : 'DESC';
    const nulls = (field.nulls ?? 'last').toUpperCase();
    return `${quoteIdent(field.columnId)} ${dir} NULLS ${nulls}`;
  });
  // Append the primary-key tiebreaker so keyset pagination has a
  // stable ordering. Direction matches the dominant sort direction
  // — ASC sorts page forward via row > cursor, DESC via row < cursor,
  // so the tiebreaker has to match. Mixed-direction sorts are
  // treated as "all DESC if any DESC" for the tiebreaker; full
  // mixed-direction keyset support is a v0.0.9 follow-up.
  const allDesc = sort.length > 0 && sort.every((s) => s.direction === 'desc');
  const reqBefore = direction === 'before';
  const tieDir = allDesc !== reqBefore ? 'DESC' : 'ASC';
  fields.push(`${quoteIdent(table.primaryKey)} ${tieDir}`);
  return ` ORDER BY ${fields.join(', ')}`;
}

function compileKeysetPredicate(
  sort: ReadonlyArray<SortField>,
  cursor: KeysetCursor,
  params: unknown[],
  table: PgTableDescriptor,
): string {
  // Build the row-comparison: (sort_col_1, sort_col_2, ..., pk) >
  //                          (cursor.s[0], cursor.s[1], ..., cursor.r)
  // Postgres evaluates row comparisons left-to-right with proper
  // tie-breaking, which is exactly the semantics we want for
  // keyset pagination.
  if (sort.length === 0) {
    params.push(cursor.rowId);
    return `${quoteIdent(table.primaryKey)} > $${String(params.length)}`;
  }
  const lhs: string[] = [];
  const rhs: string[] = [];
  for (let i = 0; i < sort.length; i++) {
    const field = sort[i] as SortField;
    requireColumn(field.columnId, table);
    lhs.push(quoteIdent(field.columnId));
    params.push(cursor.sortValues[i] ?? null);
    rhs.push(`$${String(params.length)}`);
  }
  lhs.push(quoteIdent(table.primaryKey));
  params.push(cursor.rowId);
  rhs.push(`$${String(params.length)}`);
  // For DESC sorts the cursor predicate flips. To keep this minimal,
  // we assume all sorts go the same direction; mixed-direction
  // keyset is a v0.0.9 follow-up where we'd compile per-column
  // (col > ? OR (col = ? AND ...)) chains.
  const allDesc = sort.every((s) => s.direction === 'desc');
  const op = allDesc ? '<' : '>';
  return `(${lhs.join(', ')}) ${op} (${rhs.join(', ')})`;
}

function projectColumns(
  cols: ReadonlyArray<string> | undefined,
  table: PgTableDescriptor,
): string {
  if (!cols || cols.length === 0) {
    return table.columns.map((c) => quoteIdent(c)).join(', ');
  }
  return cols
    .map((c) => {
      requireColumn(c, table);
      return quoteIdent(c);
    })
    .join(', ');
}

function quoteIdent(id: string): string {
  // Schema-qualified identifiers come through as `schema.table`;
  // quote each segment independently.
  if (id.includes('.')) {
    return id.split('.').map((part) => quoteIdent(part)).join('.');
  }
  return `"${id.replace(/"/g, '""')}"`;
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function requireColumn(columnId: string, table: PgTableDescriptor): void {
  if (columnId === table.primaryKey) return;
  if (!table.columns.includes(columnId)) {
    throw new Error(
      `@onegrid/postgres: unknown column "${columnId}" (not in table descriptor).`,
    );
  }
}

export function isLegacyOffsetCursor(cursor: string): boolean {
  return cursor.startsWith('offset:');
}

export function isKeysetCursor(cursor: string): boolean {
  return cursor.startsWith(KEYSET_PREFIX);
}

/** Decode a canonical `ks:`-prefixed keyset cursor. Inline with the
 *  drizzle/kysely adapters' format — see CONTRIBUTING.md guardrail
 *  about adapters depending only on @onegrid/protocol. */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
  const b64 = cursor.startsWith(KEYSET_PREFIX)
    ? cursor.slice(KEYSET_PREFIX.length)
    : cursor;
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
    return {
      sortValues: obj.sortValues,
      rowId: obj.rowId as string | number,
    };
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
