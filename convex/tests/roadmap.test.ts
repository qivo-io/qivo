import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import { byId } from '../lib/db'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
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

  it('restores automatically widened ancestors together with descendants', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const ancestor = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
    })
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: ancestor.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
      start_week: '2026-01-05',
      end_week: '2026-01-05',
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(child.id, '2026-02-02')],
    })
    expect((await task(t, ancestor.id))?.end_week).toBe('2026-02-02')
    await user.mutation(api.roadmap.undo, { session_id, all: false })
    expect((await task(t, child.id))?.end_week).toBe('2026-01-05')
    expect((await task(t, parent.id))?.end_week).toBe('2026-01-12')
    expect((await task(t, ancestor.id))?.end_week).toBe('2026-01-12')
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

  it.each(['hidden', 'read-only'] as const)(
    'reverses automatic ancestor widening in a %s project using current child write access',
    async (visibility) => {
      const t = newT(),
        f = await withOrg(t),
        guest = as(t, f.guest),
        session_id = uuid()
      const otherSub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.hidden.id,
      })
      if (visibility === 'read-only')
        await t.run((ctx) =>
          ctx.db.insert('project_access', {
            project_id: f.hidden.id,
            profile_id: f.guest.id,
            level: 'viewer',
          }),
        )
      const parent = await plantIssue(t, {
        org_id: f.org.id,
        project_id: otherSub.id,
        start_week: '2026-01-05',
        end_week: '2026-01-12',
      })
      const child = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        parent_id: parent.id,
        start_week: '2026-01-05',
        end_week: '2026-01-05',
      })
      await expectRefusal(
        guest.mutation(api.issues.update, {
          org_id: f.org.id,
          id: parent.id,
          patch: { end_week: '2026-02-02' },
        }),
        'forbidden',
      )
      await guest.mutation(api.roadmap.change, {
        session_id,
        operations: [schedule(child.id, '2026-02-02')],
      })
      expect((await task(t, parent.id))?.end_week).toBe('2026-02-02')
      expect(await guest.mutation(api.roadmap.undo, { session_id, all: true })).toEqual({
        count: 0,
      })
      expect((await task(t, parent.id))?.end_week).toBe('2026-01-12')
      expect((await task(t, child.id))?.start_week).toBe('2026-01-05')
    },
  )

  it('refuses changed task topology and newly scheduled children before shrinking an ancestor', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
      start_week: '2026-01-05',
      end_week: '2026-01-05',
    })
    const sibling = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(child.id, '2026-02-02')],
    })
    await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: sibling.id,
      patch: { start_week: '2026-01-26', end_week: '2026-01-26' },
    })
    await expectRefusal(user.mutation(api.roadmap.undo, { session_id, all: true }), 'conflict')
    expect((await task(t, child.id))?.start_week).toBe('2026-02-02')
    // Even an unscheduled new child changes the topology receipt.
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: child.id })
    await expectRefusal(user.mutation(api.roadmap.undo, { session_id, all: false }), 'conflict')
  })

  it.each(['access revoked', 'project moved'] as const)(
    'rechecks the original child when only its ancestor has a net change: %s',
    async (condition) => {
      const t = newT(),
        f = await withOrg(t),
        guest = as(t, f.guest),
        session_id = uuid()
      const otherSub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.hidden.id,
      })
      const parent = await plantIssue(t, {
        org_id: f.org.id,
        project_id: otherSub.id,
        start_week: '2026-01-05',
        end_week: '2026-01-12',
      })
      const child = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        parent_id: parent.id,
        start_week: '2026-01-05',
        end_week: '2026-01-05',
      })
      // Widening is sticky: returning the child leaves only a parent change.
      await guest.mutation(api.roadmap.change, {
        session_id,
        operations: [schedule(child.id, '2026-02-02'), schedule(child.id, '2026-01-05')],
      })
      const changes = JSON.parse((await rows(t))[0].changes) as { id: string }[]
      expect(changes.map((change) => change.id)).toEqual([parent.id])
      if (condition === 'access revoked') {
        await t.run(async (ctx) => {
          const grant = await ctx.db
            .query('project_access')
            .withIndex('by_project_profile', (q) =>
              q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
            )
            .unique()
          if (!grant) throw new Error('fixture grant missing')
          await ctx.db.patch(grant._id, { level: 'viewer' })
        })
      } else {
        await as(t, f.admin).mutation(api.issues.move, {
          org_id: f.org.id,
          id: child.id,
          project_id: f.sub2.id,
        })
      }
      await expectRefusal(
        guest.mutation(api.roadmap.undo, { session_id, all: true }),
        condition === 'access revoked' ? 'forbidden' : 'conflict',
      )
      expect((await task(t, parent.id))?.end_week).toBe('2026-02-02')
      expect(await rows(t)).toHaveLength(1)
    },
  )

  it('expires older task receipts without captured authority paths with a typed refusal', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [schedule(a.id, '2026-01-05')],
    })
    await t.run(async (ctx) => {
      const entry = (await ctx.db.query('roadmap_history').collect())[0]
      const changes = JSON.parse(entry.changes) as { authorities?: unknown }[]
      for (const change of changes) delete change.authorities
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

  it('skips effective no-ops including clamped dates and unchanged remaining estimates', async () => {
    const t = newT(),
      f = await withOrg(t),
      user = as(t, f.user),
      session_id = uuid()
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-01-05',
      end_week: '2026-02-02',
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
      start_week: '2026-01-05',
      end_week: '2026-02-02',
      remaining_hours: 12,
      remaining_set_at: NOW,
    })
    expect(
      await user.mutation(api.roadmap.change, {
        session_id,
        operations: [
          schedule(parent.id, '2026-01-12'),
          { kind: 'task', id: child.id, patch: { remaining_hours: 12 } },
        ],
      }),
    ).toEqual({ count: 0 })
    expect((await task(t, child.id))?.remaining_set_at).toBe(NOW)
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
