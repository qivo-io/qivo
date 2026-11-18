/* Who may work on a subtask, and when the people on a task stop a change
 * to it. A subtask stays in its parent's own sub-project, so whoever may
 * work on it there sees its parent, and the people on a task's subtasks
 * must be able to work wherever a move takes them. Someone left on a task
 * when their access to its sub-project was removed sees neither the task
 * nor its parent, so they stop no parent change. The scene: an epic with a
 * feature below it in a sibling sub-project of TBED hidden from the guest.
 * f.guest can edit f.sub and f.sub2 but holds nothing on hiddenSub; f.user
 * leads TBED, so sees every task. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { PARENT_IS_SUBTASK, SUBTASK_WITH_SUBTASKS } from '../lib/limits'
import { issueKey } from '../lib/taskRefs'
import {
  ASSIGNEE_RULE,
  type IssuePatch,
  MOVE_NAMES,
  moveSubtreeHolderRule,
  REVIEWER_RULE,
  SUBTASK_PROJECT_RULE,
} from '../model/issues'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'

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
  const f = await withReadingAdmin(t)
  const hiddenSub = await plantHiddenSibling(t, f, f.guest)
  const base = { org_id: f.org.id, project_id: f.sub.id }
  const home = { ...base, project_id: hiddenSub.id }
  const epic = await plantIssue(t, { ...home, title: 'Epic' })
  const feature = await plantIssue(t, { ...home, parent_id: epic.id, title: 'Feature' })
  return { f, hiddenSub, base, home, epic, feature }
}

/* Gives `profile` `level` on each of `projects`. */
const grant = (t: T, projects: string[], profile: string, level: 'user' | 'viewer' = 'user') =>
  t.run(async (ctx) => {
    for (const project_id of projects)
      await ctx.db.insert('project_access', { project_id, profile_id: profile, level })
  })

const update = (t: T, f: OrgFixture, id: string, patch: IssuePatch) =>
  as(t, f.admin).mutation(api.issues.update, { org_id: f.org.id, id, patch })

const move = (t: T, who: Doc<'profiles'>, f: OrgFixture, id: string, project_id: string) =>
  as(t, who).mutation(api.issues.move, { org_id: f.org.id, id, project_id })

describe('who works on a subtask', () => {
  it("creates a subtask only in its parent's sub-project, for someone who can work there", async () => {
    const t = newT()
    const { f, base, hiddenSub, epic, feature } = await scene(t)
    const create = (project_id: string, parent_id: string, assignee_id: string) =>
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id,
        title: 'New subtask',
        parent_id,
        assignee_id,
      })
    // where the guest can work, the epic's sub-project is another one
    const across = await expectRefusal(create(base.project_id, epic.id, f.guest.id), 'rule')
    expect(across.data.message).toBe(SUBTASK_PROJECT_RULE)
    // and in the epic's own sub-project the guest can hold no work
    const r = await expectRefusal(create(hiddenSub.id, epic.id, f.guest.id), 'rule')
    expect(r.data.message).toBe(ASSIGNEE_RULE)
    // the feature is a subtask, so it takes no subtask of its own at all
    const nested = await expectRefusal(create(hiddenSub.id, feature.id, f.user.id), 'rule')
    expect(nested.data.message).toBe(PARENT_IS_SUBTASK)
    const made = await create(hiddenSub.id, epic.id, f.user.id)
    expect(made).toMatchObject({ assignee_id: f.user.id, project_id: hiddenSub.id })
  })

  it('sets a parent while someone left on the task holds it, and gives them no new work there', async () => {
    const t = newT()
    const { f, hiddenSub, home, epic } = await scene(t)
    // the guest works on a task in the epic's sub-project and is left on it
    // when their access there goes
    await grant(t, [hiddenSub.id], f.guest.id)
    const top = await plantIssue(t, {
      ...home,
      title: 'Top',
      assignee_id: f.guest.id,
      reviewer_id: f.guest.id,
    })
    const removed = await as(t, f.user).mutation(api.projects.removeAccess, {
      org_id: f.org.id,
      id: hiddenSub.id,
      user_id: f.guest.id,
      on_held_tasks: 'leave',
    })
    // one holding for each role
    expect(removed).toMatchObject({ removed: true, stranded: 2 })
    // they see neither task, so the parent is set and they stay on the task
    await update(t, f, top.id, { parent_id: epic.id })
    expect(await issueRow(t, top.id)).toMatchObject({
      parent_id: epic.id,
      assignee_id: f.guest.id,
      reviewer_id: f.guest.id,
    })
    // and they hold nothing new there, on a task or its new parent
    const other = await plantIssue(t, { ...home, title: 'Other' })
    const assignee = await expectRefusal(update(t, f, epic.id, { assignee_id: f.guest.id }), 'rule')
    expect(assignee.data.message).toBe(ASSIGNEE_RULE)
    const reviewer = await expectRefusal(
      update(t, f, other.id, { parent_id: epic.id, reviewer_id: f.guest.id }),
      'rule',
    )
    expect(reviewer.data.message).toBe(REVIEWER_RULE)
    expect(await issueRow(t, other.id)).toEqual(other)
  })

  it('refuses a parent for a task whose only subtask is archived', async () => {
    const t = newT()
    const { f, home, epic } = await scene(t)
    // a restore from the archive would bring the subtask back below a subtask
    const former = await plantIssue(t, home)
    await plantIssue(t, { ...home, parent_id: former.id, archived_at: '2026-01-02T00:00:00.000Z' })
    const r = await expectRefusal(update(t, f, former.id, { parent_id: epic.id }), 'rule')
    expect(r.data.message).toBe(SUBTASK_WITH_SUBTASKS)
    expect(await issueRow(t, former.id)).toEqual(former)
  })
})

describe('the people on the subtasks a move carries', () => {
  it('refuses moving a task where someone on the subtasks it carries cannot work', async () => {
    const t = newT()
    const { f, base, hiddenSub } = await scene(t)
    const top = await plantIssue(t, { ...base, title: 'Top' })
    const kid = await plantIssue(t, { ...base, parent_id: top.id, reviewer_id: f.guest.id })
    // the guest reviews a subtask and cannot work in hiddenSub
    const r = await expectRefusal(move(t, f.admin, f, top.id, hiddenSub.id), 'rule')
    // the refusal names the guest and the subtask
    expect(r.data.message).toBe(
      moveSubtreeHolderRule([{ name: f.guest.name, tasks: [issueKey(kid.num)] }]),
    )
    expect(await issueRow(t, top.id)).toEqual(top)
    // a destination they can work in is fine, and the subtask comes along
    await move(t, f.admin, f, top.id, f.sub2.id)
    for (const task of [top, kid]) expect((await issueRow(t, task.id)).project_id).toBe(f.sub2.id)
    // and so is the move once nobody below is blind to it
    await update(t, f, kid.id, { reviewer_id: f.user.id })
    await move(t, f.admin, f, top.id, hiddenSub.id)
    expect((await issueRow(t, top.id)).project_id).toBe(hiddenSub.id)
  })

  it('names everyone who blocks a move with their subtasks', async () => {
    const t = newT()
    const { f, base, hiddenSub } = await scene(t)
    // a mover who edits FW and the destination
    const mover = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Mo Mover',
      auth_user_id: `mover_${uuid()}`,
    })
    const dest = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    await grant(t, [f.sub.id, dest.id], mover.id)
    const [ann, bo] = await Promise.all(
      ['Ann Ash', 'Bo Birch'].map(async (name) => {
        const seat = await plantSeat(t, { org_id: f.org.id, name })
        await grant(t, [f.sub.id, f.sub2.id, hiddenSub.id], seat.id)
        return seat
      }),
    )
    const top = await plantIssue(t, { ...base, title: 'Top' })
    const kid = (over: Partial<Doc<'issues'>>) =>
      plantIssue(t, { ...base, parent_id: top.id, ...over })
    // Ann holds five subtasks, twice on the first
    const hers = [await kid({ assignee_id: ann.id, reviewer_id: ann.id })]
    for (let i = 0; i < 4; i++) hers.push(await kid({ assignee_id: ann.id }))
    const his = await kid({ reviewer_id: bo.id })
    // the guest, who edits FW and PCB and not the destination, holds one
    const guests = await kid({ reviewer_id: f.guest.id })
    const keys = hers.map((task) => issueKey(task.num))
    const r = await expectRefusal(move(t, mover, f, top.id, dest.id), 'rule')
    expect(r.data.message).toBe(
      `Ann Ash (on ${keys.slice(0, MOVE_NAMES.tasks).join(', ')} and 2 more), Bo Birch (on ${issueKey(his.num)}) and ${f.guest.name} (on ${issueKey(guests.num)}) cannot edit that sub-project; give them Edit access there, or change who works on those subtasks first`,
    )
    expect(await issueRow(t, top.id)).toEqual(top)
    // once each of them edits the destination the move passes
    for (const seat of [ann, bo, f.guest]) await grant(t, [dest.id], seat.id)
    await move(t, mover, f, top.id, dest.id)
    expect((await issueRow(t, top.id)).project_id).toBe(dest.id)
  })

  it('names the first people of many who block a move and counts the others', async () => {
    const t = newT()
    const { f, base, hiddenSub } = await scene(t)
    const top = await plantIssue(t, { ...base, title: 'Top' })
    const names = ['Ada', 'Bea', 'Cy', 'Di', 'Ed', 'Fay', 'Gus']
    const kids: Doc<'issues'>[] = []
    for (const name of names) {
      const seat = await plantSeat(t, { org_id: f.org.id, name })
      await grant(t, [f.sub.id], seat.id)
      kids.push(await plantIssue(t, { ...base, parent_id: top.id, assignee_id: seat.id }))
    }
    const named = names
      .slice(0, MOVE_NAMES.people)
      .map((name, i) => `${name} (on ${issueKey(kids[i].num)})`)
    const r = await expectRefusal(move(t, f.admin, f, top.id, hiddenSub.id), 'rule')
    expect(r.data.message).toBe(
      `${named.join(', ')} and 2 others cannot edit that sub-project; give them Edit access there, or change who works on those subtasks first`,
    )
  })
})
