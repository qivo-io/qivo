/* The task Reviewer: the one ownership rule (lib/review.ts), the project
 * review time a task gets on entering Review (every writer funnels through
 * updateIssueCore/createIssueCore), and the reviewer's eligibility, which is
 * the assignee's rule with its own sentence. */

import type { FunctionArgs } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  DEFAULT_REVIEW_HOURS,
  resolveReviewHours,
  reviewerOwns,
  reviewStamp,
  roundReviewHours,
  taskOwnerId,
} from '../lib/review'
import { assertAssignable, type IssuePatch } from '../model/issues'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

const REVIEWER_SENTENCE =
  /^a task can only be reviewed by an active user with Edit permission or higher on its project$/

const issueRow = (t: T, id: string): Promise<Doc<'issues'>> =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (row === null) throw new Error(`issue ${id} vanished`)
    return row
  })

const update = (t: T, f: OrgFixture, id: string, patch: IssuePatch) =>
  as(t, f.user).mutation(api.issues.update, { org_id: f.org.id, id, patch })

type CreateExtra = Pick<
  FunctionArgs<typeof api.issues.create>,
  'status' | 'remaining_hours' | 'reviewer_id'
>

const createArgs = (f: OrgFixture, extra: CreateExtra) => ({
  org_id: f.org.id,
  id: uuid(),
  project_id: f.sub.id,
  title: 'Created',
  ...extra,
})

const create = (t: T, f: OrgFixture, extra: CreateExtra = {}) =>
  as(t, f.user).mutation(api.issues.create, createArgs(f, extra))

describe('the rule', () => {
  const people = { assignee_id: 'a', reviewer_id: 'r' }

  it('the reviewer owns a task In Review; the assignee owns it otherwise', () => {
    expect(taskOwnerId({ status: 'review', ...people })).toBe('r')
    for (const status of ['backlog', 'todo', 'progress', 'done'] as const) {
      expect(taskOwnerId({ status, ...people })).toBe('a')
    }
    expect(taskOwnerId({ status: 'review', assignee_id: 'a', reviewer_id: undefined })).toBe('a')
    expect(taskOwnerId({ status: 'review', assignee_id: undefined, reviewer_id: 'r' })).toBe('r')
    // a group's stored status is dormant: it stays with its assignee
    expect(taskOwnerId({ status: 'review', ...people }, true)).toBe('a')
    expect(reviewerOwns({ status: 'done', reviewer_id: 'r' })).toBe(false)
  })

  it('review hours resolve own, then parent, then the default; 0 is a real setting', () => {
    expect(resolveReviewHours(undefined, undefined)).toBe(DEFAULT_REVIEW_HOURS)
    expect(DEFAULT_REVIEW_HOURS).toBe(2)
    expect(resolveReviewHours(3, 5)).toBe(3)
    expect(resolveReviewHours(undefined, 5)).toBe(5)
    expect(resolveReviewHours(0, 5)).toBe(0)
    expect(roundReviewHours(2.25)).toBe(2.3)
  })
})

describe('review time on entering Review', () => {
  it('lands the project review time with a fresh stamp, even when the hours are unchanged', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }

    const fresh = await plantIssue(t, { ...base, status: 'todo' })
    const a = await update(t, f, fresh.id, { status: 'review' })
    expect(a.remaining_hours).toBe(2)
    expect(a.remaining_set_at).toBe(a.updated_at)

    const worked = await plantIssue(t, {
      ...base,
      status: 'progress',
      remaining_hours: 6,
      remaining_set_at: NOW,
    })
    const b = await update(t, f, worked.id, { status: 'review' })
    expect(b.remaining_hours).toBe(2)
    expect(b.remaining_set_at).toBe(b.updated_at)

    // a fresh measurement: the stamp moves although the value does not
    const same = await plantIssue(t, {
      ...base,
      status: 'progress',
      remaining_hours: 2,
      remaining_set_at: NOW,
    })
    const c = await update(t, f, same.id, { status: 'review' })
    expect(c.remaining_hours).toBe(2)
    expect(c.remaining_set_at).not.toBe(NOW)
    expect(c.remaining_set_at).toBe(c.updated_at)

    const done = await plantIssue(t, { ...base, status: 'done', done_at: NOW })
    const d = await update(t, f, done.id, { status: 'review' })
    expect(d.remaining_hours).toBe(2)
    expect(d.done_at).toBeUndefined()

    const paused = await plantIssue(t, { ...base, status: 'progress', paused: true })
    const e = await update(t, f, paused.id, { status: 'review' })
    expect(e.paused).toBe(true)
    expect(e.remaining_hours).toBe(2)

    // a parent whose only child is archived is a leaf again
    const parent = await plantIssue(t, { ...base })
    await plantIssue(t, { ...base, parent_id: parent.id, archived_at: NOW })
    expect((await update(t, f, parent.id, { status: 'review' })).remaining_hours).toBe(2)
  })

  it('reads the sub-project value, else its project value, else 2 h', async () => {
    const t = newT()
    const f = await withOrg(t)
    const enter = async () => {
      const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      return (await update(t, f, row.id, { status: 'review' })).remaining_hours
    }
    await t.run((ctx) => ctx.db.patch(f.sub._id, { review_hours: 4 }))
    expect(await enter()).toBe(4)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.sub._id, { review_hours: undefined })
      await ctx.db.patch(f.meta._id, { review_hours: 3 })
    })
    expect(await enter()).toBe(3)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { review_hours: 0 }))
    expect(await enter()).toBe(0)
  })

  it('explicit hours in the same write win; null takes the review time', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const a = await plantIssue(t, { ...base })
    expect(
      (await update(t, f, a.id, { status: 'review', remaining_hours: 5 })).remaining_hours,
    ).toBe(5)
    const b = await plantIssue(t, { ...base })
    expect(
      (await update(t, f, b.id, { status: 'review', remaining_hours: null })).remaining_hours,
    ).toBe(2)
  })

  it('a write that stays in Review, or leaves it, keeps the hours and the stamp', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inReview = { org_id: f.org.id, project_id: f.sub.id, status: 'review' as const }
    const stay = await plantIssue(t, { ...inReview, remaining_hours: 5, remaining_set_at: NOW })
    const kept = await update(t, f, stay.id, { status: 'review', title: 'x' })
    expect(kept.remaining_hours).toBe(5)
    expect(kept.remaining_set_at).toBe(NOW)
    for (const status of ['progress', 'done'] as const) {
      const row = await plantIssue(t, { ...inReview, remaining_hours: 5, remaining_set_at: NOW })
      const left = await update(t, f, row.id, { status })
      expect(left.remaining_hours).toBe(5)
      expect(left.remaining_set_at).toBe(NOW)
    }
  })

  it('a task with active subtasks is refused before any review time lands', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, { ...base })
    await plantIssue(t, { ...base, parent_id: parent.id })
    await expectRefusal(
      update(t, f, parent.id, { status: 'review' }),
      'rule',
      /status cannot be set on a task with subtasks/,
    )
    expect(await issueRow(t, parent.id)).toEqual(parent)
  })
})

describe('the review hand-off stamp (review_at)', () => {
  const EARLIER = '2025-12-30T09:00:00.000Z'

  it('follows the task into and out of Review, as a pure rule', () => {
    const r = (status: Doc<'issues'>['status'], reviewer_id?: string, review_at?: string) => ({
      status,
      reviewer_id,
      review_at,
    })
    expect(reviewStamp(null, r('review'), NOW)).toBe(NOW)
    expect(reviewStamp(null, r('todo', 'a'), NOW)).toBeUndefined()
    expect(reviewStamp(r('progress', 'a'), r('review', 'a'), NOW)).toBe(NOW)
    expect(reviewStamp(r('done', 'a', EARLIER), r('review', 'a'), NOW)).toBe(NOW)
    // while in Review: only a different reviewer is a new hand-off
    expect(reviewStamp(r('review', 'a', EARLIER), r('review', 'a'), NOW)).toBe(EARLIER)
    expect(reviewStamp(r('review', undefined, EARLIER), r('review', 'a'), NOW)).toBe(NOW)
    expect(reviewStamp(r('review', 'a', EARLIER), r('review', 'b'), NOW)).toBe(NOW)
    expect(reviewStamp(r('review', 'a', EARLIER), r('review'), NOW)).toBe(EARLIER)
    // reviewed to Done keeps it, and Done keeps it; any other way out clears
    expect(reviewStamp(r('review', 'a', EARLIER), r('done', 'a'), NOW)).toBe(EARLIER)
    expect(reviewStamp(r('done', 'a', EARLIER), r('done', 'b'), NOW)).toBe(EARLIER)
    expect(reviewStamp(r('progress', 'a'), r('done', 'a'), NOW)).toBeUndefined()
    // only a review reaches Done reviewed, whatever a stray row carries
    expect(reviewStamp(r('progress', 'a', EARLIER), r('done', 'a'), NOW)).toBeUndefined()
    for (const status of ['backlog', 'todo', 'progress'] as const) {
      expect(reviewStamp(r('review', 'a', EARLIER), r(status, 'a'), NOW)).toBeUndefined()
      expect(reviewStamp(r('done', 'a', EARLIER), r(status, 'a'), NOW)).toBeUndefined()
    }
  })

  it('stamps entering Review and a new reviewer there, and keeps it through other writes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'progress' })
    // a reviewer named outside Review hands nothing over
    expect('review_at' in (await update(t, f, row.id, { reviewer_id: f.guest.id }))).toBe(false)
    const entered = await update(t, f, row.id, { status: 'review' })
    expect(entered.review_at).toBe(entered.updated_at)
    await tick()
    // a Remaining edit, a same-reviewer write or a cleared reviewer is no hand-off
    const edited = await update(t, f, row.id, { remaining_hours: 3, reviewer_id: f.guest.id })
    expect(edited.updated_at).not.toBe(entered.updated_at)
    expect(edited.review_at).toBe(entered.review_at)
    expect((await update(t, f, row.id, { reviewer_id: null })).review_at).toBe(entered.review_at)
    await tick()
    // naming one, or a different one, while in Review is
    const named = await update(t, f, row.id, { reviewer_id: f.admin.id })
    expect(named.review_at).toBe(named.updated_at)
    expect(named.review_at).not.toBe(entered.review_at)
    await tick()
    const handedOn = await update(t, f, row.id, { reviewer_id: f.guest.id })
    expect(handedOn.review_at).toBe(handedOn.updated_at)
    expect(handedOn.review_at).not.toBe(named.review_at)
  })

  it('keeps it from Review to Done, and clears it on every other way out', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inReview = {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review' as const,
      reviewer_id: f.guest.id,
      review_at: EARLIER,
    }
    const reviewed = await plantIssue(t, inReview)
    const done = await update(t, f, reviewed.id, { status: 'done' })
    expect(done.review_at).toBe(EARLIER)
    expect((await update(t, f, reviewed.id, { title: 'Still done' })).review_at).toBe(EARLIER)
    // Done to To Do clears
    expect('review_at' in (await update(t, f, reviewed.id, { status: 'todo' }))).toBe(false)

    const sentBack = await plantIssue(t, inReview)
    expect('review_at' in (await update(t, f, sentBack.id, { status: 'progress' }))).toBe(false)

    // In Progress straight to Done is not a review, whoever is named
    const skipped = await plantIssue(t, { ...inReview, status: 'progress', review_at: undefined })
    expect('review_at' in (await update(t, f, skipped.id, { status: 'done' }))).toBe(false)
  })

  it('stamps a task created In Review, and no other', async () => {
    const t = newT()
    const f = await withOrg(t)
    const born = await create(t, f, { status: 'review', reviewer_id: f.guest.id })
    expect(born.review_at).toBe(born.created_at)
    expect('review_at' in (await create(t, f, { status: 'done' }))).toBe(false)
    expect('review_at' in (await create(t, f, { status: 'todo', reviewer_id: f.guest.id }))).toBe(
      false,
    )
  })

  it('never lands on a group: refused into Review, and dropped when a leaf gains a subtask', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const group = await plantIssue(t, { ...base, status: 'progress' })
    await plantIssue(t, { ...base, parent_id: group.id })
    await expectRefusal(update(t, f, group.id, { status: 'review' }), 'rule')
    expect('review_at' in (await issueRow(t, group.id))).toBe(false)

    const leaf = await plantIssue(t, { ...base, status: 'progress' })
    expect((await update(t, f, leaf.id, { status: 'review' })).review_at).toBeDefined()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'First subtask',
      parent_id: leaf.id,
    })
    expect('review_at' in (await issueRow(t, leaf.id))).toBe(false)
  })

  it('every writer stamps it: REST and MCP into Review', async () => {
    const t = newT()
    const f = await withOrg(t)
    const rest = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.admin.id,
      keyName: 'test',
      ref: rest.id,
      body: JSON.stringify({ status: 'review' }),
    })
    expect((await issueRow(t, rest.id)).review_at).toBe(out.updated_at)
    const mcp = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.admin.id,
      ref: mcp.id,
      status: 'review',
    })
    const row = await issueRow(t, mcp.id)
    expect(row.review_at).toBe(row.updated_at)
  })
})

describe('every writer', () => {
  it('REST PATCH into Review gets the review time and narrates it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const out = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.admin.id,
      keyName: 'test',
      ref: row.id,
      body: JSON.stringify({ status: 'review' }),
    })
    expect(out.remaining_hours).toBe(2)
    expect(typeof out.remaining_set_at).toBe('string')
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0].detail).toContain('remaining unset → 2 h')
  })

  it('MCP update_task into Review gets the review time without echoing it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const out = JSON.parse(
      await t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.admin.id,
        ref: row.id,
        status: 'review',
      }),
    ) as { updated: string[] }
    expect(out.updated).toEqual(['status'])
    expect((await issueRow(t, row.id)).remaining_hours).toBe(2)
  })
})

describe('created in Review', () => {
  it('takes the review time unless hours are stated; other statuses get none', async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await create(t, f, { status: 'review', remaining_hours: null })
    expect(a.remaining_hours).toBe(2)
    expect(a.remaining_set_at).toBe(a.created_at)
    expect((await create(t, f, { status: 'review', remaining_hours: 7 })).remaining_hours).toBe(7)
    const todo = await create(t, f, { status: 'todo' })
    expect('remaining_hours' in todo).toBe(false)
  })
})

describe('reviewer eligibility (browser path)', () => {
  it('stores an eligible reviewer; null leaves the column absent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    expect((await update(t, f, row.id, { reviewer_id: f.guest.id })).reviewer_id).toBe(f.guest.id)
    await update(t, f, row.id, { reviewer_id: null })
    expect('reviewer_id' in (await issueRow(t, row.id))).toBe(false)
    expect((await create(t, f, { reviewer_id: f.guest.id })).reviewer_id).toBe(f.guest.id)
  })

  it('a standing reviewer survives a later downgrade on unrelated and same-value writes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await update(t, f, row.id, { reviewer_id: f.guest.id })
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant === null) throw new Error('fixture grant missing')
      await ctx.db.patch(grant._id, { level: 'viewer' })
    })
    expect((await update(t, f, row.id, { title: 'Still reviewed' })).reviewer_id).toBe(f.guest.id)
    expect((await update(t, f, row.id, { reviewer_id: f.guest.id })).reviewer_id).toBe(f.guest.id)
  })

  it('refuses ineligible reviewers with one sentence on update and create', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inactive = await plantSeat(t, { org_id: f.org.id, active: false })
    const viewOnly = await plantSeat(t, { org_id: f.org.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: inactive.id,
        level: 'user',
      })
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: viewOnly.id,
        level: 'viewer',
      })
    })
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // a foreign profile answers exactly like an unknown uuid: no oracle
    for (const bad of [f.viewer.id, f.otherAdmin.id, uuid(), inactive.id, viewOnly.id]) {
      await expectRefusal(update(t, f, row.id, { reviewer_id: bad }), 'rule', REVIEWER_SENTENCE)
      const args = createArgs(f, { reviewer_id: bad })
      await expectRefusal(
        as(t, f.user).mutation(api.issues.create, args),
        'rule',
        REVIEWER_SENTENCE,
      )
      expect(await t.run((ctx) => ctx.db.query('issues').collect())).toHaveLength(1)
    }
    expect(await issueRow(t, row.id)).toEqual(row)
  })

  it('a move keeps an eligible reviewer and refuses one without Edit at the destination', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      reviewer_id: f.guest.id,
    })
    const moved = await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: row.id,
      project_id: f.sub2.id,
    })
    expect(moved.project_id).toBe(f.sub2.id)
    expect(moved.reviewer_id).toBe(f.guest.id)

    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const before = await issueRow(t, row.id)
    await expectRefusal(
      as(t, f.user).mutation(api.issues.move, {
        org_id: f.org.id,
        id: row.id,
        project_id: hiddenSub.id,
      }),
      'rule',
      REVIEWER_SENTENCE,
    )
    expect(await issueRow(t, row.id)).toEqual(before)
  })

  it("a group's dormant reviewer never blocks a move: kept when eligible, else cleared", async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id, status: 'review' as const }
    const group = await plantIssue(t, { ...base, reviewer_id: f.guest.id })
    await plantIssue(t, { ...base, parent_id: group.id })
    const leaf = await plantIssue(t, { ...base, reviewer_id: f.guest.id })
    const move = (id: string, project_id: string) =>
      as(t, f.user).mutation(api.issues.move, { org_id: f.org.id, id, project_id })

    expect((await move(group.id, f.sub2.id)).reviewer_id).toBe(f.guest.id)

    // guest holds no grant under hidden: the group moves and drops its
    // reviewer, while the leaf with the same reviewer is still refused
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const moved = await move(group.id, hiddenSub.id)
    expect(moved.project_id).toBe(hiddenSub.id)
    expect('reviewer_id' in (await issueRow(t, group.id))).toBe(false)
    await expectRefusal(move(leaf.id, hiddenSub.id), 'rule', REVIEWER_SENTENCE)
    expect(await issueRow(t, leaf.id)).toEqual(leaf)
  })

  it('a task with active subtasks takes no new reviewer; clearing one passes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, { ...base, reviewer_id: f.admin.id })
    await plantIssue(t, { ...base, parent_id: parent.id })
    await expectRefusal(
      update(t, f, parent.id, { reviewer_id: f.guest.id }),
      'rule',
      /^a task with subtasks has no reviewer of its own; set reviewers on its subtasks$/,
    )
    expect(await issueRow(t, parent.id)).toEqual(parent)
    expect('reviewer_id' in (await update(t, f, parent.id, { reviewer_id: null }))).toBe(false)
  })
})

describe('machine sentence', () => {
  it('names the role in the Edit-permission sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const viewOnly = await plantSeat(t, { org_id: f.org.id })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: viewOnly.id,
        level: 'viewer',
      }),
    )
    await expectRefusal(
      t.run((ctx) => assertAssignable(ctx, f.sub, viewOnly.id, 'reviewer')),
      'bad_request',
      /needs Edit permission or higher on this project to review work$/,
    )
    await expectRefusal(
      t.run((ctx) => assertAssignable(ctx, f.sub, viewOnly.id)),
      'bad_request',
      /needs Edit permission or higher on this project to be assigned work$/,
    )
  })
})
