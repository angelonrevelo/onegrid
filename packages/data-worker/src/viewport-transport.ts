// =============================================================================
// Viewport transport — shared-memory path with an honest postMessage fallback
//
// `ViewportBuffer` is only half the story. Cross-origin isolation is a
// deployment decision an adopter may not be able to make (a third-party
// embed, an ad-supported page that cannot serve COEP: require-corp), so the
// shared path can never be the only path. This module gives both sides one
// API whose semantics are identical either way, and picks the transport once
// at construction:
//
//   shared       — the publisher allocates a SharedArrayBuffer, posts it once
//                  in a handshake, and thereafter every frame costs zero
//                  messages. The subscriber reads it with the seqlock during
//                  its own rAF callback.
//   postMessage  — the publisher structured-clones each frame. Identical
//                  `ViewportFrame` shape arrives at the subscriber, one
//                  message per frame, which is exactly today's cost.
//
// The reason the API is uniform is that the renderer must not branch. It
// calls `poll()` each frame and gets the newest frame or null; under the
// shared transport that is a seqlock read, under postMessage it returns
// whatever the last message delivered. Nothing above this line knows which.
// =============================================================================

import {
  ViewportBuffer,
  isSharedMemoryAvailable,
  type ViewportColumnSpec,
  type ViewportFrame,
  type ViewportFrameInput,
} from './viewport-buffer.js';

/**
 * The subset of `Worker` / `MessagePort` the transport needs. Keeping it
 * structural means the same code runs over a Worker, a MessagePort, a
 * BroadcastChannel, or an in-process fake in tests.
 * @public
 */
export interface ViewportPortLike {
  postMessage(message: unknown, transfer?: ReadonlyArray<Transferable>): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

/** Which wire the transport settled on. @public */
export type ViewportTransportMode = 'shared' | 'postMessage';

const MESSAGE_INIT = 'onegrid:viewport:init';
const MESSAGE_FRAME = 'onegrid:viewport:frame';

interface InitMessage {
  readonly type: typeof MESSAGE_INIT;
  readonly mode: ViewportTransportMode;
  readonly buffer?: SharedArrayBuffer | ArrayBuffer | undefined;
  readonly column: ReadonlyArray<ViewportColumnSpec>;
  readonly capacityRow: number;
}

interface FrameMessage {
  readonly type: typeof MESSAGE_FRAME;
  readonly frame: ViewportFrame;
}

function isInitMessage(data: unknown): data is InitMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === MESSAGE_INIT
  );
}

function isFrameMessage(data: unknown): data is FrameMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === MESSAGE_FRAME
  );
}

/** @public */
export interface ViewportPublisherOptions {
  readonly port: ViewportPortLike;
  readonly column: ReadonlyArray<ViewportColumnSpec>;
  readonly capacityRow: number;
  /**
   * Force a transport. Omit to auto-detect via `isSharedMemoryAvailable()`.
   * Pass `'shared'` under Node/`worker_threads`, where SharedArrayBuffer works
   * but `crossOriginIsolated` is undefined.
   */
  readonly mode?: ViewportTransportMode;
}

/** Worker-side writer. @public */
export interface ViewportPublisher {
  readonly mode: ViewportTransportMode;
  /** The shared region, or null under the postMessage transport. */
  readonly buffer: ViewportBuffer | null;
  /** Publish a window. Zero messages under the shared transport. */
  publish(frame: ViewportFrameInput): void;
  dispose(): void;
}

/**
 * Create the worker-side half. Posts the handshake immediately so a
 * subscriber constructed before or after it converges either way — the
 * subscriber replays whatever it receives.
 * @public
 */
export function createViewportPublisher(
  option: ViewportPublisherOptions,
): ViewportPublisher {
  const mode: ViewportTransportMode =
    option.mode ?? (isSharedMemoryAvailable() ? 'shared' : 'postMessage');
  const buffer =
    mode === 'shared'
      ? ViewportBuffer.create({
          column: option.column,
          capacityRow: option.capacityRow,
          preferShared: true,
        })
      : null;
  // If we asked for shared memory and did not get it (no SharedArrayBuffer
  // constructor at all), degrade rather than hand the reader a private
  // ArrayBuffer it can never see writes through.
  const effectiveMode: ViewportTransportMode =
    buffer !== null && buffer.isShared ? 'shared' : 'postMessage';

  const init: InitMessage = {
    type: MESSAGE_INIT,
    mode: effectiveMode,
    buffer: effectiveMode === 'shared' ? buffer!.buffer : undefined,
    column: option.column,
    capacityRow: option.capacityRow,
  };
  option.port.postMessage(init);

  let generation = 0;
  let disposed = false;

  return {
    mode: effectiveMode,
    buffer: effectiveMode === 'shared' ? buffer : null,
    publish(frame: ViewportFrameInput): void {
      if (disposed) throw new Error('[OG_VIEWPORT_TRANSPORT] publisher disposed.');
      generation = frame.generation ?? generation + 1;
      if (effectiveMode === 'shared') {
        buffer!.write({ ...frame, generation });
        return;
      }
      // postMessage transport: materialise the same snapshot shape the
      // shared reader would produce, so the consumer cannot tell them apart.
      const message: FrameMessage = {
        type: MESSAGE_FRAME,
        frame: materialiseFrame(frame, option.column, generation),
      };
      option.port.postMessage(message);
    },
    dispose(): void {
      disposed = true;
    },
  };
}

function materialiseFrame(
  frame: ViewportFrameInput,
  spec: ReadonlyArray<ViewportColumnSpec>,
  generation: number,
): ViewportFrame {
  const byId = new Map(frame.column.map((c) => [c.id, c.value]));
  const column = spec.map((s) => {
    const raw = byId.get(s.id);
    if (s.kind === 'utf8') {
      const text = (raw ?? []) as ReadonlyArray<string>;
      return {
        id: s.id,
        kind: s.kind,
        value: Array.from({ length: frame.rowCount }, (_, i) => text[i] ?? ''),
      };
    }
    const numeric = (raw ?? []) as ArrayLike<number>;
    const out =
      s.kind === 'int32'
        ? new Int32Array(frame.rowCount)
        : new Float64Array(frame.rowCount);
    for (let i = 0; i < frame.rowCount; i++) out[i] = numeric[i] ?? 0;
    return { id: s.id, kind: s.kind, value: out };
  });
  return {
    sequence: generation,
    rowOffset: frame.rowOffset,
    rowCount: frame.rowCount,
    generation,
    retryCount: 0,
    column,
  };
}

/** @public */
export interface ViewportSubscriberOptions {
  readonly port: ViewportPortLike;
  /** Retry budget for the shared-memory read. See `ViewportReadOptions`. */
  readonly maxRetry?: number | undefined;
}

/** Renderer-side reader. @public */
export interface ViewportSubscriber {
  /** Null until the publisher's handshake arrives. */
  readonly mode: ViewportTransportMode | null;
  /**
   * Read the newest frame. Under the shared transport this is a seqlock read
   * and should be called once per rAF; under postMessage it returns the last
   * delivered frame. Returns null before the first frame, and — under the
   * shared transport only — when the retry budget was exhausted, in which
   * case the caller should reuse the frame it already has.
   */
  poll(): ViewportFrame | null;
  /** The last frame `poll()` returned, without re-reading. */
  latest(): ViewportFrame | null;
  /** Fires when `poll()` observes a new sequence, or a frame message lands. */
  onFrame(listener: (frame: ViewportFrame) => void): () => void;
  dispose(): void;
}

/**
 * Create the renderer-side half. Attaches to the shared region when the
 * handshake carries one, otherwise consumes frame messages.
 * @public
 */
export function createViewportSubscriber(
  option: ViewportSubscriberOptions,
): ViewportSubscriber {
  let mode: ViewportTransportMode | null = null;
  let attached: ViewportBuffer | null = null;
  let last: ViewportFrame | null = null;
  let lastSequence = -1;
  const listener = new Set<(frame: ViewportFrame) => void>();

  const emit = (frame: ViewportFrame): void => {
    last = frame;
    lastSequence = frame.sequence;
    listener.forEach((fn) => fn(frame));
  };

  const onMessage = (e: { data: unknown }): void => {
    if (isInitMessage(e.data)) {
      mode = e.data.mode;
      if (e.data.mode === 'shared' && e.data.buffer) {
        attached = ViewportBuffer.attach(e.data.buffer, e.data.column, e.data.capacityRow);
      }
      return;
    }
    if (isFrameMessage(e.data)) emit(e.data.frame);
  };
  option.port.addEventListener('message', onMessage);

  return {
    get mode(): ViewportTransportMode | null {
      return mode;
    },
    poll(): ViewportFrame | null {
      if (!attached) return last;
      const frame = attached.readFrame({ maxRetry: option.maxRetry });
      if (!frame) return null;
      if (frame.sequence === lastSequence) return frame;
      emit(frame);
      return frame;
    },
    latest(): ViewportFrame | null {
      return last;
    },
    onFrame(fn): () => void {
      listener.add(fn);
      return () => listener.delete(fn);
    },
    dispose(): void {
      option.port.removeEventListener('message', onMessage);
      listener.clear();
      attached = null;
    },
  };
}
