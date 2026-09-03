// =============================================================================
// Capability detection — "can this machine run the WebGPU render path?"
//
// The design decision here is that detection NEVER throws and NEVER returns a
// bare boolean. oneGrid's contract is that it must never render nothing: the
// Canvas-2D renderer stays authoritative until WebGPU proves it can take over.
// A bare boolean gives the host no way to log *why* it was refused, so support
// tickets become guesswork. detectWebGpu() therefore returns a report with the
// blocker list, the adapter identity, and the limits it ACTUALLY queried off
// the adapter — not a hardcoded table of what we assume hardware provides.
//
// The limits matter concretely:
//   - maxTextureDimension2D bounds the glyph atlas. A 2048-square atlas holds
//     roughly 4000 16px glyphs; below that the atlas thrashes and the render
//     path is slower than Canvas-2D, so we refuse rather than ship a
//     regression.
//   - maxBufferSize bounds the per-frame instance buffer. One cell instance is
//     CELL_STRIDE (32) bytes; a 40k-visible-cell viewport needs 1.28 MB, which
//     every conformant adapter clears — but a software fallback adapter on a
//     locked-down VM may not, and that is exactly the case we must catch.
//
// Everything is injectable (option.gpu) because there is no GPU in CI: the
// tests drive detection with a fake GPU object and assert on the report.
// =============================================================================

/** Minimum device capability the render path needs to beat Canvas-2D. */
export interface WebGpuRequirement {
  /** Square atlas edge, in texels. Below this the atlas evicts every frame. */
  readonly minTextureDimension2d: number;
  /** Bytes; must hold one frame's instance buffer plus the glyph run buffer. */
  readonly minBufferByte: number;
  /** Vertex buffer slots — the cell pipeline binds one instanced slot. */
  readonly minVertexBuffer: number;
  /**
   * Adapter features that must be present. Empty by default: the MSDF path is
   * deliberately built on core WGSL so it runs on baseline hardware.
   */
  readonly requiredFeature: readonly string[];
}

/** The requirement the shipped pipelines were written against. */
export const DEFAULT_WEBGPU_REQUIREMENT: WebGpuRequirement = {
  minTextureDimension2d: 2048,
  minBufferByte: 8 * 1024 * 1024,
  minVertexBuffer: 1,
  requiredFeature: [],
};

/** Why the render path was refused. An empty array means it can run. */
export type WebGpuBlocker =
  | 'no-navigator-gpu'
  | 'no-adapter'
  | 'adapter-error'
  | 'limit-below-requirement'
  | 'missing-feature';

/** Limits read off the adapter, not assumed. */
export interface WebGpuLimitReport {
  readonly maxTextureDimension2d: number;
  readonly maxBufferByte: number;
  readonly maxVertexBuffer: number;
  readonly maxBindGroup: number;
  readonly maxVertexAttribute: number;
}

/**
 * Adapter identity. Chrome blanks vendor/architecture for fingerprinting
 * reasons, so treat every field as advisory — never branch rendering on it.
 */
export interface WebGpuAdapterReport {
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
}

/** The full capability report. */
export interface WebGpuCapability {
  readonly supported: boolean;
  readonly blocker: readonly WebGpuBlocker[];
  /** Human-readable specifics, one per blocker, for logs and bug reports. */
  readonly detail: readonly string[];
  readonly adapter: WebGpuAdapterReport | null;
  readonly limit: WebGpuLimitReport | null;
  readonly feature: readonly string[];
  readonly missingFeature: readonly string[];
  readonly preferredCanvasFormat: string | null;
}

/**
 * The slice of `GPU` detection needs. Narrow on purpose: a real `navigator.gpu`
 * satisfies it structurally, and a fake in a test is nine lines.
 */
export interface GpuLike {
  requestAdapter(option?: {
    powerPreference?: 'low-power' | 'high-performance';
  }): Promise<AdapterLike | null>;
  getPreferredCanvasFormat?(): string;
}

/** The slice of `GPUAdapter` detection reads. */
export interface AdapterLike {
  readonly features?: { has(name: string): boolean } & Iterable<string>;
  readonly limits?: Record<string, number | undefined>;
  readonly info?: {
    readonly vendor?: string;
    readonly architecture?: string;
    readonly description?: string;
  };
  readonly isFallbackAdapter?: boolean;
}

export interface DetectWebGpuOption {
  /** Injected `GPU` implementation. Defaults to `navigator.gpu`. */
  readonly gpu?: GpuLike;
  readonly requirement?: Partial<WebGpuRequirement>;
  readonly powerPreference?: 'low-power' | 'high-performance';
}

function readLimit(
  limit: Record<string, number | undefined> | undefined,
  name: string,
): number {
  const value = limit?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function featureList(adapter: AdapterLike): string[] {
  const feature = adapter.features;
  if (!feature) return [];
  try {
    return [...feature].map(String).sort();
  } catch {
    // A fake or an exotic host may expose `has` without iteration. Degrade to
    // "we cannot enumerate", which is honest — missingFeature still works
    // because it is computed via `has`, not via the enumeration.
    return [];
  }
}

function unsupported(
  blocker: WebGpuBlocker,
  detail: string,
  requiredFeature: readonly string[],
): WebGpuCapability {
  return {
    supported: false,
    blocker: [blocker],
    detail: [detail],
    adapter: null,
    limit: null,
    feature: [],
    missingFeature: [...requiredFeature],
    preferredCanvasFormat: null,
  };
}

/**
 * Probe the machine. Resolves to a report; never rejects. `supported === false`
 * is the documented signal to keep the Canvas-2D renderer authoritative.
 */
export async function detectWebGpu(
  option: DetectWebGpuOption = {},
): Promise<WebGpuCapability> {
  const requirement: WebGpuRequirement = {
    ...DEFAULT_WEBGPU_REQUIREMENT,
    ...option.requirement,
  };
  const gpu =
    option.gpu ??
    (typeof navigator !== 'undefined'
      ? ((navigator as Navigator & { gpu?: GpuLike }).gpu ?? null)
      : null);

  if (!gpu) {
    return unsupported(
      'no-navigator-gpu',
      'navigator.gpu is undefined — the browser has no WebGPU',
      requirement.requiredFeature,
    );
  }

  let adapter: AdapterLike | null = null;
  try {
    adapter = await gpu.requestAdapter({
      powerPreference: option.powerPreference ?? 'high-performance',
    });
  } catch (err) {
    return unsupported(
      'adapter-error',
      `requestAdapter threw: ${String(err)}`,
      requirement.requiredFeature,
    );
  }

  if (!adapter) {
    return unsupported(
      'no-adapter',
      'requestAdapter resolved null — no compatible adapter',
      requirement.requiredFeature,
    );
  }

  const limit: WebGpuLimitReport = {
    maxTextureDimension2d: readLimit(adapter.limits, 'maxTextureDimension2D'),
    maxBufferByte: readLimit(adapter.limits, 'maxBufferSize'),
    maxVertexBuffer: readLimit(adapter.limits, 'maxVertexBuffers'),
    maxBindGroup: readLimit(adapter.limits, 'maxBindGroups'),
    maxVertexAttribute: readLimit(adapter.limits, 'maxVertexAttributes'),
  };

  const blocker: WebGpuBlocker[] = [];
  const detail: string[] = [];

  const flagLimit = (message: string): void => {
    if (!blocker.includes('limit-below-requirement')) {
      blocker.push('limit-below-requirement');
    }
    detail.push(message);
  };

  if (limit.maxTextureDimension2d < requirement.minTextureDimension2d) {
    flagLimit(
      `maxTextureDimension2D=${limit.maxTextureDimension2d} < required ${requirement.minTextureDimension2d}`,
    );
  }
  if (limit.maxBufferByte < requirement.minBufferByte) {
    flagLimit(
      `maxBufferSize=${limit.maxBufferByte} < required ${requirement.minBufferByte}`,
    );
  }
  if (limit.maxVertexBuffer < requirement.minVertexBuffer) {
    flagLimit(
      `maxVertexBuffers=${limit.maxVertexBuffer} < required ${requirement.minVertexBuffer}`,
    );
  }

  const feature = adapter.features;
  const missingFeature = requirement.requiredFeature.filter(
    (name) => !(feature?.has(name) ?? false),
  );
  if (missingFeature.length > 0) {
    blocker.push('missing-feature');
    detail.push(`adapter is missing: ${missingFeature.join(', ')}`);
  }

  return {
    supported: blocker.length === 0,
    blocker,
    detail,
    adapter: {
      vendor: adapter.info?.vendor ?? '',
      architecture: adapter.info?.architecture ?? '',
      description: adapter.info?.description ?? '(unnamed adapter)',
      isFallbackAdapter: adapter.isFallbackAdapter ?? false,
    },
    limit,
    feature: featureList(adapter),
    missingFeature,
    preferredCanvasFormat: gpu.getPreferredCanvasFormat?.() ?? null,
  };
}

/** One-line log summary — what a host should print when it falls back. */
export function describeCapability(capability: WebGpuCapability): string {
  if (capability.supported) {
    const name = capability.adapter?.description ?? 'unknown adapter';
    return `webgpu-render: ready on ${name} (atlas limit ${capability.limit?.maxTextureDimension2d ?? 0}px)`;
  }
  const why =
    capability.detail.length > 0
      ? capability.detail.join('; ')
      : capability.blocker.join(', ');
  return `webgpu-render: unavailable (${why}) — Canvas-2D renderer stays authoritative`;
}
