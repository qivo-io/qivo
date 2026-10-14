/* Contract-test credential minting — the seam the wire suites need. The
 * dataset's agent (Atlas) ships without a key, and no seeded secret could
 * authenticate a test anyway, so the contract scripts mint their own pair:
 * node mints `qva_…`/`qvt_…` + sha256 locally, then
 *   npx convex run machine/testing:mintCredential '{"profile_id":…, "kind":…,
 *     "key_prefix":…, "key_hash":…, "name":…, "access":…}'
 * and drives <deployment>.convex.site. internalMutation = deploy-key-gated;
 * no public wrapper may ever reach this. Only the hash crosses the wire,
 * exactly like the real minting paths (convex/tokens.ts). A personal token
 * names its access ('read' or 'write') like convex/tokens.ts requires, and
 * may carry an expiry, a past one included, so suites can mint an expired
 * token. Agent keys take neither: the agent's role decides their access. */

import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalMutation } from '../_generated/server'
import { cleanTokenExpiry } from '../lib/access'
import { byId, insertUnique } from '../lib/db'
import { refuseProduction } from '../lib/deployment'
import { vCredentialAccess } from '../lib/enums'
import { badRequest, notFound } from '../lib/functions'
import { newUuid } from '../model/orgs'

const HASH_RE = /^[0-9a-f]{64}$/

export const mintCredential = internalMutation({
  args: {
    /** profile uuid, or resolve by email or (for email-less agents) by name */
    profile_id: v.optional(v.string()),
    email: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    kind: v.union(v.literal('agent_key'), v.literal('mcp_token')),
    key_prefix: v.string(),
    key_hash: v.string(),
    name: v.string(),
    /** required for mcp_token, refused for agent_key */
    access: v.optional(vCredentialAccess),
    /** mcp_token only; any UTC date-time, so a test can mint an expired token */
    expires_at: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ id: string; profile_id: string }> => {
    refuseProduction('machine/testing')
    const now = new Date().toISOString()
    if (!HASH_RE.test(a.key_hash)) throw badRequest('a key hash is 64 lowercase hex characters')
    if (a.kind === 'mcp_token' && a.access === undefined) {
      throw badRequest('a personal token needs access: "read" or "write"')
    }
    if (a.kind === 'agent_key' && (a.access !== undefined || a.expires_at !== undefined)) {
      throw badRequest("an agent key takes no access or expiry, the agent's role decides")
    }
    const expiry = a.expires_at === undefined ? undefined : cleanTokenExpiry(a.expires_at)
    const email = a.email?.toLowerCase()
    let profile: Doc<'profiles'> | null = null
    if (a.profile_id !== undefined) {
      profile = await byId(ctx, 'profiles', a.profile_id)
    } else if (email !== undefined) {
      // an email can sit on several seats (internal/guestOrg plants an
      // UNCLAIMED guest seat carrying Ben's Northstar address) — prefer the
      // claimed one, since machine/auth refuses a person token on a seat with
      // no login behind it
      const seats = await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', email))
        .collect()
      profile = seats.find((p) => p.auth_user_id !== undefined) ?? seats[0] ?? null
    }
    if (
      profile === null &&
      a.agent_name !== undefined &&
      a.profile_id === undefined &&
      email === undefined
    ) {
      // an agent has no email, so a caller without its profile id resolves
      // it by name — a deliberate unindexed scan, acceptable in this
      // deploy-key-gated test-only fn (the contract pass passes profile_id)
      const agents = (await ctx.db.query('profiles').collect()).filter(
        (p) => p.kind === 'agent' && p.name === a.agent_name,
      )
      if (agents.length > 1) {
        throw badRequest(
          `agent name "${a.agent_name}" is ambiguous (${agents.length} agents) — pass profile_id instead`,
        )
      }
      profile = agents[0] ?? null
    }
    if (profile === null) throw notFound('profile not found')
    const id = newUuid()
    if (a.kind === 'agent_key') {
      if (profile.kind !== 'agent') throw badRequest('agent keys belong to agent profiles')
      await insertUnique(
        ctx,
        'agent_keys',
        'by_hash',
        { key_hash: a.key_hash },
        {
          id,
          profile_id: profile.id,
          name: a.name,
          key_prefix: a.key_prefix,
          key_hash: a.key_hash,
          created_at: now,
        },
        badRequest('that key already exists'),
      )
    } else {
      await insertUnique(
        ctx,
        'mcp_tokens',
        'by_hash',
        { token_hash: a.key_hash },
        {
          id,
          profile_id: profile.id,
          name: a.name,
          token_prefix: a.key_prefix,
          token_hash: a.key_hash,
          access: a.access,
          expires_at: expiry,
          created_at: now,
        },
        badRequest('that token already exists'),
      )
    }
    return { id, profile_id: profile.id }
  },
})

/* Teardown twin: the contract pass deletes the credentials it minted so the
 * shared dev deployment never accumulates live secrets (a standing qva_ key
 * IS a capability). Tolerates an already-deleted row — the mcp contract
 * suite's finale deletes the qvt token mid-run to capture the revoked-token
 * 401 live, and the globalSetup teardown then deletes it again. */
export const deleteCredential = internalMutation({
  args: {
    id: v.string(),
    kind: v.union(v.literal('agent_key'), v.literal('mcp_token')),
  },
  handler: async (ctx, a): Promise<{ deleted: boolean }> => {
    refuseProduction('machine/testing')
    const row = await byId(ctx, a.kind === 'agent_key' ? 'agent_keys' : 'mcp_tokens', a.id)
    if (row === null) return { deleted: false }
    await ctx.db.delete(row._id)
    return { deleted: true }
  },
})
