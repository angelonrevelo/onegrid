// =============================================================================
// Snowflake STREAM-backed CDC adapter.
//
// Snowflake has no LISTEN/NOTIFY. Its native change-tracking
// primitive is the STREAM: a bookmark over a table that exposes the
// rows changed since the stream was last *consumed*, with three
// metadata columns —
//
//   METADATA$ACTION    INSERT | DELETE
//   METADATA$ISUPDATE  TRUE when the row is one half of an update,
//                      which Snowflake represents as a DELETE row and
//                      an INSERT row carrying the same ROW_ID
//   METADATA$ROW_ID    stable per-row identity across the change
//
// So an update arrives as TWO stream rows. Collapsing them is this
// adapter's job: the DELETE half of an update pair is dropped and the
// INSERT half becomes `kind: 'update'`, which is what a grid client
// can actually apply.
//
// CONSUMPTION SEMANTICS — the part that surprises people. A plain
// `SELECT * FROM stream` does NOT advance the stream's offset; only
// DML that reads the stream inside a transaction does. Polling with a
// bare SELECT therefore re-delivers the same changes forever. The
// default `consume: 'temp-table'` mode runs the documented idiom
//
//   CREATE OR REPLACE TEMPORARY TABLE <consume> AS SELECT * FROM <stream>
//
// which is DML over the stream and so advances the offset atomically,
// then reads the temp table. `consume: 'peek'` keeps the
// non-advancing SELECT for dashboards and tests that must not disturb
// the bookmark.
//
// Polling shape (interval, poll limit, resync-or-snapshot) matches the
// MySQL adapter exactly, so an application can swap warehouses
// without re-learning the CDC contract. Latency is bounded by
// `pollIntervalMs` (default 1000 ms — higher than MySQL's 500 ms
// because every poll is a billed warehouse query, and
// SYSTEM$STREAM_HAS_DATA is the cheap pre-check that keeps an idle
// stream from costing anything).
//
// VERSIONS: a stream carries no version column, so the adapter
// assigns a monotonic counter per emitted diff, which is exactly what
// the protocol's gap detection needs. Because that counter lives in
// memory, replay across a process restart is impossible from the
// stream alone — pass `resyncQuery` (backed by a durable outbox or a
// CHANGES-clause query) if you need it; without one, resync honestly
// answers `snapshot: true` rather than pretending.
// =============================================================================

import type {
  ResyncRequest,
  ResyncResponse,
  RowDiff,
  Unsubscribe,
} from '@onegrid/protocol';
import type { SnowflakeQueryable, SnowflakeStatement } from './datasource';

export type SnowflakeStreamConsumeMode = 'temp-table' | 'peek';

export interface SnowflakeCdcAdapterOptions {
  readonly client: SnowflakeQueryable;
  /** Fully-qualified stream name, e.g. `ANALYTICS.PUBLIC.ORDER_STREAM`. */
  readonly stream: string;
  /** Primary-key column of the source table; becomes `RowDiff.pkey`. */
  readonly primaryKey: string;
  /** How to drain the stream. Default `temp-table` (advances the
   *  offset). `peek` re-reads the same window every poll. */
  readonly consume?: SnowflakeStreamConsumeMode;
  /** Temp table the `temp-table` mode drains into. Default
   *  `ONEGRID_STREAM_CONSUME`. */
  readonly consumeTable?: string;
  /** Poll interval in milliseconds. Default 1000. */
  readonly pollIntervalMs?: number;
  /** Maximum rows drained per poll. Default 1000. */
  readonly pollLimit?: number;
  /** Version the monotonic counter starts from. Default 0. */
  readonly startVersion?: number;
  /** Optional durable replay source, same contract as the Postgres
   *  adapter's: given `fromVersion`, return diffs in version order. */
  readonly resyncQuery?: (fromVersion: number) => Promise<ReadonlyArray<RowDiff>>;
  /** Diffs beyond which resync answers `snapshot: true`. Default 10_000. */
  readonly maxResyncDiffs?: number;
  /** Timer overrides so tests can drive the loop deterministically. */
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

export class SnapshotRequired extends Error {
  constructor(public readonly toVersion: number) {
    super(
      `@onegrid/snowflake: snapshot required (resync window exceeded; toVersion=${String(toVersion)}).`,
    );
    this.name = 'SnapshotRequired';
  }
}

export interface SnowflakeCdcAdapter {
  readonly subscribe: (onDiff: (diff: RowDiff) => void) => Unsubscribe;
  readonly resync: (req: ResyncRequest) => Promise<ResyncResponse>;
  /** Drain the stream once and emit to current subscribers. Exposed
   *  so an application can drive CDC from its own scheduler (or a
   *  Snowflake TASK webhook) instead of this adapter's poll timer. */
  readonly poll: () => Promise<number>;
  readonly close: () => Promise<void>;
}

const METADATA_PREFIX = 'METADATA$';

export function createSnowflakeCdcAdapter(
  opts: SnowflakeCdcAdapterOptions,
): SnowflakeCdcAdapter {
  const stream = requireQualifiedIdent(opts.stream, 'stream');
  const consumeTable = requireQualifiedIdent(
    opts.consumeTable ?? 'ONEGRID_STREAM_CONSUME',
    'consumeTable',
  );
  const consume = opts.consume ?? 'temp-table';
  const interval = opts.pollIntervalMs ?? 1_000;
  const pollLimit = opts.pollLimit ?? 1_000;
  const maxResync = opts.maxResyncDiffs ?? 10_000;
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;

  const subscriber = new Set<(diff: RowDiff) => void>();
  let version = opts.startVersion ?? 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let draining = false;

  const emit = (diff: RowDiff): void => {
    for (const sub of subscriber) {
      try {
        sub(diff);
      } catch (err) {
        console.error('@onegrid/snowflake: subscriber threw', err);
      }
    }
  };

  const drain = async (): Promise<number> => {
    // SYSTEM$STREAM_HAS_DATA is the cheap pre-check: it answers from
    // metadata without spinning the warehouse, so an idle stream
    // polls essentially for free.
    const probe = await opts.client.execute({
      sql: `SELECT SYSTEM$STREAM_HAS_DATA('${escapeStringLiteral(stream)}') AS "HAS_DATA"`,
      bind: [],
    });
    if (!hasData(probe.row[0])) return 0;

    let changeRow: ReadonlyArray<Record<string, unknown>>;
    if (consume === 'temp-table') {
      await opts.client.execute({
        sql: `CREATE OR REPLACE TEMPORARY TABLE ${quoteQualified(consumeTable)} AS SELECT * FROM ${quoteQualified(stream)}`,
        bind: [],
      });
      const drained = await opts.client.execute({
        sql: `SELECT * FROM ${quoteQualified(consumeTable)} LIMIT ${String(pollLimit)}`,
        bind: [],
      });
      changeRow = drained.row;
    } else {
      const peeked = await opts.client.execute({
        sql: `SELECT * FROM ${quoteQualified(stream)} LIMIT ${String(pollLimit)}`,
        bind: [],
      });
      changeRow = peeked.row;
    }

    let emitted = 0;
    for (const raw of changeRow) {
      const diff = toRowDiff(raw, opts.primaryKey, version + 1);
      if (!diff) continue;
      version = diff.version;
      emitted++;
      emit(diff);
    }
    return emitted;
  };

  const tick = async (): Promise<void> => {
    if (closed || draining) return;
    draining = true;
    try {
      await drain();
    } catch (err) {
      // A failed poll must not kill the loop — a warehouse that is
      // resuming from suspend routinely fails the first statement.
      console.error('@onegrid/snowflake: stream poll failed', err);
    } finally {
      draining = false;
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
      if (subscriber.size === 1 && !closed && !draining && handle === null) {
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
      if (!opts.resyncQuery) {
        // A stream cannot replay what it already handed out. Saying so
        // is better than returning an empty diff list the client would
        // read as "nothing changed".
        return {
          fromVersion: req.fromVersion,
          toVersion: version,
          diffs: [],
          snapshot: true,
        };
      }
      try {
        const diff = await opts.resyncQuery(req.fromVersion);
        if (diff.length > maxResync) {
          const lastVersion = diff.reduce((max, d) => Math.max(max, d.version), req.fromVersion);
          return {
            fromVersion: req.fromVersion,
            toVersion: lastVersion,
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
 * DDL for the stream this adapter reads. Emitted rather than
 * documented because the identifiers need the same validation the
 * query path gets. `SHOW_INITIAL_ROWS = TRUE` makes the first drain
 * deliver the table's current contents as inserts, which is what a
 * grid bootstrapping from empty wants.
 */
export function createStreamStatement(opts: {
  readonly stream: string;
  readonly sourceTable: string;
  readonly showInitialRow?: boolean;
  readonly appendOnly?: boolean;
}): SnowflakeStatement {
  const stream = requireQualifiedIdent(opts.stream, 'stream');
  const source = requireQualifiedIdent(opts.sourceTable, 'sourceTable');
  const clause = [
    opts.appendOnly ? 'APPEND_ONLY = TRUE' : null,
    opts.showInitialRow ? 'SHOW_INITIAL_ROWS = TRUE' : null,
  ].filter((c): c is string => c !== null);
  const suffix = clause.length > 0 ? ` ${clause.join(' ')}` : '';
  return {
    sql: `CREATE STREAM IF NOT EXISTS ${quoteQualified(stream)} ON TABLE ${quoteQualified(source)}${suffix}`,
    bind: [],
  };
}

/** The `SYSTEM$STREAM_HAS_DATA` probe, exposed for callers driving
 *  the poll from their own scheduler. */
export function streamHasDataStatement(stream: string): SnowflakeStatement {
  const validated = requireQualifiedIdent(stream, 'stream');
  return {
    sql: `SELECT SYSTEM$STREAM_HAS_DATA('${escapeStringLiteral(validated)}') AS "HAS_DATA"`,
    bind: [],
  };
}

function hasData(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  const value = row.HAS_DATA ?? row.has_data;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toUpperCase() === 'TRUE';
  return false;
}

/**
 * Collapse one stream row into a RowDiff. Returns null for the DELETE
 * half of an update pair (Snowflake emits both halves; the INSERT half
 * carries the post-image the grid needs) and for rows whose action or
 * primary key is unusable.
 */
function toRowDiff(
  raw: Record<string, unknown>,
  primaryKey: string,
  version: number,
): RowDiff | null {
  const action = String(raw[`${METADATA_PREFIX}ACTION`] ?? '').toUpperCase();
  const isUpdate = raw[`${METADATA_PREFIX}ISUPDATE`] === true ||
    String(raw[`${METADATA_PREFIX}ISUPDATE`] ?? '').toUpperCase() === 'TRUE';
  if (action !== 'INSERT' && action !== 'DELETE') return null;
  if (action === 'DELETE' && isUpdate) return null;

  const rawKey = raw[primaryKey] ?? raw[primaryKey.toUpperCase()];
  const pkey =
    typeof rawKey === 'bigint'
      ? rawKey.toString()
      : typeof rawKey === 'string' || typeof rawKey === 'number'
        ? rawKey
        : null;
  if (pkey === null) return null;

  const kind: RowDiff['kind'] = action === 'DELETE' ? 'delete' : isUpdate ? 'update' : 'insert';
  if (kind === 'delete') return { kind, version, pkey };

  const field: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(METADATA_PREFIX)) continue;
    field[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return { kind, version, pkey, fields: field };
}

const IDENT_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Stream / table names reach the SQL text as identifiers and, for
 * SYSTEM$STREAM_HAS_DATA, as a string literal — neither can be a
 * bind. So each dot-separated part must look like a bare Snowflake
 * identifier before it is allowed anywhere near the statement.
 */
function requireQualifiedIdent(id: string, label: string): string {
  const part = id.split('.');
  for (const p of part) {
    if (!IDENT_PART.test(p)) {
      throw new Error(
        `@onegrid/snowflake: ${label} "${id}" is not a valid identifier (part "${p}").`,
      );
    }
  }
  return id;
}

function quoteQualified(id: string): string {
  return id
    .split('.')
    .map((part) => `"${part.toUpperCase()}"`)
    .join('.');
}

function escapeStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
