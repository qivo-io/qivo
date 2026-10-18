/* Bulk task updates in one transaction, from one NotifyPreload
 * (model/messages.ts):
 *
 *   1. An access removal that reassigns its held tasks
 *      (model/projectAccess.ts removeAndSettle) stays inside Convex's limits
 *      for one transaction up to REASSIGN_MAX tasks and refuses more, without
 *      blaming the tasks.
 *   2. The preload and the passed checks (model/issues.ts BulkUpdate) change
 *      nothing a follower reads or follows.
 *   3. Deleting a task with many direct subtasks detaches and announces them
 *      all inside those limits (model/deletedItems.ts moveTasksToTrash).
 *
 * convex-test enforces the deployment's limits with transactionLimits: true
 * and counts every index range a function reads, where a deployment counts a
 * range it already read once, so these counts are an upper bound.
 *
 * REASSIGN_MAX comes from the `crowded` fixture below. When it was set, the
 * largest count that fixture reassigned inside the limits was 196 tasks, at
 * about 16 index ranges per task after about 900 for the first sight check of
 * each follower. Index ranges ran out first. Without the preload it managed
 * 44 tasks, at about 93 ranges each. A local Convex backend reassigned 400
 * tasks of the same shape, with 92 more people in Northstar, using 3,422 of
 * its 4,096 reads, so the cap leaves room for larger organizations. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal } from '../lib/functions'
import { type BulkUpdate, holderKey, updateIssueCore } from '../model/issues'
import { loadNotifyPreload } from '../model/messages'
import { REASSIGN_MAX, REASSIGN_TOO_LARGE } from '../model/projectAccess'
import {
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* The people the crowd adds to withOrg's five, for an organization of 100. */
const CROWD = 93

type Crowd = OrgFixture & {
  t: T
  emil: Doc<'profiles'>
  leo: Doc<'profiles'>
  crowd: Doc<'profiles'>[]
  tasks: Doc<'issues'>[]
}

/* withOrg grown to 100 profiles. Hardware (led by `user`) and a second team,
 * Platform, each hold User on TBED, and the crowd is split between them, so
 * every person sees TBED only through a team grant. Emil, in Hardware, holds
 * `n` open tasks in Firmware, each followed by him and three of the crowd.
 * Every third one is a subtask of a task in Board rev, and every fifth is In
 * Review with Emil as its reviewer. Leo, in Platform, can take them all. */
async function crowded(n: number, t: T = newT({ transactionLimits: true })): Promise<Crowd> {
  const f = await withOrg(t)
  const { emil, leo, crowd } = await t.run(async (ctx) => {
    const platform = uuid()
    await ctx.db.insert('teams', {
      id: platform,
      org_id: f.org.id,
      name: 'Platform',
      stale_days: 14,
      archive_days: 30,
      track_delay_default: false,
      created_at: NOW,
    })
    for (const team_id of [f.team.id, platform])
      await ctx.db.insert('project_team_access', { project_id: f.meta.id, team_id, level: 'user' })
    const person = async (name: string, team_id: string) => {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.org.id,
        name,
        initials: name.slice(0, 2).toUpperCase(),
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        accepted_at: NOW,
        created_at: NOW,
      })
      const profile = (await ctx.db.get(_id)) as Doc<'profiles'>
      await ctx.db.insert('team_members', { team_id, profile_id: profile.id, is_leader: false })
      return profile
    }
    const crowd: Doc<'profiles'>[] = []
    for (let i = 0; i < CROWD; i++) crowd.push(await person(`p${i}`, i % 2 ? platform : f.team.id))
    return {
      emil: await person('Emil', f.team.id),
      leo: await person('Leo', platform),
      crowd,
    }
  })
  const parents: Doc<'issues'>[] = []
  for (let i = 0; i < Math.ceil(n / 30); i++)
    parents.push(
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub2.id,
        title: `Parent ${i}`,
        assignee_id: f.user.id,
      }),
    )
  const tasks: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += 100) {
    tasks.push(
      ...(await t.run(async (ctx) => {
        const out: Doc<'issues'>[] = []
        for (let i = from; i < Math.min(n, from + 100); i++) {
          const reviewing = i % 5 === 1
          const _id = await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 1000 + i,
            title: `Task ${i}`,
            description: '',
            status: reviewing ? 'review' : 'todo',
            priority: 'medium',
            paused: false,
            assignee_id: reviewing ? crowd[i % CROWD].id : emil.id,
            reviewer_id: reviewing ? emil.id : undefined,
            parent_id: i % 3 === 0 ? parents[Math.floor(i / 30)].id : undefined,
            created_at: NOW,
            updated_at: NOW,
          })
          const task = (await ctx.db.get(_id)) as Doc<'issues'>
          for (const follower of [emil, ...[1, 2, 3].map((k) => crowd[(i * 3 + k) % CROWD])])
            await ctx.db.insert('issue_subscriptions', {
              issue_id: task.id,
              profile_id: follower.id,
              created_at: NOW,
            })
          out.push(task)
        }
        return out
      })),
    )
  }
  return { ...f, t, emil, leo, crowd, tasks }
}

/* The app's removal of Emil from Hardware, handing his tasks to `to`. */
const removeEmil = (fx: Crowd, to: string | null) =>
  as(fx.t, fx.user).mutation(api.teams.removeMember, {
    org_id: fx.org.id,
    team_id: fx.team.id,
    profile_id: fx.emil.id,
    on_held_tasks: { reassign_to: to },
  })

const membership = (fx: Crowd) =>
  fx.t.run((ctx) =>
    ctx.db
      .query('team_members')
      .withIndex('by_team_profile', (q) => q.eq('team_id', fx.team.id).eq('profile_id', fx.emil.id))
      .unique(),
  )

/* Each planted task's assignee and reviewer, in order, null for none. */
const holders = (fx: Crowd) =>
  fx.t.run(async (ctx) => {
    const out: [string | null, string | null][] = []
    for (const task of fx.tasks) {
      const row = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', task.id))
        .unique()
      out.push([row?.assignee_id ?? null, row?.reviewer_id ?? null])
    }
    return out
  })

describe('reassigning the tasks of an access removal', () => {
  it(`hands over ${REASSIGN_MAX} tasks inside one transaction's limits`, async () => {
    const fx = await crowded(REASSIGN_MAX)
    await removeEmil(fx, fx.leo.id)
    expect(await membership(fx)).toBeNull()
    // each task keeps its other holder, and Leo takes Emil's role
    expect(await holders(fx)).toEqual(
      fx.tasks.map((task) =>
        task.reviewer_id === fx.emil.id ? [task.assignee_id, fx.leo.id] : [fx.leo.id, null],
      ),
    )
  })

  it(`refuses ${REASSIGN_MAX + 1} tasks for their number, and changes nothing`, async () => {
    const fx = await crowded(REASSIGN_MAX + 1)
    const before = await holders(fx)
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(REASSIGN_TOO_LARGE)
    // the app quotes the sentence rather than blaming the tasks
    expect((e.data as Refusal).reason).toBeUndefined()
    expect(await membership(fx)).not.toBeNull()
    expect(await holders(fx)).toEqual(before)
    // leaving them still removes the member at once
    await as(fx.t, fx.user).mutation(api.teams.removeMember, {
      org_id: fx.org.id,
      team_id: fx.team.id,
      profile_id: fx.emil.id,
      on_held_tasks: 'leave',
    })
    expect(await membership(fx)).toBeNull()
  })

  it('refuses a project grant removal above the cap too, keeping the grant', async () => {
    const fx = await crowded(REASSIGN_MAX + 1)
    const e = await expectRefusal(
      as(fx.t, fx.user).mutation(api.projects.removeAccess, {
        org_id: fx.org.id,
        id: fx.meta.id,
        team_id: fx.team.id,
        on_held_tasks: { reassign_to: null },
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(REASSIGN_TOO_LARGE)
    const grant = await fx.t.run((ctx) =>
      ctx.db
        .query('project_team_access')
        .withIndex('by_project_team', (q) =>
          q.eq('project_id', fx.meta.id).eq('team_id', fx.team.id),
        )
        .unique(),
    )
    expect(grant?.level).toBe('user')
  })

  it('still refuses, changing nothing, when the new holder cannot take a task', async () => {
    const fx = await crowded(3)
    // the organization's viewer sees TBED but is never assigned work
    const before = await holders(fx)
    const e = await expectRefusal(removeEmil(fx, fx.viewer.id), 'rule')
    expect((e.data as Refusal).reason).toBe('held_tasks')
    expect(await membership(fx)).not.toBeNull()
    expect(await holders(fx)).toEqual(before)
  })

  it('tells each follower what they would read without the preload, and no one who lost sight', async () => {
    const fx = await crowded(3)
    await removeEmil(fx, fx.leo.id)
    // Emil was assigned task 0, a subtask, and task 2, and reviewed task 1
    const [first, second, third] = fx.tasks
    for (const task of [first, third]) {
      expect((await messagesFor(fx.t, fx.leo.id, task.id)).map((m) => m.detail)).toEqual([
        'Assigned to you',
      ])
    }
    expect((await messagesFor(fx.t, fx.leo.id, second.id)).map((m) => m.detail)).toEqual([
      'Ready for your review',
    ])
    const follower = fx.crowd[1]
    expect((await messagesFor(fx.t, follower.id, first.id)).map((m) => m.detail)).toEqual([
      'Assigned to Leo',
    ])
    // Emil still follows his old tasks, but lost sight of them, so he hears nothing
    expect(await messagesFor(fx.t, fx.emil.id)).toEqual([])
    const follows = await fx.t.run(async (ctx) =>
      (
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', first.id))
          .collect()
      )
        .map((s) => s.profile_id)
        .sort(),
    )
    expect(follows).toEqual([fx.emil.id, fx.leo.id, ...[1, 2, 3].map((k) => fx.crowd[k].id)].sort())
  })
})

describe('a bulk update', () => {
  /* One reassignment of each planted task to Leo, with a preload or without,
   * answering every message and follow it wrote. Nora follows every task
   * but sees no project, so she must hear nothing either way. */
  async function handOver(withBulk: boolean) {
    const fx = await crowded(6, newT())
    const nora = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Nora', accepted_at: NOW })
    for (const task of fx.tasks)
      await plantSubscription(fx.t, { issue_id: task.id, profile_id: nora.id })
    await fx.t.run(async (ctx) => {
      const bulk: BulkUpdate | undefined = withBulk
        ? { preload: await loadNotifyPreload(ctx, fx.org.id), checked: new Set() }
        : undefined
      for (const task of fx.tasks) {
        const role = task.reviewer_id === fx.emil.id ? 'reviewer_id' : 'assignee_id'
        await updateIssueCore(ctx, {
          me: fx.user,
          issue: task,
          patch: { [role]: fx.leo.id },
          now: NOW,
          bulk,
        })
      }
    })
    return await fx.t.run(async (ctx) => {
      const name = new Map([fx.emil, fx.leo, nora, ...fx.crowd].map((p) => [p.id, p.name] as const))
      const at = new Map(fx.tasks.map((task, i) => [task.id, i] as const))
      const messages = (await ctx.db.query('messages').collect())
        .map((m) => `${at.get(m.issue_id)} ${name.get(m.recipient_id)}: ${m.detail}`)
        .sort()
      const follows = (await ctx.db.query('issue_subscriptions').collect())
        .map((s) => `${at.get(s.issue_id)} ${name.get(s.profile_id)}`)
        .sort()
      return { messages, follows }
    })
  }

  it('writes the same messages and follows as single updates', async () => {
    const single = await handOver(false)
    expect(single.messages.length).toBeGreaterThan(12)
    expect(single.messages.some((m) => m.includes('Nora'))).toBe(false)
    expect(await handOver(true)).toEqual(single)
  })

  it('skips only a check it already passed for that holder and project', async () => {
    const fx = await crowded(2, newT())
    // a passed rule for Leo does not cover the viewer, who cannot hold work
    await expectRefusal(
      fx.t.run(async (ctx) => {
        const bulk: BulkUpdate = {
          preload: await loadNotifyPreload(ctx, fx.org.id),
          checked: new Set([holderKey('assignee', fx.leo.id, fx.sub.id)]),
        }
        await updateIssueCore(ctx, {
          me: fx.user,
          issue: fx.tasks[0],
          patch: { assignee_id: fx.viewer.id },
          now: NOW,
          bulk,
        })
      }),
      'rule',
    )
  })
})

describe('deleting a task with many subtasks', () => {
  it('detaches 300 subtasks inside one transaction, and tells their followers', async () => {
    const fx = await crowded(0)
    const parent = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub2.id,
      title: 'Parent',
      assignee_id: fx.user.id,
    })
    const followers = (i: number) => [1, 2].map((k) => fx.crowd[(i * 2 + k) % CROWD])
    const kids = await fx.t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 300; i++) {
        const id = uuid()
        await ctx.db.insert('issues', {
          id,
          org_id: fx.org.id,
          project_id: fx.sub.id,
          num: 2000 + i,
          title: `Subtask ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          parent_id: parent.id,
          created_at: NOW,
          updated_at: NOW,
        })
        for (const follower of followers(i))
          await ctx.db.insert('issue_subscriptions', {
            issue_id: id,
            profile_id: follower.id,
            created_at: NOW,
          })
        ids.push(id)
      }
      return ids
    })
    await as(fx.t, fx.user).mutation(api.issues.deleteDeep, { org_id: fx.org.id, id: parent.id })
    const { rows, messages } = await fx.t.run(async (ctx) => ({
      rows: await ctx.db
        .query('issues')
        .withIndex('by_project', (q) => q.eq('project_id', fx.sub.id))
        .collect(),
      messages: await ctx.db.query('messages').collect(),
    }))
    expect(rows.filter((r) => r.parent_id === undefined)).toHaveLength(300)
    const told = new Map<string, string[]>()
    for (const m of messages) {
      expect(m.detail).toBe('Detached from its parent')
      told.set(m.issue_id, [...(told.get(m.issue_id) ?? []), m.recipient_id].sort())
    }
    kids.forEach((id, i) => {
      expect(told.get(id)).toEqual(
        followers(i)
          .map((p) => p.id)
          .sort(),
      )
    })
  })
})
