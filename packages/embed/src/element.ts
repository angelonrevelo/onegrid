// =============================================================================
// @onegrid/embed — the <onegrid-embed> custom element.
//
// The third embedding mechanism, alongside the raw iframe and the oEmbed
// unfurl: a one-tag drop-in for hosts that render arbitrary HTML but will not
// run a bundler for you. Paste the tag plus one script include and a grid
// appears.
//
// Conventions follow @onegrid/wc's <one-grid> element deliberately: a
// `define…Element(tag?)` function guarded on `customElements.get`, the class
// exported for advanced use, and the tag name exported as a const. Two places
// diverge, each for a reason:
//
//   - This element DOES use shadow DOM, where <one-grid> does not. <one-grid>
//     hosts a canvas that the page is expected to co-style and debug; this one
//     hosts a foreign iframe inside somebody else's document, where the whole
//     point is that the host's CSS cannot reach in and the embed's cannot leak
//     out. Style isolation is the feature.
//   - It is attribute-driven (`src`, `block`, `theme`, `height`) rather than
//     property-driven, because the hosts that need this element are the ones
//     pasting HTML, who have no script context in which to set a property.
//     Properties are still exposed and reflect to their attributes so a script
//     context can drive it too.
// =============================================================================

import type { EmbedBlock, EmbedTheme } from './block';
import { createEmbedFrame } from './frame';
import { decodeBlockUrl } from './url';

/**
 * Default tag for the embed element.
 *
 * @public
 */
export const ONEGRID_EMBED_TAG_NAME = 'onegrid-embed' as const;

const OBSERVED = ['src', 'block', 'theme', 'height', 'viewer'] as const;

/**
 * `<onegrid-embed>` — an embedded oneGrid block as a single custom element.
 *
 * @public
 */
export class OneGridEmbedElement extends HTMLElement {
  static get observedAttributes(): ReadonlyArray<string> {
    return OBSERVED;
  }

  private root: ShadowRoot;
  private frame: HTMLIFrameElement | null = null;
  private lastError: string | null = null;

  constructor() {
    super();
    // `open` rather than `closed`: a closed root would stop the host page from
    // ever inspecting or testing the embed, and buys no real security — the
    // isolation that matters here is the iframe's, not the shadow root's.
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // :host display defaults to inline, which would collapse the block to zero
    // height in most documents. Everything else is deliberately minimal — the
    // frame owns its own presentation.
    style.textContent =
      ':host{display:block;width:100%;contain:content}' +
      ':host([hidden]){display:none}' +
      'iframe{width:100%;border:0;display:block}' +
      '.error{font:13px/1.4 system-ui,sans-serif;padding:8px 10px;color:#b42318}';
    this.root.appendChild(style);
  }

  /** Fully formed viewer URL. Reflects to the `src` attribute. */
  get src(): string | null {
    return this.getAttribute('src');
  }

  set src(value: string | null) {
    if (value === null) this.removeAttribute('src');
    else this.setAttribute('src', value);
  }

  /** base64url-encoded block. Reflects to the `block` attribute. */
  get block(): string | null {
    return this.getAttribute('block');
  }

  set block(value: string | null) {
    if (value === null) this.removeAttribute('block');
    else this.setAttribute('block', value);
  }

  /** Theme name. Reflects to the `theme` attribute. Default `auto`. */
  get theme(): EmbedTheme {
    return (this.getAttribute('theme') as EmbedTheme | null) ?? 'auto';
  }

  set theme(value: EmbedTheme) {
    this.setAttribute('theme', typeof value === 'string' ? value : JSON.stringify(value));
  }

  /** Frame height in px. Reflects to the `height` attribute. Default 400. */
  get height(): number {
    const raw = this.getAttribute('height');
    const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 400;
  }

  set height(value: number) {
    this.setAttribute('height', String(value));
  }

  /** Decoded block, or null when the `block` attribute is absent or invalid. */
  get decodedBlock(): EmbedBlock | null {
    const encoded = this.getAttribute('block');
    if (encoded === null) return null;
    try {
      return decodeBlockUrl(encoded);
    } catch {
      return null;
    }
  }

  /** Live iframe once rendered; null before connection or after an error. */
  get frameElement(): HTMLIFrameElement | null {
    return this.frame;
  }

  /** Last render failure, or null. Surfaced for tests and diagnostics. */
  get errorMessage(): string | null {
    return this.lastError;
  }

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    this.frame?.remove();
    this.frame = null;
  }

  attributeChangedCallback(_name: string, previous: string | null, next: string | null): void {
    // The callback fires during upgrade with previous === next; re-rendering
    // then would tear down a frame that was just built.
    if (previous === next) return;
    if (this.isConnected) this.render();
  }

  private render(): void {
    this.lastError = null;
    this.frame?.remove();
    this.frame = null;
    for (const stale of this.root.querySelectorAll('.error')) stale.remove();

    const src = this.getAttribute('src');
    const encoded = this.getAttribute('block') ?? '';
    if (src === null && encoded === '') {
      this.fail('<onegrid-embed> needs a `src` or a `block` attribute.');
      return;
    }

    try {
      // `src` wins when both are present: an explicit URL is the caller being
      // specific, and silently re-encoding their block over it would discard it.
      const frame =
        src !== null
          ? createEmbedFrame({ src, height: this.height, ...(this.title === '' ? {} : { title: this.title }) })
          : createEmbedFrame({
              viewerUrl: this.getAttribute('viewer') ?? '',
              block: decodeBlockUrl(encoded),
              height: this.height,
            });
      // Theme rides on the frame URL rather than through postMessage so the
      // very first paint is already correct — a block that flashes light before
      // switching to dark is worse than one that takes a moment to appear.
      frame.src = appendTheme(frame.src, this.getAttribute('theme'));
      this.frame = frame;
      this.root.appendChild(frame);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(message: string): void {
    this.lastError = message;
    const node = document.createElement('div');
    node.className = 'error';
    node.textContent = message;
    this.root.appendChild(node);
  }
}

function appendTheme(src: string, theme: string | null): string {
  if (theme === null || theme === '') return src;
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}theme=${encodeURIComponent(theme)}`;
}

/**
 * Register {@link OneGridEmbedElement}. Registering the same tag twice is a
 * no-op rather than a throw — a document host may include the bundle once per
 * block, and `customElements.define` on an already-defined name throws a
 * NotSupportedError that would take the whole page's script down with it.
 * Returns true when this call performed the registration.
 *
 * @public
 */
export function defineEmbedElement(tag: string = ONEGRID_EMBED_TAG_NAME): boolean {
  if (typeof customElements === 'undefined') {
    throw new Error('@onegrid/embed: customElements is not available in this environment.');
  }
  if (customElements.get(tag)) return false;
  customElements.define(tag, OneGridEmbedElement);
  return true;
}
