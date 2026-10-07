import { useState } from 'react'
import { matchesAllWords } from '../lib/search'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import { type IssueFilters, P, type ScopeInfo } from '../store/planner'
import { Avatar, Icon, MenuItem, PausedMark, Popover, PriorityIcon, Seg, StatusDot } from './qivo'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { NativeSelect } from './ui/native-select'
import { ViewFilters } from './viewFilters'

type Actions = Record<string, (...args: unknown[]) => void>

export function MobileHeader({
  scope,
  view,
  inboxOpen,
  projectsOpen,
  syncOpen,
  actions,
}: {
  scope: string
  view: string
  inboxOpen: boolean
  projectsOpen: boolean
  syncOpen: boolean
  actions: Actions
}) {
  const info = P.scopeInfo(scope)
  // Team sync is always about the home organization
  const project = syncOpen ? undefined : P.project(scope)
  const organization = P.orgs.find((org) => org.id === project?.org)?.name || P.org.name
  const title = inboxOpen
    ? 'Inbox'
    : projectsOpen
      ? 'Projects'
      : syncOpen
        ? 'Team sync'
        : info?.mine
          ? 'My tasks'
          : info?.name || 'Projects'
  const canCreate = info?.subIds.some((id) => P.canWrite(id))
  return (
    <header className="mobile-workspace-header">
      <div className="mobile-title-row">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-text-2">{organization}</p>
          <h1 className="mobile-page-title">{title}</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search tasks and projects"
          onClick={actions.openPalette}
        >
          <Icon name="search" size={20} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-mobile-settings
          aria-label="Open settings"
          onClick={() => actions.openSettings('menu')}
        >
          <Avatar id={P.CURRENT_USER} size={28} />
        </Button>
      </div>
      {!inboxOpen && !projectsOpen && !syncOpen && info && (
        <>
          <div className="mobile-view-switch" data-view-switch>
            <Seg
              fit
              value={view}
              onChange={actions.setView}
              options={[
                { value: 'kanban', label: 'Tasks', icon: 'board' },
                { value: 'overview', label: 'Overview', icon: 'chart' },
                { value: 'roadmap', label: 'Roadmap', icon: 'timeline' },
              ]}
            />
          </div>
          {(project || view !== 'kanban') && (
            <div className="mobile-context-actions">
              {project ? (
                <Popover
                  align="left"
                  width={260}
                  button={(toggle) => (
                    <Button variant="ghost" onClick={toggle} aria-label="Project actions">
                      <Icon name="more" size={16} /> Project
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem
                        onClick={() => {
                          close()
                          actions.openSettings(`project:${project.id}`)
                        }}
                      >
                        <Icon name="people" size={16} /> People & settings
                      </MenuItem>
                      {project.type === 'meta' && P.levelOn(project.id) === 'lead' && (
                        <MenuItem
                          onClick={() => {
                            close()
                            actions.newProject({ parent: project.id })
                          }}
                        >
                          <Icon name="plus" size={16} /> New sub-project
                        </MenuItem>
                      )}
                      <MenuItem
                        onClick={() => {
                          close()
                          actions.openArchive(project.id)
                        }}
                      >
                        <Icon name="inbox" size={16} /> Archived tasks
                      </MenuItem>
                      {project.parent && (
                        <MenuItem
                          onClick={() => {
                            close()
                            actions.setScope(project.parent)
                          }}
                        >
                          <Icon name="chevronLeft" size={16} /> {P.project(project.parent)?.name}
                        </MenuItem>
                      )}
                    </>
                  )}
                </Popover>
              ) : (
                <span className="text-xs text-text-2">
                  {info.mine ? 'Assigned to you' : 'Across your projects'}
                </span>
              )}
              {canCreate && (
                <Button onClick={() => actions.newIssue({})}>
                  <Icon name="plus" size={16} /> New task
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </header>
  )
}

/* The phone's bottom tabs. Team sync is the fourth, for a login with a
   home organization (the page is always about it); a page that owns the
   screen lights its own tab, and Projects lights for every scope view. */
export function MobileNavigation({
  scope,
  inboxOpen,
  projectsOpen,
  syncOpen,
  actions,
}: {
  scope: string
  inboxOpen: boolean
  projectsOpen: boolean
  syncOpen: boolean
  actions: Actions
}) {
  const mine = !inboxOpen && !projectsOpen && !syncOpen && P.isMineScope(scope)
  const projects = !inboxOpen && !syncOpen && !mine
  return (
    <nav className="mobile-bottom-navigation" aria-label="Main navigation">
      {[
        {
          label: 'Inbox',
          icon: 'mail',
          active: inboxOpen,
          action: actions.openInbox,
          count: P.unreadMessages,
          hook: 'data-inbox-nav',
        },
        {
          label: 'My tasks',
          icon: 'user',
          active: mine,
          action: actions.openMine,
          count: 0,
          hook: 'data-mine-nav',
        },
        {
          label: 'Projects',
          icon: 'layers',
          active: projects,
          action: actions.openProjects,
          count: 0,
          hook: 'data-projects-nav',
        },
        ...(P.homeOrg
          ? [
              {
                label: 'Sync',
                icon: 'people',
                active: syncOpen,
                action: actions.openSync,
                count: 0,
                hook: 'data-sync-nav',
              },
            ]
          : []),
      ].map((item) => (
        <Button
          key={item.label}
          variant="ghost"
          className="mobile-nav-item"
          data-on={item.active ? '' : undefined}
          aria-current={item.active ? 'page' : undefined}
          onClick={item.action}
          {...{ [item.hook]: true }}
        >
          <span className="relative inline-flex">
            <Icon name={item.icon} size={20} />
            {item.count > 0 && (
              <span className="mobile-unread-badge" role="img" aria-label={`${item.count} unread`}>
                {item.count > 99 ? '99+' : item.count}
              </span>
            )}
          </span>
          <span>{item.label}</span>
        </Button>
      ))}
    </nav>
  )
}

/** The directory preserves project and sub-project actions without a tiny rail. */
export function ProjectDirectory({ actions }: { actions: Actions }) {
  const mobile = useMobile()
  const [search, setSearch] = useState('')
  const query = mobile ? '' : search
  const projects = P.visibleProjects().filter((project) =>
    matchesAllWords(
      `${project.name} ${P.orgs.find((org) => org.id === project.org)?.name || ''}`,
      query,
    ),
  )
  return (
    <div className="mobile-project-directory">
      {!mobile && (
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find a project…"
          className="bg-surface-1"
          aria-label="Find a project"
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button data-all-nav onClick={actions.openAll}>
          <Icon name="layers" size={16} /> All projects
        </Button>
        {P.canCreateProject() && (
          <Button onClick={() => actions.newProject({ kind: 'program' })}>
            <Icon name="plus" size={16} /> New project
          </Button>
        )}
      </div>
      {projects.map((project) => {
        const visibleChildren = project.children
          .map((id) => P.project(id))
          .filter((sub) => !!sub && P.canSee(sub.id))
        return (
          <section key={project.id} className="mobile-project-card">
            <div className="mobile-project-row">
              <Button
                variant="unstyled"
                className="mobile-project-open"
                onClick={() => actions.openProject(project.id)}
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block break-words font-semibold">{project.name}</span>
                  <span className="block text-xs text-text-2">
                    {P.orgs.find((org) => org.id === project.org)?.name}, {visibleChildren.length}{' '}
                    sub-projects
                  </span>
                </span>
                <Icon name="chevronRight" size={16} />
              </Button>
            </div>
            <div className="mobile-project-actions">
              <Button variant="ghost" onClick={() => actions.openSettings(`project:${project.id}`)}>
                <Icon name="people" size={16} /> People & settings
              </Button>
              <Popover
                width={230}
                align="right"
                button={(toggle) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${project.name} actions`}
                    onClick={toggle}
                  >
                    <Icon name="more" size={16} />
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    {P.levelOn(project.id) === 'lead' && (
                      <MenuItem
                        onClick={() => {
                          close()
                          actions.newProject({ parent: project.id })
                        }}
                      >
                        <Icon name="plus" size={16} /> New sub-project
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        close()
                        actions.openArchive(project.id)
                      }}
                    >
                      <Icon name="inbox" size={16} /> Archived tasks
                    </MenuItem>
                  </>
                )}
              </Popover>
            </div>
            {!!visibleChildren.length && (
              <details className="mobile-subprojects">
                <summary>
                  Sub-projects <Icon name="chevronDown" size={16} />
                </summary>
                {visibleChildren.map((sub) => (
                  <Button
                    key={sub.id}
                    variant="ghost"
                    className="mobile-subproject-row"
                    onClick={() => actions.openProject(sub.id)}
                  >
                    <span className="min-w-0 flex-1 whitespace-normal text-left">{sub.name}</span>
                    <Icon name="chevronRight" size={16} />
                  </Button>
                ))}
              </details>
            )}
          </section>
        )
      })}
      {!projects.length && (
        <p className="p-5 text-text-2">
          {query ? 'No projects match your search.' : 'Projects you join will appear here.'}
        </p>
      )}
      {!P.homeOrg && (
        <Button onClick={actions.createOrg}>
          <Icon name="plus" size={16} /> Create your organization
        </Button>
      )}
    </div>
  )
}

export function MobileTaskList({
  info,
  filters,
  setFilters,
  actions,
}: {
  info: ScopeInfo
  filters: IssueFilters
  setFilters: React.Dispatch<React.SetStateAction<IssueFilters>>
  actions: Actions
}) {
  const [status, setStatus] = useState('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const closeFilters = useMobileBackLayer(filterOpen, () => setFilterOpen(false))
  const effective = {
    ...filters,
    search: '',
    ...(info.mine ? { mine: true, assignees: [] } : {}),
  }
  const activeFilters =
    Number(!!filters.priority) +
    Number(filters.stale) +
    Number(filters.focus) +
    (info.mine ? 0 : Number(filters.mine || filters.assignees.length > 0))
  const tasks = P.scopedIssues(info).filter((task) => P.passesFilters(task, effective))
  const statusOrder = info.mine
    ? ['progress', 'review', 'todo', 'backlog', 'done']
    : P.STATUSES.map((item) => item.id)
  const statuses = [...P.STATUSES]
    .sort((a, b) => statusOrder.indexOf(a.id) - statusOrder.indexOf(b.id))
    .filter((item) => !filters.focus || !['backlog', 'done'].includes(item.id))
  const selectedStatus = statuses.some((item) => item.id === status) ? status : 'all'
  const groups = statuses
    .filter((item) => selectedStatus === 'all' || item.id === selectedStatus)
    .map((item) => ({
      ...item,
      tasks: tasks
        .filter((task) => task.status === item.id)
        .sort(
          (a, b) =>
            (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title),
        ),
    }))
  const count = groups.reduce((sum, group) => sum + group.tasks.length, 0)
  return (
    <div className="mobile-task-list">
      <div className="mobile-task-tools">
        <NativeSelect
          value={selectedStatus}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Task status"
          className="min-w-0 flex-1"
        >
          <option value="all">All statuses</option>
          {statuses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
        <Button onClick={() => setFilterOpen(true)} data-on={activeFilters ? '' : undefined}>
          <Icon name="filter" size={16} /> Filters{activeFilters > 0 ? `, ${activeFilters}` : ''}
        </Button>
        {info.wide && info.subIds.some((id) => P.canWrite(id)) && (
          <Button
            size="icon"
            aria-label="New task"
            title="New task"
            onClick={() => actions.newIssue({})}
          >
            <Icon name="plus" size={16} />
          </Button>
        )}
      </div>
      <Dialog
        open={filterOpen}
        onOpenChange={(open) => (open ? setFilterOpen(true) : closeFilters())}
      >
        <DialogContent
          className="mobile-filter-page"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={closeFilters}>
              <Icon name="chevronLeft" size={16} /> Back
            </Button>
            <DialogTitle>Task filters</DialogTitle>
          </div>
          <div className="mobile-filter-controls">
            <ViewFilters
              info={info}
              filters={filters}
              setFilters={setFilters}
              hideSearch
              ground="page"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={actions.clearFilters}>Clear filters</Button>
            <Button variant="primary" onClick={closeFilters}>
              Show tasks
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {groups
        .filter((group) => group.tasks.length)
        .map((group) => (
          <section key={group.id} className="mobile-task-section">
            <h2>
              <StatusDot status={group.id} /> {group.name}
              <span className="text-xs text-text-2">{group.tasks.length}</span>
            </h2>
            <div className="mobile-task-group">
              {group.tasks.map((task) => {
                const sub = P.project(task.project)
                const project = P.metaOf(task.project)
                const overdue = !!task.due && task.due < P.TODAY_ISO && !P.isDone(task)
                return (
                  <Button
                    key={task.id}
                    variant="unstyled"
                    data-card={task.id}
                    className="mobile-task-row"
                    onClick={() => actions.openIssue(task.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="mobile-task-title">
                        {task.paused && <PausedMark size={14} />}
                        {task.title}
                      </span>
                      <span className="mobile-task-meta">
                        <span>
                          {project?.name}
                          {sub && `, ${sub.name}`}
                        </span>
                      </span>
                      <span className="mobile-task-meta">
                        <PriorityIcon priority={task.priority} size={13} />
                        <span>{P.PRIORITIES[task.priority]?.name}</span>
                        {P.isGroup(task) && <span>Parent task</span>}
                        {task.due && (
                          <span className={overdue ? 'text-danger' : ''}>
                            {overdue ? 'Overdue, ' : 'Due '}
                            {P.fmtISO(task.due)}
                          </span>
                        )}
                      </span>
                    </span>
                    <Avatar id={task.owner} size={28} />
                    <Icon name="chevronRight" size={16} />
                  </Button>
                )
              })}
            </div>
          </section>
        ))}
      {count === 0 && (
        <div className="mobile-task-empty">
          <Icon name="board" size={24} />
          <h2>No tasks here</h2>
          <p>
            {activeFilters || selectedStatus !== 'all'
              ? 'Try another status or adjust your filters.'
              : info.mine
                ? 'Tasks assigned to you will appear here.'
                : 'Create a task to get started.'}
          </p>
          {(activeFilters > 0 || selectedStatus !== 'all') && (
            <Button
              onClick={() => {
                actions.clearFilters()
                setFilters((current) => ({ ...current, focus: false }))
                P.saveUI({ focus: false })
                setStatus('all')
              }}
            >
              Show all tasks
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
