/* The nightly cleanups of expired sessions and spent OAuth tokens
 * (authRetention.ts): what each deletes and keeps, the session trigger's
 * work for each session, and a backlog drained over several steps. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { AUTH_EXPIRY, REPLAY_HASH_KEEP_MS } from '../authRetention'
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS } from '../lib/oauth'
import { newT, runInAuth, type T, uuid, withOrg } from './helpers.setup'

const DEFAULT_EXPIRY = { ...AUTH_EXPIRY }
/* When the nightly job runs. */
const RUN = Date.parse('2026-04-01T04:55:00.000Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(RUN)
})
afterEach(() => {
  Object.assign(AUTH_EXPIRY, DEFAULT_EXPIRY)
  vi.useRealTimers()
})

/** A Better Auth session of `profile`'s login, used from `createdAt` to
 * `updatedAt` and expiring at `expiresAt`, all in ms. Answers its id. */
const session = (
  t: T,
  profile: Doc<'profiles'>,
  createdAt: number,
  updatedAt: number,
  expiresAt: number,
) =>
  runInAuth(t, (ctx) =>
    ctx.db.insert('session', {
      token: uuid(),
      userId: profile.auth_user_id as string,
      createdAt,
      updatedAt,
      expiresAt,
    }),
  )

const sessionIds = (t: T) =>
  runInAuth(t, async (ctx) => (await ctx.db.query('session').collect()).map((s) => s._id))
const keptMonths = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('usage_sign_ins').collect()).map((r) => r.month).sort())
const endedSessions = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('oauth_ended_sessions').collect()).map(({ session_id, ended_at }) => ({
      session_id,
      ended_at,
    })),
  )
const runRows = (t: T, action: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_audit_log').collect())
      .filter((row) => row.action === action)
      .map((row) => row.detail),
  )

describe('the expired-session cleanup', () => {
  it('deletes expired sessions through the delete trigger and keeps live ones', async () => {
    const t = newT()
    const f = await withOrg(t)
    // used in February and expired long ago
    const old = await session(t, f.user, RUN - 55 * DAY, RUN - 53 * DAY, RUN - 46 * DAY)
    // used in March and expired ten minutes ago
    const recentEnd = RUN - 10 * 60_000
    const recent = await session(t, f.user, RUN - 9 * DAY, RUN - 7 * DAY, recentEnd)
    const live = await session(t, f.user, RUN - DAY, RUN - DAY, RUN + 6 * DAY)
    // expires at the very moment of the run, which Better Auth still accepts
    const now = await session(t, f.viewer, RUN - DAY, RUN - DAY, RUN)
    expect((await sessionIds(t)).sort()).toEqual([old, recent, live, now].sort())

    await t.mutation(internal.authRetention.expireSessions, {})

    expect((await sessionIds(t)).sort()).toEqual([live, now].sort())
    // The trigger ended the recent session's access tokens at its expiry.
    // The old one's tokens all expired long ago, so it needed no record.
    expect(await endedSessions(t)).toEqual([{ session_id: recent, ended_at: recentEnd }])
    expect(await runRows(t, 'expire_sessions')).toEqual([
      { deleted: 2, before: new Date(RUN).toISOString() },
    ])
    // It kept the months the two sessions were used in, in calls of their
    // own, and the record goes once those tokens have expired.
    await runSteps(t)
    expect(await keptMonths(t)).toEqual(['2026-02', '2026-03'])
    expect(await endedSessions(t)).toEqual([])
  })

  it('records the end of a session only while its access tokens can still be valid', async () => {
    const t = newT()
    const f = await withOrg(t)
    // expired a minute less than an access token's lifetime ago, so a token
    // issued just before the expiry is still valid
    const end = RUN - OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1_000 + 60_000
    const ended = await session(t, f.user, end - DAY, end - DAY, end)
    // expired a full lifetime ago, so every token issued before has expired
    await session(t, f.user, end - DAY, end - DAY, end - 60_000)
    await t.mutation(internal.authRetention.expireSessions, {})
    expect(await sessionIds(t)).toEqual([])
    expect(await endedSessions(t)).toEqual([{ session_id: ended, ended_at: end }])
  })

  it('drains a backlog over several steps, the earliest expiry first, and counts it once', async () => {
    Object.assign(AUTH_EXPIRY, { sessions: 3 })
    const t = newT()
    const f = await withOrg(t)
    // stored in an order other than their expiry
    const ids: string[] = []
    for (const day of [5, 12, 9, 14, 7, 11, 13, 10])
      ids[day] = await session(t, f.user, RUN - 20 * DAY, RUN - 19 * DAY, RUN - day * DAY)
    const live = await session(t, f.user, RUN - DAY, RUN - DAY, RUN + DAY)

    await t.mutation(internal.authRetention.expireSessions, {})
    // one step deleted the three that expired first
    expect((await sessionIds(t)).sort()).toEqual(
      [ids[5], ids[7], ids[9], ids[10], ids[11], live].sort(),
    )
    expect(await runRows(t, 'expire_sessions')).toEqual([])
    await runSteps(t)

    expect(await sessionIds(t)).toEqual([live])
    expect(await keptMonths(t)).toEqual(['2026-03'])
    expect(await runRows(t, 'expire_sessions')).toEqual([
      { deleted: 8, before: new Date(RUN).toISOString() },
    ])
  })

  it('writes nothing on a night with no expired session', async () => {
    const t = newT()
    const f = await withOrg(t)
    const live = await session(t, f.user, RUN - DAY, RUN - DAY, RUN + DAY)
    await t.mutation(internal.authRetention.expireSessions, {})
    await runSteps(t)
    expect(await sessionIds(t)).toEqual([live])
    expect(await keptMonths(t)).toEqual([])
    expect(await endedSessions(t)).toEqual([])
    expect(await runRows(t, 'expire_sessions')).toEqual([])
  })
})

describe('the spent OAuth token cleanup', () => {
  /** An access or refresh token row of `profile`'s login. Answers its id. */
  const token = (
    t: T,
    model: 'oauthAccessToken' | 'oauthRefreshToken',
    profile: Doc<'profiles'>,
    times: { expiresAt?: number; revoked?: number },
  ) =>
    runInAuth(t, (ctx) =>
      ctx.db.insert(model, {
        token: uuid(),
        clientId: 'client',
        userId: profile.auth_user_id as string,
        scopes: ['qivo:read', 'offline_access'],
        ...times,
      }),
    )
  const left = (t: T) =>
    runInAuth(t, async (ctx) => ({
      access: (await ctx.db.query('oauthAccessToken').collect()).map((row) => row._id).sort(),
      refresh: (await ctx.db.query('oauthRefreshToken').collect()).map((row) => row._id).sort(),
    }))

  it('deletes expired tokens and refresh tokens revoked over an hour ago, and keeps the rest', async () => {
    const t = newT()
    const f = await withOrg(t)
    await token(t, 'oauthAccessToken', f.user, { expiresAt: RUN - 1 })
    const liveAccess = await token(t, 'oauthAccessToken', f.user, { expiresAt: RUN + HOUR })
    // revoked but valid for a while yet: /mcp refuses it until it expires
    const revokedAccess = await token(t, 'oauthAccessToken', f.user, {
      expiresAt: RUN + HOUR,
      revoked: RUN - 2 * HOUR,
    })
    await token(t, 'oauthRefreshToken', f.user, { expiresAt: RUN - 1 })
    // rotated by a refresh two hours ago, so a revoked refresh token
    await token(t, 'oauthRefreshToken', f.user, { expiresAt: RUN + DAY, revoked: RUN - 2 * HOUR })
    const justRotated = await token(t, 'oauthRefreshToken', f.user, {
      expiresAt: RUN + DAY,
      revoked: RUN - HOUR + 60_000,
    })
    const liveRefresh = await token(t, 'oauthRefreshToken', f.user, { expiresAt: RUN + DAY })
    // rows without an expiry or a revocation time are never taken as spent
    const noExpiry = await token(t, 'oauthRefreshToken', f.user, {})

    await t.mutation(internal.authRetention.expireTokens, {})

    expect(await left(t)).toEqual({
      access: [liveAccess, revokedAccess].sort(),
      refresh: [justRotated, liveRefresh, noExpiry].sort(),
    })
    expect(await runRows(t, 'expire_oauth_tokens')).toEqual([
      { deleted: 3, before: new Date(RUN).toISOString() },
    ])
  })

  it('drains a backlog over several steps and counts it once', async () => {
    Object.assign(AUTH_EXPIRY, { tokens: 2 })
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) {
      await token(t, 'oauthAccessToken', f.user, { expiresAt: RUN - DAY + i })
      await token(t, 'oauthRefreshToken', f.user, { expiresAt: RUN - DAY + i })
    }
    const live = await token(t, 'oauthAccessToken', f.user, { expiresAt: RUN + HOUR })

    await t.mutation(internal.authRetention.expireTokens, {})
    expect((await left(t)).access).toHaveLength(2)
    await runSteps(t)

    expect(await left(t)).toEqual({ access: [live], refresh: [] })
    expect(await runRows(t, 'expire_oauth_tokens')).toEqual([
      { deleted: 6, before: new Date(RUN).toISOString() },
    ])
  })

  it('deletes the hashes of refresh tokens used past their lifetime and a day, after the spent tokens', async () => {
    Object.assign(AUTH_EXPIRY, { tokens: 2 })
    const t = newT()
    const f = await withOrg(t)
    const hash = (kind: 'authorization_code' | 'refresh_token', usedAt: number) =>
      t.run((ctx) =>
        ctx.db.insert('oauth_credential_uses', {
          connection_id: uuid(),
          credential_hash: uuid(),
          kind,
          used_at: new Date(usedAt).toISOString(),
        }),
      )
    const spent = await token(t, 'oauthAccessToken', f.user, { expiresAt: RUN - DAY })
    // used before the bound, the second a millisecond before it
    await hash('refresh_token', RUN - REPLAY_HASH_KEEP_MS - DAY)
    await hash('refresh_token', RUN - REPLAY_HASH_KEEP_MS - 1)
    // still within its token's lifetime and the day after it, and a code's
    const kept = [
      await hash('refresh_token', RUN - REPLAY_HASH_KEEP_MS + 60_000),
      await hash('authorization_code', RUN - REPLAY_HASH_KEEP_MS - DAY),
    ]

    await t.mutation(internal.authRetention.expireTokens, {})
    // the first step deleted the spent token and one hash, then stopped
    const hashes = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('oauth_credential_uses').collect()).map((r) => r._id),
      )
    expect((await left(t)).access).not.toContain(spent)
    expect(await hashes()).toHaveLength(3)
    await runSteps(t)

    expect((await hashes()).sort()).toEqual(kept.sort())
    expect(await runRows(t, 'expire_oauth_tokens')).toEqual([
      { deleted: 3, before: new Date(RUN).toISOString() },
    ])
  })

  it('writes nothing on a night with no spent token', async () => {
    const t = newT()
    const f = await withOrg(t)
    await token(t, 'oauthAccessToken', f.user, { expiresAt: RUN + HOUR })
    await t.mutation(internal.authRetention.expireTokens, {})
    await runSteps(t)
    expect((await left(t)).access).toHaveLength(1)
    expect(await runRows(t, 'expire_oauth_tokens')).toEqual([])
  })
})
