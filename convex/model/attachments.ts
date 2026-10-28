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
 * REST and MCP upload in two steps. startAttachmentUpload checks the write
 * gate and the declared size, records a ticket naming the caller, the task
 * and an expiry, and answers an upload URL signed for that ticket. The
 * client sends the bytes to the URL, whose receiver (machine/uploads.ts)
 * stores exactly the declared number of bytes once per ticket
 * (beginTicketUpload, finishTicketUpload), and confirmAttachmentUpload
 * attaches that one file only for that caller and task before the ticket
 * expires, on either surface. Convex's own upload URLs are not used here,
 * because one of them stores any number of files until it expires.
 * Unconfirmed bytes are reaped with every other unreferenced file
 * (files.ts reapOrphans), which also deletes expired tickets.
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
 * that write bounded; reapOrphans deletes the rest. */
const EXPIRED_TICKETS_PER_UPLOAD = 100

/**
 * Starts an upload of a file of `size` bytes to `issue` for `me`. Checks
 * the write gate, the task's room for one more attachment
 * (assertAttachmentRoom) and the organization's cap against the declared size,
 * records the ticket that confirmAttachmentUpload requires and answers its
 * upload URL, which stores one file. `nowMs` is the request's clock. Deletes
 * some of the caller's expired tickets on the way.
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
): Promise<{ ticket: Doc<'attachment_uploads'>; uploadUrl: string }> {
  const { me, issue } = a
  await assertCanEdit(ctx, me, issue.project_id)
  await assertAttachmentRoom(ctx, issue.id)
  const cap = await attachmentCapMb(ctx, issue.org_id)
  if (a.size > cap * MIB) throw rule(attachmentTooLarge(cap))
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
    size_bytes: a.size,
    expires_at: a.nowMs + UPLOAD_TICKET_TTL_MS,
  })
  const token = await mintFileToken({ kind: 'attachment_upload', id, minter: me.id, exp })
  return {
    ticket: (await ctx.db.get(rowId)) as Doc<'attachment_uploads'>,
    uploadUrl: attachmentUploadUrl({ id, minter: me.id, exp, token }),
  }
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
 * answers the number of bytes the POST must carry. A ticket that is unknown,
 * expired or not `minter`'s is refused, and so is one that holds a file or
 * that another POST claimed less than UPLOAD_CLAIM_MS ago, so a URL stores
 * at most one file however often it is sent to.
 */
export async function beginTicketUpload(
  ctx: MutationCtx,
  a: { ticketId: string; minter: string; attempt: string; nowMs: number },
): Promise<{ size: number }> {
  const ticket = await liveTicket(ctx, a)
  if (ticket === null) throw notFound(UPLOAD_TICKET_MISSING)
  const claimed =
    ticket.upload_started_at !== undefined && a.nowMs - ticket.upload_started_at < UPLOAD_CLAIM_MS
  if (ticket.storage_id !== undefined || claimed) {
    throw conflict(UPLOAD_URL_USED, 'upload_url_used')
  }
  await ctx.db.patch(ticket._id, { upload_started_at: a.nowMs, upload_attempt: a.attempt })
  return { size: ticket.size_bytes }
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

/**
 * Confirms the upload `ticketId` of `me` to `issue` with the uploaded
 * file `storage_id`, then attaches it like the app does (attachFileCore,
 * with the declared size enforced and `provenance` signing the activity
 * row). The ticket must be this caller's, for this task and unexpired at
 * `nowMs`, and `storage_id` must be the file its upload URL stored
 * (finishTicketUpload), so a ticket cannot claim or delete any other file. A
 * confirmed ticket is spent, and so is one whose file was deleted for
 * exceeding the cap, which happens only when the organization lowered its
 * limit after the upload started. Any other refusal leaves the ticket for
 * another try.
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
  if (
    ticket === null ||
    ticket.profile_id !== a.me.id ||
    ticket.issue_id !== a.issue.id ||
    !(ticket.expires_at > a.nowMs)
  ) {
    throw notFound(UPLOAD_TICKET_MISSING)
  }
  if (ticket.storage_id === undefined) throw badRequest(UPLOAD_NOT_SENT)
  const storageId = ctx.db.system.normalizeId('_storage', a.storage_id)
  if (storageId === null || storageId !== ticket.storage_id) throw badRequest(UPLOAD_STORAGE_ID)
  const result = await attachFileCore(ctx, {
    me: a.me,
    issue: a.issue,
    id: newUuid(),
    storage_id: storageId,
    name: ticket.name,
    mime: ticket.content_type,
    inline: false,
    now: new Date(a.nowMs).toISOString(),
    declaredSize: ticket.size_bytes,
    provenance: a.provenance,
  })
  await ctx.db.delete(ticket._id)
  return result
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
