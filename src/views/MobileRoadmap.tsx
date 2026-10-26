import { memo, useLayoutEffect, useRef, useState } from 'react'
import { DeferredList } from '@/components/DeferredList'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Avatar, Icon, StatusDot } from '../components/qivo'
import { SYNC_LIMIT } from '../lib/boardGroups'
import { focusAround } from '../lib/focusWhenGone'
import { StaticControlsContext, useLiveControls } from '../lib/liveControls'
import { createMountScheduler, useMountGuards } from '../lib/mountScheduler'
import { isRoadmapTaskVisible } from '../lib/roadmapVisibility'
import { useLatest } from '../lib/useLatest'
import {
  type IssueFilters,
  type IssueVM,
  type MilestoneVM,
  P,
  type ScopeInfo,
} from '../store/planner'
import type { StoreVersion } from '../store/updates'

type MobileRoadmapProps = {
  info: ScopeInfo
  windowStart: number
  windowEnd: number
  filters: IssueFilters
  filterControls: React.ReactNode
  actions: Record<string, (...args: unknown[]) => void>
  onTimeline: () => void
  onUpdateEstimate: () => void
  onAutoCorrect: () => void
  corrections: number
  undoControls: React.ReactNode
  section: 'milestones' | 'tasks'
  onSectionChange: (section: 'milestones' | 'tasks') => void
  taskState: 'all' | 'planned' | 'unplanned'
  onTaskStateChange: (state: 'all' | 'planned' | 'unplanned') => void
  /** The note of a scope with nothing to schedule (Roadmap's emptyNote). */
  empty?: React.ReactNode
}

/* A task row's height before it renders (a two-line title), and the least
   it takes, for the rows a first screen holds. */
const ROW_ESTIMATE_PX = 96
const ROW_MIN_PX = 72
const taskKey = (task: IssueVM) => task.id
const rowEstimate = () => ROW_ESTIMATE_PX
const pendingRows = (n: number) => `Loading ${n} more ${n === 1 ? 'task' : 'tasks'}`

/** One task of the phone's task schedule. It renders again only when its
    task object, the store's context (P.contextVersion) or `wide` changes,
    and mounts no tooltip roots until a mouse points at it or keyboard
    focus reaches it, so touch phones never mount them. */
const MobileRoadmapRow = memo(function MobileRoadmapRow({
  task: it,
  wide,
  onOpen,
}: {
  task: IssueVM
  wide: boolean
  context: StoreVersion
  onOpen: (id: string) => void
}) {
  const root = useRef<HTMLButtonElement>(null)
  const controls = useLiveControls(root)
  const project = P.project(it.project)
  const meta = P.metaOf(it.project)
  const context =
    wide && meta && meta.id !== project?.id
      ? `${P.projectLabel(meta)}, ${project ? P.projectLabel(project) : ''}`
      : project && P.projectLabel(project)
  return (
    <Button
      ref={root}
      {...controls.rootProps}
      type="button"
      variant="unstyled"
      noTooltip
      data-roadmap-row={it.id}
      data-focus-key="row"
      className="mobile-roadmap-row"
      onClick={() => onOpen(it.id)}
    >
      <StaticControlsContext.Provider value={controls.value}>
        {/* a group's own status is dormant */}
        {!P.isGroup(it) && <StatusDot status={it.status} size={16} />}
        <span className="mobile-roadmap-row-body">
          <strong>{it.title}</strong>
          <span>{context}</span>
          <span>
            {it.start == null
              ? 'Unplanned'
              : `${P.fmtDate(P.weekToDate(it.start))} → ${P.fmtDate(P.weekToDate(it.end))}`}
            {it.due ? `, Due ${P.fmtISO(it.due)}` : ''}
          </span>
        </span>
        {it.owner ? <Avatar id={it.owner} size={28} /> : <Icon name="chevronRight" size={16} />}
      </StaticControlsContext.Provider>
    </Button>
  )
})

/** The phone entry to the same roadmap. Dates, editing and access rules still
 * come from the planner; the timeline remains available for spatial planning.
 * With `empty`, the agenda keeps what the desktop's empty roadmap keeps in its
 * toolbar (Undo, the planning tools and New milestone) and shows the note in
 * place of the timeline button, the section switch and the task schedule. The
 * scope's milestones stay listed under the note, as the desktop keeps their
 * flags. */
export function MobileRoadmap({
  info,
  windowStart,
  windowEnd,
  filters,
  filterControls,
  actions,
  onTimeline,
  onUpdateEstimate,
  onAutoCorrect,
  corrections,
  undoControls,
  section,
  onSectionChange,
  taskState,
  onTaskStateChange,
  empty,
}: MobileRoadmapProps) {
  const milestones = info.milestones.slice().sort((a, b) => a.week - b.week)
  const upcoming = milestones.filter((m) => m.week >= P.TODAY_WEEK)
  const past = milestones.filter((m) => m.week < P.TODAY_WEEK)
  const tasks = P.scopedIssues(info)
    .filter((it) => isRoadmapTaskVisible(it, P.isDone(it), windowStart, windowEnd))
    .filter((it) => P.passesFilters(it, filters))
    .filter(
      (it) =>
        taskState === 'all' || (taskState === 'planned' ? it.start != null : it.start == null),
    )
    .sort(
      (a, b) =>
        (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title),
    )

  /* A schedule of more than SYNC_LIMIT tasks mounts the rows of its first
     screen at once and the rest in slices, as the phone's task list does.
     The count comes from the first render of a scope, section and choice. */
  const scroller = useRef<HTMLDivElement>(null)
  const [scheduler] = useState(createMountScheduler)
  useMountGuards(scheduler)
  useLayoutEffect(() => scheduler.setRoot(scroller.current), [scheduler])
  const eagerKey = `${info.id}:${section}:${taskState}`
  const firstScreen = () => Math.ceil((window.innerHeight + 500) / ROW_MIN_PX)
  const [eager, setEager] = useState(() => ({ key: eagerKey, rows: firstScreen() }))
  if (eager.key !== eagerKey) setEager({ key: eagerKey, rows: firstScreen() })
  const initial =
    tasks.length <= SYNC_LIMIT ? Number.POSITIVE_INFINITY : eager.key === eagerKey ? eager.rows : 0
  // App makes its actions again every render; the rows keep one identity
  const openIssue = useLatest((id: string) => actions.openIssue(id))
  const renderRow = (it: IssueVM) => (
    <MobileRoadmapRow
      key={it.id}
      task={it}
      wide={info.wide}
      context={P.contextVersion}
      onOpen={openIssue}
    />
  )

  const milestoneRow = (m: MilestoneVM) => (
    <Button
      key={m.id}
      type="button"
      variant="unstyled"
      className="mobile-roadmap-row"
      data-agenda-milestone={m.id}
      onClick={() =>
        // the window can delete this milestone, and its row with it. Focus
        // then goes to the next row, the previous one, New milestone or the
        // empty list's line. A row in the closed past list is out of reach
        actions.editMilestone(
          m.id,
          focusAround(
            'data-agenda-milestone',
            m.id,
            (row) => (row.closest('details:not([open])') ? null : row),
            () =>
              scroller.current?.querySelector<HTMLElement>('[data-new-milestone]') ??
              scroller.current?.querySelector<HTMLElement>('[data-no-milestones]'),
          ),
        )
      }
      aria-label={`${P.canWrite(m.project) ? 'Edit' : 'View'} milestone ${m.name}`}
    >
      <Icon name="diamond" size={16} color={P.MILESTONE_COLOR} />
      <span className="mobile-roadmap-row-body">
        <strong>{m.name}</strong>
        <span>{P.projectLabelOf(m.project)}</span>
        <span>
          {P.fmtDate(P.weekToDate(m.week))}, {P.weekNumLabel(m.week)}
        </span>
      </span>
      <Icon name="chevronRight" size={16} />
    </Button>
  )

  const planningTools = (
    <details className="mobile-roadmap-tools">
      <summary>
        <Icon name="cog" size={16} /> Planning tools
      </summary>
      <div className="mobile-roadmap-tool-actions">
        <Button type="button" onClick={onUpdateEstimate}>
          <Icon name="clockFading" size={16} />
          Estimates
        </Button>
        <Button type="button" onClick={onAutoCorrect} disabled={corrections === 0}>
          <Icon name="arrowRightFromLine" size={16} />
          Auto-move{corrections > 0 ? ` (${corrections})` : ''}
        </Button>
      </div>
      <p>Auto-move pushes planned tasks after their blockers.</p>
    </details>
  )
  const canAddMilestone = !info.wide && P.canAddMilestone(info.id)
  const milestoneSection = (
    <section className="mobile-roadmap-section">
      <div className="mobile-roadmap-section-heading">
        <h2>Upcoming milestones</h2>
        {canAddMilestone && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="New milestone"
            data-new-milestone
            onClick={() => actions.newMilestone({})}
          >
            <Icon name="plus" size={16} />
          </Button>
        )}
      </div>
      {upcoming.length ? (
        upcoming.map(milestoneRow)
      ) : (
        <p data-no-milestones tabIndex={-1} className="mobile-roadmap-note">
          No upcoming milestones.
        </p>
      )}
      {past.length > 0 && (
        <details className="mobile-roadmap-past">
          <summary>Past milestones ({past.length})</summary>
          {past.slice().reverse().map(milestoneRow)}
        </details>
      )}
      {info.wide && (
        <p className="mobile-roadmap-note">Open a project to add a milestone to its roadmap.</p>
      )}
    </section>
  )
  if (empty)
    return (
      <div ref={scroller} data-scroll data-screen-label="Roadmap" className="mobile-roadmap-agenda">
        {undoControls}
        {planningTools}
        {empty}
        {milestones.length > 0
          ? milestoneSection
          : canAddMilestone && (
              <Button type="button" data-new-milestone onClick={() => actions.newMilestone({})}>
                <Icon name="diamond" size={16} />
                New milestone
              </Button>
            )}
      </div>
    )

  return (
    <div ref={scroller} data-scroll data-screen-label="Roadmap" className="mobile-roadmap-agenda">
      <div className="mobile-roadmap-open-timeline">
        <Button type="button" onClick={onTimeline}>
          <Icon name="timeline" size={16} />
          Timeline &amp; team
          <Icon name="chevronRight" size={16} />
        </Button>
      </div>

      {undoControls}

      <fieldset className="mobile-roadmap-sections" aria-label="Roadmap content">
        <Button
          type="button"
          variant="quiet"
          data-on={section === 'milestones' ? '' : undefined}
          aria-pressed={section === 'milestones'}
          onClick={() => onSectionChange('milestones')}
        >
          Milestones
        </Button>
        <Button
          type="button"
          variant="quiet"
          data-on={section === 'tasks' ? '' : undefined}
          aria-pressed={section === 'tasks'}
          onClick={() => onSectionChange('tasks')}
        >
          Task schedule
        </Button>
      </fieldset>

      {planningTools}

      {section === 'milestones' ? (
        milestoneSection
      ) : (
        <section className="mobile-roadmap-section">
          <h2>Task schedule</h2>
          <p className="mobile-roadmap-note">
            Open a task to edit its dates, remaining time or linked tasks.
          </p>
          <details className="mobile-roadmap-tools">
            <summary>
              <Icon name="filter" size={16} /> Filters
            </summary>
            <div className="mobile-roadmap-filter-controls">{filterControls}</div>
          </details>
          <div className="mobile-roadmap-task-filter">
            <label htmlFor="mobile-roadmap-task-state">Show</label>
            <NativeSelect
              id="mobile-roadmap-task-state"
              className="shadow-none"
              value={taskState}
              onChange={(e) => onTaskStateChange(e.target.value as typeof taskState)}
            >
              <option value="all">All tasks</option>
              <option value="planned">Planned</option>
              <option value="unplanned">Unplanned</option>
            </NativeSelect>
            <span>{tasks.length}</span>
          </div>
          <div className="mobile-roadmap-task-list">
            <DeferredList
              id="phone-roadmap"
              items={tasks}
              keyOf={taskKey}
              render={renderRow}
              estimate={rowEstimate}
              gap={0}
              initial={initial}
              scheduler={scheduler}
              label={pendingRows}
            />
          </div>
          {tasks.length === 0 && (
            <p className="mobile-roadmap-note">No tasks match these filters.</p>
          )}
          {!info.wide && P.canWrite(info.id) && info.subIds.length > 0 && (
            <Button type="button" onClick={() => actions.newIssue({ project: info.subIds[0] })}>
              <Icon name="plus" size={16} />
              New task
            </Button>
          )}
          {!info.wide && P.levelOn(info.id) === 'lead' && info.subIds.length === 0 && (
            <Button type="button" onClick={() => actions.newProject({ parent: info.id })}>
              <Icon name="plus" size={16} />
              New sub-project
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
