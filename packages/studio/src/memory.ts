// =============================================================================
// In-process executing queryable.
//
// Interprets the SQL this package's compiler emits and answers the
// introspection catalog queries. It is a queryable, not a mock of the
// compiler: tests compile real operations, apply them here, then
// introspect. A hardcoded schema that never saw the SQL is exactly what
// this exists to prevent.
// =============================================================================

import type { ForeignKeyAction, PostgresQueryable } from './model';

interface MemoryColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  identity: 'none' | 'always' | 'by default';
  ordinalPosition: number;
}

interface MemoryForeignKey {
  name: string;
  column: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string[];
  onDelete: ForeignKeyAction;
  onUpdate: ForeignKeyAction;
}

interface MemoryTable {
  schema: string;
  name: string;
  column: MemoryColumn[];
  primaryKeyName: string | null;
  foreignKey: MemoryForeignKey[];
  row: Record<string, unknown>[];
  nextIdentity: number;
}

const ACTION_CODE: Record<string, ForeignKeyAction> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
};

const ACTION_PG: Record<ForeignKeyAction, string> = {
  cascade: 'c',
  'set null': 'n',
  'set default': 'd',
  restrict: 'r',
  'no action': 'a',
};

function unquote(token: string): string {
  const t = token.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  return t;
}

function splitQualified(rel: string): { schema: string; name: string } {
  const piece = rel.split('.').map(unquote);
  if (piece.length === 1) return { schema: 'public', name: piece[0]! };
  return { schema: piece[0]!, name: piece[1]! };
}

function splitTop(list: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

function parseColumnList(body: string): string[] {
  return splitTop(body.replace(/^\(|\)$/g, ''), ',').map(unquote);
}

function bind(sql: string, param: readonly unknown[]): string {
  return sql.replace(/\$(\d+)\b/g, (_, n: string) => {
    const value = param[Number(n) - 1];
    if (value === null || value === undefined) return 'NULL';
    return `__P${n}__`;
  });
}

function readBound(token: string, param: readonly unknown[]): unknown {
  const m = /^__P(\d+)__$/.exec(token.trim());
  if (m) return param[Number(m[1]) - 1] ?? null;
  if (token === 'NULL') return null;
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
  return token;
}

/**
 * A PostgresQueryable that executes this package's compiled SQL in memory.
 * @public
 */
export interface MemoryQueryable extends PostgresQueryable {
  /** Tables currently stored — for assertions that read the queryable, not the compiler. */
  snapshot(): ReadonlyArray<{
    readonly schema: string;
    readonly name: string;
    readonly column: readonly string[];
    readonly primaryKey: readonly string[];
    readonly foreignKey: readonly MemoryForeignKey[];
    readonly row: readonly Record<string, unknown>[];
  }>;
}

/**
 * Create an empty in-process database. Starts with schema `public`.
 * @public
 */
export function createMemoryQueryable(): MemoryQueryable {
  const table = new Map<string, MemoryTable>();

  const keyOf = (schema: string, name: string) => `${schema}.${name}`;

  const get = (schema: string, name: string): MemoryTable => {
    const t = table.get(keyOf(schema, name));
    if (!t) throw new Error(`[OG_MEMORY] relation ${schema}.${name} does not exist`);
    return t;
  };

  function createTable(sql: string): void {
    const m =
      /^CREATE(?: UNLOGGED)? TABLE(?: IF NOT EXISTS)? (\S+) \((.*)\)\s*$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised CREATE TABLE: ${sql}`);
    const rel = splitQualified(m[1]!);
    const k = keyOf(rel.schema, rel.name);
    if (table.has(k) && /IF NOT EXISTS/i.test(sql)) return;
    const spec = splitTop(m[2]!, ',');
    const column: MemoryColumn[] = [];
    let primaryKeyName: string | null = null;
    let pkFromTable: string[] = [];
    let ordinal = 1;
    for (const piece of spec) {
      const pk = /^PRIMARY KEY\s*\((.*)\)\s*$/i.exec(piece);
      if (pk) {
        pkFromTable = parseColumnList(`(${pk[1]})`);
        primaryKeyName = `${rel.name}_pkey`;
        continue;
      }
      const parts = piece.trim().split(/\s+/);
      const name = unquote(parts[0]!);
      const dataType = parts[1] ?? 'text';
      const rest = parts.slice(2).join(' ').toUpperCase();
      const isPk = /\bPRIMARY KEY\b/.test(rest);
      if (isPk) {
        pkFromTable = [name];
        primaryKeyName = `${rel.name}_pkey`;
      }
      column.push({
        name,
        dataType,
        isNullable: !/\bNOT NULL\b/.test(rest) && !isPk,
        isPrimaryKey: isPk,
        identity: /\bGENERATED ALWAYS AS IDENTITY\b/.test(rest)
          ? 'always'
          : /\bGENERATED BY DEFAULT AS IDENTITY\b/.test(rest)
            ? 'by default'
            : 'none',
        ordinalPosition: ordinal++,
      });
    }
    for (const pk of pkFromTable) {
      const col = column.find((c) => c.name === pk);
      if (col) {
        col.isPrimaryKey = true;
        col.isNullable = false;
      }
    }
    table.set(k, {
      schema: rel.schema,
      name: rel.name,
      column,
      primaryKeyName,
      foreignKey: [],
      row: [],
      nextIdentity: 1,
    });
  }

  function addColumn(sql: string): void {
    const m = /^ALTER TABLE (\S+) ADD COLUMN(?: IF NOT EXISTS)? (.*)$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised ADD COLUMN: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const parts = m[2]!.trim().split(/\s+/);
    const name = unquote(parts[0]!);
    if (t.column.some((c) => c.name === name)) return;
    const rest = parts.slice(2).join(' ').toUpperCase();
    t.column.push({
      name,
      dataType: parts[1] ?? 'text',
      isNullable: !/\bNOT NULL\b/.test(rest),
      isPrimaryKey: false,
      identity: 'none',
      ordinalPosition: t.column.length + 1,
    });
    for (const row of t.row) {
      if (!(name in row)) row[name] = null;
    }
  }

  function addPrimaryKey(sql: string): void {
    const m =
      /^ALTER TABLE (\S+) ADD(?: CONSTRAINT (\S+))? PRIMARY KEY \((.*)\)\s*$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised ADD PRIMARY KEY: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const pk = parseColumnList(`(${m[3]})`);
    t.primaryKeyName = m[2] ? unquote(m[2]) : `${t.name}_pkey`;
    for (const col of t.column) col.isPrimaryKey = pk.includes(col.name);
  }

  function addForeignKey(sql: string): void {
    const m =
      /^ALTER TABLE (\S+) ADD(?: CONSTRAINT (\S+))? FOREIGN KEY \((.*)\) REFERENCES (\S+) \((.*)\)(.*)$/is.exec(
        sql.trim(),
      );
    if (!m) throw new Error(`[OG_MEMORY] unrecognised ADD FOREIGN KEY: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const target = splitQualified(m[4]!);
    const tail = (m[6] ?? '').toUpperCase();
    const onDeleteMatch = /ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/.exec(tail);
    const onUpdateMatch = /ON UPDATE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/.exec(tail);
    t.foreignKey.push({
      name: m[2] ? unquote(m[2]) : `${t.name}_${parseColumnList(`(${m[3]})`)[0]}_fkey`,
      column: parseColumnList(`(${m[3]})`),
      referencedSchema: target.schema,
      referencedTable: target.name,
      referencedColumn: parseColumnList(`(${m[5]})`),
      onDelete: ACTION_CODE[onDeleteMatch?.[1] ?? 'NO ACTION'] ?? 'no action',
      onUpdate: ACTION_CODE[onUpdateMatch?.[1] ?? 'NO ACTION'] ?? 'no action',
    });
  }

  function parseWhere(
    where: string,
    param: readonly unknown[],
  ): (row: Record<string, unknown>) => boolean {
    if (!where.trim()) return () => true;
    const clause = splitTop(where, 'AND').map((c) => c.trim());
    const pred = clause.map((c) => {
      const eq = /^(\S+)\s*=\s*(\S+)$/.exec(c);
      if (!eq) throw new Error(`[OG_MEMORY] unrecognised WHERE clause: ${c}`);
      return { column: unquote(eq[1]!), value: readBound(eq[2]!, param) };
    });
    return (row) => pred.every((p) => String(row[p.column] ?? '') === String(p.value ?? ''));
  }

  function insertSql(sql: string, param: readonly unknown[]): Record<string, unknown>[] {
    const m =
      /^INSERT INTO (\S+) \((.*)\) VALUES \((.*)\) RETURNING \*\s*$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised INSERT: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const colName = parseColumnList(`(${m[2]})`);
    const valueToken = splitTop(m[3]!, ',');
    const row: Record<string, unknown> = {};
    for (const col of t.column) row[col.name] = null;
    for (let i = 0; i < colName.length; i++) {
      row[colName[i]!] = readBound(valueToken[i] ?? 'NULL', param);
    }
    for (const col of t.column) {
      if (col.identity !== 'none' && (row[col.name] === null || row[col.name] === undefined)) {
        row[col.name] = t.nextIdentity++;
      }
    }
    t.row.push(row);
    return [{ ...row }];
  }

  function updateSql(sql: string, param: readonly unknown[]): Record<string, unknown>[] {
    const m = /^UPDATE (\S+) SET (.*) WHERE (.*) RETURNING \*\s*$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised UPDATE: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const assignment = splitTop(m[2]!, ',').map((a) => {
      const eq = /^(\S+)\s*=\s*(\S+)$/.exec(a.trim());
      if (!eq) throw new Error(`[OG_MEMORY] unrecognised SET: ${a}`);
      return { column: unquote(eq[1]!), value: readBound(eq[2]!, param) };
    });
    const match = parseWhere(m[3]!, param);
    const out: Record<string, unknown>[] = [];
    for (const row of t.row) {
      if (!match(row)) continue;
      for (const a of assignment) row[a.column] = a.value;
      out.push({ ...row });
    }
    return out;
  }

  function deleteSql(sql: string, param: readonly unknown[]): Record<string, unknown>[] {
    const m = /^DELETE FROM (\S+) WHERE (.*) RETURNING \*\s*$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised DELETE: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const match = parseWhere(m[2]!, param);
    const kept: Record<string, unknown>[] = [];
    const out: Record<string, unknown>[] = [];
    for (const row of t.row) {
      if (match(row)) out.push({ ...row });
      else kept.push(row);
    }
    t.row = kept;
    return out;
  }

  function selectSql(sql: string, param: readonly unknown[]): Record<string, unknown>[] {
    const m = /^SELECT \* FROM (\S+)(?: WHERE (.*?))?(?: LIMIT (\d+))?\s*$/is.exec(sql.trim());
    if (!m) throw new Error(`[OG_MEMORY] unrecognised SELECT: ${sql}`);
    const rel = splitQualified(m[1]!);
    const t = get(rel.schema, rel.name);
    const match = m[2] ? parseWhere(m[2], param) : () => true;
    const hit = t.row.filter(match).map((r) => ({ ...r }));
    const limit = m[3] !== undefined ? Number(m[3]) : hit.length;
    return hit.slice(0, limit);
  }

  function introspect(sql: string): Record<string, unknown>[] {
    const schemas = [...new Set([...table.values()].map((t) => t.schema))];
    if (sql.includes('FROM pg_catalog.pg_namespace n') && !sql.includes('pg_class')) {
      return schemas.map((schema_name) => ({ schema_name }));
    }
    if (sql.includes('relrowsecurity')) {
      return [...table.values()].map((t) => ({
        schema_name: t.schema,
        table_name: t.name,
        relkind: 'r',
        rls_enabled: false,
        estimated_row_count: t.row.length,
        table_comment: null,
        view_definition: null,
      }));
    }
    if (sql.includes('format_type(a.atttypid') && sql.includes('attisdropped')) {
      const out: Record<string, unknown>[] = [];
      for (const t of table.values()) {
        for (const c of t.column) {
          out.push({
            schema_name: t.schema,
            table_name: t.name,
            column_name: c.name,
            ordinal_position: c.ordinalPosition,
            data_type: c.dataType,
            is_nullable: c.isNullable,
            default_expression: null,
            identity_kind: c.identity === 'always' ? 'a' : c.identity === 'by default' ? 'd' : '',
            generated_expression: null,
            column_comment: null,
            enum_type_name: null,
            character_maximum_length: null,
            numeric_precision: null,
            numeric_scale: null,
          });
        }
      }
      return out;
    }
    if (sql.includes("con.contype IN ('p','u')")) {
      const out: Record<string, unknown>[] = [];
      for (const t of table.values()) {
        const pk = t.column.filter((c) => c.isPrimaryKey).map((c) => c.name);
        if (pk.length === 0) continue;
        out.push({
          schema_name: t.schema,
          table_name: t.name,
          constraint_name: t.primaryKeyName ?? `${t.name}_pkey`,
          constraint_type: 'p',
          is_deferrable: false,
          column_name: pk,
        });
      }
      return out;
    }
    if (sql.includes("con.contype = 'f'")) {
      const out: Record<string, unknown>[] = [];
      for (const t of table.values()) {
        for (const fk of t.foreignKey) {
          out.push({
            schema_name: t.schema,
            table_name: t.name,
            constraint_name: fk.name,
            referenced_schema: fk.referencedSchema,
            referenced_table: fk.referencedTable,
            on_delete: ACTION_PG[fk.onDelete],
            on_update: ACTION_PG[fk.onUpdate],
            column_name: fk.column,
            referenced_column: fk.referencedColumn,
          });
        }
      }
      return out;
    }
    if (
      sql.includes("con.contype = 'c'") ||
      sql.includes('pg_catalog.pg_index') ||
      sql.includes('pg_catalog.pg_trigger') ||
      sql.includes('pg_catalog.pg_policy') ||
      sql.includes('pg_catalog.pg_enum') ||
      sql.includes('pg_catalog.pg_sequence')
    ) {
      return [];
    }
    throw new Error(`[OG_MEMORY] unrecognised catalog query`);
  }

  function isCatalog(sql: string): boolean {
    return (
      sql.includes('pg_catalog.pg_namespace') ||
      sql.includes('pg_catalog.pg_class') ||
      sql.includes('pg_catalog.pg_attribute') ||
      sql.includes('pg_catalog.pg_constraint') ||
      sql.includes('pg_catalog.pg_index') ||
      sql.includes('pg_catalog.pg_trigger') ||
      sql.includes('pg_catalog.pg_policy') ||
      sql.includes('pg_catalog.pg_enum') ||
      sql.includes('pg_catalog.pg_sequence')
    );
  }

  const queryable: MemoryQueryable = {
    query(sql: string, param: readonly unknown[] = []) {
      const bound = bind(sql, param);
      const trimmed = bound.trim();
      if (isCatalog(sql) && /pg_catalog/.test(sql)) return introspect(sql);
      if (/^CREATE(?: UNLOGGED)? TABLE/i.test(trimmed)) {
        createTable(trimmed);
        return [];
      }
      if (/^ALTER TABLE \S+ ADD COLUMN/i.test(trimmed)) {
        addColumn(trimmed);
        return [];
      }
      if (/^ALTER TABLE \S+ ADD(?: CONSTRAINT \S+)? PRIMARY KEY/i.test(trimmed)) {
        addPrimaryKey(trimmed);
        return [];
      }
      if (/^ALTER TABLE \S+ ADD(?: CONSTRAINT \S+)? FOREIGN KEY/i.test(trimmed)) {
        addForeignKey(trimmed);
        return [];
      }
      if (/^INSERT INTO /i.test(trimmed)) return insertSql(trimmed, param);
      if (/^UPDATE /i.test(trimmed)) return updateSql(trimmed, param);
      if (/^DELETE FROM /i.test(trimmed)) return deleteSql(trimmed, param);
      if (/^SELECT \* FROM /i.test(trimmed)) return selectSql(trimmed, param);
      throw new Error(`[OG_MEMORY] unsupported statement: ${sql.slice(0, 180)}`);
    },
    snapshot() {
      return [...table.values()].map((t) => ({
        schema: t.schema,
        name: t.name,
        column: t.column.map((c) => c.name),
        primaryKey: t.column.filter((c) => c.isPrimaryKey).map((c) => c.name),
        foreignKey: t.foreignKey,
        row: t.row.map((r) => ({ ...r })),
      }));
    },
  };

  return queryable;
}
