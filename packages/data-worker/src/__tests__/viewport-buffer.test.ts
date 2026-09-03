import { describe, it, expect, afterEach } from 'vitest';
import {
  ViewportBuffer,
  computeViewportLayout,
  isSharedMemoryAvailable,
  VIEWPORT_LAYOUT_CONSTANT,
  type ViewportColumnSpec,
  type ViewportFrame,
} from '../viewport-buffer.js';
import {
  createViewportPublisher,
  createViewportSubscriber,
  type ViewportPortLike,
} from '../viewport-transport.js';

// Node exposes SharedArrayBuffer but has no `crossOriginIsolated` — that is a
// document concept. `preferShared: true` is the documented escape hatch and is
// what lets these tests exercise the real shared path.
const SPEC: ReadonlyArray<ViewportColumnSpec> = [
  { id: 'id', kind: 'int32' },
  { id: 'price', kind: 'float64' },
  { id: 'name', kind: 'utf8', textBytePerRow: 24 },
];

function makeBuffer(capacityRow = 8): ViewportBuffer {
  return ViewportBuffer.create({ column: SPEC, capacityRow, preferShared: true });
}

function numericValue(frame: ViewportFrame, id: string): number[] {
  const column = frame.column.find((c) => c.id === id)!;
  return Array.from(column.value as Int32Array | Float64Array);
}

function textValue(frame: ViewportFrame, id: string): readonly string[] {
  const column = frame.column.find((c) => c.id === id)!;
  return column.value as ReadonlyArray<string>;
}

describe('computeViewportLayout', () => {
  it('places every region on an 8-byte boundary after the header + descriptors', () => {
    const layout = computeViewportLayout(SPEC, 100);
    expect(layout.headerByteLength).toBe(VIEWPORT_LAYOUT_CONSTANT.HEADER_BYTE_LENGTH);
    expect(layout.descriptorByteLength).toBe(
      VIEWPORT_LAYOUT_CONSTANT.DESCRIPTOR_BYTE_LENGTH,
    );
    const firstRegion = layout.column[0]!.dataByteOffset;
    expect(firstRegion).toBeGreaterThanOrEqual(64 + 32 * SPEC.length);
    for (const c of layout.column) {
      expect(c.dataByteOffset % 8).toBe(0);
      if (c.kind === 'utf8') expect(c.auxByteOffset % 8).toBe(0);
    }
  });

  it('sizes each column region from its kind and the capacity', () => {
    const layout = computeViewportLayout(SPEC, 100);
    const [id, price, name] = layout.column;
    expect(id!.dataByteLength).toBe(400); // 100 * 4
    expect(price!.dataByteLength).toBe(800); // 100 * 8
    expect(name!.dataByteLength).toBe(2400); // 100 * 24
    expect(name!.auxByteLength).toBe(408); // (100 + 1) * 4, aligned to 8
    expect(layout.byteLength).toBeGreaterThan(400 + 800 + 2400 + 408);
  });

  it('rejects a duplicate column id, a bad capacity and a bad text budget', () => {
    expect(() =>
      computeViewportLayout(
        [
          { id: 'a', kind: 'int32' },
          { id: 'a', kind: 'int32' },
        ],
        4,
      ),
    ).toThrow(/duplicate column id/);
    expect(() => computeViewportLayout(SPEC, 0)).toThrow(/positive integer/);
    expect(() =>
      computeViewportLayout([{ id: 'a', kind: 'utf8', textBytePerRow: 0 }], 4),
    ).toThrow(/textBytePerRow/);
  });
});

describe('ViewportBuffer round-trip', () => {
  it('round-trips int32 values including negatives', () => {
    const vb = makeBuffer();
    vb.write({
      rowOffset: 0,
      rowCount: 4,
      column: [{ id: 'id', value: new Int32Array([-2147483648, -1, 0, 2147483647]) }],
    });
    const frame = vb.readFrame()!;
    expect(numericValue(frame, 'id')).toEqual([-2147483648, -1, 0, 2147483647]);
  });

  it('round-trips float64 values at full precision', () => {
    const vb = makeBuffer();
    const value = [Math.PI, -0.5, 1e-300, Number.MAX_SAFE_INTEGER + 0.5];
    vb.write({ rowOffset: 0, rowCount: 4, column: [{ id: 'price', value }] });
    const frame = vb.readFrame()!;
    expect(numericValue(frame, 'price')).toEqual(value);
  });

  it('round-trips utf8 including empty strings, CJK, emoji and combining marks', () => {
    const vb = makeBuffer();
    const value = ['', 'ascii', '日本語テキスト', '🎉🎉 grid', 'é combined'];
    vb.write({ rowOffset: 0, rowCount: 5, column: [{ id: 'name', value }] });
    const frame = vb.readFrame()!;
    expect(textValue(frame, 'name')).toEqual(value);
  });

  it('round-trips all three kinds in one frame with the window metadata', () => {
    const vb = makeBuffer();
    vb.write({
      rowOffset: 1200,
      rowCount: 3,
      generation: 7,
      column: [
        { id: 'id', value: new Int32Array([10, 20, 30]) },
        { id: 'price', value: new Float64Array([1.5, 2.5, 3.5]) },
        { id: 'name', value: ['a', '', 'ç'] },
      ],
    });
    const frame = vb.readFrame()!;
    expect(frame.rowOffset).toBe(1200);
    expect(frame.rowCount).toBe(3);
    expect(frame.generation).toBe(7);
    expect(numericValue(frame, 'id')).toEqual([10, 20, 30]);
    expect(numericValue(frame, 'price')).toEqual([1.5, 2.5, 3.5]);
    expect(textValue(frame, 'name')).toEqual(['a', '', 'ç']);
  });

  it('returns a non-shared copy the caller can hold across frames', () => {
    const vb = makeBuffer();
    vb.write({ rowOffset: 0, rowCount: 2, column: [{ id: 'id', value: [1, 2] }] });
    const first = vb.readFrame()!;
    const held = numericValue(first, 'id');
    vb.write({ rowOffset: 0, rowCount: 2, column: [{ id: 'id', value: [9, 9] }] });
    expect(held).toEqual([1, 2]);
    expect(numericValue(vb.readFrame()!, 'id')).toEqual([9, 9]);
  });

  it('throws when the text arena overflows rather than truncating', () => {
    const vb = makeBuffer(2);
    // 2 rows * 24 bytes = 48-byte arena; these are 60 bytes together.
    expect(() =>
      vb.write({
        rowOffset: 0,
        rowCount: 2,
        column: [{ id: 'name', value: ['x'.repeat(30), 'y'.repeat(30)] }],
      }),
    ).toThrow(/OG_VIEWPORT_TEXT_OVERFLOW/);
  });

  it('throws when rowCount exceeds capacity, and when a column is short', () => {
    const vb = makeBuffer(4);
    expect(() =>
      vb.write({ rowOffset: 0, rowCount: 5, column: [{ id: 'id', value: [1, 2, 3, 4, 5] }] }),
    ).toThrow(/exceeds capacity/);
    expect(() =>
      vb.write({ rowOffset: 0, rowCount: 3, column: [{ id: 'id', value: [1] }] }),
    ).toThrow(/supplied 1 values for 3 rows/);
    expect(() =>
      vb.write({ rowOffset: 0, rowCount: 1, column: [{ id: 'nope', value: [1] }] }),
    ).toThrow(/unknown column/);
  });
});

describe('ViewportBuffer seqlock', () => {
  it('leaves the sequence even after a completed write and odd during one', () => {
    const vb = makeBuffer();
    expect(vb.sequence).toBe(0);
    vb.beginWrite();
    expect(vb.sequence % 2).toBe(1);
    vb.endWrite();
    expect(vb.sequence).toBe(2);
    expect(vb.sequence % 2).toBe(0);
  });

  it('refuses a second concurrent writer', () => {
    const vb = makeBuffer();
    vb.beginWrite();
    expect(() => vb.beginWrite()).toThrow(/only one writer|exactly one writer/);
    vb.endWrite();
  });

  it('endWrite is idempotent so a stray call cannot desync the counter', () => {
    const vb = makeBuffer();
    vb.write({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [1] }] });
    const seq = vb.sequence;
    vb.endWrite();
    vb.endWrite();
    expect(vb.sequence).toBe(seq);
  });

  it('never exposes a half-written frame: the reader gives up while seq is odd', () => {
    const vb = makeBuffer();
    vb.write({
      rowOffset: 0,
      rowCount: 4,
      column: [{ id: 'id', value: [1, 1, 1, 1] }],
    });
    // Drive the protocol by hand: take the lock, write only half the row,
    // and confirm the reader refuses the snapshot rather than returning the
    // 2/2 mixture that is sitting in memory right now.
    vb.beginWrite();
    vb.writePayload({ rowOffset: 0, rowCount: 4, column: [{ id: 'id', value: [2, 2, 1, 1] }] });
    expect(vb.readFrame({ maxRetry: 4 })).toBeNull();
    // Finish the write; now the frame is whole and readable.
    vb.writePayload({ rowOffset: 0, rowCount: 4, column: [{ id: 'id', value: [2, 2, 2, 2] }] });
    vb.endWrite();
    const frame = vb.readFrame()!;
    expect(numericValue(frame, 'id')).toEqual([2, 2, 2, 2]);
  });

  it('retries when a writer lands inside the copy, and returns a consistent frame', () => {
    const vb = makeBuffer();
    vb.write({ rowOffset: 0, rowCount: 4, column: [{ id: 'id', value: [1, 1, 1, 1] }] });
    let landed = false;
    const frame = vb.readFrame({
      maxRetry: 4,
      // Fires after the payload copy, before the trailing sequence read —
      // exactly the window the seqlock exists to detect.
      onPayloadCopied: () => {
        if (landed) return;
        landed = true;
        vb.write({ rowOffset: 0, rowCount: 4, column: [{ id: 'id', value: [2, 2, 2, 2] }] });
      },
    })!;
    expect(landed).toBe(true);
    expect(frame.retryCount).toBe(1);
    expect(numericValue(frame, 'id')).toEqual([2, 2, 2, 2]);
  });

  it('never observes a torn value across many interleaved writes', () => {
    const vb = makeBuffer();
    let generation = 1;
    vb.write({
      rowOffset: 0,
      rowCount: 4,
      generation,
      column: [
        { id: 'id', value: [1, 1, 1, 1] },
        { id: 'name', value: ['1', '1', '1', '1'] },
      ],
    });
    let nullCount = 0;
    for (let round = 0; round < 50; round++) {
      let interleaved = 0;
      const frame = vb.readFrame({
        maxRetry: 8,
        onPayloadCopied: () => {
          // Land a whole new frame under every one of the first two attempts.
          if (interleaved >= 2) return;
          interleaved++;
          generation++;
          const n = generation;
          vb.write({
            rowOffset: 0,
            rowCount: 4,
            generation: n,
            column: [
              { id: 'id', value: [n, n, n, n] },
              { id: 'name', value: [`${n}`, `${n}`, `${n}`, `${n}`] },
            ],
          });
        },
      });
      if (!frame) {
        nullCount++;
        continue;
      }
      // Every cell in the snapshot must belong to the same generation — a
      // torn read is exactly a row whose columns disagree.
      const id = numericValue(frame, 'id');
      const name = textValue(frame, 'name');
      expect(new Set(id).size).toBe(1);
      expect(new Set(name).size).toBe(1);
      expect(String(id[0])).toBe(name[0]);
      expect(id[0]).toBe(frame.generation);
    }
    expect(nullCount).toBe(0);
  });

  it('leaves the counter even when the payload write throws mid-frame', () => {
    const vb = makeBuffer(2);
    expect(() =>
      vb.write({
        rowOffset: 0,
        rowCount: 2,
        column: [{ id: 'name', value: ['z'.repeat(40), 'z'.repeat(40)] }],
      }),
    ).toThrow();
    expect(vb.sequence % 2).toBe(0);
    // A reader must still make progress rather than spin on an odd counter.
    expect(vb.readFrame()).not.toBeNull();
  });
});

describe('ViewportBuffer.attach', () => {
  it('lets a second instance read what the first wrote through the same memory', () => {
    const writer = makeBuffer(16);
    const reader = ViewportBuffer.attach(writer.buffer, SPEC, 16);
    writer.write({
      rowOffset: 5,
      rowCount: 2,
      generation: 3,
      column: [
        { id: 'id', value: [7, 8] },
        { id: 'price', value: [0.25, 0.75] },
        { id: 'name', value: ['añ', '🙂'] },
      ],
    });
    const frame = reader.readFrame()!;
    expect(frame.rowOffset).toBe(5);
    expect(frame.generation).toBe(3);
    expect(numericValue(frame, 'id')).toEqual([7, 8]);
    expect(numericValue(frame, 'price')).toEqual([0.25, 0.75]);
    expect(textValue(frame, 'name')).toEqual(['añ', '🙂']);
    expect(reader.sequence).toBe(writer.sequence);
  });

  it('rejects a foreign buffer, a wrong capacity and a wrong column kind', () => {
    const writer = makeBuffer(16);
    expect(() => ViewportBuffer.attach(new ArrayBuffer(4096), SPEC, 16)).toThrow(
      /bad magic/,
    );
    expect(() => ViewportBuffer.attach(writer.buffer, SPEC, 8)).toThrow(
      /buffer capacity 16, spec capacity 8/,
    );
    // Declaring `price` as int32 keeps the layout small enough to pass the
    // size check, so the descriptor kind check is what has to catch it.
    const wrongKind: ReadonlyArray<ViewportColumnSpec> = [
      { id: 'id', kind: 'int32' },
      { id: 'price', kind: 'int32' },
      { id: 'name', kind: 'utf8', textBytePerRow: 24 },
    ];
    expect(() => ViewportBuffer.attach(writer.buffer, wrongKind, 16)).toThrow(
      /is float64 in the buffer/,
    );
    expect(() => ViewportBuffer.attach(new ArrayBuffer(8), SPEC, 16)).toThrow(
      /layout needs/,
    );
  });
});

describe('isSharedMemoryAvailable', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'crossOriginIsolated', original);
    else delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  });

  it('is false without cross-origin isolation even though the constructor exists', () => {
    expect(typeof SharedArrayBuffer).toBe('function');
    delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    expect(isSharedMemoryAvailable()).toBe(false);
  });

  it('is true only when COOP/COEP have flipped crossOriginIsolated on', () => {
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: true,
      configurable: true,
    });
    expect(isSharedMemoryAvailable()).toBe(true);
  });

  it('falls back to a private ArrayBuffer when shared memory is unavailable', () => {
    delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    const vb = ViewportBuffer.create({ column: SPEC, capacityRow: 4 });
    expect(vb.isShared).toBe(false);
    expect(vb.buffer).toBeInstanceOf(ArrayBuffer);
    // The layout and the seqlock still work — it is only cross-thread
    // visibility that is lost.
    vb.write({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [42] }] });
    expect(numericValue(vb.readFrame()!, 'id')).toEqual([42]);
  });
});

describe('ViewportBuffer blocking helpers', () => {
  it('waitForChangeAsync resolves rather than blocking the caller', async () => {
    const vb = makeBuffer();
    const seq = vb.sequence;
    const pending = vb.waitForChangeAsync(seq, 50);
    vb.write({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [1] }] });
    await expect(pending).resolves.toMatch(/ok|timed-out/);
  });

  it('waitForChange returns immediately when the sequence already moved on', () => {
    const vb = makeBuffer();
    vb.write({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [1] }] });
    // Waiting on a stale value is a not-equal, which returns without blocking.
    expect(vb.waitForChange(0, 5)).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

function makePort(): { a: ViewportPortLike; b: ViewportPortLike; count: () => number } {
  const listenerA = new Set<(e: { data: unknown }) => void>();
  const listenerB = new Set<(e: { data: unknown }) => void>();
  const pending: unknown[] = [];
  let messageCount = 0;
  const a: ViewportPortLike = {
    postMessage: (message) => {
      messageCount++;
      if (listenerB.size === 0) pending.push(message);
      else listenerB.forEach((fn) => fn({ data: message }));
    },
    addEventListener: (_t, l) => {
      listenerA.add(l);
    },
    removeEventListener: (_t, l) => listenerA.delete(l),
  };
  const b: ViewportPortLike = {
    postMessage: (message) => {
      messageCount++;
      listenerA.forEach((fn) => fn({ data: message }));
    },
    addEventListener: (_t, l) => {
      listenerB.add(l);
      // Replay whatever the publisher sent before we attached — a real Worker
      // queues messages the same way.
      while (pending.length > 0) l({ data: pending.shift() });
    },
    removeEventListener: (_t, l) => listenerB.delete(l),
  };
  return { a, b, count: () => messageCount };
}

describe('viewport transport', () => {
  it('shared mode hands over the buffer once and posts nothing per frame', () => {
    const { a, b, count } = makePort();
    const publisher = createViewportPublisher({
      port: a,
      column: SPEC,
      capacityRow: 8,
      mode: 'shared',
    });
    const subscriber = createViewportSubscriber({ port: b });
    expect(publisher.mode).toBe('shared');
    expect(subscriber.mode).toBe('shared');
    const afterHandshake = count();
    for (let i = 0; i < 10; i++) {
      publisher.publish({
        rowOffset: i,
        rowCount: 1,
        column: [
          { id: 'id', value: [i] },
          { id: 'name', value: [`row ${i}`] },
        ],
      });
    }
    expect(count()).toBe(afterHandshake); // zero messages for ten frames
    const frame = subscriber.poll()!;
    expect(frame.rowOffset).toBe(9);
    expect(textValue(frame, 'name')).toEqual(['row 9']);
    publisher.dispose();
    subscriber.dispose();
  });

  it('postMessage mode delivers the identical frame shape, one message per frame', () => {
    const { a, b, count } = makePort();
    const publisher = createViewportPublisher({
      port: a,
      column: SPEC,
      capacityRow: 8,
      mode: 'postMessage',
    });
    const subscriber = createViewportSubscriber({ port: b });
    expect(publisher.mode).toBe('postMessage');
    expect(publisher.buffer).toBeNull();
    const before = count();
    publisher.publish({
      rowOffset: 4,
      rowCount: 2,
      column: [
        { id: 'id', value: [1, 2] },
        { id: 'price', value: [1.25, 2.5] },
        { id: 'name', value: ['ünïcode', ''] },
      ],
    });
    expect(count()).toBe(before + 1);
    const frame = subscriber.latest()!;
    expect(frame.rowOffset).toBe(4);
    expect(frame.rowCount).toBe(2);
    expect(numericValue(frame, 'id')).toEqual([1, 2]);
    expect(numericValue(frame, 'price')).toEqual([1.25, 2.5]);
    expect(textValue(frame, 'name')).toEqual(['ünïcode', '']);
    // `poll()` is the renderer's single entry point in both modes.
    expect(subscriber.poll()!.sequence).toBe(frame.sequence);
  });

  it('auto-detects postMessage when cross-origin isolation is absent', () => {
    delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    const { a, b } = makePort();
    const publisher = createViewportPublisher({ port: a, column: SPEC, capacityRow: 4 });
    const subscriber = createViewportSubscriber({ port: b });
    expect(publisher.mode).toBe('postMessage');
    expect(subscriber.mode).toBe('postMessage');
    publisher.publish({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [5] }] });
    expect(numericValue(subscriber.latest()!, 'id')).toEqual([5]);
  });

  it('notifies subscribers on new frames in both modes and stops after dispose', () => {
    for (const mode of ['shared', 'postMessage'] as const) {
      const { a, b } = makePort();
      const publisher = createViewportPublisher({
        port: a,
        column: SPEC,
        capacityRow: 4,
        mode,
      });
      const subscriber = createViewportSubscriber({ port: b });
      const seen: number[] = [];
      subscriber.onFrame((f) => seen.push(f.rowOffset));
      publisher.publish({ rowOffset: 1, rowCount: 1, column: [{ id: 'id', value: [1] }] });
      subscriber.poll();
      publisher.publish({ rowOffset: 2, rowCount: 1, column: [{ id: 'id', value: [2] }] });
      subscriber.poll();
      expect(seen).toEqual([1, 2]);
      subscriber.dispose();
      publisher.publish({ rowOffset: 3, rowCount: 1, column: [{ id: 'id', value: [3] }] });
      subscriber.poll();
      expect(seen).toEqual([1, 2]);
    }
  });

  it('returns null before the first frame and refuses to publish after dispose', () => {
    const { a, b } = makePort();
    const subscriber = createViewportSubscriber({ port: b });
    expect(subscriber.latest()).toBeNull();
    expect(subscriber.mode).toBeNull();
    const publisher = createViewportPublisher({
      port: a,
      column: SPEC,
      capacityRow: 4,
      mode: 'postMessage',
    });
    publisher.dispose();
    expect(() =>
      publisher.publish({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [1] }] }),
    ).toThrow(/disposed/);
  });

  it('auto-increments the generation so a consumer can detect a new window', () => {
    const { a, b } = makePort();
    const publisher = createViewportPublisher({
      port: a,
      column: SPEC,
      capacityRow: 4,
      mode: 'shared',
    });
    const subscriber = createViewportSubscriber({ port: b });
    publisher.publish({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [1] }] });
    const first = subscriber.poll()!.generation;
    publisher.publish({ rowOffset: 0, rowCount: 1, column: [{ id: 'id', value: [2] }] });
    expect(subscriber.poll()!.generation).toBe(first + 1);
  });
});
