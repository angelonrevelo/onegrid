#!/usr/bin/env node
// =============================================================================
// scripts/generate-api-reports.mjs
//
// Walks every workspace package that has a `dist/index.d.ts`, writes a
// per-package api-extractor config to <pkg>/api-extractor.json, and runs
// api-extractor to emit `docs/api/<unscoped-name>.api.md`.
//
// Modes:
//   node scripts/generate-api-reports.mjs           # update reports
//   node scripts/generate-api-reports.mjs --check   # CI gate: fail on diff
//
// The check mode runs the same flow against a temp report folder and
// compares to the committed `docs/api/*.api.md` files. CI calls this
// after `pnpm build`.
// =============================================================================

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// NOTE: `new URL(...).pathname` yields a leading-slash path on Windows
// (`/C:/Users/...`), which every fs call then rejects — the walk found no
// package and the script exited 0 having checked NOTHING. Use fileURLToPath,
// which is the platform-correct conversion.
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPORT_DIR = join(REPO_ROOT, 'docs', 'api');
const CHECK_MODE = process.argv.includes('--check');

async function findPackageDirs() {
  const out = [];
  for (const root of ['packages', 'packages/adapters']) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const name of await readdir(abs)) {
      const dir = join(abs, name);
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      out.push(dir);
    }
  }
  return out;
}

function unscoped(name) {
  return name.startsWith('@') ? name.split('/')[1] : name;
}

function relativeReportFolder(pkgDir) {
  // Compute relative path from package dir to docs/api/.
  return relative(pkgDir, REPORT_DIR).replace(/\\/g, '/');
}

function writePackageConfig(pkgDir, reportFolderRel) {
  const cfg = {
    $schema: 'https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json',
    mainEntryPointFilePath: '<projectFolder>/dist/index.d.ts',
    bundledPackages: [],
    compiler: {
      skipLibCheck: true,
      overrideTsconfig: {
        compilerOptions: {
          target: 'ES2022',
          module: 'esnext',
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          // Inject @webgpu/types so the webgpu adapters can resolve GPUDevice
          // et al. when api-extractor walks their .d.ts surface. The host
          // packages already list it in devDependencies.
          types: ['@webgpu/types'],
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          strict: true,
        },
        include: ['dist/index.d.ts'],
      },
    },
    apiReport: {
      enabled: true,
      reportFolder: `<projectFolder>/${reportFolderRel}/`,
      reportTempFolder: '<projectFolder>/temp/',
      includeForgottenExports: false,
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      compilerMessageReporting: { default: { logLevel: 'none' } },
      extractorMessageReporting: {
        default: { logLevel: 'warning' },
        'ae-missing-release-tag': { logLevel: 'none', addToApiReportFile: false },
        'ae-forgotten-export': { logLevel: 'none' },
        'ae-internal-missing-underscore': { logLevel: 'none' },
        'ae-unresolved-link': { logLevel: 'none' },
      },
      tsdocMessageReporting: { default: { logLevel: 'none' } },
    },
  };
  const path = join(pkgDir, 'api-extractor.json');
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return path;
}

// node:fs sync write — needed because api-extractor reads config off disk.
import { writeFileSync } from 'node:fs';

function runApiExtractor(pkgDir) {
  const local = 'node_modules/.bin/api-extractor';
  const bin = existsSync(join(pkgDir, local))
    ? join(pkgDir, local)
    : join(REPO_ROOT, local);
  const args = CHECK_MODE
    ? ['run', '--config', join(pkgDir, 'api-extractor.json')]
    : ['run', '--local', '--config', join(pkgDir, 'api-extractor.json')];
  const result = spawnSync(bin, args, { cwd: pkgDir, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  const dirs = await findPackageDirs();
  const results = [];

  for (const dir of dirs) {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (!pkg.name?.startsWith('@onegrid/') && pkg.name !== 'onegrid') continue;
    if (!existsSync(join(dir, 'dist/index.d.ts'))) {
      results.push({ name: pkg.name, status: 'no-dist' });
      continue;
    }
    const reportRel = relativeReportFolder(dir);
    writePackageConfig(dir, reportRel);
    const r = runApiExtractor(dir);
    if (r.ok) {
      results.push({ name: pkg.name, status: 'ok' });
    } else {
      results.push({
        name: pkg.name,
        status: 'fail',
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }
    // Clean up the temp folder api-extractor created.
    await rm(join(dir, 'temp'), { recursive: true, force: true });
  }

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  for (const r of results) {
    if (r.status === 'ok') {
      okCount++;
      console.log(`[ok]   ${r.name}`);
    } else if (r.status === 'no-dist') {
      skipCount++;
      console.log(`[skip] ${r.name} — no dist/index.d.ts (run pnpm build first)`);
    } else {
      failCount++;
      console.log(`[FAIL] ${r.name}`);
      if (r.stdout) console.log(r.stdout.split('\n').slice(0, 10).map((l) => `  | ${l}`).join('\n'));
      if (r.stderr) console.log(r.stderr.split('\n').slice(0, 10).map((l) => `  ! ${l}`).join('\n'));
    }
  }
  console.log('');
  console.log(`${okCount} ok, ${skipCount} skipped, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
