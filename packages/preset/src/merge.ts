// =============================================================================
// @onegrid/preset/merge — extendPreset and its merge semantics
//
// Deep merge is where config libraries quietly go wrong, so the rules here are
// stated up front and each one is covered by a test:
//
//  1. PLAIN OBJECTS MERGE, RECURSIVELY. `{ interaction: { motion: 'none' } }`
//     over a full preset changes exactly `interaction.motion` and nothing else.
//     "Plain" means an object literal — prototype is `Object.prototype` or
//     null. Anything else (Set, Map, Date, class instance) is a value.
//
//  2. ARRAYS REPLACE. They never concatenate and never merge index-by-index.
//     Concatenation is unremovable: once `feature` concatenates there is no
//     way to spell "the base list, minus grouping" in an override object. So
//     `extendPreset(dashboardPreset, { feature: ['sort'] })` yields exactly
//     `['sort']`. When you want additive semantics, say so with
//     `withFeature` / `withoutFeature`, which are explicit about it.
//
//  3. `undefined` IN THE OVERRIDE IS ABSENT, NOT A DELETE. `{ theme: undefined }`
//     leaves the base theme alone. This makes spread-built overrides
//     (`{ theme: maybeTheme }`) safe when the value is not known.
//
//  4. `null` REPLACES. Explicit null is a value the caller typed on purpose.
//
//  5. THE RESULT IS A NEW OBJECT. Neither input is mutated, and no sub-object
//     of the base is aliased into the result — a preset is data adopters keep
//     around, and mutating a shared constant is a bug nobody debugs twice.
// =============================================================================

import type { FeatureName } from './feature.js';
import type { Preset } from './type.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Structural clone of the pieces we own: plain objects and arrays. Anything
 *  else is treated as an opaque value and carried by reference, because a
 *  generic clone of a Map or a class instance is not this module's business. */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = cloneValue(inner);
    return out;
  }
  return value;
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (override === undefined) return cloneValue(base);
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) out[key] = cloneValue(value);
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      out[key] = key in out ? mergeValue(out[key], value) : cloneValue(value);
    }
    return out;
  }
  return cloneValue(override);
}

/**
 * A partial preset, deep — every nested object is optional too, so an override
 * can name a single interaction field.
 * @public
 */
export type PresetOverride = {
  readonly [K in keyof Preset]?: Preset[K] extends readonly (infer _E)[]
    ? Preset[K]
    : Preset[K] extends object
      ? { readonly [P in keyof Preset[K]]?: Preset[K][P] }
      : Preset[K];
};

/**
 * Derive a new preset from an existing one.
 *
 * Objects merge, arrays replace, `undefined` is ignored, `null` replaces, and
 * the result shares no mutable structure with either input. See the module
 * banner for the reasoning behind each rule.
 *
 * ```ts
 * const readOnlySpreadsheet = extendPreset(spreadsheetPreset, {
 *   name: 'read-only-spreadsheet',
 *   disabled: ['editing'],
 *   feature: ['sort', 'filter', 'find', 'export'],
 *   interaction: { readOnly: true },   // the other 8 fields survive
 * });
 * ```
 * @public
 */
export function extendPreset(base: Preset, override: PresetOverride): Preset {
  return mergeValue(base, override) as Preset;
}

/**
 * Additive counterpart to rule 2 — append features to a preset's list,
 * skipping any already present, order preserved.
 * @public
 */
export function withFeature(base: Preset, ...feature: readonly FeatureName[]): Preset {
  const next = [...base.feature];
  for (const name of feature) if (!next.includes(name)) next.push(name);
  // Anything newly enabled must leave the deny list, or resolveFeature would
  // immediately throw on the preset we just handed back.
  const disabled = base.disabled.filter((name) => !feature.includes(name));
  return extendPreset(base, { feature: next, disabled });
}

/**
 * Subtractive counterpart — remove features from the list AND add them to the
 * deny list, so a dependency edge cannot quietly reintroduce them. Removing
 * `editing` from a preset that keeps `fillHandle` therefore raises
 * `FeatureDependencyError` at resolve time instead of silently re-enabling it.
 * @public
 */
export function withoutFeature(base: Preset, ...feature: readonly FeatureName[]): Preset {
  const next = base.feature.filter((name) => !feature.includes(name));
  const disabled = [...base.disabled];
  for (const name of feature) if (!disabled.includes(name)) disabled.push(name);
  return extendPreset(base, { feature: next, disabled });
}
