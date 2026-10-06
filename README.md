# ann_hagan — personal portfolio & journal

My personal site: a minimalist, content-first portfolio and blog with an
interactive **WebGL fluid sidebar** you can push around with your cursor.
Fully static, no backend.

## Highlights

- **Interactive fluid sidebar** — a real GPU fluid simulation (Stable-Fluids
  method, tone-mapped), calm and cursor-reactive.
- **Content collections** — write a Markdown file, get a page. Posts and projects
  are validated against Zod schemas.
- **Zero-JS by default** — Astro ships static HTML/CSS; only the sidebar hydrates.

## Tech stack

- [Astro](https://astro.build) (static output)
- Vanilla JavaScript + WebGL for the fluid effect (no framework)
- CSS Modules + CSS custom-property design tokens
- Fonts: Fraunces, Hanken Grotesk, Space Mono
- Deployed on Cloudflare Pages

## Local development

```bash
npm install      # install dependencies
npm run dev      # dev server at http://localhost:4321
npm run build    # production build -> dist/
npm run preview  # preview the production build locally
```

Developed on Node 24 LTS (Astro requires Node 18.20+ / 20.3+ / 22+).

## Project structure

```
src/
  layouts/BaseLayout.astro    # page shell: <head>, fonts, sidebar + <slot>
  components/Sidebar.astro    # dark rail + WebGL fluid canvas
  lib/fluid.js                # the GPU fluid simulation
  pages/
    index.astro               # home: intro, project grid, recent posts
    about.astro               # about
    journal/index.astro       # journal: latest post in full + archive
    journal/[id].astro        # individual post pages
  content/
    blog/*.md                 # journal entries
    projects/*.md             # project entries
  content.config.ts           # collection schemas
  styles/global.css           # design tokens + reset + layout shell
```

## Adding content

**Blog post** — add `src/content/blog/<slug>.md`:

```md
---
title: "Post title"
description: "One-line summary."
pubDate: 2026-10-05
tags: ["agents"]
draft: false
---

Your post, in Markdown.
```

**Project** — add `src/content/projects/<slug>.md`:

```md
---
title: "Project name"
summary: "One-sentence pitch."
github: "https://github.com/..."
order: 1
---
```

The filename becomes the URL slug. New files appear on the site automatically —
no code changes needed.

## Deployment

Static build on **Cloudflare Pages**:

- Build command: `npm run build`
- Output directory: `dist`
- Production branch: `develop`

Every push to `develop` triggers a new deploy.

## Credits

Fluid simulation adapted from the WebGL Stable-Fluids technique — Jos Stam's
method, popularized by Pavel Dobryakov's MIT-licensed implementation.
