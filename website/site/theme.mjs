/* Shared Airspace typography, palette and navigation for the public website.
   The locally hosted fonts and product captures make no third-party requests.
   Manrope sets the text. Every page preloads it, and browsers cache it for a
   year (see FONTS). The "Qivo" wordmark uses Rubik 700, embedded in the
   stylesheet (see WORDMARK_FONT). The signed-in application keeps its own
   appearance system. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const SITE_NAME = 'Qivo'

/** Where the site will be served. Overridable so a staging deployment emits
    its own canonicals and sitemap instead of claiming to be production. */
export const ORIGIN = (process.env.SITE_ORIGIN || 'https://qivo.io').replace(/\/+$/, '')

/** A font in public/marketing/fonts/, published under a name that contains
    the first eight hex digits of its SHA-256. vercel.json lets browsers reuse
    these files for a year without asking the server, which is what keeps the
    fonts from swapping in on every page. Changed bytes must therefore get a
    new URL, and the hash in the name does that. */
function font(name) {
  const source = `public/marketing/fonts/${name}.woff2`
  const hash = createHash('sha256')
    .update(readFileSync(new URL(`../${source}`, import.meta.url)))
    .digest('hex')
    .slice(0, 8)
  return { source, url: `/marketing/fonts/${name}.${hash}.woff2` }
}

/** The self-hosted fonts. scripts/build.mjs publishes them, and the
    stylesheet and the preloads below refer to the same URLs. */
export const FONTS = {
  manrope: font('manrope-normal-latin'),
}

/** The "Qivo" wordmark font: Google's Rubik 700 subset with only Q, i, v and
    o (about 1.2 KB), the same file the application embeds. It is embedded in
    the stylesheet, so the wordmark never waits for a download or a cache
    check. It is not published as a separate file. */
export const WORDMARK_FONT = `data:font/woff2;base64,${readFileSync(
  new URL('../../src/assets/fonts/rubik-700-qivo.woff2', import.meta.url),
).toString('base64')}`

/** Preloads for the top of every page's <head>. Chrome holds the first paint
    for fonts preloaded there, for at most about 100 ms, so a font read from
    the disk cache (a new tab or a restarted browser) is ready for the first
    frame instead of replacing a fallback a frame later. On a first visit the
    downloads start before layout asks for them. The crossorigin attribute is
    required even on the same origin, because @font-face fetches in CORS mode
    and a preload fetched any other way is not reused. */
export const FONT_PRELOADS = Object.values(FONTS)
  .map(({ url }) => `<link rel="preload" href="${url}" as="font" type="font/woff2" crossorigin />`)
  .join('\n')

/* Manrope keeps font-display: swap. With the cache and the preload, a
   returning visitor gets it in the first frame, and on a slow first visit the
   text stays readable in a fallback font. The embedded wordmark font is ready
   without a request, so block only covers its decoding and never shows the
   wordmark in another font. */
export const CSS = `
@font-face {
  font-family: "Manrope"; font-style: normal; font-weight: 200 800;
  font-display: swap;
  src: url("${FONTS.manrope.url}") format("woff2");
}
@font-face {
  font-family: "Qivo Wordmark"; font-style: normal; font-weight: 700;
  font-display: block;
  src: url("${WORDMARK_FONT}") format("woff2");
}

:root {
  color-scheme: light;
  --bg: #f3f8ff;
  --surface-1: #ffffff;
  --surface-2: #e4edff;
  --hover: #e7efff;
  --border: #d6e1f1;
  --border-strong: #bbcce5;
  --text-1: #142444;
  --text-2: #526481;
  --text-3: #526481;
  --accent: #2e54e8;
  --success: #267544;
  --warn: #8c621c;
  --danger: #b23540;
  --sans: "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  /* The header's height, and where content starts below the sticky header. */
  --header-height: 96px;
  --below-header: calc(var(--header-height) + 24px);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 24px; }
body {
  margin: 0; background: var(--bg); color: var(--text-1);
  font-family: var(--sans); font-size: 16px; line-height: 1.62;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.wrap { width: min(1240px, calc(100% - 96px)); margin-inline: auto; }
.wrap .wrap { width: 100%; }

/* Shared navigation and controls. */
.top .wrap { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: var(--header-height); }
.brand { color: var(--text-1); font-family: "Qivo Wordmark", var(--sans); font-size: 32px; font-weight: 700; letter-spacing: -.03em; line-height: 1; }
.brand:hover { text-decoration: none; }
.top nav { display: flex; align-items: center; gap: 32px; font-size: 14px; font-weight: 500; }
.top nav a { color: var(--text-1); }
.top nav a[aria-current] { text-decoration: underline; text-underline-offset: 5px; }
.btn { display: inline-flex; justify-content: center; align-items: center; padding: 11px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; border: 1px solid var(--border); color: var(--text-1); background: var(--surface-1); }
.btn:hover { background: var(--hover); text-decoration: none; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { background: #2446cb; }
.btn.lg { padding: 14px 24px; font-size: 16px; }
/* A disabled button treatment for unavailable marketing actions. */
.btn.disabled { opacity: .45; cursor: not-allowed; pointer-events: none; }
.skip { position: fixed; top: -80px; left: 20px; z-index: 100; background: white; padding: 12px; }
.skip:focus { top: 10px; }
/* The header stays at the top of windows tall enough to spare the room (WCAG
   technique C34). Once the page scrolls, /marketing/nav.js marks it
   data-scrolled and a line appears under it. The z-index keeps positioned
   page content, such as the screenshots, from painting over it and stays
   below the skip link. The scroll padding keeps anchor targets and keyboard
   focus clear of the header. Its own links sit inside that padding, so their
   negative margin stops Chrome from scrolling the page when focus enters it. */
@media (min-height: 480px) {
  html { scroll-padding-top: var(--below-header); }
  .top { position: sticky; top: 0; z-index: 10; background: var(--bg); }
  .top[data-scrolled] { box-shadow: 0 1px 0 var(--border); }
  .top a { scroll-margin-top: calc(-1 * var(--below-header)); }
}
footer.site { border-top: 1px solid var(--border); margin-top: 96px; padding: 32px 0; color: var(--text-2); font-size: 14px; }
footer.site .wrap { display: flex; flex-wrap: wrap; gap: 24px 30px; align-items: center; justify-content: space-between; }
footer.site .brand { font-size: 29px; }
footer.site p { margin: 0; }
.footerlinks { display: flex; flex-wrap: wrap; gap: 20px; }
footer.site a { color: var(--text-1); }

/* prose */
.prose { font-size: 16px; line-height: 1.68; color: var(--text-2); }
.prose h1, .prose h2, .prose h3 { color: var(--text-1); letter-spacing: -.02em; line-height: 1.25; }
.prose h1 { font-size: 33px; margin: 0 0 20px; }
.prose h2 { font-size: 23px; margin: 44px 0 12px; padding-top: 8px; }
.prose h3 { font-size: 18px; margin: 30px 0 8px; }
.prose p { margin: 0 0 16px; }
.prose img { display: block; max-width: 100%; height: auto; }
.prose ul, .prose ol { margin: 0 0 16px; padding-left: 24px; }
.prose li { margin: 0 0 8px; }
.prose li > ul, .prose li > ol { margin: 8px 0 0; }
.prose strong { color: var(--text-1); font-weight: 620; }
.prose code {
  font-family: var(--mono); font-size: 13.5px; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; color: var(--text-1);
}
.prose blockquote {
  margin: 20px 0; padding: 2px 0 2px 18px; border-left: 3px solid var(--accent);
  color: var(--text-2);
}
.prose blockquote p:last-child { margin-bottom: 0; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 36px 0; }
.prose h2 a.anchor, .prose h3 a.anchor { color: var(--text-3); opacity: 0; margin-left: 8px; font-weight: 400; }
.prose h2:hover a.anchor, .prose h3:hover a.anchor { opacity: 1; }

/* docs shell */
.docs { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 56px; padding: 44px 0 0; align-items: start; }
/* The guide's paragraphs are long, and the docs column is wide enough to run
   them past 110 characters — which is where the eye starts losing the line it
   came from. Capped on the measure rather than by narrowing the column, so
   the contents grid underneath it still uses the full width. */
.docs .prose > p, .docs .prose > ul, .docs .prose > ol, .docs .prose > blockquote, .docs .prose > h2, .docs .prose > h3 { max-width: 72ch; }
.docnav { position: sticky; top: 84px; font-size: 14.5px; }
/* Under the sticky header, the sidebar starts below it and scrolls on its own
   when it is taller than the window, with a thin scrollbar where the system
   always shows one. /marketing/nav.js brings the current page's entry into
   view. The padding, offset by the margin, and the scroll padding keep focus
   outlines inside its scroll box. */
@media (min-width: 861px) and (min-height: 480px) {
  .docnav { top: var(--below-header); max-height: calc(100vh - var(--below-header) - 16px); overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; padding: 4px; margin: -4px; scroll-padding-block: 6px; }
}
.docnav .lbl { color: var(--text-3); font-size: 13px; letter-spacing: .07em; font-weight: 600; margin: 0 0 10px; }
.docnav ol { list-style: none; margin: 0; padding: 0; counter-reset: s; }
.docnav li { margin: 0 0 1px; }
.docnav a { display: block; padding: 5px 10px; border-radius: 7px; color: var(--text-2); line-height: 1.4; }
.docnav a:hover { background: var(--hover); color: var(--text-1); text-decoration: none; }
.docnav a[aria-current] { background: var(--surface-2); color: var(--text-1); font-weight: 600; }
.pager { display: flex; gap: 12px; justify-content: space-between; margin: 56px 0 0; border-top: 1px solid var(--border); padding-top: 20px; font-size: 14.5px; }
.pager .nx { margin-left: auto; text-align: right; }
.pager .k { display: block; color: var(--text-3); font-size: 12.5px; }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 18px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 22px 22px 20px; }
.card h3 { margin: 0 0 8px; font-size: 16.5px; color: var(--text-1); letter-spacing: -.01em; line-height: 1.35; }
.card p { margin: 0; color: var(--text-2); font-size: 16px; line-height: 1.6; }
section.band { padding: 72px 0 0; }
section.band > .wrap > h2 { font-size: 30px; letter-spacing: -.025em; margin: 0 0 10px; color: var(--text-1); }
section.band > .wrap > p.lede { font-size: 16.5px; color: var(--text-2); margin: 0 0 30px; max-width: 680px; }

/* pricing */
.plan { background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px; padding: 30px; max-width: 460px; }
.plan .amt { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }
.plan .amt b { font-size: 46px; font-weight: 680; letter-spacing: -.03em; color: var(--text-1); line-height: 1; }
.plan .amt span { color: var(--text-2); font-size: 15.5px; }
.plan ul { list-style: none; margin: 22px 0 26px; padding: 0; font-size: 15px; color: var(--text-2); }
.plan li { padding: 0 0 0 26px; margin: 0 0 10px; position: relative; }
.plan li::before { content: ""; position: absolute; left: 4px; top: .55em; width: 9px; height: 9px; border-radius: 50%; background: var(--success); opacity: .75; }
table.meter { width: 100%; border-collapse: collapse; font-size: 15px; margin: 0 0 8px; }
table.meter th, table.meter td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.meter th { color: var(--text-3); font-weight: 600; font-size: 12.5px; letter-spacing: .05em; }
table.meter td:first-child { color: var(--text-1); }
table.meter td { color: var(--text-2); }
.scroller { overflow-x: auto; }

/* Airspace homepage, adapted from the selected website mockup. */
.airspace { --ink: var(--text-1); --muted: var(--text-2); --line: var(--border); --radius: 14px; }
.airspace h1, .airspace h2, .airspace h3, .airspace p, .airspace figure { margin: 0; }
.airspace h1, .airspace h2 { text-wrap: balance; }
.airspace h1 { font-size: clamp(48px, 6.7vw, 100px); line-height: 1.03; letter-spacing: -.055em; font-weight: 600; }
.airspace h2 { font-size: clamp(34px, 4vw, 58px); line-height: 1.1; letter-spacing: -.04em; font-weight: 500; }
img { display: block; max-width: 100%; }
button { font: inherit; cursor: pointer; }
.actions {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-top: 28px;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 14px 24px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: var(--accent);
  color: var(--onaccent, #fff);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
}
.button:hover {
  filter: brightness(0.94);
}
.textlink {
  font-size: 15px;
  font-weight: 500;
  border-bottom: 1px solid currentColor;
  padding-bottom: 3px;
}
.intro {
  max-width: 510px;
  font-size: 18px;
  line-height: 1.7;
  color: var(--muted);
  margin-top: 24px;
}
.hero-content {
  position: relative;
}
.hero {
  padding-top: 54px;
}
.hero-visual {
  margin-top: 52px;
}
.media {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius, 12px);
  background: var(--media-bg, #10212b);
}
.media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.media-board {
  aspect-ratio: 1.66;
}
.media-board-light {
  aspect-ratio: 1.66;
}
.media-roadmap {
  aspect-ratio: 1.72;
}
.media-roadmap img {
  position: absolute;
  width: 125%;
  max-width: none;
  height: auto;
  top: -3%;
  left: -25%;
}
.media-capacity {
  aspect-ratio: 2.1;
}
.media-capacity img {
  position: absolute;
  width: 128%;
  max-width: none;
  height: auto;
  bottom: -1%;
  left: -28%;
}
.media-task {
  aspect-ratio: 1.52;
}
.media-task img {
  position: absolute;
  width: 142%;
  max-width: none;
  height: auto;
  top: -5.6%;
  left: -21%;
}
.media-plain img {
  object-fit: cover;
}
.media .enlarge {
  position: absolute;
  right: 14px;
  bottom: 14px;
  border: 1px solid #ffffff40;
  background: #12202ddd;
  color: white;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 7px;
}
.media .enlarge:hover {
  background: #1f3651;
}
.feature {
  padding-block: 94px;
}
.feature-copy p {
  font-size: 17px;
  color: var(--muted);
  max-width: 470px;
  margin-top: 12px;
  line-height: 1.75;
}
/* The feature's name is a subtitle under its headline: one step down in
   size, the same ink, no accent colour. */
.feature-copy .feature-label {
  display: block;
  margin-top: 18px;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -.015em;
  line-height: 1.3;
  color: var(--text-1);
}
.feature-grid {
  display: grid;
  grid-template-columns: 0.8fr 1.2fr;
  gap: 70px;
  align-items: center;
}
.feature-grid.reverse {
  grid-template-columns: 1.2fr 0.8fr;
}
.feature-grid.reverse .feature-copy {
  order: 2;
}
.feature-grid.reverse figure {
  order: 1;
}
.feature-top {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 60px;
  margin-bottom: 40px;
}
.feature-top h2 {
  max-width: 600px;
}
.feature-top p {
  max-width: 400px;
  margin-top: 0;
}
.feature-wide .media {
  aspect-ratio: 1.93;
}
.proof-rail {
  display: flex;
  justify-content: center;
  gap: 42px;
  font-size: 14px;
  color: var(--muted);
  padding: 32px 20px;
}
.proof-rail span {
  display: flex;
  align-items: center;
  gap: 9px;
}
.proof-rail svg {
  width: 17px;
  height: 17px;
}
.closing {
  padding: 90px 0;
  text-align: center;
  border-top: 1px solid var(--line);
}
.closing h2 {
  max-width: 720px;
  margin: auto;
}
.closing p {
  margin: 20px auto 25px;
  max-width: 550px;
  font-size: 17px;
  color: var(--muted);
}
.lightbox {
  padding: 0;
  border: 1px solid #6b798b;
  border-radius: 12px;
  background: #101722;
  color: #fff;
  max-width: 96vw;
  max-height: 94vh;
  width: 1400px;
}
.lightbox::backdrop {
  background: #050912d9;
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.lightbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  font-size: 14px;
  gap: 20px;
}
.lightbox-head button {
  background: #273243;
  color: white;
  border: 0;
  border-radius: 5px;
  padding: 7px 12px;
  font-size: 14px;
}
.lightbox img {
  width: 100%;
  height: auto;
  max-height: 82vh;
  object-fit: contain;
}
.lightbox-note {
  padding: 12px 18px;
  font-size: 13px;
  color: #b8c4d3;
}
.airspace .hero {
  text-align: center;
  padding-top: 66px;
}
.airspace h1 {
  max-width: 980px;
  margin: auto;
  font-weight: 600;
}
.airspace .intro {
  margin: 25px auto 0;
  max-width: 550px;
}
.airspace .actions {
  justify-content: center;
}
.airspace .hero-visual {
  margin: 55px auto 0;
  width: 90%;
  padding: 10px;
  background: #fff9;
  border: 1px solid #fff;
  border-radius: 22px;
  box-shadow: 0 28px 90px #385aa62b;
}
.airspace .hero-visual .media {
  aspect-ratio: 1.92;
}
.airspace .proof-rail {
  padding-block: 44px;
}
.airspace .feature:nth-of-type(even) {
  background: white;
}
.airspace .feature .media {
  box-shadow: 0 14px 35px #253a6312;
}
.airspace .closing {
  background: #e7efff;
}
.airspace .site-footer {
  border-top: 0;
}


.airspace .closing h2 { margin-inline: auto; }
.airspace .closing p { margin: 20px auto 25px; }
.airspace + footer.site { margin-top: 0; border-top: 0; }
.media .enlarge { min-height: 44px; text-decoration: none; }
.button:hover, .textlink:hover { text-decoration: none; }
.button:focus-visible, .textlink:focus-visible, .enlarge:focus-visible { outline-offset: 5px; }
.lightbox { overscroll-behavior: contain; }
.lightbox-head button { min-height: 44px; }
.lightbox-note { margin: 0; }
@media (max-width: 1100px) {
  .wrap { width: calc(100% - 64px); }
  .top nav { gap: 23px; }
  .feature-grid, .feature-grid.reverse { gap: 42px; }
  .proof-rail { gap: 24px; }
}
@media (max-width: 860px) {
  .docs { grid-template-columns: 1fr; gap: 0; }
  .docnav { position: static; margin-bottom: 32px; }
}
@media (max-width: 760px) {
  .wrap { width: calc(100% - 40px); }
  :root { --header-height: 82px; }
  .top .wrap { gap: 18px; }
  .top nav { gap: 18px; }
  .top nav .features-link { display: none; }
  .brand { font-size: 29px; }
  .btn { padding: 9px 12px; }
  .airspace .hero { padding-top: 45px; }
  .airspace h1 { font-size: clamp(40px, 9.2vw, 68px); }
  .airspace h2 { font-size: clamp(30px, 7vw, 40px); }
  .feature-copy .feature-label { margin-top: 14px; font-size: 19px; }
  .airspace .intro { max-width: 470px; font-size: 17px; }
  .actions { gap: 22px; flex-wrap: wrap; }
  .button { padding: 14px 19px; }
  .airspace .hero-visual { width: 100%; padding: 6px; border-radius: 15px; margin-top: 40px; }
  .airspace .hero-visual .media { aspect-ratio: 1.55; }
  .airspace .proof-rail { flex-wrap: wrap; gap: 14px 24px; padding: 30px 0; }
  .feature { padding-block: 62px; }
  .feature-grid, .feature-grid.reverse { grid-template-columns: minmax(0, 1fr); gap: 30px; }
  .feature-grid.reverse .feature-copy, .feature-grid.reverse figure { order: initial; }
  .feature-top { display: block; margin-bottom: 30px; }
  .feature-top p { margin-top: 12px; }
  .closing { padding-block: 62px; }
  .plan { padding: 22px; }
  footer.site .wrap { gap: 24px; }
}
@media (max-width: 380px) {
  .wrap { width: calc(100% - 32px); }
  .top .wrap { gap: 12px; }
  .top nav { gap: 12px; }
  .top nav .btn { padding: 9px 10px; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
`.trim()

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* The handwritten homepage repeats this shell so its complete layout remains
   reviewable in index.html. Keep its header and footer in step with these,
   and keep loading /marketing/nav.js there as page() does. */
export function header(current) {
  const at = (href) => (href === current ? ' aria-current="page"' : '')
  return `<header class="top"><div class="wrap">
<a class="brand" href="/" aria-label="Qivo homepage">Qivo</a>
<nav aria-label="Qivo website">
  <a class="features-link" href="/#features">Features</a>
  <a href="/docs/"${at('/docs/')}>Docs</a>
  <a href="/pricing/"${at('/pricing/')}>Pricing</a>
  <a class="btn signin" href="/app">Sign in</a>
</nav>
</div></header>`
}

export function footer() {
  return `<footer class="site"><div class="wrap">
<a class="brand" href="/" aria-label="Qivo homepage">Qivo</a>
<p>Work orchestration for people and AI agents.</p>
<div class="footerlinks">
<a href="/docs/">Documentation</a>
<a href="/pricing/">Pricing</a>
<a href="/skill.md">For agents</a>
<a href="mailto:support@qivo.io">Contact support</a>
<a href="/app">Sign in</a>
</div>
</div></footer>`
}

/** One complete page. `path` is the URL it will be served at, and is what the
    canonical, the OG url and the sitemap are all derived from — passing it
    once is what keeps those three from disagreeing. */
export function page({ path, title, description, body, css = '' }) {
  const url = ORIGIN + path
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${FONT_PRELOADS}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(url)}" />
<link rel="describedby" href="/llms.txt" type="text/plain" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${SITE_NAME}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta name="twitter:card" content="summary" />
<style>${CSS}${css ? `\n${css}` : ''}</style>
<script type="module" src="/marketing/nav.js"></script>
</head>
<body>
${header(path)}
${body}
${footer()}
</body>
</html>
`
}
