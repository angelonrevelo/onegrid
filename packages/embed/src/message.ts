// =============================================================================
// @onegrid/embed — the host ↔ guest postMessage protocol.
//
// This is a security surface, so the rules are strict and symmetric:
//
//   - Origin is checked on BOTH sides. A host that only checks the child's
//     origin is still vulnerable to a malicious page that frames the guest and
//     drives it; a guest that only checks the parent's origin can be tricked by
//     any page that can get a reference to its window. Neither side ever calls
//     postMessage with a `'*'` target origin, and neither side ever acts on a
//     message whose `event.origin` is not in its allowlist.
//   - Every message carries a `channel` tag. A document host is full of other
//     people's postMessage traffic — analytics, video players, its own editor.
//     A message without our tag is not an error, it is simply not ours, and is
//     dropped silently rather than logged as a fault.
//   - Every message carries an `id`, and a reply carries `replyTo`. That is what
//     makes request/response possible over a channel that is otherwise pure
//     fire-and-forget, and it is what lets two concurrent in-flight requests not
//     confuse each other's answers.
//   - A handshake with version negotiation runs before anything else. The guest
//     is a separately deployed bundle; it will drift from the host. The
//     handshake settles on the highest version both sides claim to speak, and
//     the connection fails closed when there is no overlap.
//
// Both ends are built on a narrow injectable pair (`MessageListenerTarget` +
// `MessagePoster`) rather than reaching for `window` directly. That is the
// repo's established pattern for anything environmental, and it is what makes
// the origin-rejection path testable without spinning up two real browsing
// contexts.
// =============================================================================

import type { EmbedTheme, EmbedViewState } from './block';

/**
 * Wire tag on every message. Anything without it is someone else's traffic.
 *
 * @public
 */
export const EMBED_CHANNEL = 'onegrid-embed' as const;

/**
 * Protocol version this build speaks. Bump on any incompatible change to the
 * message union; the handshake negotiates down to a shared version.
 *
 * @public
 */
export const EMBED_PROTOCOL_VERSION = 2;

/**
 * Every version this build can still speak, newest first. The handshake picks
 * the highest entry the peer also lists.
 *
 * @public
 */
export const EMBED_SUPPORTED_VERSION: ReadonlyArray<number> = [2, 1];

// -----------------------------------------------------------------------------
// Message union
// -----------------------------------------------------------------------------

/** Fields present on every message regardless of direction. @public */
export interface EmbedMessageBase {
  readonly channel: typeof EMBED_CHANNEL;
  /** Unique per message; a reply echoes it back in `replyTo`. */
  readonly id: string;
  /** Set only on a reply, naming the request it answers. */
  readonly replyTo?: string;
}

/** Host → guest. Opens the connection and offers a version list. @public */
export interface HandshakeMessage extends EmbedMessageBase {
  readonly type: 'handshake';
  readonly version: ReadonlyArray<number>;
  /** Origin the guest should send its replies to. */
  readonly hostOrigin: string;
}

/** Guest → host. Settles the version, or reports no overlap. @public */
export interface HandshakeAckMessage extends EmbedMessageBase {
  readonly type: 'handshake-ack';
  /** Negotiated version, or null when the two version lists do not intersect. */
  readonly version: number | null;
}

/** Guest → host. The grid is mounted and interactive. @public */
export interface ReadyMessage extends EmbedMessageBase {
  readonly type: 'ready';
  readonly blockId: string;
}

/** Guest → host. Content height changed; resize the frame. @public */
export interface ResizeMessage extends EmbedMessageBase {
  readonly type: 'resize';
  readonly height: number;
  readonly width?: number;
}

/** Guest → host. Sort / filter / grouping changed. @public */
export interface StateChangeMessage extends EmbedMessageBase {
  readonly type: 'state-change';
  readonly state: EmbedViewState;
}

/** Guest → host. The user selected a row. @public */
export interface RowSelectedMessage extends EmbedMessageBase {
  readonly type: 'row-selected';
  readonly rowId: string | number;
  readonly rowIndex: number;
}

/** Guest → host. A cell was edited. @public */
export interface EditMessage extends EmbedMessageBase {
  readonly type: 'edit';
  readonly rowId: string | number;
  readonly columnId: string;
  readonly value: unknown;
}

/** Either direction. Fatal or recoverable failure, with a machine code. @public */
export interface ErrorMessage extends EmbedMessageBase {
  readonly type: 'error';
  readonly code: 'version-mismatch' | 'bad-block' | 'load-failed' | 'forbidden' | 'internal';
  readonly message: string;
}

/** Host → guest. Push a theme change (e.g. the host went dark). @public */
export interface ThemeChangeMessage extends EmbedMessageBase {
  readonly type: 'theme-change';
  readonly theme: EmbedTheme;
}

/**
 * Every message that may cross the frame boundary.
 *
 * @public
 */
export type EmbedMessage =
  | HandshakeMessage
  | HandshakeAckMessage
  | ReadyMessage
  | ResizeMessage
  | StateChangeMessage
  | RowSelectedMessage
  | EditMessage
  | ErrorMessage
  | ThemeChangeMessage;

/** Discriminator values of {@link EmbedMessage}. @public */
export type EmbedMessageType = EmbedMessage['type'];

// A plain `Omit<EmbedMessage, ...>` collapses the union into one object type
// with only the keys every member shares, which would make `send({ type:
// 'resize', height })` a type error. Distributing over the union preserves each
// member's own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A message minus the envelope fields the connection fills in.
 *
 * @public
 */
export type EmbedMessageInit = DistributiveOmit<EmbedMessage, 'channel' | 'id'>;

/**
 * A reply minus the envelope fields, including `replyTo` which the connection
 * derives from the message being answered.
 *
 * @public
 */
export type EmbedReplyInit = DistributiveOmit<EmbedMessage, 'channel' | 'id' | 'replyTo'>;

// -----------------------------------------------------------------------------
// Injectable environment
// -----------------------------------------------------------------------------

/**
 * The slice of `window` this package listens on. Narrow by design: an adopter
 * embedding inside a worker, a test, or an exotic host can supply their own.
 *
 * @public
 */
export interface MessageListenerTarget {
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

/**
 * The slice of a peer `Window` this package writes to. `targetOrigin` is
 * required, not optional — the `'*'` escape hatch is not reachable from here.
 *
 * @public
 */
export interface MessagePoster {
  postMessage(data: unknown, targetOrigin: string): void;
}

// -----------------------------------------------------------------------------
// Shared plumbing
// -----------------------------------------------------------------------------

let counter = 0;

/**
 * Message id. Uses `crypto.randomUUID` where available and falls back to a
 * counter plus timestamp — ids only need to be unique within one connection,
 * not globally unpredictable, because the origin check is what provides the
 * security, not id entropy.
 *
 * @public
 */
export function nextMessageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  counter += 1;
  return `og-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Type guard for inbound data. Deliberately shape-based rather than
 * `instanceof`, because the structured-clone algorithm strips prototypes.
 *
 * @public
 */
export function isEmbedMessage(data: unknown): data is EmbedMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Partial<EmbedMessage>;
  return m.channel === EMBED_CHANNEL && typeof m.id === 'string' && typeof m.type === 'string';
}

/**
 * Pick the highest version present in both lists, or null when they do not
 * intersect. Exported because a server rendering the guest bundle may need to
 * run the same negotiation before it emits anything.
 *
 * @public
 */
export function negotiateVersion(
  mine: ReadonlyArray<number>,
  their: ReadonlyArray<number>,
): number | null {
  let best: number | null = null;
  for (const v of mine) {
    if (their.includes(v) && (best === null || v > best)) best = v;
  }
  return best;
}

type Handler = (message: EmbedMessage) => void;

interface PendingRequest {
  readonly resolve: (message: EmbedMessage) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Shared connection surface. Both {@link createEmbedHost} and
 * {@link createEmbedGuest} return this shape so a caller can write code
 * against a connection without caring which side of the frame it is on.
 *
 * @public
 */
export interface EmbedConnection {
  /** Send a message; an `id` is generated when the caller omits one. */
  send(message: EmbedMessageInit & { readonly id?: string }): string;
  /** Send and await the reply whose `replyTo` matches. Rejects on timeout. */
  request(message: EmbedMessageInit, timeoutMs?: number): Promise<EmbedMessage>;
  /** Reply to a received message, correlating automatically. */
  reply(to: EmbedMessage, message: EmbedReplyInit): void;
  /** Subscribe to one message type. Returns an unsubscribe function. */
  on(type: EmbedMessageType, handler: Handler): () => void;
  /** Negotiated protocol version, or null before the handshake completes. */
  readonly version: number | null;
  /** Count of inbound messages dropped for a failed origin / channel check. */
  readonly rejectedCount: number;
  dispose(): void;
}

interface ChannelOption {
  readonly self: MessageListenerTarget;
  readonly peer: MessagePoster;
  /** Origins accepted on inbound messages AND used as the postMessage target. */
  readonly peerOrigin: string;
}

interface Channel {
  readonly connection: EmbedConnection;
  setVersion(v: number | null): void;
}

function createChannel(option: ChannelOption): Channel {
  const handlerByType = new Map<EmbedMessageType, Set<Handler>>();
  const pending = new Map<string, PendingRequest>();
  let version: number | null = null;
  let rejected = 0;
  let disposed = false;

  const onMessage = (event: MessageEvent): void => {
    // Origin check first, before the payload is inspected at all. A message
    // from the wrong origin is not parsed, not logged by type, not counted as
    // anything but a rejection.
    if (event.origin !== option.peerOrigin) {
      rejected += 1;
      return;
    }
    if (!isEmbedMessage(event.data)) {
      // Not tagged as ours. Someone else's traffic — drop silently, and do not
      // count it as a rejection, because it is not a security event.
      return;
    }
    const message = event.data;
    if (message.replyTo !== undefined) {
      const waiter = pending.get(message.replyTo);
      if (waiter) {
        pending.delete(message.replyTo);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        // A reply still fans out to type subscribers: a caller may await the
        // handshake ack AND separately observe every ack for logging.
      }
    }
    for (const h of handlerByType.get(message.type) ?? []) h(message);
  };

  option.self.addEventListener('message', onMessage);

  const post = (message: EmbedMessage): void => {
    if (disposed) throw new Error('@onegrid/embed: connection is disposed.');
    option.peer.postMessage(message, option.peerOrigin);
  };

  const connection: EmbedConnection = {
    send(message) {
      const id = message.id ?? nextMessageId();
      post({ ...message, channel: EMBED_CHANNEL, id });
      return id;
    },
    request(message, timeoutMs = 5000) {
      const id = nextMessageId();
      return new Promise<EmbedMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`@onegrid/embed: no reply to '${message.type}' within ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          post({ ...message, channel: EMBED_CHANNEL, id });
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    reply(to, message) {
      post({ ...message, channel: EMBED_CHANNEL, id: nextMessageId(), replyTo: to.id });
    },
    on(type, handler) {
      let set = handlerByType.get(type);
      if (!set) {
        set = new Set();
        handlerByType.set(type, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
    get version() {
      return version;
    },
    get rejectedCount() {
      return rejected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      option.self.removeEventListener('message', onMessage);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('@onegrid/embed: connection disposed before reply.'));
      }
      pending.clear();
      handlerByType.clear();
    },
  };

  return {
    connection,
    setVersion(v) {
      version = v;
    },
  };
}

// -----------------------------------------------------------------------------
// Host side
// -----------------------------------------------------------------------------

/**
 * Options for {@link createEmbedHost}.
 *
 * @public
 */
export interface EmbedHostOption {
  /** Where the host listens — normally `window`. */
  readonly self: MessageListenerTarget;
  /** The frame's content window. */
  readonly peer: MessagePoster;
  /** Exact origin of the embedded document. Never `'*'`. */
  readonly guestOrigin: string;
  /** This document's own origin, sent to the guest so it can check us back. */
  readonly hostOrigin: string;
  readonly version?: ReadonlyArray<number>;
}

/**
 * The host half of the connection, plus a handshake that resolves once the
 * guest has agreed a version.
 *
 * @public
 */
export interface EmbedHost extends EmbedConnection {
  /** Send the handshake and await the ack. Rejects when versions do not overlap. */
  handshake(timeoutMs?: number): Promise<number>;
}

/**
 * Build the parent-page side of the connection.
 *
 * @public
 */
export function createEmbedHost(option: EmbedHostOption): EmbedHost {
  const mine = option.version ?? EMBED_SUPPORTED_VERSION;
  const channel = createChannel({
    self: option.self,
    peer: option.peer,
    peerOrigin: option.guestOrigin,
  });

  // Methods are delegated one by one rather than spread: `version` and
  // `rejectedCount` are live getters, and Object.assign would freeze them at
  // their construction-time values.
  const host: EmbedHost = {
    send: (message) => channel.connection.send(message),
    request: (message, timeoutMs) => channel.connection.request(message, timeoutMs),
    reply: (to, message) => channel.connection.reply(to, message),
    on: (type, handler) => channel.connection.on(type, handler),
    dispose: () => channel.connection.dispose(),
    get version() {
      return channel.connection.version;
    },
    get rejectedCount() {
      return channel.connection.rejectedCount;
    },
    async handshake(timeoutMs = 5000): Promise<number> {
      const ack = await channel.connection.request(
        { type: 'handshake', version: mine, hostOrigin: option.hostOrigin },
        timeoutMs,
      );
      if (ack.type !== 'handshake-ack') {
        throw new Error(`@onegrid/embed: expected handshake-ack, got '${ack.type}'.`);
      }
      if (ack.version === null) {
        throw new Error(
          `@onegrid/embed: no shared protocol version. Host speaks [${mine.join(', ')}].`,
        );
      }
      channel.setVersion(ack.version);
      return ack.version;
    },
  };

  return host;
}

// -----------------------------------------------------------------------------
// Guest side
// -----------------------------------------------------------------------------

/**
 * Options for {@link createEmbedGuest}.
 *
 * @public
 */
export interface EmbedGuestOption {
  /** Where the guest listens — normally its own `window`. */
  readonly self: MessageListenerTarget;
  /** The parent window. */
  readonly peer: MessagePoster;
  /** Exact origin of the embedding page. Never `'*'`. */
  readonly hostOrigin: string;
  readonly version?: ReadonlyArray<number>;
}

/**
 * The guest half of the connection. It answers the handshake automatically, so
 * an embedded bundle only has to construct it and start reporting.
 *
 * @public
 */
export interface EmbedGuest extends EmbedConnection {
  /** Resolves with the negotiated version once the host has shaken hands. */
  whenConnected(timeoutMs?: number): Promise<number>;
  /** Announce that the grid is mounted. */
  reportReady(blockId: string): void;
  /** Report content height so the host can size the frame. */
  reportHeight(height: number, width?: number): void;
}

/**
 * Build the embedded-document side of the connection.
 *
 * @public
 */
export function createEmbedGuest(option: EmbedGuestOption): EmbedGuest {
  const mine = option.version ?? EMBED_SUPPORTED_VERSION;
  const channel = createChannel({
    self: option.self,
    peer: option.peer,
    peerOrigin: option.hostOrigin,
  });

  let settle: ((v: number) => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  let settledVersion: number | null = null;
  const connected = new Promise<number>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Nothing may await `connected` before a handshake arrives, and an unhandled
  // rejection on a promise no one is holding would crash a strict host. Attach
  // an inert catch; `whenConnected` re-exposes the real rejection.
  connected.catch(() => undefined);

  channel.connection.on('handshake', (message) => {
    if (message.type !== 'handshake') return;
    const agreed = negotiateVersion(mine, message.version);
    channel.connection.reply(message, { type: 'handshake-ack', version: agreed });
    if (agreed === null) {
      const err = new Error(
        `@onegrid/embed: no shared protocol version. Guest speaks [${mine.join(', ')}], host offered [${message.version.join(', ')}].`,
      );
      fail?.(err);
      return;
    }
    channel.setVersion(agreed);
    settledVersion = agreed;
    settle?.(agreed);
  });

  const guest: EmbedGuest = {
    send: (message) => channel.connection.send(message),
    request: (message, timeoutMs) => channel.connection.request(message, timeoutMs),
    reply: (to, message) => channel.connection.reply(to, message),
    on: (type, handler) => channel.connection.on(type, handler),
    dispose: () => channel.connection.dispose(),
    get version() {
      return channel.connection.version;
    },
    get rejectedCount() {
      return channel.connection.rejectedCount;
    },
    whenConnected(timeoutMs = 5000): Promise<number> {
      if (settledVersion !== null) return Promise.resolve(settledVersion);
      return Promise.race([
        connected,
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error(`@onegrid/embed: no handshake within ${timeoutMs}ms.`)),
            timeoutMs,
          ),
        ),
      ]);
    },
    reportReady(blockId: string): void {
      channel.connection.send({ type: 'ready', blockId });
    },
    reportHeight(height: number, width?: number): void {
      channel.connection.send(
        width === undefined ? { type: 'resize', height } : { type: 'resize', height, width },
      );
    },
  };

  return guest;
}
