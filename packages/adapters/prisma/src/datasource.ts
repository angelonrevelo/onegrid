// =============================================================================
// Prisma-backed DataSource.
//
// The adapter takes no npm dependency on `@prisma/client`. It cannot: the
// generated client is a per-project artifact whose types are produced from
// the adopter's own `schema.prisma`, so there is nothing stable to depend on.
// What every generated client DOES have is a delegate per model with the same
// six methods, and that is exactly what `PrismaDelegate` declares. Pass
// `prisma.order` and TypeScript structurally accepts it; pass an in-memory
// fake and the tests work without a database.
//
// Read path: `findMany` with cursor pagination. Grouped requests go through
// `groupBy` so the rollup happens in SQL.
//
// Write path: `mutate` is implemented, unlike most read-only adapters here,
// because Prisma is the ORM people reach for when the grid is editable. The
// optimistic-concurrency check (`UpdateMutation.expected`) is done as a read
// before the write rather than folded into the `where` clause: Prisma's
// `update` accepts only unique fields in `where`, so a non-unique guard
// column cannot go there, and `updateMany` — which could take one — reports a
// count instead of the row we need to send back on a conflict.
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  Cursor,
  DataSource,
  FetchOptions,
  KeysetCursor,
  Mutation,
  MutationResult,
  MutationResultEntry,
  Schema,
  SortModel,
} from '@onegrid/protocol';
import {
  compilePrismaQuery,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  parseGroupByResult,
  type PrismaFindManyArg,
  type PrismaGroupByArg,
  type PrismaModelDescriptor,
} from './query';
import { normalizePrismaRow, type NormalizeOptions } from './schema';

// -----------------------------------------------------------------------------
// The injectable
// -----------------------------------------------------------------------------

/**
 * The slice of a Prisma model delegate this adapter uses. Every generated
 * `prisma.<model>` satisfies it structurally.
 */
export interface PrismaDelegate {
  findMany(arg: PrismaFindManyArg): Promise<ReadonlyArray<Record<string, unknown>>>;
  groupBy(arg: PrismaGroupByArg): Promise<ReadonlyArray<Record<string, unknown>>>;
  count(arg: { where?: Record<string, unknown> }): Promise<number>;
  create(arg: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  update(arg: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  delete(arg: { where: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface PrismaDataSourceOptions {
  /** `prisma.order`, or anything with the same six methods. */
  readonly delegate: PrismaDelegate;
  readonly descriptor: PrismaModelDescriptor;
  /**
   * Schema for the model. Derive it once at boot with `schemaFromDmmf` over
   * `Prisma.dmmf.datamodel.models`.
   */
  readonly schema: Schema;
  /** Page size when a request omits `limit`. Default 200. */
  readonly defaultLimit?: number;
  /**
   * Issue a `count` alongside the first block so the grid can size its
   * scrollbar. Off by default — on a large table `SELECT COUNT(*)` is a full
   * scan, and SSRM's infinite-scroll mode does not need it.
   */
  readonly trackTotalRowCount?: boolean;
  /** BigInt / Decimal encoding on the way out. Default 'string'. */
  readonly wideNumber?: NormalizeOptions['wideNumber'];
  /** Set false to skip row normalisation when the model has no wide numerics. */
  readonly normalizeRow?: boolean;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function createPrismaDataSource(options: PrismaDataSourceOptions): DataSource {
  const defaultLimit = options.defaultLimit ?? 200;
  const normalizeOption: NormalizeOptions =
    options.wideNumber !== undefined ? { wideNumber: options.wideNumber } : {};
  const shouldNormalize = options.normalizeRow !== false;

  const finish = (row: ReadonlyArray<Record<string, unknown>>) =>
    shouldNormalize ? row.map((r) => normalizePrismaRow(r, normalizeOption)) : row.slice();

  async function fetchBlock(
    request: BlockRequest,
    fetchOptions?: FetchOptions,
  ): Promise<BlockResponse<'json'>> {
    throwIfAborted(fetchOptions);
    const limit = request.limit > 0 ? request.limit : defaultLimit;
    const req: BlockRequest = { ...request, limit };
    const cursor = keysetFrom(request.cursor);
    const compiled = compilePrismaQuery(req, options.descriptor, cursor);

    if (compiled.kind === 'groupBy') {
      const raw = await options.delegate.groupBy(compiled.arg);
      throwIfAborted(fetchOptions);
      return {
        encoding: 'json',
        rows: finish(parseGroupByResult(compiled, raw)),
        // Grouped blocks are not cursor-paginated: Prisma's groupBy has no
        // cursor argument, so a grouped fetch returns up to `limit` groups and
        // stops. Deeper group sets need a raw query.
        nextCursor: null,
        prevCursor: null,
      };
    }

    const raw = await options.delegate.findMany(compiled.arg);
    throwIfAborted(fetchOptions);

    // A negative `take` makes Prisma walk backwards from the cursor, but it
    // still returns rows in `orderBy` order, so no client-side reversal is
    // needed — which is exactly why the compiler does not flip the sort.
    const row = finish(raw);
    const full = raw.length === limit;
    const forward = request.direction === 'after';

    const last = row[row.length - 1];
    const first = row[0];
    const tailCursor = full && last ? buildCursor(last, request.sort, options.descriptor) : null;
    const headCursor = first ? buildCursor(first, request.sort, options.descriptor) : null;

    let totalRowCount: number | undefined;
    if (options.trackTotalRowCount) {
      const where = compiled.arg.where;
      totalRowCount = await options.delegate.count(where ? { where } : {});
      throwIfAborted(fetchOptions);
    }

    return {
      encoding: 'json',
      rows: row,
      nextCursor: forward ? tailCursor : headCursor,
      prevCursor: forward ? (request.cursor ? headCursor : null) : tailCursor,
      ...(totalRowCount !== undefined ? { totalRowCount } : {}),
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    };
  }

  async function mutate(mutation: ReadonlyArray<Mutation>): Promise<MutationResult> {
    const key = options.descriptor.primaryKey;
    const out: MutationResultEntry[] = [];
    for (const entry of mutation) {
      try {
        if (entry.kind === 'insert') {
          const created = await options.delegate.create({ data: { ...entry.row } });
          out.push({ kind: 'ok', clientId: entry.clientId, rowId: rowIdOf(created, key) });
          continue;
        }
        if (entry.kind === 'delete') {
          await options.delegate.delete({ where: { [key]: entry.rowId } });
          out.push({ kind: 'ok', clientId: entry.clientId, rowId: entry.rowId });
          continue;
        }
        if (entry.expected) {
          const [current] = await options.delegate.findMany({
            where: { [key]: { equals: entry.rowId } },
            orderBy: [{ [key]: 'asc' }],
            take: 1,
          });
          if (!current) {
            out.push({
              kind: 'error',
              clientId: entry.clientId,
              message: `row ${String(entry.rowId)} no longer exists`,
              code: 'NOT_FOUND',
            });
            continue;
          }
          const stale = Object.entries(entry.expected).some(
            ([field, value]) => !Object.is(normaliseScalar(current[field]), normaliseScalar(value)),
          );
          if (stale) {
            out.push({
              kind: 'conflict',
              clientId: entry.clientId,
              rowId: entry.rowId,
              server: shouldNormalize ? normalizePrismaRow(current, normalizeOption) : current,
            });
            continue;
          }
        }
        await options.delegate.update({
          where: { [key]: entry.rowId },
          data: { ...entry.fields },
        });
        out.push({ kind: 'ok', clientId: entry.clientId, rowId: entry.rowId });
      } catch (error) {
        out.push({
          kind: 'error',
          clientId: entry.clientId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  return {
    schema: () => options.schema,
    fetchBlock,
    mutate,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildCursor(
  row: Record<string, unknown>,
  sort: SortModel,
  descriptor: PrismaModelDescriptor,
): Cursor {
  return encodeKeysetCursor({
    sortValues: sort.map((s) => row[s.columnId] ?? null),
    rowId: rowIdOf(row, descriptor.primaryKey),
  });
}

function rowIdOf(row: Record<string, unknown>, key: string): string | number {
  const raw = row[key];
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  // A BigInt primary key is exactly the case `normalizePrismaRow` turns into
  // a string; either form has to round-trip through the cursor intact.
  if (typeof raw === 'bigint') return raw.toString();
  throw new Error(
    `@onegrid/prisma: primary key "${key}" is ${typeof raw}; expected string, number, or bigint.`,
  );
}

function keysetFrom(cursor: Cursor | null): KeysetCursor | null {
  if (!cursor || !isKeysetCursor(cursor)) return null;
  try {
    return decodeKeysetCursor(cursor);
  } catch {
    return null;
  }
}

/**
 * Compare optimistic-concurrency values across the JS/DB type boundary. A
 * client that read a BigInt column saw a string (that is what the wire
 * carries); the database still has a bigint. Comparing them raw would flag
 * every such row as a conflict.
 */
function normaliseScalar(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.getTime();
  return value;
}

function throwIfAborted(fetchOptions: FetchOptions | undefined): void {
  if (fetchOptions?.signal?.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
}
