<p align="center">
  <img src="apps/showcase/screenshots/01-live-grid.png" alt="oneGrid showcase — a live 100K-row grid with a formula bar" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/TypeScript-5-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node-%E2%89%A520.10-339933" alt="Node 20.10+">
  <img src="https://img.shields.io/badge/pnpm-9-f69220" alt="pnpm 9">
</p>

# oneGrid

**A free, MIT-licensed data grid for the web that stays fast at millions of rows — for developers who want spreadsheet power without a paid tier.**

Most serious data grids lock their best features (pivots, grouping, server-side
data, Excel export) behind a commercial license. oneGrid puts all of it under MIT,
with no paywalled tier.

- **Fast at scale** — draws to a canvas instead of thousands of DOM nodes, so 10
  million rows scroll smoothly (a billion when every row is the same height).
- **Spreadsheet behaviour** — editing, copy/paste, fill-handle, grouping, pivots,
  tree data, and a formula engine covering most Excel functions, with `.xlsx`
  read/write.
- **Talks to your database** — adapters for Postgres, MySQL, SQLite, ClickHouse,
  MongoDB and more, plus Drizzle, Kysely and Prisma, with live updates when rows change.
- **Any framework** — React, Vue, Svelte, Solid, Angular, or a plain Web Component.

## Quick start

Needs Node 20.10+ and pnpm 9+.

```bash
pnpm install
pnpm build
pnpm dev          # playground + mock server-side data source
pnpm test
pnpm typecheck
pnpm bench        # Playwright performance suite
```

The playground (`apps/playground`) shows in-memory, server-side, tree, pivot,
formula and DuckDB modes. `apps/showcase` wires every package into one app — its
screenshots are in [apps/showcase/screenshots/](apps/showcase/screenshots/).

## How it works

```
your data ──► adapter (Postgres / Drizzle / DuckDB / in-memory …)
                 │   rows in blocks, live diffs over CDC
                 ▼
          @onegrid/data   columnar tables · sort · filter · group · pivot
                 │
                 ▼
          @onegrid/core   canvas renderer + accessible DOM shadow
                 │
                 ▼
     React / Vue / Svelte / Solid / Angular / Web Component
```

Everything is split into small `@onegrid/*` packages that share one wire contract,
[packages/protocol/src/index.ts](packages/protocol/src/index.ts). Install only what
you need, or the `onegrid` umbrella package for the core.

## More

- [docs/internals.md](docs/internals.md) — the full package table, per-release feature status, architecture and benchmark notes
- [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [PUBLISHING.md](PUBLISHING.md)
- [docs/](docs/) — API surface, semver policy, security, release notes
- [apps/docs](apps/docs) — Astro Starlight documentation site

## License

[MIT](LICENSE) — every package, no exceptions.
