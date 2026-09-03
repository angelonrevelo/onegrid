// =============================================================================
// @onegrid/embed
//
// Makes a oneGrid instance embeddable as a self-contained BLOCK inside a
// third-party document host — Notion, Coda, Obsidian, a wiki, a CMS. There are
// exactly three mechanisms such hosts use to embed foreign content, and this
// package covers all three rather than picking one:
//
//   1. An IFRAME the host drops into the page. `createEmbedFrame` builds it
//      with a justified sandbox allowlist, and `createEmbedHost` /
//      `createEmbedGuest` speak an origin-checked postMessage protocol across
//      the boundary so the block can report its height and its events.
//   2. A CUSTOM ELEMENT the host renders from pasted HTML. `<onegrid-embed>`
//      needs no build step: one script tag and one element.
//   3. An UNFURL. When someone pastes a link, the host calls an oEmbed endpoint
//      or scrapes Open Graph tags and decides from that response alone whether
//      to render a block. `oembedResponse` and `embedMetaTag` produce those.
//
// Underneath all three sits one idea: the block is DATA, not a live object. An
// `EmbedBlock` is versioned JSON carrying the data source reference, the column
// set, the sort / filter / group state, the theme and the preset — everything
// needed to reconstitute the grid and nothing that cannot survive a round trip
// through a host's document store. Because that JSON outlives the code that
// wrote it, reading is always `migrateBlock`, never a cast, and the migration
// ladder is a first-class part of the surface.
//
// Design decisions worth knowing before you use it:
//
//   - The guest MUST be served from a different origin than the host. The
//     sandbox omits `allow-same-origin` (see frame.ts), which is what makes the
//     sandbox meaningful and what makes the origin check on the postMessage
//     channel worth performing.
//   - No `'*'` target origin exists anywhere in this package. `MessagePoster`
//     requires an explicit origin at the type level.
//   - Nothing assumes a capability. `negotiateCapability` takes what the host
//     says it permits and returns the richest achievable mode, with a written
//     reason for every downgrade.
//   - Zero runtime dependencies beyond `@onegrid/protocol` types. base64url is
//     implemented here rather than via `btoa` (which cannot encode non-ASCII)
//     or `Buffer` (which does not exist in a browser).
// =============================================================================

// -----------------------------------------------------------------------------
// Block descriptor + migration
// -----------------------------------------------------------------------------

export {
  assertBlock,
  BLOCK_SCHEMA_VERSION,
  createBlock,
  deserializeBlock,
  detectBlockVersion,
  migrateBlock,
  serializeBlock,
} from './block';

export type {
  AnyEmbedBlock,
  EmbedBlock,
  EmbedBlockV1,
  EmbedBlockV2,
  EmbedColumn,
  EmbedSourceRef,
  EmbedTheme,
  EmbedViewState,
} from './block';

// -----------------------------------------------------------------------------
// URL-safe encoding
// -----------------------------------------------------------------------------

export {
  buildEmbedUrl,
  decodeBlockUrl,
  encodeBlockUrl,
  fromBase64Url,
  MAX_BLOCK_URL_LENGTH,
  measureBlockUrlLength,
  parseEmbedUrl,
  toBase64Url,
} from './url';

export type { EncodeBlockUrlOption } from './url';

// -----------------------------------------------------------------------------
// iframe
// -----------------------------------------------------------------------------

export {
  createEmbedFrame,
  EMBED_ALLOW_POLICY,
  EMBED_SANDBOX_TOKEN,
  frameOrigin,
} from './frame';

export type { CreateEmbedFrameOption } from './frame';

// -----------------------------------------------------------------------------
// postMessage protocol
// -----------------------------------------------------------------------------

export {
  createEmbedGuest,
  createEmbedHost,
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  EMBED_SUPPORTED_VERSION,
  isEmbedMessage,
  negotiateVersion,
  nextMessageId,
} from './message';

export type {
  EditMessage,
  EmbedConnection,
  EmbedGuest,
  EmbedGuestOption,
  EmbedHost,
  EmbedHostOption,
  EmbedMessage,
  EmbedMessageBase,
  EmbedMessageInit,
  EmbedMessageType,
  EmbedReplyInit,
  ErrorMessage,
  HandshakeAckMessage,
  HandshakeMessage,
  MessageListenerTarget,
  MessagePoster,
  ReadyMessage,
  ResizeMessage,
  RowSelectedMessage,
  StateChangeMessage,
  ThemeChangeMessage,
} from './message';

// -----------------------------------------------------------------------------
// Auto-resize
// -----------------------------------------------------------------------------

export { startAutoResize } from './resize';

export type {
  AutoResizeHandle,
  AutoResizeOption,
  ResizeObserverFactory,
  ResizeObserverLike,
} from './resize';

// -----------------------------------------------------------------------------
// Web component
// -----------------------------------------------------------------------------

export { defineEmbedElement, ONEGRID_EMBED_TAG_NAME, OneGridEmbedElement } from './element';

// -----------------------------------------------------------------------------
// oEmbed + Open Graph
// -----------------------------------------------------------------------------

export {
  embedIframeHtml,
  embedMetaTag,
  escapeHtmlAttribute,
  oembedResponse,
  renderEmbedMetaTag,
} from './oembed';

export type {
  EmbedMetaOption,
  EmbedMetaTag,
  OEmbedOption,
  OEmbedRichResponse,
} from './oembed';

// -----------------------------------------------------------------------------
// Host capability negotiation
// -----------------------------------------------------------------------------

export { negotiateCapability } from './capability';

export type {
  CapabilityPlan,
  EmbedMode,
  HostAdvert,
  NegotiateCapabilityOption,
} from './capability';
