/* accessFlags (lib/core.ts), the read and write flags every REST call and the
 * MCP list tools build over the organization's catalogue. They come from the
 * batched project levels (lib/access.ts projectLevelsForOrg) and must equal
 * what canSeeProject and hasProjectLevel answer project by project, which is
 * how they were computed before and how the single-project reads and writes
 * still decide. The per-project walk is kept here as the reference, and the
 * grant shapes are in accessShapes.setup.ts. */
import { describe, expect, it } from 'vitest'
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
  projectLevelsForOrg,
  projectLevelsForPeople,
} from '../lib/access'
import { type AccessFlag, accessFlags, loadCatalogue } from '../lib/core'
import { type CredentialAccess, ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import { SHAPES } from './accessShapes.setup'
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
            // read together, then past the row budget one by one
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
