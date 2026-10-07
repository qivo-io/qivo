import { Button } from '@/components/ui/button'
import { HoverTooltip, hasOpenTooltip } from '@/components/ui/tooltip'
/* Rich editor for the lib/md dialect; viewers use Markdown. Load through
   parseMd -> astToDoc, save through docToAst -> astToMd and reparse to a fixed
   point. updateIssue GC preserves images referenced by new or previous text.
   Editable users load this component lazily.

   Save/Mod-S commits; blur retains drafts and dirty unmount discards with a
   toast. Escape closes popovers, then reverts dirty content and clears undo
   history so redo cannot resurrect reaped attachments, then reaches the modal
   only when clean. Toolbar mousedown preserves selection. Remote edits replace
   only unfocused clean documents; matching echoes advance committed refs to
   keep finishUpload's text and document patches atomic.

   Dialect: headings 1–3, flat one-paragraph quotes/lists, inline att:/uploading:
   images; no nesting, Tab binding, horizontal rules, underscore emphasis or
   fence languages. Only completed HTTP(S) tokens autolink; pasted text goes
   through parseMd. Comment mode shares Save/Discard and keys, but strips
   attachment images and rejects file paste/drop because comments own no files.
   comment.reset clears a submitted composer; edits retain the committed baseline. */

import type { Attributes, Editor, NodeViewProps } from '@tiptap/core'
import { Extension, markInputRule } from '@tiptap/core'
import Blockquote from '@tiptap/extension-blockquote'
import Bold, { starInputRegex as boldStar } from '@tiptap/extension-bold'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Image from '@tiptap/extension-image'
import Italic, { starInputRegex as italicStar } from '@tiptap/extension-italic'
import Link from '@tiptap/extension-link'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import Mention from '@tiptap/extension-mention'
import Paragraph from '@tiptap/extension-paragraph'
import Strike from '@tiptap/extension-strike'
import Text from '@tiptap/extension-text'
import Underline from '@tiptap/extension-underline'
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from '@tiptap/extensions'
import type { Node as PMDocNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from '@tiptap/react'
import type React from 'react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@/components/ui/input'
import { compressImage } from '../lib/images'
import type { MdBlock, MdInline } from '../lib/md'
import { MAX_PARSE, parseMd, sanitizeHref } from '../lib/md'
import { astToMd } from '../lib/mdSerialize'
import { beginUpdateBlock, useUpdateBlocker } from '../lib/updateSafety'
import { P } from '../store/planner'
import type { PMNode } from './descDoc'
import { astToDoc, docToAst } from './descDoc'
import { copyImage, downloadImage, openImageFull, toast } from './imgActions'
import { Markdown } from './markdown'
import { mentionSuggestion } from './mentionSuggestion'
import { Icon } from './qivo'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl+'

/* A copy from the read-only rendered view carries the 5-minute signed URL,
   not the att: pseudo-src — normalize it back so ownership rules (and
   permanence) apply instead of baking an expiring token into the text. */
const SIGNED_ATT = /\/storage\/v1\/object\/sign\/attachments\/[0-9a-f-]{36}\/([0-9a-f-]{36})\//
const normalizeImgSrc = (src: string) => {
  const m = SIGNED_ATT.exec(src)
  return m ? `att:${m[1]}` : src
}
/** True when this issue may NOT keep a pasted image reference: it neither
    owns it (committed text) nor uploaded it this session. */
const srcForeign = (src: string, committed: string, session: string[]) => {
  if (src.startsWith('uploading:')) return true
  const attId = src.startsWith('att:') ? src.slice(4) : null
  return !!attId && !committed.includes(attId) && !session.includes(attId)
}

/* Same ownership rules for the plain-text markdown paste path, which goes
   through parseMd → insertContent and never reaches transformPasted. */
function filterForeignInline(
  nodes: MdInline[],
  committed: string,
  session: string[],
  flag: { stripped: boolean },
): MdInline[] {
  return nodes.map((n): MdInline => {
    if (n.t === 'image') {
      const src = normalizeImgSrc(n.src)
      if (srcForeign(src, committed, session)) {
        flag.stripped = true
        return { t: 'text', text: ' ' }
      }
      return src === n.src ? n : { ...n, src }
    }
    if ('children' in n)
      return { ...n, children: filterForeignInline(n.children, committed, session, flag) }
    return n
  })
}
function stripForeignImages(
  blocks: MdBlock[],
  committed: string,
  session: string[],
): { blocks: MdBlock[]; stripped: boolean } {
  const flag = { stripped: false }
  const out = blocks.map((b): MdBlock => {
    if (b.t === 'p' || b.t === 'h' || b.t === 'quote')
      return { ...b, children: filterForeignInline(b.children, committed, session, flag) }
    if (b.t === 'ul' || b.t === 'ol')
      return { ...b, items: b.items.map((it) => filterForeignInline(it, committed, session, flag)) }
    return b
  })
  return { blocks: out, stripped: flag.stripped }
}

const canonical = (text: string) => astToMd(parseMd(text))
/** Commit form: canonical AND a parse fixpoint (one extra parse catches the
    cases docToAst can't know about, e.g. bare URLs autolinking on reparse).
    Past the parse cap the re-parse would hit parseMd's literal fallback and
    re-escape everything — the single-pass form is already safe to store, and
    the next load renders it read-only behind the MAX_PARSE guard. */
const serialize = (editor: Editor) => {
  const md = astToMd(docToAst(editor.getJSON() as PMNode))
  return md.length > MAX_PARSE ? md : canonical(md)
}

/* An upload can outlive the editor that started it (commit-on-blur
   mid-flight), and the user may have re-opened the issue — completions
   route through whichever live editor owns the issue now, falling back to
   patching the committed text. */
const liveEditors = new Map<
  string,
  (src: string, repl: { attId: string; alt: string } | null) => boolean
>()

function finishUpload(issueKey: string, src: string, attId: string | null, alt: string) {
  const live = liveEditors.get(issueKey)
  const inDraft = live ? live(src, attId ? { attId, alt } : null) : false
  const token = `![Uploading image…](${src})`
  const it = P.issueById[issueKey]
  const committed = !!it && typeof it.description === 'string' && it.description.includes(token)
  if (committed) {
    const replacement = attId ? `![${alt}](att:${attId})` : ''
    P.updateIssue(issueKey, {
      description: it.description.split(token).join(replacement).trim() || null,
    })
  }
  // gone from both draft and committed text: the paste was discarded before
  // the upload landed — drop the attachment again
  if (!inDraft && !committed && attId) P.removeAttachment(attId)
}

/* ---- image node view ------------------------------------------------------ */

function ImageView({ node, selected }: NodeViewProps) {
  const src = String(node.attrs.src || '')
  const alt = String(node.attrs.alt || '')
  const attId = src.startsWith('att:') ? src.slice(4) : null
  const uploading = src.startsWith('uploading:')
  const external = !attId && !uploading ? sanitizeHref(src) : null
  const [url, setUrl] = useState<string | null>(external)
  const [gone, setGone] = useState(!attId && !uploading && !external)
  const retried = useRef(false)

  useEffect(() => {
    let alive = true
    if (attId) {
      setGone(false)
      setUrl(null)
      retried.current = false
      void P.attachmentUrl(attId).then((u) => {
        if (alive) {
          u ? setUrl(u) : setGone(true)
        }
      })
    }
    return () => {
      alive = false
    }
  }, [attId])

  const cls = `mdimgwrap${selected ? ' ProseMirror-selectednode' : ''}`
  if (uploading) {
    return (
      <NodeViewWrapper as="span" className={cls} contentEditable={false}>
        <span className="mdimgph">
          <Icon name="paperclip" size={16} />
          Uploading image…
        </span>
      </NodeViewWrapper>
    )
  }
  if (gone) {
    return (
      <NodeViewWrapper as="span" className={cls} contentEditable={false}>
        <HoverTooltip content={alt}>
          <span className="mdimgph">
            <Icon name="blocked" size={16} />
            Image unavailable
          </span>
        </HoverTooltip>
      </NodeViewWrapper>
    )
  }
  if (!url) {
    return (
      <NodeViewWrapper as="span" className={cls} contentEditable={false}>
        <span className="mdimgph">Loading image…</span>
      </NodeViewWrapper>
    )
  }
  const freshUrl = async () => (attId ? await P.attachmentUrl(attId) : url)
  const swallow = (e: React.MouseEvent) => e.preventDefault() // keep focus in the editor
  return (
    <NodeViewWrapper
      as="span"
      className={cls}
      contentEditable={false}
      data-att={attId || undefined}
    >
      <HoverTooltip content={alt}>
        <img
          className="mdimg"
          src={url}
          alt={alt}
          onDoubleClick={() => void openImageFull(freshUrl)}
          onError={() => {
            // minted URLs live ~10 minutes; a late load gets one fresh URL retry
            if (attId && !retried.current) {
              retried.current = true
              void P.attachmentUrl(attId).then((u) => (u ? setUrl(u) : setGone(true)))
            } else setGone(true)
          }}
        />
      </HoverTooltip>
      <span className="mdimgbtns" onMouseDown={swallow}>
        <Button
          type="button"
          className="mdimgbtn"
          title="Copy image"
          aria-label="Copy image"
          onClick={() => void copyImage(freshUrl)}
          variant="unstyled"
        >
          <Icon name="copy" size={16} />
        </Button>
        <Button
          type="button"
          className="mdimgbtn"
          title="Download image"
          aria-label="Download image"
          onClick={() => void downloadImage(attId, url)}
          variant="unstyled"
        >
          <Icon name="download" size={16} />
        </Button>
      </span>
    </NodeViewWrapper>
  )
}

/* ---- editor --------------------------------------------------------------- */

type LinkPop =
  // create-mode `href` carries the existing URL when Edit re-opens a view pop
  | { mode: 'create'; x: number; y: number; withText: boolean; href?: string }
  | { mode: 'view'; x: number; y: number; href: string }

export type DescEditorHandle = {
  getText: () => string
  focus: () => void
}

/** Comment mode: commit goes to onCommit (the store's add/updateComment),
    not the issue description. `label` is the primary button ("Comment" for
    the composer, "Save" for edit-in-place); `reset` clears the doc after a
    commit (composer); `onDiscard` lets edit-in-place close on Esc/Discard. */
export type CommentMode = {
  onCommit: (text: string) => void
  onDiscard?: () => void
  label: string
  reset?: boolean
}

type DescEditorProps = {
  issueKey: string | null
  /* which organization this text belongs to (0081): the @-mention picker
     must offer that org`s people — the server only delivers a mention to a
     recipient inside the task`s own org, so a foreign name would render as a
     mention and notify nobody. Defaults to the home organization. */
  org?: string
  value: string
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  comment?: CommentMode
}

const DescEditorInner = forwardRef<DescEditorHandle, DescEditorProps>(function DescEditorInner(
  { issueKey, org, value, placeholder, ariaLabel, autoFocus, comment },
  refHandle,
) {
  // mode never flips on a live instance (the composer/edit editors always
  // mount with it) — safe to capture for the editorProps closures below
  const isComment = !!comment
  const commentRef = useRef(comment)
  commentRef.current = comment
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const rawRef = useRef(value) // committed text, prop form
  const canonRef = useRef(canonical(value)) // its canonical bytes (commit compare)
  const sessionUploadsRef = useRef<string[]>([])
  const [linkPop, setLinkPop] = useState<LinkPop | null>(null)
  const [headMenu, setHeadMenu] = useState(false)
  const [dirty, setDirty] = useState(false)
  useUpdateBlocker(dirty || linkPop?.mode === 'create')
  const dirtyRef = useRef(false)
  const linkUrlRef = useRef<HTMLInputElement | null>(null)
  const linkTextRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const linkPopRef = useRef<LinkPop | null>(null)
  linkPopRef.current = linkPop

  // dirty ⇢ the Save/Discard bar; recomputed on every doc change and after
  // every committed-refs move (commit, revert, echo reconciliation). The
  // compare is doc.eq against the committed doc — cheap enough to run per
  // keystroke, unlike a full serialize round-trip — so a doc that differs
  // structurally but serializes identically still shows the bar; commit then
  // just realigns the baseline without writing.
  const committedDocRef = useRef<PMDocNode | null>(null)
  const refreshDirty = () => {
    const ed = editorRef.current
    const base = committedDocRef.current
    const d = !!ed && !ed.isDestroyed && !!base && !ed.state.doc.eq(base)
    dirtyRef.current = d
    setDirty(d)
  }
  const refreshDirtyRef = useRef(refreshDirty)
  refreshDirtyRef.current = refreshDirty

  const openLinkPopover = () => {
    const editor = editorRef.current
    if (!editor) return false
    const { state, view } = editor
    // VIEWPORT coordinates: the popover is portaled to <body> and fixed, so it
    // is no longer measured against the wrapper — and no longer clipped by the
    // field's own scroll box. The permanent Link button makes the empty-
    // selection branch (URL + Text) the common case, and that is exactly the
    // one an absolutely positioned pop inside a 72px-floor field could not fit.
    // The height branches on MODE, not on selection.empty: a caret inside an
    // existing link is 'view' WITH an empty selection.
    const coords = view.coordsAtPos(state.selection.head)
    const viewing = editor.isActive('link')
    const h = !viewing && state.selection.empty ? 82 : 46
    const x = Math.max(8, Math.min(coords.left, window.innerWidth - 254))
    const y = Math.min(coords.bottom + 6, window.innerHeight - 8 - h)
    if (viewing) {
      setLinkPop({ mode: 'view', x, y, href: String(editor.getAttributes('link').href || '') })
    } else {
      setLinkPop({ mode: 'create', x, y, withText: state.selection.empty })
    }
    return true // Mod-K's binding: a falsy return un-consumes the key
  }
  const openLinkPopoverRef = useRef(openLinkPopover)
  openLinkPopoverRef.current = openLinkPopover
  const commitRef = useRef<() => void>(() => {}) // assigned below commit()

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      Gapcursor,
      Dropcursor.configure({ color: 'var(--primary)', width: 2 }),
      Placeholder.configure({
        placeholder: placeholder || '',
      }),
      Heading.configure({ levels: [1, 2, 3] }),
      Blockquote.extend({
        content: 'paragraph', // the dialect quote is one inline run with breaks
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              const editor = this.editor
              const { $from, empty } = editor.state.selection
              if (!empty || $from.depth < 2 || $from.node(-1).type.name !== 'blockquote')
                return false
              const nb = $from.nodeBefore
              const atEnd = $from.parentOffset === $from.parent.content.size
              if (atEnd && nb && nb.type.name === 'hardBreak') {
                // Enter on an empty trailing quote line exits the quote
                return editor.commands.command(({ tr, state }) => {
                  const brFrom = $from.pos - nb.nodeSize
                  const after = $from.after(-1) - nb.nodeSize
                  tr.delete(brFrom, $from.pos)
                  tr.insert(after, state.schema.nodes.paragraph.create())
                  tr.setSelection(TextSelection.create(tr.doc, after + 1))
                  return true
                })
              }
              return editor.commands.setHardBreak()
            },
          }
        },
      }),
      BulletList,
      OrderedList,
      ListItem.extend({
        content: 'paragraph', // single-paragraph items, and no Tab: no nesting
        addKeyboardShortcuts() {
          return { Enter: () => this.editor.commands.splitListItem(this.name) }
        },
      }),
      CodeBlock, // the dialect fence keeps no language; docToAst drops the attr
      HardBreak.extend({
        addKeyboardShortcuts() {
          const guarded = () => {
            const { $from } = this.editor.state.selection
            for (let d = $from.depth; d > 0; d--) {
              const name = $from.node(d).type.name
              // per-line parse contexts: a break here would split the block on
              // reload, so it is a no-op
              if (name === 'heading' || name === 'listItem') return true
            }
            return this.editor.commands.setHardBreak()
          }
          return { 'Shift-Enter': guarded, 'Mod-Enter': guarded }
        },
      }),
      Bold.extend({
        // dialect has no underscore emphasis (snake_case is everywhere)
        addInputRules() {
          return [markInputRule({ find: boldStar, type: this.type })]
        },
        addPasteRules() {
          return []
        },
      }),
      Italic.extend({
        addInputRules() {
          return [markInputRule({ find: italicStar, type: this.type })]
        },
        addPasteRules() {
          return []
        },
      }),
      Strike,
      Code,
      Underline.extend({
        addInputRules() {
          return [
            markInputRule({ find: /(?:^|\s)(\+\+(?!\s)((?:[^+]+))(?!\s)\+\+)$/, type: this.type }),
          ]
        },
      }),
      Link.configure({
        autolink: false, // linkify bare domains never; the input rule below handles http(s)
        openOnClick: false,
        linkOnPaste: false,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      Image.extend({
        inline: true, // the dialect image is inline content
        group: 'inline',
        parseHTML() {
          // the fallback rendering below emits att:/uploading: images with NO
          // src attribute — without this second rule they'd vanish from
          // clipboard HTML round-trips
          return [{ tag: 'img[src]:not([src^="data:"])' }, { tag: 'img[data-qivo-src]' }]
        },
        addAttributes() {
          const parent: Attributes = this.parent?.() || {}
          return {
            ...parent,
            src: {
              ...parent.src,
              // round-trips the fallback rendering below (and clipboard HTML)
              parseHTML: (el: HTMLElement) =>
                el.getAttribute('data-qivo-src') || el.getAttribute('src'),
            },
          }
        },
        renderHTML({ HTMLAttributes }) {
          // ProseMirror falls back to this before the React node view attaches
          // (and for clipboard serialization); a raw att:/uploading: src would
          // hit the network as an unknown scheme, so park it in a data attr
          const src = String(HTMLAttributes.src || '')
          if (/^(att|uploading):/.test(src)) {
            return ['img', { ...HTMLAttributes, src: undefined, 'data-qivo-src': src }]
          }
          return ['img', HTMLAttributes]
        },
        addNodeView() {
          return ReactNodeViewRenderer(ImageView, {
            className: 'mdimgnv',
            stopEvent: ({ event }) => {
              const t = event.target as HTMLElement | null
              return !!t?.closest?.('button')
            },
          })
        },
      }),
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        deleteTriggerWithBackspace: true,
        suggestion: mentionSuggestion,
      }),
      Extension.create({
        name: 'descKeys',
        addKeyboardShortcuts() {
          return {
            'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
            'Mod-k': () => openLinkPopoverRef.current(),
            'Mod-s': () => {
              commitRef.current()
              return true
            }, // ours, not the browser save dialog
          }
        },
      }),
    ],
    [placeholder],
  )

  const initialDoc = useMemo(() => astToDoc(parseMd(rawRef.current)), []) // eslint-disable-line

  // test hook: scripts/verify-md.mjs drives selections through PM commands
  // (synthetic DOM selection doesn't reliably reach PM before the next event).
  // v3 THROWS on .view before EditorContent mounts it, and a cold deep-link
  // load can flush a store-emit re-render in that window (watchComments) —
  // skip; this deps-less effect re-runs on the next render anyway.
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    try {
      ;(ed.view.dom as HTMLElement & { qivoEditor?: Editor }).qivoEditor = ed
    } catch {
      /* view not mounted yet */
    }
  })

  const editor = useEditor(
    {
      extensions,
      content: initialDoc,
      // edit-in-place opens with the caret at the end (mockup contract);
      // TipTap sequences this against its own deferred view mount
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'md',
          role: 'textbox',
          'aria-multiline': 'true',
          // read back by the mention suggestion, which has no React context
          'data-qivo-org': org || P.homeOrg || '',
          'aria-label': ariaLabel || 'Task description',
        },
        // autolink when a space completes an http(s) token — boundaries per
        // md.ts autolink rules (preceding non-word char, no stop chars).
        // Returning false lets the space insert normally.
        handleTextInput: (view, from, _to, text) => {
          if (text !== ' ') return false
          const { state } = view
          const $from = state.doc.resolve(from)
          if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false
          const before = state.doc.textBetween($from.start(), from, '￼', '￼')
          const m = /(?:^|[^\w])(https?:\/\/[^\s<>"')\]]{2,})$/.exec(before)
          if (!m) return false
          const urlFrom = from - m[1].length
          const linkType = state.schema.marks.link
          if (state.doc.rangeHasMark(urlFrom, from, linkType)) return false
          view.dispatch(state.tr.addMark(urlFrom, from, linkType.create({ href: m[1] })))
          return false
        },
        handlePaste: (view, event) => {
          const files = Array.from(event.clipboardData?.files || []).filter((f) =>
            f.type.startsWith('image/'),
          )
          if (files.length) {
            event.preventDefault()
            addImagesRef.current(files)
            return true
          }
          const text = event.clipboardData?.getData('text/plain') || ''
          const hasHtml = !!event.clipboardData?.getData('text/html')
          if (!text || hasHtml) return false // rich HTML paste → parseDOM rules
          const url = text.trim()
          if (/^https?:\/\/\S+$/.test(url) && !view.state.selection.empty) {
            editorRef.current?.chain().focus().setLink({ href: url }).run()
            return true
          }
          const parsed = parseMd(text)
          const plain =
            parsed.length === 1 &&
            parsed[0].t === 'p' &&
            parsed[0].children.every((n) => n.t === 'text')
          if (plain) return false // nothing markdown about it — default insert
          // comments are text-only: the ownership baseline is empty, so EVERY
          // att:/uploading: image strips (a comment body that happens to
          // contain an attachment uuid as text must not launder a reference in)
          const { blocks, stripped } = stripForeignImages(
            parsed,
            isComment ? '' : rawRef.current,
            isComment ? [] : sessionUploadsRef.current,
          )
          if (stripped)
            setTimeout(
              () =>
                toast(
                  isComment
                    ? 'Attach images to the task instead of the comment.'
                    : 'Upload the image to this task before adding it here.',
                ),
              0,
            )
          editorRef.current
            ?.chain()
            .focus()
            .insertContent(astToDoc(blocks).content || [])
            .run()
          return true
        },
        handleDrop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
            f.type.startsWith('image/'),
          )
          if (!files.length) return false
          event.preventDefault()
          addImagesRef.current(files)
          return true
        },
        handleClick: (_view, pos, event) => {
          if (!(event.ctrlKey || event.metaKey)) return false
          const editor2 = editorRef.current
          if (!editor2) return false
          const $pos = editor2.state.doc.resolve(pos)
          const link =
            $pos.marks().find((m) => m.type.name === 'link') ||
            (editor2.state.doc.nodeAt(pos)?.marks || []).find((m) => m.type.name === 'link')
          const href = link && sanitizeHref(String(link.attrs.href || ''))
          if (!href) return false
          window.open(href, '_blank', 'noopener')
          return true
        },
        transformPasted: (slice) => {
          // an att: image pasted from another issue would die with that
          // issue's GC — strip it (uploading: placeholders are meaningless
          // outside their source editor too); signed-URL srcs from a copy of
          // the rendered view normalize back to att: first. Comment mode owns
          // nothing: empty baseline, so every image reference strips.
          const committed = isComment ? '' : rawRef.current
          const session = isComment ? [] : sessionUploadsRef.current
          let stripped = false
          let changed = false
          const filter = (fragment: Fragment): Fragment => {
            const nodes: PMDocNode[] = []
            fragment.forEach((node) => {
              if (node.type.name === 'image') {
                const raw = String(node.attrs.src || '')
                const src = normalizeImgSrc(raw)
                if (srcForeign(src, committed, session)) {
                  stripped = true
                  // a space placeholder keeps the slice's open depths valid
                  nodes.push(node.type.schema.text(' '))
                  return
                }
                if (src !== raw) {
                  changed = true
                  nodes.push(node.type.create({ ...node.attrs, src }, null, node.marks))
                  return
                }
              }
              nodes.push(node.copy(filter(node.content)))
            })
            return Fragment.fromArray(nodes)
          }
          const content = filter(slice.content)
          if (!stripped && !changed) return slice
          if (stripped)
            setTimeout(
              () =>
                toast(
                  isComment
                    ? 'Attach images to the task instead of the comment.'
                    : 'Upload the image to this task before adding it here.',
                ),
              0,
            )
          return new Slice(content, slice.openStart, slice.openEnd)
        },
      },
    },
    [issueKey],
  )
  editorRef.current = editor
  if (editor && !committedDocRef.current) committedDocRef.current = editor.state.doc

  /* ---- committed-text plumbing ------------------------------------------- */

  const reapSessionUploads = () => {
    // Draft-only uploads die with their draft (revert, unmount).
    // Ids that ever reached committed text are pruned at commit/reconcile
    // time and belong to the store's description GC from then on — but a
    // held echo can leave rawRef behind the store (finishUpload patches the
    // committed row mid-draft), so check BOTH texts before deleting anything.
    const it = issueKey !== null ? P.issueById[issueKey] : null
    const storeDesc = it && typeof it.description === 'string' ? it.description : ''
    sessionUploadsRef.current = sessionUploadsRef.current.filter((id) => {
      if (!rawRef.current.includes(id) && !storeDesc.includes(id)) P.removeAttachment(id)
      return false
    })
  }
  const reapRef = useRef(reapSessionUploads)
  reapRef.current = reapSessionUploads

  const setDocFromText = (ed: Editor, text: string) => {
    // a fresh EditorState resets plugin state — undo history included, so
    // redo can't resurrect nodes whose attachments a revert just reaped
    const doc = ed.schema.nodeFromJSON(astToDoc(parseMd(text)))
    ed.view.updateState(EditorState.create({ doc, plugins: ed.state.plugins }))
    committedDocRef.current = ed.state.doc
  }

  const commit = () => {
    const ed = editorRef.current
    if (!ed) return
    const cm = commentRef.current
    if (cm) {
      const text = serialize(ed)
      if (!text.trim()) return // an empty comment isn't a thing — Discard is the way out
      if (text.length > MAX_PARSE) {
        // past the parse cap the stored form couldn't be re-edited safely
        // (the outer guard renders read-only) — refuse instead of trapping
        toast('Comment too long. Shorten it to save.')
        return
      }
      cm.onCommit(text) // the store no-ops a same-body save; still exits edit mode
      if (cm.reset) {
        // composer: posting clears the field for the next comment
        rawRef.current = ''
        canonRef.current = ''
        setDocFromText(ed, '')
        refreshDirty()
        ed.commands.focus()
      } else {
        // edit-in-place: the save is the new baseline (the parent unmounts
        // this editor on its own; a clean doc keeps the unmount silent)
        rawRef.current = text
        canonRef.current = text
        committedDocRef.current = ed.state.doc
        refreshDirty()
      }
      return
    }
    if (issueKey === null) return
    const text = serialize(ed)
    if (text !== canonRef.current) {
      // no-op otherwise (undo-back-to-original too)
      rawRef.current = text
      canonRef.current = text
      // ids entering committed text are the store's from here on — its
      // description GC decides their lifetime, never this editor's reap
      sessionUploadsRef.current = sessionUploadsRef.current.filter((id) => !text.includes(id))
      P.updateIssue(issueKey, { description: text || null })
    }
    // the save is the new baseline; undo may cross it freely — the store GC
    // keeps the just-replaced text's images for one more save, so an att:
    // node resurrected right away still has its attachment (undoing across
    // OLDER saves can surface "Image unavailable" — acceptable, and visible
    // for what it is). No state reset: it would also yank the caret to the
    // doc start under a focused Mod-S.
    committedDocRef.current = ed.state.doc
    refreshDirty()
  }
  commitRef.current = commit

  const revert = () => {
    const ed = editorRef.current
    if (!ed) return
    // the echo effect may have held (focused + dirty) while finishUpload
    // advanced the committed row — revert to the store's truth, not the refs
    if (commentRef.current) {
      // comment truth is the value prop (held echoes included — the parent
      // re-renders it from the store, this editor may just not have applied it)
      const latest = valueRef.current
      rawRef.current = latest
      canonRef.current = canonical(latest)
    } else if (issueKey !== null) {
      const it = P.issueById[issueKey]
      const latest = it && typeof it.description === 'string' ? it.description : ''
      rawRef.current = latest
      canonRef.current = canonical(latest)
    }
    setDocFromText(ed, rawRef.current)
    reapSessionUploads()
    refreshDirty()
    ed.commands.blur()
    const cm = commentRef.current
    if (cm?.onDiscard) cm.onDiscard() // edit-in-place closes on discard
  }

  useImperativeHandle(
    refHandle,
    () => ({
      getText: () => (editorRef.current ? serialize(editorRef.current) : rawRef.current),
      focus: () => {
        editorRef.current?.commands.focus('end')
      },
    }),
    [],
  ) // eslint-disable-line

  /* Reconcile the doc with the latest committed prop. A held echo must land
     as soon as holding it stops being justified, so this runs on prop
     echoes, on focus leaving the editor, and when an undo turns the draft
     clean again — not just on prop changes. */
  const valueRef = useRef(value)
  valueRef.current = value
  const reconcile = () => {
    const ed = editorRef.current
    const val = valueRef.current
    if (!ed || ed.isDestroyed || val === rawRef.current) return
    const canon = canonical(val)
    if (serialize(ed) === canon) {
      // doc already matches (finishUpload patched both sides) — just advance
      rawRef.current = val
      canonRef.current = canon
      committedDocRef.current = ed.state.doc
      sessionUploadsRef.current = sessionUploadsRef.current.filter((id) => !val.includes(id))
      refreshDirty()
      return
    }
    if (ed.isFocused || serialize(ed) !== canonRef.current) return // an open draft wins (last writer)
    setDocFromText(ed, val)
    rawRef.current = val
    canonRef.current = canon
    sessionUploadsRef.current = sessionUploadsRef.current.filter((id) => !val.includes(id))
    refreshDirty()
  }
  const reconcileRef = useRef(reconcile)
  reconcileRef.current = reconcile

  // remote echo reconciliation — the editor no longer unmounts on updates
  useEffect(() => {
    reconcileRef.current()
  }, [value, editor])

  /* A growing field must not push its own bottom out of the pane.
     The composer is the LAST thing inside the task window's spine scroller
     (deviation #71 — the box comes up to the conversation), so every line you
     add makes that scroller taller and slides the field's floor — the caret,
     and the Save bar under it — below the visible edge. You then had to
     scroll the pane by hand to see what you were typing.
     Only ever when it is actually cut off (`over > 0`), so reading back up
     the thread mid-draft is never yanked away, and only the overflow plus a
     small margin, never a scroll-to-bottom: the point is to keep the floor
     just in view, not to take the scroller somewhere. Inside a capped field
     the text is its own scroll box between the two rows (.mdscroll) and
     ProseMirror keeps the caret in view there itself: nothing is painted over
     that box, so what it can scroll to is exactly what is visible. */
  const keepFloorInView = () => {
    const el = wrapRef.current
    if (!el) return
    const box = (el.closest('.descfield, .mdeditfield') as HTMLElement | null) || el
    // the nearest scrolling ancestor ABOVE the field — the text's own scroll
    // is internal and ProseMirror's
    let n = box.parentElement
    while (n) {
      const oy = getComputedStyle(n).overflowY
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) break
      n = n.parentElement
    }
    if (!n) return
    const over = box.getBoundingClientRect().bottom - n.getBoundingClientRect().bottom
    if (over > 0) n.scrollTop += over + 8
  }
  const keepFloorRef = useRef(keepFloorInView)
  keepFloorRef.current = keepFloorInView

  // the Save/Discard bar tracks every doc change (typing, node-view patches);
  // a change landing back on the committed doc (undo) may unblock a held echo
  useEffect(() => {
    if (!editor) return
    const onUpd = () => {
      refreshDirtyRef.current()
      if (!dirtyRef.current) reconcileRef.current()
      // after the browser has laid the new line out, not before it
      if (editor.isFocused) requestAnimationFrame(() => keepFloorRef.current())
    }
    editor.on('update', onUpd)
    return () => {
      editor.off('update', onUpd)
    }
  }, [editor])

  // caret inside a link opens the destination popover (Open/Edit/Remove);
  // it closes itself as soon as the selection leaves the link
  useEffect(() => {
    if (!editor) return
    const onSel = () => {
      const pop = linkPopRef.current
      if (editor.state.selection.empty && editor.isFocused && editor.isActive('link')) {
        if (!pop) openLinkPopoverRef.current()
      } else if (pop) {
        // any selection movement dismisses a stale popover (typing in its
        // inputs never touches the PM selection, so it stays while in use)
        setLinkPop(null)
      }
    }
    editor.on('selectionUpdate', onSel)
    return () => {
      editor.off('selectionUpdate', onSel)
    }
  }, [editor])

  // A fixed popover does not travel with its anchor, so close it rather than
  // leave it stranded pointing at nothing — the same answer AnchoredPop gives.
  // Capture phase, or the inner scrollers (the field itself, the spine, a
  // modal body) never reach the listener: scroll does not bubble.
  useEffect(() => {
    if (!linkPop) return
    const close = () => setLinkPop(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [linkPop])

  // upload completion routing + discard-reap on unmount / issue switch
  useEffect(() => {
    const ed = editor
    if (!ed || issueKey === null) return
    const entry = (src: string, repl: { attId: string; alt: string } | null): boolean => {
      let found: { pos: number; attrs: Record<string, unknown>; size: number } | null = null
      ed.state.doc.descendants((node, pos) => {
        if (found) return false
        if (node.type.name === 'image' && node.attrs.src === src) {
          found = { pos, attrs: node.attrs, size: node.nodeSize }
          return false
        }
        return true
      })
      if (!found) return false
      const f = found as { pos: number; attrs: Record<string, unknown>; size: number }
      const tr = ed.state.tr
      if (repl)
        tr.setNodeMarkup(f.pos, undefined, { ...f.attrs, src: `att:${repl.attId}`, alt: repl.alt })
      else tr.delete(f.pos, f.pos + f.size)
      ed.view.dispatch(tr)
      return true
    }
    liveEditors.set(issueKey, entry)
    return () => {
      if (liveEditors.get(issueKey) === entry) liveEditors.delete(issueKey)
      // an unmount (modal closed, issue deleted remotely) drops any unsaved
      // draft — say so, since only the Save button persists now
      if (dirtyRef.current) toast('Unsaved description changes discarded')
      reapRef.current()
    }
  }, [issueKey, editor])

  // comment mode has no upload plumbing, but the same unmount contract: a
  // dirty draft (typed composer, half-edited comment) dies with the editor
  // (modal closed, comment deleted remotely) — say so
  useEffect(() => {
    if (!isComment) return
    return () => {
      if (dirtyRef.current) toast('Unsaved comment discarded')
    }
  }, [isComment])

  /* ---- images -------------------------------------------------------------- */

  const addImages = (files: File[]) => {
    const ed = editorRef.current
    if (!ed) return
    if (isComment) {
      toast('Attach images to the task instead of the comment.')
      return
    }
    if (issueKey === null) {
      toast('Create the task before adding images.')
      return
    }
    // One at a time. Every placeholder is inserted up front (below) so the
    // document looks right immediately, but the decodes are chained: eight
    // 12 MP phone photos dropped together would otherwise hold eight
    // full-resolution bitmaps AND eight canvas backing stores live at once —
    // hundreds of MB — and land eight drawImage calls on the main thread back
    // to back. On a constrained tab those decodes fail, which silently falls
    // back to uploading the originals: the feature defeating itself.
    // Uploads can outlive the editor. Hold through compression, queued files,
    // and each completion's description patch, even after it unmounts.
    const releaseUpdate = beginUpdateBlock()
    let queue: Promise<unknown> = Promise.resolve()
    for (const f of files) {
      const src = `uploading:${crypto.randomUUID().slice(0, 8)}`
      ed.chain()
        .focus()
        .insertContent({ type: 'image', attrs: { src, alt: 'Uploading image…' } })
        .run()
      // the placeholder goes in FIRST: re-encoding a large paste takes a
      // moment and the caret should not wait on it. Naming happens after, so
      // the name and the alt text describe the file that is actually stored
      // (a pasted PNG leaves here as .webp) rather than the clipboard's.
      queue = queue
        .then(() => compressImage(f))
        .then((c) => {
          // clipboard images are all called "image.png" — give them a real name
          const generic = !c.name || /^image\.\w+$/i.test(c.name)
          const ext = (c.type.split('/')[1] || 'png').replace(/[^\w]/g, '')
          const name = generic
            ? `pasted-image-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`
            : c.name
          const file = generic ? new File([c], name, { type: c.type }) : c
          const alt = name.replace(/[[\]()\n\\]/g, '_')
          return P.addAttachment(issueKey, file, { inline: true }).then(
            (attId: string | null) => {
              if (attId) sessionUploadsRef.current.push(attId)
              finishUpload(issueKey, src, attId, alt)
              // finishUpload(null) is the existing "this one didn't make it" path;
              // reaching it matters more than the reason
            },
            () => finishUpload(issueKey, src, null, alt),
          )
          // and one image failing must never strand the rest of the queue
        })
        .catch(() => {})
    }
    void queue.finally(releaseUpdate)
  }
  const addImagesRef = useRef(addImages)
  addImagesRef.current = addImages

  /* ---- focus / keys ---------------------------------------------------------- */

  const onFocusOut = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (next && wrapRef.current?.contains(next)) return
    // the link popover is portaled to <body> to escape the field's overflow
    // clip, and its URL input deliberately TAKES focus — containment against
    // the wrapper alone would read that as a focus-out and close the popover
    // the instant it opened
    if (next instanceof Element && next.closest('[data-mdpop]')) return
    // popovers close with focus; the draft itself stays until Save/Discard
    setHeadMenu(false)
    setLinkPop(null)
    reconcile() // a clean editor catches up with any echo held while focused
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || hasOpenTooltip()) return
    const ed = editorRef.current
    if (linkPopRef.current) {
      e.preventDefault()
      e.stopPropagation()
      setLinkPop(null)
      ed?.commands.focus()
      return
    }
    if (headMenu) {
      e.preventDefault()
      e.stopPropagation()
      setHeadMenu(false)
      return
    }
    if (ed && dirtyRef.current) {
      e.preventDefault()
      e.stopPropagation()
      revert()
      return
    }
    const cm = commentRef.current
    if (cm?.onDiscard) {
      // edit-in-place: Esc exits edit mode even when clean — the modal only
      // closes from the read view
      e.preventDefault()
      e.stopPropagation()
      revert()
      return
    }
    ed?.commands.blur() // clean: let it bubble; the modal closes
  }

  /* ---- formatting toolbar ---------------------------------------------------- */

  const active = useEditorState({
    editor,
    selector: (ctx) => {
      const ed = ctx.editor
      if (!ed) return null
      return {
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        strike: ed.isActive('strike'),
        underline: ed.isActive('underline'),
        code: ed.isActive('code'),
        link: ed.isActive('link'),
        quote: ed.isActive('blockquote'),
        ul: ed.isActive('bulletList'),
        ol: ed.isActive('orderedList'),
        codeBlock: ed.isActive('codeBlock'),
        h1: ed.isActive('heading', { level: 1 }),
        h2: ed.isActive('heading', { level: 2 }),
        h3: ed.isActive('heading', { level: 3 }),
      }
    },
  })

  const swallow = (e: React.MouseEvent) => e.preventDefault() // keep focus + selection in the editor
  // tabIndex -1: the row is permanent now, and the task window mounts up to
  // three editors — focusable buttons would put ~30 tab stops ahead of the
  // text. Every command already has a keyboard path (Mod-B/I/U/E/K,
  // Mod-Shift-X, and the input rules for headings, quotes, lists, fences), and
  // a button that cannot HOLD focus also cannot strand Escape outside the
  // editor, where ModalShell's capture listener would close the whole draft.
  // The pressed fill moved to CSS keyed on aria-pressed — the same fact the
  // drive asserts — because --surface-3 on a near-black page is exactly the
  // lit-tile look deviation #64 removed.
  const btn = (
    title: string,
    on: boolean | undefined,
    onClick: () => void,
    child: React.ReactNode,
    className = '',
  ) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={`text-text-1 aria-pressed:bg-primary-soft ${className}`}
      title={title}
      aria-label={title}
      aria-pressed={!!on}
      tabIndex={-1}
      onMouseDown={swallow}
      onClick={onClick}
    >
      {child}
    </Button>
  )
  const chain = () => editorRef.current!.chain().focus()
  // Focus FIRST, and through the VIEW rather than the focus command: TipTap's
  // command short-circuits on its own isFocused flag, which reads true while
  // document.activeElement is still <body> — measured, not assumed — so it
  // moves no DOM focus at all. That matters here and nowhere else: with a
  // permanent row the editor may never have been focused, and Escape only
  // reaches this component's ladder when the event TARGET is inside it. Click
  // Aa while the caret is in another task field (mousedown is
  // swallowed, so focus never moves on its own) and Escape would otherwise hit
  // the enclosing window's Escape listener, closing the whole draft.
  const focusEditor = () => editorRef.current?.view.focus()
  const toggleHeadMenu = () => {
    focusEditor()
    setHeadMenu((v) => !v)
  }
  const openLinkFromToolbar = () => {
    focusEditor() // the view-mode popover has no input to take focus for us
    openLinkPopover()
  }
  // "Text" is pressed for a plain paragraph only: a bare !h1 && !h2 && !h3 is
  // also true inside a quote or a list item, and while `active` is still null
  const plainBlock =
    !!active &&
    !active.h1 &&
    !active.h2 &&
    !active.h3 &&
    !active.codeBlock &&
    !active.quote &&
    !active.ul &&
    !active.ol

  const applyLink = () => {
    const ed = editorRef.current
    const url = (linkUrlRef.current?.value || '').trim()
    const pop = linkPopRef.current
    if (!ed || !pop) return
    setLinkPop(null)
    if (!url) {
      ed.commands.focus()
      return
    }
    if (pop.mode === 'view' || !('withText' in pop) || !pop.withText) {
      ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    } else {
      const label = (linkTextRef.current?.value || '').trim() || url
      ed.chain()
        .focus()
        .insertContent({
          type: 'text',
          text: label,
          marks: [{ type: 'link', attrs: { href: url } }],
        })
        .unsetMark('link')
        .run()
    }
  }

  // .mdwrap stacks the three parts — row, text, bar — as a flex column; in a
  // capped field (.descfield-capped) the text (.mdscroll) is the scroll box
  // between the two rows, so neither ever covers a line.
  return (
    <div ref={wrapRef} className="mdwrap" onBlur={onFocusOut} onKeyDown={onKeyDown}>
      {/* The formatting row is permanent and sits above the text — it
          replaced the selection bubble (deviation #71), so it has to work with
          nothing selected at all. It lives INSIDE wrapRef on purpose: onFocusOut
          bails only for a focus target the wrapper contains, and the mousedown
          swallow — on the row itself as well as on each button, so the dead
          space between them cannot collapse the selection either — is what
          keeps the caret alive across a press. It never scrolls with the text:
          in a capped field the text scrolls beneath it in its own box, and in
          an uncapped one (the create dialog, an edited comment) the whole field
          moves with the surrounding scroller. Buttons are grouped so a wrap
          moves a whole cluster down rather than orphaning one glyph. */}
      {editor && (
        <div
          className="mdtoolbar"
          data-mdtoolbar
          role="toolbar"
          aria-label="Formatting"
          onMouseDown={swallow}
        >
          <span className="mdgroup">
            {btn(
              'Text style',
              headMenu || active?.h1 || active?.h2 || active?.h3 || active?.codeBlock,
              toggleHeadMenu,
              <>
                <span className="[font-size:var(--fs-sm)]">Aa</span>
                <Icon name="chevronDown" size={12} />
              </>,
              'w-auto gap-1 px-1.5',
            )}
          </span>
          <span className="mdgroup">
            {btn(`Bold (${MOD}B)`, active?.bold, () => chain().toggleBold().run(), <b>B</b>)}
            {btn(`Italic (${MOD}I)`, active?.italic, () => chain().toggleItalic().run(), <i>I</i>)}
            {btn(
              `Strikethrough (${MOD}Shift+X)`,
              active?.strike,
              () => chain().toggleStrike().run(),
              <s>S</s>,
            )}
            {btn(
              `Underline (${MOD}U)`,
              active?.underline,
              () => chain().toggleUnderline().run(),
              <u>U</u>,
            )}
          </span>
          <span className="mdgroup">
            {btn(
              `Link (${MOD}K)`,
              active?.link,
              openLinkFromToolbar,
              <Icon name="link" size={16} />,
            )}
            {btn(
              'Quote',
              active?.quote,
              () => chain().toggleBlockquote().run(),
              <span className="[font-size:var(--fs-md)] [font-weight:700] [line-height:10px] [height:10px]">
                ”
              </span>,
            )}
            {btn(
              `Inline code (${MOD}E)`,
              active?.code,
              () => chain().toggleCode().run(),
              <span className="!font-mono [font-size:var(--fs-xs)]">{'</>'}</span>,
            )}
          </span>
          <span className="mdgroup">
            {btn(
              'Bulleted list',
              active?.ul,
              () => chain().toggleBulletList().run(),
              <Icon name="list" size={16} />,
            )}
            {btn(
              'Numbered list',
              active?.ol,
              () => chain().toggleOrderedList().run(),
              <span className="!font-mono [font-size:var(--fs-xs)]">1.</span>,
            )}
          </span>
          {/* the block types open as the row's SECOND LINE, not as a menu:
              flexBasis 100% forces the break, and in flow nothing can clip
              them — an absolutely positioned menu inside a 26vh field is cut
              off in the DEFAULT state, and escaping that would take a portal
              with measured coordinates, a backdrop and a second Escape gate */}
          {headMenu && (
            <span className="mdgroup [flex-basis:100%]">
              {btn(
                'Text',
                plainBlock,
                () => {
                  setHeadMenu(false)
                  chain().setParagraph().run()
                },
                <span className="!font-mono [font-size:var(--fs-xs)]">¶</span>,
              )}
              {btn(
                'Heading 1',
                active?.h1,
                () => {
                  setHeadMenu(false)
                  chain().toggleHeading({ level: 1 }).run()
                },
                <span className="[font-size:var(--fs-sm)] [font-weight:600]">H1</span>,
              )}
              {btn(
                'Heading 2',
                active?.h2,
                () => {
                  setHeadMenu(false)
                  chain().toggleHeading({ level: 2 }).run()
                },
                <span className="[font-size:var(--fs-sm)] [font-weight:600]">H2</span>,
              )}
              {btn(
                'Heading 3',
                active?.h3,
                () => {
                  setHeadMenu(false)
                  chain().toggleHeading({ level: 3 }).run()
                },
                <span className="[font-size:var(--fs-sm)] [font-weight:600]">H3</span>,
              )}
              {btn(
                'Code block',
                active?.codeBlock,
                () => {
                  setHeadMenu(false)
                  chain().toggleCodeBlock().run()
                },
                <span className="!font-mono [font-size:var(--fs-xs)]">{'```'}</span>,
              )}
            </span>
          )}
        </div>
      )}
      <EditorContent editor={editor} className="mdscroll" />
      {/* description + composer: the bar appears when dirty; edit-in-place
          (comment without reset) shows it from the start — Discard is the
          visible way out of edit mode, like the mockup */}
      {(comment && !comment.reset ? true : (isComment || issueKey !== null) && dirty) && (
        <div className="mdactions animate-in fade-in zoom-in-95" data-mdactions>
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm [font-size:var(--fs-sm)]"
            title="Discard changes (Esc)"
            onClick={revert}
          >
            Discard changes
          </Button>
          <Button
            type="button"
            className="h-control-sm [font-size:var(--fs-sm)] [font-weight:600] [background:var(--primary)] [border-color:var(--primary)] [color:#fff]"
            title={comment ? `${comment.label} (${MOD}S)` : `Save description (${MOD}S)`}
            onClick={commit}
          >
            {comment ? comment.label : 'Save'}
          </Button>
        </div>
      )}
      {/* Portaled to <body>, not left in the wrapper: .descfield clips, the
          text's own scroll box (.mdscroll) clips on both axes,
          and the task window's card carries a transform — which would capture
          a position:fixed child left inside it. React still routes events
          through the tree above, so wrapRef's onKeyDown/onBlur keep working,
          and [data-mdpop] rides the portaled node for ModalShell's Escape
          gate to find. */}
      {linkPop &&
        createPortal(
          <div
            className="mdmenu animate-in fade-in zoom-in-95 [min-width:230px] [padding:8px]"
            data-mdpop
            role="dialog"
            aria-label="Link"
            style={{ top: linkPop.y, left: linkPop.x }}
          >
            {linkPop.mode === 'view' ? (
              <div className="[display:flex] [align-items:center] [gap:6px]">
                <HoverTooltip content={linkPop.href}>
                  <span className="[font-size:var(--fs-sm)] [color:var(--text-2)] [max-width:150px] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                    {linkPop.href}
                  </span>
                </HoverTooltip>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="aria-pressed:bg-primary-soft"
                  title="Open link"
                  aria-label="Open link"
                  onMouseDown={swallow}
                  onClick={() => {
                    const href = sanitizeHref(linkPop.href)
                    if (href) window.open(href, '_blank', 'noopener')
                  }}
                >
                  <Icon name="link" size={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="aria-pressed:bg-primary-soft"
                  onMouseDown={swallow}
                  onClick={() => setLinkPop({ ...linkPop, mode: 'create', withText: false })}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="aria-pressed:bg-primary-soft"
                  title="Remove link"
                  aria-label="Remove link"
                  onMouseDown={swallow}
                  onClick={() => {
                    setLinkPop(null)
                    chain().extendMarkRange('link').unsetLink().run()
                  }}
                >
                  <Icon name="close" size={16} />
                </Button>
              </div>
            ) : (
              <div className="[display:flex] [flex-direction:column] [gap:6px]">
                <Input
                  ref={linkUrlRef}
                  autoFocus
                  placeholder="https://…"
                  defaultValue={linkPop.href ?? ''}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyLink()
                    }
                  }}
                  className="h-control-sm w-[220px] border-border-strong bg-surface-2 px-2 py-0 text-sm text-text-1"
                />
                {linkPop.withText && (
                  <Input
                    ref={linkTextRef}
                    placeholder="Text"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyLink()
                      }
                    }}
                    className="h-control-sm w-[220px] border-border-strong bg-surface-2 px-2 py-0 text-sm text-text-1"
                  />
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
})

/** Outer guard: oversized texts render read-only (the parser's literal
    fallback must never round-trip through a commit). */
const DescEditor = forwardRef<DescEditorHandle, DescEditorProps>(function DescEditor(props, ref) {
  if (props.value.length > MAX_PARSE) {
    const onDiscard = props.comment?.onDiscard
    return (
      <div>
        <Markdown text={props.value} />
        <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [margin-top:6px] [font-style:italic]">
          This {props.comment ? 'comment' : 'description'} is too long to edit.
        </div>
        {/* edit-in-place must stay exitable: without this the row is stuck in
            edit mode (its own Edit/Delete buttons hide while editing) */}
        {onDiscard && (
          <div className="[display:flex] [justify-content:flex-end] [margin-top:8px]">
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm [font-size:var(--fs-sm)]"
              onClick={onDiscard}
            >
              Close
            </Button>
          </div>
        )}
      </div>
    )
  }
  return <DescEditorInner {...props} ref={ref} />
})

export default DescEditor
