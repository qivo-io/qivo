/* The projects a caller sees, kept as the tests' reference data now that no
 * workspace part sends them: the reader the workspace's projects part ran
 * before t3/limits-projects-part removed it, without its windows, splits or
 * budgets. For every seat of the caller's login, in seat order, the
 * organization's projects the seat sees by lib/access.ts accessOf visible
 * (navigation included, so an archived project and a top-level project
 * seen only through a sub-project are there), oldest first, with every
 * grant and team grant on each. It is unbounded, as orgLoad.setup.ts keeps
 * the load fence, so it is complete for any fixture a test builds, and no
 * production code reads every project of an organization with its grants.
 *
 * helpers.setup.ts workspaceOf and wholeOf join it into the workspace the
 * store tests publish (src/store/guard/liveDouble.setup.ts Whole), whose
 * stand-ins of the navigation reads, the views and the Settings pages read
 * projects from it as the server does.
 *
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessOf, OWN_READS, type OwnReads } from '../lib/access'

/** A project as the app's stand-ins hold it: without Convex's system fields
 * and the fields that only serve index reads. */
export type OracleProject = Omit<
  Doc<'projects'>,
  '_id' | '_creationTime' | 'window_key' | 'name_key' | 'archive_state'
>
/** A grant as the stand-ins hold it, without its name key. */
export type OracleGrant = Omit<Doc<'project_access'>, '_id' | '_creationTime' | 'name_key'>
/** A team grant as the stand-ins hold it, without its name key. */
export type OracleTeamGrant = Omit<Doc<'project_team_access'>, '_id' | '_creationTime' | 'name_key'>

/** The caller's projects with their grants and team grants. */
export type OracleProjects = {
  projects: OracleProject[]
  access: OracleGrant[]
  teamAccess: OracleTeamGrant[]
}

/* Bounds so wide no fixture meets them, so the oracle answers whole where
 * a production read would stop and refuse. */
const UNBOUNDED: OwnReads = {
  ...OWN_READS,
  steps: OWN_READS.steps.map((n) => n * 1000),
  ...Object.fromEntries(
    Object.entries(OWN_READS)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([key, n]) => [key, n * 1000]),
  ),
}

/**
 * The projects the seats `seats` see, in that order, each organization's
 * oldest first by creation, with every grant and team grant on each shown
 * project, other people's included. A seat whose organization holds no
 * project adds nothing.
 */
export async function projectsOracle(
  ctx: QueryCtx,
  seats: readonly Doc<'profiles'>[],
): Promise<OracleProjects> {
  const out: OracleProjects = { projects: [], access: [], teamAccess: [] }
  for (const me of seats) {
    const rows = (
      await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
        .collect()
    ).sort((a, b) => a._creationTime - b._creationTime)
    const caller = accessOf(ctx, me, rows, UNBOUNDED)
    for (const p of rows) {
      if (!(await caller.visible(p.id))) continue
      const {
        _id,
        _creationTime,
        window_key: _window,
        name_key: _key,
        archive_state: _state,
        ...row
      } = p
      out.projects.push(row)
      for (const g of await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', p.id))
        .collect()) {
        const { _id: _gid, _creationTime: _gt, name_key: _gk, ...grant } = g
        out.access.push(grant)
      }
      for (const g of await ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', p.id))
        .collect()) {
        const { _id: _gid, _creationTime: _gt, name_key: _gk, ...grant } = g
        out.teamAccess.push(grant)
      }
    }
  }
  return out
}
