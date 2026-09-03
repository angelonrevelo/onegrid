// =============================================================================
// Screenshot capture, with the tall-grid case treated as the normal one.
//
// `canvas.toDataURL()` on a oneGrid canvas captures the VIEWPORT — for a
// virtualised grid that is forty visible rows out of two hundred thousand.
// A screenshot feature that silently exports 0.02% of the data is worse than
// no feature, so the tiling path here is the primary path: scroll, capture,
// scroll, capture, and composite the strips into one tall image.
//
// The interesting part is the stitching arithmetic, and the reason it is not
// simply `y += viewportHeight`:
//
//   The LAST tile cannot scroll to `totalHeight - something`; a scroll port
//   clamps at `totalHeight - viewportHeight`. So the final capture re-shows
//   content already captured, and the compositor must take only the unseen
//   BOTTOM slice of it. Every tile therefore carries both `scrollY` (where to
//   scroll) and `sourceY` (how far into that capture the new content starts),
//   with the invariant `scrollY + sourceY === destY`. Ignoring this is why
//   naive stitchers produce a duplicated final band.
//
//   `overlap` shrinks each advance by a few pixels so a sticky header or a
//   partially-rendered row at a tile seam is covered twice rather than zero
//   times. It never changes total coverage — the tile heights still sum to
//   exactly `totalHeight`.
//
// Everything DOM-touching is behind a narrow injectable interface, following
// the repo's `SqliteQueryable` pattern, so the maths is testable without a
// real 2D canvas (jsdom has no rasteriser).
// =============================================================================

// -----------------------------------------------------------------------------
// Injectable surfaces
// -----------------------------------------------------------------------------

/**
 * The subset of `HTMLCanvasElement` this package needs. A real canvas
 * satisfies it structurally; a test fake is a dozen lines.
 * @public
 */
export interface CanvasSource {
  readonly width: number;
  readonly height: number;
  toDataURL(type?: string, quality?: number): string;
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

/**
 * A compositing surface the tiler draws strips into.
 * @public
 */
export interface StitchCanvas extends CanvasSource {
  /** Copy `height` pixels starting at `sourceY` of `source` to `destY`. */
  drawTile(source: CanvasSource, sourceY: number, height: number, destY: number): void;
}

/** @public */
export type StitchCanvasFactory = (width: number, height: number) => StitchCanvas;

/**
 * A scrollable grid the tiler can drive. `scrollTo` may return a promise —
 * an adopter that re-renders asynchronously resolves it once the frame is
 * painted.
 * @public
 */
export interface ScrollableGridSource {
  readonly canvas: CanvasSource;
  /** Full scrollable content height in device pixels. */
  readonly totalHeight: number;
  /** Visible height in device pixels — the height of one capture. */
  readonly viewportHeight: number;
  /** Content width in device pixels. Defaults to the canvas width. */
  readonly width?: number;
  /** Scroll position to restore when capture finishes. Default 0. */
  readonly scrollY?: number;
  scrollTo(y: number): void | Promise<void>;
  /** Optional hook awaited after each scroll, e.g. one animation frame. */
  settle?: () => void | Promise<void>;
}

// -----------------------------------------------------------------------------
// Tiling maths
// -----------------------------------------------------------------------------

/** @public */
export interface CaptureTile {
  readonly index: number;
  /** Where to scroll the grid before capturing. */
  readonly scrollY: number;
  /** Offset into the capture at which unseen content begins. */
  readonly sourceY: number;
  /** How many pixels of that capture to keep. */
  readonly height: number;
  /** Where the kept strip lands in the composite. */
  readonly destY: number;
}

/** @public */
export interface TilePlanOption {
  readonly totalHeight: number;
  readonly viewportHeight: number;
  /** Pixels of deliberate duplication at each seam. Default 0. */
  readonly overlap?: number;
}

/**
 * Plan the scroll-and-capture passes needed to image a grid taller than its
 * viewport.
 *
 * Guarantees, all asserted in the test suite:
 *   - tile heights sum to exactly `totalHeight`
 *   - destinations are contiguous from 0 with no gap and no double-write
 *   - `scrollY + sourceY === destY` for every tile
 *   - `scrollY` never exceeds `totalHeight - viewportHeight`
 * @public
 */
export function planTile(option: TilePlanOption): CaptureTile[] {
  const total = Math.max(0, option.totalHeight);
  const viewport = Math.max(1, option.viewportHeight);
  const overlap = Math.max(0, option.overlap ?? 0);
  if (total === 0) return [];
  if (total <= viewport) {
    return [{ index: 0, scrollY: 0, sourceY: 0, height: total, destY: 0 }];
  }

  const maxScroll = total - viewport;
  const tile: CaptureTile[] = [];
  let destY = 0;
  while (destY < total) {
    const scrollY = Math.min(destY, maxScroll);
    const sourceY = destY - scrollY;
    const remaining = total - destY;
    const usable = viewport - sourceY;
    // Only trim for overlap when more tiles will follow; the final strip must
    // reach the bottom exactly.
    const height = remaining <= usable ? remaining : Math.max(1, usable - overlap);
    tile.push({ index: tile.length, scrollY, sourceY, height, destY });
    destY += height;
  }
  return tile;
}

// -----------------------------------------------------------------------------
// Capture
// -----------------------------------------------------------------------------

/** @public */
export interface CaptureOption {
  /** Image MIME type. Default `image/png` — lossless, which a grid needs. */
  readonly type?: string;
  /** Quality 0..1 for lossy types. Ignored for PNG. */
  readonly quality?: number;
  /** Also produce a Blob when the canvas supports `toBlob`. Default true. */
  readonly blob?: boolean;
  /** Overlap in pixels for the tiled path. Default 0. */
  readonly overlap?: number;
  /** Compositing surface factory. Defaults to a real DOM canvas. */
  readonly canvasFactory?: StitchCanvasFactory;
}

/** @public */
export interface GridCapture {
  readonly dataUrl: string;
  readonly blob: Blob | null;
  readonly width: number;
  readonly height: number;
  readonly type: string;
  /** How many scroll-and-capture passes produced this image. */
  readonly tileCount: number;
}

function toBlobAsync(
  canvas: CanvasSource,
  type: string,
  quality: number | undefined,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((b) => {
      resolve(b);
    }, type, quality);
  });
}

/**
 * Capture a single canvas — the visible grid — as a PNG (or other type).
 * Returns both a data URL and, where available, a Blob: the data URL is what
 * an `<img src>` or a clipboard write wants, the Blob is what an upload
 * wants, and producing both costs one extra encode only when asked.
 * @public
 */
export async function captureGrid(
  canvas: CanvasSource,
  option: CaptureOption = {},
): Promise<GridCapture> {
  const type = option.type ?? 'image/png';
  const dataUrl = canvas.toDataURL(type, option.quality);
  const blob = option.blob === false ? null : await toBlobAsync(canvas, type, option.quality);
  return {
    dataUrl,
    blob,
    width: canvas.width,
    height: canvas.height,
    type,
    tileCount: 1,
  };
}

/**
 * Default compositing surface: a real DOM canvas.
 * @public
 */
export function domStitchCanvas(width: number, height: number): StitchCanvas {
  if (typeof document === 'undefined') {
    throw new Error('@onegrid/print: no document — supply option.canvasFactory.');
  }
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('@onegrid/print: 2D context unavailable.');
  return {
    get width() {
      return el.width;
    },
    get height() {
      return el.height;
    },
    drawTile(source, sourceY, h, destY) {
      ctx.drawImage(
        source as unknown as CanvasImageSource,
        0,
        sourceY,
        width,
        h,
        0,
        destY,
        width,
        h,
      );
    },
    toDataURL: (type, quality) => el.toDataURL(type, quality),
    toBlob: (cb, type, quality) => {
      el.toBlob(cb, type, quality);
    },
  };
}

/**
 * Capture a grid taller than its viewport by scrolling, capturing and
 * stitching. This is the real screenshot use case; `captureGrid` is the
 * degenerate one-tile case of it.
 * @public
 */
export async function captureTallGrid(
  source: ScrollableGridSource,
  option: CaptureOption = {},
): Promise<GridCapture> {
  const width = source.width ?? source.canvas.width;
  const tile = planTile({
    totalHeight: source.totalHeight,
    viewportHeight: source.viewportHeight,
    ...(option.overlap !== undefined ? { overlap: option.overlap } : {}),
  });
  if (tile.length === 0) {
    throw new Error('@onegrid/print captureTallGrid: totalHeight must be positive.');
  }

  const factory = option.canvasFactory ?? domStitchCanvas;
  const target = factory(width, source.totalHeight);

  for (const t of tile) {
    await source.scrollTo(t.scrollY);
    if (source.settle) await source.settle();
    target.drawTile(source.canvas, t.sourceY, t.height, t.destY);
  }
  // Put the user's grid back where they left it.
  await source.scrollTo(source.scrollY ?? 0);

  const type = option.type ?? 'image/png';
  const dataUrl = target.toDataURL(type, option.quality);
  const blob = option.blob === false ? null : await toBlobAsync(target, type, option.quality);
  return {
    dataUrl,
    blob,
    width,
    height: source.totalHeight,
    type,
    tileCount: tile.length,
  };
}
