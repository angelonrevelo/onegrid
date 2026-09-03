// =============================================================================
// Inbound context -> grid action
//
// A peer broadcasts `fdc3.instrument { id: { ticker: "AAPL" } }`. What should
// the grid do? The honest answer is that only the adopter knows — scroll to
// the row, select it, or filter the whole grid down to it are all legitimate
// and all different. So this module does the part that is mechanical and
// leaves the part that is a product decision to the caller: it translates the
// context into a typed action carrying a protocol `FilterNode`, and the
// adopter applies that action to their grid.
//
// The translation is the mapping run backwards. Because a mapping records
// which column feeds `id.ticker`, the same declaration that lets the grid
// broadcast a row also tells us which column an inbound ticker must be matched
// against — the adopter never writes the inverse by hand, and the two
// directions cannot drift apart.
//
// Multiple identifiers OR together on purpose. A peer that publishes both a
// ticker and an ISIN is describing one security; a row matching either is the
// row they mean. Requiring both would break the extremely common case where
// one of the two columns is null.
// =============================================================================

import type { ComparisonFilter, FilterNode } from '@onegrid/protocol';

import type { Fdc3ContextBase, Fdc3ContextType } from './context.js';
import type { ContextMapping } from './mapping.js';
import { getPath } from './path.js';

/** @public */
export type GridActionKind = 'select-row' | 'scroll-to' | 'filter' | 'none';

/**
 * What the adopter should do with an inbound context. `filter` is the
 * predicate that identifies the target row(s) — feed it straight into the
 * grid's filter model, or evaluate it locally to find a row index.
 * @public
 */
export interface GridMatchAction {
  readonly kind: Exclude<GridActionKind, 'none'>;
  readonly filter: FilterNode;
  /** The context type that produced this action. */
  readonly contextType: string;
  /** Grid columns the filter touches — useful for "this column is not
   *  currently visible, reveal it" handling. */
  readonly column: readonly string[];
}

/**
 * The context carried nothing this grid can match on. Not an error: peers
 * broadcast context types a given grid has no opinion about all the time.
 * @public
 */
export interface GridNoAction {
  readonly kind: 'none';
  readonly contextType: string;
  readonly reason: string;
}

/** @public */
export type GridAction = GridMatchAction | GridNoAction;

/** @public */
export interface ContextToGridActionOptions {
  /**
   * Action kind to emit when the context matches. Defaults to `select-row`
   * for single-entity contexts and `filter` for the collection contexts
   * (portfolio, chart), where more than one row is implicated.
   */
  readonly kind?: Exclude<GridActionKind, 'none'>;
  /** String comparisons are case-insensitive by default — tickers arrive in
   *  both cases across vendors. */
  readonly caseSensitive?: boolean;
}

/** Paths whose values identify a row. Non-identifying fields (name, market,
 *  holding) are ignored: matching a row by its display name is a bug waiting
 *  to happen, and holdings change between apps. */
function isIdentifyingPath(path: string): boolean {
  return path.includes('id.');
}

/**
 * Strips array indices so `positions[0].instrument.id.ticker` and
 * `positions[3].instrument.id.ticker` collapse onto the same column. That is
 * what lets a portfolio of N positions produce one `in` filter rather than N
 * separate equality filters.
 */
function normalisePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

function expandIndex(path: string, context: Fdc3ContextBase): string[] {
  const at = path.indexOf('[]');
  if (at < 0) return [path];
  const head = path.slice(0, at);
  const value = getPath(context, head);
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    out.push(...expandIndex(`${head}[${i}]${path.slice(at + 2)}`, context));
  }
  return out;
}

const COLLECTION_CONTEXT = new Set(['fdc3.portfolio', 'fdc3.chart']);

/**
 * Translates an inbound peer context into a typed grid action, using the same
 * mapping the grid broadcasts with. Never throws; returns a `none` action when
 * the context type does not match the mapping or carries no usable identifier.
 * @public
 */
export function contextToGridAction<T extends Fdc3ContextType>(
  context: Fdc3ContextBase,
  mapping: ContextMapping<T>,
  option: ContextToGridActionOptions = {},
): GridAction {
  const contextType = context.type;

  if (contextType !== mapping.type) {
    return {
      kind: 'none',
      contextType,
      reason: `context type "${contextType}" does not match mapping type "${mapping.type}"`,
    };
  }

  // column id -> the distinct values the context supplies for it.
  const valueByColumn = new Map<string, unknown[]>();
  for (const [path, source] of Object.entries(mapping.spec.field)) {
    if (!('column' in source)) continue;
    if (!isIdentifyingPath(path)) continue;
    for (const concrete of expandIndex(normalisePath(path), context)) {
      const value = getPath(context, concrete);
      if (value === undefined || value === null || value === '') continue;
      let list = valueByColumn.get(source.column);
      if (!list) {
        list = [];
        valueByColumn.set(source.column, list);
      }
      if (!list.includes(value)) list.push(value);
    }
  }

  if (valueByColumn.size === 0) {
    return {
      kind: 'none',
      contextType,
      reason: 'context carried no identifier mapped to a grid column',
    };
  }

  const caseSensitive = option.caseSensitive ?? false;
  const clause: ComparisonFilter[] = [];
  for (const [column, value] of valueByColumn) {
    clause.push(
      value.length === 1
        ? { type: 'comparison', columnId: column, op: 'eq', value: value[0], caseSensitive }
        : { type: 'comparison', columnId: column, op: 'in', values: value, caseSensitive },
    );
  }

  const filter: FilterNode =
    // `filters` (plural) is the protocol's own spelling of LogicalFilter's
    // child list — an existing public surface, so it is matched verbatim.
    clause.length === 1 ? clause[0]! : { type: 'logical', op: 'or', filters: clause };

  const kind = option.kind ?? (COLLECTION_CONTEXT.has(contextType) ? 'filter' : 'select-row');

  return {
    kind,
    filter,
    contextType,
    column: Array.from(valueByColumn.keys()),
  };
}
