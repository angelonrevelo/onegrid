// =============================================================================
// @onegrid/preset/profile — adaptive resolution
//
// A preset says what kind of application this is. A profile says what the
// device in front of the user can actually do. They are separate because the
// same application ships to a 4K desktop, a laptop trackpad, a tablet and a
// phone, and only the second half changes.
//
// Design decisions:
//
//  - Breakpoints are width-only and there are five of them. Height is not a
//    breakpoint input: a grid is horizontally constrained (columns) and
//    vertically virtualized (rows), so height changes the row count and
//    nothing else.
//
//  - Pointer beats width. A 1280 px tablet in landscape is a coarse pointer
//    and needs 44 px targets; a 400 px browser window on a desktop is a fine
//    pointer that can keep its 6 px resize gutters. Sizing off width alone is
//    the classic mistake and produces finger-hostile tablets.
//
//  - `pointer: none` (TV remote, keyboard-only, some kiosk hardware) is
//    treated as coarse for sizing. There is no hover and no precise drag
//    there either; the failure mode of being generous is a slightly roomy
//    grid, and of being stingy is an unusable one.
//
//  - Auto-disabling a feature must not orphan a dependent. Dropping
//    `columnReorder` on touch would leave `toolPanel` enabled with its
//    dependency banned, which `resolveFeature` correctly rejects. So
//    `applyProfile` prunes the dependency cascade to a fixpoint before
//    returning, and the returned preset always resolves.
//
//  - `matchMedia` is injectable and its absence is a supported state, not an
//    error. `createResponsivePreset` on a server returns a preset resolved
//    from the declared fallback viewport and a `subscribe` that never fires,
//    so the same call site works in a Node render pass and in the browser.
// =============================================================================

import { FEATURE_META, type FeatureName } from './feature.js';
import { extendPreset } from './merge.js';
import type { DensityName, MotionLevel, Preset } from './type.js';

/**
 * Width buckets. `xs` is a phone in portrait, `xl` is a desktop monitor.
 * @public
 */
export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Lower bound of each breakpoint in CSS px. 480 / 768 / 1024 / 1440 — the
 * phone, tablet-portrait, tablet-landscape and desktop edges the CSS in this
 * repo's showcase already uses.
 * @public
 */
export const BREAKPOINT_MIN_WIDTH: Readonly<Record<Breakpoint, number>> = {
  xs: 0,
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1440,
};

/** Ordered wide-to-narrow so the first match wins. */
const BREAKPOINT_DESC: readonly Breakpoint[] = ['xl', 'lg', 'md', 'sm', 'xs'];

/**
 * What the environment reports. Only `width` is required; the three media
 * features default to the conservative desktop answer.
 * @public
 */
export interface ViewportCondition {
  /** Viewport width in CSS px. */
  readonly width: number;
  /** `matchMedia('(pointer: coarse)')` and friends. Default `'fine'`. */
  readonly pointer?: 'fine' | 'coarse' | 'none';
  /** `prefers-reduced-motion: reduce`. Default false. */
  readonly reducedMotion?: boolean;
  /** `forced-colors: active` — Windows High Contrast and friends. Default false. */
  readonly forcedColors?: boolean;
}

/**
 * The device-side half of a configuration.
 * @public
 */
export interface ResolvedProfile {
  readonly breakpoint: Breakpoint;
  readonly density: DensityName;
  readonly hitTargetPx: number;
  readonly hoverAffordance: boolean;
  readonly swipeAction: boolean;
  readonly motion: MotionLevel;
  /** True under `forced-colors: active`. The adopter should emit
   *  `forcedColorsBlock()` from `@onegrid/tokens` when this is set. */
  readonly highContrast: boolean;
  /** Features this environment cannot support, in registry order. */
  readonly autoDisable: readonly FeatureName[];
  /** One human-readable line per rule that fired. */
  readonly reason: readonly string[];
}

/**
 * Which width bucket a viewport falls in.
 * @public
 */
export function breakpointOf(width: number): Breakpoint {
  for (const name of BREAKPOINT_DESC) {
    if (width >= BREAKPOINT_MIN_WIDTH[name]) return name;
  }
  return 'xs';
}

/**
 * Resolve density, hit-target size, motion and the auto-disable list for a
 * given environment.
 * @public
 */
export function resolveProfile(condition: ViewportCondition): ResolvedProfile {
  const breakpoint = breakpointOf(condition.width);
  const pointer = condition.pointer ?? 'fine';
  const coarse = pointer === 'coarse' || pointer === 'none';
  const reducedMotion = condition.reducedMotion ?? false;
  const forcedColors = condition.forcedColors ?? false;

  const reason: string[] = [];
  const disable = new Set<FeatureName>();

  let density: DensityName;
  let hitTargetPx: number;
  if (coarse) {
    // A finger needs the Apple HIG / WCAG 2.2 AAA 44 px target regardless of
    // how wide the screen is. On the narrowest screens go one step further —
    // spacious — because at xs the grid is also the whole page.
    density = breakpoint === 'xs' ? 'spacious' : 'comfortable';
    hitTargetPx = 44;
    for (const name of ['columnResize', 'rowResize', 'fillHandle', 'rowReorder', 'columnReorder'] as const) {
      disable.add(name);
    }
    reason.push(
      `pointer:${pointer} -> ${density} density, 44 px targets, no hover; drag handles (column/row resize, fill handle, drag reorder) removed because they are sub-10 px targets that fight the scroll gesture`,
    );
  } else {
    // Fine pointer: compact pays off only when there is width to fill.
    density = breakpoint === 'lg' || breakpoint === 'xl' ? 'compact' : 'comfortable';
    // WCAG 2.2 AA (2.5.8) floor is 24 px; give narrow windows a little more
    // because they are usually a laptop being used somewhere awkward.
    hitTargetPx = breakpoint === 'xs' || breakpoint === 'sm' ? 32 : 24;
    reason.push(
      `pointer:fine at ${breakpoint} -> ${density} density, ${hitTargetPx} px targets`,
    );
  }

  if (breakpoint === 'xs') {
    for (const name of ['toolPanel', 'chart', 'pivot', 'columnGroup', 'statusBar'] as const) {
      disable.add(name);
    }
    reason.push(
      'xs viewport -> tool panel, charts, pivot, column-group band and status bar removed; below 480 px they consume more of the screen than the data does',
    );
  } else if (breakpoint === 'sm') {
    disable.add('toolPanel');
    disable.add('chart');
    reason.push(
      'sm viewport -> tool panel and charts removed; both need a second pane the layout cannot afford under 768 px',
    );
  }

  let motion: MotionLevel;
  if (reducedMotion) {
    motion = 'none';
    // A cell flash is a 600 ms animated tint. Under prefers-reduced-motion it
    // is exactly the kind of unrequested movement the query asks us to stop.
    disable.add('flashCell');
    reason.push(
      'prefers-reduced-motion:reduce -> motion:none and cell flash removed',
    );
  } else {
    motion = 'full';
  }

  if (forcedColors) {
    // In forced-colors the UA overrides every colour with the user's palette.
    // A sparkline is a colour-encoded chart with no axis and no legend, so it
    // survives as an indistinguishable smear; the cell flash tint is stripped
    // outright and animates nothing.
    disable.add('sparkline');
    disable.add('flashCell');
    reason.push(
      'forced-colors:active -> sparklines and cell flash removed; both encode meaning in colours the UA replaces',
    );
  }

  // Registry order keeps the output a pure function of the inputs.
  const autoDisable = Object.keys(FEATURE_META).filter((name) =>
    disable.has(name as FeatureName),
  ) as FeatureName[];

  return {
    breakpoint,
    density,
    hitTargetPx,
    hoverAffordance: !coarse,
    swipeAction: coarse,
    motion,
    highContrast: forcedColors,
    autoDisable,
    reason,
  };
}

/**
 * Remove `deny` from a feature list, then keep removing anything whose
 * transitive dependency landed in `deny`, until nothing else falls out.
 * The result is guaranteed to survive `resolveFeature` against the same deny
 * set. Exported because "what actually survives at this viewport" is a
 * question worth asking without building a whole preset.
 * @public
 */
export function pruneFeature(
  feature: readonly FeatureName[],
  deny: readonly FeatureName[],
): readonly FeatureName[] {
  const banned = new Set<FeatureName>(deny);
  let current = feature.filter((name) => !banned.has(name));
  for (;;) {
    const next = current.filter((name) => {
      const stack = [...FEATURE_META[name].dependency];
      const seen = new Set<FeatureName>();
      while (stack.length > 0) {
        const dep = stack.pop()!;
        if (banned.has(dep)) return false;
        if (seen.has(dep)) continue;
        seen.add(dep);
        stack.push(...FEATURE_META[dep].dependency);
      }
      return true;
    });
    if (next.length === current.length) return next;
    current = next;
  }
}

/**
 * Fold a resolved profile into a preset. Density, hit target, hover, swipe
 * and motion are overwritten; the auto-disabled features are removed from
 * `feature`, added to `disabled`, and their orphaned dependents pruned.
 * @public
 */
export function applyProfile(base: Preset, profile: ResolvedProfile): Preset {
  const disabled = [...base.disabled];
  for (const name of profile.autoDisable) {
    if (!disabled.includes(name)) disabled.push(name);
  }
  return extendPreset(base, {
    feature: pruneFeature(base.feature, disabled),
    disabled,
    density: profile.density,
    interaction: {
      pointer: profile.hoverAffordance ? 'fine' : 'coarse',
      hitTargetPx: profile.hitTargetPx,
      hoverAffordance: profile.hoverAffordance,
      swipeAction: profile.swipeAction,
      motion: profile.motion,
    },
  });
}

// -----------------------------------------------------------------------------
// Live binding
// -----------------------------------------------------------------------------

/**
 * The slice of `MediaQueryList` this package uses. Narrow on purpose so a
 * test can supply a plain object and so the type does not require `lib.dom`
 * to be present at the call site.
 * @public
 */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  /** Safari < 14 and older Android WebViews. */
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

/** @public */
export type MatchMediaLike = (query: string) => MediaQueryLike;

/** @public */
export interface ResponsivePresetOptions {
  /**
   * Injected `matchMedia`. Omit to use `globalThis.matchMedia`; pass `null`
   * to force the SSR path even in a browser (useful for hydration parity).
   */
  readonly matchMedia?: MatchMediaLike | null;
  /**
   * Viewport assumed when `matchMedia` is unavailable. Default: 1280 px,
   * fine pointer, no reduced motion, no forced colors — the desktop case,
   * which is what a server render should bet on when it cannot know.
   */
  readonly fallback?: ViewportCondition;
}

/**
 * A preset that recomputes when the environment changes.
 * @public
 */
export interface ResponsivePreset {
  /** The unmodified input preset. */
  readonly base: Preset;
  /** The preset adapted to the current environment. */
  readonly current: Preset;
  /** The profile `current` was derived from. */
  readonly profile: ResolvedProfile;
  /** True when no `matchMedia` was available and `fallback` was used. */
  readonly ssr: boolean;
  /**
   * Register a listener. Called on every change, never synchronously on
   * subscribe — read `current` for the initial value. Returns an unsubscribe.
   */
  subscribe(listener: (preset: Preset, profile: ResolvedProfile) => void): () => void;
  /** Detach every media listener. Idempotent. */
  destroy(): void;
}

const DEFAULT_FALLBACK: ViewportCondition = {
  width: 1280,
  pointer: 'fine',
  reducedMotion: false,
  forcedColors: false,
};

// Width is read through min-width queries rather than `innerWidth` so that the
// whole resolver runs off one mechanism, stays correct inside an iframe, and
// needs no resize listener or debounce.
const WIDTH_QUERY: readonly { readonly query: string; readonly width: number }[] = [
  { query: `(min-width: ${BREAKPOINT_MIN_WIDTH.xl}px)`, width: BREAKPOINT_MIN_WIDTH.xl },
  { query: `(min-width: ${BREAKPOINT_MIN_WIDTH.lg}px)`, width: BREAKPOINT_MIN_WIDTH.lg },
  { query: `(min-width: ${BREAKPOINT_MIN_WIDTH.md}px)`, width: BREAKPOINT_MIN_WIDTH.md },
  { query: `(min-width: ${BREAKPOINT_MIN_WIDTH.sm}px)`, width: BREAKPOINT_MIN_WIDTH.sm },
];

const POINTER_QUERY = '(pointer: coarse)';
const POINTER_NONE_QUERY = '(pointer: none)';
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FORCED_COLORS_QUERY = '(forced-colors: active)';

function attach(mql: MediaQueryLike, listener: () => void): () => void {
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener?.('change', listener);
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(listener);
    return () => mql.removeListener?.(listener);
  }
  // A MediaQueryList with neither API cannot notify. Its value is still read
  // once at construction, so the preset is correct — just not live.
  return () => undefined;
}

class ResponsivePresetImpl implements ResponsivePreset {
  readonly base: Preset;
  readonly ssr: boolean;
  private profileValue: ResolvedProfile;
  private currentValue: Preset;
  private readonly listener = new Set<
    (preset: Preset, profile: ResolvedProfile) => void
  >();
  private readonly detach: (() => void)[] = [];
  private readonly read: () => ViewportCondition;

  constructor(base: Preset, option: ResponsivePresetOptions) {
    this.base = base;
    const fallback = option.fallback ?? DEFAULT_FALLBACK;
    const mm =
      option.matchMedia === null
        ? null
        : (option.matchMedia ??
          (typeof globalThis.matchMedia === 'function'
            ? globalThis.matchMedia.bind(globalThis)
            : null));

    if (mm === null) {
      this.ssr = true;
      this.read = () => fallback;
    } else {
      this.ssr = false;
      const widthMql = WIDTH_QUERY.map((entry) => ({
        width: entry.width,
        mql: mm(entry.query),
      }));
      const coarseMql = mm(POINTER_QUERY);
      const noneMql = mm(POINTER_NONE_QUERY);
      const motionMql = mm(MOTION_QUERY);
      const forcedMql = mm(FORCED_COLORS_QUERY);

      this.read = (): ViewportCondition => {
        const hit = widthMql.find((entry) => entry.mql.matches);
        return {
          width: hit?.width ?? 0,
          pointer: noneMql.matches ? 'none' : coarseMql.matches ? 'coarse' : 'fine',
          reducedMotion: motionMql.matches,
          forcedColors: forcedMql.matches,
        };
      };

      const onChange = (): void => this.recompute();
      for (const entry of widthMql) this.detach.push(attach(entry.mql, onChange));
      for (const mql of [coarseMql, noneMql, motionMql, forcedMql]) {
        this.detach.push(attach(mql, onChange));
      }
    }

    this.profileValue = resolveProfile(this.read());
    this.currentValue = applyProfile(base, this.profileValue);
  }

  get current(): Preset {
    return this.currentValue;
  }

  get profile(): ResolvedProfile {
    return this.profileValue;
  }

  subscribe(listener: (preset: Preset, profile: ResolvedProfile) => void): () => void {
    this.listener.add(listener);
    return () => this.listener.delete(listener);
  }

  destroy(): void {
    while (this.detach.length > 0) this.detach.pop()?.();
    this.listener.clear();
  }

  /** Recompute and notify. Exposed on the class (not the interface) so tests
   *  driving a fake matchMedia can force a pass without faking an event. */
  recompute(): void {
    const profile = resolveProfile(this.read());
    // Media queries fire in bursts — a rotation flips width AND pointer — so
    // skip the notification when nothing an adopter can see actually moved.
    if (sameProfile(profile, this.profileValue)) return;
    this.profileValue = profile;
    this.currentValue = applyProfile(this.base, profile);
    for (const listener of this.listener) listener(this.currentValue, profile);
  }
}

function sameProfile(a: ResolvedProfile, b: ResolvedProfile): boolean {
  return (
    a.breakpoint === b.breakpoint &&
    a.density === b.density &&
    a.hitTargetPx === b.hitTargetPx &&
    a.hoverAffordance === b.hoverAffordance &&
    a.swipeAction === b.swipeAction &&
    a.motion === b.motion &&
    a.highContrast === b.highContrast &&
    a.autoDisable.length === b.autoDisable.length &&
    a.autoDisable.every((name, i) => name === b.autoDisable[i])
  );
}

/**
 * Bind a preset to the environment.
 *
 * ```ts
 * const responsive = createResponsivePreset(databaseEditorPreset);
 * render(responsive.current);
 * const off = responsive.subscribe((preset) => render(preset));
 * // teardown: off(); responsive.destroy();
 * ```
 *
 * On a server — or anywhere `matchMedia` is missing — `ssr` is true, `current`
 * is resolved from `option.fallback`, and `subscribe` returns a no-op
 * unsubscribe without ever firing.
 * @public
 */
export function createResponsivePreset(
  base: Preset,
  option: ResponsivePresetOptions = {},
): ResponsivePreset {
  return new ResponsivePresetImpl(base, option);
}

/**
 * Force a recompute on a responsive preset. Only meaningful for tests driving
 * an injected `matchMedia` fake, where flipping `matches` does not dispatch a
 * real `change` event.
 * @public
 */
export function recomputeResponsivePreset(responsive: ResponsivePreset): void {
  if (responsive instanceof ResponsivePresetImpl) responsive.recompute();
}
