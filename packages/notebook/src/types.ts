// =============================================================================
// Notebook document model — the data types.
//
// Everything here is `readonly`. A NotebookDocument is a value, never a
// mutable object graph: every operation in this package (edit, run, mark
// stale) returns a NEW document and leaves the input untouched. That is
// what lets a UI diff two revisions cheaply and what makes undo/redo a
// matter of holding on to an old reference.
// =============================================================================

import type { ColumnInput, ColumnTable } from '@onegrid/data';

/**
 * Cell kinds. The kind selects which kernel evaluates the cell —
 * `markdown` is the one kind this package can evaluate on its own.
 * @public
 */
export type CellKind = 'formula' | 'sql' | 'markdown' | 'javascript';

/**
 * Cell lifecycle. This is a real state machine, not a label:
 *
 *   idle    — never run, or reset. No output.
 *   queued  — scheduled in the current run, not started.
 *   running — the kernel is executing it right now.
 *   ok      — last run succeeded; `output` holds the result.
 *   error   — last run failed (its own error, or an upstream one).
 *   stale   — a dependency's source changed since this output was produced.
 *             The output is still there (a UI greys it) but it is no longer
 *             trustworthy.
 * @public
 */
export type CellState = 'idle' | 'queued' | 'running' | 'ok' | 'error' | 'stale';

/**
 * A columnar result, shaped so it can be handed straight to a grid.
 * `column` is exactly `@onegrid/data`'s `ColumnInput[]`, so
 * `toColumnTable(output)` is a call to `createColumnTable` and nothing else.
 * @public
 */
export interface TableOutput {
  readonly kind: 'table';
  readonly column: ReadonlyArray<ColumnInput>;
  readonly numRow: number;
}

/** A single value — the common case for a formula cell. @public */
export interface ScalarOutput {
  readonly kind: 'scalar';
  readonly value: unknown;
}

/**
 * A failure. `cellId` is the OFFENDING cell — the one that actually threw.
 * When the error propagates to a dependent, the dependent's output keeps
 * pointing at the origin, so a UI can jump the user to the real problem
 * instead of to a downstream victim.
 * @public
 */
export interface ErrorOutput {
  readonly kind: 'error';
  readonly message: string;
  readonly cellId: string;
}

/** Rendered markdown text (references already interpolated). @public */
export interface MarkdownOutput {
  readonly kind: 'markdown';
  readonly text: string;
}

/** @public */
export type CellOutput = TableOutput | ScalarOutput | ErrorOutput | MarkdownOutput;

/**
 * One notebook cell. `name` is what OTHER cells reference; an unnamed cell
 * can depend on others but nothing can depend on it.
 * @public
 */
export interface NotebookCell {
  readonly id: string;
  readonly kind: CellKind;
  readonly source: string;
  readonly name?: string;
  readonly output?: CellOutput;
  readonly state: CellState;
}

/**
 * An ordered list of cells plus a monotonic revision counter. Document
 * order is presentation order only — EXECUTION order comes from the
 * dependency graph, so a cell may legally reference one declared below it.
 * @public
 */
export interface NotebookDocument {
  readonly cell: ReadonlyArray<NotebookCell>;
  readonly revision: number;
}

/**
 * What a kernel sees. Dependency values are resolved and unwrapped before
 * the kernel runs: a scalar arrives as its value, markdown as its text,
 * a table as a materialised `ColumnTable`.
 * @public
 */
export interface KernelScope {
  /** The cell currently being evaluated. */
  readonly cellId: string;
  /** Names this cell may read — its direct dependencies. */
  readonly name: ReadonlyArray<string>;
  readonly has: (name: string) => boolean;
  /** Unwrapped dependency value: scalar → value, markdown → text,
   *  table → ColumnTable (materialised once, then cached). */
  readonly get: (name: string) => unknown;
  /** The raw output object, when a kernel wants the discriminant. */
  readonly output: (name: string) => CellOutput | undefined;
  /** Aborts when the run is cancelled. Long kernels should check it. */
  readonly signal: AbortSignal;
}

/**
 * The pluggable execution backend. The formula engine, DuckDB and a GPU
 * kernel all fit this shape — the notebook never learns what a kernel is
 * made of, only that it turns a source string plus a scope into an output.
 *
 * Throwing is allowed and is turned into an `ErrorOutput`; returning an
 * `ErrorOutput` explicitly is equivalent.
 * @public
 */
export interface Kernel {
  readonly language: CellKind;
  readonly evaluate: (source: string, scope: KernelScope) => CellOutput | Promise<CellOutput>;
}

/** Convenience alias for the `toColumnTable` return type. @public */
export type NotebookColumnTable = ColumnTable;
