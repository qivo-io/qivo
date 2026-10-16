/* accessFlags (lib/core.ts), the read and write flags every REST call and the
 * MCP list tools build over the organization's catalogue. They come from the
 * batched project levels (lib/access.ts projectLevelsForOrg) and must equal
 * what canSeeProject and hasProjectLevel answer project by project, which is
 * how they were computed before, for every tree the project writers can
 * build. The per-project walk is kept here as the reference. */
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { canSeeProject, hasProjectLevel, machineAccess } from '../lib/access'
import { type AccessFlag, accessFlags, loadCatalogue } from '../lib/core'
import {
  type CredentialAccess,
  GRANT_LEVELS,
  type GrantLevel,
  ORG_ROLES,
  PROFILE_KINDS,
} from '../lib/enums'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  uuid,
  withOrg,
} from './helpers.setup'

const ACCESS: CredentialAccess[] = ['read', 'write']

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

const grant = (
  ctx: MutationCtx,
  project: Doc<'projects'>,
  me: Doc<'profiles'>,
  level: GrantLevel,
) => ctx.db.insert('project_access', { project_id: project.id, profile_id: me.id, level })

const join = (ctx: MutationCtx, teamId: string, me: Doc<'profiles'>, is_leader = false) =>
  ctx.db.insert('team_members', { team_id: teamId, profile_id: me.id, is_leader })

const share = (ctx: MutationCtx, project: Doc<'projects'>, teamId: string, level: GrantLevel) =>
  ctx.db.insert('project_team_access', { project_id: project.id, team_id: teamId, level })

/* A new team of organization `orgId`, without members. */
async function newTeam(ctx: MutationCtx, orgId: string): Promise<string> {
  const id = uuid()
  await ctx.db.insert('teams', {
    id,
    org_id: orgId,
    name: 'Second',
    stale_days: 14,
    archive_days: 30,
    track_delay_default: false,
    created_at: NOW,
  })
  return id
}

/* What the subject holds, planted over the withOrg fixture: the TBED meta
 * (led by `user`) with sub-projects FW and PCB, and SKNK, which no shape
 * touches. */
type Shape = [
  name: string,
  plant: (ctx: MutationCtx, f: OrgFixture, me: Doc<'profiles'>) => Promise<unknown>,
]

const SHAPES: Shape[] = [
  ['no grant', async () => {}],
  ...GRANT_LEVELS.flatMap((level): Shape[] => [
    [`${level} grant on the parent`, (ctx, f, me) => grant(ctx, f.meta, me, level)],
    [`${level} grant on a sub-project`, (ctx, f, me) => grant(ctx, f.sub, me, level)],
    [
      `${level} team share on the parent`,
      async (ctx, f, me) => {
        await join(ctx, f.team.id, me)
        await share(ctx, f.meta, f.team.id, level)
      },
    ],
    [
      `${level} team share on a sub-project`,
      async (ctx, f, me) => {
        await join(ctx, f.team.id, me)
        await share(ctx, f.sub, f.team.id, level)
      },
    ],
  ]),
  [
    'viewer grant on the parent and user grant on a sub-project',
    async (ctx, f, me) => {
      await grant(ctx, f.meta, me, 'viewer')
      await grant(ctx, f.sub, me, 'user')
    },
  ],
  [
    'viewer team share and user grant on the parent',
    async (ctx, f, me) => {
      await join(ctx, f.team.id, me)
      await share(ctx, f.meta, f.team.id, 'viewer')
      await grant(ctx, f.meta, me, 'user')
    },
  ],
  [
    'user team share and viewer grant on a sub-project',
    async (ctx, f, me) => {
      await join(ctx, f.team.id, me)
      await share(ctx, f.sub, f.team.id, 'user')
      await grant(ctx, f.sub, me, 'viewer')
    },
  ],
  [
    'viewer and user shares on the parent through two teams',
    async (ctx, f, me) => {
      const other = await newTeam(ctx, f.org.id)
      await join(ctx, f.team.id, me)
      await join(ctx, other, me)
      await share(ctx, f.meta, f.team.id, 'viewer')
      await share(ctx, f.meta, other, 'user')
    },
  ],
  [
    'viewer grant on one sub-project and user grant on the other',
    async (ctx, f, me) => {
      await grant(ctx, f.sub, me, 'viewer')
      await grant(ctx, f.sub2, me, 'user')
    },
  ],
  [
    'a share through a team whose row is gone',
    async (ctx, f, me) => {
      const gone = uuid()
      await join(ctx, gone, me)
      await share(ctx, f.meta, gone, 'user')
    },
  ],
  [
    'a share on the parent to a team the subject is not in',
    (ctx, f) => share(ctx, f.meta, f.team.id, 'user'),
  ],
  [
    "another organization's team shared on the parent",
    async (ctx, f, me) => {
      const teamId = await newTeam(ctx, f.otherOrg.id)
      await join(ctx, teamId, me)
      await share(ctx, f.meta, teamId, 'user')
    },
  ],
  ['leader of a team without shares', (ctx, f, me) => join(ctx, f.team.id, me, true)],
  ['lead of the parent', (ctx, f, me) => ctx.db.patch(f.meta._id, { lead_id: me.id })],
  [
    'lead of the parent while someone else leads a sub-project',
    async (ctx, f, me) => {
      await ctx.db.patch(f.meta._id, { lead_id: me.id })
      await ctx.db.patch(f.sub2._id, { lead_id: f.user.id })
    },
  ],
  ['lead of a sub-project', (ctx, f, me) => ctx.db.patch(f.sub._id, { lead_id: me.id })],
  [
    'user grant on an archived sub-project',
    async (ctx, f, me) => {
      await ctx.db.patch(f.sub._id, { archived_at: NOW })
      await grant(ctx, f.sub, me, 'user')
    },
  ],
  [
    "user grant on another organization's project",
    (ctx, f, me) => grant(ctx, f.otherProject, me, 'user'),
  ],
]

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

  it('gives no flag on a project outside a top-level meta, even to an admin', async () => {
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
