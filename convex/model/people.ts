/* Person-seat rules shared by the organization admin's doors (profiles.ts),
 * the platform operator's doors (admin.ts, adminOrgs.ts) and seat claiming
 * (identity.ts).
 *
 *   address shape      the only address check the database ever had
 *   name shape         0116's normalization and its two sentences
 *   avatar color       #rrggbb on write, gray on read for older values
 *   retention stamp    0112's sibling inheritance, stamped on every create
 *   viewer leads none  0102:391-411, checked before a seat becomes a viewer
 *   claim order        the order claiming adopts an address's pending seats
 *   home elsewhere     which organization would be an address's home
 *
 * Plain functions over ctx, with no wrappers and no auth. Callers hold the
 * refusal posture. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { badRequest, rule } from '../lib/functions'
import { isLabelColor } from './labels'

/* invite_project_guest's regex, mirrored by the client's EMAIL_RE: something,
 * @, something, dot, something, no whitespace. The address is proved by
 * someone signing in with it. */
export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const normalizeEmail = (raw: string | null | undefined): string | undefined => {
  const e = (raw ?? '').trim().toLowerCase()
  return e === '' ? undefined : e
}

/* 0116's normalization, shared by both rename doors AND create: collapse
 * whitespace runs, trim; then the two profiles_name_shape rules as sentences
 * (the CHECK was bare — these are 0116's own RPC wordings). */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

export function assertNameShape(name: string): void {
  if (name === '') throw rule('a name cannot be blank')
  if ([...name].length > 80) throw rule('a name is at most 80 characters')
}

/** The avatar color as given, refused unless it is `#rrggbb`. Clients paint
 * it as a CSS background like a label color, so it follows the label rule. */
export function avatarColor(raw: string): string {
  if (!isLabelColor(raw)) {
    throw badRequest('an avatar color must be # followed by six hex digits, like #0F766E')
  }
  return raw
}

/** The gray a new guest seat gets, sent in place of a color that breaks the rule. */
const FALLBACK_AVATAR_COLOR = '#8A8F98'

/** The color to send a client. Seats created before the `#rrggbb` rule may
 * hold any text, so every read that hands a profile to a client uses this and
 * sends gray instead. The stored value stays as it is. */
export function shownAvatarColor(stored: string): string {
  return isLabelColor(stored) ? stored : FALLBACK_AVATAR_COLOR
}

export const byCreated = (a: Doc<'profiles'>, b: Doc<'profiles'>) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0

/* The order claimSeatsForLogin adopts an address's pending seats in, by
 * created_at and then id (0085). The first non-guest seat adopted becomes the
 * login's home; every later one becomes a guest seat. */
export const byClaimOrder = (a: Doc<'profiles'>, b: Doc<'profiles'>) =>
  a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1

/* The organization that would be this address's home instead of `orgId`, or
 * null. A claimed non-guest seat elsewhere is a home already. A pending one
 * becomes the home if claiming reaches it first, that is, if it comes before
 * `subject` (the seat being judged) in claim order. Without a subject the seat
 * is a new one, which claiming reaches last. */
export async function homeElsewhere(
  ctx: QueryCtx,
  email: string,
  orgId: string | undefined,
  subject?: Doc<'profiles'>,
): Promise<Doc<'organizations'> | null> {
  const seats = await ctx.db
    .query('profiles')
    .withIndex('by_email', (q) => q.eq('email', email))
    .collect()
  const home = seats
    .sort(byClaimOrder)
    .find(
      (p) =>
        p.org_id !== orgId &&
        p.org_role !== 'guest' &&
        (p.auth_user_id !== undefined || subject === undefined || byClaimOrder(p, subject) < 0),
    )
  return home ? await byId(ctx, 'organizations', home.org_id) : null
}

/* The refusal for an org admin whose address has a home elsewhere. Claiming
 * would make the seat a guest, and the organization would have no admin. */
export const adminElsewhere = (email: string, org: Doc<'organizations'>) =>
  rule(
    `${email} already belongs to ${org.name}, so they would join as a guest and could not manage this organization. Invite someone else as org admin.`,
  )

/* How many days a new seat keeps read inbox messages when nothing else
 * decides. It is the old column default, where the app's retention setting
 * also starts. */
export const DEFAULT_MESSAGE_RETENTION_DAYS = 7

/**
 * How many days `p` keeps read inbox messages before the nightly sweep
 * removes them, or null to keep them. A stored period decides. Absent means
 * Never for a person, who chose it in Settings. An agent has no settings
 * page, so one without a stored period keeps them for the default.
 */
export function messageRetentionDays(
  p: Pick<Doc<'profiles'>, 'kind' | 'message_retention_days'>,
): number | null {
  if (p.message_retention_days !== undefined) return p.message_retention_days
  return p.kind === 'agent' ? DEFAULT_MESSAGE_RETENTION_DAYS : null
}

/* profiles_inherit_message_retention (0112): a new seat starts where the
 * person's other seats already are — matched on login OR address across every
 * org, oldest sibling wins, and the value copies even when it is Never
 * (FOUND-not-null semantics). No sibling ⇒ the old column default, 7 —
 * stamped explicitly. */
export async function inheritedRetention(
  ctx: QueryCtx,
  who: { auth_user_id?: string; email?: string },
): Promise<number | undefined> {
  const siblings: Doc<'profiles'>[] = []
  const auth = who.auth_user_id
  if (auth !== undefined) {
    siblings.push(
      ...(await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', auth))
        .collect()),
    )
  }
  const em = who.email
  if (em !== undefined) {
    const carriers = await ctx.db
      .query('profiles')
      .withIndex('by_email', (q) => q.eq('email', em))
      .collect()
    for (const p of carriers) {
      if (!siblings.some((s) => s._id === p._id)) siblings.push(p)
    }
  }
  if (siblings.length === 0) return DEFAULT_MESSAGE_RETENTION_DAYS
  siblings.sort(byCreated)
  return siblings[0].message_retention_days
}

/* viewer-leads-nothing (0102:391-411), agents included; existing grants are
 * deliberately KEPT — they are what the viewer sees through. Call it when a
 * seat that is not yet a viewer is about to become one. `name` is the
 * person's post-patch name, as the BEFORE trigger's new.name was. A guest's
 * memberships are stale, so a guest leads no team. */
export async function assertViewerLeadsNothing(
  ctx: QueryCtx,
  row: Doc<'profiles'>,
  name: string,
): Promise<void> {
  const led = await ctx.db
    .query('projects')
    .withIndex('by_lead', (q) => q.eq('lead_id', row.id))
    .collect()
  if (led.length > 0) {
    throw rule(
      `${name} leads ${led.length} project(s) — hand those over before making them a viewer`,
    )
  }
  let teamsLed = 0
  const memberships = ctx.db
    .query('team_members')
    .withIndex('by_profile', (q) => q.eq('profile_id', row.id))
  for await (const tm of memberships) {
    if (tm.is_leader && row.org_role !== 'guest') teamsLed += 1
  }
  if (teamsLed > 0) {
    throw rule(`${name} leads ${teamsLed} team(s) — hand those over before making them a viewer`)
  }
}
