// =============================================================================
// BigQuery polling CDC adapter, over an ingestion-time-partitioned
// outbox table.
//
// BigQuery has no push change feed a browser-facing service can
// subscribe to. The options are:
//   1. Datastream / Pub-Sub CDC pipelines — real, but they land
//      changes IN BigQuery rather than emitting them out of it.
//   2. Table snapshots + diffing — a full scan per poll, which bills
//      like one.
//   3. Polling an append-only outbox — what this adapter ships. The
//      application appends `{ version, kind, pkey, fields }` rows on
//      every mutation (from its own writer, a Datastream sink, or a
//      MERGE job), and the adapter tails them by version.
//
// The BigQuery-specific part is COST, and it is why the outbox must be
// partitioned by ingestion time. `WHERE version > @lastVersion` alone
// forces a full-column scan of the whole outbox on every poll, at
// every poll interval, forever — a query that gets more expensive the
// longer the system runs. Adding
// `_PARTITIONTIME >= TIMESTAMP(@since)` first restricts the scan to
// the last few partitions, so polling cost stays flat no matter how
// large the outbox grows. The version predicate then does the exact
// filtering within that window.
//
// `lookbackMs` (default 10 minutes) sets how far back that window
// reaches. It must comfortably exceed the worst-case delay between a
// row being written and becoming queryable — streaming inserts can
// take a moment to land, and a window that is too tight drops diffs
// permanently. Ten minutes is generous on purpose: an extra partition
// scanned is cheap, a lost change is not.
//
// Polling shape (interval, poll limit, resync-or-snapshot) matches the
// MySQL adapter, so an application can move warehouses without
// re-learning the CDC contract.
// =============================================================================

import type {
  ResyncRequest,
  ResyncResponse,
  RowDiff,
  Unsubscribe,
} from '@onegrid/protocol';
import type { BigQueryQueryable } from './datasource';

export interface BqCdcAdapterOptions {
  readonly client: BigQueryQueryable;
  /** GCP project id holding the outbox. */
  readonly project: string;
  /** Dataset id holding the outbox. */
  readonly dataset: string;
  /** Outbox table id. Default `onegrid_outbox`. */
  readonly outboxTable?: string;
  /** Ingestion-time pseudo-column used to prune the poll query.
   *  Default `_PARTITIONTIME`. */
  readonly partitionPseudoColumn?: '_PARTITIONTIME' | '_PARTITIONDATE';
  /** How far back the partition window reaches, in milliseconds.
   *  Default 600_000 (10 minutes). */
  readonly lookbackMs?: number;
  /** Poll interval in milliseconds. Default 2000 — every poll is a
   *  billed job, so this is slower than MySQL's 500 ms on purpose. */
  readonly pollIntervalMs?: number;
  /** Maximum diffs fetched per poll. Default 1000. */
  readonly pollLimit?: number;
  /** Diffs beyond which resync answers `snapshot: true`. Default 10_000. */
  readonly maxResyncDiffs?: number;
  /** Version to start tailing from. Default -1 (everything in the
   *  lookback window). */
  readonly startVersion?: number;
  /** Dataset location, forwarded on every job. */
  readonly location?: string;
  /** Clock override, so tests can pin the partition window. */
  readonly nowImpl?: () => number;
  /** Timer overrides so tests can drive the loop deterministically. */
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

export class SnapshotRequired extends Error {
  constructor(public readonly toVersion: number) {
    super(
      `@onegrid/bigquery: snapshot required (resync window exceeded; toVersion=${String(toVersion)}).`,
    );
    this.name = 'SnapshotRequired';
  }
}

export interface BqCdcAdapter {
  readonly subscribe: (onDiff: (diff: RowDiff) => void) => Unsubscribe;
  readonly resync: (req: ResyncRequest) => Promise<ResyncResponse>;
  /** Run one poll and emit to current subscribers. Exposed so an
   *  application can drive CDC from its own scheduler (or a Cloud
   *  Scheduler tick) instead of this adapter's timer. */
  readonly poll: () => Promise<number>;
  readonly close: () => Promise<void>;
}

const PATH_PART = /^[A-Za-z0-9_-]+$/;

export function createBqCdcAdapter(opts: BqCdcAdapterOptions): BqCdcAdapter {
  const outbox = quoteOutbox(
    opts.project,
    opts.dataset,
    opts.outboxTable ?? 'onegrid_outbox',
  );
  const pseudo = opts.partitionPseudoColumn ?? '_PARTITIONTIME';
  const wrap = pseudo === '_PARTITIONTIME' ? 'TIMESTAMP' : 'DATE';
  const lookbackMs = opts.lookbackMs ?? 600_000;
  const interval = opts.pollIntervalMs ?? 2_000;
  const pollLimit = opts.pollLimit ?? 1_000;
  const maxResync = opts.maxResyncDiffs ?? 10_000;
  const now = opts.nowImpl ?? Date.now;
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;

  const subscriber = new Set<(diff: RowDiff) => void>();
  let lastVersion = opts.startVersion ?? -1;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let polling = false;

  /** The tail query. Partition predicate FIRST so BigQuery prunes
   *  before it filters — the difference between a bounded scan and a
   *  full-history one on every tick. */
  const tailSql = (limit: number): string =>
    `SELECT \`version\`, \`kind\`, \`pkey\`, \`fields\` FROM ${outbox}` +
    ` WHERE ${pseudo} >= ${wrap}(@since) AND \`version\` > @fromVersion` +
    ` ORDER BY \`version\` LIMIT ${String(limit)}`;

  const since = (): string => new Date(now() - lookbackMs).toISOString();

  const paramType = {
    since: wrap,
    fromVersion: 'INT64',
  } as const;

  const runTail = async (
    fromVersion: number,
    limit: number,
  ): Promise<ReadonlyArray<Record<string, unknown>>> => {
    const result = await opts.client.query({
      sql: tailSql(limit),
      params: { since: since(), fromVersion },
      paramType,
      ...(opts.location === undefined ? {} : { location: opts.location }),
    });
    return result.row;
  };

  const drain = async (): Promise<number> => {
    const row = await runTail(lastVersion, pollLimit);
    let emitted = 0;
    for (const raw of row) {
      const diff = toRowDiff(raw);
      if (!diff) continue;
      lastVersion = Math.max(lastVersion, diff.version);
      emitted++;
      for (const sub of subscriber) {
        try {
          sub(diff);
        } catch (err) {
          console.error('@onegrid/bigquery: subscriber threw', err);
        }
      }
    }
    return emitted;
  };

  const tick = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      await drain();
    } catch (err) {
      // A failed poll must not kill the loop: BigQuery rate-limits
      // concurrent jobs, and a 403 on one tick is routine.
      console.error('@onegrid/bigquery: outbox poll failed', err);
    } finally {
      polling = false;
      if (!closed && subscriber.size > 0) {
        handle = setT(() => {
          void tick();
        }, interval);
      }
    }
  };

  return {
    subscribe(onDiff): Unsubscribe {
      subscriber.add(onDiff);
      if (subscriber.size === 1 && !closed && !polling && handle === null) {
        // Kick immediately so the first change lands without waiting
        // out a whole poll interval.
        void tick();
      }
      return () => {
        subscriber.delete(onDiff);
        if (subscriber.size === 0 && handle) {
          clearT(handle);
          handle = null;
        }
      };
    },
    poll: drain,
    async resync(req: ResyncRequest): Promise<ResyncResponse> {
      try {
        // maxResync + 1 so an over-long window is detectable without a
        // second COUNT query.
        const row = await runTail(req.fromVersion, maxResync + 1);
        const diff = row.map(toRowDiff).filter((d): d is RowDiff => d !== null);
        if (diff.length > maxResync) {
          const lastKnown = diff[maxResync]?.version ?? req.fromVersion;
          return {
            fromVersion: req.fromVersion,
            toVersion: lastKnown,
            diffs: [],
            snapshot: true,
          };
        }
        const toVersion = diff.length > 0 ? diff[diff.length - 1]!.version : req.fromVersion;
        return { fromVersion: req.fromVersion, toVersion, diffs: diff };
      } catch (err) {
        if (err instanceof SnapshotRequired) {
          return {
            fromVersion: req.fromVersion,
            toVersion: err.toVersion,
            diffs: [],
            snapshot: true,
          };
        }
        throw err;
      }
    },
    close() {
      closed = true;
      if (handle) {
        clearT(handle);
        handle = null;
      }
      subscriber.clear();
      return Promise.resolve();
    },
  };
}

/**
 * DDL for the outbox this adapter tails. Emitted rather than
 * documented so the identifiers get the same validation the query path
 * gets, and so the partitioning — the thing that keeps polling cheap —
 * cannot be forgotten.
 */
export function createOutboxStatement(opts: {
  readonly project: string;
  readonly dataset: string;
  readonly outboxTable?: string;
  /** Partition expiry in days; BigQuery drops older partitions
   *  automatically, which bounds the outbox without a cleanup job. */
  readonly partitionExpirationDay?: number;
}): string {
  const table = quoteOutbox(opts.project, opts.dataset, opts.outboxTable ?? 'onegrid_outbox');
  const expiry =
    opts.partitionExpirationDay === undefined
      ? ''
      : ` OPTIONS (partition_expiration_days = ${String(
          requireSafeInteger(opts.partitionExpirationDay, 'partitionExpirationDay'),
        )})`;
  return (
    `CREATE TABLE IF NOT EXISTS ${table} (` +
    '`version` INT64 NOT NULL, ' +
    '`kind` STRING NOT NULL, ' +
    '`pkey` STRING NOT NULL, ' +
    '`fields` JSON' +
    ') PARTITION BY DATE(_PARTITIONTIME)' +
    expiry
  );
}

/**
 * Parse one outbox row into a RowDiff. `fields` may arrive as a JSON
 * string (the REST API renders a JSON column as text) or already
 * parsed, depending on the transport — both are accepted. A row whose
 * version, kind or pkey is unusable is dropped rather than crashing
 * the poll loop.
 */
function toRowDiff(row: Record<string, unknown>): RowDiff | null {
  const version = toVersionNumber(row.version);
  const kind = row.kind;
  if (version === null) return null;
  if (kind !== 'insert' && kind !== 'update' && kind !== 'delete') return null;

  const rawKey = row.pkey;
  const pkey =
    typeof rawKey === 'bigint'
      ? rawKey.toString()
      : typeof rawKey === 'string' || typeof rawKey === 'number'
        ? rawKey
        : null;
  if (pkey === null) return null;

  let fields: Record<string, unknown> | undefined;
  if (typeof row.fields === 'string') {
    try {
      fields = JSON.parse(row.fields) as Record<string, unknown>;
    } catch {
      fields = undefined;
    }
  } else if (row.fields && typeof row.fields === 'object') {
    fields = row.fields as Record<string, unknown>;
  }

  return { kind, version, pkey, ...(fields ? { fields } : {}) };
}

/**
 * The outbox's `version` is INT64, so it arrives as a BigInt or a
 * `{ value }` wrapper. The protocol's `RowDiff.version` is a JS
 * number, which is correct here: a version counter that reached 2^53
 * would mean nine quadrillion mutations.
 */
function toVersionNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (raw !== null && typeof raw === 'object' && 'value' in raw) {
    return toVersionNumber((raw).value);
  }
  return null;
}

function quoteOutbox(project: string, dataset: string, table: string): string {
  for (const [label, part] of [
    ['project', project],
    ['dataset', dataset],
    ['outboxTable', table],
  ] as const) {
    if (!PATH_PART.test(part)) {
      throw new Error(
        `@onegrid/bigquery: ${label} "${part}" is not a valid BigQuery identifier.`,
      );
    }
  }
  return `\`${project}.${dataset}.${table}\``;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`@onegrid/bigquery: ${label} must be a positive safe integer.`);
  }
  return value;
}
