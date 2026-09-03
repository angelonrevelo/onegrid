// =============================================================================
// Kernels
//
// A kernel is the only thing in this package that knows what a language
// MEANS. The notebook owns the graph, the states and the scheduling; the
// kernel owns evaluation. That split is what lets the same document be
// driven by @onegrid/formula, by DuckDB-WASM, or by a WebGPU compute kernel
// without the document model changing a line.
//
// Two kernels ship here:
//
//   createMarkdownKernel — built in, because prose interpolation needs no
//     backend: `{{name}}` is replaced with the referenced cell's value.
//     Registered automatically unless the adopter supplies their own.
//
//   createFormulaKernel — delegates to @onegrid/formula's engine. The
//     interesting part is the bridge. The formula grammar surfaces a bare
//     identifier as a ZERO-ARGUMENT CALL, and the evaluator resolves a
//     zero-arg call against the FUNCTION TABLE first — so a cell named
//     `base` would silently be Excel's BASE() and evaluate to #NUM!.
//     Named-range resolution alone therefore cannot carry notebook names.
//     Instead the kernel parses the source itself and rewrites every
//     zero-arg call that matches a name in scope into a reference node the
//     resolver answers from scope, which makes an in-scope notebook name
//     win over a same-named built-in. `getNamedRange` stays wired for the
//     paths the rewrite cannot see (a name bound inside LET, say).
// =============================================================================

import { evaluate, isFormulaError, parseFormula } from '@onegrid/formula';
import type { FormulaNode } from '@onegrid/formula';
import { interpolate } from './reference';
import { toColumnTable } from './output';
import type { CellOutput, Kernel, KernelScope } from './types';

/**
 * Registry mapping a cell kind to the kernel that evaluates it.
 * @public
 */
export interface KernelRegistry {
  readonly get: (language: string) => Kernel | undefined;
  readonly language: ReadonlyArray<string>;
}

/**
 * Build a registry. Later kernels win over earlier ones for the same
 * language, so an adopter can override the built-in markdown kernel by
 * appending their own.
 * @public
 */
export function createKernelRegistry(kernel: ReadonlyArray<Kernel>): KernelRegistry {
  const byLanguage = new Map<string, Kernel>();
  byLanguage.set('markdown', createMarkdownKernel());
  for (const k of kernel) byLanguage.set(k.language, k);
  return {
    get: (language) => byLanguage.get(language),
    language: [...byLanguage.keys()],
  };
}

/**
 * Markdown cell kernel: substitutes `{{name}}` with the referenced cell's
 * value and emits the result as a `markdown` output.
 * @public
 */
export function createMarkdownKernel(): Kernel {
  return {
    language: 'markdown',
    evaluate: (source, scope): CellOutput => ({
      kind: 'markdown',
      text: interpolate(source, (name) => (scope.has(name) ? scope.get(name) : undefined)),
    }),
  };
}

/** Options for {@link createFormulaKernel}. @public */
export interface FormulaKernelOption {
  /**
   * Resolve an A1-style cell reference the notebook knows nothing about
   * (`=A1 + total`). Without it, an A1 reference evaluates to `#REF!`.
   */
  readonly getCell?: (ref: string) => unknown;
  /** Resolve an A1-style range reference (`=SUM(A1:A9)`). */
  readonly getRange?: (ref: string) => ReadonlyArray<unknown>;
}

/**
 * A kernel backed by `@onegrid/formula`. Sources may be written with or
 * without Excel's leading `=`.
 *
 * Name resolution: a referenced cell arrives as a scalar value, as the text
 * of a markdown cell, or — for a table — as a flat array when it has one
 * column and as an array of row arrays when it has several. That is exactly
 * what `SUM(sale)` and `INDEX(matrix, 2, 3)` expect to receive.
 * @public
 */
export function createFormulaKernel(option: FormulaKernelOption = {}): Kernel {
  return {
    language: 'formula',
    evaluate: (source, scope): CellOutput => {
      const text = source.trimStart().startsWith('=') ? source.trimStart().slice(1) : source;
      if (text.trim() === '') return { kind: 'scalar', value: null };
      let node: FormulaNode;
      try {
        node = substituteScopeName(parseFormula(text), scope) as FormulaNode;
      } catch (err) {
        return {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          cellId: scope.cellId,
        };
      }
      const value = evaluate(node, {
        getCell: (ref) => {
          if (ref.startsWith(SCOPE_REF_PREFIX)) return formulaValue(scope, ref.slice(SCOPE_REF_PREFIX.length));
          if (scope.has(ref)) return formulaValue(scope, ref);
          return option.getCell ? option.getCell(ref) : undefined;
        },
        getRange: (ref) => (option.getRange ? option.getRange(ref) : []),
        getNamedRange: (name) => (scope.has(name) ? formulaValue(scope, name) : undefined),
      });
      if (isFormulaError(value)) {
        return {
          kind: 'error',
          message: value.message === value.code ? value.code : `${value.code} ${value.message}`,
          cellId: scope.cellId,
        };
      }
      return { kind: 'scalar', value };
    },
  };
}

/**
 * Reference sentinel. A NUL character cannot appear in a formula source, so
 * a ref carrying this prefix is unambiguously one the kernel synthesised.
 */
const SCOPE_REF_PREFIX = '\u0000scope:';

/**
 * Rewrite `name` (a zero-arg call node) into a NUL-prefixed cell-ref
 * node wherever `name` is a dependency in scope. The walk is structural
 * rather than per-node-kind so it keeps working as the formula AST grows
 * new node types.
 */
function substituteScopeName(node: unknown, scope: KernelScope): unknown {
  if (Array.isArray(node)) return node.map((child) => substituteScopeName(child, scope));
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  if (
    record.kind === 'call' &&
    typeof record.name === 'string' &&
    Array.isArray(record.args) &&
    record.args.length === 0 &&
    scope.has(record.name)
  ) {
    return { kind: 'cellRef', ref: `${SCOPE_REF_PREFIX}${record.name}` };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = substituteScopeName(value, scope);
  return out;
}

/** Flatten a dependency's output into the shape the formula evaluator wants. */
function formulaValue(scope: KernelScope, name: string): unknown {
  const output = scope.output(name);
  if (!output) return undefined;
  switch (output.kind) {
    case 'scalar':
      return output.value;
    case 'markdown':
      return output.text;
    case 'error':
      return undefined;
    case 'table': {
      const table = toColumnTable(output);
      if (table.schema.length === 1) {
        const vector = table.column(table.schema[0]!.id);
        const flat: unknown[] = [];
        for (let r = 0; r < table.numRows; r++) flat.push(vector.get(r));
        return flat;
      }
      const row: unknown[][] = [];
      for (let r = 0; r < table.numRows; r++) {
        row.push(table.schema.map((s) => table.column(s.id).get(r)));
      }
      return row;
    }
  }
}
