// =============================================================================
// Per-cell instanced pipeline + ring-buffered staging.
//
// THE DRAW MODEL. Canvas-2D pays one fillRect and one fillText per cell; at
// 40,000 visible cells that is 80,000 driver calls per frame and it is why the
// canvas renderer tops out. Here every visible cell is one INSTANCE of a unit
// quad, and the whole grid is two draws: draw(6, cellCount) for the cell
// backgrounds and draw(6, glyphCount) for the text. The vertex shader expands
// vertex_index 0..5 into the quad corners, so there is no index buffer and no
// per-cell vertex data beyond the instance record itself.
//
// THE RING. A GPUBuffer that the GPU is still reading cannot be rewritten. The
// naive loop — write the instance buffer, submit, write it again next frame —
// is correct only because the driver silently renames the buffer or, worse,
// stalls the CPU until the previous frame retires. Either way the cost is
// invisible until it is 6 ms. So staging is explicitly ring-buffered: N buffers
// in rotation, each marked in-flight when its frame is submitted and released
// when queue.onSubmittedWorkDone() settles for that submission. acquire()
// returns a buffer nobody is reading.
//
// Depth 3 is the default because it covers the deepest pipelining a browser
// actually runs (CPU frame N, GPU frame N-1, present N-2). If all three are
// somehow in flight, the ring GROWS rather than blocking, up to maxDepth — a
// grow costs one allocation, whereas awaiting a fence costs a frame. Only when
// growth is exhausted do we await, and that await is counted in stat().stall
// so a host can see the ring is too shallow instead of guessing at a stutter.
// =============================================================================

import { CELL_STRIDE } from './vertex-buffer.js';
import { MSDF_WGSL } from './msdf.js';

// GPUBufferUsage / GPUTextureUsage / GPUShaderStage are browser globals that do
// not exist in Node, so the tests would throw on import if we referenced them.
// The values are fixed by the WebGPU spec; naming them here keeps the module
// importable everywhere.
/** GPUBufferUsage.COPY_DST */
export const BUFFER_USAGE_COPY_DST = 0x0008;
/** GPUBufferUsage.VERTEX */
export const BUFFER_USAGE_VERTEX = 0x0020;
/** GPUBufferUsage.UNIFORM */
export const BUFFER_USAGE_UNIFORM = 0x0040;
/** GPUTextureUsage.COPY_DST */
export const TEXTURE_USAGE_COPY_DST = 0x0002;
/** GPUTextureUsage.TEXTURE_BINDING */
export const TEXTURE_USAGE_TEXTURE_BINDING = 0x0004;
/** GPUTextureUsage.RENDER_ATTACHMENT */
export const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x0010;

/** Bytes per glyph instance: rect (16) + uv rect (16) + colour (4) + range (4). */
export const GLYPH_INSTANCE_STRIDE = 40;

/** One glyph quad, in viewport pixels and atlas UV. */
export interface GlyphInstance {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Packed 0xRRGGBBAA, same convention as packRgba. */
  readonly color: number;
  /** screen_px_range for this glyph at its rendered size. */
  readonly pxRange: number;
}

/**
 * Pack glyph quads into the instance buffer layout. Kept separate from
 * packCells because the two passes have different strides and are uploaded to
 * different ring slots — sharing a buffer would mean re-uploading the cell
 * backgrounds every time only the text changed.
 */
export function packGlyphInstance(
  instance: readonly GlyphInstance[],
): ArrayBuffer {
  const buffer = new ArrayBuffer(GLYPH_INSTANCE_STRIDE * instance.length);
  const view = new DataView(buffer);
  for (let i = 0; i < instance.length; i++) {
    const g = instance[i]!;
    const o = i * GLYPH_INSTANCE_STRIDE;
    view.setFloat32(o + 0, g.x, true);
    view.setFloat32(o + 4, g.y, true);
    view.setFloat32(o + 8, g.width, true);
    view.setFloat32(o + 12, g.height, true);
    view.setFloat32(o + 16, g.u0, true);
    view.setFloat32(o + 20, g.v0, true);
    view.setFloat32(o + 24, g.u1, true);
    view.setFloat32(o + 28, g.v1, true);
    view.setUint32(o + 32, g.color >>> 0, true);
    view.setFloat32(o + 36, g.pxRange, true);
  }
  return buffer;
}

// -----------------------------------------------------------------------------
// Ring-buffered staging
// -----------------------------------------------------------------------------

/** The device surface the ring needs. A real GPUDevice satisfies it. */
export interface RingDevice {
  createBuffer(descriptor: {
    size: number;
    usage: number;
    label?: string;
  }): GPUBuffer;
  readonly queue: RingQueue;
}

export interface RingQueue {
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBufferLike,
    dataOffset?: number,
    size?: number,
  ): void;
  onSubmittedWorkDone(): Promise<undefined>;
}

export interface StagingSlot {
  readonly index: number;
  readonly buffer: GPUBuffer;
  readonly capacityByte: number;
}

export interface InstanceRingOption {
  readonly device: RingDevice;
  /** Instances the buffer must hold. Rounded up to a power of two so a slowly
   *  growing viewport does not reallocate on every resize tick. */
  readonly instanceCapacity: number;
  readonly byteStride?: number;
  readonly depth?: number;
  readonly maxDepth?: number;
  readonly label?: string;
  readonly usage?: number;
}

export interface RingStat {
  readonly depth: number;
  readonly inFlightCount: number;
  readonly acquireCount: number;
  /** Times acquire() had to await a fence. Non-zero means depth is too small. */
  readonly stallCount: number;
  readonly growCount: number;
  readonly uploadCount: number;
  readonly uploadByteTotal: number;
}

export interface InstanceRing {
  readonly byteStride: number;
  readonly capacityByte: number;
  /** Take a slot the GPU is not reading. */
  acquire(): Promise<StagingSlot>;
  /** Upload instance data into a slot. Returns bytes written. */
  upload(slot: StagingSlot, data: ArrayBufferView): number;
  /** Mark a slot submitted; it is released when the queue reports the work
   *  done. Call this exactly once per acquire, after queue.submit. */
  markSubmitted(slot: StagingSlot): void;
  stat(): RingStat;
  destroy(): void;
}

function nextPowerOfTwo(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

/** Create the staging ring. */
export function createInstanceRing(option: InstanceRingOption): InstanceRing {
  const byteStride = option.byteStride ?? CELL_STRIDE;
  const depth = Math.max(1, option.depth ?? 3);
  const maxDepth = Math.max(depth, option.maxDepth ?? depth * 2);
  const usage = option.usage ?? (BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST);
  const capacityByte =
    nextPowerOfTwo(Math.max(1, option.instanceCapacity)) * byteStride;
  const label = option.label ?? 'onegrid-instance-ring';

  const slot: StagingSlot[] = [];
  const inFlight = new Map<number, Promise<void>>();
  let cursor = 0;
  let acquireCount = 0;
  let stallCount = 0;
  let growCount = 0;
  let uploadCount = 0;
  let uploadByteTotal = 0;
  let destroyed = false;

  function addSlot(): StagingSlot {
    const created: StagingSlot = {
      index: slot.length,
      buffer: option.device.createBuffer({
        size: capacityByte,
        usage,
        label: `${label}-${slot.length}`,
      }),
      capacityByte,
    };
    slot.push(created);
    return created;
  }

  for (let i = 0; i < depth; i++) addSlot();

  return {
    byteStride,
    capacityByte,

    async acquire(): Promise<StagingSlot> {
      if (destroyed) throw new Error('[OG_RING_DESTROYED] ring already destroyed');
      acquireCount++;
      // Round-robin from the last used slot so a free slot is found in O(1) in
      // the steady state, rather than always re-testing slot 0.
      for (let i = 0; i < slot.length; i++) {
        const index = (cursor + i) % slot.length;
        if (!inFlight.has(index)) {
          cursor = (index + 1) % slot.length;
          return slot[index]!;
        }
      }
      if (slot.length < maxDepth) {
        growCount++;
        const grown = addSlot();
        cursor = (grown.index + 1) % slot.length;
        return grown;
      }
      // Every slot is in flight and the ring is at its ceiling. Awaiting is the
      // only correct move; it is counted so the host can see it happened.
      stallCount++;
      await Promise.race([...inFlight.values()]);
      for (let i = 0; i < slot.length; i++) {
        const index = (cursor + i) % slot.length;
        if (!inFlight.has(index)) {
          cursor = (index + 1) % slot.length;
          return slot[index]!;
        }
      }
      // Race settled but the release handler has not run yet; slot 0 is the
      // oldest submission, so it is the safest to reuse once its fence settled.
      return slot[0]!;
    },

    upload(target: StagingSlot, data: ArrayBufferView): number {
      if (data.byteLength > target.capacityByte) {
        throw new Error(
          `[OG_RING_OVERFLOW] ${data.byteLength} bytes into a ${target.capacityByte}-byte slot`,
        );
      }
      option.device.queue.writeBuffer(target.buffer, 0, data);
      uploadCount++;
      uploadByteTotal += data.byteLength;
      return data.byteLength;
    },

    markSubmitted(target: StagingSlot): void {
      const fence = option.device.queue.onSubmittedWorkDone().then(
        () => {
          inFlight.delete(target.index);
        },
        () => {
          // A rejected fence means the device died. Release anyway: the whole
          // ring is about to be torn down and holding the slot would make the
          // teardown path await a promise that will never settle.
          inFlight.delete(target.index);
        },
      );
      inFlight.set(target.index, fence);
    },

    stat(): RingStat {
      return {
        depth: slot.length,
        inFlightCount: inFlight.size,
        acquireCount,
        stallCount,
        growCount,
        uploadCount,
        uploadByteTotal,
      };
    },

    destroy(): void {
      destroyed = true;
      inFlight.clear();
      for (const s of slot) s.buffer.destroy();
      slot.length = 0;
    },
  };
}

// -----------------------------------------------------------------------------
// Pipelines
// -----------------------------------------------------------------------------

/** WGSL for the cell-background pass: one instanced quad per cell. */
export const CELL_INSTANCE_WGSL = `
struct Uniform {
  viewport: vec2f,
};
@group(0) @binding(0) var<uniform> u: Uniform;

struct CellIn {
  @location(0) rect_pos: vec2f,
  @location(1) rect_size: vec2f,
  @location(2) bg_color: u32,
  @builtin(vertex_index) vid: u32,
};

struct CellOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

fn unpack_rgba(v: u32) -> vec4f {
  return vec4f(
    f32((v >> 24u) & 0xffu) / 255.0,
    f32((v >> 16u) & 0xffu) / 255.0,
    f32((v >> 8u)  & 0xffu) / 255.0,
    f32( v         & 0xffu) / 255.0,
  );
}

fn quad_corner(vid: u32) -> vec2f {
  var corner = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  return corner[vid];
}

fn to_clip(px: vec2f, viewport: vec2f) -> vec4f {
  return vec4f(
    (px.x / viewport.x) * 2.0 - 1.0,
    1.0 - (px.y / viewport.y) * 2.0,
    0.0,
    1.0,
  );
}

@vertex
fn vs_cell(in: CellIn) -> CellOut {
  let px = in.rect_pos + quad_corner(in.vid) * in.rect_size;
  var out: CellOut;
  out.position = to_clip(px, u.viewport);
  out.color = unpack_rgba(in.bg_color);
  return out;
}

@fragment
fn fs_cell(in: CellOut) -> @location(0) vec4f {
  return in.color;
}
`.trim();

/** WGSL for the glyph pass: one instanced quad per glyph, MSDF-sampled. */
export const GLYPH_INSTANCE_WGSL = `
${MSDF_WGSL}

struct Uniform {
  viewport: vec2f,
};
@group(0) @binding(0) var<uniform> u: Uniform;
@group(0) @binding(1) var atlas_sampler: sampler;
@group(0) @binding(2) var atlas_texture: texture_2d<f32>;

struct GlyphIn {
  @location(0) rect_pos: vec2f,
  @location(1) rect_size: vec2f,
  @location(2) uv_min: vec2f,
  @location(3) uv_max: vec2f,
  @location(4) fg_color: u32,
  @location(5) px_range: f32,
  @builtin(vertex_index) vid: u32,
};

struct GlyphOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) px_range: f32,
};

fn unpack_rgba(v: u32) -> vec4f {
  return vec4f(
    f32((v >> 24u) & 0xffu) / 255.0,
    f32((v >> 16u) & 0xffu) / 255.0,
    f32((v >> 8u)  & 0xffu) / 255.0,
    f32( v         & 0xffu) / 255.0,
  );
}

fn quad_corner(vid: u32) -> vec2f {
  var corner = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  return corner[vid];
}

@vertex
fn vs_glyph(in: GlyphIn) -> GlyphOut {
  let corner = quad_corner(in.vid);
  let px = in.rect_pos + corner * in.rect_size;
  var out: GlyphOut;
  out.position = vec4f(
    (px.x / u.viewport.x) * 2.0 - 1.0,
    1.0 - (px.y / u.viewport.y) * 2.0,
    0.0,
    1.0,
  );
  out.uv = mix(in.uv_min, in.uv_max, corner);
  out.color = unpack_rgba(in.fg_color);
  out.px_range = in.px_range;
  return out;
}

@fragment
fn fs_glyph(in: GlyphOut) -> @location(0) vec4f {
  let sampled = textureSample(atlas_texture, atlas_sampler, in.uv);
  let alpha = msdf_alpha(msdf_distance(sampled.rgb), in.px_range);
  return vec4f(in.color.rgb * in.color.a * alpha, in.color.a * alpha);
}
`.trim();

/** The device surface pipeline construction needs. */
export interface PipelineDevice {
  createShaderModule(descriptor: { code: string; label?: string }): GPUShaderModule;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
}

export interface CellInstancePipeline {
  readonly cellPipeline: GPURenderPipeline;
  readonly glyphPipeline: GPURenderPipeline;
}

/**
 * Build both instanced pipelines against the given swap-chain format. The
 * glyph pass blends premultiplied because the MSDF fragment already multiplies
 * colour by coverage — blending straight alpha over a premultiplied source is
 * the classic cause of dark fringes around text.
 */
export function buildInstancePipeline(
  device: PipelineDevice,
  format: GPUTextureFormat,
): CellInstancePipeline {
  const cellModule = device.createShaderModule({
    code: CELL_INSTANCE_WGSL,
    label: 'onegrid-cell-instance',
  });
  const glyphModule = device.createShaderModule({
    code: GLYPH_INSTANCE_WGSL,
    label: 'onegrid-glyph-instance',
  });

  const blend: GPUBlendState = {
    color: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
    alpha: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    },
  };

  const cellPipeline = device.createRenderPipeline({
    label: 'onegrid-cell-pipeline',
    layout: 'auto',
    vertex: {
      module: cellModule,
      entryPoint: 'vs_cell',
      buffers: [
        {
          arrayStride: CELL_STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'uint32' },
          ],
        },
      ],
    },
    fragment: {
      module: cellModule,
      entryPoint: 'fs_cell',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const glyphPipeline = device.createRenderPipeline({
    label: 'onegrid-glyph-pipeline',
    layout: 'auto',
    vertex: {
      module: glyphModule,
      entryPoint: 'vs_glyph',
      buffers: [
        {
          arrayStride: GLYPH_INSTANCE_STRIDE,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32x2' },
            { shaderLocation: 3, offset: 24, format: 'float32x2' },
            { shaderLocation: 4, offset: 32, format: 'uint32' },
            { shaderLocation: 5, offset: 36, format: 'float32' },
          ],
        },
      ],
    },
    fragment: {
      module: glyphModule,
      entryPoint: 'fs_glyph',
      targets: [{ format, blend }],
    },
    primitive: { topology: 'triangle-list' },
  });

  return { cellPipeline, glyphPipeline };
}
