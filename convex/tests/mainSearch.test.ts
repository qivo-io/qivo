/* Main Search's task and project results (search.ts page,
 * lib/mainSearch.ts): which tasks and projects a search finds, for whom, in
 * which order, a page at a time, and what its coverage says when its reads
 * stop.
 *
 * convex-test's search splits texts on whitespace only, matches any term
 * as a prefix, and has neither Convex's 1,024-result cap nor its ranking.
 * So these cases test ranking, caps and coverage through the server's own
 * logic, with lowered MAIN_SEARCH values, and a description that must be a
 * candidate for a word only its hidden parts hold spaces those parts out,
 * so convex-test returns it. The local backend probe checked Convex's own
 * behavior (the stage report). */

import type { WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { canSeeProject } from '../lib/access'
import { newWindowKey } from '../lib/db'
import { LIMITS } from '../lib/limits'
import {
  ARCHIVED_FILTER,
  MAIN_SEARCH,
  type MainSearchPage,
  mainSearchPage,
  SEARCH_RESERVE,
  SEAT_SHARE,
  type SearchScope,
} from '../lib/mainSearch'
import { insertTask } from '../model/descriptions'
import { PROJECT_SIGHT } from '../model/projectNav'
import { SHAPES, type Shape } from './accessShapes.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantLogins,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { withReach } from './projectReach.setup'
import { deleteProject, deleteTask, installTrashTimers } from './trash.setup'

/* Search cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts), which the edge runtime does not set. */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'main-search-test-secret-not-a-deployment-key'

installTrashTimers()
const DEFAULT_SEARCH = { ...MAIN_SEARCH }
const DEFAULT_RESERVE = { ...SEARCH_RESERVE }
const DEFAULT_FILTER = { ...ARCHIVED_FILTER }
const DEFAULT_SHARE = { ...SEAT_SHARE }
const DEFAULT_SIGHT = { ...PROJECT_SIGHT }
afterEach(() => {
  Object.assign(PROJECT_SIGHT, DEFAULT_SIGHT)
  Object.assign(SEAT_SHARE, DEFAULT_SHARE)
  Object.assign(MAIN_SEARCH, DEFAULT_SEARCH)
  Object.assign(SEARCH_RESERVE, DEFAULT_RESERVE)
  Object.assign(ARCHIVED_FILTER, DEFAULT_FILTER)
})

type Args = { text: string; include_archived?: boolean; scope?: SearchScope; cursor?: string }

/** One page of main Search as `who` asks for it through the public query. */
const search = (t: T, who: Doc<'profiles'>, a: Args): Promise<MainSearchPage> =>
  as(t, who).query(api.search.page, { include_archived: false, ...a })

/** The task and project ids of a page's rows, in order. */
const ids = (page: MainSearchPage) => page.rows.map((row) => row.id)

/** The names of a page's project rows, in order. */
const projectNames = (page: MainSearchPage) =>
  page.rows.flatMap((row) => (row.kind === 'project' ? [row.name] : []))

/** Sets nav_at on organization `orgId`'s org_ready row, or clears it with
 * null, adding the row when it has none, as model/orgs.ts insertOrgRows
 * writes it for a new organization. */
const stampNav = (t: T, orgId: string, nav_at: string | null = NOW) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('org_ready')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique()
    const stamped = {
      org_id: orgId,
      ...(row?.name_keys_at === undefined ? {} : { name_keys_at: row.name_keys_at }),
      ...(nav_at === null ? {} : { nav_at }),
    }
    if (row === null) await ctx.db.insert('org_ready', stamped)
    else await ctx.db.replace(row._id, stamped)
  })

const COMPLETE = { complete: true }
/** The coverage of a search that stopped, by default of one seat's one. */
const stopped = (
  why: 'projects' | 'reads' | 'candidates' | 'organizations',
  searched = 1,
  of = 1,
) => ({
  complete: false,
  stopped: why,
  searched,
  of,
})
const EMPTY = { rows: [], next_cursor: null, coverage: COMPLETE }

/** One call of the search as the seats `seats`, inside one transaction, with
 * what it did and what it read beyond its caller's reads. */
async function searchRun(t: T, seats: readonly Doc<'profiles'>[], a: Args) {
  return await t.run(async (ctx) => {
    const stats = { searches: 0 }
    const before = await ctx.meta.getTransactionMetrics()
    const page = await mainSearchPage(
      ctx,
      new Map(seats.map((seat) => [seat.org_id, seat])),
      { include_archived: false, ...a },
      stats,
    )
    const after = await ctx.meta.getTransactionMetrics()
    return {
      page,
      searches: stats.searches,
      read: {
        ranges: after.databaseQueries.used - before.databaseQueries.used,
        documents: after.documentsRead.used - before.documentsRead.used,
        bytes: after.bytesRead.used - before.bytesRead.used,
      },
    }
  })
}

/** The other active seats of `profile`'s login. */
const seatsOf = (t: T, profile: Doc<'profiles'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', profile.auth_user_id))
        .collect()
    ).filter((seat) => seat.id !== profile.id && seat.active),
  )

/** Organization number `i` of its own, with its counters, and its id. */
const plantOrg = (t: T, i: number) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('organizations', {
      id,
      name: `Broad ${i}`,
      slug: `broad-${i}`,
      created_at: NOW,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
    })
    await ctx.db.insert('org_counters', { org_id: id, next_issue_num: 1, next_project_num: 4 })
    return id
  })

/** An organization of its own for login `login`, in which a guest seat
 * sees one top-level project with two sub-projects, `sub` among them. */
async function broadSeat(t: T, login: string, i: number) {
  const org = await plantOrg(t, i)
  const meta = await plantProject(t, { org_id: org })
  const sub = await plantProject(t, { org_id: org, type: 'project', parent_id: meta.id })
  await plantProject(t, { org_id: org, type: 'project', parent_id: meta.id })
  const seat = await plantSeat(t, {
    org_id: org,
    auth_user_id: login,
    org_role: 'guest',
    accepted_at: NOW,
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: meta.id, profile_id: seat.id, level: 'user' }),
  )
  return { org, sub, seat }
}

/** `n` broadSeat organizations for `login`, in seat order. */
async function broadSeats(t: T, login: string, n: number) {
  const built = []
  for (let i = 0; i < n; i++) built.push(await broadSeat(t, login, i))
  return built.sort((a, b) => (a.org < b.org ? -1 : 1))
}

/** Sets the text of task `task`, on its row and its description row. */
const setText = (t: T, task: Doc<'issues'>, description: string) =>
  t.run(async (ctx) => {
    await ctx.db.patch(task._id, { description })
    const row = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .unique()
    if (row !== null) await ctx.db.patch(row._id, { description })
  })

/** A seeded stream of numbers from 0 up to 1 (mulberry32), so a failing
 * seed fails again. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let z = a
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

/** A task in `project` of the fixture's organization. */
const task = (
  t: T,
  f: OrgFixture,
  project: Doc<'projects'>,
  title: string,
  extra: Partial<WithoutSystemFields<Doc<'issues'>>> = {},
) => plantIssue(t, { org_id: f.org.id, project_id: project.id, title, ...extra })

/** A live sub-project of `parent`. */
const subOf = (t: T, f: OrgFixture, parent: Doc<'projects'>, extra = {}) =>
  plantProject(t, { org_id: f.org.id, type: 'project', parent_id: parent.id, ...extra })

/** `count` tasks in one project, a batch of rows a transaction. */
async function plantMany(
  t: T,
  count: number,
  task: (
    i: number,
  ) => { org_id: string; project_id: string } & Partial<WithoutSystemFields<Doc<'issues'>>>,
  batch = 50,
): Promise<string[]> {
  const out: string[] = []
  for (let from = 0; from < count; from += batch)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + batch); i++) {
        const id = uuid()
        await insertTask(
          ctx.db,
          {
            id,
            num: 50_000 + i,
            title: 'Planted task',
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...task(i),
          },
          'restore',
        )
        out.push(id)
      }
    })
  return out
}

/** The task ids convex-test's description index returns for `word`. */
const descriptionHits = (t: T, f: OrgFixture, word: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issue_descriptions')
        .withSearchIndex('search_description', (q) =>
          q.search('description', word).eq('org_id', f.org.id),
        )
        .collect()
    ).map((row) => row.issue_id),
  )

/** A seat for `f.user`'s login in the fixture's other organization, as a
 * guest with User on its project, and a live sub-project there. */
async function secondSeat(t: T, f: OrgFixture) {
  const seat = await plantSeat(t, {
    org_id: f.otherOrg.id,
    auth_user_id: f.user.auth_user_id,
    org_role: 'guest',
    accepted_at: NOW,
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.otherProject.id,
      profile_id: seat.id,
      level: 'user',
    }),
  )
  const sub = await plantProject(t, {
    org_id: f.otherOrg.id,
    type: 'project',
    parent_id: f.otherProject.id,
  })
  return { seat, sub }
}

describe('what main Search matches', () => {
  it('finds a task reference by its number and by a whole word of its digits', async () => {
    const t = newT()
    const f = await withOrg(t)
    const twelve = await task(t, f, f.sub, 'Calibrate the rig', { num: 12 })
    const titled = await task(t, f, f.sub2, 'Rev 12 board')
    const described = await task(t, f, f.sub, 'Planted', { description: 'see step 12 first' })
    // 120 starts with the digits but is another word
    await task(t, f, f.sub, 'Rev 120 board')
    await task(t, f, f.sub, 'Planted', { description: 'see step 120 first' })
    const found = [twelve.id, titled.id, described.id]
    const bare = await search(t, f.user, { text: '12' })
    expect(ids(bare)[0]).toBe(twelve.id)
    expect(ids(bare).sort()).toEqual([...found].sort())
    expect(bare.coverage).toEqual(COMPLETE)
    expect(ids(await search(t, f.user, { text: 'QN-12' })).sort()).toEqual([...found].sort())
    // a number no task can have still finds a word of its digits
    const zero = await task(t, f, f.sub, 'Version 0 notes')
    expect(await search(t, f.user, { text: '0' })).toMatchObject({
      rows: [{ id: zero.id }],
      coverage: COMPLETE,
    })
  })

  it('finds a task by its number, a title word, a description word and both', async () => {
    const t = newT()
    const f = await withOrg(t)
    const torque = await task(t, f, f.sub, 'Calibrate the torque sensor', {
      description: 'Use the bench rig in lab B.',
    })
    const cables = await task(t, f, f.sub2, 'Order cables', { description: 'Torque wrench too' })
    expect(ids(await search(t, f.user, { text: `QN-${torque.num}` }))).toEqual([torque.id])
    expect(ids(await search(t, f.user, { text: `${torque.num}` }))).toEqual([torque.id])
    expect(ids(await search(t, f.user, { text: 'calibrate' }))).toEqual([torque.id])
    expect(ids(await search(t, f.user, { text: 'bench' }))).toEqual([torque.id])
    expect(ids(await search(t, f.user, { text: 'calibrate bench' }))).toEqual([torque.id])
    // the title match ranks above the description match
    expect(ids(await search(t, f.user, { text: 'torque' }))).toEqual([torque.id, cables.id])
    // a term that matches nothing leaves the task out
    expect(ids(await search(t, f.user, { text: 'calibrate oscilloscope' }))).toEqual([])
    // a project's name is no part of its tasks' text: it finds the project
    expect(f.sub.name).toBe('Firmware')
    expect(ids(await search(t, f.user, { text: 'firmware' }))).toEqual([f.sub.id])
  })

  it('matches the text a description shows, not its hidden parts', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the hidden parts stand apart, so convex-test returns these rows for
    // their words and the server's own check must leave them out
    const mention = await task(t, f, f.sub, 'Mention', {
      description: `Ask @[ Nora ]( user:${f.user.id} ) about it`,
    })
    const image = await task(t, f, f.sub, 'Image', {
      description: `The ![ plan ]( att:${uuid()} ) is here`,
    })
    const link = await task(t, f, f.sub, 'Link', {
      description: 'Read [ docs ]( example.com/guide ) first',
    })
    const code = await task(t, f, f.sub, 'Code', { description: 'Run ` calibrate_all ` now' })
    for (const word of ['user', 'att', 'example']) {
      expect(await descriptionHits(t, f, word)).not.toEqual([])
      expect(ids(await search(t, f.user, { text: word }))).toEqual([])
    }
    expect(ids(await search(t, f.user, { text: 'nora' }))).toEqual([mention.id])
    expect(ids(await search(t, f.user, { text: 'plan' }))).toEqual([image.id])
    expect(ids(await search(t, f.user, { text: 'docs' }))).toEqual([link.id])
    expect(ids(await search(t, f.user, { text: 'calibrate' }))).toEqual([code.id])
  })

  it("leaves out a code fence's language and a numbered list's numbers", async () => {
    const t = newT()
    const f = await withOrg(t)
    // no link, so only the fence and the list mark these as hiding words
    const fenced = await task(t, f, f.sub, 'Planted', {
      description: 'fun main\n```kotlin\nx\n```',
    })
    const listed = await task(t, f, f.sub, 'Planted', { description: 'steps\n7. calibrate' })
    expect(ids(await search(t, f.user, { text: 'fun kotlin' }))).toEqual([])
    expect(ids(await search(t, f.user, { text: 'fun main' }))).toEqual([fenced.id])
    expect(ids(await search(t, f.user, { text: 'steps 7' }))).toEqual([])
    expect(ids(await search(t, f.user, { text: 'steps calibrate' }))).toEqual([listed.id])
  })

  it('leaves out archived tasks until the toggle is on, and always those of archived projects or Deleted items', async () => {
    const t = newT()
    const f = await withOrg(t)
    const active = await task(t, f, f.sub, 'Gearbox teardown')
    const archived = await task(t, f, f.sub, 'Gearbox rebuild', { archived_at: NOW })
    const shelf = await subOf(t, f, f.meta, { archived_at: NOW })
    await task(t, f, shelf, 'Gearbox spares')
    await task(t, f, shelf, 'Gearbox log', { archived_at: NOW })
    const deleted = await task(t, f, f.sub, 'Gearbox mount', { description: 'gearbox mount' })
    await deleteTask(t, f, deleted.id)
    for (const who of [f.user, f.admin]) {
      const off = await search(t, who, { text: 'gearbox' })
      expect(ids(off)).toEqual([active.id])
      expect(off.rows[0]).toMatchObject({ archived: false, status: 'todo', is_group: false })
      const on = await search(t, who, { text: 'gearbox', include_archived: true })
      expect(ids(on).sort()).toEqual([active.id, archived.id].sort())
      expect(on.rows.find((row) => row.id === archived.id)).toMatchObject({ archived: true })
    }
  })
})

describe('who main Search shows a task to', () => {
  it('shows a guest only the matches in the projects shared with them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const shared = await task(t, f, f.sub, 'Gearbox teardown')
    await task(t, f, sibling, 'Gearbox rebuild')
    const elsewhere = await subOf(t, f, f.hidden)
    await task(t, f, elsewhere, 'Gearbox spares')
    expect(ids(await search(t, f.guest, { text: 'gearbox' }))).toEqual([shared.id])
    // and when the guest's search reads the whole organization, which is
    // never reported complete for them
    MAIN_SEARCH.projects = 1
    const whole = await searchRun(t, [f.guest], { text: 'gearbox' })
    expect(whole.searches).toBe(2)
    expect(ids(whole.page)).toEqual([shared.id])
    expect(whole.page.coverage).toEqual(stopped('projects'))
    MAIN_SEARCH.projects = DEFAULT_SEARCH.projects
    // a member without a grant sees none of them
    const member = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
    expect(await search(t, member, { text: 'gearbox' })).toEqual(EMPTY)
  })

  it('gives an organization admin what projectLevel gives', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await subOf(t, f, f.hidden)
    const unshared = await task(t, f, elsewhere, 'Gearbox spares')
    // today an admin leads every project (lib/access.ts levelUnder); the
    // admin access split leaves this task out
    expect(ids(await search(t, f.admin, { text: 'gearbox' }))).toEqual([unshared.id])
    expect(ids(await search(t, f.guest, { text: 'gearbox' }))).toEqual([])
  })

  it("adds a second seat's matches, each organization answering its own task numbers", async () => {
    const t = newT()
    const f = await withOrg(t)
    const { seat, sub } = await secondSeat(t, f)
    const home = await task(t, f, f.sub, 'Gearbox teardown', { num: 7 })
    // titles of one length, so only the seat orders them
    const away = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: sub.id,
      title: 'Gearbox rebuilds',
      num: 7,
    })
    const page = await search(t, f.user, { text: 'QN-7' })
    // the home seat first, then the guest seat
    expect(ids(page)).toEqual([home.id, away.id])
    expect(page.rows.map((row) => row.org_id)).toEqual([f.org.id, f.otherOrg.id])
    expect(ids(await search(t, f.user, { text: 'gearbox' }))).toEqual([home.id, away.id])
    expect(seat.org_role).toBe('guest')
  })
})

describe('seats', () => {
  it('shows the match of every seat it searches of eight that search their organization whole', async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    // eight organizations, in each a guest who sees two sub-projects, more
    // than one by one allows here, with a small task in one of them
    MAIN_SEARCH.projects = 1
    const seats: Doc<'profiles'>[] = []
    const found = new Map<string, string>()
    for (let i = 0; i < 8; i++) {
      const { org, sub, seat } = await broadSeat(t, login, i)
      seats.push(seat)
      found.set(
        org,
        (await plantIssue(t, { org_id: org, project_id: sub.id, title: 'Gearbox' })).id,
      )
    }
    const run = await searchRun(t, seats, { text: 'gearbox' })
    // as many seats as the budget gives a share and a step's headroom, in
    // seat order, each judging its candidates
    const { coverage } = run.page
    if (coverage.complete) throw new Error('a search of a whole organization is never complete')
    expect(coverage).toEqual(stopped('projects', coverage.searched, 8))
    expect(coverage.searched).toBeGreaterThan(1)
    const searched = [...found.keys()].sort().slice(0, coverage.searched)
    expect(ids(run.page).sort()).toEqual(searched.map((org) => found.get(org)).sort())
  })

  it('keeps the page its room when seats searched whole read large project rows', async () => {
    const t = newT({ transactionLimits: true })
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    MAIN_SEARCH.projects = 1
    const huge = 'x'.repeat(900_000)
    const seats: Doc<'profiles'>[] = []
    const found = new Map<string, string>()
    for (let i = 0; i < 4; i++) {
      const { org, sub, seat } = await broadSeat(t, login, i)
      seats.push(seat)
      // the guest's match first, as convex-test's search returns tasks in
      // the order they were made
      found.set(
        org,
        (await plantIssue(t, { org_id: org, project_id: sub.id, title: 'Gearbox' })).id,
      )
      // hidden matches, each in a project whose row and whose top-level
      // project's row are near Convex's 1 MiB, as older rows can be
      for (let k = 0; k < 4; k++) {
        const root = await plantProject(t, { org_id: org, description: huge })
        const hidden = await plantProject(t, {
          org_id: org,
          type: 'project',
          parent_id: root.id,
          description: huge,
        })
        await plantIssue(t, { org_id: org, project_id: hidden.id, title: 'Gearbox' })
      }
    }
    const run = await searchRun(t, seats, { text: 'gearbox' })
    console.log('4 broad seats, large project rows', run.read, run.page.rows.length)
    // every seat searched shows its match
    const { coverage } = run.page
    if (coverage.complete) throw new Error('a search of a whole organization is never complete')
    expect(coverage).toEqual(stopped('projects', coverage.searched, 4))
    expect(coverage.searched).toBeGreaterThanOrEqual(2)
    const searched = [...found.keys()].sort().slice(0, coverage.searched)
    expect(ids(run.page).sort()).toEqual(searched.map((org) => found.get(org)).sort())
    expect(run.read.bytes).toBeLessThan(16 << 20)
  })

  it("never lets hidden tasks in one seat's organization change what another seat reads", async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    MAIN_SEARCH.projects = 1
    const seats: Doc<'profiles'>[] = []
    const orgs: string[] = []
    for (let i = 0; i < 7; i++) {
      const { org, sub, seat } = await broadSeat(t, login, i)
      seats.push(seat)
      orgs.push(org)
      await plantIssue(t, { org_id: org, project_id: sub.id, title: 'Gearbox' })
    }
    const without = await searchRun(t, seats, { text: 'gearbox' })
    // hidden matches in the first six organizations in seat order, with
    // descriptions at LIMITS.description in a three-byte script
    const long = `${'中'.repeat(LIMITS.description.max - 8)} gearbox`
    for (const org of [...orgs].sort().slice(0, 6)) {
      const root = await plantProject(t, { org_id: org })
      const hidden = await plantProject(t, { org_id: org, type: 'project', parent_id: root.id })
      await plantMany(t, 24, () => ({ org_id: org, project_id: hidden.id, description: long }), 8)
    }
    const withHidden = await searchRun(t, seats, { text: 'gearbox' })
    expect(withHidden.page).toEqual(without.page)
    expect(without.page.coverage).toMatchObject({ complete: false, stopped: 'projects', of: 7 })
  })

  it('counts only the seats whose reads began when task numbers spend the budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    await secondSeat(t, f)
    // home tasks large enough to spend the home seat's allowance in its
    // number lookups, and an allowance only one seat gets
    const nums = Array.from({ length: 10 }, (_, i) => 900 + i)
    for (const num of nums)
      await task(t, f, f.sub, `Gearbox ${num}`, { num, description: 'x'.repeat(900_000) })
    SEAT_SHARE.bytes = 4 << 20
    // every term must match, so no task does, and the guest seat, whose
    // reads never began, is not counted as searched
    expect(await search(t, f.user, { text: nums.join(' ') })).toEqual({
      rows: [],
      next_cursor: null,
      coverage: stopped('reads', 1, 2),
    })
  })

  it("reads every seat's task numbers before any source", async () => {
    const t = newT()
    const f = await withOrg(t)
    const { sub } = await secondSeat(t, f)
    // home tasks large enough to spend the budget in the home seat's titles
    for (let i = 0; i < 10; i++)
      await task(t, f, f.sub, `Gearbox ${i}`, { description: 'x'.repeat(900_000) })
    const away = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: sub.id,
      title: 'Gearbox rebuilds',
      num: 7,
    })
    const page = await search(t, f.user, { text: 'QN-7 gearbox' })
    expect(ids(page)).toContain(away.id)
    expect(page.coverage).toEqual(stopped('reads', 2, 2))
  })

  it('keeps two searches for each seat after the one it plans', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { sub } = await secondSeat(t, f)
    const home = await task(t, f, f.sub, 'Gearbox teardown')
    const away = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: sub.id,
      title: 'Gearbox rebuilds',
    })
    // the home seat sees two projects, four searches, which would leave the
    // guest seat none
    MAIN_SEARCH.searches = 4
    const run = await searchRun(t, [f.user, ...(await seatsOf(t, f.user))], { text: 'gearbox' })
    expect(ids(run.page).sort()).toEqual([home.id, away.id].sort())
    expect(run.searches).toBe(4)
    // the home seat searched its organization whole, which is never complete
    expect(run.page.coverage).toEqual(stopped('projects', 2, 2))
  })
})

describe('main Search across seats', () => {
  it('answers alike whatever a hidden numbered task holds, at any allocation threshold', async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    MAIN_SEARCH.projects = 1
    const built = await broadSeats(t, login, 4)
    const seats = built.map((b) => b.seat)
    const nums = Array.from({ length: 11 }, (_, i) => 901 + i)
    const text = [...nums.map((num) => `QN-${num}`), 'gearbox'].join(' ')
    // visible matches in the later organizations
    for (const { org, sub } of built.slice(1))
      await plantIssue(t, {
        org_id: org,
        project_id: sub.id,
        title: `Gearbox ${nums.join(' ')}`,
        num: 50,
      })
    // in the first organization, numbered tasks the guest sees, whose
    // descriptions at LIMITS.description fill the reads before the old
    // allocation to its threshold, and one numbered task they cannot see
    const [{ org, sub }] = built
    for (const [i, num] of nums.slice(0, -1).entries())
      await plantIssue(t, {
        org_id: org,
        project_id: sub.id,
        num,
        description: i === 0 ? '' : '中'.repeat(LIMITS.description.max - 10),
      })
    const root = await plantProject(t, { org_id: org })
    const hidden = await plantProject(t, { org_id: org, type: 'project', parent_id: root.id })
    const secret = await plantIssue(t, { org_id: org, project_id: hidden.id, num: nums[10] })
    // its text grows 600 bytes at a time across the old threshold
    const pages: MainSearchPage[] = []
    for (let chars = 6_000; chars <= 8_600; chars += 200) {
      await setText(t, secret, '中'.repeat(chars))
      pages.push((await searchRun(t, seats, { text })).page)
    }
    for (const page of pages) expect(page).toEqual(pages[0])
    expect(pages[0].rows).toHaveLength(3)
  })

  it('answers alike whether a number names no task or a hidden task at the description limit', async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    // eight guest seats that see no project, so only number lookups read
    const orgs: string[] = []
    const seats: Doc<'profiles'>[] = []
    for (let i = 0; i < 8; i++) {
      const org = await plantOrg(t, i)
      orgs.push(org)
      seats.push(
        await plantSeat(t, {
          org_id: org,
          auth_user_id: login,
          org_role: 'guest',
          accepted_at: NOW,
        }),
      )
    }
    const nums = Array.from({ length: 12 }, (_, i) => 901 + i)
    const text = nums.map((num) => `QN-${num}`).join(' ')
    const answer = async () => {
      const { page } = await searchRun(t, seats, { text })
      return { rows: page.rows, coverage: page.coverage, more: page.next_cursor !== null }
    }
    const absent = await answer()
    // the last number now names a task in a project none of them sees,
    // with a description at LIMITS.description in a three-byte script
    const [first] = [...orgs].sort()
    const root = await plantProject(t, { org_id: first })
    const hidden = await plantProject(t, { org_id: first, type: 'project', parent_id: root.id })
    await plantIssue(t, {
      org_id: first,
      project_id: hidden.id,
      num: nums[11],
      description: '中'.repeat(LIMITS.description.max),
    })
    expect(await answer()).toEqual(absent)
    expect(absent).toEqual({ rows: [], coverage: COMPLETE, more: false })
  })

  it('counts no seat whose first number lookup the real limit refuses', async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    const orgs: string[] = []
    const seats: Doc<'profiles'>[] = []
    for (let i = 0; i < 8; i++) {
      const org = await plantOrg(t, i)
      orgs.push(org)
      seats.push(
        await plantSeat(t, {
          org_id: org,
          auth_user_id: login,
          org_role: 'guest',
          accepted_at: NOW,
        }),
      )
    }
    // the first seat's numbers name legacy rows near 1 MiB in a project none
    // of them sees, which spend the real limit while each lookup counts as
    // LOOKUP, so no later seat's first lookup fits
    const nums = Array.from({ length: 16 }, (_, i) => 901 + i)
    const [first] = [...orgs].sort()
    const root = await plantProject(t, { org_id: first })
    const hidden = await plantProject(t, { org_id: first, type: 'project', parent_id: root.id })
    for (const num of nums)
      await plantIssue(t, {
        org_id: first,
        project_id: hidden.id,
        num,
        description: 'x'.repeat(900_000),
      })
    const { page } = await searchRun(t, seats, { text: nums.map((num) => `QN-${num}`).join(' ') })
    expect(page.coverage).toEqual(stopped('reads', 1, 8))
  })

  it('keeps later seats and coverage alike whatever hidden tasks earlier organizations hold', async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    const built = await broadSeats(t, login, 4)
    const seats = built.map((b) => b.seat)
    const text = 'QN-7 gearbox'
    const [earlier, later] = [built.slice(0, 2), built.slice(2)]
    // visible matches everywhere, and in the later organizations a task the
    // number names
    for (const { org, sub } of built)
      await plantIssue(t, { org_id: org, project_id: sub.id, title: 'Gearbox 7 notes', num: 50 })
    for (const { org, sub } of later)
      await plantIssue(t, { org_id: org, project_id: sub.id, title: 'Gearbox', num: 7 })
    const laterOrgs = new Set(later.map((b) => b.org))
    // each seat searches its organization whole, or project by project,
    // with the default budget and with read caps across a band tight enough
    // that some cap sits beside any threshold a read could cross
    const modes = [1, DEFAULT_SEARCH.projects].flatMap((projects) => [
      { projects, ranges: DEFAULT_SEARCH.ranges },
      ...Array.from({ length: 16 }, (_, i) => ({ projects, ranges: 180 + 9 * i })),
    ])
    const answer = async ({ projects, ranges }: (typeof modes)[number]) => {
      MAIN_SEARCH.projects = projects
      MAIN_SEARCH.ranges = ranges
      SEAT_SHARE.ranges = ranges < DEFAULT_SEARCH.ranges ? 8 : DEFAULT_SHARE.ranges
      const { page } = await searchRun(t, seats, { text })
      return {
        later: page.rows.filter((row) => laterOrgs.has(row.org_id)),
        coverage: page.coverage,
        more: page.next_cursor !== null,
      }
    }
    const base = []
    for (const mode of modes) base.push(await answer(mode))
    for (const seed of [1, 2, 3, 4, 5]) {
      // hidden matches and hidden numbered tasks in the earlier
      // organizations, with descriptions within LIMITS.description
      const random = seeded(seed * 7919)
      const made: Doc<'projects'>[] = []
      for (const { org } of earlier) {
        const root = await plantProject(t, { org_id: org })
        const hidden = await plantProject(t, { org_id: org, type: 'project', parent_id: root.id })
        made.push(root, hidden)
        const size = () => '中'.repeat(Math.floor(random() * (LIMITS.description.max - 20)))
        await plantMany(t, Math.floor(random() * 30), () => ({
          org_id: org,
          project_id: hidden.id,
          title: random() < 0.5 ? 'Gearbox 7' : 'Planted',
          description: `${size()} gearbox 7`,
        }))
        if (random() < 0.7)
          await plantIssue(t, {
            org_id: org,
            project_id: hidden.id,
            num: 7,
            title: random() < 0.5 ? 'Gearbox' : 'Planted',
            description: size(),
          })
      }
      for (const [i, mode] of modes.entries()) expect(await answer(mode)).toEqual(base[i])
      // the next seed starts from the same visible data
      await t.run(async (ctx) => {
        for (const project of made) {
          const tasks = await ctx.db
            .query('issues')
            .withIndex('by_project', (q) => q.eq('project_id', project.id))
            .collect()
          for (const task of tasks) {
            for (const row of await ctx.db
              .query('issue_descriptions')
              .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
              .collect())
              await ctx.db.delete(row._id)
            await ctx.db.delete(task._id)
          }
          await ctx.db.delete(project._id)
        }
      })
    }
  })
})

describe('the scope of main Search', () => {
  it('narrows to a sub-project, a top-level project and an organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { sub: away } = await secondSeat(t, f)
    const a = await task(t, f, f.sub, 'Gearbox teardown')
    const b = await task(t, f, f.sub2, 'Gearbox rebuild')
    const elsewhere = await subOf(t, f, f.hidden)
    const c = await task(t, f, elsewhere, 'Gearbox spares')
    const d = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: away.id,
      title: 'Gearbox log',
    })
    const found = async (scope?: SearchScope) =>
      ids(await search(t, f.user, { text: 'gearbox', scope })).sort()
    expect(await found()).toEqual([a.id, b.id, c.id, d.id].sort())
    expect(await found({ org_id: f.org.id, project_id: f.sub.id })).toEqual([a.id])
    expect(await found({ org_id: f.org.id, project_id: f.meta.id })).toEqual([a.id, b.id].sort())
    expect(await found({ org_id: f.org.id })).toEqual([a.id, b.id, c.id].sort())
    expect(await found({ org_id: f.otherOrg.id })).toEqual([d.id])
  })

  it('answers the same empty, complete page for a scope the caller cannot use', async () => {
    const t = newT()
    const f = await withOrg(t)
    await task(t, f, f.sub, 'Gearbox teardown')
    const shelf = await subOf(t, f, f.meta, { archived_at: NOW })
    const elsewhere = await subOf(t, f, f.hidden)
    for (const scope of [
      { org_id: f.org.id, project_id: uuid() },
      { org_id: f.org.id, project_id: elsewhere.id },
      { org_id: f.org.id, project_id: shelf.id },
      { org_id: f.org.id, project_id: f.otherProject.id },
      { org_id: f.otherOrg.id },
      { org_id: uuid() },
    ])
      expect(await search(t, f.guest, { text: 'gearbox', scope })).toEqual(EMPTY)
  })
})

describe('searching project by project', () => {
  it('finds all of a guest’s matches among many hidden ones with a few search queries', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await subOf(t, f, f.hidden)
    await plantMany(t, 300, (i) => ({
      org_id: f.org.id,
      project_id: elsewhere.id,
      title: `Gearbox spare ${i}`,
      description: 'gearbox',
    }))
    const mine = [
      await task(t, f, f.sub, 'Gearbox teardown'),
      await task(t, f, f.sub2, 'Gearbox rebuild'),
      await task(t, f, f.sub2, 'Shaft', { description: 'for the gearbox' }),
    ]
    await withReach(t)
    MAIN_SEARCH.candidates = 100
    const guest = await searchRun(t, [f.guest], { text: 'gearbox' })
    expect(guest.page.rows.map((row) => row.id).sort()).toEqual(mine.map((m) => m.id).sort())
    expect(guest.page.coverage).toEqual(COMPLETE)
    // two projects, a title and a description query each, and no name query
    expect(guest.searches).toBe(4)
    // the organization's search reads the hidden tasks and stops at the
    // cap, after one query of its project names
    const admin = await searchRun(t, [f.admin], { text: 'gearbox' })
    expect(admin.searches).toBe(3)
    expect(admin.page.coverage).toEqual(stopped('candidates'))
  })

  it('searches a top-level project only while it holds a task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const mine = await task(t, f, f.sub, 'Gearbox teardown')
    // the guest's grant is on the top-level project, which holds no task
    expect((await searchRun(t, [f.guest], { text: 'gearbox' })).searches).toBe(4)
    // a task stored directly under it, as before sub-projects held them all
    const legacy = await task(t, f, f.meta, 'Gearbox legacy')
    const run = await searchRun(t, [f.guest], { text: 'gearbox' })
    expect(run.searches).toBe(6)
    expect(ids(run.page).sort()).toEqual([mine.id, legacy.id].sort())
    expect(run.page.coverage).toEqual(COMPLETE)
    expect(run.page.rows.find((row) => row.id === legacy.id)).toMatchObject({
      project: { id: f.meta.id },
      parent: null,
    })
    const scoped = await search(t, f.guest, {
      text: 'gearbox',
      scope: { org_id: f.org.id, project_id: f.meta.id },
    })
    expect(ids(scoped).sort()).toEqual([mine.id, legacy.id].sort())
  })

  it("lists a person's projects through team shares, never another organization's team", async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await task(t, f, f.sub, 'Gearbox teardown')
    const b = await task(t, f, f.sub2, 'Gearbox rebuild')
    const member = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
    const share = (team_id: string, project_id: string) =>
      t.run((ctx) => ctx.db.insert('project_team_access', { team_id, project_id, level: 'user' }))
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: member.id,
        is_leader: false,
      }),
    )
    // a team of another organization, sharing a project of this one
    const foreign = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('teams', {
        id: foreign,
        org_id: f.otherOrg.id,
        name: 'Foreign',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: foreign,
        profile_id: member.id,
        is_leader: false,
      })
    })
    await share(foreign, f.sub.id)
    const none = await searchRun(t, [member], { text: 'gearbox' })
    expect(none.page).toEqual(EMPTY)
    expect(none.searches).toBe(0)
    // a share on a sub-project
    const onSub = await share(f.team.id, f.sub.id)
    const one = await searchRun(t, [member], { text: 'gearbox' })
    expect(ids(one.page)).toEqual([a.id])
    expect(one.searches).toBe(2)
    // a share on the top-level project reaches its sub-projects
    await t.run((ctx) => ctx.db.delete(onSub))
    await share(f.team.id, f.meta.id)
    const all = await searchRun(t, [member], { text: 'gearbox' })
    expect(ids(all.page).sort()).toEqual([a.id, b.id].sort())
    expect(all.searches).toBe(4)
    expect(all.page.coverage).toEqual(COMPLETE)
  })

  it("lists a viewer seat's projects", async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await task(t, f, f.sub, 'Gearbox teardown')
    const run = await searchRun(t, [f.viewer], { text: 'gearbox' })
    expect(ids(run.page)).toEqual([a.id])
    expect(run.searches).toBe(4)
    expect(run.page.coverage).toEqual(COMPLETE)
  })

  it('reports no coverage that depends on tasks the person cannot see', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await subOf(t, f, f.hidden)
    await withReach(t)
    // the guest sees two sub-projects, more than one by one allows here, so
    // their search reads the whole organization
    MAIN_SEARCH.projects = 1
    MAIN_SEARCH.candidates = 4
    // they pad a project they see with one task fewer than the cap
    for (let i = 0; i < 3; i++) await task(t, f, f.sub, `Zebra ${i}`)
    const without = await searchRun(t, [f.guest], { text: 'zebra' })
    await task(t, f, elsewhere, 'Zebra hidden')
    const withHidden = await searchRun(t, [f.guest], { text: 'zebra' })
    expect(withHidden.page).toEqual(without.page)
    expect(without.page.coverage).toEqual(stopped('projects'))
    expect(without.page.rows).toHaveLength(3)
    // an admin, who sees every project, gets coverage from the cap
    expect((await searchRun(t, [f.admin], { text: 'zebra' })).page.coverage).toEqual(
      stopped('candidates'),
    )
    // the guest's search project by project reads no hidden task and is
    // exact
    MAIN_SEARCH.projects = DEFAULT_SEARCH.projects
    expect((await searchRun(t, [f.guest], { text: 'zebra' })).page.coverage).toEqual(COMPLETE)
  })

  it('stops with reads, inside the limits, while it lists projects with large rows', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // projects the guest leads, each row near Convex's 1 MiB, as a legacy
    // icon or text can make it
    for (let i = 0; i < 20; i++)
      await plantProject(t, {
        org_id: f.org.id,
        lead_id: f.guest.id,
        description: 'x'.repeat(900_000),
      })
    const run = await searchRun(t, [f.guest], { text: 'gearbox' })
    expect(run.page).toEqual({ rows: [], next_cursor: null, coverage: stopped('reads', 0, 1) })
    expect(run.read.bytes).toBeLessThan(16 << 20)
  })

  it('searches the organization for a person who sees more sub-projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const mine = await task(t, f, f.sub, 'Gearbox teardown')
    expect((await searchRun(t, [f.guest], { text: 'gearbox' })).searches).toBe(4)
    MAIN_SEARCH.projects = 1
    const run = await searchRun(t, [f.guest], { text: 'gearbox' })
    expect(run.searches).toBe(2)
    expect(run.page.rows.map((row) => row.id)).toEqual([mine.id])
    // and when the projects' queries would pass the searches left
    MAIN_SEARCH.projects = 8
    MAIN_SEARCH.searches = 3
    expect((await searchRun(t, [f.guest], { text: 'gearbox' })).searches).toBe(2)
  })
})

describe('the order of main Search', () => {
  it('ranks the reference, an equal title, a phrase, the title, a split, then the description', async () => {
    const t = newT()
    const f = await withOrg(t)
    const description = await task(t, f, f.sub, 'Calibration', {
      description: 'the torque sensor drifts',
    })
    const split = await task(t, f, f.sub, 'Torque rig', { description: 'its sensor drifts' })
    const title = await task(t, f, f.sub, 'Sensor for torque')
    const phrase = await task(t, f, f.sub, 'Calibrate the torque sensor')
    const equal = await task(t, f, f.sub, 'Torque sensor')
    expect(ids(await search(t, f.user, { text: 'torque sensor' }))).toEqual([
      equal.id,
      phrase.id,
      title.id,
      split.id,
      description.id,
    ])
    // the task with the number first, then a title that is the number
    const named = await task(t, f, f.sub, `${equal.num}`)
    expect(ids(await search(t, f.user, { text: `QN-${equal.num}` }))).toEqual([equal.id, named.id])
  })

  it('orders equal scores by seat, then newest number, then id', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { sub: away } = await secondSeat(t, f)
    const older = await task(t, f, f.sub, 'Gearbox', { num: 10 })
    const newer = await task(t, f, f.sub2, 'Gearbox', { num: 11 })
    const guestSeat = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: away.id,
      title: 'Gearbox',
      num: 99,
    })
    expect(ids(await search(t, f.user, { text: 'gearbox' }))).toEqual([
      newer.id,
      older.id,
      guestSeat.id,
    ])
    // description-only matches follow by id, as their numbers are not read
    const x = await task(t, f, f.sub, 'Planted', { description: 'flywheel', num: 20 })
    const y = await task(t, f, f.sub, 'Planted', { description: 'flywheel', num: 21 })
    expect(ids(await search(t, f.user, { text: 'flywheel' }))).toEqual([x.id, y.id].sort())
  })
})

describe('paging through main Search', () => {
  it('returns each match once, in the order of one large page', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const [i, title] of [
      'Gearbox',
      'Gearbox teardown',
      'Rebuild the gearbox',
      'Gearbox spares and bearings',
      'Shaft',
      'Housing',
      'Seal kit',
    ].entries())
      await task(t, f, i % 2 ? f.sub : f.sub2, title, { description: 'gearbox' })
    const whole = await search(t, f.user, { text: 'gearbox' })
    expect(whole.rows).toHaveLength(7)
    expect(whole.next_cursor).toBeNull()
    MAIN_SEARCH.rows = 3
    const walked: string[] = []
    let cursor: string | undefined
    for (let n = 0; n < 5; n++) {
      const page = await search(t, f.user, { text: 'gearbox', cursor })
      walked.push(...ids(page))
      expect(page.coverage).toEqual(COMPLETE)
      if (page.next_cursor === null) break
      expect(page.rows).toHaveLength(3)
      cursor = page.next_cursor
      // a task created between two pages does not repeat a row
      if (n === 0) await task(t, f, f.sub, 'Gearbox', { description: 'gearbox' })
    }
    expect(walked).toEqual(ids(whole))
  })

  it('refuses a cursor from another search, a changed one and a malformed one', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const title of ['Gearbox', 'Gearbox teardown', 'Gearbox rebuild'])
      await task(t, f, f.sub, title)
    MAIN_SEARCH.rows = 1
    const first = await search(t, f.user, { text: 'gearbox' })
    const cursor = first.next_cursor as string
    expect(cursor).toMatch(/^s1~[0-9a-f]+$/)
    expect(ids(await search(t, f.user, { text: 'gearbox', cursor }))).toHaveLength(1)
    // the same terms written another way keep the cursor
    expect(ids(await search(t, f.user, { text: ' GEARBOX ', cursor }))).toHaveLength(1)
    const flipped = cursor.slice(0, -1) + (cursor.endsWith('0') ? '1' : '0')
    for (const a of [
      { text: 'gear', cursor },
      { text: 'gearbox', cursor, include_archived: true },
      { text: 'gearbox', cursor, scope: { org_id: f.org.id } },
      { text: 'gearbox', cursor: flipped },
      { text: 'gearbox', cursor: 'nope' },
      { text: 'gearbox', cursor: 's1~zz' },
      { text: 'gearbox', cursor: `2~${cursor.slice(3)}` },
      { text: '', cursor },
    ])
      await expectRefusal(
        search(t, f.user, a),
        'bad_request',
        /^cursor must be the next_cursor of an earlier page$/,
      )
  })
})

describe("description rows' copies", () => {
  it('never shows a task whose copies say active and visible while it is not', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await subOf(t, f, f.hidden)
    const shelved = await task(t, f, f.sub, 'Planted', { description: 'flux capacitor' })
    const moved = await task(t, f, f.sub, 'Planted', { description: 'flux capacitor' })
    const kept = await task(t, f, f.sub, 'Planted', { description: 'flux capacitor' })
    // as a release from before the table leaves them: the task row changed
    // without its description row
    await t.run(async (ctx) => {
      await ctx.db.patch(shelved._id, { archived_at: NOW })
      await ctx.db.patch(moved._id, { project_id: elsewhere.id })
    })
    for (const who of [f.guest, f.admin]) {
      const page = await search(t, who, { text: 'capacitor' })
      expect(ids(page)).toEqual(who === f.admin ? [kept.id, moved.id].sort() : [kept.id])
    }
  })

  it('never shows a task for the text of a second description row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shown = await task(t, f, f.sub, 'Planted', { description: 'plain notes' })
    // repeated rollbacks can leave a second row with the copies and other text
    await t.run((ctx) =>
      ctx.db.insert('issue_descriptions', {
        issue_id: shown.id,
        org_id: f.org.id,
        project_id: f.sub.id,
        description: 'flux capacitor',
      }),
    )
    expect(await descriptionHits(t, f, 'capacitor')).toEqual([shown.id])
    expect(ids(await search(t, f.user, { text: 'capacitor' }))).toEqual([])
    expect(ids(await search(t, f.user, { text: 'plain' }))).toEqual([shown.id])
  })

  it('reads the task of a description match when Convex did not take every term', async () => {
    const t = newT()
    const f = await withOrg(t)
    const words = Array.from({ length: 16 }, (_, i) => `w${i}`)
    // the title holds only the 17th term, which no search query takes
    const found = await task(t, f, f.sub, 'Zeta', { description: words.join(' ') })
    expect(ids(await search(t, f.user, { text: [...words, 'zeta'].join(' ') }))).toEqual([found.id])
  })

  it('judges a row without copies from its task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await task(t, f, f.sub, 'Planted', {
      description: 'flux capacitor',
      archived_at: NOW,
    })
    const active = await task(t, f, f.sub, 'Planted', { description: 'flux capacitor' })
    await t.run(async (ctx) => {
      for (const id of [archived.id, active.id]) {
        const row = await ctx.db
          .query('issue_descriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .unique()
        if (row !== null)
          await ctx.db.patch(row._id, { project_id: undefined, archived_at: undefined })
      }
    })
    expect(ids(await search(t, f.admin, { text: 'capacitor' }))).toEqual([active.id])
    expect(
      ids(await search(t, f.admin, { text: 'capacitor', include_archived: true })).sort(),
    ).toEqual([archived.id, active.id].sort())
  })
})

describe('the coverage of main Search', () => {
  it('says which stop kept it from covering everything', async () => {
    const t = newT()
    const f = await withOrg(t)
    await secondSeat(t, f)
    for (let i = 0; i < 5; i++) await task(t, f, f.sub, `Gearbox ${i}`)
    expect((await search(t, f.user, { text: 'gearbox' })).coverage).toEqual(COMPLETE)
    MAIN_SEARCH.candidates = 2
    const capped = await search(t, f.user, { text: 'gearbox' })
    expect(capped.coverage).toEqual(stopped('candidates', 2, 2))
    expect(capped.rows.length).toBeGreaterThan(0)
    MAIN_SEARCH.seats = 1
    // a source's stop comes first, beside the seats left out
    expect((await search(t, f.user, { text: 'gearbox' })).coverage).toEqual(
      stopped('candidates', 1, 2),
    )
    MAIN_SEARCH.candidates = DEFAULT_SEARCH.candidates
    expect((await search(t, f.user, { text: 'gearbox' })).coverage).toEqual(
      stopped('organizations', 1, 2),
    )
    MAIN_SEARCH.seats = DEFAULT_SEARCH.seats
    // a budget that holds no read: no rows, never complete, and no seat
    // counted as searched
    MAIN_SEARCH.bytes = 1
    expect(await search(t, f.user, { text: 'gearbox', scope: { org_id: f.org.id } })).toEqual({
      rows: [],
      next_cursor: null,
      coverage: stopped('reads', 0, 1),
    })
    expect((await search(t, f.user, { text: 'gearbox' })).coverage).toEqual(stopped('reads', 0, 2))
    // nor when it runs out while it asks about the scope's project
    expect(
      await search(t, f.user, {
        text: 'gearbox',
        scope: { org_id: f.org.id, project_id: f.sub.id },
      }),
    ).toEqual({ rows: [], next_cursor: null, coverage: stopped('reads', 0, 1) })
  })

  it('stops with reads once it has parsed MAIN_SEARCH.parse characters', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++)
      await task(t, f, f.sub, 'Planted', {
        description: `flywheel notes in the [ guide ]( example.com/${i} )`,
      })
    // a description without a link, an image or a mention is not parsed
    await task(t, f, f.sub, 'Planted', { description: 'flywheel notes, plain' })
    expect(ids(await search(t, f.user, { text: 'flywheel' }))).toHaveLength(4)
    MAIN_SEARCH.parse = 60
    const page = await search(t, f.user, { text: 'flywheel' })
    expect(page.coverage).toEqual(stopped('reads'))
    expect(page.rows.length).toBeLessThan(4)
  })

  it('shows the description matches the gathering parsed, with a parse allowance of its own', async () => {
    const t = newT()
    const f = await withOrg(t)
    const description = (i: number) => `flywheel notes in the [ guide ]( example.com/${i} )`
    const found: string[] = []
    for (let i = 0; i < 3; i++)
      found.push((await task(t, f, f.sub, 'Planted', { description: description(i) })).id)
    // just what the gathering parses, so the page parses on an allowance of
    // its own
    MAIN_SEARCH.parse = [0, 1, 2].reduce((sum, i) => sum + description(i).length, 0)
    const page = await search(t, f.user, { text: 'flywheel' })
    expect(ids(page).sort()).toEqual([...found].sort())
    expect(page.coverage).toEqual(COMPLETE)
    // a page whose allowance holds one text still shows its first row, so
    // paging goes on to every match
    MAIN_SEARCH.pageParse = 1
    const walked: string[] = []
    let cursor: string | undefined
    for (let n = 0; n < 5; n++) {
      const next = await search(t, f.user, { text: 'flywheel', cursor })
      expect(next.rows).toHaveLength(1)
      walked.push(...ids(next))
      if (next.next_cursor === null) break
      cursor = next.next_cursor
    }
    expect(walked).toEqual(ids(page))
  })

  it('pays for leaving archived tasks out after the query when the index cannot', async () => {
    const t = newT()
    const f = await withOrg(t)
    await withReach(t)
    for (let i = 0; i < 3; i++) await task(t, f, f.sub, `Gearbox ${i}`, { archived_at: NOW })
    const active = [await task(t, f, f.sub, 'Gearbox a'), await task(t, f, f.sub, 'Gearbox b')]
    MAIN_SEARCH.candidates = 3
    const byIndex = await search(t, f.admin, { text: 'gearbox' })
    expect(ids(byIndex).sort()).toEqual(active.map((a) => a.id).sort())
    expect(byIndex.coverage).toEqual(COMPLETE)
    ARCHIVED_FILTER.byIndex = false
    const after = await search(t, f.admin, { text: 'gearbox' })
    expect(after.coverage).toEqual(stopped('candidates'))
    for (const row of after.rows) expect(row).toMatchObject({ kind: 'task', archived: false })
  })

  it('reads nothing for a blank text or one of punctuation only', async () => {
    const t = newT()
    const f = await withOrg(t)
    await task(t, f, f.sub, 'Gearbox')
    for (const text of ['', '   ', '-- !! ...']) {
      const run = await searchRun(t, [f.user], { text })
      expect(run.page).toEqual(EMPTY)
      expect(run.read).toEqual({ ranges: 0, documents: 0, bytes: 0 })
      expect(run.searches).toBe(0)
    }
  })

  it('refuses a text past the search limit with its sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const refusal = await expectRefusal(
      search(t, f.user, { text: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(refusal.data.message).toBe(LIMITS.search.refusal)
    expect(await search(t, f.user, { text: 'x'.repeat(LIMITS.search.max) })).toEqual(EMPTY)
  })
})

describe('main Search at Convex’s limits', () => {
  it('stops with reads, inside the limits, among 600 matches with the largest descriptions', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await withReach(t)
    const long = '中'.repeat(LIMITS.description.max - 8)
    await plantMany(
      t,
      300,
      (i) => ({ org_id: f.org.id, project_id: f.sub.id, title: `Gearbox ${i}`, description: long }),
      10,
    )
    await plantMany(
      t,
      300,
      (i) => ({
        org_id: f.org.id,
        project_id: f.sub2.id,
        num: 60_000 + i,
        description: `${long} gearbox`,
      }),
      10,
    )
    for (const who of [f.admin, f.guest]) {
      const run = await searchRun(t, [who], { text: 'gearbox' })
      console.log('600 large matches', who.name, run.read, run.searches, run.page.rows.length)
      expect(run.page.coverage).toEqual(stopped('reads'))
      expect(run.page.rows).toHaveLength(MAIN_SEARCH.rows)
      expect(run.read.bytes).toBeLessThan(16 << 20)
    }
  })

  it('ends a page early, inside the limits, among rows near the document size limit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await withReach(t)
    // rows over the caps, as older data can hold, near Convex's 1 MiB
    const huge = 'x'.repeat(900_000)
    for (let i = 0; i < 24; i++)
      await plantMany(
        t,
        1,
        () => ({
          org_id: f.org.id,
          project_id: f.sub.id,
          num: 80_000 + i,
          description: `zebra ${huge}`,
        }),
        1,
      )
    const run = await searchRun(t, [f.admin], { text: 'zebra' })
    console.log('24 rows near 1 MiB', run.read, run.searches, run.page.rows.length)
    expect(run.page.coverage).toEqual(stopped('reads'))
    expect(run.read.bytes).toBeLessThan(16 << 20)
  })

  it('covers a Northstar-sized organization', async () => {
    const t = newT({ transactionLimits: true })
    const { org, profiles } = await plantNorthstar(t)
    // a seeded organization holds nav_at from its creation
    await stampNav(t, org.id)
    const nora = profiles.find((p) => p.auth_user_id === 'auth_nora')
    if (nora === undefined) throw new Error('no Nora')
    const projectsFor: Record<string, string[]> = {
      sensor: ['Luma Sensor'],
      the: [],
      'QN-12': [],
      'firmware board': [],
      industrial: ['Mechanical & Industrial Design'],
    }
    // Leo sees all 15 projects through his teams' shares, project by project
    const leo = profiles.find((p) => p.auth_user_id === 'auth_leo')
    if (leo === undefined) throw new Error('no Leo')
    for (const [text, names] of Object.entries(projectsFor))
      for (const who of [nora, leo]) {
        const run = await searchRun(t, [who], { text, include_archived: true })
        console.log('Northstar', who.name, text, run.read, run.searches, run.page.rows.length)
        expect(run.page.coverage).toEqual(COMPLETE)
        expect(projectNames(run.page)).toEqual(names)
      }
  })
})

/** The ids of a page's project rows, in order. */
const projectIds = (page: MainSearchPage) =>
  page.rows.flatMap((row) => (row.kind === 'project' ? [row.id] : []))

/** The ids of a page's task rows, in order. */
const taskIds = (page: MainSearchPage) =>
  page.rows.flatMap((row) => (row.kind === 'task' ? [row.id] : []))

/** Adds `word` to the name of every project, so one search finds them
 * all. */
const nameAll = (t: T, word: string) =>
  t.run(async (ctx) => {
    for (const p of await ctx.db.query('projects').collect())
      await ctx.db.patch(p._id, { name: `${p.name} ${word}` })
  })

/* Distinct keys and numbers for plantProjects. */
let plantedProjects = 0

/** `count` sub-projects of organization `orgId`, a batch of rows a
 * transaction, each with the fields `project` gives it. */
async function plantProjects(
  t: T,
  orgId: string,
  count: number,
  project: (i: number) => Partial<WithoutSystemFields<Doc<'projects'>>>,
  batch = 50,
): Promise<string[]> {
  const out: string[] = []
  for (let from = 0; from < count; from += batch)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + batch); i++) {
        const id = uuid()
        const n = plantedProjects++
        await ctx.db.insert('projects', {
          id,
          org_id: orgId,
          type: 'project',
          key: `Q${n}`,
          name: `Planted ${n}`,
          description: '',
          sort_order: n,
          num: 10_000 + n,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
          ...project(i),
        })
        out.push(id)
      }
    })
  return out
}

/** A member of the fixture's organization with a login, in no team and
 * holding nothing. */
const plantMember = async (t: T, f: OrgFixture) =>
  await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))

/** A user grant of `profile` on `project`. */
const grant = (t: T, project: Doc<'projects'>, profile: Doc<'profiles'>) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: project.id,
      profile_id: profile.id,
      level: 'user',
    }),
  )

/** The project ids of one search as `who` on each path: project by project
 * as planning chooses, and of the whole organization (MAIN_SEARCH.projects
 * 0). An admin is searched whole on both. */
async function bothPaths(t: T, who: Doc<'profiles'>[], a: Args) {
  const out: string[][] = []
  for (const projects of [DEFAULT_SEARCH.projects, 0]) {
    MAIN_SEARCH.projects = projects
    out.push(projectIds((await searchRun(t, who, a)).page))
  }
  MAIN_SEARCH.projects = DEFAULT_SEARCH.projects
  return out
}

describe('the project results of main Search', () => {
  it('matches a project by the words of its own name only', async () => {
    const t = newT()
    const f = await withOrg(t)
    await task(t, f, f.sub, 'Calibrate the rig')
    await task(t, f, f.sub2, 'Gearbox teardown')
    const rev = await subOf(t, f, f.meta, { name: 'Rev 12 harness', key: 'REVH' })
    await withReach(t)
    // f.user leads TBED and SKNK, searched project by project and whole,
    // and the admin, searched whole
    for (const projects of [DEFAULT_SEARCH.projects, 0]) {
      MAIN_SEARCH.projects = projects
      for (const who of [f.user, f.admin]) {
        const found = async (text: string) => ids((await searchRun(t, [who], { text })).page)
        // a project's name brings none of its tasks
        expect(await found('firmware')).toEqual([f.sub.id])
        // a word of a name, and the last word's prefix
        // the phrase at the start of a name ranks first
        expect(await found('rev')).toEqual([rev.id, f.sub2.id])
        expect(await found('board re')).toEqual([f.sub2.id])
        expect(await found('testbed plat')).toEqual([f.meta.id])
        // every term must match
        expect(await found('firmware gearbox')).toEqual([])
        // the key and the number are no part of the name
        expect(await found('fw')).toEqual([])
        expect(await found('revh')).toEqual([])
        expect(await found(`${f.sub2.num}`)).toEqual([])
        // a reference term matches a word of the name, as in a task's title
        expect(await found('12')).toEqual([rev.id])
        expect(await found('QN-12')).toEqual([rev.id])
        // a parent's name finds none of its sub-projects
        expect(await found('testbed')).toEqual([f.meta.id])
        expect(await found('skunkworks')).toEqual([f.hidden.id])
      }
    }
  })

  it('names a sub-project’s top-level project and nothing else', async () => {
    const t = newT()
    const f = await withOrg(t)
    await withReach(t)
    for (const who of [f.user, f.admin]) {
      expect((await search(t, who, { text: 'firmware' })).rows).toEqual([
        {
          kind: 'project',
          org_id: f.org.id,
          id: f.sub.id,
          name: 'Firmware',
          parent: { id: f.meta.id, name: 'Testbed platform' },
        },
      ])
      expect((await search(t, who, { text: 'testbed' })).rows).toEqual([
        {
          kind: 'project',
          org_id: f.org.id,
          id: f.meta.id,
          name: 'Testbed platform',
          parent: null,
        },
      ])
    }
  })

  it('shows live projects only, with the archived toggle off or on', async () => {
    const t = newT()
    const f = await withOrg(t)
    await subOf(t, f, f.meta, { name: 'Gearbox shelf', archived_at: NOW })
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      name: 'Gearbox archive',
      lead_id: f.user.id,
      archived_at: NOW,
    })
    await subOf(t, f, shelved, { name: 'Gearbox old', archived_at: NOW })
    const gone = await subOf(t, f, f.meta, { name: 'Gearbox gone' })
    await deleteProject(t, f, gone.id)
    const live = await subOf(t, f, f.meta, { name: 'Gearbox live' })
    await withReach(t)
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query('projects').collect()).map((p) => p.archive_state),
      ),
    ).toContain('under')
    for (const include_archived of [false, true])
      for (const who of [[f.user], [f.admin]])
        expect(await bothPaths(t, who, { text: 'gearbox', include_archived })).toEqual([
          [live.id],
          [live.id],
        ])
  })

  it('shows each person the projects ordinary access lets them see', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const { sub: away } = await secondSeat(t, f)
    const member = await plantMember(t, f)
    const teamMember = await plantMember(t, f)
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: teamMember.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        team_id: f.team.id,
        project_id: f.sub.id,
        level: 'user',
      })
    })
    await nameAll(t, 'zephyr')
    await withReach(t)
    const sorted = (...projects: Doc<'projects'>[]) => projects.map((p) => p.id).sort()
    const sees = async (who: Doc<'profiles'>[]) =>
      (await bothPaths(t, who, { text: 'zephyr' })).map((found) => [...found].sort())
    // the guest sees TBED to reach FW and PCB, never the sibling or SKNK
    expect(await sees([f.guest])).toEqual(Array(2).fill(sorted(f.meta, f.sub, f.sub2)))
    expect(await sees([member])).toEqual([[], []])
    // a team share on a sub-project shows it and its parent
    expect(await sees([teamMember])).toEqual(Array(2).fill(sorted(f.meta, f.sub)))
    // the viewer's grant on TBED reaches its sub-projects
    expect(await sees([f.viewer])).toEqual(Array(2).fill(sorted(f.meta, f.sub, f.sub2, sibling)))
    // a second seat adds its organization's projects
    const user = [f.user, ...(await seatsOf(t, f.user))]
    expect(await sees(user)).toEqual(
      Array(2).fill(sorted(f.meta, f.sub, f.sub2, sibling, f.hidden, f.otherProject, away)),
    )
    // today an admin leads every project of a meta's tree (lib/access.ts
    // levelUnder); the admin access split leaves out what they hold nothing on
    const adminSees = sorted(f.meta, f.sub, f.sub2, sibling, f.hidden)
    expect(await sees([f.admin])).toEqual([adminSees, adminSees])
  })

  it('shows exactly the live projects canSeeProject shows, for every access shape, on both paths', async () => {
    const extra: Shape[] = [
      [
        'user team share on an archived sub-project',
        async (ctx: MutationCtx, f: OrgFixture, me: Doc<'profiles'>) => {
          await ctx.db.patch(f.sub._id, { archived_at: NOW })
          await ctx.db.insert('team_members', {
            team_id: f.team.id,
            profile_id: me.id,
            is_leader: false,
          })
          await ctx.db.insert('project_team_access', {
            team_id: f.team.id,
            project_id: f.sub.id,
            level: 'user',
          })
        },
      ],
    ]
    const seen = new Set<number>()
    for (const [name, plant] of [...SHAPES, ...extra]) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await nameAll(t, 'zephyr')
      await withReach(t)
      for (const org_role of ['user', 'viewer', 'guest'] as const) {
        const me = { ...subject, org_role }
        const expected = await t.run(async (ctx) => {
          const out: string[] = []
          const projects = await ctx.db
            .query('projects')
            .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
            .collect()
          for (const p of projects)
            if (p.archived_at === undefined && (await canSeeProject(ctx, me, p))) out.push(p.id)
          return out.sort()
        })
        seen.add(expected.length)
        const [listed, whole] = await bothPaths(t, [me], { text: 'zephyr' })
        expect([...listed].sort(), `${name} as ${org_role}, project by project`).toEqual(expected)
        expect([...whole].sort(), `${name} as ${org_role}, whole`).toEqual(expected)
      }
    }
    // the shapes show no project, a parent for navigation alone, and more
    expect([...seen].sort()).toEqual([0, 1, 2, 3])
  }, 180_000)

  it('narrows project results as it narrows tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const { sub: away } = await secondSeat(t, f)
    await nameAll(t, 'zephyr')
    await withReach(t)
    const sorted = (...projects: Doc<'projects'>[]) => projects.map((p) => p.id).sort()
    const found = async (who: Doc<'profiles'>, scope?: SearchScope) =>
      projectIds(await search(t, who, { text: 'zephyr', scope })).sort()
    expect(await found(f.guest, { org_id: f.org.id, project_id: f.sub.id })).toEqual([f.sub.id])
    expect(await found(f.user, { org_id: f.org.id, project_id: f.sub.id })).toEqual([f.sub.id])
    expect(await found(f.guest, { org_id: f.org.id, project_id: f.meta.id })).toEqual(
      sorted(f.meta, f.sub, f.sub2),
    )
    expect(await found(f.user, { org_id: f.org.id, project_id: f.meta.id })).toEqual(
      sorted(f.meta, f.sub, f.sub2, sibling),
    )
    expect(await found(f.user, { org_id: f.org.id })).toEqual(
      sorted(f.meta, f.sub, f.sub2, sibling, f.hidden),
    )
    expect(await found(f.user, { org_id: f.otherOrg.id })).toEqual(sorted(f.otherProject, away))
    // a top-level project with more sub-projects than one listing holds,
    // whose seat is searched whole, shows only its family's visible projects
    MAIN_SEARCH.listing = 2
    const scope = { org_id: f.org.id, project_id: f.meta.id }
    const run = await searchRun(t, [f.guest], { text: 'zephyr', scope })
    expect(projectIds(run.page).sort()).toEqual(sorted(f.meta, f.sub, f.sub2))
    expect(run.page.coverage).toEqual(stopped('projects'))
    expect(run.searches).toBe(3)
    // a seat that also sees a matching project outside the family, SKNK,
    // finds it only outside the scope
    const user = await searchRun(t, [f.user], { text: 'zephyr', scope })
    expect(user.searches).toBe(3)
    expect(projectIds(user.page).sort()).toEqual(sorted(f.meta, f.sub, f.sub2, sibling))
    expect(projectIds((await searchRun(t, [f.user], { text: 'zephyr' })).page)).toContain(
      f.hidden.id,
    )
  })

  it('lets no hidden project name change a search of projects one by one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const rig = await subOf(t, f, f.meta, { name: 'Zephyr rig' })
    await task(t, f, f.sub, 'Zephyr teardown')
    await withReach(t)
    const without = await searchRun(t, [f.guest], { text: 'zephyr' })
    expect(projectIds(without.page)).toEqual([rig.id])
    expect(without.page.coverage).toEqual(COMPLETE)
    // FW, PCB and the rig, a title and a description query each
    expect(without.searches).toBe(6)
    await plantProjects(t, f.org.id, 25, (i) => ({ type: 'meta', name: `Zephyr ${i}` }))
    await plantProjects(t, f.org.id, 25, (i) => ({ parent_id: f.hidden.id, name: `Zephyr ${i}` }))
    await withReach(t)
    const withHidden = await searchRun(t, [f.guest], { text: 'zephyr' })
    expect(withHidden.page).toEqual(without.page)
    expect(withHidden.searches).toBe(without.searches)
    expect(withHidden.read).toEqual(without.read)
  })

  it("never lets hidden project names in one seat's organization change what another seat reads", async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    MAIN_SEARCH.projects = 1
    const built = await broadSeats(t, login, 7)
    for (const { org, sub } of built) {
      await plantIssue(t, { org_id: org, project_id: sub.id, title: 'Gearbox' })
      await t.run((ctx) => ctx.db.patch(sub._id, { name: 'Gearbox rig' }))
    }
    await withReach(t)
    const without = await searchRun(
      t,
      built.map((b) => b.seat),
      { text: 'gearbox' },
    )
    // hidden projects named the text in the first six organizations
    for (const { org } of built.slice(0, 6)) {
      const top = await plantProjects(t, org, 12, (i) => ({ type: 'meta', name: `Gearbox ${i}` }))
      await plantProjects(t, org, 24, (i) => ({
        parent_id: top[i % top.length],
        name: `Gearbox spare ${i}`,
        description: 'x'.repeat(20_000),
      }))
    }
    await withReach(t)
    const withHidden = await searchRun(
      t,
      built.map((b) => b.seat),
      { text: 'gearbox' },
    )
    expect(withHidden.page).toEqual(without.page)
    expect(without.page.coverage).toMatchObject({ complete: false, stopped: 'projects', of: 7 })
    expect(projectIds(without.page).length).toBeGreaterThan(0)
  })

  it('judges a top-level project without walking its sub-projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const member = await plantMember(t, f)
    const hiddenTop = await plantProject(t, { org_id: f.org.id, name: 'Zephyr hidden' })
    await plantProjects(t, f.org.id, 300, () => ({ parent_id: hiddenTop.id }))
    const seenTop = await plantProject(t, { org_id: f.org.id, name: 'Zephyr seen' })
    const granted = await subOf(t, f, seenTop)
    await grant(t, granted, member)
    await plantProjects(t, f.org.id, 300, () => ({ parent_id: seenTop.id }))
    await withReach(t)
    // the member's whole organization
    MAIN_SEARCH.projects = 0
    for (const roots of [DEFAULT_SIGHT.roots, 0]) {
      // with the root rows read first, and with each project checked alone
      PROJECT_SIGHT.roots = roots
      const run = await searchRun(t, [member], { text: 'zephyr' })
      console.log('no navigation walk, roots', roots, run.read, run.searches)
      expect(projectIds(run.page)).toEqual([seenTop.id])
      expect(run.page.coverage).toEqual(stopped('projects'))
      expect(run.read.documents).toBeLessThan(40)
      expect(run.read.ranges).toBeLessThan(40)
    }
  })

  it('counts a reach row only for a sub-project of the project it judges', async () => {
    const t = newT()
    const f = await withOrg(t)
    const member = await plantMember(t, f)
    await grant(t, f.sub, member)
    const hiddenTop = await plantProject(t, { org_id: f.org.id, name: 'Zephyr hidden' })
    await withReach(t)
    // rows a Deleted items move or a reused id can leave: a root row on the
    // hidden project and child rows under it that name FW, a sub-project of
    // another parent the member sees, and SKNK, a top-level project
    await t.run(async (ctx) => {
      const row = {
        org_id: f.org.id,
        grantee_kind: 'profile' as const,
        grantee_id: member.id,
        root_id: hiddenTop.id,
        key: hiddenTop.key,
        live: true,
        on_root: false,
      }
      await ctx.db.insert('project_reach', {
        ...row,
        kind: 'root',
        project_id: hiddenTop.id,
        name_key: 'zephyr hidden',
      })
      for (const p of [f.sub, f.hidden])
        await ctx.db.insert('project_reach', {
          ...row,
          kind: 'child',
          project_id: p.id,
          name_key: 'a',
        })
    })
    MAIN_SEARCH.projects = 0
    const run = await searchRun(t, [member], { text: 'zephyr' })
    expect(run.page.rows).toEqual([])
    // and the real ones still show
    expect(projectIds((await searchRun(t, [member], { text: 'firmware' })).page)).toEqual([
      f.sub.id,
    ])
    expect(projectIds((await searchRun(t, [member], { text: 'testbed' })).page)).toEqual([
      f.meta.id,
    ])
  })

  it('misses a parent whose first child rows all fail, never shows one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const member = await plantMember(t, f)
    await grant(t, f.sub, member)
    await withReach(t)
    // a stale child row under TBED that sorts first and names a project
    // that is gone
    await t.run((ctx) =>
      ctx.db.insert('project_reach', {
        org_id: f.org.id,
        grantee_kind: 'profile',
        grantee_id: member.id,
        kind: 'child',
        project_id: uuid(),
        root_id: f.meta.id,
        name_key: 'a',
        key: 'GONE',
        live: false,
        on_root: false,
      }),
    )
    MAIN_SEARCH.projects = 0
    const found = async () => (await searchRun(t, [member], { text: 'testbed' })).page
    expect(projectIds(await found())).toEqual([f.meta.id])
    PROJECT_SIGHT.children = 1
    const missed = await found()
    expect(missed.rows).toEqual([])
    // a seat searched whole that does not see every project says so
    expect(missed.coverage).toEqual(stopped('projects'))
    // searched project by project it needs no reach rows
    MAIN_SEARCH.projects = DEFAULT_SEARCH.projects
    expect(projectIds(await found())).toEqual([f.meta.id])
  })

  it("reads each of an admin's name candidates once", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantProjects(t, f.org.id, 10, (i) => ({ type: 'meta', name: `Zephyr ${i}` }))
    await withReach(t)
    const none = await searchRun(t, [f.admin], { text: 'quokka' })
    const ten = await searchRun(t, [f.admin], { text: 'zephyr' })
    expect(projectIds(ten.page)).toHaveLength(10)
    expect(ten.searches).toBe(none.searches)
    // one document each and no read of its row by id, which would add a
    // range and a document; convex-test counts no range for a search result,
    // where Convex counts one
    expect(ten.read.documents - none.read.documents).toBe(10)
    expect(ten.read.ranges - none.read.ranges).toBe(0)
  })

  it('leaves the names of an organization without nav_at out of a search of it whole', async () => {
    const t = newT()
    const f = await withOrg(t)
    const torque = await task(t, f, f.sub, 'Firmware torque')
    const unready = await searchRun(t, [f.admin], { text: 'firmware' })
    expect(unready.page.rows.map((row) => row.kind)).toEqual(['task'])
    expect(taskIds(unready.page)).toEqual([torque.id])
    expect(unready.page.coverage).toEqual(stopped('projects'))
    expect(unready.searches).toBe(2)
    // a seat searched project by project needs no readiness
    // the project's name equals the text and ranks first
    const guest = await searchRun(t, [f.guest], { text: 'firmware' })
    expect(ids(guest.page)).toEqual([f.sub.id, torque.id])
    expect(guest.page.coverage).toEqual(COMPLETE)
    await withReach(t)
    const ready = await searchRun(t, [f.admin], { text: 'firmware' })
    expect(ids(ready.page)).toEqual([f.sub.id, torque.id])
    expect(ready.page.coverage).toEqual(COMPLETE)
    expect(ready.searches).toBe(3)
    // and once nav_at is gone again, as no organization's is
    await stampNav(t, f.org.id, null)
    expect((await searchRun(t, [f.admin], { text: 'firmware' })).page).toEqual(unready.page)
  })

  it('ranks project and task matches together on one scale', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { sub: away } = await secondSeat(t, f)
    const rev = await subOf(t, f, f.meta, { name: 'Rev 12' })
    const reference = await task(t, f, f.sub, 'Planted', { num: 12 })
    expect(ids(await search(t, f.user, { text: '12' }))).toEqual([reference.id, rev.id])
    const gearbox = await subOf(t, f, f.meta, { name: 'Gearbox' })
    const titled = await task(t, f, f.sub, 'Gearbox')
    const phrase = await task(t, f, f.sub, 'Rebuild the gearbox')
    const described = await task(t, f, f.sub, 'Planted', { description: 'the gearbox' })
    // equal scores order by newest number, then id
    const older = await subOf(t, f, f.meta, { name: 'Gearbox rig', num: 60 })
    const [low, high] = [uuid(), uuid()].sort()
    const twin = await subOf(t, f, f.meta, { name: 'Gearbox rig', num: 61, id: high })
    const first = await subOf(t, f, f.meta, { name: 'Gearbox rig', num: 61, id: low })
    // the guest seat's equal match follows the home seat's
    const elsewhere = await t.run(async (ctx) => {
      await ctx.db.patch(away._id, { name: 'Gearbox rig' })
      return away.id
    })
    await withReach(t)
    const order = [
      titled.id,
      gearbox.id,
      first.id,
      twin.id,
      older.id,
      elsewhere,
      phrase.id,
      described.id,
    ]
    expect(ids(await search(t, f.user, { text: 'gearbox' }))).toEqual(order)
    MAIN_SEARCH.projects = 0
    expect(ids(await search(t, f.user, { text: 'gearbox' }))).toEqual(order)
  })

  it('pages through tasks and projects together, each once, in the order of one large page', async () => {
    for (const admin of [false, true]) {
      const t = newT()
      const f = await withOrg(t)
      const who = admin ? f.admin : f.user
      for (const [i, name] of [
        'Gearbox',
        'Gearbox rig',
        'Spare gearbox',
        'Old gearbox mount',
      ].entries()) {
        await subOf(t, f, f.meta, { name })
        await task(t, f, i % 2 ? f.sub : f.sub2, name, { description: 'gearbox' })
      }
      await withReach(t)
      const whole = await search(t, who, { text: 'gearbox' })
      expect(whole.rows).toHaveLength(8)
      expect(new Set(whole.rows.map((row) => row.kind))).toEqual(new Set(['task', 'project']))
      MAIN_SEARCH.rows = 3
      const walked: string[] = []
      let cursor: string | undefined
      for (let n = 0; n < 5; n++) {
        const page = await search(t, who, { text: 'gearbox', cursor })
        walked.push(...ids(page))
        expect(page.coverage).toEqual(COMPLETE)
        if (page.next_cursor === null) break
        expect(page.rows).toHaveLength(3)
        cursor = page.next_cursor
        // a project created between two pages repeats no row
        if (n === 0) {
          await subOf(t, f, f.meta, { name: 'Gearbox' })
          await withReach(t)
        }
      }
      expect(walked).toEqual(ids(whole))
      MAIN_SEARCH.rows = DEFAULT_SEARCH.rows
    }
  })

  it("reports the name source's stops", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantProjects(t, f.org.id, 5, (i) => ({ parent_id: f.meta.id, name: `Zephyr ${i}` }))
    await withReach(t)
    expect((await search(t, f.admin, { text: 'zephyr' })).coverage).toEqual(COMPLETE)
    MAIN_SEARCH.names = 2
    const capped = await search(t, f.admin, { text: 'zephyr' })
    expect(capped.coverage).toEqual(stopped('candidates'))
    expect(projectIds(capped)).toHaveLength(2)
    MAIN_SEARCH.names = DEFAULT_SEARCH.names
    // a seat searched whole that does not see every project
    MAIN_SEARCH.projects = 0
    expect((await search(t, f.user, { text: 'zephyr' })).coverage).toEqual(stopped('projects'))
    MAIN_SEARCH.projects = DEFAULT_SEARCH.projects
    // project rows near Convex's 1 MiB, more than the seat's whole
    // allowance holds, spend the names' quarter of it, and the seat's task
    // sources still read with the rest
    await plantProjects(t, f.org.id, 12, (i) => ({
      parent_id: f.meta.id,
      name: `Zephyr large ${i}`,
      description: 'x'.repeat(900_000),
    }))
    await withReach(t)
    const titled = await task(t, f, f.sub, 'Zephyr')
    const large = await searchRun(t, [f.admin], { text: 'zephyr' })
    expect(large.page.coverage).toEqual(stopped('reads'))
    expect(projectIds(large.page).length).toBeGreaterThan(0)
    expect(taskIds(large.page)).toEqual([titled.id])
    // a quarter of the seat's 8 MiB, passed by the one row that crosses it
    expect(large.read.bytes).toBeLessThan(4 << 20)
  })

  it("keeps the task sources of eight seats whose name checks would spend each seat's reads", async () => {
    const t = newT()
    const [login] = await plantLogins(t, [{ name: 'Broad', email: 'broad@testbed.test' }])
    // in each of eight organizations a guest granted 65 sub-projects under
    // distinct parents, more than one listing holds, so each seat is
    // searched whole and its name candidates each cost a few access reads
    const seats: Doc<'profiles'>[] = []
    const titled: string[] = []
    for (let i = 0; i < 8; i++) {
      const org = await plantOrg(t, i)
      const seat = await plantSeat(t, {
        org_id: org,
        auth_user_id: login,
        org_role: 'guest',
        accepted_at: NOW,
      })
      seats.push(seat)
      const tops = await plantProjects(t, org, 65, (k) => ({ type: 'meta', name: `Zephyr ${k}` }))
      const subs = await plantProjects(t, org, 65, (k) => ({
        parent_id: tops[k],
        name: `Zephyr part ${k}`,
      }))
      await t.run(async (ctx) => {
        for (const project_id of subs)
          await ctx.db.insert('project_access', { project_id, profile_id: seat.id, level: 'user' })
      })
      titled.push((await plantIssue(t, { org_id: org, project_id: subs[0], title: 'Zephyr' })).id)
    }
    await withReach(t)
    const run = await searchRun(t, seats, { text: 'zephyr' })
    // every seat's title match, ranked first as its title is the text
    expect(taskIds(run.page).sort()).toEqual([...titled].sort())
    expect(run.page.rows.slice(0, 8).map((row) => row.kind)).toEqual(Array(8).fill('task'))
    // names stopped within their part, with some shown, and the seats
    // searched whole say the search is incomplete
    expect(projectIds(run.page).length).toBeGreaterThan(0)
    expect(run.page.coverage).toEqual(stopped('projects', 8, 8))
    expect(run.searches).toBe(24)
  }, 120_000)

  it('keeps the task sources of a member past the root row bound', async () => {
    const t = newT()
    const f = await withOrg(t)
    const member = await plantMember(t, f)
    // twenty teams, the first sharing a top-level project with 40
    // sub-projects, and a grant on TBED, so the member is searched whole
    const teams = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 20; i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: id,
          profile_id: member.id,
          is_leader: false,
        })
        ids.push(id)
      }
      return ids
    })
    const shared = await plantProject(t, { org_id: f.org.id, name: 'Shared work' })
    const subs = await plantProjects(t, f.org.id, 40, () => ({ parent_id: shared.id }))
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        team_id: teams[0],
        project_id: shared.id,
        level: 'user',
      }),
    )
    await grant(t, f.meta, member)
    // 120 top-level projects named the text that the member cannot see
    await plantProjects(t, f.org.id, 120, (i) => ({ type: 'meta', name: `Zephyr ${i}` }))
    const titled = await plantIssue(t, { org_id: f.org.id, project_id: subs[0], title: 'Zephyr' })
    await withReach(t)
    // their two root rows pass the bound, so each candidate is checked by
    // itself, with the seat's own child rows alone
    PROJECT_SIGHT.roots = 1
    const run = await searchRun(t, [member], { text: 'zephyr' })
    expect(taskIds(run.page)).toEqual([titled.id])
    expect(projectIds(run.page)).toEqual([])
    expect(run.page.coverage).toEqual(stopped('projects'))
    expect(run.searches).toBe(3)
  })

  it('runs one name query for each ready seat searched whole and none for one searched project by project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { sub } = await secondSeat(t, f)
    await task(t, f, f.sub, 'Gearbox teardown')
    await plantIssue(t, { org_id: f.otherOrg.id, project_id: sub.id, title: 'Gearbox rebuilds' })
    const seats = [f.user, ...(await seatsOf(t, f.user))]
    // both seats project by project, ready or not: FW and PCB, then the
    // guest seat's sub-project
    expect((await searchRun(t, seats, { text: 'gearbox' })).searches).toBe(6)
    await withReach(t)
    expect((await searchRun(t, seats, { text: 'gearbox' })).searches).toBe(6)
    // the planning of task sources is unchanged: with four searches the home
    // seat is searched whole and the guest seat still gets its two, and the
    // home seat's name query comes on top
    MAIN_SEARCH.searches = 4
    const run = await searchRun(t, seats, { text: 'gearbox' })
    expect(run.searches).toBe(5)
    expect(run.page.coverage).toEqual(stopped('projects', 2, 2))
  })
})

describe('project results at Convex’s limits', () => {
  it('answers inside the limits among 600 projects named the text, some near 1 MiB', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const member = await plantMember(t, f)
    const tops = await plantProjects(t, f.org.id, 40, (i) => ({
      type: 'meta',
      name: `Zephyr ${i}`,
    }))
    await plantProjects(t, f.org.id, 552, (i) => ({
      parent_id: tops[i % tops.length],
      name: `Zephyr part ${i}`,
    }))
    // rows over the caps, as a legacy icon or an older description makes
    // them, one a transaction
    await plantProjects(
      t,
      f.org.id,
      8,
      (i) => ({ parent_id: tops[i], name: `Zephyr large ${i}`, description: 'x'.repeat(900_000) }),
      1,
    )
    // the member's team shares five top-level projects, about 70
    // sub-projects, so their organization is searched whole
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: member.id,
        is_leader: false,
      })
      for (const project_id of tops.slice(0, 5))
        await ctx.db.insert('project_team_access', {
          team_id: f.team.id,
          project_id,
          level: 'user',
        })
    })
    await withReach(t)
    for (const who of [f.admin, member]) {
      const run = await searchRun(t, [who], { text: 'zephyr' })
      console.log(
        '600 projects named the text',
        who.name,
        run.read,
        run.searches,
        run.page.rows.length,
      )
      expect(run.page.rows).toHaveLength(MAIN_SEARCH.rows)
      expect(run.read.bytes).toBeLessThan(16 << 20)
      expect(run.read.documents).toBeLessThan(32_000)
      expect(run.read.ranges).toBeLessThan(4_096)
      if (who === f.admin)
        expect(['reads', 'candidates']).toContain(
          (run.page.coverage as { stopped: string }).stopped,
        )
      else expect(run.page.coverage).toEqual(stopped('projects'))
    }
  }, 120_000)

  it('searches a guest, a wide member and an admin of a few hundred projects within the limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // a guest with one sub-project
    const guest = await plantLogin(
      t,
      await plantSeat(t, { org_id: f.org.id, org_role: 'guest', accepted_at: NOW }),
    )
    await grant(t, f.sub, guest)
    // an organization of a few hundred projects, in which a member's team
    // shares four top-level projects, 36 sub-projects
    const tops = await plantProjects(t, f.org.id, 30, (i) => ({
      type: 'meta',
      name: `Zephyr ${i}`,
    }))
    await plantProjects(t, f.org.id, 270, (i) => ({
      parent_id: tops[i % tops.length],
      name: `Zephyr part ${i}`,
    }))
    const member = await plantMember(t, f)
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: member.id,
        is_leader: false,
      })
      for (const project_id of tops.slice(0, 4))
        await ctx.db.insert('project_team_access', {
          team_id: f.team.id,
          project_id,
          level: 'user',
        })
    })
    for (let i = 0; i < 40; i++)
      await task(t, f, f.sub, `Zephyr task ${i}`, { description: 'zephyr notes' })
    await withReach(t)
    // the guest is searched project by project, with no name query; the
    // member and the admin are searched whole, each with one
    for (const [who, searches, coverage] of [
      [guest, 2, COMPLETE],
      [member, 3, stopped('projects')],
      [f.admin, 3, stopped('candidates')],
    ] as const) {
      const run = await searchRun(t, [who], { text: 'zephyr' })
      expect(run.searches).toBe(searches)
      expect(run.page.coverage).toEqual(coverage)
      expect(run.page.rows).toHaveLength(MAIN_SEARCH.rows)
      expect(run.read.bytes).toBeLessThan(16 << 20)
    }
  }, 120_000)
})

describe('the search_title index', () => {
  it('filters by organization, project and archived state', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plant = (project_id: string, archived_at?: string, org_id = f.org.id) =>
      plantIssue(t, { org_id, project_id, archived_at, title: 'Calibrate the torque sensor' }).then(
        (row) => row.id,
      )
    const active = await plant(f.sub.id)
    const elsewhere = await plant(f.sub2.id)
    const shelved = await plant(f.sub.id, NOW)
    await plant(f.otherProject.id, undefined, f.otherOrg.id)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Order cables' })
    const found = (narrow: { project_id?: string; active?: true } = {}) =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query('issues')
            .withSearchIndex('search_title', (q) => {
              let filter = q.search('title', 'torque').eq('org_id', f.org.id)
              if (narrow.project_id !== undefined)
                filter = filter.eq('project_id', narrow.project_id)
              if (narrow.active) filter = filter.eq('archived_at', undefined)
              return filter
            })
            .collect()
        )
          .map((row) => row.id)
          .sort(),
      )
    expect(await found()).toEqual([active, elsewhere, shelved].sort())
    expect(await found({ project_id: f.sub.id })).toEqual([active, shelved].sort())
    expect(await found({ active: true })).toEqual([active, elsewhere].sort())
    expect(await found({ project_id: f.sub.id, active: true })).toEqual([active])
  })
})

describe('the search_name index', () => {
  it('filters by organization and archive state', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plant = (org_id: string, archive_state?: 'live' | 'listed') =>
      plantProject(t, { org_id, name: 'Torque bench', archive_state }).then((p) => p.id)
    const live = await plant(f.org.id, 'live')
    const listed = await plant(f.org.id, 'listed')
    // a project stored before archive states has none
    const unstated = await plant(f.org.id)
    await plant(f.otherOrg.id, 'live')
    await plantProject(t, { org_id: f.org.id, name: 'Order cables', archive_state: 'live' })
    const found = (state?: 'live' | 'listed') =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query('projects')
            .withSearchIndex('search_name', (q) => {
              const filter = q.search('name', 'torque').eq('org_id', f.org.id)
              return state === undefined ? filter : filter.eq('archive_state', state)
            })
            .collect()
        )
          .map((row) => row.id)
          .sort(),
      )
    expect(await found()).toEqual([live, listed, unstated].sort())
    expect(await found('live')).toEqual([live])
    expect(await found('listed')).toEqual([listed])
  })
})
