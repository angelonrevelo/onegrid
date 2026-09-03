// =============================================================================
// @onegrid/native
//
// The protocol a GPUI (Zed) window — or any other GPU-native host — speaks
// with oneGrid. The TypeScript encoder is the specification. The Rust crate
// at crate/ implements the same layout and is tested for byte-identity
// against `encodeFrame` here, the same pattern `@onegrid/wasm` uses for
// kernels: JS is the spec, the accelerated host is only allowed to exist
// while it matches.
//
// Why a protocol and not a GPUI crate in this repo:
//   GPUI is Zed's GPU UI framework (Metal / wgpu / DX11). Pulling it in
//   as a workspace dep would pin us to Zed's rust-toolchain and three
//   GPU backends. A native host is a *consumer* of oneGrid, not a
//   package we compile in CI. What we own is the frame: viewport,
//   cell quads, theme tokens, pointer events. A GPUI view deserialises
//   that frame and paints; a WebGPU renderer already does the same
//   work on the other side of this wire.
//
// Frame version 1 is JSON. A packed binary form is a v2 concern and is
// not invented here.
// =============================================================================

/** Protocol version. Bump on a breaking change to {@link NativeFrame}. @public */
export const NATIVE_FRAME_VERSION = 1 as const;

/** One cell rectangle in device-independent pixels. @public */
export interface NativeCellQuad {
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly fill: string;
  readonly color: string;
}

/** Visible viewport the host should paint. @public */
export interface NativeViewport {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly width: number;
  readonly height: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

/** Theme tokens the host maps onto GPUI / wgpu colours. @public */
export interface NativeTheme {
  readonly background: string;
  readonly text: string;
  readonly headerBackground: string;
  readonly border: string;
  readonly selection: string;
}

/** One frame of grid state a native host consumes. @public */
export interface NativeFrame {
  readonly version: typeof NATIVE_FRAME_VERSION;
  readonly viewport: NativeViewport;
  readonly theme: NativeTheme;
  readonly cell: ReadonlyArray<NativeCellQuad>;
}

/**
 * Encode a frame to JSON text. Deterministic key order so the Rust
 * crate can assert byte-identity in `cargo test`.
 * @public
 */
export function encodeFrame(frame: NativeFrame): string {
  if (frame.version !== NATIVE_FRAME_VERSION) {
    throw new Error(`[OG_NATIVE_VERSION] unsupported frame version ${String(frame.version)}`);
  }
  return JSON.stringify({
    version: frame.version,
    viewport: {
      scrollTop: frame.viewport.scrollTop,
      scrollLeft: frame.viewport.scrollLeft,
      width: frame.viewport.width,
      height: frame.viewport.height,
      rowStart: frame.viewport.rowStart,
      rowEnd: frame.viewport.rowEnd,
      colStart: frame.viewport.colStart,
      colEnd: frame.viewport.colEnd,
    },
    theme: {
      background: frame.theme.background,
      text: frame.theme.text,
      headerBackground: frame.theme.headerBackground,
      border: frame.theme.border,
      selection: frame.theme.selection,
    },
    cell: frame.cell.map((c) => ({
      row: c.row,
      col: c.col,
      x: c.x,
      y: c.y,
      width: c.width,
      height: c.height,
      text: c.text,
      fill: c.fill,
      color: c.color,
    })),
  });
}

/**
 * Decode a frame. Rejects a missing version or a future version.
 * @public
 */
export function decodeFrame(text: string): NativeFrame {
  const parsed = JSON.parse(text) as Partial<NativeFrame>;
  if (parsed.version !== NATIVE_FRAME_VERSION) {
    throw new Error(`[OG_NATIVE_VERSION] unsupported frame version ${String(parsed.version)}`);
  }
  if (!parsed.viewport || !parsed.theme || !Array.isArray(parsed.cell)) {
    throw new Error('[OG_NATIVE_SHAPE] frame missing viewport, theme or cell');
  }
  return parsed as NativeFrame;
}

/**
 * Pointer event a GPUI window posts back into the engine.
 * @public
 */
export interface NativePointerEvent {
  readonly kind: 'down' | 'move' | 'up';
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly modifier: ReadonlyArray<'shift' | 'ctrl' | 'alt' | 'meta'>;
}

/**
 * Hit-test a pointer against the frame's cell quads. Returns the top-most
 * cell containing (x, y), or null.
 * @public
 */
export function hitTest(frame: NativeFrame, x: number, y: number): NativeCellQuad | null {
  for (let i = frame.cell.length - 1; i >= 0; i--) {
    const c = frame.cell[i]!;
    if (x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height) {
      return c;
    }
  }
  return null;
}
