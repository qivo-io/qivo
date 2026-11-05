/* The removal window's Reassign picker (accessRemovals.reassignChoices,
 * model/removalPreview.ts reassignChoicesOf) and the preview's additions
 * for the window (reassign_to with reassign.holder_eligible, keep.offered,
 * keep.permitted, reassign.permitted and PREVIEW.items) against the write
 * they stand for. For each scenario the picker is listed to its end, and the
 * write then hands the held tasks to every seat of the organization in
 * turn: it must go through exactly for the seats listed, and the preview's
 * holder_eligible must say the same. Each handover runs in a transaction
 * that throws at its end, which convex-test rolls back, so it changes
 * nothing for the next. The reads at the design size close the file, one
 * figure a case. */
/// <reference types="vite/client" />

import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { ACCESS_NEEDS_A_PERSON, NO_USER_MANAGEMENT } from '../lib/access'
import { deletionReadOnly } from '../lib/billingAccess'
import { byId } from '../lib/db'
import type { GrantLevel } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { ASSIGNEE_RULE, ASSIGNEE_SIGHT_RULE, NO_WRITE_ACCESS } from '../model/issues'
import {
  type HeldTasks,
  REASSIGN_ROOM,
  REMOVAL_FULL,
  reassignTooLarge,
  removeProjectGrantCore,
  VIEWER_NOT_KEPT,
} from '../model/projectAccess'
import {
  PREVIEW,
  previewRemoval,
  type ReassignChoices,
  type RemovalChange,
  type RemovalPreview,
  reassignChoicesOf,
} from '../model/removalPreview'
import { deleteTeamCore, removeTeamMemberCore } from '../model/teams'
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
import { keyOrg } from './nameKeys.setup'

const DEFAULT_READ = { ...NAMED_READ }
const ITEMS = PREVIEW.items
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  PREVIEW.items = ITEMS
})

type Ok = Extract<RemovalPreview, { state: 'ok' }>
type Ready = Extract<ReassignChoices, { state: 'ready' }>
type Search = { search?: string; after?: string }

const choices = (t: T, caller: Doc<'profiles'>, change: RemovalChange, a: Search = {}) =>
  as(t, caller).query(api.accessRemovals.reassignChoices, { org_id: caller.org_id, change, ...a })

const preview = (t: T, caller: Doc<'profiles'>, change: RemovalChange, reassignTo?: string) =>
  as(t, caller).query(api.accessRemovals.preview, {
    org_id: caller.org_id,
    change,
    ...(reassignTo === undefined ? {} : { reassign_to: reassignTo }),
  })

async function previewOk(
  t: T,
  caller: Doc<'profiles'>,
  change: RemovalChange,
  reassignTo?: string,
): Promise<Ok> {
  const answer = await preview(t, caller, change, reassignTo)
  if (answer.state !== 'ok') throw new Error(`expected an answer, got ${JSON.stringify(answer)}`)
  return answer
}

function ready(answer: ReassignChoices): Ready {
  if (answer.state !== 'ready') throw new Error(`expected a batch, got ${JSON.stringify(answer)}`)
  return answer
}

/* Every batch of a picker from its start to its end, and the ids it listed
 * in order. */
async function listAll(
  read: (after?: string) => Promise<ReassignChoices>,
): Promise<{ ids: string[]; batches: Ready[] }> {
  const batches: Ready[] = []
  let after: string | undefined
  for (let round = 0; round < 500; round++) {
    const batch = ready(await read(after))
    batches.push(batch)
    if (batch.next === null)
      return { ids: batches.flatMap((b) => b.rows.map((r) => r.id)), batches }
    after = batch.next
  }
  throw new Error('the list did not end')
}

/* The write `change` names, run as `me` with `held` through its core. */
async function writeCore(
  ctx: MutationCtx,
  me: Doc<'profiles'>,
  change: RemovalChange,
  held: HeldTasks,
): Promise<void> {
  const must = <R>(row: R | null): R => {
    if (row === null) throw new Error('the scenario names a row that does not exist')
    return row
  }
  if (change.kind === 'user_grant' || change.kind === 'team_grant') {
    await removeProjectGrantCore(ctx, {
      me,
      project: must(await byId(ctx, 'projects', change.project_id)),
      subject:
        change.kind === 'user_grant'
          ? { profile: must(await byId(ctx, 'profiles', change.user_id)) }
          : { team: must(await byId(ctx, 'teams', change.team_id)) },
      held,
      now: NOW,
    })
    return
  }
  const team = must(await byId(ctx, 'teams', change.team_id))
  if (change.kind === 'team_member')
    await removeTeamMemberCore(ctx, { me, team, profileId: change.user_id, held, now: NOW })
  else await deleteTeamCore(ctx, { me, team, held, now: NOW })
}

/* What a handover throws at its end so convex-test rolls it back. */
const ROLLED_BACK = 'rolled back on purpose'

/* Whether the write `change` names, as `me`, goes through when it hands
 * the held tasks to `to`, or the sentence it refuses with. The write's
 * transaction throws at its end, so nothing it wrote stays. */
async function handover(
  t: T,
  me: Doc<'profiles'>,
  change: RemovalChange,
  to: string,
): Promise<true | string> {
  try {
    await t.run(async (ctx) => {
      await writeCore(ctx, me, change, { reassign_to: to })
      throw new Error(ROLLED_BACK)
    })
  } catch (e) {
    if (e instanceof ConvexError) return (e.data as Refusal).message
    if (e instanceof Error && e.message.includes(ROLLED_BACK)) return true
    throw e
  }
  throw new Error('the handover neither went through nor was refused')
}

/* Every task's holders and every grant, share and membership of the
 * organization, to show that the handovers left nothing behind. */
const stateOf = (t: T) =>
  t.run(async (ctx) => ({
    issues: (await ctx.db.query('issues').collect()).map((i) => [
      i.id,
      i.assignee_id ?? null,
      i.reviewer_id ?? null,
    ]),
    access: (await ctx.db.query('project_access').collect()).map((g) => g._id),
    shares: (await ctx.db.query('project_team_access').collect()).map((s) => s._id),
    members: (await ctx.db.query('team_members').collect()).map((m) => m._id),
    teams: (await ctx.db.query('teams').collect()).map((m) => m._id),
  }))

/* A scenario: who removes which access, in which organization. */
type Scenario = { t: T; orgId: string; caller: Doc<'profiles'>; change: RemovalChange }

/**
 * Lists the scenario's picker to its end and checks it against the write:
 * each seat of the organization is listed exactly when the write's handover
 * to them goes through, and exactly when the preview's holder_eligible says
 * so; nobody who loses sight of a task is listed, and every seat is listed
 * once, in name order. Answers the names listed and the preview.
 */
async function expectAgainstWrite(
  s: Scenario,
): Promise<{ listed: string[]; p: Ok; outcomes: Map<string, true | string> }> {
  const p = await previewOk(s.t, s.caller, s.change)
  expect(p.pending).toBe(true)
  expect(p.reassign.allowed).toBe(true)
  const { ids } = await listAll((after) => choices(s.t, s.caller, s.change, { after }))
  const listed = new Set(ids)
  expect(ids).toHaveLength(listed.size)
  for (const person of p.people) expect(listed.has(person.id), person.name).toBe(false)
  const before = await stateOf(s.t)
  const seats = await s.t.run((ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', s.orgId))
      .collect(),
  )
  const outcomes = new Map<string, true | string>()
  for (const seat of seats) {
    const outcome = await handover(s.t, s.caller, s.change, seat.id)
    outcomes.set(seat.name, outcome)
    expect(outcome === true, `${seat.name}: ${outcome}`).toBe(listed.has(seat.id))
    const check = await previewOk(s.t, s.caller, s.change, seat.id)
    expect(check.reassign.holder_eligible, seat.name).toBe(listed.has(seat.id))
  }
  expect(await stateOf(s.t)).toEqual(before)
  const byId = new Map(seats.map((p) => [p.id, p]))
  const listedSeats = ids.map((id) => byId.get(id) as Doc<'profiles'>)
  // name order, then id
  const keyOf = (p: Doc<'profiles'>) => `${p.name_key ?? ''}\u0000${p.id}`
  expect(listedSeats.map(keyOf)).toEqual(listedSeats.map(keyOf).sort())
  return { listed: listedSeats.map((x) => x.name), p, outcomes }
}

/* withOrg with helpers that plant people, grants, team shares, memberships
 * and tasks. `keyed` keys every name and stamps the organization ready, as
 * the backfill leaves it; call it once everything is planted. */
async function base(t: T = newT()) {
  const f = await withOrg(t)
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
  const keyed = () => keyOrg(t, f.org.id)
  return { t, f, orgId: f.org.id, person, grant, share, join, task, team, elsewhere, keyed }
}

/* The names `listed` holds, in any order. */
const sorted = (listed: readonly string[]) => [...listed].sort()

describe('the Reassign picker against the write', () => {
  it('rolls back a handover, so each seat starts from the same state', async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    const held = await b.task(b.f.sub, { assignee_id: pia.id })
    await b.keyed()
    const change = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    expect(await handover(b.t, b.f.admin, change, b.f.admin.id)).toBe(true)
    // the grant is still there and the task still Pia's
    expect((await previewOk(b.t, b.f.admin, change)).pending).toBe(true)
    expect((await b.t.run((ctx) => byId(ctx, 'issues', held.id)))?.assignee_id).toBe(pia.id)
  })

  it("lists for a person's grant on a top-level project who can take every lost task, as the write accepts them", async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    // her own grant on Board rev keeps its task in sight
    await b.grant(b.f.sub2, pia)
    await b.task(b.f.sub, { title: 'Assigned in Firmware', assignee_id: pia.id })
    await b.task(b.f.sub, {
      title: 'Reviewed in Firmware',
      status: 'review',
      assignee_id: b.f.user.id,
      reviewer_id: pia.id,
    })
    await b.task(b.f.sub2, { title: 'Assigned in Board rev', assignee_id: pia.id })
    // Edit on Firmware alone is enough
    const quinn = await b.person('Quinn')
    await b.grant(b.f.sub, quinn)
    // Viewer only, switched off, or Edit elsewhere is not
    await b.grant(b.f.meta, await b.person('Vic'), 'viewer')
    await b.grant(b.f.meta, await b.person('Ivy', { active: false }))
    await b.grant(b.f.sub2, await b.person('Sam'))
    // an agent with the user role can hold work
    await b.grant(b.f.meta, b.f.agent)
    await b.keyed()
    const { listed, outcomes } = await expectAgainstWrite({
      ...b,
      caller: b.f.admin,
      change: { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id },
    })
    // an admin while levelsFrom gives Lead, TBED's lead, a guest with Edit
    // and an agent; never the organization's viewer or Pia herself
    expect(sorted(listed)).toEqual(['Quinn', 'Relay', 'admin', 'guest', 'user'])
    expect(outcomes.get('Sam')).toBe(ASSIGNEE_RULE)
    expect(outcomes.get('Pia')).toBe(ASSIGNEE_RULE)
    expect(outcomes.get('viewer')).toBe(ASSIGNEE_RULE)
  })

  it("lists for a person's grant on a sub-project who edits that sub-project", async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.sub, pia)
    await b.grant(b.f.sub2, pia)
    await b.task(b.f.sub, { title: 'In Firmware', assignee_id: pia.id })
    await b.task(b.f.sub2, { title: 'In Board rev', assignee_id: pia.id })
    const quinn = await b.person('Quinn')
    await b.grant(b.f.sub, quinn)
    await b.grant(b.f.sub2, await b.person('Sam'))
    await b.keyed()
    const { listed } = await expectAgainstWrite({
      ...b,
      caller: b.f.user,
      change: { kind: 'user_grant', project_id: b.f.sub.id, user_id: pia.id },
    })
    expect(sorted(listed)).toEqual(['Quinn', 'admin', 'guest', 'user'])
  })

  it('leaves out whose only Edit came through a removed team share on a top-level project', async () => {
    const b = await base()
    const second = await b.team('Second')
    await b.share(b.f.meta, b.f.team.id)
    await b.share(b.f.meta, second, 'viewer')
    const mia = await b.person('Mia')
    const noah = await b.person('Noah')
    const olga = await b.person('Olga')
    // a member who holds no task and edits TBED only through the share
    const nils = await b.person('Nils')
    for (const m of [mia, noah, olga, nils]) await b.join(b.f.team.id, m)
    await b.grant(b.f.meta, noah)
    await b.join(second, olga)
    for (const m of [mia, noah, olga])
      await b.task(b.f.sub, { title: `${m.name}'s task`, assignee_id: m.id })
    await b.keyed()
    const { listed, p } = await expectAgainstWrite({
      ...b,
      caller: b.f.admin,
      change: { kind: 'team_grant', project_id: b.f.meta.id, team_id: b.f.team.id },
    })
    // Olga keeps sight through the second team's Viewer share
    expect(p.people.map((x) => x.name)).toEqual(['Mia'])
    expect(sorted(listed)).toEqual(['Noah', 'admin', 'guest', 'user'])
  })

  it('leaves out whose only Edit came through a removed team share on a sub-project', async () => {
    const b = await base()
    await b.share(b.f.sub, b.f.team.id)
    const mia = await b.person('Mia')
    const pete = await b.person('Pete')
    const nils = await b.person('Nils')
    for (const m of [mia, pete, nils]) await b.join(b.f.team.id, m)
    await b.grant(b.f.meta, pete)
    for (const m of [mia, pete])
      await b.task(b.f.sub, { title: `${m.name}'s task`, assignee_id: m.id })
    await b.keyed()
    const { listed } = await expectAgainstWrite({
      ...b,
      caller: b.f.user,
      change: { kind: 'team_grant', project_id: b.f.sub.id, team_id: b.f.team.id },
    })
    expect(sorted(listed)).toEqual(['Pete', 'admin', 'guest', 'user'])
  })

  it('lists for a member leaving a team the members who stay', async () => {
    const b = await base()
    await b.share(b.f.meta, b.f.team.id)
    const mia = await b.person('Mia')
    const nils = await b.person('Nils')
    for (const m of [mia, nils]) await b.join(b.f.team.id, m)
    await b.task(b.f.sub, { title: 'Firmware work', assignee_id: mia.id })
    await b.task(b.f.sub2, {
      title: 'Board review',
      status: 'review',
      assignee_id: b.f.user.id,
      reviewer_id: mia.id,
    })
    await b.task(b.f.sub, { title: 'Done work', status: 'done', assignee_id: mia.id })
    await b.keyed()
    const { listed } = await expectAgainstWrite({
      ...b,
      caller: b.f.user,
      change: { kind: 'team_member', team_id: b.f.team.id, user_id: mia.id },
    })
    expect(sorted(listed)).toEqual(['Nils', 'admin', 'guest', 'user'])
  })

  it('lists for a team deletion its members who keep Edit another way, and not those who edit through the team alone', async () => {
    const b = await base()
    await b.team('Second')
    await b.share(b.f.meta, b.f.team.id)
    // at User, so a member who edits through the team alone would pass
    // both projects' rule if the deletion were not left out
    await b.share(b.f.hidden, b.f.team.id)
    const mia = await b.person('Mia')
    const sam = await b.person('Sam')
    const nils = await b.person('Nils')
    const rita = await b.person('Rita')
    for (const m of [mia, sam, nils, rita]) await b.join(b.f.team.id, m)
    await b.grant(b.f.meta, rita)
    await b.grant(b.f.hidden, rita)
    await b.task(b.f.sub, { title: "Mia's task", assignee_id: mia.id })
    await b.task(b.f.hidden, { title: "Sam's task", assignee_id: sam.id })
    await b.keyed()
    const { listed } = await expectAgainstWrite({
      ...b,
      caller: b.f.admin,
      change: { kind: 'delete_team', team_id: b.f.team.id },
    })
    // the guest edits TBED but not Skunkworks
    expect(sorted(listed)).toEqual(['Rita', 'admin', 'user'])
  })

  it('lists for a team leader who keeps Edit after removing a member', async () => {
    const b = await base()
    const { meta, sub } = await b.elsewhere()
    await b.share(meta, b.f.team.id)
    const lena = await b.person('Lena')
    const mia = await b.person('Mia')
    await b.join(b.f.team.id, lena, true)
    await b.join(b.f.team.id, mia)
    await b.task(sub, { title: "Lena's task", assignee_id: lena.id })
    await b.task(sub, { title: "Mia's task", assignee_id: mia.id })
    await b.keyed()
    const { listed } = await expectAgainstWrite({
      ...b,
      caller: lena,
      change: { kind: 'team_member', team_id: b.f.team.id, user_id: mia.id },
    })
    expect(sorted(listed)).toEqual(['Lena', 'admin', 'user'])
  })

  it("leaves out who cannot see a lost subtask's parent in another sub-project, also one the caller cannot see", async () => {
    const b = await base()
    // Lena leads Firmware alone and cannot see Board rev
    const lena = await b.person('Lena')
    await b.t.run((ctx) => ctx.db.patch(b.f.sub._id, { lead_id: lena.id }))
    const pia = await b.person('Pia')
    await b.grant(b.f.sub, pia)
    await b.grant(b.f.sub2, pia)
    const parent = await b.task(b.f.sub2, { title: 'Board bring-up', assignee_id: b.f.user.id })
    await b.task(b.f.sub, {
      title: 'Flash the bootloader',
      parent_id: parent.id,
      assignee_id: pia.id,
    })
    // Edit on Firmware, and with sight of Board rev or without
    const quinn = await b.person('Quinn')
    await b.grant(b.f.sub, quinn)
    const rae = await b.person('Rae')
    await b.grant(b.f.sub, rae)
    await b.grant(b.f.sub2, rae, 'viewer')
    await b.keyed()
    const change = { kind: 'user_grant', project_id: b.f.sub.id, user_id: pia.id } as const
    const { listed, p, outcomes } = await expectAgainstWrite({ ...b, caller: lena, change })
    expect(p.hidden).toBe(0)
    expect(p.items.map((i) => i.title)).toEqual(['Flash the bootloader'])
    // Lena edits the task but cannot see its parent, so the write refuses
    // her as it refuses Quinn
    expect(sorted(listed)).toEqual(['Rae', 'admin', 'guest', 'user'])
    expect(outcomes.get('Quinn')).toBe(ASSIGNEE_SIGHT_RULE)
    expect(outcomes.get('Lena')).toBe(ASSIGNEE_SIGHT_RULE)
  })
})

describe("the Reassign picker's gate", () => {
  it("refuses a caller without Edit on one lost task's project once the access is gone, with no rows", async () => {
    const b = await base()
    const { meta, sub } = await b.elsewhere()
    await b.share(b.f.meta, b.f.team.id)
    await b.share(meta, b.f.team.id, 'viewer')
    const mia = await b.person('Mia')
    await b.join(b.f.team.id, mia)
    await b.task(b.f.sub, { title: 'In Firmware', assignee_id: mia.id })
    await b.task(sub, { title: 'Elsewhere', assignee_id: mia.id })
    await b.keyed()
    // leads Hardware and TBED, and sees Elsewhere only through the team
    const change = { kind: 'team_member', team_id: b.f.team.id, user_id: mia.id } as const
    expect(await choices(b.t, b.f.user, change)).toEqual({
      state: 'refused',
      message: NO_WRITE_ACCESS,
    })
    const p = await previewOk(b.t, b.f.user, change, b.f.admin.id)
    expect(p.keep).toMatchObject({ allowed: false, refusal: NO_USER_MANAGEMENT, permitted: false })
    expect(p.reassign).toEqual({
      allowed: false,
      refusal: NO_WRITE_ACCESS,
      permitted: false,
      holder_eligible: false,
    })
    // and the write refuses the admin, whom an organization admin's removal
    // would let take them
    expect(await handover(b.t, b.f.user, change, b.f.admin.id)).toBe(NO_WRITE_ACCESS)
  })

  it('refuses a team leader who loses Edit by leaving their own team', async () => {
    const b = await base()
    const { meta, sub } = await b.elsewhere()
    await b.share(meta, b.f.team.id)
    const lena = await b.person('Lena')
    await b.join(b.f.team.id, lena, true)
    await b.task(sub, { title: "Lena's task", assignee_id: lena.id })
    await b.keyed()
    const change = { kind: 'team_member', team_id: b.f.team.id, user_id: lena.id } as const
    expect(await choices(b.t, lena, change)).toEqual({ state: 'refused', message: NO_WRITE_ACCESS })
  })

  /* Pia, with a User or Viewer grant on TBED, holding `n` open tasks in
   * Firmware. */
  async function holding(n: number, level: GrantLevel = 'user') {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia, level)
    await b.t.run(async (ctx) => {
      for (let i = 0; i < n; i++)
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
    await b.keyed()
    return {
      ...b,
      change: { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const,
    }
  }

  it(`lists ${LIMITS.reassign.max} tasks whole and refuses to reassign ${LIMITS.reassign.max + 1}, counting them all`, async () => {
    const whole = await holding(LIMITS.reassign.max)
    const p = await previewOk(whole.t, whole.f.admin, whole.change)
    expect(p.items).toHaveLength(LIMITS.reassign.max)
    expect(p.items_total).toBe(LIMITS.reassign.max)
    expect(p.reassign).toEqual({ allowed: true, refusal: null, permitted: true })
    expect(ready(await choices(whole.t, whole.f.admin, whole.change)).rows.length).toBeGreaterThan(
      0,
    )

    const over = await holding(LIMITS.reassign.max + 1)
    const q = await previewOk(over.t, over.f.admin, over.change, over.f.admin.id)
    expect(q.items).toHaveLength(LIMITS.reassign.max)
    expect(q.items_total).toBe(LIMITS.reassign.max + 1)
    expect(q.tasks).toBe(LIMITS.reassign.max + 1)
    // the size fills the refusal; the caller's authority still shows
    expect(q.reassign).toEqual({
      allowed: false,
      refusal: reassignTooLarge(true),
      permitted: true,
      holder_eligible: false,
    })
    expect(q.keep).toMatchObject({ allowed: true, offered: true, permitted: true })
    expect(await choices(over.t, over.f.admin, over.change)).toEqual({
      state: 'refused',
      message: reassignTooLarge(true),
    })
  })

  it('offers Keep as Viewer for every removal but a Viewer grant, whose refusal names it', async () => {
    const viewer = await holding(1, 'viewer')
    const p = await previewOk(viewer.t, viewer.f.admin, viewer.change)
    expect(p.keep).toMatchObject({
      allowed: false,
      refusal: VIEWER_NOT_KEPT,
      offered: false,
      permitted: true,
    })
    expect(p.reassign).toMatchObject({ allowed: true, permitted: true })
    const user = await holding(1)
    expect((await previewOk(user.t, user.f.admin, user.change)).keep).toMatchObject({
      allowed: true,
      offered: true,
      permitted: true,
    })
  })

  it(`refuses past ${LIMITS.removalHolders.max} holders with the write's sentence`, async () => {
    const { t, f } = await manyHolders(LIMITS.removalHolders.max + 1)
    const change = { kind: 'team_grant', project_id: f.meta.id, team_id: f.team.id } as const
    expect(await choices(t, f.admin, change)).toEqual({
      state: 'refused',
      message: LIMITS.removalHolders.refusal,
    })
    const p = await previewOk(t, f.admin, change)
    expect(p.reassign).toEqual({
      allowed: false,
      refusal: LIMITS.removalHolders.refusal,
      permitted: true,
    })
    expect(p.keep).toMatchObject({ allowed: false, permitted: true, offered: true })
  }, 60_000)

  it('refuses everyone while the organization is read-only', async () => {
    const b = await holding(1)
    await b.t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: b.f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: '2026-02-01T00:00:00.000Z',
        created_at: NOW,
      }),
    )
    const p = await previewOk(b.t, b.f.admin, b.change)
    const sentence = deletionReadOnly('2026-02-01T00:00:00.000Z')
    expect(p).toMatchObject({
      leave_only: true,
      keep: { allowed: false, refusal: sentence, permitted: true, offered: true },
      reassign: { allowed: false, refusal: sentence, permitted: true },
    })
    expect(await choices(b.t, b.f.admin, b.change)).toEqual({ state: 'refused', message: sentence })
    const member = { kind: 'team_member', team_id: b.f.team.id, user_id: b.f.admin.id } as const
    expect(await choices(b.t, b.f.user, member)).toEqual({ state: 'refused', message: sentence })
  })

  it("refuses an agent with the write's sentence", async () => {
    const b = await holding(1)
    expect(await b.t.run((ctx) => reassignChoicesOf(ctx, b.f.agent, { change: b.change }))).toEqual(
      { state: 'refused', message: ACCESS_NEEDS_A_PERSON },
    )
  })

  it('refuses someone not signed in, a seat of another organization and a switched-off seat', async () => {
    const b = await holding(1)
    await expectRefusal(
      b.t.query(api.accessRemovals.reassignChoices, { org_id: b.f.org.id, change: b.change }),
      'forbidden',
      /not signed in/,
    )
    await expectRefusal(
      as(b.t, b.f.otherAdmin).query(api.accessRemovals.reassignChoices, {
        org_id: b.f.org.id,
        change: b.change,
      }),
      'forbidden',
      /no profile in this organization/,
    )
    await b.t.run((ctx) => ctx.db.patch(b.f.user._id, { active: false }))
    await expectRefusal(choices(b.t, b.f.user, b.change), 'forbidden', /no profile/)
  })
})

describe("the Reassign picker's states", () => {
  it('answers unavailable alike for unknown and foreign projects, teams and people', async () => {
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
    await b.keyed()
    const changes: RemovalChange[] = [
      { kind: 'user_grant', project_id: uuid(), user_id: pia.id },
      { kind: 'user_grant', project_id: b.f.otherProject.id, user_id: pia.id },
      { kind: 'user_grant', project_id: b.f.meta.id, user_id: uuid() },
      { kind: 'user_grant', project_id: b.f.meta.id, user_id: b.f.otherAdmin.id },
      { kind: 'team_grant', project_id: b.f.meta.id, team_id: uuid() },
      { kind: 'team_grant', project_id: b.f.meta.id, team_id: foreignTeam },
      { kind: 'team_member', team_id: uuid(), user_id: pia.id },
      { kind: 'team_member', team_id: foreignTeam, user_id: pia.id },
      { kind: 'delete_team', team_id: uuid() },
      { kind: 'delete_team', team_id: foreignTeam },
    ]
    for (const change of changes)
      expect(await choices(b.t, b.f.admin, change)).toEqual({ state: 'unavailable' })
    // and the preview's check of an unknown or foreign holder says no
    const grant = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    for (const id of [uuid(), b.f.otherAdmin.id])
      expect((await previewOk(b.t, b.f.admin, grant, id)).reassign.holder_eligible).toBe(false)
  })

  it('answers not_ready until the names are keyed', async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    await b.task(b.f.sub, { assignee_id: pia.id })
    const change = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    expect(await choices(b.t, b.f.admin, change)).toEqual({ state: 'not_ready' })
    await b.keyed()
    expect((await choices(b.t, b.f.admin, change)).state).toBe('ready')
  })

  it('lists everyone who can hold work when nothing is left to remove', async () => {
    const b = await base()
    const pia = await b.person('Pia')
    await b.task(b.f.sub, { assignee_id: pia.id })
    await b.person('Ivy', { active: false })
    await b.keyed()
    const change = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    expect((await previewOk(b.t, b.f.admin, change)).pending).toBe(false)
    const { ids } = await listAll((after) => choices(b.t, b.f.admin, change, { after }))
    const names = await b.t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await byId(ctx, 'profiles', id))?.name)),
    )
    expect(sorted(names as string[])).toEqual(['Pia', 'Relay', 'admin', 'guest', 'user'])
  })

  it('answers too_large past the room, as the preview does', async () => {
    // pastTheRoom of tests/accessRemovalPreview.test.ts: Mia, a member of
    // Hardware, which shares TBED, holds one of Firmware's 300 open tasks
    // under a lowered limit on the bytes one transaction reads
    const t = newT({ transactionLimits: { bytesRead: 144 * 1024 } })
    const f = await withOrg(t)
    const mia = await plantSeat(t, { org_id: f.org.id, name: 'Mia', accepted_at: NOW })
    await t.run(async (ctx) => {
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
    const description =
      'Check the sensor calibration on the new boards, compare it with the last batch and note any drift above the tolerance. '.repeat(
        2,
      )
    await t.run(async (ctx) => {
      for (let i = 0; i < 299; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          num: 5000 + i,
          title: `Calibration check ${i}`,
          description,
          status: 'todo',
          priority: 'medium',
          paused: false,
          assignee_id: f.user.id,
          created_at: NOW,
          updated_at: NOW,
        })
    })
    const change = { kind: 'team_member', team_id: f.team.id, user_id: mia.id } as const
    const tooLarge = { state: 'too_large', message: REMOVAL_FULL }
    expect(await preview(t, f.user, change)).toEqual(tooLarge)
    expect(await choices(t, f.user, change)).toEqual(tooLarge)
  })

  it('answers too_large when the check of who can take the tasks passes the room the preview left', async () => {
    // Pia's grant on TBED goes. She holds 30 subtasks in Firmware whose
    // parents, held by TBED's lead, sit in Board rev, so the check of a new
    // holder (takerRule) reads the 30 parents and the levels of both
    // sub-projects past the preview's own reads
    const spread = async (t: T) => {
      const b = await base(t)
      const pia = await b.person('Pia')
      await b.grant(b.f.meta, pia)
      await b.t.run(async (ctx) => {
        for (let i = 0; i < 30; i++) {
          const task = { org_id: b.f.org.id, title: `Bring-up step ${i}`, description: '' }
          const rest = { status: 'todo', priority: 'medium', paused: false } as const
          const parent = uuid()
          await ctx.db.insert('issues', {
            ...task,
            ...rest,
            id: parent,
            project_id: b.f.sub2.id,
            num: 2000 + 2 * i,
            assignee_id: b.f.user.id,
            created_at: NOW,
            updated_at: NOW,
          })
          await ctx.db.insert('issues', {
            ...task,
            ...rest,
            id: uuid(),
            project_id: b.f.sub.id,
            num: 2001 + 2 * i,
            parent_id: parent,
            assignee_id: pia.id,
            created_at: NOW,
            updated_at: NOW,
          })
        }
      })
      await b.keyed()
      const change = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
      return { ...b, change }
    }
    // at the deployment's limits the lead can take them, and the index
    // ranges the preview alone reads
    const whole = await spread(newT({ transactionLimits: true }))
    const eligible = await previewOk(whole.t, whole.f.admin, whole.change, whole.f.user.id)
    expect(eligible.reassign).toMatchObject({ allowed: true, holder_eligible: true })
    const listed = ready(await choices(whole.t, whole.f.admin, whole.change)).rows
    expect(listed.map((r) => r.id)).toContain(whole.f.user.id)
    const alone = await whole.t.run(async (ctx) => {
      await previewRemoval(ctx, whole.f.admin, whole.change)
      return (await ctx.meta.getTransactionMetrics()).databaseQueries.used
    })
    // a limit whose room holds the preview and 15 index ranges more, which
    // the check of a new holder passes while it reads the parents
    const b = await spread(
      newT({ transactionLimits: { databaseQueries: Math.ceil((alone + 15) / REASSIGN_ROOM) } }),
    )
    expect(await preview(b.t, b.f.admin, b.change)).toMatchObject({
      state: 'ok',
      pending: true,
      tasks: 30,
      reassign: { allowed: true },
    })
    const tooLarge = { state: 'too_large', message: REMOVAL_FULL }
    expect(await preview(b.t, b.f.admin, b.change, b.f.user.id)).toEqual(tooLarge)
    expect(await choices(b.t, b.f.admin, b.change)).toEqual(tooLarge)
  })
})

describe("the Reassign picker's search and cursors", () => {
  /* Pia's grant on TBED, with 30 more people who edit it and Zoë Ångström,
   * who sorts after them. */
  async function crowded() {
    const b = await base()
    const pia = await b.person('Pia')
    await b.grant(b.f.meta, pia)
    await b.task(b.f.sub, { assignee_id: pia.id })
    for (let i = 0; i < 30; i++)
      await b.grant(b.f.meta, await b.person(`Person ${String(i).padStart(2, '0')}`))
    const zoe = await b.person('Zoë Ångström')
    await b.grant(b.f.meta, zoe)
    await b.keyed()
    const change = { kind: 'user_grant', project_id: b.f.meta.id, user_id: pia.id } as const
    return { ...b, pia, zoe, change }
  }

  it('finds every word anywhere in a name, accents and case ignored, past the first batch', async () => {
    const c = await crowded()
    const first = ready(await choices(c.t, c.f.admin, c.change))
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first.rows.map((r) => r.id)).not.toContain(c.zoe.id)
    for (const search of ['ström ZOE', 'angstrom', 'oë'])
      expect(ready(await choices(c.t, c.f.admin, c.change, { search })).rows).toEqual([
        {
          id: c.zoe.id,
          name: 'Zoë Ångström',
          org_role: 'user',
          kind: 'person',
          active: true,
          pending: false,
        },
      ])
    const all = await listAll((after) => choices(c.t, c.f.admin, c.change, { after }))
    // 30 people, Zoë, admin, user, guest
    expect(all.ids).toHaveLength(34)
    expect(all.batches.map((b) => b.rows.length)).toEqual([LIST_BATCH, 34 - LIST_BATCH])
    expect(await choices(c.t, c.f.admin, c.change, { search: 'nobody' })).toEqual({
      state: 'ready',
      rows: [],
      next: null,
      stopped: false,
    })
  })

  it('refuses a search past LIMITS.search with its sentence', async () => {
    const c = await crowded()
    const e = await expectRefusal(
      choices(c.t, c.f.admin, c.change, { search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(e.data.message).toBe(LIMITS.search.refusal)
  })

  it('opens a cursor only for the organization, removal and search it came from', async () => {
    const c = await crowded()
    const next = ready(await choices(c.t, c.f.admin, c.change)).next
    if (next === null) throw new Error('expected a second batch')
    const other = { kind: 'team_grant', project_id: c.f.meta.id, team_id: c.f.team.id } as const
    for (const read of [
      () => choices(c.t, c.f.admin, other, { after: next }),
      () => choices(c.t, c.f.admin, c.change, { search: 'person', after: next }),
      () => choices(c.t, c.f.otherAdmin, c.change, { after: next }),
      () => choices(c.t, c.f.admin, c.change, { after: 'not a cursor' }),
    ])
      await expectRefusal(read(), 'bad_request', /cursors from an earlier answer/)
    expect(ready(await choices(c.t, c.f.admin, c.change, { after: next })).rows).toHaveLength(9)
  })

  it('stops a batch past its read budget and lists every person once by following its cursors', async () => {
    const c = await crowded()
    const whole = await listAll((after) => choices(c.t, c.f.admin, c.change, { after }))
    Object.assign(NAMED_READ, { documents: 6 })
    const parts = await listAll((after) => choices(c.t, c.f.admin, c.change, { after }))
    expect(parts.batches.some((b) => b.stopped)).toBe(true)
    // a stopped batch is never the end
    for (const b of parts.batches) if (b.stopped) expect(b.next).not.toBeNull()
    expect(parts.ids).toEqual(whole.ids)
    // a search that matches little stops on its way too, and never reads
    // as an end it did not reach
    const found = await listAll((after) =>
      choices(c.t, c.f.admin, c.change, { search: 'zoe', after }),
    )
    expect(found.ids).toEqual([c.zoe.id])
    expect(found.batches.length).toBeGreaterThan(1)
  })
})

/* ------------------------------------------------------- the design size */

describe("the Reassign picker inside Convex's limits", () => {
  /* A task title of ordinary length, about 80 characters. */
  const TITLE = 'Replace the fan controller on the bench rig and log the readings for the review'
  let num = 20_000

  /* What one transaction that runs `step` read, with what it answered. */
  const measured = <R>(t: T, step: (ctx: QueryCtx) => Promise<R>) =>
    t.run(async (ctx) => {
      const answer = await step(ctx)
      const m = await ctx.meta.getTransactionMetrics()
      return {
        answer,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      }
    })

  /* `n` open tasks of ordinary text in `project`, planted raw, each held by
   * `holder(i)`, and `done` more that are Done. */
  async function openTasks(
    t: T,
    f: OrgFixture,
    project: Doc<'projects'>,
    n: number,
    holder: (i: number) => string,
    done = 0,
  ) {
    for (let from = 0; from < n + done; from += 400)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(n + done, from + 400); i++)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: project.id,
            num: num++,
            title: TITLE,
            description: '',
            status: i < n ? 'todo' : 'done',
            priority: 'medium',
            paused: false,
            assignee_id: holder(i),
            created_at: NOW,
            updated_at: NOW,
          })
      })
  }

  /* People named `names`, keyed, planted raw 400 a transaction, each a
   * member of `teams` (a person in up to 3 teams, the everyday value). */
  async function people(
    t: T,
    f: OrgFixture,
    names: readonly string[],
    teams: readonly string[] = [],
  ): Promise<Doc<'profiles'>[]> {
    const out: Doc<'profiles'>[] = []
    for (let from = 0; from < names.length; from += 400)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(names.length, from + 400); i++) {
          const _id = await ctx.db.insert('profiles', {
            id: uuid(),
            org_id: f.org.id,
            name: names[i],
            name_key: nameKey(names[i]),
            initials: 'PP',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            auth_user_id: `auth_${uuid()}`,
            plannable_hours: 40,
            accepted_at: NOW,
            created_at: NOW,
          })
          const p = (await ctx.db.get(_id)) as Doc<'profiles'>
          for (const team_id of teams)
            await ctx.db.insert('team_members', {
              team_id,
              profile_id: p.id,
              is_leader: false,
              name_key: p.name_key,
            })
          out.push(p)
        }
      })
    return out
  }

  /* `n` names that sort in the order given. */
  const names = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

  /* A keyed team of the organization. */
  async function keyedTeam(t: T, f: OrgFixture, name: string): Promise<string> {
    const id = uuid()
    await t.run((ctx) =>
      ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name,
        name_key: nameKey(name),
        track_delay_default: false,
        created_at: NOW,
      }),
    )
    return id
  }

  /* A top-level project of the organization with `subs` sub-projects,
   * keyed, and `archived` more archived ones. */
  async function projectWith(t: T, f: OrgFixture, name: string, subs: number, archived = 0) {
    const meta = await plantProject(t, { org_id: f.org.id, name, name_key: nameKey(name) })
    const live: Doc<'projects'>[] = []
    for (let i = 0; i < subs + archived; i++) {
      const sub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: meta.id,
        name: `${name} ${i}`,
        name_key: nameKey(`${name} ${i}`),
        ...(i < subs ? {} : { archived_at: NOW }),
      })
      if (i < subs) live.push(sub)
    }
    return { meta, subs: live }
  }

  /* The first batch, a search's batch and the preview with `reassignTo` for
   * the change, each measured, logged under `name` and checked to answer
   * whole. Answers the first batch. */
  async function read(
    name: string,
    t: T,
    caller: Doc<'profiles'>,
    change: RemovalChange,
    o: { search: string; found: string; reassignTo: string },
  ) {
    const first = await measured(t, (ctx) => reassignChoicesOf(ctx, caller, { change }))
    const search = await measured(t, (ctx) =>
      reassignChoicesOf(ctx, caller, { change, search: o.search }),
    )
    const check = await measured(t, (ctx) => previewRemoval(ctx, caller, change, o.reassignTo))
    const firstBatch = ready(first.answer)
    const searchBatch = ready(search.answer)
    console.info(`reassign choices: ${name}`, {
      first: { ...first, answer: { rows: firstBatch.rows.length, stopped: firstBatch.stopped } },
      search: {
        ...search,
        answer: { rows: searchBatch.rows.length, stopped: searchBatch.stopped },
      },
      preview: { ...check, answer: check.answer.state },
    })
    expect(firstBatch.stopped).toBe(false)
    expect(searchBatch.stopped).toBe(false)
    expect(searchBatch.rows.map((r) => r.id)).toContain(o.found)
    if (check.answer.state !== 'ok') throw new Error(`the preview answered ${check.answer.state}`)
    expect(check.answer.reassign.holder_eligible).toBe(true)
    // the public queries answer the same under the deployment's limits
    expect(ready(await choices(t, caller, change)).rows).toEqual(firstBatch.rows)
    return firstBatch
  }

  /* withOrg with a third sub-project of TBED, Platform and Ops beside
   * Hardware, Hardware sharing Firmware at `level`, and 995 more people,
   * the organization's 1,000: Emil, 993 members and Zora Lindqvist, who
   * sorts last, each in the three teams. TBED's sub-projects hold 30 open
   * tasks each, held by its lead, and `holders` of the members hold one of
   * Firmware's instead, Emil two. */
  async function thousand(level: GrantLevel, holders = 0) {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const sub3 = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      name: 'Enclosure',
    })
    const platform = await keyedTeam(t, f, 'Platform')
    const ops = await keyedTeam(t, f, 'Ops')
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', { project_id: f.sub.id, team_id: f.team.id, level }),
    )
    await keyOrg(t, f.org.id)
    const crowd = await people(
      t,
      f,
      ['Emil', ...names('Member ', 993), 'Zora Lindqvist'],
      [f.team.id, platform, ops],
    )
    const emil = crowd[0]
    const firmware = [emil.id, emil.id, ...crowd.slice(1, 1 + holders).map((p) => p.id)]
    await openTasks(t, f, f.sub, 30, (i) => firmware[i] ?? f.user.id)
    for (const sub of [f.sub2, sub3]) await openTasks(t, f, sub, 30, () => f.user.id)
    return { t, f, crowd, emil, zora: crowd[crowd.length - 1] }
  }

  it('reads a member of a 995-member team leaving, in an organization of 1,000 people', async () => {
    const { t, f, emil, zora } = await thousand('user')
    const change = { kind: 'team_member', team_id: f.team.id, user_id: emil.id } as const
    const first = await read('a member of 995 leaves', t, f.user, change, {
      search: 'lindqvist',
      found: zora.id,
      reassignTo: zora.id,
    })
    expect(first.rows).toHaveLength(LIST_BATCH)
  }, 60_000)

  it('reads a member leaving where three people keep Edit through their own grants, in an organization of 1,000 people', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const atlas = await projectWith(t, f, 'Atlas', 3)
    const platform = await keyedTeam(t, f, 'Platform')
    const ops = await keyedTeam(t, f, 'Ops')
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: atlas.subs[0].id,
        team_id: f.team.id,
        level: 'viewer',
      }),
    )
    await keyOrg(t, f.org.id)
    const crowd = await people(t, f, ['Emil', ...names('Member ', 994)], [f.team.id, platform, ops])
    const [emil] = crowd
    const keepers = [crowd[100], crowd[500], crowd[900]]
    await t.run(async (ctx) => {
      for (const p of keepers)
        await ctx.db.insert('project_access', {
          project_id: atlas.subs[0].id,
          profile_id: p.id,
          level: 'user',
          name_key: p.name_key,
        })
    })
    const owners = [emil.id, emil.id]
    await openTasks(t, f, atlas.subs[0], 30, (i) => owners[i] ?? keepers[i % 3].id)
    for (const sub of atlas.subs.slice(1)) await openTasks(t, f, sub, 30, () => f.admin.id)
    const change = { kind: 'team_member', team_id: f.team.id, user_id: emil.id } as const
    const first = await read('three keep Edit among 1,000', t, f.admin, change, {
      search: keepers[2].name,
      found: keepers[2].id,
      reassignTo: keepers[0].id,
    })
    // every admin, user and guest walked: the admin, the three, and the end
    expect(first.rows.map((r) => r.id)).toEqual([f.admin.id, ...keepers.map((p) => p.id)])
    expect(first.next).toBeNull()
  }, 60_000)

  it("reads the team's share removed from the 995-member team, and the team deleted, in an organization of 1,000 people", async () => {
    const { t, f, crowd } = await thousand('user', 29)
    const holder = crowd[1]
    for (const [name, change] of [
      [
        'the share of a team of 995 removed',
        { kind: 'team_grant', project_id: f.sub.id, team_id: f.team.id },
      ],
      ['a team of 995 deleted', { kind: 'delete_team', team_id: f.team.id }],
    ] as const) {
      const first = await read(name, t, f.admin, change, {
        search: 'guest',
        found: f.guest.id,
        reassignTo: f.guest.id,
      })
      // the admin, TBED's lead and the guest, who edits TBED, and the end
      expect(first.rows.map((r) => r.name).sort()).toEqual(['admin', 'guest', 'user'])
      expect(first.next).toBeNull()
      const p = await previewOk(t, f.admin, change)
      expect(p.people.map((x) => x.id)).toContain(holder.id)
    }
  }, 60_000)

  it('reads a member leaving a team shared with 50 sub-projects and 150 archived ones, holding a task in each live one', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const wide = await keyedTeam(t, f, 'Wide')
    const platform = await keyedTeam(t, f, 'Platform')
    // 17 projects of 3 sub-projects, 50 of them shared, and 150 archived
    // sub-projects shared, 9 under each project but the last
    const shared: Doc<'projects'>[] = []
    for (let i = 0; i < 17; i++) {
      const { subs } = await projectWith(t, f, `Line ${i}`, 3, i < 16 ? 9 : 6)
      shared.push(...subs.slice(0, i < 16 ? 3 : 2))
    }
    const archived = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
        .then((all) => all.filter((p) => p.archived_at !== undefined)),
    )
    expect(shared).toHaveLength(50)
    expect(archived).toHaveLength(150)
    await t.run(async (ctx) => {
      for (const p of [...shared, ...archived])
        await ctx.db.insert('project_team_access', {
          project_id: p.id,
          team_id: wide,
          level: 'user',
          name_key: nameKey('Wide'),
        })
    })
    await keyOrg(t, f.org.id)
    const [mia, owen] = await people(t, f, ['Mia', 'Owen'], [wide, f.team.id, platform])
    for (const sub of shared) await openTasks(t, f, sub, 30, (i) => (i === 0 ? mia.id : owen.id))
    const change = { kind: 'team_member', team_id: wide, user_id: mia.id } as const
    const first = await read(
      'a member leaves a team shared with 50 and 150 archived',
      t,
      f.admin,
      change,
      {
        search: 'owen',
        found: owen.id,
        reassignTo: owen.id,
      },
    )
    expect(first.rows.map((r) => r.id)).toEqual([f.admin.id, owen.id])
    expect((await previewOk(t, f.admin, change)).tasks).toBe(50)
  }, 60_000)

  it("reads a person's grant removed from a sub-project shared with five teams", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const teams: string[] = []
    for (let i = 0; i < 5; i++) teams.push(await keyedTeam(t, f, `Crew ${i}`))
    await t.run(async (ctx) => {
      for (const team_id of teams)
        await ctx.db.insert('project_team_access', {
          project_id: f.sub.id,
          team_id,
          level: 'user',
          name_key: nameKey(`Crew ${teams.indexOf(team_id)}`),
        })
    })
    await keyOrg(t, f.org.id)
    // six people a crew, each also in the next two crews, so each person
    // is in three and each crew has 18 members
    const crew: Doc<'profiles'>[] = []
    for (let i = 0; i < 5; i++)
      crew.push(
        ...(await people(t, f, names(`Crew ${i} member `, 6), [
          teams[i],
          teams[(i + 1) % 5],
          teams[(i + 2) % 5],
        ])),
      )
    const [pia] = await people(t, f, ['Pia'])
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: pia.id,
        level: 'user',
        name_key: pia.name_key,
      }),
    )
    const owners = [pia.id, pia.id]
    await openTasks(t, f, f.sub, 30, (i) => owners[i] ?? f.user.id)
    const change = { kind: 'user_grant', project_id: f.sub.id, user_id: pia.id } as const
    const last = crew[crew.length - 1]
    const first = await read('a grant on a sub-project shared with 5 teams', t, f.admin, change, {
      search: last.name,
      found: last.id,
      reassignTo: last.id,
    })
    expect(first.rows).toHaveLength(LIST_BATCH)
  }, 60_000)

  it("reads a person's grant removed from a project with 800 open and 200 Done tasks, 100 of them theirs", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const atlas = await projectWith(t, f, 'Atlas', 3)
    await keyOrg(t, f.org.id)
    const [pia, ...keepers] = await people(t, f, [
      'Pia',
      'Keeper one',
      'Keeper two',
      'Keeper three',
    ])
    await t.run(async (ctx) => {
      for (const p of [pia, ...keepers])
        await ctx.db.insert('project_access', {
          project_id: atlas.meta.id,
          profile_id: p.id,
          level: 'user',
          name_key: p.name_key,
        })
    })
    // 267, 267 and 266 open tasks and 67, 67 and 66 Done, Pia's 34, 33
    // and 33 of the open ones
    for (const [i, sub] of atlas.subs.entries())
      await openTasks(
        t,
        f,
        sub,
        i < 2 ? 267 : 266,
        (k) => (k < (i === 0 ? 34 : 33) ? pia.id : keepers[k % 3].id),
        i < 2 ? 67 : 66,
      )
    const change = { kind: 'user_grant', project_id: atlas.meta.id, user_id: pia.id } as const
    const p = await previewOk(t, f.admin, change)
    expect(p.tasks).toBe(100)
    expect(p.items).toHaveLength(100)
    expect(p.reassign.allowed).toBe(true)
    const first = await read('a grant on a project of 800 open and 200 Done', t, f.admin, change, {
      search: 'keeper three',
      found: keepers[2].id,
      reassignTo: keepers[0].id,
    })
    expect(first.rows.map((r) => r.id)).toEqual([
      f.admin.id,
      keepers[0].id,
      keepers[2].id,
      keepers[1].id,
    ])
  }, 60_000)

  it("reads a person's grant removed from a project of 30 live and 40 archived sub-projects, holding a task in each live one", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const atlas = await projectWith(t, f, 'Atlas', 30, 40)
    await keyOrg(t, f.org.id)
    const [pia, keeper] = await people(t, f, ['Pia', 'Keeper'])
    await t.run(async (ctx) => {
      for (const p of [pia, keeper])
        await ctx.db.insert('project_access', {
          project_id: atlas.meta.id,
          profile_id: p.id,
          level: 'user',
          name_key: p.name_key,
        })
    })
    // 26 open tasks a sub-project, 780 in the project, inside its 800
    for (const sub of atlas.subs)
      await openTasks(t, f, sub, 26, (i) => (i === 0 ? pia.id : keeper.id))
    const change = { kind: 'user_grant', project_id: atlas.meta.id, user_id: pia.id } as const
    const first = await read(
      'a grant on a project of 30 and 40 archived sub-projects',
      t,
      f.admin,
      change,
      {
        search: 'keeper',
        found: keeper.id,
        reassignTo: keeper.id,
      },
    )
    expect(first.rows.map((r) => r.id)).toEqual([f.admin.id, keeper.id])
  }, 60_000)

  it("reads a person's grant removed in an organization of 2,000 projects, live and archived", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // withOrg's TBED and Skunkworks and TBED's two sub-projects, then 198
    // more live projects and 498 live sub-projects, 300 archived projects
    // and 1,000 archived sub-projects
    const tops: string[] = []
    await t.run(async (ctx) => {
      const insert = async (i: number, extra: Partial<Doc<'projects'>>) => {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'meta',
          key: `K${i}`,
          name: `Project ${i}`,
          name_key: nameKey(`Project ${i}`),
          description: '',
          sort_order: 100 + i,
          num: 100 + i,
          track_delay: false,
          created_at: NOW,
          ...extra,
        })
        return id
      }
      for (let i = 0; i < 498; i++) tops.push(await insert(i, i < 198 ? {} : { archived_at: NOW }))
    })
    for (let from = 0; from < 1498; from += 500)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(1498, from + 500); i++) {
          // 498 live sub-projects under the live projects, 1,000 archived
          // ones under the archived projects
          const parent = i < 498 ? tops[i % 198] : tops[198 + (i % 300)]
          await ctx.db.insert('projects', {
            id: uuid(),
            org_id: f.org.id,
            type: 'project',
            parent_id: parent,
            key: `S${i}`,
            name: `Sub-project ${i}`,
            name_key: nameKey(`Sub-project ${i}`),
            description: '',
            sort_order: 1000 + i,
            num: 1000 + i,
            track_delay: false,
            created_at: NOW,
            ...(i < 498 ? {} : { archived_at: NOW }),
          })
        }
      })
    await keyOrg(t, f.org.id)
    const count = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
        .then((all) => all.length),
    )
    expect(count).toBe(2000)
    const [pia, keeper] = await people(t, f, ['Pia', 'Keeper'])
    await t.run(async (ctx) => {
      for (const p of [pia, keeper])
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: p.id,
          level: 'user',
          name_key: p.name_key,
        })
    })
    const owners = [pia.id, pia.id]
    await openTasks(t, f, f.sub, 30, (i) => owners[i] ?? keeper.id)
    await openTasks(t, f, f.sub2, 30, () => keeper.id)
    const change = { kind: 'user_grant', project_id: f.meta.id, user_id: pia.id } as const
    const first = await read('a grant in an organization of 2,000 projects', t, f.admin, change, {
      search: 'keeper',
      found: keeper.id,
      reassignTo: keeper.id,
    })
    expect(first.rows.map((r) => r.name).sort()).toEqual(['Keeper', 'admin', 'guest', 'user'])
  }, 60_000)
})
