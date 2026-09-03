// =============================================================================
// Bit and missing-value helpers shared by every backend.
//
// These are the pieces both the JS reference and the WASM marshalling layer
// must agree on before an operation even starts. Keeping them in one file is
// what makes "the JS backend is the semantic reference" enforceable: if the
// notion of "missing" drifted between the two call sites, the differential
// harness would be comparing two different questions.
// =============================================================================

/** Byte count needed to hold `bitLength` bits. */
export function byteLengthFor(bitLength: number): number {
  return (Math.max(0, bitLength) + 7) >>> 3;
}

export function getBit(bitmap: Uint8Array, index: number): boolean {
  return ((bitmap[index >>> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

export function setBit(bitmap: Uint8Array, index: number): void {
  bitmap[index >>> 3] = (bitmap[index >>> 3] ?? 0) | (1 << (index & 7));
}

/**
 * Clear every bit at or beyond `bitLength` in the final byte. Two bitmaps of
 * equal bit length are only byte-comparable if both have done this, so every
 * bitmap this package hands out is trimmed before it leaves.
 */
export function trimTail(bitmap: Uint8Array, bitLength: number): Uint8Array {
  const tail = bitLength & 7;
  if (tail !== 0 && bitmap.length > 0) {
    const last = byteLengthFor(bitLength) - 1;
    bitmap[last] = (bitmap[last] ?? 0) & ((1 << tail) - 1);
  }
  for (let i = byteLengthFor(bitLength); i < bitmap.length; i++) bitmap[i] = 0;
  return bitmap;
}

/**
 * Collapse "validity bit clear" and "value is NaN" into one presence bitmap.
 *
 * Every operation in this package consumes presence through this function and
 * never looks at NaN again. See the header of `types.ts` for why NaN is
 * classified as missing rather than ordered.
 */
export function presenceBitmap(
  value: Float64Array,
  validity: Uint8Array | undefined,
  length: number,
): Uint8Array {
  const out = new Uint8Array(byteLengthFor(length));
  for (let i = 0; i < length; i++) {
    const v = value[i];
    if (v === undefined || Number.isNaN(v)) continue;
    if (validity && !getBit(validity, i)) continue;
    setBit(out, i);
  }
  return out;
}

/**
 * Compare two rows of one sort key under the total order this package
 * guarantees: missing rows on the requested side, values by magnitude with
 * direction applied, and the source index as the final tiebreak so the sort is
 * stable without depending on the sort algorithm being stable.
 */
export function compareRow(
  value: Float64Array,
  present: Uint8Array,
  a: number,
  b: number,
  descending: boolean,
  missingFirst: boolean,
): number {
  const pa = getBit(present, a);
  const pb = getBit(present, b);
  if (!pa || !pb) {
    if (pa === pb) return a - b;
    // Exactly one is missing.
    if (!pa) return missingFirst ? -1 : 1;
    return missingFirst ? 1 : -1;
  }
  const va = value[a] as number;
  const vb = value[b] as number;
  let d = va < vb ? -1 : va > vb ? 1 : 0;
  if (descending) d = -d;
  return d !== 0 ? d : a - b;
}
