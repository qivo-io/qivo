/* Deleted items: who sees and restores what, through the public functions
 * (design 6, 5.3, 9). deletedItems.list and matches read every seat of the
 * login and project each item for that seat; restore and purge answer per
 * item behind the same fence; projects.removalSummary feeds the Archive or
 * delete window; issues.archive can keep the subtasks. Fake timers keep
 * steps from running until a test releases them, and LIST.cap,
 * REMOVAL_COUNT.cap and TRASH_BUDGET are lowered where a test needs many
 * rows or an unfinished item. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { OrgRole } from '../lib/enums'
import { TRASH_BUDGET } from '../model/deletedItems'
import { LIST } from '../model/deletedItemsList'
import { REMOVAL_COUNT } from '../model/projects'
import {
  as,
  expectRefusal,
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
  withOrg,
} from './helpers.setup'
import {
  attach,
  blobExists,
  installTrashTimers,
  itemById,
  itemFor,
  liveTask,
  runSteps,
  START,
} from './trash.setup'

installTrashTimers()
const DEFAULT_LIST = { ...LIST }
const DEFAULT_REMOVAL = { ...REMOVAL_COUNT }
afterEach(() => {
  Object.assign(LIST, DEFAULT_LIST)
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

const list = (t: T, who: Doc<'profiles'>, deleted_by?: string) =>
  as(t, who).query(api.deletedItems.list, deleted_by === undefined ? {} : { deleted_by })
const rowsOf = async (t: T, who: Doc<'profiles'>) => (await list(t, who)).items
const idsOf = async (t: T, who: Doc<'profiles'>) => (await rowsOf(t, who)).map((r) => r.id)
const rowOf = async (t: T, who: Doc<'profiles'>, id: string) =>
  (await rowsOf(t, who)).find((r) => r.id === id)
const matches = (t: T, who: Doc<'profiles'>, text: string) =>
  as(t, who).query(api.deletedItems.matches, { text })
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
      refused: [],
      deferred: [],
    })
    expect(await t.run((ctx) => byId(ctx, 'projects', top.id))).not.toBeNull()
  })

  it('limits a sub-project lead to their sub-project inside a deleted top-level project', async () => {
    const t = newT()
    const f = await withOrg(t)
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
    expect(await matches(t, sam, 'samples')).toEqual([])
    expect((await matches(t, sam, 'trench')).map((m) => [m.title, m.path])).toEqual([
      ['Dig the trench', ['Field trial', 'Site']],
    ])
    expect((await matches(t, lena, 'samples')).map((m) => m.title).sort()).toEqual([
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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

    // Restore opens the project item first
    expect((await rowOf(t, f.admin, taskItem.id))?.blocked).toEqual({
      reason: 'project_deleted',
      item_id: projectItem.id,
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
    expect(JSON.stringify(await list(t, f.user))).not.toMatch(/Cursor|Laptop|Claude|mcp_tokens:/)
  })

  it('names a deleter only while their profile is the one that deleted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    // the seat is removed, and a later seat reuses its uuid
    await patch(t, 'profiles', f.guest.id, { created_at: '2026-06-01T00:00:00.000Z' })

    expect((await rowOf(t, f.user, item.id))?.deleter).toEqual({
      you: false,
      kind: 'app',
      who: `${f.guest.id}|app`,
    })
    // and the new seat does not see the delete as its own
    expect(await idsOf(t, f.guest)).toEqual([])
  })
})

describe('the list (design 6.2)', () => {
  it('lists the newest items up to the cap, and one person past it with deleted_by', async () => {
    const t = newT()
    const f = await withOrg(t)
    LIST.cap = 3
    const deleteOne = async (who: Doc<'profiles'>) => {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      later()
      await deleteTask(t, who, task.id)
      return (await itemFor(t, task.id)).id
    }
    const guests = [await deleteOne(f.guest), await deleteOne(f.guest)].reverse()
    const users: string[] = []
    for (let i = 0; i < 4; i++) users.unshift(await deleteOne(f.user))

    expect(await list(t, f.admin)).toEqual({
      items: users.slice(0, 3).map((id) => expect.objectContaining({ id })),
      capped: true,
    })
    expect(await list(t, f.admin, f.guest.id)).toEqual({
      items: guests.map((id) => expect.objectContaining({ id })),
      capped: false,
    })
    expect(await list(t, f.guest)).toEqual({
      items: guests.map((id) => expect.objectContaining({ id })),
      capped: false,
    })
    // filtering by someone else shows nothing the caller could not see anyway
    expect((await list(t, f.viewer, f.guest.id)).items).toEqual([])
  })

  it('reads a fixed number of ranges, however many items a lead or an admin sees', async () => {
    const t = newT({ transactionLimits: { databaseQueries: 40 } })
    const f = await withOrg(t)
    // planted, so the setup stays within the low limit: a sub-project item,
    // 60 task items deleted from that sub-project before it, all waiting for
    // it, and 60 task items in Firmware, which the user leads
    const gone = { ...f.sub, id: uuid(), key: 'GON', name: 'Gone' }
    const holder = uuid()
    const entry = (p: Doc<'projects'>) => ({
      id: p.id,
      name: p.name,
      key: p.key,
      type: p.type,
      tasks: 1,
      archived_tasks: 0,
    })
    const item = (p: Doc<'projects'>, fields: Partial<Doc<'deleted_items'>> = {}) => ({
      id: uuid(),
      org_id: f.org.id,
      kind: 'task' as const,
      target_id: uuid(),
      num: 1,
      name: 'Waiting',
      archived: false,
      project_id: p.id,
      parent_project_id: f.meta.id,
      path: ['Testbed platform', p.name],
      projects: [entry(p)],
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at: new Date(START).toISOString(),
      deleted_by: f.guest.id,
      state: 'ready' as const,
      purge_after: START + 30 * 86_400_000,
      ...fields,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert(
        'deleted_items',
        item(gone, { id: holder, kind: 'project', target_id: gone.id, key: gone.key }),
      )
      const { _id, _creationTime, ...doc } = gone
      await ctx.db.insert('deleted_rows', {
        item_id: holder,
        org_id: f.org.id,
        table: 'projects',
        owner_id: gone.id,
        row_id: gone.id,
        created_ts: _creationTime,
        project_key: gone.key,
        row: { table: 'projects', doc },
      })
      for (let i = 0; i < 60; i++) await ctx.db.insert('deleted_items', item(gone))
      for (let i = 0; i < 60; i++) await ctx.db.insert('deleted_items', item(f.sub))
    })

    const admin = await rowsOf(t, f.admin)
    expect(admin).toHaveLength(121)
    const waiting = admin.filter((r) => r.blocked?.reason === 'project_deleted')
    expect(waiting).toHaveLength(60)
    expect(new Set(waiting.map((r) => r.blocked?.item_id))).toEqual(new Set([holder]))
    // the user leads Firmware's top-level project, the parent of the
    // sub-project item too
    expect(await rowsOf(t, f.user)).toHaveLength(61)
  })

  it('refuses a caller without a login', async () => {
    const t = newT()
    await withOrg(t)
    await expectRefusal(t.query(api.deletedItems.list, {}), 'forbidden', /^not signed in$/)
    await expectRefusal(t.query(api.deletedItems.matches, { text: 'x' }), 'forbidden')
  })
})

describe('searching inside deleted projects', () => {
  it('finds tasks of visible project items by key or title, and nothing else', async () => {
    const t = newT()
    const f = await withOrg(t)
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'Route the power plane',
    })
    const loose = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Route the antenna',
    })
    await deleteTask(t, f.user, loose.id)
    later()
    await deleteProject(t, f.user, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)

    const hit = {
      item_id: item.id,
      org_id: f.org.id,
      org_name: 'Testbed Labs',
      key: `QN-${kept.num}`,
      title: 'Route the power plane',
      archived: false,
      path: ['Testbed platform', 'Board rev'],
      deleted_at: item.deleted_at,
      deleter: {
        you: true,
        profile_id: f.user.id,
        name: 'user',
        kind: 'app',
        who: `${f.user.id}|app`,
      },
      state: 'ready',
      can_restore: true,
    }
    // the loose task is a task item: the list holds it, not the search
    expect(await matches(t, f.user, 'route')).toEqual([hit])
    expect(await matches(t, f.user, `qn-${kept.num}`)).toEqual([hit])
    expect(await matches(t, f.user, `${kept.num}`)).toEqual([hit])
    expect(await matches(t, f.user, '   ')).toEqual([])
    expect((await matches(t, f.admin, 'power')).map((m) => m.key)).toEqual([`QN-${kept.num}`])
    // a member who can see Board rev, and neither deleted nor leads it
    expect(await matches(t, f.guest, 'power')).toEqual([])
    expect(await matches(t, f.otherAdmin, 'power')).toEqual([])
  })
})

describe('restore and purge calls', () => {
  it('restores per item and answers not_found for unknown, foreign and hidden ids alike', async () => {
    const t = newT()
    const f = await withOrg(t)
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
      refused: [
        { id: b, reason: 'not_found' },
        { id: c, reason: 'not_found' },
        { id: unknown, reason: 'not_found' },
      ],
      deferred: [],
    })
    expect(await liveTask(t, mine.id)).not.toBeNull()
    await expectRefusal(
      restore(t, f.guest, Array.from({ length: 26 }, uuid)),
      'rule',
      /^at most 25 items can be restored at a time$/,
    )
  })

  it('lets an organization admin delete ready and stuck items for good', async () => {
    const t = newT()
    const f = await withOrg(t)
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
    expect(await blobExists(t, attachment.storage_id)).toBe(false)
    await expectRefusal(
      purge(t, f.admin, Array.from({ length: 26 }, uuid)),
      'rule',
      /^at most 25 items can be deleted for good at a time$/,
    )
  })
})

describe('projects.removalSummary', () => {
  it('counts the tree for its lead, archived work included, and says when it stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
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
    REMOVAL_COUNT.cap = 2
    expect(await summary(f.user)).toMatchObject({
      tasks: 2,
      more: true,
      sub_projects: [
        { tasks: 3, more: true },
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
})

describe('archiving a task and keeping its subtasks (design 9)', () => {
  it('detaches the open subtasks as a delete does and archives the task alone', async () => {
    const t = newT()
    const f = await withOrg(t)
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
    const f = await withOrg(t)
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
