/* model/activity + the activity rows the issue mutations write.
 *
 * Three contracts under test:
 * - issueChanges: the machine from→to narration, verbatim (core.ts grammar —
 *   clean() strips the diff grammar's own marks so a crafted value cannot
 *   forge phantom clauses);
 * - activity history: each subject (one task, project, person...) keeps
 *   every row, whatever other subjects write, and readers page one task's
 *   rows, newest first, past rows a member does not receive;
 * - the browser verbs/details ported from the old client — the feed icon
 *   substring-matches the verb (IssueDetail.tsx evIcon), so every byte of
 *   every verb string is load-bearing.
 * Plus atomicity: a refused mutation leaves ZERO activity rows and ZERO
 * messages, even when the refusal lands AFTER the core already wrote. */
/// <reference types="vite/client" />

import type { FunctionArgs, WithoutSystemFields } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { SUBTASK_MAX } from '../lib/taskLimits'
import {
  BEFORE_NOT_A_CHANGE,
  HISTORY_HIDDEN,
  HISTORY_PAGE_MAX,
  HISTORY_ROOM,
  historyAnchor,
  NAMED_TASK_ROOM,
  olderRows,
  taskHistoryPage,
} from '../lib/activityVisibility'
import { type ActivityEntry, insertActivity, issueChanges, logActivity } from '../model/activity'
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

describe('per-subject history, kept whole and read a page at a time', () => {
  // Fake time keeps the clock and any scheduled work deterministic.
  const START = Date.parse('2026-05-04T10:00:00.000Z')
  const at = (ms: number) => new Date(ms).toISOString()
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /* One task row about `target`, as a writer that names no task gives it. */
  const entry = (orgId: string, target: string, ts = at(START)): ActivityEntry => ({
    org_id: orgId,
    actor_id: undefined,
    verb: 'created',
    target_type: 'issue',
    target_id: target,
    label: 'x',
    ts,
    named_task_nums: [],
  })

  /* `count` rows about `target` through logActivity in one mutation. */
  const write = (t: T, orgId: string, target: string, count = 1, from = START) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++) await logActivity(ctx, entry(orgId, target, at(from + i)))
      return ctx.meta.getTransactionMetrics()
    })

  /* The rows about `target`, in index order. */
  const stored = (t: T, orgId: string, target: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query('activity_events')
        .withIndex('by_target', (q) =>
          q.eq('org_id', orgId).eq('target_type', 'issue').eq('target_id', target),
        )
        .collect(),
    )

  it('keeps every row of a subject past 500, in insertion order, and numbers none', async () => {
    const t = newT()
    const f = await withOrg(t)
    await write(t, f.org.id, 'task-b', 2)
    await write(t, f.org.id, 'task-a', 600)
    const kept = await stored(t, f.org.id, 'task-a')
    expect(kept.map((row) => row.ts)).toEqual(Array.from({ length: 600 }, (_, i) => at(START + i)))
    expect(kept.filter((row) => row.seq !== undefined)).toEqual([])
    expect(await stored(t, f.org.id, 'task-b')).toHaveLength(2)
  })

  it('writes to other tasks never remove a task’s rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    await write(t, f.org.id, 'task-a', 3, START - 3_600_000)
    // 2,000 newer rows over 50 other tasks, 1,000 to a mutation
    for (let m = 0; m < 2; m++)
      await t.run(async (ctx) => {
        for (let i = 0; i < 1_000; i++)
          await logActivity(ctx, entry(f.org.id, `other-${i % 50}`, at(START - 60_000 + m)))
      })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await stored(t, f.org.id, 'task-a')).toHaveLength(3)
    expect(await activityFor(t, f.org.id)).toHaveLength(2_003)
  }, 180_000)

  it('a write past 500 rows stores one document, reads none and schedules nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await write(t, f.org.id, 'task-a', 600)
    const metrics = await t.run(async (ctx) => {
      await insertActivity(ctx, entry(f.org.id, 'task-a', at(START + 600)))
      return ctx.meta.getTransactionMetrics()
    })
    expect(metrics.documentsWritten.used).toBe(1)
    expect(metrics.documentsRead.used).toBe(0)
    expect(metrics.functionsScheduled.used).toBe(0)
    expect(await stored(t, f.org.id, 'task-a')).toHaveLength(601)
  })

  it('a project purge and profile removal clear every row, within limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // a task that moved out of sub2 earlier, and one still inside it
    const movedOut = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const inside = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    // Legacy rows filed under sub2, several step budgets' worth: about the
    // moved task, about sub2 itself and about the task inside it.
    const groups = [
      { count: 1_200, target_type: 'issue' as const, target_id: movedOut.id },
      { count: 1_200, target_type: 'project' as const, target_id: f.sub2.id },
      { count: 400, target_type: 'issue' as const, target_id: inside.id },
    ]
    let n = 0
    for (const group of groups)
      for (let from = 0; from < group.count; from += 4_000)
        await t.run(async (ctx) => {
          for (let i = from; i < Math.min(from + 4_000, group.count); i++)
            await ctx.db.insert('activity_events', {
              id: `row-${n++}`,
              org_id: f.org.id,
              ts: at(START - 3_600_000 + n),
              actor_id: f.agent.id,
              verb: 'updated',
              target_type: group.target_type,
              target_id: group.target_id,
              label: 'x',
              project_id: f.sub2.id,
            })
        })
    const rowsWhere = (pick: (row: Doc<'activity_events'>) => boolean) =>
      t.run(async (ctx) => (await ctx.db.query('activity_events').collect()).filter(pick))
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub2.id })
    const item = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', f.sub2.id))
        .unique(),
    )
    if (item === null) throw new Error('the project is not in Deleted items')
    // Delete now, its steps run one by one so that no scheduled work runs
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
    expect(await rowsWhere((row) => row.project_id === f.sub2.id)).toEqual([])
    // the task deleted with the project loses its history
    expect(await rowsWhere((row) => row.target_id === inside.id)).toEqual([])
    // the task that moved out keeps its history, no longer filed under sub2
    const moved = await rowsWhere((row) => row.target_id === movedOut.id)
    expect(moved).toHaveLength(1_200)
    expect(moved.every((row) => row.project_id === undefined)).toBe(true)
    // sub2's own rows stay, naming it, without project_id
    const own = await rowsWhere((row) => row.target_id === f.sub2.id && row.verb === 'updated')
    expect(own).toHaveLength(1_200)
    expect(own.every((row) => row.project_id === undefined)).toBe(true)
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.agent.id })
    while ((await t.run((ctx) => pendingRemoval(ctx, f.agent.id))) !== null)
      await t.mutation(internal.profileRemovals.step, { profile_id: f.agent.id })
    expect(await rowsWhere((row) => row.actor_id === f.agent.id)).toEqual([])
    await assertNoDanglingRefs(t, 'after a project purge and a profile removal')
  }, 180_000)

  it('pages a task’s whole history, newest first, however many rows other tasks have', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_200; i++)
        await insertActivity(ctx, entry(f.org.id, task.id, at(START - 3_600_000 + i)))
      for (let i = 0; i < 100; i++)
        await insertActivity(ctx, entry(f.org.id, other.id, at(START - 60_000 + i)))
    })
    const page = (before?: string) =>
      t.run(async (ctx) =>
        taskHistoryPage(
          ctx,
          f.admin,
          task,
          before === undefined ? undefined : await historyAnchor(ctx, task, before),
        ),
      )
    const times = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => at(START - 3_600_000 + from + i))
    const newest = await page()
    expect(HISTORY_PAGE_MAX).toBe(500)
    expect(newest.earlier).toBe(true)
    // oldest first by ts
    expect(newest.rows.map((row) => row.ts)).toEqual(times(700, 500))
    const middle = await page(newest.rows[0].id)
    expect(middle.earlier).toBe(true)
    expect(middle.rows.map((row) => row.ts)).toEqual(times(200, 500))
    const first = await page(middle.rows[0].id.toUpperCase())
    expect(first.earlier).toBe(false)
    expect(first.rows.map((row) => row.ts)).toEqual(times(0, 200))
    expect(first.rows.every((row) => row.target_id === task.id)).toBe(true)
    expect(await page(first.rows[0].id)).toEqual({ rows: [], earlier: false })
    // a row of another task, or no row, is no place in this history
    const elsewhere = (await stored(t, f.org.id, other.id))[0]
    for (const before of [elsewhere.id, uuid()]) {
      const e = await expectRefusal(page(before), 'bad_request')
      expect(e.data.message).toBe(BEFORE_NOT_A_CHANGE)
    }
  })

  it('reads on past rows a member does not receive, and pages on where it stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // 20 rows the viewer receives, then 600 newer ones naming the hidden project
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++)
        await insertActivity(ctx, entry(f.org.id, task.id, at(START - 3_600_000 + i)))
      for (let i = 0; i < 600; i++)
        await insertActivity(ctx, {
          ...entry(f.org.id, task.id, at(START - 60_000 + i)),
          verb: 'moved',
          related_project_id: f.hidden.id,
        })
    })
    const page = (before?: string) =>
      t.run(async (ctx) =>
        taskHistoryPage(
          ctx,
          f.viewer,
          task,
          before === undefined ? undefined : await historyAnchor(ctx, task, before),
        ),
      )
    const seen = await page()
    expect(seen.earlier).toBe(false)
    expect(seen.rows.map((row) => row.ts)).toEqual(
      Array.from({ length: 20 }, (_, i) => at(START - 3_600_000 + i)),
    )
    expect((await t.run((ctx) => taskHistoryPage(ctx, f.admin, task))).rows).toHaveLength(500)
    // a read that fills up before it finds a row answers none and where to go on
    const room = HISTORY_ROOM.room
    HISTORY_ROOM.room = 0
    let stopped: Awaited<ReturnType<typeof page>>
    try {
      stopped = await page()
      // REST and MCP cannot answer an empty page that is not the end
      const rest = t.query(internal.machine.records.restTaskActivity, {
        callerId: f.viewer.id,
        access: 'read',
        ref: task.id,
      })
      const e = await expectRefusal(rest, 'rule')
      expect(e.data.message).toBe(HISTORY_HIDDEN)
    } finally {
      HISTORY_ROOM.room = room
    }
    expect(stopped.rows).toEqual([])
    expect(stopped.earlier).toBe(true)
    expect(stopped.next?.ts).toBe(at(START - 60_000 + 99))
    const rest = await page(stopped.next?.id)
    expect(rest.rows).toHaveLength(20)
    expect(rest.earlier).toBe(false)
  })

  it('ends a page before a row it had no room to check, so the next page checks it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const named = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // plain, a link to a task the viewer may read, plain, newest last
    await t.run(async (ctx) => {
      await insertActivity(ctx, entry(f.org.id, task.id, at(START)))
      await insertActivity(ctx, {
        org_id: f.org.id,
        actor_id: undefined,
        verb: 'linked',
        target_type: 'issue',
        target_id: task.id,
        label: 'x',
        ts: at(START + 1),
        named_task_nums: [named.num],
      })
      await insertActivity(ctx, entry(f.org.id, task.id, at(START + 2)))
    })
    const page = (before?: string) =>
      t.run(async (ctx) =>
        taskHistoryPage(
          ctx,
          f.viewer,
          task,
          before === undefined ? undefined : await historyAnchor(ctx, task, before),
        ),
      )
    const room = NAMED_TASK_ROOM.room
    NAMED_TASK_ROOM.room = 0
    let first: Awaited<ReturnType<typeof page>>
    try {
      first = await page()
    } finally {
      NAMED_TASK_ROOM.room = room
    }
    expect(first.rows.map((row) => row.ts)).toEqual([at(START + 2)])
    expect(first.earlier).toBe(true)
    // the link row is read again before the page's first row, with room
    const rest = await page(first.rows[0].id)
    expect(rest.rows.map((row) => row.verb)).toEqual(['created', 'linked'])
    expect(rest.earlier).toBe(false)
    // a page whose first row is the link checks it whatever the room
    NAMED_TASK_ROOM.room = 0
    let fromLink: Awaited<ReturnType<typeof page>>
    try {
      fromLink = await page(first.rows[0].id)
    } finally {
      NAMED_TASK_ROOM.room = room
    }
    expect(fromLink.rows.map((row) => row.verb)).toEqual(['created', 'linked'])
    expect(fromLink.earlier).toBe(false)
  })

  it('reads rows that share a _creationTime once each, from any row among them', async () => {
    // convex-test never repeats a _creationTime, so the index is a fake that
    // orders rows as by_target does: _creationTime, then the document id
    const rows = Array.from(
      { length: 13 },
      (_, n) =>
        ({
          _id: `r${String(n).padStart(2, '0')}`,
          _creationTime: 1_000 + Math.floor(n / 3),
          id: `row-${n}`,
        }) as unknown as Doc<'activity_events'>,
    )
    const newestFirst = [...rows].reverse()
    type Range = { eq?: number; lt?: number; lte?: number }
    const builder = (range: Range) => ({
      eq: (field: string, value: number | string) =>
        builder(field === '_creationTime' ? { ...range, eq: value as number } : range),
      lt: (_: string, value: number) => builder({ ...range, lt: value }),
      lte: (_: string, value: number) => builder({ ...range, lte: value }),
      range,
    })
    const ctx = {
      db: {
        query: () => ({
          withIndex: (_: string, build: (q: ReturnType<typeof builder>) => { range: Range }) => {
            const { eq, lt, lte } = build(builder({})).range
            const hit = newestFirst.filter(
              (r) =>
                (eq === undefined || r._creationTime === eq) &&
                (lt === undefined || r._creationTime < lt) &&
                (lte === undefined || r._creationTime <= lte),
            )
            return {
              order: () => ({
                take: async (n: number) => hit.slice(0, n),
                collect: async () => hit,
              }),
            }
          },
        }),
      },
    } as unknown as Parameters<typeof olderRows>[0]
    const issue = { org_id: 'o', id: 't' } as Doc<'issues'>
    const ids = newestFirst.map((r) => r.id)
    for (const size of [1, 2, 3, 4, 5]) {
      // in reads of `size` from the newest
      const read = await olderRows(ctx, issue, undefined)
      const seen: string[] = []
      for (;;) {
        const got = await read(size)
        seen.push(...got.map((r) => r.id))
        if (got.length < size) break
      }
      expect(seen, `reads of ${size}`).toEqual(ids)
      // and from every row before it, as a page's `before`
      for (const [i, before] of newestFirst.entries()) {
        const from = await olderRows(ctx, issue, before)
        const rest: string[] = []
        for (;;) {
          const got = await from(size)
          rest.push(...got.map((r) => r.id))
          if (got.length < size) break
        }
        expect(rest, `before ${before.id} in reads of ${size}`).toEqual(ids.slice(i + 1))
      }
    }
  })

  it('a Deleted items delete of a task with 100 subtasks and 100 archived ones stays within limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const subtasks: string[] = []
    for (let i = 0; i < SUBTASK_MAX; i++)
      subtasks.push(
        (await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: root.id })).id,
      )
    // archived subtasks have no bound, and leave the deleted task in background steps
    const archived: string[] = []
    for (let i = 0; i < 100; i++)
      archived.push(
        (
          await plantIssue(t, {
            org_id: f.org.id,
            project_id: f.sub.id,
            parent_id: root.id,
            archived_at: NOW,
          })
        ).id,
      )
    await as(t, f.admin).mutation(api.issues.deleteDeep, {
      org_id: f.org.id,
      id: root.id,
      subtask_ids: subtasks,
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const deleted = (await activityFor(t, f.org.id)).filter((row) => row.verb === 'deleted')
    expect(deleted).toHaveLength(SUBTASK_MAX + 1)
    const left = await t.run((ctx) => ctx.db.query('issues').collect())
    expect(left.map((row) => row.id).sort()).toEqual([...archived].sort())
    expect(left.every((row) => row.parent_id === undefined)).toBe(true)
  }, 120_000)
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
      /^a task with subtasks has no remaining time of its own, because it shows the sum of its subtasks$/,
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
    // a save that changes nothing the history narrates writes no row
    for (const patch of [{}, { title: 'Renamed task' }, { status: 'progress' as const }]) {
      await as(t, f.user).mutation(api.issues.update, { org_id: f.org.id, id: issue.id, patch })
      expect(await activityFor(t, f.org.id)).toEqual([])
    }
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
    expect(events[0].named_task_nums).toEqual([parent.num])
    // a change of parent names both, in text order
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.user).mutation(api.issues.update, {
      org_id: f.org.id,
      id: child.id,
      patch: { parent_id: other.id },
    })
    events = await activityFor(t, f.org.id)
    expect(events[1].detail).toBe(`under QN-${other.num} (from QN-${parent.num})`)
    expect(events[1].named_task_nums).toEqual([other.num, parent.num])
    await drainActivity(t)
    await as(t, f.user).mutation(api.issues.update, {
      org_id: f.org.id,
      id: child.id,
      patch: { parent_id: null },
    })
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('detached')
    expect(events[0].detail).toBe(`from QN-${other.num}`)
    expect(events[0].named_task_nums).toEqual([other.num])
  })

  it('stores an empty list on task rows that name no task, whatever their text', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    const user = as(t, f.user)
    await user.mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      title: 'A',
    })
    await user.mutation(api.issues.update, { org_id: f.org.id, id, patch: { status: 'progress' } })
    await user.mutation(api.issues.update, { org_id: f.org.id, id, patch: { title: 'Fix QN-9' } })
    await user.mutation(api.issues.move, { org_id: f.org.id, id, project_id: f.sub2.id })
    await user.mutation(api.issues.archive, { org_id: f.org.id, id })
    await user.mutation(api.issues.unarchive, { org_id: f.org.id, id })
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.admin.id,
      access: 'write',
      ref: id,
      title: 'Also QN-9',
    })
    await user.mutation(api.issues.deleteDeep, { org_id: f.org.id, id })
    const rows = await activityFor(t, f.org.id)
    expect(rows.map((row) => row.verb)).toEqual([
      'created',
      'moved',
      'renamed',
      'moved',
      'archived',
      'restored',
      'changed',
      'deleted',
    ])
    expect(rows.map((row) => row.named_task_nums)).toEqual(rows.map(() => []))
    expect(rows.filter((row) => 'seq' in row)).toEqual([])
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
    expect(events[0].detail).toBe(`(blocks QN-${other.num})`)
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

describe('which task rows a member receives, in the task window and over REST', () => {
  /* The task, a task the guest may read, one it may not, and a reader that
   * asks commentThread and REST for the task's history and checks they agree.
   * The guest holds User on TBED (FW and PCB) and nothing on SKNK. */
  async function setup() {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const visible = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    const seen = async (p: Doc<'profiles'>): Promise<string[]> => {
      const thread = await as(t, p).query(api.snapshot.commentThread, {
        org_id: f.org.id,
        issue_id: task.id,
      })
      const rest = await t.query(internal.machine.records.restTaskActivity, {
        callerId: p.id,
        access: 'read',
        ref: task.id,
      })
      const ids = thread.events.map((row) => row.id)
      expect(rest.map((row) => row.id)).toEqual(ids)
      return ids
    }
    /* Inserts rows about the task raw, one second apart, in this order. */
    const plant = (rows: Partial<WithoutSystemFields<Doc<'activity_events'>>>[]) =>
      t.run(async (ctx) => {
        const ids: string[] = []
        for (const [i, row] of rows.entries()) {
          const id = uuid()
          await ctx.db.insert('activity_events', {
            id,
            org_id: f.org.id,
            ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
            actor_id: f.user.id,
            verb: 'linked',
            target_type: 'issue',
            target_id: task.id,
            label: task.title,
            project_id: f.sub.id,
            ...row,
          })
          ids.push(id)
        }
        return ids
      })
    return { t, f, task, visible, hidden, seen, plant }
  }

  it('decides a row by its stored list, not its text', async () => {
    const { f, visible, hidden, seen, plant } = await setup()
    const [namesHidden, namesVisible] = await plant([
      // the text names a task the guest may read, the list one it may not
      { named_task_nums: [hidden.num], detail: `(blocks QN-${visible.num})` },
      // text no writer produces, a list the guest passes
      { named_task_nums: [visible.num], detail: '(blocks PCB-12)' },
    ])
    expect(await seen(f.guest)).toEqual([namesVisible])
    expect(await seen(f.admin)).toEqual([namesHidden, namesVisible])
  })

  it('hides a row stored without its list from members only, whatever its text', async () => {
    const { f, visible, seen, plant } = await setup()
    const ids = await plant([
      { detail: `(blocks QN-${visible.num})` },
      { verb: 'renamed', detail: 'from “Old”' },
      // a row from before numbering, which the migration has not reached
      { verb: 'renamed', detail: 'from “Older”', seq: 4 },
      { verb: 'renamed', detail: 'from “Oldest”', named_task_nums: [] },
    ])
    expect(await seen(f.guest)).toEqual([ids[3]])
    expect(await seen(f.admin)).toEqual(ids)
  })

  it('checks a named task where it is now: hidden, deleted, purged or restored', async () => {
    vi.useFakeTimers()
    try {
      const { t, f, task, seen } = await setup()
      const writer = as(t, f.user)
      const skunkSub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.hidden.id,
      })
      const linkTo = async (target: Doc<'issues'>) => {
        await writer.mutation(api.issues.addLink, {
          org_id: f.org.id,
          id: uuid(),
          source_id: task.id,
          target_id: target.id,
          type: 'relates',
        })
        const rows = await activityFor(t, f.org.id)
        return rows[rows.length - 1].id
      }
      const moving = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
      const restored = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
      const purged = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
      const toMoving = await linkTo(moving)
      const toRestored = await linkTo(restored)
      const toPurged = await linkTo(purged)
      expect(await seen(f.guest)).toEqual([toMoving, toRestored, toPurged])
      // a named task moved where the guest cannot follow, then back
      await writer.mutation(api.issues.move, {
        org_id: f.org.id,
        id: moving.id,
        project_id: skunkSub.id,
      })
      expect(await seen(f.guest)).toEqual([toRestored, toPurged])
      await writer.mutation(api.issues.move, {
        org_id: f.org.id,
        id: moving.id,
        project_id: f.sub.id,
      })
      expect(await seen(f.guest)).toEqual([toMoving, toRestored, toPurged])
      // named tasks in Deleted items, one purged and one restored
      for (const doomed of [restored, purged])
        await writer.mutation(api.issues.deleteDeep, { org_id: f.org.id, id: doomed.id })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await seen(f.guest)).toEqual([toMoving])
      const itemOf = (id: string) =>
        t.run(
          async (ctx) =>
            (
              await ctx.db
                .query('deleted_items')
                .withIndex('by_target', (q) => q.eq('target_id', id))
                .unique()
            )?.id,
        )
      const admin = as(t, f.admin)
      await admin.mutation(api.deletedItems.purge, {
        org_id: f.org.id,
        ids: [(await itemOf(purged.id)) ?? ''],
      })
      await admin.mutation(api.deletedItems.restore, {
        org_id: f.org.id,
        ids: [(await itemOf(restored.id)) ?? ''],
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await seen(f.guest)).toEqual([toMoving, toRestored])
      expect(await seen(f.admin)).toEqual([toMoving, toRestored, toPurged])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a review whose subtask went', () => {
  it('keeps its status stamp and no hand-off, and a resave writes nothing', async () => {
    vi.useFakeTimers()
    try {
      const t = newT()
      const f = await withOrg(t)
      const id = uuid()
      const user = as(t, f.user)
      const row = () =>
        t.run((ctx) =>
          ctx.db
            .query('issues')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique(),
        )
      vi.setSystemTime(Date.parse('2026-05-04T09:00:00.000Z'))
      await user.mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Review me',
      })
      await user.mutation(api.issues.update, {
        org_id: f.org.id,
        id,
        patch: { reviewer_id: f.admin.id },
      })
      const ten = '2026-05-04T10:00:00.000Z'
      vi.setSystemTime(Date.parse(ten))
      await user.mutation(api.issues.update, { org_id: f.org.id, id, patch: { status: 'review' } })
      expect(await row()).toMatchObject({ status_at: ten, review_at: ten })
      // a subtask makes it a group, which clears the hand-off
      vi.setSystemTime(Date.parse('2026-05-04T11:00:00.000Z'))
      const sub = uuid()
      await user.mutation(api.issues.create, {
        org_id: f.org.id,
        id: sub,
        project_id: f.sub.id,
        title: 'Subtask',
        parent_id: id,
      })
      expect(await row()).not.toHaveProperty('review_at')
      expect((await row())?.status_at).toBe(ten)
      // the subtask goes: a leaf In Review with its reviewer and no hand-off
      vi.setSystemTime(Date.parse('2026-05-04T11:30:00.000Z'))
      await user.mutation(api.issues.update, {
        org_id: f.org.id,
        id: sub,
        patch: { parent_id: null },
      })
      const leaf = await row()
      expect(leaf).toMatchObject({ status: 'review', reviewer_id: f.admin.id, status_at: ten })
      expect(leaf).not.toHaveProperty('review_at')
      const rows = (await activityFor(t, f.org.id)).length
      // a stale save resends the reviewer it already has
      vi.setSystemTime(Date.parse('2026-05-04T12:00:00.000Z'))
      await user.mutation(api.issues.update, {
        org_id: f.org.id,
        id,
        patch: { reviewer_id: f.admin.id },
      })
      expect(await activityFor(t, f.org.id)).toHaveLength(rows)
      expect(await row()).not.toHaveProperty('review_at')
      expect((await row())?.status_at).toBe(ten)
    } finally {
      vi.useRealTimers()
    }
  })
})
