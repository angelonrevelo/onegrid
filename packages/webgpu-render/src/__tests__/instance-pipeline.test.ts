import { describe, it, expect } from 'vitest';
import {
  buildInstancePipeline,
  createInstanceRing,
  packGlyphInstance,
  BUFFER_USAGE_COPY_DST,
  BUFFER_USAGE_VERTEX,
  CELL_INSTANCE_WGSL,
  GLYPH_INSTANCE_STRIDE,
  GLYPH_INSTANCE_WGSL,
  type GlyphInstance,
} from '../instance-pipeline.js';
import { CELL_STRIDE, packRgba } from '../vertex-buffer.js';
import { createFakeGpu } from './fake-gpu.js';

function glyph(override: Partial<GlyphInstance> = {}): GlyphInstance {
  return {
    x: 10,
    y: 20,
    width: 8,
    height: 12,
    u0: 0.25,
    v0: 0.5,
    u1: 0.375,
    v1: 0.75,
    color: packRgba(0x11, 0x22, 0x33, 0xff),
    pxRange: 3,
    ...override,
  };
}

describe('packGlyphInstance', () => {
  it('writes each field at its documented offset', () => {
    const view = new DataView(packGlyphInstance([glyph()]));
    expect(view.getFloat32(0, true)).toBe(10);
    expect(view.getFloat32(4, true)).toBe(20);
    expect(view.getFloat32(8, true)).toBe(8);
    expect(view.getFloat32(12, true)).toBe(12);
    expect(view.getFloat32(16, true)).toBe(0.25);
    expect(view.getFloat32(20, true)).toBe(0.5);
    expect(view.getFloat32(24, true)).toBe(0.375);
    expect(view.getFloat32(28, true)).toBe(0.75);
    expect(view.getUint32(32, true)).toBe(0x112233ff);
    expect(view.getFloat32(36, true)).toBe(3);
  });

  it('emits GLYPH_INSTANCE_STRIDE bytes per instance', () => {
    const buffer = packGlyphInstance([glyph(), glyph({ x: 40 }), glyph({ x: 80 })]);
    expect(buffer.byteLength).toBe(GLYPH_INSTANCE_STRIDE * 3);
    expect(new DataView(buffer).getFloat32(GLYPH_INSTANCE_STRIDE, true)).toBe(40);
  });

  it('packs an empty list into an empty buffer', () => {
    expect(packGlyphInstance([]).byteLength).toBe(0);
  });
});

describe('createInstanceRing', () => {
  it('allocates `depth` buffers rounded up to a power-of-two capacity', () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 100,
      depth: 3,
    });
    expect(harness.createdBufferCount()).toBe(3);
    expect(ring.capacityByte).toBe(128 * CELL_STRIDE);
    const created = harness.callOf('createBuffer');
    expect(created[0]!.arg['size']).toBe(128 * CELL_STRIDE);
    expect(created[0]!.arg['usage']).toBe(BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST);
  });

  it('hands out a different slot while the previous one is in flight', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 4,
      depth: 3,
    });
    const first = await ring.acquire();
    ring.markSubmitted(first);
    const second = await ring.acquire();
    ring.markSubmitted(second);
    expect(second.index).not.toBe(first.index);
    expect(ring.stat().inFlightCount).toBe(2);
  });

  it('recycles a slot once the queue reports its work done', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 4,
      depth: 2,
    });
    const first = await ring.acquire();
    ring.markSubmitted(first);
    await harness.completeWork();
    expect(ring.stat().inFlightCount).toBe(0);
    const again = await ring.acquire();
    // Round-robin, so the next acquire takes slot 1 and the ring never grew.
    expect(ring.stat().growCount).toBe(0);
    expect(again.index).toBe(1);
  });

  it('grows rather than blocking when every slot is in flight', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 4,
      depth: 2,
      maxDepth: 4,
    });
    for (let i = 0; i < 4; i++) ring.markSubmitted(await ring.acquire());
    expect(ring.stat().depth).toBe(4);
    expect(ring.stat().growCount).toBe(2);
    expect(ring.stat().stallCount).toBe(0);
    expect(harness.createdBufferCount()).toBe(4);
  });

  it('stalls, and counts the stall, only when growth is exhausted', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 4,
      depth: 1,
      maxDepth: 1,
    });
    ring.markSubmitted(await ring.acquire());
    const pending = ring.acquire();
    await harness.completeWork();
    const recycled = await pending;
    expect(recycled.index).toBe(0);
    expect(ring.stat().stallCount).toBe(1);
  });

  it('uploads through writeBuffer and reports the byte count', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 8,
      depth: 1,
      label: 'test-ring',
    });
    const slot = await ring.acquire();
    const written = ring.upload(slot, new Uint8Array(CELL_STRIDE * 2));
    expect(written).toBe(CELL_STRIDE * 2);
    const call = harness.callOf('writeBuffer');
    expect(call).toHaveLength(1);
    expect(call[0]!.arg['label']).toBe('test-ring-0');
    expect(call[0]!.arg['offset']).toBe(0);
    expect(ring.stat().uploadByteTotal).toBe(CELL_STRIDE * 2);
  });

  it('refuses an upload larger than the slot rather than corrupting memory', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 1,
      depth: 1,
    });
    const slot = await ring.acquire();
    expect(() => ring.upload(slot, new Uint8Array(CELL_STRIDE * 4))).toThrow(
      /OG_RING_OVERFLOW/,
    );
  });

  it('destroys every buffer and refuses further acquisition', async () => {
    const harness = createFakeGpu();
    const ring = createInstanceRing({
      device: harness.device,
      instanceCapacity: 4,
      depth: 3,
    });
    ring.destroy();
    expect(harness.destroyedBufferCount()).toBe(3);
    await expect(ring.acquire()).rejects.toThrow(/OG_RING_DESTROYED/);
  });
});

describe('buildInstancePipeline', () => {
  it('builds one instanced pipeline per pass with the documented strides', () => {
    const harness = createFakeGpu();
    buildInstancePipeline(harness.device, 'bgra8unorm');
    const pipeline = harness.callOf('createRenderPipeline');
    expect(pipeline).toHaveLength(2);
    expect(pipeline[0]!.arg).toMatchObject({
      label: 'onegrid-cell-pipeline',
      arrayStride: CELL_STRIDE,
      stepMode: 'instance',
      attributeCount: 3,
      entryPoint: 'vs_cell',
    });
    expect(pipeline[1]!.arg).toMatchObject({
      label: 'onegrid-glyph-pipeline',
      arrayStride: GLYPH_INSTANCE_STRIDE,
      stepMode: 'instance',
      attributeCount: 6,
      entryPoint: 'vs_glyph',
    });
  });

  it('compiles one shader module per pass', () => {
    const harness = createFakeGpu();
    buildInstancePipeline(harness.device, 'rgba8unorm');
    expect(harness.callOf('createShaderModule').map((c) => c.arg['label'])).toEqual([
      'onegrid-cell-instance',
      'onegrid-glyph-instance',
    ]);
  });

  it('embeds the MSDF reconstruction in the glyph shader only', () => {
    expect(GLYPH_INSTANCE_WGSL).toContain('msdf_alpha');
    expect(GLYPH_INSTANCE_WGSL).toContain('textureSample');
    expect(CELL_INSTANCE_WGSL).not.toContain('msdf_alpha');
  });
});
