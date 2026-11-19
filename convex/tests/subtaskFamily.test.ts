/* A subtask stays in its parent task's own sub-project. Creating a subtask
 * and setting a parent are refused across sub-projects on every surface, a
 * move to any other sub-project carries the task's subtasks along, and a
 * subtask that moves must leave its parent in the same change.
 * withOrg's TBED holds FW (f.sub) and PCB (f.sub2); the scene adds a second
 * top-level project, Cloud, with the Backend and Frontend sub-projects. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { LIMITS, SUBTASK_WITH_SUBTASKS } from '../lib/limits'
import type { EventOwner } from '../lib/taskEvents'
import { issueKey } from '../lib/taskRefs'
import {
  MOVE_SUBTASK_RULE,
  MOVE_TOO_LARGE,
  moveSubtreeHolderRule,
  parentChainCheck,
  SUBTASK_PROJECT_RULE,
  SUBTREE_ROOM,
  SUBTREE_TOO_LARGE,
} from '../model/issues'
import {
  activityFor,
  as,
  expectRefusal,
  messagesFor,
  newT,
  type OrgFixture,
  plantCopiedIssue,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'

const ARCHIVED = '2026-01-02T00:00:00.000Z'

const grant = (t: T, project_id: string, profile_id: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level: 'user' })
  })

async function scene(t: T) {
  const f = await withReadingAdmin(t)
  const cloud = await plantProject(t, { org_id: f.org.id, key: 'CLD', name: 'Cloud' })
  const sub = { org_id: f.org.id, type: 'project' as const, parent_id: cloud.id }
  const backend = await plantProject(t, { ...sub, key: 'BE', name: 'Backend' })
  const frontend = await plantProject(t, { ...sub, key: 'FE', name: 'Frontend' })
  // the agent writes both top-level projects; the user leads TBED and edits
  // Cloud; the admin, who moves tasks between them, edits Cloud too
  for (const project of [f.meta.id, cloud.id]) await grant(t, project, f.agent.id)
  await grant(t, cloud.id, f.user.id)
  await grant(t, cloud.id, f.admin.id)
  return { f, cloud, backend, frontend }
}

const row = (t: T, id: string): Promise<Doc<'issues'>> =>
  t.run(async (ctx) => {
    const found = await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (found === null) throw new Error('missing task')
    return found
  })

const allIssues = (t: T, orgId: string): Promise<Doc<'issues'>[]> =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
    ).sort((a, b) => a.id.localeCompare(b.id)),
  )

const appMove = (t: T, f: OrgFixture, id: string, project_id: string, detach?: boolean) =>
  as(t, f.admin).mutation(api.issues.move, {
    org_id: f.org.id,
    id,
    project_id,
    ...(detach === undefined ? {} : { detach_parent: detach }),
  })

const appUpdate = (t: T, f: OrgFixture, id: string, patch: Record<string, unknown>) =>
  as(t, f.admin).mutation(api.issues.update, { org_id: f.org.id, id, patch })

const restPatch = (t: T, f: OrgFixture, ref: string, body: Record<string, unknown>) =>
  t.mutation(internal.machine.rest.updateIssue, {
    callerId: f.agent.id,
    access: 'write',
    keyName: 'drive',
    ref,
    body: JSON.stringify(body),
  })

const mcpUpdate = (
  t: T,
  f: OrgFixture,
  args: { ref: string; project?: string; parent?: string | null },
) =>
  t.mutation(internal.machine.mcp.updateIssue, { callerId: f.agent.id, access: 'write', ...args })

/* A task.updated subscription, so each task event lands in the outbox. */
async function subscribeToUpdates(t: T, f: OrgFixture): Promise<void> {
  const owner = await t.run(async (ctx): Promise<EventOwner> => {
    const id = uuid()
    const credential_row_id = await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: f.admin.id,
      name: 'Move events',
      token_prefix: 'qvt_test',
      token_hash: uuid(),
      access: 'read',
      created_at: new Date().toISOString(),
    })
    return {
      profile_id: f.admin.id,
      credential_table: 'mcp_tokens',
      credential_id: id,
      credential_row_id,
    }
  })
  await t.mutation(internal.webhooks.save, {
    owner,
    id: uuid(),
    name: 'task.updated',
    filters: {},
    url: 'https://receiver.example/events',
    encrypted_secret: 'test-only',
  })
}

const updateEvents = (t: T): Promise<string[]> =>
  t.run(async (ctx) =>
    (await ctx.db.query('webhook_events').collect())
      .filter((e) => e.name === 'task.updated')
      .map((e) => e.task_id),
  )

describe('parentChainCheck', () => {
  it('accepts a parent in the same sub-project and names one in any other', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = { id: uuid(), org_id: f.org.id }
    const [own, sibling, elsewhere] = await t.run(async (ctx) => [
      await parentChainCheck(ctx, { ...child, project_id: f.sub.id }, parent.id, f.admin),
      await parentChainCheck(ctx, { ...child, project_id: f.sub2.id }, parent.id, f.admin),
      await parentChainCheck(ctx, { ...child, project_id: backend.id }, parent.id, f.admin),
    ])
    expect(own).toMatchObject({ ok: true, parent: { id: parent.id } })
    expect(sibling).toEqual({ ok: false, problem: 'other_project' })
    expect(elsewhere).toEqual({ ok: false, problem: 'other_project' })
  })
})

describe('creating a subtask and setting a parent', () => {
  it('accepts a parent in the same sub-project', async () => {
    const t = newT()
    const { f } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const made = await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Own subtask',
      parent_id: parent.id,
    })
    expect(made).toMatchObject({ project_id: f.sub.id, parent_id: parent.id })
    const loose = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await appUpdate(t, f, loose.id, { parent_id: parent.id })
    expect((await row(t, loose.id)).parent_id).toBe(parent.id)
  })

  it('refuses a parent in a sibling sub-project or another top-level project on every surface', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const loose = [
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id }),
      await plantIssue(t, { org_id: f.org.id, project_id: backend.id }),
    ]
    const before = await allIssues(t, f.org.id)
    for (const [i, project] of [f.sub2.id, backend.id].entries()) {
      // each call starts once the one before was refused, so none rejects
      // before its refusal is awaited
      const attempts = [
        () =>
          as(t, f.admin).mutation(api.issues.create, {
            org_id: f.org.id,
            id: uuid(),
            project_id: project,
            title: 'Across',
            parent_id: parent.id,
          }),
        () =>
          t.mutation(internal.machine.rest.createIssue, {
            callerId: f.agent.id,
            access: 'write',
            keyName: 'drive',
            body: JSON.stringify({ project, title: 'Across', parent: parent.id }),
          }),
        () =>
          t.mutation(internal.machine.mcp.createIssue, {
            callerId: f.agent.id,
            access: 'write',
            project,
            title: 'Across',
            parent: parent.id,
          }),
        // setting the parent of a task that is already there
        () => appUpdate(t, f, loose[i].id, { parent_id: parent.id }),
        () => restPatch(t, f, loose[i].id, { parent: parent.id }),
        () => mcpUpdate(t, f, { ref: loose[i].id, parent: parent.id }),
      ]
      for (const attempt of attempts) {
        const r = await expectRefusal(attempt(), 'rule')
        expect(r.data.message).toBe(SUBTASK_PROJECT_RULE)
      }
    }
    expect(await allIssues(t, f.org.id)).toEqual(before)
  })
})

describe('moving a task with subtasks', () => {
  it('carries its subtasks to a sibling sub-project, archived ones included, in one message and one activity row', async () => {
    const t = newT()
    const { f } = await scene(t)
    await subscribeToUpdates(t, f)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, { ...base, title: 'Release' })
    const kid = await plantIssue(t, { ...base, parent_id: root.id })
    const sibling = await plantIssue(t, { ...base, parent_id: root.id })
    const old = await plantIssue(t, { ...base, parent_id: root.id, archived_at: ARCHIVED })
    for (const id of [root.id, kid.id])
      await plantSubscription(t, { issue_id: id, profile_id: f.user.id })
    await appMove(t, f, root.id, f.sub2.id)
    for (const moved of [root, kid, sibling, old]) {
      const after = await row(t, moved.id)
      expect(after.project_id).toBe(f.sub2.id)
      expect([after.parent_id, after.archived_at]).toEqual([moved.parent_id, moved.archived_at])
    }
    // the task's followers hear about the move once; the subtasks' do not
    expect((await messagesFor(t, f.user.id, root.id)).map((m) => m.detail)).toEqual([
      'Moved to Board rev',
    ])
    expect(await messagesFor(t, f.user.id, kid.id)).toEqual([])
    const rows = (await activityFor(t, f.org.id)).filter((e) => e.verb === 'moved')
    expect(rows.map((e) => [e.target_id, e.detail])).toEqual([
      [root.id, 'to the Board rev sub-project (from Firmware) with its subtasks'],
    ])
    // one task.updated for the task and one for each subtask that moved
    expect((await updateEvents(t)).sort()).toEqual([root.id, kid.id, sibling.id, old.id].sort())
  })

  it('refuses by name when a subtask it carries has an assignee who cannot edit the destination', async () => {
    const t = newT()
    const { f } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    // Nia edits Firmware alone
    const nia = await plantSeat(t, { org_id: f.org.id, name: 'Nia None' })
    await grant(t, f.sub.id, nia.id)
    const root = await plantIssue(t, base)
    const kid = await plantIssue(t, { ...base, parent_id: root.id, assignee_id: nia.id })
    const before = await allIssues(t, f.org.id)
    const r = await expectRefusal(appMove(t, f, root.id, f.sub2.id), 'rule')
    expect(r.data.message).toBe(
      `Nia None (on ${issueKey(kid.num)}) cannot edit that sub-project; give them Edit access there, or change who works on that subtask first`,
    )
    expect(await allIssues(t, f.org.id)).toEqual(before)
    // once she edits the destination too, the move carries her subtask there
    await grant(t, f.sub2.id, nia.id)
    await appMove(t, f, root.id, f.sub2.id)
    expect(await row(t, kid.id)).toMatchObject({
      project_id: f.sub2.id,
      parent_id: root.id,
      assignee_id: nia.id,
    })
  })

  it('refuses a subtask that would leave its parent behind, unless it leaves it in the app', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, base)
    const child = await plantIssue(t, { ...base, parent_id: parent.id })
    const before = await allIssues(t, f.org.id)
    for (const project of [f.sub2.id, backend.id])
      for (const detach of [undefined, false]) {
        const r = await expectRefusal(appMove(t, f, child.id, project, detach), 'rule')
        expect(r.data.message).toBe(MOVE_SUBTASK_RULE)
      }
    expect(await allIssues(t, f.org.id)).toEqual(before)
    await appMove(t, f, child.id, f.sub2.id, true)
    const after = await row(t, child.id)
    expect(after.project_id).toBe(f.sub2.id)
    expect(after.parent_id).toBeUndefined()
    const rows = (await activityFor(t, f.org.id)).filter((e) => e.target_id === child.id)
    expect(rows.map((e) => [e.verb, e.detail])).toEqual([
      ['moved', 'to the Board rev sub-project (from Firmware)'],
      ['detached', `from QN-${parent.num}`],
    ])
    // only the detach names a task
    expect(rows.map((e) => e.named_task_nums)).toEqual([[], [parent.num]])
  })

  it('takes the parent change in the same REST or MCP request', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, base)
    const first = await plantIssue(t, { ...base, parent_id: parent.id })
    const second = await plantIssue(t, { ...base, parent_id: parent.id })
    const elsewhere = await plantIssue(t, { ...base, project_id: backend.id })
    const there = await plantIssue(t, { ...base, project_id: f.sub2.id })
    const before = await allIssues(t, f.org.id)
    const refusals = [
      restPatch(t, f, first.id, { project: f.sub2.id }),
      // the parent it has stays in Firmware
      restPatch(t, f, first.id, { project: f.sub2.id, parent: parent.id }),
      mcpUpdate(t, f, { ref: second.id, project: f.sub2.id }),
      // a new parent that is not in the destination
      mcpUpdate(t, f, { ref: second.id, project: f.sub2.id, parent: elsewhere.id }),
    ]
    for (const attempt of refusals) {
      const r = await expectRefusal(attempt, 'rule')
      expect(r.data.message).toBe(MOVE_SUBTASK_RULE)
    }
    // a top-level task moved there with a parent elsewhere meets the parent rule
    const r = await expectRefusal(
      mcpUpdate(t, f, { ref: elsewhere.id, project: f.sub2.id, parent: parent.id }),
      'rule',
    )
    expect(r.data.message).toBe(SUBTASK_PROJECT_RULE)
    expect(await allIssues(t, f.org.id)).toEqual(before)
    const patched = await restPatch(t, f, first.id, { project: f.sub2.id, parent: null })
    expect(patched).toMatchObject({ project_id: f.sub2.id, parent_id: null })
    await mcpUpdate(t, f, { ref: second.id, project: f.sub2.id, parent: there.id })
    expect(await row(t, second.id)).toMatchObject({ project_id: f.sub2.id, parent_id: there.id })
  })

  it('refuses people who cannot work there and too many', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, base)
    // the guest edits TBED but nothing in Cloud
    const kid = await plantIssue(t, { ...base, parent_id: root.id, assignee_id: f.guest.id })
    const named = moveSubtreeHolderRule([{ name: f.guest.name, tasks: [issueKey(kid.num)] }])
    expect(named).toBe(
      `${f.guest.name} (on ${issueKey(kid.num)}) cannot edit that sub-project; give them Edit access there, or change who works on that subtask first`,
    )
    const holder = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
    expect(holder.data.message).toBe(named)
    // a subtask has no subtasks of its own, so its reviewer is checked too
    await t.run(async (ctx) => {
      await ctx.db.patch(kid._id, { assignee_id: undefined, reviewer_id: f.guest.id })
    })
    const reviewer = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
    expect(reviewer.data.message).toBe(named)
    // two people who cannot work there are named together, each once
    const nia = await plantSeat(t, { org_id: f.org.id, name: 'Nia None' })
    await t.run(async (ctx) => {
      await ctx.db.patch(kid._id, { assignee_id: nia.id })
    })
    const both = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
    expect(both.data.message).toBe(
      `Nia None (on ${issueKey(kid.num)}) and ${f.guest.name} (on ${issueKey(kid.num)}) cannot edit that sub-project; give them Edit access there, or change who works on that subtask first`,
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(kid._id, { assignee_id: undefined })
    })
    // with no room left once someone blocks the move, the walk stops there
    // and says that others may block it too, where a move with room names
    // the next subtask's person as well
    const second = await plantIssue(t, { ...base, parent_id: root.id, assignee_id: nia.id })
    const saved = { ...SUBTREE_ROOM }
    Object.assign(SUBTREE_ROOM, { room: 0 })
    try {
      const stopped = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
      expect(stopped.data.message).toBe(
        `${f.guest.name} (on ${issueKey(kid.num)}) and possibly others cannot edit that sub-project; give them Edit access there, or change who works on those subtasks first`,
      )
    } finally {
      Object.assign(SUBTREE_ROOM, saved)
    }
    const whole = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
    expect(whole.data.message).toBe(
      moveSubtreeHolderRule([
        { name: f.guest.name, tasks: [issueKey(kid.num)] },
        { name: 'Nia None', tasks: [issueKey(second.num)] },
      ]),
    )
    await t.run(async (ctx) => {
      await ctx.db.delete(second._id)
      await ctx.db.patch(kid._id, { reviewer_id: undefined })
    })
    // more than the limit at one level, archived subtasks included: with
    // kid, LIMITS.subtasks.max active ones and the rest archived
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.moveSubtree.max; i++) {
        await ctx.db.insert('issues', {
          ...base,
          id: uuid(),
          num: 1000 + i,
          title: `Step ${i}`,
          description: '',
          status: 'todo',
          priority: 'low',
          paused: false,
          parent_id: root.id,
          archived_at: i < LIMITS.subtasks.max - 1 ? undefined : ARCHIVED,
          created_at: ARCHIVED,
          updated_at: ARCHIVED,
        })
      }
    })
    const crowded = await allIssues(t, f.org.id)
    // every move of the task carries them, to a sibling sub-project too
    for (const project of [backend.id, f.sub2.id]) {
      const tooMany = await expectRefusal(appMove(t, f, root.id, project), 'rule')
      expect(tooMany.data.message).toBe(LIMITS.moveSubtree.refusal)
    }
    expect(await allIssues(t, f.org.id)).toEqual(crowded)
    // at the limit the move lands, every subtask with it
    const last = crowded.find((i) => i.title === `Step ${LIMITS.moveSubtree.max - 1}`)!
    await t.run(async (ctx) => {
      await ctx.db.delete(last._id)
    })
    await appMove(t, f, root.id, backend.id)
    const moved = (await allIssues(t, f.org.id)).filter((i) => i.project_id === backend.id)
    expect(moved.map((i) => i.id).sort()).toEqual(
      crowded
        .filter((i) => i.id === root.id || (i.parent_id === root.id && i.id !== last.id))
        .map((i) => i.id)
        .sort(),
    )
    expect(moved).toHaveLength(LIMITS.moveSubtree.max + 1)
  })
})

describe('a move, archive or parent change too large for one transaction', () => {
  /* Runs `body` with SUBTREE_ROOM lowered so that `every`th read or row of
   * a walk, or the row that brings the sizes read to `bytes`, finds the
   * transaction full. */
  const crowdedRoom = async (
    every: number,
    body: () => Promise<void>,
    bytes = SUBTREE_ROOM.bytes,
  ) => {
    const saved = { ...SUBTREE_ROOM }
    Object.assign(SUBTREE_ROOM, { room: 0, every, bytes })
    try {
      await body()
    } finally {
      Object.assign(SUBTREE_ROOM, saved)
    }
  }

  it('refuses with a plain sentence and changes nothing, where a smaller one passes', async () => {
    // convex-test reports a transaction's use only under its limits
    const t = newT({ transactionLimits: true })
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, base)
    for (let i = 0; i < 3; i++) await plantIssue(t, { ...base, parent_id: root.id })
    const carrier = await plantIssue(t, base)
    const carried = await plantIssue(t, { ...base, parent_id: carrier.id })
    const other = await plantIssue(t, { ...base, project_id: f.sub2.id })
    const newKid = await plantIssue(t, base)
    const archive = (id: string) =>
      as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id, reason: 'On hold' })
    const before = await allIssues(t, f.org.id)
    await crowdedRoom(4, async () => {
      // each walk of the root's three subtasks checks once before its range
      // and once after each row, so the third row finds the transaction full
      for (const [change, sentence] of [
        // a move to a sibling sub-project, before each task it patches
        [() => appMove(t, f, root.id, f.sub2.id), MOVE_TOO_LARGE],
        // a new subtask, for the count of the parent's subtasks
        [() => appUpdate(t, f, newKid.id, { parent_id: root.id }), SUBTREE_TOO_LARGE],
        // an archive, for the subtasks it archives with the task
        [() => archive(root.id), SUBTREE_TOO_LARGE],
        // a move to another top-level project, the same way
        [() => appMove(t, f, carrier.id, backend.id), MOVE_TOO_LARGE],
      ] as const) {
        const r = await expectRefusal(change(), 'rule')
        expect(r.data.message).toBe(sentence)
      }
    })
    expect(await allIssues(t, f.org.id)).toEqual(before)
    // with room to spare, all four pass
    await appUpdate(t, f, newKid.id, { parent_id: root.id })
    expect((await row(t, newKid.id)).parent_id).toBe(root.id)
    await appMove(t, f, root.id, f.sub2.id)
    await appMove(t, f, carrier.id, backend.id)
    for (const moved of [carrier, carried]) {
      expect((await row(t, moved.id)).project_id).toBe(backend.id)
    }
    // the root has subtasks, so it takes no parent itself
    const r = await expectRefusal(appUpdate(t, f, root.id, { parent_id: other.id }), 'rule')
    expect(r.data.message).toBe(SUBTASK_WITH_SUBTASKS)
    await archive(root.id)
    const family = (await allIssues(t, f.org.id)).filter(
      (i) => i.id === root.id || i.parent_id === root.id,
    )
    expect(family).toHaveLength(5)
    for (const task of family) {
      expect(task.archived_at).toBeDefined()
      expect(task.project_id).toBe(f.sub2.id)
    }
  })

  it('reads only the active subtasks under a real limit, however many are archived', async () => {
    // a limit of 400 documents read, and a task with LIMITS.subtasks.max active
    // subtasks and 1,000 archived ones: a walk that read the archived ones
    // would fail on the limit
    const t = newT({ transactionLimits: { documentsRead: 400 } })
    const { f, backend } = await scene(t)
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.subtasks.max + 1000; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          parent_id: root.id,
          num: 900_000 + i,
          title: `Step ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          archived_at: i < LIMITS.subtasks.max ? undefined : ARCHIVED,
          created_at: root.created_at,
          updated_at: root.updated_at,
        })
    })
    const activeUnder = () =>
      t.run(
        async (ctx) =>
          (
            await ctx.db
              .query('issues')
              .withIndex('by_parent_archived', (q) =>
                q.eq('parent_id', root.id).eq('archived_at', undefined),
              )
              .collect()
          ).length,
      )
    // a new subtask counts no further than the limit, and is refused there
    const p = await expectRefusal(appUpdate(t, f, other.id, { parent_id: root.id }), 'rule')
    expect(p.data.message).toBe(LIMITS.subtasks.refusal)
    expect(await row(t, other.id)).toEqual(other)
    // a move, which carries the archived ones too, stops reading past
    // LIMITS.moveSubtree.max, to a sibling sub-project as to another
    // top-level project
    for (const project of [f.sub2.id, backend.id]) {
      const m = await expectRefusal(appMove(t, f, root.id, project), 'rule')
      expect(m.data.message).toBe(LIMITS.moveSubtree.refusal)
    }
    expect((await row(t, root.id)).project_id).toBe(f.sub.id)
    // the archive takes the active subtasks with it
    expect(await activeUnder()).toBe(LIMITS.subtasks.max)
    await as(t, f.admin).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: root.id,
      reason: 'On hold',
    })
    expect((await row(t, root.id)).archived_at).toBeDefined()
    expect(await activeUnder()).toBe(0)
  })

  it("checks sooner after a subtask with a long description, as it counts the parent's subtasks", async () => {
    const t = newT({ transactionLimits: true })
    const { f } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const short = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: short.id, description: 'Notes.' })
    const long = await plantIssue(t, base)
    // its task row holds the text, as a rollback to the second release
    // writes it
    await plantCopiedIssue(t, { ...base, parent_id: long.id, description: 'x'.repeat(7000) })
    const [one, two] = [await plantIssue(t, base), await plantIssue(t, base)]
    // no check by count, only by size: 6 KiB is past the long subtask's
    // task row alone, and short of the short one's
    await crowdedRoom(
      1e9,
      async () => {
        const r = await expectRefusal(appUpdate(t, f, one.id, { parent_id: long.id }), 'rule')
        expect(r.data.message).toBe(SUBTREE_TOO_LARGE)
        await appUpdate(t, f, two.id, { parent_id: short.id })
      },
      6 * 1024,
    )
    expect((await row(t, one.id)).parent_id).toBeUndefined()
    expect((await row(t, two.id)).parent_id).toBe(short.id)
  })
})

describe('a parent whose subtasks are too large to count', () => {
  it('refuses with the plain sentence under a real read limit, and changes nothing', async () => {
    // ten subtasks of about 6 KB, each description an ordinary text of 6,000
    // characters in the task row too, as a rollback to the second release
    // writes it, read within a limit of 66 KB with SUBTREE_ROOM.bytes at a
    // tenth: the count asks once the nine rows before it may hold those
    // bytes, and is past the room by then
    const t = newT({ transactionLimits: { bytesRead: 66_000 } })
    const { f } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const heavy = await plantIssue(t, base)
    for (let i = 0; i < 10; i++)
      await plantCopiedIssue(t, {
        ...base,
        parent_id: heavy.id,
        description: 'Check the bracket fit and the cable route before the next build. '.repeat(91),
      })
    const light = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: light.id })
    const other = await plantIssue(t, base)
    const saved = { ...SUBTREE_ROOM }
    Object.assign(SUBTREE_ROOM, { bytes: 51_200 })
    try {
      const r = await expectRefusal(appUpdate(t, f, other.id, { parent_id: heavy.id }), 'rule')
      expect(r.data.message).toBe(SUBTREE_TOO_LARGE)
      expect(await row(t, other.id)).toEqual(other)
      await appUpdate(t, f, other.id, { parent_id: light.id })
    } finally {
      Object.assign(SUBTREE_ROOM, saved)
    }
    expect((await row(t, other.id)).parent_id).toBe(light.id)
  })
})

describe('asking whether a move carries subtasks', () => {
  it('counts archived subtasks, which the app cannot see, for any other sub-project', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const ask = (id: string, project_id: string, who = f.admin) =>
      as(t, who).query(api.issues.moveCarriesSubtasks, { org_id: f.org.id, id, project_id })
    // the only subtask is archived
    const root = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: root.id, archived_at: ARCHIVED })
    for (const project of [backend.id, f.sub2.id]) expect(await ask(root.id, project)).toBe(true)
    // no subtasks
    const lone = await plantIssue(t, base)
    expect(await ask(lone.id, backend.id)).toBe(false)
    // the guest edits TBED but not Cloud, so the answer tells them nothing
    expect(await ask(root.id, backend.id, f.guest)).toBe(false)
  })
})
