/* App shell: sidebar hierarchy, top bar, view switching, command palette,
   toasts, modals, theme. */
import {
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { DropdownChevron } from '@/components/ui/select'
import { useInputIdle } from '@/lib/inputIdle'
import {
  KEEP_IDLE_MS,
  keptPages,
  MAIN_PAGES,
  type MainPage,
  NO_PAGES,
  releasePages,
  showsScope,
  withoutPage,
} from '@/lib/keptPages'
import { BillingNotice } from './components/BillingNotice'
import { KeptInPlace, ViewKeeper } from './components/KeptView'
import { MobileHeader, MobileNavigation, MobileTaskList } from './components/MobileWorkspace'
import { navRow } from './components/navRow'
import { type ChooserShows, ProjectChooser } from './components/ProjectChooser'
import { ProjectDirectory } from './components/ProjectDirectory'
import { navMoved, onNavMove, openedName, openResolved } from './components/projectNavRows'
import { Icon, MenuItem, Popover, Seg } from './components/qivo'
import { type FocusRow, SidebarProjects } from './components/SidebarProjects'
import { TasksLoadingBar } from './components/TasksLoading'
import { ViewBoundary } from './components/ViewBoundary'
import { ViewFilters } from './components/viewFilters'
import {
  WorkspaceHeader,
  WorkspacePageHeader,
  WorkspaceShell,
  WorkspaceToolbar,
} from './components/WorkspaceShell'
import { flushWalkInput } from './components/walkRows'
import { addressMoved, rememberAddress } from './lib/addressBook'
import { closeOrAsk } from './lib/discardQuestion'
import { lazyFromModule, preloadInBackground } from './lib/lazyModule'
import { parseSyncScope, SYNC_MILESTONE_SLOTS } from './lib/teamSync'
import { useMobile, useMobileBackLayer } from './lib/useMobile'
import { OUT_OF_USE } from './lib/viewHidden'
import './styles/mobile.css'
import { announce } from './lib/announce'
import { closedBy, dropRefusedTask } from './lib/closingMoves'
import { floatSlot } from './lib/floatStack'
import { restoreFocus } from './lib/focusVisibility'
import { inboxBadge } from './lib/inboxBadge'
import { isLandscapeRoadmapOpen } from './lib/landscape'
import { createUnsentScope, type UnsentScope, UnsentScopeContext } from './lib/leaveGuard'
import { afterProjectSaved } from './lib/newProjectAccess'
import {
  busyLayerLeft,
  historyBusy,
  holdLayers,
  leavePage,
  listenBackLayers,
  onHistorySettled,
  pushPage,
  whenQuiet,
} from './lib/pageHistory'
import { createPopRefusal } from './lib/popRefusal'
import { type RevealRequest, type TaskPlace, taskPlaceOf, withoutTaken } from './lib/reveal'
import {
  ARCHIVED_TASKS_PAGE,
  buildPath,
  isFrontDoor,
  isScopeAddress,
  namesProjectPage,
  ORG_NONE,
  orgSegmentOf,
  parseHash,
  parsePath,
  pathMatchesState,
  pathNamesScope,
  projectPagesRev,
  type Route,
  type ScopeTask,
  sameTask,
  scopeForIssue,
  scopeTaskOf,
  subscribeProjectPages,
  syncPlaceOf,
  taskFacts,
  taskProjectPending,
  type UiState,
} from './lib/router'
import { isTaskRef } from './lib/taskReference'
import { type Toast, toastLook, withToast } from './lib/toasts'
import {
  loadInbox,
  loadIssueDetail,
  loadKanban,
  loadModals,
  loadOverview,
  loadPalette,
  loadRoadmap,
  loadSettings,
  loadTaskCreation,
  loadTeamSync,
  workspaceModules,
} from './lib/workspaceChunks'
import {
  type IssueFilters,
  type NewProjectInput,
  P,
  type ProjectAsk,
  type ProjectCreated,
  type ProjectShown,
  type ScopeInfo,
  TASKS_FAILED_TEXT,
} from './store/planner'
import { usePlannerVersion } from './store/usePlannerVersion'
import { BOARD_SLOTS } from './views/board/useBoardView'
import type { SyncPlace } from './views/TeamSync'

const Overview = lazyFromModule(loadOverview, (module) => module.Overview)
const Kanban = lazyFromModule(loadKanban, (module) => module.Kanban)
const Inbox = lazyFromModule(loadInbox, (module) => module.Inbox)
const IssueDetail = lazyFromModule(loadIssueDetail, (module) => module.IssueDetail)
const NewIssueModal = lazyFromModule(loadTaskCreation, (module) => module.NewIssueModal)
const NewProjectModal = lazyFromModule(loadModals, (module) => module.NewProjectModal)
const NewSubProjectModal = lazyFromModule(loadModals, (module) => module.NewSubProjectModal)
const MilestoneModal = lazyFromModule(loadModals, (module) => module.MilestoneModal)
const CreateOrgModal = lazyFromModule(loadModals, (module) => module.CreateOrgModal)
const SearchPalette = lazyFromModule(loadPalette, (module) => module.SearchPalette)
const SettingsScreen = lazyFromModule(loadSettings, (module) => module.SettingsScreen)
const Roadmap = lazyFromModule(loadRoadmap, (module) => module.Roadmap)
const TeamSync = lazyFromModule(loadTeamSync, (module) => module.TeamSync)

function ViewLoading() {
  return (
    <div role="status" className="[padding:24px] [color:var(--text-2)]">
      Loading…
    </div>
  )
}

/** Each requested overlay can fail without unmounting the page or another draft. */
function DeferredOverlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <ViewBoundary overlay onBack={onClose}>
      <Suspense fallback={null}>{children}</Suspense>
    </ViewBoundary>
  )
}

let toastSeq = 0

/* ---------- sidebar ---------- */
/* Navigation rows share components/navRow.ts with Settings. */

/** The desktop's rail. While `hidden`, as while Settings shows, it stays
    mounted and inactive (KeptInPlace), so the project tree keeps its rows
    and its place and reads again on return. `focusRow` is App's request to
    focus a project's row once the tree shows it, and `onFocusRowDone` ends
    it (components/SidebarProjects.tsx). */
function Sidebar({
  scope,
  actions,
  inboxOpen,
  syncOpen,
  projectsOpen,
  hidden,
  focusRow,
  onFocusRowDone,
}: {
  scope: string
  actions: Record<string, (...args: unknown[]) => void>
  inboxOpen: boolean
  syncOpen: boolean
  projectsOpen: boolean
  hidden: boolean
  focusRow: FocusRow | null
  onFocusRowDone: (n: number) => void
}) {
  // "My view" is a scope and lights up like a project row. "All projects"
  // opens the project directory, a page, and lights while it shows, and
  // only then: no view shows a scope over all projects. The inbox, which
  // owns the screen, outranks every one of them. Team sync is a page with a
  // row of its own: while it is open that row is the only lit one, and the
  // scope underneath waits unlit for its return, as it does under the
  // directory. A row of the project tree (components/SidebarProjects.tsx)
  // lights by scopeOn.
  const allOn = !inboxOpen && !syncOpen && projectsOpen
  const mineOn = !inboxOpen && !syncOpen && !projectsOpen && P.isMineScope(scope)
  const scopeOn = (id: string) => !syncOpen && !projectsOpen && scope === id
  /* No rule down the rail's right edge (deviation #63): --chrome is darker
     than --bg, so the rail's own value separates it from the canvas. */
  return (
    <aside
      aria-label="Workspace navigation"
      className="planner-sidebar [width:var(--sidebar-w)] [flex-shrink:0] [background:var(--chrome)] [display:flex] [flex-direction:column] [height:100vh]"
    >
      <KeptInPlace shown={!hidden}>
        <div className="planner-navigation">
          {/* The same "Qivo" wordmark as the website header. */}
          <div className="planner-brand [padding:20px_20px_0]">
            <span className="wordmark [font-size:27px] [line-height:1]">Qivo</span>
          </div>
          {/* Home organization identity. A login without one can create its own
            while the server would (P.orgCreate), not while an organization
            that deactivated it, or one being deleted, holds its home seat. */}
          <div className="planner-org [padding:16px_12px_8px]">
            {P.homeOrg ? (
              <div
                data-org-well
                className="[display:flex] [align-items:center] [padding:0_8px] [min-height:32px]"
              >
                <div className="[font-weight:600] [font-size:var(--fs-base)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                  {P.org.name}
                </div>
              </div>
            ) : (
              P.orgCreate === 'now' && (
                // a button, so the keyboard reaches it and it reads as one. The
                // resets after the well's own classes keep its look
                <Button
                  type="button"
                  variant="unstyled"
                  data-org-well
                  data-org-create
                  onClick={(e) => {
                    const opener = e.currentTarget
                    // the button leaves once the organization exists, and the
                    // rail's New project comes, as its first admin can create one
                    actions.createOrg(() =>
                      opener.isConnected
                        ? null
                        : (document.querySelector<HTMLElement>(
                            'aside [aria-label="New project"]',
                          ) ?? document.querySelector<HTMLElement>('aside [data-mine-nav]')),
                    )
                  }}
                  className="[display:flex] [align-items:center] [gap:8px] [padding:0_8px] [min-height:32px] [border-radius:var(--r-md)] [cursor:pointer] [color:var(--text-3)] [transition:background-color_var(--dur-fast)_var(--ease-out)] w-full border-0 bg-transparent text-left"
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--hover)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <Icon name="plus" size={16} />
                  <span className="[font-weight:600] [font-size:var(--fs-base)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                    Create your organization…
                  </span>
                </Button>
              )
            )}
          </div>

          {/* search → the search palette. Search only: it lists no commands and
          no standing suggestions, so this is the one thing the box does */}
          <div className="[padding:0_20px_8px]">
            <Button
              type="button"
              onClick={actions.openPalette}
              data-sidebar-search
              className="[display:flex] [align-items:center] [gap:8px] h-control [width:100%] [padding:0_8px] [background:transparent] [border:1px_solid_var(--border)] [border-radius:var(--r-md)] [color:var(--text-3)] [font-size:var(--fs-sm)] [cursor:pointer] [transition:border-color_var(--dur-fast)_var(--ease-out),_color_var(--dur-fast)_var(--ease-out)]"
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.color = 'var(--text-2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border)'
                e.currentTarget.style.color = 'var(--text-3)'
              }}
              variant="unstyled"
            >
              <Icon name="search" size={16} /> Search
            </Button>
          </div>

          {/* My view (deviation #49): the three views across every project,
          narrowed to the tasks assigned to ME on any seat I hold (0081). The
          first row because it is the personal surface (the inbox, the other
          one, is the top bar's first tab); All projects follows it. */}
          <div className="[padding:0_12px_4px]">
            <Button
              variant="quiet"
              type="button"
              aria-current={mineOn ? 'page' : undefined}
              data-on={mineOn ? '' : undefined}
              data-mine-nav
              onClick={() => actions.openMine()}
              className={navRow}
            >
              <Icon name="user" size={16} />
              <span>My view</span>
            </Button>
          </div>

          {/* All projects (deviation #47) opens the project directory, every
          project this login can reach by its own access, home organization
          and guest seats alike, its favorites first. It sits above the
          per-project list because it lists them all. */}
          <div className="[padding:0_12px_4px]">
            <Button
              variant="quiet"
              type="button"
              aria-current={allOn ? 'page' : undefined}
              data-on={allOn ? '' : undefined}
              data-all-nav
              onClick={() => actions.openProjects()}
              className={navRow}
            >
              <Icon name="layers" size={16} />
              <span>All projects</span>
            </Button>
          </div>

          {/* Team sync (deviation #316): the meeting page, always
          about the home organization, so a login without one has no row.
          No hover help, like every row of this rail. */}
          {P.homeOrg && (
            <div className="[padding:0_12px_4px]">
              <Button
                variant="quiet"
                type="button"
                aria-current={syncOpen ? 'page' : undefined}
                data-on={syncOpen ? '' : undefined}
                data-sync-nav
                onClick={() => actions.openSync()}
                className={navRow}
              >
                <Icon name="people" size={16} />
                <span>Team sync</span>
              </Button>
            </div>
          )}

          <SidebarProjects
            scope={scope}
            lit={scopeOn}
            actions={actions}
            focusRow={focusRow}
            onFocusRowDone={onFocusRowDone}
          />

          {/* Settings follows the project list with the same section gap as the
          brand and organization. The list shrinks to scroll only when needed;
          the footer stays outside it, without an expanding empty space.
          Lands on your own preferences; its own nav reaches the organization,
          the teams you lead and every project you can see, which is why the
          top bar no longer carries a per-project gear. (The Archive that sat
          here is Settings › Archived tasks, which a project row's "…" menu
          opens on that project.) */}
          <div className="planner-sidebar-footer shrink-0 px-3 pb-3 [padding-top:var(--sidebar-section-gap)]">
            <Button
              variant="ghost"
              type="button"
              data-settings-nav
              onClick={() => actions.openSettings()}
              className="w-full justify-start border-0 px-2 font-normal text-text-2 shadow-none has-[>svg]:px-2"
            >
              <Icon name="cog" size={16} />
              Settings
            </Button>
          </div>
        </div>
      </KeptInPlace>
    </aside>
  )
}

/* ---------- top bar ---------- */
/** A workspace view's container, which enters with a short rise. */
const VIEW_CLASS =
  'animate-in fade-in slide-in-from-bottom-1 [flex:1] [display:flex] [flex-direction:column] [overflow:hidden]'
/** The container of a kept page that brings its own entrance (the Inbox
    and Projects). */
const PAGE_CLASS = '[flex:1] [display:flex] [flex-direction:column] [overflow:hidden]'

const VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'chart' },
  { id: 'kanban', label: 'Board', icon: 'board' },
  { id: 'roadmap', label: 'Roadmap', icon: 'timeline' },
]

/* The desktop top bar: the Inbox glyph and the three views in one switch,
   then the Board's filter row. It stays up while the inbox is open, with the
   Inbox tab lit, so every view is one click from the inbox and back, and
   while the project chooser shows (components/ProjectChooser.tsx), so the
   Inbox tab and the view pills stay in reach; `info` is null then, and the
   bar's heading reads "Choose a project". `setView` must leave the inbox,
   so App hands it `navView`. Over Team sync the bar stays up the same way
   with nothing lit: the page is not a view of the scope, and a view tab
   leaves it for that view. */
function TopBar({
  info,
  view,
  inboxOpen,
  syncOpen,
  setView,
  filters,
  setFilters,
  tweaks,
  setTweak,
  actions,
}) {
  // Assignee lanes also arrange tasks inside a single sub-project; every
  // scope that shows a view offers them, as the store holds no list of a
  // scope's sub-projects to ask
  const showGrouping = !!info
  // View switching and task creation share the first row across all views.
  // Board filters/grouping sit below; Roadmap owns its own toolbar.
  const showFilters = !inboxOpen && !syncOpen && !!info && view === 'kanban'
  // the unread summary answers on the Inbox's channel, which App does not
  // follow, so the bar follows it itself
  usePlannerVersion('inbox')
  const badge = inboxBadge(P.inboxSummary)

  return (
    /* no rule under it either (deviation #63) — the bar is --chrome and the
       view below is --bg, and that value step is the boundary */
    <>
      {/* nothing at the right: creating a task belongs to the board itself
          (a status column's +, a side-board's +, an empty board's action), so
          the bar carries only the switcher (deviation #233) */}
      <WorkspaceHeader
        left={
          <h1 className="sr-only">
            {inboxOpen ? 'Inbox' : syncOpen ? 'Team sync' : (info?.name ?? 'Choose a project')}
          </h1>
        }
      >
        {/* view switcher — the centre of the bar, above everything it switches.
            It IS the shared <Seg>, not a copy of its drawing: the hand-rolled
            block that stood here had drifted to its own radius, height and
            font, and could drift again on the next edit to either one. */}
        {/* `data-view-switch` so a check can say WHICH "Board" it means: the
            grouping switcher beside it read "Boards" in its side-by-side
            layout until deviation #236 ("Separated" now), and
            `button:has-text("Board")` matched both. */}
        {/* The Inbox is a glyph with its unread count on the corner, split
            from the views by a rule: it is a place, not a view of the scope.
            The count is filled here, unlike an outlined count beside a label,
            because an outline cannot be read over the glyph's own lines. It
            comes from the server's unread summary (lib/inboxBadge.ts), so
            it shows "…" where it has no count and "12+" where it has only
            part of one, and no chip only for a current, complete zero. */}
        <div data-view-switch className="[justify-self:center]">
          <Seg
            fit
            value={inboxOpen ? 'inbox' : syncOpen ? 'sync' : view}
            onChange={(v) => (v === 'inbox' ? actions.openInbox() : setView(v))}
            options={[
              {
                value: 'inbox',
                icon: 'mail',
                ariaLabel: badge.tabName,
                badge: badge.chip !== null && (
                  <span
                    data-inbox-badge
                    data-inbox-badge-state={badge.state ?? undefined}
                    data-refreshing={badge.refreshing ? '' : undefined}
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-1.5 left-2.5 h-3.5 min-w-3.5 rounded-full bg-text-1 px-[3px] text-center font-mono text-[9px] leading-3.5 font-bold text-[var(--bg)] tabular-nums"
                  >
                    {badge.chip}
                  </span>
                ),
                divider: true,
              },
              ...VIEWS.map((v) => ({
                value: v.id,
                label: v.label,
                icon: v.icon,
              })),
            ]}
          />
        </div>
      </WorkspaceHeader>

      {/* ROW TWO — the board's own, and nothing but the board's: NARROW, then
          SHAPE. Clear, the search box and the four filters change what is on the
          board; Focus and the layout switcher change how it is arranged, which
          is why those two come last and the swimlane switcher ends the row.
          Centred as one cluster under the switcher rather than pushed to an
          edge: the row belongs to the board below it, not to the hidden title
          on its left. `flexWrap` is the honest
          cost of keeping every control visible at a narrow window — it wraps
          rather than clipping, the same bargain the roadmap's row makes.
          The shared alignment rhythm leaves 24px between this row and the
          view switcher (12px from each band), then one panel gap before the
          board, the Roadmap toolbar's gap above its timeline. */}
      {showFilters && (
        <WorkspaceToolbar>
          <div
            data-filter-row
            className="[display:flex] [align-items:center] [justify-content:center] [gap:8px] [padding:12px_20px_var(--panel-gap)] [flex-wrap:wrap]"
          >
            {/* one well of quiet controls — the view switcher's own panel, so
                the two rows read as one instrument (deviation #232) */}
            <div
              data-filter-well
              className="flex min-w-0 flex-wrap items-center justify-center gap-1 rounded-md border border-border bg-background p-1"
            >
              <ViewFilters
                info={info}
                filters={filters}
                setFilters={setFilters}
                actions={actions}
                searchWidth={180}
              />

              {/* Project layouts follow the scope; assignee lanes are available
                inside a single sub-project too. */}
              {showGrouping && (
                <Popover
                  width={242}
                  align="right"
                  button={(t) => (
                    <Button
                      type="button"
                      variant="quiet"
                      className="rounded-sm pr-2 has-[>svg]:pr-2"
                      data-group-menu
                      onClick={t}
                      title="Arrange tasks on the board"
                    >
                      <Icon name="layers" size={16} />
                      {/* the closed trigger says the choice in a word; the
                          menu below spells each layout out */}
                      {
                        {
                          swimlanes: 'Project',
                          assignees: 'Assignee',
                          pool: 'Pooled',
                          sideboards: 'Separated',
                        }[tweaks.metaViz]
                      }
                      <DropdownChevron />
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      <div className="[font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-3)] [padding:6px_8px_4px]">
                        Board layout
                      </div>
                      {[
                        ['swimlanes', 'Swimlanes by project', 'rows3'],
                        ['assignees', 'Swimlanes by assignee', 'people'],
                        ['pool', 'Pooled, one board', 'board'],
                        ['sideboards', 'Side-by-side boards', 'layers'],
                      ].map(([v, l, ic]) => (
                        <MenuItem
                          key={v}
                          active={tweaks.metaViz === v}
                          onClick={() => {
                            setTweak({ metaViz: v })
                            close()
                          }}
                        >
                          <Icon name={ic} size={15} />
                          {l}
                        </MenuItem>
                      ))}
                    </>
                  )}
                </Popover>
              )}
            </div>
          </div>
        </WorkspaceToolbar>
      )}
    </>
  )
}

/* ---------- toasts ---------- */

/* The visible toasts, at the top of the floating column so the app update and
   snapshot notices never cover them (lib/floatStack). A screen reader hears
   them through announce() (see showToast), so they carry no live role and are
   not read twice. */
function ToastHost({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null
  return createPortal(
    <div className="planner-toast-host">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-floating-surface
          // a notice that stays takes room, so it never covers a control
          // (lib/floatStack)
          data-float-sticky={t.sticky ? '' : undefined}
          // A modal layer below turns off pointer events on <body>, and a press
          // here would count as an outside press that closes it. Take the press
          // so Dismiss closes only the toast, as the update notice does. While
          // such a layer is open, a press also leaves focus inside it; otherwise
          // the text stays selectable.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            if (document.body.style.pointerEvents === 'none') event.preventDefault()
          }}
          className="pointer-events-auto animate-in fade-in slide-in-from-bottom-2 [display:flex] [align-items:center] [gap:8px] [padding:8px] [background:var(--surface-2)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-pop)] [font-size:var(--fs-base)] [color:var(--text-1)]"
        >
          <Icon name={toastLook(t.tone).icon} size={16} color={toastLook(t.tone).color} />
          <span className="min-w-0 [overflow-wrap:anywhere] [white-space:pre-line]">{t.text}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-control-xs h-control-xs"
            aria-label="Dismiss"
            // leave focus in the dialog or field the user was in
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => dismiss(t.id)}
          >
            <Icon name="close" size={16} />
          </Button>
        </div>
      ))}
    </div>,
    floatSlot('toasts'),
  )
}

/* Where a Team sync address opens the page for this viewer (the router's
   rule: the scope the person last picked, else none, which asks to choose,
   and the phone's own page for the bare link only). The pick is saved
   under its own key (UIPrefs.teamSyncScope): the older key held fallbacks
   to All projects the person never chose, so it reads as nothing. */
function syncPlaceFor(r: NonNullable<Route['sync']>, mobile: boolean): SyncPlace {
  return syncPlaceOf(r, { saved: P.loadUI().teamSyncScope, me: P.CURRENT_USER, mobile })
}

/* The page under Settings or Team sync, restored when it
   closes (Team sync never sits over itself, so its return has no sync). A
   restore uses it once: it is reset as it is read, and on any Back or
   Forward that leaves its page. */
type PageReturn = { inbox: boolean; projects: boolean; sync: SyncPlace | null }
const NO_RETURN: PageReturn = { inbox: false, projects: false, sync: null }

/** The page a UI state shows besides its open task, as one comparable
    string (App's pendingTask). */
const pageKey = (s: Omit<UiState, 'openIssue'>) =>
  JSON.stringify([
    s.scope ?? null,
    s.view ?? null,
    s.settingsPage ?? null,
    !!s.inboxOpen,
    !!s.projectsOpen,
    s.sync ?? null,
  ])

/** A check startup runs before it opens a project an address names by its
    organization and number: what projectNav.resolve is asked (`ask`), and
    the address the check holds while it runs, with the page it was
    reached on, as pendingTask holds a task's. An address by uuid and the
    remembered project open as the scope at once (ScopeOpened). */
type StartupCheck = {
  ask: ProjectAsk
  name: string | null
  of: 'address'
  address: { pathname: string; hash: string; page: string } | null
}

/** How the scope's project was opened, for what App says while the
    project cache checks it (scopeShows) and when it answers the project
    gone: the remembered project (UIPrefs.lastProject), an address, or a
    row, a jump or a move that names it. The name a row showed comes from
    the open rule (components/projectNavRows.tsx openedName). */
type ScopeOpened = { id: string; of: 'remembered' | 'address' | 'row' }

/** What the main pane shows in place of the views while no project is
    chosen, as App holds it beside an empty scope: a check on its way, one
    that could not finish with its sentence, the chooser with the note
    that says why no project opened and the project the access guard lost
    (`lost`, its id and its top-level project's), or, for a task address
    the workspace does not hold, the wait for the task's answer, which
    names its project. `n` tells one opening from the next, so only the
    newest check's answer counts. */
type Opening =
  | { kind: 'checking'; n: number; check: StartupCheck }
  | { kind: 'retry'; n: number; check: StartupCheck; line: string }
  | {
      kind: 'choose'
      n: number
      note: string | null
      lost: { id: string; top: string | null } | null
    }
  | { kind: 'task'; n: number }

/** What the chooser says for an address naming a project the person
    cannot open, and for a remembered project they can no longer open. */
const ADDRESS_UNAVAILABLE = 'That project is not available to you.'
const REMEMBERED_UNAVAILABLE = 'The project you opened last is no longer available to you.'

/** The remembered project (UIPrefs.lastProject), which the startup rule
    opens as the scope where the address names none, or undefined. */
const rememberedScope = (): string | undefined => P.loadUI().lastProject?.project_id || undefined

/** What the chooser shows for project scope `info` while the views wait
    for its project cache answer (App's scopeShows): "Opening <name>…"
    while it loads, the failure's sentence with Retry. */
function scopeOpeningShows(info: ScopeInfo, opened: ScopeOpened | null): ChooserShows {
  const of = opened?.id === info.id ? opened.of : 'row'
  // the cache's name, else the one the row that opened it showed, as a
  // Search result, which seeds nothing
  const name = info.name || (of === 'row' ? (openedName(info.id) ?? '') : '')
  // the refusal's sentence of whichever project the cache lists unchecked,
  // the scope's own or its top-level project's
  if (info.state === 'unchecked') {
    const apart = P.projectState(info.id) === 'unchecked' ? info.id : (info.topId ?? info.id)
    return { kind: 'retry', line: P.writeNote(apart) ?? "Couldn't open the project." }
  }
  if (info.state === 'failed')
    return {
      kind: 'retry',
      line: name
        ? `Couldn't open ${name}.`
        : of === 'remembered'
          ? "Couldn't check the project you opened last."
          : of === 'address'
            ? "Couldn't check that project."
            : "Couldn't open the project.",
    }
  return {
    kind: 'checking',
    line: name
      ? `Opening ${name}…`
      : of === 'remembered'
        ? 'Opening the project you opened last…'
        : of === 'address'
          ? 'Opening that project…'
          : 'Opening the project…',
  }
}

/** The note of the chooser for project scope `id` that the project cache
    answered gone (App's guard), with the name the scope showed. */
function lostNote(id: string, opened: ScopeOpened | null, name: string | null): string {
  if (opened?.id === id && opened.of === 'remembered') return REMEMBERED_UNAVAILABLE
  if (opened?.id === id && opened.of === 'address' && !name) return ADDRESS_UNAVAILABLE
  return `${name ?? 'That project'} is no longer available to you.`
}

/** The person a Team sync jump opened the chooser for (App showPersonOn):
    their profile id and first name, for the chooser's line. */
type PersonJump = { id: string; first: string }

/** A person jump's history mark (jumpMarkOf): the person, and the view the
    chooser last showed on its entry, which the front door does not name. */
type JumpMark = PersonJump & { view: 'overview' | 'kanban' | 'roadmap' }

/** Whether `view` is one the chooser shows on, which a jump mark names. */
const isChooserView = (view: unknown): view is JumpMark['view'] =>
  view === 'overview' || view === 'kanban' || view === 'roadmap'

/** Whether `filters` hold what a person jump set: the one person `id` and
    nothing else, Focus aside. */
function holdsPerson(filters: Omit<IssueFilters, 'focus'>, id: string): boolean {
  return (
    filters.search === '' &&
    !filters.mine &&
    filters.priority === null &&
    !filters.stale &&
    filters.assignees.length === 1 &&
    filters.assignees[0] === id
  )
}

/** The person a history entry's state marks as the one its chooser was
    opened for, with the view it showed on (qivoJump, which App's address
    sync writes on a person jump's entry), else null. */
function jumpMarkOf(state: unknown): JumpMark | null {
  const mark: unknown =
    state && typeof state === 'object' ? Reflect.get(state, 'qivoJump') : undefined
  if (!mark || typeof mark !== 'object') return null
  const id: unknown = Reflect.get(mark, 'id')
  const first: unknown = Reflect.get(mark, 'first')
  const view: unknown = Reflect.get(mark, 'view')
  return typeof id === 'string' && typeof first === 'string' && isChooserView(view)
    ? { id, first, view }
    : null
}

/** `state` with the person jump mark `mark` (jumpMarkOf), or without one
    for null, as a copy when that changes it. */
function withJumpMark(state: unknown, mark: JumpMark | null): unknown {
  const was = jumpMarkOf(state)
  if (
    mark === null
      ? was === null
      : was?.id === mark.id && was.first === mark.first && was.view === mark.view
  )
    return state
  const entry: Record<string, unknown> = state && typeof state === 'object' ? { ...state } : {}
  const { qivoJump: _mark, ...rest } = entry
  return mark === null ? rest : { ...rest, qivoJump: mark }
}

/** What the chooser shows for `opening`, which waits for no task. */
function chooserShows(opening: Exclude<Opening, { kind: 'task' }>): ChooserShows {
  if (opening.kind === 'choose') return { kind: 'choose', note: opening.note }
  if (opening.kind === 'retry') return { kind: 'retry', line: opening.line }
  return { kind: 'checking', line: 'Opening that project…' }
}

/** The project address `opening` checks on page `page` (pageKey), or
    checked there for Retry, as one comparable string; null where it
    checks no address on that page. */
function checkedOn(opening: Opening, page: string): string | null {
  if (opening.kind !== 'checking' && opening.kind !== 'retry') return null
  return opening.check.address?.page === page ? JSON.stringify(opening.check.ask) : null
}

/** Says politely, through the page's announcer (lib/announce), which modal
    layers leave audible, when every task starts loading for a page or
    action that needs them, when every task has loaded, and when the load
    stopped. The caller renders on every store change (usePlannerVersion). */
function useTasksLoadingNews() {
  const load = P.taskLoad()
  const state = load.state
  const reason = load.state === 'failed' ? load.reason : ''
  // whether the start was said, so the end is said only after it
  const said = useRef(false)
  useEffect(() => {
    if (state === 'arriving') {
      said.current = true
      announce('Loading every task. What asked for them continues once they are in.')
    } else if (state === 'failed') {
      said.current = true
      announce(`${TASKS_FAILED_TEXT} ${reason}`)
    } else if (said.current) {
      said.current = false
      announce('Every task has loaded.')
    }
  }, [state, reason])
}

/* ---------- root ---------- */
/** A task address's scope to settle once the project cache names the
    task's project (App's scopeToSettle). */
type ScopeSettle = { issue: string; task: ScopeTask; preferred: string }

/** The project cache owner under which App names the project of a task
    whose scope it settles. */
const SETTLE_OWNER = 'task scope'

/** The scope `chosen` that scopeForIssue gave task `task`, open as
    `issue`, over `preferred`, to settle once the project cache names the
    task's project, when it kept the preferred scope only for want of that
    name (taskProjectPending), else null. */
function settleOf(
  issue: string | null | undefined,
  task: ScopeTask | undefined,
  preferred: string | null | undefined,
  chosen: string | undefined,
): ScopeSettle | null {
  return issue && task && preferred && chosen === preferred && taskProjectPending(task)
    ? { issue, task, preferred }
    : null
}

function App() {
  const mobile = useMobile()
  const ui0 = P.loadUI()
  /* Deep link wins over the remembered project. Two grammars are read, in
     order: the path, then — only if the path named nothing — a pre-path
     HASH link (#/board/p/12), which is every link shared before the move.
     The url-sync effect below then rewrites the address to the path form on
     the first commit, so a legacy link is translated exactly once and never
     again. Both return null for "named nothing", the front door, which
     opens the remembered project once the server checked it, else the
     project chooser (opening). */
  const r0 = parsePath(location.pathname) || parseHash(location.hash)
  // a scope is either a project's id or My view's sentinel; a project scope
  // opens at once and the project cache checks it (scopeShows)
  const liveScope = (s: string | null | undefined): s is string => !!s
  // the remembered project (UIPrefs.lastProject), which a task address
  // prefers when the project cache names it as the task's
  const remembered = rememberedScope() ?? null
  // prefs saved before the merge may still say "split"/"resources" — both
  // collapsed into the roadmap (which now always docks the resource strip)
  const uiView0 = ui0.view === 'split' || ui0.view === 'resources' ? 'roadmap' : ui0.view
  const uiView = ['overview', 'kanban', 'roadmap'].includes(uiView0) ? uiView0 : 'overview'
  // issue URLs carry no scope segment (the issue names its own project):
  // keep the remembered project when the issue lives inside it, else jump
  // to the issue's sub-project — link recipients land on a board that
  // shows it (scopeForIssue). A task over Team sync is the exception, as
  // that page names its own scope. A task the workspace does not hold boots
  // with no scope, and its answer names its project (pendingTask).
  const task0 = r0?.issue ? scopeTaskOf(r0.issue) : undefined
  const r0Scope =
    r0 && !r0.sync ? r0.scope || (task0 ? scopeForIssue(task0, remembered) : undefined) : undefined
  // whether the address waits for a task the workspace does not hold, or
  // for the check of a project it names by number or cannot name, either
  // of which decides the scope itself (opening below)
  const r0Waits =
    !!r0 && !r0.sync && ((!!r0.issue && !task0) || (!r0.issue && r0.unheld !== undefined))
  // the address's scope, else for any other address that names no scope,
  // as the front door, a view's or a page's address, an address that once
  // named all projects and Team sync's, the remembered project (the startup
  // rule), or none: the boot never falls back to the first project or My
  // view (opening below)
  const bootScope = liveScope(r0Scope) ? r0Scope : r0Waits ? undefined : rememberedScope()
  const [scope, setScope] = useState<string | undefined>(bootScope)
  /* How the scope's project was opened (ScopeOpened), for the chooser's
     line while the project cache checks it and its note once it answers
     the project gone. */
  const scopeOpened = useRef<ScopeOpened | null>(
    bootScope && !P.isMineScope(bootScope)
      ? { id: bootScope, of: liveScope(r0Scope) ? 'address' : 'remembered' }
      : null,
  )
  /* The scope a task's address chose at the boot, on Back or Forward, or
     by the answer of a task the workspace did not hold, which the save
     effect does not remember: the person read a task there, and did not
     pick its project. Any scope the person moves to (move) ends it. */
  const taskScope = useRef<string | null>(
    liveScope(r0Scope) && !r0?.scope && task0 ? (r0Scope ?? null) : null,
  )
  /* A task address whose scope kept the preferred project only because the
     project cache had not named the task's project yet (scopeForIssue),
     which the settle effect below revisits once the cache names it: the
     open task, its project and owner, and the preferred project. */
  const scopeToSettle = useRef<ScopeSettle | null>(
    r0 && !r0.sync && !r0.scope ? settleOf(r0.issue, task0, remembered, r0Scope) : null,
  )
  /** Marks the scope `chosen` that scopeForIssue gave task `task`, open as
      `issue`, over `preferred`, to settle (settleOf). */
  const settleLater = (
    issue: string | null | undefined,
    task: ScopeTask | undefined,
    preferred: string | null | undefined,
    chosen: string | undefined,
  ) => {
    scopeToSettle.current = settleOf(issue, task, preferred, chosen)
  }
  // counts the person's scope moves, so one that keeps the scope as it was
  // commits too and the save effect looks again
  const [, setPicks] = useState(0)
  const [view, setView] = useState(() =>
    // a viewless issue short link keeps the saved view (the modal sits over
    // whatever's behind), and so does Team sync, which returns to it on Done;
    // scope/settings routes without a view mean overview
    r0?.view
      ? r0.view
      : r0?.issue || r0?.sync || (mobile && (r0?.settings || r0?.projects || r0?.inbox))
        ? uiView
        : r0
          ? 'overview'
          : uiView,
  )
  const [openIssue, setOpenIssue] = useState(r0?.issue || null)
  // A new task's handle is a preview that moves when another person's create
  // takes its number while the write waits, and a change of the home
  // organization moves the handles of the old and the new home organization's
  // tasks. A reference (lib/taskReference.ts) moves to its task's handle once
  // the workspace holds the task. The open window follows its task, with
  // every move of one repaint applied at once.
  useEffect(
    () => P.watchHandles((moved) => setOpenIssue((cur) => (cur && moved.get(cur)) || cur)),
    [],
  )
  /* Has this address changed hands since this login last followed it? Computed
     once, at boot, from the address the browser actually arrived at — a later
     read would see the canonical path the url-sync effect writes, which is
     built from the store and therefore always agrees with itself. */
  const [addrMoved, setAddrMoved] = useState(() => {
    const seg = orgSegmentOf(location.pathname)
    if (!seg || seg === ORG_NONE) return null
    const org = P.orgBySlug(seg)
    if (!org) return null // unresolvable: not this login's to be warned about
    return addressMoved(P.CURRENT_USER, seg, org.id) ? { slug: seg, org } : null
  })
  // "Plan on roadmap": spotlight an issue on the roadmap after jumping there
  // from the issue window. { id, n } — n is a nonce so re-planning the same
  // issue re-triggers the spotlight even when the id is unchanged.
  const [focusPlan, setFocusPlan] = useState<
    ({ id: string; n: number; key?: string; status?: string } & Partial<TaskPlace>) | null
  >(null)
  const focusN = useRef(0)
  // Show a task in the view: its bar on the Roadmap (Team sync's jump, a
  // parent's Plan on roadmap), or its card on the Board behind its task
  // window (Team sync, the Inbox, the task crumb, search). { id, n } like
  // focusPlan; the nonce comes from the same counter.
  const [revealTask, setRevealTask] = useState<RevealRequest | null>(null)
  const reveal = (id: string, atOnce = false, key?: string, place?: TaskPlace) => {
    focusN.current += 1
    setRevealTask({ id, n: focusN.current, atOnce, ...(key ? { key } : {}), ...place })
  }
  /* The nonce of a reveal planOnRoadmap asked for, dropped with the plan
     request once another page covers the Roadmap (below roadmapActive). */
  const roadmapReveal = useRef<number | null>(null)
  // current scope and layout for the popstate handler (registered once, deps [])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const mobileRef = useRef(mobile)
  mobileRef.current = mobile
  // focus (hide Backlog & Done on board/roadmap) is a per-user persisted mode
  // riding in the filters object so P.passesFilters sees it; the ephemeral
  // filters reset with Clear, focus follows the user via user_prefs
  const [filters, setFilters] = useState({
    search: '',
    mine: false,
    assignees: [],
    priority: null,
    stale: false,
    focus: !!ui0.focus,
  })
  const [tweaks, setTweaks] = useState(() => ({
    metaViz: ui0.metaViz || 'swimlanes',
  }))
  // {kind:"issue"|"program"|"subproject"|"milestone"|"createorg", init,
  // focusAfterClose}. The opener gives focusAfterClose (ModalShell) when it
  // leaves while the dialog is open, as a menu row does
  const [modal, setModal] = useState(null)
  // the sub-project New sub-project created last, for afterNewSubProject
  const createdProject = useRef<string | null>(null)
  /* Where focus goes in the commit that moves App into a project that has
     finished saving (projectTarget), when it is nowhere or in a page that
     move hides, such as the Projects page with its New project or a row's
     menu button. A kept view hidden behind another page takes no focus. */
  const focusAfterMove = useRef<(() => HTMLElement | null) | null>(null)
  /* The sidebar's request to focus a project's row once its tree shows it
     (components/SidebarProjects.tsx), which the server's list brings only
     after the save, with the scope it was made in. App holds it, not the
     tree, so a tree mounted again, as after the phone's layout, never takes
     it twice.
     It is made only while the desktop's rail shows (not on the phone, nor
     while Settings hides the tree), and it ends once the tree is done with
     it (doneFocusRow), or the scope moves or the rail leaves or hides
     (focusRowLive below). */
  const [focusRow, setFocusRow] = useState<(FocusRow & { scope: string }) | null>(null)
  const askFocusRow = (id: string, at: string) => {
    if (!hereRef.current.settingsPage && !mobileRef.current)
      setFocusRow((was) => ({ id, scope: at, n: (was?.n ?? 0) + 1 }))
  }
  const doneFocusRow = (n: number) => setFocusRow((was) => (was?.n === n ? null : was))
  useLayoutEffect(() => {
    const target = focusAfterMove.current
    focusAfterMove.current = null
    if (!target) return
    const active = document.activeElement
    const nowhere = !active || active === document.body || !active.isConnected
    if (nowhere || active.closest(OUT_OF_USE)) restoreFocus(target())
  })
  const [settingsPage, setSettingsPage] = useState(r0?.settings || null) // null | "account" | "org-*" | "team:<id>" | "project:<id>" | "project:<org>/<num>"
  // the tree's focus request while the desktop's rail shows the scope it
  // was made in; once not, it ends, so it never comes back
  const focusRowLive =
    focusRow && !mobile && !settingsPage && focusRow.scope === scope ? focusRow : null
  useLayoutEffect(() => {
    if (focusRow && !focusRowLive) setFocusRow(null)
  })
  const [inboxOpen, setInboxOpen] = useState(!!r0?.inbox || (mobile && !r0)) // the message inbox (0074)
  const [projectsOpen, setProjectsOpen] = useState(!!r0?.projects)
  /* Team sync (the meeting page) while it is open: { scope, step }. It sits
     over the scope and view, which it leaves untouched so Done returns to
     them. Only a login with a home organization has the page. */
  const [sync, setSync] = useState<SyncPlace | null>(() =>
    r0?.sync && P.homeOrg ? syncPlaceFor(r0.sync, mobile) : null,
  )
  /* What the main pane shows while the scope is empty (Opening,
     ProjectChooser). A project address by number (Route.unheld) is
     checked through projectNav.resolve, holding its address, and one no
     read can ask about, under a slug this login cannot resolve, shows the
     chooser with a note. A task address the workspace does not hold waits
     for the task's answer. Any other address that names no scope takes the
     startup rule: the remembered project as the scope at once (bootScope),
     which the project cache checks, else the chooser. */
  const openingN = useRef(0)
  const [opening, setOpening] = useState<Opening>(() => {
    if (r0 && !r0.sync && r0.issue && !task0) return { kind: 'task', n: 0 }
    if (r0 && !r0.sync && !r0.issue && r0.unheld === null)
      return { kind: 'choose', n: 0, note: ADDRESS_UNAVAILABLE, lost: null }
    if (r0 && !r0.sync && !r0.issue && r0.unheld) {
      const page = pageKey({ scope, view, settingsPage, inboxOpen, projectsOpen, sync })
      const address = { pathname: location.pathname, hash: location.hash, page }
      return {
        kind: 'checking',
        n: 0,
        check: { ask: r0.unheld, name: null, of: 'address', address },
      }
    }
    return { kind: 'choose', n: 0, note: null, lost: null }
  })
  /** Shows `next`, made with the next opening number, in the main pane. */
  const showOpening = (next: (n: number) => Opening) => {
    openingN.current += 1
    setOpening(next(openingN.current))
  }
  /** The startup rule where nothing names a scope: the remembered project
      as the scope at once, which the project cache checks, else the
      chooser. */
  const openStartup = () => {
    const id = rememberedScope()
    showOpening((n) => ({ kind: 'choose', n, note: null, lost: null }))
    if (!id) return
    scopeOpened.current = { id, of: 'remembered' }
    setScope(id)
  }
  // the opening on screen, for the popstate handler and startup's check
  const openingRef = useRef(opening)
  openingRef.current = opening
  /* The scope as the project cache answers for it (P.scopeInfo): My view,
     or a project with its facts and where it and its top-level project
     stand there. A project scope is set at once, so its views mount only
     once they can ask about it (scopeShows): while the cache knows no
     facts of it before its first ok, the main pane shows the chooser's
     "Opening <name>…", and its failure's sentence with Retry. A navigation
     row seeds the facts (P.seedProjects), so the views ask at once while
     the cache reads it. After the scope's first ok the views stay mounted
     through a reread, a failure, a hidden tab or a reconnect, with their
     own notes; only the cache's gone moves the scope to the chooser's lost
     note (the access guard). */
  const scopeInfo = scope ? P.scopeInfo(scope) : null
  const everOk = useRef<string | null>(null)
  if (scopeInfo && !scopeInfo.mine && scopeInfo.state === 'ok') everOk.current = scopeInfo.id
  const scopeShows =
    !!scopeInfo &&
    (scopeInfo.mine ||
      scopeInfo.state === 'ok' ||
      (scopeInfo.state !== 'gone' && everOk.current === scopeInfo.id) ||
      (scopeInfo.state === 'loading' && !!scopeInfo.proj))
  // the scope the views show, null while they wait for it
  const viewInfo = scopeShows ? scopeInfo : null
  /* The scope's project as the project cache named it last: its id, its
     name and its top-level project's id, for the access guard's note and
     Settings' onProjectGone once the cache answers it gone. */
  const scopePlace = useRef<{ id: string; top: string | null; name: string } | null>(null)
  if (scopeInfo?.proj)
    scopePlace.current = {
      id: scopeInfo.proj.id,
      top: scopeInfo.topId,
      name: scopeInfo.proj.name,
    }
  /** The main page on screen, none while Settings shows. */
  const shownPage: MainPage | null = settingsPage
    ? null
    : sync
      ? 'sync'
      : inboxOpen
        ? 'inbox'
        : projectsOpen
          ? 'projects'
          : view === 'overview' || view === 'roadmap' || view === 'kanban'
            ? view
            : null
  // the Board (or the phone's task list) is what the main pane shows
  const boardActive = shownPage === 'kanban'
  /* The main pages that stay loaded, hidden, while another page shows
     (lib/keptPages.ts, components/KeptView.tsx), until the person leaves
     the app alone for KEEP_IDLE_MS. */
  const [kept, setKept] = useState(NO_PAGES)
  /* Done on Team sync's last step ends the sitting (closeSync): the page
     goes once it no longer shows, so the next sitting opens anew, with no
     review ticks. */
  const [syncEnded, setSyncEnded] = useState(false)
  const syncGoes = syncEnded && shownPage !== 'sync'
  if (syncGoes) setSyncEnded(false)
  const keep = keptPages({
    kept: syncGoes ? withoutPage(kept, 'sync') : kept,
    scope,
    scopeLive: !!viewInfo,
    shown: shownPage,
  })
  if (keep !== kept) setKept(keep)
  useInputIdle(KEEP_IDLE_MS, () => setKept(releasePages(keep, shownPage)))
  // a Board page that is no longer kept takes the rows its read kept with
  // it (store/viewRows.ts)
  const boardKept = keep.pages.includes('kanban')
  useEffect(() => {
    if (boardKept) return
    for (const slot of Object.values(BOARD_SLOTS)) P.releaseView(slot)
  }, [boardKept])
  // and so does a Roadmap page, its two reads and the owners Team
  // utilization and the planning panel registered
  const roadmapKept = keep.pages.includes('roadmap')
  useEffect(() => {
    if (!roadmapKept) P.releaseRoadmap()
  }, [roadmapKept])
  // and so does an Overview page, its reads and the rows of its lists
  const overviewKept = keep.pages.includes('overview')
  useEffect(() => {
    if (!overviewKept) P.releaseOverview()
  }, [overviewKept])
  // and so does Team sync, its agenda's read and rows, an organization
  // Viewer's people's loads and the last comments' marks, also when Done
  // ends the sitting, and its opening's milestone reads, which stop while
  // a person's page shows and keep their answers until then
  const syncKept = keep.pages.includes('sync')
  useEffect(() => {
    if (syncKept) return
    P.releaseSync()
    for (const slot of Object.values(SYNC_MILESTONE_SLOTS)) P.releaseMilestones(slot)
  }, [syncKept])
  /** The id a page's ViewKeeper keeps it under: its scope for a page that
      shows one, so a new scope mounts it anew; null once it is not kept. */
  const keptId = (page: MainPage) =>
    keep.pages.includes(page) ? (showsScope(page) ? keep.scope : page) : null
  /* The Inbox's task pane is a window over it: a hidden Inbox holds none,
     as leaving the Inbox closes its task. A hidden Team sync holds the
     place it showed last. */
  const inboxTask = shownPage === 'inbox' ? openIssue : null
  const lastSync = useRef(sync)
  if (sync) lastSync.current = sync
  const syncPlace = sync ?? lastSync.current
  // Where the user is, as the address mirrors it: a project create that
  // finishes saving moves the user into the project only if this is unchanged.
  // The ref follows committed renders only.
  const place = JSON.stringify([
    scope,
    view,
    openIssue,
    settingsPage,
    inboxOpen,
    projectsOpen,
    sync,
  ])
  const placeRef = useRef(place)
  useLayoutEffect(() => {
    placeRef.current = place
  }, [place])
  const here: UiState = { scope, view, openIssue, settingsPage, inboxOpen, projectsOpen, sync }
  // for the popstate handler, like scopeRef
  const hereRef = useRef(here)
  hereRef.current = here
  // the text typed in the task window (with the Inbox) and in the page
  const [unsent] = useState(() => ({ task: createUnsentScope(), page: createUnsentScope() }))
  // a refused Back or Forward (lib/popRefusal), for the popstate handler
  const [refusal] = useState(() => createPopRefusal(closeOrAsk))
  /** `scopes` with the task window over Settings › Archived tasks when a
      move from `from` to `to` leaves that page, which closes the window. */
  const withSettingsTask = (from: UiState, to: UiState, scopes: UnsentScope[]) =>
    settingsTaskRef.current !== null && to.settingsPage !== from.settingsPage
      ? [...scopes, unsent.task]
      : scopes
  /** Runs `go`, a user's move to the place `next` patches in, once the
      windows it closes hold no unsent text, or after the person chose
      Discard. Raw setters remain for moves the person did not ask for.
      The accepted move drops every open that waits and startup's check
      (navMoved). */
  const move = (next: UiState, go: () => void) => {
    const to = { ...hereRef.current, ...next }
    closeOrAsk(withSettingsTask(hereRef.current, to, closedBy(hereRef.current, to, unsent)), () => {
      // a scope the person moves to is theirs to remember, also the one a
      // task's address chose, which the save effect would not see change
      if (next.scope !== undefined) {
        taskScope.current = null
        setPicks((n) => n + 1)
      }
      navMoved()
      go()
    })
  }
  // edits made on the sync page are not roadmap edits, whatever the view below
  const roadmapActive = view === 'roadmap' && !settingsPage && !inboxOpen && !projectsOpen && !sync
  useLayoutEffect(() => {
    P.roadmapContext(roadmapActive, !!openIssue)
  }, [roadmapActive, openIssue])
  /* A Plan on roadmap request waits while the Roadmap waits for an answer
     that holds its task (views/Roadmap.tsx). It holds only while the
     Roadmap stays on screen. Another view, or the Inbox, Projects, Settings
     or Team sync page over the Roadmap, drops the plan request and the
     reveal planOnRoadmap asked for, so a later visit starts no planning
     session and writes no dates the person no longer asked for. */
  useEffect(() => {
    if (roadmapActive) return
    setFocusPlan(null)
    const asked = roadmapReveal.current
    roadmapReveal.current = null
    if (asked !== null) setRevealTask((request) => (request?.n === asked ? null : request))
  }, [roadmapActive])
  useLayoutEffect(() => () => P.roadmapContext(false, false), [])
  // the page Settings and Team sync return to on exit
  const settingsReturn = useRef(NO_RETURN)
  const syncReturn = useRef(NO_RETURN)
  const replaceNextHistory = useRef(false)
  // bumped each time a page move the url sync waited for has landed, so it
  // looks again: the return from a refused Back or Forward (lib/popRefusal),
  // which no other popstate listener hears, or the step off a phone layer's
  // spare over the session's first entry (lib/pageHistory)
  const [settled, setSettled] = useState(0)
  useEffect(() => onHistorySettled(() => setSettled((n) => n + 1)), [])
  /* The address the boot, Back or Forward reached, when it names a task the
     workspace does not hold, by a reference (`ref`, lib/taskReference.ts)
     that the task window reads from the server. The address stays as it
     was while the page does (`page`), until the answer names the task's
     project. The scope then moves to the one Back or Forward would have
     chosen for the task (`scope`, `preferred`), in place, unless the page
     moved meanwhile. An unavailable or failed answer moves nothing, and
     the window and the address stay until the window closes. */
  const [bootHold] = useState(() =>
    r0?.issue && !scopeTaskOf(r0.issue)
      ? {
          pathname: location.pathname,
          hash: location.hash,
          ref: r0.issue,
          page: pageKey({ scope, view, settingsPage, inboxOpen, projectsOpen, sync }),
          scope: r0.scope,
          preferred: remembered,
        }
      : null,
  )
  const pendingTask = useRef<{
    pathname: string
    hash: string
    ref: string
    page: string
    scope?: string
    preferred: string | null
  } | null>(bootHold)
  /* The boot reads the task its address names with the first parts
     (AuthGate, store/liveParts.ts `address`), and the window that opens it
     takes that read over. An address the router reads as no task, such as
     a mistyped one, opens no window, so the read stops once App shows. */
  const [bootTask] = useState(() => !!r0?.issue)
  useEffect(() => {
    if (!bootTask) P.watchTaskRef(null)
  }, [bootTask])
  // the project an "Archived tasks" entry asked for; null = derive from the
  // current scope (Settings' own Archived tasks item, deep links)
  const [archiveProject, setArchiveProject] = useState<string | null>(null)
  // it holds only while Archived tasks stays open, so leaving the page by
  // any way, Settings' own items and history included, forgets it
  useEffect(() => {
    if (settingsPage !== ARCHIVED_TASKS_PAGE) setArchiveProject(null)
  }, [settingsPage])
  /* The task an Archived tasks row opened, by its handle or a reference
     (lib/taskReference.ts), which the task window shows over Settings. It
     is App's own, apart from openIssue, so the address stays the page's,
     and the address sync and the moves of a task named by a reference never
     see it. It goes when Settings closes or shows another page, and follows
     its task's handle as the floating window does. */
  const [settingsTask, setSettingsTask] = useState<string | null>(null)
  const settingsTaskRef = useRef(settingsTask)
  settingsTaskRef.current = settingsTask
  useEffect(() => {
    if (settingsPage !== ARCHIVED_TASKS_PAGE) setSettingsTask(null)
  }, [settingsPage])
  useEffect(
    () => P.watchHandles((moved) => setSettingsTask((cur) => (cur && moved.get(cur)) || cur)),
    [],
  )
  /* Closes that window once it holds no unsent text, or after Discard. On a
     phone the window holds a Back step of its own, which a close by Escape
     or by its own Back button takes with it. */
  const closeSettingsTask = useMobileBackLayer(!!settingsTask, () =>
    closeOrAsk([unsent.task], () => setSettingsTask(null)),
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  // the project Search opens on, as the Board's pointer to it sets it
  const [paletteIn, setPaletteIn] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const rev = usePlannerVersion()
  // The read of a task App holds by a reference (lib/taskReference.ts)
  // answers on the comments channel: App follows what the store knows of
  // that task while it holds one (lib/router.ts taskFacts), which is all
  // the address and the pending task's scope below read of it, so the
  // address names what the answer taught and the page moves to the task's
  // project (pendingTask), and whether its read ended with no project,
  // which ends a boot's wait for it (opening). Any other emit of the
  // channel, such as each section answer of a new task's window, renders
  // no App. Null otherwise, which renders nothing.
  const refRev = useSyncExternalStore(P.updates.comments.subscribe, () =>
    isTaskRef(openIssue)
      ? JSON.stringify([taskFacts(openIssue) ?? null, P.reference?.state ?? null])
      : null,
  )
  // A project settings page names the organization of a project the
  // workspace does not hold once its read answers (lib/router.ts
  // noteProjectPage), which the address follows in place.
  const pagesRev = useSyncExternalStore(subscribeProjectPages, projectPagesRev)
  // The Roadmap and Team sync read their tasks from the server, so no page
  // waits for every task
  useTasksLoadingNews()

  // date rendering follows the organization's format setting; set during
  // render so everything below formats consistently on this pass
  P.setDateFormat(P.org.dateFormat)

  // toasts
  useEffect(() => {
    // the expiry timers still pending, by toast id. When App goes, or Fast
    // Refresh runs this effect again, they end with their toasts, so none
    // sets state after App and no toast stays without its timer.
    const expiries = new Map<number, ReturnType<typeof setTimeout>>()
    window.showToast = (text, tone, opts = {}) => {
      const id = ++toastSeq
      announce(text, toastLook(tone).politeness)
      const { sticky, key, onDismiss } = opts
      setToasts((t) => withToast(t, { id, text, tone, sticky, key, onDismiss }))
      if (sticky) return
      const expiry = setTimeout(() => {
        expiries.delete(id)
        setToasts((t) => t.filter((x) => x.id !== id))
      }, 4200)
      expiries.set(id, expiry)
    }
    // a keyed toast whose news no longer holds, such as a bulk Inbox
    // action's stop that a later run finished
    window.dismissToast = (key) => setToasts((t) => t.filter((x) => x.key !== key))
    return () => {
      for (const expiry of expiries.values()) clearTimeout(expiry)
      setToasts((t) => t.filter((x) => !expiries.has(x.id)))
      window.showToast = null
      window.dismissToast = null
    }
  }, [])
  const dismissToast = (id: number) => {
    // outside the updater, which React may run twice
    toasts.find((x) => x.id === id)?.onDismiss?.()
    setToasts((t) => t.filter((x) => x.id !== id))
  }

  // After the first paint, download the code of every view not opened yet,
  // so each still opens if the connection drops. What this person can use
  // is asked again whenever the list goes on after a pause.
  useEffect(
    () =>
      preloadInBackground(() =>
        workspaceModules({
          // a seat of the login that is not an organization Viewer may
          // hold Edit somewhere, a guest seat included
          editor: P.users.some(
            (u) => P.myProfileIds.includes(u.id) && u.active && u.orgRole !== 'viewer',
          ),
          admin: P.isAdmin(),
        }),
      ),
    [],
  )

  // ui persistence: the view, as it changes
  useEffect(() => {
    P.saveUI({ view })
  }, [view])
  /* The remembered project (UIPrefs.lastProject): a project scope whose
     project cache state is ok while the Overview, the Board or the Roadmap
     shows it, however the person got there, sent at once, so a reload right
     after a pick opens it. A scope that changes under the Inbox, Team sync,
     the directory or Settings writes nothing until a view of it shows, and
     neither do My view, no scope, and a scope a task's
     address chose (taskScope). A loss never clears it. */
  const viewShown = !!shownPage && showsScope(shownPage)
  // the views' place shows the project chooser while no scope is chosen,
  // and while a project scope waits for the project cache (scopeShows)
  const chooserShown = viewShown && !viewInfo
  /* The person a Team sync jump over all projects or a team opened the
     chooser for (showPersonOn), while the filters hold exactly what the
     jump set, one person and nothing else (holdsPerson). The chooser then
     says whose tasks a pick will show (jumpLine). Any filter change and any
     chosen scope end it. The jump's history entry carries the person and
     the view its chooser shows on (qivoJump, the address sync below), so a
     Back or Forward onto it shows the chooser on that view, with its line,
     again while the filters still hold that person, also after a Back past
     Team sync to a project ended the jump, rather than the startup rule
     or, on a phone, the Inbox (onPop). */
  const [personJump, setPersonJump] = useState<PersonJump | null>(null)
  const jumpHolds =
    personJump !== null && scope === undefined && holdsPerson(filters, personJump.id)
  if (personJump !== null && !jumpHolds) setPersonJump(null)
  // the filters for onPop, which reads them against a jump's entry
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  /* What the chooser says a pick will show after a person jump: that
     person's tasks on the Board or the Roadmap, which show the person
     filter, or on a phone in the project's task list, which a pick opens
     (ProjectChooser's line). None on the Overview, which has no filter. */
  const jumpLine =
    jumpHolds && chooserShown && personJump && (view === 'kanban' || view === 'roadmap')
      ? mobile
        ? `Choose a project to see ${personJump.first}'s tasks in its task list.`
        : `Choose a project to see ${personJump.first}'s tasks on the ${view === 'kanban' ? 'Board' : 'Roadmap'}.`
      : null
  // the scope's project cache state, which a scope opened from a row
  // reaches after it is set, so the rule looks again after every commit and
  // writes only what changed
  const scopeOk = scopeInfo?.state === 'ok'
  useEffect(() => {
    if (!viewShown || !scope || P.isMineScope(scope) || taskScope.current === scope) return
    const p = P.project(scope)
    if (!p || !scopeOk) return
    const was = P.loadUI().lastProject
    if (was?.project_id === p.id && was.org_id === p.org) return
    P.saveUINow({ lastProject: { org_id: p.org, project_id: p.id } })
  })

  // url sync — every "page" (scope/view/open issue/settings) gets its own
  // path. rev is a dependency on purpose: paths embed store-derived refs (the
  // scope project's num, the owning org's slug — which an admin can now
  // change, and which arrives here over realtime), and an insert reconcile can
  // correct them without any of the other deps changing. Re-running on store
  // emits lets the address bar self-heal, and the equality early return makes
  // that free. Synchronize during the commit: a passive effect can run after
  // native Back has changed the URL and push the previous page back into history.
  useLayoutEffect(() => {
    // the address is not the page's while the page returns from a refused
    // Back or Forward, or steps off a spare (lib/pageHistory), and a write
    // now would move the entry it goes to (it looks again once landed)
    if (historyBusy()) return
    // a task the boot, Back or Forward reached by its address keeps that
    // address until its answer names its project, while the page and the
    // address are still the ones it reached (pendingTask)
    const pending = pendingTask.current
    const state = { scope, view, openIssue, settingsPage, inboxOpen, projectsOpen, sync }
    const onPending =
      !!pending &&
      sameTask(openIssue, pending.ref) &&
      location.pathname === pending.pathname &&
      location.hash === pending.hash
    if (onPending && pending.page === pageKey(state)) return
    // so does a project address the workspace does not hold while
    // startup checks it, also after a check that could not finish, until
    // the answer opens the project in place or the chooser takes it
    const held =
      opening.kind === 'checking' || opening.kind === 'retry' ? opening.check.address : null
    if (
      held &&
      scope === undefined &&
      location.pathname === held.pathname &&
      location.hash === held.hash &&
      held.page === pageKey(state)
    )
      return
    // and so does the address that opened a project scope while the project
    // cache knows none of its facts, as the path names the project by its
    // number, which only the cache's answer gives; any other page's address
    // names no scope, so it follows at once
    if (pathNamesScope(state) && !P.project(scope)) return
    const p = buildPath(state)
    /* A person jump's chooser marks its entry, the front door, with the
       person and the view it shows on, which the front door does not name,
       so a Back or Forward onto it shows that chooser again (onPop). Every
       other entry the address sync writes carries no mark, also one that
       replaces the chooser's in place, as a pick does. */
    const mark =
      jumpHolds && personJump && isFrontDoor(p) && isChooserView(view)
        ? { ...personJump, view }
        : null
    // the hash term is what finally clears a translated legacy link: the path
    // is already canonical by then, so nothing else would ever rewrite it
    if (location.pathname === p && !location.hash) {
      // a view the chooser moves to stays on its entry, in place
      const marked = mark ? withJumpMark(history.state, mark) : history.state
      if (marked !== history.state) history.replaceState(marked, '', p)
      replaceNextHistory.current = false
      return
    }
    const inPlace = pathMatchesState(location.pathname, state)
    if (replaceNextHistory.current || inPlace)
      history.replaceState(withJumpMark(history.state, mark), '', p)
    else
      pushPage(
        mark
          ? { qivoPrevious: location.pathname, qivoJump: mark }
          : { qivoPrevious: location.pathname },
        p,
      )
    replaceNextHistory.current = false
  }, [
    scope,
    view,
    openIssue,
    settingsPage,
    inboxOpen,
    projectsOpen,
    sync,
    rev,
    refRev,
    pagesRev,
    settled,
    opening,
  ])
  // the task the boot, Back or Forward named by a reference, once its
  // answer names its project: its scope, unless the page moved meanwhile.
  // A boot, Back or Forward that waits for it with no scope takes the
  // startup rule once the wait ends without one, or once the answer names
  // no project.
  useEffect(() => {
    const pending = pendingTask.current
    const waiting = opening.kind === 'task' && scope === undefined
    if (!pending || !sameTask(openIssue, pending.ref)) {
      pendingTask.current = null
      if (waiting) openStartup()
      return
    }
    // only the project of an ok or archived answer moves the scope
    const task = scopeTaskOf(openIssue)
    if (!task) {
      const read = P.reference
      const ended = read?.state === 'unavailable' || read?.state === 'failed'
      if (waiting && ended && sameTask(read.ref, pending.ref)) openStartup()
      return
    }
    pendingTask.current = null
    const here = { scope, view, settingsPage, inboxOpen, projectsOpen, sync }
    if (pending.page !== pageKey(here) || sync) {
      if (waiting) openStartup()
      return
    }
    // the scope Back or Forward gives a task address (onPop)
    const sc = liveScope(pending.scope) ? pending.scope : scopeForIssue(task, pending.preferred)
    if (!liveScope(pending.scope)) settleLater(openIssue, task, pending.preferred, sc)
    // the entry names the task, which takes it over in place
    replaceNextHistory.current = true
    if (liveScope(sc) && sc !== scope) {
      if (!pending.scope) taskScope.current = sc
      setScope(sc)
    } else if (waiting) openStartup()
  }, [openIssue, rev, refRev, scope, view, settingsPage, inboxOpen, projectsOpen, sync, opening])
  // the scope a task address kept while the project cache had not named
  // the task's project (scopeToSettle), which App names with the cache
  // meanwhile: once the cache names it, the task's own sub-project unless
  // it lies in the preferred project, as the boot would have chosen with
  // the name, and nothing where the cache answers the project gone or the
  // person moved on
  useEffect(() => {
    const settle = scopeToSettle.current
    const done = () => {
      scopeToSettle.current = null
      P.nameProjects(SETTLE_OWNER, [])
    }
    if (!settle) return done()
    if (scope !== settle.preferred || !sameTask(openIssue, settle.issue)) return done()
    P.nameProjects(SETTLE_OWNER, [settle.task.project])
    if (!P.project(settle.task.project)) {
      if (P.projectState(settle.task.project) === 'gone') done()
      return
    }
    done()
    const sc = scopeForIssue(settle.task, settle.preferred)
    if (!liveScope(sc) || sc === scope) return
    taskScope.current = sc
    setScope(sc)
  }, [scope, openIssue, rev])
  useEffect(() => () => P.nameProjects(SETTLE_OWNER, []), [])
  /* Remember what each address opened, so the gate can tell a MOVED address
     from one this login has simply never followed. Deliberately after the
     url-sync effect above and skipped entirely while the gate is up: accepting
     the move is what records it, and recording it here first would dismiss the
     warning before it was ever shown. */
  useEffect(() => {
    if (addrMoved) return
    const seg = orgSegmentOf(location.pathname)
    if (!seg || seg === ORG_NONE) return
    const org = P.orgBySlug(seg)
    if (org) rememberAddress(P.CURRENT_USER, seg, org.id)
  }, [addrMoved, scope, view, openIssue, settingsPage, inboxOpen, projectsOpen, sync, rev])
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      // a Remaining number typed on Team sync and not yet committed: history
      // unmounts its box without a blur, so commit it before the page moves
      flushWalkInput()
      // the same two grammars as the boot read, in the same order, as Back
      // can land on a legacy entry from earlier in this session's history
      const parsed = parsePath(location.pathname) || parseHash(location.hash)
      const was = hereRef.current
      const page = pageKey(was)
      /* The front door names no page. A move onto it from another page
         shows no scope and the startup rule, as a boot there does, with the
         Inbox on a phone, so the chooser's entry that Back left for the
         Inbox shows the chooser again on Forward. A page whose opening
         checks a project address the workspace does not hold, or offers
         Retry for it, shows no scope either, but it is that address's page,
         not the front door's. A move that stays on the front door's page,
         as a phone layer's Back over the chooser does, changes nothing, and
         neither does a path outside the app. */
      const door =
        !parsed &&
        isFrontDoor(location.pathname) &&
        (!!parsePath(buildPath(was)) || checkedOn(openingRef.current, page) !== null)
      if (!parsed && !door) return
      /* A person jump's entry (its qivoJump mark) while the filters still
         hold that person: the chooser with its line, never a project the
         person did not pick. */
      const mark = door ? jumpMarkOf(history.state) : null
      const jump = mark && holdsPerson(filtersRef.current, mark.id) ? mark : null
      const r: Route = parsed ?? {}
      /* Issue URLs carry no scope: keep the current scope when the issue is
         inside it, else re-scope to the issue's own sub-project. One case
         must NOT keep it — `/app/<org>/<view>/tasks/<task>` IS the project-scope form
         (it omits the segment because the issue names its own project), so
         going Back to it from My view is a request to LEAVE the mode.
         Carrying 'mine' through instead would leave the pane in a state
         the address doesn't describe, and the url-sync effect would then push
         a forward entry over the one just popped — a Back that can't get out.
         No UI path reaches such an entry today (entering the mode needs the
         sidebar, which the window's scrim covers), but the rule belongs with
         the router's own absent-scope-means-project-form reading.
         A Team sync address names its own scope, so the one underneath stays
         put, task or not. A task the workspace does not hold keeps the
         scope until its answer names its project (pendingTask). */
      const preferred = r.view && !r.scope && P.isMineScope(was.scope) ? null : was.scope
      /* The address names the open task when it names the same task
         (sameTask), as the address of a task opened by a reference does,
         which reads back as another string: the open task stays, so the
         move closes no window and reads nothing again, as a Back that
         closes a phone layer over the task. */
      const issue = r.issue && sameTask(r.issue, was.openIssue) ? was.openIssue : r.issue || null
      const task = issue ? scopeTaskOf(issue) : undefined
      // a task named by a reference whose project is not known yet
      const resolving = !!issue && !task
      const sc = r.sync
        ? undefined
        : liveScope(r.scope)
          ? r.scope
          : task
            ? scopeForIssue(task, preferred)
            : undefined
      /* A project address by number (Route.unheld) shows no scope while
         startup checks it through projectNav.resolve, as on a boot, and its
         entry keeps the address until the answer takes it in place; one no
         read can ask about shows the chooser with a note. The number of the
         scope on screen, as Back or Forward between its views reaches, is
         that scope, as pathMatchesState reads it: the project cache names
         the scope by the address's organization and number, and it goes on
         checking the scope, so the scope and its kept pages stay. */
      const ask = r.unheld
      const shownScope = was.scope && !P.isMineScope(was.scope) ? P.project(was.scope) : undefined
      const sameScope =
        typeof ask === 'object' &&
        ask !== null &&
        shownScope?.org === ask.org_id &&
        shownScope.num === ask.num
      const unheld =
        !r.sync && !r.issue && !liveScope(r.scope) && r.unheld !== undefined && !sameScope
      const next = {
        scope: door
          ? jump
            ? undefined
            : rememberedScope()
          : unheld
            ? undefined
            : liveScope(sc)
              ? sc
              : was.scope,
        // viewless issue links keep the current view; Settings, #/inbox and
        // Team sync sit over/instead of the current view, so they must not
        // reset it either, and the front door keeps it as a boot keeps the
        // saved one, except a person jump's entry, whose chooser shows on
        // the view its mark names (jump)
        view: r.view
          ? r.view
          : door && jump
            ? jump.view
            : !door && !r.issue && !r.inbox && !r.settings && !r.projects && !r.sync
              ? 'overview'
              : was.view,
        openIssue: issue,
        // a project page held while its project left (Settings) keeps its
        // own address, which parses to no project now: a Back within it,
        // as from its Archive or delete window, stays on the page
        settingsPage: namesProjectPage(location.pathname, was.settingsPage)
          ? was.settingsPage
          : r.settings || null,
        // the phone opens the Inbox at the front door, as on a boot, but
        // not on a person jump's entry (jump), which shows the chooser again
        inboxOpen: door ? mobileRef.current && jump === null : !!r.inbox,
        projectsOpen: !!r.projects,
        sync: r.sync && P.homeOrg ? syncPlaceFor(r.sync, mobileRef.current) : null,
      }
      /* A busy phone layer the move left below its page, as a dialog whose
         request still runs, holds the page whatever App would ask, so App
         asks nothing about a move that cannot happen yet. */
      if (busyLayerLeft() && holdLayers(event)) return
      /* Back or Forward that would close a window holding unsent text
         returns to the entry it left, so nothing moves, and asks there
         (lib/popRefusal). When it has no entry to return to, the address it
         left is pushed on top instead. */
      const closing = withSettingsTask(was, next, closedBy(was, next, unsent))
      if (closing.some((held) => held.held().length)) {
        if (!refusal.refuse(event, closing)) {
          event.stopImmediatePropagation()
          history.pushState({ qivoPrevious: location.pathname }, '', buildPath(was))
          closeOrAsk(closing, () => history.back())
        }
        return
      }
      /* A phone layer the move left below its page that refuses its close,
         as a busy dialog does, holds the page: the move returns to its
         marker unheard (lib/pageHistory holdLayers). */
      if (holdLayers(event)) return
      refusal.accepted()
      /* A move to another page or task drops every open that waits and
         startup's check (navMoved), and so does one on the same page that
         changes which project address the workspace does not hold it
         checks, as from the chooser to an earlier project's address in the
         same view, or from that address to the front door. One that stays
         on its page and the address it checks, as a phone layer's Back
         does, moves nothing. */
      const target = unheld ? JSON.stringify(r.unheld ?? null) : null
      if (
        pageKey(next) !== page ||
        next.openIssue !== was.openIssue ||
        target !== checkedOn(openingRef.current, page)
      )
        navMoved()
      /* An address that is not the page's own, such as one to a project
         that is gone, gives way to the page's in place, as on a boot: the
         url-sync effect would leave it when the page stays the same. A task
         named by a reference keeps its address until its answer names its
         project (pendingTask), and so does a project address being checked. */
      const own = buildPath(next)
      const checking = unheld && !!r.unheld
      if (!resolving && !checking && (location.pathname !== own || location.hash))
        history.replaceState(history.state, '', own)
      /* A return belongs to the visit that opened its page. A pop that stays
         on the page keeps it (Back through Settings' pages, a phone layer, a
         task closing over the sync); one that leaves drops it, so a later
         Exit or Done cannot restore a page from another visit. */
      if (!r.settings) settingsReturn.current = NO_RETURN
      if (!r.sync) syncReturn.current = NO_RETURN
      pendingTask.current =
        resolving && issue
          ? {
              pathname: location.pathname,
              hash: location.hash,
              ref: issue,
              page: pageKey(next),
              scope: r.scope,
              preferred,
            }
          : null
      if (unheld) {
        const address = { pathname: location.pathname, hash: location.hash, page: pageKey(next) }
        showOpening((n) =>
          ask
            ? { kind: 'checking', n, check: { ask, name: null, of: 'address', address } }
            : { kind: 'choose', n, note: ADDRESS_UNAVAILABLE, lost: null },
        )
      }
      /* A person jump's entry shows the chooser again, with its line, as
         the filters still hold the person (jump), so it never opens a
         project the person did not pick. Any other front door takes the
         startup rule, and no line. */
      if (door) {
        setPersonJump(jump)
        showOpening((n) => ({ kind: 'choose', n, note: null, lost: null }))
        if (next.scope) scopeOpened.current = { id: next.scope, of: 'remembered' }
      }
      // a task the workspace does not hold, reached with no scope, waits
      // for its answer to name its project, as on a boot, never for a
      // check the move dropped
      if (resolving && !r.sync && next.scope === undefined)
        showOpening((n) => ({ kind: 'task', n }))
      // a scope the task's address chose is not remembered (taskScope)
      if (!r.sync && !liveScope(r.scope) && task && liveScope(sc)) taskScope.current = sc ?? null
      else if (next.scope !== was.scope) taskScope.current = null
      settleLater(
        next.openIssue,
        !r.sync && !liveScope(r.scope) ? task : undefined,
        preferred,
        next.scope,
      )
      setScope(next.scope)
      setView(next.view)
      setOpenIssue(next.openIssue)
      setSettingsPage(next.settingsPage)
      setInboxOpen(next.inboxOpen)
      setProjectsOpen(next.projectsOpen)
      setSync(next.sync)
    }
    window.addEventListener('popstate', onPop)
    // the phone layers hear a move after App, so never one App refuses
    // (holdLayers asks them only when App does not refuse it, or first for
    // a busy layer, which holds the page anyway)
    const stopLayers = listenBackLayers()
    return () => {
      window.removeEventListener('popstate', onPop)
      stopLayers()
    }
  }, [])

  /* The access guard keeps the scope within what the current user can see.
     My view IS "what the user can see", so it needs no rescuing. No scope
     is the chooser's. A project scope names its project and its top-level
     project with the project cache (under `scope`), and stays while the
     cache loads, rereads, failed or did not check them: only the cache's
     current answer that leaves one of them out (P.scopeInfo `gone`) loses
     it, so a sub-project lost under a parent the person still sees goes
     too and loading never reads as lost. A lost one leaves no scope and the
     chooser with "<name> is no longer available to you." (lostNote), never
     another project or My view: someone else's change must not choose for
     the person. Its address gives way to the front door in place. */
  useEffect(() => {
    if (!scope || P.isMineScope(scope)) {
      P.nameProjects('scope', [])
      return
    }
    const info = P.scopeInfo(scope)
    P.nameProjects('scope', info.topId && info.topId !== scope ? [scope, info.topId] : [scope])
    if (info.state !== 'gone') return
    const was = scopePlace.current?.id === scope ? scopePlace.current : null
    const note = lostNote(scope, scopeOpened.current, was?.name ?? null)
    scopeOpened.current = null
    // the scope's own address, by uuid or by number, gives way to the front
    // door's in place, as it is no page the person can open; the address
    // of a page shown over the scope stays its entry
    const shownState = { scope, view, openIssue, settingsPage, inboxOpen, projectsOpen, sync }
    if (pathNamesScope(shownState) && isScopeAddress(location.pathname))
      replaceNextHistory.current = true
    setScope(undefined)
    showOpening((n) => ({
      kind: 'choose',
      n,
      note,
      lost: { id: scope, top: was?.top ?? null },
    }))
  }, [scope, rev])

  /* Startup's check (Opening `checking`): one projectNav.resolve read of
     the project an address names by its organization and number, once a
     view would show it, as only the server can say which project that
     number names for the person. Under a page that
     covers the views, as the phone's Inbox at a bare address, it waits
     until a view shows, as no tab there leads to the scope beneath. Every
     navigation the person makes while it is on its way drops it
     (navMoved), a view pill, another page, project or Team sync scope,
     Back or Forward and an open that starts to wait in a list, so its
     answer changes nothing and the chooser takes its line's place, unless
     Back or Forward reached an address that names its own opening.
     Otherwise its answer counts only while the scope is still empty and
     no newer opening started: ok opens the project as the scope at once,
     its facts seeded (openResolved); unavailable shows the chooser with
     its note; the access_unchecked refusal and a failed read show their
     sentence with Retry, never the chooser, another project or My view. */
  const askedCheck = useRef(-1)
  const stopCheck = useRef<(() => void) | null>(null)
  useEffect(() => () => stopCheck.current?.(), [])
  useEffect(
    () =>
      onNavMove(() => {
        const stop = stopCheck.current
        if (!stop) return
        stopCheck.current = null
        stop()
        showOpening((n) => ({ kind: 'choose', n, note: null, lost: null }))
      }),
    [],
  )
  useEffect(() => {
    if (opening.kind !== 'checking' || scope !== undefined || !viewShown) return
    if (askedCheck.current === opening.n) return
    askedCheck.current = opening.n
    const { n, check } = opening
    stopCheck.current?.()
    stopCheck.current = openResolved(check.ask, (answer) => {
      stopCheck.current = null
      if (openingRef.current.n !== n || scopeRef.current !== undefined) return
      const retry = (line: string) => showOpening((m) => ({ kind: 'retry', n: m, check, line }))
      switch (answer.state) {
        case 'open':
          // the address the check held takes the project's in place
          if (check.address) replaceNextHistory.current = true
          scopeOpened.current = { id: answer.id, of: 'address' }
          setScope(answer.id)
          return
        case 'unavailable':
          return showOpening((m) => ({
            kind: 'choose',
            n: m,
            note: ADDRESS_UNAVAILABLE,
            lost: null,
          }))
        case 'unchecked':
          return retry(answer.message)
        case 'failed':
          return retry("Couldn't check that project.")
      }
    })
  }, [opening, scope, viewShown])

  // User navigation must leave the inbox: the main pane renders the inbox
  // INSTEAD of the views, so a scope/view/issue navigation that left it open
  // would look dead (the sidebar row would highlight while the screen stays
  // put). The access guard's silent re-scopes and the modal's close (openIssue
  // null) keep the raw setters.
  /* …and leaving takes the pane's task with it. A task read in the inbox is
     IN the inbox's right half, not floating over the app, so carrying it out
     as a window over wherever you land is not what the click asked for. This
     is new with that pane: while the window floated, its scrim covered the
     sidebar and none of these were reachable with a task open. Every entry
     that closes the inbox goes through here — the one exception is
     showOnBoard, which names the task it wants and sets it right after.
     Team sync owns the screen the same way, so every one of them leaves it
     too (a task window over it floats, and stays with the window's own close). */
  const leaveInbox = () => {
    setProjectsOpen(false)
    setSync(null)
    if (inboxOpen) setOpenIssue(null)
    setInboxOpen(false)
  }
  // …the place leaveInbox moves to, for `move`
  const leftInbox = (): UiState => ({
    projectsOpen: false,
    sync: null,
    inboxOpen: false,
    openIssue: inboxOpen ? null : openIssue,
  })
  const navScope = (id) =>
    move({ ...leftInbox(), scope: id }, () => {
      leaveInbox()
      setScope(id)
    })
  const navView = (v) =>
    move({ ...leftInbox(), view: v }, () => {
      leaveInbox()
      setView(v)
    })
  // `revealing` also reveals the task's card behind its window
  const openNav = (k, revealing: boolean) =>
    move(k ? { openIssue: k, inboxOpen: false, projectsOpen: false } : { openIssue: k }, () => {
      if (k) {
        setInboxOpen(false)
        setProjectsOpen(false)
      }
      setOpenIssue(k)
      // the views name a task by its handle, also one a reference opens
      if (k && revealing) reveal(P.handleOfOpen(k))
    })
  const navOpenIssue = (k) => openNav(k, false)
  // another task in the open window, or none (the Inbox pane, Team sync)
  const openTask = (id: string | null) => move({ openIssue: id }, () => setOpenIssue(id))

  // the newest New task opener, so an answer for an older one opens nothing
  const newIssueAsk = useRef(0)
  const openNewIssue = (init) => {
    /* Desktop creates normally name a project. My view and the phone's My
       tasks action open without one: the dialog lists the sub-projects the
       person may add tasks to (projectNav.targets) and says so at a
       confirmed empty end. */
    const target = init.project || (P.isMineScope(scope) ? null : scope)
    const proj = target ? P.project(target) : null
    const ask = ++newIssueAsk.current
    const open = () => {
      if (newIssueAsk.current === ask)
        setModal({ kind: 'issue', init: { ...init, project: target } })
    }
    // "tasks live in sub-projects": a top-level project with none can't
    // receive one, which the first batch of its sub-projects the person
    // sees (projectNav.children) says once it answers an empty last batch.
    // The rule follows the TARGET, not just the scope. My view gives every
    // project a lane and a track, and their + buttons name them. Any other
    // answer opens the dialog, which lists what the person may write.
    if (proj && proj.type === 'meta') {
      void P.hasSubProjects(proj.id).then((has) => {
        if (newIssueAsk.current !== ask) return
        if (has === false) {
          window.showToast?.('Create a sub-project first. Tasks live in sub-projects.', 'info')
          openNewProject({ parent: proj.id })
          return
        }
        open()
      })
      return
    }
    open()
  }
  const clearFilters = () =>
    setFilters((f) => ({
      search: '',
      mine: false,
      assignees: [],
      priority: null,
      stale: false,
      focus: f.focus,
    }))

  /* A milestone lands on exactly ONE project's roadmap (0078), so My view
     has none to offer: the three surfaces that create one (the Overview
     section's +, the Roadmap toolbar, the palette) all hide there. This is the
     single closure behind them, in place of two copies that had already
     drifted apart once, and it never lets My view reach the dialog. */
  const openNewMilestone = (init) =>
    setModal({
      kind: 'milestone',
      init: { project: P.isMineScope(scope) ? null : scope, ...init },
    })

  // "New project" and "New sub-project" are separate dialogs; kind:"program"
  // (sidebar header +, palette) opens the project one, everything else,
  // always parented, opens the sub-project one. `onCreated` hears the id
  // of a sub-project the dialog creates and whether the server stored it,
  // as Settings › Projects keeps it in its open list until its loaded
  // batches hold it or, once stored, tell that they do not.
  const openNewProject = (
    init,
    focusAfterClose?: () => HTMLElement | null,
    onCreated?: (id: string, saved: Promise<{ num: number } | null>, name: string) => void,
  ) => {
    createdProject.current = null
    setModal({
      kind: init && init.kind === 'program' ? 'program' : 'subproject',
      init: { ...init },
      focusAfterClose,
      onCreated,
    })
  }
  /* The control that stands for project `id` once App shows it: its row in
     the sidebar or in Settings › Projects, else the phone header's New
     task, or its Project actions while it holds no sub-project for a task.
     The sidebar and the header stay as App moves into a project once it is
     saved, while the views and the Projects page go behind it. A row out of
     use, such as the sidebar's while Settings hides it, never counts. The
     sidebar shows a new project once the server's list holds it, which its
     focus request (focusRow) waits for. */
  const projectTarget = (id: string) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        `[data-project-row="${id}"] button, [data-subproject-row="${id}"] button`,
      ),
    ].find((control) => !control.closest(OUT_OF_USE)) ??
    document.querySelector<HTMLElement>('[data-mobile-new-task]') ??
    document.querySelector<HTMLElement>('[data-mobile-project-actions]')
  /* Where focus goes as New sub-project closes after a create, for an
     opener that names nothing else. The empty states and Add sub-project
     buttons that open the dialog leave once the sub-project shows. */
  const afterNewSubProject = () =>
    createdProject.current ? projectTarget(createdProject.current) : null

  // Jump from the issue window to the roadmap to plan an issue in context.
  // Switches to the issue's project/roadmap and closes the window so the
  // timeline is interactable; the Roadmap opens a planning session (spotlight
  // + card) that owns the initial placement, auto-fit, and Confirm/Cancel.
  // A group's dates come from its subtasks, so it gets the read-only reveal
  // instead. That opens no session and writes nothing, and a group's dormant
  // status never stops it as Backlog. A task the window shows from its own
  // answer plans the same way (P.taskShown). The request carries the task's
  // uuid, sub-project and weeks (TaskPlace) and its status. The Roadmap pans
  // to those weeks, asks the server to keep the task past the filter row,
  // waits for an answer that holds it, then spotlights it, or says it is
  // not on the roadmap any more or why it cannot plan it there, as for a
  // Done task without dates, whose window's button is off.
  const planOnRoadmap = (id) => {
    const it = P.taskShown(id)
    if (!it) return
    const group = P.isGroup(it)
    if (!group && it.status === 'backlog') {
      window.showToast?.('Move this task out of Backlog before planning it on the roadmap', 'error')
      return
    }
    // the task's top-level project from the project cache, which the task
    // window names; the Roadmap then opens as any scope does, at once
    const meta = P.topLevelOf(it.project)
    if (!meta) return
    const place = taskPlaceOf(it)
    /* A Roadmap that holds the task's sub-project, that sub-project's or
       its top-level project's, stays; from anywhere else planning opens
       the task's top-level project. My view carries it
       only when it IS mine: spotlighting somebody else's task from there
       would open a planning session over a bar the view doesn't render.
       The jump passes the scope it shows through move, also one it keeps,
       so that Roadmap is the person's choice, which the save effect
       remembers even where a task's address chose the scope, as under an
       Inbox task (taskScope). */
    const cur = scopeRef.current
    const stays =
      cur !== undefined &&
      (cur === it.project || cur === meta || (P.isMineScope(cur) && P.isMine(it)))
    const to = stays ? cur : meta
    move(
      {
        scope: to,
        view: 'roadmap',
        projectsOpen: false,
        inboxOpen: false,
        sync: null,
        openIssue: null,
      },
      () => {
        setScope(to)
        // a reveal does not bypass the toolbar filters, so clear them as Team
        // sync's jump does (Focus stays)
        if (group) clearFilters()
        setView('roadmap')
        setProjectsOpen(false)
        setInboxOpen(false)
        setSync(null)
        setOpenIssue(null)
        if (group) {
          reveal(id, false, it.key, place)
          roadmapReveal.current = focusN.current
        } else {
          focusN.current += 1
          setFocusPlan({ id, n: focusN.current, key: it.key, status: it.status, ...place })
        }
      },
    )
  }

  // Task breadcrumb clicks and the Inbox's Open task in board switch to the
  // Board scoped to the project or sub-project, with the task's window open
  // over the Board and its card revealed behind it, by the handle the views
  // name it by, also for a task the workspace does not hold, which the
  // Inbox opens by a reference (P.handleOfOpen). `keepOpen` false closes
  // the window and reveals the card at once (the crumb on a phone, whose
  // window covers the list).
  const showOnBoard = (projectId: string, issueKey?: string, keepOpen = true) => {
    if (!projectId) return
    const revealed = issueKey || null
    const target = keepOpen ? revealed : null
    move(
      {
        scope: projectId,
        view: 'kanban',
        projectsOpen: false,
        inboxOpen: false,
        sync: null,
        openIssue: target,
      },
      () => {
        setScope(projectId)
        setView('kanban')
        setProjectsOpen(false)
        setInboxOpen(false)
        setSync(null)
        setOpenIssue(target)
        if (revealed) reveal(P.handleOfOpen(revealed), !keepOpen)
      },
    )
  }

  // A phone's Back action consumes the page it opened, stepping past the
  // marker of phone layers over its entry (lib/pageHistory leavePage).
  // Direct links have no in-app predecessor; replace those with the parent
  // instead of looping back into a task or setting the user just dismissed.
  // Both read the entry the page is on, so they wait for a page move on its
  // way.
  const backOrSet = (patch, apply: () => void) =>
    whenQuiet(() => {
      const phoneHistory = mobile || isLandscapeRoadmapOpen()
      const target = buildPath({
        scope,
        view,
        openIssue,
        settingsPage,
        inboxOpen,
        projectsOpen,
        sync,
        ...patch,
      })
      if (phoneHistory && history.state?.qivoPrevious === target) leavePage()
      else {
        replaceNextHistory.current = phoneHistory
        apply()
      }
    })
  const closeIssue = () =>
    move({ openIssue: null }, () => backOrSet({ openIssue: null }, () => setOpenIssue(null)))

  /* ---- Team sync's hand-offs (the TeamSync props) ---- */
  // a step or a scope from the page; the address follows in place (the
  // router's sync rule), and a new scope is the person's pick, the only
  // thing that saves one
  const placeSync = (next: SyncPlace, closes?: UnsentScope[]) => {
    if (sync && next.scope === sync.scope && next.step === sync.step) return
    const apply = () => {
      if (next.scope && next.scope !== sync?.scope) P.saveUINow({ teamSyncScope: next.scope })
      correctSync(next)
    }
    // a scope switch names the cards it asks about, and drops every open
    // that waits and startup's check once accepted, as move does
    if (closes)
      closeOrAsk(closes, () => {
        navMoved()
        apply()
      })
    else move({ sync: next }, apply)
  }
  // …and the page's own correction of a step it cannot show, unasked; it
  // saves nothing, so no default or refusal becomes the person's choice
  const correctSync = (next: SyncPlace) => {
    if (sync && next.scope === sync.scope && next.step === sync.step) return
    setSync(next)
  }
  // Done on the last step: back to the page it was opened from (the Inbox,
  // the Projects directory), else the scope and view underneath
  const closeSync = () => {
    const back = syncReturn.current
    const to = { sync: null, inboxOpen: back.inbox, projectsOpen: back.projects }
    move(to, () => {
      syncReturn.current = NO_RETURN
      setSyncEnded(true)
      backOrSet(to, () => {
        setSync(null)
        setInboxOpen(back.inbox)
        setProjectsOpen(back.projects)
      })
    })
  }
  /* A row's Board or Roadmap jump: leave the page for that view, scoped so
     the task is on it: the task's own sub-project. Filters left from
     before the sync are
     cleared, Focus kept, since nothing on the sync could show why the task
     is missing. The Board opens the task window over it, as showOnBoard
     does, and reveals its card behind it; the Roadmap reveals its bar
     read-only. Either way the task is scrolled into view and ringed for a
     moment: no planning session, nothing written. A task only Team sync's
     agenda brings is found among the views' models (P.anyTask), and its
     window opens through the window's own read (P.openTarget). */
  const showTaskOn = (v: 'kanban' | 'roadmap', handle: string) => {
    const it = P.anyTask(handle)
    if (!it) return
    const to = it.project
    const task = v === 'kanban' ? P.openTarget(handle) : null
    move({ sync: null, scope: to, view: v, openIssue: task }, () => {
      clearFilters()
      setSync(null)
      setScope(to)
      setView(v)
      setOpenIssue(task)
      reveal(handle, false, v === 'roadmap' ? it.key : undefined, taskPlaceOf(it))
    })
  }
  /* A person header's Board or Roadmap jump: leave the page for that view
     filtered to the person (the filters match the task's owner, the rule
     the sync's rows follow). A project sync opens that project, as any
     scope opens. All projects and a team, which no view has
     a scope for, open the view with no project chosen, which shows the
     chooser with the filter kept and a line that names the person
     (jumpLine), never My view, which drops the filter, nor a project the
     person did not pick. A pick opens that project's view filtered to the
     person, in place of the chooser's entry. `first` is the person's
     first name, from Team sync's agenda. */
  const showPersonOn = (v: 'kanban' | 'roadmap', profileId: string, first: string) => {
    const place = parseSyncScope(sync?.scope)
    const to = place.kind === 'project' ? place.id : undefined
    move({ sync: null, scope: to, view: v, openIssue: null }, () => {
      setFilters((f) => ({
        search: '',
        mine: false,
        assignees: [profileId],
        priority: null,
        stale: false,
        focus: f.focus,
      }))
      setSync(null)
      setScope(to)
      setView(v)
      setOpenIssue(null)
      if (to === undefined) {
        setPersonJump({ id: profileId, first })
        // the chooser itself, never the startup rule's remembered project
        showOpening((n) => ({ kind: 'choose', n, note: null, lost: null }))
      }
    })
  }
  /* A sub-project's Board, from Team sync's note for one past its limits:
     leave the page for the Board of that sub-project. */
  const showBoardOf = (projectId: string) => {
    if (!projectId) return
    move({ sync: null, scope: projectId, view: 'kanban', openIssue: null }, () => {
      setSync(null)
      setScope(projectId)
      setView('kanban')
      setOpenIssue(null)
    })
  }

  /* Opens Settings on `page`, remembering the page underneath for its exit.
     `archived` is the project Archived tasks opens on. */
  const openSettingsOn = (page: string, archived: string | null) =>
    move({ ...leftInbox(), settingsPage: page }, () => {
      settingsReturn.current = { inbox: inboxOpen, projects: projectsOpen, sync }
      leaveInbox()
      setArchiveProject(archived)
      setSettingsPage(page)
    })

  const actions = {
    openIssue: navOpenIssue,
    newIssue: openNewIssue,
    newProject: openNewProject,
    newMilestone: openNewMilestone,
    // `project`, the project the opener shows the milestone on, lets the
    // window read its Upcoming section beside the milestone; the window's
    // read of the milestone alone fixes its project
    editMilestone: (id, focusAfterClose?: () => HTMLElement | null, project?: string) =>
      setModal({ kind: 'milestone', init: { id, project }, focusAfterClose }),
    // settings and the inbox each own the screen, one at a time
    openSettings: (page) => openSettingsOn(page || (mobile ? 'menu' : 'account'), null),
    // Settings › Archived tasks on one project (the project menus' entry)
    openArchivedTasks: (projectId?: string) =>
      openSettingsOn(ARCHIVED_TASKS_PAGE, projectId || null),
    // …and its pane starts empty: the inbox is a triage surface, so arriving
    // at it holding whatever task the last view had open would light a row-less
    // pane before a single message has been read. A deep link straight to
    // /inbox/tasks/<task> is the other direction and still lands on the task.
    // Each press also runs a failed unread summary again, so the badge
    // can count once more (P.retryInboxSummary).
    openInbox: () => {
      P.retryInboxSummary()
      return move(
        { projectsOpen: false, settingsPage: null, sync: null, openIssue: null, inboxOpen: true },
        () => {
          setProjectsOpen(false)
          setSettingsPage(null)
          setSync(null)
          setOpenIssue(null)
          setInboxOpen(true)
        },
      )
    },
    // My view is a scope, so it also leaves whichever page owns the screen,
    // since the sidebar shows over the inbox and the palette over every page
    openMine: () =>
      move(
        {
          ...leftInbox(),
          settingsPage: null,
          scope: P.MINE_SCOPE,
          ...(mobile ? { view: 'kanban' } : {}),
        },
        () => {
          setSettingsPage(null)
          leaveInbox()
          setScope(P.MINE_SCOPE)
          if (mobile) setView('kanban')
        },
      ),
    // All projects: the project directory, from the sidebar's row and the
    // phone's Projects tab. It leaves the scope and the view as they are,
    // so visiting it never changes the remembered project
    // (UIPrefs.lastProject), and closes a task window, since its address
    // names no task
    openProjects: () =>
      move(
        { settingsPage: null, inboxOpen: false, sync: null, openIssue: null, projectsOpen: true },
        () => {
          setSettingsPage(null)
          setInboxOpen(false)
          setSync(null)
          setOpenIssue(null)
          setProjectsOpen(true)
        },
      ),
    // Team sync (the sidebar row, the phone's Sync tab): opens where the
    // sitting left it while the page is kept, else on the saved scope,
    // remembering the Inbox or Projects page for Done; pressed while open,
    // it stays where the walk is
    openSync: () => {
      if (!P.homeOrg) return
      const opening =
        sync || (keep.pages.includes('sync') && lastSync.current) || syncPlaceFor({}, mobile)
      move({ ...leftInbox(), sync: opening, settingsPage: null }, () => {
        if (!sync) {
          syncReturn.current = { inbox: inboxOpen, projects: projectsOpen, sync: null }
          setSync(opening)
        }
        setSettingsPage(null)
        setProjectsOpen(false)
        if (inboxOpen) setOpenIssue(null)
        setInboxOpen(false)
      })
    },
    clearFilters,
    setScope: navScope,
    openProject: (id) =>
      move({ ...leftInbox(), scope: id, ...(mobile ? { view: 'kanban' } : {}) }, () => {
        leaveInbox()
        setScope(id)
        if (mobile) setView('kanban')
      }),
    setView: navView,
    planOnRoadmap,
    // a project id opens Search on that project; a click opens it on All
    // projects
    openPalette: (searchIn?: unknown) => {
      setPaletteIn(typeof searchIn === 'string' ? searchIn : null)
      setPaletteOpen(true)
    },
    createOrg: (focusAfterClose?: () => HTMLElement | null) =>
      setModal({ kind: 'createorg', focusAfterClose }),
  }
  // a click on a desktop notification opens the inbox as the Inbox button
  // does, asking first when a window holds unsent text
  const openInboxRef = useRef(actions.openInbox)
  openInboxRef.current = actions.openInbox
  useEffect(() => {
    P.setInboxOpener(() => openInboxRef.current())
    return () => P.setInboxOpener(null)
  }, [])

  const createIssue = (issue) => {
    // while edits are paused the dialog stays open with what was typed
    if (P.refusePausedEdit()) return false
    // what opening the new task passes on, which addIssue returns: a
    // reference to its organization, preview number and uuid, as the
    // workspace holds no task (a handle where it holds every task). The
    // preview can be invalidated by ANY concurrent create in the org
    // (0050's shared counter): the open window follows its task to the
    // server's number (P.watchHandles above), so it doesn't blank or show
    // the concurrent issue, and a refusal closes it under what it showed
    // last, saying with the task's key what text typed in it went with it.
    // The window is compared by its task (sameTask), since a refusal can
    // name a reference that moved before App took the move.
    const open = P.addIssue(issue, (last) => {
      if (!sameTask(hereRef.current.openIssue, last)) return
      const lost = dropRefusedTask(unsent.task, P.keyOfOpen(last))
      setOpenIssue((cur) => (sameTask(cur, last) ? null : cur))
      if (lost) window.showToast?.(lost, 'error')
    })
    // a create the store refused says why itself (P.addIssue's toast, the
    // project cache's sentence for a project it has not answered)
    if (!open) return false
    // The create dialog's phone marker, a spare once it closes in this
    // commit, takes the task's address (lib/pageHistory pushPage).
    setModal(null)
    window.showToast?.(`Created ${P.keyOfOpen(open)}`)
    /* A create from a project that does not hold the task moves to the
       task's sub-project, whose parent the project cache names (the
       create refused unless the cache answered it). My view shows it only
       if it landed on me, by P.isMine's rule read from what was typed,
       since the workspace holds no task: its assignee, or its reviewer for
       a task born In Review. A task created from a side-board's + is
       unassigned, so that one still jumps to its sub-project. */
    const owner = issue.status === 'review' && issue.reviewer ? issue.reviewer : issue.assignee
    const inScope =
      (P.isMineScope(scope) && !!owner && P.myProfileIds.includes(owner)) ||
      (!!scope && (scope === issue.project || P.project(issue.project)?.parent === scope))
    // Keep the task visible underneath its editor when creation changes scope.
    if (!inScope) setScope(issue.project)
    navOpenIssue(open)
    return true
  }
  // The sidebar's tree shows the new project once the server's list holds
  // it, which usually lands with the save's answer, and the toast, the
  // starter task and the move into the project wait for the server too. A
  // refused create must not leave the user inside a project that then
  // disappears. `shown` is the organization New sub-project's parent check
  // named, which the create goes to (P.addProject). App moves into a new
  // sub-project, and makes its starter task, only once one projectNav.byIds
  // read of it (P.projectsByIds) answers that the creator opens it, since
  // an organization admin manages parents they cannot see, and the
  // project cache, which the starter task's create reads, holds it. `sees`
  // false, the dialog's own knowledge that they will not, skips the read
  // and says so. The starter task also needs that answer to give the
  // creator Edit there, as the server's task create does, so a Viewer of
  // the parent, who sees the sub-project, gets the plain toast and no
  // task, also where the dialog offered one.
  const createProject = (
    p: NewProjectInput,
    {
      withStarter,
      shown,
      sees,
    }: { withStarter: boolean; shown?: ProjectShown; sees?: boolean | null },
  ) => {
    // while edits are paused the dialog stays open with what was typed
    if (P.refusePausedEdit()) return
    // Projects and sub-projects are led by people and shared through explicit grants.
    if (p.type === 'meta') p.access = p.access || {}
    const placeAtCreate = placeRef.current
    // the create's answer once the server stored it, null for a refusal,
    // for the dialog's opener (onCreated)
    let answered: (stored: { num: number } | null) => void = () => {}
    const saved = new Promise<{ num: number } | null>((resolve) => {
      answered = resolve
    })
    const id = P.addProject(
      p,
      (created: ProjectCreated) => {
        answered({ num: created.num })
        /* What follows once whether the creator sees the project is known:
           true, false or null for unknown, with whether they may add tasks
           to it. */
        const follow = (seen: boolean | null, writes = false) => {
          if (withStarter && seen === true && writes && id) {
            P.addIssue({
              title: p.name,
              project: id,
              status: 'backlog',
              priority: 'medium',
              assignee: p.lead || null,
              parent: null,
            })
          }
          // A top-level project's visibility comes from the draft by the
          // rule the dialog's warning used. A sub-project opens once the
          // server's read confirmed that the creator sees it.
          const saved = afterProjectSaved({
            type: p.type,
            name: p.name,
            visible: p.type === 'meta' ? P.seesNewProject(p) : seen === true,
            sees: seen,
          })
          window.showToast?.(saved.message)
          // stay put when the creator cannot see it, or moved elsewhere
          // while it saved; otherwise follow the new project, its facts
          // seeded from the create and its answer, as a navigation row
          // seeds them, so its views and the sidebar's scope rule place it
          // at once while the project cache checks it
          if (!saved.open || placeRef.current !== placeAtCreate) return
          P.seedProjects([
            {
              id: created.id,
              org_id: created.org,
              name: p.name,
              num: created.num,
              parent_id: p.type === 'meta' ? null : (p.parent ?? null),
            },
          ])
          setScope(id)
          setProjectsOpen(false)
          setSync(null)
          focusAfterMove.current = () => projectTarget(id)
          // the tree's row may come a commit later than the move
          askFocusRow(id, id)
        }
        if (p.type === 'meta' || !id) follow(true)
        else if (sees === false) follow(false)
        else {
          // the new sub-project, named while its starter task may need it,
          // so the project cache reads it beside this one-shot answer
          P.nameProjects(`created:${id}`, [id])
          void P.projectsByIds([id]).then((answer) => {
            const row = answer?.rows.find((r) => r.id === id)
            const seen = answer === null || answer.unchecked.includes(id) ? null : row !== undefined
            const done = () => {
              follow(seen, row?.level === 'lead' || row?.level === 'user')
              P.nameProjects(`created:${id}`, [])
            }
            // the starter task's create reads the project cache, which the
            // live read fills a moment after this answer
            if (!withStarter || !row || P.projectState(id) === 'ok') return done()
            const off = P.updates.workspace.subscribe(() => {
              if (P.projectState(id) !== 'ok') return
              off()
              clearTimeout(bound)
              done()
            })
            const bound = setTimeout(() => {
              off()
              done()
            }, 10_000)
          })
        }
      },
      () => {
        answered(null)
        // a refusal leaves the dialog's opener in place, which keeps focus;
        // where the opener went, focus that is nowhere goes to the parent's
        // row
        const { parent } = p
        if (parent) {
          focusAfterMove.current = () => projectTarget(parent)
          askFocusRow(parent, scopeRef.current)
        }
      },
      shown,
    )
    createdProject.current = id ?? null
    if (id) modal?.onCreated?.(id, saved, p.name)
    setModal(null)
  }

  const setTweak = (patch) => {
    setTweaks((prev) => ({ ...prev, ...patch }))
    P.saveUI(patch)
  }

  // the palette searches on the server (Palette.tsx) and needs only the two
  // ways to open what it found, a project as the scope and a task by its
  // handle or a reference, which may name a task the workspace does not
  // hold, such as an archived one. A task picked while the Board shows opens
  // over its revealed card, which the Board shows from its answer; one the
  // Board does not show reveals nothing, as a filtered task does.
  const paletteCtx = {
    setScope: navScope,
    openIssue: (id: string) => openNav(id, boardActive),
  }

  /* An address that now names a DIFFERENT organization than the last time this
     login followed it. See src/lib/addressBook.ts for why that is worth
     stopping for: a released slug is claimable at once, and an unsolicited
     guest seat can make the new owner visible to one particular person, so a
     stale bookmark can quietly open somebody else's workspace. This gate does
     not decide who may hold an address — it only refuses to switch which
     organization you are looking at without telling you. */
  if (addrMoved) {
    return (
      <>
        <div className="[height:calc(100vh-var(--float-inset-y))] [display:grid] [place-items:center]">
          <div
            data-floating-surface
            className="animate-in fade-in slide-in-from-bottom-1 [width:420px] [max-width:calc(100vw-40px)] [padding:20px] [border-radius:var(--r-lg)] [background:var(--surface-1)] [border:1px_solid_var(--border)] [box-shadow:var(--qivo-shadow-pop)]"
          >
            <div className="[font-size:var(--fs-base)] [font-weight:600] [margin-bottom:8px]">
              This address has changed hands
            </div>
            <div className="[color:var(--text-2)] [font-size:var(--fs-base)] [line-height:1.6] [margin-bottom:8px]">
              <span className="!font-mono">
                {location.host}/app/{addrMoved.slug}
              </span>{' '}
              opened a different organization the last time you used it. It now belongs to{' '}
              <strong className="[color:var(--text-1)]">{addrMoved.org.name}</strong>.
            </div>
            <div className="[color:var(--text-3)] [font-size:var(--fs-sm)] [line-height:1.6] [margin-bottom:24px]">
              Check that this is the organization you intended to open before continuing.
            </div>
            <Button
              type="button"
              variant="primary"
              className="[width:100%] [justify-content:center]"
              data-address-continue
              onClick={() => {
                rememberAddress(P.CURRENT_USER, addrMoved.slug, addrMoved.org.id)
                setAddrMoved(null)
              }}
            >
              Continue to {addrMoved.org.name}
            </Button>
          </div>
        </div>
        <ToastHost toasts={toasts} dismiss={dismissToast} />
      </>
    )
  }

  /* The create and Milestones dialogs, rendered in the same place whichever
     page is open, so a move between Settings and the workspace (Back, for
     example) keeps an open dialog and what was typed into it. Settings opens
     the project dialogs itself. */
  const dialogs = modal && (
    <DeferredOverlay key={`dialog:${modal.kind}`} onClose={() => setModal(null)}>
      {modal.kind === 'issue' && (
        <NewIssueModal init={modal.init} onClose={() => setModal(null)} onCreate={createIssue} />
      )}
      {modal.kind === 'program' && (
        <NewProjectModal
          init={modal.init}
          onClose={() => setModal(null)}
          onCreate={createProject}
        />
      )}
      {modal.kind === 'subproject' && (
        <NewSubProjectModal
          init={modal.init}
          onClose={() => setModal(null)}
          onCreate={createProject}
          focusAfterClose={() => modal.focusAfterClose?.() ?? afterNewSubProject()}
        />
      )}
      {modal.kind === 'milestone' && (
        <MilestoneModal
          init={modal.init}
          onClose={() => setModal(null)}
          focusAfterClose={modal.focusAfterClose}
        />
      )}
      {modal.kind === 'createorg' && (
        <CreateOrgModal onClose={() => setModal(null)} focusAfterClose={modal.focusAfterClose} />
      )}
    </DeferredOverlay>
  )

  /* Settings owns the screen, and goes when the person leaves it. The
     workspace stays mounted after it, hidden, for the kept pages
     (KeptView). */
  const settingsView = settingsPage
    ? (() => {
        // the scope's top-level project, which Archived tasks opens on once
        // the server resolves it for this person; null from My view, on
        // purpose, so My view opens it on no choice rather than on an
        // arbitrary project or on all of an organization's projects
        // (P.project() is undefined for it)
        const scopeMeta = scopeInfo?.topId ?? null
        /** Leaves Settings for the page that opened it. */
        const exitSettings = () => {
          const back = settingsReturn.current
          const to = {
            settingsPage: null,
            inboxOpen: back.inbox,
            projectsOpen: back.projects,
            sync: back.sync,
          }
          move(to, () => {
            settingsReturn.current = NO_RETURN
            backOrSet(to, () => {
              setSettingsPage(null)
              setInboxOpen(back.inbox)
              setProjectsOpen(back.projects)
              setSync(back.sync)
            })
          })
        }
        return (
          <ViewBoundary onBack={() => setSettingsPage(null)}>
            <Suspense fallback={<ViewLoading />}>
              <UnsentScopeContext.Provider value={unsent.page}>
                <SettingsScreen
                  page={settingsPage}
                  setPage={(page) => move({ settingsPage: page }, () => setSettingsPage(page))}
                  resetPage={setSettingsPage}
                  onBackPage={(page) =>
                    move({ settingsPage: page }, () =>
                      backOrSet({ settingsPage: page }, () => setSettingsPage(page)),
                    )
                  }
                  onExit={exitSettings}
                  onNewProject={() => openNewProject({ kind: 'program' })}
                  onNewSubProject={(parent, focusAfterClose, onCreated) =>
                    openNewProject({ parent }, focusAfterClose, onCreated)
                  }
                  archivedTasksProject={archiveProject || scopeMeta}
                  onOpenArchivedTask={(task) =>
                    closeOrAsk([settingsTaskRef.current !== null && unsent.task], () =>
                      setSettingsTask(task),
                    )
                  }
                  taskOpen={!!settingsTask}
                  onOpenArchivedTasks={(projectId) =>
                    move({ settingsPage: ARCHIVED_TASKS_PAGE }, () => {
                      setArchiveProject(projectId)
                      setSettingsPage(ARCHIVED_TASKS_PAGE)
                    })
                  }
                  onProjectGone={(id, parent) => {
                    /* The person archived or deleted project `id` here.
                       It moves the scope only when the scope is that
                       project or one of its sub-projects, also after the
                       access guard took it as its answer landed first:
                       to `parent`, where they were working, while the
                       project cache answers it ok, else to no scope and
                       the chooser, with no note and the guard's dropped.
                       My view survives it. */
                    if (P.isMineScope(scope)) return
                    const at = scope
                      ? scopePlace.current?.id === scope
                        ? scopePlace.current
                        : null
                      : opening.kind === 'choose'
                        ? opening.lost
                        : null
                    if (!at || (at.id !== id && at.top !== id)) return
                    if (parent && P.projectState(parent) === 'ok' && P.canSee(parent))
                      setScope(parent)
                    else {
                      setScope(undefined)
                      showOpening((n) => ({ kind: 'choose', n, note: null, lost: null }))
                    }
                  }}
                />
              </UnsentScopeContext.Provider>
            </Suspense>
          </ViewBoundary>
        )
      })()
    : null

  /* The scope's own narrowing, handed to the two views that render a filter
     row. DERIVED here, never written into `filters` state: the My tasks
     button, the Assignee popover's "Anyone" and Clear all edit that object,
     and any of them would quietly dissolve the scope while it still called
     itself "My view". `assignees` is emptied because the control that sets it
     is hidden here — a list left over from another scope would blank the board
     with nothing on screen to clear. The Overview takes no filters at all
     (its row is hidden); it reads `info.only` straight off the scope. */
  const effFilters = scopeInfo?.mine ? { ...filters, mine: true, assignees: [] } : filters
  /* The roadmap shows no Stale control (deviation #236) and no Focus control
     (deviation #241), so it must not be narrowed by either: Stale is a board
     question about neglected work, Focus a board question about which columns
     stand, and a flag switched on over on the board would otherwise thin the
     timeline with nothing on screen to clear it. */
  const roadmapFilters = { ...effFilters, stale: false, focus: false }
  /** A failed view's way back: the scope's Overview. */
  const backToWorkspace = () => {
    setSync(null)
    setInboxOpen(false)
    setProjectsOpen(false)
    setView('overview')
  }

  /** What the main page `page` shows. A page that is not shown keeps what
      it rendered last (KeptView), so what this gives it then goes unused. */
  const pageContent = (page: MainPage): ReactNode => {
    switch (page) {
      case 'projects':
        return <ProjectDirectory actions={actions} />
      case 'inbox':
        // openTask does not use navOpenIssue on purpose: the inbox's right pane IS
        // the task window, so opening a task must NOT leave the inbox — and
        // `openIssue` is what that pane shows, which is why the address
        // (/inbox/tasks/<task>) restores it
        return (
          <UnsentScopeContext.Provider value={unsent.task}>
            <Inbox
              showOnBoard={showOnBoard}
              onExit={() => move({ inboxOpen: false }, () => setInboxOpen(false))}
              openTask={(id) => (id ? openTask(id) : closeIssue())}
              openIssue={inboxTask}
              onPlanOnRoadmap={planOnRoadmap}
            />
          </UnsentScopeContext.Provider>
        )
      case 'sync':
        /* Team sync, over the scope and view it returns to, at once in every
           state: its meeting comes from the server, and it waits for no
           task. Its tasks open in the floating window below (openTask, not
           navOpenIssue: opening one must not leave the page), and Escape
           does not close it: a meeting page must not vanish on a stray
           key. */
        if (!syncPlace) return null
        return (
          <TeamSync
            place={syncPlace}
            onPlace={placeSync}
            onCorrect={correctSync}
            onClose={closeSync}
            onOpenTask={openTask}
            onShowTask={showTaskOn}
            onShowPerson={showPersonOn}
            onShowBoard={showBoardOf}
          />
        )
      case 'overview':
        // its figures, lists and health table come from the server
        if (!viewInfo) return null
        return <Overview info={viewInfo} actions={actions} />
      case 'roadmap':
        if (!viewInfo) return null
        // its tasks, arrows and Team's loads come from the server
        return (
          /* The roadmap's toolbar row is its own — the window controls and
             the Auto-move count are both local to it and cannot be handed up
             to the bar. So the bar hands the FILTERS
             down instead, ready-made: App holds the state, the roadmap holds
             the row, and the controls themselves have one definition shared
             with the board, in the same order — but three of them are left
             out here. `My tasks` is HIDDEN: the Assignee roster's
             `Me only` row throws the same flag and its trigger reads
             "Me only" while it is on, so nothing is lost. `Stale` and
             `Focus` are hidden AND inert: the roadmap takes
             `roadmapFilters`, the effective filters with `stale` and
             `focus` forced off, because a filter this view does not show
             must not narrow it (deviations #236 and #241) — see the note
             above ViewFilters.
             `filters` (not effFilters) on purpose — the controls edit the raw
             object for the same reason TopBar does. */
          <Roadmap
            info={viewInfo}
            filters={roadmapFilters}
            actions={actions}
            filterControls={(phone) => (
              <ViewFilters
                info={viewInfo}
                filters={filters}
                setFilters={setFilters}
                actions={actions}
                searchWidth={180}
                hideSearch={phone}
                hide={['mine', 'stale', 'focus']}
              />
            )}
            focusPlan={focusPlan}
            onFocusConsumed={(n) => setFocusPlan(withoutTaken(n))}
            revealTask={revealTask}
            onRevealConsumed={(n) => setRevealTask(withoutTaken(n))}
          />
        )
      case 'kanban':
        if (!viewInfo) return null
        return mobile ? (
          <MobileTaskList
            info={viewInfo}
            filters={filters}
            setFilters={setFilters}
            actions={actions}
            revealTask={revealTask}
            onRevealConsumed={(n) => setRevealTask(withoutTaken(n))}
          />
        ) : (
          <Kanban
            info={viewInfo}
            filters={effFilters}
            tweaks={tweaks}
            actions={actions}
            revealTask={revealTask}
            onRevealConsumed={(n) => setRevealTask(withoutTaken(n))}
          />
        )
    }
  }
  /** What a kept page holds besides data: the layout, and the place it
      shows where that is the page's own (the Inbox's task, Team sync's
      step). A page shown again for another one renders it at once, and the
      Inbox drops its task pane as it hides. */
  const pageVariant = (page: MainPage) => {
    const layout = mobile ? 'phone' : 'desktop'
    if (page === 'inbox') return `${layout}:${inboxTask ?? ''}`
    if (page === 'sync')
      return `${layout}:${syncPlace ? `${syncPlace.scope}:${syncPlace.step}` : ''}`
    return layout
  }

  /* Leaves Settings for the workspace, closing the task window over it,
     before Show on board or Plan on roadmap act as from the floating
     window. The callers check first that the action will act, so one that
     would only say why, or do nothing, leaves the window and Settings as
     they are. */
  const leaveSettingsFor = (act: () => void) =>
    closeOrAsk([unsent.task, unsent.page], () => {
      settingsReturn.current = NO_RETURN
      setSettingsTask(null)
      setSettingsPage(null)
      act()
    })

  return (
    <>
      {settingsView}
      {/* The task window an Archived tasks row opened, over Settings. It
         stays out of the workspace shell, which Settings hides. */}
      {settingsPage === ARCHIVED_TASKS_PAGE && settingsTask && (
        <DeferredOverlay onClose={closeSettingsTask}>
          <UnsentScopeContext.Provider value={unsent.task}>
            <IssueDetail
              issueId={settingsTask}
              onClose={closeSettingsTask}
              onOpen={(id) => closeOrAsk([unsent.task], () => setSettingsTask(id))}
              onPlanOnRoadmap={(id) => {
                // planOnRoadmap's own checks: a Backlog task only gets its
                // toast, over Settings, and a task or project the store
                // lacks gets nothing
                const it = P.taskShown(id)
                const acts =
                  it && P.topLevelOf(it.project) && (P.isGroup(it) || it.status !== 'backlog')
                if (acts) leaveSettingsFor(() => planOnRoadmap(id))
                else planOnRoadmap(id)
              }}
              unread={undefined}
              onPopOut={undefined}
              onShowOnBoard={(projectId, issueKey, keepOpen) =>
                leaveSettingsFor(() => showOnBoard(projectId, issueKey, keepOpen))
              }
            />
          </UnsentScopeContext.Provider>
        </DeferredOverlay>
      )}
      {/* While Settings shows, the workspace stays, hidden, holding the
         kept pages in place, so their elements keep their layout. */}
      <WorkspaceShell
        className="planner-shell"
        hidden={!!settingsPage}
        header={
          settingsPage ? null : mobile ? (
            <MobileHeader
              scope={scope}
              view={view}
              inboxOpen={inboxOpen}
              projectsOpen={projectsOpen}
              syncOpen={!!sync}
              actions={actions}
            />
          ) : projectsOpen ? (
            <WorkspacePageHeader label="All projects" icon="layers" />
          ) : (
            // up over the chooser too, for the Inbox tab and the view pills
            (inboxOpen || sync || viewInfo || chooserShown) && (
              <TopBar
                info={viewInfo}
                view={view}
                inboxOpen={inboxOpen}
                syncOpen={!!sync}
                setView={navView}
                filters={filters}
                setFilters={setFilters}
                tweaks={tweaks}
                setTweak={setTweak}
                actions={actions}
              />
            )
          )
        }
        navigation={
          // the desktop's rail stays while Settings shows, hidden, so the
          // project tree keeps its rows and its place
          mobile ? (
            settingsPage ? null : (
              <MobileNavigation
                scope={scope}
                inboxOpen={inboxOpen}
                projectsOpen={projectsOpen}
                syncOpen={!!sync}
                actions={actions}
              />
            )
          ) : (
            <Sidebar
              scope={scope}
              actions={actions}
              inboxOpen={inboxOpen}
              syncOpen={!!sync}
              projectsOpen={projectsOpen}
              hidden={!!settingsPage}
              focusRow={focusRowLive}
              onFocusRowDone={doneFocusRow}
            />
          )
        }
      >
        <main className="[flex:1] [display:flex] [flex-direction:column] [overflow:hidden] [min-width:0] [position:relative]">
          {!settingsPage && (
            <BillingNotice
              key={P.org.id}
              orgId={P.org.id}
              orgName={P.org.name}
              admin={P.isAdmin()}
              onBilling={() => actions.openSettings('org-billing')}
              onExport={() => actions.openSettings('org-general')}
            />
          )}
          {!settingsPage && <TasksLoadingBar />}
          {/* Every main page the person opened stays loaded, hidden, while
             another one shows (lib/keptPages.ts, ViewKeeper): coming back
             shows it as it was, without mounting it again. A new scope
             mounts the pages of that scope anew, and the old ones come
             apart after the next page paints. Each page has a boundary of
             its own. */}
          {MAIN_PAGES.map((page) => (
            <UnsentScopeContext.Provider key={page} value={unsent.page}>
              <ViewKeeper
                id={keptId(page)}
                view={page}
                shown={shownPage === page}
                variant={pageVariant(page)}
                className={page === 'inbox' || page === 'projects' ? PAGE_CLASS : VIEW_CLASS}
              >
                <ViewBoundary onBack={backToWorkspace}>
                  <Suspense fallback={<ViewLoading />}>{pageContent(page)}</Suspense>
                </ViewBoundary>
              </ViewKeeper>
            </UnsentScopeContext.Provider>
          ))}
          {/* With no project chosen, the project chooser takes the views'
             place, outside the kept pages, so it is never one of them; a
             task address the workspace does not hold waits for the task's
             answer instead, which names its project (opening). */}
          {chooserShown &&
            (scopeInfo && !scopeInfo.mine ? (
              // a project scope the project cache has not answered yet
              <ProjectChooser
                key={`scope:${scopeInfo.id}`}
                shows={scopeOpeningShows(scopeInfo, scopeOpened.current)}
                view={view}
                mobile={mobile}
                purpose={jumpLine}
                onOpen={mobile ? actions.openProject : navScope}
                onRetry={() => P.retryProjects('scope')}
                onNewProject={() => openNewProject({ kind: 'program' })}
              />
            ) : opening.kind === 'task' ? (
              <ViewLoading />
            ) : (
              <ProjectChooser
                key={opening.n}
                shows={chooserShows(opening)}
                view={view}
                mobile={mobile}
                purpose={jumpLine}
                onOpen={mobile ? actions.openProject : navScope}
                onRetry={() => {
                  if (opening.kind === 'retry')
                    showOpening((n) => ({ kind: 'checking', n, check: opening.check }))
                }}
                onNewProject={() => openNewProject({ kind: 'program' })}
              />
            ))}
        </main>
        {/* the floating window — everywhere but the inbox, which embeds the same
          component in its right pane instead of stacking one over the other */}
        {!settingsPage && !inboxOpen && openIssue && (
          <DeferredOverlay onClose={closeIssue}>
            <UnsentScopeContext.Provider value={unsent.task}>
              <IssueDetail
                issueId={openIssue}
                onClose={closeIssue}
                onOpen={openTask}
                onPlanOnRoadmap={planOnRoadmap}
                unread={undefined}
                onPopOut={undefined}
                onShowOnBoard={showOnBoard}
              />
            </UnsentScopeContext.Provider>
          </DeferredOverlay>
        )}
        {!settingsPage && paletteOpen && (
          <DeferredOverlay onClose={() => setPaletteOpen(false)}>
            <SearchPalette
              ctx={paletteCtx}
              searchIn={paletteIn}
              onClose={() => setPaletteOpen(false)}
            />
          </DeferredOverlay>
        )}
        {!settingsPage && <ToastHost toasts={toasts} dismiss={dismissToast} />}
      </WorkspaceShell>
      {dialogs}
      {settingsPage && <ToastHost toasts={toasts} dismiss={dismissToast} />}
    </>
  )
}

export default App
