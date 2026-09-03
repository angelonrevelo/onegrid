#!/usr/bin/env node
// =============================================================================
// scripts/check-roadmap-green.mjs
//
// The acceptance gate for "the roadmap is done".
//
// A status emoji is a CLAIM. This script is what makes the claim cost
// something: a row may only be ✅ if `docs/roadmap-evidence.json` binds it to
// a package that exists, a symbol that is actually exported from that
// package's public entry point, and a test file that is actually on disk.
// Flipping 🔵 → ✅ in the markdown alone fails here, which is the entire
// point — the previous roadmap drifted precisely because nothing recomputed
// the ground truth.
//
// Checked in BOTH directions, because a count-only gate passes fabrications:
//   - every roadmap row must be ✅ and must have evidence   (no empty claims)
//   - every evidence entry must name a real roadmap row     (no invented rows)
//
// Usage:
//   node scripts/check-roadmap-green.mjs          # enforce (exit 1 on any gap)
//   node scripts/check-roadmap-green.mjs --report # print the gap list, exit 0
// =============================================================================

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ONLY = process.argv.includes('--report');

const DONE = '✅';

/** Sections of ROADMAP.md whose feature tables this gate governs. */
const GOVERNED = [
  '1. Grid surface area',
  '2. Performance',
  '3. Hierarchy & nesting',
  '4. Database + data infrastructure',
  '5. Differentiation moats',
];

/** `**Foo** ` / `` `Foo` `` → `Foo`. The evidence file keys on this form. */
function normalizeFeature(cell) {
  return cell
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull `| Feature | Status | Notes |` rows out of the governed sections.
 * @returns {Array<{feature: string, status: string, section: string, line: number}>}
 */
function parseRoadmapRow(markdown) {
  const line = markdown.split(/\r?\n/);
  const row = [];
  let section = null;

  for (let i = 0; i < line.length; i++) {
    const text = line[i];

    const heading = /^##\s+(.*)$/.exec(text);
    if (heading) {
      const title = heading[1].trim();
      section = GOVERNED.includes(title) ? title : null;
      continue;
    }
    if (section === null) continue;
    if (!text.startsWith('|')) continue;

    const cell = text.split('|').slice(1, -1);
    if (cell.length < 2) continue;

    const feature = normalizeFeature(cell[0]);
    const status = cell[1].trim();

    // Skip the header row and its `|---|---|---|` separator.
    if (feature === 'Feature' || /^-+$/.test(feature.replace(/\s/g, ''))) continue;
    if (feature === '') continue;

    row.push({ feature, status, section, line: i + 1 });
  }
  return row;
}

/** Directory for a package named `core` or `adapters/postgres`. */
function packageDir(name) {
  const direct = join(ROOT, 'packages', name);
  if (existsSync(direct)) return direct;
  const adapter = join(ROOT, 'packages', 'adapters', name);
  if (existsSync(adapter)) return adapter;
  return null;
}

/** Every `.ts`/`.tsx` source file under a package's `src/`, recursively. */
function sourceFile(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(join(dir, 'src'));
  return out;
}

function main() {
  const roadmapPath = join(ROOT, 'ROADMAP.md');
  const evidencePath = join(ROOT, 'docs', 'roadmap-evidence.json');

  if (!existsSync(evidencePath)) {
    console.error(`FAIL: missing ${evidencePath} — the roadmap gate has no ground truth to check against.`);
    process.exit(1);
  }

  const row = parseRoadmapRow(readFileSync(roadmapPath, 'utf8'));
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

  const failure = [];

  // ---- Direction 1: every roadmap row is done AND backed by real code. ----
  const seen = new Set();
  for (const r of row) {
    seen.add(r.feature);

    if (r.status !== DONE) {
      failure.push(`NOT DONE   ROADMAP.md:${r.line}  [${r.section}] "${r.feature}" is "${r.status}", expected ${DONE}`);
      continue;
    }

    const ev = evidence[r.feature];
    if (!ev) {
      failure.push(`NO PROOF   ROADMAP.md:${r.line}  "${r.feature}" is ${DONE} but has no entry in docs/roadmap-evidence.json`);
      continue;
    }

    const dir = packageDir(ev.package);
    if (dir === null) {
      failure.push(`NO PKG     "${r.feature}" → package "${ev.package}" does not exist under packages/`);
      continue;
    }

    const src = sourceFile(dir);
    const blob = src.map((f) => readFileSync(f, 'utf8')).join('\n');

    for (const symbol of ev.symbol ?? []) {
      if (!blob.includes(symbol)) {
        failure.push(`NO SYMBOL  "${r.feature}" → "${symbol}" not found anywhere in packages/${ev.package}/src`);
      }
    }

    for (const test of ev.test ?? []) {
      const hit = src.some((f) => f.replace(/\\/g, '/').endsWith(`/${test}`));
      if (!hit) {
        failure.push(`NO TEST    "${r.feature}" → test file "${test}" not found in packages/${ev.package}/src`);
      }
    }

    if ((ev.symbol ?? []).length === 0 || (ev.test ?? []).length === 0) {
      failure.push(`WEAK PROOF "${r.feature}" → evidence must name at least one symbol AND one test`);
    }
  }

  // ---- Direction 2: no evidence for a row that does not exist. ----
  for (const feature of Object.keys(evidence)) {
    if (!seen.has(feature)) {
      failure.push(`ORPHAN     docs/roadmap-evidence.json names "${feature}", which is not a row in any governed ROADMAP.md section`);
    }
  }

  const total = row.length;
  const done = row.filter((r) => r.status === DONE).length;

  console.log(`roadmap rows governed : ${total}`);
  console.log(`marked ${DONE}              : ${done}`);
  console.log(`evidence entries      : ${Object.keys(evidence).length}`);
  console.log(`failures              : ${failure.length}`);

  if (failure.length > 0) {
    console.log('');
    for (const f of failure) console.log(`  ${f}`);
    console.log('');
    if (REPORT_ONLY) {
      console.log('(--report: exiting 0 despite failures)');
      process.exit(0);
    }
    console.error(`FAIL: ${failure.length} roadmap gap(s).`);
    process.exit(1);
  }

  console.log('\nOK: every governed roadmap row is ✅ and backed by a real symbol + a real test.');
}

main();
