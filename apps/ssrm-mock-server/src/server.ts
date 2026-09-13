// =============================================================================
// oneGrid SSRM mock server
//
// Plain Node http server speaking oneGrid's SSRM HTTP protocol. Holds 1M
// synthetic rows in memory, columnar (Struct-of-Arrays). Translates
// BlockRequests into filtered + sorted slices using @onegrid/data's same
// primitives the client uses, so the wire round-trip is fully exercised.
//
// Endpoints:
//   GET  /schema   → Schema
//   POST /block    body: BlockRequest   → BlockResponse<'json'>
//   POST /distinct body: DistinctRequest → DistinctResponse
//   GET  /healthz  → "ok"
//
// CORS enabled for any origin (development server only).
//
// Cursor encoding: `offset:N` (string), where N is the row index in the
// active query's sorted+filtered view. Lets the client jump directly to
// any row index — appropriate for the SsrmRowSource bridge in the canvas
// renderer, which needs random access.
// =============================================================================

import http from 'node:http';
import {
  createColumnTable,
  createTableIndex,
  filterIndex,
  groupRows,
  sortIndex,
  type ColumnInput,
  type GroupNode,
} from '@onegrid/data';
import type {
  BlockRequest,
  BlockResponse,
  DistinctRequest,
  HierarchyEntry,
  KeysetCursor,
  Schema,
} from '@onegrid/protocol';
import {
  compareKeysetCursors,
  cursorFromRow,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isLegacyOffsetCursor,
  parseLegacyOffsetCursor,
} from '@onegrid/ssrm';
import { answerDistinct } from './distinct';

// -----------------------------------------------------------------------------
// Synthetic dataset
// -----------------------------------------------------------------------------

const NUM_ROWS = Number(process.env.ROWS ?? '1000000');
const PORT = Number(process.env.PORT ?? '3001');

const FIRST_NAMES = [
  'Aiko', 'Bashir', 'Camila', 'Dmitri', 'Elena', 'Farhan', 'Gabriela', 'Hideki',
  'Imani', 'Jin', 'Kalani', 'Lior', 'Maya', 'Nadir', 'Olamide', 'Priya',
  'Quentin', 'Ravi', 'Saskia', 'Tomás', 'Uma', 'Viktor', 'Wren', 'Xiomara',
  'Yara', 'Zane',
];

const LAST_NAMES = [
  'Adeyemi', 'Bukowski', 'Chen', 'Dvorak', 'Eriksen', 'Fitzgerald', 'Garibay',
  'Halevi', 'Ivanova', 'Jónsson', 'Kapur', 'Lindqvist', 'Mokoena', 'Nakamura',
  'Okonkwo', 'Petrov', 'Quesada', 'Rinaldi', 'Saito', 'Tahir', 'Ueda', 'Vargas',
  'Watanabe', 'Xu', 'Yusuf', 'Zografos',
];

const STATUSES = ['active', 'pending', 'archived', 'pilot', 'churned'] as const;

console.log(`[onegrid:ssrm-mock] generating ${NUM_ROWS.toLocaleString()} synthetic rows…`);
const t0 = Date.now();

const ids = new Int32Array(NUM_ROWS);
const firstNames: string[] = new Array(NUM_ROWS);
const lastNames: string[] = new Array(NUM_ROWS);
const revenue = new Float64Array(NUM_ROWS);
const statuses: string[] = new Array(NUM_ROWS);
const scores = new Int32Array(NUM_ROWS);
const updatedAt: string[] = new Array(NUM_ROWS);

for (let i = 0; i < NUM_ROWS; i++) {
  ids[i] = i;
  firstNames[i] = FIRST_NAMES[i % FIRST_NAMES.length] ?? '';
  lastNames[i] = LAST_NAMES[(i * 17) % LAST_NAMES.length] ?? '';
  revenue[i] = ((i * 1009) % 1_000_000) / 100;
  statuses[i] = STATUSES[i % STATUSES.length] ?? 'active';
  scores[i] = (i * 31) % 100;
  const t = 1_700_000_000_000 + i * 60_000;
  updatedAt[i] = new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

const COLUMNS: ColumnInput[] = [
  { schema: { id: 'id', type: 'int32' }, data: ids },
  { schema: { id: 'firstName', type: 'utf8' }, data: firstNames },
  { schema: { id: 'lastName', type: 'utf8' }, data: lastNames },
  { schema: { id: 'revenue', type: 'float64' }, data: revenue },
  { schema: { id: 'status', type: 'utf8' }, data: statuses },
  { schema: { id: 'score', type: 'int32' }, data: scores },
  { schema: { id: 'updatedAt', type: 'utf8' }, data: updatedAt },
];

const TABLE = createColumnTable(COLUMNS);
// Column dictionaries for /distinct, built lazily on first use per column and
// shared by every request after it. The table is never mutated.
const TABLE_INDEX = createTableIndex(TABLE);

const SCHEMA: Schema = TABLE.schema;

console.log(`[onegrid:ssrm-mock] generated in ${String(Date.now() - t0)} ms.`);

// -----------------------------------------------------------------------------
// Block fetch
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Hierarchical synthetic dataset for tree-mode SSRM
//
// 3 regions × 3-4 countries × 4-6 cities, totaling ~50 nodes. Far more
// expressive than the in-memory tree mode because the entire 1M flat
// table is also a "leaf" of each city (in concept) — but we keep it
// scoped to ~50 nodes here so the wire round-trip is the focus, not
// dataset size.
//
// Node ids look like `r:emea`, `c:emea/germany`, `x:emea/germany/berlin`
// so the response carries enough info to reconstruct lineage.
// -----------------------------------------------------------------------------

interface TreeNode {
  readonly id: string;
  readonly name: string;
  readonly population?: number;
  readonly children?: ReadonlyArray<TreeNode>;
}

const TREE_ROOTS: ReadonlyArray<TreeNode> = [
  {
    id: 'r:emea',
    name: 'EMEA',
    children: [
      {
        id: 'c:emea/germany',
        name: 'Germany',
        children: [
          { id: 'x:emea/germany/berlin', name: 'Berlin', population: 3_700_000 },
          { id: 'x:emea/germany/munich', name: 'Munich', population: 1_500_000 },
        ],
      },
      {
        id: 'c:emea/france',
        name: 'France',
        children: [
          { id: 'x:emea/france/paris', name: 'Paris', population: 2_100_000 },
          { id: 'x:emea/france/lyon', name: 'Lyon', population: 520_000 },
        ],
      },
    ],
  },
  {
    id: 'r:americas',
    name: 'Americas',
    children: [
      {
        id: 'c:americas/usa',
        name: 'USA',
        children: [
          { id: 'x:americas/usa/nyc', name: 'New York', population: 8_300_000 },
          { id: 'x:americas/usa/sf', name: 'San Francisco', population: 880_000 },
        ],
      },
      {
        id: 'c:americas/brazil',
        name: 'Brazil',
        children: [
          { id: 'x:americas/brazil/sp', name: 'São Paulo', population: 12_300_000 },
          { id: 'x:americas/brazil/rio', name: 'Rio', population: 6_700_000 },
        ],
      },
    ],
  },
  {
    id: 'r:apac',
    name: 'APAC',
    children: [
      {
        id: 'c:apac/japan',
        name: 'Japan',
        children: [
          { id: 'x:apac/japan/tokyo', name: 'Tokyo', population: 13_900_000 },
        ],
      },
      {
        id: 'c:apac/india',
        name: 'India',
        children: [
          { id: 'x:apac/india/mumbai', name: 'Mumbai', population: 12_500_000 },
        ],
      },
    ],
  },
];

const TREE_INDEX = new Map<string, TreeNode>();
function indexTree(nodes: ReadonlyArray<TreeNode>): void {
  for (const n of nodes) {
    TREE_INDEX.set(n.id, n);
    if (n.children) indexTree(n.children);
  }
}
indexTree(TREE_ROOTS);

const TREE_SCHEMA: Schema = [
  { id: 'id', type: 'utf8' },
  { id: 'name', type: 'utf8' },
  { id: 'population', type: 'int32' },
];

function fetchTreeBlock(parentId: string | null): BlockResponse<'json'> {
  let children: ReadonlyArray<TreeNode>;
  if (parentId === null) {
    children = TREE_ROOTS;
  } else {
    const node = TREE_INDEX.get(parentId);
    children = node?.children ?? [];
  }
  const rows: Record<string, unknown>[] = children.map((c) => ({
    id: c.id,
    name: c.name,
    population: c.population ?? null,
  }));
  const hierarchy: HierarchyEntry[] = children.map((c) => ({
    id: c.id,
    hasChildren: !!c.children && c.children.length > 0,
  }));
  return {
    encoding: 'json',
    rows,
    hierarchy,
    nextCursor: null,
    prevCursor: null,
    totalRowCount: rows.length,
  };
}

/**
 * Group + aggregate the flat people table per the request's grouping
 * column list and aggregation spec, returning one row per distinct
 * top-level group key. Each row carries:
 *   - the group-key column (e.g. `status: 'active'`)
 *   - one column per aggregation, named by `alias` or
 *     `${fn}_${columnId}` (e.g. `sum_revenue`, `avg_score`)
 *   - `__count__` — the row count under that group, for the chevron
 *     label / count badge in the renderer
 *
 * Pagination ignores cursors here — the result is small enough (at
 * most a few thousand groups) to fit in one response. A real adapter
 * would page the group rows themselves under cursor; that's outside
 * the v0.0.8 item 2 scope.
 */
function fetchGroupedBlock(req: BlockRequest): BlockResponse<'json'> {
  const sel = filterIndex(TABLE, req.filter);
  const filteredIndices = new Set(sel.toIndices());
  const root: GroupNode = groupRows(
    TABLE,
    req.grouping!,
    {
      ...(req.aggregations ? { aggregations: req.aggregations } : {}),
      rowFilter: (i) => filteredIndices.has(i),
    },
  );
  // Top-level group rows. `groupRows` returns a synthetic root whose
  // children are the first-level groups. We emit one wire-row per
  // child. Multi-level open-keys handling lands in v0.0.9.
  const rows: Record<string, unknown>[] = root.children.map((node) => {
    const key = node.path[0] ?? null;
    const groupColumn = req.grouping!.columns[0]!;
    return {
      [groupColumn]: key,
      __count__: node.rowCount,
      ...node.aggregates,
    };
  });
  return {
    encoding: 'json',
    rows,
    nextCursor: null,
    prevCursor: null,
    totalRowCount: rows.length,
  };
}

function fetchBlock(req: BlockRequest): BlockResponse<'json'> {
  // Hierarchical fetches branch into the synthetic tree dataset; flat
  // fetches go through the 1M-row people table below. The presence of
  // `parentId` in the request (even null!) flips the mode; clients that
  // never set it always get the flat table.
  if (req.parentId !== undefined) {
    return fetchTreeBlock(req.parentId);
  }
  // Aggregation pushdown: when the request carries `grouping`, we
  // build the group tree and emit one row per top-level group with
  // the per-group aggregate aliases as columns. Clients get group
  // headers WITHOUT round-tripping every raw row in the group —
  // which is the entire point of pushdown for a 1M-row dataset.
  // (Multi-level grouping + open-key expansion is a v0.0.9 follow-up.)
  if (req.grouping && req.grouping.columns.length > 0) {
    return fetchGroupedBlock(req);
  }
  const sel = filterIndex(TABLE, req.filter);
  // Materialize filtered indices, sorted by req.sort.
  const filteredIndices = sel.toIndices();

  let permutation: Int32Array;
  if (req.sort.length === 0) {
    // Filtered indices are already in source order, which matches an
    // implicit sort by row id.
    permutation = filteredIndices;
  } else {
    // Sort the underlying table, then filter. Could be more efficient by
    // sorting only filtered rows; the mock keeps it simple.
    const fullPerm = sortIndex(TABLE, req.sort);
    const filterMask = sel;
    const out = new Int32Array(filteredIndices.length);
    let j = 0;
    for (let i = 0; i < fullPerm.length; i++) {
      const srcIdx = fullPerm[i] ?? 0;
      if (filterMask.contains(srcIdx)) {
        out[j++] = srcIdx;
      }
    }
    permutation = out.subarray(0, j);
  }

  const totalRowCount = permutation.length;

  // Resolve the request's cursor to a row offset in the permutation.
  // Three input shapes are accepted:
  //   1. null / undefined           → start of the result (no resume)
  //   2. legacy `offset:N`          → SsrmRowSource's random-access path
  //   3. canonical `ks:<base64>`    → keyset cursor; we scan the
  //                                   permutation to find the first row
  //                                   strictly greater than the cursor
  //                                   under the active sort
  //
  // The response always emits canonical keyset cursors. SsrmRowSource
  // ignores response cursors entirely (constructs its own offsets from
  // blockIndex × blockSize), so emitting keyset is safe for it. Real
  // adapters that round-trip cursors get the production-grade format.
  const start = resolveStartOffset(req, permutation, totalRowCount);
  const end = Math.min(totalRowCount, start + req.limit);

  const rows: Record<string, unknown>[] = [];
  for (let i = start; i < end; i++) {
    const srcIdx = permutation[i] ?? 0;
    const row: Record<string, unknown> = {};
    for (const col of TABLE.schema) {
      row[col.id] = TABLE.column(col.id).get(srcIdx);
    }
    rows.push(row);
  }

  // Build the next-cursor from the *last row of this block* under the
  // active sort. The id column is the canonical row id.
  const nextCursor =
    end < totalRowCount && rows.length > 0
      ? encodeKeysetCursor(cursorFromRow(rows[rows.length - 1]!, req.sort, 'id'))
      : null;
  const prevCursor =
    start > 0 && rows.length > 0
      ? encodeKeysetCursor(cursorFromRow(rows[0]!, req.sort, 'id'))
      : null;

  return {
    encoding: 'json',
    rows,
    nextCursor,
    prevCursor,
    totalRowCount,
  };
}

/**
 * Translate the request cursor into the integer row offset within the
 * sorted+filtered permutation. For legacy offset cursors the offset is
 * literal; for keyset cursors we scan the permutation comparing each
 * row's (sortValues, rowId) against the cursor under the active sort.
 *
 * Linear scan is fine for the mock (≤ 1M rows in memory, scan is
 * single-digit ms). A real adapter would issue a `WHERE (sort_col, id)
 * > (cursor.sortValues[0], cursor.rowId)` predicate and let the
 * database's index do the seek.
 */
function resolveStartOffset(
  req: BlockRequest,
  permutation: Int32Array,
  totalRowCount: number,
): number {
  if (req.cursor === null || req.cursor === undefined) return 0;
  if (isLegacyOffsetCursor(req.cursor)) {
    const offset = parseLegacyOffsetCursor(req.cursor);
    return req.direction === 'after'
      ? offset
      : Math.max(0, offset - req.limit);
  }
  // Canonical keyset cursor.
  let cursor: KeysetCursor;
  try {
    cursor = decodeKeysetCursor(req.cursor);
  } catch {
    // Unrecognized cursor format — fall back to start of result.
    return 0;
  }
  // Linear scan — find the first row strictly greater than the cursor.
  for (let i = 0; i < permutation.length; i++) {
    const srcIdx = permutation[i] ?? 0;
    const row: Record<string, unknown> = {};
    for (const col of TABLE.schema) {
      row[col.id] = TABLE.column(col.id).get(srcIdx);
    }
    const rowCursor = cursorFromRow(row, req.sort, 'id');
    if (compareKeysetCursors(rowCursor, cursor, req.sort) > 0) {
      return req.direction === 'after' ? i : Math.max(0, i - req.limit);
    }
  }
  return totalRowCount;
}

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
  'Access-Control-Max-Age': '86400',
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...corsHeaders,
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/schema') {
    send(res, 200, SCHEMA);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/tree-schema') {
    send(res, 200, TREE_SCHEMA);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/block') {
    void readBody(req).then(
      (body) => {
        let request: BlockRequest;
        try {
          request = JSON.parse(body) as BlockRequest;
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        try {
          const t = Date.now();
          const response = fetchBlock(request);
          const ms = Date.now() - t;
          console.log(
            `[onegrid:ssrm-mock] block cursor=${String(request.cursor)} dir=${request.direction} limit=${String(request.limit)} sort=${String(request.sort.length)} filter=${request.filter ? '1' : '0'} → ${String(response.rows.length)} rows in ${String(ms)}ms`,
          );
          send(res, 200, response);
        } catch (err) {
          console.error('[onegrid:ssrm-mock] error', err);
          send(res, 500, { error: String(err) });
        }
      },
      (err) => {
        console.error('[onegrid:ssrm-mock] body error', err);
        send(res, 500, { error: 'body read error' });
      },
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/distinct') {
    void readBody(req).then(
      (body) => {
        let request: DistinctRequest;
        try {
          request = JSON.parse(body) as DistinctRequest;
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        try {
          const t = Date.now();
          const response = answerDistinct(TABLE_INDEX, request);
          const ms = Date.now() - t;
          console.log(
            `[onegrid:ssrm-mock] distinct column=${request.columnId} filter=${request.filter ? '1' : '0'} → ${String(response.entry.length)} values in ${String(ms)}ms`,
          );
          send(res, 200, response);
        } catch (err) {
          console.error('[onegrid:ssrm-mock] error', err);
          send(res, 500, { error: String(err) });
        }
      },
      (err) => {
        console.error('[onegrid:ssrm-mock] body error', err);
        send(res, 500, { error: 'body read error' });
      },
    );
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[onegrid:ssrm-mock] listening on http://localhost:${String(PORT)}`);
  console.log('[onegrid:ssrm-mock] endpoints: /healthz, /schema, /block, /distinct');
});
