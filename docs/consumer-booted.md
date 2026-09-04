# Consumer report: booted

`~/Code/booted` is the first real out-of-repo consumer of oneGrid, and the most
useful one, because its constraints are hostile in exactly the ways a published
grid's constraints are hostile. It is not a pnpm workspace, it holds two
dependencies on purpose, and its whole safety model is that the process
rendering the grid never holds a database connection string.

Its own findings live in `~/Code/booted/docs/tunnelmind-onegrid-gap.md`, which
separates *wireable* gaps (booted has not called an API that exists) from
*repo-innate* ones (the capability does not exist, or exists in a shape that
cannot answer the question). This file is the oneGrid-side answer to the innate
list: what we closed, what we did not, and what is still true.

Measured 2026-09-04.

---

## How booted consumes oneGrid

Two seams, both filesystem links — never an install.

**1. The bundler alias** (`web/onegrid-link.mjs`). oneGrid's packages declare
each other as `workspace:*` and none is published, so `npm i file:../onegrid/...`
cannot resolve the protocol and corrupts booted's tree. booted therefore aliases
each `@onegrid/*` specifier at the Vite layer.

The important detail is what it does when the alias target is **missing**.
oneGrid's `dist/` is a build artifact, and booted's own `bin/derived.mjs` deletes
build artifacts in any repo idle 30 days — which is how it was found missing on
2026-09-02. An alias pointing at an absent file fails the Vite build outright
and would take booted's whole catalog down, so a missing build falls back to
`src/component/grid-fallback.tsx`, which implements the small surface booted
uses and *says* it is doing so. A plain table that admits it is a plain table,
rather than a blank screen.

**2. The HTTP queryable** (`web/server/onegrid-queryable.mjs` →
`createBootedQueryable`). This is the seam that closed the biggest innate gap;
see below.

---

## Innate gaps: closed

### `rowHeight` was required but read as optional — **closed**

`OneGridProps` required `rowHeight`, which is not obvious from the name, and the
failure was a type error rather than a sensible default. It was the first thing
a new consumer hit.

`GridOptions.rowHeight` is now optional and defaults to `DEFAULT_ROW_HEIGHT`
(32, the comfortable-density row height). `Grid` resolves it in one place, and
`@onegrid/test`'s `mountGrid` resolves it the *same* way — a harness that
disagreed with the Grid about row height would compute geometry that silently
disagreed with what was painted, and every coordinate-based test helper would
click the wrong cell.

### The Postgres adapter needed a connection booted will not make — **closed**

`@onegrid/postgres` assumed a node-postgres client in the process rendering the
grid. booted reaches databases through `docker exec` / ssh and holds no
connection string in that process, so the adapter was unusable there — not
because it was wrong, but because it assumed a topology booted deliberately does
not have.

`createHttpQueryable` (`packages/adapters/postgres/src/http.ts`) is the same
`PgQueryable` surface over `POST { sql, param } → { row }`. The server on the
other side runs the SQL; the rendering process never sees a credential. booted
consumes it directly.

The consequence recorded in booted's file — that `@onegrid/ssrm` could not be
used as designed either, so paging was `LIMIT`/`OFFSET` rather than keyset — is
what this unblocks: the HTTP queryable satisfies the same contract the keyset
cursor path is built on.

---

## Innate gaps: still open

### Not published, and `workspace:*` internally — **still true**

Every package still declares its siblings as `workspace:*` and none is on npm.
booted's alias works, but it means oneGrid cannot be depended on by version,
cannot be pinned, and a rebuild of the sibling silently changes what booted
runs. Publishing (or shipping a bundled single-file build with no workspace
deps) remains the fix, and remains unshipped. It is tracked on the operational
track in `ROADMAP.md`, not here.

### The DTS build fails unless dependencies are built first — **not re-verified**

booted recorded that `pnpm --filter @onegrid/core build` produces working ESM
and CJS and then fails the types build with `Cannot find module
'@onegrid/protocol'`, and that you have to know to write
`--filter "@onegrid/core..."` with the trailing dots.

`pnpm --filter @onegrid/core build` succeeds here **including the DTS step** —
but only because every sibling `dist/` was already present from a prior full
build, which is precisely the condition that hides this bug. Confirming it is
closed needs a clean tree (`pnpm clean`, then a single-package build), and that
was not run. Treat this as unresolved.

---

## Not a gap, recorded so it is not re-litigated

The reverse direction matters too. booted's file lists several findings that
looked like sibling-repo bugs and were not — `~/Code/PORTS.md` being a
reservation list rather than a census, a container not being a database, and
`information_schema` foreign keys being a cartesian product for composite keys
(12,221 reported FKs across 113 tables, 77 after rewriting the query against
`pg_constraint` with `unnest(conkey, confkey) WITH ORDINALITY`).

That last one is now oneGrid's problem too, because `@onegrid/studio`
introspects foreign keys. It reads them from `pg_constraint` with the
`unnest ... WITH ORDINALITY` form for exactly this reason, and the regression is
pinned by a test. A composite-key schema is the case that exposes it, so that is
what the test uses.
