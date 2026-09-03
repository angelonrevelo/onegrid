// =============================================================================
// Frame encoding — turning a laid-out frame into a recorded command stream.
//
// Everything here is written against NARROW structural interfaces rather than
// GPURenderPassEncoder directly. A real encoder satisfies them, and so does a
// recorder in a test, which is the only way this logic is verifiable without a
// GPU: the tests assert on the exact sequence of setPipeline / setVertexBuffer /
// setScissorRect / draw calls, including the scissor rectangles the damage
// planner produced. That assertion is the real contract — if the encoder emits
// the wrong rect or draws the wrong instance count, the recorded stream says so
// as loudly as a screenshot would.
//
// Draw-call budget: TWO per scissor rect (backgrounds, then glyphs), not two
// per cell. A frame with one dirty region is four state calls and two draws
// regardless of whether it contains 40 cells or 40,000.
// =============================================================================

import type { AtlasEntry, GlyphAtlas } from './atlas.js';
import type { CellTextLayout } from './text-layout.js';
import type { DamagePlan, DamageRect } from './damage.js';
import type { GlyphInstance } from './instance-pipeline.js';

/** The render-pass surface frame encoding uses. GPURenderPassEncoder fits. */
export interface CellRenderPass {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, group: GPUBindGroup): void;
  setVertexBuffer(slot: number, buffer: GPUBuffer, offset?: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number,
  ): void;
  end(): void;
}

export interface EncodeFrameOption {
  readonly pass: CellRenderPass;
  readonly plan: DamagePlan;
  /**
   * The two pipelines are built with `layout: 'auto'`, which gives each its own
   * bind-group layout, so they cannot share one bind group: the cell pass binds
   * only the viewport uniform while the glyph pass also binds the atlas texture
   * and sampler. Passing both explicitly keeps that fact visible instead of
   * hiding it behind a manual pipeline layout nobody would remember to update.
   */
  readonly cellBindGroup: GPUBindGroup;
  readonly glyphBindGroup: GPUBindGroup;
  readonly cellPipeline: GPURenderPipeline;
  readonly glyphPipeline: GPURenderPipeline;
  readonly cellBuffer: GPUBuffer;
  readonly cellCount: number;
  readonly glyphBuffer: GPUBuffer;
  readonly glyphCount: number;
  /** End the pass after encoding. Defaults true; a caller composing several
   *  passes into one encoder turns it off. */
  readonly endPass?: boolean;
}

export interface FrameDrawReport {
  readonly drawCallCount: number;
  readonly scissorRectCount: number;
  readonly cellInstanceCount: number;
  readonly glyphInstanceCount: number;
  readonly mode: DamagePlan['mode'];
}

/**
 * Record one frame. Returns what it recorded so a host can log draw-call counts
 * without instrumenting the encoder.
 *
 * A 'none' plan records nothing at all and still ends the pass — a pass that is
 * begun must be ended, and a load-op of 'load' means an empty pass legitimately
 * presents the previous frame's contents unchanged.
 */
export function encodeGridFrame(option: EncodeFrameOption): FrameDrawReport {
  const {
    pass,
    plan,
    cellBindGroup,
    glyphBindGroup,
    cellPipeline,
    glyphPipeline,
    cellBuffer,
    cellCount,
    glyphBuffer,
    glyphCount,
  } = option;

  let drawCallCount = 0;
  if (plan.mode !== 'none' && (cellCount > 0 || glyphCount > 0)) {
    for (const rect of plan.rect) {
      pass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
      if (cellCount > 0) {
        pass.setPipeline(cellPipeline);
        pass.setBindGroup(0, cellBindGroup);
        pass.setVertexBuffer(0, cellBuffer);
        pass.draw(6, cellCount, 0, 0);
        drawCallCount++;
      }
      if (glyphCount > 0) {
        pass.setPipeline(glyphPipeline);
        pass.setBindGroup(0, glyphBindGroup);
        pass.setVertexBuffer(0, glyphBuffer);
        pass.draw(6, glyphCount, 0, 0);
        drawCallCount++;
      }
    }
  }
  if (option.endPass !== false) pass.end();

  return {
    drawCallCount,
    scissorRectCount: plan.mode === 'none' ? 0 : plan.rect.length,
    cellInstanceCount: cellCount,
    glyphInstanceCount: glyphCount,
    mode: plan.mode,
  };
}

export interface GlyphQuadOption {
  /** Source-em to screen-px scale — the same `scale` layoutCellText used. */
  readonly scale: number;
  /** Packed 0xRRGGBBAA foreground. */
  readonly color: number;
  /** Distance range baked into the atlas, in atlas texels. */
  readonly distanceRangePx: number;
  /** Clip quads to this rect (the cell's content box) — a glyph that a
   *  truncation edge case pushed past the cell must not paint the neighbour. */
  readonly clip?: DamageRect;
}

/**
 * Turn a laid-out cell into glyph instances, resolving each code point through
 * the atlas. Glyphs the atlas refuses are skipped rather than substituted: a
 * tofu box drawn from a missing glyph is worse than a gap, because it looks
 * like a data error rather than a rendering one.
 *
 * `pxRange` per instance is the atlas distance range times the render scale,
 * which is exactly screenPxRange()'s definition specialised to an atlas whose
 * texels are source-em pixels. Passing it per instance rather than per frame is
 * what lets a header row at 16px and a cell at 12px share one draw call.
 */
export function buildGlyphInstance(
  layout: CellTextLayout,
  atlas: GlyphAtlas,
  option: GlyphQuadOption,
): GlyphInstance[] {
  const { scale, color, distanceRangePx, clip } = option;
  const instance: GlyphInstance[] = [];
  for (const positioned of layout.glyph) {
    const entry: AtlasEntry | null = atlas.get(positioned.codePoint);
    if (!entry) continue;
    const x = positioned.penX + entry.bearingX * scale;
    const y = positioned.penY - entry.bearingY * scale;
    const width = entry.width * scale;
    const height = entry.height * scale;
    if (clip) {
      const right = clip.x + clip.width;
      const bottom = clip.y + clip.height;
      if (x >= right || y >= bottom || x + width <= clip.x || y + height <= clip.y) {
        continue;
      }
    }
    instance.push({
      x,
      y,
      width,
      height,
      u0: entry.u0,
      v0: entry.v0,
      u1: entry.u1,
      v1: entry.v1,
      color,
      pxRange: distanceRangePx * scale,
    });
  }
  return instance;
}
