/* The image node of the description and comment editor (descEditor.tsx):
   how its HTML parses and renders, and what a paste may keep. It holds no
   React and no store, so the tests drive it in a plain TipTap editor; the
   editor adds its React node view and the store's loader. */
import type { Attributes, NodeViewRenderer } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import type { Node as PMDocNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'

/* A copy from the read-only rendered view carries what the image shows,
   not its att: pseudo-src: a placeholder, a blob: URL of the store's
   inline image loader, the gateway's /files/<uuid> URL where the loader
   fell back to it, or the retired signed URL. The view's wrapper names
   the source whatever its body shows (data-qivo-src, components/
   markdown.tsx), and the others normalize back, so ownership rules (and
   permanence) apply instead of baking a URL that ends into the text. */
const SIGNED_ATT = /\/storage\/v1\/object\/sign\/attachments\/[0-9a-f-]{36}\/([0-9a-f-]{36})\//
const GATEWAY_ATT = /\/files\/([0-9a-f]{8}-[0-9a-f-]{27})\?/

/** The source a pasted image keeps: att:<id> for a blob: URL whose
    attachment `shown` names (the loader's attachmentOf) or a gateway or
    signed URL of an attachment, else `src` as it came. */
export function normalizeImgSrc(src: string, shown: (url: string) => string | null): string {
  const attachment = src.startsWith('blob:') ? shown(src) : null
  if (attachment) return `att:${attachment}`
  const m = SIGNED_ATT.exec(src) ?? GATEWAY_ATT.exec(src)
  return m ? `att:${m[1]}` : src
}

/** True when this issue may NOT keep a pasted image reference: it neither
    owns it (committed text) nor uploaded it this session, or it is a
    blob: URL no attachment of this tab's loader shows, whose bytes die
    with the page that made them. */
export function srcForeign(src: string, committed: string, session: string[]): boolean {
  if (src.startsWith('uploading:') || src.startsWith('blob:')) return true
  const attId = src.startsWith('att:') ? src.slice(4) : null
  return !!attId && !committed.includes(attId) && !session.includes(attId)
}

/** A pasted slice's images normalized (normalizeImgSrc) and the foreign
    ones (srcForeign) replaced by a space, with whether any was. `slice`
    comes back unchanged when nothing changed. */
export function filterPastedImages(
  slice: Slice,
  committed: string,
  session: string[],
  shown: (url: string) => string | null,
): { slice: Slice; stripped: boolean } {
  let stripped = false
  let changed = false
  const filter = (fragment: Fragment): Fragment => {
    const nodes: PMDocNode[] = []
    fragment.forEach((node) => {
      if (node.type.name === 'image') {
        const raw = String(node.attrs.src || '')
        const src = normalizeImgSrc(raw, shown)
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
  if (!stripped && !changed) return { slice, stripped }
  return { slice: new Slice(content, slice.openStart, slice.openEnd), stripped }
}

/** The editor's inline image node, with `nodeView` as its view when given.
    It parses a rendered view's wrapper as the image it names, an <img>
    with a src, and the att:/uploading: images it renders itself without
    one. */
export function descImage(nodeView?: () => NodeViewRenderer) {
  return Image.extend({
    inline: true, // the dialect image is inline content
    group: 'inline',
    parseHTML() {
      return [
        // A copy of the read-only view: the wrapper names the image's own
        // source whatever its body shows (a placeholder far from view, a
        // blob: URL or "Image unavailable"). It goes first, and its
        // content, the body and the buttons, is not parsed.
        { tag: 'span.mdimgwrap[data-qivo-src]', priority: 60 },
        // the fallback rendering below emits att:/uploading: images with NO
        // src attribute; without this rule they'd vanish from clipboard
        // HTML round-trips
        { tag: 'img[src]:not([src^="data:"])' },
        { tag: 'img[data-qivo-src]' },
      ]
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
        alt: {
          ...parent.alt,
          // a rendered view's wrapper keeps the alt text beside its source
          parseHTML: (el: HTMLElement) =>
            el.getAttribute('alt') ?? el.getAttribute('data-qivo-alt'),
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
    ...(nodeView ? { addNodeView: nodeView } : {}),
  })
}
