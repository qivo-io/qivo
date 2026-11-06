/* Upload tickets for suites that attach a file they stored themselves.
 * Outside the demo files.attach takes only a file the caller's own unexpired
 * ticket for that task stored (model/attachments.ts attachUploadedFile), so
 * such a suite plants the ticket the upload URL's receiver would leave
 * (machine/uploads.ts finishTicketUpload) before it attaches. */

import type { Doc, Id } from '../_generated/dataModel'
import { UPLOAD_TICKET_TTL_MS } from '../model/attachments'
import { type T, uuid } from './helpers.setup'

/** Plants a live upload ticket of `profile` for task `issue` holding file
 * `storageId`, declared at the file's size, as the receiver leaves one after
 * the POST, and answers it. `expiresAt` defaults to the ticket's hour from
 * now. */
export async function plantTicket(
  t: T,
  a: {
    profile: Pick<Doc<'profiles'>, 'id'>
    issue: Pick<Doc<'issues'>, 'id' | 'org_id'>
    storageId: Id<'_storage'>
    expiresAt?: number
  },
): Promise<Doc<'attachment_uploads'>> {
  return await t.run(async (ctx) => {
    const file = await ctx.db.system.get(a.storageId)
    const rowId = await ctx.db.insert('attachment_uploads', {
      id: uuid(),
      org_id: a.issue.org_id,
      profile_id: a.profile.id,
      issue_id: a.issue.id,
      name: 'upload.bin',
      size_bytes: file?.size ?? 0,
      expires_at: a.expiresAt ?? Date.now() + UPLOAD_TICKET_TTL_MS,
      storage_id: a.storageId,
    })
    return (await ctx.db.get(rowId))!
  })
}
