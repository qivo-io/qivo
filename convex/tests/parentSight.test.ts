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
import { PARENT_IS_SUBTASK, SUBTASK_WITH_SUBTASKS } from '../lib/limits'
import { issueKey } from '../lib/taskRefs'
import {
  ASSIGNEE_SIGHT_RULE,
  HOLDER_SIGHT_RULE,
  type IssuePatch,
  MOVE_NAMES,
  MOVE_TOO_LARGE,
  moveHolderRule,
  REVIEWER_SIGHT_RULE,
  SUBTREE_ROOM,
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
  const f = await withReadingAdmin(t)
  const hiddenSub = await plantHiddenSibling(t, f, f.guest)
  const base = { org_id: f.org.id, project_id: f.sub.id }
  // an epic the guest cannot see, a visible feature under it, a task below,
  // a chain from before the one level of subtasks
  const epic = await plantIssue(t, { ...base, project_id: hiddenSub.id, title: 'Epic' })
  const feature = await plantIssue(t, { ...base, parent_id: epic.id, title: 'Feature' })
  const task = await plantIssue(t, { ...base, parent_id: feature.id, title: 'Task' })
  return { f, hiddenSub, base, epic, feature, task }
}

/* Gives `profile` `level` on each of `projects`. */
const grant = (t: T, projects: string[], profile: string, level: 'user' | 'viewer' = 'user') =>
  t.run(async (ctx) => {
    for (const project_id of projects)
      await ctx.db.insert('project_access', { project_id, profile_id: profile, level })
  })

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
    // the refusal names the guest and the subtask
    expect(r.data.message).toBe(
      moveHolderRule([{ name: f.guest.name, tasks: [issueKey(kid.num)], hidden: 0 }]),
    )
    expect(r.data.message).toBe(
      `${f.guest.name} (on ${issueKey(kid.num)}) has no access to that sub-project; give them access there, or change who works on that subtask first`,
    )
    expect(await issueRow(t, top.id)).toEqual(top)
    // a destination they can see is fine
    await move(top.id, f.sub2.id)
    expect((await issueRow(t, top.id)).project_id).toBe(f.sub2.id)
    // and so is the move once nobody below is blind to it
    await update(t, f, kid.id, { reviewer_id: f.user.id })
    await move(top.id, hiddenSub.id)
    expect((await issueRow(t, top.id)).project_id).toBe(hiddenSub.id)
  })

  it('names everyone who blocks a move with their subtasks, and tells a subtask the mover cannot see only as that', async () => {
    const t = newT()
    const { f, base, hiddenSub } = await scene(t)
    // a mover who edits FW and the destination and sees nothing of PCB
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
    // Ann holds five subtasks the mover sees, twice on the first, and one in PCB
    const hers = [await kid({ assignee_id: ann.id, reviewer_id: ann.id })]
    for (let i = 0; i < 4; i++) hers.push(await kid({ assignee_id: ann.id }))
    await kid({ project_id: f.sub2.id, reviewer_id: ann.id })
    // Bo holds only subtasks in projects the mover cannot see
    await kid({ project_id: f.sub2.id, assignee_id: bo.id })
    await kid({ project_id: hiddenSub.id, reviewer_id: bo.id })
    // the guest, who sees FW, PCB and not the destination, holds one
    const guests = await kid({ reviewer_id: f.guest.id })
    const move = () =>
      as(t, mover).mutation(api.issues.move, { org_id: f.org.id, id: top.id, project_id: dest.id })
    const keys = hers.map((task) => issueKey(task.num))
    const r = await expectRefusal(move(), 'rule')
    expect(r.data.message).toBe(
      `Ann Ash (on ${keys.slice(0, MOVE_NAMES.tasks).join(', ')} and 3 more), Bo Birch (on 2 subtasks you cannot see) and ${f.guest.name} (on ${issueKey(guests.num)}) have no access to that sub-project; give them access there, or change who works on those subtasks first`,
    )
    expect(await issueRow(t, top.id)).toEqual(top)
    // the sentence gives no ID of a subtask in PCB or the hidden sibling
    const unseen = (await t.run((ctx) => ctx.db.query('issues').collect())).filter(
      (task) => task.parent_id === top.id && task.project_id !== f.sub.id,
    )
    expect(unseen).toHaveLength(3)
    for (const task of unseen) expect(r.data.message).not.toContain(issueKey(task.num))
    // once each of them reads the destination the move passes
    await grant(t, [dest.id], ann.id, 'viewer')
    await grant(t, [dest.id], bo.id, 'viewer')
    await grant(t, [dest.id], f.guest.id, 'viewer')
    await move()
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
    const move = as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: top.id,
      project_id: hiddenSub.id,
    })
    const named = names
      .slice(0, MOVE_NAMES.people)
      .map((name, i) => `${name} (on ${issueKey(kids[i].num)})`)
    expect((await expectRefusal(move, 'rule')).data.message).toBe(
      `${named.join(', ')} and 2 others have no access to that sub-project; give them access there, or change who works on those subtasks first`,
    )
  })

  it('says others may block a move too once it has no room to check them, and that it is too large before anyone blocks it', async () => {
    const t = newT({ transactionLimits: true })
    const { f, base, hiddenSub } = await scene(t)
    const top = await plantIssue(t, { ...base, title: 'Top' })
    const kids: Doc<'issues'>[] = []
    for (const name of ['Ada', 'Bea', 'Cy']) {
      const seat = await plantSeat(t, { org_id: f.org.id, name })
      await grant(t, [f.sub.id], seat.id)
      kids.push(await plantIssue(t, { ...base, parent_id: top.id, assignee_id: seat.id }))
    }
    const key = (i: number) => issueKey(kids[i].num)
    const blocker = (name: string, i: number) => ({ name, tasks: [key(i)], hidden: 0 })
    const all = [blocker('Ada', 0), blocker('Bea', 1), blocker('Cy', 2)]
    // every share of the transaction the move may fill, from none to all
    const said = new Set<string>()
    const saved = { ...SUBTREE_ROOM }
    try {
      for (let room = 0; room <= 1000; room++) {
        Object.assign(SUBTREE_ROOM, { room: room / 100_000, every: 1 })
        const r = await expectRefusal(
          as(t, f.admin).mutation(api.issues.move, {
            org_id: f.org.id,
            id: top.id,
            project_id: hiddenSub.id,
          }),
          'rule',
        )
        said.add(r.data.message)
      }
    } finally {
      Object.assign(SUBTREE_ROOM, saved)
    }
    const whole = await expectRefusal(
      as(t, f.admin).mutation(api.issues.move, {
        org_id: f.org.id,
        id: top.id,
        project_id: hiddenSub.id,
      }),
      'rule',
    )
    said.add(whole.data.message)
    // nothing but these, each of them met: too large while nobody blocks
    // it yet, the people found so far with the word that others may block
    // it too, and everyone once the room holds
    expect([...said].sort()).toEqual(
      [
        MOVE_TOO_LARGE,
        moveHolderRule(all.slice(0, 1), true),
        moveHolderRule(all.slice(0, 2), true),
        moveHolderRule(all),
      ].sort(),
    )
    expect(moveHolderRule(all.slice(0, 1), true)).toBe(
      `Ada (on ${key(0)}) and possibly others have no access to that sub-project; give them access there, or change who works on those subtasks first`,
    )
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
