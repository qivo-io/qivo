/* The rows behind the Notification delivery setting (notifications.ts):
 * each login's setting and checkpoint (account_notifications), its signed-in
 * sessions (notification_sessions) and the records of the alerts granted
 * (notification_deliveries), with their bounds and the choice of the
 * session that alerts in the default mode. A session row is named only by
 * the Better Auth session in the caller's token, so every row read or
 * written here is the caller's own. Every time is server time, from the
 * mutation's own Date.now(), and a query answers none of them, since a
 * query's result does not change as time passes. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { forbidden } from '../lib/functions'

/** The bounds of notification delivery. Tests lower them and restore them
 * with structuredClone.
 *
 * A beat reads the session in its token and its login (one nested call),
 * the session row and the account row, and writes the session row. A claim
 * in the default mode reads the account row, the session rows up to the
 * first live one and one record range a new event, and writes a record a
 * grant and the account row. Every call reads only the caller's login's
 * rows. Measured in tests/notifications.test.ts "inside Convex's limits",
 * which counts the call's own reads without the nested session lookup, a
 * beat reads 4 ranges and 5 documents and writes 1, a claim of 50 new
 * events with 3 sessions reads 55 ranges and 4 documents and writes 51,
 * and beside 1,000 other people's sessions and 10,000 records a beat and a
 * claim of 10 events read exactly what they read without them. */
export const NOTIFY = {
  /** How often a session that can notify beats while the login's mode is
   * 'recent', the only time liveness picks a target. A hidden browser tab
   * runs its timers about once a minute, so a shorter beat would not hold
   * there. */
  beat_ms: 60_000,
  /** How often every other session beats, one that cannot notify or any
   * in 'all', where no target is chosen. It keeps the row from the expiry
   * cron (session_keep_ms), so a session left open for days keeps its own
   * checkpoint. */
  idle_beat_ms: 6 * 3_600_000,
  /** A session is live while its last beat is less than this many beats
   * old, so a target that sleeps or loses its connection hands delivery on
   * within about three minutes, and a late timer does not. */
  live_beats: 3,
  /** A beat that reports interaction writes active_at at most this often,
   * so a client cannot turn input into writes. */
  active_ms: 15_000,
  /** No live alert is granted for an event older than this. A handoff
   * takes about three minutes (live_beats), so a late alert stays live. */
  live_window_ms: 600_000,
  /** How far a catch-up reads back before its checkpoint for items that
   * were stored after it with an earlier time. Convex stamps a row with
   * its mutation's start, not its commit, and background steps store
   * follower and mention notices with their write's earlier created_at
   * (model/messages.ts itemMessages). The app allows the same minute
   * (src/store/planner.ts COMMIT_SLACK_MS). A step delayed past it stays a
   * miss until messages carry a commit timestamp. */
  lag_ms: 60_000,
  /** How long a delivery or summary record is kept. Longer than
   * live_window_ms, so a record outlives every grant it must refuse, and
   * than lag_ms, so a catch-up can tell an alerted item from a missed one
   * (model/notificationCatchup.ts). */
  keep_ms: 900_000,
  /** A session row not beaten for this long goes with the expiry cron,
   * Better Auth's 7-day session plus a day, far past idle_beat_ms. A row
   * normally goes with its session (lib/sessionEnd.ts), so this catches
   * the rows a rollback or a raw component delete left. */
  session_keep_ms: 8 * 86_400_000,
  /** Session rows the target choice reads at most, newest activity first.
   * None live within them answers no target, so nothing is granted. */
  scan: 100,
  /** Events one claim takes at most. */
  claim_keys: 50,
  /** The longest event key, a message id or `${issue_id}:${woke_at}`. */
  key_chars: 128,
  /** The longest tab instance name. */
  instance_chars: 64,
  /** The claim rate window and the records a login ('recent') or a session
   * ('all') may add in it, so a broken or hostile client cannot grow the
   * records past expiry's pace. */
  claim_window_ms: 600_000,
  claim_window_most: 500,
}

/** The records and session rows one step of the expiry cron
 * (notifications.ts expire) or of a deleted login's cleanup
 * (notifications.ts forgetLogin) deletes at most, far below Convex's write
 * limits. */
export const EXPIRY = { records: 1_000, sessions: 200 }

/** The Notification delivery setting, 'recent' (Most recently active
 * session, the default) or 'all' (All enabled sessions). */
export type Delivery = Doc<'account_notifications'>['delivery']

/** How long a beat keeps a session live. */
export const liveMs = (): number => NOTIFY.live_beats * NOTIFY.beat_ms

/** Whether session row `row` is live at `now`. */
export const isLive = (row: Pick<Doc<'notification_sessions'>, 'beat_at'>, now: number) =>
  row.beat_at > now - liveMs()

/** Login `authUserId`'s account row, or null, which reads as 'recent' with
 * no checkpoint. */
export const accountRow = (ctx: QueryCtx, authUserId: string) =>
  ctx.db
    .query('account_notifications')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authUserId))
    .first()

/** The delivery mode `account` holds. */
export const deliveryOf = (account: Doc<'account_notifications'> | null): Delivery =>
  account?.delivery ?? 'recent'

/** The row of Better Auth session `sessionId`, the session in the caller's
 * token, or null. A row that names another login is never used. It
 * refuses, which cannot happen while a Better Auth session belongs to one
 * login. */
export async function sessionRow(
  ctx: QueryCtx,
  authUserId: string,
  sessionId: string,
): Promise<Doc<'notification_sessions'> | null> {
  const row = await ctx.db
    .query('notification_sessions')
    .withIndex('by_session', (q) => q.eq('session_id', sessionId))
    .first()
  if (row !== null && row.auth_user_id !== authUserId)
    throw forbidden('this session belongs to another login')
  return row
}

/**
 * The session that alerts for login `authUserId` in the default mode at
 * `now`, or null. It is the first of the login's rows that can notify,
 * newest active_at first, whose beat is live, among the first NOTIFY.scan
 * of them. A row
 * that never reported activity sorts after every one that did, and equal
 * active_at falls to the row created last, the index's own order, so
 * every mutation picks the same row. Only a mutation calls it, since
 * liveness depends on the time. None within the scan answers null, so the
 * claim grants nothing and the activity waits for the summary.
 */
export async function targetOf(
  ctx: QueryCtx,
  authUserId: string,
  now: number,
): Promise<Doc<'notification_sessions'> | null> {
  const rows = ctx.db
    .query('notification_sessions')
    .withIndex('by_login_notify_active', (q) =>
      q.eq('auth_user_id', authUserId).eq('can_notify', true),
    )
    .order('desc')
  let read = 0
  for await (const row of rows) {
    if (isLive(row, now)) return row
    read += 1
    if (read >= NOTIFY.scan) return null
  }
  return null
}

/** Where a claim's records and floors live: the account in 'recent'
 * (`sessionId` null), the caller's session in 'all'. */
export type Scope = { authUserId: string; sessionId: string | null }

/** Whether `scope` holds a record of event `key`. In 'recent' any record of
 * the key does, whichever session or mode wrote it; in 'all' the caller's
 * session's record or an account-wide one does, and another session's
 * does not. One or two index reads. */
export async function recorded(ctx: QueryCtx, scope: Scope, key: string): Promise<boolean> {
  const first = (session: string | undefined | null) =>
    ctx.db
      .query('notification_deliveries')
      .withIndex('by_login_key', (q) => {
        const ofKey = q.eq('auth_user_id', scope.authUserId).eq('key', key)
        return session === null ? ofKey : ofKey.eq('session_id', session)
      })
      .first()
  if (scope.sessionId === null) return (await first(null)) !== null
  return (await first(scope.sessionId)) !== null || (await first(undefined)) !== null
}

/** Stores a record of event `key` for `scope`, kept NOTIFY.keep_ms. */
export const record = (ctx: MutationCtx, scope: Scope, key: string, now: number) =>
  ctx.db.insert('notification_deliveries', {
    auth_user_id: scope.authUserId,
    key,
    ...(scope.sessionId === null ? {} : { session_id: scope.sessionId }),
    expires_at: now + NOTIFY.keep_ms,
  })

/** The fields of a row that hold a claim rate window. */
type Window = Pick<Doc<'account_notifications'>, 'claim_window_at' | 'claim_window_count'>

/** The rate window `holder` keeps at `now`: when it started, how many
 * records it added and how many more it may add. */
export function claimWindow(holder: Window | null, now: number) {
  const started = holder?.claim_window_at
  const fresh = started === undefined || now - started >= NOTIFY.claim_window_ms
  const used = fresh ? 0 : (holder?.claim_window_count ?? 0)
  return {
    at: fresh ? now : started,
    used,
    room: Math.max(0, NOTIFY.claim_window_most - used),
  }
}

/** Deletes every account row of login `authUserId`, duplicates included,
 * and up to EXPIRY.sessions of its session rows and EXPIRY.records of its
 * records. Answers whether any may remain. Session rows go here too, since
 * Qivo's own purges of a login delete its Better Auth sessions without the
 * session delete trigger. */
export async function forgetLoginRows(ctx: MutationCtx, authUserId: string): Promise<boolean> {
  const accounts = await ctx.db
    .query('account_notifications')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authUserId))
    .take(EXPIRY.sessions)
  const sessions = await ctx.db
    .query('notification_sessions')
    .withIndex('by_login_notify_active', (q) => q.eq('auth_user_id', authUserId))
    .take(EXPIRY.sessions)
  const records = await ctx.db
    .query('notification_deliveries')
    .withIndex('by_login_key', (q) => q.eq('auth_user_id', authUserId))
    .take(EXPIRY.records)
  for (const row of [...accounts, ...sessions, ...records]) await ctx.db.delete(row._id)
  return (
    accounts.length === EXPIRY.sessions ||
    sessions.length === EXPIRY.sessions ||
    records.length === EXPIRY.records
  )
}

/** Deletes up to EXPIRY.records records that expired before `now` and up to
 * EXPIRY.sessions session rows not beaten since NOTIFY.session_keep_ms
 * before it, ended ones included, since an end only moves beat_at back.
 * Answers whether a page was full, so more may remain. A quiet run reads
 * no row. */
export async function expireRows(ctx: MutationCtx, now: number): Promise<boolean> {
  const records = await ctx.db
    .query('notification_deliveries')
    .withIndex('by_expiry', (q) => q.lt('expires_at', now))
    .take(EXPIRY.records)
  const sessions = await ctx.db
    .query('notification_sessions')
    .withIndex('by_beat', (q) => q.lt('beat_at', now - NOTIFY.session_keep_ms))
    .take(EXPIRY.sessions)
  for (const row of [...records, ...sessions]) await ctx.db.delete(row._id)
  return records.length === EXPIRY.records || sessions.length === EXPIRY.sessions
}
