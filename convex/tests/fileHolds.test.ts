/* Deleted files are held for a restore before they are erased
 * (model/fileHolds.ts).
 *
 *   1. The hold: a let-go file is held until HOLD_MS later and its erase is
 *      scheduled for then, which with the eraser's interval leaves a margin
 *      before 7 days. A file another row still names is not held, and the
 *      demo erases at once.
 *   2. The scheduled erase erases the file even when a restore took its hold
 *      back, keeps a file a restore brought back, and waits for a later
 *      release but not for a hold made after a restore.
 *   3. The eraser reads only due holds, in bounded legs, erases what no row
 *      names, keeps a file a restore brought back, and passes over a file
 *      already gone.
 *   4. A restore is noticed, and the orphan sweep then holds the files it
 *      left named by nothing until HOLD_MS after that, so a second restore
 *      finds them: in the run the eraser starts, in a run already going, in
 *      a weekly run that overtakes it, and for a file the floor kept from
 *      the first run.
 *   5. A held file is out of reach: the avatar gateway misses it, nothing can
 *      adopt it, and the storage totals leave it out.
 *
 * The attachment gateway, REST and MCP are covered in records.test.ts, and
 * the orphan sweep keeping held files in jobs.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import crons from '../crons'
import { REAP_PAGES } from '../files'
import { storageUsage } from '../model/billing'
import {
  ERASE_EVERY_MS,
  ERASE_PAGE,
  eraseDueFiles,
  HOLD_MS,
  releaseFile,
  restoreHoldEnd,
  restoreState,
} from '../model/fileHolds'
import { deleteOrgStep } from '../model/orgDeletion'
import {
  as,
  chargeFilteredReads,
  expectRefusal,
  fileState,
  NOW,
  newT,
  plantIssue,
  quietWatch,
  type T,
  uuid,
  watchRestores,
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

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const DEFAULT_PAGE = { ...ERASE_PAGE }
const DEFAULT_REAP_PAGES = { ...REAP_PAGES }

afterEach(() => {
  Object.assign(ERASE_PAGE, DEFAULT_PAGE)
  Object.assign(REAP_PAGES, DEFAULT_REAP_PAGES)
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

const holdFor = async (t: T, id: Id<'_storage'>) =>
  (await holds(t)).find((hold) => hold.storage_id === id)

/* Runs one eraser run through all its legs at `now`, and the sweep it starts
 * when it notices a restore. */
async function erase(t: T, now: number): Promise<void> {
  await t.mutation(internal.files.eraseHeldFiles, { now })
  await t.finishAllScheduledFunctions(() => {
    if (vi.isFakeTimers()) vi.advanceTimersByTime(0)
  })
}

/* Moves the fake clock to `at` and runs the scheduled functions due by
 * then, as the deployment's scheduler does. */
async function runUntil(t: T, at: number): Promise<void> {
  vi.advanceTimersByTime(at - Date.now())
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0))
}

/* The scheduled erases waiting to run, by file. */
const pendingErases = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect())
      .filter((job) => job.name.endsWith('eraseHeldFile') && job.state.kind === 'pending')
      .map((job) => ({
        storage_id: (job.args[0] as { storage_id: Id<'_storage'> }).storage_id,
        at: job.scheduledTime,
      })),
  )

/* The restore watch as a backup taken now keeps it. */
const backupWatch = (t: T) =>
  t.run(async (ctx) => {
    const row = await ctx.db.query('restore_watch').first()
    if (row === null) throw new Error('no restore watch')
    return row
  })

/* Puts the restore watch back as `backup` had it, as a restore does. */
const rewindWatch = (t: T, backup: Doc<'restore_watch'>) =>
  t.run(async (ctx) => {
    const { _id, _creationTime, ...fields } = backup
    await ctx.db.replace(_id, fields)
  })

/* The counts of the last reap_orphans audit row. */
const lastSweep = (t: T) =>
  t.run(async (ctx) => {
    const rows = (await ctx.db.query('platform_audit_log').collect()).filter(
      (row) => row.action === 'reap_orphans',
    )
    return rows.at(-1)?.detail
  })

describe('the hold', () => {
  it('erases every file an eraser interval before 7 days, and keeps it for a backup an hour older', () => {
    // a failed scheduled erase leaves the file to the next eraser run, which
    // still comes at least one interval before the 7 days
    expect(7 * DAY - (HOLD_MS + ERASE_EVERY_MS)).toBeGreaterThanOrEqual(ERASE_EVERY_MS)
    // a backup taken more than an hour before the release still finds it
    expect(7 * DAY - HOLD_MS).toBeLessThanOrEqual(HOUR)
    const job = Object.values(crons.crons).find((c) => c.name === 'files:eraseHeldFiles')
    expect(job?.schedule).toEqual({ type: 'interval', minutes: ERASE_EVERY_MS / 60_000 })
  })

  it('holds a removed file until HOLD_MS after its release, with its size, and schedules its erase then', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    const before = Date.now()
    await remove(t, f, row)
    const [hold] = await holds(t)
    expect(hold).toMatchObject({ storage_id: row.storage_id, size_bytes: 12 })
    expect(hold.after_restore).toBeUndefined()
    expect(hold.erase_at - HOLD_MS).toBeGreaterThanOrEqual(before)
    expect(hold.erase_at - HOLD_MS).toBeLessThanOrEqual(Date.now())
    expect(await fileState(t, row.storage_id)).toBe('held')
    expect(await pendingErases(t)).toEqual([{ storage_id: row.storage_id, at: hold.erase_at }])
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

  it('keeps the later time when a file held already is let go again, and takes over a hold made after a restore', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    await remove(t, f, row)
    const [first] = await holds(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { erase_at: first.erase_at - DAY, after_restore: true })
      await releaseFile(ctx, row.storage_id)
    })
    const [again] = await holds(t)
    expect(again._id).toBe(first._id)
    expect(again.erase_at).toBeGreaterThanOrEqual(first.erase_at)
    expect(again.after_restore).toBeUndefined()
    // a second erase for the later time; the first finds the hold not due
    expect((await pendingErases(t)).map((job) => job.at)).toEqual([first.erase_at, again.erase_at])
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

describe('the scheduled erase', () => {
  it('erases the file when its hold ends, also after a restore took the hold back', async () => {
    vi.useFakeTimers()
    const t = newT()
    const f = await withOrg(t)
    const plain = await attached(t, f)
    const rewound = await attached(t, f)
    const released = Date.now()
    await remove(t, f, plain.row)
    await remove(t, f, rewound.row)
    // a restore of a backup from before both files: the second file's hold
    // goes with the restored tables, its scheduled erase stays
    await t.run(async (ctx) => {
      const hold = await ctx.db
        .query('file_holds')
        .withIndex('by_storage', (q) => q.eq('storage_id', rewound.row.storage_id))
        .unique()
      if (hold) await ctx.db.delete(hold._id)
    })
    expect(await fileState(t, rewound.row.storage_id)).toBe('kept')
    await runUntil(t, released + HOLD_MS - 1)
    expect(await fileState(t, plain.row.storage_id)).toBe('held')
    await runUntil(t, released + HOLD_MS)
    expect(await fileState(t, plain.row.storage_id)).toBe('gone')
    expect(await fileState(t, rewound.row.storage_id)).toBe('gone')
    expect(Date.now() - released).toBeLessThan(7 * DAY)
    expect(await holds(t)).toEqual([])
  })

  it('keeps a file a restore brought back', async () => {
    vi.useFakeTimers()
    const t = newT()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    await remove(t, f, row)
    const [hold] = await holds(t)
    // the restored backup names the file and has no hold for it
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...doc } = row
      await ctx.db.insert('issue_attachments', doc)
      await ctx.db.delete(hold._id)
    })
    await runUntil(t, hold.erase_at)
    expect(await fileState(t, row.storage_id)).toBe('kept')
  })

  it('waits for a later release, but not for a hold made after a restore', async () => {
    vi.useFakeTimers()
    const t = newT()
    const f = await withOrg(t)
    const later = await attached(t, f)
    const restored = await attached(t, f)
    await remove(t, f, later.row)
    await remove(t, f, restored.row)
    const due = (await holds(t))[0].erase_at
    await t.run(async (ctx) => {
      for (const hold of await ctx.db.query('file_holds').collect())
        await ctx.db.patch(
          hold._id,
          hold.storage_id === later.row.storage_id
            ? { erase_at: hold.erase_at + DAY }
            : { erase_at: hold.erase_at + DAY, after_restore: true },
        )
    })
    await runUntil(t, due + 1)
    expect(await fileState(t, later.row.storage_id)).toBe('held')
    expect(await fileState(t, restored.row.storage_id)).toBe('gone')
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

  it('reads only the holds that are due', async () => {
    const t = newT()
    // a filtered scan would read the holds it passes over too
    chargeFilteredReads()
    const f = await withOrg(t)
    const { row } = await attached(t, f)
    await remove(t, f, row)
    const [due] = await holds(t)
    // twenty files let go a day later
    await t.run(async (ctx) => {
      for (let n = 0; n < 20; n++) {
        const storage_id = await ctx.storage.store(new Blob([new Uint8Array(12)]) as never)
        await ctx.db.insert('file_holds', {
          storage_id,
          size_bytes: 12,
          erase_at: due.erase_at + DAY,
        })
      }
    })
    const read = await t.run(async (ctx) => {
      await eraseDueFiles(ctx, due.erase_at, { erased: 0, kept: 0 })
      return (await ctx.meta.getTransactionMetrics()).documentsRead.used
    })
    expect(await fileState(t, row.storage_id)).toBe('gone')
    expect(await holds(t)).toHaveLength(20)
    // the due hold, and its file, which the erase reads again
    expect(read).toBe(3)
  })
})

describe('a restore', () => {
  it('is noticed once, when the watch goes back to an earlier witness', async () => {
    vi.useFakeTimers()
    const t = newT()
    const state = () => t.run((ctx) => restoreState(ctx))
    // a deployment that never had a watch counts as restored
    expect(await watchRestores(t)).toBe(true)
    expect(await watchRestores(t)).toBe(false)
    await quietWatch(t)
    const backup = await backupWatch(t)
    expect(await watchRestores(t)).toBe(false)
    // a witness that ran, after a day without the eraser, still counts
    await runUntil(t, Date.now() + DAY + 1)
    expect(await watchRestores(t)).toBe(false)
    expect(await state()).toEqual({ rewound: false })
    await rewindWatch(t, backup)
    // a sweep holds before the eraser notices the restore
    const before = Date.now()
    expect(restoreHoldEnd(await state(), false, before - DAY, before)).toBe(before + HOLD_MS)
    expect(await watchRestores(t)).toBe(true)
    const noticed = Date.now()
    expect(await state()).toEqual({ rewound: false, restored_at: noticed })
    expect(await watchRestores(t)).toBe(false)
  })

  it('holds what existed when it was noticed until HOLD_MS after that, and in its own run everything', async () => {
    const noticed = Date.parse(NOW)
    const restore = { rewound: false, restored_at: noticed }
    const soon = noticed + HOUR
    expect(restoreHoldEnd(restore, false, noticed - 1, soon)).toBe(noticed + HOLD_MS)
    expect(restoreHoldEnd(restore, false, noticed, noticed + HOLD_MS - 1)).toBe(noticed + HOLD_MS)
    // once the hold would have ended, and for files uploaded after it was noticed
    expect(restoreHoldEnd(restore, false, noticed - 1, noticed + HOLD_MS)).toBeNull()
    expect(restoreHoldEnd(restore, false, noticed + 1, soon)).toBeNull()
    // the run noteRestore started holds every file
    expect(restoreHoldEnd(restore, true, noticed + 1, soon)).toBe(noticed + HOLD_MS)
    // no restore
    expect(restoreHoldEnd({ rewound: false }, false, noticed, soon)).toBeNull()
  })

  it('makes the eraser start a sweep that holds what the restore left unnamed, so a second restore finds it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = newT()
    const f = await withOrg(t)
    const orphan = await storeFile(t)
    await erase(t, Date.now())
    const backup = await backupWatch(t)
    // after the backup: two attachments, and a third let go again
    const first = await attached(t, f)
    const second = await attached(t, f)
    const released = await attached(t, f)
    await remove(t, f, released.row)
    // the next eraser run notices nothing
    await erase(t, Date.now())
    expect(await lastSweep(t)).toMatchObject({ held: 0 })
    vi.setSystemTime(Date.now() + HOUR + 60_000)

    // the restore: the tables go back to the backup, the files stay
    await t.run(async (ctx) => {
      await ctx.db.delete(first.row._id)
      await ctx.db.delete(second.row._id)
      for (const hold of await ctx.db.query('file_holds').collect()) await ctx.db.delete(hold._id)
    })
    await rewindWatch(t, backup)
    const noticed = Date.now()
    await erase(t, noticed)
    expect(await lastSweep(t)).toMatchObject({ deleted: 0, held: 4 })
    for (const file of [orphan, first.row.storage_id, second.row.storage_id])
      expect(await holdFor(t, file)).toMatchObject({
        after_restore: true,
        erase_at: noticed + HOLD_MS,
      })
    // the let-go file still has its scheduled erase from the release
    expect((await pendingErases(t)).map((job) => job.storage_id)).toEqual([released.row.storage_id])

    // a second restore, of a backup taken before the first restore, names
    // the first attachment again
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...doc } = first.row
      await ctx.db.insert('issue_attachments', doc)
    })
    await erase(t, noticed + HOLD_MS)
    expect(await fileState(t, first.row.storage_id)).toBe('kept')
    expect(await fileState(t, second.row.storage_id)).toBe('gone')
    expect(await fileState(t, orphan)).toBe('gone')
  })

  it('makes a sweep that began before it hold instead of erasing', async () => {
    vi.useFakeTimers()
    const t = newT()
    const f = await withOrg(t)
    Object.assign(REAP_PAGES, { files: 1 })
    const orphan = await storeFile(t)
    const { row } = await attached(t, f)
    await quietWatch(t)
    const backup = await backupWatch(t)
    await watchRestores(t)
    vi.setSystemTime(Date.now() + HOUR + 60_000)
    const start = Date.now()
    await t.mutation(internal.files.reapOrphans, {})
    // run legs until the orphan, the first file, is erased
    for (let leg = 0; leg < 20 && (await fileState(t, orphan)) !== 'gone'; leg++) {
      vi.advanceTimersByTime(0)
      await t.finishInProgressScheduledFunctions()
    }
    expect(await fileState(t, orphan)).toBe('gone')
    // the restore lands between two legs, and nothing has noticed it yet
    await t.run((ctx) => ctx.db.delete(row._id))
    await rewindWatch(t, backup)
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0))
    expect(await holdFor(t, row.storage_id)).toMatchObject({
      after_restore: true,
      erase_at: start + HOLD_MS,
    })
    expect(await lastSweep(t)).toMatchObject({ deleted: 1, held: 1 })
  })

  it('makes a weekly sweep that starts while the restored one is still going hold, until HOLD_MS after it was noticed', async () => {
    vi.useFakeTimers()
    const t = newT()
    const f = await withOrg(t)
    await quietWatch(t)
    const backup = await backupWatch(t)
    await watchRestores(t)
    const { row } = await attached(t, f)
    vi.setSystemTime(Date.now() + 2 * HOUR)
    await t.run((ctx) => ctx.db.delete(row._id))
    await rewindWatch(t, backup)
    // the eraser notices the restore; the sweep it starts waits to run
    await t.mutation(internal.files.eraseHeldFiles, {})
    const noticed = Date.now()
    vi.setSystemTime(noticed + 60_000)
    // the weekly sweep reaches the file first
    await t.mutation(internal.files.reapOrphans, { phase: 'files' })
    expect(await lastSweep(t)).toMatchObject({ deleted: 0, held: 1 })
    expect(await holdFor(t, row.storage_id)).toMatchObject({
      after_restore: true,
      erase_at: noticed + HOLD_MS,
    })
  })

  it('makes later sweeps hold a file too young for the first, but not an upload after it was noticed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = newT()
    const f = await withOrg(t)
    await quietWatch(t)
    const backup = await backupWatch(t)
    await watchRestores(t)
    // attached minutes before the restore
    const young = await attached(t, f)
    await t.run((ctx) => ctx.db.delete(young.row._id))
    await rewindWatch(t, backup)
    vi.setSystemTime(Date.now() + 60_000)
    const noticed = Date.now()
    await erase(t, noticed)
    expect(await lastSweep(t)).toMatchObject({ held: 0, kept: 1 })
    expect(await fileState(t, young.row.storage_id)).toBe('kept')
    // an upload after the restore was noticed, never attached
    vi.setSystemTime(noticed + 60_000)
    const after = await storeFile(t)
    // the weekly sweep, past the floor
    vi.setSystemTime(noticed + 2 * HOUR)
    await t.mutation(internal.files.reapOrphans, {})
    await t.finishAllScheduledFunctions(() => {})
    expect(await lastSweep(t)).toMatchObject({ deleted: 1, held: 1 })
    expect(await holdFor(t, young.row.storage_id)).toMatchObject({
      after_restore: true,
      erase_at: noticed + HOLD_MS,
    })
    expect(await fileState(t, after)).toBe('gone')
  })

  it('is never noticed on the demo, which keeps no backups', async () => {
    const t = newT()
    vi.stubEnv('APP_MODE', 'demo')
    expect(await watchRestores(t)).toBe(false)
    expect(await t.run((ctx) => restoreState(ctx))).toEqual({ rewound: false })
    expect(await t.run((ctx) => ctx.db.query('restore_watch').collect())).toEqual([])
  })
})

describe('an organization deletion', () => {
  it('holds every picture, each step within the index range limit', async () => {
    const t = newT()
    const f = await withOrg(t)
    // agents with pictures and no other rows, the most profiles a step reaches
    const faces = await t.run(async (ctx) => {
      const { _id, _creationTime, ...agent } = f.agent
      const ids: Id<'_storage'>[] = []
      for (let n = 0; n < 300; n++) {
        const avatar_storage_id = await ctx.storage.store(new Blob([new Uint8Array(12)]) as never)
        await ctx.db.insert('profiles', { ...agent, id: uuid(), avatar_storage_id })
        ids.push(avatar_storage_id)
      }
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
        phase: 'profiles',
      })
      return ids
    })
    const ranges: number[] = []
    for (let step = 0; step < 20; step++) {
      const done = await t.run(async (ctx) => {
        const removal = await ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        if (removal === null || removal.phase !== 'profiles') return true
        await deleteOrgStep(ctx, removal)
        ranges.push((await ctx.meta.getTransactionMetrics()).databaseQueries.used)
        return false
      })
      if (done) break
    }
    expect(Math.max(...ranges)).toBeLessThan(4096)
    for (const face of faces) expect(await fileState(t, face)).toBe('held')
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
