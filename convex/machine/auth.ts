/* Machine-surface authentication (phase 8): the successor to
 * core.ts's `authenticate` (core.ts:157-203). The one step that cannot run as
 * the caller — you need the row to learn who you are — so it is its own
 * internalQuery, called from the surface HTTP actions before dispatch.
 *
 * HTTP ingress first consumes the shared request limit. Then, in order:
 *   1. the action extracts the secret (per-surface header rules), routes the
 *      prefix (classifySecret — a bad prefix is `missing`, WITHOUT hashing or
 *      touching the DB), hashes, and runs lookupCredential
 *   2. touchCredential stamps last_used_at — unconditionally, on EVERY
 *      authenticated request, before any routing/work, even ones that then
 *      404 or 400 (the published contract: "last_used_at on the key updates
 *      on every authenticated request"; the design's 60 s throttle was
 *      rejected by the plan — per-call wins). The same mutation enforces
 *      the profile's shared rate limit and records accepted-request usage.
 *   3. the endpoint internal fn re-asserts the profile via asMachineCaller
 *      (lib/core.ts) — auth runs in a separate query, so the profile can flip
 *      between lookup and dispatch
 *
 * Minting stays client-side / seed-side (convex/tokens.ts — hash-only
 * inserts); usage and rate counters live outside the planner's tables. */

import { v } from 'convex/values'
import { internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import { internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { isDemoDeployment } from '../lib/demo'
import { recordApiCall } from '../model/billingUsage'

/* Web Crypto + TextEncoder exist in the Convex isolate; convex/tsconfig's lib
 * is ESNext only, which does not declare the globals (same move as model/orgs). */
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> }
}
declare class TextEncoder {
  encode(input: string): Uint8Array
}

export const sha256hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* Failure kinds, in check order (order is observable: a revoked key of a
 * deactivated agent answers "revoked"):
 *   missing     bad/absent prefix — decided in the action, pre-hash
 *   unknown     no row for the hash
 *   revoked     revoked_at set
 *   wrong_kind  profile missing; agent leg: kind !== 'agent'; person leg:
 *               auth_user_id absent — a person's token is only good once the
 *               seat is actually claimed (an unclaimed profile has no login
 *               to impersonate)
 *   inactive    profile switched off — the profile IS the credential's state:
 *               a switched-off user needs no key revoked to go quiet */
export type AuthFail = 'missing' | 'unknown' | 'revoked' | 'inactive' | 'wrong_kind'

export type MachineCredential = {
  profileId: string
  orgId: string
  tokenId: string
  rowId: string
  isAgent: boolean
  /** the agent key's own name for qva_ (feeds the REST provenance string
   *  `via the REST API (<keyName>)`); null for qvt_ */
  keyName: string | null
}

export type AuthResult =
  | { ok: true; cred: MachineCredential }
  | { ok: false; why: AuthFail; isAgent: boolean }

/* Prefix routing (core.ts:171-173): `qva_` → agent leg; `qvt_` → person leg
 * ONLY where the surface allows persons (REST passes {person:false}, so a
 * qvt_ on REST is the `missing` failure, not wrong_kind); anything else →
 * missing. Secret extraction stays in each surface's action: REST honors
 * `Authorization` when it starts with exactly 'Bearer ' (case-sensitive, one
 * space) else falls back to X-Api-Key; MCP is Bearer-only. */
export const classifySecret = (
  secret: string,
  allow: { person: boolean },
): { isAgent: boolean } | null =>
  secret.startsWith('qva_')
    ? { isAgent: true }
    : allow.person && secret.startsWith('qvt_')
      ? { isAgent: false }
      : null

export const lookupCredential = internalQuery({
  args: { hash: v.string(), isAgent: v.boolean() },
  handler: async (ctx, { hash, isAgent }): Promise<AuthResult> => {
    if (isDemoDeployment()) return { ok: false, why: 'unknown', isAgent }
    const token = isAgent
      ? await ctx.db
          .query('agent_keys')
          .withIndex('by_hash', (q) => q.eq('key_hash', hash))
          .first()
      : await ctx.db
          .query('mcp_tokens')
          .withIndex('by_hash', (q) => q.eq('token_hash', hash))
          .first()
    if (token === null) return { ok: false, why: 'unknown', isAgent }
    if (token.revoked_at !== undefined) return { ok: false, why: 'revoked', isAgent }
    const profile = await byId(ctx, 'profiles', token.profile_id)
    const shapeOk =
      profile !== null && (isAgent ? profile.kind === 'agent' : profile.auth_user_id !== undefined)
    if (profile === null || !shapeOk) return { ok: false, why: 'wrong_kind', isAgent }
    if (!profile.active) return { ok: false, why: 'inactive', isAgent }
    return {
      ok: true,
      cred: {
        profileId: profile.id,
        orgId: profile.org_id,
        tokenId: token.id,
        rowId: token._id,
        isAgent,
        keyName: isAgent ? token.name : null,
      },
    }
  },
})

/* The action-side composition: route the prefix, hash, look up. The caller
 * then stamps via touchCredential and dispatches. */
export async function authenticateSecret(
  ctx: Pick<ActionCtx, 'runQuery'>,
  secret: string,
  allow: { person: boolean },
): Promise<AuthResult> {
  const leg = classifySecret(secret, allow)
  if (leg === null) return { ok: false, why: 'missing', isAgent: false }
  const hash = await sha256hex(secret)
  return await ctx.runQuery(internal.machine.auth.lookupCredential, { hash, isAgent: leg.isAgent })
}

/* PER-CALL stamp and usage accounting. A query cannot write, hence the
 * separate internalMutation. False means the profile's request rate is full;
 * the HTTP action returns 429 without dispatching or charging that request. */
export const touchCredential = internalMutation({
  args: {
    table: v.union(v.literal('agent_keys'), v.literal('mcp_tokens')),
    tokenId: v.string(),
    rowId: v.string(),
    profileId: v.string(),
    now: v.string(),
  },
  handler: async (ctx, { table, tokenId, rowId, profileId, now }): Promise<boolean | null> => {
    const row =
      table === 'agent_keys'
        ? await byId(ctx, 'agent_keys', tokenId)
        : await byId(ctx, 'mcp_tokens', tokenId)
    // App UUIDs may be reused after deletion. Bind to the exact DB record
    // authenticated by lookup so a replacement cannot inherit or pay for it.
    if (
      row === null ||
      row._id !== rowId ||
      row.profile_id !== profileId ||
      row.revoked_at !== undefined
    )
      return null
    await ctx.db.patch(row._id, { last_used_at: now })
    return await recordApiCall(ctx, {
      profile_id: row.profile_id,
      credential_id: `${table}:${row.id}`,
      credential_name: row.name,
    })
  },
})

/* ------------------------------------------------- the 401 sentence tables
 * VERBATIM per surface — byte-preserved contract, do not unify. Bodies are
 * {"error": <sentence>} with CORS + Content-Type: application/json; MCP 401s
 * additionally carry `WWW-Authenticate: Bearer`. */

/* REST (rest-api/index.ts:146-155). */
export const REST_AUTH_401: Record<AuthFail, string> = {
  missing: 'missing agent key (Authorization: Bearer qva_…)',
  unknown: 'unknown agent key',
  revoked: 'this agent key has been revoked',
  inactive: 'this agent has been deactivated',
  wrong_kind: 'unknown agent key', // deliberately identical to unknown
}

/* MCP (mcp/index.ts:139-146): missing is its own sentence; every other
 * failure collapses per LEG — the credential's state is not disclosed. */
export const MCP_AUTH_401 = {
  missing: 'missing credential (Authorization: Bearer qvt_… or qva_…)',
  agent: 'unknown, revoked or deactivated agent key',
  person: 'unknown or revoked MCP token',
} as const

export const mcpAuth401 = (fail: { why: AuthFail; isAgent: boolean }): string =>
  fail.why === 'missing'
    ? MCP_AUTH_401.missing
    : fail.isAgent
      ? MCP_AUTH_401.agent
      : MCP_AUTH_401.person
