/* listProjectUsersCore (lib/core.ts), the project user list behind REST
 * GET /v1/projects/{ref}/users and MCP list_project_users. It answers every
 * profile from the project's grants (lib/access.ts projectLevelsForProfiles)
 * and must list whom canAccessProject admits and mark `assignable` whom
 * profileCanBeAssigned admits, which is how it was computed before and how
 * the task writes still decide. The per-profile walk is kept here as the
 * reference.
 *
 * The removal window's Reassign picker reads the same levels with a
 * removal's rows left out (projectLevelsForProfiles `without`), which must
 * equal projectLevelsForPeople's with the same rows left out, the reads the
 * removal's own findLost makes, and checks its room before each read
 * (`guard`).
 *
 * The task owner pickers and Team sync's mention recipients
 * (model/pickers.ts) ask canBeAssignedFor and canSeeProjectFor, the same
 * levels as many-profile answers of profileCanBeAssigned and canSeeProject,
 * the second with the navigation a top-level project gives whoever reaches
 * one of its sub-projects, live or archived. */
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  canAccessProject,
  canBeAssignedFor,
  canSeeProject,
  canSeeProjectFor,
  orgProjects,
  profileCanBeAssigned,
  projectLevelReads,
  projectLevelsForPeople,
  projectLevelsForProfiles,
  type RemovedAccess,
} from '../lib/access'
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

describe('projectLevelsForProfiles with a removal left out', () => {
  it("equals projectLevelsForPeople's level, navigation aside, for every access shape, role and removed row", async () => {
    // whether some removal changed the subject's level, so the comparison
    // is not only of levels nothing removes
    const seen = new Set<string>()
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        const projects = await orgProjects(ctx, f.org.id)
        const asked = projects.filter((p) =>
          [f.meta.id, f.sub.id, f.sub2.id, f.hidden.id].includes(p.id),
        )
        // every row a removal could take from the subject: each grant, each
        // share on the organization's projects, each membership, each team
        // those name, and nothing
        const grants = await ctx.db
          .query('project_access')
          .withIndex('by_profile', (q) => q.eq('profile_id', subject.id))
          .collect()
        const shares = (
          await Promise.all(
            projects.map((p) =>
              ctx.db
                .query('project_team_access')
                .withIndex('by_project', (q) => q.eq('project_id', p.id))
                .collect(),
            ),
          )
        ).flat()
        const memberships = await ctx.db
          .query('team_members')
          .withIndex('by_profile', (q) => q.eq('profile_id', subject.id))
          .collect()
        const teams = [
          ...new Set([...memberships.map((m) => m.team_id), ...shares.map((s) => s.team_id)]),
        ]
        const removals: RemovedAccess[] = [
          {},
          ...grants.map((g) => ({ grant: g._id })),
          ...shares.map((s) => ({ share: s._id })),
          ...memberships.map((m) => ({
            membership: { team_id: m.team_id, profile_id: subject.id },
          })),
          ...teams.map((team) => ({ team })),
        ]
        for (const org_role of ORG_ROLES) {
          await ctx.db.patch(subject._id, { org_role })
          const me = (await ctx.db.get(subject._id)) as Doc<'profiles'>
          for (const without of removals) {
            const people = (
              await projectLevelsForPeople(ctx, [me], projects, async () => {}, without)
            ).get(me.id)
            for (const project of asked) {
              const expected = people?.navigationOnly(project.id)
                ? null
                : (people?.levelOf(project) ?? null)
              const got = (await projectLevelsForProfiles(ctx, project, { without }))(me)
              expect(
                got,
                `${name}: ${org_role} on ${project.key} without ${JSON.stringify(without)}`,
              ).toBe(expected)
              const whole = (await projectLevelsForProfiles(ctx, project))(me)
              seen.add(got === whole ? 'same' : 'changed')
            }
          }
        }
      })
    }
    expect([...seen].sort()).toEqual(['changed', 'same'])
  }, 60_000)

  it('runs its guard before each read, so a guard that refuses stops it before it reads more', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      const second = await newTeam(ctx, f.org.id)
      await ctx.db.insert('team_members', {
        team_id: second,
        profile_id: subject.id,
        is_leader: false,
      })
      for (const [project, team_id] of [
        [f.meta, f.team.id],
        [f.sub, second],
      ] as const)
        await ctx.db.insert('project_team_access', {
          project_id: project.id,
          team_id,
          level: 'user',
        })
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subject.id,
        level: 'viewer',
      })
    })
    const ranges = (ctx: QueryCtx) =>
      ctx.meta.getTransactionMetrics().then((m) => m.databaseQueries.used)
    // how many times it guards and how many index ranges it reads for FW,
    // its root's and its own grants and shares and both teams
    const { calls, read } = await t.run(async (ctx) => {
      const before = await ranges(ctx)
      let calls = 0
      await projectLevelsForProfiles(ctx, f.sub, {
        guard: async () => {
          calls++
        },
      })
      return { calls, read: (await ranges(ctx)) - before }
    })
    expect(read).toBeGreaterThan(5)
    expect(calls).toBeGreaterThanOrEqual(read)
    // a guard that refuses at its k-th run leaves at most k - 1 ranges read
    for (let k = 1; k <= calls; k++) {
      const stopped = await t.run(async (ctx) => {
        const before = await ranges(ctx)
        let run = 0
        try {
          await projectLevelsForProfiles(ctx, f.sub, {
            guard: async () => {
              if (++run === k) throw new Error('full')
            },
          })
        } catch (e) {
          if (!(e instanceof Error) || e.message !== 'full') throw e
          return (await ranges(ctx)) - before
        }
        throw new Error(`the guard's run ${k} did not stop it`)
      })
      expect(stopped, `refused at run ${k}`).toBeLessThanOrEqual(k - 1)
    }
  })
})

describe('canSeeProjectFor and canBeAssignedFor', () => {
  // which answers the shapes reached, over every shape: seen with a level,
  // seen only through a sub-project (navigation), unseen, and assignable
  const reached = new Set<string>()

  it.each(SHAPES)(
    'equal canSeeProject and profileCanBeAssigned for every profile, role, kind and state: %s',
    async (name, plant) => {
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
              const people = [
                ...(await ctx.db
                  .query('profiles')
                  .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
                  .collect()),
                f.otherAdmin,
              ]
              for (const project of projects) {
                const sees = await canSeeProjectFor(ctx, project)
                const takes = await canBeAssignedFor(ctx, project)
                const levelOf = await projectLevelsForProfiles(ctx, project)
                for (const p of people) {
                  const why = `${name}: ${active ? 'active' : 'inactive'} ${org_role} ${kind} ${p.name} on ${project.key}`
                  const seen = await canSeeProject(ctx, p, project)
                  expect(sees(p), why).toBe(seen)
                  expect(takes(p), why).toBe(await profileCanBeAssigned(ctx, p, project))
                  if (p.id !== subject.id) continue
                  reached.add(!seen ? 'unseen' : levelOf(p) === null ? 'navigation' : 'level')
                  if (takes(p)) reached.add('assignable')
                }
              }
            }
          }
        }
      })
    },
  )

  it('reach every answer over the shapes, navigation through a live and an archived sub-project included', () => {
    expect([...reached].sort()).toEqual(['assignable', 'level', 'navigation', 'unseen'])
  })

  it('show a top-level project through an archived sub-project alone, and not through a sub-project of another organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const foreign = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.meta.id,
    })
    const grant = (project: Doc<'projects'>) =>
      t.run((ctx) =>
        ctx.db.insert('project_access', {
          project_id: project.id,
          profile_id: subject.id,
          level: 'viewer',
        }),
      )
    const answer = () =>
      t.run(async (ctx) => {
        const me = (await ctx.db.get(subject._id)) as Doc<'profiles'>
        return {
          many: (await canSeeProjectFor(ctx, f.meta))(me),
          one: await canSeeProject(ctx, me, f.meta),
        }
      })
    await grant(foreign)
    expect(await answer()).toEqual({ many: false, one: false })
    await grant(archived)
    expect(await answer()).toEqual({ many: true, one: true })
  })

  it('run their guard before each read, so a guard that refuses stops them before they read more', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subject.id,
        level: 'viewer',
      })
    })
    const ranges = (ctx: QueryCtx) =>
      ctx.meta.getTransactionMetrics().then((m) => m.databaseQueries.used)
    // TBED with its two sub-projects, and FW alone
    const asks = [
      (ctx: QueryCtx, guard: () => Promise<void>) => canSeeProjectFor(ctx, f.meta, { guard }),
      (ctx: QueryCtx, guard: () => Promise<void>) => canBeAssignedFor(ctx, f.sub, { guard }),
    ]
    for (const ask of asks) {
      const { calls, read } = await t.run(async (ctx) => {
        const before = await ranges(ctx)
        let calls = 0
        await ask(ctx, async () => {
          calls++
        })
        return { calls, read: (await ranges(ctx)) - before }
      })
      expect(read).toBeGreaterThan(3)
      expect(calls).toBeGreaterThanOrEqual(read)
      for (let k = 1; k <= calls; k++) {
        const stopped = await t.run(async (ctx) => {
          const before = await ranges(ctx)
          let run = 0
          try {
            await ask(ctx, async () => {
              if (++run === k) throw new Error('full')
            })
          } catch (e) {
            if (!(e instanceof Error) || e.message !== 'full') throw e
            return (await ranges(ctx)) - before
          }
          throw new Error(`the guard's run ${k} did not stop it`)
        })
        expect(stopped, `refused at run ${k}`).toBeLessThanOrEqual(k - 1)
      }
    }
  })

  it("read a top-level project's grants and shares once when their calls share reads", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'user',
      }),
    )
    const counted = (step: (ctx: QueryCtx) => Promise<unknown>) =>
      t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
        await step(ctx)
        return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before
      })
    // alone, PCB reads its root, the grants and shares on PCB and TBED,
    // and Hardware, which shares TBED, with its members
    const alone = await counted((ctx) => canSeeProjectFor(ctx, f.sub2))
    expect(alone).toBe(7)
    const shared = await counted(async (ctx) => {
      const reads = projectLevelReads()
      await canBeAssignedFor(ctx, f.sub, { reads })
      const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
      await canSeeProjectFor(ctx, f.sub2, { reads })
      const second = (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before
      // after FW, PCB reads its root and its own grants and shares only
      expect(second).toBe(3)
      // and TBED with its navigation reads its sub-projects, one range,
      // and each one's root again, nothing more
      const again = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
      await canSeeProjectFor(ctx, f.meta, { reads })
      expect((await ctx.meta.getTransactionMetrics()).databaseQueries.used - again).toBe(3)
    })
    expect(shared).toBeLessThan(3 * alone)
  })
})
