/* The nightly jobs (jobs.ts) — the archive sweep's SQL semantics (single
 * snapshot, the archived-project drop, the leaf guard), its thresholds (the
 * standard default for teamless projects, a legacy team's saved value where
 * one remains) and its bounded legs, and the read-message retention sweep
 * (per-profile period; absent is Never for a person and the default for an
 * agent) and its bounded legs, plus the counts-only platform_audit_log row
 * each run writes in-transaction.
 * The weekly reap-orphan-files cron targets files.reapOrphans directly
 * (crons.ts — it audits itself); its sweep is tested here with the others.
 *
 * The single-snapshot test is the pin against 0106's one-UPDATE reading: a
 * done parent whose done child was archived THIS run waits until tomorrow —
 * the design doc's "iterate to fixpoint" would archive the whole chain in one
 * night, a behavior change. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { ARCHIVE_BATCH, SWEEP_BATCH, SWEEP_PROFILES } from '../jobs'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import { DEFAULT_MESSAGE_RETENTION_DAYS, messageRetentionDays } from '../model/people'
import schema from '../schema'
import {
  NOW,
  newT,
  plantIssue,
  plantMessage,
  plantProject,
  plantSeat,
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

/* One nightly run: the cron's first leg and every leg it schedules. `now`
 * pins the run's clock; without it the first leg reads the current time. */
async function runLegs(t: T, now?: string): Promise<void> {
  vi.useFakeTimers()
  try {
    await t.mutation(internal.jobs.archiveDoneIssues, now === undefined ? {} : { now })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  } finally {
    vi.useRealTimers()
  }
}

/* One nightly run that must succeed. Returns the archived count from the
 * run's audit row. */
async function runArchive(t: T, now?: string): Promise<number> {
  await runLegs(t, now)
  const last = (await auditRows(t, 'archive_done_issues')).at(-1)
  if (last === undefined) throw new Error('the archive run wrote no audit row')
  return (last.detail as { archived: number }).archived
}

/* A test deployment that enforces tighter transaction limits than Convex. */
const limitedT = (transactionLimits: { documentsRead?: number; documentsWritten?: number }): T =>
  convexTest({ schema, modules: import.meta.glob('../**/*.*s'), transactionLimits })

/* Inserts `count` tasks of one shape in a single transaction. */
let bulkNum = 10_000
const plantTasks = (
  t: T,
  count: number,
  issue: { org_id: string; project_id: string } & Partial<WithoutSystemFields<Doc<'issues'>>>,
): Promise<void> =>
  t.run(async (ctx) => {
    for (let n = 0; n < count; n++) {
      await ctx.db.insert('issues', {
        id: uuid(),
        num: bulkNum++,
        title: 'Bulk task',
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        ...issue,
      })
    }
  })

describe('archiveDoneIssues — the 0106 predicate', () => {
  it('archives Done tasks in a teamless project from the standard threshold on; younger and unstamped ones stay', async () => {
    const t = newT()
    const f = await withOrg(t) // f.sub and its root f.meta have no team
    // The run's clock is pinned to NOW, so the boundary holds to the millisecond.
    const cutoff = Date.parse(NOW) - DEFAULT_ARCHIVE_DAYS * DAY
    const due = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: new Date(cutoff).toISOString(),
    })
    const fresh = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: new Date(cutoff + 1).toISOString(),
    })
    // the demo-seed fact: done_at never given ⇒ the sweep never takes it
    const noStamp = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'done' })
    const open = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'todo',
      updated_at: ago(400),
    })

    expect(DEFAULT_ARCHIVE_DAYS).toBe(30)
    expect(await runArchive(t, NOW)).toBe(1)
    expect((await issueRow(t, due.id))?.archived_at).toBe(NOW)
    expect((await issueRow(t, fresh.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, noStamp.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, open.id))?.archived_at).toBeUndefined()
  })

  it('a legacy team keeps its saved threshold, from the sub-project first, else its root', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      // the root keeps a legacy team saved at 90 days; f.sub2 has its own at 10
      await ctx.db.patch(f.team._id, { archive_days: 90 })
      await ctx.db.patch(f.meta._id, { team_id: f.team.id })
      const quick = uuid()
      await ctx.db.insert('teams', {
        id: quick,
        org_id: f.org.id,
        name: 'Quick',
        stale_days: 120,
        archive_days: 10,
        track_delay_default: true,
        created_at: NOW,
      })
      await ctx.db.patch(f.sub2._id, { team_id: quick })
    })
    const done = (project_id: string, days: number) =>
      plantIssue(t, { org_id: f.org.id, project_id, status: 'done', done_at: ago(days) })
    // f.sub has no team of its own, so its root's 90 days apply
    const rootKept = await done(f.sub.id, 40)
    const rootDue = await done(f.sub.id, 91)
    // f.sub2's own team (10 days) wins over the root's
    const ownKept = await done(f.sub2.id, 9)
    const ownDue = await done(f.sub2.id, 11)

    expect(await runArchive(t)).toBe(2)
    expect((await issueRow(t, rootKept.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, rootDue.id))?.archived_at).toBeDefined()
    expect((await issueRow(t, ownKept.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, ownDue.id))?.archived_at).toBeDefined()
  })

  it('single snapshot: a done parent whose done child is archived this run waits until the next', async () => {
    const t = newT()
    const f = await withOrg(t)
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

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, child.id))?.archived_at).toBeDefined()
    // the child was unarchived AS OF the snapshot, so the parent waits
    expect((await issueRow(t, parent.id))?.archived_at).toBeUndefined()

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, parent.id))?.archived_at).toBeDefined()
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

    expect(await runArchive(t)).toBe(0)
    expect((await issueRow(t, done.id))?.archived_at).toBeUndefined()
  })

  it('every run writes one counts-only audit row in the same transaction, zero-count runs included', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })

    await runArchive(t)
    await runArchive(t)

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

describe('archiveDoneIssues — bounded legs', () => {
  it('reads one organization per leg', async () => {
    // Both organizations' tasks together exceed this read budget; either
    // organization alone fits.
    const t = limitedT({ documentsRead: 1000 })
    const f = await withOrg(t)
    const otherSub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const here = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })
    const there = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: otherSub.id,
      status: 'done',
      done_at: ago(40),
    })
    await plantTasks(t, 600, { org_id: f.org.id, project_id: f.sub.id })
    await plantTasks(t, 600, { org_id: f.otherOrg.id, project_id: otherSub.id })

    expect(await runArchive(t)).toBe(2)
    expect((await issueRow(t, here.id))?.archived_at).toBeDefined()
    expect((await issueRow(t, there.id))?.archived_at).toBeDefined()
  })

  it('drains a larger backlog in the same run, and a parent whose child went in an earlier leg still waits', async () => {
    // One leg's writes fit this budget; the whole backlog in one transaction would not.
    const t = limitedT({ documentsWritten: ARCHIVE_BATCH + 10 })
    const f = await withOrg(t)
    const due = {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done' as const,
      done_at: ago(40),
    }
    const parentId = uuid()
    // The child is the oldest row, so the first leg archives it.
    await plantTasks(t, 1, { ...due, parent_id: parentId })
    await plantTasks(t, ARCHIVE_BATCH, due)
    await plantTasks(t, ARCHIVE_BATCH - 1, due)
    await plantTasks(t, 1, { ...due, id: parentId })

    expect(await runArchive(t)).toBe(2 * ARCHIVE_BATCH)
    expect((await issueRow(t, parentId))?.archived_at).toBeUndefined()

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, parentId))?.archived_at).toBeDefined()
  })

  it('a failing leg keeps earlier legs, writes no audit row and stops the organizations after it', async () => {
    // The middle organization's tasks exceed this read budget on every
    // attempt; the other two fit.
    const t = limitedT({ documentsRead: 1000 })
    const [first, middle, last] = [uuid(), uuid(), uuid()].sort()
    const due = new Map<string, string>()
    for (const org_id of [first, middle, last]) {
      await t.run(async (ctx) => {
        await ctx.db.insert('organizations', {
          id: org_id,
          name: 'Sweep',
          slug: `sweep-${org_id}`,
          created_at: NOW,
          next_issue_num: 1,
          next_project_num: 1,
          date_format: 'iso',
          week_start: 1,
          week_one_rule: 'first4day',
          default_plannable_hours: 40,
          gravatar_avatars: false,
        })
      })
      const project = await plantProject(t, { org_id })
      const task = await plantIssue(t, {
        org_id,
        project_id: project.id,
        status: 'done',
        done_at: ago(40),
      })
      due.set(org_id, task.id)
      if (org_id === middle) await plantTasks(t, 1000, { org_id, project_id: project.id })
    }

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runLegs(t)
      expect(logged).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ message: expect.stringContaining('Scanned too many documents') }),
      )
    } finally {
      logged.mockRestore()
    }

    expect((await issueRow(t, due.get(first) ?? ''))?.archived_at).toBeDefined()
    expect((await issueRow(t, due.get(middle) ?? ''))?.archived_at).toBeUndefined()
    // The known limit (jobs.ts header): nothing schedules the later legs.
    expect((await issueRow(t, due.get(last) ?? ''))?.archived_at).toBeUndefined()
    expect(await auditRows(t, 'archive_done_issues')).toEqual([])
  })
})

/* One nightly read-message sweep, the cron's first leg and every leg it
 * schedules. Returns the counts from the run's audit row. */
async function runSweep(t: T): Promise<{ deleted: number; woken: number }> {
  vi.useFakeTimers()
  try {
    await t.mutation(internal.jobs.sweepReadMessages, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  } finally {
    vi.useRealTimers()
  }
  const last = (await auditRows(t, 'sweep_read_messages')).at(-1)
  if (last === undefined) throw new Error('the sweep wrote no audit row')
  return last.detail as { deleted: number; woken: number }
}

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

    const { deleted } = await runSweep(t)

    expect(deleted).toBe(1)
    const remaining = await t.run(async (ctx) => await ctx.db.query('messages').collect())
    const ids = remaining.map((m) => m.id).sort()
    expect(ids).toEqual([freshRead.id, keptForever.id, unread.id].sort())
    expect(ids).not.toContain(staleRead.id)
  })

  it('an agent without a period keeps read messages for the default; its own period wins', async () => {
    const t = newT()
    const f = await withOrg(t)
    // f.agent has no message_retention_days, like every agent created
    // before the default and every seeded one
    const base = { org_id: f.org.id, recipient_id: f.agent.id }
    const stale = await plantMessage(t, {
      ...base,
      issue_id: uuid(),
      read_at: ago(DEFAULT_MESSAGE_RETENTION_DAYS + 1),
    })
    const fresh = await plantMessage(t, {
      ...base,
      issue_id: uuid(),
      read_at: ago(DEFAULT_MESSAGE_RETENTION_DAYS - 1),
    })
    const unread = await plantMessage(t, { ...base, issue_id: uuid(), created_at: ago(400) })
    // a person without a period chose Never
    const person = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.user.id,
      issue_id: uuid(),
      read_at: ago(400),
    })
    const patient = await plantSeat(t, {
      org_id: f.org.id,
      kind: 'agent',
      name: 'Patient',
      plannable_hours: undefined,
      message_retention_days: 30,
    })
    const kept = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: patient.id,
      issue_id: uuid(),
      read_at: ago(DEFAULT_MESSAGE_RETENTION_DAYS + 1),
    })

    expect(await runSweep(t)).toEqual({ deleted: 1, woken: 0 })
    const ids = (await t.run((ctx) => ctx.db.query('messages').collect())).map((m) => m.id)
    expect(ids.sort()).toEqual([fresh.id, unread.id, person.id, kept.id].sort())
    expect(ids).not.toContain(stale.id)
  })

  it('messageRetentionDays: a stored period decides, else agents get the default and people keep', () => {
    expect(messageRetentionDays({ kind: 'person', message_retention_days: 30 })).toBe(30)
    expect(messageRetentionDays({ kind: 'agent', message_retention_days: 1 })).toBe(1)
    expect(messageRetentionDays({ kind: 'agent', message_retention_days: undefined })).toBe(
      DEFAULT_MESSAGE_RETENTION_DAYS,
    )
    expect(messageRetentionDays({ kind: 'person', message_retention_days: undefined })).toBeNull()
    // an unknown kind keeps its messages rather than losing them
    const odd = { kind: 'robot', message_retention_days: undefined } as unknown as Doc<'profiles'>
    expect(messageRetentionDays(odd)).toBeNull()
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

    await runSweep(t)

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

    expect(await runSweep(t)).toEqual({ deleted: 1, woken: 1 })

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

  it('runs in bounded legs: a backlog larger than one leg finishes in one run with one audit row', async () => {
    // One leg's writes fit this budget; the whole backlog in one transaction would not.
    const t = limitedT({ documentsWritten: SWEEP_BATCH + 10 })
    const f = await withOrg(t)
    const read = { org_id: f.org.id, recipient_id: f.agent.id, read_at: ago(30) }
    const plantRead = (count: number, over: Partial<WithoutSystemFields<Doc<'messages'>>> = {}) =>
      t.run(async (ctx) => {
        for (let n = 0; n < count; n++) {
          await ctx.db.insert('messages', {
            id: uuid(),
            issue_title: 'Bulk',
            kind: 'change',
            detail: 'bulk',
            created_at: NOW,
            issue_id: uuid(),
            ...read,
            ...over,
          })
        }
      })
    await plantRead(SWEEP_BATCH)
    await plantRead(SWEEP_BATCH)
    await plantRead(10)
    // unread rows, however many, are neither swept nor read by the sweep
    await plantRead(SWEEP_BATCH, { read_at: undefined })
    // overdue snoozes on another profile, past the same budget
    await t.run((ctx) => ctx.db.patch(f.admin._id, { message_retention_days: 7 }))
    await plantRead(SWEEP_BATCH + 5, {
      recipient_id: f.admin.id,
      read_at: undefined,
      snoozed_until: ago(1),
    })

    expect(await runSweep(t)).toEqual({ deleted: 2 * SWEEP_BATCH + 10, woken: SWEEP_BATCH + 5 })
    const left = await t.run((ctx) => ctx.db.query('messages').collect())
    expect(left).toHaveLength(2 * SWEEP_BATCH + 5)
    expect(left.filter((m) => m.recipient_id === f.agent.id && m.read_at !== undefined)).toEqual([])
    expect(left.filter((m) => m.snoozed_until !== undefined)).toEqual([])
    expect(await auditRows(t, 'sweep_read_messages')).toHaveLength(1)
  })

  it('visits at most SWEEP_PROFILES profiles per leg and still reaches every one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const agents: string[] = []
    for (let n = 0; n < SWEEP_PROFILES + 5; n++) {
      const agent = await plantSeat(t, {
        org_id: f.org.id,
        kind: 'agent',
        name: `Bot ${n}`,
        plannable_hours: undefined,
      })
      agents.push(agent.id)
      await plantMessage(t, {
        org_id: f.org.id,
        recipient_id: agent.id,
        issue_id: uuid(),
        read_at: ago(30),
      })
    }
    vi.useFakeTimers()
    try {
      await t.mutation(internal.jobs.sweepReadMessages, {})
      // the first leg stopped short of the last profiles and scheduled the rest
      expect(await auditRows(t, 'sweep_read_messages')).toEqual([])
      await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    } finally {
      vi.useRealTimers()
    }
    const rows = await auditRows(t, 'sweep_read_messages')
    expect(rows.map((r) => r.detail)).toEqual([{ deleted: SWEEP_PROFILES + 5, woken: 0 }])
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
