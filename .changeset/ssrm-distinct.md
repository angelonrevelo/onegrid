---
"@onegrid/protocol": minor
"@onegrid/ssrm": minor
"@onegrid/postgres": minor
"@onegrid/duckdb": minor
---

Server-side set-filter values, and cheaper query changes in the server-side row model.

- `@onegrid/protocol`: an additive distinct-values request and result, and an optional `DataSource.fetchDistinct`.
- `@onegrid/ssrm`: `fetchDistinct(columnId)` asks under the active filter minus that column's own set rule, with in-flight dedupe; the HTTP transport posts to `/distinct` and treats a 404 as unsupported. `setSort` / `setFilter` accept a `debounceMs` (default 0, unchanged behaviour), and every query change aborts superseded fetches and ignores late responses — which also fixes a block fetched under an old filter being cached under the new one. The block cache keeps the blocks of the last `retainQueryCount` queries (default 2), so switching back to the previous filter or sort is a cache hit; `retainQueryCount: 1` restores the previous evict-all behaviour.
- `@onegrid/postgres`, `@onegrid/duckdb`: distinct values with counts via `GROUP BY` + `COUNT(*)`, with filter and search values always bound as parameters.

`SsrmRowSourceHandle` gained a required `fetchDistinct` member: callers using the factory are unaffected, but code implementing that interface directly must add it.
