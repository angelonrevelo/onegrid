import { describe, expect, it } from 'vitest';
import {
  EXTENSION_NAME,
  FETCH_BLOCK_FUNCTION,
  compileExtensionSql,
  compileFetchCall,
} from '../index';

describe('compileExtensionSql', () => {
  it('emits a PL/pgSQL function named onegid_fetch_block', () => {
    const sql = compileExtensionSql();
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${FETCH_BLOCK_FUNCTION}`);
    expect(sql).toContain('LANGUAGE plpgsql');
    expect(sql).toContain('format(');
    expect(sql).toContain('%I');
  });

  it('rejects a schema that is not a bare identifier', () => {
    expect(() => compileExtensionSql({ schema: 'public;drop' })).toThrow(/OG_PGRX_SCHEMA/);
  });

  it('installs into a requested schema', () => {
    expect(compileExtensionSql({ schema: 'onegrid' })).toContain(
      `CREATE OR REPLACE FUNCTION onegrid.${FETCH_BLOCK_FUNCTION}`,
    );
  });
});

describe('compileFetchCall', () => {
  it('emits a SELECT against the function', () => {
    const sql = compileFetchCall({
      tableName: 'public.order',
      primaryKey: 'order_id',
      limit: 50,
    });
    expect(sql).toContain(`public.${FETCH_BLOCK_FUNCTION}`);
    expect(sql).toContain("'public.order'");
    expect(sql).toContain("'order_id'");
    expect(sql).toContain('50');
    expect(sql).toContain('NULL');
  });

  it('quotes a cursor that contains a quote', () => {
    const sql = compileFetchCall({
      tableName: 't',
      primaryKey: 'id',
      cursorRowId: "O'Reilly",
    });
    expect(sql).toContain("'O''Reilly'");
  });
});

describe('constants', () => {
  it('names the extension onegid', () => {
    expect(EXTENSION_NAME).toBe('onegrid');
  });
});
