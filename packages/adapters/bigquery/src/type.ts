// =============================================================================
// BigQuery type → oneGrid ColumnType mapping.
//
// BigQuery's schema surface has two vocabularies for the same types —
// the legacy REST names (`INTEGER`, `FLOAT`, `BOOLEAN`, `RECORD`) and
// the GoogleSQL names (`INT64`, `FLOAT64`, `BOOL`, `STRUCT`) — and the
// client library hands back whichever the API felt like. Both are
// accepted here, because an adapter that only understood one of them
// would break depending on how the caller fetched its schema.
//
// The mode field is orthogonal to the type: `REPEATED` makes any type
// an ARRAY, so it is checked before the type itself.
//
// Width decisions that matter:
//   INT64      → int64. BigQuery's ONLY integer type is 64-bit, so
//                every integer column exceeds float64's exact range
//                and must stay on the BigInt-safe path — the client
//                library returns them as `BigQueryInt` wrappers for
//                exactly this reason. Same call the Postgres adapter
//                makes for int8, and the Snowflake adapter for
//                NUMBER(38,0).
//   NUMERIC    → decimal, precision 38 scale 9 (fixed by BigQuery).
//   BIGNUMERIC → decimal, precision 76 scale 38 (fixed by BigQuery).
//   DATETIME   → timestamp (civil, no zone).
//   TIMESTAMP  → timestamp_tz; BigQuery stores an absolute instant and
//                the API renders it in UTC, so the zone is UTC and not
//                a caller preference.
//   GEOGRAPHY  → utf8. BigQuery returns WKT text, not GeoJSON — the
//                opposite of Snowflake, whose default output is
//                GeoJSON and therefore maps to `json`.
// =============================================================================

import type { ColumnSchema, ColumnType, Schema } from '@onegrid/protocol';

/** A field as it appears in a BigQuery table schema. */
export interface BqFieldDescription {
  readonly name: string;
  /** `INT64`/`INTEGER`, `STRING`, `STRUCT`/`RECORD`, … */
  readonly type: string;
  /** `NULLABLE` (default), `REQUIRED` or `REPEATED`. */
  readonly mode?: string;
  readonly description?: string;
  /** Sub-fields for STRUCT/RECORD. */
  readonly fields?: ReadonlyArray<BqFieldDescription>;
}

/** Fixed precision/scale of BigQuery's two exact numeric types. */
const NUMERIC_PRECISION = { NUMERIC: { precision: 38, scale: 9 }, BIGNUMERIC: { precision: 76, scale: 38 } } as const;

/**
 * Map a BigQuery type name to the protocol's ColumnType, ignoring
 * mode. Unknown types degrade to `unknown` rather than throwing — a
 * newly released BigQuery type should not take a grid down.
 */
export function bqColumnType(raw: string): ColumnType {
  switch (raw.trim().toUpperCase()) {
    case 'INT64':
    case 'INTEGER':
      return 'int64';
    case 'NUMERIC':
    case 'DECIMAL':
    case 'BIGNUMERIC':
    case 'BIGDECIMAL':
      return 'decimal';
    case 'FLOAT64':
    case 'FLOAT':
      return 'float64';
    case 'BOOL':
    case 'BOOLEAN':
      return 'bool';
    case 'STRING':
      return 'utf8';
    case 'BYTES':
      return 'binary';
    case 'DATE':
      return 'date32';
    case 'TIME':
      return 'time64';
    case 'DATETIME':
      return 'timestamp';
    case 'TIMESTAMP':
      return 'timestamp_tz';
    case 'STRUCT':
    case 'RECORD':
      return 'struct';
    case 'ARRAY':
      return 'list';
    case 'JSON':
      return 'json';
    case 'GEOGRAPHY':
      // WKT text, not GeoJSON — BigQuery's default GEOGRAPHY rendering.
      return 'utf8';
    case 'INTERVAL':
      return 'utf8';
    default:
      return 'unknown';
  }
}

/**
 * True when a BigQuery type can hold values outside float64's exact
 * integer range. INT64 is the headline case, and since it is
 * BigQuery's only integer type, every integer column qualifies.
 */
export function isBigIntSafeRequired(raw: string): boolean {
  const type = raw.trim().toUpperCase();
  return type === 'INT64' || type === 'INTEGER' || type === 'BIGNUMERIC' || type === 'BIGDECIMAL';
}

/**
 * Build a protocol `Schema` from a BigQuery table schema. REPEATED
 * fields become `list` with the element type as their single child;
 * STRUCT/RECORD fields recurse into `children`.
 */
export function buildBqSchema(field: ReadonlyArray<BqFieldDescription>): Schema {
  return field.map((f) => toColumnSchema(f));
}

function toColumnSchema(field: BqFieldDescription): ColumnSchema {
  const base = bqColumnType(field.type);
  const child =
    field.fields && field.fields.length > 0
      ? field.fields.map((f) => toColumnSchema(f))
      : undefined;
  const numeric =
    NUMERIC_PRECISION[field.type.trim().toUpperCase() as keyof typeof NUMERIC_PRECISION];

  // REPEATED wraps whatever the field's own type is, so the element
  // type moves down into `children` and the column becomes a list.
  if (field.mode?.toUpperCase() === 'REPEATED') {
    return {
      id: field.name,
      type: 'list',
      nullable: false,
      ...(field.description === undefined ? {} : { displayName: field.description }),
      children: [
        {
          id: 'element',
          type: base,
          ...(child ? { children: child } : {}),
        },
      ],
    };
  }

  return {
    id: field.name,
    type: base,
    nullable: field.mode?.toUpperCase() !== 'REQUIRED',
    ...(field.description === undefined ? {} : { displayName: field.description }),
    ...(numeric ? { precision: numeric.precision, scale: numeric.scale } : {}),
    ...(base === 'timestamp_tz' ? { timezone: 'UTC' } : {}),
    ...(child ? { children: child } : {}),
  };
}

/**
 * Column id → BigQuery type map, the shape `BqTableDescriptor.columnType`
 * wants. Built from the same schema so parameter types and column
 * types can never drift apart.
 */
export function buildColumnTypeMap(
  field: ReadonlyArray<BqFieldDescription>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of field) {
    out[f.name] = f.type.trim().toUpperCase();
  }
  return out;
}
