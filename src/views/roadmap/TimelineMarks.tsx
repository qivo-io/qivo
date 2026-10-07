import type { CSSProperties, PointerEvent } from 'react'
import { useContext, useRef as useRefR } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { LandscapeContext } from '@/lib/landscape'
import { Icon } from '../../components/qivo'
import type { DateEnvelope } from '../../lib/dates'
import type { RoadmapEdge } from '../../lib/roadmapEdges'
import { type IssueVM, type MilestoneVM, P } from '../../store/planner'

export const BAR_RING = 4

// Done and delayed states choose the hue. Theme tokens set tint and rim;
// paused work adds stripes without hiding that state.
const roadmapBarPaint = (it: IssueVM) => {
  const pressure = P.delayColor(it) && P.delayOf(it)?.status
  const state = P.isDone(it)
    ? 'done'
    : pressure === 'late' || pressure === 'behind'
      ? pressure
      : 'planned'
  const color = `var(--roadmap-bar-${state})`
  const fill = `var(--roadmap-bar-${state}-fill, var(--roadmap-bar-fill))`
  const tint = `color-mix(in oklab, ${color} ${fill}, transparent)`
  return {
    color,
    rim: `var(--roadmap-bar-${state}-rim, color-mix(in oklab, ${color} var(--roadmap-bar-rim), transparent))`,
    surface: it.paused
      ? `repeating-linear-gradient(135deg, ${tint} 0 3px, color-mix(in oklab, ${color} 12%, transparent) 3px 7px)`
      : tint,
  }
}

export function WeekCountEdge({
  it,
  edge,
  side,
  fade,
  ring,
  onReveal,
}: {
  it: IssueVM
  edge: RoadmapEdge
  side: 'before' | 'after'
  fade: number
  ring?: string
  onReveal: () => void
}) {
  const before = side === 'before'
  const outside = edge.kind === 'outside'
  // A detached task still occupies the nearest hidden week when there is no gap.
  const filled = !outside || edge.weeks === 0
  const paint = roadmapBarPaint(it)
  const relation = outside
    ? before
      ? 'Planned period ended before this window'
      : 'Planned period starts after this window'
    : before
      ? 'Continues from earlier weeks'
      : 'Continues into later weeks'
  const count = `${edge.weeks} ${edge.weeks === 1 ? 'week' : 'weeks'}`
  const explanation = outside
    ? `${count} between the planned period and this window`
    : `${count} of this task ${before ? 'before' : 'after'} this window`
  const verb = outside ? (before ? 'Ended' : 'Starts') : before ? 'Started' : 'Ends'
  const endpoint = `${verb} ${P.weekLabel(edge.endpoint)}`
  return (
    <Button
      type="button"
      variant="unstyled"
      className="roadmap-week-edge"
      data-roadmap-edge={it.id}
      data-edge-kind={edge.kind}
      data-edge-filled={filled}
      data-edge-side={side}
      data-offwin={outside ? it.id : undefined}
      style={
        {
          opacity: fade,
          '--roadmap-edge-color': filled ? paint.color : P.delayColor(it) || 'var(--text-3)',
          '--roadmap-edge-surface': paint.surface,
          '--roadmap-edge-rim': filled ? paint.rim : undefined,
          // a connected chip is the visible start or end of its bar, so a
          // ringed bar rings it too (Roadmap.css)
          '--roadmap-edge-ring': outside ? undefined : ring,
        } as CSSProperties
      }
      aria-label={`${it.title}${it.paused ? ', paused' : ''}: ${relation}. ${explanation}. ${endpoint}. Show ${before ? 'earlier' : 'later'} weeks`}
      title={`${verb} ${P.weekNumLabel(edge.endpoint)}`}
      onClick={onReveal}
    >
      <span className="roadmap-week-count">
        {before && <Icon name="chevronLeft" size={12} />}
        {!before && <Icon name="chevronRight" size={12} />}
      </span>
    </Button>
  )
}

export function Bar({
  it,
  start,
  end,
  w0,
  w1,
  weekW,
  env,
  onSched,
  onCommit,
  onOpen,
  ring,
}: {
  it: IssueVM
  start: number
  end: number
  w0: number
  w1: number
  weekW: number
  env: DateEnvelope | null
  onSched: (id: string, start: number, end: number) => void
  onCommit: (id: string, epoch: number) => void
  onOpen: (id: string) => void
  ring?: string
}) {
  // Completed work is green, including its connected edge badges.
  // Unfinished work keeps the accent unless delay tracking reports pressure.
  const paint = roadmapBarPaint(it)
  // Hover help includes on-track status even when paint shows no pressure.
  const delay = P.tracksDelay(it) ? P.delayOf(it) : null
  const delayNote = P.tracksDelay(it)
    ? `, ${delay ? P.DELAY_LABELS[delay.status] : P.isDone(it) ? 'complete' : 'no delay signal'}`
    : ''
  const drag = useRefR<{
    mode: 'move' | 'start' | 'end'
    x: number
    rotated: boolean
    s: number
    e: number
    moved: boolean
    epoch: number
    frozen: boolean
  } | null>(null)
  const landscape = useContext(LandscapeContext)
  // Keep pointer handlers for read-only clicks, but gate all plan drags.
  const movable = P.canWrite(it.project)
  // Drawn across the visible weeks only: a span that continues past either
  // end stops flush at the timeline edge, squared, where its edge chip joins
  // it. Nothing the bar paints (ring, shadow) may cross that join.
  const cutStart = start < w0
  const cutEnd = end > w1
  const left = (Math.max(start, w0) - w0) * weekW
  const width = (cutEnd ? w1 - w0 + 1 : end - w0 + 1) * weekW - (cutEnd ? 0 : 6) - left
  const spill = BAR_RING * 2
  const clipPath =
    cutStart || cutEnd
      ? `inset(-${spill}px ${cutEnd ? 0 : -spill}px -${spill}px ${cutStart ? 0 : -spill}px)`
      : undefined

  const onDown = (mode: 'move' | 'start' | 'end') => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    // epoch: the grid can re-anchor mid-drag (another admin changes the org's
    // week start; realtime rebuild) — the held indexes are then stale units
    drag.current = {
      mode,
      x: landscape?.rotated ? e.clientY : e.clientX,
      rotated: !!landscape?.rotated,
      s: start,
      e: end,
      moved: false,
      epoch: P.gridEpoch,
      frozen: !movable,
    }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.frozen) return
    if (drag.current.epoch !== P.gridEpoch) return
    const x = drag.current.rotated ? e.clientY : e.clientX
    const d = Math.round((x - drag.current.x) / weekW)
    // partially-visible bars clamp INTO the window — don't snap them there
    // before the pointer has actually dragged a full week
    if (d === 0 && !drag.current.moved) return
    if (d !== 0) drag.current.moved = true
    const { mode, s: os, e: oe } = drag.current
    // window clamp (the bar must keep intersecting the window or it unmounts
    // mid-drag and loses the release commit) + envelope pin (a parent never
    // shrinks inside its sub-issues; a bar already violating the rule drags
    // toward compliance only, never teleports) — see clampBarDrag
    const r = P.clampBarDrag(mode, os, oe, d, w0, w1, env)
    onSched(it.id, r.start, r.end)
  }
  const onUp = () => {
    if (drag.current) {
      if (!drag.current.moved) onOpen(it.id)
      else onCommit(it.id, drag.current.epoch)
    }
    drag.current = null
  }

  return (
    <HoverTooltip
      content={`${it.title}, ${P.fmtRange(start, end)}${it.paused ? ', paused' : ''}${delayNote}${movable ? '' : ', read-only'}`}
    >
      <div
        data-bar={it.id}
        onPointerDown={onDown('move')}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{
          left,
          width,
          borderTopLeftRadius: cutStart ? 0 : undefined,
          borderBottomLeftRadius: cutStart ? 0 : undefined,
          borderTopRightRadius: cutEnd ? 0 : undefined,
          borderBottomRightRadius: cutEnd ? 0 : undefined,
          clipPath,
          cursor: movable ? 'grab' : 'pointer',
          background: paint.surface,
          // no rim on a cut side: the joined chip carries the outline on
          borderColor: paint.rim,
          borderWidth: `1px ${cutEnd ? 0 : 1}px 1px ${cutStart ? 0 : 1}px`,
          boxShadow: ring
            ? `0 0 0 ${BAR_RING}px ${ring}, var(--qivo-shadow-card)`
            : 'var(--qivo-shadow-card)',
        }}
        className="[position:absolute] [top:8px] [height:20px] [border-style:solid] [border-radius:var(--r-sm)] [overflow:hidden] [touch-action:none] [user-select:none] [transition:filter_var(--dur-fast)_var(--ease-out),_box-shadow_var(--dur-fast)_var(--ease-out)]"
        onMouseEnter={(e) => {
          e.currentTarget.style.filter = 'brightness(1.05)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.filter = 'none'
        }}
      >
        {movable && !cutStart && (
          <div
            onPointerDown={onDown('start')}
            className="[position:absolute] [left:0] [top:0] [bottom:0] [width:9px] [cursor:ew-resize]"
          />
        )}
        {movable && !cutEnd && (
          <div
            onPointerDown={onDown('end')}
            className="[position:absolute] [right:0] [top:0] [bottom:0] [width:9px] [cursor:ew-resize]"
          />
        )}
      </div>
    </HoverTooltip>
  )
}

/* draggable milestone diamond in the header */
export function MilestoneFlag({
  m,
  week,
  w0,
  w1,
  weekW,
  onLive,
  onCommit,
  onEdit,
}: {
  m: MilestoneVM
  week: number
  w0: number
  w1: number
  weekW: number
  onLive: (id: string, week: number) => void
  onCommit: (id: string, epoch: number) => void
  onEdit?: (id: string) => void
}) {
  const drag = useRefR<{
    x: number
    rotated: boolean
    w: number
    moved: boolean
    epoch: number
  } | null>(null)
  const landscape = useContext(LandscapeContext)
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      x: landscape?.rotated ? e.clientY : e.clientX,
      rotated: !!landscape?.rotated,
      w: week,
      moved: false,
      epoch: P.gridEpoch,
    }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    if (drag.current.epoch !== P.gridEpoch) return
    const x = drag.current.rotated ? e.clientY : e.clientX
    const d = Math.round((x - drag.current.x) / weekW)
    if (d === 0 && !drag.current.moved) return
    if (d !== 0) drag.current.moved = true
    onLive(m.id, Math.max(w0, Math.min(w1, drag.current.w + d)))
  }
  const onUp = () => {
    if (drag.current) {
      if (!drag.current.moved) {
        onEdit?.(m.id)
      } else {
        onCommit(m.id, drag.current.epoch)
      }
    }
    drag.current = null
  }
  return (
    <HoverTooltip content={`${m.name}, ${P.weekLabel(week)}`}>
      <div
        data-msflag={m.id}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ left: (week - w0) * weekW - 4.5, width: weekW }}
        className="[position:absolute] [bottom:3px] [display:flex] [align-items:center] [gap:8px] [cursor:ew-resize] [touch-action:none] [user-select:none] [padding:2px_4px_2px_0] [z-index:2]"
      >
        <span
          style={{ background: P.MILESTONE_COLOR }}
          className="[width:9px] [height:9px] [transform:rotate(45deg)] [border-radius:var(--r-2xs)] [flex-shrink:0] [box-shadow:var(--qivo-shadow-card)]"
        />
        <span className="min-w-0 line-clamp-2 [overflow-wrap:anywhere] [font-size:var(--fs-2xs)] [line-height:13px] [font-weight:600] [color:var(--text-2)]">
          {m.name}
        </span>
      </div>
    </HoverTooltip>
  )
}
