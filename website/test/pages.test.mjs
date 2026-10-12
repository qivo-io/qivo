import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadDocs } from '../site/docs.mjs'
import { build } from '../site/pages.mjs'

/* Published documentation URLs and heading anchors that links elsewhere may
   use. Pages and anchors may be added. Page URLs must not be removed or
   renamed. A renamed heading keeps its old anchor through the page's
   `aliases` in docs/guide/pages.json. */
const compatibility = JSON.parse(
  readFileSync(new URL('./fixtures/docs-compatibility.json', import.meta.url), 'utf8'),
)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const suffix = [...randomBytes(4)].map((byte) => String.fromCharCode(97 + (byte % 26))).join('')
const fixtureRoot = join(tmpdir(), `qivo-docs-tests-${suffix}`)
let fixtureCount = 0
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

/** Separate content trees exercise publishing without changing the real guide. */
function fixture() {
  const root = join(fixtureRoot, String(++fixtureCount))
  const contentDir = join(root, 'guide')
  const publicDir = join(root, 'public')
  const metadata = {
    overview: {
      file: 'overview.md',
      title: 'Documentation',
      description: 'Find a guide.',
    },
    pages: [
      {
        file: 'start.md',
        slug: 'getting-started',
        title: 'Getting started',
        order: 10,
        description: 'Create a plan.',
      },
      {
        file: 'planning/schedule.md',
        slug: 'schedule',
        title: 'Schedule',
        order: 20,
        description: 'Plan the week.',
        aliases: { 'weekly-plan': ['old-weekly-plan'] },
      },
    ],
  }
  function write(path, data) {
    const file = join(contentDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  mkdirSync(publicDir, { recursive: true })
  write('overview.md', 'Choose a topic from the navigation.\n')
  write('start.md', '## Create a plan\n\nStart with a project.\n')
  write('planning/schedule.md', '## Weekly plan\n\nReview the schedule.\n')
  const save = () => write('pages.json', `${JSON.stringify(metadata, null, 2)}\n`)
  save()
  return { contentDir, publicDir, metadata, write, save }
}

function navLinks(html) {
  const nav = /<aside class="docnav">([\s\S]*?)<\/aside>/.exec(html)?.[1] || ''
  return [...nav.matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((match) => ({
    path: match[1],
    title: match[2],
  }))
}

describe('public documentation compatibility', () => {
  let files
  let metadata
  beforeAll(() => {
    files = build({
      contentDir: join(repository, 'docs/guide'),
      publicDir: join(repository, 'public'),
    })
    metadata = JSON.parse(readFileSync(join(repository, 'docs/guide/pages.json'), 'utf8'))
  })

  it('keeps every published page URL and anchor', () => {
    for (const previous of compatibility) {
      const html = files.get(`${previous.path.slice(1)}index.html`)
      expect(html, previous.path).toBeDefined()
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
      expect(new Set(ids).size).toBe(ids.length)
      for (const anchor of previous.anchors) expect(ids, previous.path).toContain(anchor)
    }
  })

  it('keeps navigation order, the active page, heading links and sitemap entries', () => {
    const escapeHtml = (text) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const expectedNav = [
      { path: '/docs/', title: 'Overview' },
      ...[...metadata.pages]
        .sort((a, b) => a.order - b.order)
        .map((page) => ({ path: `/docs/${page.slug}/`, title: escapeHtml(page.title) })),
    ]
    for (const { path } of expectedNav) {
      const html = files.get(`${path.slice(1)}index.html`)
      expect(navLinks(html)).toEqual(expectedNav)
      expect(html).toContain(`<a href="${path}" aria-current="page"`)
      const nav = /<aside class="docnav">([\s\S]*?)<\/aside>/.exec(html)[1]
      expect(nav.match(/aria-current="page"/g)).toHaveLength(1)
      const headings = [...html.matchAll(/<h[2-6] id="([^"]+)"/g)].map((match) => match[1])
      for (const id of headings) expect(html).toContain(`class="anchor" href="#${id}"`)
      expect(files.get('sitemap.xml')).toContain(`${path}</loc>`)
    }
  })
})

describe('documentation publishing', () => {
  it('uses explicit slugs and order when titles or headings change', () => {
    const source = fixture()
    source.metadata.pages[0].title = 'A new title'
    source.metadata.pages[0].order = 30
    source.write('start.md', '## A renamed heading\n\nThe same page.\n')
    source.save()
    const files = build(source)
    const html = files.get('docs/getting-started/index.html')
    expect(html).toContain('<h1>A new title</h1>')
    expect(html).toContain('id="a-renamed-heading"')
    expect(files.has('docs/a-new-title/index.html')).toBe(false)
    expect(navLinks(html).map(({ path }) => path)).toEqual([
      '/docs/',
      '/docs/schedule/',
      '/docs/getting-started/',
    ])
    expect(html).toContain('href="/docs/schedule/"><span class="k">Previous</span>')
  })

  it('resolves Markdown, absolute documentation and legacy-fragment links', () => {
    const source = fixture()
    source.write(
      'start.md',
      `## Create a plan

[Schedule](./planning/schedule.md#weekly-plan)
[Old link](./planning/schedule.md#old-weekly-plan)
[With a query](./planning/schedule.md?view=week#weekly-plan)
[Absolute](/docs/schedule/#weekly-plan)
[Canonical](https://qivo.io/docs/schedule/#old-weekly-plan)
[Overview](./overview.md)
[Pricing](/pricing/)
[Application](/app#signup)
[External](https://example.com/docs/unknown/#anything)
`,
    )
    source.write(
      'planning/schedule.md',
      '## Weekly plan\n\n[Start](../start.md#create-a-plan) and [this section](#weekly-plan).\n',
    )
    const files = build(source)
    const start = files.get('docs/getting-started/index.html')
    expect(start).toContain('href="/docs/schedule/#weekly-plan"')
    expect(start).toContain('href="/docs/schedule/#old-weekly-plan"')
    expect(start).toContain('href="/docs/schedule/?view=week#weekly-plan"')
    expect(start).toContain('href="/docs/"')
    expect(start).toContain('href="https://example.com/docs/unknown/#anything"')
    expect(files.get('docs/schedule/index.html')).toContain(
      'href="/docs/getting-started/#create-a-plan"',
    )
  })

  it('emits local image bytes and encoded URLs relative to the page source', () => {
    const source = fixture()
    const image = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="green"/></svg>',
    )
    source.write('planning/images/weekly plan.svg', image)
    source.write(
      'planning/schedule.md',
      '## Weekly plan\n\n![Roadmap showing scheduled tasks](./images/weekly%20plan.svg)\n\n*Tasks scheduled for the coming week.*\n',
    )
    const files = build(source)
    const html = files.get('docs/schedule/index.html')
    const src = /<img\b[^>]*src="([^"]+)"/.exec(html)?.[1]
    expect(src).toBe('/docs/assets/planning/images/weekly%20plan.svg')
    expect(html).toContain('alt="Roadmap showing scheduled tasks"')
    expect(html).toContain('<em>Tasks scheduled for the coming week.</em>')
    expect(files.get(decodeURIComponent(src).slice(1))).toEqual(image)
    expect(files.get('sitemap.xml')).not.toContain('/docs/assets/')
    const docs = loadDocs(source)
    expect(docs.assets.get('docs/assets/planning/images/weekly plan.svg')).toEqual(image)
  })

  it('resolves absolute documentation images and validates links to public files', () => {
    const source = fixture()
    source.write('images/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(source.publicDir, 'reference.md'), '## The reference\n')
    source.write(
      'start.md',
      `![A project diagram](/docs/assets/images/diagram.svg)

![An external diagram](https://example.com/diagram.webp)

[Reference](/reference.md#the-reference)
`,
    )
    const html = build(source).get('docs/getting-started/index.html')
    expect(html).toContain('src="/docs/assets/images/diagram.svg"')
    expect(html).toContain('src="https://example.com/diagram.webp"')
    expect(html).toContain('href="/reference.md#the-reference"')
  })

  it.each([
    ['[Missing page](./missing.md)', /missing\.md/],
    ['[Missing fragment](./planning/schedule.md#missing-anchor)', /missing-anchor/],
    ['[Missing local fragment](#missing-anchor)', /missing-anchor/],
    ['[Malformed local fragment](#bad%C0)', /bad%C0/],
    ['[Missing public page](/docs/missing-page/)', /missing-page/],
    ['[Missing canonical page](https://qivo.io/docs/missing-page/)', /missing-page/],
    [
      '[Missing canonical fragment](https://qivo.io/docs/schedule/#missing-anchor)',
      /missing-anchor/,
    ],
    ['![Missing image](./images/missing.webp)', /images\/missing\.webp/],
    ['![Missing public image](/missing.webp)', /missing\.webp/],
    ['[Missing public file](/reference.md)', /reference\.md/],
  ])('rejects broken internal content with the source and target, %s', (body, target) => {
    const source = fixture()
    source.write('start.md', body)
    expect(() => build(source)).toThrow(/start\.md/)
    expect(() => build(source)).toThrow(target)
  })

  it.each(['slug', 'order'])('rejects duplicate page %s metadata', (field) => {
    const source = fixture()
    source.metadata.pages[1][field] = source.metadata.pages[0][field]
    source.save()
    expect(() => build(source)).toThrow(new RegExp(`duplicate.*${field}|${field}.*duplicate`, 'i'))
  })

  it('rejects a legacy alias whose heading no longer exists', () => {
    const source = fixture()
    source.write('planning/schedule.md', '## A different heading\n')
    expect(() => build(source)).toThrow(/weekly-plan/)
  })

  it('requires alternative text and refuses images outside the content tree', () => {
    const source = fixture()
    source.write('images/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(
      join(source.publicDir, 'private.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    source.write('start.md', '![](./images/diagram.svg)')
    expect(() => build(source)).toThrow(/alternative text/i)
    source.write('start.md', '![A diagram](../public/private.svg)')
    expect(() => build(source)).toThrow(/Missing or invalid local image/)
  })
})
