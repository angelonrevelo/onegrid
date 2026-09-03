// =============================================================================
// selectBackend — pick the best available path, and never take the grid down
//
// This function has one absolute rule: it does not throw. It runs during grid
// construction, on hosts nobody tested — a locked-down enterprise browser, an
// SSR pass with no `WebAssembly` global, a jsdom test, a React Native
// WebView — and a capability probe that throws would turn "no acceleration"
// into "no grid".
//
// So every failure path here degrades rather than propagates: probes that
// throw report the feature absent, a module that fails to bind is discarded,
// and the JS reference backend is always the answer of last resort. The reason
// for the choice is returned rather than logged, because a package cannot know
// whether the adopter wants that on the console.
// =============================================================================

import type { AccelModule } from './abi';
import type { AccelBackend, AccelCapability } from './types';
import type { AccelHost } from './detect';
import { detectCapability } from './detect';
import { createJsBackend } from './js-backend';
import { createWasmBackend } from './wasm-backend';

/** @public */
export interface SelectBackendOption {
  /**
   * The kernel module, or a factory that instantiates one. A factory that
   * throws is treated as "no kernel available" — adopters commonly want to
   * pass `() => instantiateSync(bytes)` and have a corrupt asset degrade to
   * JS rather than take down the page.
   */
  readonly module?: AccelModule | (() => AccelModule);
  /** Override the host probe. Tests pass a simulated host; production omits it. */
  readonly host?: AccelHost;
  /** Skip detection entirely and return the reference backend. */
  readonly forceJs?: boolean;
}

/** @public */
export interface BackendSelection {
  readonly backend: AccelBackend;
  readonly capability: AccelCapability;
  /** Human-readable justification, e.g. `wasm unavailable on this host`. */
  readonly reason: string;
}

function resolveModule(
  source: AccelModule | (() => AccelModule) | undefined,
): AccelModule | null {
  if (!source) return null;
  try {
    return typeof source === 'function' ? source() : source;
  } catch {
    return null;
  }
}

/** @public */
export function selectBackend(option: SelectBackendOption = {}): BackendSelection {
  if (option.forceJs === true) {
    return {
      backend: createJsBackend(),
      capability: { wasm: false, simd: false, thread: false },
      reason: 'forceJs requested',
    };
  }

  let capability: AccelCapability;
  try {
    capability = detectCapability(option.host);
  } catch {
    capability = { wasm: false, simd: false, thread: false };
  }

  if (!capability.wasm) {
    return {
      backend: createJsBackend(),
      capability,
      reason: 'WebAssembly is unavailable or disabled on this host',
    };
  }

  const module = resolveModule(option.module);
  if (!module) {
    return {
      backend: createJsBackend(),
      capability,
      reason: 'WebAssembly is supported but no kernel module was supplied',
    };
  }

  try {
    // The name records what the host can do, not what the module was compiled
    // with — a SIMD-capable host running a scalar kernel is a real and
    // reportable state, and naming it is how it gets noticed.
    const name = capability.thread
      ? 'wasm-thread'
      : capability.simd
        ? 'wasm-simd'
        : 'wasm';
    return {
      backend: createWasmBackend(module, { capability, name }),
      capability,
      reason: `bound kernel module as "${name}"`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      backend: createJsBackend(),
      capability,
      reason: `kernel module rejected: ${detail}`,
    };
  }
}
