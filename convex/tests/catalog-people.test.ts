/* Phase-5 people surfaces: profiles.* and teams.* public mutations — the
 * invitation door (create), the admin door (update), removal + cascade, the
 * plannable-hours rights matrix, the two rename doors, retention, and the
 * team settings/membership verbs. Sentences asserted VERBATIM (they are SQL
 * trigger/RPC prose or client sentences the server now owns; the client
 * toasts them byte-for-byte). */
/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { newOrgDefaults } from '../model/orgs'
import {
  activityFor,
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const profileById = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const teamById = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('teams')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const membership = (t: T, teamId: string, profileId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('team_members')
      .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', profileId))
      .unique(),
  )

const personArgs = (f: OrgFixture, extra: Record<string, unknown> = {}) => ({
  org_id: f.org.id,
  id: uuid(),
  name: 'New Person',
  email: `p${Math.floor(Math.random() * 1e9)}@x.se`,
  org_role: 'user' as const,
  kind: 'person' as const,
  color: '#123456',
  ...extra,
})

describe('profiles.create — the org-seat invitation', () => {
  it('stamps defaults, lands team rows, narrates added and grows beyond the old seat allowance', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id,
      name: ' Anna  Larsson ',
      email: 'Anna.L@Example.SE',
      org_role: 'user',
      kind: 'person',
      color: '#123456',
      teams: [f.team.id],
    })
    const row = await profileById(t, id)
    expect(row).toMatchObject({
      org_id: f.org.id,
      name: 'Anna Larsson', // whitespace runs collapsed
      initials: 'AL', // nameInitials, not the invite-guest rule
      email: 'anna.l@example.se', // lowercased
      org_role: 'user',
      active: true,
      kind: 'person',
      plannable_hours: 40, // the org default
      message_retention_days: 7, // no sibling seat ⇒ the old column default, stamped
    })
    expect(row?.accepted_at).toBeUndefined() // the seat IS the invitation
    expect(row?.auth_user_id).toBeUndefined()
    expect((await membership(t, f.team.id, id))?.is_leader).toBe(false)
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'added',
      target_type: 'user',
      target_id: id,
      label: 'Anna Larsson',
      detail: 'to the organization',
      actor_id: f.admin.id,
    })
    expect(events[0].project_id).toBeUndefined()
    expect(events[0].team_id).toBeUndefined()
    // Adding another active user succeeds beyond the old five-seat allowance.
    const extra = personArgs(f, { email: 'late@x.se' })
    await as(t, f.admin).mutation(api.profiles.create, extra)
    expect((await profileById(t, extra.id))?.active).toBe(true)
    // A replayed uuid is still refused.
    await expectRefusal(
      as(t, f.admin).mutation(
        api.profiles.create,
        personArgs(f, { id, email: 'g2@x.se', org_role: 'guest' }),
      ),
      'bad_request',
      /id already exists/,
    )
  })

  it('agent shape: no mailbox, user/viewer only, no plannable week; the agent detail', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id,
      name: 'Courier',
      org_role: 'viewer',
      kind: 'agent',
      color: '#50b070',
    })
    const row = await profileById(t, id)
    expect(row?.kind).toBe('agent')
    expect(row?.email).toBeUndefined()
    expect(row?.plannable_hours).toBeUndefined() // (kind='agent') = (hours is null)
    expect(row?.message_retention_days).toBe(7)
    const events = await activityFor(t, f.org.id)
    expect(events[events.length - 1]).toMatchObject({
      verb: 'added',
      label: 'Courier',
      detail: 'to the organization as an agent',
    })
    const mailed = await expectRefusal(
      as(t, f.admin).mutation(
        api.profiles.create,
        personArgs(f, { kind: 'agent', email: 'bot@x.se' }),
      ),
      'rule',
    )
    expect(mailed.data.message).toBe('An agent has no email address — its login is a key')
    const promoted = await expectRefusal(
      as(t, f.admin).mutation(
        api.profiles.create,
        personArgs(f, { kind: 'agent', email: null, org_role: 'admin' }),
      ),
      'rule',
    )
    expect(promoted.data.message).toBe(
      'an agent cannot be an organization admin — it reaches only the projects it is added to',
    )
    await expectRefusal(
      as(t, f.admin).mutation(
        api.profiles.create,
        personArgs(f, { kind: 'agent', email: null, org_role: 'guest' }),
      ),
      'bad_request',
    )
  })

  it('person email rules: required with shape, unique per org; teams fenced; admin only', async () => {
    const t = newT()
    const f = await withOrg(t)
    const needs = await expectRefusal(
      as(t, f.admin).mutation(api.profiles.create, personArgs(f, { email: null })),
      'rule',
    )
    expect(needs.data.message).toBe(
      'A person needs an email address — it is what they sign in with',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.create, personArgs(f, { email: 'not an address' })),
      'rule',
      /^A person needs an email address/,
    )
    const dup = await expectRefusal(
      as(t, f.admin).mutation(api.profiles.create, personArgs(f, { email: f.user.email })),
      'rule',
    )
    expect(dup.data.message).toBe('user@testbed.test already has a seat in this organization')
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.create, personArgs(f, { teams: [uuid()] })),
      'not_found',
      /^team not found$/,
    )
    await expectRefusal(as(t, f.user).mutation(api.profiles.create, personArgs(f)), 'forbidden')
  })

  it('retention inheritance (0112): the oldest sibling by address wins, copying even Never', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: 'bo@x.se',
      message_retention_days: 30,
      created_at: '2025-06-01T00:00:00.000Z',
    })
    const bo = uuid()
    await as(t, f.admin).mutation(api.profiles.create, personArgs(f, { id: bo, email: 'bo@x.se' }))
    expect((await profileById(t, bo))?.message_retention_days).toBe(30)
    // a sibling whose value is absent-meaning-Never is copied too (FOUND
    // semantics), including a guest invitation
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: 'nils@x.se',
      created_at: '2025-06-01T00:00:00.000Z',
    })
    const nils = uuid()
    await as(t, f.admin).mutation(
      api.profiles.create,
      personArgs(f, { id: nils, email: 'nils@x.se', org_role: 'guest' }),
    )
    expect((await profileById(t, nils))?.message_retention_days).toBeUndefined()
  })
})

describe('profiles.update — the admin door', () => {
  it('a real rename writes ONE renamed row with the old name; a same-value write is silent', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: f.user.id,
      patch: { name: '  Ulla   Berg ' },
    })
    const row = await profileById(t, f.user.id)
    expect(row?.name).toBe('Ulla Berg')
    expect(row?.initials).toBe('UB') // refreshed with the rename
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'renamed',
      target_type: 'user',
      target_id: f.user.id,
      label: 'Ulla Berg',
      detail: 'from “user”',
      actor_id: f.admin.id,
    })
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: f.user.id,
      patch: { name: 'Ulla Berg' },
    })
    expect(await activityFor(t, f.org.id)).toHaveLength(1) // still one
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.user.id,
        patch: { name: '   ' },
      }),
      'rule',
      /^a name cannot be blank$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.user.id,
        patch: { name: 'x'.repeat(81) },
      }),
      'rule',
      /^a name is at most 80 characters$/,
    )
  })

  it('email: the claimed-seat refusal verbatim; an unclaimed address is corrected, never emptied', async () => {
    const t = newT()
    const f = await withOrg(t)
    // f.user signed in with their address — it is no longer the admin's to edit
    const claimed = await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.user.id,
        patch: { email: 'new@x.se' },
      }),
      'rule',
    )
    expect(claimed.data.message).toBe(
      'This seat has been claimed — its address is the one they signed in with',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.agent.id,
        patch: { email: 'bot@x.se' },
      }),
      'rule',
      /^An agent has no email address — its login is a key$/,
    )
    const invitee = await plantSeat(t, { org_id: f.org.id, email: 'invitee@x.se', name: 'Invitee' })
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: invitee.id,
      patch: { email: ' Fixed@X.SE ' },
    })
    expect((await profileById(t, invitee.id))?.email).toBe('fixed@x.se')
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: invitee.id,
        patch: { email: f.user.email },
      }),
      'rule',
      /already has a seat in this organization$/,
    )
    // never emptied (0104), and shape still holds
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: invitee.id,
        patch: { email: null },
      }),
      'rule',
      /^A person needs an email address/,
    )
  })

  it('role edges: demote-self last admin; viewer-leads-nothing; the teams diff and its guest fence', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const patch of [{ org_role: 'user' as const }, { active: false }]) {
      const r = await expectRefusal(
        as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id: f.admin.id, patch }),
        'rule',
      )
      expect(r.data.message).toBe('cannot demote the last admin')
    }
    // f.user leads the Skunkworks meta — projects are checked first
    const leadsProjects = await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.user.id,
        patch: { org_role: 'viewer' },
      }),
      'rule',
    )
    expect(leadsProjects.data.message).toBe(
      'user leads 2 project(s) — hand those over before making them a viewer',
    )
    // Hand both projects over; team leadership is checked independently.
    await t.run(async (ctx) => {
      const hidden = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.hidden.id))
        .unique()
      await ctx.db.patch(hidden!._id, { lead_id: undefined })
      const meta = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique()
      await ctx.db.patch(meta!._id, { lead_id: undefined })
    })
    // Team leadership remains a separate responsibility and still blocks
    // demotion until the team is handed over.
    const leadsTeams = await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.user.id,
        patch: { org_role: 'viewer' },
      }),
      'rule',
    )
    expect(leadsTeams.data.message).toBe(
      'user leads 1 team(s) — hand those over before making them a viewer',
    )
    // a guest never joins a team through the diff either
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.guest.id,
        patch: { teams: [f.team.id] },
      }),
      'forbidden',
      /^a guest is never a team member$/,
    )
    // a viewer may sit on a team (0102:332); adds arrive as plain members
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: f.viewer.id,
      patch: { teams: [f.team.id] },
    })
    expect((await membership(t, f.team.id, f.viewer.id))?.is_leader).toBe(false)
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: f.viewer.id,
      patch: { teams: [] },
    })
    expect(await membership(t, f.team.id, f.viewer.id)).toBeNull()
    // role/active/teams narrate NOTHING — the whole test wrote zero events
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('a seat on a team becomes a guest only when the same patch leaves every team', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (id: string, patch: Record<string, unknown>) =>
      as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch })
    await update(f.viewer.id, { teams: [f.team.id] })
    // a member and a leader both keep their role and their team
    for (const p of [f.viewer, f.user]) {
      await expectRefusal(
        update(p.id, { org_role: 'guest' }),
        'forbidden',
        /^a guest is never a team member$/,
      )
      expect((await profileById(t, p.id))?.org_role).toBe(p.org_role)
      expect(await membership(t, f.team.id, p.id)).not.toBeNull()
    }
    await expectRefusal(
      update(f.user.id, { org_role: 'guest', teams: [f.team.id] }),
      'forbidden',
      /^a guest is never a team member$/,
    )
    // leaving every team in the same patch demotes; the team keeps running
    await update(f.user.id, { org_role: 'guest', teams: [] })
    expect((await profileById(t, f.user.id))?.org_role).toBe('guest')
    expect(await membership(t, f.team.id, f.user.id)).toBeNull()
    await as(t, f.admin).mutation(api.teams.setLeader, {
      org_id: f.org.id,
      team_id: f.team.id,
      profile_id: f.admin.id,
      is_leader: true,
    })
    expect((await membership(t, f.team.id, f.admin.id))?.is_leader).toBe(true)
    // a seat on no team becomes a guest without naming teams
    await update(f.viewer.id, { teams: [] })
    await update(f.viewer.id, { org_role: 'guest' })
    expect((await profileById(t, f.viewer.id))?.org_role).toBe('guest')
    // a guest left with a stale membership can still be edited and cleaned up
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.guest.id,
        is_leader: true,
      }),
    )
    await update(f.guest.id, { name: 'Renamed guest' })
    expect((await profileById(t, f.guest.id))?.name).toBe('Renamed guest')
    await update(f.guest.id, { teams: [] })
    expect(await membership(t, f.team.id, f.guest.id)).toBeNull()
  })

  it('leaving the guest role drops memberships kept from before', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (id: string, patch: Record<string, unknown>) =>
      as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch })
    const stale = () =>
      t.run((ctx) =>
        ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: f.guest.id,
          is_leader: true,
        }),
      )
    await stale()
    await update(f.guest.id, { org_role: 'user' })
    expect(await membership(t, f.team.id, f.guest.id)).toBeNull()
    // back to guest, with a stale leader row again; a listed team arrives
    // as a plain member, never as the old leadership
    await update(f.guest.id, { org_role: 'guest' })
    await stale()
    await update(f.guest.id, { org_role: 'viewer', teams: [f.team.id] })
    expect((await membership(t, f.team.id, f.guest.id))?.is_leader).toBe(false)
  })
})

describe('profiles.update and the project-creation right', () => {
  const flaggedSeat = (t: T, f: OrgFixture, extra: Record<string, unknown> = {}) =>
    plantSeat(t, { org_id: f.org.id, can_create_projects: true, ...extra })

  it('an admin turns the right on and off for a standard user; off is stored as absent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (patch: { can_create_projects: boolean }) =>
      as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id: f.user.id, patch })
    await update({ can_create_projects: true })
    expect((await profileById(t, f.user.id))?.can_create_projects).toBe(true)
    await update({ can_create_projects: false })
    const row = await profileById(t, f.user.id)
    expect(row).not.toHaveProperty('can_create_projects')
    expect(row?.org_role).toBe('user')
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('gives the right to a Standard user agent like a person, and off is stored as absent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (can_create_projects: boolean) =>
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: f.agent.id,
        patch: { can_create_projects },
      })
    await update(true)
    expect((await profileById(t, f.agent.id))?.can_create_projects).toBe(true)
    await update(false)
    expect(await profileById(t, f.agent.id)).not.toHaveProperty('can_create_projects')
  })

  it('refuses the right for viewers, Viewer agents, guests and admins; turning it off is accepted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const viewerAgent = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Ledger',
      kind: 'agent',
      org_role: 'viewer',
      plannable_hours: undefined,
    })
    const update = (id: string, can_create_projects: boolean) =>
      as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id,
        patch: { can_create_projects },
      })
    for (const p of [f.viewer, viewerAgent, f.guest, f.admin]) {
      await expectRefusal(
        update(p.id, true),
        'rule',
        /^only a standard user can be allowed to create projects$/,
      )
    }
    // a stale value planted raw, so turning it off has something to clear
    const stale = [viewerAgent, f.viewer, f.guest, f.admin]
    await t.run(async (ctx) => {
      for (const p of stale) await ctx.db.patch(p._id, { can_create_projects: true })
    })
    for (const p of stale) {
      await update(p.id, false)
      expect(await profileById(t, p.id)).not.toHaveProperty('can_create_projects')
    }
  })

  it('only an org admin may set the right', async () => {
    const t = newT()
    const f = await withOrg(t)
    const seat = await plantSeat(t, { org_id: f.org.id })
    for (const caller of [f.user, f.viewer, f.guest, f.otherAdmin]) {
      await expectRefusal(
        as(t, caller).mutation(api.profiles.update, {
          org_id: f.org.id,
          id: caller === f.user ? f.user.id : seat.id,
          patch: { can_create_projects: true },
        }),
        'forbidden',
      )
    }
    expect((await profileById(t, f.user.id))?.can_create_projects).toBeUndefined()
    expect((await profileById(t, seat.id))?.can_create_projects).toBeUndefined()
  })

  it('a role change away from standard user clears the right; deactivating keeps it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (id: string, patch: Record<string, unknown>) =>
      as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch })
    for (const org_role of ['viewer', 'admin', 'guest'] as const) {
      const seat = await flaggedSeat(t, f)
      await update(seat.id, { org_role })
      const row = await profileById(t, seat.id)
      expect(row?.org_role).toBe(org_role)
      expect(row?.can_create_projects).toBeUndefined()
    }
    const kept = await flaggedSeat(t, f)
    await update(kept.id, { active: false })
    expect((await profileById(t, kept.id))?.can_create_projects).toBe(true)
    // the role select sends the unchanged role with active: true
    await update(kept.id, { org_role: 'user', active: true })
    expect((await profileById(t, kept.id))?.can_create_projects).toBe(true)
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('making someone a standard user sets the right only when the same patch turns it on', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (id: string, patch: Record<string, unknown>) =>
      as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch })
    const promoted = await plantSeat(t, { org_id: f.org.id, org_role: 'viewer' })
    await update(promoted.id, { org_role: 'user', can_create_projects: true })
    expect(await profileById(t, promoted.id)).toMatchObject({
      org_role: 'user',
      can_create_projects: true,
    })
    // a stale value left on a viewer never comes back with the role
    const stale = await flaggedSeat(t, f, { org_role: 'viewer' })
    await update(stale.id, { org_role: 'user' })
    const row = await profileById(t, stale.id)
    expect(row?.org_role).toBe('user')
    expect(row?.can_create_projects).toBeUndefined()
    // and a demotion in the same patch as turning it on is refused whole
    await expectRefusal(
      update(promoted.id, { org_role: 'viewer', can_create_projects: true }),
      'rule',
      /^only a standard user can be allowed to create projects$/,
    )
    expect((await profileById(t, promoted.id))?.org_role).toBe('user')
  })

  it('the right schedules no billing reconcile, unlike a role change', async () => {
    vi.useFakeTimers()
    vi.stubEnv('POLAR_ACCESS_TOKEN', 'test-token')
    try {
      const t = newT()
      const f = await withOrg(t)
      const scheduled = () => t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      const update = (patch: Record<string, unknown>) =>
        as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id: f.user.id, patch })
      await update({ can_create_projects: true })
      await update({ can_create_projects: false })
      expect(await scheduled()).toEqual([])
      // the control: a real role change does mark billing
      await update({ org_role: 'guest', teams: [] })
      expect((await scheduled()).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })
})

describe('profiles.deactivate', () => {
  it("switches a seat off with update's guards and refuses a non-admin", async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.user).mutation(api.profiles.deactivate, { org_id: f.org.id, id: f.viewer.id }),
      'forbidden',
      /^admin only$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.deactivate, { org_id: f.org.id, id: f.admin.id }),
      'rule',
      /^cannot demote the last admin$/,
    )
    await as(t, f.admin).mutation(api.profiles.deactivate, { org_id: f.org.id, id: f.user.id })
    expect(await profileById(t, f.user.id)).toMatchObject({ active: false, org_role: 'user' })
    expect(await profileById(t, f.viewer.id)).toMatchObject({ active: true })
  })
})

describe('profiles.remove', () => {
  it('folds no-row/foreign/non-admin into ONE sentence; self refused; cascade + removed narration', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the SQL raised the same sentence for all three — a probing uuid learns nothing
    await expectRefusal(
      as(t, f.user).mutation(api.profiles.remove, { org_id: f.org.id, id: f.viewer.id }),
      'rule',
      /^user not found$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: uuid() }),
      'rule',
      /^user not found$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.admin.id }),
      'rule',
      /^you cannot remove yourself$/,
    )
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.guest.id,
    })
    const reviewed = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      assignee_id: f.admin.id,
      reviewer_id: f.guest.id,
    })
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.guest.id, issue_id: issue.id })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.guest.id })
    expect(await profileById(t, f.guest.id)).toBeNull()
    // grants and inbox die with the seat; assigned issues detach WITH a touch
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('project_access')
          .withIndex('by_profile', (q) => q.eq('profile_id', f.guest.id))
          .collect(),
      ),
    ).toEqual([])
    expect(await messagesFor(t, f.guest.id)).toEqual([])
    const orphan = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', issue.id))
        .unique(),
    )
    expect(orphan?.assignee_id).toBeUndefined()
    expect(orphan?.updated_at).not.toBe(NOW) // issues_touch fired
    // …and so do the issues the seat reviewed, keeping their assignee
    const unreviewed = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', reviewed.id))
        .unique(),
    )
    expect(unreviewed?.reviewer_id).toBeUndefined()
    expect(unreviewed?.assignee_id).toBe(f.admin.id)
    expect(unreviewed?.updated_at).not.toBe(NOW)
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'removed',
      target_type: 'user',
      target_id: f.guest.id,
      label: 'guest',
      detail: 'from the organization',
      actor_id: f.admin.id,
    })
  })
})

describe('profiles.setPlannableHours — the rights matrix', () => {
  const RIGHTS =
    "only an organization admin or a leader of one of this person's teams can set their plannable hours"

  it('admin and a shared-team leader may; everyone else reads ONE sentence; agent and range verbatim', async () => {
    const t = newT()
    const f = await withOrg(t)
    const set = (caller: Doc<'profiles'>, profile_id: string, hours: number) =>
      as(t, caller).mutation(api.profiles.setPlannableHours, {
        org_id: f.org.id,
        profile_id,
        hours,
      })
    await set(f.admin, f.viewer.id, 37.4)
    expect((await profileById(t, f.viewer.id))?.plannable_hours).toBe(37) // rounded
    // f.user leads Hardware, f.admin sits on it — the leader qualifies
    await set(f.user, f.admin.id, 20)
    expect((await profileById(t, f.admin.id))?.plannable_hours).toBe(20)
    // no shared team, unknown uuid, foreign profile, and an agent target for a
    // non-leader: all the SAME sentence — probing uuids learns nothing
    for (const target of [f.viewer.id, uuid(), f.otherAdmin.id, f.agent.id]) {
      const r = await expectRefusal(set(f.user, target, 10), 'rule')
      expect(r.data.message).toBe(RIGHTS)
    }
    // a leader row held by a guest or a viewer grants nothing
    for (const caller of [f.guest, f.viewer]) {
      await t.run((ctx) =>
        ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: caller.id,
          is_leader: true,
        }),
      )
      const r = await expectRefusal(set(caller, f.admin.id, 10), 'rule')
      expect(r.data.message).toBe(RIGHTS)
    }
    expect((await profileById(t, f.admin.id))?.plannable_hours).toBe(20)
    // a guest is never a team member, so a stale row gives a leader no rights
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.guest.id,
        is_leader: false,
      }),
    )
    const overGuest = await expectRefusal(set(f.user, f.guest.id, 10), 'rule')
    expect(overGuest.data.message).toBe(RIGHTS)
    await set(f.admin, f.guest.id, 12)
    expect((await profileById(t, f.guest.id))?.plannable_hours).toBe(12)
    // the agent check sits AFTER rights: only someone entitled reads it
    const agent = await expectRefusal(set(f.admin, f.agent.id, 10), 'rule')
    expect(agent.data.message).toBe('an agent has no plannable week — its capacity is unbounded')
    for (const hours of [0.4, 169, -3]) {
      const r = await expectRefusal(set(f.admin, f.viewer.id, hours), 'rule')
      expect(r.data.message).toBe('plannable hours must be a whole number of hours from 1 to 168')
    }
  })
})

describe('profiles.setDisplayName — the self door, fanned out', () => {
  it('renames every matched seat with ONE renamed row per touched org, actor per org', async () => {
    const t = newT()
    const f = await withOrg(t)
    const thirdOrgId = uuid()
    await t.run((ctx) =>
      ctx.db.insert('organizations', {
        id: thirdOrgId,
        name: 'Inviting organization',
        slug: 'inviting-org',
        ...newOrgDefaults(NOW),
      }),
    )
    // the auth arm: a claimed seat of the same login in another org
    const seatAuth = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.user.auth_user_id,
      name: 'user',
    })
    // the unclaimed-invitation arm: a seat carrying the claimed address
    const seatInvite = await plantSeat(t, { org_id: thirdOrgId, email: f.user.email })
    const res = await as(t, f.user).mutation(api.profiles.setDisplayName, {
      name: ' Nya   Namnet ',
    })
    expect(res).toBeNull()
    for (const id of [f.user.id, seatAuth.id, seatInvite.id]) {
      const row = await profileById(t, id)
      expect(row?.name).toBe('Nya Namnet')
      expect(row?.initials).toBe('NN')
    }
    const home = await activityFor(t, f.org.id)
    expect(home).toHaveLength(1)
    expect(home[0]).toMatchObject({
      verb: 'renamed',
      target_type: 'user',
      target_id: f.user.id,
      label: 'Nya Namnet',
      detail: 'from “user”',
      actor_id: f.user.id, // a self-rename: the renamed row itself
    })
    const other = await activityFor(t, f.otherOrg.id)
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({
      target_id: seatAuth.id,
      detail: 'from “user”',
      actor_id: seatAuth.id, // the caller's profile in THAT org
    })
    const third = await activityFor(t, thirdOrgId)
    expect(third).toHaveLength(1)
    expect(third[0]).toMatchObject({ target_id: seatInvite.id, detail: 'from “Seat”' })
    expect(third[0].actor_id).toBeUndefined() // no seat there — the feed's "Someone"
    // a same-value call touches nothing and narrates nowhere
    expect(
      await as(t, f.user).mutation(api.profiles.setDisplayName, { name: 'Nya Namnet' }),
    ).toBeNull()
    expect(await activityFor(t, f.org.id)).toHaveLength(1)
    expect(await activityFor(t, f.otherOrg.id)).toHaveLength(1)
    expect(await activityFor(t, thirdOrgId)).toHaveLength(1)
  })

  it('returns its sentences instead of throwing; nothing moves on a refusal', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await as(t, f.user).mutation(api.profiles.setDisplayName, { name: '   ' })).toBe(
      'a name cannot be blank',
    )
    expect(
      await as(t, f.user).mutation(api.profiles.setDisplayName, { name: 'x'.repeat(81) }),
    ).toBe('a name is at most 80 characters')
    expect(
      await t
        .withIdentity({ subject: 'auth_nobody' })
        .mutation(api.profiles.setDisplayName, { name: 'Real Name' }),
    ).toBe('no profile for this account')
    expect((await profileById(t, f.user.id))?.name).toBe('user')
    expect(await activityFor(t, f.org.id)).toEqual([])
  })
})

describe('profiles.setMessageRetention', () => {
  it('follows the person across seats; null stores as ABSENT; the range sentence verbatim', async () => {
    const t = newT()
    const f = await withOrg(t)
    const seatInvite = await plantSeat(t, { org_id: f.otherOrg.id, email: f.user.email })
    await as(t, f.user).mutation(api.profiles.setMessageRetention, { days: 30 })
    expect((await profileById(t, f.user.id))?.message_retention_days).toBe(30)
    expect((await profileById(t, seatInvite.id))?.message_retention_days).toBe(30)
    await as(t, f.user).mutation(api.profiles.setMessageRetention, { days: null })
    expect((await profileById(t, f.user.id))?.message_retention_days).toBeUndefined()
    expect((await profileById(t, seatInvite.id))?.message_retention_days).toBeUndefined()
    for (const days of [0, 1.5, 3651]) {
      const r = await expectRefusal(
        as(t, f.user).mutation(api.profiles.setMessageRetention, { days }),
        'rule',
      )
      expect(r.data.message).toBe(
        'message retention must be NULL (never) or a whole number of days from 1 to 3650',
      )
    }
    // unlike setDisplayName, this door THROWS its no-seat sentence
    await expectRefusal(
      t
        .withIdentity({ subject: 'auth_nobody' })
        .mutation(api.profiles.setMessageRetention, { days: 5 }),
      'rule',
      /^no profile for this account$/,
    )
    expect(await activityFor(t, f.org.id)).toEqual([]) // retention never narrates
  })
})

describe('teams.create / teams.update', () => {
  it('create is admin-only, silent, and stamps newTeamDefaults; a replayed uuid is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id, name: 'Design' })
    expect(await teamById(t, id)).toMatchObject({
      org_id: f.org.id,
      name: 'Design',
      stale_days: 120,
      archive_days: 30,
      track_delay_default: true,
    })
    expect((await teamById(t, id))?.max_attachment_mb).toBeUndefined()
    expect(await activityFor(t, f.org.id)).toEqual([]) // teams never narrate
    await expectRefusal(
      as(t, f.user).mutation(api.teams.create, { org_id: f.org.id, id: uuid(), name: 'Coup' }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id, name: 'Again' }),
      'bad_request',
      /id already exists/,
    )
  })

  it('settings clamp to their bounds and narrate nothing; icon strings are fenced', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the team leader qualifies, not just the admin
    await as(t, f.user).mutation(api.teams.update, {
      org_id: f.org.id,
      id: f.team.id,
      patch: {
        name: 'HW',
        stale_days: 0,
        archive_days: 99999,
        track_delay_default: true,
        icon: 'zap',
      },
    })
    expect(await teamById(t, f.team.id)).toMatchObject({
      name: 'HW',
      stale_days: 1,
      archive_days: 3650,
      track_delay_default: true,
      icon: 'zap',
    })
    await as(t, f.admin).mutation(api.teams.update, {
      org_id: f.org.id,
      id: f.team.id,
      patch: { icon: null },
    })
    const row = await teamById(t, f.team.id)
    expect(row?.icon).toBeUndefined() // null clears the field
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.update, {
        org_id: f.org.id,
        id: f.team.id,
        patch: { icon: 'x'.repeat(41) },
      }),
      'bad_request',
    )
    /* icon_color is allowlisted, not length-capped: the glyph draws it as SVG
       paint, and a 19-character value already fits an attribute break-out. */
    for (const bad of [
      'y'.repeat(21),
      '" onclick=alert(1) ',
      'red',
      '#abc',
      '#GGGGGG',
      'rainbow ',
    ]) {
      await expectRefusal(
        as(t, f.admin).mutation(api.teams.update, {
          org_id: f.org.id,
          id: f.team.id,
          patch: { icon_color: bad },
        }),
        'bad_request',
        /^an icon color must be a #rrggbb hex$/,
      )
    }
    for (const ok of ['#0366D6', '#0366d6', 'rainbow']) {
      await as(t, f.admin).mutation(api.teams.update, {
        org_id: f.org.id,
        id: f.team.id,
        patch: { icon_color: ok },
      })
      expect((await teamById(t, f.team.id))?.icon_color).toBe(ok)
    }
    await expectRefusal(
      as(t, f.guest).mutation(api.teams.update, {
        org_id: f.org.id,
        id: f.team.id,
        patch: { name: 'Mine' },
      }),
      'forbidden',
      /^requires an organization admin or a leader of this team$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.update, { org_id: f.org.id, id: uuid(), patch: {} }),
      'not_found',
      /^team not found$/,
    )
    // rename + every settings write above: zero activity
    expect(await activityFor(t, f.org.id)).toEqual([])
  })
})

describe('teams attachment cap removal', () => {
  it('rejects the legacy team setting at the wire boundary even for an administrator', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expect(
      as(t, f.admin).mutation(api.teams.update, {
        org_id: f.org.id,
        id: f.team.id,
        patch: { max_attachment_mb: 1 },
      } as never),
    ).rejects.toThrow(/max_attachment_mb/)
    expect((await teamById(t, f.team.id))?.max_attachment_mb).toBeUndefined()
  })
})

describe('teams membership — the three verbs', () => {
  it('addMember/removeMember narrate against the USER on the team branch; both idempotent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = { org_id: f.org.id, team_id: f.team.id, profile_id: f.viewer.id }
    await as(t, f.user).mutation(api.teams.addMember, args) // the leader qualifies
    expect((await membership(t, f.team.id, f.viewer.id))?.is_leader).toBe(false)
    await as(t, f.user).mutation(api.teams.addMember, args) // silent no-op
    let events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'added',
      target_type: 'user',
      target_id: f.viewer.id,
      label: 'viewer',
      detail: 'to Hardware',
      team_id: f.team.id,
      actor_id: f.user.id,
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.addMember, { ...args, profile_id: f.guest.id }),
      'forbidden',
      /^a guest is never a team member$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.addMember, { ...args, profile_id: f.otherAdmin.id }),
      'not_found',
      /^user not found$/,
    )
    await as(t, f.user).mutation(api.teams.removeMember, args)
    expect(await membership(t, f.team.id, f.viewer.id)).toBeNull()
    await as(t, f.user).mutation(api.teams.removeMember, args) // silent no-op
    events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      verb: 'removed',
      target_id: f.viewer.id,
      detail: 'from Hardware',
      team_id: f.team.id,
    })
  })

  it('setLeader: made/demoted verbs; a viewer never; same-value and missing rows silent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lead = (profile_id: string, is_leader: boolean) =>
      as(t, f.admin).mutation(api.teams.setLeader, {
        org_id: f.org.id,
        team_id: f.team.id,
        profile_id,
        is_leader,
      })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: f.team.id,
      profile_id: f.viewer.id,
    })
    await expectRefusal(lead(f.viewer.id, true), 'forbidden', /^a viewer is never a team leader$/)
    await lead(f.admin.id, true)
    expect((await membership(t, f.team.id, f.admin.id))?.is_leader).toBe(true)
    await lead(f.admin.id, true) // same value — silent
    await lead(f.admin.id, false)
    await lead(f.guest.id, true) // no membership row — silent
    const events = await activityFor(t, f.org.id)
    expect(events.map((e) => e.verb)).toEqual(['added', 'made', 'demoted'])
    expect(events[1]).toMatchObject({
      target_id: f.admin.id,
      label: 'admin',
      detail: 'a leader of Hardware',
      team_id: f.team.id,
    })
    expect(events[2]).toMatchObject({ detail: 'from leader of Hardware' })
  })

  it('setLeader: a guest with a stale membership is never promoted, and can be demoted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lead = (is_leader: boolean) =>
      as(t, f.admin).mutation(api.teams.setLeader, {
        org_id: f.org.id,
        team_id: f.team.id,
        profile_id: f.guest.id,
        is_leader,
      })
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.guest.id,
        is_leader: false,
      }),
    )
    await expectRefusal(lead(true), 'forbidden', /^a guest is never a team member$/)
    expect((await membership(t, f.team.id, f.guest.id))?.is_leader).toBe(false)
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('team_members')
        .withIndex('by_team_profile', (q) =>
          q.eq('team_id', f.team.id).eq('profile_id', f.guest.id),
        )
        .unique()
      await ctx.db.patch(row!._id, { is_leader: true })
    })
    await lead(false)
    expect((await membership(t, f.team.id, f.guest.id))?.is_leader).toBe(false)
  })

  it('setLeader: an agent is never promoted, and an older agent leader row can be demoted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lead = (caller: Doc<'profiles'>, is_leader: boolean) =>
      as(t, caller).mutation(api.teams.setLeader, {
        org_id: f.org.id,
        team_id: f.team.id,
        profile_id: f.agent.id,
        is_leader,
      })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: f.team.id,
      profile_id: f.agent.id,
    })
    // Refused for the admin and for the team's own leader alike.
    for (const caller of [f.admin, f.user]) {
      await expectRefusal(lead(caller, true), 'rule', /^an agent cannot lead a team$/)
    }
    expect((await membership(t, f.team.id, f.agent.id))?.is_leader).toBe(false)
    // A leader row written before this rule grants nothing and can be cleared.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('team_members')
        .withIndex('by_team_profile', (q) =>
          q.eq('team_id', f.team.id).eq('profile_id', f.agent.id),
        )
        .unique()
      await ctx.db.patch(row!._id, { is_leader: true })
    })
    await lead(f.admin, false)
    expect((await membership(t, f.team.id, f.agent.id))?.is_leader).toBe(false)
    const events = await activityFor(t, f.org.id)
    expect(events.map((e) => e.verb)).toEqual(['added', 'demoted'])
  })

  it('an agent with a leader row cannot run the team; a person leader still can', async () => {
    const t = newT()
    const f = await withOrg(t)
    // Agents have no login. The planted one stands in for any surface that
    // brings an agent caller to these handlers, next to an agent leader row.
    const agent = await t.run(async (ctx) => {
      await ctx.db.patch(f.agent._id, { auth_user_id: 'auth_agent_relay' })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.agent.id,
        is_leader: true,
      })
      return (await ctx.db.get(f.agent._id)) as Doc<'profiles'>
    })
    const args = { org_id: f.org.id, team_id: f.team.id, profile_id: f.viewer.id }
    const promoteAdmin = { ...args, profile_id: f.admin.id, is_leader: true }
    const RUNS = /^requires an organization admin or a leader of this team$/
    await expectRefusal(as(t, agent).mutation(api.teams.addMember, args), 'forbidden', RUNS)
    await expectRefusal(
      as(t, agent).mutation(api.teams.removeMember, { ...args, profile_id: f.admin.id }),
      'forbidden',
      RUNS,
    )
    await expectRefusal(as(t, agent).mutation(api.teams.setLeader, promoteAdmin), 'forbidden', RUNS)
    await expectRefusal(
      as(t, agent).mutation(api.teams.update, {
        org_id: f.org.id,
        id: f.team.id,
        patch: { name: 'Renamed by agent' },
      }),
      'forbidden',
      RUNS,
    )
    expect(await membership(t, f.team.id, f.viewer.id)).toBeNull()
    expect((await membership(t, f.team.id, f.admin.id))?.is_leader).toBe(false)
    expect((await teamById(t, f.team.id))?.name).toBe('Hardware')
    expect(await activityFor(t, f.org.id)).toEqual([])
    // The person who leads the team still manages its members and leaders.
    await as(t, f.user).mutation(api.teams.addMember, args)
    await as(t, f.user).mutation(api.teams.setLeader, promoteAdmin)
    await as(t, f.user).mutation(api.teams.removeMember, args)
    expect(await membership(t, f.team.id, f.viewer.id)).toBeNull()
    expect((await membership(t, f.team.id, f.admin.id))?.is_leader).toBe(true)
  })
})

describe('teams.deleteDeep', () => {
  it('guard order fence → admin sentence → last-team; the cascade names its full inventory', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.user).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: f.team.id }),
      'rule',
      /^only organization admins can delete teams$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: uuid() }),
      'not_found',
      /^team not found$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: f.team.id }),
      'rule',
      /^cannot delete the last team$/,
    )
    // a sibling team frees the guard; now build the inventory to destroy
    await as(t, f.admin).mutation(api.teams.create, {
      org_id: f.org.id,
      id: uuid(),
      name: 'Design',
    })
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: issue.id })
    const labelId = uuid()
    await as(t, f.admin).mutation(api.labels.create, {
      org_id: f.org.id,
      id: labelId,
      name: 'Bug',
      color: '#F0555D',
    })
    await as(t, f.admin).mutation(api.labels.toggle, {
      org_id: f.org.id,
      issue_id: issue.id,
      label_id: labelId,
    })
    await as(t, f.admin).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: f.team.id,
      profile_id: f.viewer.id,
    })
    const before = await activityFor(t, f.org.id)
    await as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: f.team.id })
    const left = await t.run(async (ctx) => ({
      team: await ctx.db
        .query('teams')
        .withIndex('by_uuid', (q) => q.eq('id', f.team.id))
        .unique(),
      members: await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', f.team.id))
        .collect(),
      projects: await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
      issues: await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
      milestones: await ctx.db
        .query('milestones')
        .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
        .collect(),
      grants: await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
        .collect(),
      pairs: await ctx.db
        .query('issue_labels')
        .withIndex('by_label', (q) => q.eq('label_id', labelId))
        .collect(),
      label: await ctx.db
        .query('labels')
        .withIndex('by_uuid', (q) => q.eq('id', labelId))
        .unique(),
    }))
    expect(left.team).toBeNull()
    expect(left.members).toEqual([])
    // Teams are permission groups; deleting one preserves every project and
    // its work while removing only membership and team-share rows.
    expect(left.projects.map((p) => p.id)).toEqual(
      expect.arrayContaining([f.meta.id, f.sub.id, f.sub2.id, f.hidden.id]),
    )
    expect(left.issues).toHaveLength(1)
    expect(left.milestones).toHaveLength(1)
    expect(left.grants).toHaveLength(2)
    expect(left.pairs).toHaveLength(1)
    expect(left.label).not.toBeNull() // labels are org-level and SURVIVE
    expect(await messagesFor(t, f.admin.id, issue.id)).toHaveLength(1)
    // History survives its subjects: same rows. Team references stay, so
    // the deleted team's history reaches admins only (snapshot.ts), and
    // project references remain valid because those projects remain.
    const after = await activityFor(t, f.org.id)
    expect(after).toHaveLength(before.length) // deleteDeep narrates nothing
    expect(after.some((e) => e.verb === 'added' && e.team_id === f.team.id)).toBe(true)
    for (const e of after) {
      expect(e.team_id === undefined || e.team_id === f.team.id).toBe(true)
      if (e.project_id !== undefined) {
        expect([f.meta.id, f.sub.id, f.sub2.id, f.hidden.id]).toContain(e.project_id)
      }
    }
  })
})
