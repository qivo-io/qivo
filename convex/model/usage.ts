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
 * was used in are kept as usage_sign_ins rows (lib/signIns.ts).
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
  type MonthBytes,
  monthOf,
  monthRange,
  ORG_METRICS,
  overlapShare,
  PERSON_MAIL,
  type PersonMail,
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
  /** Profiles, each with one read of its login's sessions and its picture. */
  profiles: 200,
  /** Sessions one read of a login's sessions takes past its first page. */
  sessions: 200,
  /** Tasks, each with one read of its comments stored since the month began. */
  issues: 200,
  /** Comments read with their task; a task with more is paged on its own.
   * Few enough that one task's read stays small even for comments stored
   * before the body limit, which can reach Convex's 1 MiB document limit. */
  comments: 5,
  /** Bytes the paged range of one page may read. */
  bytes: 8 * 1024 * 1024,
  /** Bytes of comments one page of tasks may read, by docBytes, before the
   * rest of its tasks are paged on their own. */
  commentBytes: 3 * 1024 * 1024,
}

const MIB = 1024 * 1024

/** The most one comments page may read, in bytes, at Convex's 1 MiB
 * document limit: its tasks, the comments within the budget and the last
 * task's first read. It must stay under the 16 MiB a transaction may read. */
export const pageReadBound = () =>
  USAGE_PAGE.bytes / 2 + MIB + USAGE_PAGE.commentBytes + (USAGE_PAGE.comments + 1) * MIB

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

/** Stores `bytes`, the total `metric` names (account backgrounds or held
 * files), when `month`'s rows were stored, replacing an earlier value. */
export async function setMonthBytes(
  ctx: MutationCtx,
  month: string,
  metric: MonthBytes,
  bytes: number,
) {
  const row = await countRow(ctx, undefined, month, metric)
  if (row) await ctx.db.patch(row._id, { count: bytes })
  else await ctx.db.insert('usage_counts', { month, metric, count: bytes })
}

/** The total `metric` names stored with `month`, or null. */
export async function storedMonthBytes(
  ctx: QueryCtx,
  month: string,
  metric: MonthBytes,
): Promise<number | null> {
  return (await countRow(ctx, undefined, month, metric))?.count ?? null
}

/** Kept months a last sign-in is looked for in, newest first: all that
 * retention keeps of one login, about 27. A session that is used every week
 * is refreshed and lives on, so its sign-in month can be far older than the
 * months it was used in last. */
const LAST_SIGN_IN_MONTHS = 30

/** When login `authUserId` last signed in among the sessions that have
 * ended, in ms, or null when none kept it (lib/signIns.ts keepSignIns). */
export async function keptSignInAt(ctx: QueryCtx, authUserId: string): Promise<number | null> {
  const rows = await ctx.db
    .query('usage_sign_ins')
    .withIndex('by_user_month', (q) => q.eq('auth_user_id', authUserId))
    .order('desc')
    .take(LAST_SIGN_IN_MONTHS)
  return rows.find((row) => row.signed_in_at !== undefined)?.signed_in_at ?? null
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

/** Whether login `authUserId` has a kept sign-in for the month: a session
 * that ended was used in it (lib/signIns.ts keepSignIns). */
async function keptSignIn(ctx: QueryCtx, authUserId: string, span: Span): Promise<boolean> {
  const kept = await ctx.db
    .query('usage_sign_ins')
    .withIndex('by_user_month', (q) =>
      q.eq('auth_user_id', authUserId).eq('month', monthOf(span.start)),
    )
    .first()
  return kept !== null
}

/**
 * One page of login `authUserId`'s stored sessions, newest first through
 * the userId index: whether one of them was created before the month ended
 * and created or refreshed after it began, and where the next page starts
 * while none was. A bound on updatedAt would make the adapter scan the whole
 * table, as no index has it. A login can hold many sessions, such as one
 * per device and expired ones the nightly cleanup has not deleted yet
 * (authRetention.ts), and every one is read until one matches.
 */
export async function sessionsPage(
  ctx: QueryCtx,
  authUserId: string,
  span: Span,
  cursor: Cursor,
  numItems: number,
): Promise<{ used: boolean; next: Cursor }> {
  const sessions = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'session',
    where: [{ field: 'userId', value: authUserId }],
    sortBy: { field: 'createdAt', direction: 'desc' },
    paginationOpts: { numItems, cursor },
  })) as Sessions
  const used = sessions.page.some((s) => s.createdAt < span.end && s.updatedAt >= span.start)
  return { used, next: used ? null : nextOf(sessions) }
}

/** Sessions read per login in a profiles page. A login with more is read
 * on, a page at a time (usage.ts sessions). */
const SESSIONS_READ = 50

/** Whether profile `p` held its seat in the month with its login: it is
 * active, and was created or claimed before the month ended. A seat that
 * was deactivated counts only through its changes, comments and calls. */
const seatHeld = (p: Doc<'profiles'>, span: Span) =>
  p.active && (p.accepted_at ?? p.created_at) < span.to

/** One page of profiles: guests and agents among the active ones, the
 * bytes of their pictures, the ones signed in during the month, and the
 * ones whose login holds more sessions than the page read, with where to
 * read on (`unsure`). */
export async function profilesPage(ctx: QueryCtx, orgId: string, span: Span, cursor: Cursor) {
  const page = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.profiles, maximumBytesRead: USAGE_PAGE.bytes })
  let guests = 0
  let agents = 0
  let avatar_bytes = 0
  const active: string[] = []
  const unsure: { id: string; auth_user_id: string; cursor: string }[] = []
  for (const p of page.page) {
    if (p.active && p.org_role === 'guest') guests += 1
    if (p.active && p.kind === 'agent') agents += 1
    if (p.avatar_storage_id !== undefined)
      avatar_bytes += (await ctx.db.system.get(p.avatar_storage_id))?.size ?? 0
    const login = p.auth_user_id
    if (login === undefined || !seatHeld(p, span)) continue
    if (await keptSignIn(ctx, login, span)) {
      active.push(p.id)
      continue
    }
    const first = await sessionsPage(ctx, login, span, null, SESSIONS_READ)
    if (first.used) active.push(p.id)
    else if (first.next !== null) unsure.push({ id: p.id, auth_user_id: login, cursor: first.next })
  }
  return { guests, agents, avatar_bytes, active, unsure, next: nextOf(page) }
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
 * USAGE_PAGE.bytes, plus the one that passes it), the comments up to the
 * budget and the one task read past it, at most USAGE_PAGE.comments + 1
 * comments of up to 1 MiB, stay under the 16 MiB a transaction may read
 * (pageReadBound). Tasks in Deleted items are left out with their comments.
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

/** One page of the deleted files held for a restore (model/fileHolds.ts),
 * with the bytes of those still stored. No row names them, so no
 * organization's figures do. A restore can bring back the hold of a file
 * erased since, which the eraser then clears, so each file is looked up. */
export async function heldFilesPage(ctx: QueryCtx, cursor: Cursor) {
  const page = await ctx.db
    .query('file_holds')
    .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
  let bytes = 0
  for (const hold of page.page)
    if ((await ctx.db.system.get(hold.storage_id)) !== null) bytes += hold.size_bytes
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
