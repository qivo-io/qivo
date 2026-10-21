/* Invitation email from the app (invites.ts): an org admin adding a person,
 * correcting a pending person's address or inviting a new project guest
 * schedules one letter once the mutation commits. Covers the wording, the
 * guest ending, the sign-up or sign-in link, the audit record and the cases
 * that send nothing. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import type { Refusal, RefusalCode } from '../lib/functions'
import {
  APP_SENDS_PER_ORG_HOUR,
  INVITE_NOT_HELD,
  INVITE_SENDING,
  INVITES_HELD,
} from '../lib/inviteLimits'
import { as, expectRefusal, NOW, newT, plantSeat, type T, uuid, withOrg } from './helpers.setup'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

declare const process: { env: Record<string, string | undefined> }

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.ts'))
  return t
}

type Letter = { to: string[]; subject: string; text: string; html: string }

let fetch: ReturnType<typeof vi.fn>
const letters = (): Letter[] => fetch.mock.calls.map(([, init]) => JSON.parse(init.body))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
  vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
  fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
  vi.stubGlobal('fetch', fetch)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const isoNow = () => new Date().toISOString()
const flush = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

const person = (orgId: string, email: string, extra: Record<string, unknown> = {}) => ({
  org_id: orgId,
  id: uuid(),
  name: 'Anna Larsson',
  email,
  org_role: 'user' as const,
  kind: 'person' as const,
  color: '#123456',
  ...extra,
})

const inviteRows = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_audit_log').collect()).filter((r) => r.action === 'invite_email'),
  )

describe('invitations from the app', () => {
  it('emails a person added in Settings, and records it as the system', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const added = person(f.org.id, 'Anna.L@Example.SE')
    await as(t, f.admin).mutation(api.profiles.create, added)
    await flush(t)
    const [letter] = letters()
    expect(letter.to).toEqual(['anna.l@example.se'])
    expect(letter.subject).toBe('You are invited to Qivo')
    expect(letter.text).toContain(
      'Testbed Labs has invited you to join their organization. Sign in or create an account with anna.l@example.se to join:',
    )
    expect(letter.text.endsWith(`${process.env.SITE_URL}/app#signup`)).toBe(true)
    expect(
      (await inviteRows(t)).map((r) => [r.actor_email, r.target_profile_id, r.detail]),
    ).toEqual([
      [
        'system',
        added.id,
        { email: 'anna.l@example.se', sent: true, resend: false, settled: true, by: f.admin.id },
      ],
    ])
  })

  it('says "as a guest" when the address has a home organization elsewhere, and links to sign-in', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const now = Date.now()
    const email = 'home@example.se'
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      email,
      auth_user_id: 'home-login',
      accepted_at: NOW,
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: { name: 'other', email, emailVerified: true, createdAt: now, updatedAt: now },
      },
    })
    await as(t, f.admin).mutation(api.profiles.create, person(f.org.id, email))
    await flush(t)
    const [letter] = letters()
    expect(letter.text).toContain(
      'Testbed Labs has invited you to join their organization as a guest.',
    )
    expect(letter.html).toContain('their organization as a guest.')
    expect(letter.text.endsWith(`${process.env.SITE_URL}/app`)).toBe(true)
  })

  it('emails a new project guest once, with the guest ending', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const invite = () =>
      as(t, f.admin).mutation(api.projects.inviteGuest, {
        org_id: f.org.id,
        project_id: f.meta.id,
        email: 'Guest.New@Example.se',
        level: 'viewer',
      })
    await invite()
    await flush(t)
    expect(letters().map((l) => l.text.split('\n')[2])).toEqual([
      'Testbed Labs has invited you to join their organization as a guest. Sign in or create an account with guest.new@example.se to join:',
    ])
    // inviting the existing seat again only updates its access
    expect((await invite()).emailed).toBe(false)
    await flush(t)
    expect(letters()).toHaveLength(1)
  })

  it('emails a quickly corrected address once, and nothing for an agent', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const added = person(f.org.id, 'typo@example.se')
    await as(t, f.admin).mutation(api.profiles.create, added)
    await as(t, f.admin).mutation(api.profiles.create, {
      ...person(f.org.id, ''),
      email: null,
      kind: 'agent',
      name: 'Release Bot',
    })
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: added.id,
      patch: { email: 'right@example.se' },
    })
    await flush(t)
    // the first send saw a different address than the seat now holds, so it stood down
    expect(letters().map((l) => l.to[0])).toEqual(['right@example.se'])
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: added.id,
      patch: { name: 'Anna L' },
    })
    await flush(t)
    expect(letters()).toHaveLength(1)
    const detail = await t.run((ctx) =>
      ctx.db
        .query('platform_audit_log')
        .withIndex('by_target_profile', (q) => q.eq('target_profile_id', added.id))
        .collect(),
    )
    expect(detail.map((r) => r.detail.email)).toEqual(['right@example.se'])
  })

  it('skips a seat claimed before its send, and emails a reactivated seat only if no delivered invitation is on record', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const claimed = person(f.org.id, 'quick@example.se')
    await as(t, f.admin).mutation(api.profiles.create, claimed)
    await t.run(async (ctx) => {
      const seat = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', claimed.id))
        .unique()
      if (seat) await ctx.db.patch(seat._id, { auth_user_id: 'quick-login' })
    })
    await flush(t)
    expect(letters()).toEqual([])
    expect(await inviteRows(t)).toEqual([])

    const later = person(f.org.id, 'typo@example.se')
    const update = (patch: Record<string, unknown>) =>
      as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id: later.id, patch })
    await as(t, f.admin).mutation(api.profiles.create, later)
    await flush(t)
    await update({ active: false })
    await update({ email: 'right@example.se' })
    await flush(t)
    expect(letters().map((l) => l.to[0])).toEqual(['typo@example.se'])
    await update({ active: true })
    await flush(t)
    expect(letters().map((l) => l.to[0])).toEqual(['typo@example.se', 'right@example.se'])
    await update({ active: false })
    await update({ active: true })
    await flush(t)
    expect(letters()).toHaveLength(2)
  })

  it('lets one person receive a letter for every correction', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const added = person(f.org.id, 'try0@example.se')
    await as(t, f.admin).mutation(api.profiles.create, added)
    await flush(t)
    for (let i = 1; i <= 6; i++) {
      await as(t, f.admin).mutation(api.profiles.update, {
        org_id: f.org.id,
        id: added.id,
        patch: { email: `try${i}@example.se` },
      })
      await flush(t)
    }
    expect(letters().map((l) => l.to[0])).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => `try${i}@example.se`),
    )
  })

  it('caps an organization at 50 letters an hour, not counting held-back or unattempted ones', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const plantSends = (n: number, detail: Record<string, unknown>) =>
      t.run(async (ctx) => {
        for (let i = 0; i < n; i++) {
          await ctx.db.insert('platform_audit_log', {
            ts: new Date().toISOString(),
            actor_email: 'system',
            action: 'invite_email',
            target_org_id: f.org.id,
            detail,
          })
        }
      })
    // 46 delivered and 3 uncertain count; held-back and never-attempted ones do not
    await plantSends(46, { email: 'earlier@example.se', sent: true, resend: false })
    await plantSends(3, {
      email: 'timeout@example.se',
      sent: false,
      resend: false,
      settled: true,
      uncertain: true,
    })
    await plantSends(3, { email: 'held@example.se', sent: false, resend: false, limited: true })
    await plantSends(3, { email: 'unsent@example.se', sent: false, resend: false, settled: true })
    await as(t, f.admin).mutation(api.profiles.create, person(f.org.id, 'fiftieth@example.se'))
    await flush(t)
    await as(t, f.admin).mutation(api.profiles.create, person(f.org.id, 'over@example.se'))
    await flush(t)
    expect(letters().map((l) => l.to[0])).toEqual(['fiftieth@example.se'])
    const rows = (await inviteRows(t)).filter((r) => r.target_profile_id !== undefined)
    expect(rows.map((r) => [r.detail.email, r.detail.sent, r.detail.limited ?? false])).toEqual([
      ['fiftieth@example.se', true, false],
      ['over@example.se', false, true],
    ])
    // the next hour starts a new count
    vi.advanceTimersByTime(3_600_001)
    await as(t, f.admin).mutation(api.profiles.create, person(f.org.id, 'later@example.se'))
    await flush(t)
    expect(letters().map((l) => l.to[0])).toEqual(['fiftieth@example.se', 'later@example.se'])
  })

  it('reserves the last slot under the cap for only one of two simultaneous sends', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 49; i++) {
        await ctx.db.insert('platform_audit_log', {
          ts: new Date().toISOString(),
          actor_email: 'system',
          action: 'invite_email',
          target_org_id: f.org.id,
          channel: 'app',
          detail: { email: 'earlier@example.se', sent: true, resend: false },
        })
      }
    })
    const a = await plantSeat(t, { org_id: f.org.id, email: 'a@example.se' })
    const b = await plantSeat(t, { org_id: f.org.id, email: 'b@example.se' })
    const reserve = (seat: { id: string; email?: string }) =>
      t.mutation(internal.invites.reserve, {
        profile_id: seat.id,
        org_id: f.org.id,
        email: seat.email ?? '',
        resend: false,
        actor: { email: 'system' },
        app: true,
      })
    const outcomes = await Promise.all([reserve(a), reserve(b)])
    expect(outcomes.map((o) => o.allowed).sort()).toEqual([false, true])
  })

  it('reserves nothing for a seat readdressed or removed since it was read', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const added = person(f.org.id, 'anna@example.se')
    await as(t, f.admin).mutation(api.profiles.create, added)
    const reserve = (email: string) =>
      t.mutation(internal.invites.reserve, {
        profile_id: added.id,
        org_id: f.org.id,
        email,
        resend: false,
        actor: { email: 'system' },
        app: true,
      })
    expect(await reserve('old@example.se')).toEqual({ row: null, allowed: false })
    expect((await reserve('anna@example.se')).allowed).toBe(true)
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: added.id })
    expect(await reserve('anna@example.se')).toEqual({ row: null, allowed: false })
  })

  it('skips a seat claimed since it was saved, unless the request is strict', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const targets = (strict: boolean) =>
      t.query(internal.invites.targets, {
        invites: [{ profile_id: f.user.id }],
        operator: true,
        strict,
      })
    expect(await targets(false)).toEqual([])
    await expect(targets(true)).rejects.toThrow(/invitation not found/)
  })

  it('shows app sends in the organization detail but not in the operator audit listing', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const now = Date.now()
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'op',
          email: 'op@platform.test',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', { auth_user_id: user._id, note: '', created_at: NOW }),
    )
    const op = t.withIdentity({ subject: user._id as string })
    const added = person(f.org.id, 'anna@example.se')
    await as(t, f.admin).mutation(api.profiles.create, added)
    await flush(t)
    const detail = await op.action(api.adminPeople.orgDetail, { org_id: f.org.id })
    expect(detail.members.find((m) => m.profile_id === added.id)?.invite).toMatchObject({
      sent: true,
    })
    expect((await op.query(api.admin.auditLog, {})).rows.map((r) => r.action)).not.toContain(
      'invite_email',
    )
    // many newer app emails never push an operator action out of the listing
    await t.run(async (ctx) => {
      await ctx.db.insert('platform_audit_log', {
        ts: new Date(Date.now() - 60_000).toISOString(),
        actor_email: 'op@platform.test',
        action: 'create_org',
        target_org_id: f.org.id,
        detail: {},
      })
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('platform_audit_log', {
          ts: new Date().toISOString(),
          actor_email: 'system',
          action: 'invite_email',
          target_org_id: f.org.id,
          channel: 'app',
          detail: { email: `x${i}@example.se`, sent: true, resend: false },
        })
      }
    })
    expect(await op.query(api.admin.auditLog, { limit: 5 })).toMatchObject({
      rows: [{ action: 'create_org' }],
      next: null,
    })
  })

  it('sends and records nothing on a public demo deployment', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const seat = await plantSeat(t, { org_id: f.org.id, email: 'anna@example.se' })
    const send = () =>
      t.action(internal.invites.sendFromApp, { invites: [{ profile_id: seat.id }] })
    vi.stubEnv('APP_MODE', 'demo')
    await send()
    expect(fetch).not.toHaveBeenCalled()
    expect(await inviteRows(t)).toEqual([])
    vi.stubEnv('APP_MODE', '')
    await send()
    expect(letters().map((l) => l.to[0])).toEqual(['anna@example.se'])
    expect(await inviteRows(t)).toHaveLength(1)
  })

  it('records an unsent letter when mail is not configured', async () => {
    vi.stubEnv('LETTERMINT_API_KEY', '')
    const t = newAuthT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.profiles.create, person(f.org.id, 'anna@example.se'))
    await flush(t)
    expect(fetch).not.toHaveBeenCalled()
    expect((await inviteRows(t)).map((r) => [r.detail.sent, r.detail.settled])).toEqual([
      [false, true],
    ])
  })
})

describe('whoever caused an app invitation sees whether it went out', () => {
  const byId = <R extends { profile_id: string }>(rows: R[]) =>
    [...rows].sort((a, b) => a.profile_id.localeCompare(b.profile_id))

  it('shows an org admin every pending seat and a project lead only the guests they invited', async () => {
    const t = newAuthT()
    // f.user leads f.meta and is not an org admin
    const f = await withOrg(t)
    const deliveries = (who: typeof f.admin) =>
      as(t, who).query(api.invites.deliveries, { org_id: f.org.id })
    // a final refusal, such as a suppressed recipient
    fetch.mockResolvedValue({
      ok: false,
      status: 422,
      headers: { get: () => null },
      json: async () => ({}),
    })
    const added = person(f.org.id, 'refused@example.se')
    await as(t, f.admin).mutation(api.profiles.create, added)
    await flush(t)
    fetch.mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
    const { id: guest, emailed } = await as(t, f.user).mutation(api.projects.inviteGuest, {
      org_id: f.org.id,
      project_id: f.meta.id,
      email: 'guest.new@example.se',
      level: 'viewer',
    })
    await flush(t)
    expect(emailed).toBe(true)

    expect(byId(await deliveries(f.admin))).toEqual(
      byId([
        {
          profile_id: added.id,
          email: 'refused@example.se',
          state: 'unsent',
          since: expect.any(String),
          free_at: null,
        },
        {
          profile_id: guest,
          email: 'guest.new@example.se',
          state: 'sent',
          since: expect.any(String),
        },
      ]),
    )
    expect(await deliveries(f.user)).toEqual([
      {
        profile_id: guest,
        email: 'guest.new@example.se',
        state: 'sent',
        since: expect.any(String),
      },
    ])
    expect(await deliveries(f.viewer)).toEqual([])

    // the lead may not email a delivered invitation again, and once they no
    // longer lead its project, they may not send it at all
    const again = () =>
      as(t, f.user).mutation(api.invites.sendAgain, { org_id: f.org.id, profile_id: guest })
    await refused(again(), 'rule', INVITE_NOT_HELD)
    await t.run(async (ctx) => {
      const meta = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique()
      if (meta) await ctx.db.patch(meta._id, { lead_id: f.admin.id })
    })
    await expectRefusal(again(), 'forbidden')
    // the admin sends the refused one again, which a live demo refuses
    await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: f.admin.auth_user_id ?? '',
        org_id: f.org.id,
        created_at: Date.now(),
        expires_at: Date.now() + 86_400_000,
        status: 'ready',
        seed_version: 1,
        anchor: '2026-09-14',
      }),
    )
    vi.stubEnv('APP_MODE', 'demo')
    await expectRefusal(
      as(t, f.admin).mutation(api.invites.sendAgain, { org_id: f.org.id, profile_id: added.id }),
      'forbidden',
      /requires a regular workspace/,
    )
    vi.stubEnv('APP_MODE', '')
    const before = (await inviteRows(t)).length
    await as(t, f.admin).mutation(api.invites.sendAgain, { org_id: f.org.id, profile_id: added.id })
    await flush(t)
    expect(letters().at(-1)?.to).toEqual(['refused@example.se'])
    expect(await inviteRows(t)).toHaveLength(before + 1)
  })

  it('tells a send in flight, a held-back one and an uncertain one apart, for the current address only', async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const seats = await Promise.all(
      ['sending', 'held', 'uncertain', 'readdressed', 'stuck'].map(async (name) => {
        const seat = person(f.org.id, `${name}@example.se`)
        await as(t, f.admin).mutation(api.profiles.create, seat)
        return seat
      }),
    )
    // the scheduled sends never run here, so only the planted rows count
    const plant = (seat: { id: string }, detail: Record<string, unknown>, ts = isoNow()) =>
      t.run((ctx) =>
        ctx.db.insert('platform_audit_log', {
          ts,
          actor_email: 'system',
          action: 'invite_email',
          channel: 'app',
          target_org_id: f.org.id,
          target_profile_id: seat.id,
          detail: { resend: false, by: f.admin.id, ...detail },
        }),
      )
    const [sending, held, uncertain, readdressed, stuck] = seats
    await plant(sending, { email: sending.email, sent: false })
    await plant(held, { email: held.email, sent: false, limited: true })
    await plant(uncertain, { email: uncertain.email, sent: false, settled: true, uncertain: true })
    await plant(readdressed, { email: 'old@example.se', sent: false, settled: true })
    // reserved ten minutes ago and never settled: its action died
    await plant(
      stuck,
      { email: stuck.email, sent: false },
      new Date(Date.now() - 10 * 60_000).toISOString(),
    )
    // an operator's later entries for the same seat do not hide its send
    for (let i = 0; i < 25; i++)
      await t.run((ctx) =>
        ctx.db.insert('platform_audit_log', {
          ts: `2099-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          actor_email: 'operator@example.se',
          action: 'set_member_role',
          target_org_id: f.org.id,
          target_profile_id: held.id,
          detail: {},
        }),
      )
    expect(byId(await as(t, f.admin).query(api.invites.deliveries, { org_id: f.org.id }))).toEqual(
      byId([
        {
          profile_id: sending.id,
          email: sending.email,
          state: 'sending',
          since: expect.any(String),
        },
        // the planted rows leave the hour free, so it may go again now
        {
          profile_id: held.id,
          email: held.email,
          state: 'held',
          since: expect.any(String),
          free_at: null,
        },
        {
          profile_id: uncertain.id,
          email: uncertain.email,
          state: 'uncertain',
          since: expect.any(String),
        },
        { profile_id: stuck.id, email: stuck.email, state: 'uncertain', since: expect.any(String) },
      ]),
    )
  })

  it(`says when the hourly cap frees a held send, refuses to send it again before, and sends it after`, async () => {
    const t = newAuthT()
    const f = await withOrg(t)
    const first = Date.now()
    // the hour's 50 counted sends, a minute apart from `first`
    await t.run(async (ctx) => {
      for (let i = 0; i < APP_SENDS_PER_ORG_HOUR; i++) {
        await ctx.db.insert('platform_audit_log', {
          ts: new Date(first + i * 60_000 - 3_000_000).toISOString(),
          actor_email: 'system',
          action: 'invite_email',
          channel: 'app',
          target_org_id: f.org.id,
          detail: { email: `earlier${i}@example.se`, sent: true, resend: false, settled: true },
        })
      }
    })
    const seat = person(f.org.id, 'later@example.se')
    await as(t, f.admin).mutation(api.profiles.create, seat)
    await flush(t)
    const freeAt = new Date(first - 3_000_000 + 3_600_000).toISOString()
    const row = async () =>
      (await as(t, f.admin).query(api.invites.deliveries, { org_id: f.org.id })).find(
        (r) => r.profile_id === seat.id,
      )
    expect(await row()).toMatchObject({ state: 'held', free_at: freeAt })
    const again = () =>
      as(t, f.admin).mutation(api.invites.sendAgain, { org_id: f.org.id, profile_id: seat.id })
    await refused(again(), 'rule', INVITES_HELD)
    // someone who did not cause the send may not send it
    await expectRefusal(
      as(t, f.user).mutation(api.invites.sendAgain, { org_id: f.org.id, profile_id: seat.id }),
      'forbidden',
    )
    expect(letters()).toEqual([])
    // once the oldest send leaves the hour, it goes, and counts as a resend;
    // the seat shows it in flight at once, and a second click waits for it
    vi.setSystemTime(Date.parse(freeAt) + 1)
    await again()
    expect(await row()).toMatchObject({ state: 'sending' })
    await refused(again(), 'rule', INVITE_SENDING)
    await flush(t)
    expect(letters().map((l) => l.to[0])).toEqual(['later@example.se'])
    expect(await row()).toMatchObject({ state: 'sent' })
    expect((await inviteRows(t)).at(-1)?.detail).toMatchObject({ resend: true, by: f.admin.id })
  })
})
