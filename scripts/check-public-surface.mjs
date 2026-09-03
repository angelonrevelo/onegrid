#!/usr/bin/env node
// =============================================================================
// scripts/check-public-surface.mjs
//
// Walks every workspace package, reads its `src/index.ts` (the canonical
// public-surface entry point — what `package.json#exports` points to), and
// verifies every top-level `export` statement is preceded by a JSDoc tag
// from the stability vocabulary:
//
//   @public      — semver-locked. Major bump to break.
//   @beta        — public but unstable.
//   @internal    — not part of the public API (rare at index.ts).
//   @deprecated  — public but scheduled for removal.
//
// Re-exports (`export { x } from './y'`) are not required to repeat a tag
// here — the tag lives at the original declaration site. Anonymous
// `export *` re-exports are warned about because they pull in unbounded
// surface area.
//
// Usage:
//   node scripts/check-public-surface.mjs           # check all packages
//   node scripts/check-public-surface.mjs core data # specific packages
// =============================================================================

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STABILITY_TAGS = ['@public', '@beta', '@internal', '@deprecated'];

// NOTE: `new URL(...).pathname` yields a leading-slash path on Windows
// (`/C:/Users/...`), which every fs call then rejects — the walk found no
// package and the script exited 0 having checked NOTHING. Use fileURLToPath,
// which is the platform-correct conversion.
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

async function findPackageDirs() {
  const out = [];
  for (const root of ['packages', 'packages/adapters']) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const name of await readdir(abs)) {
      const dir = join(abs, name);
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      out.push(dir);
    }
  }
  return out;
}

async function loadPackageMeta(dir) {
  const raw = await readFile(join(dir, 'package.json'), 'utf8');
  const json = JSON.parse(raw);
  return { name: json.name, hasExports: Boolean(json.exports), dir };
}

// Find the entry file the package publishes — typically src/index.ts.
function findEntry(dir) {
  for (const candidate of ['src/index.ts', 'src/index.tsx']) {
    const p = join(dir, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

// Strip line + block comments while preserving line breaks so reported
// line numbers stay accurate.
function stripStringsAndComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// Walk backward from a `^export ` line to find the immediately preceding
// JSDoc block (one or more `*/` ... `/**` pairs separated only by blank
// lines or other JSDoc blocks). Returns the concatenated doc text, or ''.
function findLeadingJsdoc(lines, lineIdx) {
  let i = lineIdx - 1;
  // Skip blank lines.
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0) return '';
  // Must end with `*/`.
  if (!lines[i].trimEnd().endsWith('*/')) return '';
  // Walk back to matching /**.
  const end = i;
  while (i >= 0 && !lines[i].trimStart().startsWith('/**')) i--;
  if (i < 0) return '';
  return lines.slice(i, end + 1).join('\n');
}

const EXPORT_LINE_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:type|interface|class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/;
const REEXPORT_RE = /^export\s+(?:type\s+)?\{[^}]*\}\s*from\s+['"][^'"]+['"]/;
const REEXPORT_STAR_RE = /^export\s+\*\s+from\s+['"][^'"]+['"]/;
const NAMED_EXPORT_BLOCK_RE = /^export\s+(?:type\s+)?\{([^}]+)\}\s*;?\s*$/;

function checkFile(src) {
  const stripped = stripStringsAndComments(src);
  const lines = stripped.split('\n');
  const rawLines = src.split('\n');

  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trimStart();
    if (!t.startsWith('export')) continue;

    // export * from './x' — opaque, can't enforce per-symbol; warn.
    if (REEXPORT_STAR_RE.test(t)) {
      findings.push({
        line: i + 1,
        kind: 'wildcard-reexport',
        message: `wildcard re-export — surface tags can't be verified here`,
        source: rawLines[i].trim(),
      });
      continue;
    }

    // export { Foo, Bar } from './x' — tags live at the declaration site;
    // skip. Same for `export type {...} from ...`.
    if (REEXPORT_RE.test(t)) continue;

    // export { Foo, Bar };  // local re-export — tags live at the declaration.
    if (NAMED_EXPORT_BLOCK_RE.test(t)) continue;

    // export const|let|var|function|class|interface|type|enum NAME
    const m = EXPORT_LINE_RE.exec(t);
    if (!m) continue;
    const name = m[1];

    const doc = findLeadingJsdoc(rawLines, i);
    const hasTag = STABILITY_TAGS.some((tag) => doc.includes(tag));
    if (!hasTag) {
      findings.push({
        line: i + 1,
        kind: 'untagged-export',
        name,
        source: rawLines[i].trim(),
      });
    }
  }

  return findings;
}

async function main() {
  const requested = process.argv.slice(2);
  const allDirs = await findPackageDirs();
  const metas = await Promise.all(allDirs.map(loadPackageMeta));

  const filtered = metas.filter((m) => {
    if (!m.hasExports) return false;
    if (requested.length === 0) return true;
    const short = m.name.replace(/^@onegrid\//, '');
    return requested.includes(short) || requested.includes(m.name);
  });

  let totalFindings = 0;
  let totalChecked = 0;
  const failures = [];

  for (const meta of filtered) {
    const entry = findEntry(meta.dir);
    if (!entry) {
      console.warn(`[skip] ${meta.name}: no src/index.ts`);
      continue;
    }
    totalChecked++;
    const src = await readFile(entry, 'utf8');
    const findings = checkFile(src);
    if (findings.length === 0) {
      console.log(`[ok]   ${meta.name}`);
      continue;
    }
    const hardCount = findings.filter((f) => f.kind === 'untagged-export').length;
    failures.push({ name: meta.name, entry, findings });
    totalFindings += hardCount;
    const label = hardCount > 0 ? '[FAIL]' : '[warn]';
    console.log(`${label} ${meta.name} — ${findings.length} issue(s)`);
    for (const f of findings) {
      const tag = f.kind === 'untagged-export' ? 'untagged' : f.kind;
      const where = `${entry.replace(REPO_ROOT + '/', '')}:${f.line}`;
      console.log(`         ${tag} ${f.name ?? ''} at ${where}`);
      console.log(`           > ${f.source}`);
    }
  }

  console.log('');
  console.log(`Checked ${totalChecked} package(s). Untagged exports: ${totalFindings}.`);

  // A surface gate that inspected nothing is worse than no gate: it reports
  // success for every future change. This fired for real — a Windows path bug
  // made the package walk return empty and the script exited 0 having checked
  // zero packages. Refuse that outcome loudly.
  if (totalChecked === 0) {
    console.error('FAIL: checked 0 packages — the package walk is broken, not the repo.');
    process.exit(1);
  }
  process.exit(totalFindings === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
