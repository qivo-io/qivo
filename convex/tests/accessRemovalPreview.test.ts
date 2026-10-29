/* The access removal preview (accessRemovals.preview,
 * model/removalPreview.ts) against the writes it previews. For each
 * scenario the preview is read, then the write runs in the same state:
 * 'leave' must strand exactly the holdings the preview lists,
 * 'keep_as_viewer' must give Viewer grants on exactly its Keep targets or
 * refuse with its sentence, and a handover to someone who can take every
 * task must change exactly those holdings or refuse with its sentence. Each
 * choice runs in its own convex-test instance, so the cases stay
 * independent. After a write that went through, the preview finds nothing
 * left to remove, except the Viewer grant of a person kept as Viewer on the
 * project whose grant went. */
/// <reference types="vite/client" />

import { ConvexError, getConvexSize } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as access from '../lib/access'
import { ACCESS_NEEDS_A_PERSON } from '../lib/access'
import { byId } from '../lib/db'
import type { GrantLevel } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { ASSIGNEE_RULE, NO_WRITE_ACCESS } from '../model/issues'
import { LAST_TEAM_RULE } from '../model/orgs'
import {
  type AccessRemoval,
  HELD_TASKS_REFUSED,
  type HeldTasks,
  type Holding,
  LEAD_ACCESS_RULE,
  NO_USER_MANAGEMENT,
  REASSIGN_ROOM,
  REMOVAL_FULL,
  reassignTooLarge,
  removeProjectGrantCore,
  VIEWER_NOT_KEPT,
} from '../model/projectAccess'
import {
  PREVIEW,
  previewRemoval,
  type RemovalChange,
  type RemovalPreview,
} from '../model/removalPreview'
import { deleteTeamCore, removeTeamMemberCore, TEAM_RUNS_RULE } from '../model/teams'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { manyHolders } from './holders.setup'
import { northstarId, plantNorthstar } from './northstar.setup'

type Ok = Extract<RemovalPreview, { state: 'ok' }>

const preview = (t: T, caller: Doc<'profiles'>, change: RemovalChange) =>
  as(t, caller).query(api.accessRemovals.preview, { org_id: caller.org_id, change })

async function previewOk(t: T, caller: Doc<'profiles'>, change: RemovalChange): Promise<Ok> {
  const answer = await preview(t, caller, change)
  if (answer.state !== 'ok') throw new Error(`expected an answer, got ${JSON.stringify(answer)}`)
  return answer
}

/* What a write did: what it settled (null for a team deletion, which
 * answers nothing), or the sentence it refused with. */
type Outcome = { ok: AccessRemoval | null } | { refused: string }

/* The write `change` names, run as `me` with `held` through its core, in
 * one transaction. */
async function write(
  t: T,
  me: Doc<'profiles'>,
  change: RemovalChange,
  held: HeldTasks,
): Promise<Outcome> {
  try {
    const ok = await t.run(async (ctx) => {
      const must = <R>(row: R | null): R => {
        if (row === null) throw new Error('the scenario names a row that does not exist')
        return row
      }
      if (change.kind === 'user_grant' || change.kind === 'team_grant') {
        return await removeProjectGrantCore(ctx, {
          me,
          project: must(await byId(ctx, 'projects', change.project_id)),
          subject:
            change.kind === 'user_grant'
              ? { profile: must(await byId(ctx, 'profiles', change.user_id)) }
              : { team: must(await byId(ctx, 'teams', change.team_id)) },
          held,
          now: NOW,
        })
      }
      const team = must(await byId(ctx, 'teams', change.team_id))
      if (change.kind === 'team_member')
        return await removeTeamMemberCore(ctx, {
          me,
          team,
          profileId: change.user_id,
          held,
          now: NOW,
        })
      await deleteTeamCore(ctx, { me, team, held, now: NOW })
      return null
    })
    return { ok }
  } catch (e) {
    if (e instanceof ConvexError) return { refused: (e.data as Refusal).message }
    throw e
  }
}

/* A holding as "task role holder", the form both sides compare in. */
const holding = (h: { task_id: string; role: string; holder_id: string }) =>
  `${h.task_id} ${h.role} ${h.holder_id}`
const listed = (p: Ok) => p.items.map(holding).sort()
const settled = (hs: readonly Holding[]) =>
  hs.map((h) => holding({ task_id: h.task.id, role: h.role, holder_id: h.profile_id })).sort()

/* Every task's assignee and reviewer in the organization, by task id. */
const holdersOf = async (t: T, orgId: string) =>
  new Map(
    await t.run(async (ctx) =>
      (await ctx.db.query('issues').collect())
        .filter((task) => task.org_id === orgId)
        .map((task) => [
          task.id,
          { assignee: task.assignee_id ?? null, reviewer: task.reviewer_id ?? null },
        ]),
    ),
  )

/* The Viewer grants of the organization's people, as [project, profile]. */
const viewerGrants = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('project_access').collect())
      .filter((g) => g.level === 'viewer')
      .map((g) => `${g.project_id} ${g.profile_id}`),
  )

/* A scenario: who previews and then writes which change, and an
 * organization admin who can take over any task. `gone` is what the
 * preview answers once the write went through, when that is not the usual
 * (afterWrite). */
type Scenario = {
  t: T
  orgId: string
  caller: Doc<'profiles'>
  change: RemovalChange
  taker: Doc<'profiles'>
  gone?: Partial<RemovalPreview>
}

/* What the preview must answer once the write went through. */
const afterWrite = (s: Scenario) =>
  s.gone ??
  (s.change.kind === 'delete_team' ? { state: 'unavailable' } : { state: 'ok', pending: false })

/* What the preview must answer once a 'keep_as_viewer' write went through:
 * a person kept as Viewer on the project whose grant went holds that Viewer
 * grant now, which cannot be kept as Viewer again. */
const afterKeep = (s: Scenario, p: Ok) =>
  s.change.kind === 'user_grant' && p.people.length > 0
    ? { state: 'ok', pending: true, keep: { allowed: false, refusal: VIEWER_NOT_KEPT } }
    : afterWrite(s)

/**
 * Checks the preview of the scenario `build` plants against each of the
 * three writes, each in a fresh build, and answers the first build with its
 * preview. The caller of every scenario here sees every project the change
 * reaches, as every caller the writes accept does until the admin access
 * split, so the preview lists every holding.
 */
async function expectParity<S extends Scenario>(build: () => Promise<S>): Promise<{ s: S; p: Ok }> {
  const s = await build()
  const p = await previewOk(s.t, s.caller, s.change)
  expect(p.pending).toBe(true)
  expect(p.hidden).toBe(0)
  expect(p.items_total).toBe(p.items.length)
  expect(p.tasks).toBe(new Set(p.items.map((i) => i.task_id)).size)
  expect(p.people.map((x) => x.id).sort()).toEqual(
    [...new Set(p.items.map((i) => i.holder_id))].sort(),
  )
  const left = await write(s.t, s.caller, s.change, 'leave')
  if (!('ok' in left)) throw new Error(`leaving the tasks was refused: ${left.refused}`)
  if (left.ok !== null) {
    expect(left.ok.removed).toBe(true)
    expect(listed(p)).toEqual(settled(left.ok.stranded))
  }
  expect(await preview(s.t, s.caller, s.change)).toMatchObject(afterWrite(s))

  const k = await build()
  const kp = await previewOk(k.t, k.caller, k.change)
  const grants = new Set(await viewerGrants(k.t))
  const kept = await write(k.t, k.caller, k.change, 'keep_as_viewer')
  if (kp.keep.allowed) {
    if (!('ok' in kept)) throw new Error(`keeping them as Viewers was refused: ${kept.refused}`)
    const added = (await viewerGrants(k.t)).filter((g) => !grants.has(g)).map((g) => g.split(' '))
    expect(new Set(added.map(([project]) => project))).toEqual(new Set(kp.keep.targets))
    expect(new Set(added.map(([, profile]) => profile))).toEqual(
      new Set(kp.people.map((x) => x.id)),
    )
    if (kept.ok !== null)
      expect(kept.ok.kept_as_viewer.sort()).toEqual(kp.people.map((x) => x.id).sort())
    expect(await preview(k.t, k.caller, k.change)).toMatchObject(afterKeep(k, kp))
  } else expect(kept).toEqual({ refused: kp.keep.refusal })

  const r = await build()
  const rp = await previewOk(r.t, r.caller, r.change)
  const before = await holdersOf(r.t, r.orgId)
  const handed = await write(r.t, r.caller, r.change, { reassign_to: r.taker.id })
  if (rp.reassign.allowed) {
    if (!('ok' in handed)) throw new Error(`the handover was refused: ${handed.refused}`)
    const changed: string[] = []
    for (const [id, now] of await holdersOf(r.t, r.orgId)) {
      const was = before.get(id)
      for (const role of ['assignee', 'reviewer'] as const) {
        const holder = was?.[role]
        if (holder && now[role] === r.taker.id && holder !== r.taker.id)
          changed.push(holding({ task_id: id, role, holder_id: holder }))
      }
    }
    expect(changed.sort()).toEqual(listed(rp))
    expect(await preview(r.t, r.caller, r.change)).toMatchObject(afterWrite(r))
  } else expect(handed).toEqual({ refused: rp.reassign.refusal })
  return { s, p }
}

/* withOrg with Taker, an organization admin who can take over any task, and
 * helpers that plant people, grants, team shares, memberships and tasks. */
async function base(t: T = newT()) {
  const f = await withOrg(t)
  const taker = await plantSeat(t, { org_id: f.org.id, name: 'Taker', org_role: 'admin' })
  const person = (name: string, extra: Partial<Doc<'profiles'>> = {}) =>
    plantSeat(t, { org_id: f.org.id, name, accepted_at: NOW, auth_user_id: uuid(), ...extra })
  const grant = (project: Doc<'projects'>, who: Doc<'profiles'>, level: GrantLevel = 'user') =>
    t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: project.id, profile_id: who.id, level }),
    )
  const share = (project: Doc<'projects'>, teamId: string, level: GrantLevel = 'user') =>
    t.run((ctx) =>
      ctx.db.insert('project_team_access', { project_id: project.id, team_id: teamId, level }),
    )
  const join = (teamId: string, who: Doc<'profiles'>, is_leader = false) =>
    t.run((ctx) =>
      ctx.db.insert('team_members', { team_id: teamId, profile_id: who.id, is_leader }),
    )
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: f.org.id, project_id: project.id, ...fields })
  const team = async (name: string) => {
    const id = uuid()
    await t.run((ctx) =>
      ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name,
        track_delay_default: false,
        created_at: NOW,
      }),
    )
    return id
  }
  /* A new top-level project led by the organization admin, with one
   * sub-project. */
  const elsewhere = async () => {
    const meta = await plantProject(t, { org_id: f.org.id, name: 'Elsewhere', lead_id: f.admin.id })
    const sub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: meta.id,
      name: 'Elsewhere sub',
    })
    return { meta, sub }
  }
  return { t, f, orgId: f.org.id, taker, person, grant, share, join, task, team, elsewhere }
}

const names = (p: Ok) => p.people.map((x) => x.name)
/* The keys of the projects with these ids, as the answer names them. */
const keys = (p: Ok, ids: readonly string[]) =>
  ids.map((id) => p.projects.find((x) => x.id === id)?.key)
const titles = (p: Ok) => p.items.map((i) => i.title)

describe('the removal preview and the write it previews', () => {
  // the parity checks compare every holding, so none is cut off
  beforeEach(() => {
    PREVIEW.items = 10_000
  })
  afterEach(() => {
    PREVIEW.items = 100
  })

  it("previews a person's grant on a top-level project", async () => {
    const { s, p } = await expectParity(async () => {
      const b = await base()
      const pia = await b.person('Pia')
      await b.grant(b.f.meta, pia)
      // her own grant on Board rev keeps its tasks in sight
      await b.grant(b.f.sub2, pia)
      await b.task(b.f.sub, { title: 'Assigned in Firmware', assignee_id: pia.id })
      await b.task(b.f.sub, {
        title: 'Reviewed in Firmware',
        status: 'review',
        assignee_id: b.f.user.id,
        reviewer_id: pia.id,
      })
      await b.task(b.f.sub2, { title: 'Assigned in Board rev', assignee_id: pia.id })
      return {
        ...b,
        caller: b.f.admin,
        change: { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const,
        pia,
      }
    })
    expect(names(p)).toEqual(['Pia'])
    expect(titles(p)).toEqual(['Assigned in Firmware', 'Reviewed in Firmware'])
    expect(p.items.map((i) => i.role)).toEqual(['assignee', 'reviewer'])
    expect(p.tasks).toBe(2)
    expect(p.keep).toEqual({
      targets: [s.f.meta.id],
      // she can still change Board rev, as the window's Keep text says
      changers: [{ id: s.pia.id, projects: [s.f.sub2.id], more: 0 }],
      allowed: true,
      refusal: null,
    })
    // each project the answer names, once, in the app's order
    expect(p.projects).toEqual([
      { id: s.f.meta.id, name: s.f.meta.name, key: s.f.meta.key, parent_id: null },
      { id: s.f.sub2.id, name: s.f.sub2.name, key: s.f.sub2.key, parent_id: s.f.meta.id },
    ])
    expect(p.reassign).toEqual({ allowed: true, refusal: null })
    expect(p.leave_only).toBe(false)
  })

  it("previews a person's grant on a sub-project, who keeps the parent through navigation only", async () => {
    const { s, p } = await expectParity(async () => {
      const b = await base()
      const pia = await b.person('Pia')
      await b.grant(b.f.sub, pia)
      await b.grant(b.f.sub2, pia)
      await b.task(b.f.sub, { title: 'In Firmware', assignee_id: pia.id })
      await b.task(b.f.sub2, { title: 'In Board rev', assignee_id: pia.id })
      return {
        ...b,
        // the parent's lead manages its sub-projects' users
        caller: b.f.user,
        change: { kind: 'user_grant', project_id: b.f.sub.id, user_id: pia.id } as const,
      }
    })
    expect(titles(p)).toEqual(['In Firmware'])
    expect(p.keep.targets).toEqual([s.f.sub.id])
    expect(p.keep.changers).toEqual([])
    expect(p.keep.allowed).toBe(true)
  })

  it("previews a team's share on a top-level project, leaving out who keeps sight another way", async () => {
    const { p } = await expectParity(async () => {
      const b = await base()
      const second = await b.team('Second')
      await b.share(b.f.meta, b.f.team.id)
      await b.share(b.f.meta, second, 'viewer')
      const mia = await b.person('Mia')
      const noah = await b.person('Noah')
      const olga = await b.person('Olga')
      const ivy = await b.person('Ivy', { active: false })
      for (const m of [mia, noah, olga, ivy]) await b.join(b.f.team.id, m)
      // Noah has a grant of his own, Olga a second team
      await b.grant(b.f.meta, noah)
      await b.join(second, olga)
      for (const m of [mia, noah, olga, ivy])
        await b.task(b.f.sub, { title: `${m.name}'s task`, assignee_id: m.id })
      // the lead of TBED, a member of the team, keeps it through the lead
      await b.task(b.f.sub2, { title: "The lead's task", assignee_id: b.f.user.id })
      return {
        ...b,
        caller: b.f.admin,
        change: { kind: 'team_grant', project_id: b.f.meta.id, team_id: b.f.team.id } as const,
      }
    })
    expect(names(p)).toEqual(['Mia'])
    expect(titles(p)).toEqual(["Mia's task"])
  })

  it("previews a team's share on a sub-project, leaving out who keeps it through the parent", async () => {
    const { s, p } = await expectParity(async () => {
      const b = await base()
      await b.share(b.f.sub, b.f.team.id)
      const mia = await b.person('Mia')
      const pete = await b.person('Pete')
      for (const m of [mia, pete]) await b.join(b.f.team.id, m)
      await b.grant(b.f.meta, pete)
      for (const m of [mia, pete])
        await b.task(b.f.sub, { title: `${m.name}'s task`, assignee_id: m.id })
      return {
        ...b,
        caller: b.f.user,
        change: { kind: 'team_grant', project_id: b.f.sub.id, team_id: b.f.team.id } as const,
      }
    })
    expect(names(p)).toEqual(['Mia'])
    expect(p.keep.targets).toEqual([s.f.sub.id])
  })

  /* Hardware shares TBED; Mia, a member, holds open tasks in Firmware and
   * Board rev beside tasks no removal settles. */
  const memberScenario = async (caller: (f: OrgFixture) => Doc<'profiles'>) => {
    const b = await base()
    await b.share(b.f.meta, b.f.team.id)
    const mia = await b.person('Mia')
    await b.join(b.f.team.id, mia)
    await b.task(b.f.sub, { title: 'Firmware work', assignee_id: mia.id })
    await b.task(b.f.sub2, {
      title: 'Board review',
      status: 'review',
      assignee_id: b.f.user.id,
      reviewer_id: mia.id,
    })
    await b.task(b.f.sub, { title: 'Done work', status: 'done', assignee_id: mia.id })
    await b.task(b.f.sub, { title: 'Archived work', assignee_id: mia.id, archived_at: NOW })
    // a group's reviewer is dormant while it has an active subtask
    const group = await b.task(b.f.sub, {
      title: 'Group review',
      status: 'review',
      assignee_id: b.f.user.id,
      reviewer_id: mia.id,
    })
    await b.task(b.f.sub, { title: 'Subtask', parent_id: group.id, assignee_id: b.f.user.id })
    const archived = await plantProject(b.t, {
      org_id: b.f.org.id,
      type: 'project',
      parent_id: b.f.meta.id,
      archived_at: NOW,
    })
    await b.task(archived, { title: 'Work in an archived sub-project', assignee_id: mia.id })
    return {
      ...b,
      caller: caller(b.f),
      change: { kind: 'team_member', team_id: b.f.team.id, user_id: mia.id } as const,
      mia,
    }
  }

  it('previews a member leaving a team, without done, archived or dormant work', async () => {
    const { s, p } = await expectParity(() => memberScenario((f) => f.user))
    expect(names(p)).toEqual(['Mia'])
    expect(titles(p)).toEqual(['Firmware work', 'Board review'])
    // the team shared the parent, so the Viewer grant goes there
    expect(p.keep.targets).toEqual([s.f.meta.id])
    expect(p.keep.allowed).toBe(true)
    expect(p.reassign.allowed).toBe(true)
  })

  it('shows an organization admin every title, as every admin sees every project today', async () => {
    const { p } = await expectParity(() => memberScenario((f) => f.admin))
    expect(titles(p)).toEqual(['Firmware work', 'Board review'])
    // the admin access split leaves an admin without ordinary access to
    // TBED only the count: hidden 2 and no items
    expect(p.hidden).toBe(0)
  })

  it('previews a team deletion', async () => {
    const { s, p } = await expectParity(async () => {
      const b = await base()
      await b.team('Second')
      await b.share(b.f.meta, b.f.team.id)
      await b.share(b.f.hidden, b.f.team.id, 'viewer')
      const mia = await b.person('Mia')
      const sam = await b.person('Sam')
      for (const m of [mia, sam]) await b.join(b.f.team.id, m)
      await b.task(b.f.sub, { title: "Mia's task", assignee_id: mia.id })
      await b.task(b.f.hidden, { title: "Sam's task", assignee_id: sam.id })
      return {
        ...b,
        caller: b.f.admin,
        change: { kind: 'delete_team', team_id: b.f.team.id } as const,
      }
    })
    expect(names(p)).toEqual(['Mia', 'Sam'])
    expect(new Set(p.keep.targets)).toEqual(new Set([s.f.meta.id, s.f.hidden.id]))
  })

  it("follows the write's refusals when a team leader removes a member from projects they cannot manage", async () => {
    const { p } = await expectParity(async () => {
      const b = await base()
      const { meta, sub } = await b.elsewhere()
      await b.share(b.f.meta, b.f.team.id)
      await b.share(meta, b.f.team.id, 'viewer')
      const mia = await b.person('Mia')
      await b.join(b.f.team.id, mia)
      await b.task(b.f.sub, { title: 'In Firmware', assignee_id: mia.id })
      await b.task(sub, { title: 'Elsewhere', assignee_id: mia.id })
      return {
        ...b,
        // leads Hardware and TBED, and sees Elsewhere only through the team
        caller: b.f.user,
        change: { kind: 'team_member', team_id: b.f.team.id, user_id: mia.id } as const,
      }
    })
    expect(titles(p)).toEqual(['In Firmware', 'Elsewhere'])
    expect(p.keep).toMatchObject({ allowed: false, refusal: NO_USER_MANAGEMENT })
    expect(p.reassign).toEqual({ allowed: false, refusal: NO_WRITE_ACCESS })
  })

  /* Lena, a user who leads Hardware, which shares Elsewhere at User, and
   * Mia, a member: each holds a task there. */
  const leaderScenario = async (leaving: 'lena' | 'mia') => {
    const b = await base()
    const { meta, sub } = await b.elsewhere()
    await b.share(meta, b.f.team.id)
    const lena = await b.person('Lena')
    const mia = await b.person('Mia')
    await b.join(b.f.team.id, lena, true)
    await b.join(b.f.team.id, mia)
    await b.task(sub, { title: "Lena's task", assignee_id: lena.id })
    await b.task(sub, { title: "Mia's task", assignee_id: mia.id })
    return {
      ...b,
      caller: lena,
      change: {
        kind: 'team_member',
        team_id: b.f.team.id,
        user_id: (leaving === 'lena' ? lena : mia).id,
      } as const,
      // once she has left, she no longer runs the team
      gone:
        leaving === 'lena' ? ({ state: 'refused', message: TEAM_RUNS_RULE } as const) : undefined,
    }
  }

  it('uses the edit access a leader keeps after removing a member', async () => {
    const { p } = await expectParity(() => leaderScenario('mia'))
    expect(titles(p)).toEqual(["Mia's task"])
    expect(p.reassign).toEqual({ allowed: true, refusal: null })
  })

  it('uses the edit access a leader loses by leaving their own team', async () => {
    const { p } = await expectParity(() => leaderScenario('lena'))
    // she reads it now and could edit it, but not once she has left
    expect(titles(p)).toEqual(["Lena's task"])
    expect(p.reassign).toEqual({ allowed: false, refusal: NO_WRITE_ACCESS })
    expect(p.keep).toMatchObject({ allowed: false, refusal: NO_USER_MANAGEMENT })
  })

  it('answers Reassign for a new holder who can take the tasks, whom the write checks first', async () => {
    // the organization's viewer can hold no work, and the write says so
    // before it finds that Lena cannot edit the task once she has left
    const s = await leaderScenario('lena')
    expect((await previewOk(s.t, s.caller, s.change)).reassign.refusal).toBe(NO_WRITE_ACCESS)
    const e = await expectRefusal(
      as(s.t, s.caller).mutation(api.teams.removeMember, {
        org_id: s.orgId,
        team_id: s.change.team_id,
        profile_id: s.change.user_id,
        on_held_tasks: { reassign_to: s.f.viewer.id },
      }),
      'rule',
    )
    expect(e.data).toMatchObject({ message: ASSIGNEE_RULE, reason: HELD_TASKS_REFUSED })
  })

  it('refuses to keep a person as Viewer whose removed grant was Viewer', async () => {
    const { p } = await expectParity(async () => {
      const b = await base()
      const pia = await b.person('Pia')
      await b.grant(b.f.meta, pia, 'viewer')
      await b.task(b.f.sub, { title: 'Held by a Viewer', assignee_id: pia.id })
      return {
        ...b,
        caller: b.f.admin,
        change: { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const,
      }
    })
    expect(p.keep).toMatchObject({ allowed: false, refusal: VIEWER_NOT_KEPT })
    expect(p.reassign.allowed).toBe(true)
  })

  it(`refuses to reassign more than ${LIMITS.reassign.max} tasks with the write's sentence`, async () => {
    const plant = async (level: GrantLevel) => {
      const b = await base()
      const pia = await b.person('Pia')
      await b.grant(b.f.meta, pia, level)
      await b.t.run(async (ctx) => {
        for (let i = 0; i <= LIMITS.reassign.max; i++)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: b.f.org.id,
            project_id: b.f.sub.id,
            num: 1000 + i,
            title: `Task ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            assignee_id: pia.id,
            created_at: NOW,
            updated_at: NOW,
          })
      })
      return {
        ...b,
        caller: b.f.admin,
        change: { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const,
      }
    }
    const { p } = await expectParity(() => plant('user'))
    expect(p.tasks).toBe(LIMITS.reassign.max + 1)
    expect(p.reassign).toEqual({ allowed: false, refusal: reassignTooLarge(true) })
    // without Keep as Viewer, the sentence does not suggest it
    const viewer = await plant('viewer')
    expect((await previewOk(viewer.t, viewer.caller, viewer.change)).reassign).toEqual({
      allowed: false,
      refusal: reassignTooLarge(false),
    })
  })

  it(`refuses to settle the tasks of ${LIMITS.removalHolders.max + 1} people with the write's sentence, and leaves them`, async () => {
    const { p } = await expectParity(async () => {
      const { t, f } = await manyHolders(LIMITS.removalHolders.max + 1)
      const taker = await plantSeat(t, { org_id: f.org.id, name: 'Taker', org_role: 'admin' })
      return {
        t,
        orgId: f.org.id,
        caller: f.admin,
        taker,
        change: { kind: 'team_grant', project_id: f.meta.id, team_id: f.team.id } as const,
      }
    })
    expect(p.people).toHaveLength(LIMITS.removalHolders.max + 1)
    const capped = { allowed: false, refusal: LIMITS.removalHolders.refusal }
    expect(p.keep).toMatchObject(capped)
    expect(p.reassign).toEqual(capped)
  }, 120_000)

  it('previews nothing to remove once the access is gone', async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.task(b.f.sub, { assignee_id: pia.id })
    const empty = {
      state: 'ok',
      pending: false,
      leave_only: false,
      people: [],
      tasks: 0,
      items: [],
      items_total: 0,
      hidden: 0,
      projects: [],
      keep: { targets: [], changers: [], allowed: true, refusal: null },
      reassign: { allowed: true, refusal: null },
    }
    const changes: RemovalChange[] = [
      { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id },
      { kind: 'team_grant', project_id: b.f.meta.id, team_id: b.f.team.id },
      { kind: 'team_member', team_id: b.f.team.id, user_id: pia.id },
      // removeTeamMemberCore never looks up a person without a membership,
      // so neither someone unknown nor someone of another organization is
      // unavailable here
      { kind: 'team_member', team_id: b.f.team.id, user_id: uuid() },
      { kind: 'team_member', team_id: b.f.team.id, user_id: b.f.otherAdmin.id },
    ]
    for (const change of changes) expect(await preview(b.t, b.f.admin, change)).toEqual(empty)
  })
})

describe('the removal preview on Northstar', () => {
  beforeEach(() => {
    PREVIEW.items = 10_000
  })
  afterEach(() => {
    PREVIEW.items = 100
  })

  /* Northstar with an admin who can take over any task, previewed by Nora. */
  const northstar =
    (change: (id: (key: string) => Promise<string>) => Promise<RemovalChange>) => async () => {
      const t = newT()
      const { org, profiles } = await plantNorthstar(t)
      const nora = profiles.find((p) => p.name === 'Nora Berg')
      if (nora === undefined) throw new Error('Northstar has no Nora')
      const taker = await plantSeat(t, { org_id: org.id, name: 'Taker', org_role: 'admin' })
      return { t, orgId: org.id, caller: nora, taker, change: await change(northstarId) }
    }

  it("previews the Northstar Hardware team's share on Luma Sensor", async () => {
    const { p } = await expectParity(
      northstar(async (id) => ({
        kind: 'team_grant',
        project_id: await id('project:sensor'),
        team_id: await id('team:northstar'),
      })),
    )
    // Leo leads Luma Sensor, Nora is an admin, and Sofia and Atlas keep it
    // through Cloud & Launch's Viewer share; Aisha and Emil keep only the
    // sub-projects they lead
    expect(names(p)).toEqual(['Aisha Rahman', 'Emil Strand'])
    expect(p.tasks).toBe(5)
    expect(keys(p, p.keep.targets)).toEqual(['SENS'])
    expect(p.keep.changers.map((c) => keys(p, c.projects))).toEqual([['FW'], ['MECH', 'MFG']])
  })

  it('previews Leo leaving Northstar Hardware', async () => {
    const { p } = await expectParity(
      northstar(async (id) => ({
        kind: 'team_member',
        team_id: await id('team:northstar'),
        user_id: await id('person:leo'),
      })),
    )
    // every task Leo works on is in Luma Sensor, which he leads
    expect(p.people).toEqual([])
    expect(p.reassign.allowed).toBe(true)
  })

  it('previews deleting Northstar Cloud & Launch', async () => {
    const { p } = await expectParity(
      northstar(async (id) => ({ kind: 'delete_team', team_id: await id('team:cloud-launch') })),
    )
    // Daniel leads Luma Cloud, Ben Pilot & Launch, and Sofia and Atlas keep
    // both through Hardware's Viewer shares; Ben's two open Quality &
    // Release tasks leave his sight
    expect(names(p)).toEqual(['Ben Carter'])
    expect(p.tasks).toBe(2)
    expect(keys(p, p.keep.targets)).toEqual(['CLOUD'])
  })
})

describe('what the removal preview lists', () => {
  it('lists the holdings of at most PREVIEW.items tasks by number, never splitting a task, and counts them all', async () => {
    const b = await base()
    await b.share(b.f.meta, b.f.team.id)
    const mia = await b.person('Mia')
    const noah = await b.person('Noah')
    for (const m of [mia, noah]) await b.join(b.f.team.id, m)
    for (const num of [905, 901, 904, 902, 903])
      await b.task(b.f.sub, {
        num,
        title: `Task ${num}`,
        assignee_id: mia.id,
        // Noah reviews the third task listed, and the one past the cap
        ...(num === 903 || num === 904 ? { status: 'review' as const, reviewer_id: noah.id } : {}),
      })
    const change = { kind: 'team_grant', project_id: b.f.meta.id, team_id: b.f.team.id } as const
    PREVIEW.items = 3
    try {
      const p = await previewOk(b.t, b.f.admin, change)
      // three tasks, the third with both its holdings
      expect(p.items.map((i) => `${i.num} ${i.role}`)).toEqual([
        '901 assignee',
        '902 assignee',
        '903 assignee',
        '903 reviewer',
      ])
      // every holding, and every task once
      expect(p.items_total).toBe(7)
      expect(p.tasks).toBe(5)
    } finally {
      PREVIEW.items = 100
    }
  })

  it('answers too_large rather than an answer past PREVIEW.bytes', async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    await b.task(b.f.sub, { title: 'Held', assignee_id: pia.id })
    const change = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    const size = getConvexSize(await previewOk(b.t, b.f.admin, change))
    PREVIEW.bytes = size - 100
    try {
      expect(await preview(b.t, b.f.admin, change)).toEqual({
        state: 'too_large',
        message: REMOVAL_FULL,
      })
    } finally {
      PREVIEW.bytes = 1024 * 1024
    }
  })

  it('counts the tasks in projects the caller cannot see, without naming them', async () => {
    // Until the admin access split every caller the writes accept sees
    // every project the change reaches. This stands in for the split: the
    // preview reads the admin's own sight as a user's.
    const b = await base()
    // a team the admin is not in
    const second = await b.team('Second')
    await b.share(b.f.meta, second)
    const mia = await b.person('Mia')
    await b.join(second, mia)
    await b.task(b.f.sub, { title: 'Firmware work', assignee_id: mia.id })
    await b.task(b.f.sub2, { title: 'Board work', assignee_id: mia.id })
    const change = { kind: 'team_member', team_id: second, user_id: mia.id } as const
    const real = access.projectLevelsForPeople
    const spy = vi
      .spyOn(access, 'projectLevelsForPeople')
      .mockImplementation((ctx, people, ...rest) =>
        real(
          ctx,
          people.map((p) => (p.id === b.f.admin.id ? { ...p, org_role: 'user' as const } : p)),
          ...rest,
        ),
      )
    try {
      const p = await previewOk(b.t, b.f.admin, change)
      expect(p).toMatchObject({ people: [{ name: 'Mia' }], tasks: 2, items: [], items_total: 0 })
      expect(p.hidden).toBe(2)
      // the admin still manages TBED, so may know its name and keep Mia
      expect(p.keep).toMatchObject({ targets: [b.f.meta.id], allowed: true })
      expect(p.reassign).toEqual({ allowed: false, refusal: NO_WRITE_ACCESS })
    } finally {
      spy.mockRestore()
    }
    const left = await write(b.t, b.f.admin, change, 'leave')
    if (!('ok' in left) || left.ok === null) throw new Error('the removal did not go through')
    expect(new Set(left.ok.stranded.map((h) => h.task.id)).size).toBe(2)
  })
})

describe('what the removal preview refuses', () => {
  it('answers unavailable for unknown and foreign projects, teams and people', async () => {
    const b = await base()
    const foreignTeam = uuid()
    await b.t.run((ctx) =>
      ctx.db.insert('teams', {
        id: foreignTeam,
        org_id: b.f.otherOrg.id,
        name: 'Foreign',
        track_delay_default: false,
        created_at: NOW,
      }),
    )
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    const changes: RemovalChange[] = [
      { kind: 'user_grant', project_id: uuid(), user_id: pia.id },
      { kind: 'user_grant', project_id: b.f.otherProject.id, user_id: pia.id },
      { kind: 'user_grant', project_id: b.f.meta.id, user_id: uuid() },
      { kind: 'user_grant', project_id: b.f.meta.id, user_id: b.f.otherAdmin.id },
      { kind: 'team_grant', project_id: b.f.meta.id, team_id: uuid() },
      { kind: 'team_grant', project_id: b.f.meta.id, team_id: foreignTeam },
      { kind: 'team_grant', project_id: b.f.otherProject.id, team_id: b.f.team.id },
      { kind: 'team_member', team_id: uuid(), user_id: pia.id },
      { kind: 'team_member', team_id: foreignTeam, user_id: pia.id },
      { kind: 'delete_team', team_id: uuid() },
      { kind: 'delete_team', team_id: foreignTeam },
    ]
    for (const change of changes)
      expect(await preview(b.t, b.f.admin, change)).toEqual({ state: 'unavailable' })
  })

  /* The sentence the public write refuses `change` with. */
  const writeRefusal = async (
    t: T,
    caller: Doc<'profiles'>,
    change: RemovalChange,
    held: HeldTasks,
  ) => {
    const run = () => {
      const org_id = caller.org_id
      switch (change.kind) {
        case 'user_grant':
          return as(t, caller).mutation(api.projects.removeAccess, {
            org_id,
            id: change.project_id,
            user_id: change.user_id,
            on_held_tasks: held,
          })
        case 'team_grant':
          return as(t, caller).mutation(api.projects.removeAccess, {
            org_id,
            id: change.project_id,
            team_id: change.team_id,
            on_held_tasks: held,
          })
        case 'team_member':
          return as(t, caller).mutation(api.teams.removeMember, {
            org_id,
            team_id: change.team_id,
            profile_id: change.user_id,
            on_held_tasks: held,
          })
        case 'delete_team':
          return as(t, caller).mutation(api.teams.deleteDeep, {
            org_id,
            id: change.team_id,
            on_held_tasks: held,
          })
      }
    }
    try {
      await run()
    } catch (e) {
      if (e instanceof ConvexError) return (e.data as Refusal).message
      throw e
    }
    throw new Error('the write went through')
  }

  it("refuses with the write's sentence while the organization is read-only, except an admin's removal that leaves the tasks", async () => {
    const b = await base()
    await b.team('Second')
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    await b.task(b.f.sub, { title: 'Held', assignee_id: pia.id })
    await b.t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: b.f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: '2026-02-01T00:00:00.000Z',
        created_at: NOW,
      }),
    )
    const grant = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    const deletion = { kind: 'delete_team', team_id: b.f.team.id } as const
    const member = { kind: 'team_member', team_id: b.f.team.id, user_id: b.f.admin.id } as const
    // a lead who is not an admin, and any team deletion
    for (const [caller, change] of [
      [b.f.user, grant],
      [b.f.user, member],
      [b.f.admin, deletion],
    ] as const) {
      const sentence = await writeRefusal(b.t, caller, change, 'leave')
      expect(await preview(b.t, caller, change)).toEqual({ state: 'refused', message: sentence })
    }
    // an admin may only leave the tasks
    const p = await previewOk(b.t, b.f.admin, grant)
    const sentence = await writeRefusal(b.t, b.f.admin, grant, 'keep_as_viewer')
    expect(await writeRefusal(b.t, b.f.admin, grant, { reassign_to: b.taker.id })).toBe(sentence)
    expect(p).toMatchObject({
      leave_only: true,
      pending: true,
      people: [{ name: 'Pia' }],
      keep: { allowed: false, refusal: sentence },
      reassign: { allowed: false, refusal: sentence },
    })
    const nothing = await previewOk(b.t, b.f.admin, member)
    expect(nothing).toMatchObject({
      leave_only: true,
      keep: { allowed: false, refusal: sentence },
      reassign: { allowed: false, refusal: sentence },
    })
  })

  it("refuses with the write's sentence what the write refuses", async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    const grant = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    const member = { kind: 'team_member', team_id: b.f.team.id, user_id: b.f.admin.id } as const
    const deletion = { kind: 'delete_team', team_id: b.f.team.id } as const
    const cases: [Doc<'profiles'>, RemovalChange, string][] = [
      // the lead's own access, by an admin
      [
        b.f.admin,
        { kind: 'user_grant', project_id: b.f.meta.id, user_id: b.f.user.id },
        LEAD_ACCESS_RULE,
      ],
      // the last team
      [b.f.admin, deletion, LAST_TEAM_RULE],
      // someone who neither leads the project nor runs the team
      [pia, grant, NO_USER_MANAGEMENT],
      [pia, member, TEAM_RUNS_RULE],
      // a team leader who is no admin
      [b.f.user, deletion, 'only organization admins can delete teams'],
    ]
    for (const [caller, change, sentence] of cases) {
      expect(await writeRefusal(b.t, caller, change, 'leave')).toBe(sentence)
      expect(await preview(b.t, caller, change)).toEqual({ state: 'refused', message: sentence })
    }
    // an agent, which has no login, through the model
    const byAgent = (change: RemovalChange) =>
      b.t.run((ctx) => previewRemoval(ctx, b.f.agent, change))
    expect(await byAgent(grant)).toEqual({ state: 'refused', message: ACCESS_NEEDS_A_PERSON })
    expect(await byAgent(member)).toEqual({ state: 'refused', message: ACCESS_NEEDS_A_PERSON })
    expect(await byAgent(deletion)).toEqual({
      state: 'refused',
      message: 'only organization admins can delete teams',
    })
    // someone who is not signed in
    await expectRefusal(
      b.t.query(api.accessRemovals.preview, { org_id: b.f.org.id, change: grant }),
      'forbidden',
      /not signed in/,
    )
  })

  it(`refuses a team deletion past ${LIMITS.teamDeleteRows.max} rows with the write's sentence`, async () => {
    const b = await base()
    await b.team('Second')
    await b.t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.teamDeleteRows.max; i++)
        await ctx.db.insert('team_members', {
          team_id: b.f.team.id,
          profile_id: uuid(),
          is_leader: false,
        })
    })
    const change = { kind: 'delete_team', team_id: b.f.team.id } as const
    const sentence = await writeRefusal(b.t, b.f.admin, change, 'leave')
    expect(sentence).toBe(LIMITS.teamDeleteRows.refusal)
    expect(await preview(b.t, b.f.admin, change)).toEqual({ state: 'refused', message: sentence })
  }, 60_000)

  it('writes nothing', async () => {
    const b = await base()
    await b.team('Second')
    await b.share(b.f.meta, b.f.team.id)
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    await b.join(b.f.team.id, pia)
    await b.task(b.f.sub, { title: 'Held', assignee_id: pia.id })
    const dump = () =>
      b.t.run(async (ctx) => {
        const out: Record<string, unknown[]> = {}
        for (const table of [
          'issues',
          'issue_descriptions',
          'projects',
          'profiles',
          'project_access',
          'project_team_access',
          'project_reach',
          'team_members',
          'team_counts',
          'teams',
          'activity_events',
          'messages',
        ] as const)
          out[table] = await ctx.db.query(table).collect()
        return out
      })
    const before = await dump()
    for (const change of [
      { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id },
      { kind: 'team_grant', project_id: b.f.meta.id, team_id: b.f.team.id },
      { kind: 'team_member', team_id: b.f.team.id, user_id: pia.id },
      { kind: 'delete_team', team_id: b.f.team.id },
    ] as const)
      expect((await previewOk(b.t, b.f.admin, change)).pending).toBe(true)
    expect(await dump()).toEqual(before)
  })
})

describe("the removal preview inside Convex's limits", () => {
  /* withOrg under the deployment's limits with `members` more members of
   * Hardware, which shares TBED at User beside a second team, Platform. Each
   * member holds `each` open tasks in Firmware, every fifth one In Review
   * with the next member reviewing it, and each task has three followers,
   * as tests/bulkReassign.test.ts measured. Emil is the first member. */
  async function crowd(members: number, each: number) {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const ids: string[] = []
    for (let from = 0; from < members; from += 100) {
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
        for (let i = from; i < Math.min(members, from + 100); i++) {
          const id = uuid()
          await ctx.db.insert('profiles', {
            id,
            org_id: f.org.id,
            name: i === 0 ? 'Emil' : `m${i}`,
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
          ids.push(id)
        }
      })
    }
    for (let from = 0; from < members; from += 100) {
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(members, from + 100); i++)
          for (let k = 0; k < each; k++) {
            const n = i * each + k
            const reviewing = n % 5 === 1
            const id = uuid()
            await ctx.db.insert('issues', {
              id,
              org_id: f.org.id,
              project_id: f.sub.id,
              num: 1000 + n,
              title: `Task ${n}`,
              description: '',
              status: reviewing ? 'review' : 'todo',
              priority: 'medium',
              paused: false,
              assignee_id: ids[i],
              reviewer_id: reviewing ? ids[(i + 1) % members] : undefined,
              created_at: NOW,
              updated_at: NOW,
            })
            for (let j = 1; j <= 3; j++)
              await ctx.db.insert('issue_subscriptions', {
                issue_id: id,
                profile_id: ids[(i + j) % members],
                created_at: NOW,
              })
          }
      })
    }
    return { t, f, emil: ids[0] }
  }

  /* The metrics of one transaction that runs `step`, with what it
   * answered or the sentence it refused with. */
  const measured = <R>(t: T, step: (ctx: Parameters<Parameters<T['run']>[0]>[0]) => Promise<R>) =>
    t.run(async (ctx) => {
      let answer: R | string
      try {
        answer = await step(ctx)
      } catch (e) {
        if (!(e instanceof ConvexError)) throw e
        answer = (e.data as Refusal).message
      }
      const m = await ctx.meta.getTransactionMetrics()
      return {
        answer,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      }
    })

  /* Previews deleting Hardware and removing Emil from it, then runs the
   * writes, and logs what each read. */
  async function previewCrowd(members: number, each: number) {
    const { t, f, emil } = await crowd(members, each)
    const deletion = { kind: 'delete_team', team_id: f.team.id } as const
    const member = { kind: 'team_member', team_id: f.team.id, user_id: emil } as const
    const results: Record<string, unknown> = {}
    for (const [name, caller, change] of [
      ['delete', f.admin, deletion],
      ['member', f.user, member],
    ] as const) {
      const p = await preview(t, caller, change)
      expect(['ok', 'too_large']).toContain(p.state)
      const m = await measured(t, (ctx) => previewRemoval(ctx, caller, change))
      results[`${name} preview`] = {
        state: p.state,
        ...(p.state === 'ok' ? { people: p.people.length, tasks: p.tasks } : {}),
        ranges: m.ranges,
        documents: m.documents,
        bytes: m.bytes,
      }
    }
    // the writes of the same changes, last, because they commit
    const left = await measured(t, (ctx) =>
      removeTeamMemberCore(ctx, {
        me: f.user,
        team: f.team,
        profileId: emil,
        held: 'leave',
        now: NOW,
      }).then((r) => r.stranded.length),
    )
    results['member leave write'] = left
    const kept = await measured(t, (ctx) =>
      deleteTeamCore(ctx, { me: f.admin, team: f.team, held: 'keep_as_viewer', now: NOW }).then(
        () => 'deleted',
      ),
    )
    results['delete keep write'] = kept
    console.info(`${members} members holding ${members * each} tasks`, results)
    return results
  }

  it('previews a team deletion and a member removal of 100 people and about 200 held tasks', async () => {
    const results = await previewCrowd(95, 2)
    expect(results['delete preview']).toMatchObject({ state: 'ok', people: 95, tasks: 190 })
    expect(results['member preview']).toMatchObject({ state: 'ok', people: 1, tasks: 2 })
  }, 120_000)

  it('previews a team deletion and a member removal of 1,000 members holding 2,000 open tasks', async () => {
    await previewCrowd(1000, 2)
  }, 300_000)

  it("bounds Keep's changers when many people can still change many projects", async () => {
    // Team Wide shares two top-level projects of 500 sub-projects each. Each
    // of its 200 members keeps User on one of them through a grant of their
    // own and holds a task in the other. Without a bound, the answer named
    // 501 projects for each of them, 100,200 project rows and about 20 MB.
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const wide = uuid()
    const metas = [uuid(), uuid()]
    const firstSubs: string[] = []
    const project = (id: string, n: number, extra: Partial<Doc<'projects'>>) => ({
      id,
      org_id: f.org.id,
      type: 'meta' as const,
      key: `W${n}`,
      name: `Wide ${n}`,
      description: '',
      sort_order: n,
      num: n,
      track_delay: false,
      created_at: NOW,
      ...extra,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('teams', {
        id: wide,
        org_id: f.org.id,
        name: 'Wide',
        track_delay_default: false,
        created_at: NOW,
      })
      for (const [m, id] of metas.entries()) {
        await ctx.db.insert('projects', project(id, 100 + m, {}))
        await ctx.db.insert('project_team_access', { project_id: id, team_id: wide, level: 'user' })
      }
    })
    for (const [m, parent_id] of metas.entries())
      await t.run(async (ctx) => {
        for (let i = 0; i < 500; i++) {
          const id = uuid()
          await ctx.db.insert(
            'projects',
            project(id, 1000 + m * 500 + i, { type: 'project', parent_id }),
          )
          if (i === 0) firstSubs.push(id)
        }
      })
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `w${i}`,
          initials: 'WW',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          accepted_at: NOW,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', { team_id: wide, profile_id: id, is_leader: false })
        await ctx.db.insert('project_access', {
          project_id: metas[i % 2],
          profile_id: id,
          level: 'user',
        })
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: firstSubs[1 - (i % 2)],
          num: 5000 + i,
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
    const change = { kind: 'delete_team', team_id: wide } as const
    const p = await previewOk(t, f.admin, change)
    expect(p.people).toHaveLength(200)
    expect(p.keep.targets).toEqual(metas)
    // every one of them still changes a parent and its 500 sub-projects
    expect(p.keep.changers).toHaveLength(200)
    for (const c of p.keep.changers) {
      expect(c.projects).toHaveLength(PREVIEW.changerProjects)
      expect(c.projects.length + c.more).toBe(501)
    }
    // the parents and the first sub-projects of each, once
    expect(p.projects).toHaveLength(2 + 2 * (PREVIEW.changerProjects - 1))
    const m = await measured(t, (ctx) => previewRemoval(ctx, f.admin, change))
    console.info("Keep's changers over 2 x 501 projects", {
      answer_bytes: getConvexSize(m.answer as RemovalPreview),
      ranges: m.ranges,
      documents: m.documents,
      bytes: m.bytes,
    })
    // its people and changers, about 360 bytes for each of the 200
    expect(getConvexSize(m.answer as RemovalPreview)).toBeLessThan(128 * 1024)
  }, 120_000)

  /* withOrg under the deployment's limits, with a second team, Platform,
   * beside Hardware, which shares TBED; Mia, a member of Hardware, holds
   * one task in Firmware beside 320 open tasks with descriptions at the cap
   * in a three-byte script, about 60 KB each and 19 MB in all, past the
   * 16 MiB one request reads. */
  async function pastTheRoom() {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const mia = await plantSeat(t, { org_id: f.org.id, name: 'Mia', accepted_at: NOW })
    await t.run(async (ctx) => {
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
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: mia.id,
        is_leader: false,
      })
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: mia.id })
    const description = '€'.repeat(LIMITS.description.max)
    for (let from = 0; from < 320; from += 80)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 80; i++)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 5000 + i,
            title: `Long ${i}`,
            description,
            status: 'todo',
            priority: 'medium',
            paused: false,
            assignee_id: f.user.id,
            created_at: NOW,
            updated_at: NOW,
          })
      })
    return { t, f, mia }
  }

  it('answers too_large for a member removal past the room, which its write refuses too', async () => {
    const { t, f, mia } = await pastTheRoom()
    const change = { kind: 'team_member', team_id: f.team.id, user_id: mia.id } as const
    expect(await preview(t, f.user, change)).toEqual({ state: 'too_large', message: REMOVAL_FULL })
    console.info(
      'a member removal past the room',
      await measured(t, (ctx) => previewRemoval(ctx, f.user, change).then((p) => p.state)),
    )
    const e = await expectRefusal(
      as(t, f.user).mutation(api.teams.removeMember, {
        org_id: f.org.id,
        team_id: f.team.id,
        profile_id: mia.id,
        on_held_tasks: 'leave',
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(REMOVAL_FULL)
  }, 120_000)

  it('answers too_large for a team deletion past the room, which still deletes the team when it leaves the tasks', async () => {
    // a deletion that leaves the tasks reads none of them
    const { t, f } = await pastTheRoom()
    const change = { kind: 'delete_team', team_id: f.team.id } as const
    expect(await preview(t, f.admin, change)).toEqual({ state: 'too_large', message: REMOVAL_FULL })
    await as(t, f.admin).mutation(api.teams.deleteDeep, {
      org_id: f.org.id,
      id: f.team.id,
      on_held_tasks: 'leave',
    })
    expect(await preview(t, f.admin, change)).toEqual({ state: 'unavailable' })
  }, 120_000)

  it('refuses a team deletion that keeps people as Viewers where the preview allowed it, when the deletes fill the room', async () => {
    // Hardware, beside Platform, shares TBED; Mia, a member, holds one task,
    // and 2,000 more memberships name people who no longer exist. The
    // write also deletes those memberships before it reads sight again,
    // which the preview never does.
    const plant = async (limits: Parameters<typeof newT>[0]) => {
      const b = await base(newT(limits))
      await b.team('Platform')
      await b.share(b.f.meta, b.f.team.id)
      const mia = await b.person('Mia')
      await b.join(b.f.team.id, mia)
      await b.task(b.f.sub, { assignee_id: mia.id })
      await b.t.run(async (ctx) => {
        for (let i = 0; i < 2000; i++)
          await ctx.db.insert('team_members', {
            team_id: b.f.team.id,
            profile_id: uuid(),
            is_leader: false,
          })
      })
      return { ...b, change: { kind: 'delete_team', team_id: b.f.team.id } as const }
    }
    const m = await plant({ transactionLimits: true })
    const read = await measured(m.t, (ctx) => previewRemoval(ctx, m.f.admin, m.change))
    const wrote = await measured(m.t, (ctx) =>
      deleteTeamCore(ctx, { me: m.f.admin, team: m.f.team, held: 'keep_as_viewer', now: NOW }).then(
        () => 'deleted',
      ),
    )
    expect(wrote.answer).toBe('deleted')
    const used = ({ ranges, documents, bytes }: Omit<typeof wrote, 'answer'>) => ({
      ranges,
      documents,
      bytes,
    })
    console.info('a team deletion that keeps people as Viewers', {
      preview: used(read),
      write: used(wrote),
    })
    expect(wrote.documents).toBeGreaterThan(read.documents + 1500)
    // a limit whose room the preview's reads stay inside and the write's pass
    const documentsRead = Math.ceil((read.documents + wrote.documents) / 2 / REASSIGN_ROOM)
    const s = await plant({ transactionLimits: { documentsRead } })
    expect((await previewOk(s.t, s.f.admin, s.change)).keep).toMatchObject({ allowed: true })
    const e = await expectRefusal(
      as(s.t, s.f.admin).mutation(api.teams.deleteDeep, {
        org_id: s.orgId,
        id: s.f.team.id,
        on_held_tasks: 'keep_as_viewer',
      }),
      'rule',
    )
    expect((e.data as Refusal).message).toBe(REMOVAL_FULL)
  }, 120_000)
})
