// =============================================================================
// Elasticsearch CDC by watermark polling.
//
// Elasticsearch has no change stream. There is no equivalent of Postgres's
// logical replication slot or Mongo's oplog-backed `watch()` — the closest
// thing, the `_changes`-style CCR follower API, is a licensed cross-cluster
// feature and replicates whole indices rather than emitting row events. So
// the honest implementation is polling, and the only question is what makes
// the poll correct.
//
// The answer is a monotonic watermark field: `@timestamp` on a time-series
// index, or an application-maintained sequence number. Each poll asks for
// documents whose watermark is strictly greater than the last one seen,
// sorted by watermark ascending with the primary key as tiebreaker, and
// resumes from the last document of the previous batch via `search_after`.
// That gives exactly-once delivery per (watermark, id) pair as long as the
// watermark never goes backwards.
//
// Two failure modes are handled explicitly rather than hidden:
//
//   - Ties at the watermark boundary. Polling with `gt: lastWatermark` drops
//     any document written in the same millisecond as the last one seen but
//     indexed after the poll ran. The adapter therefore resumes with
//     `gte: lastWatermark` plus a `search_after` on `(watermark, id)`, which
//     walks past the already-delivered part of the tie instead of skipping
//     the rest of it.
//   - Insert vs update is not observable. A poll sees a document's current
//     state, not its history. The default classifier reports every change as
//     `update` — an idempotent upsert, which is what a cache merge wants —
//     unless a `createdField` is configured, in which case a document whose
//     creation time equals its watermark is reported as an `insert`.
//
// The adapter conforms structurally to `CdcAdapter` from `@onegrid/ssrm`
// (subscribe / resync / close) so it drops into `RowDiffStream` and
// `bindOrmSync` without an adaptor shim.
// =============================================================================

import type { ResyncRequest, ResyncResponse, RowDiff, Unsubscribe } from '@onegrid/protocol';
import type { ElasticsearchHit, ElasticsearchQueryable } from './datasource';

/** Watermarks must be totally ordered; ES gives us numbers or ISO strings. */
export type Watermark = number | string;

export interface ElasticsearchCdcAdapterOptions {
  readonly client: ElasticsearchQueryable;
  readonly index: string;
  /**
   * Monotonic field the poll orders by — `@timestamp`, `updated_at`, or a
   * sequence counter. It MUST be non-decreasing on every write, or the poll
   * will skip documents permanently.
   */
  readonly watermarkField: string;
  /** Field carrying the document's stable row id. */
  readonly primaryKey: string;
  /**
   * Creation-time field. When supplied, a document whose creation time equals
   * its watermark is reported as an `insert` rather than an `update`.
   */
  readonly createdField?: string;
  /**
   * Field marking a soft delete. When the value is truthy the diff is emitted
   * as `delete`. ES's real deletes are invisible to a poll, so soft deletes
   * are the only deletes CDC can see — this is worth saying out loud rather
   * than pretending the stream is complete.
   */
  readonly softDeleteField?: string;
  /** Documents per poll. Default 500. */
  readonly batchSize?: number;
  /** Poll period in ms. Default 1000. */
  readonly pollIntervalMs?: number;
  /** Resume point from a previous process. */
  readonly startAfter?: Watermark;
  /**
   * Diffs retained in memory for `resync`. A gap larger than this returns
   * `snapshot: true` instead of a partial replay, because a partial replay
   * would leave the client's cache silently wrong. Default 10 000.
   */
  readonly historySize?: number;
  /** Override the change classifier. */
  readonly toRowDiff?: (hit: ElasticsearchHit, version: number) => RowDiff | null;
  /** Injected timers so tests can drive polling without wall-clock waits. */
  readonly scheduler?: CdcScheduler;
  /** Called on a failed poll. Defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/** Timer surface, injectable so tests can drive the loop by hand. */
export interface CdcScheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ElasticsearchCdcAdapter {
  readonly subscribe: (onDiff: (diff: RowDiff) => void) => Unsubscribe;
  readonly resync: (request: ResyncRequest) => Promise<ResyncResponse>;
  readonly close: () => void;
  /** Highest watermark delivered so far. Persist to resume across restarts. */
  readonly lastWatermark: () => Watermark | null;
  /**
   * Run one poll immediately and resolve when its diffs have been dispatched.
   * The interval loop calls this; tests call it directly.
   */
  readonly poll: () => Promise<number>;
}

export function createElasticsearchCdcAdapter(
  options: ElasticsearchCdcAdapterOptions,
): ElasticsearchCdcAdapter {
  const batchSize = options.batchSize ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const historySize = options.historySize ?? 10_000;
  const onError = options.onError ?? ((error: unknown) => { console.error('@onegrid/elasticsearch: CDC poll failed', error); });
  const scheduler: CdcScheduler = options.scheduler ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>); },
  };

  const subscriber = new Set<(diff: RowDiff) => void>();
  const history: RowDiff[] = [];
  let watermark: Watermark | null = options.startAfter ?? null;
  let searchAfter: ReadonlyArray<unknown> | null = null;
  let version = 0;
  let handle: unknown = null;
  let closed = false;
  // A poll that overruns its interval must not be re-entered — two concurrent
  // polls would both read the same watermark and emit every diff twice.
  let inFlight: Promise<number> | null = null;

  const classify = options.toRowDiff ?? ((hit, v) => defaultToRowDiff(hit, v, options));

  async function runPoll(): Promise<number> {
    if (closed) return 0;
    const body: Record<string, unknown> = {
      size: batchSize,
      track_total_hits: false,
      // `gte` is only safe once we also hold a `search_after` that walks past
      // the part of the boundary tie we already delivered. On a cold start
      // from a persisted watermark there is no such anchor, so we use `gt`
      // and accept that a same-instant sibling of the checkpoint is lost —
      // the alternative, re-emitting it, is worse for a non-idempotent
      // consumer.
      query:
        watermark === null
          ? { match_all: {} }
          : {
              bool: {
                filter: [
                  {
                    range: {
                      [options.watermarkField]: searchAfter
                        ? { gte: watermark }
                        : { gt: watermark },
                    },
                  },
                ],
              },
            },
      sort: [
        { [options.watermarkField]: { order: 'asc' } },
        { [options.primaryKey]: { order: 'asc' } },
      ],
    };
    if (searchAfter) body.search_after = [...searchAfter];

    const response = await options.client.search({ index: options.index, body });
    const hit = response.hits?.hits ?? [];
    if (hit.length === 0) return 0;

    let emitted = 0;
    for (const h of hit) {
      const diff = classify(h, version);
      if (!diff) continue;
      version++;
      emitted++;
      history.push(diff);
      if (history.length > historySize) history.shift();
      for (const notify of subscriber) {
        try {
          notify(diff);
        } catch (error) {
          onError(error);
        }
      }
    }

    const lastHit = hit[hit.length - 1]!;
    const source = lastHit._source ?? {};
    const nextWatermark = (lastHit.sort?.[0] ?? source[options.watermarkField]) as
      | Watermark
      | undefined;
    if (nextWatermark !== undefined) watermark = nextWatermark;
    searchAfter =
      lastHit.sort ??
      [source[options.watermarkField] ?? null, source[options.primaryKey] ?? null];
    return emitted;
  }

  const poll = (): Promise<number> => {
    if (inFlight) return inFlight;
    const run = runPoll()
      .catch((error: unknown) => {
        onError(error);
        return 0;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  };

  const ensureLoop = (): void => {
    if (handle !== null || closed) return;
    handle = scheduler.setInterval(() => {
      void poll();
    }, pollIntervalMs);
  };

  return {
    subscribe(onDiff): Unsubscribe {
      subscriber.add(onDiff);
      ensureLoop();
      return () => {
        subscriber.delete(onDiff);
      };
    },
    resync(request: ResyncRequest): Promise<ResyncResponse> {
      const diff = history.filter((d) => d.version > request.fromVersion);
      const oldest = history[0];
      // The replay is only coherent if the requested start point is still
      // inside the retained window. If history has already evicted past it we
      // cannot tell the client what it missed, so we tell it to start over.
      const coherent = oldest === undefined || oldest.version <= request.fromVersion + 1;
      if (!coherent) {
        return Promise.resolve({
          fromVersion: request.fromVersion,
          toVersion: version,
          diffs: [],
          snapshot: true,
        });
      }
      return Promise.resolve({
        fromVersion: request.fromVersion,
        toVersion: diff.length > 0 ? diff[diff.length - 1]!.version : request.fromVersion,
        diffs: diff,
      });
    },
    close(): void {
      closed = true;
      subscriber.clear();
      if (handle !== null) {
        scheduler.clearInterval(handle);
        handle = null;
      }
    },
    lastWatermark: () => watermark,
    poll,
  };
}

function defaultToRowDiff(
  hit: ElasticsearchHit,
  version: number,
  options: ElasticsearchCdcAdapterOptions,
): RowDiff | null {
  const source = hit._source ?? {};
  const rawId = source[options.primaryKey] ?? hit._id;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null;

  if (options.softDeleteField && source[options.softDeleteField]) {
    return { kind: 'delete', version, pkey: rawId };
  }
  const created = options.createdField ? source[options.createdField] : undefined;
  const kind: RowDiff['kind'] =
    created !== undefined && created === source[options.watermarkField] ? 'insert' : 'update';
  return { kind, version, pkey: rawId, fields: source };
}
