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
afterEach(() => {
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
const stopped = (why: 'candidates' | 'reads' | 'organizations', searched = 1, of = 1) => ({
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
    // and when the guest's search reads the whole organization
    MAIN_SEARCH.projects = 1
    expect((await searchRun(t, [f.guest], { text: 'gearbox' })).searches).toBe(2)
    expect(ids(await search(t, f.guest, { text: 'gearbox' }))).toEqual([shared.id])
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
    // a budget that holds no read: no rows, and never complete
    MAIN_SEARCH.bytes = 1
    expect(await search(t, f.user, { text: 'gearbox', scope: { org_id: f.org.id } })).toEqual({
      rows: [],
      next_cursor: null,
      coverage: stopped('reads'),
    })
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
