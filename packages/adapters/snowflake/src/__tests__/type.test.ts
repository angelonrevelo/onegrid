// =============================================================================
// Snowflake type mapping — unit tests. The precision-dependent NUMBER
// rules are the ones that matter: NUMBER(38,0) landing on float64
// would corrupt ids in the millions of rows a warehouse grid exists to
// show.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  buildSnowflakeSchema,
  isBigIntSafeRequired,
  parseSnowflakeType,
  snowflakeColumnType,
} from '../type';

describe('parseSnowflakeType', () => {
  it('splits base type from precision and scale', () => {
    expect(parseSnowflakeType('NUMBER(38,0)')).toEqual({ base: 'NUMBER', precision: 38, scale: 0 });
    expect(parseSnowflakeType('varchar(16777216)')).toEqual({
      base: 'VARCHAR',
      precision: 16777216,
      scale: null,
    });
    expect(parseSnowflakeType('VARIANT')).toEqual({
      base: 'VARIANT',
      precision: null,
      scale: null,
    });
  });
});

describe('snowflakeColumnType', () => {
  it('keeps NUMBER(38,0) on the BigInt-safe int64 path', () => {
    expect(snowflakeColumnType('NUMBER(38,0)')).toBe('int64');
    expect(snowflakeColumnType('NUMBER')).toBe('int64');
    expect(snowflakeColumnType('BIGINT')).toBe('int64');
  });

  it('narrows small-precision integers to int32', () => {
    expect(snowflakeColumnType('NUMBER(9,0)')).toBe('int32');
    expect(snowflakeColumnType('NUMBER(10,0)')).toBe('int64');
  });

  it('maps scaled numerics to decimal', () => {
    expect(snowflakeColumnType('NUMBER(12,2)')).toBe('decimal');
    expect(snowflakeColumnType('DECIMAL(38,9)')).toBe('decimal');
  });

  it('distinguishes the three timestamp flavours', () => {
    expect(snowflakeColumnType('TIMESTAMP_NTZ(9)')).toBe('timestamp');
    expect(snowflakeColumnType('TIMESTAMP_TZ(9)')).toBe('timestamp_tz');
    expect(snowflakeColumnType('TIMESTAMP_LTZ(9)')).toBe('timestamp_tz');
  });

  it('maps the semi-structured trio by their actual shape', () => {
    expect(snowflakeColumnType('VARIANT')).toBe('json');
    expect(snowflakeColumnType('OBJECT')).toBe('map');
    expect(snowflakeColumnType('ARRAY')).toBe('list');
  });

  it('maps GEOGRAPHY / GEOMETRY to json (GeoJSON is the default output)', () => {
    expect(snowflakeColumnType('GEOGRAPHY')).toBe('json');
    expect(snowflakeColumnType('GEOMETRY')).toBe('json');
  });

  it('covers the scalar types and degrades unknowns instead of throwing', () => {
    expect(snowflakeColumnType('VARCHAR(255)')).toBe('utf8');
    expect(snowflakeColumnType('BOOLEAN')).toBe('bool');
    expect(snowflakeColumnType('BINARY')).toBe('binary');
    expect(snowflakeColumnType('DATE')).toBe('date32');
    expect(snowflakeColumnType('TIME(9)')).toBe('time64');
    expect(snowflakeColumnType('FLOAT')).toBe('float64');
    expect(snowflakeColumnType('SOMETHING_NEW')).toBe('unknown');
  });
});

describe('isBigIntSafeRequired', () => {
  it('flags integers wider than float64 can represent exactly', () => {
    expect(isBigIntSafeRequired('NUMBER(38,0)')).toBe(true);
    expect(isBigIntSafeRequired('NUMBER')).toBe(true);
    expect(isBigIntSafeRequired('NUMBER(15,0)')).toBe(false);
    expect(isBigIntSafeRequired('NUMBER(38,2)')).toBe(false);
    expect(isBigIntSafeRequired('VARCHAR(16)')).toBe(false);
  });
});

describe('buildSnowflakeSchema', () => {
  it('carries precision, scale, nullability and timezone through', () => {
    const schema = buildSnowflakeSchema(
      [
        { name: 'ID', type: 'NUMBER(38,0)', nullable: false },
        { name: 'PRICE', type: 'NUMBER(12,2)', nullable: true, displayName: 'Price' },
        { name: 'SEEN_AT', type: 'TIMESTAMP_LTZ(9)' },
        { name: 'PAYLOAD', type: 'VARIANT' },
      ],
      { sessionTimezone: 'Asia/Manila' },
    );
    expect(schema).toEqual([
      { id: 'ID', type: 'int64', nullable: false },
      { id: 'PRICE', type: 'decimal', nullable: true, displayName: 'Price', precision: 12, scale: 2 },
      { id: 'SEEN_AT', type: 'timestamp_tz', timezone: 'Asia/Manila' },
      { id: 'PAYLOAD', type: 'json' },
    ]);
  });

  it('defaults the session timezone to UTC', () => {
    const schema = buildSnowflakeSchema([{ name: 'T', type: 'TIMESTAMP_TZ' }]);
    expect(schema[0]!.timezone).toBe('UTC');
  });
});
