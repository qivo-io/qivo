/* Each organization's monthly usage, for Qivo Admin's Usage page
 * (src/admin/views/Usage.tsx), so limits and add-on prices can be set from
 * what organizations really use.
 *
 * A closed month is a stored usage_months row per organization. The monthly
 * cron starts closeMonth early on the 1st for the month that just ended. Each
 * step handles USAGE_PAGE.orgs organizations, CONCURRENCY at a time, and
 * schedules the next; the last writes one usage_month audit row with the
 * number of organizations saved and failed. An organization whose figures
 * fail to load is logged and skipped, so one cannot stop the others. A rerun
 * for the same month, `npx convex run usage:closeMonth '{"month":"YYYY-MM"}'`,
 * replaces each organization's row. Its members, counters and stored bytes
 * are then the values at the rerun.
 *
 * The current month is never stored. The page computes it from the same
 * reads when an operator opens it (monthTable, orgMonths), and the
 * per-person breakdown of any month is computed the same way (orgPeople).
 *
 * The reads are in model/usage.ts. Each internal query is one transaction
 * over one bounded page, and an action strings them together, so no
 * transaction grows with an organization. A month's figures come from many
 * snapshots, so a write during a run may count in one figure and not yet in
 * another. Rows older than USAGE_RETENTION_DAYS are deleted monthly
 * (expire), and an organization's deletion takes its rows
 * (model/orgDeletion.ts). */

import { makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import { literals } from 'convex-helpers/validators'
import { internal } from './_generated/api'
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { allOrgs, inParallel } from './adminStats'
import { deletionBegun } from './lib/billingAccess'
import { isDemoDeployment } from './lib/demo'
import { badRequest, platformAction, require } from './lib/functions'
import {
  monthOf,
  monthRange,
  PERSON_MAIL,
  type PersonMail,
  previousMonth,
  type UsageCounts,
  vUsageCounts,
} from './lib/usage'
import { audit } from './model/admin'
import {
  activityPage,
  apiPage,
  commentsPage,
  countUsage,
  deletedPage,
  filesPage,
  monthSpan,
  type PerPerson,
  personMail,
  profilesPage,
  retentionCutoff,
  type Span,
  taskCommentsPage,
  USAGE_PAGE,
  type UsageHead,
  usageHead,
  webhooksPage,
} from './model/usage'

const vCursor = v.union(v.string(), v.null())
type Cursor = string | null

/** The span of `month`, refusing a key that is not a month. */
function spanOf(month: string): Span {
  const span = monthSpan(month)
  require(span, badRequest('month must be YYYY-MM'))
  return span
}

/* ------------------------------------------------------------ the pages */

/** The organization's seats, counters, counted mail and deliveries and API
 * buckets for `month`, or null once it is gone or being deleted. */
export const head = internalQuery({
  args: { org_id: v.string(), month: v.string(), now: v.number() },
  handler: async (ctx, { org_id, month, now }): Promise<UsageHead | null> =>
    await usageHead(ctx, org_id, month, now),
})

export const profiles = internalQuery({
  args: { org_id: v.string(), month: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, month, cursor }) =>
    await profilesPage(ctx, org_id, spanOf(month), cursor),
})

export const activity = internalQuery({
  args: { org_id: v.string(), month: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, month, cursor }) =>
    await activityPage(ctx, org_id, spanOf(month), cursor),
})

export const comments = internalQuery({
  args: { org_id: v.string(), month: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, month, cursor }) =>
    await commentsPage(ctx, org_id, spanOf(month), cursor),
})

export const taskComments = internalQuery({
  args: { task_id: v.string(), month: v.string(), cursor: vCursor },
  handler: async (ctx, { task_id, month, cursor }) =>
    await taskCommentsPage(ctx, task_id, spanOf(month), cursor),
})

export const api = internalQuery({
  args: { org_id: v.string(), key: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, key, cursor }) => await apiPage(ctx, org_id, key, cursor),
})

export const files = internalQuery({
  args: { org_id: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, cursor }) => await filesPage(ctx, org_id, cursor),
})

export const deleted = internalQuery({
  args: { org_id: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, cursor }) => await deletedPage(ctx, org_id, cursor),
})

export const webhooks = internalQuery({
  args: { org_id: v.string(), month: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, month, cursor }) =>
    await webhooksPage(ctx, org_id, spanOf(month), cursor),
})

export const mailWithoutOrg = internalQuery({
  args: { month: v.string() },
  handler: async (ctx, { month }): Promise<PersonMail> => await personMail(ctx, month),
})

/** Counts one authentication letter (verification, password reset or an
 * account note) the provider accepted, under no organization. */
export const countPersonMail = internalMutation({
  args: { metric: literals(...PERSON_MAIL) },
  handler: async (ctx, { metric }): Promise<null> => {
    await countUsage(ctx, { metric })
    return null
  },
})

/* ---------------------------------------------------- one organization */

type Runner = Pick<ActionCtx, 'runQuery'>

/** Reads every page of a paged internal query, handing each page to `take`. */
async function eachPage<P extends { next: Cursor }>(
  read: (cursor: Cursor) => Promise<P>,
  take: (page: P) => void,
): Promise<void> {
  let cursor: Cursor = null
  do {
    const page = await read(cursor)
    take(page)
    cursor = page.next
  } while (cursor !== null)
}

/** One person's part of an organization's month (orgPeople). */
export type PersonUsage = {
  profile_id: string
  changes: number
  comments: number
  api_calls: number
  credentials: { id: string; name: string; calls: number }[]
  signed_in: boolean
}

/** An organization's figures for a month, with who did what. */
export type OrgUsage = { counts: UsageCounts; api_estimated: boolean; people: PersonUsage[] }

/** Reads organization `org_id`'s figures for `month`, or null once it is
 * gone or being deleted. `now` ends a paid period still running. */
export async function orgUsage(
  ctx: Runner,
  org_id: string,
  month: string,
  now: number,
): Promise<OrgUsage | null> {
  const top: UsageHead | null = await ctx.runQuery(internal.usage.head, { org_id, month, now })
  if (top === null) return null
  const people = new Map<string, PersonUsage>()
  const person = (profile_id: string): PersonUsage => {
    let p = people.get(profile_id)
    if (p === undefined) {
      p = { profile_id, changes: 0, comments: 0, api_calls: 0, credentials: [], signed_in: false }
      people.set(profile_id, p)
    }
    return p
  }
  const add = (list: PerPerson, field: 'changes' | 'comments') => {
    for (const { id, n } of list) person(id)[field] += n
  }
  const counts: UsageCounts = {
    billable: top.billable,
    guests: 0,
    agents: 0,
    active_people: 0,
    active_tasks: top.active_tasks,
    live_projects: top.live_projects,
    changes: 0,
    comments: 0,
    api_calls: 0,
    file_bytes: 0,
    image_bytes: 0,
    deleted_file_bytes: 0,
    avatar_bytes: 0,
    ...top.counted,
  }
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.profiles, { org_id, month, cursor }),
    (page) => {
      counts.guests += page.guests
      counts.agents += page.agents
      counts.avatar_bytes += page.avatar_bytes
      for (const id of page.active) person(id).signed_in = true
    },
  )
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.activity, { org_id, month, cursor }),
    (page) => {
      counts.changes += page.changes
      add(page.by_actor, 'changes')
    },
  )
  const deferred: string[] = []
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.comments, { org_id, month, cursor }),
    (page) => {
      counts.comments += page.comments
      add(page.by_author, 'comments')
      deferred.push(...page.deferred)
    },
  )
  for (const task_id of deferred)
    await eachPage(
      (cursor) => ctx.runQuery(internal.usage.taskComments, { task_id, month, cursor }),
      (page) => {
        counts.comments += page.comments
        add(page.by_author, 'comments')
      },
    )
  // Calls split from a paid period are fractions until each sum is rounded.
  let calls = 0
  const credentials = new Map<
    string,
    { profile_id: string; id: string; name: string; calls: number }
  >()
  for (const { key, share } of top.buckets)
    await eachPage(
      (cursor) => ctx.runQuery(internal.usage.api, { org_id, key, cursor }),
      (page) => {
        for (const row of page.rows) {
          const n = row.calls * share
          calls += n
          const id = `${row.profile_id} ${row.credential_id}`
          const credential = credentials.get(id) ?? {
            profile_id: row.profile_id,
            id: row.credential_id,
            name: row.credential_name,
            calls: 0,
          }
          credential.calls += n
          credentials.set(id, credential)
        }
      },
    )
  counts.api_calls = Math.round(calls)
  for (const credential of credentials.values()) {
    const p = person(credential.profile_id)
    const n = Math.round(credential.calls)
    p.api_calls += n
    p.credentials.push({ id: credential.id, name: credential.name, calls: n })
  }
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.files, { org_id, cursor }),
    (page) => {
      counts.file_bytes += page.file_bytes
      counts.image_bytes += page.image_bytes
    },
  )
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.deleted, { org_id, cursor }),
    (page) => {
      counts.deleted_file_bytes += page.deleted_file_bytes
    },
  )
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.webhooks, { org_id, month, cursor }),
    (page) => {
      counts.webhook_deliveries += page.deliveries
      counts.webhook_attempts += page.attempts
    },
  )
  const list = [...people.values()].filter(
    (p) => p.signed_in || p.changes > 0 || p.comments > 0 || p.api_calls > 0,
  )
  counts.active_people = list.length
  return { counts, api_estimated: top.api_estimated, people: list }
}

/* ------------------------------------------------------ the monthly job */

/** One page of organization ids, in creation order. */
export const orgPage = internalQuery({
  args: { cursor: vCursor },
  handler: async (ctx, { cursor }): Promise<{ ids: string[]; next: Cursor }> => {
    const page = await ctx.db
      .query('organizations')
      .paginate({ cursor, numItems: USAGE_PAGE.orgs, maximumBytesRead: USAGE_PAGE.bytes })
    return { ids: page.page.map((org) => org.id), next: page.isDone ? null : page.continueCursor }
  },
})

/** Stores organization `org_id`'s row for `month`, replacing an earlier one.
 * Writes nothing for an organization that is gone or being deleted, so a
 * run cannot leave a row behind its deletion. */
export const saveMonth = internalMutation({
  args: {
    org_id: v.string(),
    month: v.string(),
    counts: vUsageCounts,
    api_estimated: v.boolean(),
  },
  handler: async (ctx, a): Promise<boolean> => {
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => q.eq('id', a.org_id))
      .unique()
    if (org === null || (await deletionBegun(ctx, a.org_id))) return false
    const row = {
      org_id: a.org_id,
      month: a.month,
      counts: a.counts,
      api_estimated: a.api_estimated,
      computed_at: new Date().toISOString(),
    }
    const existing = await ctx.db
      .query('usage_months')
      .withIndex('by_org_month', (q) => q.eq('org_id', a.org_id).eq('month', a.month))
      .unique()
    if (existing) await ctx.db.replace(existing._id, row)
    else await ctx.db.insert('usage_months', row)
    return true
  },
})

/** Records a finished run in the platform audit log. */
export const finishMonth = internalMutation({
  args: { month: v.string(), saved: v.number(), failed: v.number() },
  handler: async (ctx, detail): Promise<null> => {
    await audit(ctx, { actor_email: 'system', action: 'usage_month', detail })
    return null
  },
})

const closeArgs = {
  // the month to store; the month before the current one when absent
  month: v.optional(v.string()),
  cursor: v.optional(vCursor),
  // organizations the run's earlier steps saved and failed on
  saved: v.optional(v.number()),
  failed: v.optional(v.number()),
}
const closeMonthRef = makeFunctionReference<'action', ObjectType<typeof closeArgs>, null>(
  'usage:closeMonth',
)

/** One step of the monthly job. Empty arguments start a run for the month
 * that just ended. Refuses the current month and later ones, which are not
 * closed. Does nothing on the demo deployment. */
export const closeMonth = internalAction({
  args: closeArgs,
  handler: async (ctx, a): Promise<null> => {
    if (isDemoDeployment()) return null
    const now = Date.now()
    const month = a.month ?? previousMonth(now)
    spanOf(month)
    require(month < monthOf(now), badRequest('only a month that has ended can be stored'))
    const page: { ids: string[]; next: Cursor } = await ctx.runQuery(internal.usage.orgPage, {
      cursor: a.cursor ?? null,
    })
    let saved = a.saved ?? 0
    let failed = a.failed ?? 0
    await inParallel(page.ids, async (org_id) => {
      try {
        const usage = await orgUsage(ctx, org_id, month, now)
        if (usage === null) return
        const stored: boolean = await ctx.runMutation(internal.usage.saveMonth, {
          org_id,
          month,
          counts: usage.counts,
          api_estimated: usage.api_estimated,
        })
        if (stored) saved += 1
      } catch (e) {
        failed += 1
        console.error('[usage] organization skipped', {
          org_id,
          month,
          name: (e as Error)?.name ?? 'error',
        })
      }
    })
    if (page.next !== null)
      await ctx.scheduler.runAfter(0, closeMonthRef, { month, cursor: page.next, saved, failed })
    else await ctx.runMutation(internal.usage.finishMonth, { month, saved, failed })
    return null
  },
})

/** Rows one expiry step deletes from each table at most. Tests lower it. */
export const USAGE_EXPIRY = { page: 200 }

const expireRef = makeFunctionReference<'mutation', Record<string, never>, null>('usage:expire')

/** Deletes usage_months and usage_counts rows of months older than
 * USAGE_RETENTION_DAYS, a page at a time, scheduling the next step while a
 * full page came back. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const cutoff = retentionCutoff(Date.now())
    const months = await ctx.db
      .query('usage_months')
      .withIndex('by_month', (q) => q.lt('month', cutoff))
      .take(USAGE_EXPIRY.page)
    const counted = await ctx.db
      .query('usage_counts')
      .withIndex('by_month', (q) => q.lt('month', cutoff))
      .take(USAGE_EXPIRY.page)
    for (const row of [...months, ...counted]) await ctx.db.delete(row._id)
    if (months.length === USAGE_EXPIRY.page || counted.length === USAGE_EXPIRY.page)
      await ctx.scheduler.runAfter(0, expireRef, {})
    return null
  },
})

/* ------------------------------------------------------- Qivo Admin */

/** One organization's month on the Usage page. `computed_at` is null for
 * the current month, which is computed for the request. */
export type UsageRow = {
  org_id: string
  name: string
  counts: UsageCounts
  api_estimated: boolean
  computed_at: string | null
}

type StoredRow = Omit<UsageRow, 'name'>

/** One page of the stored rows of `month`. */
export const monthRows = internalQuery({
  args: { month: v.string(), cursor: vCursor },
  handler: async (ctx, { month, cursor }): Promise<{ rows: StoredRow[]; next: Cursor }> => {
    const page = await ctx.db
      .query('usage_months')
      .withIndex('by_month', (q) => q.eq('month', month))
      .paginate({ cursor, numItems: USAGE_PAGE.rows, maximumBytesRead: USAGE_PAGE.bytes })
    return {
      rows: page.page.map(({ org_id, counts, api_estimated, computed_at }) => ({
        org_id,
        counts,
        api_estimated,
        computed_at,
      })),
      next: page.isDone ? null : page.continueCursor,
    }
  },
})

/** The stored rows of one organization, oldest month first. Retention keeps
 * about 27 of them. */
export const orgRows = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<(StoredRow & { month: string })[]> => {
    const rows = await ctx.db
      .query('usage_months')
      .withIndex('by_org_month', (q) => q.eq('org_id', org_id))
      .collect()
    return rows.map(({ month, counts, api_estimated, computed_at }) => ({
      org_id,
      month,
      counts,
      api_estimated,
      computed_at,
    }))
  },
})

/** The names of up to USAGE_PAGE.profiles profiles of organization
 * `org_id`. A removed profile is missing. */
export const profileNames = internalQuery({
  args: { org_id: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, { org_id, ids }): Promise<{ id: string; name: string }[]> => {
    require(ids.length <= USAGE_PAGE.profiles, badRequest('too many profiles'))
    const out: { id: string; name: string }[] = []
    for (const id of ids) {
      const p = await ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      if (p?.org_id === org_id) out.push({ id, name: p.name })
    }
    return out
  },
})

/** Refuses a month that is not `YYYY-MM` or has not begun. */
function askedMonth(month: string, now: number): { current: boolean } {
  require(monthRange(month), badRequest('month must be YYYY-MM'))
  const current = monthOf(now)
  require(month <= current, badRequest('that month has not begun'))
  return { current: month === current }
}

/** The Usage page's table for `month`: every organization's row, and the
 * mail sent to people without an organization. A closed month shows its
 * stored rows, and an organization without one is left out; the current
 * month is computed now for every organization. */
export const monthTable = platformAction({
  args: { month: v.string() },
  handler: async (
    ctx,
    { month },
  ): Promise<{ month: string; current: boolean; rows: UsageRow[]; person_mail: PersonMail }> => {
    const now = Date.now()
    const { current } = askedMonth(month, now)
    const orgs = await allOrgs(ctx)
    const names = new Map(orgs.map((org) => [org.id, org.name]))
    const rows: UsageRow[] = []
    if (current) {
      const live = await inParallel(orgs, async (org) => {
        const usage = await orgUsage(ctx, org.id, month, now)
        return usage === null
          ? null
          : {
              org_id: org.id,
              name: org.name,
              counts: usage.counts,
              api_estimated: usage.api_estimated,
              computed_at: null,
            }
      })
      for (const row of live) if (row !== null) rows.push(row)
    } else {
      await eachPage(
        (cursor) => ctx.runQuery(internal.usage.monthRows, { month, cursor }),
        (page) => {
          for (const row of page.rows)
            rows.push({ ...row, name: names.get(row.org_id) ?? row.org_id })
        },
      )
    }
    const person_mail: PersonMail = await ctx.runQuery(internal.usage.mailWithoutOrg, { month })
    return { month, current, rows, person_mail }
  },
})

/** One organization's stored months side by side with the current month,
 * oldest first. */
export const orgMonths = platformAction({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<(StoredRow & { month: string })[]> => {
    const now = Date.now()
    const month = monthOf(now)
    const stored: (StoredRow & { month: string })[] = await ctx.runQuery(internal.usage.orgRows, {
      org_id,
    })
    const live = await orgUsage(ctx, org_id, month, now)
    if (live === null) return stored
    return [
      ...stored,
      { org_id, month, counts: live.counts, api_estimated: live.api_estimated, computed_at: null },
    ]
  },
})

/** Who did what in one organization's month, computed now from the rows
 * Qivo keeps: changes, comments and REST and MCP calls per person and
 * credential, and whether they signed in. A removed person keeps their
 * calls under their old id, named null. Nothing is stored. */
export const orgPeople = platformAction({
  args: { org_id: v.string(), month: v.string() },
  handler: async (
    ctx,
    { org_id, month },
  ): Promise<{ people: (PersonUsage & { name: string | null })[]; api_estimated: boolean }> => {
    const now = Date.now()
    askedMonth(month, now)
    const usage = await orgUsage(ctx, org_id, month, now)
    if (usage === null) return { people: [], api_estimated: false }
    const names = new Map<string, string>()
    const ids = usage.people.map((p) => p.profile_id)
    for (let i = 0; i < ids.length; i += USAGE_PAGE.profiles) {
      const page: { id: string; name: string }[] = await ctx.runQuery(internal.usage.profileNames, {
        org_id,
        ids: ids.slice(i, i + USAGE_PAGE.profiles),
      })
      for (const { id, name } of page) names.set(id, name)
    }
    return {
      people: usage.people.map((p) => ({ ...p, name: names.get(p.profile_id) ?? null })),
      api_estimated: usage.api_estimated,
    }
  },
})
