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

import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { asciiEmail } from '../lib/email'
import { ORG_ROLES } from '../lib/enums'
import { badRequest, rule } from '../lib/functions'
import { cleanName, DEFAULT_MESSAGE_RETENTION_DAYS, LIMITS, overText } from '../lib/limits'
import {
  assertExpected,
  BOOLEAN,
  exact,
  type Fields,
  hoursOrNull,
  oneOf,
  TEXT_OR_NULL,
  textOrNull,
} from './expected'
import { isLabelColor } from './labels'

export const normalizeEmail = (raw: string | null | undefined): string | undefined => {
  const e = (raw ?? '').trim().toLowerCase()
  return e === '' ? undefined : e
}

/* 0116's normalization, shared by both rename doors AND create, and by the
 * app's name fields (lib/limits.ts cleanName). */
export { cleanName }

/** Refuses a person name, already cleaned (cleanName), that is blank or past
 * LIMITS.personName. */
export function assertNameShape(name: string): void {
  if (name === '') throw rule('a name cannot be blank')
  if (overText(LIMITS.personName, name)) throw rule(LIMITS.personName.refusal)
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
      `${name} leads ${led.length} project(s). Hand those over before making them a viewer.`,
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
    throw rule(`${name} leads ${teamsLed} team(s). Hand those over before making them a viewer.`)
  }
}

/* ------------------------------------------------------- the field check */

/** The keys of a seat's `expected` (model/expected.ts) for an admin's edit
 * on the Users page, the plannable week (REST's and MCP's only key), the
 * display name a person gives themselves and the profile picture. */
export const PROFILE_FIELDS: Fields<Doc<'profiles'>> = {
  org_role: { sends: 'org_role', type: oneOf(ORG_ROLES), form: exact },
  active: { sends: 'active', type: BOOLEAN, form: exact },
  name: {
    sends: 'name',
    type: textOrNull(LIMITS.personName),
    form: (value) => (value == null ? null : cleanName(String(value))),
  },
  email: {
    sends: 'email',
    type: textOrNull(LIMITS.email),
    // the stored form (lib/email.ts), so an address read back compares
    form: (value) => (value == null ? null : asciiEmail(String(value)) || null),
  },
  // Off is stored as absence (lib/projectCreators.ts), so false and absent
  // are one value
  can_create_projects: {
    sends: 'can_create_projects',
    type: BOOLEAN,
    form: (value) => value === true,
  },
  // a seat created without a plannable week reads null; a set one follows
  // model/orgs.ts setPlannableHoursCore's rule
  plannable_hours: {
    sends: 'plannable_hours',
    type: hoursOrNull({
      min: LIMITS.plannableHours.min,
      max: LIMITS.plannableHours.max,
      whole: true,
      says: `a whole number of hours from ${LIMITS.plannableHours.min} to ${LIMITS.plannableHours.max}, or null`,
    }),
    form: exact,
  },
  avatar_storage_id: { sends: 'avatar_storage_id', type: TEXT_OR_NULL, form: exact },
}

/** The key REST's PATCH /v1/users/{ref} and MCP's update_user take. */
export const PLANNABLE_FIELDS: Fields<Doc<'profiles'>> = {
  plannable_hours: PROFILE_FIELDS.plannable_hours,
}

/** The app's `expected` for a seat edit. */
export const vProfileExpected = v.object({
  org_role: v.optional(v.string()),
  active: v.optional(v.boolean()),
  name: v.optional(v.union(v.string(), v.null())),
  email: v.optional(v.union(v.string(), v.null())),
  can_create_projects: v.optional(v.union(v.boolean(), v.null())),
  plannable_hours: v.optional(v.union(v.number(), v.null())),
  avatar_storage_id: v.optional(v.union(v.string(), v.null())),
})

/** Refuses an edit of `seat` over a field someone else changed since
 * `expected` was read. `next` holds what the edit stores for each key it
 * sends. */
export async function assertProfileExpected(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    seat: Doc<'profiles'>
    expected: Readonly<Record<string, unknown>> | undefined
    next: Readonly<Record<string, unknown>>
  },
): Promise<void> {
  await assertExpected({
    read: { ctx, me: a.me, view: 'app' },
    fields: PROFILE_FIELDS,
    record: 'profile',
    id: a.seat.id,
    label: `user "${a.seat.name}"`,
    row: a.seat,
    expected: a.expected,
    next: a.next,
  })
}
