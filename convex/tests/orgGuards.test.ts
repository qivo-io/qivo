/* Public membership changes grow the billing quantity without a purchased-seat
 * cap. Last-admin, last-team, cross-org and identity protections remain. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { MARKETING_DEMO } from '../internal/marketingDemoData'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { northstarId, plantNorthstar } from './northstar.setup'
import { assertNoDanglingRefs } from './refs.setup'

const profileByUuid = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const orgProfiles = (t: T, orgId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
  )

/* Invitations go through the organization admin's public mutation. */
const addPerson = (t: T, f: OrgFixture, n: number) =>
  as(t, f.admin).mutation(api.profiles.create, {
    org_id: f.org.id,
    id: uuid(),
    name: `Extra ${n}`,
    email: `extra${n}@testbed.test`,
    org_role: 'user',
    kind: 'person',
    color: '#445566',
  })

const patchProfile = (t: T, f: OrgFixture, id: string, patch: Record<string, unknown>) =>
  as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch })

describe('membership growth without a purchased-seat cap', () => {
  it('admins add people and guests beyond the old five-seat allowance', async () => {
    const t = newT()
    const f = await withOrg(t)
    await addPerson(t, f, 5)
    await addPerson(t, f, 6)
    expect(
      (await orgProfiles(t, f.org.id)).filter((profile) => profile.org_role !== 'guest'),
    ).toHaveLength(6)
    const guestId = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id: guestId,
      name: 'Walk-in',
      email: 'walkin@guest.test',
      org_role: 'guest',
      kind: 'person',
      color: '#8A8F98',
    })
    expect((await profileByUuid(t, guestId))?.org_role).toBe('guest')
    await expectRefusal(
      as(t, f.user).mutation(api.profiles.create, {
        org_id: f.org.id,
        id: uuid(),
        name: 'Unauthorized',
        email: 'unauthorized@testbed.test',
        org_role: 'user',
        kind: 'person',
        color: '#445566',
      }),
      'forbidden',
    )
  })

  it('admins add agents beyond the old allowance without deactivating anybody', async () => {
    const t = newT()
    const f = await withOrg(t)
    await addPerson(t, f, 5)
    const agentId = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id: agentId,
      name: 'Beta',
      org_role: 'user',
      kind: 'agent',
      color: '#50b070',
    })
    expect((await profileByUuid(t, agentId))?.active).toBe(true)
    expect((await profileByUuid(t, f.agent.id))?.active).toBe(true)
  })

  it('reactivation and guest promotion grow the roster beyond the old allowance', async () => {
    const t = newT()
    const f = await withOrg(t)
    await addPerson(t, f, 5)
    const sleeper = await plantSeat(t, { org_id: f.org.id, name: 'Sleeper', active: false })
    await patchProfile(t, f, sleeper.id, { active: true })
    await patchProfile(t, f, f.guest.id, { org_role: 'user' })
    expect((await profileByUuid(t, sleeper.id))?.active).toBe(true)
    expect((await profileByUuid(t, f.guest.id))?.org_role).toBe('user')
    await expectRefusal(
      as(t, f.user).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: sleeper.id,
        patch: { active: false },
      }),
      'forbidden',
    )
  })

  it('organizations without billing can add users', async () => {
    const t = newT()
    const f = await withOrg(t) // otherOrg carries no billing
    for (let n = 1; n <= 3; n++) {
      await as(t, f.otherAdmin).mutation(api.profiles.create, {
        org_id: f.otherOrg.id,
        id: uuid(),
        name: `Boundless ${n}`,
        email: `boundless${n}@other.test`,
        org_role: 'user',
        kind: 'person',
        color: '#445566',
      })
    }
    expect((await orgProfiles(t, f.otherOrg.id)).length).toBe(4)
  })

  it('claims preserve home membership rules beyond the old seat allowance', async () => {
    const t = newT()
    const f = await withOrg(t)
    await addPerson(t, f, 5)
    // arm 1: a plain adoption of an unclaimed invitation
    const seat = await plantSeat(t, {
      org_id: f.org.id,
      name: 'New Hire',
      email: 'newhire@testbed.test',
    })
    const adopted = await t.mutation(internal.identity.claimSeatsInternal, {
      userId: 'auth_newhire',
      email: 'newhire@testbed.test',
      emailVerified: true,
    })
    expect(adopted).toBe(1)
    const claimed = (await profileByUuid(t, seat.id))!
    expect(claimed.auth_user_id).toBe('auth_newhire')
    expect(claimed.accepted_at).toBeDefined()
    expect(claimed.org_role).toBe('user') // no bootstrap promotion either — an admin holds a login
    // arm 2: the guest-ward demotion is an org_role change and STILL passes
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Wander Home',
      email: 'wander@example.test',
      auth_user_id: 'auth_wander',
      accepted_at: NOW,
    })
    const second = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Wander Guestward',
      email: 'wander@example.test',
    })
    const n2 = await t.mutation(internal.identity.claimSeatsInternal, {
      userId: 'auth_wander',
      email: 'wander@example.test',
      emailVerified: true,
    })
    expect(n2).toBe(1)
    const demoted = (await profileByUuid(t, second.id))!
    expect(demoted.auth_user_id).toBe('auth_wander')
    expect(demoted.org_role).toBe('guest') // second non-guest seat lands as guest
  })
})

describe('last admin — profiles_last_admin_* through the public doors (0099)', () => {
  it('the sole active admin can neither demote nor deactivate themselves; an inactive second admin frees nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      patchProfile(t, f, f.admin.id, { org_role: 'user' }),
      'rule',
      /^cannot demote the last admin$/,
    )
    await expectRefusal(
      patchProfile(t, f, f.admin.id, { active: false }),
      'rule',
      /^cannot demote the last admin$/,
    )
    await plantSeat(t, { org_id: f.org.id, name: 'Sleepy Admin', org_role: 'admin', active: false })
    await expectRefusal(
      patchProfile(t, f, f.admin.id, { org_role: 'user' }),
      'rule',
      /^cannot demote the last admin$/,
    )
  })

  it('a second ACTIVE admin frees the demotion; through remove, the caller always remains — so removing the other admin passes', async () => {
    const t = newT()
    const f = await withOrg(t)
    await patchProfile(t, f, f.user.id, { org_role: 'admin' })
    // self-removal has its own sentence, ahead of any counting
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.admin.id }),
      'rule',
      /^you cannot remove yourself$/,
    )
    /* 'cannot remove the last admin' cannot fire on this door while the SQL
     * shape holds: remove requires an ACTIVE admin caller, who is always the
     * "other" admin the count finds — removing the second admin therefore
     * PASSES. The remove-flavored sentence itself is pinned at the model
     * layer in orgs.test.ts (assertNotLastAdmin, 'remove'). */
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    expect(await profileByUuid(t, f.user.id)).toBeNull()
    // sole again — the demote guard is back…
    await expectRefusal(
      patchProfile(t, f, f.admin.id, { org_role: 'user' }),
      'rule',
      /^cannot demote the last admin$/,
    )
    // …until a second active admin exists
    await patchProfile(t, f, f.viewer.id, { org_role: 'admin' })
    await patchProfile(t, f, f.admin.id, { org_role: 'user' })
    expect((await profileByUuid(t, f.admin.id))?.org_role).toBe('user')
  })
})

describe('last team + delete authority — teams.deleteDeep (0078/0081)', () => {
  it('the fixture org holds one team: deleting it refuses; non-admins and unknown ids read their own sentences', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: f.team.id }),
      'rule',
      /^cannot delete the last team$/,
    )
    // the team leader is not an org admin — the SQL's own sentence
    await expectRefusal(
      as(t, f.user).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: f.team.id }),
      'rule',
      /^only organization admins can delete teams$/,
    )
    // unknown and foreign ids are indistinguishable — the uniform fence
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: uuid() }),
      'not_found',
      /^team not found$/,
    )
    await expectRefusal(
      as(t, f.otherAdmin).mutation(api.teams.deleteDeep, { org_id: f.otherOrg.id, id: f.team.id }),
      'not_found',
      /^team not found$/,
    )
  })
})

describe('teams.deleteDeep names its cascade — the Northstar Labs dataset', () => {
  /* Northstar Hardware has a shared permission grant on each product.
   * Projects are independent of teams, so deleting Hardware removes
   * only its memberships and permission grants. */
  it('removes team permissions while preserving projects, tasks and history', async () => {
    const t = newT()
    const { org } = await plantNorthstar(t)
    const count = async (
      table:
        | 'projects'
        | 'issues'
        | 'milestones'
        | 'issue_links'
        | 'issue_labels'
        | 'comments'
        | 'project_team_access'
        | 'team_members'
        | 'labels'
        | 'activity_events'
        | 'teams',
    ) => await t.run(async (ctx) => (await ctx.db.query(table).collect()).length)
    const hardware = await northstarId('team:northstar')
    const cloudLaunch = await northstarId('team:cloud-launch')
    const sensorTree = new Set(
      MARKETING_DEMO.projects
        .filter((p) => p.key === 'sensor' || p.parent === 'sensor')
        .map((p) => p.key),
    )
    const sensorIssues = MARKETING_DEMO.issues.filter((i) => sensorTree.has(i.project)).length
    const sensorMilestones = MARKETING_DEMO.milestones.filter((m) =>
      sensorTree.has(m.project),
    ).length

    // the dataset inventory the sentence names
    expect(await count('teams')).toBe(2)
    expect(await count('projects')).toBe(15)
    expect(await count('issues')).toBe(90)
    expect(await count('milestones')).toBe(7)
    expect(sensorTree.size).toBe(6)
    expect(sensorIssues).toBe(40)
    expect(sensorMilestones).toBe(3)
    const before = {
      links: await count('issue_links'),
      issueLabels: await count('issue_labels'),
      comments: await count('comments'),
      teamGrants: await count('project_team_access'),
      members: await count('team_members'),
      labels: await count('labels'),
      events: await count('activity_events'),
    }
    expect(before.teamGrants).toBe(6) // both teams hold a grant on each of the 3 metas
    expect(before.events).toBe(90) // one import event per task

    const asNora = t.withIdentity({ subject: 'auth_nora' })
    await asNora.mutation(api.teams.deleteDeep, { org_id: org.id, id: hardware })

    // all project work remains; only Hardware's membership and shares are gone
    expect(await count('teams')).toBe(1)
    expect(await count('projects')).toBe(15)
    expect(await count('issues')).toBe(90)
    expect(await count('milestones')).toBe(7)
    const survivors = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect(),
    )
    expect(survivors.map((p) => p.key).sort()).toEqual(
      MARKETING_DEMO.projects.map((p) => p.code).sort(),
    )
    expect(await count('issue_links')).toBe(before.links)
    expect(await count('issue_labels')).toBe(before.issueLabels)
    expect(await count('comments')).toBe(before.comments)
    expect(await count('project_team_access')).toBe(3)
    expect(await count('team_members')).toBe(
      MARKETING_DEMO.teams.find((team) => team.key === 'cloud-launch')?.members.length,
    )
    // labels are org-level and SURVIVE
    expect(await count('labels')).toBe(before.labels)
    // history survives its subjects: every row KEPT, the doomed refs nulled
    const events = await t.run(async (ctx) => await ctx.db.query('activity_events').collect())
    expect(events.length).toBe(before.events)
    expect(events.filter((e) => e.project_id === undefined).length).toBe(0)
    for (const e of events) {
      expect(e.team_id === undefined || e.team_id === cloudLaunch).toBe(true)
      expect(e.actor_id).toBeDefined() // the actors all live
    }
    await assertNoDanglingRefs(t, 'after Northstar delete_team')

    // Leo (Northstar Hardware's leader, org user) still cannot delete a team
    await expectRefusal(
      t
        .withIdentity({ subject: 'auth_leo' })
        .mutation(api.teams.deleteDeep, { org_id: org.id, id: cloudLaunch }),
      'rule',
      /^only organization admins can delete teams$/,
    )
    // and Cloud & Launch is now the last team
    await expectRefusal(
      asNora.mutation(api.teams.deleteDeep, { org_id: org.id, id: cloudLaunch }),
      'rule',
      /^cannot delete the last team$/,
    )
  })
})

describe('slug narration — orgs.setSlug narrates only a REAL change (0108)', () => {
  const slugEvents = (rows: Doc<'activity_events'>[]) =>
    rows.filter((e) => e.verb === 'changed the address of')

  it('same-value writes are silent no-ops on both sides of a real move', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the 0108 probe: writing the CURRENT address must not narrate
    await as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'testbed' })
    expect(slugEvents(await activityFor(t, f.org.id))).toEqual([])

    await as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'testbed-guards' })
    const rows = slugEvents(await activityFor(t, f.org.id))
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      org_id: f.org.id,
      actor_id: f.admin.id,
      verb: 'changed the address of',
      target_type: 'org',
      target_id: f.org.id,
      label: 'Testbed Labs', // the org NAME, not the slug
      detail: 'testbed → testbed-guards',
    })
    expect(rows[0].project_id).toBeUndefined()
    expect(rows[0].team_id).toBeUndefined()

    // repeating the NEW value is silent too — still exactly one row
    await as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'testbed-guards' })
    expect(slugEvents(await activityFor(t, f.org.id)).length).toBe(1)
    const org = await t.run(async (ctx) =>
      ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', f.org.id))
        .unique(),
    )
    expect(org?.slug).toBe('testbed-guards')
  })
})
