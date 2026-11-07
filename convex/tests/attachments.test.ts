/* files.ts (phase 7): attach cap/uniqueness/verbs, removeAttachment rights,
 * avatar set/clear guards, mintUrls visibility fencing, and the fileTokens
 * MAC/exp unit round-trip.
 *
 * Probe fact this suite encodes: ctx.storage.delete ROLLS BACK with a throw
 * in the same mutation (verified live), so attach's oversize path RETURNS
 * { refused } after deleting — the tests assert the bytes are actually gone,
 * which only the return-style refusal can deliver.
 *
 * convex-test's storage.store records size+sha256 but no contentType; the
 * storeBlob helper patches contentType onto the _storage doc directly
 * (verified supported) to stand in for the real upload POST's header. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { UPLOAD_TICKET_PAGE } from '../files'
import { attachmentFileUrl, mintFileToken, verifyFileToken } from '../lib/fileTokens'
import { attachmentTooLarge, LIMITS } from '../lib/limits'
import { UPLOAD_NOT_STARTED, UPLOAD_OVER_URL, UPLOAD_SIZE_SHAPE } from '../model/attachments'
import {
  activityFor,
  allMessages,
  as,
  expectRefusal,
  fileState,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  quietWatch,
  reap,
  type T,
  uuid,
  withReadingAdmin,
  workspaceOf,
} from './helpers.setup'
import { plantTicket } from './uploadTickets.setup'

/* edge-runtime provides Blob and URLSearchParams; convex/tsconfig's
 * ESNext-only lib does not declare either. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}
declare class URLSearchParams {
  constructor(init?: string)
  get(name: string): string | null
}
declare class URL {
  constructor(url: string)
  pathname: string
  search: string
}

/* fileTokens reads process.env lazily; guarantee the vars exist in this VM
 * (edge-runtime may or may not carry a process global). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'
// This suite asserts exact gateway URLs, overriding the shared auth-discovery default.
g.process.env.CONVEX_SITE_URL = 'https://test.convex.site'

const MiB = 1024 * 1024
const DEFAULT_TICKET_PAGE = UPLOAD_TICKET_PAGE.size

/* Store n zero bytes; contentType patched on when given (the upload POST's
 * Content-Type header in production). */
const storeBlob = (t: T, bytes: number, type?: string): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const sid = await ctx.storage.store(new Blob([new Uint8Array(bytes)]) as never)
    if (type !== undefined) await ctx.db.patch(sid as never, { contentType: type } as never)
    return sid
  })

const storageExists = (t: T, sid: Id<'_storage'>): Promise<boolean> =>
  t.run(async (ctx) => (await ctx.db.system.get(sid)) !== null)

const attachmentRows = (t: T): Promise<Doc<'issue_attachments'>[]> =>
  t.run(async (ctx) => await ctx.db.query('issue_attachments').collect())

const profileRow = (t: T, id: string): Promise<Doc<'profiles'> | null> =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('profiles').collect()
    return rows.find((r) => r.id === id) ?? null
  })

const setOrgCap = (t: T, fx: OrgFixture, mb: number) =>
  as(t, fx.admin).mutation(api.orgs.update, {
    org_id: fx.org.id,
    patch: { max_attachment_mb: mb },
  })

const giveAvatar = async (t: T, profile: Doc<'profiles'>, bytes = 64): Promise<Id<'_storage'>> => {
  const sid = await storeBlob(t, bytes, 'image/png')
  await t.run(async (ctx) => {
    await ctx.db.patch(profile._id, { avatar_storage_id: sid })
  })
  return sid
}

/* attach as `by`, defaulting to a fresh uuid/name; returns the full result.
 * It first plants the ticket that the upload of `sid` would leave, since the
 * attach takes only such a file, for `seat`, the seat `by` acts as in the
 * task's organization (`by` itself unless given). */
const attachAs = async (
  t: T,
  fx: OrgFixture,
  by: Doc<'profiles'>,
  issue: Doc<'issues'>,
  sid: Id<'_storage'>,
  extra: {
    id?: string
    name?: string
    mime?: string
    inline?: boolean
    seat?: Doc<'profiles'>
  } = {},
) => {
  await plantTicket(t, { profile: extra.seat ?? by, issue, storageId: sid })
  return await as(t, by).mutation(api.files.attach, {
    org_id: fx.org.id,
    id: extra.id ?? uuid(),
    issue_id: issue.id,
    storage_id: sid,
    name: extra.name ?? 'spec.pdf',
    ...(extra.mime !== undefined ? { mime: extra.mime } : {}),
    inline: extra.inline ?? false,
  })
}

const setup = async () => {
  const t = newT()
  const fx = await withReadingAdmin(t)
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  return { t, fx, issue }
}

describe('files.uploadUrl', () => {
  it('mints for a member, refuses a viewer, hides foreign issues', async () => {
    const { t, fx, issue } = await setup()
    const url = await as(t, fx.user).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    expect(url).toMatch(/^https:\/\/test\.convex\.site\/attachment-uploads\//)
    await expectRefusal(
      as(t, fx.viewer).mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id }),
      'forbidden',
    )
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.uploadUrl, {
        org_id: fx.otherOrg.id,
        issue_id: issue.id,
      }),
      'not_found',
    )
  })
})

type Fetched = { status: number; text(): Promise<string> }

/* POSTs `body` to the upload URL `url` as the app does, with `headers`. */
async function postTo(
  t: T,
  url: string,
  body: Uint8Array,
  headers: Record<string, string> = { 'Content-Type': 'application/pdf' },
) {
  const { pathname, search } = new URL(url)
  const res = await (
    t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body: Uint8Array },
      ): Promise<Fetched>
    }
  ).fetch(`${pathname}${search}`, { method: 'POST', headers, body })
  return {
    status: res.status,
    json: JSON.parse(await res.text()) as { storageId?: Id<'_storage'>; error?: string },
  }
}

const ticketRows = (t: T) => t.run((ctx) => ctx.db.query('attachment_uploads').collect())

describe('app uploads on tickets', () => {
  /* Starts an upload as `by` and sends `bytes` to its URL; answers the file. */
  async function uploaded(
    t: T,
    fx: OrgFixture,
    by: Doc<'profiles'>,
    issue: Doc<'issues'>,
    bytes: number,
    args: { size?: number; name?: string } = { size: bytes, name: 'spec.pdf' },
  ) {
    const url = await as(t, by).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
      ...args,
    })
    const res = await postTo(t, url, new Uint8Array(bytes))
    expect(res.status, res.json.error).toBe(200)
    return res.json.storageId!
  }
  const attach = (
    t: T,
    fx: OrgFixture,
    by: Doc<'profiles'>,
    issue: Doc<'issues'>,
    sid: Id<'_storage'>,
    extra: { id?: string; inline?: boolean } = {},
  ) =>
    as(t, by).mutation(api.files.attach, {
      org_id: fx.org.id,
      id: extra.id ?? uuid(),
      issue_id: issue.id,
      storage_id: sid,
      name: 'spec.pdf',
      inline: extra.inline ?? false,
    })

  it('stores exactly the declared size on one ticket, which the attach spends, for a file and a description image', async () => {
    const { t, fx, issue } = await setup()
    for (const inline of [false, true]) {
      const url = await as(t, fx.user).mutation(api.files.uploadUrl, {
        org_id: fx.org.id,
        issue_id: issue.id,
        size: 64,
        name: ' spec.pdf ',
      })
      expect(url).toContain('/attachment-uploads/')
      const [ticket] = await ticketRows(t)
      expect(ticket).toMatchObject({
        profile_id: fx.user.id,
        issue_id: issue.id,
        name: 'spec.pdf',
        size_bytes: 64,
      })
      expect(ticket.up_to).toBeUndefined()
      expect((await postTo(t, url, new Uint8Array(63))).status).toBe(400)
      const res = await postTo(t, url, new Uint8Array(64))
      expect(res.status).toBe(200)
      // one file a ticket
      expect((await postTo(t, url, new Uint8Array(64))).status).toBe(409)
      const out = await attach(t, fx, fx.user, issue, res.json.storageId!, { inline })
      if (!('attachment' in out)) throw new Error('the attach was refused')
      expect(out.attachment).toMatchObject({ size_bytes: 64, inline, uploaded_by: fx.user.id })
      expect(await ticketRows(t)).toEqual([])
    }
  })

  it('takes a smaller body without a size, as an app loaded before this release sends, up to the organization limit', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const sid = await uploaded(t, fx, fx.user, issue, 10, {})
    const [ticket] = await ticketRows(t)
    expect(ticket).toMatchObject({ up_to: true, size_bytes: 1 * MiB, name: '' })
    const out = await attach(t, fx, fx.user, issue, sid)
    if (!('attachment' in out)) throw new Error('the attach was refused')
    expect(out.attachment.size_bytes).toBe(10)
    // a longer body, declared or sent without a length, stores nothing
    const sent: Record<string, string>[] = [
      { 'Content-Type': 'application/pdf', 'Content-Length': String(MiB + 1) },
      { 'Content-Type': 'application/pdf' },
    ]
    for (const headers of sent) {
      const url = await as(t, fx.user).mutation(api.files.uploadUrl, {
        org_id: fx.org.id,
        issue_id: issue.id,
      })
      const res = await postTo(t, url, new Uint8Array(MiB + 1), headers)
      expect(res).toEqual({ status: 400, json: { error: UPLOAD_OVER_URL } })
    }
    expect(await storageExists(t, sid)).toBe(true)
    expect((await t.run((ctx) => ctx.db.system.query('_storage').collect())).length).toBe(1)
  })

  it('refuses a file no live ticket of the caller for the task stored, with one sentence', async () => {
    const { t, fx, issue } = await setup()
    const other = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
    const planted = await storeBlob(t, 8)
    const theirs = await uploaded(t, fx, fx.admin, issue, 8)
    const elsewhere = await uploaded(t, fx, fx.user, other, 8)
    const late = await uploaded(t, fx, fx.user, issue, 8)
    await t.run(async (ctx) => {
      const ticket = await ctx.db
        .query('attachment_uploads')
        .withIndex('by_storage', (q) => q.eq('storage_id', late))
        .unique()
      await ctx.db.patch(ticket!._id, { expires_at: Date.now() })
    })
    for (const sid of [planted, theirs, elsewhere, late]) {
      const refusal = await expectRefusal(attach(t, fx, fx.user, issue, sid), 'not_found')
      expect(refusal.data.message).toBe(UPLOAD_NOT_STARTED)
    }
    expect(await attachmentRows(t)).toEqual([])
    // the owners still attach theirs
    expect(await attach(t, fx, fx.admin, issue, theirs)).toHaveProperty('attachment')
    expect(await attach(t, fx, fx.user, other, elsewhere)).toHaveProperty('attachment')
  })

  it("attaches a file the caller's REST or MCP ticket stored, since a ticket is its person's", async () => {
    const { t, fx, issue } = await setup()
    const started = await t.mutation(internal.machine.records.mcpStartUpload, {
      callerId: fx.user.id,
      access: 'write',
      ref: `QN-${issue.num}`,
      name: 'report.pdf',
      size: 12,
    })
    const { upload_url } = JSON.parse(started) as { upload_url: string }
    const res = await postTo(t, upload_url, new Uint8Array(12))
    expect(res.status).toBe(200)
    // nobody else's attach takes it
    await expectRefusal(attach(t, fx, fx.admin, issue, res.json.storageId!), 'not_found')
    const out = await attach(t, fx, fx.user, issue, res.json.storageId!)
    if (!('attachment' in out)) throw new Error('the attach was refused')
    // the app's attach names the file, not the ticket
    expect(out.attachment.name).toBe('spec.pdf')
    expect(await ticketRows(t)).toEqual([])
  })

  it('answers the same attach sent again after it committed, only with the same id', async () => {
    const { t, fx, issue } = await setup()
    const sid = await uploaded(t, fx, fx.user, issue, 16)
    const id = uuid()
    const first = await attach(t, fx, fx.user, issue, sid, { id, inline: true })
    const activity = (await activityFor(t, fx.org.id)).length
    expect(await attach(t, fx, fx.user, issue, sid, { id, inline: true })).toEqual(first)
    expect(await attachmentRows(t)).toHaveLength(1)
    expect(await activityFor(t, fx.org.id)).toHaveLength(activity)
    // another id would put the description's att:<id> on a row it never made
    const other = await expectRefusal(attach(t, fx, fx.user, issue, sid), 'not_found')
    expect(other.data.message).toBe(UPLOAD_NOT_STARTED)
    // nor does another person or another task get it
    await expectRefusal(attach(t, fx, fx.admin, issue, sid, { id }), 'not_found')
    const elsewhere = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
    await expectRefusal(attach(t, fx, fx.user, elsewhere, sid, { id }), 'not_found')
  })

  it("refuses a size over the organization's limit, one that is not whole bytes and a name the attach would refuse, before any bytes", async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const start = (args: { size?: number; name?: string }) =>
      as(t, fx.user).mutation(api.files.uploadUrl, {
        org_id: fx.org.id,
        issue_id: issue.id,
        ...args,
      })
    const over = await expectRefusal(start({ size: MiB + 1 }), 'rule')
    expect(over.data.message).toBe(attachmentTooLarge(1))
    for (const size of [-1, 0.5]) {
      const shape = await expectRefusal(start({ size }), 'bad_request')
      expect(shape.data.message).toBe(UPLOAD_SIZE_SHAPE)
    }
    const long = await expectRefusal(start({ name: 'x'.repeat(256) }), 'rule')
    expect(long.data.message).toBe(LIMITS.attachmentName.refusal)
    const blank = await expectRefusal(start({ name: '  ' }), 'rule')
    expect(blank.data.message).toBe('a file name cannot be blank')
    expect(await ticketRows(t)).toEqual([])
    // at the limit it starts
    await start({ size: MiB, name: 'x'.repeat(255) })
    expect(await ticketRows(t)).toHaveLength(1)
  })

  it('refuses a full task before any ticket, and a viewer and another organization as before', async () => {
    const { t, fx, issue } = await setup()
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.attachments.max; i++)
        await ctx.db.insert('issue_attachments', {
          id: uuid(),
          org_id: fx.org.id,
          issue_id: issue.id,
          name: `${i}.pdf`,
          size_bytes: 1,
          storage_id: await ctx.storage.store(new Blob([new Uint8Array(1)]) as never),
          inline: false,
          uploaded_by: fx.user.id,
          created_at: NOW,
        })
    })
    const full = await expectRefusal(
      as(t, fx.user).mutation(api.files.uploadUrl, {
        org_id: fx.org.id,
        issue_id: issue.id,
        size: 5 * MiB * 100,
        name: '',
      }),
      'rule',
    )
    expect(full.data.message).toBe(LIMITS.attachments.refusal)
    await expectRefusal(
      as(t, fx.viewer).mutation(api.files.uploadUrl, {
        org_id: fx.org.id,
        issue_id: issue.id,
        size: 1,
      }),
      'forbidden',
    )
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.uploadUrl, {
        org_id: fx.otherOrg.id,
        issue_id: issue.id,
        size: 1,
        name: 'a.pdf',
      }),
      'not_found',
    )
    expect(await ticketRows(t)).toEqual([])
  })
})

describe('uploads in progress', () => {
  const MAX = LIMITS.uploadsInProgress.max
  const start = (t: T, fx: OrgFixture, by: Doc<'profiles'>, issue: Doc<'issues'>) =>
    as(t, by).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
      size: 8,
      name: 'spec.pdf',
    })

  it('refuses the 21st start until an attach spends a ticket or one expires', async () => {
    const { t, fx, issue } = await setup()
    const urls: string[] = []
    for (let i = 0; i < MAX; i++) urls.push(await start(t, fx, fx.user, issue))
    const refusal = await expectRefusal(start(t, fx, fx.user, issue), 'rule')
    expect(refusal.data.message).toBe(LIMITS.uploadsInProgress.refusal)
    expect(refusal.data.message).toBe(
      'you already have 20 uploads in progress, the most one person can have at once. Try again once one has finished. An upload that is never finished stops counting an hour after it started.',
    )
    // another person's count is their own
    await start(t, fx, fx.admin, issue)
    // an attach spends its ticket
    const sent = await postTo(t, urls[0], new Uint8Array(8))
    await as(t, fx.user).mutation(api.files.attach, {
      org_id: fx.org.id,
      id: uuid(),
      issue_id: issue.id,
      storage_id: sent.json.storageId!,
      name: 'spec.pdf',
      inline: false,
    })
    await start(t, fx, fx.user, issue)
    await expectRefusal(start(t, fx, fx.user, issue), 'rule')
    // a ticket whose POST failed counts until its hour ends
    expect((await postTo(t, urls[1], new Uint8Array(7))).status).toBe(400)
    await expectRefusal(start(t, fx, fx.user, issue), 'rule')
    await t.run(async (ctx) => {
      const [first] = await ctx.db
        .query('attachment_uploads')
        .withIndex('by_profile_expiry', (q) => q.eq('profile_id', fx.user.id))
        .take(1)
      await ctx.db.patch(first._id, { expires_at: Date.now() })
    })
    await start(t, fx, fx.user, issue)
  })

  it('counts REST, MCP and app starts together, and names the room before the cap', async () => {
    const { t, fx, issue } = await setup()
    const machine = (surface: 'rest' | 'mcp') =>
      surface === 'rest'
        ? t.mutation(internal.machine.records.restStartUpload, {
            callerId: fx.user.id,
            access: 'write',
            ref: `QN-${issue.num}`,
            body: JSON.stringify({ name: 'spec.pdf', size: 8 }),
          })
        : t.mutation(internal.machine.records.mcpStartUpload, {
            callerId: fx.user.id,
            access: 'write',
            ref: `QN-${issue.num}`,
            name: 'spec.pdf',
            size: 8,
          })
    for (let i = 0; i < MAX / 2; i++) {
      await machine(i % 2 === 0 ? 'rest' : 'mcp')
      await start(t, fx, fx.user, issue)
    }
    for (const call of [start(t, fx, fx.user, issue), machine('rest'), machine('mcp')]) {
      const refusal = await expectRefusal(call, 'rule')
      expect(refusal.data.message).toBe(LIMITS.uploadsInProgress.refusal)
    }
    // a full task says so, not that the uploads are at their cap
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.attachments.max; i++)
        await ctx.db.insert('issue_attachments', {
          id: uuid(),
          org_id: fx.org.id,
          issue_id: issue.id,
          name: `${i}.pdf`,
          size_bytes: 1,
          storage_id: await ctx.storage.store(new Blob([new Uint8Array(1)]) as never),
          inline: false,
          uploaded_by: fx.admin.id,
          created_at: NOW,
        })
    })
    for (const call of [start(t, fx, fx.user, issue), machine('rest'), machine('mcp')]) {
      const refusal = await expectRefusal(call, 'rule')
      expect(refusal.data.message).toBe(LIMITS.attachments.refusal)
    }
  })
})

describe('expired upload tickets', () => {
  const run = async (t: T) => {
    await t.mutation(internal.files.reapUploadTickets, {})
    await t.finishAllScheduledFunctions(() => {})
  }

  it('erases the file an expired ticket holds unless something names it, and leaves live tickets', async () => {
    const { t, fx, issue } = await setup()
    await quietWatch(t)
    const loose = await storeBlob(t, 8)
    const picture = await storeBlob(t, 8, 'image/png')
    const live = await storeBlob(t, 8)
    const expired = Date.now() - 1
    await plantTicket(t, { profile: fx.user, issue, storageId: loose, expiresAt: expired })
    await plantTicket(t, { profile: fx.user, issue, storageId: picture, expiresAt: expired })
    await plantTicket(t, { profile: fx.user, issue, storageId: live })
    await t.run(async (ctx) => {
      await ctx.db.patch(fx.user._id, { avatar_storage_id: picture })
      // a ticket whose POST never stored a file
      await ctx.db.insert('attachment_uploads', {
        id: uuid(),
        org_id: fx.org.id,
        profile_id: fx.user.id,
        issue_id: issue.id,
        name: 'never.bin',
        size_bytes: 8,
        expires_at: expired,
      })
    })
    await run(t)
    expect(await fileState(t, loose)).toBe('gone')
    expect(await fileState(t, picture)).toBe('kept')
    expect(await fileState(t, live)).toBe('kept')
    const left = await ticketRows(t)
    expect(left.map((row) => row.storage_id)).toEqual([live])
  })

  it('leaves an expired ticket that holds a file to the cleanup when its person starts another upload', async () => {
    const { t, fx, issue } = await setup()
    await quietWatch(t)
    const sent = await storeBlob(t, 8)
    const expiresAt = Date.now() - 1
    const holding = await plantTicket(t, { profile: fx.user, issue, storageId: sent, expiresAt })
    const empty = await t.run(async (ctx) => {
      // a ticket whose POST never stored a file
      const rowId = await ctx.db.insert('attachment_uploads', {
        id: uuid(),
        org_id: fx.org.id,
        profile_id: fx.user.id,
        issue_id: issue.id,
        name: 'never.bin',
        size_bytes: 8,
        expires_at: expiresAt,
      })
      return (await ctx.db.get(rowId))!
    })
    await as(t, fx.user).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
      size: 8,
      name: 'spec.pdf',
    })
    // the start deletes only the ticket that holds nothing
    const ids = (await ticketRows(t)).map((row) => row.id)
    expect(ids).toContain(holding.id)
    expect(ids).not.toContain(empty.id)
    await run(t)
    expect(await fileState(t, sent)).toBe('gone')
    expect((await ticketRows(t)).map((row) => row.id)).not.toContain(holding.id)
  })

  it('is left the expired tickets that hold a file when the weekly sweep runs first', async () => {
    const { t, fx, issue } = await setup()
    const sent = await storeBlob(t, 8)
    const expiresAt = Date.now() - 1
    const holding = await plantTicket(t, { profile: fx.user, issue, storageId: sent, expiresAt })
    await t.run((ctx) =>
      // a ticket whose POST never stored a file
      ctx.db.insert('attachment_uploads', {
        id: uuid(),
        org_id: fx.org.id,
        profile_id: fx.user.id,
        issue_id: issue.id,
        name: 'never.bin',
        size_bytes: 8,
        expires_at: expiresAt,
      }),
    )
    // the weekly sweep deletes only the ticket without a file, and its
    // files phase keeps the file, which is younger than its floor
    expect(await reap(t)).toMatchObject({ tickets: 1, deleted: 0 })
    expect((await ticketRows(t)).map((row) => row.id)).toEqual([holding.id])
    expect(await fileState(t, sent)).toBe('kept')
    // so the hourly cleanup still finds the file and erases it
    await run(t)
    expect(await fileState(t, sent)).toBe('gone')
    expect(await ticketRows(t)).toEqual([])
  })

  it('holds the files after a restore it has not noticed, and pages through the rest', async () => {
    const { t, fx, issue } = await setup()
    UPLOAD_TICKET_PAGE.size = 1
    try {
      const files = [await storeBlob(t, 8), await storeBlob(t, 8), await storeBlob(t, 8)]
      for (const storageId of files)
        await plantTicket(t, { profile: fx.user, issue, storageId, expiresAt: Date.now() - 1 })
      // no restore watch yet counts as a restore
      await run(t)
      for (const id of files) expect(await fileState(t, id)).toBe('held')
      expect(await ticketRows(t)).toEqual([])
    } finally {
      UPLOAD_TICKET_PAGE.size = DEFAULT_TICKET_PAGE
    }
  })
})

describe('files.attach', () => {
  it('copies size from storage metadata, fills mime from it, narrates the file verb', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 64, 'application/pdf')
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    expect(result.attachment.size_bytes).toBe(64)
    expect(result.attachment.mime).toBe('application/pdf')
    expect(result.attachment.uploaded_by).toBe(fx.user.id)
    const events = await activityFor(t, fx.org.id)
    const last = events[events.length - 1]
    expect(last.verb).toBe('attached a file to')
    expect(last.detail).toBe('spec.pdf')
    expect(last.target_id).toBe(issue.id)
    // no notify, no updated_at stamp — the SQL had neither
    expect(await allMessages(t)).toEqual([])
    const after = await t.run(async (ctx) =>
      (await ctx.db.query('issues').collect()).find((i) => i.id === issue.id),
    )
    expect(after?.updated_at).toBe(NOW)
  })

  it('inline attach narrates the image verb', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 32, 'image/png')
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'shot.png', inline: true })
    expect('attachment' in result).toBe(true)
    const events = await activityFor(t, fx.org.id)
    expect(events[events.length - 1].verb).toBe('added an image to')
  })

  it("stores the task's organization on the row, and neither the answer nor the snapshot shows it", async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 64, 'application/pdf')
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    const [row] = await attachmentRows(t)
    expect(row).toMatchObject({ org_id: fx.org.id, issue_id: issue.id })
    const snap = await workspaceOf(as(t, fx.user))
    const shown = snap?.attachments.find((a) => a.id === row.id)
    expect(shown).toMatchObject({ issue_id: issue.id, name: 'spec.pdf', size_bytes: 64 })
    for (const answer of [result.attachment, shown]) expect(answer).not.toHaveProperty('org_id')
  })

  it('trims the name and refuses an empty or longer name or media type before any write', async () => {
    const { t, fx, issue } = await setup()
    const NAME = LIMITS.attachmentName.refusal
    const TYPE = LIMITS.mediaType.refusal
    const cases = [
      { name: '   ', refusal: 'a file name cannot be blank' },
      { name: 'x'.repeat(256), refusal: NAME },
      // 128 emoji are 256 UTF-16 units, which the old code point count took
      { name: '📎'.repeat(128), refusal: NAME },
      { name: 'a.bin', mime: `application/${'x'.repeat(244)}`, refusal: TYPE },
      // a type the upload stored, when the client sends none
      { name: 'a.bin', stored: `application/${'x'.repeat(244)}`, refusal: TYPE },
    ]
    for (const c of cases) {
      const sid = await storeBlob(t, 8, c.stored)
      const refusal = await expectRefusal(attachAs(t, fx, fx.user, issue, sid, c), 'rule')
      expect(refusal.data.message).toBe(c.refusal)
      // the bytes stay for the weekly sweep
      expect(await storageExists(t, sid)).toBe(true)
    }
    expect(await attachmentRows(t)).toEqual([])
    expect(await activityFor(t, fx.org.id)).toEqual([])

    // 255 UTF-16 units of either pass after trimming, which the old code
    // did not do for the media type
    for (const name of [` ${'x'.repeat(255)} `, `${'📎'.repeat(127)}x`]) {
      const result = await attachAs(t, fx, fx.user, issue, await storeBlob(t, 8), {
        name,
        mime: ` application/${'x'.repeat(243)} `,
      })
      if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
      expect(result.attachment.name).toBe(name.trim())
      expect(result.attachment.mime).toBe(`application/${'x'.repeat(243)}`)
    }
    expect((await activityFor(t, fx.org.id)).at(-2)?.detail).toBe('x'.repeat(255))
  })

  it('the wire has no size slot — a client-sent size is rejected by the validator', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 32)
    await expect(
      as(t, fx.user).mutation(api.files.attach, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: sid,
        name: 'liar.bin',
        inline: false,
        size_bytes: 1,
      } as never),
    ).rejects.toThrow(/size_bytes/)
  })

  it('exactly at the organization cap passes', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const sid = await storeBlob(t, 1 * MiB)
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'cap.bin' })
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    expect(result.attachment.size_bytes).toBe(1 * MiB)
  })

  it('one byte over the cap returns { refused } AND the bytes die', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const sid = await storeBlob(t, 1 * MiB + 1)
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'big.bin' })
    if (!('refused' in result)) throw new Error('expected a refusal')
    expect(result.refused.code).toBe('rule')
    expect(result.refused.message).toBe(attachmentTooLarge(1))
    // the commit carried the delete (probe: delete+throw would have rolled back)
    expect(await storageExists(t, sid)).toBe(false)
    expect(await attachmentRows(t)).toEqual([])
    expect(await activityFor(t, fx.org.id)).toEqual([])
  })

  it('applies the same organization cap to inline images and projects without a team', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const teamlessIssue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.hidden.id })
    for (const target of [issue, teamlessIssue]) {
      const sid = await storeBlob(t, MiB + 1, 'image/png')
      const result = await attachAs(t, fx, fx.user, target, sid, { inline: true })
      expect(result).toEqual({
        refused: {
          code: 'rule',
          message: attachmentTooLarge(1),
        },
      })
      expect(await storageExists(t, sid)).toBe(false)
    }
    expect(await attachmentRows(t)).toEqual([])
  })

  it('uses the owning issue organization for a login with seats in two organizations', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    await as(t, fx.otherAdmin).mutation(api.orgs.update, {
      org_id: fx.otherOrg.id,
      patch: { max_attachment_mb: 2 },
    })
    // The Other administrator is also a guest with write access in Testbed Labs.
    await t.run((ctx) => ctx.db.patch(fx.guest._id, { auth_user_id: fx.otherAdmin.auth_user_id }))
    const denied = await storeBlob(t, MiB + 1)
    expect(await attachAs(t, fx, fx.otherAdmin, issue, denied, { seat: fx.guest })).toEqual({
      refused: {
        code: 'rule',
        message: attachmentTooLarge(1),
      },
    })
    expect(await storageExists(t, denied)).toBe(false)

    const otherIssue = await plantIssue(t, {
      org_id: fx.otherOrg.id,
      project_id: fx.otherProject.id,
    })
    const allowed = await storeBlob(t, MiB + 1)
    const result = await attachAs(
      t,
      { ...fx, org: fx.otherOrg },
      fx.otherAdmin,
      otherIssue,
      allowed,
    )
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    expect(result.attachment.uploaded_by).toBe(fx.otherAdmin.id)
  })

  it('defaults an older organization to 20 MiB and still enforces the gateway ceiling', async () => {
    const { t, fx, issue } = await setup()
    await t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: undefined }))
    const allowed = await storeBlob(t, 20 * MiB)
    expect('attachment' in (await attachAs(t, fx, fx.user, issue, allowed))).toBe(true)
    const denied = await storeBlob(t, 20 * MiB + 1)
    expect(await attachAs(t, fx, fx.user, issue, denied)).toEqual({
      refused: {
        code: 'rule',
        message: attachmentTooLarge(20),
      },
    })
    expect(await storageExists(t, denied)).toBe(false)
  })

  it('a storage id may be referenced by at most ONE attachment row — and the refusal deletes nothing', async () => {
    const { t, fx, issue } = await setup()
    const issue2 = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub2.id })
    const sid = await storeBlob(t, 40)
    const first = await attachAs(t, fx, fx.user, issue, sid)
    expect('attachment' in first).toBe(true)
    await expectRefusal(attachAs(t, fx, fx.user, issue2, sid), 'bad_request', /already attached/)
    expect(await storageExists(t, sid)).toBe(true)
    expect((await attachmentRows(t)).length).toBe(1)
  })

  it('a storage id already serving as an avatar is refused too', async () => {
    const { t, fx, issue } = await setup()
    const avatarSid = await giveAvatar(t, fx.admin)
    await expectRefusal(
      attachAs(t, fx, fx.user, issue, avatarSid),
      'bad_request',
      /already attached/,
    )
    expect(await storageExists(t, avatarSid)).toBe(true)
  })

  it('missing bytes refuse with the diagnosable sentence, never default-to-zero', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 16)
    await t.run(async (ctx) => await ctx.storage.delete(sid))
    await expectRefusal(
      attachAs(t, fx, fx.user, issue, sid),
      'bad_request',
      /bytes not found in storage/,
    )
  })

  it('rights: guest with a member grant attaches; viewer is capped out; foreign org sees nothing', async () => {
    const { t, fx, issue } = await setup()
    const guestSid = await storeBlob(t, 8)
    const result = await attachAs(t, fx, fx.guest, issue, guestSid)
    expect('attachment' in result).toBe(true)
    const viewerSid = await storeBlob(t, 8)
    await expectRefusal(attachAs(t, fx, fx.viewer, issue, viewerSid), 'forbidden')
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.attach, {
        org_id: fx.otherOrg.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: viewerSid,
        name: 'x.bin',
        inline: false,
      }),
      'not_found',
    )
  })
})

describe('files.removeAttachment', () => {
  const planted = async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 24)
    const result = await attachAs(t, fx, fx.admin, issue, sid, { name: 'doomed.txt' })
    if ('refused' in result) throw new Error('setup attach refused')
    return { t, fx, issue, sid, attId: result.attachment.id }
  }

  it('any project member may delete any attachment (not uploader-only) — row, held bytes and verb', async () => {
    const { t, fx, sid, attId, issue } = await planted()
    // guest holds 'user' via the meta grant and did NOT upload this file
    await as(t, fx.guest).mutation(api.files.removeAttachment, { org_id: fx.org.id, id: attId })
    expect(await attachmentRows(t)).toEqual([])
    expect(await fileState(t, sid)).toBe('held')
    const events = await activityFor(t, fx.org.id)
    const last = events[events.length - 1]
    expect(last.verb).toBe('removed an attachment from')
    expect(last.detail).toBe('doomed.txt')
    expect(last.target_id).toBe(issue.id)
  })

  it('inline rows narrate the image verb', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 24)
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'pic.png', inline: true })
    if ('refused' in result) throw new Error('setup attach refused')
    await as(t, fx.user).mutation(api.files.removeAttachment, {
      org_id: fx.org.id,
      id: result.attachment.id,
    })
    const events = await activityFor(t, fx.org.id)
    expect(events[events.length - 1].verb).toBe('removed an image from')
  })

  it('viewer is refused, foreign org and missing ids read not_found', async () => {
    const { t, fx, sid, attId } = await planted()
    await expectRefusal(
      as(t, fx.viewer).mutation(api.files.removeAttachment, { org_id: fx.org.id, id: attId }),
      'forbidden',
    )
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.removeAttachment, {
        org_id: fx.otherOrg.id,
        id: attId,
      }),
      'not_found',
    )
    await expectRefusal(
      as(t, fx.user).mutation(api.files.removeAttachment, { org_id: fx.org.id, id: uuid() }),
      'not_found',
    )
    expect(await storageExists(t, sid)).toBe(true)
    expect((await attachmentRows(t)).length).toBe(1)
  })
})

describe('files.setAvatar / clearAvatar', () => {
  it('self sets; a swap holds the OLD bytes in the same mutation', async () => {
    const { t, fx } = await setup()
    const first = await storeBlob(t, 128, 'image/webp')
    await as(t, fx.user).mutation(api.files.setAvatar, {
      profile_id: fx.user.id,
      storage_id: first,
    })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBe(first)
    const second = await storeBlob(t, 128, 'image/png')
    await as(t, fx.user).mutation(api.files.setAvatar, {
      profile_id: fx.user.id,
      storage_id: second,
    })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBe(second)
    expect(await fileState(t, first)).toBe('held')
    expect(await storageExists(t, second)).toBe(true)
  })

  it('an org admin sets for others; a plain member may not; absent uuids read the same sentence', async () => {
    const { t, fx } = await setup()
    const sid = await storeBlob(t, 64, 'image/jpeg')
    await as(t, fx.admin).mutation(api.files.setAvatar, {
      profile_id: fx.agent.id,
      storage_id: sid,
    })
    expect((await profileRow(t, fx.agent.id))?.avatar_storage_id).toBe(sid)
    const sid2 = await storeBlob(t, 64, 'image/jpeg')
    const wrong = await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: fx.admin.id, storage_id: sid2 }),
      'forbidden',
    )
    const missing = await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: uuid(), storage_id: sid2 }),
      'forbidden',
    )
    // 0099:203 verbatim, identical for invisible and absent (no existence oracle)
    const sentence = 'only this person or an organization admin can change their picture'
    expect((wrong.data as { message: string }).message).toBe(sentence)
    expect((missing.data as { message: string }).message).toBe(sentence)
  })

  it('mime allowlist: SVG and typeless uploads are refused (0096 successor)', async () => {
    const { t, fx } = await setup()
    const svg = await storeBlob(t, 64, 'image/svg+xml')
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: fx.user.id, storage_id: svg }),
      'rule',
      /PNG, JPEG, WebP, or GIF/,
    )
    const typeless = await storeBlob(t, 64)
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, {
        profile_id: fx.user.id,
        storage_id: typeless,
      }),
      'rule',
      /PNG, JPEG, WebP, or GIF/,
    )
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBeUndefined()
  })

  it('2 MiB cap: exactly at passes, one byte over refuses', async () => {
    const { t, fx } = await setup()
    const atCap = await storeBlob(t, 2_097_152, 'image/png')
    await as(t, fx.user).mutation(api.files.setAvatar, {
      profile_id: fx.user.id,
      storage_id: atCap,
    })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBe(atCap)
    const over = await storeBlob(t, 2_097_153, 'image/png')
    const refusal = await expectRefusal(
      as(t, fx.admin).mutation(api.files.setAvatar, { profile_id: fx.admin.id, storage_id: over }),
      'rule',
    )
    expect(refusal.data.message).toBe(LIMITS.avatarSize.refusal)
  })

  it('a storage id referenced elsewhere is refused — the delete paths could destroy foreign bytes', async () => {
    const { t, fx, issue } = await setup()
    const attSid = await storeBlob(t, 32, 'image/png')
    const result = await attachAs(t, fx, fx.user, issue, attSid, { name: 'pic.png', inline: true })
    expect('attachment' in result).toBe(true)
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: fx.user.id, storage_id: attSid }),
      'bad_request',
      /already in use/,
    )
    const otherFace = await giveAvatar(t, fx.admin)
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, {
        profile_id: fx.user.id,
        storage_id: otherFace,
      }),
      'bad_request',
      /already in use/,
    )
    expect(await storageExists(t, attSid)).toBe(true)
    expect(await storageExists(t, otherFace)).toBe(true)
  })

  it('clearAvatar holds the bytes; clearing nothing is a no-op; rights match setAvatar', async () => {
    const { t, fx } = await setup()
    const sid = await giveAvatar(t, fx.user)
    await expectRefusal(
      as(t, fx.guest).mutation(api.files.clearAvatar, { profile_id: fx.user.id }),
      'forbidden',
    )
    await as(t, fx.user).mutation(api.files.clearAvatar, { profile_id: fx.user.id })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBeUndefined()
    expect(await fileState(t, sid)).toBe('held')
    // idempotent second clear
    await as(t, fx.user).mutation(api.files.clearAvatar, { profile_id: fx.user.id })
  })
})

describe('files.mintUrls', () => {
  it('mints attachment urls for visible rows and OMITS invisible/missing ids — no existence oracle', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 16, 'image/png')
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error('setup attach refused')
    const attId = result.attachment.id
    // an attachment on the hidden meta — guest holds no grant there
    const hiddenIssue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.hidden.id })
    const hiddenSid = await storeBlob(t, 16)
    const hiddenAtt = await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('issue_attachments', {
        org_id: hiddenIssue.org_id,
        id,
        issue_id: hiddenIssue.id,
        name: 'secret.txt',
        size_bytes: 16,
        storage_id: hiddenSid,
        inline: false,
        created_at: NOW,
      })
      return id
    })
    const before = Math.floor(Date.now() / 1000)
    const minted = await as(t, fx.guest).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [attId, hiddenAtt, uuid()],
    })
    expect(Object.keys(minted.attachments)).toEqual([attId])
    expect(minted.avatars).toEqual({})
    const { url, exp } = minted.attachments[attId]
    expect(exp).toBeGreaterThanOrEqual(before + 599)
    expect(exp).toBeLessThanOrEqual(before + 601)
    expect(url.startsWith(`https://test.convex.site/files/${attId}?`)).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('e')).toBe(String(exp))
    expect(params.get('m')).toBe(fx.guest.id) // minter = caller's profile uuid
    expect(
      await verifyFileToken({
        kind: 'attachment',
        id: attId,
        minter: fx.guest.id,
        exp,
        token: params.get('t') as string,
      }),
    ).toBe(true)
    // the minter who CAN see hidden gets it
    const adminMinted = await as(t, fx.admin).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [hiddenAtt],
    })
    expect(Object.keys(adminMinted.attachments)).toEqual([hiddenAtt])
  })

  it('a viewer can mint what it can see — read scope, not write scope', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 16)
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error('setup attach refused')
    const minted = await as(t, fx.viewer).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [result.attachment.id],
    })
    expect(Object.keys(minted.attachments)).toEqual([result.attachment.id])
  })

  it('avatar urls carry v=<storage id> and auth-user minter; foreign orgs and avatarless profiles are omitted', async () => {
    const { t, fx } = await setup()
    const faceSid = await giveAvatar(t, fx.admin)
    await giveAvatar(t, fx.otherAdmin)
    const minted = await as(t, fx.guest).query(api.files.mintUrls, {
      org_id: fx.org.id,
      profile_ids: [fx.admin.id, fx.user.id, fx.otherAdmin.id, uuid()],
    })
    // fx.user has no avatar; otherAdmin is a foreign org; the last is missing
    expect(Object.keys(minted.avatars)).toEqual([fx.admin.id])
    const { url, exp } = minted.avatars[fx.admin.id]
    expect(url.startsWith(`https://test.convex.site/avatars/${fx.admin.id}?`)).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('v')).toBe(faceSid)
    expect(params.get('m')).toBe(fx.guest.auth_user_id) // minter = auth-user id
    expect(
      await verifyFileToken({
        kind: 'avatar',
        id: fx.admin.id,
        minter: fx.guest.auth_user_id as string,
        exp,
        token: params.get('t') as string,
      }),
    ).toBe(true)
  })
})

describe('fileTokens', () => {
  const base = { kind: 'attachment' as const, id: 'att-1', minter: 'prof-1' }

  it('round-trips: mint then verify', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const token = await mintFileToken({ ...base, exp })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 HMAC bytes, base64url, no padding
    expect(await verifyFileToken({ ...base, exp, token })).toBe(true)
  })

  it('rejects tampering with any covered field', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const token = await mintFileToken({ ...base, exp })
    expect(
      await verifyFileToken({
        ...base,
        exp,
        token: `A${token.slice(1)}` === token ? `B${token.slice(1)}` : `A${token.slice(1)}`,
      }),
    ).toBe(false)
    expect(await verifyFileToken({ ...base, id: 'att-2', exp, token })).toBe(false)
    expect(await verifyFileToken({ ...base, minter: 'prof-2', exp, token })).toBe(false)
    expect(await verifyFileToken({ ...base, kind: 'avatar', exp, token })).toBe(false)
    expect(await verifyFileToken({ ...base, exp: exp + 1, token })).toBe(false)
    expect(await verifyFileToken({ ...base, exp, token: 'not!base64url' })).toBe(false)
    expect(await verifyFileToken({ ...base, exp, token: '' })).toBe(false)
  })

  it('rejects expired tokens — exp injected, now injected', async () => {
    const exp = 1_000_000 // long past
    const token = await mintFileToken({ ...base, exp })
    expect(await verifyFileToken({ ...base, exp, token })).toBe(false)
    // and a valid MAC exactly AT expiry fails, one second before passes
    expect(await verifyFileToken({ ...base, exp, token, now: exp * 1000 })).toBe(false)
    expect(await verifyFileToken({ ...base, exp, token, now: exp * 1000 - 1000 })).toBe(true)
  })

  it('urls put the token parts where the gateway parses them', () => {
    const url = attachmentFileUrl({ id: 'att-1', minter: 'prof-1', exp: 123, token: 'tok' })
    expect(url).toBe('https://test.convex.site/files/att-1?e=123&m=prof-1&t=tok')
  })
})
