// =============================================================================
// Prisma query compiler — unit tests.
//
// Prisma's API surface is "one argument object per call", so the compiled
// value IS what the client receives. These assert on it literally.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { BlockRequest } from '@onegrid/protocol';
import {
  aliasOf,
  compileOrderBy,
  compilePrismaQuery,
  compileSelect,
  compileWhere,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  parseGroupByResult,
  GROUP_COUNT_KEY,
  type CompiledFindManyQuery,
  type CompiledGroupByQuery,
  type PrismaModelDescriptor,
} from '../query';

const MODEL: PrismaModelDescriptor = {
  model: 'order',
  field: ['id', 'status', 'amount', 'customerId', 'title'],
  primaryKey: 'id',
  relationField: ['customer'],
};

function req(override: Partial<BlockRequest> = {}): BlockRequest {
  return { cursor: null, direction: 'after', limit: 50, sort: [], filter: null, ...override };
}

describe('compilePrismaQuery — findMany path', () => {
  it('emits orderBy with the primary-key tiebreaker and a positive take', () => {
    const out = compilePrismaQuery(req(), MODEL) as CompiledFindManyQuery;
    expect(out.kind).toBe('findMany');
    expect(out.arg).toEqual({ orderBy: [{ id: 'asc' }], take: 50 });
  });

  it('carries multi-column sort through in priority order', () => {
    const out = compilePrismaQuery(
      req({
        sort: [
          { columnId: 'status', direction: 'asc' },
          { columnId: 'amount', direction: 'desc' },
        ],
      }),
      MODEL,
    ) as CompiledFindManyQuery;
    expect(out.arg.orderBy).toEqual([{ status: 'asc' }, { amount: 'desc' }, { id: 'asc' }]);
  });

  it('uses cursor + skip:1 rather than an offset', () => {
    const out = compilePrismaQuery(req(), MODEL, {
      sortValues: [10],
      rowId: 'ord-3',
    }) as CompiledFindManyQuery;
    expect(out.arg.cursor).toEqual({ id: 'ord-3' });
    expect(out.arg.skip).toBe(1);
    expect(out.arg.take).toBe(50);
  });

  it('walks backwards with a negative take instead of flipping the sort', () => {
    const out = compilePrismaQuery(
      req({ direction: 'before', sort: [{ columnId: 'amount', direction: 'asc' }] }),
      MODEL,
      { sortValues: [10], rowId: 'ord-3' },
    ) as CompiledFindManyQuery;
    expect(out.arg.take).toBe(-50);
    expect(out.arg.orderBy).toEqual([{ amount: 'asc' }, { id: 'asc' }]);
    expect(out.arg.skip).toBe(1);
  });

  it('builds select from the requested columns, always keeping the key', () => {
    const out = compilePrismaQuery(req({ columns: ['status', 'amount'] }), MODEL) as CompiledFindManyQuery;
    expect(out.arg.select).toEqual({ status: true, amount: true, id: true });
  });

  it('omits select entirely when the request names no columns', () => {
    expect(compileSelect(undefined, MODEL)).toBeUndefined();
    expect(compileSelect([], MODEL)).toBeUndefined();
  });

  it('rejects an unknown field id at the adapter boundary', () => {
    expect(() => compileSelect(['nope'], MODEL)).toThrow(/unknown field "nope" on model "order"/);
  });

  it('refuses to sort by a relation field', () => {
    expect(() => compileOrderBy([{ columnId: 'customer', direction: 'asc' }], MODEL)).toThrow(
      /cannot sort by relation field "customer"/,
    );
  });
});

describe('where operator matrix', () => {
  const w = (op: string, extra: Record<string, unknown> = {}) =>
    compileWhere({ type: 'comparison', columnId: 'status', op, ...extra } as never, MODEL);

  it('maps the scalar comparisons', () => {
    expect(w('eq', { value: 'a' })).toEqual({ status: { equals: 'a' } });
    expect(w('neq', { value: 'a' })).toEqual({ status: { not: 'a' } });
    expect(w('lt', { value: 1 })).toEqual({ status: { lt: 1 } });
    expect(w('lte', { value: 1 })).toEqual({ status: { lte: 1 } });
    expect(w('gt', { value: 1 })).toEqual({ status: { gt: 1 } });
    expect(w('gte', { value: 1 })).toEqual({ status: { gte: 1 } });
  });

  it('maps in / notIn to Prisma list filters', () => {
    expect(w('in', { values: ['a', 'b'] })).toEqual({ status: { in: ['a', 'b'] } });
    expect(w('notIn', { values: ['a'] })).toEqual({ status: { notIn: ['a'] } });
  });

  it('maps the string operators, including the negated one', () => {
    expect(w('contains', { value: 'ship' })).toEqual({ status: { contains: 'ship' } });
    expect(w('startsWith', { value: 'sh' })).toEqual({ status: { startsWith: 'sh' } });
    expect(w('endsWith', { value: 'ed' })).toEqual({ status: { endsWith: 'ed' } });
    expect(w('notContains', { value: 'ship' })).toEqual({
      status: { not: { contains: 'ship' } },
    });
  });

  it('adds mode:insensitive only when the request asks for it', () => {
    expect(w('contains', { value: 'x', caseSensitive: false })).toEqual({
      status: { contains: 'x', mode: 'insensitive' },
    });
    expect(w('contains', { value: 'x', caseSensitive: true })).toEqual({
      status: { contains: 'x' },
    });
  });

  it('maps null checks onto equals/not null', () => {
    expect(w('isNull')).toEqual({ status: { equals: null } });
    expect(w('isNotNull')).toEqual({ status: { not: null } });
  });

  it('expresses between as a closed range and notBetween as its negation', () => {
    expect(w('between', { values: [1, 9] })).toEqual({ status: { gte: 1, lte: 9 } });
    expect(w('notBetween', { values: [1, 9] })).toEqual({
      status: { NOT: { gte: 1, lte: 9 } },
    });
  });

  it('maps logical nodes onto AND / OR / NOT', () => {
    expect(
      compileWhere(
        {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'status', op: 'eq', value: 'a' },
            { type: 'comparison', columnId: 'amount', op: 'gt', value: 5 },
          ],
        },
        MODEL,
      ),
    ).toEqual({ AND: [{ status: { equals: 'a' } }, { amount: { gt: 5 } }] });

    expect(
      compileWhere(
        {
          type: 'logical',
          op: 'or',
          filters: [{ type: 'comparison', columnId: 'status', op: 'eq', value: 'a' }],
        },
        MODEL,
      ),
    ).toEqual({ OR: [{ status: { equals: 'a' } }] });

    expect(
      compileWhere(
        {
          type: 'logical',
          op: 'not',
          filters: [{ type: 'comparison', columnId: 'status', op: 'eq', value: 'a' }],
        },
        MODEL,
      ),
    ).toEqual({ NOT: { status: { equals: 'a' } } });
  });

  it('returns undefined for a null filter model so `where` is omitted', () => {
    expect(compileWhere(null, MODEL)).toBeUndefined();
  });

  it('attaches the compiled where to the findMany argument', () => {
    const out = compilePrismaQuery(
      req({ filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'active' } }),
      MODEL,
    ) as CompiledFindManyQuery;
    expect(out.arg.where).toEqual({ status: { equals: 'active' } });
  });
});

describe('groupBy pushdown', () => {
  const grouped = (override: Partial<BlockRequest> = {}) =>
    compilePrismaQuery(
      req({
        limit: 20,
        grouping: { columns: ['status'], openKeys: [] },
        aggregations: [
          { columnId: 'amount', fn: 'sum' },
          { columnId: 'amount', fn: 'avg', alias: 'mean' },
          { columnId: 'amount', fn: 'min' },
          { columnId: 'amount', fn: 'max' },
          { columnId: 'title', fn: 'count' },
          { columnId: '*', fn: 'count', alias: 'total' },
        ],
        ...override,
      }),
      MODEL,
    ) as CompiledGroupByQuery;

  it('emits by + aggregate buckets and always requests _count._all', () => {
    const out = grouped();
    expect(out.kind).toBe('groupBy');
    expect(out.arg.by).toEqual(['status']);
    expect(out.arg.take).toBe(20);
    expect(out.arg.orderBy).toEqual([{ status: 'asc' }]);
    expect(out.arg._sum).toEqual({ amount: true });
    expect(out.arg._avg).toEqual({ amount: true });
    expect(out.arg._min).toEqual({ amount: true });
    expect(out.arg._max).toEqual({ amount: true });
    expect(out.arg._count).toEqual({ _all: true, title: true });
  });

  it('records which bucket every output alias came from', () => {
    expect(grouped().metric).toEqual([
      { alias: 'sum_amount', bucket: '_sum', columnId: 'amount' },
      { alias: 'mean', bucket: '_avg', columnId: 'amount' },
      { alias: 'min_amount', bucket: '_min', columnId: 'amount' },
      { alias: 'max_amount', bucket: '_max', columnId: 'amount' },
      { alias: 'count_title', bucket: '_count', columnId: 'title' },
      { alias: 'total', bucket: '_count', columnId: '_all' },
    ]);
  });

  it('groups by several columns in nesting order', () => {
    const out = compilePrismaQuery(
      req({ grouping: { columns: ['status', 'customerId'], openKeys: [] } }),
      MODEL,
    ) as CompiledGroupByQuery;
    expect(out.arg.by).toEqual(['status', 'customerId']);
    expect(out.arg.orderBy).toEqual([{ status: 'asc' }, { customerId: 'asc' }]);
  });

  it('says out loud that countDistinct has no groupBy equivalent', () => {
    expect(() =>
      compilePrismaQuery(
        req({
          grouping: { columns: ['status'], openKeys: [] },
          aggregations: [{ columnId: 'amount', fn: 'countDistinct' }],
        }),
        MODEL,
      ),
    ).toThrow(/countDistinct.*no groupBy equivalent/s);
  });

  it('rejects an unsupported aggregation fn', () => {
    expect(() =>
      compilePrismaQuery(
        req({
          grouping: { columns: ['status'], openKeys: [] },
          aggregations: [{ columnId: 'amount', fn: 'stddev' }],
        }),
        MODEL,
      ),
    ).toThrow(/unsupported aggregation fn "stddev"/);
  });

  it('flattens Prisma nested aggregate rows into the one-row-per-group shape', () => {
    const compiled = grouped();
    const flat = parseGroupByResult(compiled, [
      {
        status: 'active',
        _count: { _all: 200_000, title: 199_000 },
        _sum: { amount: 9.99e9 },
        _avg: { amount: 49.5 },
        _min: { amount: 1 },
        _max: { amount: 99 },
      },
    ]);
    expect(flat).toEqual([
      {
        status: 'active',
        [GROUP_COUNT_KEY]: 200_000,
        sum_amount: 9.99e9,
        mean: 49.5,
        min_amount: 1,
        max_amount: 99,
        count_title: 199_000,
        total: 200_000,
      },
    ]);
  });

  it('fills a missing aggregate with null rather than undefined', () => {
    const compiled = grouped();
    const flat = parseGroupByResult(compiled, [{ status: 'empty', _count: { _all: 0 } }]);
    expect(flat[0]!.sum_amount).toBeNull();
    expect(flat[0]![GROUP_COUNT_KEY]).toBe(0);
  });

  it('defaults an alias to `${fn}_${columnId}`', () => {
    expect(aliasOf({ columnId: 'amount', fn: 'sum' })).toBe('sum_amount');
    expect(aliasOf({ columnId: 'amount', fn: 'sum', alias: 'x' })).toBe('x');
  });
});

describe('cursor codec', () => {
  it('round-trips through the shared ks: wire format', () => {
    const encoded = encodeKeysetCursor({ sortValues: [1, 'b'], rowId: 7 });
    expect(isKeysetCursor(encoded)).toBe(true);
    expect(decodeKeysetCursor(encoded)).toEqual({ sortValues: [1, 'b'], rowId: 7 });
  });

  it('throws on a malformed payload', () => {
    expect(() => decodeKeysetCursor('ks:' + Buffer.from('[]').toString('base64'))).toThrow(
      /malformed keyset cursor/,
    );
  });
});
