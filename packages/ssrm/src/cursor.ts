// =============================================================================
// Canonical keyset-cursor codec.
//
// Cursors are opaque strings on the wire — the protocol mandates that
// clients only ever round-trip the bytes back. But every adapter
// historically rolled its own (sortValues, rowId) → base64-JSON
// implementation, drifting in subtle ways (some tolerated missing
// fields, some didn't; the prefix wasn't standardized; offset cursors
// were a separate code path). This module is the canonical encode /
// decode pair every server and adapter aligns on going into v0.0.8.
//
// Wire shape: `ks:<base64-of-utf8-of-json>` — the `ks:` prefix is the
// version sentinel and disambiguates from legacy `offset:N` cursors
// that earlier mock-server / SsrmRowSource code paths produced. Future
// cursor formats can ship behind a different prefix without breaking
// existing clients (they'll throw on decode and the consumer can
// migrate at their own pace).
//
// JSON payload: `{ "s": [...], "r": <id> }` — short field names keep
// the cursor compact for URL/header transport. Decoder also accepts
// the long-form `{ "sortValues": [...], "rowId": <id> }` so cursors
// produced by the per-adapter implementations that shipped before
// this canonical module continue to round-trip cleanly during the
// migration window.
//
// Production SSRM consumers (real database adapters with millions of
// rows) MUST use these cursors. The legacy `offset:N` shape is
// available only because `SsrmRowSource` does synchronous random
// access against the canvas renderer, which fundamentally needs row
// indices and can't reconstruct them from a forward-only keyset.
// =============================================================================

import type { KeysetCursor, SortField, SortModel } from '@onegrid/protocol';

const KEYSET_PREFIX = 'ks:';
const LEGACY_OFFSET_PREFIX = 'offset:';

/**
 * Encode a `KeysetCursor` as the canonical `ks:<base64-json>` wire
 * string. Servers should produce these for `nextCursor` /
 * `prevCursor` on every block response; clients only ever round-trip
 * them back on the next `BlockRequest.cursor`.
 */
/** JSON cannot distinguish -0 from +0; canonicalize so encode/decode round-trips. */
function canonicalizeSortValue(value: unknown): unknown {
  if (typeof value === 'number' && Object.is(value, -0)) return 0;
  return value;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  const payload = JSON.stringify({
    s: cursor.sortValues.map(canonicalizeSortValue),
    r: cursor.rowId,
  });
  const b64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(payload)
      : Buffer.from(payload, 'utf-8').toString('base64');
  return KEYSET_PREFIX + b64;
}

/**
 * Decode a canonical keyset cursor back to its `KeysetCursor` shape.
 * Tolerant of:
 *   - bare base64-JSON without the `ks:` prefix (the historical
 *     per-adapter encoding) — accepted so cursors emitted by drizzle
 *     / kysely adapters that pre-date this module still parse.
 *   - long-form `{ sortValues, rowId }` payloads — same reason.
 *
 * Throws if the cursor is empty, the prefix indicates a non-keyset
 * format the caller should handle separately (e.g. legacy `offset:N`),
 * or the payload doesn't structurally match.
 */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
  if (!cursor) {
    throw new Error('decodeKeysetCursor: empty cursor.');
  }
  if (isLegacyOffsetCursor(cursor)) {
    throw new Error(
      'decodeKeysetCursor: received a legacy offset cursor; use parseLegacyOffsetCursor() instead.',
    );
  }
  const b64 = cursor.startsWith(KEYSET_PREFIX)
    ? cursor.slice(KEYSET_PREFIX.length)
    : cursor;
  let json: string;
  try {
    json =
      typeof globalThis.atob === 'function'
        ? globalThis.atob(b64)
        : Buffer.from(b64, 'base64').toString('utf-8');
  } catch (err) {
    throw new Error(`decodeKeysetCursor: base64 decode failed: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`decodeKeysetCursor: JSON parse failed: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('decodeKeysetCursor: payload is not an object.');
  }
  const obj = parsed as Record<string, unknown>;
  // Short field names from the canonical codec…
  if (Array.isArray(obj.s) && 'r' in obj) {
    const rowId = obj.r;
    if (typeof rowId !== 'string' && typeof rowId !== 'number') {
      throw new Error('decodeKeysetCursor: rowId must be string or number.');
    }
    return { sortValues: obj.s, rowId };
  }
  // …or the long-form payload from pre-canonical adapter codecs.
  if (Array.isArray(obj.sortValues) && 'rowId' in obj) {
    const rowId = obj.rowId;
    if (typeof rowId !== 'string' && typeof rowId !== 'number') {
      throw new Error('decodeKeysetCursor: rowId must be string or number.');
    }
    return { sortValues: obj.sortValues, rowId };
  }
  throw new Error('decodeKeysetCursor: malformed payload.');
}

/** Returns true if the cursor uses the legacy `offset:N` encoding. */
export function isLegacyOffsetCursor(cursor: string): boolean {
  return cursor.startsWith(LEGACY_OFFSET_PREFIX);
}

/**
 * Parse a legacy offset cursor produced by `SsrmRowSource` or the
 * pre-v0.0.8 mock server. Returns the row offset (always ≥ 0); throws
 * if the prefix doesn't match. Adapters that need to consume legacy
 * cursors during the migration window pair this with
 * `isLegacyOffsetCursor`.
 */
export function parseLegacyOffsetCursor(cursor: string): number {
  if (!isLegacyOffsetCursor(cursor)) {
    throw new Error(
      `parseLegacyOffsetCursor: cursor does not start with "${LEGACY_OFFSET_PREFIX}".`,
    );
  }
  const n = Number(cursor.slice(LEGACY_OFFSET_PREFIX.length));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('parseLegacyOffsetCursor: invalid offset payload.');
  }
  return Math.floor(n);
}

/**
 * Build a keyset cursor from a row + the active sort model + the row
 * id column. Adapter authors call this to produce `nextCursor` after
 * fetching a block: pass the last row of the result, the SortModel
 * the query was executed under, and the column id used as the row's
 * stable tiebreaker. Length of `sortValues` matches `sort.length` so
 * the cursor's structural shape mirrors the active query.
 */
export function cursorFromRow(
  row: Record<string, unknown>,
  sort: SortModel,
  rowIdColumn: string,
): KeysetCursor {
  const sortValues = sort.map((field) => row[field.columnId] ?? null);
  const rawId = row[rowIdColumn];
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new Error(
      `cursorFromRow: row id column "${rowIdColumn}" must produce string or number, got ${typeof rawId}.`,
    );
  }
  return { sortValues, rowId: rawId };
}

/**
 * Compare two keyset cursors under the active sort model. Returns
 * a negative number when `a < b`, zero when equal, positive when
 * `a > b`. Adapter authors use this for client-side sanity checks
 * and tests; it is NOT used on the wire.
 *
 * Tiebreaker is the rowId. Null values follow the `nulls` field of
 * the corresponding `SortField` (default 'last').
 */
export function compareKeysetCursors(
  a: KeysetCursor,
  b: KeysetCursor,
  sort: SortModel,
): number {
  for (let i = 0; i < sort.length; i++) {
    const field = sort[i] as SortField;
    const av = a.sortValues[i];
    const bv = b.sortValues[i];
    const cmp = compareValues(av, bv, field.nulls ?? 'last');
    if (cmp !== 0) {
      return field.direction === 'desc' ? -cmp : cmp;
    }
  }
  if (a.rowId < b.rowId) return -1;
  if (a.rowId > b.rowId) return 1;
  return 0;
}

function compareValues(
  a: unknown,
  b: unknown,
  nulls: 'first' | 'last',
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return nulls === 'first' ? -1 : 1;
  if (bNull) return nulls === 'first' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}
