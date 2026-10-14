/* platform_audit_log insert — admin_log_action's successor (0017), shared by
 * the operator console's modules and system jobs. A plain
 * exported function, never a public mutation: the deny-by-default private
 * schema becomes "no public function touches it". Callers
 * resolve the actor themselves (the operator's Better Auth email, 'system'
 * for crons, 'cli' for `npx convex run` mutations) — the SQL's
 * coalesce((select u.email from auth.users …), '') is theirs to say.
 * operatorEmail below resolves it for an operator's mutation. */

import { components } from '../_generated/api'
import type { MutationCtx } from '../_generated/server'

export type AuditEntry = {
  actor_auth_id?: string
  actor_email: string
  action: string
  target_org_id?: string
  target_profile_id?: string
  detail?: Record<string, unknown>
}

export async function audit(ctx: MutationCtx, entry: AuditEntry): Promise<void> {
  await ctx.db.insert('platform_audit_log', {
    ts: new Date().toISOString(),
    actor_email: entry.actor_email,
    action: entry.action,
    ...(entry.actor_auth_id !== undefined ? { actor_auth_id: entry.actor_auth_id } : {}),
    ...(entry.target_org_id !== undefined ? { target_org_id: entry.target_org_id } : {}),
    ...(entry.target_profile_id !== undefined
      ? { target_profile_id: entry.target_profile_id }
      : {}),
    detail: entry.detail ?? {},
  })
}

/* The actor half of an operator's audit row, their Better Auth email, as the
 * SQL's coalesce((select u.email from auth.users …), '') had it (0015:55). An
 * unreadable login row yields '' rather than a failed write. */
export async function operatorEmail(ctx: MutationCtx, authUserId: string): Promise<string> {
  try {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: authUserId }],
    })) as { email?: string } | null
    return user?.email ?? ''
  } catch {
    return ''
  }
}
