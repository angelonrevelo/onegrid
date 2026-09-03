// =============================================================================
// The bridge
//
// Everything above this file is pure. The bridge is the only stateful piece:
// it owns the joined channel, the set of listener registrations, and the
// last-broadcast context used for de-duplication.
//
// Design decisions:
//
//   - `agent: DesktopAgent | null` is accepted, not required. A grid rendered
//     in a plain browser tab gets `detectAgent() === null` and every method on
//     the bridge becomes a no-op returning null. No try/catch at the call
//     site, no feature flag, no separate code path in the adopter. This is the
//     single most important property of the package: interop must be additive.
//
//   - Selection broadcasts are de-duplicated by serialised context, not by row
//     identity. Re-selecting the same row after a scroll should not spam the
//     desk channel, and two different rows describing the same instrument
//     genuinely are the same context.
//
//   - Every agent call is wrapped. A container that throws on `broadcast`
//     (disconnected socket, revoked permission) must not take the grid down
//     with it; failures go to `onError` and the bridge stays usable.
//
//   - Listener registrations are tracked so `stop()` tears the whole thing
//     down on unmount. Leaked FDC3 listeners survive component remounts and
//     produce duplicate handling, which is very hard to diagnose.
// =============================================================================

import type {
  ContextHandler,
  DesktopAgent,
  Fdc3Channel,
  Fdc3Listener,
  IntentHandler,
  IntentResolution,
} from './agent.js';
import type { Fdc3Context, Fdc3ContextBase, Fdc3ContextType, Fdc3Intent } from './context.js';
import type { ContextMapping, GridRow } from './mapping.js';

/**
 * A standard FDC3 intent, or any vendor-defined one. Spelling it as an
 * intersection on the string arm keeps editor completion for the ten standard
 * names, which a bare `Fdc3Intent | string` erases.
 * @public
 */
export type IntentName = Fdc3Intent | (string & Record<never, never>);

/**
 * The context type a mapping for `T` produces. Named so the bridge's return
 * types stay readable — `Extract<Fdc3Context, { type: T }>` inline four times
 * obscures more than it documents.
 * @public
 */
export type MappedContext<T extends Fdc3ContextType> = Extract<Fdc3Context, { type: T }>;

/** @public */
export interface Fdc3BridgeOptions<T extends Fdc3ContextType = Fdc3ContextType> {
  /**
   * The desktop agent, or null when none is available. Pass
   * `detectAgent()` directly — null is a supported value, not a failure.
   */
  readonly agent: DesktopAgent | null;
  /** Compiled mapping from `defineContextMapping`. */
  readonly mapping: ContextMapping<T>;
  /** User channel to join on `start()`. Omit to stay on whatever channel the
   *  container has the app on. */
  readonly channel?: string;
  /** Broadcast onto this app channel instead of the user channel. App
   *  channels are the right choice for a private grid-to-blotter link that
   *  should not follow the trader's colour selection. */
  readonly appChannel?: string;
  /** Suppress repeat broadcasts of an identical context. Default true. */
  readonly dedupe?: boolean;
  /** Called for every failure the bridge swallows. */
  readonly onError?: (error: unknown, operation: string) => void;
}

/**
 * The grid-side FDC3 surface. Every method is safe to call when no agent is
 * present; the return value tells you whether anything happened.
 * @public
 */
export interface Fdc3Bridge<T extends Fdc3ContextType = Fdc3ContextType> {
  /** False when there is no desktop agent — the degraded, no-op mode. */
  readonly isConnected: boolean;
  /** Joins the configured channel and resolves the app channel, if any.
   *  Idempotent. */
  start: () => Promise<void>;
  /**
   * Converts `row` and broadcasts it. Returns the context that went out, or
   * null when there is no agent, the row cannot satisfy the context type, or
   * the context was suppressed as a duplicate.
   */
  broadcastRow: (row: GridRow) => Promise<MappedContext<T> | null>;
  /** Wire this to the grid's selection callback. A null row clears the
   *  de-dupe memory so re-selecting the same row broadcasts again. */
  onSelectionChange: (row: GridRow | null) => Promise<MappedContext<T> | null>;
  /** Broadcast an already-built context. */
  broadcast: (context: Fdc3ContextBase) => Promise<boolean>;
  /** Raise an intent with an explicit context. */
  raiseIntent: (
    intent: IntentName,
    context: Fdc3ContextBase,
  ) => Promise<IntentResolution | null>;
  /** Raise an intent with the context derived from a row — the common case
   *  behind a "View chart" row action. */
  raiseIntentForRow: (
    intent: IntentName,
    row: GridRow,
  ) => Promise<IntentResolution | null>;
  /** Register a handler for a peer-raised intent. */
  addIntentListener: (intent: IntentName, handler: IntentHandler) => Promise<Fdc3Listener>;
  /** Register a handler for peer broadcasts. Pass null to receive every type. */
  addContextListener: (contextType: string | null, handler: ContextHandler) => Promise<Fdc3Listener>;
  joinUserChannel: (channelId: string) => Promise<boolean>;
  leaveCurrentChannel: () => Promise<void>;
  getCurrentChannel: () => Promise<Fdc3Channel | null>;
  getUserChannel: () => Promise<readonly Fdc3Channel[]>;
  /** Create or attach to an app channel by name. */
  getOrCreateChannel: (channelId: string) => Promise<Fdc3Channel | null>;
  /** Unsubscribe every listener this bridge registered. */
  stop: () => Promise<void>;
}

/** Listener handed back in degraded mode. Unsubscribing is a no-op. */
const NOOP_LISTENER: Fdc3Listener = { unsubscribe: () => undefined };

/**
 * Creates the bridge. When `agent` is null the returned bridge is fully formed
 * but inert — see the module banner for why that matters.
 * @public
 */
export function createFdc3Bridge<T extends Fdc3ContextType = Fdc3ContextType>(
  option: Fdc3BridgeOptions<T>,
): Fdc3Bridge<T> {
  const { agent, mapping } = option;
  const dedupe = option.dedupe ?? true;
  const report = (error: unknown, operation: string): void => {
    option.onError?.(error, operation);
  };

  const openListener: Fdc3Listener[] = [];
  let appChannel: Fdc3Channel | null = null;
  let lastBroadcastKey: string | null = null;
  let started = false;

  /** Runs an agent call, funnelling any rejection into onError. */
  async function guard<R>(operation: string, run: () => Promise<R>, fallback: R): Promise<R> {
    try {
      return await run();
    } catch (error) {
      report(error, operation);
      return fallback;
    }
  }

  const track = (listener: Fdc3Listener): Fdc3Listener => {
    openListener.push(listener);
    return {
      unsubscribe: () => {
        const at = openListener.indexOf(listener);
        if (at >= 0) openListener.splice(at, 1);
        listener.unsubscribe();
      },
    };
  };

  async function emit(context: Fdc3ContextBase): Promise<boolean> {
    if (!agent) return false;
    // An app channel, when configured, wins over the user channel: it is an
    // explicit private link the adopter asked for.
    if (appChannel) {
      return guard('broadcast', async () => {
        await appChannel!.broadcast(context);
        return true;
      }, false);
    }
    return guard('broadcast', async () => {
      await agent.broadcast(context);
      return true;
    }, false);
  }

  const bridge: Fdc3Bridge<T> = {
    get isConnected() {
      return agent !== null;
    },

    start: async () => {
      if (!agent || started) return;
      started = true;
      if (option.channel !== undefined) {
        await guard('joinUserChannel', () => agent.joinUserChannel(option.channel!), undefined);
      }
      if (option.appChannel !== undefined) {
        appChannel = await guard(
          'getOrCreateChannel',
          () => agent.getOrCreateChannel(option.appChannel!),
          null,
        );
      }
    },

    broadcastRow: async (row) => {
      if (!agent) return null;
      const context = mapping.rowToContext(row);
      if (context === null) return null;
      const key = JSON.stringify(context);
      if (dedupe && key === lastBroadcastKey) return null;
      const sent = await emit(context);
      if (!sent) return null;
      lastBroadcastKey = key;
      return context;
    },

    onSelectionChange: async (row) => {
      if (row === null) {
        lastBroadcastKey = null;
        return null;
      }
      return bridge.broadcastRow(row);
    },

    broadcast: async (context) => {
      const sent = await emit(context);
      if (sent) lastBroadcastKey = JSON.stringify(context);
      return sent;
    },

    raiseIntent: async (intent, context) => {
      if (!agent) return null;
      return guard('raiseIntent', () => agent.raiseIntent(intent, context), null);
    },

    raiseIntentForRow: async (intent, row) => {
      if (!agent) return null;
      const context = mapping.rowToContext(row);
      if (context === null) return null;
      return guard('raiseIntent', () => agent.raiseIntent(intent, context), null);
    },

    addIntentListener: async (intent, handler) => {
      if (!agent) return NOOP_LISTENER;
      const listener = await guard(
        'addIntentListener',
        () => agent.addIntentListener(intent, handler),
        NOOP_LISTENER,
      );
      return track(listener);
    },

    addContextListener: async (contextType, handler) => {
      if (!agent) return NOOP_LISTENER;
      // Prefer the app channel when one is configured: a listener registered
      // agent-level would also pick up unrelated user-channel traffic.
      const listener = await guard(
        'addContextListener',
        () =>
          appChannel
            ? appChannel.addContextListener(contextType, handler)
            : agent.addContextListener(contextType, handler),
        NOOP_LISTENER,
      );
      return track(listener);
    },

    joinUserChannel: async (channelId) => {
      if (!agent) return false;
      return guard('joinUserChannel', async () => {
        await agent.joinUserChannel(channelId);
        // Channel change invalidates de-dupe: the new channel has not seen
        // our current context.
        lastBroadcastKey = null;
        return true;
      }, false);
    },

    leaveCurrentChannel: async () => {
      if (!agent) return;
      await guard('leaveCurrentChannel', () => agent.leaveCurrentChannel(), undefined);
      lastBroadcastKey = null;
    },

    getCurrentChannel: async () => {
      if (!agent) return null;
      return guard('getCurrentChannel', () => agent.getCurrentChannel(), null);
    },

    getUserChannel: async () => {
      if (!agent) return [];
      return guard<readonly Fdc3Channel[]>('getUserChannels', () => agent.getUserChannels(), []);
    },

    getOrCreateChannel: async (channelId) => {
      if (!agent) return null;
      return guard('getOrCreateChannel', () => agent.getOrCreateChannel(channelId), null);
    },

    stop: async () => {
      for (const listener of openListener.splice(0)) {
        try {
          listener.unsubscribe();
        } catch (error) {
          report(error, 'unsubscribe');
        }
      }
      appChannel = null;
      lastBroadcastKey = null;
      started = false;
      await Promise.resolve();
    },
  };

  return bridge;
}
