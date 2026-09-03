// =============================================================================
// Snowflake type → oneGrid ColumnType mapping.
//
// Snowflake's type system is narrow (every numeric is a NUMBER, every
// string is a VARCHAR) but its *precision* carries the information the
// grid needs, so the mapping is parameter-aware rather than a flat
// lookup table:
//
//   NUMBER(p,0) with p ≤ 9   → int32   (fits an i32 column vector)
//   NUMBER(p,0) with p > 9   → int64   (NUMBER(38,0) is the default
//                                       integer, and 10^38 blows past
//                                       float64's 2^53 exact range —
//                                       so it MUST stay on the
//                                       BigInt-safe path, exactly as
//                                       the Postgres adapter keeps
//                                       int8 there.)
//   NUMBER(p,s) with s > 0   → decimal, with precision + scale carried
//                              through so the formatter can round
//                              without guessing.
//
// The three timestamp flavours matter too. TIMESTAMP_NTZ has no zone
// and maps to `timestamp`; TIMESTAMP_TZ and TIMESTAMP_LTZ are
// zone-aware and map to `timestamp_tz`, where LTZ's zone is the
// session's — the adopter passes `sessionTimezone` so the schema can
// name it instead of leaving the client to assume UTC.
//
// VARIANT / OBJECT / ARRAY are Snowflake's semi-structured trio. Only
// ARRAY has a genuine list shape; VARIANT is a tagged union that can
// hold any JSON, so it maps to `json` rather than `struct` — the grid
// renders it as a JSON cell instead of pretending it has fixed fields.
//
// GEOGRAPHY / GEOMETRY serialise as GeoJSON by default
// (GEOGRAPHY_OUTPUT_FORMAT), so they map to `json`. An adopter who
// sets the session to WKT gets strings, and should override to `utf8`.
// =============================================================================

import type { ColumnSchema, ColumnType, Schema } from '@onegrid/protocol';

/** One row of `DESCRIBE TABLE` / `INFORMATION_SCHEMA.COLUMNS`. */
export interface SnowflakeColumnDescription {
  /** Column name as Snowflake stores it (usually upper case). */
  readonly name: string;
  /** Snowflake type text, e.g. `NUMBER(38,0)`, `TIMESTAMP_NTZ(9)`. */
  readonly type: string;
  readonly nullable?: boolean;
  readonly displayName?: string;
}

export interface SnowflakeTypeOptions {
  /** IANA zone recorded on TIMESTAMP_LTZ columns, i.e. the session's
   *  TIMEZONE parameter. Defaults to `UTC`. */
  readonly sessionTimezone?: string;
}

interface ParsedType {
  readonly base: string;
  readonly precision: number | null;
  readonly scale: number | null;
}

/**
 * Parse `NUMBER(38,0)` / `VARCHAR(16777216)` / `TIMESTAMP_NTZ(9)` into
 * base + parameters. Unparameterised types come back with nulls.
 */
export function parseSnowflakeType(raw: string): ParsedType {
  const text = raw.trim();
  const open = text.indexOf('(');
  if (open === -1) {
    return { base: text.toUpperCase(), precision: null, scale: null };
  }
  const base = text.slice(0, open).trim().toUpperCase();
  const inner = text.slice(open + 1, text.lastIndexOf(')'));
  const part = inner.split(',').map((p) => Number.parseInt(p.trim(), 10));
  const precision = Number.isFinite(part[0]) ? (part[0] as number) : null;
  const scale = part.length > 1 && Number.isFinite(part[1]) ? (part[1] as number) : null;
  return { base, precision, scale };
}

/**
 * Map a Snowflake type to the protocol's ColumnType. Unknown types
 * degrade to `unknown` rather than throwing — a new Snowflake type
 * should not take a grid down.
 */
export function snowflakeColumnType(raw: string): ColumnType {
  const { base, precision, scale } = parseSnowflakeType(raw);
  switch (base) {
    case 'NUMBER':
    case 'DECIMAL':
    case 'NUMERIC':
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
    case 'TINYINT':
    case 'BYTEINT':
      if (scale !== null && scale > 0) return 'decimal';
      // Snowflake defaults an unparameterised INT to NUMBER(38,0),
      // so "no precision" is the WIDE case, not the narrow one.
      if (precision !== null && precision <= 9) return 'int32';
      return 'int64';
    case 'FLOAT':
    case 'FLOAT4':
    case 'FLOAT8':
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'REAL':
      return 'float64';
    case 'VARCHAR':
    case 'CHAR':
    case 'CHARACTER':
    case 'STRING':
    case 'TEXT':
      return 'utf8';
    case 'BOOLEAN':
      return 'bool';
    case 'BINARY':
    case 'VARBINARY':
      return 'binary';
    case 'DATE':
      return 'date32';
    case 'TIME':
      return 'time64';
    case 'DATETIME':
    case 'TIMESTAMP':
    case 'TIMESTAMP_NTZ':
      return 'timestamp';
    case 'TIMESTAMP_TZ':
    case 'TIMESTAMP_LTZ':
      return 'timestamp_tz';
    case 'ARRAY':
      return 'list';
    case 'OBJECT':
    case 'MAP':
      return 'map';
    case 'VARIANT':
      return 'json';
    case 'GEOGRAPHY':
    case 'GEOMETRY':
      return 'json';
    default:
      return 'unknown';
  }
}

/**
 * True when a Snowflake type can hold values outside float64's exact
 * integer range, so the driver must keep it as a string/BigInt rather
 * than coercing to a JS number. NUMBER(38,0) — Snowflake's default
 * integer — is the headline case.
 */
export function isBigIntSafeRequired(raw: string): boolean {
  const { base, precision, scale } = parseSnowflakeType(raw);
  const numeric =
    base === 'NUMBER' ||
    base === 'DECIMAL' ||
    base === 'NUMERIC' ||
    base === 'INT' ||
    base === 'INTEGER' ||
    base === 'BIGINT';
  if (!numeric) return false;
  if (scale !== null && scale > 0) return false;
  // 15 decimal digits is the last width fully representable in a
  // float64; anything wider (or unparameterised, which means 38) has
  // to stay off the number path.
  return precision === null || precision > 15;
}

/**
 * Build a protocol `Schema` from a `DESCRIBE TABLE` result. Decimal
 * columns carry precision/scale; TIMESTAMP_TZ/LTZ carry a timezone.
 */
export function buildSnowflakeSchema(
  column: ReadonlyArray<SnowflakeColumnDescription>,
  opts: SnowflakeTypeOptions = {},
): Schema {
  const timezone = opts.sessionTimezone ?? 'UTC';
  return column.map((c): ColumnSchema => {
    const type = snowflakeColumnType(c.type);
    const { precision, scale } = parseSnowflakeType(c.type);
    return {
      id: c.name,
      type,
      ...(c.nullable === undefined ? {} : { nullable: c.nullable }),
      ...(c.displayName === undefined ? {} : { displayName: c.displayName }),
      ...(type === 'decimal' && precision !== null ? { precision } : {}),
      ...(type === 'decimal' && scale !== null ? { scale } : {}),
      ...(type === 'timestamp_tz' ? { timezone } : {}),
    };
  });
}
