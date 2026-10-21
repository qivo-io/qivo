/* Attachments, task activity and workload over REST and MCP
 * (machine/records.ts), through the app's shared rules.
 *
 *   1. Attachments in the single-task read and the REST list: fields, the
 *      download link minted for the reader (which the /files gateway serves
 *      and stops serving once the reader loses the project) and hidden tasks.
 *   2. Removing an attachment: the app's Edit rule, an attachment of another
 *      task, description images left to the app, the activity row.
 *   3. The REST upload: the ticket the start records, an upload URL that
 *      stores one file of the declared size, and a confirm that must match
 *      the caller, the task, the expiry and the file that URL stored, with
 *      the organization's cap measured from the stored file; expired
 *      tickets are reaped. The MCP upload
 *      tools run the same rules over a personal token, and a ticket confirms
 *      on either surface. attach_text_file stores text as UTF-8 within 256
 *      KiB and the cap, refuses before it stores anything, and deletes what
 *      it stored when the attach refuses.
 *   4. Task activity: the app's visibility rule for members, every row for
 *      organization admins.
 *   5. Workload: the app's spread rule, the anonymized hidden hours, a
 *      project limit, the week grid and the input checks. */

import { ConvexError } from 'convex/values'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { verifyFileToken } from '../lib/fileTokens'
import type { Refusal, RefusalCode } from '../lib/functions'
import { attachmentTooLarge, LIMITS } from '../lib/limits'
import { weekGrid, weeksSpreadSoFar } from '../lib/workload'
import { sha256hex } from '../machine/auth'
import { storeThenAttach } from '../machine/records'
import { MEDIA_TYPE_TOO_LONG, readExactly, UPLOAD_TOO_SLOW } from '../machine/uploads'
import {
  UPLOAD_CLAIM_MS,
  UPLOAD_NOT_SENT,
  UPLOAD_STORAGE_ID,
  UPLOAD_TICKET_MISSING,
  UPLOAD_URL_USED,
  uploadSizeWrong,
} from '../model/attachments'
import {
  activityFor,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  reap,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob and TextEncoder; convex/tsconfig's ESNext-only
 * lib does not declare them. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
  arrayBuffer(): Promise<ArrayBuffer>
}
declare class TextEncoder {
  encode(input: string): Uint8Array
}

/* fileTokens reads these lazily (attachments.test.ts plants the same). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

const MiB = 1024 * 1024
const AGENT_NO_WRITE = 'this agent has no write access to that project'
const PERSON_NO_WRITE = 'your account has no write access to that project'
const INLINE_STAYS =
  'this image belongs to the task description; remove it by taking it out of the description'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

type Fx = OrgFixture & {
  t: T
  /** a sub-project of the project the agent cannot see */
  hiddenSub: Doc<'projects'>
  /** an agent key, for the requests made over HTTP */
  agentKey: string
}

/* withOrg, with the agent holding Edit on TBED (FW, PCB) and nothing on
 * SKNK. The Viewer person holds Edit on TBED, capped to reading by the role. */
async function setup(): Promise<Fx> {
  const t = newT()
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  const hiddenSub = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.hidden.id,
    key: 'SKS',
    name: 'Skunk sub',
  })
  const agentKey = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(agentKey)
  await t.run((ctx) =>
    ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: f.agent.id,
      name: 'CI key',
      key_prefix: agentKey.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return { t, ...f, hiddenSub, agentKey }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> & { project_id?: string } = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

const storeFile = (t: T, bytes: number, type?: string): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([new Uint8Array(bytes)]) as never)
    if (type !== undefined) await ctx.db.patch(id as never, { contentType: type } as never)
    return id
  })

async function plantAttachment(
  fx: Fx,
  issue: Doc<'issues'>,
  over: Partial<Doc<'issue_attachments'>> = {},
): Promise<Doc<'issue_attachments'>> {
  const storage_id = await storeFile(fx.t, over.size_bytes ?? 12)
  return await fx.t.run(async (ctx) => {
    const _id = await ctx.db.insert('issue_attachments', {
      id: uuid(),
      org_id: issue.org_id,
      issue_id: issue.id,
      name: 'spec.pdf',
      size_bytes: 12,
      mime: 'application/pdf',
      storage_id,
      inline: false,
      uploaded_by: fx.user.id,
      created_at: NOW,
      ...over,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_attachments'>
  })
}

const attachmentRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('issue_attachments')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const storageExists = (t: T, id: Id<'_storage'>) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null)

const tickets = (t: T) => t.run((ctx) => ctx.db.query('attachment_uploads').collect())

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }
type Res = { status: number; text: string }

async function fetchPath(t: T, path: string, init: FetchInit = {}): Promise<Res> {
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, init)
  return { status: res.status, text: await res.text() }
}

const rest = (fx: Fx, method: string, path: string, body?: unknown) =>
  fetchPath(fx.t, path, {
    method,
    headers: { Authorization: `Bearer ${fx.agentKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/* POSTs `size` bytes, or `body`, to the upload URL `uploadUrl`, as a client
 * would. Answers the status and the parsed answer. */
async function send(
  t: T,
  uploadUrl: string,
  size: number,
  o: { type?: string; body?: Uint8Array; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: { storageId?: Id<'_storage'>; error?: string } }> {
  const url = new URL(uploadUrl)
  const res = await fetchPath(t, `${url.pathname}${url.search}`, {
    method: 'POST',
    headers: { 'Content-Type': o.type ?? 'application/octet-stream', ...o.headers },
    body: o.body ?? new Uint8Array(size),
  })
  return { status: res.status, json: JSON.parse(res.text) }
}

/* The file the upload URL `uploadUrl` stores from `size` bytes. */
async function upload(t: T, uploadUrl: string, size: number, type?: string) {
  const res = await send(t, uploadUrl, size, { type })
  if (res.json.storageId === undefined) throw new Error(`upload failed: ${res.json.error}`)
  return res.json.storageId
}

const storageRows = (t: T) => t.run((ctx) => ctx.db.system.query('_storage').collect())

/* A personal token of `profile` with `access`, for the MCP requests. */
async function personalToken(
  t: T,
  profile: Doc<'profiles'>,
  access: 'read' | 'write',
): Promise<string> {
  const secret = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const token_hash = await sha256hex(secret)
  await t.run((ctx) =>
    ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: profile.id,
      name: `${access} token`,
      token_prefix: secret.slice(0, 11),
      token_hash,
      access,
      created_at: NOW,
    }),
  )
  return secret
}

/* The JSON-RPC body of one tools/call on the modern leg. */
const toolCall = (name: string, args: Record<string, unknown>): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })

/* POSTs `body`, a tools/call of the tool `name`, to /mcp with `secret`. */
const postTool = (t: T, secret: string, name: string, body: string | Uint8Array) =>
  fetchPath(t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body,
  })

/* One MCP tools/call with `secret` on the modern leg. Answers the tool's
 * text and whether it is an error result. */
async function mcpTool(
  t: T,
  secret: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = await postTool(t, secret, name, toolCall(name, args))
  expect(res.status, res.text).toBe(200)
  const { result } = JSON.parse(res.text) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return { text: result.content[0].text, isError: result.isError === true }
}

/* The bytes the /files gateway serves for an attachment's download link. */
async function download(t: T, link: string): Promise<Uint8Array> {
  const url = new URL(link)
  const res = await (
    t as unknown as {
      fetch(path: string): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>
    }
  ).fetch(`${url.pathname}${url.search}`)
  expect(res.status).toBe(200)
  return new Uint8Array(await res.arrayBuffer())
}

/* How many files storage holds. */
const storedFiles = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)

const attachmentRows = (t: T) => t.run((ctx) => ctx.db.query('issue_attachments').collect())

/* ------------------------------------------------------ 1. attachments */

describe('attachments in the single-task read', () => {
  it('lists every attachment oldest first, with a link minted for the reader', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const later = await plantAttachment(fx, issue, {
      name: 'later.png',
      mime: 'image/png',
      inline: true,
      created_at: '2026-01-02T00:00:00.000Z',
    })
    const first = await plantAttachment(fx, issue, { created_at: '2026-01-01T00:00:00.000Z' })
    const before = Math.floor(Date.now() / 1000)
    const got = await fx.t.query(internal.machine.rest.getIssue, {
      today: TODAY,
      callerId: fx.agent.id,
      access: 'read',
      ref: `QN-${issue.num}`,
    })
    const after = Math.floor(Date.now() / 1000)
    expect(got.attachments.map((a) => a.id)).toEqual([first.id, later.id])
    const [file, image] = got.attachments
    expect(file).toMatchObject({
      name: 'spec.pdf',
      size_bytes: 12,
      content_type: 'application/pdf',
      inline: false,
      uploaded_by_id: fx.user.id,
      uploaded_by_name: 'user',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    expect(image.inline).toBe(true)
    // The link names the reader as its minter and expires ten minutes after a
    // second within the call. A slow call can span several seconds, so the
    // bounds are the seconds read before and after it.
    const url = new URL(file.url)
    expect(url.pathname).toBe(`/files/${first.id}`)
    expect(url.searchParams.get('m')).toBe(fx.agent.id)
    const exp = Number(url.searchParams.get('e'))
    expect(exp - before).toBeGreaterThanOrEqual(600)
    expect(exp - after).toBeLessThanOrEqual(600)
    expect(file.url_expires_at).toBe(new Date(exp * 1000).toISOString())
    expect(
      await verifyFileToken({
        kind: 'attachment',
        id: first.id,
        minter: fx.agent.id,
        exp,
        token: url.searchParams.get('t') ?? '',
      }),
    ).toBe(true)
    // MCP get_task and the REST list carry the same list
    const viaMcp = JSON.parse(
      await fx.t.query(internal.machine.mcp.getIssue, {
        today: TODAY,
        callerId: fx.agent.id,
        access: 'read',
        ref: issue.id,
      }),
    ) as { attachments: { id: string }[] }
    expect(viaMcp.attachments.map((a) => a.id)).toEqual([first.id, later.id])
    const listed = await fx.t.query(internal.machine.records.restListAttachments, {
      callerId: fx.agent.id,
      access: 'read',
      ref: issue.id,
    })
    expect(listed.map((a) => a.id)).toEqual([first.id, later.id])
  })

  it('serves the link through the gateway until the reader loses the project', async () => {
    const fx = await setup()
    const issue = await task(fx)
    await plantAttachment(fx, issue, { size_bytes: 12 })
    const [att] = await fx.t.query(internal.machine.records.restListAttachments, {
      callerId: fx.agent.id,
      access: 'read',
      ref: issue.id,
    })
    const url = new URL(att.url)
    const ok = await fetchPath(fx.t, `${url.pathname}${url.search}`)
    expect(ok.status).toBe(200)
    expect(ok.text.length).toBe(12)
    await fx.t.run(async (ctx) => {
      for (const grant of await ctx.db.query('project_access').collect()) {
        if (grant.profile_id === fx.agent.id) await ctx.db.delete(grant._id)
      }
    })
    expect((await fetchPath(fx.t, `${url.pathname}${url.search}`)).status).toBe(404)
  })

  it('answers a hidden task like an unknown one', async () => {
    const fx = await setup()
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    await plantAttachment(fx, hidden)
    await refused(
      fx.t.query(internal.machine.records.restListAttachments, {
        callerId: fx.agent.id,
        access: 'read',
        ref: hidden.id,
      }),
      'not_found',
      'task not found',
    )
    expect((await rest(fx, 'GET', `/v1/tasks/QN-${hidden.num}/attachments`)).status).toBe(404)
  })
})

/* --------------------------------------------------------- 2. removing */

describe('removing an attachment', () => {
  const restDelete = (fx: Fx, callerId: string, ref: string, id: string) =>
    fx.t.mutation(internal.machine.records.restDeleteAttachment, {
      callerId,
      access: 'write',
      keyName: 'CI key',
      ref,
      id,
    })
  const mcpDelete = (fx: Fx, callerId: string, ref: string, attachment: string) =>
    fx.t.mutation(internal.machine.records.mcpDeleteAttachment, {
      callerId,
      access: 'write',
      ref,
      attachment,
    })

  it('deletes the row and bytes and writes the signed activity row', async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Wire the harness' })
    const att = await plantAttachment(fx, issue)
    expect(await restDelete(fx, fx.agent.id, `QN-${issue.num}`, att.id)).toEqual({
      deleted: true,
      id: att.id,
      name: 'spec.pdf',
      key: `QN-${issue.num}`,
    })
    expect(await attachmentRow(fx.t, att.id)).toBeNull()
    expect(await storageExists(fx.t, att.storage_id)).toBe(false)
    const [row] = await activityFor(fx.t, fx.org.id)
    expect(row).toMatchObject({
      actor_id: fx.agent.id,
      verb: 'removed an attachment from',
      target_id: issue.id,
      detail: 'spec.pdf, via the REST API (CI key)',
    })
    // MCP signs its own way
    const other = await plantAttachment(fx, issue, { name: 'b.txt' })
    expect(JSON.parse(await mcpDelete(fx, fx.agent.id, issue.id, other.id))).toEqual({
      deleted: true,
      key: `QN-${issue.num}`,
      attachment: other.id,
      name: 'b.txt',
    })
    expect((await activityFor(fx.t, fx.org.id)).at(-1)?.detail).toBe('b.txt, via MCP')
  })

  it('needs Edit on the project, as in the app', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const att = await plantAttachment(fx, issue)
    // the Viewer person reads the task but cannot edit it
    await refused(restDelete(fx, fx.viewer.id, issue.id, att.id), 'forbidden', PERSON_NO_WRITE)
    await refused(mcpDelete(fx, fx.viewer.id, issue.id, att.id), 'forbidden', PERSON_NO_WRITE)
    // an agent with View on the project only
    await fx.t.run(async (ctx) => {
      const grant = (await ctx.db.query('project_access').collect()).find(
        (g) => g.profile_id === fx.agent.id,
      )
      if (grant) await ctx.db.patch(grant._id, { level: 'viewer' })
    })
    await refused(restDelete(fx, fx.agent.id, issue.id, att.id), 'forbidden', AGENT_NO_WRITE)
    expect(await attachmentRow(fx.t, att.id)).not.toBeNull()
  })

  it('answers a hidden task, another task and an unknown id like missing ones', async () => {
    const fx = await setup()
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    const hiddenAtt = await plantAttachment(fx, hidden)
    await refused(
      restDelete(fx, fx.agent.id, hidden.id, hiddenAtt.id),
      'not_found',
      'task not found',
    )
    await refused(
      mcpDelete(fx, fx.agent.id, `QN-${hidden.num}`, hiddenAtt.id),
      'not_found',
      `task "QN-${hidden.num}" not found (or not visible to you)`,
    )
    // an attachment of another task the caller can edit
    const a = await task(fx)
    const b = await task(fx)
    const onB = await plantAttachment(fx, b)
    await refused(restDelete(fx, fx.agent.id, a.id, onB.id), 'not_found', 'attachment not found')
    await refused(
      mcpDelete(fx, fx.agent.id, a.id, 'nope'),
      'not_found',
      `attachment "nope" not found on QN-${a.num}`,
    )
    expect(await attachmentRow(fx.t, onB.id)).not.toBeNull()
  })

  it('leaves description images to the app', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const image = await plantAttachment(fx, issue, { inline: true, name: 'shot.png' })
    await refused(restDelete(fx, fx.agent.id, issue.id, image.id), 'bad_request', INLINE_STAYS)
    await refused(mcpDelete(fx, fx.agent.id, issue.id, image.id), 'bad_request', INLINE_STAYS)
    expect(await attachmentRow(fx.t, image.id)).not.toBeNull()
  })
})

/* ---------------------------------------------------------- 3. uploads */

describe('the REST upload', () => {
  const start = (fx: Fx, ref: string, body: unknown, callerId = fx.agent.id) =>
    fx.t.mutation(internal.machine.records.restStartUpload, {
      callerId,
      access: 'write',
      ref,
      body: JSON.stringify(body),
    })
  const confirm = (fx: Fx, ref: string, ticket: string, body: unknown, callerId = fx.agent.id) =>
    fx.t.mutation(internal.machine.records.restConfirmUpload, {
      callerId,
      access: 'write',
      keyName: 'CI key',
      ref,
      ticket,
      body: JSON.stringify(body),
    })

  it('records a ticket for the caller and task, then attaches the uploaded file once', async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Wire the harness' })
    const before = Date.now()
    const started = await start(fx, `QN-${issue.num}`, {
      name: ' wiring.pdf ',
      content_type: 'application/pdf',
      size: 2048,
    })
    expect(started.upload_url).toMatch(
      new RegExp(`^https://[^/]+/attachment-uploads/${started.ticket}\\?e=\\d+&m=`),
    )
    const [ticket] = await tickets(fx.t)
    expect(ticket).toMatchObject({
      id: started.ticket,
      org_id: fx.org.id,
      profile_id: fx.agent.id,
      issue_id: issue.id,
      name: 'wiring.pdf',
      content_type: 'application/pdf',
      size_bytes: 2048,
    })
    expect(ticket.expires_at - before).toBeGreaterThanOrEqual(60 * 60 * 1000)
    expect(started.expires_at).toBe(new Date(ticket.expires_at).toISOString())
    const stored = await upload(fx.t, started.upload_url, 2048)
    const out = await confirm(fx, issue.id, started.ticket, { storage_id: stored })
    if (!('attachment' in out)) throw new Error('expected an attachment')
    expect(out.attachment).toMatchObject({
      name: 'wiring.pdf',
      size_bytes: 2048,
      content_type: 'application/pdf',
      inline: false,
      uploaded_by_id: fx.agent.id,
      uploaded_by_name: 'Relay',
    })
    expect(new URL(out.attachment.url).searchParams.get('m')).toBe(fx.agent.id)
    expect(await tickets(fx.t)).toEqual([])
    const row = await attachmentRow(fx.t, out.attachment.id)
    expect(row).toMatchObject({
      storage_id: stored,
      issue_id: issue.id,
      org_id: fx.org.id,
      uploaded_by: fx.agent.id,
    })
    expect((await activityFor(fx.t, fx.org.id)).at(-1)).toMatchObject({
      verb: 'attached a file to',
      detail: 'wiring.pdf, via the REST API (CI key)',
    })
    // the ticket is spent, and so is its upload URL
    await refused(
      confirm(fx, issue.id, started.ticket, { storage_id: stored }),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    expect(await send(fx.t, started.upload_url, 2048)).toEqual({
      status: 404,
      json: { error: UPLOAD_TICKET_MISSING },
    })
    expect(await storageRows(fx.t)).toHaveLength(1)
  })

  it('refuses a ticket of another caller, another task or past its expiry alike', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const other = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'a.txt', size: 4 })
    const stored = await upload(fx.t, upload_url, 4)
    // the admin can edit the task too, but the ticket is the agent's
    await refused(
      confirm(fx, issue.id, ticket, { storage_id: stored }, fx.admin.id),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    await refused(
      confirm(fx, other.id, ticket, { storage_id: stored }),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    await refused(
      confirm(fx, issue.id, uuid(), { storage_id: stored }),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    await fx.t.run(async (ctx) => {
      const [row] = await ctx.db.query('attachment_uploads').collect()
      await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
    })
    await refused(
      confirm(fx, issue.id, ticket, { storage_id: stored }),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    expect(await storageExists(fx.t, stored)).toBe(true)
    expect(await fx.t.run((ctx) => ctx.db.query('issue_attachments').collect())).toEqual([])
  })

  it('stores one file per upload URL however often it is sent to', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'a.txt', size: 5 })
    const first = await send(fx.t, upload_url, 5, { type: 'text/plain' })
    expect(first.status).toBe(200)
    for (let i = 0; i < 4; i++) {
      expect(await send(fx.t, upload_url, 5)).toEqual({
        status: 409,
        json: { error: UPLOAD_URL_USED },
      })
    }
    // two at once: one claims the URL, the other is refused before it stores
    const second = await start(fx, issue.id, { name: 'b.txt', size: 5 })
    const both = await Promise.all([
      send(fx.t, second.upload_url, 5),
      send(fx.t, second.upload_url, 5),
    ])
    expect(both.map((r) => r.status).sort()).toEqual([200, 409])
    const files = await storageRows(fx.t)
    expect(files.map((f) => f._id).sort()).toEqual(
      [first.json.storageId, both.find((r) => r.status === 200)?.json.storageId].sort(),
    )
    const out = await confirm(fx, issue.id, ticket, { storage_id: first.json.storageId })
    expect(out).toMatchObject({ attachment: { name: 'a.txt', size_bytes: 5 } })
  })

  it('refuses a forged, altered or expired upload URL before it reads anything', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { upload_url } = await start(fx, issue.id, { name: 'a.txt', size: 4 })
    const other = await start(fx, issue.id, { name: 'b.txt', size: 4 })
    const missing = { status: 404, json: { error: UPLOAD_TICKET_MISSING } }
    const exp = Number(/[?&]e=(\d+)/.exec(upload_url)?.[1])
    for (const forged of [
      upload_url.replace(/([?&]t=)[^&]+/, `$1${'A'.repeat(43)}`),
      upload_url.replace(/([?&]m=)[^&]+/, `$1${fx.admin.id}`),
      upload_url.replace(/([?&]e=)\d+/, `$1${exp + 60}`),
      // another ticket's token does not open this one
      upload_url.replace(/attachment-uploads\/[^?]+/, `attachment-uploads/${other.ticket}`),
      upload_url.replace(/&t=[^&]+/, ''),
    ]) {
      expect(forged).not.toBe(upload_url)
      expect(await send(fx.t, forged, 4)).toEqual(missing)
    }
    await fx.t.run(async (ctx) => {
      for (const row of await ctx.db.query('attachment_uploads').collect()) {
        await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
      }
    })
    expect(await send(fx.t, upload_url, 4)).toEqual(missing)
    expect(await storageRows(fx.t)).toEqual([])
    expect((await tickets(fx.t)).every((r) => r.upload_started_at === undefined)).toBe(true)
  })

  it('stores only the declared number of bytes, and a refused POST leaves the URL usable', async () => {
    const fx = await setup()
    const issue = await task(fx)
    // the organization allows 10 MiB
    await refused(
      start(fx, issue.id, { name: 'big.bin', size: 10 * MiB + 1 }),
      'rule',
      attachmentTooLarge(10),
    )
    expect(await tickets(fx.t)).toEqual([])
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'a.bin', size: 100 })
    const wrong = { status: 400, json: { error: uploadSizeWrong(100) } }
    expect(await send(fx.t, upload_url, 99)).toEqual(wrong)
    expect(await send(fx.t, upload_url, 101)).toEqual(wrong)
    expect(await send(fx.t, upload_url, 10 * MiB + 1)).toEqual(wrong)
    // a declared length that differs is refused before the body is read
    expect(await send(fx.t, upload_url, 100, { headers: { 'Content-Length': '99' } })).toEqual(
      wrong,
    )
    expect(await storageRows(fx.t)).toEqual([])
    const [row] = await tickets(fx.t)
    expect(row.upload_started_at).toBeUndefined()
    // without a declared type the upload's own becomes the attachment's,
    // and it has the same length limit; convex-test's storage records no
    // type, so the test sets the one Convex would
    const typed = await upload(fx.t, upload_url, 100)
    await fx.t.run((ctx) =>
      ctx.db.patch(typed as never, { contentType: `application/${'x'.repeat(244)}` } as never),
    )
    await refused(
      confirm(fx, issue.id, ticket, { storage_id: typed }),
      'rule',
      LIMITS.mediaType.refusal,
    )
    expect(await storageExists(fx.t, typed)).toBe(true)
    expect(await tickets(fx.t)).toHaveLength(1)
    expect(await fx.t.run((ctx) => ctx.db.query('issue_attachments').collect())).toEqual([])
  })

  it('deletes a file of the declared size over a cap lowered since the start, and spends the ticket', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'six.bin', size: 6 * MiB })
    const six = await upload(fx.t, upload_url, 6 * MiB)
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: 5 }))
    expect(await confirm(fx, issue.id, ticket, { storage_id: six })).toEqual({
      refused: attachmentTooLarge(5),
    })
    expect(await storageExists(fx.t, six)).toBe(false)
    expect(await tickets(fx.t)).toEqual([])
    expect(await fx.t.run((ctx) => ctx.db.query('issue_attachments').collect())).toEqual([])
  })

  it('accepts only the file its upload URL stored, and never deletes another', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'six.bin', size: 6 * MiB })
    // a file stored after the ticket, of its size, but not through its URL
    const elsewhere = await storeFile(fx.t, 6 * MiB)
    const sibling = await start(fx, issue.id, { name: 'other.bin', size: 6 * MiB })
    const siblings = await upload(fx.t, sibling.upload_url, 6 * MiB)
    // before the upload has stored anything
    for (const storage_id of [elsewhere, siblings]) {
      await refused(confirm(fx, issue.id, ticket, { storage_id }), 'bad_request', UPLOAD_NOT_SENT)
    }
    const mine = await upload(fx.t, upload_url, 6 * MiB)
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: 5 }))
    for (const storage_id of [elsewhere, siblings, 'not-an-id']) {
      await refused(confirm(fx, issue.id, ticket, { storage_id }), 'bad_request', UPLOAD_STORAGE_ID)
    }
    await refused(confirm(fx, issue.id, ticket, {}), 'bad_request', UPLOAD_STORAGE_ID)
    expect(await storageExists(fx.t, elsewhere)).toBe(true)
    expect(await storageExists(fx.t, siblings)).toBe(true)
    // the ticket is still usable for the file its upload stored
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: 10 }))
    const out = await confirm(fx, issue.id, ticket, { storage_id: mine })
    expect(out).toMatchObject({ attachment: { name: 'six.bin', size_bytes: 6 * MiB } })
  })

  it('frees a URL whose POST failed, and never lets two POSTs hold one ticket', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'a.bin', size: 3 })
    const minter = fx.agent.id
    const call = {
      begin: (attempt: string) =>
        fx.t.mutation(internal.machine.uploads.begin, { ticket, minter, attempt }),
      finish: (attempt: string, storage_id: Id<'_storage'>) =>
        fx.t.mutation(internal.machine.uploads.finish, { ticket, minter, attempt, storage_id }),
      abandon: (attempt: string, storage_id?: Id<'_storage'>) =>
        fx.t.mutation(internal.machine.uploads.abandon, { ticket, minter, attempt, storage_id }),
    }
    // begin committed but its answer never reached the POST: the POST's own
    // cleanup frees the URL, and another POST's cleanup does not
    await call.begin('a')
    await refused(call.begin('b'), 'conflict', UPLOAD_URL_USED)
    await call.abandon('b')
    await refused(call.begin('c'), 'conflict', UPLOAD_URL_USED)
    await call.abandon('a')
    expect((await tickets(fx.t))[0].upload_started_at).toBeUndefined()
    // a POST that failed after it stored a file: the file goes, the URL frees
    await call.begin('d')
    const failed = await storeFile(fx.t, 3)
    await call.abandon('d', failed)
    expect(await storageExists(fx.t, failed)).toBe(false)
    // a POST whose runtime stopped holds the URL for UPLOAD_CLAIM_MS at most;
    // then another takes it, and the first one's late file is deleted
    await call.begin('e')
    await fx.t.run(async (ctx) => {
      const [row] = await ctx.db.query('attachment_uploads').collect()
      await ctx.db.patch(row._id, { upload_started_at: Date.now() - UPLOAD_CLAIM_MS - 1 })
    })
    await call.begin('f')
    const late = await storeFile(fx.t, 3)
    expect(await call.finish('e', late)).toBe(false)
    expect(await storageExists(fx.t, late)).toBe(false)
    // a file another row holds is never deleted
    const held = await plantAttachment(fx, issue, { size_bytes: 3 })
    expect(await call.finish('f', held.storage_id)).toBe(false)
    await call.abandon('f', held.storage_id)
    expect(await storageExists(fx.t, held.storage_id)).toBe(true)
    // the ticket expired while its file was stored
    await call.begin('g')
    await fx.t.run(async (ctx) => {
      const [row] = await ctx.db.query('attachment_uploads').collect()
      await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
    })
    const expired = await storeFile(fx.t, 3)
    expect(await call.finish('g', expired)).toBe(false)
    expect(await storageExists(fx.t, expired)).toBe(false)
    expect(await send(fx.t, upload_url, 3)).toEqual({
      status: 404,
      json: { error: UPLOAD_TICKET_MISSING },
    })
  })

  it('answers a POST whose stored file lost its answer, and refuses a long type before it claims', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'a.bin', size: 3 })
    const minter = fx.agent.id
    // finish committed, but its answer never reached the POST: the POST's
    // cleanup keeps the file and hands it back
    await fx.t.mutation(internal.machine.uploads.begin, { ticket, minter, attempt: 'a' })
    const stored = await storeFile(fx.t, 3)
    const args = { ticket, minter, attempt: 'a', storage_id: stored }
    expect(await fx.t.mutation(internal.machine.uploads.finish, args)).toBe(true)
    expect(await fx.t.mutation(internal.machine.uploads.abandon, args)).toBe(stored)
    expect(await storageExists(fx.t, stored)).toBe(true)
    // another POST's cleanup gets nothing back
    expect(
      await fx.t.mutation(internal.machine.uploads.abandon, { ...args, attempt: 'b' }),
    ).toBeNull()
    // a media type the confirm would refuse is refused first, and the URL
    // stays usable
    const other = await start(fx, issue.id, { name: 'b.bin', size: 3 })
    expect(
      await send(fx.t, other.upload_url, 3, { type: `application/${'x'.repeat(244)}` }),
    ).toEqual({ status: 400, json: { error: MEDIA_TYPE_TOO_LONG } })
    expect((await send(fx.t, other.upload_url, 3)).status).toBe(200)
    expect(await send(fx.t, upload_url, 3)).toEqual({
      status: 409,
      json: { error: UPLOAD_URL_USED },
    })
  })

  it('reads exactly the declared bytes, and gives up on a body that stalls', async () => {
    // a request whose body sends `chunks` and then waits until it is cancelled
    let cancelled = false
    const body = (...chunks: Uint8Array[]) =>
      ({
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () =>
              chunks.length > 0
                ? Promise.resolve({ done: false, value: chunks.shift() })
                : new Promise<never>(() => {}),
            cancel: async () => {
              cancelled = true
            },
          }),
        },
      }) as unknown as Request
    await expect(readExactly(body(new Uint8Array(2)), 4, 20)).rejects.toMatchObject({
      data: { code: 'bad_request', message: UPLOAD_TOO_SLOW },
    })
    expect(cancelled).toBe(true)
    // a longer body is refused once it passes the size, without waiting
    cancelled = false
    expect(await readExactly(body(new Uint8Array(3), new Uint8Array(2)), 4, 60_000)).toBeNull()
    expect(cancelled).toBe(true)
  })

  it('stores an empty file and answers a browser preflight', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'empty.txt', size: 0 })
    const empty = await upload(fx.t, upload_url, 0)
    expect(await confirm(fx, issue.id, ticket, { storage_id: empty })).toMatchObject({
      attachment: { name: 'empty.txt', size_bytes: 0 },
    })
    const url = new URL(upload_url)
    const res = await (
      fx.t as unknown as {
        fetch(
          path: string,
          init: { method: string; headers: Record<string, string> },
        ): Promise<{ status: number; headers: { get(name: string): string | null } }>
      }
    ).fetch(`${url.pathname}${url.search}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://agent.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type')
  })

  it('tells a confirm that comes before any file to send it first', async () => {
    const fx = await setup()
    const issue = await task(fx)
    // also a ticket started before upload URLs stored a single file, whose
    // file went to a Convex URL
    const { ticket, upload_url } = await start(fx, issue.id, { name: 'a.bin', size: 3 })
    const elsewhere = await storeFile(fx.t, 3)
    await refused(
      confirm(fx, issue.id, ticket, { storage_id: elsewhere }),
      'bad_request',
      UPLOAD_NOT_SENT,
    )
    const stored = await upload(fx.t, upload_url, 3)
    const out = await confirm(fx, issue.id, ticket, { storage_id: stored })
    expect(out).toMatchObject({ attachment: { name: 'a.bin', size_bytes: 3 } })
  })

  it('checks sight, Edit and the body before minting anything', async () => {
    const fx = await setup()
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(start(fx, hidden.id, { name: 'a', size: 1 }), 'not_found', 'task not found')
    const issue = await task(fx)
    await refused(
      start(fx, issue.id, { name: 'a', size: 1 }, fx.viewer.id),
      'forbidden',
      PERSON_NO_WRITE,
    )
    for (const [body, sentence] of [
      [{ size: 1 }, 'a file name cannot be blank'],
      [{ name: '   ', size: 1 }, 'a file name cannot be blank'],
      [{ name: 'x'.repeat(LIMITS.attachmentName.max + 1), size: 1 }, LIMITS.attachmentName.refusal],
      [
        { name: 'a', content_type: 'x'.repeat(LIMITS.mediaType.max + 1), size: 1 },
        LIMITS.mediaType.refusal,
      ],
    ] as const) {
      await refused(start(fx, issue.id, body), 'rule', sentence)
    }
    for (const [body, sentence] of [
      [
        { name: 'a', content_type: 'pdf', size: 1 },
        'content_type must be a media type such as application/pdf',
      ],
      [{ name: 'a' }, 'size must be the file size in bytes, a whole number'],
      [{ name: 'a', size: 1.5 }, 'size must be the file size in bytes, a whole number'],
      [{ name: 'a', size: -1 }, 'size must be the file size in bytes, a whole number'],
    ] as const) {
      await refused(start(fx, issue.id, body), 'bad_request', sentence)
    }
    expect(await tickets(fx.t)).toEqual([])
  })

  it('answers over HTTP: 201 for the start and the confirm, 400 for a file it refuses', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const res = await rest(fx, 'POST', `/v1/tasks/QN-${issue.num}/attachments`, {
      name: 'log.txt',
      content_type: 'text/plain',
      size: 3,
    })
    expect(res.status).toBe(201)
    const { ticket, upload_url } = JSON.parse(res.text) as { ticket: string; upload_url: string }
    const stored = await upload(fx.t, upload_url, 3)
    const done = await rest(fx, 'POST', `/v1/tasks/QN-${issue.num}/attachments/${ticket}`, {
      storage_id: stored,
    })
    expect(done.status).toBe(201)
    expect(JSON.parse(done.text)).toMatchObject({ name: 'log.txt', size_bytes: 3 })
    const earlier = await storeFile(fx.t, 6 * MiB)
    const big = JSON.parse(
      (
        await rest(fx, 'POST', `/v1/tasks/QN-${issue.num}/attachments`, {
          name: 'big.bin',
          size: 6 * MiB,
        })
      ).text,
    ) as { ticket: string; upload_url: string }
    const path = `/v1/tasks/QN-${issue.num}/attachments/${big.ticket}`
    expect(await rest(fx, 'POST', path, { storage_id: earlier })).toEqual({
      status: 400,
      text: JSON.stringify({ error: UPLOAD_NOT_SENT }),
    })
    const six = await upload(fx.t, big.upload_url, 6 * MiB)
    expect(await rest(fx, 'POST', path, { storage_id: earlier })).toEqual({
      status: 400,
      text: JSON.stringify({ error: UPLOAD_STORAGE_ID }),
    })
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: 5 }))
    expect(await rest(fx, 'POST', path, { storage_id: six })).toEqual({
      status: 400,
      text: JSON.stringify({ error: attachmentTooLarge(5) }),
    })
    expect(await storageExists(fx.t, six)).toBe(false)
    expect(await storageExists(fx.t, earlier)).toBe(true)
  })

  it('reaps expired tickets and leaves live ones', async () => {
    const fx = await setup()
    const issue = await task(fx)
    await start(fx, issue.id, { name: 'live.txt', size: 1 })
    const { ticket } = await start(fx, issue.id, { name: 'old.txt', size: 1 })
    await fx.t.run(async (ctx) => {
      const row = (await ctx.db.query('attachment_uploads').collect()).find((r) => r.id === ticket)
      if (row) await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
    })
    expect(await reap(fx.t)).toMatchObject({ tickets: 1 })
    expect((await tickets(fx.t)).map((r) => r.name)).toEqual(['live.txt'])
  })

  it("deletes the caller's own expired tickets when it starts another", async () => {
    const fx = await setup()
    const issue = await task(fx)
    const { ticket } = await start(fx, issue.id, { name: 'old.txt', size: 1 })
    // another caller's expired ticket stays for the reaper
    await start(fx, issue.id, { name: 'admin.txt', size: 1 }, fx.admin.id)
    await fx.t.run(async (ctx) => {
      for (const row of await ctx.db.query('attachment_uploads').collect()) {
        await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
      }
    })
    await start(fx, issue.id, { name: 'new.txt', size: 1 })
    const left = await tickets(fx.t)
    expect(left.map((r) => r.name).sort()).toEqual(['admin.txt', 'new.txt'])
    expect(left.some((r) => r.id === ticket)).toBe(false)
  })
})

/* -------------------------------------------------------- 3b. MCP uploads */

describe('the MCP upload', () => {
  const start = (
    fx: Fx,
    ref: string,
    args: { name: string; size: number },
    callerId = fx.agent.id,
  ) =>
    fx.t.mutation(internal.machine.records.mcpStartUpload, {
      callerId,
      access: 'write',
      ref,
      ...args,
    })
  const confirm = (
    fx: Fx,
    ref: string,
    ticket: string,
    storage_id: string,
    callerId = fx.agent.id,
  ) =>
    fx.t.mutation(internal.machine.records.mcpConfirmUpload, {
      callerId,
      access: 'write',
      ref,
      ticket,
      storage_id,
    })

  it('starts and confirms over HTTP with a personal token, and the file downloads', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const token = await personalToken(fx.t, fx.user, 'write')
    const ref = `QN-${issue.num}`
    const before = Date.now()
    const started = await mcpTool(fx.t, token, 'start_attachment_upload', {
      ref,
      name: ' wiring.pdf ',
      size: 256,
      content_type: 'application/pdf',
    })
    expect(started.isError).toBe(false)
    const out = JSON.parse(started.text) as {
      ticket: string
      upload_url: string
      expires_at: string
    }
    expect(Object.keys(out)).toEqual(['ticket', 'upload_url', 'expires_at'])
    expect(out.upload_url).toMatch(/^https:\/\/[^/]+\/attachment-uploads\//)
    expect(Date.parse(out.expires_at) - before).toBeGreaterThanOrEqual(60 * 60 * 1000)
    const [ticket] = await tickets(fx.t)
    expect(ticket).toMatchObject({ id: out.ticket, profile_id: fx.user.id, name: 'wiring.pdf' })
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const sent = await send(fx.t, out.upload_url, 256, { body: bytes })
    expect(sent.status).toBe(200)
    const stored = sent.json.storageId as Id<'_storage'>
    expect(await send(fx.t, out.upload_url, 256, { body: bytes })).toEqual({
      status: 409,
      json: { error: UPLOAD_URL_USED },
    })
    const confirmed = await mcpTool(fx.t, token, 'confirm_attachment_upload', {
      ref,
      ticket: out.ticket,
      storage_id: stored,
    })
    expect(confirmed.isError).toBe(false)
    const attachment = JSON.parse(confirmed.text) as { id: string; url: string }
    expect(attachment).toMatchObject({
      name: 'wiring.pdf',
      size_bytes: 256,
      content_type: 'application/pdf',
      inline: false,
      uploaded_by_id: fx.user.id,
      uploaded_by_name: 'user',
    })
    expect(await download(fx.t, attachment.url)).toEqual(bytes)
    expect(await attachmentRow(fx.t, attachment.id)).toMatchObject({
      storage_id: stored,
      org_id: fx.org.id,
    })
    expect((await activityFor(fx.t, fx.org.id)).at(-1)).toMatchObject({
      actor_id: fx.user.id,
      verb: 'attached a file to',
      detail: 'wiring.pdf, via MCP',
    })
    expect(await tickets(fx.t)).toEqual([])
  })

  it('confirms a ticket started on the other surface, for the same user only', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const viaMcp = JSON.parse(await start(fx, issue.id, { name: 'mcp.txt', size: 3 })) as {
      ticket: string
      upload_url: string
    }
    const restOut = await fx.t.mutation(internal.machine.records.restConfirmUpload, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'CI key',
      ref: issue.id,
      ticket: viaMcp.ticket,
      body: JSON.stringify({ storage_id: await upload(fx.t, viaMcp.upload_url, 3) }),
    })
    expect(restOut).toMatchObject({ attachment: { name: 'mcp.txt', size_bytes: 3 } })
    const viaRest = await fx.t.mutation(internal.machine.records.restStartUpload, {
      callerId: fx.agent.id,
      access: 'write',
      ref: issue.id,
      body: JSON.stringify({ name: 'rest.txt', size: 4 }),
    })
    const stored = await upload(fx.t, viaRest.upload_url, 4)
    // the admin can edit the task too, but the ticket is the agent's
    await refused(
      confirm(fx, issue.id, viaRest.ticket, stored, fx.admin.id),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    const mcpOut = await confirm(fx, issue.id, viaRest.ticket, stored)
    if (!('text' in mcpOut)) throw new Error('expected an attachment')
    expect(JSON.parse(mcpOut.text)).toMatchObject({ name: 'rest.txt', uploaded_by_id: fx.agent.id })
    expect((await activityFor(fx.t, fx.org.id)).map((row) => row.detail)).toEqual([
      'mcp.txt, via the REST API (CI key)',
      'rest.txt, via MCP',
    ])
  })

  it('checks sight, Edit and the fields before minting a ticket', async () => {
    const fx = await setup()
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(
      start(fx, `QN-${hidden.num}`, { name: 'a', size: 1 }),
      'not_found',
      `task "QN-${hidden.num}" not found (or not visible to you)`,
    )
    const issue = await task(fx)
    await refused(
      start(fx, issue.id, { name: 'a', size: 1 }, fx.viewer.id),
      'forbidden',
      PERSON_NO_WRITE,
    )
    await refused(
      start(fx, issue.id, { name: '   ', size: 1 }),
      'rule',
      'a file name cannot be blank',
    )
    await refused(
      start(fx, issue.id, { name: 'big.bin', size: 10 * MiB + 1 }),
      'rule',
      attachmentTooLarge(10),
    )
    expect(await tickets(fx.t)).toEqual([])
  })

  it('refuses tickets and files by the REST rules, and deletes a file over a lowered cap', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const other = await task(fx)
    const me = fx.user.id
    const earlier = await storeFile(fx.t, 6 * MiB)
    const started = JSON.parse(
      await start(fx, issue.id, { name: 'six.bin', size: 6 * MiB }, me),
    ) as { ticket: string; upload_url: string }
    const ticket = started.ticket
    // a body of another size stores nothing, and the URL stays usable
    expect(await send(fx.t, started.upload_url, 6 * MiB - 1)).toEqual({
      status: 400,
      json: { error: uploadSizeWrong(6 * MiB) },
    })
    const six = await upload(fx.t, started.upload_url, 6 * MiB)
    await refused(confirm(fx, other.id, ticket, six, me), 'not_found', UPLOAD_TICKET_MISSING)
    await refused(confirm(fx, issue.id, uuid(), six, me), 'not_found', UPLOAD_TICKET_MISSING)
    await refused(confirm(fx, issue.id, ticket, earlier, me), 'bad_request', UPLOAD_STORAGE_ID)
    expect(await tickets(fx.t)).toHaveLength(1)
    // a cap lowered since the start is an error result whose byte delete has
    // committed, and it spends the ticket
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: 5 }))
    const token = await personalToken(fx.t, fx.user, 'write')
    expect(
      await mcpTool(fx.t, token, 'confirm_attachment_upload', {
        ref: issue.id,
        ticket,
        storage_id: six,
      }),
    ).toEqual({ text: attachmentTooLarge(5), isError: true })
    expect(await storageExists(fx.t, six)).toBe(false)
    expect(await storageExists(fx.t, earlier)).toBe(true)
    expect(await tickets(fx.t)).toEqual([])
    // an expired ticket answers like an unknown one
    const late = JSON.parse(await start(fx, issue.id, { name: 'late.txt', size: 1 }, me)) as {
      ticket: string
      upload_url: string
    }
    const lateFile = await upload(fx.t, late.upload_url, 1)
    await fx.t.run(async (ctx) => {
      const [row] = await ctx.db.query('attachment_uploads').collect()
      await ctx.db.patch(row._id, { expires_at: Date.now() - 1 })
    })
    await refused(
      confirm(fx, issue.id, late.ticket, lateFile, me),
      'not_found',
      UPLOAD_TICKET_MISSING,
    )
    expect(await attachmentRows(fx.t)).toEqual([])
  })
})

describe('attach_text_file', () => {
  const attachText = (
    fx: Fx,
    args: { ref: string; name: string; text: string; content_type?: string },
    callerId = fx.agent.id,
  ) =>
    fx.t.action(internal.machine.records.mcpAttachTextFile, { callerId, access: 'write', ...args })
  const fileText = (t: T, id: Id<'_storage'>) =>
    t.run(async (ctx) => {
      const blob = (await ctx.storage.get(id)) as { text(): Promise<string> } | null
      return await blob?.text()
    })

  it('stores the text as UTF-8 and attaches it, signed via MCP', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const token = await personalToken(fx.t, fx.user, 'write')
    const text = 'Kalibrering 3,5 °C ±0,2 ✓\nNästa steg: byt sensor 🌡️\n'
    const done = await mcpTool(fx.t, token, 'attach_text_file', {
      ref: `QN-${issue.num}`,
      name: ' notes.txt ',
      text,
    })
    expect(done.isError).toBe(false)
    const attachment = JSON.parse(done.text) as { id: string; url: string }
    const bytes = new TextEncoder().encode(text)
    expect(attachment).toMatchObject({
      name: 'notes.txt',
      size_bytes: bytes.length,
      content_type: 'text/plain; charset=utf-8',
      inline: false,
      uploaded_by_id: fx.user.id,
    })
    expect(bytes.length).toBeGreaterThan(text.length)
    expect(await download(fx.t, attachment.url)).toEqual(bytes)
    const row = await attachmentRow(fx.t, attachment.id)
    expect(row).toMatchObject({
      org_id: fx.org.id,
      size_bytes: bytes.length,
    })
    expect((await activityFor(fx.t, fx.org.id)).at(-1)).toMatchObject({
      actor_id: fx.user.id,
      verb: 'attached a file to',
      detail: 'notes.txt, via MCP',
    })
    // a given type is kept, and exactly 256 KiB of UTF-8 fits
    const csv = JSON.parse(
      await attachText(fx, {
        ref: issue.id,
        name: 'readings.csv',
        text: 'é'.repeat(128 * 1024),
        content_type: 'text/csv',
      }),
    ) as { id: string; size_bytes: number; content_type: string }
    expect(csv).toMatchObject({ size_bytes: 256 * 1024, content_type: 'text/csv' })
    const stored = await attachmentRow(fx.t, csv.id)
    if (stored === null) throw new Error('expected the attachment row')
    expect(await fileText(fx.t, stored.storage_id)).toBe('é'.repeat(128 * 1024))
  })

  it('refuses before it stores anything', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    const viewerAgent = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Ledger',
      kind: 'agent',
      org_role: 'viewer',
    })
    await fx.t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: fx.meta.id,
        profile_id: viewerAgent.id,
        level: 'user',
      }),
    )
    const before = await storedFiles(fx.t)
    // convex-test reads every blob it stores, so no read means nothing stored
    const stores = vi.spyOn(Blob.prototype, 'arrayBuffer')
    onTestFinished(() => stores.mockRestore())
    const readToken = await personalToken(fx.t, fx.user, 'read')
    const args = { ref: issue.id, name: 'notes.txt', text: 'hello' }
    expect(await mcpTool(fx.t, readToken, 'attach_text_file', args)).toEqual({
      text: 'this credential can only read',
      isError: true,
    })
    await refused(
      attachText(fx, args, viewerAgent.id),
      'forbidden',
      'this agent is a Viewer and can only read',
    )
    await refused(attachText(fx, args, fx.viewer.id), 'forbidden', PERSON_NO_WRITE)
    await refused(
      attachText(fx, { ...args, ref: hidden.id }),
      'not_found',
      `task "${hidden.id}" not found (or not visible to you)`,
    )
    await refused(attachText(fx, { ...args, name: '   ' }), 'rule', 'a file name cannot be blank')
    await refused(
      attachText(fx, { ...args, content_type: 'csv' }),
      'bad_request',
      'content_type must be a media type such as application/pdf',
    )
    // 256 KiB counts UTF-8 bytes, not characters
    await refused(
      attachText(fx, { ...args, text: `${'é'.repeat(128 * 1024)}a` }),
      'rule',
      LIMITS.textFile.refusal,
    )
    // an unpaired surrogate cannot reach a function, so the schema refuses it
    const token = await personalToken(fx.t, fx.user, 'write')
    expect(
      await mcpTool(fx.t, token, 'attach_text_file', { ...args, text: 'half \ud83c of a pair' }),
    ).toEqual({
      text: 'Input validation error: Invalid arguments for tool attach_text_file: text: Invalid string: has an unpaired surrogate, which UTF-8 cannot encode',
      isError: true,
    })
    expect(stores).not.toHaveBeenCalled()
    expect(await storedFiles(fx.t)).toBe(before)
    expect(await attachmentRows(fx.t)).toEqual([])
  })

  it('refuses a request body that is not UTF-8, and stores nothing', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const token = await personalToken(fx.t, fx.user, 'write')
    // the call with the degree sign sent as the bytes `degree`
    const [head, tail] = toolCall('attach_text_file', {
      ref: issue.id,
      name: 'readings.txt',
      text: '3,5 °C',
    }).split('°')
    const body = (degree: number[]) => {
      const encoder = new TextEncoder()
      return Uint8Array.from([...encoder.encode(head), ...degree, ...encoder.encode(tail)])
    }
    const before = await storedFiles(fx.t)
    // Latin-1 and cp1252 send the degree sign as the one byte B0
    const latin1 = await postTool(fx.t, token, 'attach_text_file', body([0xb0]))
    expect(latin1).toEqual({
      status: 400,
      text: '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: the request body is not UTF-8"},"id":null}',
    })
    expect(await storedFiles(fx.t)).toBe(before)
    expect(await attachmentRows(fx.t)).toEqual([])
    // the same call in UTF-8 attaches the text byte for byte
    const utf8 = await postTool(fx.t, token, 'attach_text_file', body([0xc2, 0xb0]))
    expect(utf8.status).toBe(200)
    const { result } = JSON.parse(utf8.text) as { result: { content: { text: string }[] } }
    const attachment = JSON.parse(result.content[0].text) as { url: string }
    expect(await download(fx.t, attachment.url)).toEqual(new TextEncoder().encode('3,5 °C'))
  })

  it('deletes the stored text when the organization limit refuses it', async () => {
    const fx = await setup()
    const issue = await task(fx)
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: 0.1 }))
    const before = await storedFiles(fx.t)
    await refused(
      attachText(fx, { ref: issue.id, name: 'log.txt', text: 'x'.repeat(200 * 1024) }),
      'rule',
      attachmentTooLarge(0.1),
    )
    expect(await storedFiles(fx.t)).toBe(before)
    expect(await attachmentRows(fx.t)).toEqual([])
    // within the limit it attaches
    await attachText(fx, { ref: issue.id, name: 'log.txt', text: 'x'.repeat(100 * 1024) })
    expect(await attachmentRows(fx.t)).toHaveLength(1)
  })

  it('deletes the stored file when the attach refuses, and keeps it on any other failure', async () => {
    const stored: string[] = []
    const deleted: string[] = []
    const storage = {
      store: async () => {
        stored.push(`file${stored.length}`)
        return stored.at(-1) as Id<'_storage'>
      },
      delete: async (id: Id<'_storage'>) => {
        deleted.push(id)
      },
    }
    const file = {} as Parameters<typeof storeThenAttach>[1]
    const forbiddenRefusal = new ConvexError({ code: 'forbidden', message: 'no' })
    expect(await storeThenAttach(storage, file, async (id) => `attached ${id}`)).toBe(
      'attached file0',
    )
    await expect(
      storeThenAttach(storage, file, async () => {
        throw forbiddenRefusal
      }),
    ).rejects.toBe(forbiddenRefusal)
    await expect(
      storeThenAttach(storage, file, async () => {
        throw new Error('Too many reads')
      }),
    ).rejects.toThrow('Too many reads')
    expect(stored).toEqual(['file0', 'file1', 'file2'])
    expect(deleted).toEqual(['file1'])
  })
})

/* --------------------------------------------------------- 4. activity */

describe('task activity', () => {
  async function plantActivity(
    fx: Fx,
    issue: Doc<'issues'>,
    rows: Partial<Doc<'activity_events'>>[],
  ): Promise<void> {
    await fx.t.run(async (ctx) => {
      for (const [i, row] of rows.entries()) {
        const doc = {
          id: uuid(),
          org_id: fx.org.id,
          ts: `2026-01-01T00:00:0${i}.000Z`,
          actor_id: fx.user.id,
          verb: 'changed',
          target_type: 'issue' as const,
          target_id: issue.id,
          label: issue.title,
          project_id: issue.project_id,
          ...row,
        }
        // naming no task unless it brings its own list, as the app writes it
        await ctx.db.insert('activity_events', { named_task_nums: [], ...doc })
      }
    })
  }

  it("gives a member the app's rows, oldest first, and an admin every row", async () => {
    const fx = await setup()
    const issue = await task(fx)
    const elsewhere = await task(fx, { project_id: fx.hiddenSub.id })
    await plantActivity(fx, issue, [
      { verb: 'created' },
      // moved here from a project the agent cannot access
      { verb: 'moved', detail: 'to the Firmware sub-project', related_project_id: fx.hiddenSub.id },
      // names a task the agent cannot see
      {
        verb: 'linked',
        detail: `(blocks QN-${elsewhere.num}), via MCP`,
        named_task_nums: [elsewhere.num],
      },
      // filed while the task was in a project the agent cannot access
      { verb: 'changed', detail: '(title “a” → “b”)', project_id: fx.hiddenSub.id },
      { verb: 'archived', detail: 'with 2 subtasks' },
      { verb: 'changed', target_id: elsewhere.id, project_id: fx.hiddenSub.id },
      { verb: 'restored', actor_id: undefined },
    ])
    const member = await fx.t.query(internal.machine.records.restTaskActivity, {
      callerId: fx.agent.id,
      access: 'read',
      ref: `QN-${issue.num}`,
    })
    expect(member.map((r) => [r.verb, r.detail])).toEqual([
      ['created', null],
      ['archived', null],
      ['restored', null],
    ])
    expect(member[0]).toEqual({
      id: expect.any(String),
      created_at: '2026-01-01T00:00:00.000Z',
      actor_id: fx.user.id,
      actor_name: 'user',
      verb: 'created',
      detail: null,
    })
    expect(member[2]).toMatchObject({ actor_id: null, actor_name: null })
    const admin = JSON.parse(
      await fx.t.query(internal.machine.records.mcpTaskActivity, {
        callerId: fx.admin.id,
        access: 'read',
        ref: issue.id,
      }),
    ) as { verb: string; detail: string | null }[]
    expect(admin.map((r) => r.verb)).toEqual([
      'created',
      'moved',
      'linked',
      'changed',
      'archived',
      'restored',
    ])
    expect(admin[4].detail).toBe('with 2 subtasks')
  })

  it('answers null for an actor whose profile is gone, even before the removal clears the row', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const gone = uuid()
    await plantActivity(fx, issue, [{ verb: 'created' }, { verb: 'changed', actor_id: gone }])
    const rows = await fx.t.query(internal.machine.records.restTaskActivity, {
      callerId: fx.admin.id,
      access: 'read',
      ref: issue.id,
    })
    expect(rows.map((r) => [r.actor_id, r.actor_name])).toEqual([
      [fx.user.id, 'user'],
      [null, null],
    ])
  })

  it("answers an archived task's history by the same rule", async () => {
    const fx = await setup()
    const issue = await task(fx, { archived_at: NOW })
    await plantActivity(fx, issue, [
      { verb: 'archived' },
      { verb: 'changed', project_id: fx.hiddenSub.id },
    ])
    const rows = await fx.t.query(internal.machine.records.restTaskActivity, {
      callerId: fx.agent.id,
      access: 'read',
      ref: issue.id,
    })
    expect(rows.map((r) => r.verb)).toEqual(['archived'])
  })

  it('answers a hidden task like an unknown one', async () => {
    const fx = await setup()
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(
      fx.t.query(internal.machine.records.mcpTaskActivity, {
        callerId: fx.agent.id,
        access: 'read',
        ref: `QN-${hidden.num}`,
      }),
      'not_found',
      `task "QN-${hidden.num}" not found (or not visible to you)`,
    )
    expect((await rest(fx, 'GET', `/v1/tasks/QN-${hidden.num}/activity`)).status).toBe(404)
  })
})

/* --------------------------------------------------------- 5. workload */

describe('workload', () => {
  const DAY = '2026-10-14' // a Wednesday
  const restLoad = (fx: Fx, q: Record<string, string> = {}, callerId = fx.agent.id) =>
    fx.t.query(internal.machine.records.restWorkload, {
      callerId,
      access: 'read',
      today: DAY,
      ...q,
    })
  const mcpLoad = async (fx: Fx, a: Record<string, unknown> = {}, callerId = fx.agent.id) =>
    JSON.parse(
      await fx.t.query(internal.machine.records.mcpWorkload, {
        callerId,
        access: 'read',
        today: DAY,
        ...a,
      }),
    ) as Awaited<ReturnType<typeof restLoad>>
  const person = (load: Awaited<ReturnType<typeof restLoad>>, id: string) =>
    load.people.find((p) => p.id === id)

  it("spreads each owner's remaining hours by the app's rule", async () => {
    const fx = await setup()
    const plan = { start_week: '2026-10-12', end_week: '2026-11-02' }
    await task(fx, { ...plan, assignee_id: fx.user.id, remaining_hours: 40 })
    // measured in the second week, so its hours spread from there
    await task(fx, {
      ...plan,
      assignee_id: fx.admin.id,
      remaining_hours: 40,
      remaining_set_at: '2026-10-21T09:00:00.000Z',
    })
    // the reviewer owns a task in review
    await task(fx, {
      start_week: '2026-10-19',
      end_week: '2026-10-19',
      status: 'review',
      assignee_id: fx.user.id,
      reviewer_id: fx.admin.id,
      remaining_hours: 2,
    })
    // paused, done and unscheduled work is not load
    await task(fx, { ...plan, assignee_id: fx.user.id, remaining_hours: 9, paused: true })
    await task(fx, { ...plan, assignee_id: fx.user.id, remaining_hours: 9, status: 'done' })
    await task(fx, { assignee_id: fx.user.id, remaining_hours: 9 })
    const load = await restLoad(fx, { weeks: '4' })
    expect(load.week_starts).toEqual(['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'])
    expect(load.project).toBeNull()
    expect(person(load, fx.user.id)).toMatchObject({
      name: 'user',
      kind: 'person',
      plannable_hours: 40,
      hours: [10, 10, 10, 10],
      hidden_hours: [0, 0, 0, 0],
    })
    expect(person(load, fx.admin.id)?.hours).toEqual([0, 15.3, 13.3, 13.3])
    // an agent has no plannable week; everyone active is listed by name
    expect(person(load, fx.agent.id)).toMatchObject({ plannable_hours: null, hours: [0, 0, 0, 0] })
    const names = load.people.map((p) => p.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    // MCP answers the same
    expect(await mcpLoad(fx, { weeks: 4 })).toEqual(load)
  })

  it('counts hidden work for staff without naming it, and not for a viewer', async () => {
    const fx = await setup()
    const plan = { start_week: '2026-10-12', end_week: '2026-10-12' }
    await task(fx, { ...plan, assignee_id: fx.user.id, remaining_hours: 6 })
    await task(fx, {
      ...plan,
      project_id: fx.hiddenSub.id,
      assignee_id: fx.user.id,
      remaining_hours: 4,
    })
    const staff = await restLoad(fx, { weeks: '1' })
    expect(person(staff, fx.user.id)).toMatchObject({ hours: [10], hidden_hours: [4] })
    // the Viewer person cannot see SKNK and does not own that task
    const viewer = await restLoad(fx, { weeks: '1' }, fx.viewer.id)
    expect(person(viewer, fx.user.id)).toMatchObject({ hours: [6], hidden_hours: [0] })
  })

  it('limits the hours to a project and its visible sub-projects', async () => {
    const fx = await setup()
    const plan = { start_week: '2026-10-12', end_week: '2026-10-12' }
    await task(fx, { ...plan, assignee_id: fx.user.id, remaining_hours: 6 })
    await task(fx, { ...plan, project_id: fx.sub2.id, assignee_id: fx.user.id, remaining_hours: 3 })
    await task(fx, {
      ...plan,
      project_id: fx.hiddenSub.id,
      assignee_id: fx.user.id,
      remaining_hours: 4,
    })
    const pcb = await restLoad(fx, { weeks: '1', project: 'PCB' })
    expect(pcb.project).toEqual({ id: fx.sub2.id, key: 'PCB', name: 'Board rev' })
    expect(person(pcb, fx.user.id)).toMatchObject({ hours: [3], hidden_hours: [0] })
    const meta = await mcpLoad(fx, { weeks: 1, project: 'TBED' })
    expect(person(meta, fx.user.id)).toMatchObject({ hours: [9], hidden_hours: [0] })
    // a project the caller cannot see answers like an unknown one
    await refused(restLoad(fx, { project: 'SKNK' }), 'not_found', 'project not found')
    await refused(
      mcpLoad(fx, { project: 'NOPE' }),
      'not_found',
      'project "NOPE" not found (or not visible to you)',
    )
  })

  it("follows the organization's first weekday and lists inactive people with hours", async () => {
    const fx = await setup()
    await fx.t.run((ctx) => ctx.db.patch(fx.org._id, { week_start: 0 }))
    const gone = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Gone', active: false })
    await plantSeat(fx.t, { org_id: fx.org.id, name: 'Idle', active: false })
    await task(fx, {
      start_week: '2026-10-11',
      end_week: '2026-10-18',
      assignee_id: gone.id,
      remaining_hours: 8,
    })
    const load = await restLoad(fx, { from_week: '2026-10-14', weeks: '2' })
    expect(load.week_starts).toEqual(['2026-10-11', '2026-10-18'])
    expect(person(load, gone.id)).toMatchObject({ active: false, hours: [4, 4] })
    expect(load.people.some((p) => p.name === 'Idle')).toBe(false)
  })

  it('adds up only the requested weeks of a plan that runs to the year 9999', async () => {
    const fx = await setup()
    const grid = weekGrid(1)
    const plan = { start_week: '2026-10-12', end_week: '9999-12-27' }
    const span = grid.ofDay(plan.end_week) - grid.ofDay(plan.start_week) + 1
    expect(span).toBeGreaterThan(416_000)
    // ten such plans of 2.5 hours a week, half in a project the agent cannot
    // see, which a full spread would expand fifteen times
    const planted: Doc<'issues'>[] = []
    for (let i = 0; i < 10; i++) {
      planted.push(
        await task(fx, {
          ...plan,
          project_id: i % 2 === 0 ? fx.sub.id : fx.hiddenSub.id,
          assignee_id: fx.user.id,
          remaining_hours: span * 2.5,
        }),
      )
    }
    /* A read's answer and the week entries it spread (lib/workload.ts
     * weeksSpreadSoFar), the work, measured without a clock. */
    const spread = async <R>(read: () => Promise<R>): Promise<{ out: R; weeks: number }> => {
      const before = weeksSpreadSoFar()
      const out = await read()
      return { out, weeks: weeksSpreadSoFar() - before }
    }
    // each plan adds the asked week to hours, and each hidden one adds it
    // again to hidden_hours
    const one = await spread(() => restLoad(fx, { weeks: '1' }))
    expect(one.weeks).toBe(15)
    expect(person(one.out, fx.user.id)).toMatchObject({ hours: [25], hidden_hours: [12.5] })
    // every week of a later window keeps the whole plan's rate
    const later = await spread(() => mcpLoad(fx, { from_week: '2031-03-05', weeks: 52 }))
    expect(later.weeks).toBe(15 * 52)
    expect(person(later.out, fx.user.id)).toMatchObject({
      hours: Array(52).fill(25),
      hidden_hours: Array(52).fill(12.5),
    })
    // the same plans ending in 2027 cost the asked week the same
    await fx.t.run(async (ctx) => {
      for (const row of planted) await ctx.db.patch(row._id, { end_week: '2027-12-27' })
    })
    expect((await spread(() => restLoad(fx, { weeks: '1' }))).weeks).toBe(one.weeks)
  })

  it('checks the window', async () => {
    const fx = await setup()
    // the default is eight weeks from this week
    const load = await restLoad(fx)
    expect(load.week_starts).toHaveLength(8)
    expect(load.week_starts[0]).toBe('2026-10-12')
    for (const weeks of ['0', '53', '1.5', 'x']) {
      await refused(restLoad(fx, { weeks }), 'rule', LIMITS.workloadWeeks.refusal)
    }
    await refused(
      restLoad(fx, { from_week: '2026-02-30' }),
      'bad_request',
      'from_week must be a valid calendar date',
    )
    await refused(
      restLoad(fx, { from_week: 'next week' }),
      'bad_request',
      'from_week must be YYYY-MM-DD',
    )
    expect((await rest(fx, 'GET', '/v1/workload?weeks=2')).status).toBe(200)
  })

  it('keeps every week inside the years 0000 to 9999', async () => {
    const fx = await setup()
    const years = 'the workload window must fall within the years 0000 to 9999'
    // the second week would start in year 10000
    await refused(restLoad(fx, { from_week: '9999-12-31', weeks: '2' }), 'bad_request', years)
    await refused(mcpLoad(fx, { from_week: '9999-06-01', weeks: 52 }), 'bad_request', years)
    // the week holding 0000-01-01 starts on a Monday in year -1
    await refused(restLoad(fx, { from_week: '0000-01-01', weeks: '1' }), 'bad_request', years)
    expect((await restLoad(fx, { from_week: '9999-12-20', weeks: '2' })).week_starts).toEqual([
      '9999-12-20',
      '9999-12-27',
    ])
    expect((await restLoad(fx, { from_week: '0000-01-03', weeks: '1' })).week_starts).toEqual([
      '0000-01-03',
    ])
  })
})

describe('the week grid', () => {
  it('numbers weeks from their first day and maps both ways', () => {
    const monday = weekGrid(1)
    const week = monday.ofDay('2026-10-12')
    expect(monday.ofDay('2026-10-18')).toBe(week)
    expect(monday.ofDay('2026-10-19')).toBe(week + 1)
    expect(monday.ofDay('2026-10-11')).toBe(week - 1)
    expect(monday.firstDay(monday.ofDay('2026-10-15'))).toBe('2026-10-12')
    expect(monday.ofInstant('2026-10-18T23:59:59.000Z')).toBe(week)
    expect(monday.ofInstant('2026-10-19T00:00:00.000Z')).toBe(week + 1)
    const sunday = weekGrid(0)
    expect(sunday.firstDay(sunday.ofDay('2026-10-15'))).toBe('2026-10-11')
    expect(sunday.firstDay(sunday.ofDay('2026-10-11'))).toBe('2026-10-11')
    // an unreadable setting means Monday, as in the app
    expect(weekGrid(9).firstDay(weekGrid(9).ofDay('2026-10-15'))).toBe('2026-10-12')
  })
})
