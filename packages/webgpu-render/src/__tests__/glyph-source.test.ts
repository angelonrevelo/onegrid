import { describe, it, expect } from 'vitest';
import {
  createCanvas2dGlyphSource,
  signedDistanceField,
  type GlyphRasterContext,
} from '../glyph-source.js';

describe('signedDistanceField', () => {
  /** A 9x9 field with a filled 3x3 block in the middle. */
  function blockCoverage(): Uint8Array {
    const coverage = new Uint8Array(81);
    for (let y = 3; y < 6; y++) {
      for (let x = 3; x < 6; x++) coverage[y * 9 + x] = 255;
    }
    return coverage;
  }

  it('encodes the interior above the 0.5 isoline and the exterior below it', () => {
    const pixel = signedDistanceField(blockCoverage(), 9, 9, 4);
    const at = (x: number, y: number): number => pixel[(y * 9 + x) * 4]!;
    expect(at(4, 4)).toBeGreaterThan(128); // centre of the block
    expect(at(0, 0)).toBeLessThan(128); // far corner
    expect(at(8, 8)).toBeLessThan(128);
  });

  it('falls off monotonically with distance from the shape', () => {
    const pixel = signedDistanceField(blockCoverage(), 9, 9, 8);
    const at = (x: number, y: number): number => pixel[(y * 9 + x) * 4]!;
    expect(at(4, 4)).toBeGreaterThan(at(4, 2));
    expect(at(4, 2)).toBeGreaterThan(at(4, 1));
    expect(at(4, 1)).toBeGreaterThan(at(4, 0));
  });

  it('replicates the single channel into rgb so median(rgb) recovers it', () => {
    const pixel = signedDistanceField(blockCoverage(), 9, 9, 4);
    for (let i = 0; i < 81; i++) {
      const o = i * 4;
      expect(pixel[o + 1]).toBe(pixel[o]);
      expect(pixel[o + 2]).toBe(pixel[o]);
      expect(pixel[o + 3]).toBe(pixel[o]);
    }
  });

  it('saturates a wholly-inside field to 255 and a wholly-empty one to 0', () => {
    const full = signedDistanceField(new Uint8Array(16).fill(255), 4, 4, 2);
    const empty = signedDistanceField(new Uint8Array(16), 4, 4, 2);
    expect(full[0]).toBe(255);
    expect(empty[0]).toBe(0);
  });

  it('narrows the falloff as the distance range narrows', () => {
    const wide = signedDistanceField(blockCoverage(), 9, 9, 16);
    const narrow = signedDistanceField(blockCoverage(), 9, 9, 2);
    const at = (p: Uint8Array, x: number, y: number): number => p[(y * 9 + x) * 4]!;
    // Two texels outside the block: a narrow range has already bottomed out.
    expect(at(narrow, 4, 1)).toBeLessThan(at(wide, 4, 1));
  });

  it('rejects a coverage buffer that does not match the dimensions', () => {
    expect(() => signedDistanceField(new Uint8Array(10), 4, 4, 2)).toThrow(
      /OG_SDF_SIZE/,
    );
  });

  it('rejects a non-positive distance range', () => {
    expect(() => signedDistanceField(new Uint8Array(16), 4, 4, 0)).toThrow(
      /OG_SDF_RANGE/,
    );
  });
});

/**
 * A deterministic stand-in for a 2D canvas: every glyph is 10 wide with an
 * 8/2 ascent/descent split, the pair "AV" measures 2px narrower than the sum of
 * its parts (a real kern pair), and the ink is a solid square.
 */
function fakeRasterContext(edge: number): GlyphRasterContext & {
  measureCall: string[];
} {
  const measureCall: string[] = [];
  const pixel = new Uint8Array(edge * edge);
  return {
    measureCall,
    width: edge,
    height: edge,
    setFont: () => undefined,
    measure(text: string) {
      measureCall.push(text);
      const base = 10 * [...text].length;
      const kern = text === 'AV' ? -2 : 0;
      return {
        width: base + kern,
        ascent: 8,
        descent: 2,
        left: 0,
        right: 10,
      };
    },
    clear: () => pixel.fill(0),
    fillText: (_text, x, y) => {
      for (let dy = -4; dy < 4; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const px = Math.round(x) + dx;
          const py = Math.round(y) + dy;
          if (px >= 0 && px < edge && py >= 0 && py < edge) pixel[py * edge + px] = 255;
        }
      }
    },
    readCoverage: () => pixel.slice(),
  };
}

describe('createCanvas2dGlyphSource', () => {
  const build = (): ReturnType<typeof createCanvas2dGlyphSource> =>
    createCanvas2dGlyphSource({
      emPx: 20,
      distanceRangePx: 4,
      createContext: (w) => fakeRasterContext(w),
    });

  it('derives font metrics from the measured "M" box', () => {
    const source = build();
    expect(source.emPx).toBe(20);
    expect(source.ascentPx).toBe(8);
    expect(source.descentPx).toBe(2);
    expect(source.lineHeightPx).toBe(12);
    expect(source.distanceRangePx).toBe(4);
  });

  it('derives a kern pair from the pair-versus-singles measurement identity', () => {
    const source = build();
    expect(source.kernOf(65, 86)).toBe(-2); // "AV"
    expect(source.kernOf(65, 66)).toBe(0); // "AB" has no pair adjustment
  });

  it('memoises advances and kern pairs instead of re-measuring', () => {
    const context = fakeRasterContext(64);
    const source = createCanvas2dGlyphSource({
      emPx: 20,
      createContext: () => context,
    });
    const before = context.measureCall.length;
    source.advanceOf(65);
    source.advanceOf(65);
    source.advanceOf(65);
    source.kernOf(65, 86);
    source.kernOf(65, 86);
    // One measure for "A", one for the pair "AV", one for "V" — no more.
    expect(context.measureCall.length - before).toBe(3);
  });

  it('rasterises a glyph into a padded distance-field bitmap with metrics', () => {
    const source = build();
    const raster = source.rasterize(65)!;
    const pad = 4; // ceil(distanceRangePx)
    expect(raster.bitmap.width).toBe(10 + pad * 2);
    expect(raster.bitmap.height).toBe(10 + pad * 2);
    expect(raster.bitmap.pixel.length).toBe(
      raster.bitmap.width * raster.bitmap.height * 4,
    );
    expect(raster.metric.advance).toBe(10);
    // Pen-relative: the ink starts `pad` texels into the bitmap.
    expect(raster.metric.bearingX).toBe(-pad);
    expect(raster.metric.bearingY).toBe(8 + pad);
  });

  it('caches rasters so a repeated code point never re-runs the transform', () => {
    const source = build();
    expect(source.rasterize(65)).toBe(source.rasterize(65));
  });

  it('throws a diagnosable error when no canvas is available', () => {
    expect(() => createCanvas2dGlyphSource({ createContext: () => null })).toThrow(
      /OG_GLYPH_NO_CANVAS/,
    );
  });
});
