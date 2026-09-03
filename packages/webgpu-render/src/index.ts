// =============================================================================
// @onegrid/webgpu-render
//
// The full WebGPU rendering path — the Canvas-2D replacement.
//
// What is here and why it is shaped this way:
//
//   - capability.ts    detectWebGpu() returns a REPORT, never a boolean and
//                      never a throw. oneGrid must never render nothing, so
//                      the Canvas-2D renderer stays authoritative until this
//                      report says the machine can do better.
//   - glyph-source.ts  GlyphSource is injectable (bring your own MSDF bake),
//                      with a working Canvas-2D fallback that derives a true
//                      signed distance field via an exact Euclidean distance
//                      transform — so the package is usable with no external
//                      font pipeline at all.
//   - atlas.ts         A DYNAMIC atlas: shelf packing, shelf-granular LRU
//                      eviction with the current frame pinned, and incremental
//                      writeTexture uploads of just the new glyph's rectangle.
//   - text-layout.ts   Shaping-free but correct: real per-pair kerning,
//                      ellipsis truncation that accounts for the ellipsis's own
//                      kern pair, alignment, and a measurement path that is
//                      literally the same arithmetic the draw path uses.
//   - instance-pipeline.ts  One instanced draw for every cell background and
//                      one for every glyph, fed by a ring of staging buffers so
//                      a frame never rewrites a buffer the GPU is still reading.
//   - damage.ts        Scissor the dirty regions when damage is small, redraw
//                      the frame when it is large — with the crossover MEASURED
//                      on the host machine rather than assumed.
//   - renderer.ts      Ties it together, and treats a lost device as the
//                      routine event it is: tear down, re-acquire, bounded
//                      retry, then hand the frame back to Canvas-2D.
//
// The v0.1.0 scaffold exports (packCells, MSDF_WGSL, createRenderScaffold, …)
// are unchanged and still supported; the new surface is additive.
// =============================================================================

/** @public Per-cell vertex buffer protocol. */
export {
  packCells,
  packRgba,
  CELL_STRIDE,
  GLYPH_STRIDE,
  type CellPackInput,
  type PackedCellBuffers,
} from './vertex-buffer.js';

/** @public MSDF atlas format + WGSL fragment snippet. */
export {
  lookupGlyph,
  screenPxRange,
  MSDF_WGSL,
  type MsdfAtlas,
  type MsdfGlyph,
} from './msdf.js';

/** @public Device + swap-chain + cell-quad pipeline scaffold. */
export {
  createRenderScaffold,
  type RenderScaffold,
  type RenderScaffoldOptions,
} from './scaffold.js';

/** @public Capability detection and the documented fallback signal. */
export {
  detectWebGpu,
  describeCapability,
  DEFAULT_WEBGPU_REQUIREMENT,
  type AdapterLike,
  type DetectWebGpuOption,
  type GpuLike,
  type WebGpuAdapterReport,
  type WebGpuBlocker,
  type WebGpuCapability,
  type WebGpuLimitReport,
  type WebGpuRequirement,
} from './capability.js';

/** @public Glyph outline source + the Canvas-2D SDF fallback. */
export {
  createCanvas2dGlyphSource,
  signedDistanceField,
  type Canvas2dGlyphSourceOption,
  type GlyphBitmap,
  type GlyphMetric,
  type GlyphMetricSource,
  type GlyphRaster,
  type GlyphRasterContext,
  type GlyphSource,
} from './glyph-source.js';

/** @public Dynamic MSDF glyph atlas — shelf packing, LRU eviction, sub-rect upload. */
export {
  createGlyphAtlas,
  type AtlasEntry,
  type AtlasMiss,
  type AtlasQueue,
  type AtlasStat,
  type GlyphAtlas,
  type GlyphAtlasOption,
} from './atlas.js';

/** @public Kerned, truncating, aligned text layout + measurement. */
export {
  layoutCellText,
  measureColumnWidth,
  measureText,
  truncateToWidth,
  type CellTextLayout,
  type CellTextLayoutOption,
  type HorizontalAlign,
  type PositionedGlyph,
  type TextMetric,
  type TruncateResult,
  type VerticalAlign,
} from './text-layout.js';

/** @public Instanced per-cell pipeline + ring-buffered staging. */
export {
  buildInstancePipeline,
  createInstanceRing,
  packGlyphInstance,
  BUFFER_USAGE_COPY_DST,
  BUFFER_USAGE_UNIFORM,
  BUFFER_USAGE_VERTEX,
  CELL_INSTANCE_WGSL,
  GLYPH_INSTANCE_STRIDE,
  GLYPH_INSTANCE_WGSL,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_RENDER_ATTACHMENT,
  TEXTURE_USAGE_TEXTURE_BINDING,
  type CellInstancePipeline,
  type GlyphInstance,
  type InstanceRing,
  type InstanceRingOption,
  type PipelineDevice,
  type RingDevice,
  type RingQueue,
  type RingStat,
  type StagingSlot,
} from './instance-pipeline.js';

/** @public Frame encoding — the recorded command stream for one frame. */
export {
  buildGlyphInstance,
  encodeGridFrame,
  type CellRenderPass,
  type EncodeFrameOption,
  type FrameDrawReport,
  type GlyphQuadOption,
} from './frame.js';

/** @public Damage tracking, scissor planning, measured crossover calibration. */
export {
  calibrateDamageThreshold,
  clipRect,
  measureDamageCrossover,
  mergeDamageRect,
  planDamage,
  rectAdjacent,
  rectArea,
  unionRect,
  DEFAULT_DAMAGE_THRESHOLD,
  type DamageCalibration,
  type DamageMode,
  type DamagePlan,
  type DamagePlanOption,
  type DamageRect,
  type DamageSample,
  type MeasureDamageCrossoverOption,
  type MergeDamageOption,
  type Viewport,
} from './damage.js';

/** @public The renderer: capability gate, frame submission, device-lost retry. */
export {
  createWebGpuRenderer,
  type RenderCanvas,
  type RenderCell,
  type RenderCommandEncoder,
  type RenderContext,
  type RenderDevice,
  type RenderFrameInput,
  type RenderFrameReport,
  type RenderQueue,
  type RendererState,
  type WebGpuRenderer,
  type WebGpuRendererOption,
  type WebGpuRendererResult,
} from './renderer.js';
