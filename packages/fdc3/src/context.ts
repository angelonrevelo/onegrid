// =============================================================================
// FDC3 2.0 context objects
//
// These are hand-modelled rather than imported from `@finos/fdc3` on purpose.
// The reference package pulls in a runtime shim that reaches for `window.fdc3`
// at import time, which is exactly the thing a grid running in a plain browser
// tab must not do. Everything here is types plus two frozen lookup tables, so
// the whole module tree-shakes to nothing when only the bridge is used.
//
// Fidelity to the standard matters because the value of FDC3 is that a peer
// app you have never seen can read your payload. So: field names match the
// spec exactly (including the plural `instruments` / `positions` that FDC3
// itself commits to — the repo's singular rule yields to an external contract
// here), the `id` identifier bag carries the standard financial identifier
// keys, and every context keeps an open index signature because the standard
// explicitly permits extra fields and forbids consumers from choking on them.
// =============================================================================

/** @public */
export const FDC3_CONTEXT_TYPE = [
  'fdc3.instrument',
  'fdc3.contact',
  'fdc3.country',
  'fdc3.organization',
  'fdc3.position',
  'fdc3.portfolio',
  'fdc3.chart',
  'fdc3.timerange',
  'fdc3.valuation',
] as const;

/**
 * The context types this package can map a grid row onto.
 * @public
 */
export type Fdc3ContextType = (typeof FDC3_CONTEXT_TYPE)[number];

/**
 * Standard financial identifier bag. FDC3 spells these keys in upper case
 * apart from `ticker`; peer apps match on them verbatim, so do not normalise.
 * Unknown keys are legal — vendors add their own (`FDS_ID`, `BBG`, ...).
 * @public
 */
export interface InstrumentIdentifier {
  /** Exchange ticker symbol, e.g. `AAPL`. */
  readonly ticker?: string;
  /** ISO 6166 International Securities Identification Number. */
  readonly ISIN?: string;
  /** Financial Instrument Global Identifier. */
  readonly FIGI?: string;
  /** CUSIP (North America). */
  readonly CUSIP?: string;
  /** Refinitiv PermID. */
  readonly PERMID?: string;
  /** ISO 17442 Legal Entity Identifier. */
  readonly LEI?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Base shape every FDC3 context shares. `type` is the discriminator peer apps
 * switch on; `name` is the human-readable label a launcher shows.
 * @public
 */
export interface Fdc3ContextBase {
  readonly type: string;
  readonly name?: string;
  readonly id?: Readonly<Record<string, string | undefined>>;
  readonly [key: string]: unknown;
}

/** @public */
export interface InstrumentContext extends Fdc3ContextBase {
  readonly type: 'fdc3.instrument';
  /** At least one identifier is required by the standard. */
  readonly id: InstrumentIdentifier;
  /** Optional market qualifier — MIC, country ISO code, or vendor name. */
  readonly market?: {
    readonly MIC?: string;
    readonly name?: string;
    readonly COUNTRY_ISOALPHA2?: string;
    readonly [key: string]: string | undefined;
  };
}

/** @public */
export interface ContactContext extends Fdc3ContextBase {
  readonly type: 'fdc3.contact';
  /** `email` or a vendor person id — at least one is required. */
  readonly id: {
    readonly email?: string;
    readonly FDS_ID?: string;
    readonly [key: string]: string | undefined;
  };
}

/** @public */
export interface CountryContext extends Fdc3ContextBase {
  readonly type: 'fdc3.country';
  /**
   * ISO 3166 alpha-2 / alpha-3. FDC3 accepts both the bare and the
   * `COUNTRY_`-prefixed spelling; peers publish either.
   */
  readonly id: {
    readonly ISOALPHA2?: string;
    readonly ISOALPHA3?: string;
    readonly COUNTRY_ISOALPHA2?: string;
    readonly COUNTRY_ISOALPHA3?: string;
    readonly [key: string]: string | undefined;
  };
}

/** @public */
export interface OrganizationContext extends Fdc3ContextBase {
  readonly type: 'fdc3.organization';
  readonly id: {
    readonly LEI?: string;
    readonly PERMID?: string;
    readonly FDS_ID?: string;
    readonly [key: string]: string | undefined;
  };
}

/** @public */
export interface PositionContext extends Fdc3ContextBase {
  readonly type: 'fdc3.position';
  readonly instrument: InstrumentContext;
  /** Size of the holding, in units of the instrument. Required. */
  readonly holding: number;
}

/**
 * A basket of positions. FDC3 spells the collection `positions`; that plural
 * is part of the wire contract, so it is preserved verbatim.
 * @public
 */
export interface PortfolioContext extends Fdc3ContextBase {
  readonly type: 'fdc3.portfolio';
  readonly positions: readonly PositionContext[];
}

/**
 * A time window. At least one of `startTime` / `endTime` must be present —
 * an open-ended range is legal, an empty one is not.
 * @public
 */
export interface TimeRangeContext extends Fdc3ContextBase {
  readonly type: 'fdc3.timerange';
  /** ISO 8601 datetime string. */
  readonly startTime?: string;
  /** ISO 8601 datetime string. */
  readonly endTime?: string;
}

/** @public */
export type ChartStyle =
  | 'line'
  | 'bar'
  | 'stacked-bar'
  | 'mountain'
  | 'candle'
  | 'pie'
  | 'scatter'
  | 'histogram'
  | 'heatmap'
  | 'custom';

/**
 * Charting request. `instruments` (plural, per the standard) is required;
 * `range` and `style` steer the peer charting app.
 * @public
 */
export interface ChartContext extends Fdc3ContextBase {
  readonly type: 'fdc3.chart';
  readonly instruments: readonly InstrumentContext[];
  readonly range?: TimeRangeContext;
  readonly style?: ChartStyle;
  readonly otherConfig?: readonly Fdc3ContextBase[];
}

/**
 * A valuation of some other context. `value` and `currency` are required;
 * `price`, `valuationTime` and `expiryTime` are optional refinements.
 * @public
 */
export interface ValuationContext extends Fdc3ContextBase {
  readonly type: 'fdc3.valuation';
  readonly value: number;
  /** ISO 4217 currency code. */
  readonly currency: string;
  readonly price?: number;
  /** ISO 8601 datetime string. */
  readonly valuationTime?: string;
  /** ISO 8601 datetime string. */
  readonly expiryTime?: string;
}

/**
 * Discriminated union of every context type this package produces. An
 * inbound listener may receive contexts outside this union — peers are free
 * to publish anything — so inbound handlers are typed on `Fdc3ContextBase`.
 * @public
 */
export type Fdc3Context =
  | InstrumentContext
  | ContactContext
  | CountryContext
  | OrganizationContext
  | PositionContext
  | PortfolioContext
  | ChartContext
  | TimeRangeContext
  | ValuationContext;

/** @public */
export const FDC3_INTENT = [
  'ViewChart',
  'ViewNews',
  'ViewAnalysis',
  'ViewInstrument',
  'ViewQuote',
  'ViewProfile',
  'StartCall',
  'StartChat',
  'ViewOrders',
  'ViewHoldings',
] as const;

/**
 * The standard intents a trading-desk grid raises. Peer apps register as
 * handlers for these; the string is the wire value, so it is case-sensitive.
 * @public
 */
export type Fdc3Intent = (typeof FDC3_INTENT)[number];

/**
 * Runtime guard for a value that arrived from a peer app. It only checks the
 * invariant the standard actually guarantees — a non-empty `type` string —
 * because anything stricter would reject valid vendor extensions.
 * @public
 */
export function isFdc3Context(value: unknown): value is Fdc3ContextBase {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0;
}

/**
 * Narrows an inbound context to one of the modelled types.
 * @public
 */
export function isContextOfType<T extends Fdc3ContextType>(
  value: unknown,
  type: T,
): value is Extract<Fdc3Context, { type: T }> {
  return isFdc3Context(value) && value.type === type;
}
