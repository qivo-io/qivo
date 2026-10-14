/* The scheduling invariants, driven through the PUBLIC issue mutations. A
 * group's dates are calculated from its subtasks, so a date write on a group
 * is refused and no subtask write ever changes an ancestor. Also the
 * hierarchy depth caps (0057/0038), the parent org/archive fences and the
 * week-pair CHECKs. Refusal sentences are asserted byte-for-byte via
 * err.data.message. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  type CreateIssueArgs,
  GROUP_DATES_RULE,
  GROUP_PAUSE_RULE,
  type IssuePatch,
} from '../model/issues'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const issueRow = (t: T, id: string): Promise<Doc<'issues'>> =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (row === null) throw new Error(`issue ${id} vanished`)
    return row
  })

const subscribe = (t: T, issue_id: string, profile_id: string): Promise<void> =>
  t.run(async (ctx) => {
    await ctx.db.insert('issue_subscriptions', { issue_id, profile_id, created_at: NOW })
  })

const inbox = (t: T, recipient_id: string, issue_id: string): Promise<Doc<'messages'>[]> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', recipient_id).eq('issue_id', issue_id),
        )
        .collect(),
  )

const createAs = (t: T, f: OrgFixture, extra: Partial<CreateIssueArgs> = {}) =>
  as(t, f.admin).mutation(api.issues.create, {
    org_id: f.org.id,
    id: uuid(),
    project_id: f.sub.id,
    title: 'Envelope task',
    ...extra,
  })

const updateAs = (t: T, f: OrgFixture, id: string, patch: IssuePatch) =>
  as(t, f.admin).mutation(api.issues.update, { org_id: f.org.id, id, patch })

/* A parent_id chain of n rows in f.sub, index 0 the root, n-1 the deepest. */
async function plantChain(t: T, f: OrgFixture, n: number): Promise<Doc<'issues'>[]> {
  const rows: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++) {
    const prev = rows[rows.length - 1]
    rows.push(
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        ...(prev === undefined ? {} : { parent_id: prev.id }),
      }),
    )
  }
  return rows
}

describe('issue scheduling and hierarchy', () => {
  it('a date write on a group is refused for any value, archived groups included; archived-only subtasks make no group', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const span = { start_week: '2026-03-02', end_week: '2026-03-08' }
    const group = await plantIssue(t, { ...base, ...span })
    await plantIssue(t, {
      ...base,
      parent_id: group.id,
      start_week: '2026-03-09',
      end_week: '2026-03-15',
    })
    // archived with its subtree, it is still a group
    const archivedGroup = await plantIssue(t, { ...base, ...span, archived_at: NOW })
    await plantIssue(t, { ...base, parent_id: archivedGroup.id, archived_at: NOW })
    const patches: IssuePatch[] = [
      { start_week: '2026-04-06', end_week: '2026-04-12' }, // a change
      { start_week: null, end_week: null }, // a clear
      { end_week: null }, // half a clear
      span, // the stored values, unchanged
      { start_week: span.start_week }, // one key alone, unchanged
    ]
    for (const row of [group, archivedGroup]) {
      for (const patch of patches) {
        const r = await expectRefusal(updateAs(t, f, row.id, patch), 'rule')
        expect(r.data.message).toBe(GROUP_DATES_RULE)
        expect(await issueRow(t, row.id)).toEqual(row) // dormant dates, untouched
      }
    }
    expect(await t.run((ctx) => ctx.db.query('activity_events').collect())).toEqual([])

    // a parent whose only subtasks are archived is no group and plans its own dates
    const former = await plantIssue(t, { ...base, ...span })
    await plantIssue(t, { ...base, parent_id: former.id, ...span, archived_at: NOW })
    const ret = await updateAs(t, f, former.id, {
      start_week: '2026-04-06',
      end_week: '2026-04-12',
    })
    expect(ret.start_week).toBe('2026-04-06')
    expect(ret.end_week).toBe('2026-04-12')
  })

  it("a pause on a group is refused; clearing a group's stored pause passes", async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const group = await plantIssue(t, { ...base, status: 'progress' })
    await plantIssue(t, { ...base, parent_id: group.id, status: 'todo' })
    const r = await expectRefusal(updateAs(t, f, group.id, { paused: true }), 'rule')
    expect(r.data.message).toBe(GROUP_PAUSE_RULE)
    expect(await issueRow(t, group.id)).toEqual(group)
    // a pause it kept from its leaf days is dormant and can still be cleared
    await t.run(async (ctx) => {
      const row = await ctx.db.get(group._id)
      await ctx.db.patch(row!._id, { paused: true })
    })
    expect((await updateAs(t, f, group.id, { paused: false })).paused).toBe(false)
    // a leaf under way still pauses
    const leaf = await plantIssue(t, { ...base, status: 'progress' })
    expect((await updateAs(t, f, leaf.id, { paused: true })).paused).toBe(true)
  })

  it('no subtask write changes an ancestor: reschedule, scheduled create and restore leave every ancestor and its followers alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const narrow = { start_week: '2026-02-02', end_week: '2026-02-08' }
    const top = await plantIssue(t, { ...base, title: 'unscheduled top' })
    const gp = await plantIssue(t, { ...base, parent_id: top.id, ...narrow })
    const parent = await plantIssue(t, { ...base, parent_id: gp.id, ...narrow })
    const child = await plantIssue(t, { ...base, parent_id: parent.id, ...narrow })
    const ancestors = [parent, gp, top]
    for (const a of ancestors) await subscribe(t, a.id, f.user.id)

    // a reschedule and a scheduled create, both far outside every stored span
    const moved = await updateAs(t, f, child.id, {
      start_week: '2026-01-05',
      end_week: '2026-03-29',
    })
    expect(moved.start_week).toBe('2026-01-05')
    expect(moved.end_week).toBe('2026-03-29')
    await createAs(t, f, { parent_id: parent.id, start_week: '2026-05-04', end_week: '2026-05-10' })
    for (const a of ancestors) {
      expect(await issueRow(t, a.id)).toEqual(a) // dates and updated_at alike
      expect(await inbox(t, f.user.id, a.id)).toEqual([])
    }

    // restoring a scheduled subtask under a scheduled parent the caller
    // cannot edit (f.guest holds User on f.meta and nothing on f.hidden)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const hiddenParent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      ...narrow,
    })
    const buried = await plantIssue(t, {
      ...base,
      parent_id: hiddenParent.id,
      start_week: '2026-03-02',
      end_week: '2026-03-08',
      archived_at: NOW,
    })
    await subscribe(t, hiddenParent.id, f.admin.id)
    await as(t, f.guest).mutation(api.issues.unarchive, { org_id: f.org.id, id: buried.id })
    expect((await issueRow(t, buried.id)).archived_at).toBeUndefined()
    expect(await issueRow(t, hiddenParent.id)).toEqual(hiddenParent)
    expect(await inbox(t, f.admin.id, hiddenParent.id)).toEqual([])
  })

  it('depth caps: the up-walk refuses past 20, and a reparent may not merge two legal chains past the budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    const deep = await plantChain(t, f, 21)
    const up = await expectRefusal(createAs(t, f, { parent_id: deep[20].id }), 'rule')
    expect(up.data.message).toBe('task hierarchy too deep or cyclic')

    const a = await plantChain(t, f, 10)
    const b = await plantChain(t, f, 11)
    const merged = await expectRefusal(updateAs(t, f, b[0].id, { parent_id: a[9].id }), 'rule')
    expect(merged.data.message).toBe('task hierarchy too deep')

    // the boundary itself is legal: 10 above + the row + 9 below = 20
    const c = await plantChain(t, f, 10)
    const d = await plantChain(t, f, 10)
    const moved = await updateAs(t, f, d[0].id, { parent_id: c[9].id })
    expect(moved.parent_id).toBe(c[9].id)
  })

  it('the parent fence: foreign-org and missing parents both answer not_found, self is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const mine = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const parent_id of [foreign.id, uuid()]) {
      for (const attempt of [
        createAs(t, f, { parent_id }),
        updateAs(t, f, mine.id, { parent_id }),
      ]) {
        const r = await expectRefusal(attempt, 'not_found')
        expect(r.data.message).toBe('parent task not found')
      }
    }
    const self = await expectRefusal(updateAs(t, f, mine.id, { parent_id: mine.id }), 'rule')
    expect(self.data.message).toBe('a task cannot be its own parent')
  })

  it('the parent fence: a hidden parent reads like a missing one and stays untouched; a read-only one is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    // f.guest holds User on f.meta and nothing on f.hidden
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const hiddenParent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
      remaining_hours: 5,
      remaining_set_at: NOW,
    })
    await subscribe(t, hiddenParent.id, f.admin.id)
    const mine = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const weeks = { start_week: '2026-03-02', end_week: '2026-03-08' }
    const asGuest = as(t, f.guest)
    const attempts = () => [
      asGuest.mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Probe',
        parent_id: hiddenParent.id,
        ...weeks,
      }),
      asGuest.mutation(api.issues.update, {
        org_id: f.org.id,
        id: mine.id,
        patch: { parent_id: hiddenParent.id, ...weeks },
      }),
    ]
    for (const attempt of attempts()) {
      const r = await expectRefusal(attempt, 'not_found')
      expect(r.data.message).toBe('parent task not found')
    }
    expect(await issueRow(t, hiddenParent.id)).toEqual(hiddenParent)
    // seeing the parent without Edit is not enough, because attaching changes it
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: hiddenSub.id,
        profile_id: f.guest.id,
        level: 'viewer',
      }),
    )
    for (const attempt of attempts()) {
      await expectRefusal(attempt, 'forbidden', /^no write access to the parent task$/)
    }
    expect(await issueRow(t, hiddenParent.id)).toEqual(hiddenParent)
    // re-sending a child's current parent, here one the guest cannot edit,
    // is a no-op that neither clears the parent's own hours nor names it
    const archivedChild = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: hiddenParent.id,
      archived_at: NOW,
    })
    await asGuest.mutation(api.issues.update, {
      org_id: f.org.id,
      id: archivedChild.id,
      patch: { parent_id: hiddenParent.id },
    })
    expect(await issueRow(t, hiddenParent.id)).toEqual(hiddenParent)
    const named = await t.run(async (ctx) =>
      (await ctx.db.query('activity_events').collect()).filter((e) =>
        (e.detail ?? '').includes(`QN-${hiddenParent.num}`),
      ),
    )
    expect(named).toEqual([])
    // an editable parent in another sub-project attaches as before
    const sibling = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await asGuest.mutation(api.issues.update, {
      org_id: f.org.id,
      id: mine.id,
      patch: { parent_id: sibling.id },
    })
    expect((await issueRow(t, mine.id)).parent_id).toBe(sibling.id)
  })

  it('week pair: both-or-neither and ordering, on create and on a half-clear', async () => {
    const t = newT()
    const f = await withOrg(t)
    const half = await expectRefusal(createAs(t, f, { start_week: '2026-02-02' }), 'bad_request')
    expect(half.data.message).toBe('start_week and end_week must be set (or cleared) together')
    const backwards = await expectRefusal(
      createAs(t, f, { start_week: '2026-02-09', end_week: '2026-02-02' }),
      'bad_request',
    )
    expect(backwards.data.message).toBe('start_week must not be after end_week')
    const scheduled = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
    })
    const halfClear = await expectRefusal(
      updateAs(t, f, scheduled.id, { end_week: null }),
      'bad_request',
    )
    expect(halfClear.data.message).toBe('start_week and end_week must be set (or cleared) together')
  })

  it('archived-parent guard, non-inverted: no ACTIVE row under an archived parent — yet archiving a parent with active children is the normal cascade', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const buried = await plantIssue(t, { ...base, archived_at: NOW })
    const onCreate = await expectRefusal(createAs(t, f, { parent_id: buried.id }), 'rule')
    expect(onCreate.data.message).toBe('the parent task is archived — restore it first')
    const mine = await plantIssue(t, { ...base })
    const onPatch = await expectRefusal(updateAs(t, f, mine.id, { parent_id: buried.id }), 'rule')
    expect(onPatch.data.message).toBe('the parent task is archived — restore it first')

    // the direction the survey had backwards: archived child under an active
    // parent IS archiving — the cascade makes it, no guard fires
    const parent = await plantIssue(t, { ...base })
    const kid = await plantIssue(t, { ...base, parent_id: parent.id })
    const { issue: archived } = await as(t, f.admin).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: parent.id,
    })
    const kidRow = await issueRow(t, kid.id)
    expect(kidRow.archived_at).toBe(archived.archived_at) // the subtree shares one now
    const p2 = await plantIssue(t, { ...base })
    const k2 = await plantIssue(t, { ...base, parent_id: p2.id })
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: k2.id })
    expect((await issueRow(t, p2.id)).archived_at).toBeUndefined()
  })

  it('archive refuses to change a subtask in a project the caller cannot edit', async () => {
    const t = newT()
    const f = await withOrg(t)
    // f.guest holds User on f.meta and nothing on f.hidden
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const asGuest = as(t, f.guest)
    const archive = (id: string) => asGuest.mutation(api.issues.archive, { org_id: f.org.id, id })
    const ARCHIVE_RULE =
      /^archiving this task would change a subtask in a project you cannot edit; an organization admin can archive it$/

    // a hidden active subtask, directly or deeper, refuses the archive whole
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const mid = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, parent_id: root.id })
    const deep = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      parent_id: mid.id,
    })
    await expectRefusal(archive(root.id), 'rule', ARCHIVE_RULE)
    for (const id of [root.id, mid.id, deep.id]) {
      expect((await issueRow(t, id)).archived_at).toBeUndefined()
    }
    // so does a visible subtask the caller can only read
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: hiddenSub.id,
        profile_id: f.guest.id,
        level: 'viewer',
      }),
    )
    await expectRefusal(archive(root.id), 'rule', ARCHIVE_RULE)
    // an archived hidden subtask is not changed, so it does not block
    await t.run(async (ctx) => {
      const row = await ctx.db.get(deep._id)
      await ctx.db.patch(row!._id, { archived_at: NOW })
    })
    await archive(root.id)
    expect((await issueRow(t, mid.id)).archived_at).toBe((await issueRow(t, root.id)).archived_at)
    // an admin's cascade reaches every project
    const adminRoot = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const adminKid = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      parent_id: adminRoot.id,
    })
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: adminRoot.id })
    expect((await issueRow(t, adminKid.id)).archived_at).toBeDefined()
  })

  /* The restore half runs twice: under a parent the caller can only read,
   * and under one they cannot see at all, which the app shows only as "the
   * parent task is outside this view". */
  it.each([
    ['cannot see', undefined],
    ['can only read', 'viewer'],
  ] as const)('restore refuses to change a parent task the caller %s', async (_, level) => {
    const t = newT()
    const f = await withOrg(t)
    // f.guest holds User on f.meta and nothing on f.hidden
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    if (level !== undefined) {
      await t.run((ctx) =>
        ctx.db.insert('project_access', {
          project_id: hiddenSub.id,
          profile_id: f.guest.id,
          level,
        }),
      )
    }
    const snapshot = await as(t, f.guest).query(api.snapshot.forMe, {})
    expect(snapshot?.projects.some((p) => p.id === hiddenSub.id)).toBe(level !== undefined)
    const restore = (id: string) =>
      as(t, f.guest).mutation(api.issues.unarchive, { org_id: f.org.id, id })
    const RESTORE_RULE =
      /^restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it$/
    const top = await plantIssue(t, { org_id: f.org.id, project_id: hiddenSub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: top.id,
    })
    const patchTop = (patch: Partial<Doc<'issues'>>) =>
      t.run(async (ctx) => {
        const row = await ctx.db.get(top._id)
        await ctx.db.patch(row!._id, patch)
      })

    // an archived parent refuses
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: top.id })
    await expectRefusal(restore(child.id), 'rule', RESTORE_RULE)
    expect((await issueRow(t, child.id)).archived_at).toBeDefined()
    expect((await issueRow(t, top.id)).archived_at).toBeDefined()
    // so does an active parent that would lose its own hours or review hand-off
    await as(t, f.admin).mutation(api.issues.unarchive, { org_id: f.org.id, id: top.id })
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: child.id })
    await patchTop({ remaining_hours: 4, remaining_set_at: NOW })
    await expectRefusal(restore(child.id), 'rule', RESTORE_RULE)
    await patchTop({ remaining_hours: undefined, remaining_set_at: undefined, review_at: NOW })
    await expectRefusal(restore(child.id), 'rule', RESTORE_RULE)
    // an active parent with neither is left alone, so the restore passes
    await patchTop({ review_at: undefined })
    const untouched = await issueRow(t, top.id)
    await restore(child.id)
    expect((await issueRow(t, child.id)).archived_at).toBeUndefined()
    expect(await issueRow(t, top.id)).toEqual(untouched)
    // an organization admin can finish what the refusal names
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: top.id })
    await as(t, f.admin).mutation(api.issues.unarchive, { org_id: f.org.id, id: child.id })
    expect((await issueRow(t, top.id)).archived_at).toBeUndefined()
  })

  it('REST and MCP archives follow the same cascade rule', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      }),
    )
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const kid = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      parent_id: root.id,
    })
    const RULE =
      /^archiving this task would change a subtask in a project you cannot edit; an organization admin can archive it$/
    await expectRefusal(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        keyName: 'drive',
        ref: root.id,
        body: JSON.stringify({ archived: true }),
      }),
      'rule',
      RULE,
    )
    await expectRefusal(
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ref: root.id,
        archived: true,
      }),
      'rule',
      RULE,
    )
    for (const id of [root.id, kid.id]) {
      expect((await issueRow(t, id)).archived_at).toBeUndefined()
    }

    // restore: an archived parent the agent cannot edit refuses on both
    const hiddenTop = await plantIssue(t, { org_id: f.org.id, project_id: hiddenSub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: hiddenTop.id,
    })
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: hiddenTop.id })
    const RESTORE =
      /^restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it$/
    await expectRefusal(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        keyName: 'drive',
        ref: child.id,
        body: JSON.stringify({ archived: false }),
      }),
      'rule',
      RESTORE,
    )
    await expectRefusal(
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ref: child.id,
        archived: false,
      }),
      'rule',
      RESTORE,
    )
    for (const id of [child.id, hiddenTop.id]) {
      expect((await issueRow(t, id)).archived_at).toBeDefined()
    }
  })
})
