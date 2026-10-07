/* App shell: sidebar hierarchy, top bar, view switching, command palette,
   keyboard shortcuts, toasts, modals, theme. */
import { type ReactNode, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BillingNotice } from './components/BillingNotice'
import {
  MobileHeader,
  MobileNavigation,
  MobileTaskList,
  ProjectDirectory,
} from './components/MobileWorkspace'
import { navRow, navRowDiv } from './components/navRow'
import { Icon, MenuItem, Popover, Seg } from './components/qivo'
import { ViewBoundary } from './components/ViewBoundary'
import { ViewFilters } from './components/viewFilters'
import {
  WorkspaceHeader,
  WorkspacePageHeader,
  WorkspaceShell,
  WorkspaceToolbar,
} from './components/WorkspaceShell'
import { flushWalkInput } from './components/walk'
import { addressMoved, rememberAddress } from './lib/addressBook'
import { lazyFromModule } from './lib/lazyModule'
import { parseSyncScope } from './lib/teamSync'
import { useMobile } from './lib/useMobile'
import './styles/mobile.css'
import { isLandscapeRoadmapOpen } from './lib/landscape'
import {
  buildPath,
  ORG_NONE,
  orgSegmentOf,
  parseHash,
  parsePath,
  pathMatchesState,
  type Route,
  scopeForIssue,
  syncPlaceOf,
} from './lib/router'
import {
  loadArchive,
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
} from './lib/workspaceChunks'
import { P } from './store/planner'
import { usePlannerVersion } from './store/usePlannerVersion'
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
const ArchivePage = lazyFromModule(loadArchive, (module) => module.ArchivePage)
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

function Sidebar({ scope, setScope, actions, inboxOpen, syncOpen }) {
  const scopeProj = P.project(scope)
  // "My view" and "All projects" are scopes, not pages — they light up like a
  // project row, and the inbox (which owns the screen) outranks both. `scope`
  // holds one value, so the four kinds of row are mutually exclusive for free.
  // Team sync is a page with a row of its own: while it is open that row is
  // the only lit one, and the scope underneath waits unlit for its return.
  const allOn = !inboxOpen && !syncOpen && P.isAllScope(scope)
  const mineOn = !inboxOpen && !syncOpen && P.isMineScope(scope)
  const scopeOn = (id: string) => !syncOpen && scope === id
  const scopeOwner = scopeProj
    ? scopeProj.type === 'meta'
      ? scopeProj.id
      : scopeProj.parent
    : null
  // flat navigation (0078): every project in the organization this user can
  // see, in one list — no workspace silo and no switcher above it
  const metas = P.visibleProjects()
  const canCreateProject = P.canCreateProject()
  /* No rule down the rail's right edge (deviation #63): --chrome is darker
     than --bg, so the rail's own value separates it from the canvas. */
  return (
    <aside
      aria-label="Workspace navigation"
      className="planner-sidebar [width:var(--sidebar-w)] [flex-shrink:0] [background:var(--chrome)] [display:flex] [flex-direction:column] [height:100vh]"
    >
      <div className="planner-navigation">
        {/* The wordmark uses the same lowercase spelling as the website. */}
        <div className="planner-brand [padding:20px_20px_0]">
          <span className="[font-size:28px] [font-weight:800] [letter-spacing:-0.03em] [line-height:1]">
            qivo
          </span>
        </div>
        {/* Home organization identity; guest-only accounts can create their own. */}
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
            <div
              data-org-well
              data-org-create
              onClick={() => actions.createOrg()}
              className="[display:flex] [align-items:center] [gap:8px] [padding:0_8px] [min-height:32px] [border-radius:var(--r-md)] [cursor:pointer] [color:var(--text-3)] [transition:background-color_var(--dur-fast)_var(--ease-out)]"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <Icon name="plus" size={16} />
              <div className="[font-weight:600] [font-size:var(--fs-base)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                Create your organization…
              </div>
            </div>
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

        {/* My view (deviation #49) — the same three views as All projects below,
          narrowed to the tasks assigned to ME on any seat I hold (0081). The
          first row because it is the personal surface (the inbox, the other
          one, is the top bar's first tab); the wider scope follows it. */}
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

        {/* All projects (deviation #47) — the same Overview / Board / Roadmap across every
          project this login can reach, home organization and guest seats alike.
          Sits above the per-project list because it is the widest scope, not a
          page of its own. */}
        <div className="[padding:0_12px_4px]">
          <Button
            variant="quiet"
            type="button"
            aria-current={allOn ? 'page' : undefined}
            data-on={allOn ? '' : undefined}
            data-all-nav
            onClick={() => actions.openAll()}
            className={navRow}
          >
            <Icon name="layers" size={16} />
            <span>All projects</span>
          </Button>
        </div>

        {/* Team sync (docs/team-sync-brief.md): the meeting page, always
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

        <div className="planner-project-list min-h-0 flex-[0_1_auto] overflow-y-auto overscroll-contain [padding:4px_12px_0]">
          <div className="[display:flex] [align-items:center] [gap:8px] [min-height:32px] [padding:8px_8px]">
            <span className="[font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-3)]">
              Projects
            </span>
            <div className="[flex:1]" />
            {canCreateProject && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="w-control-xs h-control-xs"
                aria-label="New project"
                onClick={() => actions.newProject({ kind: 'program' })}
              >
                <Icon name="plus" size={16} />
              </Button>
            )}
          </div>
          {metas.map((meta, i) => {
            // Selecting a project or one of its children reveals this branch.
            const isOpen = scopeOwner === meta.id
            const subs = meta.children
              .map((c) => P.project(c))
              .filter((sp) => !!sp && P.canSee(sp.id))
            // Blended list (0081): home-org projects first, then each foreign
            // organization's granted projects under a header with its name.
            // A guest is in exactly one project of that org, so the header is
            // the only thing naming where the work lives.
            const foreign = meta.org !== P.homeOrg
            const prev = i > 0 ? metas[i - 1] : null
            const header =
              foreign && (!prev || prev.org !== meta.org)
                ? P.orgs.find((o) => o.id === meta.org)?.name
                : null
            return (
              <div key={meta.id} className="[margin-bottom:2px]">
                {header && (
                  <HoverTooltip content={`Shared with you by ${header}`}>
                    <div
                      data-org-header={meta.org}
                      className="[display:flex] [align-items:center] [gap:8px] [padding:12px_8px_4px] [font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-3)]"
                    >
                      <Icon name="people" size={12} />
                      {header}
                    </div>
                  </HoverTooltip>
                )}
                <div
                  data-on={scopeOn(meta.id) ? '' : undefined}
                  className={cn(navRowDiv, 'hoverrow gap-1 font-semibold')}
                  onClick={() => setScope(meta.id)}
                >
                  <Button
                    variant="unstyled"
                    type="button"
                    aria-current={scopeOn(meta.id) ? 'page' : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      setScope(meta.id)
                    }}
                    className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
                  >
                    {meta.name}
                  </Button>
                  {/* Keep one trailing action target so ordinary project names
                    fit the rail. The menu retains New sub-project for leads. */}
                  <Popover
                    width={196}
                    align="right"
                    button={(t) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="w-control-xs h-control-xs"
                        aria-label="Project actions"
                        onClick={(e) => {
                          e.stopPropagation()
                          t()
                        }}
                      >
                        <Icon name="more" size={16} />
                      </Button>
                    )}
                  >
                    {(close) => (
                      <>
                        {P.levelOn(meta.id) === 'lead' && (
                          <MenuItem
                            onClick={() => {
                              close()
                              actions.newProject({ parent: meta.id })
                            }}
                          >
                            <Icon name="plus" size={16} />
                            New sub-project…
                          </MenuItem>
                        )}
                        <MenuItem
                          onClick={() => {
                            close()
                            actions.openSettings(`project:${meta.id}`)
                          }}
                        >
                          <Icon name="cog" size={16} />
                          Project settings
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            close()
                            actions.openArchive(meta.id)
                          }}
                        >
                          <Icon name="inbox" size={14} />
                          Archived tasks
                        </MenuItem>
                      </>
                    )}
                  </Popover>
                </div>
                {isOpen &&
                  subs.map((sp) => (
                    // Compact branch lines show the hierarchy beside the names.
                    // ONE SELECTION IDIOM in the rail: a selected sub-project is
                    // the same LIFTED TILE as a selected project row, the inbox
                    // and the two sentinels — --surface-1 under --qivo-shadow-card.
                    // Depth is carried by this indent and the 600 weight, not by a
                    // second colour language, which is what frees --accent-soft
                    // from doing six unrelated jobs at once.
                    <div
                      key={sp.id}
                      data-on={scopeOn(sp.id) ? '' : undefined}
                      onClick={() => setScope(sp.id)}
                      className={cn(navRowDiv, 'planner-subproject relative pl-6')}
                    >
                      <Button
                        variant="unstyled"
                        type="button"
                        aria-current={scopeOn(sp.id) ? 'page' : undefined}
                        onClick={(e) => {
                          e.stopPropagation()
                          setScope(sp.id)
                        }}
                        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
                      >
                        {sp.name}
                      </Button>
                      <Popover
                        width={206}
                        align="right"
                        button={(t) => (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="w-control-xs h-control-xs"
                            aria-label="Sub-project actions"
                            onClick={(e) => {
                              e.stopPropagation()
                              t()
                            }}
                          >
                            <Icon name="more" size={16} />
                          </Button>
                        )}
                      >
                        {(close) => (
                          <>
                            <MenuItem
                              onClick={() => {
                                close()
                                actions.openSettings(`project:${sp.id}`)
                              }}
                            >
                              <Icon name="cog" size={16} />
                              Sub-project settings
                            </MenuItem>
                            <MenuItem
                              onClick={() => {
                                close()
                                actions.openArchive(sp.id)
                              }}
                            >
                              <Icon name="inbox" size={14} />
                              Archived tasks
                            </MenuItem>
                          </>
                        )}
                      </Popover>
                    </div>
                  ))}
                {isOpen && subs.length === 0 && P.levelOn(meta.id) === 'lead' && (
                  <Button
                    type="button"
                    onClick={() => actions.newProject({ parent: meta.id })}
                    variant="ghost"
                    className="[margin:8px_0_8px_24px] h-control-sm [font-size:var(--fs-sm)] [color:var(--text-3)]"
                  >
                    <Icon name="plus" size={16} />
                    Add sub-project
                  </Button>
                )}
              </div>
            )
          })}
        </div>

        {/* Settings follows the project list with the same section gap as the
          brand and organization. The list shrinks to scroll only when needed;
          the footer stays outside it, without an expanding empty space.
          Lands on your own preferences; its own nav reaches the organization,
          the teams you lead and every project you can see, which is why the
          top bar no longer carries a per-project gear. (The Archive that sat
          here is reached from a project row's "…" menu, or #/archive.) */}
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
    </aside>
  )
}

/* ---------- top bar ---------- */
const VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'chart', kbd: '1' },
  { id: 'kanban', label: 'Board', icon: 'board', kbd: '2' },
  { id: 'roadmap', label: 'Roadmap', icon: 'timeline', kbd: '3' },
]

/* The desktop top bar: the Inbox glyph and the three views in one switch,
   then the Board's filter row. It stays up while the inbox is open, with the
   Inbox tab lit, so every view is one click from the inbox and back; `info`
   can be null only then (a scope the access guard has not re-homed yet).
   `setView` must leave the inbox, so App hands it `navView`. Over Team sync
   the bar stays up the same way with nothing lit: the page is not a view of
   the scope, and a view tab leaves it for that view. */
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
  // Assignee lanes also arrange tasks inside a single sub-project.
  const showGrouping = info?.subIds.length > 0
  // View switching and task creation share the first row across all views.
  // Board filters/grouping sit below; Roadmap owns its own toolbar.
  const showFilters = !inboxOpen && !syncOpen && !!info && view === 'kanban'
  const unread = P.unreadMessages

  return (
    /* no rule under it either (deviation #63) — the bar is --chrome and the
       view below is --bg, and that value step is the boundary */
    <>
      {/* nothing at the right: creating a task belongs to the board itself
          (a status column's +, a side-board's +, an empty board's action), so
          the bar carries only the switcher (deviation #233) */}
      <WorkspaceHeader
        left={
          <h1 className="sr-only">{inboxOpen ? 'Inbox' : syncOpen ? 'Team sync' : info?.name}</h1>
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
            because an outline cannot be read over the glyph's own lines. */}
        <div data-view-switch className="[justify-self:center]">
          <Seg
            fit
            value={inboxOpen ? 'inbox' : syncOpen ? 'sync' : view}
            onChange={(v) => (v === 'inbox' ? actions.openInbox() : setView(v))}
            options={[
              {
                value: 'inbox',
                icon: 'mail',
                ariaLabel: unread > 0 ? `Inbox, ${unread} unread` : 'Inbox',
                badge: unread > 0 && (
                  <span
                    data-inbox-badge
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-1.5 left-2.5 h-3.5 min-w-3.5 rounded-full bg-text-1 px-[3px] text-center font-mono text-[9px] leading-3.5 font-bold text-[var(--bg)] tabular-nums"
                  >
                    {unread > 99 ? '99+' : unread}
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
          view switcher (12px from each band), then 8px before the board, the
          Roadmap toolbar's gap above its timeline. */}
      {showFilters && (
        <WorkspaceToolbar>
          <div
            data-filter-row
            className="[display:flex] [align-items:center] [justify-content:center] [gap:8px] [padding:12px_20px_8px] [flex-wrap:wrap]"
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
                      className="rounded-sm"
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
                      <Icon name="chevronDown" size={13} />
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
function ToastHost({ toasts, dismiss }) {
  if (!toasts.length) return null
  return createPortal(
    <div className="planner-toast-host [position:fixed] [bottom:20px] [left:50%] [transform:translateX(-50%)] [z-index:130] [display:flex] [flex-direction:column] [gap:8px] [align-items:center]">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-floating-surface
          className="animate-in fade-in slide-in-from-bottom-2 [display:flex] [align-items:center] [gap:8px] [padding:8px] [background:var(--surface-2)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-pop)] [font-size:var(--fs-base)] [color:var(--text-1)]"
        >
          <Icon name="check" size={16} color="var(--success)" />
          {t.text}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-control-xs h-control-xs"
            onClick={() => dismiss(t.id)}
          >
            <Icon name="close" size={16} />
          </Button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

/* Where a Team sync address opens the page for this viewer (the router's
   rule: the saved scope, and the phone's own page for the bare link only). */
function syncPlaceFor(r: NonNullable<Route['sync']>, mobile: boolean): SyncPlace {
  return syncPlaceOf(r, { saved: P.loadUI().syncScope, me: P.CURRENT_USER, mobile })
}

/* The page under Settings, the Archive or Team sync, restored when it
   closes (Team sync never sits over itself, so its return has no sync). A
   restore uses it once: it is reset as it is read, and on any Back or
   Forward that leaves its page. */
type PageReturn = { inbox: boolean; projects: boolean; sync: SyncPlace | null }
const NO_RETURN: PageReturn = { inbox: false, projects: false, sync: null }

/* ---------- root ---------- */
function App() {
  const mobile = useMobile()
  const ui0 = P.loadUI()
  /* Deep link wins over the saved UI state. Two grammars are read, in order:
     the path, then — only if the path named nothing — a pre-path HASH link
     (#/board/p/12), which is every link shared before the move. The url-sync
     effect below then rewrites the address to the path form on the first
     commit, so a legacy link is translated exactly once and never again.
     Both return null for "named nothing", which is what lets the saved UI
     state survive a visit to a bare /app/<org> front door. */
  const r0 = parsePath(location.pathname) || parseHash(location.hash)
  // a scope is either a project row or one of the two sentinels (All projects,
  // My view) — those resolve to no row on purpose, so every check has to admit
  // them explicitly, or a saved pref and a #/board/mine deep link both boot
  // into the first visible project instead
  const liveScope = (s) => !!s && (P.isWideScope(s) || !!P.project(s))
  const uiScope = liveScope(ui0.scope) ? ui0.scope : null
  // issue URLs carry no scope segment (the issue names its own project):
  // keep the saved scope when the issue lives inside it, else jump to the
  // issue's sub-project — link recipients land on a board that shows it.
  // A task over Team sync is the exception: the page names its own scope,
  // and the one underneath stays the saved one.
  const r0Scope =
    r0 && !r0.sync
      ? r0.scope || (r0.issue ? scopeForIssue(r0.issue, uiScope) : undefined)
      : undefined
  // project ids are DB uuids (not the prototype's fixed slugs): default the
  // scope to the first visible project org-wide (navigation is flat since 0078)
  const [scope, setScope] = useState(() =>
    liveScope(r0Scope) ? r0Scope : uiScope ? uiScope : P.visibleProjects()[0]?.id,
  )
  // prefs saved before the merge may still say "split"/"resources" — both
  // collapsed into the roadmap (which now always docks the resource strip)
  const uiView0 = ui0.view === 'split' || ui0.view === 'resources' ? 'roadmap' : ui0.view
  const uiView = ['overview', 'kanban', 'roadmap'].includes(uiView0) ? uiView0 : 'overview'
  const [view, setView] = useState(() =>
    // a viewless issue short link keeps the saved view (the modal sits over
    // whatever's behind), and so does Team sync, which returns to it on Done;
    // scope/settings routes without a view mean overview
    r0?.view
      ? r0.view
      : r0?.issue ||
          r0?.sync ||
          (mobile && (r0?.settings || r0?.projects || r0?.inbox || r0?.archive))
        ? uiView
        : r0
          ? 'overview'
          : uiView,
  )
  const [openIssue, setOpenIssue] = useState(r0?.issue || null)
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
  const [focusPlan, setFocusPlan] = useState(null)
  const focusN = useRef(0)
  // Team sync's Roadmap jump: reveal a task's bar read-only, { id, n } like
  // focusPlan (the nonce comes from the same counter)
  const [revealTask, setRevealTask] = useState(null)
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
  const [modal, setModal] = useState(null) // {kind:"issue"|"program"|"subproject"|"milestone", init}
  const [settingsPage, setSettingsPage] = useState(r0?.settings || null) // null | "account" | "org-*" | "team:<id>" | "project:<id>"
  const [archiveOpen, setArchiveOpen] = useState(!!r0?.archive) // the Archive page (0070)
  const [inboxOpen, setInboxOpen] = useState(!!r0?.inbox || (mobile && !r0)) // the message inbox (0074)
  // the project a "⋯ → Archived issues" entry asked for; null = derive from
  // the current scope (the sidebar's pinned Archive entry, deep links)
  const [projectsOpen, setProjectsOpen] = useState(!!r0?.projects)
  /* Team sync (the meeting page) while it is open: { scope, step }. It sits
     over the scope and view, which it leaves untouched so Done returns to
     them. Only a login with a home organization has the page. */
  const [sync, setSync] = useState<SyncPlace | null>(() =>
    r0?.sync && P.homeOrg ? syncPlaceFor(r0.sync, mobile) : null,
  )
  // edits made on the sync page are not roadmap edits, whatever the view below
  const roadmapActive =
    view === 'roadmap' && !settingsPage && !archiveOpen && !inboxOpen && !projectsOpen && !sync
  useLayoutEffect(() => {
    P.roadmapContext(roadmapActive, !!openIssue)
  }, [roadmapActive, openIssue])
  useLayoutEffect(() => () => P.roadmapContext(false, false), [])
  // the page Settings, the Archive and Team sync return to on exit
  const settingsReturn = useRef(NO_RETURN)
  const archiveReturn = useRef(NO_RETURN)
  const syncReturn = useRef(NO_RETURN)
  const replaceNextHistory = useRef(false)
  const [archiveProject, setArchiveProject] = useState(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toasts, setToasts] = useState([])
  const rev = usePlannerVersion()

  // date rendering follows the organization's format setting; set during
  // render so everything below formats consistently on this pass
  P.setDateFormat(P.org.dateFormat)

  // toasts
  useEffect(() => {
    window.showToast = (text) => {
      const id = ++toastSeq
      setToasts((t) => [...t.slice(-2), { id, text }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
    }
    return () => {
      window.showToast = null
    }
  }, [])
  const dismissToast = (id) => setToasts((t) => t.filter((x) => x.id !== id))

  // ui persistence
  useEffect(() => {
    P.saveUI({ scope, view })
  }, [scope, view])

  // url sync — every "page" (scope/view/open issue/settings) gets its own
  // path. rev is a dependency on purpose: paths embed store-derived refs (the
  // scope project's num, the owning org's slug — which an admin can now
  // change, and which arrives here over realtime), and an insert reconcile can
  // correct them without any of the other deps changing. Re-running on store
  // emits lets the address bar self-heal, and the equality early return makes
  // that free. Synchronize during the commit: a passive effect can run after
  // native Back has changed the URL and push the previous page back into history.
  useLayoutEffect(() => {
    const p = buildPath({
      scope,
      view,
      openIssue,
      settingsPage,
      archiveOpen,
      inboxOpen,
      projectsOpen,
      sync,
    })
    // the hash term is what finally clears a translated legacy link: the path
    // is already canonical by then, so nothing else would ever rewrite it
    if (location.pathname === p && !location.hash) {
      replaceNextHistory.current = false
      return
    }
    if (
      replaceNextHistory.current ||
      pathMatchesState(location.pathname, {
        scope,
        view,
        openIssue,
        settingsPage,
        archiveOpen,
        inboxOpen,
        projectsOpen,
        sync,
      })
    )
      history.replaceState(history.state, '', p)
    else history.pushState({ qivoPrevious: location.pathname }, '', p)
    replaceNextHistory.current = false
  }, [scope, view, openIssue, settingsPage, archiveOpen, inboxOpen, projectsOpen, sync, rev])
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
  }, [
    addrMoved,
    scope,
    view,
    openIssue,
    settingsPage,
    archiveOpen,
    inboxOpen,
    projectsOpen,
    sync,
    rev,
  ])
  useEffect(() => {
    const onPop = () => {
      // a Remaining number typed on Team sync and not yet committed: history
      // unmounts its box without a blur, so commit it before the page moves
      flushWalkInput('sync')
      // same two grammars as the boot read, same order — Back can land on a
      // legacy entry from earlier in this session's history
      const r = parsePath(location.pathname) || parseHash(location.hash)
      if (!r) return
      /* A return belongs to the visit that opened its page. A pop that stays
         on the page keeps it (Back through Settings' pages, a phone layer, a
         task closing over the sync); one that leaves drops it, so a later
         Exit or Done cannot restore a page from another visit. */
      if (!r.settings) settingsReturn.current = NO_RETURN
      if (!r.archive) archiveReturn.current = NO_RETURN
      if (!r.sync) syncReturn.current = NO_RETURN
      /* Issue URLs carry no scope: keep the current scope when the issue is
         inside it, else re-scope to the issue's own sub-project. One case
         must NOT keep it — `/app/<org>/<view>/tasks/<task>` IS the project-scope form
         (it omits the segment because the issue names its own project), so
         going Back to it from a sentinel scope is a request to LEAVE the mode.
         Carrying 'all'/'mine' through instead would leave the pane in a state
         the address doesn't describe, and the url-sync effect would then push
         a forward entry over the one just popped — a Back that can't get out.
         No UI path reaches such an entry today (entering the mode needs the
         sidebar, which the window's scrim covers), but the rule belongs with
         the router's own absent-scope-means-project-form reading.
         A Team sync address names its own scope, so the one underneath stays
         put, task or not. */
      const preferred =
        r.view && !r.scope && P.isWideScope(scopeRef.current) ? null : scopeRef.current
      const sc = r.sync
        ? undefined
        : liveScope(r.scope)
          ? r.scope
          : r.issue
            ? scopeForIssue(r.issue, preferred)
            : undefined
      if (liveScope(sc)) setScope(sc)
      if (r.view) setView(r.view)
      // viewless issue links keep the current view; #/archive, #/inbox and
      // Team sync sit over/instead of the current view, so they must not
      // reset it either
      else if (!r.issue && !r.archive && !r.inbox && !r.settings && !r.projects && !r.sync)
        setView('overview')
      setOpenIssue(r.issue || null)
      setSettingsPage(r.settings || null)
      setArchiveOpen(!!r.archive)
      setInboxOpen(!!r.inbox)
      setProjectsOpen(!!r.projects)
      setSync(r.sync && P.homeOrg ? syncPlaceFor(r.sync, mobileRef.current) : null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // access guard — keep the scope within what the current user can see. Both
  // sentinels ARE "what the user can see", so neither needs rescuing — and
  // each resolves to no project row, which would otherwise bounce it away one
  // commit after it was entered (and persist the bounce).
  useEffect(() => {
    if (P.isWideScope(scope)) return
    const metas = P.visibleProjects()
    const p = P.project(scope)
    const meta = p ? (p.type === 'meta' ? p : P.project(p.parent)) : null
    if (!(meta && metas.some((m) => m.id === meta.id)) && metas[0]) setScope(metas[0].id)
  }, [scope, rev])

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
  const navScope = (id) => {
    leaveInbox()
    setScope(id)
  }
  const navView = (v) => {
    leaveInbox()
    setView(v)
  }
  const navOpenIssue = (k) => {
    if (k) {
      setInboxOpen(false)
      setProjectsOpen(false)
    }
    setOpenIssue(k)
  }

  const openNewIssue = (init) => {
    /* Desktop creates normally name a project. The phone's My tasks and
       All projects actions can open without one: the dialog offers only
       writable projects and asks for the project/sub-project there. */
    const target = init.project || (P.isWideScope(scope) ? null : scope)
    const proj = target ? P.project(target) : null
    // "tasks live in sub-projects": a project with none can't receive one.
    // The rule follows the TARGET, not just the scope — a sentinel scope gives
    // every project a lane and a track, and their + buttons name them.
    if (proj && proj.type === 'meta' && proj.children.length === 0) {
      window.showToast?.('Create a sub-project first — tasks live in sub-projects')
      setModal({ kind: 'subproject', init: { parent: proj.id } })
      return
    }
    // …and with no target at all (a sentinel scope, nothing to put a task in
    // anywhere) there is no project to parent a sub-project to either. The
    // TopBar button already disables here; the palette's doesn't, so say why
    // rather than opening a dialog that could never be submitted.
    if (!target && !(P.scopeInfo(scope) || { subIds: [] }).subIds.length) {
      window.showToast?.('Create a sub-project first — tasks live in sub-projects')
      return
    }
    setModal({ kind: 'issue', init: { ...init, project: target } })
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

  /* A milestone lands on exactly ONE project's roadmap (0078), so a sentinel
     scope has none to offer: the three surfaces that create one (the Overview
     section's +, the Roadmap toolbar, the palette) all hide there. This is the
     single closure behind them — the two copies it replaces had already
     drifted apart once — and it never lets a sentinel reach the dialog. */
  const openNewMilestone = (init) =>
    setModal({
      kind: 'milestone',
      init: { project: P.isWideScope(scope) ? null : scope, ...(init || {}) },
    })

  // "New project" and "New sub-project" are separate dialogs; kind:"program"
  // (sidebar header +, palette) opens the project one, everything else —
  // always parented — opens the sub-project one
  const openNewProject = (init) =>
    setModal({
      kind: init && init.kind === 'program' ? 'program' : 'subproject',
      init: { ...(init || {}) },
    })

  // Jump from the issue window to the roadmap to plan an issue in context.
  // Switches to the issue's project/roadmap and closes the window so the
  // timeline is interactable; the Roadmap opens a planning session (spotlight
  // + card) that owns the initial placement, auto-fit, and Confirm/Cancel.
  const planOnRoadmap = (id) => {
    const it = P.issueById[id]
    if (!it) return
    if (it.status === 'backlog') {
      window.showToast?.('Move this task out of Backlog before planning it on the roadmap')
      return
    }
    const meta = P.metaOf(it.project)
    if (!meta) return
    /* All projects already carries this issue's track — planning from there
       stays there rather than dropping the user into one project. My view
       carries it only when it IS mine: spotlighting somebody else's task from
       there would open a planning session over a bar the view doesn't render. */
    const cur = scopeRef.current
    if (!(P.isAllScope(cur) || (P.isMineScope(cur) && P.isMine(it)))) setScope(meta.id)
    setView('roadmap')
    setProjectsOpen(false)
    setInboxOpen(false)
    setSync(null)
    setOpenIssue(null)
    focusN.current += 1
    setFocusPlan({ id, n: focusN.current })
  }

  // Task breadcrumb clicks switch to the Board scoped to the clicked
  // project/sub-project; the Inbox's Open task in board action also opens the task.
  const showOnBoard = (projectId, issueKey?) => {
    const p = P.project(projectId)
    if (!p) return
    setScope(projectId)
    setView('kanban')
    setProjectsOpen(false)
    setInboxOpen(false)
    setSync(null)
    setOpenIssue(issueKey || null)
  }

  // A phone's Back action consumes the page it opened. Direct links have no
  // in-app predecessor; replace those with the parent instead of looping back
  // into a task or setting the user just dismissed.
  const backOrSet = (patch, apply: () => void) => {
    const phoneHistory = mobile || isLandscapeRoadmapOpen()
    const target = buildPath({
      scope,
      view,
      openIssue,
      settingsPage,
      archiveOpen,
      inboxOpen,
      projectsOpen,
      sync,
      ...patch,
    })
    if (phoneHistory && history.state?.qivoPrevious === target) history.back()
    else {
      replaceNextHistory.current = phoneHistory
      apply()
    }
  }
  const closeIssue = () => backOrSet({ openIssue: null }, () => setOpenIssue(null))

  /* ---- Team sync's hand-offs (the TeamSync props) ---- */
  // a step or a scope from the page; the address follows in place (the
  // router's sync rule), and a new scope is the viewer's saved choice
  const placeSync = (next: SyncPlace) => {
    if (sync && next.scope === sync.scope && next.step === sync.step) return
    if (next.scope !== sync?.scope) P.saveUINow({ syncScope: next.scope })
    setSync(next)
  }
  // Done on the last step: back to the page it was opened from (the Inbox,
  // the Projects directory), else the scope and view underneath
  const closeSync = () => {
    const back = syncReturn.current
    syncReturn.current = NO_RETURN
    backOrSet({ sync: null, inboxOpen: back.inbox, projectsOpen: back.projects }, () => {
      setSync(null)
      setInboxOpen(back.inbox)
      setProjectsOpen(back.projects)
    })
  }
  /* A row's Board or Roadmap jump: leave the page for that view, scoped so
     the task is on it (All projects when the sync covers all projects, else
     the task's own sub-project). Filters left from before the sync are
     cleared, Focus kept, since nothing on the sync could show why the task
     is missing. The Board opens the task window over it, as showOnBoard
     does; the Roadmap reveals its bar read-only (scrolled into view and
     ringed for a moment: no planning session, nothing written). */
  const showTaskOn = (v: 'kanban' | 'roadmap', handle: string) => {
    const it = P.issueById[handle]
    if (!it) return
    clearFilters()
    setSync(null)
    setScope(sync?.scope === 'all' ? P.ALL_SCOPE : it.project)
    setView(v)
    setOpenIssue(v === 'kanban' ? handle : null)
    if (v === 'roadmap') {
      focusN.current += 1
      setRevealTask({ id: handle, n: focusN.current })
    }
  }
  /* A person header's Board or Roadmap jump: leave the page for that view
     filtered to the person (the filters match the task's owner, the rule
     the sync's rows follow) over the view scope nearest the sync's: one
     project stays that project; all projects and a team (views have no team
     scope) become All projects, never My view, which drops the filter. */
  const showPersonOn = (v: 'kanban' | 'roadmap', profileId: string) => {
    const place = parseSyncScope(sync?.scope)
    setFilters((f) => ({
      search: '',
      mine: false,
      assignees: [profileId],
      priority: null,
      stale: false,
      focus: f.focus,
    }))
    setSync(null)
    setScope(place.kind === 'project' && P.project(place.id) ? place.id : P.ALL_SCOPE)
    setView(v)
    setOpenIssue(null)
  }

  const actions = {
    openIssue: navOpenIssue,
    newIssue: openNewIssue,
    newProject: openNewProject,
    newMilestone: openNewMilestone,
    editMilestone: (id) => setModal({ kind: 'milestone', init: { id } }),
    // settings, the archive and the inbox each own the screen — one at a time
    openSettings: (page) => {
      settingsReturn.current = { inbox: inboxOpen, projects: projectsOpen, sync }
      setArchiveOpen(false)
      leaveInbox()
      setSettingsPage(page || (mobile ? 'menu' : 'account'))
    },
    openArchive: (projectId?) => {
      archiveReturn.current = { inbox: inboxOpen, projects: projectsOpen, sync }
      setSettingsPage(null)
      leaveInbox()
      setArchiveProject(projectId || null)
      setArchiveOpen(true)
    },
    // …and its pane starts empty: the inbox is a triage surface, so arriving
    // at it holding whatever task the last view had open would light a row-less
    // pane before a single message has been read. A deep link straight to
    // /inbox/tasks/<task> is the other direction and still lands on the task.
    openInbox: () => {
      setProjectsOpen(false)
      setSettingsPage(null)
      setArchiveOpen(false)
      setSync(null)
      setOpenIssue(null)
      setInboxOpen(true)
    },
    // both sentinels are scopes, so they also have to leave whichever page owns
    // the screen — the sidebar is visible from the inbox, the palette from all
    openAll: () => {
      setSettingsPage(null)
      setArchiveOpen(false)
      leaveInbox()
      setScope(P.ALL_SCOPE)
    },
    openMine: () => {
      setSettingsPage(null)
      setArchiveOpen(false)
      leaveInbox()
      setScope(P.MINE_SCOPE)
      if (mobile) setView('kanban')
    },
    openProjects: () => {
      setSettingsPage(null)
      setArchiveOpen(false)
      setInboxOpen(false)
      setSync(null)
      setOpenIssue(null)
      setProjectsOpen(true)
    },
    // Team sync (the sidebar row, the phone's Sync tab): opens on the saved
    // scope, remembering the Inbox or Projects page for Done; pressed while
    // open, it stays where the walk is
    openSync: () => {
      if (!P.homeOrg) return
      if (!sync) {
        syncReturn.current = { inbox: inboxOpen, projects: projectsOpen, sync: null }
        setSync(syncPlaceFor({}, mobile))
      }
      setSettingsPage(null)
      setArchiveOpen(false)
      setProjectsOpen(false)
      if (inboxOpen) setOpenIssue(null)
      setInboxOpen(false)
    },
    clearFilters,
    setScope: navScope,
    openProject: (id) => {
      navScope(id)
      if (mobile) setView('kanban')
    },
    setView: navView,
    planOnRoadmap,
    openPalette: () => setPaletteOpen(true),
    createOrg: () => setModal({ kind: 'createorg' }),
  }

  const createIssue = (issue) => {
    // the issue's key exists only once the row does — addIssue returns it.
    // The preview can be invalidated by ANY concurrent create in the org
    // (0050's shared counter): onKeyFixed re-anchors the newly opened
    // editor when the insert reconciles, so it
    // doesn't blank (or later resolve to the concurrent issue).
    const key = P.addIssue(
      issue,
      (fixed) => setOpenIssue((cur) => (cur === key ? fixed : cur)),
      () => setOpenIssue((cur) => (cur === key ? null : cur)),
    )
    if (!key) {
      window.showToast?.('That sub-project is gone — task not created')
      return false
    }
    // Replace the phone create layer with the task's URL. Retiring its marker
    // before unmount keeps the layer cleanup from restoring stale history.
    if (history.state?.qivoLayer) {
      history.replaceState({ qivoPrevious: location.pathname }, '', location.href)
      replaceNextHistory.current = true
    }
    setModal(null)
    window.showToast?.(`Created ${P.issueById[key]?.key || key}`)
    const curProj = P.project(scope)
    /* All projects already shows it — jumping out of the widest scope to a
       single sub-project would be a demotion, not a "so you can see it". My
       view shows it only if it landed on me; a task created from a side-board's
       + is unassigned, so that one still jumps to its sub-project. */
    const inScope =
      P.isAllScope(scope) ||
      (P.isMineScope(scope) && P.isMine(P.issueById[key])) ||
      (curProj &&
        (curProj.id === issue.project || (curProj.children || []).includes(issue.project)))
    // Keep the task visible underneath its editor when creation changes scope.
    if (!inScope) setScope(issue.project)
    navOpenIssue(key)
    return true
  }
  const createProject = (p, { withStarter }) => {
    // Projects and sub-projects are led by people and shared through explicit grants.
    if (p.type === 'meta') p.access = p.access || {}
    const id = P.addProject(p)
    if (withStarter) {
      P.addIssue({
        title: p.name,
        project: id,
        status: 'backlog',
        priority: 'medium',
        assignee: p.lead || null,
        parent: null,
      })
    }
    setModal(null)
    window.showToast?.(`${p.type === 'meta' ? 'Project' : 'Sub-project'} “${p.name}” created`)
    setScope(id)
    setProjectsOpen(false)
    setSync(null)
  }

  const setTweak = (patch) => {
    setTweaks((prev) => ({ ...prev, ...patch }))
    P.saveUI(patch)
  }

  // the palette searches and nothing else, so it needs only the two ways to
  // open what it found
  const paletteCtx = { setScope: navScope, openIssue: navOpenIssue }

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
        <div className="[height:100vh] [display:grid] [place-items:center]">
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

  if (settingsPage) {
    return (
      <>
        <ViewBoundary onBack={() => setSettingsPage(null)}>
          <Suspense fallback={<ViewLoading />}>
            <SettingsScreen
              page={settingsPage}
              setPage={setSettingsPage}
              onBackPage={(page) => backOrSet({ settingsPage: page }, () => setSettingsPage(page))}
              onExit={() => {
                const back = settingsReturn.current
                settingsReturn.current = NO_RETURN
                backOrSet(
                  {
                    settingsPage: null,
                    inboxOpen: back.inbox,
                    projectsOpen: back.projects,
                    sync: back.sync,
                  },
                  () => {
                    setSettingsPage(null)
                    setInboxOpen(back.inbox)
                    setProjectsOpen(back.projects)
                    setSync(back.sync)
                  },
                )
              }}
              onNewProject={() => openNewProject({ kind: 'program' })}
              onNewSubProject={(parent) => openNewProject({ parent })}
              onOpenArchive={(projectId) => actions.openArchive(projectId)}
              onProjectGone={(parent) => {
                // deleted or archived — from out here they are the same event: a
                // project the scope may have been pointing at is no longer one of
                // the ones this login can open. Both sentinels survive it — each is
                // defined by what's left, not by the row that went away.
                if (P.isWideScope(scope)) return
                const fb = parent && P.project(parent) ? parent : P.visibleProjects()[0]?.id
                if (fb) setScope(fb)
              }}
            />
          </Suspense>
        </ViewBoundary>
        {modal && modal.kind === 'program' && (
          <DeferredOverlay onClose={() => setModal(null)}>
            <NewProjectModal
              init={modal.init}
              onClose={() => setModal(null)}
              onCreate={createProject}
            />
          </DeferredOverlay>
        )}
        <ToastHost toasts={toasts} dismiss={dismissToast} />
      </>
    )
  }

  if (archiveOpen) {
    // null from either sentinel scope, deliberately: the Archive page shows
    // ONE project at a time, so it opens on its own picker rather than being
    // pre-scoped to an arbitrary one (P.project() is undefined for both)
    const scopeMeta = (() => {
      const p = P.project(scope)
      return p ? (p.type === 'meta' ? p.id : p.parent) : null
    })()
    return (
      <>
        <ViewBoundary onBack={() => setArchiveOpen(false)}>
          <Suspense fallback={<ViewLoading />}>
            <ArchivePage
              initialProject={archiveProject || scopeMeta}
              onExit={() => {
                const back = archiveReturn.current
                archiveReturn.current = NO_RETURN
                backOrSet(
                  {
                    archiveOpen: false,
                    inboxOpen: back.inbox,
                    projectsOpen: back.projects,
                    sync: back.sync,
                  },
                  () => {
                    setArchiveOpen(false)
                    setInboxOpen(back.inbox)
                    setProjectsOpen(back.projects)
                    setSync(back.sync)
                  },
                )
              }}
            />
          </Suspense>
        </ViewBoundary>
        <ToastHost toasts={toasts} dismiss={dismissToast} />
      </>
    )
  }

  // The scope row can vanish mid-session (deleted by another member, or over
  // REST/MCP). The access guard above re-scopes one commit later, but THIS
  // render still runs with the dead id — and an uncaught render error would
  // unmount the tree for good, so the guard never gets its chance. Skip the
  // scoped pane for that frame; the sidebar (already null-safe) stays up.
  // scopeInfo returns null for exactly that dead scope, and a full description
  // for the live ones (both sentinels included).
  const scopeInfo = P.scopeInfo(scope)

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

  return (
    <WorkspaceShell
      className="planner-shell"
      header={
        mobile ? (
          <MobileHeader
            scope={scope}
            view={view}
            inboxOpen={inboxOpen}
            projectsOpen={projectsOpen}
            syncOpen={!!sync}
            actions={actions}
          />
        ) : projectsOpen ? (
          <WorkspacePageHeader label="Projects" icon="layers" />
        ) : (
          (inboxOpen || sync || scopeInfo) && (
            <TopBar
              info={scopeInfo}
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
        mobile ? (
          <MobileNavigation
            scope={scope}
            inboxOpen={inboxOpen}
            projectsOpen={projectsOpen}
            syncOpen={!!sync}
            actions={actions}
          />
        ) : (
          <Sidebar
            scope={scope}
            setScope={navScope}
            actions={actions}
            inboxOpen={inboxOpen}
            syncOpen={!!sync}
          />
        )
      }
    >
      <main className="[flex:1] [display:flex] [flex-direction:column] [overflow:hidden] [min-width:0]">
        <BillingNotice
          key={P.org.id}
          orgId={P.org.id}
          orgName={P.org.name}
          admin={P.isAdmin()}
          onBilling={() => actions.openSettings('org-billing')}
        />
        <ViewBoundary
          key={sync ? 'sync' : inboxOpen ? 'inbox' : projectsOpen ? 'projects' : view}
          onBack={() => {
            setSync(null)
            setInboxOpen(false)
            setProjectsOpen(false)
            setView('overview')
          }}
        >
          <Suspense fallback={<ViewLoading />}>
            {projectsOpen ? (
              <ProjectDirectory actions={actions} />
            ) : inboxOpen ? (
              // openTask is the raw setter on purpose: the inbox's right pane IS
              // the task window, so opening a task must NOT leave the inbox — and
              // `openIssue` is what that pane shows, which is why the address
              // (/inbox/tasks/<task>) restores it
              <Inbox
                showOnBoard={showOnBoard}
                onExit={() => setInboxOpen(false)}
                openTask={(id) => (id ? setOpenIssue(id) : closeIssue())}
                openIssue={openIssue}
                onPlanOnRoadmap={planOnRoadmap}
              />
            ) : sync ? (
              /* Team sync, over the scope and view it returns to. Its tasks open
             in the floating window below (the raw setter: opening one must
             not leave the page), and Escape does not close it: a meeting
             page must not vanish on a stray key. */
              <div
                data-workspace-view="sync"
                className="animate-in fade-in slide-in-from-bottom-1 [flex:1] [display:flex] [flex-direction:column] [overflow:hidden]"
              >
                <TeamSync
                  place={sync}
                  onPlace={placeSync}
                  onClose={closeSync}
                  onOpenTask={setOpenIssue}
                  onShowTask={showTaskOn}
                  onShowPerson={showPersonOn}
                />
              </div>
            ) : (
              scopeInfo && (
                <div
                  key={scope + view}
                  data-workspace-view={view}
                  className="animate-in fade-in slide-in-from-bottom-1 [flex:1] [display:flex] [flex-direction:column] [overflow:hidden]"
                >
                  {view === 'overview' && <Overview info={scopeInfo} actions={actions} />}
                  {view === 'kanban' &&
                    (mobile ? (
                      <MobileTaskList
                        info={scopeInfo}
                        filters={filters}
                        setFilters={setFilters}
                        actions={actions}
                      />
                    ) : (
                      <Kanban
                        info={scopeInfo}
                        filters={effFilters}
                        tweaks={tweaks}
                        actions={actions}
                      />
                    ))}
                  {/* The roadmap's toolbar row is its own — the window controls, the
                estimate walk and the auto-correct count are all local to it and
                cannot be handed up to the bar. So the bar hands the FILTERS
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
                object for the same reason TopBar does. */}
                  {view === 'roadmap' && (
                    <Roadmap
                      info={scopeInfo}
                      filters={roadmapFilters}
                      actions={actions}
                      filterControls={(phone) => (
                        <ViewFilters
                          info={scopeInfo}
                          filters={filters}
                          setFilters={setFilters}
                          actions={actions}
                          searchWidth={180}
                          hideSearch={phone}
                          hide={['mine', 'stale', 'focus']}
                        />
                      )}
                      focusPlan={focusPlan}
                      onFocusConsumed={() => setFocusPlan(null)}
                      revealTask={revealTask}
                      onRevealConsumed={() => setRevealTask(null)}
                    />
                  )}
                </div>
              )
            )}
          </Suspense>
        </ViewBoundary>
      </main>
      {/* the floating window — everywhere but the inbox, which embeds the same
          component in its right pane instead of stacking one over the other */}
      {!inboxOpen && openIssue && (
        <DeferredOverlay onClose={closeIssue}>
          <IssueDetail
            issueId={openIssue}
            onClose={closeIssue}
            onOpen={setOpenIssue}
            onPlanOnRoadmap={planOnRoadmap}
            unreadTs={undefined}
            onPopOut={undefined}
            onShowOnBoard={showOnBoard}
          />
        </DeferredOverlay>
      )}
      {modal && (
        <DeferredOverlay key={modal.kind} onClose={() => setModal(null)}>
          {modal.kind === 'issue' && (
            <NewIssueModal
              init={modal.init}
              onClose={() => setModal(null)}
              onCreate={createIssue}
            />
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
            />
          )}
          {modal.kind === 'milestone' && (
            <MilestoneModal init={modal.init} onClose={() => setModal(null)} />
          )}
          {modal.kind === 'createorg' && <CreateOrgModal onClose={() => setModal(null)} />}
        </DeferredOverlay>
      )}
      {paletteOpen && (
        <DeferredOverlay onClose={() => setPaletteOpen(false)}>
          <SearchPalette ctx={paletteCtx} onClose={() => setPaletteOpen(false)} />
        </DeferredOverlay>
      )}
      <ToastHost toasts={toasts} dismiss={dismissToast} />
    </WorkspaceShell>
  )
}

export default App
