/* The rule of project navigation (model/projectNavReads.ts) and of the
 * favorites reader (model/projectFavorites.ts) worked out from the
 * projects, the favorites rows and lib/access.ts projectLevel alone,
 * without reach rows or the code under test, for the suites that check
 * them (projectNav.test.ts, projectFavorites.test.ts and
 * src/store/projectNavParity.test.ts). Two dots in the basename keep the
 * Convex CLI from deploying this module, as helpers.setup.ts.
 *
 * A top-level project shows a seat for navigation when it is a live meta
 * of the seat's organization the seat holds a level on for a reason of its
 * own (projectLevel without navigation, of ordinaryOf(seat)), or under
 * which a live sub-project gives the seat a level. A sub-project shows when
 * it and its parent are live and the seat holds a level on it. */

import { compareValues } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ordinaryOf, projectLevel } from '../lib/access'
import { byId } from '../lib/db'
import { nameKey } from '../lib/nameKey'
import type { T } from './helpers.setup'

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

/* The live sub-projects of top-level project `p`. */
const liveChildren = async (ctx: QueryCtx, p: Doc<'projects'>) =>
  (
    await ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', p.id))
      .collect()
  ).filter((child) => child.archived_at === undefined && child.org_id === p.org_id)

/** Whether `seat` sees project `p` for navigation by the rule above. */
export async function navSees(
  ctx: QueryCtx,
  seat: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<boolean> {
  if (p.org_id !== seat.org_id || p.archived_at !== undefined) return false
  if (p.parent_id !== undefined) {
    const parent = await byId(ctx, 'projects', p.parent_id)
    if (parent === null || parent.archived_at !== undefined || parent.type !== 'meta') return false
    if (parent.parent_id !== undefined || parent.org_id !== p.org_id) return false
    return (await levelOf(ctx, seat, p)) !== null
  }
  if (p.type !== 'meta') return false
  if ((await levelOf(ctx, seat, p, false)) !== null) return true
  for (const child of await liveChildren(ctx, p))
    if ((await levelOf(ctx, seat, child)) !== null) return true
  return false
}

/** Whether a reader shows favorites row `row`: its seat, organization and
 * live top-level meta agree, the row holds the project's copies, and the
 * seat sees the project for navigation by the rule above. */
export async function favoriteSeen(ctx: QueryCtx, row: Doc<'project_favorites'>) {
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
    (await navSees(ctx, seat, p))
  )
}

/** favoriteSeen in its own transaction. */
export const shows = (t: T, row: Doc<'project_favorites'>) => t.run((ctx) => favoriteSeen(ctx, row))

/** A page row as the oracle names it. */
export type ExpectedRow = {
  id: string
  org_id: string
  name: string
  num: number
  favorite: boolean
}

/* Positions in the page's order: the group, the name key's bytes, the id
 * and the organization. */
const order = (a: ExpectedRow, b: ExpectedRow) =>
  compareValues(
    [a.favorite ? 0 : 1, nameKey(a.name), a.id, a.org_id],
    [b.favorite ? 0 : 1, nameKey(b.name), b.id, b.org_id],
  )

/** What projectNav.page should answer over every batch for the login whose
 * seats are `seats`, in order: each seat's live top-level metas it sees for
 * navigation, a project marked favorite when one of the seat's rows on it
 * shows (favoriteSeen), every favorite first and then the rest. */
export const expectedPage = (t: T, seats: readonly Doc<'profiles'>[]) =>
  t.run(async (ctx) => {
    const out: ExpectedRow[] = []
    for (const seat of seats) {
      const tops = await ctx.db
        .query('projects')
        .withIndex('by_org_parent', (q) => q.eq('org_id', seat.org_id).eq('parent_id', undefined))
        .collect()
      for (const p of tops) {
        if (!(await navSees(ctx, seat, p))) continue
        const rows = await ctx.db
          .query('project_favorites')
          .withIndex('by_project_profile', (q) =>
            q.eq('project_id', p.id).eq('profile_id', seat.id),
          )
          .collect()
        let favorite = false
        for (const row of rows) if (await favoriteSeen(ctx, row)) favorite = true
        out.push({ id: p.id, org_id: p.org_id, name: p.name, num: p.num, favorite })
      }
    }
    return out.sort(order)
  })

/** What projectNav.children should answer over every batch for `seat` and
 * top-level project `parent`, in name key order with the id breaking ties:
 * its live sub-projects the seat sees, when the seat sees the parent. */
export const expectedChildren = (t: T, seat: Doc<'profiles'>, parent: Doc<'projects'>) =>
  t.run(async (ctx) => {
    const p = await byId(ctx, 'projects', parent.id)
    if (p === null || !(await navSees(ctx, seat, p))) return null
    const out: Doc<'projects'>[] = []
    for (const child of await liveChildren(ctx, p))
      if (await navSees(ctx, seat, child)) out.push(child)
    return out
      .sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))
      .map((c) => ({ id: c.id, org_id: c.org_id, name: c.name, num: c.num, parent_id: p.id }))
  })
