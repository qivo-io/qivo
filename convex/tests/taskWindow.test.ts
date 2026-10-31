/* The task window's own reads (taskWindow.ts, lib/taskWindow.ts): parity
 * with the workspace's tasks part on Northstar and on the small fixture for
 * guest, viewer, member and admin seats, one unavailable answer for every
 * refusal, what links, parents and subtasks reveal, the ref forms, the
 * attachment list, and reads that stay within TASK_WINDOW under Convex's
 * transaction limits. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS, projectLevel } from '../lib/access'
import { archivedTaskCore } from '../lib/archivedTasks'
import { newWindowKey } from '../lib/db'
import { LIMITS, MIB, NAME_MAX } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { readWindowLinks, readWindowTask, TASK_WINDOW } from '../lib/taskWindow'
import { relationRow, type TaskRow } from '../lib/workspaceParts'
import { descriptionOf } from '../model/descriptions'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'

const DEFAULT_TASK_WINDOW = structuredClone(TASK_WINDOW)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(TASK_WINDOW, structuredClone(DEFAULT_TASK_WINDOW))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

const whole = { from: '', to: null }

/* The largest description the server accepts, of three-byte characters:
 * about 60 KB stored. */
const LARGEST = '€'.repeat(20_000)

/* -1, 0 or 1 as `a` sorts before, with or after `b`. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byCreation = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  order(a.created_at, b.created_at) || order(a.id, b.id)
const byNumber = (a: { num: number; id: string }, b: { num: number; id: string }) =>
  a.num - b.num || order(a.id, b.id)

/* The tasks part's row of a task cut to the short row the window sends. */
function cut(row: TaskRow, level: string | null | undefined) {
  const {
    description: _text,
    parent_id: _parent,
    has_hidden_parent: _hiddenParent,
    has_hidden_subtasks: _hiddenKids,
    ...rest
  } = row
  return { ...rest, has_subtasks: rest.has_subtasks ?? false, level }
}

/* A caller as as() gives one. */
type Caller = ReturnType<typeof as>

/** The tasks part of `caller` over the whole window. */
async function tasksPart(caller: Caller, orgId: string) {
  const part = await caller.query(api.workspace.tasks, { org_id: orgId, ...whole })
  if (part.state !== 'ok') throw new Error(`the tasks part answered ${part.state}`)
  return part
}

/**
 * Checks that the task window answers `person` what their tasks part says
 * of every task it holds, and unavailable or archived for every other task
 * of the organization. Answers how many tasks it compared.
 */
async function expectParity(t: T, orgId: string, person: Doc<'profiles'>): Promise<number> {
  const caller = t.withIdentity({ subject: person.auth_user_id as string })
  const part = await tasksPart(caller, orgId)
  const read = await t.run(async (ctx) => {
    const me = (await ctx.db.get(person._id)) as Doc<'profiles'>
    const tasks = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const levels: [string, string | null][] = []
    for (const id of new Set(tasks.map((task) => task.project_id))) {
      const project = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      levels.push([id, project === null ? null : await projectLevel(ctx, me, project)])
    }
    // each archived task the caller sees with what the window shows of it
    const archived: [string, unknown][] = []
    for (const task of tasks.filter((row) => row.archived_at !== undefined)) {
      const row = await archivedTaskCore(ctx, new Map([[orgId, me]]), task.id)
      const labels = await ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .collect()
      archived.push([
        task.id,
        row && {
          state: 'archived',
          task: row,
          description: await descriptionOf(ctx.db, task),
          labels: labels.map(relationRow),
        },
      ])
    }
    return { tasks, levels, archived }
  })
  const { tasks } = read
  const levels = new Map(read.levels)
  const archived = new Map(read.archived)
  const byId = new Map(part.issues.map((row) => [row.id, row]))
  const short = (id: string) => {
    const row = byId.get(id)
    if (row === undefined) throw new Error(`the part does not hold ${id}`)
    return cut(row, levels.get(row.project_id))
  }
  for (const row of part.issues) {
    const window = await caller.query(api.taskWindow.task, { org_id: orgId, ref: row.id })
    if (window.state !== 'ok') throw new Error(`${row.title}: ${window.state}`)
    expect(window.task, row.title).toEqual(row)
    expect(window.level, row.title).toBe(levels.get(row.project_id))
    expect(
      [...window.labels].sort((a, b) => order(a.label_id, b.label_id)),
      row.title,
    ).toEqual(
      part.issueLabels
        .filter((label) => label.issue_id === row.id)
        .sort((a, b) => order(a.label_id, b.label_id)),
    )
    expect(window.follow, row.title).toEqual(
      part.issueSubs.find((follow) => follow.issue_id === row.id) ?? null,
    )
    expect(window.parent, row.title).toEqual(
      row.parent_id === undefined ? null : short(row.parent_id),
    )
    expect(window.subtasks, row.title).toEqual({
      rows: part.issues
        .filter((kid) => kid.parent_id === row.id)
        .sort(byNumber)
        .map((kid) => short(kid.id)),
      complete: true,
    })
    const links = await caller.query(api.taskWindow.links, { org_id: orgId, issue_id: row.id })
    const named = part.links
      .filter((link) => link.source_id === row.id || link.target_id === row.id)
      .sort(byCreation)
    const ends = [
      ...new Set(
        named.map((link) => (link.source_id === row.id ? link.target_id : link.source_id)),
      ),
    ]
    expect(links, row.title).toEqual({
      state: 'ok',
      links: named,
      tasks: ends.map(short),
      complete: true,
    })
    const files = part.attachments.filter((file) => file.issue_id === row.id).sort(byCreation)
    expect(
      await caller.query(api.taskWindow.attachments, { org_id: orgId, issue_id: row.id }),
      row.title,
    ).toEqual({
      state: 'ok',
      rows: files,
      count: files.filter((file) => file.dropped_at === undefined).length,
      complete: true,
    })
  }
  for (const task of tasks.filter((row) => !byId.has(row.id))) {
    const shown = archived.get(task.id) ?? null
    expect(
      await caller.query(api.taskWindow.task, { org_id: orgId, ref: task.id }),
      task.title,
    ).toEqual(
      shown === null
        ? { state: 'unavailable' }
        : { ...(shown as object), level: levels.get(task.project_id) },
    )
    expect(await caller.query(api.taskWindow.links, { org_id: orgId, issue_id: task.id })).toEqual({
      state: 'unavailable',
    })
    expect(
      await caller.query(api.taskWindow.attachments, { org_id: orgId, issue_id: task.id }),
    ).toEqual({ state: 'unavailable' })
  }
  return part.issues.length
}

/* A link row from `source` to `target`, as a writer stores it. */
const linkRow = (
  f: OrgFixture,
  source: Pick<Doc<'issues'>, 'id' | 'window_key'>,
  targetId: string,
  extra: Partial<Doc<'issue_links'>> = {},
) => ({
  org_id: f.org.id,
  id: uuid(),
  source_id: source.id,
  target_id: targetId,
  type: 'blocks' as const,
  pair_key: [source.id, targetId].sort().join(':'),
  created_at: NOW,
  task_key: source.window_key,
  ...extra,
})

/**
 * The fixture's tasks the window must tell apart. Before it, the guest's
 * grant on TBED moves to FW and PCB, and a sub-project of TBED the guest
 * cannot see (`sibling`) and an archived one (`shelved`) are planted.
 */
async function plantWorld(t: T, f: OrgFixture) {
  const sibling = await plantHiddenSibling(t, f, f.guest)
  const shelved = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    archived_at: NOW,
  })
  const task = (project: Doc<'projects'>, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: f.org.id, project_id: project.id, ...extra })
  const parent = await task(f.sub, { title: 'Parent', description: 'Bring up the board' })
  const kids = {
    shown: await task(f.sub, { title: 'Shown subtask', status: 'done', parent_id: parent.id }),
    other: await task(f.sub2, {
      title: 'Subtask in PCB',
      parent_id: parent.id,
      remaining_hours: 3,
      remaining_set_at: NOW,
    }),
    hidden: await task(sibling, { title: 'Subtask the guest cannot see', parent_id: parent.id }),
    shelved: await task(shelved, { title: 'Subtask in an archived project', parent_id: parent.id }),
    archived: await task(f.sub, {
      title: 'Archived subtask',
      parent_id: parent.id,
      archived_at: NOW,
    }),
  }
  const hiddenParent = await task(sibling, { title: 'Parent the guest cannot see' })
  const orphan = await task(f.sub, {
    title: 'Subtask of a hidden parent',
    parent_id: hiddenParent.id,
  })
  // a group whose subtask is a group too, stored before the rule of one level
  const legacy = await task(f.sub, { title: 'Legacy group' })
  const legacyKid = await task(f.sub, { title: 'Legacy subgroup', parent_id: legacy.id })
  await task(f.sub, { title: 'Legacy leaf', parent_id: legacyKid.id })
  const secret = await task(f.hidden, { title: 'Secret' })
  // stored under the top-level project, as older code did
  const onMeta = await task(f.meta, { title: 'On the top-level project' })
  const archived = await task(f.sub, { title: 'Archived', archived_at: NOW })
  // restored before its archive marks were cleared
  const marked = await task(f.sub, { title: 'Marked', relations_marked: true })
  const markedToo = await task(f.sub, { title: 'Also marked', relations_marked: true })
  const gone = uuid()
  const links = await t.run(async (ctx) => {
    const rows = {
      toShown: linkRow(f, parent, kids.shown.id),
      fromOther: linkRow(f, kids.other, parent.id, { type: 'relates' }),
      toSecret: linkRow(f, parent, secret.id),
      fromArchived: linkRow(f, archived, parent.id, { task_archived: true }),
      toShelved: linkRow(f, parent, kids.shelved.id),
      toGone: linkRow(f, parent, gone),
      fromHidden: linkRow(f, hiddenParent, parent.id),
      fromMarked: linkRow(f, marked, parent.id, { task_archived: true }),
      // marked links into the restored task: the tasks part sends the one
      // from an unflagged source with the flagged task, and the one between
      // two flagged tasks with its source
      intoMarked: linkRow(f, kids.shown, marked.id, { task_archived: true }),
      markedToMarked: linkRow(f, marked, markedToo.id, { task_archived: true }),
      toMeta: linkRow(f, parent, onMeta.id, { created_at: '2025-12-31T00:00:00.000Z' }),
    }
    for (const row of Object.values(rows)) await ctx.db.insert('issue_links', row)
    for (const label of ['label-a', 'label-b'])
      await ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: parent.id,
        label_id: label,
        task_key: parent.window_key,
      })
    await ctx.db.insert('issue_labels', {
      org_id: f.org.id,
      issue_id: marked.id,
      label_id: 'label-a',
      task_archived: true,
      task_key: marked.window_key,
    })
    for (const person of [f.admin, f.user, f.viewer, f.guest])
      await ctx.db.insert('issue_subscriptions', {
        issue_id: parent.id,
        profile_id: person.id,
        created_at: NOW,
        task_key: parent.window_key,
      })
    await ctx.db.insert('issue_subscriptions', {
      issue_id: marked.id,
      profile_id: f.guest.id,
      created_at: NOW,
      task_archived: true,
      task_key: marked.window_key,
    })
    const file = (extra: Partial<Doc<'issue_attachments'>>) =>
      ctx.storage.store(new Blob(['bytes']) as never).then((storage_id) =>
        ctx.db.insert('issue_attachments', {
          org_id: f.org.id,
          id: uuid(),
          issue_id: parent.id,
          name: 'file.txt',
          size_bytes: 5,
          storage_id,
          inline: false,
          created_at: NOW,
          task_key: parent.window_key,
          ...extra,
        }),
      )
    await file({ name: 'spec.pdf', created_at: '2026-01-02T00:00:00.000Z' })
    await file({ name: 'board.png', inline: true, mime: 'image/png' })
    await file({ name: 'old.png', inline: true, dropped_at: NOW })
    return rows
  })
  return {
    sibling,
    shelved,
    parent,
    kids,
    hiddenParent,
    orphan,
    legacy,
    legacyKid,
    secret,
    onMeta,
    archived,
    marked,
    markedToo,
    gone,
    links,
  }
}

describe('parity with the tasks part', () => {
  it('answers what the tasks part says of every task, for guest, viewer, member and admin seats', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    for (const person of [f.guest, f.viewer, f.user, f.admin])
      expect(await expectParity(t, f.org.id, person), person.name).toBeGreaterThan(5)
    // the part sends each marked link once: into the restored task from an
    // unflagged source with that task, and between flagged tasks with its source
    const part = await tasksPart(as(t, f.guest), f.org.id)
    for (const link of [w.links.intoMarked, w.links.markedToMarked, w.links.fromMarked])
      expect(part.links.filter((row) => row.id === link.id)).toHaveLength(1)
  }, 120_000)

  it('answers what the tasks part says of every Northstar task, for every person', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    let compared = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined))
      compared += await expectParity(t, org.id, person)
    expect(compared).toBeGreaterThan(100)
  }, 300_000)

  it('tells a hidden subtask by has_hidden_subtasks, and a subtask in an archived project not at all', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const ask = (person: Doc<'profiles'>) =>
      as(t, person).query(api.taskWindow.task, { org_id: f.org.id, ref: w.parent.id })
    const guest = await ask(f.guest)
    if (guest.state !== 'ok') throw new Error(guest.state)
    expect(guest.task.has_subtasks).toBe(true)
    expect(guest.task.has_hidden_subtasks).toBe(true)
    expect(guest.subtasks.rows.map((row) => row.id)).toEqual([w.kids.shown.id, w.kids.other.id])
    expect(JSON.stringify(guest)).not.toContain(w.kids.hidden.id)
    expect(JSON.stringify(guest)).not.toContain(w.kids.shelved.id)
    const part = await tasksPart(as(t, f.guest), f.org.id)
    expect(part.issues.find((row) => row.id === w.parent.id)?.has_hidden_subtasks).toBe(true)
    const admin = await ask(f.admin)
    if (admin.state !== 'ok') throw new Error(admin.state)
    expect(admin.task.has_hidden_subtasks).toBe(false)
    expect(admin.subtasks.rows.map((row) => row.id)).toEqual([
      w.kids.shown.id,
      w.kids.other.id,
      w.kids.hidden.id,
    ])
  })
})

describe('refusals', () => {
  it('answers one unavailable for every task the caller may not open', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      num: 4242,
    })
    const deleted = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: deleted.id })
    // the admin's login also holds a seat in the other organization, where
    // this task is archived
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      org_role: 'admin',
      auth_user_id: f.admin.auth_user_id,
    })
    const foreignArchived = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      archived_at: NOW,
    })
    const refusals: [string, Doc<'profiles'>, string][] = [
      ['an unknown uuid', f.admin, uuid()],
      ["another organization's uuid", f.admin, foreign.id],
      ['a number only another organization holds', f.admin, 'QN-4242'],
      ['a task in a project the caller cannot see', f.guest, w.secret.id],
      ['a task moved to Deleted items', f.admin, deleted.id],
      ['an active task in an archived project', f.admin, w.kids.shelved.id],
      [
        "an archived task of another organization of the caller's login",
        f.admin,
        foreignArchived.id,
      ],
    ]
    for (const [reason, person, ref] of refusals) {
      for (const answer of [
        await as(t, person).query(api.taskWindow.task, { org_id: f.org.id, ref }),
        await as(t, person).query(api.taskWindow.links, { org_id: f.org.id, issue_id: ref }),
        await as(t, person).query(api.taskWindow.attachments, { org_id: f.org.id, issue_id: ref }),
      ])
        expect(answer, reason).toEqual({ state: 'unavailable' })
    }
    // the other seat sees the archived task where it is pinned
    expect(
      await as(t, f.admin).query(api.taskWindow.task, {
        org_id: f.otherOrg.id,
        ref: foreignArchived.id,
      }),
    ).toMatchObject({ state: 'archived', task: { id: foreignArchived.id } })
  })

  it('answers unavailable, not an error, for a task in a project whose tree is broken', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a sub-project whose parent row is gone, and two that are each other's parent
    const orphaned = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: uuid() })
    const a = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const b = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: a.id })
    await t.run((ctx) => ctx.db.patch(a._id, { parent_id: b.id }))
    for (const project of [orphaned, a]) {
      for (const extra of [{}, { archived_at: NOW }]) {
        const task = await plantIssue(t, { org_id: f.org.id, project_id: project.id, ...extra })
        expect(
          await as(t, f.admin).query(api.taskWindow.task, { org_id: f.org.id, ref: task.id }),
        ).toEqual({ state: 'unavailable' })
      }
    }
  })

  it('resolves a number both organizations hold to the pinned organization only', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the other organization's task is stored first, so a lookup by number
    // without the organization would find it
    await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id, num: 7777 })
    const mine = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, num: 7777 })
    for (const ref of ['QN-7777', '7777']) {
      const answer = await as(t, f.admin).query(api.taskWindow.task, { org_id: f.org.id, ref })
      expect(answer).toMatchObject({ state: 'ok', task: { id: mine.id } })
    }
  })

  it('answers archived with the Archived tasks row of an archived task the caller sees', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const row = await as(t, f.guest).query(api.issues.archivedTask, { id: w.archived.id })
    expect(row).not.toBeNull()
    expect(
      await as(t, f.guest).query(api.taskWindow.task, { org_id: f.org.id, ref: w.archived.id }),
    ).toEqual({ state: 'archived', task: row, description: '', labels: [], level: 'user' })
    // the guest cannot see the hidden project, so its archived task is unavailable
    const secret = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      archived_at: NOW,
    })
    expect(
      await as(t, f.guest).query(api.taskWindow.task, { org_id: f.org.id, ref: secret.id }),
    ).toEqual({ state: 'unavailable' })
  })

  it("answers an archived task's text, labels and the caller's level, so the window shows it read-only", async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Protection ratings and both connector orientations',
      archived_at: NOW,
    })
    await t.run(async (ctx) => {
      for (const label of ['label-b', 'label-a'])
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: task.id,
          label_id: label,
          task_archived: true,
          task_key: task.window_key,
        })
    })
    // the text is in its description row alone, as the third release left it
    expect(task.description).toBeUndefined()
    for (const [who, level] of [
      [f.admin, 'lead'],
      [f.guest, 'user'],
      [f.viewer, 'viewer'],
    ] as const) {
      const answer = await as(t, who).query(api.taskWindow.task, { org_id: f.org.id, ref: task.id })
      expect(answer, who.name).toMatchObject({
        state: 'archived',
        task: { id: task.id, is_group: false, archived_at: NOW },
        description: 'Protection ratings and both connector orientations',
        level,
      })
      if (answer.state !== 'archived') throw new Error(answer.state)
      // label rows as the tasks part sends them, without the archive mark
      expect(answer.labels.map((label) => label.label_id).sort()).toEqual(['label-a', 'label-b'])
      for (const label of answer.labels) expect(Object.keys(label)).not.toContain('task_archived')
      // the page row names no parent and holds no text
      expect(Object.keys(answer.task)).not.toContain('description')
    }
    // nothing of it reaches a person who cannot see its project, nor
    // another organization's admin
    const secret = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      description: 'Secret notes',
      archived_at: NOW,
    })
    expect(
      await as(t, f.guest).query(api.taskWindow.task, { org_id: f.org.id, ref: secret.id }),
    ).toEqual({ state: 'unavailable' })
    const elsewhere = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      description: 'Elsewhere',
      archived_at: NOW,
    })
    expect(
      await as(t, f.admin).query(api.taskWindow.task, { org_id: f.org.id, ref: elsewhere.id }),
    ).toEqual({ state: 'unavailable' })
  })

  it('answers an archived task in an archived project as archived', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      description: 'Board notes',
      archived_at: NOW,
    })
    await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW, archive_state: 'listed' }))
    expect(
      await as(t, f.guest).query(api.taskWindow.task, { org_id: f.org.id, ref: task.id }),
    ).toMatchObject({ state: 'archived', task: { id: task.id }, description: 'Board notes' })
  })
})

describe('refs', () => {
  it('resolves QN-12, 12 and an uppercase uuid to the same task, and nothing else', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, num: 12 })
    const ask = (ref: string) =>
      as(t, f.guest).query(api.taskWindow.task, { org_id: f.org.id, ref })
    for (const ref of ['QN-12', 'qn-12', '12', task.id.toUpperCase(), task.id])
      expect(await ask(ref), ref).toMatchObject({ state: 'ok', task: { id: task.id } })
    for (const ref of ['', 'QN-', 'QN-0', 'XX-12', '12a', ' 12', 'QN-3000000000', `${task.id}0`])
      expect(await ask(ref), ref).toEqual({ state: 'unavailable' })
  })
})

describe('what a read reveals', () => {
  it('leaves out every link whose other end the caller is not shown, with both ids', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const answer = await as(t, f.guest).query(api.taskWindow.links, {
      org_id: f.org.id,
      issue_id: w.parent.id,
    })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.links.map((link) => link.id)).toEqual([
      w.links.toMeta.id,
      ...[w.links.toShown, w.links.fromOther, w.links.fromMarked]
        .sort(byCreation)
        .map((link) => link.id),
    ])
    expect(answer.tasks.map((row) => row.id)).toEqual(
      answer.links.map((link) =>
        link.source_id === w.parent.id ? link.target_id : link.source_id,
      ),
    )
    expect(answer.complete).toBe(true)
    const json = JSON.stringify(answer)
    for (const absent of [
      w.links.toSecret,
      w.links.fromArchived,
      w.links.toShelved,
      w.links.toGone,
      w.links.fromHidden,
    ]) {
      expect(json).not.toContain(absent.id)
      expect(json).not.toContain(
        absent.source_id === w.parent.id ? absent.target_id : absent.source_id,
      )
    }
  })

  it('names a parent only when the caller is shown it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const guest = await as(t, f.guest).query(api.taskWindow.task, {
      org_id: f.org.id,
      ref: w.orphan.id,
    })
    if (guest.state !== 'ok') throw new Error(guest.state)
    expect(guest.parent).toBeNull()
    expect(guest.task.has_hidden_parent).toBe(true)
    expect('parent_id' in guest.task).toBe(false)
    expect(JSON.stringify(guest)).not.toContain(w.hiddenParent.id)
    const admin = await as(t, f.admin).query(api.taskWindow.task, {
      org_id: f.org.id,
      ref: w.orphan.id,
    })
    expect(admin).toMatchObject({
      state: 'ok',
      task: { parent_id: w.hiddenParent.id, has_hidden_parent: false },
      parent: { id: w.hiddenParent.id, has_subtasks: true, level: 'lead' },
    })
  })

  it('tells a subtask stored as a group before the rule of one level', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const answer = await as(t, f.guest).query(api.taskWindow.task, {
      org_id: f.org.id,
      ref: w.legacy.id,
    })
    expect(answer).toMatchObject({
      state: 'ok',
      subtasks: { rows: [{ id: w.legacyKid.id, has_subtasks: true }], complete: true },
    })
  })
})

describe('the text', () => {
  it('comes from the description row, and from the task row only for a task without one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Shown text',
    })
    const ask = async () => {
      const answer = await as(t, f.guest).query(api.taskWindow.task, {
        org_id: f.org.id,
        ref: task.id,
      })
      if (answer.state !== 'ok') throw new Error(answer.state)
      return answer.task.description
    }
    // a release from before the table changed only the task row
    await t.run((ctx) => ctx.db.patch(task._id, { description: 'Stale copy' }))
    expect(await ask()).toBe('Shown text')
    // the third release clears the task row's copy
    await t.run((ctx) => ctx.db.patch(task._id, { description: undefined }))
    expect(await ask()).toBe('Shown text')
    // a task the backfill has not given a row
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('issue_descriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .unique()
      if (row !== null) await ctx.db.delete(row._id)
      await ctx.db.patch(task._id, { description: 'Task row text' })
    })
    expect(await ask()).toBe('Task row text')
  })
})

describe('attachments', () => {
  it('lists files and description images, those taken out within the day too, and counts the rest', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    const answer = await as(t, f.guest).query(api.taskWindow.attachments, {
      org_id: f.org.id,
      issue_id: w.parent.id,
    })
    if (answer.state !== 'ok') throw new Error(answer.state)
    // oldest first, then by id
    expect(answer.rows).toEqual([...answer.rows].sort(byCreation))
    expect(answer.rows.map((row) => [row.name, row.inline, row.dropped_at ?? null]).sort()).toEqual(
      [
        ['board.png', true, null],
        ['old.png', true, NOW],
        ['spec.pdf', false, null],
      ],
    )
    expect(answer.rows.at(-1)?.name).toBe('spec.pdf')
    expect(answer.count).toBe(2)
    expect(answer.complete).toBe(true)
    for (const row of answer.rows) expect(Object.keys(row)).not.toContain('task_archived')
  })

  it('stops at TASK_WINDOW.attachments rows and says so', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWorld(t, f)
    TASK_WINDOW.attachments = 2
    const answer = await as(t, f.guest).query(api.taskWindow.attachments, {
      org_id: f.org.id,
      issue_id: w.parent.id,
    })
    expect(answer).toMatchObject({ state: 'ok', complete: false })
    if (answer.state === 'ok') expect(answer.rows).toHaveLength(2)
  })
})

/* ------------------------------------------------------------ real limits */

/* The number of the next task plantMany plants. */
let nextNum = 50_000

/** Plants `n` tasks with `fields(i)` in the fixture's FW, `each` a
 * transaction, through raw inserts: with a description row when `rows`,
 * else as older code stored them, with the text only on the task row. */
async function plantMany(
  t: T,
  f: OrgFixture,
  n: number,
  fields: (i: number) => Partial<Doc<'issues'>>,
  o: { each: number; rows: boolean },
): Promise<Doc<'issues'>[]> {
  const planted: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += o.each)
    planted.push(
      ...(await t.run(async (ctx) => {
        const out: Doc<'issues'>[] = []
        for (let i = from; i < Math.min(n, from + o.each); i++) {
          const doc = {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: nextNum++,
            title: `Task ${i}`,
            description: '',
            status: 'todo' as const,
            priority: 'medium' as const,
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...fields(i),
          }
          const _id = await ctx.db.insert('issues', doc)
          if (o.rows)
            await ctx.db.insert('issue_descriptions', {
              issue_id: doc.id,
              description: doc.description,
              org_id: doc.org_id,
              project_id: doc.project_id,
            })
          out.push((await ctx.db.get(_id)) as Doc<'issues'>)
        }
        return out
      })),
    )
  return planted
}

/** Links from `task` to each of `targets`. */
const linkAll = (t: T, f: OrgFixture, task: Doc<'issues'>, targets: readonly Doc<'issues'>[]) =>
  t.run(async (ctx) => {
    for (const target of targets) await ctx.db.insert('issue_links', linkRow(f, task, target.id))
  })

/* What a read in t.run read, in MiB to two decimals. */
const mib = (m: { bytesRead: { used: number } }) => Math.round((m.bytesRead.used / MIB) * 100) / 100

/** readWindowTask for `who`, the fixture's guest unless named, with what it
 * read, in MiB, documents and index ranges. */
const taskRead = (t: T, f: OrgFixture, ref: string, who = f.guest) =>
  t.run(async (ctx) => {
    const answer = await readWindowTask(ctx, who, ref)
    const m = await ctx.meta.getTransactionMetrics()
    return { answer, read: mib(m), documents: m.documentsRead.used, ranges: m.databaseQueries.used }
  })

/** readWindowLinks for `who`, the fixture's guest unless named, with what it
 * read, in MiB, documents and index ranges. */
const linksRead = (t: T, f: OrgFixture, id: string, who = f.guest) =>
  t.run(async (ctx) => {
    const answer = await readWindowLinks(ctx, who, id)
    const m = await ctx.meta.getTransactionMetrics()
    return { answer, read: mib(m), documents: m.documentsRead.used, ranges: m.databaseQueries.used }
  })

/* A name at the cap whose name key NFKD expands 18 times, and a project
 * description at the cap in a three-byte script, the largest a project row
 * holds (lib/limits.ts PROJECT_ROW_MAX_BYTES). */
const WIDE_NAME = '\uFDFA'.repeat(NAME_MAX)
const WIDE_DESCRIPTION = '\u4E00'.repeat(LIMITS.projectDescription.max)

/** `n` sub-projects of TBED, which the guest and the viewer see through
 * their grants there, each at the row bound. */
async function wideProjects(t: T, f: OrgFixture, n: number): Promise<Doc<'projects'>[]> {
  const out: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    out.push(
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.meta.id,
        name: WIDE_NAME,
        name_key: nameKey(WIDE_NAME),
        description: WIDE_DESCRIPTION,
      }),
    )
  return out
}

/** `n` teams of the fixture's organization named at the cap, each sharing
 * `project` alone with its name key copied, the viewer, named at the cap, a
 * member of the first with the key of its name copied. */
async function distinctShares(t: T, f: OrgFixture, project: Doc<'projects'>, n: number) {
  for (let from = 0; from < n; from += 250)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.viewer._id, { name: WIDE_NAME, name_key: nameKey(WIDE_NAME) })
      for (let i = from; i < Math.min(n, from + 250); i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: WIDE_NAME,
          name_key: nameKey(WIDE_NAME),
          track_delay_default: false,
          created_at: NOW,
        })
        if (i === 0)
          await ctx.db.insert('team_members', {
            team_id: id,
            profile_id: f.viewer.id,
            is_leader: false,
            name_key: nameKey(WIDE_NAME),
          })
        await ctx.db.insert('project_team_access', {
          project_id: project.id,
          team_id: id,
          level: 'viewer',
          name_key: nameKey(WIDE_NAME),
        })
      }
    })
}

describe('real limits', () => {
  it('reads an archived task at the description cap with its labels within TASK_WINDOW', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({ description: LARGEST, archived_at: NOW }), {
      each: 1,
      rows: true,
    })
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.labels.max; i++)
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: task.id,
          label_id: uuid(),
          task_archived: true,
          task_key: task.window_key,
        })
    })
    const { answer, read, documents, ranges } = await taskRead(t, f, task.id)
    if (answer.state !== 'archived') throw new Error(answer.state)
    expect(answer.description).toBe(LARGEST)
    expect(answer.labels).toHaveLength(LIMITS.labels.max)
    expect(read).toBeLessThan(1)
    expect(documents).toBeLessThan(TASK_WINDOW.documents)
    expect(ranges).toBeLessThan(TASK_WINDOW.ranges)
  }, 120_000)

  it('reads 100 subtasks at the description cap in a three-byte script, complete and within TASK_WINDOW.bytes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [grandparent] = await plantMany(t, f, 1, () => ({ description: LARGEST }), {
      each: 1,
      rows: true,
    })
    const [task] = await plantMany(
      t,
      f,
      1,
      () => ({ description: LARGEST, parent_id: grandparent.id }),
      { each: 1, rows: true },
    )
    await plantMany(t, f, 100, () => ({ description: LARGEST, parent_id: task.id }), {
      each: 25,
      rows: true,
    })
    const { answer, read } = await taskRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.subtasks.complete).toBe(true)
    expect(answer.subtasks.rows).toHaveLength(100)
    expect(answer.task.has_hidden_subtasks).toBe(false)
    expect(answer.task.description).toBe(LARGEST)
    expect(answer.parent?.id).toBe(grandparent.id)
    expect(read).toBeGreaterThan(5.5)
    expect(read).toBeLessThan(TASK_WINDOW.bytes / MIB)
  }, 120_000)

  it('reads 100 links to leaves at the cap, complete and within TASK_WINDOW.linkBytes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({ description: LARGEST }), {
      each: 1,
      rows: true,
    })
    const leaves = await plantMany(t, f, 100, () => ({ description: LARGEST }), {
      each: 25,
      rows: true,
    })
    await linkAll(t, f, task, leaves)
    const { answer, read } = await linksRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.complete).toBe(true)
    expect(answer.links).toHaveLength(100)
    expect(answer.tasks.every((row) => !row.has_subtasks)).toBe(true)
    expect(read).toBeLessThan(TASK_WINDOW.linkBytes / MIB)
  }, 120_000)

  it('reads 100 links to groups whose first subtasks are at the cap, complete and within TASK_WINDOW.linkBytes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({ description: LARGEST }), {
      each: 1,
      rows: true,
    })
    const groups = await plantMany(t, f, 100, () => ({ description: LARGEST }), {
      each: 25,
      rows: true,
    })
    await plantMany(t, f, 100, (i) => ({ description: LARGEST, parent_id: groups[i].id }), {
      each: 25,
      rows: true,
    })
    await linkAll(t, f, task, groups)
    const { answer, read } = await linksRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.complete).toBe(true)
    expect(answer.tasks).toHaveLength(100)
    expect(answer.tasks.every((row) => row.has_subtasks)).toBe(true)
    expect(read).toBeGreaterThan(11)
    expect(read).toBeLessThan(TASK_WINDOW.linkBytes / MIB)
  }, 120_000)

  it('reads 100 links to groups whose first subtasks, at the cap, are each in a sub-project of their own, complete and within TASK_WINDOW.linkBytes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const projects = await wideProjects(t, f, 100)
    const [task] = await plantMany(t, f, 1, () => ({ description: LARGEST }), {
      each: 1,
      rows: true,
    })
    const groups = await plantMany(t, f, 100, () => ({ description: LARGEST }), {
      each: 25,
      rows: true,
    })
    await plantMany(
      t,
      f,
      100,
      (i) => ({ description: LARGEST, parent_id: groups[i].id, project_id: projects[i].id }),
      { each: 25, rows: true },
    )
    await linkAll(t, f, task, groups)
    const { answer, ...reads } = await linksRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    console.log('100 linked groups, first subtasks in 100 sub-projects:', {
      ...reads,
      tasks: answer.tasks.length,
      complete: answer.complete,
    })
    expect(answer.complete).toBe(true)
    expect(answer.tasks).toHaveLength(100)
    expect(answer.tasks.every((row) => row.has_subtasks)).toBe(true)
    expect(reads.read).toBeGreaterThan(11)
    expect(reads.read).toBeLessThan(TASK_WINDOW.linkBytes / MIB)
  }, 300_000)

  it('reads 100 subtasks at the cap, each in a sub-project of their own, complete and within TASK_WINDOW.bytes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const projects = await wideProjects(t, f, 100)
    const [task] = await plantMany(t, f, 1, () => ({ description: LARGEST }), {
      each: 1,
      rows: true,
    })
    await plantMany(
      t,
      f,
      100,
      (i) => ({ description: LARGEST, parent_id: task.id, project_id: projects[i].id }),
      { each: 25, rows: true },
    )
    const { answer, ...reads } = await taskRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    console.log('100 subtasks in 100 sub-projects:', {
      ...reads,
      rows: answer.subtasks.rows.length,
      complete: answer.subtasks.complete,
    })
    expect(answer.subtasks.complete).toBe(true)
    expect(answer.subtasks.rows).toHaveLength(100)
    expect(answer.task.has_hidden_subtasks).toBe(false)
    expect(reads.read).toBeLessThan(TASK_WINDOW.bytes / MIB)
  }, 300_000)

  it('stops a link read inside the limits at link ends in sub-projects shared with 600 teams of their own each', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // twelve sub-projects, each shared with 600 teams of its own at the
    // name cap, about 1.7 MB of shares, which the viewer's access read whole
    // on each project it asked about before lib/access.ts OWN_READS bounded
    // them. One step takes the twelve ends, one in each of them, and asked
    // about them together they would read past Convex's 16 MiB.
    const projects = await wideProjects(t, f, 12)
    for (const p of projects) await distinctShares(t, f, p, 600)
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    const ends = await plantMany(t, f, 12, (i) => ({ project_id: projects[i].id }), {
      each: 12,
      rows: true,
    })
    await linkAll(t, f, task, ends)
    const { answer, ...reads } = await linksRead(t, f, task.id, f.viewer)
    if (answer.state !== 'ok') throw new Error(answer.state)
    console.log('12 link ends in 12 sub-projects of 600 shares of their own:', {
      ...reads,
      links: answer.links.length,
      complete: answer.complete,
    })
    // The access reads at most OWN_READS.projectShares and one more of each
    // project's shares and then the viewer's own rows, which name no team,
    // so it reads a small part of the 7,200 shares and every end is checked
    // inside the limits; the viewer sees them through TBED.
    expect(answer.complete).toBe(true)
    expect(answer.links).toHaveLength(12)
    expect(answer.tasks.map((row) => row.id)).toEqual(answer.links.map((link) => link.target_id))
    expect(reads.documents).toBeLessThan(12 * (OWN_READS.projectShares + 1) + 200)
    expect(reads.read).toBeLessThan(TASK_WINDOW.linkBytes / MIB)
  }, 300_000)

  it('stops at older subtasks near 900 KB with complete false, the rows read, and no error', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    const legacy = 'o'.repeat(900 * 1024)
    await plantMany(t, f, 12, () => ({ description: legacy, parent_id: task.id }), {
      each: 4,
      rows: false,
    })
    const { answer, read } = await taskRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.subtasks.complete).toBe(false)
    expect(answer.subtasks.rows.length).toBeGreaterThan(5)
    expect(answer.subtasks.rows.length).toBeLessThan(12)
    expect(answer.task.has_subtasks).toBe(true)
    expect(answer.task.has_hidden_subtasks).toBe(true)
    // past the budget by one row at most
    expect(read).toBeLessThanOrEqual(TASK_WINDOW.bytes / MIB + 1)
  }, 120_000)

  it('stops at older link ends near 900 KB with complete false, the links read, and no error', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    const legacy = 'o'.repeat(900 * 1024)
    const ends = await plantMany(t, f, 18, () => ({ description: legacy }), {
      each: 4,
      rows: false,
    })
    await linkAll(t, f, task, ends)
    const { answer, read } = await linksRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.complete).toBe(false)
    expect(answer.links.length).toBeGreaterThan(10)
    expect(answer.links.length).toBeLessThan(18)
    expect(answer.tasks.map((row) => row.id)).toEqual(answer.links.map((link) => link.target_id))
    expect(read).toBeLessThanOrEqual(TASK_WINDOW.linkBytes / MIB + 1)
  }, 120_000)

  it('answers n subtasks and n links complete at TASK_WINDOW.rows = n, and n + 1 incomplete', async () => {
    const t = newT()
    const f = await withOrg(t)
    TASK_WINDOW.rows = 3
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    const kids = await plantMany(t, f, 3, () => ({ parent_id: task.id }), { each: 4, rows: true })
    await linkAll(t, f, task, kids)
    const subtasks = async () => {
      const answer = await taskRead(t, f, task.id)
      if (answer.answer.state !== 'ok') throw new Error(answer.answer.state)
      return answer.answer.subtasks
    }
    const links = async () => {
      const answer = await linksRead(t, f, task.id)
      if (answer.answer.state !== 'ok') throw new Error(answer.answer.state)
      return answer.answer
    }
    expect(await subtasks()).toMatchObject({ complete: true, rows: { length: 3 } })
    expect(await links()).toMatchObject({ complete: true, links: { length: 3 } })
    const [fourth] = await plantMany(t, f, 1, () => ({ parent_id: task.id }), {
      each: 1,
      rows: true,
    })
    await linkAll(t, f, task, [fourth])
    expect(await subtasks()).toMatchObject({ complete: false, rows: { length: 3 } })
    expect(await links()).toMatchObject({ complete: false, links: { length: 3 } })
  })

  it('leaves out a link end whose group fact the budget leaves unread, and says so', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    const groups = await plantMany(t, f, 3, () => ({}), { each: 3, rows: true })
    // each group's subtask is an older row near 900 KB, so the first two
    // read spend the budget
    const legacy = 'o'.repeat(900 * 1024)
    await plantMany(t, f, 3, (i) => ({ description: legacy, parent_id: groups[i].id }), {
      each: 1,
      rows: false,
    })
    await linkAll(t, f, task, groups)
    // room for the three small ends, and for one group check while any
    // bytes are unspent
    TASK_WINDOW.linkBytes = MIB + 200 * 1024
    const { answer } = await linksRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.complete).toBe(false)
    expect(answer.tasks).toEqual([
      expect.objectContaining({ has_subtasks: true }),
      expect.objectContaining({ has_subtasks: true }),
    ])
    expect(answer.links.map((link) => link.target_id)).toEqual(answer.tasks.map((row) => row.id))
  })

  it('answers an archived task under a parent of thousands of sub-projects within the index ranges', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // the viewer sees this top-level project only for navigation, through a
    // grant on its last sub-project; canSeeProject's walk would ask the
    // viewer's grant and team shares on each sub-project first, two ranges
    // a sub-project, past 4,096
    const top = await plantProject(t, { org_id: f.org.id })
    let last = ''
    for (let from = 0; from < 2100; from += 700)
      last = await t.run(async (ctx) => {
        let id = ''
        for (let i = from; i < from + 700; i++) {
          id = uuid()
          await ctx.db.insert('projects', {
            id,
            org_id: f.org.id,
            type: 'project',
            parent_id: top.id,
            key: `S${i}`,
            name: `Sub-project ${i}`,
            description: '',
            sort_order: 1000 + i,
            num: 1000 + i,
            track_delay: false,
            created_at: NOW,
            window_key: newWindowKey(),
          })
        }
        return id
      })
    await t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: last, profile_id: f.viewer.id, level: 'user' }),
    )
    // stored under the top-level project, as older code did
    const task = await plantIssue(t, { org_id: f.org.id, project_id: top.id, archived_at: NOW })
    expect(
      await as(t, f.viewer).query(api.taskWindow.task, { org_id: f.org.id, ref: task.id }),
    ).toMatchObject({ state: 'archived', task: { id: task.id, is_group: false } })
  }, 120_000)

  it('stops the group checks of an end whose subtasks are in thousands of archived projects before the index ranges run out', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task, end] = await plantMany(t, f, 2, () => ({}), { each: 2, rows: true })
    await linkAll(t, f, task, [end])
    // each subtask in an archived sub-project of its own, so none makes the
    // end a group, and each one's project is one more read
    for (let from = 0; from < 4200; from += 700)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 700; i++) {
          const project = uuid()
          await ctx.db.insert('projects', {
            id: project,
            org_id: f.org.id,
            type: 'project',
            parent_id: f.meta.id,
            key: `A${i}`,
            name: `Archived ${i}`,
            description: '',
            sort_order: 1000 + i,
            num: 1000 + i,
            track_delay: false,
            created_at: NOW,
            archived_at: NOW,
            window_key: newWindowKey(),
          })
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: project,
            parent_id: end.id,
            num: nextNum++,
            title: `Subtask ${i}`,
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          })
        }
      })
    const { answer, ranges } = await linksRead(t, f, task.id)
    expect(answer).toEqual({ state: 'ok', links: [], tasks: [], complete: false })
    expect(ranges).toBeLessThanOrEqual(TASK_WINDOW.ranges + 50)
  }, 300_000)

  it('answers complete for exactly the subtasks the budget holds, and incomplete for one more', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    const legacy = 'o'.repeat(900 * 1024)
    await plantMany(t, f, 3, () => ({ description: legacy, parent_id: task.id }), {
      each: 1,
      rows: false,
    })
    // room for three bodies near 900 KB whole and about half a MiB left,
    // so the room for whole bodies runs out on the third subtask
    TASK_WINDOW.bytes = 3.2 * MIB
    const three = await taskRead(t, f, task.id)
    if (three.answer.state !== 'ok') throw new Error(three.answer.state)
    expect(three.answer.subtasks).toMatchObject({ complete: true, rows: { length: 3 } })
    expect(three.answer.task.has_hidden_subtasks).toBe(false)
    await plantMany(t, f, 1, () => ({ description: legacy, parent_id: task.id }), {
      each: 1,
      rows: false,
    })
    const four = await taskRead(t, f, task.id)
    if (four.answer.state !== 'ok') throw new Error(four.answer.state)
    expect(four.answer.subtasks).toMatchObject({ complete: false, rows: { length: 3 } })
    expect(four.answer.task.has_hidden_subtasks).toBe(true)
    // the look for a fourth reads it whole, one body past the budget at most
    expect(four.read).toBeLessThanOrEqual(TASK_WINDOW.bytes / MIB + 1)
  })

  it('stops the subtask read at TASK_WINDOW.documents', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [task] = await plantMany(t, f, 1, () => ({}), { each: 1, rows: true })
    await plantMany(t, f, 100, () => ({ parent_id: task.id }), { each: 50, rows: true })
    TASK_WINDOW.documents = 60
    const { answer, documents } = await taskRead(t, f, task.id)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.subtasks.complete).toBe(false)
    expect(answer.subtasks.rows.length).toBeGreaterThan(10)
    expect(answer.subtasks.rows.length).toBeLessThan(100)
    expect(documents).toBeLessThanOrEqual(TASK_WINDOW.documents + 10)
  })
})

describe('a check of the caller access that a bound stops', () => {
  /* OWN_READS under which the check of a project shared with one of the
   * caller's teams stops at a bound (lib/access.ts accessUnchecked), and
   * one bound up, with room for that team asked by itself and its row. */
  const UNCHECKED = { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 }
  const ONE_UP = { projectShares: 0, rows: 0, lookups: 1, teamReads: 2 }

  it('answers unavailable for the task or its parent, ends a subtask or link list there as incomplete, and one bound up answers as with the default bounds', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a user grant on FW, which no team shares, and a team that shares PCB
    const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: me.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const opened = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const mine = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: opened.id,
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, parent_id: opened.id })
    const onPcb = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: onPcb.id,
    })
    await t.run((ctx) => ctx.db.insert('issue_links', linkRow(f, opened, onPcb.id)))
    const caller = as(t, me)
    const read = async () => ({
      opened: await caller.query(api.taskWindow.task, { org_id: f.org.id, ref: opened.id }),
      links: await caller.query(api.taskWindow.links, { org_id: f.org.id, issue_id: opened.id }),
      onPcb: await caller.query(api.taskWindow.task, { org_id: f.org.id, ref: onPcb.id }),
      child: await caller.query(api.taskWindow.task, { org_id: f.org.id, ref: child.id }),
    })
    const usual = await read()
    expect(usual.opened.state === 'ok' && usual.opened.subtasks.complete).toBe(true)
    expect(usual.child.state === 'ok' && usual.child.parent?.id).toBe(onPcb.id)
    Object.assign(OWN_READS, UNCHECKED)
    const stopped = await read()
    // the subtask in PCB ends the list after the one in FW, and the link to
    // the task in PCB ends the links
    expect(stopped.opened.state === 'ok' && stopped.opened.subtasks).toEqual({
      rows: [expect.objectContaining({ id: mine.id })],
      complete: false,
    })
    expect(stopped.opened.state === 'ok' && stopped.opened.task.has_hidden_subtasks).toBe(true)
    expect(stopped.links).toMatchObject({ state: 'ok', links: [], tasks: [], complete: false })
    // a task in PCB, and one whose parent is there, answer as hidden ones do
    expect(stopped.onPcb).toEqual({ state: 'unavailable' })
    expect(stopped.child).toEqual({ state: 'unavailable' })
    Object.assign(OWN_READS, ONE_UP)
    expect(await read()).toEqual(usual)
  })
})
