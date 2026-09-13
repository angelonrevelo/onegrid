---
title: Packages
description: The oneGrid package map — core, data, formulas, databases, framework adapters, and tooling. Pick only what you need.
---

oneGrid is a monorepo of focused packages. Everything builds on a small
framework-agnostic core; add only the packages a given app needs. All
packages are MIT-licensed and published under the `@onegrid/*` scope.

## Core & rendering

| Package | What it does |
| --- | --- |
| `@onegrid/core` | The engine — canvas renderer, accessibility shadow DOM, signals, layout, selection, editing, tool panels. |
| `@onegrid/headless` | Framework-agnostic host with a Lit-`ReactiveController`-shaped lifecycle, imperative surface, and SSR shadow-HTML serialization. |
| `@onegrid/a11y` | Accessibility utilities: live regions, roving tabindex, ARIA grid-pattern helpers. DOM-only. |
| `@onegrid/tokens` | Design tokens — W3C DTCG JSON compiled to CSS custom properties; theme + density slots; forced-colors mapping. |
| `@onegrid/touch` | Touch / mobile surface — pointer-events bridge, gesture recognizer, virtual-keyboard + visualViewport adapter. |
| `@onegrid/webgpu` | WebGPU compute kernels — GPU reductions, filters, and sorts over typed-array columns, with CPU fallback. |
| `@onegrid/webgpu-render` | WebGPU rendering scaffold — device acquisition, cell-quad pipeline, MSDF text shader. |

## Data & compute

| Package | What it does |
| --- | --- |
| `@onegrid/data` | Columnar data layer — Arrow-compatible tables, bitmap selection, sort cache, group tree, incremental-view-maintenance hooks. |
| `@onegrid/data-worker` | Web Worker offload for sort / filter / group / pivot — keeps million-row compute off the render thread. |
| `@onegrid/dbsp` | Differential-dataflow operator algebra — incremental view maintenance for filter / map / union / distinct / groupAgg / topK. |
| `@onegrid/reactive` | On-demand memoization substrate — input slots, tracked queries, revision-counter invalidation, backdating. |
| `@onegrid/sparklines` | In-cell sparklines — line / bar / win-loss, drawn straight to the grid canvas. No dependencies. |

## Formulas & spreadsheet

| Package | What it does |
| --- | --- |
| `@onegrid/formula` | Excel-compatible formula engine — parser, dependency graph with range nodes, demand-driven recompute. |
| `@onegrid/xlsx` | OOXML (`.xlsx`) formula interop — parses Excel formulas to the formula AST and writes them back. Clean-room from ECMA-376. |
| `@onegrid/export` | Export to CSV (built-in, zero deps) and XLSX (via a peer dependency). |

## Server & protocol

| Package | What it does |
| --- | --- |
| `@onegrid/protocol` | Wire-format and database-adapter contract types. Types only, no runtime. |
| `@onegrid/ssrm` | Server-side row model — cursor-paged block fetcher, sliding-window cache, optimistic mutations, Arrow IPC over WebSocket/SSE. |

## Databases

| Package | What it does |
| --- | --- |
| `@onegrid/postgres` | Postgres adapter — `BlockRequest` → parameterized SQL; `LISTEN/NOTIFY`-backed change feed. |
| `@onegrid/mysql` | MySQL adapter — parameterized SQL; outbox-table polling change feed. |
| `@onegrid/sqlite` | SQLite adapter — better-sqlite3, `node:sqlite`, `bun:sqlite`, and Cloudflare D1. |
| `@onegrid/clickhouse` | ClickHouse adapter — native parameterized SQL with Arrow IPC ingestion. |
| `@onegrid/duckdb` | DuckDB-WASM as a client-side query engine and row-model source. |
| `@onegrid/duckdb-join` | Cross-database joins — register heterogeneous sources as DuckDB views and join across them in the browser. |
| `@onegrid/mongo` | MongoDB adapter — find / aggregation pipeline; change-stream-backed change feed. |

## ORM & schema

| Package | What it does |
| --- | --- |
| `@onegrid/drizzle` | Drizzle ORM adapter — `BlockRequest` → Drizzle queries (Postgres / MySQL / SQLite). |
| `@onegrid/kysely` | Kysely adapter — `BlockRequest` → type-safe SQL. |
| `@onegrid/orm-sync` | Live ORM sync — bridges change-data-capture row diffs into ORM-typed model rows. |
| `@onegrid/migrate` | Codemod CLI that translates external column definitions to oneGrid `ColumnDef`. Clean-room, against publicly-described shapes only. |
| `@onegrid/introspect` | Turn a protocol `Schema`, an ORM model, or a SQL data-type list into renderable `ColumnDef[]`. |

## Collaboration & history

| Package | What it does |
| --- | --- |
| `@onegrid/crdt` | Collaborative-editing bridge — pluggable Yjs / Automerge backends translating document changes into row-diff streams. |
| `@onegrid/temporal` | Time-travel — append-only diff log with snapshot anchors; reconstruct, diff, or branch from any past version. |
| `@onegrid/undo` | Undo / redo manager — inverse-pair capture, transaction bundling, `Cmd+Z` / `Cmd+Shift+Z`. |

## Framework adapters

| Package | What it does |
| --- | --- |
| `@onegrid/react` | React hooks over the core. |
| `@onegrid/vue` | Vue 3 composables. |
| `@onegrid/svelte` | Svelte 5 runes. |
| `@onegrid/solid` | Solid.js primitives. |
| `@onegrid/angular` | Angular standalone component + signals. |
| `@onegrid/wc` | `<one-grid>` Web Component. |

## AI & extensibility

| Package | What it does |
| --- | --- |
| `@onegrid/ai` | Natural-language → typed grid intents (filter / sort / formula / mutation). Bring-your-own-LLM contract. |
| `@onegrid/mcp` | Model Context Protocol server surface — exposes grid state + mutation tools through MCP's typed shapes. |
| `@onegrid/plugin-kit` | Plugin framework — facets, compartments for hot reconfigure, typed registries, narrowed plugin context. |
| `@onegrid/worker-plugins` | Worker-boundary sandbox for user-supplied formula functions and aggregators, with zero-copy Arrow transfer. |

## Internationalization

| Package | What it does |
| --- | --- |
| `@onegrid/intl` | i18n / l10n / RTL — `Intl.*` wrappers, cached collator, ICU MessageFormat subset, BCP 47 validator, RTL helpers. |

## Meta-package

| Package | What it does |
| --- | --- |
| `onegrid` | Umbrella package re-exporting the common surface for quick starts. |
