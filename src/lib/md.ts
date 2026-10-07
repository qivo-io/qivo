/* =========================================================================
   Minimal markdown for issue descriptions — the parser half; the inverse
   serializer (astToMd, the canonical form) lives in lib/mdSerialize.

   Dialect (deliberately small; exactly what the WYSIWYG editor emits):
     inline  **bold**  *italic*  ~~strike~~  ++underline++  `code`
             [text](url)  ![alt](src)  bare http(s) autolinks  \ escapes
     blocks  # ## ### headings · > quotes · -/* bullets · 1. numbered lists
             ``` fenced code ``` · blank-line paragraphs (single \n = <br>)

   The renderer (components/markdown.tsx) walks this AST and builds React
   elements — raw HTML in a description is never interpreted, so parsing
   here is purely structural. Underscores are NOT emphasis (snake_case is
   everywhere in issue text) and ++underline++ is a local extension:
   markdown has no underline and this round-trips without HTML tags.
   Image src values are either a normal URL or "att:<attachment uuid>"
   pointing into the private attachments bucket ("uploading:<tag>" is the
   editor's transient placeholder while a paste is in flight).
   ========================================================================= */

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

/** `[label](dest)` scanner; `at` must point at the opening bracket. */
function matchLinkLike(
  src: string,
  at: number,
): { label: string; dest: string; end: number } | null {
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

/** Backtick-run code span at `at` (must point at a backtick): the content
    runs to the next run of exactly the same length, so code can contain
    shorter backtick runs (``a`b``). One space is stripped from each end when
    both are present and the content isn't all spaces — the serializer pads
    content that starts or ends with a space or backtick. Escapes do not work
    inside code: content is verbatim (`` `a\` `` is code ending in a
    backslash). Returns [content, indexAfterCloser] or [null, 0]. */
function matchCodeSpan(src: string, at: number): [string | null, number] {
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

/** Find `marker` scanning from `from`, skipping backslash escapes, complete
    code spans, and link/image constructs — the same atoms the main scan
    consumes — so a delimiter inside them ("**a\***", "**`a**b`**") never
    closes an outer mark. Returns -1 when no closer exists. */
function scanClose(src: string, from: number, marker: string): number {
  let i = from
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      i += 2
      continue
    }
    if (c === '`') {
      const [content, end] = matchCodeSpan(src, i)
      if (content !== null) {
        i = end
        continue
      }
      while (src[i] === '`') i++
      continue
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const m = matchLinkLike(src, c === '[' ? i : i + 1)
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

/* Nested link labels are the one place recursion depth is user-controlled
   ("[[[…]]](u)(u)(u)"); past this depth the rest renders as literal text
   instead of risking a stack overflow at render time. */
const MAX_DEPTH = 12

export function parseInline(src: string, depth = 0, inLabel = false): MdInline[] {
  if (depth > MAX_DEPTH) return src ? [{ t: 'text', text: src }] : []
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
      const [content, end] = matchCodeSpan(src, i)
      if (content !== null) {
        flush()
        out.push({ t: 'code', text: content })
        i = end
        continue
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const m = matchLinkLike(src, i + 1)
      if (m) {
        flush()
        out.push({ t: 'image', alt: m.label, src: m.dest })
        i = m.end
        continue
      }
    }
    if (ch === '@' && src[i + 1] === '[') {
      const m = matchLinkLike(src, i + 1)
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
      const m = matchLinkLike(src, i)
      if (m) {
        flush()
        out.push({ t: 'link', href: m.dest, children: parseInline(m.label, depth + 1, true) })
        i = m.end
        continue
      }
    }
    // ***both*** — the serializer emits this when bold and italic stack
    if (src.startsWith('***', i) && src[i + 3] !== '*') {
      const end = scanClose(src, i + 3, '***')
      if (end > i + 3) {
        const inner = src.slice(i + 3, end)
        if (inner.trim() && !/^\s|\s$/.test(inner)) {
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
      const end = scanClose(src, i + marker.length, marker)
      if (end <= i + marker.length) continue
      const inner = src.slice(i + marker.length, end)
      // "a * b * c" must stay literal: no space hugging the delimiters
      if (!inner.trim() || /^\s|\s$/.test(inner)) continue
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

/* The inline scanner's nearest-closer searches are quadratic on pathological
   input (e.g. one long run of asterisks); past this size the text renders as
   plain paragraphs instead of freezing every viewer of the issue. The editor
   checks it too: the fallback AST must never round-trip through a commit
   (re-escaping would corrupt the whole text). */
export const MAX_PARSE = 20_000

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

/** Only plain web/mail links survive; anything else (javascript:, data:,
    relative paths…) renders as text. */
export function sanitizeHref(href: string): string | null {
  const h = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null
}

/* The pure text-transform editor helpers that lived below (toggleWrap and
   friends) left with the textarea editor — the WYSIWYG editor operates on
   the document, and serialization lives in lib/mdSerialize. */
