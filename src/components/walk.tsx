/* The pieces both person-by-person walks render: the weekly Update Estimate
   modal (src/panels/UpdateEstimate.tsx, hooks `data-ue-*`) and the Team sync
   page (src/views/TeamSync.tsx, hooks `data-sync-*`). One walk, two presets
   (docs/team-sync-brief.md): each piece takes the hook prefix of the walk it
   sits in, so drives keep telling the two apart. */
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { remainingPatchFromInput, remainingValue } from '@/lib/remaining'
import { cn } from '@/lib/utils'
import { type IssueVM, P, type UserVM } from '@/store/planner'
import { Avatar, Icon } from './qivo'

/** Which walk a piece sits in: its data hooks read `data-<hook>-…`. */
export type WalkHook = 'ue' | 'sync'

/* One data hook of a walk, e.g. `data-ue-jump="<profile uuid>"`. */
function hook(walk: WalkHook, name: string, value = '') {
  return { [`data-${walk}-${name}`]: value }
}

/** Review ticks: session-local, keyed by task uuid, stored nowhere. An edit
    ticks a row, the tick button toggles it. `count` intersects the caller's
    LIVE rows, so the total adjusts when a task leaves the walk. */
export function useReviewed() {
  const [set, setSet] = useState(() => new Set<string>())
  return {
    has: (uuid: string) => set.has(uuid),
    mark: (uuid: string) => setSet((s) => (s.has(uuid) ? s : new Set(s).add(uuid))),
    toggle: (uuid: string) =>
      setSet((s) => {
        const n = new Set(s)
        if (n.has(uuid)) n.delete(uuid)
        else n.add(uuid)
        return n
      }),
    count: (rows: readonly { uuid: string }[]) => rows.filter((it) => set.has(it.uuid)).length,
  }
}
export type Reviewed = ReturnType<typeof useReviewed>

/** Scheduled first by planned start week, then unscheduled by due date
    (undated last): the same per-track ordering the roadmap uses, so the
    list reads in "this week first" order. */
export function rowOrder(a: IssueVM, b: IssueVM) {
  if (a.start != null && b.start != null) return a.start - b.start
  if (a.start != null) return -1
  if (b.start != null) return 1
  return a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0
}

/** The plan in a row's meta line: `W40` or `W40–W41`, else `due 23 Sep`. */
export function planHint(it: IssueVM) {
  if (it.start != null) {
    const a = P.weekNumLabel(it.start),
      b = P.weekNumLabel(it.end)
    return a === b ? a : `${a}–${b}`
  }
  if (it.due) return `due ${P.fmtDate(P.isoToDate(it.due))}`
  return null
}

/** Blur a focused Remaining box of this walk so it commits: closing or
    stepping away unmounts the box, and React fires no blur on unmount, so a
    typed-but-uncommitted number would vanish. */
export function flushWalkInput(walk: WalkHook) {
  const el = document.activeElement
  if (el instanceof HTMLElement && el.hasAttribute(`data-${walk}-input`)) el.blur()
}

/** The person rail: jump anywhere, the current person ringed, a check on
    everyone whose rows are all ticked. `lead` renders before the people (the
    sync's team button); `gapAt` opens a gap before that index (the sync's
    agents). */
export function WalkRail({
  hook: walk,
  people,
  isCurrent,
  allDone,
  onPick,
  label,
  lead,
  gapAt,
  className,
}: {
  hook: WalkHook
  people: readonly Pick<UserVM, 'id' | 'name'>[]
  isCurrent: (id: string) => boolean
  allDone: (id: string) => boolean
  onPick: (id: string, index: number) => void
  /** the button's accessible name, from the person's name */
  label: (name: string) => string
  lead?: ReactNode
  gapAt?: number
  className?: string
}) {
  return (
    <div
      {...hook(walk, 'rail')}
      className={cn(
        '[display:flex] [gap:4px] [flex-wrap:wrap] [justify-content:flex-end]',
        className,
      )}
    >
      {lead}
      {people.map((u, i) => (
        <Button
          type="button"
          key={u.id}
          {...hook(walk, 'jump', u.id)}
          onClick={() => onPick(u.id, i)}
          title={u.name}
          aria-label={label(u.name)}
          aria-current={isCurrent(u.id) ? 'true' : undefined}
          className={cn(
            'relative grid size-8 shrink-0 place-items-center p-0 border-none bg-transparent cursor-pointer rounded-sm aria-[current=true]:shadow-[0_0_0_2px_var(--primary)]',
            i > 0 && i === gapAt && 'ml-2',
          )}
          variant="unstyled"
        >
          <Avatar id={u.id} size={28} />
          {/* the done badge's ring knocks it out of whatever it sits on: the
              dialog card in the Estimates walk (#77), the page panel in the sync */}
          {allDone(u.id) && (
            <span
              {...hook(walk, 'done', u.id)}
              className="[position:absolute] [right:-2px] [bottom:-2px] [width:11px] [height:11px] [border-radius:50%] [background:var(--success)] [border:1.5px_solid_var(--background)] [display:grid] [place-items:center]"
            >
              <Icon name="check" size={7} color="#fff" strokeWidth={3.5} />
            </span>
          )}
        </Button>
      ))}
    </div>
  )
}

/** A task's Remaining box. Uncontrolled, but the key folds in the STORE
    value: typing never remounts (the store hasn't moved), while a remote
    edit or a rollback replaces the node, so the box can never keep showing a
    number the server doesn't hold, and a later blur can't write that stale
    number back over the newer one. A walk exists to make the field true; it
    must not be the surface that quietly undoes someone else's edit.
    Commits on blur or Enter with the details pane's rule (lib/remaining):
    empty = unset, a stored 0 is a value, unparseable or unchanged text writes
    nothing, so a bare tab-through is not an edit. `onCommit` runs after a
    write. */
export function RemainingInput({
  hook: walk,
  it,
  title,
  onCommit,
  disabled,
  className,
}: {
  hook: WalkHook
  it: IssueVM
  title: string
  onCommit?: (it: IssueVM) => void
  disabled?: boolean
  className?: string
}) {
  // takes the ELEMENT, not its value: the parse verdict (validity.badInput)
  // only exists on the element, and without it unparseable text arrives as ""
  // and reads as a deliberate clear
  const commit = (el: HTMLInputElement) => {
    const p = remainingPatchFromInput(el, it.remaining)
    if (!p.write) return
    P.updateIssue(it.id, { remaining: p.value })
    onCommit?.(it)
  }
  return (
    <Input
      {...hook(walk, 'input')}
      aria-label={`Remaining hours for ${it.title}`}
      type="number"
      min="0"
      placeholder="—"
      key={`${it.uuid}:${it.remaining != null ? it.remaining : ''}`}
      defaultValue={remainingValue(it.remaining)}
      title={title}
      disabled={disabled}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      onBlur={(e) => commit(e.target)}
      className={cn('h-control w-15 shrink-0 bg-surface-1 px-2 py-0 text-sm !font-mono', className)}
    />
  )
}

/** The review tick: marks a row looked at without an edit. */
export function ReviewTick({
  hook: walk,
  it,
  on,
  onToggle,
  markTitle = 'Mark reviewed without changing hours',
}: {
  hook: WalkHook
  it: IssueVM
  on: boolean
  onToggle: () => void
  markTitle?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      {...hook(walk, 'tick', it.id)}
      {...hook(walk, 'reviewed', on ? '1' : '0')}
      aria-label={`${on ? 'Unmark' : 'Mark'} ${it.title} as reviewed`}
      aria-pressed={on}
      onClick={onToggle}
      className="w-control-sm h-control-sm [flex-shrink:0]"
      title={on ? 'Unmark reviewed' : markTitle}
    >
      <Icon
        name="check"
        size={16}
        color={on ? 'var(--success)' : 'var(--text-3)'}
        strokeWidth={on ? 2.75 : 2}
      />
    </Button>
  )
}

/** The walk's foot: "n of m tasks reviewed", Previous, Next or Done. The
    caller supplies the row it sits in. */
export function WalkFooter({
  hook: walk,
  reviewed,
  total,
  showPrev,
  atStart,
  last,
  onPrev,
  onNext,
}: {
  hook: WalkHook
  reviewed: number
  total: number
  showPrev: boolean
  atStart: boolean
  /** the last step: Next reads Done */
  last: boolean
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <>
      <span {...hook(walk, 'progress')} className="[font-size:var(--fs-sm)] [color:var(--text-1)]">
        {total ? `${reviewed} of ${total} task${total === 1 ? '' : 's'} reviewed` : ''}
      </span>
      <div className="[flex:1]" />
      {showPrev && (
        <Button
          type="button"
          variant="ghost"
          {...hook(walk, 'prev')}
          disabled={atStart}
          onClick={onPrev}
          className={atStart ? 'cursor-default opacity-40' : undefined}
        >
          <Icon name="chevronLeft" size={16} />
          Previous
        </Button>
      )}
      <Button
        type="button"
        {...hook(walk, 'next')}
        onClick={onNext}
        className="[background:var(--primary)] [border-color:var(--primary)] [color:#fff] [font-weight:600]"
      >
        {last ? (
          <>
            <Icon name="check" size={16} />
            Done
          </>
        ) : (
          <>
            Next
            <Icon name="chevronRight" size={16} />
          </>
        )}
      </Button>
    </>
  )
}
