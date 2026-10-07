import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDocs } from './docs-contract.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('public documentation contract', () => {
  let copy
  afterEach(() => rmSync(copy, { recursive: true, force: true }))

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

  it('accepts the published guide, relative images and aliases', () => {
    expect(checkDocs(root)).toEqual([])
    expect(
      fixture(({ manifest, page }) => {
        const first = manifest.pages[0]
        writeFileSync(page('picture.png'), 'not decoded')
        appendFileSync(
          page(first.file),
          `\n## Renamed\n\n![Board](./picture.png) [Back](./overview.md) [Old](#old-name)\n`,
        )
        first.aliases = { renamed: ['old-name'] }
      }),
    ).toEqual([])
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
      'broken page link',
      ({ page }) => writeFileSync(page('overview.md'), '[x](./missing.md)\n'),
    ],
    [
      'a broken page anchor',
      'broken anchor',
      ({ page }) => writeFileSync(page('overview.md'), '[x](./the-board.md#no-such-heading)\n'),
    ],
    [
      'an unknown docs URL',
      'unknown documentation page',
      ({ page }) => writeFileSync(page('overview.md'), '[x](https://qivo.io/docs/no-such-page/)\n'),
    ],
    [
      'a missing image',
      'invalid image',
      ({ page }) => writeFileSync(page('overview.md'), '![Board](./images/missing.png)\n'),
    ],
    [
      'an image outside the guide',
      'invalid image',
      ({ page }) => writeFileSync(page('overview.md'), '![Readme](../../public/favicon.svg)\n'),
    ],
    [
      'an encoded absolute image path',
      'invalid image',
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
      'public/skill.md: unknown documentation page',
      ({ copy }) =>
        writeFileSync(join(copy, 'public/skill.md'), 'See https://qivo.io/docs/removed-page/.\n'),
    ],
  ])('rejects %s', (_name, message, edit) => {
    expect(fixture(edit).join('\n')).toContain(message)
  })
})
