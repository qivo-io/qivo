/* Refusal helpers and the customFunction wrappers every public function is
 * built from. The wrappers are the fail-closed layer:
 * every public query/mutation starts from an identity, and the org-scoped
 * ones resolve the caller's profile before the handler runs.
 *
 * Error-helper style: each helper RETURNS a ConvexError (never throws), so
 * guards read `throw forbidden('…')`, and the same value can be handed to
 * require() or insertUnique() unraised. */

import { makeFunctionReference } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { customAction, customMutation, customQuery } from 'convex-helpers/server/customFunctions'
import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { action, mutation, query } from '../_generated/server'
import { assertOrgWritable, deletionBegun, ORG_DELETING, removedWithOrg } from './billingAccess'
import {
  assertDemoPayload,
  consumeDemoWrite,
  demoWriter,
  isDemoDeployment,
  refuseDemoFeature,
  requireActiveDemo,
  requireDemoDeployment,
} from './demo'

export type RefusalCode = 'not_found' | 'forbidden' | 'bad_request' | 'rule' | 'conflict'

/** One field an edit was refused over because someone else changed it
 * (model/expected.ts). `id` is the record's id, for a grant the project's
 * and for a link task a's; `of` is a grant's person or team, or a link's
 * task b. `by` is the profile that wrote the stored value and `at` when,
 * only where the server can prove it. */
export type FieldChange = {
  record:
    | 'task'
    | 'comment'
    | 'milestone'
    | 'project'
    | 'grant'
    | 'team'
    | 'label'
    | 'profile'
    | 'organization'
    | 'link'
  id: string
  of?: string
  field: string
  by: string | null
  at: string | null
}

/** A refusal's data. `changes` lists the fields of a `field_changed`
 * conflict (model/expected.ts). */
export type Refusal = {
  code: RefusalCode
  message: string
  reason?: string
  changes?: FieldChange[]
}

export const notFound = (message: string): ConvexError<Refusal> =>
  new ConvexError<Refusal>({ code: 'not_found', message })

export const forbidden = (message: string): ConvexError<Refusal> =>
  new ConvexError<Refusal>({ code: 'forbidden', message })

export const badRequest = (message: string): ConvexError<Refusal> =>
  new ConvexError<Refusal>({ code: 'bad_request', message })

/* P0001's successor: a human sentence written server-side, toasted verbatim. */
export const rule = (message: string): ConvexError<Refusal> =>
  new ConvexError<Refusal>({ code: 'rule', message })

export const conflict = (message: string, reason: string): ConvexError<Refusal> =>
  new ConvexError<Refusal>({ code: 'conflict', message, reason })

export function require(cond: unknown, err: ConvexError<Refusal>): asserts cond {
  if (!cond) throw err
}

/** The signed-in login's active profiles, keyed by org_id. An organization
 * whose deletion has begun is left out and listed in `deleting`, an
 * inactive profile's too, so reads across organizations, such as the
 * snapshot, stop showing it while its profiles are deleted. MutationCtx
 * satisfies this too (writer db/storage extend the readers). */
async function loadMemberships(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (identity === null) throw forbidden('not signed in')
  const authUserId = identity.subject
  const demo = isDemoDeployment() ? await requireActiveDemo(ctx, authUserId) : null
  const mine = await ctx.db
    .query('profiles')
    .withIndex('by_auth', (q) => q.eq('auth_user_id', authUserId))
    .collect()
  const myProfiles = new Map<string, Doc<'profiles'>>()
  const deleting = new Set<string>()
  for (const profile of mine) {
    if (demo && profile.org_id !== demo.org_id) continue
    if (await deletionBegun(ctx, profile.org_id)) deleting.add(profile.org_id)
    else if (profile.active) myProfiles.set(profile.org_id, profile)
  }
  return { authUserId, myProfiles, deleting }
}

/** The signed-in login and its active profiles outside a deletion. */
async function loadAuthed(ctx: QueryCtx) {
  const { authUserId, myProfiles } = await loadMemberships(ctx)
  return { authUserId, myProfiles }
}

/** private.profile_in's successor for people. A member of an organization
 * whose deletion has begun learns why they are refused, also once the
 * deletion has deleted their seat (lib/billingAccess.ts removedWithOrg). */
async function loadMember(ctx: QueryCtx, orgId: string) {
  const { authUserId, myProfiles, deleting } = await loadMemberships(ctx)
  if (deleting.has(orgId)) throw forbidden(ORG_DELETING)
  const me = myProfiles.get(orgId)
  if (!me) {
    if (await removedWithOrg(ctx, 'login', authUserId, orgId)) throw forbidden(ORG_DELETING)
    throw forbidden('no profile in this organization')
  }
  return { authUserId, myProfiles, me }
}

async function loadOperator(ctx: QueryCtx) {
  refuseDemoFeature()
  const identity = await ctx.auth.getUserIdentity()
  if (identity === null) throw forbidden('not signed in')
  const operator = await ctx.db
    .query('platform_admins')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', identity.subject))
    .unique()
  if (!operator) throw forbidden('not a platform operator')
  return { authUserId: identity.subject, operator }
}

/* Signed in. Adds ctx.authUserId + ctx.myProfiles (active profiles only,
 * keyed by org_id) — the client-side myProfiles map, computed server-side. */
export const authedQuery = customQuery(query, {
  args: {},
  input: async (ctx) => ({ ctx: await loadAuthed(ctx), args: {} }),
})

/* authedQuery + an org_id arg (consumed), for the workspace parts
 * (workspace.ts). Adds ctx.me, the caller's active profile in that org, or
 * null when the caller holds no active seat there or the org is being
 * deleted. The handler answers that case without throwing, so a seat that
 * goes away ends its parts quietly while the app's root part drops the org.
 * Only a missing sign-in throws (`not signed in`). */
export const seatQuery = customQuery(query, {
  args: { org_id: v.string() },
  input: async (ctx, { org_id }) => {
    const { authUserId, myProfiles } = await loadAuthed(ctx)
    return { ctx: { authUserId, myProfiles, me: myProfiles.get(org_id) ?? null }, args: {} }
  },
})

/* customFunctions' input receives only its own declared args. Wrap the
 * eventual handler to bound the complete websocket payload as well. Keep the
 * builder's generic validator inference for every existing call site. */
function withDemoPayloadLimit<B>(builder: B): B {
  const build = builder as (definition: unknown) => unknown
  return ((definition: { handler: (ctx: unknown, args: unknown) => unknown }) =>
    build({
      ...definition,
      handler: async (ctx: unknown, args: unknown) => {
        assertDemoPayload(args)
        return definition.handler(ctx, args)
      },
    })) as B
}

async function loadAuthedWriter(ctx: MutationCtx) {
  const authed = await loadAuthed(ctx)
  await consumeDemoWrite(ctx, authed.authUserId)
  return { ...authed, db: demoWriter(ctx, authed.authUserId) }
}

export const authedMutation = withDemoPayloadLimit(
  customMutation(mutation, {
    args: {},
    input: async (ctx) => ({ ctx: await loadAuthedWriter(ctx), args: {} }),
  }),
)

/* authed* + an org_id arg (consumed — handlers never see it; use ctx.me.org_id).
 * Adds ctx.me, the caller's active profile in that org. */
export const orgQuery = customQuery(query, {
  args: { org_id: v.string() },
  input: async (ctx, { org_id }) => ({ ctx: await loadMember(ctx, org_id), args: {} }),
})

export const orgMutation = withDemoPayloadLimit(
  customMutation(mutation, {
    args: { org_id: v.string() },
    input: async (ctx, { org_id }) => {
      const member = await loadMember(ctx, org_id)
      await assertOrgWritable(ctx, org_id)
      await consumeDemoWrite(ctx, member.authUserId)
      return { ctx: { ...member, db: demoWriter(ctx, member.authUserId) }, args: {} }
    },
  }),
)

export const adminMutation = withDemoPayloadLimit(
  customMutation(mutation, {
    args: { org_id: v.string() },
    input: async (ctx, { org_id }) => {
      const member = await loadMember(ctx, org_id)
      if (member.me.org_role !== 'admin') throw forbidden('admin only')
      await assertOrgWritable(ctx, org_id)
      await consumeDemoWrite(ctx, member.authUserId)
      return { ctx: { ...member, db: demoWriter(ctx, member.authUserId) }, args: {} }
    },
  }),
)

/* orgMutation for the admin actions that only take access away. These are
 * revoking any credential on API access, revoking or deleting an agent key,
 * deactivating a seat, removing a seat, removing someone from a team and
 * removing a person's or team's project access. An organization admin
 * passes the read-only gate here, so they can still shut out a leaked key or
 * a departed person while billing or a pending deletion has made the
 * organization read-only. REST and MCP give an admin the same exception for
 * the last two (lib/core.ts asMachineCaller 'access_removal'). Everyone else
 * meets the gate exactly as in orgMutation. Handlers keep their own admin
 * rule and sentences. Never build a write that only adds seats, access or
 * data on this wrapper. A handler that can also add them must call
 * assertOrgWritable itself before those branches, as removeTeamMemberCore
 * and removeProjectGrantCore (model/) do when a removal keeps people as
 * Viewers or reassigns their tasks. */
export const accessRemovalMutation = withDemoPayloadLimit(
  customMutation(mutation, {
    args: { org_id: v.string() },
    input: async (ctx, { org_id }) => {
      const member = await loadMember(ctx, org_id)
      if (member.me.org_role !== 'admin') await assertOrgWritable(ctx, org_id)
      await consumeDemoWrite(ctx, member.authUserId)
      return { ctx: { ...member, db: demoWriter(ctx, member.authUserId) }, args: {} }
    },
  }),
)

/* Public, non-sensitive deployment metadata lets a demo build refuse a
 * mismatched backend before it allocates an anonymous login. */
export const demoConfigurationQuery = customQuery(query, {
  args: {},
  input: async () => ({ ctx: {}, args: {} }),
})

async function loadDemoIdentity(ctx: QueryCtx) {
  requireDemoDeployment()
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw forbidden('not signed in')
  return { authUserId: identity.subject }
}

/* These intentionally require identity without requiring a ready org. The
 * handlers verify the live anonymous account/receipt before provisioning. */
export const demoLifecycleQuery = customQuery(query, {
  args: {},
  input: async (ctx) => ({ ctx: await loadDemoIdentity(ctx), args: {} }),
})
export const demoBootstrapMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => ({ ctx: await loadDemoIdentity(ctx), args: {} }),
})

/* Operator console only: identity must hold a platform_admins row. Adds
 * ctx.authUserId + ctx.operator (the platform_admins doc). */
export const platformQuery = customQuery(query, {
  args: {},
  input: async (ctx) => ({ ctx: await loadOperator(ctx), args: {} }),
})

export const platformMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => ({ ctx: await loadOperator(ctx), args: {} }),
})

/* The operator identity platformAction hands its handlers. */
export type PlatformOperator = { auth_user_id: string; email: string }

/* By-name reference, not `internal.adminAuth.operatorCheck`: the typed api
 * object's type walks every module, adminAuth included, and adminAuth builds
 * its actions from platformAction below — a type cycle tsc resolves to
 * implicit any. The string form is runtime-identical (anyApi builds the same
 * path) and keeps the types acyclic. */
const operatorCheckRef = makeFunctionReference<
  'query',
  Record<string, never>,
  { auth_user_id: string }
>('adminAuth:operatorCheck')

/* Operator console ACTIONS (adminAuth.ts). Actions have no ctx.db, so the
 * gate runs as an internal query the caller's identity propagates into —
 * adminAuth.operatorCheck, which folds the anonymous and non-operator callers
 * into the edge's ONE 403 sentence ('platform admins only'; platformQuery/
 * platformMutation above keep their two-sentence pair — both surfaces are
 * pinned by tests). The audit email comes off the component user row by id,
 * not the session (getAuthUser would demand a live session, which
 * `npx convex run --identity` does not have). Adds ctx.operator. */
export const platformAction = customAction(action, {
  args: {},
  input: async (ctx) => {
    refuseDemoFeature()
    const { auth_user_id } = await ctx.runQuery(operatorCheckRef, {})
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: auth_user_id }],
    })) as { email?: string } | null
    const operator: PlatformOperator = { auth_user_id, email: user?.email ?? '' }
    return { ctx: { operator }, args: {} }
  },
})

// Billing recovery must remain available when the workspace is read-only.
// The internal query repeats org membership/admin checks with the action's
// propagated identity; no caller-supplied profile or customer ID is trusted.
const billingAdminRef = makeFunctionReference<
  'query',
  { org_id: string },
  {
    auth_user_id: string
    email: string
    org_name: string
    org_slug: string
  }
>('billing:adminContext')
export const orgAction = customAction(action, {
  args: { org_id: v.string() },
  input: async (ctx, { org_id }) => {
    refuseDemoFeature()
    const caller = await ctx.runQuery(billingAdminRef, { org_id })
    return { ctx: { ...caller, orgId: org_id }, args: {} }
  },
})
