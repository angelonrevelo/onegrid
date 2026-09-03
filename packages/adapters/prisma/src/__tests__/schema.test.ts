// =============================================================================
// DMMF introspection, wide-number handling, and the orm-sync live bridge.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { RowDiff } from '@onegrid/protocol';
import { extractFromPrisma, toSchema } from '@onegrid/orm-sync';
import {
  descriptorFromDmmf,
  normalizePrismaRow,
  primaryKeyOfDmmf,
  prismaTypeToColumnType,
  schemaFromDmmf,
  toOrmSyncModel,
  type PrismaDmmfModel,
} from '../schema';
import { bindPrismaSync, createPrismaCdcAdapter, type PrismaCdcScheduler } from '../sync';
import type { PrismaDelegate } from '../datasource';

const ORDER: PrismaDmmfModel = {
  name: 'Order',
  dbName: 'order_record',
  fields: [
    { name: 'id', kind: 'scalar', type: 'Int', isId: true, isRequired: true },
    { name: 'reference', kind: 'scalar', type: 'BigInt', isRequired: true },
    { name: 'total', kind: 'scalar', type: 'Decimal', isRequired: true },
    { name: 'ratio', kind: 'scalar', type: 'Float', isRequired: true },
    { name: 'note', kind: 'scalar', type: 'String', isRequired: false },
    { name: 'paid', kind: 'scalar', type: 'Boolean', isRequired: true },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true },
    { name: 'meta', kind: 'scalar', type: 'Json', isRequired: false },
    { name: 'blob', kind: 'scalar', type: 'Bytes', isRequired: false },
    { name: 'tag', kind: 'scalar', type: 'String', isList: true, isRequired: true },
    { name: 'status', kind: 'enum', type: 'OrderStatus', isRequired: true },
    { name: 'geom', kind: 'unsupported', type: 'Unsupported("geometry")' },
    { name: 'customerId', kind: 'scalar', type: 'Int', isRequired: true },
    {
      name: 'customer',
      kind: 'object',
      type: 'Customer',
      isRequired: true,
      relationName: 'CustomerToOrder',
      relationFromFields: ['customerId'],
    },
  ],
};

describe('schemaFromDmmf', () => {
  it('keeps BigInt and Decimal off the float64 path', () => {
    expect(prismaTypeToColumnType('BigInt')).toBe('int64');
    expect(prismaTypeToColumnType('Decimal')).toBe('decimal');
    expect(prismaTypeToColumnType('Float')).toBe('float64');
    expect(prismaTypeToColumnType('Int')).toBe('int32');
  });

  it('translates the scalar types a Prisma model actually uses', () => {
    const byId = Object.fromEntries(schemaFromDmmf(ORDER).map((c) => [c.id, c.type]));
    expect(byId).toMatchObject({
      id: 'int32',
      reference: 'int64',
      total: 'decimal',
      ratio: 'float64',
      note: 'utf8',
      paid: 'bool',
      createdAt: 'timestamp_tz',
      meta: 'json',
      blob: 'binary',
      customerId: 'int32',
    });
  });

  it('maps an enum field to utf8 rather than inventing a column type', () => {
    expect(schemaFromDmmf(ORDER).find((c) => c.id === 'status')!.type).toBe('utf8');
  });

  it('models a list field as a list carrying its element type', () => {
    const tag = schemaFromDmmf(ORDER).find((c) => c.id === 'tag')!;
    expect(tag.type).toBe('list');
    expect(tag.children).toEqual([{ id: 'item', type: 'utf8' }]);
  });

  it('drops Unsupported() columns, which Prisma Client cannot even select', () => {
    expect(schemaFromDmmf(ORDER).some((c) => c.id === 'geom')).toBe(false);
  });

  it('excludes relation fields by default and includes them on request', () => {
    expect(schemaFromDmmf(ORDER).some((c) => c.id === 'customer')).toBe(false);
    const withRelation = schemaFromDmmf(ORDER, { includeRelation: true });
    expect(withRelation.find((c) => c.id === 'customer')!.type).toBe('struct');
  });

  it('marks optional fields nullable and required fields not', () => {
    const schema = schemaFromDmmf(ORDER);
    expect(schema.find((c) => c.id === 'note')!.nullable).toBe(true);
    expect(schema.find((c) => c.id === 'paid')!.nullable).toBe(false);
  });
});

describe('descriptorFromDmmf / primaryKeyOfDmmf', () => {
  it('finds the @id field', () => {
    expect(primaryKeyOfDmmf(ORDER)).toBe('id');
  });

  it('falls back to a single-column @@id, then to a unique scalar', () => {
    const composite: PrismaDmmfModel = {
      name: 'Thing',
      fields: [{ name: 'code', kind: 'scalar', type: 'String', isRequired: true }],
      primaryKey: { fields: ['code'] },
    };
    expect(primaryKeyOfDmmf(composite)).toBe('code');

    const uniqueOnly: PrismaDmmfModel = {
      name: 'Thing',
      fields: [
        { name: 'name', kind: 'scalar', type: 'String' },
        { name: 'slug', kind: 'scalar', type: 'String', isUnique: true },
      ],
    };
    expect(primaryKeyOfDmmf(uniqueOnly)).toBe('slug');
  });

  it('separates scalar fields from relation fields in the descriptor', () => {
    const descriptor = descriptorFromDmmf(ORDER);
    expect(descriptor.model).toBe('Order');
    expect(descriptor.primaryKey).toBe('id');
    expect(descriptor.relationField).toEqual(['customer']);
    expect(descriptor.field).toContain('customerId');
    expect(descriptor.field).not.toContain('customer');
    expect(descriptor.field).not.toContain('geom');
  });

  it('refuses a model with no usable single-column key instead of guessing', () => {
    const composite: PrismaDmmfModel = {
      name: 'Join',
      fields: [
        { name: 'a', kind: 'scalar', type: 'Int', isRequired: true },
        { name: 'b', kind: 'scalar', type: 'Int', isRequired: true },
      ],
      primaryKey: { fields: ['a', 'b'] },
    };
    expect(() => descriptorFromDmmf(composite)).toThrow(/no single-column primary key/);
    expect(descriptorFromDmmf(composite, 'a').primaryKey).toBe('a');
  });
});

describe('toOrmSyncModel', () => {
  it('produces exactly what @onegrid/orm-sync extractFromPrisma consumes', () => {
    const model = toOrmSyncModel(ORDER);
    // @@map means the CDC stream reports `order_record`, not `Order`.
    expect(model.table).toBe('order_record');
    expect(model.primaryKey).toBe('id');

    const descriptor = extractFromPrisma<Record<string, unknown>>({ ...model, primaryKey: 'id' });
    const byId = Object.fromEntries(toSchema(descriptor).map((c) => [c.id, c.type]));
    expect(byId.reference).toBe('int64');
    expect(byId.total).toBe('decimal');
    expect(byId.status).toBe('utf8');
    expect(byId.customer).toBeUndefined();
  });
});

describe('normalizePrismaRow', () => {
  it('stringifies bigints, which JSON.stringify refuses to serialise', () => {
    const row = normalizePrismaRow({ id: 1, ref: 9007199254740993n });
    expect(row.ref).toBe('9007199254740993');
    expect(() => JSON.stringify(row)).not.toThrow();
  });

  it('stringifies Decimal-like values instead of leaking Decimal.js internals', () => {
    const decimal = { toFixed: () => '12.34', toString: () => '12.34' };
    expect(normalizePrismaRow({ total: decimal }).total).toBe('12.34');
  });

  it('leaves Dates and arrays alone', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const row = normalizePrismaRow({ when, tag: ['a', 'b'] });
    expect(row.when).toBe(when);
    expect(row.tag).toEqual(['a', 'b']);
  });

  it('opts into lossy number encoding only when asked', () => {
    expect(normalizePrismaRow({ ref: 5n }, { wideNumber: 'number' }).ref).toBe(5);
    expect(normalizePrismaRow({ ref: 5n }).ref).toBe('5');
  });
});

// -----------------------------------------------------------------------------
// Live sync
// -----------------------------------------------------------------------------

const IMMEDIATE: PrismaCdcScheduler = {
  setInterval: () => 'handle',
  clearInterval: () => undefined,
};

function createPollDelegate(batch: Record<string, unknown>[][]) {
  const arg: unknown[] = [];
  const delegate: PrismaDelegate = {
    findMany(a) {
      arg.push(a);
      return Promise.resolve(batch.shift() ?? []);
    },
    groupBy: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    create: () => Promise.resolve({}),
    update: () => Promise.resolve({}),
    delete: () => Promise.resolve({}),
  };
  return { delegate, arg };
}

describe('createPrismaCdcAdapter', () => {
  it('polls the watermark column and emits one diff per row', async () => {
    const poll = createPollDelegate([
      [
        { id: 1, updatedAt: 10, status: 'a' },
        { id: 2, updatedAt: 11, status: 'b' },
      ],
    ]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      scheduler: IMMEDIATE,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    expect(await cdc.poll()).toBe(2);
    expect(seen.map((d) => d.pkey)).toEqual([1, 2]);
    expect(seen.map((d) => d.version)).toEqual([0, 1]);
    expect(cdc.lastWatermark()).toBe(11);
    expect(poll.arg[0]).toEqual({
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    cdc.close();
  });

  it('re-reads the boundary inclusively but does not re-emit what it delivered', async () => {
    const poll = createPollDelegate([
      [{ id: 1, updatedAt: 10 }],
      // Second poll sees the same row again (gte boundary) plus a new sibling
      // written in the same tick — the sibling must come through, the
      // duplicate must not.
      [
        { id: 1, updatedAt: 10 },
        { id: 2, updatedAt: 10 },
      ],
    ]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      scheduler: IMMEDIATE,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    await cdc.poll();
    expect(seen.map((d) => d.pkey)).toEqual([1, 2]);
    expect((poll.arg[1] as { where: unknown }).where).toEqual({ updatedAt: { gte: 10 } });
    cdc.close();
  });

  it('classifies a first write as insert when createdField is configured', async () => {
    const poll = createPollDelegate([
      [
        { id: 1, updatedAt: 7, createdAt: 7 },
        { id: 2, updatedAt: 8, createdAt: 3 },
      ],
    ]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      createdField: 'createdAt',
      scheduler: IMMEDIATE,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    expect(seen.map((d) => d.kind)).toEqual(['insert', 'update']);
    cdc.close();
  });

  it('emits a delete for a soft-deleted row and carries no fields', async () => {
    const poll = createPollDelegate([[{ id: 1, updatedAt: 1, deletedAt: '2026-01-01' }]]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      softDeleteField: 'deletedAt',
      scheduler: IMMEDIATE,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    expect(seen[0]).toEqual({ kind: 'delete', version: 0, pkey: 1 });
    cdc.close();
  });

  it('compares Date watermarks by instant, not identity', async () => {
    const t1 = new Date('2026-01-01T00:00:00Z');
    const poll = createPollDelegate([
      [{ id: 1, updatedAt: t1, createdAt: new Date(t1.getTime()) }],
    ]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      createdField: 'createdAt',
      scheduler: IMMEDIATE,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    expect(seen[0]!.kind).toBe('insert');
    cdc.close();
  });

  it('replays retained history and snapshots once the window has rolled past', async () => {
    const poll = createPollDelegate([
      [
        { id: 1, updatedAt: 1 },
        { id: 2, updatedAt: 2 },
        { id: 3, updatedAt: 3 },
      ],
    ]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      historySize: 2,
      scheduler: IMMEDIATE,
    });
    cdc.subscribe(() => undefined);
    await cdc.poll();
    const replay = await cdc.resync({ fromVersion: 1 });
    expect(replay.diffs.map((d) => d.version)).toEqual([2]);
    const stale = await cdc.resync({ fromVersion: -1 });
    expect(stale.snapshot).toBe(true);
    cdc.close();
  });

  it('reports a failed poll through onError instead of rejecting', async () => {
    const delegate: PrismaDelegate = {
      findMany: () => Promise.reject(new Error('P1001: cannot reach database')),
      groupBy: () => Promise.resolve([]),
      count: () => Promise.resolve(0),
      create: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      delete: () => Promise.resolve({}),
    };
    const error: unknown[] = [];
    const cdc = createPrismaCdcAdapter({
      delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      onError: (e) => error.push(e),
      scheduler: IMMEDIATE,
    });
    cdc.subscribe(() => undefined);
    await expect(cdc.poll()).resolves.toBe(0);
    expect((error[0] as Error).message).toContain('P1001');
    cdc.close();
  });
});

describe('bindPrismaSync', () => {
  interface OrderRow {
    id: number;
    status: string;
  }

  it('delivers ORM-typed rows through @onegrid/orm-sync', async () => {
    const poll = createPollDelegate([
      [
        { id: 1, updatedAt: 1, status: 'active' },
        { id: 2, updatedAt: 2, status: 'closed' },
      ],
    ]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      scheduler: IMMEDIATE,
    });
    const seen: { pkey: number; status: string | undefined }[] = [];
    const handle = bindPrismaSync<OrderRow>({
      model: toOrmSyncModel({
        name: 'Order',
        fields: [
          { name: 'id', kind: 'scalar', type: 'Int', isId: true, isRequired: true },
          { name: 'status', kind: 'scalar', type: 'String', isRequired: true },
        ],
      }),
      cdc,
      onDiff: (diff) => {
        seen.push({ pkey: Number(diff.pkey), status: diff.row?.status });
      },
    });
    await cdc.poll();
    expect(seen).toEqual([
      { pkey: 1, status: 'active' },
      { pkey: 2, status: 'closed' },
    ]);
    expect(handle.lastVersion()).toBe(1);
    await handle.close();
    cdc.close();
  });

  it('routes a manual resync request through the bound handle', async () => {
    const poll = createPollDelegate([[{ id: 1, updatedAt: 1 }]]);
    const cdc = createPrismaCdcAdapter({
      delegate: poll.delegate,
      watermarkField: 'updatedAt',
      primaryKey: 'id',
      scheduler: IMMEDIATE,
    });
    const handle = bindPrismaSync<OrderRow>({
      model: toOrmSyncModel({
        name: 'Order',
        fields: [{ name: 'id', kind: 'scalar', type: 'Int', isId: true, isRequired: true }],
      }),
      cdc,
      onDiff: () => undefined,
    });
    await cdc.poll();
    const replay = await handle.resync({ fromVersion: -1 });
    expect(replay.diffs.map((d) => d.pkey)).toEqual([1]);
    await handle.close();
    cdc.close();
  });
});
