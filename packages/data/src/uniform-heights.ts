// =============================================================================
// UniformHeights
//
// Row heights for the common case: every row is the same height except a
// handful — the ones a user resized, or whose detail panel is open.
//
// FenwickHeights stores two Float64Arrays of length n. That is fine at 10M rows
// (~160 MB) and impossible at a billion (~16 GB, before the grid's own copies),
// even though almost every entry holds the same number. This stores the default
// height once plus a sorted list of overrides, so memory is O(overrides) and a
// billion-row grid costs the same to mount as a thousand-row one:
//
//   prefixSum(i)        — i × height + Σ(override − height) below i   — O(log k)
//   indexAtOffset(y)    — binary search over rows on prefixSum          — O(log n · log k)
//   setHeight(i, h)     — insert / update / remove one override          — O(k)
//
// k is the override count. setHeight is O(k) because the running delta array is
// rebuilt; k is "rows the user touched", so that stays small by construction.
//
// Contract: every method returns exactly what FenwickHeights returns for the
// same heights — including indexAtOffset's clamping and its treatment of zero-
// height rows — so the grid can hold either behind one interface. Heights must
// be non-negative (as they must for FenwickHeights' descent to be meaningful).
// Integer and half-pixel heights sum exactly in both; arbitrary fractions can
// differ by floating-point summation order, as any two summation orders can.
// =============================================================================

/** What the grid's layout needs from a row-height store. */
export interface RowHeights {
  readonly length: number;
  /** Height of a single row. */
  get(index: number): number;
  /** Sum of heights for rows [0, count). */
  prefixSum(count: number): number;
  /** Total height of all rows. */
  readonly totalHeight: number;
  /** The row containing vertical offset `y` (clamped to [0, length - 1]). */
  indexAtOffset(offset: number): number;
  /** Replace one row's height. */
  setHeight(index: number, newHeight: number): void;
}

export class UniformHeights implements RowHeights {
  public readonly length: number;
  /** The height every row has unless overridden. */
  public readonly height: number;
  /** Overridden row indices, ascending. */
  private row: number[] = [];
  /** Override heights, parallel to `row`. */
  private value: number[] = [];
  /** prefixDelta[j] = Σ(value[m] − height) for m < j. Length row.length + 1. */
  private prefixDelta: number[] = [0];

  constructor(length: number, height: number) {
    // Tolerant on purpose. The grid used to allocate `new Float32Array(numRows)`,
    // which turns a missing or invalid count (a headless host mounting before
    // its row source is ready) into an empty table. Throwing here would turn
    // that into a crashed mount, so an invalid length means zero rows.
    const n = Number(length);
    this.length = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    this.height = height;
  }

  /** A copy with the same default height and overrides. O(k). */
  clone(): UniformHeights {
    const out = new UniformHeights(this.length, this.height);
    out.row = this.row.slice();
    out.value = this.value.slice();
    out.prefixDelta = this.prefixDelta.slice();
    return out;
  }

  /**
   * A copy where every row in `row` is `extra` taller than it is here — the
   * grid's "base heights plus an open detail panel". One merge, O(k log k) for
   * k overrides after the change, where k setHeight calls would be O(k²).
   */
  withAdded(row: Iterable<number>, extra: number): UniformHeights {
    const merged = new Map<number, number>();
    for (let j = 0; j < this.row.length; j++) merged.set(this.row[j]!, this.value[j]!);
    for (const r of row) {
      if (r < 0 || r >= this.length || !Number.isInteger(r)) continue;
      // From THIS store's height, not the running merge: a row listed twice is
      // still one open panel, not two.
      merged.set(r, this.get(r) + extra);
    }
    const out = new UniformHeights(this.length, this.height);
    const key = [...merged.keys()].filter((r) => merged.get(r) !== this.height).sort((a, b) => a - b);
    out.row = key;
    out.value = key.map((r) => merged.get(r)!);
    out.rebuildPrefix();
    return out;
  }

  /** Number of overridden rows — the structure's whole memory cost. */
  get overrideCount(): number {
    return this.row.length;
  }

  get(index: number): number {
    if (index < 0 || index >= this.length) return 0;
    const j = this.search(index);
    return j < this.row.length && this.row[j] === index ? this.value[j]! : this.height;
  }

  prefixSum(count: number): number {
    const c = Math.max(0, Math.min(Math.floor(count), this.length));
    // Overrides strictly below c.
    const j = this.search(c);
    return c * this.height + this.prefixDelta[j]!;
  }

  get totalHeight(): number {
    return this.prefixSum(this.length);
  }

  /**
   * FenwickHeights' descent returns the largest i with prefixSum(i) <= offset,
   * clamped to length - 1, and 0 for offset <= 0. prefixSum is non-decreasing,
   * so the same i is a binary search away.
   */
  indexAtOffset(offset: number): number {
    if (offset <= 0 || this.length === 0) return 0;
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (this.prefixSum(mid) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo >= this.length ? this.length - 1 : lo;
  }

  setHeight(index: number, newHeight: number): void {
    if (index < 0 || index >= this.length) return;
    const j = this.search(index);
    const present = j < this.row.length && this.row[j] === index;
    if (newHeight === this.height) {
      if (!present) return;
      this.row.splice(j, 1);
      this.value.splice(j, 1);
    } else if (present) {
      if (this.value[j] === newHeight) return;
      this.value[j] = newHeight;
    } else {
      this.row.splice(j, 0, index);
      this.value.splice(j, 0, newHeight);
    }
    this.rebuildPrefix();
  }

  /** First position j with row[j] >= index. */
  private search(index: number): number {
    let lo = 0;
    let hi = this.row.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.row[mid]! < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private rebuildPrefix(): void {
    const prefix = new Array<number>(this.row.length + 1);
    prefix[0] = 0;
    for (let j = 0; j < this.row.length; j++) prefix[j + 1] = prefix[j]! + (this.value[j]! - this.height);
    this.prefixDelta = prefix;
  }
}
