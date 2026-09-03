# @onegrid/fdc3

FDC3 2.0 desktop interop for oneGrid. Broadcast the selected row as a typed
context to peer apps on a trading desk; take intents and broadcasts back from
those peers and turn them into grid actions.

## Why

On a desk the grid is one window of six. Clicking a position should move the
chart, the news reader and the order blotter with it, and any of those apps
should be able to push a security back at the grid. FDC3 is the FINOS standard
that makes that work across vendors — but it is defined in terms of an ambient
`window.fdc3` injected by the container, which is both untestable and absent
in a plain browser tab.

This package fixes both problems:

- The `DesktopAgent` is a **narrow interface declared here and injected**.
  `detectAgent()` is the only code that touches `window`, and it is allowed to
  return `null`. A bridge built on a null agent is fully formed and completely
  inert — the same adopter code runs in OpenFin and in a browser tab, with no
  feature flag and no `try`/`catch`.
- `createInMemoryDesktopAgent()` is a real in-process routing agent, so your
  mapping and your inbound handlers are testable without booting a container.

Zero runtime dependencies beyond `@onegrid/protocol`. No dependency on
`@finos/fdc3` — its runtime shim reaches for `window.fdc3` at import time.

## Install

```sh
pnpm add @onegrid/fdc3
```

## Declare the mapping once

The adopter is the only party who knows what a row *means*. Declare it, and
the mapping is validated against the grid's `Schema` immediately — a mapping
missing an identifier the standard requires throws on your machine instead of
emitting contexts every peer silently drops.

```ts
import type { Schema } from '@onegrid/protocol';
import { defineContextMapping, fromColumn, fromValue } from '@onegrid/fdc3';

const schema: Schema = [
  { id: 'symbol', type: 'utf8' },
  { id: 'isin', type: 'utf8' },
  { id: 'long_name', type: 'utf8' },
  { id: 'quantity', type: 'float64' },
];

const mapping = defineContextMapping(schema, {
  type: 'fdc3.position',
  field: {
    'instrument.id.ticker': fromColumn('symbol'),
    'instrument.id.ISIN': fromColumn('isin'),
    'instrument.name': fromColumn('long_name'),
    holding: fromColumn('quantity'),
  },
});

mapping.rowToContext({ symbol: 'AAPL', isin: 'US0378331005', long_name: 'Apple Inc.', quantity: 1200 });
// { type: 'fdc3.position', holding: 1200,
//   instrument: { type: 'fdc3.instrument', id: { ticker: 'AAPL', ISIN: 'US0378331005' }, name: 'Apple Inc.' } }
```

Field targets are dotted paths, so nested and array-valued contexts
(`fdc3.chart`, `fdc3.portfolio`) come from the same grammar:
`'instruments[0].id.ticker'`, `'positions[0].holding'`.

`rowToContext` returns `null` — never a half-built context — when the row's
cells cannot satisfy the type's required fields.

## Bridge it to the desk

```ts
import { createFdc3Bridge, detectAgent } from '@onegrid/fdc3';

const bridge = createFdc3Bridge({
  agent: detectAgent(),   // null in a browser tab; the bridge then no-ops
  mapping,
  channel: 'green',       // user channel to join
  onError: (error, operation) => console.warn('fdc3', operation, error),
});

await bridge.start();

grid.onSelectionChange((row) => void bridge.onSelectionChange(row));

// Row action: "View chart"
await bridge.raiseIntentForRow('ViewChart', row);
```

Repeat broadcasts of an identical context are suppressed, so re-selecting the
same row after a scroll does not spam the channel.

## Take context back from peers

`contextToGridAction` is the mapping run backwards: because the mapping already
records which column feeds `id.ticker`, the inbound direction cannot drift out
of sync with the outbound one.

```ts
import { contextToGridAction } from '@onegrid/fdc3';

await bridge.addContextListener('fdc3.instrument', (context) => {
  const action = contextToGridAction(context, mapping);
  if (action.kind === 'none') return;
  // action.filter is a protocol FilterNode over action.column
  if (action.kind === 'select-row') grid.selectFirstMatching(action.filter);
  else grid.setFilterModel(action.filter);
});

await bridge.addIntentListener('ViewInstrument', (context) => {
  grid.scrollTo(contextToGridAction(context, mapping, { kind: 'scroll-to' }).filter);
});
```

Multiple identifiers OR together — a peer publishing both a ticker and an ISIN
is describing one security, and requiring both would break the very common case
where one of the two columns is null. A portfolio of N positions collapses into
a single `in` filter.

## Channels

```ts
await bridge.getUserChannel();          // the container's colour channels
await bridge.joinUserChannel('blue');
await bridge.getCurrentChannel();
await bridge.leaveCurrentChannel();
await bridge.getOrCreateChannel('desk.blotter');  // private app channel
```

Passing `appChannel` to `createFdc3Bridge` routes both broadcasts and inbound
listeners onto that app channel instead of the trader's colour channel — the
right choice for a private grid-to-blotter link.

## Context types

`fdc3.instrument`, `fdc3.contact`, `fdc3.country`, `fdc3.organization`,
`fdc3.position`, `fdc3.portfolio`, `fdc3.chart`, `fdc3.timerange`,
`fdc3.valuation` — modelled against the FDC3 2.0 schemas, including the
`ticker` / `ISIN` / `FIGI` / `CUSIP` / `PERMID` / `LEI` identifier bag. Field
names (including the standard's plural `instruments` / `positions`) are
verbatim, because a peer app you have never seen reads them.

Intents: `ViewChart`, `ViewNews`, `ViewAnalysis`, `ViewInstrument`,
`ViewQuote`, `ViewProfile`, `StartCall`, `StartChat`, `ViewOrders`,
`ViewHoldings`.

## Testing

```ts
import { createFdc3Bridge, createInMemoryDesktopAgent } from '@onegrid/fdc3';

const agent = createInMemoryDesktopAgent();
const bridge = createFdc3Bridge({ agent, mapping, channel: 'red' });
await bridge.start();
await bridge.onSelectionChange(row);

expect(agent.broadcastLog[0].channelId).toBe('red');

// Simulate a peer pushing context or an intent at the grid
await agent.dispatchContext({ type: 'fdc3.instrument', id: { ticker: 'MSFT' } });
await agent.dispatchIntent('ViewInstrument', { type: 'fdc3.instrument', id: { ticker: 'MSFT' } });
```

## License

MIT
