// =============================================================================
// Output helpers
//
// The `table` variant carries `@onegrid/data`'s own `ColumnInput[]` rather
// than a private row format, so handing a SQL cell's result to a grid is
// `createColumnTable(output.column)` — no conversion layer, no copy.
// =============================================================================

import { createColumnTable } from '@onegrid/data';
import type { ColumnInput, ColumnTable } from '@onegrid/data';
import type { ColumnSchema } from '@onegrid/protocol';
import type { CellOutput, ErrorOutput, ScalarOutput, TableOutput } from './types';

/**
 * Wrap columnar data as a table output, validating that every column has the
 * same length — the same invariant `createColumnTable` enforces, checked here
 * so a bad kernel fails at the boundary instead of at render time.
 * @public
 */
export function createTableOutput(column: ReadonlyArray<ColumnInput>): TableOutput {
  const numRow = column.length === 0 ? 0 : column[0]!.data.length;
  for (const c of column) {
    if (c.data.length !== numRow) {
      throw new Error(
        `[OG_NOTEBOOK_RAGGED_TABLE] column "${c.schema.id}" has length ${c.data.length}, expected ${numRow}`,
      );
    }
  }
  return { kind: 'table', column, numRow };
}

/**
 * Build a table output from row objects — the shape a SQL driver hands back.
 * Column types come from `schema` when given, otherwise every column is
 * inferred as a plain (untyped) array column.
 * @public
 */
export function tableOutputFromRow(
  row: ReadonlyArray<Record<string, unknown>>,
  schema?: ReadonlyArray<ColumnSchema>,
): TableOutput {
  const id = schema
    ? schema.map((s) => s.id)
    : [...new Set(row.flatMap((r) => Object.keys(r)))];
  const column: ColumnInput[] = id.map((columnId, i) => ({
    schema: schema?.[i] ?? { id: columnId, type: 'utf8' },
    data: row.map((r) => r[columnId]),
  }));
  return createTableOutput(column);
}

/** Materialise a table output as a `ColumnTable` the grid can render. @public */
export function toColumnTable(output: TableOutput): ColumnTable {
  return createColumnTable(output.column);
}

/** @public */
export function isTableOutput(output: CellOutput | undefined): output is TableOutput {
  return output?.kind === 'table';
}

/** @public */
export function isScalarOutput(output: CellOutput | undefined): output is ScalarOutput {
  return output?.kind === 'scalar';
}

/** @public */
export function isErrorOutput(output: CellOutput | undefined): output is ErrorOutput {
  return output?.kind === 'error';
}

/**
 * The value a dependent cell sees for this output: a scalar's value,
 * markdown's text, a table materialised as a `ColumnTable`, and `undefined`
 * for an error (an error never reaches a kernel — it short-circuits first).
 * @public
 */
export function unwrapOutput(output: CellOutput | undefined): unknown {
  if (!output) return undefined;
  switch (output.kind) {
    case 'scalar':
      return output.value;
    case 'markdown':
      return output.text;
    case 'table':
      return toColumnTable(output);
    case 'error':
      return undefined;
  }
}
