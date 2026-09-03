// =============================================================================
// Deterministic fakes
//
// Two fakes cover the two halves of the grid's data story: a synchronous
// `RowSource` for the client-side row model, and an in-memory `DataSource`
// (the @onegrid/protocol server-side contract) for the block-fetch path.
//
// Design decisions:
//
//   1. Data is a pure function of (row, column). No random values, no
//      timestamps, no counters. A test that fails must fail for the reason it
//      names, and a fixture that regenerates itself between runs makes every
//      other failure suspect.
//
//   2. `createFakeDataSource` never resolves on its own timeline unless asked
//      to. The default is `latencyMs: 0`, which still defers by a macrotask so
//      loading state is observable; `manual: true` holds every fetch open
//      until `flush()`. Testing a loading spinner is otherwise a race, and a
//      race dressed as a test is worse than no test.
//
//   3. The data source records every `BlockRequest` it receives, keyed by
//      block index decoded from the `offset:N` cursor convention that
//      @onegrid/ssrm's row source emits. Asserting WHICH blocks were fetched
//      is how an adopter proves their overscan and cache settings work — the
//      request log is the observable, not the row text.
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  ColumnSchema,
  DataSource,
  Schema,
} from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Row source
// -----------------------------------------------------------------------------

/** Synchronous row model the canvas renderer reads. Structurally identical to
 *  `RowSource` in @onegrid/core; re-declared so this package does not force a
 *  type-only import on adopters who only want the fakes. */
export interface FakeRowSourceOption {
  /** Number of rows the source reports. */
  readonly rowCount: number;
  /** Column ids, or a count that generates `c0`, `c1`, … */
  readonly column: ReadonlyArray<string> | number;
  /**
   * Cell value generator. Default `` `${columnId}-${rowIndex}` `` — unique per
   * cell, so an assertion that reads the wrong cell cannot accidentally pass.
   */
  readonly value?: (rowIndex: number, columnId: string) => unknown;
}

/** A fake row source plus the write-back hook an editing test needs. */
export interface FakeRowSourceHandle {
  readonly numRows: number;
  readonly getCell: (rowIndex: number, columnId: string) => unknown;
  /** Column ids in order, as generated or supplied. */
  readonly columnId: ReadonlyArray<string>;
  /** Overwrite one cell. Wire this to `onCellEdit` to make edits stick. */
  readonly setCell: (rowIndex: number, columnId: string, value: unknown) => void;
  /** Drop every override, returning to the generated values. */
  readonly reset: () => void;
}

/**
 * Build a deterministic `RowSource` over `rowCount` rows.
 *
 * @public
 */
export function createFakeRowSource(option: FakeRowSourceOption): FakeRowSourceHandle {
  const columnId =
    typeof option.column === 'number'
      ? Array.from({ length: option.column }, (_v, i) => `c${String(i)}`)
      : [...option.column];
  const generate =
    option.value ?? ((rowIndex: number, id: string): unknown => `${id}-${String(rowIndex)}`);
  const override = new Map<string, unknown>();

  return {
    numRows: option.rowCount,
    columnId,
    getCell: (rowIndex, id) => {
      const key = `${String(rowIndex)}:${id}`;
      if (override.has(key)) return override.get(key);
      return generate(rowIndex, id);
    },
    setCell: (rowIndex, id, value) => {
      override.set(`${String(rowIndex)}:${id}`, value);
    },
    reset: () => {
      override.clear();
    },
  };
}

// -----------------------------------------------------------------------------
// Data source
// -----------------------------------------------------------------------------

/** One recorded `fetchBlock` invocation. */
export interface FakeBlockCall {
  /** Block index decoded from the request cursor (`offset:N` / null → 0). */
  readonly blockIndex: number;
  /** First dataset row the block covers. */
  readonly startRow: number;
  /** The request exactly as the caller sent it. */
  readonly request: BlockRequest;
  /** Whether the fetch has settled. */
  readonly settled: () => boolean;
}

/** Options for {@link createFakeDataSource}. */
export interface FakeDataSourceOption {
  /** Total rows the source can serve. */
  readonly rowCount: number;
  /** Column ids, or a count that generates `c0`, `c1`, … */
  readonly column: ReadonlyArray<string> | number;
  /**
   * Milliseconds before a fetch resolves. Default 0 — still asynchronous, so
   * a loading state exists, but settles on the next macrotask.
   */
  readonly latencyMs?: number;
  /**
   * Hold every fetch open until `flush()` is called. Overrides `latencyMs`.
   * This is the deterministic way to assert on a loading overlay.
   */
  readonly manual?: boolean;
  /** Cell value generator. Same default as {@link createFakeRowSource}. */
  readonly value?: (rowIndex: number, columnId: string) => unknown;
}

/** An in-memory `DataSource` with an inspectable, controllable fetch queue. */
export interface FakeDataSourceHandle extends DataSource {
  /** Every fetch this source has received, in order. */
  readonly call: ReadonlyArray<FakeBlockCall>;
  /** Block indices with an in-flight (unsettled) fetch. */
  readonly pending: ReadonlyArray<number>;
  /** True once block `index` has been fetched AND settled. */
  readonly hasBlock: (index: number) => boolean;
  /**
   * Settle every in-flight fetch now and yield so the awaiting code runs.
   * Returns the number of fetches that were released.
   */
  readonly flush: () => Promise<number>;
  /** Clear the call log and delivered-block set. In-flight fetches survive. */
  readonly reset: () => void;
}

/** Decode `offset:N` (the cursor convention @onegrid/ssrm's row source emits).
 *  A null cursor means "first block"; anything unrecognised also maps to 0,
 *  because a source that cannot place a cursor should serve the head rather
 *  than throw at the adopter. */
function offsetFromCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const m = /^offset:(\d+)$/.exec(cursor);
  if (!m?.[1]) return 0;
  return Number(m[1]);
}

interface PendingFetch {
  readonly blockIndex: number;
  readonly release: () => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Build an in-memory `DataSource` conforming to @onegrid/protocol, with a
 * request log, a `pending` view, and a `flush()` handle.
 *
 * @public
 */
export function createFakeDataSource(option: FakeDataSourceOption): FakeDataSourceHandle {
  const columnId =
    typeof option.column === 'number'
      ? Array.from({ length: option.column }, (_v, i) => `c${String(i)}`)
      : [...option.column];
  const generate =
    option.value ?? ((rowIndex: number, id: string): unknown => `${id}-${String(rowIndex)}`);
  const latencyMs = option.latencyMs ?? 0;
  const manual = option.manual ?? false;

  const call: FakeBlockCall[] = [];
  const delivered = new Set<number>();
  let inflight: PendingFetch[] = [];

  const schema: Schema = columnId.map(
    (id): ColumnSchema => ({ id, type: 'utf8', nullable: false, displayName: id }),
  );

  const buildRow = (startRow: number, limit: number): Record<string, unknown>[] => {
    const end = Math.min(option.rowCount, startRow + limit);
    const row: Record<string, unknown>[] = [];
    for (let r = startRow; r < end; r++) {
      const record: Record<string, unknown> = {};
      for (const id of columnId) record[id] = generate(r, id);
      row.push(record);
    }
    return row;
  };

  const fetchBlock = (req: BlockRequest): Promise<BlockResponse> => {
    const startRow = offsetFromCursor(req.cursor);
    const limit = Math.max(1, req.limit);
    const blockIndex = Math.floor(startRow / limit);
    let settled = false;
    call.push({
      blockIndex,
      startRow,
      request: req,
      settled: () => settled,
    });

    const row = buildRow(startRow, limit);
    const nextRow = startRow + row.length;
    const response: BlockResponse = {
      encoding: 'json',
      rows: row,
      nextCursor: nextRow >= option.rowCount ? null : `offset:${String(nextRow)}`,
      prevCursor: startRow === 0 ? null : `offset:${String(Math.max(0, startRow - limit))}`,
      totalRowCount: option.rowCount,
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
    };

    return new Promise<BlockResponse>((resolve) => {
      const release = (): void => {
        if (settled) return;
        settled = true;
        inflight = inflight.filter((p) => p.release !== release);
        delivered.add(blockIndex);
        resolve(response);
      };
      // `manual` parks the fetch in `inflight` with no timer, so it only
      // moves when flush() says so. Otherwise a macrotask (possibly a
      // delayed one) releases it on its own.
      const timer = manual ? null : setTimeout(release, latencyMs);
      inflight.push({ blockIndex, release, timer });
    });
  };

  return {
    schema: () => schema,
    fetchBlock: (req, opt) => {
      if (opt?.signal?.aborted === true) {
        return Promise.reject(new Error('@onegrid/test: fetchBlock aborted before dispatch'));
      }
      return fetchBlock(req);
    },
    get call(): ReadonlyArray<FakeBlockCall> {
      return call;
    },
    get pending(): ReadonlyArray<number> {
      return inflight.map((p) => p.blockIndex);
    },
    hasBlock: (index) => delivered.has(index),
    flush: async () => {
      const released = inflight.slice();
      for (const p of released) {
        if (p.timer !== null) clearTimeout(p.timer);
        p.release();
      }
      // Two turns: one for the fetchBlock promise's own continuation, one for
      // whatever the consumer chained onto it (a row source's cache write).
      await Promise.resolve();
      await Promise.resolve();
      return released.length;
    },
    reset: () => {
      call.length = 0;
      delivered.clear();
    },
  };
}
