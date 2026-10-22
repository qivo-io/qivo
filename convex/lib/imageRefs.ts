/* Which attachments a task description names, shared by the server's
 * description saves (model/descriptionImages.ts) and the app's paint of
 * them (src/store/planner.ts). It imports only the description parser, so
 * the app can import it as it does limits.ts.
 *
 * Two readings, for two jobs:
 * - shownImages: the images the app shows, read by the app's own parser
 *   (lib/md.ts), so `att:<uuid>` in prose or code is no image. A save may
 *   add only images of its own task, and this is what it checks.
 * - imageRefs: every `att:<uuid>` anywhere, in any case. An image any of
 *   them names is kept, so a reading that misses an image the app shows
 *   can only keep it, never delete it. */

import { type MdInline, parseMd } from './md'

const ANY_REF_RE = /att:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

/** Every attachment id `text` names as `att:<uuid>`, lowercase. */
export function imageRefs(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(ANY_REF_RE), (m) => m[1].toLowerCase()))
}

/** The attachment ids of the images `text` shows, as the app renders it.
 * Text without any `att:` shows none, and is not parsed. */
export function shownImages(text: string): Set<string> {
  const ids = new Set<string>()
  if (!/att:/i.test(text)) return ids
  const walk = (nodes: readonly MdInline[]) => {
    for (const node of nodes) {
      if (node.t === 'image') {
        const src = node.src.trim()
        if (/^att:/i.test(src)) ids.add(src.slice(4).toLowerCase())
      } else if ('children' in node) walk(node.children)
    }
  }
  for (const block of parseMd(text)) {
    if ('children' in block) walk(block.children)
    else if ('items' in block) for (const item of block.items) walk(item)
  }
  return ids
}
