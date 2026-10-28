/* A removal of many people with open tasks, which the access removal
 * suites share (tests/bulkReassign.test.ts, tests/accessRemovalPreview.test.ts).
 *
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import { byId } from '../lib/db'
import { NOW, newT, uuid, withOrg } from './helpers.setup'

/** withOrg with `n` more members of Hardware, which shares TBED at User,
 * each assigned to one open task in Firmware, beside a second team,
 * Platform. Under `limits` the deployment's limits apply. `admin` is the
 * organization admin as REST and MCP calls name a caller, and `state` reads
 * Hardware's share on TBED, the Viewer grants on TBED and Hardware itself. */
export async function manyHolders(n: number, limits: Parameters<typeof newT>[0] = {}) {
  const t = newT({ transactionLimits: true, ...limits })
  const f = await withOrg(t)
  for (let from = 0; from < n; from += 100) {
    await t.run(async (ctx) => {
      if (from === 0) {
        await ctx.db.insert('teams', {
          id: uuid(),
          org_id: f.org.id,
          name: 'Platform',
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('project_team_access', {
          project_id: f.meta.id,
          team_id: f.team.id,
          level: 'user',
        })
      }
      for (let i = from; i < Math.min(n, from + 100); i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `m${i}`,
          initials: 'MM',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          accepted_at: NOW,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: id,
          is_leader: false,
        })
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          num: 2000 + i,
          title: `Task ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          assignee_id: id,
          created_at: NOW,
          updated_at: NOW,
        })
      }
    })
  }
  const admin = { callerId: f.admin.id, access: 'write' as const }
  const state = () =>
    t.run(async (ctx) => ({
      share: await ctx.db
        .query('project_team_access')
        .withIndex('by_project_team', (q) => q.eq('project_id', f.meta.id).eq('team_id', f.team.id))
        .unique(),
      viewers: (
        await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
          .collect()
      ).filter((g) => g.level === 'viewer').length,
      team: await byId(ctx, 'teams', f.team.id),
    }))
  return { t, f, admin, state }
}
