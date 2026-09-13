// =============================================================================
// The mock server's /distinct answer must equal enumerateDistinct restricted
// to the rows filterIndex selects — the scan the endpoint replaces.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  createColumnTable,
  createTableIndex,
  enumerateDistinct,
  filterIndex,
} from '@onegrid/data';
import type { FilterModel } from '@onegrid/protocol';
import { answerDistinct } from '../distinct';

const N = 5000;
const STATUS = ['active', 'pending', 'archived', null];
const status: unknown[] = [];
const city: unknown[] = [];
const score = new Int32Array(N);
for (let i = 0; i < N; i++) {
  status.push(STATUS[(i * 7) % STATUS.length]);
  city.push(`City-${String((i * 31) % 300)}`);
  score[i] = (i * 13) % 100;
}
const TABLE = createColumnTable([
  { schema: { id: 'status', type: 'utf8' }, data: status },
  { schema: { id: 'city', type: 'utf8' }, data: city },
  { schema: { id: 'score', type: 'int32' }, data: score },
]);

const CASE: ReadonlyArray<[string, FilterModel]> = [
  ['no filter', null],
  ['eq', { type: 'comparison', columnId: 'status', op: 'eq', value: 'active' }],
  ['contains', { type: 'comparison', columnId: 'city', op: 'contains', value: 'city-1' }],
  [
    'or + range',
    {
      type: 'logical',
      op: 'or',
      filters: [
        { type: 'comparison', columnId: 'score', op: 'lt', value: 10 },
        { type: 'comparison', columnId: 'status', op: 'isNull' },
      ],
    },
  ],
  ['matches nothing', { type: 'comparison', columnId: 'city', op: 'eq', value: 'nowhere' }],
];

describe('answerDistinct ≡ enumerateDistinct over filterIndex', () => {
  const tableIndex = createTableIndex(TABLE);

  for (const [name, filter] of CASE) {
    for (const columnId of ['status', 'city', 'score']) {
      it(`${name} · ${columnId}`, () => {
        const selection = filter === null ? null : filterIndex(TABLE, filter);
        const want = enumerateDistinct(TABLE, columnId, {
          limit: null,
          ...(selection ? { rowFilter: (i: number) => selection.contains(i) } : {}),
        });
        const got = answerDistinct(tableIndex, { columnId, filter, limit: 100_000 });
        expect(got.entry).toEqual(want.map((d) => ({ value: d.value, count: d.count })));
        expect(got.truncated).toBe(false);
      });
    }
  }

  it('applies a case-insensitive prefix and reports truncation', () => {
    const got = answerDistinct(tableIndex, {
      columnId: 'city',
      filter: null,
      search: 'CITY-29',
      limit: 3,
      requestId: 'q1',
    });
    const want = enumerateDistinct(TABLE, 'city', { limit: null }).filter((d) =>
      String(d.value).toLowerCase().startsWith('city-29'),
    );
    expect(got.entry).toEqual(want.slice(0, 3));
    expect(got.truncated).toBe(want.length > 3);
    expect(got.requestId).toBe('q1');
  });

  it('answers an unknown column with an empty list', () => {
    expect(answerDistinct(tableIndex, { columnId: 'nope', filter: null, limit: 10 })).toEqual({
      kind: 'distinct',
      entry: [],
      truncated: false,
    });
  });
});
