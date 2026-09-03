// =============================================================================
// @onegrid/embed — the iframe.
//
// The iframe is the trust boundary. Everything the embedded grid can do to the
// host page passes through the `sandbox` attribute, so the allowlist below is
// the single most security-relevant expression in this package and every token
// is justified inline. The rule applied throughout: a token is present only if
// the grid is functionally broken without it.
//
// The one token deliberately ABSENT is `allow-same-origin`. Granting it, in
// combination with `allow-scripts`, lets the framed document reach into its own
// origin's storage and — if it is served from the host's own origin — remove
// its own sandbox attribute and reload itself unsandboxed. The guest is
// therefore expected to be served from a DIFFERENT origin than the host, which
// is also what makes the postMessage origin check meaningful. If you must serve
// the guest same-origin, you have no sandbox worth the name and should say so
// out loud rather than quietly adding the token.
// =============================================================================

import type { EmbedBlock } from './block';
import { buildEmbedUrl } from './url';

/**
 * The sandbox tokens a oneGrid embed needs, and only those.
 *
 * @public
 */
export const EMBED_SANDBOX_TOKEN: ReadonlyArray<string> = [
  // The grid is a canvas renderer driven by JavaScript. Without scripts there
  // is nothing to embed — this is the one token that is non-negotiable, and it
  // is why `allow-same-origin` must stay off.
  'allow-scripts',
  // Sorting, filtering and cell editing are user gestures inside the frame;
  // without form semantics the guest cannot host an input for cell editing.
  'allow-forms',
  // A cell may contain a link, and clicking it should take the reader
  // somewhere. Scoped to a user activation so the guest cannot navigate the
  // top-level page on its own — a drive-by redirect out of a document host is
  // the classic embedded-content attack.
  'allow-top-navigation-by-user-activation',
  // Deliberately NOT included, and listed here so the omission reads as a
  // decision rather than an oversight:
  //   allow-same-origin  — see the module header; it defeats the sandbox.
  //   allow-popups       — a grid has no reason to open a window.
  //   allow-modals       — alert()/confirm() from an embedded block is abuse.
  //   allow-downloads    — export is routed through the host over postMessage
  //                        so the host decides what lands on the user's disk.
  //   allow-pointer-lock — a data grid never captures the pointer.
];

/**
 * Feature-policy tokens for the `allow` attribute. Kept minimal for the same
 * reason as the sandbox: an embedded table needs no camera, microphone,
 * geolocation or payment access, and stating that explicitly stops a permissive
 * host default from leaking through.
 *
 * @public
 */
export const EMBED_ALLOW_POLICY: ReadonlyArray<string> = [
  // Clipboard write is how "copy selection" works inside the block. Read is NOT
  // granted — an embedded grid has no business reading the user's clipboard.
  'clipboard-write',
  // Fullscreen so a large block can expand out of a narrow document column.
  'fullscreen',
];

/**
 * Options for {@link createEmbedFrame}.
 *
 * @public
 */
export interface CreateEmbedFrameOption {
  /**
   * Viewer URL that renders a block. Either this plus `block`, or a fully
   * formed `src`, must be supplied.
   */
  readonly viewerUrl?: string;
  /** Block to encode into the viewer URL. */
  readonly block?: EmbedBlock;
  /** Fully formed frame URL, used as-is when `viewerUrl` is absent. */
  readonly src?: string;
  /** Query parameter carrying the encoded block. Default `b`. */
  readonly param?: string;
  /** CSS height. Number is treated as px. Default `'400px'`. */
  readonly height?: number | string;
  /** CSS width. Number is treated as px. Default `'100%'`. */
  readonly width?: number | string;
  /** Accessible name for the frame. Default derives from the block title. */
  readonly title?: string;
  /** Document used to create the element. Defaults to the ambient `document`. */
  readonly document?: Document;
  /** Extra sandbox tokens. Appended after the defaults; use sparingly. */
  readonly extraSandboxToken?: ReadonlyArray<string>;
  /** Loading strategy. Default `'lazy'` — a document may hold many blocks. */
  readonly loading?: 'lazy' | 'eager';
}

function cssSize(value: number | string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return typeof value === 'number' ? `${value}px` : value;
}

/**
 * Build the iframe element for a block. Does not attach it — the caller decides
 * where it lands, which keeps this usable from a web component, a React
 * adapter, or a plain script.
 *
 * @public
 */
export function createEmbedFrame(option: CreateEmbedFrameOption): HTMLIFrameElement {
  const doc = option.document ?? (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error('@onegrid/embed: no document available — pass option.document.');
  }

  let src: string;
  if (option.src !== undefined) {
    src = option.src;
  } else if (option.viewerUrl !== undefined && option.block !== undefined) {
    src = buildEmbedUrl(
      option.viewerUrl,
      option.block,
      option.param === undefined ? {} : { param: option.param },
    );
  } else {
    throw new Error('@onegrid/embed: createEmbedFrame needs either `src`, or `viewerUrl` + `block`.');
  }

  const frame = doc.createElement('iframe');
  frame.src = src;
  frame.title = option.title ?? option.block?.title ?? 'oneGrid embedded table';
  frame.loading = option.loading ?? 'lazy';
  frame.setAttribute(
    'sandbox',
    [...EMBED_SANDBOX_TOKEN, ...(option.extraSandboxToken ?? [])].join(' '),
  );
  frame.setAttribute('allow', EMBED_ALLOW_POLICY.join('; '));
  // referrerpolicy: the viewer URL already carries everything the guest needs.
  // Leaking the host document's full URL — often a private workspace page —
  // into the guest's request headers is a data leak with no upside.
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  frame.style.width = cssSize(option.width, '100%');
  frame.style.height = cssSize(option.height, '400px');
  frame.style.border = '0';
  frame.style.display = 'block';
  return frame;
}

/**
 * Origin of a frame's `src`, which is what the host must use as the guest
 * origin in {@link createEmbedHost}. Returns null for a relative or malformed
 * URL — a same-document src has no distinct origin to check against, and the
 * caller must treat that as a configuration error rather than a wildcard.
 *
 * @public
 */
export function frameOrigin(src: string, base?: string): string | null {
  try {
    return new URL(src, base).origin;
  } catch {
    return null;
  }
}
