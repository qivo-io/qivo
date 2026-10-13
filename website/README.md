# Website

`website/` builds the qivo.io homepage, pricing page, the rendered user guide
at `/docs/`, the sitemap and `robots.txt`. It has no bundler.
`scripts/build.mjs` renders `docs/guide/` with the code in `site/` and writes
the pages into `dist/` after `vite build`. One deployment then serves the
website, `/app` and `/admin`.

| Path | Contents |
| --- | --- |
| `index.html` | The homepage, written by hand |
| `site/pages.mjs` | The docs pages, the pricing page and the sitemap |
| `site/docs.mjs`, `site/md.mjs` | Guide loading, validation and Markdown rendering |
| `site/theme.mjs` | The shared stylesheet, header, footer and fonts |
| `site/home.mjs` | The homepage screenshot lightbox, published as `/marketing/home.js` |
| `site/nav.mjs` | The line under the sticky header once a page scrolls, and the docs sidebar opening at the current page, published as `/marketing/nav.js` |
| `public/` | Images, the Manrope font, `robots.txt` and the Microsoft publisher-domain file |

## Work on it

```sh
npm run build
npm run preview
```

Then open the address `vite preview` prints. `/` shows the homepage, and
`/app` and `/admin` work as in production. `npm run dev` has no website and
sends `/` to the app. The tests run with the rest of the suite:
`npx vitest run website`.

## Rules the build enforces

- **Only named files.** `ASSETS` in `scripts/build.mjs` lists every file
  copied from `public/`. Add new files there.
- **No application files.** The build fails rather than replace a file that
  `vite build` wrote, and never writes under `/assets/`, where the application
  keeps its year-long cached bundles.
- **No third-party requests.** Pages may not load scripts, modules,
  stylesheets, fonts, images or frames from another origin, and the build
  rejects text that looks like a credential. Plain links may point anywhere.
  The website runs on the same origin as the signed-in app.
- **Indexing.** Only production (`QIVO_ENVIRONMENT=production`) may be
  indexed. Every other build marks pages `noindex` and disallows crawling.
- **Origin.** Canonical links and the sitemap use `SITE_ORIGIN`. Production
  must be built for `https://qivo.io` and staging for
  `https://preview.qivo.io`.
- **The demo leaves it out.** demo.qivo.io serves only the application, so
  the build skips itself when `VITE_APP_MODE=demo`, and the demo build fails
  if it finds website files.

## Fonts

The "qivo" wordmark uses the same Rubik subset as the application
(`src/assets/fonts/rubik-700-qivo.woff2`), embedded in the stylesheet so it
never waits for a request. Manrope sets the text. It is published under a name
that contains a hash of its contents and preloaded at the top of every page.
`vercel.json` lets browsers keep that file for a year, so changed font bytes
must get a new name, and the build derives it from the content. Font sources
and licenses are listed in `public/marketing/README.md`.

## Docs

The guide is written in `docs/guide/`. See
[publishing documentation](../docs/documentation.md) for its rules.
`test/fixtures/docs-compatibility.json` lists published page URLs and
anchors. Never remove or rename a published page slug. To rename a published
subsection heading, keep its old anchor in that page's `aliases` in
`docs/guide/pages.json`.
