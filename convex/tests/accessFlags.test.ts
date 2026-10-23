/* accessFlags (lib/core.ts), the read and write flags every REST call and the
 * MCP list tools build over the organization's catalogue. They come from the
 * batched project levels (lib/access.ts projectLevelsForOrg) and must equal
 * what canSeeProject and hasProjectLevel answer project by project, which is
 * how they were computed before and how the single-project reads and writes
 * still decide. The per-project walk is kept here as the reference, and the
 * grant shapes are in accessShapes.setup.ts. */
import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  canAccessProject,
  canManageProjectUsers,
  canSeeProject,
  hasProjectLevel,
  LEVELS_READ,
  machineAccess,
  type OrgProjectLevels,
  OWN_READS,
  projectLevel,
  projectLevelsForOrg,
  projectLevelsForPeople,
  projectLevelsOf,
} from '../lib/access'
import { type AccessFlag, accessFlags, loadCatalogue } from '../lib/core'
import { type CredentialAccess, ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import { newTeam, SHAPES } from './accessShapes.setup'
import {
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

const ACCESS: CredentialAccess[] = ['read', 'write']
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/* The flags as accessFlags computed them before, one canSeeProject and one
 * hasProjectLevel walk per project. */
async function perProjectFlags(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  projects: readonly Doc<'projects'>[],
  access: CredentialAccess,
): Promise<Map<string, AccessFlag>> {
  const writes = machineAccess(me, access) === 'write'
  const out = new Map<string, AccessFlag>()
  for (const p of projects) {
    out.set(p.id, {
      read: await canSeeProject(ctx, me, p),
      write: writes && (await hasProjectLevel(ctx, me, p.id, 'user')),
    })
  }
  return out
}

describe('accessFlags', () => {
  it('equals canSeeProject and hasProjectLevel for every role, kind, credential and grant shape', async () => {
    const seen = new Set<string>()
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        const cat = await loadCatalogue(ctx, subject)
        // the subject under every role and kind, beside the fixture's people
        const callers = [
          ...ORG_ROLES.flatMap((org_role) =>
            PROFILE_KINDS.map((kind) => ({ ...subject, org_role, kind })),
          ),
          f.admin,
          f.user,
          f.viewer,
          f.guest,
          f.agent,
          f.otherAdmin,
        ]
        for (const me of callers) {
          for (const access of ACCESS) {
            const flags = await accessFlags(ctx, me, cat, access)
            const expected = await perProjectFlags(ctx, me, cat.projects, access)
            expect(flags, `${name}: ${me.name} as ${me.org_role} ${me.kind}, ${access}`).toEqual(
              expected,
            )
            for (const flag of flags.values()) seen.add(JSON.stringify(flag))
          }
        }
      })
    }
    // the shapes reach hidden, read-only and writable projects alike
    expect([...seen].sort()).toEqual([
      '{"read":false,"write":false}',
      '{"read":true,"write":false}',
      '{"read":true,"write":true}',
    ])
  }, 60_000)

  it('answers many people together as projectLevelsForOrg answers each alone, for every role, kind and grant shape', async () => {
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        const projects = await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .collect()
        for (const org_role of ORG_ROLES) {
          for (const kind of PROFILE_KINDS) {
            // enough people that they are read together, one of another organization
            const people = [
              { ...subject, org_role, kind },
              f.admin,
              f.user,
              f.viewer,
              f.guest,
              f.agent,
              f.otherAdmin,
            ]
            const levels = (l: OrgProjectLevels | undefined) =>
              projects.map((p) => [p.id, l?.levelOf(p), l?.navigationOnly(p.id)])
            // memberships read from the teams, then past the row budget person by person
            for (const max of [LEVELS_READ.max, 0]) {
              const before = LEVELS_READ.max
              LEVELS_READ.max = max
              const together = await projectLevelsForPeople(ctx, people, projects).finally(() => {
                LEVELS_READ.max = before
              })
              for (const me of people) {
                const alone = await projectLevelsForOrg(ctx, me, projects)
                expect(
                  levels(together.get(me.id)),
                  `${name}: ${me.name} as ${me.org_role} ${me.kind}, budget ${max}`,
                ).toEqual(levels(alone))
              }
            }
          }
        }
      })
    }
  }, 60_000)

  it('answers project by project as projectLevel, with and without navigation, for every role, kind and grant shape', async () => {
    const seen = new Set<string>()
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        const projects = await ctx.db.query('projects').collect()
        for (const org_role of ORG_ROLES) {
          for (const kind of PROFILE_KINDS) {
            for (const me of [{ ...subject, org_role, kind }, f.viewer, f.guest, f.otherAdmin]) {
              // project by project, the person's own rows read from the first
              // project on, and own rows too many to read at once, the
              // projects asked in both orders; then the organization's
              // shares not read at once, and read at once while the shares
              // have no org_id, stored before it
              for (const [own, unkeyed] of [
                [DEFAULT_OWN_READS, false],
                [
                  {
                    ...DEFAULT_OWN_READS,
                    steps: [1, 2],
                    manyTeams: 1,
                  },
                  false,
                ],
                [
                  {
                    ...DEFAULT_OWN_READS,
                    steps: [1],
                    lookups: 0,
                    rows: 0,
                    manyTeams: 1,
                    orgTeams: 0,
                    bytes: 0,
                  },
                  false,
                ],
                [{ ...DEFAULT_OWN_READS, steps: [1, 2], manyTeams: 1, orgShares: 0 }, false],
                [{ ...DEFAULT_OWN_READS, steps: [1, 2], manyTeams: 1 }, true],
              ] as const) {
                Object.assign(OWN_READS, structuredClone(own))
                const shares = await ctx.db.query('project_team_access').collect()
                for (const share of shares)
                  await ctx.db.patch(share._id, { org_id: unkeyed ? undefined : share.org_id })
                const asked = (order: readonly Doc<'projects'>[]) =>
                  order.flatMap((p) => [true, false].map((navigation) => ({ p, navigation })))
                const expectSame = async (
                  { p, navigation }: { p: Doc<'projects'>; navigation: boolean },
                  level: string | null,
                  how: string,
                ) => {
                  expect(
                    level,
                    `${name}: ${me.name} as ${me.org_role} ${me.kind} on ${p.key}, navigation ${navigation}, own reads ${JSON.stringify(own)}, unkeyed ${unkeyed}, ${how}`,
                  ).toBe(await projectLevel(ctx, me, p, navigation))
                  seen.add(String(level))
                }
                for (const order of [projects, [...projects].reverse()]) {
                  const levels = projectLevelsOf(ctx, me)
                  for (const one of asked(order))
                    await expectSame(one, await levels.level(one.p.id, one.navigation), 'in turn')
                }
                // all at once, as a part asks a batch
                const levels = projectLevelsOf(ctx, me)
                const all = asked(projects)
                const answers = await Promise.all(
                  all.map(({ p, navigation }) => levels.level(p.id, navigation)),
                )
                for (const [i, one] of all.entries()) await expectSame(one, answers[i], 'at once')
                for (const share of shares) await ctx.db.patch(share._id, { org_id: share.org_id })
              }
              Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
            }
          }
        }
      })
    }
    // the shapes reach every answer, the parent shown for navigation included
    expect([...seen].sort()).toEqual(['lead', 'null', 'user', 'viewer'])
  }, 60_000)

  it('answers null for a missing parent or a cycle where projectLevel refuses, and reads only the projects asked about', async () => {
    const t = newT()
    const f = await withOrg(t)
    const dangling = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: uuid() })
    const [one, two] = [uuid(), uuid()]
    await plantProject(t, { org_id: f.org.id, type: 'project', id: one, parent_id: two })
    await plantProject(t, { org_id: f.org.id, type: 'meta', id: two, parent_id: one })
    await t.run(async (ctx) => {
      for (const p of [
        dangling,
        await ctx.db
          .query('projects')
          .withIndex('by_uuid', (q) => q.eq('id', one))
          .unique(),
      ]) {
        await expect(projectLevel(ctx, f.admin, p!)).rejects.toThrow(/project not found/)
        expect(await projectLevelsOf(ctx, f.admin).level(p!.id)).toBeNull()
      }
      expect(await projectLevelsOf(ctx, f.admin).level(uuid())).toBeNull()
    })
    // many other projects cost one sub-project's answer nothing
    await t.run(async (ctx) => {
      for (let n = 0; n < 200; n++)
        await ctx.db.insert('projects', {
          id: uuid(),
          org_id: f.org.id,
          type: 'project',
          parent_id: f.meta.id,
          key: `M${n}`,
          name: `Many ${n}`,
          description: '',
          sort_order: 500 + n,
          num: 500 + n,
          track_delay: false,
          created_at: NOW,
        })
    })
    const read = await t.run(async (ctx) => {
      expect(await projectLevelsOf(ctx, f.user).level(f.sub.id)).toBe('lead')
      expect(await projectLevelsOf(ctx, f.viewer).level(f.sub.id)).toBe(
        await projectLevel(ctx, f.viewer, f.sub),
      )
      return (await ctx.meta.getTransactionMetrics()).documentsRead.used
    })
    expect(read).toBeLessThan(20)
  })

  it("stops reading the organization's teams at OWN_READS.bytes and answers from the person's own teams", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    // team by team, without the organization's shares at once
    OWN_READS.orgShares = 0
    // eight teams of the person, one of them shares the meta's sub-project,
    // beside 24 teams with 64 KiB legacy icons, 1.5 MiB in all
    await t.run(async (ctx) => {
      const team = async (icon?: string) => {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: 'Team',
          icon,
          track_delay_default: false,
          created_at: NOW,
        })
        return id
      }
      for (let i = 0; i < 24; i++) await team('x'.repeat(64 * 1024))
      for (let i = 0; i < OWN_READS.manyTeams; i++) {
        const id = await team()
        await ctx.db.insert('team_members', {
          team_id: id,
          profile_id: me.id,
          org_id: me.org_id,
          is_leader: false,
        })
        if (i === 0)
          await ctx.db.insert('project_team_access', {
            project_id: f.sub.id,
            org_id: f.sub.org_id,
            team_id: id,
            level: 'user',
          })
      }
    })
    await t.run(async (ctx) => {
      const before = (await ctx.meta.getTransactionMetrics()).bytesRead.used
      const levels = projectLevelsOf(ctx, me)
      for (const p of [f.meta, f.sub, f.sub2]) {
        expect(await levels.level(p.id, true), p.key).toBe(await projectLevel(ctx, me, p, true))
      }
      const read = (await ctx.meta.getTransactionMetrics()).bytesRead.used - before
      expect(await levels.level(f.sub.id)).toBe('user')
      // the scan reached the bound and stopped at the first row past it,
      // the reference walk's reads included
      expect(levels.shared.bytes).toBeGreaterThan(OWN_READS.bytes)
      expect(levels.shared.bytes).toBeLessThan(OWN_READS.bytes + 2 * 64 * 1024)
      expect(read).toBeLessThan(OWN_READS.bytes + 3 * 64 * 1024)
    })
  })

  it("stops reading the organization's teams past OWN_READS.orgTeams rows a team asked about and answers team by team", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    // team by team, without the organization's shares at once
    Object.assign(OWN_READS, { manyTeams: 2, orgTeams: 1, orgShares: 0 })
    // ten small teams first, then the person's two, one sharing the
    // sub-project, past the two rows the scan may read
    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) await newTeam(ctx, f.org.id)
      for (let i = 0; i < 2; i++) {
        const id = await newTeam(ctx, f.org.id)
        await ctx.db.insert('team_members', {
          team_id: id,
          profile_id: me.id,
          org_id: me.org_id,
          is_leader: false,
        })
        if (i === 0)
          await ctx.db.insert('project_team_access', {
            project_id: f.sub.id,
            org_id: f.sub.org_id,
            team_id: id,
            level: 'user',
          })
      }
    })
    await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      expect(await levels.level(f.meta.id)).toBe('viewer')
      expect(await levels.level(f.meta.id)).toBe(await projectLevel(ctx, me, f.meta))
      // two memberships, the scan's first three rows, both teams by their
      // own read and the one share, not the organization's 13 teams, and
      // the one share the read of the organization's shares stopped at
      expect(levels.shared.documents).toBe(2 + 3 + 2 + 1 + 1)
    })
  })

  it("answers every project from navigation's read of the person's team shares, and reads the organization's teams only for teams it must ask about", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const subs = await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        org_id: me.org_id,
        is_leader: false,
      })
      for (const p of [f.sub, f.sub2])
        await ctx.db.insert('project_team_access', {
          project_id: p.id,
          org_id: p.org_id,
          team_id: f.team.id,
          level: 'user',
        })
      const ids: string[] = []
      for (let n = 0; n < 20; n++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: f.meta.id,
          key: `S${n}`,
          name: `Spread ${n}`,
          description: '',
          sort_order: 500 + n,
          num: 500 + n,
          track_delay: false,
          created_at: NOW,
        })
        ids.push(id)
      }
      return ids
    })
    // the shares are too many to read at once, so navigation reads them
    // and they answer every later project
    Object.assign(OWN_READS, { steps: [1], rows: 1 })
    await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      expect(await levels.level(f.meta.id)).toBe('viewer')
      const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
      for (const id of subs) expect(await levels.level(id)).toBeNull()
      // one range a project for its own row, none for its shares
      expect((await ctx.meta.getTransactionMetrics()).databaseQueries.used - before).toBe(20)
    })
    // the shares known before navigation name one team of the person's
    // two, which the sub-projects asked already checked, so it reads no
    // team at all
    await t.run(async (ctx) => {
      const team_id = await newTeam(ctx, f.org.id)
      await ctx.db.insert('team_members', {
        team_id,
        profile_id: me.id,
        org_id: me.org_id,
        is_leader: false,
      })
    })
    Object.assign(OWN_READS, { ...DEFAULT_OWN_READS, steps: [2], manyTeams: 1 })
    await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      expect(await levels.level(f.sub.id)).toBe('user')
      expect(await levels.level(f.sub2.id)).toBe('user')
      const known = { ...levels.shared }
      expect(await levels.level(f.meta.id)).toBe('viewer')
      // a read nothing awaits would still count after the answer
      for (let i = 0; i < 100; i++) await Promise.resolve()
      expect(levels.shared).toEqual(known)
    })
  })

  it('refuses as projectLevel does where a team id names two rows, under navigation, with no rejection left unhandled', async () => {
    for (const many of [false, true]) {
      const t = newT()
      const f = await withOrg(t)
      const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run(async (ctx) => {
        // the person's teams, enough to read the organization's teams or not,
        // the first with a second row of its id and a share on the
        // sub-project
        for (let i = 0; i < (many ? OWN_READS.manyTeams : 1); i++) {
          const id = await newTeam(ctx, f.org.id)
          await ctx.db.insert('team_members', {
            team_id: id,
            profile_id: me.id,
            org_id: me.org_id,
            is_leader: false,
          })
          if (i > 0) continue
          await ctx.db.insert('teams', {
            id,
            org_id: f.org.id,
            name: 'Twin',
            track_delay_default: false,
            created_at: NOW,
          })
          await ctx.db.insert('project_team_access', {
            project_id: f.sub.id,
            org_id: f.sub.org_id,
            team_id: id,
            level: 'user',
          })
        }
      })
      const unhandled: unknown[] = []
      const note = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', note)
      try {
        await t.run(async (ctx) => {
          await expect(projectLevel(ctx, me, f.meta)).rejects.toThrow()
          await expect(projectLevelsOf(ctx, me).level(f.meta.id)).rejects.toThrow()
        })
        await new Promise((done) => setTimeout(done, 10))
      } finally {
        process.off('unhandledRejection', note)
      }
      expect(unhandled, `${many ? 'many teams' : 'one team'}`).toEqual([])
    }
  })

  it('hides a project outside a top-level meta from everyone, in lists and single reads and writes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const dangling = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: uuid() })
    const loose = await plantProject(t, { org_id: f.org.id, type: 'project' })
    const underLoose = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: loose.id,
    })
    const nested = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.sub.id })
    const [one, two] = [uuid(), uuid()]
    const cycle = [
      await plantProject(t, { org_id: f.org.id, type: 'project', id: one, parent_id: two }),
      await plantProject(t, { org_id: f.org.id, type: 'meta', id: two, parent_id: one }),
    ]
    const broken = [dangling, loose, underLoose, nested, ...cycle].map((p) => p.id)
    await t.run(async (ctx) => {
      const cat = await loadCatalogue(ctx, f.admin)
      for (const me of [f.admin, f.user, f.viewer, f.guest, f.agent]) {
        const flags = await accessFlags(ctx, me, cat, 'write')
        for (const id of broken) expect(flags.get(id)).toEqual({ read: false, write: false })
      }
      // the rest of the organization keeps its flags
      const admin = await accessFlags(ctx, f.admin, cat, 'write')
      expect(admin.get(f.sub.id)).toEqual({ read: true, write: true })
    })
    // The per-project walk refused over a missing parent or a cycle, so every
    // REST call in the organization failed with "project not found".
    await expectRefusal(
      t.run(async (ctx) =>
        perProjectFlags(ctx, f.admin, (await loadCatalogue(ctx, f.admin)).projects, 'write'),
      ),
      'not_found',
      /project not found/,
    )
    const rows = await t.query(internal.machine.rest.listProjects, {
      callerId: f.admin.id,
      access: 'write',
    })
    expect(rows.map((p) => p.key).sort()).toEqual(['FW', 'PCB', 'SKNK', 'TBED'])
    // The per-project predicates hide the projects they can walk to a root
    // too, so the single-project reads and writes agree with the lists.
    await t.run(async (ctx) => {
      for (const me of [f.admin, f.user, f.viewer, f.guest, f.agent]) {
        const walked = [loose, underLoose, nested]
        const flags = await perProjectFlags(ctx, me, walked, 'write')
        for (const p of walked) {
          expect(flags.get(p.id), `${me.name} on ${p.key}`).toEqual({ read: false, write: false })
          expect(await canAccessProject(ctx, me, p)).toBe(false)
          expect(await canManageProjectUsers(ctx, me, p)).toBe(false)
        }
      }
    })
    const as_ = { callerId: f.admin.id, access: 'write' as const }
    for (const p of [loose, underLoose, nested]) {
      await expectRefusal(
        t.query(internal.machine.projects.mcpGetProject, { ...as_, project: p.key }),
        'not_found',
      )
      await expectRefusal(
        t.query(internal.machine.rest.getProject, { ...as_, ref: p.key }),
        'not_found',
      )
      await expectRefusal(
        t.mutation(internal.machine.projects.restUpdateProject, {
          ...as_,
          keyName: 'drive',
          ref: p.key,
          body: JSON.stringify({ name: 'Renamed' }),
        }),
        'not_found',
      )
      await expectRefusal(
        t.mutation(internal.machine.projects.mcpUpdateProject, {
          ...as_,
          project: p.key,
          name: 'Renamed',
        }),
        'not_found',
      )
      const task = await plantIssue(t, { org_id: f.org.id, project_id: p.id })
      await expectRefusal(
        t.query(internal.machine.rest.getIssue, { today: TODAY, ...as_, ref: task.id }),
        'not_found',
      )
      await expectRefusal(
        t.query(internal.machine.mcp.getIssue, { today: TODAY, ...as_, ref: task.id }),
        'not_found',
      )
    }
  })

  it("stays within Convex's 4,096 index ranges for a writer among 1,654 projects, where the per-project walk did not", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 150 parents with ten sub-projects each. The agent holds User on the
    // last sub-project of each, so each parent shows only for navigation,
    // which the per-project walk finds after reading every sibling's grants.
    // convex-test counts every query, while a deployment counts a range the
    // function already read once, which is about three ranges per project
    // for this walk (measured on a local backend). This organization passes
    // 4,096 either way.
    const granted = await t.run(async (ctx) => {
      const ids: string[] = []
      const row = (n: number, key: string, parent_id?: string) => ({
        id: uuid(),
        org_id: f.org.id,
        type: parent_id === undefined ? ('meta' as const) : ('project' as const),
        parent_id,
        key,
        name: `Project ${key}`,
        description: '',
        sort_order: n,
        num: n,
        track_delay: false,
        created_at: NOW,
      })
      for (let m = 0; m < 150; m++) {
        const parent = row(100 + m, `P${m}`)
        await ctx.db.insert('projects', parent)
        for (let s = 0; s < 10; s++) {
          const sub = row(1000 + m * 10 + s, `Q${m * 10 + s}`, parent.id)
          await ctx.db.insert('projects', sub)
          if (s === 9) {
            await ctx.db.insert('project_access', {
              project_id: sub.id,
              profile_id: f.agent.id,
              level: 'user',
            })
            ids.push(sub.id)
          }
        }
      }
      return ids
    })
    await expect(
      t.run(async (ctx) =>
        perProjectFlags(ctx, f.agent, (await loadCatalogue(ctx, f.agent)).projects, 'write'),
      ),
    ).rejects.toThrow(/Too many index ranges read/)
    const ranges = await t.run(async (ctx) => {
      const cat = await loadCatalogue(ctx, f.agent)
      expect(cat.projects).toHaveLength(1654)
      const flags = [...(await accessFlags(ctx, f.agent, cat, 'write')).values()]
      expect(flags.filter((flag) => flag.read)).toHaveLength(300)
      expect(flags.filter((flag) => flag.write)).toHaveLength(150)
      return (await ctx.meta.getTransactionMetrics()).databaseQueries.used
    })
    // the catalogue, the agent's grants and its team memberships
    expect(ranges).toBeLessThan(10)
    const rest = await t.query(internal.machine.rest.listProjects, {
      callerId: f.agent.id,
      access: 'write',
    })
    expect(rest).toHaveLength(300)
    expect(
      rest
        .filter((p) => p.access.write)
        .map((p) => p.id)
        .sort(),
    ).toEqual([...granted].sort())
    const mcp: { access: AccessFlag }[] = JSON.parse(
      await t.query(internal.machine.mcp.listProjects, { callerId: f.agent.id, access: 'write' }),
    )
    expect(mcp.filter((p) => p.access.read)).toHaveLength(300)
  })
})
