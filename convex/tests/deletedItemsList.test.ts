/* Deleted items: who sees and restores what, through the public functions
 * (design 6, 5.3, 9). deletedItems.item reads every seat of the login and
 * projects one item for the seat in its organization, the row the page
 * builds each entry with (model/deletedItemsList.ts rowFor), so these cases
 * read every stored item's row through it, and the page
 * (deletedItems.page) where they search or filter; restore and purge answer
 * per item behind the same fence; projects.removalSummary feeds the Archive
 * or delete window; issues.archive can keep the subtasks. Fake timers keep
 * steps from running until a test releases them, and REMOVAL_COUNT and
 * TRASH_BUDGET are lowered where a test needs many rows or an unfinished
 * item. The cases of the old list and search (deletedItems.list and
 * matches), their cap, budgets and `capped`, went with them; the page's
 * own are in deletedItemsPage.test.ts and deletedItemsPageReads.test.ts. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { OrgRole } from '../lib/enums'
import { LIMITS } from '../lib/limits'
import { TRASH_BUDGET } from '../model/deletedItems'
import type { DeletedRow } from '../model/deletedItemsList'
import { type PageArgs, pageFor } from '../model/deletedItemsPage'
import { REMOVAL_COUNT } from '../model/projects'
import {
  as,
  copyTaskTexts,
  expectRefusal,
  fileState,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import {
  attach,
  installTrashTimers,
  itemById,
  itemFor,
  liveTask,
  runSteps,
  START,
} from './trash.setup'

installTrashTimers()
const DEFAULT_REMOVAL = { ...REMOVAL_COUNT }
afterEach(() => {
  Object.assign(REMOVAL_COUNT, DEFAULT_REMOVAL)
})

const AT_START = new Date(START).toISOString()

/** A person with a login in `org_id`. */
const person = (
  t: T,
  org_id: string,
  name: string,
  org_role: OrgRole = 'user',
  extra: Partial<WithoutSystemFields<Doc<'profiles'>>> = {},
) =>
  plantSeat(t, {
    org_id,
    name,
    org_role,
    auth_user_id: `auth_${name}_${org_id}`,
    email: `${name.toLowerCase()}@testbed.test`,
    accepted_at: NOW,
    ...extra,
  })

const grant = (t: T, project_id: string, profile_id: string, level: 'user' | 'viewer') =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level })
  })
/** Changes a grant's level, or removes it without one. */
const setGrant = (t: T, project_id: string, profile_id: string, level?: 'user' | 'viewer') =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', project_id).eq('profile_id', profile_id),
      )
      .unique()
    if (row === null) throw new Error('no grant to change')
    if (level === undefined) await ctx.db.delete(row._id)
    else await ctx.db.patch(row._id, { level })
  })
const patch = (
  t: T,
  table: 'projects' | 'profiles' | 'deleted_items',
  id: string,
  fields: object,
) =>
  t.run(async (ctx) => {
    const row = await byId(ctx, table, id)
    if (row === null) throw new Error(`no ${table} row ${id}`)
    await ctx.db.patch(row._id, fields)
  })

const item = (t: T, who: Doc<'profiles'>, id: string) =>
  as(t, who).query(api.deletedItems.item, { id })
/** Every stored item's row for `who`'s login as deletedItems.item answers
 * it, newest first, without those the login does not see. */
async function rowsOf(t: T, who: Doc<'profiles'>): Promise<DeletedRow[]> {
  const stored = await t.run((ctx) => ctx.db.query('deleted_items').collect())
  const rows: DeletedRow[] = []
  for (const d of stored) {
    const row = await item(t, who, d.id)
    if (row !== null) rows.push(row)
  }
  return rows.sort((a, b) =>
    a.deleted_at === b.deleted_at ? (a.id < b.id ? 1 : -1) : a.deleted_at < b.deleted_at ? 1 : -1,
  )
}
const idsOf = async (t: T, who: Doc<'profiles'>) => (await rowsOf(t, who)).map((r) => r.id)
const rowOf = async (t: T, who: Doc<'profiles'>, id: string) =>
  (await rowsOf(t, who)).find((r) => r.id === id)
/** Every page of Deleted items for `who` over All projects of their
 * organization with `args`, paged to the end: its entries and rows. */
async function walk(t: T, who: Doc<'profiles'>, args: Omit<PageArgs, 'scope' | 'cursor'> = {}) {
  const entries = []
  const items: DeletedRow[] = []
  let cursor: string | undefined
  for (let i = 0; i < 100; i++) {
    const page = await as(t, who).query(api.deletedItems.page, {
      scope: { org_id: who.org_id, all: true },
      ...args,
      ...(cursor === undefined ? {} : { cursor }),
    })
    entries.push(...page.entries)
    items.push(...page.items)
    if (page.next_cursor === null) break
    cursor = page.next_cursor
  }
  return { entries, items }
}
/** The tasks a search of the page for `text` finds for `who`: each entry's
 * task, or its item's row where the entry names no task of its own. */
async function found(t: T, who: Doc<'profiles'>, text: string) {
  const { entries, items } = await walk(t, who, { search: text })
  return entries.map((e) => {
    const row = items.find((r) => r.id === e.item_id)
    return e.task ?? { key: row?.key, title: row?.title, path: row?.path }
  })
}
const restore = (t: T, who: Doc<'profiles'>, ids: string[]) =>
  as(t, who).mutation(api.deletedItems.restore, { org_id: who.org_id, ids })
const purge = (t: T, who: Doc<'profiles'>, ids: string[]) =>
  as(t, who).mutation(api.deletedItems.purge, { org_id: who.org_id, ids })
const deleteTask = (t: T, who: Doc<'profiles'>, id: string, extra: object = {}) =>
  as(t, who).mutation(api.issues.deleteDeep, { org_id: who.org_id, id, ...extra })
const deleteProject = (t: T, who: Doc<'profiles'>, id: string) =>
  as(t, who).mutation(api.projects.deleteDeep, { org_id: who.org_id, id })
/** Moves the clock on, so the next delete sorts after the last. */
const later = () => vi.setSystemTime(Date.now() + 60_000)

/** A top-level project `name` led by `lead`, with sub-projects `subs`, each
 * with an optional lead of its own. */
async function tree(
  t: T,
  f: OrgFixture,
  name: string,
  lead: Doc<'profiles'> | undefined,
  subs: { name: string; lead?: Doc<'profiles'> }[],
) {
  const top = await plantProject(t, { org_id: f.org.id, name, lead_id: lead?.id })
  const children: Doc<'projects'>[] = []
  for (const sub of subs)
    children.push(
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: top.id,
        name: sub.name,
        lead_id: sub.lead?.id,
      }),
    )
  return { top, subs: children }
}

/** A sub-project under the fixture's hidden project, which only its lead
 * (the user) and admins can see. */
const hiddenSub = (t: T, f: OrgFixture) =>
  plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.hidden.id })

describe('who sees an item (design 6.1)', () => {
  it('shows an admin every item, and everyone else their own deletes', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const mine = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Mine' })
    const theirs = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Theirs' })
    await deleteTask(t, f.guest, mine.id, { reason: '  wrong board  ' })
    later()
    await deleteTask(t, f.user, theirs.id)
    const mineItem = await itemFor(t, mine.id)
    const theirsItem = await itemFor(t, theirs.id)

    expect(await idsOf(t, f.admin)).toEqual([theirsItem.id, mineItem.id])
    expect(await idsOf(t, f.guest)).toEqual([mineItem.id])
    // a viewer with a grant on the project deleted nothing and leads nothing
    expect(await idsOf(t, f.viewer)).toEqual([])
    expect(await rowOf(t, f.guest, mineItem.id)).toEqual({
      id: mineItem.id,
      org_id: f.org.id,
      org_name: 'Testbed Labs',
      kind: 'task',
      key: `QN-${mine.num}`,
      title: 'Mine',
      status: 'todo',
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      projects: [
        { id: f.sub.id, name: 'Firmware', key: 'FW', type: 'project', tasks: 1, archived_tasks: 0 },
      ],
      path: ['Testbed platform', 'Firmware'],
      archived: false,
      deleted_at: mineItem.deleted_at,
      deleter: {
        you: true,
        profile_id: f.guest.id,
        name: 'guest',
        kind: 'app',
        who: `${f.guest.id}|app`,
      },
      reason: 'wrong board',
      state: 'ready',
      can_restore: true,
      can_purge: false,
    })
    expect((await rowOf(t, f.admin, mineItem.id))?.can_purge).toBe(true)
    // live names win over the names at deletion
    await patch(t, 'projects', f.sub.id, { name: 'Firmware 2' })
    expect((await rowOf(t, f.guest, mineItem.id))?.path).toEqual(['Testbed platform', 'Firmware 2'])
  })

  it('shows the deletes in a project to its lead and to the lead of its top-level project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const sam = await person(t, f.org.id, 'Sam')
    // Firmware has a lead of its own; the user still leads its top-level project
    await patch(t, 'projects', f.sub.id, { lead_id: sam.id })
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)

    for (const lead of [f.user, sam]) {
      const row = await rowOf(t, lead, item.id)
      expect(row?.deleter).toMatchObject({ you: false, name: 'guest' })
      expect(row?.can_restore).toBe(true)
    }
    // the lead of another project sees nothing of it
    const other = await person(t, f.org.id, 'Other')
    await tree(t, f, 'Elsewhere', other, [{ name: 'Over there' }])
    expect(await idsOf(t, other)).toEqual([])
    expect((await restore(t, sam, [item.id])).restored).toEqual([item.id])
    expect(await liveTask(t, task.id)).not.toBeNull()
  })

  it('shows a project item to the lead its stored rows name, who can restore it', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const lena = await person(t, f.org.id, 'Lena')
    const { top, subs } = await tree(t, f, 'Field trial', lena, [{ name: 'Site' }])
    await plantIssue(t, { org_id: f.org.id, project_id: subs[0].id })
    await deleteProject(t, f.admin, top.id)
    const item = await itemFor(t, top.id)

    // Lena leads nothing live any more
    expect(await rowOf(t, lena, item.id)).toMatchObject({
      kind: 'project',
      key: top.key,
      title: 'Field trial',
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 1 },
      path: [],
      deleter: { you: false, name: 'admin' },
      can_restore: true,
    })
    expect(await restore(t, lena, [item.id])).toEqual({
      restored: [item.id],
      stepping: [],
      refused: [],
      deferred: [],
    })
    expect(await t.run((ctx) => byId(ctx, 'projects', top.id))).not.toBeNull()
  })

  it('limits a sub-project lead to their sub-project inside a deleted top-level project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const lena = await person(t, f.org.id, 'Lena')
    const sam = await person(t, f.org.id, 'Sam')
    const tia = await person(t, f.org.id, 'Tia')
    const { top, subs } = await tree(t, f, 'Field trial', lena, [
      { name: 'Site', lead: sam },
      { name: 'Lab' },
    ])
    const [site, lab] = subs
    await grant(t, lab.id, tia.id, 'user')
    await plantIssue(t, { org_id: f.org.id, project_id: site.id, title: 'Dig the trench' })
    await plantIssue(t, { org_id: f.org.id, project_id: site.id, title: 'Fence the site' })
    for (const title of ['Calibrate the probe', 'Seal the samples', 'Label the samples'])
      await plantIssue(t, { org_id: f.org.id, project_id: lab.id, title, archived_at: NOW })
    await deleteProject(t, lena, top.id)
    const item = await itemFor(t, top.id)

    expect((await rowOf(t, lena, item.id))?.counts).toEqual({
      tasks: 5,
      archived_tasks: 3,
      subtasks: 0,
      sub_projects: 2,
    })
    const row = await rowOf(t, sam, item.id)
    expect(row?.projects.map((p) => p.name)).toEqual(['Field trial', 'Site'])
    expect(row?.counts).toEqual({ tasks: 2, archived_tasks: 0, subtasks: 0, sub_projects: 1 })
    expect(row?.can_restore).toBe(false)
    expect(row?.blocked).toEqual({ reason: 'not_lead', project: 'Field trial', lead: 'Lena' })
    // the sibling's tasks stay out of Sam's search, his own do not
    expect(await found(t, sam, 'samples')).toEqual([])
    expect((await found(t, sam, 'trench')).map((m) => [m.title, m.path])).toEqual([
      ['Dig the trench', ['Field trial', 'Site']],
    ])
    expect((await found(t, lena, 'samples')).map((m) => m.title).sort()).toEqual([
      'Label the samples',
      'Seal the samples',
    ])
    // a member of the sibling neither deleted nor led anything
    expect(await idsOf(t, tia)).toEqual([])
    expect((await restore(t, sam, [item.id])).refused).toEqual([
      { id: item.id, reason: 'not_lead' },
    ])
  })

  it('keeps a delete visible without Restore once its deleter can only view the project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    await setGrant(t, f.meta.id, f.guest.id, 'viewer')

    // Firmware has no lead of its own, so its top-level project's lead leads it
    expect(await rowOf(t, f.guest, item.id)).toMatchObject({
      can_restore: false,
      blocked: { reason: 'view_only', project: 'Firmware', lead: 'user' },
    })
    expect((await restore(t, f.guest, [item.id])).refused).toEqual([
      { id: item.id, reason: 'view_only' },
    ])
    // with no lead the row names none, for "Ask an organization admin"
    await patch(t, 'projects', f.meta.id, { lead_id: undefined })
    expect((await rowOf(t, f.guest, item.id))?.blocked).toEqual({
      reason: 'view_only',
      project: 'Firmware',
    })
  })

  it('hides a delete from its deleter once they lost all access to its project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    await setGrant(t, f.meta.id, f.guest.id)

    expect(await idsOf(t, f.guest)).toEqual([])
    expect((await restore(t, f.guest, [item.id])).refused).toEqual([
      { id: item.id, reason: 'not_found' },
    ])
    expect(await idsOf(t, f.user)).toEqual([item.id])
  })

  it('redacts a task item for the lead of a subtask project who cannot see the root', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const omar = await person(t, f.org.id, 'Omar')
    const dana = await person(t, f.org.id, 'Dana')
    const ops = await tree(t, f, 'Operations', omar, [{ name: 'Infra' }])
    const infra = ops.subs[0]
    await grant(t, f.meta.id, dana.id, 'user')
    await grant(t, ops.top.id, dana.id, 'user')
    const root = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Contoso acquisition due diligence',
    })
    const sub = await plantIssue(t, {
      org_id: f.org.id,
      project_id: infra.id,
      title: 'Provision the data room',
      parent_id: root.id,
    })
    await deleteTask(t, dana, root.id, { subtask_ids: [sub.id], reason: 'confidential' })
    const item = await itemFor(t, root.id)

    const row = await rowOf(t, omar, item.id)
    expect(row).toMatchObject({
      key: `QN-${sub.num}`,
      title: 'Provision the data room',
      path: [],
      redacted: true,
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      can_restore: false,
      blocked: { reason: 'no_access' },
      deleter: { name: 'Dana' },
    })
    expect(row?.projects.map((p) => p.id)).toEqual([infra.id])
    expect(row).not.toHaveProperty('reason')
    expect(JSON.stringify(row)).not.toContain('Contoso')
    expect((await restore(t, omar, [item.id])).refused).toEqual([
      { id: item.id, reason: 'no_access' },
    ])
    // the root's lead sees the root, not the subtask in a project hidden from them
    expect(await rowOf(t, f.user, item.id)).toMatchObject({
      title: 'Contoso acquisition due diligence',
      reason: 'confidential',
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      blocked: { reason: 'subtask_project' },
    })
    expect((await rowOf(t, dana, item.id))?.counts).toMatchObject({ tasks: 2, subtasks: 1 })
  })

  it('shows items whose project is in Deleted items, and stuck items, to admins only', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const omar = await person(t, f.org.id, 'Omar')
    const ops = await tree(t, f, 'Operations', omar, [{ name: 'Infra' }])
    await grant(t, ops.top.id, f.guest.id, 'user')
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const sub = await plantIssue(t, {
      org_id: f.org.id,
      project_id: ops.subs[0].id,
      parent_id: task.id,
    })
    await deleteTask(t, f.guest, task.id, { subtask_ids: [sub.id] })
    const taskItem = await itemFor(t, task.id)
    expect(await idsOf(t, omar)).toEqual([taskItem.id])
    later()
    await deleteProject(t, f.user, f.meta.id)
    const projectItem = await itemFor(t, f.meta.id)

    // Restore opens the project item first, and the task follows it, as
    // the admin's User grant on TBED comes back with TBED
    expect((await rowOf(t, f.admin, taskItem.id))?.blocked).toEqual({
      reason: 'project_deleted',
      item_id: projectItem.id,
      with_project: true,
    })
    // not even to the lead of the subtask's project, which is still live
    expect(await idsOf(t, f.guest)).toEqual([])
    expect(await idsOf(t, omar)).toEqual([])
    // the user led the project, so they see the project item and not the task item
    expect(await idsOf(t, f.user)).toEqual([projectItem.id])
    await patch(t, 'deleted_items', projectItem.id, { state: 'stuck' })
    expect(await idsOf(t, f.user)).toEqual([])
    expect(await rowOf(t, f.admin, projectItem.id)).toMatchObject({
      state: 'stuck',
      can_restore: false,
      can_purge: true,
    })
  })

  it('lists a guest-only login its own deletes in the organization it is a guest of', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const pilot = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
      name: 'Pilot',
    })
    const gus = await person(t, f.otherOrg.id, 'Gus', 'guest')
    await grant(t, pilot.id, gus.id, 'user')
    const own = await plantIssue(t, { org_id: f.otherOrg.id, project_id: pilot.id })
    const others = await plantIssue(t, { org_id: f.otherOrg.id, project_id: pilot.id })
    await deleteTask(t, gus, own.id)
    await deleteTask(t, f.otherAdmin, others.id)
    const item = await itemFor(t, own.id)

    expect(await rowsOf(t, gus)).toEqual([
      expect.objectContaining({ id: item.id, org_id: f.otherOrg.id, org_name: 'Other' }),
    ])
  })

  it('judges each organization by the seat there, not the home seat', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // the admin of Testbed is a guest in Other
    const pilot = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const away = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'admin',
      org_role: 'guest',
      auth_user_id: f.admin.auth_user_id,
    })
    await grant(t, pilot.id, away.id, 'user')
    const home = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const own = await plantIssue(t, { org_id: f.otherOrg.id, project_id: pilot.id })
    const others = await plantIssue(t, { org_id: f.otherOrg.id, project_id: pilot.id })
    await deleteTask(t, f.user, home.id)
    later()
    await deleteTask(t, away, own.id)
    later()
    await deleteTask(t, f.otherAdmin, others.id)

    const rows = await rowsOf(t, f.admin)
    expect(rows.map((r) => r.id)).toEqual([
      (await itemFor(t, own.id)).id,
      (await itemFor(t, home.id)).id,
    ])
    expect(rows.map((r) => [r.org_name, r.deleter.you, r.can_purge])).toEqual([
      ['Other', true, false],
      ['Testbed Labs', false, true],
    ])
    expect(await idsOf(t, f.otherAdmin)).toHaveLength(2)
  })

  it('shows a moving item with its state and no Restore', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    for (let i = 0; i < 4; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    Object.assign(TRASH_BUDGET, { rows: 2 })
    await deleteProject(t, f.user, f.sub.id)
    const item = await itemFor(t, f.sub.id)

    const row = await rowOf(t, f.user, item.id)
    expect(row).toMatchObject({ state: 'moving', can_restore: false })
    expect(row?.blocked).toBeUndefined()
    expect((await restore(t, f.user, [item.id])).refused).toEqual([
      { id: item.id, reason: 'moving' },
    ])
  })
})

describe('who deleted it (design 1.6)', () => {
  it('names personal tokens and apps to admins and their owner only, agent keys to all', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const items: Doc<'deleted_items'>[] = []
    for (let i = 0; i < 4; i++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await deleteTask(t, f.guest, task.id)
      items.push(await itemFor(t, task.id))
    }
    // as the REST and MCP deletes record them
    const vias = [
      { table: 'mcp_tokens', id: uuid(), name: 'Cursor' },
      { table: 'mcp_tokens', id: uuid(), name: 'Laptop script' },
      { table: 'oauth_connections', id: uuid(), name: 'Claude' },
      { table: 'agent_keys', id: uuid(), name: 'Support inbox sync' },
    ] as const
    for (const [i, via] of vias.entries()) await patch(t, 'deleted_items', items[i].id, { via })
    const deleters = async (who: Doc<'profiles'>) => {
      const rows = await rowsOf(t, who)
      return items.map((item) => rows.find((r) => r.id === item.id)?.deleter)
    }
    const g = f.guest.id

    // the lead folds the two personal tokens into one `who`
    expect((await deleters(f.user)).map((d) => [d?.kind, d?.credential_name, d?.who])).toEqual([
      ['mcp_tokens', undefined, `${g}|mcp_tokens`],
      ['mcp_tokens', undefined, `${g}|mcp_tokens`],
      ['oauth_connections', undefined, `${g}|oauth_connections`],
      ['agent_keys', 'Support inbox sync', `${g}|agent_keys:${vias[3].id}`],
    ])
    for (const who of [f.admin, f.guest])
      expect((await deleters(who)).map((d) => [d?.credential_name, d?.who])).toEqual(
        vias.map((via) => [via.name, `${g}|${via.table}:${via.id}`]),
      )
    expect(JSON.stringify(await rowsOf(t, f.user))).not.toMatch(/Cursor|Laptop|Claude|mcp_tokens:/)
  })

  it('names a deleter only while their profile is the one that deleted', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    // the seat is removed, and a later seat reuses its uuid
    const reused = '2026-06-01T00:00:00.000Z'
    await patch(t, 'profiles', f.guest.id, { created_at: reused, name: 'Newcomer' })

    // a "Someone" row, whose key names nobody
    expect((await rowOf(t, f.user, item.id))?.deleter).toEqual({
      you: false,
      kind: 'app',
      who: '|app',
    })
    // and the new seat does not see the delete as its own
    expect(await idsOf(t, f.guest)).toEqual([])

    // the new seat's own delete groups apart, and a filter by it finds only that
    vi.setSystemTime(Date.parse(reused) + 60_000)
    const seat = (await t.run((ctx) => byId(ctx, 'profiles', f.guest.id))) as Doc<'profiles'>
    const theirs = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, seat, theirs.id)
    const fresh = await itemFor(t, theirs.id)
    expect((await rowOf(t, f.user, fresh.id))?.deleter).toMatchObject({
      name: 'Newcomer',
      who: `${f.guest.id}|app`,
    })
    for (const who of [f.admin, f.user])
      expect((await walk(t, who, { deleted_by: f.guest.id })).entries).toEqual([
        { item_id: fresh.id },
      ])
  })
})

describe('one item (deletedItems.item)', () => {
  it('refuses a caller without a login', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await expectRefusal(
      t.query(api.deletedItems.item, { id: uuid() }),
      'forbidden',
      /^not signed in$/,
    )
    await expectRefusal(
      t.query(api.deletedItems.page, { scope: { org_id: f.org.id, all: true } }),
      'forbidden',
    )
  })

  it("answers one item as the page's row, for a blocked row whose project item no page holds", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await deleteTask(t, f.guest, task.id)
    await deleteTask(t, f.otherAdmin, foreign.id)
    later()
    await deleteProject(t, f.user, f.meta.id)
    const taskItem = await itemFor(t, task.id)
    const projectItem = await itemFor(t, f.meta.id)
    expect((await item(t, f.admin, taskItem.id))?.blocked?.item_id).toBe(projectItem.id)

    const paged = (await walk(t, f.admin)).items
    expect(await item(t, f.admin, projectItem.id)).toEqual(
      paged.find((r) => r.id === projectItem.id),
    )
    expect(await item(t, f.admin, taskItem.id)).toEqual(paged.find((r) => r.id === taskItem.id))
    expect(await item(t, f.admin, projectItem.id)).toMatchObject({ can_restore: true })
    // hidden, foreign and unknown ids answer alike
    expect(await item(t, f.guest, taskItem.id)).toBeNull()
    expect(await item(t, f.guest, projectItem.id)).toBeNull()
    expect(await item(t, f.admin, (await itemFor(t, foreign.id)).id)).toBeNull()
    expect(await item(t, f.admin, uuid())).toBeNull()
  })
})

describe('restore and purge calls', () => {
  it('restores per item and answers not_found for unknown, foreign and hidden ids alike', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const mine = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: (await hiddenSub(t, f)).id })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await deleteTask(t, f.guest, mine.id)
    await deleteTask(t, f.user, hidden.id)
    await deleteTask(t, f.otherAdmin, foreign.id)
    const a = (await itemFor(t, mine.id)).id
    const b = (await itemFor(t, hidden.id)).id
    const c = (await itemFor(t, foreign.id)).id
    const unknown = uuid()

    expect(await restore(t, f.guest, [a, b, c, unknown, a])).toEqual({
      restored: [a],
      stepping: [],
      refused: [
        { id: b, reason: 'not_found' },
        { id: c, reason: 'not_found' },
        { id: unknown, reason: 'not_found' },
      ],
      deferred: [],
    })
    expect(await liveTask(t, mine.id)).not.toBeNull()
    const e = await expectRefusal(
      restore(t, f.guest, Array.from({ length: LIMITS.restoreBatch.max + 1 }, uuid)),
      'rule',
    )
    expect(e.data.message).toBe(LIMITS.restoreBatch.refusal)
  })

  it('lets an organization admin delete ready and stuck items for good', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const ready = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const stuck = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const attachment = await attach(t, ready)
    for (const task of [ready, stuck]) await deleteTask(t, f.user, task.id)
    for (let i = 0; i < 4; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 2 })
    await deleteProject(t, f.user, f.sub2.id)
    const readyItem = await itemFor(t, ready.id)
    const stuckItem = await itemFor(t, stuck.id)
    const moving = await itemFor(t, f.sub2.id)
    await patch(t, 'deleted_items', stuckItem.id, { state: 'stuck' })
    const unknown = uuid()

    await expectRefusal(purge(t, f.user, [readyItem.id]), 'forbidden', /^admin only$/)
    expect(await purge(t, f.admin, [readyItem.id, stuckItem.id, moving.id, unknown])).toEqual({
      purged: [readyItem.id, stuckItem.id],
      refused: [
        { id: unknown, reason: 'not_found' },
        { id: moving.id, reason: 'moving' },
      ],
    })
    // the rows leave the list at once; the bytes go with their item
    expect(await idsOf(t, f.admin)).toEqual([moving.id])
    await runSteps(t)
    expect(await itemById(t, readyItem.id)).toBeNull()
    expect(await itemById(t, stuckItem.id)).toBeNull()
    expect(await fileState(t, attachment.storage_id)).toBe('held')
    const gone = await expectRefusal(
      purge(t, f.admin, Array.from({ length: LIMITS.purgeBatch.max + 1 }, uuid)),
      'rule',
    )
    expect(gone.data.message).toBe(LIMITS.purgeBatch.refusal)
  })

  it('offers Delete now only while billing lets an admin write', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const ready = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const stuck = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const task of [ready, stuck]) await deleteTask(t, f.user, task.id)
    const ids = [(await itemFor(t, ready.id)).id, (await itemFor(t, stuck.id)).id]
    await patch(t, 'deleted_items', ids[1], { state: 'stuck' })
    const purgeable = async () =>
      Promise.all(ids.map(async (id) => (await rowOf(t, f.admin, id))?.can_purge))
    expect(await purgeable()).toEqual([true, true])

    // billing on and no subscription: the organization is read-only, and
    // Delete now, an adminMutation, is refused
    vi.stubEnv('BILLING_ENABLED', 'true')
    expect(await purgeable()).toEqual([false, false])
    expect((await rowOf(t, f.admin, ids[0]))?.blocked).toEqual({ reason: 'read_only' })
    await expectRefusal(purge(t, f.admin, ids), 'forbidden', /read-only/)
  })
})

describe('projects.removalSummary', () => {
  it('counts the tree for its lead, archived work included, and says when it stopped', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await patch(t, 'projects', f.sub2.id, { archived_at: NOW })
    for (let i = 0; i < 2; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: NOW })
    const summary = (who: Doc<'profiles'>, id = f.meta.id) =>
      as(t, who).query(api.projects.removalSummary, { org_id: f.org.id, id })
    const named = (p: Doc<'projects'>) => ({ id: p.id, name: p.name, key: p.key })

    expect(await summary(f.user)).toEqual({
      tasks: 4,
      archived_tasks: 2,
      more: false,
      sub_projects: [
        { ...named(f.sub), archived: false, tasks: 3, archived_tasks: 1, more: false },
        { ...named(f.sub2), archived: true, tasks: 1, archived_tasks: 1, more: false },
      ],
    })
    // the third task is read past the cap but not counted, so it says more than 2
    REMOVAL_COUNT.cap = 2
    expect(await summary(f.user)).toMatchObject({
      tasks: 2,
      more: true,
      sub_projects: [
        { tasks: 2, more: true },
        { tasks: 0, more: true },
      ],
    })
    // members who reach it, for navigation to a sub-project or with a grant,
    // are refused as deleteDeep refuses them
    const nav = await person(t, f.org.id, 'Nav')
    await grant(t, f.sub.id, nav.id, 'user')
    for (const who of [nav, f.guest, f.viewer])
      await expectRefusal(summary(who), 'rule', /^requires the project lead$/)
    await expectRefusal(summary(f.user, uuid()), 'not_found', /^project not found$/)
  })

  it('stops counting before long task descriptions pass the read limit', async () => {
    // REMOVAL_COUNT.bytes and Convex's 16 MiB read limit lowered alike to
    // a 32nd: 256 KiB and 512 KiB
    const t = newT({ transactionLimits: { bytesRead: 512 * 1024 } })
    REMOVAL_COUNT.bytes = DEFAULT_REMOVAL.bytes / 32
    const f = await withReadingAdmin(t)
    // 30 tasks at the 20,000-character description cap pass 512 KiB,
    // their text in the task rows too, as a rollback to the second release
    // writes it
    const description = 'Measured on site. '.repeat(1112).slice(0, 20_000)
    for (let i = 0; i < 30; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })
    await copyTaskTexts(t, f.org.id)

    const summary = await as(t, f.user).query(api.projects.removalSummary, {
      org_id: f.org.id,
      id: f.meta.id,
    })
    expect(summary.more).toBe(true)
    expect(summary.tasks).toBeGreaterThan(0)
    expect(summary.tasks).toBeLessThan(30)
    expect(summary.sub_projects).toMatchObject([
      { id: f.sub.id, tasks: summary.tasks, more: true },
      { id: f.sub2.id, tasks: 0, more: true },
    ])
  })
})

describe('archiving a task and keeping its subtasks (design 9)', () => {
  it('detaches the open subtasks as a delete does and archives the task alone', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Parent' })
    const open = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    // in a project the archiver cannot see: a delete detaches such a child too
    const hidden = await plantIssue(t, {
      org_id,
      project_id: (await hiddenSub(t, f)).id,
      parent_id: parent.id,
    })
    const done = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      parent_id: parent.id,
      archived_at: NOW,
    })
    for (const kid of [open, hidden])
      await plantSubscription(t, { issue_id: kid.id, profile_id: f.admin.id })

    await as(t, f.guest).mutation(api.issues.archive, {
      org_id,
      id: parent.id,
      reason: 'Out of scope',
      keep_subtasks: true,
    })

    expect((await liveTask(t, parent.id))?.archived_at).toBe(AT_START)
    for (const kid of [open, hidden]) {
      expect(await liveTask(t, kid.id)).toMatchObject({ updated_at: AT_START })
      expect(await liveTask(t, kid.id)).not.toHaveProperty('parent_id')
      expect(await liveTask(t, kid.id)).not.toHaveProperty('archived_at')
      expect((await messagesFor(t, f.admin.id, kid.id)).map((m) => m.detail)).toEqual([
        'Detached from its parent',
      ])
    }
    expect(await liveTask(t, done.id)).toMatchObject({ parent_id: parent.id, archived_at: NOW })
  })

  it('archives the open subtasks with it otherwise, in the app and over REST', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await grant(t, f.meta.id, f.agent.id, 'user')
    const app = await plantIssue(t, { org_id, project_id: f.sub.id })
    const appKid = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: app.id })
    const rest = await plantIssue(t, { org_id, project_id: f.sub.id })
    const restKid = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: rest.id })

    await as(t, f.user).mutation(api.issues.archive, { org_id, id: app.id })
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'drive',
      ref: `QN-${rest.num}`,
      body: JSON.stringify({ archived: true }),
    })

    expect(await liveTask(t, appKid.id)).toMatchObject({ parent_id: app.id, archived_at: AT_START })
    expect(await liveTask(t, restKid.id)).toMatchObject({ parent_id: rest.id })
    expect((await liveTask(t, restKid.id))?.archived_at).toBeDefined()
  })
})

describe('a project item while it moves', () => {
  it("reads the viewer's grants and team shares once for a whole page", async () => {
    // the lead is in 3 teams that each share the same 50 other projects,
    // 150 shares the page's sight reads, and their own project is moving
    const t = newT()
    const f = await withReadingAdmin(t)
    await t.run(async (ctx) => {
      const projects: string[] = []
      for (let i = 0; i < 50; i++) {
        const id = crypto.randomUUID()
        projects.push(id)
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'meta',
          key: `SH${i}`,
          name: `Shared ${i}`,
          description: '',
          sort_order: 100 + i,
          num: 500 + i,
          track_delay: false,
          created_at: NOW,
        })
      }
      for (let i = 0; i < 3; i++) {
        const team_id = crypto.randomUUID()
        await ctx.db.insert('teams', {
          id: team_id,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', { team_id, profile_id: f.user.id, is_leader: false })
        for (const project_id of projects)
          await ctx.db.insert('project_team_access', { project_id, team_id, level: 'user' })
      }
    })
    TRASH_BUDGET.rows = 1
    await deleteProject(t, f.user, f.meta.id)
    expect((await itemFor(t, f.meta.id)).state).toBe('moving')
    expect(await idsOf(t, f.user)).toContain((await itemFor(t, f.meta.id)).id)
    // about 80 documents besides the shares, and 150 more for a second read
    const metrics = await as(t, f.user).query(async (ctx) => {
      await pageFor(ctx, new Map([[f.org.id, f.user]]), { scope: { org_id: f.org.id, all: true } })
      return await ctx.meta.getTransactionMetrics()
    })
    expect(metrics.documentsRead.used).toBeLessThan(300)
  })
})
