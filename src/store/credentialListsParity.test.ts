/* MCP access's stand-in (store/credentialListsStandIn.setup.ts) against
 * the real queries (convex/tokens.ts personalTokens and
 * convex/connectedApps.ts list) on convex-test, as
 * peopleSettingsParity.test.ts holds the Users page's stand-in to its
 * reads. It compares every batch from the start to the end, and with
 * searches, cursors compared by where they lead, over everyday rows, 26
 * tokens of one seat, 26 tokens over three seats, 26 approved connections
 * interleaved with 26 deleted ones and 20 unfinished authorizations, and
 * equal creation and approval times. It also compares the refusals, and
 * holds the stand-in's own forced states. No design-size figure covers
 * these lists, so no case raises one. */

import { makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import { LIMITS, LIST_BATCH } from '../../convex/lib/limits'
import { named, nameKey } from '../../convex/lib/nameKey'
import {
  as,
  newT,
  plantSeat,
  runInAuth,
  type T,
  uuid,
  withOrg,
} from '../../convex/tests/helpers.setup'
import {
  type CredentialListRead,
  type CredentialWorld,
  credentialListsStandIn,
  type ForcedCredentialLists,
  type StandInConnection,
} from './credentialListsStandIn.setup'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'credential-lists-parity-secret-not-a-deployment-key'
})

type Args = { search?: string; cursor?: string }
type Batch = { rows: { id: string }[]; next: string | null; stopped: boolean }

/** What both answer, with each cursor replaced by whether it is there. */
const shape = (b: Batch) => ({ ...b, next: b.next !== null })

/** An ISO time `minutes` after the start of 2026. */
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString()

/** The caller's login, its seats and three seats' worth of rows. */
async function caller() {
  const t = newT()
  const f = await withOrg(t)
  const login = f.user.auth_user_id as string
  const guest = await plantSeat(t, {
    org_id: f.otherOrg.id,
    auth_user_id: login,
    name: 'user',
    org_role: 'guest',
  })
  return { t, f, login, seats: [f.user, guest] }
}

let minted = 0

/** Plants tokens `names` with created_at `when(n)` on seat `seat(n)`. */
async function plantTokens(
  t: T,
  count: number,
  seat: (n: number) => Doc<'profiles'>,
  when: (n: number) => string,
  name: (n: number) => string = (n) => `Script ${n}`,
) {
  await t.run(async (ctx) => {
    for (let n = 0; n < count; n++) {
      const owner = seat(n)
      const m = ++minted
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: owner.id,
        org_id: owner.org_id,
        ...named(name(n)),
        token_prefix: `qvt_${m.toString(16).padStart(7, '0')}`,
        token_hash: m.toString(16).padStart(64, '0'),
        ...(n % 5 === 4 ? {} : { access: n % 2 ? 'read' : 'write' }),
        ...(n % 7 === 3 ? { revoked_at: at(500) } : {}),
        created_at: when(n),
      })
    }
  })
}

type ConnectionSeed = {
  client: string
  approved_at?: string
  seat?: Doc<'profiles'>
  revocation_reason?: string
}

/** Plants connections of `login`, in order, on `seat` unless a seed names
    another. */
async function plantConnections(
  t: T,
  login: string,
  seat: Doc<'profiles'>,
  seeds: readonly ConnectionSeed[],
) {
  await t.run(async (ctx) => {
    for (const s of seeds) {
      const owner = s.seat ?? seat
      await ctx.db.insert('oauth_connections', {
        id: uuid(),
        authorization_hash: uuid(),
        auth_user_id: login,
        profile_id: owner.id,
        org_id: owner.org_id,
        client_id: `client-${s.client}`,
        client_name: s.client,
        name_key: nameKey(s.client),
        resource: 'https://api.qivo.test/mcp',
        requested_scopes: ['qivo:read'],
        scopes: s.approved_at === undefined ? [] : ['qivo:read'],
        created_at: s.approved_at ?? at(0),
        authorization_expires_at: at(10_000),
        ...(s.approved_at === undefined ? {} : { approved_at: s.approved_at }),
        ...(s.revocation_reason === undefined
          ? {}
          : { revoked_at: at(900), revocation_reason: s.revocation_reason }),
      })
    }
  })
}

/** The world the stand-in reads, from what the server holds for `login`
    with active seats `seats`. */
async function worldOf(
  t: T,
  login: string,
  seats: readonly Doc<'profiles'>[],
): Promise<CredentialWorld> {
  const clients = await runInAuth(t, async (ctx) =>
    (await ctx.db.query('oauthClient').collect()).map((c) => c.clientId),
  )
  return await t.run(async (ctx) => {
    const tokens = (await ctx.db.query('mcp_tokens').collect()).map((r) => ({
      seat: r.profile_id,
      id: r.id,
      name: r.name,
      prefix: r.token_prefix,
      access: r.access ?? 'read',
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? null,
      lastUsedAt: r.last_used_at ?? null,
      revokedAt: r.revoked_at ?? null,
      revokedByAdmin: r.revoked_by_admin === true,
    }))
    const connections: StandInConnection[] = []
    for (const r of await ctx.db.query('oauth_connections').collect()) {
      const seat = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', r.profile_id))
        .unique()
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', r.org_id))
        .unique()
      connections.push({
        id: r.id,
        clientId: r.client_id,
        clientName: r.client_name,
        profileId: r.profile_id,
        orgId: r.org_id,
        scopes: r.scopes,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at ?? null,
        revokedAt: r.revoked_at ?? null,
        login: r.auth_user_id,
        approvedAt: r.approved_at ?? null,
        revocationReason: r.revocation_reason ?? null,
        created: r._creationTime,
        profileName: seat?.auth_user_id === r.auth_user_id ? seat.name : null,
        orgName: org?.name ?? null,
        clientGone: !clients.includes(r.client_id),
      })
    }
    return { login, seats: seats.map((s) => s.id), tokens, connections }
  })
}

/** Both answers of read `name` for `search`, each following its own
    cursors to the end. */
async function both(
  t: T,
  login: string,
  world: CredentialWorld,
  name: CredentialListRead,
  search?: string,
) {
  const server: Batch[] = []
  const stand: Batch[] = []
  let cursor: { server?: string; stand?: string } = {}
  const ask = (c: string | undefined): Args => ({
    ...(search === undefined ? {} : { search }),
    ...(c === undefined ? {} : { cursor: c }),
  })
  for (let round = 0; round < 50; round++) {
    const s = (await t
      .withIdentity({ subject: login })
      .query(makeFunctionReference<'query'>(name), ask(cursor.server))) as Batch
    const o = credentialListsStandIn(name, ask(cursor.stand), world) as Batch
    server.push(s)
    stand.push(o)
    if (!s.next || !o.next) return { server, stand }
    cursor = { server: s.next, stand: o.next }
  }
  throw new Error('the list did not end')
}

/** Expects the stand-in to answer read `name` for `search` as the server
    does, batch after batch, and answers the server's batches. */
async function same(
  t: T,
  login: string,
  world: CredentialWorld,
  name: CredentialListRead,
  search?: string,
) {
  const walked = await both(t, login, world, name, search)
  expect(walked.stand.map(shape), `${name} ${search ?? ''}`).toEqual(walked.server.map(shape))
  return walked.server
}

/** The refusal `run` throws, which must be a typed one. */
function refusalOf(run: () => unknown) {
  try {
    run()
  } catch (e) {
    if (e instanceof ConvexError) return e.data
    throw e
  }
  throw new Error('no refusal')
}
async function serverRefusal(promise: Promise<unknown>) {
  const outcome = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(outcome instanceof ConvexError)) throw new Error(`no refusal: ${String(outcome)}`)
  return outcome.data
}

describe("MCP access's stand-in", () => {
  it('answers three tokens and three connections, in everyday use, as the server does', async () => {
    const { t, login, seats } = await caller()
    await plantTokens(
      t,
      3,
      () => seats[0],
      (n) => at(n),
    )
    await runInAuth(t, (ctx) =>
      ctx.db.insert('oauthClient', { clientId: 'client-Claude', redirectUris: [] }),
    )
    await plantConnections(t, login, seats[0], [
      { client: 'Claude', approved_at: at(1) },
      { client: 'Cursor', approved_at: at(2), seat: seats[1] },
      { client: 'Zed', approved_at: at(3), revocation_reason: 'admin' },
      { client: 'Attempt' },
    ])
    const world = await worldOf(t, login, seats)
    const tokens = await same(t, login, world, 'tokens:personalTokens')
    expect(tokens[0].rows).toHaveLength(3)
    const apps = await same(t, login, world, 'connectedApps:list')
    expect(apps[0].rows).toHaveLength(3)
    for (const search of ['script 1', 'QVT_', 'nothing'])
      await same(t, login, world, 'tokens:personalTokens', search)
    for (const search of ['other cursor', 'removed', 'testbed', 'nothing'])
      await same(t, login, world, 'connectedApps:list', search)
  })

  it('answers 26 tokens of one seat and 26 over three seats, with ties, batch by batch and searched', async () => {
    const { t, f, login, seats } = await caller()
    const third = await plantSeat(t, {
      org_id: (
        await t.run(async (ctx) => {
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
          return { id }
        })
      ).id,
      auth_user_id: login,
      name: 'user',
    })
    // one seat, each pair made at one instant
    await plantTokens(
      t,
      26,
      () => seats[0],
      (n) => at(Math.floor(n / 2)),
    )
    const one = await worldOf(t, login, seats)
    const batches = await same(t, login, one, 'tokens:personalTokens')
    expect(batches.map((b) => b.rows.length)).toEqual([LIST_BATCH, 1])
    for (const search of ['script 2', 'SCRIPT 25', 'nothing like it'])
      await same(t, login, one, 'tokens:personalTokens', search)
    // 26 more over three seats, interleaved in time
    const all = [...seats, third]
    await plantTokens(
      t,
      26,
      (n) => all[n % 3],
      (n) => at(100 + n),
      (n) => `Laptop ${n}`,
    )
    const three = await worldOf(t, login, all)
    const merged = await same(t, login, three, 'tokens:personalTokens')
    expect(merged.flatMap((b) => b.rows)).toHaveLength(52)
    for (const search of ['laptop 1', 'nothing like it'])
      await same(t, login, three, 'tokens:personalTokens', search)
    // another login's tokens are in neither
    expect(three.tokens.some((tk) => tk.seat === f.admin.id)).toBe(false)
  })

  it('answers 26 approved connections among deleted ones and unfinished authorizations, with ties', async () => {
    const { t, login, seats } = await caller()
    await runInAuth(t, async (ctx) => {
      for (const client of ['Assistant', 'Tied'])
        await ctx.db.insert('oauthClient', { clientId: `client-${client}`, redirectUris: [] })
    })
    const seeds: ConnectionSeed[] = []
    for (let n = 0; n < 26; n++) {
      seeds.push({
        client: n % 4 === 0 ? 'Tied' : 'Assistant',
        approved_at: at(n % 4 === 0 ? 7 : 10 + n),
      })
      seeds.push({ client: 'Gone', approved_at: at(10 + n), revocation_reason: 'deleted' })
      if (n < 20) seeds.push({ client: `Attempt ${n}` })
    }
    seeds.push({ client: 'Elsewhere', approved_at: at(3), seat: seats[1] })
    await plantConnections(t, login, seats[0], seeds)
    const world = await worldOf(t, login, seats)
    const batches = await same(t, login, world, 'connectedApps:list')
    expect(batches.flatMap((b) => b.rows)).toHaveLength(27)
    for (const search of ['tied', 'other', 'testbed assistant', 'nothing'])
      await same(t, login, world, 'connectedApps:list', search)
  })

  it('refuses a long search and foreign cursors as the server does', async () => {
    const { t, f, login, seats } = await caller()
    await plantTokens(
      t,
      26,
      () => seats[0],
      (n) => at(n),
    )
    await plantConnections(
      t,
      login,
      seats[0],
      Array.from({ length: 26 }, (_, n) => ({ client: 'App', approved_at: at(n) })),
    )
    const world = await worldOf(t, login, seats)
    const long = { search: 'x'.repeat(LIMITS.search.max + 1) }
    const user = t.withIdentity({ subject: login })
    for (const name of ['tokens:personalTokens', 'connectedApps:list'] as const) {
      const ref = makeFunctionReference<'query'>(name)
      expect(refusalOf(() => credentialListsStandIn(name, long, world))).toEqual(
        await serverRefusal(user.query(ref, long)),
      )
      const server = (await user.query(ref, {})) as Batch
      const stand = credentialListsStandIn(name, {}, world) as Batch
      const other =
        name === 'tokens:personalTokens' ? 'connectedApps:list' : 'tokens:personalTokens'
      const foreign = credentialListsStandIn(other, {}, world) as Batch
      // its own cursor under another search, and another list's
      expect(
        refusalOf(() => credentialListsStandIn(name, { search: 'a', cursor: stand.next }, world)),
      ).toEqual(
        await serverRefusal(user.query(ref, { search: 'a', cursor: server.next as string })),
      )
      expect(
        refusalOf(() => credentialListsStandIn(name, { cursor: foreign.next }, world)),
      ).toEqual(await serverRefusal(user.query(ref, { cursor: 'junk' })))
      // another login's cursor
      const stranger = { ...world, login: 'someone-else' }
      expect(
        refusalOf(() => credentialListsStandIn(name, { cursor: stand.next }, stranger)),
      ).toEqual(await serverRefusal(as(t, f.admin).query(ref, { cursor: server.next as string })))
    }
  })
})

describe("the stand-in's forced states", () => {
  /** A world of `n` tokens and `n` approved connections. */
  const world = (n: number): CredentialWorld => ({
    login: 'login',
    seats: ['seat'],
    tokens: Array.from({ length: n }, (_, i) => ({
      seat: 'seat',
      id: `token-${String(i).padStart(2, '0')}`,
      name: `Token ${i}`,
      prefix: `qvt_${String(i).padStart(7, '0')}`,
      access: 'write' as const,
      createdAt: at(i),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedByAdmin: false,
    })),
    connections: Array.from({ length: n }, (_, i) => ({
      id: `app-${i}`,
      clientId: `client-${i}`,
      clientName: `App ${i}`,
      profileId: 'seat',
      orgId: 'org',
      scopes: ['qivo:read'],
      createdAt: at(i),
      lastUsedAt: null,
      revokedAt: null,
      login: 'login',
      approvedAt: at(i),
      revocationReason: null,
      created: i,
      profileName: 'Nora Berg',
      orgName: 'Northstar Labs',
      clientGone: false,
    })),
  })
  const read = (name: CredentialListRead, force: ForcedCredentialLists, args: Args = {}) =>
    credentialListsStandIn(name, args, world(30), force) as Batch

  it('stops a batch after the rows it looked at, with a next that goes on, and never as an end', () => {
    for (const name of ['tokens:personalTokens', 'connectedApps:list'] as const) {
      const first = read(name, { stop: 4 })
      expect(first.rows).toHaveLength(4)
      expect(first.stopped).toBe(true)
      expect(first.next).not.toBeNull()
      const searched = read(name, { stop: 4 }, { search: '29' })
      expect(searched).toMatchObject({ rows: [expect.anything()], stopped: true })
      const nothing = read(name, { stop: 4 }, { search: '3' })
      expect(nothing.rows.length).toBeLessThan(4)
      expect(nothing.stopped).toBe(true)
    }
  })

  it('answers smaller batches and fails every read when asked', () => {
    for (const name of ['tokens:personalTokens', 'connectedApps:list'] as const) {
      expect(read(name, { batch: 5 }).rows).toHaveLength(5)
      expect(read(name, {}).rows).toHaveLength(LIST_BATCH)
      expect(() => read(name, { fail: true })).toThrow(/fails/)
    }
    expect(() => credentialListsStandIn('tokens:listMcpTokens', {}, world(1))).toThrow(
      /do not answer/,
    )
  })

  it('refuses a cursor of another list, login or search, junk and a long search, and goes on after its own', () => {
    const w = world(30)
    const tokens = credentialListsStandIn('tokens:personalTokens', {}, w) as Batch
    const apps = credentialListsStandIn('connectedApps:list', {}, w) as Batch
    const bad = (name: CredentialListRead, args: Args, on = w) =>
      refusalOf(() => credentialListsStandIn(name, args, on))
    expect(bad('tokens:personalTokens', { cursor: apps.next as string })).toMatchObject({
      code: 'bad_request',
    })
    expect(bad('connectedApps:list', { cursor: tokens.next as string })).toMatchObject({
      code: 'bad_request',
    })
    expect(bad('tokens:personalTokens', { cursor: 'junk' })).toMatchObject({ code: 'bad_request' })
    expect(
      bad('tokens:personalTokens', { cursor: tokens.next as string }, { ...w, login: 'other' }),
    ).toMatchObject({ code: 'bad_request' })
    expect(
      bad('tokens:personalTokens', { search: 't', cursor: tokens.next as string }),
    ).toMatchObject({
      code: 'bad_request',
    })
    expect(bad('connectedApps:list', { search: 'x'.repeat(LIMITS.search.max + 1) })).toEqual({
      code: 'rule',
      message: LIMITS.search.refusal,
    })
    const rest = credentialListsStandIn(
      'tokens:personalTokens',
      { cursor: tokens.next as string },
      w,
    ) as Batch
    expect(rest).toMatchObject({ next: null, stopped: false })
    expect(rest.rows).toHaveLength(5)
  })
})
