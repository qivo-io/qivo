/* =========================================================================
   Minimal markdown for issue descriptions — the parser half; the inverse
   serializer (astToMd, the canonical form) lives in src/lib/mdSerialize.

   Dialect (deliberately small; exactly what the WYSIWYG editor emits):
     inline  **bold**  *italic*  ~~strike~~  ++underline++  `code`
             [text](url)  ![alt](src)  bare http(s) autolinks  \ escapes
     blocks  # ## ### headings · > quotes · -/* bullets · 1. numbered lists
             ``` fenced code ``` · blank-line paragraphs (single \n = <br>)

   It lives here, importing only lib/limits.ts, so the server reads a
   description as the app shows it (lib/imageRefs.ts); the app imports it
   through src/lib/md.ts. The renderer (src/components/markdown.tsx) walks
   this AST and builds React elements — raw HTML in a description is never
   interpreted, so parsing
   here is purely structural. Underscores are NOT emphasis (snake_case is
   everywhere in issue text) and ++underline++ is a local extension:
   markdown has no underline and this round-trips without HTML tags.
   Image src values are either a normal URL or "att:<attachment uuid>"
   pointing into the private attachments bucket ("uploading:<tag>" is the
   editor's transient placeholder while a paste is in flight).
   ========================================================================= */

import { TEXT_MAX } from './limits'

export type MdInline =
  | { t: 'text'; text: string }
  | { t: 'br' }
  | { t: 'code'; text: string }
  | { t: 'bold' | 'italic' | 'strike' | 'underline'; children: MdInline[] }
  | { t: 'link'; href: string; children: MdInline[] }
  | { t: 'image'; alt: string; src: string }
  | { t: 'mention'; id: string; name: string }

/* @[Name](user:<uuid>) — a member mention. The dest must be exactly a
   user: uuid or the construct stays a literal "@" + link; the uuid is what
   the server's notify triggers extract, the name is display-only (like an
   image alt, the label is not unescaped). The label may not contain square
   brackets (0075: the server regex can't cross them, the canonical
   serializer never emits them — sanitizeAlt strips brackets — so accepting
   them here would render mentions the server never notifies). */
export const MENTION_DEST = /^user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export type MdBlock =
  | { t: 'p'; children: MdInline[] }
  | { t: 'h'; level: 1 | 2 | 3; children: MdInline[] }
  | { t: 'quote'; children: MdInline[] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; start: number; items: MdInline[][] }
  | { t: 'codeblock'; text: string }

const ESCAPABLE = '\\`*_~+[]()!#>-.@'

/* paired inline marks, longest first so ** wins over * */
const MARKS: Array<['**' | '~~' | '++' | '*', 'bold' | 'strike' | 'underline' | 'italic']> = [
  ['**', 'bold'],
  ['~~', 'strike'],
  ['++', 'underline'],
  ['*', 'italic'],
]

/** A `[label](dest)` construct: its label, its trimmed destination and the
    index after its closing parenthesis. */
type LinkLike = { label: string; dest: string; end: number }

/* The partner of each opening `open` in `src`: the index of the `close`
   that brings its depth back to zero, or -1 when a line break or the end
   comes first. A character after an odd run of backslashes is escaped and
   counts for nothing, as a backslash escapes any character inside a link. */
function partners(src: string, escaped: Uint8Array, open: string, close: string): Int32Array {
  const partner = new Int32Array(src.length).fill(-1)
  const stack: number[] = []
  for (let p = 0; p < src.length; p++) {
    if (escaped[p]) continue
    const c = src[p]
    if (c === '\n') stack.length = 0
    else if (c === open) stack.push(p)
    else if (c === close) {
      const opener = stack.pop()
      if (opener !== undefined) partner[opener] = p
    }
  }
  return partner
}

/* Whether each character of `src` follows an odd run of backslashes. */
function escapes(src: string): Uint8Array {
  const escaped = new Uint8Array(src.length)
  let run = 0
  for (let p = 0; p < src.length; p++) {
    escaped[p] = run % 2
    run = src[p] === '\\' ? run + 1 : 0
  }
  return escaped
}

/** One text's links, code spans and mark closers, each read from a table
    built in one pass the first time it is asked. Scanning ahead for them
    at each bracket, backtick or mark costs up to the rest of the text a
    time, which made text such as 20,000 brackets parse in quadratic time;
    the tables keep a parse linear in the text length at each nesting
    depth. Exported for src/lib/md.test.ts, which checks every answer
    against a scan ahead from the same index. */
export class Scan {
  private escaped?: Uint8Array
  private brackets?: Int32Array
  private parens?: Int32Array
  private runEnd?: Int32Array
  private runClose?: Int32Array
  private closers = new Map<string, Int32Array>()

  constructor(readonly src: string) {}

  /** The `[label](dest)` whose opening bracket is at `at`, or null. Inside
      it a backslash escapes any character and a line break ends it; the
      brackets of the label and the parentheses of the destination nest.
      `at` must be an unescaped bracket (one after an even run of
      backslashes, if any), as every parse asks. */
  link(at: number): LinkLike | null {
    this.escaped ??= escapes(this.src)
    this.brackets ??= partners(this.src, this.escaped, '[', ']')
    const j = this.brackets[at]
    if (j < 0 || this.src[j + 1] !== '(') return null
    this.parens ??= partners(this.src, this.escaped, '(', ')')
    const k = this.parens[j + 1]
    if (k < 0) return null
    return { label: this.src.slice(at + 1, j), dest: this.src.slice(j + 2, k).trim(), end: k + 1 }
  }

  /* The end of each backtick's run, and where the first later run of
     exactly the length from it to that end starts, or -1. */
  private codeTables(): { runEnd: Int32Array; runClose: Int32Array } {
    if (this.runEnd && this.runClose) return { runEnd: this.runEnd, runClose: this.runClose }
    const { src } = this
    const runEnd = new Int32Array(src.length).fill(-1)
    const runClose = new Int32Array(src.length).fill(-1)
    const runs: [number, number][] = []
    for (let p = 0; p < src.length; ) {
      if (src[p] !== '`') {
        p++
        continue
      }
      let q = p
      while (src[q] === '`') q++
      for (let r = p; r < q; r++) runEnd[r] = q
      runs.push([p, q])
      p = q
    }
    // from the last run back, the nearest run to the right of each length
    const nearest = new Map<number, number>()
    for (let r = runs.length - 1; r >= 0; r--) {
      const [p, q] = runs[r]
      for (let at = p; at < q; at++) runClose[at] = nearest.get(q - at) ?? -1
      nearest.set(q - p, p)
    }
    this.runEnd = runEnd
    this.runClose = runClose
    return { runEnd, runClose }
  }

  /** The backtick-run code span at `at` (must point at a backtick): the
      content runs to the next run of exactly the same length, so code can
      contain shorter backtick runs (``a`b``). One space is stripped from
      each end when both are present and the content isn't all spaces — the
      serializer pads content that starts or ends with a space or backtick.
      Escapes do not work inside code: content is verbatim (`` `a\` `` is
      code ending in a backslash). Returns [content, indexAfterCloser] or
      [null, 0]. */
  code(at: number): [string | null, number] {
    const { runEnd, runClose } = this.codeTables()
    const n = runEnd[at] - at
    const j = runClose[at]
    if (j < 0) return [null, 0]
    let content = this.src.slice(at + n, j)
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim())
      content = content.slice(1, -1)
    return [content, j + n]
  }

  /* Where the closer search (close) moves on from `i`: past an escape, a
     code span or backtick run, or a link or image, else to the next
     character. */
  private step(i: number): number {
    const { src } = this
    const c = src[i]
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) return i + 2
    if (c === '`') {
      const { runEnd, runClose } = this.codeTables()
      return runClose[i] < 0 ? runEnd[i] : runClose[i] + runEnd[i] - i
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const m = this.link(c === '[' ? i : i + 1)
      if (m) return m.end
    }
    return i + 1
  }

  /** The first `marker` from `from`, skipping backslash escapes, complete
      code spans, and link/image constructs — the same atoms the main scan
      consumes — so a delimiter inside them ("**a\***", "**`a**b`**") never
      closes an outer mark. Returns -1 when no closer exists. Every index
      the search passes keeps its answer, so no index is walked twice for
      one marker. */
  close(from: number, marker: string): number {
    let known = this.closers.get(marker)
    if (known === undefined) {
      // -2: not known yet; the end of the text has no closer
      known = new Int32Array(this.src.length + 1).fill(-2)
      known[this.src.length] = -1
      this.closers.set(marker, known)
    }
    const path: number[] = []
    let i = from
    while (known[i] === -2) {
      if (this.src.startsWith(marker, i)) {
        known[i] = i
        break
      }
      path.push(i)
      i = this.step(i)
    }
    for (const p of path) known[p] = known[i]
    return known[i]
  }
}

/* Whether a mark's inner text is empty or starts or ends with whitespace,
   which keeps "a * b * c" literal. Reads only the two ends, unlike a trim
   or a regular expression over the whole inner text. */
const hugsSpace = (inner: string) =>
  inner.length === 0 || /\s/.test(inner[0]) || /\s/.test(inner[inner.length - 1])

/* Nested link labels are the one place recursion depth is user-controlled
   ("[[[…]]](u)(u)(u)"); past this depth the rest renders as literal text
   instead of risking a stack overflow at render time. */
const MAX_DEPTH = 12

export function parseInline(src: string, depth = 0, inLabel = false): MdInline[] {
  if (depth > MAX_DEPTH) return src ? [{ t: 'text', text: src }] : []
  const tables = new Scan(src)
  const out: MdInline[] = []
  let text = ''
  const flush = () => {
    if (text) {
      out.push({ t: 'text', text })
      text = ''
    }
  }
  let i = 0
  scan: while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }
    if (ch === '`') {
      const [content, end] = tables.code(i)
      if (content !== null) {
        flush()
        out.push({ t: 'code', text: content })
        i = end
        continue
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const m = tables.link(i + 1)
      if (m) {
        flush()
        out.push({ t: 'image', alt: m.label, src: m.dest })
        i = m.end
        continue
      }
    }
    if (ch === '@' && src[i + 1] === '[') {
      const m = tables.link(i + 1)
      const u = m && MENTION_DEST.exec(m.dest)
      // a non-user: dest (or a bracketed label) falls through: the "@"
      // stays text, the link parses
      if (m && u && !/[\][]/.test(m.label)) {
        flush()
        out.push({ t: 'mention', id: u[1].toLowerCase(), name: m.label })
        i = m.end
        continue
      }
    }
    if (ch === '[') {
      const m = tables.link(i)
      if (m) {
        flush()
        out.push({ t: 'link', href: m.dest, children: parseInline(m.label, depth + 1, true) })
        i = m.end
        continue
      }
    }
    // ***both*** — the serializer emits this when bold and italic stack
    if (src.startsWith('***', i) && src[i + 3] !== '*') {
      const end = tables.close(i + 3, '***')
      if (end > i + 3) {
        const inner = src.slice(i + 3, end)
        if (!hugsSpace(inner)) {
          flush()
          out.push({
            t: 'bold',
            children: [{ t: 'italic', children: parseInline(inner, depth + 1, inLabel) }],
          })
          i = end + 3
          continue
        }
      }
    }
    for (const [marker, t] of MARKS) {
      if (!src.startsWith(marker, i)) continue
      const end = tables.close(i + marker.length, marker)
      if (end <= i + marker.length) continue
      const inner = src.slice(i + marker.length, end)
      // "a * b * c" must stay literal: no space hugging the delimiters
      if (hugsSpace(inner)) continue
      flush()
      out.push({ t, children: parseInline(inner, depth + 1, inLabel) })
      i = end + marker.length
      continue scan
    }
    // no autolinks inside a link label: links can't nest (the span model is
    // flat), and a label like "[https://a.io](https://b.io)" must keep b.io
    if (
      !inLabel &&
      (src.startsWith('http://', i) || src.startsWith('https://', i)) &&
      (i === 0 || !/\w/.test(src[i - 1]))
    ) {
      let j = i
      while (j < src.length && !/[\s<>"')\]]/.test(src[j])) j++
      while (j > i && /[.,;:!?]/.test(src[j - 1])) j--
      const url = src.slice(i, j)
      if (url.length > 'https://'.length) {
        flush()
        out.push({ t: 'link', href: url, children: [{ t: 'text', text: url }] })
        i = j
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

const FENCE = /^\s{0,3}(`{3,})\w*\s*$/
const HEADING = /^(#{1,3})\s+(.*)$/
const QUOTE = /^>\s?/
const BULLET = /^[-*]\s+/
const ORDERED = /^(\d{1,3})[.)]\s+/

/* The inline scanner reads in time linear in the text length (Scan), but a
   text no save accepts is not parsed at all: past this size it renders as
   plain paragraphs. The editor
   checks it too: the fallback AST must never round-trip through a commit
   (re-escaping would corrupt the whole text), so a stored text past it
   opens read-only. The limit equals the server's save cap, so every text
   saved since the cap parses. */
export const MAX_PARSE = TEXT_MAX

export function parseMd(src: string): MdBlock[] {
  if (src.length > MAX_PARSE) {
    return src.split(/\n{2,}/).map((chunk) => ({
      t: 'p' as const,
      children: chunk
        .split('\n')
        .flatMap<MdInline>((l, i) =>
          i ? [{ t: 'br' }, { t: 'text', text: l }] : [{ t: 'text', text: l }],
        ),
    }))
  }
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      blocks.push({ t: 'p', children: parseInline(para.join('\n')) })
      para = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (f) {
      flushPara()
      // the closer must be at least as long as the opener, so a code block
      // can contain shorter fence lines (the serializer picks its fence
      // length as the longest interior backtick run + 1)
      const openLen = f[1].length
      const buf: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const c = FENCE.exec(lines[j])
        if (c && c[1].length >= openLen) break
        buf.push(lines[j])
      }
      blocks.push({ t: 'codeblock', text: buf.join('\n') })
      i = j // past the closing fence (or EOF on an unterminated one)
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flushPara()
      blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, children: parseInline(h[2]) })
      continue
    }
    if (QUOTE.test(line)) {
      flushPara()
      const buf = [line.replace(QUOTE, '')]
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) {
        i++
        buf.push(lines[i].replace(QUOTE, ''))
      }
      blocks.push({ t: 'quote', children: parseInline(buf.join('\n')) })
      continue
    }
    if (BULLET.test(line)) {
      flushPara()
      const items = [line.replace(BULLET, '')]
      while (i + 1 < lines.length && BULLET.test(lines[i + 1])) {
        i++
        items.push(lines[i].replace(BULLET, ''))
      }
      blocks.push({ t: 'ul', items: items.map((l) => parseInline(l)) })
      continue
    }
    const o = ORDERED.exec(line)
    if (o) {
      flushPara()
      const items = [line.replace(ORDERED, '')]
      while (i + 1 < lines.length && ORDERED.test(lines[i + 1])) {
        i++
        items.push(lines[i].replace(ORDERED, ''))
      }
      blocks.push({
        t: 'ol',
        start: parseInt(o[1], 10) || 1,
        items: items.map((l) => parseInline(l)),
      })
      continue
    }
    if (!line.trim()) {
      flushPara()
      continue
    }
    para.push(line)
  }
  flushPara()
  return blocks
}

/* The text inline nodes show, each piece apart: a link's text but not its
   destination, an image's alt text but not its source, a mention's name but
   not its id. */
function inlineText(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
        case 'code':
          return node.text
        case 'br':
          return '\n'
        case 'image':
          return node.alt
        case 'mention':
          return node.name
        default:
          return inlineText(node.children)
      }
    })
    .join(' ')
}

/* What only a description with hidden words holds: the `](` of a link, an
   image or a mention, a code fence, whose opening line can name a
   language, and a numbered list item, whose number the list draws. Any
   other markup is marks and punctuation, which hold no word. */
const HIDES = /\]\(|^\s{0,3}```|^\d{1,3}[.)]\s/m

/** Whether `markdown` can hold words it does not show (readableText). A
    text without any is shown word for word, so it needs no parse. */
export const hidesWords = (markdown: string): boolean => HIDES.test(markdown)

/** The text a description shows, which main Search matches
    (lib/mainSearch.ts): its text, code, link text, image alt text and
    mention names, without link destinations, image sources (`att:`
    references), mention ids (MENTION_DEST), the language a code fence
    names or the numbers of a numbered list. A bare autolink is shown text
    and stays. The pieces join with a space, as the markup between them
    ends a word in the stored text too, so the words are those of the
    stored text without its hidden parts. A text that hides no words
    (hidesWords) is answered as it is, unparsed. */
export function readableText(markdown: string): string {
  if (!hidesWords(markdown)) return markdown
  return parseMd(markdown)
    .map((block) => {
      switch (block.t) {
        case 'codeblock':
          return block.text
        case 'ul':
        case 'ol':
          return block.items.map(inlineText).join('\n')
        default:
          return inlineText(block.children)
      }
    })
    .join('\n')
}

/** Only plain web/mail links survive; anything else (javascript:, data:,
    relative paths…) renders as text. */
export function sanitizeHref(href: string): string | null {
  const h = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null
}

/* The pure text-transform editor helpers that lived below (toggleWrap and
   friends) left with the textarea editor — the WYSIWYG editor operates on
   the document, and serialization lives in src/lib/mdSerialize. */
