/* The reads behind an organization's monthly usage (usage.ts), and the one
 * counter Qivo writes for it.
 *
 * Every figure except mail comes from rows Qivo already keeps, read one
 * bounded page at a time, so measuring adds no write to the paths it
 * measures. Mail has no other record, so each letter the provider accepts
 * adds one to a usage_counts row (countUsage). Webhook deliveries are
 * deleted a week after they finish, so the retention sweep (webhooks.ts)
 * adds the ones it deletes to usage_counts by the month they finished, and
 * a month's count is those plus the deliveries still stored.
 *
 * Each page function reads at most USAGE_PAGE of one range and returns
 * where the next page starts. They are plain functions over a QueryCtx;
 * usage.ts wraps them in internal queries. */

import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { deletionBegun, subscriptionFor } from '../lib/billingAccess'
import { getBillableUsers } from '../lib/billableUsers'
import { isDemoDeployment } from '../lib/demo'
import {
  monthOf,
  monthRange,
  ORG_METRICS,
  overlapShare,
  PERSON_MAIL,
  type PersonMail,
  type UsageCounts,
  type UsageMetric,
} from '../lib/usage'
import { usageKeyRanges } from './billingUsage'
import { countersRow } from './orgs'

/** Rows per page and the bytes one page's range may read. Tests lower them. */
export const USAGE_PAGE = {
  /** Organizations one step of the monthly job handles. */
  orgs: 50,
  /** Activity, attachment, Deleted items, delivery and API usage rows. */
  rows: 2000,
  /** Profiles, each with one read of its sessions and its picture. */
  profiles: 200,
  /** Tasks, each with one read of its comments stored since the month began. */
  issues: 200,
  /** Comments read with their task; a task with more is paged on its own. */
  comments: 50,
  /** Bytes the paged range of one page may read. */
  bytes: 8 * 1024 * 1024,
}

const DAY_MS = 86_400_000

/** Days a usage_months or usage_counts row is kept after its month. */
export const USAGE_RETENTION_DAYS = 800

/** Rows older than this month are deleted (usage.ts expire). */
export const retentionCutoff = (now: number): string => monthOf(now - USAGE_RETENTION_DAYS * DAY_MS)

/** Adds `n` to one usage_counts row of the month `at` falls in. Leave out
 * `org_id` for mail that belongs to a person. Counts nothing on the demo
 * deployment, whose organizations are deleted without their usage, or for
 * an organization whose deletion has begun, which may already have deleted
 * its counts. */
export async function countUsage(
  ctx: MutationCtx,
  a: { org_id?: string; metric: UsageMetric; at?: number; n?: number },
): Promise<void> {
  const n = a.n ?? 1
  if (n <= 0 || isDemoDeployment()) return
  if (a.org_id !== undefined && (await deletionBegun(ctx, a.org_id))) return
  const month = monthOf(a.at ?? Date.now())
  const row = await ctx.db
    .query('usage_counts')
    .withIndex('by_org_month_metric', (q) =>
      q.eq('org_id', a.org_id).eq('month', month).eq('metric', a.metric),
    )
    .unique()
  if (row) await ctx.db.patch(row._id, { count: row.count + n })
  else
    await ctx.db.insert('usage_counts', {
      ...(a.org_id === undefined ? {} : { org_id: a.org_id }),
      month,
      metric: a.metric,
      count: n,
    })
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
  let estimated = false
  ranges.forEach((range, i) => {
    const from = Date.parse(range.start)
    if (Number.isNaN(from)) return
    const to = Math.min(range.end === null ? now : Date.parse(range.end), now)
    const share = overlapShare(from, to, span.start, span.end)
    if (share <= 0) return
    if (share < 1) estimated = true
    buckets.push({ key: keys[i], share })
  })
  return { buckets, estimated }
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
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_uuid', (q) => q.eq('id', orgId))
    .unique()
  if (org === null) return null
  if (await deletionBegun(ctx, orgId)) return null
  const { total } = await getBillableUsers(ctx, orgId)
  const counters = await countersRow(ctx, orgId)
  const counting = counters?.counted !== undefined
  const counted = Object.fromEntries(
    ORG_METRICS.map((metric) => [metric, 0]),
  ) as UsageHead['counted']
  for (const metric of ORG_METRICS) {
    const row = await ctx.db
      .query('usage_counts')
      .withIndex('by_org_month_metric', (q) =>
        q.eq('org_id', orgId).eq('month', month).eq('metric', metric),
      )
      .unique()
    counted[metric] = row?.count ?? 0
  }
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

/** Mail sent to people rather than for an organization in `month`. */
export async function personMail(ctx: QueryCtx, month: string): Promise<PersonMail> {
  const mail = Object.fromEntries(PERSON_MAIL.map((metric) => [metric, 0])) as PersonMail
  for (const metric of PERSON_MAIL) {
    const row = await ctx.db
      .query('usage_counts')
      .withIndex('by_org_month_metric', (q) =>
        q.eq('org_id', undefined).eq('month', month).eq('metric', metric),
      )
      .unique()
    mail[metric] = row?.count ?? 0
  }
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

/** Whether login `authUserId` had a sign-in session created before the
 * month ended and created or refreshed after it began. It reads the newest
 * SESSIONS_READ sessions through the userId index; a bound on updatedAt
 * would make the adapter scan the whole table, as no index has it. Better
 * Auth deletes a session at sign-out, so a person who signed in and out
 * within the month and did nothing else is missed. */
async function signedIn(ctx: QueryCtx, authUserId: string, span: Span): Promise<boolean> {
  const sessions = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'session',
    where: [{ field: 'userId', value: authUserId }],
    sortBy: { field: 'createdAt', direction: 'desc' },
    paginationOpts: { numItems: SESSIONS_READ, cursor: null },
  })) as { page: Session[] }
  return sessions.page.some((s) => s.createdAt < span.end && s.updatedAt >= span.start)
}

/** Sessions read per login. A login holds one per device it stays signed
 * in on. */
const SESSIONS_READ = 50

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
    if (p.auth_user_id !== undefined && (await signedIn(ctx, p.auth_user_id, span)))
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
 * USAGE_PAGE.comments comments stored since the month began is named in
 * `deferred` and paged on its own (taskCommentsPage). Tasks in Deleted
 * items are left out with their comments.
 */
export async function commentsPage(ctx: QueryCtx, orgId: string, span: Span, cursor: Cursor) {
  const page = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({ cursor, numItems: USAGE_PAGE.issues, maximumBytesRead: USAGE_PAGE.bytes })
  const authors = new Map<string, number>()
  const deferred: string[] = []
  let comments = 0
  await Promise.all(
    page.page.map(async (task) => {
      const rows = await taskComments(ctx, task.id, span).take(USAGE_PAGE.comments + 1)
      if (rows.length > USAGE_PAGE.comments) {
        deferred.push(task.id)
        return
      }
      for (const row of rows)
        if (commentIn(row, span)) {
          comments += 1
          tally(authors, row.author)
        }
    }),
  )
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
