import { memo, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { Icon } from '../../components/qivo'
import { type RoadmapEdge, roadmapEdges } from '../../lib/roadmapEdges'
import { type IssueVM, P, type ProjectVM } from '../../store/planner'
import type { StoreVersion } from '../../store/updates'
import { GUTTER_W, HEAD_STICK, LABEL_W, SUB_STICK } from './layout'
import type { RowObserver } from './rowObserver'
import { BAR_RING, Bar, WeekCountEdge } from './TimelineMarks'

type Row = {
  kind: 'track' | 'sub' | 'task' | 'unsched'
  pid: string
  proj: ProjectVM
  issue?: IssueVM
}
type DueMark = { x: number; color: string; state: string } | null

type Props = {
  row: Row
  top: number
  h: number
  remH: number
  open: boolean
  planning: boolean
  revealing: boolean
  fade: number
  ring?: string
  due: DueMark
  start: number | null
  end: number | null
  w0: number
  w1: number
  weekW: number
  timelineW: number
  hasSubHeads: boolean
  workspaceVersion: StoreVersion
  observer: RowObserver
  guidesKey: string
  renderGuides: () => ReactNode
  onToggle: (id: string) => void
  onScope: (id: string) => void
  onOpen: (id: string) => void
  onSchedule: (id: string, start: number, end: number) => void
  onCommit: (id: string, epoch: number) => void
  onEdgeReveal: (side: 'before' | 'after', endpoint: number) => void
}

function TimelineRowView({
  row,
  top,
  h,
  remH,
  open,
  planning,
  revealing,
  fade,
  ring,
  due,
  start,
  end,
  w0,
  w1,
  weekW,
  timelineW,
  hasSubHeads,
  observer,
  renderGuides,
  onToggle,
  onScope,
  onOpen,
  onSchedule,
  onCommit,
  onEdgeReveal,
}: Props) {
  const isTrack = row.kind === 'track'
  const isSub = row.kind === 'sub'
  const isGroup = isTrack || isSub
  const [hydrated, setHydrated] = useState(isGroup)
  const ready = hydrated || isGroup || planning || revealing
  const rowElement = useRef<HTMLDivElement>(null)
  const restoreTitleFocus = useRef(false)
  const pressed = useRef(false)
  const deferredActivation = useRef(false)
  const activate = () => {
    if (pressed.current) {
      deferredActivation.current = true
      return
    }
    restoreTitleFocus.current = rowElement.current?.contains(document.activeElement) ?? false
    setHydrated(true)
  }
  useLayoutEffect(() => {
    if (ready) {
      // A planning/reveal request can hydrate a row before the observer sees it.
      if (!hydrated) setHydrated(true)
      if (restoreTitleFocus.current) {
        restoreTitleFocus.current = false
        rowElement.current
          ?.querySelector<HTMLButtonElement>('[data-roadmap-task-open]')
          ?.focus({ preventScroll: true })
      }
      return
    }
    const element = rowElement.current
    if (element) return observer.observe(element, activate)
  }, [observer, ready, hydrated])
  const cancelRelease = useRef<() => void>(() => {})
  const holdTitle = () => {
    pressed.current = true
    cancelRelease.current()
    let frame = 0
    const removeListeners = () => {
      document.removeEventListener('pointerup', release)
      document.removeEventListener('pointercancel', release)
    }
    const release = () => {
      removeListeners()
      pressed.current = false
      if (!deferredActivation.current) return
      deferredActivation.current = false
      // Preserve the pressed DOM target through click dispatch.
      frame = requestAnimationFrame(activate)
    }
    document.addEventListener('pointerup', release)
    document.addEventListener('pointercancel', release)
    cancelRelease.current = () => {
      cancelAnimationFrame(frame)
      removeListeners()
    }
  }
  useLayoutEffect(() => () => cancelRelease.current(), [])
  const edges =
    row.kind === 'task' && start != null && end != null
      ? roadmapEdges(start, end, w0, w1)
      : { left: null, right: null }
  let min = Infinity
  let max = -Infinity
  for (const id of row.issue?.children ?? []) {
    const child = P.issueById[id]
    if (!child || child.start == null) continue
    min = Math.min(min, child.start)
    max = Math.max(max, child.end)
  }
  const envelope = min === Infinity ? null : { min, max }

  const edgeColumn = (side: 'before' | 'after', edge: RoadmapEdge | null) => (
    <div
      className={`roadmap-edge-column roadmap-edge-${side} roadmap-row-edge`}
      style={{ width: GUTTER_W, height: h }}
    >
      {edge && (
        <WeekCountEdge
          it={row.issue}
          edge={edge}
          side={side}
          fade={fade}
          ring={ring}
          onReveal={() => onEdgeReveal(side, edge.endpoint)}
        />
      )}
    </div>
  )
  return (
    <div
      ref={rowElement}
      data-track={isTrack ? row.pid : undefined}
      data-subtrack={isSub ? row.pid : undefined}
      data-roadmap-heading-top={isGroup ? top : undefined}
      data-roadmap-task-top={isGroup ? undefined : top}
      data-roadmap-row-ready={isGroup ? undefined : ready}
      data-roadmap-planning={planning ? row.issue.id : undefined}
      data-roadmap-revealed={revealing ? row.issue.id : undefined}
      style={{
        // Title shells and hydrated rows share the exact bordered height.
        ...(!isGroup
          ? {
              height: h + 1,
              containIntrinsicBlockSize: `auto ${h + 1}px`,
            }
          : null),
        background: isSub
          ? 'var(--roadmap-group, var(--surface-2))'
          : isTrack
            ? 'var(--roadmap-group, var(--surface-1))'
            : 'var(--roadmap-row, var(--surface-1))',
        ...(isGroup
          ? {
              position: 'sticky' as const,
              top: isSub ? SUB_STICK : HEAD_STICK,
            }
          : null),
      }}
      className={`flex border-b border-border ${
        isTrack
          ? 'z-[4] data-[roadmap-pinned=true]:z-[7]'
          : isSub
            ? 'z-[3] data-[roadmap-pinned=true]:z-[6]'
            : ''
      }`}
    >
      {!ready ? (
        <div
          style={{ width: LABEL_W, height: h }}
          className="pr-3 [flex-shrink:0] [position:sticky] [left:0] [z-index:2] [background:var(--roadmap-rail,inherit)] [border-right:1px_solid_var(--border)]"
        >
          <Button
            type="button"
            variant="ghost"
            data-roadmap-task-open={row.issue.id}
            className={`h-full w-full min-w-0 justify-start rounded-none border-0 pr-0 text-left text-base font-normal ${hasSubHeads ? 'pl-[44px]' : 'pl-[15px]'}`}
            onPointerDown={holdTitle}
            onFocus={activate}
            onClick={() => {
              pressed.current = false
              restoreTitleFocus.current = false
              setHydrated(true)
              onOpen(row.issue.id)
            }}
          >
            <span className="truncate">{row.issue.title}</span>
          </Button>
        </div>
      ) : (
        <>
          <div
            style={{
              width: LABEL_W,
              height: h,
            }}
            className="pr-3 [flex-shrink:0] [position:sticky] [left:0] [z-index:2] [background:var(--roadmap-rail,inherit)] [border-right:1px_solid_var(--border)] [display:flex] [align-items:center] [gap:8px]"
          >
            {isGroup ? (
              <>
                {/* Folding and project navigation keep separate hit targets. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-row-fold={row.pid}
                  className={`absolute top-1/2 z-[1] -translate-y-1/2 ${isSub ? 'left-[26px] size-6' : 'left-3 size-8'}`}
                  onClick={() => onToggle(row.pid)}
                  aria-label={`Expand / collapse ${isSub ? 'sub-project' : 'track'}`}
                  title={`Expand / collapse ${isSub ? 'sub-project' : 'track'}`}
                >
                  <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
                </Button>
                <Button
                  type="button"
                  data-lane-open={row.proj.id}
                  onClick={() => onScope(row.proj.id)}
                  className={`h-full min-w-0 flex-1 justify-start rounded-none border-0 pr-0 text-left ${isSub ? 'pl-[58px] text-base font-medium' : 'pl-[52px] text-md font-semibold'}`}
                  variant="ghost"
                >
                  <span className="truncate">{row.proj.name}</span>
                </Button>
                {remH > 0 && (
                  <HoverTooltip content={`${remH}h remaining on unfinished tasks`}>
                    <span className="[font-size:var(--fs-xs)] [color:var(--text-3)] !font-mono [white-space:nowrap]">
                      {remH}h
                    </span>
                  </HoverTooltip>
                )}
              </>
            ) : (
              <div
                style={{ opacity: fade }}
                className="h-full [display:flex] [align-items:center] [gap:8px] [flex:1] [min-width:0]"
              >
                <Button
                  type="button"
                  variant="ghost"
                  data-roadmap-task-open={row.issue.id}
                  onClick={() => onOpen(row.issue.id)}
                  title={row.issue.title}
                  className={`h-full min-w-0 flex-1 justify-start rounded-none border-0 pr-0 text-left text-base font-normal ${hasSubHeads ? 'pl-[44px]' : 'pl-[15px]'}`}
                >
                  <span className="truncate">{row.issue.title}</span>
                </Button>
                <AssigneeAvatar issue={row.issue} />
              </div>
            )}
          </div>
          {edgeColumn('before', edges.left)}
          {/* Preserve bar rings at week edges; clip beneath the sticky rail. */}
          <div
            style={{
              width: timelineW,
              height: h,
              opacity: fade,
              clipPath: `inset(0 -${BAR_RING}px 0 max(-${BAR_RING}px, calc(var(--roadmap-scroll-left, 0px) - ${GUTTER_W}px)))`,
            }}
            className="[position:relative]"
          >
            {renderGuides()}
            {/* The due hover strip stays below bars and inside the grid. */}
            {due && (
              <HoverTooltip content={`Due ${P.fmtISO(row.issue.due)} — ${due.state}`}>
                <div
                  style={{ left: Math.min(Math.max(due.x - 4, 0), timelineW - 8) }}
                  className="[position:absolute] [top:3px] [bottom:3px] [width:8px] [cursor:help]"
                />
              </HoverTooltip>
            )}
            {/* Committed row kind prevents ghost bars after remote unscheduling. */}
            {row.kind === 'task' && start != null && end >= w0 && start <= w1 && (
              <Bar
                it={row.issue}
                start={start}
                end={end}
                w0={w0}
                w1={w1}
                weekW={weekW}
                env={envelope}
                onSched={onSchedule}
                onCommit={onCommit}
                onOpen={onOpen}
                ring={ring}
              />
            )}
            {/* Due lines paint above bars without intercepting drag pointers. */}
            {due && (
              <div
                style={{
                  left: Math.min(Math.max(due.x - 1, 0), timelineW - 2),
                  background: due.color,
                }}
                className="[position:absolute] [top:0] [bottom:0] [width:2px] [opacity:0.85] [pointer-events:none] [z-index:1]"
              />
            )}
            {row.kind === 'unsched' &&
              (() => {
                // Clip long pills to the grid. Only the pill intercepts pointers.
                const it = row.issue
                const pc = P.delayColor(it) || 'var(--text-3)'
                return (
                  <div className="[position:absolute] [left:0] [right:0] [top:0] [bottom:0] [padding-left:8px] [overflow:clip] [display:flex] [align-items:center] [pointer-events:none]">
                    <Button
                      type="button"
                      onClick={() => onOpen(it.id)}
                      title={it.title}
                      style={{
                        border: `1px dashed color-mix(in oklab, ${pc} 53%, transparent)`,
                        background: `color-mix(in oklab, ${pc} 8%, transparent)`,
                      }}
                      className="[display:inline-flex] [align-items:center] [gap:8px] [height:20px] [padding:0_8px] [border-radius:var(--r-pill)] [color:var(--text-2)] [font-size:var(--fs-xs)] !font-mono [cursor:pointer] [white-space:nowrap] [pointer-events:auto]"
                      variant="unstyled"
                    >
                      <span>
                        unplanned
                        {it.due && (
                          <span
                            style={{
                              color:
                                it.due < P.TODAY_ISO && !P.isDone(it)
                                  ? 'var(--danger)'
                                  : 'var(--text-3)',
                            }}
                          >
                            , due {P.fmtISO(it.due)}
                          </span>
                        )}
                      </span>
                    </Button>
                  </div>
                )
              })()}
          </div>
          {edgeColumn('after', edges.right)}
        </>
      )}
    </div>
  )
}

// Local drag state recreates layout records, but unchanged rows keep their
// tooltip/popover trees. Workspace revisions still refresh permissions, dates
// and owner portraits. Guide identity covers everything renderGuides reads.
export const TimelineRow = memo(TimelineRowView, (before, after) => {
  if (
    before.row.kind !== after.row.kind ||
    before.row.pid !== after.row.pid ||
    before.row.proj !== after.row.proj ||
    before.row.issue !== after.row.issue
  )
    return false
  if (
    before.due?.x !== after.due?.x ||
    before.due?.color !== after.due?.color ||
    before.due?.state !== after.due?.state
  )
    return false
  return (Object.keys(after) as (keyof Props)[]).every(
    (key) =>
      key === 'row' ||
      key === 'due' ||
      key === 'renderGuides' ||
      Object.is(before[key], after[key]),
  )
})
