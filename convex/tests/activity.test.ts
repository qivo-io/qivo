/* model/activity + the activity rows the issue mutations write.
 *
 * Three contracts under test:
 * - issueChanges: the machine from→to narration, verbatim (core.ts grammar —
 *   clean() strips the diff grammar's own marks so a crafted value cannot
 *   forge phantom clauses);
 * - activity retention: every reader shows an organization's newest 500
 *   rows, and a background trim deletes older ones without making writers
 *   conflict;
 * - the browser verbs/details ported from the old client — the feed icon
 *   substring-matches the verb (IssueDetail.tsx evIcon), so every byte of
 *   every verb string is load-bearing.
 * Plus atomicity: a refused mutation leaves ZERO activity rows and ZERO
 * messages, even when the refusal lands AFTER the core already wrote. */
/// <reference types="vite/client" />

import type { FunctionArgs } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { taskActivity } from '../lib/activityVisibility'
import {
  ACTIVITY_CAP,
  ACTIVITY_TRIM_BUDGET,
  ACTIVITY_TRIM_DELAY_MS,
  ACTIVITY_TRIM_STALE_MS,
  issueChanges,
  logActivity,
  namedTaskNums,
  trimActivity,
} from '../model/activity'
import { pendingRemoval } from '../model/cascade'
import {
  activityFor,
  allMessages,
  as,
  countersFor,
  drainActivity,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

type Patch = FunctionArgs<typeof api.issues.update>['patch']

/* A stored-row shape for the pure narration tests — issueChanges only reads
 * the diffed columns, so the system fields can be stand-ins. */
const row = (over: Partial<Doc<'issues'>> = {}): Doc<'issues'> =>
  ({
    _id: 'x',
    _creationTime: 0,
    id: 'i-1',
    project_id: 'p-1',
    org_id: 'o-1',
    num: 1,
    title: 'Old',
    description: '',
    status: 'backlog',
    priority: 'low',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }) as unknown as Doc<'issues'>

describe('issueChanges — machine narration, verbatim', () => {
  it('the exemplar: (status Backlog → Done, remaining 80 h → 40 h)', () => {
    const s = issueChanges(
      row({ remaining_hours: 80 }),
      row({ status: 'done', remaining_hours: 40 }),
    )
    expect(s).toBe('(status Backlog → Done, remaining 80 h → 40 h)')
    expect(s).toContain(' → ') // the arrow is U+2192, spaced
  })

  it('field order, labels and value grammar across all twelve columns', () => {
    const names = new Map([
      ['u-guest', 'Guest'],
      ['u-reviewer', 'Reviewer'],
      ['u-reporter', 'Reporter'],
    ])
    const s = issueChanges(
      row(),
      row({
        title: 'New',
        status: 'done',
        priority: 'urgent',
        assignee_id: 'u-guest',
        reviewer_id: 'u-reviewer',
        reporter_id: 'u-reporter',
        due_date: '2026-08-05',
        start_week: '2026-01-05',
        end_week: '2026-01-11',
        remaining_hours: 2.5,
        paused: true,
        description: 'Body',
      }),
      names,
    )
    expect(s).toBe(
      '(title “Old” → “New”, status Backlog → Done, priority Low → Urgent, ' +
        'assignee unset → Guest, reviewer unset → Reviewer, reporter unset → Reporter, ' +
        'due date unset → 2026-08-05, ' +
        'start week unset → 2026-01-05, end week unset → 2026-01-11, ' +
        'remaining unset → 2.5 h, paused no → yes, ' +
        'description unset → “Body”)',
    )
  })

  it('clean(): arrows fold to hyphens, curly quotes to straight, whitespace collapses', () => {
    expect(issueChanges(row({ description: 'go → stop  now' }), row({ description: '' }))).toBe(
      '(description “go - stop now” → unset)',
    )
    expect(issueChanges(row({ title: 'He said “hi”' }), row({ title: 'X' }))).toBe(
      "(title “He said 'hi'” → “X”)",
    )
    expect(issueChanges(row({ description: '' }), row({ description: '  a \n\n b ' }))).toBe(
      '(description unset → “a b”)',
    )
  })

  it('free text excerpts at 80 codepoints: slice at 79 plus the ellipsis', () => {
    const long = 'a'.repeat(90)
    expect(issueChanges(row(), row({ description: long }))).toBe(
      `(description unset → “${'a'.repeat(79)}…”)`,
    )
  })

  it('the assignee falls back to the uuid without a names map', () => {
    expect(issueChanges(row({ assignee_id: 'u-a' }), row({ assignee_id: 'u-b' }))).toBe(
      '(assignee u-a → u-b)',
    )
  })

  it('undefined when nothing narratable changed (server-owned columns are not in the diff)', () => {
    expect(
      issueChanges(row(), row({ updated_at: '2026-02-01T00:00:00.000Z', done_at: NOW })),
    ).toBeUndefined()
  })
})

describe('activity retention, newest 500 shown and older rows trimmed in the background', () => {
  // Fake time keeps the settle cutoff and the trim delay deterministic.
  const START = Date.parse('2026-05-04T10:00:00.000Z')
  const at = (ms: number) => new Date(ms).toISOString()
  const DEFAULT_BUDGET = { ...ACTIVITY_TRIM_BUDGET }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    Object.assign(ACTIVITY_TRIM_BUDGET, DEFAULT_BUDGET)
    vi.useRealTimers()
  })

  const write = (t: T, orgId: string, ts: string, target = 'new') =>
    t.run(async (ctx) => {
      await logActivity(ctx, {
        org_id: orgId,
        actor_id: undefined,
        verb: 'created',
        target_type: 'issue',
        target_id: target,
        label: 'x',
        ts,
      })
      return ctx.meta.getTransactionMetrics()
    })

  /* `count` rows of `orgId`, `step` ms apart from `from`, inserted raw. */
  const plantRows = (
    t: T,
    orgId: string,
    count: number,
    from: number,
    prefix = 'seed',
    step = 1000,
  ) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++)
        await ctx.db.insert('activity_events', {
          id: `${prefix}-${i}`,
          org_id: orgId,
          ts: at(from + i * step),
          verb: 'seeded',
          target_type: 'issue',
          target_id: `${prefix}-${i}`,
          label: 'x',
        })
    })

  const newestFirst = (t: T, orgId: string) =>
    t.run((ctx) =>
      ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
        .order('desc')
        .collect(),
    )

  const trims = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === 'activityRetention:trim',
      ),
    )

  const stateOf = (t: T, orgId: string) =>
    t.run((ctx) =>
      ctx.db
        .query('activity_retention')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .unique(),
    )

  it('the first write records a pending trim and schedules one, even for several rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++)
        await logActivity(ctx, {
          org_id: f.org.id,
          actor_id: f.admin.id,
          verb: 'created',
          target_type: 'issue',
          target_id: `new-${i}`,
          label: 'x',
          ts: at(START),
        })
    })
    expect(await activityFor(t, f.org.id)).toHaveLength(3)
    const pending = await trims(t)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      args: [{ org_id: f.org.id }],
      scheduledTime: START + ACTIVITY_TRIM_DELAY_MS,
      state: { kind: 'pending' },
    })
    expect(await stateOf(t, f.org.id)).toMatchObject({
      trim_due_at: START + ACTIVITY_TRIM_DELAY_MS,
    })
    // the organization row is only read
    expect(await t.run((ctx) => ctx.db.get(f.org._id))).toEqual(f.org)
  })

  it('while a trim is pending, a write stores only its own row', async () => {
    const t = newT()
    const f = await withOrg(t)
    await write(t, f.org.id, at(START))
    const metrics = await write(t, f.org.id, at(START))
    expect(metrics.documentsWritten.used).toBe(1)
    expect(metrics.functionsScheduled.used).toBe(0)
    expect(await trims(t)).toHaveLength(1)
  })

  it('a pending trim lost for over an hour is scheduled again; a late one is not', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('activity_retention', {
        org_id: f.org.id,
        trim_due_at: START - ACTIVITY_TRIM_STALE_MS + 60_000,
      })
      await ctx.db.insert('activity_retention', {
        org_id: f.otherOrg.id,
        trim_due_at: START - ACTIVITY_TRIM_STALE_MS - 1,
      })
    })
    await write(t, f.org.id, at(START))
    await write(t, f.otherOrg.id, at(START))
    expect((await trims(t)).map((job) => job.args[0])).toEqual([{ org_id: f.otherOrg.id }])
    expect(await stateOf(t, f.otherOrg.id)).toMatchObject({
      trim_due_at: START + ACTIVITY_TRIM_DELAY_MS,
    })
  })

  it('a trim keeps the newest 500 in the exact index order, ties and backdated rows included', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = at(START - 60_000)
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++)
        await ctx.db.insert('activity_events', {
          id: `tied-${i}`,
          org_id: f.org.id,
          ts: old,
          verb: 'seeded',
          target_type: 'issue',
          target_id: `task-${i}`,
          label: 'x',
        })
    })
    const before = await newestFirst(t, f.org.id)
    await write(t, f.org.id, old)
    expect(await newestFirst(t, f.org.id)).toHaveLength(501) // nothing deleted yet
    expect(await t.run((ctx) => trimActivity(ctx, f.org.id))).toBe('done')
    const tied = await newestFirst(t, f.org.id)
    expect(tied).toHaveLength(500)
    expect(tied[0].target_id).toBe('new')
    expect(tied.slice(1).map((row) => row.id)).toEqual(before.slice(0, 499).map((row) => row.id))
    await write(t, f.org.id, '2025-01-01T00:00:00.000Z', 'backdated')
    expect(await t.run((ctx) => trimActivity(ctx, f.org.id))).toBe('done')
    expect((await newestFirst(t, f.org.id)).map((row) => row.id)).toEqual(tied.map((row) => row.id))
  })

  it('a trim leaves rows newer than the settle time and other organizations alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantRows(t, f.org.id, 510, START - 3_600_000)
    await plantRows(t, f.org.id, 5, START - 2_000, 'recent')
    await plantRows(t, f.otherOrg.id, 3, START - 3_600_000, 'other')
    // the 5 recent rows still hold the organization past the cap
    expect(await t.run((ctx) => trimActivity(ctx, f.org.id))).toBe('later')
    const kept = await newestFirst(t, f.org.id)
    expect(kept).toHaveLength(505)
    expect(kept.slice(0, 5).map((row) => row.id)).toEqual([
      'recent-4',
      'recent-3',
      'recent-2',
      'recent-1',
      'recent-0',
    ])
    expect(kept.at(-1)?.id).toBe('seed-10') // seeds 0..9 were the overflow
    expect(await activityFor(t, f.otherOrg.id)).toHaveLength(3)
  })

  it('a trim answers later only while rows too new to trim hold the organization past the cap', async () => {
    const t = newT()
    const f = await withOrg(t)
    const trimmed = () => t.run((ctx) => trimActivity(ctx, f.org.id))
    // 300 settled rows leave room for 200 recent ones
    await plantRows(t, f.org.id, 300, START - 3_600_000)
    await plantRows(t, f.org.id, 200, START - 5_000, 'recent', 0)
    expect(await trimmed()).toBe('done')
    await plantRows(t, f.org.id, 1, START - 2_000, 'late')
    expect(await trimmed()).toBe('later')
    expect(await activityFor(t, f.org.id)).toHaveLength(501) // nothing was old enough to go
  })

  it('rows too new to trim keep the trim pending until it brings the organization to the cap', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantRows(t, f.org.id, 500, START - 3_600_000)
    await plantRows(t, f.org.id, 10, START - 2_000, 'recent', 0)
    await t.run((ctx) =>
      ctx.db.insert('activity_retention', { org_id: f.org.id, trim_due_at: START }),
    )
    await t.mutation(internal.activityRetention.trim, { org_id: f.org.id })
    expect(await activityFor(t, f.org.id)).toHaveLength(510)
    const due = START + ACTIVITY_TRIM_DELAY_MS
    expect((await stateOf(t, f.org.id))?.trim_due_at).toBe(due)
    expect((await trims(t)).map((job) => [job.scheduledTime, job.state.kind])).toEqual([
      [due, 'pending'],
    ])
    // no write follows, and the scheduled trim alone removes the excess
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const kept = await newestFirst(t, f.org.id)
    expect(kept).toHaveLength(500)
    expect(kept.slice(0, 10).every((row) => row.id.startsWith('recent-'))).toBe(true)
    expect((await stateOf(t, f.org.id))?.trim_due_at).toBeUndefined()
    expect((await trims(t)).map((job) => job.state.kind)).toEqual(['success'])
  })

  it('a trim run while another is due later leaves the schedule to that one', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantRows(t, f.org.id, 505, START - 3_600_000)
    await plantRows(t, f.org.id, 10, START - 2_000, 'recent', 0)
    await plantRows(t, f.otherOrg.id, 3, START - 3_600_000, 'other')
    const due = START + 60_000
    await t.run(async (ctx) => {
      for (const org_id of [f.org.id, f.otherOrg.id])
        await ctx.db.insert('activity_retention', { org_id, trim_due_at: due })
    })
    for (const org_id of [f.org.id, f.otherOrg.id])
      await t.mutation(internal.activityRetention.trim, { org_id })
    // it deletes what it may but neither reschedules nor clears the due trim
    expect(await activityFor(t, f.org.id)).toHaveLength(510)
    for (const org_id of [f.org.id, f.otherOrg.id])
      expect((await stateOf(t, org_id))?.trim_due_at).toBe(due)
    expect(await trims(t)).toEqual([])
  })

  it('a project purge and profile removal stay within limits with a trim backlog', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // More rows about one project by one agent than a transaction may write
    // (16,000), as a lost trim and a busy agent could leave them.
    const count = 16_100
    for (let from = 0; from < count; from += count / 2)
      await t.run(async (ctx) => {
        for (let i = from; i < from + count / 2; i++)
          await ctx.db.insert('activity_events', {
            id: `row-${i}`,
            org_id: f.org.id,
            ts: at(START - 3_600_000 + i * 100),
            actor_id: f.agent.id,
            verb: 'updated',
            target_type: 'project',
            target_id: f.sub2.id,
            label: 'x',
            project_id: f.sub2.id,
          })
      })
    const naming = (field: 'actor_id' | 'project_id', id: string) =>
      t.run(
        async (ctx) =>
          (await ctx.db.query('activity_events').collect()).filter((row) => row[field] === id)
            .length,
      )
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub2.id })
    // Deleted items keep the project, so its rows keep naming it
    expect(await naming('project_id', f.sub2.id)).toBe(count)
    const item = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', f.sub2.id))
        .unique(),
    )
    if (item === null) throw new Error('the project is not in Deleted items')
    // Delete now, its steps run one by one so that no trim runs yet
    const job = () =>
      t.run((ctx) =>
        ctx.db
          .query('deleted_item_jobs')
          .withIndex('by_item', (q) => q.eq('item_id', item.id))
          .unique(),
      )
    const stepThrough = async () => {
      while ((await job()) !== null)
        await t.mutation(internal.deletedItems.step, { item_id: item.id })
    }
    await stepThrough()
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] })
    await stepThrough()
    expect(await t.run((ctx) => ctx.db.get(item._id))).toBeNull()
    // the rows readers show lose the project. They are the delete's own
    // row, filed under the parent, and the newest 499 of the backlog. Older
    // ones wait for the trim
    expect(await naming('project_id', f.sub2.id)).toBe(count - (ACTIVITY_CAP - 1))
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.agent.id })
    expect(await naming('actor_id', f.agent.id)).toBe(count - ACTIVITY_CAP)
    const shown = await t.run((ctx) =>
      ctx.db
        .query('activity_events')
        .withIndex('by_org_ts', (q) => q.eq('org_id', f.org.id))
        .order('desc')
        .take(ACTIVITY_CAP),
    )
    expect(
      shown.filter((row) => row.actor_id === f.agent.id || row.project_id === f.sub2.id),
    ).toEqual([])
    // the removal's activity phase clears the rest before any trim runs
    while ((await t.run((ctx) => pendingRemoval(ctx, f.agent.id))) !== null)
      await t.mutation(internal.profileRemovals.step, { profile_id: f.agent.id })
    expect(await naming('actor_id', f.agent.id)).toBe(0)
    expect(await activityFor(t, f.org.id)).toHaveLength(count + 2) // plus both narrations
    // then the trim deletes the backlog
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await activityFor(t, f.org.id)).toHaveLength(ACTIVITY_CAP)
    await assertNoDanglingRefs(t, 'after deletions over a trim backlog')
  }, 120_000)

  it('a backlog larger than one step is trimmed over several steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    ACTIVITY_TRIM_BUDGET.rows = 4
    await plantRows(t, f.org.id, 510, START - 3_600_000)
    await write(t, f.org.id, at(START))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const kept = await newestFirst(t, f.org.id)
    expect(kept).toHaveLength(500)
    expect(kept[0].target_id).toBe('new')
    expect(kept.at(-1)?.id).toBe('seed-11')
    // 11 rows over the cap at 4 a step
    expect((await trims(t)).map((job) => job.state.kind)).toEqual(['success', 'success', 'success'])
    expect((await stateOf(t, f.org.id))?.trim_due_at).toBeUndefined()
    // the next write schedules a trim again
    await write(t, f.org.id, at(Date.now()))
    expect((await trims(t)).filter((job) => job.state.kind === 'pending')).toHaveLength(1)
  })

  it('readers show only the newest 500 rows before the trim runs', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // The guest cannot see Skunkworks, so 100 of the newest 500 rows hide
    // from it while 100 older rows about `task` would fill their place.
    const secret = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i++) {
        const about = i < 500 ? task : secret
        await ctx.db.insert('activity_events', {
          id: `row-${i}`,
          org_id: f.org.id,
          ts: at(START - 3_600_000 + i * 1000),
          verb: 'updated',
          target_type: 'issue',
          target_id: about.id,
          label: about.title,
          project_id: about.project_id,
        })
      }
    })
    const ids = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, i) => `row-${from - i}`)
    const history = await t.run((ctx) => taskActivity(ctx, f.admin, task))
    expect(history.map((row) => row.id)).toEqual(ids(499, 100).reverse())
    const admin = await as(t, f.admin).query(api.snapshot.forMe, {})
    expect(admin?.activity.map((row) => row.id)).toEqual(ids(599, 100))
    const guest = await as(t, f.guest).query(api.snapshot.forMe, {})
    expect(guest?.activity.map((row) => row.id)).toEqual(ids(499, 100))
  })
})

describe('atomicity — a refused write leaves zero rows', () => {
  it('a move to a destination the caller cannot write writes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: issue.id })
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    // guest can write the source (grant on meta) but not the hidden target;
    // the check runs before the core, so nothing is patched, sent or logged
    await expectRefusal(
      as(t, f.guest).mutation(api.issues.move, {
        org_id: f.org.id,
        id: issue.id,
        project_id: hiddenSub.id,
      }),
      'forbidden',
    )
    const after = await t.run(async (ctx) => (await ctx.db.get(issue._id)) as Doc<'issues'>)
    expect(after.project_id).toBe(f.sub.id)
    expect(after.updated_at).toBe(NOW)
    expect(await activityFor(t, f.org.id)).toHaveLength(0)
    expect(await allMessages(t)).toHaveLength(0)
  })

  it('a refused create rolls the issue counter back with everything else', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: '   ',
      }),
      'bad_request',
      /blank/,
    )
    // bumped before the title guard, rolled back with it
    expect(await countersFor(t, f.org.id)).toEqual({ next_issue_num: 1, next_project_num: 5 })
    expect(await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)).toBe(0)
    expect(await activityFor(t, f.org.id)).toHaveLength(0)
    expect(await allMessages(t)).toHaveLength(0)
  })

  it('the remaining-time rule refusal: verbatim sentence, zero rows, untouched issue', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })
    await as(t, f.admin).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: parent.id })
    await expectRefusal(
      as(t, f.user).mutation(api.issues.update, {
        org_id: f.org.id,
        id: parent.id,
        patch: { remaining_hours: 5 },
      }),
      'rule',
      /^a task with subtasks has no remaining time of its own — it shows the sum of its subtasks$/,
    )
    const after = await t.run(async (ctx) => (await ctx.db.get(parent._id)) as Doc<'issues'>)
    expect(after.remaining_hours).toBeUndefined()
    expect(after.updated_at).toBe(NOW)
    expect(await activityFor(t, f.org.id)).toHaveLength(0)
    expect(await allMessages(t)).toHaveLength(0)
  })
})

describe('browser verbs — the feed contract (evIcon substring-matches these)', () => {
  it('one verb per update, first matching patch key wins, details verbatim', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const step = async (patch: Patch, verb: string, detail?: string) => {
      await as(t, f.user).mutation(api.issues.update, { org_id: f.org.id, id: issue.id, patch })
      const events = await activityFor(t, f.org.id)
      expect(events).toHaveLength(1)
      expect(events[0].verb).toBe(verb)
      expect(events[0].detail).toBe(detail)
      expect(events[0].target_type).toBe('issue')
      expect(events[0].target_id).toBe(issue.id)
      expect(events[0].actor_id).toBe(f.user.id)
      await drainActivity(t)
    }

    await step({ status: 'progress' }, 'moved', 'from To Do to In Progress')
    await step({ assignee_id: f.guest.id }, 'assigned', 'to guest')
    await step({ assignee_id: f.admin.id }, 'assigned', 'to admin (was guest)')
    await step({ assignee_id: null }, 'unassigned', '(was admin)')
    await step({ reviewer_id: f.guest.id }, 'set the reviewer of', 'to guest')
    await step({ reviewer_id: f.admin.id }, 'set the reviewer of', 'to admin (was guest)')
    await step({ reviewer_id: null }, 'removed the reviewer from', '(was admin)')
    await step({ due_date: '2026-08-05' }, 'set a due date on', 'to 2026-08-05')
    await step({ due_date: '2026-09-12' }, 'moved the due date on', 'from 2026-08-05 to 2026-09-12')
    await step({ due_date: null }, 'cleared the due date on', '(was 2026-09-12)')
    await step(
      { start_week: '2026-01-05', end_week: '2026-01-11' },
      'scheduled',
      'for 5 Jan → 11 Jan',
    )
    await step(
      { start_week: '2026-01-12', end_week: '2026-01-18' },
      'rescheduled',
      'from 5 Jan → 11 Jan to 12 Jan → 18 Jan',
    )
    await step(
      { start_week: null, end_week: null },
      'removed from the roadmap',
      '(was 12 Jan → 18 Jan)',
    )
    await step({ title: 'Renamed task' }, 'renamed', 'from “Planted task”')
    await step({ paused: true }, 'paused', undefined)
    await step({ paused: false }, 'resumed', undefined)
    await step({ priority: 'urgent' }, 'reprioritized', 'from Medium to Urgent')
    await step({ remaining_hours: 8 }, 'set the remaining time on', 'to 8 h')
    await step({ remaining_hours: 2.5 }, 'changed the remaining time on', 'from 8 h to 2.5 h')
    await step({ remaining_hours: null }, 'cleared the remaining time on', '(was 2.5 h)')
    await step({ description: 'Hello world' }, 'added a description to', '“Hello world”')
    await step(
      { description: 'Second' },
      'updated the description of',
      'from “Hello world” to “Second”',
    )
    await step({ description: null }, 'removed the description from', '(was “Second”)')
    await step({}, 'updated', undefined)
    // priority order: status outranks title and the reviewer
    await step({ status: 'todo', title: 'X' }, 'moved', 'from In Progress to To Do')
    await step(
      { status: 'progress', reviewer_id: f.guest.id },
      'moved',
      'from To Do to In Progress',
    )
  })

  it('parent attach/detach narrate under/from the parent key', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.user).mutation(api.issues.update, {
      org_id: f.org.id,
      id: child.id,
      patch: { parent_id: parent.id },
    })
    let events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('moved')
    expect(events[0].detail).toBe(`under QN-${parent.num}`)
    await drainActivity(t)
    await as(t, f.user).mutation(api.issues.update, {
      org_id: f.org.id,
      id: child.id,
      patch: { parent_id: null },
    })
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('detached')
    expect(events[0].detail).toBe(`from QN-${parent.num}`)
  })

  it('lifecycle verbs: created, moved (source-keyed), linked, archived, restored, deleted — and history survives its subjects', async () => {
    const t = newT()
    const f = await withOrg(t)

    // created
    const id = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      title: 'Fresh',
    })
    let events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('created')
    expect(events[0].detail).toBeUndefined()
    expect(events[0].label).toBe('Fresh')
    expect(events[0].project_id).toBe(f.sub.id)
    await drainActivity(t)

    // moved between projects — keyed to the SOURCE project
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id,
      project_id: f.sub2.id,
    })
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('moved')
    expect(events[0].detail).toBe('to the Board rev sub-project (from Firmware)')
    expect(events[0].project_id).toBe(f.sub.id)
    await drainActivity(t)

    // linked — keyed to the canonical source; removeLink logs nothing
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.user).mutation(api.issues.addLink, {
      org_id: f.org.id,
      id: uuid(),
      source_id: id,
      target_id: other.id,
      type: 'blocks',
    })
    events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('linked')
    expect(events[0].detail).toBe(`— blocks QN-${other.num}`)
    expect(events[0].target_id).toBe(id)
    await drainActivity(t)
    await as(t, f.user).mutation(api.issues.removeLink, { org_id: f.org.id, a: id, b: other.id })
    expect(await activityFor(t, f.org.id)).toHaveLength(0)

    // archived without a subtask count (subtasks can sit in projects some
    // readers cannot access), then restored
    const p2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: p2.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: p2.id })
    const archivedP2 = await as(t, f.user).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: p2.id,
    })
    expect(Object.keys(archivedP2)).toEqual(['issue'])
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('archived')
    expect(events[0].detail).toBeUndefined()
    await drainActivity(t)

    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id })
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('archived')
    expect(events[0].detail).toBeUndefined() // a leaf archives alone
    await drainActivity(t)

    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id })
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('restored')
    expect(events[0].detail).toBe('from the archive')
    await drainActivity(t)

    // deleted — and the older rows about the same issue would have survived
    await as(t, f.user).mutation(api.issues.deleteDeep, { org_id: f.org.id, id })
    events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].verb).toBe('deleted')
    expect(events[0].detail).toBeUndefined()
    expect(events[0].target_id).toBe(id) // history outlives its subject
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique(),
      ),
    ).toBeNull()
  })
})

describe('namedTaskNums — the relation grammar the snapshot checks', () => {
  const row = (verb: string, detail?: string, target_type: 'issue' | 'project' = 'issue') => ({
    verb,
    detail,
    target_type,
  })

  it('reads the task numbers a parent change or link names', () => {
    expect(namedTaskNums(row('moved', 'under QN-5 (from QN-3)'))).toEqual([5, 3])
    expect(namedTaskNums(row('moved', 'under QN-5'))).toEqual([5])
    expect(namedTaskNums(row('moved', 'under its parent (from QN-3)'))).toEqual([3])
    expect(namedTaskNums(row('detached', 'from QN-3'))).toEqual([3])
    expect(namedTaskNums(row('detached', 'from its parent'))).toEqual([])
    expect(namedTaskNums(row('linked', '— blocks QN-6'))).toEqual([6])
    expect(namedTaskNums(row('linked', '— relates to QN-6'))).toEqual([6])
  })

  it('names nothing for other rows', () => {
    expect(namedTaskNums(row('moved', 'from To Do to Done'))).toEqual([])
    expect(namedTaskNums(row('moved', 'to the Firmware sub-project (from Board rev)'))).toEqual([])
    expect(namedTaskNums(row('renamed', 'from “Fix QN-9”'))).toEqual([])
    expect(namedTaskNums(row('linked', '— blocks QN-6', 'project'))).toEqual([])
  })

  it('answers null for relation wording no writer produces, so readers fail closed', () => {
    expect(namedTaskNums(row('linked', '— blocks PCB-12'))).toBeNull()
    expect(namedTaskNums(row('linked'))).toBeNull()
    expect(namedTaskNums(row('detached', 'from QN-3 and QN-4'))).toBeNull()
    expect(namedTaskNums(row('moved', 'under QN-5 (from PCB-3)'))).toBeNull()
  })
})
