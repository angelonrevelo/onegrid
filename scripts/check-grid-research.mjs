#!/usr/bin/env node
// =============================================================================
// scripts/check-grid-research.mjs
//
// The acceptance gate for the grid-landscape survey.
//
// "Research everything" does not stick, because nothing checks it. This script
// recomputes the ground truth from docs/research/grid-registry.json and refuses
// a partial answer in BOTH directions:
//
//   - every registry id must have a section in the survey   (nothing MISSING)
//   - every survey section must have a registry id          (nothing INVENTED)
//
// A count-only gate ("at least 40 sections") passes forty fabrications, so
// coverage alone is not enough. Each section must additionally:
//
//   - fill EVERY required field from the registry's `requiredField` list
//   - contain no placeholder text (TBD / TODO / ??? / lorem / n/a)
//   - cite at least one http(s) source URL
//
// "Not documented" IS an acceptable finding — vendors genuinely omit things —
// but only in the form `not documented` accompanied by a source URL, so the
// claim records where we looked rather than what we assumed.
//
// Usage:
//   node scripts/check-grid-research.mjs           # enforce (exit 1 on a gap)
//   node scripts/check-grid-research.mjs --report  # print gaps, exit 0
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_ONLY = process.argv.includes('--report');

const REGISTRY = join(ROOT, 'docs', 'research', 'grid-registry.json');
const SURVEY = join(ROOT, 'docs', 'research', 'grid-landscape.md');

/** Text that means "I did not actually find this out". */
const PLACEHOLDER = /\b(TBD|TODO|FIXME|\?\?\?|lorem ipsum|xxx|coming soon)\b/i;

/**
 * Sections are `### <name> {#grid:<id>}`. The explicit anchor id is what binds
 * a prose heading to a registry entry — matching on the display name would
 * break the moment a heading is reworded, and would silently drop coverage.
 */
function parseSection(markdown) {
  const line = markdown.split(/\r?\n/);
  const section = [];
  let current = null;

  for (let i = 0; i < line.length; i++) {
    const heading = /^###\s+(.*?)\s*\{#grid:([a-z0-9-]+)\}\s*$/.exec(line[i]);
    if (heading) {
      if (current !== null) section.push(current);
      current = { id: heading[2], name: heading[1], line: i + 1, body: [] };
      continue;
    }
    // A new ## or ### ends the current section.
    if (current !== null && /^##\s/.test(line[i])) {
      section.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.body.push(line[i]);
  }
  if (current !== null) section.push(current);

  return section.map((s) => ({ ...s, body: s.body.join('\n') }));
}

function main() {
  for (const path of [REGISTRY, SURVEY]) {
    if (!existsSync(path)) {
      console.error(`FAIL: missing ${path.replace(ROOT, '.')}`);
      process.exit(1);
    }
  }

  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const requiredField = registry.requiredField ?? [];
  const expected = new Map(registry.grid.map((g) => [g.id, g]));

  const section = parseSection(readFileSync(SURVEY, 'utf8'));
  const seen = new Map();
  const failure = [];

  for (const s of section) {
    if (seen.has(s.id)) {
      failure.push(`DUPLICATE  grid-landscape.md:${s.line}  "${s.id}" already documented at line ${seen.get(s.id).line}`);
      continue;
    }
    seen.set(s.id, s);

    // ---- Direction 2: nothing invented. ----
    if (!expected.has(s.id)) {
      failure.push(`ORPHAN     grid-landscape.md:${s.line}  "${s.id}" is not an id in grid-registry.json`);
      continue;
    }

    // ---- Substance, not just presence. ----
    for (const field of requiredField) {
      // Fields are rendered as `- **<field>:** …` rows.
      const row = new RegExp(`^\\s*[-*]\\s*\\*\\*${field}\\s*:?\\*\\*\\s*(.+)$`, 'im').exec(s.body);
      if (row === null) {
        failure.push(`NO FIELD   "${s.id}" is missing the required field "${field}"`);
        continue;
      }
      const value = row[1].trim();
      if (value === '' || value === '-' || value === '—') {
        failure.push(`EMPTY      "${s.id}" field "${field}" has no value`);
      }
    }

    if (PLACEHOLDER.test(s.body)) {
      const hit = PLACEHOLDER.exec(s.body);
      failure.push(`PLACEHOLDER "${s.id}" contains placeholder text "${hit[0]}" — research it or say "not documented" with a URL`);
    }

    const url = s.body.match(/https?:\/\/[^\s)<>\]]+/g) ?? [];
    if (url.length === 0) {
      failure.push(`NO SOURCE  "${s.id}" cites no source URL`);
    }

    // "not documented" is allowed, but must be near a URL so the claim records
    // where we looked. Cheap proxy: the section has to cite something.
    if (/not documented/i.test(s.body) && url.length === 0) {
      failure.push(`UNSOURCED  "${s.id}" says "not documented" without citing where that was checked`);
    }
  }

  // ---- Direction 1: nothing missing. ----
  for (const [id, grid] of expected) {
    if (!seen.has(id)) {
      failure.push(`MISSING    "${id}" (${grid.name}) is in the registry but has no section in grid-landscape.md`);
    }
  }

  console.log(`registry entries : ${expected.size}`);
  console.log(`survey sections  : ${seen.size}`);
  console.log(`required field   : ${requiredField.length}`);
  console.log(`failures         : ${failure.length}`);

  if (failure.length > 0) {
    console.log('');
    for (const f of failure.slice(0, 80)) console.log(`  ${f}`);
    if (failure.length > 80) console.log(`  … and ${failure.length - 80} more`);
    console.log('');
    if (REPORT_ONLY) {
      console.log('(--report: exiting 0 despite failures)');
      process.exit(0);
    }
    console.error(`FAIL: ${failure.length} survey gap(s).`);
    process.exit(1);
  }

  console.log('\nOK: every registry grid is documented, every section is sourced, no placeholders.');
}

main();
