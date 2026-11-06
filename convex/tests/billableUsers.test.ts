import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { getBillableUsers, markBillingMembershipChanged } from '../lib/billableUsers'
import type { AccountNameRow, BillingSummary } from '../lib/billingTypes'
import { nameKey } from '../lib/nameKey'
import { as, NOW, newT, type OrgFixture, plantSeat, type T, uuid, withOrg } from './helpers.setup'

beforeEach(() => {
  vi.stubEnv('POLAR_ACCESS_TOKEN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Every profile of `orgId` keyed and the organization marked keyed, as
 * the name keys backfill leaves them, so the name lists read. */
const keyed = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    for (const p of await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect())
      await ctx.db.patch(p._id, { name_key: nameKey(p.name) })
    await ctx.db.insert('org_ready', { org_id: orgId, name_keys_at: NOW })
  })

/** Every name of one of Billing's lists as `f.admin` reads it, batch by
 * batch from the start. */
async function namesOf(t: T, f: OrgFixture, kind: 'billable' | 'non_billable') {
  const rows: AccountNameRow[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const batch = await as(t, f.admin).query(api.billing.accountList, {
      org_id: f.org.id,
      kind,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (batch.state !== 'ready') throw new Error(`the list answered ${batch.state}`)
    rows.push(...batch.rows)
    if (batch.next === null) return rows
    cursor = batch.next
  }
  throw new Error('the list did not end')
}

/** Checks that billing.details answers what the deprecated `summary`
 * answers without its two lists, that the name lists name exactly its
 * lists' accounts, in name order, and that no answer holds anything of
 * the home profile `home` or the other organization. */
async function sameAsSummary(
  t: T,
  f: OrgFixture,
  summary: BillingSummary,
  home: { id: string; name: string },
) {
  const details = await as(t, f.admin).query(api.billing.details, { org_id: f.org.id })
  const { billable_accounts, non_billable_accounts, ...counters } = summary
  expect(details).toEqual(counters)
  expect(details).not.toHaveProperty('billable_accounts')
  expect(details).not.toHaveProperty('non_billable_accounts')
  const billable = await namesOf(t, f, 'billable')
  const non = await namesOf(t, f, 'non_billable')
  const ids = (rows: { profile_id: string }[]) => new Set(rows.map((row) => row.profile_id))
  expect(ids(billable)).toEqual(ids(billable_accounts))
  expect(ids(non)).toEqual(ids(non_billable_accounts))
  for (const rows of [billable, non]) {
    const keys = rows.map((row) => nameKey(row.name))
    expect(keys).toEqual([...keys].sort())
  }
  const shown = JSON.stringify([details, billable, non])
  for (const hidden of [home.id, home.name, f.otherOrg.id]) expect(shown).not.toContain(hidden)
}

describe('billable users', () => {
  it('lists local excluded users and counts inactive users separately from guests billed elsewhere', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inactivePerson = await plantSeat(t, { org_id: f.org.id, active: false })
    const inactiveAgent = await plantSeat(t, {
      org_id: f.org.id,
      kind: 'agent',
      active: false,
      plannable_hours: undefined,
    })
    const home = await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: f.guest.email,
      name: 'Private home identity',
    })
    const summary = () => as(t, f.admin).query(api.billing.summary, { org_id: f.org.id })
    const initial = await summary()
    expect(initial).toMatchObject({
      billable_users: 4,
      inactive_users: 2,
      invited_users_with_own_billing: 1,
    })
    expect(initial.non_billable_accounts).toEqual(
      expect.arrayContaining([
        { profile_id: inactivePerson.id, name: inactivePerson.name, reason: 'inactive' },
        { profile_id: inactiveAgent.id, name: inactiveAgent.name, reason: 'inactive' },
        { profile_id: f.guest.id, name: f.guest.name, reason: 'guest_with_home' },
      ]),
    )
    expect(initial.non_billable_accounts).toHaveLength(3)
    expect(JSON.stringify(initial)).not.toContain(home.id)
    expect(JSON.stringify(initial)).not.toContain(home.name)
    expect(JSON.stringify(initial)).not.toContain(f.otherOrg.id)
    // the details and the name lists agree with it at every step
    await keyed(t, f.org.id)
    await sameAsSummary(t, f, initial, home)

    // A guest's own billing is relevant only while that invited profile is active.
    await t.run((ctx) => ctx.db.patch(f.guest._id, { active: false }))
    const inactiveGuest = await summary()
    expect(inactiveGuest).toMatchObject({
      billable_users: 4,
      inactive_users: 3,
      invited_users_with_own_billing: 0,
    })
    await sameAsSummary(t, f, inactiveGuest, home)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.guest._id, { active: true })
      await ctx.db.patch(home._id, { active: false })
    })
    const changed = await summary()
    expect(changed).toMatchObject({
      billable_users: 5,
      inactive_users: 2,
      invited_users_with_own_billing: 0,
    })
    expect(changed.non_billable_accounts.map((account) => account.profile_id)).not.toContain(
      f.guest.id,
    )
    expect(changed.billable_accounts.map((account) => account.profile_id)).toContain(f.guest.id)
    await sameAsSummary(t, f, changed, home)
  })

  it('counts active people, viewers, agents and unclaimed invitations, excluding inactive profiles', async () => {
    const t = newT()
    const f = await withOrg(t)
    const invitation = await plantSeat(t, { org_id: f.org.id, email: 'invited@example.test' })
    await plantSeat(t, { org_id: f.org.id, active: false })
    await plantSeat(t, { org_id: f.org.id, org_role: 'guest', active: false })
    await plantSeat(t, {
      org_id: f.org.id,
      kind: 'agent',
      active: false,
      plannable_hours: undefined,
    })
    const billable = await t.run((ctx) => getBillableUsers(ctx, f.org.id))
    expect(billable).toMatchObject({ total: 6, members: 5, guests: 1 })
    expect(billable.users.map((user) => user.profile_id).sort()).toEqual(
      [f.admin.id, f.user.id, f.viewer.id, f.agent.id, f.guest.id, invitation.id].sort(),
    )
    expect(billable.users.find((user) => user.profile_id === invitation.id)?.reason).toBe('member')
    expect(invitation.accepted_at).toBeUndefined()
    expect(invitation.auth_user_id).toBeUndefined()
  })

  it('an active home invitation exempts a matching guest, and deactivation restores the guest charge', async () => {
    const t = newT()
    const f = await withOrg(t)
    const homeId = uuid()
    await as(t, f.otherAdmin).mutation(api.profiles.create, {
      org_id: f.otherOrg.id,
      id: homeId,
      name: 'Private home identity',
      email: f.guest.email!.toUpperCase(),
      org_role: 'viewer',
      kind: 'person',
      color: '#445566',
    })
    const exempt = await t.run((ctx) => getBillableUsers(ctx, f.org.id))
    expect(exempt).toMatchObject({ total: 4, members: 4, guests: 0 })
    expect(exempt.users.map((user) => user.profile_id)).not.toContain(f.guest.id)
    expect(JSON.stringify(exempt)).not.toContain(homeId)
    expect(JSON.stringify(exempt)).not.toContain('Private home identity')
    expect(JSON.stringify(exempt)).not.toContain(f.otherOrg.id)

    await as(t, f.otherAdmin).mutation(api.profiles.update, {
      org_id: f.otherOrg.id,
      id: homeId,
      patch: { active: false },
    })
    const chargeable = await t.run((ctx) => getBillableUsers(ctx, f.org.id))
    expect(chargeable).toMatchObject({ total: 5, members: 4, guests: 1 })
    expect(chargeable.users.find((user) => user.profile_id === f.guest.id)).toEqual({
      profile_id: f.guest.id,
      name: f.guest.name,
      kind: 'person',
      org_role: 'guest',
      reason: 'guest_without_home',
    })
  })

  it('each inviting organization pays for a guest who has no active home membership', async () => {
    const t = newT()
    const f = await withOrg(t)
    const email = 'shared-contractor@example.test'
    const first = await plantSeat(t, { org_id: f.org.id, email, org_role: 'guest' })
    const second = await plantSeat(t, { org_id: f.otherOrg.id, email, org_role: 'guest' })
    const firstBill = await t.run((ctx) => getBillableUsers(ctx, f.org.id))
    const secondBill = await t.run((ctx) => getBillableUsers(ctx, f.otherOrg.id))
    expect(firstBill.users.find((user) => user.profile_id === first.id)?.reason).toBe(
      'guest_without_home',
    )
    expect(secondBill.users.find((user) => user.profile_id === second.id)?.reason).toBe(
      'guest_without_home',
    )
    expect(firstBill.users.map((user) => user.profile_id)).not.toContain(second.id)
    expect(secondBill.users.map((user) => user.profile_id)).not.toContain(first.id)
  })

  it('a deleted home membership restores the charge without conflating unclaimed logins', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = await plantSeat(t, {
      org_id: f.org.id,
      email: 'guest@example.test',
      org_role: 'guest',
    })
    const unrelated = await plantSeat(t, { org_id: f.otherOrg.id, email: 'other@example.test' })
    expect(guest.auth_user_id).toBeUndefined()
    expect(unrelated.auth_user_id).toBeUndefined()
    expect(
      (await t.run((ctx) => getBillableUsers(ctx, f.org.id))).users.map((user) => user.profile_id),
    ).toContain(guest.id)
    const home = await plantSeat(t, { org_id: f.otherOrg.id, email: guest.email })
    expect(
      (await t.run((ctx) => getBillableUsers(ctx, f.org.id))).users.map((user) => user.profile_id),
    ).not.toContain(guest.id)
    await as(t, f.otherAdmin).mutation(api.profiles.remove, { org_id: f.otherOrg.id, id: home.id })
    expect(
      (await t.run((ctx) => getBillableUsers(ctx, f.org.id))).users.map((user) => user.profile_id),
    ).toContain(guest.id)
  })
})

describe('membership billing synchronization', () => {
  it('schedules the changed org and orgs sharing old/new addresses once, without unrelated orgs', async () => {
    const t = newT()
    const f = await withOrg(t)
    const thirdOrgId = uuid()
    await plantSeat(t, { org_id: f.otherOrg.id, email: 'old@example.test', org_role: 'guest' })
    await plantSeat(t, { org_id: f.otherOrg.id, email: 'new@example.test', org_role: 'guest' })
    await plantSeat(t, { org_id: thirdOrgId, email: 'unrelated@example.test' })
    vi.stubEnv('POLAR_ACCESS_TOKEN', 'test-token')
    const runAfter = vi.fn(async () => 'scheduled' as Id<'_scheduled_functions'>)
    await t.run(async (ctx) => {
      await markBillingMembershipChanged(
        { ...ctx, scheduler: { ...ctx.scheduler, runAfter } },
        f.org.id,
        ['OLD@EXAMPLE.TEST', 'new@example.test', 'old@example.test'],
      )
    })
    expect(runAfter).toHaveBeenCalledTimes(2)
    expect(
      runAfter.mock.calls
        .map((call) => (call as unknown as [number, unknown, { org_id: string }])[2].org_id)
        .sort(),
    ).toEqual([f.org.id, f.otherOrg.id].sort())
  })

  it('does not schedule demo workspaces or an unconfigured provider', async () => {
    const t = newT()
    const runAfter = vi.fn(async () => 'scheduled' as Id<'_scheduled_functions'>)
    await t.run(async (ctx) => {
      const schedulerCtx = { ...ctx, scheduler: { ...ctx.scheduler, runAfter } }
      await markBillingMembershipChanged(schedulerCtx, uuid())
      vi.stubEnv('POLAR_ACCESS_TOKEN', 'test-token')
      vi.stubEnv('APP_MODE', 'demo')
      await markBillingMembershipChanged(schedulerCtx, uuid())
    })
    expect(runAfter).not.toHaveBeenCalled()
  })
})
