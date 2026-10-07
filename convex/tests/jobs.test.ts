/* The nightly jobs (jobs.ts) — the archive sweep's SQL semantics (single
 * snapshot, the team-less-root and archived-project drops, the leaf guard)
 * and the read-message retention sweep (per-profile period, absent = Never),
 * plus the counts-only platform_audit_log row each run writes in-transaction.
 * The weekly reap-orphan-files cron targets files.reapOrphans directly
 * (crons.ts — it audits itself); its sweep is tested here with the others.
 *
 * The single-snapshot test is the pin against 0106's one-UPDATE reading: a
 * done parent whose done child was archived THIS run waits until tomorrow —
 * the design doc's "iterate to fixpoint" would archive the whole chain in one
 * night, a behavior change. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import {
  NOW,
  newT,
  plantIssue,
  plantMessage,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it (same situation as helpers.setup's crypto) */
declare class Blob {
  constructor(parts: string[])
}

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()

const issueRow = (t: T, id: string): Promise<Doc<'issues'> | null> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
  )

const auditRows = (t: T, action: string): Promise<Doc<'platform_audit_log'>[]> =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('platform_audit_log').withIndex('by_ts').collect()
    return rows.filter((r) => r.action === action)
  })

describe('archiveDoneIssues — the 0106 predicate', () => {
  it('archives an old done leaf; leaves fresh done and done-without-done_at alone', async () => {
    const t = newT()
    const f = await withOrg(t) // team archive_days = 30
    // Archive thresholds remain a legacy team setting; new projects are
    // teamless, so attach this fixture row explicitly for the compatibility
    // path under test.
    await t.run((ctx) => ctx.db.patch(f.sub._id, { team_id: f.team.id }))
    const oldDone = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })
    const freshDone = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(5),
    })
    // the demo-seed fact: done_at never given ⇒ the sweep never takes it
    const noStamp = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'done' })

    const { archived } = await t.mutation(internal.jobs.archiveDoneIssues, {})

    expect(archived).toBe(1)
    expect((await issueRow(t, oldDone.id))?.archived_at).toBeDefined()
    expect((await issueRow(t, freshDone.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, noStamp.id))?.archived_at).toBeUndefined()
  })

  it('single snapshot: a done parent whose done child is archived this run waits until the next', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { team_id: f.team.id }))
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
      status: 'done',
      done_at: ago(40),
    })

    const first = await t.mutation(internal.jobs.archiveDoneIssues, {})
    expect(first.archived).toBe(1)
    expect((await issueRow(t, child.id))?.archived_at).toBeDefined()
    // the child was unarchived AS OF the snapshot, so the parent waits
    expect((await issueRow(t, parent.id))?.archived_at).toBeUndefined()

    const second = await t.mutation(internal.jobs.archiveDoneIssues, {})
    expect(second.archived).toBe(1)
    expect((await issueRow(t, parent.id))?.archived_at).toBeDefined()
  })

  it('a team-less root is never swept (the SQL inner join on teams)', async () => {
    const t = newT()
    const f = await withOrg(t) // f.hidden is a meta with no team
    const orphanSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const done = await plantIssue(t, {
      org_id: f.org.id,
      project_id: orphanSub.id,
      status: 'done',
      done_at: ago(400),
    })

    const { archived } = await t.mutation(internal.jobs.archiveDoneIssues, {})

    expect(archived).toBe(0)
    expect((await issueRow(t, done.id))?.archived_at).toBeUndefined()
  })

  it('an archived project is left alone — its done tasks stay as the restore left them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archivedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: ago(1),
    })
    const done = await plantIssue(t, {
      org_id: f.org.id,
      project_id: archivedSub.id,
      status: 'done',
      done_at: ago(400),
    })

    const { archived } = await t.mutation(internal.jobs.archiveDoneIssues, {})

    expect(archived).toBe(0)
    expect((await issueRow(t, done.id))?.archived_at).toBeUndefined()
  })

  it('every run writes one counts-only audit row in the same transaction, zero-count runs included', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { team_id: f.team.id }))
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })

    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await t.mutation(internal.jobs.archiveDoneIssues, {})

    const rows = await auditRows(t, 'archive_done_issues')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.detail)).toEqual([{ archived: 1 }, { archived: 0 }])
    for (const r of rows) {
      expect(r.actor_email).toBe('system')
      expect(r.actor_auth_id).toBeUndefined()
      expect(r.ts).toBeDefined()
    }
  })
})

describe('sweepReadMessages — retention follows the person', () => {
  it('sweeps rows read longer ago than the period; unread and fresh-read stay; absent = Never', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.admin._id, { message_retention_days: 7 })
    })
    const issue_id = uuid()
    const staleRead = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id,
      read_at: ago(8),
    })
    const freshRead = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id,
      read_at: ago(1),
    })
    // an UNREAD message is never swept however old it is
    const unread = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id,
      created_at: ago(400),
    })
    // f.user has no message_retention_days — absent means keep forever
    const keptForever = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.user.id,
      issue_id,
      read_at: ago(400),
    })

    const { deleted } = await t.mutation(internal.jobs.sweepReadMessages, {})

    expect(deleted).toBe(1)
    const remaining = await t.run(async (ctx) => await ctx.db.query('messages').collect())
    const ids = remaining.map((m) => m.id).sort()
    expect(ids).toEqual([freshRead.id, keptForever.id, unread.id].sort())
    expect(ids).not.toContain(staleRead.id)
  })

  it('writes its counts-only audit row as actor system', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.viewer._id, { message_retention_days: 30 })
    })
    await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.viewer.id,
      issue_id: uuid(),
      read_at: ago(31),
    })

    await t.mutation(internal.jobs.sweepReadMessages, {})

    const rows = await auditRows(t, 'sweep_read_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_email).toBe('system')
    expect(rows[0].detail).toEqual({ deleted: 1, woken: 0 })
  })

  it('a snoozed row is never swept, and one whose instant has passed is woken instead', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.admin._id, { message_retention_days: 7 })
    })
    const base = { org_id: f.org.id, recipient_id: f.admin.id }
    // read long ago, but snoozed into next week: a pending reminder, kept
    const pending = await plantMessage(t, {
      ...base,
      issue_id: uuid(),
      read_at: ago(30),
      snoozed_until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    })
    // its scheduled wake never ran (the stamp is in the past): the sweep is
    // the fallback that brings it back — unread, with the wake stamp
    const overdueIssue = uuid()
    const overdue = await plantMessage(t, {
      ...base,
      issue_id: overdueIssue,
      read_at: ago(30),
      snoozed_until: ago(1),
    })
    const stale = await plantMessage(t, { ...base, issue_id: uuid(), read_at: ago(8) })

    const result = await t.mutation(internal.jobs.sweepReadMessages, {})
    expect(result).toEqual({ deleted: 1, woken: 1 })

    const remaining = await t.run(async (ctx) => await ctx.db.query('messages').collect())
    const byId = new Map(remaining.map((m) => [m.id, m]))
    expect(byId.has(stale.id)).toBe(false)
    expect(byId.get(pending.id)?.snoozed_until).toBeDefined()
    expect(byId.get(pending.id)?.read_at).toBe(pending.read_at)
    const woken = byId.get(overdue.id)
    expect(woken?.snoozed_until).toBeUndefined()
    expect(woken?.read_at).toBeUndefined()
    expect(woken?.woke_at).toBeDefined()
    const rows = await auditRows(t, 'sweep_read_messages')
    expect(rows[0].detail).toEqual({ deleted: 1, woken: 1 })
  })
})

/* files.reapOrphans — the 0033 sweep: bytes referenced by neither
 * issue_attachments.storage_id nor profiles.avatar_storage_id die once older
 * than the 60-minute floor (0033:34-38 — never race an upload whose attach is
 * seconds away). _creationTime cannot be backdated, so the clock is advanced
 * past the floor instead — Date only, leaving convex-test's real timers
 * alone (it stamps _creationTime from Date.now()). */
describe('reapOrphans — orphaned bytes die after the floor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const HOUR = 3_600_000

  const storeBlob = (t: T): Promise<Id<'_storage'>> =>
    t.run(async (ctx) => await ctx.storage.store(new Blob(['bytes']) as never))

  // Blob is not a Convex value, so the probe answers inside the run
  const blobExists = (t: T, id: Id<'_storage'>): Promise<boolean> =>
    t.run(async (ctx) => (await ctx.storage.get(id)) !== null)

  it('deletes only the old unreferenced file; attachment, avatar, and fresh bytes survive', async () => {
    const t = newT()
    const f = await withOrg(t)
    vi.useFakeTimers({ toFake: ['Date'] })

    const orphan = await storeBlob(t)
    const attached = await storeBlob(t)
    const avatar = await storeBlob(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_attachments', {
        org_id: issue.org_id,
        id: uuid(),
        issue_id: issue.id,
        name: 'kept.txt',
        size_bytes: 5,
        storage_id: attached,
        inline: false,
        created_at: NOW,
      })
      await ctx.db.patch(f.admin._id, { avatar_storage_id: avatar })
    })

    // past the floor: everything stored above is now old; the next one is not
    vi.setSystemTime(Date.now() + HOUR + 60_000)
    const fresh = await storeBlob(t)

    const counts = await t.mutation(internal.files.reapOrphans, {})

    expect(counts).toEqual({ deleted: 1, kept: 3 })
    expect(await blobExists(t, orphan)).toBe(false)
    expect(await blobExists(t, attached)).toBe(true)
    expect(await blobExists(t, avatar)).toBe(true)
    expect(await blobExists(t, fresh)).toBe(true)

    const rows = await auditRows(t, 'reap_orphans')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toEqual({ deleted: 1, kept: 3 })
    expect(rows[0].actor_email).toBe('system')
    expect(rows[0].actor_auth_id).toBeUndefined()
    expect(rows[0].ts).toBeDefined()
  })

  it('a zero-file run still writes its counts-only audit row', async () => {
    const t = newT()

    await t.mutation(internal.files.reapOrphans, {})

    const rows = await auditRows(t, 'reap_orphans')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toEqual({ deleted: 0, kept: 0 })
    expect(rows[0].actor_email).toBe('system')
  })

  it('the floor alone protects: with only fresh files, nothing dies', async () => {
    const t = newT()
    const a = await storeBlob(t)
    const b = await storeBlob(t)

    const counts = await t.mutation(internal.files.reapOrphans, {})

    expect(counts).toEqual({ deleted: 0, kept: 2 })
    expect(await blobExists(t, a)).toBe(true)
    expect(await blobExists(t, b)).toBe(true)
  })
})
