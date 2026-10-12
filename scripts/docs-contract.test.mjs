import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDocs } from './docs-contract.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('public documentation contract', () => {
  let copy
  afterEach(() => {
    if (copy) rmSync(copy, { recursive: true, force: true })
    copy = undefined
  })

  /** A copy of the real guide and agent guides, changed by one edit per case. */
  function fixture(edit) {
    copy = mkdtempSync(join(tmpdir(), 'qivo-docs-contract-'))
    cpSync(join(root, 'docs/guide'), join(copy, 'docs/guide'), { recursive: true })
    cpSync(join(root, 'public'), join(copy, 'public'), { recursive: true })
    const manifestFile = join(copy, 'docs/guide/pages.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const page = (file) => join(copy, 'docs/guide', file)
    edit({ manifest, page, copy })
    writeFileSync(manifestFile, JSON.stringify(manifest))
    return checkDocs(copy)
  }

  it('accepts the published guide, relative images, aliases and every path the site serves', () => {
    expect(checkDocs(root)).toEqual([])
    expect(
      fixture(({ manifest, page }) => {
        const first = manifest.pages[0]
        writeFileSync(page('picture.png'), 'not decoded')
        appendFileSync(
          page(first.file),
          `\n## Renamed\n\n![Board](./picture.png) [Back](./overview.md) [Old](#old-name)
[Same page](?view=week#renamed) [Pricing](/pricing) [Board](/docs/the-board) [Features](/#features)
[Cards](https://www.qivo.io/docs/the-board/#cards)\n`,
        )
        first.aliases = { renamed: ['old-name'] }
      }),
    ).toEqual([])
  })

  it('reports every problem at once', () => {
    const errors = fixture(({ manifest, page }) => {
      manifest.pages[1].slug = 'Not A Slug'
      writeFileSync(page('orphan.md'), 'Text\n')
      writeFileSync(page('overview.md'), '[x](./missing.md) ![](./images/missing.png)\n')
    })
    expect(errors).toEqual(
      expect.arrayContaining([
        'pages.json page 2: invalid slug "Not A Slug"',
        'orphan.md: not listed in pages.json',
        'overview.md: Broken internal page link "./missing.md"',
        'overview.md: Image needs descriptive alternative text "./images/missing.png"',
        expect.stringContaining('overview.md: Missing or invalid local image'),
      ]),
    )
  })

  it('reports an invalid alias and still checks the rest of the page', () => {
    const errors = fixture(({ manifest, page }) => {
      const first = manifest.pages[0]
      appendFileSync(page(first.file), '\n## Renamed\n\n[x](./missing.md)\n')
      appendFileSync(page('overview.md'), `\n[Renamed](./${first.file}#renamed)\n`)
      first.aliases = { renamed: ['Old Name'] }
    })
    expect(errors).toEqual([
      expect.stringContaining('Invalid or duplicate heading alias "Old Name"'),
      expect.stringContaining('Broken internal page link "./missing.md"'),
    ])
  })

  it.each([
    [
      'an unsafe page file',
      'invalid file name',
      ({ manifest }) => (manifest.pages[0].file = '../README.md'),
    ],
    [
      'a nested page file',
      'invalid file name',
      ({ manifest }) => (manifest.pages[0].file = 'nested/page.md'),
    ],
    ['an invalid slug', 'invalid slug', ({ manifest }) => (manifest.pages[0].slug = 'Not A Slug')],
    [
      'a duplicate order',
      'duplicate order',
      ({ manifest }) => (manifest.pages[1].order = manifest.pages[0].order),
    ],
    ['an unlisted page', 'not listed', ({ page }) => writeFileSync(page('orphan.md'), 'Text\n')],
    [
      'a top-level heading',
      'page title',
      ({ page, manifest }) => writeFileSync(page(manifest.pages[0].file), '# Title\n'),
    ],
    [
      'a broken page link',
      'Broken internal page link',
      ({ page }) => writeFileSync(page('overview.md'), '[x](./missing.md)\n'),
    ],
    [
      'a relative link that is not a Markdown page',
      'Relative links must name a Markdown page',
      ({ page }) => appendFileSync(page('the-board.md'), '\n[Roadmap](../the-roadmap/)\n'),
    ],
    [
      'a broken page anchor',
      'Broken internal anchor',
      ({ page }) => writeFileSync(page('overview.md'), '[x](./the-board.md#no-such-heading)\n'),
    ],
    [
      'a malformed anchor',
      'Invalid internal anchor encoding',
      ({ page }) => writeFileSync(page('overview.md'), '[x](#bad%C0)\n'),
    ],
    [
      'an unknown docs URL',
      'Broken internal link "https://qivo.io/docs/no-such-page/"',
      ({ page }) => writeFileSync(page('overview.md'), '[x](https://qivo.io/docs/no-such-page/)\n'),
    ],
    [
      'an unknown docs URL on www.qivo.io',
      'Broken internal link',
      ({ page }) =>
        writeFileSync(page('overview.md'), '[x](https://www.qivo.io/docs/no-such-page/)\n'),
    ],
    [
      'an unknown site path',
      'Broken internal link "/no-such-page"',
      ({ page }) => writeFileSync(page('overview.md'), '[x](/no-such-page)\n'),
    ],
    [
      'a missing homepage section',
      'Broken internal anchor "/#no-such-section"',
      ({ page }) => writeFileSync(page('overview.md'), '[x](/#no-such-section)\n'),
    ],
    [
      'a missing image',
      'Missing or invalid local image',
      ({ page }) => writeFileSync(page('overview.md'), '![Board](./images/missing.png)\n'),
    ],
    [
      'an image path that is not written plainly',
      'Use a plain path',
      ({ page }) => {
        writeFileSync(page('picture.png'), 'not decoded')
        writeFileSync(page('overview.md'), '![Board](./images/../picture.png)\n')
      },
    ],
    [
      'a root image path',
      'Image must be a relative path',
      ({ page }) => {
        writeFileSync(page('picture.png'), 'not decoded')
        writeFileSync(page('overview.md'), '![Board](/docs/assets/picture.png)\n')
      },
    ],
    [
      'an image on another site',
      'Image must be a relative path',
      ({ page }) => writeFileSync(page('overview.md'), '![Board](https://example.com/board.png)\n'),
    ],
    [
      'an image outside the guide',
      'Missing or invalid local image',
      ({ page }) => writeFileSync(page('overview.md'), '![Readme](../../public/favicon.svg)\n'),
    ],
    [
      'an encoded absolute image path',
      'Missing or invalid local image',
      ({ page, copy }) => {
        const outside = join(copy, 'outside.png')
        writeFileSync(outside, 'synthetic image outside the guide')
        writeFileSync(page('overview.md'), `![Outside](${encodeURIComponent(outside)})\n`)
      },
    ],
    [
      'a dangling alias',
      'does not exist',
      ({ manifest }) => (manifest.pages[0].aliases = { 'no-such-heading': ['old'] }),
    ],
    [
      'a stale agent-guide docs link',
      'public/skill.md: Broken internal link',
      ({ copy }) =>
        writeFileSync(join(copy, 'public/skill.md'), 'See https://qivo.io/docs/removed-page/.\n'),
    ],
  ])('rejects %s', (_name, message, edit) => {
    expect(fixture(edit).join('\n')).toContain(message)
  })
})
