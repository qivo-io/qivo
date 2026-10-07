import {
  loadArchive,
  loadInbox,
  loadIssueDetail,
  loadKanban,
  loadOverview,
  loadRoadmap,
  loadSettings,
  loadTeamSync,
} from './workspaceChunks'

export const loadWorkspace = preloadModule(() => import('../App'))

const pages: Record<string, (() => Promise<unknown>) | undefined> = {
  overview: loadOverview,
  board: loadKanban,
  kanban: loadKanban,
  roadmap: loadRoadmap,
  split: loadRoadmap,
  resources: loadRoadmap,
  inbox: loadInbox,
  sync: loadTeamSync,
  archive: loadArchive,
  settings: loadSettings,
}

// Match only task positions. An organization, team or person can be named tasks.
function hasTask(segments: string[]): boolean {
  const page = segments[0]
  if (page === 'settings' || page === 'archive' || page === 'projects') return false
  let at = Object.hasOwn(pages, page) ? 1 : 0
  if (page === 'sync') {
    if (segments[at] === 'all') at++
    else if (segments[at] === 'p' || segments[at] === 'team') at += 2
    if (segments[at] === 'agents') at++
    else if (segments[at] === 'people' && segments[at + 1]) at += 2
  } else if (page !== 'inbox') {
    if (segments[at] === 'all' || segments[at] === 'mine') at++
    else if (segments[at] === 'p') at += 2
  }
  return segments[at] === 'tasks' && !!segments[at + 1]
}

/** Warm explicit route code while boot loads data. The router still resolves
 * permissions, saved views and task references after the snapshot arrives. */
export function preloadWorkspacePage(pathname: string, hash: string): void {
  const path = pathname.split('?')[0].split('#')[0]
  if (path !== '/app' && !path.startsWith('/app/')) return
  let segments: string[]
  try {
    segments = path.slice('/app'.length).split('/').filter(Boolean).map(decodeURIComponent).slice(1)
    if (segments.length === 0 && hash.startsWith('#/')) {
      segments = hash.slice(2).split('/').filter(Boolean).map(decodeURIComponent)
      if (segments[0] === 'o') segments = segments.slice(2)
    }
  } catch {
    return // A malformed address must not interrupt startup speculation.
  }
  // Bare and unknown routes keep their saved/mobile view without extra downloads.
  const loadPage = Object.hasOwn(pages, segments[0]) ? pages[segments[0]] : undefined
  void loadPage?.().catch(() => undefined)
  if (hasTask(segments)) void loadIssueDetail().catch(() => undefined)
}

import { preloadModule } from './lazyModule'
