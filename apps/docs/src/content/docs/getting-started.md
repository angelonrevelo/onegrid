---
title: Getting started
description: Install oneGrid and render your first grid — vanilla core or via a framework adapter.
---

oneGrid is a small framework-agnostic core (`@onegrid/core`) with optional
framework adapters and data/database packages layered on top. Start with the
core, then add only what you need.

## Install

```sh
# the core engine
npm install @onegrid/core

# optional: a framework adapter (pick one)
npm install @onegrid/react   # or @onegrid/vue, @onegrid/svelte, …
```

## Your first grid (vanilla)

The core renders into a host element you provide. You give it **columns** and
a **row source** — a tiny interface the grid pulls cell values from, so the
grid never owns your data.

```ts
import { Grid } from '@onegrid/core';
import type { ColumnDef, RowSource } from '@onegrid/core';

const columns: ColumnDef[] = [
  { id: 'name', width: 200, displayName: 'Name' },
  { id: 'email', width: 280, displayName: 'Email' },
  { id: 'role', width: 140, displayName: 'Role' },
];

const data = [
  { name: 'Ada Lovelace', email: 'ada@example.com', role: 'Engineer' },
  { name: 'Alan Turing', email: 'alan@example.com', role: 'Engineer' },
];

const rowSource: RowSource = {
  numRows: data.length,
  getCell: (rowIndex, columnId) => data[rowIndex]?.[columnId] ?? '',
};

const host = document.getElementById('grid')!;
const grid = new Grid({ host, columns, rowSource, rowHeight: 28 });

// later, when tearing down:
// grid.destroy();
```

The host should be a positioned element with a size — the grid fills it:

```html
<div id="grid" style="position: relative; width: 100%; height: 480px"></div>
```

## With React

`@onegrid/react` wraps the core in an idiomatic hook. `useOneGrid` returns a
`ref` to attach to your host element and the live `grid` instance for
imperative calls.

```tsx
import { useOneGrid } from '@onegrid/react';
import type { ColumnDef, RowSource } from '@onegrid/core';

const columns: ColumnDef[] = [
  { id: 'name', width: 200, displayName: 'Name' },
  { id: 'email', width: 280, displayName: 'Email' },
];

function People({ rowSource }: { rowSource: RowSource }) {
  const { ref } = useOneGrid({ columns, rowSource, rowHeight: 28 });
  return <div ref={ref} style={{ position: 'relative', height: 480 }} />;
}
```

## Scaling up

The same `RowSource` interface scales from an in-memory array to millions of
rows or a server-side model — the grid only ever asks for the cells it paints.
For server-backed data, virtualization, and a real-time row-diff protocol,
see the server-side row model in `@onegrid/ssrm` and `@onegrid/protocol`.

From here:

- [Packages](/packages/) — the full package map (data, formulas, databases,
  adapters, tooling).
- [API surface stability](/guides/api-surface-stability-policy/) — what's
  stable vs. evolving, and how the public surface is tracked.
