# @onegrid/docs

The oneGrid documentation site — [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build). Private (not published).

Search (Pagefind), light/dark toggle, and syntax highlighting are built in.

## Develop

```sh
pnpm --filter @onegrid/docs dev      # localhost:4321
pnpm --filter @onegrid/docs build    # → apps/docs/dist
pnpm --filter @onegrid/docs preview  # serve the built site on :4175
```

## Content

- **Hand-authored pages** live in `src/content/docs/`:
  `index.mdx` (landing), `getting-started.md`, `packages.md`.
- **Generated pages** under `src/content/docs/guides/` and
  `src/content/docs/reference/` are mirrored from the repo's curated docs
  by [`sync-content.mjs`](./sync-content.mjs), which runs automatically as
  part of `dev` / `build`. **Edit the source** (`docs/*.md`, root
  `CHANGELOG.md`) — not the generated copies. Re-sync explicitly with
  `pnpm --filter @onegrid/docs sync`.

The internal wave-by-wave version logs (`docs/v*.md`) are intentionally
not published; they're development history, not user docs.

## Deploy

`vercel.json` builds from the monorepo root and outputs to `dist`. Set the
`SITE_URL` env var to the hosted URL so canonical links + the sitemap are
correct (defaults to a placeholder otherwise). If hosting under a subpath
rather than a domain root, also set `base` in `astro.config.mjs`.
