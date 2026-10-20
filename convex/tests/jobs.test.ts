/* The nightly jobs (jobs.ts) — the archive sweep's SQL semantics (single
 * snapshot, the archived-project drop, the leaf guard), its thresholds (the
 * standard default for teamless projects, a legacy team's saved value where
 * one remains), its chain per organization and bounded legs, and the
 * read-message retention sweep (per-profile period; absent is Never for a
 * person and the default for an agent), its chain per page of profiles and
 * bounded legs, plus the platform_audit_log row each run's dispatcher writes
 * and the counts each chain logs.
 * The weekly reap-orphan-files cron targets files.reapOrphans (crons.ts),
 * which runs in bounded legs and audits itself; its sweep is tested here
 * with the others.
 *
 * The single-snapshot test is the pin against 0106's one-UPDATE reading: a
 * done parent whose done child was archived THIS run waits until tomorrow —
 * the design doc's "iterate to fixpoint" would archive the whole chain in one
 * night, a behavior change.
 *
 * The isolation tests pin the reason for the chains. A leg that fails every
 * time stops only its own organization or page of profiles. */
/// <reference types="vite/client" />

import type { FunctionArgs, WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { REAP_PAGES } from '../files'
import { ARCHIVE_LIMITS, SWEEP_LIMITS } from '../jobs'
import { ITEM_UNREAD_CAP, wakeSnoozedItem } from '../model/messages'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import { DEFAULT_MESSAGE_RETENTION_DAYS, messageRetentionDays } from '../model/people'
import {
  as,
  messagesFor,
  NOW,
  newT,
  plantIssue,
  plantMessage,
  plantProject,
  plantSeat,
  reap,
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

const DEFAULT_ARCHIVE_LIMITS = { ...ARCHIVE_LIMITS }
const DEFAULT_SWEEP_LIMITS = { ...SWEEP_LIMITS }
afterEach(() => {
  Object.assign(ARCHIVE_LIMITS, DEFAULT_ARCHIVE_LIMITS)
  Object.assign(SWEEP_LIMITS, DEFAULT_SWEEP_LIMITS)
})

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

/* The scheduled calls of one function the run made, in schedule order. */
const scheduled = async (t: T, name: string) =>
  (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter((job) =>
    job.name.includes(name),
  )

/* Runs `start`, then every call it schedules, on fake timers. Returns the
 * second argument of every console.info call with `message`, the counts a
 * chain logs on its last leg. */
async function runLogged<Counts>(
  t: T,
  start: () => Promise<unknown>,
  message: string,
): Promise<Counts[]> {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.useFakeTimers()
  try {
    await start()
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    return info.mock.calls.filter(([m]) => m === message).map(([, counts]) => counts as Counts)
  } finally {
    vi.useRealTimers()
    info.mockRestore()
  }
}

type ArchiveCounts = {
  org_id: string
  archived: number
  flagged: number
  now: string
}

/* Runs one nightly archive, the cron's first step and everything it
 * schedules. `now` pins the run's clock, and without it the first step reads
 * the current time. Returns the counts each organization's chain logged. */
const runLegs = (t: T, now?: string): Promise<ArchiveCounts[]> =>
  runLogged(
    t,
    () => t.mutation(internal.jobs.archiveDoneIssues, now === undefined ? {} : { now }),
    'Auto-archive finished',
  )

/* One nightly run that must write its audit row. Returns how many tasks the
 * chains archived. */
async function runArchive(t: T, now?: string): Promise<number> {
  const before = (await auditRows(t, 'archive_done_issues')).length
  const chains = await runLegs(t, now)
  if ((await auditRows(t, 'archive_done_issues')).length !== before + 1) {
    throw new Error('the archive run wrote no audit row')
  }
  return chains.reduce((sum, chain) => sum + chain.archived, 0)
}

/* A test deployment that enforces tighter transaction limits than Convex. */
const limitedT = (transactionLimits: {
  documentsRead?: number
  documentsWritten?: number
  bytesRead?: number
}): T => newT({ transactionLimits })

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

/* An organization row with `id` and one teamless project, for tests that
 * need several organizations in a known order. */
async function plantOrg(t: T, id: string): Promise<Doc<'projects'>> {
  await t.run(async (ctx) => {
    await ctx.db.insert('organizations', {
      id,
      name: 'Sweep',
      slug: `sweep-${id}`,
      created_at: NOW,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
    })
  })
  return await plantProject(t, { org_id: id })
}

/* Runs `work` with console.error silenced and returns whether a failed
 * scheduled call reported the document read limit. */
async function failsOnReads(work: () => Promise<unknown>): Promise<boolean> {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await work()
    return logged.mock.calls.some(([, error]) =>
      String((error as { message?: string } | undefined)?.message).includes(
        'Scanned too many documents',
      ),
    )
  } finally {
    logged.mockRestore()
  }
}

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
    const noStamp = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
    })
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
      plantIssue(t, {
        org_id: f.org.id,
        project_id,
        status: 'done',
        done_at: ago(days),
      })
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

  it('a Done task moved to another sub-project waits the full threshold from the move', async () => {
    const t = newT()
    const f = await withOrg(t)
    const done = () =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'done', done_at: ago(40) })
    const stayed = await done()
    const moved = await done()
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: moved.id,
      project_id: f.sub2.id,
    })

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, stayed.id))?.archived_at).toBeDefined()
    const landed = await issueRow(t, moved.id)
    expect(landed?.archived_at).toBeUndefined()
    // and archives once the full threshold has passed since the move
    const due = new Date(Date.parse(landed!.done_at!) + DEFAULT_ARCHIVE_DAYS * DAY).toISOString()
    expect(await runArchive(t, due)).toBe(1)
    expect((await issueRow(t, moved.id))?.archived_at).toBe(due)
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

  it('a done parent waits for an active child in any project, an archived one included', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archivedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: ago(1),
    })
    const due = {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done' as const,
      done_at: ago(40),
    }
    const shelvedParent = await plantIssue(t, due)
    // its only active child sits in an archived sub-project, which the sweep leaves alone
    await plantIssue(t, {
      ...due,
      project_id: archivedSub.id,
      parent_id: shelvedParent.id,
    })
    const busyParent = await plantIssue(t, due)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: busyParent.id,
      status: 'todo',
    })

    expect(await runArchive(t)).toBe(0)
    expect(await runArchive(t)).toBe(0)
    expect((await issueRow(t, shelvedParent.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, busyParent.id))?.archived_at).toBeUndefined()
  })

  it('a task archived before keeps its own stamp', async () => {
    const t = newT()
    const f = await withOrg(t)
    const earlier = ago(5)
    const shelved = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
      archived_at: earlier,
    })

    expect(await runArchive(t)).toBe(0)
    expect((await issueRow(t, shelved.id))?.archived_at).toBe(earlier)
  })

  it('each run writes one audit row with the organizations it scheduled, and each chain logs its own counts', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })

    const first = await runLegs(t)
    // nothing left to do, so no chain logs
    expect(await runLegs(t)).toEqual([])

    const rows = await auditRows(t, 'archive_done_issues')
    expect(first).toEqual([{ org_id: f.org.id, archived: 1, flagged: 0, now: rows[0].ts }])
    // withOrg plants two organizations
    expect(rows.map((r) => r.detail)).toEqual([{ organizations: 2 }, { organizations: 2 }])
    for (const r of rows) {
      expect(r.actor_email).toBe('system')
      expect(r.actor_auth_id).toBeUndefined()
      expect(r.ts).toBeDefined()
    }
  })

  it('schedules one chain per organization, ARCHIVE_LIMITS.orgs organizations per step', async () => {
    ARCHIVE_LIMITS.orgs = 2
    const t = newT()
    const due = new Map<string, string>()
    for (let n = 0; n < 5; n++) {
      const org_id = uuid()
      const project = await plantOrg(t, org_id)
      const task = await plantIssue(t, {
        org_id,
        project_id: project.id,
        status: 'done',
        done_at: ago(40),
      })
      due.set(org_id, task.id)
    }

    const chains = await runLegs(t)

    expect(chains.map((c) => c.org_id).sort()).toEqual([...due.keys()].sort())
    for (const id of due.values()) expect((await issueRow(t, id))?.archived_at).toBeDefined()
    expect(await scheduled(t, 'archiveDoneIssues')).toHaveLength(2)
    // nothing is flagged, so each chain ends after its one archive leg
    const legs = await scheduled(t, 'archiveOrg')
    expect(legs.map((job) => job.args[0].phase)).toEqual(Array(5).fill('archive'))
    expect((await auditRows(t, 'archive_done_issues')).map((r) => r.detail)).toEqual([
      { organizations: 5 },
    ])
  })
})

describe('archiveDoneIssues keeps every leg bounded', () => {
  it('reads only the due Done tasks, however many open tasks the organization holds', async () => {
    const t = limitedT({ documentsRead: 200 })
    const f = await withOrg(t)
    const due = {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done' as const,
    }
    const tasks = [
      await plantIssue(t, { ...due, done_at: ago(40) }),
      await plantIssue(t, { ...due, done_at: ago(50) }),
      await plantIssue(t, { ...due, done_at: ago(60) }),
    ]
    await plantTasks(t, 5000, { org_id: f.org.id, project_id: f.sub.id })

    expect(await runArchive(t)).toBe(3)
    for (const task of tasks) expect((await issueRow(t, task.id))?.archived_at).toBeDefined()
  })

  it('ends a leg at ARCHIVE_LIMITS.bytes, so large descriptions take several legs', async () => {
    ARCHIVE_LIMITS.bytes = 200_000
    // One leg reads about 400 KB, its candidates and the rows it patches.
    // The 40 tasks together are about 800 KB.
    const t = limitedT({ bytesRead: 600_000 })
    const f = await withOrg(t)
    await plantTasks(t, 40, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
      description: 'x'.repeat(20_000),
    })

    expect(await runArchive(t)).toBe(40)
    const legs = await scheduled(t, 'archiveOrg')
    expect(legs.filter((job) => job.args[0].phase === 'archive').length).toBeGreaterThan(2)
  })

  it('drains a backlog over several legs of one run, and a parent whose child went in an earlier leg still waits', async () => {
    ARCHIVE_LIMITS.tasks = 5
    const t = newT()
    const f = await withOrg(t)
    const due = {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done' as const,
    }
    const parent = await plantIssue(t, { ...due, done_at: ago(40) })
    // The child is the oldest candidate, so the first leg archives it.
    const child = await plantIssue(t, {
      ...due,
      done_at: ago(50),
      parent_id: parent.id,
    })
    await plantTasks(t, 10, { ...due, done_at: ago(45) })

    expect(await runArchive(t)).toBe(11)
    expect((await issueRow(t, child.id))?.archived_at).toBeDefined()
    expect((await issueRow(t, parent.id))?.archived_at).toBeUndefined()
    const legs = await scheduled(t, 'archiveOrg')
    const archiveLegs = legs.filter(
      (job) => job.args[0].org_id === f.org.id && job.args[0].phase === 'archive',
    )
    expect(archiveLegs).toHaveLength(3)

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, parent.id))?.archived_at).toBeDefined()
  })

  it('the leaf guard reads at most two children, however many the parent has archived', async () => {
    const t = limitedT({ documentsRead: 100 })
    const f = await withOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })
    await plantTasks(t, 2000, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
      status: 'done',
      done_at: ago(400),
      archived_at: ago(300),
    })

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, parent.id))?.archived_at).toBeDefined()
  })

  it('splits a page whose leaf guard reads too many child bytes, and still archives the leaves after it', async () => {
    ARCHIVE_LIMITS.bytes = 100_000
    // The active children are about 400 KB together, more than one leg may read.
    const t = limitedT({ bytesRead: 300_000 })
    const f = await withOrg(t)
    const done = {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done' as const,
    }
    const parents: Doc<'issues'>[] = []
    for (let n = 0; n < 20; n++) {
      const parent = await plantIssue(t, { ...done, done_at: ago(50) })
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        parent_id: parent.id,
        description: 'x'.repeat(20_000),
      })
      parents.push(parent)
    }
    // younger, so the same page reads them after the parents
    await plantTasks(t, 5, { ...done, done_at: ago(40) })

    expect(await runArchive(t)).toBe(5)
    for (const parent of parents) {
      expect((await issueRow(t, parent.id))?.archived_at).toBeUndefined()
    }
    const legs = await scheduled(t, 'archiveOrg')
    expect(legs.some((job) => job.args[0].size !== undefined)).toBe(true)
  })

  it('repairs flagged active tasks in pages of ARCHIVE_LIMITS.marked, each once per run', async () => {
    ARCHIVE_LIMITS.marked = 2
    const t = newT()
    const f = await withOrg(t)
    const flagged: Doc<'issues'>[] = []
    for (let n = 0; n < 5; n++) {
      flagged.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: f.sub.id,
          relations_marked: true,
        }),
      )
    }

    expect(await runLegs(t, NOW)).toEqual([{ org_id: f.org.id, archived: 0, flagged: 5, now: NOW }])

    for (const task of flagged) {
      expect((await issueRow(t, task.id))?.relations_marked).toBeUndefined()
    }
    const legs = await scheduled(t, 'archiveOrg')
    const repairs = legs.filter(
      (job) => job.args[0].org_id === f.org.id && job.args[0].phase === 'repair',
    )
    expect(repairs).toHaveLength(3)
    const clears = await scheduled(t, 'archiveMarks:clearTasks')
    expect(clears).toHaveLength(3)
    expect(clears.flatMap((job) => job.args[0].issues).sort()).toEqual(
      flagged.map((task) => task.id).sort(),
    )
  })

  it('an organization deleted after the dispatch ends its chain without an error', async () => {
    const t = newT()
    const f = await withOrg(t)
    const done = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const chains = await runLogged<ArchiveCounts>(
        t,
        async () => {
          await t.mutation(internal.jobs.archiveDoneIssues, {})
          await t.run((ctx) => ctx.db.delete(f.org._id))
        },
        'Auto-archive finished',
      )
      expect(chains).toEqual([])
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    expect((await issueRow(t, done.id))?.archived_at).toBeUndefined()
    // the deleted organization's chain ended at its first leg
    const legs = await scheduled(t, 'archiveOrg')
    expect(legs.filter((job) => job.args[0].org_id === f.org.id)).toHaveLength(1)
  })
})

/* `count` agents of the organization, each able to see `projects` and
 * subscribed to its task.updated events. */
async function plantSubscribers(
  t: T,
  orgId: string,
  projects: readonly string[],
  count: number,
): Promise<void> {
  await t.run(async (ctx) => {
    for (let n = 0; n < count; n++) {
      const profile_id = uuid()
      await ctx.db.insert('profiles', {
        id: profile_id,
        org_id: orgId,
        name: `Hook ${n}`,
        initials: 'HK',
        color: '#50b070',
        org_role: 'user',
        active: true,
        kind: 'agent',
        created_at: NOW,
      })
      for (const project_id of projects)
        await ctx.db.insert('project_access', { project_id, profile_id, level: 'viewer' })
      const credential_id = uuid()
      const credential_row_id = await ctx.db.insert('agent_keys', {
        id: credential_id,
        profile_id,
        name: 'Archive events',
        key_prefix: 'qva_1...1111',
        key_hash: uuid(),
        created_at: NOW,
      })
      await ctx.db.insert('webhook_subscriptions', {
        id: uuid(),
        org_id: orgId,
        owner: { profile_id, credential_table: 'agent_keys', credential_id, credential_row_id },
        name: 'task.updated',
        filters: {},
        url: `https://receiver.example/${n}`,
        encrypted_secret: 'test-only',
        created_at: Date.now(),
      })
    }
  })
}

/* The ids of the tasks each task.updated event in the outbox is about. */
const updatedTasks = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('webhook_events').collect())
      .filter((e) => e.name === 'task.updated')
      .map((e) => e.task_id)
      .sort(),
  )

/* Runs one nightly archive by hand, the dispatcher and the chains' legs in
 * schedule order, on fake timers that never fire. Nothing else runs, so the
 * task.updated events stay in the outbox. Returns the arguments of every
 * archive leg of organization `orgId`, in order. */
async function archiveByHand(
  t: T,
  orgId: string,
): Promise<FunctionArgs<typeof internal.jobs.archiveOrg>[]> {
  vi.useFakeTimers()
  try {
    const legs: FunctionArgs<typeof internal.jobs.archiveOrg>[] = []
    const ran = new Set<string>()
    await t.mutation(internal.jobs.archiveDoneIssues, {})
    for (let guard = 0; guard < 100; guard++) {
      const job = (
        await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      ).find(
        (j) =>
          j.state.kind === 'pending' &&
          !ran.has(j._id) &&
          (j.name.includes('archiveOrg') || j.name.includes('archiveDoneIssues')),
      )
      if (job === undefined) return legs
      ran.add(job._id)
      if (job.name.includes('archiveDoneIssues')) {
        await t.mutation(internal.jobs.archiveDoneIssues, job.args[0])
        continue
      }
      const leg = job.args[0] as FunctionArgs<typeof internal.jobs.archiveOrg>
      if (leg.org_id === orgId && leg.phase === 'archive') legs.push(leg)
      await t.mutation(internal.jobs.archiveOrg, leg)
    }
    throw new Error('the archive did not finish')
  } finally {
    vi.useRealTimers()
  }
}

describe('archiveDoneIssues budgets the events of a leg', () => {
  /* withOrg with two subscribers and three due Done tasks in each of its
   * two sub-projects, Firmware's done first, or the two projects' tasks
   * taking turns. */
  async function scene(order: 'grouped' | 'alternating' = 'grouped') {
    const t = newT()
    const f = await withOrg(t)
    await plantSubscribers(t, f.org.id, [f.sub.id, f.sub2.id], 2)
    const tasks: string[] = []
    const projects =
      order === 'grouped'
        ? [f.sub.id, f.sub.id, f.sub.id, f.sub2.id, f.sub2.id, f.sub2.id]
        : [f.sub.id, f.sub2.id, f.sub.id, f.sub2.id, f.sub.id, f.sub2.id]
    for (const [i, project_id] of projects.entries()) {
      const task = await plantIssue(t, {
        org_id: f.org.id,
        project_id,
        status: 'done',
        done_at: ago(60 - i),
      })
      tasks.push(task.id)
    }
    return { t, f, tasks: tasks.sort() }
  }

  const archived = (t: T, ids: readonly string[]) =>
    Promise.all(ids.map(async (id) => (await issueRow(t, id))?.archived_at !== undefined))

  it('sends one event per task in one leg while the checks fit the budget', async () => {
    const { t, f, tasks } = await scene()
    expect(await archiveByHand(t, f.org.id)).toHaveLength(1)
    expect(await archived(t, tasks)).toEqual(tasks.map(() => true))
    expect(await updatedTasks(t)).toEqual(tasks)
  })

  it('stops a leg before a project whose checks would pass ARCHIVE_LIMITS.checks, and the next leg goes on', async () => {
    const { t, f, tasks } = await scene()
    // Firmware's first task costs 2 checks and its other tasks none. Board
    // rev's first task would make 4.
    ARCHIVE_LIMITS.checks = 3
    const legs = await archiveByHand(t, f.org.id)
    expect(legs).toHaveLength(2)
    // the second leg reads the first leg's page again
    expect(legs[1].archived).toBe(3)
    expect(legs[1].cursor).toBe(legs[0].cursor)
    expect(await archived(t, tasks)).toEqual(tasks.map(() => true))
    expect(await updatedTasks(t)).toEqual(tasks)
  })

  it('skips the tasks of a project past the budget and still archives the projects it met', async () => {
    const { t, f, tasks } = await scene('alternating')
    ARCHIVE_LIMITS.checks = 3
    const legs = await archiveByHand(t, f.org.id)
    // Firmware's three tasks in the first leg, Board rev's in the second
    expect(legs).toHaveLength(2)
    expect(legs[1].archived).toBe(3)
    expect(await archived(t, tasks)).toEqual(tasks.map(() => true))
    expect(await updatedTasks(t)).toEqual(tasks)
  })

  it('reads the same later page again after a stop', async () => {
    const { t, f, tasks } = await scene()
    // Pages of two: Firmware, Firmware, then Firmware and Board rev, where
    // the second leg's budget lets only the Firmware task through.
    ARCHIVE_LIMITS.tasks = 2
    ARCHIVE_LIMITS.checks = 3
    const legs = await archiveByHand(t, f.org.id)
    expect(legs[2].cursor).toEqual(expect.any(String))
    expect(legs[2].cursor).toBe(legs[1].cursor)
    expect(legs[2].archived).toBe(3)
    expect(await archived(t, tasks)).toEqual(tasks.map(() => true))
    expect(await updatedTasks(t)).toEqual(tasks)
  })

  it('stops a leg once it used ARCHIVE_LIMITS.room of a transaction limit, one task at least', async () => {
    const { t, f, tasks } = await scene()
    ARCHIVE_LIMITS.room = 0
    expect(await archiveByHand(t, f.org.id)).toHaveLength(6)
    expect(await archived(t, tasks)).toEqual(tasks.map(() => true))
    expect(await updatedTasks(t)).toEqual(tasks)
  })
})

describe('archiveDoneIssues and organization deletion', () => {
  it('ends the chain of an organization whose deletion has begun, and archives during the read-only period', async () => {
    const t = newT()
    const f = await withOrg(t)
    const deleting = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: ago(40),
    })
    const readOnly = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      status: 'done',
      done_at: ago(40),
    })
    await t.run(async (ctx) => {
      const removal = {
        reason: 'requested' as const,
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
      }
      await ctx.db.insert('org_removals', { ...removal, org_id: f.org.id, phase: 'profiles' })
      await ctx.db.insert('org_removals', { ...removal, org_id: f.otherOrg.id })
    })

    expect(await runArchive(t)).toBe(1)
    expect((await issueRow(t, deleting.id))?.archived_at).toBeUndefined()
    expect((await issueRow(t, readOnly.id))?.archived_at).toBeDefined()
  })

  it('logs what a chain archived before the deletion began', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      })
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const now = new Date().toISOString()
      await t.mutation(internal.jobs.archiveOrg, {
        org_id: f.org.id,
        now,
        phase: 'archive',
        cursor: undefined,
        archived: 4,
        flagged: 0,
      })
      expect(info).toHaveBeenCalledWith('Auto-archive finished', {
        org_id: f.org.id,
        archived: 4,
        flagged: 0,
        now,
      })
    } finally {
      info.mockRestore()
    }
  })
})

describe('archiveDoneIssues runs one chain per organization', () => {
  it('a leg that fails every time stops only its own organization', async () => {
    // The middle organization's candidates exceed this read budget on every
    // attempt; the other two fit.
    const t = limitedT({ documentsRead: 200 })
    const [first, middle, last] = [uuid(), uuid(), uuid()].sort()
    const due = new Map<string, string>()
    for (const org_id of [first, middle, last]) {
      const project = await plantOrg(t, org_id)
      const done = {
        org_id,
        project_id: project.id,
        status: 'done' as const,
        done_at: ago(40),
      }
      const task = await plantIssue(t, done)
      due.set(org_id, task.id)
      if (org_id === middle) await plantTasks(t, 300, done)
    }

    let chains: ArchiveCounts[] = []
    expect(
      await failsOnReads(async () => {
        chains = await runLegs(t)
      }),
    ).toBe(true)

    expect((await issueRow(t, due.get(first) ?? ''))?.archived_at).toBeDefined()
    expect((await issueRow(t, due.get(middle) ?? ''))?.archived_at).toBeUndefined()
    expect((await issueRow(t, due.get(last) ?? ''))?.archived_at).toBeDefined()
    expect(chains.map((c) => c.org_id).sort()).toEqual([first, last])
    expect((await auditRows(t, 'archive_done_issues')).map((r) => r.detail)).toEqual([
      { organizations: 3 },
    ])
  })
})

type SweepCounts = { to: string; deleted: number; woken: number }

/* One nightly read-message sweep, the cron's first step and everything it
 * schedules. Returns the counts the chains logged, summed, and checks the
 * run wrote its audit row. */
async function runSweep(t: T): Promise<{ deleted: number; woken: number }> {
  const before = (await auditRows(t, 'sweep_read_messages')).length
  const pages = await runLogged<SweepCounts>(
    t,
    () => t.mutation(internal.jobs.sweepReadMessages, {}),
    'Read-message sweep finished',
  )
  if ((await auditRows(t, 'sweep_read_messages')).length !== before + 1) {
    throw new Error('the sweep wrote no audit row')
  }
  return {
    deleted: pages.reduce((sum, page) => sum + page.deleted, 0),
    woken: pages.reduce((sum, page) => sum + page.woken, 0),
  }
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
    const unread = await plantMessage(t, {
      ...base,
      issue_id: uuid(),
      created_at: ago(400),
    })
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
    expect(
      messageRetentionDays({
        kind: 'agent',
        message_retention_days: undefined,
      }),
    ).toBe(DEFAULT_MESSAGE_RETENTION_DAYS)
    expect(
      messageRetentionDays({
        kind: 'person',
        message_retention_days: undefined,
      }),
    ).toBeNull()
    // an unknown kind keeps its messages rather than losing them
    const odd = {
      kind: 'robot',
      message_retention_days: undefined,
    } as unknown as Doc<'profiles'>
    expect(messageRetentionDays(odd)).toBeNull()
  })

  it('writes one audit row with the pages it scheduled as actor system', async () => {
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

    expect(await runSweep(t)).toEqual({ deleted: 1, woken: 0 })

    const rows = await auditRows(t, 'sweep_read_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_email).toBe('system')
    // withOrg's six profiles fit one page
    expect(rows[0].detail).toEqual({ pages: 1 })
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
    const stale = await plantMessage(t, {
      ...base,
      issue_id: uuid(),
      read_at: ago(8),
    })

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
  })

  it('runs in bounded legs: a backlog larger than one leg finishes in one run with one audit row', async () => {
    // One leg's writes fit this budget; the whole backlog in one transaction would not.
    const t = limitedT({ documentsWritten: SWEEP_LIMITS.rows + 10 })
    const f = await withOrg(t)
    const read = {
      org_id: f.org.id,
      recipient_id: f.agent.id,
      read_at: ago(30),
    }
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
    await plantRead(SWEEP_LIMITS.rows)
    await plantRead(SWEEP_LIMITS.rows)
    await plantRead(10)
    // unread rows, however many, are neither swept nor read by the sweep
    await plantRead(SWEEP_LIMITS.rows, { read_at: undefined })
    // overdue snoozes on another profile, past the same budget
    await t.run((ctx) => ctx.db.patch(f.admin._id, { message_retention_days: 7 }))
    await plantRead(SWEEP_LIMITS.rows + 5, {
      recipient_id: f.admin.id,
      read_at: undefined,
      snoozed_until: ago(1),
    })

    expect(await runSweep(t)).toEqual({
      deleted: 2 * SWEEP_LIMITS.rows + 10,
      woken: SWEEP_LIMITS.rows + 5,
    })
    const left = await t.run((ctx) => ctx.db.query('messages').collect())
    expect(left).toHaveLength(2 * SWEEP_LIMITS.rows + 5)
    expect(left.filter((m) => m.recipient_id === f.agent.id && m.read_at !== undefined)).toEqual([])
    expect(left.filter((m) => m.snoozed_until !== undefined)).toEqual([])
    expect(await auditRows(t, 'sweep_read_messages')).toHaveLength(1)
  })

  it('schedules one chain per page of SWEEP_LIMITS.profiles profiles and still reaches every one', async () => {
    SWEEP_LIMITS.profiles = 4
    const t = newT()
    const f = await withOrg(t)
    for (let n = 0; n < 5; n++) {
      const agent = await plantSeat(t, {
        org_id: f.org.id,
        kind: 'agent',
        name: `Bot ${n}`,
        plannable_hours: undefined,
      })
      await plantMessage(t, {
        org_id: f.org.id,
        recipient_id: agent.id,
        issue_id: uuid(),
        read_at: ago(30),
      })
    }

    const pages = await runLogged<SweepCounts>(
      t,
      async () => {
        await t.mutation(internal.jobs.sweepReadMessages, {})
        // the first step scheduled one page and the next step, not the row
        expect(await auditRows(t, 'sweep_read_messages')).toEqual([])
      },
      'Read-message sweep finished',
    )

    expect(pages.reduce((sum, page) => sum + page.deleted, 0)).toBe(5)
    // withOrg's six profiles and the five agents, in uuid order
    const ids = (await t.run((ctx) => ctx.db.query('profiles').collect())).map((p) => p.id).sort()
    expect(ids).toHaveLength(11)
    const ranges = (await scheduled(t, 'sweepProfiles')).map((job) => [
      job.args[0].from,
      job.args[0].to,
    ])
    expect(ranges).toEqual([
      [ids[0], ids[3]],
      [ids[4], ids[7]],
      [ids[8], ids[10]],
    ])
    const rows = await auditRows(t, 'sweep_read_messages')
    expect(rows.map((r) => r.detail)).toEqual([{ pages: 3 }])
  })

  it('a page whose leg fails every time stops only its own profiles', async () => {
    SWEEP_LIMITS.profiles = 2
    // The middle page's first profile holds more expired rows than this read
    // budget; every other profile fits.
    const t = limitedT({ documentsRead: 300 })
    const org_id = uuid()
    const ids = Array.from({ length: 6 }, (_, n) => `00000000-0000-4000-8000-00000000000${n}`)
    const expired = {
      org_id,
      issue_id: uuid(),
      read_at: ago(DEFAULT_MESSAGE_RETENTION_DAYS + 1),
    }
    for (const [n, id] of ids.entries()) {
      await plantSeat(t, {
        org_id,
        id,
        kind: 'agent',
        name: `Bot ${n}`,
        plannable_hours: undefined,
      })
      await plantMessage(t, { ...expired, recipient_id: id })
    }
    await t.run(async (ctx) => {
      for (let n = 0; n < 400; n++) {
        await ctx.db.insert('messages', {
          ...expired,
          id: uuid(),
          recipient_id: ids[2],
          issue_title: 'Bulk',
          kind: 'change',
          detail: 'bulk',
          created_at: NOW,
        })
      }
    })

    let pages: SweepCounts[] = []
    expect(
      await failsOnReads(async () => {
        pages = await runLogged<SweepCounts>(
          t,
          () => t.mutation(internal.jobs.sweepReadMessages, {}),
          'Read-message sweep finished',
        )
      }),
    ).toBe(true)

    // the read limit applies here too, so ask each profile for one row
    const kept = await t.run(async (ctx) => {
      const rows = []
      for (const id of ids) {
        rows.push(
          await ctx.db
            .query('messages')
            .withIndex('by_recipient_read', (q) => q.eq('recipient_id', id))
            .first(),
        )
      }
      return rows.map((row) => row !== null)
    })
    expect(kept).toEqual([false, false, true, true, false, false])
    expect(pages.map((page) => page.to).sort()).toEqual([ids[1], ids[5]])
    expect((await auditRows(t, 'sweep_read_messages')).map((r) => r.detail)).toEqual([{ pages: 3 }])
  })

  it('a wake answers how many rows it wrote, each written once, for a live or an archived task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const live = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
    })
    const shelved = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    // full items whose wakes were lost, read once before the snooze
    for (const task of [live, shelved]) {
      await t.run(async (ctx) => {
        for (let n = 0; n <= ITEM_UNREAD_CAP; n++) {
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: f.org.id,
            recipient_id: f.admin.id,
            issue_id: task.id,
            issue_title: task.title,
            kind: 'change',
            detail: `change ${n}`,
            created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
            read_at: n === 0 ? NOW : undefined,
            snoozed_until: ago(1),
          })
        }
      })
    }
    const wake = (issue_id: string) =>
      t.run(async (ctx) => {
        const written = await wakeSnoozedItem(ctx, { recipient_id: f.admin.id, issue_id }, 'now')
        return {
          written,
          used: (await ctx.meta.getTransactionMetrics()).documentsWritten.used,
        }
      })
    for (const task of [live, shelved]) {
      expect(await wake(task.id)).toEqual({
        written: ITEM_UNREAD_CAP + 1,
        used: ITEM_UNREAD_CAP + 1,
      })
    }
    // the live item comes back whole and unread, the archived one keeps only
    // its newest row, read
    const back = await messagesFor(t, f.admin.id, live.id)
    expect(back).toHaveLength(ITEM_UNREAD_CAP + 1)
    for (const m of back) {
      expect([m.snoozed_until, m.read_at, m.woke_at]).toEqual([undefined, undefined, 'now'])
    }
    const kept = await messagesFor(t, f.admin.id, shelved.id)
    expect(kept.map((m) => [m.detail, m.read_at !== undefined, m.snoozed_until])).toEqual([
      [`change ${ITEM_UNREAD_CAP}`, true, undefined],
    ])
    // nothing left to wake writes nothing
    expect(await wake(live.id)).toEqual({ written: 0, used: 0 })
  })

  it('wakes overdue items in legs within the budget, each once, and still sweeps later profiles', async () => {
    // a leg with its whole budget can always wake one full item
    expect(SWEEP_LIMITS.rows).toBeGreaterThanOrEqual(ITEM_UNREAD_CAP + 1)
    // a leg's budget; waking every item that one leg's sample of overdue
    // rows touches would write far more
    const t = limitedT({ documentsWritten: SWEEP_LIMITS.rows })
    const f = await withOrg(t)
    const agent = (id: string, name: string) =>
      plantSeat(t, {
        org_id: f.org.id,
        id,
        kind: 'agent',
        name,
        plannable_hours: undefined,
      })
    // first in uuid order, so every other profile waits for its legs
    const snoozer = await agent('00000000-0000-4000-8000-000000000000', 'Snoozer')
    // last in uuid order, with a read message past its retention
    const last = await agent('ffffffff-ffff-4fff-bfff-ffffffffffff', 'Last')
    const stale = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: last.id,
      issue_id: uuid(),
      read_at: ago(DEFAULT_MESSAGE_RETENTION_DAYS + 1),
    })
    // full items whose wakes were lost, their rows interleaved in creation
    // order, so the first overdue rows of the range belong to every item
    const items = Array.from({ length: 25 }, () => uuid())
    for (let n = 0; n <= ITEM_UNREAD_CAP; n++) {
      await t.run(async (ctx) => {
        for (const issue_id of items) {
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: f.org.id,
            recipient_id: snoozer.id,
            issue_id,
            issue_title: 'Busy task',
            kind: 'comment',
            detail: 'New comment',
            created_at: NOW,
            snoozed_until: ago(1),
          })
        }
      })
    }

    expect(await runSweep(t)).toEqual({ deleted: 1, woken: items.length })

    const rows = await messagesFor(t, snoozer.id)
    expect(rows).toHaveLength(items.length * (ITEM_UNREAD_CAP + 1))
    expect(rows.filter((m) => m.snoozed_until !== undefined || m.read_at !== undefined)).toEqual([])
    // one stamp, the run's, on every row
    expect(new Set(rows.map((m) => m.woke_at)).size).toBe(1)
    expect(rows[0].woke_at).toBeDefined()
    expect(await messagesFor(t, last.id)).not.toContainEqual(stale)
    // a leg wakes whole items while one more could fit its budget
    const perLeg = Math.floor(SWEEP_LIMITS.rows / (ITEM_UNREAD_CAP + 1))
    expect(await scheduled(t, 'sweepProfiles')).toHaveLength(Math.ceil(items.length / perLeg))
  })
})

/* files.reapOrphans, the 0033 sweep. Bytes nothing references die once older
 * than the 60-minute floor (0033:34-38, never race an upload whose attach is
 * seconds away), measured from the run's start. A run deletes expired upload
 * tickets, clears the appearance of logins that no longer exist, then checks
 * every stored file, in legs that each schedule the next, and its last leg
 * writes one audit row. _creationTime cannot be backdated, so the clock is
 * advanced past the floor instead. Most cases fake Date only, leaving
 * convex-test's real timers to run the legs (it stamps _creationTime from
 * Date.now()). The cases that stop between legs fake every timer. */
describe('reapOrphans — orphaned bytes die after the floor', () => {
  const DEFAULT_PAGES = { ...REAP_PAGES }
  afterEach(() => {
    vi.useRealTimers()
    Object.assign(REAP_PAGES, DEFAULT_PAGES)
  })

  const HOUR = 3_600_000

  const storeBlob = (t: T): Promise<Id<'_storage'>> =>
    t.run(async (ctx) => await ctx.storage.store(new Blob(['bytes']) as never))

  // Blob is not a Convex value, so the probe answers inside the run
  const blobExists = (t: T, id: Id<'_storage'>): Promise<boolean> =>
    t.run(async (ctx) => (await ctx.storage.get(id)) !== null)

  const storedCount = (t: T): Promise<number> =>
    t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)

  /* An attachment row on `issue` that references `storage_id`. */
  const attach = (t: T, issue: Doc<'issues'>, storage_id: Id<'_storage'>) =>
    t.run(async (ctx) => {
      await ctx.db.insert('issue_attachments', {
        org_id: issue.org_id,
        id: uuid(),
        issue_id: issue.id,
        name: 'kept.txt',
        size_bytes: 5,
        storage_id,
        inline: false,
        created_at: NOW,
      })
    })

  /* A Better Auth login; returns its id. */
  async function login(t: T, name: string): Promise<string> {
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name,
          email: `${name}@reap.test`,
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    return user._id as string
  }

  /* A library image whose original and preview are both stored. */
  async function libraryImage(t: T): Promise<Id<'_storage'>[]> {
    const files = [await storeBlob(t), await storeBlob(t)]
    await t.run(async (ctx) => {
      await ctx.db.insert('panorama_images', {
        id: uuid(),
        storage_id: files[0],
        preview_storage_id: files[1],
        source_id: uuid(),
        source_url: '',
        download_url: '',
        title: 'Lake',
        creator: 'Photographer',
        license: 'CC0',
        license_url: '',
        attribution: '',
        source_metadata: '{}',
        sha256: uuid(),
        width: 1920,
        height: 1080,
        byte_size: 5,
        status: 'approved',
        imported_at: NOW,
      })
    })
    return files
  }

  /* A login's chosen custom background, original and preview stored. */
  async function customBackground(t: T, authId: string): Promise<Id<'_storage'>[]> {
    const files = [await storeBlob(t), await storeBlob(t)]
    await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('custom_backgrounds', {
        id,
        auth_user_id: authId,
        storage_id: files[0],
        preview_storage_id: files[1],
        name: 'Private.jpg',
        mime: 'image/jpeg',
        width: 1920,
        height: 1080,
        byte_size: 5,
        sha256: uuid(),
        uploaded_at: NOW,
      })
      await ctx.db.insert('account_appearance', {
        auth_user_id: authId,
        mode: 'dark',
        image_source: 'custom',
        custom_image_id: id,
        revision: uuid(),
        updated_at: NOW,
      })
    })
    return files
  }

  /* One expired-or-not ticket of each kind, expiring at `expires_at`. */
  const plantTickets = (t: T, issue: Doc<'issues'>, profileId: string, expires_at: number) =>
    t.run(async (ctx) => {
      await ctx.db.insert('background_uploads', {
        id: uuid(),
        auth_user_id: 'tickets-login',
        name: 'Lake.jpg',
        expires_at,
        expected_revision: uuid(),
      })
      await ctx.db.insert('attachment_uploads', {
        id: uuid(),
        org_id: issue.org_id,
        profile_id: profileId,
        issue_id: issue.id,
        name: 'log.txt',
        size_bytes: 5,
        expires_at,
      })
    })

  const ticketCount = (t: T) =>
    t.run(async (ctx) => ({
      background: (await ctx.db.query('background_uploads').collect()).length,
      attachment: (await ctx.db.query('attachment_uploads').collect()).length,
    }))

  /* The arguments of the reapOrphans leg waiting to run, or null when the
   * run has ended. */
  const pendingLeg = (t: T) =>
    t.run(async (ctx) => {
      const jobs = await ctx.db.system.query('_scheduled_functions').collect()
      const job = jobs.find((j) => j.name.includes('reapOrphans') && j.state.kind === 'pending')
      return job === undefined ? null : (job.args[0] as { phase: string; cursor?: string })
    })

  /* Runs the waiting leg alone, under fake timers, and returns the next. */
  async function step(t: T) {
    vi.runOnlyPendingTimers()
    await t.finishInProgressScheduledFunctions()
    return await pendingLeg(t)
  }

  it('runs in bounded legs that keep every referenced and fresh file and audit once', async () => {
    const t = newT()
    const f = await withOrg(t)
    Object.assign(REAP_PAGES, { tickets: 2, accounts: 1, files: 2 })
    vi.useFakeTimers({ toFake: ['Date'] })

    const kept = await login(t, 'kept')
    const gone = await login(t, 'gone')
    const orphans = [] as Id<'_storage'>[]
    for (let n = 0; n < 5; n++) orphans.push(await storeBlob(t))
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const attached = await storeBlob(t)
    await attach(t, issue, attached)
    const avatar = await storeBlob(t)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { avatar_storage_id: avatar }))
    const library = await libraryImage(t)
    const custom = await customBackground(t, kept)
    const removed = await customBackground(t, gone)
    // a raw component delete bypasses the auth API hook and leaves the
    // login's appearance behind
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: gone }] },
    })
    for (let n = 0; n < 3; n++) await plantTickets(t, issue, f.user.id, Date.now() - 1)
    await plantTickets(t, issue, f.user.id, Date.now() + 3 * HOUR)

    // past the floor: everything stored above is now old; the next one is not
    vi.setSystemTime(Date.now() + HOUR + 60_000)
    const fresh = await storeBlob(t)

    expect(await reap(t)).toEqual({ deleted: 5, kept: 7, tickets: 6, accounts: 1 })

    for (const id of [...orphans, ...removed]) expect(await blobExists(t, id)).toBe(false)
    for (const id of [attached, avatar, ...library, ...custom, fresh])
      expect(await blobExists(t, id)).toBe(true)
    expect(await ticketCount(t)).toEqual({ background: 1, attachment: 1 })
    const appearance = await t.run((ctx) => ctx.db.query('account_appearance').collect())
    expect(appearance.map((row) => row.auth_user_id)).toEqual([kept])

    const rows = await auditRows(t, 'reap_orphans')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_email).toBe('system')
    expect(rows[0].actor_auth_id).toBeUndefined()
    // tickets: 3 expired of each kind in pages of 2. accounts: 2 rows in
    // pages of 1. files: 12 left in pages of 2. The first leg is the call.
    const legs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(legs.filter((job) => job.name.includes('reapOrphans'))).toHaveLength(2 + 2 + 6 - 1)
  })

  it('keeps a file attached between legs', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    Object.assign(REAP_PAGES, { files: 1 })
    vi.useFakeTimers()
    const [first, second, late] = [await storeBlob(t), await storeBlob(t), await storeBlob(t)]
    vi.setSystemTime(Date.now() + HOUR + 60_000)

    await t.mutation(internal.files.reapOrphans, {})
    let leg = await pendingLeg(t)
    while (leg !== null && !(leg.phase === 'files' && leg.cursor !== undefined)) leg = await step(t)
    // the first files leg is done, and the last file sits on a later page
    expect(await blobExists(t, first)).toBe(false)
    await attach(t, issue, late)
    while (leg !== null) leg = await step(t)

    expect(await blobExists(t, second)).toBe(false)
    expect(await blobExists(t, late)).toBe(true)
    expect((await auditRows(t, 'reap_orphans'))[0].detail).toEqual({
      deleted: 2,
      kept: 1,
      tickets: 0,
      accounts: 0,
    })
  })

  it("measures the floor from the run's start, not from a later leg's clock", async () => {
    const t = newT()
    vi.useFakeTimers()
    const young = await storeBlob(t)
    vi.setSystemTime(Date.now() + HOUR - 60_000)
    const start = Date.now()

    await t.mutation(internal.files.reapOrphans, {})
    let leg = await pendingLeg(t)
    while (leg !== null && leg.phase !== 'files') leg = await step(t)
    // the file is past the floor by the time its leg runs
    vi.setSystemTime(Date.now() + 10 * 60_000)
    while (leg !== null) leg = await step(t)

    expect(await blobExists(t, young)).toBe(true)
    const [row] = await auditRows(t, 'reap_orphans')
    expect(row.detail).toEqual({ deleted: 0, kept: 1, tickets: 0, accounts: 0 })
    expect(row.ts).toBe(new Date(start).toISOString())
  })

  it('a zero-file run still writes its counts-only audit row', async () => {
    const t = newT()

    expect(await reap(t)).toEqual({ deleted: 0, kept: 0, tickets: 0, accounts: 0 })

    const rows = await auditRows(t, 'reap_orphans')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_email).toBe('system')
  })

  it('the floor alone protects: with only fresh files, nothing dies', async () => {
    const t = newT()
    const a = await storeBlob(t)
    const b = await storeBlob(t)

    expect(await reap(t)).toEqual({ deleted: 0, kept: 2, tickets: 0, accounts: 0 })
    expect(await blobExists(t, a)).toBe(true)
    expect(await blobExists(t, b)).toBe(true)
  })

  it("stays inside Convex's transaction limits with many orphans", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    vi.useFakeTimers({ toFake: ['Date'] })
    // 800 orphans cost 6 index ranges each, over the 4,096 one leg may read
    await t.run(async (ctx) => {
      for (let n = 0; n < 800; n++) await ctx.storage.store(new Blob(['bytes']) as never)
    })
    const kept: Id<'_storage'>[] = []
    for (let n = 0; n < 100; n++) {
      const id = await storeBlob(t)
      await attach(t, issue, id)
      kept.push(id)
    }
    for (let n = 0; n < 20; n++) kept.push(...(await libraryImage(t)))
    vi.setSystemTime(Date.now() + HOUR + 60_000)

    expect(await reap(t)).toEqual({ deleted: 800, kept: 140, tickets: 0, accounts: 0 })
    expect(await storedCount(t)).toBe(140)
    for (const id of kept) expect(await blobExists(t, id)).toBe(true)
  })
})
