/* messages.snooze / messages.wake — the inbox snooze. An item is hidden on
 * every client until a server-scheduled wake, never a client clock; both
 * directions leave the item UNREAD; the whole (recipient, issue) pair is
 * stamped alike; news wakes it; the bulk acts and the nightly sweep leave a
 * snoozed item alone. */
/// <reference types="vite/client" />

import type { FunctionArgs } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { wakeSnoozedItem } from '../model/messages'
import {
  as,
  expectRefusal,
  messagesFor,
  newT,
  plantIssue,
  plantMessage,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const HOUR = 3_600_000
const inAnHour = () => new Date(Date.now() + HOUR).toISOString()

const snooze = (t: T, who: Doc<'profiles'>, ids: string[], until: string | null) =>
  as(t, who).mutation(api.messages.snooze, { org_id: who.org_id, ids, until })

const subscribe = (t: T, who: Doc<'profiles'>, issueId: string) =>
  as(t, who).mutation(api.issues.subscribe, { org_id: who.org_id, issue_id: issueId })

type Patch = FunctionArgs<typeof api.issues.update>['patch']
const update = (t: T, actor: Doc<'profiles'>, id: string, patch: Patch) =>
  as(t, actor).mutation(api.issues.update, { org_id: actor.org_id, id, patch })

/* The scheduled wake needs the clock to move; every case here drives it
 * explicitly, so none of them may await the real-time `tick()` helper. */
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('messages.snooze — the item, stamped alike, unread, woken by the server', () => {
  it('stamps every row of the pair from one id, marks the item unread and leaves other pairs alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issueA = uuid()
    const issueB = uuid()
    const base = { org_id: f.org.id, recipient_id: f.guest.id }
    const READ = '2026-01-02T00:00:00.000Z'
    const a1 = await plantMessage(t, { ...base, issue_id: issueA, read_at: READ })
    const a2 = await plantMessage(t, { ...base, issue_id: issueA, created_at: READ })
    const b1 = await plantMessage(t, { ...base, issue_id: issueB })
    const other = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: issueA,
    })

    const until = inAnHour()
    await snooze(t, f.guest, [a2.id], until) // one id names the whole item

    const pair = await messagesFor(t, f.guest.id, issueA)
    expect(pair.map((m) => m.id).sort()).toEqual([a1.id, a2.id].sort())
    for (const m of pair) {
      expect(m.snoozed_until).toBe(until)
      expect(m.read_at).toBeUndefined() // the read one is unread again
      expect(m.woke_at).toBeUndefined()
    }
    const [b] = await messagesFor(t, f.guest.id, issueB)
    expect(b.snoozed_until).toBeUndefined()
    expect(b.id).toBe(b1.id)
    const [foreign] = await messagesFor(t, f.admin.id, issueA)
    expect(foreign.snoozed_until).toBeUndefined()
    expect(foreign.id).toBe(other.id)

    // the scheduled wake: snooze gone, still unread, one woke_at on every row
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const woken = await messagesFor(t, f.guest.id, issueA)
    expect(woken).toHaveLength(2)
    const stamps = new Set(woken.map((m) => m.woke_at))
    expect(stamps.size).toBe(1)
    expect([...stamps][0]).toBeDefined()
    for (const m of woken) {
      expect(m.snoozed_until).toBeUndefined()
      expect(m.read_at).toBeUndefined()
    }
  })

  it('a wake scheduled for a superseded snooze does nothing; the current one wakes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue_id = uuid()
    const m = await plantMessage(t, { org_id: f.org.id, recipient_id: f.guest.id, issue_id })
    const first = inAnHour()
    const second = new Date(Date.now() + 2 * HOUR).toISOString()
    await snooze(t, f.guest, [m.id], first)
    await snooze(t, f.guest, [m.id], second)

    const pair = { recipient_id: f.guest.id, issue_id }
    const stale = await t.run((ctx) => wakeSnoozedItem(ctx, { ...pair, until: first }, 'now'))
    expect(stale).toBe(false)
    let [row] = await messagesFor(t, f.guest.id, issue_id)
    expect(row.snoozed_until).toBe(second)
    expect(row.woke_at).toBeUndefined()

    const live = await t.run((ctx) => wakeSnoozedItem(ctx, { ...pair, until: second }, 'now'))
    expect(live).toBe(true)
    ;[row] = await messagesFor(t, f.guest.id, issue_id)
    expect(row.snoozed_until).toBeUndefined()
    expect(row.woke_at).toBe('now')
  })

  it('null lifts the snooze early: visible, unread, no woke stamp — and the pending wake finds nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue_id = uuid()
    const m = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.guest.id,
      issue_id,
      read_at: '2026-01-02T00:00:00.000Z',
    })
    await snooze(t, f.guest, [m.id], inAnHour())
    await snooze(t, f.guest, [m.id], null)

    let [row] = await messagesFor(t, f.guest.id, issue_id)
    expect(row.snoozed_until).toBeUndefined()
    expect(row.read_at).toBeUndefined()
    expect(row.woke_at).toBeUndefined()

    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    ;[row] = await messagesFor(t, f.guest.id, issue_id)
    expect(row.woke_at).toBeUndefined()
  })

  it('refuses a stamp that is not an instant, is in the past, or is more than a year ahead', async () => {
    const t = newT()
    const f = await withOrg(t)
    const m = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.guest.id,
      issue_id: uuid(),
    })
    await expectRefusal(snooze(t, f.guest, [m.id], 'tomorrow-ish'), 'bad_request', /ISO instant/)
    await expectRefusal(
      snooze(t, f.guest, [m.id], new Date(Date.now() - 1000).toISOString()),
      'bad_request',
      /in the future/,
    )
    await expectRefusal(
      snooze(t, f.guest, [m.id], new Date(Date.now() + 400 * 24 * HOUR).toISOString()),
      'bad_request',
      /a year/,
    )
    const [row] = await messagesFor(t, f.guest.id, m.issue_id)
    expect(row.snoozed_until).toBeUndefined()
  })

  it("somebody else's row is skipped silently — no stamp, no error", async () => {
    const t = newT()
    const f = await withOrg(t)
    const theirs = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: uuid(),
    })
    await expect(snooze(t, f.guest, [theirs.id], inAnHour())).resolves.toBeNull()
    const [row] = await messagesFor(t, f.admin.id, theirs.issue_id)
    expect(row.snoozed_until).toBeUndefined()
    expect(row.read_at).toBeUndefined()
  })

  it('news wakes a snoozed item: the arrival drops the stamp, and the scheduled wake then has nothing to do', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)
    await update(t, f.user, issue.id, { status: 'progress' })
    const [m1] = await messagesFor(t, f.guest.id, issue.id)
    await snooze(t, f.guest, [m1.id], inAnHour())

    vi.advanceTimersByTime(1000) // a later instant for the arrival
    await update(t, f.user, issue.id, { status: 'review' })
    const pair = await messagesFor(t, f.guest.id, issue.id)
    expect(pair).toHaveLength(2)
    for (const m of pair) {
      expect(m.snoozed_until).toBeUndefined()
      expect(m.read_at).toBeUndefined()
      expect(m.woke_at).toBeUndefined() // the arrival is the news; no wake stamp
    }

    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    for (const m of await messagesFor(t, f.guest.id, issue.id)) expect(m.woke_at).toBeUndefined()
  })
})

describe('the bulk acts leave a snoozed item alone', () => {
  it('markAllRead skips snoozed unread rows; removeRead skips snoozed read rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, recipient_id: f.guest.id }
    const until = inAnHour()
    const READ = '2026-01-02T00:00:00.000Z'
    const snoozedUnread = await plantMessage(t, { ...base, issue_id: uuid(), snoozed_until: until })
    const plainUnread = await plantMessage(t, { ...base, issue_id: uuid() })
    const snoozedRead = await plantMessage(t, {
      ...base,
      issue_id: uuid(),
      read_at: READ,
      snoozed_until: until,
    })
    const plainRead = await plantMessage(t, { ...base, issue_id: uuid(), read_at: READ })

    const marked = await as(t, f.guest).mutation(api.messages.markAllRead, { org_id: f.org.id })
    expect(marked.marked).toBe(1)
    expect(marked.hasMore).toBe(false)
    const byId = new Map((await messagesFor(t, f.guest.id)).map((m) => [m.id, m]))
    expect(byId.get(snoozedUnread.id)?.read_at).toBeUndefined()
    expect(byId.get(plainUnread.id)?.read_at).toBeDefined()

    const removed = await as(t, f.guest).mutation(api.messages.removeRead, { org_id: f.org.id })
    expect(removed.removed).toBe(2) // plainRead and the just-marked plainUnread
    expect(removed.hasMore).toBe(false)
    const left = (await messagesFor(t, f.guest.id)).map((m) => m.id).sort()
    expect(left).toEqual([snoozedUnread.id, snoozedRead.id].sort())
    expect(left).not.toContain(plainRead.id)
  })
})
