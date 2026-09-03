# Remaining gaps after the live-studio sitting

Honest leftovers. Not a substitute for the gating logs under `%TEMP%/grok-goal-5e80b3c4e78c/implementer`.

## Closed this sitting

- Studio compile-and-apply through a queryable (`createStudioSession` + `createMemoryQueryable`). Tests: `packages/studio/src/__tests__/apply-live.test.ts`.
- Playground Studio surface: in-grid edit, add field, PK, FK + ON DELETE, insert/delete row, create table, feature toggles, query bench. Playwright: `studio.png` + `studio-verify.json`.
- `createHttpQueryable` consumed from booted (`web/server/onegrid-queryable.mjs` → `createBootedQueryable`) and from a studio consumer test.
- Native host PPM surface (`onegrid-native-host`, 18477 bytes). GPUI is an optional `--features gpui` binary.
- pgrx SQL compiler + optional `--features pg17`/`pg18` `#[pg_extern]` module. Default `cargo test` stays Postgres-free.

## Toolchain captured, not faked

- `cargo pgrx` is not installed (`error: no such command: pgrx`). Log: `cargo-pgrx-missing.log`.
- `cargo build --features pg18` / `pg17` fails: `$PGRX_HOME does not exist`; with `PGRX_PG_CONFIG_PATH` set to PostgreSQL 18's `pg_config`, `PgConfig has no known property named --version`. No loadable `.so`/`.dll` extension was produced. The compiler-only cdylib is not a Postgres extension.
- `cargo build --features gpui --bin onegrid-native-gpui` fails compiling `tinyvec 1.13.0` (`cannot find macro vec in this scope`). No GPUI window. PPM host remains the smoke surface.
- chrome-devtools MCP could not open a page (shared `chrome-profile` lock). Playwright + bundled Chromium against `http://[::1]:5173` verified Studio instead (`127.0.0.1:5173` is booted).

## Unfiltered `pnpm test`

Unit packages (studio, formula, xlsx, native, pgrx, preset, postgres, core, …) pass. `@onegrid/benchmarks` is Playwright against `localhost:5173` with `reuseExistingServer`; this sitting's playground was already bound there, SSRM (`localhost:3001`) tests timed out, FPS gates missed on a loaded agent box, and `modes.spec.ts` still looks for `getByRole('button', { name: 'In-memory' })` while the playground uses a `<select aria-label="data source mode">`. Full log: `%TEMP%/grok-goal-5e80b3c4e78c/implementer/pnpm-test.log`.

## Still later

- `cargo pgrx init` + a matching Postgres, then `cargo pgrx package` for a real extension artifact.
- GPUI window once `gpui-unofficial` / `tinyvec` compile on this rustc.
- Pixel-perfect Supabase chrome, RLS editor, JSON cell widgets.
