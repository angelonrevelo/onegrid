// =============================================================================
// @onegrid/fdc3
//
// FDC3 2.0 desktop interop for oneGrid. On a trading desk the grid is rarely
// the only window: selecting a position should light up the chart app, the
// news app and the order blotter, and those apps should be able to push a
// security back at the grid. FDC3 is the standard that makes that work across
// vendors. This package binds a oneGrid row to it.
//
// Four pieces, in the order an adopter meets them:
//
//   1. `src/context.ts` — the nine context types a grid plausibly emits,
//      modelled by hand against the FDC3 2.0 schemas. Hand-modelled rather
//      than imported from `@finos/fdc3` because that package's runtime shim
//      touches `window.fdc3` on import, which is precisely the coupling this
//      package exists to avoid.
//
//   2. `src/mapping.ts` — `defineContextMapping(schema, spec)`. The adopter
//      declares, once, which columns feed which context fields. Validation
//      runs against the grid's Schema at definition time, so a mapping that
//      omits an identifier the standard requires fails on the developer's
//      machine instead of producing contexts every peer silently drops.
//
//   3. `src/bridge.ts` — `createFdc3Bridge`. Broadcasts the selected row,
//      raises intents, registers inbound listeners, joins channels.
//
//   4. `src/action.ts` — `contextToGridAction`. The mapping run backwards:
//      an inbound peer context becomes a typed filter/select/scroll action
//      over the same columns, so the two directions cannot drift apart.
//
// The one architectural commitment worth stating up front: the FDC3
// `DesktopAgent` is an interface declared here and *injected*, never reached
// for. `detectAgent()` is the only code in the package that touches `window`,
// and it is allowed to return null. A bridge built on a null agent is fully
// formed and completely inert — a grid in a plain browser tab runs the exact
// same adopter code as one inside OpenFin, with no feature flag and no
// try/catch. That also means the whole surface is testable in-process against
// `createInMemoryDesktopAgent()`, which is a real routing agent, not a stub.
// =============================================================================

export {
  FDC3_CONTEXT_TYPE,
  FDC3_INTENT,
  isContextOfType,
  isFdc3Context,
} from './context.js';
export type {
  ChartContext,
  ChartStyle,
  ContactContext,
  CountryContext,
  Fdc3Context,
  Fdc3ContextBase,
  Fdc3ContextType,
  Fdc3Intent,
  InstrumentContext,
  InstrumentIdentifier,
  OrganizationContext,
  PortfolioContext,
  PositionContext,
  TimeRangeContext,
  ValuationContext,
} from './context.js';

export { createInMemoryDesktopAgent, detectAgent } from './agent.js';
export type {
  AppIdentifier,
  ChannelKind,
  ContextHandler,
  DesktopAgent,
  Fdc3Channel,
  Fdc3ContextMetadata,
  Fdc3Listener,
  InMemoryDesktopAgent,
  InMemoryDesktopAgentOptions,
  IntentHandler,
  IntentResolution,
  RecordedBroadcast,
  RecordedIntent,
} from './agent.js';

export {
  ContextMappingError,
  defineContextMapping,
  fromColumn,
  fromValue,
  validateContextMapping,
} from './mapping.js';
export type {
  ContextFieldSource,
  ContextMapping,
  ContextMappingSpec,
  GridRow,
  MappingFinding,
  MappingFindingCode,
} from './mapping.js';

export { createFdc3Bridge } from './bridge.js';
export type { Fdc3Bridge, Fdc3BridgeOptions, IntentName, MappedContext } from './bridge.js';

export { contextToGridAction } from './action.js';
export type {
  ContextToGridActionOptions,
  GridAction,
  GridActionKind,
  GridMatchAction,
  GridNoAction,
} from './action.js';
