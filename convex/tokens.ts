/* Agent keys + personal MCP tokens (phase 5). Ported from 0100 (agent_keys
 * + policies) and 0030 (mcp_tokens): both tables store only a SHA-256 hex
 * hash and a safe display identifier — a first/last fingerprint for agent
 * keys, a short prefix for personal MCP tokens. The secret is minted in the
 * BROWSER (`qva_`/`qvt_` + 48 hex chars), hashed with WebCrypto, and only
 * the display value plus hash crosses the wire. The
 * plaintext never touches the server; create returns `{id}` and the client
 * assembles the P.* `{id, secret}` shape itself.
 *
 * Rights split (the two tables' whole difference): agent keys are managed
 * by ADMINS of the agent's org — nobody else sees the rows at all — while
 * MCP tokens are created, listed and deleted by their owner here. An
 * organization admin can also list every member's tokens and revoke them on
 * API access (apiAccess.ts), which marks the row revoked_by_admin and
 * narrates for admins only, who read it in the organization export.
 * Narration is equally split (T8): agent key create/revoke narrate against
 * the AGENT profile ("what happened to this user"); the owner's own token
 * churn here never narrates.
 *
 * A personal token also carries its access ('read' or 'write', chosen at
 * creation; a row without one can only read) and an optional expiry, after
 * which machine auth refuses it like a revoked one (lib/access.ts
 * credentialAccess). Agent keys have neither, because the agent's role
 * decides.
 *
 * last_used_at is written only by phase 8's machine auth; revoked keys stay
 * listed. A key row whose plaintext is gone is still a real row (its holder
 * can still revoke it by fingerprint); never "clean up" such rows.
 *
 * Settings › Users reads the keys of the agents it shows with agentKeys,
 * once for the key lines and once for a panel that opens, and again after
 * a key write and when the tab shows again, never as a subscription.
 * MCP access lists the caller's own tokens with personalTokens, 25 a batch,
 * newest first, with a search and Load more, each batch read once on
 * opening and again from the first batch after a create, revoke or delete,
 * never as a subscription either, and lists the login's connected apps the
 * same way (connectedApps.ts). Machine auth stamps last_used_at on every
 * call, so a live read of key or token rows would run again on each API
 * call of each credential on screen. listMcpTokens, which the app read
 * before, stays for one release, deprecated. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { cleanTokenExpiry } from './lib/access'
import type { ReadCeiling } from './lib/archivedTasks'
import { assertNewRowId, byId, insertUnique } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { vCredentialAccess } from './lib/enums'
import {
  accessRemovalMutation,
  authedMutation,
  authedQuery,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  orgQuery,
  rule,
} from './lib/functions'
import { limitedText } from './lib/limitRules'
import { LIMITS, LIST_BATCH } from './lib/limits'
import {
  indexAfter,
  type ListBatch,
  listBatch,
  mergeNamed,
  NAMED_READ,
  type NamedAt,
  type NamedIndex,
  namedCeiling,
  openNamedCursor,
} from './lib/namedPages'
import { named, nameKey } from './lib/nameKey'
import { allWordsMatcher } from './lib/search'
import { logActivity } from './model/activity'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/* key_hash / token_hash CHECK (0100:50 / 0030:14). */
const HASH_RE = /^[0-9a-f]{64}$/

/* The display identifiers the app derives from a fresh secret
 * (src/store/planner.ts createAgentKey and createMcpToken): an agent key's
 * first 7 and last 5 characters, a personal token's first 11. Nothing else is
 * stored, so the settings lists only ever show these. */
const KEY_PREFIX_RE = /^qva_[0-9a-f]{3}\.\.\.[0-9a-f]{5}$/
const TOKEN_PREFIX_RE = /^qvt_[0-9a-f]{7}$/

/** A key or token name as stored: trimmed, and refused when nothing is left
 * or past LIMITS.keyName or LIMITS.tokenName. `what` names the credential
 * in the sentences. */
function credentialName(raw: string, what: 'key' | 'token'): string {
  const name = limitedText(what === 'key' ? LIMITS.keyName : LIMITS.tokenName, raw)
  if (name === '') throw rule(`a ${what} needs a name`)
  return name
}

/* The listing shape the Settings page renders — the old client's camelCase
 * mapping, nulls included (the P.* contract carried Postgres nulls). */
const pubKey = (k: Doc<'agent_keys'>) => ({
  id: k.id,
  agentId: k.profile_id,
  name: k.name,
  prefix: k.key_prefix,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at ?? null,
  revokedAt: k.revoked_at ?? null,
})

const pubToken = (t: Doc<'mcp_tokens'>) => ({
  id: t.id,
  name: t.name,
  prefix: t.token_prefix,
  // a token minted before access existed can only read
  access: t.access ?? 'read',
  createdAt: t.created_at,
  expiresAt: t.expires_at ?? null,
  lastUsedAt: t.last_used_at ?? null,
  revokedAt: t.revoked_at ?? null,
  // an organization admin revoked it on API access
  revokedByAdmin: t.revoked_by_admin === true,
})

const byCreatedDesc = <R extends { createdAt: string }>(rows: R[]): R[] =>
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))

/** The caller's own seat with id `profileId`, if it is one. */
const ownSeat = (
  myProfiles: Map<string, Doc<'profiles'>>,
  profileId: string,
): Doc<'profiles'> | undefined => {
  for (const p of myProfiles.values()) if (p.id === profileId) return p
  return undefined
}

const isMine = (myProfiles: Map<string, Doc<'profiles'>>, profileId: string): boolean =>
  ownSeat(myProfiles, profileId) !== undefined

/* ------------------------------------------------------------- agent keys
 * agent_keys policies (0100:66-84): every operation requires admin of the
 * agent's org. The fence reads uniform not-found for a missing, foreign or
 * non-agent target (agents are org-visible, so this leaks nothing), then
 * the admin gate. */
async function myAgentKey(
  ctx: MeCtx,
  id: string,
): Promise<{ key: Doc<'agent_keys'>; agent: Doc<'profiles'> }> {
  const key = await byId(ctx, 'agent_keys', id)
  const agent = key === null ? null : await byId(ctx, 'profiles', key.profile_id)
  if (key === null || agent === null || agent.org_id !== ctx.me.org_id) {
    throw notFound('key not found')
  }
  if (ctx.me.org_role !== 'admin') throw forbidden('admin only')
  return { key, agent }
}

/** How many keys of one agent agentKeys answers, the newest first, up to
 * `most`, with `more` when the agent holds another. Organization › API
 * access lists every key. Tests lower it. */
export const AGENT_KEYS = { most: 50 }

/** One agent's keys as agentKeys answers them, in pubKey's shape, revoked
 * ones included, newest first, with `more` when a key past AGENT_KEYS.most
 * exists. */
export type AgentKeysRow = { agent_id: string; keys: ReturnType<typeof pubKey>[]; more: boolean }

/**
 * The keys of the agents of the caller's organization among `agent_ids`,
 * for Settings › Users' key lines and an agent's key panel, read once and
 * never subscribed to. Refused in the demo, as the other key doors are, and
 * for anyone but an organization admin before any read; then an empty list
 * and more than LIST_BATCH (25) ids, counted raw, are refused as bad
 * requests. Each distinct id that names an agent of the organization gets
 * its AGENT_KEYS.most newest keys by created_at, read in that order
 * (agent_keys by_profile_created, the id breaking ties), each without its
 * hash, and `more` when the agent holds another. An id that names no agent
 * of the organization (unknown, a person, or another organization's agent)
 * is left out, a definite answer, as myAgentKey treats such a target
 * alike. It reads one organization, at most 25 lookups and 25 ranges of
 * 51 keys.
 */
export const agentKeys = orgQuery({
  args: { agent_ids: v.array(v.string()) },
  handler: (ctx, { agent_ids }): Promise<{ agents: AgentKeysRow[] }> =>
    agentKeysOf(ctx, ctx.me, agent_ids),
})

/** agentKeys for `me`, an active seat, on the rules in its docstring. */
export async function agentKeysOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  agentIds: readonly string[],
): Promise<{ agents: AgentKeysRow[] }> {
  refuseDemoFeature()
  if (me.org_role !== 'admin') throw forbidden('admin only')
  if (agentIds.length === 0) throw badRequest('agent_ids must name at least one agent')
  if (agentIds.length > LIST_BATCH)
    throw badRequest(`agent_ids must name at most ${LIST_BATCH} agents`)
  const agents: AgentKeysRow[] = []
  for (const id of new Set(agentIds)) {
    const agent = await byId(ctx, 'profiles', id)
    if (agent === null || agent.org_id !== me.org_id || agent.kind !== 'agent') continue
    // in created_at order before the bound, since rows ported from 0100
    // may carry a created_at that differs from the order they were stored in
    const rows = await ctx.db
      .query('agent_keys')
      .withIndex('by_profile_created', (q) => q.eq('profile_id', agent.id))
      .order('desc')
      .take(AGENT_KEYS.most + 1)
    const keys = rows.map(pubKey)
    agents.push({
      agent_id: agent.id,
      keys: keys.slice(0, AGENT_KEYS.most),
      more: keys.length > AGENT_KEYS.most,
    })
  }
  return { agents }
}

/* P.createAgentKey (awaited — the secret exists only in the client). */
export const createAgentKey = orgMutation({
  args: {
    id: v.string(),
    agent_id: v.string(),
    name: v.string(),
    key_prefix: v.string(),
    key_hash: v.string(),
  },
  handler: async (ctx, { id, agent_id, name, key_prefix, key_hash }) => {
    refuseDemoFeature()
    assertNewRowId(id)
    const now = new Date().toISOString()
    const agent = await byId(ctx, 'profiles', agent_id)
    if (agent === null || agent.org_id !== ctx.me.org_id || agent.kind !== 'agent') {
      throw notFound('agent not found')
    }
    if (ctx.me.org_role !== 'admin') throw forbidden('admin only')
    const keyName = credentialName(name, 'key')
    if (!HASH_RE.test(key_hash)) throw badRequest('a key hash is 64 lowercase hex characters')
    if (!KEY_PREFIX_RE.test(key_prefix)) {
      throw badRequest(
        'a key prefix is the first 7 and last 5 characters of the key, such as qva_012...abcde',
      )
    }
    if ((await byId(ctx, 'agent_keys', id)) !== null) {
      throw badRequest('a key with this id already exists')
    }
    await insertUnique(
      ctx,
      'agent_keys',
      'by_hash',
      { key_hash },
      {
        id,
        profile_id: agent.id,
        org_id: agent.org_id,
        ...named(keyName),
        key_prefix,
        key_hash,
        created_by: ctx.me.id,
        created_at: now,
      },
      rule('that key already exists'),
    )
    // narrated against the AGENT, not the key: the feed answers "what
    // happened to this user", and a key row is not a thing anyone can open
    await logActivity(ctx, {
      org_id: agent.org_id,
      actor_id: ctx.me.id,
      verb: 'created',
      target_type: 'user',
      target_id: agent.id,
      label: agent.name,
      detail: `a new key “${keyName}”`,
      ts: now,
    })
    return { id }
  },
})

/* P.revokeAgentKey — the stamp, plus the 'revoked' line against the agent.
 * Revoke and delete only take access away, so an admin can still run them
 * while billing has made the organization read-only (accessRemovalMutation). */
export const revokeAgentKey = accessRemovalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const { key, agent } = await myAgentKey(ctx, id)
    await ctx.db.patch(key._id, { revoked_at: now })
    await logActivity(ctx, {
      org_id: agent.org_id,
      actor_id: ctx.me.id,
      verb: 'revoked',
      target_type: 'user',
      target_id: agent.id,
      label: agent.name,
      detail: `the key “${key.name}”`,
      ts: now,
    })
    return true
  },
})

/* P.deleteAgentKey — row gone, no narration. */
export const deleteAgentKey = accessRemovalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const { key } = await myAgentKey(ctx, id)
    await ctx.db.delete(key._id)
    return true
  },
})

/* ------------------------------------------------------------- mcp tokens
 * The owner's own management (0030): rows whose profile_id is one of the
 * caller's own seats; nothing here narrates. MCP access lists them a batch
 * at a time (personalTokens). Admins list and revoke other members' tokens
 * through apiAccess.ts instead. */

/** What one batch of personal tokens may read past what the call read
 * before it, NAMED_READ's share of 2,000 index ranges, 8,000 documents and
 * 4 MiB. A token row holds two uuids, a name of at most 80 characters, its
 * prefix, its hash and a few ISO times, under 1 KB, and the walk reads
 * nothing else, so a search that matches only a person's oldest token
 * reads each of the person's tokens once in at most two index ranges a
 * seat. Measured in convex/tests/personalCredentialLists.test.ts ("reads
 * everyday batches"), the reader alone, a first batch over one seat with
 * 26 tokens read 26 documents, 1 index range and about 11 KB, and a search
 * that matched none of them read the same.
 * Past the share the batch answers `stopped` and Load more goes on. Tests
 * lower it. */
export const PERSONAL_TOKENS: { reads: ReadCeiling } = { reads: { ...NAMED_READ } }

/** The list's name, which seals its cursors (lib/namedPages.ts namedCursor). */
export const PERSONAL_TOKENS_LIST = 'tokens.personalTokens'

/** The refusal of a cursor that is not one of this list for the same login
 * and search. */
export const NOT_TOKENS_CURSOR =
  'cursor must come from an earlier answer of your personal tokens, with the same search; start the list again'

/** One personal token as MCP access lists it, without its hash, its
 * organization, its name key or its seat. */
export type PersonalTokenRow = ReturnType<typeof pubToken>

/** One batch of the caller's personal tokens (personalTokens). */
export type PersonalTokenBatch = ListBatch<PersonalTokenRow>

/** The tie of a personal token position, the token's id, which
 * by_profile_created orders equal created_at times by. Token ids are
 * unique (createMcpToken), so the two name one row across the caller's
 * seats. */
type TokenTie = readonly [id: string]

/* A personal token position's tie, or null for any other shape. */
function tokenTieOf(at: NamedAt): TokenTie | null {
  const [id] = at.tie
  return at.tie.length === 1 && typeof id === 'string' ? [id] : null
}

/** The tokens of seat `profileId`, newest created_at first (mcp_tokens
 * by_profile_created read descending), equal times in descending id
 * order. After a position it reads the rest of its time before its id,
 * then every earlier time. */
function tokenIndex(ctx: QueryCtx, profileId: string): NamedIndex<Doc<'mcp_tokens'>, TokenTie> {
  const rows = () => ctx.db.query('mcp_tokens')
  return {
    all: () =>
      rows()
        .withIndex('by_profile_created', (q) => q.eq('profile_id', profileId))
        .order('desc'),
    after: ({ key, tie: [id] }) => [
      () =>
        rows()
          .withIndex('by_profile_created', (q) =>
            q.eq('profile_id', profileId).eq('created_at', key).lt('id', id),
          )
          .order('desc'),
      () =>
        rows()
          .withIndex('by_profile_created', (q) =>
            q.eq('profile_id', profileId).lt('created_at', key),
          )
          .order('desc'),
    ],
    at: (t) => ({ key: t.created_at, tie: [t.id] }),
  }
}

/**
 * One batch of the caller's own personal tokens for MCP access, at most
 * LIST_BATCH (25) tokens of the login's active seats outside an
 * organization's deletion, as listMcpTokens lists them, newest created_at
 * first across the seats, equal times in descending id order, each in
 * pubToken's shape without its hash, revoked, expired and admin-revoked
 * tokens included. `search` keeps the tokens whose name or shown prefix
 * holds every whitespace-separated fragment of it, ignoring case and
 * accents, over the whole list, and `cursor` is an earlier batch's `next`
 * for the same search. Open to any signed-in login; refused in the demo, as
 * every credential door is, and a search past LIMITS.search and a cursor of
 * another list, login or search are refused too, each before any token is
 * read. A login without an active seat gets an empty end.
 *
 * Nothing freezes a snapshot. A token made between batches shows once the
 * list starts again, and one deleted leaves no gap. A batch reads at most
 * PERSONAL_TOKENS.reads and answers `stopped` where that ended it, with a
 * `next` that goes on. It reads no other table. The app reads each batch
 * once (convex.query) and never subscribes to it, because machine auth
 * stamps last_used_at on every call made with a token.
 */
export const personalTokens = authedQuery({
  args: { search: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: (ctx, a): Promise<PersonalTokenBatch> =>
    personalTokensOf(ctx, ctx.authUserId, ctx.myProfiles, a),
})

/** personalTokens for login `authUserId` with active seats `myProfiles`,
 * on the rules in its docstring. It refuses the demo, then the search,
 * then the cursor, before the walk reads a token. */
export async function personalTokensOf(
  ctx: QueryCtx,
  authUserId: string,
  myProfiles: Map<string, Doc<'profiles'>>,
  a: { search?: string; cursor?: string },
): Promise<PersonalTokenBatch> {
  refuseDemoFeature()
  const search = limitedText(LIMITS.search, a.search ?? '')
  const scope = [authUserId, nameKey(search)]
  let after: NamedAt<TokenTie> | null = null
  if (a.cursor !== undefined) {
    const at = await openNamedCursor(a.cursor, PERSONAL_TOKENS_LIST, scope)
    const tie = at === null ? null : tokenTieOf(at)
    if (at === null || tie === null) throw badRequest(NOT_TOKENS_CURSOR)
    after = { key: at.key, tie }
  }
  const seats = [...myProfiles.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  const matches = allWordsMatcher(nameKey(search))
  return await listBatch(
    ctx,
    { list: PERSONAL_TOKENS_LIST, scope, after, through: null },
    {
      stream: (reads) =>
        mergeNamed(
          seats.map((seat) => indexAfter(tokenIndex(ctx, seat.id), after, 'desc')(reads)),
          { order: 'desc' },
        ),
      keep: async (t: Doc<'mcp_tokens'>) =>
        search === '' || matches(`${nameKey(t.name)}\n${nameKey(t.token_prefix)}`)
          ? pubToken(t)
          : null,
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx, PERSONAL_TOKENS.reads),
      order: 'desc',
    },
  )
}

/**
 * @deprecated The app reads tokens.personalTokens since the release after
 * v0.1.158. This query stays, with its arguments and its answer, through
 * that release, so tabs and desktop windows loaded before it still list
 * tokens on MCP access, and a later release removes it and adds it to the
 * Instant Rollback list in docs/deployment.md.
 *
 * Before then P.listMcpTokens read every token of every active seat of the
 * caller in one fetch, sorted newest first by created_at. */
export const listMcpTokens = authedQuery({
  args: {},
  handler: async (ctx) => {
    const out: ReturnType<typeof pubToken>[] = []
    for (const me of ctx.myProfiles.values()) {
      const tokens = await ctx.db
        .query('mcp_tokens')
        .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
        .collect()
      for (const t of tokens) out.push(pubToken(t))
    }
    return byCreatedDesc(out)
  },
})

/* P.createMcpToken (awaited). The old client always minted for CURRENT_USER
 * (the home seat); any own seat is accepted. `access` is required, so no
 * caller gets write access by leaving it out; `expires_at` is optional and
 * must lie in the future. */
export const createMcpToken = authedMutation({
  args: {
    id: v.string(),
    profile_id: v.string(),
    name: v.string(),
    token_prefix: v.string(),
    token_hash: v.string(),
    access: vCredentialAccess,
    expires_at: v.optional(v.string()),
  },
  handler: async (ctx, { id, profile_id, name, token_prefix, token_hash, access, expires_at }) => {
    refuseDemoFeature()
    assertNewRowId(id)
    const now = new Date().toISOString()
    const seat = ownSeat(ctx.myProfiles, profile_id)
    if (seat === undefined) throw notFound('profile not found')
    const tokenName = credentialName(name, 'token')
    if (!HASH_RE.test(token_hash)) throw badRequest('a token hash is 64 lowercase hex characters')
    if (!TOKEN_PREFIX_RE.test(token_prefix)) {
      throw badRequest(
        'a token prefix is the first 11 characters of the token, such as qvt_0123456',
      )
    }
    const expiry = expires_at === undefined ? undefined : cleanTokenExpiry(expires_at)
    if (expiry !== undefined && expiry <= now) throw badRequest('expires_at must be in the future')
    if ((await byId(ctx, 'mcp_tokens', id)) !== null) {
      throw badRequest('a token with this id already exists')
    }
    await insertUnique(
      ctx,
      'mcp_tokens',
      'by_hash',
      { token_hash },
      {
        id,
        profile_id,
        org_id: seat.org_id,
        ...named(tokenName),
        token_prefix,
        token_hash,
        access,
        expires_at: expiry,
        created_at: now,
      },
      rule('that token already exists'),
    )
    return { id }
  },
})

export const revokeMcpToken = authedMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const token = await byId(ctx, 'mcp_tokens', id)
    if (token === null || !isMine(ctx.myProfiles, token.profile_id)) {
      throw notFound('token not found')
    }
    await ctx.db.patch(token._id, { revoked_at: now })
    return true
  },
})

export const deleteMcpToken = authedMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const token = await byId(ctx, 'mcp_tokens', id)
    if (token === null || !isMine(ctx.myProfiles, token.profile_id)) {
      throw notFound('token not found')
    }
    await ctx.db.delete(token._id)
    return true
  },
})
