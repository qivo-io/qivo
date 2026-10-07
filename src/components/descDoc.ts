/* =========================================================================
   Mechanical adapters between lib/md's AST and TipTap/ProseMirror JSON for
   the description editor. Load: parseMd(text) → astToDoc → editor. Commit:
   editor.getJSON() → docToAst → astToMd → updateIssue.

   These are pure JSON transforms with no engine imports, so the round-trip
   contract (docToAst(astToDoc(ast)) ≅ ast under astToMd) is unit-testable
   without a DOM. The editor schema (descEditor) constrains documents to
   exactly what the dialect can hold: headings 1–3, single-paragraph list
   items, one-paragraph blockquotes (hard breaks instead of nested blocks),
   inline images, no horizontal rule / tables / language fences. Anything
   outside that (from a hostile or future doc) degrades here the same way
   astToMd degrades it, never by throwing.

   ProseMirror stores marks flat on each text leaf; docToAst re-nests them
   per leaf in the serializer's canonical order and leaves merging of
   adjacent same-marked runs to astToMd's canonicalization.
   ========================================================================= */

import type { MdBlock, MdInline } from '../lib/md'

export type PMMark = { type: string; attrs?: Record<string, unknown> }
export type PMNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
  marks?: PMMark[]
  text?: string
}

/* ---- AST → doc ----------------------------------------------------------- */

function inlineToNodes(nodes: MdInline[], marks: PMMark[]): PMNode[] {
  const out: PMNode[] = []
  const push = (n: PMNode, extra?: PMMark) => {
    const all = extra ? [...marks, extra] : marks
    out.push(all.length ? { ...n, marks: all } : n)
  }
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        if (n.text) push({ type: 'text', text: n.text }) // PM rejects empty text leaves
        break
      case 'br':
        push({ type: 'hardBreak' })
        break
      case 'code':
        if (n.text) push({ type: 'text', text: n.text }, { type: 'code' })
        break
      case 'image':
        push({ type: 'image', attrs: { src: n.src, alt: n.alt } })
        break
      case 'mention':
        push({ type: 'mention', attrs: { id: n.id, label: n.name } })
        break
      case 'link':
        // replace, don't stack: PM allows one link mark, and the serializer
        // resolves nested links to the innermost
        out.push(
          ...inlineToNodes(n.children, [
            ...marks.filter((m) => m.type !== 'link'),
            { type: 'link', attrs: { href: n.href } },
          ]),
        )
        break
      default:
        out.push(
          ...inlineToNodes(
            n.children,
            marks.some((m) => m.type === n.t) ? marks : [...marks, { type: n.t }],
          ),
        )
    }
  }
  return out
}

const para = (children: MdInline[]): PMNode => {
  const content = inlineToNodes(children, [])
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

export function astToDoc(blocks: MdBlock[]): PMNode {
  const content: PMNode[] = []
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        content.push(para(b.children))
        break
      case 'h': {
        const inline = inlineToNodes(b.children, [])
        content.push({
          type: 'heading',
          attrs: { level: Math.min(3, Math.max(1, b.level | 0)) },
          ...(inline.length ? { content: inline } : {}),
        })
        break
      }
      case 'quote':
        content.push({ type: 'blockquote', content: [para(b.children)] })
        break
      case 'ul':
        if (b.items.length)
          content.push({
            type: 'bulletList',
            content: b.items.map((it) => ({ type: 'listItem', content: [para(it)] })),
          })
        break
      case 'ol':
        if (b.items.length)
          content.push({
            type: 'orderedList',
            attrs: { start: Math.min(999, Math.max(1, Math.floor(b.start) || 1)) },
            content: b.items.map((it) => ({ type: 'listItem', content: [para(it)] })),
          })
        break
      case 'codeblock':
        content.push(
          b.text
            ? { type: 'codeBlock', content: [{ type: 'text', text: b.text }] }
            : { type: 'codeBlock' },
        )
        break
    }
  }
  // PM documents hold at least one block
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

/* ---- doc → AST ----------------------------------------------------------- */

const MARK_WRAP: Array<[string, 'bold' | 'italic' | 'underline' | 'strike']> = [
  // inner → outer; matches the serializer's canonical nesting (link outermost)
  ['strike', 'strike'],
  ['underline', 'underline'],
  ['italic', 'italic'],
  ['bold', 'bold'],
]

function leafToInline(n: PMNode): MdInline | null {
  const marks = n.marks || []
  const has = (t: string) => marks.some((m) => m.type === t)
  let leaf: MdInline
  if (n.type === 'text') {
    if (!n.text) return null
    leaf = has('code') ? { t: 'code', text: n.text } : { t: 'text', text: n.text }
  } else if (n.type === 'hardBreak') {
    leaf = { t: 'br' }
  } else if (n.type === 'image') {
    leaf = { t: 'image', alt: String(n.attrs?.alt ?? ''), src: String(n.attrs?.src ?? '') }
  } else if (n.type === 'mention') {
    const id = String(n.attrs?.id ?? '')
    const name = String(n.attrs?.label ?? '')
    // an id that isn't a uuid can't round-trip as a mention — keep the text
    leaf = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? { t: 'mention', id: id.toLowerCase(), name }
      : { t: 'text', text: `@${name}` }
  } else {
    return null // unknown inline node — nothing in the dialect to hold it
  }
  for (const [pm, md] of MARK_WRAP) if (has(pm)) leaf = { t: md, children: [leaf] }
  const link = marks.find((m) => m.type === 'link')
  if (link) leaf = { t: 'link', href: String(link.attrs?.href ?? ''), children: [leaf] }
  return leaf
}

function inlineContent(nodes: PMNode[] | undefined): MdInline[] {
  const out: MdInline[] = []
  for (const n of nodes || []) {
    const leaf = leafToInline(n)
    if (leaf) out.push(leaf)
  }
  return out
}

/** All inline content of a block-level subtree, paragraphs joined by hard
    breaks — the defensive path for shapes the schema forbids (multi-block
    list items or quotes); astToMd then degrades the breaks per context. */
function flattenBlocks(nodes: PMNode[] | undefined): MdInline[] {
  const out: MdInline[] = []
  for (const n of nodes || []) {
    const leaf = leafToInline(n)
    if (leaf) {
      out.push(leaf)
      continue
    } // inline sibling — append in place
    const part = flattenBlocks(n.content) // block — recurse and join on breaks
    if (!part.length) continue
    if (out.length) out.push({ t: 'br' })
    out.push(...part)
  }
  return out
}

function codeText(nodes: PMNode[] | undefined): string {
  return (nodes || []).map((n) => n.text || '').join('')
}

export function docToAst(doc: PMNode): MdBlock[] {
  const out: MdBlock[] = []
  for (const b of doc.content || []) {
    switch (b.type) {
      case 'paragraph':
        out.push({ t: 'p', children: inlineContent(b.content) })
        break
      case 'heading': {
        const raw = Number(b.attrs?.level) || 1
        out.push({
          t: 'h',
          level: Math.min(3, Math.max(1, raw)) as 1 | 2 | 3,
          children: inlineContent(b.content),
        })
        break
      }
      case 'blockquote': {
        // one paragraph by schema; several degrade to a blank quote line
        const children: MdInline[] = []
        for (const p of b.content || []) {
          if (children.length) children.push({ t: 'br' }, { t: 'br' })
          children.push(...(p.type === 'paragraph' ? inlineContent(p.content) : flattenBlocks([p])))
        }
        out.push({ t: 'quote', children })
        break
      }
      case 'bulletList':
      case 'orderedList': {
        const items = (b.content || [])
          .filter((li) => li.type === 'listItem')
          .map((li) => flattenBlocks(li.content))
        if (!items.length) break
        if (b.type === 'bulletList') out.push({ t: 'ul', items })
        else
          out.push({
            t: 'ol',
            start: Math.min(999, Math.max(1, Math.floor(Number(b.attrs?.start)) || 1)),
            items,
          })
        break
      }
      case 'codeBlock':
        out.push({ t: 'codeblock', text: codeText(b.content) })
        break
      default:
        break // horizontalRule etc. — schema disables them; drop
    }
  }
  return out
}
