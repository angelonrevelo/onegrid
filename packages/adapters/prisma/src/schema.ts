// =============================================================================
// Prisma DMMF → oneGrid Schema.
//
// Prisma ships its schema as runtime metadata: `Prisma.dmmf.datamodel.models`
// is a plain object describing every model, field, kind and relation. That is
// enough to derive a oneGrid `Schema` without a code generator and without
// importing `@prisma/client` — the adapter takes the DMMF shape structurally,
// so the adopter passes `Prisma.dmmf.datamodel.models.find(m => m.name === 'Order')`
// and nothing links against Prisma at build time.
//
// The decision that actually matters here is which Prisma types are allowed
// onto the float64 path, and the answer is: neither of the two that people
// assume. `BigInt` maps to `int64` and `Decimal` maps to `decimal`, never to
// `float64`. A Prisma `BigInt` column arrives in JS as a native `bigint`
// precisely because it can exceed 2^53, and a `Decimal` arrives as a
// Decimal.js instance precisely because binary floating point cannot
// represent 0.1. Coercing either through `Number()` — which is what a
// `float64` column type invites a renderer to do — is a correctness bug that
// only shows up on the rows that matter: large ids and money.
//
// `normalizePrismaRow` is the other half of that promise. It converts both
// types to strings on the way out, because `JSON.stringify` throws outright
// on a `bigint` and silently serialises a Decimal.js object into
// `{"s":1,"e":2,"d":[...]}`.
// =============================================================================

import type { ColumnSchema, ColumnType, Schema } from '@onegrid/protocol';
import type { PrismaModelDescriptor } from './query';

// -----------------------------------------------------------------------------
// DMMF shapes — structural, matching what `Prisma.dmmf` actually contains
// -----------------------------------------------------------------------------

/** DMMF field kinds. `unsupported` covers `Unsupported("…")` columns. */
export type PrismaFieldKind = 'scalar' | 'object' | 'enum' | 'unsupported';

export interface PrismaDmmfField {
  readonly name: string;
  readonly kind: PrismaFieldKind;
  /** Scalar type name (`Int`, `BigInt`, `Decimal`, …) or the related model. */
  readonly type: string;
  readonly isList?: boolean;
  readonly isRequired?: boolean;
  readonly isId?: boolean;
  readonly isUnique?: boolean;
  readonly relationName?: string;
  /** Scalar fields on THIS model that hold the foreign key. */
  readonly relationFromFields?: ReadonlyArray<string>;
  readonly documentation?: string;
}

export interface PrismaDmmfModel {
  readonly name: string;
  /** `@@map`ped table name when it differs from the model name. */
  readonly dbName?: string | null;
  readonly fields: ReadonlyArray<PrismaDmmfField>;
  /** Present only for `@@id([...])` composite keys. */
  readonly primaryKey?: { readonly fields: ReadonlyArray<string> } | null;
}

// -----------------------------------------------------------------------------
// Type mapping
// -----------------------------------------------------------------------------

const TYPE_MAP: Record<string, ColumnType> = {
  Int: 'int32',
  // Prisma hands these to JS as `bigint` and `Decimal`. Keeping them off
  // float64 is the whole point — see the header.
  BigInt: 'int64',
  Decimal: 'decimal',
  Float: 'float64',
  String: 'utf8',
  Boolean: 'bool',
  // Prisma always stores DateTime in UTC and returns a JS `Date`; the
  // timezone-aware column type is the honest match.
  DateTime: 'timestamp_tz',
  Json: 'json',
  Bytes: 'binary',
};

export function prismaTypeToColumnType(type: string): ColumnType {
  return TYPE_MAP[type] ?? 'unknown';
}

export interface SchemaFromDmmfOptions {
  /**
   * Emit relation fields as columns. Off by default: a relation is not a
   * scalar the grid can sort or filter, and surfacing it as a column produces
   * a column that looks editable and is not. Turn it on when the adopter
   * hydrates relations via `select` and renders them with a custom cell.
   */
  readonly includeRelation?: boolean;
}

/**
 * Translate one DMMF model into a oneGrid `Schema`.
 *
 * Enums become `utf8`: the grid renders the variant name, and treating them
 * as a distinct column type would force every consumer to special-case
 * something that behaves exactly like a constrained string.
 */
export function schemaFromDmmf(
  model: PrismaDmmfModel,
  options: SchemaFromDmmfOptions = {},
): Schema {
  const out: ColumnSchema[] = [];
  for (const field of model.fields) {
    if (field.kind === 'object' && !options.includeRelation) continue;
    const column = columnFromField(field);
    if (column) out.push(column);
  }
  return out;
}

function columnFromField(field: PrismaDmmfField): ColumnSchema | null {
  if (field.kind === 'unsupported') {
    // `Unsupported("geometry")` columns cannot be read by Prisma Client at
    // all — it refuses to select them. Reporting one as a column would
    // promise data the adapter can never deliver.
    return null;
  }
  const base: ColumnType =
    field.kind === 'enum'
      ? 'utf8'
      : field.kind === 'object'
        ? 'struct'
        : prismaTypeToColumnType(field.type);

  const nullable = field.isRequired !== true;
  if (field.isList) {
    // A list column carries its element type as the single child, which is
    // how the protocol's `list` type is meant to be populated.
    return {
      id: field.name,
      type: 'list',
      nullable,
      children: [{ id: 'item', type: base }],
    };
  }
  return { id: field.name, type: base, nullable };
}

// -----------------------------------------------------------------------------
// Descriptor
// -----------------------------------------------------------------------------

/**
 * Find the model's single-column primary key. Composite `@@id` keys return
 * null: Prisma addresses them with a synthetic compound key object
 * (`{ where: { a_b: { a, b } } }`) that cannot serve as a flat cursor value,
 * so the adopter must nominate a unique scalar instead.
 */
export function primaryKeyOfDmmf(model: PrismaDmmfModel): string | null {
  const id = model.fields.find((f) => f.isId === true && f.isList !== true);
  if (id) return id.name;
  if (model.primaryKey && model.primaryKey.fields.length === 1) {
    return model.primaryKey.fields[0] ?? null;
  }
  const unique = model.fields.find((f) => f.isUnique === true && f.kind === 'scalar');
  return unique?.name ?? null;
}

/**
 * Build the descriptor the query compiler validates against, straight from
 * DMMF. `primaryKey` overrides the derived one — necessary for composite-key
 * models and for anyone who wants to paginate on a different unique column.
 */
export function descriptorFromDmmf(
  model: PrismaDmmfModel,
  primaryKey?: string,
): PrismaModelDescriptor {
  const key = primaryKey ?? primaryKeyOfDmmf(model);
  if (!key) {
    throw new Error(
      `@onegrid/prisma: model "${model.name}" has no single-column primary key. Pass one explicitly — cursor pagination needs a unique scalar.`,
    );
  }
  const field: string[] = [];
  const relationField: string[] = [];
  for (const f of model.fields) {
    if (f.kind === 'unsupported') continue;
    if (f.kind === 'object') relationField.push(f.name);
    else field.push(f.name);
  }
  return {
    model: model.name,
    field,
    primaryKey: key,
    ...(relationField.length > 0 ? { relationField } : {}),
  };
}

// -----------------------------------------------------------------------------
// orm-sync bridge input
// -----------------------------------------------------------------------------

/** The field shape `extractFromPrisma` in `@onegrid/orm-sync` consumes. */
export interface PrismaSyncField {
  readonly name: string;
  readonly type: string;
  readonly isRequired?: boolean;
}

/** The options object `extractFromPrisma` in `@onegrid/orm-sync` consumes. */
export interface PrismaSyncModel {
  readonly table: string;
  readonly primaryKey: string;
  readonly fields: ReadonlyArray<PrismaSyncField>;
}

/**
 * Project a DMMF model into the exact input `@onegrid/orm-sync`'s
 * `extractFromPrisma` expects, so live-sync descriptors come from the same
 * source of truth as the grid schema instead of being retyped by hand.
 *
 * `table` uses the `@@map`ped database name when there is one, because that
 * is the identifier a CDC stream reports — the ORM model name never reaches
 * the replication slot.
 */
export function toOrmSyncModel(
  model: PrismaDmmfModel,
  primaryKey?: string,
): PrismaSyncModel {
  const key = primaryKey ?? primaryKeyOfDmmf(model);
  if (!key) {
    throw new Error(
      `@onegrid/prisma: model "${model.name}" has no single-column primary key; orm-sync needs one to key row diffs.`,
    );
  }
  return {
    table: model.dbName ?? model.name,
    primaryKey: key,
    fields: model.fields
      .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
      .map((f) => ({
        name: f.name,
        type: f.kind === 'enum' ? 'String' : f.type,
        isRequired: f.isRequired === true,
      })),
  };
}

// -----------------------------------------------------------------------------
// Row normalisation
// -----------------------------------------------------------------------------

/** Anything with a `toFixed` — Decimal.js, and Prisma returns one per column. */
interface DecimalLike {
  toFixed(): string;
  toString(): string;
}

function isDecimalLike(value: unknown): value is DecimalLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function' &&
    !(value instanceof Date)
  );
}

export interface NormalizeOptions {
  /**
   * How to encode `bigint` and `Decimal`. `'string'` (default) preserves
   * every digit and survives `JSON.stringify`. `'number'` is available for
   * adopters who know their values fit in a double and want arithmetic on the
   * client — it is lossy above 2^53 by definition.
   */
  readonly wideNumber?: 'string' | 'number';
}

/**
 * Make one Prisma row safe to serialise.
 *
 * `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`
 * on a bigint and quietly emits Decimal.js internals for a Decimal, so a row
 * that came straight off `findMany` cannot go over the wire untouched. Dates
 * are left alone — `JSON.stringify` already emits ISO-8601 for them, and the
 * grid's date formatters want the `Date`.
 */
export function normalizePrismaRow(
  row: Record<string, unknown>,
  options: NormalizeOptions = {},
): Record<string, unknown> {
  const wide = options.wideNumber ?? 'string';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') {
      out[key] = wide === 'number' ? Number(value) : value.toString();
    } else if (isDecimalLike(value)) {
      out[key] = wide === 'number' ? Number(value.toString()) : value.toString();
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
      out[key] = normalizePrismaRow(value as Record<string, unknown>, options);
    } else {
      out[key] = value;
    }
  }
  return out;
}
