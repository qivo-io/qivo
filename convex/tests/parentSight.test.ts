/* Whoever works on a subtask must see every task above it: the parent holds
 * the subtask's context. A subtask stays in its parent's top-level project,
 * so the scene hides a sibling sub-project of TBED from the guest. f.guest
 * can edit f.sub and f.sub2 but holds nothing on hiddenSub; f.user leads
 * TBED, so sees every task. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { canSeeProject } from '../lib/access'
import { PARENT_IS_SUBTASK, SUBTASK_WITH_SUBTASKS } from '../lib/taskLimits'
import {
  ASSIGNEE_SIGHT_RULE,
  HOLDER_SIGHT_RULE,
  type IssuePatch,
  MOVE_HOLDER_RULE,
  REVIEWER_SIGHT_RULE,
} from '../model/issues'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'

const issueRow = (t: T, id: string): Promise<Doc<'issues'>> =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (!row) throw new Error('missing issue')
    return row
  })

async function scene(t: T) {
  const f = await withOrg(t)
  const hiddenSub = await plantHiddenSibling(t, f, f.guest)
  const base = { org_id: f.org.id, project_id: f.sub.id }
  // an epic the guest cannot see, a visible feature under it, a task below,
  // a chain from before the one level of subtasks
  const epic = await plantIssue(t, { ...base, project_id: hiddenSub.id, title: 'Epic' })
  const feature = await plantIssue(t, { ...base, parent_id: epic.id, title: 'Feature' })
  const task = await plantIssue(t, { ...base, parent_id: feature.id, title: 'Task' })
  return { f, hiddenSub, base, epic, feature, task }
}

const update = (t: T, f: OrgFixture, id: string, patch: IssuePatch) =>
  as(t, f.admin).mutation(api.issues.update, { org_id: f.org.id, id, patch })

describe('a subtask is held only by people who can see every task above it', () => {
  it('refuses an assignee or reviewer who cannot see a task anywhere above', async () => {
    const t = newT()
    const { f, task, feature } = await scene(t)
    // the guest can edit the task's project, but not see the epic two levels up
    for (const id of [task.id, feature.id]) {
      const r = await expectRefusal(update(t, f, id, { assignee_id: f.guest.id }), 'rule')
      expect(r.data.message).toBe(ASSIGNEE_SIGHT_RULE)
    }
    // the feature is a group and has no reviewer of its own; the task does
    const rr = await expectRefusal(update(t, f, task.id, { reviewer_id: f.guest.id }), 'rule')
    expect(rr.data.message).toBe(REVIEWER_SIGHT_RULE)
    expect(await issueRow(t, task.id)).toEqual(task)
    // someone who sees the whole chain is accepted
    await update(t, f, task.id, { assignee_id: f.user.id, reviewer_id: f.user.id })
    expect(await issueRow(t, task.id)).toMatchObject({
      assignee_id: f.user.id,
      reviewer_id: f.user.id,
    })
  })

  it('refuses creating a subtask for someone who cannot see its parent', async () => {
    const t = newT()
    const { f, base, epic, feature } = await scene(t)
    const create = (parent_id: string, assignee_id: string) =>
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: base.project_id,
        title: 'New subtask',
        parent_id,
        assignee_id,
      })
    const r = await expectRefusal(create(epic.id, f.guest.id), 'rule')
    expect(r.data.message).toBe(ASSIGNEE_SIGHT_RULE)
    // the feature is a subtask, so it takes no subtask of its own at all
    const nested = await expectRefusal(create(feature.id, f.user.id), 'rule')
    expect(nested.data.message).toBe(PARENT_IS_SUBTASK)
    const made = await create(epic.id, f.user.id)
    expect(made).toMatchObject({ assignee_id: f.user.id })
  })

  it('refuses a parent that someone holding the task cannot see', async () => {
    const t = newT()
    const { f, base, epic } = await scene(t)
    // a task the guest works on, with no parent yet
    const top = await plantIssue(t, { ...base, title: 'Top', reviewer_id: f.guest.id })
    const r = await expectRefusal(update(t, f, top.id, { parent_id: epic.id }), 'rule')
    expect(r.data.message).toBe(HOLDER_SIGHT_RULE)
    expect(await issueRow(t, top.id)).toEqual(top)
    // the same change passes once nobody holding it is blind to the epic
    await update(t, f, top.id, { reviewer_id: f.user.id })
    await update(t, f, top.id, { parent_id: epic.id })
    expect((await issueRow(t, top.id)).parent_id).toBe(epic.id)
  })

  it('refuses moving a task to a sub-project someone on its subtasks cannot access', async () => {
    const t = newT()
    const { f, base, hiddenSub } = await scene(t)
    const move = (id: string, project_id: string) =>
      as(t, f.admin).mutation(api.issues.move, { org_id: f.org.id, id, project_id })
    const top = await plantIssue(t, { ...base, title: 'Top' })
    const kid = await plantIssue(t, { ...base, parent_id: top.id, reviewer_id: f.guest.id })
    // the guest reviews a subtask and cannot see hiddenSub
    const r = await expectRefusal(move(top.id, hiddenSub.id), 'rule')
    expect(r.data.message).toBe(MOVE_HOLDER_RULE)
    expect(await issueRow(t, top.id)).toEqual(top)
    // a destination they can see is fine
    await move(top.id, f.sub2.id)
    expect((await issueRow(t, top.id)).project_id).toBe(f.sub2.id)
    // and so is the move once nobody below is blind to it
    await update(t, f, kid.id, { reviewer_id: f.user.id })
    await move(top.id, hiddenSub.id)
    expect((await issueRow(t, top.id)).project_id).toBe(hiddenSub.id)
  })

  it('ignores a switched-off holder', async () => {
    const t = newT()
    const { f, base, epic } = await scene(t)
    const top = await plantIssue(t, { ...base, assignee_id: f.guest.id })
    await t.run(async (ctx) => {
      const guest = await ctx.db.get(f.guest._id)
      await ctx.db.patch(guest!._id, { active: false })
    })
    await update(t, f, top.id, { parent_id: epic.id })
    expect((await issueRow(t, top.id)).parent_id).toBe(epic.id)
  })

  it('refuses a parent for a task whose only subtask is archived', async () => {
    const t = newT()
    const { f, base, epic } = await scene(t)
    // a restore from the archive would bring the subtask back below a subtask
    const former = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: former.id, archived_at: '2026-01-02T00:00:00.000Z' })
    const r = await expectRefusal(update(t, f, former.id, { parent_id: epic.id }), 'rule')
    expect(r.data.message).toBe(SUBTASK_WITH_SUBTASKS)
    expect(await issueRow(t, former.id)).toEqual(former)
  })

  it('leaves an existing holder alone on other edits', async () => {
    const t = newT()
    const { f, task } = await scene(t)
    // a holder who lost sight of the chain later (the rule checks changes only)
    await t.run(async (ctx) => {
      const row = await ctx.db.get(task._id)
      await ctx.db.patch(row!._id, { assignee_id: f.guest.id })
    })
    await update(t, f, task.id, { title: 'Renamed' })
    expect(await issueRow(t, task.id)).toMatchObject({
      title: 'Renamed',
      assignee_id: f.guest.id,
    })
  })

  it('holds in the realistic Northstar seed', async () => {
    const t = newT()
    const { org } = await plantNorthstar(t)
    const blind = await t.run(async (ctx) => {
      const issues = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect()
      const byId = new Map(issues.map((i) => [i.id, i]))
      const out: string[] = []
      for (const task of issues) {
        if (task.archived_at !== undefined || task.parent_id === undefined) continue
        const group = issues.some((c) => c.parent_id === task.id && c.archived_at === undefined)
        const holders = [task.assignee_id, group ? undefined : task.reviewer_id]
        for (const holder of holders) {
          if (holder === undefined) continue
          const profile = await ctx.db
            .query('profiles')
            .withIndex('by_uuid', (q) => q.eq('id', holder))
            .unique()
          for (let up = byId.get(task.parent_id); up; up = byId.get(up.parent_id ?? '')) {
            const project = await ctx.db
              .query('projects')
              .withIndex('by_uuid', (q) => q.eq('id', up!.project_id))
              .unique()
            if (!profile || !project || !(await canSeeProject(ctx, profile, project)))
              out.push(`${task.title} / ${profile?.name}`)
          }
        }
      }
      return out
    })
    expect(blind).toEqual([])
  })
})
