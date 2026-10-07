/* Adapter contract: a doc built from an AST reads back as the same canonical
   markdown (astToMd is the equality), and astToDoc output is always shaped
   like what the editor schema accepts — setContent must never have to
   repair it. */

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { MdBlock } from '../lib/md'
import { parseMd } from '../lib/md'
import { docArb, RUNS, UUID } from '../lib/md.arb'
import { astToMd } from '../lib/mdSerialize'
import type { PMNode } from './descDoc'
import { astToDoc, docToAst } from './descDoc'

describe('astToDoc / docToAst round-trip', () => {
  it('doc → ast reads back the same canonical markdown', () => {
    fc.assert(
      fc.property(docArb, (blocks) => {
        expect(astToMd(docToAst(astToDoc(blocks)))).toBe(astToMd(blocks))
      }),
      { numRuns: RUNS },
    )
  })

  it('round-trips stored text through the editor path byte-identically', () => {
    const cases = [
      `![shot](att:${UUID})`,
      '![Uploading image…](uploading:ab12cd34)',
      '# H1\n\ntext with **bold** and `code`\n\n> quote\n> line\n\n- a\n- b\n\n3. x\n4. y\n\n```\nfence\n```',
      'a \\* b\nbreak **spanning\nbold**',
      '[label **bold**](https://a.io/x) and [https://a.io](https://a.io)',
    ]
    for (const s of cases) {
      const canonical = astToMd(parseMd(s))
      expect(astToMd(docToAst(astToDoc(parseMd(canonical))))).toBe(canonical)
    }
  })
})

describe('doc shape', () => {
  const walk = (n: PMNode, fn: (n: PMNode) => void) => {
    fn(n)
    for (const c of n.content || []) walk(c, fn)
  }

  it('always emits schema-valid structure', () => {
    fc.assert(
      fc.property(docArb, (blocks) => {
        const doc = astToDoc(blocks)
        expect(doc.type).toBe('doc')
        expect(doc.content!.length).toBeGreaterThan(0)
        walk(doc, (n) => {
          if (n.type === 'text') expect(n.text).not.toBe('')
          if (n.marks) {
            const types = n.marks.map((m) => m.type)
            expect(new Set(types).size).toBe(types.length) // no duplicate marks
          }
          if (n.type === 'listItem') {
            expect(n.content!.length).toBe(1)
            expect(n.content![0].type).toBe('paragraph')
          }
          if (n.type === 'blockquote') {
            expect(n.content!.every((c) => c.type === 'paragraph')).toBe(true)
          }
          if (n.type === 'heading') {
            expect([1, 2, 3]).toContain(n.attrs!.level)
          }
          if (n.type === 'codeBlock') {
            for (const c of n.content || []) expect(c.type).toBe('text')
          }
        })
      }),
      { numRuns: RUNS },
    )
  })
})

describe('docToAst degradations', () => {
  it('clamps out-of-dialect heading levels and drops unknown nodes', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'h' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      ],
    }
    expect(docToAst(doc)).toEqual([
      { t: 'h', level: 3, children: [{ t: 'text', text: 'h' }] },
      { t: 'p', children: [{ t: 'text', text: 'x' }] },
    ])
  })

  it('flattens forbidden multi-block list items and quotes onto breaks', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
              ],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'q1' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'q2' }] },
          ],
        },
      ],
    }
    // list item: breaks degrade to spaces in astToMd's line context;
    // blockquote: the paragraph gap becomes a blank quote line
    expect(astToMd(docToAst(doc))).toBe('- a b\n\n> q1\n>\n> q2')
  })

  it('reads flat editor marks into canonical nesting', () => {
    const doc: PMNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'b', marks: [{ type: 'italic' }, { type: 'bold' }] },
            { type: 'text', text: 'c', marks: [{ type: 'code' }, { type: 'bold' }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'd', marks: [{ type: 'link', attrs: { href: 'https://a.io' } }] },
            { type: 'image', attrs: { src: `att:${UUID}`, alt: 'shot' } },
          ],
        },
      ],
    }
    // canonical form closes and reopens delimiters at every mark-set change
    expect(astToMd(docToAst(doc))).toBe(
      `**a*****b*****\`c\`**\n[d](https://a.io)![shot](att:${UUID})`,
    )
    // …and those bytes read back as the same flat spans
    expect(astToMd(parseMd(astToMd(docToAst(doc))))).toBe(astToMd(docToAst(doc)))
  })
})

describe('editor-load guard', () => {
  it('empty and whitespace descriptions load as one empty paragraph', () => {
    expect(astToDoc(parseMd(''))).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(astToMd(docToAst(astToDoc(parseMd(''))))).toBe('')
  })
})

// keep MdBlock imported for casts in future fixtures without lint noise
const _t: MdBlock | null = null
void _t
