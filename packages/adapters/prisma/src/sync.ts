// =============================================================================
// Prisma live sync.
//
// `@onegrid/orm-sync` already declares the Prisma side of the live-sync
// contract: `extractFromPrisma` takes a DMMF-shaped field list and produces
// an `OrmModelDescriptor`, and `bindOrmSync` wraps a `CdcAdapter` so
// subscriber callbacks fire with ORM-typed rows. This module conforms to that
// contract rather than inventing a second one — it supplies the missing
// `CdcAdapter` and wires the two ends together.
//
// The honest part: Prisma Client has no change feed. There is no
// `prisma.order.subscribe()`; the removed `$subscribe` preview API only ever
// worked against the Prisma Data Proxy. So the CDC adapter here polls a
// monotonic column through the same `PrismaDelegate` the datasource uses —
// typically `updatedAt`, which `@updatedAt` maintains for free. Adopters who
// want true logical-decoding CDC point `bindPrismaSync` at
// `@onegrid/postgres`'s LISTEN/NOTIFY adapter instead; the model descriptor
// half of this module is what they still need, and it works either way.
//
// Correctness notes for the poll, which are the same two that bite every
// watermark poller:
//
//   - The boundary tie. Polling `updatedAt > last` drops rows written in the
//     same millisecond as the last one seen but committed after the query
//     ran. The poll therefore re-reads the boundary inclusively
//     (`gte: last`) and suppresses ids it already delivered at that exact
//     watermark, rather than pretending millisecond timestamps are unique.
//   - Insert versus update is not observable from a poll. With a `createdAt`
//     column configured, a row whose creation time equals its watermark is an
//     insert; without one, everything is reported as an idempotent `update`.
// =============================================================================

import type { ResyncRequest, ResyncResponse, RowDiff, Unsubscribe } from '@onegrid/protocol';
import { bindOrmSync, extractFromPrisma, type OrmSyncHandle, type TypedRowDiff } from '@onegrid/orm-sync';
import type { PrismaDelegate } from './datasource';
import type { PrismaSyncModel } from './schema';

/** Timer surface, injectable so tests drive the loop without wall-clock waits. */
export interface PrismaCdcScheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PrismaCdcAdapterOptions {
  readonly delegate: PrismaDelegate;
  /** Monotonic column the poll orders by. Usually an `@updatedAt` field. */
  readonly watermarkField: string;
  readonly primaryKey: string;
  /** Creation-time column; lets the poll distinguish insert from update. */
  readonly createdField?: string;
  /** Soft-delete flag. Real deletes are invisible to a poll. */
  readonly softDeleteField?: string;
  /** Rows per poll. Default 500. */
  readonly batchSize?: number;
  /** Poll period in ms. Default 1000. */
  readonly pollIntervalMs?: number;
  /** Resume point from a previous process. */
  readonly startAfter?: Date | number | string;
  /** Diffs retained for `resync`. Default 10 000. */
  readonly historySize?: number;
  readonly scheduler?: PrismaCdcScheduler;
  readonly onError?: (error: unknown) => void;
}

/**
 * Structurally a `CdcAdapter` from `@onegrid/ssrm`, plus a manual `poll` for
 * tests and for adopters who drive the loop from their own job runner.
 */
export interface PrismaCdcAdapter {
  readonly subscribe: (onDiff: (diff: RowDiff) => void) => Unsubscribe;
  readonly resync: (request: ResyncRequest) => Promise<ResyncResponse>;
  readonly close: () => void;
  readonly lastWatermark: () => Date | number | string | null;
  readonly poll: () => Promise<number>;
}

export function createPrismaCdcAdapter(
  options: PrismaCdcAdapterOptions,
): PrismaCdcAdapter {
  const batchSize = options.batchSize ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const historySize = options.historySize ?? 10_000;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error('@onegrid/prisma: CDC poll failed', error);
    });
  const scheduler: PrismaCdcScheduler = options.scheduler ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };

  const subscriber = new Set<(diff: RowDiff) => void>();
  const history: RowDiff[] = [];
  /** Ids already delivered at the current watermark, so the inclusive
   *  re-read of the boundary does not re-emit them. */
  let deliveredAtWatermark = new Set<string>();
  let watermark: Date | number | string | null = options.startAfter ?? null;
  let version = 0;
  let handle: unknown = null;
  let closed = false;
  let inFlight: Promise<number> | null = null;

  async function runPoll(): Promise<number> {
    if (closed) return 0;
    const row = await options.delegate.findMany({
      ...(watermark !== null
        ? { where: { [options.watermarkField]: { gte: watermark } } }
        : {}),
      orderBy: [
        { [options.watermarkField]: 'asc' },
        { [options.primaryKey]: 'asc' },
      ],
      take: batchSize,
    });
    if (row.length === 0) return 0;

    let emitted = 0;
    for (const record of row) {
      const rawId = record[options.primaryKey];
      const pkey = scalarId(rawId);
      if (pkey === null) continue;
      const mark = record[options.watermarkField] as Date | number | string | undefined;
      if (mark === undefined) continue;

      if (sameWatermark(mark, watermark) && deliveredAtWatermark.has(String(pkey))) {
        continue;
      }
      if (!sameWatermark(mark, watermark)) {
        watermark = mark;
        deliveredAtWatermark = new Set<string>();
      }
      deliveredAtWatermark.add(String(pkey));

      const diff = toRowDiff(record, pkey, version, options);
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
    return emitted;
  }

  const poll = (): Promise<number> => {
    // A poll that overruns its interval must not be re-entered — two
    // concurrent polls would read the same watermark and double-emit.
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

function toRowDiff(
  record: Record<string, unknown>,
  pkey: string | number,
  version: number,
  options: PrismaCdcAdapterOptions,
): RowDiff {
  if (options.softDeleteField && record[options.softDeleteField]) {
    return { kind: 'delete', version, pkey };
  }
  const created = options.createdField ? record[options.createdField] : undefined;
  const kind: RowDiff['kind'] =
    created !== undefined && sameWatermark(created, record[options.watermarkField])
      ? 'insert'
      : 'update';
  return { kind, version, pkey, fields: record };
}

/** Dates compare by instant, everything else by value. */
function sameWatermark(left: unknown, right: unknown): boolean {
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function scalarId(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return value.toString();
  return null;
}

// -----------------------------------------------------------------------------
// The orm-sync bridge
// -----------------------------------------------------------------------------

export interface BindPrismaSyncOptions<TRow> {
  /**
   * The model, as `toOrmSyncModel(dmmfModel)` produces it. Same source of
   * truth as the grid schema.
   */
  readonly model: PrismaSyncModel;
  /**
   * The change source. Pass `createPrismaCdcAdapter(...)` for the polling
   * default, or any `CdcAdapter` — `@onegrid/postgres`'s logical-decoding
   * adapter drops in here unchanged.
   */
  readonly cdc: PrismaCdcAdapter;
  /** Fires per change with the row typed as the Prisma model. */
  readonly onDiff: (diff: TypedRowDiff<TRow>) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/**
 * Wire a Prisma change source into `@onegrid/orm-sync`, so subscribers
 * receive `TypedRowDiff<TRow>` instead of raw column maps.
 *
 * This is deliberately a thin call into `bindOrmSync` rather than a
 * reimplementation: orm-sync owns the version tracking, the resync trigger
 * and the typed-row projection, and having two copies of that logic is how
 * they drift.
 */
export function bindPrismaSync<TRow>(options: BindPrismaSyncOptions<TRow>): OrmSyncHandle {
  const model = extractFromPrisma<TRow>({
    table: options.model.table,
    primaryKey: options.model.primaryKey as keyof TRow & string,
    fields: options.model.fields,
  });
  return bindOrmSync<TRow>({
    cdc: options.cdc,
    model,
    onDiff: options.onDiff,
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
