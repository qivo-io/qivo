/* Organization internals: initials, the slug machinery, the org counters,
 * the new-org/starter-team defaults and the org guards:
 *
 *   nameInitials     fold, THEN cut to two
 *   cleanOrgName     the organization name's length cap
 *   slug machinery   the generator, the shape check and the reserved-word
 *                    list (the reserved word is `qivo`)
 *   counters         the per-org issue and project numbers (org_counters),
 *                    and the helpers that insert an organization with its
 *                    org_counters and org_ready rows and delete them
 *   live counts      the active tasks and live projects the app's windows
 *                    read (org_counters), kept by tallyRow, which also
 *                    moves the label usage counts (model/labelCounts.ts)
 *   column defaults  including the organization-wide upload cap
 *   last admin       an org may never lose its last admin
 *   last team        an org may never lose its last team
 *   slug narration   organizations_slug_narrate (0108)
 *   week labels      src/lib/dates.ts:114-141 (fmtDate/weekNumberOf), for
 *                    server-owned milestone narration
 *
 * Plain async functions over ctx — no wrappers, no auth: callers hold the
 * refusal posture. The guards throw `rule` refusals themselves; internal
 * seed/reset mutations simply do not call them. */

import type { WithoutSystemFields } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { isTeamLeader } from '../lib/access'
import { byId } from '../lib/db'
import { trimmedForm } from '../lib/fieldPrints'
import { conflict, notFound, require, rule } from '../lib/functions'
import { limitedText, limitedWhole } from '../lib/limitRules'
import { LIMITS, SLUG_SHAPE } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { DEFAULT_PLANNABLE_HOURS } from '../lib/workload'
import { logActivity } from './activity'
import {
  assertExpected,
  exact,
  type Fields,
  filledText,
  NUMBER,
  NUMBER_OR_NULL,
  TEXT,
  TEXT_OR_NULL,
} from './expected'
import {
  insertLabelCount,
  labelCountRun,
  type TaskAfter,
  type TaskBefore,
  tallyTaskLabels,
} from './labelCounts'
import { readyRow } from './nameKeys'
import { assertProfileExpected } from './people'
import { deleteOrgTotals, startOrgTotals } from './storageTotals'
import { countingOrg, countMemberRemoved, insertTeamCount } from './teamCounts'

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

/* ---------------------------------------------------------------------- name */

/** An organization name as stored: trimmed, and refused past
 * LIMITS.orgName. Each caller refuses a blank name with its own sentence. */
export function cleanOrgName(raw: string): string {
  return limitedText(LIMITS.orgName, raw)
}

/** The keys of an organization's `expected` (model/expected.ts): its
 * settings and its address. */
export const ORG_FIELDS: Fields<Doc<'organizations'>> = {
  // cleanOrgName's rule
  name: { sends: 'name', type: filledText(LIMITS.orgName), form: trimmedForm },
  date_format: { sends: 'date_format', type: TEXT, form: exact },
  week_start: { sends: 'week_start', type: NUMBER, form: exact },
  week_one_rule: { sends: 'week_one_rule', type: TEXT, form: exact },
  default_plannable_hours: { sends: 'default_plannable_hours', type: NUMBER, form: exact },
  max_attachment_mb: { sends: 'max_attachment_mb', type: NUMBER_OR_NULL, form: exact },
  project_creators: { sends: 'project_creators', type: TEXT_OR_NULL, form: exact },
  slug: { sends: 'slug', type: TEXT, form: exact },
}

/** The app's `expected` for an organization edit. */
export const vOrgExpected = v.object({
  name: v.optional(v.string()),
  date_format: v.optional(v.string()),
  week_start: v.optional(v.number()),
  week_one_rule: v.optional(v.string()),
  default_plannable_hours: v.optional(v.number()),
  max_attachment_mb: v.optional(v.union(v.number(), v.null())),
  project_creators: v.optional(v.union(v.string(), v.null())),
  slug: v.optional(v.string()),
})

/** Refuses an organization edit over a setting someone else changed since
 * `expected` was read. `next` holds what the edit stores for each key. */
export async function assertOrgExpected(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    org: Doc<'organizations'>
    expected: Readonly<Record<string, unknown>> | undefined
    next: Readonly<Record<string, unknown>>
  },
): Promise<void> {
  await assertExpected({
    read: { ctx, me: a.me, view: 'app' },
    fields: ORG_FIELDS,
    record: 'organization',
    id: a.org.id,
    label: 'the organization',
    row: a.org,
    expected: a.expected,
    next: a.next,
  })
}

/* ---------------------------------------------------------------------- slug
 * One constant serves the validator AND the generator — the SQL carried two
 * copies (a privilege constraint on CHECK expressions) and proved them equal;
 * here the duplication simply does not exist. List verbatim from 0107. */
const RESERVED_WORDS =
  'about|accept|account|accounts|admin|administrator|api|app|apps|archive|assets|auth|billing|blog|board|callback|cdn|changelog|checkout|confirm|contact|cookies|dashboard|demo|doc|docs|download|downloads|email|enterprise|faq|favicon|features|feed|ftp|graphql|help|home|images|img|inbox|integrations|internal|invite|invites|join|legal|login|logout|mail|mcp|me|media|new|news|notifications|oauth|onboarding|org|organization|organizations|orgs|overview|partners|payment|payments|plans|press|pricing|privacy|project|projects|public|qivo|register|rest|reset|roadmap|robots|root|search|security|settings|setup|share|shared|signin|signout|signup|sitemap|sso|static|status|subscribe|subscription|support|system|task|tasks|team|teams|terms|test|token|trial|upgrade|user|users|verify|webhook|webhooks|welcome|www'

export const RESERVED_SLUGS: ReadonlySet<string> = new Set(RESERVED_WORDS.split('|'))

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
  if (!SLUG_SHAPE.test(slug) || slug.length > LIMITS.slug.max) {
    const sentence = LIMITS.slug.refusal
    throw conflict(`${sentence[0].toUpperCase()}${sentence.slice(1)}`, 'slug_shape')
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw conflict('That address is reserved. Choose another.', 'slug_reserved')
  }
  const holder = await slugHolder(ctx, slug)
  if (holder !== null && holder.id !== owner) {
    throw conflict('That address is already taken. Choose another.', 'slug_taken')
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
 * issues_before_insert / projects_assign_num (0050/0100): bump the org's
 * counter and use the result as the row's num, inside the one mutation.
 * Convex serializes conflicting mutations (the row lock's successor), so
 * numbers are dense per org at assignment, never reused, and nothing else may
 * write the counters. They live in the org's org_counters row, not on the
 * organization row, so task and project creation do not conflict with the
 * many reads of the organization's settings. */

export type OrgCounters = Pick<Doc<'org_counters'>, 'next_issue_num' | 'next_project_num'>

/** The organization's org_counters row, or null if it has none. */
export const countersRow = (ctx: QueryCtx, orgId: string) =>
  ctx.db
    .query('org_counters')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()

/** The numbers of org_counters row `row`, zero without one. */
export const numbersOf = (row: Doc<'org_counters'> | null): OrgCounters => ({
  next_issue_num: row?.next_issue_num ?? 0,
  next_project_num: row?.next_project_num ?? 0,
})

/** The organization's counters, zero before its org_counters row exists. */
export async function countersOf(ctx: QueryCtx, org: Doc<'organizations'>): Promise<OrgCounters> {
  return numbersOf(await countersRow(ctx, org.id))
}

/** The organization's org_counters row, created zeroed on first use.
 * insertOrgRows creates it with the organization, so this only covers a row
 * that is missing anyway. A refused mutation rolls the insert back with
 * everything else. */
async function ensureCounters(ctx: MutationCtx, orgId: string): Promise<Doc<'org_counters'>> {
  const existing = await countersRow(ctx, orgId)
  if (existing !== null) return existing
  const id = await ctx.db.insert('org_counters', {
    org_id: orgId,
    next_issue_num: 0,
    next_project_num: 0,
  })
  const row = await ctx.db.get(id)
  require(row !== null, notFound('organization counters not found'))
  return row
}

/* The counters row is re-read through ensureCounters, so two bumps inside
 * one mutation chain instead of reusing a stale value. */
async function bump(
  ctx: MutationCtx,
  org: Doc<'organizations'>,
  field: keyof OrgCounters,
): Promise<number> {
  const row = await ensureCounters(ctx, org.id)
  const used = row[field] + 1
  await ctx.db.patch(row._id, { [field]: used })
  return used
}

export const nextIssueNum = (ctx: MutationCtx, org: Doc<'organizations'>): Promise<number> =>
  bump(ctx, org, 'next_issue_num')

export const nextProjectNum = (ctx: MutationCtx, org: Doc<'organizations'>): Promise<number> =>
  bump(ctx, org, 'next_project_num')

/** Sets the counters, for the demo seed and the Northstar wipe only. The
 * live counts follow the rows they write and delete (tallyRow). */
export async function setCounters(
  ctx: MutationCtx,
  org: Doc<'organizations'>,
  counters: OrgCounters,
): Promise<void> {
  const row = await ensureCounters(ctx, org.id)
  await ctx.db.patch(row._id, counters)
}

/** Inserts an organization with its org_counters row, its live counts at
 * zero, its org_ready row, ready from its creation because every writer
 * gives its rows their name keys (model/nameKeys.ts), and its stored-byte
 * totals at zero (model/storageTotals.ts). Every path that creates an
 * organization uses it; `counters` lets a fixture start numbering past rows
 * it plants, which it tallies (tallyRow). */
export async function insertOrgRows(
  ctx: MutationCtx,
  row: WithoutSystemFields<Doc<'organizations'>>,
  counters: OrgCounters = { next_issue_num: 0, next_project_num: 0 },
): Promise<Id<'organizations'>> {
  const id = await ctx.db.insert('organizations', row)
  await ctx.db.insert('org_counters', {
    org_id: row.id,
    ...counters,
    active_tasks: 0,
    live_projects: 0,
  })
  await ctx.db.insert('org_ready', { org_id: row.id, name_keys_at: row.created_at })
  await startOrgTotals(ctx, row.id)
  return id
}

/* ------------------------------------------------------------- live counts
 * org_counters active_tasks and live_projects count the rows the app's
 * windows read, which are the active tasks and the projects in the live
 * tables. Every write that inserts or deletes a task or project, or sets or
 * clears a task's archived_at, calls tallyRow in its transaction, except
 * model/cascade.ts deleteOrgDeep, which deletes the counters with the rows
 * in one transaction. An organization created before them has none until
 * internal/liveCountsBackfill counts it, and the app sizes its windows by
 * its numbers until then (lib/idWindows.ts startWindows). The counts share
 * the row with the numbers, so archives, restores and deletes in one
 * organization conflict with each other and with its creates, as its
 * creates already did, and Convex runs the one that lost again. A write of
 * tasks also moves the label usage counts of their labels
 * (model/labelCounts.ts tallyTaskLabels), which count the same active
 * tasks. */

export type LiveCounts = Pick<Doc<'org_counters'>, 'active_tasks' | 'live_projects'>

/** The live counts of org_counters row `row` as the app may use them:
 * none until they are counted, and none while a backfill counts them. */
export const liveCountsOf = (row: Doc<'org_counters'> | null): LiveCounts =>
  row?.counted === undefined && row?.active_tasks !== undefined && row.live_projects !== undefined
    ? { active_tasks: row.active_tasks, live_projects: row.live_projects }
    : {}

/** A task or project as tallyRow reads it. */
type Tallied = Pick<Doc<'issues'>, 'org_id' | 'num' | 'archived_at'>

/** One write of a task: the stored task before it, with its position for
 * the label counts, and the task after it. */
type TaskWrite = readonly [
  before: (Tallied & TaskBefore) | null,
  after: (Tallied & TaskAfter) | null,
]

/** One write of a project. */
type ProjectWrite = readonly [before: Tallied | null, after: Tallied | null]

/** Whether the windows read `row` of `table`, a task while it is active and
 * a project while it exists. */
const tallied = (table: 'issues' | 'projects', row: Tallied | null) =>
  row !== null && (table === 'projects' || row.archived_at === undefined)

/** Moves the organizations' live counts for writes to `table` that each
 * turned a `before` row into an `after` one, null for no row: an insert, a
 * delete, or a patch of archived_at (`after` as the row reads after the
 * patch). Reads each organization's counters once, and a write that changes
 * neither count costs nothing. Counts an organization has not got stay
 * absent, and while internal/liveCountsBackfill counts them, a row numbered
 * past where it has counted waits for the backfill. Writes of tasks also
 * move the counts of the labels the tasks carry when this runs
 * (model/labelCounts.ts tallyTaskLabels). An assignment a caller inserts or
 * deletes while its task is live moves them through tallyAssignment. */
export async function tallyRows(
  ctx: MutationCtx,
  table: 'issues',
  writes: readonly TaskWrite[],
): Promise<void>
export async function tallyRows(
  ctx: MutationCtx,
  table: 'projects',
  writes: readonly ProjectWrite[],
): Promise<void>
export async function tallyRows(
  ctx: MutationCtx,
  table: 'issues' | 'projects',
  writes: readonly (TaskWrite | ProjectWrite)[],
): Promise<void> {
  if (table === 'issues') await tallyTaskLabels(ctx, writes as readonly TaskWrite[])
  const field = table === 'issues' ? 'active_tasks' : 'live_projects'
  const kind = table === 'issues' ? 'tasks' : 'projects'
  const moves = new Map<string, { num: number; by: number }[]>()
  for (const [before, after] of writes) {
    const by = Number(tallied(table, after)) - Number(tallied(table, before))
    const row = after ?? before
    if (by === 0 || row === null) continue
    moves.set(row.org_id, [...(moves.get(row.org_id) ?? []), { num: row.num, by }])
  }
  for (const [orgId, rows] of moves) {
    const counters = await countersRow(ctx, orgId)
    const now = counters?.[field]
    if (counters === null || now === undefined) continue
    const through = counters.counted?.[kind] ?? Number.POSITIVE_INFINITY
    const by = rows.reduce((n, row) => (row.num > through ? n : n + row.by), 0)
    if (by !== 0) await ctx.db.patch(counters._id, { [field]: now + by })
  }
}

/** tallyRows for one write. */
export function tallyRow(
  ctx: MutationCtx,
  table: 'issues',
  before: TaskWrite[0],
  after: TaskWrite[1],
): Promise<void>
export function tallyRow(
  ctx: MutationCtx,
  table: 'projects',
  before: Tallied | null,
  after: Tallied | null,
): Promise<void>
export function tallyRow(
  ctx: MutationCtx,
  table: 'issues' | 'projects',
  before: TaskWrite[0] | Tallied | null,
  after: TaskWrite[1] | Tallied | null,
): Promise<void> {
  // the overloads above pair each table with its rows
  return table === 'issues'
    ? tallyRows(ctx, table, [[before, after] as TaskWrite])
    : tallyRows(ctx, table, [[before, after]])
}

/** Deletes the organization's org_counters and org_ready rows, its
 * stored-byte totals row (model/storageTotals.ts) and its running label
 * count (label_count_runs), if any. Every organization delete
 * (model/cascade.ts deleteOrgDeep, the last step of model/orgDeletion.ts,
 * the demo purge) calls it before it deletes the organization row. */
export async function deleteOrgBookkeeping(ctx: MutationCtx, orgId: string): Promise<void> {
  const counters = await countersRow(ctx, orgId)
  if (counters !== null) await ctx.db.delete(counters._id)
  const ready = await readyRow(ctx, orgId)
  if (ready !== null) await ctx.db.delete(ready._id)
  await deleteOrgTotals(ctx, orgId)
  const run = await labelCountRun(ctx, orgId)
  if (run !== null) await ctx.db.delete(run._id)
}

/* ------------------------------------------------------------------ defaults
 * The organizations column defaults (0020/0039/0050/0095). The counters
 * start in org_counters (insertOrgRows). */
export const newOrgDefaults = (now: string) => ({
  created_at: now,
  date_format: 'YYYY-MM-DD',
  week_start: 1,
  week_one_rule: 'first4day',
  default_plannable_hours: DEFAULT_PLANNABLE_HOURS,
  max_attachment_mb: LIMITS.attachmentLimit.max,
  // Retired and unread (schema.ts). Earlier releases' schemas require it, so
  // new organizations store false until no earlier release can be rolled
  // back to.
  gravatar_avatars: false,
})

/* The organization's upload cap in MiB, at most LIMITS.attachmentLimit.max.
 * The ceiling is a product and cost rule, not a technical limit: Qivo makes
 * it simple to add images and PDF files to tasks and is not a storage
 * service, so a larger file does not go onto Qivo. A row without a value
 * gets the ceiling. */
export const attachmentLimitMb = (org: Pick<Doc<'organizations'>, 'max_attachment_mb'> | null) =>
  Math.min(org?.max_attachment_mb ?? LIMITS.attachmentLimit.max, LIMITS.attachmentLimit.max)

/* The auto-archive threshold in days for Done tasks (jobs.ts). */
export const DEFAULT_ARCHIVE_DAYS = 30

/* A new team's settings: new projects track delay by default. */
export const newTeamDefaults = (now: string) => ({
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
    const id = newUuid()
    await ctx.db.insert('labels', {
      id,
      org_id,
      name: label.name,
      name_lower: label.name.toLowerCase(),
      color: label.color,
      created_at: now,
    })
    await insertLabelCount(ctx, { id, org_id })
  }
}

/* create_organization's tail (0118): every new organization gets a starter
 * team for its first workstream. Products themselves are team-less; the
 * creator becomes the initial product lead in the client flow. An operator
 * may create an organization before inviting anyone, so its team can start
 * without a leader. */
export async function createStarterTeam(
  ctx: MutationCtx,
  {
    org_id,
    name,
    leader,
    now,
  }: {
    org_id: string
    name: string
    leader: Pick<Doc<'profiles'>, 'id' | 'name'> | undefined
    now: string
  },
): Promise<string> {
  const teamId = newUuid()
  await ctx.db.insert('teams', { id: teamId, org_id, ...named(name), ...newTeamDefaults(now) })
  let members = 0
  if (leader !== undefined) {
    await ctx.db.insert('team_members', {
      team_id: teamId,
      profile_id: leader.id,
      is_leader: true,
      name_key: nameKey(leader.name),
    })
    // the leader as stored, whose role decides whether it counts
    if (countingOrg(await byId(ctx, 'profiles', leader.id)) === org_id) members = 1
  }
  await insertTeamCount(ctx, { id: teamId, org_id }, members)
  return teamId
}

/* A guest is never a team member (teams.addMember). When a seat becomes a
 * guest its memberships end, leadership included. A team may be left
 * without a leader; organization admins still run it (teams.setLeader).
 * `profile` is the seat as it was before the change, so the team counts
 * lose the memberships it counted in (model/teamCounts.ts). */
export async function leaveAllTeams(ctx: MutationCtx, profile: Doc<'profiles'>): Promise<void> {
  const rows = await ctx.db
    .query('team_members')
    .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
    .collect()
  for (const row of rows) {
    await ctx.db.delete(row._id)
    await countMemberRemoved(ctx, row, countingOrg(profile))
  }
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
 * the browser mutation (profiles.setPlannableHours), MCP's update_user and
 * REST's PATCH /v1/users/{id}.
 * Order matters — rights first with ONE sentence for unknown/foreign/
 * unauthorized (0049), the agent check AFTER it so probing uuids learns
 * nothing, then the whole-hours range. Deliberately not self-service (0094).
 * No narration. Returns the fresh row (MCP and REST answer with it). */

/* The rights refusal. REST answers it 403; the app and MCP show the rule. */
export const PLANNABLE_HOURS_RIGHTS =
  "only an organization admin or a leader of one of this person's teams can set their plannable hours"

export async function setPlannableHoursCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    profile_id: string
    hours: number
    /** The hours the caller read (model/people.ts PROFILE_FIELDS). */
    expected?: Readonly<Record<string, unknown>>
  },
): Promise<Doc<'profiles'>> {
  const rights = rule(PLANNABLE_HOURS_RIGHTS)
  const target = await byId(ctx, 'profiles', a.profile_id)
  if (target === null || target.org_id !== a.me.org_id) throw rights
  if (a.me.org_role !== 'admin') {
    // Leadership is the shared lib/access isTeamLeader, so leader rows held
    // by a guest, a viewer or an agent grant nothing. A guest is never a team
    // member, so a stale row gives no leader rights over them either. Same
    // sentence, so probing learns nothing.
    if (target.org_role === 'guest') throw rights
    let leads = false
    const memberships = ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', target.id))
    for await (const tm of memberships) {
      if (await isTeamLeader(ctx, a.me, tm.team_id)) {
        leads = true
        break
      }
    }
    if (!leads) throw rights
  }
  if (target.kind === 'agent') {
    throw rule('an agent has no plannable week, because its capacity is unbounded')
  }
  const h = limitedWhole(LIMITS.plannableHours, a.hours)
  // after the rules, so a request no check can let through says why
  await assertProfileExpected(ctx, {
    me: a.me,
    seat: target,
    expected: a.expected,
    next: { plannable_hours: h },
  })
  await ctx.db.patch(target._id, { plannable_hours: h })
  return (await ctx.db.get(target._id)) as Doc<'profiles'>
}

/** The refusal of deleting an organization's last team, with the next step. */
export const LAST_TEAM_RULE =
  'an organization needs at least one team; create another team before deleting this one'

/* teams_last_guard (0078:356-370): a team may only be deleted while another
 * team exists in its org. teams.deleteDeep calls it before the cascade. */
export async function assertNotLastTeam(ctx: QueryCtx, team: Doc<'teams'>): Promise<void> {
  const teams = ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', team.org_id))
  for await (const other of teams) {
    if (other.id !== team.id) return
  }
  throw rule(LAST_TEAM_RULE)
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

/** The days of the week by Date#getUTCDay number, as week_start counts them. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/* setWeekConfig's coercions (dates.ts:68-75): out-of-range settings fall back
 * to ISO 8601 Monday + first4day rather than throwing — narration must not
 * fail on values an older validator let in (withOrg's 'iso' date_format). */
const weekStartDay = (s: Pick<WeekSettings, 'week_start'>): number =>
  Number.isFinite(s.week_start) && s.week_start >= 0 && s.week_start <= 6
    ? Math.round(s.week_start)
    : 1

const minDays = (s: WeekSettings): number => WEEK_ONE_MIN_DAYS[s.week_one_rule] ?? 4

/* UTC midnight of day `d` of month `m` (0 to 11) of year `y`, overflowing
 * into the next month or year as Date does. Date.UTC would read the years 0
 * to 99 as 1900 to 1999. */
const utcDay = (y: number, m: number, d: number): Date => {
  const date = new Date(0)
  date.setUTCFullYear(y, m, d)
  return date
}

/* A YYYY-MM-DD day as the app reads it (dates.ts isoToDate): a day that does
 * not exist overflows, so 2026-02-31 is 3 March. Invalid for text that is
 * not three numbers. */
const parseISODate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return utcDay(y, (m ?? 1) - 1, d ?? 1)
}

/* First day of d's week — the org's week-start day (dates.ts weekStartOf). */
const weekStartOf = (d: Date, startDay: number): Date =>
  new Date(d.getTime() - ((d.getUTCDay() - startDay + 7) % 7) * DAY)

const week1Start = (year: number, s: WeekSettings): Date =>
  weekStartOf(utcDay(year, 0, minDays(s)), weekStartDay(s))

/* The YYYY-MM-DD text of a day, cut to the days a stored date can name. */
const isoDay = (d: Date): string =>
  d.getUTCFullYear() < 0
    ? '0000-01-01'
    : d.getUTCFullYear() > 9999
      ? '9999-12-31'
      : d.toISOString().slice(0, 10)

/** Real calendar day `day` moved by `days`, cut to 0000-01-01 and
 * 9999-12-31. */
export function shiftDay(day: string, days: number): string {
  return isoDay(new Date(parseISODate(day).getTime() + days * DAY))
}

/** The YYYY-MM-DD day the app shows stored text `day` on: the day itself,
 * or for a day that does not exist the day it overflows to (2026-02-31 is
 * 2026-03-03). Null for text that names no day at all. */
export function shownDay(day: string): string | null {
  const date = parseISODate(day)
  return Number.isFinite(date.getTime()) ? isoDay(date) : null
}

/**
 * The first and last day, YYYY-MM-DD, of the week that holds `day` when the
 * organization's weeks begin on its week_start. Two days share a week when
 * their `first` is the same. A day that does not exist, such as 2026-02-31,
 * which a milestone took until 2026-10-16, is read as the app shows it, the
 * day it overflows to (3 March). Null for text that names no day at all.
 * The weeks at either end of the dates YYYY-MM-DD can write are cut to
 * 0000-01-01 and 9999-12-31.
 */
export function weekDays(
  day: string,
  s: Pick<WeekSettings, 'week_start'>,
): { first: string; last: string } | null {
  const date = parseISODate(day)
  if (!Number.isFinite(date.getTime())) return null
  const start = weekStartOf(date, weekStartDay(s))
  return { first: isoDay(start), last: isoDay(new Date(start.getTime() + 6 * DAY)) }
}

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

/** A day with its year in the org's date format (dates.ts fmtFullWith):
 * `11 May 2026`, `05/11/2026` or `2026-05-11` for any format it does not
 * know. */
export function fmtFull(d: Date, dateFormat: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0')
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  const mm = p2(d.getUTCMonth() + 1)
  const dd = p2(d.getUTCDate())
  switch (dateFormat) {
    case 'DD/MM/YYYY':
      return `${dd}/${mm}/${y}`
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${y}`
    case 'DD.MM.YYYY':
      return `${dd}.${mm}.${y}`
    case 'D MMM YYYY':
      return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${y}`
    case 'MMM D, YYYY':
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${y}`
    default:
      return `${y}-${mm}-${dd}`
  }
}

/** A stored day in the org's date format, read as weekDays reads it. */
export function dayLabel(day: string, s: WeekSettings): string {
  return fmtFull(parseISODate(day), s.date_format)
}

/** `the week of 11 May 2026 (W20)`, the week that holds `day` in the org's
 * calendar, as a refusal names it: its first day in the org's date format
 * and its week number. */
export function weekPhrase(day: string, s: WeekSettings): string {
  const start = weekStartOf(parseISODate(day), weekStartDay(s))
  // the first week of year 0000 begins in year -1, which YYYY cannot write,
  // so it reads from 0000-01-01 as weekDays cuts it
  const first = start.getUTCFullYear() < 0 ? utcDay(0, 0, 1) : start
  return `the week of ${fmtFull(first, s.date_format)} (W${weekNumberOf(start, s).num})`
}
