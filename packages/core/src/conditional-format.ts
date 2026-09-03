// =============================================================================
// Conditional formatting
//
// Per-cell visual rules — colour scales, data bars, icon sets, and predicate
// rules — evaluated per visible cell per frame. Excel's model, with the parts
// that matter for a canvas renderer.
//
// Design decisions, and why:
//
//   1. RULES RESOLVE TO A STYLE, NOT TO A PAINT CALL. Evaluation returns a
//      plain `CellStyle`; the renderer decides how to draw it. That keeps the
//      rule engine free of canvas, testable without one, and reusable by the
//      export/print packages, which need the same colours in a different medium.
//
//   2. SCALE RULES NEED COLUMN STATISTICS, WHICH ARE COMPUTED ONCE PER FRAME.
//      A colour scale needs the column's min/max; computing that per cell is
//      O(rows) per cell. `prepareFormat` computes the statistic for every
//      scale/bar/icon rule once, and `evaluateFormat` is then O(rules) per
//      cell. For a virtualized grid the statistic is computed over the VISIBLE
//      window unless the adopter supplies a whole-column range — and the
//      difference is visible to users (colours shift as you scroll), so it is
//      an explicit option rather than a silent choice.
//
//   3. LATER RULES WIN, PER PROPERTY. Excel applies rules in priority order
//      and lets a later rule override an earlier one field by field. Merging
//      per property (rather than last-rule-wins wholesale) is what lets "red
//      text if negative" and "grey background if stale" compose.
//
//   4. `stopIfTrue` IS SUPPORTED because without it there is no way to express
//      "if this matches, ignore everything below", which is how real
//      spreadsheets express precedence.
// =============================================================================

/** Visual result of evaluating the rule set for one cell. @public */
export interface CellStyle {
  readonly color?: string;
  readonly background?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  /** 0..1 fill fraction for a data bar, drawn behind the text. */
  readonly bar?: { readonly fraction: number; readonly color: string };
  /** Icon key from the rule's icon set, for the renderer to draw. */
  readonly icon?: string;
}

/** @public */
export type FormatOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'between'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty';

/** @public */
export type FormatRule =
  | {
      readonly kind: 'predicate';
      readonly columnId: string;
      readonly operator: FormatOperator;
      readonly value?: unknown;
      /** Upper bound for `between`. */
      readonly value2?: unknown;
      readonly style: CellStyle;
      readonly stopIfTrue?: boolean;
    }
  | {
      readonly kind: 'colorScale';
      readonly columnId: string;
      /** Two or three stops, low → high. Three gives a midpoint diverging scale. */
      readonly stop: ReadonlyArray<string>;
      /** Explicit domain; omit to derive from the prepared statistic. */
      readonly domain?: readonly [number, number];
      readonly stopIfTrue?: boolean;
    }
  | {
      readonly kind: 'dataBar';
      readonly columnId: string;
      readonly color: string;
      readonly domain?: readonly [number, number];
      readonly stopIfTrue?: boolean;
    }
  | {
      readonly kind: 'iconSet';
      readonly columnId: string;
      /** Icons low → high; thresholds are quantile cut points between them. */
      readonly icon: ReadonlyArray<string>;
      readonly domain?: readonly [number, number];
      readonly stopIfTrue?: boolean;
    }
  | {
      readonly kind: 'formula';
      readonly columnId: string;
      /** Adopter-supplied predicate over the whole row. */
      readonly test: (value: unknown, rowIndex: number) => boolean;
      readonly style: CellStyle;
      readonly stopIfTrue?: boolean;
    };

/** Per-column numeric statistic a scale/bar/icon rule needs. @public */
export interface ColumnStat {
  readonly min: number;
  readonly max: number;
}

/** @public */
export interface PreparedFormat {
  readonly rule: ReadonlyArray<FormatRule>;
  readonly stat: ReadonlyMap<string, ColumnStat>;
}

/** #rrggbb → [r,g,b]. Returns null for anything else, so a non-hex stop is
 *  passed through untouched rather than producing a wrong colour. */
function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Interpolate a colour across an ordered stop list. `t` is clamped to 0..1.
 * Interpolation is in sRGB, which is what spreadsheets do — perceptually
 * uniform spaces look better but would not match Excel's output, and matching
 * is the point for a compatibility feature.
 * @public
 */
export function interpolateColor(stop: ReadonlyArray<string>, t: number): string {
  if (stop.length === 0) return '#000000';
  if (stop.length === 1) return stop[0]!;

  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (stop.length - 1);
  const lower = Math.min(stop.length - 2, Math.floor(scaled));
  const local = scaled - lower;

  const a = parseHex(stop[lower]!);
  const b = parseHex(stop[lower + 1]!);
  if (a === null || b === null) return stop[local < 0.5 ? lower : lower + 1]!;

  return toHex([
    a[0] + (b[0] - a[0]) * local,
    a[1] + (b[1] - a[1]) * local,
    a[2] + (b[2] - a[2]) * local,
  ]);
}

/**
 * Coerce a cell value to a number for the scale-type rules.
 *
 * `Number(null)` is 0 and `Number('')` is 0, which would make an empty cell
 * drag a colour scale's domain down to zero and paint a hole as if it were a
 * real minimum. A hole is absent data, not zero, so it becomes NaN here and is
 * skipped by every caller.
 */
function toNumeric(value: unknown): number {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  if (typeof value === 'boolean') return NaN;
  return Number(value);
}

/**
 * Compute the column statistics the scale-type rules need.
 *
 * `readValue` is called once per (rule column × row) in the supplied range —
 * pass the visible window for cheap scrolling, or the whole column for stable
 * colours. See design note 2.
 * @public
 */
export function prepareFormat(
  rule: ReadonlyArray<FormatRule>,
  range: { readonly start: number; readonly end: number },
  readValue: (rowIndex: number, columnId: string) => unknown,
): PreparedFormat {
  const stat = new Map<string, ColumnStat>();

  const needStat = new Set(
    rule
      .filter((r) => r.kind === 'colorScale' || r.kind === 'dataBar' || r.kind === 'iconSet')
      .map((r) => r.columnId),
  );

  for (const columnId of needStat) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let row = range.start; row <= range.end; row++) {
      const numeric = toNumeric(readValue(row, columnId));
      if (!Number.isFinite(numeric)) continue;
      if (numeric < min) min = numeric;
      if (numeric > max) max = numeric;
    }

    // An empty or all-non-numeric column yields a degenerate domain. Store it
    // as 0..0 so normalisation returns a defined value instead of NaN.
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      stat.set(columnId, { min: 0, max: 0 });
    } else {
      stat.set(columnId, { min, max });
    }
  }

  return { rule, stat };
}

/** Position of `value` in a domain, 0..1. A zero-width domain maps to 1 —
 *  every value is simultaneously the min and the max, and a full bar reads
 *  better than an empty one. */
function normalize(value: number, domain: readonly [number, number]): number {
  const [min, max] = domain;
  if (max === min) return 1;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

function domainFor(
  rule: { readonly columnId: string; readonly domain?: readonly [number, number] },
  prepared: PreparedFormat,
): readonly [number, number] {
  if (rule.domain) return rule.domain;
  const stat = prepared.stat.get(rule.columnId);
  return stat ? [stat.min, stat.max] : [0, 1];
}

/** @public */
export function testOperator(
  operator: FormatOperator,
  value: unknown,
  // Optional: `isEmpty` / `isNotEmpty` are unary and take no operand.
  operand?: unknown,
  operand2?: unknown,
): boolean {
  const asNumber = (v: unknown): number =>
    typeof v === 'number' ? v : Number(v);
  const asText = (v: unknown): string =>
    v === null || v === undefined ? '' : String(v);

  switch (operator) {
    case 'equals':
      return value === operand || asText(value) === asText(operand);
    case 'notEquals':
      return !(value === operand || asText(value) === asText(operand));
    case 'greaterThan':
      return asNumber(value) > asNumber(operand);
    case 'greaterThanOrEqual':
      return asNumber(value) >= asNumber(operand);
    case 'lessThan':
      return asNumber(value) < asNumber(operand);
    case 'lessThanOrEqual':
      return asNumber(value) <= asNumber(operand);
    case 'between': {
      const n = asNumber(value);
      const lo = asNumber(operand);
      const hi = asNumber(operand2);
      return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
    }
    case 'contains':
      return asText(value).toLowerCase().includes(asText(operand).toLowerCase());
    case 'notContains':
      return !asText(value).toLowerCase().includes(asText(operand).toLowerCase());
    case 'startsWith':
      return asText(value).toLowerCase().startsWith(asText(operand).toLowerCase());
    case 'endsWith':
      return asText(value).toLowerCase().endsWith(asText(operand).toLowerCase());
    case 'isEmpty':
      return value === null || value === undefined || asText(value) === '';
    case 'isNotEmpty':
      return !(value === null || value === undefined || asText(value) === '');
  }
}

/**
 * Evaluate every rule for one cell and merge the results.
 *
 * Returns null when no rule matched, so the renderer can take its fast path
 * without allocating a style object per cell per frame.
 * @public
 */
export function evaluateFormat(
  prepared: PreparedFormat,
  rowIndex: number,
  columnId: string,
  value: unknown,
): CellStyle | null {
  let style: CellStyle | null = null;

  const merge = (next: CellStyle): void => {
    style = style === null ? next : { ...style, ...next };
  };

  for (const rule of prepared.rule) {
    if (rule.columnId !== columnId) continue;

    let matched = false;

    switch (rule.kind) {
      case 'predicate': {
        matched = testOperator(rule.operator, value, rule.value, rule.value2);
        if (matched) merge(rule.style);
        break;
      }
      case 'formula': {
        matched = rule.test(value, rowIndex);
        if (matched) merge(rule.style);
        break;
      }
      case 'colorScale': {
        const numeric = toNumeric(value);
        if (!Number.isFinite(numeric)) break;
        matched = true;
        merge({
          background: interpolateColor(rule.stop, normalize(numeric, domainFor(rule, prepared))),
        });
        break;
      }
      case 'dataBar': {
        const numeric = toNumeric(value);
        if (!Number.isFinite(numeric)) break;
        matched = true;
        merge({
          bar: {
            fraction: normalize(numeric, domainFor(rule, prepared)),
            color: rule.color,
          },
        });
        break;
      }
      case 'iconSet': {
        const numeric = toNumeric(value);
        if (!Number.isFinite(numeric) || rule.icon.length === 0) break;
        matched = true;
        const t = normalize(numeric, domainFor(rule, prepared));
        // Bucket into equal bands; t === 1 must land in the last bucket, not
        // one past it.
        const index = Math.min(rule.icon.length - 1, Math.floor(t * rule.icon.length));
        merge({ icon: rule.icon[index]! });
        break;
      }
    }

    if (matched && rule.stopIfTrue === true) break;
  }

  return style;
}
