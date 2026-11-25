import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import { useContext, useLayoutEffect, useRef as useRefR } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { LandscapeContext } from '@/lib/landscape'
import { cn } from '@/lib/utils'
import { Icon } from '../../components/qivo'
import type { RoadmapEdge } from '../../lib/roadmapEdges'
import { type IssueVM, type MilestoneVM, P } from '../../store/planner'
import { barShape, type TailPress, tailClickOpens } from './barShape'
import {
  FLAG_LANE_H,
  type FlagPlace,
  type FlagView,
  flagBandHeight,
  flagLanesShown,
} from './flagLanes'

/* Whether the store knows the caller's level on project `id`, which a bar
   that takes no drag says as ", read-only": the project cache's current
   answer gave it or left it out. While the
   cache loads it, failed or did not check it, the bar says ", loading"
   instead, so a project not yet answered never reads as read-only
   (P.projectState). */
const projectKnown = (id: string) => {
  const state = P.projectState(id)
  return state === 'ok' || state === 'gone'
}

export const BAR_RING = 4

type BarPaint = 'done' | 'late' | 'behind' | 'unknown' | 'todo' | 'progress' | 'review'
const STATUS_PAINT: Record<string, BarPaint> = {
  todo: 'todo',
  progress: 'progress',
  review: 'review',
}

/* The paint of a task's bar from the today line on (Roadmap.css). A task
   whose delay is unknown, its owner's load unread (P.delayUnknown), never
   takes a status colour that would read as on track. A task with subtasks
   shows no status of its own, so it reads as In Progress once one of its
   subtasks has started (`started`), else as To Do. */
const nowPaint = (it: IssueVM, started: boolean): BarPaint => {
  if (P.isDone(it)) return 'done'
  const pressure = P.delayColor(it) && P.delayOf(it)?.status
  if (pressure === 'late' || pressure === 'behind') return pressure
  if (P.delayUnknown(it)) return 'unknown'
  if (P.isGroup(it)) return started ? 'progress' : 'todo'
  return STATUS_PAINT[it.status] ?? 'todo'
}

/** What a bar's hover text and accessible name say of its status, which its
    colour shows. A finished task in a project that tracks delay says
    "complete" with its delay (delayNoteOf). */
const statusNoteOf = (it: IssueVM, started: boolean) => {
  if (P.isDone(it)) return P.tracksDelay(it) ? '' : ', Done'
  if (P.isGroup(it)) return started ? ', In Progress' : ', To Do'
  return `, ${P.statusOf(it.status)?.name ?? 'To Do'}`
}

/** What a bar's hover text and accessible name say of its delay. */
const delayNoteOf = (it: IssueVM) => {
  if (!P.tracksDelay(it)) return ''
  const delay = P.delayOf(it)
  return `, ${
    delay
      ? P.DELAY_LABELS[delay.status]
      : P.isDone(it)
        ? 'complete'
        : P.delayUnknown(it)
          ? 'Delay unknown'
          : 'no delay signal'
  }`
}

export function WeekCountEdge({
  it,
  edge,
  side,
  past,
  started,
  fade,
  ring,
  onReveal,
}: {
  it: IssueVM
  edge: RoadmapEdge
  side: 'before' | 'after'
  /** the hidden week next to the window is before the current week */
  past: boolean
  /** a subtask of the task has started (Roadmap.tsx subtasksStarted) */
  started: boolean
  fade: number
  ring?: string
  onReveal: () => void
}) {
  const before = side === 'before'
  const outside = edge.kind === 'outside'
  // A detached task still occupies the nearest hidden week when there is no gap.
  const filled = !outside || edge.weeks === 0
  const paint = nowPaint(it, started)
  const pressure = paint === 'behind' || paint === 'late'
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
    : `${count} of this task's plan ${before ? 'before' : 'after'} this window`
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
      data-bar-paint={past && paint !== 'done' ? 'past' : paint}
      data-unknown={paint === 'unknown' || undefined}
      data-paused={P.isPaused(it) || undefined}
      style={
        {
          opacity: fade,
          '--roadmap-edge-color': pressure ? `var(--roadmap-bar-${paint}-rim)` : 'var(--text-3)',
          // a connected chip is the visible start or end of its bar, so a
          // ringed bar rings it too (Roadmap.css)
          '--roadmap-edge-ring': outside ? undefined : ring,
        } as CSSProperties
      }
      aria-label={`${it.title}${statusNoteOf(it, started)}${P.isPaused(it) ? ', paused' : ''}${delayNoteOf(it)}: ${relation}. ${explanation}. ${endpoint}. Show ${before ? 'earlier' : 'later'} weeks`}
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
  showProjection,
  started,
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
  /** whether the person shows a Behind plan or Late task's projected finish */
  showProjection: boolean
  /** a subtask of the task has started (Roadmap.tsx subtasksStarted) */
  started: boolean
  onSched: (id: string, start: number, end: number) => void
  onCommit: (id: string, epoch: number) => void
  onOpen: (id: string) => void
  ring?: string
}) {
  const paint = nowPaint(it, started)
  const pressure = paint === 'behind' || paint === 'late'
  const shape = barShape({
    start,
    end,
    w0,
    w1,
    weekW,
    todayWeek: P.TODAY_WEEK,
    todayPos: P.TODAY_POS,
    done: paint === 'done',
    finish: pressure ? (P.delayOf(it)?.fin ?? null) : null,
    showProjection,
  })
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
  // Keep pointer handlers for read-only clicks, but gate all plan drags. A
  // group's dates come from its subtasks, so its bar is never dragged either.
  const group = P.isGroup(it)
  const movable = P.canWrite(it.project) && !group
  const paused = P.isPaused(it)
  const finishNote =
    shape.stripesTo === null
      ? ''
      : `, projected to finish in the week of ${P.fmtDate(P.weekToDate(shape.stripesTo))}`
  const label = `${it.title}, ${P.fmtRange(start, end)}${statusNoteOf(it, started)}${paused ? ', paused' : ''}${delayNoteOf(it)}${finishNote}${group ? ', dates from subtasks' : movable ? '' : projectKnown(it.project) ? ', read-only' : ', loading'}`
  const { plan, runOn, projection } = shape
  const tail = runOn ?? projection
  const tailEnd = projection ?? runOn
  // the plan and its run-on or stripes read as one shape: no rim, rounding
  // or ring where they meet
  const joined = !!plan && !!tail && !plan.cutEnd

  const dragged = useRefR(false)
  const onDown = (mode: 'move' | 'start' | 'end') => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragged.current = false
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
    // the window clamp keeps the bar intersecting the window, or it would
    // unmount mid-drag and lose the release commit (see clampBarDrag)
    const r = P.clampBarDrag(mode, os, oe, d, w0, w1)
    onSched(it.id, r.start, r.end)
  }
  const endDrag = () => {
    const moved = !!drag.current?.moved
    if (drag.current && moved) onCommit(it.id, drag.current.epoch)
    drag.current = null
    return moved
  }
  // The click that follows a drag's release opens nothing. That click comes
  // before any timer, and a release off the bar sends none, so the mark is
  // dropped after it either way. Any other click opens the task, also one an
  // assistive tool sends alone.
  const onUp = () => {
    if (!endDrag()) return
    dragged.current = true
    setTimeout(() => {
      dragged.current = false
    }, 0)
  }
  const onClick = () => {
    if (!dragged.current) onOpen(it.id)
  }
  // The run-on and the stripes are no plan to drag: a press that travels
  // across them moves nothing and opens nothing. The press holds the pointer,
  // so its release and the click of that release come here (tailClickOpens).
  const tailPress = useRefR<TailPress | null>(null)
  const onTailDown = (e: PointerEvent<HTMLDivElement>) => {
    // only the main button's release sends a click
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    tailPress.current = { x: e.clientX, y: e.clientY, far: false, releasedAt: null }
  }
  const onTailMove = (e: PointerEvent<HTMLDivElement>) => {
    const press = tailPress.current
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) press.far = true
  }
  const onTailUp = (e: PointerEvent<HTMLDivElement>) => {
    if (tailPress.current) tailPress.current.releasedAt = e.timeStamp
  }
  const onTailClick = (e: MouseEvent<HTMLDivElement>) => {
    const press = tailPress.current
    tailPress.current = null
    const inside = e.currentTarget.contains(document.elementFromPoint(e.clientX, e.clientY))
    if (tailClickOpens(press, { detail: e.detail, at: e.timeStamp, inside })) onOpen(it.id)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onOpen(it.id)
  }
  // Nothing a part paints (ring, shadow) may cross a side that is cut at the
  // timeline's edge, where an edge chip joins it, or one that meets another
  // part.
  const clip = (openStart: boolean, openEnd: boolean) =>
    openStart || openEnd
      ? `inset(-${BAR_RING * 2}px ${openEnd ? 0 : -BAR_RING * 2}px -${BAR_RING * 2}px ${openStart ? 0 : -BAR_RING * 2}px)`
      : undefined
  const ringStyle = ring ? ({ '--roadmap-bar-ring': ring } as CSSProperties) : null

  return (
    <>
      {plan && (
        <HoverTooltip content={label}>
          {/* biome-ignore lint/a11y/useSemanticElements: a drag handle; a native button would also click at the end of every drag. */}
          <div
            data-bar={it.id}
            data-bar-paint={paint}
            data-paused={paused || undefined}
            data-open-start={plan.cutStart || undefined}
            data-open-end={plan.cutEnd || joined || undefined}
            role="button"
            tabIndex={0}
            aria-label={label}
            onPointerDown={onDown('move')}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={endDrag}
            onClick={onClick}
            onKeyDown={onKey}
            style={
              {
                ...ringStyle,
                '--bar-split': `${shape.past}px`,
                left: plan.left,
                width: plan.width,
                clipPath: clip(plan.cutStart, plan.cutEnd || joined),
                cursor: movable ? 'grab' : 'pointer',
              } as CSSProperties
            }
            className="roadmap-bar"
          >
            {shape.past > 0 && (
              <span
                className="roadmap-bar-past"
                data-split={shape.past < plan.width || undefined}
              />
            )}
            {shape.past < plan.width && (
              <span className="roadmap-bar-now" data-split={shape.past > 0 || undefined} />
            )}
            {paused && plan.width >= 20 && (
              <span className="roadmap-bar-pause">
                <span className="glyph glyph-pause" />
              </span>
            )}
            {movable && !plan.cutStart && (
              <div
                onPointerDown={onDown('start')}
                className="[position:absolute] [left:0] [top:0] [bottom:0] [width:9px] [cursor:ew-resize]"
              />
            )}
            {movable && !plan.cutEnd && (
              <div
                onPointerDown={onDown('end')}
                className="[position:absolute] [right:0] [top:0] [bottom:0] [width:9px] [cursor:ew-resize]"
              />
            )}
          </div>
        </HoverTooltip>
      )}
      {tail && tailEnd && (
        <HoverTooltip content={label}>
          {/* biome-ignore lint/a11y/useSemanticElements: it sits beside the plan's bar, which is no native button either. */}
          <div
            data-bar-tail={it.id}
            data-bar-paint={paint}
            data-open-start=""
            data-open-end={tailEnd.cutEnd || undefined}
            role="button"
            aria-label={label}
            // the plan's bar speaks for both parts wherever it is in the window
            aria-hidden={plan ? true : undefined}
            tabIndex={plan ? -1 : 0}
            onPointerDown={onTailDown}
            onPointerMove={onTailMove}
            onPointerUp={onTailUp}
            onPointerCancel={() => {
              tailPress.current = null
            }}
            onClick={onTailClick}
            onKeyDown={onKey}
            style={
              {
                ...ringStyle,
                '--bar-run': `${runOn?.width ?? 0}px`,
                left: tail.left,
                width: tailEnd.left + tailEnd.width - tail.left,
                clipPath: clip(true, tailEnd.cutEnd),
              } as CSSProperties
            }
            className="roadmap-bar"
          >
            {runOn && (
              <span
                className="roadmap-bar-run"
                data-plain={!pressure || undefined}
                data-split={!!projection || undefined}
              />
            )}
            {projection && <span className="roadmap-bar-stripes" />}
          </div>
        </HoverTooltip>
      )}
    </>
  )
}

/* The header's band of milestone flags, `lanes` rows inside a box `height`
   pixels tall. It scrolls, starting at its bottom row, only when one week
   holds more milestones than it shows (`scrolls`). Then it tells `onView`
   which rows are in sight and how wide its scrollbar is, so the layout keeps
   a dragged flag in sight, counts the flags out of it and ends labels before
   the scrollbar. It tells null when it does not scroll. */
export function FlagBand({
  width,
  height,
  lanes,
  scrolls,
  busy = false,
  onView,
  children,
}: {
  width: number
  height: number
  lanes: number
  scrolls: boolean
  /** whether the flags' read is on its way, so the band is aria-busy */
  busy?: boolean
  onView: (view: FlagView | null) => void
  children: ReactNode
}) {
  const ref = useRefR<HTMLDivElement>(null)
  const read = () => {
    const band = ref.current
    if (!band || !scrolls) {
      onView(null)
      return
    }
    // a column-reverse box counts scrollTop down from 0 at its bottom row;
    // layout sizes, so the phone's turned timeline reads the same
    const shown = flagLanesShown(lanes, Math.max(0, -band.scrollTop), band.clientHeight)
    onView({ ...shown, bar: band.offsetWidth - band.clientWidth })
  }
  useLayoutEffect(read, [scrolls, lanes, height, width])
  return (
    <div
      ref={ref}
      data-msband
      data-msband-scrolls={scrolls || undefined}
      aria-busy={busy || undefined}
      onScroll={read}
      style={{ width, height }}
      className={`[position:absolute] [left:0] [bottom:0] ${
        scrolls
          ? '[display:flex] [flex-direction:column-reverse] [overflow-x:hidden] [overflow-y:auto] [overscroll-behavior:contain] [scrollbar-width:thin]'
          : ''
      }`}
    >
      <div style={{ height: flagBandHeight(lanes) }} className="[position:relative] [flex:none]">
        {children}
      </div>
    </div>
  )
}

/* draggable milestone diamond in the header, or in a track row of My view,
   in the row, on the side and with the room that layoutFlags or
   layoutTrackFlags (flagLanes.ts) gave it, its diamond nudged right of its
   week's line where the place says (`shift`). The flag is as
   wide as its label, so only the diamond and the name it shows take the
   pointer, also inside a box that takes none, as a track row's does so
   its Today line keeps its tooltip, and Enter or Space opens it as a click
   does. A label cut short
   still has the full name as its accessible name, and the tooltip shows it
   with the week on hover and on keyboard focus. A flag whose label runs left
   is placed from the band's left edge too, so a scrollbar that narrows the
   band cannot move it off its week's line. */
export function MilestoneFlag({
  m,
  week,
  w0,
  w1,
  weekW,
  place,
  movable,
  onLive,
  onCommit,
  onEdit,
}: {
  m: MilestoneVM
  week: number
  w0: number
  w1: number
  weekW: number
  place: FlagPlace
  movable: boolean // edit access to the milestone's project; otherwise a click only opens it
  onLive: (id: string, week: number) => void
  onCommit: (id: string, epoch: number) => void
  /** opens the milestone, naming the project it sits on */
  onEdit?: (id: string, project: string) => void
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
    if (!drag.current || !movable) return
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
        onEdit?.(m.id, m.project)
      } else {
        onCommit(m.id, drag.current.epoch)
      }
    }
    drag.current = null
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onEdit?.(m.id, m.project)
  }
  const x = (week - w0) * weekW + (place.shift ?? 0)
  const left = place.side === 'left'
  return (
    <HoverTooltip content={`${m.name}, ${P.weekLabel(week)}`}>
      {/* biome-ignore lint/a11y/useSemanticElements: a drag handle; a native button would also click at the end of every drag. */}
      <div
        data-msflag={m.id}
        data-msflag-side={place.side}
        role="button"
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        style={{
          ...(left ? { right: `calc(100% - ${x + 4.5}px)` } : { left: x - 4.5 }),
          maxWidth: place.room,
          height: FLAG_LANE_H,
          bottom: place.bottom,
        }}
        className={cn(
          '[position:absolute] [display:flex] [align-items:center] [gap:8px] [touch-action:none] [user-select:none] [pointer-events:auto]',
          // a flag being dragged passes over the others, hiding what it covers
          week === m.week ? '[z-index:2]' : '[z-index:3] bg-surface-1',
          left ? '[flex-direction:row-reverse] [padding:0_0_0_4px]' : '[padding:0_4px_0_0]',
          movable ? '[cursor:ew-resize]' : '[cursor:pointer]',
        )}
      >
        <span
          style={{ background: P.MILESTONE_COLOR }}
          className="[width:9px] [height:9px] [transform:rotate(45deg)] [border-radius:var(--r-2xs)] [flex-shrink:0] [box-shadow:var(--qivo-shadow-card)]"
        />
        <span className="min-w-0 truncate [font-size:var(--fs-2xs)] [line-height:13px] [font-weight:600] [color:var(--text-2)]">
          {m.name}
        </span>
      </div>
    </HoverTooltip>
  )
}
