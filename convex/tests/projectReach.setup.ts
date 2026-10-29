/* Reach row checks shared by the suites that write project_reach rows
 * (projectReach.test.ts, marketingDemo.test.ts and others), and withReach,
 * which writes them as a deployment's backfill does for the suites that
 * read them (archived.test.ts, mainSearch.test.ts). Two dots in the
 * basename keep the Convex CLI from deploying this module, as
 * helpers.setup.ts.
 *
 * The expected rows are worked out here from the sources themselves, the
 * live projects with their leads, grants and team shares, without
 * model/projectNav.ts, so a mistake there cannot hide in its own check. A
 * second check holds the rows against lib/access.ts projectLevel for every
 * person who is not an organization admin. */

import type { FunctionArgs } from 'convex/server'
import { expect } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { projectLevel } from '../lib/access'
import { nameKey } from '../lib/nameKey'
import { NOW, type T } from './helpers.setup'

/** Writes every organization's archive states and project_reach rows, as
 * internal/navBackfill does on a deployment, stamps nav_at, and stamps its
 * name keys, so the reads that wait for navigation data take them
 * (model/projectNav.ts navReady, reachReady). A project, grant or share
 * planted after it gets no archive state or row, so call it after the last
 * one a case plants. */
export async function withReach(t: T): Promise<void> {
  let cursor: FunctionArgs<typeof internal.internal.navBackfill.run>['cursor']
  do {
    const done = await t.action(internal.internal.navBackfill.run, {
      dry_run: false,
      ...(cursor ? { cursor } : {}),
    })
    cursor = done.cursor ?? undefined
  } while (cursor !== undefined)
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query('org_ready').collect())
      await ctx.db.patch(row._id, { name_keys_at: NOW })
  })
}

/** A reach row as the checks compare it. */
export type ReachFields = Omit<Doc<'project_reach'>, '_id' | '_creationTime'>

/** One row's identity, for sorting and messages. */
const keyOf = (row: ReachFields) =>
  `${row.grantee_kind}:${row.grantee_id}:${row.kind}:${row.project_id}`

const sorted = (rows: ReachFields[]) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

/** Every reach row, without its system fields, sorted. */
export const reachRows = (t: T) =>
  t.run(async (ctx) =>
    sorted(
      (await ctx.db.query('project_reach').collect()).map(({ _id, _creationTime, ...row }) => row),
    ),
  )

/** The rows every live project's sources call for, worked out from the
 * sources alone: in a top-level meta's tree in its grantee's organization,
 * a child row for each source on a sub-project (a grant, a share or its
 * own lead_id) and a root row for each grantee with a source on the
 * top-level project (on_root) or a child row under it. */
export const expectedReach = (t: T) =>
  t.run(async (ctx) => {
    const projects = await ctx.db.query('projects').collect()
    const byId = new Map(projects.map((p) => [p.id, p]))
    const profiles = new Map((await ctx.db.query('profiles').collect()).map((p) => [p.id, p]))
    const teams = new Map((await ctx.db.query('teams').collect()).map((p) => [p.id, p]))
    const grants = await ctx.db.query('project_access').collect()
    const shares = await ctx.db.query('project_team_access').collect()
    type Source = { kind: 'profile' | 'team'; id: string; project: Doc<'projects'> }
    const sources: Source[] = []
    for (const p of projects)
      if (p.lead_id !== undefined) sources.push({ kind: 'profile', id: p.lead_id, project: p })
    for (const g of grants) {
      const project = byId.get(g.project_id)
      if (project !== undefined) sources.push({ kind: 'profile', id: g.profile_id, project })
    }
    for (const s of shares) {
      const project = byId.get(s.project_id)
      if (project !== undefined) sources.push({ kind: 'team', id: s.team_id, project })
    }
    const rows = new Map<string, ReachFields>()
    const row = (s: Source, kind: 'root' | 'child', p: Doc<'projects'>, root: Doc<'projects'>) => ({
      org_id: p.org_id,
      grantee_kind: s.kind,
      grantee_id: s.id,
      kind,
      project_id: p.id,
      root_id: root.id,
      name_key: nameKey(p.name),
      key: p.key,
      live: p.archived_at === undefined,
      on_root: false,
    })
    for (const s of sources) {
      const p = s.project
      const root = p.parent_id === undefined ? p : byId.get(p.parent_id)
      if (root === undefined || root.type !== 'meta' || root.parent_id !== undefined) continue
      if (root.org_id !== p.org_id) continue
      if (p.id !== root.id && p.parent_id !== root.id) continue
      const grantee = s.kind === 'profile' ? profiles.get(s.id) : teams.get(s.id)
      if (grantee === undefined || grantee.org_id !== p.org_id) continue
      const rootKey = keyOf(row(s, 'root', root, root))
      const rootRow = rows.get(rootKey) ?? row(s, 'root', root, root)
      if (p.id === root.id) rootRow.on_root = true
      else rows.set(keyOf(row(s, 'child', p, root)), row(s, 'child', p, root))
      rows.set(rootKey, rootRow)
    }
    return sorted([...rows.values()])
  })

/** Fails unless the reach rows are exactly the ones the sources call for. */
export async function expectReachExact(t: T): Promise<void> {
  expect(await reachRows(t)).toEqual(await expectedReach(t))
}

/** Fails unless, for every person of the organization who is not an
 * organization admin, the rows of their seat and of their teams reach
 * exactly the projects projectLevel lets them see: a top-level project
 * through a root row, a sub-project through a root row with on_root or a
 * child row of its own. A guest receives no team share, as lib/access.ts
 * rules. Admins see every project through projectLevel, so their rows are
 * held to their sources by expectReachExact instead. */
export async function expectReachMatchesAccess(t: T, orgId: string): Promise<void> {
  const mismatches = await t.run(async (ctx) => {
    const out: string[] = []
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const people = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const reach = await ctx.db
      .query('project_reach')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const me of people) {
      if (me.org_role === 'admin') continue
      const teams = new Set(
        me.org_role === 'guest'
          ? []
          : (
              await ctx.db
                .query('team_members')
                .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
                .collect()
            ).map((m) => m.team_id),
      )
      const mine = reach.filter((r) =>
        r.grantee_kind === 'profile' ? r.grantee_id === me.id : teams.has(r.grantee_id),
      )
      for (const p of projects) {
        let level: string | null
        try {
          level = await projectLevel(ctx, me, p)
        } catch {
          level = null
        }
        const reached =
          p.parent_id === undefined
            ? mine.some((r) => r.kind === 'root' && r.project_id === p.id)
            : mine.some(
                (r) =>
                  (r.kind === 'root' && r.project_id === p.parent_id && r.on_root) ||
                  (r.kind === 'child' && r.project_id === p.id),
              )
        if ((level !== null) !== reached)
          out.push(`${me.name} on ${p.name}: level ${level}, reached ${reached}`)
      }
    }
    return out
  })
  expect(mismatches).toEqual([])
}
