import { describe, expect, it } from 'vitest'
import { type MdBlock, parseInline, parseMd, sanitizeHref } from './md'

describe('parseInline', () => {
  it('leaves plain text alone', () => {
    expect(parseInline('hello world')).toEqual([{ t: 'text', text: 'hello world' }])
  })

  it('parses the paired marks', () => {
    expect(parseInline('**b**')).toEqual([{ t: 'bold', children: [{ t: 'text', text: 'b' }] }])
    expect(parseInline('*i*')).toEqual([{ t: 'italic', children: [{ t: 'text', text: 'i' }] }])
    expect(parseInline('~~s~~')).toEqual([{ t: 'strike', children: [{ t: 'text', text: 's' }] }])
    expect(parseInline('++u++')).toEqual([{ t: 'underline', children: [{ t: 'text', text: 'u' }] }])
  })

  it('nests marks', () => {
    expect(parseInline('**a *b* c**')).toEqual([
      {
        t: 'bold',
        children: [
          { t: 'text', text: 'a ' },
          { t: 'italic', children: [{ t: 'text', text: 'b' }] },
          { t: 'text', text: ' c' },
        ],
      },
    ])
  })

  it('does not treat underscores or spaced asterisks as emphasis', () => {
    expect(parseInline('snake_case_name')).toEqual([{ t: 'text', text: 'snake_case_name' }])
    expect(parseInline('a * b * c')).toEqual([{ t: 'text', text: 'a * b * c' }])
  })

  it('keeps an unclosed marker literal', () => {
    expect(parseInline('2 ** 3 equals 8')).toEqual([{ t: 'text', text: '2 ** 3 equals 8' }])
    expect(parseInline('**dangling')).toEqual([{ t: 'text', text: '**dangling' }])
  })

  it('parses inline code without interpreting its contents', () => {
    expect(parseInline('run `npm *test*` now')).toEqual([
      { t: 'text', text: 'run ' },
      { t: 'code', text: 'npm *test*' },
      { t: 'text', text: ' now' },
    ])
  })

  it('parses links and keeps the href raw for the renderer to sanitize', () => {
    expect(parseInline('[docs](https://x.dev)')).toEqual([
      { t: 'link', href: 'https://x.dev', children: [{ t: 'text', text: 'docs' }] },
    ])
    expect(parseInline('[evil](javascript:alert(1))')[0].t).toBe('link')
  })

  it('parses images, including att: sources', () => {
    expect(parseInline('![shot](att:0f4b)')).toEqual([{ t: 'image', alt: 'shot', src: 'att:0f4b' }])
  })

  it('autolinks bare URLs and trims trailing punctuation', () => {
    expect(parseInline('see https://a.io/x, ok')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'link', href: 'https://a.io/x', children: [{ t: 'text', text: 'https://a.io/x' }] },
      { t: 'text', text: ', ok' },
    ])
  })

  it('never autolinks inside a link label (links cannot nest)', () => {
    expect(parseInline('[https://a.io](https://b.io)')).toEqual([
      { t: 'link', href: 'https://b.io', children: [{ t: 'text', text: 'https://a.io' }] },
    ])
    expect(parseInline('[**see https://a.io**](https://b.io)')).toEqual([
      {
        t: 'link',
        href: 'https://b.io',
        children: [{ t: 'bold', children: [{ t: 'text', text: 'see https://a.io' }] }],
      },
    ])
  })

  it('honors backslash escapes', () => {
    expect(parseInline('\\*not italic\\*')).toEqual([{ t: 'text', text: '*not italic*' }])
  })

  it('turns single newlines into breaks', () => {
    expect(parseInline('a\nb')).toEqual([
      { t: 'text', text: 'a' },
      { t: 'br' },
      { t: 'text', text: 'b' },
    ])
  })

  it('parses ***both*** as bold containing italic (the toolbar emits this)', () => {
    expect(parseInline('***both***')).toEqual([
      {
        t: 'bold',
        children: [{ t: 'italic', children: [{ t: 'text', text: 'both' }] }],
      },
    ])
  })

  it('skips escaped delimiters when looking for a closer', () => {
    expect(parseInline('**a\\***')).toEqual([{ t: 'bold', children: [{ t: 'text', text: 'a*' }] }])
    expect(parseInline('~~a\\~~~')).toEqual([
      { t: 'strike', children: [{ t: 'text', text: 'a~' }] },
    ])
  })

  it('skips code spans and links when looking for a closer', () => {
    expect(parseInline('**`a**b`**')).toEqual([
      { t: 'bold', children: [{ t: 'code', text: 'a**b' }] },
    ])
    expect(parseInline('**[x**](u)**')).toEqual([
      { t: 'bold', children: [{ t: 'link', href: 'u', children: [{ t: 'text', text: 'x**' }] }] },
    ])
  })

  it('parses double-backtick code spans holding backticks', () => {
    expect(parseInline('``a`b``')).toEqual([{ t: 'code', text: 'a`b' }])
    // one space each side is padding when the content edge collides
    expect(parseInline('`` ` ``')).toEqual([{ t: 'code', text: '`' }])
    expect(parseInline('`a\\`')).toEqual([{ t: 'code', text: 'a\\' }])
  })

  it('caps link-label recursion instead of blowing the stack', () => {
    const n = 2000
    const evil = `${'['.repeat(n)}x${'](u)'.repeat(n)}`
    expect(() => parseInline(evil)).not.toThrow()
  })
})

describe('parseMd', () => {
  it('splits paragraphs on blank lines', () => {
    const b = parseMd('one\n\ntwo')
    expect(b.map((x) => x.t)).toEqual(['p', 'p'])
  })

  it('parses headings up to level 3 only', () => {
    expect(parseMd('# a')[0]).toMatchObject({ t: 'h', level: 1 })
    expect(parseMd('### a')[0]).toMatchObject({ t: 'h', level: 3 })
    expect(parseMd('#### a')[0].t).toBe('p')
  })

  it('merges consecutive quote lines into one block', () => {
    const b = parseMd('> a\n> b')
    expect(b).toHaveLength(1)
    expect(b[0].t).toBe('quote')
  })

  it('collects list items; ordered lists keep their start number', () => {
    const ul = parseMd('- a\n- b')
    expect(ul[0]).toMatchObject({ t: 'ul' })
    expect((ul[0] as Extract<MdBlock, { t: 'ul' }>).items).toHaveLength(2)
    const ol = parseMd('3. a\n4. b')
    expect(ol[0]).toMatchObject({ t: 'ol', start: 3 })
  })

  it('keeps a bullet a bullet but a lone *italic* line a paragraph', () => {
    expect(parseMd('* item')[0].t).toBe('ul')
    expect(parseMd('*item*')[0].t).toBe('p')
  })

  it('parses code fences verbatim, and survives an unterminated fence', () => {
    const b = parseMd('```\n**raw**\n```')
    expect(b).toEqual([{ t: 'codeblock', text: '**raw**' }])
    expect(parseMd('```\nabc')).toEqual([{ t: 'codeblock', text: 'abc' }])
  })

  it('longer fences can hold shorter fence lines', () => {
    expect(parseMd('````\na\n```\nb\n````')).toEqual([{ t: 'codeblock', text: 'a\n```\nb' }])
  })

  it('falls back to plain paragraphs for pathologically long input', () => {
    const start = Date.now()
    const blocks = parseMd('*'.repeat(100_000))
    expect(Date.now() - start).toBeLessThan(500)
    expect(blocks).toEqual([{ t: 'p', children: [{ t: 'text', text: '*'.repeat(100_000) }] }])
  })
})

describe('sanitizeHref', () => {
  it('allows http(s) and mailto only', () => {
    expect(sanitizeHref('https://a.io')).toBe('https://a.io')
    expect(sanitizeHref('http://a.io')).toBe('http://a.io')
    expect(sanitizeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(sanitizeHref('javascript:alert(1)')).toBeNull()
    expect(sanitizeHref('data:text/html,x')).toBeNull()
    expect(sanitizeHref('/relative')).toBeNull()
  })
})

/* The toggleWrap/toggleLinePrefix/setHeading/toggleCodeBlock/insertLink
   suites left with the textarea editor's text transforms. */
