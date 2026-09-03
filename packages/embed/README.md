# @onegrid/embed

Drop a oneGrid into a third-party document host — Notion, Coda, Obsidian, a
wiki, a CMS — as a self-contained **block**.

Document hosts embed foreign content through exactly three mechanisms, and this
package covers all three rather than picking one:

| Mechanism          | What the host does                                    | What you use                                   |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------- |
| **iframe**         | Drops a frame into the page                            | `createEmbedFrame` + `createEmbedHost/Guest`   |
| **custom element** | Renders pasted HTML                                    | `<onegrid-embed>` / `defineEmbedElement()`     |
| **unfurl**         | Pastes a link, then calls oEmbed / scrapes OG tags     | `oembedResponse` / `embedMetaTag`              |

Underneath all three sits one idea: **the block is data, not a live object.** An
`EmbedBlock` is versioned JSON carrying the data-source reference, the column
set, the sort / filter / group state, the theme and the preset — everything
needed to reconstitute the grid, and nothing that cannot survive a round trip
through a host's document store.

## Why it exists

An embedded block outlives the code that wrote it. Someone pastes a link into a
page today and opens that page in three years; the descriptor sitting in the
host's document is frozen at whatever shape you emitted the day they pasted it,
while your bundle has been rewritten four times. So reading a descriptor is
always `migrateBlock(raw)` — a ladder of single-step migrations — never a cast,
and the migration chain is a first-class part of the public surface.

## Install

```sh
pnpm add @onegrid/embed
```

Zero runtime dependencies beyond `@onegrid/protocol` types.

## Usage

### Build a block and put it in a link

```ts
import { createBlock, buildEmbedUrl, measureBlockUrlLength } from '@onegrid/embed';

const block = createBlock({
  id: 'q3-revenue',
  title: 'Q3 revenue by region',
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
});

console.log(measureBlockUrlLength(block)); // check before you commit to a link
const url = buildEmbedUrl('https://embed.example.com/v', block);
```

Encoding is unpadded base64url over UTF-8 bytes, so unicode column headers and
titles round-trip. The default ceiling is **4096 encoded characters** — over
that, `encodeBlockUrl` throws rather than emitting a link that truncates
silently in transit. If you are over it, switch `source.kind` to `'named'` so
the link carries a key instead of the data.

### Host side: frame + connection

```ts
import { createEmbedFrame, createEmbedHost, frameOrigin } from '@onegrid/embed';

const frame = createEmbedFrame({ viewerUrl: 'https://embed.example.com/v', block, height: 480 });
document.querySelector('#slot')!.appendChild(frame);

const guestOrigin = frameOrigin(frame.src)!;
const host = createEmbedHost({
  self: window,
  peer: frame.contentWindow!,
  guestOrigin,
  hostOrigin: window.location.origin,
});

host.on('resize', (m) => {
  if (m.type === 'resize') frame.style.height = `${m.height}px`;
});
host.on('row-selected', (m) => console.log('selected', m));

const version = await host.handshake(); // negotiated protocol version
host.send({ type: 'theme-change', theme: 'dark' });
```

The guest **must** be served from a different origin than the host. The sandbox
allowlist deliberately omits `allow-same-origin` — granting it alongside
`allow-scripts` lets the framed document strip its own sandbox — and that
cross-origin separation is also what makes the postMessage origin check
meaningful. No `'*'` target origin exists anywhere in this package;
`MessagePoster` requires an explicit origin at the type level, and a message
arriving from an unexpected origin is dropped before its payload is inspected.

### Guest side: connection + auto-resize

```ts
import { createEmbedGuest, startAutoResize, parseEmbedUrl } from '@onegrid/embed';

const block = parseEmbedUrl(location.href);
const guest = createEmbedGuest({
  self: window,
  peer: window.parent,
  hostOrigin: 'https://notion.so',
});

await guest.whenConnected();       // the host's handshake settled a version
guest.reportReady(block!.id);

const resize = startAutoResize({
  target: document.getElementById('grid')!,
  report: (height) => guest.reportHeight(height),
  debounceMs: 100,
});
// resize.stop() on teardown
```

`startAutoResize` uses `ResizeObserver` where available and falls back to
polling where not; reports are debounced on the trailing edge and suppressed
below a pixel threshold, which is what stops the host↔guest resize feedback
loop.

### Custom element

```html
<script type="module" src="https://embed.example.com/onegrid-embed.js"></script>

<onegrid-embed
  viewer="https://embed.example.com/v"
  block="eyJzY2hlbWFWZXJzaW9uIjoz…"
  theme="dark"
  height="480"
></onegrid-embed>
```

```ts
import { defineEmbedElement } from '@onegrid/embed';
defineEmbedElement(); // safe to call repeatedly — returns false if already defined
```

`src`, `block`, `theme` and `height` are observed attributes and reflected
properties. The frame is rendered into an open shadow root so the host page's
CSS cannot reach it and the embed's cannot leak out.

### Unfurl: oEmbed + Open Graph

```ts
import { oembedResponse, embedMetaTag, renderEmbedMetaTag } from '@onegrid/embed';

// GET /oembed?url=…&format=json
res.json(oembedResponse(block, {
  viewerUrl: 'https://embed.example.com/v',
  width: 800,
  height: 500,
  providerName: 'Acme Data',
  providerUrl: 'https://acme.example',
}));

// …and in the block's own page <head>
const head = renderEmbedMetaTag(
  embedMetaTag(block, { viewerUrl: 'https://embed.example.com/v' }),
  { oembedEndpoint: 'https://acme.example/oembed?url=…&format=json' },
);
```

The oEmbed payload is a spec-shaped `rich` response with `html`, `width` and
`height` present as the spec requires; field names stay snake_case
(`provider_name`, `cache_age`) because that is the external contract consumers
match on. The `html` is an iframe carrying the same sandbox and allow allowlist
as `createEmbedFrame`, so there is one security surface rather than two.

### Degrade to what the host actually allows

```ts
import { negotiateCapability } from '@onegrid/embed';

const plan = negotiateCapability(
  { name: 'strict-wiki', script: false, iframe: true, storage: false },
  { preferredHeightPx: 600 },
);
// plan.mode           → 'static'
// plan.persistState   → false
// plan.statePlacement → 'url'
// plan.reason         → ['Host forbids scripts; …', 'Host forbids storage; …']
```

The ladder is `interactive` → `static` → `inline` → `link`. Every downgrade is
explained in `plan.reason`, so a developer staring at a static card in their
wiki can find out why from one log line instead of bisecting a CSP. An
unspecified capability is treated as permitted — hosts under-report, and
refusing to render because a host forgot to mention iframes would be worse than
trying.

## Migration

```ts
import { migrateBlock, detectBlockVersion, BLOCK_SCHEMA_VERSION } from '@onegrid/embed';

detectBlockVersion(raw);        // 1, 2, 3 — or 0 if it is not a block at all
const block = migrateBlock(raw); // always returns the current shape
```

| Version | Shape |
| ------- | ----- |
| 1 | Bare URL source, column ids only, single optional sort, no filter |
| 2 | Structured columns, multi-column sort, filter; source still a bare URL |
| 3 | Tagged `source` ref (`url` / `named` / `inline`), singular `column`, sort + filter + grouping under `state`, `preset` |

A descriptor from a **future** version throws rather than being partially
interpreted. Silently dropping keys we do not understand would let a host
quietly discard a user's filter and render a grid that lies.

## License

MIT
