/* A subtask stays in its parent task's top-level project, in any of its
 * sub-projects. Creating a subtask and setting a parent are refused across
 * top-level projects on every surface, a move to another top-level project
 * carries the task's subtasks along, and a subtask moved there must leave
 * its parent in the same change. withOrg's TBED holds FW (f.sub) and PCB
 * (f.sub2); the scene adds a second top-level project, Cloud, with the
 * Backend and Frontend sub-projects. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { EventOwner } from '../lib/taskEvents'
import { PARENT_FULL, SUBTASK_WITH_SUBTASKS } from '../lib/taskLimits'
import {
  ARCHIVE_TOO_LARGE,
  MOVE_SUBTASK_RULE,
  MOVE_SUBTREE_EDIT_RULE,
  MOVE_SUBTREE_HOLDER_RULE,
  MOVE_SUBTREE_MAX,
  MOVE_SUBTREE_TOO_LARGE,
  PARENT_TOO_LARGE,
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
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const ARCHIVED = '2026-01-02T00:00:00.000Z'

const grant = (t: T, project_id: string, profile_id: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level: 'user' })
  })

async function scene(t: T) {
  const f = await withOrg(t)
  const cloud = await plantProject(t, { org_id: f.org.id, key: 'CLD', name: 'Cloud' })
  const sub = { org_id: f.org.id, type: 'project' as const, parent_id: cloud.id }
  const backend = await plantProject(t, { ...sub, key: 'BE', name: 'Backend' })
  const frontend = await plantProject(t, { ...sub, key: 'FE', name: 'Frontend' })
  // the agent writes both top-level projects; the user leads TBED and edits Cloud
  for (const project of [f.meta.id, cloud.id]) await grant(t, project, f.agent.id)
  await grant(t, cloud.id, f.user.id)
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
  it('names a parent in another top-level project and accepts a sibling sub-project', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = { id: uuid(), org_id: f.org.id }
    const [elsewhere, sibling] = await t.run(async (ctx) => [
      await parentChainCheck(ctx, { ...child, project_id: backend.id }, parent.id, f.admin),
      await parentChainCheck(ctx, { ...child, project_id: f.sub2.id }, parent.id, f.admin),
    ])
    expect(elsewhere).toEqual({ ok: false, problem: 'other_project' })
    expect(sibling).toMatchObject({ ok: true, parent: { id: parent.id } })
  })
})

describe('creating a subtask and setting a parent', () => {
  it('accepts a parent in another sub-project of the same top-level project', async () => {
    const t = newT()
    const { f } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const made = await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub2.id,
      title: 'Sibling subtask',
      parent_id: parent.id,
    })
    expect(made).toMatchObject({ project_id: f.sub2.id, parent_id: parent.id })
    const loose = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await appUpdate(t, f, loose.id, { parent_id: parent.id })
    expect((await row(t, loose.id)).parent_id).toBe(parent.id)
  })

  it('refuses a parent in another top-level project on every surface', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const before = await allIssues(t, f.org.id)
    const attempts = [
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: backend.id,
        title: 'Across',
        parent_id: parent.id,
      }),
      t.mutation(internal.machine.rest.createIssue, {
        callerId: f.agent.id,
        access: 'write',
        keyName: 'drive',
        body: JSON.stringify({ project: backend.id, title: 'Across', parent: parent.id }),
      }),
      t.mutation(internal.machine.mcp.createIssue, {
        callerId: f.agent.id,
        access: 'write',
        project: backend.id,
        title: 'Across',
        parent: parent.id,
      }),
    ]
    for (const attempt of attempts) {
      const r = await expectRefusal(attempt, 'rule')
      expect(r.data.message).toBe(SUBTASK_PROJECT_RULE)
    }
    // setting the parent of a task that is already there
    const loose = await plantIssue(t, { org_id: f.org.id, project_id: backend.id })
    const r1 = await expectRefusal(appUpdate(t, f, loose.id, { parent_id: parent.id }), 'rule')
    const r2 = await expectRefusal(restPatch(t, f, loose.id, { parent: parent.id }), 'rule')
    for (const r of [r1, r2]) expect(r.data.message).toBe(SUBTASK_PROJECT_RULE)
    expect(await allIssues(t, f.org.id)).toEqual(
      [...before, loose].sort((a, b) => a.id.localeCompare(b.id)),
    )
  })
})

describe('moving a task within its top-level project', () => {
  it('keeps the parent and leaves the subtasks where they are', async () => {
    const t = newT()
    const { f } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const epic = await plantIssue(t, base)
    const group = await plantIssue(t, { ...base, parent_id: epic.id })
    const leaf = await plantIssue(t, { ...base, parent_id: group.id })
    await appMove(t, f, group.id, f.sub2.id)
    expect(await row(t, group.id)).toMatchObject({ project_id: f.sub2.id, parent_id: epic.id })
    expect(await row(t, leaf.id)).toEqual(leaf)
    expect(await row(t, epic.id)).toEqual(epic)
  })
})

describe('moving a task to another top-level project', () => {
  it('carries its subtasks, archived ones included, in one message and one activity row', async () => {
    const t = newT()
    const { f, backend, frontend } = await scene(t)
    await subscribeToUpdates(t, f)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, { ...base, title: 'Release' })
    const kid = await plantIssue(t, { ...base, project_id: f.sub2.id, parent_id: root.id })
    const old = await plantIssue(t, { ...base, parent_id: root.id, archived_at: ARCHIVED })
    const grandkid = await plantIssue(t, { ...base, parent_id: kid.id })
    const deep = await plantIssue(t, { ...base, parent_id: grandkid.id, archived_at: ARCHIVED })
    // an older subtask already in Cloud stays in its sub-project
    const settled = await plantIssue(t, { ...base, project_id: frontend.id, parent_id: kid.id })
    for (const id of [root.id, kid.id])
      await plantSubscription(t, { issue_id: id, profile_id: f.user.id })
    await appMove(t, f, root.id, backend.id)
    for (const moved of [root, kid, old, grandkid, deep]) {
      const after = await row(t, moved.id)
      expect(after.project_id).toBe(backend.id)
      expect([after.parent_id, after.archived_at]).toEqual([moved.parent_id, moved.archived_at])
    }
    expect(await row(t, settled.id)).toEqual(settled)
    // the task's followers hear about the move once; the subtasks' do not
    expect((await messagesFor(t, f.user.id, root.id)).map((m) => m.detail)).toEqual([
      'Moved to Backend',
    ])
    expect(await messagesFor(t, f.user.id, kid.id)).toEqual([])
    const rows = (await activityFor(t, f.org.id)).filter((e) => e.verb === 'moved')
    expect(rows.map((e) => [e.target_id, e.detail])).toEqual([
      [root.id, 'to the Backend sub-project (from Firmware) with its subtasks'],
    ])
    // one task.updated for the task and one for each subtask that moved
    expect((await updateEvents(t)).sort()).toEqual(
      [root.id, kid.id, old.id, grandkid.id, deep.id].sort(),
    )
  })

  it('refuses a subtask that would stay under its parent, unless it leaves it in the app', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, base)
    const child = await plantIssue(t, { ...base, parent_id: parent.id })
    const before = await allIssues(t, f.org.id)
    for (const detach of [undefined, false]) {
      const r = await expectRefusal(appMove(t, f, child.id, backend.id, detach), 'rule')
      expect(r.data.message).toBe(MOVE_SUBTASK_RULE)
    }
    expect(await allIssues(t, f.org.id)).toEqual(before)
    await appMove(t, f, child.id, backend.id, true)
    const after = await row(t, child.id)
    expect(after.project_id).toBe(backend.id)
    expect(after.parent_id).toBeUndefined()
    const rows = (await activityFor(t, f.org.id)).filter((e) => e.target_id === child.id)
    expect(rows.map((e) => [e.verb, e.detail])).toEqual([
      ['moved', 'to the Backend sub-project (from Firmware)'],
      ['detached', `from QN-${parent.num}`],
    ])
    // consecutive numbers, and only the detach names a task
    expect(rows.map((e) => [e.seq, e.named_task_nums])).toEqual([
      [1, []],
      [2, [parent.num]],
    ])
  })

  it('takes the parent change in the same REST or MCP request', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, base)
    const first = await plantIssue(t, { ...base, parent_id: parent.id })
    const second = await plantIssue(t, { ...base, parent_id: parent.id })
    const elsewhere = await plantIssue(t, { ...base, project_id: f.sub2.id })
    const there = await plantIssue(t, { ...base, project_id: backend.id })
    const mcpUpdate = (args: { ref: string; project: string; parent?: string | null }) =>
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ...args,
      })
    const before = await allIssues(t, f.org.id)
    const refusals = [
      restPatch(t, f, first.id, { project: backend.id }),
      restPatch(t, f, first.id, { project: backend.id, parent: parent.id }),
      mcpUpdate({ ref: second.id, project: backend.id }),
      // a new parent that is not in the destination's top-level project
      mcpUpdate({ ref: second.id, project: backend.id, parent: elsewhere.id }),
    ]
    for (const attempt of refusals) {
      const r = await expectRefusal(attempt, 'rule')
      expect(r.data.message).toBe(MOVE_SUBTASK_RULE)
    }
    // a top-level task moved there with a parent elsewhere meets the parent rule
    const r = await expectRefusal(
      mcpUpdate({ ref: elsewhere.id, project: backend.id, parent: parent.id }),
      'rule',
    )
    expect(r.data.message).toBe(SUBTASK_PROJECT_RULE)
    expect(await allIssues(t, f.org.id)).toEqual(before)
    const patched = await restPatch(t, f, first.id, { project: backend.id, parent: null })
    expect(patched).toMatchObject({ project_id: backend.id, parent_id: null })
    await mcpUpdate({ ref: second.id, project: backend.id, parent: there.id })
    expect(await row(t, second.id)).toMatchObject({ project_id: backend.id, parent_id: there.id })
  })

  it('refuses subtasks the caller cannot edit, people who cannot work there and too many', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    // someone who edits FW and Backend but not PCB
    const editor = await plantSeat(t, { org_id: f.org.id, auth_user_id: `editor_${uuid()}` })
    for (const project of [f.sub.id, backend.id]) await grant(t, project, editor.id)
    const root = await plantIssue(t, base)
    const inPcb = await plantIssue(t, { ...base, project_id: f.sub2.id, parent_id: root.id })
    const asEditor = as(t, editor).mutation(api.issues.move, {
      org_id: f.org.id,
      id: root.id,
      project_id: backend.id,
    })
    expect((await expectRefusal(asEditor, 'rule')).data.message).toBe(MOVE_SUBTREE_EDIT_RULE)
    expect(await row(t, root.id)).toEqual(root)
    // the guest edits TBED but nothing in Cloud
    await t.run(async (ctx) => {
      await ctx.db.patch(inPcb._id, { assignee_id: f.guest.id })
    })
    const holder = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
    expect(holder.data.message).toBe(MOVE_SUBTREE_HOLDER_RULE)
    // as a group's dormant reviewer the guest is cleared instead
    await t.run(async (ctx) => {
      await ctx.db.patch(inPcb._id, { assignee_id: undefined, reviewer_id: f.guest.id })
    })
    await plantIssue(t, { ...base, parent_id: inPcb.id })
    // more than the limit, archived subtasks included
    await t.run(async (ctx) => {
      for (let i = 0; i < MOVE_SUBTREE_MAX - 1; i++) {
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
          archived_at: i % 2 ? ARCHIVED : undefined,
          created_at: ARCHIVED,
          updated_at: ARCHIVED,
        })
      }
    })
    const crowded = await allIssues(t, f.org.id)
    const tooMany = await expectRefusal(appMove(t, f, root.id, backend.id), 'rule')
    expect(tooMany.data.message).toBe(MOVE_SUBTREE_TOO_LARGE)
    expect(await allIssues(t, f.org.id)).toEqual(crowded)
    // at the limit the move lands, and the group's reviewer is cleared
    const last = crowded.find((i) => i.title === `Step ${MOVE_SUBTREE_MAX - 2}`)!
    await t.run(async (ctx) => {
      await ctx.db.delete(last._id)
    })
    await appMove(t, f, root.id, backend.id)
    const moved = await row(t, inPcb.id)
    expect(moved.project_id).toBe(backend.id)
    expect(moved.reviewer_id).toBeUndefined()
  })
})

describe("older subtasks outside their parent's top-level project", () => {
  it('stay editable and move within their project and into their parent one', async () => {
    const t = newT()
    const { f, backend, frontend } = await scene(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const stray = await plantIssue(t, {
      org_id: f.org.id,
      project_id: backend.id,
      parent_id: parent.id,
    })
    await appUpdate(t, f, stray.id, { title: 'Still editable', status: 'progress' })
    await appMove(t, f, stray.id, frontend.id)
    expect(await row(t, stray.id)).toMatchObject({ project_id: frontend.id, parent_id: parent.id })
    await appMove(t, f, stray.id, f.sub2.id)
    expect(await row(t, stray.id)).toMatchObject({
      project_id: f.sub2.id,
      parent_id: parent.id,
      title: 'Still editable',
      status: 'progress',
    })
  })
})

describe('an older subtask whose parent the mover cannot see', () => {
  it('moves to another top-level project only when it leaves the parent, wherever the parent is', async () => {
    const t = newT()
    const { f, backend } = await scene(t)
    // Vault's Open sub-project is the agent's; its Closed one is not, so the
    // agent sees Vault only for navigation and cannot see the parent
    const vault = await plantProject(t, { org_id: f.org.id, key: 'VLT', name: 'Vault' })
    const under = { org_id: f.org.id, type: 'project' as const, parent_id: vault.id }
    const open = await plantProject(t, { ...under, key: 'OPN', name: 'Open' })
    const closed = await plantProject(t, { ...under, key: 'CLS', name: 'Closed' })
    await grant(t, open.id, f.agent.id)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: closed.id })
    const elsewhere = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const strays = []
    for (const parent_id of [parent.id, elsewhere.id]) {
      // the agent cannot see the TBED parent either once its grant goes below
      strays.push(await plantIssue(t, { org_id: f.org.id, project_id: backend.id, parent_id }))
    }
    await t.run(async (ctx) => {
      const tbed = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.agent.id),
        )
        .unique()
      await ctx.db.delete(tbed!._id)
    })
    // the parent under Vault and the one under TBED answer alike
    for (const stray of strays) {
      const r = await expectRefusal(
        restPatch(t, f, `QN-${stray.num}`, { project: open.id }),
        'rule',
      )
      expect(r.data.message).toBe(MOVE_SUBTASK_RULE)
      expect(await row(t, stray.id)).toEqual(stray)
    }
    // leaving the parent in the same request moves it
    await restPatch(t, f, `QN-${strays[0].num}`, { project: open.id, parent: null })
    const moved = await row(t, strays[0].id)
    expect([moved.project_id, moved.parent_id]).toEqual([open.id, undefined])
  })
})

describe('a move or a parent change too large for one transaction', () => {
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
    const kids = []
    for (let i = 0; i < 3; i++) kids.push(await plantIssue(t, { ...base, parent_id: root.id }))
    for (const kid of kids) await plantIssue(t, { ...base, parent_id: kid.id })
    const other = await plantIssue(t, { ...base, project_id: f.sub2.id })
    const lone = await plantIssue(t, base)
    const newKid = await plantIssue(t, base)
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++)
        await ctx.db.insert('issue_attachments', {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          issue_id: lone.id,
          name: `notes ${i}.txt`,
          size_bytes: 1,
          storage_id: await ctx.storage.store(new Blob() as never),
          inline: false,
          created_at: f.org.created_at,
        })
    })
    const before = await allIssues(t, f.org.id)
    await crowdedRoom(4, async () => {
      // a move within TBED walks the four tasks under the root's three
      // children for their holders, and a new subtask counts the root's
      // three children
      for (const [change, sentence] of [
        [() => appMove(t, f, root.id, f.sub2.id), SUBTREE_TOO_LARGE],
        [() => appUpdate(t, f, newKid.id, { parent_id: root.id }), PARENT_TOO_LARGE],
        // the task's four attachment rows
        [() => appMove(t, f, lone.id, backend.id), SUBTREE_TOO_LARGE],
      ] as const) {
        const r = await expectRefusal(change(), 'rule')
        expect(r.data.message).toBe(sentence)
      }
    })
    expect(await allIssues(t, f.org.id)).toEqual(before)
    // with room to spare, all three pass
    await appMove(t, f, root.id, f.sub2.id)
    await appUpdate(t, f, newKid.id, { parent_id: root.id })
    await appMove(t, f, lone.id, backend.id)
    expect((await row(t, newKid.id)).parent_id).toBe(root.id)
    // the legacy root has subtasks, so it takes no parent itself
    const r = await expectRefusal(appUpdate(t, f, root.id, { parent_id: other.id }), 'rule')
    expect(r.data.message).toBe(SUBTASK_WITH_SUBTASKS)
    expect((await row(t, lone.id)).project_id).toBe(backend.id)
    const moved = await t.run((ctx) =>
      ctx.db
        .query('issue_attachments')
        .withIndex('by_issue', (q) => q.eq('issue_id', lone.id))
        .collect(),
    )
    expect(moved.map((file) => file.project_id)).toEqual(Array(4).fill(backend.id))
  })

  it('refuses a walk that would pass a real limit, as it stands', async () => {
    // a limit of 1,000 index ranges, and 1,200 subtasks under one task from
    // before the subtask limits, each a range of the walk
    const t = newT({ transactionLimits: { databaseQueries: 1000 } })
    const { f } = await scene(t)
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 1200; i++)
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
          created_at: root.created_at,
          updated_at: root.updated_at,
        })
    })
    const r = await expectRefusal(appMove(t, f, root.id, f.sub2.id), 'rule')
    expect(r.data.message).toBe(SUBTREE_TOO_LARGE)
    // archiving walks every subtask too, and refuses as plainly (#4)
    const a = await expectRefusal(
      as(t, f.admin).mutation(api.issues.archive, {
        org_id: f.org.id,
        id: root.id,
        reason: 'On hold',
      }),
      'rule',
    )
    expect(a.data.message).toBe(ARCHIVE_TOO_LARGE)
    // a new subtask counts no further than the limit, and is refused there
    const p = await expectRefusal(appUpdate(t, f, other.id, { parent_id: root.id }), 'rule')
    expect(p.data.message).toBe(PARENT_FULL)
    expect(await row(t, root.id)).toEqual(root)
    expect(await row(t, other.id)).toEqual(other)
  })

  it('checks sooner after a subtask with a long description', async () => {
    const t = newT({ transactionLimits: true })
    const { f } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const short = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: short.id, description: 'Notes.' })
    const long = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: long.id, description: 'x'.repeat(2000) })
    const other = await plantIssue(t, { ...base, project_id: f.sub2.id })
    const another = await plantIssue(t, base)
    // no check by count, only by size: 6 KiB is past the long subtask's
    // estimate alone, and short of the short one's
    await crowdedRoom(
      1e9,
      async () => {
        // a move walks the subtasks for their holders, and a new subtask
        // counts the parent's subtasks
        for (const [change, sentence] of [
          [() => appMove(t, f, long.id, f.sub2.id), SUBTREE_TOO_LARGE],
          [() => appUpdate(t, f, other.id, { parent_id: long.id }), PARENT_TOO_LARGE],
        ] as const) {
          const r = await expectRefusal(change(), 'rule')
          expect(r.data.message).toBe(sentence)
        }
        await appMove(t, f, short.id, f.sub2.id)
        await appUpdate(t, f, another.id, { parent_id: short.id })
      },
      6 * 1024,
    )
    expect((await row(t, another.id)).parent_id).toBe(short.id)
    expect((await row(t, other.id)).parent_id).toBeUndefined()
    expect((await row(t, long.id)).project_id).toBe(f.sub.id)
  })
})

describe('asking whether a move carries subtasks', () => {
  it('counts archived subtasks, which the app cannot see, and nothing else', async () => {
    const t = newT()
    const { f, backend, frontend } = await scene(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const ask = (id: string, project_id: string, who = f.admin) =>
      as(t, who).query(api.issues.moveCarriesSubtasks, { org_id: f.org.id, id, project_id })
    // the only subtask is archived
    const root = await plantIssue(t, base)
    await plantIssue(t, { ...base, parent_id: root.id, archived_at: ARCHIVED })
    expect(await ask(root.id, backend.id)).toBe(true)
    // within the top-level project nothing moves along
    expect(await ask(root.id, f.sub2.id)).toBe(false)
    // no subtasks, or only an older one already in the destination's project
    const lone = await plantIssue(t, base)
    const settledRoot = await plantIssue(t, base)
    await plantIssue(t, { ...base, project_id: frontend.id, parent_id: settledRoot.id })
    for (const id of [lone.id, settledRoot.id]) expect(await ask(id, backend.id)).toBe(false)
    // the guest edits TBED but not Cloud, so the answer tells them nothing
    expect(await ask(root.id, backend.id, f.guest)).toBe(false)
  })
})
