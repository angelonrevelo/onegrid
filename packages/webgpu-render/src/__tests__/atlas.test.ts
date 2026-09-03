import { describe, it, expect } from 'vitest';
import { createGlyphAtlas, type AtlasQueue } from '../atlas.js';
import { createFakeGlyphSource, type RecordedCall } from './fake-gpu.js';

/** Records every writeTexture so the tests can assert on the upload rects. */
function recordingQueue(): { queue: AtlasQueue; call: RecordedCall[] } {
  const call: RecordedCall[] = [];
  return {
    call,
    queue: {
      writeTexture(destination, data, dataLayout, size): void {
        call.push({
          kind: 'writeTexture',
          arg: {
            x: destination.origin?.x ?? 0,
            y: destination.origin?.y ?? 0,
            width: size.width,
            height: size.height,
            bytesPerRow: dataLayout.bytesPerRow,
            rowsPerImage: dataLayout.rowsPerImage,
            byteLength: ArrayBuffer.isView(data)
              ? data.byteLength
              : (data as ArrayBuffer).byteLength,
          },
        });
      },
    },
  };
}

const fakeTexture = { label: 'atlas' } as unknown as GPUTexture;

function makeAtlas(
  width = 32,
  height = 32,
  source = createFakeGlyphSource(),
): ReturnType<typeof createGlyphAtlas> & { call: RecordedCall[] } {
  const { queue, call } = recordingQueue();
  const atlas = createGlyphAtlas({
    source,
    queue,
    texture: fakeTexture,
    width,
    height,
  });
  return Object.assign(atlas, { call });
}

describe('shelf packing', () => {
  it('places the first glyph at the origin and uploads only its rect', () => {
    const atlas = makeAtlas();
    const entry = atlas.get(65)!;
    expect(entry.x).toBe(0);
    expect(entry.y).toBe(0);
    expect(atlas.call).toHaveLength(1);
    expect(atlas.call[0]!.arg).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      bytesPerRow: 40,
      rowsPerImage: 10,
      byteLength: 400,
    });
  });

  it('advances the shelf cursor by width plus padding', () => {
    const atlas = makeAtlas();
    atlas.get(65);
    const second = atlas.get(66)!;
    const third = atlas.get(67)!;
    expect(second.x).toBe(11);
    expect(third.x).toBe(22);
    expect(second.y).toBe(0);
    expect(third.y).toBe(0);
    expect(atlas.stat().shelfCount).toBe(1);
  });

  it('opens a new shelf when the current one runs out of width', () => {
    const atlas = makeAtlas();
    for (const cp of [65, 66, 67]) atlas.get(cp);
    const fourth = atlas.get(68)!;
    expect(fourth.x).toBe(0);
    expect(fourth.y).toBe(11);
    expect(atlas.stat().shelfCount).toBe(2);
  });

  it('reuses a shelf for a glyph within the height slack, not for a taller one', () => {
    const source = createFakeGlyphSource({
      glyphSize: (cp) =>
        cp === 65 ? { width: 8, height: 10 } : { width: 8, height: 12 },
    });
    // 12 > 10, so the taller glyph cannot share the 10-tall shelf.
    const atlas = makeAtlas(64, 64, source);
    const first = atlas.get(65)!;
    const second = atlas.get(66)!;
    expect(first.y).toBe(0);
    expect(second.y).toBe(11);
    expect(atlas.stat().shelfCount).toBe(2);
  });

  it('computes the UV rect from the packed position', () => {
    const atlas = makeAtlas(100, 50);
    atlas.get(65);
    const second = atlas.get(66)!;
    expect(second.u0).toBeCloseTo(0.11);
    expect(second.u1).toBeCloseTo(0.21);
    expect(second.v0).toBeCloseTo(0);
    expect(second.v1).toBeCloseTo(0.2);
  });
});

describe('incremental upload', () => {
  it('does not re-upload a glyph that is already resident', () => {
    const atlas = makeAtlas();
    atlas.get(65);
    atlas.get(65);
    atlas.get(65);
    expect(atlas.call).toHaveLength(1);
    expect(atlas.stat().hitCount).toBe(2);
    expect(atlas.stat().missCount).toBe(1);
  });

  it('uploads each new glyph into its own sub-rect, never the whole atlas', () => {
    const atlas = makeAtlas();
    atlas.get(65);
    atlas.get(66);
    expect(atlas.call.map((c) => [c.arg['x'], c.arg['y'], c.arg['width']])).toEqual([
      [0, 0, 10],
      [11, 0, 10],
    ]);
    // The atlas is 32x32 = 4096 texels; the two uploads together touch 200.
    const uploaded = atlas.call.reduce(
      (sum, c) => sum + (c.arg['width'] as number) * (c.arg['height'] as number),
      0,
    );
    expect(uploaded).toBe(200);
    expect(atlas.stat().uploadByteTotal).toBe(800);
  });
});

describe('LRU eviction', () => {
  it('evicts the least recently used shelf and reuses its space', () => {
    // 21x21 fits exactly two 10-tall shelves of two glyphs each.
    const atlas = makeAtlas(21, 21);
    atlas.beginFrame(1);
    atlas.get(65);
    atlas.get(66);
    atlas.beginFrame(2);
    atlas.get(67);
    atlas.get(68);
    expect(atlas.stat().shelfCount).toBe(2);
    expect(atlas.stat().evictionCount).toBe(0);

    atlas.beginFrame(3);
    const evicting = atlas.get(69)!;
    expect(atlas.stat().evictionCount).toBe(1);
    // Shelf 0 (last used in frame 1) is the victim, so the new glyph lands there.
    expect(evicting.y).toBe(0);
    expect(evicting.x).toBe(0);
    expect(atlas.has(65)).toBe(false);
    expect(atlas.has(66)).toBe(false);
    expect(atlas.has(67)).toBe(true);
  });

  it('refuses rather than evicting a glyph the current frame is using', () => {
    const atlas = makeAtlas(21, 21);
    atlas.beginFrame(1);
    atlas.get(65);
    atlas.get(66);
    atlas.get(67);
    atlas.get(68);
    // Every shelf holds a glyph from frame 1, so nothing may be evicted.
    const refused = atlas.get(69);
    expect(refused).toBeNull();
    expect(atlas.lastMiss()).toEqual({ codePoint: 69, reason: 'atlas-full' });
    expect(atlas.stat().evictionCount).toBe(0);
    expect(atlas.stat().refusalCount).toBe(1);
  });

  it('keeps a touched glyph resident across frames', () => {
    const atlas = makeAtlas(21, 21);
    atlas.beginFrame(1);
    atlas.get(65);
    atlas.get(66); // fills shelf 0
    atlas.beginFrame(2);
    atlas.get(67);
    atlas.get(68); // fills shelf 1
    atlas.beginFrame(3);
    atlas.get(65); // touch shelf 0, making shelf 1 the least recently used
    atlas.get(70); // no room anywhere — forces one eviction
    expect(atlas.stat().evictionCount).toBe(1);
    expect(atlas.has(65)).toBe(true);
    expect(atlas.has(67)).toBe(false);
    expect(atlas.has(68)).toBe(false);
  });
});

describe('refusals', () => {
  it('reports no-ink for a glyph the source cannot draw', () => {
    const atlas = makeAtlas();
    expect(atlas.get(32)).toBeNull();
    expect(atlas.lastMiss()).toEqual({ codePoint: 32, reason: 'no-ink' });
    expect(atlas.call).toHaveLength(0);
  });

  it('reports too-large for a glyph bigger than the atlas', () => {
    const atlas = makeAtlas(16, 16, createFakeGlyphSource({
      glyphSize: () => ({ width: 64, height: 64 }),
    }));
    expect(atlas.get(65)).toBeNull();
    expect(atlas.lastMiss()?.reason).toBe('too-large');
  });

  it('rejects a non-positive atlas size at construction', () => {
    expect(() =>
      createGlyphAtlas({
        source: createFakeGlyphSource(),
        queue: recordingQueue().queue,
        texture: fakeTexture,
        width: 0,
        height: 32,
      }),
    ).toThrow(/OG_ATLAS_SIZE/);
  });
});

describe('reset', () => {
  it('drops every entry and shelf so a new device starts clean', () => {
    const atlas = makeAtlas();
    atlas.get(65);
    atlas.get(66);
    expect(atlas.stat().entryCount).toBe(2);
    atlas.reset();
    expect(atlas.stat().entryCount).toBe(0);
    expect(atlas.stat().shelfCount).toBe(0);
    expect(atlas.stat().occupancy).toBe(0);
    // A get after reset re-uploads, because the texture is presumed gone.
    atlas.get(65);
    expect(atlas.call).toHaveLength(3);
  });
});
