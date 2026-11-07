import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Avatar, Icon, Popover } from '@/components/qivo'
import {
  OWNER_WRAP,
  ownerTrigger,
  PORTRAIT_CLASS,
  portraitFace,
  WAITS_FOR_SAVE,
} from '@/components/rowElements'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DropdownChevron } from '@/components/ui/select'
import { restoreFocus } from '@/lib/focusVisibility'
import { listEnd, usePagedList, useSettledSearch } from '@/lib/pagedList'
import { PICKER_CAPS } from '@/lib/pickerCaps'
import { cn } from '@/lib/utils'
import {
  type IssueVM,
  type OwnerChecks,
  type OwnerChoice,
  type OwnerChoices,
  P,
} from '@/store/planner'
import { LIMITS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import { keepOwnerName, useOwnerNames } from './ownerNames'
import { CommandChoiceEnd } from './pickerParts'
import { escapeClearsFirst, OWNER_WORDS, REVIEWER_WORDS } from './pickerWords'

export type OwnerField = 'assignee' | 'reviewer'

/** The data attribute of an owner list's search box, which Escape clears
    before it closes the list (escapeClearsFirst). */
const OWNER_SEARCH = 'data-owner-search'

/** The value of the Unassigned or No reviewer row, which no id takes. */
const NONE = '\u0000none'

/** The task an owner list writes: the workspace's, a view's answer's, or
    the one the task window shows from its own answer. */
const liveTask = (id: string) => P.anyTask(id) ?? P.taskShown(id)

/** The 28 px face of person `id` beside their name: the store's portrait,
    or a plain square while the store does not hold them, which never reads
    as Unassigned. */
function OwnerFace({ id }: { id: string }) {
  if (P.user(id)) return <Avatar id={id} size={28} />
  return <span aria-hidden="true" className="size-7 shrink-0 rounded-[5px] bg-surface-3" />
}

/** The people behind every owner control, as a list the server answers:
 * the people who could become the task's assignee or reviewer
 * (pickers.taskOwners through P.ownerChoices), 25 a batch, read once each
 * while the list is open and never before, with the server's search, Load
 * more and at most PICKER_CAPS.owners people kept. The browser filters,
 * sorts and adds no person.
 *
 * "Unassigned" or "No reviewer" comes first, apart from the batches and
 * never counted in the cap; under a search it shows only when its own
 * label holds every typed word. The current holder comes next, checked,
 * named by a batch's row, by the one pickers.canOwn check the list sends
 * with its first batch, or by the store's or useOwnerNames' name, and
 * shown under a search only when that name holds every typed word. A
 * holder the check answers not eligible, or as a person the organization
 * does not hold, reads disabled with a note; a check that failed or could
 * not finish leaves the holder named and checked with no note. Then the
 * batches' rows, each id once, the holder left out.
 *
 * Rows of an older text read dimmed and take no pick until the answer for
 * the typed text lands, which moves the highlight to its first row; Enter
 * acts only then. Load more moves the highlight to the first new row.
 * A held, refused, unavailable, over-budget, stopped or failed list says
 * so in the field's words (CommandChoiceEnd), never as an empty or ended
 * list; a refused or unavailable list also disables its clear row, which
 * the write would refuse.
 *
 * Picking writes `field` when the pick changes it through P.updateIssue,
 * whose refusal toasts the server's sentence and is the only check of the
 * person, then calls `onPick` once the server saves it. Without `field`
 * it writes the live task's owner field, re-read at the pick: a status
 * move while the list was open can hand the task between assignee and
 * reviewer, which also lists that field's people. `onClose` runs on every
 * accepted pick, changed or not, and is handed the write as `then`, to
 * run once the list has closed (see useMenuBackLayer). `off` says why the
 * list may no longer write, such as Team sync's stale meeting. Given it,
 * its rows, Load more and Try again read disabled with that title and
 * write nothing, also a pick made before the list closes, and the list
 * closes at once through `onClose`, also one that was open before `off`
 * came. */
export function OwnerPickList({
  issue,
  field,
  onClose,
  onPick,
  off,
}: {
  issue: IssueVM
  field?: OwnerField
  onClose: (then: () => void) => void
  onPick?: (profileId: string | null) => void
  off?: string
}) {
  const shown = field ?? issue.ownerField
  const holder = issue[shown] || null
  const none = shown === 'reviewer' ? 'No reviewer' : 'Unassigned'
  const find = shown === 'reviewer' ? 'Find a reviewer' : 'Find an assignee'
  const words = shown === 'reviewer' ? REVIEWER_WORDS : OWNER_WORDS
  const task = { uuid: issue.uuid, org: issue.org }
  // an open list closes as soon as it may no longer write
  const closes = !!off
  useEffect(() => {
    if (closes) onClose(() => {})
  }, [closes])

  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const typed = search.typed
  const query = search.settled
  const listKey = `${issue.org}\n${issue.uuid}\n${shown}\n${query}`
  const list = usePagedList<OwnerChoices, OwnerChoice>({
    key: listKey,
    source: {
      kind: 'once',
      read: (at) => P.ownerChoices({ task, field: shown, search: query, cursor: at.after }),
    },
    batch: (answer) => (answer.state === 'ready' ? answer : null),
    id: (row) => row.id,
    most: PICKER_CAPS.owners,
  })
  // the list the paged list opened, which it opens after the render that
  // names a new one, so that render never takes an older text's rows as
  // this text's answer
  const opened = useRef<string | null>(null)
  useEffect(() => {
    opened.current = listKey
  })
  const answered =
    !search.tooLong && query === typed && opened.current === listKey && list.phase !== 'first'

  // The holder's one check, sent with the first batch, and once for each
  // other holder or field while the list stays open. An answer after the
  // close changes nothing, as the list is gone.
  const [checks, setChecks] = useState<ReadonlyMap<string, OwnerChecks | null>>(() => new Map())
  const checkKey = holder ? `${shown}\n${holder}` : null
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (checkKey === null || holder === null || asked.current.has(checkKey)) return
    asked.current.add(checkKey)
    void P.ownerChecks({ task, field: shown, ids: [holder] }).then((answer) => {
      if (answer?.state === 'ready')
        for (const row of answer.rows) if (row.person) keepOwnerName(issue.org, row.person)
      setChecks((was) => new Map(was).set(checkKey, answer))
    })
  }, [checkKey])
  const checkAnswer = checkKey === null ? undefined : checks.get(checkKey)
  const checkRow = checkAnswer?.state === 'ready' ? checkAnswer.rows[0] : undefined
  const [holderName] = useOwnerNames(issue.org, holder ? [holder] : [])
  const batchHolder = holder ? list.rows.find((row) => row.id === holder) : undefined
  const holderLabel =
    batchHolder?.name ??
    checkRow?.person?.name ??
    (holderName?.state === 'ok' ? holderName.name : null)
  // a batch's row says the holder may be chosen; only the check's answer
  // marks one who may not
  const ineligible = !batchHolder && checkRow !== undefined && !checkRow.eligible

  const matches = allWordsMatcher(nameKey(typed))
  const showNone = typed === '' || matches(nameKey(none))
  const showHolder =
    holder !== null && (typed === '' || (holderLabel !== null && matches(nameKey(holderLabel))))
  const stale = !answered
  const people = list.rows.filter((row) => row.id !== holder)
  const first = list.answers[0]
  // the write refuses a clear on a task the list could not open
  const closed =
    list.phase === 'held' && (first?.state === 'refused' || first?.state === 'unavailable')
  const end = answered ? listEnd(list, query !== '') : 'loading'

  // the highlighted row, which the answer for the typed text moves to its
  // first row, and Load more to the first new row
  const [value, setValue] = useState('')
  const firstValue = () =>
    showNone && !closed
      ? NONE
      : showHolder && !ineligible && holder
        ? holder
        : (people[0]?.id ?? '')
  const highlighted = useRef<string | null>(null)
  useEffect(() => {
    if (!answered || highlighted.current === listKey) return
    highlighted.current = listKey
    setValue(firstValue())
  })
  const input = useRef<HTMLInputElement>(null)
  const from = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (from.current === null || list.phase === 'more') return
    const at = from.current
    from.current = null
    const row =
      list.phase === 'ready' ? list.rows.slice(at).find((r) => r.id !== holder) : undefined
    if (row) setValue(row.id)
    restoreFocus(input.current)
  })
  const more = () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }

  const pick = (person: { id: string; name: string } | null) => {
    if (off) return
    const live = liveTask(issue.id)
    if (!live || !P.canWrite(live.project)) return
    if (person) keepOwnerName(issue.org, { id: person.id, name: person.name, active: true })
    const id = person?.id ?? null
    onClose(() => {
      const now = liveTask(issue.id)
      if (!now) return
      const f = field ?? now.ownerField
      if ((now[f] || null) === id) return
      void P.updateIssue(issue.id, f === 'reviewer' ? { reviewer: id } : { assignee: id }).then(
        (saved) => {
          if (saved) onPick?.(id)
        },
      )
    })
  }
  const rowClass = 'gap-2 py-2'
  return (
    <Command
      aria-label={`Choose ${shown}`}
      shouldFilter={false}
      value={value}
      onValueChange={setValue}
      onClick={(event) => event.stopPropagation()}
      data-owner-list={shown}
      data-picker-state={stale ? 'loading' : list.phase}
      aria-busy={stale || list.phase === 'more' || undefined}
    >
      <CommandInput
        ref={input}
        value={text}
        onValueChange={setText}
        placeholder={`${find}…`}
        aria-label={find}
        {...{ [OWNER_SEARCH]: '' }}
        onKeyDown={(event) => {
          // Enter acts only on the answer for the typed text
          if (event.key === 'Enter' && stale) event.preventDefault()
          // the popover stays open for this Escape (escapeClearsFirst)
          if (event.key === 'Escape' && text !== '') setText('')
        }}
      />
      <CommandList className="max-h-60">
        {showNone && (
          <CommandItem
            value={NONE}
            disabled={closes || closed}
            title={off}
            onSelect={() => pick(null)}
            className={cn(rowClass, holder === null && 'font-semibold')}
          >
            <Avatar id={null} size={28} />
            <span className="min-w-0 flex-1 truncate">{none}</span>
            {holder === null && (
              <Icon name="check" size={16} strokeWidth={2} color="var(--muted-foreground)" />
            )}
          </CommandItem>
        )}
        {showHolder && holder && (
          <CommandItem
            value={holder}
            data-owner-holder=""
            disabled={closes || ineligible}
            title={off}
            onSelect={() => pick({ id: holder, name: holderLabel ?? '' })}
            // the chosen person reads like a chosen dropdown row (deviation #326)
            className={cn(rowClass, 'font-semibold')}
          >
            <OwnerFace id={holder} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {holderLabel ??
                  (holderName?.state === 'failed' ? "Couldn't load this person" : 'Loading…')}
              </span>
              {ineligible && (
                <span data-owner-ineligible="" className="block text-sm font-normal text-text-2">
                  {shown === 'reviewer'
                    ? 'Can no longer review this task'
                    : 'Can no longer take this task'}
                </span>
              )}
            </span>
            <Icon name="check" size={16} strokeWidth={2} color="var(--muted-foreground)" />
          </CommandItem>
        )}
        {people.map((person) => (
          <CommandItem
            key={person.id}
            value={person.id}
            data-owner-choice={person.id}
            disabled={closes || stale}
            title={off}
            onSelect={() => pick(person)}
            className={rowClass}
          >
            <OwnerFace id={person.id} />
            <span className="min-w-0 flex-1 truncate">{person.name}</span>
          </CommandItem>
        ))}
        <CommandChoiceEnd
          end={end}
          tooLong={search.tooLong}
          list={list}
          words={words}
          onMore={more}
          off={off}
        />
      </CommandList>
    </Command>
  )
}

/** The task window's Assignee or Reviewer field (`field`) of `issue`: a
 * button in FieldSelect's look, marked data-fieldselect with `aria-label`
 * "Assignee" or "Reviewer", that opens the shared owner list
 * (OwnerPickList) in a popover. It names the holder by face and name
 * through useOwnerNames, "Loading…" while the name is on its way, "Couldn't
 * load this person" after a failed read (the list still opens), and
 * "Unassigned" or "No reviewer" only with no holder or for an answer that
 * says the organization does not hold them, so a holder not loaded never
 * reads as unassigned. `disabled` turns it off with `title` as its hover
 * text, and closes a list open as it turns off, which then writes
 * nothing, as FieldSelect does. */
export function OwnerField({
  issue,
  field,
  disabled = false,
  title,
}: {
  issue: IssueVM
  field: OwnerField
  disabled?: boolean
  title?: string
}) {
  const holder = issue[field] || null
  const none = field === 'reviewer' ? 'No reviewer' : 'Unassigned'
  const [name] = useOwnerNames(issue.org, holder ? [holder] : [])
  const label =
    holder === null || name?.state === 'gone'
      ? none
      : name?.state === 'ok'
        ? name.name
        : name?.state === 'failed'
          ? "Couldn't load this person"
          : 'Loading…'
  const known = holder !== null && name?.state === 'ok'
  return (
    <Popover
      width={260}
      align="left"
      backLayer
      onEscapeKeyDown={escapeClearsFirst(OWNER_SEARCH)}
      button={(_toggle, open) => (
        <Button
          type="button"
          variant="unstyled"
          data-fieldselect
          data-owner-field={field}
          aria-label={field === 'reviewer' ? 'Reviewer' : 'Assignee'}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          title={title}
          className={cn(
            'flex h-auto min-h-[46px] w-fit max-w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-surface-1 py-2 pr-2 pl-2.5 text-left text-base whitespace-nowrap text-text-1 shadow-xs outline-none transition-[color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50',
            !known && 'text-muted-foreground',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {holder && name?.state !== 'gone' ? (
              <OwnerFace id={holder} />
            ) : (
              <Avatar id={null} size={28} />
            )}
            <span className="truncate" data-owner-name="">
              {label}
            </span>
          </span>
          <DropdownChevron />
        </Button>
      )}
    >
      {(close) => (
        <OwnerPickList
          issue={issue}
          field={field}
          onClose={close}
          off={disabled ? (title ?? 'Read-only project access') : undefined}
        />
      )}
    </Popover>
  )
}

/** The task owner's portrait, with the same people as the task window's
 * fields behind a portrait-sized trigger (OwnerPickList). It shows and
 * edits `issue.ownerField`: the reviewer while the task waits In Review
 * with one set, else the assignee, so picking a face never reassigns work
 * the portrait did not show.
 * `field` pins the edited field instead (the sync's "Needs an owner" assigns
 * a task whose reviewer owns it; "Needs a reviewer" names a reviewer on a
 * task its assignee owns). `onPick` runs once the write is saved. `variant` picks the
 * trigger: the board's bare portrait, a 20px portrait with a chevron (a sync
 * row), or a select-look "Assign" / "Reviewer" button (the sync's opening).
 * Without write access the portrait variant is the plain portrait and the
 * others are disabled, with the task window's read-only hover text.
 * `backLayer` gives the open list a phone Back step (the Team sync page).
 * The list reads nothing until it opens, and Escape in its search clears
 * the typed text before it closes the list. */
export function AssigneeAvatar({
  issue,
  compact = false,
  field,
  onPick,
  variant = 'portrait',
  backLayer = false,
  offTitle,
}: {
  issue: IssueVM
  compact?: boolean
  field?: OwnerField
  onPick?: (profileId: string | null) => void
  variant?: 'portrait' | 'chevron' | 'label'
  backLayer?: boolean
  /** why the control is off although the person may edit the task, such
      as Team sync's stale meeting. Given it, the picker does not open, and
      a list already open closes and writes nothing (OwnerPickList `off`).
      The person's own new task the server has not stored yet is off the
      same way, with WAITS_FOR_SAVE */
  offTitle?: string
}) {
  const shown = field ?? issue.ownerField
  const who = issue[shown]
  // the person's own new task, which the server has not stored yet, has no
  // owners to read until it has (P.createOnItsWay)
  const off = offTitle ?? (P.createOnItsWay(issue.uuid) ? WAITS_FOR_SAVE : undefined)
  const editor = P.canWrite(issue.project)
  const canWrite = editor && !off
  const portrait = portraitFace(compact, <Avatar id={who} size={28} />)
  if (variant === 'portrait' && !editor) return portrait

  const face =
    variant === 'portrait' ? (
      portrait
    ) : variant === 'chevron' ? (
      <>
        <Avatar id={who} size={20} />
        <DropdownChevron />
      </>
    ) : (
      <>
        {who ? (
          <Avatar id={who} size={20} />
        ) : (
          <span className="grid size-5 place-items-center rounded-[4px] border border-dashed border-border-strong bg-surface-3">
            <Icon name="user" size={11} color="var(--text-3)" />
          </span>
        )}
        <span className="text-sm text-text-2">{shown === 'reviewer' ? 'Reviewer' : 'Assign'}</span>
        <DropdownChevron />
      </>
    )
  const faceClass =
    variant === 'portrait'
      ? PORTRAIT_CLASS
      : variant === 'chevron'
        ? 'inline-flex h-control-sm shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent pr-2 pl-1 hover:border-border hover:bg-hover disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-transparent disabled:hover:bg-transparent'
        : 'gap-1.5 pr-2 pl-2.5 font-normal'
  return (
    <span {...OWNER_WRAP}>
      <Popover
        width={260}
        align="right"
        backLayer={backLayer}
        onEscapeKeyDown={escapeClearsFirst(OWNER_SEARCH)}
        button={(toggle) => (
          <Button
            type="button"
            variant={variant === 'label' ? 'default' : 'unstyled'}
            size={variant === 'label' ? 'sm' : undefined}
            data-field-trigger={variant === 'portrait' ? undefined : ''}
            {...ownerTrigger(issue, shown, canWrite, toggle, off)}
            className={faceClass}
          >
            {face}
          </Button>
        )}
      >
        {(close) => (
          <OwnerPickList issue={issue} field={field} onClose={close} onPick={onPick} off={off} />
        )}
      </Popover>
    </span>
  )
}
