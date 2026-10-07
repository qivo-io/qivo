/* model/activity + the activity rows the issue mutations write.
 *
 * Three contracts under test:
 * - issueChanges: the machine from→to narration, verbatim (core.ts grammar —
 *   clean() strips the diff grammar's own marks so a crafted value cannot
 *   forge phantom clauses);
 * - logActivity: newest-500 per-org retention, trimmed in one call;
 * - the browser verbs/details ported from the old client — the feed icon
 *   substring-matches the verb (IssueDetail.tsx evIcon), so every byte of
 *   every verb string is load-bearing.
 * Plus atomicity: a refused mutation leaves ZERO activity rows and ZERO
 * messages, even when the refusal lands AFTER the core already wrote. */
/// <reference types="vite/client" />

import type { FunctionArgs } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { issueChanges, logActivity } from '../model/activity'
import {
  activityFor,
  allMessages,
  as,
  drainActivity,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  uuid,
  withOrg,
} from './helpers.setup'

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

describe('logActivity — newest-500 per-org retention', () => {
  it('uses the exact index tie order and drops backdated inserts with bounded reads', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { activity_count: 500 })
      for (let i = 0; i < 500; i++)
        await ctx.db.insert('activity_events', {
          id: `tied-${i}`,
          org_id: f.org.id,
          ts: NOW,
          verb: 'seeded',
          target_type: 'issue',
          target_id: `task-${i}`,
          label: 'x',
        })
    })
    const ordered = () =>
      t.run(async (ctx) =>
        ctx.db
          .query('activity_events')
          .withIndex('by_org_ts', (q) => q.eq('org_id', f.org.id))
          .order('desc')
          .collect(),
      )
    const before = await ordered()
    const write = (ts: string) =>
      t.run(async (ctx) => {
        await logActivity(ctx, {
          org_id: f.org.id,
          actor_id: f.admin.id,
          verb: 'created',
          target_type: 'issue',
          target_id: 'new',
          label: 'x',
          ts,
        })
        return ctx.meta.getTransactionMetrics()
      })
    const metrics = await write(NOW)
    const tied = await ordered()
    expect(tied).toHaveLength(500)
    expect(tied[0].target_id).toBe('new')
    expect(tied.slice(1).map((row) => row.id)).toEqual(before.slice(0, 499).map((row) => row.id))
    expect(metrics.documentsRead.used).toBeLessThan(10)
    expect(metrics.documentsWritten.used).toBe(2) // insert + delete; no org invalidation at cap
    await write('2025-01-01T00:00:00.000Z')
    expect((await ordered()).map((row) => row.id)).toEqual(tied.map((row) => row.id))
  })

  it('counts successive writes in one transaction from fresh state', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { activity_count: 0 })
      for (let i = 0; i < 3; i++)
        await logActivity(ctx, {
          org_id: f.org.id,
          actor_id: f.admin.id,
          verb: 'created',
          target_type: 'issue',
          target_id: `new-${i}`,
          label: 'x',
          ts: NOW,
        })
    })
    expect(await activityFor(t, f.org.id)).toHaveLength(3)
    expect((await t.run((ctx) => ctx.db.get(f.org._id)))!.activity_count).toBe(3)
  })

  it('a bulk backlog is trimmed in ONE call, per org, keeping the newest 500 by ts', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = Date.parse('2026-02-01T00:00:00.000Z')
    const ts = (i: number) => new Date(base + i * 1000).toISOString()
    await t.run(async (ctx) => {
      for (let i = 0; i < 510; i++) {
        await ctx.db.insert('activity_events', {
          id: uuid(),
          org_id: f.org.id,
          ts: ts(i),
          verb: 'seeded',
          target_type: 'issue',
          target_id: `seed-${i}`,
          label: 'x',
        })
      }
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('activity_events', {
          id: uuid(),
          org_id: f.otherOrg.id,
          ts: ts(i),
          verb: 'seeded',
          target_type: 'issue',
          target_id: `other-${i}`,
          label: 'x',
        })
      }
    })

    await t.run(async (ctx) =>
      logActivity(ctx, {
        org_id: f.org.id,
        actor_id: f.admin.id,
        verb: 'created',
        target_type: 'issue',
        target_id: 'the-new-one',
        label: 'newest',
        ts: ts(600),
      }),
    )

    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(500) // 511 present, everything past the cap died
    const sorted = events.map((e) => e.ts).sort()
    expect(sorted[0]).toBe(ts(11)) // seeds 0..10 were the overflow tail
    expect(events.some((e) => e.target_id === 'the-new-one')).toBe(true)
    expect(await activityFor(t, f.otherOrg.id)).toHaveLength(3) // untouched
    expect((await t.run((ctx) => ctx.db.get(f.org._id)))!.activity_count).toBe(500)
  })
})

describe('atomicity — a refused write leaves zero rows', () => {
  it('a forbidden move rolls back the row, the messages and the activity the core already wrote', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: issue.id })
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    // guest can write the source (grant on meta) but not the hidden target —
    // that check runs AFTER the core patched, notified and logged
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
    const org = await t.run(async (ctx) => (await ctx.db.get(f.org._id)) as Doc<'organizations'>)
    expect(org.next_issue_num).toBe(1) // bumped before the title guard, rolled back with it
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

    // archived, with the subtask count (plural and singular), then restored
    const p2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: p2.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: p2.id })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: p2.id })
    events = await activityFor(t, f.org.id)
    expect(events[0].verb).toBe('archived')
    expect(events[0].detail).toBe('with 2 subtasks')
    await drainActivity(t)

    const p1 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: p1.id })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: p1.id })
    events = await activityFor(t, f.org.id)
    expect(events[0].detail).toBe('with 1 subtask')
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
