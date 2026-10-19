/* The follower notices of a comment or a change (model/messages.ts
 * FOLLOWER_FANOUT). The first followers hear in the writing transaction and
 * background steps tell the rest, so a task followed by thousands of people
 * before the follower cap stays inside Convex's limits, and every follower
 * reads the same line either way. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { FOLLOWER_FANOUT } from '../model/messages'
import { as, NOW, newT, type OrgFixture, plantIssue, type T, uuid, withOrg } from './helpers.setup'

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
