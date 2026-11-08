import {
  type ComponentPropsWithoutRef,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownChevron } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../convex/lib/limits'
import { listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { PICKER_CAPS } from '../lib/pickerCaps'
import { useViewVisibility } from '../lib/viewVisibility'
import {
  type IssueFilters,
  type MentionChoice,
  type MentionChoices,
  P,
  type ScopeInfo,
} from '../store/planner'
import { ChoiceEnd, PickerSearch } from './pickerParts'
import { type ChoiceWords, heldLine } from './pickerWords'
import { Avatar, Icon, MenuItem, Popover, PriorityIcon } from './qivo'
import { RowAvatar } from './RowAvatar'
import { PERSON_FAILED, usePeople } from './usePeople'

/* The filter-row setter, React-state shaped: callers hand it either the next
   filters object or an updater over the previous one — both forms appear below. */
type SetFilters = (f: IssueFilters | ((prev: IssueFilters) => IssueFilters)) => void

type ClearFilter = { kind: string; label: string; onClear: () => void }

/* Where the row stands decides what a control looks like at rest (deviation
   #232): inside a well — the Board and Roadmap toolbars — it is quiet and draws
   nothing until hovered; on a page — the phone's filter sheet — it keeps a
   border. Lit is the same everywhere: the raised chip `data-on` / a pressed
   toggle paints. */
type Ground = 'well' | 'page'
const menuVariant = (ground: Ground) => (ground === 'well' ? 'quiet' : 'default')
const toggleVariant = (ground: Ground) => (ground === 'well' ? 'quiet' : 'outline')
/* a well's controls take the tighter radius its own corners leave room for */
const groundRadius = (ground: Ground) => (ground === 'well' ? 'rounded-sm' : 'rounded-md')

/* The clear action sits over the trigger's trailing padding as a sibling
   button. It shares the trigger's surface without nesting interactive controls. */
/** The first name of the one chosen assignee in organization `org` as
    P.person names them, "Loading…" while their details are on their way,
    PERSON_FAILED after a failed read and "Unknown user" for one the server
    says is not there, so a chosen person the workspace does not hold never
    breaks the filter row. */
const firstNameOf = (id: string, org: string) => {
  const person = P.person(id, org)
  if (person?.state === 'ok') return person.name.split(' ')[0] ?? person.name
  if (person?.state === 'failed') return PERSON_FAILED
  return person?.state === 'gone' ? 'Unknown user' : 'Loading…'
}

/** The words of the Assignee menu's list of people. */
const ASSIGNEE_WORDS: ChoiceWords = {
  held: (held) => heldLine(held, true),
  failed: "Couldn't load people.",
  stopped: 'Showing the people found so far.',
  empty: 'No people yet.',
  none: 'No matching people.',
}

function ClearX({ kind, label, onClear }: ClearFilter) {
  const fire = (e) => {
    e.stopPropagation()
    onClear()
  }
  return (
    // the hook carries WHICH filter it clears: with two lit at once a bare
    // attribute matches both, and "the × clears this one and leaves that one"
    // is exactly what a check of it has to say
    <Button
      type="button"
      className="absolute right-2.5 top-1/2 size-6 -translate-y-1/2 border-0 text-inherit hover:bg-current/10"
      data-filter-x={kind}
      aria-label={label}
      title={label}
      onClick={fire}
      variant="ghost"
      size="icon"
    >
      <Icon name="close" size={12} />
    </Button>
  )
}

/* Radix and the landscape popover pass their trigger props/ref through to the
   menu button. Clearing remains a separate keyboard stop and returns focus to
   that button before the clear action disappears. */
const FilterMenuButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { clear?: ClearFilter; lit?: boolean; ground: Ground }
>(function FilterMenuButton({ clear, lit, ground, className, children, ...props }, ref) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  useImperativeHandle(ref, () => triggerRef.current)
  return (
    <span className="relative inline-flex">
      <Button
        {...props}
        ref={triggerRef}
        variant={menuVariant(ground)}
        data-on={lit ? '' : undefined}
        // with no filter set the arrow ends the button 8px from its edge, like
        // every dropdown (deviation #326); a set filter shows its clear X instead
        className={cn(
          groundRadius(ground),
          className,
          clear ? 'pr-[42px] has-[>svg]:pr-[42px]' : 'pr-2 has-[>svg]:pr-2',
        )}
      >
        {children}
      </Button>
      {clear && (
        <ClearX
          {...clear}
          onClear={() => {
            triggerRef.current?.focus()
            clear.onClear()
          }}
        />
      )}
    </span>
  )
})

/* The Assignee popover's body is capped and scrolls. A popover has no height
   of its own and `Popover` only flips it above the trigger when it would cross
   the bottom edge — with a fifty-person roster there is no side of the trigger
   it fits on, and an unbounded list would simply run off the screen. */
/* The search field. Its own component only because two callers place it and the
   placeholder is a selector: `input[placeholder="Filter tasks…"]` is how three
   drives find it, so the string is part of the contract and not decoration. */
function FilterSearch({
  filters,
  setFilters,
  width,
  ground,
}: {
  filters: IssueFilters
  setFilters: SetFilters
  width: number
  ground: Ground
}) {
  /* The one elastic control in the cluster. Everything beside it is a nowrap
     button that cannot give up a pixel, so when the window is too narrow for the
     row this is what yields — a search box 60px shorter is a smaller loss than a
     bar that overflows its own edge.
     Drawn like the sidebar's Search: a quiet hairline on no fill, that
     strengthens on hover and while the field has focus — never the accent. */
  return (
    <div
      data-filter-search
      style={{ flex: `0 1 ${width}px` }}
      className={cn(
        'flex h-control min-w-24 items-center gap-2 border border-border bg-transparent px-2 text-text-3 transition-[border-color,color] hover:border-border-strong hover:text-text-2 focus-within:border-border-strong focus-within:text-text-2',
        groundRadius(ground),
      )}
    >
      <Icon name="search" size={16} />
      <Input
        value={filters.search}
        onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        placeholder="Filter tasks…"
        className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 font-sans text-base text-text-1 shadow-none focus-visible:outline-none focus-visible:ring-0"
      />
      {filters.search && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 bg-transparent hover:bg-transparent hover:border-border-strong"
          title="Clear search"
          aria-label="Clear search"
          onClick={() => setFilters({ ...filters, search: '' })}
        >
          <Icon name="close" size={12} />
        </Button>
      )}
    </div>
  )
}

/* ── the rows behind the two pickers ──────────────────────────────────────
   The bodies of the Assignee and Priority popovers. Their own functions
   because a row is a different thing from the button that opens it: the hooks
   and the writes live here, the label and the lit state live on the trigger. */

/* "Me only", "Anyone", the chosen people and the scope organization's
   people. Mutually exclusive: picking a person clears it, and "Anyone" —
   which means no people filter at all — clears both.

   The people come from the server (pickers.mentions, P.mentionChoices), 8
   a batch in name order with a search over names, initials and email, read
   once a batch while the menu is open and the page shows, with Load more
   and the list's end lines, at most PICKER_CAPS.owners kept: every profile
   of the organization, agents and switched-off people included, as the
   menu has always listed. The chosen people come first, checked and named
   (usePeople), whatever a batch holds; the listed rows are drawn from
   their own initials and color and named by no one, so opening the menu
   loads no face or picture. A pick toggles, and the Board's and the
   Roadmap's reads filter by the ids on the server (`owners`).

   It says "Me ONLY" because that is what distinguishes it from the roster
   underneath, where your own name would be one pick among several: this row
   is not "include me", it is "nobody else". The word does the same work
   "Anyone" does one line down — both name the SHAPE of the answer, not a
   person — and the two now read as the pair of extremes they are.

   IT LEADS THE LIST, and it is the SAME flag the `My tasks` button throws
   (`filters.mine`, `P.isMine` — every seat you hold, 0081, not one profile id
   among the roster's). That matters twice over: it is the answer to "who" that
   people actually want most often, and it is what lets a caller with no room
   for the `My tasks` button drop it (`hide`) without losing it — the
   function is still here, one click deeper, in the control that answers the
   same question. The Assignee trigger reads "Me only" while it is on, so
   hiding the button costs no visibility either. */
function PeopleRows({
  filters,
  setFilters,
  org,
}: {
  filters: IssueFilters
  setFilters: SetFilters
  org: string
}) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const { visible } = useViewVisibility()
  const list = usePagedList<MentionChoices, MentionChoice>({
    key: visible && org ? `${org}\n${search.settled}` : null,
    source: {
      kind: 'once',
      read: (at) => P.mentionChoices(org, search.settled, at.after),
    },
    batch: (answer) => (answer.state === 'ready' ? answer : null),
    id: (row) => row.id,
    most: PICKER_CAPS.owners,
  })
  const answered = !search.tooLong && search.settled === search.typed && list.phase !== 'first'
  const end = answered ? listEnd(list, search.settled !== '') : 'loading'
  // the chosen people, named while the menu shows them
  const chosen = usePeople(filters.assignees.map((id) => ({ org, id })))
  const toggle = (id: string) =>
    setFilters((f) => ({
      ...f,
      mine: false,
      assignees: f.assignees.includes(id)
        ? f.assignees.filter((x) => x !== id)
        : [...f.assignees, id],
    }))
  return (
    <>
      <MenuItem
        data-filter-me
        active={filters.mine}
        onClick={() =>
          setFilters((f) => ({ ...f, mine: !f.mine, assignees: !f.mine ? [] : f.assignees }))
        }
      >
        <Avatar id={P.CURRENT_USER} size={28} />
        Me only
      </MenuItem>
      <MenuItem
        data-filter-anyone
        active={!filters.assignees.length && !filters.mine}
        onClick={() => setFilters({ ...filters, mine: false, assignees: [] })}
      >
        <span className="grid size-7 shrink-0 place-items-center">
          <Icon name="people" size={18} />
        </span>
        Anyone
      </MenuItem>
      <div className="px-1 py-1">
        <PickerSearch
          text={text}
          onText={setText}
          label="Find a person"
          probe="data-filter-assignee-search"
        />
      </div>
      {/* picking people toggles without closing, so several can be chosen
          in one visit */}
      {chosen.map((person) => (
        <MenuItem
          key={person.id}
          active
          data-filter-assignee={person.id}
          data-filter-assignee-chosen=""
          onClick={() => toggle(person.id)}
        >
          <Avatar id={person.id} size={28} />
          {person.state === 'ok'
            ? person.name
            : person.state === 'failed'
              ? PERSON_FAILED
              : person.state === 'gone'
                ? 'Unknown user'
                : 'Loading…'}
        </MenuItem>
      ))}
      {list.rows
        .filter((row) => !filters.assignees.includes(row.id))
        .map((row) => (
          <MenuItem
            key={row.id}
            active={false}
            data-filter-assignee={row.id}
            disabled={!answered}
            onClick={() => toggle(row.id)}
          >
            <RowAvatar row={row} org={org} size={28} />
            {row.name}
          </MenuItem>
        ))}
      <ChoiceEnd end={end} tooLong={search.tooLong} list={list} words={ASSIGNEE_WORDS} />
    </>
  )
}

/* One level at a time, so a pick is a decision and the popover closes on it
   (`onPick`) — unlike the roster beside it, where several picks in one visit is
   the point. */
function PriorityRows({
  filters,
  setFilters,
  onPick,
}: {
  filters: IssueFilters
  setFilters: SetFilters
  onPick?: () => void
}) {
  return (
    <>
      <MenuItem
        data-filter-anyprio
        active={!filters.priority}
        onClick={() => {
          setFilters({ ...filters, priority: null })
          onPick?.()
        }}
      >
        All priorities
      </MenuItem>
      {Object.values(P.PRIORITIES).map((pr) => (
        <MenuItem
          key={pr.id}
          active={filters.priority === pr.id}
          data-filter-prio={pr.id}
          onClick={() => {
            setFilters({ ...filters, priority: filters.priority === pr.id ? null : pr.id })
            onPick?.()
          }}
        >
          <PriorityIcon priority={pr.id} />
          {pr.name}
        </MenuItem>
      ))}
    </>
  )
}

/* Focus is on the SHAPE side of the split: it is a persisted per-user
   preference rather than a session filter, it survives Clear, and it is the
   one control here you flip several times an hour. It is the Board's control
   alone — the roadmap hides it and takes `focus: false` (deviation #241). */
function FocusButton({
  filters,
  setFilters,
  ground,
}: {
  filters: IssueFilters
  setFilters: SetFilters
  ground: Ground
}) {
  return (
    <Toggle
      variant={toggleVariant(ground)}
      pressed={filters.focus}
      data-filter-focus
      className={groundRadius(ground)}
      onPressedChange={(v) => {
        setFilters({ ...filters, focus: v })
        P.saveUI({ focus: v })
      }}
      title="Hide Backlog and Done"
    >
      <Icon name="target" size={16} /> Focus
    </Toggle>
  )
}

/* ── the row: one button per filter ─────────────────────────────────────────
   `hide` DROPS a button, and it is legitimate on two conditions only:

   · the control has a second door — `mine` on the roadmap, where the Assignee
     roster's `Me only` row throws the same flag and the trigger reads
     "Me only" while it is on, so nothing becomes unreachable or invisible;

   · or the view does not apply the flag at all — `stale` and `focus` on the
     roadmap, which App hands `stale: false` and `focus: false` (deviations
     #236 and #241). A filter you cannot see is a filter you cannot trust, and
     `filters` is one object shared across views: a `Stale` or a `Focus`
     switched on over on the board must not arrive here in force with nothing
     on screen to clear it. Stale used to be FOLDED behind a `Filter` popover
     with a count for exactly that reason; the popover went with the flag's
     reach. */
function ViewFilters({
  info,
  filters,
  setFilters,
  searchWidth = 168,
  hideSearch = false,
  hide = [],
  ground = 'well',
}: {
  info: ScopeInfo
  filters: IssueFilters
  setFilters: SetFilters
  /** accepted but unread — callers thread the shared actions object to every view chrome row */
  actions?: unknown
  searchWidth?: number
  /** Phone lists also ignore filters.search so this cannot conceal a live query. */
  hideSearch?: boolean
  /** filters with no button here — the note above says when that is allowed */
  hide?: string[]
  /** `well` (default): quiet controls inside a toolbar well; `page`: bordered controls on a sheet */
  ground?: Ground
}) {
  const mine = info.mine
  const off = (k: string) => hide.includes(k)
  // the organization whose people the Assignee menu lists: the scope's
  const org = info.proj?.org ?? P.homeOrg
  // the one chosen person the trigger names, named while it shows
  usePeople(!mine && filters.assignees.length === 1 ? [{ org, id: filters.assignees[0] }] : [])
  return (
    <>
      {!hideSearch && (
        <FilterSearch
          filters={filters}
          setFilters={setFilters}
          width={searchWidth}
          ground={ground}
        />
      )}

      {/* The two people filters. My view answers "who" by being that scope, so
          both go away there — see the header. */}
      {!mine && (
        <>
          {!off('mine') && (
            <Toggle
              variant={toggleVariant(ground)}
              pressed={filters.mine}
              data-filter-mine
              className={groundRadius(ground)}
              onPressedChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  mine: v,
                  assignees: v ? [] : f.assignees,
                }))
              }
            >
              My tasks
            </Toggle>
          )}

          {/* the trigger answers WHO, whichever way the answer was given: the
            roster's `Me only` row sets `filters.mine`, so the button that opens
            it has to read "Me only" and light for that too — otherwise dropping
            the `My tasks` button would take the state off the screen with it.
            Lit, its chevron becomes the × that clears it: the menu is still one
            click away on the rest of the button, and turning the filter off no
            longer means going into that menu to find `Anyone`. */}
          <Popover
            width={240}
            align="right"
            button={(t: () => void, open: boolean) => {
              const who = filters.mine || filters.assignees.length > 0
              return (
                <FilterMenuButton
                  type="button"
                  lit={who}
                  ground={ground}
                  onClick={t}
                  data-filter-assignee-menu
                  aria-expanded={open}
                  clear={
                    who
                      ? {
                          kind: 'assignee',
                          label: 'Clear assignee filter',
                          onClear: () => setFilters((f) => ({ ...f, mine: false, assignees: [] })),
                        }
                      : undefined
                  }
                >
                  <Icon name="user" size={16} />
                  {filters.mine
                    ? 'Me only'
                    : filters.assignees.length === 0
                      ? 'Assignee'
                      : filters.assignees.length === 1
                        ? firstNameOf(filters.assignees[0], org)
                        : `${filters.assignees.length} people`}
                  {!who && <DropdownChevron />}
                </FilterMenuButton>
              )
            }}
          >
            {() => (
              <div className="max-h-[min(70vh,520px)] overflow-y-auto">
                <PeopleRows filters={filters} setFilters={setFilters} org={org} />
              </div>
            )}
          </Popover>
        </>
      )}

      <Popover
        width={170}
        align="right"
        button={(t: () => void, open: boolean) => (
          <FilterMenuButton
            type="button"
            lit={!!filters.priority}
            ground={ground}
            onClick={t}
            data-filter-prio-menu
            aria-expanded={open}
            clear={
              filters.priority
                ? {
                    kind: 'priority',
                    label: 'Clear priority filter',
                    onClear: () => setFilters({ ...filters, priority: null }),
                  }
                : undefined
            }
          >
            <Icon name="flag" size={16} />
            {filters.priority ? P.PRIORITIES[filters.priority].name : 'Priority'}
            {!filters.priority && <DropdownChevron />}
          </FilterMenuButton>
        )}
      >
        {(close: () => void) => (
          <PriorityRows filters={filters} setFilters={setFilters} onPick={close} />
        )}
      </Popover>

      {!off('stale') && (
        <Toggle
          variant={toggleVariant(ground)}
          pressed={filters.stale}
          data-filter-stale
          className={groundRadius(ground)}
          onPressedChange={(v) => setFilters({ ...filters, stale: v })}
          title="Only show old stale tasks"
        >
          <Icon name="clockFading" size={16} /> Stale
        </Toggle>
      )}

      {!off('focus') && <FocusButton filters={filters} setFilters={setFilters} ground={ground} />}
    </>
  )
}

/* Only the component is exported. `activeCount` and the pieces above are
   deliberately kept private: a module that exports a component AND something
   else cannot be Fast Refreshed — vite says so out loud ("activeCount export is
   incompatible") and falls back to invalidating the module, which reloads App
   with it. Nothing outside this file needs the number anyway; whether Clear is
   offered is where it is read. */
export { ViewFilters }
