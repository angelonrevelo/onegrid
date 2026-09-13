// =============================================================================
// Live-grid tab — the centerpiece.
//
// A real Grid mounted via @onegrid/react with a 100K-row synthetic RowSource.
// Optional .xlsx drag-and-drop swaps the source for parsed cells. The
// formula engine (@onegrid/formula) powers a formula bar; type a formula
// and see its result against the live row data.
//
// This proves the contracts compose end-to-end: RowSource + GridOptions +
// FormulaEngine + xlsx Workbook all share a single Grid instance.
// =============================================================================

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { OneGrid, useOneGrid } from '@onegrid/react';
import type { ColumnDef, RowSource } from '@onegrid/core';
import { createFormulaEngine, type CellResolver } from '@onegrid/formula';
import { readWorkbook, type Workbook } from '@onegrid/xlsx';
import { Btn, Card, Mono, Output } from '../ui';

interface SyntheticRow {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly department: string;
  readonly tenure: number;
  readonly revenue: number;
  readonly score: number;
}

const FIRST_NAMES = ['Ada', 'Alan', 'Linus', 'Grace', 'Donald', 'Margaret', 'Tim', 'Anita', 'Brian', 'Niklaus'];
const LAST_NAMES = ['Lovelace', 'Turing', 'Torvalds', 'Hopper', 'Knuth', 'Hamilton', 'Berners-Lee', 'Borg', 'Kernighan', 'Wirth'];
const DEPARTMENTS = ['Engineering', 'Sales', 'Marketing', 'Operations', 'Finance', 'Research'];

function makeSyntheticSource(numRows: number): RowSource {
  // Deterministic synthetic data — same row index always returns the same
  // values, so callers can hash rowIndex into stable test cases.
  function rowAt(i: number): SyntheticRow {
    const seed = i * 2654435761;
    return {
      id: i + 1,
      firstName: FIRST_NAMES[(seed >>> 0) % FIRST_NAMES.length]!,
      lastName: LAST_NAMES[(seed >>> 4) % LAST_NAMES.length]!,
      department: DEPARTMENTS[(seed >>> 8) % DEPARTMENTS.length]!,
      tenure: ((seed >>> 12) % 30) + 1,
      revenue: 50_000 + ((seed >>> 16) % 200_000),
      score: 50 + ((seed >>> 20) % 50),
    };
  }
  return {
    numRows,
    getCell(rowIndex, columnId) {
      const r = rowAt(rowIndex);
      return (r as unknown as Record<string, unknown>)[columnId];
    },
  };
}

const SYNTHETIC_COLUMNS: ReadonlyArray<ColumnDef> = [
  { id: 'id', width: 70, displayName: '#' },
  { id: 'firstName', width: 110, displayName: 'First' },
  { id: 'lastName', width: 130, displayName: 'Last' },
  { id: 'department', width: 130, displayName: 'Dept' },
  { id: 'tenure', width: 80, displayName: 'Tenure' },
  { id: 'revenue', width: 110, displayName: 'Revenue' },
  { id: 'score', width: 80, displayName: 'Score' },
];

export function OneGridLiveTab(): JSX.Element {
  const [source, setSource] = useState<RowSource>(() => makeSyntheticSource(100_000));
  const [columns, setColumns] = useState<ReadonlyArray<ColumnDef>>(SYNTHETIC_COLUMNS);
  const [sourceLabel, setSourceLabel] = useState('synthetic 100K rows');
  const [formula, setFormula] = useState('=SUM(1, 2, 3, 4, 5)');
  const [importedWorkbook, setImportedWorkbook] = useState<Workbook | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A single CellResolver that the formula engine queries. Pulls from the
  // currently-active RowSource. The first 26 rows feed cells A1..A26 etc.
  const resolver = useMemo<CellResolver>(() => ({
    getCell(ref) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) return null;
      const colLetter = m[1]!;
      const row = Number(m[2]) - 1;
      if (row < 0 || row >= source.numRows) return null;
      const colIdx = colLetter.charCodeAt(0) - 65;
      const col = columns[colIdx];
      if (!col) return null;
      return source.getCell(row, col.id) ?? null;
    },
    getRange(ref) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
      if (!m) return [];
      const startCol = m[1]!.charCodeAt(0) - 65;
      const startRow = Number(m[2]) - 1;
      const endCol = m[3]!.charCodeAt(0) - 65;
      const endRow = Number(m[4]) - 1;
      const out: unknown[] = [];
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const col = columns[c];
          if (col && r >= 0 && r < source.numRows) out.push(source.getCell(r, col.id));
        }
      }
      return out;
    },
  }), [source, columns]);

  const engine = useMemo(() => createFormulaEngine(), []);
  const formulaResult = useMemo(() => {
    try {
      return engine.evaluate(formula, resolver);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [engine, formula, resolver]);

  async function handleFile(file: File) {
    setImportError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const wb = await readWorkbook(bytes);
      setImportedWorkbook(wb);
      const sheet = wb.sheets[0];
      if (!sheet) {
        setImportError('workbook contained no sheets');
        return;
      }
      // Materialize the sheet into a synthetic RowSource. We figure out
      // the column extents from the cell refs and build a sparse grid.
      let maxCol = 0;
      let maxRow = 0;
      const cellMap = new Map<string, unknown>();
      for (const c of sheet.cells) {
        cellMap.set(c.ref, c.value);
        const m = /^([A-Z]+)(\d+)$/.exec(c.ref);
        if (m) {
          let col = 0;
          for (let i = 0; i < m[1]!.length; i++) col = col * 26 + (m[1]!.charCodeAt(i) - 64);
          maxCol = Math.max(maxCol, col);
          maxRow = Math.max(maxRow, Number(m[2]));
        }
      }
      const newCols: ColumnDef[] = [];
      for (let c = 1; c <= maxCol; c++) {
        let n = c;
        let letters = '';
        while (n > 0) {
          letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
          n = Math.floor((n - 1) / 26);
        }
        newCols.push({ id: letters, width: 110, displayName: letters });
      }
      const newSource: RowSource = {
        numRows: maxRow,
        getCell(rowIndex, columnId) {
          return cellMap.get(`${columnId}${rowIndex + 1}`) ?? null;
        },
      };
      setColumns(newCols);
      setSource(newSource);
      setSourceLabel(`${file.name} — ${sheet.cells.length} cells across ${maxRow}×${maxCol}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }

  function resetToSynthetic() {
    setColumns(SYNTHETIC_COLUMNS);
    setSource(makeSyntheticSource(100_000));
    setSourceLabel('synthetic 100K rows');
    setImportedWorkbook(null);
  }

  return (
    <div>
      <Card title="Row source">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>active:</span>
          <Mono>{sourceLabel}</Mono>
          <span style={{ flex: 1 }} />
          <Btn onClick={() => fileInputRef.current?.click()}>Import .xlsx…</Btn>
          <Btn onClick={resetToSynthetic}>Reset to synthetic</Btn>
          <input
            type="file"
            ref={fileInputRef}
            accept=".xlsx"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </div>
        {importError && (
          <Output>
            <span style={{ color: 'var(--bad)' }}>{importError}</span>
          </Output>
        )}
        {importedWorkbook && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            workbook: {importedWorkbook.sheets.length} sheet
            {importedWorkbook.sheets.length === 1 ? '' : 's'} ·{' '}
            date1904={String(importedWorkbook.date1904)}
          </div>
        )}
      </Card>

      <Card title="Formula bar">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={formula}
            onChange={(e) => setFormula(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--bg)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              padding: '4px 8px',
              borderRadius: 4,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
            }}
          />
          <span style={{ color: 'var(--muted)', fontSize: 11 }}>→</span>
          <Mono>{String(formulaResult)}</Mono>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
          Try: <Mono>=SUM(A1:A10)</Mono>{' '}
          <Mono>=LET(x, 5, x*2)</Mono>{' '}
          <Mono>=REDUCE(0, A1:A5, LAMBDA(a, v, a+v))</Mono>{' '}
          <Mono>=MAP(A1:A3, LAMBDA(x, x*100))</Mono>{' '}
          <Mono>=IFS(A1{'>'}50, "high", TRUE, "low")</Mono>
        </div>
      </Card>

      <Card title="Grid (rendered via @onegrid/react · wave 24 polish enabled)">
        <WaveControls
          columns={columns}
          source={source}
          onColumnsChange={setColumns}
        />
      </Card>
    </div>
  );
}

function WaveControls({
  columns,
  source,
  onColumnsChange,
}: {
  columns: ReadonlyArray<ColumnDef>;
  source: RowSource;
  onColumnsChange: (next: ReadonlyArray<ColumnDef>) => void;
}): JSX.Element {
  const { ref, grid } = useOneGrid({
    columns,
    rowSource: source,
    rowHeight: 28,
    enableColumnResize: true,
    enableColumnReorder: true,
    enableRowResize: true,
    enableFind: true,
    rowDragColumnId: 'id',
    enableGroupBar: true,
    onRowGrouping: (columnIds) => {
      // v1.3 wave 28: the grid emits the ordered group-by column list.
      // An adopter wires this to @onegrid/data groupRows() and feeds the
      // grouped RowSource back via setRowSource(). Here we just log it.
      console.log(`[showcase] group by: [${columnIds.join(', ')}]`);
    },
    enableAggregationPanel: true,
    onAggregationChange: (model) => {
      // v1.3 wave 29: the composed AggregationModel. An adopter passes it
      // to @onegrid/data aggregate()/groupRows(). Here we just log it.
      console.log(
        `[showcase] aggregations: ${model.map((a) => `${a.fn}(${a.columnId})`).join(', ') || '(none)'}`,
      );
    },
    enableFilterPanel: true,
    onFilterModelChange: (model) => {
      // v1.3 wave 30: the composed FilterModel (batched on Apply). An
      // adopter passes it to @onegrid/data filterIndex(). Here we log it.
      console.log(`[showcase] filter model:`, model);
    },
    enablePivotPanel: true,
    onPivotChange: (model) => {
      // v1.3 wave 31: the composed PivotModel. An adopter passes it to
      // @onegrid/data pivot() and swaps in the pivoted columns + rows.
      console.log(
        `[showcase] pivot: rows=[${model.rows.join(',')}] cols=[${model.columns.join(',')}] vals=[${model.measures.map((m) => `${m.fn}(${m.columnId})`).join(',')}]`,
      );
    },
    getRowMeta: (rowIndex) => {
      // Wave 26: pin the first row to the top and the last row to the
      // bottom of the visible band. Demonstrates mid-table row pinning
      // (different from the wave-23 `pinnedTopRowSource` band).
      if (rowIndex === 0) return { kind: 'data', pinned: 'top' };
      if (rowIndex === 99_999) return { kind: 'data', pinned: 'bottom' };
      return null;
    },
    onColumnResize: (id, width, final) => {
      if (final) onColumnsChange(columns.map((c) => (c.id === id ? { ...c, width } : c)));
    },
    onRowResize: () => {
      // Grid commits height into its own baseHeights array; this callback
      // is just for adopters who want to persist the value.
    },
    onRowReorder: (_from, to, movedRow) => {
      console.log(`[showcase] row reorder: [${movedRow.join(', ')}] → ${to}`);
    },
    onReplace: (rowIndex, columnId, newValue, oldValue) => {
      console.log(`[showcase] replace (${rowIndex}, ${columnId}): ${String(oldValue)} → ${newValue}`);
    },
  });

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        <Btn onClick={() => grid?.setLoading(true)}>setLoading(true)</Btn>
        <Btn onClick={() => grid?.setLoading(false)}>setLoading(false)</Btn>
        <Btn
          onClick={() => {
            if (!grid) return;
            for (let r = 0; r < 5; r++) grid.flashRow(r);
          }}
        >
          flashRow ×5
        </Btn>
        <Btn onClick={() => grid?.autoSizeColumns()}>autoSizeColumns()</Btn>
        <Btn onClick={() => grid?.gotoCell(0, 0)}>Ctrl+Home</Btn>
        <Btn onClick={() => grid?.gotoCell(99_999, 6)}>Ctrl+End</Btn>
        <Btn onClick={() => grid?.openFind()}>Find (Ctrl+F)</Btn>
        <Btn onClick={() => grid?.openAggregationPanel()}>Aggregations</Btn>
        <Btn onClick={() => grid?.openFilterPanel()}>Filters</Btn>
        <Btn onClick={() => grid?.openPivotPanel()}>Pivot</Btn>
      </div>
      <div
        ref={ref}
        style={{
          height: 360,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          overflow: 'hidden',
          position: 'relative',
        }}
        tabIndex={0}
      />
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
        Tip: drag a column border to resize · double-click a column border to
        auto-size · drag a row's bottom edge to resize · click the grid
        and use Ctrl+Home/End/Arrow/PgUp/PgDn for Excel-class navigation.
      </div>
    </>
  );
}
