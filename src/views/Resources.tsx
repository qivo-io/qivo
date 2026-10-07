/* The Roadmap's weekly team heatmap. The same issue-derived load drives every
 * cell, including live drag positions, remaining-hour measurement windows and
 * All projects / This project scope. Agents have hours but no weekly denominator.
 * Both panes always share the Roadmap's week width, gutters and scroll origin.
 * Every row is one line — the capacity beside the name, one value per cell —
 * so a panel of a given height shows more people; the scheduled / capacity
 * hours live in each cell's accessible description. Paused tasks add no load,
 * and any week one of them is planned in wears a dashed border, whatever its
 * size. */
import { type CSSProperties, type Ref, useEffect, useRef, useState } from 'react'
import { Avatar, Icon, Seg } from '../components/qivo'
import { Button } from '../components/ui/button'
import {
  fmtHours,
  hasPlannableWeek,
  issueLoadByPerson,
  loadTone,
  pausedWeeksByPerson,
  plannableHoursOf,
} from '../lib/workload'
import { P, type ScopeInfo, type UserVM } from '../store/planner'
import './Resources.css'

const STRIP_HEAD_H = 48
// One line per person: a 40px row plus its divider.
const STRIP_ROW_H = 41

// Header, body's top rule, rows and panel borders.
function stripHeight(n: number) {
  return STRIP_HEAD_H + 1 + (n ? n * STRIP_ROW_H : 38) + 2
}

type Props = {
  users: UserVM[]
  w0: number
  w1: number
  weekW: number
  labelW: number
  gutter?: number
  height: number | string
  info: ScopeInfo
  panelRef: Ref<HTMLElement>
  bodyRef: Ref<HTMLDivElement>
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
  users,
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
  useEffect(() => () => onActiveWeek?.(null), [onActiveWeek])
  const scopeSet = new Set([info.id, ...info.subIds])
  const scopeOnly = viewMode === 'scope' && !info.wide
  const capById = new Map(users.map((u) => [u.id, plannableHoursOf(u)]))

  // Done work contributes no remaining load. During a drag, replace only the
  // moved issue's span and feed it through the ordinary workload calculation.
  const open = P.issues.filter((it) => !P.isGroup(it) && it.status !== 'done')
  const items = livePositions
    ? open.map((it) => {
        const live = livePositions[it.id]
        return live ? { ...it, start: live.start, end: live.end } : it
      })
    : open
  const inScope = scopeOnly ? (pid: string) => scopeSet.has(pid) : undefined
  // Paused work is not load; its weeks get a fixed dashed mark instead.
  const loads = issueLoadByPerson(items, inScope)
  const pausedWeeks = pausedWeeksByPerson(items, inScope)
  const hoursAt = (id: string, week: number) => {
    let total = 0
    loads
      .get(id)
      ?.get(week)
      ?.forEach((h) => {
        total += h
      })
    return total
  }
  const measurement = (u: UserVM, week: number) => {
    const h = hoursAt(u.id, week)
    const cap = capById.get(u.id)
    return hasPlannableWeek(cap)
      ? `${P.weekLabel(week)}, ${fmtHours(h)} / ${fmtHours(cap)} h, ${Math.round((h / cap) * 100)}%`
      : `${P.weekLabel(week)}, ${fmtHours(h)} h`
  }
  const description = (u: UserVM, week: number) =>
    `${u.name}, ${measurement(u, week)}${pausedWeeks.get(u.id)?.has(week) ? ', includes paused work' : ''}`
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
            <p className="rs-empty">No assigned tasks match this view.</p>
          ) : (
            <div className="rs-week-grid">
              {users.map((u) => {
                const capacity = capById.get(u.id)
                const bounded = hasPlannableWeek(capacity)
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
                        const raw = hoursAt(u.id, w)
                        const pct = bounded ? Math.round((raw / capacity) * 100) : null
                        return (
                          <Button
                            type="button"
                            variant="ghost"
                            key={w}
                            className="rs-week-cell"
                            data-tone={bounded ? loadTone(pct) : 'agent'}
                            aria-label={description(u, w)}
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
                            <span
                              className="rs-heat-value"
                              data-load-box={w}
                              data-load-pct={pct ?? undefined}
                              data-load-hours={Math.round(raw * 10) / 10}
                              data-load-paused={pausedWeeks.get(u.id)?.has(w) || undefined}
                              style={
                                {
                                  '--res-heat': `${Math.min(24, 4 + (pct ?? 0) * 0.16)}%`,
                                } as CSSProperties
                              }
                            >
                              <strong>{bounded ? `${pct}%` : `${fmtHours(raw)} h`}</strong>
                            </span>
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

export { ResourceStrip, STRIP_HEAD_H, stripHeight }
