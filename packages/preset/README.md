# @onegrid/preset

Compile-time feature opt-in for oneGrid.

oneGrid's `GridOptions` is one interface with roughly sixty fields. That is the
right shape for the renderer and the wrong shape for a person deciding what kind
of grid they are building. This package is the layer in between: every
capability is a named toggle, dependencies between them are enforced rather than
documented, and seven complete presets answer "what kind of app is this?" in one
import.

```
pnpm add @onegrid/preset
```

## The one-liner

```ts
import { Grid } from '@onegrid/core';
import { spreadsheetPreset } from '@onegrid/preset/spreadsheet';
import { toGridOptions } from '@onegrid/preset/feature';

const option = toGridOptions(spreadsheetPreset.feature);

const grid = new Grid({
  host,
  columns: column,
  rowSource,
  rowHeight: 24,
  ...option.flat,          // enableFillHandle, enableFind, statusBar, editable, …
  onCellEdit: applyEdit,   // option.requiredBinding tells you which of these you owe
});
```

`option.requiredBinding` is the checklist. The grid never owns row data, so every
mutating feature terminates in a callback you write; the list names each one
(`onCellEdit`, `editing.onFillHandle`, `getRowMeta`, …) so "I turned it on and
nothing happened" is answerable.

`option.nested` carries the same intent in core's nested namespace form for
`defineGridOptions`. It is a strict subset — core's nested schema has no slot yet
for `statusBar`, `enableFind` or `enableColumnResize` — and the two shapes cannot
be mixed in one call, because `defineGridOptions` rejects unknown top-level keys.

## Features and dependency

`FeatureName` is a closed union of 31 toggles, each mapped to a real
`GridOptions` field, a real workspace package, or a real `@onegrid/plugin-kit`
registry. `FEATURE_META[name].option` is typed `Partial<GridOptions>`, so a
feature that disappears from core breaks this package at compile time.

Some features cannot exist alone:

| feature | needs | why |
| --- | --- | --- |
| `pivot` | `grouping` | pivot output reaches the renderer as group rows |
| `tree` | `grouping` | tree rows ride the same `getRowMeta` / `onToggleGroup` channel |
| `fillHandle` | `editing` | a fill handle that cannot write does nothing |
| `clipboard` | `editing` | `onPaste` delivers a rectangle you must write somewhere |
| `formula` | `editing` | formulas are typed into cells |
| `undo` | `editing` | undo inverts mutations |
| `toolPanel` | `columnReorder` | the panel's job is showing, hiding and reordering columns |

```ts
const resolved = resolveFeature({ enable: ['pivot'], disable: [] });
resolved.feature;  // Set { 'pivot', 'grouping' }
resolved.implied;  // Set { 'grouping' }  ← nobody asked for it
```

Asking for a feature whose dependency the same request bans is an error, not a
coin flip:

```ts
resolveFeature({ enable: ['fillHandle'], disable: ['editing'] });
// FeatureDependencyError: [OG_FEATURE_DEP_CONFLICT] 'fillHandle' requires
// 'editing', which this request explicitly disables. Either drop 'editing'
// from `disable` or drop 'fillHandle' from `enable`.
```

## The seven presets

Each is a plain data object — no closures — so it survives `structuredClone`,
JSON and a server-to-client boundary.

| preset | import | shape |
| --- | --- | --- |
| `spreadsheetPreset` | `@onegrid/preset/spreadsheet` | formula, fill handle, find/replace, undo, clipboard, both resize axes. Compact, light, keyboard-first. |
| `databaseEditorPreset` | `@onegrid/preset/database-editor` | the Supabase table-editor profile: server-paged rows, per-cell edits with undo, foreign-key detail expansion, checkbox selection. No pivot, no formula, no fill handle. |
| `dashboardPreset` | `@onegrid/preset/dashboard` | read-only: grouping with aggregates, pinned totals, sparklines, range charts, cell flash. Comfortable, theme-following. |
| `reportPreset` | `@onegrid/preset/report` | pivot, grouping, export, print. The only preset with virtualization **off**, because a paginator cannot see virtualized rows. No interaction at all. |
| `mobilePreset` | `@onegrid/preset/mobile` | coarse pointer: 44 px hit targets, swipe row actions, long-press menu, no hover, no drag handles. |
| `minimalPreset` | `@onegrid/preset/minimal` | virtual scroll plus sort. Every other feature explicitly denied. |
| `analyticsPreset` | `@onegrid/preset/analytics` | DuckDB-backed, server-paged, grouping and pivot, charts, tool panel. Deepest overscan of any preset. |

Each preset is its own module and its own package export, so an app that only
ships the mobile profile never pulls the other six — or the registry — into its
graph. `@onegrid/preset/feature`, `/profile` and `/cost` split the same way.

## Extending

```ts
const readOnlySpreadsheet = extendPreset(spreadsheetPreset, {
  name: 'read-only-spreadsheet',
  feature: ['sort', 'filter', 'find', 'export'],
  disabled: ['editing', 'formula', 'fillHandle', 'undo', 'clipboard'],
  interaction: { readOnly: true },   // the other eight interaction fields survive
});
```

Merge rules, each covered by a test:

1. **Plain objects merge recursively.** Prototype must be `Object.prototype` or
   null; a Set, Map, Date or class instance is a value, not a thing to merge.
2. **Arrays replace.** They never concatenate. Concatenation is unremovable —
   once `feature` concatenates there is no way to spell "the base list, minus
   grouping". For additive edits use `withFeature` / `withoutFeature`, which say
   so in their names.
3. **`undefined` in the override is absent, not a delete**, so spread-built
   overrides are safe.
4. **`null` replaces.** It is a value someone typed on purpose.
5. **The result is new.** Neither input is mutated and no sub-object of the base
   is aliased into the result.

`withoutFeature` both removes a feature and bans it, so a dependency edge cannot
quietly reintroduce it — `withoutFeature(spreadsheetPreset, 'editing')` leaves
`fillHandle` in place and therefore raises `FeatureDependencyError` at resolve
time rather than silently switching editing back on.

## Responsive

```ts
const responsive = createResponsivePreset(databaseEditorPreset);
render(responsive.current);
const off = responsive.subscribe((preset) => render(preset));
// teardown: off(); responsive.destroy();
```

`resolveProfile({ width, pointer, reducedMotion, forcedColors })` decides
density, hit-target size, motion and which features the environment cannot
support:

- Breakpoints are 480 / 768 / 1024 / 1440 px, width only.
- **Pointer beats width.** A 1280 px tablet is a coarse pointer and gets 44 px
  targets (Apple HIG, WCAG 2.2 AAA 2.5.5) and comfortable density; a narrow
  desktop window stays a fine pointer and keeps its drag handles, at 32 px
  targets under 768 px and 24 px above (WCAG 2.2 AA 2.5.8 floor is 24).
- Coarse pointers lose the drag handles — column resize, row resize, fill
  handle, drag reorder — because all four are sub-10 px targets that fight the
  scroll gesture.
- `pointer: none` (TV remote, keyboard-only kiosk) is sized as coarse.
- Below 480 px the tool panel, charts, pivot, the column-group band and the
  status bar come off; below 768 px the tool panel and charts do.
- `prefers-reduced-motion: reduce` sets `motion: 'none'` and removes the cell
  flash — a 600 ms animated tint is exactly the unrequested movement the query
  asks us to stop.
- `forced-colors: active` removes sparklines and the cell flash, both of which
  encode meaning in colours the UA replaces, and sets `highContrast` so you can
  emit `forcedColorsBlock()` from `@onegrid/tokens`.

Auto-disabling never orphans a dependent: `applyProfile` prunes the dependency
cascade to a fixpoint, so dropping `columnReorder` on touch also drops
`toolPanel`, and the returned preset always resolves.

`matchMedia` is injectable and its absence is a supported state. On a server,
`ssr` is `true`, `current` is resolved from `option.fallback` (default: 1280 px,
fine pointer), and `subscribe` returns a no-op unsubscribe that never fires — so
the same call site works in a Node render pass and in the browser.

## Bundle honesty

```ts
const estimate = estimateBundle(dashboardPreset.feature);
estimate.totalKb;      // 58.7
estimate.unmeasured;   // ['export']
estimate.note;         // the caveats, in words
```

Every figure is transcribed from a `bundle-budget.json` in this repository.
`scripts/check-bundle-budget.mjs` gzips each package's `dist/index.js` at level 9
and fails the build above the declared number, so these are **enforced gzip
ceilings, not measured sizes**, and this package says so instead of implying a
precision it does not have. `@onegrid/core` is reported separately as the
baseline — every feature ships through the renderer, so its 30 KB belongs to
none of them.

Three packages — `@onegrid/export`, `@onegrid/undo` and `@onegrid/duckdb` — have
no budget file. Their features report `gzipByte: null`, land in `unmeasured`, and
the estimate is labelled a lower bound. A guess there would be worse than
useless: an adopter would plan around a number nobody measured. A test in this
package reads the budget files off disk and fails if the transcribed constants
drift from them.

## Relationship to `@onegrid/plugin-kit`

They compose; they do not compete. plugin-kit owns **runtime** composition —
facets combine many inputs into one, compartments swap a sub-extension live.
This package owns the **compile-time** decision of which features exist at all.
A preset picks the set; a compartment swaps one member of it while the grid is
running. Different clocks.

## License

MIT
