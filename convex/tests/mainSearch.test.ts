/* Main Search's task results (search.ts page, lib/mainSearch.ts): which
 * tasks a search finds, for whom, in which order, a page at a time, and
 * what its coverage says when its reads stop.
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
import { deleteTask, installTrashTimers } from './trash.setup'

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
afterEach(() => {
  Object.assign(SEAT_SHARE, DEFAULT_SHARE)
  Object.assign(MAIN_SEARCH, DEFAULT_SEARCH)
  Object.assign(SEARCH_RESERVE, DEFAULT_RESERVE)
  Object.assign(ARCHIVED_FILTER, DEFAULT_FILTER)
})

type Args = { text: string; include_archived?: boolean; scope?: SearchScope; cursor?: string }

/** One page of main Search as `who` asks for it through the public query. */
const search = (t: T, who: Doc<'profiles'>, a: Args): Promise<MainSearchPage> =>
  as(t, who).query(api.search.page, { include_archived: false, ...a })

/** The task ids of a page's rows, in order. */
const ids = (page: MainSearchPage) => page.rows.map((row) => row.id)

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
    // a project's name is no part of its tasks' text
    expect(f.sub.name).toBe('Firmware')
    expect(ids(await search(t, f.user, { text: 'firmware' }))).toEqual([])
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
    MAIN_SEARCH.candidates = 100
    const guest = await searchRun(t, [f.guest], { text: 'gearbox' })
    expect(guest.page.rows.map((row) => row.id).sort()).toEqual(mine.map((m) => m.id).sort())
    expect(guest.page.coverage).toEqual(COMPLETE)
    // two projects, a title and a description query each
    expect(guest.searches).toBe(4)
    // the organization's search reads the hidden tasks and stops at the cap
    const admin = await searchRun(t, [f.admin], { text: 'gearbox' })
    expect(admin.searches).toBe(2)
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
    for (let i = 0; i < 3; i++) await task(t, f, f.sub, `Gearbox ${i}`, { archived_at: NOW })
    const active = [await task(t, f, f.sub, 'Gearbox a'), await task(t, f, f.sub, 'Gearbox b')]
    MAIN_SEARCH.candidates = 3
    const byIndex = await search(t, f.admin, { text: 'gearbox' })
    expect(ids(byIndex).sort()).toEqual(active.map((a) => a.id).sort())
    expect(byIndex.coverage).toEqual(COMPLETE)
    ARCHIVED_FILTER.byIndex = false
    const after = await search(t, f.admin, { text: 'gearbox' })
    expect(after.coverage).toEqual(stopped('candidates'))
    for (const row of after.rows) expect(row.archived).toBe(false)
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
    const { profiles } = await plantNorthstar(t)
    const nora = profiles.find((p) => p.auth_user_id === 'auth_nora')
    if (nora === undefined) throw new Error('no Nora')
    for (const text of ['sensor', 'the', 'QN-12', 'firmware board']) {
      const run = await searchRun(t, [nora], { text, include_archived: true })
      console.log('Northstar', text, run.read, run.searches, run.page.rows.length)
      expect(run.page.coverage).toEqual(COMPLETE)
    }
  })
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
