/* The follower notices of a comment or a change (model/messages.ts
 * FOLLOWER_FANOUT). The first followers hear in the writing transaction and
 * background steps tell the rest, so a task followed by thousands of people
 * before the follower cap stays inside Convex's limits, and every follower
 * reads the same line either way. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { FOLLOWER_FANOUT, postMessage } from '../model/messages'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const DEFAULT_FANOUT = { ...FOLLOWER_FANOUT }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  Object.assign(FOLLOWER_FANOUT, DEFAULT_FANOUT)
  vi.useRealTimers()
})

/* `n` people who see TBED through their own grant and follow `task`. */
const plantFollowers = (t: T, f: OrgFixture, task: Doc<'issues'>, n: number) =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const id = uuid()
      await ctx.db.insert('profiles', {
        id,
        org_id: f.org.id,
        name: `Follower ${i}`,
        initials: 'FF',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        accepted_at: NOW,
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: id,
        level: 'user',
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: id,
        created_at: NOW,
      })
      ids.push(id)
    }
    return ids
  })

/* What each recipient was told about `task`, by recipient. */
const told = (t: T, task: Doc<'issues'>) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id))
      .collect()
    return rows.map((m) => [m.recipient_id, m.detail] as const)
  })

const comment = (t: T, f: OrgFixture, task: Doc<'issues'>, body: string) =>
  as(t, f.admin).mutation(api.comments.create, {
    org_id: f.org.id,
    id: uuid(),
    issue_id: task.id,
    body,
  })

describe('the follower notices of a task followed before the cap', () => {
  it('tell 2,000 followers of a comment, the first in the comment and the rest in steps, within the limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const followers = await plantFollowers(t, f, task, 2000)
    // told in the comment, this passed 4,096 index ranges
    await comment(t, f, task, 'The supplier confirmed the dates.')
    expect(await told(t, task)).toHaveLength(FOLLOWER_FANOUT.inline)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const all = await told(t, task)
    expect(all.map(([id]) => id).sort()).toEqual([...followers].sort())
    expect(new Set(all.map(([, detail]) => detail))).toEqual(new Set(['New comment']))
  }, 120_000)

  it('tell no one more once the task is deleted', async () => {
    Object.assign(FOLLOWER_FANOUT, { inline: 2, step: 2 })
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantFollowers(t, f, task, 6)
    await comment(t, f, task, 'Closing this one.')
    await as(t, f.admin).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: task.id })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    // the delete removed the first two notices, and the steps posted none
    expect(await told(t, task)).toEqual([])
  })
})

describe('a change told in steps', () => {
  it('reads to each follower as it does in the change itself', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    /* One task with six followers, changed so every reader-side line
     * appears: the new assignee and reviewer follow already, one follower
     * is mentioned, and the task moves under a parent. */
    const changed = async () => {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      const people = await plantFollowers(t, f, task, 6)
      await as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: task.id,
        patch: {
          assignee_id: people[4],
          reviewer_id: people[5],
          status: 'review',
          parent_id: parent.id,
          description: `Ask @[Follower 3](user:${people[3]}) first.`,
        },
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      const byPerson = new Map(await told(t, task))
      return people.map((id) => byPerson.get(id))
    }
    const inline = await changed()
    // every follower past the first in background steps of two
    Object.assign(FOLLOWER_FANOUT, { inline: 1, step: 2 })
    const stepped = await changed()
    expect(stepped).toEqual(inline)
    expect(inline[4]).toMatch(/^Assigned to you\. Reviewer set to Follower 5\./)
    expect(inline[5]).toMatch(/^Assigned to Follower 4\. Ready for your review\./)
    expect(inline[3]).not.toMatch(/Description updated/)
    expect(inline[0]).toMatch(/Description updated/)
  })
})

describe('a change told in steps after the task changed', () => {
  /* A follower who sees only Board rev, and one who sees all of TBED, both
   * following a task in Firmware. */
  async function scene() {
    Object.assign(FOLLOWER_FANOUT, { inline: 0, step: 10 })
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Draft' })
    const outsider = await plantSeat(t, { org_id: f.org.id, org_role: 'user' })
    const insider = await plantSeat(t, { org_id: f.org.id, org_role: 'user' })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: outsider.id,
        level: 'user',
      })
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: insider.id,
        level: 'user',
      })
    })
    for (const p of [outsider, insider])
      await plantSubscription(t, { issue_id: task.id, profile_id: p.id })
    const rename = () =>
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: task.id,
        patch: { title: 'Acquisition plan' },
      })
    return { t, f, task, outsider, insider, rename }
  }

  it('tells nobody what they could not see when it was written, after a move', async () => {
    const { t, f, task, outsider, insider, rename } = await scene()
    await rename()
    // the task moves to Board rev, which the outsider sees, before the step
    await t.run(async (ctx) => ctx.db.patch(task._id, { project_id: f.sub2.id }))
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const byPerson = new Map(await told(t, task))
    expect(byPerson.get(outsider.id)).toBeUndefined()
    expect(byPerson.get(insider.id)).toBe('Title: “Draft” → “Acquisition plan”')
  })

  it('tells nobody about a task deleted and written back with the same id meanwhile', async () => {
    const { t, task, insider, rename } = await scene()
    await rename()
    await t.run(async (ctx) => {
      const row = await ctx.db.get(task._id)
      if (row === null) throw new Error('no task')
      const { _id, _creationTime, ...doc } = row
      await ctx.db.delete(_id)
      await ctx.db.insert('issues', doc)
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(new Map(await told(t, task)).get(insider.id)).toBeUndefined()
  })

  it('keeps the new parent anonymous once it moved out of sight meanwhile', async () => {
    const { t, f, task, insider } = await scene()
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: task.id,
      patch: { parent_id: parent.id },
    })
    // the parent moves to a sub-project the insider cannot see
    const hidden = await plantHiddenSibling(t, f, insider)
    await t.run(async (ctx) => ctx.db.patch(parent._id, { project_id: hidden.id }))
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(new Map(await told(t, task)).get(insider.id)).toBe(
      'Attached under a task in another sub-project',
    )
  })
})

describe('a notice that arrives after newer ones', () => {
  it('keeps the newest message of each kind when it trims the item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    // 50 unread: a comment, a change at minute 2 and 48 later comments
    await t.run(async (ctx) => {
      const row = (kind: 'comment' | 'change', minute: number) =>
        ctx.db.insert('messages', {
          id: uuid(),
          org_id: f.org.id,
          recipient_id: f.user.id,
          issue_id: task.id,
          issue_title: task.title,
          kind,
          detail: `${kind} ${minute}`,
          created_at: at(minute),
        })
      await row('comment', 0)
      await row('change', 2)
      for (let m = 3; m < 51; m++) await row('comment', m)
    })
    // a step's change written at minute 1 arrives last
    await t.run((ctx) =>
      postMessage(ctx, {
        org_id: f.org.id,
        recipient_id: f.user.id,
        issue_id: task.id,
        kind: 'change',
        body: 'change 1',
        actor_id: f.admin.id,
        now: at(1),
      }),
    )
    const details = (await told(t, task)).map(([, detail]) => detail)
    expect(details).toHaveLength(50)
    expect(details).toContain('change 2')
    expect(details).toContain('comment 0')
  })
})
