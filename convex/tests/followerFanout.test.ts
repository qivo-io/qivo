/* The follower notices of a comment or a change (model/messages.ts
 * FOLLOWER_FANOUT). The first followers hear in the writing transaction and
 * background steps tell the rest, so a task followed by thousands of people
 * before the follower cap stays inside Convex's limits, and every follower
 * reads the same line either way. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { FOLLOWER_FANOUT, postMessage } from '../model/messages'
import {
  as,
  messagesFor,
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
import { deleteTask, itemFor } from './trash.setup'

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

describe('a step whose followers hold many snoozed rows', () => {
  it('stops on its room and tells the rest in the next step, within the limits', async () => {
    // convex-test counts no range for a write, which reads its row first,
    // so the writes stand in for those ranges
    const t = newT({ transactionLimits: { documentsWritten: 4096 } })
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    const followers = await plantFollowers(t, f, kept, 100)
    // each item holds 50 snoozed rows, one write each to wake
    for (let from = 0; from < followers.length; from += 40)
      await t.run(async (ctx) => {
        for (const recipient_id of followers.slice(from, from + 40))
          for (let i = 0; i < 50; i++)
            await ctx.db.insert('messages', {
              id: uuid(),
              org_id: f.org.id,
              recipient_id,
              issue_id: kept.id,
              issue_title: kept.title,
              kind: 'change',
              detail: `Status update ${i + 1}`,
              created_at: NOW,
              snoozed_until: '2026-12-01T09:00:00.000Z',
            })
      })

    // the delete detaches the kept subtask and leaves its followers to steps
    await deleteTask(t, f, parent.id)
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const rows = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_issue_read', (q) => q.eq('issue_id', kept.id))
        .collect(),
    )
    const detached = rows.filter((m) => m.detail === 'Detached from its parent')
    expect(detached.map((m) => m.recipient_id).sort()).toEqual([...followers].sort())
    expect(rows.filter((m) => m.snoozed_until !== undefined)).toEqual([])
  }, 120_000)
})

/* 50 snoozed rows about `task` in the item of each of `followers`, each a
 * write to wake. */
const plantSnoozed = async (t: T, f: OrgFixture, task: Doc<'issues'>, followers: string[]) => {
  for (let from = 0; from < followers.length; from += 40)
    await t.run(async (ctx) => {
      for (const recipient_id of followers.slice(from, from + 40))
        for (let i = 0; i < 50; i++)
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: f.org.id,
            recipient_id,
            issue_id: task.id,
            issue_title: task.title,
            kind: 'change',
            detail: `Status update ${i + 1}`,
            created_at: NOW,
            snoozed_until: '2026-12-01T09:00:00.000Z',
          })
    })
}

describe('a comment whose followers hold many snoozed rows', () => {
  it('stops on its room and tells the rest in steps, within the limits', async () => {
    // convex-test counts no range for a write, which reads its row first,
    // so the writes stand in for those ranges
    const t = newT({ transactionLimits: { documentsWritten: 4096 } })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const followers = await plantFollowers(t, f, task, 100)
    await plantSnoozed(t, f, task, followers)

    await comment(t, f, task, 'The supplier confirmed the dates.')
    const inline = (await told(t, task)).filter(([, detail]) => detail === 'New comment')
    expect(inline.length).toBeGreaterThan(0)
    expect(inline.length).toBeLessThan(followers.length)
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const rows = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id))
        .collect(),
    )
    const notices = rows.filter((m) => m.detail === 'New comment')
    expect(notices.map((m) => m.recipient_id).sort()).toEqual([...followers].sort())
    expect(rows.filter((m) => m.snoozed_until !== undefined)).toEqual([])
  }, 120_000)

  it('tells 100 mentioned people the same way, the first in the comment and the rest in steps', async () => {
    const t = newT({ transactionLimits: { documentsWritten: 4096 } })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // people who see the task but do not follow it yet
    const people = await plantFollowers(t, f, task, 100)
    await t.run(async (ctx) => {
      for (const s of await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_profile', (q) => q.eq('issue_id', task.id))
        .collect())
        await ctx.db.delete(s._id)
    })
    await plantSnoozed(t, f, task, people)

    await comment(t, f, task, people.map((id) => `@[Reviewer](user:${id})`).join(' '))
    const mentioned = (await told(t, task)).filter(([, d]) => d === 'Mentioned you in a comment')
    expect(mentioned.length).toBeGreaterThan(0)
    expect(mentioned.length).toBeLessThan(people.length)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const all = (await told(t, task)).filter(([, d]) => d === 'Mentioned you in a comment')
    expect(all.map(([id]) => id).sort()).toEqual([...people].sort())
    // each follows the task now, and none heard the comment twice
    expect((await told(t, task)).filter(([, d]) => d === 'New comment')).toEqual([])
  }, 120_000)
})

describe('notices a step posts after their author was removed', () => {
  it('do not name the removed author', async () => {
    Object.assign(FOLLOWER_FANOUT, { inline: 1, step: 2, inlineRoom: 0 })
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const followers = await plantFollowers(t, f, task, 4)
    // the author mentions two followers; the room leaves both mentions and
    // all but the first follower to steps
    await as(t, f.user).mutation(api.comments.create, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: task.id,
      body: `@[A](user:${followers[0]}) @[B](user:${followers[1]}) please look`,
    })
    // the author is removed and the cleanup finishes before the steps run
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    const pending = () =>
      t.run((ctx) =>
        ctx.db
          .query('profile_removals')
          .withIndex('by_profile', (q) => q.eq('profile_id', f.user.id))
          .unique(),
      )
    while ((await pending()) !== null)
      await t.mutation(internal.profileRemovals.step, { profile_id: f.user.id })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const rows = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id))
        .collect(),
    )
    expect(rows.map((m) => m.recipient_id).sort()).toEqual([...followers].sort())
    expect(rows.filter((m) => m.actor_id !== undefined)).toEqual([])
  })
})

describe('a restore from Deleted items', () => {
  it("tells the task's followers past the first in steps", async () => {
    Object.assign(FOLLOWER_FANOUT, { inline: 2, step: 2 })
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const followers = await plantFollowers(t, f, task, 7)
    await deleteTask(t, f, task.id)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const item = await itemFor(t, task.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] })
    // the restore's own transaction tells the first two
    expect(await told(t, task)).toHaveLength(2)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const all = await told(t, task)
    expect(all.map(([id]) => id).sort()).toEqual([...followers].sort())
    expect(new Set(all.map(([, detail]) => detail))).toEqual(new Set(['Restored']))
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

  it('keeps the new parent anonymous when it moved into sight meanwhile', async () => {
    const { t, f, task, insider } = await scene()
    // the parent sits in a sub-project the insider cannot see when the
    // change is written, and moves into Firmware before the step
    const hidden = await plantHiddenSibling(t, f, insider)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: hidden.id })
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: task.id,
      patch: { parent_id: parent.id },
    })
    await t.run(async (ctx) => ctx.db.patch(parent._id, { project_id: f.sub.id }))
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
    // the arrival woke the item, so it stays, and the oldest other comment goes
    expect(details).toContain('change 1')
    expect(details).not.toContain('comment 3')
  })
})

describe('a deferred mention step', () => {
  /** Runs one mention step about `task`, written in `projectId`. */
  const mentionStep = (t: T, f: OrgFixture, task: Doc<'issues'>, projectId: string) =>
    t.mutation(internal.messages.notifyMentions, {
      org_id: f.org.id,
      issue_id: task.id,
      task: task._id,
      project_id: projectId,
      actor_id: f.user.id,
      now: NOW,
      body: 'Can you check this?',
      recipients: [f.guest.id, f.admin.id],
    })

  it('tells only those who see the task where it was written and where it is now', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // written in Skunkworks, which the guest cannot see, and moved to
    // Firmware, which they can, before the step ran
    await mentionStep(t, f, task, f.hidden.id)
    expect(await messagesFor(t, f.guest.id, task.id)).toEqual([])
    expect(await messagesFor(t, f.admin.id, task.id)).toHaveLength(1)
  })

  it('tells nobody about a task deleted before it ran', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run((ctx) => ctx.db.delete(task._id))
    await mentionStep(t, f, task, f.sub.id)
    for (const who of [f.guest, f.admin]) expect(await messagesFor(t, who.id, task.id)).toEqual([])
  })
})
