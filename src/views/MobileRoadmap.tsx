import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Avatar, Icon, StatusDot } from '../components/qivo'
import { isRoadmapTaskVisible } from '../lib/roadmapVisibility'
import { type IssueFilters, type MilestoneVM, P, type ScopeInfo } from '../store/planner'

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
}

/** The phone entry to the same roadmap. Dates, editing and access rules still
 * come from the planner; the timeline remains available for spatial planning. */
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
}: MobileRoadmapProps) {
  const milestones = info.milestones.slice().sort((a, b) => a.week - b.week)
  const upcoming = milestones.filter((m) => m.week >= P.TODAY_WEEK)
  const past = milestones.filter((m) => m.week < P.TODAY_WEEK)
  const tasks = P.scopedIssues(info)
    .filter((it) => isRoadmapTaskVisible(it, windowStart, windowEnd))
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

  const milestoneRow = (m: MilestoneVM) => (
    <Button
      key={m.id}
      type="button"
      variant="unstyled"
      className="mobile-roadmap-row"
      onClick={() => actions.editMilestone(m.id)}
      aria-label={`${P.canWrite(m.project) ? 'Edit' : 'View'} milestone ${m.name}`}
    >
      <Icon name="diamond" size={16} color={P.MILESTONE_COLOR} />
      <span className="mobile-roadmap-row-body">
        <strong>{m.name}</strong>
        <span>{P.project(m.project)?.name}</span>
        <span>
          {P.fmtDate(P.weekToDate(m.week))}, {P.weekNumLabel(m.week)}
        </span>
      </span>
      <Icon name="chevronRight" size={16} />
    </Button>
  )

  return (
    <div data-scroll data-screen-label="Roadmap" className="mobile-roadmap-agenda">
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

      {section === 'milestones' ? (
        <section className="mobile-roadmap-section">
          <div className="mobile-roadmap-section-heading">
            <h2>Upcoming milestones</h2>
            {!info.wide && P.canWrite(info.id) && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="New milestone"
                onClick={() => actions.newMilestone({})}
              >
                <Icon name="plus" size={16} />
              </Button>
            )}
          </div>
          {upcoming.length ? (
            upcoming.map(milestoneRow)
          ) : (
            <p className="mobile-roadmap-note">No upcoming milestones.</p>
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
          {tasks.map((it) => {
            const project = P.project(it.project)
            const meta = P.metaOf(it.project)
            const context =
              info.wide && meta && meta.id !== project?.id
                ? `${meta.name}, ${project?.name || ''}`
                : project?.name
            return (
              <Button
                key={it.id}
                type="button"
                variant="unstyled"
                className="mobile-roadmap-row"
                onClick={() => actions.openIssue(it.id)}
              >
                <StatusDot status={it.status} size={16} />
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
                {it.owner ? (
                  <Avatar id={it.owner} size={28} />
                ) : (
                  <Icon name="chevronRight" size={16} />
                )}
              </Button>
            )
          })}
          {tasks.length === 0 && (
            <p className="mobile-roadmap-note">No tasks match these filters.</p>
          )}
          {!info.wide && P.canWrite(info.id) && info.subIds.length > 0 && (
            <Button type="button" onClick={() => actions.newIssue({ project: info.subIds[0] })}>
              <Icon name="plus" size={16} />
              New task
            </Button>
          )}
          {!info.wide && P.canWrite(info.id) && info.subIds.length === 0 && (
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
