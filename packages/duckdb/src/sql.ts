// =============================================================================
// SQL builder for DuckDB BlockRequest translation.
//
// Produces parameterized SQL: identifiers double-quoted (DuckDB's standard),
// values passed as positional parameters via `?` placeholders. DuckDB-WASM's
// `connection.query` and `connection.send` both accept parameter arrays,
// keeping us safe from injection.
//
// Cursor strategy: offset-based. DuckDB queries the in-memory engine
// directly, so OFFSET N is cheap (no index scan to skip rows on disk like
// Postgres). The cursor format `offset:N` matches the SsrmRowSource bridge
// in @onegrid/ssrm.
// =============================================================================

import type {
  BlockRequest,
  ComparisonFilter,
  DistinctRequest,
  FilterNode,
  LogicalFilter,
  SortField,
} from '@onegrid/protocol';

export interface SqlPart {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

export interface BuildBlockSqlOptions {
  /** Quoted source: a table name or `(SELECT … )` subquery. */
  readonly source: string;
  readonly request: BlockRequest;
  readonly defaultLimit: number;
  /**
   * Column id used for stable secondary ordering. Without one, DuckDB may
   * return ties in different orders between OFFSET pages, scrambling the
   * client view. Pass undefined to skip.
   */
  readonly idColumn?: string;
}

/** Build the data-fetch SQL for a BlockRequest. Returns SQL + parameters. */
export function buildBlockSql(options: BuildBlockSqlOptions): SqlPart {
  const { source, request, defaultLimit, idColumn } = options;
  const limit = request.limit > 0 ? request.limit : defaultLimit;
  const offset = parseOffsetCursor(request.cursor);
  const direction = request.direction;

  const where = buildWhere(request);
  const orderBy = buildOrderBy(request.sort, direction, idColumn);
  // +1 to detect hasMore.
  const fetchLimit = limit + 1;
  const startOffset = direction === 'after' ? offset : Math.max(0, offset - limit);

  const sql =
    `SELECT * FROM ${source}` +
    (where.sql ? ` WHERE ${where.sql}` : '') +
    (orderBy ? ` ORDER BY ${orderBy}` : '') +
    ` LIMIT ${String(fetchLimit)} OFFSET ${String(startOffset)}`;

  return { sql, params: where.params };
}

/** Build a COUNT(*) SQL matching the same filter. Used for totalRowCount. */
export function buildCountSql(options: Pick<BuildBlockSqlOptions, 'source' | 'request'>): SqlPart {
  const where = buildWhere(options.request);
  const sql =
    `SELECT COUNT(*) AS c FROM ${options.source}` +
    (where.sql ? ` WHERE ${where.sql}` : '');
  return { sql, params: where.params };
}

export interface BuildDistinctSqlOptions {
  /** Quoted source: a table name or `(SELECT … )` subquery. */
  readonly source: string;
  readonly request: DistinctRequest;
}

/**
 * Distinct values + counts for one column under the request's filter,
 * ordered by count descending. Fetches `limit + 1` rows so the caller can
 * report truncation without a second query.
 */
export function buildDistinctSql(options: BuildDistinctSqlOptions): SqlPart {
  const { source, request } = options;
  const col = quoteIdent(request.columnId);
  const params: unknown[] = [];
  const clause: string[] = [];
  if (request.filter) {
    const filterSql = translateFilterNode(request.filter, params);
    if (filterSql) clause.push(filterSql);
  }
  if (request.search) {
    params.push(`${escapeLike(request.search)}%`);
    clause.push(`CAST(${col} AS VARCHAR) ILIKE ?`);
  }
  const limit = Math.max(0, Math.floor(request.limit)) + 1;
  const sql =
    `SELECT ${col} AS "value", COUNT(*) AS "count" FROM ${source}` +
    (clause.length > 0 ? ` WHERE ${clause.join(' AND ')}` : '') +
    ` GROUP BY ${col} ORDER BY "count" DESC, ${col} ASC NULLS LAST LIMIT ${String(limit)}`;
  return { sql, params };
}

/** Build the SQL that DESCRIBEs the source's columns + types. */
export function buildSchemaSql(source: string): string {
  return `DESCRIBE SELECT * FROM ${source} LIMIT 0`;
}

// -----------------------------------------------------------------------------
// WHERE construction
// -----------------------------------------------------------------------------

function buildWhere(request: BlockRequest): SqlPart {
  if (!request.filter) return { sql: '', params: [] };
  const params: unknown[] = [];
  const sql = translateFilterNode(request.filter, params);
  return { sql: sql ?? '', params };
}

function translateFilterNode(node: FilterNode, params: unknown[]): string | null {
  if (node.type === 'comparison') return translateComparison(node, params);
  return translateLogical(node, params);
}

function translateComparison(node: ComparisonFilter, params: unknown[]): string | null {
  const col = quoteIdent(node.columnId);

  switch (node.op) {
    case 'eq':
      params.push(node.value);
      return `${col} = ?`;
    case 'neq':
      params.push(node.value);
      return `${col} <> ?`;
    case 'lt':
      params.push(node.value);
      return `${col} < ?`;
    case 'lte':
      params.push(node.value);
      return `${col} <= ?`;
    case 'gt':
      params.push(node.value);
      return `${col} > ?`;
    case 'gte':
      params.push(node.value);
      return `${col} >= ?`;
    case 'in':
    case 'notIn': {
      const values = node.values ?? [];
      if (values.length === 0) {
        return node.op === 'in' ? '1=0' : '1=1';
      }
      const placeholders = values.map(() => '?').join(', ');
      params.push(...values);
      return `${col} ${node.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`;
    }
    case 'isNull':
      return `${col} IS NULL`;
    case 'isNotNull':
      return `${col} IS NOT NULL`;
    case 'between': {
      const [lo, hi] = node.values ?? [];
      params.push(lo, hi);
      return `${col} BETWEEN ? AND ?`;
    }
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      params.push(lo, hi);
      return `${col} NOT BETWEEN ? AND ?`;
    }
    case 'contains': {
      const op = node.caseSensitive ? 'LIKE' : 'ILIKE';
      params.push(`%${escapeLike(String(node.value ?? ''))}%`);
      return `${col} ${op} ?`;
    }
    case 'notContains': {
      const op = node.caseSensitive ? 'NOT LIKE' : 'NOT ILIKE';
      params.push(`%${escapeLike(String(node.value ?? ''))}%`);
      return `${col} ${op} ?`;
    }
    case 'startsWith': {
      const op = node.caseSensitive ? 'LIKE' : 'ILIKE';
      params.push(`${escapeLike(String(node.value ?? ''))}%`);
      return `${col} ${op} ?`;
    }
    case 'endsWith': {
      const op = node.caseSensitive ? 'LIKE' : 'ILIKE';
      params.push(`%${escapeLike(String(node.value ?? ''))}`);
      return `${col} ${op} ?`;
    }
    default:
      return null;
  }
}

function translateLogical(node: LogicalFilter, params: unknown[]): string | null {
  if (node.op === 'not') {
    const inner = node.filters[0];
    if (!inner) return null;
    const sub = translateFilterNode(inner, params);
    return sub ? `NOT (${sub})` : null;
  }
  const subs = node.filters
    .map((f) => translateFilterNode(f, params))
    .filter((s): s is string => Boolean(s));
  if (subs.length === 0) return null;
  if (subs.length === 1) return subs[0]!;
  const joiner = node.op === 'and' ? ' AND ' : ' OR ';
  return `(${subs.join(joiner)})`;
}

// -----------------------------------------------------------------------------
// ORDER BY
// -----------------------------------------------------------------------------

function buildOrderBy(
  sort: ReadonlyArray<SortField>,
  direction: 'after' | 'before',
  idColumn?: string,
): string {
  const goingForward = direction === 'after';
  const parts: string[] = [];
  for (const field of sort) {
    const dir = (field.direction === 'asc') === goingForward ? 'ASC' : 'DESC';
    const nulls = (field.nulls ?? 'last') === 'last' ? 'NULLS LAST' : 'NULLS FIRST';
    parts.push(`${quoteIdent(field.columnId)} ${dir} ${nulls}`);
  }
  if (idColumn) {
    const dir = goingForward ? 'ASC' : 'DESC';
    parts.push(`${quoteIdent(idColumn)} ${dir}`);
  }
  return parts.join(', ');
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function quoteIdent(id: string): string {
  // DuckDB SQL identifiers: double-quoted, with internal " doubled.
  return `"${id.replace(/"/g, '""')}"`;
}

function escapeLike(s: string): string {
  // Default LIKE escape char is `\\` in DuckDB; ESCAPE not specified means
  // `\\` is treated as the escape character. We produce `\` before special
  // chars so `%` and `_` are literal.
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function parseOffsetCursor(cursor: string | null): number {
  if (!cursor) return 0;
  if (cursor.startsWith('offset:')) {
    const n = Number(cursor.slice('offset:'.length));
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

export function encodeOffsetCursor(offset: number): string {
  return `offset:${String(offset)}`;
}
