/* Bulk task updates in one transaction, from one NotifyPreload
 * (model/messages.ts):
 *
 *   1. An access removal that reassigns its held tasks
 *      (model/projectAccess.ts removeAndSettle) stays inside Convex's limits
 *      for one transaction up to REASSIGN_MAX tasks with a few followers
 *      each. It refuses more tasks, or fewer whose followers fill the
 *      transaction (REASSIGN_ROOM), without blaming the tasks, and suggests
 *      keeping the people as Viewers only to a remover who could.
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
 * its 4,096 reads. Followers' sight is now worked out once per project
 * after the first few (model/messages.ts RecipientSight), so each follower
 * costs about one range: REASSIGN_MAX tasks used 1,669 ranges here with 4
 * followers each and 3,709 with 21, and 100 tasks with 61 followers each
 * reach REASSIGN_ROOM, which refuses them. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal } from '../lib/functions'
import { type BulkUpdate, holderKey, type IssuePatch, updateIssueCore } from '../model/issues'
import { loadNotifyPreload } from '../model/messages'
import { REASSIGN_MAX, reassignTooLarge } from '../model/projectAccess'
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
 * `n` open tasks in Firmware, each followed by him and `followers` of the
 * crowd. Every third one is a subtask of a task in Board rev, and every fifth
 * is In Review with Emil as its reviewer. Leo, in Platform, can take them
 * all. */
async function crowded(
  n: number,
  { followers = 3, t = newT({ transactionLimits: true }) }: { followers?: number; t?: T } = {},
): Promise<Crowd> {
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
          const others = Array.from(
            { length: followers },
            (_, k) => crowd[(i * followers + k + 1) % CROWD],
          )
          for (const follower of [emil, ...others])
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
    expect((e.data as Refusal).message).toBe(reassignTooLarge(true))
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
    expect((e.data as Refusal).message).toBe(reassignTooLarge(true))
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

  it('suggests Viewers only to a remover who could keep them', async () => {
    const fx = await crowded(REASSIGN_MAX + 1)
    // `user` still leads Hardware but no longer leads TBED, so cannot give
    // Viewer grants on it
    await fx.t.run((ctx) => ctx.db.patch(fx.meta._id, { lead_id: fx.admin.id }))
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(reassignTooLarge(false))
    await expectRefusal(
      as(fx.t, fx.user).mutation(api.teams.removeMember, {
        org_id: fx.org.id,
        team_id: fx.team.id,
        profile_id: fx.emil.id,
        on_held_tasks: 'keep_as_viewer',
      }),
      'forbidden',
    )
  })

  it('refuses fewer tasks whose followers would fill the transaction, and changes nothing', async () => {
    // 40 tasks with 21 followers each need about 1,330 index ranges here,
    // past a limit of 1,000
    const fx = await crowded(40, {
      followers: 20,
      t: newT({ transactionLimits: { databaseQueries: 1000 } }),
    })
    const before = await holders(fx)
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(reassignTooLarge(true))
    expect((e.data as Refusal).reason).toBeUndefined()
    // the tasks reassigned before the check refused are rolled back too
    expect(await membership(fx)).not.toBeNull()
    expect(await holders(fx)).toEqual(before)
    expect(await fx.t.run((ctx) => ctx.db.query('messages').collect())).toEqual([])
  })

  it('refuses during a task whose followers would pass the limits', async () => {
    const fx = await crowded(20, { t: newT({ transactionLimits: { databaseQueries: 1000 } }) })
    // 1,000 more people of Hardware follow only the last task, which the
    // removal reaches last. Checked only before each task, their messages
    // pass a limit of 1,000 index ranges during that task.
    const last = fx.tasks[fx.tasks.length - 1]
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 1000; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: fx.org.id,
          name: `q${i}`,
          initials: 'QQ',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          accepted_at: NOW,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: fx.team.id,
          profile_id: id,
          is_leader: false,
        })
        await ctx.db.insert('issue_subscriptions', {
          issue_id: last.id,
          profile_id: id,
          created_at: NOW,
        })
      }
    })
    const before = await holders(fx)
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(reassignTooLarge(true))
    expect(await membership(fx)).not.toBeNull()
    expect(await holders(fx)).toEqual(before)
  })

  it('hands over a task whose followers see it through one of many teams', async () => {
    // With 50 more teams sharing TBED, checking each follower's sight on its
    // own read every share, about 100 index ranges each, so the 41 followers
    // of one task passed the limit. The project's shares are now read once.
    const fx = await crowded(1, { followers: 40 })
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: fx.org.id,
          name: `Team ${i}`,
          stale_days: 14,
          archive_days: 30,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('project_team_access', {
          project_id: fx.meta.id,
          team_id: id,
          level: 'viewer',
        })
      }
    })
    await removeEmil(fx, fx.leo.id)
    expect(await membership(fx)).toBeNull()
    expect(await holders(fx)).toEqual([[fx.leo.id, null]])
    expect((await messagesFor(fx.t, fx.crowd[1].id, fx.tasks[0].id)).map((m) => m.detail)).toEqual([
      'Assigned to Leo',
    ])
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
  /* One update of each planted task, with a preload or without, answering
   * every message and follow it wrote. Each task goes to Leo. Of the tasks
   * that are not subtasks yet, one in two is also attached under a task in
   * Board rev, and the other mentions p50, who sees Firmware but follows
   * none of them, and Pia, who sees no project. Nora follows every task but
   * sees no project either. Neither must hear anything or follow a task.
   * Olga follows every task and sees Firmware through her own grant but not
   * Board rev, so she must read the attach line without the parent's key. */
  async function handOver(withBulk: boolean) {
    const fx = await crowded(6, { t: newT() })
    const nora = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Nora', accepted_at: NOW })
    const olga = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Olga', accepted_at: NOW })
    const pia = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Pia', accepted_at: NOW })
    await fx.t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: fx.sub.id,
        profile_id: olga.id,
        level: 'user',
      }),
    )
    for (const task of fx.tasks)
      for (const p of [nora, olga])
        await plantSubscription(fx.t, { issue_id: task.id, profile_id: p.id })
    const parent = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub2.id,
      num: 900,
      title: 'Board parent',
    })
    const p50 = fx.crowd[50]
    await fx.t.run(async (ctx) => {
      const bulk: BulkUpdate | undefined = withBulk
        ? { preload: await loadNotifyPreload(ctx, fx.org.id), checked: new Set() }
        : undefined
      for (const [i, task] of fx.tasks.entries()) {
        const role = task.reviewer_id === fx.emil.id ? 'reviewer_id' : 'assignee_id'
        const patch: IssuePatch = { [role]: fx.leo.id }
        if (i % 3 === 1) patch.parent_id = parent.id
        if (i % 3 === 2)
          patch.description = `@[p50](user:${p50.id}) and @[Pia](user:${pia.id}), please look`
        await updateIssueCore(ctx, { me: fx.user, issue: task, patch, now: NOW, bulk })
      }
    })
    return await fx.t.run(async (ctx) => {
      const name = new Map(
        [fx.emil, fx.leo, nora, olga, pia, ...fx.crowd].map((p) => [p.id, p.name] as const),
      )
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
    const { messages, follows } = single
    expect(messages.some((m) => m.includes('Nora') || m.includes('Pia'))).toBe(false)
    // each branch the preload answers ran: the attach line with and without
    // the parent's key, and the mention of someone who sees the task
    expect(messages).toContain('4 Olga: Assigned to Leo. Attached under a task in another project')
    expect(messages).toContain('4 p13: Assigned to Leo. Attached under QN-900')
    expect(messages).toContain('2 p50: Mentioned you in the description')
    expect(follows).toContain('2 p50')
    expect(follows.some((f) => f.includes('Pia'))).toBe(false)
    expect(await handOver(true)).toEqual(single)
  })

  it('skips only a check it already passed for that holder and project', async () => {
    const fx = await crowded(2, { t: newT() })
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
