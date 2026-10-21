import { unsentList } from './discardQuestion'
import type { UnsentScope } from './leaveGuard'
import type { UiState } from './router'

/* Which windows a move in the app closes. The task window (floating, or the
   Inbox with its pane) and the page under it each keep the leases of the
   text typed in them (lib/leaveGuard), so App asks before a move that closes
   one of them while it holds unsent text (components/DiscardPrompt). */

/** The task window a place shows: floating, or the Inbox with its pane. */
const taskWindowAt = (p: UiState) =>
  p.settingsPage ? null : p.inboxOpen ? `inbox:${p.openIssue ?? ''}` : (p.openIssue ?? null)

/** The page a place shows under any task window. Each Team sync step shows
    its own cards. */
const pageAt = (p: UiState) =>
  p.settingsPage
    ? `settings:${p.settingsPage}`
    : p.sync
      ? `sync:${p.sync.scope}:${p.sync.step}`
      : p.inboxOpen
        ? 'inbox'
        : p.projectsOpen
          ? 'projects'
          : `${p.scope}:${p.view}`

/** The scopes of the windows a move from `here` to `next` closes. */
export function closedBy(
  here: UiState,
  next: UiState,
  scopes: { task: UnsentScope; page: UnsentScope },
): UnsentScope[] {
  const task = taskWindowAt(here)
  return [
    ...(task && taskWindowAt(next) !== task ? [scopes.task] : []),
    ...(pageAt(next) !== pageAt(here) ? [scopes.page] : []),
  ]
}

/** Lets the task window of `key`, a new task whose create the server
    refused, close with its unsent text: the task does not exist, so the
    text has nowhere to go. Answers the sentence that says what went with
    it, for a notice beside the refusal, or null when the window held none.
    The editors' own "discarded" toasts stay quiet, as after a Discard. */
export function dropRefusedTask(scope: UnsentScope, key: string): string | null {
  const lost = scope.held()
  if (!lost.length) return null
  scope.discard()
  return `${key} was not created, so its window closed and your unsent ${unsentList(lost)} went with it.`
}
