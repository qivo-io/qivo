/* The Deleted items page (deletedItems.page, model/deletedItemsPage.ts):
 * its arguments and cursor, who sees what, the order and continuation, the
 * parts and scopes, the search, its stops, the assignee and deleter
 * filters, and the rows stored before the page's fields. Fake timers keep
 * steps from running until a test releases them, and DELETED_PAGE is
 * lowered where a test needs a stop. */
/// <reference types="vite/client" />

import type { FunctionArgs, WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { OrgRole } from '../lib/enums'
import { LIMITS } from '../lib/limits'
import { TRASH_BUDGET } from '../model/deletedItems'
import type { DeletedRow } from '../model/deletedItemsList'
import { DELETED_PAGE, type DeletedPage } from '../model/deletedItemsPage'
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
import { installTrashTimers, itemFor, START } from './trash.setup'

installTrashTimers()
const DEFAULT_PAGE = {
  ...DELETED_PAGE,
  call: { ...DELETED_PAGE.call },
  find: { ...DELETED_PAGE.find },
  gather: { ...DELETED_PAGE.gather },
}
afterEach(() => {
  Object.assign(DELETED_PAGE, DEFAULT_PAGE)
})

type PageArgs = FunctionArgs<typeof api.deletedItems.page>

const iso = (ms: number) => new Date(ms).toISOString()

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

const page = (t: T, who: Doc<'profiles'>, args: PageArgs = {}): Promise<DeletedPage> =>
  as(t, who).query(api.deletedItems.page, args)
const list = (t: T, who: Doc<'profiles'>) => as(t, who).query(api.deletedItems.list, {})
const deleteTask = (t: T, who: Doc<'profiles'>, id: string, extra: object = {}) =>
  as(t, who).mutation(api.issues.deleteDeep, { org_id: who.org_id, id, ...extra })
const deleteProject = (t: T, who: Doc<'profiles'>, id: string) =>
  as(t, who).mutation(api.projects.deleteDeep, { org_id: who.org_id, id })
/** Moves the clock on, so the next delete sorts after the last. */
const later = () => vi.setSystemTime(Date.now() + 60_000)

/** Every page for `who` and `args` from the first to the one whose
 * next_cursor is null, with their entries and rows in order. */
async function walk(t: T, who: Doc<'profiles'>, args: PageArgs = {}) {
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
  lead: Doc<'profiles'> | undefined,
  subs: { name: string; lead?: Doc<'profiles'>; key?: string }[],
  key?: string,
) {
  const top = await plantProject(t, {
    org_id: f.org.id,
    name,
    lead_id: lead?.id,
    ...(key === undefined ? {} : { key }),
  })
  const children: Doc<'projects'>[] = []
  for (const sub of subs)
    children.push(
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: top.id,
        name: sub.name,
        lead_id: sub.lead?.id,
        ...(sub.key === undefined ? {} : { key: sub.key }),
      }),
    )
  return { top, subs: children }
}

/** A ready task item of one task in sub-project `p` of the fixture's
 * top-level project, deleted by the guest, as a deleted_items row planted
 * without its stored rows. */
const plantedItem = (
  f: OrgFixture,
  p: Doc<'projects'>,
  fields: Partial<Doc<'deleted_items'>> = {},
) => ({
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
  projects: [{ id: p.id, name: p.name, key: p.key, type: p.type, tasks: 1, archived_tasks: 0 }],
  counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
  deleted_at: iso(START),
  deleted_by: f.guest.id,
  state: 'ready' as const,
  purge_after: START + 30 * 86_400_000,
  ...fields,
})

/** `count` items of plantedItem in Firmware, deleted a second apart, the
 * newest last, named `Item 0` and on. Their ids in that order. */
const plantItems = (t: T, f: OrgFixture, count: number, from = START) =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const item = plantedItem(f, f.sub, { name: `Item ${i}`, deleted_at: iso(from + i * 1000) })
      await ctx.db.insert('deleted_items', item)
      ids.push(item.id)
    }
    return ids
  })

/** Expects the page to give each of `people` exactly the items the list
 * gives them, each once, with the same rows: All projects of each
 * organization they hold a seat in, paged to the end. */
async function expectAsListed(t: T, people: Doc<'profiles'>[]) {
  const seats = await t.run((ctx) => ctx.db.query('profiles').collect())
  for (const who of people) {
    const listed = (await list(t, who)).items
    const orgs = seats
      .filter((s) => s.auth_user_id === who.auth_user_id && s.active)
      .map((s) => s.org_id)
    const ids: string[] = []
    const rows: DeletedRow[] = []
    for (const org_id of orgs) {
      const walked = await walk(t, who, { scope: { org_id, all: true } })
      ids.push(...walked.ids)
      rows.push(...walked.items)
    }
    expect(ids.length, who.name).toBe(new Set(ids).size)
    expect([...ids].sort(), who.name).toEqual(listed.map((r) => r.id).sort())
    for (const row of listed)
      expect(
        rows.find((r) => r.id === row.id),
        who.name,
      ).toEqual(row)
  }
}

describe('arguments', () => {
  it('refuses a limit, a scope, a search or a filter the page does not take', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    for (const limit of [0, 26, 1.5])
      await expectRefusal(
        page(t, f.admin, { limit }),
        'bad_request',
        /^limit must be a whole number from 1 to 25$/,
      )
    await expectRefusal(page(t, f.admin, { search: 'x'.repeat(201) }), 'rule', /200 characters/)
    expect(LIMITS.search.max).toBe(200)
    const ids = Array.from({ length: 51 }, () => uuid())
    for (const project_ids of [[], ids])
      await expectRefusal(
        page(t, f.admin, { scope: { org_id, project_ids } }),
        'bad_request',
        /^scope.project_ids must name 1 to 50 projects$/,
      )
    await expectRefusal(page(t, f.admin, { assignee: f.user.id }), 'bad_request', /^assignee/)
    await expectRefusal(
      page(t, f.admin, { scope: { org_id, all: true }, via: 'app' }),
      'bad_request',
      /^via needs deleted_by/,
    )
    // 50 ids, a repeated one counted once, are fine
    const fine = await page(t, f.admin, {
      scope: { org_id, project_ids: [...ids.slice(0, 49), f.sub.id, f.sub.id] },
    })
    expect(fine).toEqual({ entries: [], items: [], next_cursor: null })
  })

  it('refuses a cursor of other arguments, a changed one and one of another list', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await plantItems(t, f, 3)
    const args: PageArgs = { scope: { org_id, all: true }, limit: 1 }
    const first = await page(t, f.admin, args)
    const cursor = first.next_cursor
    if (cursor === null) throw new Error('no cursor')
    expect((await page(t, f.admin, { ...args, cursor })).entries).toHaveLength(1)
    // another page size is the same list
    expect((await page(t, f.admin, { ...args, cursor, limit: 2 })).entries).toHaveLength(2)
    const others: PageArgs[] = [
      { scope: { org_id, project_ids: [f.sub.id] } },
      { scope: { org_id, all: true }, kind: 'task' },
      { scope: { org_id, all: true }, search: 'waiting' },
      { scope: { org_id, all: true }, deleted_by: f.guest.id },
      { scope: { org_id, all: true }, assignee: f.user.id },
      {},
    ]
    for (const other of others)
      await expectRefusal(
        page(t, f.admin, { ...other, cursor }),
        'bad_request',
        /^cursor must be the next_cursor of an earlier page$/,
      )
    const last = cursor.at(-1) === '0' ? '1' : '0'
    const changed = `${cursor.slice(0, -1)}${last}`
    await expectRefusal(page(t, f.admin, { ...args, cursor: changed }), 'bad_request')
    // an Archived tasks cursor
    for (let i = 0; i < 2; i++)
      await plantIssue(t, { org_id, project_id: f.sub.id, archived_at: iso(START + i) })
    const archived = await as(t, f.admin).query(api.issues.archivedPage, {
      scope: { org_id, project_ids: [f.sub.id] },
      limit: 1,
    })
    expect(archived.next_cursor).not.toBeNull()
    await expectRefusal(
      page(t, f.admin, { ...args, cursor: archived.next_cursor ?? '' }),
      'bad_request',
    )
  })
})

describe('who sees what', () => {
  it('gives each caller exactly the items the list gives them, each once, with the same rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const sam = await person(t, org_id, 'Sam')
    const lena = await person(t, org_id, 'Lena')
    const tia = await person(t, org_id, 'Tia')
    const omar = await person(t, org_id, 'Omar')
    const dana = await person(t, org_id, 'Dana')
    const other = await person(t, org_id, 'Other')
    // own deletes, and one in a project with a lead of its own
    await patch(t, 'projects', f.sub.id, { lead_id: sam.id })
    const mine = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Mine' })
    const theirs = await plantIssue(t, { org_id, project_id: f.sub2.id, title: 'Theirs' })
    await deleteTask(t, f.guest, mine.id)
    later()
    await deleteTask(t, f.user, theirs.id)
    later()
    // a project item a lead's stored rows name, with a sub-project lead and a member
    const trial = await tree(t, f, 'Field trial', lena, [
      { name: 'Site', lead: sam },
      { name: 'Lab' },
    ])
    await grant(t, trial.subs[1].id, tia.id, 'user')
    await plantIssue(t, { org_id, project_id: trial.subs[0].id, title: 'Dig the trench' })
    await plantIssue(t, { org_id, project_id: trial.subs[1].id, title: 'Seal the samples' })
    await deleteProject(t, lena, trial.top.id)
    later()
    // a redacted task item for the lead of the subtask's project
    const ops = await tree(t, f, 'Operations', omar, [{ name: 'Infra' }])
    await tree(t, f, 'Elsewhere', other, [{ name: 'Over there' }])
    await grant(t, f.meta.id, dana.id, 'user')
    await grant(t, ops.top.id, dana.id, 'user')
    const root = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Contoso diligence' })
    const sub = await plantIssue(t, {
      org_id,
      project_id: ops.subs[0].id,
      parent_id: root.id,
      title: 'Provision the data room',
    })
    await deleteTask(t, dana, root.id, { subtask_ids: [sub.id] })
    later()
    // a deleted sub-project of a live top-level project
    await plantIssue(t, { org_id, project_id: f.sub2.id, title: 'Board task' })
    await deleteProject(t, f.user, f.sub2.id)
    later()
    // the admin of Testbed is a guest in Other, and Other has a guest of its own
    const pilot = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
      name: 'Pilot',
    })
    const away = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'admin',
      org_role: 'guest',
      auth_user_id: f.admin.auth_user_id,
    })
    const gus = await person(t, f.otherOrg.id, 'Gus', 'guest')
    await grant(t, pilot.id, away.id, 'user')
    await grant(t, pilot.id, gus.id, 'user')
    for (const who of [away, gus, f.otherAdmin]) {
      const task = await plantIssue(t, { org_id: f.otherOrg.id, project_id: pilot.id })
      await deleteTask(t, who, task.id)
      later()
    }

    const people = [f.admin, f.user, f.viewer, f.guest, sam, lena, tia, omar, dana, other, gus]
    await expectAsListed(t, [...people, f.otherAdmin])
    // the redacted row shows the subtask, not the root
    const omars = await walk(t, omar, { scope: { org_id, all: true } })
    expect(omars.items).toEqual([expect.objectContaining({ redacted: true })])
    expect(JSON.stringify(omars)).not.toContain('Contoso')
  })

  it("keeps the list's answer for view-only deleters, lost access, deleted projects, stuck and moving items", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const omar = await person(t, org_id, 'Omar')
    const ops = await tree(t, f, 'Operations', omar, [{ name: 'Infra' }])
    await grant(t, ops.top.id, f.guest.id, 'user')
    // the guest's delete, then the guest can only view the project
    const viewOnly = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f.guest, viewOnly.id)
    later()
    // a task item whose project goes to Deleted items afterwards
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    const subtask = await plantIssue(t, {
      org_id,
      project_id: ops.subs[0].id,
      parent_id: task.id,
    })
    await deleteTask(t, f.guest, task.id, { subtask_ids: [subtask.id] })
    later()
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (row !== null) await ctx.db.patch(row._id, { level: 'viewer' })
    })
    await expectAsListed(t, [f.admin, f.user, f.guest, omar])
    // a moving item, then the top-level project in Deleted items, stuck
    for (let i = 0; i < 4; i++) await plantIssue(t, { org_id, project_id: ops.subs[0].id })
    Object.assign(TRASH_BUDGET, { rows: 2 })
    await deleteProject(t, omar, ops.subs[0].id)
    later()
    await expectAsListed(t, [f.admin, f.user, f.guest, omar])
    Object.assign(TRASH_BUDGET, { rows: 300 })
    await deleteProject(t, f.user, f.meta.id)
    await patch(t, 'deleted_items', (await itemFor(t, f.meta.id)).id, { state: 'stuck' })
    await expectAsListed(t, [f.admin, f.user, f.guest, omar, f.viewer])
  })

  it('answers unknown, foreign, hidden and deleted project ids alike, and an organization without a seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const gone = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const task = await plantIssue(t, { org_id, project_id: gone.id })
    await deleteTask(t, f.user, task.id)
    later()
    await deleteProject(t, f.user, gone.id)
    const empty = { entries: [], items: [], next_cursor: null }
    // the guest sees neither Skunkworks nor the other organization's project
    for (const id of [uuid(), f.otherProject.id, f.hidden.id, gone.id])
      for (const args of [{}, { search: 'planted' }, { assignee: f.guest.id }])
        expect(await page(t, f.guest, { scope: { org_id, project_ids: [id] }, ...args })).toEqual(
          empty,
        )
    for (const scope of [
      { org_id: f.otherOrg.id, all: true as const },
      { org_id: uuid(), project_ids: [f.otherProject.id] },
    ])
      expect(await page(t, f.guest, { scope })).toEqual(empty)
    // the admin sees the deleted sub-project only as an entry of its parent
    const parent = await page(t, f.admin, { scope: { org_id, project_ids: [f.meta.id] } })
    expect(parent.entries.map((e) => e.item_id)).toContain((await itemFor(t, gone.id)).id)
  })
})

describe('order and continuation', () => {
  it('pages 60 items at 25 a page, newest first, and ends with no cursor', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await plantItems(t, f, 60)
    const walked = await walk(t, f.admin, { scope: { org_id: f.org.id, all: true } })
    expect(walked.pages.map((p) => p.entries.length)).toEqual([25, 25, 10])
    expect(walked.ids).toEqual([...ids].reverse())
    expect(walked.pages.at(-1)?.next_cursor).toBeNull()
  })

  it('keeps the index order of items deleted at the same moment, whatever their ids', async () => {
    const t = newT()
    const f = await withOrg(t)
    // uuids in the opposite order of their creation, then another order
    const ids = [
      'ffffffff-0000-4000-8000-000000000000',
      'aaaaaaaa-0000-4000-8000-000000000000',
      'cccccccc-0000-4000-8000-000000000000',
    ]
    for (const [i, id] of ids.entries()) {
      vi.setSystemTime(START + 1000 * (i + 1))
      await t.run((ctx) => ctx.db.insert('deleted_items', plantedItem(f, f.sub, { id })))
    }
    for (const limit of [1, 2, 25]) {
      const walked = await walk(t, f.admin, { scope: { org_id: f.org.id, all: true }, limit })
      // newest created first, as the index orders them
      expect(walked.ids).toEqual([ids[2], ids[1], ids[0]])
    }
  })

  it('lands an item deleted between pages before the cursor, and skips nothing that leaves between pages', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = { scope: { org_id: f.org.id, all: true as const }, limit: 2 }
    const ids = await plantItems(t, f, 5)
    const first = await page(t, f.admin, args)
    expect(first.entries.map((e) => e.item_id)).toEqual([ids[4], ids[3]])
    const [newer] = await plantItems(t, f, 1, START + 60_000)
    // the next item leaves, as a restore or a purge takes it
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'deleted_items', ids[2])
      if (row !== null) await ctx.db.delete(row._id)
    })
    const second = await page(t, f.admin, { ...args, cursor: first.next_cursor ?? '' })
    expect(second.entries.map((e) => e.item_id)).toEqual([ids[1], ids[0]])
    const third = await page(t, f.admin, { ...args, cursor: second.next_cursor ?? '' })
    expect(third).toMatchObject({ entries: [], next_cursor: null })
    expect((await page(t, f.admin, args)).entries.map((e) => e.item_id)).toEqual([newer, ids[4]])
  })

  it("opens each of a member's sources as one range on a later page, as on the first", async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await plantItems(t, f, 3)
    // the user's own deletes, Testbed platform and Skunkworks, and the
    // cross-project rows of Firmware and Board rev: five ranges a page
    Object.assign(DELETED_PAGE, { find: { bytes: 1 << 30, rows: 1e6, ranges: 6 } })
    const walked = await walk(t, f.user, {
      scope: { org_id: f.org.id, all: true },
      kind: 'task',
      limit: 1,
    })
    expect(walked.ids).toEqual([...ids].reverse())
    expect(walked.pages.map((p) => p.missing ?? null)).toEqual([null, null, null, null])
  })
})

describe('parts and scopes', () => {
  it('lists only project entries without a scope, and says task entries need one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f.user, task.id)
    later()
    await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteProject(t, f.user, f.sub2.id)
    const projectItem = await itemFor(t, f.sub2.id)

    const bare = await page(t, f.user)
    expect(bare.entries).toEqual([{ item_id: projectItem.id }])
    expect(bare.scope_needed).toBe(true)
    expect(bare.items.map((r) => r.id)).toEqual([projectItem.id])
    expect((await page(t, f.user, { kind: 'project' })).scope_needed).toBeUndefined()
    expect(await page(t, f.user, { kind: 'task' })).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
      scope_needed: true,
    })
    const all = await page(t, f.user, { scope: { org_id, all: true } })
    expect(all.entries.map((e) => e.item_id)).toEqual([
      projectItem.id,
      (await itemFor(t, task.id)).id,
    ])
    expect(all.scope_needed).toBeUndefined()
    const tasks = await page(t, f.user, { scope: { org_id, all: true }, kind: 'task' })
    expect(tasks.entries.map((e) => e.item_id)).toEqual([(await itemFor(t, task.id)).id])
  })

  it("holds a top-level project's deleted sub-projects, then the task items of its sub-projects of any state and its cross-project items", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const away = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    const archived = await plantProject(t, {
      org_id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const leaving = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const inSub = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f.user, inSub.id)
    later()
    // rooted under another top-level project, with a subtask in Firmware
    const crossRoot = await plantIssue(t, { org_id, project_id: away.id })
    const crossSub = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: crossRoot.id })
    await deleteTask(t, f.user, crossRoot.id, { subtask_ids: [crossSub.id] })
    later()
    const outside = await plantIssue(t, { org_id, project_id: away.id })
    await deleteTask(t, f.user, outside.id)
    later()
    const leavingTask = await plantIssue(t, { org_id, project_id: leaving.id })
    await deleteTask(t, f.user, leavingTask.id)
    later()
    await deleteProject(t, f.user, leaving.id)
    later()
    const inArchived = plantedItem(f, archived, { deleted_at: iso(Date.now()) })
    await t.run((ctx) => ctx.db.insert('deleted_items', inArchived))
    const id = async (target: string) => (await itemFor(t, target)).id

    const top = await page(t, f.admin, { scope: { org_id, project_ids: [f.meta.id] } })
    expect(top.entries.map((e) => e.item_id)).toEqual([
      await id(leaving.id),
      inArchived.id,
      await id(leavingTask.id),
      await id(crossRoot.id),
      await id(inSub.id),
    ])
    // the lead of the top-level project reads the same, but for the item
    // whose project left, which waits for an admin
    const lead = await page(t, f.user, { scope: { org_id, project_ids: [f.meta.id] } })
    expect(lead.entries.map((e) => e.item_id)).toEqual([
      await id(leaving.id),
      inArchived.id,
      await id(crossRoot.id),
      await id(inSub.id),
    ])
    // a sub-project holds no project entry, and its own and cross-project items
    const sub = await page(t, f.user, { scope: { org_id, project_ids: [f.sub.id] } })
    expect(sub.entries.map((e) => e.item_id)).toEqual([await id(crossRoot.id), await id(inSub.id)])
    const there = await page(t, f.user, { scope: { org_id, project_ids: [away.id] } })
    expect(there.entries.map((e) => e.item_id)).toEqual([
      await id(outside.id),
      await id(crossRoot.id),
    ])
    const both = await page(t, f.user, {
      scope: { org_id, project_ids: [f.sub.id, away.id] },
      kind: 'task',
    })
    expect(both.entries.map((e) => e.item_id)).toEqual([
      await id(outside.id),
      await id(crossRoot.id),
      await id(inSub.id),
    ])
  })
})

describe('search', () => {
  it('matches every word in a title or description, the last also as a prefix, with accents exact', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const tasks = [
      { title: 'Calibrate the torque sensor', description: 'Use the blue fixture' },
      { title: 'Torque wrench', description: 'Café calibration notes' },
      { title: 'Sensor housing', description: '' },
    ]
    const ids: string[] = []
    for (const task of tasks) {
      const planted = await plantIssue(t, { org_id, project_id: f.sub.id, ...task })
      await deleteTask(t, f.user, planted.id)
      ids.unshift((await itemFor(t, planted.id)).id)
      later()
    }
    const [housing, wrench, calibrate] = ids
    const found = async (search: string) =>
      (await page(t, f.admin, { scope: { org_id, all: true }, search })).entries.map(
        (e) => e.item_id,
      )
    expect(await found('torque sensor')).toEqual([calibrate])
    expect(await found('sensor torque')).toEqual([calibrate])
    expect(await found('torq')).toEqual([wrench, calibrate])
    expect(await found('torque sens')).toEqual([calibrate])
    // only the last word matches as a prefix
    expect(await found('torq sens')).toEqual([])
    expect(await found('blue fixture')).toEqual([calibrate])
    expect(await found('housing torque')).toEqual([])
    expect(await found('cafe')).toEqual([])
    expect(await found('café')).toEqual([wrench])
    expect(await found('sensor')).toEqual([housing, calibrate])
    // punctuation alone is no word to match
    expect(await page(t, f.admin, { scope: { org_id, all: true }, search: '--' })).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
    })
  })

  it('finds a task by its key in every seat without a scope, where every other word must match it too', async () => {
    const t = newT()
    const f = await withOrg(t)
    const relay = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Wire the relay',
    })
    await deleteTask(t, f.user, relay.id)
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
    const there = await plantIssue(t, { org_id: f.otherOrg.id, project_id: pilot.id })
    await deleteTask(t, away, there.id)
    const relayItem = (await itemFor(t, relay.id)).id
    const thereItem = (await itemFor(t, there.id)).id

    for (const search of [`QN-${relay.num}`, `${relay.num}`, `qn-${relay.num} relay`]) {
      const found = await page(t, f.admin, { search })
      expect(found.entries, search).toEqual([{ item_id: relayItem }])
      expect(found.scope_needed).toBe(true)
    }
    expect((await page(t, f.admin, { search: `QN-${relay.num} valve` })).entries).toEqual([])
    expect((await page(t, f.admin, { search: `QN-${there.num}` })).entries).toEqual([
      { item_id: thereItem },
    ])
    // a title word needs a scope
    expect((await page(t, f.admin, { search: 'relay' })).entries).toEqual([])
    expect(
      (await page(t, f.admin, { search: 'relay', scope: { org_id: f.org.id, all: true } })).entries,
    ).toEqual([{ item_id: relayItem }])
  })

  it('finds a project entry by its names and keys, and the tasks inside it only with a scope', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const trial = await tree(
      t,
      f,
      'Field trial',
      f.user,
      [{ name: 'Lab', key: 'LAB' }, { name: 'Site' }],
      'FTRL',
    )
    await plantIssue(t, { org_id, project_id: trial.subs[0].id, title: 'Seal the samples' })
    await deleteProject(t, f.user, trial.top.id)
    const item = (await itemFor(t, trial.top.id)).id
    for (const search of ['field', 'FTRL', 'lab', 'LAB', 'trial site'])
      expect((await page(t, f.user, { search })).entries, search).toEqual([{ item_id: item }])
    expect((await page(t, f.user, { search: 'samples' })).entries).toEqual([])
    const inside = await page(t, f.user, { search: 'samples', scope: { org_id, all: true } })
    expect(inside.entries).toEqual([
      {
        item_id: item,
        task: expect.objectContaining({ title: 'Seal the samples', path: ['Field trial', 'Lab'] }),
      },
    ])
    expect(inside.items.map((r) => r.id)).toEqual([item])
  })

  it('counts a task item once with its first matching subtask, and each task of a project item once with one row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Overhaul' })
    const subs: Doc<'issues'>[] = []
    for (const title of ['Pump seal', 'Pump bearing', 'Pump housing'])
      subs.push(await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id, title }))
    await deleteTask(t, f.user, root.id, { subtask_ids: subs.map((s) => s.id) })
    later()
    const valves: Doc<'issues'>[] = []
    for (const title of ['Board pump valve A', 'Board pump valve B', 'Board pump valve C'])
      valves.push(await plantIssue(t, { org_id, project_id: f.sub2.id, title }))
    await deleteProject(t, f.user, f.sub2.id)
    const taskItem = await itemFor(t, root.id)
    const projectItem = await itemFor(t, f.sub2.id)

    const pump = await page(t, f.user, { scope: { org_id, all: true }, search: 'pump' })
    expect(pump.entries).toEqual([
      ...valves.map((v) => ({
        item_id: projectItem.id,
        task: {
          key: `QN-${v.num}`,
          title: v.title,
          archived: false,
          path: ['Testbed platform', 'Board rev'],
        },
      })),
      {
        item_id: taskItem.id,
        task: {
          key: `QN-${subs[0].num}`,
          title: 'Pump seal',
          root_key: `QN-${root.num}`,
          root_title: 'Overhaul',
          archived: false,
          path: ['Testbed platform', 'Firmware'],
        },
      },
    ])
    expect(pump.items.map((r) => r.id)).toEqual([projectItem.id, taskItem.id])
    // the root matching too: its row shows it already
    expect(
      (await page(t, f.user, { scope: { org_id, all: true }, search: 'overhaul' })).entries,
    ).toEqual([{ item_id: taskItem.id }])
    // the project entry first, then its tasks, one row for both
    const board = await page(t, f.user, { scope: { org_id, all: true }, search: 'board' })
    expect(board.entries.map((e) => [e.item_id, e.task?.title])).toEqual([
      [projectItem.id, undefined],
      ...valves.map((v) => [projectItem.id, v.title]),
    ])
    expect(board.items.map((r) => r.id)).toEqual([projectItem.id])
    // paged one entry at a time, the same entries in the same order
    const walked = await walk(t, f.user, { scope: { org_id, all: true }, search: 'pump', limit: 1 })
    expect(walked.entries).toEqual(pump.entries)
  })

  it("never names a redacted item's root in a hit", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const omar = await person(t, org_id, 'Omar')
    const dana = await person(t, org_id, 'Dana')
    const ops = await tree(t, f, 'Operations', omar, [{ name: 'Infra' }])
    await grant(t, f.meta.id, dana.id, 'user')
    await grant(t, ops.top.id, dana.id, 'user')
    const root = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      title: 'Contoso acquisition due diligence',
      description: 'Data room checklist',
    })
    const shown = await plantIssue(t, {
      org_id,
      project_id: ops.subs[0].id,
      parent_id: root.id,
      title: 'Provision the racks',
    })
    const hidden = await plantIssue(t, {
      org_id,
      project_id: ops.subs[0].id,
      parent_id: root.id,
      title: 'Data room keys',
    })
    await deleteTask(t, dana, root.id, { subtask_ids: [shown.id, hidden.id] })
    const item = await itemFor(t, root.id)

    const found = await page(t, omar, { scope: { org_id, all: true }, search: 'data room' })
    expect(found.entries).toEqual([
      {
        item_id: item.id,
        task: {
          key: `QN-${hidden.num}`,
          title: 'Data room keys',
          archived: false,
          path: [],
          redacted: true,
        },
      },
    ])
    expect(found.items).toEqual([expect.objectContaining({ redacted: true })])
    expect(JSON.stringify(found)).not.toContain('Contoso')
    // the root's words find nothing for the lead who cannot see it
    expect(
      (await page(t, omar, { scope: { org_id, all: true }, search: 'contoso' })).entries,
    ).toEqual([])
  })
})

describe('stops', () => {
  it("finds a member's own match beside more of other people's matches than the lowered candidates, and always says matches may be missing", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // other people's deletes in the same projects, each with the word twice
    for (let i = 0; i < 5; i++) {
      const task = await plantIssue(t, {
        org_id,
        project_id: f.sub.id,
        title: `Valve valve ${i}`,
      })
      await deleteTask(t, f.user, task.id)
      later()
    }
    const own = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Gasket for the valve' })
    await deleteTask(t, f.guest, own.id)
    Object.assign(DELETED_PAGE, { candidates: 2, results: 4 })
    const found = await page(t, f.guest, { scope: { org_id, all: true }, search: 'valve' })
    expect(found.entries).toEqual([{ item_id: (await itemFor(t, own.id)).id }])
    expect(found.missing).toBe('matches')
    // with nothing to find, the note stays the same
    const none = await page(t, f.guest, { scope: { org_id, all: true }, search: 'zebra' })
    expect(none).toMatchObject({ entries: [], missing: 'matches' })
    // the lead of the project reads more matches than its allowance
    const lead = await page(t, f.user, { scope: { org_id, all: true }, search: 'valve' })
    expect(lead.missing).toBe('matches')
  })

  it("says an admin's search may miss matches when a source read its allowance, or reads when its room ran out", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    for (let i = 0; i < 3; i++) {
      const task = await plantIssue(t, { org_id, project_id: f.sub.id, title: `Relay ${i}` })
      await deleteTask(t, f.user, task.id)
      later()
    }
    const args = { scope: { org_id, all: true as const }, search: 'relay' }
    const whole = await page(t, f.admin, args)
    expect(whole.entries).toHaveLength(3)
    expect(whole.missing).toBeUndefined()
    Object.assign(DELETED_PAGE, { candidates: 2 })
    const capped = await page(t, f.admin, args)
    expect(capped.missing).toBe('matches')
    expect(capped.entries).toHaveLength(2)
    // with no older row in the organization the one query takes all of
    // results, as no title source for older rows shares it
    Object.assign(DELETED_PAGE, { candidates: 256, results: 4 })
    const shared = await page(t, f.admin, args)
    expect(shared.entries).toHaveLength(3)
    expect(shared.missing).toBeUndefined()
    Object.assign(DELETED_PAGE, { results: DEFAULT_PAGE.results })

    // a task item whose root and two subtasks hold the word: the query's
    // range, a range for each result and the item's read, so a gathering
    // with 4 ranges stops at its second result, while one with 8 does not
    const root = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Solenoid bank' })
    const subs: Doc<'issues'>[] = []
    for (const title of ['Solenoid coil', 'Solenoid spring'])
      subs.push(await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id, title }))
    await deleteTask(t, f.user, root.id, { subtask_ids: subs.map((s) => s.id) })
    const item = (await itemFor(t, root.id)).id
    const tasks = { scope: { org_id, all: true as const }, kind: 'task' as const }
    const solenoid = { ...tasks, search: 'solenoid' }
    Object.assign(DELETED_PAGE, { gather: { ...DEFAULT_PAGE.gather, ranges: 8 } })
    const roomy = await page(t, f.admin, solenoid)
    expect(roomy.entries.map((e) => e.item_id)).toEqual([item])
    expect(roomy.missing).toBeUndefined()
    Object.assign(DELETED_PAGE, { gather: { ...DEFAULT_PAGE.gather, ranges: 4 } })
    const cut = await page(t, f.admin, solenoid)
    expect(cut.entries.map((e) => e.item_id)).toEqual([item])
    expect(cut.missing).toBe('reads')
  })

  it('ends a browse page early on a lowered budget, and pages on to the end with no entry twice', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids = await plantItems(t, f, 12)
    const args = { scope: { org_id: f.org.id, all: true as const } }
    // the reads that find items may read four documents: the first page
    // reads the first item of its range and three more after it, then
    // stops; a later page reads its cursor's item again first
    Object.assign(DELETED_PAGE, { find: { bytes: 1 << 30, rows: 4, ranges: 1e6 } })
    const walked = await walk(t, f.admin, args)
    expect(walked.ids).toEqual([...ids].reverse())
    expect(walked.pages[0].entries).toHaveLength(3)
    expect(walked.pages.length).toBeGreaterThan(4)
    for (const p of walked.pages.slice(0, -1)) {
      expect(p.entries.length).toBeLessThan(4)
      expect(p.next_cursor).not.toBeNull()
    }
    expect(walked.pages.every((p) => p.missing === undefined)).toBe(true)
    // a page whose sight spends the call reads no item, and says so
    Object.assign(DELETED_PAGE, { call: { bytes: 1 << 30, rows: 1, ranges: 1e6 } })
    expect(await page(t, f.admin, args)).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
      missing: 'reads',
    })
  })

  it('answers too_wide past the lowered sources for anyone but an admin, whose page reads the organization instead', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const inHidden = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    const a = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Spring' })
    const b = await plantIssue(t, { org_id, project_id: inHidden.id, title: 'Spring' })
    await deleteTask(t, f.guest, a.id)
    later()
    await deleteTask(t, f.user, b.id)
    const items = [(await itemFor(t, b.id)).id, (await itemFor(t, a.id)).id]
    const scope = { org_id, project_ids: [f.meta.id, f.hidden.id] }
    // the user's own deletes and the two top-level projects they lead
    Object.assign(DELETED_PAGE, { sources: 2 })
    expect(await page(t, f.user, { scope })).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
      too_wide: true,
    })
    expect(await page(t, f.user, { scope, assignee: f.user.id })).toMatchObject({ too_wide: true })
    // without a scope the same project ranges are too wide, and task
    // entries still need a scope
    expect(await page(t, f.user)).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
      too_wide: true,
      scope_needed: true,
    })
    expect(await page(t, f.user, { kind: 'project' })).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
      too_wide: true,
    })
    expect((await page(t, f.admin, { scope })).entries.map((e) => e.item_id)).toEqual(items)
    Object.assign(DELETED_PAGE, { sources: 1 })
    expect((await page(t, f.admin, { scope })).entries.map((e) => e.item_id)).toEqual(items)
    // a search past the lowered searches reads the whole organization
    Object.assign(DELETED_PAGE, { sources: 256, searches: 1 })
    const found = await page(t, f.user, { scope, search: 'spring' })
    expect(found.entries.map((e) => e.item_id)).toEqual(items)
    expect(found.missing).toBe('matches')
    expect(found.too_wide).toBeUndefined()
  })

  it('counts each sub-project a member leads without its top-level project toward the lowered sources', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // Sam leads both sub-projects of a top-level project the user leads
    const sam = await person(t, org_id, 'Sam')
    await patch(t, 'projects', f.sub.id, { lead_id: sam.id })
    await patch(t, 'projects', f.sub2.id, { lead_id: sam.id })
    const a = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Clamp' })
    const b = await plantIssue(t, { org_id, project_id: f.sub2.id, title: 'Bracket' })
    await deleteTask(t, f.user, a.id)
    later()
    await deleteTask(t, f.user, b.id)
    const items = [(await itemFor(t, b.id)).id, (await itemFor(t, a.id)).id]
    const all = { org_id, all: true as const }
    // Sam's own deletes and a range for each sub-project: three
    Object.assign(DELETED_PAGE, { sources: 3 })
    expect((await page(t, sam, { scope: all })).entries.map((e) => e.item_id)).toEqual(items)
    Object.assign(DELETED_PAGE, { sources: 2 })
    expect(await page(t, sam, { scope: all })).toEqual({
      entries: [],
      items: [],
      next_cursor: null,
      too_wide: true,
    })
    // the project entries need only Sam's own deletes, and one sub-project fits
    expect((await page(t, sam, { scope: all, kind: 'project' })).too_wide).toBeUndefined()
    const one = await page(t, sam, { scope: { org_id, project_ids: [f.sub.id] } })
    expect(one.entries.map((e) => e.item_id)).toEqual([items[1]])
    expect(one.too_wide).toBeUndefined()
  })
})

describe('the assignee filter', () => {
  /** Sam's tasks: a task item's root, another's subtask, and two tasks of
   * a project item, beside tasks of someone else. */
  async function assigned(t: T, f: OrgFixture) {
    const org_id = f.org.id
    const sam = await person(t, org_id, 'Sam')
    const rex = await person(t, org_id, 'Rex')
    const byRoot = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      title: 'Rewire the bench',
      assignee_id: sam.id,
    })
    const bySub = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Shelf' })
    const subtask = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      parent_id: bySub.id,
      title: 'Bolt the shelf',
      assignee_id: sam.id,
    })
    const elsewhere = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      title: 'Not his',
      assignee_id: rex.id,
    })
    await deleteTask(t, f.user, byRoot.id)
    later()
    await deleteTask(t, f.user, bySub.id, { subtask_ids: [subtask.id] })
    later()
    await deleteTask(t, f.user, elsewhere.id)
    later()
    const leaving = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const inProject: Doc<'issues'>[] = []
    for (const assignee of [sam, rex, sam])
      inProject.push(
        await plantIssue(t, { org_id, project_id: leaving.id, assignee_id: assignee.id }),
      )
    await deleteProject(t, f.user, leaving.id)
    return { sam, rex, byRoot, bySub, subtask, leaving, inProject }
  }

  /** The entries of `who`'s pages, each as its item and the key of its task. */
  const keysOf = async (t: T, who: Doc<'profiles'>, args: PageArgs) =>
    (await walk(t, who, args)).entries.map((e) => [e.item_id, e.task?.key ?? null])

  it("gives the same entries on an admin's index and a lead's scan, a task item once and each task of a project item", async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await assigned(t, f)
    const id = async (target: string) => (await itemFor(t, target)).id
    const args = { scope: { org_id: f.org.id, all: true as const }, assignee: a.sam.id }
    const expected = [
      [await id(a.leaving.id), `QN-${a.inProject[0].num}`],
      [await id(a.leaving.id), `QN-${a.inProject[2].num}`],
      [await id(a.bySub.id), `QN-${a.subtask.num}`],
      [await id(a.byRoot.id), null],
    ]
    for (const limit of [25, 1]) {
      const admin = await keysOf(t, f.admin, { ...args, limit })
      const lead = await keysOf(t, f.user, { ...args, limit })
      expect(lead).toEqual(expected)
      // the admin's index orders a project item's tasks by when they were
      // stored, the same set
      expect([...admin].sort()).toEqual([...expected].sort())
    }
    // no project entry while the filter is set, and someone else's tasks only for them
    expect(await keysOf(t, f.admin, { ...args, kind: 'project' })).toEqual([])
    expect(await keysOf(t, f.admin, { ...args, assignee: a.rex.id })).toHaveLength(2)
  })

  it("shows a task item once on the admin's index however its assigned tasks fall across pages", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const sam = await person(t, org_id, 'Sam')
    const root = await plantIssue(t, { org_id, project_id: f.sub.id, assignee_id: sam.id })
    const subs: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++)
      subs.push(
        await plantIssue(t, {
          org_id,
          project_id: f.sub.id,
          parent_id: root.id,
          assignee_id: sam.id,
        }),
      )
    await deleteTask(t, f.user, root.id, { subtask_ids: subs.map((s) => s.id) })
    const args = { scope: { org_id, all: true as const }, assignee: sam.id, limit: 1 }
    const walked = await walk(t, f.admin, args)
    expect(walked.ids).toEqual([(await itemFor(t, root.id)).id])
    // the root is assigned, so the row shows the hit
    expect(walked.entries[0].task).toBeUndefined()
  })

  it("leaves out a task in a project hidden from the lead, and a seat that reuses a removed person's id", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const sam = await person(t, org_id, 'Sam')
    const ana = await person(t, org_id, 'Ana')
    await patch(t, 'projects', f.sub.id, { lead_id: sam.id })
    const root = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Front panel' })
    const hidden = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: root.id,
      title: 'Back panel',
      assignee_id: ana.id,
    })
    await deleteTask(t, f.user, root.id, { subtask_ids: [hidden.id] })
    const item = (await itemFor(t, root.id)).id
    const args = { scope: { org_id, all: true as const }, assignee: ana.id }
    // Sam leads Firmware and sees the item, but not Board rev, where Ana's task is
    expect((await page(t, sam, { scope: { org_id, all: true } })).entries).toEqual([
      { item_id: item },
    ])
    expect((await page(t, sam, args)).entries).toEqual([])
    expect((await page(t, sam, { ...args, search: 'panel' })).entries).toEqual([])
    // the root matches for Sam without the filter, the hidden subtask never
    const scope = { org_id, all: true as const }
    expect((await page(t, sam, { scope, search: 'panel' })).entries).toEqual([{ item_id: item }])
    expect((await page(t, sam, { scope, search: 'back' })).entries).toEqual([])
    expect((await page(t, f.user, args)).entries).toEqual([
      { item_id: item, task: expect.objectContaining({ title: 'Back panel' }) },
    ])
    // Ana is removed and a later seat takes her id
    later()
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'profiles', ana.id)
      if (row === null) throw new Error('no profile')
      await ctx.db.delete(row._id)
      const { _id, _creationTime, ...seat } = row
      await ctx.db.insert('profiles', { ...seat, created_at: iso(Date.now()) })
    })
    for (const who of [f.user, f.admin])
      for (const extra of [{}, { search: 'panel' }])
        expect((await page(t, who, { ...args, ...extra })).entries, who.name).toEqual([])
  })
})

describe('deleted by', () => {
  it("reaches a person's older deletes for an admin, filters anyone else's own ranges, and matches via only as the caller may know it", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const token = { table: 'mcp_tokens' as const, id: uuid(), name: 'Laptop' }
    const key = { table: 'agent_keys' as const, id: uuid(), name: 'Relay key' }
    const guestItems = await t.run(async (ctx) => {
      const out: Record<string, string> = {}
      for (const [name, via] of [
        ['app', undefined],
        ['token', token],
        ['key', key],
      ] as const) {
        const item = plantedItem(f, f.sub, { name, deleted_at: iso(START - 1000), via })
        await ctx.db.insert('deleted_items', item)
        out[name] = item.id
      }
      return out
    })
    // 30 newer deletes of someone else
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++)
        await ctx.db.insert(
          'deleted_items',
          plantedItem(f, f.sub, { deleted_by: f.user.id, deleted_at: iso(START + i) }),
        )
    })
    const scope = { org_id, all: true as const }
    const ids = async (who: Doc<'profiles'>, extra: Partial<PageArgs>) =>
      (await page(t, who, { scope, deleted_by: f.guest.id, ...extra })).entries
        .map((e) => e.item_id)
        .sort()
    const all = Object.values(guestItems).sort()
    expect(await ids(f.admin, {})).toEqual(all)
    // the lead of the project sees them through the project's range
    expect(await ids(f.user, {})).toEqual(all)
    expect(await ids(f.user, { deleted_by: f.user.id })).toHaveLength(25)
    expect(await ids(f.admin, { via: 'app' })).toEqual([guestItems.app])
    // an admin knows which token, the lead only that it was a token
    expect(await ids(f.admin, { via: `mcp_tokens:${token.id}` })).toEqual([guestItems.token])
    expect(await ids(f.admin, { via: 'mcp_tokens' })).toEqual([])
    expect(await ids(f.user, { via: 'mcp_tokens' })).toEqual([guestItems.token])
    expect(await ids(f.user, { via: `mcp_tokens:${token.id}` })).toEqual([])
    expect(await ids(f.user, { via: `mcp_tokens:${uuid()}` })).toEqual([])
    // the deleter knows their own token; everyone knows an agent key
    expect(await ids(f.guest, { via: `mcp_tokens:${token.id}` })).toEqual([guestItems.token])
    expect(await ids(f.user, { via: `agent_keys:${key.id}` })).toEqual([guestItems.key])
    // a seat that reuses the deleter's id takes none of their deletes
    later()
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'profiles', f.guest.id)
      if (row !== null) await ctx.db.patch(row._id, { created_at: iso(Date.now()) })
    })
    expect(await ids(f.admin, {})).toEqual([])
  })
})

describe('rows stored before the page', () => {
  it('finds them by key and title, not by description or assignee, and says so while they last', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      title: 'Thermal camera',
      description: 'Borrowed from the lab',
      assignee_id: f.guest.id,
    })
    await deleteTask(t, f.guest, task.id)
    const item = (await itemFor(t, task.id)).id
    const scope = { org_id, all: true as const }
    const find = (who: Doc<'profiles'>, extra: Partial<PageArgs>) =>
      page(t, who, { scope, ...extra })
    // stored by this release: found by every field, and no older row
    expect((await find(f.admin, { search: 'borrowed' })).entries).toEqual([{ item_id: item }])
    expect((await find(f.admin, { search: 'thermal' })).legacy).toBeUndefined()
    expect((await find(f.guest, { search: 'thermal' })).legacy).toBe(true)
    // as the release before stored it, but for an empty search text: Convex
    // leaves a row without the field out of the search index, while
    // convex-test reads the field of every row and fails on one without it
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('deleted_tasks')
        .withIndex('by_task', (q) => q.eq('task_id', task.id))
        .unique()
      if (row === null) throw new Error('no stored row')
      await ctx.db.patch(row._id, {
        search_text: '',
        assignee_id: undefined,
        deleted_at: undefined,
        deleted_by: undefined,
        item_project_id: undefined,
        item_parent_id: undefined,
      })
    })
    for (const who of [f.admin, f.guest]) {
      for (const search of ['thermal', 'camera', `QN-${task.num}`]) {
        const found = await find(who, { search })
        expect(found.entries, `${who.name} ${search}`).toEqual([{ item_id: item }])
        expect(found.legacy).toBe(true)
      }
      expect((await find(who, { search: 'borrowed' })).entries).toEqual([])
      const assignee = await find(who, { assignee: f.guest.id })
      expect(assignee).toMatchObject({ entries: [], legacy: true })
    }
    // browsing needs no note
    expect((await find(f.admin, {})).legacy).toBeUndefined()
    // once the row is gone, only the admin's note goes
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('deleted_tasks').collect()) await ctx.db.delete(row._id)
    })
    expect((await find(f.admin, { search: 'thermal' })).legacy).toBeUndefined()
    expect((await find(f.guest, { search: 'thermal' })).legacy).toBe(true)
  })
})
