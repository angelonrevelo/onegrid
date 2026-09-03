import { describe, expect, it, vi } from 'vitest';
import { printStylesheet } from '../css';
import {
  captureGrid,
  captureTallGrid,
  planTile,
  type CanvasSource,
  type StitchCanvas,
} from '../screenshot';

describe('@media print stylesheet', () => {
  it('emits @page geometry with a named size and orientation', () => {
    const css = printStylesheet({ size: 'A4', orientation: 'landscape' });
    expect(css).toContain('@page {');
    expect(css).toContain('size: A4 landscape;');
    expect(css).toContain('margin: 36pt 36pt 36pt 36pt;');
  });

  it('emits an explicit point size for a custom page box', () => {
    const css = printStylesheet({ size: { width: 400, height: 300 }, margin: 12 });
    expect(css).toContain('size: 400pt 300pt;');
    expect(css).toContain('margin: 12pt 12pt 12pt 12pt;');
  });

  it('uses table-header-group so the browser repeats the header per page', () => {
    const css = printStylesheet();
    expect(css).toContain('thead {\n    display: table-header-group;\n  }');
    expect(css).toContain('tfoot {\n    display: table-footer-group;\n  }');
  });

  it('drops back to table-row-group when header repetition is disabled', () => {
    const css = printStylesheet({ repeatHeader: false });
    expect(css).toContain('display: table-row-group;');
    expect(css).not.toContain('table-header-group');
  });

  it('asks the fragmenter not to split rows or group headers', () => {
    const css = printStylesheet();
    expect(css).toContain('break-inside: avoid;');
    expect(css).toContain('page-break-inside: avoid;');
    expect(css).toContain('.onegrid-group-header');
  });

  it('hides interactive chrome, including caller-supplied selectors', () => {
    const css = printStylesheet({ hideSelector: ['.my-fab'] });
    expect(css).toContain('.onegrid .onegrid-toolbar');
    expect(css).toContain('.onegrid .onegrid-scrollbar');
    expect(css).toContain('.onegrid .my-fab');
    expect(css).toContain('display: none !important;');
  });

  it('forces exact colour so conditional fills survive the print pipeline', () => {
    expect(printStylesheet()).toContain('print-color-adjust: exact;');
    expect(printStylesheet({ exactColor: false })).not.toContain('print-color-adjust');
  });

  it('expands the virtualised viewport so more than one screenful prints', () => {
    const css = printStylesheet();
    expect(css).toContain('height: auto !important;');
    expect(css).toContain('overflow: visible !important;');
  });

  it('scopes every rule to the supplied selector', () => {
    const css = printStylesheet({ scope: '#report' });
    expect(css).toContain('#report table {');
    expect(css).not.toContain('.onegrid table {');
  });

  it('applies a scale factor as a transform on the grid root', () => {
    expect(printStylesheet({ scaleFactor: 0.8 })).toContain('transform: scale(0.8);');
    expect(printStylesheet({ scaleFactor: 1 })).not.toContain('transform: scale(');
  });

  it('wraps everything but @page inside a print media query', () => {
    const css = printStylesheet();
    expect(css.indexOf('@media print {')).toBeGreaterThan(css.indexOf('@page'));
    expect(css.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('screenshot tiling maths', () => {
  it('returns a single tile when the grid fits the viewport', () => {
    expect(planTile({ totalHeight: 400, viewportHeight: 800 })).toEqual([
      { index: 0, scrollY: 0, sourceY: 0, height: 400, destY: 0 },
    ]);
  });

  it('returns no tile for an empty grid', () => {
    expect(planTile({ totalHeight: 0, viewportHeight: 800 })).toEqual([]);
  });

  it('covers the full height exactly, with contiguous destinations', () => {
    for (const total of [1000, 2400, 5001, 7777]) {
      const tile = planTile({ totalHeight: total, viewportHeight: 600 });
      expect(tile.reduce((a, t) => a + t.height, 0)).toBe(total);
      let cursor = 0;
      for (const t of tile) {
        expect(t.destY).toBe(cursor);
        cursor += t.height;
      }
      expect(cursor).toBe(total);
    }
  });

  it('keeps scrollY + sourceY === destY for every tile', () => {
    for (const t of planTile({ totalHeight: 5001, viewportHeight: 600 })) {
      expect(t.scrollY + t.sourceY).toBe(t.destY);
    }
  });

  it('clamps the final scroll at totalHeight - viewportHeight and trims the duplicate band', () => {
    const tile = planTile({ totalHeight: 1000, viewportHeight: 600 });
    expect(tile).toHaveLength(2);
    expect(tile[1]!.scrollY).toBe(400); // clamped, not 600
    expect(tile[1]!.sourceY).toBe(200); // skip the 200 px already captured
    expect(tile[1]!.height).toBe(400);
    for (const t of tile) expect(t.scrollY).toBeLessThanOrEqual(1000 - 600);
  });

  it('overlap adds seam duplication without changing total coverage', () => {
    const plain = planTile({ totalHeight: 3000, viewportHeight: 500 });
    const lapped = planTile({ totalHeight: 3000, viewportHeight: 500, overlap: 20 });
    expect(lapped.length).toBeGreaterThan(plain.length);
    expect(lapped.reduce((a, t) => a + t.height, 0)).toBe(3000);
    expect(lapped[0]!.height).toBe(480);
  });

  it('terminates on a viewport of zero by treating it as one pixel', () => {
    const tile = planTile({ totalHeight: 3, viewportHeight: 0 });
    expect(tile).toHaveLength(3);
  });
});

// A canvas fake — jsdom has no rasteriser, so the compositing surface is
// injected exactly as the SqliteQueryable pattern prescribes.
function fakeCanvas(width: number, height: number, tag = 'src'): CanvasSource {
  return {
    width,
    height,
    toDataURL: (type = 'image/png') => `data:${type};base64,${tag}-${width}x${height}`,
  };
}

interface DrawCall {
  sourceY: number;
  height: number;
  destY: number;
}

function fakeStitch(
  width: number,
  height: number,
  log: DrawCall[],
): StitchCanvas {
  return {
    width,
    height,
    drawTile: (_source, sourceY, h, destY) => log.push({ sourceY, height: h, destY }),
    toDataURL: (type = 'image/png') => `data:${type};base64,stitched-${width}x${height}`,
    toBlob: (cb) => {
      cb(null);
    },
  };
}

describe('screenshot capture', () => {
  it('captures a single canvas to a data URL', async () => {
    const capture = await captureGrid(fakeCanvas(800, 600), { blob: false });
    expect(capture.dataUrl).toContain('data:image/png;base64,');
    expect(capture).toMatchObject({ width: 800, height: 600, tileCount: 1, blob: null });
  });

  it('honours a lossy type and quality', async () => {
    const canvas = fakeCanvas(100, 100);
    const spy = vi.spyOn(canvas, 'toDataURL');
    await captureGrid(canvas, { type: 'image/jpeg', quality: 0.6, blob: false });
    expect(spy).toHaveBeenCalledWith('image/jpeg', 0.6);
  });

  it('resolves a null blob when the canvas has no toBlob', async () => {
    expect((await captureGrid(fakeCanvas(10, 10))).blob).toBeNull();
  });

  it('stitches a grid taller than the viewport by scrolling and compositing', async () => {
    const log: DrawCall[] = [];
    const scroll: number[] = [];
    const capture = await captureTallGrid(
      {
        canvas: fakeCanvas(800, 600),
        totalHeight: 2000,
        viewportHeight: 600,
        scrollTo: (y) => {
          scroll.push(y);
        },
      },
      { canvasFactory: (w, h) => fakeStitch(w, h, log) },
    );
    expect(capture.height).toBe(2000);
    expect(capture.width).toBe(800);
    expect(capture.tileCount).toBe(4);
    expect(log.reduce((a, d) => a + d.height, 0)).toBe(2000);
    expect(log.map((d) => d.destY)).toEqual([0, 600, 1200, 1800]);
    // Final capture is scroll-clamped at 1400 and contributes only 200 px.
    expect(log[3]).toEqual({ sourceY: 400, height: 200, destY: 1800 });
    expect(scroll).toEqual([0, 600, 1200, 1400, 0]);
  });

  it('awaits the settle hook after every scroll', async () => {
    const settle = vi.fn(() => Promise.resolve());
    await captureTallGrid(
      {
        canvas: fakeCanvas(400, 200),
        totalHeight: 1000,
        viewportHeight: 200,
        scrollTo: () => undefined,
        settle,
      },
      { canvasFactory: (w, h) => fakeStitch(w, h, []) },
    );
    expect(settle).toHaveBeenCalledTimes(5);
  });

  it('restores the caller’s scroll position when finished', async () => {
    const scroll: number[] = [];
    await captureTallGrid(
      {
        canvas: fakeCanvas(400, 200),
        totalHeight: 600,
        viewportHeight: 200,
        scrollY: 350,
        scrollTo: (y) => {
          scroll.push(y);
        },
      },
      { canvasFactory: (w, h) => fakeStitch(w, h, []) },
    );
    expect(scroll[scroll.length - 1]).toBe(350);
  });

  it('rejects a zero-height grid rather than emitting an empty image', async () => {
    await expect(
      captureTallGrid(
        { canvas: fakeCanvas(10, 10), totalHeight: 0, viewportHeight: 10, scrollTo: () => undefined },
        { canvasFactory: (w, h) => fakeStitch(w, h, []) },
      ),
    ).rejects.toThrow(/totalHeight/);
  });
});
