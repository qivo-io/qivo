import { memo, useState } from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { Icon, PausedMark, PriorityIcon, ProjectName } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import type { BoardCellGroup } from '@/lib/boardGroups'
import { type IssueVM, P, type ProjectPlace } from '@/store/planner'
import type { StoreVersion } from '@/store/updates'
import { BOARD_TASK_TYPE } from './board/dropOver'

type CardActions = {
  onOpen: (id: string) => void
  /** `source` is the dragged row, which the Board watches for leaving the page. */
  onDragStart: (id: string, source: HTMLElement) => void
  onDragEnd: () => void
  dragId: string | null
}

/** Delay is still a per-task exception, including inside a sibling group.
 * A neutral band names the state and ends in a block of the roadmap's
 * yellow or red carrying a clock (tokens.css, deviation #312). The Team sync
 * page draws the same banner on its rows. */
function DelayBanner({ it }: { it: IssueVM }) {
  if (!P.delayColor(it)) return null
  const behind = P.delayOf(it)?.status === 'behind'
  return (
    <span className="flex w-full items-stretch justify-between bg-[var(--delay-banner)] text-xs font-extrabold tracking-[.05em] text-text-1">
      <span className="px-2.5 py-1">{behind ? 'Slipping' : 'Delayed'}</span>
      <span
        className={`flex w-[30px] shrink-0 items-center justify-center text-white ${behind ? 'bg-[var(--delay-banner-behind-block)]' : 'bg-[var(--delay-banner-late-block)]'}`}
      >
        <Icon name="clock8" size={14} strokeWidth={2.4} />
      </span>
    </span>
  )
}

/* The paused mark stays visible on a faded card: a pause is a fact about the
   task, not a hover detail. The reason lives in the task's comments. */
function PausedGlyph({ it }: { it: IssueVM }) {
  if (!P.isPaused(it)) return null
  return (
    <HoverTooltip content="Paused">
      <PausedMark className="mt-0.5" />
    </HoverTooltip>
  )
}

function DueDate({ it, inButton = false }: { it: IssueVM; inButton?: boolean }) {
  if (!it.due) return null
  const overdue = it.due < P.TODAY_ISO && !P.isDone(it)
  const dueMiss = overdue || (P.tracksDelay(it) && P.delayOf(it)?.status === 'late')
  const warning = dueMiss && !P.delayColor(it)
  return (
    <HoverTooltip
      content={`Due ${P.fmtISO(it.due)}${overdue ? ', overdue' : dueMiss ? ', projected to be missed' : ''}`}
    >
      <span
        tabIndex={inButton ? -1 : 0}
        data-focus-key="due"
        className={`inline-flex items-center gap-1 whitespace-nowrap !font-mono text-xs ${warning ? 'font-semibold text-danger' : 'text-text-3'}`}
      >
        <Icon name="calendar" size={11} />
        {P.fmtISO(it.due)}
      </span>
    </HoverTooltip>
  )
}

/** Parent context uses a small inline portrait, leaving the larger right-hand
 * portrait exclusively for the child whose row can be moved independently.
 * A group's owner is always its assignee. */
function ParentHeading({ it, place }: { it: IssueVM; place: ProjectPlace | null }) {
  const owner = P.user(it.owner)
  return (
    <span className="flex w-full min-w-0 flex-col gap-2 p-2">
      <Button
        type="button"
        variant="unstyled"
        data-focus-key="parent"
        aria-label={`Parent: ${it.title}`}
        className="flex min-w-0 items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <PausedGlyph it={it} />
        <span className="min-w-0 break-words text-base font-semibold leading-[1.4] text-[var(--board-parent-text)]">
          {it.title}
        </span>
      </Button>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
        <HoverTooltip content={owner?.name || 'Unassigned'}>
          <span data-focus-key="owner-name" className="inline-flex min-w-0 items-center gap-1.5">
            <AssigneeAvatar issue={it} compact />
            <span className="truncate">{owner?.name.split(' ')[0] || 'Unassigned'}</span>
          </span>
        </HoverTooltip>
        <PriorityIcon priority={it.priority} size={11} />
        <DueDate it={it} />
      </span>
      {place && (
        <HoverTooltip content={P.placeLabel(place)}>
          <span data-focus-key="place" className="truncate text-xs text-text-2">
            <ProjectName {...place} />
          </span>
        </HoverTooltip>
      )}
    </span>
  )
}

/** The title button opens the task; the portrait is a separate control.
 * Repeated parent context opens details without becoming a draggable copy.
 * A child row (`indented`) spans the whole card and keeps the rail's 12px
 * gutter as its own padding, so its hover fill reaches the card's left edge. */
function TaskRow({
  it,
  place,
  parentHeader = false,
  actualIssue = true,
  indented = false,
  onOpen,
  onDragStart,
  onDragEnd,
  dragId,
}: CardActions & {
  it: IssueVM
  place: ProjectPlace | null
  parentHeader?: boolean
  actualIssue?: boolean
  indented?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const movable = actualIssue && !P.isGroup(it) && P.canWrite(it.project)
  const dragging = actualIssue && dragId === it.id
  const stale = actualIssue && P.isStale(it) && !hovered
  const remaining = parentHeader ? null : P.remainingOf(it)
  return (
    <div
      role="presentation"
      data-card={actualIssue ? it.id : undefined}
      data-parent-heading={parentHeader ? it.id : undefined}
      draggable={movable}
      onClick={() => onOpen(it.id)}
      onDragStart={(e) => {
        e.stopPropagation()
        if (!movable) {
          e.preventDefault()
          return
        }
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', it.id)
        e.dataTransfer.setData(BOARD_TASK_TYPE, it.id)
        onDragStart(it.id, e.currentTarget)
      }}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative flex w-full min-w-0 flex-col overflow-hidden border-0 bg-transparent text-left font-normal text-text-1 transition-[background-color,opacity] hover:bg-hover focus-within:opacity-100 ${indented ? 'pl-3' : ''} ${dragging ? 'opacity-40' : stale ? 'opacity-50' : 'opacity-100'}`}
    >
      <div
        className={`relative flex w-full min-w-0 flex-col ${movable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}`}
      >
        {actualIssue && <DelayBanner it={it} />}
        {parentHeader ? (
          <ParentHeading it={it} place={place} />
        ) : (
          <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_28px] items-center gap-x-2 p-2">
            <Button
              type="button"
              variant="unstyled"
              data-focus-key="title"
              aria-label={it.title}
              className="min-w-0 cursor-inherit text-left font-normal outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="flex min-w-0 items-start gap-2">
                <PausedGlyph it={it} />
                <span className="min-w-0 break-words text-base font-medium leading-[1.35]">
                  {it.title}
                </span>
              </span>
              <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
                <PriorityIcon priority={it.priority} size={11} />
                {remaining != null && (
                  <span className="whitespace-nowrap !font-mono">
                    {it.children.length ? 'Σ ' : ''}
                    {remaining}h
                  </span>
                )}
                {place && (
                  <HoverTooltip content={P.placeLabel(place)}>
                    <span tabIndex={-1} className="max-w-full truncate">
                      <ProjectName {...place} />
                    </span>
                  </HoverTooltip>
                )}
                <DueDate it={it} inButton />
                {!P.user(it.owner) && <span>Unassigned</span>}
              </span>
            </Button>
            <AssigneeAvatar issue={it} />
          </span>
        )}
      </div>
    </div>
  )
}

type BoardCardProps = CardActions & {
  group: BoardCellGroup<IssueVM>
  place: (issue: IssueVM) => ProjectPlace | null
  /** P.contextVersion, for what the rows read besides their tasks. */
  context: StoreVersion
  /** The ids of the card's tasks that are stale now (P.isStale), joined.
      Staleness follows the clock, so a task that crosses the age renders
      again although nothing else changed. */
  stale: string
}

function BoardCardView({
  group,
  place,
  context: _context,
  stale: _stale,
  ...actions
}: BoardCardProps) {
  // Repeated child project labels already name this shared project. Keep the
  // parent's label when it has no local children or belongs to another project.
  const parentPlace =
    group.parent &&
    !(group.issues.length > 0 && group.issues.every((it) => it.project === group.parent.project))
      ? place(group.parent)
      : null
  return (
    <div
      data-parent-card={group.parent?.id}
      className="board-card overflow-hidden rounded-md border border-border bg-surface-1 shadow-card transition-opacity duration-150 motion-reduce:transition-none"
    >
      {group.ancestors.map((ancestor) => (
        <TaskRow
          key={ancestor.uuid}
          it={ancestor}
          parentHeader
          actualIssue={false}
          place={place(ancestor)}
          {...actions}
        />
      ))}
      {group.parent && (
        <TaskRow
          it={group.parent}
          parentHeader
          actualIssue={false}
          place={parentPlace}
          {...actions}
        />
      )}
      <div className={group.parent && group.issues.length ? 'pb-2' : undefined}>
        {group.issues.map((it, index) => (
          // The rail and elbow sit in the row's 12px gutter and are lifted
          // above the row (an isolated stacking context) so the hover fill
          // spanning the card never covers them. The sibling separator stays
          // on the indented content, starting at the rail.
          <div
            key={it.uuid}
            data-child-row={group.parent ? it.id : undefined}
            className={
              group.parent
                ? `relative isolate before:pointer-events-none before:absolute before:top-0 before:left-3 before:z-[1] before:w-0.5 before:bg-[var(--board-hierarchy-line)] after:pointer-events-none after:absolute after:left-3 after:z-[1] after:h-px after:w-2 after:bg-[var(--board-hierarchy-line)] ${P.delayColor(it) ? 'after:top-[42px]' : 'after:top-[18px]'} ${index === group.issues.length - 1 ? (P.delayColor(it) ? 'before:h-[42px]' : 'before:h-[18px]') : 'before:bottom-0'} ${index > 0 ? '[&>div>div]:border-t [&>div>div]:border-border' : ''}`
                : undefined
            }
          >
            <TaskRow it={it} place={place(it)} indented={!!group.parent} {...actions} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The tasks a card shows, from its top heading down. */
const members = (group: BoardCellGroup<IssueVM>) => [
  ...group.ancestors,
  ...(group.parent ? [group.parent] : []),
  ...group.issues,
]
const samePlace = (a: ProjectPlace | null, b: ProjectPlace | null) =>
  a === b || (!!a && !!b && a.project === b.project && a.owner === b.owner)
/** The dragged task when this card holds it, the only drag a card shows. */
const ownDrag = (props: BoardCardProps) =>
  props.group.issues.some((it) => it.id === props.dragId) ? props.dragId : null

/* A board renders every card again on each store change. A card whose tasks
   are the same objects (P.issues keeps a task's object while it, its delay
   and its family stay the same), in the same places, with the same context,
   drag and stale tasks, renders the same, so it skips. Kanban keeps the
   callbacks' identity. */
const BoardCard = memo(BoardCardView, (before, after) => {
  const a = members(before.group)
  const b = members(after.group)
  return (
    before.group.key === after.group.key &&
    before.context === after.context &&
    before.stale === after.stale &&
    before.onOpen === after.onOpen &&
    before.onDragStart === after.onDragStart &&
    before.onDragEnd === after.onDragEnd &&
    ownDrag(before) === ownDrag(after) &&
    a.length === b.length &&
    a.every((it, i) => it === b[i] && samePlace(before.place(it), after.place(it)))
  )
})

export { BoardCard, DelayBanner }
