/* Deleted files are held for a restore before they are erased
 * (model/fileHolds.ts).
 *
 *   1. The hold: a let-go file is held until HOLD_MS later, which with the
 *      eraser's interval stays within 7 days. A file another row still
 *      names is not held, and the demo erases at once.
 *   2. The eraser reads only due holds, in bounded legs, erases what no row
 *      names, keeps a file a restore brought back, and passes over a file
 *      already gone.
 *   3. A held file is out of reach: the avatar gateway misses it, nothing can
 *      adopt it, and the storage totals leave it out.
 *
 * The attachment gateway, REST and MCP are covered in records.test.ts, and
 * the orphan sweep keeping held files in jobs.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import crons from '../crons'
import { storageUsage } from '../model/billing'
import { ERASE_EVERY_MS, ERASE_PAGE, HOLD_MS, releaseFile } from '../model/fileHolds'
import {
  as,
  expectRefusal,
  fileState,
  NOW,
  newT,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* fileTokens reads this lazily (attachments.test.ts plants the same). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

const DAY = 24 * 60 * 60 * 1000
const DEFAULT_PAGE = { ...ERASE_PAGE }

afterEach(() => {
  Object.assign(ERASE_PAGE, DEFAULT_PAGE)
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const storeFile = (t: T, type = 'application/pdf'): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([new Uint8Array(12)]) as never)
    await ctx.db.patch(id as never, { contentType: type } as never)
    return id
  })

/* A task in the fixture's sub-project with one attachment of 12 bytes. */
async function attached(t: T, f: Awaited<ReturnType<typeof withOrg>>) {
  const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const storage_id = await storeFile(t)
  const row = await t.run(async (ctx) => {
    const _id = await ctx.db.insert('issue_attachments', {
      id: uuid(),
      org_id: issue.org_id,
      issue_id: issue.id,
      name: 'spec.pdf',
      size_bytes: 12,
      storage_id,
      inline: false,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_attachments'>
  })
  return { issue, row }
}

const remove = (t: T, f: Awaited<ReturnType<typeof withOrg>>, row: Doc<'issue_attachments'>) =>
  as(t, f.user).mutation(api.files.removeAttachment, { org_id: f.org.id, id: row.id })

const holds = (t: T) => t.run((ctx) => ctx.db.query('file_holds').collect())

/* Runs one eraser run through all its legs at `now`. */
async function erase(t: T, now: number): Promise<void> {
  await t.mutation(internal.files.eraseHeldFiles, { now })
  await t.finishAllScheduledFunctions(() => {
    if (vi.isFakeTimers()) vi.advanceTimersByTime(0)
  })
}

describe('the hold', () => {
  it('erases every file within 7 days of its release, one eraser interval at most after its hold', () => {
    expect(HOLD_MS + ERASE_EVERY_MS).toBeLessThanOrEqual(7 * DAY)
    expect(HOLD_MS).toBeGreaterThanOrEqual(7 * DAY - ERASE_EVERY_MS)
    const job = Object.values(crons.crons).find((c) => c.name === 'files:eraseHeldFiles')
    expect(job?.schedule).toEqual({ type: 'interval', minutes: ERASE_EVERY_MS / 60_000 })
  })

  it('holds a removed file until HOLD_MS after its release, with its size', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    const before = Date.now()
    await remove(t, f, row)
    const [hold] = await holds(t)
    expect(hold).toMatchObject({ storage_id: row.storage_id, size_bytes: 12 })
    expect(hold.erase_at - HOLD_MS).toBeGreaterThanOrEqual(before)
    expect(hold.erase_at - HOLD_MS).toBeLessThanOrEqual(Date.now())
    expect(await fileState(t, row.storage_id)).toBe('held')
  })

  it('holds nothing while another row still names the file, and nothing that is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    const gone = await storeFile(t)
    await t.run(async (ctx) => {
      // two rows share the file, then one of them goes
      await ctx.db.patch(f.user._id, { avatar_storage_id: row.storage_id })
      await ctx.db.delete(row._id)
      await releaseFile(ctx, row.storage_id)
      await ctx.storage.delete(gone)
      await releaseFile(ctx, gone)
    })
    expect(await holds(t)).toEqual([])
    expect(await fileState(t, row.storage_id)).toBe('kept')
  })

  it('keeps the later time when a file held already is let go again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    await remove(t, f, row)
    const [first] = await holds(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { erase_at: first.erase_at - DAY })
      await releaseFile(ctx, row.storage_id)
    })
    const [again] = await holds(t)
    expect(again._id).toBe(first._id)
    expect(again.erase_at).toBeGreaterThanOrEqual(first.erase_at)
  })

  it('erases at once on the demo, which keeps no backups', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    vi.stubEnv('APP_MODE', 'demo')
    await t.run((ctx) => ctx.db.delete(row._id))
    await t.run((ctx) => releaseFile(ctx, row.storage_id))
    expect(await holds(t)).toEqual([])
    expect(await fileState(t, row.storage_id)).toBe('gone')
  })
})

describe('the eraser', () => {
  it('erases due files in bounded legs and leaves holds that are not due', async () => {
    const t = newT()
    const f = await withOrg(t)
    ERASE_PAGE.holds = 2
    const files: Id<'_storage'>[] = []
    for (let n = 0; n < 5; n++) {
      const { row } = await attached(t, f)
      await remove(t, f, row)
      files.push(row.storage_id)
    }
    const due = Math.max(...(await holds(t)).map((hold) => hold.erase_at))
    // a file let go a day later
    const later = (await attached(t, f)).row
    await remove(t, f, later)
    await t.run(async (ctx) => {
      const hold = (await ctx.db.query('file_holds').collect()).find(
        (h) => h.storage_id === later.storage_id,
      )
      if (hold) await ctx.db.patch(hold._id, { erase_at: hold.erase_at + DAY })
    })
    // one interval before the first five are due, nothing goes
    await erase(t, due - ERASE_EVERY_MS)
    expect(await holds(t)).toHaveLength(6)
    await erase(t, due)
    for (const file of files) expect(await fileState(t, file)).toBe('gone')
    expect(await fileState(t, later.storage_id)).toBe('held')
    // the call and two scheduled legs, at most two holds each
    const legs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(legs.filter((job) => job.name.includes('eraseHeldFiles'))).toHaveLength(2)
  })

  it('keeps a file a restore brought back, and passes over a file already gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const kept = await attached(t, f)
    const lost = await attached(t, f)
    await remove(t, f, kept.row)
    await remove(t, f, lost.row)
    // a restore writes the row back; the other file was erased by hand
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...doc } = kept.row
      await ctx.db.insert('issue_attachments', doc)
      await ctx.storage.delete(lost.row.storage_id)
    })
    await erase(t, Date.now() + HOLD_MS + 1)
    expect(await holds(t)).toEqual([])
    expect(await fileState(t, kept.row.storage_id)).toBe('kept')
    expect(await fileState(t, lost.row.storage_id)).toBe('gone')
  })
})

describe('a held file is out of reach', () => {
  it('leaves the avatar gateway, and no picture or attachment can take it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const face = await storeFile(t, 'image/png')
    await as(t, f.user).mutation(api.files.setAvatar, { profile_id: f.user.id, storage_id: face })
    const minted = await as(t, f.admin).query(api.files.mintUrls, {
      org_id: f.org.id,
      profile_ids: [f.user.id],
    })
    const url = new URL(minted.avatars[f.user.id].url)
    const fetchPath = (path: string) =>
      (t as unknown as { fetch(path: string): Promise<{ status: number }> }).fetch(path)
    expect((await fetchPath(`${url.pathname}${url.search}`)).status).toBe(200)
    await as(t, f.user).mutation(api.files.clearAvatar, { profile_id: f.user.id })
    expect(await fileState(t, face)).toBe('held')
    expect((await fetchPath(`${url.pathname}${url.search}`)).status).toBe(404)
    await expectRefusal(
      as(t, f.admin).mutation(api.files.setAvatar, { profile_id: f.admin.id, storage_id: face }),
      'bad_request',
    )
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await expectRefusal(
      as(t, f.user).mutation(api.files.attach, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: face,
        name: 'face.png',
        inline: false,
      }),
      'bad_request',
    )
  })

  it('leaves the storage totals', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    const bytes = () => t.run(async (ctx) => (await storageUsage(ctx, f.org.id)).bytes)
    expect(await bytes()).toBe(12)
    await remove(t, f, row)
    expect(await fileState(t, row.storage_id)).toBe('held')
    expect(await bytes()).toBe(0)
  })
})
