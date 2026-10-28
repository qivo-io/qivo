/* What the API access page (panels/settings/ApiAccessSettings.tsx) shows for
   the server's answers (convex/apiAccess.ts): labels, the count line and the
   revoke window's sentence. Pure, so they are tested without rendering. Dates
   follow the organization's date format (lib/dates.ts). */
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { fmtDateYear } from './dates'
import { expiryLabel, lastDay } from './tokenExpiry'

export type ApiAccessSummaryAnswer = FunctionReturnType<typeof api.apiAccess.summary>
export type ApiAccessFigures = Extract<ApiAccessSummaryAnswer, { state: 'ready' }>
export type ApiUsagePeriod = ApiAccessSummaryAnswer['periods'][number]
export type ApiAccessPageAnswer = FunctionReturnType<typeof api.apiAccess.page>
export type ApiAccessPageRows = Extract<ApiAccessPageAnswer, { state: 'ready' }>
export type ApiCredentialRow = ApiAccessPageRows['rows'][number]
export type ApiAccessPerson = NonNullable<ApiAccessPageRows['person']>
export type ApiAccessPeopleAnswer = FunctionReturnType<typeof api.apiAccess.people>
export type ApiCredentialKind = ApiCredentialRow['table']

/** What Billing's View credentials hands to API access: the organization,
    the account and the usage period of the report it showed. */
export type ApiAccessEntry = { org_id: string; profile_id: string; period_key: string }

export const KIND_LABEL: Record<ApiCredentialKind, string> = {
  mcp_tokens: 'Personal token',
  oauth_connections: 'Connected app',
  agent_keys: 'Agent key',
}

/* The kind's icon, as the token list and the Users page draw them. */
export const KIND_ICON: Record<ApiCredentialKind, string> = {
  mcp_tokens: 'command',
  oauth_connections: 'plug',
  agent_keys: 'zap',
}

export const ACCESS_LABEL = { read: 'Read only', write: 'Can make changes' } as const

/** The page's filters as the server applies them. `person` is the chosen
    profile, with its name once known, or null for everyone; `search` is the
    text sent, trimmed. */
export type ApiAccessFilters = {
  kind: 'all' | ApiCredentialKind
  state: 'active' | 'all'
  person: { id: string; name?: string } | null
  search: string
}

/** Whether a credential no longer works by itself: revoked, expired or
    deleted. Such a row is dimmed and offers no Revoke. */
export const credentialEnded = (row: ApiCredentialRow): boolean =>
  row.state === 'revoked' || row.state === 'expired' || row.state === 'deleted'

/* A day the server names in UTC (a calendar-month bucket), read as that
   calendar day wherever the viewer is. */
const utcDay = (iso: string): Date => {
  const d = new Date(iso)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** The period select's label: "1 Oct to 31 Oct" for a calendar month (a UTC
    month) or a paid period, "From 2 Jul" when the end is unknown. The year
    shows only when it is not this year. */
export function periodLabel(period: ApiUsagePeriod, now: Date): string {
  const day = (iso: string) => {
    const d = period.kind === 'month' ? utcDay(iso) : new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : fmtDateYear(d, now)
  }
  return period.end === null
    ? `From ${day(period.start)}`
    : `${day(period.start)} to ${day(period.end)}`
}

/** The line under the summary bar: the plan's allowance per seat, then the
    price of calls above it, or why the period's calls are not charged. Null
    without a plan, when the page shows only the count. */
export function planLine(
  summary: ApiAccessFigures['summary'],
  period: ApiUsagePeriod,
): string | null {
  const plan = summary.plan
  if (!plan) return null
  const shared = `${plan.api_calls_per_seat.toLocaleString()} calls per seat, shared by the organization.`
  if (period.kind === 'month') return `${shared} Calls are not charged without a paid period.`
  if (summary.waived) return `${shared} Calls in this period are not charged.`
  const cents = plan.api_block_price_cents
  const price = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: plan.currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
  return `${shared} Each started ${plan.api_block_size.toLocaleString()} above that costs ${price}.`
}

/** When a credential was last used: "Just now", "12 min ago", "1 h ago",
    "Yesterday", "3 days ago", then the date. */
export function lastUsedLabel(iso: string | null, now: Date): string {
  if (iso === null) return 'Never'
  const at = new Date(iso)
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000)
  if (days <= 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return fmtDateYear(at, now)
}

/** The mono line under a credential's name: a token's prefix, an agent key's
    fingerprint, or a connected app's OAuth client id, shortened. A deleted
    credential has none. */
export function credentialPrefix(row: ApiCredentialRow): string | null {
  if (row.prefix === null) return null
  if (row.table !== 'oauth_connections') return row.prefix
  const id = row.prefix
  return `client ${id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id}`
}

/** The tag beside the prefix for a credential that does not work: "revoked
    6 Oct", "expired 9 Sep", "account inactive" or "deleted". */
export function stateTag(row: ApiCredentialRow, now: Date): string | null {
  const day = (iso: string) => fmtDateYear(new Date(iso), now)
  switch (row.state) {
    case 'revoked':
      return row.revoked_at ? `revoked ${day(row.revoked_at)}` : 'revoked'
    case 'expired': {
      // the last day it worked, as its owner's token list names it
      const last = row.expires_at ? lastDay(row.expires_at) : null
      return last ? `expired ${fmtDateYear(last, now)}` : 'expired'
    }
    case 'inactive':
      return 'account inactive'
    case 'deleted':
      return 'deleted'
    default:
      return null
  }
}

/** The expiry under a working token's access, as its owner's token list
    shows it: the last day it works ("expires 18 Nov"), or "expires today",
    "expires tomorrow" or "expires in 6 days" when that is close. A token
    stores the instant after its last day (lib/tokenExpiry.ts). */
export function expiryNote(row: ApiCredentialRow, now: Date): string | null {
  if (row.expires_at === null || credentialEnded(row)) return null
  const { text, soon } = expiryLabel(row.expires_at, now)
  return text ? `expires ${soon ? text.toLowerCase() : text}` : null
}

/** The count line: the rows on screen as positions in the list, "26–50",
    or "26" for one row. Convex keeps no count, so there is no total. Null
    for no rows. `first` is how many rows the pages before this one held. */
export function rangeLabel(first: number, count: number): string | null {
  if (count <= 0) return null
  return count === 1 ? `${first + 1}` : `${first + 1}–${first + count}`
}

/** The revoke window's sentence, which says what stops and what the owner
    can do next. */
export function revokeSentence(row: ApiCredentialRow, me: string): string {
  const mine = row.profile_id === me
  const whose = mine ? 'Your' : `${row.person}'s`
  const first = row.person.split(/\s+/)[0] || row.person
  switch (row.table) {
    case 'mcp_tokens':
      return mine
        ? 'Your personal token stops working right away. You can create a new one.'
        : `${whose} personal token stops working right away. ${first} sees it as revoked by an admin and can create a new one.`
    case 'oauth_connections':
      return `${whose} connection to ${row.name} stops working right away. ${mine ? 'You' : first} can connect it again.`
    default:
      return `${whose} agent key stops working right away. Create a new key for it in Users.`
  }
}
