/* Main Search, which Search in the left menu and the phone header open. It
   searches tasks and projects on the server (P.fetchSearchPage,
   search:page): every project the person can open in every organization of
   the login, whatever page it opened on, or the narrower scope chosen under
   Search in, which lasts while the palette is open. Typing rests 250 ms
   before a request, a change of scope or of Include archived tasks asks at
   once, and any change starts at the first page. Only the newest request's
   answer shows. One list in the server's order, 25 rows a page at most,
   with Previous and Next, and a note when the search could not cover
   everything (lib/searchNote.ts), which it never calls no results. An empty
   search reads nothing, and nothing subscribes, so a hidden tab reads
   nothing. Opening a result and the Search in choices still use the
   workspace (openTaskResult, openProjectResult, scopeChoices), the places
   later stages switch. */
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
import { NativeSelect } from '@/components/ui/native-select'
import { LIMITS } from '../../convex/lib/limits'
import { searchTerms } from '../../convex/lib/searchTerms'
import { Icon, IssueKey, ProjectName, StatusDot } from '../components/qivo'
import { limitSentence, overLimit } from '../lib/fieldLimits'
import { restoreFocus } from '../lib/focusVisibility'
import { noteOpenedTask } from '../lib/openedTasks'
import { withStart } from '../lib/pageStarts'
import { type SearchCoverage, searchNote } from '../lib/searchNote'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import {
  P,
  type ProjectVM,
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

/** One choice of Search in: its value, its label and the scope it
    searches, null for every organization. */
type ScopeChoice = { value: string; label: string; scope: SearchScope | null }

/**
 * The choices of Search in, built from the workspace's projects as the
 * Archived tasks chooser builds them: All projects first, then All
 * projects of each organization with visible projects when the login holds
 * seats in more than one, then each visible top-level project with its
 * sub-projects, "<name>, whole project" first. The shared bounded project
 * picker replaces this once the workspace stops carrying every project.
 */
function scopeChoices(): {
  all: ScopeChoice[]
  groups: { label: string; choices: ScopeChoice[] }[]
} {
  const metas = P.visibleProjects()
  const orgs = [...new Set(metas.map((meta) => meta.org))]
  const all: ScopeChoice[] = [{ value: '', label: 'All projects', scope: null }]
  if (P.orgs.length > 1)
    for (const org of orgs)
      all.push({
        value: `org:${org}`,
        label: `All projects in ${P.orgs.find((o) => o.id === org)?.name ?? 'another organization'}`,
        scope: { org_id: org },
      })
  const groups = metas.map((meta) => {
    const subs = (meta.children || [])
      .map((id: string) => P.project(id))
      .filter((sp): sp is ProjectVM => !!sp && P.canSee(sp.id))
    const label = P.projectLabel(meta)
    return {
      label,
      choices: [
        {
          value: meta.id,
          label: `${label}, whole project`,
          scope: { org_id: meta.org, project_id: meta.id },
        },
        ...subs.map((sp) => ({
          value: sp.id,
          label: P.projectLabel(sp),
          scope: { org_id: sp.org, project_id: sp.id },
        })),
      ],
    }
  })
  return { all, groups }
}

/**
 * Opens task result `row` with `open` (App openNav) by the handle the store
 * gives it now (P.handleNow), not the one its page arrived with, as a role
 * change meanwhile can change it. It notes the task first in the
 * opened-task registry (lib/openedTasks.ts), so a task window opened on a
 * task the workspace does not hold, archived, deleted or moved out of sight
 * since the search, says what became of it. t3/limits-direct-links opens
 * such a task by itself instead.
 */
function openTaskResult(row: SearchTaskRow, open: (handle: string) => void): void {
  const handle = P.handleNow(row.id, row.org_id, row.num)
  noteOpenedTask(handle, {
    uuid: row.id,
    key: row.key,
    title: row.title,
    project: row.project.id,
    org: row.org_id,
    archived: row.archived,
  })
  open(handle)
}

/** The name of organization `org` when it is not the home organization,
    for a result row, as two organizations can each have a QN-5. */
const foreignOrg = (org: string): string | null =>
  org === P.homeOrg ? null : (P.orgs.find((o) => o.id === org)?.name ?? null)

type SearchPaletteProps = {
  ctx: { setScope: (scopeId: string) => void; openIssue: (issueId: string) => void }
  onClose: () => void
}

function SearchPalette({ ctx, onClose }: SearchPaletteProps) {
  const mobile = useMobile()
  const [text, setText] = useState('')
  // the text a search asks with: the text once typing rests, and at once
  // when a control changes or the text holds no term
  const [settled, setSettled] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  // the Search in choice, '' for All projects
  const [choice, setChoice] = useState('')
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
  const scopeRef = useRef<HTMLSelectElement>(null)
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

  const { all, groups } = scopeChoices()
  const offered = [...all, ...groups.flatMap((g) => g.choices)]
  // a project that left the choices, as when it is archived or access to
  // it ends, returns the search to All projects
  const chosen = offered.find((c) => c.value === choice)
  const left = !chosen
  useEffect(() => {
    if (left) setChoice('')
  }, [left])
  const scope = chosen?.scope ?? null

  const tooLong = overLimit(LIMITS.search, text)
  // the search the input and the controls describe now, and the one the
  // palette asks for, which waits for typing to rest
  const typed = tooLong ? TOO_LONG : searchKeyOf(text, includeArchived, scope)
  const wanted = overLimit(LIMITS.search, settled)
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
    })
    status = note.lines.length ? note.lines.join(' ') : null
    if (note.offer)
      action = (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-palette-choose
          onClick={() => scopeRef.current?.focus()}
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
          <NativeSelect
            ref={scopeRef}
            id="palette-scope"
            data-palette-scope
            size="sm"
            value={chosen ? choice : ''}
            onChange={(event) => {
              setChoice(event.target.value)
              setSettled(text)
            }}
            className="h-control-sm max-w-[260px] cursor-pointer bg-surface-1 font-sans text-sm"
          >
            {all.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            {groups.map((g) => (
              <optgroup key={g.choices[0].value} label={g.label}>
                {g.choices.map((c, i) => (
                  // option padding is not portable (phones and Firefox draw
                  // their own list), so NBSPs indent sub-projects one step
                  // under their "whole project" row
                  <option key={c.value} value={c.value}>
                    {i > 0 && '    '}
                    {c.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="palette-archived"
            data-palette-archived
            checked={includeArchived}
            onCheckedChange={(checked) => {
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
        aria-busy={running !== null || stale || undefined}
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
