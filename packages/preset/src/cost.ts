// =============================================================================
// @onegrid/preset/cost — what a preset costs to ship
//
// Every number in this file is transcribed from a `bundle-budget.json` that
// exists in this repository. `scripts/check-bundle-budget.mjs` gzips each
// package's `dist/index.js` at level 9 and fails the build if it exceeds the
// declared byte count, so the figures are enforced gzip CEILINGS — the real
// artifact is at or under them. They are not measured sizes, and this module
// says so rather than implying a precision it does not have.
//
// Where a package has NO budget file, the entry is `null` and the feature is
// reported under `unmeasured`. Three features are in that state today —
// export, undo and duckdb. Guessing a number for them would be worse
// than useless: an adopter would plan around a figure nobody measured.
// A test in this package reads the budget files off disk and fails if these
// constants drift from them, which is the only thing that keeps a hand-copied
// table honest.
//
// @onegrid/core is handled separately as the BASELINE. Every feature ships
// through the renderer, so its 30 KB is not attributable to any one feature
// and is never summed into `featureByte`.
// =============================================================================

import { FEATURE_META, type FeatureName, type ResolvedFeature, type FeatureRequest, resolveFeature } from './feature.js';

/**
 * A package's gzip budget as declared in its `bundle-budget.json`.
 * @public
 */
export interface PackageCost {
  readonly package: string;
  /** Gzip budget of `dist/index.js` in bytes, or `null` when the package has
   *  no `bundle-budget.json` and therefore no enforced number. */
  readonly gzipByte: number | null;
  /** Why this package costs what it does, or why it has no figure. */
  readonly note: string;
}

/**
 * The package whose cost is unavoidable. Not attributed to any feature.
 * @public
 */
export const BASELINE_PACKAGE: PackageCost = {
  package: '@onegrid/core',
  gzipByte: 39936,
  note: 'Canvas renderer, ARIA shadow, Fenwick heights, selection, editing. Hard floor — every feature ships through it. Optional core features (merged cells, conditional formatting, damage tracking, navigation history, schema evolution, layout, reorder, multi-select) are NOT in this figure: they live behind `@onegrid/core/*` sub-path entries and cost nothing unless imported.',
};

/**
 * Gzip budget per workspace package a feature can live in. Transcribed from
 * the repository's `bundle-budget.json` files.
 * @public
 */
export const PACKAGE_COST: Readonly<Record<string, PackageCost>> = {
  '@onegrid/core': BASELINE_PACKAGE,
  '@onegrid/data': {
    package: '@onegrid/data',
    gzipByte: 12800,
    note: 'Group, aggregate, pivot and sort over columnar data, including the recursive group-by-pivot composition and its hierarchical header tree.',
  },
  '@onegrid/formula': {
    package: '@onegrid/formula',
    gzipByte: 8192,
    note: 'Adapton-style incremental engine plus 41 base functions.',
  },
  '@onegrid/sparklines': {
    package: '@onegrid/sparklines',
    gzipByte: 2048,
    note: 'line, bar and win-loss kinds plus the cell-renderer factory.',
  },
  '@onegrid/touch': {
    package: '@onegrid/touch',
    gzipByte: 7600,
    note: 'Gesture recognizer, swipe-to-reveal row actions, touch CSS emitter, VirtualKeyboard adapter.',
  },
  '@onegrid/intl': {
    package: '@onegrid/intl',
    gzipByte: 4096,
    note: 'Intl wrappers, ICU MessageFormat subset, BCP 47 validator, 75 translation ids.',
  },
  '@onegrid/ssrm': {
    package: '@onegrid/ssrm',
    gzipByte: 8192,
    note: 'Block fetcher, LRU cache, cursor codec, row-diff tracker, optimistic mutator.',
  },
  '@onegrid/react': {
    package: '@onegrid/react',
    gzipByte: 4096,
    note: 'React adapter — hosts the column tool panel and the selection checkbox column. React itself is a peer and is not counted here.',
  },
  '@onegrid/chart': {
    package: '@onegrid/chart',
    gzipByte: 10420,
    note: 'Derivation, scales, geometry, Canvas2D renderer, hit-testing and selection binding for 7 chart kinds.',
  },
  '@onegrid/export': {
    package: '@onegrid/export',
    gzipByte: null,
    note: 'No bundle-budget.json in the repository, so there is no enforced figure to quote.',
  },
  '@onegrid/undo': {
    package: '@onegrid/undo',
    gzipByte: null,
    note: 'No bundle-budget.json in the repository, so there is no enforced figure to quote.',
  },
  '@onegrid/duckdb': {
    package: '@onegrid/duckdb',
    gzipByte: null,
    note: 'No bundle-budget.json in the repository. Separately, DuckDB-WASM itself is an optional peer measured in megabytes and is never part of a oneGrid figure.',
  },
};

/**
 * Cost lookup keyed by feature. Derived from `FEATURE_META[f].package`, so a
 * feature that moves package moves its cost with it.
 * @public
 */
export const FEATURE_COST: Readonly<Record<FeatureName, PackageCost>> =
  Object.fromEntries(
    Object.entries(FEATURE_META).map(([name, meta]) => [
      name,
      PACKAGE_COST[meta.package] ?? {
        package: meta.package,
        gzipByte: null,
        note: 'Package is not in the cost table.',
      },
    ]),
  ) as Record<FeatureName, PackageCost>;

/** One package's contribution to an estimate. @public */
export interface BundlePackageEntry {
  readonly package: string;
  readonly gzipByte: number | null;
  /** The enabled features that pulled this package in. */
  readonly feature: readonly FeatureName[];
  readonly note: string;
}

/** @public */
export interface BundleEstimate {
  /** @onegrid/core, always paid. */
  readonly baselineByte: number;
  /** Sum of every DISTINCT optional package with a known budget. Features
   *  sharing a package (grouping and pivot both live in @onegrid/data) are
   *  counted once. */
  readonly featureByte: number;
  /** baseline + feature, in bytes. */
  readonly totalByte: number;
  /** `totalByte` in KB, one decimal. Convenience only — bytes are the truth. */
  readonly totalKb: number;
  /** Per-package breakdown, largest known figure first, unknowns last. */
  readonly packageEntry: readonly BundlePackageEntry[];
  /** Enabled features whose package has no budget file. The estimate is a
   *  LOWER BOUND while this is non-empty. */
  readonly unmeasured: readonly FeatureName[];
  /** Caveats worth printing next to the number. */
  readonly note: readonly string[];
}

function toKb(byte: number): number {
  return Math.round((byte / 1024) * 10) / 10;
}

/**
 * Estimate the gzipped cost of a feature set.
 *
 * Accepts a bare feature list, a request, or an already-resolved set —
 * dependencies are closed first, so the estimate covers what actually ships
 * rather than what was asked for.
 *
 * ```ts
 * const estimate = estimateBundle(dashboardPreset.feature);
 * console.log(`${estimate.totalKb} KB gzip, unmeasured: ${estimate.unmeasured.join(', ')}`);
 * ```
 * @public
 */
export function estimateBundle(
  input: readonly FeatureName[] | FeatureRequest | ResolvedFeature,
): BundleEstimate {
  const resolved: ResolvedFeature =
    !Array.isArray(input) && (input as ResolvedFeature).feature instanceof Set
      ? (input as ResolvedFeature)
      : resolveFeature(input as readonly FeatureName[] | FeatureRequest);

  const byPackage = new Map<string, FeatureName[]>();
  for (const name of Object.keys(FEATURE_META) as FeatureName[]) {
    if (!resolved.feature.has(name)) continue;
    const pkg = FEATURE_META[name].package;
    if (pkg === BASELINE_PACKAGE.package) continue;
    const bucket = byPackage.get(pkg);
    if (bucket) bucket.push(name);
    else byPackage.set(pkg, [name]);
  }

  const packageEntry: BundlePackageEntry[] = [];
  const unmeasured: FeatureName[] = [];
  let featureByte = 0;

  for (const [pkg, feature] of byPackage) {
    const cost = PACKAGE_COST[pkg] ?? {
      package: pkg,
      gzipByte: null,
      note: 'Package is not in the cost table.',
    };
    if (cost.gzipByte === null) unmeasured.push(...feature);
    else featureByte += cost.gzipByte;
    packageEntry.push({
      package: pkg,
      gzipByte: cost.gzipByte,
      feature,
      note: cost.note,
    });
  }

  // Known figures descending, then unmeasured packages, then alphabetical —
  // a stable order so two runs of the same set print identically.
  packageEntry.sort((a, b) => {
    if (a.gzipByte === null && b.gzipByte === null) {
      return a.package.localeCompare(b.package);
    }
    if (a.gzipByte === null) return 1;
    if (b.gzipByte === null) return -1;
    return b.gzipByte - a.gzipByte || a.package.localeCompare(b.package);
  });

  const baselineByte = BASELINE_PACKAGE.gzipByte ?? 0;
  const totalByte = baselineByte + featureByte;

  const note: string[] = [
    'Figures are the gzip CEILINGS declared in each package bundle-budget.json and enforced by scripts/check-bundle-budget.mjs, not measured artifact sizes.',
    `@onegrid/core (${toKb(baselineByte)} KB) is the baseline every feature ships through and is not attributed to any one feature.`,
  ];
  if (unmeasured.length > 0) {
    note.push(
      `Lower bound only: ${unmeasured.join(', ')} live in packages with no bundle-budget.json, so no figure is claimed for them.`,
    );
  }
  if (resolved.implied.size > 0) {
    note.push(
      `Includes ${[...resolved.implied].join(', ')}, pulled in by dependency rather than requested.`,
    );
  }

  return {
    baselineByte,
    featureByte,
    totalByte,
    totalKb: toKb(totalByte),
    packageEntry,
    unmeasured,
    note,
  };
}
