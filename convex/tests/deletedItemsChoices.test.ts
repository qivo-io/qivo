/* What the Deleted items page shows beside its entries
 * (model/deletedItemsChoices.ts): each seat's role (deletedItems.roles),
 * the people for Deleted by and the assignee filter (deletedItems.people)
 * and Delete now's summary (deletedItems.purgeSummary), with the page's two
 * filters that complete the Deleted by choices, `someone` and a `via` of a
 * credential kind (model/deletedItemsPage.ts deletedAsAsked). Fake timers
 * keep steps from running until a test releases them. DELETED_PEOPLE,
 * PURGE_ALONG and DELETED_PAGE are lowered where a case needs a stop and
 * restored after each case. The last block reads at the design size, one
 * figure raised a case, and logs its reads as
 * tests/deletedItemsPageReads.test.ts does. */
/// <reference types="vite/client" />

import type { FunctionArgs, WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { OrgRole } from '../lib/enums'
import { LIMITS } from '../lib/limits'
import {
  DELETED_PEOPLE,
  type DeletedPeople,
  type PeopleArgs,
  PURGE_ALONG,
  peopleBatch,
  purgeSummaryOf,
} from '../model/deletedItemsChoices'
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
import { keyOrg } from './nameKeys.setup'
import { installTrashTimers, itemFor, runSteps, START } from './trash.setup'

installTrashTimers()
const DEFAULT_PEOPLE = { ...DELETED_PEOPLE, read: { ...DELETED_PEOPLE.read } }
const DEFAULT_ALONG = { ...PURGE_ALONG }
const DEFAULT_PAGE = {
  ...DELETED_PAGE,
  call: { ...DELETED_PAGE.call },
  build: { ...DELETED_PAGE.build },
  find: { ...DELETED_PAGE.find },
  gather: { ...DELETED_PAGE.gather },
}
afterEach(() => {
  Object.assign(DELETED_PEOPLE, DEFAULT_PEOPLE)
  Object.assign(PURGE_ALONG, DEFAULT_ALONG)
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
/** Deletes profile `id`, as a removal of the person leaves no row. */
const removeProfile = (t: T, id: string) =>
  t.run(async (ctx) => {
    const row = await byId(ctx, 'profiles', id)
    if (row !== null) await ctx.db.delete(row._id)
  })

const roles = (t: T, who: Profile) => as(t, who).query(api.deletedItems.roles, {})
const people = (t: T, who: Profile, args: FunctionArgs<typeof api.deletedItems.people>) =>
  as(t, who).query(api.deletedItems.people, args)
const summary = (t: T, who: Profile, id: string) =>
  as(t, who).query(api.deletedItems.purgeSummary, { id })
const page = (t: T, who: Profile, args: FunctionArgs<typeof api.deletedItems.page>) =>
  as(t, who).query(api.deletedItems.page, args)
const purge = (t: T, who: Profile, ids: string[]) =>
  as(t, who).mutation(api.deletedItems.purge, { org_id: who.org_id, ids })
const deleteTask = (t: T, who: Profile, id: string, extra: object = {}) =>
  as(t, who).mutation(api.issues.deleteDeep, { org_id: who.org_id, id, ...extra })
const deleteProject = (t: T, who: Profile, id: string) =>
  as(t, who).mutation(api.projects.deleteDeep, { org_id: who.org_id, id })
/** Moves the clock on, so the next delete sorts after the last. */
const later = () => vi.setSystemTime(Date.now() + 60_000)

/** `answer` when it is a ready batch, else a failure. */
function ready(answer: DeletedPeople) {
  if (answer.state !== 'ready') throw new Error('the people are not ready')
  return answer
}

/** Every batch for `who` and `args` to the one whose next is null. */
async function batches(t: T, who: Profile, args: FunctionArgs<typeof api.deletedItems.people>) {
  const out: ReturnType<typeof ready>[] = []
  let cursor: string | undefined
  for (let i = 0; i < 100; i++) {
    const batch = ready(await people(t, who, cursor === undefined ? args : { ...args, cursor }))
    out.push(batch)
    if (batch.next === null) break
    cursor = batch.next
  }
  return out
}

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
  return { pages, ids: pages.flatMap((p) => p.entries.map((e) => e.item_id)) }
}

/** A stored project row of item `item`, as a deletion stores it, naming
 * `lead_id` as its lead. */
const storedLead = (item: WithoutSystemFields<Item>, lead_id: string) => ({
  item_id: item.id,
  org_id: item.org_id,
  table: 'projects' as const,
  owner_id: item.target_id,
  row_id: item.target_id,
  created_ts: START,
  project_key: item.key,
  lead_id,
  row: {
    table: 'projects' as const,
    doc: {
      id: item.target_id,
      org_id: item.org_id,
      type: 'meta' as const,
      key: item.key ?? 'KEY',
      name: item.name,
      description: '',
      sort_order: 1,
      num: item.num,
      track_delay: false,
      created_at: NOW,
      lead_id,
    },
  },
})

/** A ready project item of a top-level project, deleted at `at`, as a
 * deleted_items row without its stored rows. */
const plantedProject = (
  f: OrgFixture,
  at: string,
  fields: Partial<WithoutSystemFields<Item>> = {},
): WithoutSystemFields<Item> => {
  const target = uuid()
  return {
    id: uuid(),
    org_id: f.org.id,
    kind: 'project',
    target_id: target,
    num: 77,
    name: 'Old survey',
    key: 'OLD',
    archived: false,
    project_id: target,
    path: [],
    projects: [
      { id: target, name: 'Old survey', key: 'OLD', type: 'meta', tasks: 0, archived_tasks: 0 },
    ],
    counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
    deleted_at: at,
    deleted_by: f.admin.id,
    state: 'ready',
    purge_after: START + 30 * 86_400_000,
    ...fields,
  }
}

describe('deletedItems.roles', () => {
  it("tells each seat its own role: an admin's, a lead's of a live, archived or deleted project, and anyone else's", async () => {
    const t = newT()
    const f = await withOrg(t)
    const live = await person(t, f.org.id, 'Lena')
    const archived = await person(t, f.org.id, 'Arlo')
    const deleted = await person(t, f.org.id, 'Dora')
    await plantProject(t, { org_id: f.org.id, lead_id: live.id })
    await plantProject(t, { org_id: f.org.id, lead_id: archived.id, archived_at: NOW })
    const gone = await plantProject(t, { org_id: f.org.id, lead_id: deleted.id })
    await deleteProject(t, f.admin, gone.id)
    await runSteps(t)
    const roleOf = async (who: Profile) => {
      const answer = await roles(t, who)
      expect(answer, who.name).toHaveLength(1)
      return answer[0]
    }
    expect(await roleOf(f.admin)).toEqual({
      org_id: f.org.id,
      org_name: 'Testbed Labs',
      role: 'admin',
      can_purge: true,
    })
    for (const lead of [live, archived, deleted, f.user])
      expect(await roleOf(lead), lead.name).toMatchObject({ role: 'lead', can_purge: false })
    // the guest leads nothing, and a viewer named as a lead cannot lead
    await patch(t, 'projects', f.sub2.id, { lead_id: f.viewer.id })
    for (const who of [f.guest, f.viewer])
      expect(await roleOf(who), who.name).toEqual({
        org_id: f.org.id,
        org_name: 'Testbed Labs',
        role: 'user',
        can_purge: false,
      })
  })

  it("does not read a seat that reuses a removed lead's id as a lead, and reads only the newest stored row, as its docstring says", async () => {
    const t = newT()
    const f = await withOrg(t)
    const dora = await person(t, f.org.id, 'Dora')
    const project = await plantProject(t, { org_id: f.org.id, lead_id: dora.id })
    await deleteProject(t, f.admin, project.id)
    await runSteps(t)
    expect((await roles(t, dora))[0].role).toBe('lead')
    // a new seat with Dora's id, created after the delete
    later()
    await patch(t, 'profiles', dora.id, { created_at: new Date(Date.now()).toISOString() })
    const reused = (await t.run((ctx) => byId(ctx, 'profiles', dora.id))) as Profile
    expect((await roles(t, reused))[0].role).toBe('user')
    // a project the new seat led, deleted since: a lead again, unless the
    // item is purging
    later()
    const named = plantedProject(f, new Date(Date.now()).toISOString())
    await t.run(async (ctx) => {
      await ctx.db.insert('deleted_items', named)
      await ctx.db.insert('deleted_rows', storedLead(named, reused.id))
    })
    expect((await roles(t, reused))[0].role).toBe('lead')
    await patch(t, 'deleted_items', named.id, { state: 'purging' })
    expect((await roles(t, reused))[0].role).toBe('user')
    await patch(t, 'deleted_items', named.id, { state: 'ready' })
    // the approximation: a newer row of the earlier holder hides the older
    // row that names the new seat, since the role reads the newest row only
    const earlier = plantedProject(f, new Date(START - 86_400_000).toISOString())
    await t.run(async (ctx) => {
      await ctx.db.insert('deleted_items', earlier)
      await ctx.db.insert('deleted_rows', storedLead(earlier, reused.id))
    })
    expect((await roles(t, reused))[0].role).toBe('user')
  })

  it("answers every seat of the login, each with its own organization's role, and Delete now only while the organization can write", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'admin',
      org_role: 'guest',
      auth_user_id: f.admin.auth_user_id,
    })
    const answer = await roles(t, f.admin)
    expect([...answer].sort((a, b) => a.org_name.localeCompare(b.org_name))).toEqual([
      { org_id: f.otherOrg.id, org_name: 'Other', role: 'user', can_purge: false },
      { org_id: f.org.id, org_name: 'Testbed Labs', role: 'admin', can_purge: true },
    ])
    // the other organization's admin is told nothing of this login
    expect(await roles(t, f.otherAdmin)).toEqual([
      { org_id: f.otherOrg.id, org_name: 'Other', role: 'admin', can_purge: true },
    ])
    // billing on and no subscription: read-only, so Delete now is refused
    vi.stubEnv('BILLING_ENABLED', 'true')
    expect((await roles(t, f.admin)).find((r) => r.org_id === f.org.id)).toMatchObject({
      role: 'admin',
      can_purge: false,
    })
  })
})

describe('deletedItems.people', () => {
  it('answers every profile in name order with ties by id, as person rows with pending and you', async () => {
    const t = newT()
    const f = await withOrg(t)
    const first = await person(t, f.org.id, 'Sam Lee')
    const second = await person(t, f.org.id, 'Sam Lee', 'user', { auth_user_id: 'auth_sam_two' })
    const pat = await plantSeat(t, { org_id: f.org.id, name: 'Pat Pending', org_role: 'user' })
    const ivy = await person(t, f.org.id, 'Ivy Off', 'user', { active: false })
    // before the name keys, the batch waits
    expect(await people(t, f.user, { org_id: f.org.id })).toEqual({ state: 'not_ready' })
    await keyOrg(t, f.org.id)
    const batch = ready(await people(t, f.user, { org_id: f.org.id }))
    expect(batch).toMatchObject({ next: null, stopped: false })
    const ties = [first, second].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => p.id)
    expect(batch.rows.map((r) => [r.name, r.id])).toEqual([
      ['admin', f.admin.id],
      ['guest', f.guest.id],
      ['Ivy Off', ivy.id],
      ['Pat Pending', pat.id],
      ['Relay', f.agent.id],
      ['Sam Lee', ties[0]],
      ['Sam Lee', ties[1]],
      ['user', f.user.id],
      ['viewer', f.viewer.id],
    ])
    const row = (id: string) => batch.rows.find((r) => r.id === id)
    expect(row(f.user.id)).toEqual({
      id: f.user.id,
      name: 'user',
      org_role: 'user',
      kind: 'person',
      active: true,
      pending: false,
      you: true,
    })
    expect(row(f.agent.id)).toMatchObject({ kind: 'agent', pending: false, you: false })
    expect(row(pat.id)).toMatchObject({ kind: 'person', pending: true, you: false })
    expect(row(ivy.id)).toMatchObject({ active: false, pending: false })
    expect(row(f.admin.id)).toMatchObject({ org_role: 'admin', you: false })
  })

  it('keeps every word of a search ignoring case and accents, 25 a batch, with cursors sealed to the organization and search', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: `Émile Durand ${String(i).padStart(2, '0')}`,
          initials: 'ED',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    await keyOrg(t, f.org.id)
    await keyOrg(t, f.otherOrg.id)
    const one = ready(await people(t, f.viewer, { org_id: f.org.id, search: 'DURAND emile 07' }))
    expect(one.rows.map((r) => r.name)).toEqual(['Émile Durand 07'])
    expect(
      ready(await people(t, f.viewer, { org_id: f.org.id, search: 'durand zed' })).rows,
    ).toEqual([])
    const all = await batches(t, f.viewer, { org_id: f.org.id, search: 'émile' })
    expect(all.map((b) => b.rows.length)).toEqual([25, 5])
    expect(all.flatMap((b) => b.rows).at(-1)?.name).toBe('Émile Durand 29')
    // the same name key opens the same cursor
    const cursor = all[0].next ?? ''
    expect(
      ready(await people(t, f.viewer, { org_id: f.org.id, search: 'EMILE', cursor })).rows,
    ).toHaveLength(5)
    // another search or organization does not
    const refused = /cursor must come from an earlier batch of these people/
    await expectRefusal(
      people(t, f.viewer, { org_id: f.org.id, search: 'durand', cursor }),
      'bad_request',
      refused,
    )
    await expectRefusal(
      people(t, f.otherAdmin, { org_id: f.otherOrg.id, search: 'émile', cursor }),
      'bad_request',
      refused,
    )
    await expectRefusal(
      people(t, f.viewer, { org_id: f.org.id, cursor: 'not a cursor' }),
      'bad_request',
      refused,
    )
    await expectRefusal(
      people(t, f.viewer, { org_id: f.org.id, search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
      /Search for fewer words\.$/,
    )
  })

  it('answers an organization without an active seat of the caller as an empty last batch, after it refuses its arguments', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    await keyOrg(t, f.otherOrg.id)
    const empty = { state: 'ready', rows: [], next: null, stopped: false }
    expect(await people(t, f.user, { org_id: f.otherOrg.id })).toEqual(empty)
    expect(await people(t, f.user, { org_id: uuid() })).toEqual(empty)
    // an inactive seat is no seat
    await patch(t, 'profiles', f.guest.id, { active: false })
    expect(await people(t, f.guest, { org_id: f.org.id })).toEqual(empty)
    // the search and the cursor are judged first, as the page's are
    await expectRefusal(
      people(t, f.user, { org_id: f.otherOrg.id, search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    await expectRefusal(people(t, f.user, { org_id: f.otherOrg.id, cursor: 'junk' }), 'bad_request')
  })

  it('stops a batch at a lowered candidate bound or read share with a cursor that pages on to the end', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: `Bench person ${String(i).padStart(2, '0')}`,
          initials: 'BP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    await keyOrg(t, f.org.id)
    // 'viewer' sorts last, after every bench person
    const args = { org_id: f.org.id, search: 'viewer' }
    expect(await batches(t, f.user, args)).toHaveLength(1)
    DELETED_PEOPLE.candidates = 3
    const capped = await batches(t, f.user, args)
    expect(capped[0]).toMatchObject({ rows: [], stopped: true })
    expect(capped.length).toBeGreaterThan(3)
    expect(capped.flatMap((b) => b.rows.map((r) => r.name))).toEqual(['viewer'])
    expect(capped.at(-1)).toMatchObject({ next: null })
    Object.assign(DELETED_PEOPLE, DEFAULT_PEOPLE)
    // a read share of a few documents past the call's own reads
    DELETED_PEOPLE.read = { ...DEFAULT_PEOPLE.read, documents: 4 }
    const shared = await batches(t, f.user, args)
    expect(shared[0]).toMatchObject({ rows: [], stopped: true })
    expect(shared.length).toBeGreaterThan(2)
    expect(shared.flatMap((b) => b.rows.map((r) => r.name))).toEqual(['viewer'])
  })
})

describe('deletedItems.purgeSummary', () => {
  it('counts the items a purge of a project item purges, both levels and both purgeable states, as the purge then does', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = (project_id: string, title: string) =>
      plantIssue(t, { org_id: f.org.id, project_id, title })
    const deleted = async (project_id: string, title: string) => {
      const planted = await task(project_id, title)
      await deleteTask(t, f.user, planted.id)
      later()
      return await itemFor(t, planted.id)
    }
    // ready and stuck task items in a sub-project and in the root itself
    const ready = await deleted(f.sub.id, 'Ready in Firmware')
    const stuck = await deleted(f.sub.id, 'Stuck in Firmware')
    await patch(t, 'deleted_items', stuck.id, { state: 'stuck' })
    const onRoot = await deleted(f.meta.id, 'Ready on the platform')
    // a task item of Board rev, then Board rev itself
    const inBoard = await deleted(f.sub2.id, 'Ready in Board rev')
    await deleteProject(t, f.user, f.sub2.id)
    await runSteps(t)
    const board = await itemFor(t, f.sub2.id)
    later()
    // moving and restoring items, which the purge leaves to their expiry
    const moving = await deleted(f.sub.id, 'Moving in Firmware')
    const restoring = await deleted(f.sub.id, 'Restoring in Firmware')
    await patch(t, 'deleted_items', moving.id, { state: 'moving' })
    await patch(t, 'deleted_items', restoring.id, { state: 'restoring' })
    await deleteProject(t, f.user, f.meta.id)
    await runSteps(t)
    const platform = await itemFor(t, f.meta.id)

    const along = [ready, stuck, onRoot, inBoard, board].map((i) => i.id)
    expect(await summary(t, f.admin, platform.id)).toEqual({ along: along.length, exact: true })
    expect(await summary(t, f.admin, board.id)).toEqual({ along: 1, exact: true })
    expect(await summary(t, f.admin, ready.id)).toEqual({ along: 0, exact: true })
    // the purge takes exactly those, the second level in its own steps
    const before = new Set(
      (await t.run((ctx) => ctx.db.query('deleted_items').collect())).map((i) => i.id),
    )
    expect(await purge(t, f.admin, [platform.id])).toEqual({ purged: [platform.id], refused: [] })
    await runSteps(t)
    const after = new Set(
      (await t.run((ctx) => ctx.db.query('deleted_items').collect())).map((i) => i.id),
    )
    const purged = [...before].filter((id) => !after.has(id) && id !== platform.id)
    expect(purged.sort()).toEqual([...along].sort())
    expect([...after].sort()).toEqual([moving.id, restoring.id].sort())
  })

  it('answers an admin of the item’s organization only, and null alike for every other seat and item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const planted = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f.user, planted.id)
    await deleteProject(t, f.user, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, planted.id)
    const board = await itemFor(t, f.sub2.id)
    expect(await summary(t, f.admin, board.id)).toEqual({ along: 0, exact: true })
    // the user leads and sees both, the guest deleted nothing, the other
    // organization's admin holds no seat here
    for (const who of [f.user, f.guest, f.viewer, f.otherAdmin])
      for (const id of [item.id, board.id]) expect(await summary(t, who, id), who.name).toBeNull()
    expect(await summary(t, f.admin, uuid())).toBeNull()
    expect(await summary(t, f.admin, 'not an id')).toBeNull()
    for (const state of ['moving', 'restoring', 'purging'] as const) {
      await patch(t, 'deleted_items', board.id, { state })
      expect(await summary(t, f.admin, board.id), state).toBeNull()
    }
    await patch(t, 'deleted_items', board.id, { state: 'stuck' })
    expect(await summary(t, f.admin, board.id)).toEqual({ along: 0, exact: true })
  })

  it('answers the count so far as inexact past a lowered bound', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 4; i++) {
      const planted = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await deleteTask(t, f.user, planted.id)
    }
    await deleteProject(t, f.user, f.meta.id)
    await runSteps(t)
    const platform = await itemFor(t, f.meta.id)
    expect(await summary(t, f.admin, platform.id)).toEqual({ along: 4, exact: true })
    PURGE_ALONG.items = 2
    expect(await summary(t, f.admin, platform.id)).toEqual({ along: 2, exact: false })
    Object.assign(PURGE_ALONG, DEFAULT_ALONG)
    PURGE_ALONG.rows = 3
    expect(await summary(t, f.admin, platform.id)).toEqual({ along: 3, exact: false })
    Object.assign(PURGE_ALONG, DEFAULT_ALONG)
    // four ranges a project, the platform's own first, which hold nothing
    PURGE_ALONG.ranges = 2
    expect(await summary(t, f.admin, platform.id)).toEqual({ along: 0, exact: false })
  })
})

describe("the page's someone", () => {
  it('keeps the deletes of removed people and of an id a new seat reuses, for an admin across the organization and a lead within their ranges', async () => {
    const t = newT()
    const f = await withOrg(t)
    const kim = await person(t, f.org.id, 'Kim')
    const lou = await person(t, f.org.id, 'Lou')
    const elsewhere = await plantProject(t, { org_id: f.org.id, name: 'Elsewhere' })
    const away = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: elsewhere.id,
      name: 'Away',
    })
    for (const who of [kim, lou]) {
      await grant(t, f.meta.id, who.id, 'user')
      await grant(t, elsewhere.id, who.id, 'user')
    }
    const deleted = async (who: Profile, project_id: string) => {
      const planted = await plantIssue(t, { org_id: f.org.id, project_id })
      await deleteTask(t, who, planted.id)
      later()
      return (await itemFor(t, planted.id)).id
    }
    const byKim = await deleted(kim, f.sub.id)
    const byKimAway = await deleted(kim, away.id)
    const byLou = await deleted(lou, f.sub.id)
    const byGuest = await deleted(f.guest, f.sub.id)
    const byUser = await deleted(f.user, f.sub.id)
    // Kim is removed, and a new seat takes Lou's id
    await removeProfile(t, kim.id)
    await patch(t, 'profiles', lou.id, { created_at: new Date(Date.now()).toISOString() })
    const scope = { org_id: f.org.id, all: true as const }
    const ids = async (who: Profile, args: Partial<FunctionArgs<typeof api.deletedItems.page>>) =>
      (await walk(t, who, { scope, kind: 'task', ...args })).ids
    expect(await ids(f.admin, { someone: true })).toEqual([byLou, byKimAway, byKim])
    expect(await ids(f.admin, {})).toEqual([byUser, byGuest, byLou, byKimAway, byKim])
    // the user leads the platform, not Elsewhere
    expect(await ids(f.user, { someone: true })).toEqual([byLou, byKim])
    // with a search, an assignee or a project scope too
    expect((await walk(t, f.admin, { scope, someone: true, search: 'Planted' })).ids).toEqual([
      byLou,
      byKimAway,
      byKim,
    ])
    expect(
      (
        await walk(t, f.admin, {
          scope: { org_id: f.org.id, project_ids: [elsewhere.id] },
          someone: true,
        })
      ).ids,
    ).toEqual([byKimAway])
  })

  it('goes with neither deleted_by nor via, and opens no cursor of a page without it', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 2; i++) {
      const planted = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await deleteTask(t, f.guest, planted.id)
      later()
    }
    const scope = { org_id: f.org.id, all: true as const }
    const refused = /someone goes with neither deleted_by nor via/
    await expectRefusal(
      page(t, f.admin, { scope, someone: true, deleted_by: f.guest.id }),
      'bad_request',
      refused,
    )
    await expectRefusal(
      page(t, f.admin, { scope, someone: true, via: 'app' }),
      'bad_request',
      refused,
    )
    const first = await page(t, f.admin, { scope, limit: 1 })
    const cursor = first.next_cursor ?? ''
    expect(cursor).not.toBe('')
    await expectRefusal(page(t, f.admin, { scope, limit: 1, someone: true, cursor }), 'bad_request')
    // and a page with it opens none of a page without it, nor the reverse
    const mine = await page(t, f.admin, { scope, limit: 1, kind: 'task', someone: true })
    expect(mine).toEqual({ entries: [], items: [], next_cursor: null })
    expect((await page(t, f.admin, { scope, limit: 1, cursor })).entries).toHaveLength(1)
  })

  it('ends a browse page early on a lowered budget, and pages on to the end', async () => {
    const t = newT()
    const f = await withOrg(t)
    const kim = await person(t, f.org.id, 'Kim')
    await grant(t, f.meta.id, kim.id, 'user')
    const kims: string[] = []
    for (let i = 0; i < 6; i++) {
      const planted = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await deleteTask(t, i % 2 === 0 ? kim : f.guest, planted.id)
      if (i % 2 === 0) kims.unshift((await itemFor(t, planted.id)).id)
      later()
    }
    await removeProfile(t, kim.id)
    const scope = { org_id: f.org.id, all: true as const }
    // the reads that find items may read four documents: a page reads the
    // first item of its range and three more, and a later page its
    // cursor's item again first
    DELETED_PAGE.find = { bytes: 1 << 30, rows: 4, ranges: 1e6 }
    const walked = await walk(t, f.admin, { scope, kind: 'task', someone: true })
    expect(walked.pages.length).toBeGreaterThan(1)
    for (const p of walked.pages.slice(0, -1)) {
      expect(p.entries.length).toBeLessThan(kims.length)
      expect(p.next_cursor).not.toBeNull()
    }
    expect(walked.pages.every((p) => p.missing === undefined)).toBe(true)
    expect(walked.ids).toEqual(kims)
  })
})

describe("the page's via", () => {
  it('matches a kind of credential for every viewer, and a credential only where the viewer may know which', async () => {
    const t = newT()
    const f = await withOrg(t)
    const token = (name: string) => ({ table: 'mcp_tokens' as const, id: uuid(), name })
    const laptop = token('Laptop')
    const desk = token('Desk')
    const app = { table: 'oauth_connections' as const, id: uuid(), name: 'Claude' }
    const ids = await t.run(async (ctx) => {
      const out: Record<string, string> = {}
      for (const [name, via] of [
        ['laptop', laptop],
        ['desk', desk],
        ['app', app],
        ['plain', undefined],
      ] as const) {
        const id = uuid()
        await ctx.db.insert('deleted_items', {
          id,
          org_id: f.org.id,
          kind: 'task',
          target_id: uuid(),
          num: 1,
          name,
          archived: false,
          project_id: f.sub.id,
          parent_project_id: f.meta.id,
          path: ['Testbed platform', 'Firmware'],
          projects: [
            {
              id: f.sub.id,
              name: 'Firmware',
              key: 'FW',
              type: 'project',
              tasks: 1,
              archived_tasks: 0,
            },
          ],
          counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
          deleted_at: new Date(START).toISOString(),
          deleted_by: f.guest.id,
          state: 'ready',
          purge_after: START + 30 * 86_400_000,
          via,
        })
        out[name] = id
      }
      return out
    })
    const scope = { org_id: f.org.id, all: true as const }
    const of = async (who: Profile, via: string) =>
      (await page(t, who, { scope, deleted_by: f.guest.id, via })).entries
        .map((e) => e.item_id)
        .sort()
    const tokens = [ids.laptop, ids.desk].sort()
    // the admin and the owner know each token, the lead only the kind
    for (const who of [f.admin, f.guest, f.user]) {
      expect(await of(who, 'mcp_tokens'), who.name).toEqual(tokens)
      expect(await of(who, 'oauth_connections'), who.name).toEqual([ids.app])
      expect(await of(who, 'app'), who.name).toEqual([ids.plain])
    }
    for (const who of [f.admin, f.guest])
      expect(await of(who, `mcp_tokens:${laptop.id}`), who.name).toEqual([ids.laptop])
    expect(await of(f.user, `mcp_tokens:${laptop.id}`)).toEqual([])
    // a prefix of a kind is no kind
    expect(await of(f.admin, 'mcp')).toEqual([])
  })
})

/* ------------------------------------------------- reads at the design size */

/** What one call of `read` cost, as convex-test counts it. */
async function metered<R>(
  t: T,
  me: Profile,
  read: (ctx: Parameters<typeof peopleBatch>[0]) => Promise<R>,
) {
  return await as(t, me).query(async (ctx) => {
    const answer = await read(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      figures: {
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / 2 ** 20) * 100) / 100,
      },
    }
  })
}

/** Prints `figures` and checks them inside Convex's limits. */
function record(what: string, figures: { ranges: number; documents: number; mib: number }) {
  console.log(`deleted choices figures, ${what}:`, JSON.stringify(figures))
  expect(figures.ranges).toBeLessThan(4096)
  expect(figures.documents).toBeLessThan(32_000)
  expect(figures.mib).toBeLessThan(16)
}

describe('reads at the design size', () => {
  it('reads the people of an organization of 1,000, with no search and with one whose matches sit last', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // with withOrg's five, 995 people with ordinary names, the last three
    // after every other name
    await t.run(async (ctx) => {
      for (let i = 0; i < 995; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: i < 992 ? `Person ${String(i).padStart(3, '0')} of the lab` : `Zora Quill ${i}`,
          initials: 'PL',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
          email: `person${i}@testbed.test`,
        })
    })
    await keyOrg(t, f.org.id)
    const seats = new Map([[f.user.org_id, f.user]])
    const batch = (a: PeopleArgs) => metered(t, f.user, (ctx) => peopleBatch(ctx, seats, a))
    const plain = await batch({ org_id: f.org.id })
    record('1,000 people, the first batch', plain.figures)
    expect(ready(plain.answer)).toMatchObject({ stopped: false })
    expect(ready(plain.answer).rows).toHaveLength(25)
    const sparse = await batch({ org_id: f.org.id, search: 'quill' })
    record('1,000 people, a search whose matches sit last, the first batch', sparse.figures)
    expect(ready(sparse.answer)).toMatchObject({ rows: [], stopped: true })
    // it pages on to the matches
    let cursor = ready(sparse.answer).next ?? undefined
    const rows: string[] = []
    for (let i = 0; i < 10 && cursor !== undefined; i++) {
      const next = await batch({ org_id: f.org.id, search: 'quill', cursor })
      record(`the same, batch ${i + 2}`, next.figures)
      rows.push(...ready(next.answer).rows.map((r) => r.name))
      cursor = ready(next.answer).next ?? undefined
    }
    expect(rows).toEqual(['Zora Quill 992', 'Zora Quill 993', 'Zora Quill 994'])
  })

  it("counts Delete now's summary of a project item that stores 30 live and 40 archived sub-projects", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const at = new Date(START).toISOString()
    const before = new Date(START - 86_400_000).toISOString()
    const root = uuid()
    const subs = Array.from({ length: 70 }, (_, i) => ({ id: uuid(), live: i < 30 }))
    const entry = (id: string, type: 'meta' | 'project', i: number) => ({
      id,
      name: `Project ${i} of the bench`,
      key: `B${i}`,
      type,
      tasks: 0,
      archived_tasks: 0,
    })
    const item = plantedProject(f, at, {
      target_id: root,
      project_id: root,
      projects: [entry(root, 'meta', 0), ...subs.map((s, i) => entry(s.id, 'project', i + 1))],
      counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 70 },
    })
    /** A ready task item of one task in `project`, deleted before the root. */
    const taskItem = (project: string): WithoutSystemFields<Item> => ({
      id: uuid(),
      org_id: f.org.id,
      kind: 'task',
      target_id: uuid(),
      num: 1,
      name: 'Calibrate the torque sensor on test rig 1 before the thermal soak run starts',
      archived: false,
      project_id: project,
      parent_project_id: root,
      path: ['Bench', 'Rig'],
      projects: [entry(project, 'project', 1)],
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at: before,
      deleted_by: f.guest.id,
      state: 'ready',
      purge_after: START + 30 * 86_400_000,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('deleted_items', item)
      // an everyday dependent in each live sub-project
      for (const sub of subs.filter((s) => s.live))
        await ctx.db.insert('deleted_items', taskItem(sub.id))
      // three sub-projects deleted earlier, each with a task item of its own
      for (let i = 0; i < 3; i++) {
        const target = uuid()
        await ctx.db.insert('deleted_items', {
          ...plantedProject(f, before),
          target_id: target,
          project_id: target,
          parent_project_id: root,
          projects: [entry(target, 'project', 100 + i)],
        })
        await ctx.db.insert('deleted_items', taskItem(target))
      }
    })
    const seats = new Map([[f.admin.org_id, f.admin]])
    const read = await metered(t, f.admin, (ctx) => purgeSummaryOf(ctx, seats, item.id))
    record('a project item of 70 sub-projects with 36 items to purge with it', read.figures)
    expect(read.answer).toEqual({ along: 36, exact: true })
  })
})
