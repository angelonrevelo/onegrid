// =============================================================================
// Capability detection
//
// Every answer here comes from handing real module bytes to
// `WebAssembly.validate`. User-agent sniffing and `typeof WebAssembly` checks
// both lie: a browser can expose the `WebAssembly` object while refusing a
// `v128` operand, and an enterprise policy can disable WASM entirely while
// leaving the global in place. Validation of a module that USES the feature is
// the only test that cannot be wrong.
//
// The probes are the smallest modules that exercise each feature:
//
//   BASELINE — the eight-byte header of an empty module. Validating it proves
//              a WASM decoder exists and is enabled.
//   SIMD     — a function returning a `v128`, whose body splats an i32 and
//              runs a lane operation. A pre-SIMD engine rejects the 0x7b
//              value type at the type-section stage.
//   THREAD   — a function performing `i32.atomic.load` against a `shared`
//              memory. A pre-threads engine rejects the shared flag.
//
// Threads additionally require the HOST to cooperate: atomics on a shared
// memory need a SharedArrayBuffer, and browsers only hand one out to a
// cross-origin-isolated document. Both are checked, because a module that
// validates but cannot be given a shared memory is not a usable thread path.
//
// Nothing in this file throws. A host that does not define `WebAssembly` at
// all reports every capability false and the caller falls back to JS.
// =============================================================================

import type { AccelCapability } from './types';

/** Empty module header: `\0asm` + version 1. */
export const PROBE_BASELINE: Uint8Array<ArrayBuffer> = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

/** `(func (result v128) (i8x16.splat (i32.const 0)) ...)` */
export const PROBE_SIMD: Uint8Array<ArrayBuffer> = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
);

/** `(memory 1 1 shared) (func (i32.atomic.load (i32.const 0)) drop)` */
export const PROBE_THREAD: Uint8Array<ArrayBuffer> = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x04, 0x01, 0x03, 0x01, 0x01,
  0x0a, 0x0b, 0x01, 0x09, 0x00, 0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a, 0x0b,
);

/**
 * The parts of the host that decide capability. Every field is optional and
 * defaults to the real global, so production calls `detectCapability()` with
 * no argument and tests describe an imaginary browser by filling fields in.
 */
export interface AccelHost {
  /** Usually `WebAssembly.validate`. Absent means no WebAssembly at all. */
  readonly validate?: (bytes: Uint8Array<ArrayBuffer>) => boolean;
  /** Usually `typeof SharedArrayBuffer !== 'undefined'`. */
  readonly sharedArrayBuffer?: boolean;
  /** Usually `globalThis.crossOriginIsolated`. */
  readonly crossOriginIsolated?: boolean;
}

function ambientHost(): AccelHost {
  const wasm = (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly;
  // `exactOptionalPropertyTypes` is on repo-wide, so an absent capability has
  // to be an absent KEY rather than an explicit undefined. That is the better
  // shape anyway: `'validate' in host` then means what it looks like.
  const base = {
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  };
  if (typeof wasm?.validate !== 'function') return base;
  return { ...base, validate: wasm.validate.bind(wasm) };
}

/**
 * A host probe that throws is treated as "feature absent". Some embedders
 * raise on `validate` for oversized or policy-blocked bytes rather than
 * returning false, and a capability probe that can take down the grid is
 * worse than a capability probe that is pessimistic.
 */
function safeValidate(host: AccelHost, bytes: Uint8Array<ArrayBuffer>): boolean {
  const validate = host.validate;
  if (typeof validate !== 'function') return false;
  try {
    return validate(bytes) === true;
  } catch {
    return false;
  }
}

export function detectCapability(host: AccelHost = ambientHost()): AccelCapability {
  const wasm = safeValidate(host, PROBE_BASELINE);
  if (!wasm) return { wasm: false, simd: false, thread: false };
  const simd = safeValidate(host, PROBE_SIMD);
  const thread =
    safeValidate(host, PROBE_THREAD) &&
    host.sharedArrayBuffer === true &&
    host.crossOriginIsolated === true;
  return { wasm, simd, thread };
}
