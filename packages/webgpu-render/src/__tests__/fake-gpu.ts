// =============================================================================
// A recording fake GPUDevice / GPUQueue / GPUBuffer.
//
// There is no GPU in CI, so nothing here talks to one. Instead the fake records
// every command the renderer issues and the tests assert on that command
// stream: which sub-rect was uploaded, which scissor rect was set, how many
// instances were drawn, which buffer was written. That is a real assertion
// about behaviour — a wrong upload origin or a wrong instance count fails here
// exactly as it would on hardware.
//
// What this CANNOT test, stated plainly: whether the WGSL compiles, whether the
// pipeline's vertex attribute layout matches the shader's struct, and what the
// rendered pixels look like. Those need a GPU (or a Dawn/wgpu native harness)
// and are out of scope for this package's unit tests.
// =============================================================================

export interface RecordedCall {
  readonly kind: string;
  readonly arg: Record<string, unknown>;
}

export interface FakeGpuHarness {
  readonly device: any;
  readonly log: RecordedCall[];
  /** Calls of one kind, in order. */
  callOf(kind: string): RecordedCall[];
  /** Settle every outstanding onSubmittedWorkDone promise. */
  completeWork(): Promise<void>;
  /** Fire device.lost. */
  loseDevice(message?: string): void;
  readonly createdBufferCount: () => number;
  readonly destroyedBufferCount: () => number;
}

export interface FakeGpuOption {
  /** Fail the Nth createTexture call, simulating an OOM on re-acquisition. */
  readonly failTextureAt?: number;
}

export function createFakeGpu(option: FakeGpuOption = {}): FakeGpuHarness {
  const log: RecordedCall[] = [];
  const record = (kind: string, arg: Record<string, unknown> = {}): void => {
    log.push({ kind, arg });
  };

  let createdBuffer = 0;
  let destroyedBuffer = 0;
  let textureCount = 0;
  const pendingWork: Array<() => void> = [];
  let loseDevice: (info: { reason: string; message: string }) => void = () => {
    /* replaced below */
  };
  const lost = new Promise<{ reason: string; message: string }>((resolve) => {
    loseDevice = resolve;
  });

  const makeBuffer = (descriptor: Record<string, unknown>): any => {
    createdBuffer++;
    record('createBuffer', descriptor);
    return {
      label: descriptor['label'],
      size: descriptor['size'],
      usage: descriptor['usage'],
      destroy(): void {
        destroyedBuffer++;
        record('buffer.destroy', { label: descriptor['label'] });
      },
    };
  };

  const queue = {
    writeBuffer(
      buffer: any,
      offset: number,
      data: ArrayBufferView | ArrayBufferLike,
    ): void {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      record('writeBuffer', {
        label: buffer.label,
        offset,
        byteLength: view.byteLength,
        byte: view.slice(0, Math.min(view.byteLength, 256)),
      });
    },
    writeTexture(
      destination: { texture: any; origin?: { x: number; y: number } },
      data: ArrayBufferView | ArrayBufferLike,
      dataLayout: { bytesPerRow: number; rowsPerImage: number },
      size: { width: number; height: number },
    ): void {
      record('writeTexture', {
        textureLabel: destination.texture?.label,
        originX: destination.origin?.x ?? 0,
        originY: destination.origin?.y ?? 0,
        bytesPerRow: dataLayout.bytesPerRow,
        rowsPerImage: dataLayout.rowsPerImage,
        width: size.width,
        height: size.height,
        byteLength: ArrayBuffer.isView(data)
          ? data.byteLength
          : (data as ArrayBuffer).byteLength,
      });
    },
    submit(commandBuffer: readonly unknown[]): void {
      record('submit', { count: commandBuffer.length });
    },
    onSubmittedWorkDone(): Promise<undefined> {
      return new Promise<undefined>((resolve) => {
        pendingWork.push(() => resolve(undefined));
      });
    },
  };

  const device: any = {
    queue,
    lost,
    createBuffer: makeBuffer,
    createTexture(descriptor: Record<string, unknown>): any {
      textureCount++;
      if (option.failTextureAt === textureCount) {
        throw new Error('fake OOM creating texture');
      }
      record('createTexture', descriptor);
      return {
        label: descriptor['label'],
        createView(): any {
          record('texture.createView', { label: descriptor['label'] });
          return { label: `${String(descriptor['label'])}-view` };
        },
        destroy(): void {
          record('texture.destroy', { label: descriptor['label'] });
        },
      };
    },
    createSampler(descriptor: Record<string, unknown> = {}): any {
      record('createSampler', descriptor);
      return { label: 'fake-sampler' };
    },
    createShaderModule(descriptor: Record<string, unknown>): any {
      record('createShaderModule', {
        label: descriptor['label'],
        codeLength: String(descriptor['code']).length,
      });
      return { label: descriptor['label'] };
    },
    createRenderPipeline(descriptor: any): any {
      record('createRenderPipeline', {
        label: descriptor.label,
        arrayStride: descriptor.vertex?.buffers?.[0]?.arrayStride,
        stepMode: descriptor.vertex?.buffers?.[0]?.stepMode,
        attributeCount: descriptor.vertex?.buffers?.[0]?.attributes?.length,
        entryPoint: descriptor.vertex?.entryPoint,
      });
      return {
        label: descriptor.label,
        getBindGroupLayout(index: number): any {
          return { label: `${String(descriptor.label)}-layout-${index}` };
        },
      };
    },
    createBindGroup(descriptor: any): any {
      record('createBindGroup', {
        layout: descriptor.layout?.label,
        entryCount: descriptor.entries?.length,
      });
      return { label: `${String(descriptor.layout?.label)}-group` };
    },
    createCommandEncoder(descriptor: Record<string, unknown> = {}): any {
      record('createCommandEncoder', { label: descriptor['label'] });
      return {
        beginRenderPass(passDescriptor: any): any {
          record('beginRenderPass', {
            loadOp: passDescriptor.colorAttachments?.[0]?.loadOp,
            storeOp: passDescriptor.colorAttachments?.[0]?.storeOp,
          });
          return {
            setPipeline(pipeline: any): void {
              record('setPipeline', { label: pipeline.label });
            },
            setBindGroup(index: number, group: any): void {
              record('setBindGroup', { index, label: group.label });
            },
            setVertexBuffer(slot: number, buffer: any): void {
              record('setVertexBuffer', { slot, label: buffer.label });
            },
            setScissorRect(
              x: number,
              y: number,
              width: number,
              height: number,
            ): void {
              record('setScissorRect', { x, y, width, height });
            },
            draw(
              vertexCount: number,
              instanceCount?: number,
            ): void {
              record('draw', { vertexCount, instanceCount });
            },
            end(): void {
              record('endPass', {});
            },
          };
        },
        finish(): any {
          record('finishEncoder', {});
          return { label: 'fake-command-buffer' };
        },
      };
    },
    destroy(): void {
      record('device.destroy', {});
    },
  };

  return {
    device,
    log,
    callOf: (kind) => log.filter((c) => c.kind === kind),
    async completeWork(): Promise<void> {
      const settle = pendingWork.splice(0, pendingWork.length);
      for (const resolve of settle) resolve();
      // Two ticks: one for the fence, one for the .then that frees the slot.
      await Promise.resolve();
      await Promise.resolve();
    },
    loseDevice(message = 'fake device loss'): void {
      loseDevice({ reason: 'unknown', message });
    },
    createdBufferCount: () => createdBuffer,
    destroyedBufferCount: () => destroyedBuffer,
  };
}

/** A canvas whose `getContext('webgpu')` hands back a recording context. */
export function createFakeCanvas(
  width = 800,
  height = 600,
): { canvas: any; log: RecordedCall[] } {
  const log: RecordedCall[] = [];
  let currentTexture = 0;
  const context = {
    configure(configuration: Record<string, unknown>): void {
      log.push({ kind: 'configure', arg: { format: configuration['format'] } });
    },
    unconfigure(): void {
      log.push({ kind: 'unconfigure', arg: {} });
    },
    getCurrentTexture(): any {
      currentTexture++;
      return {
        label: `swapchain-${currentTexture}`,
        createView: () => ({ label: `swapchain-${currentTexture}-view` }),
      };
    },
  };
  return {
    canvas: {
      width,
      height,
      getContext: (id: string) => (id === 'webgpu' ? context : null),
    },
    log,
  };
}

/**
 * A deterministic GlyphSource: every glyph is a solid square whose size and
 * advance derive from the code point, so packing tests can force a known
 * sequence of shelf allocations without depending on a font.
 */
export function createFakeGlyphSource(option: {
  readonly glyphSize?: (codePoint: number) => { width: number; height: number };
  readonly advance?: number;
  readonly kern?: (left: number, right: number) => number;
  readonly noInk?: readonly number[];
} = {}): any {
  const glyphSize =
    option.glyphSize ?? (() => ({ width: 10, height: 10 }));
  const advance = option.advance ?? 10;
  const noInk = new Set(option.noInk ?? [32]);
  return {
    fontFamily: 'fake',
    emPx: 48,
    ascentPx: 36,
    descentPx: 12,
    lineHeightPx: 58,
    distanceRangePx: 6,
    advanceOf: () => advance,
    kernOf: option.kern ?? (() => 0),
    rasterize(codePoint: number): any {
      if (noInk.has(codePoint)) return null;
      const { width, height } = glyphSize(codePoint);
      return {
        metric: {
          codePoint,
          advance,
          bearingX: 0,
          bearingY: height,
          width,
          height,
        },
        bitmap: {
          width,
          height,
          pixel: new Uint8Array(width * height * 4).fill(200),
        },
      };
    },
  };
}
