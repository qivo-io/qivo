/* The platform-operator fixture and the platform_admins plumbing — the
 * development-only half that outlived the old demo seed.
 *
 *   npx convex run internal/operator:testOperator
 *
 * mints (or repairs) operator@demo.local / qivo-demo: a Better Auth login
 * with role admin plus a platform_admins row, and deliberately NO profile —
 * an operator is a member of no customer organization, and a seat-less
 * login is the state the admin area is meant to be used from. The same
 * ensureOperator runs on every Vercel preview (internal/previewSeed).
 *
 * Operator-only posture (0119): everything here is internal — unreachable
 * from clients — and `npx convex run` is deploy-key-gated. That gate is the
 * fence; lib/deployment's SITE_URL check is belt and braces against the one
 * deployment where a documented password would be a back door. */

import { v } from 'convex/values'
import { components, internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import { internalAction, internalMutation } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { refuseProduction } from '../lib/deployment'

/* The one documented password every development fixture login carries. */
export const FIXTURE_PASSWORD = 'qivo-demo'

export const OPERATOR = { email: 'operator@demo.local', name: 'Operator' }

type ComponentUser = { _id: string; role?: string | null }

export const findUserByEmail = async (ctx: ActionCtx, email: string) =>
  (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: 'email', value: email }],
  })) as ComponentUser | null

/* Headerless server call: createUser skips the admin-session check when no
 * request/headers are present, and `data` spreads into the user row, so
 * emailVerified lands directly. Idempotent: an existing login is kept as is. */
export const ensureAuthUser = async (
  ctx: ActionCtx,
  auth: ReturnType<typeof createAuth>,
  { email, name }: { email: string; name: string },
) => {
  const existing = await findUserByEmail(ctx, email)
  if (existing !== null) {
    console.log(`[fixture] exists email=${email}`)
    return { id: existing._id, role: existing.role ?? null }
  }
  const { user } = await auth.api.createUser({
    body: { email, password: FIXTURE_PASSWORD, name, data: { emailVerified: true } },
  })
  console.log(`[fixture] created email=${email}`)
  return { id: user.id, role: user.role ?? null }
}

/* Better Auth's adminMiddleware gates banUser/setUserPassword/removeUser on
 * the CALLER's user.role — our requireOperator alone does not satisfy it,
 * so the operator's Better Auth user must itself carry role admin.
 * createUser always writes the default role 'user', hence the follow-up
 * adapter update (idempotent: skipped once set). */
export const ensureOperator = async (
  ctx: ActionCtx,
  auth: ReturnType<typeof createAuth>,
): Promise<string> => {
  const operator = await ensureAuthUser(ctx, auth, OPERATOR)

  if (operator.role !== 'admin') {
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: 'email', value: OPERATOR.email }],
        update: { role: 'admin' },
      },
    })
    console.log('[fixture] set role=admin on operator Better Auth user')
  }

  await ctx.runMutation(internal.internal.operator.ensurePlatformAdmin, {
    auth_user_id: operator.id,
    note: 'Test operator for the admin smoke drive — development deployments only',
  })

  return operator.id
}

export const ensurePlatformAdmin = internalMutation({
  args: { auth_user_id: v.string(), note: v.string() },
  handler: async (ctx, { auth_user_id, note }) => {
    const existing = await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', auth_user_id))
      .first()
    if (existing !== null) return
    await ctx.db.insert('platform_admins', {
      auth_user_id,
      note,
      created_at: new Date().toISOString(),
    })
  },
})

/* testOperator's teardown half: Postgres cascaded platform_admins off
 * auth.users; Convex has no cascades, so the row pointing at the old user id
 * is dropped explicitly and re-ensured on the new id. */
export const removePlatformAdmin = internalMutation({
  args: { auth_user_id: v.string() },
  handler: async (ctx, { auth_user_id }) => {
    const existing = await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', auth_user_id))
      .unique()
    if (existing !== null) await ctx.db.delete(existing._id)
  },
})

/* Adapter-level login removal (BA notes §3.2): auth.api.removeUser demands an
 * admin SESSION a fixture action does not have, so the rows go directly —
 * appearance, sessions and credential accounts first, then the user. */
export const deleteAuthUser = async (ctx: ActionCtx, userId: string) => {
  await ctx.runMutation(internal.appearance.clearForDeletedLogin, { auth_user_id: userId })
  for (const model of ['session', 'account'] as const) {
    let cursor: string | null = null
    for (;;) {
      const page: { isDone: boolean; continueCursor: string } = await ctx.runMutation(
        components.betterAuth.adapter.deleteMany,
        {
          input: { model, where: [{ field: 'userId', value: userId }] },
          paginationOpts: { numItems: 200, cursor },
        },
      )
      if (page.isDone) break
      cursor = page.continueCursor
    }
  }
  /* The component user table keys on _id itself — there is no `id` column. */
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: 'user', where: [{ field: '_id', value: userId }] },
  })
}

/* test-operator.sql, independently runnable. The fixture is
 * delete-then-recreate — "a forgotten password is repaired by running it
 * again" — which is exactly what ensureAuthUser's idempotent skip does NOT
 * do, so an existing operator login is deleted (sessions, accounts, user,
 * and the platform_admins row the SQL cascade took) and rebuilt from
 * scratch. */
const runTestOperator = async (
  ctx: ActionCtx,
): Promise<{ auth_user_id: string; repaired: boolean }> => {
  refuseProduction('operator')
  const { auth } = await authComponent.getAuth(createAuth, ctx)

  const existing = await findUserByEmail(ctx, OPERATOR.email)
  if (existing !== null) {
    await deleteAuthUser(ctx, existing._id)
    await ctx.runMutation(internal.internal.operator.removePlatformAdmin, {
      auth_user_id: existing._id,
    })
    console.log('[fixture] removed existing operator login for repair')
  }

  const auth_user_id = await ensureOperator(ctx, auth)
  return { auth_user_id, repaired: existing !== null }
}

export const testOperator = internalAction({
  args: {},
  handler: (ctx): Promise<{ auth_user_id: string; repaired: boolean }> => runTestOperator(ctx),
})
