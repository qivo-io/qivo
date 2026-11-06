/* The Roadmap's weekly team heatmap. Its people are the owners of the tasks
 * the Roadmap shows, and each person's hours come from the server's owner
 * loads through the owner-load cache (planning.ownerLoads, P.ownerItems),
 * reconciled by task with the rows this person holds, so a pending edit
 * counts once and at once. The same load drives every cell, including live
 * drag positions, remaining-hour measurement windows and All projects / This
 * project scope, which keeps the work whose project is in the selection.
 * Busy time in projects the reader cannot see stays out: the strip counts
 * visible projects only. Agents have hours but no weekly denominator.
 * Both panes always share the Roadmap's week width, gutters and scroll origin.
 * Every row is one line — the capacity beside the name, one value per cell —
 * so a panel of a given height shows more people; the scheduled / capacity
 * hours live in each cell's accessible description. Paused tasks add no load,
 * and any week one of them is planned in wears a dashed border, whatever its
 * size. A person whose load is still on its way shows "…" in every cell, and
 * one whose load could not be read, came back past the reader's bounds or
 * past a guest's or Viewer's cap of people, or from a backend that sent no
 * projects or paused list, shows "unknown", never a percentage, so missing
 * work never reads as free time. */
import { type CSSProperties, type Ref, useEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Icon, Seg } from '../components/qivo'
import { Button } from '../components/ui/button'
import {
  fmtHours,
  hasPlannableWeek,
  issueLoadByPerson,
  type LoadIssue,
  loadTone,
  pausedWeeksByPerson,
  plannableHoursOf,
} from '../lib/workload'
import { P, type ScopeInfo, type UserVM } from '../store/planner'
import type { OwnerItem } from '../store/viewDelay'
import './Resources.css'

/** Person `user`'s place in Team utilization: their organization, and how
    many of the Roadmap's shown rows they own, which orders a guest's or
    Viewer's capped calls (P.watchRoadmapTeam). */
export type TeamPerson = { user: UserVM; org: string; rows: number }

/** What the strip knows of one person's weeks: still loading, unknown, or
    the hours each shown week holds and the weeks with paused work. */
type Figures =
  | { state: 'waiting' }
  | { state: 'unknown' }
  | {
      state: 'ok'
      hours: Map<number, number>
      paused: Set<number>
      /** the work the figures spread, for a drag's spread again */
      items: readonly OwnerItem[]
    }

/** Person `id`'s figures over the weeks `range` from their work `items`
    (P.ownerItems), keeping, under This project, the work whose project
    `inScope` keeps, and with the weeks of the tasks in `live` (by uuid)
    replaced by their drafts. Work without a project, busy time the reader
    cannot see, stays out. */
function figuresOf(
  id: string,
  items: readonly OwnerItem[],
  range: { from: number; to: number },
  inScope: ((pid: string) => boolean) | undefined,
  live?: Record<string, { start: number; end: number }>,
): Extract<Figures, { state: 'ok' }> {
  const issues: LoadIssue[] = []
  for (const item of items) {
    if (item.project === null) continue
    const draft = item.uuid ? live?.[item.uuid] : undefined
    issues.push({
      owner: id,
      project: item.project,
      start: draft ? draft.start : item.start,
      end: draft ? draft.end : item.end,
      remaining: item.remaining,
      remainingSet: item.remainingSet,
      paused: item.paused,
    })
  }
  const hours = new Map<number, number>()
  issueLoadByPerson(issues, inScope, range)
    .get(id)
    ?.forEach((byProject, week) => {
      let total = 0
      byProject.forEach((h) => {
        total += h
      })
      hours.set(week, total)
    })
  const paused = pausedWeeksByPerson(issues, inScope, range).get(id) ?? new Set<number>()
  return { state: 'ok', hours, paused, items }
}

type Props = {
  /** the owners of the Roadmap's shown tasks that meet the window */
  people: TeamPerson[]
  /** whether the Roadmap's tasks are a current answer's (`ok`), on their way
      (`waiting`), or a note took their place (`none`), for the empty strip */
  status: 'ok' | 'waiting' | 'none'
  w0: number
  w1: number
  weekW: number
  labelW: number
  gutter?: number
  height: number | string
  info: ScopeInfo
  panelRef: Ref<HTMLElement>
  bodyRef: Ref<HTMLDivElement>
  /** the bars being dragged, by task uuid */
  livePositions?: Record<string, { start: number; end: number }>
  mode: string
  onMode?: (mode: string) => void
  onBodyScroll?: (left: number) => void
  selectedUser?: string
  onSelectUser?: (id: string) => void
  filterKey: string
  onActiveWeek?: (week: number | null) => void
}

function ResourceStrip({
  people,
  status,
  w0,
  w1,
  weekW,
  labelW,
  gutter = 0,
  height,
  info,
  panelRef,
  bodyRef,
  livePositions,
  mode,
  onMode,
  onBodyScroll,
  selectedUser,
  onSelectUser,
  filterKey,
  onActiveWeek,
}: Props) {
  const [viewMode, setViewMode] = useState('all')
  type ActiveCell = { userId: string; week: number }
  const hoveredCell = useRef<ActiveCell | null>(null)
  const focusedCell = useRef<ActiveCell | null>(null)
  const lockedCell = useRef<(ActiveCell & { context: string }) | null>(null)
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null)
  const highlightCell = (cell: ActiveCell | null) => {
    setActiveCell(cell)
    onActiveWeek?.(lockedCell.current?.week ?? cell?.week ?? null)
  }
  // Clicking a workload cell pins its week until another cell is selected
  // or the person selection is dismissed. Hover still identifies the person.
  useEffect(() => {
    if (lockedCell.current && lockedCell.current.userId !== selectedUser) {
      lockedCell.current = null
      onActiveWeek?.(hoveredCell.current?.week ?? focusedCell.current?.week ?? null)
    }
  }, [selectedUser, onActiveWeek])
  const users = people.map((p) => p.user)
  // Filters clear transient hover/focus but retain a clicked week while its
  // person remains visible. Changing the grid itself releases the week lock.
  const lockContext = JSON.stringify([info.id, info.wide, P.gridEpoch, mode, viewMode, w0, w1])
  const highlightContext = JSON.stringify([filterKey, lockContext, users.map((u) => u.id)])
  const activeContext = useRef(highlightContext)
  useEffect(() => {
    if (activeContext.current !== highlightContext) {
      activeContext.current = highlightContext
      hoveredCell.current = null
      focusedCell.current = null
      if (lockedCell.current?.context !== lockContext) lockedCell.current = null
      setActiveCell(null)
      onActiveWeek?.(lockedCell.current?.week ?? null)
    }
  }, [highlightContext, lockContext, onActiveWeek])
  // a kept Roadmap shown again (components/KeptView) gets its week back
  useEffect(() => {
    onActiveWeek?.(lockedCell.current?.week ?? null)
    return () => onActiveWeek?.(null)
  }, [onActiveWeek])
  const scopeOnly = viewMode === 'scope' && !info.wide
  const capById = new Map(users.map((u) => [u.id, plannableHoursOf(u)]))

  /* Each person's figures, once for each answer of the owner-load cache,
     change of the rows on screen (the views' news covers both), window and
     grid. Done work contributes no remaining load. Paused work is not
     load; its weeks get a fixed dashed mark instead. Only the weeks on
     screen are spread, however far a plan runs. */
  const views = P.updates.views.getSnapshot()
  const peopleKey = people.map((p) => `${p.org}:${p.user.id}`).join()
  const base = useMemo(() => {
    const range = { from: w0, to: w1 }
    const scopeSet = new Set([info.id, ...info.subIds])
    const inScope = scopeOnly ? (pid: string) => scopeSet.has(pid) : undefined
    const out = new Map<string, Figures>()
    for (const { user, org } of people) {
      const load = P.ownerLoad(org, user.id)
      const items = P.ownerItems(org, user.id)
      out.set(
        user.id,
        load.state === 'waiting'
          ? { state: 'waiting' }
          : items
            ? figuresOf(user.id, items, range, inScope)
            : { state: 'unknown' },
      )
    }
    return { out, range, inScope }
    // the views' news and the people's signature cover what the figures read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, peopleKey, w0, w1, scopeOnly, info.id, info.subIds.join(), P.gridEpoch])
  /** Person `id`'s figures, a drag applied as the change of its task alone:
      only a person who owns a dragged task spreads again. */
  const figures = (id: string): Figures | undefined => {
    const f = base.out.get(id)
    if (f?.state !== 'ok' || !livePositions) return f
    if (!f.items.some((it) => it.uuid && livePositions[it.uuid])) return f
    return figuresOf(id, f.items, base.range, base.inScope, livePositions)
  }
  const measurement = (u: UserVM, f: Figures | undefined, week: number) => {
    if (!f || f.state === 'waiting') return `${P.weekLabel(week)}, Loading workload`
    if (f.state === 'unknown') return `${P.weekLabel(week)}, workload unknown`
    const h = f.hours.get(week) ?? 0
    const cap = capById.get(u.id)
    return hasPlannableWeek(cap)
      ? `${P.weekLabel(week)}, ${fmtHours(h)} / ${fmtHours(cap)} h, ${Math.round((h / cap) * 100)}%`
      : `${P.weekLabel(week)}, ${fmtHours(h)} h`
  }
  const description = (u: UserVM, f: Figures | undefined, week: number) =>
    `${u.name}, ${measurement(u, f, week)}${f?.state === 'ok' && f.paused.has(week) ? ', includes paused work' : ''}`
  const weeks = Array.from({ length: w1 - w0 + 1 }, (_, i) => w0 + i)

  return (
    <section
      ref={panelRef}
      className="resource-strip"
      data-split-strip
      data-strip-mode={mode}
      data-strip-density={weekW >= 72 ? 'full' : weekW >= 40 ? 'compact' : 'tight'}
      style={
        {
          height,
          '--res-label': `${labelW}px`,
          '--res-gutter': `${gutter}px`,
          '--res-week': `${weekW}px`,
          '--res-weeks': `${weeks.length * weekW}px`,
        } as CSSProperties
      }
    >
      <header className="rs-header">
        <div className="rs-heading">
          <Icon name="people" />
          <h3>Team utilization</h3>
        </div>
        <div className="rs-actions">
          {!info.wide && (
            <div data-strip-scope={viewMode}>
              <Seg
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { value: 'all', label: 'All projects' },
                  { value: 'scope', label: 'This project' },
                ]}
              />
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-strip-expand
            disabled={mode === 'max'}
            aria-label="Expand utilization"
            title="Expand utilization"
            onClick={() => onMode?.('max')}
          >
            <Icon name="chevronUp" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-strip-split
            disabled={mode === 'normal'}
            aria-label="Show roadmap and team"
            title="Show roadmap and team"
            onClick={() => onMode?.('normal')}
          >
            <Icon name="rows" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-strip-collapse
            disabled={mode === 'min'}
            aria-label="Collapse utilization"
            title="Collapse utilization"
            onClick={() => onMode?.('min')}
          >
            <Icon name="chevronDown" />
          </Button>
        </div>
      </header>
      {mode !== 'min' && (
        <div
          className="rs-body"
          ref={bodyRef}
          onScroll={(e) => onBodyScroll?.(e.currentTarget.scrollLeft)}
        >
          {users.length === 0 ? (
            // only a current answer says nothing matches
            <p className="rs-empty" data-res-empty={status}>
              {status === 'ok'
                ? 'No assigned tasks match this view.'
                : status === 'waiting'
                  ? '…'
                  : ''}
            </p>
          ) : (
            <div className="rs-week-grid">
              {users.map((u) => {
                const capacity = capById.get(u.id)
                const bounded = hasPlannableWeek(capacity)
                const f = figures(u.id)
                return (
                  <div
                    className="rs-grid-row rs-week-row"
                    key={u.id}
                    data-res-row={u.id}
                    data-res-unbounded={!bounded || undefined}
                  >
                    <div className="rs-label">
                      <Button
                        type="button"
                        variant="ghost"
                        className="rs-person"
                        data-res-person={u.id}
                        data-resource-user-active={activeCell?.userId === u.id || undefined}
                        aria-pressed={selectedUser === u.id}
                        title="Highlight on roadmap"
                        onClick={() => {
                          lockedCell.current = null
                          highlightCell(hoveredCell.current ?? focusedCell.current)
                          onSelectUser?.(u.id)
                        }}
                      >
                        <Avatar id={u.id} size={28} />
                        <span className="rs-person-copy">
                          <span className="rs-person-name">{u.name}</span>
                          {/* the capacity shares the name's line, a clear gap
                              after it so it reads as a fact beside the person
                              rather than as part of their name */}
                          {bounded && (
                            <span className="rs-person-capacity" data-res-plannable={capacity}>
                              {fmtHours(capacity)} hours/week
                            </span>
                          )}
                        </span>
                      </Button>
                    </div>
                    <div className="rs-gutter" />
                    <div className="rs-weeks">
                      {weeks.map((w) => {
                        const known = f?.state === 'ok' ? f : null
                        const raw = known?.hours.get(w) ?? 0
                        const pct = bounded && known ? Math.round((raw / capacity) * 100) : null
                        return (
                          <Button
                            type="button"
                            variant="ghost"
                            key={w}
                            className="rs-week-cell"
                            data-tone={
                              !known
                                ? (f?.state ?? 'waiting')
                                : bounded
                                  ? loadTone(pct as number)
                                  : 'agent'
                            }
                            aria-label={description(u, f, w)}
                            onMouseEnter={() => {
                              hoveredCell.current = { userId: u.id, week: w }
                              highlightCell(hoveredCell.current)
                            }}
                            onMouseLeave={() => {
                              hoveredCell.current = null
                              highlightCell(focusedCell.current)
                            }}
                            onFocus={(e) => {
                              // Focusing a distant week must pan both grids
                              // before the header highlight triggers a render
                              // and the timeline re-pins the strip's scroll.
                              e.currentTarget.scrollIntoView({
                                block: 'nearest',
                                inline: 'nearest',
                              })
                              const body = e.currentTarget.closest<HTMLDivElement>('.rs-body')
                              if (body) onBodyScroll?.(body.scrollLeft)
                              focusedCell.current = { userId: u.id, week: w }
                              highlightCell(focusedCell.current)
                            }}
                            onBlur={() => {
                              focusedCell.current = null
                              highlightCell(hoveredCell.current)
                            }}
                            onClick={() => {
                              lockedCell.current = { userId: u.id, week: w, context: lockContext }
                              onActiveWeek?.(w)
                              if (selectedUser !== u.id) onSelectUser?.(u.id)
                            }}
                          >
                            {known ? (
                              <span
                                className="rs-heat-value"
                                data-load-box={w}
                                data-load-pct={pct ?? undefined}
                                data-load-hours={Math.round(raw * 10) / 10}
                                data-load-paused={known.paused.has(w) || undefined}
                                style={
                                  {
                                    '--res-heat': `${Math.min(24, 4 + (pct ?? 0) * 0.16)}%`,
                                  } as CSSProperties
                                }
                              >
                                <strong>{bounded ? `${pct}%` : `${fmtHours(raw)} h`}</strong>
                              </span>
                            ) : (
                              // no figure, no heat and no paused mark: a load
                              // that is not there is never free time
                              <span
                                className="rs-heat-value rs-heat-unknown"
                                data-load-box={w}
                                data-load-unknown={f?.state === 'unknown' || undefined}
                                data-load-waiting={f?.state !== 'unknown' || undefined}
                              >
                                <strong>{f?.state === 'unknown' ? 'unknown' : '…'}</strong>
                              </span>
                            )}
                          </Button>
                        )
                      })}
                    </div>
                    <div className="rs-gutter" />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export { ResourceStrip }
