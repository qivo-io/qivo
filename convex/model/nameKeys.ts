/* Name keys (schema.ts `name_key`, lib/nameKey.ts) are the normalized names
 * that name-ordered lists sort and search by. A profile, team or project
 * stores its own, written with its name. A membership and a user grant copy
 * the profile's, a team share the team's, so a team's members and a
 * project's grants read in name order from one range without reading every
 * profile or team.
 *
 * A rename brings the copies in line with copyNameKey, up to
 * NAME_COPIES.inline in its own transaction and the rest in bounded
 * background steps tracked by a name_copies row (nameCopies.ts). Every pass
 * reads the source's current name, so the last rename wins, and finds the
 * copies that differ from it through an index range by source and key
 * (staleCopies), so no cursor is kept and a repeated pass cannot skip one.
 * A copy can trail a rename for a moment, which may misorder its row or
 * miss a search by the new name, but every copy holds a key, so browsing a
 * list in name order leaves no row out.
 *
 * org_ready.name_keys_at says that every row of an organization holds its
 * key. A reader in name order checks nameKeysReady and refuses without it,
 * because a row without a key sorts first and a search by name misses it. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { NameSource } from '../lib/enums'
import { nameKey } from '../lib/nameKey'

/** The copies a rename brings in line in its own transaction, shared by
 * every source one transaction renames, and the most one background step
 * brings in line (nameCopies.ts). Convex reads a row by id before it
 * patches it, so each copy uses one of the 4,096 index ranges a transaction
 * may read, as a label deletion's rows do (model/labels.ts LABEL_REMOVAL,
 * which measured a step of 2,000 at about half the limit). A copy is a
 * small row, far from the byte limits. Tests lower both values. */
export const NAME_COPIES = { inline: 500, step: 2000 }

/** What a transaction may still bring in line. */
export type CopyBudget = { left: number }

/** A fresh budget for one rename's transaction. */
export const inlineBudget = (): CopyBudget => ({ left: NAME_COPIES.inline })

/** The tables that copy each source's key. */
type CopyTable = 'team_members' | 'project_access' | 'project_team_access'
const COPIES: Readonly<Record<NameSource, readonly CopyTable[]>> = {
  profiles: ['team_members', 'project_access'],
  teams: ['project_team_access'],
}

/** The two ranges of `table` that hold source `id`'s copies whose key is
 * not `key`, one below it, which includes those without a key, and one
 * above it. */
function staleRanges(ctx: QueryCtx, table: CopyTable, id: string, key: string) {
  switch (table) {
    case 'team_members':
      return [
        ctx.db
          .query('team_members')
          .withIndex('by_profile_name', (q) => q.eq('profile_id', id).lt('name_key', key)),
        ctx.db
          .query('team_members')
          .withIndex('by_profile_name', (q) => q.eq('profile_id', id).gt('name_key', key)),
      ]
    case 'project_access':
      return [
        ctx.db
          .query('project_access')
          .withIndex('by_profile_name', (q) => q.eq('profile_id', id).lt('name_key', key)),
        ctx.db
          .query('project_access')
          .withIndex('by_profile_name', (q) => q.eq('profile_id', id).gt('name_key', key)),
      ]
    case 'project_team_access':
      return [
        ctx.db
          .query('project_team_access')
          .withIndex('by_team_name', (q) => q.eq('team_id', id).lt('name_key', key)),
        ctx.db
          .query('project_team_access')
          .withIndex('by_team_name', (q) => q.eq('team_id', id).gt('name_key', key)),
      ]
  }
}

/** Up to `n` rows of `table` that copy source `id`'s name key and do not
 * hold `key`. A row leaves the ranges once it holds `key`. */
export async function staleCopies(
  ctx: QueryCtx,
  table: CopyTable,
  id: string,
  key: string,
  n: number,
): Promise<Doc<CopyTable>[]> {
  const rows: Doc<CopyTable>[] = []
  for (const range of staleRanges(ctx, table, id, key)) {
    if (rows.length >= n) break
    rows.push(...(await range.take(n - rows.length)))
  }
  return rows
}

/** A source row, which its copies follow. */
type Source = Pick<Doc<NameSource>, 'id' | 'name'>

/** Gives up to `budget.left` copies of `row`'s name key (a profile's when
 * `source` is 'profiles', a team's for 'teams') the key of its current name,
 * spending the budget, and answers whether copies that differ are left. */
export async function bringInLine(
  ctx: MutationCtx,
  source: NameSource,
  row: Source,
  budget: CopyBudget,
): Promise<boolean> {
  const key = nameKey(row.name)
  for (const table of COPIES[source]) {
    // one more than the budget tells whether any are left
    const stale = await staleCopies(ctx, table, row.id, key, budget.left + 1)
    const now = stale.slice(0, budget.left)
    for (const copy of now) await ctx.db.patch(copy._id, { name_key: key })
    budget.left -= now.length
    if (stale.length > now.length) return true
  }
  return false
}

const stepRef = makeFunctionReference<'mutation', { source: NameSource; source_id: string }, null>(
  'nameCopies:step',
)

/** The name_copies row of source `id`, or null. */
export const pendingNameCopies = (ctx: QueryCtx, source: NameSource, id: string) =>
  ctx.db
    .query('name_copies')
    .withIndex('by_source', (q) => q.eq('source', source).eq('source_id', id))
    .unique()

/** Brings the copies of `row`'s name key in line after a rename, within
 * `budget`, and leaves the rest to a name_copies row and its background
 * steps (nameCopies.ts). Call it in the transaction that writes the name. A
 * row whose step still waits or runs keeps it, because that step reads the
 * name this transaction writes. */
export async function copyNameKey(
  ctx: MutationCtx,
  source: NameSource,
  row: Source,
  budget: CopyBudget,
): Promise<void> {
  if (!(await bringInLine(ctx, source, row, budget))) return
  const job = await pendingNameCopies(ctx, source, row.id)
  const next = job?.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
  if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') return
  const progress_at = new Date().toISOString()
  const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { source, source_id: row.id })
  if (job !== null) await ctx.db.patch(job._id, { progress_at, scheduled_id })
  else await ctx.db.insert('name_copies', { source, source_id: row.id, progress_at, scheduled_id })
}

/** The org_ready row of the organization, or null. */
export const readyRow = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('org_ready')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** Whether every profile, team, project, membership, grant and team share
 * of the organization holds its name key (schema.ts org_ready). A list in
 * name order refuses while it is not, instead of leaving rows out. */
export async function nameKeysReady(ctx: QueryCtx, orgId: string): Promise<boolean> {
  return (await readyRow(ctx, orgId))?.name_keys_at !== undefined
}
