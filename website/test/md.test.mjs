import { describe, expect, it, vi } from 'vitest'
import { render, slugify } from '../site/md.mjs'

describe('documentation Markdown', () => {
  it('renders standard Markdown, including nested blocks, tables and fenced code', () => {
    const html = render(`A **strong *nested* phrase**, a [link](https://example.com) and \`<code>\`.

> A quotation.
>
> - First item
> - Second item

1. Open the project.
2. Read the plan.

| Task | Status |
| --- | --- |
| Schedule | Ready |

\`\`\`js
const value = '<script>'
\`\`\`
`)
    expect(html).toContain('<strong>strong <em>nested</em> phrase</strong>')
    expect(html).toContain('<code>&lt;code&gt;</code>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Task</th>')
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes raw HTML and retains markdown-it unsafe-link protections', () => {
    const html = render(`<script>alert('raw HTML')</script>

An <img src=x onerror=alert(1)> and <date> stay text.

[unsafe](javascript:alert%281%29)
[obfuscated](jav&#x61;script:alert%281%29)
[unsafe data](data:text/html;base64,PHNjcmlwdD4=)
![unsafe image](javascript:alert%281%29)
[safe](https://example.com/guide)
`)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;date&gt;')
    expect(html).not.toMatch(/<(?:script|img)\b/)
    expect(html).not.toMatch(/(?:href|src)="(?:javascript:|data:text\/html)/)
    expect(html).toContain('href="https://example.com/guide"')
  })

  it('renders standard images with accessible alternative text and resolved paths', () => {
    const resolveLink = vi.fn(() => '/docs/schedule/#weekly-plan')
    const resolveImage = vi.fn(() => '/docs/assets/images/roadmap%20view.webp')
    const html = render(
      '[The schedule](./schedule.md#weekly-plan)\n\n![Roadmap showing **scheduled** tasks](./images/roadmap.webp "September plan")',
      { resolveLink, resolveImage },
    )
    expect(resolveLink).toHaveBeenCalledWith('./schedule.md#weekly-plan')
    expect(resolveImage).toHaveBeenCalledWith(
      './images/roadmap.webp',
      'Roadmap showing **scheduled** tasks',
    )
    expect(html).toContain('href="/docs/schedule/#weekly-plan"')
    expect(html).toContain('src="/docs/assets/images/roadmap%20view.webp"')
    expect(html).toContain('alt="Roadmap showing scheduled tasks"')
    expect(html).toContain('title="September plan"')
  })

  it('keeps heading slugs, explicit legacy aliases and links through h6', () => {
    const headings = []
    const html = render(
      '## Archiving\n\n### Weeks that match *your* calendar\n\n#### Details\n\n##### More details\n\n###### Last detail',
      {
        aliases: { archiving: ['archiving-done-work-leaves-the-room-on-its-own'], details: [] },
        onHeading: (heading) => headings.push(heading),
      },
    )
    expect(headings.map(({ id }) => id)).toEqual([
      'archiving',
      'weeks-that-match-your-calendar',
      'details',
      'more-details',
      'last-detail',
    ])
    expect(html).toContain('id="archiving-done-work-leaves-the-room-on-its-own"')
    for (const { level, id } of headings) {
      expect(html).toContain(`<h${level} id="${id}">`)
      expect(html).toContain(`class="anchor" href="#${id}"`)
    }
    expect(slugify('Undo this Roadmap visit’s changes')).toBe('undo-this-roadmap-visits-changes')
    expect(slugify('a'.repeat(70))).toHaveLength(60)
  })

  it('makes repeated heading anchors unique', () => {
    const headings = []
    const html = render('## Details\n\n### Details\n\n## Details\n\n## Constructor', {
      onHeading: (heading) => headings.push(heading),
    })
    expect(headings).toHaveLength(4)
    expect(new Set(headings.map(({ id }) => id)).size).toBe(4)
    expect(headings[0].id).toBe('details')
    expect(headings[3].id).toBe('constructor')
    for (const { id } of headings) expect(html).toContain(`href="#${id}"`)
  })
})
