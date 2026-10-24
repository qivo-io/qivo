import { memo, useId, useRef } from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { PausedMark } from '@/components/qivo'
import {
  hoverTooltip,
  priorityIcon,
  projectName,
  staticOwnerPortrait,
} from '@/components/rowElements'
import { buttonElement } from '@/components/ui/button-element'
import { HoverTooltip } from '@/components/ui/tooltip'
import type { BoardCellGroup } from '@/lib/boardGroups'
import { clampedTitleTip } from '@/lib/clampedTitle'
import { type StaticControls, StaticControlsContext, useLiveControls } from '@/lib/liveControls'
import { type IssueVM, P, type ProjectPlace } from '@/store/planner'
import type { StoreVersion } from '@/store/updates'
import { parentPlaceOf } from './board/cardEstimate'
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
 * yellow or red carrying a clock (tokens.css, deviation #312), the band's
 * ::after (styles/glyphs.css), so a card's banner is one element. The Team
 * sync page draws the same banner on its rows. */
function DelayBanner({ it, id }: { it: IssueVM; id?: string }) {
  if (!P.delayColor(it)) return null
  const behind = P.delayOf(it)?.status === 'behind'
  return (
    <span
      id={id}
      data-delay={behind ? 'behind' : 'late'}
      className="delay-banner block w-full bg-[var(--delay-banner)] py-1 pr-10 pl-2.5 text-xs font-extrabold tracking-[.05em] text-text-1"
    >
      {behind ? 'Slipping' : 'Delayed'}
    </span>
  )
}

/* The paused mark stays visible on a faded card: a pause is a fact about the
   task, not a hover detail. The reason lives in the task's comments. Render
   it for a paused task only. */
function PausedGlyph({ id }: { id?: string }) {
  return (
    <HoverTooltip content="Paused">
      <PausedMark className="mt-0.5" id={id} />
    </HoverTooltip>
  )
}

/* A Board renders thousands of cards, and every component a card mounts
   adds to mounting the Board and to leaving it. So the parts every card
   shows are elements that its rows build in the card's static scope
   (`statics`, liveControls.tsx), as rowElements.tsx does, not components
   of their own. */

/** The owner's portrait, which opens the owner picker. */
const ownerPortrait = (statics: StaticControls | null, it: IssueVM, compact = false) =>
  statics ? (
    staticOwnerPortrait(statics, it, compact)
  ) : (
    <AssigneeAvatar issue={it} compact={compact} />
  )

/** The due date, its state in the hover text. Inside the title's button
    (`inButton`) it takes no tab stop. The calendar glyph is the span's
    ::before (styles/glyphs.css). */
function dueDate(statics: StaticControls | null, it: IssueVM, inButton = false) {
  if (!it.due) return null
  const overdue = it.due < P.TODAY_ISO && !P.isDone(it)
  const dueMiss = overdue || (P.tracksDelay(it) && P.delayOf(it)?.status === 'late')
  const warning = dueMiss && !P.delayColor(it)
  return hoverTooltip(
    statics,
    `Due ${P.fmtISO(it.due)}${overdue ? ', overdue' : dueMiss ? ', projected to be missed' : ''}`,
    <span
      tabIndex={inButton ? -1 : 0}
      data-focus-key="due"
      className={`due-date inline-flex items-center gap-1 whitespace-nowrap !font-mono text-xs ${warning ? 'font-semibold text-danger' : 'text-text-3'}`}
    >
      {P.fmtISO(it.due)}
    </span>,
  )
}

/** A card title clamped to four lines. Only a title long enough to be cut
    gets a tooltip with its whole text, so a card adds no tooltip root for a
    short title. The span takes no tab stop: its button already names the
    whole title. */
function clampedTitle(statics: StaticControls | null, title: string, className: string) {
  const tip = clampedTitleTip(title)
  const text = (
    <span tabIndex={tip ? -1 : undefined} className={className}>
      {title}
    </span>
  )
  return tip ? hoverTooltip(statics, tip, text) : text
}

/** Parent context uses a small inline portrait, leaving the larger right-hand
 * portrait exclusively for the child whose row can be moved independently.
 * A group's owner is always its assignee. */
function ParentHeading({
  it,
  place,
  statics,
}: {
  it: IssueVM
  place: ProjectPlace | null
  statics: StaticControls | null
}) {
  const owner = P.user(it.owner)
  /* A screen reader hears the owner, priority and due date after the title,
     in plain words: the meta row holds the owner button, whose name repeats
     the title. A parent is never paused (P.isPaused). */
  const meta = useId()
  const summary = [
    owner?.name || 'Unassigned',
    `${P.PRIORITIES[it.priority]?.name ?? ''} priority`,
    it.due && `due ${P.fmtISO(it.due)}`,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <span className="flex w-full min-w-0 flex-col gap-2 p-2">
      {buttonElement({
        type: 'button',
        variant: 'unstyled',
        'data-focus-key': 'parent',
        'aria-label': `Parent: ${it.title}`,
        'aria-describedby': meta,
        className:
          'flex min-w-0 items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary',
        children: (
          <>
            {P.isPaused(it) && <PausedGlyph />}
            {clampedTitle(
              statics,
              it.title,
              'line-clamp-4 min-w-0 break-words text-base font-semibold leading-[1.4] text-[var(--board-parent-text)]',
            )}
          </>
        ),
      })}
      <span id={meta} className="sr-only">
        {summary}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
        {hoverTooltip(
          statics,
          owner?.name || 'Unassigned',
          <span data-focus-key="owner-name" className="inline-flex min-w-0 items-center gap-1.5">
            {ownerPortrait(statics, it, true)}
            <span className="truncate">{owner?.name.split(' ')[0] || 'Unassigned'}</span>
          </span>,
        )}
        {priorityIcon(statics, it.priority, 11)}
        {dueDate(statics, it)}
      </span>
      {place &&
        hoverTooltip(
          statics,
          P.placeLabel(place),
          <span data-focus-key="place" className="truncate text-xs text-text-2">
            {projectName(place)}
          </span>,
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
  statics,
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
  /** The card's static scope, null once it is live. */
  statics: StaticControls | null
  parentHeader?: boolean
  actualIssue?: boolean
  indented?: boolean
}) {
  const movable = actualIssue && !P.isGroup(it) && P.canWrite(it.project)
  const dragging = actualIssue && dragId === it.id
  const stale = actualIssue && P.isStale(it)
  const remaining = parentHeader ? null : P.remainingOf(it)
  /* The title is the row's name. A screen reader hears the delay, the pause
     and the meta row (priority, hours, place, due date, owner) after it. */
  const ids = useId()
  const banner = actualIssue && !!P.delayColor(it)
  const paused = P.isPaused(it)
  const describedBy = [banner && `${ids}delay`, paused && `${ids}paused`, `${ids}meta`]
    .filter(Boolean)
    .join(' ')
  const title = clampedTitle(
    statics,
    it.title,
    'line-clamp-4 min-w-0 break-words text-base font-medium leading-[1.35]',
  )
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
      className={`relative flex w-full min-w-0 flex-col overflow-hidden border-0 bg-transparent text-left font-normal text-text-1 transition-[background-color,opacity] hover:bg-hover focus-within:opacity-100 ${indented ? 'pl-3' : ''} ${dragging ? 'opacity-40' : stale ? 'opacity-50 hover:opacity-100 has-[[aria-expanded=true]]:opacity-100' : 'opacity-100'}`}
    >
      <div
        className={`relative flex w-full min-w-0 flex-col ${movable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}`}
      >
        {banner && <DelayBanner it={it} id={`${ids}delay`} />}
        {parentHeader ? (
          <ParentHeading it={it} place={place} statics={statics} />
        ) : (
          // a row, not a grid: a grid keeps its track sizes per card, which
          // a Board of thousands of cards holds megabytes of
          <span className="flex w-full min-w-0 items-center gap-x-2 p-2">
            {buttonElement({
              type: 'button',
              variant: 'unstyled',
              'data-focus-key': 'title',
              'aria-label': it.title,
              'aria-describedby': describedBy,
              className:
                'min-w-0 flex-1 cursor-inherit text-left font-normal outline-none focus-visible:ring-2 focus-visible:ring-primary',
              children: (
                <>
                  {/* the paused mark sits before the title, in a row of
                     their own; a title alone needs no row */}
                  {paused ? (
                    <span className="flex min-w-0 items-start gap-2">
                      <PausedGlyph id={`${ids}paused`} />
                      {title}
                    </span>
                  ) : (
                    title
                  )}
                  <span
                    id={`${ids}meta`}
                    className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3"
                  >
                    {priorityIcon(statics, it.priority, 11)}
                    {remaining != null && (
                      // one text node
                      <span className="whitespace-nowrap !font-mono">
                        {`${it.children.length ? 'Σ ' : ''}${remaining}h`}
                      </span>
                    )}
                    {place &&
                      hoverTooltip(
                        statics,
                        P.placeLabel(place),
                        <span tabIndex={-1} className="max-w-full truncate">
                          {projectName(place)}
                        </span>,
                      )}
                    {dueDate(statics, it, true)}
                    {!P.user(it.owner) && <span>Unassigned</span>}
                  </span>
                </>
              ),
            })}
            {ownerPortrait(statics, it)}
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
  const parentPlace = parentPlaceOf(group, place)
  // The card mounts no tooltip or popover roots until it is used.
  const root = useRef<HTMLDivElement>(null)
  const controls = useLiveControls(root)
  return (
    // biome-ignore lint/a11y/useSemanticElements: one item of its status cell's list (Kanban), a styled div that drags
    <div
      ref={root}
      {...controls.rootProps}
      role="listitem"
      data-parent-card={group.parent?.id}
      className="board-card overflow-hidden rounded-md border border-border bg-surface-1 shadow-card transition-opacity duration-150 motion-reduce:transition-none"
    >
      <StaticControlsContext.Provider value={controls.value}>
        {group.parent ? (
          <>
            {group.ancestors.map((ancestor) => (
              <TaskRow
                key={ancestor.uuid}
                it={ancestor}
                parentHeader
                actualIssue={false}
                place={place(ancestor)}
                statics={controls.value}
                {...actions}
              />
            ))}
            <TaskRow
              it={group.parent}
              parentHeader
              actualIssue={false}
              place={parentPlace}
              statics={controls.value}
              {...actions}
            />
            <div className={group.issues.length ? 'pb-2' : undefined}>
              {group.issues.map((it, index) => (
                // The rail and elbow sit in the row's 12px gutter and are lifted
                // above the row (an isolated stacking context) so the hover fill
                // spanning the card never covers them. The sibling separator stays
                // on the indented content, starting at the rail.
                <div
                  key={it.uuid}
                  data-child-row={it.id}
                  className={`relative isolate before:pointer-events-none before:absolute before:top-0 before:left-3 before:z-[1] before:w-0.5 before:bg-[var(--board-hierarchy-line)] after:pointer-events-none after:absolute after:left-3 after:z-[1] after:h-px after:w-2 after:bg-[var(--board-hierarchy-line)] ${P.delayColor(it) ? 'after:top-[42px]' : 'after:top-[18px]'} ${index === group.issues.length - 1 ? (P.delayColor(it) ? 'before:h-[42px]' : 'before:h-[18px]') : 'before:bottom-0'} ${index > 0 ? '[&>div>div]:border-t [&>div>div]:border-border' : ''}`}
                >
                  <TaskRow
                    it={it}
                    place={place(it)}
                    statics={controls.value}
                    indented
                    {...actions}
                  />
                </div>
              ))}
            </div>
          </>
        ) : (
          /* a card of its own is its task's row alone, without the wrappers
             a parent's subtasks need, nor a list's: thousands of cards render
             on a Board. A group without a parent holds its one task
             (createCellGrouper). */
          <TaskRow
            key={group.issues[0].uuid}
            it={group.issues[0]}
            place={place(group.issues[0])}
            statics={controls.value}
            {...actions}
          />
        )}
      </StaticControlsContext.Provider>
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
