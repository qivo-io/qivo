/* Contract-test credential minting — the seam the wire suites need. The
 * dataset's agent (Atlas) ships without a key, and no seeded secret could
 * authenticate a test anyway, so the contract scripts mint their own pair:
 * node mints `qva_…`/`qvt_…` + sha256 locally, then
 *   npx convex run machine/testing:mintCredential '{"profile_id":…, "kind":…,
 *     "key_prefix":…, "key_hash":…, "name":…, "access":…, "pending":true}'
 * and drives <deployment>.convex.site. internalMutation = deploy-key-gated;
 * no public wrapper may ever reach this. Only the hash crosses the wire,
 * exactly like the real minting paths (convex/tokens.ts). A personal token
 * names its access ('read' or 'write') like convex/tokens.ts requires, and
 * may carry an expiry, a past one included, so suites can mint an expired
 * token. Agent keys take neither, because the agent's role decides their
 * access.
 *
 * Every credential starts pending: the mint stores its hash behind the
 * `pending:` prefix, which no secret's sha256 hex can match, so machine/auth
 * finds no row for the secret until
 *   npx convex run machine/testing:activateNamedCredentials
 *     '{"profile_id":…, "name":…}'
 * stores the plain hash. A pending row is not revoked, so every revoke path
 * stamps it like any other credential, and activation skips a row that
 * carries a revoked_at. No production code needs to know the pending state,
 * so listings and the organization export show a pending row as an active
 * credential whose secret machine/auth still refuses.
 * The mint requires `pending: true`, so a caller that expects a usable
 * credential fails at the mint instead of with 401s later. A contract pass
 * whose process is killed while a call runs can leave that one call
 * running after the next pass has deleted the killed pass's credentials by
 * name. The pass starts each call only after the one before it returned,
 * and activates only after both mints, so the call left is either a late
 * mint, which leaves a pending row, or a late activation, which finds
 * nothing. deleteOldCredentials sweeps such rows. */

import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalMutation, type MutationCtx } from '../_generated/server'
import { cleanTokenExpiry } from '../lib/access'
import { byId, insertUnique } from '../lib/db'
import { refuseProduction } from '../lib/deployment'
import { vCredentialAccess } from '../lib/enums'
import { badRequest, notFound } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS } from '../lib/limits'
import { newUuid } from '../model/orgs'

const HASH_RE = /^[0-9a-f]{64}$/
/** Prefix of the stored hash of a pending credential (see the header). */
const PENDING = 'pending:'

type Kind = 'agent_key' | 'mcp_token'

/** The agent key or personal token whose stored hash is exactly `stored`. */
const byStoredHash = (ctx: MutationCtx, kind: Kind, stored: string) =>
  kind === 'agent_key'
    ? ctx.db
        .query('agent_keys')
        .withIndex('by_hash', (q) => q.eq('key_hash', stored))
        .first()
    : ctx.db
        .query('mcp_tokens')
        .withIndex('by_hash', (q) => q.eq('token_hash', stored))
        .first()

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
    /** the caller knows the credential stays unusable until activated */
    pending: v.literal(true),
  },
  handler: async (ctx, a): Promise<{ id: string; profile_id: string }> => {
    refuseProduction('machine/testing')
    const now = new Date().toISOString()
    if (!HASH_RE.test(a.key_hash)) throw badRequest('a key hash is 64 lowercase hex characters')
    if (a.kind === 'mcp_token' && a.access === undefined) {
      throw badRequest('a personal token needs access: "read" or "write"')
    }
    if (a.kind === 'agent_key' && (a.access !== undefined || a.expires_at !== undefined)) {
      throw badRequest("an agent key takes no access or expiry because the agent's role decides")
    }
    const expiry = a.expires_at === undefined ? undefined : cleanTokenExpiry(a.expires_at)
    // capped as tokens.ts caps every other key and token name, so a removal
    // can read a profile's credentials a page at a time (model/cascade.ts)
    const name = limitedText(a.kind === 'agent_key' ? LIMITS.keyName : LIMITS.tokenName, a.name)
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
          `agent name "${a.agent_name}" is ambiguous (${agents.length} agents), so pass profile_id instead`,
        )
      }
      profile = agents[0] ?? null
    }
    if (profile === null) throw notFound('profile not found')
    // insertUnique checks the pending form; a usable row may hold the plain one
    if ((await byStoredHash(ctx, a.kind, a.key_hash)) !== null) {
      throw badRequest(
        a.kind === 'agent_key' ? 'that key already exists' : 'that token already exists',
      )
    }
    const id = newUuid()
    if (a.kind === 'agent_key') {
      if (profile.kind !== 'agent') throw badRequest('agent keys belong to agent profiles')
      await insertUnique(
        ctx,
        'agent_keys',
        'by_hash',
        { key_hash: PENDING + a.key_hash },
        {
          id,
          profile_id: profile.id,
          name,
          key_prefix: a.key_prefix,
          key_hash: PENDING + a.key_hash,
          created_at: now,
        },
        badRequest('that key already exists'),
      )
    } else {
      await insertUnique(
        ctx,
        'mcp_tokens',
        'by_hash',
        { token_hash: PENDING + a.key_hash },
        {
          id,
          profile_id: profile.id,
          name,
          token_prefix: a.key_prefix,
          token_hash: PENDING + a.key_hash,
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

/* Delete twin by id: the mcp contract suite's finale deletes its qvt token
 * mid-run to capture the revoked-token 401 live, and the contract setup
 * revokes the ids a stash names when it cleans up after an interrupted pass,
 * so the shared dev deployment never accumulates live secrets (a standing
 * qva_ key IS a capability). Tolerates an already-deleted row, because the
 * setup's teardown deletes the same credentials again by name. */
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

/** The agent keys and personal tokens of one profile. */
async function profileCredentials(ctx: MutationCtx, profile_id: string) {
  const [keys, tokens] = await Promise.all(
    (['agent_keys', 'mcp_tokens'] as const).map((table) =>
      ctx.db
        .query(table)
        .withIndex('by_profile', (q) => q.eq('profile_id', profile_id))
        .collect(),
    ),
  )
  return [...keys, ...tokens]
}

/* Makes the pending credentials of one profile with exactly that name
 * usable: stores the plain hash of each row whose hash is still pending and
 * that nobody revoked. A row that is gone stays gone, and one that any
 * revoke path stamped, a person's own revoke or an organization admin's
 * alike, stays pending and revoked. A plain hash that another credential
 * holds refuses the whole activation, because machine/auth reads one row per
 * hash. The contract pass activates within seconds of its mints and deletes
 * its credentials when it ends. */
export const activateNamedCredentials = internalMutation({
  args: { profile_id: v.string(), name: v.string() },
  handler: async (ctx, a): Promise<{ activated: number }> => {
    refuseProduction('machine/testing')
    if (a.name.trim() === '') throw badRequest('a credential name is required')
    let activated = 0
    for (const row of await profileCredentials(ctx, a.profile_id)) {
      if (row.name !== a.name || row.revoked_at !== undefined) continue
      const kind: Kind = 'key_hash' in row ? 'agent_key' : 'mcp_token'
      const stored = 'key_hash' in row ? row.key_hash : row.token_hash
      if (!stored.startsWith(PENDING)) continue
      const hash = stored.slice(PENDING.length)
      if ((await byStoredHash(ctx, kind, hash)) !== null) {
        throw badRequest('another credential already holds that hash')
      }
      if ('key_hash' in row) await ctx.db.patch(row._id, { key_hash: hash })
      else await ctx.db.patch(row._id, { token_hash: hash })
      activated++
    }
    return { activated }
  },
})

/* Sweep twin: the contract pass names every credential it mints after the
 * pass, so it can delete them without their ids, for example after a mint
 * that succeeded but whose CLI output could not be parsed, or after a pass
 * that was killed before it saved the ids. Deletes every agent key and
 * personal token of the profile with exactly that name. */
export const deleteNamedCredentials = internalMutation({
  args: { profile_id: v.string(), name: v.string() },
  handler: async (ctx, a): Promise<{ deleted: number }> => {
    refuseProduction('machine/testing')
    if (a.name.trim() === '') throw badRequest('a credential name is required')
    const named = (await profileCredentials(ctx, a.profile_id)).filter((row) => row.name === a.name)
    for (const row of named) await ctx.db.delete(row._id)
    return { deleted: named.length }
  },
})

/* Age sweep: deletes every agent key and personal token of the profile
 * whose name starts with `name_prefix` and that was created before
 * `created_before`. The contract pass sweeps what no stash names any more:
 * a pending row a killed pass's late mint left, a usable credential that a
 * late mint left before mints were pending, and credentials from passes
 * before their names carried a pass id. The cutoff keeps the credentials of
 * a pass that runs elsewhere at the same time. */
export const deleteOldCredentials = internalMutation({
  args: { profile_id: v.string(), name_prefix: v.string(), created_before: v.string() },
  handler: async (ctx, a): Promise<{ deleted: number }> => {
    refuseProduction('machine/testing')
    if (a.name_prefix.trim() === '') throw badRequest('a name prefix is required')
    const before = Date.parse(a.created_before)
    if (Number.isNaN(before)) throw badRequest('created_before is a date-time')
    const old = (await profileCredentials(ctx, a.profile_id)).filter(
      (row) => row.name.startsWith(a.name_prefix) && Date.parse(row.created_at) < before,
    )
    for (const row of old) await ctx.db.delete(row._id)
    return { deleted: old.length }
  },
})
