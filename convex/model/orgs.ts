/* Organization internals: initials, the slug machinery, the org counters,
 * the new-org/starter-team defaults and the org guards:
 *
 *   nameInitials     fold, THEN cut to two
 *   slug machinery   the generator, the shape check and the reserved-word
 *                    list (the reserved word is `qivo`)
 *   counters         the per-org issue number and project number
 *   column defaults  including the organization-wide 20 MiB upload cap
 *   last admin       an org may never lose its last admin
 *   last team        an org may never lose its last team
 *   slug narration   organizations_slug_narrate (0108)
 *   week labels      src/lib/dates.ts:114-141 (fmtDate/weekNumberOf), for
 *                    server-owned milestone narration
 *
 * Plain async functions over ctx — no wrappers, no auth: callers hold the
 * refusal posture. The guards throw `rule` refusals themselves; internal
 * seed/reset mutations simply do not call them. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { conflict, notFound, require, rule } from '../lib/functions'
import { logActivity } from './activity'

/* Web Crypto exists in the Convex isolate (and the edge-runtime VM), but
 * convex/tsconfig's lib is ESNext only, which does not declare the global. */
declare const crypto: { randomUUID(): string }

export const newUuid = () => crypto.randomUUID()

/* ------------------------------------------------------------------ initials
 * private.name_initials (0117): first alphanumeric of each word, in order;
 * cut to two; UPPERCASE; cut to two AGAIN — the second cut is the fix, because
 * uppercasing is not one-to-one (ß→SS, ﬄ→FFL) and the stored value is capped
 * at 3 chars. '?' when the name holds no alphanumerics at all. Cuts count
 * codepoints (Postgres substr semantics), hence the Array.from spreads. */
export function nameInitials(name: string | null | undefined): string {
  let letters = ''
  for (const word of (name ?? '').trim().split(/\s+/)) {
    const m = word.match(/[\p{L}\p{N}]/u)
    if (m !== null) letters += m[0]
  }
  const folded = [...letters].slice(0, 2).join('').toUpperCase()
  const cut = [...folded].slice(0, 2).join('')
  return cut === '' ? '?' : cut
}

/* ---------------------------------------------------------------------- slug
 * One constant serves the validator AND the generator — the SQL carried two
 * copies (a privilege constraint on CHECK expressions) and proved them equal;
 * here the duplication simply does not exist. List verbatim from 0107. */
const RESERVED_WORDS =
  'about|accept|account|accounts|admin|administrator|api|app|apps|archive|assets|auth|billing|blog|board|callback|cdn|changelog|checkout|confirm|contact|cookies|dashboard|demo|doc|docs|download|downloads|email|enterprise|faq|favicon|features|feed|ftp|graphql|help|home|images|img|inbox|integrations|internal|invite|invites|join|legal|login|logout|mail|mcp|me|media|new|news|notifications|oauth|onboarding|org|organization|organizations|orgs|overview|partners|payment|payments|plans|press|pricing|privacy|project|projects|public|qivo|register|rest|reset|roadmap|robots|root|search|security|settings|setup|share|shared|signin|signout|signup|sitemap|sso|static|status|subscribe|subscription|support|system|task|tasks|team|teams|terms|test|token|trial|upgrade|user|users|verify|webhook|webhooks|welcome|www'

export const RESERVED_SLUGS: ReadonlySet<string> = new Set(RESERVED_WORDS.split('|'))

/* organizations_slug_check (0107): alphanumeric groups joined by SINGLE
 * hyphens, no leading/trailing one, 1..40 chars. '~' is structurally
 * unspellable — /app/~/ routing depends on that. */
export const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SLUG_MAX = 40

/* icon_color (teams AND projects) is stored user data that reaches the browser
 * as SVG paint, so it is allowlisted at the WRITE rather than escaped at the
 * read: a 6-digit hex — the only thing the picker's swatches and its HSV
 * custom field can produce — or the legacy 'rainbow' gradient that predates
 * the picker and is still rendered though no longer offered. A length cap is
 * NOT a substitute: a 19-character value is long enough to close the `fill="`
 * attribute the glyph draws it into and open an event handler. */
export const ICON_COLOR_SHAPE = /^(?:#[0-9a-fA-F]{6}|rainbow)$/

const trimHyphens = (s: string) => s.replace(/^-+|-+$/g, '')

const slugHolder = (ctx: QueryCtx, slug: string) =>
  ctx.db
    .query('organizations')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .first()

/* The setSlug-side validator — the 23514/23505 taxonomy as typed refusals.
 * `owner` is the org uuid allowed to already hold the value, so a same-value
 * write is not "taken" by the writer's own row. orgs.setSlug pairs this with
 * narrateSlugChange (below) in the same mutation. */
export async function assertSlugAvailable(
  ctx: QueryCtx,
  slug: string,
  owner?: string,
): Promise<void> {
  if (!SLUG_SHAPE.test(slug) || slug.length > SLUG_MAX) {
    throw conflict(
      'An address is lowercase letters, digits and single hyphens between them — up to 40 characters.',
      'slug_shape',
    )
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw conflict('That address is reserved — choose another.', 'slug_reserved')
  }
  const holder = await slugHolder(ctx, slug)
  if (holder !== null && holder.id !== owner) {
    throw conflict('That address is already taken — choose another.', 'slug_taken')
  }
}

/* private.org_slug (0107): derive from the name, then probe -2/-3/… while the
 * candidate is reserved OR taken. A reserved word is SKIPPED like a taken one
 * ("Admin" ⇒ admin-2), never refused on the self-serve path. Every cut is
 * re-trimmed — a cut can land on a separator. */
export async function generateSlug(ctx: QueryCtx, name: string): Promise<string> {
  let base = trimHyphens(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  base = trimHyphens(base.slice(0, 32))
  if (base === '') base = 'org'
  let s = base
  let i = 1
  while (RESERVED_SLUGS.has(s) || (await slugHolder(ctx, s)) !== null) {
    i += 1
    let stem = trimHyphens(base.slice(0, 31 - String(i).length))
    if (stem === '') stem = 'org'
    s = `${stem}-${i}`
  }
  return s
}

/* organizations_slug_narrate (0108): after a slug write whose value ACTUALLY
 * changed, one activity row in the same mutation. Only orgs.setSlug calls it —
 * creation never narrates, a same-value write must not (the caller's no-op
 * return AND the guard here), and renaming the NAME must not. actor_id is the
 * caller's profile in the changed org; undefined on an operator/seed path
 * (the feed's neutral "Someone", private.profile_in's null). */
export async function narrateSlugChange(
  ctx: MutationCtx,
  org: Doc<'organizations'>,
  {
    old_slug,
    new_slug,
    actor_id,
    now,
  }: {
    old_slug: string
    new_slug: string
    actor_id: string | undefined
    now: string
  },
): Promise<void> {
  if (old_slug === new_slug) return
  await logActivity(ctx, {
    org_id: org.id,
    actor_id,
    verb: 'changed the address of',
    target_type: 'org',
    target_id: org.id,
    label: org.name,
    detail: `${old_slug} → ${new_slug}`,
    ts: now,
  })
}

/* ------------------------------------------------------------------ counters
 * issues_before_insert / projects_assign_num (0050/0100): bump the org-row
 * counter and use the result as the row's num, inside the one mutation.
 * Convex serializes conflicting mutations (the row lock's successor), so
 * numbers are dense per org at assignment, never reused, and nothing else may
 * write these fields. The doc is re-read by _id so two bumps inside one
 * mutation chain instead of reusing a stale value. */
async function bump(
  ctx: MutationCtx,
  org: Doc<'organizations'>,
  field: 'next_issue_num' | 'next_project_num',
): Promise<number> {
  const live = await ctx.db.get(org._id)
  require(live !== null, notFound('organization not found'))
  const used = live[field] + 1
  await ctx.db.patch(org._id, { [field]: used })
  return used
}

export const nextIssueNum = (ctx: MutationCtx, org: Doc<'organizations'>): Promise<number> =>
  bump(ctx, org, 'next_issue_num')

export const nextProjectNum = (ctx: MutationCtx, org: Doc<'organizations'>): Promise<number> =>
  bump(ctx, org, 'next_project_num')

/* ------------------------------------------------------------------ defaults
 * The organizations column defaults (0020/0039/0050/0095/0096). */
export const newOrgDefaults = (now: string) => ({
  created_at: now,
  next_issue_num: 0,
  activity_count: 0,
  next_project_num: 0,
  date_format: 'YYYY-MM-DD',
  week_start: 1,
  week_one_rule: 'first4day',
  default_plannable_hours: 32,
  gravatar_avatars: true,
  max_attachment_mb: 20,
  only_team_leads_manage_project_users: true,
})

/* New teams mark tasks stale after 120 days and auto-archive after 30 days.
 * Existing configured values are preserved; uploads use the org's cap. */
export const newTeamDefaults = (now: string) => ({
  stale_days: 120,
  archive_days: 30,
  track_delay_default: true,
  created_at: now,
})

/* Initial organization vocabulary. These stored colors come from the label
 * picker palette; each organization owns its editable copies. */
const DEFAULT_LABELS = [
  { name: 'Electronics', color: '#4C9AFF' },
  { name: 'Mechanical', color: '#F2994A' },
] as const

export async function createStarterLabels(
  ctx: MutationCtx,
  { org_id, now }: { org_id: string; now: string },
): Promise<void> {
  for (const label of DEFAULT_LABELS) {
    await ctx.db.insert('labels', {
      id: newUuid(),
      org_id,
      name: label.name,
      name_lower: label.name.toLowerCase(),
      color: label.color,
      created_at: now,
    })
  }
}

/* create_organization's tail (0118): every new organization gets a starter
 * team for its first workstream. Products themselves are team-less; the
 * creator becomes the initial product lead in the client flow. */
export async function createStarterTeam(
  ctx: MutationCtx,
  {
    org_id,
    name,
    leader_id,
    now,
  }: { org_id: string; name: string; leader_id: string; now: string },
): Promise<string> {
  const teamId = newUuid()
  await ctx.db.insert('teams', { id: teamId, org_id, name, ...newTeamDefaults(now) })
  await ctx.db.insert('team_members', { team_id: teamId, profile_id: leader_id, is_leader: true })
  return teamId
}

/* profiles_last_admin_update / _delete (0099:286-323): the last admin who can
 * actually sign in and fix things stays. The FIRE condition lives in the
 * caller — demote/deactivate when (old admin AND old active) and NOT
 * (new admin AND new active); remove when old admin AND old active — this
 * counts OTHER active admins of the subject's org and refuses when none
 * remain. Two verbs, two verbatim sentences: 'cannot demote the last admin'
 * (profiles.update) and 'cannot remove the last admin' (profiles.remove). */
export async function assertNotLastAdmin(
  ctx: QueryCtx,
  subject: Doc<'profiles'>,
  action: 'demote' | 'remove',
): Promise<void> {
  const seats = ctx.db.query('profiles').withIndex('by_org', (q) => q.eq('org_id', subject.org_id))
  for await (const p of seats) {
    if (p.org_role === 'admin' && p.active && p.id !== subject.id) return
  }
  throw rule(`cannot ${action} the last admin`)
}

/* ---------------------------------------------------- plannable hours (0103)
 * set_plannable_hours' rule body (0094→0095→0099→0103), ONE copy shared by
 * the browser mutation (profiles.setPlannableHours) and MCP's update_user.
 * Order matters — rights first with ONE sentence for unknown/foreign/
 * unauthorized (0049), the agent check AFTER it so probing uuids learns
 * nothing, then the whole-hours range. Deliberately not self-service (0094).
 * No narration. Returns the fresh row (MCP answers with it). */
export async function setPlannableHoursCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; profile_id: string; hours: number },
): Promise<Doc<'profiles'>> {
  const rights = rule(
    "only an organization admin or a leader of one of this person's teams can set their plannable hours",
  )
  const target = await byId(ctx, 'profiles', a.profile_id)
  if (target === null || target.org_id !== a.me.org_id) throw rights
  if (a.me.org_role !== 'admin') {
    // the SQL's raw membership join — a leader row, no viewer fence of its
    // own (a viewer never holds one, 0102's WITH CHECK)
    let leads = false
    const memberships = ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', target.id))
    for await (const tm of memberships) {
      const mine = await ctx.db
        .query('team_members')
        .withIndex('by_team_profile', (q) => q.eq('team_id', tm.team_id).eq('profile_id', a.me.id))
        .unique()
      if (mine?.is_leader) {
        leads = true
        break
      }
    }
    if (!leads) throw rights
  }
  if (target.kind === 'agent') {
    throw rule('an agent has no plannable week — its capacity is unbounded')
  }
  const h = Math.round(Number(a.hours) || 0)
  if (h < 1 || h > 168) {
    throw rule('plannable hours must be a whole number of hours from 1 to 168')
  }
  await ctx.db.patch(target._id, { plannable_hours: h })
  return (await ctx.db.get(target._id)) as Doc<'profiles'>
}

/* teams_last_guard (0078:356-370): a team may only be deleted while another
 * team exists in its org. teams.deleteDeep calls it before the cascade. */
export async function assertNotLastTeam(ctx: QueryCtx, team: Doc<'teams'>): Promise<void> {
  const teams = ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', team.org_id))
  for await (const other of teams) {
    if (other.id !== team.id) return
  }
  throw rule('cannot delete the last team')
}

/* --------------------------------------------------------------- week labels
 * src/lib/dates.ts:114-141 ported for server-owned milestone narration
 * (`at W20, 12 May`), computed against the SUBJECT org's week_start /
 * week_one_rule / date_format — the old client used the display org's, a
 * minor drift fixed here. The stored detail is frozen at write
 * time; historical rows never re-render, so grid-at-write-time is correct.
 *
 * All arithmetic is UTC-midnight day math. The client did the same on LOCAL
 * midnights; day-granular answers are timezone-invariant given one consistent
 * zone, and UTC has no DST hour for Math.round to absorb. */

const DAY = 86400000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* Which week is week 1 of the year — week 1 is the first week with at least
 * minDays days in the new year, i.e. the week containing Jan (minDays). */
const WEEK_ONE_MIN_DAYS: Record<string, number> = { jan1: 1, first4day: 4, firstfull: 7 }

export type WeekSettings = Pick<
  Doc<'organizations'>,
  'week_start' | 'week_one_rule' | 'date_format'
>

/* setWeekConfig's coercions (dates.ts:68-75): out-of-range settings fall back
 * to ISO 8601 Monday + first4day rather than throwing — narration must not
 * fail on values an older validator let in (withOrg's 'iso' date_format). */
const weekStartDay = (s: WeekSettings): number =>
  Number.isFinite(s.week_start) && s.week_start >= 0 && s.week_start <= 6
    ? Math.round(s.week_start)
    : 1

const minDays = (s: WeekSettings): number => WEEK_ONE_MIN_DAYS[s.week_one_rule] ?? 4

const parseISODate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
}

/* First day of d's week — the org's week-start day (dates.ts weekStartOf). */
const weekStartOf = (d: Date, startDay: number): Date =>
  new Date(d.getTime() - ((d.getUTCDay() - startDay + 7) % 7) * DAY)

const week1Start = (year: number, s: WeekSettings): Date =>
  weekStartOf(new Date(Date.UTC(year, 0, minDays(s))), weekStartDay(s))

/* Calendar week number of the week STARTING at `start` under the org's rule.
 * The week-year can differ from the start date's year around New Year — a
 * Dec–Jan straddler may already be week 1 of the new year (ISO semantics). */
export function weekNumberOf(start: Date, s: WeekSettings): { year: number; num: number } {
  const end = new Date(start.getTime() + 6 * DAY)
  let year = end.getUTCFullYear()
  if (start.getTime() < week1Start(year, s).getTime()) year = start.getUTCFullYear()
  return {
    year,
    num: Math.round((start.getTime() - week1Start(year, s).getTime()) / (7 * DAY)) + 1,
  }
}

/* Compact day+month in the org's day/month order (dates.ts fmtDate): only the
 * two month-first formats flip; every other value reads day-first. */
export function fmtDate(d: Date, dateFormat: string): string {
  const monthFirst = dateFormat === 'MM/DD/YYYY' || dateFormat === 'MMM D, YYYY'
  return monthFirst
    ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
    : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/* `W20, 12 May` for a stored milestone week (an ISO week-start date). An
 * unaligned date — the org's week settings may have moved since the write —
 * floors to its week's first day, the client's isoToWeek round trip. */
export function weekLabel(weekISO: string, s: WeekSettings): string {
  const start = weekStartOf(parseISODate(weekISO), weekStartDay(s))
  return `W${weekNumberOf(start, s).num}, ${fmtDate(start, s.date_format)}`
}
