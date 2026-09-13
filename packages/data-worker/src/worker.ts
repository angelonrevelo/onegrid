// =============================================================================
// @onegrid/data-worker/worker
//
// Worker-side dispatcher. Authors who don't need custom logic can import
// this file directly as their Worker entrypoint:
//
//   // my-worker.ts
//   export {} from '@onegrid/data-worker/worker';
//
// Registers `sort`, `filter`, `group`, `pivot` and `aggregate` — each running
// the corresponding @onegrid/data function — plus `configureAccel`, which
// binds a compiled acceleration kernel so the numeric jobs run on it (see
// ./accel). Results flow through the @onegrid/worker-plugins protocol;
// transferable typed arrays + ArrayBuffers travel zero-copy.
// =============================================================================

import { definePluginWorker } from '@onegrid/worker-plugins/worker';
import { createDataWorkerHandler } from './handler.js';

export type {
  AggregateInput,
  ConfigureAccelInput,
  FilterInput,
  GroupInput,
  PivotInput,
  SortInput,
} from './handler.js';

definePluginWorker({ handlers: createDataWorkerHandler() });
