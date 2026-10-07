import { preloadModule } from './lazyModule'

// Boot and React share these loaders so the requested view can download while
// authentication and workspace data are still loading.
export const loadOverview = preloadModule(() => import('../views/Overview'))
export const loadKanban = preloadModule(() => import('../views/Kanban'))
export const loadInbox = preloadModule(() => import('../panels/Inbox'))
export const loadIssueDetail = preloadModule(() => import('../panels/IssueDetail'))
export const loadModals = preloadModule(() => import('../panels/Modals'))
// Creation hands focus directly to the new task window when its dialog closes.
// Have that code ready before showing the form, including on a slow connection.
export const loadTaskCreation = preloadModule(async () => {
  const [modals] = await Promise.all([loadModals(), loadIssueDetail()])
  return modals
})
export const loadPalette = preloadModule(() => import('../panels/Palette'))
export const loadSettings = preloadModule(() => import('../panels/Settings'))
export const loadArchive = preloadModule(() => import('../panels/ArchivePage'))
export const loadRoadmap = preloadModule(() => import('../views/Roadmap'))
export const loadTeamSync = preloadModule(() => import('../views/TeamSync'))
