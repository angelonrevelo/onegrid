// =============================================================================
// The renderer — capability gate, resource lifetime, device loss, one frame.
//
// TWO CONTRACTS DRIVE THIS FILE.
//
// 1. oneGrid must never render nothing. createWebGpuRenderer therefore returns
//    a RESULT, not a renderer, and never rejects on an unsupported machine:
//    `{ ok: false, reason, capability }` is the documented signal for the host
//    to keep the Canvas-2D renderer authoritative. A thrown error would work
//    too, except that hosts catch and log errors inconsistently, and the one
//    failure mode we cannot ship is a grid that silently paints nothing.
//    renderFrame() honours the same contract after startup: once the device is
//    gone it returns `rendered: false` with a reason instead of throwing, so
//    the host can switch back mid-session.
//
// 2. A lost device is routine. Switching a laptop from the discrete GPU to the
//    integrated one, a driver update, or Chrome reclaiming GPU memory under
//    pressure all fire device.lost, and none of them are bugs. So we subscribe,
//    tear the resources down (they belong to the dead device and touching them
//    afterwards is undefined behaviour), and re-acquire with EXPONENTIAL
//    BACKOFF and a BOUNDED retry count. Bounded matters: if the GPU process is
//    crash-looping, an unbounded retry turns a degraded grid into a pinned CPU
//    core. After the bound, we go to 'failed' once, tell the host, and stop.
//
// Every dependency the renderer cannot construct in Node is injectable —
// device acquisition, the canvas context, the glyph source and the sleep timer
// — which is what makes the loss-and-recovery path testable on a machine with
// no GPU at all.
// =============================================================================

import {
  detectWebGpu,
  describeCapability,
  type GpuLike,
  type WebGpuCapability,
} from './capability.js';
import { createGlyphAtlas, type AtlasStat, type GlyphAtlas } from './atlas.js';
import type { GlyphSource } from './glyph-source.js';
import {
  layoutCellText,
  type HorizontalAlign,
  type VerticalAlign,
} from './text-layout.js';
import {
  planDamage,
  DEFAULT_DAMAGE_THRESHOLD,
  type DamageRect,
  type Viewport,
} from './damage.js';
import {
  buildInstancePipeline,
  createInstanceRing,
  packGlyphInstance,
  BUFFER_USAGE_COPY_DST,
  BUFFER_USAGE_UNIFORM,
  GLYPH_INSTANCE_STRIDE,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_TEXTURE_BINDING,
  type GlyphInstance,
  type InstanceRing,
  type PipelineDevice,
  type RingDevice,
  type RingQueue,
  type RingStat,
} from './instance-pipeline.js';
import {
  buildGlyphInstance,
  encodeGridFrame,
  type CellRenderPass,
  type FrameDrawReport,
} from './frame.js';
import { packCells, CELL_STRIDE, type CellPackInput } from './vertex-buffer.js';

/** Queue surface the renderer needs on top of the ring's. */
export interface RenderQueue extends RingQueue {
  writeTexture(
    destination: { texture: GPUTexture; origin?: { x: number; y: number } },
    data: ArrayBufferView | ArrayBufferLike,
    dataLayout: { offset?: number; bytesPerRow: number; rowsPerImage: number },
    size: { width: number; height: number; depthOrArrayLayers?: number },
  ): void;
  submit(commandBuffer: readonly GPUCommandBuffer[]): void;
}

export interface RenderCommandEncoder {
  beginRenderPass(descriptor: GPURenderPassDescriptor): CellRenderPass;
  finish(): GPUCommandBuffer;
}

/** The GPUDevice surface the renderer uses. A real GPUDevice satisfies it. */
export interface RenderDevice extends RingDevice, PipelineDevice {
  readonly queue: RenderQueue;
  readonly lost: Promise<{ readonly reason?: string; readonly message: string }>;
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
  createSampler(descriptor?: GPUSamplerDescriptor): GPUSampler;
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
  createCommandEncoder(descriptor?: { label?: string }): RenderCommandEncoder;
  destroy(): void;
}

/** The canvas WebGPU context surface. */
export interface RenderContext {
  configure(configuration: {
    device: RenderDevice;
    format: GPUTextureFormat;
    alphaMode?: GPUCanvasAlphaMode;
  }): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

export interface RenderCanvas {
  readonly width: number;
  readonly height: number;
  getContext(contextId: 'webgpu'): RenderContext | null;
}

/** Renderer lifecycle state. */
export type RendererState =
  | 'ready'
  | 'recovering'
  | 'failed'
  | 'disposed';

/** One cell to paint. Text is optional — a spacer or a spanned cell has none. */
export interface RenderCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Packed 0xRRGGBBAA. */
  readonly bgColor: number;
  readonly fgColor: number;
  readonly text?: string;
  readonly align?: HorizontalAlign;
  readonly verticalAlign?: VerticalAlign;
}

export interface RenderFrameInput {
  readonly cell: readonly RenderCell[];
  /** Dirty regions. Omit for a full-frame redraw (the first frame, a resize,
   *  a theme change — anything where nothing is reusable). */
  readonly damage?: readonly DamageRect[];
  readonly viewport?: Viewport;
  /** On-screen text size. The atlas rasterises at the source's em size and the
   *  renderer scales; one atlas serves every text size on screen. */
  readonly fontSizePx?: number;
  readonly paddingX?: number;
  readonly paddingY?: number;
}

export interface RenderFrameReport extends FrameDrawReport {
  readonly rendered: boolean;
  /** Non-null exactly when `rendered` is false. */
  readonly skipReason: 'device-lost' | 'device-failed' | 'disposed' | null;
  readonly coverage: number;
  readonly threshold: number;
  readonly atlasStat: AtlasStat;
  readonly cellRingStat: RingStat;
  readonly glyphRingStat: RingStat;
}

export interface WebGpuRendererOption {
  readonly canvas: RenderCanvas;
  readonly glyphSource: GlyphSource;
  /** Injected GPU for capability detection. Defaults to navigator.gpu. */
  readonly gpu?: GpuLike;
  /** Injected device acquisition. Required when `gpu` is a fake, because a fake
   *  adapter cannot produce a real device. */
  readonly acquireDevice?: () => Promise<RenderDevice>;
  /** Skip detection and trust this report — the host may have detected once at
   *  startup and be creating renderers per grid. */
  readonly capability?: WebGpuCapability;
  readonly format?: GPUTextureFormat;
  /** Atlas edge in texels. Clamped to the adapter's maxTextureDimension2D. */
  readonly atlasSize?: number;
  /** Instances the staging ring is sized for. */
  readonly instanceCapacity?: number;
  readonly ringDepth?: number;
  /** Bounded retry after a device loss. 0 disables recovery entirely. */
  readonly maxRetry?: number;
  /** First retry delay in ms; doubles per attempt. */
  readonly retryDelayMs?: number;
  /** Injected timer so tests do not wait on real backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Damage coverage crossover; supply a calibrated value from
   *  measureDamageCrossover() once the host has measured this machine. */
  readonly damageThreshold?: number;
  readonly onStateChange?: (state: RendererState, detail: string) => void;
}

export interface WebGpuRenderer {
  readonly capability: WebGpuCapability;
  readonly state: RendererState;
  /** Successful device re-acquisitions since creation. */
  readonly restartCount: number;
  readonly atlas: GlyphAtlas;
  renderFrame(input: RenderFrameInput): Promise<RenderFrameReport>;
  /** Resolves when any in-progress recovery has settled. */
  whenReady(): Promise<void>;
  dispose(): void;
}

export type WebGpuRendererResult =
  | { readonly ok: true; readonly renderer: WebGpuRenderer }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly capability: WebGpuCapability;
    };

/** Resources whose lifetime is exactly one device's. */
interface DeviceResource {
  device: RenderDevice;
  context: RenderContext;
  atlas: GlyphAtlas;
  cellRing: InstanceRing;
  glyphRing: InstanceRing;
  cellPipeline: GPURenderPipeline;
  glyphPipeline: GPURenderPipeline;
  cellBindGroup: GPUBindGroup;
  glyphBindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  atlasTexture: GPUTexture;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a renderer, or explain why this machine cannot have one.
 *
 * Detection runs first and its report is carried on the result either way, so a
 * host that falls back still has the adapter identity and limits to log.
 */
export async function createWebGpuRenderer(
  option: WebGpuRendererOption,
): Promise<WebGpuRendererResult> {
  const capability =
    option.capability ??
    (await detectWebGpu(option.gpu ? { gpu: option.gpu } : {}));

  if (!capability.supported) {
    return { ok: false, reason: describeCapability(capability), capability };
  }

  const context = option.canvas.getContext('webgpu');
  if (!context) {
    return {
      ok: false,
      reason:
        'webgpu-render: canvas.getContext("webgpu") returned null — Canvas-2D renderer stays authoritative',
      capability,
    };
  }

  const acquireDevice = option.acquireDevice ?? defaultDeviceAcquisition;
  const format =
    option.format ??
    ((capability.preferredCanvasFormat ?? 'bgra8unorm') as GPUTextureFormat);
  const atlasSize = Math.min(
    option.atlasSize ?? 2048,
    capability.limit?.maxTextureDimension2d ?? 2048,
  );
  const instanceCapacity = option.instanceCapacity ?? 4096;
  const ringDepth = option.ringDepth ?? 3;
  const maxRetry = option.maxRetry ?? 3;
  const retryDelayMs = option.retryDelayMs ?? 50;
  const sleep = option.sleep ?? defaultSleep;
  const source = option.glyphSource;

  let state: RendererState = 'ready';
  let restartCount = 0;
  let frameIndex = 0;
  let recovery: Promise<void> | null = null;
  let resource: DeviceResource;

  const notify = (next: RendererState, detail: string): void => {
    state = next;
    option.onStateChange?.(next, detail);
  };

  const canvasContext: RenderContext = context;

  function buildResource(device: RenderDevice): DeviceResource {
    const atlasTexture = device.createTexture({
      label: 'onegrid-glyph-atlas',
      size: { width: atlasSize, height: atlasSize, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_TEXTURE_BINDING | TEXTURE_USAGE_COPY_DST,
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      label: 'onegrid-viewport-uniform',
      // vec2f is 8 bytes but a uniform buffer binding must be 16-byte aligned.
      size: 16,
      usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
    });
    const pipeline = buildInstancePipeline(device, format);
    const cellBindGroup = device.createBindGroup({
      layout: pipeline.cellPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    const glyphBindGroup = device.createBindGroup({
      layout: pipeline.glyphPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: atlasTexture.createView() },
      ],
    });
    canvasContext.configure({ device, format, alphaMode: 'premultiplied' });

    return {
      device,
      context: canvasContext,
      atlasTexture,
      uniformBuffer,
      cellPipeline: pipeline.cellPipeline,
      glyphPipeline: pipeline.glyphPipeline,
      cellBindGroup,
      glyphBindGroup,
      atlas: createGlyphAtlas({
        source,
        queue: device.queue,
        texture: atlasTexture,
        width: atlasSize,
        height: atlasSize,
      }),
      cellRing: createInstanceRing({
        device,
        instanceCapacity,
        byteStride: CELL_STRIDE,
        depth: ringDepth,
        label: 'onegrid-cell-ring',
      }),
      glyphRing: createInstanceRing({
        device,
        instanceCapacity: instanceCapacity * 4,
        byteStride: GLYPH_INSTANCE_STRIDE,
        depth: ringDepth,
        label: 'onegrid-glyph-ring',
      }),
    };
  }

  function teardown(destroyDevice: boolean): void {
    try {
      resource.cellRing.destroy();
      resource.glyphRing.destroy();
      resource.atlas.reset();
      resource.atlasTexture.destroy();
      resource.uniformBuffer.destroy();
      resource.context.unconfigure();
      if (destroyDevice) resource.device.destroy();
    } catch {
      // A device that is already gone rejects or throws on teardown. That is
      // the expected path on loss, not an error worth propagating — the whole
      // point of teardown here is to drop our references.
    }
  }

  function watchLoss(device: RenderDevice): void {
    void device.lost.then((info) => {
      if (state === 'disposed') return;
      recovery = recoverFrom(info.message || info.reason || 'device lost');
    });
  }

  async function recoverFrom(detail: string): Promise<void> {
    notify('recovering', `device lost: ${detail}`);
    teardown(false);
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      // Exponential backoff. The first retry is usually enough on a GPU
      // switch; the later ones exist for a driver that is still restarting.
      await sleep(retryDelayMs * 2 ** (attempt - 1));
      if ((state as RendererState) === 'disposed') return;
      try {
        const device = await acquireDevice();
        resource = buildResource(device);
        watchLoss(device);
        restartCount++;
        notify('ready', `device re-acquired after ${attempt} attempt(s)`);
        return;
      } catch {
        // Keep trying until the bound. Swallowing here is deliberate: the
        // only interesting error is the last one, reported below.
      }
    }
    notify(
      'failed',
      `device could not be re-acquired after ${maxRetry} attempt(s) — Canvas-2D renderer must take over`,
    );
  }

  let device: RenderDevice;
  try {
    device = await acquireDevice();
  } catch (err) {
    return {
      ok: false,
      reason: `webgpu-render: requestDevice failed (${String(err)}) — Canvas-2D renderer stays authoritative`,
      capability,
    };
  }
  resource = buildResource(device);
  watchLoss(device);

  function skipped(reason: NonNullable<RenderFrameReport['skipReason']>): RenderFrameReport {
    return {
      rendered: false,
      skipReason: reason,
      drawCallCount: 0,
      scissorRectCount: 0,
      cellInstanceCount: 0,
      glyphInstanceCount: 0,
      mode: 'none',
      coverage: 0,
      threshold: option.damageThreshold ?? DEFAULT_DAMAGE_THRESHOLD,
      atlasStat: resource.atlas.stat(),
      cellRingStat: resource.cellRing.stat(),
      glyphRingStat: resource.glyphRing.stat(),
    };
  }

  const renderer: WebGpuRenderer = {
    capability,
    get state() {
      return state;
    },
    get restartCount() {
      return restartCount;
    },
    get atlas() {
      return resource.atlas;
    },

    async whenReady(): Promise<void> {
      await recovery;
    },

    async renderFrame(input: RenderFrameInput): Promise<RenderFrameReport> {
      if (state === 'disposed') return skipped('disposed');
      if (state === 'recovering') return skipped('device-lost');
      if (state === 'failed') return skipped('device-failed');

      const viewport = input.viewport ?? {
        width: option.canvas.width,
        height: option.canvas.height,
      };
      const fontSizePx = input.fontSizePx ?? 14;
      const scale = fontSizePx / source.emPx;
      const paddingX = input.paddingX ?? 6;
      const paddingY = input.paddingY ?? 2;

      frameIndex++;
      resource.atlas.beginFrame(frameIndex);

      const packInput: CellPackInput[] = [];
      const glyphInstance: GlyphInstance[] = [];
      for (const cell of input.cell) {
        packInput.push({
          x: cell.x,
          y: cell.y,
          width: cell.width,
          height: cell.height,
          bgColor: cell.bgColor,
          fgColor: cell.fgColor,
          // The glyph run buffer in the v0.1.0 packed layout is unused by the
          // instanced text pass — glyphs travel in their own instance buffer,
          // which is what lets one draw cover every cell's text at once.
          glyphs: [],
        });
        if (!cell.text) continue;
        const layout = layoutCellText({
          text: cell.text,
          source,
          x: cell.x,
          y: cell.y,
          width: cell.width,
          height: cell.height,
          paddingX,
          paddingY,
          scale,
          align: cell.align ?? 'left',
          verticalAlign: cell.verticalAlign ?? 'middle',
        });
        for (const g of buildGlyphInstance(layout, resource.atlas, {
          scale,
          color: cell.fgColor,
          distanceRangePx: source.distanceRangePx,
          clip: cell,
        })) {
          glyphInstance.push(g);
        }
      }

      const packed = packCells(packInput);
      const glyphBuffer = packGlyphInstance(glyphInstance);
      const plan = planDamage(
        input.damage ?? [{ x: 0, y: 0, width: viewport.width, height: viewport.height }],
        viewport,
        option.damageThreshold !== undefined
          ? { threshold: option.damageThreshold }
          : {},
      );

      const cellSlot = await resource.cellRing.acquire();
      const glyphSlot = await resource.glyphRing.acquire();
      resource.cellRing.upload(cellSlot, new Uint8Array(packed.cells));
      resource.glyphRing.upload(glyphSlot, new Uint8Array(glyphBuffer));
      resource.device.queue.writeBuffer(
        resource.uniformBuffer,
        0,
        new Float32Array([viewport.width, viewport.height, 0, 0]),
      );

      const encoder = resource.device.createCommandEncoder({
        label: `onegrid-frame-${frameIndex}`,
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: resource.context.getCurrentTexture().createView(),
            // A scissored frame must PRESERVE what is outside the scissor, so
            // it loads. A full-frame redraw clears, which is measurably faster
            // than loading on tiled GPUs because the tile never reads back.
            loadOp: plan.mode === 'full' ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      const report = encodeGridFrame({
        pass,
        plan,
        cellPipeline: resource.cellPipeline,
        glyphPipeline: resource.glyphPipeline,
        cellBindGroup: resource.cellBindGroup,
        glyphBindGroup: resource.glyphBindGroup,
        cellBuffer: cellSlot.buffer,
        cellCount: packed.cellCount,
        glyphBuffer: glyphSlot.buffer,
        glyphCount: glyphInstance.length,
      });
      resource.device.queue.submit([encoder.finish()]);
      resource.cellRing.markSubmitted(cellSlot);
      resource.glyphRing.markSubmitted(glyphSlot);

      return {
        ...report,
        rendered: true,
        skipReason: null,
        coverage: plan.coverage,
        threshold: plan.threshold,
        atlasStat: resource.atlas.stat(),
        cellRingStat: resource.cellRing.stat(),
        glyphRingStat: resource.glyphRing.stat(),
      };
    },

    dispose(): void {
      if (state === 'disposed') return;
      teardown(true);
      notify('disposed', 'renderer disposed by host');
    },
  };

  return { ok: true, renderer };
}

/**
 * Real device acquisition. Kept out of the main flow so the renderer has no
 * hard dependency on a browser global: every test path injects instead.
 */
async function defaultDeviceAcquisition(): Promise<RenderDevice> {
  const gpu = (globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined)
    ?.gpu;
  if (!gpu) throw new Error('[OG_WEBGPU_UNAVAILABLE] navigator.gpu missing');
  const adapter = await gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) throw new Error('[OG_WEBGPU_NO_ADAPTER] no compatible adapter');
  const device = await adapter.requestDevice();
  return device as unknown as RenderDevice;
}
