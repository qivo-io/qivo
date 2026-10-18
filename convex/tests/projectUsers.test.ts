/* listProjectUsersCore (lib/core.ts), the project user list behind REST
 * GET /v1/projects/{ref}/users and MCP list_project_users. It answers every
 * profile from the project's grants (lib/access.ts projectLevelsForProfiles)
 * and must list whom canAccessProject admits and mark `assignable` whom
 * profileCanBeAssigned admits, which is how it was computed before and how
 * the task writes still decide. The per-profile walk is kept here as the
 * reference. */
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canAccessProject, profileCanBeAssigned, projectLevelsForProfiles } from '../lib/access'
import { listProjectUsersCore, listUsersCore, userJson } from '../lib/core'
import { ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import { newTeam, SHAPES } from './accessShapes.setup'
import { expectRefusal, NOW, newT, plantProject, plantSeat, uuid, withOrg } from './helpers.setup'

/* The list as listProjectUsersCore built it before, one canAccessProject and
 * one profileCanBeAssigned walk per profile. */
async function perProfileUsers(ctx: QueryCtx, me: Doc<'profiles'>, project: Doc<'projects'>) {
  const out = []
  for (const profile of await listUsersCore(ctx, me)) {
    if (!(await canAccessProject(ctx, profile, project))) continue
    out.push({
      ...userJson(profile),
      assignable: await profileCanBeAssigned(ctx, profile, project),
    })
  }
  return out
}

describe('listProjectUsersCore', () => {
  it('equals canAccessProject and profileCanBeAssigned for every role, kind, seat and grant shape', async () => {
    const seen = new Set<string>()
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        // as the shape left them, leads and archive marks included
        const projects = await Promise.all(
          [f.meta, f.sub, f.sub2, f.hidden].map(
            async (p) => (await ctx.db.get(p._id)) as Doc<'projects'>,
          ),
        )
        for (const org_role of ORG_ROLES) {
          for (const kind of PROFILE_KINDS) {
            for (const active of [true, false]) {
              await ctx.db.patch(subject._id, { org_role, kind, active })
              for (const project of projects) {
                const users = await listProjectUsersCore(ctx, f.admin, project)
                expect(
                  users,
                  `${name}: ${active ? 'active' : 'inactive'} ${org_role} ${kind} on ${project.key}`,
                ).toEqual(await perProfileUsers(ctx, f.admin, project))
                const row = users.find((u) => u.id === subject.id)
                seen.add(row === undefined ? 'unlisted' : row.assignable ? 'assignable' : 'listed')
              }
            }
          }
        }
        // a profile of another organization holds nothing on these projects
        for (const project of projects) {
          expect((await projectLevelsForProfiles(ctx, project))(f.otherAdmin)).toBeNull()
          expect(await canAccessProject(ctx, f.otherAdmin, project)).toBe(false)
        }
      })
    }
    // the shapes reach unlisted, listed and assignable alike
    expect([...seen].sort()).toEqual(['assignable', 'listed', 'unlisted'])
  }, 60_000)

  it('gives nobody a level on a project outside a top-level meta, as the per-profile checks do', async () => {
    const t = newT()
    const f = await withOrg(t)
    const loose = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const nested = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.sub.id })
    // a sub-project whose parent meta belongs to another organization
    const foreignParent = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    await t.run(async (ctx) => {
      for (const project of [loose, nested, foreignParent]) {
        const levelOf = await projectLevelsForProfiles(ctx, project)
        for (const me of [f.admin, f.user, f.viewer, f.guest, f.agent, f.otherAdmin]) {
          expect(levelOf(me), `${me.name} on ${project.key}`).toBeNull()
          expect(await canAccessProject(ctx, me, project)).toBe(false)
        }
        expect(await listProjectUsersCore(ctx, f.admin, project)).toEqual([])
      }
    })
    // A missing parent or a cycle refuses, as rootMetaOf does for each profile.
    const dangling = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: uuid() })
    const [one, two] = [uuid(), uuid()]
    const cycle = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      id: one,
      parent_id: two,
    })
    await plantProject(t, { org_id: f.org.id, type: 'meta', id: two, parent_id: one })
    for (const project of [dangling, cycle]) {
      await expectRefusal(
        t.run((ctx) => listProjectUsersCore(ctx, f.admin, project)),
        'not_found',
        /project not found/,
      )
    }
  })

  it("stays within Convex's 4,096 index ranges for 1,100 people in two teams sharing the parent, where the per-profile checks did not", async () => {
    const CROWD = 1100
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // Hardware and a second team each hold User on TBED, and the crowd is
    // split between them, so each person reaches FW only through a team.
    // convex-test counts every query, about 19 per person here. A deployment
    // counts a range the function already read once, which leaves each
    // person's two grants and two team memberships, about 4,400 ranges for
    // this crowd.
    await t.run(async (ctx) => {
      const second = await newTeam(ctx, f.org.id)
      for (const team_id of [f.team.id, second]) {
        await ctx.db.insert('project_team_access', {
          project_id: f.meta.id,
          team_id,
          level: 'user',
        })
      }
      for (let i = 0; i < CROWD; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `Person ${i}`,
          initials: 'PE',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: i % 2 ? second : f.team.id,
          profile_id: id,
          is_leader: false,
        })
      }
    })
    await expect(t.run((ctx) => perProfileUsers(ctx, f.admin, f.sub))).rejects.toThrow(
      /Too many index ranges read/,
    )
    const ranges = await t.run(async (ctx) => {
      const users = await listProjectUsersCore(ctx, f.admin, f.sub)
      // the crowd, admin, user (TBED's lead), guest, and viewer, who only reads
      expect(users).toHaveLength(CROWD + 4)
      expect(users.filter((u) => !u.assignable).map((u) => u.id)).toEqual([f.viewer.id])
      return (await ctx.meta.getTransactionMetrics()).databaseQueries.used
    })
    // the roster, FW's root, the grants and shares on FW and TBED, and both
    // teams with their members
    expect(ranges).toBeLessThanOrEqual(10)
    const as_ = { callerId: f.admin.id, access: 'read' as const }
    const rest = await t.query(internal.machine.rest.listProjectUsers, { ...as_, ref: 'FW' })
    expect(rest).toHaveLength(CROWD + 4)
    const mcp: unknown[] = JSON.parse(
      await t.query(internal.machine.mcp.listProjectUsers, { ...as_, project: 'FW' }),
    )
    expect(mcp).toHaveLength(CROWD + 4)
  })
})
