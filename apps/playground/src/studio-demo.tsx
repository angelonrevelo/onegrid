// =============================================================================
// Studio demo — Supabase-class table editor over a live queryable.
//
// Every action compiles then applies. The default queryable is in-process
// memory (executes the SQL). Pass `?studio=http://…` to use
// createHttpQueryable against a live psql/HTTP endpoint instead.
// =============================================================================

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import {
  applyList,
  createMemoryQueryable,
  createStudioSession,
  findTable,
  listRow,
  measureQuery,
  resolveRelationship,
  seedStudioDemo,
  type DatabaseSchema,
  type DdlOperation,
  type ForeignKeyAction,
  type PostgresQueryable,
  type QueryBenchResult,
  type TableDescriptor,
} from '@onegrid/studio';
import { createHttpQueryable } from '@onegrid/postgres';
import {
  databaseEditorPreset,
  resolveFeature,
  toGridOptions,
  withFeature,
  withoutFeature,
  FEATURE_NAME,
  type FeatureName,
  type Preset,
} from '@onegrid/preset';

const TYPE_OPTION = ['uuid', 'text', 'bigint', 'numeric', 'boolean', 'timestamptz'] as const;
const DELETE_ACTION: readonly ForeignKeyAction[] = [
  'cascade',
  'restrict',
  'no action',
  'set null',
  'set default',
];

function queryableFromLocation(): PostgresQueryable {
  const http = new URLSearchParams(window.location.search).get('studio');
  if (http && /^https?:\/\//.test(http)) {
    const pg = createHttpQueryable({ url: http });
    return {
      async query(sql, param) {
        const result = await pg.query(sql, param);
        return result.rows;
      },
    };
  }
  return createMemoryQueryable();
}

export function StudioDemo(): JSX.Element {
  const session = useMemo(() => createStudioSession(queryableFromLocation()), []);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [activeTable, setActiveTable] = useState('account');
  const [row, setRow] = useState<Record<string, unknown>[]>([]);
  const [sqlLog, setSqlLog] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [fieldName, setFieldName] = useState('note');
  const [fieldType, setFieldType] = useState<string>('text');
  const [fieldNullable, setFieldNullable] = useState(true);
  const [pkColumn, setPkColumn] = useState('account_id');
  const [fkColumn, setFkColumn] = useState('account_id');
  const [fkTarget, setFkTarget] = useState('account');
  const [fkTargetColumn, setFkTargetColumn] = useState('account_id');
  const [fkDelete, setFkDelete] = useState<ForeignKeyAction>('cascade');
  const [bench, setBench] = useState<QueryBenchResult | null>(null);
  const [preset, setPreset] = useState<Preset>(databaseEditorPreset);
  const [newTable, setNewTable] = useState('note');

  const current: TableDescriptor | null = schema
    ? findTable(schema, { schema: 'public', name: activeTable })
    : null;

  const pushSql = useCallback((sql: string) => {
    setSqlLog((prev) => [sql, ...prev].slice(0, 24));
  }, []);

  const refresh = useCallback(async () => {
    const next = await session.introspect();
    setSchema(next);
    const table = findTable(next, { schema: 'public', name: activeTable });
    if (table) setRow([...(await applyList(session.queryable, table))]);
    else setRow([]);
  }, [activeTable, session]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await seedStudioDemo(session);
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, session]);

  const runDdl = useCallback(
    async (operation: DdlOperation) => {
      const statement = await session.applyDdl(operation);
      pushSql(statement.sql);
      await refresh();
    },
    [pushSql, refresh, session],
  );

  const insert = useCallback(async () => {
    if (!current) return;
    const value: Record<string, unknown> = {};
    for (const c of current.column) {
      if (c.identity !== 'none') continue;
      value[c.name] = c.dataType.includes('int') || c.dataType === 'bigint' ? Date.now() % 100000 : `new-${c.name}`;
    }
    const statement = await session.insert(current, value);
    pushSql(`INSERT … ${current.name} (${Object.keys(value).join(', ')})`);
    if (statement[0]) setRow((prev) => [...prev, statement[0]!]);
    await refresh();
  }, [current, pushSql, refresh, session]);

  const remove = useCallback(
    async (index: number) => {
      if (!current) return;
      const source = row[index];
      if (!source) return;
      const key = Object.fromEntries(
        (current.primaryKey?.column ?? []).map((k) => [k, source[k]]),
      );
      await session.remove(current, key);
      pushSql(`DELETE ${current.name}`);
      await refresh();
    },
    [current, pushSql, refresh, row, session],
  );

  const addField = useCallback(async () => {
    if (!current || fieldName.trim() === '') return;
    await runDdl({
      kind: 'addColumn',
      schema: current.schema,
      table: current.name,
      column: {
        name: fieldName.trim(),
        type: fieldType,
        isNullable: fieldNullable,
      },
    });
  }, [current, fieldName, fieldNullable, fieldType, runDdl]);

  const setPrimaryKey = useCallback(async () => {
    if (!current || pkColumn.trim() === '') return;
    await runDdl({
      kind: 'addPrimaryKey',
      schema: current.schema,
      table: current.name,
      column: [pkColumn.trim()],
      name: `${current.name}_pkey`,
    });
  }, [current, pkColumn, runDdl]);

  const createTable = useCallback(async () => {
    const name = newTable.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    await runDdl({
      kind: 'createTable',
      schema: 'public',
      table: name,
      column: [{ name: `${name}_id`, type: 'uuid', isNullable: false, isPrimaryKey: true }],
    });
    setActiveTable(name);
  }, [newTable, runDdl]);

  const toggleFeature = useCallback((name: FeatureName) => {
    setPreset((current) => {
      const enabled = current.feature.includes(name);
      const next = enabled ? withoutFeature(current, name) : withFeature(current, name);
      try {
        resolveFeature({ enable: next.feature, disable: next.disabled });
        return next;
      } catch {
        return current;
      }
    });
  }, []);

  const addForeignKey = useCallback(async () => {
    if (!current) return;
    await runDdl({
      kind: 'addForeignKey',
      schema: current.schema,
      table: current.name,
      name: `${current.name}_${fkColumn}_fkey`,
      column: [fkColumn],
      referencedSchema: 'public',
      referencedTable: fkTarget,
      referencedColumn: [fkTargetColumn],
      onDelete: fkDelete,
    });
  }, [current, fkColumn, fkDelete, fkTarget, fkTargetColumn, runDdl]);

  const runBench = useCallback(async () => {
    if (!current) return;
    const result = await measureQuery(session.queryable, listRow(current));
    setBench(result);
    pushSql(`-- bench ${result.durationMs.toFixed(2)} ms · ${result.rowCount} row\n${result.sql}`);
  }, [current, pushSql, session.queryable]);

  const graph = useMemo(() => (schema ? resolveRelationship(schema) : null), [schema]);
  const relation = current && graph ? graph.get({ schema: current.schema, name: current.name }) : null;

  const command = useMemo(
    () => [
      { id: 'insert', label: 'Insert row', hint: '⌘N', run: () => void insert() },
      { id: 'add-column', label: 'Add field', hint: '⌘⇧C', run: () => void addField() },
      { id: 'add-pk', label: 'Set primary key', hint: '', run: () => void setPrimaryKey() },
      { id: 'add-fk', label: 'Add foreign key', hint: '⌘⇧K', run: () => void addForeignKey() },
      { id: 'create-table', label: 'Create table', hint: '', run: () => void createTable() },
      { id: 'bench', label: 'Bench query', hint: '', run: () => void runBench() },
    ],
    [addField, addForeignKey, createTable, insert, runBench, setPrimaryKey],
  );

  const filtered = command.filter((c) =>
    c.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const resolved = resolveFeature({ enable: preset.feature, disable: preset.disabled });
  const option = toGridOptions(resolved);

  return (
    <div
      data-testid="studio-demo"
      style={{
        display: 'grid',
        gridTemplateColumns: '220px 1fr 300px',
        gridTemplateRows: '48px 1fr',
        height: '100%',
        minHeight: 520,
        background: '#0b0d10',
        color: '#e7e9ec',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <header
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          borderBottom: '1px solid #1c2027',
        }}
      >
        <strong>Studio</strong>
        <span style={{ color: '#8b929c' }}>
          {preset.name} · live queryable · {preset.feature.length} feature
        </span>
        <button type="button" data-testid="studio-palette-open" onClick={() => setPaletteOpen(true)} style={btnStyle}>
          ⌘K Quick actions
        </button>
        {command.map((c) => (
          <button key={c.id} type="button" onClick={c.run} style={btnStyle} data-testid={`studio-${c.id}`}>
            {c.label}
          </button>
        ))}
        {bench && (
          <span data-testid="studio-bench-result" style={{ color: '#62d68a', marginLeft: 'auto' }}>
            {bench.durationMs.toFixed(2)} ms · {bench.rowCount} row
          </span>
        )}
      </header>

      <nav style={{ borderRight: '1px solid #1c2027', overflow: 'auto', padding: 8 }}>
        {(schema?.table ?? []).map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => {
              setActiveTable(t.name);
              void applyList(session.queryable, t).then((r) => setRow([...r]));
            }}
            data-testid={`studio-table-${t.name}`}
            style={{
              ...btnStyle,
              width: '100%',
              textAlign: 'left',
              background: t.name === activeTable ? '#1d4ed8' : 'transparent',
              marginBottom: 4,
            }}
          >
            {t.schema}.{t.name}
            <span style={{ float: 'right', opacity: 0.7 }}>{t.estimatedRowCount}</span>
          </button>
        ))}
        {relation && (
          <div style={{ marginTop: 16, color: '#8b929c', fontSize: 12 }}>
            <div>outbound {relation.outbound.length}</div>
            <div>inbound {relation.inbound.length}</div>
            {current?.primaryKey && (
              <div data-testid="studio-pk">PK {current.primaryKey.column.join(', ')}</div>
            )}
          </div>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 4 }}>
          <input
            data-testid="studio-new-table"
            value={newTable}
            onChange={(e) => setNewTable(e.target.value)}
            placeholder="new table"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" data-testid="studio-create-table-form" onClick={() => void createTable()} style={btnStyle}>
            New
          </button>
        </div>
        <div data-testid="studio-feature-toggle" style={{ marginTop: 16 }}>
          <div style={{ color: '#8b929c', fontSize: 11, marginBottom: 6 }}>Feature</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {FEATURE_NAME.map((name) => {
              const on = preset.feature.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  data-testid={`studio-feature-${name}`}
                  onClick={() => toggleFeature(name)}
                  style={{
                    ...btnStyle,
                    padding: '2px 6px',
                    fontSize: 10,
                    background: on ? '#1d4ed8' : 'transparent',
                    opacity: on ? 1 : 0.55,
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <main style={{ overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            padding: 8,
            borderBottom: '1px solid #1c2027',
            alignItems: 'center',
          }}
        >
          <label>
            Field{' '}
            <input
              data-testid="studio-field-name"
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
              style={inputStyle}
            />
          </label>
          <select
            data-testid="studio-field-type"
            value={fieldType}
            onChange={(e) => setFieldType(e.target.value)}
            style={inputStyle}
          >
            {TYPE_OPTION.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              data-testid="studio-field-nullable"
              checked={fieldNullable}
              onChange={(e) => setFieldNullable(e.target.checked)}
            />
            nullable
          </label>
          <button type="button" data-testid="studio-add-field" onClick={() => void addField()} style={btnStyle}>
            Add field
          </button>
          <label>
            PK{' '}
            <input
              data-testid="studio-pk-column"
              value={pkColumn}
              onChange={(e) => setPkColumn(e.target.value)}
              style={inputStyle}
            />
          </label>
          <button type="button" data-testid="studio-set-pk" onClick={() => void setPrimaryKey()} style={btnStyle}>
            Set PK
          </button>
          <label>
            FK{' '}
            <input
              data-testid="studio-fk-column"
              value={fkColumn}
              onChange={(e) => setFkColumn(e.target.value)}
              style={inputStyle}
            />
            →
            <input
              data-testid="studio-fk-target"
              value={fkTarget}
              onChange={(e) => setFkTarget(e.target.value)}
              style={inputStyle}
            />
            .
            <input
              data-testid="studio-fk-target-column"
              value={fkTargetColumn}
              onChange={(e) => setFkTargetColumn(e.target.value)}
              style={inputStyle}
            />
          </label>
          <select
            data-testid="studio-fk-delete"
            value={fkDelete}
            onChange={(e) => setFkDelete(e.target.value as ForeignKeyAction)}
            style={inputStyle}
          >
            {DELETE_ACTION.map((a) => (
              <option key={a} value={a}>
                ON DELETE {a}
              </option>
            ))}
          </select>
          <button type="button" data-testid="studio-add-fk-form" onClick={() => void addForeignKey()} style={btnStyle}>
            Add FK
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="studio-grid">
          <thead>
            <tr>
              {(current?.column ?? []).map((c) => (
                <th
                  key={c.name}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderBottom: '1px solid #1c2027',
                    background: '#1b1f26',
                    position: 'sticky',
                    top: 0,
                  }}
                >
                  {c.name}
                  {current?.primaryKey?.column.includes(c.name) ? ' 🔑' : ''}
                  <div style={{ fontWeight: 400, color: '#8b929c', fontSize: 11 }}>{c.dataType}</div>
                </th>
              ))}
              <th style={{ width: 72, background: '#1b1f26' }} />
            </tr>
          </thead>
          <tbody>
            {row.map((r, i) => (
              <tr key={i}>
                {(current?.column ?? []).map((c) => (
                  <td
                    key={c.name}
                    style={{ padding: '6px 10px', borderBottom: '1px solid #1c2027' }}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => {
                      if (!current) return;
                      const next = e.currentTarget.textContent ?? '';
                      const prev = String(r[c.name] ?? '');
                      if (next === prev) return;
                      const key = Object.fromEntries(
                        (current.primaryKey?.column ?? []).map((k) => [k, r[k]]),
                      );
                      void session.update(current, key, { [c.name]: next }).then(() => refresh());
                    }}
                  >
                    {String(r[c.name] ?? '')}
                  </td>
                ))}
                <td>
                  <button type="button" onClick={() => void remove(i)} style={btnStyle}>
                    Del
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>

      <aside
        style={{
          borderLeft: '1px solid #1c2027',
          padding: 8,
          overflow: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 11,
          color: '#a5b1c2',
        }}
        data-testid="studio-sql"
      >
        <div style={{ marginBottom: 8, color: '#8b929c' }}>SQL preview</div>
        {sqlLog.length === 0 && <div>Actions compile then apply.</div>}
        {sqlLog.map((s, i) => (
          <pre key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {s}
          </pre>
        ))}
        <div style={{ marginTop: 16, color: '#8b929c' }}>
          required binding: {option.requiredBinding.join(', ')}
        </div>
      </aside>

      {paletteOpen && (
        <div
          role="dialog"
          aria-label="Quick actions"
          data-testid="studio-palette"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: 80,
          }}
          onClick={() => setPaletteOpen(false)}
        >
          <div
            style={{
              width: 420,
              background: '#11141a',
              border: '1px solid #1c2027',
              borderRadius: 8,
              padding: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Insert row, add field, set PK, add FK, bench…"
              data-testid="studio-palette-input"
              style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
            />
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  c.run();
                  setPaletteOpen(false);
                  setQuery('');
                }}
                style={{ ...btnStyle, width: '100%', textAlign: 'left', marginBottom: 4 }}
              >
                {c.label}
                <span style={{ float: 'right', opacity: 0.5 }}>{c.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: '#1b1f26',
  color: '#e7e9ec',
  border: '1px solid #1c2027',
  borderRadius: 4,
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 12,
};

const inputStyle: CSSProperties = {
  background: '#0b0d10',
  color: '#e7e9ec',
  border: '1px solid #1c2027',
  borderRadius: 4,
  padding: '4px 6px',
  fontSize: 12,
};
