/* Round-trip contract for the serializer: parseMd(astToMd(ast)) preserves
   ast up to the documented canonicalizations, and astToMd(parseMd(s)) is a
   fixpoint (serializing is idempotent from any input).

   `normalize` below is an INDEPENDENT re-implementation of the canonical
   semantics at character granularity — deliberately a different shape from
   the serializer's atom model, so shared bugs can't hide. The documented
   normalizations it applies:
   - whitespace/hard breaks touching a mark-set boundary lose
     bold/italic/underline/strike (the parser rejects delimiter-hugging
     whitespace); interior whitespace keeps its marks
   - hard breaks inside link labels, headings and list items become spaces;
     blank/whitespace-only paragraph lines don't survive
   - hrefs are trimmed and get spaces/parens percent-encoded; image alts get
     the upload flow's sanitization; \r never survives
   - ordered-list starts clamp to 1..999; heading levels to 1..3
   - inline nesting order and adjacent same-mark runs are canonical (flat
     span semantics), nested links resolve to the innermost */

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { MdBlock, MdInline } from './md'
import { parseMd } from './md'
import { docArb, hostileString, RUNS, UUID } from './md.arb'
import { astToMd } from './mdSerialize'

/* ---- independent normalizer ---------------------------------------------- */

type Entry = {
  c?: string
  code?: boolean
  br?: boolean
  img?: { alt: string; src: string }
  mention?: { id: string; name: string }
  link: string | null
  b: boolean
  i: boolean
  u: boolean
  s: boolean
}

const sanitizeAlt = (alt: string) => alt.replace(/\r/g, '').replace(/[[\]()\n\\]/g, '_')
const encodeDest = (href: string) =>
  href
    .trim()
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '%5C')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')

function normInline(nodes: MdInline[], ctx: 'p' | 'quote' | 'line'): Entry[] {
  const out: Entry[] = []
  const walk = (
    ns: MdInline[],
    link: string | null,
    b: boolean,
    i: boolean,
    u: boolean,
    s: boolean,
  ) => {
    const brEntry = (): Entry =>
      link !== null || ctx === 'line'
        ? { c: ' ', link, b, i, u, s }
        : { br: true, link, b, i, u, s }
    for (const n of ns) {
      if (n.t === 'br') {
        out.push(brEntry())
        continue
      }
      if (n.t === 'text' || n.t === 'code') {
        for (const ch of n.text.replace(/\r/g, '')) {
          if (ch === '\n') out.push(brEntry())
          else out.push({ c: ch, code: n.t === 'code' || undefined, link, b, i, u, s })
        }
        continue
      }
      if (n.t === 'image') {
        out.push({ img: { alt: sanitizeAlt(n.alt), src: encodeDest(n.src) }, link, b, i, u, s })
        continue
      }
      if (n.t === 'mention') {
        // the emitter sanitizes the display name like an image alt; the
        // parser lowercases the uuid
        out.push({
          mention: { id: n.id.toLowerCase(), name: sanitizeAlt(n.name) },
          link,
          b,
          i,
          u,
          s,
        })
        continue
      }
      if (n.t === 'link') {
        walk(n.children, encodeDest(n.href), b, i, u, s)
        continue
      }
      walk(
        n.children,
        link,
        b || n.t === 'bold',
        i || n.t === 'italic',
        u || n.t === 'underline',
        s || n.t === 'strike',
      )
    }
  }
  walk(nodes, null, false, false, false, false)
  // whitespace at a mark-set boundary can't keep bold/italic/underline/strike
  const key = (e: Entry) => JSON.stringify([e.link, e.b, e.i, e.u, e.s])
  const keys = out.map(key)
  const isWs = (e: Entry) => !!e.br || (e.c !== undefined && !e.code && /^\s$/.test(e.c))
  const clear = (e: Entry) => {
    e.b = e.i = e.u = e.s = false
  }
  let st = 0
  for (let idx = 1; idx <= out.length; idx++) {
    if (idx < out.length && keys[idx] === keys[st]) continue
    if (out[st].b || out[st].i || out[st].u || out[st].s) {
      let a = st,
        z = idx - 1
      while (a < idx && isWs(out[a])) clear(out[a++])
      while (z >= a && isWs(out[z])) clear(out[z--])
    }
    st = idx
  }
  return out
}

function splitLines(entries: Entry[]): Entry[][] {
  const lines: Entry[][] = [[]]
  for (const e of entries) {
    if (e.br) lines.push([])
    else lines[lines.length - 1].push(e)
  }
  return lines
}

const wsLine = (l: Entry[]) => l.every((e) => e.c !== undefined && !e.code && /^\s$/.test(e.c))

function stripLeadE(entries: Entry[]): Entry[] {
  const out = [...entries]
  while (
    out.length &&
    out[0].c !== undefined &&
    !out[0].code &&
    out[0].link === null &&
    /^\s$/.test(out[0].c!)
  )
    out.shift()
  return out
}

function normalize(blocks: MdBlock[]): unknown[] {
  const out: unknown[] = []
  for (const bl of blocks) {
    switch (bl.t) {
      case 'p': {
        const lines = splitLines(normInline(bl.children, 'p')).filter((l) => !wsLine(l))
        if (lines.length) out.push({ t: 'p', lines })
        break
      }
      case 'h':
        out.push({
          t: 'h',
          level: Math.min(3, Math.max(1, bl.level | 0)),
          line: stripLeadE(normInline(bl.children, 'line')),
        })
        break
      case 'quote':
        out.push({ t: 'quote', lines: splitLines(normInline(bl.children, 'quote')) })
        break
      case 'ul':
        if (bl.items.length)
          out.push({ t: 'ul', items: bl.items.map((it) => stripLeadE(normInline(it, 'line'))) })
        break
      case 'ol':
        if (bl.items.length)
          out.push({
            t: 'ol',
            start: Math.min(999, Math.max(1, Math.floor(bl.start) || 1)),
            items: bl.items.map((it) => stripLeadE(normInline(it, 'line'))),
          })
        break
      case 'codeblock':
        out.push({ t: 'codeblock', text: bl.text.replace(/\r/g, '') })
        break
    }
  }
  return out
}

/* ---- golden fixtures ------------------------------------------------------ */

const roundTrip = (s: string) => astToMd(parseMd(s))

describe('astToMd goldens', () => {
  it('emits the upload flow tokens byte-identically (store GC matches on them)', () => {
    const att = `![shot](att:${UUID})`
    expect(roundTrip(att)).toBe(att)
    const up = '![Uploading image…](uploading:ab12cd34)'
    expect(roundTrip(up)).toBe(up)
  })

  it('keeps dialect-inert text byte-identical', () => {
    expect(roundTrip('snake_case_name stays')).toBe('snake_case_name stays')
    expect(roundTrip('#### not a heading')).toBe('#### not a heading')
    expect(roundTrip('3. a\n4. b')).toBe('3. a\n4. b')
    expect(roundTrip('- item\n- other')).toBe('- item\n- other')
    expect(roundTrip('# H1\n\n> quoted\n\n`code`')).toBe('# H1\n\n> quoted\n\n`code`')
  })

  it('escapes what would otherwise gain meaning', () => {
    expect(roundTrip('a * b * c')).toBe('a \\* b \\* c')
    expect(parseMd(roundTrip('a * b * c'))).toEqual(parseMd('a * b * c'))
    expect(roundTrip('2 ** 3 equals 8')).toBe('2 \\*\\* 3 equals 8')
    expect(astToMd([{ t: 'p', children: [{ t: 'text', text: '- not a list' }] }])).toBe(
      '\\- not a list',
    )
    expect(astToMd([{ t: 'p', children: [{ t: 'text', text: '> not a quote' }] }])).toBe(
      '\\> not a quote',
    )
    expect(astToMd([{ t: 'p', children: [{ t: 'text', text: '12. not a list' }] }])).toBe(
      '12\\. not a list',
    )
    expect(astToMd([{ t: 'p', children: [{ t: 'text', text: '## not a heading' }] }])).toBe(
      '\\## not a heading',
    )
    // …including on hard-break continuation lines
    expect(
      astToMd([
        { t: 'p', children: [{ t: 'text', text: 'a' }, { t: 'br' }, { t: 'text', text: '- b' }] },
      ]),
    ).toBe('a\n\\- b')
    expect(astToMd([{ t: 'p', children: [{ t: 'text', text: '+++x+++' }] }])).toBe(
      '\\+\\++x\\+\\+\\+',
    )
  })

  it('round-trips escaped delimiters inside marks (escape-aware closer scan)', () => {
    expect(roundTrip('**a\\***')).toBe('**a\\***')
    expect(parseMd('**a\\***')).toEqual([
      { t: 'p', children: [{ t: 'bold', children: [{ t: 'text', text: 'a*' }] }] },
    ])
    expect(roundTrip('**`a**b`**')).toBe('**`a**b`**')
  })

  it('serializes bare autolinks as explicit links', () => {
    expect(roundTrip('see https://a.io/x, ok')).toBe('see [https://a.io/x](https://a.io/x), ok')
  })

  it('keeps a URL-looking label owned by its own link', () => {
    expect(roundTrip('[https://a.io](https://b.io)')).toBe('[https://a.io](https://b.io)')
    const ast: MdBlock[] = [
      {
        t: 'p',
        children: [
          {
            t: 'link',
            href: 'https://b.io',
            children: [{ t: 'text', text: 'see https://a.io now' }],
          },
        ],
      },
    ]
    expect(normalize(parseMd(astToMd(ast)))).toEqual(normalize(ast))
  })

  it('percent-encodes href delimiters instead of escaping them', () => {
    expect(roundTrip('[a](http://x/(y))')).toBe('[a](http://x/%28y%29)')
    expect(
      astToMd([
        {
          t: 'p',
          children: [{ t: 'link', href: 'http://x/a b', children: [{ t: 'text', text: 'a' }] }],
        },
      ]),
    ).toBe('[a](http://x/a%20b)')
  })

  it('picks code delimiters and fences longer than any interior run', () => {
    expect(roundTrip('``a`b``')).toBe('``a`b``')
    expect(astToMd([{ t: 'p', children: [{ t: 'code', text: '`' }] }])).toBe('`` ` ``')
    expect(astToMd([{ t: 'p', children: [{ t: 'code', text: ' x ' }] }])).toBe('`  x  `')
    expect(astToMd([{ t: 'codeblock', text: 'a\n```\nb' }])).toBe('````\na\n```\nb\n````')
    expect(roundTrip('````\na\n```\nb\n````')).toBe('````\na\n```\nb\n````')
  })

  it('closes unterminated fences and collapses extra blank lines', () => {
    expect(roundTrip('```\nabc')).toBe('```\nabc\n```')
    expect(roundTrip('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('lets marks span hard breaks inside a paragraph', () => {
    expect(roundTrip('**a\nb**')).toBe('**a\nb**')
  })

  it('keeps abutting mark boundaries parseable', () => {
    expect(roundTrip('**a***b*')).toBe('**a***b*')
    expect(roundTrip('*a***b**')).toBe('*a***b**')
    expect(roundTrip('***a***')).toBe('***a***')
    // overlapping flat spans (bold over a+b, italic over b+c) close and
    // reopen at each boundary instead of emitting ambiguous delimiter runs
    const spans: MdBlock[] = [
      {
        t: 'p',
        children: [
          {
            t: 'bold',
            children: [
              { t: 'text', text: 'a' },
              { t: 'italic', children: [{ t: 'text', text: 'b' }] },
            ],
          },
          { t: 'italic', children: [{ t: 'text', text: 'c' }] },
        ],
      },
    ]
    const md = astToMd(spans)
    expect(normalize(parseMd(md))).toEqual(normalize(spans))
  })

  it('expels whitespace hugging mark delimiters', () => {
    const ast: MdBlock[] = [
      { t: 'p', children: [{ t: 'bold', children: [{ t: 'text', text: ' a ' }] }] },
    ]
    expect(astToMd(ast)).toBe(' **a** ')
    expect(normalize(parseMd(astToMd(ast)))).toEqual(normalize(ast))
  })

  it('quotes keep interior blank lines; paragraphs cannot', () => {
    expect(roundTrip('> a\n>\n> b')).toBe('> a\n>\n> b')
    const ast: MdBlock[] = [
      {
        t: 'p',
        children: [{ t: 'text', text: 'a' }, { t: 'br' }, { t: 'br' }, { t: 'text', text: 'b' }],
      },
    ]
    expect(astToMd(ast)).toBe('a\nb')
  })

  it('drops what the dialect cannot represent, consistently', () => {
    // hard break in a heading → space; empty paragraph → nothing
    expect(
      astToMd([
        {
          t: 'h',
          level: 2,
          children: [{ t: 'text', text: 'a' }, { t: 'br' }, { t: 'text', text: 'b' }],
        },
      ]),
    ).toBe('## a b')
    expect(
      astToMd([
        { t: 'p', children: [] },
        { t: 'p', children: [{ t: 'text', text: 'x' }] },
      ]),
    ).toBe('x')
  })
})

/* ---- properties ----------------------------------------------------------- */

describe('round-trip properties', () => {
  it('ast → md → ast preserves canonical content', () => {
    fc.assert(
      fc.property(docArb, (blocks) => {
        expect(normalize(parseMd(astToMd(blocks)))).toEqual(normalize(blocks))
      }),
      { numRuns: RUNS },
    )
  })

  it('serializing is idempotent from any string', () => {
    fc.assert(
      fc.property(hostileString, (s) => {
        const s1 = astToMd(parseMd(s))
        expect(astToMd(parseMd(s1))).toBe(s1)
      }),
      { numRuns: RUNS },
    )
  })

  it('canonical form is a fixpoint over generated ASTs too', () => {
    fc.assert(
      fc.property(docArb, (blocks) => {
        const s1 = astToMd(blocks)
        expect(astToMd(parseMd(s1))).toBe(s1)
      }),
      { numRuns: RUNS },
    )
  })
})
