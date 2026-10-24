/* Roadmap saves and undo that change many tasks in one transaction
 * (roadmap.ts change and undo). Auto-arrange sends every pending move in one
 * save, and undo of the whole visit replays every save in one undo. One
 * preload per organization (model/issues.ts BulkUpdate) serves every task
 * write, and the tasks' followers hear from background steps
 * (model/messages.ts NotifyPreload.deferFollowers), so a save's cost does not
 * grow with its followers. They stay inside Convex's limits for one
 * transaction up to the measured size below, and refuse a save or undo that
 * would fill it (ROADMAP_ROOM) with a plain sentence instead of an internal
 * error.
 *
 * convex-test enforces the deployment's limits with transactionLimits: true
 * and counts every index range a function reads, where a deployment counts a
 * range it already read once, so these counts are an upper bound. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal } from '../lib/functions'
import { emitTaskEvent } from '../model/taskEvents'
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
  withParentKey,
} from './helpers.setup'

/* The people the crowd adds to withOrg's five, for an organization of 100. */
const CROWD = 95

type Roadmap = OrgFixture & { t: T; tasks: Doc<'issues'>[] }

/* withOrg grown to 100 profiles. Hardware (led by `user`) and a second team,
 * Platform, each hold User on TBED, and the crowd is split between them, so
 * every person sees TBED only through a team grant. `n` open tasks in
 * Firmware without dates are each followed by `followers` of the crowd. */
async function planted(
  n: number,
  followers: number,
  t: T = newT({ transactionLimits: true }),
): Promise<Roadmap> {
  const f = await withOrg(t)
  const crowd = await t.run(async (ctx) => {
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
        org_id: f.org.id,
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
          const _id = await ctx.db.insert(
            'issues',
            await withParentKey(ctx, {
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
            }),
          )
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
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules 120 followed tasks in one save and undoes the visit in one undo', async () => {
    // Without the preload, this save passed the limit of 4,096 index ranges
    // at the 76th task
    const fx = await planted(120, 4)
    const session_id = uuid()
    expect(await scheduleAll(fx, session_id, '2026-01-05')).toEqual({ count: 1 })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => '2026-01-05'))
    // every follower hears of the new dates, from background steps; only
    // those due now run, so the visit's history stays
    expect(await messageCount(fx)).toBe(0)
    await fx.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0))
    expect(await messageCount(fx)).toBe(120 * 4)
    expect(await scheduleAll(fx, session_id, '2026-02-02')).toEqual({ count: 2 })
    expect(await as(fx.t, fx.user).mutation(api.roadmap.undo, { session_id, all: true })).toEqual({
      count: 0,
    })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => null))
  }, 120_000)

  it('saves tasks whose followers once filled the transaction, and tells them in steps', async () => {
    // Under a limit of 1,500 index ranges, telling 60 tasks' 20 followers
    // each in the save filled it, and ROADMAP_ROOM refused the save
    const fx = await planted(60, 20, newT({ transactionLimits: { databaseQueries: 1500 } }))
    expect(await scheduleAll(fx, uuid(), '2026-01-05')).toEqual({ count: 1 })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => '2026-01-05'))
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await messageCount(fx)).toBe(60 * 20)
  }, 120_000)

  it('refuses a save too large for one transaction, and changes nothing', async () => {
    // Under a limit of 400 index ranges, a save of 60 tasks passes it
    // without the room check, with an internal error
    const fx = await planted(60, 3, newT({ transactionLimits: { databaseQueries: 400 } }))
    const e = await expectRefusal(scheduleAll(fx, uuid(), '2026-01-05'), 'rule')
    expect((e.data as Refusal).message).toBe(ROADMAP_CHANGE_TOO_LARGE)
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => null))
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await messageCount(fx)).toBe(0)
  }, 120_000)

  it('refuses an undo of the whole visit too large for one transaction, and keeps its history', async () => {
    // Without the room check, this undo passes a limit of 800 index ranges
    // with an internal error
    const fx = await planted(180, 0, newT({ transactionLimits: { databaseQueries: 800 } }))
    const session_id = uuid()
    // three saves of a third of the tasks each fit, and undoing all at once does not
    const thirds = [fx.tasks.slice(0, 60), fx.tasks.slice(60, 120), fx.tasks.slice(120)]
    for (const third of thirds)
      await as(fx.t, fx.user).mutation(api.roadmap.change, {
        session_id,
        operations: third.map((task) => ({
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
    for (const count of [2, 1, 0])
      expect(
        await as(fx.t, fx.user).mutation(api.roadmap.undo, { session_id, all: false }),
      ).toEqual({ count })
    expect(await startWeeks(fx)).toEqual(fx.tasks.map(() => null))
  }, 240_000)

  it("checks the room before each webhook subscription's sight check", async () => {
    const fx = await planted(1, 0)
    await fx.t.run(async (ctx) => {
      for (let n = 0; n < 3; n++) {
        const profile_id = uuid()
        await ctx.db.insert('profiles', {
          id: profile_id,
          org_id: fx.org.id,
          name: `Agent ${n}`,
          initials: 'AG',
          color: '#50b070',
          org_role: 'user',
          active: true,
          kind: 'agent',
          created_at: NOW,
        })
        await ctx.db.insert('project_access', {
          project_id: fx.meta.id,
          profile_id,
          level: 'viewer',
        })
        const credential_id = uuid()
        const credential_row_id = await ctx.db.insert('agent_keys', {
          id: credential_id,
          profile_id,
          name: 'Roadmap events',
          key_prefix: 'qva_1...1111',
          key_hash: uuid(),
          created_at: NOW,
        })
        await ctx.db.insert('webhook_subscriptions', {
          id: uuid(),
          org_id: fx.org.id,
          owner: { profile_id, credential_table: 'agent_keys', credential_id, credential_row_id },
          name: 'task.updated',
          filters: {},
          url: `https://receiver.example/${n}`,
          encrypted_secret: 'test-only',
          created_at: Date.now(),
        })
      }
    })
    const [before] = fx.tasks
    const after = { ...before, start_week: '2026-01-05', end_week: '2026-01-05' }
    const event = { name: 'task.updated' as const, issue: after, before, now: NOW }
    // each subscription is checked after the guard
    let checks = 0
    await fx.t.run((ctx) => emitTaskEvent(ctx, { ...event, guard: async () => void checks++ }))
    expect(checks).toBe(3)
    // a guard that refuses stops the event before any sight check
    const full = new Error('full')
    await expect(
      fx.t.run((ctx) =>
        emitTaskEvent(ctx, {
          ...event,
          guard: async () => {
            throw full
          },
        }),
      ),
    ).rejects.toThrow('full')
  })

  it('tells each follower apart by access when it answers many at once', async () => {
    const fx = await planted(1, 0)
    const [task] = fx.tasks
    // sixteen followers, every other one without access to the project, so
    // both the first answers, one by one, and the batched rest meet some
    const followers = await fx.t.run(async (ctx) => {
      const out: { id: string; sees: boolean }[] = []
      for (let n = 0; n < 16; n++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: fx.org.id,
          name: `Follower ${n}`,
          initials: 'FF',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          accepted_at: NOW,
          created_at: NOW,
        })
        const sees = n % 2 === 0
        if (sees)
          await ctx.db.insert('team_members', {
            org_id: fx.org.id,
            team_id: fx.team.id,
            profile_id: id,
            is_leader: false,
          })
        await ctx.db.insert('issue_subscriptions', {
          issue_id: task.id,
          profile_id: id,
          created_at: NOW,
        })
        out.push({ id, sees })
      }
      return out
    })
    await scheduleAll(fx, uuid(), '2026-01-05')
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    const told = await fx.t.run(async (ctx) =>
      (await ctx.db.query('messages').collect()).map((m) => m.recipient_id),
    )
    expect(told.sort()).toEqual(
      followers
        .filter((f) => f.sees)
        .map((f) => f.id)
        .sort(),
    )
  })
})
