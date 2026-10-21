/* Attachments, task activity and workload over REST and MCP. A caller reads
 * a task's files and history, and each person's planned hours per week.
 *
 * RECORD_TOOLS and RECORD_ROUTES are registry entries (machine/registry.ts)
 * that machine/mcp.ts TOOLS and machine/rest.ts ROUTES spread in, so
 * tools/list, the OAuth step-up and REST routing treat them like the rest.
 * This module imports only types from those two, so neither is loaded
 * through it. The refusal sentences, provenance, key name validator, body
 * parser and MCP text it shares with them come from machine/shared.ts.
 *
 * Each action is one shared function that holds the app's rule.
 * model/attachments.ts lists attachments with download links, removes them
 * and runs the REST upload's start and confirm, and the app's files.ts runs
 * the same attach and remove. lib/activityVisibility.ts taskHistoryPage is the
 * app's activity rule, and planning.ts workloadCore is the app's org load
 * with its anonymization. The internal functions below are thin per-surface
 * wrappers named `mcp*` and `rest*`. Each starts from asMachineCaller, which
 * refuses a read-only credential before anything resolves, then parses its
 * surface's input, calls the shared function and encodes the result. MCP
 * answers pretty-printed text, stringified here so the key order survives
 * the function boundary, and REST answers objects.
 *
 * A task the caller cannot read answers like an unknown one, before any
 * write check. Inline description images stay app-only, so neither surface
 * uploads or deletes one.
 *
 * Both surfaces upload a file in the same three steps, through the same
 * ticket (model/attachments.ts startAttachmentUpload and
 * confirmAttachmentUpload). The start answers an upload URL that takes no
 * credential and stores one file (machine/uploads.ts), the client sends the
 * bytes there, and the confirm attaches them. So the file never passes
 * through an MCP or REST request, and an OAuth token never leaves /mcp. A
 * ticket belongs to the user, not the credential, so either surface may
 * confirm it. MCP's attach_text_file stores text the assistant writes
 * itself, for a client that cannot send the bytes anywhere. Its action stores the text and a mutation attaches
 * it, both behind the same checks as every other MCP write. */

import { ConvexError, type ObjectType, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { canSeeProject, hasProjectLevel } from '../lib/access'
import {
  HISTORY_HIDDEN,
  HISTORY_PAGE_MAX,
  historyAnchor,
  taskHistoryPage,
} from '../lib/activityVisibility'
import { asMachineCaller, type Caller, findIssue, findProject, issueKey, UUID } from '../lib/core'
import { byId } from '../lib/db'
import { vCredentialAccess } from '../lib/enums'
import { badRequest, forbidden, notFound, type Refusal, rule } from '../lib/functions'
import { utcToday } from '../lib/machineDelay'
import {
  ATTACHMENT_NAME_MAX,
  ATTACHMENT_TYPE_MAX,
  type AttachmentJson,
  type AttachResult,
  attachFileCore,
  attachmentJson,
  cleanAttachmentName,
  confirmAttachmentUpload,
  removeAttachmentCore,
  startAttachmentUpload,
  taskAttachments,
  UPLOAD_STORAGE_ID,
} from '../model/attachments'
import { newUuid } from '../model/orgs'
import { calendarDay } from '../model/taskValues'
import { type WorkloadJson, workloadCore } from '../planning'
import type { TOOLS } from './mcp'
import { conflictRetrying } from './registry'
import type { ROUTES, route as restRoute } from './rest'
import {
  MCP_NO_WRITE,
  MCP_PROVENANCE,
  needJson,
  optionalJson,
  pretty,
  REST_CALLER,
  refuseUnknownFields,
  restProvenance,
  vKeyName,
} from './shared'

type McpTool = (typeof TOOLS)[number]
type RestRoute = (typeof ROUTES)[number]

/* machine/rest.ts route(), which types each `run`'s params from its path.
 * Only its type is imported, so this module does not load rest.ts. */
const route: typeof restRoute = (declared) => declared

/* An attachment's description image is the description's to remove, by an
 * edit in the app, so the machine surfaces leave it alone. */
const INLINE_STAYS =
  'this image belongs to the task description; remove it by editing the description in the app'

/* --------------------------------------------------------- attachments */

/**
 * The attachment `ref` (its uuid) of `issue`, which the caller can read,
 * else null. An attachment of another task reads like an unknown one.
 */
async function attachmentOf(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  ref: string,
): Promise<Doc<'issue_attachments'> | null> {
  if (!UUID.test(ref)) return null
  const att = await byId(ctx, 'issue_attachments', ref.toLowerCase())
  return att !== null && att.issue_id === issue.id ? att : null
}

/** Whether the caller holds Edit (or Lead) on the task's project. */
const canEdit = (ctx: QueryCtx, me: Caller, issue: Doc<'issues'>): Promise<boolean> =>
  hasProjectLevel(ctx, me, issue.project_id, 'user')

/* The shape of a media type an upload may declare. The file name rule and
 * the type's length limit are model/attachments.ts's, which every attach
 * checks again. */
const MEDIA_TYPE = /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:\s*;.*)?$/

/* An upload's file name, media type and byte size, from a REST body or MCP
 * arguments. */
function uploadFields(b: Record<string, unknown>): {
  name: string
  content_type?: string
  size: number
} {
  const name = cleanAttachmentName(typeof b.name === 'string' ? b.name : '')
  let content_type: string | undefined
  if (b.content_type !== undefined && b.content_type !== null) {
    const value = typeof b.content_type === 'string' ? b.content_type.trim() : ''
    if (value.length > ATTACHMENT_TYPE_MAX || !MEDIA_TYPE.test(value)) {
      throw badRequest('content_type must be a media type such as application/pdf')
    }
    content_type = value
  }
  if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size < 0) {
    throw badRequest('size must be the file size in bytes, a whole number')
  }
  return { name, content_type, size: b.size }
}

/* GET /v1/tasks/{ref}/attachments, the task's attachments with fresh
 * download links (model/attachments.ts taskAttachments). The single-task
 * read carries the same list. */
export const restListAttachments = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, a): Promise<AttachmentJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    return await taskAttachments(ctx, me, issue)
  },
})

/* POST /v1/tasks/{ref}/attachments {name, content_type?, size} starts an
 * upload (model/attachments.ts startAttachmentUpload). It needs Edit on the
 * task and a declared size within the organization's cap, then answers an
 * upload URL and the ticket that the confirm call names. */
export const restStartUpload = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<{ ticket: string; upload_url: string; expires_at: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await canEdit(ctx, me, issue))) throw forbidden(REST_CALLER[me.kind].noWrite)
    const b = needJson(a.body)
    refuseUnknownFields(b, ['name', 'content_type', 'size'])
    const fields = uploadFields(b)
    const { ticket, uploadUrl } = await startAttachmentUpload(ctx, {
      me,
      issue,
      ...fields,
      nowMs: Date.now(),
    })
    return {
      ticket: ticket.id,
      upload_url: uploadUrl,
      expires_at: new Date(ticket.expires_at).toISOString(),
    }
  },
})

/* POST /v1/tasks/{ref}/attachments/{ticket} {storage_id} attaches the
 * uploaded file (model/attachments.ts confirmAttachmentUpload). An oversize
 * file comes back as a refusal whose byte delete has committed; the route
 * answers it 400. */
export const restConfirmUpload = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    ticket: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a): Promise<{ refused: string } | { attachment: AttachmentJson }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await canEdit(ctx, me, issue))) throw forbidden(REST_CALLER[me.kind].noWrite)
    const b = needJson(a.body)
    refuseUnknownFields(b, ['storage_id'])
    if (typeof b.storage_id !== 'string') throw badRequest(UPLOAD_STORAGE_ID)
    const result: AttachResult = await confirmAttachmentUpload(ctx, {
      me,
      issue,
      ticketId: a.ticket,
      storage_id: b.storage_id,
      nowMs: Date.now(),
      provenance: restProvenance(a.keyName),
    })
    if ('refused' in result) return { refused: result.refused.message }
    return { attachment: await attachmentJson(ctx, me, result.attachment) }
  },
})

/* start_attachment_upload starts an upload by REST's rule (restStartUpload). */
export const mcpStartUpload = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    name: v.string(),
    size: v.number(),
    content_type: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound(`task "${a.ref}" not found (or not visible to you)`)
    if (!(await canEdit(ctx, me, issue))) throw forbidden(MCP_NO_WRITE)
    const fields = uploadFields({ name: a.name, content_type: a.content_type, size: a.size })
    const { ticket, uploadUrl } = await startAttachmentUpload(ctx, {
      me,
      issue,
      ...fields,
      nowMs: Date.now(),
    })
    return pretty({
      ticket: ticket.id,
      upload_url: uploadUrl,
      expires_at: new Date(ticket.expires_at).toISOString(),
    })
  },
})

/* confirm_attachment_upload attaches the uploaded file by REST's rule
 * (restConfirmUpload). An oversize file comes back as a refusal whose byte
 * delete has committed, and the tool answers it as an error result. */
export const mcpConfirmUpload = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    ticket: v.string(),
    storage_id: v.string(),
  },
  handler: async (ctx, a): Promise<{ refused: string } | { text: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound(`task "${a.ref}" not found (or not visible to you)`)
    if (!(await canEdit(ctx, me, issue))) throw forbidden(MCP_NO_WRITE)
    const result = await confirmAttachmentUpload(ctx, {
      me,
      issue,
      ticketId: a.ticket,
      storage_id: a.storage_id,
      nowMs: Date.now(),
      provenance: MCP_PROVENANCE,
    })
    if ('refused' in result) return { refused: result.refused.message }
    return { text: pretty(await attachmentJson(ctx, me, result.attachment)) }
  },
})

/* The largest text attach_text_file stores, in UTF-8 bytes (256 KiB). The
 * organization's per-file limit applies too. */
export const TEXT_FILE_MAX_BYTES = 256 * 1024

/* The media type of a text file attached without one. */
const TEXT_FILE_TYPE = 'text/plain; charset=utf-8'

/* The Convex isolate's Blob, which encodes a string part as UTF-8.
 * convex/env.d.ts declares the type without its constructor. */
declare const Blob: { new (parts: string[], options: { type: string }): Blob }

/* What attach_text_file checks before it stores the text and again when it
 * attaches it, with the text's `size` in UTF-8 bytes. */
const vTextFile = {
  callerId: v.string(),
  access: vCredentialAccess,
  ref: v.string(),
  name: v.string(),
  content_type: v.string(),
  size: v.number(),
}

/**
 * The caller, the task and the file's trimmed name, media type and size for
 * attach_text_file. It refuses in the order of every MCP write, so a
 * read-only credential comes first, then a task the caller cannot read, then
 * one it cannot edit, then the fields.
 */
async function textFileTarget(
  ctx: MutationCtx,
  a: ObjectType<typeof vTextFile>,
): Promise<{ me: Caller; issue: Doc<'issues'> } & ReturnType<typeof uploadFields>> {
  const me = await asMachineCaller(ctx, a.callerId, a.access)
  const issue = await findIssue(ctx, me, a.ref)
  if (issue === null) throw notFound(`task "${a.ref}" not found (or not visible to you)`)
  if (!(await canEdit(ctx, me, issue))) throw forbidden(MCP_NO_WRITE)
  const fields = uploadFields(a)
  if (fields.size > TEXT_FILE_MAX_BYTES) {
    throw badRequest(`text must be at most 256 KiB (${TEXT_FILE_MAX_BYTES} bytes) as UTF-8`)
  }
  return { me, issue, ...fields }
}

/* attach_text_file's check before the text is stored, so a call it refuses
 * stores nothing. */
export const mcpCheckTextFile = internalMutation({
  args: vTextFile,
  handler: async (ctx, a): Promise<null> => {
    await textFileTarget(ctx, a)
    return null
  },
})

/* attach_text_file attaches the stored text by the app's rule
 * (attachFileCore), after the same checks again. A file over the
 * organization's limit comes back as a refusal whose byte delete has
 * committed. */
export const mcpAttachStoredText = internalMutation({
  args: { ...vTextFile, storage_id: v.id('_storage') },
  handler: async (ctx, a): Promise<{ refused: string } | { text: string }> => {
    const { me, issue, name, content_type, size } = await textFileTarget(ctx, a)
    const result = await attachFileCore(ctx, {
      me,
      issue,
      id: newUuid(),
      storage_id: a.storage_id,
      name,
      mime: content_type,
      inline: false,
      now: new Date().toISOString(),
      declaredSize: size,
      provenance: MCP_PROVENANCE,
    })
    if ('refused' in result) return { refused: result.refused.message }
    return { text: pretty(await attachmentJson(ctx, me, result.attachment)) }
  },
})

/**
 * Stores `file` and runs `attach` with its storage id, as http.ts
 * receiveBackground does. When `attach` refuses (a ConvexError), its
 * transaction rolled back and nothing holds the file, so the file is deleted
 * before the refusal is rethrown. Any other failure leaves the file to the
 * weekly sweep, which keeps it if the attach committed after all.
 */
export async function storeThenAttach<Out>(
  storage: Pick<ActionCtx['storage'], 'store' | 'delete'>,
  file: Blob,
  attach: (storageId: Id<'_storage'>) => Promise<Out>,
): Promise<Out> {
  const storageId = await storage.store(file)
  try {
    return await attach(storageId)
  } catch (e) {
    if (e instanceof ConvexError) await storage.delete(storageId)
    throw e
  }
}

/* attach_text_file stores `text` as a UTF-8 file and attaches it to the
 * task. The check runs first, so a refused call stores nothing. Both
 * mutations retry write conflicts and time outs (machine/registry.ts
 * conflictRetrying), as the write runner does for every other tool, and an
 * attach that kept failing so deletes the stored file with its
 * WRITE_CONFLICT refusal.
 * Answers the attachment as get_task lists it. */
export const mcpAttachTextFile = internalAction({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    name: v.string(),
    text: v.string(),
    content_type: v.optional(v.string()),
  },
  handler: async (ctx, { text, content_type = TEXT_FILE_TYPE, ...a }): Promise<string> => {
    const runMutation = conflictRetrying(ctx)
    const file = new Blob([text], { type: content_type })
    const target = { ...a, content_type, size: file.size }
    await runMutation(internal.machine.records.mcpCheckTextFile, target)
    const out = await storeThenAttach(ctx.storage, file, (storage_id) =>
      runMutation(internal.machine.records.mcpAttachStoredText, { ...target, storage_id }),
    )
    // the refusal's byte delete has committed, and an action rolls nothing back
    if ('refused' in out) throw badRequest(out.refused)
    return out.text
  },
})

/* DELETE /v1/tasks/{ref}/attachments/{id} removes a file attachment, row
 * and bytes (model/attachments.ts removeAttachmentCore). By the app's rule,
 * anyone with Edit on the task's project may remove it. */
export const restDeleteAttachment = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    id: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ deleted: true; id: string; name: string; key: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    if (!(await canEdit(ctx, me, issue))) throw forbidden(REST_CALLER[me.kind].noWrite)
    refuseUnknownFields(optionalJson(a.body ?? ''), [])
    const attachment = await attachmentOf(ctx, issue, a.id)
    if (attachment === null) throw notFound('attachment not found')
    if (attachment.inline) throw badRequest(INLINE_STAYS)
    await removeAttachmentCore(ctx, {
      me,
      attachment,
      issue,
      now: new Date().toISOString(),
      provenance: restProvenance(a.keyName),
    })
    return { deleted: true, id: attachment.id, name: attachment.name, key: issueKey(issue.num) }
  },
})

/* delete_attachment removes a file attachment from a task, by the same rule
 * as REST's DELETE. */
export const mcpDeleteAttachment = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    attachment: v.string(),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound(`task "${a.ref}" not found (or not visible to you)`)
    if (!(await canEdit(ctx, me, issue))) throw forbidden(MCP_NO_WRITE)
    const attachment = await attachmentOf(ctx, issue, a.attachment)
    if (attachment === null) {
      throw notFound(`attachment "${a.attachment}" not found on ${issueKey(issue.num)}`)
    }
    if (attachment.inline) throw badRequest(INLINE_STAYS)
    await removeAttachmentCore(ctx, {
      me,
      attachment,
      issue,
      now: new Date().toISOString(),
      provenance: MCP_PROVENANCE,
    })
    return pretty({
      deleted: true,
      key: issueKey(issue.num),
      attachment: attachment.id,
      name: attachment.name,
    })
  },
})

/* ------------------------------------------------------------ activity */

/** One row of a task's history. */
type ActivityJson = {
  id: string
  created_at: string
  actor_id: string | null
  actor_name: string | null
  verb: string
  detail: string | null
}

/* A page of the task's history the caller receives (lib/activityVisibility.ts
 * taskHistoryPage, the app's rule), the newest rows or those before the row
 * `before` names, oldest first, with actor names. An empty page means there
 * is no earlier history the caller receives, so a page that found none with
 * history left refuses with HISTORY_HIDDEN. An actor whose profile is gone
 * reads as null, also on rows a profile removal has not cleared yet
 * (profileRemovals.ts clears older rows in the background). */
async function activityOut(
  ctx: QueryCtx,
  me: Caller,
  issue: Doc<'issues'>,
  before: string | undefined,
): Promise<ActivityJson[]> {
  const anchor = before === undefined ? undefined : await historyAnchor(ctx, issue, before)
  const { rows, earlier } = await taskHistoryPage(ctx, me, issue, anchor)
  if (rows.length === 0 && earlier) throw rule(HISTORY_HIDDEN)
  const names = new Map<string, string | null>()
  const out: ActivityJson[] = []
  for (const ev of rows) {
    const actor = ev.actor_id
    if (actor !== undefined && !names.has(actor)) {
      names.set(actor, (await byId(ctx, 'profiles', actor))?.name ?? null)
    }
    const name = actor === undefined ? null : (names.get(actor) ?? null)
    out.push({
      id: ev.id,
      created_at: ev.ts,
      actor_id: name === null ? null : (actor ?? null),
      actor_name: name,
      verb: ev.verb,
      detail: ev.detail ?? null,
    })
  }
  return out
}

/* GET /v1/tasks/{ref}/activity?before=, a page of the task's history. */
export const restTaskActivity = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    before: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<ActivityJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    return await activityOut(ctx, me, issue, a.before)
  },
})

/* list_task_activity, a page of the task's history. */
export const mcpTaskActivity = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    before: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound(`task "${a.ref}" not found (or not visible to you)`)
    return pretty(await activityOut(ctx, me, issue, a.before))
  },
})

/* ------------------------------------------------------------ workload */

/* How many weeks a workload read covers by default, and at most. */
const WORKLOAD_WEEKS = 8
const WORKLOAD_WEEKS_MAX = 52
const weeksSentence = `weeks must be a whole number from 1 to ${WORKLOAD_WEEKS_MAX}`

/* The workload window, which starts at `from_week` (any day of the first
 * week) or else the week of `today`, the request's UTC day, and runs for
 * the number of weeks. */
function workloadWindow(
  today: string,
  from: string | undefined,
  weeks: number | undefined,
): { fromDay: string; weeks: number } {
  const fromDay =
    from === undefined
      ? today
      : calendarDay(from, {
          shape: 'from_week must be YYYY-MM-DD',
          date: 'from_week must be a valid calendar date',
        })
  const count = weeks ?? WORKLOAD_WEEKS
  if (!Number.isInteger(count) || count < 1 || count > WORKLOAD_WEEKS_MAX) {
    throw badRequest(weeksSentence)
  }
  return { fromDay, weeks: count }
}

/* A project the caller can see, by uuid, number or key, or null when the
 * read is not limited to one; `missing` words the refusal. */
async function workloadProject(
  ctx: QueryCtx,
  me: Caller,
  ref: string | undefined,
  missing: (ref: string) => ConvexError<Refusal>,
): Promise<Doc<'projects'> | null> {
  if (ref === undefined || ref === '') return null
  const project = await findProject(ctx, me, ref)
  if (project === null || !(await canSeeProject(ctx, me, project))) throw missing(ref)
  return project
}

/* GET /v1/workload?from_week=&weeks=&project= (planning.ts workloadCore).
 * Query values arrive as raw strings. */
export const restWorkload = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    today: v.string(),
    from_week: v.optional(v.string()),
    weeks: v.optional(v.string()),
    project: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<WorkloadJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const weeks =
      a.weeks === undefined || a.weeks === ''
        ? undefined
        : /^\d+$/.test(a.weeks)
          ? Number(a.weeks)
          : Number.NaN
    const window = workloadWindow(a.today, a.from_week || undefined, weeks)
    const project = await workloadProject(ctx, me, a.project, () => notFound('project not found'))
    return await workloadCore(ctx, me, { ...window, project })
  },
})

/* get_workload (planning.ts workloadCore). */
export const mcpWorkload = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    today: v.string(),
    from_week: v.optional(v.string()),
    weeks: v.optional(v.number()),
    project: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const window = workloadWindow(a.today, a.from_week, a.weeks)
    const project = await workloadProject(ctx, me, a.project, (ref) =>
      notFound(`project "${ref}" not found (or not visible to you)`),
    )
    return pretty(await workloadCore(ctx, me, { ...window, project }))
  },
})

/* -------------------------------------------------------------- entries */

export const RECORD_TOOLS: McpTool[] = [
  {
    access: 'write',
    def: {
      name: 'delete_attachment',
      title: 'Delete attachment',
      description:
        "Delete a file attached to a task, by `ref` and the `attachment` id from get_task's `attachments`. Needs Edit access to the task's project. Description images (`inline: true`) are left to the app.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          attachment: {
            type: 'string',
          },
        },
        required: ['ref', 'attachment'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.records.mcpDeleteAttachment, {
        callerId,
        access,
        ...(args as { ref: string; attachment: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'start_attachment_upload',
      title: 'Start attachment upload',
      description:
        "Start attaching a file to the task `ref`. Give the file `name`, its exact `size` in bytes and optionally its `content_type`. Answers an `upload_url` and a `ticket`, valid for an hour. Send exactly `size` bytes, the file's, to `upload_url` in one HTTP POST with the file's type as Content-Type and no Authorization header, for example `curl -X POST -H 'Content-Type: application/pdf' --data-binary @wiring.pdf '<upload_url>'`. Then call confirm_attachment_upload with the `storageId` it answers. Needs Edit access to the task's project.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: ATTACHMENT_NAME_MAX,
          },
          size: {
            type: 'integer',
            minimum: 0,
          },
          content_type: {
            type: 'string',
            maxLength: ATTACHMENT_TYPE_MAX,
          },
        },
        required: ['ref', 'name', 'size'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.records.mcpStartUpload, {
        callerId,
        access,
        ...(args as { ref: string; name: string; size: number; content_type?: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'confirm_attachment_upload',
      title: 'Confirm attachment upload',
      description:
        'Attach the file sent to the upload_url from start_attachment_upload. Give the task `ref`, the `ticket` and the `storageId` the upload answered as `storage_id`. Only the same user can confirm it, for the same task and once. Answers the attachment as get_task lists it.',
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          ticket: {
            type: 'string',
          },
          storage_id: {
            type: 'string',
          },
        },
        required: ['ref', 'ticket', 'storage_id'],
      },
    },
    run: async (r, { callerId, access, args }) => {
      const out = await r.runMutation(internal.machine.records.mcpConfirmUpload, {
        callerId,
        access,
        ...(args as { ref: string; ticket: string; storage_id: string }),
      })
      // the refusal's byte delete has committed; answer it as an error result
      if ('refused' in out) throw badRequest(out.refused)
      return out.text
    },
  },
  {
    access: 'write',
    def: {
      name: 'attach_text_file',
      title: 'Attach text file',
      description:
        "Attach a text file you write yourself, such as notes, a CSV table or a log, to the task `ref`. Give the file `name`, its `text` and optionally its `content_type` (default `text/plain; charset=utf-8`). Qivo stores the text as UTF-8, at most 256 KiB and within the organization's per-file limit. To attach a file that already exists, use start_attachment_upload. Needs Edit access to the task's project. Answers the attachment as get_task lists it.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: ATTACHMENT_NAME_MAX,
          },
          text: {
            type: 'string',
          },
          content_type: {
            type: 'string',
            maxLength: ATTACHMENT_TYPE_MAX,
          },
        },
        required: ['ref', 'name', 'text'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runAction(internal.machine.records.mcpAttachTextFile, {
        callerId,
        access,
        ...(args as { ref: string; name: string; text: string; content_type?: string }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'list_task_activity',
      title: 'List task activity',
      description: `A task's newest history, oldest first: who changed what and when, as the app's Activity shows it. A page holds at most ${HISTORY_PAGE_MAX} rows. To read further back, pass the first row's \`id\` as \`before\`. An empty list means there is no earlier history. Comments are in list_comments.`,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          before: {
            type: 'string',
          },
        },
        required: ['ref'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.records.mcpTaskActivity, {
        callerId,
        access,
        ...(args as { ref: string; before?: string }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'get_workload',
      title: 'Get workload',
      description:
        "Each person's planned hours per week against their `plannable_hours`, from the week holding `from_week` (default this week) for `weeks` weeks (default 8). `project` limits it to one project. `hours` includes work in projects hidden from you; `hidden_hours` is that part, unnamed.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          from_week: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          weeks: {
            type: 'integer',
            minimum: 1,
            maximum: WORKLOAD_WEEKS_MAX,
          },
          project: {
            type: 'string',
          },
        },
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.records.mcpWorkload, {
        callerId,
        access,
        today: utcToday(),
        ...(args as { from_week?: string; weeks?: number; project?: string }),
      }),
  },
]

export const RECORD_ROUTES: RestRoute[] = [
  route({
    method: 'GET',
    path: 'tasks/:ref/attachments',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runQuery(internal.machine.records.restListAttachments, {
        callerId,
        access,
        ref: param('ref'),
      }),
  }),
  route({
    method: 'POST',
    path: 'tasks/:ref/attachments',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.records.restStartUpload, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'POST',
    path: 'tasks/:ref/attachments/:ticket',
    access: 'write',
    status: 201,
    run: async (r, { callerId, access, keyName, param, body }) => {
      const out = await r.runMutation(internal.machine.records.restConfirmUpload, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        ticket: param('ticket'),
        body,
      })
      // the refusal's byte delete has committed; answer it like any 400
      if ('refused' in out) throw badRequest(out.refused)
      return out.attachment
    },
  }),
  route({
    method: 'DELETE',
    path: 'tasks/:ref/attachments/:id',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.records.restDeleteAttachment, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        id: param('id'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'tasks/:ref/activity',
    access: 'read',
    status: 200,
    query: ['before'],
    run: (r, { callerId, access, param, query }) =>
      r.runQuery(internal.machine.records.restTaskActivity, {
        callerId,
        access,
        ref: param('ref'),
        before: query('before'),
      }),
  }),
  route({
    method: 'GET',
    path: 'workload',
    access: 'read',
    status: 200,
    query: ['from_week', 'weeks', 'project'],
    run: (r, { callerId, access, query }) =>
      r.runQuery(internal.machine.records.restWorkload, {
        callerId,
        access,
        today: utcToday(),
        from_week: query('from_week'),
        weeks: query('weeks'),
        project: query('project'),
      }),
  }),
]
