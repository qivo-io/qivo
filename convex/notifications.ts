/* Notification delivery across a person's sessions: the Notification
 * delivery setting, the signed-in sessions that can show alerts, the
 * records of the alerts granted, and the catch-up checkpoint
 * (model/notificationSessions.ts, model/notificationCatchup.ts). No app
 * calls these yet. The Inbox feed and its client (a later release) and the
 * leader tab and the Settings control (the release after it) will.
 *
 * Every function needs a sign-in whose Better Auth session is live, and on
 * the demo an active demo (lib/functions.ts sessionQuery,
 * sessionMutation). No argument names a login, a seat or a session. The
 * session row is the one of the session in the caller's token, so every
 * row read or written is the caller's own. Nothing here writes a message,
 * an inbox item or an inbox_state row, so showing an alert or a summary
 * marks nothing read. Nothing it loads loads Better Auth
 * (tests/authTriggers.test.ts).
 *
 * The mode is 'recent' (Most recently active session, the default, also
 * without a row) or 'all' (All enabled sessions). In 'recent' one session
 * alerts for the login, the target, which is the live session that can
 * notify and reported interaction last (model/notificationSessions.ts
 * targetOf), and
 * the login's checkpoint, floors and records are account-wide. In 'all'
 * every session that can notify alerts on its own, with its own
 * checkpoint, floors, records and rate window on its session row.
 *
 * - settings: the mode. It reads the account row only.
 * - setDelivery: writes the mode, counting one demo write. A change sets
 *   changed_at, before which no live alert is granted; a switch to 'all'
 *   keeps the account's checkpoint as every session's floor (all_from), and
 *   a switch to 'recent' takes the checkpoint and a baseline now and names
 *   no session as the one that moved it (covered_by), so a mode change
 *   replays nothing and the first claim after it is not sent to summarize.
 * - beat: registers the caller's session and keeps it live, with whether
 *   it can notify (`can_notify`) and whether the person used it since the
 *   last report (`active`, written at most every NOTIFY.active_ms; a first
 *   beat never sets it). It answers the pacing: `every_ms`, one minute
 *   while the mode is 'recent' and the session can notify, else a 6-hour
 *   keep-alive; `live_ms`, how long a beat keeps it live; and the server's
 *   `now`. It reads the session and the login (one nested call), the
 *   session row and the account row, and writes the session row.
 * - end: hands delivery on at once when the caller's tab `instance` was the
 *   last to beat, by moving its beat back past liveness. It keeps the row
 *   and its checkpoint, and a later beat makes the session live again.
 * - claimAlerts: which of the events the caller offers it may show. It
 *   answers `not_registered` without a row that can notify, and in 'recent'
 *   `not_target` unless the caller is the target, and `summarize_first`,
 *   writing nothing, when another session's claim or summary moved the
 *   checkpoint last (covered_by), so a session that became the target
 *   summarizes before its claim can move the checkpoint past what arrived
 *   while it was not the target. It grants an event once in its scope,
 *   never one at or before the latest of the live window
 *   (NOTIFY.live_window_ms), the last mode change and the scope's last
 *   summary, and records each grant for NOTIFY.keep_ms. Past the scope's
 *   rate window it grants no more and answers `limited`. `through` moves
 *   the scope's checkpoint, and in 'recent' names the caller's session as
 *   the one that moved it. It reads the account row, in 'recent' the
 *   session rows up to the target, and one or two record ranges an event,
 *   and writes a record a grant and the account row ('recent') or the
 *   caller's row ('all'). It reads no message or item. The keys and times
 *   come from the feed the caller read under access, and a grant tells it
 *   nothing more.
 * - claimSummary: whether eligible unread activity arrived since the
 *   scope's checkpoint, decided here from the caller's seats' inbox items
 *   under current access, read state and snooze (model/notificationCatchup.ts
 *   missedActivity). It answers `baseline` where no checkpoint exists yet
 *   (in 'all', where the caller's session has none of its own), `summary`
 *   when it found eligible activity, `none` when it read everything and
 *   found none, and `unchecked` when a budget or a seat not ready stopped
 *   it first, then moves the checkpoint and the summary floor to now, in
 *   'recent' naming the caller's session as the one that moved it, so the
 *   same gap answers `none` from any session and any retry. It holds no
 *   count.
 *
 * What a client does with the answers:
 * - It beats every `every_ms`, again at once when its capability or the
 *   mode changes, and again whenever a claim answers `not_registered`. It
 *   sends `active: true` on the first input after a quiet minute, never the
 *   input itself.
 * - It watches settings, so a mode change reaches a session that beats
 *   only every 6 hours.
 * - Each event's time is the time the item sorts by, a message's
 *   created_at or a snooze return's woke_at, in epoch milliseconds. Its
 *   key is the message id, or `${issue_id}:${woke_at}` with woke_at as
 *   stored, the ISO string the app tags notifications with today, never
 *   its epoch milliseconds (model/notificationCatchup.ts newestUnread
 *   builds the same key).
 * - `through` is the newest event time of the feed answer the claim covers,
 *   or that answer's floor when it held none, never a clock. A claim with
 *   no events is a baseline. A freshly started target takes one with its
 *   first feed answer's `through` and never offers that answer's events,
 *   so no summary counts what it held. Send no events otherwise.
 * - After a resume or a reconnect it beats, then calls claimSummary, then
 *   claims, so its gap is summarized before a claim moves the checkpoint;
 *   a claim from a session past liveness answers `not_target`. It calls
 *   claimSummary after a `limited` claim too, which held the checkpoint
 *   before the first event it refused. It shows the generic summary only on
 *   `summary`, and never alerts an event at or before its own summary.
 * - When a claim answers `summarize_first`, it calls claimSummary, then
 *   offers the same events again. The session became the target after
 *   another session moved the checkpoint, and the summary covers what
 *   arrived in between; its records refuse what it announced. A login
 *   without a checkpoint and a switch to 'recent' name no session, so no
 *   claim answers it until a claim or a summary has moved the checkpoint.
 * - It sends end when the last tab of its browser profile closes. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { consumeDemoWrite } from './lib/demo'
import { badRequest, loginMemberships, sessionMutation, sessionQuery } from './lib/functions'
import { missedActivity } from './model/notificationCatchup'
import {
  accountRow,
  claimWindow,
  deliveryOf,
  expireRows,
  forgetLoginRows,
  liveMs,
  NOTIFY,
  record,
  recorded,
  type Scope,
  sessionRow,
  targetOf,
} from './model/notificationSessions'

const vDelivery = v.union(v.literal('recent'), v.literal('all'))

/* A tab instance name, 1 to NOTIFY.instance_chars characters. */
function checkInstance(instance: string): void {
  if (instance.length === 0 || instance.length > NOTIFY.instance_chars)
    throw badRequest(`instance must be 1 to ${NOTIFY.instance_chars} characters`)
}

/* The row a call's checkpoint, floors and rate window live on. */
type Holder = Doc<'account_notifications'> | Doc<'notification_sessions'>

/* The fields of a Holder a claim or a summary moves. */
type Checkpoint = Partial<
  Pick<
    Holder,
    'covered_at' | 'summarized_at' | 'baseline_at' | 'claim_window_at' | 'claim_window_count'
  >
>

/* Writes `patch` to the scope's row: the caller's session row in 'all', the
 * account row in 'recent', which it adds when the login has none. On the
 * account row a move of covered_at also names the caller's session in
 * covered_by, which claimAlerts compares with the next target's. */
async function saveHolder(
  ctx: MutationCtx & { authUserId: string; sessionId: string },
  holder: Holder | null,
  patch: Checkpoint,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  if (holder !== null && 'session_id' in holder) {
    await ctx.db.patch(holder._id, patch)
    return
  }
  const account = patch.covered_at === undefined ? patch : { ...patch, covered_by: ctx.sessionId }
  if (holder === null)
    await ctx.db.insert('account_notifications', {
      auth_user_id: ctx.authUserId,
      delivery: 'recent',
      ...account,
    })
  else await ctx.db.patch(holder._id, account)
}

/* The scope of a call by the caller's session in `delivery`, and the row
 * that holds its checkpoint, the account row in 'recent', which may not
 * exist yet, and the caller's own row in 'all'. */
const scopeOf = (
  ctx: { authUserId: string; sessionId: string },
  delivery: 'recent' | 'all',
  account: Doc<'account_notifications'> | null,
  row: Doc<'notification_sessions'>,
): { scope: Scope; holder: Holder | null } =>
  delivery === 'recent'
    ? { scope: { authUserId: ctx.authUserId, sessionId: null }, holder: account }
    : { scope: { authUserId: ctx.authUserId, sessionId: ctx.sessionId }, holder: row }

/** The caller's Notification delivery setting, 'recent' without a row. */
export const settings = sessionQuery({
  args: {},
  handler: async (ctx) => ({ delivery: deliveryOf(await accountRow(ctx, ctx.authUserId)) }),
})

/** Sets the caller's Notification delivery setting, counting one demo
 * write. The same mode changes nothing. */
export const setDelivery = sessionMutation({
  args: { delivery: vDelivery },
  handler: async (ctx, { delivery }) => {
    await consumeDemoWrite(ctx, ctx.authUserId)
    const account = await accountRow(ctx, ctx.authUserId)
    if (deliveryOf(account) === delivery) return { delivery }
    const now = Date.now()
    const change =
      delivery === 'all'
        ? { delivery, changed_at: now, all_from: account?.covered_at ?? now }
        : { delivery, changed_at: now, covered_at: now, baseline_at: now, covered_by: undefined }
    if (account === null)
      await ctx.db.insert('account_notifications', { auth_user_id: ctx.authUserId, ...change })
    else await ctx.db.patch(account._id, change)
    return { delivery }
  },
})

/** Registers the caller's session or keeps it live, and answers the pacing
 * (header above). */
export const beat = sessionMutation({
  args: { instance: v.string(), can_notify: v.boolean(), active: v.boolean() },
  handler: async (ctx, { instance, can_notify, active }) => {
    checkInstance(instance)
    const row = await sessionRow(ctx, ctx.authUserId, ctx.sessionId)
    const delivery = deliveryOf(await accountRow(ctx, ctx.authUserId))
    const now = Date.now()
    if (row === null)
      await ctx.db.insert('notification_sessions', {
        auth_user_id: ctx.authUserId,
        session_id: ctx.sessionId,
        instance,
        can_notify,
        beat_at: now,
      })
    else {
      const used =
        active && (row.active_at === undefined || now - row.active_at >= NOTIFY.active_ms)
      await ctx.db.patch(row._id, {
        instance,
        can_notify,
        beat_at: now,
        ...(used ? { active_at: now } : {}),
      })
    }
    return {
      every_ms: delivery === 'recent' && can_notify ? NOTIFY.beat_ms : NOTIFY.idle_beat_ms,
      live_ms: liveMs(),
      now,
    }
  },
})

/** Ends the caller's session as a target at once, when tab `instance` was
 * the last to beat it (header above). */
export const end = sessionMutation({
  args: { instance: v.string() },
  handler: async (ctx, { instance }) => {
    checkInstance(instance)
    const row = await sessionRow(ctx, ctx.authUserId, ctx.sessionId)
    if (row === null || row.instance !== instance) return null
    const ended = Date.now() - liveMs()
    if (row.beat_at > ended) await ctx.db.patch(row._id, { beat_at: ended })
    return null
  },
})

/** Grants the caller the events it may show and records each (header
 * above). Repeated keys count once. */
export const claimAlerts = sessionMutation({
  args: {
    events: v.array(v.object({ key: v.string(), at: v.number() })),
    through: v.optional(v.number()),
  },
  handler: async (ctx, { events, through }) => {
    if (events.length > NOTIFY.claim_keys)
      throw badRequest(`a claim takes at most ${NOTIFY.claim_keys} events`)
    for (const { key, at } of events) {
      if (key.length === 0 || key.length > NOTIFY.key_chars)
        throw badRequest(`an event key must be 1 to ${NOTIFY.key_chars} characters`)
      if (!Number.isFinite(at) || at < 0)
        throw badRequest('an event time must be epoch milliseconds')
    }
    // never negative, so every stored checkpoint lies between 0 and now and
    // the catch-up's read back from it is a time a Date holds
    if (through !== undefined && (!Number.isFinite(through) || through < 0))
      throw badRequest('through must be epoch milliseconds')
    const row = await sessionRow(ctx, ctx.authUserId, ctx.sessionId)
    if (row === null || !row.can_notify) return { state: 'not_registered' as const }
    const account = await accountRow(ctx, ctx.authUserId)
    const delivery = deliveryOf(account)
    const now = Date.now()
    if (delivery === 'recent' && (await targetOf(ctx, ctx.authUserId, now))?._id !== row._id)
      return { state: 'not_target' as const }
    // a target that another session's claim or summary preceded summarizes
    // first, so this claim cannot move the checkpoint past what arrived
    // while it was not the target, which nobody alerted
    if (
      delivery === 'recent' &&
      account?.covered_by !== undefined &&
      account.covered_by !== ctx.sessionId
    )
      return { state: 'summarize_first' as const }
    const { scope, holder } = scopeOf(ctx, delivery, account, row)
    const floor = Math.max(
      now - NOTIFY.live_window_ms,
      account?.changed_at ?? -Infinity,
      holder?.summarized_at ?? -Infinity,
    )
    const offered = new Map<string, number>()
    for (const { key, at } of events) if (!offered.has(key)) offered.set(key, Math.min(at, now))
    const fresh: { key: string; at: number }[] = []
    for (const [key, at] of offered)
      if (at > floor && !(await recorded(ctx, scope, key))) fresh.push({ key, at })
    // the oldest first, so a window that runs out refuses the newest
    fresh.sort((a, b) => a.at - b.at)
    const window = claimWindow(holder, now)
    const granted = fresh.slice(0, window.room)
    const refused = fresh.slice(window.room)
    for (const { key } of granted) await record(ctx, scope, key, now)
    // the checkpoint stops before the first refused event, which the
    // client's summary then reports
    let covered = through === undefined ? undefined : Math.min(through, now)
    if (covered !== undefined && refused.length > 0) covered = Math.min(covered, refused[0].at - 1)
    const patch: Checkpoint = {}
    if (granted.length > 0) {
      patch.claim_window_at = window.at
      patch.claim_window_count = window.used + granted.length
    }
    if (covered !== undefined && covered > (holder?.covered_at ?? -Infinity))
      patch.covered_at = covered
    if (
      events.length === 0 &&
      covered !== undefined &&
      covered > (holder?.baseline_at ?? -Infinity)
    )
      patch.baseline_at = covered
    await saveHolder(ctx, holder, patch)
    const shown = new Set(granted.map(({ key }) => key))
    return {
      state: 'granted' as const,
      keys: [...offered.keys()].filter((key) => shown.has(key)),
      limited: refused.length > 0,
    }
  },
})

/** Whether eligible unread activity arrived since the caller's checkpoint,
 * answered once a gap (header above). */
export const claimSummary = sessionMutation({
  args: {},
  handler: async (ctx) => {
    const row = await sessionRow(ctx, ctx.authUserId, ctx.sessionId)
    if (row === null || !row.can_notify) return { state: 'not_registered' as const }
    const account = await accountRow(ctx, ctx.authUserId)
    const delivery = deliveryOf(account)
    const now = Date.now()
    if (delivery === 'recent' && (await targetOf(ctx, ctx.authUserId, now))?._id !== row._id)
      return { state: 'not_target' as const }
    const { scope, holder } = scopeOf(ctx, delivery, account, row)
    // in 'all', the switch raises a session's own checkpoint and baseline
    const allFrom = (delivery === 'all' ? account?.all_from : undefined) ?? -Infinity
    const checkpoint = holder?.covered_at
    let state: 'baseline' | 'summary' | 'none' | 'unchecked' = 'baseline'
    if (checkpoint !== undefined) {
      const floor = Math.max(checkpoint, allFrom)
      // Read back NOTIFY.lag_ms for items stored late, but not past a
      // baseline, which recorded nothing, and not past the floor once the
      // records of what the read back would pass may be gone
      // (NOTIFY.keep_ms).
      const after = Math.max(
        floor - NOTIFY.lag_ms,
        Math.min(floor, now - NOTIFY.keep_ms),
        holder?.baseline_at ?? -Infinity,
        allFrom,
      )
      const { myProfiles } = await loginMemberships(ctx, ctx.authUserId)
      const missed = await missedActivity(
        ctx,
        [...myProfiles.values()],
        after,
        now - NOTIFY.lag_ms,
        (key) => recorded(ctx, scope, key),
      )
      state = missed.state === 'found' ? 'summary' : missed.state === 'none' ? 'none' : 'unchecked'
      // so a later catch-up that reads back over this one's last stretch
      // counts none of what this summary announced
      if (state === 'summary') for (const key of missed.keys) await record(ctx, scope, key, now)
    }
    await saveHolder(ctx, holder, {
      covered_at: Math.max(now, checkpoint ?? -Infinity),
      summarized_at: now,
      ...(state === 'baseline' ? { baseline_at: now } : {}),
    })
    return { state }
  },
})

const forgetLoginRef = makeFunctionReference<'mutation', { auth_user_id: string }, null>(
  'notifications:forgetLogin',
)

/** Deletes every notification row of login `auth_user_id`, which Better
 * Auth's delete hook (auth.ts) and the console's login deletes
 * (adminAuth.ts removeAuthUserRows) call, in bounded steps that schedule
 * the next while rows remain (model/notificationSessions.ts
 * forgetLoginRows). Safe to run twice and for a login with no rows. */
export const forgetLogin = internalMutation({
  args: { auth_user_id: v.string() },
  handler: async (ctx, { auth_user_id }): Promise<null> => {
    if (await forgetLoginRows(ctx, auth_user_id))
      await ctx.scheduler.runAfter(0, forgetLoginRef, { auth_user_id })
    return null
  },
})

const expireRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'notifications:expire',
)

/** One step of the expiry cron (crons.ts): deletes delivery records that
 * expired and session rows not beaten for NOTIFY.session_keep_ms, and
 * schedules the next step while a page was full
 * (model/notificationSessions.ts expireRows). */
export const expire = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (await expireRows(ctx, Date.now())) await ctx.scheduler.runAfter(0, expireRef, {})
    return null
  },
})
