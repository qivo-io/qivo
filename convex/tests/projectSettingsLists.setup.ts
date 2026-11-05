/* The rule of the Settings project lists (model/projectSettingsLists.ts)
 * worked out from the projects, their archive stamps and lib/access.ts
 * projectLevel alone, without reach rows, the organization's indexes or
 * the code under test, for the suites that check them
 * (projectSettingsLists.test.ts and src/store/projectSettingsListsParity.test.ts).
 * Two dots in the basename keep the Convex CLI from deploying this module,
 * as helpers.setup.ts.
 *
 * An active organization admin lists every project of their organization
 * in a top-level meta's tree. Anyone else lists what they see: a live
 * top-level project by the navigation rule (projectNav.setup.ts navSees);
 * a live sub-project, with a search, when they hold a level on it; an
 * archived top-level meta when they hold a level on it for a reason of
 * their own (projectLevel without navigation of ordinaryOf(seat)) or on an
 * archived sub-project beneath it; an archived sub-project when they hold
 * a level on it. A right is Lead access by the writes' level rule
 * (projectLevel of the seat as it is, 'lead'), which an admin holds on
 * every project today; the admin access split replaces that branch, and
 * these rights with it, by the management predicate. */

import { compareValues } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ordinaryOf, projectLevel } from '../lib/access'
import { byId } from '../lib/db'
import { nameKey } from '../lib/nameKey'
import type { T } from './helpers.setup'
import { navSees } from './projectNav.setup'

/* projectLevel of `seat` as ordinary access judges it, null where it
 * throws for a broken tree. */
async function levelOf(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
  p: Doc<'projects'>,
  navigation = true,
): Promise<string | null> {
  try {
    return await projectLevel(ctx, ordinaryOf(seat), p, navigation)
  } catch {
    return null
  }
}

/** Whether `seat` holds Lead access on `p` by the writes' rule
 * (hasProjectLevel 'lead': projectLevel of the seat as it is). */
export async function leads(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<boolean> {
  try {
    return (await projectLevel(ctx, seat, p, false)) === 'lead'
  } catch {
    return false
  }
}

/* Whether `seat` is an active organization admin. */
const admin = (seat: Doc<'profiles'>) => seat.active && seat.org_role === 'admin'

/* Whether `p` is a top-level meta. */
const topMeta = (p: Doc<'projects'>) => p.parent_id === undefined && p.type === 'meta'

/* `p` as a row names its parent. */
const ref = (p: Doc<'projects'>) => ({ id: p.id, name: p.name, num: p.num })

/* Whether `name` holds every word of `term`'s name key. */
const matcher = (term: string) => {
  const words = nameKey(term)
    .split(' ')
    .filter((word) => word !== '')
  return { words, matches: (name: string) => words.every((w) => nameKey(name).includes(w)) }
}

/* The top-level meta of `seat`'s organization above sub-project `p`, or
 * null. */
async function parentOf(ctx: QueryCtx, p: Doc<'projects'>): Promise<Doc<'projects'> | null> {
  if (p.parent_id === undefined) return null
  const parent = await byId(ctx, 'projects', p.parent_id)
  return parent !== null && parent.org_id === p.org_id && topMeta(parent) ? parent : null
}

/* Every project of `seat`'s organization. */
const projectsOf = (ctx: QueryCtx, seat: Doc<'profiles'>) =>
  ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', seat.org_id))
    .collect()

/** A row of Settings › Projects as the rule names it. */
export type ExpectedProject = {
  id: string
  name: string
  num: number
  parent: { id: string; name: string; num: number } | null
  can_create_sub_project: boolean
}

/** What projectSettings.projects should answer `seat` over every batch, in
 * name key byte order with the id breaking ties: the live top-level metas
 * the seat lists, each with Lead access as its right to a sub-project, and
 * with `term` the live sub-projects too, each with its parent, every word
 * of the term in the name; with `parentsOnly` the top-level ones with the
 * right alone. */
export const expectedProjects = (t: T, seat: Doc<'profiles'>, term = '', parentsOnly = false) =>
  t.run(async (ctx) => {
    const { words, matches } = matcher(term)
    const out: ExpectedProject[] = []
    for (const p of await projectsOf(ctx, seat)) {
      if (p.archived_at !== undefined || !matches(p.name)) continue
      if (p.parent_id === undefined) {
        if (p.type !== 'meta') continue
        if (!admin(seat) && !(await navSees(ctx, seat, p))) continue
        const can = await leads(ctx, seat, p)
        if (parentsOnly && !can) continue
        out.push({ ...ref(p), parent: null, can_create_sub_project: can })
        continue
      }
      if (parentsOnly || words.length === 0) continue
      const parent = await parentOf(ctx, p)
      if (parent === null || parent.archived_at !== undefined) continue
      if (!admin(seat) && !(await navSees(ctx, seat, p))) continue
      out.push({ ...ref(p), parent: ref(parent), can_create_sub_project: false })
    }
    return out.sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))
  })

/** What projectSettings.subProjects should answer `seat` for top-level
 * project `parent` over every batch, in name key order with the id
 * breaking ties, or null where the seat may not list under it: every live
 * sub-project of a live top-level meta of an admin's organization, or
 * those the seat sees under one it sees for navigation. */
export const expectedSubProjects = (t: T, seat: Doc<'profiles'>, parent: Doc<'projects'>) =>
  t.run(async (ctx) => {
    const p = await byId(ctx, 'projects', parent.id)
    if (p === null || p.org_id !== seat.org_id || p.archived_at !== undefined || !topMeta(p))
      return null
    if (!admin(seat) && !(await navSees(ctx, seat, p))) return null
    const kids = await ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', p.id))
      .collect()
    const out: Doc<'projects'>[] = []
    for (const kid of kids) {
      if (kid.org_id !== p.org_id || kid.archived_at !== undefined) continue
      if (admin(seat) || (await navSees(ctx, seat, kid))) out.push(kid)
    }
    return out
      .sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))
      .map((c) => ({ id: c.id, org_id: c.org_id, name: c.name, num: c.num, parent_id: p.id }))
  })

/* The archived sub-projects beneath top-level project `p` the seat sees:
 * every one for an admin. */
async function archivedBeneath(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<Doc<'projects'>[]> {
  const kids = await ctx.db
    .query('projects')
    .withIndex('by_parent', (q) => q.eq('parent_id', p.id))
    .collect()
  const out: Doc<'projects'>[] = []
  for (const kid of kids) {
    if (kid.org_id !== p.org_id || kid.archived_at === undefined) continue
    if (admin(seat) || (await levelOf(ctx, seat, kid)) !== null) out.push(kid)
  }
  return out
}

/** Whether `seat` lists archived top-level project `p` in Archived
 * projects: an admin every archived top-level meta of their organization,
 * anyone else one they hold a level on for a reason of their own, or on an
 * archived sub-project beneath it. */
export async function archiveSees(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<boolean> {
  if (p.org_id !== seat.org_id || p.archived_at === undefined || !topMeta(p)) return false
  if (admin(seat) || (await levelOf(ctx, seat, p, false)) !== null) return true
  return (await archivedBeneath(ctx, seat, p)).length > 0
}

/** A row of Archived projects as the rule names it, with its project's
 * archive position. */
export type ExpectedArchived = {
  id: string
  name: string
  num: number
  archived_at: string
  parent: { id: string; name: string; num: number } | null
  under: boolean
  with_parent: boolean | null
  has_sub_projects: boolean | null
  can_restore: boolean
  can_delete: boolean
}

/** What projectSettings.archived should answer `seat` over every batch,
 * newest archived first, equal archive times by _creationTime and then
 * _id, both descending: the archived top-level metas the seat lists, each
 * with whether an archived sub-project it sees sits beneath it, and the
 * archived sub-projects of live top-level metas it sees; with `term` also
 * the archived sub-projects beneath an archived parent it sees, with that
 * parent, every word of the term in the name. A right is Lead access, and
 * a row beneath an archived parent carries its parent's restore and no
 * delete. */
export const expectedArchived = (t: T, seat: Doc<'profiles'>, term = '') =>
  t.run(async (ctx) => {
    const { words, matches } = matcher(term)
    const found: { row: ExpectedArchived; at: (string | number)[] }[] = []
    for (const p of await projectsOf(ctx, seat)) {
      if (p.archived_at === undefined || !matches(p.name)) continue
      const at = [p.archived_at, p._creationTime, p._id]
      const base = { id: p.id, name: p.name, num: p.num, archived_at: p.archived_at }
      if (p.parent_id === undefined) {
        if (!(await archiveSees(ctx, seat, p))) continue
        const can = await leads(ctx, seat, p)
        const has = (await archivedBeneath(ctx, seat, p)).length > 0
        found.push({
          row: {
            ...base,
            parent: null,
            under: false,
            with_parent: null,
            has_sub_projects: has,
            can_restore: can,
            can_delete: can,
          },
          at,
        })
        continue
      }
      const parent = await parentOf(ctx, p)
      if (parent === null) continue
      const under = parent.archived_at !== undefined
      if (under && words.length === 0) continue
      if (!admin(seat) && (await levelOf(ctx, seat, p)) === null) continue
      const can = await leads(ctx, seat, under ? parent : p)
      found.push({
        row: {
          ...base,
          parent: ref(parent),
          under,
          with_parent: under ? p.archived_at === parent.archived_at : null,
          has_sub_projects: null,
          can_restore: can,
          can_delete: under ? false : can,
        },
        at,
      })
    }
    return found.sort((a, b) => compareValues(b.at, a.at)).map((f) => f.row)
  })

/** What projectSettings.archivedSubProjects should answer `seat` for
 * archived top-level project `parent` over every batch, in name key order
 * with the id breaking ties, or null where the seat does not list the
 * project: the archived sub-projects beneath it the seat sees, each with
 * whether it was archived with it. */
export const expectedChips = (t: T, seat: Doc<'profiles'>, parent: Doc<'projects'>) =>
  t.run(async (ctx) => {
    const p = await byId(ctx, 'projects', parent.id)
    if (p === null || !(await archiveSees(ctx, seat, p))) return null
    return (await archivedBeneath(ctx, seat, p))
      .sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))
      .map((c) => ({
        id: c.id,
        name: c.name,
        num: c.num,
        with_parent: c.archived_at === p.archived_at,
      }))
  })
