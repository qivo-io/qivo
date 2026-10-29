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
 * because a row without a key sorts first and a search by name misses it.
 *
 * The indexes of keyed rows that name-ordered readers walk are defined here
 * once (lib/namedPages.ts NamedIndex): an organization's people, all of them
 * or one role, its teams, and a project's user grants and team shares, each
 * ordered by its name key and then one id. */

import { makeFunctionReference } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { NameSource, OrgRole } from '../lib/enums'
import { MIB } from '../lib/limits'
import type { NamedAt, NamedIndex } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'

/** What a rename may spend on copies in its own transaction, shared by
 * every source the transaction renames, and what one background step may
 * spend (nameCopies.ts): the copies it gives their key and the bytes it
 * reads. Convex reads a row by id before it patches it, so each copy uses
 * one of the 4,096 index ranges a transaction may read, as a label
 * deletion's rows do (model/labels.ts LABEL_REMOVAL, which measured a step
 * of 2,000 at about half the limit), and each copy is read twice, in its
 * range and by its patch. A copy is under 3 KiB even with the longest key a
 * name of NAME_MAX units gives (2,640 bytes), so the bytes only bind for
 * such names. A pass reads `chunk` copies at a time and starts a chunk only
 * while bytes are left, so it reads at most one chunk past its bytes. Tests
 * lower them. */
export const NAME_COPIES = {
  inline: { rows: 500, bytes: 2 * MIB },
  step: { rows: 2000, bytes: 8 * MIB },
  chunk: 100,
}

/** What a transaction may still spend on copies (NAME_COPIES). */
export type CopyBudget = { rows: number; bytes: number }

/** A fresh budget for one rename's transaction. */
export const inlineBudget = (): CopyBudget => ({ ...NAME_COPIES.inline })

/** The tables that copy each source's key. */
export type CopyTable = 'team_members' | 'project_access' | 'project_team_access'
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

/** A source row, which its copies follow. Its _creationTime tells it from
 * a later row that takes the same id. */
type Source = Pick<Doc<NameSource>, '_creationTime' | 'id' | 'name'>

/**
 * Gives the copies of `row`'s name key (a profile's when `source` is
 * 'profiles', a team's for 'teams') that do not hold the key of its current
 * name that key, within `budget`, and answers whether any are left. Each
 * copy given its key spends one of `budget.rows`, and every read of a copy
 * spends `budget.bytes`. Copies are read NAME_COPIES.chunk at a time, and a
 * chunk starts only while bytes are left. Without `write` it gives no key and only
 * reads, one chunk a table, as it would find the same copies again; `found`
 * sees each copy it would give a key, and it answers whether more are left
 * past them.
 */
export async function bringInLine(
  ctx: QueryCtx,
  source: NameSource,
  row: Pick<Source, 'id' | 'name'>,
  budget: CopyBudget,
  write: MutationCtx | null,
  found?: (table: CopyTable, copy: Doc<CopyTable>) => void,
): Promise<boolean> {
  const key = nameKey(row.name)
  for (const table of COPIES[source]) {
    for (;;) {
      const n = budget.bytes > 0 ? Math.min(budget.rows, NAME_COPIES.chunk) : 0
      // one more than the chunk tells whether any are left
      const stale = await staleCopies(ctx, table, row.id, key, n + 1)
      for (const copy of stale) budget.bytes -= getDocumentSize(copy)
      const now = stale.slice(0, n)
      for (const copy of now) {
        found?.(table, copy)
        if (write === null) continue
        await write.db.patch(copy._id, { name_key: key })
        budget.bytes -= getDocumentSize(copy)
      }
      budget.rows -= now.length
      if (stale.length <= n) break
      if (write === null || budget.rows <= 0 || budget.bytes <= 0) return true
    }
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
 * steps (nameCopies.ts). Call it in the transaction that writes the name,
 * with the row as stored and its new name. A row left by an earlier profile
 * or team with the same id is taken over for this one. A row whose step
 * still waits or runs keeps it, because that step reads the name this
 * transaction writes. */
export async function copyNameKey(
  ctx: MutationCtx,
  source: NameSource,
  row: Source,
  budget: CopyBudget,
): Promise<void> {
  if (!(await bringInLine(ctx, source, row, budget, ctx))) return
  const job = await pendingNameCopies(ctx, source, row.id)
  const source_created = row._creationTime
  if (job !== null && job.source_created !== source_created)
    await ctx.db.patch(job._id, { source_created })
  const next = job?.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
  if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') return
  const progress_at = new Date().toISOString()
  const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { source, source_id: row.id })
  if (job !== null) await ctx.db.patch(job._id, { progress_at, scheduled_id })
  else
    await ctx.db.insert('name_copies', {
      source,
      source_id: row.id,
      source_created,
      progress_at,
      scheduled_id,
    })
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

/* ----------------------------------------------------- the name indexes */

/** The tie of an index that orders equal name keys by one id. */
export type IdTie = readonly [string]

/* The position of a row of a name index tied by `id`. Readers refuse until
 * the organization is keyed (nameKeysReady), so a row without a key here
 * passed that check and is refused rather than placed first. */
function keyedAt(key: string | undefined, id: string, what: string): NamedAt<IdTie> {
  if (key === undefined) throw new Error(`an unkeyed ${what} passed the readiness check`)
  return { key, tie: [id] }
}

/** The people and agents of organization `orgId` in name order
 * (profiles.by_org_name): name key, then id. */
export function profileIndex(ctx: QueryCtx, orgId: string): NamedIndex<Doc<'profiles'>, IdTie> {
  const profiles = () => ctx.db.query('profiles')
  return {
    all: () => profiles().withIndex('by_org_name', (q) => q.eq('org_id', orgId)),
    after: ({ key, tie: [id] }) => [
      () =>
        profiles().withIndex('by_org_name', (q) =>
          q.eq('org_id', orgId).eq('name_key', key).gt('id', id),
        ),
      () => profiles().withIndex('by_org_name', (q) => q.eq('org_id', orgId).gt('name_key', key)),
    ],
    at: (profile) => keyedAt(profile.name_key, profile.id, 'profile'),
  }
}

/** The people and agents of organization `orgId` with role `role` in name
 * order (profiles.by_org_role_name): name key, then id. Several roles merge
 * into one list with lib/namedPages.ts mergeNamed. */
export function profileRoleIndex(
  ctx: QueryCtx,
  orgId: string,
  role: OrgRole,
): NamedIndex<Doc<'profiles'>, IdTie> {
  const profiles = () => ctx.db.query('profiles')
  return {
    all: () =>
      profiles().withIndex('by_org_role_name', (q) => q.eq('org_id', orgId).eq('org_role', role)),
    after: ({ key, tie: [id] }) => [
      () =>
        profiles().withIndex('by_org_role_name', (q) =>
          q.eq('org_id', orgId).eq('org_role', role).eq('name_key', key).gt('id', id),
        ),
      () =>
        profiles().withIndex('by_org_role_name', (q) =>
          q.eq('org_id', orgId).eq('org_role', role).gt('name_key', key),
        ),
    ],
    at: (profile) => keyedAt(profile.name_key, profile.id, 'profile'),
  }
}

/** The teams of organization `orgId` in name order (teams.by_org_name):
 * name key, then id. */
export function teamIndex(ctx: QueryCtx, orgId: string): NamedIndex<Doc<'teams'>, IdTie> {
  const teams = () => ctx.db.query('teams')
  return {
    all: () => teams().withIndex('by_org_name', (q) => q.eq('org_id', orgId)),
    after: ({ key, tie: [id] }) => [
      () =>
        teams().withIndex('by_org_name', (q) =>
          q.eq('org_id', orgId).eq('name_key', key).gt('id', id),
        ),
      () => teams().withIndex('by_org_name', (q) => q.eq('org_id', orgId).gt('name_key', key)),
    ],
    at: (team) => keyedAt(team.name_key, team.id, 'team'),
  }
}

/** The user grants on project `projectId` in the order of their copies of
 * the person's name key (project_access.by_project_name): copied key, then
 * profile id. A copy can trail a rename for a moment, which places its row
 * by the earlier name. */
export function projectGrantIndex(
  ctx: QueryCtx,
  projectId: string,
): NamedIndex<Doc<'project_access'>, IdTie> {
  const grants = () => ctx.db.query('project_access')
  return {
    all: () => grants().withIndex('by_project_name', (q) => q.eq('project_id', projectId)),
    after: ({ key, tie: [id] }) => [
      () =>
        grants().withIndex('by_project_name', (q) =>
          q.eq('project_id', projectId).eq('name_key', key).gt('profile_id', id),
        ),
      () =>
        grants().withIndex('by_project_name', (q) =>
          q.eq('project_id', projectId).gt('name_key', key),
        ),
    ],
    at: (grant) => keyedAt(grant.name_key, grant.profile_id, 'grant'),
  }
}

/** The team shares on project `projectId` in the order of their copies of
 * the team's name key (project_team_access.by_project_name): copied key,
 * then team id, with the same lag as projectGrantIndex. */
export function projectShareIndex(
  ctx: QueryCtx,
  projectId: string,
): NamedIndex<Doc<'project_team_access'>, IdTie> {
  const shares = () => ctx.db.query('project_team_access')
  return {
    all: () => shares().withIndex('by_project_name', (q) => q.eq('project_id', projectId)),
    after: ({ key, tie: [id] }) => [
      () =>
        shares().withIndex('by_project_name', (q) =>
          q.eq('project_id', projectId).eq('name_key', key).gt('team_id', id),
        ),
      () =>
        shares().withIndex('by_project_name', (q) =>
          q.eq('project_id', projectId).gt('name_key', key),
        ),
    ],
    at: (share) => keyedAt(share.name_key, share.team_id, 'team share'),
  }
}
