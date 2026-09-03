// =============================================================================
// @onegrid/embed — spec.
//
// Covers the four things that actually break in production embedding:
// a descriptor written by an old build, a link that does not survive transit,
// a message from an origin we do not trust, and a host that forbids something
// we assumed. Everything else is scaffolding around those.
// =============================================================================

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertBlock,
  BLOCK_SCHEMA_VERSION,
  buildEmbedUrl,
  createBlock,
  createEmbedFrame,
  createEmbedGuest,
  createEmbedHost,
  decodeBlockUrl,
  defineEmbedElement,
  deserializeBlock,
  detectBlockVersion,
  EMBED_ALLOW_POLICY,
  EMBED_CHANNEL,
  EMBED_SANDBOX_TOKEN,
  EMBED_SUPPORTED_VERSION,
  embedIframeHtml,
  embedMetaTag,
  encodeBlockUrl,
  frameOrigin,
  fromBase64Url,
  isEmbedMessage,
  measureBlockUrlLength,
  migrateBlock,
  negotiateCapability,
  negotiateVersion,
  oembedResponse,
  ONEGRID_EMBED_TAG_NAME,
  OneGridEmbedElement,
  parseEmbedUrl,
  renderEmbedMetaTag,
  serializeBlock,
  startAutoResize,
  toBase64Url,
} from '../index';
import type {
  EmbedBlock,
  EmbedBlockV1,
  EmbedBlockV2,
  EmbedMessage,
  MessageListenerTarget,
  MessagePoster,
} from '../index';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function sampleBlock(): EmbedBlock {
  return createBlock({
    id: 'blk-1',
    title: 'Quarterly revenue',
    source: { kind: 'url', ref: 'https://data.example.com/revenue' },
    column: [
      { id: 'region', displayName: 'Region', type: 'string', width: 160 },
      { id: 'amount', displayName: 'Amount', type: 'number' },
    ],
    state: {
      sort: [{ columnId: 'amount', direction: 'desc' }],
      filter: { type: 'comparison', columnId: 'region', op: 'eq', value: 'APAC' },
    },
    theme: 'dark',
    preset: 'compact',
  });
}

/**
 * A pair of fake windows wired to each other. This is the whole reason the
 * message layer takes injectable listener/poster interfaces: a real host/guest
 * pair needs two browsing contexts, and jsdom's cross-frame messaging is not
 * faithful enough to test an origin rejection against.
 */
function makeEndpoint(origin: string) {
  const handler = new Set<(event: MessageEvent) => void>();
  const sent: { data: unknown; targetOrigin: string }[] = [];
  const self: MessageListenerTarget = {
    addEventListener: (_t, h) => handler.add(h),
    removeEventListener: (_t, h) => handler.delete(h),
  };
  const deliver = (data: unknown, fromOrigin: string): void => {
    const event = { data, origin: fromOrigin } as MessageEvent;
    for (const h of [...handler]) h(event);
  };
  return { origin, self, sent, deliver, handlerCount: () => handler.size };
}

function connect(hostOrigin: string, guestOrigin: string) {
  const hostEnd = makeEndpoint(hostOrigin);
  const guestEnd = makeEndpoint(guestOrigin);

  const toGuest: MessagePoster = {
    postMessage: (data, targetOrigin) => {
      hostEnd.sent.push({ data, targetOrigin });
      guestEnd.deliver(data, hostOrigin);
    },
  };
  const toHost: MessagePoster = {
    postMessage: (data, targetOrigin) => {
      guestEnd.sent.push({ data, targetOrigin });
      hostEnd.deliver(data, guestOrigin);
    },
  };

  const host = createEmbedHost({
    self: hostEnd.self,
    peer: toGuest,
    guestOrigin,
    hostOrigin,
  });
  const guest = createEmbedGuest({
    self: guestEnd.self,
    peer: toHost,
    hostOrigin,
  });
  return { host, guest, hostEnd, guestEnd };
}

afterEach(() => {
  vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// Serialisation + migration
// -----------------------------------------------------------------------------

describe('block serialisation', () => {
  it('round-trips a full block without loss', () => {
    const block = sampleBlock();
    const restored = deserializeBlock(serializeBlock(block));
    expect(restored).toEqual(block);
  });

  it('serialises deterministically regardless of key insertion order', () => {
    const a = sampleBlock();
    // Same content, opposite key order at the root.
    const b = JSON.parse(JSON.stringify({ ...a })) as EmbedBlock;
    const shuffled = Object.fromEntries(Object.entries(b).reverse()) as unknown as EmbedBlock;
    expect(serializeBlock(shuffled)).toBe(serializeBlock(a));
    expect(serializeBlock(a).startsWith('{"schemaVersion":')).toBe(true);
  });

  it('createBlock stamps the current schema version and defaults state', () => {
    const block = createBlock({
      id: 'b',
      source: { kind: 'named', ref: 'sales' },
      column: [{ id: 'x' }],
    });
    expect(block.schemaVersion).toBe(BLOCK_SCHEMA_VERSION);
    expect(block.state).toEqual({ sort: [], filter: null });
    expect(block.theme).toBe('auto');
    expect('title' in block).toBe(false);
  });

  it('rejects a structurally invalid block with a specific message', () => {
    expect(() => assertBlock({ schemaVersion: 3, id: '', source: { kind: 'url', ref: '' } })).toThrow(
      /block.id must be a non-empty string/,
    );
    expect(() =>
      assertBlock({ schemaVersion: 3, id: 'a', source: { kind: 'ftp', ref: '' } }),
    ).toThrow(/source.kind/);
    expect(() => deserializeBlock('{not json')).toThrow(/not valid JSON/);
  });
});

describe('block migration', () => {
  it('detects the version of any descriptor, and 0 for a non-block', () => {
    expect(detectBlockVersion({ schemaVersion: 1 })).toBe(1);
    expect(detectBlockVersion(sampleBlock())).toBe(BLOCK_SCHEMA_VERSION);
    expect(detectBlockVersion(null)).toBe(0);
    expect(detectBlockVersion({ schemaVersion: '3' })).toBe(0);
  });

  it('migrates a v1 descriptor all the way to the current shape', () => {
    const v1: EmbedBlockV1 = {
      schemaVersion: 1,
      id: 'legacy-1',
      title: 'Old block',
      source: 'https://data.example.com/legacy',
      columns: ['a', 'b', 'c'],
      sort: { columnId: 'b', direction: 'asc' },
      theme: 'light',
    };
    const migrated = migrateBlock(v1);
    expect(migrated.schemaVersion).toBe(BLOCK_SCHEMA_VERSION);
    // v1's bare URL became a tagged source ref.
    expect(migrated.source).toEqual({ kind: 'url', ref: 'https://data.example.com/legacy' });
    // v1's id-only columns became structured, singular `column`.
    expect(migrated.column).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    // v1's single sort became a one-entry sort model under `state`.
    expect(migrated.state.sort).toEqual([{ columnId: 'b', direction: 'asc' }]);
    // v1 had no filter concept; absent means null, not an empty node.
    expect(migrated.state.filter).toBeNull();
    expect(migrated.theme).toBe('light');
    expect(migrated.title).toBe('Old block');
  });

  it('migrates a v1 descriptor with no sort and no theme to safe defaults', () => {
    const migrated = migrateBlock({
      schemaVersion: 1,
      id: 'legacy-2',
      source: 'https://x/y',
      columns: [],
    } satisfies EmbedBlockV1);
    expect(migrated.state.sort).toEqual([]);
    expect(migrated.theme).toBe('auto');
    expect(migrated.column).toEqual([]);
    expect('title' in migrated).toBe(false);
  });

  it('migrates a v2 descriptor and preserves its filter', () => {
    const v2: EmbedBlockV2 = {
      schemaVersion: 2,
      id: 'legacy-3',
      source: 'https://x/y',
      columns: [{ id: 'a', width: 90 }],
      sort: [{ columnId: 'a', direction: 'desc' }],
      filter: { type: 'comparison', columnId: 'a', op: 'gt', value: 5 },
      theme: { bg: '#000' },
    };
    const migrated = migrateBlock(v2);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.column).toEqual([{ id: 'a', width: 90 }]);
    expect(migrated.state.filter).toEqual({ type: 'comparison', columnId: 'a', op: 'gt', value: 5 });
    expect(migrated.theme).toEqual({ bg: '#000' });
  });

  it('decodes a v1 link written by an older build straight into the current shape', () => {
    // The real scenario: an old build encoded a v1 descriptor into a link that
    // is still sitting in someone's document.
    const legacyToken = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          id: 'from-2026',
          source: 'https://data.example.com/old',
          columns: ['q'],
          sort: null,
        }),
      ),
    );
    const block = decodeBlockUrl(legacyToken);
    expect(block.schemaVersion).toBe(BLOCK_SCHEMA_VERSION);
    expect(block.source.kind).toBe('url');
    expect(block.column).toEqual([{ id: 'q' }]);
  });

  it('refuses a future version rather than guessing', () => {
    expect(() => migrateBlock({ schemaVersion: BLOCK_SCHEMA_VERSION + 1, id: 'x' })).toThrow(
      /newer than this build understands/,
    );
    expect(() => migrateBlock({ nope: true })).toThrow(/missing or invalid `schemaVersion`/);
  });
});

// -----------------------------------------------------------------------------
// URL encoding
// -----------------------------------------------------------------------------

describe('url encoding', () => {
  it('round-trips a block through base64url', () => {
    const block = sampleBlock();
    const token = encodeBlockUrl(block);
    expect(decodeBlockUrl(token)).toEqual(block);
  });

  it('emits only URL-safe characters and no padding', () => {
    // Byte lengths 1..64 cover every tail case (0, 1 and 2 leftover bytes).
    for (let n = 1; n <= 64; n++) {
      const byte = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      const encoded = toBase64Url(byte);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).not.toContain('=');
      expect(fromBase64Url(encoded)).toEqual(byte);
    }
  });

  it('round-trips unicode content that btoa could not encode', () => {
    const block = createBlock({
      id: 'unicode',
      title: '売上 — Ventas 📊 «Ω»',
      source: { kind: 'named', ref: 'ventas/日本' },
      column: [
        { id: 'región', displayName: 'Región 🌏' },
        { id: 'кол', displayName: 'Количество' },
      ],
    });
    const restored = decodeBlockUrl(encodeBlockUrl(block));
    expect(restored.title).toBe('売上 — Ventas 📊 «Ω»');
    expect(restored.column[0]!.displayName).toBe('Región 🌏');
    expect(restored.source.ref).toBe('ventas/日本');
  });

  it('enforces the size guard and names the way out', () => {
    const fat = createBlock({
      id: 'fat',
      source: { kind: 'url', ref: 'https://x/y' },
      column: Array.from({ length: 400 }, (_, i) => ({
        id: `column_${i}`,
        displayName: `A fairly long display name for column ${i}`,
      })),
    });
    expect(measureBlockUrlLength(fat)).toBeGreaterThan(4096);
    expect(() => encodeBlockUrl(fat)).toThrow(/over the 4096-character ceiling/);
    expect(() => encodeBlockUrl(fat)).toThrow(/'named'/);
    // The ceiling is a policy, not a hard limit — a caller controlling the
    // whole request path can raise it.
    expect(() => encodeBlockUrl(fat, { maxLength: 100_000 })).not.toThrow();
  });

  it('rejects a mangled token instead of decoding garbage', () => {
    expect(() => fromBase64Url('abc*def')).toThrow(/illegal character/);
    expect(() => fromBase64Url('abcde')).toThrow(/length % 4 === 1/);
  });

  it('builds and parses a full embed URL, preserving existing query parameters', () => {
    const block = sampleBlock();
    const url = buildEmbedUrl('https://embed.onegrid.dev/v?lang=en', block);
    expect(url).toContain('lang=en');
    expect(url).toContain('&b=');
    expect(parseEmbedUrl(url)).toEqual(block);
    expect(parseEmbedUrl('https://embed.onegrid.dev/v')).toBeNull();
    expect(parseEmbedUrl(`${url}#anchor`)).toEqual(block);
  });
});

// -----------------------------------------------------------------------------
// iframe
// -----------------------------------------------------------------------------

describe('createEmbedFrame', () => {
  it('applies the justified sandbox allowlist and omits allow-same-origin', () => {
    const frame = createEmbedFrame({
      viewerUrl: 'https://embed.onegrid.dev/v',
      block: sampleBlock(),
      height: 320,
    });
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox.split(' ')).toEqual([...EMBED_SANDBOX_TOKEN]);
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    // The one token whose presence would defeat the sandbox entirely.
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-modals');
    expect(sandbox).not.toContain('allow-popups');
    expect(frame.getAttribute('allow')).toBe(EMBED_ALLOW_POLICY.join('; '));
    expect(frame.getAttribute('allow')).not.toContain('clipboard-read');
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame.style.height).toBe('320px');
    expect(frame.loading).toBe('lazy');
    expect(frame.title).toBe('Quarterly revenue');
  });

  it('accepts extra sandbox tokens after the defaults, and requires a source', () => {
    const frame = createEmbedFrame({
      src: 'https://embed.onegrid.dev/v?b=abc',
      extraSandboxToken: ['allow-downloads'],
    });
    expect(frame.getAttribute('sandbox')?.endsWith('allow-downloads')).toBe(true);
    expect(() => createEmbedFrame({})).toThrow(/needs either `src`, or `viewerUrl` \+ `block`/);
  });

  it('derives the guest origin from the frame src', () => {
    expect(frameOrigin('https://embed.onegrid.dev/v?b=x')).toBe('https://embed.onegrid.dev');
    // A relative src has no distinct origin — the caller must treat that as a
    // configuration error, never as a wildcard.
    expect(frameOrigin('/relative')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// postMessage protocol
// -----------------------------------------------------------------------------

describe('postMessage protocol', () => {
  it('completes a handshake and negotiates the highest shared version', async () => {
    const { host, guest } = connect('https://notion.so', 'https://embed.onegrid.dev');
    const version = await host.handshake();
    expect(version).toBe(Math.max(...EMBED_SUPPORTED_VERSION));
    expect(host.version).toBe(version);
    expect(await guest.whenConnected()).toBe(version);
    host.dispose();
    guest.dispose();
  });

  it('negotiates down to a version both sides still speak', () => {
    expect(negotiateVersion([3, 2, 1], [1, 2])).toBe(2);
    expect(negotiateVersion([3], [1, 2])).toBeNull();
  });

  it('fails the handshake closed when version lists do not intersect', async () => {
    const hostEnd = makeEndpoint('https://host.test');
    const guestEnd = makeEndpoint('https://guest.test');
    const host = createEmbedHost({
      self: hostEnd.self,
      peer: {
        postMessage: (data) => guestEnd.deliver(data, 'https://host.test'),
      },
      guestOrigin: 'https://guest.test',
      hostOrigin: 'https://host.test',
      version: [99],
    });
    createEmbedGuest({
      self: guestEnd.self,
      peer: { postMessage: (data) => hostEnd.deliver(data, 'https://guest.test') },
      hostOrigin: 'https://host.test',
      version: [1],
    });
    await expect(host.handshake()).rejects.toThrow(/no shared protocol version/);
  });

  it('ignores a message from the wrong origin and counts the rejection', () => {
    const hostEnd = makeEndpoint('https://notion.so');
    const host = createEmbedHost({
      self: hostEnd.self,
      peer: { postMessage: () => undefined },
      guestOrigin: 'https://embed.onegrid.dev',
      hostOrigin: 'https://notion.so',
    });
    const seen: EmbedMessage[] = [];
    host.on('row-selected', (m) => seen.push(m));

    // Byte-identical payloads; only the delivering origin differs.
    const payload = {
      channel: EMBED_CHANNEL,
      id: 'msg-1',
      type: 'row-selected',
      rowId: 'r9',
      rowIndex: 9,
    };
    hostEnd.deliver(payload, 'https://evil.example');
    expect(seen).toHaveLength(0);
    expect(host.rejectedCount).toBe(1);

    // A near-miss origin — same host, wrong scheme — is still wrong.
    hostEnd.deliver(payload, 'http://embed.onegrid.dev');
    expect(seen).toHaveLength(0);
    expect(host.rejectedCount).toBe(2);

    // The trusted origin gets through, proving the payload itself was fine.
    hostEnd.deliver(payload, 'https://embed.onegrid.dev');
    expect(seen).toHaveLength(1);
    expect(host.rejectedCount).toBe(2);
    host.dispose();
  });

  it('ignores a host-impersonating message on the guest side too', async () => {
    const guestEnd = makeEndpoint('https://embed.onegrid.dev');
    const guest = createEmbedGuest({
      self: guestEnd.self,
      peer: { postMessage: () => undefined },
      hostOrigin: 'https://notion.so',
    });
    const seen: EmbedMessage[] = [];
    guest.on('theme-change', (m) => seen.push(m));
    // A page that framed the guest and is driving it from another origin.
    guestEnd.deliver(
      { channel: EMBED_CHANNEL, id: 'x', type: 'theme-change', theme: 'dark' },
      'https://evil.example',
    );
    expect(seen).toHaveLength(0);
    expect(guest.rejectedCount).toBe(1);
    // A handshake from the wrong origin must not connect the guest either.
    guestEnd.deliver(
      { channel: EMBED_CHANNEL, id: 'h', type: 'handshake', version: [2], hostOrigin: 'https://evil.example' },
      'https://evil.example',
    );
    await expect(guest.whenConnected(10)).rejects.toThrow(/no handshake within/);
    guest.dispose();
  });

  it('drops untagged third-party traffic without counting it as a rejection', async () => {
    const hostEnd = makeEndpoint('https://notion.so');
    const host = createEmbedHost({
      self: hostEnd.self,
      peer: { postMessage: () => undefined },
      guestOrigin: 'https://embed.onegrid.dev',
      hostOrigin: 'https://notion.so',
    });
    const seen: EmbedMessage[] = [];
    host.on('ready', (m) => seen.push(m));
    // Right origin, someone else's protocol — not ours, not an attack.
    hostEnd.deliver({ source: 'react-devtools', payload: 1 }, 'https://embed.onegrid.dev');
    expect(seen).toHaveLength(0);
    expect(host.rejectedCount).toBe(0);
    await Promise.resolve();
    host.dispose();
  });

  it('never posts with a wildcard target origin', async () => {
    const { host, guest, hostEnd, guestEnd } = connect('https://notion.so', 'https://embed.onegrid.dev');
    await host.handshake();
    guest.reportHeight(512);
    expect(hostEnd.sent.length).toBeGreaterThan(0);
    expect(guestEnd.sent.length).toBeGreaterThan(0);
    for (const s of [...hostEnd.sent, ...guestEnd.sent]) expect(s.targetOrigin).not.toBe('*');
    expect(hostEnd.sent.every((s) => s.targetOrigin === 'https://embed.onegrid.dev')).toBe(true);
    expect(guestEnd.sent.every((s) => s.targetOrigin === 'https://notion.so')).toBe(true);
    host.dispose();
    guest.dispose();
  });

  it('correlates concurrent request/response pairs by id', async () => {
    const { host, guest } = connect('https://notion.so', 'https://embed.onegrid.dev');
    await host.handshake();

    // The guest answers each theme-change with an ack echoing the theme, after
    // a delay inverted relative to arrival order, so a correlation bug would
    // hand back the wrong answer.
    const delayByTheme: Record<string, number> = { light: 30, dark: 5 };
    guest.on('theme-change', (m) => {
      if (m.type !== 'theme-change') return;
      const theme = m.theme as string;
      setTimeout(() => {
        guest.reply(m, { type: 'ready', blockId: `applied:${theme}` });
      }, delayByTheme[theme] ?? 0);
    });

    const [first, second] = await Promise.all([
      host.request({ type: 'theme-change', theme: 'light' }),
      host.request({ type: 'theme-change', theme: 'dark' }),
    ]);
    expect(first.type).toBe('ready');
    expect((first as { blockId: string }).blockId).toBe('applied:light');
    expect((second as { blockId: string }).blockId).toBe('applied:dark');
    host.dispose();
    guest.dispose();
  });

  it('rejects a request that is never answered', async () => {
    const hostEnd = makeEndpoint('https://notion.so');
    const host = createEmbedHost({
      self: hostEnd.self,
      peer: { postMessage: () => undefined },
      guestOrigin: 'https://embed.onegrid.dev',
      hostOrigin: 'https://notion.so',
    });
    await expect(host.handshake(10)).rejects.toThrow(/no reply to 'handshake' within 10ms/);
    host.dispose();
  });

  it('carries every message type in the union across the boundary', async () => {
    const { host, guest } = connect('https://notion.so', 'https://embed.onegrid.dev');
    await host.handshake();
    const received: string[] = [];
    for (const type of ['ready', 'resize', 'state-change', 'row-selected', 'edit', 'error'] as const) {
      host.on(type, (m) => received.push(m.type));
    }
    guest.reportReady('blk-1');
    guest.reportHeight(300, 700);
    guest.send({ type: 'state-change', state: { sort: [], filter: null } });
    guest.send({ type: 'row-selected', rowId: 7, rowIndex: 2 });
    guest.send({ type: 'edit', rowId: 7, columnId: 'amount', value: 42 });
    guest.send({ type: 'error', code: 'load-failed', message: 'upstream 503' });
    expect(received).toEqual(['ready', 'resize', 'state-change', 'row-selected', 'edit', 'error']);
    host.dispose();
    guest.dispose();
  });

  it('detaches its listener and rejects pending work on dispose', async () => {
    const hostEnd = makeEndpoint('https://notion.so');
    const host = createEmbedHost({
      self: hostEnd.self,
      peer: { postMessage: () => undefined },
      guestOrigin: 'https://embed.onegrid.dev',
      hostOrigin: 'https://notion.so',
    });
    expect(hostEnd.handlerCount()).toBe(1);
    const pending = host.handshake(5000);
    host.dispose();
    expect(hostEnd.handlerCount()).toBe(0);
    await expect(pending).rejects.toThrow(/disposed before reply/);
    expect(() => host.send({ type: 'ready', blockId: 'x' })).toThrow(/disposed/);
  });

  it('type-guards inbound data by channel tag', () => {
    expect(isEmbedMessage({ channel: EMBED_CHANNEL, id: 'a', type: 'ready' })).toBe(true);
    expect(isEmbedMessage({ channel: 'other', id: 'a', type: 'ready' })).toBe(false);
    expect(isEmbedMessage(null)).toBe(false);
    expect(isEmbedMessage('ready')).toBe(false);
  });
});


// -----------------------------------------------------------------------------
// Auto-resize
// -----------------------------------------------------------------------------

describe('auto-resize', () => {
  it('reports immediately, then debounces a burst into one report', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    let trigger: (() => void) | null = null;
    let height = 100;
    const handle = startAutoResize({
      target: document.createElement('div'),
      report,
      debounceMs: 50,
      measure: () => height,
      observerFactory: (callback) => {
        trigger = callback;
        return { observe: () => undefined, disconnect: () => undefined };
      },
    });
    // The initial report fires synchronously so the host is not stuck at its
    // placeholder height.
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(100);
    expect(handle.usingObserver).toBe(true);

    height = 400;
    for (let i = 0; i < 20; i++) trigger!();
    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(400);
    handle.stop();
  });

  it('suppresses sub-threshold jitter that would otherwise loop', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    let trigger: (() => void) | null = null;
    let height = 300;
    const handle = startAutoResize({
      target: document.createElement('div'),
      report,
      debounceMs: 10,
      thresholdPx: 4,
      measure: () => height,
      observerFactory: (callback) => {
        trigger = callback;
        return { observe: () => undefined, disconnect: () => undefined };
      },
    });
    report.mockClear();
    height = 302; // under the 4px threshold
    trigger!();
    vi.advanceTimersByTime(10);
    expect(report).not.toHaveBeenCalled();
    height = 320; // over it
    trigger!();
    vi.advanceTimersByTime(10);
    expect(report).toHaveBeenCalledWith(320);
    // flush ignores the threshold entirely.
    height = 321;
    handle.flush();
    expect(report).toHaveBeenLastCalledWith(321);
    handle.stop();
  });

  it('falls back to polling when no ResizeObserver exists, and stops cleanly', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    let height = 100;
    const handle = startAutoResize({
      target: document.createElement('div'),
      report,
      debounceMs: 1,
      pollMs: 20,
      measure: () => height,
      observerFactory: null,
    });
    expect(handle.usingObserver).toBe(false);
    report.mockClear();
    height = 250;
    vi.advanceTimersByTime(21);
    vi.advanceTimersByTime(2);
    expect(report).toHaveBeenCalledWith(250);
    expect(handle.lastHeight).toBe(250);
    handle.stop();
    report.mockClear();
    height = 900;
    vi.advanceTimersByTime(200);
    expect(report).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Custom element
// -----------------------------------------------------------------------------

describe('<onegrid-embed>', () => {
  it('registers once and is a no-op on a second define', () => {
    expect(defineEmbedElement()).toBe(true);
    expect(customElements.get(ONEGRID_EMBED_TAG_NAME)).toBe(OneGridEmbedElement);
    // A document host may include the bundle once per block; the second call
    // must not throw a NotSupportedError and take the page down.
    expect(() => defineEmbedElement()).not.toThrow();
    expect(defineEmbedElement()).toBe(false);
  });

  it('renders a sandboxed frame from a src attribute and isolates it in shadow DOM', () => {
    defineEmbedElement();
    const el = document.createElement(ONEGRID_EMBED_TAG_NAME) as OneGridEmbedElement;
    el.setAttribute('src', 'https://embed.onegrid.dev/v?b=abc');
    document.body.appendChild(el);
    expect(el.shadowRoot).not.toBeNull();
    const frame = el.shadowRoot!.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('sandbox')).toContain('allow-scripts');
    // Light DOM stays empty — the host page's CSS cannot reach the frame.
    expect(el.children).toHaveLength(0);
    el.remove();
    expect(el.frameElement).toBeNull();
  });

  it('reflects properties to attributes and back', () => {
    defineEmbedElement();
    const el = document.createElement(ONEGRID_EMBED_TAG_NAME) as OneGridEmbedElement;
    el.src = 'https://embed.onegrid.dev/v';
    el.height = 640;
    el.theme = 'dark';
    expect(el.getAttribute('src')).toBe('https://embed.onegrid.dev/v');
    expect(el.getAttribute('height')).toBe('640');
    expect(el.getAttribute('theme')).toBe('dark');
    expect(el.height).toBe(640);
    expect(el.theme).toBe('dark');
    el.src = null;
    expect(el.hasAttribute('src')).toBe(false);
    // Defaults when unset / unparseable.
    el.removeAttribute('height');
    expect(el.height).toBe(400);
    el.setAttribute('height', 'tall');
    expect(el.height).toBe(400);
  });

  it('decodes a block attribute and rebuilds the frame when it changes', () => {
    defineEmbedElement();
    const el = document.createElement(ONEGRID_EMBED_TAG_NAME) as OneGridEmbedElement;
    const block = sampleBlock();
    el.setAttribute('viewer', 'https://embed.onegrid.dev/v');
    el.block = encodeBlockUrl(block);
    el.setAttribute('theme', 'dark');
    document.body.appendChild(el);

    expect(el.decodedBlock).toEqual(block);
    const first = el.frameElement;
    expect(first!.src).toContain('https://embed.onegrid.dev/v?b=');
    expect(first!.src).toContain('theme=dark');
    expect(first!.style.height).toBe('400px');

    el.height = 700;
    const second = el.frameElement;
    expect(second).not.toBe(first);
    expect(second!.style.height).toBe('700px');
    expect(el.shadowRoot!.querySelectorAll('iframe')).toHaveLength(1);
    el.remove();
  });

  it('surfaces a readable error instead of throwing during upgrade', () => {
    defineEmbedElement();
    const el = document.createElement(ONEGRID_EMBED_TAG_NAME) as OneGridEmbedElement;
    document.body.appendChild(el);
    expect(el.errorMessage).toMatch(/needs a `src` or a `block` attribute/);
    expect(el.shadowRoot!.querySelector('.error')?.textContent).toContain('src');

    el.setAttribute('block', 'not!valid!base64url');
    expect(el.errorMessage).toMatch(/illegal character/);
    expect(el.decodedBlock).toBeNull();
    expect(el.frameElement).toBeNull();
    el.remove();
  });
});

// -----------------------------------------------------------------------------
// oEmbed + Open Graph
// -----------------------------------------------------------------------------

describe('oEmbed', () => {
  it('produces a spec-correct rich payload with every required field', () => {
    const response = oembedResponse(sampleBlock(), {
      viewerUrl: 'https://embed.onegrid.dev/v',
      width: 800,
      height: 500,
      providerName: 'oneGrid',
      providerUrl: 'https://onegrid.dev',
    });
    // Required of every oEmbed response.
    expect(response.version).toBe('1.0');
    expect(response.type).toBe('rich');
    // Required specifically of `rich`.
    expect(typeof response.html).toBe('string');
    expect(response.width).toBe(800);
    expect(response.height).toBe(500);
    expect(response.title).toBe('Quarterly revenue');
    expect(response.provider_name).toBe('oneGrid');
    expect(response.provider_url).toBe('https://onegrid.dev');
    expect(response.cache_age).toBe(3600);
    // The html must be a sandboxed iframe sharing the DOM path's allowlist.
    expect(response.html).toContain('<iframe');
    expect(response.html).toContain(`sandbox="${EMBED_SANDBOX_TOKEN.join(' ')}"`);
    expect(response.html).not.toContain('allow-same-origin');
    expect(response.html).toContain('https://embed.onegrid.dev/v?b=');
    // The payload must survive JSON transport verbatim.
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('omits optional fields it was not given, and includes the ones it was', () => {
    const bare = oembedResponse(sampleBlock(), { viewerUrl: 'https://e/v' });
    expect('thumbnail_url' in bare).toBe(false);
    expect('author_name' in bare).toBe(false);
    const full = oembedResponse(sampleBlock(), {
      viewerUrl: 'https://e/v',
      authorName: 'Mar',
      authorUrl: 'https://example.com/mar',
      thumbnailUrl: 'https://e/thumb.png',
      thumbnailWidth: 640,
      thumbnailHeight: 360,
      cacheAgeSecond: 60,
    });
    expect(full.author_name).toBe('Mar');
    expect(full.thumbnail_url).toBe('https://e/thumb.png');
    expect(full.thumbnail_width).toBe(640);
    expect(full.cache_age).toBe(60);
  });

  it('titles an untitled block from its shape rather than leaving it blank', () => {
    const block = createBlock({
      id: 'x',
      source: { kind: 'named', ref: 'k' },
      column: [{ id: 'a' }, { id: 'b' }],
    });
    expect(oembedResponse(block, { viewerUrl: 'https://e/v' }).title).toBe(
      'oneGrid table (2 columns)',
    );
  });

  it('escapes a hostile title out of the iframe attribute', () => {
    const html = embedIframeHtml('https://e/v?b=x', {
      width: 100,
      height: 100,
      title: '" onload="alert(1)',
    });
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain('&quot; onload=&quot;alert(1)');
  });
});

describe('Open Graph tags', () => {
  it('puts og keys on property and twitter keys on name', () => {
    const tag = embedMetaTag(sampleBlock(), { viewerUrl: 'https://embed.onegrid.dev/v' });
    const byKey = new Map(tag.map((t) => [t.key, t]));
    expect(byKey.get('og:title')!.attribute).toBe('property');
    expect(byKey.get('og:type')!.content).toBe('website');
    expect(byKey.get('og:video:type')!.content).toBe('text/html');
    // Twitter's validator silently ignores `property`; these must be `name`.
    expect(byKey.get('twitter:title')!.attribute).toBe('name');
    expect(byKey.get('twitter:card')!.content).toBe('summary_large_image');
    expect(byKey.get('og:description')!.content).toContain('sorted by amount');
  });

  it('upgrades to a player card when a thumbnail is available', () => {
    const tag = embedMetaTag(sampleBlock(), {
      viewerUrl: 'https://embed.onegrid.dev/v',
      thumbnailUrl: 'https://e/t.png',
      width: 900,
    });
    const byKey = new Map(tag.map((t) => [t.key, t]));
    expect(byKey.get('twitter:card')!.content).toBe('player');
    expect(byKey.get('twitter:player')!.content).toContain('b=');
    expect(byKey.get('twitter:player:width')!.content).toBe('900');
    expect(byKey.get('og:image')!.content).toBe('https://e/t.png');
  });

  it('renders tags plus an oEmbed discovery link', () => {
    const html = renderEmbedMetaTag(
      embedMetaTag(sampleBlock(), { viewerUrl: 'https://embed.onegrid.dev/v' }),
      { oembedEndpoint: 'https://onegrid.dev/oembed?url=x&format=json' },
    );
    expect(html).toContain('<meta property="og:title" content="Quarterly revenue">');
    expect(html).toContain('type="application/json+oembed"');
    expect(html).toContain('&amp;format=json');
  });
});

// -----------------------------------------------------------------------------
// Capability negotiation
// -----------------------------------------------------------------------------

describe('negotiateCapability', () => {
  it('gives the richest plan to a fully capable host', () => {
    const plan = negotiateCapability({ name: 'Notion', script: true, iframe: true, postMessage: true });
    expect(plan.mode).toBe('interactive');
    expect(plan.useMessageChannel).toBe(true);
    expect(plan.useAutoResize).toBe(true);
    expect(plan.persistState).toBe(true);
    expect(plan.statePlacement).toBe('storage');
    expect(plan.reason).toEqual([]);
  });

  it('treats an unspecified capability as permitted', () => {
    expect(negotiateCapability({}).mode).toBe('interactive');
  });

  it('degrades to a static frame when the host forbids scripts', () => {
    const plan = negotiateCapability({ iframe: true, script: false });
    expect(plan.mode).toBe('static');
    expect(plan.useMessageChannel).toBe(false);
    expect(plan.useAutoResize).toBe(false);
    expect(plan.reason.join(' ')).toMatch(/forbids scripts/);
  });

  it('degrades to inline mounting when the host forbids iframes', () => {
    const plan = negotiateCapability({ iframe: false, script: true });
    expect(plan.mode).toBe('inline');
    expect(plan.statePlacement).toBe('storage');
    expect(plan.reason.join(' ')).toMatch(/forbids iframes/);
  });

  it('falls all the way back to an unfurl card when nothing is permitted', () => {
    const plan = negotiateCapability({ iframe: false, script: false, storage: false });
    expect(plan.mode).toBe('link');
    expect(plan.persistState).toBe(false);
    expect(plan.statePlacement).toBe('none');
    expect(plan.useAutoResize).toBe(false);
  });

  it('moves state into the URL when storage is forbidden', () => {
    const plan = negotiateCapability({ storage: false });
    expect(plan.mode).toBe('interactive');
    expect(plan.persistState).toBe(false);
    expect(plan.statePlacement).toBe('url');
    expect(plan.reason.join(' ')).toMatch(/forbids storage/);
  });

  it('disables auto-resize for a host that will not act on it, and clamps height', () => {
    const plan = negotiateCapability(
      { resize: false, maxHeightPx: 240 },
      { preferredHeightPx: 800 },
    );
    expect(plan.useMessageChannel).toBe(true);
    expect(plan.useAutoResize).toBe(false);
    expect(plan.heightPx).toBe(240);
    expect(plan.reason.join(' ')).toMatch(/caps embed height at 240px/);
    // An uncapped host keeps the preferred height.
    expect(negotiateCapability({}, { preferredHeightPx: 800 }).heightPx).toBe(800);
  });
});
