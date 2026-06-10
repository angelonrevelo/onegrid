// Mirror the repo's curated, user-facing docs into the Starlight content
// collection, injecting the frontmatter Starlight needs (title +
// description) and stripping the source's leading H1 (Starlight renders
// the frontmatter title as the page heading, so keeping it would double).
//
// The SOURCE OF TRUTH is the repo's docs/*.md (and root CHANGELOG.md) —
// edit those, then re-run `pnpm --filter @onegrid/docs sync` (or just
// `build`, which runs this first). The generated files carry
// `editUrl: false` so the site's "Edit page" link doesn't point at the
// generated copy.
//
// Only conceptual / reference docs are mirrored. The internal
// wave-by-wave version logs (docs/v*.md) are intentionally NOT published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outRoot = path.join(here, 'src', 'content', 'docs');

/** @type {{ src: string, out: string, title: string }[]} */
const MANIFEST = [
  { src: 'docs/SURFACE.md', out: 'guides/api-surface-stability-policy.md', title: 'API surface stability policy' },
  { src: 'docs/SEMVER.md', out: 'guides/semantic-versioning-policy.md', title: 'Semantic versioning policy' },
  { src: 'docs/SECURITY.md', out: 'guides/security-model.md', title: 'Security model' },
  { src: 'docs/bundle-budgets.md', out: 'guides/bundle-budgets.md', title: 'Bundle budgets' },
  { src: 'docs/dbsp-spec.md', out: 'guides/dbsp-operator-algebra.md', title: 'DBSP operator algebra' },
  { src: 'CHANGELOG.md', out: 'reference/changelog.md', title: 'Changelog' },
];

/** Escape a YAML double-quoted scalar. */
function yaml(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** First prose line after the leading H1, flattened + truncated, for the
 *  meta description. Falls back to the title. */
function deriveDescription(body, fallback) {
  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    // strip inline markdown emphasis / links / code for a clean meta tag
    const flat = line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (flat.length === 0) continue;
    return flat.length > 155 ? flat.slice(0, 152).trimEnd() + '…' : flat;
  }
  return fallback;
}

/** Drop the first leading `# H1` line (and a single blank after it). */
function stripLeadingH1(body) {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#\s+/.test(lines[i])) {
    i++;
    if (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i).join('\n');
  }
  return body;
}

let written = 0;
for (const entry of MANIFEST) {
  const srcPath = path.join(repoRoot, entry.src);
  if (!fs.existsSync(srcPath)) {
    console.warn(`[docs sync] skip (missing source): ${entry.src}`);
    continue;
  }
  const raw = fs.readFileSync(srcPath, 'utf8');
  const description = deriveDescription(raw, entry.title);
  const body = stripLeadingH1(raw);
  const sourceUrl = `https://github.com/CelestialBrain/onegrid/blob/main/${entry.src}`;

  const frontmatter = [
    '---',
    `title: ${yaml(entry.title)}`,
    `description: ${yaml(description)}`,
    'editUrl: false',
    '---',
    '',
    `<!-- GENERATED from ${entry.src} by apps/docs/sync-content.mjs — edit the source, not this file. -->`,
    '',
    `:::note`,
    `This page is generated from [\`${entry.src}\`](${sourceUrl}) in the repository.`,
    `:::`,
    '',
  ].join('\n');

  const outPath = path.join(outRoot, entry.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, frontmatter + body.trimStart() + '\n');
  written++;
}

console.log(`[docs sync] ${written}/${MANIFEST.length} pages synced into src/content/docs/.`);
