// Data layer for the platform-operator admin area: thin wrappers over the
// operator-gated Convex functions (admin.ts platform* queries/mutations and
// the adminAuth.ts session-bound actions).
// Every call throws on error; views catch and surface the message.
import { ConvexError } from 'convex/values'
import { api } from '../../convex/_generated/api'
import type { DemoMetricsResult } from '../../convex/lib/demoMetricsReport'
import { convex } from '../lib/convex'

// Admin responses normalize absent optional fields to null on the wire.
export type OrgRow = {
  id: string
  name: string
  created_at: string
  plan: string | null
  seats: number | null
  renewal_date: string | null
  member_count: number
  guest_count: number
  login_count: number
  team_count: number
  project_count: number
  issue_count: number
  last_activity: string | null
  approx_bytes: number
}

export type UserRow = {
  profile_id: string
  name: string
  email: string | null
  org_id: string
  org_name: string
  org_role: 'admin' | 'user' | 'viewer' | 'guest'
  has_login: boolean
  last_sign_in_at: string | null
  banned_until: string | null
  created_at: string
}

export type AuditRow = {
  id: string
  ts: string
  actor_email: string
  action: string
  target_org_id: string | null
  target_profile_id: string | null
  detail: unknown
}

export type PlatformStats = {
  totals: {
    orgs: number
    members: number
    logins: number
    teams: number
    projects: number
    issues: number
    activity_30d: number
    db_total_bytes: number
  }
  weekly: { week: string; new_members: number; activity: number }[]
}

export type OrgDetail = {
  org: { id: string; name: string; created_at: string }
  billing: { plan: string; seats: number; renewal_date: string | null } | null
  members: {
    profile_id: string
    name: string
    email: string | null
    org_role: 'admin' | 'user' | 'viewer' | 'guest'
    has_login: boolean
    last_sign_in_at: string | null
    banned_until: string | null
    created_at: string
  }[]
  teams: { id: string; name: string; member_count: number; project_count: number }[]
}

/* ConvexError.data = { code, message, reason? } (convex/lib/functions.ts) —
   surface the server's sentence; anything else rethrows untouched. */
function mapError(e: unknown): never {
  if (e instanceof ConvexError) {
    const data = e.data as { message?: string } | string
    const message =
      typeof data === 'object' && data !== null && typeof data.message === 'string'
        ? data.message
        : String(data)
    throw new Error(message)
  }
  throw e
}

export const listOrgs = (): Promise<OrgRow[]> =>
  convex.query(api.admin.listOrgs, {}).catch(mapError)
export const listUsers = (search: string): Promise<UserRow[]> =>
  convex.query(api.admin.listUsers, { search }).catch(mapError)
export const auditLog = (limit = 200): Promise<AuditRow[]> =>
  convex.query(api.admin.auditLog, { limit }).catch(mapError)
export const orgDetail = (orgId: string): Promise<OrgDetail> =>
  convex.query(api.admin.orgDetail, { org_id: orgId }).catch(mapError)
export const platformStats = (): Promise<PlatformStats> =>
  convex.query(api.admin.platformStats, {}).catch(mapError)
export const demoMetrics = (): Promise<DemoMetricsResult> =>
  convex.query(api.adminDemo.metrics, {}).catch(mapError)
export const promoteOrgAdmin = (profileId: string): Promise<null> =>
  convex.mutation(api.admin.promoteOrgAdmin, { profile_id: profileId }).catch(mapError)

// Auth-account operations run as session-bound Convex actions (the server
// re-verifies the caller as a platform operator and audits as them).
type AuthAction =
  | { action: 'recovery_link'; email: string }
  | { action: 'ban'; email: string }
  | { action: 'unban'; email: string }
  | { action: 'create_break_glass'; org_id: string; email: string; name?: string }

export async function authAction(body: AuthAction): Promise<{ ok?: boolean; link?: string }> {
  try {
    if (body.action === 'recovery_link') {
      return await convex.action(api.adminAuth.recoveryLink, { email: body.email })
    }
    if (body.action === 'ban') {
      return await convex.action(api.adminAuth.banUser, { email: body.email })
    }
    if (body.action === 'unban') {
      return await convex.action(api.adminAuth.unbanUser, { email: body.email })
    }
    return await convex.action(api.adminAuth.createBreakGlass, {
      org_id: body.org_id,
      email: body.email,
      ...(body.name !== undefined ? { name: body.name } : {}),
    })
  } catch (e) {
    mapError(e)
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtWhen(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const days = (Date.now() - d.getTime()) / 86400000
  if (days < 0)
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (days < 7) return `${Math.floor(days)}d ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const isBanned = (bannedUntil: string | null) =>
  bannedUntil != null && new Date(bannedUntil).getTime() > Date.now()
