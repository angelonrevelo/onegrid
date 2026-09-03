// =============================================================================
// BigQuery type mapping — unit tests. Both vocabularies (legacy REST
// `INTEGER`/`RECORD` and GoogleSQL `INT64`/`STRUCT`) must map
// identically, because which one you get depends on how the schema was
// fetched.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  bqColumnType,
  buildBqSchema,
  buildColumnTypeMap,
  isBigIntSafeRequired,
} from '../type';

describe('bqColumnType', () => {
  it('keeps INT64 — BigQuery\'s only integer type — on the int64 path', () => {
    expect(bqColumnType('INT64')).toBe('int64');
    expect(bqColumnType('INTEGER')).toBe('int64');
  });

  it('maps both exact numerics to decimal', () => {
    expect(bqColumnType('NUMERIC')).toBe('decimal');
    expect(bqColumnType('BIGNUMERIC')).toBe('decimal');
  });

  it('accepts the legacy REST names alongside the GoogleSQL ones', () => {
    expect(bqColumnType('FLOAT')).toBe(bqColumnType('FLOAT64'));
    expect(bqColumnType('BOOLEAN')).toBe(bqColumnType('BOOL'));
    expect(bqColumnType('RECORD')).toBe(bqColumnType('STRUCT'));
  });

  it('separates civil DATETIME from absolute TIMESTAMP', () => {
    expect(bqColumnType('DATETIME')).toBe('timestamp');
    expect(bqColumnType('TIMESTAMP')).toBe('timestamp_tz');
  });

  it('maps STRUCT, ARRAY and JSON to their protocol shapes', () => {
    expect(bqColumnType('STRUCT')).toBe('struct');
    expect(bqColumnType('ARRAY')).toBe('list');
    expect(bqColumnType('JSON')).toBe('json');
  });

  it('maps GEOGRAPHY to utf8 because BigQuery renders it as WKT', () => {
    expect(bqColumnType('GEOGRAPHY')).toBe('utf8');
  });

  it('covers the remaining scalars and degrades unknowns instead of throwing', () => {
    expect(bqColumnType('STRING')).toBe('utf8');
    expect(bqColumnType('BYTES')).toBe('binary');
    expect(bqColumnType('DATE')).toBe('date32');
    expect(bqColumnType('TIME')).toBe('time64');
    expect(bqColumnType('SOMETHING_NEW')).toBe('unknown');
  });
});

describe('isBigIntSafeRequired', () => {
  it('flags every integer column, since all of them are 64-bit', () => {
    expect(isBigIntSafeRequired('INT64')).toBe(true);
    expect(isBigIntSafeRequired('INTEGER')).toBe(true);
    expect(isBigIntSafeRequired('BIGNUMERIC')).toBe(true);
    expect(isBigIntSafeRequired('NUMERIC')).toBe(false);
    expect(isBigIntSafeRequired('STRING')).toBe(false);
  });
});

describe('buildBqSchema', () => {
  it('carries nullability, fixed numeric precision and the UTC zone', () => {
    expect(
      buildBqSchema([
        { name: 'id', type: 'INT64', mode: 'REQUIRED' },
        { name: 'price', type: 'NUMERIC', mode: 'NULLABLE', description: 'Price' },
        { name: 'huge', type: 'BIGNUMERIC' },
        { name: 'seen_at', type: 'TIMESTAMP' },
      ]),
    ).toEqual([
      { id: 'id', type: 'int64', nullable: false },
      {
        id: 'price',
        type: 'decimal',
        nullable: true,
        displayName: 'Price',
        precision: 38,
        scale: 9,
      },
      { id: 'huge', type: 'decimal', nullable: true, precision: 76, scale: 38 },
      { id: 'seen_at', type: 'timestamp_tz', nullable: true, timezone: 'UTC' },
    ]);
  });

  it('turns a REPEATED field into a list carrying its element type', () => {
    expect(buildBqSchema([{ name: 'tag', type: 'STRING', mode: 'REPEATED' }])).toEqual([
      {
        id: 'tag',
        type: 'list',
        nullable: false,
        children: [{ id: 'element', type: 'utf8' }],
      },
    ]);
  });

  it('recurses into STRUCT sub-fields', () => {
    expect(
      buildBqSchema([
        {
          name: 'address',
          type: 'STRUCT',
          fields: [
            { name: 'city', type: 'STRING' },
            { name: 'zip', type: 'INT64', mode: 'REQUIRED' },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'address',
        type: 'struct',
        nullable: true,
        children: [
          { id: 'city', type: 'utf8', nullable: true },
          { id: 'zip', type: 'int64', nullable: false },
        ],
      },
    ]);
  });
});

describe('buildColumnTypeMap', () => {
  it('produces the descriptor columnType map from the same field list', () => {
    expect(
      buildColumnTypeMap([
        { name: 'id', type: 'int64' },
        { name: 'status', type: 'STRING' },
      ]),
    ).toEqual({ id: 'INT64', status: 'STRING' });
  });
});
