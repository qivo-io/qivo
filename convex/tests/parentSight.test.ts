/* Whoever works on a subtask must see every task above it: the parent holds
 * the subtask's context. A subtask stays in its parent's own sub-project, so
 * only a family stored across sub-projects before that rule, or someone
 * left on their tasks when their access was removed, can hold a subtask
 * whose parent they cannot see. The scene plants such a chain: an epic in a
 * sibling sub-project of TBED hidden from the guest, with a feature and a
 * task below it in FW. f.guest can edit f.sub and f.sub2 but holds nothing
 * on hiddenSub; f.user leads TBED, so sees every task. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { canSeeProject } from '../lib/access'
import { PARENT_IS_SUBTASK, SUBTASK_WITH_SUBTASKS } from '../lib/limits'
import { issueKey } from '../lib/taskRefs'
import {
  ASSIGNEE_RULE,
  ASSIGNEE_SIGHT_RULE,
  HOLDER_SIGHT_RULE,
  type IssuePatch,
  MOVE_NAMES,
  MOVE_TOO_LARGE,
  moveHolderRule,
  moveSubtreeHolderRule,
  REVIEWER_SIGHT_RULE,
  SUBTASK_PROJECT_RULE,
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
  // a chain from before the one level of subtasks and before the rule that
  // a subtask stays in its parent's sub-project
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

const move = (t: T, who: Doc<'profiles'>, f: OrgFixture, id: string, project_id: string) =>
  as(t, who).mutation(api.issues.move, { org_id: f.org.id, id, project_id })

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
    const nested = await expectRefusal(create(base.project_id, feature.id, f.user.id), 'rule')
    expect(nested.data.message).toBe(PARENT_IS_SUBTASK)
    const made = await create(hiddenSub.id, epic.id, f.user.id)
    expect(made).toMatchObject({ assignee_id: f.user.id, project_id: hiddenSub.id })
  })

  it('refuses a parent that someone holding the task cannot see', async () => {
    const t = newT()
    const { f, hiddenSub, base, epic } = await scene(t)
    // a task in the epic's sub-project the guest still reviews, as after
    // their access there was removed with their tasks left on them
    const top = await plantIssue(t, {
      ...base,
      project_id: hiddenSub.id,
      title: 'Top',
      reviewer_id: f.guest.id,
    })
    const r = await expectRefusal(update(t, f, top.id, { parent_id: epic.id }), 'rule')
    expect(r.data.message).toBe(HOLDER_SIGHT_RULE)
    expect(await issueRow(t, top.id)).toEqual(top)
    // the same change passes once nobody holding it is blind to the epic
    await update(t, f, top.id, { reviewer_id: f.user.id })
    await update(t, f, top.id, { parent_id: epic.id })
    expect((await issueRow(t, top.id)).parent_id).toBe(epic.id)
  })

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

  it('refuses moving a task into a sub-project an older subtask already there is held by someone who cannot see it', async () => {
    const t = newT()
    const { f, base, hiddenSub } = await scene(t)
    const top = await plantIssue(t, { ...base, title: 'Top' })
    // stored there before the rule, and reviewed by the guest, who was left
    // on it when their access there was removed
    const kid = await plantIssue(t, {
      ...base,
      project_id: hiddenSub.id,
      parent_id: top.id,
      reviewer_id: f.guest.id,
    })
    const r = await expectRefusal(move(t, f.admin, f, top.id, hiddenSub.id), 'rule')
    expect(r.data.message).toBe(
      moveHolderRule([{ name: f.guest.name, tasks: [issueKey(kid.num)] }]),
    )
    expect(r.data.message).toBe(
      `${f.guest.name} (on ${issueKey(kid.num)}) has no access to that sub-project; give them access there, or change who works on that subtask first`,
    )
    expect(await issueRow(t, top.id)).toEqual(top)
    // once they read it again, the move passes and the family is together
    await grant(t, [hiddenSub.id], f.guest.id, 'viewer')
    await move(t, f.admin, f, top.id, hiddenSub.id)
    expect((await issueRow(t, top.id)).project_id).toBe(hiddenSub.id)
    expect(await issueRow(t, kid.id)).toEqual(kid)
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

  /* Every refusal `move` meets as the share of its transaction a walk may
   * fill (SUBTREE_ROOM) grows by one database query at a time, the finest
   * step a refusal can change at, until it says `whole`. */
  const refusalsByRoom = async (move: () => Promise<unknown>, whole: string) => {
    const said = new Set<string>()
    const saved = { ...SUBTREE_ROOM }
    try {
      for (let queries = 0; queries <= 400 && !said.has(whole); queries++) {
        Object.assign(SUBTREE_ROOM, { room: (queries + 0.5) / 4096, every: 1 })
        said.add((await expectRefusal(move(), 'rule')).data.message)
      }
    } finally {
      Object.assign(SUBTREE_ROOM, saved)
    }
    return [...said].sort()
  }

  it('says others may block a move too once it has no room to check them, and that it is too large before anyone blocks it', async () => {
    const t = newT({ transactionLimits: true })
    const { f, base, hiddenSub } = await scene(t)
    const top = await plantIssue(t, { ...base, title: 'Top' })
    // older subtasks already in the destination, each held by someone who
    // edits only FW
    const kids: Doc<'issues'>[] = []
    for (const name of ['Ada', 'Bea', 'Cy']) {
      const seat = await plantSeat(t, { org_id: f.org.id, name })
      await grant(t, [f.sub.id], seat.id)
      kids.push(
        await plantIssue(t, {
          ...base,
          project_id: hiddenSub.id,
          parent_id: top.id,
          assignee_id: seat.id,
        }),
      )
    }
    const key = (i: number) => issueKey(kids[i].num)
    const blocker = (name: string, i: number) => ({ name, tasks: [key(i)] })
    const all = [blocker('Ada', 0), blocker('Bea', 1), blocker('Cy', 2)]
    // nothing but these, each of them met: too large while nobody blocks
    // it yet, the people found so far with the word that others may block
    // it too, and everyone once the room holds
    expect(
      await refusalsByRoom(() => move(t, f.admin, f, top.id, hiddenSub.id), moveHolderRule(all)),
    ).toEqual(
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
    const { f, hiddenSub, base, epic } = await scene(t)
    const top = await plantIssue(t, { ...base, project_id: hiddenSub.id, assignee_id: f.guest.id })
    await t.run(async (ctx) => {
      const guest = await ctx.db.get(f.guest._id)
      await ctx.db.patch(guest!._id, { active: false })
    })
    await update(t, f, top.id, { parent_id: epic.id })
    expect((await issueRow(t, top.id)).parent_id).toBe(epic.id)
  })

  it('refuses a parent for a task whose only subtask is archived', async () => {
    const t = newT()
    const { f, hiddenSub, base, epic } = await scene(t)
    // a restore from the archive would bring the subtask back below a subtask
    const home = { ...base, project_id: hiddenSub.id }
    const former = await plantIssue(t, home)
    await plantIssue(t, { ...home, parent_id: former.id, archived_at: '2026-01-02T00:00:00.000Z' })
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
