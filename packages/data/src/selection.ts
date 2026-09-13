// =============================================================================
// BitmapSelection
//
// A row-selection bitmap backed by Uint8Array. Each bit represents whether
// row `i` is selected. Operations are O(n / 8); a Roaring-bitmap
// implementation can drop in later for sparse selections.
//
// Designed as the "selection vector" output of filter operations. Combined
// with sort permutations and group trees, BitmapSelection forms the
// columnar data substrate the renderer reads from.
// =============================================================================

export class BitmapSelection {
  /** Total row count this bitmap is sized for. */
  public readonly length: number;
  private readonly bytes: Uint8Array;
  private cardinalityCache: number | null = null;

  constructor(length: number, initial: 'empty' | 'full' = 'empty') {
    this.length = length;
    this.bytes = new Uint8Array((length + 7) >>> 3);
    if (initial === 'full') {
      this.bytes.fill(0xff);
      // Clear extra bits in the last byte that go beyond `length`.
      const tail = length & 7;
      if (tail !== 0) {
        const last = this.bytes.length - 1;
        this.bytes[last] = (this.bytes[last] ?? 0) & ((1 << tail) - 1);
      }
      this.cardinalityCache = length;
    }
  }

  /** Allocate a new bitmap from a Uint8Array. The array is referenced, not copied. */
  static fromBytes(length: number, bytes: Uint8Array): BitmapSelection {
    const expectedBytes = (length + 7) >>> 3;
    if (bytes.length !== expectedBytes) {
      throw new Error(
        `BitmapSelection.fromBytes: expected ${String(expectedBytes)} bytes for length ${String(length)}, got ${String(bytes.length)}.`,
      );
    }
    const sel = new BitmapSelection(length);
    sel.bytes.set(bytes);
    return sel;
  }

  /** Number of bits set. Computed lazily and cached. */
  get cardinality(): number {
    if (this.cardinalityCache !== null) return this.cardinalityCache;
    let count = 0;
    for (let i = 0; i < this.bytes.length; i++) {
      count += popcount8(this.bytes[i] ?? 0);
    }
    this.cardinalityCache = count;
    return count;
  }

  contains(rowIndex: number): boolean {
    if (rowIndex < 0 || rowIndex >= this.length) return false;
    const byte = this.bytes[rowIndex >>> 3] ?? 0;
    return (byte & (1 << (rowIndex & 7))) !== 0;
  }

  add(rowIndex: number): void {
    if (rowIndex < 0 || rowIndex >= this.length) return;
    const i = rowIndex >>> 3;
    const mask = 1 << (rowIndex & 7);
    if (((this.bytes[i] ?? 0) & mask) === 0) {
      this.bytes[i] = (this.bytes[i] ?? 0) | mask;
      this.cardinalityCache = null;
    }
  }

  remove(rowIndex: number): void {
    if (rowIndex < 0 || rowIndex >= this.length) return;
    const i = rowIndex >>> 3;
    const mask = 1 << (rowIndex & 7);
    if (((this.bytes[i] ?? 0) & mask) !== 0) {
      this.bytes[i] = (this.bytes[i] ?? 0) & ~mask;
      this.cardinalityCache = null;
    }
  }

  /** Bitwise AND, returns a new selection. */
  intersect(other: BitmapSelection): BitmapSelection {
    if (other.length !== this.length) {
      throw new Error('BitmapSelection.intersect: length mismatch.');
    }
    const out = new BitmapSelection(this.length);
    for (let i = 0; i < this.bytes.length; i++) {
      out.bytes[i] = (this.bytes[i] ?? 0) & (other.bytes[i] ?? 0);
    }
    return out;
  }

  /** Bitwise OR, returns a new selection. */
  union(other: BitmapSelection): BitmapSelection {
    if (other.length !== this.length) {
      throw new Error('BitmapSelection.union: length mismatch.');
    }
    const out = new BitmapSelection(this.length);
    for (let i = 0; i < this.bytes.length; i++) {
      out.bytes[i] = (this.bytes[i] ?? 0) | (other.bytes[i] ?? 0);
    }
    return out;
  }

  /** Bitwise NOT (within `length`). */
  invert(): BitmapSelection {
    const out = new BitmapSelection(this.length);
    for (let i = 0; i < this.bytes.length; i++) {
      out.bytes[i] = ~(this.bytes[i] ?? 0) & 0xff;
    }
    const tail = this.length & 7;
    if (tail !== 0) {
      const last = out.bytes.length - 1;
      out.bytes[last] = (out.bytes[last] ?? 0) & ((1 << tail) - 1);
    }
    return out;
  }

  /** Iterate set indices in ascending order. */
  *iterate(): IterableIterator<number> {
    for (let i = 0; i < this.bytes.length; i++) {
      let byte = this.bytes[i] ?? 0;
      const baseIdx = i << 3;
      while (byte !== 0) {
        const lowBit = byte & -byte;
        const offset = lsbIndex(lowBit);
        const idx = baseIdx + offset;
        if (idx < this.length) yield idx;
        byte ^= lowBit;
      }
    }
  }

  /** Materialize as Int32Array of set indices. */
  toIndices(): Int32Array {
    // A tight byte walk rather than `for..of this.iterate()`: the generator
    // allocates a result object per set bit, which made materialising a
    // 500K-row filter cost more than evaluating it.
    const out = new Int32Array(this.cardinality);
    const bytes = this.bytes;
    const length = this.length;
    let i = 0;
    for (let b = 0; b < bytes.length; b++) {
      let byte = bytes[b]!;
      const base = b << 3;
      while (byte !== 0) {
        const low = byte & -byte;
        const idx = base + 31 - Math.clz32(low);
        if (idx < length) out[i++] = idx;
        byte ^= low;
      }
    }
    return out;
  }

  /** Internal byte access (e.g., for fast batch operations). */
  get _bytes(): Uint8Array {
    return this.bytes;
  }
}

function popcount8(b: number): number {
  let n = b - ((b >> 1) & 0x55);
  n = (n & 0x33) + ((n >> 2) & 0x33);
  return (n + (n >> 4)) & 0x0f;
}

function lsbIndex(b: number): number {
  // b is a power of 2 in [1, 128]; deBruijn-free lookup.
  switch (b) {
    case 1:
      return 0;
    case 2:
      return 1;
    case 4:
      return 2;
    case 8:
      return 3;
    case 16:
      return 4;
    case 32:
      return 5;
    case 64:
      return 6;
    case 128:
      return 7;
    default:
      return 0;
  }
}
