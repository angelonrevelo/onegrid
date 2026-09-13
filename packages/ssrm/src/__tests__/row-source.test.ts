// =============================================================================
// SsrmRowSource — debounce, abort, stale-response discard, distinct.
//
// The data source here is a hand-driven fake: every fetchBlock call is
// recorded with its AbortSignal and stays pending until the test resolves it,
// so ordering (a late response for an old filter) is under the test's control.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BlockRequest,
  BlockResponse,
  ComparisonFilter,
  DataSource,
  DistinctRequest,
  DistinctResult,
  FilterModel,
} from '@onegrid/protocol';
import { excludeColumnFilter } from '../filter-exclude';
import { createSsrmRowSource } from '../row-source';

interface Call {
  readonly req: BlockRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (res: BlockResponse) => void;
}

function fakeSource(option: { honourAbort?: boolean; withDistinct?: boolean } = {}) {
  const honourAbort = option.honourAbort ?? true;
  const call: Call[] = [];
  const distinctCall: DistinctRequest[] = [];
  const source: DataSource = {
    schema: () => [],
    fetchBlock: (req, opts) =>
      new Promise<BlockResponse>((resolve, reject) => {
        call.push({ req, signal: opts?.signal, resolve });
        if (honourAbort) {
          opts?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
      }),
    ...(option.withDistinct === false
      ? {}
      : {
          fetchDistinct: (req: DistinctRequest): Promise<DistinctResult> => {
            distinctCall.push(req);
            return Promise.resolve({
              kind: 'distinct',
              entry: [{ value: 'active', count: 3 }],
              truncated: false,
            });
          },
        }),
  };
  return { source, call, distinctCall };
}

const block = (label: string): BlockResponse => ({
  encoding: 'json',
  rows: Array.from({ length: 10 }, (_, i) => ({ v: `${label}${String(i)}` })),
  nextCursor: null,
  prevCursor: null,
});

const contains = (value: string): ComparisonFilter => ({
  type: 'comparison',
  columnId: 'name',
  op: 'contains',
  value,
});

/** Let promise chains (then → catch → finally) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SsrmRowSource — debounced query changes', () => {
  /** Type `query` one character every 50ms, reading the viewport after each
   *  keystroke the way the renderer does. Returns block fetches fired. */
  async function typeQuery(debounceMs: number, query: string): Promise<number> {
    const { source, call } = fakeSource();
    const rs = createSsrmRowSource(source, { numRows: 100, blockSize: 10, debounceMs });
    rs.getCell(0, 'v');
    call[0]!.resolve(block('initial'));
    await settle();
    const before = call.length;
    for (let i = 1; i <= query.length; i++) {
      rs.setFilter(contains(query.slice(0, i)));
      rs.getCell(0, 'v');
      vi.advanceTimersByTime(50);
      await settle();
    }
    vi.advanceTimersByTime(debounceMs);
    rs.getCell(0, 'v');
    await settle();
    const fired = call.length - before;
    expect(call[call.length - 1]!.req.filter).toEqual(contains(query));
    return fired;
  }

  it('coalesces a burst of setFilter calls into one query', async () => {
    const without = await typeQuery(0, 'aikoab');
    const withDebounce = await typeQuery(150, 'aikoab');
    console.log(
      `[ssrm] block requests while typing a 6-char query: ${String(without)} without debounce, ${String(withDebounce)} with debounceMs=150`,
    );
    expect(without).toBe(6);
    expect(withDebounce).toBe(1);
  });

  it('keeps serving the previous blocks while a change is pending', async () => {
    const { source, call } = fakeSource();
    const rs = createSsrmRowSource(source, { numRows: 100, blockSize: 10, debounceMs: 150 });
    rs.getCell(0, 'v');
    call[0]!.resolve(block('a'));
    await settle();
    rs.setFilter(contains('x'));
    expect(rs.getCell(0, 'v')).toBe('a0');
    expect(call).toHaveLength(1);
  });

  it('debounces setSort the same way', () => {
    const { source, call } = fakeSource();
    const onUpdate = vi.fn();
    const rs = createSsrmRowSource(source, { numRows: 100, blockSize: 10, debounceMs: 100, onUpdate });
    rs.setSort([{ columnId: 'v', direction: 'asc' }]);
    rs.setSort([{ columnId: 'v', direction: 'desc' }]);
    expect(onUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    rs.getCell(0, 'v');
    expect(call[0]!.req.sort).toEqual([{ columnId: 'v', direction: 'desc' }]);
  });
});

describe('SsrmRowSource — abort + stale responses', () => {
  it('aborts the in-flight fetch of a superseded query', () => {
    const { source, call } = fakeSource();
    const rs = createSsrmRowSource(source, { numRows: 100, blockSize: 10 });
    rs.getCell(0, 'v');
    expect(call[0]!.signal?.aborted).toBe(false);
    rs.setFilter(contains('x'));
    expect(call[0]!.signal?.aborted).toBe(true);
  });

  it('discards a response that lands after the query changed', async () => {
    const { source, call } = fakeSource({ honourAbort: false });
    const rs = createSsrmRowSource(source, { numRows: 100, blockSize: 10 });
    rs.getCell(0, 'v');
    rs.setFilter(contains('x'));
    rs.getCell(0, 'v');
    expect(call).toHaveLength(2);

    call[0]!.resolve(block('stale'));
    await settle();
    expect(rs.getCell(0, 'v')).toBe('…');

    call[1]!.resolve(block('fresh'));
    await settle();
    expect(rs.getCell(0, 'v')).toBe('fresh0');
  });

  it("a late old-generation fetch does not clear the new generation's in-flight entry", async () => {
    const { source, call } = fakeSource({ honourAbort: false });
    const rs = createSsrmRowSource(source, { numRows: 100, blockSize: 10 });
    rs.getCell(0, 'v');
    rs.setFilter(contains('x'));
    rs.getCell(0, 'v');
    call[0]!.resolve(block('stale'));
    await settle();
    // Re-reading must not fire a duplicate fetch for the still-pending block.
    rs.getCell(0, 'v');
    expect(call).toHaveLength(2);
  });
});

describe('SsrmRowSource — fetchDistinct', () => {
  it("asks under the active filter minus the column's own set rule", async () => {
    const { source, distinctCall } = fakeSource();
    const rs = createSsrmRowSource(source, { numRows: 100 });
    rs.setFilter({
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'comparison', columnId: 'status', op: 'in', values: ['active'] },
        contains('ai'),
      ],
    });
    const result = await rs.fetchDistinct('status', { search: 'ac' });
    expect(result.kind).toBe('distinct');
    expect(distinctCall[0]).toEqual({
      columnId: 'status',
      filter: contains('ai'),
      limit: 1000,
      search: 'ac',
    });
  });

  it('uses a pending (debounced) filter, which is what the user sees', async () => {
    const { source, distinctCall } = fakeSource();
    const rs = createSsrmRowSource(source, { numRows: 100, debounceMs: 500 });
    rs.setFilter(contains('pending'));
    await rs.fetchDistinct('status');
    expect(distinctCall[0]!.filter).toEqual(contains('pending'));
  });

  it('resolves unsupported when the data source cannot answer', async () => {
    const { source } = fakeSource({ withDistinct: false });
    const rs = createSsrmRowSource(source, { numRows: 100 });
    const result = await rs.fetchDistinct('status');
    expect(result.kind).toBe('unsupported');
  });
});

describe('excludeColumnFilter', () => {
  const setRule = (columnId: string): ComparisonFilter => ({
    type: 'comparison',
    columnId,
    op: 'in',
    values: ['a'],
  });

  it('drops a bare set rule on the column to no filter', () => {
    expect(excludeColumnFilter(setRule('status'), 'status')).toBeNull();
  });

  it('keeps set rules on other columns and non-set rules on the same column', () => {
    const sameColumnContains: FilterModel = {
      type: 'comparison',
      columnId: 'status',
      op: 'contains',
      value: 'x',
    };
    expect(excludeColumnFilter(setRule('region'), 'status')).toEqual(setRule('region'));
    expect(excludeColumnFilter(sameColumnContains, 'status')).toEqual(sameColumnContains);
  });

  it('strips through nested ANDs but leaves OR and NOT subtrees whole', () => {
    const orTree: FilterModel = {
      type: 'logical',
      op: 'or',
      filters: [setRule('status'), contains('z')],
    };
    const filter: FilterModel = {
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'logical', op: 'and', filters: [setRule('status'), contains('a')] },
        orTree,
      ],
    };
    expect(excludeColumnFilter(filter, 'status')).toEqual({
      type: 'logical',
      op: 'and',
      filters: [contains('a'), orTree],
    });
  });
});
