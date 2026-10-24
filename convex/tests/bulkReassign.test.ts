/* Bulk task updates in one transaction, from one NotifyPreload
 * (model/messages.ts):
 *
 *   1. An access removal that reassigns its held tasks
 *      (model/projectAccess.ts removeAndSettle), deleting a team included,
 *      stays inside Convex's limits for one transaction up to
 *      LIMITS.reassign.max tasks. Its followers hear from background steps
 *      (NotifyPreload.deferFollowers), so their number costs the removal
 *      nothing. It refuses more tasks, or fewer that fill the
 *      transaction (REASSIGN_ROOM), without blaming the tasks, and suggests
 *      keeping the people as Viewers only to a remover who could.
 *   2. The preload and the passed checks (model/issues.ts BulkUpdate) change
 *      nothing a follower reads or follows.
 *   3. Deleting a task with LIMITS.subtasks.max active subtasks detaches and
 *      announces them all inside those limits, and its archived subtasks in
 *      background steps (model/deletedItems.ts moveTasksToTrash).
 *
 * convex-test enforces the deployment's limits with transactionLimits: true
 * and counts every index range a function reads, where a deployment counts a
 * range it already read once, so these counts are an upper bound.
 *
 * LIMITS.reassign.max comes from the `crowded` fixture below. When it was
 * set, the largest count that fixture reassigned inside the limits was 196 tasks, at
 * about 16 index ranges per task after about 900 for the first sight check of
 * each follower, back when the removal told every follower itself. Index
 * ranges ran out first. A local Convex backend now reassigns 120 tasks with
 * 100 followers each, which once was refused. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { LEVELS_READ, projectLevelsForPeople } from '../lib/access'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { type BulkUpdate, holderKey, type IssuePatch, updateIssueCore } from '../model/issues'
import { FOLLOWER_FANOUT, newNotifyPreload } from '../model/messages'
import { REMOVAL_FULL, reassignTooLarge } from '../model/projectAccess'
import {
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
  withParentKey,
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
      await ctx.db.insert('team_members', {
        team_id,
        profile_id: profile.id,
        org_id: profile.org_id,
        is_leader: false,
      })
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
          const _id = await ctx.db.insert(
            'issues',
            await withParentKey(ctx, {
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
            }),
          )
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

/* The app's deletion of Hardware, handing its members' tasks to `to`. */
const deleteHardware = (fx: Crowd, to: string | null) =>
  as(fx.t, fx.admin).mutation(api.teams.deleteDeep, {
    org_id: fx.org.id,
    id: fx.team.id,
    on_held_tasks: { reassign_to: to },
  })

const hardware = (fx: Crowd) =>
  fx.t.run((ctx) =>
    ctx.db
      .query('teams')
      .withIndex('by_uuid', (q) => q.eq('id', fx.team.id))
      .unique(),
  )

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
  // followers hear from background steps (model/messages.ts FOLLOWER_FANOUT)
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`hands over ${LIMITS.reassign.max} tasks inside one transaction's limits`, async () => {
    const fx = await crowded(LIMITS.reassign.max)
    await removeEmil(fx, fx.leo.id)
    expect(await membership(fx)).toBeNull()
    // each task keeps its other holder, and Leo takes Emil's role
    expect(await holders(fx)).toEqual(
      fx.tasks.map((task) =>
        task.reviewer_id === fx.emil.id ? [task.assignee_id, fx.leo.id] : [fx.leo.id, null],
      ),
    )
  })

  it(`refuses ${LIMITS.reassign.max + 1} tasks for their number, and changes nothing`, async () => {
    const fx = await crowded(LIMITS.reassign.max + 1)
    const before = await holders(fx)
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(LIMITS.reassign.refusal)
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

  it(`deletes a team and hands over ${LIMITS.reassign.max} tasks inside one transaction's limits`, async () => {
    const fx = await crowded(LIMITS.reassign.max)
    await deleteHardware(fx, fx.leo.id)
    expect(await hardware(fx)).toBeNull()
    // Leo takes every role a Hardware member held
    const inHardware = new Set([
      fx.emil.id,
      ...fx.crowd.filter((_, i) => i % 2 === 0).map((p) => p.id),
    ])
    expect(await holders(fx)).toEqual(
      fx.tasks.map((task) => [
        inHardware.has(task.assignee_id ?? '') ? fx.leo.id : (task.assignee_id ?? null),
        task.reviewer_id === undefined ? null : fx.leo.id,
      ]),
    )
  })

  it(`refuses to delete a team over ${LIMITS.reassign.max} tasks, and changes nothing`, async () => {
    const fx = await crowded(LIMITS.reassign.max + 1)
    const before = await holders(fx)
    const e = await expectRefusal(deleteHardware(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(LIMITS.reassign.refusal)
    // the app quotes the sentence rather than blaming the tasks
    expect((e.data as Refusal).reason).toBeUndefined()
    expect(await hardware(fx)).not.toBeNull()
    expect(await membership(fx)).not.toBeNull()
    expect(await holders(fx)).toEqual(before)
  })

  it("keeps 600 members of a deleted team as Viewers inside one transaction's limits", async () => {
    // asked one at a time, each member's sight cost four index ranges before
    // the deletion and four after, 4,800 in all
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const members: string[] = []
    for (let from = 0; from < 600; from += 100) {
      await t.run(async (ctx) => {
        if (from === 0) {
          await ctx.db.insert('teams', {
            id: uuid(),
            org_id: f.org.id,
            name: 'Platform',
            track_delay_default: false,
            created_at: NOW,
          })
          await ctx.db.insert('project_team_access', {
            project_id: f.meta.id,
            team_id: f.team.id,
            level: 'user',
          })
        }
        for (let i = from; i < from + 100; i++) {
          const id = uuid()
          await ctx.db.insert('profiles', {
            id,
            org_id: f.org.id,
            name: `m${i}`,
            initials: 'MM',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            plannable_hours: 40,
            accepted_at: NOW,
            created_at: NOW,
          })
          await ctx.db.insert('team_members', {
            org_id: f.org.id,
            team_id: f.team.id,
            profile_id: id,
            is_leader: false,
          })
          await ctx.db.insert(
            'issues',
            await withParentKey(ctx, {
              id: uuid(),
              org_id: f.org.id,
              project_id: f.sub.id,
              num: 2000 + i,
              title: `Task ${i}`,
              description: '',
              status: 'todo',
              priority: 'medium',
              paused: false,
              assignee_id: id,
              created_at: NOW,
              updated_at: NOW,
            }),
          )
          members.push(id)
        }
      })
    }
    await as(t, f.admin).mutation(api.teams.deleteDeep, {
      org_id: f.org.id,
      id: f.team.id,
      on_held_tasks: 'keep_as_viewer',
    })
    const viewers = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
          .collect()
      ).filter((g) => g.level === 'viewer' && members.includes(g.profile_id)),
    )
    expect(viewers).toHaveLength(600)
  }, 60_000)

  it('removes a team grant past many grants that concern none of its holders', async () => {
    // 3,000 grants of other people on 30 other projects: the holders' sight
    // reads only their own grants, one index range each
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    const others: Doc<'projects'>[] = []
    for (let i = 0; i < 30; i++) others.push(await plantProject(t, { org_id: f.org.id }))
    const profile = (name: string) => ({
      id: uuid(),
      org_id: f.org.id,
      name,
      initials: 'PP',
      color: '#7a7ad0',
      org_role: 'user' as const,
      active: true,
      kind: 'person' as const,
      plannable_hours: 40,
      accepted_at: NOW,
      created_at: NOW,
    })
    const holders: string[] = []
    await t.run(async (ctx) => {
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'user',
      })
      for (let i = 0; i < 25; i++) {
        const member = profile(`h${i}`)
        await ctx.db.insert('profiles', member)
        await ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: member.id,
          org_id: member.org_id,
          is_leader: false,
        })
        holders.push(member.id)
      }
    })
    for (const assignee_id of holders)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id })
    for (let from = 0; from < 100; from += 25) {
      await t.run(async (ctx) => {
        for (let i = from; i < from + 25; i++) {
          const other = profile(`o${i}`)
          await ctx.db.insert('profiles', other)
          for (const project of others)
            await ctx.db.insert('project_access', {
              project_id: project.id,
              profile_id: other.id,
              level: 'viewer',
            })
        }
      })
    }
    const queries = await t.run(async (ctx) => {
      let count = 0
      const db = new Proxy(ctx.db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop)
          if (prop === 'query') {
            return (table: 'profiles') => {
              count++
              return target.query(table)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
      const people = await Promise.all(
        holders.map(async (id) => (await byId(ctx, 'profiles', id)) as Doc<'profiles'>),
      )
      await projectLevelsForPeople({ ...ctx, db } as QueryCtx, people, projects)
      return count
    })
    // the teams, each holder's grants, Hardware's members and its shares
    expect(queries).toBe(1 + holders.length + 1 + 1)
    const before = LEVELS_READ.max
    LEVELS_READ.max = 500
    try {
      await as(t, f.admin).mutation(api.projects.removeAccess, {
        org_id: f.org.id,
        id: f.meta.id,
        team_id: f.team.id,
        on_held_tasks: 'leave',
      })
    } finally {
      LEVELS_READ.max = before
    }
    const grant = await t.run((ctx) =>
      ctx.db
        .query('project_team_access')
        .withIndex('by_project_team', (q) => q.eq('project_id', f.meta.id).eq('team_id', f.team.id))
        .unique(),
    )
    expect(grant).toBeNull()
  }, 60_000)

  it('refuses a project grant removal above the cap too, keeping the grant', async () => {
    const fx = await crowded(LIMITS.reassign.max + 1)
    const e = await expectRefusal(
      as(fx.t, fx.user).mutation(api.projects.removeAccess, {
        org_id: fx.org.id,
        id: fx.meta.id,
        team_id: fx.team.id,
        on_held_tasks: { reassign_to: null },
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(LIMITS.reassign.refusal)
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
    const fx = await crowded(LIMITS.reassign.max + 1)
    // `user` still leads Hardware but no longer leads TBED, so cannot give
    // Viewer grants on it
    await fx.t.run((ctx) => ctx.db.patch(fx.meta._id, { lead_id: fx.admin.id }))
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(reassignTooLarge(false))
    expect(reassignTooLarge(false)).not.toMatch(/Viewer/)
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

  it('hands over tasks whose followers once filled the transaction, and tells them in steps', async () => {
    // 40 tasks with 21 followers each needed about 1,330 index ranges here
    // when the removal told every follower itself, past a limit of 1,000
    const fx = await crowded(40, {
      followers: 20,
      t: newT({ transactionLimits: { databaseQueries: 1000 } }),
    })
    await removeEmil(fx, fx.leo.id)
    expect(await membership(fx)).toBeNull()
    // no follower has heard yet; background steps tell them
    expect(await fx.t.run((ctx) => ctx.db.query('messages').collect())).toEqual([])
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    const follower = fx.crowd[1]
    expect((await messagesFor(fx.t, follower.id, fx.tasks[0].id)).map((m) => m.detail)).toEqual([
      'Assigned to Leo',
    ])
  })

  it('refuses a smaller handover that fills the transaction partway, and changes nothing', async () => {
    // under a limit of 350 index ranges, the room check stops 40 tasks
    // partway, after some were reassigned
    const fx = await crowded(40, { t: newT({ transactionLimits: { databaseQueries: 350 } }) })
    const before = await holders(fx)
    const e = await expectRefusal(removeEmil(fx, fx.leo.id), 'rule')
    expect((e.data as Refusal).message).toBe(LIMITS.reassign.refusal)
    expect((e.data as Refusal).reason).toBeUndefined()
    // the tasks reassigned before the check refused are rolled back too
    expect(await membership(fx)).not.toBeNull()
    expect(await holders(fx)).toEqual(before)
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await fx.t.run((ctx) => ctx.db.query('messages').collect())).toEqual([])
  })

  it('hands over a task with more followers than one step tells, whom steps within the limits tell', async () => {
    const fx = await crowded(20, { t: newT({ transactionLimits: { databaseQueries: 1000 } }) })
    // More people of Hardware than one background step tells follow only the
    // last task, so a full step runs inside a limit of 1,000 index ranges and
    // the next one takes over. No more: convex-test reads every stored
    // document for each index range, so this test's time grows with the
    // square of the count.
    const last = fx.tasks[fx.tasks.length - 1]
    const extra = await fx.t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < FOLLOWER_FANOUT.step + 100; i++) {
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
          org_id: fx.org.id,
          team_id: fx.team.id,
          profile_id: id,
          is_leader: false,
        })
        await ctx.db.insert('issue_subscriptions', {
          issue_id: last.id,
          profile_id: id,
          created_at: NOW,
        })
        ids.push(id)
      }
      return ids
    })
    const told = () =>
      fx.t.run(async (ctx) =>
        (
          await ctx.db
            .query('messages')
            .withIndex('by_issue_read', (q) => q.eq('issue_id', last.id))
            .collect()
        ).map((m) => m.recipient_id),
      )
    await removeEmil(fx, fx.leo.id)
    expect(await membership(fx)).toBeNull()
    // the removal tells none of them itself
    expect(await told()).toEqual([])
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    const heard = await told()
    // each of them once, with the task's other followers and Leo
    expect(heard.filter((id) => extra.includes(id)).sort()).toEqual([...extra].sort())
    expect(new Set(heard).size).toBe(heard.length)
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
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
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
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
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

/* withOrg with `n` more members of Hardware, which shares TBED at User, each
 * assigned to one open task in Firmware, beside a second team, Platform.
 * Under `limits` the deployment's limits apply. */
async function manyHolders(n: number, limits: Parameters<typeof newT>[0] = {}) {
  const t = newT({ transactionLimits: true, ...limits })
  const f = await withOrg(t)
  for (let from = 0; from < n; from += 100) {
    await t.run(async (ctx) => {
      if (from === 0) {
        await ctx.db.insert('teams', {
          id: uuid(),
          org_id: f.org.id,
          name: 'Platform',
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('project_team_access', {
          project_id: f.meta.id,
          team_id: f.team.id,
          level: 'user',
        })
      }
      for (let i = from; i < Math.min(n, from + 100); i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `m${i}`,
          initials: 'MM',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          accepted_at: NOW,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          org_id: f.org.id,
          team_id: f.team.id,
          profile_id: id,
          is_leader: false,
        })
        await ctx.db.insert(
          'issues',
          await withParentKey(ctx, {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 2000 + i,
            title: `Task ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            assignee_id: id,
            created_at: NOW,
            updated_at: NOW,
          }),
        )
      }
    })
  }
  const admin = { callerId: f.admin.id, access: 'write' as const }
  const state = () =>
    t.run(async (ctx) => ({
      share: await ctx.db
        .query('project_team_access')
        .withIndex('by_project_team', (q) => q.eq('project_id', f.meta.id).eq('team_id', f.team.id))
        .unique(),
      viewers: (
        await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
          .collect()
      ).filter((g) => g.level === 'viewer').length,
      team: await byId(ctx, 'teams', f.team.id),
    }))
  return { t, f, admin, state }
}

describe('a removal of many people', () => {
  it(`takes access from ${LIMITS.removalHolders.max} people with open tasks inside one transaction's limits, the costliest way`, async () => {
    const { t, f, state } = await manyHolders(LIMITS.removalHolders.max)
    // each holder's teams read one at a time, as in an organization with
    // more than LEVELS_READ memberships, and a Viewer grant each: five index
    // ranges a holder
    const before = LEVELS_READ.max
    LEVELS_READ.max = 0
    try {
      await as(t, f.admin).mutation(api.projects.removeAccess, {
        org_id: f.org.id,
        id: f.meta.id,
        team_id: f.team.id,
        on_held_tasks: 'keep_as_viewer',
      })
    } finally {
      LEVELS_READ.max = before
    }
    expect(await state()).toMatchObject({ share: null, viewers: LIMITS.removalHolders.max })
  }, 120_000)

  it(`refuses to settle the tasks of ${LIMITS.removalHolders.max + 1} people in the app, REST and MCP, and changes nothing, but leaves them`, async () => {
    const { t, f, admin, state } = await manyHolders(LIMITS.removalHolders.max + 1)
    const refusals = [
      as(t, f.admin).mutation(api.teams.deleteDeep, {
        org_id: f.org.id,
        id: f.team.id,
        on_held_tasks: 'keep_as_viewer',
      }),
      t.mutation(internal.machine.projects.restRemoveTeamAccess, {
        ...admin,
        keyName: null,
        ref: 'TBED',
        subject: f.team.id,
        body: JSON.stringify({ on_held_tasks: 'keep_as_viewer' }),
      }),
      t.mutation(internal.machine.projects.mcpSetProjectAccess, {
        ...admin,
        project: 'TBED',
        team_id: f.team.id,
        level: null,
        on_held_tasks: { reassign_to: null },
      }),
    ]
    for (const refusal of refusals) {
      const e = await expectRefusal(refusal, 'rule')
      expect((e.data as Refusal).message).toBe(LIMITS.removalHolders.refusal)
    }
    expect(await state()).toMatchObject({ share: { level: 'user' }, viewers: 0 })
    expect((await state()).team).not.toBeNull()
    // leaving the tasks reads less, so only the room bounds it
    const left = await t.mutation(internal.machine.projects.restRemoveTeamAccess, {
      ...admin,
      keyName: null,
      ref: 'TBED',
      subject: f.team.id,
      body: '',
    })
    expect(left.stranded).toHaveLength(LIMITS.removalHolders.max + 1)
    expect((await state()).share).toBeNull()
  }, 120_000)

  it('refuses fewer people whose sight would fill the transaction, before a read passes the limit', async () => {
    // 200 holders cost about 400 index ranges to work out who loses sight,
    // past a limit of 300
    const { t, f, admin, state } = await manyHolders(200, {
      transactionLimits: { databaseQueries: 300 },
    })
    const e = await expectRefusal(
      t.mutation(internal.machine.projects.restRemoveTeamAccess, {
        ...admin,
        keyName: null,
        ref: 'TBED',
        subject: f.team.id,
        body: '',
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(REMOVAL_FULL)
    expect((await state()).share).toMatchObject({ level: 'user' })
  }, 60_000)

  it('refuses before the scan for held tasks reads past the documents left', async () => {
    // 2,500 open tasks nobody in the team holds, under a limit of 2,000 documents
    const { t, f, admin, state } = await manyHolders(5, {
      transactionLimits: { documentsRead: 2000 },
    })
    for (let from = 0; from < 2500; from += 500)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 500; i++)
          await ctx.db.insert(
            'issues',
            await withParentKey(ctx, {
              id: uuid(),
              org_id: f.org.id,
              project_id: f.sub2.id,
              num: 9000 + i,
              title: `Other ${i}`,
              description: '',
              status: 'todo',
              priority: 'medium',
              paused: false,
              assignee_id: f.viewer.id,
              created_at: NOW,
              updated_at: NOW,
            }),
          )
      })
    const e = await expectRefusal(
      t.mutation(internal.machine.projects.restRemoveTeamAccess, {
        ...admin,
        keyName: null,
        ref: 'TBED',
        subject: f.team.id,
        body: '',
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(REMOVAL_FULL)
    expect((await state()).share).toMatchObject({ level: 'user' })
  }, 60_000)

  it("refuses before a team's shares read past the index ranges left", async () => {
    // 300 shared projects cost two ranges each to reach, past a limit of 500
    const { t, f, state } = await manyHolders(5, { transactionLimits: { databaseQueries: 500 } })
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'meta',
          key: `S${i}`,
          name: `Shared ${i}`,
          description: '',
          sort_order: 100 + i,
          num: 100 + i,
          track_delay: false,
          created_at: NOW,
        })
        await ctx.db.insert('project_team_access', {
          project_id: id,
          team_id: f.team.id,
          level: 'viewer',
        })
      }
    })
    const e = await expectRefusal(
      as(t, f.admin).mutation(api.teams.deleteDeep, {
        org_id: f.org.id,
        id: f.team.id,
        on_held_tasks: 'keep_as_viewer',
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(REMOVAL_FULL)
    expect((await state()).team).not.toBeNull()
  }, 60_000)

  it("refuses before one team's memberships read past the documents left", async () => {
    // under a limit of 12,000 documents the removal keeps 600 in reserve, and
    // a third team's 12,000 memberships would pass it in one read
    const { t, f, admin, state } = await manyHolders(30, {
      transactionLimits: { documentsRead: 12_000 },
    })
    await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name: 'Crowd',
        track_delay_default: false,
        created_at: NOW,
      })
      for (let i = 0; i < 12_000; i++)
        await ctx.db.insert('team_members', {
          org_id: f.org.id,
          team_id: id,
          profile_id: uuid(),
          is_leader: false,
        })
    })
    const before = LEVELS_READ.max
    LEVELS_READ.max = 20_000
    try {
      const e = await expectRefusal(
        t.mutation(internal.machine.projects.restRemoveTeamAccess, {
          ...admin,
          keyName: null,
          ref: 'TBED',
          subject: f.team.id,
          body: '',
        }),
        'rule',
      )
      expect((e.data as Refusal).message).toBe(REMOVAL_FULL)
    } finally {
      LEVELS_READ.max = before
    }
    expect((await state()).share).toMatchObject({ level: 'user' })
  }, 120_000)
})

describe('working out sight for a removal', () => {
  it("checks the room every 500 rows of one person's grants, not only before them", async () => {
    const t = newT()
    const f = await withOrg(t)
    // the read counts rows, so 1,200 grant rows on one project will do
    await t.run(async (ctx) => {
      for (let i = 0; i < 1200; i++)
        await ctx.db.insert('project_access', {
          project_id: f.hidden.id,
          profile_id: f.agent.id,
          level: 'viewer',
        })
    })
    const checks = await t.run(async (ctx) => {
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
      let n = 0
      await projectLevelsForPeople(ctx, [f.agent], projects, async () => {
        n++
      })
      return n
    })
    // before the grants, after 500 and 1,000 of them, and before memberships
    expect(checks).toBe(4)
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
        ? { preload: newNotifyPreload(), checked: new Set() }
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
    expect(messages).toContain(
      '4 Olga: Assigned to Leo. Attached under a task in another sub-project',
    )
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
          preload: newNotifyPreload(),
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
  // the archived subtasks leave in background steps
  // (model/deletedItems.ts detachArchivedChildren)
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`detaches ${LIMITS.subtasks.max} active subtasks inside one transaction and 200 archived ones after, and tells their followers from steps`, async () => {
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
      for (let i = 0; i < LIMITS.subtasks.max + 200; i++) {
        const id = uuid()
        await ctx.db.insert(
          'issues',
          await withParentKey(ctx, {
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
            // past the active ones, archived subtasks have no bound
            ...(i < LIMITS.subtasks.max ? {} : { archived_at: NOW }),
            created_at: NOW,
            updated_at: NOW,
          }),
        )
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
    const subtaskRows = () =>
      fx.t.run((ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', fx.sub.id))
          .collect(),
      )
    await as(fx.t, fx.user).mutation(api.issues.deleteDeep, { org_id: fx.org.id, id: parent.id })
    // the delete's own transaction detaches the active ones
    const detached = (await subtaskRows()).filter((r) => r.parent_id === undefined)
    expect(detached.map((r) => r.id).sort()).toEqual(kids.slice(0, LIMITS.subtasks.max).sort())
    // and leaves every follower to background steps
    expect(await fx.t.run((ctx) => ctx.db.query('messages').collect())).toEqual([])
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await subtaskRows()).filter((r) => r.parent_id === undefined)).toHaveLength(
      LIMITS.subtasks.max + 200,
    )
    const messages = await fx.t.run((ctx) => ctx.db.query('messages').collect())
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
  }, 120_000)
})
