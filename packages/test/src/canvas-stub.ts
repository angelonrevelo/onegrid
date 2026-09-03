// =============================================================================
// Recording Canvas-2D stub
//
// jsdom's `HTMLCanvasElement.getContext('2d')` returns `null` unless the
// native `canvas` package is installed, and that package needs a C++ toolchain
// on every machine that runs the suite. @onegrid/core dereferences the context
// unconditionally in its constructor, so without a stub a grid cannot even
// mount under jsdom. That single limit is the reason this package exists.
//
// Design decisions:
//
//   1. The stub implements EXACTLY the surface @onegrid/core touches, plus the
//      handful of path primitives (`arc` / `fill` / `closePath`) that custom
//      cell renderers reach for. Enumerated from the source rather than
//      guessed: setTransform, clearRect, fillRect, strokeRect, fillText,
//      measureText, save, restore, beginPath, rect, clip, moveTo, lineTo,
//      stroke, setLineDash, and the fillStyle / strokeStyle / font /
//      lineWidth / textBaseline / globalAlpha properties. A stub that is a
//      superset of the real usage would hide a genuine "we called something
//      the browser doesn't have" bug; a subset crashes the mount.
//
//   2. `measureText` is DETERMINISTIC — width is a pure function of the string
//      and the current font. Real font metrics vary by platform, so a test
//      asserting an auto-sized column width would be green on the author's
//      machine and red in CI. A linear model (character count times a
//      font-size-derived advance) is reproducible everywhere and still
//      monotonic in text length, which is the only property layout code
//      actually depends on.
//
//   3. Every mutation — method call AND property assignment — lands in one
//      ordered log. Painting is a sequence, not a set: "the header background
//      was filled before the header text" is a real assertion an adopter
//      wants to make, and it is unavailable if style writes are invisible.
//
//   4. The stub is installed by patching the prototype, not by handing back a
//      context object. @onegrid/core creates its own canvas internally; a test
//      never sees it and so can never inject one.
// =============================================================================

/**
 * One recorded interaction with the fake context. `kind` distinguishes a
 * method invocation from a property assignment so assertions can filter to
 * paint operations without style noise.
 */
export interface CanvasCall {
  readonly kind: 'call' | 'set';
  /** Method name (`fillText`) or property name (`fillStyle`). */
  readonly name: string;
  /** Method arguments, or a single-element array holding the assigned value. */
  readonly arg: ReadonlyArray<unknown>;
  /** Monotonic sequence number across every context created by this stub. */
  readonly seq: number;
}

/** Options for {@link installCanvasStub}. */
export interface CanvasStubOption {
  /**
   * Advance width per character, in CSS pixels, used when the current font
   * carries no parseable size. Default 7 — close to a 12 px monospace glyph,
   * which is what the default theme renders.
   */
  readonly charWidth?: number;
  /**
   * Full override for text measurement. Receives the string and the context's
   * current `font` value. Supply this when a test needs proportional-ish
   * widths (e.g. to exercise auto-size against a wide column).
   */
  readonly measureTextWidth?: (text: string, font: string) => number;
}

/**
 * The fake context handed back by `canvas.getContext('2d')`. It is structurally
 * assignable to the slice of `CanvasRenderingContext2D` that @onegrid/core
 * uses, and additionally exposes its own call log.
 */
export interface RecordingContext2D {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  lineWidth: number;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  strokeRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
  measureText: (text: string) => { readonly width: number };
  save: () => void;
  restore: () => void;
  beginPath: () => void;
  closePath: () => void;
  rect: (x: number, y: number, w: number, h: number) => void;
  arc: (
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ) => void;
  clip: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  stroke: () => void;
  fill: () => void;
  setLineDash: (segment: ReadonlyArray<number>) => void;
  /** Ordered log of everything this context was asked to do. */
  readonly call: ReadonlyArray<CanvasCall>;
}

/** Handle returned by {@link installCanvasStub}. */
export interface CanvasStubHandle {
  /**
   * Ordered log across every canvas created while the stub is installed. A
   * single grid owns exactly one canvas, so for the common case this is that
   * grid's paint log.
   */
  readonly call: ReadonlyArray<CanvasCall>;
  /** The recording context for a specific canvas element, if one was made. */
  readonly contextFor: (canvas: HTMLCanvasElement) => RecordingContext2D | null;
  /** Every `fillText` string in paint order — the cheapest "what got painted". */
  readonly paintedText: () => ReadonlyArray<string>;
  /** Calls matching a method or property name, in order. */
  readonly callTo: (name: string) => ReadonlyArray<CanvasCall>;
  /** Empty the log without uninstalling. Use between phases of a test. */
  readonly reset: () => void;
  /** Restore the original `getContext`. Call from `afterEach`. */
  readonly restore: () => void;
}

/**
 * Parse a CSS `font` shorthand for its pixel size. The grid always writes
 * `"{size}px {family}"`, so a single regex covers every value it produces;
 * anything else falls back to the caller's default.
 */
function fontSizePx(font: string): number | null {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Replace `HTMLCanvasElement.prototype.getContext` with a factory that returns
 * a recording fake for `'2d'` and defers to the original implementation for
 * every other context id (so a WebGPU test in the same file still works).
 *
 * Idempotent per install/restore pair: each call captures the *current*
 * `getContext` and puts it back on `restore()`, so nesting installs unwinds
 * cleanly in reverse order.
 *
 * @public
 */
export function installCanvasStub(option: CanvasStubOption = {}): CanvasStubHandle {
  const charWidth = option.charWidth ?? 7;
  const measure = option.measureTextWidth;
  const log: CanvasCall[] = [];
  const byCanvas = new WeakMap<HTMLCanvasElement, RecordingContext2D>();
  let seq = 0;

  function makeContext(): RecordingContext2D {
    // Backing fields for the recorded properties. Defaults mirror the real
    // Canvas-2D initial state so code that reads back a value it never wrote
    // sees what a browser would show.
    const state = {
      fillStyle: '#000000',
      strokeStyle: '#000000',
      font: '10px sans-serif',
      lineWidth: 1,
      textBaseline: 'alphabetic' as CanvasTextBaseline,
      globalAlpha: 1,
    };

    const record = (kind: 'call' | 'set', name: string, arg: ReadonlyArray<unknown>): void => {
      log.push({ kind, name, arg, seq: seq++ });
    };

    const method =
      (name: string) =>
      (...arg: unknown[]): void => {
        record('call', name, arg);
      };

    const ctx = {
      setTransform: method('setTransform'),
      clearRect: method('clearRect'),
      fillRect: method('fillRect'),
      strokeRect: method('strokeRect'),
      fillText: method('fillText'),
      save: method('save'),
      restore: method('restore'),
      beginPath: method('beginPath'),
      closePath: method('closePath'),
      rect: method('rect'),
      arc: method('arc'),
      clip: method('clip'),
      moveTo: method('moveTo'),
      lineTo: method('lineTo'),
      stroke: method('stroke'),
      fill: method('fill'),
      setLineDash: method('setLineDash'),
      measureText: (text: string): { readonly width: number } => {
        record('call', 'measureText', [text]);
        if (measure) return { width: measure(text, state.font) };
        // Scale the per-character advance with the font size so a 24 px
        // header measures wider than a 12 px cell — the ordering that
        // auto-size logic depends on.
        const size = fontSizePx(state.font);
        const advance = size === null ? charWidth : (charWidth * size) / 12;
        return { width: text.length * advance };
      },
      get call(): ReadonlyArray<CanvasCall> {
        return log;
      },
    } as unknown as RecordingContext2D;

    for (const name of Object.keys(state) as (keyof typeof state)[]) {
      Object.defineProperty(ctx, name, {
        enumerable: true,
        configurable: true,
        get: () => state[name],
        set: (value: never) => {
          state[name] = value;
          record('set', name, [value]);
        },
      });
    }

    return ctx;
  }

  // Capturing a prototype method as a value is exactly what patching means;
  // the unbound-method rule is guarding against a mistake we are making on
  // purpose, and every call site below re-supplies `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalRaw = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    ...rest: unknown[]
  ): unknown {
    if (contextId === '2d') {
      let existing = byCanvas.get(this);
      if (!existing) {
        existing = makeContext();
        byCanvas.set(this, existing);
      }
      return existing;
    }
    return originalRaw.call(this, contextId as '2d', ...(rest as []));
  } as typeof HTMLCanvasElement.prototype.getContext;

  return {
    get call(): ReadonlyArray<CanvasCall> {
      return log;
    },
    contextFor: (canvas) => byCanvas.get(canvas) ?? null,
    paintedText: () =>
      log.filter((c) => c.name === 'fillText').map((c) => String(c.arg[0] ?? '')),
    callTo: (name) => log.filter((c) => c.name === name),
    reset: () => {
      log.length = 0;
    },
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalRaw;
    },
  };
}
