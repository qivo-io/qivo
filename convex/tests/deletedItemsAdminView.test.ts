/* Deleted items as an organization admin reads it (model/deletedItems.ts
 * viewOf and roleReadsEveryTask). An admin keeps every item that is not
 * purging, with its metadata, Restore by the ordinary rule and Delete now,
 * and reads its tasks only as their ordinary access reaches them: admin
 * status gives no level (lib/access.ts levelUnder and levelsFrom), so
 * roleReadsEveryTask is false for every role and a task item whose project
 * the admin cannot read shows as a hidden row. A split that left either
 * admin branch fails these cases, since roleReadsEveryTask asks levelsFrom
 * while a restore asks projectLevel through liveLevel.
 *
 * Two of the review points for this view are agent decisions of the admin
 * access split (7 November 2026): an admin's probe for rows stored before
 * the page stays organization-wide (model/deletedItemsPage.ts Seat.admin,
 * olderRows), so `legacy` can come from projects they cannot read, and the
 * admin's assignee index can end a short page at a row it dropped, which
 * the next page's cursor moves past. Both say nothing a task they cannot
 * read holds. t3/limits-project-old-paths removes the read-everything
 * branch with the old list.
 *
 * The last block reads at the design size, one figure raised a case, and
 * logs its reads as tests/deletedItemsPageReads.test.ts does. */
/// <reference types="vite/client" />

import type { FunctionArgs, WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as access from '../lib/access'
import { byId } from '../lib/db'
import type { OrgRole } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { restoreBlock, roleReadsEveryTask, sightOf } from '../model/deletedItems'
import { LIST } from '../model/deletedItemsList'
import {
  DELETED_PAGE,
  type DeletedPage,
  type PageArgs,
  type PageSpend,
  pageFor,
} from '../model/deletedItemsPage'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { installTrashTimers, itemFor, runSteps, START } from './trash.setup'

installTrashTimers()
const DEFAULT_LIST = { ...LIST }
const DEFAULT_PAGE = {
  ...DELETED_PAGE,
  call: { ...DELETED_PAGE.call },
  build: { ...DELETED_PAGE.build },
  find: { ...DELETED_PAGE.find },
  gather: { ...DELETED_PAGE.gather },
}
afterEach(() => {
  Object.assign(LIST, DEFAULT_LIST)
  Object.assign(DELETED_PAGE, DEFAULT_PAGE)
})

type Profile = Doc<'profiles'>
type Item = Doc<'deleted_items'>

/** A person with a login in `org_id`. */
const person = (
  t: T,
  org_id: string,
  name: string,
  org_role: OrgRole = 'user',
  extra: Partial<WithoutSystemFields<Profile>> = {},
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
/** Removes `profile_id`'s grant on `project_id`. */
const ungrant = (t: T, project_id: string, profile_id: string) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', project_id).eq('profile_id', profile_id),
      )
      .unique()
    if (row !== null) await ctx.db.delete(row._id)
  })
/** Shares `project_id` with team `team_id`; answers a way to take it back. */
const share = async (t: T, project_id: string, team_id: string, level: 'user' | 'viewer') => {
  const _id = await t.run((ctx) =>
    ctx.db.insert('project_team_access', { project_id, team_id, level }),
  )
  return () => t.run((ctx) => ctx.db.delete(_id))
}
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

const listOf = (t: T, who: Profile) => as(t, who).query(api.deletedItems.list, {})
const rowOf = async (t: T, who: Profile, id: string) =>
  (await listOf(t, who)).items.find((r) => r.id === id)
const itemRow = (t: T, who: Profile, id: string) => as(t, who).query(api.deletedItems.item, { id })
const search = (t: T, who: Profile, text: string) =>
  as(t, who).query(api.deletedItems.matches, { text })
const page = (t: T, who: Profile, args: FunctionArgs<typeof api.deletedItems.page>) =>
  as(t, who).query(api.deletedItems.page, args)
const restore = (t: T, who: Profile, ids: string[]) =>
  as(t, who).mutation(api.deletedItems.restore, { org_id: who.org_id, ids })
const purge = (t: T, who: Profile, ids: string[]) =>
  as(t, who).mutation(api.deletedItems.purge, { org_id: who.org_id, ids })
const deleteTask = (t: T, who: Profile, id: string, extra: object = {}) =>
  as(t, who).mutation(api.issues.deleteDeep, { org_id: who.org_id, id, ...extra })
const deleteProject = (t: T, who: Profile, id: string, extra: object = {}) =>
  as(t, who).mutation(api.projects.deleteDeep, { org_id: who.org_id, id, ...extra })
/** Moves the clock on, so the next delete sorts after the last. */
const later = () => vi.setSystemTime(Date.now() + 60_000)

/** Every page for `who` and `args` to the one whose next_cursor is null. */
async function walk(t: T, who: Profile, args: FunctionArgs<typeof api.deletedItems.page>) {
  const pages: DeletedPage[] = []
  let cursor: string | undefined
  for (let i = 0; i < 100; i++) {
    const answer = await page(t, who, cursor === undefined ? args : { ...args, cursor })
    pages.push(answer)
    if (answer.next_cursor === null) break
    cursor = answer.next_cursor
  }
  return {
    pages,
    entries: pages.flatMap((p) => p.entries),
    items: pages.flatMap((p) => p.items),
    ids: pages.flatMap((p) => p.entries.map((e) => e.item_id)),
  }
}

/** A top-level project `name` led by `lead`, with sub-projects `subs`. */
async function tree(
  t: T,
  f: OrgFixture,
  name: string,
  lead: Profile | undefined,
  subs: { name: string; lead?: Profile }[],
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

/** A ready task item of one task in project `p`, deleted by the guest, as a
 * deleted_items row planted without its stored rows. */
const plantedItem = (
  f: OrgFixture,
  p: { id: string; name: string; key: string; type: Doc<'projects'>['type'] },
  fields: Partial<Item> = {},
) => ({
  id: uuid(),
  org_id: f.org.id,
  kind: 'task' as const,
  target_id: uuid(),
  num: 9001,
  name: 'Waiting for its project',
  archived: false,
  project_id: p.id,
  path: [p.name],
  projects: [{ id: p.id, name: p.name, key: p.key, type: p.type, tasks: 1, archived_tasks: 0 }],
  counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
  deleted_at: new Date(START).toISOString(),
  deleted_by: f.guest.id,
  state: 'ready' as const,
  purge_after: START + 30 * 86_400_000,
  ...fields,
})

/** The deleter line of a delete in the app by the fixture's guest. */
const byGuest = (f: OrgFixture) => ({
  you: false,
  profile_id: f.guest.id,
  name: 'guest',
  kind: 'app',
  who: `${f.guest.id}|app`,
})

describe('an admin without ordinary access', () => {
  it("gives an admin every item in the list, the item and the page, a task item as a hidden row and a project item whole, for every shape of the list's cases", async () => {
    const t = newT()
    const f = await withOrg(t)
    const dana = await person(t, f.org.id, 'Dana')
    const lena = await person(t, f.org.id, 'Lena')
    const ops = await tree(t, f, 'Operations', undefined, [{ name: 'Infra' }])
    const trial = await tree(t, f, 'Field trial', lena, [{ name: 'Site' }, { name: 'Lab' }])
    await grant(t, f.meta.id, dana.id, 'user')
    await grant(t, ops.top.id, dana.id, 'user')
    // a delete of the guest's own, with a reason
    const own = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Own alpha' })
    await deleteTask(t, f.guest, own.id, { reason: 'wrong board' })
    later()
    // a family a member sees redacted, its subtask in another top-level project
    const root = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Family alpha root',
    })
    const sub = await plantIssue(t, {
      org_id: f.org.id,
      project_id: ops.subs[0].id,
      title: 'Family alpha subtask',
      parent_id: root.id,
    })
    await deleteTask(t, dana, root.id, { subtask_ids: [sub.id], reason: 'confidential' })
    later()
    // a project item with tasks in its sub-projects
    await plantIssue(t, { org_id: f.org.id, project_id: trial.subs[0].id, title: 'Site alpha' })
    await plantIssue(t, { org_id: f.org.id, project_id: trial.subs[1].id, title: 'Lab alpha' })
    await deleteProject(t, lena, trial.top.id, { reason: 'moved labs' })
    later()
    // a task item waiting for its deleted project, and a stuck one
    const waiting = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'Waiting alpha',
    })
    await deleteTask(t, f.guest, waiting.id)
    const stuck = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'Stuck alpha',
    })
    await deleteTask(t, f.guest, stuck.id)
    await patch(t, 'deleted_items', (await itemFor(t, stuck.id)).id, { state: 'stuck' })
    later()
    await deleteProject(t, f.user, f.sub2.id)
    // a task item whose project is gone, and one outside a valid tree
    const outside = await plantProject(t, { org_id: f.org.id, type: 'project', name: 'Loose' })
    const gone = plantedItem(
      f,
      { id: uuid(), name: 'Gone', key: 'GN', type: 'project' },
      { name: 'Gone alpha' },
    )
    const loose = plantedItem(f, outside, { name: 'Loose alpha', num: 9002 })
    await t.run(async (ctx) => {
      await ctx.db.insert('deleted_items', gone)
      await ctx.db.insert('deleted_items', loose)
    })
    await runSteps(t)

    const items = (await t.run((ctx) => ctx.db.query('deleted_items').collect())).filter(
      (i) => i.state !== 'purging',
    )
    const listed = (await listOf(t, f.admin)).items
    expect(listed.map((r) => r.id).sort()).toEqual(items.map((i) => i.id).sort())
    for (const item of items) {
      const row = listed.find((r) => r.id === item.id)
      // every item with its counts, projects and Delete now; a task item's
      // title, status and reason only where the admin reads its tasks,
      // which they read nowhere; a project item's name is management data
      expect(row, item.name).toMatchObject({
        title: item.kind === 'project' ? item.name : '',
        counts: item.counts,
        can_purge: true,
      })
      expect(
        row?.projects.map((p) => p.id),
        item.name,
      ).toEqual(item.projects.map((p) => p.id))
      if (item.kind === 'task') expect(row, item.name).toMatchObject({ hidden: true })
      else expect(row, item.name).not.toHaveProperty('hidden')
      expect(await itemRow(t, f.admin, item.id), item.name).toEqual(row)
    }
    // the page gives the same rows, each item once
    const walked = await walk(t, f.admin, { scope: { org_id: f.org.id, all: true } })
    expect([...walked.ids].sort()).toEqual(items.map((i) => i.id).sort())
    for (const row of listed)
      expect(
        walked.items.find((r) => r.id === row.id),
        row.title,
      ).toEqual(row)
    // neither search finds a task the admin cannot read
    expect((await search(t, f.admin, 'alpha')).matches).toEqual([])
    const scope = { org_id: f.org.id, all: true as const }
    expect((await page(t, f.admin, { scope, search: 'alpha' })).entries).toEqual([])
    // a member who reads them finds them, as before
    expect((await search(t, f.guest, 'Own alpha')).matches.map((m) => m.title)).toEqual([
      'Own alpha',
    ])
  })
})

describe('whether a role reads every task', () => {
  it('is false for every role, an admin included', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const who of [f.admin, f.user, f.guest, f.viewer, f.agent])
      expect(roleReadsEveryTask(who), who.name).toBe(false)
  })
})

describe('an admin by ordinary access', () => {
  it('judges an admin by their rows in model/deletedItems.ts, as anyone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    const judged = () =>
      t.run(async (ctx) => ({
        reads: roleReadsEveryTask(f.admin),
        sight: (await sightOf(ctx, f.admin)).levels.levelOf(f.sub),
        block: await restoreBlock(ctx, f.admin, item),
      }))
    expect(await judged()).toEqual({ reads: false, sight: null, block: 'no_access' })
    // a grant of their own reads it, as anyone's
    await grant(t, f.meta.id, f.admin.id, 'user')
    expect(await judged()).toEqual({ reads: false, sight: 'user', block: null })
  })

  it('keeps a task item the admin cannot read as a hidden row, with its key, path, counts and deleter and without its title, status or reason', async () => {
    const t = newT()
    const f = await withOrg(t)
    const root = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Contoso acquisition due diligence',
      status: 'review',
    })
    const sub = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Draft the term sheet',
      parent_id: root.id,
    })
    await deleteTask(t, f.guest, root.id, { subtask_ids: [sub.id], reason: 'confidential' })
    const item = await itemFor(t, root.id)
    const row = await rowOf(t, f.admin, item.id)
    expect(row).toEqual({
      id: item.id,
      org_id: f.org.id,
      org_name: 'Testbed Labs',
      kind: 'task',
      key: `QN-${root.num}`,
      title: '',
      counts: item.counts,
      projects: item.projects,
      path: ['Testbed platform', 'Firmware'],
      archived: false,
      deleted_at: item.deleted_at,
      deleter: byGuest(f),
      state: 'ready',
      hidden: true,
      can_restore: false,
      blocked: { reason: 'no_access' },
      can_purge: true,
    })
    expect(item.counts).toMatchObject({ tasks: 2, subtasks: 1 })
    expect(JSON.stringify(row)).not.toMatch(/Contoso|confidential|term sheet|review/)
    // the item, the page and its search give the same row, and no hit
    expect(await itemRow(t, f.admin, item.id)).toEqual(row)
    const scope = { org_id: f.org.id, all: true as const }
    expect((await walk(t, f.admin, { scope })).items).toEqual([row])
    const searched = await page(t, f.admin, { scope, search: 'term sheet' })
    expect(searched).toMatchObject({ entries: [], missing: 'matches' })
    expect((await search(t, f.admin, 'Contoso')).matches).toEqual([])
    // the guest, who deleted it and reads its project, sees it as before
    expect(await rowOf(t, f.guest, item.id)).toMatchObject({
      title: 'Contoso acquisition due diligence',
      reason: 'confidential',
    })
  })

  it('reads the item through a user grant, a team share, leadership and a level held as its deleter, and only then', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Bring up the board',
    })
    const mine = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Order the parts',
    })
    await deleteTask(t, f.guest, task.id)
    // the admin deletes one while a grant lets them edit it, and loses it
    await grant(t, f.meta.id, f.admin.id, 'user')
    await deleteTask(t, f.admin, mine.id)
    await ungrant(t, f.meta.id, f.admin.id)
    const item = await itemFor(t, task.id)
    const own = await itemFor(t, mine.id)
    const titleOf = async (id: string) => {
      const row = await rowOf(t, f.admin, id)
      return row?.hidden === true ? null : row?.title
    }
    expect(await titleOf(item.id)).toBeNull()
    // deleting it gives the admin no level, so it stays hidden too
    expect(await titleOf(own.id)).toBeNull()

    await grant(t, f.meta.id, f.admin.id, 'user')
    expect(await titleOf(item.id)).toBe('Bring up the board')
    expect(await rowOf(t, f.admin, item.id)).toMatchObject({ can_restore: true })
    await ungrant(t, f.meta.id, f.admin.id)
    expect(await titleOf(item.id)).toBeNull()

    // the fixture's team holds the admin
    const unshare = await share(t, f.meta.id, f.team.id, 'viewer')
    expect(await titleOf(item.id)).toBe('Bring up the board')
    expect(await rowOf(t, f.admin, item.id)).toMatchObject({
      can_restore: false,
      blocked: { reason: 'view_only' },
    })
    await unshare()
    expect(await titleOf(item.id)).toBeNull()

    await patch(t, 'projects', f.sub.id, { lead_id: f.admin.id })
    expect(await titleOf(item.id)).toBe('Bring up the board')
    await patch(t, 'projects', f.sub.id, { lead_id: undefined })
    expect(await titleOf(item.id)).toBeNull()

    await grant(t, f.meta.id, f.admin.id, 'viewer')
    expect(await titleOf(own.id)).toBe('Order the parts')
  })

  it("names a hidden item's root by key alone in a hit on a subtask the admin can read", async () => {
    const t = newT()
    const f = await withOrg(t)
    const dana = await person(t, f.org.id, 'Dana')
    const ops = await tree(t, f, 'Operations', undefined, [{ name: 'Infra' }])
    const infra = ops.subs[0]
    await grant(t, f.meta.id, dana.id, 'user')
    await grant(t, ops.top.id, dana.id, 'user')
    await grant(t, ops.top.id, f.admin.id, 'user')
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
    await deleteTask(t, dana, root.id, { subtask_ids: [sub.id] })
    const item = await itemFor(t, root.id)
    const row = await rowOf(t, f.admin, item.id)
    expect(row).toMatchObject({
      key: `QN-${root.num}`,
      title: '',
      hidden: true,
      counts: { tasks: 2, subtasks: 1 },
    })
    expect(row?.projects.map((p) => p.id)).toEqual([f.sub.id, infra.id])
    const scope = { org_id: f.org.id, all: true as const }
    const found = await page(t, f.admin, { scope, search: 'Provision' })
    expect(found.entries).toEqual([
      {
        item_id: item.id,
        task: {
          key: `QN-${sub.num}`,
          title: 'Provision the data room',
          root_key: `QN-${root.num}`,
          archived: false,
          path: ['Operations', 'Infra'],
        },
      },
    ])
    expect(found.missing).toBe('matches')
    const matched = (await search(t, f.admin, 'Provision')).matches
    expect(matched).toHaveLength(1)
    expect(matched[0]).toMatchObject({ key: `QN-${sub.num}`, root_key: `QN-${root.num}` })
    expect(matched[0]).not.toHaveProperty('root_title')
    expect(JSON.stringify([found, matched])).not.toContain('Contoso')
    expect((await page(t, f.admin, { scope, search: 'Contoso' })).entries).toEqual([])
    expect((await search(t, f.admin, 'Contoso')).matches).toEqual([])
    // a scope of a project the admin reads lists it, one they cannot read names nothing
    const opsScope = { org_id: f.org.id, project_ids: [ops.top.id] }
    expect((await walk(t, f.admin, { scope: opsScope })).ids).toEqual([item.id])
    const fwScope = { org_id: f.org.id, project_ids: [f.meta.id] }
    expect(await page(t, f.admin, { scope: fwScope })).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
    })
  })

  it('hides a task item waiting for its deleted project and one whose project is gone, and keeps the project item whole', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Waiting on the platform',
    })
    await deleteTask(t, f.guest, task.id)
    later()
    await deleteProject(t, f.user, f.meta.id, { reason: 'platform cancelled' })
    await runSteps(t)
    const waiting = await itemFor(t, task.id)
    const holder = await itemFor(t, f.meta.id)
    const gone = plantedItem(f, { id: uuid(), name: 'Gone', key: 'GN', type: 'project' })
    await t.run((ctx) => ctx.db.insert('deleted_items', gone))
    expect(await rowOf(t, f.admin, waiting.id)).toMatchObject({
      title: '',
      hidden: true,
      blocked: { reason: 'project_deleted', item_id: holder.id },
      can_purge: true,
    })
    expect(await rowOf(t, f.admin, gone.id)).toMatchObject({
      title: '',
      hidden: true,
      blocked: { reason: 'project_deleted' },
    })
    // a project's name, key, path and reason are project management data
    const projectRow = await rowOf(t, f.admin, holder.id)
    expect(projectRow).toMatchObject({
      kind: 'project',
      key: 'TBED',
      title: 'Testbed platform',
      reason: 'platform cancelled',
      counts: holder.counts,
      can_restore: true,
      can_purge: true,
    })
    expect(projectRow).not.toHaveProperty('hidden')
  })

  it('keeps a project item whole and takes its hits only from the projects its stored rows give the admin', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lena = await person(t, f.org.id, 'Lena')
    const sam = await person(t, f.org.id, 'Sam')
    const { top, subs } = await tree(t, f, 'Field trial', lena, [
      { name: 'Site', lead: sam },
      { name: 'Lab' },
    ])
    const [site, lab] = subs
    await grant(t, lab.id, f.admin.id, 'user')
    await plantIssue(t, { org_id: f.org.id, project_id: site.id, title: 'Dig the trench' })
    await plantIssue(t, { org_id: f.org.id, project_id: lab.id, title: 'Seal the samples' })
    // a task stored on the top-level project itself
    await plantIssue(t, { org_id: f.org.id, project_id: top.id, title: 'Kickoff notes' })
    await deleteProject(t, lena, top.id, { reason: 'moved to the new lab' })
    await runSteps(t)
    const item = await itemFor(t, top.id)
    const row = await rowOf(t, f.admin, item.id)
    expect(row).toMatchObject({
      kind: 'project',
      key: top.key,
      title: 'Field trial',
      path: [],
      reason: 'moved to the new lab',
      counts: item.counts,
      can_restore: true,
      can_purge: true,
    })
    expect(row?.projects.map((p) => p.id)).toEqual(item.projects.map((p) => p.id))
    expect(row).not.toHaveProperty('hidden')
    const scope = { org_id: f.org.id, all: true as const }
    const titles = async (text: string) => ({
      page: (await walk(t, f.admin, { scope, search: text })).entries.map((e) => e.task?.title),
      matches: (await search(t, f.admin, text)).matches.map((m) => m.title),
    })
    expect(await titles('samples')).toEqual({
      page: ['Seal the samples'],
      matches: ['Seal the samples'],
    })
    expect(await titles('trench')).toEqual({ page: [], matches: [] })
    // the stored rows give the admin the top-level project for navigation
    // to Lab, which counts as it does in anyone else's view of a project
    // item, so its own tasks show, as they do to a member, one rule for
    // every seat (agent decision of the admin access split, 7 November 2026)
    expect(await titles('Kickoff')).toEqual({ page: ['Kickoff notes'], matches: ['Kickoff notes'] })
  })

  it("finds nothing an admin's search or task reference would read only in a task they cannot read, and always says matches may be missing", async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Vendor review',
      description: 'Quarterly audit of the vendor contracts',
    })
    await deleteTask(t, f.guest, task.id)
    const scope = { org_id: f.org.id, all: true as const }
    const lowered = () => {
      DELETED_PAGE.candidates = 1
      DELETED_PAGE.results = 1
    }
    const item = await itemFor(t, task.id)
    // the guest, who reads it, finds it
    expect((await page(t, f.guest, { scope, search: 'audit' })).entries).toEqual([
      { item_id: item.id },
    ])
    const none = { entries: [], items: [], next_cursor: null, missing: 'matches' }
    expect(await page(t, f.admin, { scope, search: 'audit' })).toEqual(none)
    expect(await page(t, f.admin, { scope, search: `QN-${task.num}` })).toEqual(none)
    expect(await page(t, f.admin, { search: `QN-${task.num}` })).toEqual({
      ...none,
      scope_needed: true,
    })
    expect((await search(t, f.admin, 'Vendor')).matches).toEqual([])
    // a lowered allowance or room changes nothing for a seat that does not
    // read every task
    lowered()
    expect(await page(t, f.admin, { scope, search: 'audit' })).toEqual(none)
    Object.assign(DELETED_PAGE, DEFAULT_PAGE)
    DELETED_PAGE.gather = { ...DEFAULT_PAGE.gather, ranges: 1 }
    expect(await page(t, f.admin, { scope, search: 'audit' })).toEqual(none)
    Object.assign(DELETED_PAGE, DEFAULT_PAGE)
    // a browse still lists the item, hidden
    expect((await page(t, f.admin, { scope })).items).toMatchObject([{ hidden: true }])
  })

  it("lists a hidden item on the admin's assignee index only through a task they read, and on a scoped browse by its fields, and no unreadable task", async () => {
    const t = newT()
    const f = await withOrg(t)
    const dana = await person(t, f.org.id, 'Dana')
    const mia = await person(t, f.org.id, 'Mia')
    const ops = await tree(t, f, 'Operations', undefined, [{ name: 'Infra' }])
    const infra = ops.subs[0]
    for (const who of [dana, mia]) {
      await grant(t, f.meta.id, who.id, 'user')
      await grant(t, ops.top.id, who.id, 'user')
    }
    await grant(t, ops.top.id, f.admin.id, 'user')
    // a task assigned to Mia in Infra, which the admin reads
    const readable = await plantIssue(t, {
      org_id: f.org.id,
      project_id: infra.id,
      title: 'Rack the servers',
      assignee_id: mia.id,
    })
    await deleteTask(t, dana, readable.id)
    later()
    // six tasks assigned to Mia in Firmware, which the admin cannot read
    const unreadable: string[] = []
    for (let i = 0; i < 6; i++) {
      const task = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Secret firmware ${i}`,
        assignee_id: mia.id,
      })
      await deleteTask(t, f.guest, task.id)
      unreadable.push((await itemFor(t, task.id)).id)
      later()
    }
    // a family whose root the admin cannot read, its subtask assigned to Mia in Infra
    const root = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Secret family root',
    })
    const sub = await plantIssue(t, {
      org_id: f.org.id,
      project_id: infra.id,
      title: 'Cable the racks',
      parent_id: root.id,
      assignee_id: mia.id,
    })
    await deleteTask(t, dana, root.id, { subtask_ids: [sub.id] })
    const family = await itemFor(t, root.id)
    const plain = await itemFor(t, readable.id)
    const scope = { org_id: f.org.id, all: true as const }
    const expectOnlyReadable = (walked: Awaited<ReturnType<typeof walk>>) => {
      expect(walked.ids).toEqual([family.id, plain.id])
      expect(walked.items.map((r) => r.id).sort()).toEqual([family.id, plain.id].sort())
      expect(walked.entries.find((e) => e.item_id === family.id)?.task).toEqual({
        key: `QN-${sub.num}`,
        title: 'Cable the racks',
        root_key: `QN-${root.num}`,
        archived: false,
        path: ['Operations', 'Infra'],
      })
      expect(JSON.stringify(walked.pages)).not.toMatch(/Secret/)
      for (const id of unreadable) expect(JSON.stringify(walked.pages)).not.toContain(id)
    }
    expectOnlyReadable(await walk(t, f.admin, { scope, assignee: mia.id }))
    // two rows of the index a page, so pages that end at a row they
    // dropped say nothing about it but where the next page starts
    DELETED_PAGE.find = { ...DEFAULT_PAGE.find, rows: 2 }
    const paged = await walk(t, f.admin, { scope, assignee: mia.id })
    expect(paged.pages.length).toBeGreaterThan(2)
    expectOnlyReadable(paged)
    Object.assign(DELETED_PAGE, DEFAULT_PAGE)
    // a scoped browse holds an admin's item by its fields, so it lists the
    // hidden family through Operations, and no item only in Firmware
    const ofOps = await walk(t, f.admin, {
      scope: { org_id: f.org.id, project_ids: [ops.top.id] },
      kind: 'task',
    })
    expect(ofOps.ids).toEqual([family.id, plain.id])
    expect(ofOps.items.find((r) => r.id === family.id)).toMatchObject({ hidden: true, title: '' })
    // All projects lists every item, the unreadable ones hidden
    const all = await walk(t, f.admin, { scope, kind: 'task' })
    expect(all.ids).toEqual([family.id, ...[...unreadable].reverse(), plain.id])
    expect(all.items.filter((r) => r.hidden === true)).toHaveLength(7)
  })

  it('says no budget stop of the old search to an admin, who reads no task of these items', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lena = await person(t, f.org.id, 'Lena')
    for (let i = 0; i < 4; i++) {
      const p = await plantProject(t, { org_id: f.org.id, lead_id: lena.id })
      await plantIssue(t, { org_id: f.org.id, project_id: p.id, title: `Survey the gate ${i}` })
      await deleteProject(t, lena, p.id)
      later()
    }
    await runSteps(t)
    // an admin who reads none of them reads each item's stored rows, and
    // a budget that stops the search is not said, whatever it is
    for (const ranges of [DEFAULT_LIST.call.ranges, 24, 8]) {
      LIST.call = { ...DEFAULT_LIST.call, ranges }
      expect(await search(t, f.admin, 'survey'), `${ranges}`).toEqual({
        matches: [],
        capped: false,
      })
    }
    // Lena, who leads them, finds every one
    Object.assign(LIST, DEFAULT_LIST)
    expect((await search(t, lena, 'survey')).matches).toHaveLength(4)
  })

  it('restores a project item for an admin without stored levels, and clears an admin holder who cannot work there, as the reveal judges every holder', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lena = await person(t, f.org.id, 'Lena')
    const ada = await person(t, f.org.id, 'Ada', 'admin')
    const { top, subs } = await tree(t, f, 'Field trial', lena, [{ name: 'Site' }])
    // one task held by Lena, who leads the project, and one by Ada, an
    // admin with no lead, grant or share on it
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: subs[0].id,
      assignee_id: lena.id,
    })
    const cleared = await plantIssue(t, {
      org_id: f.org.id,
      project_id: subs[0].id,
      assignee_id: ada.id,
    })
    await deleteProject(t, lena, top.id)
    await runSteps(t)
    const item = await itemFor(t, top.id)
    // the fixture's admin, who holds no stored level on it, restores it:
    // a project item's restore is management
    expect(await rowOf(t, f.admin, item.id)).toMatchObject({ can_restore: true })
    expect((await restore(t, f.admin, [item.id])).refused).toEqual([])
    await runSteps(t)
    const holderOf = async (id: string) =>
      (await t.run((ctx) => byId(ctx, 'issues', id)))?.assignee_id
    expect(await holderOf(kept.id)).toBe(lena.id)
    // keepsHolder asks the holder's ordinary level, which Ada lacks
    expect(await holderOf(cleared.id)).toBeUndefined()
  })

  it('refuses to restore a hidden task item for want of access, and deletes it for good', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    expect((await restore(t, f.admin, [item.id])).refused).toEqual([
      { id: item.id, reason: 'no_access' },
    ])
    // Delete now stays the admin's, with its summary, which reads no level
    expect(await as(t, f.admin).query(api.deletedItems.purgeSummary, { id: item.id })).toEqual({
      along: 0,
      exact: true,
    })
    expect(await purge(t, f.admin, [item.id])).toEqual({ purged: [item.id], refused: [] })
    await runSteps(t)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
  })

  it('gives Delete now and its summary a task item under a broken tree, as an admin is let in with no level read', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.guest, task.id)
    const item = await itemFor(t, task.id)
    // the sub-project's parent dangles, so a level read on it throws
    await patch(t, 'projects', f.sub.id, { parent_id: uuid() })
    const broken = (await t.run((ctx) => byId(ctx, 'projects', f.sub.id))) as Doc<'projects'>
    await expectRefusal(
      t.run((ctx) => access.projectLevel(ctx, f.admin, broken)),
      'not_found',
      /project not found/,
    )
    expect(await as(t, f.admin).query(api.deletedItems.purgeSummary, { id: item.id })).toEqual({
      along: 0,
      exact: true,
    })
    expect(await purge(t, f.admin, [item.id])).toEqual({ purged: [item.id], refused: [] })
    await runSteps(t)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
  })

  it("names a deleted project's milestones in the week-start check only where the admin's view reads the project", async () => {
    const setWeekStart = (t: T, f: OrgFixture) =>
      as(t, f.admin).mutation(api.orgs.update, { org_id: f.org.id, patch: { week_start: 0 } })
    const addMilestone = (t: T, f: OrgFixture, name: string, week: string) =>
      as(t, f.user).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.meta.id,
        name,
        week,
      })
    const messageOf = async (t: T, f: OrgFixture) =>
      ((await expectRefusal(setWeekStart(t, f), 'rule')).data as Refusal).message
    const deleted = async (shared: boolean) => {
      const t = newT()
      const f = await withOrg(t)
      await addMilestone(t, f, 'Alpha', '2026-05-10')
      await addMilestone(t, f, 'Beta', '2026-05-11')
      // the fixture's team holds the admin; its share is stored with the project
      if (shared) await share(t, f.meta.id, f.team.id, 'viewer')
      await deleteProject(t, f.user, f.meta.id)
      await runSteps(t)
      return { t, f }
    }
    const named =
      /Testbed platform \(TBED, in Deleted items\) would have “Alpha” on 2026-05-10 and “Beta” on 2026-05-11/
    const unnamed =
      /Testbed platform \(TBED, in Deleted items\) would have milestones on 2026-05-10 and 2026-05-11/
    const plain = await deleted(false)
    const hidden = await messageOf(plain.t, plain.f)
    expect(hidden).toMatch(unnamed)
    expect(hidden).not.toMatch(/Alpha|Beta/)
    const viaTeam = await deleted(true)
    expect(await messageOf(viaTeam.t, viaTeam.f)).toMatch(named)
  })
})

/* ------------------------------------------------- reads at the design size */

/** About 80 characters, holding `calibrate`. */
const title = (i: number) =>
  `Calibrate the torque sensor on test rig ${i} before the thermal soak run starts`
/** A few sentences. */
const DESCRIPTION =
  'Check the fixture alignment first. Record the readings in the lab notebook. ' +
  'Ask the lead if the values drift more than two percent.'

let nextNum = 20_000

/** A project row as the projects table holds it. */
const projectRow = (
  f: OrgFixture,
  fields: { type: 'meta' | 'project'; parent_id?: string; lead_id?: string; archived?: boolean },
) => {
  const num = nextNum++
  return {
    id: uuid(),
    org_id: f.org.id,
    type: fields.type,
    key: `K${num}`,
    name: `Project ${num} of the bench`,
    description: '',
    sort_order: num,
    num,
    track_delay: false,
    created_at: NOW,
    ...(fields.parent_id === undefined ? {} : { parent_id: fields.parent_id }),
    ...(fields.lead_id === undefined ? {} : { lead_id: fields.lead_id }),
    ...(fields.archived === true ? { archived_at: NOW } : {}),
  }
}

type ProjectRow = ReturnType<typeof projectRow>

/** Inserts `rows` projects in batches. */
async function insertProjects(t: T, rows: ProjectRow[]): Promise<void> {
  for (let from = 0; from < rows.length; from += 500)
    await t.run(async (ctx) => {
      for (const row of rows.slice(from, from + 500)) await ctx.db.insert('projects', row)
    })
}

/** `count` teams of the organization holding `me`, answering their ids. */
async function teamsOf(t: T, f: OrgFixture, me: Profile, count: number): Promise<string[]> {
  return await t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name: `Bench team ${i}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: id, profile_id: me.id, is_leader: false })
      ids.push(id)
    }
    return ids
  })
}

/** A ready project item of `root` and `subs` as a deletion stores them,
 * deleted by the user at START, with `perSub` open tasks of ordinary text in
 * each live one of `subs`, and the stored shares `shares` names, each a
 * team and the sub-project it shares. Answers the item's id. */
async function plantProjectItem(
  t: T,
  f: OrgFixture,
  a: { root: ProjectRow; subs: ProjectRow[]; perSub: number; shares: [string, ProjectRow][] },
): Promise<string> {
  const id = uuid()
  const deleted_at = new Date(START).toISOString()
  const projects = [a.root, ...a.subs]
  const homes = a.subs.filter((s) => s.archived_at === undefined)
  await t.run(async (ctx) => {
    await ctx.db.insert('deleted_items', {
      id,
      org_id: f.org.id,
      kind: 'project',
      target_id: a.root.id,
      num: a.root.num,
      name: a.root.name,
      key: a.root.key,
      archived: false,
      project_id: a.root.id,
      path: [],
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        type: p.type,
        tasks: homes.includes(p) ? a.perSub : 0,
        archived_tasks: 0,
      })),
      counts: {
        tasks: homes.length * a.perSub,
        archived_tasks: 0,
        subtasks: 0,
        sub_projects: a.subs.length,
      },
      deleted_at,
      deleted_by: f.user.id,
      state: 'ready',
      purge_after: START + 30 * 86_400_000,
    })
    for (const p of projects)
      await ctx.db.insert('deleted_rows', {
        item_id: id,
        org_id: f.org.id,
        table: 'projects',
        owner_id: p.id,
        row_id: p.id,
        created_ts: START,
        project_key: p.key,
        row: { table: 'projects', doc: p },
      })
    for (const [team_id, p] of a.shares)
      await ctx.db.insert('deleted_rows', {
        item_id: id,
        org_id: f.org.id,
        table: 'project_team_access',
        owner_id: p.id,
        created_ts: START,
        grantee: team_id,
        row: { table: 'project_team_access', doc: { project_id: p.id, team_id, level: 'user' } },
      })
  })
  for (const [h, home] of homes.entries())
    await t.run(async (ctx) => {
      for (let i = 0; i < a.perSub; i++) {
        const num = nextNum++
        await ctx.db.insert('deleted_tasks', {
          org_id: f.org.id,
          item_id: id,
          task_id: uuid(),
          num,
          title: title(h * a.perSub + i),
          project_id: home.id,
          archived: false,
          search_text: `${title(h * a.perSub + i)}\n${DESCRIPTION}`,
          deleted_at,
          deleted_by: f.user.id,
          item_project_id: a.root.id,
        })
      }
    })
  return id
}

/** A ready task item of one task in live sub-project `p` under `top`,
 * deleted by the guest at `at`, with its deleted_tasks row. */
async function plantTaskItem(t: T, f: OrgFixture, p: ProjectRow, top: string, at: number) {
  const id = uuid()
  const num = nextNum++
  const deleted_at = new Date(at).toISOString()
  await t.run(async (ctx) => {
    await ctx.db.insert('deleted_items', {
      id,
      org_id: f.org.id,
      kind: 'task',
      target_id: uuid(),
      num,
      name: title(num),
      archived: false,
      project_id: p.id,
      parent_project_id: top,
      path: ['Bench', p.name],
      projects: [
        { id: p.id, name: p.name, key: p.key, type: 'project', tasks: 1, archived_tasks: 0 },
      ],
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at,
      deleted_by: f.guest.id,
      state: 'ready',
      purge_after: at + 30 * 86_400_000,
    })
    await ctx.db.insert('deleted_tasks', {
      org_id: f.org.id,
      item_id: id,
      task_id: uuid(),
      num,
      title: title(num),
      project_id: p.id,
      archived: false,
      search_text: `${title(num)}\n${DESCRIPTION}`,
      deleted_at,
      deleted_by: f.guest.id,
      item_project_id: p.id,
      item_parent_id: top,
    })
  })
  return id
}

/** What one page read, with its answer, Convex's counts as convex-test
 * keeps them, and the page's own (pageFor's spend). */
async function readPage(t: T, me: Profile, args: PageArgs) {
  return await as(t, me).query(async (ctx) => {
    const spend: PageSpend = {}
    const answer = await pageFor(ctx, new Map([[me.org_id, me]]), args, spend)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      page: answer,
      figures: {
        entries: answer.entries.length,
        hidden: answer.items.filter((r) => r.hidden === true).length,
        next: answer.next_cursor !== null,
        missing: answer.missing ?? null,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / 2 ** 20) * 100) / 100,
        page: spend,
      },
    }
  })
}

type Figures = Awaited<ReturnType<typeof readPage>>['figures']

/** Prints `figures` and checks them inside Convex's limits and the page's
 * `call`, `build` and `gather`. */
function record(what: string, figures: Figures): void {
  console.log(`deleted admin view figures, ${what}:`, JSON.stringify(figures))
  expect(figures.ranges).toBeLessThan(4096)
  expect(figures.documents).toBeLessThan(32_000)
  expect(figures.mib).toBeLessThan(16)
  for (const part of ['call', 'build', 'gather'] as const) {
    const spent = figures.page[part]
    expect(spent?.ranges ?? 0, part).toBeLessThan(DELETED_PAGE[part].ranges)
    expect(spent?.rows ?? 0, part).toBeLessThan(DELETED_PAGE[part].rows)
    expect(spent?.bytes ?? 0, part).toBeLessThan(DELETED_PAGE[part].bytes)
  }
}

describe('reads at the design size', () => {
  it('reads an admin page beside the catalogue of 2,000 projects with 25 task items the admin cannot read', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // with withOrg's two top-level projects and two sub-projects
    const live = Array.from({ length: 198 }, () => projectRow(f, { type: 'meta' }))
    const archived = Array.from({ length: 300 }, () =>
      projectRow(f, { type: 'meta', archived: true }),
    )
    const subs: ProjectRow[] = []
    for (let i = 0; i < 498; i++)
      subs.push(projectRow(f, { type: 'project', parent_id: live[i % live.length].id }))
    const rows = [...live, ...archived, ...subs]
    for (let i = 0; i < 1000; i++)
      rows.push(
        projectRow(f, {
          type: 'project',
          parent_id: archived[i % archived.length].id,
          archived: true,
        }),
      )
    await insertProjects(t, rows)
    for (let i = 0; i < 25; i++)
      await plantTaskItem(t, f, subs[i], subs[i].parent_id ?? '', START + i * 1000)
    const scope = { org_id: f.org.id, all: true as const }
    const browse = await readPage(t, f.admin, { scope })
    record('a catalogue of 2,000 projects, an admin browsing 25 hidden items', browse.figures)
    expect(browse.figures).toMatchObject({ entries: 25, hidden: 25, missing: null })
    const searched = await readPage(t, f.admin, { scope, search: 'calibrate' })
    record('the same, an admin searching a word every task holds', searched.figures)
    expect(searched.figures).toMatchObject({ entries: 0, next: false, missing: 'matches' })
  })

  it("reads an admin's project item of 30 live and 40 archived sub-projects through its stored rows, for an admin in 3 teams", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // two teams beside the fixture's, which also holds the admin
    const teams = await teamsOf(t, f, f.admin, 2)
    const root = projectRow(f, { type: 'meta' })
    const subs = [
      ...Array.from({ length: 30 }, () => projectRow(f, { type: 'project', parent_id: root.id })),
      ...Array.from({ length: 40 }, () =>
        projectRow(f, { type: 'project', parent_id: root.id, archived: true }),
      ),
    ]
    // each new team shares one live sub-project
    const shares = teams.map((team, i): [string, ProjectRow] => [team, subs[i]])
    // 26 open tasks in each live sub-project, 780 in the project, inside the
    // design size of 800 open tasks a project with all its sub-projects
    await plantProjectItem(t, f, { root, subs, perSub: 26, shares })
    const scope = { org_id: f.org.id, all: true as const }
    const browse = await readPage(t, f.admin, { scope })
    record('a project item of 70 sub-projects, an admin in 3 teams browsing', browse.figures)
    expect(browse.figures).toMatchObject({ entries: 1, hidden: 0, missing: null })
    const searched = await readPage(t, f.admin, { scope, search: 'calibrate' })
    record('the same, searching a word every task holds', searched.figures)
    // the 52 tasks of the two shared sub-projects count, wherever their
    // results fall among the ones the search reads, and no other task does
    expect(searched.figures.missing).toBe('matches')
    const shared = new Set(Array.from({ length: 2 * 26 }, (_, i) => title(i)))
    expect(searched.page.entries.length).toBeGreaterThan(0)
    for (const entry of searched.page.entries)
      expect(shared.has(entry.task?.title ?? '')).toBe(true)
  })

  it('reads an everyday project item of 3 sub-projects through its stored rows, for an admin in 5 teams', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // four teams beside the fixture's, which also holds the admin
    const teams = await teamsOf(t, f, f.admin, 4)
    const root = projectRow(f, { type: 'meta' })
    const subs = Array.from({ length: 3 }, () =>
      projectRow(f, { type: 'project', parent_id: root.id }),
    )
    const shares = teams.map((team, i): [string, ProjectRow] => [team, subs[i % 3]])
    await plantProjectItem(t, f, { root, subs, perSub: 30, shares })
    const scope = { org_id: f.org.id, all: true as const }
    const browse = await readPage(t, f.admin, { scope })
    record('an everyday project item, an admin in 5 teams browsing', browse.figures)
    expect(browse.figures).toMatchObject({ entries: 1, hidden: 0, missing: null })
    const searched = await readPage(t, f.admin, { scope, search: 'calibrate' })
    record('the same, searching a word every task holds', searched.figures)
    expect(searched.figures).toMatchObject({ entries: 25, next: true, missing: 'matches' })
  })
})
