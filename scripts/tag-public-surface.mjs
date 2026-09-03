#!/usr/bin/env node
// =============================================================================
// scripts/tag-public-surface.mjs
//
// Insert a stability tag into the JSDoc of every untagged top-level export
// in a package's src/index.ts. Uses the same regex/scan rules as
// check-public-surface.mjs so the two stay in lock-step.
//
// Behavior:
//   - If the export already has a JSDoc block, inject a `* @<tag>` line
//     just before the closing `*/`.
//   - If the export has no JSDoc, insert a `/** @<tag> */` line before it.
//
// Re-exports (`export { x } from './y'` and `export *`) are left alone —
// tags live at the original declaration site.
//
// Usage:
//   node scripts/tag-public-surface.mjs <package-short-name> [tag]
//
// Example:
//   node scripts/tag-public-surface.mjs protocol public
//   node scripts/tag-public-surface.mjs mcp beta
//
// Default tag is `public`. Idempotent — running twice is a no-op.
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STABILITY_TAGS = ['@public', '@beta', '@internal', '@deprecated'];
// NOTE: `new URL(...).pathname` yields a leading-slash path on Windows
// (`/C:/Users/...`), which every fs call then rejects — the walk found no
// package and the script exited 0 having checked NOTHING. Use fileURLToPath,
// which is the platform-correct conversion.
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const EXPORT_LINE_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:type|interface|class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/;
const REEXPORT_RE = /^export\s+(?:type\s+)?\{[^}]*\}\s*from\s+['"][^'"]+['"]/;
const REEXPORT_STAR_RE = /^export\s+\*\s+from\s+['"][^'"]+['"]/;
const NAMED_EXPORT_BLOCK_RE = /^export\s+(?:type\s+)?\{([^}]+)\}\s*;?\s*$/;

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function findLeadingJsdoc(rawLines, lineIdx) {
  let i = lineIdx - 1;
  while (i >= 0 && rawLines[i].trim() === '') i--;
  if (i < 0) return null;
  if (!rawLines[i].trimEnd().endsWith('*/')) return null;
  const end = i;
  while (i >= 0 && !rawLines[i].trimStart().startsWith('/**')) i--;
  if (i < 0) return null;
  return { startLine: i, endLine: end };
}

function findPackageDir(short) {
  for (const root of ['packages', 'packages/adapters']) {
    const dir = join(REPO_ROOT, root, short);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

function findEntry(dir) {
  for (const cand of ['src/index.ts', 'src/index.tsx']) {
    const p = join(dir, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

function indentOf(line) {
  const m = /^(\s*)/.exec(line);
  return m ? m[1] : '';
}

async function processFile(file, tag) {
  const src = await readFile(file, 'utf8');
  const rawLines = src.split('\n');
  const stripped = stripBlockComments(src).split('\n');

  // Collect edits as (lineIdx, newText, replaceCount). Apply bottom-up so
  // earlier indices stay valid.
  const edits = [];

  for (let i = 0; i < stripped.length; i++) {
    const t = stripped[i].trimStart();
    if (!t.startsWith('export')) continue;
    if (REEXPORT_STAR_RE.test(t)) continue;
    if (REEXPORT_RE.test(t)) continue;
    if (NAMED_EXPORT_BLOCK_RE.test(t)) continue;
    if (!EXPORT_LINE_RE.test(t)) continue;

    const doc = findLeadingJsdoc(rawLines, i);
    if (doc) {
      const docText = rawLines.slice(doc.startLine, doc.endLine + 1).join('\n');
      if (STABILITY_TAGS.some((x) => docText.includes(x))) continue;
      if (doc.startLine === doc.endLine) {
        // Single-line `/** X */`. Rewrite to a multi-line block that
        // carries both the original prose and the stability tag.
        const line = rawLines[doc.startLine];
        const indent = indentOf(line);
        const inner = line.trim().replace(/^\/\*\*\s?/, '').replace(/\s?\*\/$/, '');
        const replacement = [
          `${indent}/**`,
          `${indent} * ${inner}`,
          `${indent} * @${tag}`,
          `${indent} */`,
        ];
        edits.push({ atLine: doc.startLine, replaceCount: 1, lines: replacement });
      } else {
        // Multi-line block — inject `* @tag` just before the closing `*/`.
        const closingLine = rawLines[doc.endLine];
        const indent = indentOf(closingLine).replace(/\s$/, '');
        edits.push({ atLine: doc.endLine, replaceCount: 0, lines: [`${indent} * @${tag}`] });
      }
    } else {
      const indent = indentOf(rawLines[i]);
      edits.push({ atLine: i, replaceCount: 0, lines: [`${indent}/** @${tag} */`] });
    }
  }

  if (edits.length === 0) return { file, edits: 0 };

  // Apply edits bottom-up.
  edits.sort((a, b) => b.atLine - a.atLine);
  for (const e of edits) {
    rawLines.splice(e.atLine, e.replaceCount, ...e.lines);
  }

  await writeFile(file, rawLines.join('\n'), 'utf8');
  return { file, edits: edits.length };
}

async function main() {
  const [short, rawTag] = process.argv.slice(2);
  if (!short) {
    console.error('usage: node scripts/tag-public-surface.mjs <package> [public|beta|internal|deprecated]');
    process.exit(2);
  }
  const tag = (rawTag ?? 'public').toLowerCase();
  if (!['public', 'beta', 'internal', 'deprecated'].includes(tag)) {
    console.error(`bad tag: ${tag}`);
    process.exit(2);
  }
  const dir = findPackageDir(short);
  if (!dir) {
    console.error(`package not found: ${short}`);
    process.exit(2);
  }
  const entry = findEntry(dir);
  if (!entry) {
    console.error(`no src/index.ts in ${dir}`);
    process.exit(2);
  }
  const result = await processFile(entry, tag);
  console.log(`${short}: inserted @${tag} on ${result.edits} export(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
