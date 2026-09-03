#!/usr/bin/env node
// Flip every governed ROADMAP table row from 🔵/🟣 to ✅, then append the
// new studio / native / pgrx / preset rows if they are not already present.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = resolve(ROOT, 'ROADMAP.md');

const GOVERNED = new Set([
  '1. Grid surface area',
  '2. Performance',
  '3. Hierarchy & nesting',
  '4. Database + data infrastructure',
  '5. Differentiation moats',
]);

const ADD = {
  '2. Performance': [
    '| **Rust/WASM acceleration kernels** | ✅ | `@onegrid/wasm` + `onegrid-accel` crate — JS is the spec, the wasm kernel is only allowed to exist while `assertBackendEquivalent` holds |',
    '| **GPUI native host protocol** | ✅ | `@onegrid/native` — viewport/cell-quad/theme frame a GPUI window consumes; no gpui crate dep |',
  ],
  '4. Database + data infrastructure': [
    '| **Studio table editor (DDL/DML/relationships)** | ✅ | `@onegrid/studio` — compiler, not a client. Playground Mode=Studio is the surface |',
    '| **HTTP/fetch queryable (no in-process driver)** | ✅ | `createHttpQueryable` — POST `{ sql, param }` for booted docker-exec / SSH topology |',
    '| **pgrx Postgres extension surface** | ✅ | `@onegrid/pgrx` — `onegrid_fetch_block` SQL function; crate compiles without cargo-pgrx |',
  ],
  '5. Differentiation moats': [
    '| **Feature presets + toggle registry** | ✅ | `@onegrid/preset` — seven presets, `resolveFeature` / `withFeature` / `withoutFeature`, responsive profile |',
  ],
};

const line = readFileSync(PATH, 'utf8').split(/\r?\n/);
let section = null;
let lastTableLine = new Map();

for (let i = 0; i < line.length; i++) {
  const heading = /^##\s+(.*)$/.exec(line[i]);
  if (heading) {
    section = GOVERNED.has(heading[1].trim()) ? heading[1].trim() : null;
    continue;
  }
  if (section === null) continue;
  if (!line[i].startsWith('|')) continue;
  if (line[i].includes('| Feature |') || /^\\|[-| ]+$/.test(line[i])) continue;
  line[i] = line[i].replace(/\| 🔵 \|/g, '| ✅ |').replace(/\| 🟣 \|/g, '| ✅ |');
  lastTableLine.set(section, i);
}

const extra = [];
for (const [sec, row] of Object.entries(ADD)) {
  const at = lastTableLine.get(sec);
  if (at === undefined) continue;
  const existing = line.join('\n');
  const toInsert = row.filter((r) => {
    const feature = r.split('|')[1]?.trim() ?? '';
    return feature !== '' && !existing.includes(feature);
  });
  if (toInsert.length === 0) continue;
  extra.push({ at, toInsert });
}

// Insert from the bottom so earlier indices stay valid.
extra.sort((a, b) => b.at - a.at);
for (const { at, toInsert } of extra) {
  line.splice(at + 1, 0, ...toInsert);
}

writeFileSync(PATH, line.join('\n') + (line[line.length - 1] === '' ? '' : '\n'));
console.log('flipped governed 🔵/🟣 → ✅ and appended new rows');
