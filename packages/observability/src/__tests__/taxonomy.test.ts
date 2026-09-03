import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  DataFetchError,
  EditorError,
  FormulaEvalError,
  GpuError,
  GRID_ERROR_CODE,
  GridError,
  PluginError,
  RenderError,
  WorkerError,
  deserializeGridError,
  isGridError,
  serializeGridError,
  toGridError,
} from '../index';

describe('error taxonomy', () => {
  it('locks the code vocabulary — adding or renaming a code must be deliberate', () => {
    // Codes are a published contract. If this snapshot changes, so does the
    // major version.
    expect([...GRID_ERROR_CODE]).toEqual([
      'OG_RENDER_CELL',
      'OG_RENDER_HEADER',
      'OG_RENDER_FRAME',
      'OG_RENDER_NO_CONTEXT',
      'OG_DATA_BLOCK_FETCH',
      'OG_DATA_BLOCK_TIMEOUT',
      'OG_DATA_BLOCK_SHAPE',
      'OG_DATA_CURSOR_DECODE',
      'OG_FORMULA_EVAL',
      'OG_FORMULA_PARSE',
      'OG_FORMULA_CYCLE',
      'OG_FORMULA_SPILL',
      'OG_EDITOR_COMMIT',
      'OG_EDITOR_VALIDATION',
      'OG_EDITOR_PARSE',
      'OG_ADAPTER_QUERY',
      'OG_ADAPTER_CONNECT',
      'OG_ADAPTER_UNSUPPORTED',
      'OG_WORKER_CRASH',
      'OG_WORKER_TIMEOUT',
      'OG_WORKER_DISPOSED',
      'OG_WORKER_PROTOCOL',
      'OG_PLUGIN_HOOK',
      'OG_PLUGIN_LOAD',
      'OG_PLUGIN_INTERFACE_VERSION',
      'OG_GPU_DEVICE_LOST',
      'OG_WEBGPU_UNAVAILABLE',
      'OG_GPU_VALIDATION',
      'OG_GPU_OUT_OF_MEMORY',
      'OG_UNKNOWN',
    ]);
    expect(new Set(GRID_ERROR_CODE).size).toBe(GRID_ERROR_CODE.length);
  });

  it('gives every subclass its subsystem and default code', () => {
    const pair = [
      [new RenderError('r'), 'render', 'OG_RENDER_CELL'],
      [new DataFetchError('d'), 'data', 'OG_DATA_BLOCK_FETCH'],
      [new FormulaEvalError('f'), 'formula', 'OG_FORMULA_EVAL'],
      [new EditorError('e'), 'editor', 'OG_EDITOR_COMMIT'],
      [new AdapterError('a'), 'adapter', 'OG_ADAPTER_QUERY'],
      [new WorkerError('w'), 'worker', 'OG_WORKER_CRASH'],
      [new PluginError('p'), 'plugin', 'OG_PLUGIN_HOOK'],
      [new GpuError('g'), 'gpu', 'OG_GPU_DEVICE_LOST'],
    ] as const;
    for (const [error, subsystem, code] of pair) {
      expect(error.subsystem).toBe(subsystem);
      expect(error.code).toBe(code);
      expect(GRID_ERROR_CODE).toContain(error.code);
      expect(error).toBeInstanceOf(GridError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('names each error after its class so a log line is readable', () => {
    expect(new DataFetchError('x').name).toBe('DataFetchError');
    expect(new GpuError('x').name).toBe('GpuError');
  });

  it('derives retryability from the failure mode', () => {
    // Device loss re-provisions; a missing adapter does not.
    expect(new GpuError('lost').retryable).toBe(true);
    expect(new GpuError('none', { code: 'OG_WEBGPU_UNAVAILABLE' }).retryable).toBe(false);
    // A malformed block body will be malformed again.
    expect(new DataFetchError('net').retryable).toBe(true);
    expect(new DataFetchError('bad', { code: 'OG_DATA_BLOCK_SHAPE' }).retryable).toBe(false);
    // Formula evaluation is deterministic in its inputs.
    expect(new FormulaEvalError('cycle', { code: 'OG_FORMULA_CYCLE' }).retryable).toBe(false);
    // A disposed worker host never answers again.
    expect(new WorkerError('gone', { code: 'OG_WORKER_DISPOSED' }).retryable).toBe(false);
    expect(new WorkerError('slow', { code: 'OG_WORKER_TIMEOUT' }).retryable).toBe(true);
    // An explicit override always wins over the derived default.
    expect(new FormulaEvalError('x', { retryable: true }).retryable).toBe(true);
  });

  it('carries a structured context bag with repo-standard cell addressing', () => {
    const error = new RenderError('boom', {
      context: { rowIndex: 41, columnId: 'amount', operation: 'render.frame', blockIndex: 2 },
    });
    expect(error.context.rowIndex).toBe(41);
    expect(error.context.columnId).toBe('amount');
    expect(error.context['blockIndex']).toBe(2);
  });

  it('withContext returns a copy and never mutates the original', () => {
    const original = new RenderError('boom', { context: { rowIndex: 1 } });
    const annotated = original.withContext({ columnId: 'sku' });
    expect(original.context.columnId).toBeUndefined();
    expect(annotated.context.rowIndex).toBe(1);
    expect(annotated.context.columnId).toBe('sku');
    expect(annotated.ts).toBe(original.ts);
    expect(annotated.name).toBe('RenderError');
  });

  it('round-trips losslessly through serialize / deserialize', () => {
    const error = new DataFetchError('block 7 failed', {
      code: 'OG_DATA_BLOCK_TIMEOUT',
      context: { blockIndex: 7, startRow: 700, operation: 'block.fetch' },
      cause: new Error('socket hang up'),
      now: () => 1_700_000_000_000,
    });
    const wire = serializeGridError(error);
    expect(JSON.parse(JSON.stringify(wire))).toBeTruthy();

    const back = deserializeGridError(wire);
    expect(back).toBeInstanceOf(DataFetchError);
    expect(back.code).toBe('OG_DATA_BLOCK_TIMEOUT');
    expect(back.subsystem).toBe('data');
    expect(back.message).toBe('block 7 failed');
    expect(back.retryable).toBe(error.retryable);
    expect(back.ts).toBe(1_700_000_000_000);
    expect(back.name).toBe('DataFetchError');
    expect(back.context['blockIndex']).toBe(7);
    expect(back.stack).toBe(error.stack);
    // And re-serializing produces an identical wire form.
    expect(serializeGridError(back)).toEqual(wire);
  });

  it('serializes a non-Error cause without throwing', () => {
    const wire = serializeGridError(new PluginError('bad', { cause: { weird: true } }));
    expect(wire.cause?.name).toBe('NonError');
    expect(wire.cause?.message).toContain('weird');
  });

  it('isGridError is a brand check that survives losing the prototype', () => {
    const error = new WorkerError('crashed');
    expect(isGridError(error)).toBe(true);
    // Simulate structured-clone across a worker boundary: own properties
    // survive, the prototype does not.
    const cloned = { ...error };
    expect(cloned instanceof GridError).toBe(false);
    expect(isGridError(cloned)).toBe(true);
    expect(isGridError(new Error('plain'))).toBe(false);
    expect(isGridError(null)).toBe(false);
    expect(isGridError('OG_WORKER_CRASH')).toBe(false);
  });

  it('normalises anything a catch block can produce', () => {
    const fromString = toGridError('literally a string', { subsystem: 'plugin' });
    expect(fromString).toBeInstanceOf(PluginError);
    expect(fromString.message).toBe('literally a string');

    const fromObject = toGridError({ status: 500 });
    expect(fromObject.code).toBe('OG_UNKNOWN');
    expect(fromObject.subsystem).toBe('unknown');
    expect(fromObject.message).toContain('500');

    const native = new TypeError('x is not a function');
    const fromNative = toGridError(native, { subsystem: 'render' });
    expect(fromNative).toBeInstanceOf(RenderError);
    // The original throw site is preserved — a fresh stack would point here.
    expect(fromNative.stack).toBe(native.stack);
    expect((fromNative as { cause?: unknown }).cause).toBe(native);
  });

  it('is idempotent — re-wrapping keeps the original classification', () => {
    const original = new FormulaEvalError('cycle', { code: 'OG_FORMULA_CYCLE' });
    const again = toGridError(original, { subsystem: 'render', context: { rowIndex: 9 } });
    expect(again.code).toBe('OG_FORMULA_CYCLE');
    expect(again.subsystem).toBe('formula');
    expect(again.context.rowIndex).toBe(9);
  });
});
