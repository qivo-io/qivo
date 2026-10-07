/* =========================================================================
   AST → markdown serializer for issue descriptions — the inverse of
   lib/md's parseMd, and the definition of the dialect's canonical form:
   stored text is astToMd(parseMd(s)), and parseMd(astToMd(ast)) preserves
   ast up to the normalizations documented inline (whitespace at mark
   boundaries, hard breaks in single-line contexts, href encoding).

   The WYSIWYG editor commits through this: TipTap doc → AST (adapter) →
   astToMd → the existing updateIssue flow. Everything the store keys on —
   the ![alt](att:<uuid>) / ![Uploading image…](uploading:<tag>) byte
   patterns — is emitted byte-identically to the upload flow.

   Internally, inline trees flatten to a run of atoms (text / code / image /
   hard break), each carrying a link href (innermost link wins) and a
   bold/italic/underline/strike bitmask. Marks are emitted per same-markset
   group in a fixed nesting order (link > bold > italic > underline >
   strike; code and images are self-delimiting leaves), never spanning a
   markset change — abutting delimiter runs like `**a***b*` are exactly the
   shapes the parser's greedy left-to-right scan reads back correctly.
   ========================================================================= */

import type { MdBlock, MdInline } from './md'

const BOLD = 1,
  ITALIC = 2,
  UNDERLINE = 4,
  STRIKE = 8

type Atom =
  | { k: 'text'; text: string; link: string | null; m: number }
  | { k: 'code'; text: string; link: string | null; m: number }
  | { k: 'image'; alt: string; src: string; link: string | null; m: number }
  | { k: 'mention'; id: string; name: string; link: string | null; m: number }
  | { k: 'br'; link: string | null; m: number }

/* ---- flatten: inline tree → atom run ----------------------------------- */

function flatten(nodes: MdInline[], link: string | null, m: number, out: Atom[]) {
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out.push({ k: 'text', text: n.text, link, m })
        break
      case 'br':
        out.push({ k: 'br', link, m })
        break
      case 'code':
        out.push({ k: 'code', text: n.text, link, m })
        break
      case 'image':
        out.push({ k: 'image', alt: n.alt, src: n.src, link, m })
        break
      case 'mention':
        out.push({ k: 'mention', id: n.id, name: n.name, link, m })
        break
      case 'link':
        flatten(n.children, n.href, m, out)
        break // nested links: innermost wins
      case 'bold':
        flatten(n.children, link, m | BOLD, out)
        break
      case 'italic':
        flatten(n.children, link, m | ITALIC, out)
        break
      case 'underline':
        flatten(n.children, link, m | UNDERLINE, out)
        break
      case 'strike':
        flatten(n.children, link, m | STRIKE, out)
        break
    }
  }
}

/* ---- canonicalization --------------------------------------------------- */

function mergeText(atoms: Atom[]): Atom[] {
  const out: Atom[] = []
  for (const a of atoms) {
    const last = out[out.length - 1]
    // adjacent same-marked code spans also merge: they're indistinguishable
    // from one span, and `` `a``a` `` would reparse as a single "a``a"
    if (
      (a.k === 'text' || a.k === 'code') &&
      last &&
      last.k === a.k &&
      last.link === a.link &&
      last.m === a.m
    ) {
      last.text += a.text
      continue
    }
    out.push({ ...a })
  }
  return out
}

/** Peel whitespace and hard breaks off both ends of a marked group into
    unmarked atoms: the parser rejects delimiter-hugging whitespace, so
    bold/italic/underline/strike can never survive there. Link is kept —
    `[ x](u)` is representable. */
function trimGroup(group: Atom[], out: Atom[]) {
  while (group.length) {
    const a = group[0]
    if (a.k === 'br') {
      out.push({ ...a, m: 0 })
      group.shift()
      continue
    }
    if (a.k === 'text') {
      const ws = /^\s+/.exec(a.text)
      if (ws && ws[0] === a.text) {
        out.push({ ...a, m: 0 })
        group.shift()
        continue
      }
      if (ws) {
        out.push({ k: 'text', text: ws[0], link: a.link, m: 0 })
        group[0] = { ...a, text: a.text.slice(ws[0].length) }
      }
    }
    break
  }
  const tail: Atom[] = []
  while (group.length) {
    const a = group[group.length - 1]
    if (a.k === 'br') {
      tail.unshift({ ...a, m: 0 })
      group.pop()
      continue
    }
    if (a.k === 'text') {
      const ws = /\s+$/.exec(a.text)
      if (ws && ws[0] === a.text) {
        tail.unshift({ ...a, m: 0 })
        group.pop()
        continue
      }
      if (ws) {
        tail.unshift({ k: 'text', text: ws[0], link: a.link, m: 0 })
        group[group.length - 1] = { ...a, text: a.text.slice(0, a.text.length - ws[0].length) }
      }
    }
    break
  }
  out.push(...group, ...tail)
}

/** Flatten + canonicalize one block's inline content. ctx 'line' is the
    single-physical-line contexts (headings, list items) where a hard break
    cannot exist and becomes a space; inside link labels it always does
    (labels cannot span lines). */
function canonicalAtoms(nodes: MdInline[], ctx: 'p' | 'quote' | 'line'): Atom[] {
  const raw: Atom[] = []
  flatten(nodes, null, 0, raw)
  let atoms: Atom[] = []
  const brOrSpace = (a: Atom): Atom =>
    ctx === 'line' || a.link !== null
      ? { k: 'text', text: ' ', link: a.link, m: a.m }
      : { k: 'br', link: a.link, m: a.m }
  for (const a of raw) {
    if (a.k === 'image' || a.k === 'mention') {
      atoms.push({ ...a })
      continue
    }
    if (a.k === 'br') {
      atoms.push(brOrSpace(a))
      continue
    }
    // \r never survives parseMd, and embedded newlines are really hard
    // breaks (in code they split the span: escapes don't work inside code)
    const parts = a.text.replace(/\r/g, '').split('\n')
    parts.forEach((p, idx) => {
      if (idx) atoms.push(brOrSpace(a))
      if (p)
        atoms.push(
          a.k === 'code'
            ? { k: 'code', text: p, link: a.link, m: a.m }
            : { k: 'text', text: p, link: a.link, m: a.m },
        )
    })
  }
  atoms = mergeText(atoms)
  const trimmed: Atom[] = []
  let i = 0
  while (i < atoms.length) {
    const { link, m } = atoms[i]
    let j = i
    while (j < atoms.length && atoms[j].link === link && atoms[j].m === m) j++
    const group = atoms.slice(i, j)
    if (m) trimGroup(group, trimmed)
    else trimmed.push(...group)
    i = j
  }
  return mergeText(trimmed)
}

/** Paragraph-only: blank and whitespace-only lines don't survive parsing
    (they split the paragraph), so collapse them away and drop edge breaks. */
function collapseParagraphLines(atoms: Atom[]): Atom[] {
  // segments carry the break that follows them, so a kept break keeps its
  // marks and the emitter can span delimiters across it (**a\nb**)
  const segs: Array<{ atoms: Atom[]; br: Atom | null }> = [{ atoms: [], br: null }]
  for (const a of atoms) {
    if (a.k === 'br') {
      segs[segs.length - 1].br = a
      segs.push({ atoms: [], br: null })
    } else segs[segs.length - 1].atoms.push(a)
  }
  const kept = segs.filter((l) => l.atoms.some((a) => !(a.k === 'text' && !a.text.trim())))
  const out: Atom[] = []
  kept.forEach((l, idx) => {
    out.push(...l.atoms)
    if (idx < kept.length - 1) out.push(l.br!)
  })
  return mergeText(out)
}

function stripLead(atoms: Atom[]): Atom[] {
  const out = [...atoms]
  // linked whitespace stops the strip: "[ a](u)" is representable even at a
  // heading/item start (the prefix regex consumed its whitespace already)
  while (out.length && out[0].k === 'text' && out[0].link === null) {
    const t = out[0].text.replace(/^\s+/, '')
    if (t) {
      out[0] = { ...out[0], text: t }
      break
    }
    out.shift()
  }
  return out
}

/* ---- emission ------------------------------------------------------------ */

/** Byte-compatible with the upload flow's alt sanitization — `![alt](att:…)`
    must round-trip exactly for the store's reference GC to match on it. */
function sanitizeAlt(alt: string): string {
  return alt.replace(/\r/g, '').replace(/[[\]()\n\\]/g, '_')
}

/** Destinations take no backslash escapes (the parser never unescapes them)
    but its scanner still SKIPS \x pairs — a trailing backslash would swallow
    the closing paren — so backslashes and the delimiter-colliding characters
    are percent-encoded instead. att:/uploading: pseudo-URLs contain none of
    them — this is a no-op there. */
function encodeDest(href: string): string {
  return href
    .trim()
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '%5C')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

function escapeText(s: string, blockEsc: boolean, inLabel: boolean): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' || c === '`' || c === '*' || c === '[') out += `\\${c}`
    // ~ and + only pair up: escape every char of a run except the last, and
    // any at the end of the atom — the next emitted char can be a ~~/++
    // delimiter it would otherwise fuse with (`~~a\~~~` closing strike on
    // text ending in "~"); at an opener the extra char self-heals, since
    // openers are exactly two chars and the third lands inside the span
    else if ((c === '~' || c === '+') && (s[i + 1] === c || i === s.length - 1)) out += `\\${c}`
    else if (c === ']' && inLabel) out += `\\${c}`
    else out += c
  }
  if (blockEsc) {
    // this text opens a physical line of a paragraph: defuse block syntax
    if (/^#{1,3}\s/.test(out) || out[0] === '>' || /^-\s/.test(out)) return `\\${out}`
    const o = /^(\d{1,3})([.)])\s/.exec(out)
    if (o) return `${o[1]}\\${o[2]}${out.slice(o[1].length + 1)}`
  }
  return out
}

function emitCode(text: string): string {
  let run = 0
  for (const m of text.matchAll(/`+/g)) run = Math.max(run, m[0].length)
  const marker = '`'.repeat(run + 1)
  // content whose edge would collide with the marker (or be stripped as
  // padding on reparse) gets one space of padding each side
  const pad = text.trim() && /^[\s`]|[\s`]$/.test(text) ? ' ' : ''
  return marker + pad + text + pad + marker
}

/** Emit one block's canonical atoms. `para` turns on line-start block-prefix
    escaping — only paragraph lines re-enter block parsing; quote/list/heading
    prefixes are stripped exactly once before inline parsing. */
function emitAtoms(atoms: Atom[], para: boolean): string {
  const groups: Array<{ link: string | null; m: number; atoms: Atom[] }> = []
  {
    let i = 0
    while (i < atoms.length) {
      const { link, m } = atoms[i]
      let j = i
      while (j < atoms.length && atoms[j].link === link && atoms[j].m === m) j++
      groups.push({ link, m, atoms: atoms.slice(i, j) })
      i = j
    }
  }
  let out = ''
  let lineStart = true
  for (let g = 0; g < groups.length; g++) {
    const { link, m, atoms: group } = groups[g]
    let open = ''
    if (m & BOLD) open += '**'
    if (m & ITALIC) open += '*'
    if (m & UNDERLINE) open += '++'
    if (m & STRIKE) open += '~~'
    const close =
      (m & STRIKE ? '~~' : '') +
      (m & UNDERLINE ? '++' : '') +
      (m & ITALIC ? '*' : '') +
      (m & BOLD ? '**' : '')
    let inner = ''
    // text sits at a true line start only when no delimiter precedes it on
    // the line; a hard break inside a marked group starts a fresh line
    let innerLineStart = lineStart && link === null && !open
    for (const a of group) {
      if (a.k === 'br') {
        inner += '\n'
        innerLineStart = true
        continue
      }
      if (a.k === 'text') inner += escapeText(a.text, innerLineStart && para, link !== null)
      else if (a.k === 'code') inner += emitCode(a.text)
      else if (a.k === 'mention') inner += `@[${sanitizeAlt(a.name)}](user:${a.id})`
      else inner += `![${sanitizeAlt(a.alt)}](${encodeDest(a.src)})`
      innerLineStart = false
    }
    let piece = open + inner + close
    if (link !== null) piece = `[${piece}](${encodeDest(link)})`
    // a trailing literal "!" would fuse with a following link's "[" into
    // image syntax — and a trailing "@" into mention syntax when the link's
    // dest is user:-shaped; only bare adjacency fuses (any delimiter
    // between saves it), and "@" is escapable since the mention dialect
    else if (
      !close &&
      (piece.endsWith('!') || piece.endsWith('@')) &&
      groups[g + 1] &&
      groups[g + 1].link !== null
    )
      piece = `${piece.slice(0, -1)}\\${piece[piece.length - 1]}`
    out += piece
    lineStart = piece.endsWith('\n')
  }
  return out
}

/* ---- blocks --------------------------------------------------------------- */

export function astToMd(blocks: MdBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.t) {
      case 'p': {
        const atoms = collapseParagraphLines(canonicalAtoms(b.children, 'p'))
        if (atoms.length) out.push(emitAtoms(atoms, true))
        break
      }
      case 'h': {
        const level = Math.min(3, Math.max(1, b.level | 0))
        // HEADING strips all whitespace after the #s, so none can lead
        out.push(
          `${'#'.repeat(level)} ${emitAtoms(stripLead(canonicalAtoms(b.children, 'line')), false)}`,
        )
        break
      }
      case 'quote': {
        const body = emitAtoms(canonicalAtoms(b.children, 'quote'), false)
        out.push(
          body
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'),
        )
        break
      }
      case 'ul': {
        if (!b.items.length) break
        out.push(
          b.items
            .map((it) => `- ${emitAtoms(stripLead(canonicalAtoms(it, 'line')), false)}`)
            .join('\n'),
        )
        break
      }
      case 'ol': {
        if (!b.items.length) break
        const start = Math.min(999, Math.max(1, Math.floor(b.start) || 1))
        out.push(
          b.items
            // numbers past the parser's 3-digit cap saturate; only `start` is
            // meaningful on reparse anyway
            .map(
              (it, idx) =>
                `${Math.min(999, start + idx)}. ` +
                emitAtoms(stripLead(canonicalAtoms(it, 'line')), false),
            )
            .join('\n'),
        )
        break
      }
      case 'codeblock': {
        const text = b.text.replace(/\r/g, '')
        let run = 0
        for (const m of text.matchAll(/`+/g)) run = Math.max(run, m[0].length)
        const fence = '`'.repeat(Math.max(3, run + 1))
        out.push(text ? `${fence}\n${text}\n${fence}` : `${fence}\n${fence}`)
        break
      }
    }
  }
  return out.join('\n\n')
}
