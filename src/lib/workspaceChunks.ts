import { type ModuleLoader, preloadModule } from './lazyModule'

// Boot and React share these loaders so the requested view can download while
// authentication and workspace data are still loading.
export const loadOverview = preloadModule(() => import('../views/Overview'))
export const loadKanban = preloadModule(() => import('../views/Kanban'))
export const loadInbox = preloadModule(() => import('../panels/Inbox'))
export const loadIssueDetail = preloadModule(() => import('../panels/IssueDetail'))
export const loadModals = preloadModule(() => import('../panels/Modals'))
// Creation hands focus directly to the new task window when its dialog closes.
// Have that code ready before showing the form, including on a slow connection.
// It downloads nothing of its own, so it is ready once both parts are.
export const loadTaskCreation = Object.assign(
  async () => {
    const [modals] = await Promise.all([loadModals(), loadIssueDetail()])
    return modals
  },
  { peek: () => (loadIssueDetail.peek() ? loadModals.peek() : undefined) },
)
export const loadPalette = preloadModule(() => import('../panels/Palette'))
export const loadSettings = preloadModule(() => import('../panels/Settings'))
export const loadRoadmap = preloadModule(() => import('../views/Roadmap'))
export const loadTeamSync = preloadModule(() => import('../views/TeamSync'))
// The task window's text editor, shown in its place as plain text until it loads.
export const loadDescEditor = preloadModule(() => import('../components/descEditor'))
// Settings › General's organization export.
export const loadOrgExport = preloadModule(() => import('./orgExport'))

/** Every module above that downloads code, most likely to be opened first.
 * The workspace loads them all after its first paint (App.tsx). A viewer
 * never gets the task editor, so `editor` false leaves it out. */
export function workspaceModules(editor: boolean): ModuleLoader<object>[] {
  return [
    loadIssueDetail,
    loadModals,
    loadPalette,
    loadKanban,
    loadOverview,
    loadInbox,
    loadRoadmap,
    loadTeamSync,
    ...(editor ? [loadDescEditor] : []),
    loadSettings,
    loadOrgExport,
  ]
}
