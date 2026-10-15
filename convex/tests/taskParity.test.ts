/* Task parity over REST and MCP: the task fields, moves, parents, labels,
 * links and archive reasons the app has, through the same shared rules.
 *
 *   1. What a read says about other tasks: the parent, subtasks, links and a
 *      group's remaining hours name only tasks the caller can read
 *      (lib/workingSet.ts with the machine Shown), plus owner and link.
 *   2. List filters: several statuses, the owner, MCP's offset.
 *   3. REST writes: a move with Edit on both ends, parent, labels, the
 *      archive reason, and the fields a body may not write.
 *   4. REST links and labels.
 *   5. MCP: the new create and update arguments, ignored arguments, the link
 *      and label tools and the argument validation for lists.
 *   6. applyTaskUpdate, the write order both surfaces share, the shared
 *      cores the app now runs too, and the activity reader for signed rows
 *      that name tasks. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { applyTaskUpdate } from '../lib/core'
import { byId } from '../lib/db'
import type { Refusal, RefusalCode } from '../lib/functions'
import { sha256hex } from '../machine/auth'
import { namedTaskNums } from '../model/activity'
import type { IssuePatch } from '../model/issues'
import {
  activityFor,
  as,
  drainActivity,
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

const KEY = 'drive'
const VIA = 'via the REST API (drive)'
const NO_WRITE = 'this agent has no write access to that project'
const MCP_NO_WRITE = 'your account has no write access to that project'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

const grant = (t: T, project_id: string, profile_id: string, level: 'user' | 'viewer') =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level })
  })

type Fx = OrgFixture & {
  t: T
  /** a project the agent may only read, and its sub-project */
  roMeta: Doc<'projects'>
  roSub: Doc<'projects'>
  /** a sub-project of the meta the agent cannot see */
  hiddenSub: Doc<'projects'>
  /** an archived sub-project the agent can read */
  archivedSub: Doc<'projects'>
}

/* withOrg, with the agent holding Edit on TBED (FW, PCB and an archived
 * sub-project ARC), View on RO, and no access to SKNK. */
async function setup(): Promise<Fx> {
  const t = newT()
  const f = await withOrg(t)
  await grant(t, f.meta.id, f.agent.id, 'user')
  const roMeta = await plantProject(t, { org_id: f.org.id, key: 'RO', name: 'Read only' })
  const roSub = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: roMeta.id,
    key: 'ROS',
    name: 'Read only sub',
  })
  await grant(t, roMeta.id, f.agent.id, 'viewer')
  const hiddenSub = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.hidden.id,
    key: 'SKS',
    name: 'Skunk sub',
  })
  const archivedSub = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    key: 'ARC',
    name: 'Archived sub',
    archived_at: NOW,
  })
  return { t, ...f, roMeta, roSub, hiddenSub, archivedSub }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> & { project_id?: string } = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

const restGet = (fx: Fx, ref: string, callerId = fx.agent.id) =>
  fx.t.query(internal.machine.rest.getIssue, { callerId, access: 'read', ref })

const restPatch = (fx: Fx, ref: string, body: unknown) =>
  fx.t.mutation(internal.machine.rest.updateIssue, {
    callerId: fx.agent.id,
    access: 'write',
    keyName: KEY,
    ref,
    body: JSON.stringify(body),
  })

const restList = (fx: Fx, q: Record<string, string>) =>
  fx.t.query(internal.machine.rest.listIssues, { callerId: fx.agent.id, access: 'read', ...q })

const mcp = async <T = Record<string, unknown>>(
  fx: Fx,
  fn:
    | typeof internal.machine.mcp.getIssue
    | typeof internal.machine.mcp.listIssues
    | typeof internal.machine.mcp.listLabels,
  args: Record<string, unknown>,
): Promise<T> =>
  JSON.parse(await fx.t.query(fn, { callerId: fx.agent.id, access: 'read', ...args } as never)) as T

const mcpWrite = async <T = Record<string, unknown>>(
  fx: Fx,
  fn:
    | typeof internal.machine.mcp.createIssue
    | typeof internal.machine.mcp.updateIssue
    | typeof internal.machine.mcp.setTaskLink
    | typeof internal.machine.mcp.setLabel,
  args: Record<string, unknown>,
  callerId = fx.agent.id,
): Promise<T> =>
  JSON.parse(await fx.t.mutation(fn, { callerId, access: 'write', ...args } as never)) as T

const row = (t: T, id: string) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()) as Doc<'issues'>,
  )

const plantLabel = (t: T, org_id: string, name: string, color: string) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('labels', {
      id,
      org_id,
      name,
      name_lower: name.toLowerCase(),
      color,
      created_at: NOW,
    })
    return id
  })

const plantLink = (t: T, source_id: string, target_id: string, type: 'blocks' | 'relates') =>
  t.run(async (ctx) => {
    await ctx.db.insert('issue_links', {
      id: uuid(),
      source_id,
      target_id,
      type,
      pair_key: source_id < target_id ? `${source_id}:${target_id}` : `${target_id}:${source_id}`,
      created_at: NOW,
    })
  })

const labelNames = (t: T, issueId: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
      .collect()
    const names = []
    for (const r of rows) {
      const label = await ctx.db
        .query('labels')
        .withIndex('by_uuid', (q) => q.eq('id', r.label_id))
        .unique()
      names.push(label?.name)
    }
    return names.sort()
  })

/* ------------------------------------------- 1. what a read says of others */

describe('the single-task read names only tasks the caller can read', () => {
  it('subtasks, links, labels and group remaining hours, on both surfaces', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent', remaining_hours: 9 })
    const a = await task(fx, { parent_id: parent.id, title: 'A', remaining_hours: 3 })
    await task(fx, { parent_id: parent.id, title: 'B', status: 'done', remaining_hours: 5 })
    await task(fx, { parent_id: parent.id, project_id: fx.hiddenSub.id, remaining_hours: 7 })
    await task(fx, { parent_id: parent.id, archived_at: NOW, remaining_hours: 4 })
    const e = await task(fx, { parent_id: parent.id, title: 'E', remaining_hours: 8 })
    await task(fx, { parent_id: e.id, project_id: fx.sub2.id, remaining_hours: 2.5 })
    const f = await task(fx, {
      parent_id: parent.id,
      project_id: fx.archivedSub.id,
      title: 'F',
      remaining_hours: 6,
    })
    const blocked = await task(fx, { title: 'Blocked' })
    const blocker = await task(fx, { title: 'Blocker' })
    const related = await task(fx, { title: 'Related' })
    const secret = await task(fx, { project_id: fx.hiddenSub.id, title: 'Secret' })
    await plantLink(fx.t, parent.id, blocked.id, 'blocks')
    await plantLink(fx.t, blocker.id, parent.id, 'blocks')
    await plantLink(fx.t, parent.id, related.id, 'relates')
    await plantLink(fx.t, parent.id, secret.id, 'blocks')
    const bug = await plantLabel(fx.t, fx.org.id, 'Bug', '#FF0000')
    const odd = await plantLabel(fx.t, fx.org.id, 'Odd', 'url(https://x.test/a.png)')
    await fx.t.run(async (ctx) => {
      for (const label_id of [odd, bug]) {
        await ctx.db.insert('issue_labels', { org_id: fx.org.id, issue_id: parent.id, label_id })
      }
    })
    const ref = (t: Doc<'issues'>) => ({
      id: t.id,
      key: `QN-${t.num}`,
      title: t.title,
      status: t.status,
    })
    const expected = {
      // A 3 + E's leaf 2.5; not the Done one, the hidden one, the archived
      // one, nor F in an archived project; E's own hours are dormant
      group_remaining_hours: 5.5,
      labels: [
        { id: bug, name: 'Bug', color: '#FF0000' },
        { id: odd, name: 'Odd', color: '#8A8F98' },
      ],
      subtasks: [ref(a), expect.objectContaining({ title: 'B' }), ref(e), ref(f)],
      links: [
        { kind: 'blocks', ...ref(blocked) },
        { kind: 'blocked_by', ...ref(blocker) },
        { kind: 'relates', ...ref(related) },
      ],
    }
    const rest = await restGet(fx, `QN-${parent.num}`)
    expect(rest).toMatchObject({ is_group: true, remaining_hours: 9, ...expected })
    const viaMcp = await mcp(fx, internal.machine.mcp.getIssue, { ref: parent.id })
    expect(viaMcp).toMatchObject(expected)
    expect(Object.keys(viaMcp).slice(-8)).toEqual([
      'url',
      'group_remaining_hours',
      'labels',
      'subtasks',
      'links',
      'following',
      'followers',
      'attachments',
    ])
    // an admin reads the hidden subtask and link too, and counts its hours
    const admin = await restGet(fx, parent.id, fx.admin.id)
    expect(admin.group_remaining_hours).toBe(12.5)
    expect(admin.subtasks).toHaveLength(5)
    expect(admin.links.map((l) => l.id)).toContain(secret.id)
    // a leaf has no group total
    expect((await restGet(fx, a.id)).group_remaining_hours).toBeNull()
  })

  it('a hidden parent reads as has_hidden_parent; owner and link on rows', async () => {
    const fx = await setup()
    const hiddenParent = await task(fx, { project_id: fx.hiddenSub.id })
    const visibleParent = await task(fx)
    const underHidden = await task(fx, { parent_id: hiddenParent.id, assignee_id: fx.user.id })
    const underVisible = await task(fx, {
      parent_id: visibleParent.id,
      status: 'review',
      assignee_id: fx.user.id,
      reviewer_id: fx.guest.id,
    })
    const one = await restGet(fx, underHidden.id)
    expect(one).toMatchObject({ parent_id: null, has_hidden_parent: true, owner_id: fx.user.id })
    expect(one.url).toBe(`http://localhost:5199/app/testbed/tasks/qn-${underHidden.num}`)
    const rows = await restList(fx, {})
    expect(rows.find((r) => r.id === underHidden.id)).toMatchObject({
      parent_id: null,
      has_hidden_parent: true,
    })
    expect(rows.find((r) => r.id === underVisible.id)).toMatchObject({
      parent_id: visibleParent.id,
      has_hidden_parent: false,
      owner_id: fx.guest.id, // the reviewer owns it while in review
    })
    expect('subtasks' in rows[0]).toBe(false) // list rows stay lean
    const mcpRows = await mcp<Record<string, unknown>[]>(fx, internal.machine.mcp.listIssues, {})
    expect(mcpRows.find((r) => r.id === underHidden.id)).toMatchObject({
      parent_id: null,
      has_hidden_parent: true,
    })
    // the admin sees the parent
    expect((await restGet(fx, underHidden.id, fx.admin.id)).parent_id).toBe(hiddenParent.id)
  })
})

/* --------------------------------------------------------- 2. list filters */

describe('list filters', () => {
  it('several statuses, the owner and the MCP offset', async () => {
    const fx = await setup()
    const todo = await task(fx, { status: 'todo', assignee_id: fx.user.id })
    const done = await task(fx, { status: 'done' })
    const review = await task(fx, {
      status: 'review',
      assignee_id: fx.user.id,
      reviewer_id: fx.guest.id,
    })
    const group = await task(fx, { status: 'todo', assignee_id: fx.guest.id })
    await task(fx, { parent_id: group.id, status: 'progress' })
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id)
    expect(ids(await restList(fx, { status: 'todo,done' }))).toEqual([todo.id, done.id])
    await refused(
      restList(fx, { status: 'todo,later' }),
      'bad_request',
      'status must be one of backlog, todo, progress, review, done',
    )
    // the reviewer owns the task in review; a group stays with its assignee
    expect(ids(await restList(fx, { owner: fx.guest.id.toUpperCase() }))).toEqual([
      review.id,
      group.id,
    ])
    expect(ids(await restList(fx, { owner: fx.user.id }))).toEqual([todo.id])
    await refused(restList(fx, { owner: 'leo' }), 'bad_request', 'owner must be a profile uuid')
    const list = (args: Record<string, unknown>) =>
      mcp<{ id: string }[]>(fx, internal.machine.mcp.listIssues, args)
    expect(ids(await list({ status: ['todo', 'done'] }))).toEqual([todo.id, done.id])
    expect(ids(await list({ status: 'review' }))).toEqual([review.id])
    expect(ids(await list({ owner_id: fx.guest.id }))).toEqual([review.id, group.id])
    const all = ids(await list({}))
    expect(ids(await list({ offset: 2, limit: 2 }))).toEqual(all.slice(2, 4))
  })
})

/* ---------------------------------------------------------- 3. REST writes */

describe('PATCH /v1/tasks/{ref} moves, parents, labels and archive reasons', () => {
  it('moves with Edit on both ends, signed, and answers like create for a bad destination', async () => {
    const fx = await setup()
    const t1 = await task(fx, { title: 'Mover', assignee_id: fx.user.id })
    const out = await restPatch(fx, `QN-${t1.num}`, { project: 'TBED', sub_project: 'pcb' })
    expect(out).toMatchObject({ project_id: fx.sub2.id, project_key: 'PCB', key: `QN-${t1.num}` })
    const moved = (await activityFor(fx.t, fx.org.id)).at(-1)
    expect(moved).toMatchObject({
      verb: 'moved',
      detail: `to the Board rev sub-project (from Firmware) — ${VIA}`,
      project_id: fx.sub.id,
      related_project_id: fx.sub2.id,
    })
    // naming the sub-project directly works too; the current one is a no-op
    expect((await restPatch(fx, t1.id, { project: 'FW' })).project_key).toBe('FW')
    await drainActivity(fx.t)
    expect((await restPatch(fx, t1.id, { project: 'FW' })).project_key).toBe('FW')
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(0)
    // a destination the agent can read but not write
    await refused(restPatch(fx, t1.id, { project: 'ROS' }), 'forbidden', NO_WRITE)
    // one it cannot read answers like an unknown project
    for (const project of ['SKS', 'NOPE']) {
      await refused(
        restPatch(fx, t1.id, { project }),
        'bad_request',
        'project must name a project by uuid, number or key',
      )
    }
    await refused(
      restPatch(fx, t1.id, { project: 'TBED' }),
      'bad_request',
      'TBED is a project — tasks live in its sub-projects; pass sub_project (one of: FW, PCB)',
    )
    await refused(
      restPatch(fx, t1.id, { project: 'ARC' }),
      'bad_request',
      'ARC is archived — restore it in the app before adding tasks to it',
    )
    expect((await row(fx.t, t1.id)).project_id).toBe(fx.sub.id)
  })

  it('a move checks a new assignee at the destination and refuses one the app would', async () => {
    const fx = await setup()
    const pcbOnly = await withSeat(fx, 'pcb only')
    await grant(fx.t, fx.sub2.id, pcbOnly.id, 'user')
    const t1 = await task(fx, { assignee_id: fx.guest.id })
    // the new assignee works only in PCB: fine when the task moves there
    const out = await restPatch(fx, t1.id, { project: 'PCB', assignee_id: pcbOnly.id })
    expect(out).toMatchObject({ project_key: 'PCB', assignee_id: pcbOnly.id })
    // and refused where they have no access
    const t2 = await task(fx)
    await refused(
      restPatch(fx, t2.id, { assignee_id: pcbOnly.id }),
      'bad_request',
      `user "${pcbOnly.id}" has no access to this project`,
    )
    // the current assignee must be able to work at the destination, as in the app
    const t3 = await task(fx, { project_id: fx.sub2.id, assignee_id: pcbOnly.id })
    await expectRefusal(restPatch(fx, t3.id, { project: 'FW', title: 'Renamed' }), 'rule')
    expect(await row(fx.t, t3.id)).toMatchObject({ project_id: fx.sub2.id, title: t3.title })
  })

  it('sets and clears the parent through the app rules, narrated with the task keys', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent', remaining_hours: 4 })
    const child = await task(fx, { title: 'Child' })
    const out = await restPatch(fx, child.id, { parent: `qn-${parent.num}` })
    expect(out).toMatchObject({ parent_id: parent.id, has_hidden_parent: false })
    // the parent became a group and lost its own hours, as in the app
    expect((await row(fx.t, parent.id)).remaining_hours).toBeUndefined()
    const events = await activityFor(fx.t, fx.org.id)
    const attach = events.find((e) => e.target_id === child.id)
    expect(attach).toMatchObject({ verb: 'moved', detail: `under QN-${parent.num} — ${VIA}` })
    expect(namedTaskNums(attach as Doc<'activity_events'>)).toEqual([parent.num])
    // a cycle, a hidden parent and a read-only parent are refused
    await expectRefusal(restPatch(fx, parent.id, { parent: child.id }), 'rule')
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(
      restPatch(fx, child.id, { parent: hidden.id }),
      'bad_request',
      'parent task not found',
    )
    const readOnly = await task(fx, { project_id: fx.roSub.id })
    await refused(
      restPatch(fx, child.id, { parent: readOnly.id }),
      'forbidden',
      'no write access to the parent task',
    )
    await refused(
      restPatch(fx, child.id, { parent: 5 }),
      'bad_request',
      'parent must be a task key, number or uuid, or null',
    )
    // null detaches
    expect(await restPatch(fx, child.id, { parent: null })).toMatchObject({ parent_id: null })
    expect((await activityFor(fx.t, fx.org.id)).at(-1)).toMatchObject({
      verb: 'detached',
      detail: `from QN-${parent.num} — ${VIA}`,
    })
    // POST creates a subtask
    const created = await fx.t.mutation(internal.machine.rest.createIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: KEY,
      body: JSON.stringify({ project: 'FW', title: 'Sub', parent: parent.id }),
    })
    expect(created.parent_id).toBe(parent.id)
    expect((await restGet(fx, parent.id)).subtasks.map((s) => s.id)).toEqual([created.id])
  })

  it('adds and removes labels by id or name, once each, signed', async () => {
    const fx = await setup()
    const bug = await plantLabel(fx.t, fx.org.id, 'Bug', '#ff0000')
    await plantLabel(fx.t, fx.org.id, 'Blocked', '#00ff00')
    await plantLabel(fx.t, fx.otherOrg.id, 'Foreign', '#0000ff')
    const t1 = await task(fx, { title: 'Labelled' })
    const out = await restPatch(fx, t1.id, { add_labels: [bug, 'BLOCKED', 'bug'] })
    expect(out.labels.map((l) => l.name)).toEqual(['Blocked', 'Bug'])
    const rows = (await activityFor(fx.t, fx.org.id)).filter((e) => e.verb === 'labeled')
    expect(rows.map((e) => e.detail).sort()).toEqual([`— Blocked — ${VIA}`, `— Bug — ${VIA}`])
    // asking for the current state writes nothing
    await drainActivity(fx.t)
    await restPatch(fx, t1.id, { add_labels: ['bug'] })
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(0)
    await restPatch(fx, t1.id, { remove_labels: ['Blocked'] })
    expect(await labelNames(fx.t, t1.id)).toEqual(['Bug'])
    await refused(
      restPatch(fx, t1.id, { add_labels: ['Foreign'] }),
      'bad_request',
      'label "Foreign" not found',
    )
    await refused(
      restPatch(fx, t1.id, { add_labels: ['Bug'], remove_labels: [bug] }),
      'bad_request',
      'label "Bug" cannot be both added and removed',
    )
    await refused(
      restPatch(fx, t1.id, { add_labels: 'Bug' }),
      'bad_request',
      'add_labels must be an array of label ids or names',
    )
    expect(await labelNames(fx.t, t1.id)).toEqual(['Bug'])
  })

  it('posts the archive reason as a comment only when the request archives', async () => {
    const fx = await setup()
    const t1 = await task(fx)
    await restPatch(fx, t1.id, { archived: true, archive_reason: '  Superseded by QN-1  ' })
    const comments = async () =>
      fx.t.run(async (ctx) =>
        (
          await ctx.db
            .query('comments')
            .withIndex('by_issue', (q) => q.eq('issue_id', t1.id))
            .collect()
        ).map((c) => [c.author, c.body]),
      )
    expect(await comments()).toEqual([[fx.agent.id, 'Superseded by QN-1']])
    // already archived: a no-op that posts nothing
    await restPatch(fx, t1.id, { archived: true, archive_reason: 'again' })
    expect(await comments()).toHaveLength(1)
    await refused(
      restPatch(fx, t1.id, { archived: false, archive_reason: 'x' }),
      'bad_request',
      'archive_reason needs archived set to true',
    )
  })
})

async function withSeat(fx: Fx, name: string): Promise<Doc<'profiles'>> {
  return await fx.t.run(async (ctx) => {
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id: fx.org.id,
      name,
      initials: 'PO',
      color: '#123456',
      org_role: 'user',
      active: true,
      kind: 'person',
      plannable_hours: 40,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
}

/* ------------------------------------------------- 4. REST links and labels */

describe('REST links', () => {
  it('adds a link as seen from {ref}, idempotently, and removes only that kind', async () => {
    const fx = await setup()
    const a = await task(fx, { title: 'A' })
    const b = await task(fx, { title: 'B' })
    const add = (ref: string, body: unknown) =>
      fx.t.mutation(internal.machine.rest.addLink, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: KEY,
        ref,
        body: JSON.stringify(body),
      })
    const remove = (ref: string, kind: string, other: string) =>
      fx.t.mutation(internal.machine.rest.removeLink, {
        callerId: fx.agent.id,
        access: 'write',
        ref,
        kind,
        other,
      })
    expect(await add(a.id, { task: `QN-${b.num}`, kind: 'blocked_by' })).toEqual({
      kind: 'blocked_by',
      id: b.id,
      key: `QN-${b.num}`,
      title: 'B',
      status: b.status,
    })
    // stored as B blocks A, narrated against B
    const events = await activityFor(fx.t, fx.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'linked',
      target_id: b.id,
      detail: `— blocks QN-${a.num} — ${VIA}`,
    })
    expect(namedTaskNums(events[0])).toEqual([a.num])
    expect((await restGet(fx, b.id)).links).toEqual([
      { kind: 'blocks', id: a.id, key: `QN-${a.num}`, title: 'A', status: a.status },
    ])
    // the same link again changes nothing; another kind is refused
    await add(b.id, { task: a.id, kind: 'blocks' })
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(1)
    await refused(
      add(a.id, { task: b.id, kind: 'relates' }),
      'bad_request',
      'these tasks are already linked',
    )
    await refused(
      add(a.id, { task: a.id, kind: 'relates' }),
      'bad_request',
      'a task cannot be linked to itself',
    )
    await refused(
      add(a.id, { task: b.id, kind: 'depends' }),
      'bad_request',
      'kind must be one of blocks, blocked_by, relates',
    )
    // a task the agent cannot read reads like an unknown one
    const secret = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(
      add(a.id, { task: secret.id, kind: 'relates' }),
      'bad_request',
      'task must name a task by key, number or uuid',
    )
    // both ends read-only: refused; one editable end is enough
    const ro1 = await task(fx, { project_id: fx.roSub.id })
    const ro2 = await task(fx, { project_id: fx.roSub.id })
    await refused(add(ro1.id, { task: ro2.id, kind: 'relates' }), 'forbidden', NO_WRITE)
    expect((await add(ro1.id, { task: a.id, kind: 'relates' })).kind).toBe('relates')
    // removal names the kind as seen from {ref}
    expect(await remove(a.id, 'blocks', b.id)).toMatchObject({ removed: false })
    expect(await remove(a.id, 'blocked_by', `QN-${b.num}`)).toMatchObject({ removed: true })
    expect((await restGet(fx, a.id)).links.map((l) => l.id)).toEqual([ro1.id])
    await refused(remove(a.id, 'relates', secret.id), 'not_found', 'task not found')
  })
})

describe('REST labels', () => {
  it('lists, creates with the app rule and lets only admins rename', async () => {
    const fx = await setup()
    await plantLabel(fx.t, fx.org.id, 'zeta', '#000000')
    await plantLabel(fx.t, fx.otherOrg.id, 'Elsewhere', '#000000')
    const create = (body: unknown, callerId = fx.agent.id) =>
      fx.t.mutation(internal.machine.rest.createLabel, {
        callerId,
        access: 'write',
        keyName: KEY,
        body: JSON.stringify(body),
      })
    const update = (callerId: string, ref: string, body: unknown) =>
      fx.t.mutation(internal.machine.rest.updateLabel, {
        callerId,
        access: 'write',
        ref,
        body: JSON.stringify(body),
      })
    const made = await create({ name: ' Alpha ', color: '#ABCDEF' })
    expect(made).toEqual({ id: made.id, name: 'Alpha', color: '#ABCDEF' })
    expect((await activityFor(fx.t, fx.org.id)).at(-1)).toMatchObject({
      verb: 'created label',
      detail: VIA,
      actor_id: fx.agent.id,
    })
    const list = await fx.t.query(internal.machine.rest.listLabels, {
      callerId: fx.agent.id,
      access: 'read',
    })
    expect(list.map((l) => l.name)).toEqual(['Alpha', 'zeta'])
    await refused(
      create({ name: 'Red', color: 'red' }),
      'bad_request',
      'a label color must be # followed by six hex digits, like #4C9AFF',
    )
    await refused(
      create({ name: 'alpha', color: '#000000' }),
      'rule',
      'a label with that name already exists',
    )
    await refused(create({ color: '#000000' }), 'bad_request', 'name is required')
    // a person without Edit on any project may not add labels
    const nobody = await withSeat(fx, 'nobody')
    await refused(
      create({ name: 'Mine', color: '#000000' }, nobody.id),
      'forbidden',
      'no label access in this organization',
    )
    // renaming is for admins, refused before the lookup
    for (const ref of ['Alpha', 'nothing-here']) {
      await refused(
        update(fx.agent.id, ref, { name: 'Beta' }),
        'forbidden',
        'only organization admins can rename, recolor or delete labels',
      )
    }
    expect(await update(fx.admin.id, 'ALPHA', { color: '#000001' })).toEqual({
      id: made.id,
      name: 'Alpha',
      color: '#000001',
    })
    await refused(update(fx.admin.id, 'Elsewhere', { name: 'x' }), 'not_found', 'label not found')
    await refused(update(fx.admin.id, made.id, {}), 'bad_request', 'no recognized fields to update')
  })
})

/* -------------------------------------------------------------------- 5. MCP */

describe('MCP task parity', () => {
  it('create_task takes parent, plan weeks and paused, and reports ignored arguments', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent' })
    const out = await mcpWrite(fx, internal.machine.mcp.createIssue, {
      project: 'FW',
      title: 'Planned',
      parent: `QN-${parent.num}`,
      status: 'todo',
      start_week: '2026-09-21',
      end_week: '2026-09-28',
      paused: true,
    })
    expect(await row(fx.t, out.id as string)).toMatchObject({
      parent_id: parent.id,
      start_week: '2026-09-21',
      end_week: '2026-09-28',
      paused: true,
    })
    await expectRefusal(
      mcpWrite(fx, internal.machine.mcp.createIssue, {
        project: 'FW',
        title: 'Half',
        start_week: '2026-09-21',
      }),
      'bad_request',
      /^start_week and end_week must be set \(or cleared\) together$/,
    )
    const hidden = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(
      mcpWrite(fx, internal.machine.mcp.createIssue, {
        project: 'FW',
        title: 'Orphan',
        parent: hidden.id,
      }),
      'not_found',
      `parent task "${hidden.id}" not found (or not visible to you)`,
    )
  })

  it('update_task moves, reparents, labels, schedules and archives with a reason', async () => {
    const fx = await setup()
    await plantLabel(fx.t, fx.org.id, 'Bug', '#ff0000')
    const parent = await task(fx, { title: 'Parent' })
    await task(fx, { parent_id: parent.id, title: 'Stays' })
    const t1 = await task(fx, { title: 'Worked' })
    const update = (args: Record<string, unknown>) =>
      mcpWrite<{ updated: string[] }>(fx, internal.machine.mcp.updateIssue, args)
    const out = await update({
      ref: t1.id,
      project: 'TBED',
      sub_project: 'PCB',
      parent: parent.id,
      start_week: '2026-09-21',
      end_week: '2026-09-21',
      add_labels: ['bug'],
      archived: true,
      archive_reason: 'Handled elsewhere',
    })
    expect(out).toEqual({
      id: t1.id,
      key: `QN-${t1.num}`,
      updated: ['start_week', 'end_week', 'parent_id', 'project_id', 'labels', 'archived_at'],
    })
    expect(await row(fx.t, t1.id)).toMatchObject({
      project_id: fx.sub2.id,
      parent_id: parent.id,
      start_week: '2026-09-21',
      archived_at: expect.any(String),
    })
    expect(await labelNames(fx.t, t1.id)).toEqual(['Bug'])
    const verbs = (await activityFor(fx.t, fx.org.id)).map((e) => [e.verb, e.detail])
    expect(verbs).toEqual([
      ['moved', 'to the Board rev sub-project (from Firmware) — via MCP'],
      ['moved', `under QN-${parent.num} — via MCP`],
      ['archived', '(start week unset → 2026-09-21, end week unset → 2026-09-21) — via MCP'],
      ['labeled', '— Bug — via MCP'],
    ])
    const reason = await fx.t.run(async (ctx) =>
      ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', t1.id))
        .collect(),
    )
    expect(reason.map((c) => c.body)).toEqual(['Handled elsewhere'])
    // a group's dates are refused with the machine sentence
    await refused(
      update({ ref: parent.id, start_week: null, end_week: null }),
      'bad_request',
      'start_week and end_week cannot be set on a task with subtasks; its dates come from its subtasks',
    )
    await refused(
      update({ ref: parent.id, sub_project: 'PCB' }),
      'bad_request',
      'project is required to move a task; sub_project names one of its sub-projects',
    )
    await refused(
      update({ ref: parent.id, project: 'SKS' }),
      'not_found',
      'project "SKS" not found (or not visible to you)',
    )
    await refused(update({ ref: parent.id, project: 'ROS' }), 'forbidden', MCP_NO_WRITE)
    await refused(
      update({ ref: parent.id, archive_reason: 'why' }),
      'bad_request',
      'archive_reason needs archived set to true',
    )
  })

  it('update_task checks a new assignee where the task ends up, and the current one on a move', async () => {
    const fx = await setup()
    const pcbOnly = await withSeat(fx, 'pcb only')
    await grant(fx.t, fx.sub2.id, pcbOnly.id, 'user')
    const update = (args: Record<string, unknown>) =>
      mcpWrite(fx, internal.machine.mcp.updateIssue, args)
    const noAccess = `user "${pcbOnly.id}" has no access to this project`
    // the new assignee works only in PCB: fine when the task moves there
    const t1 = await task(fx, { assignee_id: fx.guest.id })
    await update({ ref: t1.id, project: 'PCB', assignee_id: pcbOnly.id })
    expect(await row(fx.t, t1.id)).toMatchObject({
      project_id: fx.sub2.id,
      assignee_id: pcbOnly.id,
    })
    // without a move, the task's own project decides, in the readable sentence
    const t2 = await task(fx)
    await refused(update({ ref: t2.id, assignee_id: pcbOnly.id }), 'bad_request', noAccess)
    // with one, the destination decides, in the same sentence
    const t3 = await task(fx, { project_id: fx.sub2.id })
    await refused(
      update({ ref: t3.id, project: 'FW', assignee_id: pcbOnly.id }),
      'bad_request',
      noAccess,
    )
    expect((await row(fx.t, t3.id)).project_id).toBe(fx.sub2.id)
    // the current assignee must be able to work at the destination, as in the app
    const t4 = await task(fx, { project_id: fx.sub2.id, assignee_id: pcbOnly.id })
    await expectRefusal(update({ ref: t4.id, project: 'FW', title: 'Renamed' }), 'rule')
    expect(await row(fx.t, t4.id)).toMatchObject({ project_id: fx.sub2.id, title: t4.title })
  })

  it('reports arguments the schema does not know instead of dropping them silently', async () => {
    const fx = await setup()
    const t1 = await task(fx, { title: 'Echo' })
    const secret = `qva_${'1a2b3c4d'.repeat(6)}`
    const key_hash = await sha256hex(secret)
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: fx.agent.id,
        name: KEY,
        key_prefix: secret.slice(0, 11),
        key_hash,
        created_at: NOW,
      })
    })
    const http = fx.t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ): Promise<{ text(): Promise<string> }>
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await http.fetch('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      const body = JSON.parse(await res.text()) as { result: { content: { text: string }[] } }
      return body.result.content[0].text
    }
    const callJson = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(await call(name, args)) as Record<string, unknown>
    expect(
      await callJson('update_task', {
        ref: t1.id,
        title: 'Echoed',
        estimate_hours: 3,
        parent_id: 'x',
      }),
    ).toEqual({
      id: t1.id,
      key: `QN-${t1.num}`,
      updated: ['title'],
      ignored_arguments: ['estimate_hours', 'parent_id'],
    })
    expect((await row(fx.t, t1.id)).title).toBe('Echoed')
    const created = await callJson('create_task', { project: 'FW', title: 'New', labels: ['Bug'] })
    expect(created).toEqual({
      id: created.id,
      key: created.key,
      ignored_arguments: ['labels'],
    })
    expect(await callJson('update_task', { ref: t1.id, title: 'Again' })).not.toHaveProperty(
      'ignored_arguments',
    )
    // lists are checked item by item, and a list where one value goes fails
    const invalid = 'Input validation error: Invalid arguments for tool'
    for (const [name, args, problem] of [
      ['list_tasks', { status: [] }, 'status: Too small: expected array to have >=1 items'],
      [
        'list_tasks',
        { status: ['todo', 'later'] },
        'status: Invalid option: expected one of "backlog"|"todo"|"progress"|"review"|"done"',
      ],
      ['list_tasks', { status: null }, 'status: Invalid input: expected string, received null'],
      ['list_tasks', { offset: -1 }, 'offset: Too small: expected int to be >=0'],
      [
        'update_task',
        { ref: t1.id, add_labels: ['Bug', 2] },
        'add_labels: Invalid input: expected string, received number',
      ],
      [
        'update_task',
        { ref: t1.id, remove_labels: 'Bug' },
        'remove_labels: Invalid input: expected array, received string',
      ],
      [
        'update_task',
        { ref: t1.id, parent: 7 },
        'parent: Invalid input: expected string, received number',
      ],
    ] as const) {
      expect(await call(name, args)).toBe(`${invalid} ${name}: ${problem}`)
    }
    // null detaches, so it passes
    expect(await callJson('update_task', { ref: t1.id, parent: null })).toMatchObject({
      updated: ['parent_id'],
    })
  })

  it('set_task_link adds and removes one link; list_labels and set_label', async () => {
    const fx = await setup()
    const a = await task(fx, { title: 'A' })
    const b = await task(fx, { title: 'B' })
    const link = (args: Record<string, unknown>) =>
      mcpWrite(fx, internal.machine.mcp.setTaskLink, args)
    expect(await link({ ref: a.id, other: `QN-${b.num}`, kind: 'relates', linked: true })).toEqual({
      key: `QN-${a.num}`,
      other: `QN-${b.num}`,
      kind: 'relates',
      linked: true,
      changed: true,
    })
    expect((await link({ ref: b.id, other: a.id, kind: 'relates', linked: true })).changed).toBe(
      false,
    )
    const detail = await mcp<{ links: { kind: string; id: string }[] }>(
      fx,
      internal.machine.mcp.getIssue,
      { ref: b.id },
    )
    expect(detail.links).toEqual([expect.objectContaining({ kind: 'relates', id: a.id })])
    expect((await link({ ref: a.id, other: b.id, kind: 'blocks', linked: false })).changed).toBe(
      false,
    )
    expect((await link({ ref: a.id, other: b.id, kind: 'relates', linked: false })).changed).toBe(
      true,
    )
    const secret = await task(fx, { project_id: fx.hiddenSub.id })
    await refused(
      link({ ref: a.id, other: secret.id, kind: 'relates', linked: true }),
      'not_found',
      `task "${secret.id}" not found (or not visible to you)`,
    )
    const ro1 = await task(fx, { project_id: fx.roSub.id })
    const ro2 = await task(fx, { project_id: fx.roSub.id })
    await refused(
      link({ ref: ro1.id, other: ro2.id, kind: 'blocks', linked: true }),
      'forbidden',
      MCP_NO_WRITE,
    )
    // labels
    const made = await mcpWrite(fx, internal.machine.mcp.setLabel, {
      name: 'Hardware',
      color: '#123ABC',
    })
    expect(made).toEqual({ id: made.id, name: 'Hardware', color: '#123ABC', created: true })
    expect(await mcp(fx, internal.machine.mcp.listLabels, {})).toEqual([
      { id: made.id, name: 'Hardware', color: '#123ABC' },
    ])
    await refused(
      mcpWrite(fx, internal.machine.mcp.setLabel, { name: 'Lonely' }),
      'bad_request',
      'a new label needs name and color',
    )
    await refused(
      mcpWrite(fx, internal.machine.mcp.setLabel, { label: 'hardware', name: 'HW' }),
      'forbidden',
      'only organization admins can rename, recolor or delete labels',
    )
    expect(
      await mcpWrite(
        fx,
        internal.machine.mcp.setLabel,
        { label: 'hardware', name: 'HW' },
        fx.admin.id,
      ),
    ).toEqual({ id: made.id, name: 'HW', color: '#123ABC', created: false })
  })
})

/* ------------------------------------------- 6. shared cores and the reader */

describe('applyTaskUpdate, the write order of REST PATCH and MCP update_task', () => {
  it('moves, reparents, writes fields, labels, then the reason, skipping what does not change', async () => {
    const fx = await setup()
    const bug = await plantLabel(fx.t, fx.org.id, 'Bug', '#ff0000')
    const parent = await task(fx, { title: 'Parent' })
    const t1 = await task(fx, { title: 'Before', parent_id: parent.id })
    const apply = (
      a: Pick<Parameters<typeof applyTaskUpdate>[1], 'destination' | 'parent' | 'reason'> & {
        patch?: IssuePatch
        archive?: boolean
        add?: string[]
      },
    ) =>
      fx.t.run(async (ctx) => {
        const add: Doc<'labels'>[] = []
        for (const id of a.add ?? []) add.push((await byId(ctx, 'labels', id)) as Doc<'labels'>)
        await applyTaskUpdate(ctx, {
          ...a,
          me: fx.agent,
          issue: (await byId(ctx, 'issues', t1.id)) as Doc<'issues'>,
          patch: a.patch ?? {},
          labels: { add, remove: [] },
          now: NOW,
          provenance: 'via MCP',
        })
      })
    const verbs = async () => (await activityFor(fx.t, fx.org.id)).map((e) => e.verb)
    const comments = () =>
      fx.t.run(async (ctx) =>
        (
          await ctx.db
            .query('comments')
            .withIndex('by_issue', (q) => q.eq('issue_id', t1.id))
            .collect()
        ).map((c) => c.body),
      )
    // the parent it already has is no change and writes no row
    await apply({
      destination: fx.sub2,
      parent: parent.id,
      patch: { title: 'After' },
      archive: true,
      add: [bug],
      reason: ' Done elsewhere ',
    })
    expect(await verbs()).toEqual(['moved', 'archived', 'labeled'])
    expect(await row(fx.t, t1.id)).toMatchObject({
      project_id: fx.sub2.id,
      parent_id: parent.id,
      title: 'After',
      archived_at: NOW,
    })
    expect(await comments()).toEqual(['Done elsewhere'])
    // an archive that matches the task's state writes nothing, reason included
    await drainActivity(fx.t)
    await apply({ archive: true, reason: 'again' })
    expect(await verbs()).toEqual([])
    // a restore never posts the reason
    await apply({ archive: false, reason: 'back' })
    expect(await verbs()).toEqual(['restored'])
    expect(await comments()).toEqual(['Done elsewhere'])
  })
})

describe('the shared cores the app runs too', () => {
  it('the app link: the same link again is a no-op, another kind is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const link = (id: string, type: 'blocks' | 'relates') =>
      as(t, f.user).mutation(api.issues.addLink, {
        org_id: f.org.id,
        id,
        source_id: a.id,
        target_id: b.id,
        type,
      })
    const id = uuid()
    await link(id, 'blocks')
    await link(id, 'blocks')
    expect(await activityFor(t, f.org.id)).toHaveLength(1)
    await expectRefusal(link(uuid(), 'relates'), 'bad_request', /^these tasks are already linked$/)
  })

  it('the app link: an id another link already has is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const c = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const link = (id: string, target_id: string) =>
      as(t, f.user).mutation(api.issues.addLink, {
        org_id: f.org.id,
        id,
        source_id: a.id,
        target_id,
        type: 'relates',
      })
    const id = uuid()
    await link(id, b.id)
    await expectRefusal(link(id, c.id), 'bad_request', /^a link with this id already exists$/)
    await link(uuid(), c.id)
    expect(await activityFor(t, f.org.id)).toHaveLength(2)
  })

  it('namedTaskNums reads signed rows and still fails closed on other wording', () => {
    const ev = (verb: string, detail: string) =>
      ({ target_type: 'issue', verb, detail }) as Pick<
        Doc<'activity_events'>,
        'target_type' | 'verb' | 'detail'
      >
    expect(namedTaskNums(ev('linked', '— blocks QN-12 — via MCP'))).toEqual([12])
    expect(namedTaskNums(ev('linked', '— relates to QN-3 — via the REST API (a (b) c)'))).toEqual([
      3,
    ])
    expect(namedTaskNums(ev('moved', 'under QN-4 (from QN-5) — via the REST API'))).toEqual([4, 5])
    expect(namedTaskNums(ev('detached', 'from QN-6 — via MCP'))).toEqual([6])
    // anything else that follows the key is not a signature: fail closed
    expect(namedTaskNums(ev('linked', '— blocks QN-12 and QN-13'))).toBeNull()
    expect(namedTaskNums(ev('linked', '— blocks QN-12 — via email'))).toBeNull()
    expect(namedTaskNums(ev('detached', 'from QN-6 — via MCP — via MCP'))).toBeNull()
  })
})
