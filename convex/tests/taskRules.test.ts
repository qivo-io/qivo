/* The task rules the app, REST and MCP share. They are the write gate inside
 * every task core (model/issues.ts assertCanEdit), the shared comment and
 * delete writes, and the working-set rules that decide what a read may say
 * about other tasks (lib/workingSet.ts). The gate tests call the cores directly
 * with an actor the surfaces would have refused, because every surface
 * checks first; they fail if a core loses its gate. */

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { childIndexOf } from '../lib/core'
import { orgProjectView } from '../lib/visibility'
import {
  aboutShownTasks,
  groupRemainingHours,
  linkShown,
  parentLink,
  workingSetOf,
} from '../lib/workingSet'
import { postComment } from '../model/comments'
import { moveTasksToTrash } from '../model/deletedItems'
import {
  archiveIssueCore,
  createIssueCore,
  moveIssueCore,
  NO_WRITE_ACCESS,
  unarchiveIssueCore,
  updateIssueCore,
} from '../model/issues'
import {
  activityFor,
  allMessages,
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

const GATE = /^no write access to this project$/

/* Every task, comment, activity row and Deleted item, to prove a refusal
 * wrote nothing. */
const everything = (t: T) =>
  t.run(async (ctx) => ({
    issues: await ctx.db.query('issues').collect(),
    comments: await ctx.db.query('comments').collect(),
    activity: await ctx.db.query('activity_events').collect(),
    messages: await ctx.db.query('messages').collect(),
    deleted: await ctx.db.query('deleted_items').collect(),
  }))

/* A sub-project under the SKNK meta, which the fixture's guest cannot see. */
const hiddenSub = (t: T, f: OrgFixture) =>
  plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.hidden.id, key: 'SKS' })

describe('the write gate inside the task cores', () => {
  it('names no caller kind', () => {
    expect(NO_WRITE_ACCESS).toBe('no write access to this project')
  })

  /* The fixture's viewer holds a User grant on TBED that the Viewer role caps
   * at View, so it sees FW but may not change anything there. */
  const writes: [
    string,
    (ctx: MutationCtx, f: OrgFixture, task: Doc<'issues'>) => Promise<unknown>,
  ][] = [
    [
      'create',
      (ctx, f) =>
        createIssueCore(ctx, {
          me: f.viewer,
          args: { id: uuid(), project_id: f.sub.id, title: 'Must not land' },
          now: NOW,
        }),
    ],
    [
      'update',
      (ctx, f, task) =>
        updateIssueCore(ctx, { me: f.viewer, issue: task, patch: { title: 'No' }, now: NOW }),
    ],
    [
      'move',
      (ctx, f, task) =>
        moveIssueCore(ctx, { me: f.viewer, issue: task, project_id: f.sub2.id, now: NOW }),
    ],
    ['archive', (ctx, f, task) => archiveIssueCore(ctx, { me: f.viewer, issue: task, now: NOW })],
    ['restore', (ctx, f, task) => unarchiveIssueCore(ctx, { me: f.viewer, issue: task, now: NOW })],
    [
      'delete',
      (ctx, f, task) =>
        moveTasksToTrash(ctx, { actor: f.viewer, root: task, subtasks: [], now: NOW }),
    ],
    [
      'comment',
      (ctx, f, task) => postComment(ctx, { issue: task, author: f.viewer, body: 'No', now: NOW }),
    ],
  ]

  it.each(writes)('%s refuses an actor without Edit and writes nothing', async (name, write) => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: name === 'restore' ? NOW : undefined,
    })
    const before = await everything(t)
    await expectRefusal(
      t.run((ctx) => write(ctx, f, task)),
      'forbidden',
      GATE,
    )
    expect(await everything(t)).toEqual(before)
  })

  it('a move needs Edit on both ends, checked before the destination is described', async () => {
    const t = newT()
    const f = await withOrg(t)
    const away = await hiddenSub(t, f)
    const here = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const there = await plantIssue(t, { org_id: f.org.id, project_id: away.id })
    const move = (issue: Doc<'issues'>, project_id: string) =>
      t.run((ctx) => moveIssueCore(ctx, { me: f.guest, issue, project_id, now: NOW }))
    // the guest edits FW and PCB but cannot see SKNK
    await expectRefusal(move(here, away.id), 'forbidden', GATE)
    await expectRefusal(move(there, f.sub2.id), 'forbidden', GATE)
    // a destination that does not exist reads the same, never 'not found'
    await expectRefusal(move(here, uuid()), 'forbidden', GATE)
    const moved = await move(here, f.sub2.id)
    expect(moved.project_id).toBe(f.sub2.id)
  })

  it('lets an actor with Edit create, change, archive, restore, comment and delete', async () => {
    const t = newT()
    const f = await withOrg(t)
    const created = await t.run((ctx) =>
      createIssueCore(ctx, {
        me: f.guest,
        args: { id: uuid(), project_id: f.sub.id, title: 'Guest work' },
        now: NOW,
      }),
    )
    await t.run(async (ctx) => {
      const renamed = await updateIssueCore(ctx, {
        me: f.guest,
        issue: created,
        patch: { title: 'Renamed' },
        now: NOW,
      })
      const archived = await archiveIssueCore(ctx, { me: f.guest, issue: renamed, now: NOW })
      const restored = await unarchiveIssueCore(ctx, { me: f.guest, issue: archived, now: NOW })
      expect(restored.archived_at).toBeUndefined()
      const comment = await postComment(ctx, {
        issue: restored,
        author: f.guest,
        body: 'Done here',
        now: NOW,
      })
      expect(comment).toMatchObject({ issue_id: created.id, author: f.guest.id, body: 'Done here' })
    })
    await t.run(async (ctx) => {
      const issue = (await ctx.db.get(created._id)) as Doc<'issues'>
      await moveTasksToTrash(ctx, {
        actor: f.guest,
        root: issue,
        subtasks: [],
        now: NOW,
        provenance: 'via MCP',
      })
    })
    const rows = await everything(t)
    expect(rows.issues).toEqual([])
    expect(rows.comments).toEqual([])
    expect(rows.deleted).toMatchObject([{ target_id: created.id, state: 'ready' }])
    expect((await activityFor(t, f.org.id)).map((e) => [e.verb, e.detail])).toEqual([
      ['created', undefined],
      ['renamed', 'from “Guest work”'],
      ['archived', undefined],
      ['restored', 'from the archive'],
      ['deleted', 'via MCP'],
    ])
  })
})

describe('postComment', () => {
  it('keeps the app id, makes one for machine callers and notifies like the app', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const id = uuid()
    const [mine, made] = await t.run(async (ctx) => [
      await postComment(ctx, {
        id,
        issue: task,
        author: f.guest,
        body: `Hi @[admin](user:${f.admin.id})`,
        now: NOW,
      }),
      await postComment(ctx, { issue: task, author: f.guest, body: 'Second', now: NOW }),
    ])
    expect(mine.id).toBe(id)
    expect(made.id).not.toBe(id)
    // the mention reaches the admin; a comment writes no activity row
    expect((await allMessages(t)).map((m) => [m.recipient_id, m.kind])).toContainEqual([
      f.admin.id,
      'mention',
    ])
    expect(await activityFor(t, f.org.id)).toEqual([])
    await expectRefusal(
      t.run((ctx) => postComment(ctx, { id, issue: task, author: f.guest, body: 'x', now: NOW })),
      'bad_request',
      /^a comment with this id already exists$/,
    )
    await expectRefusal(
      t.run((ctx) => postComment(ctx, { issue: task, author: f.guest, body: '  ', now: NOW })),
      'bad_request',
      /^a comment cannot be empty$/,
    )
  })
})

describe('the working-set rules', () => {
  /* FW (visible) holds a parent with a visible child and a child in a
   * SKNK sub-project the guest cannot see; ARCH is an archived sub-project
   * of TBED, visible but outside the working set. */
  async function tree(t: T, f: OrgFixture) {
    const away = await hiddenSub(t, f)
    const arch = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      key: 'ARCH',
      archived_at: NOW,
    })
    const task = (extra: Partial<Doc<'issues'>> & { project_id: string }) =>
      plantIssue(t, { org_id: f.org.id, ...extra })
    const parent = await task({ project_id: f.sub.id, title: 'Parent' })
    const shownKid = await task({ project_id: f.sub.id, parent_id: parent.id, remaining_hours: 2 })
    const hiddenKid = await task({ project_id: away.id, parent_id: parent.id, remaining_hours: 5 })
    const archivedHome = await task({ project_id: arch.id, parent_id: parent.id })
    const underHidden = await task({ project_id: f.sub.id, parent_id: hiddenKid.id })
    const loner = await task({ project_id: f.sub2.id })
    // its only active subtask is in the archived sub-project
    const shelvedOnly = await task({ project_id: f.sub2.id, title: 'Shelved only' })
    await task({ project_id: arch.id, parent_id: shelvedOnly.id })
    return { parent, shownKid, hiddenKid, archivedHome, underHidden, loner, shelvedOnly }
  }

  it('the working set holds the active tasks of visible, active projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const r = await tree(t, f)
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    const ws = await t.run(async (ctx) => {
      const active = (await ctx.db.query('issues').collect()).filter(
        (i) => i.archived_at === undefined,
      )
      return workingSetOf(active, await orgProjectView(ctx, f.guest)).tasks.map((i) => i.id)
    })
    expect(ws.sort()).toEqual(
      [r.parent.id, r.shownKid.id, r.underHidden.id, r.loner.id, r.shelvedOnly.id].sort(),
    )
    expect(ws).not.toContain(r.hiddenKid.id) // a project the guest cannot see
    expect(ws).not.toContain(r.archivedHome.id) // an archived project
    expect(ws).not.toContain(archived.id) // an archived task
  })

  it('flags hidden subtasks and parents, and sends neither id', async () => {
    const t = newT()
    const f = await withOrg(t)
    const r = await tree(t, f)
    const { rows, links } = await t.run(async (ctx) => {
      const active = await ctx.db.query('issues').collect()
      const ws = workingSetOf(active, await orgProjectView(ctx, f.guest))
      return {
        rows: ws.tasks.map((i) => ({
          id: i.id,
          flags: { ...parentLink(i, ws.shown), hidden_subtasks: ws.hasHiddenSubtasks(i.id) },
        })),
        links: [
          linkShown({ source_id: r.parent.id, target_id: r.loner.id }, ws.shown),
          linkShown({ source_id: r.parent.id, target_id: r.hiddenKid.id }, ws.shown),
          linkShown({ source_id: r.archivedHome.id, target_id: r.loner.id }, ws.shown),
        ],
      }
    })
    const flags = new Map(rows.map((row) => [row.id, row.flags]))
    // the parent has subtasks in a hidden and in an archived project; only
    // the hidden one makes it a group
    expect(flags.get(r.parent.id)).toEqual({ has_hidden_parent: false, hidden_subtasks: true })
    // a subtask in an archived project alone hides nothing, so it is no group
    expect(flags.get(r.shelvedOnly.id)).toEqual({
      has_hidden_parent: false,
      hidden_subtasks: false,
    })
    expect(flags.get(r.shownKid.id)).toEqual({
      parent_id: r.parent.id,
      has_hidden_parent: false,
      hidden_subtasks: false,
    })
    // the subtask under the hidden one learns only that a parent exists
    expect(flags.get(r.underHidden.id)).toEqual({ has_hidden_parent: true, hidden_subtasks: false })
    expect(flags.get(r.loner.id)).toEqual({ has_hidden_parent: false, hidden_subtasks: false })
    expect(links).toEqual([true, false, false])
    expect(parentLink({ parent_id: undefined }, () => true)).toEqual({ has_hidden_parent: false })
  })

  it('keeps only rows about shown tasks', () => {
    const rows = [{ issue_id: 'a' }, { issue_id: 'b' }, { issue_id: 'a' }]
    expect(aboutShownTasks(rows, (id) => id === 'a')).toEqual([
      { issue_id: 'a' },
      { issue_id: 'a' },
    ])
    expect(aboutShownTasks(rows, () => false)).toEqual([])
  })

  it('a group total counts only the shown, unfinished leaves under it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = (extra: Partial<Doc<'issues'>>) =>
      plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...extra })
    const group = await task({ title: 'Group' })
    const nested = await task({ parent_id: group.id, remaining_hours: 40 })
    await task({ parent_id: nested.id, remaining_hours: 1.25 })
    await task({ parent_id: nested.id, remaining_hours: 3, status: 'done' })
    await task({ parent_id: group.id, remaining_hours: 2.1 })
    await task({ parent_id: group.id }) // no hours
    const hidden = await task({ parent_id: group.id, remaining_hours: 100 })
    await task({ parent_id: hidden.id, remaining_hours: 7 })
    await task({ parent_id: group.id, remaining_hours: 9, archived_at: NOW })
    const rows = await t.run((ctx) => ctx.db.query('issues').collect())
    const index = childIndexOf(rows)
    const childrenOf = (id: string) => index.get(id) ?? []
    const active = new Set(rows.filter((i) => i.archived_at === undefined).map((i) => i.id))
    const shown = (id: string) => active.has(id) && id !== hidden.id
    // 1.25 + 2.1: the nested group's own 40 h, the done leaf, the hidden
    // subtask with everything under it and the archived one never count
    const live = () => true
    expect(groupRemainingHours(group, childrenOf, shown, live)).toBe(3.4)
    expect(groupRemainingHours(group, childrenOf, () => false, live)).toBeNull()
    // with every active task shown, the hidden subtask is a group of one 7 h leaf
    expect(groupRemainingHours(group, childrenOf, (id) => active.has(id), live)).toBe(10.4)
  })
})
