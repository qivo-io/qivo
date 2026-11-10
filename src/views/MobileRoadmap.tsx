import { memo, useId, useLayoutEffect, useRef, useState } from 'react'
import { DeferredList } from '@/components/DeferredList'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { MilestoneSectionPart } from '../components/MilestoneSectionPart'
import { Avatar, Icon, StatusDot } from '../components/qivo'
import { SYNC_LIMIT } from '../lib/boardGroups'
import { focusAround } from '../lib/focusWhenGone'
import { StaticControlsContext, useLiveControls } from '../lib/liveControls'
import { createMountScheduler, useMountGuards } from '../lib/mountScheduler'
import { autoMoveTitle } from '../lib/schedule'
import { useLatest } from '../lib/useLatest'
import { type IssueVM, type MilestoneVM, P, type ScopeInfo } from '../store/planner'
import type { StoreVersion } from '../store/updates'
import { MINE_MILESTONES_HINT, MINE_TOO_MANY } from './overview/OverviewMilestones'
import type { ScopeMilestones } from './useScopeMilestones'

type MobileRoadmapProps = {
  info: ScopeInfo
  /** the scope's sub-projects as the Roadmap's answer names them
      (useRoadmapView selection), for the agenda's New task and New
      sub-project; null in My view and before an answer */
  selection?: readonly string[] | null
  /** the tasks the Roadmap shows (views/roadmap/useRoadmapView.ts), in its
      answer's order, checked on screen against the window and the filters */
  tasks: readonly IssueVM[]
  /** whether `tasks` are a current answer's, so an empty list may say that
      nothing matches */
  settled?: boolean
  filterControls: React.ReactNode
  actions: Record<string, (...args: unknown[]) => void>
  onTimeline: () => void
  onAutoCorrect: () => void
  corrections: number
  /** Auto-move's tooltip where its inputs are not there or a write is on
      its way, in place of the one for no moves */
  correctionsTitle?: string
  undoControls: React.ReactNode
  section: 'milestones' | 'tasks'
  onSectionChange: (section: 'milestones' | 'tasks') => void
  taskState: 'all' | 'planned' | 'unplanned'
  onTaskStateChange: (state: 'all' | 'planned' | 'unplanned') => void
  /** The note in place of the task schedule (Roadmap's emptyNote): a scope
      with nothing to schedule, or the Roadmap's answer's note
      (roadmap/RoadmapNote.tsx). */
  empty?: React.ReactNode
  /** The scope's milestone sections (views/useScopeMilestones.ts), which
      the Roadmap reads, so they outlive this agenda's remounts after the
      landscape timeline, a planning session or a reveal. */
  milestones: ScopeMilestones
}

/* The verb of an agenda milestone row's label: Edit where the caller
   writes in its top-level project, View for a known level without Edit,
   and Open while the project cache loads it, failed or did not check it,
   where the Milestones window decides from its own read. */
function milestoneVerb(projectId: string): 'Edit' | 'View' | 'Open' {
  if (P.canWrite(projectId)) return 'Edit'
  const state = P.projectState(projectId)
  return state === 'ok' || state === 'gone' ? 'View' : 'Open'
}

/* A task row's height before it renders (a two-line title), and the least
   it takes, for the rows a first screen holds. */
const ROW_ESTIMATE_PX = 96
const ROW_MIN_PX = 72
const taskKey = (task: IssueVM) => task.id
const rowEstimate = () => ROW_ESTIMATE_PX
const pendingRows = (n: number) => `Loading ${n} more ${n === 1 ? 'task' : 'tasks'}`

/** One task of the phone's task schedule. It renders again only when its
    task object, the store's context (P.contextVersion) or `mine` (My view)
    changes, and mounts no tooltip roots until a mouse points at it or
    keyboard focus reaches it, so touch phones never mount them. */
const MobileRoadmapRow = memo(function MobileRoadmapRow({
  task: it,
  mine,
  onOpen,
}: {
  task: IssueVM
  mine: boolean
  context: StoreVersion
  onOpen: (id: string) => void
}) {
  const root = useRef<HTMLButtonElement>(null)
  const controls = useLiveControls(root)
  const project = P.project(it.project)
  const meta = P.metaOf(it.project)
  const context =
    mine && meta && meta.id !== project?.id
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

/** The phone entry to the same roadmap. Its tasks are the Roadmap's, from the
 * server's answer for the selection, the window and the filters, which it
 * sorts and narrows only to planned or unplanned. Dates, editing and access
 * rules still come from the planner; the timeline remains available for
 * spatial planning.
 * A toolbar row under Timeline & team holds Undo and Auto-move.
 * Its Milestones section lists the scope's milestones as the Overview does,
 * from the server: Upcoming 10 at a time and a collapsed Past, the
 * Overview's sections on slots of the Roadmap page's own
 * (views/useScopeMilestones.ts). My view lists those of the projects that
 * hold the person's own work.
 * With `empty`, the agenda keeps what the desktop's empty roadmap keeps in its
 * toolbar (Undo, Auto-move and New milestone) and shows the note in
 * place of the timeline button, the section switch and the task schedule. The
 * scope's milestones stay listed under the note where the scope holds some
 * or Qivo cannot tell (ScopeMilestones `stands`), as the desktop keeps their
 * flags. */
export function MobileRoadmap({
  info,
  selection = null,
  tasks: shown,
  settled = true,
  filterControls,
  actions,
  onTimeline,
  onAutoCorrect,
  corrections,
  correctionsTitle,
  undoControls,
  section,
  onSectionChange,
  taskState,
  onTaskStateChange,
  empty,
  milestones: ms,
}: MobileRoadmapProps) {
  const pastBodyId = useId()
  const tasks = shown
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
  // App makes its actions again every render; the rows keep one identity. A
  // task only the Roadmap's answer brings opens by a reference the window
  // reads from the server (P.openTarget)
  const openIssue = useLatest((id: string) => actions.openIssue(P.openTarget(id)))
  const renderRow = (it: IssueVM) => (
    <MobileRoadmapRow
      key={it.id}
      task={it}
      mine={info.mine}
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
        // then goes to the next row, the previous one, New milestone or
        // Upcoming's empty line. A collapsed Past shows no row
        actions.editMilestone(
          m.id,
          focusAround(
            'data-agenda-milestone',
            m.id,
            (row) => row,
            () =>
              scroller.current?.querySelector<HTMLElement>('[data-new-milestone]') ??
              scroller.current?.querySelector<HTMLElement>(
                '[data-agenda-milestones] [data-milestone-section="upcoming"] [data-milestone-note="empty"]',
              ),
          ),
          m.project,
        )
      }
      aria-label={`${milestoneVerb(m.project)} milestone ${m.name}`}
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

  // Auto-move is disabled while no task starts before its blocker ends
  const toolbar = (
    <div className="mobile-roadmap-toolbar">
      {undoControls}
      <Button
        type="button"
        onClick={onAutoCorrect}
        disabled={corrections === 0}
        title={correctionsTitle ?? autoMoveTitle(corrections)}
      >
        <Icon name="arrowRightFromLine" size={16} />
        Auto-move{corrections > 0 ? ` (${corrections})` : ''}
      </Button>
    </div>
  )
  const canAddMilestone = !info.mine && P.canAddMilestone(info.id)
  const hint = info.mine ? MINE_MILESTONES_HINT : undefined
  const tooMany = info.mine ? MINE_TOO_MANY : undefined
  const milestoneSection = ms.base && (
    <section className="mobile-roadmap-section" data-agenda-milestones>
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
      <MilestoneSectionPart
        side="upcoming"
        section={ms.upcoming}
        open
        searchable={false}
        pastKnown={ms.upcoming.view.past === false}
        header={null}
        scroller="[data-scroll]"
        rowMark="data-agenda-milestone"
        rowsClassName="gap-0"
        sentences={{
          noneYet: info.mine
            ? 'No milestones in any of your projects yet.'
            : canAddMilestone
              ? 'No milestones yet. Add one with the + button.'
              : 'No milestones yet.',
          tooMany,
        }}
        hint={hint}
      >
        {ms.upcoming.view.rows.map(milestoneRow)}
      </MilestoneSectionPart>
      {ms.showPast && (
        <MilestoneSectionPart
          side="past"
          section={ms.past}
          open={ms.pastOpen}
          searchable={ms.pastSearchable}
          bodyId={pastBodyId}
          scroller="[data-scroll]"
          rowMark="data-agenda-milestone"
          rowsClassName="gap-0"
          sentences={{ tooMany }}
          hint={hint}
          className="mt-2"
          header={
            <Button
              type="button"
              variant="ghost"
              data-milestone-past-toggle
              aria-expanded={ms.pastOpen}
              aria-controls={pastBodyId}
              onClick={() => ms.setPastOpen(!ms.pastOpen)}
              className="-ml-2 gap-1.5 self-start px-2 text-sm font-medium text-text-2"
            >
              <Icon
                name={ms.pastOpen ? 'chevronDown' : 'chevronRight'}
                size={16}
                color="var(--text-2)"
              />
              Past milestones
            </Button>
          }
        >
          {ms.pastOpen ? ms.past.view.rows.map(milestoneRow) : []}
        </MilestoneSectionPart>
      )}
      {info.mine && (
        <p className="mobile-roadmap-note">Open a project to add a milestone to its roadmap.</p>
      )}
    </section>
  )
  if (empty)
    return (
      <div ref={scroller} data-scroll data-screen-label="Roadmap" className="mobile-roadmap-agenda">
        {toolbar}
        {empty}
        {ms.stands
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

      {toolbar}

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
          {tasks.length === 0 && settled && (
            <p className="mobile-roadmap-note">No tasks match these filters.</p>
          )}
          {!info.mine && P.canWrite(info.id) && !!selection && selection.length > 0 && (
            <Button type="button" onClick={() => actions.newIssue({ project: selection[0] })}>
              <Icon name="plus" size={16} />
              New task
            </Button>
          )}
          {!info.mine &&
            P.canManageOwnProjectAccess(info.id) &&
            !!selection &&
            selection.length === 0 && (
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
