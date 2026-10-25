/* The reads behind an organization's monthly usage (usage.ts), and the
 * few rows Qivo writes for it.
 *
 * Every figure except mail comes from rows Qivo already keeps, read one
 * bounded page at a time, so measuring adds no write to the paths it
 * measures. Mail has no other record, so each letter the provider accepts
 * adds one to a usage_counts row (countUsage). Webhook deliveries are
 * deleted a week after they finish, so the retention sweep (webhooks.ts)
 * adds the ones it deletes to usage_counts by the month they finished, and
 * a month's count is those plus the deliveries still stored. Better Auth
 * deletes a sign-in session at sign-out, so the months a deleted session
 * was used in are kept as usage_sign_ins rows (keepSignIns).
 *
 * Each page function reads at most USAGE_PAGE of one range and returns
 * where the next page starts. They are plain functions over a QueryCtx;
 * usage.ts wraps them in internal queries. */

import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { getBillableUsers } from '../lib/billableUsers'
import { deletionBegun, subscriptionFor } from '../lib/billingAccess'
import { isDemoDeployment } from '../lib/demo'
import {
  DAY_MS,
  monthOf,
  monthRange,
  monthsBetween,
  ORG_METRICS,
  overlapShare,
  PERSON_FILES,
  PERSON_MAIL,
  type PersonMail,
  retentionCutoff,
  type UsageCounts,
  type UsageMetric,
} from '../lib/usage'
import { usageKeyRanges, usagePeriod } from './billingUsage'
import { countersRow } from './orgs'

/** Rows per page and the bytes one page's range may read. Tests lower them. */
export const USAGE_PAGE = {
  /** Organizations one step of the monthly job handles. */
  orgs: 50,
  /** Activity, attachment, Deleted items, delivery and API usage rows. */
  rows: 2000,
  /** Profiles, each with its picture and up to SESSION_PAGES reads of its
   * login's sessions. */
  profiles: 50,
  /** Tasks, each with one read of its comments stored since the month began. */
  issues: 200,
  /** Comments read with their task; a task with more is paged on its own. */
  comments: 50,
  /** Bytes the paged range of one page may read. */
  bytes: 8 * 1024 * 1024,
  /** Bytes of comments one page of tasks may read, by docBytes, before the
   * rest of its tasks are paged on their own. */
  commentBytes: 4 * 1024 * 1024,
}

/** An upper bound of a document's size: no UTF-16 unit takes more than 3
 * bytes in UTF-8. */
const docBytes = (doc: object): number => JSON.stringify(doc).length * 3

/** The organization `orgId` while it exists and its deletion has not begun. */
async function liveOrg(ctx: QueryCtx, orgId: string): Promise<boolean> {
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_uuid', (q) => q.eq('id', orgId))
    .unique()
  return org !== null && !(await deletionBegun(ctx, orgId))
}

/** The usage_counts row of one organization, or none, month and metric. */
const countRow = (ctx: QueryCtx, orgId: string | undefined, month: string, metric: UsageMetric) =>
  ctx.db
    .query('usage_counts')
    .withIndex('by_org_month_metric', (q) =>
      q.eq('org_id', orgId).eq('month', month).eq('metric', metric),
    )
    .unique()

/** Adds `n` to one usage_counts row of the month `at` falls in. Leave out
 * `org_id` for mail that belongs to a person. Counts nothing on the demo
 * deployment, whose organizations are deleted without their usage, or for
 * an organization that is gone or whose deletion has begun, which may
 * already have deleted its counts. */
export async function countUsage(
  ctx: MutationCtx,
  a: { org_id?: string; metric: UsageMetric; at?: number; n?: number },
): Promise<void> {
  const n = a.n ?? 1
  if (n <= 0 || isDemoDeployment()) return
  if (a.org_id !== undefined && !(await liveOrg(ctx, a.org_id))) return
  const month = monthOf(a.at ?? Date.now())
  const row = await countRow(ctx, a.org_id, month, a.metric)
  if (row) await ctx.db.patch(row._id, { count: row.count + n })
  else
    await ctx.db.insert('usage_counts', {
      ...(a.org_id === undefined ? {} : { org_id: a.org_id }),
      month,
      metric: a.metric,
      count: n,
    })
}

/** Stores the bytes of account backgrounds when `month`'s rows were
 * stored, replacing an earlier value. */
export async function setPersonFiles(ctx: MutationCtx, month: string, bytes: number) {
  const row = await countRow(ctx, undefined, month, PERSON_FILES)
  if (row) await ctx.db.patch(row._id, { count: bytes })
  else await ctx.db.insert('usage_counts', { month, metric: PERSON_FILES, count: bytes })
}

/** The bytes of account backgrounds stored with `month`, or null. */
export async function storedPersonFiles(ctx: QueryCtx, month: string): Promise<number | null> {
  return (await countRow(ctx, undefined, month, PERSON_FILES))?.count ?? null
}

/** Keeps the months a sign-in session of login `authUserId` was used in,
 * from its creation to its last refresh, as Better Auth deletes it.
 * Months older than retention keeps are left out, so a session holds at
 * most about 27. Nothing is kept on the demo deployment. */
export async function keepSignIns(
  ctx: MutationCtx,
  authUserId: string,
  session: { createdAt: number; updatedAt: number },
  now: number,
): Promise<void> {
  if (isDemoDeployment()) return
  const oldest = monthRange(retentionCutoff(now))?.start ?? now
  const months = monthsBetween(
    Math.max(session.createdAt, oldest),
    Math.min(session.updatedAt, now),
  )
  for (const month of months) {
    const kept = await ctx.db
      .query('usage_sign_ins')
      .withIndex('by_user_month', (q) => q.eq('auth_user_id', authUserId).eq('month', month))
      .first()
    if (kept === null) await ctx.db.insert('usage_sign_ins', { auth_user_id: authUserId, month })
  }
}

/** Deletes the kept sign-in months of a deleted login. Retention keeps
 * about 27, so one transaction holds them all. */
export async function forgetSignIns(ctx: MutationCtx, authUserId: string): Promise<void> {
  for (const row of await ctx.db
    .query('usage_sign_ins')
    .withIndex('by_user_month', (q) => q.eq('auth_user_id', authUserId))
    .collect())
    await ctx.db.delete(row._id)
}

/** The usage_runs row of `month`, or null. */
export const runRow = (ctx: QueryCtx, month: string) =>
  ctx.db
    .query('usage_runs')
    .withIndex('by_month', (q) => q.eq('month', month))
    .unique()

/** Writes the usage_runs row of `month`, seen now, unless it has one. */
export async function seeMonth(ctx: MutationCtx, month: string, now: number): Promise<void> {
  if ((await runRow(ctx, month)) === null)
    await ctx.db.insert('usage_runs', { month, seen_at: now })
}

/** What the page says about a month beside its rows: whether its counters
 * may have missed part of it, and how the run that stores it went. */
export type MonthStatus = {
  /** Mail, deleted webhook deliveries and ended sign-in sessions were
   * counted only from some time in the month, or after it: the usage job
   * first saw the month after its first day, or never. */
  partial: boolean
  /** The run that stored the closed month, null when none ran. */
  run: { saved: number; failed: number; finished_at: string | null } | null
}

/** The status of `month` from its usage_runs row, or of a month without
 * one. */
export function monthStatus(row: Doc<'usage_runs'> | null, month: string): MonthStatus {
  const start = monthRange(month)?.start ?? 0
  return {
    partial: row === null || row.seen_at >= start + DAY_MS,
    run:
      row?.run === undefined
        ? null
        : {
            saved: row.saved ?? 0,
            failed: row.failed ?? 0,
            finished_at:
              row.finished_at === undefined ? null : new Date(row.finished_at).toISOString(),
          },
  }
}

/** A month's start and end in milliseconds and as ISO text. */
export type Span = { start: number; end: number; from: string; to: string }

/** The span of `month`, or null for a key that is not a month. */
export function monthSpan(month: string): Span | null {
  const range = monthRange(month)
  if (range === null) return null
  return {
    ...range,
    from: new Date(range.start).toISOString(),
    to: new Date(range.end).toISOString(),
  }
}

/** A REST and MCP usage bucket (billing_usage period_start) and the share of
 * its calls that falls in the month. */
export type ApiBucket = { key: string; share: number }

/** The figures of one organization read in one transaction, or null once it
 * is gone or its deletion has begun. */
export type UsageHead = {
  billable: number
  active_tasks: number | null
  live_projects: number | null
  counted: Pick<UsageCounts, (typeof ORG_METRICS)[number]>
  buckets: ApiBucket[]
  api_estimated: boolean
}

/**
 * The buckets that hold the month's REST and MCP calls. A month without a
 * paid period has its own bucket, `month:YYYY-MM`, whose calls all count. A
 * paid or pending period (billing_usage_totals) has its own key and may
 * cross the month's start or end. Its calls are then split by time, as if
 * they came at an even rate over the part of the period that has passed,
 * and `estimated` says so.
 *
 * A bucket with no recorded end, such as a pending interval that was never
 * adopted or an old one keyed by complimentary_start, runs to now while it
 * is the bucket calls go to now. Otherwise it ends where the next known
 * period starts (another bucket, a recorded period, the subscription's
 * current period or its end), and without one its calls count in the month
 * it began, so they never spread into months it did not reach.
 */
export async function apiBuckets(
  ctx: QueryCtx,
  orgId: string,
  month: string,
  span: Span,
  now: number,
): Promise<{ buckets: ApiBucket[]; estimated: boolean }> {
  const buckets: ApiBucket[] = [{ key: `month:${month}`, share: 1 }]
  // One row per paid or pending period, so an organization has few.
  const totals = await ctx.db
    .query('billing_usage_totals')
    .withIndex('by_org_period', (q) => q.eq('org_id', orgId))
    .collect()
  const sub = await subscriptionFor(ctx, orgId)
  const keys = totals.map((row) => row.period_start)
  const ranges = await usageKeyRanges(ctx, orgId, sub, keys)
  const boundaries = ranges.some((range) => range.end === null)
    ? await knownStarts(ctx, orgId, sub, keys)
    : []
  const current = usagePeriod(sub, now).key
  let estimated = false
  ranges.forEach((range, i) => {
    const from = Date.parse(range.start)
    if (Number.isNaN(from)) return
    const next = boundaries.find((at) => at > from)
    const end =
      range.end !== null ? Date.parse(range.end) : keys[i] === current ? now : (next ?? from)
    const share = overlapShare(from, Math.min(end, now), span.start, span.end)
    if (share <= 0) return
    // An open bucket without a known end is placed in its first month.
    if (share < 1 || (range.end === null && keys[i] !== current && next === undefined))
      estimated = true
    buckets.push({ key: keys[i], share })
  })
  return { buckets, estimated }
}

/** The instants, ascending, where a usage bucket of organization `orgId`
 * can begin or its subscription ended: its other bucket keys, its recorded
 * periods' starts and the subscription's current period start and end. */
async function knownStarts(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  keys: readonly string[],
): Promise<number[]> {
  const periods = await ctx.db
    .query('billing_periods')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return [
    ...keys,
    ...periods.map((row) => row.period_start),
    sub?.current_period_start,
    sub?.ended_at,
  ]
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at) => !Number.isNaN(at))
    .sort((a, b) => a - b)
}

/** The organization's seats, counters, counted mail and webhook deliveries
 * and API buckets for `month`. */
export async function usageHead(
  ctx: QueryCtx,
  orgId: string,
  month: string,
  now: number,
): Promise<UsageHead | null> {
  const span = monthSpan(month)
  if (span === null) return null
  if (!(await liveOrg(ctx, orgId))) return null
  const { total } = await getBillableUsers(ctx, orgId)
  const counters = await countersRow(ctx, orgId)
  const counting = counters?.counted !== undefined
  const counted = Object.fromEntries(
    ORG_METRICS.map((metric) => [metric, 0]),
  ) as UsageHead['counted']
  for (const metric of ORG_METRICS)
    counted[metric] = (await countRow(ctx, orgId, month, metric))?.count ?? 0
  const { buckets, estimated } = await apiBuckets(ctx, orgId, month, span, now)
  return {
    billable: total,
    active_tasks: counting ? null : (counters?.active_tasks ?? null),
    live_projects: counting ? null : (counters?.live_projects ?? null),
    counted,
    buckets,
    api_estimated: estimated,
  }
}

/** The webhook deliveries of `month` the retention sweep has deleted so
 * far, and the requests they took. */
export async function retainedDeliveries(ctx: QueryCtx, orgId: string, month: string) {
  return {
    deliveries: (await countRow(ctx, orgId, month, 'webhook_deliveries'))?.count ?? 0,
    attempts: (await countRow(ctx, orgId, month, 'webhook_attempts'))?.count ?? 0,
  }
}

/** Mail sent to people rather than for an organization in `month`. */
export async function personMail(ctx: QueryCtx, month: string): Promise<PersonMail> {
  const mail = Object.fromEntries(PERSON_MAIL.map((metric) => [metric, 0])) as PersonMail
  for (const metric of PERSON_MAIL)
    mail[metric] = (await countRow(ctx, undefined, month, metric))?.count ?? 0
  return mail
}

type Cursor = string | null
type Paged = { page: unknown[]; isDone: boolean; continueCursor: string }
const nextOf = (page: Paged): Cursor => (page.isDone ? null : page.continueCursor)

/** A count per profile, as a list so a page with many people stays under
 * Convex's 1,024 fields per object. */
export type PerPerson = { id: string; n: number }[]

const tally = (map: Map<string, number>, id: string | undefined, n = 1) => {
  if (id !== undefined) map.set(id, (map.get(id) ?? 0) + n)
}
const listOf = (map: Map<string, number>): PerPerson => [...map].map(([id, n]) => ({ id, n }))

type Session = { createdAt: number; updatedAt: number }
type Sessions = { page: Session[]; isDone: boolean; continueCursor: string }

/** Whether login `authUserId` had a sign-in session created before the
 * month ended and created or refreshed after it began: an ended one kept by
 * keepSignIns, or one still stored. It reads the stored sessions newest
 * first through the userId index, skipping the ones created after the
 * month, and checks at most SESSIONS_READ older ones; a bound on updatedAt
 * would make the adapter scan the whole table, as no index has it. Better
 * Auth keeps a session that expired until its cookie is presented, so a
 * login can hold many; a month further back than its newest SESSIONS_READ
 * sessions before the month's end can then miss one still stored. */
async function signedIn(ctx: QueryCtx, authUserId: string, span: Span): Promise<boolean> {
  const kept = await ctx.db
    .query('usage_sign_ins')
    .withIndex('by_user_month', (q) =>
      q.eq('auth_user_id', authUserId).eq('month', monthOf(span.start)),
    )
    .first()
  if (kept !== null) return true
  let cursor: Cursor = null
  let checked = 0
  for (let read = 0; read < SESSION_PAGES; read++) {
    const sessions = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'session',
      where: [{ field: 'userId', value: authUserId }],
      sortBy: { field: 'createdAt', direction: 'desc' },
      paginationOpts: { numItems: SESSIONS_READ, cursor },
    })) as Sessions
    for (const s of sessions.page) {
      if (s.createdAt >= span.end) continue
      if (s.updatedAt >= span.start) return true
      if (++checked >= SESSIONS_READ) return false
    }
    if (sessions.isDone) return false
    cursor = sessions.continueCursor
  }
  return false
}

/** Sessions read per page of a login's sessions, and the most created
 * before the month's end that one check reads. */
const SESSIONS_READ = 50
/** Pages of a login's sessions one check reads at most, so the sessions
 * created after the month cannot make a profiles page read without bound. */
const SESSION_PAGES = 4

/** Whether profile `p` held its seat in the month with its login: it is
 * active, and was created or claimed before the month ended. A seat that
 * was deactivated counts only through its changes, comments and calls. */
const seatHeld = (p: Doc<'profiles'>, span: Span) =>
  p.active && (p.accepted_at ?? p.created_at) < span.to

/** One page of profiles: guests and agents among the active ones, the
 * bytes of their pictures, and the ones signed in during the month. */
export async function profilesPage(ctx: QueryCtx, orgId: string, span: Span, cursor: Cursor) {
  const page = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.profiles, maximumBytesRead: USAGE_PAGE.bytes })
  let guests = 0
  let agents = 0
  let avatar_bytes = 0
  const active: string[] = []
  for (const p of page.page) {
    if (p.active && p.org_role === 'guest') guests += 1
    if (p.active && p.kind === 'agent') agents += 1
    if (p.avatar_storage_id !== undefined)
      avatar_bytes += (await ctx.db.system.get(p.avatar_storage_id))?.size ?? 0
    if (
      p.auth_user_id !== undefined &&
      seatHeld(p, span) &&
      (await signedIn(ctx, p.auth_user_id, span))
    )
      active.push(p.id)
  }
  return { guests, agents, avatar_bytes, active, next: nextOf(page) }
}

/** One page of the month's activity rows, with the changes per actor. */
export async function activityPage(ctx: QueryCtx, orgId: string, span: Span, cursor: Cursor) {
  const page = await ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', orgId).gte('ts', span.from).lt('ts', span.to))
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  const actors = new Map<string, number>()
  for (const row of page.page) tally(actors, row.actor_id)
  return { changes: page.page.length, by_actor: listOf(actors), next: nextOf(page) }
}

/* A task's comments stored since the month began. A comment counts in the
 * month its created_at names. Restoring a task from Deleted items stores its
 * comments again with their old created_at, so they do not count twice, and
 * seeded comments with a back-dated created_at count in their month. */
const taskComments = (ctx: QueryCtx, taskId: string, span: Span) =>
  ctx.db
    .query('comments')
    .withIndex('by_issue', (q) => q.eq('issue_id', taskId).gte('_creationTime', span.start))

const commentIn = (comment: Doc<'comments'>, span: Span) =>
  comment.created_at >= span.from && comment.created_at < span.to

/**
 * One page of the organization's tasks with their comments in the month,
 * and the comments per author. Comments name no organization, so the page
 * goes through the tasks, active and archived. A task with more than
 * USAGE_PAGE.comments comments stored since the month began, and every task
 * after the page's comments reach USAGE_PAGE.commentBytes, is named in
 * `deferred` and paged on its own (taskCommentsPage). So the tasks (half of
 * USAGE_PAGE.bytes), the comments and the one task read past the budget
 * stay well under the 16 MiB a transaction may read. Tasks in Deleted items
 * are left out with their comments.
 */
export async function commentsPage(ctx: QueryCtx, orgId: string, span: Span, cursor: Cursor) {
  const page = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.issues, maximumBytesRead: USAGE_PAGE.bytes / 2 })
  const authors = new Map<string, number>()
  const deferred: string[] = []
  let comments = 0
  let bytes = 0
  for (const task of page.page) {
    if (bytes >= USAGE_PAGE.commentBytes) {
      deferred.push(task.id)
      continue
    }
    const rows = await taskComments(ctx, task.id, span).take(USAGE_PAGE.comments + 1)
    for (const row of rows) bytes += docBytes(row)
    if (rows.length > USAGE_PAGE.comments) {
      deferred.push(task.id)
      continue
    }
    for (const row of rows)
      if (commentIn(row, span)) {
        comments += 1
        tally(authors, row.author)
      }
  }
  return { comments, by_author: listOf(authors), deferred, next: nextOf(page) }
}

/** One page of one task's comments stored since the month began. */
export async function taskCommentsPage(ctx: QueryCtx, taskId: string, span: Span, cursor: Cursor) {
  const page = await taskComments(ctx, taskId, span).paginate({
    cursor,
    numItems: USAGE_PAGE.rows,
    maximumBytesRead: USAGE_PAGE.bytes,
  })
  const authors = new Map<string, number>()
  let comments = 0
  for (const row of page.page)
    if (commentIn(row, span)) {
      comments += 1
      tally(authors, row.author)
    }
  return { comments, by_author: listOf(authors), next: nextOf(page) }
}

/** One page of one API bucket's rows, with each credential's calls. */
export async function apiPage(ctx: QueryCtx, orgId: string, key: string, cursor: Cursor) {
  const page = await ctx.db
    .query('billing_usage')
    .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', key))
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  return {
    rows: page.page.map((row) => ({
      profile_id: row.profile_id,
      credential_id: row.credential_id,
      credential_name: row.credential_name,
      calls: row.calls,
    })),
    next: nextOf(page),
  }
}

/** One page of the organization's task attachments: description images
 * apart from other files. Every stored row counts, rows of tasks whose
 * project is gone included. */
export async function filesPage(ctx: QueryCtx, orgId: string, cursor: Cursor) {
  const page = await ctx.db
    .query('issue_attachments')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  let file_bytes = 0
  let image_bytes = 0
  for (const row of page.page)
    if (row.inline) image_bytes += row.size_bytes
    else file_bytes += row.size_bytes
  return { file_bytes, image_bytes, next: nextOf(page) }
}

/** One page of the organization's Deleted items rows, with the bytes of the
 * attachments among them. */
export async function deletedPage(ctx: QueryCtx, orgId: string, cursor: Cursor) {
  const page = await ctx.db
    .query('deleted_rows')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  let deleted_file_bytes = 0
  for (const stored of page.page)
    if (stored.row.table === 'issue_attachments') deleted_file_bytes += stored.row.doc.size_bytes
  return { deleted_file_bytes, next: nextOf(page) }
}

/** One page of the organization's stored webhook deliveries, counting the
 * ones that finished in the month and the requests they took. The rows the
 * retention sweep already deleted are in usage_counts. */
export async function webhooksPage(ctx: QueryCtx, orgId: string, span: Span, cursor: Cursor) {
  const page = await ctx.db
    .query('webhook_deliveries')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  let deliveries = 0
  let attempts = 0
  for (const row of page.page) {
    const done = row.completed_at
    if (done === undefined || done < span.start || done >= span.end) continue
    deliveries += 1
    attempts += row.attempts
  }
  return { deliveries, attempts, next: nextOf(page) }
}

/** One page of every login's account backgrounds, with the bytes of each
 * image and its preview. They belong to a login, not an organization. */
export async function backgroundsPage(ctx: QueryCtx, cursor: Cursor) {
  const page = await ctx.db
    .query('custom_backgrounds')
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  let bytes = 0
  for (const row of page.page) {
    bytes += row.byte_size
    if (row.preview_storage_id !== undefined)
      bytes += (await ctx.db.system.get(row.preview_storage_id))?.size ?? 0
  }
  return { bytes, next: nextOf(page) }
}

/** Adds the webhook deliveries the retention sweep is about to delete to
 * their organizations' counts, by the month each finished. */
export async function countDeletedDeliveries(
  ctx: MutationCtx,
  rows: readonly Doc<'webhook_deliveries'>[],
): Promise<void> {
  const groups = new Map<
    string,
    { org_id: string; at: number; deliveries: number; attempts: number }
  >()
  for (const row of rows) {
    if (row.completed_at === undefined) continue
    const key = `${row.org_id} ${monthOf(row.completed_at)}`
    const group = groups.get(key) ?? {
      org_id: row.org_id,
      at: row.completed_at,
      deliveries: 0,
      attempts: 0,
    }
    group.deliveries += 1
    group.attempts += row.attempts
    groups.set(key, group)
  }
  for (const { org_id, at, deliveries, attempts } of groups.values()) {
    await countUsage(ctx, { org_id, metric: 'webhook_deliveries', at, n: deliveries })
    await countUsage(ctx, { org_id, metric: 'webhook_attempts', at, n: attempts })
  }
}
