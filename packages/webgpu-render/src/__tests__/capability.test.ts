import { describe, it, expect } from 'vitest';
import {
  detectWebGpu,
  describeCapability,
  DEFAULT_WEBGPU_REQUIREMENT,
  type AdapterLike,
  type GpuLike,
} from '../capability.js';

function goodAdapter(overrideLimit: Record<string, number> = {}): AdapterLike {
  return {
    features: new Set(['shader-f16', 'timestamp-query']),
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxVertexBuffers: 8,
      maxBindGroups: 4,
      maxVertexAttributes: 16,
      ...overrideLimit,
    },
    info: { vendor: 'nvidia', architecture: 'ada', description: 'RTX 4070' },
    isFallbackAdapter: false,
  };
}

function gpuWith(adapter: AdapterLike | null): GpuLike {
  return {
    requestAdapter: () => Promise.resolve(adapter),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

describe('detectWebGpu', () => {
  it('reports supported with the limits it actually queried', async () => {
    const capability = await detectWebGpu({ gpu: gpuWith(goodAdapter()) });
    expect(capability.supported).toBe(true);
    expect(capability.blocker).toEqual([]);
    expect(capability.limit).toEqual({
      maxTextureDimension2d: 8192,
      maxBufferByte: 268435456,
      maxVertexBuffer: 8,
      maxBindGroup: 4,
      maxVertexAttribute: 16,
    });
    expect(capability.adapter?.description).toBe('RTX 4070');
    expect(capability.preferredCanvasFormat).toBe('bgra8unorm');
    expect(capability.feature).toEqual(['shader-f16', 'timestamp-query']);
  });

  it('refuses when navigator.gpu is missing, without throwing', async () => {
    const capability = await detectWebGpu({ gpu: undefined as never });
    expect(capability.supported).toBe(false);
    expect(capability.blocker).toEqual(['no-navigator-gpu']);
    expect(capability.adapter).toBeNull();
  });

  it('refuses when requestAdapter resolves null', async () => {
    const capability = await detectWebGpu({ gpu: gpuWith(null) });
    expect(capability.supported).toBe(false);
    expect(capability.blocker).toEqual(['no-adapter']);
  });

  it('refuses when requestAdapter throws, and keeps the message', async () => {
    const capability = await detectWebGpu({
      gpu: { requestAdapter: () => Promise.reject(new Error('gpu process died')) },
    });
    expect(capability.supported).toBe(false);
    expect(capability.blocker).toEqual(['adapter-error']);
    expect(capability.detail[0]).toContain('gpu process died');
  });

  it('refuses an adapter whose texture limit cannot hold the atlas', async () => {
    const capability = await detectWebGpu({
      gpu: gpuWith(goodAdapter({ maxTextureDimension2D: 1024 })),
    });
    expect(capability.supported).toBe(false);
    expect(capability.blocker).toEqual(['limit-below-requirement']);
    expect(capability.detail[0]).toContain('maxTextureDimension2D=1024');
    // The report still carries the adapter identity so the host can log it.
    expect(capability.adapter?.vendor).toBe('nvidia');
  });

  it('collects several limit failures under one blocker', async () => {
    const capability = await detectWebGpu({
      gpu: gpuWith(
        goodAdapter({ maxTextureDimension2D: 512, maxBufferSize: 1024, maxVertexBuffers: 0 }),
      ),
    });
    expect(capability.blocker).toEqual(['limit-below-requirement']);
    expect(capability.detail).toHaveLength(3);
  });

  it('reports a missing required feature by name', async () => {
    const capability = await detectWebGpu({
      gpu: gpuWith(goodAdapter()),
      requirement: { requiredFeature: ['float32-filterable', 'shader-f16'] },
    });
    expect(capability.supported).toBe(false);
    expect(capability.blocker).toEqual(['missing-feature']);
    expect(capability.missingFeature).toEqual(['float32-filterable']);
  });

  it('treats an absent limit as zero rather than as passing', async () => {
    const capability = await detectWebGpu({
      gpu: gpuWith({ features: new Set<string>(), limits: {}, info: {} }),
    });
    expect(capability.supported).toBe(false);
    expect(capability.limit?.maxTextureDimension2d).toBe(0);
  });

  it('honours a relaxed requirement', async () => {
    const capability = await detectWebGpu({
      gpu: gpuWith(goodAdapter({ maxTextureDimension2D: 1024 })),
      requirement: { minTextureDimension2d: 1024 },
    });
    expect(capability.supported).toBe(true);
  });

  it('ships a requirement the shipped pipelines were written against', () => {
    expect(DEFAULT_WEBGPU_REQUIREMENT.minTextureDimension2d).toBe(2048);
    expect(DEFAULT_WEBGPU_REQUIREMENT.requiredFeature).toEqual([]);
  });
});

describe('describeCapability', () => {
  it('names the adapter when supported', async () => {
    const capability = await detectWebGpu({ gpu: gpuWith(goodAdapter()) });
    expect(describeCapability(capability)).toContain('ready on RTX 4070');
  });

  it('states that Canvas-2D stays authoritative when unsupported', async () => {
    const capability = await detectWebGpu({ gpu: gpuWith(null) });
    expect(describeCapability(capability)).toContain(
      'Canvas-2D renderer stays authoritative',
    );
  });
});
