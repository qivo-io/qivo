// Data layer for the platform-operator admin area: thin wrappers over the
// operator-gated Convex functions (admin.ts platform* queries/mutations, the
// adminStats.ts, adminPeople.ts and usage.ts paged actions and the adminAuth.ts
// session-bound actions).
// Every call throws on error; views catch and surface the message. Changes
// go through ./convex.ts, which refuses them while Qivo cannot save.
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { api } from '../../convex/_generated/api'
import type { DemoMetricsResult } from '../../convex/lib/demoMetricsReport'
import { convex } from '../lib/convex'
import { runAction, sendMutation } from './convex'

// Admin responses normalize absent optional fields to null on the wire.
export type OrgRow = FunctionReturnType<typeof api.adminStats.listOrgs>[number]

export type UserRow = FunctionReturnType<typeof api.adminPeople.userPage>['rows'][number]

export type AuditRow = {
  id: string
  ts: string
  actor_email: string
  action: string
  target_org_id: string | null
  target_profile_id: string | null
  detail: unknown
}

export type PlatformStats = FunctionReturnType<typeof api.adminStats.platformStats>

export type OrgDetail = FunctionReturnType<typeof api.adminPeople.orgDetail>
export type OrgMember = OrgDetail['members'][number]

/* Organization creation and invitations (convex/adminOrgs.ts). */
export type NewOrganization = FunctionArgs<typeof api.adminOrgs.createOrganization>
export type PersonInput = NewOrganization['people'][number]
export type InviteRole = PersonInput['role']
export type InviteResult = FunctionReturnType<typeof api.adminOrgs.resendInvite>
export type PeopleCheck = FunctionReturnType<typeof api.adminOrgs.checkPeople>[number]
export type BillingPlans = FunctionReturnType<typeof api.adminBilling.listPlans>

/* Monthly usage per organization (convex/usage.ts). */
export type UsageMonth = FunctionReturnType<typeof api.usage.monthTable>
export type UsageRow = UsageMonth['rows'][number]
export type OrgUsageMonths = FunctionReturnType<typeof api.usage.orgMonths>
export type OrgUsageMonth = OrgUsageMonths['months'][number]
export type UsagePeople = FunctionReturnType<typeof api.usage.orgPeople>

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
  runAction(api.adminStats.listOrgs, {}).catch(mapError)
/* Every organization's id and name, without the counts listOrgs reads. */
export const listOrgNames = () => runAction(api.adminStats.orgNames, {}).catch(mapError)
/* Every Users page row matching `search`, read one bounded page after
   another (adminPeople.ts userPage). The view orders them. Once `wanted`
   answers false, no further page is read and the rows read so far return. */
export async function listUsers(
  search: string,
  wanted: () => boolean = () => true,
): Promise<UserRow[]> {
  const rows: UserRow[] = []
  let cursor: string | null = null
  do {
    const page = await runAction(api.adminPeople.userPage, { search, cursor }).catch(mapError)
    rows.push(...page.rows)
    cursor = page.next
  } while (cursor !== null && wanted())
  return rows
}
/** A page of the audit log, newest first, from `cursor` (the `next` of the
    page before, null for the newest); `next` is null on the last page. */
export const auditLog = (
  cursor: string | null = null,
  limit = 200,
): Promise<{ rows: AuditRow[]; next: string | null }> =>
  convex.query(api.admin.auditLog, { cursor, limit }).catch(mapError)
export const orgDetail = (orgId: string): Promise<OrgDetail> =>
  runAction(api.adminPeople.orgDetail, { org_id: orgId }).catch(mapError)
export const platformStats = (): Promise<PlatformStats> =>
  runAction(api.adminStats.platformStats, {}).catch(mapError)
/* A closed month's stored rows, or the current month computed now. */
export const usageMonth = (month: string): Promise<UsageMonth> =>
  runAction(api.usage.monthTable, { month }).catch(mapError)
export const orgUsageMonths = (orgId: string): Promise<OrgUsageMonths> =>
  runAction(api.usage.orgMonths, { org_id: orgId }).catch(mapError)
export const orgUsagePeople = (orgId: string, month: string): Promise<UsagePeople> =>
  runAction(api.usage.orgPeople, { org_id: orgId, month }).catch(mapError)
export const demoMetrics = (): Promise<DemoMetricsResult> =>
  convex.query(api.adminDemo.metrics, {}).catch(mapError)
export const promoteOrgAdmin = (profileId: string): Promise<null> =>
  sendMutation(api.admin.promoteOrgAdmin, { profile_id: profileId }).catch(mapError)

export const listPlans = (): Promise<BillingPlans> =>
  convex.query(api.adminBilling.listPlans, {}).catch(mapError)
/* The address the server would generate for a name. */
export const suggestAddress = (name: string): Promise<string> =>
  convex.query(api.adminOrgs.suggestAddress, { name }).catch(mapError)
/* ok, or the reason code: slug_shape, slug_reserved or slug_taken. */
export const checkAddress = (slug: string) =>
  convex.query(api.adminOrgs.checkAddress, { slug }).catch(mapError)
/* Omit orgId for an organization that does not exist yet. */
export const checkPeople = (emails: string[], orgId?: string): Promise<PeopleCheck[]> =>
  convex
    .query(api.adminOrgs.checkPeople, orgId === undefined ? { emails } : { emails, org_id: orgId })
    .catch(mapError)
export const createOrganization = (input: NewOrganization) =>
  runAction(api.adminOrgs.createOrganization, input).catch(mapError)
export const invitePeople = (orgId: string, people: PersonInput[]) =>
  runAction(api.adminOrgs.invitePeople, { org_id: orgId, people }).catch(mapError)
export const resendInvite = (profileId: string): Promise<InviteResult> =>
  runAction(api.adminOrgs.resendInvite, { profile_id: profileId }).catch(mapError)
/* sent is null when the address did not change and no email went out. */
export const editInvite = (profileId: string, name: string, email: string) =>
  runAction(api.adminOrgs.editInvite, { profile_id: profileId, name, email }).catch(mapError)
export const cancelInvite = (profileId: string): Promise<null> =>
  sendMutation(api.adminOrgs.cancelInvite, { profile_id: profileId }).catch(mapError)
export const setMemberRole = (profileId: string, role: InviteRole): Promise<null> =>
  sendMutation(api.adminOrgs.setMemberRole, { profile_id: profileId, role }).catch(mapError)

/* Where an invited person signs up or signs in. The console and the app share
   one origin, so the link is built here rather than asked of the server. */
export const signupLink = (): string => `${location.origin}/app#signup`

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
      return await runAction(api.adminAuth.recoveryLink, { email: body.email })
    }
    if (body.action === 'ban') {
      return await runAction(api.adminAuth.banUser, { email: body.email })
    }
    if (body.action === 'unban') {
      return await runAction(api.adminAuth.unbanUser, { email: body.email })
    }
    return await runAction(api.adminAuth.createBreakGlass, {
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
