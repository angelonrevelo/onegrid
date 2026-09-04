# The data-grid landscape

A survey of every data grid, spreadsheet component and database-table UI worth
knowing about, read from the vendors' own current documentation.

**Surveyed:** 2026-09-04 · **Entries:** see `grid-registry.json`

---

## Why this document exists

oneGrid's positioning claim is "one MIT-licensed grid that consolidates what
real applications need at scale." That claim is only meaningful against a
measured field. This document is the measurement.

It is written for three specific decisions:

1. **Where the tier line actually falls.** Almost every serious grid is
   free-until-you-need-it. Knowing *exactly* which feature triggers a licence
   purchase tells us which features are worth shipping MIT, because those are
   the ones people are currently paying for.
2. **DOM vs canvas.** This is the fork in the road for a grid's architecture,
   and it determines the row ceiling, the accessibility story and whether a
   consumer's CSS carries over. Every entry records which side it took.
3. **What is genuinely hard to replicate.** Feature lists are cheap. The
   `distinctive` field on each entry is the honest answer to "what would we
   actually struggle to build?"

## Method, and its limits

- Findings come from **publicly-published documentation, marketing pages and
  public repositories**, fetched during the survey — not from recall. Each entry
  cites the pages it was derived from.
- This inherits the clean-room rule in
  `packages/migrate/src/transforms/ag-grid.ts`: no third-party source code, type
  definitions or non-public documentation was consulted.
- Where a vendor does not document a capability, the entry says **`not
  documented`** and cites the page that was checked. That is a real finding. It
  is never a guess, and the words "probably" and "likely" do not appear in a
  field value.
- **Limits worth stating.** Documentation lags implementation, marketing pages
  overstate, and several of these products ship weekly. Version-sensitive claims
  (function counts, tier boundaries, pricing) are the first thing to rot here.
  Nothing below was verified by building an application against it.

## Scope boundary

Deliberately excluded, recorded so it is not re-litigated:

- **Virtualization primitives with no grid semantics** — `react-window`,
  `react-virtual`, TanStack Virtual. They solve one axis of the problem and are
  a dependency of several entries below, not competitors to them.
- **Charting libraries with an incidental table view.**
- **BI and dashboard products where the grid is not embeddable by a developer** —
  Tableau, Power BI, Looker.

Categories used: `oss` (permissive, single tier), `hybrid-tier` (a free tier
plus a paid one), `commercial` (paid), `db-ui` (a table UI over a database
rather than a component you embed).

---

## The field at a glance

*(Comparison matrix is generated after the per-entry sections below. See
"Cross-cutting findings" at the end for the synthesis.)*

---

## Entries

