/* Images in a task's description: attachments marked `inline` that the
 * description names as `att:<id>` (model/attachments.ts). The app's
 * attachment list hides them, so each counts toward ATTACHMENT_MAX only
 * while the description shows it, or while a draft that pasted it may
 * still save it. Every description save settles them the same way for the
 * app, REST and MCP (settleDescriptionImages, from model/issues.ts):
 *
 * - A save that takes an image out of the description drops it. The row
 *   gets dropped_at and stops counting at once, so a person who removes an
 *   image can attach another file straight away. A save that shows it again
 *   within DROPPED_KEEP_MS brings it back, when the task has room, which
 *   keeps an undo across a save working. After that it is deleted with its
 *   bytes (reapDroppedImage).
 * - Only a reference a save removes drops an image. An image pasted into a
 *   draft, which no saved description has named yet, keeps its row and its
 *   place, so neither another person's save nor a save of other text takes
 *   it from the draft. Only once ORPHAN_AFTER_MS have passed since its
 *   upload, as for an image a closed tab left, does a description save of
 *   its task drop it.
 * - A save may only add references to the task's own attachments. A
 *   reference to another task's image would break when that task deletes
 *   it, so it is refused with IMAGE_NOT_ATTACHED, as is one to an image
 *   that is gone. The app strips such an image when it is pasted
 *   (src/components/descEditor.tsx) and tells the person.
 *
 * It imports neither model/issues.ts nor model/attachments.ts, which
 * import each other's callers. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { rule } from '../lib/functions'
import { imageRefs, shownImages } from '../lib/imageRefs'
import { ATTACHMENT_MAX, ATTACHMENTS_FULL } from '../lib/taskLimits'
import { logActivity, signedDetail } from './activity'

/** How long an image a save took out of the description stays, uncounted,
 * for a later save to bring back. */
export const DROPPED_KEEP_MS = 24 * 60 * 60 * 1000

/** How long after its upload an image that no saved description names
 * stays counted for a draft that may still save it. A day outlives any
 * draft a person keeps open. */
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000

/** The most dropped images one task keeps. A save that would keep more
 * deletes the oldest at once, so a task holds at most ATTACHMENT_MAX
 * counted rows and this many dropped ones. */
export const DROPPED_IMAGES_MAX = ATTACHMENT_MAX

/** The refusal of a description that adds an image that is not one of the
 * task's attachments, such as one copied from another task's description
 * or one deleted since. */
export const IMAGE_NOT_ATTACHED =
  'the description shows an image that is not attached to this task, such as one from another task; remove it, or upload the image to this task'

const reapRef = makeFunctionReference<'mutation', { id: string }, null>('files:reapDroppedImage')

/** Schedules the step that deletes the image `id`, dropped at `droppedAt`,
 * once DROPPED_KEEP_MS have passed since (reapDroppedImage), or at once
 * when they have. */
export async function scheduleImageReap(
  ctx: MutationCtx,
  id: string,
  droppedAt: string,
): Promise<void> {
  const due = Math.max(0, Date.parse(droppedAt) + DROPPED_KEEP_MS - Date.now())
  await ctx.scheduler.runAfter(due, reapRef, { id })
}

/* Deletes a dropped image with its bytes. The byte fence
 * (model/attachments.ts storageIdInUse) gives every file one referent, so
 * no other row names them. */
async function deleteImage(ctx: MutationCtx, row: Doc<'issue_attachments'>): Promise<void> {
  await ctx.storage.delete(row.storage_id)
  await ctx.db.delete(row._id)
}

/**
 * Settles the images of `issue` for a save of its description as
 * `description` by `me` at `now`, before the task row is written: drops
 * the inline images the save takes out and those no saved text named for
 * ORPHAN_AFTER_MS, brings back dropped ones it shows again, and deletes
 * dropped ones older than DROPPED_KEEP_MS or past DROPPED_IMAGES_MAX.
 * Whether a text names an image is read broadly (lib/imageRefs.ts
 * imageRefs), so an image is dropped only once no `att:` of either text
 * names it; what a text shows is read as the app renders it (shownImages).
 * Refuses with IMAGE_NOT_ATTACHED a newly shown image that is not the
 * task's, and with ATTACHMENTS_FULL one that would bring an image back to a
 * task with ATTACHMENT_MAX attachments. A dropped or returned image
 * writes the activity row a removal or an attach writes, signed with
 * `provenance` for a machine caller.
 */
export async function settleDescriptionImages(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    description: string
    now: string
    provenance?: string
  },
): Promise<void> {
  const { issue, now } = a
  const before = imageRefs(issue.description ?? '')
  const after = imageRefs(a.description)
  const shown = shownImages(a.description)
  const rows = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
    .take(ATTACHMENT_MAX + DROPPED_IMAGES_MAX)
  const byId = new Map(rows.map((row) => [row.id, row]))
  // an image the saved text already showed may stay, even one deleted
  // since; an id it only named in prose or code is no such image. The old
  // text is parsed only when an image is not the task's.
  let shownBefore: Set<string> | undefined
  for (const id of shown) {
    if (byId.has(id)) continue
    shownBefore ??= shownImages(issue.description ?? '')
    if (!shownBefore.has(id)) throw rule(IMAGE_NOT_ATTACHED)
  }
  const log = (
    row: Doc<'issue_attachments'>,
    verb: 'added an image to' | 'removed an image from',
  ) =>
    logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: a.me.id,
      verb,
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      detail: signedDetail(row.name, a.provenance),
      project_id: issue.project_id,
      ts: now,
      named_task_nums: [],
    })
  // each row's dropped_at once this save is settled
  const dropped = new Map(rows.map((row) => [row.id, row.dropped_at]))
  const nowMs = Date.parse(now)
  // drops first, so a save that swaps one image for another fits a full task
  for (const row of rows) {
    if (!row.inline || row.dropped_at !== undefined || after.has(row.id)) continue
    const removed = before.has(row.id)
    if (!removed && nowMs - Date.parse(row.created_at) < ORPHAN_AFTER_MS) continue
    await ctx.db.patch(row._id, { dropped_at: now })
    dropped.set(row.id, now)
    await scheduleImageReap(ctx, row.id, now)
    // an image no saved text showed leaves no history of its own
    if (removed) await log(row, 'removed an image from')
  }
  let counted = [...dropped.values()].filter((at) => at === undefined).length
  for (const id of shown) {
    const row = byId.get(id)
    if (row === undefined || row.dropped_at === undefined) continue
    if (counted >= ATTACHMENT_MAX) throw rule(ATTACHMENTS_FULL)
    counted += 1
    await ctx.db.patch(row._id, { dropped_at: undefined })
    dropped.set(row.id, undefined)
    await log(row, 'added an image to')
  }
  // the dropped images this task keeps, newest first
  const kept = rows
    .filter((row) => dropped.get(row.id) !== undefined)
    .sort((x, y) => (dropped.get(y.id) as string).localeCompare(dropped.get(x.id) as string))
  for (const [i, row] of kept.entries()) {
    const at = Date.parse(dropped.get(row.id) as string)
    if (i >= DROPPED_IMAGES_MAX || nowMs - at >= DROPPED_KEEP_MS) await deleteImage(ctx, row)
  }
}

/** Deletes the image `id` with its bytes once it has stayed dropped for
 * DROPPED_KEEP_MS, as the step its drop scheduled. An image brought back
 * since, or deleted, is left alone, and one dropped again since waits for
 * the step of that drop. */
export async function reapDroppedImage(ctx: MutationCtx, id: string): Promise<void> {
  const row = await ctx.db
    .query('issue_attachments')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()
  if (row?.dropped_at === undefined) return
  if (Date.now() - Date.parse(row.dropped_at) < DROPPED_KEEP_MS) return
  await deleteImage(ctx, row)
}
