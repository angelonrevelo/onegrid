# Publishing oneGrid to npm

All `@onegrid/*` packages (44 publishable; the 4 apps under `apps/` are
`private` and never publish) are versioned together as a single
[changesets](https://github.com/changesets/changesets) `linked` group, so
a release bumps every package to the same version. The first release is
`1.0.0` (the current version in every manifest).

## One-time setup (needs your account — the agent cannot do these)

1. **Claim the `@onegrid` npm org / scope.** The packages are scoped
   `@onegrid/*`; you must own that scope on npm.
   - Create the org at <https://www.npmjs.com/org/create> (or claim the
     scope under a user account).
2. **Create an automation access token** with publish rights and add it
   to the GitHub repo as the `NPM_TOKEN` secret
   (Settings → Secrets and variables → Actions → New repository secret).
   - The release workflow reads it via `NODE_AUTH_TOKEN` (wired through
     `actions/setup-node`'s `registry-url`).
3. That's it — `GITHUB_TOKEN` is provided automatically by Actions.

## How a release happens (automated)

`.github/workflows/release.yml` runs on every push to `main`:

1. Installs, runs `pnpm typecheck` + `pnpm test` (gates the publish).
2. Runs the [changesets action](https://github.com/changesets/action):
   - If there are **pending changesets**, it opens/updates a "Version
     Packages" PR that bumps versions + writes `CHANGELOG.md` entries.
   - If versions in `main` are **ahead of npm** (e.g. the Version PR was
     merged, or the very first publish), it runs `pnpm release`
     (`turbo run build && changeset publish`) and pushes the tarballs.

So the loop is: **add a changeset → merge → the bot opens a Version PR →
merge that → it publishes.**

## The very first publish (1.0.0)

Because nothing is on the registry yet and all manifests already read
`1.0.0`, the first publish does **not** need a changeset — `changeset
publish` will publish every `@onegrid/*` package at its current `1.0.0`
because none of those versions exist on npm yet. Two ways to trigger it:

- **CI path (recommended):** once `NPM_TOKEN` is set, push to `main`. The
  release job builds, gates, and publishes 1.0.0.
- **Local path (manual, if you want to publish from your machine):**
  ```sh
  npm whoami            # confirm you're logged in as the @onegrid owner
  pnpm install
  pnpm release          # turbo build + changeset publish
  ```

## Adding changesets for future work

After any user-facing change:

```sh
pnpm changeset          # pick bump (patch/minor/major), write a summary
```

Commit the generated `.changeset/*.md`. The release bot turns it into a
Version PR on the next push to `main`.

## What was verified pre-publish (2026-06-02)

- `pnpm -r publish --dry-run` succeeds for all **44** packages; tarballs
  contain only `dist/`, `README.md`, `LICENSE`, `package.json` — no
  source or tests.
- Every publishable manifest has `license`, `repository` (+ `directory`),
  `homepage`, `bugs`, `keywords`, `publishConfig.access: public`, and a
  `files` whitelist.
- Every package has a `README.md` and a `LICENSE` in its own directory.
- The changesets config validates (`pnpm changeset status` no longer
  errors after the phantom-`@onegrid/docs` ignore entry was removed).

## Pitfalls already handled

- **npm auth in CI** — `setup-node` writes the `~/.npmrc` auth line from
  `NODE_AUTH_TOKEN`; without it `changeset publish` 401s even with the
  secret set. (Fixed in `release.yml`.)
- **`.npmrc` warnings** — `pnpm publish` emits `Unknown project config`
  warnings for pnpm-only `.npmrc` keys (`shamefully-hoist`, etc.). These
  are harmless; npm and pnpm share the file.
- **Scoped default access** — scoped packages default to *restricted* on
  npm; `publishConfig.access: public` (set on every manifest) + the
  changesets `access: public` config override that.
- **Publish with pnpm, never raw `npm publish`** — internal deps are
  declared `workspace:*`. **`pnpm publish` / `pnpm pack` rewrite them to
  the real version** (`"@onegrid/data": "1.0.0"`) in the published
  tarball; **`npm publish` / `npm pack` do NOT** — they'd ship a literal
  `"workspace:*"` that npm can't resolve, producing uninstallable
  packages. `pnpm release` → `changeset publish` uses pnpm, so the CI
  path is safe; just don't `npm publish` by hand. (Verified 2026-06-02:
  `pnpm pack @onegrid/core` → deps pinned to `1.0.0`.)
