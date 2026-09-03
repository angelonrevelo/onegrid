// =============================================================================
// @onegrid/preset
//
// Modularity as a first-class product surface: every oneGrid capability is a
// named, typed toggle, and seven complete presets answer "what kind of app is
// this?" in one import.
//
// Design decisions:
//
//  - A PRESET IS DATA, NOT A FUNCTION. `spreadsheetPreset` is a frozen-shaped
//    object literal — no closures, no builder chain. It survives
//    structuredClone, JSON, and a server-to-client boundary, which means a
//    preset can be chosen on the server, serialized into the page, and
//    hydrated without re-running anything.
//
//  - THE FEATURE UNION IS DERIVED FROM THE REPO, NOT INVENTED. Each member of
//    `FeatureName` maps to a real `GridOptions` field, a real workspace
//    package, or a real `@onegrid/plugin-kit` registry, and `FeatureMeta.option`
//    is typed as `Partial<GridOptions>` so drift is a compile error.
//
//  - DEPENDENCY IS ENFORCED, NOT DOCUMENTED. `pivot` needs `grouping`;
//    `fillHandle`, `clipboard`, `formula` and `undo` need `editing`;
//    `toolPanel` needs `columnReorder`; `tree` needs `grouping`.
//    `resolveFeature` closes over those edges, and asking for a feature whose
//    dependency the same request bans throws `FeatureDependencyError` rather
//    than picking a winner behind the adopter's back.
//
//  - THIS PACKAGE COMPOSES WITH @onegrid/plugin-kit, IT DOES NOT COMPETE.
//    plugin-kit owns runtime composition — facets combine many inputs,
//    compartments swap a sub-extension live. This package owns the
//    compile-time decision of which features exist at all. A preset picks the
//    set; a compartment swaps one member of it at runtime. Different clocks.
//
//  - COMPILE-TIME OPT-IN IS A REAL SUB-PATH SPLIT. Each preset is its own
//    module and its own package export (`@onegrid/preset/mobile`), so an app
//    that only ships the mobile profile never pulls the other six — or the
//    registry — into its graph. `@onegrid/preset/feature`,
//    `/profile` and `/cost` split the same way.
//
//  - BUNDLE FIGURES ARE CITED, AND ABSENT WHERE UNCITED. `FEATURE_COST` is
//    transcribed from the repository's `bundle-budget.json` files; the four
//    packages without one report `null` and land in `unmeasured` instead of
//    being guessed at.
// =============================================================================

export type {
  FeatureName,
  FeatureMeta,
  FeatureRequest,
  ResolvedFeature,
  PresetGridOption,
  PresetNestedOption,
} from './feature.js';
export {
  FEATURE_META,
  FEATURE_NAME,
  FeatureDependencyError,
  isFeatureName,
  resolveFeature,
  toGridOptions,
} from './feature.js';

export type { DensityName, ThemeName, MotionLevel, InteractionProfile, Preset } from './type.js';

export type { PresetOverride } from './merge.js';
export { extendPreset, withFeature, withoutFeature } from './merge.js';

export type {
  Breakpoint,
  ViewportCondition,
  ResolvedProfile,
  MediaQueryLike,
  MatchMediaLike,
  ResponsivePreset,
  ResponsivePresetOptions,
} from './profile.js';
export {
  BREAKPOINT_MIN_WIDTH,
  applyProfile,
  breakpointOf,
  createResponsivePreset,
  pruneFeature,
  recomputeResponsivePreset,
  resolveProfile,
} from './profile.js';

export type { PackageCost, BundleEstimate, BundlePackageEntry } from './cost.js';
export { BASELINE_PACKAGE, FEATURE_COST, PACKAGE_COST, estimateBundle } from './cost.js';

export { spreadsheetPreset } from './preset/spreadsheet.js';
export { databaseEditorPreset } from './preset/database-editor.js';
export { dashboardPreset } from './preset/dashboard.js';
export { reportPreset } from './preset/report.js';
export { mobilePreset } from './preset/mobile.js';
export { minimalPreset } from './preset/minimal.js';
export { analyticsPreset } from './preset/analytics.js';

import { spreadsheetPreset } from './preset/spreadsheet.js';
import { databaseEditorPreset } from './preset/database-editor.js';
import { dashboardPreset } from './preset/dashboard.js';
import { reportPreset } from './preset/report.js';
import { mobilePreset } from './preset/mobile.js';
import { minimalPreset } from './preset/minimal.js';
import { analyticsPreset } from './preset/analytics.js';
import type { Preset } from './type.js';

/**
 * Every shipped preset, keyed by name. Importing this pulls all seven into the
 * bundle — reach for the sub-path export (`@onegrid/preset/mobile`) unless the
 * choice is genuinely made at runtime, e.g. a preset picker in a demo.
 * @public
 */
export const PRESET: Readonly<Record<string, Preset>> = {
  spreadsheet: spreadsheetPreset,
  'database-editor': databaseEditorPreset,
  dashboard: dashboardPreset,
  report: reportPreset,
  mobile: mobilePreset,
  minimal: minimalPreset,
  analytics: analyticsPreset,
};
