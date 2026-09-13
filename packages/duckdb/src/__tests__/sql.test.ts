import { describe, expect, it } from 'vitest';
import {
  buildBlockSql,
  buildCountSql,
  buildSchemaSql,
  encodeOffsetCursor,
  parseOffsetCursor,
} from '../sql';
import type { BlockRequest } from '@onegrid/protocol';

const baseReq = (overrides: Partial<BlockRequest> = {}): BlockRequest => ({
  cursor: null,
  direction: 'after',
  limit: 100,
  sort: [],
  filter: null,
  ...overrides,
});

describe('cursor encoding', () => {
  it('round-trips offset cursors', () => {
    expect(parseOffsetCursor(encodeOffsetCursor(500))).toBe(500);
  });
  it('treats null as offset 0', () => {
    expect(parseOffsetCursor(null)).toBe(0);
  });
  it('rejects non-numeric cursors', () => {
    expect(parseOffsetCursor('keyset:foo')).toBe(0);
  });
});

describe('buildSchemaSql', () => {
  it('produces a DESCRIBE wrapper', () => {
    expect(buildSchemaSql('events')).toBe('DESCRIBE SELECT * FROM events LIMIT 0');
  });
});

describe('buildBlockSql', () => {
  it('plain block with no sort/filter and offset 0', () => {
    const out = buildBlockSql({
      source: '(SELECT * FROM events)',
      request: baseReq(),
      defaultLimit: 100,
    });
    expect(out.sql).toBe('SELECT * FROM (SELECT * FROM events) LIMIT 101 OFFSET 0');
    expect(out.params).toEqual([]);
  });

  it('honors offset cursor', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({ cursor: 'offset:200' }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('LIMIT 101 OFFSET 200');
  });

  it('translates ORDER BY with NULLS LAST default', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({ sort: [{ columnId: 'name', direction: 'asc' }] }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('ORDER BY "name" ASC NULLS LAST');
  });

  it('flips direction for "before" pagination', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        direction: 'before',
        sort: [{ columnId: 'name', direction: 'asc' }],
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('ORDER BY "name" DESC NULLS LAST');
  });

  it('appends idColumn as a stable tiebreaker', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({ sort: [{ columnId: 'name', direction: 'asc' }] }),
      defaultLimit: 100,
      idColumn: 'id',
    });
    expect(out.sql).toContain('ORDER BY "name" ASC NULLS LAST, "id" ASC');
  });

  it('quotes identifiers with embedded quotes', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({ filter: { type: 'comparison', columnId: 'col"name', op: 'eq', value: 1 } }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('"col""name" = ?');
  });

  it('translates a comparison filter with ? params', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'age', op: 'gt', value: 30 },
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('WHERE "age" > ?');
    expect(out.params).toEqual([30]);
  });

  it('translates IN with parameter expansion', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'status', op: 'in', values: ['a', 'b', 'c'] },
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('"status" IN (?, ?, ?)');
    expect(out.params).toEqual(['a', 'b', 'c']);
  });

  it('translates IN with empty list to a tautologically-false condition', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'status', op: 'in', values: [] },
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('1=0');
  });

  it('translates BETWEEN', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'age', op: 'between', values: [18, 65] },
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('"age" BETWEEN ? AND ?');
    expect(out.params).toEqual([18, 65]);
  });

  it('uses ILIKE for case-insensitive contains; LIKE when caseSensitive', () => {
    const insens = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'name', op: 'contains', value: 'a' },
      }),
      defaultLimit: 100,
    });
    expect(insens.sql).toContain('CAST("name" AS VARCHAR) ILIKE ?');
    expect(insens.params[0]).toBe('%a%');

    const sens = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: {
          type: 'comparison',
          columnId: 'name',
          op: 'contains',
          value: 'a',
          caseSensitive: true,
        },
      }),
      defaultLimit: 100,
    });
    expect(sens.sql).toContain('CAST("name" AS VARCHAR) LIKE ?');
  });

  // Both found by running the builder's SQL against a real DuckDB (1.5.5):
  // DuckDB LIKE has NO default escape character, so `a\_b` matched only a
  // literal backslash and every search containing `_` / `%` / `\` silently
  // matched nothing; and ILIKE on a BIGINT / DOUBLE / TIMESTAMP column is a
  // binder error, so a quick filter spanning every column failed outright.
  it('string operators cast the column to VARCHAR and declare the escape character', () => {
    const cases = [
      ['contains', false, `CAST("amount" AS VARCHAR) ILIKE ? ESCAPE '\\'`],
      ['contains', true, `CAST("amount" AS VARCHAR) LIKE ? ESCAPE '\\'`],
      ['notContains', false, `CAST("amount" AS VARCHAR) NOT ILIKE ? ESCAPE '\\'`],
      ['startsWith', false, `CAST("amount" AS VARCHAR) ILIKE ? ESCAPE '\\'`],
      ['endsWith', true, `CAST("amount" AS VARCHAR) LIKE ? ESCAPE '\\'`],
    ] as const;
    for (const [op, caseSensitive, want] of cases) {
      const out = buildBlockSql({
        source: 't',
        request: baseReq({
          filter: { type: 'comparison', columnId: 'amount', op, value: '1_5', caseSensitive },
        }),
        defaultLimit: 100,
      });
      expect(out.sql).toContain(want);
      // The escape character is fixed SQL; the value only ever travels as a parameter.
      expect(out.params[0]).toContain('1\\_5');
    }
  });

  it('escapes LIKE special characters', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'pattern', op: 'contains', value: '50%_off' },
      }),
      defaultLimit: 100,
    });
    expect(out.params[0]).toBe('%50\\%\\_off%');
  });

  it('translates AND / OR / NOT recursively', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'age', op: 'gt', value: 30 },
            {
              type: 'logical',
              op: 'or',
              filters: [
                { type: 'comparison', columnId: 'name', op: 'startsWith', value: 'A' },
                { type: 'comparison', columnId: 'name', op: 'startsWith', value: 'B' },
              ],
            },
          ],
        },
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('"age" > ?');
    expect(out.sql).toContain('CAST("name" AS VARCHAR) ILIKE ?');
    // Outer AND, inner OR — asserted structurally: the string operators now
    // wrap the column in CAST(...), so a regex that forbids `)` inside the OR
    // group no longer describes the nesting.
    expect(out.sql).toContain(
      `WHERE ("age" > ? AND (CAST("name" AS VARCHAR) ILIKE ? ESCAPE '\\' OR CAST("name" AS VARCHAR) ILIKE ? ESCAPE '\\'))`,
    );
    expect(out.params).toEqual([30, 'A%', 'B%']);
  });

  it('isNull / isNotNull take no parameters', () => {
    const out = buildBlockSql({
      source: 't',
      request: baseReq({
        filter: { type: 'comparison', columnId: 'tag', op: 'isNull' },
      }),
      defaultLimit: 100,
    });
    expect(out.sql).toContain('"tag" IS NULL');
    expect(out.params).toEqual([]);
  });
});

describe('buildCountSql', () => {
  it('matches WHERE of buildBlockSql', () => {
    const filter = {
      type: 'comparison',
      columnId: 'age',
      op: 'gt',
      value: 30,
    } as const;
    const block = buildBlockSql({
      source: 't',
      request: baseReq({ filter }),
      defaultLimit: 100,
    });
    const count = buildCountSql({ source: 't', request: baseReq({ filter }) });
    expect(count.sql).toBe('SELECT COUNT(*) AS c FROM t WHERE "age" > ?');
    expect(count.params).toEqual(block.params);
  });

  it('omits WHERE when no filter', () => {
    const out = buildCountSql({ source: 't', request: baseReq() });
    expect(out.sql).toBe('SELECT COUNT(*) AS c FROM t');
  });
});
