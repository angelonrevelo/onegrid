// =============================================================================
// createFakeAccelModule — a kernel written in JavaScript, over real linear memory
//
// This is not a mock. It is a second, independent implementation of the same
// ABI, and it is a transcription of the algorithms in `crate/src/lib.rs`:
// bottom-up stable merge sort refining a permutation, open-addressed linear
// probing for factorisation, a bounded max-heap for topK, byte-wise bitmap
// operations. It reads and writes a genuine `WebAssembly.Memory` through raw
// pointers, so it grows, detaches views, and traps on out-of-bounds exactly
// like a compiled module does.
//
// Two things fall out of that, and both are the reason this exists:
//
//   - The binding in `wasm-backend.ts` is testable without a Rust toolchain.
//     `pnpm test` must be green on a machine that has never installed cargo,
//     and it is.
//   - The differential harness compares the delegating JS backend (which
//     routes to @onegrid/data) against a from-scratch kernel. That is a real
//     comparison of two independent implementations, not a function compared
//     with itself.
//
// The one thing it cannot prove is that the RUST is correct. Running the
// harness against the compiled artefact is what does that, and `build.md`
// explains how.
// =============================================================================

import type { AccelModule } from './abi';
import { ACCEL_ABI_VERSION } from './abi';
import { byteLengthFor } from './bit';

/** Where the JS-side bump allocator starts. Below this is "static data". */
const FAKE_HEAP_BASE = 1024;

/** @public */
export interface FakeModuleOption {
  /** Initial size in 64 KiB pages. Default 1 — small on purpose, so tests hit a grow. */
  readonly initialPage?: number;
  /** Maximum size in pages. Default 512 (32 MiB). */
  readonly maximumPage?: number;
}

/**
 * Build a kernel module that satisfies `AccelModule` without any WebAssembly
 * compilation step. The memory is a real `WebAssembly.Memory`.
 * @public
 */
export function createFakeAccelModule(option: FakeModuleOption = {}): AccelModule {
  const memory = new WebAssembly.Memory({
    initial: option.initialPage ?? 1,
    maximum: option.maximumPage ?? 512,
  });

  // Every accessor re-derives its view. See memory.ts: caching one here is
  // precisely the bug this package exists to make impossible.
  const f64 = (): Float64Array => new Float64Array(memory.buffer);
  const i32 = (): Int32Array => new Int32Array(memory.buffer);
  const u8 = (): Uint8Array => new Uint8Array(memory.buffer);

  const isPresent = (presencePtr: number, row: number): boolean =>
    ((u8()[presencePtr + (row >>> 3)] ?? 0) & (1 << (row & 7))) !== 0;

  /**
   * Key-only comparison: no index tiebreak. A multi-key sort is a sequence of
   * stable passes, so a later pass must preserve the order an earlier pass
   * established. Breaking ties on the row index here would silently discard
   * every lower-priority key.
   */
  const keyCompare = (
    valuePtr: number,
    presencePtr: number,
    a: number,
    b: number,
    descending: number,
    missingFirst: number,
  ): number => {
    const pa = isPresent(presencePtr, a);
    const pb = isPresent(presencePtr, b);
    if (!pa || !pb) {
      if (pa === pb) return 0;
      if (!pa) return missingFirst !== 0 ? -1 : 1;
      return missingFirst !== 0 ? 1 : -1;
    }
    const view = f64();
    const va = view[(valuePtr >>> 3) + a] as number;
    const vb = view[(valuePtr >>> 3) + b] as number;
    const d = va < vb ? -1 : va > vb ? 1 : 0;
    return descending !== 0 ? -d : d;
  };

  /** Full order including the index tiebreak — what topK needs to emit a final order. */
  const totalCompare = (
    valuePtr: number,
    presencePtr: number,
    a: number,
    b: number,
    descending: number,
    missingFirst: number,
  ): number => {
    const d = keyCompare(valuePtr, presencePtr, a, b, descending, missingFirst);
    return d !== 0 ? d : a - b;
  };

  /** Normalise -0 to 0 so it hashes and matches identically to 0. */
  const norm = (v: number): number => (v === 0 ? 0 : v);

  const bitScratch = new DataView(new ArrayBuffer(8));
  const hashF64 = (v: number): number => {
    const scratch = bitScratch;
    scratch.setFloat64(0, norm(v));
    const hi = scratch.getUint32(0);
    const lo = scratch.getUint32(4);
    let h = (hi ^ lo) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  };

  const hashPair = (a: number, b: number): number => {
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  };

  return {
    memory,
    og_abi_version: () => ACCEL_ABI_VERSION,
    og_heap_base: () => FAKE_HEAP_BASE,

    og_sort_pass(valuePtr, presencePtr, length, descending, missingFirst, permPtr, scratchPtr) {
      // Bottom-up merge sort. Stable by construction: on a tie the merge takes
      // from the left run, which is the run that came first.
      const permBase = permPtr >>> 2;
      const scratchBase = scratchPtr >>> 2;
      for (let width = 1; width < length; width *= 2) {
        const view = i32();
        for (let lo = 0; lo < length; lo += 2 * width) {
          const mid = Math.min(lo + width, length);
          const hi = Math.min(lo + 2 * width, length);
          let a = lo;
          let b = mid;
          let out = lo;
          while (a < mid && b < hi) {
            const ia = view[permBase + a] as number;
            const ib = view[permBase + b] as number;
            if (keyCompare(valuePtr, presencePtr, ib, ia, descending, missingFirst) < 0) {
              view[scratchBase + out++] = ib;
              b++;
            } else {
              view[scratchBase + out++] = ia;
              a++;
            }
          }
          while (a < mid) view[scratchBase + out++] = view[permBase + a++] as number;
          while (b < hi) view[scratchBase + out++] = view[permBase + b++] as number;
        }
        view.copyWithin(permBase, scratchBase, scratchBase + length);
      }
    },

    og_filter_mask(
      valuePtr,
      presencePtr,
      length,
      op,
      operand,
      upper,
      setPtr,
      setLength,
      outPtr,
    ) {
      const mask = u8();
      const maskByte = byteLengthFor(length);
      for (let i = 0; i < maskByte; i++) mask[outPtr + i] = 0;
      const valueBase = valuePtr >>> 3;
      const setBase = setPtr >>> 3;
      for (let i = 0; i < length; i++) {
        const present = isPresent(presencePtr, i);
        let hit = false;
        if (op === 10) {
          hit = !present;
        } else if (op === 11) {
          hit = present;
        } else if (present) {
          const view = f64();
          const v = view[valueBase + i] as number;
          switch (op) {
            case 0:
              hit = v === operand;
              break;
            case 1:
              hit = v !== operand;
              break;
            case 2:
              hit = v < operand;
              break;
            case 3:
              hit = v <= operand;
              break;
            case 4:
              hit = v > operand;
              break;
            case 5:
              hit = v >= operand;
              break;
            case 6:
            case 7: {
              const inRange = v >= operand && v <= upper;
              hit = op === 6 ? inRange : !inRange;
              break;
            }
            default: {
              let found = false;
              for (let s = 0; s < setLength; s++) {
                if ((view[setBase + s] as number) === v) {
                  found = true;
                  break;
                }
              }
              hit = op === 8 ? found : !found;
              break;
            }
          }
        }
        if (hit) {
          const byte = outPtr + (i >>> 3);
          u8()[byte] = (u8()[byte] ?? 0) | (1 << (i & 7));
        }
      }
    },

    og_group_code(valuePtr, presencePtr, length, outPtr, slotKeyPtr, slotCodePtr, slotCapacity) {
      const codeBase = slotCodePtr >>> 2;
      const keyBase = slotKeyPtr >>> 3;
      const outBase = outPtr >>> 2;
      const valueBase = valuePtr >>> 3;
      // The kernel owns table initialisation — the caller only supplies bytes.
      i32().fill(-1, codeBase, codeBase + slotCapacity);
      let next = 0;
      let missingCode = -1;
      const step = slotCapacity - 1;
      for (let i = 0; i < length; i++) {
        if (!isPresent(presencePtr, i)) {
          if (missingCode < 0) missingCode = next++;
          i32()[outBase + i] = missingCode;
          continue;
        }
        const v = norm(f64()[valueBase + i] as number);
        let slot = hashF64(v) & step;
        for (let probe = 0; ; probe++) {
          if (probe >= slotCapacity) return -1;
          const existing = i32()[codeBase + slot] as number;
          if (existing < 0) {
            f64()[keyBase + slot] = v;
            i32()[codeBase + slot] = next;
            i32()[outBase + i] = next;
            next++;
            break;
          }
          if ((f64()[keyBase + slot] as number) === v) {
            i32()[outBase + i] = existing;
            break;
          }
          slot = (slot + 1) & step;
        }
      }
      return next;
    },

    og_group_combine(aPtr, bPtr, length, outPtr, slotAPtr, slotBPtr, slotCodePtr, slotCapacity) {
      const aBase = aPtr >>> 2;
      const bBase = bPtr >>> 2;
      const outBase = outPtr >>> 2;
      const slotABase = slotAPtr >>> 2;
      const slotBBase = slotBPtr >>> 2;
      const codeBase = slotCodePtr >>> 2;
      i32().fill(-1, codeBase, codeBase + slotCapacity);
      let next = 0;
      const step = slotCapacity - 1;
      for (let i = 0; i < length; i++) {
        const view = i32();
        const a = view[aBase + i] as number;
        const b = view[bBase + i] as number;
        let slot = hashPair(a, b) & step;
        for (let probe = 0; ; probe++) {
          if (probe >= slotCapacity) return -1;
          const existing = i32()[codeBase + slot] as number;
          if (existing < 0) {
            i32()[slotABase + slot] = a;
            i32()[slotBBase + slot] = b;
            i32()[codeBase + slot] = next;
            i32()[outBase + i] = next;
            next++;
            break;
          }
          if ((i32()[slotABase + slot] as number) === a && (i32()[slotBBase + slot] as number) === b) {
            i32()[outBase + i] = existing;
            break;
          }
          slot = (slot + 1) & step;
        }
      }
      return next;
    },

    og_aggregate(
      op,
      valuePtr,
      presencePtr,
      length,
      indexPtr,
      indexLength,
      slotKeyPtr,
      slotStatePtr,
      slotCapacity,
      outPtr,
    ) {
      const valueBase = valuePtr >>> 3;
      const indexBase = indexPtr >>> 2;
      const count = indexLength < 0 ? length : indexLength;
      const rowAt = (position: number): number =>
        indexLength < 0 ? position : (i32()[indexBase + position] as number);

      let sum = 0;
      let seen = 0;
      let acc = 0;
      let hasAcc = false;
      if (op === 3) {
        i32().fill(0, slotStatePtr >>> 2, (slotStatePtr >>> 2) + slotCapacity);
      }
      const keyBase = slotKeyPtr >>> 3;
      const stateBase = slotStatePtr >>> 2;
      const step = slotCapacity - 1;
      let distinct = 0;

      for (let p = 0; p < count; p++) {
        const row = rowAt(p);
        if (row < 0 || row >= length || !isPresent(presencePtr, row)) continue;
        const v = f64()[valueBase + row] as number;
        seen++;
        switch (op) {
          case 0:
          case 1:
            sum += v;
            break;
          case 4:
            if (!hasAcc || v < acc) {
              acc = v;
              hasAcc = true;
            }
            break;
          case 5:
            if (!hasAcc || v > acc) {
              acc = v;
              hasAcc = true;
            }
            break;
          case 6:
            if (!hasAcc) {
              acc = v;
              hasAcc = true;
            }
            break;
          case 7:
            acc = v;
            hasAcc = true;
            break;
          case 3: {
            const key = norm(v);
            let slot = hashF64(key) & step;
            for (let probe = 0; probe < slotCapacity; probe++) {
              if ((i32()[stateBase + slot] as number) === 0) {
                f64()[keyBase + slot] = key;
                i32()[stateBase + slot] = 1;
                distinct++;
                break;
              }
              if ((f64()[keyBase + slot] as number) === key) break;
              slot = (slot + 1) & step;
            }
            break;
          }
          default:
            break;
        }
      }

      const write = (value: number): number => {
        f64()[outPtr >>> 3] = value;
        return 1;
      };
      switch (op) {
        case 0:
          return write(sum);
        case 1:
          return seen === 0 ? 0 : write(sum / seen);
        case 2:
          return write(seen);
        case 3:
          return write(distinct);
        default:
          return hasAcc ? write(acc) : 0;
      }
    },

    og_bitmap_op(op, aPtr, bPtr, bitLength, outPtr) {
      const byteCount = byteLengthFor(bitLength);
      const view = u8();
      for (let i = 0; i < byteCount; i++) {
        const a = view[aPtr + i] ?? 0;
        const b = view[bPtr + i] ?? 0;
        let r: number;
        switch (op) {
          case 0:
            r = a & b;
            break;
          case 1:
            r = a | b;
            break;
          case 2:
            r = ~a;
            break;
          case 3:
            r = a & ~b;
            break;
          default:
            r = a ^ b;
            break;
        }
        view[outPtr + i] = r & 0xff;
      }
      const tail = bitLength & 7;
      if (tail !== 0 && byteCount > 0) {
        const last = outPtr + byteCount - 1;
        view[last] = (view[last] ?? 0) & ((1 << tail) - 1);
      }
    },

    og_top_k(valuePtr, presencePtr, length, k, descending, missingFirst, outPtr, scratchPtr) {
      const want = Math.min(k, length);
      if (want <= 0) return 0;
      const heapBase = scratchPtr >>> 2;
      const outBase = outPtr >>> 2;
      const worse = (x: number, y: number): boolean =>
        totalCompare(valuePtr, presencePtr, x, y, descending, missingFirst) > 0;
      let size = 0;
      for (let i = 0; i < length; i++) {
        const view = i32();
        if (size < want) {
          view[heapBase + size] = i;
          let c = size++;
          while (c > 0) {
            const parent = (c - 1) >> 1;
            const cur = i32();
            if (!worse(cur[heapBase + c] as number, cur[heapBase + parent] as number)) break;
            const t = cur[heapBase + c] as number;
            cur[heapBase + c] = cur[heapBase + parent] as number;
            cur[heapBase + parent] = t;
            c = parent;
          }
          continue;
        }
        if (!worse(i32()[heapBase] as number, i)) continue;
        i32()[heapBase] = i;
        let p = 0;
        for (;;) {
          const cur = i32();
          const l = 2 * p + 1;
          const r = l + 1;
          let big = p;
          if (l < size && worse(cur[heapBase + l] as number, cur[heapBase + big] as number)) big = l;
          if (r < size && worse(cur[heapBase + r] as number, cur[heapBase + big] as number)) big = r;
          if (big === p) break;
          const t = cur[heapBase + p] as number;
          cur[heapBase + p] = cur[heapBase + big] as number;
          cur[heapBase + big] = t;
          p = big;
        }
      }
      // Heap order is not sorted order. Selection-sort the k survivors into
      // the output; k is small by definition, so O(k^2) is the cheap choice
      // and keeps the kernel free of a second sort implementation.
      const taken = new Uint8Array(size);
      for (let out = 0; out < size; out++) {
        let best = -1;
        for (let j = 0; j < size; j++) {
          if (taken[j] === 1) continue;
          const candidate = i32()[heapBase + j] as number;
          if (best < 0 || worse(best, candidate)) best = candidate;
        }
        for (let j = 0; j < size; j++) {
          if (taken[j] !== 1 && (i32()[heapBase + j] as number) === best) {
            taken[j] = 1;
            break;
          }
        }
        i32()[outBase + out] = best;
      }
      return size;
    },
  };
}
