/* Tests of project favorites (schema.ts project_favorites): the one writer
 * projectNav.setFavorite (model/projectFavorites.ts), the copies every
 * rename, archive and restore keeps within its tree budget
 * (model/projectNav.ts treeFavorites, settleFavorites), lost access, the
 * teardowns, Deleted items and id reuse. The public demo's cleanup, the
 * Northstar wipe and the demo's write counts are in demoCleanup.test.ts,
 * marketingDemo.test.ts and demo.test.ts, which hold those fixtures.
 *
 * expectFavoritesExact checks every row against the projects and profiles
 * themselves, and `shows` applies the rule every reader applies, with
 * lib/access.ts projectLevel as its access check, so neither leans on the
 * code under test. Fake timers keep every scheduled step from running until
 * a test releases it (trash.setup.ts installTrashTimers). */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { ConvexError, getDocumentSize } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, OWN_READS, ordinaryOf, projectLevel } from '../lib/access'
import { BILLING_READ_ONLY, ORG_DELETING } from '../lib/billingAccess'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS, MIB, NAME_MAX } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { ACCESS_FIRST_PASS, deleteOrgDeep, REMOVAL_BUDGET } from '../model/cascade'
import { startPurge, TRASH_BUDGET } from '../model/deletedItems'
import { deleteOrgStep } from '../model/orgDeletion'
import { setFavoriteCore, TOP_LEVEL_ONLY } from '../model/projectFavorites'
import {
  settleFavorites,
  TREE_FAVORITES,
  TREE_READ,
  TREE_TOO_LARGE,
  TREE_TOO_MANY_FAVORITES,
  treeBudget,
} from '../model/projectNav'
import { archiveProjectCore, unarchiveProjectCore, updateProjectCore } from '../model/projects'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { withReach } from './projectReach.setup'
import { assertNoDanglingRefs } from './refs.setup'
import { DAY, installTrashTimers, itemFor, jobFor, runSteps, step } from './trash.setup'

installTrashTimers()

const FAVORITES_DEFAULTS = { ...TREE_FAVORITES }
const READ_DEFAULTS = { ...TREE_READ }
const OWN_DEFAULTS = structuredClone(OWN_READS)
const PASS_DEFAULTS = { ...ACCESS_FIRST_PASS }
const REMOVAL_DEFAULTS = { ...REMOVAL_BUDGET }
afterEach(() => {
  Object.assign(TREE_FAVORITES, FAVORITES_DEFAULTS)
  Object.assign(TREE_READ, READ_DEFAULTS)
  Object.assign(OWN_READS, structuredClone(OWN_DEFAULTS))
  Object.assign(ACCESS_FIRST_PASS, PASS_DEFAULTS)
  Object.assign(REMOVAL_BUDGET, REMOVAL_DEFAULTS)
  vi.unstubAllEnvs()
})

type Favorite = Doc<'project_favorites'>

/** withOrg with its reach rows written, as on every deployment, and Pia, a
 * standard user with no access, who can sign in. */
async function ready(t: T) {
  const f = await withOrg(t)
  const pia = await plantLogin(
    t,
    await plantSeat(t, { org_id: f.org.id, name: 'Pia Lund', email: 'pia@testbed.test' }),
  )
  await withReach(t)
  return { ...f, pia }
}

/** Stars (or with `favorite` false unstars) project `projectId` as `seat`. */
const star = (t: T, seat: Doc<'profiles'>, projectId: string, favorite = true) =>
  as(t, seat).mutation(api.projectNav.setFavorite, {
    org_id: seat.org_id,
    project_id: projectId,
    favorite,
  })

/** Every favorites row, in insertion order. */
const favorites = (t: T): Promise<Favorite[]> =>
  t.run((ctx) => ctx.db.query('project_favorites').collect())

/** The rows on project `projectId`. */
const favoritesOn = async (t: T, projectId: string) =>
  (await favorites(t)).filter((row) => row.project_id === projectId)

/** `seat`'s row on project `projectId`, or undefined. */
const rowOf = async (t: T, seat: Doc<'profiles'>, projectId: string) =>
  (await favorites(t)).find((row) => row.profile_id === seat.id && row.project_id === projectId)

const projectOf = (t: T, id: string) => t.run((ctx) => byId(ctx, 'projects', id))

/* The copy Deleted items keeps of project `id`, or null. */
async function storedProject(
  ctx: QueryCtx,
  id: string,
): Promise<WithoutSystemFields<Doc<'projects'>> | null> {
  const stored = await ctx.db
    .query('deleted_rows')
    .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', id))
    .unique()
  return stored?.row.table === 'projects' ? stored.row.doc : null
}

/** Throws unless every favorites row names a top-level project of its own
 * organization, live or in Deleted items, and a seat of that organization,
 * holds the project's copies while it is live, and is its seat's only row
 * on the project. */
async function expectFavoritesExact(t: T): Promise<void> {
  const problems = await t.run(async (ctx) => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const row of await ctx.db.query('project_favorites').collect()) {
      const label = `${row.profile_id} on ${row.project_id}`
      const pair = `${row.profile_id}:${row.project_id}`
      if (seen.has(pair)) out.push(`${label}: a second row`)
      seen.add(pair)
      const seat = await byId(ctx, 'profiles', row.profile_id)
      if (seat === null || seat.org_id !== row.org_id) out.push(`${label}: no seat of its own`)
      const live = await byId(ctx, 'projects', row.project_id)
      const project = live ?? (await storedProject(ctx, row.project_id))
      if (project === null) {
        out.push(`${label}: no project`)
        continue
      }
      if (project.org_id !== row.org_id) out.push(`${label}: another organization's project`)
      if (project.parent_id !== undefined) out.push(`${label}: a sub-project`)
      if (
        live !== null &&
        (row.name_key !== nameKey(live.name) || row.live !== (live.archived_at === undefined))
      )
        out.push(`${label}: copies differ from the project's`)
    }
    return out
  })
  expect(problems).toEqual([])
}

/** Every check of the rows: exact, and no reference dangling. */
async function expectAll(t: T, label: string): Promise<void> {
  await expectFavoritesExact(t)
  await assertNoDanglingRefs(t, label)
}

/** Whether a reader shows `row`: its seat, organization and live top-level
 * meta agree, the row holds the project's copies, and the seat sees the
 * project through ordinary access (lib/access.ts projectLevel of
 * ordinaryOf). */
const shows = (t: T, row: Favorite) =>
  t.run(async (ctx) => {
    const seat = await byId(ctx, 'profiles', row.profile_id)
    const p = await byId(ctx, 'projects', row.project_id)
    return (
      seat !== null &&
      p !== null &&
      row.org_id === seat.org_id &&
      row.org_id === p.org_id &&
      p.parent_id === undefined &&
      p.type === 'meta' &&
      p.archived_at === undefined &&
      row.live &&
      row.name_key === nameKey(p.name) &&
      (await projectLevel(ctx, ordinaryOf(seat), p)) !== null
    )
  })

/** Plants `n` more seats of `p`'s organization, each with its favorite on
 * top-level project `p` with its copies, as a star writes it. */
async function plantFavorites(
  t: T,
  p: Doc<'projects'>,
  n: number,
  fields: Partial<WithoutSystemFields<Favorite>> = {},
): Promise<void> {
  for (let from = 0; from < n; from += 250)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 250); i++) {
        const profile_id = uuid()
        await ctx.db.insert('profiles', {
          id: profile_id,
          org_id: p.org_id,
          name: `Fan ${i}`,
          initials: 'FN',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
        await ctx.db.insert('project_favorites', {
          org_id: p.org_id,
          profile_id,
          project_id: p.id,
          name_key: nameKey(p.name),
          live: p.archived_at === undefined,
          created_at: NOW,
          ...fields,
        })
      }
    })
}

const NOT_FOUND = { code: 'not_found', message: 'project not found' }

/** The refusal a call rejects with, as its code and message, or null when it
 * resolves. */
async function refusalOf(call: Promise<unknown>) {
  try {
    await call
    return null
  } catch (e) {
    if (!(e instanceof ConvexError)) throw e
    const { code, message } = e.data as Refusal
    return { code, message }
  }
}

describe('the writer', () => {
  it("stars and unstars a project for the caller's seat, once", async () => {
    const t = newT()
    const f = await ready(t)
    expect(await star(t, f.user, f.meta.id)).toBeNull()
    const [row] = await favorites(t)
    const { _id, _creationTime, ...fields } = row
    expect(fields).toEqual({
      org_id: f.org.id,
      profile_id: f.user.id,
      project_id: f.meta.id,
      name_key: nameKey(f.meta.name),
      live: true,
      created_at: new Date().toISOString(),
    })
    await expectAll(t, 'after a star')
    // a second star, later, writes nothing
    vi.setSystemTime(Date.now() + 60_000)
    expect(await star(t, f.user, f.meta.id)).toBeNull()
    expect(await favorites(t)).toEqual([row])
    expect(await star(t, f.user, f.meta.id, false)).toBeNull()
    expect(await favorites(t)).toEqual([])
    expect(await star(t, f.user, f.meta.id, false)).toBeNull()
    expect(await favorites(t)).toEqual([])
  })

  it('lets every source of ordinary access star, a Viewer seat included', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const lead = as(t, f.user)
    // Pia through a team share, Sam through a grant on FW alone, which
    // shows TBED for navigation
    await lead.mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      team_id: f.team.id,
      level: 'viewer',
    })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id,
      team_id: f.team.id,
      profile_id: f.pia.id,
    })
    const sam = await plantLogin(
      t,
      await plantSeat(t, { org_id, name: 'Sam Berg', email: 'sam@testbed.test' }),
    )
    await lead.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: sam.id,
      level: 'user',
    })
    // the lead, the user grants of the viewer and the guest seats, the team
    // share and the navigation
    for (const seat of [f.user, f.viewer, f.guest, f.pia, sam])
      expect(await star(t, seat, f.meta.id)).toBeNull()
    expect((await favoritesOn(t, f.meta.id)).map((row) => row.profile_id).sort()).toEqual(
      [f.user.id, f.viewer.id, f.guest.id, f.pia.id, sam.id].sort(),
    )
    for (const row of await favorites(t)) expect(await shows(t, row)).toBe(true)
    await expectAll(t, 'after stars from every source')
  })

  it('answers project not found alike wherever ordinary access does not reach, and refuses a sub-project only after', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // TBED shared with a team that holds a membership of a guest seat with
    // no grant of its own, as an old row can
    const guest = await plantLogin(
      t,
      await plantSeat(t, { org_id, name: 'Gus', email: 'gus@guest.test', org_role: 'guest' }),
    )
    await t.run(async (ctx) => {
      const team_id = uuid()
      await ctx.db.insert('teams', {
        id: team_id,
        org_id,
        name: 'Old crew',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id,
        level: 'user',
      })
      await ctx.db.insert('team_members', { team_id, profile_id: guest.id, is_leader: false })
    })
    // a top-level project whose lead_id names the viewer, which leads
    // nothing, and that nobody grants it
    const led = await plantProject(t, { org_id, lead_id: f.viewer.id, name: 'Viewer led' })
    // a project in Deleted items that its lead could star before
    const gone = await plantProject(t, { org_id, lead_id: f.user.id, name: 'Gone' })
    const pia = await plantLogin(
      t,
      await plantSeat(t, { org_id, name: 'Pia Lund', email: 'pia@testbed.test' }),
    )
    await withReach(t)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: gone.id })
    await runSteps(t)
    const refusals = [
      // the admin, who holds no grant or share on TBED
      await refusalOf(star(t, f.admin, f.meta.id)),
      await refusalOf(star(t, pia, f.hidden.id)),
      await refusalOf(star(t, f.user, uuid())),
      await refusalOf(star(t, f.user, f.otherProject.id)),
      await refusalOf(star(t, f.user, gone.id)),
      await refusalOf(star(t, guest, f.meta.id)),
      await refusalOf(star(t, f.viewer, led.id)),
      // a sub-project the caller cannot see
      await refusalOf(star(t, pia, f.sub.id)),
    ]
    for (const refusal of refusals) expect(refusal).toEqual(NOT_FOUND)
    // a sub-project the caller sees
    await expectRefusal(star(t, f.user, f.sub.id), 'bad_request', new RegExp(`^${TOP_LEVEL_ONLY}$`))
    expect(await favorites(t)).toEqual([])
  })

  it('lets an admin with a grant star, and keeps the row when the grant goes', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      user_id: f.admin.id,
      level: 'viewer',
    })
    await star(t, f.admin, f.meta.id)
    const row = await rowOf(t, f.admin, f.meta.id)
    expect(row).toBeDefined()
    await as(t, f.user).mutation(api.projects.removeAccess, {
      org_id,
      id: f.meta.id,
      user_id: f.admin.id,
      on_held_tasks: 'leave',
    })
    expect(await favorites(t)).toEqual([row])
    expect(await shows(t, row as Favorite)).toBe(false)
    expect(await refusalOf(star(t, f.admin, f.meta.id))).toEqual(NOT_FOUND)
    expect(await star(t, f.admin, f.meta.id, false)).toBeNull()
    expect(await favorites(t)).toEqual([])
  })

  it('stars an archived top-level project as not live, and its restore makes it live', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.user).mutation(api.projects.archive, { org_id, id: f.meta.id })
    await star(t, f.user, f.meta.id)
    expect(await rowOf(t, f.user, f.meta.id)).toMatchObject({ live: false })
    await expectFavoritesExact(t)
    await as(t, f.user).mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    expect(await rowOf(t, f.user, f.meta.id)).toMatchObject({ live: true })
    await expectFavoritesExact(t)
  })

  it('refuses with access_unchecked where a bound stops the check, and writes nothing', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    // Pia reaches TBED only through Hardware's share, which the bounds
    // below leave her team no read to check
    await as(t, f.user).mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      team_id: f.team.id,
      level: 'viewer',
    })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id,
      team_id: f.team.id,
      profile_id: f.pia.id,
    })
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    const e = await expectRefusal(star(t, f.pia, f.meta.id), 'rule')
    expect((e.data as Refusal).reason).toBe(ACCESS_UNCHECKED)
    expect(await favorites(t)).toEqual([])
    Object.assign(OWN_READS, structuredClone(OWN_DEFAULTS))
    expect(await star(t, f.pia, f.meta.id)).toBeNull()
  })

  it('writes nothing but the row, and reads the same in a project with no tasks and one with 300', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // two trees alike, one with 300 tasks
    const quiet = await plantProject(t, { org_id, lead_id: f.user.id, name: 'Quiet' })
    const busy = await plantProject(t, { org_id, lead_id: f.user.id, name: 'Busy' })
    await plantProject(t, { org_id, type: 'project', parent_id: quiet.id })
    const work = await plantProject(t, { org_id, type: 'project', parent_id: busy.id })
    for (let i = 0; i < 300; i++) await plantIssue(t, { org_id, project_id: work.id })
    await plantFavorites(t, f.meta, 3)
    await withReach(t)
    const others = [
      'activity_events',
      'issue_subscriptions',
      'messages',
      'project_access',
      'project_team_access',
      'project_reach',
    ] as const
    const snapshot = () =>
      t.run(async (ctx) => {
        const out: Record<string, unknown[]> = {}
        for (const table of others) out[table] = await ctx.db.query(table).collect()
        return out
      })
    const before = await snapshot()
    const theirs = await favorites(t)
    await star(t, f.user, busy.id)
    expect(await snapshot()).toEqual(before)
    expect((await favorites(t)).slice(0, theirs.length)).toEqual(theirs)
    /* What a star of `p` read, run as the mutation runs it. */
    const reads = (p: Doc<'projects'>) =>
      t.run(async (ctx) => {
        await setFavoriteCore(ctx, { me: f.user, projectId: p.id, favorite: true, now: NOW })
        const m = await ctx.meta.getTransactionMetrics()
        return { ranges: m.databaseQueries.used, documents: m.documentsRead.used }
      })
    await star(t, f.user, busy.id, false)
    expect(await reads(busy)).toEqual(await reads(quiet))
  })

  it('is refused in a read-only organization, star and unstar, as following a task is', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await star(t, f.user, f.meta.id)
    const issue = await plantIssue(t, { org_id, project_id: f.sub.id })
    const follow = () =>
      as(t, f.user).mutation(api.issues.subscribe, { org_id, issue_id: issue.id })
    vi.stubEnv('BILLING_ENABLED', 'true')
    for (const call of [star(t, f.user, f.meta.id, false), star(t, f.user, f.sub2.id), follow()]) {
      const e = await expectRefusal(call, 'forbidden')
      expect(e.data).toMatchObject({ reason: 'billing_required', message: BILLING_READ_ONLY })
    }
    vi.unstubAllEnvs()
    // a deletion that is scheduled, then one that has begun
    const removal = await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
      }),
    )
    for (const call of [star(t, f.user, f.meta.id, false), follow()]) {
      const e = await expectRefusal(call, 'forbidden')
      expect(e.data).toMatchObject({ reason: 'deletion_scheduled' })
    }
    await t.run((ctx) => ctx.db.patch(removal, { phase: 'profiles' }))
    for (const call of [star(t, f.user, f.meta.id, false), follow()])
      await expectRefusal(call, 'forbidden', new RegExp(`^${ORG_DELETING}$`))
    expect(await favorites(t)).toHaveLength(1)
  })

  it('resets a row a rollback or a manual edit left, and keeps when it was starred', async () => {
    const t = newT()
    const f = await ready(t)
    const earlier = new Date(Date.parse(NOW) - DAY).toISOString()
    await t.run(async (ctx) => {
      // stale copies of a live project, under another organization, and a
      // second row of the same seat
      await ctx.db.insert('project_favorites', {
        org_id: f.otherOrg.id,
        profile_id: f.user.id,
        project_id: f.meta.id,
        name_key: 'an old name',
        live: false,
        created_at: earlier,
      })
      await ctx.db.insert('project_favorites', {
        org_id: f.org.id,
        profile_id: f.user.id,
        project_id: f.meta.id,
        name_key: nameKey(f.meta.name),
        live: true,
        created_at: NOW,
      })
    })
    const [first] = await favorites(t)
    await star(t, f.user, f.meta.id)
    expect(await favorites(t)).toEqual([
      {
        ...first,
        org_id: f.org.id,
        name_key: nameKey(f.meta.name),
        live: true,
        created_at: earlier,
      },
    ])
    await expectAll(t, 'after a reset')
  })
})

/** The REST update of project `ref` with `body`, as the fixture's user. */
const restUpdate = (t: T, f: OrgFixture, ref: string, body: object) =>
  t.mutation(internal.machine.projects.restUpdateProject, {
    callerId: f.user.id,
    access: 'write',
    keyName: null,
    ref,
    body: JSON.stringify(body),
  })

/** The MCP update of project `project`, as the fixture's user. */
const mcpUpdate = (
  t: T,
  f: OrgFixture,
  project: string,
  fields: { name?: string; archived?: boolean },
) =>
  t.mutation(internal.machine.projects.mcpUpdateProject, {
    callerId: f.user.id,
    access: 'write',
    project,
    ...fields,
  })

/** A tree change run as its mutation runs it, but in one t.run that keeps
 * what it wrote before a refusal, so a case sees whether it wrote anything
 * first: an archive, a restore, a rename to `name`, or an archive or a
 * restore and a rename sharing one budget, as a REST or MCP update makes
 * them. Answers the refusal's message, or what the transaction read and
 * wrote, with the writes of favorites rows. */
type Change =
  | { archive: boolean; name?: undefined }
  | { archive?: undefined; name: string }
  | { archive: boolean; name: string }
const treeChange = (t: T, me: Doc<'profiles'>, id: string, change: Change) =>
  t.run(async (ctx) => {
    let favoritesWritten = 0
    // ctx.db, counting the patches of favorites rows
    const db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'patch')
          return (...args: Parameters<MutationCtx['db']['patch']>) => {
            if (target.normalizeId('project_favorites', String(args[0])) !== null)
              favoritesWritten += 1
            return target.patch(...args)
          }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try {
      await runChange({ ...ctx, db }, me, id, change)
    } catch (e) {
      if (!(e instanceof ConvexError)) throw e
      return { refused: (e.data as Refusal).message }
    }
    const m = await ctx.meta.getTransactionMetrics()
    return {
      read: Math.round((m.bytesRead.used / MIB) * 100) / 100,
      documents: m.documentsRead.used,
      ranges: m.databaseQueries.used,
      written: m.documentsWritten.used,
      favoritesWritten,
    }
  })

/* treeChange's change, in `ctx`. */
async function runChange(ctx: MutationCtx, me: Doc<'profiles'>, id: string, change: Change) {
  const now = new Date().toISOString()
  const read = async () => {
    const p = await byId(ctx, 'projects', id)
    if (p === null) throw new Error(`no project ${id}`)
    return p
  }
  const both = change.archive !== undefined && change.name !== undefined
  const budget = both ? treeBudget() : undefined
  if (change.archive !== undefined) {
    const step = { me, project: await read(), now, budget }
    if (change.archive) await archiveProjectCore(ctx, step)
    else await unarchiveProjectCore(ctx, step)
  }
  if (change.name !== undefined)
    await updateProjectCore(ctx, {
      me,
      project: await read(),
      patch: { name: change.name },
      now,
      budget,
    })
  if (budget !== undefined) await settleFavorites(ctx, budget)
}

/** Every row a tree change of `meta` may write: the project and its
 * sub-projects, the reach rows under it and its favorites. */
const treeOf = (t: T, meta: Doc<'projects'>) =>
  t.run(async (ctx) => [
    await byId(ctx, 'projects', meta.id),
    ...(await ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', meta.id))
      .collect()),
    ...(await ctx.db
      .query('project_reach')
      .withIndex('by_root_child', (q) => q.eq('root_id', meta.id))
      .collect()),
    ...(await ctx.db
      .query('project_favorites')
      .withIndex('by_project_profile', (q) => q.eq('project_id', meta.id))
      .collect()),
  ])

describe('the copies follow every tree change', () => {
  it('keeps the name key of every favorite through each rename, and only a rename of the starred project', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const lead = as(t, f.user)
    for (const seat of [f.user, f.viewer, f.guest]) await star(t, seat, f.meta.id)
    const keys = async () => (await favoritesOn(t, f.meta.id)).map((row) => row.name_key)
    await lead.mutation(api.projects.update, {
      org_id,
      id: f.meta.id,
      patch: { name: 'Testbed core' },
    })
    expect(await keys()).toEqual(Array(3).fill(nameKey('Testbed core')))
    await restUpdate(t, f, f.meta.key, { name: 'Testbed REST' })
    expect(await keys()).toEqual(Array(3).fill(nameKey('Testbed REST')))
    await mcpUpdate(t, f, f.meta.key, { name: 'Testbed MCP' })
    expect(await keys()).toEqual(Array(3).fill(nameKey('Testbed MCP')))
    await expectAll(t, 'after the renames')
    // a key change, a rename that keeps the name key, a sub-project's
    // rename and a lead change touch none
    const before = await favorites(t)
    await lead.mutation(api.projects.update, { org_id, id: f.meta.id, patch: { key: 'TBX' } })
    await lead.mutation(api.projects.update, {
      org_id,
      id: f.meta.id,
      patch: { name: 'testbed mcp' },
    })
    await lead.mutation(api.projects.update, { org_id, id: f.sub.id, patch: { name: 'Fw two' } })
    await lead.mutation(api.projects.update, {
      org_id,
      id: f.meta.id,
      patch: { lead_id: f.pia.id },
    })
    expect(await favorites(t)).toEqual(before)
    await expectAll(t, 'after changes that keep the copies')
  })

  it('follows an archive and a restore of a top-level project, and of none below it', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const lead = as(t, f.user)
    for (const seat of [f.user, f.viewer]) await star(t, seat, f.meta.id)
    const live = async () => (await favoritesOn(t, f.meta.id)).map((row) => row.live)
    await lead.mutation(api.projects.archive, { org_id, id: f.meta.id })
    expect(await live()).toEqual([false, false])
    await expectFavoritesExact(t)
    await lead.mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    expect(await live()).toEqual([true, true])
    // a sub-project's archive and restore under a live parent touch none
    const before = await favorites(t)
    await lead.mutation(api.projects.archive, { org_id, id: f.sub.id })
    expect(await favorites(t)).toEqual(before)
    await lead.mutation(api.projects.unarchive, { org_id, id: f.sub.id })
    expect(await favorites(t)).toEqual(before)
    // a restore of a sub-project brings its archived parent back live
    await lead.mutation(api.projects.archive, { org_id, id: f.meta.id })
    expect(await live()).toEqual([false, false])
    await lead.mutation(api.projects.unarchive, { org_id, id: f.sub.id })
    expect(await live()).toEqual([true, true])
    // and REST and MCP archive and restore alike
    await restUpdate(t, f, f.meta.key, { archived: true })
    expect(await live()).toEqual([false, false])
    await mcpUpdate(t, f, f.meta.key, { archived: false })
    expect(await live()).toEqual([true, true])
    await expectAll(t, 'after archives and restores')
  })

  it('writes each favorite once when one REST or MCP update archives or restores and renames', async () => {
    const t = newT()
    const f = await ready(t)
    await star(t, f.user, f.meta.id)
    await restUpdate(t, f, f.meta.key, { archived: true, name: 'Both at once' })
    expect(await rowOf(t, f.user, f.meta.id)).toMatchObject({
      name_key: nameKey('Both at once'),
      live: false,
    })
    await mcpUpdate(t, f, f.meta.key, { archived: false, name: 'Back at once' })
    expect(await rowOf(t, f.user, f.meta.id)).toMatchObject({
      name_key: nameKey('Back at once'),
      live: true,
    })
    // both changes write each of 3 favorites once, as one change does
    await plantFavorites(t, (await projectOf(t, f.meta.id)) as Doc<'projects'>, 2)
    for (const change of [
      { archive: true, name: 'Again' },
      { archive: false, name: 'Once more' },
      { archive: true },
      { name: 'Renamed alone' },
    ] as const)
      expect(await treeChange(t, f.user, f.meta.id, change)).toMatchObject({ favoritesWritten: 3 })
    await expectFavoritesExact(t)
  })

  it(`refuses a change past TREE_FAVORITES.max favorites before it writes, whole`, async () => {
    const t = newT()
    const f = await ready(t)
    TREE_FAVORITES.max = 3
    await plantFavorites(t, f.meta, 3)
    const refused = { refused: TREE_TOO_MANY_FAVORITES }
    // three fit an archive, a restore and a rename, and an update that
    // makes two of them, because it reads the favorites once
    for (const change of [
      { archive: true },
      { archive: false },
      { name: 'Three fit' },
      { archive: true, name: 'Three fit both' },
    ] as const)
      expect(await treeChange(t, f.user, f.meta.id, change)).not.toHaveProperty('refused')
    // with a fourth, each refuses and writes nothing: a restore of the
    // tree, then of a sub-project, which brings the parent back
    await plantFavorites(t, (await projectOf(t, f.meta.id)) as Doc<'projects'>, 1)
    const before = await treeOf(t, f.meta)
    for (const change of [{ archive: false }, { archive: false, name: 'Four do not fit' }] as const)
      expect(await treeChange(t, f.user, f.meta.id, change)).toEqual(refused)
    expect(await treeChange(t, f.user, f.sub.id, { archive: false })).toEqual(refused)
    expect(await treeOf(t, f.meta)).toEqual(before)
    // TBED live again with three, then four
    TREE_FAVORITES.max = 4
    await treeChange(t, f.user, f.meta.id, { archive: false })
    TREE_FAVORITES.max = 3
    const live = await treeOf(t, f.meta)
    for (const change of [
      { archive: true },
      { name: 'Four do not fit' },
      { archive: true, name: 'Four do not fit' },
    ] as const)
      expect(await treeChange(t, f.user, f.meta.id, change)).toEqual(refused)
    expect(await treeOf(t, f.meta)).toEqual(live)
    // the REST update meets the sentence, and so would two requests
    const e = await expectRefusal(
      restUpdate(t, f, f.meta.key, { archived: true, name: 'Both' }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(TREE_TOO_MANY_FAVORITES)
    for (const body of [{ archived: true }, { name: 'One at a time' }])
      await expectRefusal(restUpdate(t, f, f.meta.key, body), 'rule', /among their favorites/)
    expect(await treeOf(t, f.meta)).toEqual(live)
  })

  it("counts a row another organization left on the project's id and never writes it", async () => {
    const t = newT()
    const f = await ready(t)
    await star(t, f.user, f.meta.id)
    await t.run((ctx) =>
      ctx.db.insert('project_favorites', {
        org_id: f.otherOrg.id,
        profile_id: f.otherAdmin.id,
        project_id: f.meta.id,
        name_key: 'elsewhere',
        live: true,
        created_at: NOW,
      }),
    )
    const foreign = async () => (await favorites(t)).filter((row) => row.org_id === f.otherOrg.id)
    const planted = await foreign()
    TREE_FAVORITES.max = 1
    expect(await treeChange(t, f.user, f.meta.id, { archive: true })).toEqual({
      refused: TREE_TOO_MANY_FAVORITES,
    })
    TREE_FAVORITES.max = 2
    await treeChange(t, f.user, f.meta.id, { name: 'Renamed here' })
    await treeChange(t, f.user, f.meta.id, { archive: true })
    expect(await foreign()).toEqual(planted)
    expect(await rowOf(t, f.user, f.meta.id)).toMatchObject({
      name_key: nameKey('Renamed here'),
      live: false,
    })
  })
})

/* Source-text scan, as tests/projectReach.test.ts scans the grant writers. */
const sources = import.meta.glob(['../**/*.ts', '!../_generated/**', '!../tests/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

describe('the one way to write a favorite', () => {
  const INSERT = /\.insert\(\s*['"]project_favorites['"]/
  /* A read of favorites rows: the table, a range of
   * model/projectFavorites.ts, or the rows a tree budget read. */
  const READ =
    /\.query\(\s*['"]project_favorites['"]|\bfavorite(?:sOn|sOfOrg|sOfProfile|Of)\(|\.starred\b/g
  /* Whether a statement of `source` reads favorites rows and then calls
   * `write` on any receiver. A statement runs from the read to the end of
   * its line and on over the lines indented deeper than that line, such as
   * the body of a loop over the rows or of a callback they are passed to,
   * which is where every writer and teardown handles the rows it read. */
  const writesAfterRead = (source: string, write: RegExp) =>
    [...source.matchAll(READ)].some((read) => {
      const at = read.index ?? 0
      const start = source.lastIndexOf('\n', at) + 1
      const indent = (line: string) => line.length - line.trimStart().length
      const base = indent(source.slice(start, source.indexOf('\n', at)))
      const lines = source.slice(at).split('\n')
      const rest = lines.slice(1)
      const end = rest.findIndex((line) => line.trim() !== '' && indent(line) <= base)
      const statement = [lines[0], ...rest.slice(0, end === -1 ? rest.length : end)].join('\n')
      return write.test(statement)
    })
  const PATCH = /\.\s*(?:patch|replace)\(/
  const DELETE = /\.\s*delete\(/

  it('inserts them only in model/projectFavorites.ts', () => {
    // the scan sees the file that inserts them, so its silence means something
    expect(sources['../model/projectFavorites.ts']).toMatch(INSERT)
    const others = Object.entries(sources)
      .filter(([path, source]) => path !== '../model/projectFavorites.ts' && INSERT.test(source))
      .map(([path]) => path)
    expect(others).toEqual([])
  })

  it('patches them only in the writer and the tree changes', () => {
    const allowed = new Set(['../model/projectFavorites.ts', '../model/projectNav.ts'])
    for (const path of allowed) expect(writesAfterRead(sources[path], PATCH), path).toBe(true)
    // a loop over the rows, a callback on one line or below it, and a
    // write after the statement ended, which the scan leaves
    const loop =
      'for await (const row of favoritesOn(ctx, id)) {\n  if (x) y()\n  await w.patch(row._id, {})\n}'
    expect(writesAfterRead(loop, PATCH)).toBe(true)
    expect(
      writesAfterRead("drain(b, ctx.db.query('project_favorites'), (r) => db.replace(r))", PATCH),
    ).toBe(true)
    expect(
      writesAfterRead('for (const [id, rows] of budget.starred) {\n    ctx.db.patch(id)', PATCH),
    ).toBe(true)
    expect(
      writesAfterRead('  drain(b, favoritesOfOrg(ctx, o))\n  await ctx.db.patch(r, {})', PATCH),
    ).toBe(false)
    const others = Object.entries(sources)
      .filter(([path, source]) => !allowed.has(path) && writesAfterRead(source, PATCH))
      .map(([path]) => path)
    expect(others).toEqual([])
  })

  it('deletes them only in the writer and the teardowns', () => {
    const allowed = new Set([
      '../model/projectFavorites.ts',
      '../model/cascade.ts',
      '../model/orgDeletion.ts',
      '../internal/demoCleanup.ts',
      '../model/deletedItems.ts',
    ])
    // the scan sees deletes in the files it allows that delete in place
    for (const path of [
      '../model/projectFavorites.ts',
      '../model/cascade.ts',
      '../model/deletedItems.ts',
    ])
      expect(writesAfterRead(sources[path], DELETE), path).toBe(true)
    const others = Object.entries(sources)
      .filter(([path, source]) => !allowed.has(path) && writesAfterRead(source, DELETE))
      .map(([path]) => path)
    expect(others).toEqual([])
  })
})

/** A top-level project of the fixture's organization led by its user, with
 * an ordinary name, `subs` live sub-projects, the root reach rows of
 * `roots` people on it and the child reach rows of `children` people,
 * spread over its sub-projects. Planted raw, in transactions within
 * Convex's limits. */
async function wideTree(
  t: T,
  f: OrgFixture,
  { subs, roots, children }: { subs: number; roots: number; children: number },
) {
  const meta = await plantProject(t, {
    org_id: f.org.id,
    lead_id: f.user.id,
    name: 'Envelope launch programme',
    name_key: nameKey('Envelope launch programme'),
    archive_state: 'live',
  })
  const ids: string[] = []
  for (let from = 0; from < subs; from += 200)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(subs, from + 200); i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: meta.id,
          key: `WS${i}`,
          name: `Workstream ${i}`,
          name_key: nameKey(`Workstream ${i}`),
          description: 'Delivery work for one part of the launch.',
          sort_order: i,
          num: 10_000 + i,
          track_delay: false,
          created_at: NOW,
          archive_state: 'live',
        })
      }
    })
  await reachRowsOn(t, f, meta, roots, [])
  await reachRowsOn(t, f, meta, children, ids)
  return meta
}

/** Plants `n` more reach rows of new people under top-level project `meta`:
 * root rows on it, or child rows spread over sub-projects `subs`. */
async function reachRowsOn(
  t: T,
  f: OrgFixture,
  meta: Doc<'projects'>,
  n: number,
  subs: readonly string[],
) {
  for (let from = 0; from < n; from += 500)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 500); i++) {
        const child = subs.length > 0
        const project_id = child ? subs[i % subs.length] : meta.id
        const p = child ? await byId(ctx, 'projects', project_id) : meta
        await ctx.db.insert('project_reach', {
          org_id: f.org.id,
          grantee_kind: 'profile',
          grantee_id: uuid(),
          kind: child ? 'child' : 'root',
          project_id,
          root_id: meta.id,
          name_key: nameKey(p?.name ?? ''),
          key: p?.key ?? '',
          live: true,
          on_root: !child,
        })
      }
    })
}

/** What a measured change read and wrote, with the index ranges a deployment
 * counts: convex-test counts the queries, and a deployment also reads by id
 * each row it patches or deletes, which `written` bounds (it counts inserts
 * too, which read nothing). */
function logged(label: string, m: Awaited<ReturnType<typeof treeChange>>) {
  if ('refused' in m) throw new Error(`${label} was refused: ${m.refused}`)
  const withWrites = m.ranges + m.written
  console.log(`${label}:`, { ...m, ranges_with_writes: withWrites })
  expect(m.read).toBeLessThan(16)
  expect(withWrites).toBeLessThan(3_600)
  return m
}

/* The size of sub-project `p` as a tree change counts it, once archived. */
const archivedSize = (p: Doc<'projects'>) =>
  getDocumentSize({ ...p, archived_at: p.archived_at ?? NOW, archive_state: 'listed' })

describe('at the limits', () => {
  const { max } = LIMITS.projectTreeChange

  it(`archives, restores and renames a project of ${max} entries and ${TREE_FAVORITES.max} favorites within the limits`, async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // the archive and the restore read 200 sub-projects, 1,000 root rows
    // and 800 child rows; the rename then reads 2,000 root rows
    const meta = await wideTree(t, f, { subs: 200, roots: 1_000, children: 800 })
    await plantFavorites(t, meta, TREE_FAVORITES.max)
    logged('archive', await treeChange(t, f.user, meta.id, { archive: true }))
    logged('restore', await treeChange(t, f.user, meta.id, { archive: false }))
    await reachRowsOn(t, f, meta, 1_000, [])
    logged('rename', await treeChange(t, f.user, meta.id, { name: 'Envelope programme' }))
    expect(new Set((await favoritesOn(t, meta.id)).map((row) => row.name_key))).toEqual(
      new Set([nameKey('Envelope programme')]),
    )
    // one entry more is refused, whole
    await reachRowsOn(t, f, meta, 1, [])
    const before = await treeOf(t, meta)
    expect(await treeChange(t, f.user, meta.id, { name: 'One too many' })).toEqual({
      refused: LIMITS.projectTreeChange.refusal,
    })
    expect(await treeOf(t, meta)).toEqual(before)
  }, 300_000)

  it(`archives and renames such a project in one REST update with ${TREE_FAVORITES.max} favorites within the limits`, async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // the archive reads 200 sub-projects, 800 root rows and 200 child rows,
    // and the rename the 800 root rows again: 2,000 entries
    const meta = await wideTree(t, f, { subs: 200, roots: 800, children: 200 })
    await plantFavorites(t, meta, TREE_FAVORITES.max)
    const both = logged(
      'archive and rename',
      await treeChange(t, f.user, meta.id, { archive: true, name: 'Envelope, archived' }),
    )
    expect(both).toMatchObject({ favoritesWritten: TREE_FAVORITES.max })
    // and the REST update itself, with its answer
    await restUpdate(t, f, meta.key, { archived: false, name: 'Envelope, restored' })
    expect(new Set((await favoritesOn(t, meta.id)).map((row) => row.live))).toEqual(new Set([true]))
  }, 300_000)

  it('counts favorites at the name cap against TREE_READ.bytes, and refuses a tree just past it whole', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a name at the cap in a three-byte script, which its favorites copy
    const name = '一'.repeat(NAME_MAX)
    const meta = await plantProject(t, {
      org_id: f.org.id,
      lead_id: f.user.id,
      name,
      name_key: nameKey(name),
      archive_state: 'live',
    })
    await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: meta.id })
    await reachRowsOn(t, f, meta, 20, [])
    await plantFavorites(t, meta, 200)
    const bytes = await t.run(async (ctx) => {
      const subs = await ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', meta.id))
        .collect()
      const rows = await ctx.db
        .query('project_reach')
        .withIndex('by_root_child', (q) => q.eq('root_id', meta.id))
        .collect()
      const faves = await ctx.db
        .query('project_favorites')
        .withIndex('by_project_profile', (q) => q.eq('project_id', meta.id))
        .collect()
      return {
        tree:
          subs.reduce((n, p) => n + archivedSize(p), 0) +
          rows.reduce((n, row) => n + getDocumentSize(row), 0),
        favorites: faves.reduce((n, row) => n + getDocumentSize(row), 0),
      }
    })
    console.log('a tree with 200 favorites at the name cap:', bytes)
    TREE_READ.bytes = bytes.tree + bytes.favorites - 1
    const before = await treeOf(t, meta)
    expect(await treeChange(t, f.user, meta.id, { archive: true })).toEqual({
      refused: TREE_TOO_LARGE,
    })
    expect(await treeOf(t, meta)).toEqual(before)
    TREE_READ.bytes = bytes.tree + bytes.favorites
    expect(await treeChange(t, f.user, meta.id, { archive: true })).not.toHaveProperty('refused')
  })

  it("archives, restores and renames the envelope's realistic tree", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    // 200 sub-projects, 25 teams sharing the project, 40 people with a
    // grant on a sub-project each and 1,000 favorites
    const meta = await wideTree(t, f, { subs: 200, roots: 0, children: 0 })
    await t.run(async (ctx) => {
      const subs = await ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', meta.id))
        .collect()
      for (let i = 0; i < 25; i++) {
        const team_id = uuid()
        await ctx.db.insert('teams', {
          id: team_id,
          org_id,
          name: `Crew ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('project_team_access', { project_id: meta.id, team_id, level: 'user' })
      }
      for (let i = 0; i < 40; i++) {
        const profile_id = uuid()
        await ctx.db.insert('profiles', {
          id: profile_id,
          org_id,
          name: `Contributor ${i}`,
          initials: 'CT',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
        await ctx.db.insert('project_access', {
          project_id: subs[i * 5].id,
          profile_id,
          level: 'user',
        })
      }
    })
    await plantFavorites(t, meta, 1_000)
    await withReach(t)
    const lead = as(t, f.user)
    await lead.mutation(api.projects.archive, { org_id, id: meta.id })
    await lead.mutation(api.projects.unarchive, { org_id, id: meta.id })
    await lead.mutation(api.projects.update, {
      org_id,
      id: meta.id,
      patch: { name: 'Envelope programme' },
    })
    logged(
      'the realistic tree, archived and renamed in one update',
      await treeChange(t, f.user, meta.id, { archive: true, name: 'Envelope, archived' }),
    )
    await expectFavoritesExact(t)
  }, 300_000)
})

describe('lost access', () => {
  it('leaves the row as it is, and the row shows again when access returns', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      user_id: f.pia.id,
      level: 'user',
    })
    await star(t, f.pia, f.meta.id)
    const [row] = await favorites(t)
    /* Runs `change`, then checks that the row is unchanged and whether it
     * shows. */
    const leaves = async (change: Promise<unknown>, visible: boolean) => {
      await change
      expect(await favorites(t)).toEqual([row])
      expect(await shows(t, row)).toBe(visible)
    }
    const removeGrant = () =>
      admin.mutation(api.projects.removeAccess, {
        org_id,
        id: f.meta.id,
        user_id: f.pia.id,
        on_held_tasks: 'leave',
      })
    expect(await shows(t, row)).toBe(true)
    // a grant
    await leaves(removeGrant(), false)
    // a team share and a membership
    await leaves(
      admin.mutation(api.teams.addMember, { org_id, team_id: f.team.id, profile_id: f.pia.id }),
      false,
    )
    await leaves(
      admin.mutation(api.projects.setAccess, {
        org_id,
        id: f.meta.id,
        team_id: f.team.id,
        level: 'viewer',
      }),
      true,
    )
    await leaves(
      admin.mutation(api.teams.removeMember, { org_id, team_id: f.team.id, profile_id: f.pia.id }),
      false,
    )
    await leaves(
      admin.mutation(api.teams.addMember, { org_id, team_id: f.team.id, profile_id: f.pia.id }),
      true,
    )
    await leaves(
      admin.mutation(api.projects.removeAccess, {
        org_id,
        id: f.meta.id,
        team_id: f.team.id,
        on_held_tasks: 'leave',
      }),
      false,
    )
    // the lead, handed to Pia and back, which leaves her a User grant
    await leaves(
      admin.mutation(api.projects.update, { org_id, id: f.meta.id, patch: { lead_id: f.pia.id } }),
      true,
    )
    await leaves(
      admin.mutation(api.projects.update, { org_id, id: f.meta.id, patch: { lead_id: f.user.id } }),
      true,
    )
    await leaves(removeGrant(), false)
    // a role change to Viewer, with a grant again
    await leaves(
      admin.mutation(api.projects.setAccess, {
        org_id,
        id: f.meta.id,
        user_id: f.pia.id,
        level: 'user',
      }),
      true,
    )
    await leaves(
      admin.mutation(api.profiles.update, { org_id, id: f.pia.id, patch: { org_role: 'viewer' } }),
      true,
    )
    await leaves(removeGrant(), false)
    await expectAll(t, 'after lost access')
  })
})

describe('teardowns', () => {
  /** Pia with a User grant on TBED and Skunkworks, both starred, and the
   * user's star on TBED. */
  async function starred(t: T) {
    const f = await ready(t)
    for (const id of [f.meta.id, f.hidden.id]) {
      await as(t, f.admin).mutation(api.projects.setAccess, {
        org_id: f.org.id,
        id,
        user_id: f.pia.id,
        level: 'user',
      })
      await star(t, f.pia, id)
    }
    await star(t, f.user, f.meta.id)
    return f
  }
  const ofSeat = async (t: T, seat: Doc<'profiles'>) =>
    (await favorites(t)).filter((row) => row.profile_id === seat.id)

  it("deletes a removed seat's favorites, the rest in its background steps, and no one else's", async () => {
    const t = newT()
    const f = await starred(t)
    ACCESS_FIRST_PASS.rows = 1
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.pia.id })
    expect(await ofSeat(t, f.pia)).toHaveLength(2)
    await runSteps(t)
    expect(await ofSeat(t, f.pia)).toEqual([])
    expect(await ofSeat(t, f.user)).toHaveLength(1)
    await expectAll(t, 'after a profile removal')
  })

  it('deletes them in an organization deletion in steps, before their seats and project ids go', async () => {
    const t = newT()
    const f = await starred(t)
    // the other organization's own favorite, which stays
    await plantFavorites(t, f.otherProject, 1)
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
        phase: 'profiles',
      }),
    )
    REMOVAL_BUDGET.rows = 3
    let steps = 0
    for (;;) {
      const done = await t.run(async (ctx) => {
        const removal = await ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        return removal === null ? true : await deleteOrgStep(ctx, removal)
      })
      // no step leaves a favorite of a seat it deleted, or of a project id
      // it let go
      const orphans = await t.run(async (ctx) => {
        const out: string[] = []
        for (const row of await ctx.db.query('project_favorites').collect()) {
          if ((await byId(ctx, 'profiles', row.profile_id)) === null)
            out.push(`seat ${row.profile_id}`)
          const held = await ctx.db
            .query('used_ids')
            .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', row.project_id))
            .first()
          if (held === null && (await byId(ctx, 'projects', row.project_id)) === null)
            out.push(`project ${row.project_id}`)
        }
        return out
      })
      expect(orphans).toEqual([])
      if (done) break
      expect(++steps).toBeLessThan(400)
    }
    expect(await t.run((ctx) => byId(ctx, 'organizations', f.org.id))).toBeNull()
    expect((await favorites(t)).map((row) => row.org_id)).toEqual([f.otherOrg.id])
  })

  it('drains favorites an earlier release left past the profiles and projects phases, in the last phase', async () => {
    const t = newT()
    const f = await starred(t)
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
        phase: 'profiles',
      }),
    )
    REMOVAL_BUDGET.rows = 3
    let planted = false
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(400)
      const removal = await t.run((ctx) =>
        ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique(),
      )
      if (removal === null) break
      if (!planted && ['teams', 'labels', 'activity', 'webhooks'].includes(removal.phase ?? '')) {
        // an earlier release deleted a seat and a project without them
        await t.run((ctx) =>
          ctx.db.insert('project_favorites', {
            org_id: f.org.id,
            profile_id: uuid(),
            project_id: f.meta.id,
            name_key: nameKey(f.meta.name),
            live: true,
            created_at: NOW,
          }),
        )
        planted = true
      }
      await t.run((ctx) => deleteOrgStep(ctx, removal))
    }
    expect(planted).toBe(true)
    expect(await t.run((ctx) => byId(ctx, 'organizations', f.org.id))).toBeNull()
    expect(await favorites(t)).toEqual([])
  })

  it("deletes the organization's favorites in deleteOrgDeep and leaves the other's", async () => {
    const t = newT()
    const f = await starred(t)
    await plantFavorites(t, f.otherProject, 1)
    await t.run(async (ctx) => {
      const org = await byId(ctx, 'organizations', f.org.id)
      if (org !== null) await deleteOrgDeep(ctx, org)
    })
    expect((await favorites(t)).map((row) => row.org_id)).toEqual([f.otherOrg.id])
    await expectAll(t, 'after deleteOrgDeep')
  })
})

describe('Deleted items', () => {
  it('keeps a star through a delete and a restore, and deletes it with the purge', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await star(t, f.user, f.meta.id)
    await star(t, f.viewer, f.meta.id)
    const before = await favorites(t)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    await runSteps(t)
    expect(await projectOf(t, f.meta.id)).toBeNull()
    expect(await favorites(t)).toEqual(before)
    await expectAll(t, 'with the project in Deleted items')
    const item = await itemFor(t, f.meta.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    await runSteps(t)
    expect(await projectOf(t, f.meta.id)).not.toBeNull()
    expect(await favorites(t)).toEqual(before)
    for (const row of before) expect(await shows(t, row)).toBe(true)
    await expectAll(t, 'after the restore')
    // Delete now
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    await runSteps(t)
    const again = await itemFor(t, f.meta.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id, ids: [again.id] })
    await runSteps(t)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', again.id))).toBeNull()
    expect(await favorites(t)).toEqual([])
    await expectAll(t, 'after the purge')
    // the id stays taken
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, {
        org_id,
        id: f.meta.id,
        type: 'meta',
        key: 'BACK',
        name: 'Back again',
        sort_order: 9,
      }),
      'bad_request',
      /^a project with this id already exists$/,
    )
  })

  it('deletes them when the item expires', async () => {
    const t = newT()
    const f = await ready(t)
    await star(t, f.user, f.meta.id)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    await runSteps(t)
    vi.setSystemTime(Date.now() + 31 * DAY)
    await t.mutation(internal.deletedItems.expire, {})
    await runSteps(t)
    expect(await favorites(t)).toEqual([])
    await expectAll(t, 'after the expiry')
  })

  it('goes back to the favorites when one is left after the purge passed them', async () => {
    const t = newT()
    const f = await ready(t)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    await t.run(async (ctx) => {
      const live = await byId(ctx, 'deleted_items', item.id)
      if (live !== null) await startPurge(ctx, live)
    })
    TRASH_BUDGET.rows = 2
    let planted = false
    for (let n = 0; (await jobFor(t, item.id)) !== null; n++) {
      expect(n).toBeLessThan(200)
      const job = await jobFor(t, item.id)
      if (
        !planted &&
        ['purge_rows', 'purge_activity', 'purge_projects'].includes(job?.phase ?? '')
      ) {
        // a star of the project that a step past purge_live did not see
        await t.run((ctx) =>
          ctx.db.insert('project_favorites', {
            org_id: f.org.id,
            profile_id: f.user.id,
            project_id: f.meta.id,
            name_key: nameKey(f.meta.name),
            live: true,
            created_at: NOW,
          }),
        )
        planted = true
      }
      await step(t, item.id)
    }
    expect(planted).toBe(true)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
    expect(await favorites(t)).toEqual([])
    await expectAll(t, 'after a purge that went back')
  })

  it("leaves the parent's favorites alone when a sub-project is deleted, restored and purged", async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await star(t, f.user, f.meta.id)
    const before = await favorites(t)
    const lead = as(t, f.user)
    await lead.mutation(api.projects.deleteDeep, { org_id, id: f.sub.id })
    await runSteps(t)
    expect(await favorites(t)).toEqual(before)
    await lead.mutation(api.deletedItems.restore, {
      org_id,
      ids: [(await itemFor(t, f.sub.id)).id],
    })
    await runSteps(t)
    expect(await favorites(t)).toEqual(before)
    await lead.mutation(api.projects.deleteDeep, { org_id, id: f.sub.id })
    await runSteps(t)
    await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id,
      ids: [(await itemFor(t, f.sub.id)).id],
    })
    await runSteps(t)
    expect(await favorites(t)).toEqual(before)
    await expectAll(t, 'after a sub-project went')
  })

  it("deletes them in the organization's Deleted items purge, before the stored project goes", async () => {
    const t = newT()
    const f = await ready(t)
    await star(t, f.user, f.meta.id)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    await runSteps(t)
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(100)
      const { done } = await t.mutation(internal.deletedItems.purgeOrg, { org_id: f.org.id })
      if (done) break
    }
    expect(await favorites(t)).toEqual([])
    await expectAll(t, 'after purgeOrg')
  })
})

describe('id reuse', () => {
  it('never lets a project another organization creates with a freed id adopt an old row', async () => {
    const t = newT()
    const f = await ready(t)
    await star(t, f.user, f.meta.id)
    await t.run(async (ctx) => {
      const org = await byId(ctx, 'organizations', f.org.id)
      if (org !== null) await deleteOrgDeep(ctx, org)
    })
    expect(await favorites(t)).toEqual([])
    // a row a rollback left of the deleted organization's seat
    await t.run((ctx) =>
      ctx.db.insert('project_favorites', {
        org_id: f.org.id,
        profile_id: f.user.id,
        project_id: f.meta.id,
        name_key: nameKey(f.meta.name),
        live: true,
        created_at: NOW,
      }),
    )
    const [old] = await favorites(t)
    const other = as(t, f.otherAdmin)
    await other.mutation(api.projects.create, {
      org_id: f.otherOrg.id,
      id: f.meta.id,
      type: 'meta',
      key: 'REUSE',
      name: 'Reused',
      lead_id: f.otherAdmin.id,
      sort_order: 1,
    })
    await other.mutation(api.projects.update, {
      org_id: f.otherOrg.id,
      id: f.meta.id,
      patch: { name: 'Reused and renamed' },
    })
    expect(await favorites(t)).toEqual([old])
    expect(await shows(t, old)).toBe(false)
    await star(t, f.otherAdmin, f.meta.id)
    const mine = await rowOf(t, f.otherAdmin, f.meta.id)
    expect(mine).toMatchObject({ org_id: f.otherOrg.id, name_key: nameKey('Reused and renamed') })
    expect(await shows(t, mine as Favorite)).toBe(true)
    expect(await favorites(t)).toContainEqual(old)
  })
})
