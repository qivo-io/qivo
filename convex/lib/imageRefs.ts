/* Which attachments a task description shows as images, shared by the
 * server's description saves (model/descriptionImages.ts) and the app's
 * paint of them (src/store/planner.ts). No imports, so the app can import
 * this file as it does taskLimits.ts.
 *
 * An image is `![alt](att:<uuid>)`, as the app's editor writes it
 * (src/lib/mdSerialize.ts), with an alt without square brackets. Code is
 * stripped first, because the dialect shows it as text (src/lib/md.ts):
 * ``` fences to their closer or the end, then single-line backtick spans,
 * as the server's mention extractor strips them (model/messages.ts
 * mentionIds). So `att:<uuid>` in prose or in code is no image. */

const FENCE_RE = /```[\s\S]*?(```|$)/g
const SPAN_RE = /`[^`\n]*`/g
const IMAGE_RE =
  /!\[[^\][]*\]\(att:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/g

/** The attachment ids that `text` shows as images. */
export function imageRefs(text: string): Set<string> {
  const shown = text.replace(FENCE_RE, ' ').replace(SPAN_RE, ' ')
  return new Set(Array.from(shown.matchAll(IMAGE_RE), (m) => m[1]))
}
