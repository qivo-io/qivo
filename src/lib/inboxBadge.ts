/* What the Inbox badge shows, on the desktop top bar's Inbox tab and the
   phone's bottom Inbox tab, from the server's unread summary
   (convex/inbox.ts summary, store/planner.ts P.inboxSummary). The summary
   counts the unread, unsnoozed tasks of every seat, exact to 99 and then
   "more than 99", and says when its count is only a lower bound. The badge
   never shows nothing or 0 for a count it does not have. It shows an
   ellipsis while the summary loads, after it failed and for an incomplete
   count of nothing, and only a current, complete zero shows no badge. An
   incomplete count shows with a plus, as "at least". A held answer from
   before a reconnect shows as it says, marked refreshing for checks only,
   since a figure that is being refreshed keeps its place, as the
   Overview's do; a held zero shows the ellipsis, as loading. */

/** The summary as the badge reads it (store/planner.ts InboxSummaryVM). */
export type BadgeSummary =
  | { state: 'loading' | 'failed'; answer: null; current: boolean }
  | {
      state: 'ok'
      answer: { unread_count: number; unread_more: boolean; complete: boolean }
      current: boolean
    }

/** What a badge shows for one summary. */
export type InboxBadge = {
  /** the chip's text, or null for no chip */
  chip: string | null
  /** the desktop Inbox tab's accessible name */
  tabName: string
  /** the phone badge's accessible name, or null with no chip */
  phoneName: string | null
  /** what the chip says, for checks (`data-inbox-badge-state`): an exact
      count, more than 99, a lower bound, or no count; null with no chip */
  state: 'count' | 'more' | 'partial' | 'unknown' | null
  /** whether the answer is held from before a reconnect or a re-init and
      not current yet (`data-refreshing`) */
  refreshing: boolean
}

/** The ellipsis the badge shows where it has no count. */
export const NO_COUNT = '…'

const unknown = (why: 'loading' | 'unavailable', refreshing: boolean): InboxBadge => ({
  chip: NO_COUNT,
  tabName: `Inbox, unread count ${why}`,
  phoneName: `Unread count ${why}`,
  state: 'unknown',
  refreshing,
})

/** The badge for `summary`: the chip, the desktop tab's name, the phone
    badge's name and what the chip says. `unread_more` shows 99+, a count
    the summary calls incomplete shows with a plus and says "at least", and
    a summary with no count shows the ellipsis with a name that says why. */
export function inboxBadge(summary: BadgeSummary): InboxBadge {
  if (summary.state !== 'ok')
    return unknown(summary.state === 'loading' ? 'loading' : 'unavailable', false)
  const { unread_count: count, unread_more: more, complete } = summary.answer
  const refreshing = !summary.current
  // the server answers more than 99 only through unread_more; a count past
  // 99 without it would be a server defect, and still fits the chip
  if (more || count > 99)
    return {
      chip: '99+',
      tabName: 'Inbox, more than 99 unread',
      phoneName: 'More than 99 unread',
      state: 'more',
      refreshing,
    }
  if (count === 0) {
    if (!complete) return unknown('unavailable', refreshing)
    // a held zero may be stale, so it shows as loading until it is current
    if (refreshing) return unknown('loading', true)
    return { chip: null, tabName: 'Inbox', phoneName: null, state: null, refreshing: false }
  }
  if (!complete)
    return {
      chip: `${count}+`,
      tabName: `Inbox, at least ${count} unread`,
      phoneName: `At least ${count} unread`,
      state: 'partial',
      refreshing,
    }
  return {
    chip: `${count}`,
    tabName: `Inbox, ${count} unread`,
    phoneName: `${count} unread`,
    state: 'count',
    refreshing,
  }
}
