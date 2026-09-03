// =============================================================================
// The injectable DesktopAgent
//
// FDC3 defines the desktop agent as an ambient global (`window.fdc3`) injected
// by the container — FDC3 Desktop Agent, OpenFin, Finsemble, Glue42, Here.
// Depending on that global directly makes the whole feature untestable and
// couples oneGrid to a container it will often not be running inside. So the
// agent is declared here as a narrow interface and *injected*, exactly as
// `SqliteQueryable` is in the sqlite adapter.
//
// Three consequences fall out of that decision, all of them wanted:
//
//   1. `detectAgent()` is the only code that ever touches `window`, and it is
//      allowed to return null. Everything downstream takes `DesktopAgent | null`.
//   2. Tests drive `createInMemoryDesktopAgent()`, a real working agent that
//      routes broadcasts and intents between listeners in-process. It is
//      exported because adopters need it for their own tests too.
//   3. The interface is a strict subset of FDC3 2.0's DesktopAgent — the parts
//      a grid uses. A real `window.fdc3` structurally satisfies it, so no
//      adapter shim is needed at the boundary.
// =============================================================================

import type { Fdc3ContextBase } from './context.js';

/**
 * Handle returned by every listener registration. Calling `unsubscribe` twice
 * is safe.
 * @public
 */
export interface Fdc3Listener {
  unsubscribe: () => void;
}

/**
 * Metadata FDC3 2.0 attaches to a delivered context or intent, identifying the
 * app that sent it. Optional — 1.2-era agents do not supply it.
 * @public
 */
export interface Fdc3ContextMetadata {
  readonly source?: AppIdentifier;
}

/** @public */
export interface AppIdentifier {
  readonly appId: string;
  readonly instanceId?: string;
  readonly desktopAgent?: string;
}

/** @public */
export type ContextHandler = (
  context: Fdc3ContextBase,
  metadata?: Fdc3ContextMetadata,
) => void | Promise<void>;

/**
 * An intent handler may return a context as its result (FDC3 2.0 intent
 * results). Returning nothing is the common case.
 * @public
 */
export type IntentHandler = (
  context: Fdc3ContextBase,
  metadata?: Fdc3ContextMetadata,
) => void | Fdc3ContextBase | Promise<void | Fdc3ContextBase>;

/**
 * What `raiseIntent` resolves to: which app took the intent, and a lazy
 * accessor for whatever it returned.
 * @public
 */
export interface IntentResolution {
  readonly source: AppIdentifier;
  readonly intent: string;
  readonly getResult?: () => Promise<Fdc3ContextBase | void>;
}

/** @public */
export type ChannelKind = 'user' | 'app' | 'private';

/**
 * A context channel. User channels are the coloured desk-wide channels a
 * trader picks in the container chrome; app channels are private rendezvous
 * points two apps agree on by name.
 * @public
 */
export interface Fdc3Channel {
  readonly id: string;
  readonly type: ChannelKind;
  readonly displayMetadata?: {
    readonly name?: string;
    readonly color?: string;
    readonly glyph?: string;
  };
  broadcast: (context: Fdc3ContextBase) => Promise<void>;
  /** Last context broadcast on the channel, optionally filtered by type. */
  getCurrentContext: (contextType?: string) => Promise<Fdc3ContextBase | null>;
  addContextListener: (
    contextType: string | null,
    handler: ContextHandler,
  ) => Promise<Fdc3Listener>;
}

/**
 * The subset of the FDC3 2.0 DesktopAgent a grid needs. A container-provided
 * `window.fdc3` satisfies this structurally.
 * @public
 */
export interface DesktopAgent {
  broadcast: (context: Fdc3ContextBase) => Promise<void>;
  raiseIntent: (
    intent: string,
    context: Fdc3ContextBase,
    app?: AppIdentifier,
  ) => Promise<IntentResolution>;
  addIntentListener: (intent: string, handler: IntentHandler) => Promise<Fdc3Listener>;
  addContextListener: (
    contextType: string | null,
    handler: ContextHandler,
  ) => Promise<Fdc3Listener>;
  getUserChannels: () => Promise<readonly Fdc3Channel[]>;
  joinUserChannel: (channelId: string) => Promise<void>;
  leaveCurrentChannel: () => Promise<void>;
  getCurrentChannel: () => Promise<Fdc3Channel | null>;
  getOrCreateChannel: (channelId: string) => Promise<Fdc3Channel>;
}

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

/**
 * Duck-type check rather than a truthiness check. A page can define
 * `window.fdc3` as a half-initialised placeholder while the container boots;
 * treating that as an agent produces a `TypeError` on first broadcast, which
 * is worse than degrading. Every method the bridge calls must be a function
 * before we accept the object.
 */
const REQUIRED_METHOD = [
  'broadcast',
  'raiseIntent',
  'addIntentListener',
  'addContextListener',
  'getOrCreateChannel',
] as const;

function looksLikeAgent(value: unknown): value is DesktopAgent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return REQUIRED_METHOD.every((method) => typeof candidate[method] === 'function');
}

/**
 * Returns the container-injected desktop agent, or `null` when there is none.
 *
 * This never throws and never waits: a grid in a plain browser tab must render
 * on the same code path as a grid inside OpenFin, so absence is an ordinary
 * result, not an error. Pass an explicit `scope` in tests or in a worker where
 * `globalThis` is not the window.
 * @public
 */
export function detectAgent(scope?: unknown): DesktopAgent | null {
  const root = scope ?? (typeof globalThis === 'undefined' ? undefined : globalThis);
  if (typeof root !== 'object' || root === null) return null;
  const candidate = (root as { fdc3?: unknown }).fdc3;
  return looksLikeAgent(candidate) ? candidate : null;
}

// -----------------------------------------------------------------------------
// In-memory agent
// -----------------------------------------------------------------------------

/**
 * A recorded outbound broadcast: which channel it landed on (`null` = the
 * agent-level broadcast, i.e. the joined user channel) and what was sent.
 * @public
 */
export interface RecordedBroadcast {
  readonly channelId: string | null;
  readonly context: Fdc3ContextBase;
}

/** @public */
export interface RecordedIntent {
  readonly intent: string;
  readonly context: Fdc3ContextBase;
  readonly app?: AppIdentifier;
}

/**
 * A fully working desktop agent that lives in this process. It is the test
 * double for the bridge, and it is also what an adopter should point their own
 * tests at — the point of injecting the agent is that nobody has to boot a
 * container to prove their mapping works.
 * @public
 */
export interface InMemoryDesktopAgent extends DesktopAgent {
  /** Every broadcast the grid emitted, oldest first. */
  readonly broadcastLog: readonly RecordedBroadcast[];
  /** Every intent the grid raised, oldest first. */
  readonly intentLog: readonly RecordedIntent[];
  /** Simulate a peer app raising an intent at us. Resolves to the handler's
   *  return value, or undefined when no listener is registered. */
  dispatchIntent: (
    intent: string,
    context: Fdc3ContextBase,
    metadata?: Fdc3ContextMetadata,
  ) => Promise<Fdc3ContextBase | void>;
  /** Simulate a peer app broadcasting. `channelId` null targets the joined
   *  user channel, matching what a peer on the same colour would do. */
  dispatchContext: (
    context: Fdc3ContextBase,
    channelId?: string | null,
    metadata?: Fdc3ContextMetadata,
  ) => Promise<void>;
  /** Registered app identity used as `IntentResolution.source`. */
  readonly appId: string;
  reset: () => void;
}

/** @public */
export interface InMemoryDesktopAgentOptions {
  /** User channel ids. Defaults to the FDC3 reference colour set. */
  readonly userChannelId?: readonly string[];
  /** appId reported as the resolving app for raised intents. */
  readonly appId?: string;
}

const DEFAULT_USER_CHANNEL_ID = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

interface Subscription {
  readonly contextType: string | null;
  readonly handler: ContextHandler;
}

/**
 * Builds an in-memory desktop agent. Broadcasts are recorded and delivered to
 * every listener subscribed to the matching channel and context type; intents
 * are recorded and routed to the registered intent handler.
 * @public
 */
export function createInMemoryDesktopAgent(
  option: InMemoryDesktopAgentOptions = {},
): InMemoryDesktopAgent {
  const appId = option.appId ?? 'in-memory-agent';
  const userChannelId = option.userChannelId ?? DEFAULT_USER_CHANNEL_ID;

  const broadcastLog: RecordedBroadcast[] = [];
  const intentLog: RecordedIntent[] = [];
  const intentHandler = new Map<string, IntentHandler[]>();
  // Channel id -> subscriptions. The agent-level listener set is keyed by the
  // sentinel below so that joining a channel re-points it without re-registering.
  const channelSubscription = new Map<string, Subscription[]>();
  const agentSubscription: Subscription[] = [];
  const lastContext = new Map<string, Map<string, Fdc3ContextBase>>();
  const channelKind = new Map<string, ChannelKind>(
    userChannelId.map((id) => [id, 'user']),
  );

  let currentChannelId: string | null = null;

  function subscriptionFor(channelId: string): Subscription[] {
    let list = channelSubscription.get(channelId);
    if (!list) {
      list = [];
      channelSubscription.set(channelId, list);
    }
    return list;
  }

  function remember(channelId: string, context: Fdc3ContextBase): void {
    let byType = lastContext.get(channelId);
    if (!byType) {
      byType = new Map();
      lastContext.set(channelId, byType);
    }
    byType.set(context.type, context);
  }

  function deliver(subscription: readonly Subscription[], context: Fdc3ContextBase,
    metadata?: Fdc3ContextMetadata): Promise<void> {
    // Copy before iterating: a handler is allowed to unsubscribe itself.
    const target = subscription.filter(
      (sub) => sub.contextType === null || sub.contextType === context.type,
    );
    // Handlers may be sync or async; normalise before aggregating.
    return Promise.all(
      target.map((sub) => Promise.resolve(sub.handler(context, metadata))),
    ).then(() => undefined);
  }

  function makeListener(list: Subscription[], subscription: Subscription): Fdc3Listener {
    return {
      unsubscribe: () => {
        const at = list.indexOf(subscription);
        if (at >= 0) list.splice(at, 1);
      },
    };
  }

  function makeChannel(id: string, kind: ChannelKind): Fdc3Channel {
    return {
      id,
      type: kind,
      broadcast: (context) => {
        broadcastLog.push({ channelId: id, context });
        remember(id, context);
        return deliver(subscriptionFor(id), context);
      },
      getCurrentContext: (contextType) => {
        const byType = lastContext.get(id);
        if (!byType) return Promise.resolve(null);
        if (contextType) return Promise.resolve(byType.get(contextType) ?? null);
        // No type filter: the most recently written entry wins.
        const entry = Array.from(byType.values());
        return Promise.resolve(entry.length === 0 ? null : entry[entry.length - 1]!);
      },
      addContextListener: (contextType, handler) => {
        const list = subscriptionFor(id);
        const subscription: Subscription = { contextType, handler };
        list.push(subscription);
        return Promise.resolve(makeListener(list, subscription));
      },
    };
  }

  const agent: InMemoryDesktopAgent = {
    appId,
    get broadcastLog() {
      return broadcastLog;
    },
    get intentLog() {
      return intentLog;
    },

    broadcast: (context) => {
      broadcastLog.push({ channelId: currentChannelId, context });
      if (currentChannelId !== null) {
        remember(currentChannelId, context);
        return deliver(subscriptionFor(currentChannelId), context);
      }
      // Not joined to a channel: FDC3 agents drop the broadcast. We still
      // record it so a test can assert the grid tried.
      return Promise.resolve();
    },

    raiseIntent: (intent, context, app) => {
      // Built conditionally: under exactOptionalPropertyTypes an explicit
      // `app: undefined` is not the same as an absent key.
      intentLog.push(app === undefined ? { intent, context } : { intent, context, app });
      const handler = intentHandler.get(intent);
      const source: AppIdentifier = app ?? { appId };
      if (!handler || handler.length === 0) {
        return Promise.resolve({ source, intent });
      }
      const resultPromise = Promise.resolve(handler[0]!(context));
      return Promise.resolve({
        source,
        intent,
        getResult: () => resultPromise,
      });
    },

    addIntentListener: (intent, handler) => {
      let list = intentHandler.get(intent);
      if (!list) {
        list = [];
        intentHandler.set(intent, list);
      }
      list.push(handler);
      const captured = list;
      return Promise.resolve({
        unsubscribe: () => {
          const at = captured.indexOf(handler);
          if (at >= 0) captured.splice(at, 1);
        },
      });
    },

    addContextListener: (contextType, handler) => {
      const subscription: Subscription = { contextType, handler };
      agentSubscription.push(subscription);
      return Promise.resolve(makeListener(agentSubscription, subscription));
    },

    getUserChannels: () =>
      Promise.resolve(userChannelId.map((id) => makeChannel(id, 'user'))),

    joinUserChannel: (channelId) => {
      if (!userChannelId.includes(channelId)) {
        return Promise.reject(new Error(`unknown user channel: ${channelId}`));
      }
      currentChannelId = channelId;
      // FDC3 replays the channel's current context to the joining app.
      const byType = lastContext.get(channelId);
      const entry = byType ? Array.from(byType.values()) : [];
      if (entry.length === 0) return Promise.resolve();
      return deliver(agentSubscription, entry[entry.length - 1]!);
    },

    leaveCurrentChannel: () => {
      currentChannelId = null;
      return Promise.resolve();
    },

    getCurrentChannel: () =>
      Promise.resolve(
        currentChannelId === null
          ? null
          : makeChannel(currentChannelId, channelKind.get(currentChannelId) ?? 'user'),
      ),

    getOrCreateChannel: (channelId) => {
      if (!channelKind.has(channelId)) channelKind.set(channelId, 'app');
      return Promise.resolve(makeChannel(channelId, channelKind.get(channelId)!));
    },

    dispatchIntent: (intent, context, metadata) => {
      const handler = intentHandler.get(intent);
      if (!handler || handler.length === 0) return Promise.resolve();
      return Promise.resolve(handler[0]!(context, metadata));
    },

    dispatchContext: (context, channelId = null, metadata) => {
      if (channelId === null) {
        // A peer on the same user channel: agent-level listeners see it, and
        // so do channel listeners on the joined channel.
        const work = [deliver(agentSubscription, context, metadata)];
        if (currentChannelId !== null) {
          remember(currentChannelId, context);
          work.push(deliver(subscriptionFor(currentChannelId), context, metadata));
        }
        return Promise.all(work).then(() => undefined);
      }
      remember(channelId, context);
      const work = [deliver(subscriptionFor(channelId), context, metadata)];
      if (channelId === currentChannelId) {
        work.push(deliver(agentSubscription, context, metadata));
      }
      return Promise.all(work).then(() => undefined);
    },

    reset: () => {
      broadcastLog.length = 0;
      intentLog.length = 0;
      intentHandler.clear();
      channelSubscription.clear();
      agentSubscription.length = 0;
      lastContext.clear();
      currentChannelId = null;
    },
  };

  return agent;
}
