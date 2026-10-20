import { describe, expect, it } from 'vitest'
import { closedBy } from './closingMoves'
import { createUnsentScope } from './leaveGuard'
import type { UiState } from './router'

/* Which windows a move closes, so App asks before the ones holding unsent
   text close. */

const scopes = { task: createUnsentScope(), page: createUnsentScope() }
const at = (place: UiState): UiState => ({
  scope: 'roadmap-project',
  view: 'kanban',
  openIssue: null,
  settingsPage: null,
  inboxOpen: false,
  projectsOpen: false,
  sync: null,
  ...place,
})
const closes = (here: UiState, next: UiState) => {
  const closed = closedBy(at(here), at({ ...here, ...next }), scopes)
  return [
    ...(closed.includes(scopes.task) ? ['task'] : []),
    ...(closed.includes(scopes.page) ? ['page'] : []),
  ]
}

describe('the windows a move closes', () => {
  it('closes the task window when it closes or shows another task', () => {
    expect(closes({ openIssue: 'QN-1' }, { openIssue: null })).toEqual(['task'])
    expect(closes({ openIssue: 'QN-1' }, { openIssue: 'QN-2' })).toEqual(['task'])
    expect(closes({ openIssue: 'QN-1' }, { openIssue: 'QN-1' })).toEqual([])
  })

  it('keeps a floating window over a page that changes under it', () => {
    expect(closes({ openIssue: 'QN-1' }, { scope: 'other-project' })).toEqual(['page'])
    expect(closes({}, { openIssue: 'QN-1' })).toEqual([])
    const sync = { scope: 'all', step: 'team' }
    expect(closes({ sync }, { openIssue: 'QN-1' })).toEqual([])
  })

  it('closes both when Settings replaces the page', () => {
    expect(closes({ openIssue: 'QN-1' }, { settingsPage: 'account' })).toEqual(['task', 'page'])
    expect(closes({ settingsPage: 'account' }, { settingsPage: 'org-teams' })).toEqual(['page'])
  })

  it('closes the Inbox pane with its task, and the Inbox with it', () => {
    const inbox = { inboxOpen: true, openIssue: 'QN-1' }
    expect(closes(inbox, { openIssue: 'QN-2' })).toEqual(['task'])
    expect(closes(inbox, { inboxOpen: false, openIssue: null })).toEqual(['task', 'page'])
  })

  it('closes the page at each Team sync step, whose cards hold the notes', () => {
    const sync = { scope: 'all', step: 'team' }
    expect(closes({ sync }, { sync: { scope: 'all', step: 'agents' } })).toEqual(['page'])
    expect(closes({ sync }, { sync })).toEqual([])
  })
})
