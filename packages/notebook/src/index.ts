// =============================================================================
// @onegrid/notebook
//
// Notebook-style cells over grid data — the Jupyter pattern, with a
// spreadsheet's reactivity and a pluggable kernel.
//
// A document is an ordered list of cells; each cell has a source, an
// optional NAME, a lifecycle state, and an output. One cell's output is
// another cell's input: reference a cell by name and the graph does the
// rest. Nothing here evaluates anything itself — the KERNEL does, and a
// kernel is a two-field interface (`{ language, evaluate }`) satisfied
// equally well by the formula engine, by DuckDB-WASM, or by a WebGPU
// compute pass. `createFormulaKernel` ships as the reference implementation.
//
// The design decisions worth knowing before reading the code:
//
//   1. The document is a VALUE. Every operation returns a new document and
//      mutates nothing, so undo is "keep the old reference", and a UI can
//      diff two revisions by object identity. Unchanged cells keep their
//      identity across an update.
//
//   2. Execution order comes from the DEPENDENCY GRAPH, not document order.
//      Cell 9 may feed cell 2. Ordering is Kahn's algorithm with document
//      order as the tie-break, so runs are reproducible.
//
//   3. Re-execution is INCREMENTAL. Editing a cell re-runs that cell and the
//      transitive closure of its dependents — nothing else is handed to a
//      kernel again. The test suite asserts this by counting invocations,
//      not by trusting the description.
//
//   4. Staleness is EAGER. `updateCellSource` marks dependents `stale`
//      synchronously, before any kernel is touched, so a UI can grey them on
//      the same frame rather than after a DuckDB round-trip.
//
//   5. Errors are DATA, cancellation is an EXCEPTION. A failing cell yields
//      an `ErrorOutput` carrying the id of the cell that actually broke, and
//      its dependents inherit that id rather than blaming themselves; a run
//      always completes. A cancelled run has no meaningful result, so it
//      throws `NotebookAbortError` — with the partial document attached.
//
//   6. Cycles are FOUND, not survived. `findCycle` reports the full path
//      (`a → b → c → a`) before the first kernel call, and the participants
//      get an error output naming every member.
//
// On @onegrid/reactive: that package's Salsa-style memoiser is the right
// substrate for synchronous derived values, but its `compute` returns `T`
// (kernels are async), its database is mutable (a document is a value), and
// a cyclic query there recurses until the stack blows (a human-authored
// notebook is cyclic all the time). The demand-driven idea is shared; the
// implementation could not be. See the header of `graph.ts`.
// =============================================================================

// --- document model ---------------------------------------------------------

export type {
  CellKind,
  CellOutput,
  CellState,
  ErrorOutput,
  Kernel,
  KernelScope,
  MarkdownOutput,
  NotebookCell,
  NotebookColumnTable,
  NotebookDocument,
  ScalarOutput,
  TableOutput,
} from './types';

export {
  addCell,
  createNotebook,
  getCell,
  getCellByName,
  markStale,
  moveCell,
  removeCell,
  renameCell,
  resetNotebook,
  setCellResult,
  updateCellSource,
} from './document';
export type { CellInit } from './document';

// --- dependency graph -------------------------------------------------------

export {
  buildGraph,
  findAllCycle,
  findCycle,
  findDuplicateName,
  topoOrder,
  transitiveDependent,
} from './graph';
export type { NotebookCycle, NotebookGraph } from './graph';

export { findReference, isValidCellName, interpolate } from './reference';

// --- outputs ----------------------------------------------------------------

export {
  createTableOutput,
  isErrorOutput,
  isScalarOutput,
  isTableOutput,
  tableOutputFromRow,
  toColumnTable,
  unwrapOutput,
} from './output';

// --- kernels ----------------------------------------------------------------

export { createFormulaKernel, createKernelRegistry, createMarkdownKernel } from './kernel';
export type { FormulaKernelOption, KernelRegistry } from './kernel';

// --- execution --------------------------------------------------------------

export {
  createNotebookRunner,
  NotebookAbortError,
  runCell,
  runNotebook,
  runStale,
} from './run';
export type { NotebookRunner, RunOption, RunnerOption } from './run';

// --- serialisation ----------------------------------------------------------

export {
  fromJSON,
  NOTEBOOK_SCHEMA_VERSION,
  parseNotebook,
  stringifyNotebook,
  toJSON,
} from './serialize';
export type {
  SerializedCell,
  SerializedColumn,
  SerializedNotebook,
  SerializedOutput,
  ToJsonOption,
} from './serialize';
