/* The pieces of Team sync's person-by-person walk (src/views/TeamSync.tsx,
   deviation #316). Their data hooks read `data-sync-*`, which
   scripts/smoke.mjs, scripts/phone-layout-smoke.mjs and the tests select. */
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useFieldUnsaved } from '@/lib/leaveGuard'
import { remainingPatchFromInput, remainingValue } from '@/lib/remaining'
import { cn } from '@/lib/utils'
import { type IssueVM, P, type UserVM } from '@/store/planner'
import { LIMITS } from '../../convex/lib/limits'
import { Avatar, Icon } from './qivo'

/* One data hook of the walk, e.g. `data-sync-jump="<profile uuid>"`. */
function hook(name: string, value = '') {
  return { [`data-sync-${name}`]: value }
}

/** The person rail: jump anywhere, the current person ringed, a check on
    everyone whose rows are all ticked. `lead` renders before the people (the
    sync's team button); `gapAt` opens a gap before that index (the sync's
    agents). */
export function WalkRail({
  people,
  isCurrent,
  allDone,
  onPick,
  label,
  lead,
  gapAt,
  className,
}: {
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
      {...hook('rail')}
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
          {...hook('jump', u.id)}
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
          {/* the done badge's ring knocks it out of the page panel it sits on */}
          {allDone(u.id) && (
            <span
              {...hook('done', u.id)}
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
    nothing, so a bare tab-through is not an edit. `onCommit` runs once the
    server accepts the write, so a refused value (whose refusal the store
    shows) leaves the row unreviewed. `readOnly`, Team sync's stale
    meeting, keeps what was typed in the box and writes nothing, also on a
    blur, so the hours stay typed until the box writes again, and holds the
    unsaved lease as paused edits do, so a move away still asks first. */
export function RemainingInput({
  it,
  title,
  onCommit,
  disabled,
  readOnly = false,
  className,
}: {
  it: IssueVM
  title: string
  onCommit?: (it: IssueVM) => void
  disabled?: boolean
  readOnly?: boolean
  className?: string
}) {
  // takes the ELEMENT, not its value: the parse verdict (validity.badInput)
  // only exists on the element, and without it unparseable text arrives as ""
  // and reads as a deliberate clear
  // the hours typed and not yet saved, kept past a blur that sends nothing
  const unsaved = useFieldUnsaved(
    () => readOnly || P.editsPaused(),
    `${it.uuid}:${it.remaining ?? ''}`,
    'remaining hours',
  )
  const commit = (el: HTMLInputElement) => {
    if (readOnly) return
    const p = remainingPatchFromInput(el, it.remaining)
    if (!p.write) return
    void P.updateIssue(it.id, { remaining: p.value }).then((saved) => {
      if (saved) onCommit?.(it)
    })
  }
  return (
    <Input
      {...hook('input')}
      aria-label={`Remaining hours for ${it.title}`}
      type="number"
      min={LIMITS.remainingHours.min}
      max={LIMITS.remainingHours.max}
      placeholder="—"
      key={`${it.uuid}:${it.remaining != null ? it.remaining : ''}`}
      defaultValue={remainingValue(it.remaining)}
      title={title}
      disabled={disabled}
      readOnly={readOnly}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      {...unsaved}
      onBlur={(e) => commit(e.target)}
      className={cn('h-control w-15 shrink-0 bg-surface-1 px-2 py-0 text-sm !font-mono', className)}
    />
  )
}

/** The review tick: marks a row looked at without an edit. */
export function ReviewTick({
  it,
  on,
  onToggle,
}: {
  it: IssueVM
  on: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      {...hook('tick', it.id)}
      {...hook('reviewed', on ? '1' : '0')}
      aria-label={`${on ? 'Unmark' : 'Mark'} ${it.title} as reviewed`}
      aria-pressed={on}
      onClick={onToggle}
      className="w-control-sm h-control-sm [flex-shrink:0]"
      title={on ? 'Unmark reviewed' : 'Mark reviewed'}
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
  reviewed,
  total,
  atStart,
  last,
  onPrev,
  onNext,
}: {
  reviewed: number
  total: number
  atStart: boolean
  /** the last step: Next reads Done */
  last: boolean
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <>
      <span {...hook('progress')} className="[font-size:var(--fs-sm)] [color:var(--text-1)]">
        {total ? `${reviewed} of ${total} task${total === 1 ? '' : 's'} reviewed` : ''}
      </span>
      <div className="[flex:1]" />
      <Button
        type="button"
        variant="ghost"
        {...hook('prev')}
        disabled={atStart}
        onClick={onPrev}
        className={atStart ? 'cursor-default opacity-40' : undefined}
      >
        <Icon name="chevronLeft" size={16} />
        Previous
      </Button>
      <Button
        type="button"
        {...hook('next')}
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
