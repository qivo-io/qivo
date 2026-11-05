/* Main Search, which Search in the left menu and the phone header open. It
   searches tasks and projects on the server (P.fetchSearchPage,
   search:page): every project the person can open in every organization of
   the login, whatever page it opened on, or the narrower scope chosen under
   Search in, which lasts while the palette is open. Search in is the
   shared project picker (components/ProjectPicker.tsx), which lists the
   person's projects from the server's navigation reads, never from the
   workspace: All projects, an organization's All projects when the login
   holds several seats, a project with its sub-projects, or one sub-project.
   Search starts on All projects, or on the project it opened for
   (searchIn, the Board's and the Overview's Search this sub-project),
   which it resolves on the server first (P.resolveProject); until that
   answers nothing is searched, and a project the person cannot open, or a
   check the server could not finish, leaves All projects. Typing rests
   250 ms before a request; a pick and a change of Include archived tasks
   ask at once, and any change starts at the first page. Only the newest
   request's answer shows. One list in the server's order, 25 rows a page
   at most, with Previous and Next, and a note when the search could not
   cover everything (lib/searchNote.ts), which it never calls no results.
   An empty search reads nothing, and nothing subscribes, so a hidden tab
   reads nothing. A task result opens by its handle or by a reference the
   task window reads from the server (openTaskResult). Only opening a
   project result still uses the workspace (openProjectResult), which
   startup selection switches. */
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CommandDialog, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { LIMITS } from '../../convex/lib/limits'
import { searchTerms } from '../../convex/lib/searchTerms'
import { ProjectPicker } from '../components/ProjectPicker'
import { Icon, IssueKey, ProjectName, StatusDot } from '../components/qivo'
import { limitSentence, overLimit } from '../lib/fieldLimits'
import { restoreFocus } from '../lib/focusVisibility'
import { withStart } from '../lib/pageStarts'
import { type PickRules, type ProjectPick, searchScopeOf } from '../lib/projectPick'
import { type SearchCoverage, searchNote } from '../lib/searchNote'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import {
  P,
  type SearchProjectRow,
  type SearchRow,
  type SearchScope,
  type SearchTaskRow,
} from '../store/planner'

/** How long typing rests before a search goes to the server. */
const SEARCH_DELAY_MS = 250

/** The key of a search: the terms of its text (convex/lib/searchTerms.ts),
    the toggle and the scope, as the server's searchKey reads them, so
    "firmware" and "firmware " are one search. Null for a text without
    terms, which is no search. */
function searchKeyOf(
  text: string,
  includeArchived: boolean,
  scope: SearchScope | null,
): string | null {
  const terms = searchTerms(text)
  if (terms.length === 0) return null
  return JSON.stringify([
    terms.map((t) => [t.word, t.prefix, t.num === undefined ? 'w' : t.num]),
    includeArchived,
    scope?.org_id ?? null,
    scope?.project_id ?? null,
  ])
}

/** One search: its key, its text as typed, the toggle and the scope. */
type Ask = { key: string; text: string; includeArchived: boolean; scope: SearchScope | null }

/** A move to a page: the first of a search, or the next or previous one. */
type Move = 'first' | 'next' | 'previous'

/** The page on screen. `starts` are the starts of the pages walked to, the
    page on screen last, null for the first page. */
type Shown = {
  ask: Ask
  rows: SearchRow[]
  nextCursor: string | null
  coverage: SearchCoverage
  starts: (string | null)[]
}

/** A request on its way, `seq` its number. */
type Running = { seq: number; key: string; move: Move }

/** A request that failed, to ask again on Retry. */
type Failed = { ask: Ask; starts: (string | null)[]; move: Move }

/* The key a text over LIMITS.search stands for, which is never sent. */
const TOO_LONG = 'too-long'

/* The key while the project Search opened for waits for the server to
   resolve it, which asks nothing yet. */
const WAITING = 'waiting'

/* A letter or digit, as searchTerms reads words. A text that holds one but
   no term holds only words too long for Convex to index
   (CONVEX_WORD_BYTES). */
const WORD_CHAR = /[\p{Alphabetic}\p{N}]/u

/* Why a text that is not blank asks nothing: its words are all too long to
   search, or it holds no word at all. */
const noTerms = (text: string): string =>
  WORD_CHAR.test(text)
    ? 'Words longer than about 30 letters are not searched.'
    : 'Type a word or a task ID to search.'

/* The keys the command list's root acts on from any element inside it
   (cmdk 1.1.1): the arrows move the selection, Home and End jump, and Enter
   opens the selected row. */
const ROOT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'])

/* Keeps the list's keys on a control inside the palette, such as Search in,
   Include archived tasks and the page buttons, so Enter does the control's
   own action and never opens a result, and the arrows stay the control's. */
const keepKeys = (event: KeyboardEvent) => {
  if (ROOT_KEYS.has(event.key)) event.stopPropagation()
}

/** The command list value of result `row`, which the smoke drive reads. */
const resultValue = (row: SearchRow): string =>
  row.kind === 'task' ? `issue-${row.handle}` : `project-${row.id}`

/** How Search in picks: one project or sub-project, All projects, or an
    organization's All projects (lib/projectPick.ts). */
const SCOPE_RULES: PickRules = { many: false, oneOrg: false, all: 'every' }

/** Search in's starting pick, All projects. */
const EVERY: ProjectPick = { kind: 'every' }

/**
 * Opens task result `row` with `open` (App openNav): by its handle when the
 * workspace holds the task, else by a reference that names its
 * organization, number and uuid (lib/taskReference.ts), so the task window
 * shows it from its own read, archived ones read-only, or says that one
 * deleted or moved out of sight since the search can't be opened.
 */
function openTaskResult(row: SearchTaskRow, open: (handle: string) => void): void {
  open(P.openTask(row.id, row.org_id, row.num))
}

/** The name of organization `org` when it is not the home organization,
    for a result row, as two organizations can each have a QN-5. */
const foreignOrg = (org: string): string | null =>
  org === P.homeOrg ? null : (P.orgs.find((o) => o.id === org)?.name ?? null)

type SearchPaletteProps = {
  ctx: { setScope: (scopeId: string) => void; openIssue: (issueId: string) => void }
  /** the project or sub-project Search in starts on, null for All projects */
  searchIn?: string | null
  onClose: () => void
}

function SearchPalette({ ctx, searchIn = null, onClose }: SearchPaletteProps) {
  const mobile = useMobile()
  const [text, setText] = useState('')
  // the text a search asks with: the text once typing rests, and at once
  // when a control changes or the text holds no term
  const [settled, setSettled] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  // the Search in pick, and whether the project Search opened for still
  // waits for the server to resolve it, while nothing is searched
  const [pick, setPick] = useState<ProjectPick>(EVERY)
  const [resolving, setResolving] = useState(searchIn !== null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [running, setRunning] = useState<Running | null>(null)
  const [failed, setFailed] = useState<Failed | null>(null)
  // a refusal's sentence, for the search it refused
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null)
  // the selected row's value, set to the first row as each page arrives
  const [selected, setSelected] = useState('')
  // a project result the workspace does not hold yet
  const [notice, setNotice] = useState<string | null>(null)
  // answers to an older request are dropped
  const seqRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const scopeRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // what the commit that shows a new page does: the list starts at its
  // top, where its first row is selected, and after a page move focus goes
  // back to the search, so the arrows and Enter act on the new rows
  const landed = useRef<{ focus: boolean } | null>(null)
  useLayoutEffect(() => {
    const page = landed.current
    landed.current = null
    if (!page) return
    if (listRef.current) listRef.current.scrollTop = 0
    if (page.focus) restoreFocus(inputRef.current)
  })
  // a late answer after the palette closed is dropped
  useEffect(
    () => () => {
      seqRef.current++
    },
    [],
  )
  // the project Search opened for, as the server resolves it for this
  // person: a project they can open is the pick, and anything else, a
  // project they cannot open, a check the server could not finish or a
  // failed read, leaves All projects
  useEffect(() => {
    if (searchIn === null) return
    let live = true
    void P.resolveProject(searchIn).then((answer) => {
      if (!live) return
      if (answer?.state === 'ok') {
        const { id, org_id, name, num, parent } = answer.project
        setPick({ kind: 'projects', org_id, projects: [{ id, org_id, name, num, parent }] })
      }
      setResolving(false)
    })
    return () => {
      live = false
    }
  }, [])

  const pendingActionRef = useRef<(() => void) | null>(null)
  const closeLayer = useMobileBackLayer(true, () => {
    onClose()
    pendingActionRef.current?.()
  })
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  const run = (action: () => void) => {
    // Close the phone search layer with the result, in one commit, so the
    // result's page takes the layer's entry and Back from it returns to the
    // page where the search began.
    pendingActionRef.current = action
    closeLayer()
  }

  // the scope Search in names. A project picked here that is archived or
  // hidden later answers on the server as any project the person cannot
  // see, so the pick stays until the person changes it
  const scope = searchScopeOf(pick) ?? null

  const tooLong = overLimit(LIMITS.search, text)
  // the search the input and the controls describe now, and the one the
  // palette asks for, which waits for typing to rest and, for the project
  // Search opened for, for the server to resolve it
  const typed = tooLong ? TOO_LONG : searchKeyOf(text, includeArchived, scope)
  const wanted = resolving
    ? WAITING
    : overLimit(LIMITS.search, settled)
      ? TOO_LONG
      : searchKeyOf(settled, includeArchived, scope)
  useEffect(() => {
    if (text === settled) return
    if (searchKeyOf(text, false, null) === null) {
      setSettled(text)
      return
    }
    const timer = window.setTimeout(() => setSettled(text), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  /* Asks for the page of `search` that `starts` ends at, as move `move`.
     Only the newest request's answer lands. A refused cursor, from a search
     the server no longer knows as this one, restarts at the first page
     once. A refusal of the text shows its sentence; any other failure keeps
     a page on screen with Retry, or empties a first page. */
  const ask = (search: Ask, starts: (string | null)[], move: Move, restarted = false) => {
    const seq = ++seqRef.current
    const cursor = starts[starts.length - 1]
    setRunning({ seq, key: search.key, move })
    setFailed(null)
    setRefusal(null)
    setNotice(null)
    void P.fetchSearchPage(search.text, {
      includeArchived: search.includeArchived,
      scope: search.scope,
      cursor,
    }).then((answer) => {
      if (seqRef.current !== seq) return
      if (answer.state === 'refused' && answer.code === 'bad_request' && cursor && !restarted) {
        ask(search, [null], 'first', true)
        return
      }
      setRunning(null)
      if (answer.state === 'ok') {
        setShown({
          ask: search,
          rows: answer.rows,
          nextCursor: answer.nextCursor,
          coverage: answer.coverage,
          starts,
        })
        setSelected(answer.rows[0] ? resultValue(answer.rows[0]) : '')
        landed.current = { focus: move !== 'first' || restarted }
        return
      }
      if (move === 'first') setShown(null)
      if (answer.state === 'refused' && answer.code === 'rule')
        setRefusal({ key: search.key, message: answer.message })
      else setFailed({ ask: search, starts, move })
    })
  }

  /* A new search for every change of the key asked for, during the commit,
     so the newer number is in place before any older answer lands. The
     newest request's key, or the screen's when none runs, needs nothing;
     a key that returns to the screen's drops the request on its way. */
  useLayoutEffect(() => {
    if (wanted === WAITING) return
    if (wanted === null || wanted === TOO_LONG) {
      seqRef.current++
      setRunning(null)
      setFailed(null)
      setRefusal(null)
      if (wanted === null) setShown(null)
      return
    }
    if (wanted === (running?.key ?? shown?.ask.key)) return
    if (wanted === shown?.ask.key) {
      seqRef.current++
      setRunning(null)
      setFailed(null)
      return
    }
    ask({ key: wanted, text: settled, includeArchived, scope }, [null], 'first')
  }, [wanted])

  /* Moves to the next or the previous page of the search on screen. */
  const go = (to: 'next' | 'previous') => {
    if (!shown || running || typed !== shown.ask.key) return
    if (to === 'next') {
      if (shown.nextCursor === null) return
      ask(shown.ask, withStart(shown.starts, shown.nextCursor), 'next')
    } else if (shown.starts.length > 1) ask(shown.ask, shown.starts.slice(0, -1), 'previous')
  }

  /* Opens project result `row` as its sidebar entry does (App navScope).
     navScope moves an unknown project to another one, so a project the
     workspace does not hold yet stays unopened, with a note. The project
     navigation stages resolve such a project instead. */
  const openProjectResult = (row: SearchProjectRow) => {
    if (!P.project(row.id)) {
      setNotice(`${row.name} has not loaded yet. Try again in a moment.`)
      return
    }
    run(() => ctx.setScope(row.id))
  }

  // the rows on screen answer an older text, scope or toggle
  const stale = typed !== (shown?.ask.key ?? null)
  // a request runs, or the pause before one: what is typed waits to be
  // asked and is not the search on screen. A failed or refused search, a
  // text without terms and one past the limit wait for nothing.
  const busy =
    running !== null ||
    (resolving && typed !== null) ||
    (typed !== wanted && typed !== null && typed !== TOO_LONG && typed !== shown?.ask.key)
  const rows = tooLong || typed === null ? [] : (shown?.rows ?? [])
  const moving = running && running.move !== 'first' ? running.move : null

  // the status line: what the palette says about the page, or why it shows
  // none
  let status: ReactNode = null
  let action: ReactNode = null
  if (tooLong) status = limitSentence(LIMITS.search)
  else if (typed === null) status = text.trim() ? noTerms(text) : null
  else if (refusal && refusal.key === typed) status = refusal.message
  else if (failed && failed.ask.key === typed) {
    status = "Couldn't search. Try again."
    action = (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-palette-retry
        onClick={() => {
          // the button goes with the failure, so focus goes to the search
          restoreFocus(inputRef.current)
          ask(failed.ask, failed.starts, failed.move)
        }}
      >
        <Icon name="rotateCcw" size={16} />
        Retry
      </Button>
    )
  } else if (stale || running?.move === 'first') status = shown ? 'Updating results…' : 'Searching…'
  else if (notice) status = notice
  else if (shown) {
    const note = searchNote(shown.ask.text.trim(), {
      rows: shown.rows.length,
      next: shown.nextCursor,
      coverage: shown.coverage,
      inProject: shown.ask.scope?.project_id !== undefined,
    })
    status = note.lines.length ? note.lines.join(' ') : null
    if (note.offer)
      action = (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-palette-choose
          onClick={() => scopeRef.current?.click()}
        >
          {note.offer}
        </Button>
      )
  }

  const pageButton = (to: 'previous' | 'next', label: string) => (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      data-palette-page={to}
      className={moving === to ? 'pointer-events-none italic' : 'text-text-1'}
      aria-disabled={moving !== null || stale || undefined}
      onClick={() => go(to)}
    >
      {moving === to ? 'Loading…' : label}
    </Button>
  )
  // Previous and Next, for the search on screen while the text holds one
  const paged = !!shown && !tooLong && typed !== null
  const later = paged && shown.starts.length > 1
  const more = paged && shown.nextCursor !== null

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) closeLayer()
      }}
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      showCloseButton={false}
      onOpenAutoFocus={() => {
        if (document.activeElement instanceof HTMLElement)
          returnFocusRef.current = document.activeElement
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        restoreFocus(returnFocusRef.current)
      }}
      title="Search tasks and projects"
      description="Search the tasks and projects you can open"
      className="top-[calc(13vh+var(--float-inset-top))] max-h-[calc(87vh-var(--float-inset-y)-16px)] w-[580px] max-w-[93vw] translate-y-0 grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden rounded-xl border-border bg-popover p-0 shadow-pop"
    >
      <CommandInput
        ref={inputRef}
        aria-label="Search tasks and projects"
        autoFocus
        value={text}
        onValueChange={setText}
        onKeyDown={(event) => {
          // the rows on screen answer an older search, so Enter waits
          if (event.key === 'Enter' && stale) event.preventDefault()
        }}
        placeholder="Search tasks and projects…"
        className="h-control text-base"
        endAdornment={
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            data-palette-close
            aria-label="Close search"
            title={mobile ? undefined : 'Close search (Esc)'}
            onKeyDown={keepKeys}
            onClick={closeLayer}
          >
            {mobile ? 'Close' : 'esc'}
          </Button>
        }
      />
      <div
        data-palette-controls
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-2"
        onKeyDown={keepKeys}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Label htmlFor="palette-scope" className="shrink-0 text-sm font-normal text-text-2">
            Search in
          </Label>
          <ProjectPicker
            triggerRef={scopeRef}
            trigger={{ id: 'palette-scope', 'data-palette-scope': '' }}
            busyLabel={resolving ? 'Loading…' : null}
            pick={pick}
            rules={SCOPE_RULES}
            label="Search projects to search in"
            // a pick asks at once, with the text as typed
            onPick={(next) => {
              if (next === null) return
              setPick(next)
              setSettled(text)
            }}
            // the palette is a modal dialog, which keeps scrolling to its own
            // content unless the open picker holds a lock of its own
            modal
            className="h-control-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="palette-archived"
            data-palette-archived
            checked={includeArchived}
            onCheckedChange={(checked) => {
              // the toggle asks at once, with the scope chosen so far
              setIncludeArchived(checked === true)
              setSettled(text)
            }}
          />
          <Label htmlFor="palette-archived" className="text-sm font-normal text-text-2">
            Include archived tasks
          </Label>
        </div>
      </div>
      <div
        data-palette-status-line
        className={status || action ? 'flex flex-wrap items-center gap-x-2 px-5 pt-2' : 'sr-only'}
      >
        <span role="status" data-palette-status className="text-sm text-text-2">
          {status}
        </span>
        {action && <span onKeyDown={keepKeys}>{action}</span>}
      </div>
      <CommandList
        ref={listRef}
        aria-busy={busy || undefined}
        className="max-h-[388px] min-h-0 p-2"
      >
        {rows.map((row) =>
          row.kind === 'task' ? (
            <CommandItem
              key={resultValue(row)}
              value={resultValue(row)}
              className="gap-2 p-2 data-[selected=true]:bg-primary-soft"
              onSelect={() => run(() => openTaskResult(row, ctx.openIssue))}
            >
              <TaskResultRow row={row} mobile={mobile} />
            </CommandItem>
          ) : (
            <CommandItem
              key={resultValue(row)}
              value={resultValue(row)}
              className="gap-2 p-2 data-[selected=true]:bg-primary-soft"
              onSelect={() => openProjectResult(row)}
            >
              <ProjectResultRow row={row} mobile={mobile} />
            </CommandItem>
          ),
        )}
      </CommandList>
      {(later || more) && (
        <div
          data-palette-pages
          className="flex items-center justify-end gap-2 border-t px-3 py-1.5"
          onKeyDown={keepKeys}
        >
          {later && pageButton('previous', 'Previous')}
          {more && pageButton('next', 'Next')}
        </div>
      )}
    </CommandDialog>
  )
}

/* What a result row says it is, which screen readers hear too. */
function Kind({ children }: { children: string }) {
  return (
    <span data-result-kind className="w-[52px] shrink-0 text-xs text-text-3">
      {children}
    </span>
  )
}

/* Where a result lives, muted: its organization when it is not the home
   one, then `place`. On a phone it takes a line of its own under the
   title, so the title keeps the row's width. */
function Place({
  org,
  mobile,
  children,
}: {
  org: string | null
  mobile: boolean
  children: ReactNode
}) {
  return (
    <span
      data-result-place
      className={`flex min-w-0 items-baseline gap-1 text-xs text-text-3 ${mobile ? '' : 'max-w-[40%] shrink'}`}
    >
      {org && (
        <span data-result-org className="max-w-[50%] shrink-0 truncate">
          {org}
        </span>
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

/* A row's main line and its place: beside each other on a desktop, the
   place under the main line on a phone. */
function ResultLines({
  main,
  place,
  mobile,
}: {
  main: ReactNode
  place: ReactNode
  mobile: boolean
}) {
  if (!mobile)
    return (
      <>
        {main}
        {place}
      </>
    )
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">{main}</span>
      {place}
    </span>
  )
}

/* A task result: its key, title, Archived mark, status and place, and its
   organization when it is not the home one. A group has no status. */
function TaskResultRow({ row, mobile }: { row: SearchTaskRow; mobile: boolean }) {
  return (
    <>
      <Kind>Task</Kind>
      <ResultLines
        mobile={mobile}
        main={
          <>
            <IssueKey id={row.key} />
            <span className="min-w-0 flex-1 truncate text-base text-text-1">{row.title}</span>
            {row.archived && (
              <span
                data-result-archived
                className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-2"
              >
                Archived
              </span>
            )}
            {row.status !== null && <StatusDot status={row.status} />}
          </>
        }
        place={
          <Place org={foreignOrg(row.org_id)} mobile={mobile}>
            <ProjectName project={row.project} owner={row.parent} />
          </Place>
        }
      />
    </>
  )
}

/* A project result: its name, and for a sub-project its parent's, and its
   organization when it is not the home one. */
function ProjectResultRow({ row, mobile }: { row: SearchProjectRow; mobile: boolean }) {
  const org = foreignOrg(row.org_id)
  return (
    <>
      <Kind>Project</Kind>
      <ResultLines
        mobile={mobile}
        main={
          <span className="min-w-0 flex-1 truncate text-base text-text-1">
            <ProjectName project={row} />
          </span>
        }
        place={
          (org || row.parent) && (
            <Place org={org} mobile={mobile}>
              {row.parent && <ProjectName project={row.parent} />}
            </Place>
          )
        }
      />
    </>
  )
}

export { SearchPalette }
