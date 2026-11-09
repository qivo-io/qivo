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
  READ_ONLY_PROJECT,
} from '@/store/planner'
import { LIMITS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import { CommandChoiceEnd } from './pickerParts'
import { ESCAPE_CLEARS, escapeClearsFirst, OWNER_WORDS, REVIEWER_WORDS } from './pickerWords'
import { useOrgPeople, usePeople } from './usePeople'

export type OwnerField = 'assignee' | 'reviewer'

/** The data attribute of an owner list's search box, which Escape clears
    before it closes the list, in a popover (escapeClearsFirst) and in an
    anchored pop (ESCAPE_CLEARS) alike. */
const OWNER_SEARCH = 'data-owner-search'

/** The value of the Unassigned or No reviewer row, which no id takes. */
const NONE = '\u0000none'

/** The keys with which a person moves the highlight through cmdk. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End'])

/** The task an owner list writes: the workspace's, a view's answer's, or
    the one the task window shows from its own answer. */
const liveTask = (id: string) => P.anyTask(id) ?? P.taskShown(id)

/** The people behind every owner control, as a list the server answers.
 * It holds the people who could become the task's assignee or reviewer
 * (pickers.taskOwners through P.ownerChoices), 25 a batch, read once each
 * while the list is open and never before, with the server's search, Load
 * more and at most PICKER_CAPS.owners people kept. The browser filters,
 * sorts and adds no person.
 *
 * "Unassigned" or "No reviewer" comes first, apart from the batches and
 * never counted in the cap; under a search it shows only when its own
 * label holds every typed word. The current holder comes next, checked,
 * named by a batch's row, by the one pickers.canOwn check the list sends
 * with its first batch, or by P.person, and
 * shown under a search only when that name holds every typed word. A
 * holder the check answers not eligible, or as a person the organization
 * does not hold, reads disabled with a note; a check that failed or could
 * not finish leaves the holder named and checked with no note. A holder
 * no read names yet reads "Loading…", one whose name read failed "Couldn't
 * load this person", and one people.byIds says the organization does not
 * hold the field's own "Unassigned" or "No reviewer", as OwnerField names
 * them. Then the batches' rows, each id once, the holder left out.
 *
 * Rows of an older text read dimmed and take no pick until the list
 * answers the typed text, which moves the highlight to its first row;
 * Enter acts only then. Under a search that first row is a person whenever
 * the list shows one, the holder first, so Enter after a name never clears
 * the field, even when the clear row's label also holds the typed words.
 * The highlight moves this way each time the list comes to answer the
 * typed text: its first answer, a failed or held first read, the answer
 * Try again brings, and the answer for a text typed again after another.
 * cmdk moves the highlight to the first enabled row on every change of the
 * text, which under a search can be the clear row, also when the settled
 * text stays the same, as after a trailing space. The list then puts the
 * first person back, unless the person moved the highlight by a key or the
 * pointer since the text changed. Load more moves the highlight to the
 * first new row. A held, refused, unavailable, over-budget, stopped or
 * failed list says so in the field's words (CommandChoiceEnd), never as an
 * empty or ended list. An unavailable list and a refused assignee list
 * also disable the clear row, which the write would refuse. A refused
 * reviewer list keeps it, since the write still clears the reviewer a task
 * with subtasks kept from before (REVIEWER_ON_GROUP), though it refuses a
 * clear below Edit.
 *
 * Picking writes `field` when the pick changes it through P.updateIssue,
 * whose refusal toasts the server's sentence and is the only check of the
 * person, then calls `onPick` once the server saves it. Without `field`
 * it writes the live task's owner field, re-read at the pick, since a
 * status move while the list was open can hand the task between assignee
 * and reviewer, which also lists that field's people. The list names the
 * holder and its batches' people while open (usePeople), and keeps the
 * check's row and a picked batch row as names for the task's fields
 * (P.takePeople), as the server answered them. `onClose` runs on every
 * accepted pick, changed or not, and
 * is handed the write as `then`, to run once the list has closed (see
 * useMenuBackLayer). `off` says why the list may no longer write, such as
 * Team sync's stale meeting. Given it, its rows, Load more and Try again
 * read disabled with that title and write nothing, also a pick made before
 * the list closes, and the list closes at once through `onClose`, also one
 * that was open before `off` came. */
export function OwnerPickList({
  issue,
  field,
  onClose,
  onPick,
  off,
  editable,
}: {
  issue: IssueVM
  field?: OwnerField
  onClose: (then: () => void) => void
  onPick?: (profileId: string | null) => void
  off?: string
  /** the person's right from the view's own answer (Team sync's agenda
      `editable`), which decides in place of the project cache's level */
  editable?: boolean
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
        P.takePeople(
          issue.org,
          answer.rows.flatMap((row) => (row.person ? [row.person] : [])),
        )
      setChecks((was) => new Map(was).set(checkKey, answer))
    })
  }, [checkKey])
  const checkAnswer = checkKey === null ? undefined : checks.get(checkKey)
  const checkRow = checkAnswer?.state === 'ready' ? checkAnswer.rows[0] : undefined
  // the holder and the batches' people, named while the list is open, so
  // their faces and pictures load in the list's order
  const shownPeople = usePeople([
    ...(holder ? [{ org: issue.org, id: holder }] : []),
    ...list.rows.map((row) => ({ org: issue.org, id: row.id })),
  ])
  const holderName = holder ? shownPeople[0] : undefined
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
  // the write refuses a clear on a task the list could not open. A refused
  // assignee list is one below Edit. A refused reviewer list may be a task
  // with subtasks, whose dormant reviewer the write still clears.
  const closed =
    list.phase === 'held' &&
    (first?.state === 'unavailable' || (first?.state === 'refused' && shown === 'assignee'))
  const end = answered ? listEnd(list, query !== '') : 'loading'

  // the highlighted row, which the answer for the typed text moves to its
  // first row, and Load more to the first new row. Under a search a person
  // comes before the clear row, whose label may also hold the typed words
  // ("Ed" is in "Unassigned"), so Enter after a name never clears the field.
  const [value, setValue] = useState('')
  // the first row of a person the list shows and may pick, the holder first
  const firstPerson = () => (showHolder && !ineligible && holder ? holder : people[0]?.id)
  const firstValue = () => {
    const person = firstPerson()
    if (typed !== '' && person) return person
    return showNone && !closed ? NONE : (person ?? '')
  }
  // whether the list answered the typed text at the last render. The
  // highlight moves each time the list comes to answer it: its first
  // answer, a failed or held one included, the answer Try again brings,
  // and the answer for a text typed again after another, which the list
  // reads again. Load more keeps the list answered and moves it itself.
  const wasAnswered = useRef(false)
  useEffect(() => {
    const lands = answered && !wasAnswered.current
    wasAnswered.current = answered
    if (lands) setValue(firstValue())
  })
  // whether the person moved the highlight, by a key or the pointer, since
  // the text last changed, and whether cmdk's own last move of it is still
  // to be judged. cmdk moves it to the first enabled row on every change
  // of the text and when the row it was on goes, which under a search can
  // be the clear row. Such a move to the clear row, once the list answered
  // the typed text, puts the first person back; before that the answer
  // moves the highlight. The move is judged in the first render that shows
  // it, so cmdk, which follows `value` only when it changes, takes the
  // person back, and before the browser paints the clear row.
  const moved = useRef(false)
  const reselect = useRef(false)
  useLayoutEffect(() => {
    if (!reselect.current || value !== NONE) return
    reselect.current = false
    const person = firstPerson()
    if (answered && typed !== '' && person) setValue(person)
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

  const pick = (id: string | null) => {
    if (off) return
    const live = liveTask(issue.id)
    if (!live || !(editable ?? P.canWrite(live.project))) return
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
      onValueChange={(next) => {
        reselect.current = !moved.current
        setValue(next)
      }}
      onKeyDown={(event) => {
        if (MOVE_KEYS.has(event.key)) moved.current = true
      }}
      onClick={(event) => event.stopPropagation()}
      data-owner-list={shown}
      data-picker-state={stale ? 'loading' : list.phase}
      aria-busy={stale || list.phase === 'more' || undefined}
    >
      <CommandInput
        ref={input}
        value={text}
        onValueChange={(next) => {
          moved.current = false
          setText(next)
        }}
        placeholder={`${find}…`}
        aria-label={find}
        {...{ [OWNER_SEARCH]: '', [ESCAPE_CLEARS]: '' }}
        onKeyDown={(event) => {
          // Enter acts only on the answer for the typed text
          if (event.key === 'Enter' && stale) event.preventDefault()
          // the popover or pop stays open for this Escape (escapeClearsFirst,
          // ESCAPE_CLEARS)
          if (event.key === 'Escape' && text !== '') setText('')
        }}
      />
      <CommandList
        className="max-h-60"
        onPointerMoveCapture={() => {
          moved.current = true
        }}
        onPointerDownCapture={() => {
          moved.current = true
        }}
      >
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
            onSelect={() => pick(holder)}
            // the chosen person reads like a chosen dropdown row (deviation #326)
            className={cn(rowClass, 'font-semibold')}
          >
            {holderLabel === null && holderName?.state === 'gone' ? (
              <Avatar id={null} size={28} />
            ) : (
              <Avatar id={holder} size={28} />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                {holderLabel ??
                  (holderName?.state === 'failed'
                    ? "Couldn't load this person"
                    : holderName?.state === 'gone'
                      ? none
                      : 'Loading…')}
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
            onSelect={() => {
              // a name the server answered, kept for the task's fields
              P.takePeople(issue.org, [person])
              pick(person.id)
            }}
            className={rowClass}
          >
            <Avatar id={person.id} size={28} />
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

/** The task window's Assignee or Reviewer field (`field`) of `issue`, a
 * button in FieldSelect's look, marked data-fieldselect and
 * data-owner-field, that opens the shared owner list (OwnerPickList) in a
 * popover. Its accessible name holds the field and what it shows, such as
 * "Assignee, Leo Park" or "Reviewer, No reviewer", as the menu it replaced
 * gave its value to a screen reader. It names the holder by face and name
 * through usePeople, "Loading…" while the name is on its way, "Couldn't
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
  const [name] = useOrgPeople(issue.org, [holder])
  const label =
    holder === null || name?.state === 'gone'
      ? none
      : name?.state === 'ok'
        ? name.name
        : name?.state === 'failed'
          ? "Couldn't load this person"
          : 'Loading…'
  const known = holder !== null && name?.state === 'ok'
  const named = field === 'reviewer' ? 'Reviewer' : 'Assignee'
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
          aria-label={`${named}, ${label}`}
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
              <Avatar id={holder} size={28} />
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
          off={disabled ? (title ?? READ_ONLY_PROJECT) : undefined}
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
  editable,
}: {
  issue: IssueVM
  compact?: boolean
  field?: OwnerField
  onPick?: (profileId: string | null) => void
  variant?: 'portrait' | 'chevron' | 'label'
  backLayer?: boolean
  /** the person's right on the task from the view's own answer, as Team
      sync's agenda answers `editable`, which decides in place of the
      project cache's level (P.canWrite); false says the read-only text */
  editable?: boolean
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
  const waits = offTitle ?? (P.createOnItsWay(issue.uuid) ? WAITS_FOR_SAVE : undefined)
  const editor = editable ?? P.canWrite(issue.project)
  // a project that takes no write says why first, as while it loads
  // (P.writeNote), then the task's own wait
  const off = editor
    ? waits
    : editable === false
      ? READ_ONLY_PROJECT
      : (P.writeNote(issue.project) ?? READ_ONLY_PROJECT)
  const canWrite = editor && !waits
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
          <OwnerPickList
            issue={issue}
            field={field}
            onClose={close}
            onPick={onPick}
            off={off}
            editable={editable}
          />
        )}
      </Popover>
    </span>
  )
}
