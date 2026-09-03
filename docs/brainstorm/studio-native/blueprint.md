# oneGrid studio + native runtime

Extend-mode blueprint for the 2026-09-04 delta. Decisions, rejected alternatives, and claim ids.

## 1. Idea + thesis

oneGrid stays the MIT 10M-row grid. This sitting adds a Supabase-class table editor (`@onegrid/studio` + playground Studio mode), feature presets, a fetch queryable for hosts that will not hold a connection string, and two native seams (GPUI frame protocol, pgrx SQL function). North star: governed ROADMAP 130/130 green with a reachable surface. Non-goals: a GPUI binary in CI, cargo-pgrx in CI, npm publish. Claims: c8.

## 2. Customer

Primary: TypeScript app team embedding a grid. JTBD: edit live Postgres without AG Grid or pasting SQL. Secondary: booted operators; future GPUI hosts. Claims: c1, c8.

## 3. Market + competition

Supabase Table Editor (global, hosted Postgres), AG Grid (global, paywalled editor), booted's fallback table (local), pgAdmin/TablePlus (substitute). Moat: the same compiler runs in the browser, over HTTP, and as a SQL function. Claims: c1, c2, c8.

## 4. Product form

**sdk**. Rejected saas (would compete with Supabase) and on_device GPUI app (protocol first). Claims: c4, c6.

## 5. v1 cut

One JTBD: edit a table and see the SQL. One channel: existing adopters + booted. One price: MIT. Parked: cargo-pgrx .so, GPUI desktop, npm publish.

## 6. Frontend

Playground Studio mode: table list, row grid, command palette, SQL preview. Brand: precise, dark, compact.

## 7. Backend

Existing turbo monorepo. New seams: `PgQueryable` / `createHttpQueryable` / `DdlOperation` / `NativeFrame` / `onegrid_fetch_block`. Rejected rewriting hot paths in GPUI this quarter (c6, c7).

## 8. AI architecture

Not used in this delta. `@onegrid/ai` already exists as BYO-LLM.

## 9. Data strategy

n/a (AI unused).

## 10. GTM

Primary: wire createHttpQueryable into booted. Secondary: playground mode picker.

## 11. Money

MIT, $0. Success is booted dropping the fallback and ROADMAP green.

## 12. Constraints

Singular names. No cargo-pgrx/GPUI in CI. Default rowHeight 32.

## 13. Risk

Green-check without a surface; studio SQL never executed; GPUI protocol drift; PK-only pgrx pagination; uncommitted Claude tree. Each has a kill switch.

## 14. Timeline

Week 1: ROADMAP green. Week 1–2: Studio + HTTP queryable + default rowHeight.

## 15. Endgame

open_core. MIT sdk stays; hosted studio / GPUI desktop would be later products.

## 16. Open question

Queryable package split; cargo-pgrx versions; whether booted wants the palette or only the fetch seam.

## 17. Handoff

setup_preset vite-react (existing). P0: keep the green-check in CI; wire booted; do not take gpui/pgrx CI deps.
