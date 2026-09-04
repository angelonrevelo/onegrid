import { describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FEATURE_META,
  FEATURE_NAME,
  FeatureDependencyError,
  isFeatureName,
  resolveFeature,
  toGridOptions,
  type FeatureName,
} from '../feature.js';
import { extendPreset, withFeature, withoutFeature, type PresetOverride } from '../merge.js';
import {
  BREAKPOINT_MIN_WIDTH,
  applyProfile,
  breakpointOf,
  createResponsivePreset,
  pruneFeature,
  recomputeResponsivePreset,
  resolveProfile,
  type MediaQueryLike,
} from '../profile.js';
import { BASELINE_PACKAGE, PACKAGE_COST, FEATURE_COST, estimateBundle } from '../cost.js';
import { spreadsheetPreset } from '../preset/spreadsheet.js';
import { databaseEditorPreset } from '../preset/database-editor.js';
import { dashboardPreset } from '../preset/dashboard.js';
import { reportPreset } from '../preset/report.js';
import { mobilePreset } from '../preset/mobile.js';
import { minimalPreset } from '../preset/minimal.js';
import { analyticsPreset } from '../preset/analytics.js';
import { PRESET } from '../index.js';
import type { Preset } from '../type.js';

// vitest runs with cwd set to the package root (packages/preset), so the repo
// root is two levels up. import.meta.url is not usable here — vitest rewrites
// it to a non-file scheme under the jsdom environment.
const REPO_ROOT = resolve(process.cwd(), '..', '..');

const ALL_PRESET: readonly Preset[] = [
  spreadsheetPreset,
  databaseEditorPreset,
  dashboardPreset,
  reportPreset,
  mobilePreset,
  minimalPreset,
  analyticsPreset,
];

// -----------------------------------------------------------------------------
// Registry integrity
// -----------------------------------------------------------------------------

describe('feature registry', () => {
  it('derives FEATURE_NAME from FEATURE_META and keys match their entry name', () => {
    expect(FEATURE_NAME.length).toBe(Object.keys(FEATURE_META).length);
    expect(FEATURE_NAME.length).toBeGreaterThanOrEqual(31);
    for (const name of FEATURE_NAME) {
      expect(FEATURE_META[name].name).toBe(name);
    }
  });

  it('has no dangling or self-referential dependency edge', () => {
    for (const name of FEATURE_NAME) {
      for (const dep of FEATURE_META[name].dependency) {
        expect(dep).not.toBe(name);
        expect(FEATURE_NAME).toContain(dep);
      }
    }
  });

  it('maps every feature to a package that has a cost entry', () => {
    for (const name of FEATURE_NAME) {
      expect(PACKAGE_COST[FEATURE_META[name].package]).toBeDefined();
      expect(FEATURE_COST[name].package).toBe(FEATURE_META[name].package);
    }
  });

  it('guards untrusted names with isFeatureName', () => {
    expect(isFeatureName('pivot')).toBe(true);
    expect(isFeatureName('teleport')).toBe(false);
    expect(isFeatureName(42)).toBe(false);
    expect(isFeatureName('toString')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Dependency closure
// -----------------------------------------------------------------------------

describe('resolveFeature', () => {
  it('pulls grouping in behind pivot and reports it as implied', () => {
    const resolved = resolveFeature(['pivot']);
    expect([...resolved.feature].sort()).toEqual(['grouping', 'pivot']);
    expect([...resolved.implied]).toEqual(['grouping']);
    expect(resolved.requested).toEqual(['pivot']);
  });

  it('pulls editing in behind fillHandle, clipboard, formula and undo', () => {
    for (const name of ['fillHandle', 'clipboard', 'formula', 'undo'] as const) {
      const resolved = resolveFeature([name]);
      expect(resolved.feature.has('editing')).toBe(true);
      expect(resolved.implied.has('editing')).toBe(true);
    }
  });

  it('pulls columnReorder in behind toolPanel', () => {
    const resolved = resolveFeature(['toolPanel']);
    expect(resolved.feature.has('columnReorder')).toBe(true);
    expect(resolved.implied.has('columnReorder')).toBe(true);
  });

  it('does not mark an explicitly requested dependency as implied', () => {
    const resolved = resolveFeature(['pivot', 'grouping']);
    expect(resolved.feature.has('grouping')).toBe(true);
    expect(resolved.implied.size).toBe(0);
  });

  it('dedupes a repeated request and preserves request order', () => {
    const resolved = resolveFeature(['find', 'sort', 'find']);
    expect(resolved.requested).toEqual(['find', 'sort']);
  });

  it('throws FeatureDependencyError when a needed dependency is banned', () => {
    let thrown: unknown;
    try {
      resolveFeature({ enable: ['fillHandle'], disable: ['editing'] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FeatureDependencyError);
    const error = thrown as FeatureDependencyError;
    expect(error.code).toBe('OG_FEATURE_DEP_CONFLICT');
    expect(error.feature).toBe('fillHandle');
    expect(error.dependency).toBe('editing');
    expect(error.chain).toEqual(['fillHandle', 'editing']);
    expect(error.message).toContain('OG_FEATURE_DEP_CONFLICT');
  });

  it('throws when a feature is both enabled and disabled in the same request', () => {
    expect(() => resolveFeature({ enable: ['chart'], disable: ['chart'] })).toThrow(
      FeatureDependencyError,
    );
  });

  it('throws OG_FEATURE_UNKNOWN for a name outside the union', () => {
    expect(() => resolveFeature(['teleport' as FeatureName])).toThrow(/OG_FEATURE_UNKNOWN/);
    expect(() =>
      resolveFeature({ enable: ['sort'], disable: ['teleport' as FeatureName] }),
    ).toThrow(/OG_FEATURE_UNKNOWN/);
  });

  it('allows a banned feature that nothing in the closure needs', () => {
    const resolved = resolveFeature({ enable: ['sort', 'filter'], disable: ['editing'] });
    expect(resolved.feature.has('editing')).toBe(false);
    expect(resolved.disabled.has('editing')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Option projection
// -----------------------------------------------------------------------------

describe('toGridOptions', () => {
  it('emits both the flat patch and the nested subset for fillHandle', () => {
    const option = toGridOptions(['fillHandle']);
    expect(option.flat.enableFillHandle).toBe(true);
    // editing came in as a dependency, so its option rides along.
    expect(option.flat.editable).toBe(true);
    expect(option.nested.editing?.enableFillHandle).toBe(true);
    expect(option.requiredBinding).toContain('editing.onFillHandle');
    expect(option.requiredBinding).toContain('onCellEdit');
  });

  it('is a pure function of the SET, not of request order', () => {
    expect(toGridOptions(['find', 'sort', 'statusBar'])).toEqual(
      toGridOptions(['statusBar', 'sort', 'find']),
    );
  });

  it('accepts an already-resolved feature set without re-resolving', () => {
    const resolved = resolveFeature(['pivot']);
    expect(toGridOptions(resolved)).toEqual(toGridOptions(['pivot', 'grouping']));
  });

  it('merges nested namespaces instead of clobbering them', () => {
    const option = toGridOptions(['fillHandle', 'columnReorder', 'grouping']);
    expect(option.nested.editing?.enableFillHandle).toBe(true);
    expect(option.nested.columns?.enableReorder).toBe(true);
    expect(option.nested.grouping?.stickyGroupRows).toBe(true);
  });

  it('returns required bindings deduped and sorted', () => {
    const option = toGridOptions(['grouping', 'tree']);
    const sorted = [...option.requiredBinding].sort();
    expect(option.requiredBinding).toEqual(sorted);
    expect(new Set(option.requiredBinding).size).toBe(option.requiredBinding.length);
    expect(option.requiredBinding).toContain('getRowMeta');
  });

  it('produces an empty patch for a feature set that only needs core defaults', () => {
    const option = toGridOptions(['sort']);
    expect(option.flat).toEqual({});
    expect(option.nested).toEqual({});
    expect(option.requiredBinding).toEqual(['sorting.onHeaderClick']);
  });
});

// -----------------------------------------------------------------------------
// Presets
// -----------------------------------------------------------------------------

describe('presets', () => {
  it('all seven resolve without a dependency conflict', () => {
    for (const preset of ALL_PRESET) {
      expect(() =>
        resolveFeature({ enable: preset.feature, disable: preset.disabled }),
      ).not.toThrow();
    }
    expect(Object.keys(PRESET)).toHaveLength(7);
  });

  it('spreadsheet is the only preset with a formula engine and a fill handle', () => {
    const withFormula = ALL_PRESET.filter((p) => p.feature.includes('formula'));
    expect(withFormula.map((p) => p.name)).toEqual(['spreadsheet']);
    expect(spreadsheetPreset.feature).toEqual(
      expect.arrayContaining(['fillHandle', 'find', 'undo', 'clipboard']),
    );
    expect(spreadsheetPreset.density).toBe('compact');
    expect(spreadsheetPreset.interaction.keyboardFirst).toBe(true);
    expect(spreadsheetPreset.disabled).toContain('serverSideRow');
  });

  it('database editor is server-paged and row-oriented, with no pivot or formula', () => {
    expect(databaseEditorPreset.feature).toEqual(
      expect.arrayContaining([
        'serverSideRow',
        'editing',
        'undo',
        'selectionCheckbox',
        'masterDetail',
        'contextMenu',
      ]),
    );
    expect(databaseEditorPreset.disabled).toEqual(
      expect.arrayContaining(['pivot', 'formula', 'fillHandle']),
    );
    expect(databaseEditorPreset.theme).toBe('dark');
    expect(databaseEditorPreset.interaction.readOnly).toBe(false);
    // Deeper than the spreadsheet's, because a block miss is a network round trip.
    expect(databaseEditorPreset.interaction.overscanRow).toBeGreaterThan(
      spreadsheetPreset.interaction.overscanRow,
    );
  });

  it('dashboard is read-only with charts and sparklines and no editing family', () => {
    expect(dashboardPreset.interaction.readOnly).toBe(true);
    expect(dashboardPreset.feature).toEqual(
      expect.arrayContaining(['chart', 'sparkline', 'grouping', 'flashCell']),
    );
    for (const banned of ['editing', 'clipboard', 'fillHandle', 'formula', 'undo'] as const) {
      expect(dashboardPreset.feature).not.toContain(banned);
      expect(dashboardPreset.disabled).toContain(banned);
    }
    expect(dashboardPreset.theme).toBe('auto');
    expect(dashboardPreset.density).toBe('comfortable');
  });

  it('report is the only preset that turns virtualization off', () => {
    const nonVirtual = ALL_PRESET.filter((p) => !p.interaction.virtualScroll);
    expect(nonVirtual.map((p) => p.name)).toEqual(['report']);
    expect(reportPreset.interaction.motion).toBe('none');
    expect(reportPreset.interaction.overscanRow).toBe(0);
    expect(reportPreset.theme).toBe('light');
    expect(reportPreset.feature).toEqual(expect.arrayContaining(['pivot', 'export']));
    // pivot implies grouping even though the preset does not list it.
    const resolved = resolveFeature({
      enable: reportPreset.feature,
      disable: reportPreset.disabled,
    });
    expect(resolved.feature.has('grouping')).toBe(true);
  });

  it('mobile is the only coarse-pointer preset and the only one with 44 px targets', () => {
    const coarse = ALL_PRESET.filter((p) => p.interaction.pointer === 'coarse');
    expect(coarse.map((p) => p.name)).toEqual(['mobile']);
    expect(mobilePreset.interaction.hitTargetPx).toBe(44);
    expect(mobilePreset.interaction.hoverAffordance).toBe(false);
    expect(mobilePreset.interaction.swipeAction).toBe(true);
    expect(mobilePreset.density).toBe('comfortable');
    for (const banned of ['columnResize', 'rowResize', 'fillHandle'] as const) {
      expect(mobilePreset.disabled).toContain(banned);
    }
    expect(mobilePreset.feature).toContain('touch');
  });

  it('minimal enables exactly one feature and denies every other', () => {
    expect(minimalPreset.feature).toEqual(['sort']);
    expect(new Set([...minimalPreset.feature, ...minimalPreset.disabled]).size).toBe(
      FEATURE_NAME.length,
    );
    expect(minimalPreset.interaction.virtualScroll).toBe(true);
  });

  it('analytics is DuckDB-backed, read-only, and tuned deeper than every other preset', () => {
    expect(analyticsPreset.feature).toEqual(
      expect.arrayContaining(['duckdb', 'serverSideRow', 'pivot', 'grouping', 'chart']),
    );
    expect(analyticsPreset.interaction.readOnly).toBe(true);
    const deepest = Math.max(...ALL_PRESET.map((p) => p.interaction.overscanRow));
    expect(analyticsPreset.interaction.overscanRow).toBe(deepest);
    // toolPanel is listed; columnReorder is not — it arrives implied.
    const resolved = resolveFeature({
      enable: analyticsPreset.feature,
      disable: analyticsPreset.disabled,
    });
    expect(analyticsPreset.feature).not.toContain('columnReorder');
    expect(resolved.implied.has('columnReorder')).toBe(true);
  });

  it('gives every preset a genuinely distinct feature set and interaction profile', () => {
    const featureKey = new Set(ALL_PRESET.map((p) => [...p.feature].sort().join(',')));
    expect(featureKey.size).toBe(ALL_PRESET.length);
    const interactionKey = new Set(
      ALL_PRESET.map((p) => JSON.stringify(p.interaction)),
    );
    expect(interactionKey.size).toBe(ALL_PRESET.length);
    expect(new Set(ALL_PRESET.map((p) => p.name)).size).toBe(ALL_PRESET.length);
  });
});

// -----------------------------------------------------------------------------
// Merge semantics
// -----------------------------------------------------------------------------

describe('extendPreset', () => {
  it('merges plain objects recursively, leaving untouched siblings alone', () => {
    const next = extendPreset(dashboardPreset, { interaction: { motion: 'none' } });
    expect(next.interaction.motion).toBe('none');
    expect(next.interaction.hitTargetPx).toBe(dashboardPreset.interaction.hitTargetPx);
    expect(next.interaction.readOnly).toBe(true);
    expect(next.density).toBe(dashboardPreset.density);
  });

  it('REPLACES arrays rather than concatenating them', () => {
    const next = extendPreset(spreadsheetPreset, { feature: ['sort'] });
    expect(next.feature).toEqual(['sort']);
    expect(next.feature).not.toContain('formula');
  });

  it('ignores undefined in the override but honours an explicit null', () => {
    const ignored = extendPreset(spreadsheetPreset, {
      theme: undefined,
    } as unknown as PresetOverride);
    expect(ignored.theme).toBe('light');
    const nulled = extendPreset(spreadsheetPreset, {
      theme: null,
    } as unknown as PresetOverride);
    expect(nulled.theme).toBeNull();
  });

  it('mutates neither input and aliases no sub-object into the result', () => {
    const snapshot = JSON.stringify(spreadsheetPreset);
    const next = extendPreset(spreadsheetPreset, { name: 'derived' });
    expect(JSON.stringify(spreadsheetPreset)).toBe(snapshot);
    expect(next.interaction).not.toBe(spreadsheetPreset.interaction);
    expect(next.feature).not.toBe(spreadsheetPreset.feature);
    expect(next.interaction).toEqual(spreadsheetPreset.interaction);
  });

  it('composes: a read-only spreadsheet still resolves', () => {
    const readOnly = extendPreset(spreadsheetPreset, {
      name: 'read-only-spreadsheet',
      feature: ['sort', 'filter', 'find', 'export'],
      disabled: ['editing', 'formula', 'fillHandle', 'undo', 'clipboard'],
      interaction: { readOnly: true },
    });
    expect(() =>
      resolveFeature({ enable: readOnly.feature, disable: readOnly.disabled }),
    ).not.toThrow();
    expect(readOnly.interaction.keyboardFirst).toBe(true);
  });
});

describe('withFeature / withoutFeature', () => {
  it('appends without duplicating and lifts the name off the deny list', () => {
    const next = withFeature(minimalPreset, 'filter', 'sort');
    expect(next.feature).toEqual(['sort', 'filter']);
    expect(next.disabled).not.toContain('filter');
  });

  it('removes a feature AND bans it so no dependency edge reintroduces it', () => {
    const next = withoutFeature(dashboardPreset, 'sparkline');
    expect(next.feature).not.toContain('sparkline');
    expect(next.disabled).toContain('sparkline');
  });

  it('surfaces the resulting contradiction instead of hiding it', () => {
    // Banning editing while fillHandle survives is exactly the case
    // resolveFeature is supposed to refuse.
    const broken = withoutFeature(spreadsheetPreset, 'editing');
    expect(broken.feature).toContain('fillHandle');
    expect(() =>
      resolveFeature({ enable: broken.feature, disable: broken.disabled }),
    ).toThrow(FeatureDependencyError);
  });
});

// -----------------------------------------------------------------------------
// Responsive profile
// -----------------------------------------------------------------------------

describe('resolveProfile', () => {
  it('buckets width at the documented breakpoints', () => {
    expect(breakpointOf(0)).toBe('xs');
    expect(breakpointOf(479)).toBe('xs');
    expect(breakpointOf(BREAKPOINT_MIN_WIDTH.sm)).toBe('sm');
    expect(breakpointOf(767)).toBe('sm');
    expect(breakpointOf(BREAKPOINT_MIN_WIDTH.md)).toBe('md');
    expect(breakpointOf(1023)).toBe('md');
    expect(breakpointOf(BREAKPOINT_MIN_WIDTH.lg)).toBe('lg');
    expect(breakpointOf(1439)).toBe('lg');
    expect(breakpointOf(BREAKPOINT_MIN_WIDTH.xl)).toBe('xl');
    expect(breakpointOf(3840)).toBe('xl');
  });

  it('goes compact only where a fine pointer has the width for it', () => {
    expect(resolveProfile({ width: 1920 }).density).toBe('compact');
    expect(resolveProfile({ width: 1280 }).density).toBe('compact');
    expect(resolveProfile({ width: 900 }).density).toBe('comfortable');
    expect(resolveProfile({ width: 380 }).density).toBe('comfortable');
    expect(resolveProfile({ width: 1920 }).hitTargetPx).toBe(24);
    expect(resolveProfile({ width: 380 }).hitTargetPx).toBe(32);
  });

  it('lets pointer beat width — a wide tablet still gets 44 px targets', () => {
    const tablet = resolveProfile({ width: 1280, pointer: 'coarse' });
    expect(tablet.hitTargetPx).toBe(44);
    expect(tablet.density).toBe('comfortable');
    expect(tablet.hoverAffordance).toBe(false);
    expect(tablet.swipeAction).toBe(true);
    expect(tablet.autoDisable).toEqual(
      expect.arrayContaining(['columnResize', 'rowResize', 'fillHandle']),
    );
  });

  it('goes spacious on the narrowest coarse screens and strips the heavy chrome', () => {
    const phone = resolveProfile({ width: 390, pointer: 'coarse' });
    expect(phone.breakpoint).toBe('xs');
    expect(phone.density).toBe('spacious');
    expect(phone.autoDisable).toEqual(
      expect.arrayContaining(['toolPanel', 'chart', 'pivot', 'statusBar', 'columnGroup']),
    );
  });

  it('treats pointer:none as coarse for sizing', () => {
    const tv = resolveProfile({ width: 1920, pointer: 'none' });
    expect(tv.hitTargetPx).toBe(44);
    expect(tv.hoverAffordance).toBe(false);
  });

  it('drops the tool panel and charts at sm but keeps the rest', () => {
    const small = resolveProfile({ width: 600 });
    expect(small.breakpoint).toBe('sm');
    expect(small.autoDisable).toEqual(expect.arrayContaining(['toolPanel', 'chart']));
    expect(small.autoDisable).not.toContain('pivot');
  });

  it('honours prefers-reduced-motion by killing motion and the cell flash', () => {
    const reduced = resolveProfile({ width: 1440, reducedMotion: true });
    expect(reduced.motion).toBe('none');
    expect(reduced.autoDisable).toContain('flashCell');
    expect(reduced.reason.join(' ')).toContain('prefers-reduced-motion');
    expect(resolveProfile({ width: 1440 }).motion).toBe('full');
  });

  it('honours forced-colors by dropping the colour-encoded features', () => {
    const forced = resolveProfile({ width: 1440, forcedColors: true });
    expect(forced.highContrast).toBe(true);
    expect(forced.autoDisable).toEqual(expect.arrayContaining(['sparkline', 'flashCell']));
    expect(resolveProfile({ width: 1440 }).highContrast).toBe(false);
  });

  it('returns autoDisable in registry order so the output is deterministic', () => {
    const profile = resolveProfile({ width: 390, pointer: 'coarse', forcedColors: true });
    const index = profile.autoDisable.map((name) => FEATURE_NAME.indexOf(name));
    expect(index).toEqual([...index].sort((a, b) => a - b));
    expect(new Set(profile.autoDisable).size).toBe(profile.autoDisable.length);
  });
});

describe('pruneFeature / applyProfile', () => {
  it('prunes a dependent when its dependency is denied', () => {
    expect(pruneFeature(['toolPanel', 'sort'], ['columnReorder'])).toEqual(['sort']);
    expect(pruneFeature(['pivot', 'sort'], ['grouping'])).toEqual(['sort']);
  });

  it('leaves an independent feature alone', () => {
    expect(pruneFeature(['sort', 'chart'], ['editing'])).toEqual(['sort', 'chart']);
  });

  it('never produces a preset that fails to resolve', () => {
    const condition = [
      { width: 390, pointer: 'coarse' as const },
      { width: 1280, pointer: 'coarse' as const },
      { width: 1920, forcedColors: true },
      { width: 600, reducedMotion: true },
      { width: 1440 },
    ];
    for (const preset of ALL_PRESET) {
      for (const c of condition) {
        const adapted = applyProfile(preset, resolveProfile(c));
        expect(() =>
          resolveFeature({ enable: adapted.feature, disable: adapted.disabled }),
        ).not.toThrow();
      }
    }
  });

  it('rewrites density and interaction but preserves the preset identity', () => {
    const adapted = applyProfile(
      databaseEditorPreset,
      resolveProfile({ width: 800, pointer: 'coarse' }),
    );
    expect(adapted.name).toBe('database-editor');
    expect(adapted.interaction.hitTargetPx).toBe(44);
    expect(adapted.interaction.pointer).toBe('coarse');
    expect(adapted.density).toBe('comfortable');
    // toolPanel loses its columnReorder dependency on touch and is pruned.
    expect(adapted.feature).not.toContain('toolPanel');
    expect(adapted.feature).toContain('editing');
    expect(adapted.interaction.readOnly).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Responsive binding
// -----------------------------------------------------------------------------

class FakeMediaQuery implements MediaQueryLike {
  matches = false;
  readonly listener = new Set<() => void>();
  addEventListener(_type: 'change', listener: () => void): void {
    this.listener.add(listener);
  }
  removeEventListener(_type: 'change', listener: () => void): void {
    this.listener.delete(listener);
  }
}

function fakeMatchMedia(matching: readonly string[]) {
  const registry = new Map<string, FakeMediaQuery>();
  const mm = (query: string): FakeMediaQuery => {
    let entry = registry.get(query);
    if (!entry) {
      entry = new FakeMediaQuery();
      entry.matches = matching.includes(query);
      registry.set(query, entry);
    }
    return entry;
  };
  return { mm, registry };
}

describe('createResponsivePreset', () => {
  it('falls back cleanly when matchMedia is absent (SSR)', () => {
    const responsive = createResponsivePreset(dashboardPreset, { matchMedia: null });
    expect(responsive.ssr).toBe(true);
    expect(responsive.profile.breakpoint).toBe('lg');
    expect(responsive.current.density).toBe('compact');
    const listener = vi.fn();
    const off = responsive.subscribe(listener);
    recomputeResponsivePreset(responsive);
    expect(listener).not.toHaveBeenCalled();
    off();
    responsive.destroy();
  });

  it('uses the declared SSR fallback viewport', () => {
    const responsive = createResponsivePreset(dashboardPreset, {
      matchMedia: null,
      fallback: { width: 390, pointer: 'coarse' },
    });
    expect(responsive.ssr).toBe(true);
    expect(responsive.current.density).toBe('spacious');
    expect(responsive.current.interaction.hitTargetPx).toBe(44);
  });

  it('reads the initial state from the injected media queries', () => {
    const { mm } = fakeMatchMedia([
      '(min-width: 480px)',
      '(min-width: 768px)',
      '(pointer: coarse)',
    ]);
    const responsive = createResponsivePreset(databaseEditorPreset, { matchMedia: mm });
    expect(responsive.ssr).toBe(false);
    expect(responsive.profile.breakpoint).toBe('md');
    expect(responsive.profile.hitTargetPx).toBe(44);
    expect(responsive.current.feature).not.toContain('columnResize');
    responsive.destroy();
  });

  it('notifies subscribers when a media query flips, and only when something changed', () => {
    const { mm, registry } = fakeMatchMedia([
      '(min-width: 480px)',
      '(min-width: 768px)',
      '(min-width: 1024px)',
      '(min-width: 1440px)',
    ]);
    const responsive = createResponsivePreset(dashboardPreset, { matchMedia: mm });
    expect(responsive.profile.breakpoint).toBe('xl');

    const listener = vi.fn();
    responsive.subscribe(listener);

    // A no-op change must not wake anybody up.
    for (const l of registry.get('(min-width: 1440px)')!.listener) l();
    expect(listener).not.toHaveBeenCalled();

    // Shrink to a phone and go coarse — one burst, one notification.
    for (const query of [
      '(min-width: 1440px)',
      '(min-width: 1024px)',
      '(min-width: 768px)',
      '(min-width: 480px)',
    ]) {
      registry.get(query)!.matches = false;
    }
    registry.get('(pointer: coarse)')!.matches = true;
    for (const l of registry.get('(min-width: 480px)')!.listener) l();

    expect(listener).toHaveBeenCalledTimes(1);
    const [preset, profile] = listener.mock.calls[0] as [Preset, { breakpoint: string }];
    expect(profile.breakpoint).toBe('xs');
    expect(preset.density).toBe('spacious');
    expect(preset.feature).not.toContain('chart');
    expect(responsive.current).toBe(preset);
    expect(responsive.base).toBe(dashboardPreset);
    responsive.destroy();
  });

  it('unsubscribes and destroys without firing again', () => {
    const { mm, registry } = fakeMatchMedia(['(min-width: 480px)']);
    const responsive = createResponsivePreset(mobilePreset, { matchMedia: mm });
    const listener = vi.fn();
    const off = responsive.subscribe(listener);
    off();
    registry.get('(pointer: coarse)')!.matches = true;
    recomputeResponsivePreset(responsive);
    expect(listener).not.toHaveBeenCalled();
    responsive.destroy();
    expect(registry.get('(min-width: 480px)')!.listener.size).toBe(0);
    responsive.destroy();
  });

  it('supports the legacy addListener MediaQueryList shape', () => {
    const attached: (() => void)[] = [];
    const mm = (_query: string): MediaQueryLike => ({
      matches: false,
      addListener: (listener: () => void) => attached.push(listener),
      removeListener: () => undefined,
    });
    const responsive = createResponsivePreset(minimalPreset, { matchMedia: mm });
    expect(responsive.ssr).toBe(false);
    expect(attached.length).toBeGreaterThan(0);
    expect(responsive.profile.breakpoint).toBe('xs');
    responsive.destroy();
  });
});

// -----------------------------------------------------------------------------
// Bundle honesty
// -----------------------------------------------------------------------------

describe('estimateBundle', () => {
  it('charges the minimal preset nothing beyond the core baseline', () => {
    const estimate = estimateBundle(minimalPreset.feature);
    expect(estimate.featureByte).toBe(0);
    expect(estimate.packageEntry).toEqual([]);
    // Asserted against BASELINE_PACKAGE rather than a literal: core's budget is
    // a real, moving number, and hardcoding it here means every honest budget
    // re-measurement lands as a spurious failure in an unrelated package.
    // `gzipByte` is nullable for packages with no budget file; core always has
    // one, so narrow explicitly rather than asserting a literal that goes stale
    // every time the budget is honestly re-measured.
    const baseline = BASELINE_PACKAGE.gzipByte;
    expect(baseline).not.toBeNull();
    expect(estimate.baselineByte).toBe(baseline);
    expect(estimate.totalByte).toBe(baseline);
    expect(estimate.totalKb).toBe(Math.round((baseline ?? 0) / 1024));
    expect(estimate.unmeasured).toEqual([]);
  });

  it('counts a shared package once even when two features pull it in', () => {
    const single = estimateBundle(['grouping']);
    const both = estimateBundle(['grouping', 'pivot']);
    expect(single.featureByte).toBe(12800);
    expect(both.featureByte).toBe(12800);
    expect(both.packageEntry).toHaveLength(1);
    expect(both.packageEntry[0]!.feature).toEqual(['grouping', 'pivot']);
  });

  it('reports budget-less packages as unmeasured instead of guessing', () => {
    const estimate = estimateBundle(dashboardPreset.feature);
    expect(estimate.unmeasured).toEqual(['export']);
    // data 12800 + chart 10420 + sparklines 2048 + intl 4096
    expect(estimate.featureByte).toBe(29364);
    expect(estimate.note.join(' ')).toContain('Lower bound only');
    const nullEntry = estimate.packageEntry.filter((e) => e.gzipByte === null);
    expect(nullEntry.map((e) => e.package)).toEqual(['@onegrid/export']);
  });

  it('closes dependencies before costing, and says which were implied', () => {
    const estimate = estimateBundle(['pivot']);
    expect(estimate.featureByte).toBe(12800);
    expect(estimate.note.join(' ')).toContain('grouping');
  });

  it('orders the breakdown by known size descending with unknowns last', () => {
    const estimate = estimateBundle(analyticsPreset.feature);
    const known = estimate.packageEntry.filter((e) => e.gzipByte !== null);
    const unknown = estimate.packageEntry.filter((e) => e.gzipByte === null);
    expect(estimate.packageEntry.slice(0, known.length)).toEqual(known);
    expect(unknown.length).toBeGreaterThan(0);
    for (let i = 1; i < known.length; i++) {
      expect(known[i - 1]!.gzipByte!).toBeGreaterThanOrEqual(known[i]!.gzipByte!);
    }
    // data 12800 + chart 10420 + ssrm 8192 + react 4096 + sparklines 2048
    expect(estimate.featureByte).toBe(37556);
  });

  it('always names the baseline caveat', () => {
    const estimate = estimateBundle(['sort']);
    expect(estimate.note[0]).toContain('bundle-budget.json');
    expect(estimate.note.join(' ')).toContain('@onegrid/core');
  });
});

describe('cost table against the real bundle-budget.json files', () => {
  const budgetByteOf = (pkgDir: string): number | null => {
    const file = join(REPO_ROOT, 'packages', pkgDir, 'bundle-budget.json');
    if (!existsSync(file)) return null;
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: { file: string; bytes: number }[];
    };
    const entry = json.entries.find((e) => e.file === 'dist/index.js');
    return entry ? entry.bytes : null;
  };

  const DIR_OF: Readonly<Record<string, string>> = {
    '@onegrid/core': 'core',
    '@onegrid/data': 'data',
    '@onegrid/formula': 'formula',
    '@onegrid/sparklines': 'sparklines',
    '@onegrid/touch': 'touch',
    '@onegrid/intl': 'intl',
    '@onegrid/ssrm': 'ssrm',
    '@onegrid/react': 'adapters/react',
    '@onegrid/chart': 'chart',
    '@onegrid/export': 'export',
    '@onegrid/undo': 'undo',
    '@onegrid/duckdb': 'duckdb',
  };

  it('reaches every package the cost table names', () => {
    expect(Object.keys(DIR_OF).sort()).toEqual(Object.keys(PACKAGE_COST).sort());
  });

  it('matches every transcribed byte figure to the file it came from', () => {
    for (const [pkg, dir] of Object.entries(DIR_OF)) {
      expect(PACKAGE_COST[pkg]!.gzipByte, `${pkg} budget`).toBe(budgetByteOf(dir));
    }
  });

  it('reports null exactly for the packages with no budget file on disk', () => {
    const declaredNull = Object.values(PACKAGE_COST)
      .filter((c) => c.gzipByte === null)
      .map((c) => c.package)
      .sort();
    const actualNull = Object.entries(DIR_OF)
      .filter(([, dir]) => !existsSync(join(REPO_ROOT, 'packages', dir, 'bundle-budget.json')))
      .map(([pkg]) => pkg)
      .sort();
    expect(declaredNull).toEqual(actualNull);
    expect(declaredNull).toEqual(['@onegrid/duckdb', '@onegrid/export', '@onegrid/undo']);
  });

  it('keeps the baseline pinned to core', () => {
    expect(BASELINE_PACKAGE.package).toBe('@onegrid/core');
    expect(BASELINE_PACKAGE.gzipByte).toBe(budgetByteOf('core'));
  });
});
