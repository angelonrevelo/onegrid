// =============================================================================
// ViewportBuffer — SharedArrayBuffer cross-thread viewport
//
// The problem this solves: the data worker computes the rows the renderer is
// about to paint, and today it hands them over by postMessage. Structured
// clone of a 200-row x 30-column window costs 0.4-1.2 ms and, worse, it lands
// as a *task* on the main thread — so the copy competes with the very frame it
// is feeding. At 120 Hz that is a third of the frame budget spent on a copy
// that produces no pixels.
//
// The fix is a fixed-layout binary region both threads address directly: the
// worker writes cell values in, the renderer reads them out during its own
// rAF callback, and no message is posted per frame at all.
//
// -----------------------------------------------------------------------------
// Synchronisation: a seqlock, not a mutex
// -----------------------------------------------------------------------------
// A mutex is the wrong primitive here. If the renderer has to *acquire*
// anything, then a worker that is mid-write at rAF time makes the renderer
// either block (dropping the frame — the exact failure we are trying to avoid)
// or spin. A seqlock inverts that: the writer is the only party that mutates
// the lock word, and the reader is wait-free — it never blocks, never prevents
// the writer from progressing, and in the worst case discards the snapshot it
// just read and either retries or reuses last frame's data. For a render loop,
// "occasionally reuse the previous frame" is a correct and invisible outcome;
// "block the compositor" is not.
//
// The protocol on the sequence word (SEQ, a 32-bit slot addressed with
// Atomics):
//
//   Writer:  seq -> odd  (write in progress)
//            ... store payload ...
//            seq -> even (payload consistent, seq value identifies the frame)
//
//   Reader:  s1 = load(seq)
//            if (s1 & 1) retry            — a write is in flight
//            ... copy payload out ...
//            s2 = load(seq)
//            if (s2 !== s1) retry         — a write landed under us; the copy
//                                           we just made may be torn
//            else the copy is a consistent snapshot of frame s1
//
// The two Atomics.load calls are sequentially consistent, which is what makes
// the bracket meaningful: the payload stores cannot be reordered past the
// trailing counter increment, so observing an unchanged even counter after the
// copy proves no store overlapped the copy. Non-atomic payload access is
// deliberate — atomic per-cell reads would cost more than the postMessage we
// are eliminating, and the counter bracket is what provides the consistency
// guarantee, not the individual loads.
//
// Atomics.wait / Atomics.notify: Atomics.wait THROWS on a browser main thread
// (agents whose [[CanBlock]] is false), so it must never appear on the
// renderer's path — that is precisely why the reader above is a retry loop and
// not a wait. We expose blocking only as waitForChange(), documented
// worker-only, plus waitForChangeAsync() which is built on Atomics.waitAsync
// and is safe everywhere. Atomics.notify is always safe to call, main thread
// included, so the writer notifies unconditionally.
//
// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------
// SharedArrayBuffer is gated behind cross-origin isolation (COOP/COEP). If the
// document is not isolated, the constructor may exist but the buffer cannot be
// shared with a worker. isSharedMemoryAvailable() therefore checks both the
// constructor AND crossOriginIsolated, and the transport in
// ./viewport-transport falls back to the ordinary postMessage path when it is
// false. See the README for the two response headers you must serve.
// =============================================================================

// -----------------------------------------------------------------------------
// Byte layout
//
//   +--------------------------------+ 0
//   | header (64 B)                  |
//   +--------------------------------+ HEADER_BYTE_LENGTH
//   | descriptor[0] (32 B)           |
//   | descriptor[1] (32 B)           |
//   | ...                            |
//   +--------------------------------+ HEADER_BYTE_LENGTH + 32 * columnCount
//   | column 0 data region           |   8-byte aligned
//   | column 0 aux region (utf8)     |
//   | column 1 data region           |
//   | ...                            |
//   +--------------------------------+ byteLength
//
// Every offset below is a named constant. There are no magic numbers in the
// read/write paths; if you change the header you change it here and the layout
// computation picks it up.
// -----------------------------------------------------------------------------

/** Byte length of the fixed header. 64 keeps the descriptor table 8-aligned. */
const HEADER_BYTE_LENGTH = 64;
/** Byte length of one per-column descriptor. */
const DESCRIPTOR_BYTE_LENGTH = 32;
/** Everything is aligned to 8 so Float64 regions are naturally aligned. */
const REGION_ALIGNMENT = 8;

// Header slots, expressed as Int32Array indices (byte offset / 4).
const HEADER_I32_MAGIC = 0; // byte 0
const HEADER_I32_VERSION = 1; // byte 4
const HEADER_I32_SEQ = 2; // byte 8  — the seqlock word
const HEADER_I32_ROW_OFFSET = 3; // byte 12
const HEADER_I32_ROW_COUNT = 4; // byte 16
const HEADER_I32_COLUMN_COUNT = 5; // byte 20
const HEADER_I32_CAPACITY_ROW = 6; // byte 24
const HEADER_I32_GENERATION = 7; // byte 28
// Int32 indices 8..15 (bytes 32..63) are reserved for future header fields.

// Descriptor slots, as Int32Array indices relative to the descriptor base.
const DESC_I32_KIND = 0;
const DESC_I32_DATA_BYTE_OFFSET = 1;
const DESC_I32_DATA_BYTE_LENGTH = 2;
const DESC_I32_AUX_BYTE_OFFSET = 3;
const DESC_I32_AUX_BYTE_LENGTH = 4;
const DESC_I32_TEXT_BYTE_USED = 5;
// Descriptor Int32 indices 6..7 are reserved.

/** 'OGVB' — sanity-checks that an attached buffer is one of ours. */
const VIEWPORT_MAGIC = 0x4f475642;
/** Layout version. Bump on any incompatible change to the constants above. */
const VIEWPORT_LAYOUT_VERSION = 1;

const KIND_CODE = { int32: 1, float64: 2, utf8: 3 } as const;
const CODE_KIND = ['', 'int32', 'float64', 'utf8'] as const;

/** Default per-row byte budget for a utf8 column's text arena. */
const DEFAULT_TEXT_BYTE_PER_ROW = 32;

/**
 * The cell types the shared viewport can carry.
 *
 * `utf8` is not directly storable in a typed array, so it is encoded as an
 * offset table plus a byte arena — see `ViewportColumnLayout`.
 * @public
 */
export type ViewportColumnKind = 'int32' | 'float64' | 'utf8';

/** @public */
export interface ViewportColumnSpec {
  readonly id: string;
  readonly kind: ViewportColumnKind;
  /**
   * `utf8` only. Bytes reserved per row in the text arena. The arena is
   * `capacityRow * textBytePerRow` bytes; writing more throws rather than
   * silently truncating. Default 32.
   */
  readonly textBytePerRow?: number;
}

/**
 * Resolved placement of one column inside the buffer.
 * @public
 */
export interface ViewportColumnLayout {
  readonly id: string;
  readonly kind: ViewportColumnKind;
  /** Byte offset of the value region (utf8: the text arena). */
  readonly dataByteOffset: number;
  readonly dataByteLength: number;
  /**
   * utf8 only: byte offset of the `Uint32Array(capacityRow + 1)` offset table.
   * Entry `i` is the arena offset where row `i`'s bytes start, so row `i`
   * occupies `[offset[i], offset[i + 1])`. Zero for numeric kinds.
   */
  readonly auxByteOffset: number;
  readonly auxByteLength: number;
}

/** @public */
export interface ViewportLayout {
  readonly byteLength: number;
  readonly headerByteLength: number;
  readonly descriptorByteLength: number;
  readonly capacityRow: number;
  readonly column: ReadonlyArray<ViewportColumnLayout>;
}

/**
 * One column's values inside a decoded snapshot.
 * @public
 */
export interface ViewportFrameColumn {
  readonly id: string;
  readonly kind: ViewportColumnKind;
  /** Non-shared copy — safe to hold across frames. */
  readonly value: Int32Array | Float64Array | ReadonlyArray<string>;
}

/**
 * A consistent snapshot read out of the shared region.
 * @public
 */
export interface ViewportFrame {
  /** The (even) sequence number this snapshot belongs to. */
  readonly sequence: number;
  /** Index of the first row in the window, in source-table coordinates. */
  readonly rowOffset: number;
  readonly rowCount: number;
  /** Writer-controlled epoch; bump it when the column set or sort changes. */
  readonly generation: number;
  /** How many times the reader had to restart before it got a clean read. */
  readonly retryCount: number;
  readonly column: ReadonlyArray<ViewportFrameColumn>;
}

/** @public */
export interface ViewportFrameInput {
  readonly rowOffset: number;
  readonly rowCount: number;
  readonly generation?: number;
  readonly column: ReadonlyArray<{
    readonly id: string;
    readonly value: ArrayLike<number> | ReadonlyArray<string>;
  }>;
}

/** @public */
export interface ViewportReadOptions {
  /**
   * How many times to restart before giving up and returning null. A render
   * loop should keep this small (the default 8) and reuse the previous frame
   * on null — that is one stale frame, not a dropped one.
   */
  readonly maxRetry?: number | undefined;
  /**
   * Test seam. Invoked after the payload copy and before the trailing sequence
   * re-read, so a test can land a concurrent write exactly in the window the
   * seqlock exists to detect. Never set this in production code.
   */
  readonly onPayloadCopied?: (attempt: number) => void;
}

/** @public */
export interface ViewportBufferOptions {
  readonly column: ReadonlyArray<ViewportColumnSpec>;
  /** Maximum rows the window can hold. The buffer is sized for this. */
  readonly capacityRow: number;
  /**
   * Allocate a SharedArrayBuffer. Defaults to `isSharedMemoryAvailable()`.
   *
   * Override it to `true` under Node/`worker_threads`, where SharedArrayBuffer
   * is fully usable but `crossOriginIsolated` — a document-only concept — is
   * undefined, so the honest browser guard would report false.
   */
  readonly preferShared?: boolean;
}

/**
 * True only when SharedArrayBuffer is both defined and actually shareable with
 * a worker.
 *
 * The `crossOriginIsolated` half is the part adopters miss: since Spectre,
 * browsers expose the SharedArrayBuffer *constructor* in some contexts where
 * posting one to a worker still throws. Serving
 * `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` is what flips this to true.
 * @public
 */
export function isSharedMemoryAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

function alignUp(value: number, alignment: number): number {
  const rem = value % alignment;
  return rem === 0 ? value : value + (alignment - rem);
}

/**
 * Resolve the byte placement of every region. Pure — both threads run it and
 * must agree, which is why it takes only the column spec and the capacity.
 * @public
 */
export function computeViewportLayout(
  column: ReadonlyArray<ViewportColumnSpec>,
  capacityRow: number,
): ViewportLayout {
  if (!Number.isInteger(capacityRow) || capacityRow <= 0) {
    throw new Error(
      `[OG_VIEWPORT_LAYOUT] capacityRow must be a positive integer, got ${capacityRow}.`,
    );
  }
  const seen = new Set<string>();
  let cursor = alignUp(
    HEADER_BYTE_LENGTH + DESCRIPTOR_BYTE_LENGTH * column.length,
    REGION_ALIGNMENT,
  );
  const out: ViewportColumnLayout[] = [];
  for (const spec of column) {
    if (seen.has(spec.id)) {
      throw new Error(`[OG_VIEWPORT_LAYOUT] duplicate column id "${spec.id}".`);
    }
    seen.add(spec.id);
    if (spec.kind === 'int32' || spec.kind === 'float64') {
      const width = spec.kind === 'int32' ? 4 : 8;
      const dataByteLength = alignUp(capacityRow * width, REGION_ALIGNMENT);
      out.push({
        id: spec.id,
        kind: spec.kind,
        dataByteOffset: cursor,
        dataByteLength,
        auxByteOffset: 0,
        auxByteLength: 0,
      });
      cursor += dataByteLength;
      continue;
    }
    // utf8: offset table first (so it stays 4-aligned), then the byte arena.
    const auxByteLength = alignUp((capacityRow + 1) * 4, REGION_ALIGNMENT);
    const bytePerRow = spec.textBytePerRow ?? DEFAULT_TEXT_BYTE_PER_ROW;
    if (!Number.isInteger(bytePerRow) || bytePerRow <= 0) {
      throw new Error(
        `[OG_VIEWPORT_LAYOUT] column "${spec.id}" textBytePerRow must be a positive integer.`,
      );
    }
    const dataByteLength = alignUp(capacityRow * bytePerRow, REGION_ALIGNMENT);
    out.push({
      id: spec.id,
      kind: 'utf8',
      auxByteOffset: cursor,
      auxByteLength,
      dataByteOffset: cursor + auxByteLength,
      dataByteLength,
    });
    cursor += auxByteLength + dataByteLength;
  }
  return {
    byteLength: cursor,
    headerByteLength: HEADER_BYTE_LENGTH,
    descriptorByteLength: DESCRIPTOR_BYTE_LENGTH,
    capacityRow,
    column: out,
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * A fixed-layout viewport window shared between the worker (writer) and the
 * renderer (reader), synchronised with a seqlock. See the file banner for the
 * protocol and why the reader is wait-free.
 * @public
 */
export class ViewportBuffer {
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  readonly layout: ViewportLayout;
  /** False when we fell back to a non-shared ArrayBuffer. */
  readonly isShared: boolean;

  private readonly i32: Int32Array;
  private readonly u8: Uint8Array;
  private readonly columnIndexById: ReadonlyMap<string, number>;

  private constructor(
    buffer: SharedArrayBuffer | ArrayBuffer,
    layout: ViewportLayout,
    initialise: boolean,
  ) {
    this.buffer = buffer;
    this.layout = layout;
    this.isShared =
      typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
    this.i32 = new Int32Array(buffer);
    this.u8 = new Uint8Array(buffer);
    const index = new Map<string, number>();
    layout.column.forEach((c, i) => index.set(c.id, i));
    this.columnIndexById = index;
    if (initialise) this.writeLayoutHeader();
    else this.assertHeaderMatches();
  }

  /** Allocate a new buffer sized for `option`. Call this on the writer side. */
  static create(option: ViewportBufferOptions): ViewportBuffer {
    const layout = computeViewportLayout(option.column, option.capacityRow);
    const useShared = option.preferShared ?? isSharedMemoryAvailable();
    const buffer =
      useShared && typeof SharedArrayBuffer !== 'undefined'
        ? new SharedArrayBuffer(layout.byteLength)
        : new ArrayBuffer(layout.byteLength);
    return new ViewportBuffer(buffer, layout, true);
  }

  /**
   * Attach to a buffer received from the other thread. The column spec and
   * capacity must match what the writer used; the header magic, version,
   * column count and capacity are verified and a mismatch throws rather than
   * producing silently wrong cells.
   */
  static attach(
    buffer: SharedArrayBuffer | ArrayBuffer,
    column: ReadonlyArray<ViewportColumnSpec>,
    capacityRow: number,
  ): ViewportBuffer {
    const layout = computeViewportLayout(column, capacityRow);
    if (buffer.byteLength < layout.byteLength) {
      throw new Error(
        `[OG_VIEWPORT_ATTACH] buffer is ${buffer.byteLength} bytes, layout needs ${layout.byteLength}.`,
      );
    }
    return new ViewportBuffer(buffer, layout, false);
  }

  /** The current seqlock value. Odd means a write is in flight. */
  get sequence(): number {
    return Atomics.load(this.i32, HEADER_I32_SEQ);
  }

  /** Rows currently published. Read outside a snapshot; advisory only. */
  get rowCount(): number {
    return Atomics.load(this.i32, HEADER_I32_ROW_COUNT);
  }

  /**
   * Publish a frame. Brackets the payload stores in the seqlock and notifies
   * any worker blocked in `waitForChange`.
   */
  write(frame: ViewportFrameInput): void {
    this.beginWrite();
    try {
      this.writePayload(frame);
    } finally {
      // Even on a failed write we must leave the counter even, or every
      // subsequent reader spins forever on an odd counter. What remains
      // visible is the previous frame plus whatever partial stores landed — so
      // a throwing write yields a stale-or-partial window, never a reader that
      // never returns.
      this.endWrite();
    }
  }

  /**
   * Take the write lock: seq becomes odd. Exposed separately from `write` so a
   * caller can stream cells in over several calls, and so tests can drive the
   * protocol by hand.
   */
  beginWrite(): void {
    const seq = Atomics.load(this.i32, HEADER_I32_SEQ);
    if ((seq & 1) === 1) {
      throw new Error(
        '[OG_VIEWPORT_WRITE] sequence is already odd — a write is in flight. ' +
          'ViewportBuffer supports exactly one writer.',
      );
    }
    Atomics.store(this.i32, HEADER_I32_SEQ, seq + 1);
  }

  /** Release the write lock: seq becomes even, then wake any waiter. */
  endWrite(): void {
    const seq = Atomics.load(this.i32, HEADER_I32_SEQ);
    if ((seq & 1) === 0) return; // idempotent — no write in flight
    Atomics.store(this.i32, HEADER_I32_SEQ, seq + 1);
    // Always safe, main thread included (unlike Atomics.wait).
    Atomics.notify(this.i32, HEADER_I32_SEQ);
  }

  /** Store the payload without touching the sequence word. */
  writePayload(frame: ViewportFrameInput): void {
    const { rowCount, rowOffset } = frame;
    if (rowCount < 0 || rowCount > this.layout.capacityRow) {
      throw new Error(
        `[OG_VIEWPORT_WRITE] rowCount ${rowCount} exceeds capacity ${this.layout.capacityRow}.`,
      );
    }
    for (const input of frame.column) {
      const index = this.columnIndexById.get(input.id);
      if (index === undefined) {
        throw new Error(`[OG_VIEWPORT_WRITE] unknown column "${input.id}".`);
      }
      this.writeColumn(index, input.value, rowCount);
    }
    this.i32[HEADER_I32_ROW_OFFSET] = rowOffset;
    this.i32[HEADER_I32_ROW_COUNT] = rowCount;
    if (frame.generation !== undefined) {
      this.i32[HEADER_I32_GENERATION] = frame.generation;
    }
  }

  /**
   * Wait-free consistent read. Returns null if `maxRetry` restarts were not
   * enough — the caller should reuse its previous frame rather than block.
   */
  readFrame(option: ViewportReadOptions = {}): ViewportFrame | null {
    const maxRetry = option.maxRetry ?? 8;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      const s1 = Atomics.load(this.i32, HEADER_I32_SEQ);
      if ((s1 & 1) === 1) continue; // write in flight — do not even copy
      const rowOffset = this.i32[HEADER_I32_ROW_OFFSET]!;
      const rowCount = this.i32[HEADER_I32_ROW_COUNT]!;
      const generation = this.i32[HEADER_I32_GENERATION]!;
      if (rowCount < 0 || rowCount > this.layout.capacityRow) continue;
      const column = this.layout.column.map((c, i) => this.readColumn(i, c, rowCount));
      option.onPayloadCopied?.(attempt);
      const s2 = Atomics.load(this.i32, HEADER_I32_SEQ);
      if (s2 !== s1) continue; // torn — a writer landed inside our copy
      return {
        sequence: s1,
        rowOffset,
        rowCount,
        generation,
        retryCount: attempt,
        column,
      };
    }
    return null;
  }

  /**
   * Block until the sequence moves off `lastSequence`.
   *
   * WORKER THREADS ONLY. `Atomics.wait` throws TypeError on any agent that
   * cannot block — which includes every browser main thread — so calling this
   * from the renderer is a bug, not a slow path. The renderer polls
   * `readFrame()` from its own rAF callback instead.
   */
  waitForChange(lastSequence: number, timeoutMs = Infinity): 'ok' | 'timed-out' {
    const r = Atomics.wait(this.i32, HEADER_I32_SEQ, lastSequence, timeoutMs);
    return r === 'timed-out' ? 'timed-out' : 'ok';
  }

  /**
   * Non-blocking sibling of `waitForChange`, built on `Atomics.waitAsync`.
   * Safe on the main thread. Resolves immediately where `waitAsync` is
   * unimplemented or the buffer is not shared, so callers must re-check the
   * sequence rather than assume a change happened.
   */
  waitForChangeAsync(
    lastSequence: number,
    timeoutMs = Infinity,
  ): Promise<'ok' | 'timed-out'> {
    const waitAsync = (
      Atomics as unknown as {
        waitAsync?: (
          i32: Int32Array,
          index: number,
          value: number,
          timeout: number,
        ) => { async: boolean; value: 'ok' | 'not-equal' | 'timed-out' | Promise<string> };
      }
    ).waitAsync;
    if (!waitAsync || !this.isShared) return Promise.resolve('ok');
    const r = waitAsync(this.i32, HEADER_I32_SEQ, lastSequence, timeoutMs);
    if (!r.async) {
      return Promise.resolve(r.value === 'timed-out' ? 'timed-out' : 'ok');
    }
    return (r.value as Promise<string>).then((v) => (v === 'timed-out' ? 'timed-out' : 'ok'));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private descriptorBase(index: number): number {
    return (HEADER_BYTE_LENGTH + DESCRIPTOR_BYTE_LENGTH * index) / 4;
  }

  private writeLayoutHeader(): void {
    this.i32[HEADER_I32_MAGIC] = VIEWPORT_MAGIC;
    this.i32[HEADER_I32_VERSION] = VIEWPORT_LAYOUT_VERSION;
    this.i32[HEADER_I32_COLUMN_COUNT] = this.layout.column.length;
    this.i32[HEADER_I32_CAPACITY_ROW] = this.layout.capacityRow;
    this.i32[HEADER_I32_ROW_COUNT] = 0;
    this.i32[HEADER_I32_ROW_OFFSET] = 0;
    this.i32[HEADER_I32_GENERATION] = 0;
    Atomics.store(this.i32, HEADER_I32_SEQ, 0);
    this.layout.column.forEach((c, i) => {
      const b = this.descriptorBase(i);
      this.i32[b + DESC_I32_KIND] = KIND_CODE[c.kind];
      this.i32[b + DESC_I32_DATA_BYTE_OFFSET] = c.dataByteOffset;
      this.i32[b + DESC_I32_DATA_BYTE_LENGTH] = c.dataByteLength;
      this.i32[b + DESC_I32_AUX_BYTE_OFFSET] = c.auxByteOffset;
      this.i32[b + DESC_I32_AUX_BYTE_LENGTH] = c.auxByteLength;
      this.i32[b + DESC_I32_TEXT_BYTE_USED] = 0;
    });
  }

  private assertHeaderMatches(): void {
    const magic = this.i32[HEADER_I32_MAGIC]!;
    if (magic !== VIEWPORT_MAGIC) {
      throw new Error(
        `[OG_VIEWPORT_ATTACH] bad magic 0x${magic.toString(16)} — not a ViewportBuffer.`,
      );
    }
    const version = this.i32[HEADER_I32_VERSION]!;
    if (version !== VIEWPORT_LAYOUT_VERSION) {
      throw new Error(
        `[OG_VIEWPORT_ATTACH] layout version ${version}, this build speaks ${VIEWPORT_LAYOUT_VERSION}.`,
      );
    }
    const columnCount = this.i32[HEADER_I32_COLUMN_COUNT]!;
    if (columnCount !== this.layout.column.length) {
      throw new Error(
        `[OG_VIEWPORT_ATTACH] buffer has ${columnCount} columns, spec has ${this.layout.column.length}.`,
      );
    }
    const capacityRow = this.i32[HEADER_I32_CAPACITY_ROW]!;
    if (capacityRow !== this.layout.capacityRow) {
      throw new Error(
        `[OG_VIEWPORT_ATTACH] buffer capacity ${capacityRow}, spec capacity ${this.layout.capacityRow}.`,
      );
    }
    for (let i = 0; i < this.layout.column.length; i++) {
      const b = this.descriptorBase(i);
      const kind = CODE_KIND[this.i32[b + DESC_I32_KIND]!];
      if (kind !== this.layout.column[i]!.kind) {
        throw new Error(
          `[OG_VIEWPORT_ATTACH] column ${i} is ${String(kind)} in the buffer, ` +
            `${this.layout.column[i]!.kind} in the spec.`,
        );
      }
    }
  }

  private writeColumn(
    index: number,
    value: ArrayLike<number> | ReadonlyArray<string>,
    rowCount: number,
  ): void {
    const c = this.layout.column[index]!;
    if (value.length < rowCount) {
      throw new Error(
        `[OG_VIEWPORT_WRITE] column "${c.id}" supplied ${value.length} values for ${rowCount} rows.`,
      );
    }
    if (c.kind === 'int32') {
      const view = new Int32Array(this.buffer, c.dataByteOffset, this.layout.capacityRow);
      for (let i = 0; i < rowCount; i++) view[i] = (value as ArrayLike<number>)[i]!;
      return;
    }
    if (c.kind === 'float64') {
      const view = new Float64Array(this.buffer, c.dataByteOffset, this.layout.capacityRow);
      for (let i = 0; i < rowCount; i++) view[i] = (value as ArrayLike<number>)[i]!;
      return;
    }
    // utf8: fill the offset table as we append into the arena. Encoding into a
    // scratch array first keeps this correct on engines that refuse
    // TextEncoder.encodeInto with a SharedArrayBuffer-backed destination.
    const offset = new Uint32Array(this.buffer, c.auxByteOffset, this.layout.capacityRow + 1);
    const text = value as ReadonlyArray<string>;
    let cursor = 0;
    for (let i = 0; i < rowCount; i++) {
      offset[i] = cursor;
      const encoded = textEncoder.encode(text[i] ?? '');
      if (cursor + encoded.length > c.dataByteLength) {
        throw new Error(
          `[OG_VIEWPORT_TEXT_OVERFLOW] column "${c.id}" needs more than ` +
            `${c.dataByteLength} bytes of text arena at row ${i}. ` +
            'Raise textBytePerRow for this column.',
        );
      }
      this.u8.set(encoded, c.dataByteOffset + cursor);
      cursor += encoded.length;
    }
    offset[rowCount] = cursor;
    this.i32[this.descriptorBase(index) + DESC_I32_TEXT_BYTE_USED] = cursor;
  }

  private readColumn(
    index: number,
    c: ViewportColumnLayout,
    rowCount: number,
  ): ViewportFrameColumn {
    if (c.kind === 'int32') {
      const view = new Int32Array(this.buffer, c.dataByteOffset, this.layout.capacityRow);
      return { id: c.id, kind: c.kind, value: view.slice(0, rowCount) };
    }
    if (c.kind === 'float64') {
      const view = new Float64Array(this.buffer, c.dataByteOffset, this.layout.capacityRow);
      return { id: c.id, kind: c.kind, value: view.slice(0, rowCount) };
    }
    const offset = new Uint32Array(this.buffer, c.auxByteOffset, this.layout.capacityRow + 1);
    const value: string[] = new Array<string>(rowCount);
    for (let i = 0; i < rowCount; i++) {
      const start = offset[i]!;
      const end = offset[i + 1]!;
      if (end < start || end > c.dataByteLength) {
        // Torn offset table. Return empties; the trailing sequence check in
        // readFrame will reject this snapshot anyway.
        value[i] = '';
        continue;
      }
      // Copy out of shared memory before decoding — some engines reject
      // decoding directly from a SharedArrayBuffer view.
      const bytes = this.u8.slice(c.dataByteOffset + start, c.dataByteOffset + end);
      value[i] = textDecoder.decode(bytes);
    }
    return { id: c.id, kind: c.kind, value };
  }
}

/**
 * Byte-layout constants, exported so an adopter writing a non-JavaScript peer
 * (a Wasm module, a Rust worker) can address the same region.
 * @public
 */
export const VIEWPORT_LAYOUT_CONSTANT = {
  HEADER_BYTE_LENGTH,
  DESCRIPTOR_BYTE_LENGTH,
  REGION_ALIGNMENT,
  VIEWPORT_MAGIC,
  VIEWPORT_LAYOUT_VERSION,
  SEQ_BYTE_OFFSET: HEADER_I32_SEQ * 4,
  ROW_OFFSET_BYTE_OFFSET: HEADER_I32_ROW_OFFSET * 4,
  ROW_COUNT_BYTE_OFFSET: HEADER_I32_ROW_COUNT * 4,
  GENERATION_BYTE_OFFSET: HEADER_I32_GENERATION * 4,
} as const;
