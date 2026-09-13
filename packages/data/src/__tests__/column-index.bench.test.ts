// =============================================================================
// ColumnIndex vs full scan, at grid scale — so "cheaper per keystroke" is a number.
//
// Opt-in (OG_INDEX_BENCH=1): a 1M-row table is too slow for the default suite.
// Each measured call is also checked against the scan result, so a fast wrong
// answer fails the run rather than printing a flattering row.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { FilterNode } from '@onegrid/protocol';
import { createColumnTable } from '../column-table';
import { enumerateDistinct } from '../distinct';
import { filterIndex } from '../filter';
import { createTableIndex, enumerateDistinctIndexed, filterIndexed } from '../column-index';

const N = Number(process.env.OG_INDEX_BENCH_ROW ?? 1_000_000);

const FIRST = ['Aiko', 'Ben', 'Carmen', 'Dmitri', 'Elif', 'Farah', 'Gustavo', 'Hana', 'Ivan', 'Jun', 'Kofi', 'Lena'];
const LAST = ['Tanaka', 'Okafor', 'Silva', 'Novak', 'Reyes', 'Kim', 'Haddad', 'Larsen', 'Moreau', 'Singh'];

function table() {
  let s = 0x2545f491;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  const status = new Array<unknown>(N);
  const city = new Array<unknown>(N);
  const name = new Array<unknown>(N);
  const email = new Array<unknown>(N);
  const STATUS = ['active', 'pending', 'suspended', 'closed', null];
  for (let i = 0; i < N; i++) {
    status[i] = STATUS[rand() % STATUS.length];
    city[i] = `City-${rand() % 2000}`;
    name[i] = `${FIRST[rand() % FIRST.length]!} ${LAST[rand() % LAST.length]!}`;
    email[i] = `user${i}.${rand() % 1000}@example.com`; // unique: the dictionary's worst case
  }
  return createColumnTable([
    { schema: { id: 'status', type: 'utf8' }, data: status },
    { schema: { id: 'city', type: 'utf8' }, data: city },
    { schema: { id: 'name', type: 'utf8' }, data: name },
    { schema: { id: 'email', type: 'utf8' }, data: email },
  ]);
}

const time = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

/** The playground's quick filter: OR of case-insensitive contains across columns. */
const quick = (value: string, column: readonly string[]): FilterNode => ({
  type: 'logical',
  op: 'or',
  filters: column.map((columnId) => ({ type: 'comparison', columnId, op: 'contains', value })),
});

describe.skipIf(!process.env.OG_INDEX_BENCH)(`ColumnIndex vs scan at ${N.toLocaleString()} rows`, () => {
  it('reports build, per-keystroke quick filter, and set-filter distinct cost', () => {
    const t = table();
    const line: string[] = [`${'case'.padEnd(46)}${'scan ms'.padStart(10)}${'index ms'.padStart(10)}${'×'.padStart(8)}`];
    const row = (name: string, scan: number, index: number) =>
      line.push(`${name.padEnd(46)}${scan.toFixed(1).padStart(10)}${index.toFixed(1).padStart(10)}${(scan / index).toFixed(1).padStart(8)}`);

    const set: ReadonlyArray<readonly string[]> = [['status', 'city', 'name'], ['status', 'city', 'name', 'email']];
    for (const column of set) {
      const tag = column.includes('email') ? '+unique email' : 'low/mid card';
      const tableIndex = createTableIndex(t);
      const build = time(() => column.forEach((c) => tableIndex.column(c)));
      line.push(`${`build index (${column.length} col, ${tag})`.padEnd(46)}${''.padStart(10)}${build.toFixed(1).padStart(10)}`);

      let scanTotal = 0;
      let indexTotal = 0;
      for (const value of ['a', 'ai', 'aik', 'aiko', 'aiko t', 'aiko ta']) {
        const filter = quick(value, column);
        let want!: ReturnType<typeof filterIndex>;
        let got!: ReturnType<typeof filterIndex>;
        const scan = time(() => (want = filterIndex(t, filter)));
        const index = time(() => (got = filterIndexed(tableIndex, filter)));
        expect(got.cardinality).toBe(want.cardinality);
        expect(Array.from(got._bytes.subarray(0, 4096))).toEqual(Array.from(want._bytes.subarray(0, 4096)));
        scanTotal += scan;
        indexTotal += index;
        row(`  keystroke "${value}" (${tag})`, scan, index);
      }
      row(`  typing "aiko ta", 6 keystrokes (${tag})`, scanTotal, indexTotal);
    }

    const tableIndex = createTableIndex(t);
    tableIndex.column('city');
    let want = enumerateDistinct(t, 'city');
    let got = enumerateDistinctIndexed(tableIndex, 'city');
    row('set filter: distinct city (2000 values)', time(() => (want = enumerateDistinct(t, 'city'))), time(() => (got = enumerateDistinctIndexed(tableIndex, 'city'))));
    expect(got).toEqual(want);

    const selection = filterIndexed(tableIndex, { type: 'comparison', columnId: 'status', op: 'eq', value: 'active' });
    row(
      'set filter: distinct city where status=active',
      time(() => (want = enumerateDistinct(t, 'city', { rowFilter: (i) => selection.contains(i) }))),
      time(() => (got = enumerateDistinctIndexed(tableIndex, 'city', { selection }))),
    );
    expect(got).toEqual(want);

    console.log(`\n[bench] column index at ${N.toLocaleString()} rows\n${line.join('\n')}`);
  }, 600_000);
});
