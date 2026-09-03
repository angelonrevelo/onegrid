// =============================================================================
// @onegrid/preset — shared vocabulary
//
// The types every other module in this package speaks. Kept in one small
// module with no imports beyond `feature.ts` so that a sub-path import of a
// single preset does not drag the registry in behind it.
// =============================================================================

import type { FeatureName } from './feature.js';

/**
 * Density slot. Matches the three DTCG bundles published by
 * `@onegrid/tokens` (`@onegrid/tokens/density/{compact,comfortable,spacious}`),
 * so a preset's `density` is directly usable as an import specifier.
 * @public
 */
export type DensityName = 'compact' | 'comfortable' | 'spacious';

/**
 * Theme slot. `'auto'` means "follow `prefers-color-scheme`" — the adopter
 * wires it with `watchPrefersColorScheme()` from `@onegrid/tokens`.
 * @public
 */
export type ThemeName = 'light' | 'dark' | 'auto';

/**
 * How much motion the grid is allowed to spend. `'reduced'` keeps
 * state-change affordances (a 1-frame flash) but drops travel animation;
 * `'none'` is what `prefers-reduced-motion: reduce` resolves to.
 * @public
 */
export type MotionLevel = 'full' | 'reduced' | 'none';

/**
 * The half of a preset that is not a feature list: how the grid expects to
 * be touched. Two presets can enable identical features and still be wrong
 * for each other's input device, which is why this is a first-class,
 * separately-mergeable object rather than a handful of booleans on `Preset`.
 * @public
 */
export interface InteractionProfile {
  /** Coarse means finger/stylus: every hit target grows, hover disappears. */
  readonly pointer: 'fine' | 'coarse';
  /**
   * Minimum interactive target edge in CSS px. 44 is the Apple HIG /
   * WCAG 2.2 AAA (2.5.5) figure for touch; 24 is the WCAG 2.2 AA (2.5.8)
   * minimum, which is what a mouse-driven grid can safely use.
   */
  readonly hitTargetPx: number;
  /** Whether hover state is meaningful. False on coarse pointers — a
   *  finger has no hover, and sticky :hover on touch is a known bug class. */
  readonly hoverAffordance: boolean;
  /** Horizontal swipe on a row reveals row actions. Touch-only affordance. */
  readonly swipeAction: boolean;
  /** Bias toward keyboard: type-ahead edit, Enter-to-commit, roving focus. */
  readonly keyboardFirst: boolean;
  /** Motion budget. */
  readonly motion: MotionLevel;
  /** The grid never mutates. Read-only presets skip the editing machinery
   *  entirely rather than merely hiding it. */
  readonly readOnly: boolean;
  /** Row virtualization. Off only for print/report output, where the DOM
   *  must contain every row for the paginator to see it. */
  readonly virtualScroll: boolean;
  /** Rows rendered beyond the viewport edge. Higher on touch, where fling
   *  scrolling outruns the render loop; zero when virtualization is off. */
  readonly overscanRow: number;
}

/**
 * A complete, self-contained answer to "what kind of grid is this?".
 * A preset is data — no functions, no closures — so it survives
 * `structuredClone`, JSON round-trips, and server→client serialization.
 * @public
 */
export interface Preset {
  /** Stable identifier. Used in error messages and telemetry. */
  readonly name: string;
  /** One sentence on who this preset is for. */
  readonly description: string;
  /** Features the adopter is asking for. Dependencies are resolved from
   *  here by `resolveFeature`, so a preset does not have to list them. */
  readonly feature: readonly FeatureName[];
  /** Features explicitly forbidden. A preset that asks for a feature whose
   *  dependency appears here is a contradiction, and `resolveFeature`
   *  throws `FeatureDependencyError` rather than silently enabling it. */
  readonly disabled: readonly FeatureName[];
  readonly density: DensityName;
  readonly theme: ThemeName;
  readonly interaction: InteractionProfile;
}
