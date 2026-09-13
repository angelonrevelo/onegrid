// =============================================================================
// createDataWorkerHandler — the worker-side handler table
//
// `./worker` registers this table as-is. It lives in its own module so a
// custom worker (or a test) can build the same handlers with a kernel bound,
// without importing a file whose top level calls `definePluginWorker`.
//
// The acceleration kernel is optional and never load-bearing: `selectBackend`
// does not throw, and while the selected backend is the JS reference the
// handlers call @onegrid/data directly rather than paying for a round trip
// through the reference implementation.
// =============================================================================

import { filterIndex, groupRows, pivot, sortIndex, aggregate } from '@onegrid/data';
import type { ColumnTable, FilterOptions, GroupRowsOptions, SortOptions } from '@onegrid/data';
import type {
  Aggregation,
  FilterModel,
  GroupingModel,
  PivotModel,
  SortModel,
} from '@onegrid/protocol';
import { selectBackend } from '@onegrid/wasm';
import type { AccelBackend, AccelHost, AccelModule, BackendSelection } from '@onegrid/wasm';
import { accelAggregate, accelFilterIndex, accelGroupRows, accelSortIndex } from './accel.js';

/** @public */
export interface SortInput {
  readonly table: ColumnTable;
  readonly sort: SortModel;
  readonly options?: SortOptions;
}
/** @public */
export interface FilterInput {
  readonly table: ColumnTable;
  readonly filter: FilterModel;
  readonly options?: FilterOptions;
}
/** @public */
export interface GroupInput {
  readonly table: ColumnTable;
  readonly grouping: GroupingModel;
  readonly options?: GroupRowsOptions;
}
/** @public */
export interface PivotInput {
  readonly table: ColumnTable;
  readonly model: PivotModel;
}
/** @public */
export interface AggregateInput {
  readonly table: ColumnTable;
  readonly aggregation: Aggregation;
  readonly rowIndex?: ReadonlyArray<number> | Int32Array | null;
}
/** @public */
export interface ConfigureAccelInput {
  /** Compiled kernel bytes, e.g. a fetched `index-accel.wasm`. */
  readonly byte: ArrayBuffer | Uint8Array;
}

/** Which backend the worker is using, and why. @public */
export interface AccelStatus {
  readonly backend: string;
  readonly reason: string;
}

/** @public */
export interface DataWorkerHandlerOption {
  /** Kernel to bind at startup — a module, or a factory that may throw. */
  readonly module?: AccelModule | (() => AccelModule);
  /** Override the capability probe. Tests pass a simulated host. */
  readonly host?: AccelHost;
}

/** @public */
export function createDataWorkerHandler(option: DataWorkerHandlerOption = {}) {
  let selection: BackendSelection = selectBackend(option);
  const accel = (): AccelBackend | null =>
    selection.backend.name === 'js' ? null : selection.backend;
  const status = (): AccelStatus => ({ backend: selection.backend.name, reason: selection.reason });

  return {
    sort: (input: SortInput): Int32Array => {
      const backend = accel();
      return backend
        ? accelSortIndex(backend, input.table, input.sort, input.options)
        : sortIndex(input.table, input.sort, input.options);
    },
    filter: (input: FilterInput) => {
      const backend = accel();
      return backend
        ? accelFilterIndex(backend, input.table, input.filter, input.options)
        : filterIndex(input.table, input.filter, input.options);
    },
    group: (input: GroupInput) => {
      const backend = accel();
      return backend
        ? accelGroupRows(backend, input.table, input.grouping, input.options)
        : groupRows(input.table, input.grouping, input.options);
    },
    pivot: (input: PivotInput) => pivot(input.table, input.model),
    aggregate: (input: AggregateInput): unknown => {
      const backend = accel();
      const rowIndex = input.rowIndex ?? null;
      return backend
        ? accelAggregate(backend, input.table, input.aggregation, rowIndex)
        : aggregate(input.table, input.aggregation, rowIndex);
    },
    /**
     * Bind a compiled kernel. Never rejects on a bad kernel: the worker keeps
     * its previous backend and the returned reason says what went wrong.
     */
    configureAccel: async (input: ConfigureAccelInput): Promise<AccelStatus> => {
      let module: AccelModule;
      try {
        // Copy into a fresh ArrayBuffer-backed view: a caller's view may sit on
        // a SharedArrayBuffer, which WebAssembly.compile does not accept.
        const compiled = await WebAssembly.compile(new Uint8Array(input.byte));
        const instance = await WebAssembly.instantiate(compiled, {});
        module = instance.exports as unknown as AccelModule;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { backend: selection.backend.name, reason: `kernel failed to instantiate: ${detail}` };
      }
      const next = selectBackend(option.host ? { module, host: option.host } : { module });
      if (next.backend.name === 'js' && selection.backend.name !== 'js') {
        // A kernel that was rejected must not silently demote a working one.
        return { backend: selection.backend.name, reason: next.reason };
      }
      selection.backend.dispose();
      selection = next;
      return status();
    },
    accelStatus: (): AccelStatus => status(),
  };
}
