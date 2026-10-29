/* lib/access.ts projectLevelsOf's bounded reads of a person's own rows
 * (OWN_READS): whether a top-level project shows for navigation, answered
 * from project_reach rows once the organization's rows are complete
 * (org_ready nav_at) and from the bounded legacy path before; the bounded
 * team shares of one project and memberships; and the one refusal a check
 * a bound stops ends in (accessUnchecked), which never answers no level
 * and never a wider one. Every answer below the bounds is projectLevel's,
 * which accessFlags.test.ts holds for every grant shape and rung. Each
 * caller's answer to the refusal is pinned beside its own suite. */
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  ACCESS_UNCHECKED,
  accessOf,
  canAccessProject,
  canSeeProject,
  isAccessUnchecked,
  OWN_READS,
  projectLevel,
  projectLevelsOf,
} from '../lib/access'
import { byId, newWindowKey } from '../lib/db'
import { ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import { halve, type IdWindow, idWindows, inIdWindow } from '../lib/idWindows'
import { NAME_MAX } from '../lib/limits'
import { mainSearchPage } from '../lib/mainSearch'
import { nameKey } from '../lib/nameKey'
import { inWorkingSet } from '../lib/workingSet'
import { readProjects } from '../lib/workspaceParts'
import { postMessage } from '../model/messages'
import { planReach } from '../model/projectNav'
import { newTeam, SHAPES } from './accessShapes.setup'
import {
  as,
  NOW,
  newT,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { withReach } from './projectReach.setup'

const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/* What a transaction read so far, as Convex counts it. */
async function readsOf(ctx: QueryCtx) {
  const m = await ctx.meta.getTransactionMetrics()
  return {
    ranges: m.databaseQueries.used,
    documents: m.documentsRead.used,
    bytes: m.bytesRead.used,
  }
}

/* The level, or 'refused' where a bound stopped the check. */
async function levelOrRefused(levels: ReturnType<typeof projectLevelsOf>, id: string, nav = true) {
  try {
    return await levels.level(id, nav)
  } catch (e) {
    if (isAccessUnchecked(e)) return 'refused'
    throw e
  }
}

/* Stamps nav_at on organization `orgId`, as navBackfill does once its rows
 * are complete. */
const stampNav = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('org_ready')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique()
    if (row === null) await ctx.db.insert('org_ready', { org_id: orgId, nav_at: NOW })
    else await ctx.db.patch(row._id, { nav_at: NOW })
  })

/* Distinct keys and numbers for the families planted here. */
let familyNum = 10_000

/* A meta of `orgId` with `subs` sub-projects, in one transaction. */
async function plantFamily(
  ctx: MutationCtx,
  orgId: string,
  name: string,
  subs: number,
): Promise<{ meta: Doc<'projects'>; subs: Doc<'projects'>[] }> {
  const row = (n: number, parent_id?: string) => {
    const num = familyNum++
    return {
      id: uuid(),
      org_id: orgId,
      type: parent_id === undefined ? ('meta' as const) : ('project' as const),
      parent_id,
      key: `F${num}`,
      name: `${name} ${n}`,
      description: '',
      sort_order: num,
      num,
      track_delay: false,
      created_at: NOW,
      window_key: newWindowKey(),
    }
  }
  const meta = (await ctx.db.get(await ctx.db.insert('projects', row(0))))!
  const out: Doc<'projects'>[] = []
  for (let n = 1; n <= subs; n++)
    out.push((await ctx.db.get(await ctx.db.insert('projects', row(n, meta.id))))!)
  return { meta, subs: out }
}

/* The reach rows planReach writes for team `teamId`'s shares on `subs`,
 * every one under top-level project `meta`: a child row each and a root row
 * for navigation. */
async function plantTeamReach(
  ctx: MutationCtx,
  teamId: string,
  meta: Doc<'projects'>,
  subs: readonly Doc<'projects'>[],
) {
  const row = (p: Doc<'projects'>, kind: 'root' | 'child') => ({
    org_id: p.org_id,
    grantee_kind: 'team' as const,
    grantee_id: teamId,
    kind,
    project_id: p.id,
    root_id: meta.id,
    name_key: nameKey(p.name),
    key: p.key,
    live: p.archived_at === undefined,
    on_root: false,
  })
  await ctx.db.insert('project_reach', row(meta, 'root'))
  for (const sub of subs) await ctx.db.insert('project_reach', row(sub, 'child'))
}

describe('projectLevelsOf own reads', () => {
  it('answers as canSeeProject, canAccessProject and projectLevel through accessOf on both paths, and holds a task as the working-set rule does', async () => {
    for (const [name, plant] of SHAPES) {
      for (const reach of [false, true]) {
        const t = newT()
        const f = await withOrg(t)
        const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
        await t.run((ctx) => plant(ctx, f, subject))
        const tasks = new Map<string, Doc<'issues'>>()
        for (const p of [f.meta, f.sub, f.sub2, f.hidden])
          tasks.set(p.id, await plantIssue(t, { org_id: f.org.id, project_id: p.id }))
        if (reach) await withReach(t)
        await t.run(async (ctx) => {
          const projects = await ctx.db
            .query('projects')
            .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
            .collect()
          for (const org_role of ORG_ROLES)
            for (const kind of PROFILE_KINDS)
              for (const me of [{ ...subject, org_role, kind }, f.viewer, f.guest, f.otherAdmin]) {
                const access = accessOf(ctx, me)
                const how = `${name}: ${me.name} as ${me.org_role} ${me.kind}, ${reach ? 'reach rows' : 'legacy'}`
                for (const p of projects) {
                  const sees = await canSeeProject(ctx, me, p)
                  expect(await access.visible(p.id), `${how} on ${p.key}`).toBe(sees)
                  expect(await access.accessible(p.id), `${how} on ${p.key}`).toBe(
                    await canAccessProject(ctx, me, p),
                  )
                  expect(await access.level(p.id), `${how} on ${p.key}`).toBe(
                    await projectLevel(ctx, me, p),
                  )
                  const task = tasks.get(p.id)
                  if (task === undefined) continue
                  const live = (await ctx.db.get(p._id))!
                  expect(await access.holds(task), `${how}, task on ${p.key}`).toBe(
                    me.org_id === p.org_id &&
                      live.archived_at === undefined &&
                      inWorkingSet(task, live, sees),
                  )
                }
              }
        })
      }
    }
  }, 240_000)

  it('answers every Northstar person on every project as projectLevel from reach rows, reading fewer documents than the legacy path', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    const read = async () =>
      await t.run(async (ctx) => {
        const projects = await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .collect()
        let documents = 0
        let ranges = 0
        for (const me of profiles) {
          const levels = projectLevelsOf(ctx, me, projects)
          const before = await readsOf(ctx)
          const answers = await Promise.all(
            projects.flatMap((p) => [levels.level(p.id), levels.level(p.id, false)]),
          )
          const after = await readsOf(ctx)
          documents += after.documents - before.documents
          ranges += after.ranges - before.ranges
          for (const [i, p] of projects.entries()) {
            expect(answers[2 * i], `${me.name} on ${p.key}`).toBe(await projectLevel(ctx, me, p))
            expect(answers[2 * i + 1], `${me.name} on ${p.key}, no navigation`).toBe(
              await projectLevel(ctx, me, p, false),
            )
          }
        }
        return { documents, ranges }
      })
    const legacy = await read()
    await stampNav(t, org.id)
    const reach = await read()
    // reported in the stage's report: Northstar's people, every project
    console.info(
      `Northstar levels, legacy ${JSON.stringify(legacy)}, reach ${JSON.stringify(reach)}`,
    )
    expect(reach.documents).toBeLessThanOrEqual(legacy.documents)
  }, 120_000)

  it("answers a top-level project from the person's reach rows only, whatever the organization's other sub-projects and team shares", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await withReach(t)
    const answers = () =>
      t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        const before = await readsOf(ctx)
        const out = [
          await levels.level(f.meta.id),
          await levels.level(f.hidden.id),
          await levels.level(f.sub.id),
          await levels.level(f.sub2.id),
        ]
        const after = await readsOf(ctx)
        return {
          out,
          documents: after.documents - before.documents,
          ranges: after.ranges - before.ranges,
        }
      })
    const first = await answers()
    expect(first.out).toEqual(['viewer', null, 'user', null])
    // hidden families of 3,000 sub-projects, shared with 2,000 teams the
    // person is not in, and a hidden family under TBED's own sharing team
    // that is not theirs
    for (let n = 0; n < 2; n++) {
      const family = await t.run((ctx) => plantFamily(ctx, f.org.id, `Hidden${n}`, 1_500))
      await t.run(async (ctx) => {
        for (let i = 0; i < 1_000; i++) {
          const team_id = await newTeam(ctx, f.org.id)
          await ctx.db.insert('project_team_access', {
            project_id: family.subs[i].id,
            team_id,
            level: 'user',
          })
        }
      })
    }
    await withReach(t)
    const later = await answers()
    expect(later.out).toEqual(first.out)
    expect(later.documents).toBe(first.documents)
    expect(later.ranges).toBe(first.ranges)
    expect(first.documents).toBeLessThan(20)
  }, 240_000)

  it('never shows a hidden top-level project for a reach row that names a sub-project of another one, and a viewer leads nothing on either path', async () => {
    for (const reach of [false, true]) {
      const t = newT()
      const f = await withOrg(t)
      const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject', org_role: 'viewer' })
      await t.run(async (ctx) => {
        await ctx.db.insert('project_access', {
          project_id: f.sub.id,
          profile_id: me.id,
          level: 'viewer',
        })
        await ctx.db.patch(f.sub2._id, { lead_id: me.id })
      })
      const hiddenTop = await plantProject(t, { org_id: f.org.id, name: 'Zephyr hidden' })
      if (reach) {
        await withReach(t)
        // rows a Deleted items move or a reused id can leave: a root row on
        // the hidden project and child rows under it naming FW, which the
        // person sees under TBED, and SKNK, a top-level project
        await t.run(async (ctx) => {
          const row = {
            org_id: f.org.id,
            grantee_kind: 'profile' as const,
            grantee_id: me.id,
            root_id: hiddenTop.id,
            key: hiddenTop.key,
            live: true,
            on_root: false,
          }
          await ctx.db.insert('project_reach', {
            ...row,
            kind: 'root',
            project_id: hiddenTop.id,
            name_key: 'zephyr hidden',
          })
          for (const p of [f.sub, f.hidden])
            await ctx.db.insert('project_reach', {
              ...row,
              kind: 'child',
              project_id: p.id,
              name_key: 'a',
            })
        })
      }
      await t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        const before = await readsOf(ctx)
        expect(await levels.level(hiddenTop.id)).toBeNull()
        expect((await readsOf(ctx)).documents - before.documents).toBeLessThan(20)
        // FW shows TBED; a viewer's lead of PCB shows neither PCB nor more
        expect(await levels.level(f.meta.id)).toBe('viewer')
        expect(await levels.level(f.sub2.id)).toBeNull()
        for (const p of [hiddenTop, f.meta, f.sub, f.sub2])
          expect(await levels.level(p.id)).toBe(await projectLevel(ctx, me, p))
      })
    }
    // a viewer who reaches TBED only through the PCB they lead sees nothing
    for (const reach of [false, true]) {
      const t = newT()
      const f = await withOrg(t)
      const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject', org_role: 'viewer' })
      await t.run((ctx) => ctx.db.patch(f.sub2._id, { lead_id: me.id }))
      if (reach) await withReach(t)
      await t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        for (const p of [f.meta, f.sub2]) {
          expect(await levels.level(p.id), `${p.key}, reach ${reach}`).toBeNull()
          expect(await projectLevel(ctx, me, p)).toBeNull()
        }
      })
    }
  })

  it('answers a parent through a team share where a viewer seat leads more of its sub-projects than navigation checks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject', org_role: 'viewer' })
    const family = await t.run((ctx) => plantFamily(ctx, f.org.id, 'Led', OWN_READS.children + 2))
    await t.run(async (ctx) => {
      // the viewer leads every sub-project but the last, which their team
      // shares
      for (const sub of family.subs.slice(0, -1)) await ctx.db.patch(sub._id, { lead_id: me.id })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: family.subs.at(-1)!.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await withReach(t)
    await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      expect(await levels.level(family.meta.id)).toBe('viewer')
      expect(await levels.level(family.meta.id)).toBe(await projectLevel(ctx, me, family.meta))
    })
    // without the share the seat's leads all fail, past the rows checked,
    // and the legacy path answers for the parent
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('project_team_access').collect())
        if (row.project_id === family.subs.at(-1)!.id) await ctx.db.delete(row._id)
    })
    await withReach(t)
    await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      expect(await levels.level(family.meta.id)).toBeNull()
      expect(await projectLevel(ctx, me, family.meta)).toBeNull()
    })
  })

  it("counts the reach path's readiness, membership and root-row reads once in shared, and a second instance reads them again", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const second = await plantProject(t, { org_id: f.org.id, name: 'Second' })
    const under = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: second.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      for (const p of [f.sub, under])
        await ctx.db.insert('project_team_access', {
          project_id: p.id,
          team_id: f.team.id,
          level: 'user',
        })
    })
    await withReach(t)
    await t.run(async (ctx) => {
      for (let n = 0; n < 2; n++) {
        const levels = projectLevelsOf(ctx, me)
        expect(await Promise.all([levels.level(f.meta.id), levels.level(second.id)])).toEqual([
          'viewer',
          'viewer',
        ])
        // the readiness row, the one membership, the root rows of the team
        // (TBED and Second) and of the seat (none), and the team's row, once
        expect([levels.shared.ranges, levels.shared.documents], `instance ${n}`).toEqual([5, 5])
      }
    })
  })

  it('reads the person own rows once for a batch of projects shared with more teams than it reads', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const subs = await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      const family = await plantFamily(ctx, f.org.id, 'Wide', 64)
      for (const sub of family.subs) {
        await ctx.db.insert('project_team_access', {
          project_id: sub.id,
          team_id: f.team.id,
          level: 'user',
        })
        for (let i = 0; i < 2; i++)
          await ctx.db.insert('project_team_access', {
            project_id: sub.id,
            team_id: uuid(),
            level: 'user',
          })
      }
      return family.subs
    })
    // only the largest step, which the first project past projectShares
    // starts, so the batch's questions run it together
    Object.assign(OWN_READS, { projectShares: 2, steps: [512] })
    await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      const answers = await Promise.all(subs.map((sub) => levels.level(sub.id, false)))
      expect(answers.every((level) => level === 'user')).toBe(true)
      // grants and memberships at the largest step, the one team's shares
      // and its row, each once for the 64 questions
      expect(levels.shared.ranges).toBe(4)
      expect(levels.shared.documents).toBe(1 + 64 + 1)
    })
  })

  it('answers through the legacy path without nav_at, and the same through reach rows once it is stamped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const ask = () =>
      t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        const out = await Promise.all([f.meta, f.hidden].map((p) => levels.level(p.id)))
        return { out, shared: { ...levels.shared } }
      })
    await withReach(t)
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('org_ready').collect()) await ctx.db.delete(row._id)
    })
    const legacy = await ask()
    await stampNav(t, f.org.id)
    const reach = await ask()
    expect(legacy.out).toEqual(['viewer', null])
    expect(reach.out).toEqual(legacy.out)
    // legacy: readiness, membership, grants, the team and its shares; reach:
    // readiness, membership, the root rows of the team and the seat, and the
    // team, which a sub-project's check reads
    expect(legacy.shared.ranges).toBe(5)
    expect(reach.shared.ranges).toBe(5)
  })

  it('refuses as projectLevel does where a team id names two rows on the reach path, with no rejection left unhandled', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const twin = await t.run(async (ctx) => {
      const id = await newTeam(ctx, f.org.id)
      await ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name: 'Twin',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: id, profile_id: me.id, is_leader: false })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: id,
        level: 'user',
      })
      // the rows planReach would write, which navBackfill refuses to plan
      // over the twin
      await plantTeamReach(ctx, id, f.meta, [f.sub])
      await ctx.db.insert('org_ready', { org_id: f.org.id, nav_at: NOW })
      return id
    })
    expect(twin).toBeDefined()
    const unhandled: unknown[] = []
    const note = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', note)
    try {
      await t.run(async (ctx) => {
        await expect(projectLevel(ctx, me, f.meta)).rejects.toThrow()
        const levels = projectLevelsOf(ctx, me)
        const asked = levels.level(f.meta.id)
        await expect(asked).rejects.toThrow()
        await expect(asked).rejects.not.toSatisfy(isAccessUnchecked)
      })
      await new Promise((done) => setTimeout(done, 10))
    } finally {
      process.off('unhandledRejection', note)
    }
    expect(unhandled).toEqual([])
  })

  it('leaves no rejection unhandled when a bound refuses a question', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    Object.assign(OWN_READS, { subProjects: 1 })
    const unhandled: unknown[] = []
    const note = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', note)
    try {
      await t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        const refused = await levels.level(f.meta.id).catch((e: unknown) => e)
        expect(isAccessUnchecked(refused) && refused.data.reason).toBe(ACCESS_UNCHECKED)
        // the refusal stays for the rest of the instance, and other
        // questions still answer
        await expect(levels.level(f.meta.id)).rejects.toSatisfy(isAccessUnchecked)
        expect(await levels.level(f.sub.id)).toBe('user')
        expect(await levels.level(f.meta.id, false)).toBeNull()
      })
      await new Promise((done) => setTimeout(done, 10))
    } finally {
      process.off('unhandledRejection', note)
    }
    expect(unhandled).toEqual([])
    // one sub-project more and the same question answers
    Object.assign(OWN_READS, { subProjects: 2 })
    await t.run(async (ctx) => {
      expect(await projectLevelsOf(ctx, me).level(f.meta.id)).toBe('viewer')
    })
  })
})

describe('projectLevelsOf at Convex limits', () => {
  it('answers the shares on a project shared with 2,000 teams from the person own team shares, team by team, or refuses', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const wide = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const teams: string[] = []
    for (let at = 0; at < 2_000; at += 500)
      await t.run(async (ctx) => {
        for (let i = at; i < at + 500; i++) {
          const team_id = await newTeam(ctx, f.org.id)
          teams.push(team_id)
          await ctx.db.insert('project_team_access', {
            project_id: wide.id,
            team_id,
            level: i === 0 ? 'user' : 'viewer',
          })
        }
      })
    // the shares of their teams elsewhere, past OWN_READS.rows for the
    // people in 60 and 300 teams
    const elsewhere = await t.run((ctx) => plantFamily(ctx, f.org.id, 'Elsewhere', 20))
    const person = async (n: number) => {
      const me = await plantSeat(t, { org_id: f.org.id, name: `In ${n}` })
      for (let at = 0; at < n; at += 50)
        await t.run(async (ctx) => {
          for (const team_id of teams.slice(at, Math.min(n, at + 50))) {
            await ctx.db.insert('team_members', { team_id, profile_id: me.id, is_leader: false })
            if (n > 1)
              for (const sub of elsewhere.subs)
                await ctx.db.insert('project_team_access', {
                  project_id: sub.id,
                  team_id,
                  level: 'viewer',
                })
          }
        })
      return me
    }
    // without reach rows, whose writes for 9,000 shares would take minutes
    // here: past projectShares the person's teams are asked one by one
    // while they are at most OWN_READS.lookups, as reach rows would narrow
    // them to the 60 that hold a root row on TBED
    const one = await person(1)
    const sixty = await person(60)
    const many = await person(300)
    for (const [me, expected] of [
      [one, 'user'],
      [sixty, 'user'],
      [many, 'refused'],
    ] as const) {
      const got = await t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        const level = await levelOrRefused(levels, wide.id, false)
        return { level, reads: await readsOf(ctx) }
      })
      expect(got.level, me.name).toBe(expected)
      if (expected !== 'refused')
        expect(got.level).toBe(await t.run((ctx) => projectLevel(ctx, me, wide, false)))
      console.info(`2,000 shares, ${me.name}: ${JSON.stringify(got.reads)}`)
    }
  }, 240_000)
})

/* The finding of Astra's review of t3/limits-project-access-reads: a
 * person in 20 teams, each shared on the same 1,600 sub-projects under 16
 * metas (32,000 shares), who holds no source on the metas, so each shows
 * them only for navigation; and a meta with a few sub-projects they hold no
 * source under. Planted within Convex's write limits, with the reach rows
 * planReach writes inserted directly, as withReach would plan 32,000
 * sources one by one; a sample is checked against planReach. A legacy task
 * stored on the first meta, with a message to the person, makes the task
 * window, Search and the inbox ask about the meta with navigation. */
async function plantFinding(t: T) {
  const f = await withOrg(t)
  const me = await plantLogin(
    t,
    await plantSeat(t, { org_id: f.org.id, name: 'Many teams', email: 'many@testbed.test' }),
  )
  const families: { meta: Doc<'projects'>; subs: Doc<'projects'>[] }[] = []
  for (let m = 0; m < 16; m++)
    families.push(await t.run((ctx) => plantFamily(ctx, f.org.id, `Shared ${m}`, 100)))
  const other = await t.run((ctx) => plantFamily(ctx, f.org.id, 'Other', 5))
  const teams = await t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const team_id = await newTeam(ctx, f.org.id)
      await ctx.db.insert('team_members', { team_id, profile_id: me.id, is_leader: false })
      ids.push(team_id)
    }
    return ids
  })
  for (const team_id of teams)
    await t.run(async (ctx) => {
      for (const family of families)
        for (const sub of family.subs)
          await ctx.db.insert('project_team_access', {
            project_id: sub.id,
            team_id,
            level: 'user',
          })
    })
  for (const team_id of teams)
    await t.run(async (ctx) => {
      for (const family of families) await plantTeamReach(ctx, team_id, family.meta, family.subs)
    })
  // the planted rows are those planReach calls for
  await t.run(async (ctx) => {
    for (const team_id of [teams[0], teams[19]])
      for (const p of [families[0].meta, families[0].subs[0], families[15].subs[99]])
        expect(await planReach(ctx, { grantee_kind: 'team', grantee_id: team_id }, p.id)).toEqual(
          [],
        )
  })
  const task = await plantIssue(t, {
    org_id: f.org.id,
    project_id: families[0].meta.id,
    title: 'Legacy meta task',
  })
  await t.run((ctx) =>
    postMessage(ctx, {
      org_id: f.org.id,
      recipient_id: me.id,
      issue_id: task.id,
      kind: 'change',
      body: 'Update',
      actor_id: f.admin.id,
      now: NOW,
    }),
  )
  await t.run((ctx) =>
    ctx.db.insert('org_ready', { org_id: f.org.id, nav_at: NOW, name_keys_at: NOW }),
  )
  return { f, me, families, other, teams, task }
}

describe("the finding at Convex's real limits", () => {
  const t = newT({ transactionLimits: true })
  let planted: ReturnType<typeof plantFinding> | undefined
  const finding = () => (planted ??= plantFinding(t))

  /* runs `read` with the organization's reach rows marked incomplete */
  async function withoutNav<R>(read: () => Promise<R>): Promise<R> {
    const { f } = await finding()
    const flip = (nav_at: string | undefined) =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query('org_ready')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        await ctx.db.patch(row!._id, { nav_at })
      })
    await flip(undefined)
    try {
      return await read()
    } finally {
      await flip(NOW)
    }
  }

  it('shows each of the 16 metas for navigation and not the other, from reach rows, reading a few hundred documents', async () => {
    const { me, families, other } = await finding()
    const got = await t.run(async (ctx) => {
      const access = accessOf(ctx, me)
      const shown = await Promise.all(families.map((family) => access.visible(family.meta.id)))
      const hidden = await access.visible(other.meta.id)
      return { shown, hidden, shared: { ...access.shared }, reads: await readsOf(ctx) }
    })
    expect(got.shown).toEqual(families.map(() => true))
    expect(got.hidden).toBe(false)
    console.info(`finding, reach path: ${JSON.stringify(got)}`)
    expect(got.reads.documents).toBeLessThan(2_000)
    // the readiness row, 20 memberships, 320 root rows and the
    // organization's 21 teams, read once for the teams the sub-projects'
    // checks ask about
    expect(got.shared.documents).toBe(1 + 20 + 320 + 21)
  }, 600_000)

  it('refuses those questions inside the limits without nav_at, never with a Convex error', async () => {
    const { me, families } = await finding()
    const got = await withoutNav(() =>
      t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        const answers = await Promise.all(
          families.map((family) => levelOrRefused(levels, family.meta.id)),
        )
        return { answers, reads: await readsOf(ctx) }
      }),
    )
    expect(got.answers).toEqual(families.map(() => 'refused'))
    console.info(`finding, legacy path: ${JSON.stringify(got.reads)}`)
    expect(got.reads.documents).toBeLessThan(2_000)
  }, 600_000)

  it("answers every caller's read of the person within the limits", async () => {
    const { f, me, families, other, task } = await finding()
    // the projects part of each window that holds a meta, among 64, cut
    // where it asks; every window holds sub-projects shared with 20 teams
    const shown = new Set<string>()
    const metas = [...families.map((family) => family.meta), other.meta]
    const windows: IdWindow[] = idWindows(64).filter((w) =>
      metas.some((meta) => inIdWindow(meta.window_key!, w)),
    )
    while (windows.length > 0) {
      const w = windows.shift()!
      const part = await t.run((ctx) => readProjects(ctx, me, w))
      expect(part.state, JSON.stringify(w)).not.toBe('refused')
      if (part.state === 'overflow') windows.push(...halve(w)!)
      else if (part.state === 'ok') for (const p of part.projects) shown.add(p.id)
    }
    for (const family of families) expect(shown.has(family.meta.id)).toBe(true)
    expect(shown.has(other.meta.id)).toBe(false)
    // the task window, Search scoped to the meta, the inbox
    const caller = as(t, me)
    expect(
      (await caller.query(api.taskWindow.task, { org_id: f.org.id, ref: task.id })).state,
    ).toBe('ok')
    const search = await t.run((ctx) =>
      mainSearchPage(ctx, new Map([[f.org.id, me]]), {
        text: 'legacy',
        include_archived: false,
        scope: { org_id: f.org.id, project_id: families[0].meta.id },
      }),
    )
    // a scope of 101 projects is searched whole, past MAIN_SEARCH.projects,
    // which no access check stopped
    expect(search.coverage).toMatchObject({ complete: false, stopped: 'projects' })
    expect(search.rows.map((row) => row.id)).toEqual([task.id])
    const summary = await caller.query(api.inbox.summary, {})
    expect([summary.unread_count, summary.complete]).toEqual([1, true])
    const item = await caller.query(api.inbox.item, { org_id: f.org.id, issue_id: task.id })
    expect(item.state === 'ok' && item.item?.unread_count).toBe(1)
    // the meta's settings, and the lead picker of a new sub-project, which
    // a navigation-only viewer may not create
    const settings = await caller.query(api.projectSettings.get, { id: families[0].meta.id })
    expect(settings.state === 'ok' && settings.level).toBe('viewer')
    const leads = await caller.query(api.projectSettings.leadCandidates, {
      org_id: f.org.id,
      parent_id: families[0].meta.id,
    })
    expect(leads.state).toBe('refused')
  }, 600_000)

  it('stays inside the limits for 64 projects each shared with projectShares + 1 teams, asked at once', async () => {
    const { f, me, families } = await finding()
    // under a meta the person's teams reach, shared with teams of others
    const subs = await t.run(async (ctx) => {
      const out: Doc<'projects'>[] = []
      const meta = families[0].meta
      for (let n = 0; n < 64; n++) {
        const id = uuid()
        const num = familyNum++
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: meta.id,
          key: `F${num}`,
          name: `Wide ${n}`,
          description: '',
          sort_order: num,
          num,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
        })
        out.push((await byId(ctx, 'projects', id))!)
      }
      return out
    })
    const others = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i <= OWN_READS.projectShares; i++) ids.push(await newTeam(ctx, f.org.id))
      return ids
    })
    await t.run(async (ctx) => {
      for (const team_id of others) {
        for (const sub of subs)
          await ctx.db.insert('project_team_access', { project_id: sub.id, team_id, level: 'user' })
        await plantTeamReach(ctx, team_id, families[0].meta, subs)
      }
    })
    const got = await t.run(async (ctx) => {
      const access = accessOf(ctx, me, subs)
      const answers = await Promise.all(
        subs.map((sub) =>
          access.visible(sub.id).catch((e: unknown) => {
            if (isAccessUnchecked(e)) return 'refused'
            throw e
          }),
        ),
      )
      return { answers, reads: await readsOf(ctx) }
    })
    console.info(
      `64 projects past projectShares: ${JSON.stringify({ refused: got.answers.filter((a) => a === 'refused').length, reads: got.reads })}`,
    )
    // each asks the 20 teams that hold a root row on the meta one by one,
    // so OWN_READS.teamReads holds six of them; none shows, and the rest
    // refuse as having run out of the instance's room
    const answered = Math.floor(OWN_READS.teamReads / 20)
    expect(got.answers.filter((answer) => answer === false)).toHaveLength(answered)
    expect(got.answers.filter((answer) => answer === 'refused')).toHaveLength(64 - answered)
  }, 600_000)
})

/* The reach rows of team `teamId` for a share on sub-project `sub` of `top`:
 * a child row on `sub` and a root row on `top`, as planReach writes them. */
async function plantShareReach(
  ctx: MutationCtx,
  teamId: string,
  top: Doc<'projects'>,
  sub: Doc<'projects'>,
) {
  const row = (p: Doc<'projects'>, kind: 'root' | 'child') => ({
    org_id: p.org_id,
    grantee_kind: 'team' as const,
    grantee_id: teamId,
    kind,
    project_id: p.id,
    root_id: top.id,
    name_key: nameKey(p.name),
    key: p.key,
    live: true,
    on_root: false,
  })
  await ctx.db.insert('project_reach', row(top, 'root'))
  await ctx.db.insert('project_reach', row(sub, 'child'))
}

/* `n` share rows of team `teamId` on projects that do not exist, which fill
 * its shares past OWN_READS.rows without changing any level. */
async function plantShares(ctx: MutationCtx, teamId: string, n: number) {
  for (let i = 0; i < n; i++)
    await ctx.db.insert('project_team_access', {
      project_id: uuid(),
      team_id: teamId,
      level: 'viewer',
    })
}

describe('projectLevelsOf past its bounds of own rows', () => {
  it('shows a parent for navigation past OWN_READS.roots root rows, where the legacy path would refuse their shares', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
      await plantShareReach(ctx, f.team.id, f.meta, f.sub)
      // the team's sources on as many other top-level projects as the reach
      // path reads root rows, past OWN_READS.rows shares in all
      for (let i = 0; i < OWN_READS.roots; i++) {
        const project_id = uuid()
        await ctx.db.insert('project_team_access', {
          project_id,
          team_id: f.team.id,
          level: 'user',
        })
        await ctx.db.insert('project_reach', {
          org_id: f.org.id,
          grantee_kind: 'team',
          grantee_id: f.team.id,
          kind: 'root',
          project_id,
          root_id: project_id,
          name_key: `elsewhere ${i}`,
          key: `E${i}`,
          live: true,
          on_root: true,
        })
      }
      await ctx.db.insert('org_ready', { org_id: f.org.id, nav_at: NOW, name_keys_at: NOW })
    })
    const got = await t.run(async (ctx) => {
      const levels = projectLevelsOf(ctx, me)
      const answers = [
        await levelOrRefused(levels, f.meta.id),
        await levelOrRefused(levels, f.hidden.id),
        await levelOrRefused(levels, f.sub.id),
      ]
      return { answers, reads: await readsOf(ctx) }
    })
    expect(got.answers).toEqual(['viewer', null, 'user'])
    console.info(`past roots: ${JSON.stringify(got.reads)}`)
    expect((await t.run((ctx) => readProjects(ctx, me, { from: '', to: null }))).state).toBe('ok')
  }, 240_000)

  it('shows a parent from reach rows for a person in 100 teams whose teams hold more than OWN_READS.rows shares, which the legacy path refuses', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
      await plantShareReach(ctx, f.team.id, f.meta, f.sub)
      for (let i = 1; i < 100; i++) {
        const team_id = await newTeam(ctx, f.org.id)
        await ctx.db.insert('team_members', { team_id, profile_id: me.id, is_leader: false })
        await plantShares(ctx, team_id, 11)
      }
    })
    expect(OWN_READS.navTeams).toBeGreaterThanOrEqual(100)
    const ask = () =>
      t.run(async (ctx) => {
        const levels = projectLevelsOf(ctx, me)
        return [await levelOrRefused(levels, f.meta.id), await levelOrRefused(levels, f.hidden.id)]
      })
    // without nav_at the legacy path reads their 1,090 shares and refuses
    expect(await ask()).toEqual(['refused', 'refused'])
    await stampNav(t, f.org.id)
    expect(await ask()).toEqual(['viewer', null])
  }, 240_000)

  it('shows a sub-project from the level it inherits where its own check refuses, and level() refuses', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      for (let i = 0; i <= OWN_READS.projectShares; i++)
        await ctx.db.insert('project_team_access', {
          project_id: f.sub.id,
          team_id: i === 0 ? f.team.id : uuid(),
          level: 'user',
        })
      await plantShares(ctx, f.team.id, OWN_READS.rows)
    })
    // FW's team may not be asked by itself, so its own check refuses
    Object.assign(OWN_READS, { teamReads: 0 })
    const answers = (grant: boolean) =>
      t.run(async (ctx) => {
        const access = accessOf(ctx, me)
        const settle = (p: Promise<unknown>) =>
          p.catch((e: unknown) => (isAccessUnchecked(e) ? 'refused' : Promise.reject(e)))
        return {
          grant,
          visible: await settle(access.visible(f.sub.id)),
          accessible: await settle(access.accessible(f.sub.id)),
          holds: await settle(access.holds(task)),
          level: await settle(access.level(f.sub.id)),
        }
      })
    expect(await answers(false)).toEqual({
      grant: false,
      visible: 'refused',
      accessible: 'refused',
      holds: 'refused',
      level: 'refused',
    })
    // a viewer grant on TBED, which FW inherits
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: me.id,
        level: 'viewer',
      }),
    )
    expect(await answers(true)).toEqual({
      grant: true,
      visible: true,
      accessible: true,
      holds: true,
      level: 'refused',
    })
  })
})

describe('a workspace batch at the name caps', () => {
  it("reads a batch of parents seen only through a team's sub-project, each shared with 64 teams named at the caps, inside Convex's limits", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    const wide = 'ﷺ'.repeat(NAME_MAX)
    const families: { meta: Doc<'projects'>; subs: Doc<'projects'>[] }[] = []
    for (let n = 0; n < 64; n++)
      families.push(await t.run((ctx) => plantFamily(ctx, f.org.id, 'Capped', 1)))
    const teams = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 64; i++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: wide,
          name_key: nameKey(wide),
          track_delay_default: false,
          created_at: NOW,
        })
        ids.push(id)
      }
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      return ids
    })
    for (const { meta, subs } of families)
      await t.run(async (ctx) => {
        for (const p of [meta, subs[0]])
          for (const team_id of teams)
            await ctx.db.insert('project_team_access', {
              project_id: p.id,
              team_id,
              level: 'user',
              name_key: nameKey(wide),
            })
        await ctx.db.insert('project_team_access', {
          project_id: subs[0].id,
          team_id: f.team.id,
          level: 'user',
        })
        await plantShareReach(ctx, f.team.id, meta, subs[0])
      })
    await t.run((ctx) =>
      ctx.db.insert('org_ready', { org_id: f.org.id, nav_at: NOW, name_keys_at: NOW }),
    )
    // the parents only, as one batch of the projects part asks them
    const got = await t.run(async (ctx) => {
      const access = accessOf(
        ctx,
        me,
        families.map((family) => family.meta),
      )
      const shown = await Promise.all(families.map((family) => access.visible(family.meta.id)))
      return { shown, reads: await readsOf(ctx) }
    })
    expect(got.shown).toEqual(families.map(() => true))
    console.info(`batch of 64 parents at the name caps: ${JSON.stringify(got.reads)}`)
    // the parents' own 4,096 team shares with their name keys take about
    // 5.7 MB, as before these bounds; navigation adds one share read a
    // parent, where checking each child's level read the child's 64 shares
    // again and doubled it
    expect(got.reads.bytes).toBeLessThan(7 * 1024 * 1024)
  }, 600_000)
})

