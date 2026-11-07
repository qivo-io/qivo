/* MCP access's two lists read from the server a batch at a time
 * (tokens.ts personalTokens and connectedApps.ts list, through
 * model/connectedApps.ts):
 *
 *   1. personalTokens: the login's own tokens across its active seats,
 *      newest created_at first, ties by id, in pubToken's shape, 25 a
 *      batch, the search over names and shown prefixes, the refusals
 *      before any token read, the read share and the demo.
 *   2. connectedApps.list: the login's approved connections only, newest
 *      approval first, deleted ones read and left out, the seat's and the
 *      organization's names, the gone app, batches, searches, refusals,
 *      the read share, the demo and a login without a seat.
 *   3. The deprecated full lists, one pin each, unchanged.
 *   4. Reads of everyday batches, logged for the read shares' docstrings.
 *
 * No design-size figure covers these lists, so no case raises one. A case
 * holds at most 26 rows of a list, three seats, 26 deleted connections and
 * 20 unfinished authorizations, and reaches every stop by lowering a read
 * share, put back after each case. */

import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { Refusal } from '../lib/functions'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ, namedCursor } from '../lib/namedPages'
import { named, nameKey } from '../lib/nameKey'
import {
  CONNECTED_APPS,
  CONNECTED_APPS_LIST,
  type ConnectedAppBatch,
  type ConnectedAppRow,
  connectedAppsOf,
  NOT_APPS_CURSOR,
  REMOVED_MEMBER,
  REMOVED_ORGANIZATION,
} from '../model/connectedApps'
import {
  NOT_TOKENS_CURSOR,
  PERSONAL_TOKENS,
  PERSONAL_TOKENS_LIST,
  type PersonalTokenBatch,
  personalTokensOf,
} from '../tokens'
import { as, newT, plantSeat, runInAuth, type T, uuid, withOrg } from './helpers.setup'

afterEach(() => {
  PERSONAL_TOKENS.reads = { ...NAMED_READ }
  CONNECTED_APPS.reads = { ...NAMED_READ }
  vi.unstubAllEnvs()
})

/* An ISO time `minutes` after the start of 2026. */
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString()

type Caller = ReturnType<typeof as>

/** The refusal `promise` throws, which must be a typed one. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  const outcome = await promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  if (!('error' in outcome)) throw new Error(`resolved with ${JSON.stringify(outcome.value)}`)
  if (!(outcome.error instanceof ConvexError)) throw new Error(String(outcome.error))
  return outcome.error.data as Refusal
}

/** The refusal `read` throws inside one transaction, with the index ranges
 * and documents the transaction read before it. */
const refusedRead = (t: T, read: (ctx: QueryCtx) => Promise<unknown>) =>
  t.run(async (ctx) => {
    const e = await read(ctx).then(
      () => null,
      (error: unknown) => error,
    )
    const m = await ctx.meta.getTransactionMetrics()
    if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
    return {
      data: e.data as Refusal,
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
    }
  })

/** What one transaction read, from Convex's metrics. */
type Read = { ranges: number; documents: number; bytes: number }

/** `run` in its own transaction, with what that transaction read. */
const measured = <R>(t: T, run: (ctx: QueryCtx) => Promise<R>) =>
  t.run(async (ctx) => {
    const out = await run(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    const read: Read = {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      bytes: m.bytesRead.used,
    }
    return { out, read }
  })

/** Every batch `read` answers from the start, following `next` to the end. */
async function walk<B extends { next: string | null }>(
  read: (cursor: string | undefined) => Promise<B>,
): Promise<B[]> {
  const batches: B[] = []
  let cursor: string | undefined
  for (let round = 0; round < 100; round++) {
    const batch = await read(cursor)
    batches.push(batch)
    if (batch.next === null) return batches
    cursor = batch.next
  }
  throw new Error('the list did not end')
}

/* ------------------------------------------------------------ the tokens */

/** A token to plant: its name and created_at, and any stored field. A
 * missing `access` plants one with access, as createMcpToken does; `none`
 * plants a row from before access existed. */
type TokenSeed = {
  name: string
  created_at: string
  id?: string
  access?: 'read' | 'write' | 'none'
  expires_at?: string
  last_used_at?: string
  revoked_at?: string
  revoked_by_admin?: true
}

let minted = 0

/** Plants `seeds` as personal tokens of `seat`, in that order, each with
 * its own hash and prefix, and answers the rows. */
async function plantTokens(
  t: T,
  seat: Doc<'profiles'>,
  seeds: readonly TokenSeed[],
): Promise<Doc<'mcp_tokens'>[]> {
  return await t.run(async (ctx) => {
    const out: Doc<'mcp_tokens'>[] = []
    for (const { access, ...seed } of seeds) {
      const n = ++minted
      const _id = await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: seat.id,
        org_id: seat.org_id,
        token_prefix: `qvt_${n.toString(16).padStart(7, '0')}`,
        token_hash: n.toString(16).padStart(64, '0'),
        ...(access === 'none' ? {} : { access: access ?? 'write' }),
        ...seed,
        ...named(seed.name),
      })
      const row = await ctx.db.get(_id)
      if (row === null) throw new Error('a planted token vanished')
      out.push(row)
    }
    return out
  })
}

/** withOrg, with a guest seat of the user's login in the other
 * organization, as a person invited elsewhere holds one. */
async function seats() {
  const t = newT()
  const f = await withOrg(t)
  const guestSeat = await plantSeat(t, {
    org_id: f.otherOrg.id,
    auth_user_id: f.user.auth_user_id,
    name: 'user',
    email: 'user@testbed.test',
    org_role: 'guest',
  })
  return { t, f, guestSeat }
}

const tokens = (caller: Caller, a: { search?: string; cursor?: string } = {}) =>
  caller.query(api.tokens.personalTokens, a)

/** Every token the caller's list holds for `search`, batch after batch. */
const allTokens = async (caller: Caller, search?: string) =>
  (await walk((cursor) => tokens(caller, { search, cursor }))).flatMap((b) => b.rows)

describe('personal tokens', () => {
  it('lists newest created_at first across the seats, ties by descending id, never by insertion', async () => {
    const { t, f, guestSeat } = await seats()
    await plantTokens(t, f.user, [
      { name: 'home three', created_at: at(30) },
      { name: 'home one', created_at: at(10) },
    ])
    await plantTokens(t, guestSeat, [
      { name: 'guest four', created_at: at(40) },
      { name: 'guest two', created_at: at(20) },
    ])
    // two tokens made at one instant, ordered by their ids
    await plantTokens(t, f.user, [
      { name: 'tie low', created_at: at(50), id: '00000000-0000-4000-8000-000000000001' },
      { name: 'tie high', created_at: at(50), id: 'ffffffff-0000-4000-8000-000000000001' },
    ])
    // inserted last, made first, as a row ported from the old database
    await plantTokens(t, guestSeat, [{ name: 'ported', created_at: at(1) }])
    const batch = await tokens(as(t, f.user))
    expect(batch.rows.map((row) => row.name)).toEqual([
      'tie high',
      'tie low',
      'guest four',
      'home three',
      'guest two',
      'home one',
      'ported',
    ])
    expect(batch).toMatchObject({ next: null, stopped: false })
  })

  it("lists only the caller's active seats outside a deletion", async () => {
    const { t, f, guestSeat } = await seats()
    await plantTokens(t, f.user, [{ name: 'mine', created_at: at(1) }])
    // another login's token in the same organization
    await plantTokens(t, f.admin, [{ name: 'the admin', created_at: at(2) }])
    // the caller's seat that is no longer active
    const thirdOrg = await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('organizations', {
        id,
        name: 'Third',
        slug: 'third',
        created_at: at(0),
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      })
      return id
    })
    const inactive = await plantSeat(t, {
      org_id: thirdOrg,
      auth_user_id: f.user.auth_user_id,
      active: false,
    })
    await plantTokens(t, inactive, [{ name: 'inactive seat', created_at: at(3) }])
    await plantTokens(t, guestSeat, [{ name: 'deleting', created_at: at(4) }])
    expect((await allTokens(as(t, f.user))).map((row) => row.name)).toEqual(['deleting', 'mine'])
    // the guest seat's organization begins its deletion
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.otherOrg.id,
        reason: 'requested',
        ended_at: at(5),
        delete_after: at(5),
        phase: 'profiles',
        created_at: at(5),
      }),
    )
    expect((await allTokens(as(t, f.user))).map((row) => row.name)).toEqual(['mine'])
    expect((await allTokens(as(t, f.admin))).map((row) => row.name)).toEqual(['the admin'])
    // a login with no active seat answers an empty end
    expect(await tokens(t.withIdentity({ subject: 'a-login-without-a-seat' }))).toEqual({
      rows: [],
      next: null,
      stopped: false,
    })
  })

  it("answers each token in pubToken's shape, without its hash, ended ones included", async () => {
    const { t, f } = await seats()
    const [legacy, revoked, expired, byAdmin] = await plantTokens(t, f.user, [
      { name: 'legacy', created_at: at(4), access: 'none', last_used_at: at(9) },
      { name: 'revoked', created_at: at(3), revoked_at: at(8) },
      { name: 'expired', created_at: at(2), access: 'read', expires_at: at(7) },
      { name: 'by admin', created_at: at(1), revoked_at: at(6), revoked_by_admin: true },
    ])
    const { rows } = await tokens(as(t, f.user))
    expect(rows).toEqual([
      {
        id: legacy.id,
        name: 'legacy',
        prefix: legacy.token_prefix,
        access: 'read',
        createdAt: at(4),
        expiresAt: null,
        lastUsedAt: at(9),
        revokedAt: null,
        revokedByAdmin: false,
      },
      {
        id: revoked.id,
        name: 'revoked',
        prefix: revoked.token_prefix,
        access: 'write',
        createdAt: at(3),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: at(8),
        revokedByAdmin: false,
      },
      {
        id: expired.id,
        name: 'expired',
        prefix: expired.token_prefix,
        access: 'read',
        createdAt: at(2),
        expiresAt: at(7),
        lastUsedAt: null,
        revokedAt: null,
        revokedByAdmin: false,
      },
      {
        id: byAdmin.id,
        name: 'by admin',
        prefix: byAdmin.token_prefix,
        access: 'write',
        createdAt: at(1),
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: at(6),
        revokedByAdmin: true,
      },
    ])
    expect(JSON.stringify(rows)).not.toContain(legacy.token_hash)
  })

  it('pages 26 tokens as 25 and then 1, each once, and searches the whole list', async () => {
    const { t, f } = await seats()
    const planted = await plantTokens(
      t,
      f.user,
      Array.from({ length: 26 }, (_, n) => ({
        name: n === 0 ? 'Café laptop' : `Script ${n}`,
        created_at: at(n),
      })),
    )
    const caller = as(t, f.user)
    const [first, second] = await walk((cursor) => tokens(caller, { cursor }))
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first.next).not.toBeNull()
    expect(first.stopped).toBe(false)
    expect(second.rows.map((row) => row.name)).toEqual(['Café laptop'])
    expect(second).toMatchObject({ next: null, stopped: false })
    const ids = [...first.rows, ...second.rows].map((row) => row.id)
    expect(new Set(ids).size).toBe(26)
    // the oldest, past the first batch, by words of its name in other case
    // and without accents, and by its prefix as the row shows it
    const oldest = planted[0]
    for (const search of ['LAPTOP cafe', 'café', oldest.token_prefix.toUpperCase()])
      expect(await tokens(caller, { search }), search).toEqual({
        rows: [expect.objectContaining({ id: oldest.id })],
        next: null,
        stopped: false,
      })
    expect(await tokens(caller, { search: 'nothing like it' })).toEqual({
      rows: [],
      next: null,
      stopped: false,
    })
  })

  it('refuses a long search and foreign cursors before it reads a token', async () => {
    const { t, f } = await seats()
    await plantTokens(
      t,
      f.user,
      Array.from({ length: 26 }, (_, n) => ({ name: `Script ${n}`, created_at: at(n) })),
    )
    const caller = as(t, f.user)
    const long = await refusal(tokens(caller, { search: 'x'.repeat(LIMITS.search.max + 1) }))
    expect(long).toMatchObject({ code: 'rule', message: LIMITS.search.refusal })
    const { next } = await tokens(caller, { search: 'script' })
    if (next === null) throw new Error('the search should go on')
    const login = f.user.auth_user_id as string
    const mine = new Map([[f.org.id, f.user]])
    // another search, the same cursor without its search, another login's,
    // another list's, and junk
    const foreign: [string | undefined, string][] = [
      ['script 1', next],
      [undefined, next],
      [
        undefined,
        await namedCursor(PERSONAL_TOKENS_LIST, [f.admin.auth_user_id as string, ''], {
          key: at(3),
          tie: [uuid()],
        }),
      ],
      [
        undefined,
        await namedCursor(CONNECTED_APPS_LIST, [login, ''], { key: at(3), tie: [1, 'x'] }),
      ],
      [undefined, 'junk'],
    ]
    for (const [n, [search, cursor]] of foreign.entries()) {
      const refused = await refusedRead(t, (ctx) =>
        personalTokensOf(ctx, login, mine, { search, cursor }),
      )
      expect(refused.data, `cursor ${n}`).toEqual({
        code: 'bad_request',
        message: NOT_TOKENS_CURSOR,
      })
      expect(refused.ranges, `cursor ${n}`).toBe(0)
    }
    const longRead = await refusedRead(t, (ctx) =>
      personalTokensOf(ctx, login, mine, { search: 'x'.repeat(LIMITS.search.max + 1) }),
    )
    expect(longRead).toMatchObject({ data: { code: 'rule' }, ranges: 0, documents: 0 })
    // the cursor of its own list and search goes on
    expect((await tokens(caller, { search: 'script', cursor: next })).rows).toHaveLength(1)
  })

  it('stops at a lowered share with a next that goes on to every token once, also searching', async () => {
    const { t, f, guestSeat } = await seats()
    const planted = [
      ...(await plantTokens(
        t,
        f.user,
        Array.from({ length: 13 }, (_, n) => ({
          name: n === 0 ? 'Oldest helper' : `Home ${n}`,
          created_at: at(2 * n),
        })),
      )),
      ...(await plantTokens(
        t,
        guestSeat,
        Array.from({ length: 13 }, (_, n) => ({ name: `Guest ${n}`, created_at: at(2 * n + 1) })),
      )),
    ]
    PERSONAL_TOKENS.reads = { ...NAMED_READ, documents: 4 }
    const caller = as(t, f.user)
    const first = await tokens(caller)
    expect(first.stopped).toBe(true)
    expect(first.next).not.toBeNull()
    expect(first.rows.length).toBeLessThan(LIST_BATCH)
    const every = await walk((cursor) => tokens(caller, { cursor }))
    const ids = every.flatMap((b) => b.rows.map((row) => row.id))
    expect(ids).toEqual(
      [...planted].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((row) => row.id),
    )
    // a search that matches only the oldest stops before it and goes on
    const found = await walk((cursor) => tokens(caller, { search: 'oldest', cursor }))
    expect(found.some((b) => b.stopped && b.rows.length === 0)).toBe(true)
    expect(found.flatMap((b) => b.rows.map((row) => row.name))).toEqual(['Oldest helper'])
    expect(found.at(-1)).toMatchObject({ next: null, stopped: false })
  })

  it('refuses the demo before any read, and a caller who is not signed in', async () => {
    const { t, f } = await seats()
    await plantTokens(t, f.user, [{ name: 'mine', created_at: at(1) }])
    await expect(refusal(t.query(api.tokens.personalTokens, {}))).resolves.toMatchObject({
      code: 'forbidden',
      message: 'not signed in',
    })
    vi.stubEnv('APP_MODE', 'demo')
    const demo = await refusedRead(t, (ctx) =>
      personalTokensOf(ctx, f.user.auth_user_id as string, new Map([[f.org.id, f.user]]), {}),
    )
    expect(demo.data.code).toBe('forbidden')
    expect(demo.ranges).toBe(0)
  })
})

/* ---------------------------------------------------- the connected apps */

/** A connection to plant: its app's name and when it was approved, or
 * undefined for an unfinished authorization, with any stored field. */
type ConnectionSeed = {
  client: string
  approved_at?: string
  created_at?: string
  profile_id?: string
  org_id?: string
  auth_user_id?: string
  client_id?: string
  revoked_at?: string
  revocation_reason?: string
  last_used_at?: string
}

/** Plants `seeds` as OAuth connections of `seat`'s login, in that order,
 * and answers the rows. */
async function plantConnections(
  t: T,
  seat: Doc<'profiles'>,
  seeds: readonly ConnectionSeed[],
): Promise<Doc<'oauth_connections'>[]> {
  return await t.run(async (ctx) => {
    const out: Doc<'oauth_connections'>[] = []
    for (const { client, ...seed } of seeds) {
      const _id = await ctx.db.insert('oauth_connections', {
        id: uuid(),
        authorization_hash: uuid(),
        auth_user_id: seat.auth_user_id as string,
        profile_id: seat.id,
        org_id: seat.org_id,
        client_id: `client-${client}`,
        client_name: client,
        name_key: nameKey(client),
        resource: 'https://api.qivo.test/mcp',
        requested_scopes: ['qivo:read'],
        scopes: seed.approved_at === undefined ? [] : ['qivo:read'],
        created_at: seed.created_at ?? seed.approved_at ?? at(0),
        authorization_expires_at: at(10_000),
        ...seed,
      })
      const row = await ctx.db.get(_id)
      if (row === null) throw new Error('a planted connection vanished')
      out.push(row)
    }
    return out
  })
}

/** Gives Better Auth a client for each of `names`, as `client-<name>`. */
const plantClients = (t: T, names: readonly string[]) =>
  runInAuth(t, async (ctx) => {
    for (const name of names)
      await ctx.db.insert('oauthClient', { clientId: `client-${name}`, redirectUris: [] })
  })

const apps = (caller: Caller, a: { search?: string; cursor?: string } = {}) =>
  caller.query(api.connectedApps.list, a)

/** Every connection the caller's list holds for `search`, batch after batch. */
const allApps = async (caller: Caller, search?: string) =>
  (await walk((cursor) => apps(caller, { search, cursor }))).flatMap((b) => b.rows)

/** withOrg, with the user's guest seat in the other organization. */
const connectionSeats = seats

describe('connected apps', () => {
  it('reads approved connections only, past 20 unfinished authorizations, under a small share', async () => {
    const { t, f } = await connectionSeats()
    await plantClients(t, ['Claude', 'Cursor', 'Zed'])
    // each consent attempt leaves an unfinished authorization, interleaved
    for (let n = 0; n < 20; n++) {
      await plantConnections(t, f.user, [{ client: `Attempt ${n}`, created_at: at(n) }])
      if (n % 7 === 0)
        await plantConnections(t, f.user, [
          { client: ['Claude', 'Cursor', 'Zed'][n / 7], approved_at: at(100 + n) },
        ])
    }
    // three rows, their seat and their organization, with a margin well under 20
    CONNECTED_APPS.reads = { ...NAMED_READ, documents: 10 }
    const batch = await apps(as(t, f.user))
    expect(batch.rows.map((row) => row.clientName)).toEqual(['Zed', 'Cursor', 'Claude'])
    expect(batch).toMatchObject({ next: null, stopped: false })
  })

  it('reads, counts and leaves out deleted connections', async () => {
    const { t, f } = await connectionSeats()
    await plantClients(t, ['Claude', 'Cursor'])
    await plantConnections(t, f.user, [{ client: 'Claude', approved_at: at(1) }])
    await plantConnections(
      t,
      f.user,
      Array.from({ length: 26 }, (_, n) => ({
        client: 'Cursor',
        approved_at: at(10 + n),
        revoked_at: at(100),
        revocation_reason: 'deleted',
      })),
    )
    await plantConnections(t, f.user, [{ client: 'Cursor', approved_at: at(200) }])
    const caller = as(t, f.user)
    expect((await allApps(caller)).map((row) => row.clientName)).toEqual(['Cursor', 'Claude'])
    // the deleted rows fill a small share, so they were read
    CONNECTED_APPS.reads = { ...NAMED_READ, documents: 8 }
    const batches = await walk((cursor) => apps(caller, { cursor }))
    expect(batches[0]).toMatchObject({ stopped: true })
    expect(batches.flatMap((b) => b.rows.map((row) => row.clientName))).toEqual([
      'Cursor',
      'Claude',
    ])
  })

  it('lists newest approval first, equal approvals newest row first, not by creation', async () => {
    const { t, f } = await connectionSeats()
    await plantClients(t, ['Early', 'Late', 'Tie A', 'Tie B'])
    await plantConnections(t, f.user, [
      // made first, approved last, after the consent screen stayed open
      { client: 'Early', created_at: at(1), approved_at: at(50) },
      { client: 'Late', created_at: at(20), approved_at: at(21) },
      { client: 'Tie A', approved_at: at(30) },
      { client: 'Tie B', approved_at: at(30) },
    ])
    expect((await allApps(as(t, f.user))).map((row) => row.clientName)).toEqual([
      'Early',
      'Tie B',
      'Tie A',
      'Late',
    ])
  })

  it("never lists another login's connections, and works for a login without a seat", async () => {
    const { t, f } = await connectionSeats()
    await plantClients(t, ['Mine', 'Theirs'])
    await plantConnections(t, f.user, [{ client: 'Mine', approved_at: at(1) }])
    await plantConnections(t, f.admin, [{ client: 'Theirs', approved_at: at(2) }])
    expect((await allApps(as(t, f.user))).map((row) => row.clientName)).toEqual(['Mine'])
    expect((await allApps(as(t, f.admin))).map((row) => row.clientName)).toEqual(['Theirs'])
    // the user's seats leave, and the login keeps its connection
    await t.run(async (ctx) => {
      for (const p of await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', f.user.auth_user_id))
        .collect())
        await ctx.db.delete(p._id)
    })
    const caller = t.withIdentity({ subject: f.user.auth_user_id as string })
    expect(await caller.query(api.connectedApps.list, {})).toEqual({
      rows: [
        expect.objectContaining({
          clientName: 'Mine',
          profileName: REMOVED_MEMBER,
          orgName: 'Testbed Labs',
        }),
      ],
      next: null,
      stopped: false,
    })
  })

  it("names a gone seat, a gone organization and another login's seat as removed", async () => {
    const { t, f, guestSeat } = await connectionSeats()
    await plantClients(t, ['Home', 'Guest', 'Borrowed', 'Gone org'])
    const goneOrg = uuid()
    await plantConnections(t, f.user, [
      { client: 'Home', approved_at: at(4) },
      { client: 'Guest', approved_at: at(3), profile_id: guestSeat.id, org_id: f.otherOrg.id },
      // a seat id that now names another login's seat
      { client: 'Borrowed', approved_at: at(2), profile_id: f.admin.id },
      { client: 'Gone org', approved_at: at(1), org_id: goneOrg },
    ])
    const caller = as(t, f.user)
    const names = async () =>
      (await allApps(caller)).map((row) => [row.clientName, row.orgName, row.profileName])
    expect(await names()).toEqual([
      ['Home', 'Testbed Labs', 'user'],
      ['Guest', 'Other', 'user'],
      ['Borrowed', 'Testbed Labs', REMOVED_MEMBER],
      ['Gone org', REMOVED_ORGANIZATION, 'user'],
    ])
    await t.run(async (ctx) => {
      await ctx.db.delete(guestSeat._id)
    })
    expect((await names())[1]).toEqual(['Guest', 'Other', REMOVED_MEMBER])
    // a search finds what the row shows, never the borrowed seat's name
    expect((await allApps(caller, 'removed member')).map((row) => row.clientName)).toEqual([
      'Guest',
      'Borrowed',
    ])
    expect(await allApps(caller, 'admin')).toEqual([])
  })

  it('marks an admin revoke, and a gone app only for an unrevoked connection after the search', async () => {
    const { t, f } = await connectionSeats()
    await plantClients(t, ['Kept', 'By admin'])
    const rows = await plantConnections(t, f.user, [
      { client: 'Kept', approved_at: at(5), last_used_at: at(9) },
      { client: 'By admin', approved_at: at(4), revoked_at: at(8), revocation_reason: 'admin' },
      // Better Auth no longer has these two clients
      { client: 'Vanished', approved_at: at(3) },
      { client: 'Vanished revoked', approved_at: at(2), revoked_at: at(7), revocation_reason: 'x' },
    ])
    const listed = await allApps(as(t, f.user))
    const expected: ConnectedAppRow[] = rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name,
      profileId: f.user.id,
      profileName: 'user',
      orgId: f.org.id,
      orgName: 'Testbed Labs',
      scopes: ['qivo:read'],
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      revokedAt: row.revoked_at ?? null,
      revokedByAdmin: row.revocation_reason === 'admin',
      appGone: row.client_name === 'Vanished',
    }))
    expect(listed).toEqual(expected)
    // the component is asked only for unrevoked rows the search keeps
    const asks = (search?: string) =>
      t.run(async (ctx) => {
        const runQuery = vi.spyOn(ctx, 'runQuery')
        const batch = await connectedAppsOf(ctx, f.user.auth_user_id as string, { search })
        return {
          names: batch.rows.map((row) => row.clientName),
          asked: runQuery.mock.calls.map(([, args]) => args),
        }
      })
    expect(await asks()).toEqual({
      names: ['Kept', 'By admin', 'Vanished', 'Vanished revoked'],
      asked: [{ clientId: 'client-Kept' }, { clientId: 'client-Vanished' }],
    })
    expect(await asks('kept')).toEqual({ names: ['Kept'], asked: [{ clientId: 'client-Kept' }] })
  })

  it('pages 26 connections as 25 and 1, and searches by app, organization and seat name', async () => {
    const { t, f, guestSeat } = await connectionSeats()
    await plantClients(t, ['Assistant', 'Zéphyr'])
    await plantConnections(t, f.user, [
      { client: 'Zéphyr', approved_at: at(0), profile_id: guestSeat.id, org_id: f.otherOrg.id },
    ])
    await plantConnections(
      t,
      f.user,
      Array.from({ length: 25 }, (_, n) => ({ client: 'Assistant', approved_at: at(1 + n) })),
    )
    const caller = as(t, f.user)
    const [first, second] = await walk((cursor) => apps(caller, { cursor }))
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first).toMatchObject({ stopped: false })
    expect(second.rows.map((row) => row.clientName)).toEqual(['Zéphyr'])
    expect(second).toMatchObject({ next: null, stopped: false })
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(26)
    // by the app's name without its accent, the organization's and the seat's
    for (const search of ['ZEPHYR', 'other', 'user zeph'])
      expect(await apps(caller, { search }), search).toEqual({
        rows: [expect.objectContaining({ clientName: 'Zéphyr' })],
        next: null,
        stopped: false,
      })
    expect((await apps(caller, { search: 'testbed labs assistant' })).rows).toHaveLength(25)
    expect(await apps(caller, { search: 'nowhere' })).toEqual({
      rows: [],
      next: null,
      stopped: false,
    })
  })

  it('refuses a long search, foreign cursors, the demo and no sign-in before it reads a connection', async () => {
    const { t, f } = await connectionSeats()
    await plantClients(t, ['App'])
    await plantConnections(
      t,
      f.user,
      Array.from({ length: 26 }, (_, n) => ({ client: 'App', approved_at: at(n) })),
    )
    const caller = as(t, f.user)
    const login = f.user.auth_user_id as string
    expect(await refusal(apps(caller, { search: 'x'.repeat(LIMITS.search.max + 1) }))).toEqual({
      code: 'rule',
      message: LIMITS.search.refusal,
    })
    const { next } = await apps(caller, { search: 'app' })
    if (next === null) throw new Error('the search should go on')
    const foreign: [string | undefined, string][] = [
      ['app 1', next],
      [undefined, next],
      [
        undefined,
        await namedCursor(CONNECTED_APPS_LIST, [f.admin.auth_user_id as string, ''], {
          key: at(3),
          tie: [1, 'x'],
        }),
      ],
      [undefined, await namedCursor(PERSONAL_TOKENS_LIST, [login, ''], { key: at(3), tie: ['x'] })],
      [undefined, 'junk'],
    ]
    for (const [n, [search, cursor]] of foreign.entries()) {
      const refused = await refusedRead(t, (ctx) => connectedAppsOf(ctx, login, { search, cursor }))
      expect(refused.data, `cursor ${n}`).toEqual({ code: 'bad_request', message: NOT_APPS_CURSOR })
      expect(refused.ranges, `cursor ${n}`).toBe(0)
    }
    expect((await apps(caller, { search: 'app', cursor: next })).rows).toHaveLength(1)
    await expect(refusal(t.query(api.connectedApps.list, {}))).resolves.toMatchObject({
      code: 'forbidden',
      message: 'not signed in',
    })
    vi.stubEnv('APP_MODE', 'demo')
    const demo = await refusedRead(t, (ctx) => connectedAppsOf(ctx, login, {}))
    expect(demo.data.code).toBe('forbidden')
    expect(demo.ranges).toBe(0)
  })

  it('stops at a lowered share with a next that goes on to every connection once', async () => {
    const { t, f } = await connectionSeats()
    const planted = await plantConnections(
      t,
      f.user,
      Array.from({ length: 26 }, (_, n) => ({
        client: n === 0 ? 'Oldest helper' : `App ${n}`,
        approved_at: at(n),
      })),
    )
    await plantClients(
      t,
      planted.map((row) => row.client_name),
    )
    CONNECTED_APPS.reads = { ...NAMED_READ, documents: 5 }
    const caller = as(t, f.user)
    const batches = await walk((cursor) => apps(caller, { cursor }))
    expect(batches[0].stopped).toBe(true)
    expect(batches.flatMap((b) => b.rows.map((row) => row.id))).toEqual(
      [...planted].reverse().map((row) => row.id),
    )
    const found = await walk((cursor) => apps(caller, { search: 'oldest', cursor }))
    expect(found.some((b) => b.stopped && b.rows.length === 0)).toBe(true)
    expect(found.flatMap((b) => b.rows.map((row) => row.clientName))).toEqual(['Oldest helper'])
  })
})

/* -------------------------------------------------------- the deprecated */

describe('the deprecated full lists', () => {
  it('keeps listMcpTokens answering every token of every active seat, newest first', async () => {
    const { t, f, guestSeat } = await seats()
    await plantTokens(t, f.user, [{ name: 'home', created_at: at(1) }])
    await plantTokens(t, guestSeat, [{ name: 'guest', created_at: at(2), access: 'none' }])
    const rows = await as(t, f.user).query(api.tokens.listMcpTokens, {})
    expect(rows.map((row) => [row.name, row.access])).toEqual([
      ['guest', 'read'],
      ['home', 'write'],
    ])
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'access',
        'createdAt',
        'expiresAt',
        'id',
        'lastUsedAt',
        'name',
        'prefix',
        'revokedAt',
        'revokedByAdmin',
      ].sort(),
    )
  })

  it('keeps oauthConnections.list answering every approved connection, newest created first', async () => {
    const { t, f } = await seats()
    await plantClients(t, ['Early'])
    await plantConnections(t, f.user, [
      { client: 'Early', created_at: at(1), approved_at: at(50) },
      { client: 'Late', created_at: at(20), approved_at: at(21) },
      { client: 'Unfinished', created_at: at(30) },
      { client: 'Deleted', approved_at: at(40), revoked_at: at(41), revocation_reason: 'deleted' },
    ])
    const rows = await as(t, f.user).query(api.oauthConnections.list, {})
    expect(rows.map((row) => [row.clientName, row.appGone])).toEqual([
      ['Late', true],
      ['Early', false],
    ])
  })
})

/* ---------------------------------------------------- everyday reads */

describe('reads everyday batches', () => {
  it('reads a first batch and a search with no match of 26 tokens, and 26 approved beside 26 deleted connections', async () => {
    const { t, f } = await seats()
    await plantTokens(
      t,
      f.user,
      Array.from({ length: 26 }, (_, n) => ({
        name: `A token with an ordinary name ${n}`,
        created_at: at(n),
      })),
    )
    const login = f.user.auth_user_id as string
    const mine = new Map([[f.org.id, f.user]])
    const first = await measured(t, (ctx) => personalTokensOf(ctx, login, mine, {}))
    const none = await measured(t, (ctx) =>
      personalTokensOf(ctx, login, mine, { search: 'nothing like it' }),
    )
    expect((first.out as PersonalTokenBatch).rows).toHaveLength(LIST_BATCH)
    expect((none.out as PersonalTokenBatch).rows).toEqual([])
    await plantClients(t, ['Assistant'])
    for (let n = 0; n < 26; n++)
      await plantConnections(t, f.user, [
        { client: 'Assistant', approved_at: at(2 * n + 1) },
        {
          client: 'Assistant',
          approved_at: at(2 * n),
          revoked_at: at(100),
          revocation_reason: 'deleted',
        },
      ])
    const connections = await measured(t, (ctx) => connectedAppsOf(ctx, login, {}))
    expect((connections.out as ConnectedAppBatch).rows).toHaveLength(LIST_BATCH)
    console.log(
      'MCP access lists at everyday sizes',
      JSON.stringify({
        tokensFirst: first.read,
        tokensSearchNone: none.read,
        connectionsFirst: connections.read,
      }),
    )
    for (const read of [first.read, none.read, connections.read]) {
      expect(read.ranges).toBeLessThan(NAMED_READ.ranges)
      expect(read.documents).toBeLessThan(100)
    }
  })
})
