// =============================================================================
// Capability detection and backend selection across simulated hosts.
//
// The interesting hosts are the ones nobody has: a browser with SIMD but no
// cross-origin isolation, an embedder whose `validate` throws, a server-side
// render with no WebAssembly global at all. Injecting the host is what makes
// those testable, and the load-bearing assertion in every one of them is that
// nothing throws.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  PROBE_BASELINE,
  PROBE_SIMD,
  PROBE_THREAD,
  detectCapability,
} from '../detect';
import type { AccelHost } from '../detect';
import { selectBackend } from '../select';
import { createFakeAccelModule } from '../fake-module';
import { ACCEL_ABI_VERSION } from '../abi';
import type { AccelModule } from '../abi';

/** A host that accepts exactly the probes it has been told to accept. */
function hostAccepting(accept: ReadonlyArray<Uint8Array>, rest: Partial<AccelHost> = {}): AccelHost {
  return {
    validate: (bytes) => accept.some((probe) => probe === bytes),
    sharedArrayBuffer: rest.sharedArrayBuffer ?? false,
    crossOriginIsolated: rest.crossOriginIsolated ?? false,
  };
}

describe('detectCapability — probe bytes', () => {
  it('ships probe modules that a real engine actually accepts', () => {
    // If this fails, the probes are malformed and every host would be reported
    // as incapable — a silent, permanent fallback to JS.
    expect(WebAssembly.validate(PROBE_BASELINE)).toBe(true);
    expect(WebAssembly.validate(PROBE_SIMD)).toBe(true);
    expect(WebAssembly.validate(PROBE_THREAD)).toBe(true);
  });

  it('reads the real ambient host without throwing', () => {
    const capability = detectCapability();
    expect(typeof capability.wasm).toBe('boolean');
    expect(typeof capability.simd).toBe('boolean');
    expect(typeof capability.thread).toBe('boolean');
    expect(capability.wasm).toBe(true);
  });
});

describe('detectCapability — simulated hosts', () => {
  it('reports nothing when the host has no WebAssembly at all', () => {
    expect(detectCapability({})).toEqual({ wasm: false, simd: false, thread: false });
  });

  it('reports nothing when WebAssembly exists but rejects even the empty module', () => {
    expect(detectCapability({ validate: () => false })).toEqual({
      wasm: false,
      simd: false,
      thread: false,
    });
  });

  it('reports baseline WASM without SIMD on a pre-SIMD engine', () => {
    expect(detectCapability(hostAccepting([PROBE_BASELINE]))).toEqual({
      wasm: true,
      simd: false,
      thread: false,
    });
  });

  it('reports SIMD when the v128 probe validates', () => {
    expect(detectCapability(hostAccepting([PROBE_BASELINE, PROBE_SIMD]))).toEqual({
      wasm: true,
      simd: true,
      thread: false,
    });
  });

  it('withholds threads when the engine validates atomics but the page is not isolated', () => {
    const host = hostAccepting([PROBE_BASELINE, PROBE_SIMD, PROBE_THREAD], {
      sharedArrayBuffer: true,
      crossOriginIsolated: false,
    });
    expect(detectCapability(host).thread).toBe(false);
  });

  it('withholds threads when the page is isolated but SharedArrayBuffer is absent', () => {
    const host = hostAccepting([PROBE_BASELINE, PROBE_THREAD], {
      sharedArrayBuffer: false,
      crossOriginIsolated: true,
    });
    expect(detectCapability(host).thread).toBe(false);
  });

  it('reports threads only when engine, SharedArrayBuffer and isolation all agree', () => {
    const host = hostAccepting([PROBE_BASELINE, PROBE_SIMD, PROBE_THREAD], {
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    });
    expect(detectCapability(host)).toEqual({ wasm: true, simd: true, thread: true });
  });

  it('treats a validate that throws as a feature that is absent', () => {
    const host: AccelHost = {
      validate: () => {
        throw new Error('blocked by policy');
      },
    };
    expect(() => detectCapability(host)).not.toThrow();
    expect(detectCapability(host).wasm).toBe(false);
  });

  it('treats a validate returning a truthy non-boolean as failure', () => {
    const host = { validate: (() => 1) as unknown as AccelHost['validate'] };
    expect(detectCapability(host).wasm).toBe(false);
  });
});

describe('selectBackend', () => {
  it('falls back to JS when the host cannot run WebAssembly', () => {
    const selection = selectBackend({ host: {}, module: createFakeAccelModule() });
    expect(selection.backend.name).toBe('js');
    expect(selection.reason).toContain('unavailable');
  });

  it('falls back to JS when the host can but no module was supplied', () => {
    const selection = selectBackend({ host: hostAccepting([PROBE_BASELINE]) });
    expect(selection.backend.name).toBe('js');
    expect(selection.capability.wasm).toBe(true);
    expect(selection.reason).toContain('no kernel module');
  });

  it('binds the module and names the backend after the host capability', () => {
    const simd = selectBackend({
      host: hostAccepting([PROBE_BASELINE, PROBE_SIMD]),
      module: createFakeAccelModule(),
    });
    expect(simd.backend.name).toBe('wasm-simd');
    expect(simd.backend.capability.simd).toBe(true);

    const scalar = selectBackend({
      host: hostAccepting([PROBE_BASELINE]),
      module: createFakeAccelModule(),
    });
    expect(scalar.backend.name).toBe('wasm');

    const threaded = selectBackend({
      host: hostAccepting([PROBE_BASELINE, PROBE_SIMD, PROBE_THREAD], {
        sharedArrayBuffer: true,
        crossOriginIsolated: true,
      }),
      module: createFakeAccelModule(),
    });
    expect(threaded.backend.name).toBe('wasm-thread');
  });

  it('accepts a factory and degrades to JS when the factory throws', () => {
    const selection = selectBackend({
      host: hostAccepting([PROBE_BASELINE]),
      module: () => {
        throw new Error('asset 404');
      },
    });
    expect(selection.backend.name).toBe('js');
    expect(selection.reason).toContain('no kernel module');
  });

  it('degrades to JS when the module reports the wrong ABI version', () => {
    const stale: AccelModule = {
      ...createFakeAccelModule(),
      og_abi_version: () => ACCEL_ABI_VERSION + 1,
    };
    const selection = selectBackend({
      host: hostAccepting([PROBE_BASELINE]),
      module: stale,
    });
    expect(selection.backend.name).toBe('js');
    expect(selection.reason).toContain('ABI version');
  });

  it('returns the reference backend on request without probing anything', () => {
    const selection = selectBackend({ forceJs: true, module: createFakeAccelModule() });
    expect(selection.backend.name).toBe('js');
    expect(selection.reason).toBe('forceJs requested');
  });

  it('never throws, whatever the host does', () => {
    expect(() =>
      selectBackend({
        host: {
          get validate(): AccelHost['validate'] {
            throw new Error('exploding getter');
          },
        },
      }),
    ).not.toThrow();
  });
});
