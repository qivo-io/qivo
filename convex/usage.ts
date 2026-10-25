/* Each organization's monthly usage, for Qivo Admin's Usage page
 * (src/admin/views/Usage.tsx), so limits and add-on prices can be set from
 * what organizations really use.
 *
 * A closed month is a stored usage_months row per organization that existed
 * before it ended. The daily cron calls closeMonth, which on the 1st starts
 * the run for the month that just ended. Each step handles USAGE_PAGE.orgs
 * organizations, CONCURRENCY at a time, and keeps the run's progress in the
 * month's usage_runs row; the last marks the run finished and writes one
 * usage_month audit row with the number of organizations saved and failed.
 * An organization whose figures fail to load is logged and skipped, so one
 * cannot stop the others, and a step that stopped, such as at a restart, is
 * resumed by the next day's call. A rerun for the same month,
 * `npx convex run usage:closeMonth '{"month":"YYYY-MM"}'`, starts over and
 * replaces each organization's row. Its members, counters and stored bytes
 * are then the values at the rerun. The daily call also records when the job
 * first saw each month, which tells a month whose counters began during it
 * (model/usage.ts monthStatus).
 *
 * The current month is never stored. The page computes it from the same
 * reads when an operator opens it (monthTable, orgMonths), and the
 * per-person breakdown of any month is computed the same way (orgPeople).
 * The last step also stores the bytes of account backgrounds, which belong
 * to a login rather than an organization, as one total for the month.
 *
 * The reads are in model/usage.ts. Each internal query is one transaction
 * over one bounded page, and an action strings them together, so no
 * transaction grows with an organization except the head, whose billable
 * seats come from getBillableUsers, the read Billing makes of every profile
 * of the organization in one transaction. A month's figures come from many
 * snapshots, so a write during a run may count in one figure and not yet in
 * another. Rows older than USAGE_RETENTION_DAYS are deleted monthly
 * (expire), and an organization's deletion takes its rows
 * (model/orgDeletion.ts). */

import { makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import { literals } from 'convex-helpers/validators'
import { components, internal } from './_generated/api'
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
  previousMonth,
  retentionCutoff,
  type Unattributed,
  type UsageCounts,
  vUsageCounts,
} from './lib/usage'
import { audit } from './model/admin'
import { newUuid } from './model/orgs'
import {
  activityPage,
  apiPage,
  backgroundsPage,
  commentsPage,
  countUsage,
  deletedPage,
  filesPage,
  forgetSignIns,
  keepSignIns,
  type MonthStatus,
  monthSpan,
  monthStatus,
  type PerPerson,
  personMail,
  profilesPage,
  retainedDeliveries,
  runRow,
  type Span,
  seeMonth,
  setPersonFiles,
  storedPersonFiles,
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

export const retained = internalQuery({
  args: { org_id: v.string(), month: v.string() },
  handler: async (ctx, { org_id, month }) => await retainedDeliveries(ctx, org_id, month),
})

export const backgrounds = internalQuery({
  args: { cursor: vCursor },
  handler: async (ctx, { cursor }) => await backgroundsPage(ctx, cursor),
})

/** Account mail of `month`, and the account background bytes stored with
 * it, null for a month stored without them. */
export const unattributed = internalQuery({
  args: { month: v.string() },
  handler: async (ctx, { month }): Promise<Unattributed> => ({
    ...(await personMail(ctx, month)),
    background_bytes: await storedPersonFiles(ctx, month),
  }),
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

/** Keeps the months of a sign-in session that ended (auth.ts keepSignIn),
 * so they still count. A login already deleted keeps nothing: its deletion
 * forgot its months (adminAuth.ts removeAuthUserRows), and reading the user
 * here orders the two transactions. */
export const keepSignIn = internalMutation({
  args: { auth_user_id: v.string(), created_at: v.number(), updated_at: v.number() },
  handler: async (ctx, a): Promise<null> => {
    if (isDemoDeployment()) return null
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: a.auth_user_id }],
    })
    if (user === null) return null
    await keepSignIns(
      ctx,
      a.auth_user_id,
      { createdAt: a.created_at, updatedAt: a.updated_at },
      Date.now(),
    )
    return null
  },
})

/** Deletes the kept sign-in months of a deleted login (auth.ts). */
export const forgetLogin = internalMutation({
  args: { auth_user_id: v.string() },
  handler: async (ctx, { auth_user_id }): Promise<null> => {
    await forgetSignIns(ctx, auth_user_id)
    return null
  },
})

/* ---------------------------------------------------- one organization */

type Runner = Pick<ActionCtx, 'runQuery'>

/** Reads of the stored deliveries at most, while the retention sweep moves
 * some of them into usage_counts. The sweep runs every 15 minutes, so a
 * second read is rare; a sweep during the last read could still go
 * uncounted. */
const WEBHOOK_READS = 3

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
  // A person's total and whether they called at all come from the exact
  // shares; each credential's count is rounded for display.
  const exact = new Map<string, number>()
  for (const credential of credentials.values()) {
    const p = person(credential.profile_id)
    exact.set(p.profile_id, (exact.get(p.profile_id) ?? 0) + credential.calls)
    p.credentials.push({
      id: credential.id,
      name: credential.name,
      calls: Math.round(credential.calls),
    })
  }
  for (const [profile_id, n] of exact) person(profile_id).api_calls = Math.round(n)
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
  // The deliveries the sweep deleted plus the ones still stored, read again
  // when the sweep moved some from one to the other meanwhile.
  let retained = {
    deliveries: top.counted.webhook_deliveries,
    attempts: top.counted.webhook_attempts,
  }
  for (let read = 1; ; read++) {
    let deliveries = retained.deliveries
    let attempts = retained.attempts
    await eachPage(
      (cursor) => ctx.runQuery(internal.usage.webhooks, { org_id, month, cursor }),
      (page) => {
        deliveries += page.deliveries
        attempts += page.attempts
      },
    )
    counts.webhook_deliveries = deliveries
    counts.webhook_attempts = attempts
    const after: { deliveries: number; attempts: number } = await ctx.runQuery(
      internal.usage.retained,
      { org_id, month },
    )
    const same = after.deliveries === retained.deliveries && after.attempts === retained.attempts
    if (same || read === WEBHOOK_READS) break
    retained = after
  }
  const list = [...people.values()].filter(
    (p) => p.signed_in || p.changes > 0 || p.comments > 0 || (exact.get(p.profile_id) ?? 0) > 0,
  )
  counts.active_people = list.length
  return { counts, api_estimated: top.api_estimated, people: list }
}

/* ------------------------------------------------------ the monthly job */

/** One page of organization ids, in creation order, leaving out the ones
 * created at `before` or later, which did not exist in the month. */
export const orgPage = internalQuery({
  args: { cursor: vCursor, before: v.string() },
  handler: async (ctx, { cursor, before }): Promise<{ ids: string[]; next: Cursor }> => {
    const page = await ctx.db
      .query('organizations')
      .paginate({ cursor, numItems: USAGE_PAGE.orgs, maximumBytesRead: USAGE_PAGE.bytes })
    return {
      ids: page.page.filter((org) => org.created_at < before).map((org) => org.id),
      next: page.isDone ? null : page.continueCursor,
    }
  },
})

/** Stores organization `org_id`'s row for `month`, replacing an earlier one.
 * Writes nothing for an organization that is gone or being deleted, so a
 * run cannot leave a row behind its deletion, nor for a run that is no
 * longer the month's, so a step of a run an operator replaced cannot
 * overwrite the new run's rows. */
export const saveMonth = internalMutation({
  args: {
    org_id: v.string(),
    month: v.string(),
    counts: vUsageCounts,
    api_estimated: v.boolean(),
    // the run storing the month; absent for closeOrgMonth
    run: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<boolean> => {
    if (a.run !== undefined && (await runRow(ctx, a.month))?.run !== a.run) return false
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

/** Reads and stores organization `org_id`'s row for the closed `month`.
 * False when the organization is gone or being deleted. */
async function storeOrgMonth(
  ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>,
  org_id: string,
  month: string,
  now: number,
  run?: string,
): Promise<boolean> {
  const usage = await orgUsage(ctx, org_id, month, now)
  if (usage === null) return false
  return await ctx.runMutation(internal.usage.saveMonth, {
    org_id,
    month,
    counts: usage.counts,
    api_estimated: usage.api_estimated,
    run,
  })
}

/** The bytes of every account background and its preview now. */
async function backgroundBytes(ctx: Runner): Promise<number> {
  let bytes = 0
  await eachPage(
    (cursor) => ctx.runQuery(internal.usage.backgrounds, { cursor }),
    (page) => {
      bytes += page.bytes
    },
  )
  return bytes
}

/** Refuses a key that is not a month, a month that has not ended, and one
 * older than retention keeps. */
function closedMonth(month: string, now: number): void {
  spanOf(month)
  require(month < monthOf(now), badRequest('only a month that has ended can be stored'))
  require(month >= retentionCutoff(now), badRequest('that month is older than usage is kept'))
}

/** Stores one organization's closed month, for the marketing demo's seed,
 * which must not rewrite other organizations' rows. */
export const closeOrgMonth = internalAction({
  args: { org_id: v.string(), month: v.string() },
  handler: async (ctx, { org_id, month }): Promise<null> => {
    if (isDemoDeployment()) return null
    const now = Date.now()
    closedMonth(month, now)
    await storeOrgMonth(ctx, org_id, month, now)
    return null
  },
})

/** A run step that began longer ago than this has stopped, since an action
 * runs for 10 minutes at most. The daily job then resumes its run. */
export const RUN_STALLED_MS = 15 * 60_000

/** What one step of a run reads: its next page of organizations and the
 * organizations the run saved and failed on so far. */
type RunStep = { run: string; cursor: Cursor; saved: number; failed: number }

/**
 * Claims the next step of the run that stores the closed `month`, recording
 * when it began, or null when there is nothing to do. With `run`, it
 * continues that run while it is still the month's run. Without, it starts
 * one: an operator's rerun (`fresh`) starts over, and the daily job starts
 * the month once and resumes a run whose last step stopped, under a new id
 * so a step of the old one could not write. Each call also records that the
 * job saw the month of `now` (usage_runs seen_at).
 */
export const claimStep = internalMutation({
  args: { month: v.string(), run: v.optional(v.string()), fresh: v.boolean(), now: v.number() },
  handler: async (ctx, a): Promise<RunStep | null> => {
    await seeMonth(ctx, monthOf(a.now), a.now)
    await seeMonth(ctx, a.month, a.now)
    const row = await runRow(ctx, a.month)
    if (row === null) return null
    const step = {
      run: row.run ?? newUuid(),
      cursor: row.cursor ?? null,
      saved: row.saved ?? 0,
      failed: row.failed ?? 0,
    }
    if (a.run !== undefined) {
      if (row.run !== a.run || row.finished_at !== undefined) return null
    } else if (a.fresh || row.run === undefined) {
      Object.assign(step, { run: newUuid(), cursor: null, saved: 0, failed: 0 })
    } else if (row.finished_at !== undefined || a.now - (row.step_at ?? 0) < RUN_STALLED_MS) {
      return null
    } else step.run = newUuid()
    await ctx.db.patch(row._id, { ...step, step_at: a.now, finished_at: undefined })
    return step
  },
})

/**
 * Records a finished step of run `run` of `month`. While pages remain it
 * schedules the next step, in this transaction, so a step cannot end
 * without its successor. After the last page it stores the bytes of account
 * backgrounds, or counts one more failure when they could not be read
 * (null), marks the run finished and writes one usage_month row to the
 * platform audit log. Does nothing once another run took the month.
 */
export const endStep = internalMutation({
  args: {
    month: v.string(),
    run: v.string(),
    cursor: vCursor,
    saved: v.number(),
    failed: v.number(),
    background_bytes: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, a): Promise<null> => {
    const row = await runRow(ctx, a.month)
    if (row === null || row.run !== a.run || row.finished_at !== undefined) return null
    const { month, run, cursor, saved } = a
    if (cursor !== null) {
      await ctx.db.patch(row._id, { cursor, saved, failed: a.failed })
      await ctx.scheduler.runAfter(0, closeMonthRef, { month, run })
      return null
    }
    const failed = a.failed + (typeof a.background_bytes === 'number' ? 0 : 1)
    if (typeof a.background_bytes === 'number') await setPersonFiles(ctx, month, a.background_bytes)
    await ctx.db.patch(row._id, { cursor, saved, failed, finished_at: Date.now() })
    await audit(ctx, {
      actor_email: 'system',
      action: 'usage_month',
      detail: { month, saved, failed },
    })
    return null
  },
})

const closeArgs = {
  // the month to store; the month before the current one when absent
  month: v.optional(v.string()),
  // the run a scheduled step continues; absent for a start
  run: v.optional(v.string()),
}
const closeMonthRef = makeFunctionReference<'action', ObjectType<typeof closeArgs>, null>(
  'usage:closeMonth',
)

/** One step of the usage job: one page of organizations. The daily cron
 * calls it without arguments, which starts or resumes the run for the month
 * that just ended until it finished; `{"month": "YYYY-MM"}` reruns a closed
 * month from the start. Refuses the current month and later ones, which
 * are not closed. Does nothing on the demo deployment. */
export const closeMonth = internalAction({
  args: closeArgs,
  handler: async (ctx, a): Promise<null> => {
    if (isDemoDeployment()) return null
    const now = Date.now()
    const month = a.month ?? previousMonth(now)
    closedMonth(month, now)
    const step: RunStep | null = await ctx.runMutation(internal.usage.claimStep, {
      month,
      run: a.run,
      fresh: a.month !== undefined && a.run === undefined,
      now,
    })
    if (step === null) return null
    const page: { ids: string[]; next: Cursor } = await ctx.runQuery(internal.usage.orgPage, {
      cursor: step.cursor,
      before: spanOf(month).to,
    })
    let { saved, failed } = step
    await inParallel(page.ids, async (org_id) => {
      try {
        if (await storeOrgMonth(ctx, org_id, month, now, step.run)) saved += 1
      } catch (e) {
        failed += 1
        console.error('[usage] organization skipped', {
          org_id,
          month,
          name: (e as Error)?.name ?? 'error',
        })
      }
    })
    let background_bytes: number | null | undefined
    if (page.next === null)
      background_bytes = await backgroundBytes(ctx).catch((e: unknown) => {
        console.error('[usage] account backgrounds not counted', {
          month,
          name: (e as Error)?.name ?? 'error',
        })
        return null
      })
    await ctx.runMutation(internal.usage.endStep, {
      month,
      run: step.run,
      cursor: page.next,
      saved,
      failed,
      background_bytes,
    })
    return null
  },
})

/** Rows one expiry step deletes from each table at most. Tests lower it. */
export const USAGE_EXPIRY = { page: 200 }

const expireRef = makeFunctionReference<'mutation', Record<string, never>, null>('usage:expire')

/** Deletes usage_months, usage_counts, usage_runs and usage_sign_ins rows
 * of months older than USAGE_RETENTION_DAYS, a page of each at a time,
 * scheduling the next step while a full page came back. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const cutoff = retentionCutoff(Date.now())
    let full = false
    for (const table of ['usage_months', 'usage_counts', 'usage_runs', 'usage_sign_ins'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_month', (q) => q.lt('month', cutoff))
        .take(USAGE_EXPIRY.page)
      for (const row of rows) await ctx.db.delete(row._id)
      if (rows.length === USAGE_EXPIRY.page) full = true
    }
    if (full) await ctx.scheduler.runAfter(0, expireRef, {})
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

/** The status of `month` (model/usage.ts monthStatus). */
export const status = internalQuery({
  args: { month: v.string() },
  handler: async (ctx, { month }): Promise<MonthStatus> =>
    monthStatus(await runRow(ctx, month), month),
})

/** Every month's status that retention keeps, by month. */
export const statuses = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, MonthStatus>> => {
    // One row per month, so retention keeps about 27.
    const rows = await ctx.db.query('usage_runs').collect()
    return Object.fromEntries(rows.map((row) => [row.month, monthStatus(row, row.month)]))
  },
})

/** Logs an organization whose current month could not be computed. */
function liveFailed(org_id: string, e: unknown): void {
  console.error('[usage] current month not computed', {
    org_id,
    name: (e as Error)?.name ?? 'error',
  })
}

/** The Usage page's table for `month`: every organization's row, what
 * belongs to no organization, account mail and account backgrounds, and
 * the month's status. A closed month shows its stored rows, and an
 * organization without one is left out; the current month is computed now
 * for every organization, and one whose figures fail to load is named in
 * `failed` instead. */
export const monthTable = platformAction({
  args: { month: v.string() },
  handler: async (
    ctx,
    { month },
  ): Promise<{
    month: string
    current: boolean
    rows: UsageRow[]
    unattributed: Unattributed
    failed: { org_id: string; name: string }[]
    status: MonthStatus
  }> => {
    const now = Date.now()
    const { current } = askedMonth(month, now)
    const orgs = await allOrgs(ctx)
    const names = new Map(orgs.map((org) => [org.id, org.name]))
    const rows: UsageRow[] = []
    const failed: { org_id: string; name: string }[] = []
    if (current) {
      // undefined for an organization whose figures failed to load
      const live = await inParallel(orgs, async (org) => {
        try {
          return { org, usage: await orgUsage(ctx, org.id, month, now) }
        } catch (e) {
          liveFailed(org.id, e)
          return { org, usage: undefined }
        }
      })
      for (const { org, usage } of live)
        if (usage === undefined) failed.push({ org_id: org.id, name: org.name })
        else if (usage !== null)
          rows.push({
            org_id: org.id,
            name: org.name,
            counts: usage.counts,
            api_estimated: usage.api_estimated,
            computed_at: null,
          })
    } else {
      await eachPage(
        (cursor) => ctx.runQuery(internal.usage.monthRows, { month, cursor }),
        (page) => {
          for (const row of page.rows)
            rows.push({ ...row, name: names.get(row.org_id) ?? row.org_id })
        },
      )
    }
    const stored: Unattributed = await ctx.runQuery(internal.usage.unattributed, { month })
    const unattributed = current
      ? { ...stored, background_bytes: await backgroundBytes(ctx) }
      : stored
    const status: MonthStatus = await ctx.runQuery(internal.usage.status, { month })
    return { month, current, rows, unattributed, failed, status }
  },
})

/** One month of one organization on the Usage page, with whether its
 * counters may have missed part of it. */
export type OrgMonth = StoredRow & { month: string; partial: boolean }

/** One organization's stored months side by side with the current month,
 * oldest first. When the current month fails to load, the stored ones are
 * still returned, with `current_failed`. */
export const orgMonths = platformAction({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<{ months: OrgMonth[]; current_failed: boolean }> => {
    const now = Date.now()
    const month = monthOf(now)
    const stored: (StoredRow & { month: string })[] = await ctx.runQuery(internal.usage.orgRows, {
      org_id,
    })
    const statuses: Record<string, MonthStatus> = await ctx.runQuery(internal.usage.statuses, {})
    const partial = (m: string) => statuses[m]?.partial ?? true
    const months = stored.map((row) => ({ ...row, partial: partial(row.month) }))
    let live: OrgUsage | null
    try {
      live = await orgUsage(ctx, org_id, month, now)
    } catch (e) {
      liveFailed(org_id, e)
      return { months, current_failed: true }
    }
    if (live !== null)
      months.push({
        org_id,
        month,
        counts: live.counts,
        api_estimated: live.api_estimated,
        computed_at: null,
        partial: partial(month),
      })
    return { months, current_failed: false }
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
