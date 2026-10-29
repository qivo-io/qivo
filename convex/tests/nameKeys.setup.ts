/* Name key checks shared by the suites that write keyed rows
 * (nameKeys.test.ts, marketingDemo.test.ts). Two dots in the basename keep
 * the Convex CLI from deploying this module, as helpers.setup.ts. */

import { expect } from 'vitest'
import type { Doc, Id } from '../_generated/dataModel'
import { nameKey } from '../lib/nameKey'
import type { CopyTable } from '../model/nameKeys'
import type { T } from './helpers.setup'

/** The keys of every row of the organization that has one, with the key
 * its name, or its profile's or team's name, gives it, by table. */
export const keysOf = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const of = <R extends { name_key?: string }>(rows: R[], name: (row: R) => string | undefined) =>
      rows.map((row) => {
        const source = name(row)
        return { stored: row.name_key, wanted: source === undefined ? null : nameKey(source) }
      })
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const teams = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const person = new Map(profiles.map((p) => [p.id, p.name]))
    const team = new Map(teams.map((p) => [p.id, p.name]))
    const members: Doc<'team_members'>[] = []
    for (const one of teams)
      members.push(
        ...(await ctx.db
          .query('team_members')
          .withIndex('by_team', (q) => q.eq('team_id', one.id))
          .collect()),
      )
    const grants: Doc<'project_access'>[] = []
    const shares: Doc<'project_team_access'>[] = []
    for (const p of projects) {
      grants.push(
        ...(await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', p.id))
          .collect()),
      )
      shares.push(
        ...(await ctx.db
          .query('project_team_access')
          .withIndex('by_project', (q) => q.eq('project_id', p.id))
          .collect()),
      )
    }
    return {
      profiles: of(profiles, (p) => p.name),
      teams: of(teams, (p) => p.name),
      projects: of(projects, (p) => p.name),
      team_members: of(members, (m) => person.get(m.profile_id)),
      project_access: of(grants, (g) => person.get(g.profile_id)),
      project_team_access: of(shares, (s) => team.get(s.team_id)),
    }
  })

/** Fails unless every row of the organization holds the key it should. */
export async function expectExact(t: T, orgId: string): Promise<void> {
  for (const [table, rows] of Object.entries(await keysOf(t, orgId)))
    for (const row of rows) expect(row.stored, table).toBe(row.wanted)
}

/** Gives every profile, team and project of the organization the key its
 * name gives it, every membership, grant and team share the key of its
 * profile's or team's name, and stamps the organization ready
 * (org_ready.name_keys_at), as internal/nameKeysBackfill leaves it. withOrg
 * and plantNorthstar write no keys, and the shapes of accessShapes.setup.ts
 * no copies. A copy whose profile or team is not in the organization keeps
 * what it holds. An org_ready row another suite wrote is patched. */
export const keyOrg = (t: T, orgId: string): Promise<void> =>
  t.run(async (ctx) => {
    const keyed = <R extends { name: string }>(row: R) => ({ name_key: nameKey(row.name) })
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const teams = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const row of [...profiles, ...teams, ...projects]) await ctx.db.patch(row._id, keyed(row))
    const person = new Map(profiles.map((p) => [p.id, nameKey(p.name)]))
    const team = new Map(teams.map((p) => [p.id, nameKey(p.name)]))
    const copy = async <R extends { _id: Id<CopyTable> }>(
      rows: R[],
      key: (row: R) => string | undefined,
    ) => {
      for (const row of rows) {
        const name_key = key(row)
        if (name_key !== undefined) await ctx.db.patch(row._id, { name_key })
      }
    }
    for (const one of teams) {
      const members = await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', one.id))
        .collect()
      await copy(members, (m) => person.get(m.profile_id))
    }
    for (const p of projects) {
      const grants = await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', p.id))
        .collect()
      await copy(grants, (g) => person.get(g.profile_id))
      const shares = await ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', p.id))
        .collect()
      await copy(shares, (s) => team.get(s.team_id))
    }
    const ready = await ctx.db
      .query('org_ready')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique()
    const name_keys_at = new Date().toISOString()
    if (ready === null) await ctx.db.insert('org_ready', { org_id: orgId, name_keys_at })
    else await ctx.db.patch(ready._id, { name_keys_at })
  })
