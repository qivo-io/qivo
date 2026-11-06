import { describe, expect, it } from 'vitest'
import { type BadgeSummary, inboxBadge, NO_COUNT } from './inboxBadge'

/* The Inbox badge's rule (lib/inboxBadge.ts) for every state of the unread
   summary: its chip, the desktop tab's name, the phone badge's name, what
   the chip says and whether it is refreshing, at the boundaries 0, 1, 99
   and more than 99, complete and not, current and not. */

const ok = (unread_count: number, complete = true, current = true, unread_more = false) =>
  ({
    state: 'ok',
    answer: { unread_count, unread_more, complete },
    current,
  }) satisfies BadgeSummary

describe("the Inbox badge's rule", () => {
  it('shows the ellipsis while the summary loads and after it failed, never nothing or 0', () => {
    expect(inboxBadge({ state: 'loading', answer: null, current: false })).toEqual({
      chip: NO_COUNT,
      tabName: 'Inbox, unread count loading',
      phoneName: 'Unread count loading',
      state: 'unknown',
      refreshing: false,
    })
    expect(inboxBadge({ state: 'failed', answer: null, current: false })).toEqual({
      chip: NO_COUNT,
      tabName: 'Inbox, unread count unavailable',
      phoneName: 'Unread count unavailable',
      state: 'unknown',
      refreshing: false,
    })
  })

  it('shows no chip only for a current, complete zero', () => {
    expect(inboxBadge(ok(0))).toEqual({
      chip: null,
      tabName: 'Inbox',
      phoneName: null,
      state: null,
      refreshing: false,
    })
    // a held zero from before a reconnect may be stale
    expect(inboxBadge(ok(0, true, false))).toEqual({
      chip: NO_COUNT,
      tabName: 'Inbox, unread count loading',
      phoneName: 'Unread count loading',
      state: 'unknown',
      refreshing: true,
    })
    // an incomplete zero counted nothing it can stand by
    expect(inboxBadge(ok(0, false))).toMatchObject({
      chip: NO_COUNT,
      tabName: 'Inbox, unread count unavailable',
      phoneName: 'Unread count unavailable',
      state: 'unknown',
    })
  })

  it('shows an exact count from 1 to 99', () => {
    expect(inboxBadge(ok(1))).toEqual({
      chip: '1',
      tabName: 'Inbox, 1 unread',
      phoneName: '1 unread',
      state: 'count',
      refreshing: false,
    })
    expect(inboxBadge(ok(12))).toMatchObject({ chip: '12', tabName: 'Inbox, 12 unread' })
    expect(inboxBadge(ok(99))).toMatchObject({
      chip: '99',
      tabName: 'Inbox, 99 unread',
      phoneName: '99 unread',
      state: 'count',
    })
  })

  it('shows 99+ for more than 99, complete or not', () => {
    for (const complete of [true, false])
      expect(inboxBadge(ok(100, complete, true, true))).toEqual({
        chip: '99+',
        tabName: 'Inbox, more than 99 unread',
        phoneName: 'More than 99 unread',
        state: 'more',
        refreshing: false,
      })
    // the flag decides, whatever count rides with it
    expect(inboxBadge(ok(7, true, true, true))).toMatchObject({ chip: '99+', state: 'more' })
  })

  it('marks an incomplete count with a plus and says at least', () => {
    expect(inboxBadge(ok(12, false))).toEqual({
      chip: '12+',
      tabName: 'Inbox, at least 12 unread',
      phoneName: 'At least 12 unread',
      state: 'partial',
      refreshing: false,
    })
    expect(inboxBadge(ok(1, false))).toMatchObject({ chip: '1+', state: 'partial' })
    expect(inboxBadge(ok(99, false))).toMatchObject({ chip: '99+', state: 'partial' })
  })

  it('shows a held count as its answer says, marked refreshing', () => {
    expect(inboxBadge(ok(12, true, false))).toEqual({
      chip: '12',
      tabName: 'Inbox, 12 unread',
      phoneName: '12 unread',
      state: 'count',
      refreshing: true,
    })
    expect(inboxBadge(ok(12, false, false))).toMatchObject({ chip: '12+', refreshing: true })
    expect(inboxBadge(ok(100, true, false, true))).toMatchObject({ chip: '99+', refreshing: true })
  })
})
