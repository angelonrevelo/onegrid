---
"@onegrid/data-worker": minor
---

Run numeric data-worker jobs on an `@onegrid/wasm` kernel. `createDataWorkerHandler({ module, host })` binds an optional acceleration kernel (the worker also accepts `configureAccel(bytes)` and reports `accelStatus`); numeric `sortIndex`, comparison filters, `groupKey` and `aggregate` jobs run on it, with results byte-identical to `@onegrid/data`. String columns, collation, custom aggregators, row filters and NaN-bearing columns stay on the `@onegrid/data` path, per job or per filter leaf. A kernel that fails to bind never replaces a working one. Measured at 1M rows once columns are converted: 2.4–9.9× faster; the first call on a table pays the column conversion.
