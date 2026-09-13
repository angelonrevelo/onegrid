// =============================================================================
// HTTP SSRM transport
//
// Plain `fetch`-based transport. Four endpoints:
//
//   GET  ${baseUrl}/schema                        → Schema
//   POST ${baseUrl}/block      body: BlockRequest    → BlockResponse<'json'>
//   POST ${baseUrl}/distinct   body: DistinctRequest → DistinctResult
//   POST ${baseUrl}/mutate     body: Mutation[]      → MutationResult
//
// Subscribe is not supported over HTTP — for live updates use the
// WebSocket transport. AbortController integration via `opts.signal`.
// A server without `/distinct` (404) reads as `{ kind: 'unsupported' }`
// rather than an error, so older servers keep working.
//
// Designed for:
//   - localhost development against a mock server
//   - serverless / edge deployments where WebSocket is awkward
//   - any HTTP-fronted backend that already speaks JSON
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  DistinctRequest,
  DistinctResult,
  FetchOptions,
  Mutation,
  MutationResult,
  Schema,
} from '@onegrid/protocol';
import type { SsrmTransport } from '../types';

export interface HttpTransportOptions {
  /** Base URL, e.g. "http://localhost:3001". No trailing slash. */
  readonly baseUrl: string;
  /** Optional path prefix (default: ""). */
  readonly basePath?: string;
  /** Extra headers (auth tokens, etc.). */
  readonly headers?: Record<string, string>;
  /** Default fetch implementation override (e.g. for SSR). */
  readonly fetchImpl?: typeof fetch;
}

export function createHttpTransport(options: HttpTransportOptions): SsrmTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = `${options.baseUrl}${options.basePath ?? ''}`;
  // Accept both JSON and the canonical Apache Arrow IPC stream MIME
  // (Arrow Project: https://arrow.apache.org/docs/format/IPC.html).
  // The server picks per-request; the response's Content-Type tells us
  // how to parse the body.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, application/vnd.apache.arrow.stream',
    ...options.headers,
  };

  async function schema(): Promise<Schema> {
    const res = await fetchImpl(`${base}/schema`, { headers });
    if (!res.ok) throw new Error(`@onegrid/ssrm http: schema ${String(res.status)}`);
    return (await res.json()) as Schema;
  }

  async function request(req: BlockRequest, opts?: FetchOptions): Promise<BlockResponse> {
    const res = await fetchImpl(`${base}/block`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: opts?.signal ?? null,
    });
    if (!res.ok) throw new Error(`@onegrid/ssrm http: block ${String(res.status)}`);
    // Sniff Content-Type to dispatch JSON vs Arrow IPC. The Arrow
    // path returns a BlockResponse<'arrow-ipc'> whose `rows` is the
    // raw IPC byte stream; the row source's decoder unpacks it.
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/vnd.apache.arrow.stream')) {
      const buf = await res.arrayBuffer();
      // Cursors / totalRowCount come from response headers when the
      // body is binary (no room in the bytes for protocol metadata).
      const nextCursor = res.headers.get('x-onegrid-next-cursor');
      const prevCursor = res.headers.get('x-onegrid-prev-cursor');
      const totalRowCountHeader = res.headers.get('x-onegrid-total-row-count');
      return {
        encoding: 'arrow-ipc',
        rows: new Uint8Array(buf),
        nextCursor: nextCursor && nextCursor.length > 0 ? nextCursor : null,
        prevCursor: prevCursor && prevCursor.length > 0 ? prevCursor : null,
        ...(totalRowCountHeader !== null
          ? { totalRowCount: Number(totalRowCountHeader) }
          : {}),
      } as BlockResponse<'arrow-ipc'>;
    }
    return (await res.json()) as BlockResponse<'json'>;
  }

  async function distinct(req: DistinctRequest, opts?: FetchOptions): Promise<DistinctResult> {
    const res = await fetchImpl(`${base}/distinct`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: opts?.signal ?? null,
    });
    if (res.status === 404) {
      return { kind: 'unsupported', reason: 'the server has no /distinct endpoint' };
    }
    if (!res.ok) throw new Error(`@onegrid/ssrm http: distinct ${String(res.status)}`);
    return (await res.json()) as DistinctResult;
  }

  async function mutate(
    mutations: ReadonlyArray<Mutation>,
    opts?: FetchOptions,
  ): Promise<MutationResult> {
    const res = await fetchImpl(`${base}/mutate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(mutations),
      signal: opts?.signal ?? null,
    });
    if (!res.ok) throw new Error(`@onegrid/ssrm http: mutate ${String(res.status)}`);
    return (await res.json()) as MutationResult;
  }

  return { request, schema, mutate, distinct };
}
