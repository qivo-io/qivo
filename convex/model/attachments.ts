/* Task attachments, one set of rules for the app, REST and MCP. An
 * attachment is a stored file on a task, either one in the task's attachment
 * list or an image inside its description (`inline`), which the description
 * names as `att:<id>`.
 *
 * Anyone with Edit (User) or Lead on the task's project may attach or
 * remove, not only the uploader (files.ts header, ia_insert and ia_delete).
 * Each caller resolves the task and refuses with its own sentence first;
 * these cores repeat the write gate as defense in depth.
 *
 * The size cap is the organization's (model/orgs.ts attachmentLimitMb),
 * measured from storage metadata, never from a client's number. An oversize
 * file's bytes are deleted and the refusal is RETURNED instead of thrown,
 * because a throw would roll the delete back (files.ts header, the probe
 * verdict).
 *
 * Each row carries its task's organization, so the storage totals read the
 * organization's rows by index. It names no project: the storage totals
 * read each row's project through its task (model/billing.ts storagePage),
 * so moving a task writes none of its rows. The maintained stored-byte
 * totals (model/storageTotals.ts) count a file in the transaction that
 * attaches it and take it out in the one that deletes it. A task holds at
 * most LIMITS.attachments.max rows, files and description images together
 * (lib/limits.ts), less the description images a save took out
 * (model/descriptionImages.ts): an upload that would pass it is refused
 * before any bytes are sent (startAttachmentUpload, files.ts uploadUrl,
 * machine/records.ts attach_text_file), and attachFileCore checks again. A file name and a
 * media type stay within LIMITS.attachmentName and LIMITS.mediaType. That
 * keeps every row small, so a page of rows stays small too.
 *
 * The app, REST and MCP upload on the same tickets. openUploadTicket checks
 * the declared size against the organization's limit, records a ticket
 * naming the caller, the task and an expiry, and answers an upload URL
 * signed for that ticket; startAttachmentUpload, for REST and MCP, checks
 * the write gate and the task's room first, as files.ts uploadUrl does for
 * the app. The client sends the bytes to the URL, whose receiver
 * (machine/uploads.ts) stores exactly the declared number of bytes once per
 * ticket (beginTicketUpload, finishTicketUpload), or at most the
 * organization's limit for an app that declared no size (`up_to`). The
 * file then attaches only for that caller and task before the ticket
 * expires, through completeUpload: files.ts attach finds the ticket by its
 * file, and confirmAttachmentUpload, on either machine surface, by its id.
 * Convex's own upload URLs are not used for task files, because one of them
 * stores any number of files of any size until it expires. A person holds
 * at most LIMITS.uploadsInProgress unexpired tickets in an organization, and
 * within an hour of a ticket's expiry files.ts reapUploadTickets erases the
 * file it holds unless something names it, and deletes it.
 *
 * Downloads go through the /files gateway with a 10-minute token minted for
 * the reader (lib/fileTokens.ts), which the gateway re-checks on every fetch.
 * Never ctx.storage.getUrl, whose URLs are permanent and unauthenticated. */

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { assertNewRowId, byId, insertUnique } from '../lib/db'
import {
  attachmentFileUrl,
  attachmentUploadUrl,
  FILE_TOKEN_TTL_SECONDS,
  mintFileToken,
} from '../lib/fileTokens'
import { badRequest, conflict, notFound, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { attachmentTooLarge, LIMITS, MIB } from '../lib/limits'
import { logActivity, signedDetail } from './activity'
import { eraseFile, releaseFile, storageIdInUse } from './fileHolds'
import { assertCanEdit } from './issues'
import { attachmentLimitMb, newUuid } from './orgs'
import { countFile, uncountFile } from './storageTotals'

/* The byte fence and the file holds live in model/fileHolds.ts; other
 * modules still import storageIdInUse from here and from files.ts. */
export { storageIdInUse } from './fileHolds'

/* The issue's owning organization controls all attachments, including inline
 * images and projects without a team (attachmentLimitMb). */
async function attachmentCapMb(ctx: QueryCtx, orgId: string): Promise<number> {
  return attachmentLimitMb(await byId(ctx, 'organizations', orgId))
}

/** Refuses with LIMITS.attachments' sentence when task `issueId` already
 * has LIMITS.attachments.max attachment rows that count, which are those a
 * description save has not dropped (model/descriptionImages.ts). One range
 * of at most that many rows. */
export async function assertAttachmentRoom(ctx: QueryCtx, issueId: string): Promise<void> {
  const rows = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue_dropped', (q) => q.eq('issue_id', issueId).eq('dropped_at', undefined))
    .take(LIMITS.attachments.max)
  if (rows.length >= LIMITS.attachments.max) throw rule(LIMITS.attachments.refusal)
}

/** Answers `raw` trimmed, the name an attachment stores. Refuses a name that
 * is empty after trimming or past LIMITS.attachmentName. REST and MCP check
 * it when an upload starts, and attachFileCore for every attach. */
export function cleanAttachmentName(raw: string): string {
  const name = limitedText(LIMITS.attachmentName, raw)
  if (name === '') throw rule('a file name cannot be blank')
  return name
}

/** The refusal of a declared upload size that is not a whole number of
 * bytes, the same on the app, REST and MCP. */
export const UPLOAD_SIZE_SHAPE = 'size must be the file size in bytes, a whole number'

/** Answers `size`, a size an upload declares, when it is a whole number of
 * bytes, at least 0. Refuses any other number as a bad request. */
export function uploadSize(size: number): number {
  if (!Number.isInteger(size) || size < 0) throw badRequest(UPLOAD_SIZE_SHAPE)
  return size
}

/* System fields and the organization stay internal; optional columns come
 * back ABSENT. */
const pub = ({ _id, _creationTime, org_id: _orgId, ...row }: Doc<'issue_attachments'>) => row

export type AttachmentRow = ReturnType<typeof pub>

/* The structured refusal an attach returns when the byte delete must commit
 * (the probe verdict above). The app's client toasts the message, REST
 * answers it as a 400 and MCP as an error result. */
export type AttachResult =
  | { refused: { code: 'rule'; message: string } }
  | { attachment: AttachmentRow }

/**
 * Attaches the stored file `storage_id` to `issue` as `me`, with the
 * activity row the app writes ('attached a file to', or 'added an image to'
 * for an inline image), signed with `provenance` for a machine caller. The
 * row takes the task's organization. A task with LIMITS.attachments.max rows
 * refuses it (assertAttachmentRoom). `name` is stored trimmed and must be
 * within LIMITS.attachmentName, and the media type (`mime`, else the stored
 * file's), trimmed, within LIMITS.mediaType. The size comes from storage
 * metadata. When
 * `declaredSize` is given, the stored file must have exactly that many
 * bytes, checked before the cap so that a file of another size is refused
 * and kept, never deleted. Throws before any write; only an oversize file is
 * a returned refusal, after its bytes are deleted. The attached file counts
 * in the organization's stored-byte totals from this transaction
 * (model/storageTotals.ts countFile); a refused one never does. Does not
 * notify and does not stamp the task's updated_at, as in the app.
 */
export async function attachFileCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    id: string
    storage_id: Id<'_storage'>
    name: string
    mime?: string
    inline: boolean
    now: string
    declaredSize?: number
    provenance?: string
  },
): Promise<AttachResult> {
  const { me, issue } = a
  assertNewRowId(a.id)
  await assertCanEdit(ctx, me, issue.project_id)
  const name = cleanAttachmentName(a.name)
  await assertAttachmentRoom(ctx, issue.id)
  if (await storageIdInUse(ctx, a.storage_id)) {
    // never delete here, the bytes belong to the EXISTING referent
    throw badRequest('this file is already attached')
  }
  const meta = await ctx.db.system.get(a.storage_id)
  if (meta === null) throw badRequest('attachment bytes not found in storage')
  const sent = a.mime ?? meta.contentType ?? undefined
  const mime = sent === undefined ? undefined : limitedText(LIMITS.mediaType, sent)
  if (a.declaredSize !== undefined && meta.size !== a.declaredSize) {
    throw badRequest(`the uploaded file has ${meta.size} bytes, not the ${a.declaredSize} declared`)
  }
  const cap = await attachmentCapMb(ctx, issue.org_id)
  if (meta.size > cap * MIB) {
    // no committed row ever named these bytes, so they go at once
    await eraseFile(ctx, a.storage_id)
    return { refused: { code: 'rule', message: attachmentTooLarge(cap) } }
  }
  const rowId = await insertUnique(
    ctx,
    'issue_attachments',
    'by_uuid',
    { id: a.id },
    {
      id: a.id,
      org_id: issue.org_id,
      issue_id: issue.id,
      name,
      size_bytes: meta.size, // server truth, NEVER a client number (0089)
      mime,
      storage_id: a.storage_id,
      inline: a.inline,
      uploaded_by: me.id,
      created_at: a.now,
      task_key: issue.window_key,
    },
    badRequest('an attachment with this id already exists'),
  )
  await countFile(ctx, issue, meta.size)
  await logActivity(ctx, {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: a.inline ? 'added an image to' : 'attached a file to',
    target_type: 'issue',
    target_id: issue.id,
    label: issue.title,
    detail: signedDetail(name, a.provenance),
    project_id: issue.project_id,
    ts: a.now,
    named_task_nums: [],
  })
  const row = (await ctx.db.get(rowId)) as Doc<'issue_attachments'>
  return { attachment: pub(row) }
}

/**
 * Deletes `attachment` of `issue`, takes it out of the stored-byte totals
 * (model/storageTotals.ts uncountFile) and lets go of its file, which is
 * held for a restore before it is erased (model/fileHolds.ts releaseFile),
 * with the app's activity row ('removed an attachment from', or 'removed an
 * image from' for an inline image), signed with `provenance` for a machine
 * caller.
 * Any member with Edit on the task's project may remove any attachment.
 */
export async function removeAttachmentCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    attachment: Doc<'issue_attachments'>
    issue: Doc<'issues'>
    now: string
    provenance?: string
  },
): Promise<void> {
  const { me, attachment, issue } = a
  await assertCanEdit(ctx, me, issue.project_id)
  if (attachment.issue_id !== issue.id) throw notFound('attachment not found')
  await ctx.db.delete(attachment._id)
  await uncountFile(ctx, attachment, issue.num)
  await releaseFile(ctx, attachment.storage_id)
  await logActivity(ctx, {
    org_id: issue.org_id,
    actor_id: me.id,
    verb: attachment.inline ? 'removed an image from' : 'removed an attachment from',
    target_type: 'issue',
    target_id: issue.id,
    label: issue.title,
    detail: signedDetail(attachment.name, a.provenance),
    project_id: issue.project_id,
    ts: a.now,
    named_task_nums: [],
  })
}

/* --------------------------------------------------------------- uploads */

/** How long an upload ticket and its signed upload URL stay usable. It must
 * not exceed the 60 minutes reapOrphans waits before reaping unreferenced
 * bytes (files.ts REAP_FLOOR_MS), or the sweep could take a file a ticket
 * still holds. */
export const UPLOAD_TICKET_TTL_MS = 60 * 60 * 1000

/** How many of a caller's expired tickets one new upload deletes, keeping
 * that write bounded; files.ts reapUploadTickets deletes the rest. */
const EXPIRED_TICKETS_PER_UPLOAD = 100

/** A new upload ticket and its upload URL. */
type OpenedUpload = { ticket: Doc<'attachment_uploads'>; uploadUrl: string }

/**
 * Records a ticket for an upload of a file of `size` bytes to `issue` by
 * `me` and answers its upload URL, which stores one file. The caller has
 * checked the write gate and the task's room. Refuses a size over the
 * organization's limit with that limit's `rule`, and then a start while
 * `me` holds LIMITS.uploadsInProgress unexpired tickets, on any surface,
 * with that limit's. Without `size`, for an app loaded before uploads
 * declared one, the ticket is `up_to` the organization's limit. `name` and
 * `content_type` are what a REST or MCP confirm attaches the file as; the
 * app's attach names the file itself. `nowMs` is the request's clock.
 * Reads at most LIMITS.uploadsInProgress live tickets and deletes up to
 * EXPIRED_TICKETS_PER_UPLOAD of the caller's expired ones on the way.
 */
export async function openUploadTicket(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    name: string
    content_type?: string
    size?: number
    nowMs: number
  },
): Promise<OpenedUpload> {
  const { me, issue } = a
  const cap = await attachmentCapMb(ctx, issue.org_id)
  if (a.size !== undefined && a.size > cap * MIB) throw rule(attachmentTooLarge(cap))
  // two starts at once read the same range, so one of them retries
  const live = await ctx.db
    .query('attachment_uploads')
    .withIndex('by_profile_expiry', (q) => q.eq('profile_id', me.id).gt('expires_at', a.nowMs))
    .take(LIMITS.uploadsInProgress.max)
  if (live.length >= LIMITS.uploadsInProgress.max) throw rule(LIMITS.uploadsInProgress.refusal)
  const expired = await ctx.db
    .query('attachment_uploads')
    .withIndex('by_profile_expiry', (q) => q.eq('profile_id', me.id).lte('expires_at', a.nowMs))
    .take(EXPIRED_TICKETS_PER_UPLOAD)
  for (const old of expired) await ctx.db.delete(old._id)
  const id = newUuid()
  // the URL's token lapses at the ticket's expiry, rounded down to a second
  const exp = Math.floor((a.nowMs + UPLOAD_TICKET_TTL_MS) / 1000)
  const rowId = await ctx.db.insert('attachment_uploads', {
    id,
    org_id: issue.org_id,
    profile_id: me.id,
    issue_id: issue.id,
    name: a.name,
    content_type: a.content_type,
    size_bytes: a.size ?? cap * MIB,
    ...(a.size === undefined ? { up_to: true as const } : {}),
    expires_at: a.nowMs + UPLOAD_TICKET_TTL_MS,
  })
  const token = await mintFileToken({ kind: 'attachment_upload', id, minter: me.id, exp })
  return {
    ticket: (await ctx.db.get(rowId)) as Doc<'attachment_uploads'>,
    uploadUrl: attachmentUploadUrl({ id, minter: me.id, exp, token }),
  }
}

/**
 * Starts a REST or MCP upload of a file of `size` bytes to `issue` for
 * `me`. Checks the write gate and the task's room for one more attachment
 * (assertAttachmentRoom), then opens the ticket that confirmAttachmentUpload
 * requires (openUploadTicket).
 */
export async function startAttachmentUpload(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    name: string
    content_type?: string
    size: number
    nowMs: number
  },
): Promise<OpenedUpload> {
  await assertCanEdit(ctx, a.me, a.issue.project_id)
  await assertAttachmentRoom(ctx, a.issue.id)
  return await openUploadTicket(ctx, a)
}

/** The one answer for a ticket that is unknown, expired, another caller's
 * or another task's, so a refusal says nothing about other tickets. The
 * upload URL answers it too. */
export const UPLOAD_TICKET_MISSING = 'upload not found or expired; start a new upload'

/** The upload URL's answer once it is storing or has stored its file. */
export const UPLOAD_URL_USED = 'this upload URL has already been used; start a new upload'

/** The upload URL's answer for a body that is not the declared size. */
export const uploadSizeWrong = (size: number): string =>
  `the upload must be exactly the ${size} bytes declared`

/** The upload URL's answer for a body longer than an `up_to` ticket takes. */
export const UPLOAD_OVER_URL =
  'the file is larger than the most this upload URL takes; start a new upload'

/** The app's attach answer for a file no live ticket of the caller for
 * the task holds, the same whether there is no ticket, another person's,
 * another task's or an expired one, so it says nothing about other
 * uploads. */
export const UPLOAD_NOT_STARTED =
  'this upload expired or was not started for this task. Upload the file again.'

/** How long a POST to an upload URL holds the URL. A POST that ended
 * without storing its file, or without freeing the URL, such as one whose
 * runtime was stopped, lets another POST take the URL once this has passed.
 * The receiver stops reading a body well before (machine/uploads.ts). */
export const UPLOAD_CLAIM_MS = 15 * 60 * 1000

/* The ticket `ticketId` of `minter` while it is unexpired at `nowMs`, else
 * null. */
async function liveTicket(
  ctx: QueryCtx,
  a: { ticketId: string; minter: string; nowMs: number },
): Promise<Doc<'attachment_uploads'> | null> {
  const ticket = await byId(ctx, 'attachment_uploads', a.ticketId)
  return ticket !== null && ticket.profile_id === a.minter && ticket.expires_at > a.nowMs
    ? ticket
    : null
}

/**
 * Claims the upload URL of ticket `ticketId` for the POST `attempt`, and
 * answers the number of bytes the POST must carry, or with `upTo` the most
 * it may carry. A ticket that is unknown, expired or not `minter`'s is
 * refused, and so is one that holds a file or that another POST claimed
 * less than UPLOAD_CLAIM_MS ago, so a URL stores at most one file however
 * often it is sent to.
 */
export async function beginTicketUpload(
  ctx: MutationCtx,
  a: { ticketId: string; minter: string; attempt: string; nowMs: number },
): Promise<{ size: number; upTo: boolean }> {
  const ticket = await liveTicket(ctx, a)
  if (ticket === null) throw notFound(UPLOAD_TICKET_MISSING)
  const claimed =
    ticket.upload_started_at !== undefined && a.nowMs - ticket.upload_started_at < UPLOAD_CLAIM_MS
  if (ticket.storage_id !== undefined || claimed) {
    throw conflict(UPLOAD_URL_USED, 'upload_url_used')
  }
  await ctx.db.patch(ticket._id, { upload_started_at: a.nowMs, upload_attempt: a.attempt })
  return { size: ticket.size_bytes, upTo: ticket.up_to === true }
}

/**
 * Records `storageId` as the file of ticket `ticketId`, which the POST
 * `attempt` claimed (beginTicketUpload). If the ticket is gone, expired, holds
 * a file or belongs to another POST now, the file is deleted instead and the
 * answer is false, so a ticket never holds two files.
 */
export async function finishTicketUpload(
  ctx: MutationCtx,
  a: {
    ticketId: string
    minter: string
    attempt: string
    storageId: Id<'_storage'>
    nowMs: number
  },
): Promise<boolean> {
  const ticket = await liveTicket(ctx, a)
  const inUse = await storageIdInUse(ctx, a.storageId)
  if (
    ticket === null ||
    ticket.upload_attempt !== a.attempt ||
    ticket.storage_id !== undefined ||
    inUse
  ) {
    if (!inUse) await eraseFile(ctx, a.storageId)
    return false
  }
  await ctx.db.patch(ticket._id, { storage_id: a.storageId })
  return true
}

/**
 * Undoes the POST `attempt` after it failed: deletes `storageId`, when given,
 * unless the ticket or anything else holds it, and frees the URL for another
 * try if that POST still holds it and the ticket holds no file. Safe to run
 * whether or not beginTicketUpload claimed the URL for this POST. Answers
 * the ticket's file when this POST stored it after all, such as when the
 * answer of finishTicketUpload was lost, else null.
 */
export async function abandonTicketUpload(
  ctx: MutationCtx,
  a: { ticketId: string; minter: string; attempt: string; storageId?: Id<'_storage'> },
): Promise<Id<'_storage'> | null> {
  const ticket = await byId(ctx, 'attachment_uploads', a.ticketId)
  if (
    ticket !== null &&
    ticket.profile_id === a.minter &&
    ticket.upload_attempt === a.attempt &&
    ticket.storage_id !== undefined
  ) {
    return ticket.storage_id
  }
  if (
    a.storageId !== undefined &&
    ticket?.storage_id !== a.storageId &&
    !(await storageIdInUse(ctx, a.storageId))
  ) {
    await eraseFile(ctx, a.storageId)
  }
  if (
    ticket !== null &&
    ticket.profile_id === a.minter &&
    ticket.upload_attempt === a.attempt &&
    ticket.storage_id === undefined
  ) {
    await ctx.db.patch(ticket._id, { upload_started_at: undefined, upload_attempt: undefined })
  }
  return null
}

/** The confirm's answer for a ticket whose upload URL has stored no file,
 * such as one started before upload URLs stored a single file. */
export const UPLOAD_NOT_SENT =
  'no file has been sent to this upload URL; send it there, or start a new upload'

/** The one answer for a `storage_id` that is not the file the ticket's
 * upload URL stored. */
export const UPLOAD_STORAGE_ID = 'storage_id must be the storageId the upload answered'

/* The attachment that file `storageId` became on `issue`, uploaded by `me`
 * and not taken out by a description save, else null. With `id`, only a
 * row of that id. One range of issue_attachments.by_storage. */
async function committedUpload(
  ctx: QueryCtx,
  a: { me: Doc<'profiles'>; issue: Doc<'issues'>; storageId: Id<'_storage'>; id?: string },
): Promise<AttachmentRow | null> {
  const row = await ctx.db
    .query('issue_attachments')
    .withIndex('by_storage', (q) => q.eq('storage_id', a.storageId))
    .first()
  if (
    row === null ||
    row.issue_id !== a.issue.id ||
    row.uploaded_by !== a.me.id ||
    row.dropped_at !== undefined ||
    (a.id !== undefined && row.id !== a.id)
  )
    return null
  return pub(row)
}

/**
 * Attaches the file of upload ticket `ticket` to `issue` as `me`, the core
 * the app's attach and the REST and MCP confirm share. The ticket must be
 * this caller's, for this task and unexpired at `nowMs`, or the answer is a
 * not-found refusal with `missing`, the surface's sentence, the same for
 * every such case. With no ticket at all, as when the completion is sent
 * again after its answer was lost and the first one spent the ticket, it
 * answers the attachment `storageId` became when that is a row of this
 * task that `me` uploaded and no description save took out, and, with
 * `sameId`, of `row.id`; it then writes nothing, no row, activity or
 * count. Every other such case is `missing`. `storageId` must be the file
 * its upload URL stored (finishTicketUpload), so a ticket cannot claim or
 * delete any other file. The attachment is `row`, through attachFileCore
 * with every one of its checks, the ticket's declared size enforced unless
 * it was `up_to`, and `provenance` signing the activity row. A completed
 * ticket is spent, and so is one whose file was deleted for exceeding the
 * organization's limit, which for a declared size happens only when the
 * organization lowered its limit after the upload started. Any other
 * refusal leaves the ticket for another try.
 */
async function completeUpload(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    ticket: Doc<'attachment_uploads'> | null
    storageId: Id<'_storage'> | null
    row: { id: string; name: string; mime?: string; inline: boolean }
    nowMs: number
    provenance?: string
    missing: string
    sameId: boolean
  },
): Promise<AttachResult> {
  const { me, issue, ticket } = a
  if (ticket === null && a.storageId !== null) {
    await assertCanEdit(ctx, me, issue.project_id)
    const id = a.sameId ? a.row.id : undefined
    const committed = await committedUpload(ctx, { me, issue, storageId: a.storageId, id })
    if (committed !== null) return { attachment: committed }
  }
  if (
    ticket === null ||
    ticket.profile_id !== me.id ||
    ticket.issue_id !== issue.id ||
    !(ticket.expires_at > a.nowMs)
  ) {
    throw notFound(a.missing)
  }
  if (ticket.storage_id === undefined) throw badRequest(UPLOAD_NOT_SENT)
  if (a.storageId === null || a.storageId !== ticket.storage_id) throw badRequest(UPLOAD_STORAGE_ID)
  const result = await attachFileCore(ctx, {
    me,
    issue,
    ...a.row,
    storage_id: a.storageId,
    now: new Date(a.nowMs).toISOString(),
    ...(ticket.up_to ? {} : { declaredSize: ticket.size_bytes }),
    provenance: a.provenance,
  })
  await ctx.db.delete(ticket._id)
  return result
}

/**
 * Attaches file `storageId` to `issue` as `me` for the app (files.ts
 * attach), as `row`, the attachment's id, name, media type and whether it
 * is a description image. Only the file the caller's own unexpired ticket
 * for this task stored attaches (completeUpload); any other file is refused
 * with UPLOAD_NOT_STARTED, also one a REST or MCP ticket of another person
 * stored. A REST or MCP ticket of the caller attaches, since a ticket
 * belongs to its person on every surface. The same attach sent again after
 * it committed, with the same id, answers the attachment it made. Reads the
 * ticket by its file (attachment_uploads.by_storage).
 */
export async function attachUploadedFile(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    storageId: Id<'_storage'>
    row: { id: string; name: string; mime?: string; inline: boolean }
    nowMs: number
  },
): Promise<AttachResult> {
  const ticket = await ctx.db
    .query('attachment_uploads')
    .withIndex('by_storage', (q) => q.eq('storage_id', a.storageId))
    .first()
  return await completeUpload(ctx, { ...a, ticket, missing: UPLOAD_NOT_STARTED, sameId: true })
}

/**
 * Confirms the upload `ticketId` of `me` to `issue` with the uploaded
 * file `storage_id`, then attaches it like the app does (completeUpload),
 * under the ticket's name and media type, with `provenance` signing the
 * activity row. A ticket that is unknown, expired, another caller's or
 * another task's is UPLOAD_TICKET_MISSING. A confirm sent again by the same
 * caller for the same task and file after the first one attached it, as
 * when its answer was lost, finds no ticket and answers that attachment,
 * changing nothing. So do two confirms of one ticket sent at once: the
 * second conflicts on the ticket, runs again and finds it spent.
 */
export async function confirmAttachmentUpload(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    issue: Doc<'issues'>
    ticketId: string
    storage_id: string
    nowMs: number
    provenance: string
  },
): Promise<AttachResult> {
  const ticket = await byId(ctx, 'attachment_uploads', a.ticketId.toLowerCase())
  return await completeUpload(ctx, {
    me: a.me,
    issue: a.issue,
    ticket,
    storageId: ctx.db.system.normalizeId('_storage', a.storage_id),
    row: {
      id: newUuid(),
      name: ticket?.name ?? '',
      mime: ticket?.content_type,
      inline: false,
    },
    nowMs: a.nowMs,
    provenance: a.provenance,
    missing: UPLOAD_TICKET_MISSING,
    sameId: false,
  })
}

/* ----------------------------------------------------------------- reads */

/** An attachment as REST and MCP read it, with a download link minted for
 * the reader. */
export type AttachmentJson = {
  id: string
  name: string
  size_bytes: number
  content_type: string | null
  /** an image inside the description, which names it as `att:<id>` */
  inline: boolean
  uploaded_by_id: string | null
  uploaded_by_name: string | null
  created_at: string
  /** the /files gateway link, which works until url_expires_at */
  url: string
  url_expires_at: string
}

/** When a download link minted now stops working, in unix seconds. */
const linkExpiry = (): number => Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS

/**
 * One attachment as REST and MCP read it, with a download link minted for
 * `reader` that works until `exp` (unix seconds). The caller has already
 * resolved the attachment's task for `reader`; the gateway re-checks the
 * reader's active seat and sight of the project on every fetch, so a link
 * stops working once that access is gone. `names` caches uploader names
 * across a list.
 */
export async function attachmentJson(
  ctx: QueryCtx,
  reader: Doc<'profiles'>,
  att: AttachmentRow,
  exp: number = linkExpiry(),
  names: Map<string, string | null> = new Map(),
): Promise<AttachmentJson> {
  const uploader = att.uploaded_by
  if (uploader !== undefined && !names.has(uploader)) {
    names.set(uploader, (await byId(ctx, 'profiles', uploader))?.name ?? null)
  }
  const token = await mintFileToken({ kind: 'attachment', id: att.id, minter: reader.id, exp })
  return {
    id: att.id,
    name: att.name,
    size_bytes: att.size_bytes,
    content_type: att.mime ?? null,
    inline: att.inline,
    uploaded_by_id: uploader ?? null,
    uploaded_by_name: uploader === undefined ? null : (names.get(uploader) ?? null),
    created_at: att.created_at,
    url: attachmentFileUrl({ id: att.id, minter: reader.id, exp, token }),
    url_expires_at: new Date(exp * 1000).toISOString(),
  }
}

/**
 * The attachments of `issue`, oldest first and inline images included, as
 * attachmentJson reads them for `reader`, all links sharing one expiry. An
 * image a description save dropped (model/descriptionImages.ts) is no
 * longer the task's, so it is left out.
 */
export async function taskAttachments(
  ctx: QueryCtx,
  reader: Doc<'profiles'>,
  issue: Doc<'issues'>,
): Promise<AttachmentJson[]> {
  const rows = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue_dropped', (q) => q.eq('issue_id', issue.id).eq('dropped_at', undefined))
    .collect()
  rows.sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id))
  const exp = linkExpiry()
  const names = new Map<string, string | null>()
  const out: AttachmentJson[] = []
  for (const att of rows) out.push(await attachmentJson(ctx, reader, att, exp, names))
  return out
}
