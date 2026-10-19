/* Publish the guide's Markdown pages through the existing website templates.
   Titles, URLs, navigation order and descriptions come from explicit metadata. */
import { loadDocs } from './docs.mjs'
import { ORIGIN, page, SITE_NAME } from './theme.mjs'

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function docNav(all, currentPath) {
  const items = all
    .map(
      (s) =>
        `<li><a href="${s.path}"${s.path === currentPath ? ' aria-current="page"' : ''}>${esc(
          s.title,
        )}</a></li>`,
    )
    .join('\n')
  return `<aside class="docnav">
<p class="lbl">Documentation</p>
<ol>
<li><a href="/docs/"${currentPath === '/docs/' ? ' aria-current="page"' : ''}>Overview</a></li>
${items}
</ol>
</aside>`
}

function pager(all, i) {
  const prev = i > 0 ? all[i - 1] : null
  const next = i < all.length - 1 ? all[i + 1] : null
  if (!prev && !next) return ''
  return `<nav class="pager">
${prev ? `<a href="${prev.path}"><span class="k">Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
${next ? `<a class="nx" href="${next.path}"><span class="k">Next</span>${esc(next.title)}</a>` : ''}
</nav>`
}

/* ------------------------------------------------------------------ docs */

function docsPages({ overview, pages: all }) {
  const pages = all.map((s, i) => ({
    path: s.path,
    title: `${s.title} | ${SITE_NAME} docs`,
    description: s.description,
    body: `<div class="wrap"><div class="docs">
${docNav(all, s.path)}
<article class="prose">
<h1>${esc(s.title)}</h1>
${s.html}
${pager(all, i)}
</article>
</div></div>`,
  }))

  const cards = all
    .map(
      (s) =>
        `<div class="card"><h3><a href="${s.path}">${esc(s.title)}</a></h3><p>${esc(
          s.description,
        )}</p></div>`,
    )
    .join('\n')

  pages.unshift({
    path: overview.path,
    title: `${overview.title} | ${SITE_NAME}`,
    description: overview.description,
    body: `<div class="wrap"><div class="docs">
${docNav(all, overview.path)}
<article class="prose">
<h1>${esc(overview.title)}</h1>
${overview.html}
<div class="grid" style="margin-top:28px">${cards}</div>
</article>
</div></div>`,
  })
  return pages
}

/* --------------------------------------------------------------- pricing */

/* The decided prices, written out by hand. The reasoning behind them lives in
   a private pricing plan, so changing the price is meant to be a deliberate
   edit in both places. */
function pricingPage() {
  const body = `<div class="wrap">
<section class="band" style="padding-top:56px">
<div class="wrap" style="padding:0;max-width:none">
<h2 style="font-size:38px">One price, per person.</h2>
<p class="lede">Each active user costs the same, whether they are a person
or an AI agent. A guest with an active membership in their own Qivo
organization adds no user charge to yours.</p>

<div class="plan">
  <p class="amt"><b>$1</b><span>per user, per month</span></p>
  <p style="margin:0;color:var(--text-3);font-size:14.5px">Billed on the number of
  active users at monthly renewal, including pending invitations. Minimum
  5 users, so $5 a month before applicable taxes.</p>
  <ul>
    <li>Unlimited projects, sub-projects and tasks</li>
    <li>Every feature, with no higher tier</li>
    <li>AI agents are users, priced the same and no differently</li>
    <li>REST API and MCP server included</li>
    <li>1&nbsp;GB of attachments per user (pooled)</li>
    <li>25,000 API calls per user a month (pooled)</li>
  </ul>
  <a class="btn primary lg" href="/app#signup">Create an account</a>
</div>
</div>
</section>

<section class="band">
<div class="wrap" style="padding:0;max-width:none">
<h2>If you go past what is included</h2>
<p class="lede">Two meters, both charged by the started unit so a line item is
never a fraction of something. <strong>Both allowances are pooled</strong>.</p>
<div class="scroller"><table class="meter">
<thead><tr><th>Meter</th><th>Included</th><th>After that</th></tr></thead>
<tbody>
<tr><td>Attachment storage</td><td>5&nbsp;GB, or 1&nbsp;GB × users if larger, pooled organization-wide</td><td>$1 per extra started GB</td></tr>
<tr><td>API and MCP calls</td><td>25,000 × users, pooled organization-wide</td><td>$1 per extra started 25,000</td></tr>
</tbody>
</table></div>
<p style="color:var(--text-3);font-size:14.5px;max-width:680px">Pooled means
the allowance belongs to the organization, not to each person. One busy agent
should not produce a call charge while four users sit idle, and one large
attachment should not produce a storage charge while the rest of the
organization stores nothing.</p>
<p style="color:var(--text-3);font-size:14.5px;max-width:680px">API calls accumulate
over your billing period. Storage is sampled at the start of the period;
extra usage charges are added to the invoice at the end of the period. Your Billing
page shows the recorded charges and usage by account or project.</p>
</div>
</section>

<section class="band">
<div class="wrap" style="padding:0;max-width:none">
<h2>Questions people actually ask</h2>
<div class="grid">
<div class="card"><h3>What counts as a user?</h3><p>Active people, viewers and AI
agents count as soon as an admin adds them, including invitations that have
not been accepted. Inactive users do not count. Add or deactivate users as
needed: the next renewal uses the current count, without prorated charges
or credits during the month.</p></div>
<div class="card"><h3>What about guests?</h3><p>If the guest you invite has
an active membership in their own Qivo organization,
you pay no extra user charge. That is the usual case for a
client or a contractor who uses Qivo themselves. Otherwise, they count as a
user on your bill while active in your organization.</p></div>
<div class="card"><h3>And if two companies invite the same person?</h3><p>If
that person has no active membership in an organization of their own, each
company counts them while they are active there. We could
split it, but that would mean two unrelated companies knowing about each
other, and at $1 the complexity costs more than the case is worth.</p></div>
<div class="card"><h3>Do agents cost extra?</h3><p>No. An agent is a user and
costs the same $1. An assistant driving Qivo through <em>your own</em> access
token is you, not a second worker, and costs nothing.</p></div>
<div class="card"><h3>Why a five-user minimum?</h3><p>It is where the product
covers its own infrastructure. It also means the price does not have to climb
later to make small organizations viable.</p></div>
<div class="card"><h3>Can I try it first?</h3><p><a href="https://demo.qivo.io">Open
the demo</a> to explore a populated private workspace before creating your own
organization. No account or card is needed for the demo.</p></div>
</div>
</div>
</section>
</div>`

  return {
    path: '/pricing/',
    title: `Pricing | ${SITE_NAME}`,
    description:
      '$1 per user per month, five-user minimum. AI agents cost the same as people, a guest with their own organization costs you nothing, and every feature is in the one plan.',
    body,
  }
}

/* --------------------------------------------------------------- sitemap */

function sitemap(paths) {
  const urls = paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

/** Every generated file, keyed by the path it is served at. `index.html` is
    NOT here: the landing page is a real file in the repo, so its copy can be
    reviewed in a diff like any other change, and scripts/build.mjs only
    injects this module's stylesheet into it. */
export function build(options) {
  const guide = loadDocs(options)
  const pages = [...docsPages(guide), pricingPage()]
  const files = new Map(guide.assets)
  for (const p of pages) {
    files.set(`${p.path.replace(/^\/|\/$/g, '')}/index.html`, page(p))
  }
  // "/" is the landing page, which scripts/build.mjs writes; the sitemap lists it
  files.set('sitemap.xml', sitemap(['/', ...pages.map((p) => p.path)]))
  return files
}
