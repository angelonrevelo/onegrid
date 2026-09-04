// =============================================================================
// Canonical keyset cursor codec — unit tests.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { KeysetCursor, SortModel } from '@onegrid/protocol';
import {
  compareKeysetCursors,
  cursorFromRow,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isLegacyOffsetCursor,
  parseLegacyOffsetCursor,
} from '../cursor';

describe('encodeKeysetCursor / decodeKeysetCursor', () => {
  it('round-trips a basic cursor', () => {
    const cursor: KeysetCursor = {
      sortValues: ['active', 42],
      rowId: 'r-123',
    };
    const encoded = encodeKeysetCursor(cursor);
    expect(encoded.startsWith('ks:')).toBe(true);
    const decoded = decodeKeysetCursor(encoded);
    expect(decoded.sortValues).toEqual(cursor.sortValues);
    expect(decoded.rowId).toBe(cursor.rowId);
  });

  it('canonicalizes -0 sort values because JSON cannot round-trip them', () => {
    const decoded = decodeKeysetCursor(
      encodeKeysetCursor({ sortValues: [-0], rowId: 'x' }),
    );
    expect(Object.is(decoded.sortValues[0], 0)).toBe(true);
    expect(Object.is(decoded.sortValues[0], -0)).toBe(false);
  });

  it('round-trips numeric rowId', () => {
    const cursor: KeysetCursor = {
      sortValues: [123.45, 'x'],
      rowId: 99999,
    };
    const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor));
    expect(decoded.rowId).toBe(99999);
  });

  it('round-trips null sort values (e.g. nullable columns)', () => {
    const cursor: KeysetCursor = {
      sortValues: [null, 'tail'],
      rowId: 1,
    };
    const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor));
    expect(decoded.sortValues[0]).toBeNull();
    expect(decoded.sortValues[1]).toBe('tail');
  });

  it('decodes long-form payloads from pre-canonical adapters (no prefix, sortValues/rowId)', () => {
    // What drizzle/kysely emitted before v0.0.8 — base64 of long-form JSON.
    const longForm = JSON.stringify({
      sortValues: ['x', 1],
      rowId: 'legacy-id',
    });
    const b64 =
      typeof globalThis.btoa === 'function'
        ? globalThis.btoa(longForm)
        : Buffer.from(longForm, 'utf-8').toString('base64');
    const decoded = decodeKeysetCursor(b64);
    expect(decoded.sortValues).toEqual(['x', 1]);
    expect(decoded.rowId).toBe('legacy-id');
  });

  it('throws on empty cursor', () => {
    expect(() => decodeKeysetCursor('')).toThrow(/empty/);
  });

  it('throws on legacy offset cursor with a directing message', () => {
    expect(() => decodeKeysetCursor('offset:42')).toThrow(/parseLegacyOffsetCursor/);
  });

  it('throws on malformed base64', () => {
    expect(() => decodeKeysetCursor('ks:!!!not-base64!!!')).toThrow();
  });

  it('throws on payload missing sortValues', () => {
    const broken = encodeKeysetCursor({ sortValues: ['ok'], rowId: 'x' });
    // Tamper: replace base64 content with one whose JSON has no sortValues.
    const json = JSON.stringify({ r: 'x' });
    const b64 =
      typeof globalThis.btoa === 'function'
        ? globalThis.btoa(json)
        : Buffer.from(json, 'utf-8').toString('base64');
    expect(() => decodeKeysetCursor('ks:' + b64)).toThrow(/malformed/);
    // Sanity: the well-formed one we built first does NOT throw.
    expect(() => decodeKeysetCursor(broken)).not.toThrow();
  });

  it('throws on rowId of unsupported type', () => {
    const json = JSON.stringify({ s: ['x'], r: { not: 'allowed' } });
    const b64 =
      typeof globalThis.btoa === 'function'
        ? globalThis.btoa(json)
        : Buffer.from(json, 'utf-8').toString('base64');
    expect(() => decodeKeysetCursor('ks:' + b64)).toThrow(/string or number/);
  });
});

describe('isLegacyOffsetCursor / parseLegacyOffsetCursor', () => {
  it('identifies legacy offset cursors', () => {
    expect(isLegacyOffsetCursor('offset:0')).toBe(true);
    expect(isLegacyOffsetCursor('offset:9999')).toBe(true);
    expect(isLegacyOffsetCursor('ks:abcd')).toBe(false);
    expect(isLegacyOffsetCursor('arbitrary-string')).toBe(false);
  });

  it('parses legacy offset cursors to row indices', () => {
    expect(parseLegacyOffsetCursor('offset:0')).toBe(0);
    expect(parseLegacyOffsetCursor('offset:200')).toBe(200);
    expect(parseLegacyOffsetCursor('offset:1000000')).toBe(1_000_000);
  });

  it('floors fractional offsets', () => {
    expect(parseLegacyOffsetCursor('offset:42.7')).toBe(42);
  });

  it('rejects non-legacy prefixes', () => {
    expect(() => parseLegacyOffsetCursor('ks:abcd')).toThrow();
    expect(() => parseLegacyOffsetCursor('foo')).toThrow();
  });

  it('rejects negative offsets', () => {
    expect(() => parseLegacyOffsetCursor('offset:-5')).toThrow();
  });
});

describe('cursorFromRow', () => {
  it('builds a cursor whose shape mirrors the SortModel', () => {
    const sort: SortModel = [
      { columnId: 'status', direction: 'asc' },
      { columnId: 'revenue', direction: 'desc' },
    ];
    const row = { status: 'active', revenue: 999, id: 7 };
    const cursor = cursorFromRow(row, sort, 'id');
    expect(cursor.sortValues).toEqual(['active', 999]);
    expect(cursor.rowId).toBe(7);
  });

  it('substitutes null for missing sort values (e.g. NULL DB column)', () => {
    const sort: SortModel = [{ columnId: 'maybe', direction: 'asc' }];
    const row: Record<string, unknown> = { id: 'x' };
    const cursor = cursorFromRow(row, sort, 'id');
    expect(cursor.sortValues).toEqual([null]);
  });

  it('throws when the row id column produces an unsupported type', () => {
    const sort: SortModel = [{ columnId: 'a', direction: 'asc' }];
    expect(() => cursorFromRow({ a: 'x', id: { obj: true } }, sort, 'id')).toThrow(
      /row id column "id" must produce/,
    );
  });
});

describe('compareKeysetCursors', () => {
  const sort: SortModel = [{ columnId: 'name', direction: 'asc' }];
  const a: KeysetCursor = { sortValues: ['alpha'], rowId: 1 };
  const b: KeysetCursor = { sortValues: ['beta'], rowId: 1 };

  it('returns negative when a precedes b', () => {
    expect(compareKeysetCursors(a, b, sort)).toBeLessThan(0);
  });

  it('returns positive when a follows b', () => {
    expect(compareKeysetCursors(b, a, sort)).toBeGreaterThan(0);
  });

  it('returns zero on identical cursors', () => {
    expect(compareKeysetCursors(a, a, sort)).toBe(0);
  });

  it('honors descending direction', () => {
    const desc: SortModel = [{ columnId: 'name', direction: 'desc' }];
    expect(compareKeysetCursors(a, b, desc)).toBeGreaterThan(0);
  });

  it('falls through to rowId tiebreaker on equal sort values', () => {
    const x: KeysetCursor = { sortValues: ['same'], rowId: 1 };
    const y: KeysetCursor = { sortValues: ['same'], rowId: 2 };
    expect(compareKeysetCursors(x, y, sort)).toBeLessThan(0);
  });

  it('places nulls last by default', () => {
    const nullCursor: KeysetCursor = { sortValues: [null], rowId: 1 };
    const valueCursor: KeysetCursor = { sortValues: ['anything'], rowId: 2 };
    expect(compareKeysetCursors(nullCursor, valueCursor, sort)).toBeGreaterThan(0);
  });

  it('respects nulls=first when configured', () => {
    const nullsFirst: SortModel = [
      { columnId: 'name', direction: 'asc', nulls: 'first' },
    ];
    const nullCursor: KeysetCursor = { sortValues: [null], rowId: 1 };
    const valueCursor: KeysetCursor = { sortValues: ['x'], rowId: 2 };
    expect(compareKeysetCursors(nullCursor, valueCursor, nullsFirst)).toBeLessThan(0);
  });
});
