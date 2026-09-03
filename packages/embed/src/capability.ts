// =============================================================================
// @onegrid/embed — host capability negotiation.
//
// Document hosts are not uniform. Notion runs third-party embeds in a sandboxed
// iframe with scripts; Obsidian's markdown preview will render an iframe but
// several community setups strip scripts; a corporate wiki with a strict CSP
// may forbid frames entirely and only unfurl a link card; a static site
// generator has no runtime at all. A block that assumes the best case renders
// as a blank rectangle in three of those four hosts.
//
// So the embed advertises nothing and asks first. `negotiateCapability` takes
// what the host says it permits and returns the richest MODE that is actually
// achievable, plus the reasons anything was downgraded. Every degradation is
// explained in `reason` so a developer looking at a static card in their wiki
// can find out why in one log line instead of bisecting a CSP.
//
// The ladder, richest to poorest:
//
//   interactive → iframe + scripts + postMessage. Live grid, auto-resize,
//                 events flow back to the host.
//   static      → iframe, no scripts. A server-rendered snapshot of the block;
//                 no resize channel, so the host must size the frame from the
//                 declared height.
//   inline      → no iframe permitted but scripts are. Mount the web component
//                 directly into the host DOM. Loses style isolation guarantees
//                 the frame gave us, so this is below `static` in trust even
//                 though it is more interactive.
//   link        → neither. Emit an oEmbed / Open Graph unfurl card and let the
//                 host render a preview that links out.
// =============================================================================

/**
 * What a host says it permits. Every field is optional and every absent field
 * is treated as PERMITTED — hosts under-report, and refusing to render because
 * a host forgot to mention iframes would be worse than trying and failing.
 * A host that means to forbid something must say so.
 *
 * @public
 */
export interface HostAdvert {
  /** Host name, for diagnostics only. */
  readonly name?: string;
  /** Host will execute script from the embed. */
  readonly script?: boolean;
  /** Host permits an iframe. */
  readonly iframe?: boolean;
  /** Host relays postMessage between the frame and the page. */
  readonly postMessage?: boolean;
  /** Embed may use localStorage / sessionStorage / cookies. */
  readonly storage?: boolean;
  /** Host will resize the frame in response to a resize message. */
  readonly resize?: boolean;
  /** Hard cap on rendered height, px. */
  readonly maxHeightPx?: number;
  /** Protocol versions the host speaks, if it pins any. */
  readonly protocolVersion?: ReadonlyArray<number>;
}

/**
 * Rendering modes, richest to poorest. See the module header for the ladder.
 *
 * @public
 */
export type EmbedMode = 'interactive' | 'static' | 'inline' | 'link';

/**
 * The plan an embed should execute against a given host.
 *
 * @public
 */
export interface CapabilityPlan {
  readonly mode: EmbedMode;
  /** Open a postMessage channel. False in every non-interactive mode. */
  readonly useMessageChannel: boolean;
  /** Run the auto-resize reporter. */
  readonly useAutoResize: boolean;
  /** Persist view state to storage; when false, state must ride in the URL. */
  readonly persistState: boolean;
  /** Where view state survives a reload given what the host allows. */
  readonly statePlacement: 'storage' | 'url' | 'none';
  /** Height to render at, honouring the host's cap. */
  readonly heightPx: number;
  /** Human-readable explanation of every downgrade applied. */
  readonly reason: ReadonlyArray<string>;
}

/**
 * Options for {@link negotiateCapability}.
 *
 * @public
 */
export interface NegotiateCapabilityOption {
  /** Height the embed would like. Default 400. */
  readonly preferredHeightPx?: number;
}

/**
 * Reduce a host's advertised permissions to the richest achievable plan.
 *
 * @public
 */
export function negotiateCapability(
  hostAdvert: HostAdvert,
  option: NegotiateCapabilityOption = {},
): CapabilityPlan {
  const reason: string[] = [];
  // Absent means permitted — see HostAdvert's doc comment.
  const script = hostAdvert.script !== false;
  const iframe = hostAdvert.iframe !== false;
  const canMessage = hostAdvert.postMessage !== false;
  const storage = hostAdvert.storage !== false;
  const hostResize = hostAdvert.resize !== false;

  let mode: EmbedMode;
  if (iframe && script && canMessage) {
    mode = 'interactive';
  } else if (iframe && script && !canMessage) {
    // A frame that runs script but cannot talk to its parent still renders a
    // live grid; it simply cannot report height or emit events. That is the
    // static contract from the host's point of view.
    mode = 'static';
    reason.push('Host does not relay postMessage; the block renders live but cannot report to the host.');
  } else if (iframe && !script) {
    mode = 'static';
    reason.push('Host forbids scripts; falling back to a server-rendered snapshot in a frame.');
  } else if (!iframe && script) {
    mode = 'inline';
    reason.push('Host forbids iframes; mounting inline, which gives up frame-level style and script isolation.');
  } else {
    mode = 'link';
    reason.push('Host permits neither iframes nor scripts; only an oEmbed / Open Graph unfurl card is possible.');
  }

  const useMessageChannel = mode === 'interactive';
  const useAutoResize = useMessageChannel && hostResize;
  if (useMessageChannel && !hostResize) {
    reason.push('Host does not act on resize messages; auto-resize is disabled to avoid pointless traffic.');
  }

  if (!storage) {
    reason.push('Host forbids storage; view state rides in the embed URL instead of persisting.');
  }
  const statePlacement: CapabilityPlan['statePlacement'] =
    storage && mode !== 'link' ? 'storage' : mode === 'link' ? 'none' : 'url';

  const preferred = option.preferredHeightPx ?? 400;
  let heightPx = preferred;
  if (hostAdvert.maxHeightPx !== undefined && hostAdvert.maxHeightPx < preferred) {
    heightPx = hostAdvert.maxHeightPx;
    reason.push(
      `Host caps embed height at ${hostAdvert.maxHeightPx}px; requested ${preferred}px was clamped.`,
    );
  }

  return {
    mode,
    useMessageChannel,
    useAutoResize,
    persistState: storage && mode !== 'link',
    statePlacement,
    heightPx,
    reason,
  };
}
