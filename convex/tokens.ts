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
 * MCP tokens are strictly self-service. Narration is equally split (T8):
 * agent key create/revoke narrate against the AGENT profile ("what happened
 * to this user"); MCP tokens never narrate (private credential management).
 *
 * last_used_at is written only by phase 8's machine auth; revoked keys stay
 * listed. A key row whose plaintext is gone is still a real row (its holder
 * can still revoke it by fingerprint); never "clean up" such rows. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { byId, insertUnique } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import {
  authedMutation,
  authedQuery,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  rule,
} from './lib/functions'
import { logActivity } from './model/activity'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/* key_hash / token_hash CHECK (0100:50 / 0030:14). */
const HASH_RE = /^[0-9a-f]{64}$/

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
  createdAt: t.created_at,
  lastUsedAt: t.last_used_at ?? null,
  revokedAt: t.revoked_at ?? null,
})

const byCreatedDesc = <R extends { createdAt: string }>(rows: R[]): R[] =>
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))

const isMine = (myProfiles: Map<string, Doc<'profiles'>>, profileId: string): boolean => {
  for (const p of myProfiles.values()) if (p.id === profileId) return true
  return false
}

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

/* P.listAgentKeys — one flat fetch for the whole page (grouped by agentId
 * client-side), across every org where the caller is an admin. */
export const listAgentKeys = authedQuery({
  args: {},
  handler: async (ctx) => {
    const out: ReturnType<typeof pubKey>[] = []
    for (const me of ctx.myProfiles.values()) {
      if (me.org_role !== 'admin') continue
      const seats = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      for await (const seat of seats) {
        if (seat.kind !== 'agent') continue
        const keys = await ctx.db
          .query('agent_keys')
          .withIndex('by_profile', (q) => q.eq('profile_id', seat.id))
          .collect()
        for (const k of keys) out.push(pubKey(k))
      }
    }
    return byCreatedDesc(out)
  },
})

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
    const now = new Date().toISOString()
    const agent = await byId(ctx, 'profiles', agent_id)
    if (agent === null || agent.org_id !== ctx.me.org_id || agent.kind !== 'agent') {
      throw notFound('agent not found')
    }
    if (ctx.me.org_role !== 'admin') throw forbidden('admin only')
    if (name.trim() === '') throw badRequest('a key needs a name')
    if (!HASH_RE.test(key_hash)) throw badRequest('a key hash is 64 lowercase hex characters')
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
        name,
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
      detail: `a new key “${name}”`,
      ts: now,
    })
    return { id }
  },
})

/* P.revokeAgentKey — the stamp, plus the 'revoked' line against the agent. */
export const revokeAgentKey = orgMutation({
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
export const deleteAgentKey = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const { key } = await myAgentKey(ctx, id)
    await ctx.db.delete(key._id)
    return true
  },
})

/* ------------------------------------------------------------- mcp tokens
 * Strictly self-service (0030): rows whose profile_id is one of the
 * caller's own seats; nothing narrates, ever. */
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
 * (the home seat); any own seat is accepted. */
export const createMcpToken = authedMutation({
  args: {
    id: v.string(),
    profile_id: v.string(),
    name: v.string(),
    token_prefix: v.string(),
    token_hash: v.string(),
  },
  handler: async (ctx, { id, profile_id, name, token_prefix, token_hash }) => {
    refuseDemoFeature()
    const now = new Date().toISOString()
    if (!isMine(ctx.myProfiles, profile_id)) throw notFound('profile not found')
    if (name.trim() === '') throw badRequest('a token needs a name')
    if (!HASH_RE.test(token_hash)) throw badRequest('a token hash is 64 lowercase hex characters')
    if ((await byId(ctx, 'mcp_tokens', id)) !== null) {
      throw badRequest('a token with this id already exists')
    }
    await insertUnique(
      ctx,
      'mcp_tokens',
      'by_hash',
      { token_hash },
      { id, profile_id, name, token_prefix, token_hash, created_at: now },
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
