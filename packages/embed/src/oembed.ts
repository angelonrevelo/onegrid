// =============================================================================
// @onegrid/embed — oEmbed and Open Graph unfurl payloads.
//
// This is the part of the package a document host calls FIRST. When someone
// pastes a oneGrid link into Notion or Coda, the host does not load the page —
// it hits the oEmbed endpoint (or scrapes the OG tags) and decides from that
// response whether to render an interactive block, a preview card, or plain
// link text. Get a required field wrong and the paste degrades to blue
// underlined text, which is indistinguishable to the user from the feature not
// existing.
//
// Two spec details this file gets deliberately right:
//
//   - oEmbed (oembed.com, 1.0) field names are snake_case: `provider_name`,
//     `thumbnail_url`, `cache_age`. This is an external contract, so those keys
//     stay exactly as the spec spells them even though the repo's own naming
//     convention differs. Consumers match on the literal key.
//   - For `type: 'rich'`, the REQUIRED fields are `html`, `width` and `height`,
//     on top of the version + type required of every response. A response
//     missing `width`/`height` is rejected outright by strict consumers, so
//     they are non-optional in the returned type rather than left to the caller.
//
// The returned `html` is an iframe string rather than inline markup. Every
// serious consumer sandboxes what it receives here anyway, and shipping an
// iframe means the same sandbox/allow allowlist that `createEmbedFrame` builds
// applies to the unfurled path too — one security surface, not two.
// =============================================================================

import type { EmbedBlock } from './block';
import { EMBED_ALLOW_POLICY, EMBED_SANDBOX_TOKEN } from './frame';
import { buildEmbedUrl } from './url';

/**
 * A spec-shaped oEmbed `rich` response. Key names follow oEmbed 1.0 exactly —
 * this is an external contract, not repo-internal surface.
 *
 * @public
 */
export interface OEmbedRichResponse {
  readonly type: 'rich';
  readonly version: '1.0';
  /** Required for `rich`. */
  readonly html: string;
  /** Required for `rich`. */
  readonly width: number;
  /** Required for `rich`. */
  readonly height: number;
  readonly title?: string;
  readonly provider_name?: string;
  readonly provider_url?: string;
  readonly author_name?: string;
  readonly author_url?: string;
  readonly thumbnail_url?: string;
  readonly thumbnail_width?: number;
  readonly thumbnail_height?: number;
  /** Seconds the consumer may cache this response. */
  readonly cache_age?: number;
}

/**
 * Options for {@link oembedResponse}.
 *
 * @public
 */
export interface OEmbedOption {
  /** Viewer URL that renders a block; the block is encoded onto it. */
  readonly viewerUrl: string;
  readonly width?: number;
  readonly height?: number;
  readonly providerName?: string;
  readonly providerUrl?: string;
  readonly authorName?: string;
  readonly authorUrl?: string;
  readonly thumbnailUrl?: string;
  readonly thumbnailWidth?: number;
  readonly thumbnailHeight?: number;
  /** Seconds. Default 3600 — long enough to matter, short enough to fix a bad unfurl. */
  readonly cacheAgeSecond?: number;
  /** Query parameter carrying the encoded block. Default `b`. */
  readonly param?: string;
}

/**
 * Escape for an HTML attribute value. Blocks carry user-authored titles, and a
 * title is interpolated into the iframe markup below; without escaping, a
 * column header containing a quote breaks out of the attribute.
 *
 * @public
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the iframe markup an oEmbed consumer will inject. Shares the sandbox
 * and allow allowlist with {@link createEmbedFrame} so the DOM path and the
 * unfurl path cannot drift apart.
 *
 * @public
 */
export function embedIframeHtml(
  src: string,
  option: { readonly width: number; readonly height: number; readonly title: string },
): string {
  return (
    `<iframe src="${escapeHtmlAttribute(src)}"` +
    ` width="${option.width}" height="${option.height}"` +
    ` title="${escapeHtmlAttribute(option.title)}"` +
    ` sandbox="${EMBED_SANDBOX_TOKEN.join(' ')}"` +
    ` allow="${EMBED_ALLOW_POLICY.join('; ')}"` +
    ' referrerpolicy="strict-origin-when-cross-origin"' +
    ' loading="lazy" frameborder="0" style="border:0;display:block"></iframe>'
  );
}

/**
 * Produce the oEmbed `rich` payload a document host receives when it unfurls a
 * oneGrid link.
 *
 * @public
 */
export function oembedResponse(block: EmbedBlock, option: OEmbedOption): OEmbedRichResponse {
  const width = option.width ?? 720;
  const height = option.height ?? 400;
  const title = block.title ?? `oneGrid table (${block.column.length} columns)`;
  const src = buildEmbedUrl(
    option.viewerUrl,
    block,
    option.param === undefined ? {} : { param: option.param },
  );
  return {
    type: 'rich',
    version: '1.0',
    html: embedIframeHtml(src, { width, height, title }),
    width,
    height,
    title,
    provider_name: option.providerName ?? 'oneGrid',
    provider_url: option.providerUrl ?? 'https://onegrid.dev',
    cache_age: option.cacheAgeSecond ?? 3600,
    ...(option.authorName === undefined ? {} : { author_name: option.authorName }),
    ...(option.authorUrl === undefined ? {} : { author_url: option.authorUrl }),
    ...(option.thumbnailUrl === undefined ? {} : { thumbnail_url: option.thumbnailUrl }),
    ...(option.thumbnailWidth === undefined ? {} : { thumbnail_width: option.thumbnailWidth }),
    ...(option.thumbnailHeight === undefined ? {} : { thumbnail_height: option.thumbnailHeight }),
  };
}

/**
 * One `<meta>` tag as a pair of attributes. Open Graph keys go on `property`,
 * Twitter keys on `name` — a difference every generator gets wrong at least
 * once, and Twitter's card validator silently ignores `property`.
 *
 * @public
 */
export interface EmbedMetaTag {
  readonly attribute: 'property' | 'name';
  readonly key: string;
  readonly content: string;
}

/**
 * Options for {@link embedMetaTag}.
 *
 * @public
 */
export interface EmbedMetaOption extends OEmbedOption {
  /** Canonical page URL for the block. Falls back to the encoded viewer URL. */
  readonly canonicalUrl?: string;
  /** Absolute URL of the oEmbed endpoint, emitted as a discovery link. */
  readonly oembedEndpoint?: string;
  readonly siteName?: string;
  readonly description?: string;
}

/**
 * Build the Open Graph + Twitter card tag set for a block. `og:type` is
 * `website` rather than `article` because a block is a live view, not a
 * document; `twitter:card` is `player` when a thumbnail is present, since that
 * is the only Twitter card type that renders an embedded iframe, and
 * `summary_large_image` otherwise.
 *
 * @public
 */
export function embedMetaTag(block: EmbedBlock, option: EmbedMetaOption): ReadonlyArray<EmbedMetaTag> {
  const width = option.width ?? 720;
  const height = option.height ?? 400;
  const title = block.title ?? `oneGrid table (${block.column.length} columns)`;
  const src = buildEmbedUrl(
    option.viewerUrl,
    block,
    option.param === undefined ? {} : { param: option.param },
  );
  const canonical = option.canonicalUrl ?? src;
  const description =
    option.description ??
    `An interactive oneGrid table with ${block.column.length} columns${
      block.state.sort.length > 0 ? `, sorted by ${block.state.sort[0]!.columnId}` : ''
    }.`;

  const tag: EmbedMetaTag[] = [
    { attribute: 'property', key: 'og:type', content: 'website' },
    { attribute: 'property', key: 'og:title', content: title },
    { attribute: 'property', key: 'og:description', content: description },
    { attribute: 'property', key: 'og:url', content: canonical },
    { attribute: 'property', key: 'og:site_name', content: option.siteName ?? option.providerName ?? 'oneGrid' },
    // og:video:* is what makes an embedded, playable/interactive frame appear
    // on the crawlers that support it; the iframe URL doubles as the player.
    { attribute: 'property', key: 'og:video:url', content: src },
    { attribute: 'property', key: 'og:video:type', content: 'text/html' },
    { attribute: 'property', key: 'og:video:width', content: String(width) },
    { attribute: 'property', key: 'og:video:height', content: String(height) },
    { attribute: 'name', key: 'twitter:title', content: title },
    { attribute: 'name', key: 'twitter:description', content: description },
  ];

  if (option.thumbnailUrl !== undefined) {
    tag.push({ attribute: 'property', key: 'og:image', content: option.thumbnailUrl });
    tag.push({ attribute: 'name', key: 'twitter:card', content: 'player' });
    tag.push({ attribute: 'name', key: 'twitter:image', content: option.thumbnailUrl });
    tag.push({ attribute: 'name', key: 'twitter:player', content: src });
    tag.push({ attribute: 'name', key: 'twitter:player:width', content: String(width) });
    tag.push({ attribute: 'name', key: 'twitter:player:height', content: String(height) });
  } else {
    tag.push({ attribute: 'name', key: 'twitter:card', content: 'summary_large_image' });
  }

  return tag;
}

/**
 * Render a tag set to HTML, plus the oEmbed discovery `<link>` when an endpoint
 * is supplied. Discovery is what lets a host that has never heard of oneGrid
 * find the oEmbed endpoint from the page alone.
 *
 * @public
 */
export function renderEmbedMetaTag(
  tag: ReadonlyArray<EmbedMetaTag>,
  option: { readonly oembedEndpoint?: string; readonly title?: string } = {},
): string {
  const line = tag.map(
    (t) => `<meta ${t.attribute}="${escapeHtmlAttribute(t.key)}" content="${escapeHtmlAttribute(t.content)}">`,
  );
  if (option.oembedEndpoint !== undefined) {
    const title = escapeHtmlAttribute(option.title ?? 'oneGrid embed');
    line.push(
      `<link rel="alternate" type="application/json+oembed" href="${escapeHtmlAttribute(option.oembedEndpoint)}" title="${title}">`,
    );
  }
  return line.join('\n');
}
