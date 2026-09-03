// =============================================================================
// GlyphSource — where the atlas gets its pixels from.
//
// Producing a true multi-channel SDF requires the glyph's Bezier outlines, and
// getting outlines requires a font parser (opentype.js, fontkit) plus msdfgen's
// edge-colouring algorithm. Bundling either would blow the dependency budget
// and force every adopter to ship a font pipeline they may not want. So the
// package inverts the dependency: GlyphSource is a narrow injectable interface
// (the same pattern SqliteQueryable uses in the SQLite adapter). An adopter who
// already bakes MSDF offline implements it in ten lines over their own atlas.
//
// But an interface with no implementation is a stub, so we ship a working
// fallback: createCanvas2dGlyphSource() rasterises each glyph with a 2D canvas,
// reads the coverage (alpha) channel, and converts it to a signed distance
// field with an exact Euclidean distance transform. That single-channel SDF is
// written into all three colour channels, which is not a decorative choice: the
// MSDF shader reconstructs distance with median(r, g, b), and median(x, x, x)
// is exactly x. A replicated SDF is therefore a valid *degenerate* MSDF and
// flows through the identical shader, sampler and atlas path — no branch, no
// second pipeline. What you lose versus real MSDF is corner sharpness at large
// scale, which is the documented trade for having zero font dependencies.
//
// The distance transform is Felzenszwalb & Huttenlocher's exact O(n) algorithm
// (2012), run once over the "inside" set and once over the "outside" set. The
// naive alternative — a brute-force nearest-edge search — is O(n^2) per glyph
// and would cost tens of milliseconds on a 64px glyph, which is a visible hitch
// when a column of new characters scrolls into view.
// =============================================================================

/** Per-glyph metrics, in pixels at the source's rasterisation size. */
export interface GlyphMetric {
  readonly codePoint: number;
  /** Pen advance after drawing this glyph, before kerning. */
  readonly advance: number;
  /** Horizontal offset from the pen to the bitmap's left edge. */
  readonly bearingX: number;
  /** Vertical offset from the baseline UP to the bitmap's top edge. */
  readonly bearingY: number;
  /** Bitmap dimensions, including the distance-field padding. */
  readonly width: number;
  readonly height: number;
}

/** RGBA8 pixel block for one glyph. `pixel.length === width * height * 4`. */
export interface GlyphBitmap {
  readonly width: number;
  readonly height: number;
  readonly pixel: Uint8Array;
}

/** A rasterised glyph: metrics plus the distance-field bitmap. */
export interface GlyphRaster {
  readonly metric: GlyphMetric;
  readonly bitmap: GlyphBitmap;
}

/**
 * Metric-only view of a font. Text measurement and layout need nothing else,
 * so they take this rather than the full GlyphSource — which keeps the layout
 * tests pure, with no rasterisation anywhere near them.
 */
export interface GlyphMetricSource {
  readonly emPx: number;
  readonly ascentPx: number;
  readonly descentPx: number;
  readonly lineHeightPx: number;
  /** Advance width of one code point, in px at emPx. */
  advanceOf(codePoint: number): number;
  /** Kerning adjustment applied between an adjacent pair. Usually negative. */
  kernOf(leftCodePoint: number, rightCodePoint: number): number;
}

/** The atlas's supplier of glyph pixels. Implement this to bring your own font
 *  pipeline; or use createCanvas2dGlyphSource() and ship today. */
export interface GlyphSource extends GlyphMetricSource {
  readonly fontFamily: string;
  /**
   * Distance range baked into the field, in px. The shader needs it to scale
   * the field into screen space (see screenPxRange in msdf.ts).
   */
  readonly distanceRangePx: number;
  /** Rasterise one code point. Returns null for a glyph the font cannot draw
   *  (which the atlas treats as a blank advance, never as an error). */
  rasterize(codePoint: number): GlyphRaster | null;
}

// -----------------------------------------------------------------------------
// Exact Euclidean signed distance field
// -----------------------------------------------------------------------------

/**
 * One-dimensional squared-distance transform of a sampled function (the lower
 * envelope of a set of parabolas). This is the inner loop of Felzenszwalb &
 * Huttenlocher; both passes of the 2D transform call it.
 *
 * `f` is the input row, `d` receives the result, and `v`/`z` are scratch arrays
 * the caller hoists out of the loop so a 64x64 glyph does not allocate 128
 * times.
 */
function distanceTransform1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q]!;
    let s = 0;
    for (;;) {
      const vk = v[k]!;
      s = (fq + q * q - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
      if (s <= z[k]!) {
        k--;
        continue;
      }
      break;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const vk = v[k]!;
    d[q] = (q - vk) * (q - vk) + f[vk]!;
  }
}

/**
 * Full 2D squared-distance transform: distance from every cell to the nearest
 * cell where `mask` is true.
 */
function distanceTransform2d(
  mask: Uint8Array,
  width: number,
  height: number,
): Float64Array {
  const INF = 1e20;
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? 0 : INF;

  const span = Math.max(width, height);
  const f = new Float64Array(span);
  const d = new Float64Array(span);
  const v = new Int32Array(span);
  const z = new Float64Array(span + 1);

  // Columns first, then rows — the separable order the algorithm requires.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]!;
    distanceTransform1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]!;
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = grid[row + x]!;
    distanceTransform1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[row + x] = d[x]!;
  }
  return grid;
}

/**
 * Convert an 8-bit coverage bitmap (alpha of a rasterised glyph) into an RGBA8
 * signed distance field, encoded the way msdfgen does: 0.5 sits exactly on the
 * outline, values above 0.5 are inside, and `distanceRangePx` is the total
 * width in px that the 0..1 range spans.
 *
 * The single channel is replicated into r, g and b so median(rgb) recovers it
 * unchanged, and copied to alpha so a host that prefers an alpha-only sampler
 * needs no separate encode. Exported because it is the piece worth unit-testing
 * directly — it is pure, and a wrong sign here shows up as glyphs rendered
 * inside-out.
 */
export function signedDistanceField(
  coverage: Uint8Array,
  width: number,
  height: number,
  distanceRangePx: number,
): Uint8Array {
  if (coverage.length !== width * height) {
    throw new Error(
      `[OG_SDF_SIZE] coverage length ${coverage.length} != ${width}x${height}`,
    );
  }
  if (distanceRangePx <= 0) {
    throw new Error('[OG_SDF_RANGE] distanceRangePx must be > 0');
  }

  const inside = new Uint8Array(width * height);
  const outside = new Uint8Array(width * height);
  for (let i = 0; i < inside.length; i++) {
    // 128 is the half-coverage isoline: the antialiased edge the rasteriser
    // produced is where the true outline lies.
    const isInside = coverage[i]! >= 128 ? 1 : 0;
    inside[i] = isInside;
    outside[i] = isInside ? 0 : 1;
  }

  const toInside = distanceTransform2d(inside, width, height);
  const toOutside = distanceTransform2d(outside, width, height);

  const pixel = new Uint8Array(width * height * 4);
  const half = distanceRangePx / 2;
  for (let i = 0; i < inside.length; i++) {
    // Positive inside, negative outside. A pixel inside the shape has distance
    // 0 to the inside set, so its signed distance is its distance to the
    // outside set, and vice versa.
    const signed = Math.sqrt(toOutside[i]!) - Math.sqrt(toInside[i]!);
    const normalized = 0.5 + signed / (2 * half);
    const byte = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    const o = i * 4;
    pixel[o] = byte;
    pixel[o + 1] = byte;
    pixel[o + 2] = byte;
    pixel[o + 3] = byte;
  }
  return pixel;
}

// -----------------------------------------------------------------------------
// Canvas-2D fallback source
// -----------------------------------------------------------------------------

/**
 * The 2D-canvas operations the fallback source needs. Injectable so the tests
 * can drive the whole rasterise-and-encode path with a deterministic fake — a
 * real OffscreenCanvas does not exist in Node, and mocking `document` wholesale
 * would test the mock rather than the code.
 */
export interface GlyphRasterContext {
  readonly width: number;
  readonly height: number;
  /** Assign a CSS font shorthand, e.g. "48px Inter, sans-serif". */
  setFont(css: string): void;
  /** TextMetrics subset. `ascent`/`descent` come from the actual bounding box. */
  measure(text: string): {
    width: number;
    ascent: number;
    descent: number;
    left: number;
    right: number;
  };
  clear(): void;
  fillText(text: string, x: number, y: number): void;
  /** Alpha channel of the canvas, row-major, length width * height. */
  readCoverage(): Uint8Array;
}

export interface Canvas2dGlyphSourceOption {
  /** CSS font family list. Default: the platform UI sans stack. */
  readonly fontFamily?: string;
  /** Rasterisation size. 48 is the sweet spot: sharp down to 10px on screen
   *  without burning atlas area. */
  readonly emPx?: number;
  /** Distance range in px. msdfgen's default of 4 at em=32 scales to 6 at 48. */
  readonly distanceRangePx?: number;
  /** Extra px around the glyph so the field has room to fall off. Defaults to
   *  ceil(distanceRangePx), below which the field clips at the bitmap edge. */
  readonly padPx?: number;
  /** Injected canvas. Defaults to OffscreenCanvas, then document.createElement. */
  readonly createContext?: (
    width: number,
    height: number,
  ) => GlyphRasterContext | null;
}

const DEFAULT_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Build a GlyphRasterContext over a real 2D canvas, or null if there is none. */
function defaultRasterContext(
  width: number,
  height: number,
): GlyphRasterContext | null {
  type Ctx2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  let ctx: Ctx2d | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    ctx = new OffscreenCanvas(width, height).getContext('2d', {
      willReadFrequently: true,
    });
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) return null;
  const context = ctx;
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#fff';
  return {
    width,
    height,
    setFont: (css) => {
      context.font = css;
    },
    measure: (text) => {
      const m = context.measureText(text);
      return {
        width: m.width,
        ascent: m.actualBoundingBoxAscent,
        descent: m.actualBoundingBoxDescent,
        left: m.actualBoundingBoxLeft,
        right: m.actualBoundingBoxRight,
      };
    },
    clear: () => context.clearRect(0, 0, width, height),
    fillText: (text, x, y) => {
      context.fillStyle = '#fff';
      context.fillText(text, x, y);
    },
    readCoverage: () => {
      const data = context.getImageData(0, 0, width, height).data;
      const coverage = new Uint8Array(width * height);
      for (let i = 0; i < coverage.length; i++) coverage[i] = data[i * 4 + 3]!;
      return coverage;
    },
  };
}

/**
 * A GlyphSource backed by a 2D canvas. Real kerning: the canvas exposes no
 * kern table, but `measure(left + right) - measure(left) - measure(right)` is
 * exactly the pair adjustment the shaper would have applied, because the 2D
 * context applies the font's kern/GPOS data when it measures a two-character
 * string. That identity is what makes kerning work here without a font parser,
 * and it is memoised per pair because measureText is not cheap.
 *
 * Throws if no canvas exists and none was injected — a silent no-op source
 * would render an empty grid, which is the one outcome oneGrid forbids.
 */
export function createCanvas2dGlyphSource(
  option: Canvas2dGlyphSourceOption = {},
): GlyphSource {
  const emPx = option.emPx ?? 48;
  const distanceRangePx = option.distanceRangePx ?? 6;
  const padPx = option.padPx ?? Math.ceil(distanceRangePx);
  const fontFamily = option.fontFamily ?? DEFAULT_FONT_FAMILY;
  const fontCss = `${emPx}px ${fontFamily}`;
  // 2x em plus padding covers every Latin/CJK glyph a UI font draws; a glyph
  // wider than that is clipped rather than allowed to corrupt the atlas.
  const canvasEdge = Math.ceil(emPx * 2 + padPx * 2);

  const make = option.createContext ?? defaultRasterContext;
  const context = make(canvasEdge, canvasEdge);
  if (!context) {
    throw new Error(
      '[OG_GLYPH_NO_CANVAS] no 2D canvas available — inject option.createContext or supply your own GlyphSource',
    );
  }
  context.setFont(fontCss);

  const spaceMetric = context.measure(' ');
  const emMetric = context.measure('M');
  const ascentPx = emMetric.ascent > 0 ? emMetric.ascent : emPx * 0.8;
  const descentPx = emMetric.descent > 0 ? emMetric.descent : emPx * 0.2;
  const lineHeightPx = Math.ceil((ascentPx + descentPx) * 1.2);

  const advanceCache = new Map<number, number>();
  const kernCache = new Map<number, number>();
  const rasterCache = new Map<number, GlyphRaster | null>();

  const advanceOf = (codePoint: number): number => {
    const hit = advanceCache.get(codePoint);
    if (hit !== undefined) return hit;
    const width =
      codePoint === 32
        ? spaceMetric.width
        : context.measure(String.fromCodePoint(codePoint)).width;
    advanceCache.set(codePoint, width);
    return width;
  };

  const kernOf = (left: number, right: number): number => {
    // Pack the pair into one number so the cache is a flat Map rather than a
    // Map of Maps. Code points above 0x10FFFF do not exist, so 21 bits is safe
    // and the product stays inside the f64 integer range.
    const key = left * 0x110000 + right;
    const hit = kernCache.get(key);
    if (hit !== undefined) return hit;
    const pair = context.measure(
      String.fromCodePoint(left) + String.fromCodePoint(right),
    ).width;
    const kern = pair - advanceOf(left) - advanceOf(right);
    // Sub-1/64px noise is float error in measureText, not a real kern pair.
    const cleaned = Math.abs(kern) < 1 / 64 ? 0 : kern;
    kernCache.set(key, cleaned);
    return cleaned;
  };

  const rasterize = (codePoint: number): GlyphRaster | null => {
    if (rasterCache.has(codePoint)) return rasterCache.get(codePoint) ?? null;
    const char = String.fromCodePoint(codePoint);
    const metric = context.measure(char);
    const inkWidth = Math.ceil(metric.left + metric.right);
    const inkHeight = Math.ceil(metric.ascent + metric.descent);
    if (inkWidth <= 0 || inkHeight <= 0) {
      // Whitespace and unmapped code points have no ink. That is not an error:
      // the layout still advances the pen, the atlas just stores nothing.
      rasterCache.set(codePoint, null);
      return null;
    }
    const width = Math.min(canvasEdge, inkWidth + padPx * 2);
    const height = Math.min(canvasEdge, inkHeight + padPx * 2);

    context.clear();
    // Draw with the pen placed so the ink lands inside the padded box.
    context.fillText(char, padPx + metric.left, padPx + metric.ascent);
    const full = context.readCoverage();

    // Crop the full canvas down to the padded glyph box before the distance
    // transform: the transform is linear in pixel count, and cropping a 108px
    // canvas to a 40px box is a 7x saving on every cache miss.
    const coverage = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const src = y * context.width;
      coverage.set(full.subarray(src, src + width), y * width);
    }

    const raster: GlyphRaster = {
      metric: {
        codePoint,
        advance: advanceOf(codePoint),
        bearingX: -metric.left - padPx,
        bearingY: metric.ascent + padPx,
        width,
        height,
      },
      bitmap: {
        width,
        height,
        pixel: signedDistanceField(coverage, width, height, distanceRangePx),
      },
    };
    rasterCache.set(codePoint, raster);
    return raster;
  };

  return {
    fontFamily,
    emPx,
    ascentPx,
    descentPx,
    lineHeightPx,
    distanceRangePx,
    advanceOf,
    kernOf,
    rasterize,
  };
}
