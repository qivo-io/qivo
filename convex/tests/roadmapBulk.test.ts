/* Roadmap saves and undo that change many tasks in one transaction
 * (roadmap.ts change and undo). Auto-arrange sends every pending move in one
 * save, and undo of the whole visit replays every save in one undo. Each task
 * write notifies the task's followers, and without one preload per
 * organization (model/issues.ts BulkUpdate) each read every profile of the
 * organization and checked each follower's sight again. They stay inside
 * Convex's limits for one transaction up to the measured size below, and
 * refuse a save or undo whose followers would fill it (ROADMAP_ROOM) with a
 * plain sentence instead of an internal error.
 *
 * convex-test enforces the deployment's limits with transactionLimits: true
 * and counts every index range a function reads, where a deployment counts a
 * range it already read once, so these counts are an upper bound. */
import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal } from '../lib/functions'
import { ROADMAP_CHANGE_TOO_LARGE, ROADMAP_UNDO_TOO_LARGE } from '../roadmap'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* The people the crowd adds to withOrg's five, for an organization of 100. */
const CROWD = 95

type Roadmap = OrgFixture & { t: T; tasks: Doc<'issues'>[] }

/* withOrg grown to 100 profiles. Hardware (led by `user`) and a second team,
 * Platform, each hold User on TBED, and the crowd is split between them, so
 * every person sees TBED only through a team grant. `n` open tasks in
 * Firmware without dates are each followed by `followers` of the crowd. */
async function planted(n: number, followers: number): Promise<Roadmap> {
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const crowd = await t.run(async (ctx) => {
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
    const out: string[] = []
    for (let i = 0; i < CROWD; i++) {
      const id = uuid()
      await ctx.db.insert('profiles', {
        id,
        org_id: f.org.id,
        name: `p${i}`,
        initials: 'PP',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        accepted_at: NOW,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: i % 2 ? platform : f.team.id,
        profile_id: id,
        is_leader: false,
      })
      out.push(id)
    }
    return out
  })
  const tasks: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += 100) {
    tasks.push(
      ...(await t.run(async (ctx) => {
        const out: Doc<'issues'>[] = []
        for (let i = from; i < Math.min(n, from + 100); i++) {
          const _id = await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 1000 + i,
            title: `Task ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            assignee_id: crowd[i % CROWD],
            created_at: NOW,
            updated_at: NOW,
          })
          for (let k = 0; k < followers; k++)
            await ctx.db.insert('issue_subscriptions', {
              issue_id: (await ctx.db.get(_id))?.id as string,
              profile_id: crowd[(i * followers + k + 1) % CROWD],
              created_at: NOW,
            })
          out.push((await ctx.db.get(_id)) as Doc<'issues'>)
        }
        return out
      })),
    )
  }
  return { ...f, t, tasks }
}

/* One save that schedules every planted task in `week`, as auto-arrange
 * sends its moves. */
const scheduleAll = (fx: Roadmap, session_id: string, week: string) =>
  as(fx.t, fx.user).mutation(api.roadmap.change, {
    session_id,
    operations: fx.tasks.map((task) => ({
      kind: 'task' as const,
      id: task.id,
      patch: { start_week: week, end_week: week },
    })),
  })

const startWeeks = (fx: Roadmap) =>
  fx.t.run(async (ctx) => {
    const out: (string | null)[] = []
    for (const task of fx.tasks) out.push((await ctx.db.get(task._id))?.start_week ?? null)
    return out
  })

const messageCount = (fx: Roadmap) =>
  fx.t.run(async (ctx) => (await ctx.db.query('messages').collect()).length)

describe('roadmap saves and undo of many tasks', () => {
  it('schedules 120 followed tasks in one save and undoes the visit in one undo', async () => {
    // Without the preload, this save passed the limit of 4,096 index ranges
    // at the 76th task
    const fx = await planted(120, 4)
    const session_id = uuid()
    expect(await scheduleAll(fx, session_id, '2026-01-05')).toEqual({ count: 1 })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => '2026-01-05'))
    // every follower hears of the new dates
    const saved = await messageCount(fx)
    expect(saved).toBe(120 * 4)
    expect(await scheduleAll(fx, session_id, '2026-02-02')).toEqual({ count: 2 })
    expect(await as(fx.t, fx.user).mutation(api.roadmap.undo, { session_id, all: true })).toEqual({
      count: 0,
    })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => null))
  }, 120_000)

  it('refuses a save whose followers would fill the transaction, and changes nothing', async () => {
    // Without the room check, this save passes the limit of 4,096 index
    // ranges with an internal error
    const fx = await planted(120, 20)
    const e = await expectRefusal(scheduleAll(fx, uuid(), '2026-01-05'), 'rule')
    expect((e.data as Refusal).message).toBe(ROADMAP_CHANGE_TOO_LARGE)
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => null))
    expect(await messageCount(fx)).toBe(0)
  }, 120_000)

  it('refuses an undo of the whole visit too large for one transaction, and keeps its history', async () => {
    // Without the room check, this undo passes the limit of 4,096 index
    // ranges with an internal error
    const fx = await planted(130, 20)
    const session_id = uuid()
    // two saves of half the tasks each fit, and undoing both at once does not
    const halves = [fx.tasks.slice(0, 65), fx.tasks.slice(65)]
    for (const half of halves)
      await as(fx.t, fx.user).mutation(api.roadmap.change, {
        session_id,
        operations: half.map((task) => ({
          kind: 'task' as const,
          id: task.id,
          patch: { start_week: '2026-01-05', end_week: '2026-01-05' },
        })),
      })
    const e = await expectRefusal(
      as(fx.t, fx.user).mutation(api.roadmap.undo, { session_id, all: true }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(ROADMAP_UNDO_TOO_LARGE)
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => '2026-01-05'))
    // one step at a time still undoes the visit
    for (const count of [1, 0])
      expect(
        await as(fx.t, fx.user).mutation(api.roadmap.undo, { session_id, all: false }),
      ).toEqual({ count })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => null))
  }, 240_000)
})
