import type { Schema } from '@onegrid/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fdc3ContextBase, InstrumentContext, PortfolioContext, PositionContext } from '../index.js';
import {
  ContextMappingError,
  contextToGridAction,
  createFdc3Bridge,
  createInMemoryDesktopAgent,
  defineContextMapping,
  detectAgent,
  FDC3_CONTEXT_TYPE,
  FDC3_INTENT,
  fromColumn,
  fromValue,
  isContextOfType,
  isFdc3Context,
  validateContextMapping,
} from '../index.js';

// A positions blotter: the canonical fintech-desk grid.
const SCHEMA: Schema = [
  { id: 'symbol', type: 'utf8' },
  { id: 'isin', type: 'utf8' },
  { id: 'long_name', type: 'utf8' },
  { id: 'mic', type: 'utf8' },
  { id: 'quantity', type: 'float64' },
  { id: 'market_value', type: 'float64' },
  { id: 'trader_email', type: 'utf8' },
  { id: 'quantity_text', type: 'utf8' },
];

const ROW = {
  symbol: 'AAPL',
  isin: 'US0378331005',
  long_name: 'Apple Inc.',
  mic: 'XNAS',
  quantity: 1200,
  market_value: 264000,
  trader_email: 'jo@desk.example',
  quantity_text: '1200',
};

function instrumentMapping() {
  return defineContextMapping(SCHEMA, {
    type: 'fdc3.instrument',
    field: {
      'id.ticker': fromColumn('symbol'),
      'id.ISIN': fromColumn('isin'),
      name: fromColumn('long_name'),
      'market.MIC': fromColumn('mic'),
    },
  });
}

describe('context types', () => {
  it('exposes the nine mappable context types and the ten desk intents', () => {
    expect(FDC3_CONTEXT_TYPE).toHaveLength(9);
    expect(FDC3_CONTEXT_TYPE).toContain('fdc3.valuation');
    expect(FDC3_INTENT).toHaveLength(10);
    expect(FDC3_INTENT).toContain('ViewHoldings');
  });

  it('guards inbound values on the only invariant FDC3 guarantees', () => {
    expect(isFdc3Context({ type: 'fdc3.instrument' })).toBe(true);
    expect(isFdc3Context({ type: 'vendor.custom.thing' })).toBe(true);
    expect(isFdc3Context({ type: '' })).toBe(false);
    expect(isFdc3Context(null)).toBe(false);
    expect(isFdc3Context('fdc3.instrument')).toBe(false);
  });

  it('narrows a context by type', () => {
    const value: unknown = { type: 'fdc3.instrument', id: { ticker: 'MSFT' } };
    expect(isContextOfType(value, 'fdc3.instrument')).toBe(true);
    expect(isContextOfType(value, 'fdc3.contact')).toBe(false);
  });
});

describe('defineContextMapping validation', () => {
  it('rejects a mapping that references a column outside the schema', () => {
    const finding = validateContextMapping(SCHEMA, {
      type: 'fdc3.instrument',
      field: { 'id.ticker': fromColumn('nope') },
    });
    expect(finding).toHaveLength(1);
    expect(finding[0]!.code).toBe('unknown-column');
    expect(finding[0]!.column).toBe('nope');
  });

  it('rejects an instrument mapping with no identifier at all', () => {
    const finding = validateContextMapping(SCHEMA, {
      type: 'fdc3.instrument',
      field: { name: fromColumn('long_name') },
    });
    expect(finding.map((f) => f.code)).toContain('missing-required-field');
  });

  it('accepts any single identifier from the bag', () => {
    for (const path of ['id.ticker', 'id.ISIN', 'id.FIGI', 'id.CUSIP', 'id.PERMID', 'id.LEI']) {
      const finding = validateContextMapping(SCHEMA, {
        type: 'fdc3.instrument',
        field: { [path]: fromColumn('symbol') },
      });
      expect(finding, path).toHaveLength(0);
    }
  });

  it('requires both value and currency on a valuation, and accepts a constant currency', () => {
    const missing = validateContextMapping(SCHEMA, {
      type: 'fdc3.valuation',
      field: { value: fromColumn('market_value') },
    });
    expect(missing.map((f) => f.code)).toEqual(['missing-required-field']);

    const ok = validateContextMapping(SCHEMA, {
      type: 'fdc3.valuation',
      field: { value: fromColumn('market_value'), currency: fromValue('USD') },
    });
    expect(ok).toHaveLength(0);
  });

  it('rejects a numeric context field fed by a text column unless a transform is supplied', () => {
    const bad = validateContextMapping(SCHEMA, {
      type: 'fdc3.valuation',
      field: { value: fromColumn('quantity_text'), currency: fromValue('USD') },
    });
    expect(bad.map((f) => f.code)).toEqual(['non-numeric-column']);

    const good = validateContextMapping(SCHEMA, {
      type: 'fdc3.valuation',
      field: {
        value: fromColumn('quantity_text', (v) => Number(v)),
        currency: fromValue('USD'),
      },
    });
    expect(good).toHaveLength(0);
  });

  it('flags an unknown context type and a malformed path', () => {
    const unknown = validateContextMapping(SCHEMA, {
      type: 'fdc3.nope' as 'fdc3.instrument',
      field: { 'id.ticker': fromColumn('symbol') },
    });
    expect(unknown.map((f) => f.code)).toEqual(['unknown-context-type']);

    const malformed = validateContextMapping(SCHEMA, {
      type: 'fdc3.instrument',
      field: { 'id.ticker': fromColumn('symbol'), '9bad..path': fromColumn('symbol') },
    });
    expect(malformed.map((f) => f.code)).toContain('malformed-path');
  });

  it('throws ContextMappingError carrying the finding list', () => {
    expect(() =>
      defineContextMapping(SCHEMA, {
        type: 'fdc3.contact',
        field: { name: fromColumn('long_name') },
      }),
    ).toThrow(ContextMappingError);

    try {
      defineContextMapping(SCHEMA, {
        type: 'fdc3.contact',
        field: { name: fromColumn('long_name') },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextMappingError);
      expect((error as ContextMappingError).finding[0]!.code).toBe('missing-required-field');
    }
  });
});

describe('rowToContext', () => {
  it('builds a nested instrument with the identifier bag and market qualifier', () => {
    const context = instrumentMapping().rowToContext(ROW);
    expect(context).toEqual({
      type: 'fdc3.instrument',
      id: { ticker: 'AAPL', ISIN: 'US0378331005' },
      name: 'Apple Inc.',
      market: { MIC: 'XNAS' },
    });
  });

  it('omits absent identifiers rather than writing nulls', () => {
    const context = instrumentMapping().rowToContext({ ...ROW, isin: null });
    expect(context?.id).toEqual({ ticker: 'AAPL' });
    expect('ISIN' in (context as InstrumentContext).id).toBe(false);
  });

  it('returns null when the row satisfies no required field', () => {
    expect(instrumentMapping().rowToContext({ ...ROW, symbol: null, isin: undefined })).toBeNull();
  });

  it('stamps the nested type discriminator on a position', () => {
    const mapping = defineContextMapping(SCHEMA, {
      type: 'fdc3.position',
      field: {
        'instrument.id.ticker': fromColumn('symbol'),
        'instrument.name': fromColumn('long_name'),
        holding: fromColumn('quantity'),
      },
    });
    const context = mapping.rowToContext(ROW) as PositionContext;
    expect(context.type).toBe('fdc3.position');
    expect(context.holding).toBe(1200);
    expect(context.instrument.type).toBe('fdc3.instrument');
    expect(context.instrument.id.ticker).toBe('AAPL');
  });

  it('coerces a numeric leaf out of a text column and rejects unparseable text', () => {
    const mapping = defineContextMapping(SCHEMA, {
      type: 'fdc3.position',
      field: {
        'instrument.id.ticker': fromColumn('symbol'),
        holding: fromColumn('quantity_text', (v) => v),
      },
    });
    expect(mapping.rowToContext(ROW)?.holding).toBe(1200);
    expect(mapping.rowToContext({ ...ROW, quantity_text: 'n/a' })).toBeNull();
  });

  it('builds array-valued contexts from indexed paths', () => {
    const portfolio = defineContextMapping(SCHEMA, {
      type: 'fdc3.portfolio',
      field: {
        'positions[0].instrument.id.ticker': fromColumn('symbol'),
        'positions[0].holding': fromColumn('quantity'),
      },
    });
    const context = portfolio.rowToContext(ROW) as PortfolioContext;
    expect(context.positions).toHaveLength(1);
    expect(context.positions[0]!.type).toBe('fdc3.position');
    expect(context.positions[0]!.instrument.id.ticker).toBe('AAPL');

    const chart = defineContextMapping(SCHEMA, {
      type: 'fdc3.chart',
      field: {
        'instruments[0].id.ticker': fromColumn('symbol'),
        style: fromValue('candle'),
      },
    });
    const chartContext = chart.rowToContext(ROW);
    expect(chartContext?.instruments[0]!.type).toBe('fdc3.instrument');
    expect(chartContext?.style).toBe('candle');
  });

  it('records the columns a mapping reads', () => {
    expect(instrumentMapping().column).toEqual(['symbol', 'isin', 'long_name', 'mic']);
  });
});

describe('detectAgent', () => {
  it('returns null when there is no window.fdc3', () => {
    expect(detectAgent({})).toBeNull();
    expect(detectAgent(null)).toBeNull();
  });

  it('rejects a half-initialised placeholder', () => {
    expect(detectAgent({ fdc3: {} })).toBeNull();
    expect(detectAgent({ fdc3: { broadcast: () => undefined } })).toBeNull();
  });

  it('returns a structurally complete agent, including off the ambient global', () => {
    const agent = createInMemoryDesktopAgent();
    expect(detectAgent({ fdc3: agent })).toBe(agent);

    const win = globalThis as unknown as { fdc3?: unknown };
    win.fdc3 = agent;
    try {
      expect(detectAgent()).toBe(agent);
    } finally {
      delete win.fdc3;
    }
  });
});

describe('bridge — connected', () => {
  let agent: ReturnType<typeof createInMemoryDesktopAgent>;

  beforeEach(() => {
    agent = createInMemoryDesktopAgent();
  });

  it('broadcasts the selected row on the joined user channel', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), channel: 'green' });
    await bridge.start();
    expect(bridge.isConnected).toBe(true);

    const sent = await bridge.onSelectionChange(ROW);
    expect(sent?.type).toBe('fdc3.instrument');
    expect(agent.broadcastLog).toHaveLength(1);
    expect(agent.broadcastLog[0]!.channelId).toBe('green');
    expect((agent.broadcastLog[0]!.context as InstrumentContext).id.ticker).toBe('AAPL');
  });

  it('de-dupes an identical repeat selection and re-broadcasts after a clear', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), channel: 'red' });
    await bridge.start();

    await bridge.onSelectionChange(ROW);
    expect(await bridge.onSelectionChange(ROW)).toBeNull();
    expect(agent.broadcastLog).toHaveLength(1);

    await bridge.onSelectionChange(null);
    await bridge.onSelectionChange(ROW);
    expect(agent.broadcastLog).toHaveLength(2);
  });

  it('broadcasts nothing for a row that cannot satisfy the context type', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), channel: 'red' });
    await bridge.start();
    expect(await bridge.broadcastRow({ ...ROW, symbol: null, isin: null })).toBeNull();
    expect(agent.broadcastLog).toHaveLength(0);
  });

  it('routes onto an app channel when one is configured', async () => {
    const bridge = createFdc3Bridge({
      agent,
      mapping: instrumentMapping(),
      channel: 'blue',
      appChannel: 'desk.blotter',
    });
    await bridge.start();
    await bridge.broadcastRow(ROW);

    expect(agent.broadcastLog[0]!.channelId).toBe('desk.blotter');
    const channel = await agent.getOrCreateChannel('desk.blotter');
    expect(channel.type).toBe('app');
    expect(await channel.getCurrentContext('fdc3.instrument')).not.toBeNull();
  });

  it('raises an intent for a row and records the resolution', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), channel: 'red' });
    await bridge.start();

    await agent.addIntentListener('ViewChart', (context) => ({
      type: 'fdc3.chart',
      instruments: [context],
    }) as Fdc3ContextBase);

    const resolution = await bridge.raiseIntentForRow('ViewChart', ROW);
    expect(resolution?.intent).toBe('ViewChart');
    expect(agent.intentLog).toHaveLength(1);
    expect(agent.intentLog[0]!.intent).toBe('ViewChart');
    const result = await resolution?.getResult?.();
    expect((result as { type: string }).type).toBe('fdc3.chart');
  });

  it('delivers a peer-raised intent to a listener registered through the bridge', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), channel: 'red' });
    await bridge.start();

    const seen: Fdc3ContextBase[] = [];
    await bridge.addIntentListener('ViewInstrument', (context) => {
      seen.push(context);
    });

    await agent.dispatchIntent('ViewInstrument', { type: 'fdc3.instrument', id: { ticker: 'MSFT' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id?.ticker).toBe('MSFT');
  });

  it('delivers a peer broadcast to a context listener and stops after teardown', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), channel: 'red' });
    await bridge.start();

    const seen: Fdc3ContextBase[] = [];
    await bridge.addContextListener('fdc3.instrument', (context) => {
      seen.push(context);
    });

    await agent.dispatchContext({ type: 'fdc3.instrument', id: { ticker: 'IBM' } });
    await agent.dispatchContext({ type: 'fdc3.contact', id: { email: 'x@y.z' } });
    expect(seen).toHaveLength(1);

    await bridge.stop();
    await agent.dispatchContext({ type: 'fdc3.instrument', id: { ticker: 'IBM' } });
    expect(seen).toHaveLength(1);
  });

  it('joins, reports and leaves user channels', async () => {
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping() });
    await bridge.start();

    expect(await bridge.getCurrentChannel()).toBeNull();
    expect((await bridge.getUserChannel()).map((c) => c.id)).toContain('yellow');

    expect(await bridge.joinUserChannel('yellow')).toBe(true);
    expect((await bridge.getCurrentChannel())?.id).toBe('yellow');

    await bridge.leaveCurrentChannel();
    expect(await bridge.getCurrentChannel()).toBeNull();
  });

  it('reports an unknown channel through onError instead of throwing', async () => {
    const onError = vi.fn();
    const bridge = createFdc3Bridge({ agent, mapping: instrumentMapping(), onError });
    await bridge.start();

    expect(await bridge.joinUserChannel('chartreuse')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toBe('joinUserChannel');
  });

  it('survives an agent whose broadcast rejects', async () => {
    const onError = vi.fn();
    const hostile = {
      ...createInMemoryDesktopAgent(),
      broadcast: () => Promise.reject(new Error('socket closed')),
    };
    const bridge = createFdc3Bridge({ agent: hostile, mapping: instrumentMapping(), onError });
    await bridge.start();

    expect(await bridge.broadcastRow(ROW)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toBe('broadcast');
  });
});

describe('bridge — no agent (degraded)', () => {
  it('is inert but fully callable', async () => {
    const bridge = createFdc3Bridge({ agent: null, mapping: instrumentMapping(), channel: 'red' });

    expect(bridge.isConnected).toBe(false);
    await expect(bridge.start()).resolves.toBeUndefined();
    await expect(bridge.broadcastRow(ROW)).resolves.toBeNull();
    await expect(bridge.onSelectionChange(ROW)).resolves.toBeNull();
    await expect(bridge.broadcast({ type: 'fdc3.instrument' })).resolves.toBe(false);
    await expect(bridge.raiseIntent('ViewChart', { type: 'fdc3.instrument' })).resolves.toBeNull();
    await expect(bridge.raiseIntentForRow('ViewChart', ROW)).resolves.toBeNull();
    await expect(bridge.joinUserChannel('red')).resolves.toBe(false);
    await expect(bridge.getCurrentChannel()).resolves.toBeNull();
    await expect(bridge.getUserChannel()).resolves.toEqual([]);
    await expect(bridge.getOrCreateChannel('x')).resolves.toBeNull();
    await expect(bridge.leaveCurrentChannel()).resolves.toBeUndefined();
    await expect(bridge.stop()).resolves.toBeUndefined();
  });

  it('hands back unsubscribable no-op listeners', async () => {
    const bridge = createFdc3Bridge({ agent: null, mapping: instrumentMapping() });
    const intentListener = await bridge.addIntentListener('ViewChart', () => undefined);
    const contextListener = await bridge.addContextListener(null, () => undefined);
    expect(() => {
      intentListener.unsubscribe();
      contextListener.unsubscribe();
    }).not.toThrow();
  });
});

describe('contextToGridAction', () => {
  it('turns a single-identifier instrument into a select-row equality filter', () => {
    const action = contextToGridAction(
      { type: 'fdc3.instrument', id: { ticker: 'AAPL' } },
      instrumentMapping(),
    );
    expect(action.kind).toBe('select-row');
    expect(action).toMatchObject({
      filter: { type: 'comparison', columnId: 'symbol', op: 'eq', value: 'AAPL' },
      column: ['symbol'],
    });
  });

  it('ORs multiple identifiers, because either match means the same security', () => {
    const action = contextToGridAction(
      { type: 'fdc3.instrument', id: { ticker: 'AAPL', ISIN: 'US0378331005' }, name: 'Apple Inc.' },
      instrumentMapping(),
    );
    expect(action).toMatchObject({
      kind: 'select-row',
      filter: {
        type: 'logical',
        op: 'or',
        filters: [
          { columnId: 'symbol', op: 'eq', value: 'AAPL' },
          { columnId: 'isin', op: 'eq', value: 'US0378331005' },
        ],
      },
    });
  });

  it('ignores non-identifying fields such as name and market', () => {
    const action = contextToGridAction(
      { type: 'fdc3.instrument', name: 'Apple Inc.', market: { MIC: 'XNAS' } },
      instrumentMapping(),
    );
    expect(action.kind).toBe('none');
    expect((action as { reason: string }).reason).toContain('no identifier');
  });

  it('collapses a multi-position portfolio into one `in` filter', () => {
    const mapping = defineContextMapping(SCHEMA, {
      type: 'fdc3.portfolio',
      field: {
        'positions[0].instrument.id.ticker': fromColumn('symbol'),
        'positions[0].holding': fromColumn('quantity'),
      },
    });
    const action = contextToGridAction(
      {
        type: 'fdc3.portfolio',
        positions: [
          { type: 'fdc3.position', holding: 1, instrument: { type: 'fdc3.instrument', id: { ticker: 'AAPL' } } },
          { type: 'fdc3.position', holding: 2, instrument: { type: 'fdc3.instrument', id: { ticker: 'MSFT' } } },
        ],
      } as unknown as Fdc3ContextBase,
      mapping,
    );
    expect(action).toMatchObject({
      kind: 'filter',
      filter: { columnId: 'symbol', op: 'in', values: ['AAPL', 'MSFT'] },
    });
  });

  it('honours an explicit action kind and case sensitivity', () => {
    const action = contextToGridAction(
      { type: 'fdc3.instrument', id: { ticker: 'AAPL' } },
      instrumentMapping(),
      { kind: 'scroll-to', caseSensitive: true },
    );
    expect(action.kind).toBe('scroll-to');
    expect(action).toMatchObject({ filter: { caseSensitive: true } });
  });

  it('declines a context type the mapping does not describe', () => {
    const action = contextToGridAction(
      { type: 'fdc3.contact', id: { email: 'jo@desk.example' } },
      instrumentMapping(),
    );
    expect(action.kind).toBe('none');
    expect((action as { reason: string }).reason).toContain('does not match mapping type');
  });
});

describe('round trip', () => {
  it('a broadcast row comes back as an action selecting the same row', async () => {
    const agent = createInMemoryDesktopAgent();
    const mapping = instrumentMapping();
    const bridge = createFdc3Bridge({ agent, mapping, channel: 'blue' });
    await bridge.start();

    await bridge.broadcastRow(ROW);
    const wire = agent.broadcastLog[0]!.context;

    // A peer echoes it back onto the channel; the grid translates it.
    const received: Fdc3ContextBase[] = [];
    await bridge.addContextListener('fdc3.instrument', (context) => {
      received.push(context);
    });
    await agent.dispatchContext(wire);

    const action = contextToGridAction(received[0]!, mapping);
    expect(action.kind).toBe('select-row');
    expect(action).toMatchObject({ column: ['symbol', 'isin'] });
  });
});
