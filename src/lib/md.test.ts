import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { grouped, TEXT_MAX } from '../../convex/lib/limits'
import { MAX_PARSE, type MdBlock, parseInline, parseMd, Scan, sanitizeHref } from './md'

describe('the parse limit', () => {
  it('equals the server text cap, so every saved text stays editable', () => {
    expect(MAX_PARSE).toBe(TEXT_MAX)
    expect(grouped(TEXT_MAX)).toBe(TEXT_MAX.toLocaleString('en-US'))
  })
})

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

/* The scans ahead the parser made before its tables (convex/lib/md.ts
   Scan), one index at a time, kept as the definition the tables must meet. */
const ESCAPABLE = '\\`*_~+[]()!#>-.@'

function naiveLink(src: string, at: number) {
  let j = at + 1
  let depth = 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n') return null
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) break
    }
    j++
  }
  if (depth !== 0 || src[j + 1] !== '(') return null
  let k = j + 2
  let pdepth = 1
  while (k < src.length) {
    const c = src[k]
    if (c === '\\') {
      k += 2
      continue
    }
    if (c === '\n') return null
    if (c === '(') pdepth++
    else if (c === ')') {
      pdepth--
      if (pdepth === 0) break
    }
    k++
  }
  if (pdepth !== 0) return null
  return { label: src.slice(at + 1, j), dest: src.slice(j + 2, k).trim(), end: k + 1 }
}

function naiveCode(src: string, at: number): [string | null, number] {
  let n = 1
  while (src[at + n] === '`') n++
  let j = at + n
  while (j < src.length) {
    if (src[j] !== '`') {
      j++
      continue
    }
    let m = 1
    while (src[j + m] === '`') m++
    if (m === n) {
      let content = src.slice(at + n, j)
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim())
        content = content.slice(1, -1)
      return [content, j + m]
    }
    j += m
  }
  return [null, 0]
}

function naiveClose(src: string, from: number, marker: string): number {
  let i = from
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      i += 2
      continue
    }
    if (c === '`') {
      const [content, end] = naiveCode(src, i)
      if (content !== null) {
        i = end
        continue
      }
      while (src[i] === '`') i++
      continue
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const m = naiveLink(src, c === '[' ? i : i + 1)
      if (m) {
        i = m.end
        continue
      }
    }
    if (src.startsWith(marker, i)) return i
    i++
  }
  return -1
}

/* Whether the character at `p` follows an odd run of backslashes. */
const escapedAt = (src: string, p: number) => {
  let run = 0
  while (p - run - 1 >= 0 && src[p - run - 1] === '\\') run++
  return run % 2 === 1
}

describe('the parser tables', () => {
  // Brackets, parentheses, backtick runs, marks, escapes and line breaks,
  // including escaped line breaks inside a label and code spans entered
  // mid-run.
  const PIECES = [
    '[',
    ']',
    '(',
    ')',
    '![',
    '@[',
    '`',
    '``',
    '```',
    '\\',
    '\\\n',
    '*',
    '**',
    '***',
    '~~',
    '++',
    ' ',
    '\n',
    'a',
    '](u)',
  ]
  const text = fc.oneof(
    fc.string({ unit: fc.constantFrom(...'[]()!@`*~+\\\n a'), maxLength: 48 }),
    fc.array(fc.constantFrom(...PIECES), { maxLength: 24 }).map((parts) => parts.join('')),
  )

  it('answer as a scan ahead from each index does', () => {
    fc.assert(
      fc.property(text, (src) => {
        const forward = new Scan(src)
        const backward = new Scan(src)
        const indexes = Array.from({ length: src.length + 1 }, (_, i) => i)
        for (const at of indexes) {
          // a parse asks for a link only at an unescaped bracket
          if (src[at] === '[' && !escapedAt(src, at))
            expect(forward.link(at), `link at ${at}`).toEqual(naiveLink(src, at))
          if (src[at] === '`') expect(forward.code(at), `code at ${at}`).toEqual(naiveCode(src, at))
        }
        // a parse asks for a closer just after a mark, never inside a run of
        // backslashes; both orders exercise the memo of passed indexes
        for (const marker of ['***', '**', '~~', '++', '*']) {
          for (const scan of [forward, backward]) {
            const order = scan === forward ? indexes : [...indexes].reverse()
            for (const from of order) {
              if (from > 0 && src[from - 1] === '\\') continue
              expect(scan.close(from, marker), `${marker} from ${from}`).toBe(
                naiveClose(src, from, marker),
              )
            }
          }
        }
      }),
      { numRuns: 3000 },
    )
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
