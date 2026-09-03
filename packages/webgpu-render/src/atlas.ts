// =============================================================================
// Dynamic glyph atlas — shelf packing, LRU eviction, incremental upload.
//
// A static baked atlas is the wrong shape for a grid. A grid renders whatever
// the data contains: a Japanese column, a currency column and an emoji column
// can all scroll into view in the same second, and no offline bake covers that
// set. So the atlas is dynamic — glyphs are rasterised on first sight and
// uploaded into free space in a single GPU texture.
//
// Three decisions carry this file.
//
// 1. SHELF (skyline-lite) PACKING, not a general 2D bin packer. Glyphs from one
//    font at one size cluster tightly around a single height, which is the case
//    shelf packing is optimal for and the case where a full skyline or MAXRECTS
//    packer spends its extra time for nothing. Shelves also make eviction
//    tractable: a shelf is a contiguous horizontal band, so reclaiming one
//    yields usable space, whereas evicting scattered rectangles yields a
//    fragmented hole nothing fits into. That second property is the real reason
//    for the choice — the packer and the evictor have to agree on a geometry.
//
// 2. LRU EVICTION AT SHELF GRANULARITY, with the current frame pinned. When the
//    atlas fills, we evict the shelf whose most-recently-used glyph is oldest,
//    then retry the allocation. A glyph touched during the frame being built is
//    pinned and its shelf cannot be evicted, which is what stops a viewport
//    wider than the atlas from evicting the glyph it drew two cells ago and
//    looping forever. When every shelf is pinned we refuse the allocation and
//    report it, and the renderer draws that cell without text rather than
//    corrupting the atlas.
//
// 3. INCREMENTAL SUB-RECT UPLOAD. Each newly rasterised glyph is written with
//    one writeTexture into exactly its own rectangle. Re-uploading the whole
//    2048-square atlas would move 16 MB across PCIe for one new comma, at
//    roughly 2 ms per upload — which is the entire frame budget. The sub-rect
//    write moves a few kilobytes. This is the whole point of a dynamic atlas,
//    and the tests assert on the recorded origin and size of every write.
// =============================================================================

import type { GlyphSource, GlyphRaster } from './glyph-source.js';

/**
 * The one GPUQueue method the atlas calls. Narrow on purpose: a real GPUQueue
 * satisfies it structurally, and the test fake records every call.
 */
export interface AtlasQueue {
  writeTexture(
    destination: { texture: GPUTexture; origin?: { x: number; y: number } },
    data: ArrayBufferView | ArrayBufferLike,
    dataLayout: { offset?: number; bytesPerRow: number; rowsPerImage: number },
    size: { width: number; height: number; depthOrArrayLayers?: number },
  ): void;
}

/** Where a glyph lives in the atlas, plus everything layout needs. */
export interface AtlasEntry {
  readonly codePoint: number;
  /** Texel rect inside the atlas texture. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Normalised UV rect, precomputed so the hot path never divides. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
  /** Frame index of the most recent touch — the LRU key. */
  lastUsedFrame: number;
  /** Index into the shelf list, so eviction can find its neighbours. */
  readonly shelfIndex: number;
}

interface Shelf {
  readonly y: number;
  /** Fixed once opened: a shelf's height is set by its first glyph. */
  height: number;
  cursorX: number;
  /** Code points currently living on this shelf. */
  member: Set<number>;
  lastUsedFrame: number;
}

export interface GlyphAtlasOption {
  readonly source: GlyphSource;
  readonly queue: AtlasQueue;
  readonly texture: GPUTexture;
  /** Atlas edge in texels. Must not exceed the adapter's maxTextureDimension2D. */
  readonly width: number;
  readonly height: number;
  /** Texels of separation between packed glyphs so bilinear sampling of one
   *  glyph never bleeds a neighbour in. 1 is enough for a non-mipmapped atlas. */
  readonly padding?: number;
  /**
   * A shelf accepts a glyph up to this factor taller than its own height was
   * set at. Above 1 the packer wastes vertical space; at exactly 1 nearly every
   * glyph opens a new shelf because rasterised heights vary by a texel or two.
   * 1.25 is the standard compromise and matches what font-atlas packers ship.
   */
  readonly shelfSlack?: number;
}

export interface AtlasStat {
  readonly entryCount: number;
  readonly shelfCount: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly evictionCount: number;
  readonly uploadCount: number;
  readonly uploadByteTotal: number;
  readonly refusalCount: number;
  /** Fraction of the atlas area currently occupied by shelves. */
  readonly occupancy: number;
}

/** A refused allocation. `entry` is null; the renderer skips that glyph. */
export interface AtlasMiss {
  readonly codePoint: number;
  readonly reason: 'no-ink' | 'too-large' | 'atlas-full';
}

export interface GlyphAtlas {
  readonly width: number;
  readonly height: number;
  readonly texture: GPUTexture;
  /** Start a frame. Glyphs touched after this call are pinned against eviction
   *  until the next beginFrame. */
  beginFrame(frameIndex: number): void;
  /** Resolve a code point, rasterising and uploading on a miss. */
  get(codePoint: number): AtlasEntry | null;
  /** Why the last get() for this code point returned null. */
  lastMiss(): AtlasMiss | null;
  has(codePoint: number): boolean;
  /** Drop everything. Used on device loss, where the texture is gone anyway. */
  reset(): void;
  stat(): AtlasStat;
}

/**
 * Build a dynamic glyph atlas over an existing GPUTexture (rgba8unorm, usage
 * TEXTURE_BINDING | COPY_DST). The caller owns the texture because the renderer
 * has to recreate it on device loss and re-point the atlas at the new one.
 */
export function createGlyphAtlas(option: GlyphAtlasOption): GlyphAtlas {
  const { source, queue, texture, width, height } = option;
  const padding = option.padding ?? 1;
  const shelfSlack = option.shelfSlack ?? 1.25;
  if (width <= 0 || height <= 0) {
    throw new Error(`[OG_ATLAS_SIZE] atlas must be positive, got ${width}x${height}`);
  }

  const entry = new Map<number, AtlasEntry>();
  let shelf: Shelf[] = [];
  let nextShelfY = 0;
  let frameIndex = 0;
  let hitCount = 0;
  let missCount = 0;
  let evictionCount = 0;
  let uploadCount = 0;
  let uploadByteTotal = 0;
  let refusalCount = 0;
  let miss: AtlasMiss | null = null;

  /** Find or open a shelf that can hold w x h. Returns null when full. */
  function allocate(w: number, h: number): { x: number; y: number; index: number } | null {
    for (let i = 0; i < shelf.length; i++) {
      const s = shelf[i]!;
      if (h > s.height || h * shelfSlack < s.height) continue;
      if (s.cursorX + w > width) continue;
      const x = s.cursorX;
      s.cursorX += w + padding;
      return { x, y: s.y, index: i };
    }
    if (nextShelfY + h <= height) {
      const s: Shelf = {
        y: nextShelfY,
        height: h,
        cursorX: w + padding,
        member: new Set(),
        lastUsedFrame: frameIndex,
      };
      shelf.push(s);
      nextShelfY += h + padding;
      return { x: 0, y: s.y, index: shelf.length - 1 };
    }
    return null;
  }

  /**
   * Evict the least-recently-used unpinned shelf. Returns false when every
   * shelf holds a glyph drawn in the current frame — evicting one of those
   * would guarantee an immediate re-miss and an unbounded upload loop.
   */
  function evictLeastRecentShelf(): boolean {
    let victim = -1;
    let victimFrame = Infinity;
    for (let i = 0; i < shelf.length; i++) {
      const s = shelf[i]!;
      if (s.lastUsedFrame >= frameIndex) continue; // pinned by this frame
      if (s.lastUsedFrame < victimFrame) {
        victimFrame = s.lastUsedFrame;
        victim = i;
      }
    }
    if (victim < 0) return false;
    const s = shelf[victim]!;
    for (const cp of s.member) entry.delete(cp);
    s.member.clear();
    s.cursorX = 0;
    // The shelf's height is deliberately kept. Recycling the band at its
    // original height keeps the vertical layout stable, so repeated eviction
    // cannot ratchet nextShelfY upward and strand the bottom of the atlas.
    evictionCount++;
    return true;
  }

  function upload(raster: GlyphRaster, x: number, y: number): void {
    const { bitmap } = raster;
    queue.writeTexture(
      { texture, origin: { x, y } },
      bitmap.pixel,
      { offset: 0, bytesPerRow: bitmap.width * 4, rowsPerImage: bitmap.height },
      { width: bitmap.width, height: bitmap.height, depthOrArrayLayers: 1 },
    );
    uploadCount++;
    uploadByteTotal += bitmap.pixel.byteLength;
  }

  function touch(e: AtlasEntry): AtlasEntry {
    e.lastUsedFrame = frameIndex;
    const s = shelf[e.shelfIndex];
    if (s) s.lastUsedFrame = frameIndex;
    return e;
  }

  return {
    width,
    height,
    texture,

    beginFrame(next: number): void {
      frameIndex = next;
    },

    has(codePoint: number): boolean {
      return entry.has(codePoint);
    },

    lastMiss(): AtlasMiss | null {
      return miss;
    },

    get(codePoint: number): AtlasEntry | null {
      const existing = entry.get(codePoint);
      if (existing) {
        hitCount++;
        miss = null;
        return touch(existing);
      }
      missCount++;
      const raster = source.rasterize(codePoint);
      if (!raster) {
        miss = { codePoint, reason: 'no-ink' };
        return null;
      }
      const w = raster.bitmap.width;
      const h = raster.bitmap.height;
      if (w > width || h > height) {
        refusalCount++;
        miss = { codePoint, reason: 'too-large' };
        return null;
      }

      let slot = allocate(w, h);
      while (!slot) {
        if (!evictLeastRecentShelf()) {
          refusalCount++;
          miss = { codePoint, reason: 'atlas-full' };
          return null;
        }
        slot = allocate(w, h);
      }

      upload(raster, slot.x, slot.y);
      const created: AtlasEntry = {
        codePoint,
        x: slot.x,
        y: slot.y,
        width: w,
        height: h,
        u0: slot.x / width,
        v0: slot.y / height,
        u1: (slot.x + w) / width,
        v1: (slot.y + h) / height,
        bearingX: raster.metric.bearingX,
        bearingY: raster.metric.bearingY,
        advance: raster.metric.advance,
        lastUsedFrame: frameIndex,
        shelfIndex: slot.index,
      };
      entry.set(codePoint, created);
      shelf[slot.index]!.member.add(codePoint);
      miss = null;
      return touch(created);
    },

    reset(): void {
      entry.clear();
      shelf = [];
      nextShelfY = 0;
      miss = null;
    },

    stat(): AtlasStat {
      let occupied = 0;
      for (const s of shelf) occupied += s.cursorX * s.height;
      return {
        entryCount: entry.size,
        shelfCount: shelf.length,
        hitCount,
        missCount,
        evictionCount,
        uploadCount,
        uploadByteTotal,
        refusalCount,
        occupancy: occupied / (width * height),
      };
    },
  };
}
