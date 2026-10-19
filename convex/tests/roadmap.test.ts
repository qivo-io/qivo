import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import { byId } from '../lib/db'
import { GROUP_DATES_RULE } from '../model/issues'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const schedule = (id: string, start: string, end = start) => ({
  kind: 'task' as const,
  id,
  patch: { start_week: start, end_week: end },
})
const task = (t: T, id: string) => t.run((ctx) => byId(ctx, 'issues', id))
const milestone = (t: T, id: string) => t.run((ctx) => byId(ctx, 'milestones', id))
const rows = (t: T) => t.run((ctx) => ctx.db.query('roadmap_history').collect())

afterEach(() => vi.useRealTimers())

describe('roadmap visit undo', () => {
  it('undoes one atomic batch or the entire visit, including originally absent dates', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    expect(
      await user.mutation(api.roadmap.change, {
        session_id,
        operations: [schedule(a.id, '2026-01-05')],
      }),
    ).toEqual({ count: 1 })
    expect(
      await user.mutation(api.roadmap.change, {
        session_id,
        operations: [schedule(a.id, '2026-01-12'), schedule(b.id, '2026-02-02')],
      }),
    ).toEqual({ count: 2 })
    expect(await user.mutation(api.roadmap.undo, { session_id, all: false })).toEqual({ count: 1 })
    expect((await task(t, a.id))?.start_week).toBe('2026-01-05')
    expect((await task(t, b.id))?.start_week).toBeUndefined()
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(b.id, '2026-02-09')],
    })
    expect(await user.mutation(api.roadmap.undo, { session_id, all: true })).toEqual({ count: 0 })
    expect((await task(t, a.id))?.start_week).toBeUndefined()
    expect((await task(t, b.id))?.start_week).toBeUndefined()
    expect(await rows(t)).toEqual([])
  })

  it('restores exact estimate measurement time and preserves independent task edits', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      remaining_hours: 12,
      remaining_set_at: NOW,
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ kind: 'task', id: a.id, patch: { remaining_hours: 6 } }],
    })
    expect((await task(t, a.id))?.remaining_set_at).not.toBe(NOW)
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: a.id,
      patch: { title: 'An independent edit', priority: 'high' },
    })
    await user.mutation(api.roadmap.undo, { session_id, all: true })
    expect(await task(t, a.id)).toMatchObject({
      remaining_hours: 12,
      remaining_set_at: NOW,
      title: 'An independent edit',
      priority: 'high',
    })
  })

  it('refuses a newer estimate measurement even when the amount returns to the recorded value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      remaining_hours: 12,
      remaining_set_at: NOW,
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ kind: 'task', id: a.id, patch: { remaining_hours: 6 } }],
    })
    vi.setSystemTime('2026-01-02T00:00:00.000Z')
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: a.id,
      patch: { remaining_hours: 8 },
    })
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: a.id,
      patch: { remaining_hours: 6 },
    })
    await expectRefusal(user.mutation(api.roadmap.undo, { session_id, all: false }), 'conflict')
    expect((await task(t, a.id))?.remaining_hours).toBe(6)
  })

  it('journals and writes only the task an operation names, never its ancestors', async () => {
    const t = newT(),
      f = await withOrg(t),
      guest = as(t, f.guest),
      session_id = uuid()
    // the middle task sits in a project the guest cannot see
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const narrow = { start_week: '2026-01-05', end_week: '2026-01-12' }
    const ancestor = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...narrow })
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      parent_id: ancestor.id,
      ...narrow,
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
      start_week: '2026-01-05',
      end_week: '2026-01-05',
    })
    await guest.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(child.id, '2026-02-02')],
    })
    const changes = JSON.parse((await rows(t))[0].changes) as { id: string }[]
    expect(changes.map((change) => change.id)).toEqual([child.id])
    expect(changes[0]).not.toHaveProperty('authorities')
    for (const row of [ancestor, parent]) expect(await task(t, row.id)).toEqual(row)
    await guest.mutation(api.roadmap.undo, { session_id, all: false })
    expect(await task(t, child.id)).toMatchObject({
      start_week: '2026-01-05',
      end_week: '2026-01-05',
    })
    for (const row of [ancestor, parent]) expect(await task(t, row.id)).toEqual(row)
  })

  it('refuses external schedule conflicts and leaves the whole revert-all transaction intact', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(a.id, '2026-01-05')],
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(b.id, '2026-01-12')],
    })
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: a.id,
      patch: { start_week: '2026-01-19', end_week: '2026-01-19' },
    })
    await expectRefusal(
      user.mutation(api.roadmap.undo, { session_id, all: true }),
      'conflict',
      /edited elsewhere/,
    )
    expect((await task(t, a.id))?.start_week).toBe('2026-01-19')
    expect((await task(t, b.id))?.start_week).toBe('2026-01-12')
    expect(await rows(t)).toHaveLength(2)
  })

  it.each(['gained a subtask', 'moved project'] as const)(
    'refuses to undo a task that has since %s and leaves it as it is',
    async (condition) => {
      const t = newT(),
        f = await withOrg(t),
        user = as(t, f.user),
        session_id = uuid()
      const leaf = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        start_week: '2026-01-05',
        end_week: '2026-01-05',
      })
      await user.mutation(api.roadmap.change, {
        session_id,
        operations: [schedule(leaf.id, '2026-02-02')],
      })
      if (condition === 'gained a subtask') {
        // the leaf is now a group, whose dates come from its subtasks
        const kid = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
        await as(t, f.admin).mutation(api.issues.update, {
          org_id: f.org.id,
          id: kid.id,
          patch: { parent_id: leaf.id },
        })
      } else {
        await as(t, f.admin).mutation(api.issues.move, {
          org_id: f.org.id,
          id: leaf.id,
          project_id: f.sub2.id,
        })
      }
      await expectRefusal(
        user.mutation(api.roadmap.undo, { session_id, all: true }),
        'conflict',
        /edited elsewhere/,
      )
      expect((await task(t, leaf.id))?.start_week).toBe('2026-02-02')
      expect(await rows(t)).toHaveLength(1)
    },
  )

  it('expires a receipt written while child edits still widened their ancestors', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(a.id, '2026-01-05')],
    })
    // in that era every task change carried `authorities`
    await t.run(async (ctx) => {
      const entry = (await ctx.db.query('roadmap_history').collect())[0]
      const changes = JSON.parse(entry.changes) as Record<string, unknown>[]
      for (const change of changes) change.authorities = [{ id: a.id, path: [] }]
      await ctx.db.patch(entry._id, { changes: JSON.stringify(changes) })
    })
    await expectRefusal(
      user.mutation(api.roadmap.undo, { session_id, all: true }),
      'conflict',
      /expired/,
    )
    expect((await task(t, a.id))?.start_week).toBe('2026-01-05')
    expect(await rows(t)).toHaveLength(1)
  })

  it('undoes milestone creation, edits and deletion and retains unrelated milestone edits', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid(),
      id = uuid()
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [
        { kind: 'milestone_create', id, project_id: f.meta.id, name: 'Launch', week: '2026-01-05' },
      ],
    })
    const original = await milestone(t, id)
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ kind: 'milestone_update', id, patch: { week: '2026-02-02' } }],
    })
    await as(t, f.admin).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Launch candidate' },
    })
    await user.mutation(api.roadmap.undo, { session_id, all: false })
    expect(await milestone(t, id)).toMatchObject({ name: 'Launch candidate', week: '2026-01-05' })
    // Undoing creation would delete someone else's rename, so it refuses.
    await expectRefusal(user.mutation(api.roadmap.undo, { session_id, all: false }), 'conflict')
    await as(t, f.admin).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Launch' },
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ kind: 'milestone_remove', id }],
    })
    expect(await milestone(t, id)).toBeNull()
    await user.mutation(api.roadmap.undo, { session_id, all: false })
    expect(await milestone(t, id)).toMatchObject({
      name: 'Launch',
      week: '2026-01-05',
      created_at: original?.created_at,
    })
    await user.mutation(api.roadmap.undo, { session_id, all: true })
    expect(await milestone(t, id)).toBeNull()
  })

  it('stores a milestone created against a sub-project on its top-level project', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid(),
      id = uuid()
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [
        { kind: 'milestone_create', id, project_id: f.sub.id, name: 'Launch', week: '2026-01-05' },
      ],
    })
    expect(await milestone(t, id)).toMatchObject({ project_id: f.meta.id })
    await user.mutation(api.roadmap.undo, { session_id, all: false })
    expect(await milestone(t, id)).toBeNull()
  })

  it('refuses milestones without top-level write access or a real calendar day', async () => {
    const t = newT(),
      f = await withOrg(t),
      session_id = uuid()
    const subOnly = await plantSeat(t, {
      org_id: f.org.id,
      name: 'sub only',
      auth_user_id: 'auth_sub_only',
      accepted_at: NOW,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subOnly.id,
        level: 'user',
      }),
    )
    const create = (project_id: string, week = '2026-01-05') => ({
      kind: 'milestone_create' as const,
      id: uuid(),
      project_id,
      name: 'Launch',
      week,
    })
    // a sub-project grant shows the parent read-only
    await expectRefusal(
      as(t, subOnly).mutation(api.roadmap.change, { session_id, operations: [create(f.sub.id)] }),
      'forbidden',
      /^no write access to this project$/,
    )
    // a sibling the seat cannot see and another organization's project stay not found
    for (const project_id of [f.sub2.id, f.otherProject.id])
      await expectRefusal(
        as(t, subOnly).mutation(api.roadmap.change, {
          session_id,
          operations: [create(project_id)],
        }),
        'not_found',
        /^project not found$/,
      )
    const user = as(t, f.user)
    // an archived sub-project, or an active one under an archived top-level project
    for (const archived of [f.sub, f.meta]) {
      await t.run((ctx) => ctx.db.patch(archived._id, { archived_at: '2026-01-02T00:00:00.000Z' }))
      await expectRefusal(
        user.mutation(api.roadmap.change, { session_id, operations: [create(f.sub.id)] }),
        'rule',
        /^that project is archived, so restore it first$/,
      )
      await t.run((ctx) => ctx.db.patch(archived._id, { archived_at: undefined }))
    }
    for (const week of ['2026-02-31', '2026-13-01'])
      await expectRefusal(
        user.mutation(api.roadmap.change, { session_id, operations: [create(f.meta.id, week)] }),
        'bad_request',
        /^a milestone week must be a valid calendar date$/,
      )
    await expectRefusal(
      user.mutation(api.roadmap.change, { session_id, operations: [create(f.meta.id, 'garbage')] }),
      'bad_request',
      /^a milestone week is an ISO date \(YYYY-MM-DD\)$/,
    )
    const id = uuid()
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ ...create(f.meta.id), id }],
    })
    await expectRefusal(
      user.mutation(api.roadmap.change, {
        session_id,
        operations: [{ kind: 'milestone_update', id, patch: { week: '2026-02-30' } }],
      }),
      'bad_request',
      /^a milestone week must be a valid calendar date$/,
    )
    expect(await milestone(t, id)).toMatchObject({ week: '2026-01-05' })
    expect(await t.run((ctx) => ctx.db.query('milestones').collect())).toHaveLength(1)
  })

  it('reads milestones the caller cannot see as not found on update and remove', async () => {
    const t = newT(),
      f = await withOrg(t),
      session_id = uuid()
    const plant = async (project_id: string) => {
      const id = uuid()
      await t.run((ctx) =>
        ctx.db.insert('milestones', {
          id,
          project_id,
          name: 'Launch',
          week: '2026-01-05',
          created_at: NOW,
        }),
      )
      return id
    }
    const hidden = await plant(f.hidden.id)
    const foreign = await plant(f.otherProject.id)
    const shown = await plant(f.meta.id)
    const viewer = as(t, f.viewer)
    const ops = (id: string) => [
      { kind: 'milestone_update' as const, id, patch: { name: 'Renamed' } },
      { kind: 'milestone_remove' as const, id },
    ]
    for (const id of [hidden, foreign, uuid()])
      for (const op of ops(id))
        await expectRefusal(
          viewer.mutation(api.roadmap.change, { session_id, operations: [op] }),
          'not_found',
          /^milestone not found$/,
        )
    for (const op of ops(shown))
      await expectRefusal(
        viewer.mutation(api.roadmap.change, { session_id, operations: [op] }),
        'forbidden',
        /^no write access to this project$/,
      )
    for (const id of [hidden, foreign, shown])
      expect(await milestone(t, id)).toMatchObject({ name: 'Launch' })
  })

  it('isolates journal ownership and rechecks current access on undo', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(a.id, '2026-01-05')],
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.roadmap.undo, { session_id, all: true }),
      'conflict',
      /expired/,
    )
    expect(await rows(t)).toHaveLength(1)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.user.id,
        level: 'user',
      })
      await ctx.db.patch(f.user._id, { org_role: 'viewer' })
    })
    await expectRefusal(
      user.mutation(api.roadmap.undo, { session_id, all: true }),
      'forbidden',
      /write access/,
    )
    expect((await task(t, a.id))?.start_week).toBe('2026-01-05')
    await expectRefusal(
      t.mutation(api.roadmap.change, { session_id, operations: [] }),
      'forbidden',
      /not signed in/,
    )
  })

  it('rolls back a batch if any operation lacks permission, including foreign organizations', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await expectRefusal(
      user.mutation(api.roadmap.change, {
        session_id,
        operations: [schedule(a.id, '2026-01-05'), schedule(foreign.id, '2026-01-12')],
      }),
      'not_found',
    )
    expect((await task(t, a.id))?.start_week).toBeUndefined()
    expect(await rows(t)).toEqual([])
  })

  it('supports a visit spanning writable organizations through the caller’s current seats', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    await t.run((ctx) => ctx.db.patch(f.otherAdmin._id, { auth_user_id: f.user.auth_user_id }))
    const otherSub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id: f.otherOrg.id, project_id: otherSub.id })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(a.id, '2026-01-05'), schedule(b.id, '2026-01-12')],
    })
    await user.mutation(api.roadmap.undo, { session_id, all: true })
    expect((await task(t, a.id))?.start_week).toBeUndefined()
    expect((await task(t, b.id))?.start_week).toBeUndefined()
  })

  it('refuses a date operation on a group even when it would change nothing; skips an unchanged estimate', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const group = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-01-05',
      end_week: '2026-02-02',
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: group.id,
      start_week: '2026-01-05',
      end_week: '2026-02-02',
      remaining_hours: 12,
      remaining_set_at: NOW,
    })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    expect(
      await user.mutation(api.roadmap.change, {
        session_id,
        operations: [{ kind: 'task', id: child.id, patch: { remaining_hours: 12 } }],
      }),
    ).toEqual({ count: 0 })
    expect((await task(t, child.id))?.remaining_set_at).toBe(NOW)
    for (const op of [
      schedule(group.id, '2026-01-12'), // a change
      schedule(group.id, '2026-01-05', '2026-02-02'), // its dormant stored dates
      { kind: 'task' as const, id: group.id, patch: { start_week: null, end_week: null } },
      { kind: 'task' as const, id: group.id, patch: { end_week: '2026-02-02' } },
    ]) {
      // the whole batch rolls back, the leaf's valid operation included
      const r = await expectRefusal(
        user.mutation(api.roadmap.change, {
          session_id,
          operations: [schedule(other.id, '2026-03-02'), op],
        }),
        'rule',
      )
      expect(r.data.message).toBe(GROUP_DATES_RULE)
    }
    expect(await task(t, group.id)).toEqual(group)
    expect(await task(t, other.id)).toEqual(other)
    expect(await rows(t)).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('activity_events').collect())).toEqual([])
  })

  it('refuses expired entries and lets the internal expiry remove only its own visit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(a.id, '2026-01-05')],
    })
    const expiry = (await rows(t))[0].expires_at
    vi.setSystemTime(expiry + 1)
    await expectRefusal(
      user.mutation(api.roadmap.undo, { session_id, all: true }),
      'conflict',
      /expired/,
    )
    await t.mutation(internal.roadmap.expire, {
      auth_user_id: f.user.auth_user_id!,
      session_id,
      expires_at: expiry,
    })
    expect(await rows(t)).toEqual([])
    await expectRefusal(
      user.mutation(api.roadmap.undo, { session_id, all: true }),
      'conflict',
      /expired/,
    )
    expect((await task(t, a.id))?.start_week).toBe('2026-01-05')
  })
})
