// =============================================================================
// Elasticsearch query compiler — unit tests.
//
// These assert on the literal JSON body that would go over the wire to
// `_search`. That is the right level: the compiler's whole job is producing a
// document ES accepts, and a test that stubs the shape one layer higher would
// not catch a `must` that should have been a `filter`.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { BlockRequest } from '@onegrid/protocol';
import {
  aliasOf,
  compileBlockQuery,
  compileFilter,
  decodeAfterKey,
  decodeKeysetCursor,
  encodeAfterKey,
  encodeKeysetCursor,
  isKeysetCursor,
  parseAggregationResponse,
  GROUP_AGG_NAME,
  GROUP_COUNT_KEY,
  type CompiledAggregationQuery,
  type CompiledSearchQuery,
  type ElasticsearchBlockRequest,
  type ElasticsearchIndexDescriptor,
  type ElasticsearchTextFilter,
} from '../query';

const INDEX: ElasticsearchIndexDescriptor = {
  index: 'order',
  field: ['order_id', 'status', 'amount', 'customer', 'note', '@timestamp'],
  primaryKey: 'order_id',
  keywordSubfield: ['customer'],
};

function req(override: Partial<ElasticsearchBlockRequest> = {}): ElasticsearchBlockRequest {
  return {
    cursor: null,
    direction: 'after',
    limit: 100,
    sort: [],
    filter: null,
    ...override,
  };
}

describe('compileBlockQuery — flat search path', () => {
  it('emits size + sort + tiebreaker and never emits `from`', () => {
    const out = compileBlockQuery(req(), INDEX) as CompiledSearchQuery;
    expect(out.kind).toBe('search');
    expect(out.index).toBe('order');
    expect(out.body.size).toBe(100);
    expect(out.body.sort).toEqual([{ order_id: { order: 'asc' } }]);
    expect(out.body).not.toHaveProperty('from');
    expect(JSON.stringify(out.body)).not.toContain('"from"');
  });

  it('appends the primary key after the requested sort fields', () => {
    const out = compileBlockQuery(
      req({ sort: [{ columnId: 'amount', direction: 'desc' }] }),
      INDEX,
    ) as CompiledSearchQuery;
    expect(out.body.sort).toEqual([
      { amount: { order: 'desc' } },
      { order_id: { order: 'asc' } },
    ]);
  });

  it('maps SortField.nulls onto the ES `missing` sentinel', () => {
    const out = compileBlockQuery(
      req({ sort: [{ columnId: 'amount', direction: 'desc', nulls: 'first' }] }),
      INDEX,
    ) as CompiledSearchQuery;
    expect(out.body.sort[0]).toEqual({ amount: { order: 'desc', missing: '_first' } });
  });

  it('inverts every sort direction when paging backwards', () => {
    const out = compileBlockQuery(
      req({
        direction: 'before',
        sort: [
          { columnId: 'amount', direction: 'desc' },
          { columnId: 'status', direction: 'asc' },
        ],
      }),
      INDEX,
    ) as CompiledSearchQuery;
    expect(out.body.sort).toEqual([
      { amount: { order: 'asc' } },
      { status: { order: 'desc' } },
      { order_id: { order: 'desc' } },
    ]);
  });

  it('emits search_after from a keyset cursor, sort values then row id', () => {
    const out = compileBlockQuery(
      req({ sort: [{ columnId: 'amount', direction: 'asc' }] }),
      INDEX,
      { cursor: { sortValues: [42.5], rowId: 'ord-7' } },
    ) as CompiledSearchQuery;
    expect(out.body.search_after).toEqual([42.5, 'ord-7']);
  });

  it('switches the tiebreaker to _shard_doc and drops the index under a PIT', () => {
    const out = compileBlockQuery(req(), INDEX, {
      pointInTime: { id: 'pit-abc', keepAlive: '1m' },
    }) as CompiledSearchQuery;
    expect(out.index).toBeNull();
    expect(out.body.sort).toEqual(['_shard_doc']);
    expect(out.body.pit).toEqual({ id: 'pit-abc', keep_alive: '1m' });
  });

  it('projects _source from requested columns and always keeps the primary key', () => {
    const out = compileBlockQuery(req({ columns: ['status', 'amount'] }), INDEX) as CompiledSearchQuery;
    expect(out.body._source).toEqual(['status', 'amount', 'order_id']);
  });

  it('rejects a field that is not in the index descriptor', () => {
    expect(() =>
      compileBlockQuery(req({ sort: [{ columnId: 'secret', direction: 'asc' }] }), INDEX),
    ).toThrow(/unknown field "secret"/);
  });
});

describe('filter operator matrix', () => {
  const cmp = (op: string, extra: Record<string, unknown> = {}) =>
    compileFilter(
      { type: 'comparison', columnId: 'status', op, ...extra } as never,
      INDEX,
    ).bool;

  it('eq becomes a scoring-free term in bool.filter', () => {
    expect(cmp('eq', { value: 'active' })).toEqual({
      filter: [{ term: { status: { value: 'active' } } }],
    });
  });

  it('neq becomes must_not term', () => {
    expect(cmp('neq', { value: 'active' })).toEqual({
      must_not: [{ term: { status: { value: 'active' } } }],
    });
  });

  it('the four range operators become range clauses', () => {
    expect(cmp('lt', { value: 1 })).toEqual({ filter: [{ range: { status: { lt: 1 } } }] });
    expect(cmp('lte', { value: 1 })).toEqual({ filter: [{ range: { status: { lte: 1 } } }] });
    expect(cmp('gt', { value: 1 })).toEqual({ filter: [{ range: { status: { gt: 1 } } }] });
    expect(cmp('gte', { value: 1 })).toEqual({ filter: [{ range: { status: { gte: 1 } } }] });
  });

  it('in / notIn become terms and must_not terms', () => {
    expect(cmp('in', { values: ['a', 'b'] })).toEqual({ filter: [{ terms: { status: ['a', 'b'] } }] });
    expect(cmp('notIn', { values: ['a'] })).toEqual({ must_not: [{ terms: { status: ['a'] } }] });
  });

  it('isNull / isNotNull become exists clauses, since ES has no null', () => {
    expect(cmp('isNull')).toEqual({ must_not: [{ exists: { field: 'status' } }] });
    expect(cmp('isNotNull')).toEqual({ filter: [{ exists: { field: 'status' } }] });
  });

  it('contains / startsWith / endsWith become wildcard and prefix', () => {
    expect(cmp('contains', { value: 'ship' })).toEqual({
      filter: [{ wildcard: { status: { value: '*ship*' } } }],
    });
    expect(cmp('startsWith', { value: 'ship' })).toEqual({
      filter: [{ prefix: { status: { value: 'ship' } } }],
    });
    expect(cmp('endsWith', { value: 'ped' })).toEqual({
      filter: [{ wildcard: { status: { value: '*ped' } } }],
    });
    expect(cmp('notContains', { value: 'ship' })).toEqual({
      must_not: [{ wildcard: { status: { value: '*ship*' } } }],
    });
  });

  it('escapes wildcard metacharacters in user input', () => {
    expect(cmp('contains', { value: 'a*b?c' })).toEqual({
      filter: [{ wildcard: { status: { value: '*a\\*b\\?c*' } } }],
    });
  });

  it('caseSensitive:false sets ES case_insensitive on term-level queries', () => {
    expect(cmp('eq', { value: 'Active', caseSensitive: false })).toEqual({
      filter: [{ term: { status: { value: 'Active', case_insensitive: true } } }],
    });
  });

  it('between / notBetween collapse into one range clause', () => {
    expect(cmp('between', { values: [1, 9] })).toEqual({
      filter: [{ range: { status: { gte: 1, lte: 9 } } }],
    });
    expect(cmp('notBetween', { values: [1, 9] })).toEqual({
      must_not: [{ range: { status: { gte: 1, lte: 9 } } }],
    });
  });

  it('routes exact operators to the .keyword sub-field when declared', () => {
    const out = compileFilter(
      { type: 'comparison', columnId: 'customer', op: 'eq', value: 'ACME' },
      INDEX,
    );
    expect(out.bool).toEqual({ filter: [{ term: { 'customer.keyword': { value: 'ACME' } } }] });
  });

  it('and nests into bool.filter, or into bool.should with minimum_should_match', () => {
    const and = compileFilter(
      {
        type: 'logical',
        op: 'and',
        filters: [
          { type: 'comparison', columnId: 'status', op: 'eq', value: 'a' },
          { type: 'comparison', columnId: 'amount', op: 'gt', value: 5 },
        ],
      },
      INDEX,
    );
    expect(and.bool.filter).toHaveLength(2);
    expect(and.bool.filter?.[0]).toEqual({ bool: { filter: [{ term: { status: { value: 'a' } } }] } });

    const or = compileFilter(
      {
        type: 'logical',
        op: 'or',
        filters: [{ type: 'comparison', columnId: 'status', op: 'eq', value: 'a' }],
      },
      INDEX,
    );
    expect(or.bool.minimum_should_match).toBe(1);
    expect(or.bool.should).toHaveLength(1);
  });

  it('not wraps the child in must_not', () => {
    const out = compileFilter(
      {
        type: 'logical',
        op: 'not',
        filters: [{ type: 'comparison', columnId: 'status', op: 'eq', value: 'a' }],
      },
      INDEX,
    );
    expect(out.bool).toEqual({
      must_not: [{ bool: { filter: [{ term: { status: { value: 'a' } } }] } }],
    });
  });
});

describe('full-text operators', () => {
  it('match lands in bool.filter unscored by default', () => {
    const node: ElasticsearchTextFilter = {
      type: 'text',
      columnId: 'note',
      op: 'match',
      query: 'late delivery',
      operator: 'and',
      fuzziness: 'AUTO',
    };
    expect(compileFilter(node, INDEX).bool).toEqual({
      filter: [{ match: { note: { query: 'late delivery', operator: 'and', fuzziness: 'AUTO' } } }],
    });
  });

  it('scored:true moves the clause into bool.must so it contributes to _score', () => {
    const node: ElasticsearchTextFilter = {
      type: 'text',
      columnId: 'note',
      op: 'matchPhrase',
      query: 'lost parcel',
      scored: true,
    };
    expect(compileFilter(node, INDEX).bool).toEqual({
      must: [{ match_phrase: { note: { query: 'lost parcel' } } }],
    });
  });

  it('multiMatch fans out across every named field', () => {
    const node: ElasticsearchTextFilter = {
      type: 'text',
      columnId: ['note', 'customer'],
      op: 'multiMatch',
      query: 'acme',
      multiMatchType: 'cross_fields',
    };
    expect(compileFilter(node, INDEX).bool).toEqual({
      filter: [
        { multi_match: { query: 'acme', fields: ['note', 'customer'], type: 'cross_fields' } },
      ],
    });
  });

  it('queryString is lenient so a malformed grid filter cannot 400 the request', () => {
    const node: ElasticsearchTextFilter = {
      type: 'text',
      columnId: ['note'],
      op: 'queryString',
      query: 'late AND (delivery OR',
      operator: 'and',
    };
    expect(compileFilter(node, INDEX).bool).toEqual({
      filter: [
        {
          query_string: {
            query: 'late AND (delivery OR',
            fields: ['note'],
            lenient: true,
            default_operator: 'AND',
          },
        },
      ],
    });
  });

  it('validates full-text field ids against the descriptor too', () => {
    const node: ElasticsearchTextFilter = {
      type: 'text',
      columnId: ['note', 'nope'],
      op: 'multiMatch',
      query: 'x',
    };
    expect(() => compileFilter(node, INDEX)).toThrow(/unknown field "nope"/);
  });
});

describe('aggregation pushdown', () => {
  const grouped = (override: Partial<ElasticsearchBlockRequest> = {}) =>
    compileBlockQuery(
      req({
        limit: 25,
        grouping: { columns: ['status'], openKeys: [] },
        aggregations: [
          { columnId: 'amount', fn: 'sum' },
          { columnId: 'amount', fn: 'avg', alias: 'mean_amount' },
          { columnId: 'customer', fn: 'countDistinct' },
          { columnId: '*', fn: 'count', alias: 'total' },
        ],
        ...override,
      }),
      INDEX,
    ) as CompiledAggregationQuery;

  it('emits a composite aggregation with size 0 hits', () => {
    const out = grouped();
    expect(out.kind).toBe('aggregation');
    expect(out.body.size).toBe(0);
    const inner = out.body.aggs[GROUP_AGG_NAME] as Record<string, never>;
    expect(inner.composite).toEqual({
      size: 25,
      sources: [{ status: { terms: { field: 'status', order: 'asc' } } }],
    });
  });

  it('maps every aggregation fn onto its ES metric agg', () => {
    const inner = grouped().body.aggs[GROUP_AGG_NAME] as { aggs: Record<string, unknown> };
    expect(inner.aggs).toEqual({
      sum_amount: { sum: { field: 'amount' } },
      mean_amount: { avg: { field: 'amount' } },
      countDistinct_customer: { cardinality: { field: 'customer' } },
    });
  });

  it('serves count(*) from the bucket doc_count rather than a wasted sub-agg', () => {
    const out = grouped();
    expect(out.docCountAlias).toEqual(['total']);
    expect(out.alias).toContain('total');
  });

  it('carries the composite after key through as the resume point', () => {
    const out = compileBlockQuery(
      req({ limit: 10, grouping: { columns: ['status', 'customer'], openKeys: [] } }),
      INDEX,
      { afterKey: { status: 'active', customer: 'acme' } },
    ) as CompiledAggregationQuery;
    const inner = out.body.aggs[GROUP_AGG_NAME] as { composite: { after?: unknown; sources: unknown[] } };
    expect(inner.composite.after).toEqual({ status: 'active', customer: 'acme' });
    expect(inner.composite.sources).toHaveLength(2);
  });

  it('supports the terms strategy for a single group column', () => {
    const out = compileBlockQuery(
      req({ limit: 10, grouping: { columns: ['customer'], openKeys: [] } }),
      INDEX,
      { aggregationStrategy: 'terms', termsSize: 50 },
    ) as CompiledAggregationQuery;
    expect(out.strategy).toBe('terms');
    expect(out.body.aggs[GROUP_AGG_NAME]).toEqual({
      terms: { field: 'customer.keyword', size: 50, order: { _key: 'asc' } },
    });
  });

  it('refuses the terms strategy for multi-column grouping', () => {
    expect(() =>
      compileBlockQuery(
        req({ grouping: { columns: ['status', 'customer'], openKeys: [] } }),
        INDEX,
        { aggregationStrategy: 'terms' },
      ),
    ).toThrow(/exactly one group column/);
  });

  it('rejects an unsupported aggregation fn instead of silently dropping it', () => {
    expect(() =>
      compileBlockQuery(
        req({
          grouping: { columns: ['status'], openKeys: [] },
          aggregations: [{ columnId: 'amount', fn: 'median' }],
        }),
        INDEX,
      ),
    ).toThrow(/unsupported aggregation fn "median"/);
  });

  it('defaults an alias to `${fn}_${columnId}` per the protocol contract', () => {
    expect(aliasOf({ columnId: 'amount', fn: 'sum' })).toBe('sum_amount');
    expect(aliasOf({ columnId: 'amount', fn: 'sum', alias: 'x' })).toBe('x');
  });
});

describe('parseAggregationResponse', () => {
  it('flattens composite buckets into one row per group', () => {
    const compiled = compileBlockQuery(
      req({
        limit: 5,
        grouping: { columns: ['status'], openKeys: [] },
        aggregations: [
          { columnId: 'amount', fn: 'sum' },
          { columnId: '*', fn: 'count', alias: 'total' },
        ],
      }),
      INDEX,
    ) as CompiledAggregationQuery;

    const parsed = parseAggregationResponse(compiled, {
      aggregations: {
        [GROUP_AGG_NAME]: {
          after_key: { status: 'shipped' },
          buckets: [
            { key: { status: 'active' }, doc_count: 200_000, sum_amount: { value: 9.99e9 } },
            { key: { status: 'shipped' }, doc_count: 12, sum_amount: { value: 3 } },
          ],
        },
      },
    });

    expect(parsed.row).toEqual([
      { status: 'active', [GROUP_COUNT_KEY]: 200_000, sum_amount: 9.99e9, total: 200_000 },
      { status: 'shipped', [GROUP_COUNT_KEY]: 12, sum_amount: 3, total: 12 },
    ]);
    expect(parsed.afterKey).toEqual({ status: 'shipped' });
  });

  it('flattens bare terms bucket keys onto the single group column', () => {
    const compiled = compileBlockQuery(
      req({ limit: 5, grouping: { columns: ['customer'], openKeys: [] } }),
      INDEX,
      { aggregationStrategy: 'terms' },
    ) as CompiledAggregationQuery;
    const parsed = parseAggregationResponse(compiled, {
      aggregations: { [GROUP_AGG_NAME]: { buckets: [{ key: 'acme', doc_count: 4 }] } },
    });
    expect(parsed.row).toEqual([{ customer: 'acme', [GROUP_COUNT_KEY]: 4 }]);
    expect(parsed.afterKey).toBeNull();
  });

  it('returns no rows when the response carries no aggregations', () => {
    const compiled = compileBlockQuery(
      req({ grouping: { columns: ['status'], openKeys: [] } }),
      INDEX,
    ) as CompiledAggregationQuery;
    expect(parseAggregationResponse(compiled, {})).toEqual({ row: [], afterKey: null });
  });
});

describe('cursor codecs', () => {
  it('round-trips a keyset cursor through the ks: wire format', () => {
    const encoded = encodeKeysetCursor({ sortValues: [1, 'b'], rowId: 'ord-9' });
    expect(isKeysetCursor(encoded)).toBe(true);
    expect(decodeKeysetCursor(encoded)).toEqual({ sortValues: [1, 'b'], rowId: 'ord-9' });
  });

  it('round-trips a composite after key and rejects a foreign prefix', () => {
    const encoded = encodeAfterKey({ status: 'active' });
    expect(decodeAfterKey(encoded)).toEqual({ status: 'active' });
    expect(decodeAfterKey(encodeKeysetCursor({ sortValues: [], rowId: 1 }))).toBeNull();
  });

  it('throws on a malformed keyset payload rather than returning garbage', () => {
    expect(() => decodeKeysetCursor('ks:' + Buffer.from('{"nope":1}').toString('base64'))).toThrow(
      /malformed keyset cursor/,
    );
  });
});

describe('BlockRequest compatibility', () => {
  it('accepts a plain protocol BlockRequest without a cast', () => {
    const plain: BlockRequest = {
      cursor: null,
      direction: 'after',
      limit: 10,
      sort: [{ columnId: 'amount', direction: 'asc' }],
      filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'active' },
    };
    const out = compileBlockQuery(plain, INDEX) as CompiledSearchQuery;
    expect(out.body.query.bool.filter).toEqual([{ term: { status: { value: 'active' } } }]);
  });
});
