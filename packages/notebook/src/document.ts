// =============================================================================
// Document operations
//
// Every function here returns a NEW document and mutates nothing. Cells that
// did not change keep their object identity, so a UI can compare cells by
// reference to decide what to repaint.
//
// Staleness is applied EAGERLY, at edit time, before any kernel runs. That
// is the whole point: the user types in cell `base` and the three cells
// downstream of it go grey on the same frame, without waiting for a DuckDB
// round-trip to tell them they are out of date.
// =============================================================================

import { transitiveDependent } from './graph';
import { isValidCellName } from './reference';
import type { CellKind, CellOutput, CellState, NotebookCell, NotebookDocument } from './types';

/** Input shape for creating a cell; `id` is generated when omitted. @public */
export interface CellInit {
  readonly id?: string;
  readonly kind: CellKind;
  readonly source: string;
  readonly name?: string;
}

let idCounter = 0;

/** Deterministic-enough cell id. Adopters usually supply their own. */
function nextId(): string {
  idCounter += 1;
  return `cell_${idCounter}`;
}

/**
 * Build a document from cell definitions. Every cell starts `idle` with no
 * output — a fresh notebook has computed nothing yet.
 * @public
 */
export function createNotebook(init: ReadonlyArray<CellInit> = []): NotebookDocument {
  return {
    cell: init.map(toCell),
    revision: 0,
  };
}

function toCell(init: CellInit): NotebookCell {
  if (init.name !== undefined && !isValidCellName(init.name)) {
    throw new Error(
      `[OG_NOTEBOOK_BAD_NAME] "${init.name}" is not a valid cell name; expected /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  const cell: NotebookCell = {
    id: init.id ?? nextId(),
    kind: init.kind,
    source: init.source,
    state: 'idle',
  };
  return init.name === undefined ? cell : { ...cell, name: init.name };
}

/** Look up a cell, or `undefined`. @public */
export function getCell(doc: NotebookDocument, id: string): NotebookCell | undefined {
  return doc.cell.find((c) => c.id === id);
}

/** Look up a cell by its name, or `undefined`. @public */
export function getCellByName(doc: NotebookDocument, name: string): NotebookCell | undefined {
  return doc.cell.find((c) => c.name === name);
}

/**
 * Append a cell. Existing cells are untouched — a new cell cannot invalidate
 * anything, because nothing can reference a name that did not exist yet.
 * @public
 */
export function addCell(doc: NotebookDocument, init: CellInit, index?: number): NotebookDocument {
  const cell = toCell(init);
  const at = index === undefined ? doc.cell.length : Math.max(0, Math.min(index, doc.cell.length));
  const next = [...doc.cell.slice(0, at), cell, ...doc.cell.slice(at)];
  // A new NAME can change what existing sources resolve to, so anything that
  // mentions it must be re-checked.
  const newName = cell.name;
  const dirty =
    newName === undefined
      ? []
      : next.filter((c) => c.id !== cell.id && mentions(c.source, newName)).map((c) => c.id);
  return markStaleFrom({ cell: next, revision: doc.revision + 1 }, dirty);
}

/**
 * Remove a cell and stale everything that referenced it. The dependents keep
 * their (now unbacked) outputs and go `stale`; the next run turns them into
 * whatever the kernel makes of the missing name.
 * @public
 */
export function removeCell(doc: NotebookDocument, id: string): NotebookDocument {
  const target = getCell(doc, id);
  if (!target) return doc;
  const affected = transitiveDependent(doc, id);
  const next = doc.cell.filter((c) => c.id !== id);
  return markStaleFrom({ cell: next, revision: doc.revision + 1 }, affected);
}

/**
 * Replace a cell's source. The cell itself and every transitive dependent go
 * `stale` immediately. Dependents are computed against BOTH the old and the
 * new graph, because an edit can delete a reference — the cell that used to
 * be downstream is just as out of date as the one that now is.
 * @public
 */
export function updateCellSource(
  doc: NotebookDocument,
  id: string,
  source: string,
): NotebookDocument {
  const target = getCell(doc, id);
  if (!target) return doc;
  if (target.source === source) return doc;
  const before = transitiveDependent(doc, id);
  const next: NotebookDocument = {
    cell: doc.cell.map((c) => (c.id === id ? { ...c, source } : c)),
    revision: doc.revision + 1,
  };
  const after = transitiveDependent(next, id);
  return markStaleFrom(next, [id, ...before, ...after]);
}

/**
 * Rename a cell. Every source mentioning the old or the new name changes
 * meaning, so all of them go stale along with their own dependents.
 * @public
 */
export function renameCell(doc: NotebookDocument, id: string, name: string): NotebookDocument {
  const target = getCell(doc, id);
  if (!target) return doc;
  if (!isValidCellName(name)) {
    throw new Error(`[OG_NOTEBOOK_BAD_NAME] "${name}" is not a valid cell name`);
  }
  const oldName = target.name;
  const next: NotebookDocument = {
    cell: doc.cell.map((c) => (c.id === id ? { ...c, name } : c)),
    revision: doc.revision + 1,
  };
  const touched = next.cell
    .filter(
      (c) =>
        c.id !== id && (mentions(c.source, name) || (oldName !== undefined && mentions(c.source, oldName))),
    )
    .map((c) => c.id);
  return markStaleFrom(next, [id, ...touched, ...transitiveDependent(next, id)]);
}

/** Move a cell to a new index. Presentation only — no staleness. @public */
export function moveCell(doc: NotebookDocument, id: string, index: number): NotebookDocument {
  const from = doc.cell.findIndex((c) => c.id === id);
  if (from === -1) return doc;
  const without = [...doc.cell.slice(0, from), ...doc.cell.slice(from + 1)];
  const at = Math.max(0, Math.min(index, without.length));
  return {
    cell: [...without.slice(0, at), doc.cell[from]!, ...without.slice(at)],
    revision: doc.revision + 1,
  };
}

/**
 * Mark a cell and everything downstream of it `stale`, without running
 * anything. `updateCellSource` calls this for you; call it directly when an
 * EXTERNAL input a cell reads has changed (a table reloaded under a SQL
 * cell, say).
 * @public
 */
export function markStale(doc: NotebookDocument, id: string): NotebookDocument {
  if (!getCell(doc, id)) return doc;
  return markStaleFrom(
    { cell: doc.cell, revision: doc.revision + 1 },
    [id, ...transitiveDependent(doc, id)],
  );
}

/**
 * Stale-mark a set of ids. A cell that has never produced an output stays
 * `idle` — "stale" means "the output you can see is no longer trustworthy",
 * and there is nothing to distrust yet.
 */
function markStaleFrom(doc: NotebookDocument, id: ReadonlyArray<string>): NotebookDocument {
  if (id.length === 0) return doc;
  const dirty = new Set(id);
  let changed = false;
  const cell = doc.cell.map((c): NotebookCell => {
    if (!dirty.has(c.id)) return c;
    if (c.state === 'idle' || c.state === 'stale') return c;
    changed = true;
    return { ...c, state: 'stale' };
  });
  return changed ? { cell, revision: doc.revision } : doc;
}

/** Replace a cell's state + output. Internal to the runner, exported so an
 *  adopter driving a kernel by hand can write results back. @public */
export function setCellResult(
  doc: NotebookDocument,
  id: string,
  state: CellState,
  output?: CellOutput,
): NotebookDocument {
  let changed = false;
  const cell = doc.cell.map((c): NotebookCell => {
    if (c.id !== id) return c;
    changed = true;
    const base = { ...c, state };
    if (output === undefined) {
      const { output: _dropped, ...rest } = base;
      return rest;
    }
    return { ...base, output };
  });
  return changed ? { cell, revision: doc.revision + 1 } : doc;
}

/** Clear every output and reset every cell to `idle`. @public */
export function resetNotebook(doc: NotebookDocument): NotebookDocument {
  return {
    cell: doc.cell.map((c): NotebookCell => {
      const { output: _dropped, ...rest } = c;
      return { ...rest, state: 'idle' };
    }),
    revision: doc.revision + 1,
  };
}

/** Cheap pre-filter for "could this source possibly reference `name`?". */
function mentions(source: string, name: string): boolean {
  return source.includes(name);
}
