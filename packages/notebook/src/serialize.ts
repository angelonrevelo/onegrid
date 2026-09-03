// =============================================================================
// Serialisation
//
// A notebook has to survive a page reload, which means JSON — and JSON has
// no typed arrays. A table output's columns are usually Float64Array or
// Int32Array, and round-tripping them through `JSON.stringify` would turn
// each into an object keyed by index. So the encoder records the constructor
// name alongside the values and the decoder rebuilds the exact array type.
//
// BigInt is the other JSON hole: `JSON.stringify(1n)` throws. BigInt64Array
// values are encoded as decimal strings and parsed back with `BigInt()`.
//
// `schemaVersion` is stamped on every document so a future format change can
// be migrated rather than guessed at.
// =============================================================================

import type { ColumnData, ColumnInput } from '@onegrid/data';
import type { ColumnSchema } from '@onegrid/protocol';
import type { CellOutput, NotebookCell, NotebookDocument } from './types';

/** Format version written by {@link toJSON}. @public */
export const NOTEBOOK_SCHEMA_VERSION = 1;

/** JSON shape of one column of a table output. @public */
export interface SerializedColumn {
  readonly schema: ColumnSchema;
  /** Constructor name, or `'Array'` for a plain untyped column. */
  readonly arrayType: string;
  readonly data: ReadonlyArray<unknown>;
  readonly validity?: ReadonlyArray<number>;
}

/** JSON shape of a cell output. @public */
export type SerializedOutput =
  | { readonly kind: 'scalar'; readonly value: unknown }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string; readonly cellId: string }
  | {
      readonly kind: 'table';
      readonly numRow: number;
      readonly column: ReadonlyArray<SerializedColumn>;
    };

/** JSON shape of a cell. @public */
export interface SerializedCell {
  readonly id: string;
  readonly kind: NotebookCell['kind'];
  readonly source: string;
  readonly name?: string;
  readonly state: NotebookCell['state'];
  readonly output?: SerializedOutput;
}

/** JSON shape of a whole notebook. @public */
export interface SerializedNotebook {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly cell: ReadonlyArray<SerializedCell>;
}

/** Options for {@link toJSON}. @public */
export interface ToJsonOption {
  /**
   * Persist computed outputs. Default true. Set false for a "source only"
   * notebook — smaller on disk, and every cell comes back `idle`.
   */
  readonly includeOutput?: boolean;
}

/** Encode a document as a plain JSON-safe object. @public */
export function toJSON(doc: NotebookDocument, option: ToJsonOption = {}): SerializedNotebook {
  const includeOutput = option.includeOutput ?? true;
  return {
    schemaVersion: NOTEBOOK_SCHEMA_VERSION,
    revision: doc.revision,
    cell: doc.cell.map((cell) => {
      const base: SerializedCell = {
        id: cell.id,
        kind: cell.kind,
        source: cell.source,
        state: includeOutput ? cell.state : 'idle',
      };
      const withName = cell.name === undefined ? base : { ...base, name: cell.name };
      if (!includeOutput || cell.output === undefined) return withName;
      return { ...withName, output: encodeOutput(cell.output) };
    }),
  };
}

/**
 * Decode a document. Throws on an unknown `schemaVersion` rather than
 * silently mangling a newer file.
 * @public
 */
export function fromJSON(json: SerializedNotebook): NotebookDocument {
  if (json.schemaVersion !== NOTEBOOK_SCHEMA_VERSION) {
    throw new Error(
      `[OG_NOTEBOOK_SCHEMA] unsupported notebook schemaVersion ${json.schemaVersion}; expected ${NOTEBOOK_SCHEMA_VERSION}`,
    );
  }
  return {
    revision: json.revision,
    cell: json.cell.map((cell) => {
      const base: NotebookCell = {
        id: cell.id,
        kind: cell.kind,
        source: cell.source,
        state: cell.state,
      };
      const withName = cell.name === undefined ? base : { ...base, name: cell.name };
      if (cell.output === undefined) return withName;
      return { ...withName, output: decodeOutput(cell.output) };
    }),
  };
}

/** Encode then `JSON.stringify`. @public */
export function stringifyNotebook(doc: NotebookDocument, option?: ToJsonOption): string {
  return JSON.stringify(toJSON(doc, option));
}

/** `JSON.parse` then decode. @public */
export function parseNotebook(text: string): NotebookDocument {
  return fromJSON(JSON.parse(text) as SerializedNotebook);
}

function encodeOutput(output: CellOutput): SerializedOutput {
  switch (output.kind) {
    case 'scalar':
      return { kind: 'scalar', value: encodeScalar(output.value) };
    case 'markdown':
      return { kind: 'markdown', text: output.text };
    case 'error':
      return { kind: 'error', message: output.message, cellId: output.cellId };
    case 'table':
      return {
        kind: 'table',
        numRow: output.numRow,
        column: output.column.map(encodeColumn),
      };
  }
}

function decodeOutput(output: SerializedOutput): CellOutput {
  switch (output.kind) {
    case 'scalar':
      return { kind: 'scalar', value: decodeScalar(output.value) };
    case 'markdown':
      return { kind: 'markdown', text: output.text };
    case 'error':
      return { kind: 'error', message: output.message, cellId: output.cellId };
    case 'table':
      return {
        kind: 'table',
        numRow: output.numRow,
        column: output.column.map(decodeColumn),
      };
  }
}

/** A lone bigint scalar gets the same string treatment as a bigint column. */
function encodeScalar(value: unknown): unknown {
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
}

function decodeScalar(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '$bigint' in value) {
    return BigInt((value as { $bigint: string }).$bigint);
  }
  return value;
}

const TYPED_ARRAY: Record<string, (value: ReadonlyArray<unknown>) => ColumnData> = {
  Int8Array: (v) => Int8Array.from(v as number[]),
  Int16Array: (v) => Int16Array.from(v as number[]),
  Int32Array: (v) => Int32Array.from(v as number[]),
  Uint8Array: (v) => Uint8Array.from(v as number[]),
  Uint16Array: (v) => Uint16Array.from(v as number[]),
  Uint32Array: (v) => Uint32Array.from(v as number[]),
  Float32Array: (v) => Float32Array.from(v as number[]),
  Float64Array: (v) => Float64Array.from(v as number[]),
  BigInt64Array: (v) => BigInt64Array.from((v as string[]).map((s) => BigInt(s))),
  BigUint64Array: (v) => BigUint64Array.from((v as string[]).map((s) => BigInt(s))),
};

function encodeColumn(column: ColumnInput): SerializedColumn {
  const arrayType = Array.isArray(column.data) ? 'Array' : column.data.constructor.name;
  const isBig = arrayType === 'BigInt64Array' || arrayType === 'BigUint64Array';
  const data = Array.from(column.data as ArrayLike<unknown>, (v) =>
    isBig || typeof v === 'bigint' ? String(v) : v,
  );
  const base: SerializedColumn = { schema: column.schema, arrayType, data };
  return column.validity === undefined ? base : { ...base, validity: Array.from(column.validity) };
}

function decodeColumn(column: SerializedColumn): ColumnInput {
  const build = TYPED_ARRAY[column.arrayType];
  const data: ColumnData = build ? build(column.data) : [...column.data];
  const base: ColumnInput = { schema: column.schema, data };
  return column.validity === undefined
    ? base
    : { ...base, validity: Uint8Array.from(column.validity) };
}
