import { describe, expect, it } from 'vitest';
import {
  evaluateFormat,
  interpolateColor,
  prepareFormat,
  testOperator,
  type FormatRule,
} from '../conditional-format';

/** A tiny table: revenue 0,25,50,75,100 with one non-numeric hole. */
const value: Record<string, ReadonlyArray<unknown>> = {
  revenue: [0, 25, 50, 75, 100],
  status: ['active', 'pending', 'churned', 'active', ''],
  mixed: [10, 'n/a', 30, null, 50],
};

const read = (row: number, columnId: string): unknown => value[columnId]?.[row];
const range = { start: 0, end: 4 };

describe('testOperator', () => {
  it('compares numerically', () => {
    expect(testOperator('greaterThan', 10, 5)).toBe(true);
    expect(testOperator('lessThanOrEqual', 5, 5)).toBe(true);
    expect(testOperator('greaterThanOrEqual', 4, 5)).toBe(false);
  });

  it('treats between as inclusive and order-insensitive', () => {
    expect(testOperator('between', 5, 1, 10)).toBe(true);
    expect(testOperator('between', 5, 10, 1)).toBe(true);
    expect(testOperator('between', 1, 1, 10)).toBe(true);
    expect(testOperator('between', 11, 1, 10)).toBe(false);
  });

  it('compares text case-insensitively', () => {
    expect(testOperator('contains', 'Pending', 'pend')).toBe(true);
    expect(testOperator('startsWith', 'Pending', 'PEN')).toBe(true);
    expect(testOperator('endsWith', 'Pending', 'ing')).toBe(true);
    expect(testOperator('notContains', 'Pending', 'xyz')).toBe(true);
  });

  it('treats null, undefined and empty string as empty', () => {
    expect(testOperator('isEmpty', null)).toBe(true);
    expect(testOperator('isEmpty', undefined)).toBe(true);
    expect(testOperator('isEmpty', '')).toBe(true);
    expect(testOperator('isEmpty', 0)).toBe(false);
    expect(testOperator('isNotEmpty', 'x')).toBe(true);
  });

  it('equates a number and its string form', () => {
    expect(testOperator('equals', 5, '5')).toBe(true);
    expect(testOperator('notEquals', 5, '6')).toBe(true);
  });
});

describe('interpolateColor', () => {
  it('returns the endpoints exactly', () => {
    expect(interpolateColor(['#000000', '#ffffff'], 0)).toBe('#000000');
    expect(interpolateColor(['#000000', '#ffffff'], 1)).toBe('#ffffff');
  });

  it('interpolates the midpoint', () => {
    expect(interpolateColor(['#000000', '#ffffff'], 0.5)).toBe('#808080');
  });

  it('supports a three-stop diverging scale', () => {
    const stop = ['#ff0000', '#ffffff', '#0000ff'];
    expect(interpolateColor(stop, 0.5)).toBe('#ffffff');
    expect(interpolateColor(stop, 0)).toBe('#ff0000');
    expect(interpolateColor(stop, 1)).toBe('#0000ff');
  });

  it('clamps out-of-range and non-finite t', () => {
    expect(interpolateColor(['#000000', '#ffffff'], -5)).toBe('#000000');
    expect(interpolateColor(['#000000', '#ffffff'], 5)).toBe('#ffffff');
    expect(interpolateColor(['#000000', '#ffffff'], NaN)).toBe('#000000');
  });

  it('handles a single stop', () => {
    expect(interpolateColor(['#123456'], 0.7)).toBe('#123456');
  });
});

describe('prepareFormat', () => {
  it('computes min and max for scale-type rules only', () => {
    const rule: FormatRule[] = [
      { kind: 'colorScale', columnId: 'revenue', stop: ['#000000', '#ffffff'] },
      {
        kind: 'predicate',
        columnId: 'status',
        operator: 'equals',
        value: 'active',
        style: { bold: true },
      },
    ];

    const prepared = prepareFormat(rule, range, read);
    expect(prepared.stat.get('revenue')).toEqual({ min: 0, max: 100 });
    // A predicate rule needs no statistic, so none is computed.
    expect(prepared.stat.has('status')).toBe(false);
  });

  it('ignores non-numeric holes when computing the domain', () => {
    const rule: FormatRule[] = [
      { kind: 'dataBar', columnId: 'mixed', color: '#4488ff' },
    ];
    expect(prepareFormat(rule, range, read).stat.get('mixed')).toEqual({
      min: 10,
      max: 50,
    });
  });

  it('yields a defined degenerate domain for an all-text column', () => {
    const rule: FormatRule[] = [
      { kind: 'dataBar', columnId: 'status', color: '#4488ff' },
    ];
    expect(prepareFormat(rule, range, read).stat.get('status')).toEqual({
      min: 0,
      max: 0,
    });
  });
});

describe('evaluateFormat', () => {
  it('returns null when no rule matched, so the renderer takes its fast path', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'predicate',
          columnId: 'status',
          operator: 'equals',
          value: 'archived',
          style: { bold: true },
        },
      ],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 0, 'status', 'active')).toBeNull();
  });

  it('ignores rules bound to a different column', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 0,
          style: { bold: true },
        },
      ],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 0, 'status', 'active')).toBeNull();
  });

  it('merges later rules over earlier ones per property', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 0,
          style: { color: '#ff0000', bold: true },
        },
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 10,
          style: { color: '#00ff00' },
        },
      ],
      range,
      read,
    );

    // color overridden by the later rule; bold survives from the earlier one.
    expect(evaluateFormat(prepared, 1, 'revenue', 25)).toEqual({
      color: '#00ff00',
      bold: true,
    });
  });

  it('stops at a matching stopIfTrue rule', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 0,
          style: { color: '#ff0000' },
          stopIfTrue: true,
        },
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 10,
          style: { color: '#00ff00' },
        },
      ],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 1, 'revenue', 25)).toEqual({ color: '#ff0000' });
  });

  it('does not stop when the stopIfTrue rule did not match', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 1000,
          style: { color: '#ff0000' },
          stopIfTrue: true,
        },
        {
          kind: 'predicate',
          columnId: 'revenue',
          operator: 'greaterThan',
          value: 10,
          style: { color: '#00ff00' },
        },
      ],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 1, 'revenue', 25)).toEqual({ color: '#00ff00' });
  });

  it('maps a colour scale across the prepared domain', () => {
    const prepared = prepareFormat(
      [{ kind: 'colorScale', columnId: 'revenue', stop: ['#000000', '#ffffff'] }],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 0, 'revenue', 0)?.background).toBe('#000000');
    expect(evaluateFormat(prepared, 2, 'revenue', 50)?.background).toBe('#808080');
    expect(evaluateFormat(prepared, 4, 'revenue', 100)?.background).toBe('#ffffff');
  });

  it('honours an explicit domain over the prepared statistic', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'colorScale',
          columnId: 'revenue',
          stop: ['#000000', '#ffffff'],
          domain: [0, 200],
        },
      ],
      range,
      read,
    );
    // 50 of 200 is a quarter, not half.
    expect(evaluateFormat(prepared, 2, 'revenue', 50)?.background).toBe('#404040');
  });

  it('computes a data bar fraction', () => {
    const prepared = prepareFormat(
      [{ kind: 'dataBar', columnId: 'revenue', color: '#4488ff' }],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 1, 'revenue', 25)?.bar).toEqual({
      fraction: 0.25,
      color: '#4488ff',
    });
  });

  it('gives a full bar when every value is identical', () => {
    const flat = (): unknown => 7;
    const prepared = prepareFormat(
      [{ kind: 'dataBar', columnId: 'revenue', color: '#4488ff' }],
      range,
      flat,
    );
    expect(evaluateFormat(prepared, 0, 'revenue', 7)?.bar?.fraction).toBe(1);
  });

  it('buckets an icon set, putting the maximum in the last bucket', () => {
    const prepared = prepareFormat(
      [{ kind: 'iconSet', columnId: 'revenue', icon: ['low', 'mid', 'high'] }],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 0, 'revenue', 0)?.icon).toBe('low');
    expect(evaluateFormat(prepared, 2, 'revenue', 50)?.icon).toBe('mid');
    // The classic off-by-one: t === 1 must not index past the array.
    expect(evaluateFormat(prepared, 4, 'revenue', 100)?.icon).toBe('high');
  });

  it('skips scale rules for a non-numeric value', () => {
    const prepared = prepareFormat(
      [{ kind: 'colorScale', columnId: 'mixed', stop: ['#000000', '#ffffff'] }],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 1, 'mixed', 'n/a')).toBeNull();
  });

  it('runs an adopter-supplied formula rule', () => {
    const prepared = prepareFormat(
      [
        {
          kind: 'formula',
          columnId: 'revenue',
          test: (v, row) => row % 2 === 0 && Number(v) > 10,
          style: { italic: true },
        },
      ],
      range,
      read,
    );
    expect(evaluateFormat(prepared, 2, 'revenue', 50)).toEqual({ italic: true });
    expect(evaluateFormat(prepared, 1, 'revenue', 25)).toBeNull();
  });
});
