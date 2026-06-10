// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// `site` is used for canonical URLs + the sitemap. Override via the
// SITE_URL env var at build time (e.g. on Vercel) — the default is a
// placeholder until the hosted URL is claimed. See apps/docs/README.md.
const site = process.env.SITE_URL ?? 'https://onegrid-docs.vercel.app';

// https://astro.build/config
export default defineConfig({
  site,
  // Served at the domain root on Vercel. If hosting under a subpath
  // (e.g. GitHub Pages project sites), set `base` to '/onegrid'.
  base: '/',
  integrations: [
    starlight({
      title: 'oneGrid',
      description:
        'A free, MIT-licensed, framework-agnostic data grid built for millions of rows, multiple databases, formulas, instant updates, and modern ORM integrations.',
      // Search (Pagefind), dark/light toggle, and syntax highlighting are
      // built in to Starlight — no extra config needed.
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/CelestialBrain/onegrid',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/CelestialBrain/onegrid/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'index' },
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Packages', slug: 'packages' },
          ],
        },
        {
          label: 'Guides',
          // These pages are generated from the repo's docs/*.md by
          // sync-content.mjs (run as part of `build`). Edit the source in
          // docs/, not here.
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Changelog', slug: 'reference/changelog' },
            {
              label: 'API reports',
              link: 'https://github.com/CelestialBrain/onegrid/tree/main/docs/api',
              attrs: { target: '_blank', rel: 'noopener' },
            },
          ],
        },
      ],
    }),
  ],
});
