/* Public demos have a real authenticated owner and a fixed server deadline.
 * This module deliberately does not import auth.ts/functions.ts: both auth
 * triggers and the common function wrappers use these checks. */

import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { ConvexError } from 'convex/values'
import { components } from '../_generated/api'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { deploymentEnvironment } from './deployment'

declare class TextEncoder {
  encode(input: string): Uint8Array
}

export const DEMO_TTL_MS = 86_400_000
export const DEMO_WRITES_PER_MINUTE = 120
export const DEMO_WRITES_TOTAL = 10_000
export const DEMO_MAX_PAYLOAD_BYTES = 65_536
export const DEMO_INSERTS_TOTAL = 5_000
export const DEMO_MAX_SESSIONS = 500
declare const crypto: { randomUUID(): string }

const expireRef = makeFunctionReference<'mutation', { id: string }>('demo:expire')

export const isDemoDeployment = (): boolean => process.env.APP_MODE === 'demo'

export function requireDemoDeployment(): void {
  if (!isDemoDeployment()) throw demoRefusal('Demo access is unavailable.', 'demo_unavailable')
  if (deploymentEnvironment() === 'production') {
    throw demoRefusal('Demo access is unavailable on the main deployment.', 'demo_unavailable')
  }
  // A misdirected deployment must never turn the actual product into a demo.
  // SITE_URL is controlled by the deployment, never by request headers.
  const origin = process.env.SITE_URL
  if (!origin) throw demoRefusal('Demo deployment is not configured.', 'demo_unavailable')
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    throw demoRefusal('Demo deployment is not configured.', 'demo_unavailable')
  }
  if (host === 'qivo.io' || host === 'www.qivo.io')
    throw demoRefusal('Demo access is unavailable on the main deployment.', 'demo_unavailable')
}

export function demoAdmissionOpen(): boolean {
  return isDemoDeployment() && process.env.DEMO_ADMISSION_OPEN === 'true'
}

export function demoRefusal(message = 'Your demo has expired.', reason = 'demo_expired') {
  return new ConvexError({ code: 'forbidden' as const, message, reason })
}

export function refuseDemoFeature(): void {
  if (isDemoDeployment())
    throw demoRefusal('This feature requires a regular workspace.', 'demo_feature_unavailable')
}

export async function demoForAuth(ctx: QueryCtx, authUserId: string) {
  return ctx.db
    .query('demo_sessions')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authUserId))
    .unique()
}

export async function demoForOrg(ctx: QueryCtx, orgId: string) {
  return ctx.db
    .query('demo_sessions')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
}

export function assertDemoActive(
  receipt: Doc<'demo_sessions'> | null,
  ready = true,
): asserts receipt is Doc<'demo_sessions'> {
  if (!receipt || receipt.status === 'deleting' || receipt.expires_at <= Date.now())
    throw demoRefusal()
  if (ready && (receipt.status !== 'ready' || !receipt.org_id))
    throw demoRefusal('Your demo is still being prepared.', 'demo_preparing')
}

export async function requireActiveDemo(
  ctx: QueryCtx,
  authUserId: string,
  opts?: { ready?: boolean },
) {
  requireDemoDeployment()
  const receipt = await demoForAuth(ctx, authUserId)
  assertDemoActive(receipt, opts?.ready !== false)
  return receipt
}

/** Gate capabilities that resolve a profile/org instead of a browser identity. */
export async function requireActiveDemoOrg(ctx: QueryCtx, orgId: string) {
  if (!isDemoDeployment()) return null
  requireDemoDeployment()
  const receipt = await demoForOrg(ctx, orgId)
  assertDemoActive(receipt)
  return receipt
}

/** Failed mutations roll this accounting back with their own writes. */
export async function consumeDemoWrite(ctx: MutationCtx, authUserId: string): Promise<void> {
  if (!isDemoDeployment()) return
  const receipt = await requireActiveDemo(ctx, authUserId)
  const now = Date.now()
  const fresh = receipt.write_window_at === undefined || now - receipt.write_window_at >= 60_000
  const count = fresh ? 0 : (receipt.write_window_count ?? 0)
  const total = receipt.write_count ?? 0
  if (count >= DEMO_WRITES_PER_MINUTE || total >= DEMO_WRITES_TOTAL)
    throw demoRefusal('Your demo has reached its change limit. Try again later.', 'demo_limit')
  await ctx.db.patch(receipt._id, {
    write_window_at: fresh ? now : receipt.write_window_at,
    write_window_count: count + 1,
    write_count: total + 1,
  })
}

export function assertDemoPayload(value: unknown): void {
  if (
    isDemoDeployment() &&
    new TextEncoder().encode(JSON.stringify(value)).length > DEMO_MAX_PAYLOAD_BYTES
  )
    throw demoRefusal('This change is too large for the demo.', 'demo_limit')
}

/** Count actual inserted records, including narration and bulk helpers, in
 * the writer's transaction. Updating the receipt uses the underlying writer
 * so accounting cannot recursively count itself. */
export function demoWriter(ctx: MutationCtx, authUserId: string): MutationCtx['db'] {
  if (!isDemoDeployment()) return ctx.db
  const insert = async <Table extends TableNames>(
    table: Table,
    value: WithoutSystemFields<Doc<Table>>,
  ): Promise<Id<Table>> => {
    assertDemoPayload(value)
    const receipt = await requireActiveDemo(ctx, authUserId)
    const count = receipt.insert_count ?? 0
    if (count >= DEMO_INSERTS_TOTAL)
      throw demoRefusal('Your demo has reached its record limit.', 'demo_limit')
    await ctx.db.patch(receipt._id, { insert_count: count + 1 })
    return ctx.db.insert(table, value)
  }
  return new Proxy(ctx.db, {
    get(target, key) {
      if (key === 'insert') return insert
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export async function registerDemoUser(
  ctx: MutationCtx,
  user: { _id: string; isAnonymous?: boolean | null },
): Promise<void> {
  if (!isDemoDeployment()) {
    if (user.isAnonymous) throw demoRefusal('Demo access is unavailable.', 'demo_unavailable')
    return
  }
  requireDemoDeployment()
  if (!user.isAnonymous || !demoAdmissionOpen())
    throw demoRefusal('New demos are temporarily unavailable.', 'demo_unavailable')
  if (await demoForAuth(ctx, user._id))
    throw demoRefusal('This demo already exists.', 'demo_conflict')
  if ((await ctx.db.query('demo_sessions').take(DEMO_MAX_SESSIONS)).length >= DEMO_MAX_SESSIONS)
    throw demoRefusal('The demo is busy. Please try again later.', 'demo_limit')
  const now = Date.now(),
    id = crypto.randomUUID(),
    expires_at = now + DEMO_TTL_MS
  const expiry_scheduled_id = await ctx.scheduler.runAt(expires_at, expireRef, { id })
  await ctx.db.insert('demo_sessions', {
    id,
    auth_user_id: user._id,
    created_at: now,
    expires_at,
    status: 'unprovisioned',
    expiry_scheduled_id,
  })
}

export async function clampDemoSession(
  ctx: MutationCtx,
  session: { _id: string; userId: string; expiresAt: number },
): Promise<void> {
  if (!isDemoDeployment()) return
  const receipt = await requireActiveDemo(ctx, session.userId, { ready: false })
  const expiresAt = Math.min(session.expiresAt, receipt.expires_at)
  if (expiresAt !== session.expiresAt)
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'session',
        where: [{ field: '_id', value: session._id }],
        update: { expiresAt },
      },
    })
}

export async function expireDeletedDemoUser(ctx: MutationCtx, userId: string): Promise<void> {
  const receipt = await demoForAuth(ctx, userId)
  if (!receipt || receipt.status === 'deleting') return
  await ctx.db.patch(receipt._id, { status: 'deleting' })
  await ctx.scheduler.runAfter(0, expireRef, { id: receipt.id })
}
