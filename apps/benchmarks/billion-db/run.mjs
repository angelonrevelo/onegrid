// =============================================================================
// Query cost of a grid's server-side row model, at up to a billion rows.
//
// The browser benchmark (src/perf-billion-row.spec.ts) proves the grid can
// mount and scroll 1B rows. This measures the other half: what each thing the
// grid asks a database for actually costs. Every grid-shaped query is produced
// by @onegrid/duckdb's real SQL builders, so what is timed is what the adapter
// sends — which is how this harness found two builder bugs (LIKE without an
// ESCAPE clause; ILIKE on non-VARCHAR columns).
//
//   node apps/benchmarks/billion-db/run.mjs build <file.duckdb> <rows>
//   node apps/benchmarks/billion-db/run.mjs bench <file.duckdb> [--no-deep-offset]
//
// Needs the DuckDB CLI (`duckdb`, or set DUCKDB=/path/to/duckdb) and a built
// @onegrid/duckdb (`pnpm --filter @onegrid/duckdb build`). The CLI has no bind
// parameters, so `?` placeholders are replaced with strictly-encoded literals —
// fine for a local benchmark, never for user input.
// =============================================================================

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DUCKDB = process.env.DUCKDB ?? 'duckdb';
const [mode, file, arg] = process.argv.slice(2);

function usage(message) {
  console.error(`${message}\n\n  run.mjs build <file.duckdb> <rows>\n  run.mjs bench <file.duckdb> [--no-deep-offset]`);
  process.exit(2);
}

function duckdb(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(DUCKDB, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function build() {
  const rows = Number(arg);
  if (!file || !Number.isInteger(rows) || rows <= 0) usage('build needs a file and a positive integer row count');
  const sql = readFileSync(join(here, 'build.sql'), 'utf8').replace('{{row_count}}', String(rows));
  const started = Date.now();
  const { code, stdout, stderr } = await duckdb([file], sql);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  console.log(`build: ${rows.toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)} s (exit ${String(code)})`);
  process.exit(code ?? 1);
}

// ---- SQL generation through the real builders ---------------------------------

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite literal ${String(v)}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Replace `?` placeholders that sit outside quoted strings and identifiers. */
function inline({ sql, params }) {
  let i = 0;
  let quote = null;
  let out = '';
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      if (i >= params.length) throw new Error(`more placeholders than params in: ${sql}`);
      out += literal(params[i++]);
    } else {
      out += ch;
    }
  }
  if (i !== params.length) throw new Error(`unused params in: ${sql}`);
  return out;
}

async function querySet(deepOffset) {
  const builderUrl = pathToFileURL(join(here, '../../../packages/duckdb/dist/index.js')).href;
  const { buildBlockSql, buildCountSql, buildDistinctSql } = await import(builderUrl);
  const SOURCE = '"row"';
  const COLUMN = ['id', 'region', 'status', 'name', 'amount', 'created'];
  const request = (over = {}) => ({ sort: [], filter: null, limit: 100, cursor: null, direction: 'after', ...over });
  const block = (over) => inline(buildBlockSql({ source: SOURCE, request: request(over), defaultLimit: 100, idColumn: 'id' }));
  const count = (over) => inline(buildCountSql({ source: SOURCE, request: request(over) }));
  const distinct = (over) => inline(buildDistinctSql({ source: SOURCE, request: { limit: 1000, ...over } }));
  const quick = (q) => ({
    type: 'logical',
    op: 'or',
    filters: COLUMN.map((columnId) => ({ type: 'comparison', columnId, op: 'contains', value: q, caseSensitive: false })),
  });
  const active = { type: 'comparison', columnId: 'status', op: 'eq', value: 'active' };
  const query = [
    ['count: all rows', count({})],
    ['block: first 100 (ORDER BY id)', block({})],
    ['block: 100 rows at the midpoint via keyset seek', 'SELECT * FROM "row" WHERE "id" >= (SELECT max("id") // 2 FROM "row") ORDER BY "id" ASC LIMIT 101'],
    ['block: first 100 sorted by amount desc', block({ sort: [{ columnId: 'amount', direction: 'desc' }] })],
    ['count: status = active', count({ filter: active })],
    ['block: first 100 where status = active', block({ filter: active })],
    ['quick filter "a": block', block({ filter: quick('a') })],
    ['quick filter "a": count', count({ filter: quick('a') })],
    ['quick filter "an": block', block({ filter: quick('an') })],
    ['quick filter "an": count', count({ filter: quick('an') })],
    ['quick filter "ann": block', block({ filter: quick('ann') })],
    ['quick filter "ann": count', count({ filter: quick('ann') })],
    ['distinct: status (5 values)', distinct({ columnId: 'status' })],
    ['distinct: region (8 values)', distinct({ columnId: 'region' })],
    ['distinct: name (high cardinality, top 1000)', distinct({ columnId: 'name' })],
    ['distinct: name where status = active', distinct({ columnId: 'name', filter: active })],
    ['group-by pushdown: region, COUNT, SUM(amount)', 'SELECT "region", COUNT(*) AS "__count__", SUM("amount") AS "sum_amount" FROM "row" GROUP BY "region"'],
  ];
  if (deepOffset) {
    // Last on purpose: OFFSET has to produce and discard every row before the
    // midpoint. The offset is computed from the table so it is the midpoint at
    // any scale.
    query.push(['block: 100 rows at the midpoint via OFFSET (what offset cursors send)', null]);
  }
  return query;
}

async function bench() {
  if (!file) usage('bench needs a file');
  const deepOffset = !process.argv.includes('--no-deep-offset');
  const query = await querySet(deepOffset);

  const { stdout: countOut } = await duckdb(['-readonly', '-csv', '-noheader', file], 'SELECT count(*) FROM "row";\n');
  const rowCount = Number(countOut.trim());
  if (!Number.isFinite(rowCount) || rowCount <= 0) usage(`could not read row count from ${file}: ${countOut}`);

  const lines = ['.mode trash', '.timer on'];
  for (const [label, sql] of query) {
    const text =
      sql ??
      (await (async () => {
        const { buildBlockSql } = await import(pathToFileURL(join(here, '../../../packages/duckdb/dist/index.js')).href);
        return inline(
          buildBlockSql({
            source: '"row"',
            request: { sort: [], filter: null, limit: 100, cursor: `offset:${String(Math.floor(rowCount / 2))}`, direction: 'after' },
            defaultLimit: 100,
            idColumn: 'id',
          }),
        );
      })());
    lines.push(`.print __query__ ${label}`, `${text};`);
  }

  console.log(`bench: ${rowCount.toLocaleString()} rows in ${file}`);
  const started = Date.now();
  const { code, stdout, stderr } = await duckdb(['-readonly', file], `${lines.join('\n')}\n`);
  const result = [];
  let label = null;
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    if (line.startsWith('__query__ ')) label = line.slice('__query__ '.length);
    const time = /Run Time \(s\): real ([0-9.]+)/.exec(line);
    if (time && label) {
      result.push([label, Number(time[1])]);
      label = null;
    }
  }
  for (const [name, seconds] of result) console.log(`${seconds.toFixed(3).padStart(10)} s  ${name}`);
  const error = `${stdout}\n${stderr}`.split(/\r?\n/).filter((l) => /Error/.test(l));
  console.log(`total ${((Date.now() - started) / 1000).toFixed(1)} s; ${String(result.length)}/${String(query.length)} timed; ${String(error.length)} errors`);
  for (const e of error.slice(0, 5)) console.log(`  ${e}`);
  process.exit(code === 0 && error.length === 0 && result.length === query.length ? 0 : 1);
}

if (mode === 'build') await build();
else if (mode === 'bench') await bench();
else usage(`unknown mode ${String(mode)}`);
