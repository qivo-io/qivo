/* Settings › Projects › Archived tasks. Archived tasks are not part of the
   working snapshot. Nothing is read until this page opens and a scope is
   chosen: a project, a top-level project with its sub-projects, or, only
   when chosen, All projects of one organization. Then one page of 25 tasks
   at a time (P.fetchArchivedPage, server issues.archivedPage), which
   Previous and Next replace, so the page holds one page of rows however far
   it goes. Search is the main way to find a task. It asks the server, which
   looks through the scope's archived tasks a read budget at a time, so a
   page can stop early, even with no matches, and Search older tasks goes on
   from there. Without a search the list shows the newest archived tasks
   first. Each row comes with its place, its owner's name and whether this
   person may restore it, so the page reads no task, person or level from
   the snapshot and opens while a large workspace still loads. Restoring goes
   through P.unarchiveIssue. The row leaves at once and the page asks for
   its tasks again, so tasks the server restored with it, such as archived
   parents, leave too, and the page fills from the next ones. */

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { PageTitle } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { Icon, StatusDot } from '../../components/qivo'
import { archivedAtLabel, deletedAtFull, monthLabel } from '../../lib/deletedTime'
import { limitSentence, overLimit } from '../../lib/fieldLimits'
import { restoreFocus } from '../../lib/focusVisibility'
import { useMobile } from '../../lib/useMobile'
import { type ArchivedListRowVM, type ArchivedScope, P } from '../../store/planner'
import '../../styles/archived-tasks.css'

/** How many tasks one page asks for. */
export const PAGE_ROWS = 25

/** How many page starts Previous keeps. Past it the oldest is dropped, so
    Previous stops at the oldest page still held; another search or scope
    starts again from the newest. */
const MOST_STARTS = 1000

/** How long typing rests before a search goes to the server. */
const SEARCH_DELAY_MS = 250

/** Where one page starts: the cursor it was asked from, null for the
    first, and the archived tasks the pages before it looked at and the rows
    they answered, for a search's reach and the position line. */
type PageStart = { cursor: string | null; scanned: number; found: number }

/** A move from the page on screen: to the next or the previous page, or
    the same page asked for again after a restore. */
type Move = 'next' | 'previous' | 'again'

/** The page on screen for one scope and search, and where reading stands. */
type Listing = {
  /** which first page this listing grew from, so a restore that ends after
      the scope or search changed asks for nothing */
  gen: number
  /** the scope and search the listing answers */
  scope: ArchivedScope | null
  query: string
  rows: ArchivedListRowVM[]
  /** where the next page starts, or null once the scope is read to its end */
  nextCursor: string | null
  /** the scope's archived tasks this page looked at */
  scanned: number
  /** the rows the server answered for this page, restored ones included */
  answered: number
  /** the starts of the pages walked to, the page on screen last */
  starts: PageStart[]
  phase: 'first' | 'failedFirst' | 'ready'
  /** a move that runs, or that failed while the page stays on screen */
  moving: { to: Move; failed: boolean } | null
}

const START: Omit<Listing, 'gen' | 'scope' | 'query'> = {
  rows: [],
  nextCursor: null,
  scanned: 0,
  answered: 0,
  starts: [{ cursor: null, scanned: 0, found: 0 }],
  phase: 'first',
  moving: null,
}

/** `n` with thousands separators, "1,000". */
const count = (n: number) => n.toLocaleString('en-US')
/** "1 archived task", "1,000 archived tasks". */
const tasks = (n: number) => `${count(n)} archived task${n === 1 ? '' : 's'}`

/** The chooser's value for All projects of organization `org`. */
const allOf = (org: string) => `all:${org}`

/** The scope the chooser's value `choice` names, or null for none. */
function scopeOf(choice: string): ArchivedScope | null {
  if (choice.startsWith('all:')) return { org: choice.slice(4), all: true }
  const project = choice ? P.project(choice) : undefined
  return project ? { org: project.org, projectIds: [project.id] } : null
}

/** The Archived tasks page, opened on `initialProject` when it is a project
    the person can see, else on no scope until they choose one. */
export function ArchivedTasksPage({ initialProject }: { initialProject?: string | null }) {
  const mobile = useMobile()
  // every visible project (navigation is flat since 0078) with its visible
  // sub-projects; seeing the archive needs only visibility, and the server
  // says per row whether this person may restore it
  const groups = P.visibleProjects().map((meta) => ({
    meta,
    subs: (meta.children || [])
      .map((id: string) => P.project(id))
      .filter((sp) => !!sp && P.canSee(sp.id)),
  }))
  // the organizations of those projects, each offered as All projects
  const orgs = [...new Set(groups.map((g) => g.meta.org))]
  const known = (id: string | null | undefined) =>
    !!id && groups.some((g) => g.meta.id === id || g.subs.some((sp) => sp?.id === id))
  const [choice, setChoice] = useState(known(initialProject) ? (initialProject as string) : '')
  const [search, setSearch] = useState('')
  // the search the list answers, which is the trimmed text once typing
  // rests, and empty at once when the box is cleared
  const [query, setQuery] = useState('')
  const text = search.trim()
  // a search over the server's cap is not sent; the list says why instead
  const tooLong = overLimit(LIMITS.search, text)
  useEffect(() => {
    if (!text) {
      setQuery('')
      return
    }
    if (tooLong) return
    const timer = window.setTimeout(() => setQuery(text), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [text, tooLong])

  const [list, setList] = useState<Listing>({ ...START, gen: 0, scope: null, query: '' })
  // the listing as last committed, for moves and restores that end later
  const listRef = useRef(list)
  useEffect(() => {
    listRef.current = list
  })
  const [attempt, setAttempt] = useState(0)
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set())
  // answers for an older scope, search, page or attempt are dropped
  const seqRef = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  // a focus move for after the next commit, once new rows are in or a
  // restored one has left
  const focusNext = useRef<(() => void) | null>(null)
  useEffect(() => {
    const run = focusNext.current
    focusNext.current = null
    run?.()
  })

  // Search is the main control, so it takes focus as the page opens. A
  // phone would raise its keyboard over the list, so it does not.
  useEffect(() => {
    if (!mobile) restoreFocus(searchRef.current)
  }, [mobile])

  /* The first page for the scope and search, again on Retry. Any change
     starts again at the first page and forgets the pages walked. */
  useEffect(() => {
    const seq = ++seqRef.current
    const scope = scopeOf(choice)
    setList({ ...START, gen: seq, scope, query })
    if (!scope) return
    void P.fetchArchivedPage(scope, { search: query, limit: PAGE_ROWS }).then((page) => {
      if (seqRef.current !== seq) return
      setList((current) =>
        page
          ? {
              ...current,
              rows: page.rows,
              nextCursor: page.nextCursor,
              scanned: page.scanned,
              answered: page.rows.length,
              phase: 'ready',
            }
          : { ...current, phase: 'failedFirst' },
      )
    })
  }, [choice, query, attempt])

  /* The element inside the page that `selector` names, or null. */
  const pageElement = (selector: string) =>
    pageRef.current?.querySelector<HTMLElement>(selector) ?? null
  /* The button of move `to`, or null when it is not shown. */
  const buttonOf = (to: Move) =>
    pageElement(to === 'previous' ? '[data-archive-previous]' : '[data-archive-more]')

  /* Moves from the page on screen, `to` the next page, the previous one, or
     the same page again. The rows on screen stay until the answer replaces
     them, and a failed move keeps them with a Retry. Focus moves to the
     first row of a new page. A Next or Previous waits for no restore's read
     of the page again, which it replaces. */
  const go = (to: Move) => {
    const current = listRef.current
    const { scope, moving } = current
    if (!scope || current.phase !== 'ready') return
    if (moving && !moving.failed && moving.to !== 'again') return
    const here = current.starts[current.starts.length - 1]
    let starts = current.starts
    if (to === 'next') {
      if (current.nextCursor === null) return
      const after = {
        cursor: current.nextCursor,
        scanned: here.scanned + current.scanned,
        found: here.found + current.answered,
      }
      starts = [...current.starts, after].slice(-MOST_STARTS)
    } else if (to === 'previous') {
      if (current.starts.length < 2) return
      starts = current.starts.slice(0, -1)
    }
    const start = starts[starts.length - 1]
    const seq = ++seqRef.current
    // a Retry leaves with its failed line, so focus goes to the move's button
    if (moving?.failed && to !== 'again')
      focusNext.current = () => {
        if (!pageRef.current?.contains(document.activeElement)) restoreFocus(buttonOf(to))
      }
    setList((c) => ({ ...c, moving: { to, failed: false } }))
    void P.fetchArchivedPage(scope, {
      cursor: start.cursor,
      search: current.query,
      limit: PAGE_ROWS,
    }).then((page) => {
      if (seqRef.current !== seq) return
      if (!page) {
        // the move's button leaves with the failed move, so focus goes to Retry
        focusNext.current = () => {
          if (!pageRef.current?.contains(document.activeElement))
            restoreFocus(pageElement('[data-archive-retry]'))
        }
        setList((c) => ({ ...c, moving: { to, failed: true } }))
        return
      }
      focusNext.current = () => {
        const active = document.activeElement
        const first = pageElement('[data-archive-row]')
        // a new page: focus goes to its first row, which scrolls into view.
        // The same page asked again leaves focus where it is, unless it was
        // on a row that left.
        if (to !== 'again' && first) first.focus()
        else if (to !== 'again' || !active || active === document.body) {
          if (pageRef.current?.contains(active)) return
          const button = buttonOf('next') ?? buttonOf('previous')
          if (first) restoreFocus(first)
          else if (button) restoreFocus(button)
          else if (!mobile) restoreFocus(searchRef.current)
        }
      }
      setList((c) => ({
        ...c,
        rows: page.rows,
        nextCursor: page.nextCursor,
        scanned: page.scanned,
        answered: page.rows.length,
        starts,
        moving: null,
      }))
    })
  }

  /* Restores `row`'s task. Once it succeeds the row leaves, focus moves to
     the next row still listed when it was on this one, and the page asks
     for its tasks again, which fills it. A refused restore keeps the row,
     and P.unarchiveIssue says why. */
  const restore = (row: ArchivedListRowVM) => {
    if (restoring.has(row.uuid)) return
    // the rows around this one, for focus once it leaves
    const shown = [...(pageRef.current?.querySelectorAll<HTMLElement>('[data-archive-row]') ?? [])]
    const at = shown.findIndex((el) => el.dataset.archiveRow === row.uuid)
    const around = at < 0 ? [] : [...shown.slice(at + 1), ...shown.slice(0, at).reverse()]
    const gen = listRef.current.gen
    setRestoring((current) => new Set(current).add(row.uuid))
    void P.unarchiveIssue(row.uuid, row.title, row.project, row.org).then((ok) => {
      setRestoring((current) => {
        const next = new Set(current)
        next.delete(row.uuid)
        return next
      })
      if (!ok) return // unarchiveIssue toasted why
      window.showToast?.(`Restored ${row.key}`)
      if (listRef.current.gen !== gen) return
      // focus goes to the next row still listed, else the nearest one
      // before it, unless it has moved on from the row and its button
      const active = document.activeElement
      if (!active || active === document.body || active.closest('[data-archive-row]') === shown[at])
        focusNext.current = () =>
          restoreFocus(around.find((el) => el.isConnected) ?? (mobile ? null : searchRef.current))
      setList((current) =>
        current.gen === gen
          ? { ...current, rows: current.rows.filter((r) => r.uuid !== row.uuid) }
          : current,
      )
      go('again')
    })
  }

  const searching = list.query !== ''
  const ended = list.nextCursor === null
  const start = list.starts[list.starts.length - 1]
  const later = list.starts.length > 1
  const ready = list.phase === 'ready'
  const rowsShown = list.rows.length
  // how far a search has read, this page included
  const reach = start.scanned + list.scanned

  // the position line under the filters, once a page with rows is in
  let countText = ''
  if (!tooLong && ready && rowsShown > 0) {
    const from = start.found + 1
    const to = start.found + rowsShown
    if (ended && !later) countText = searching ? `${count(rowsShown)} found` : tasks(rowsShown)
    else if (from === to) countText = `${searching ? 'Match' : 'Archived task'} ${count(from)}`
    else countText = `${searching ? 'Matches' : 'Archived tasks'} ${count(from)} to ${count(to)}`
  }

  const projectName = list.scope && !('all' in list.scope) ? P.project(choice)?.name : undefined
  let body: ReactNode = null
  if (!list.scope) body = <ListNote>Choose a project to see its archived tasks.</ListNote>
  else if (tooLong) body = <ListNote>{limitSentence(LIMITS.search)}</ListNote>
  else if (list.phase === 'first')
    body = (
      <ListNote>{searching ? 'Searching archived tasks…' : 'Loading archived tasks…'}</ListNote>
    )
  else if (list.phase === 'failedFirst')
    body = <Failed onRetry={() => setAttempt((n) => n + 1)}>Couldn't load the archive.</Failed>
  else if (rowsShown === 0 && ended) {
    let note: string
    if (start.found > 0) note = searching ? 'No older matches.' : 'No older archived tasks.'
    else if (searching) note = `No archived tasks match “${list.query}”.`
    else if ('all' in list.scope) note = 'No archived tasks in any project you can see.'
    else note = `No archived tasks in ${projectName ? `“${projectName}”` : 'this project'}.`
    body = <ListNote>{note}</ListNote>
  }

  // the line that ends the list: how far the scope is read, then Previous
  // and Next, or why a move failed. While a move runs its button stays, with
  // static text and no action, so keyboard focus stays on it.
  let fold: ReactNode = null
  const moving = list.moving
  if (list.scope && ready && moving?.failed)
    fold = (
      <Failed onRetry={() => go(moving.to)}>
        {moving.to === 'again'
          ? "Couldn't load this page again."
          : searching && moving.to === 'next'
            ? "Couldn't search older tasks."
            : `Couldn't load the ${moving.to} page.`}
      </Failed>
    )
  else if (list.scope && ready && (later || !ended)) {
    const running = moving?.to === 'again' ? null : (moving?.to ?? null)
    let note = ''
    if (searching && !ended) {
      if (rowsShown > 0) note = `Searched the newest ${tasks(reach)}.`
      else if (start.found > 0) note = `No more matches in the newest ${tasks(reach)}.`
      else note = `No matches in the newest ${tasks(reach)}.`
    } else if (!searching && !ended && rowsShown === 0)
      note = 'No archived task you can see is among those read so far.'
    else if (ended && rowsShown > 0)
      note = searching ? 'These are the oldest matches.' : 'These are the oldest archived tasks.'
    fold = (
      <FoldLine>
        {note && <span>{note}</span>}
        {later && (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className={running === 'previous' ? 'pointer-events-none italic' : 'text-text-1'}
            aria-disabled={running !== null || undefined}
            data-archive-previous
            onClick={() => go('previous')}
          >
            {running === 'previous' ? 'Loading…' : 'Previous'}
          </Button>
        )}
        {!ended && (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className={running === 'next' ? 'pointer-events-none italic' : 'text-text-1'}
            aria-disabled={running !== null || undefined}
            data-archive-more
            onClick={() => go('next')}
          >
            {running === 'next'
              ? searching
                ? 'Searching older tasks…'
                : 'Loading…'
              : searching
                ? 'Search older tasks'
                : 'Next'}
          </Button>
        )}
      </FoldLine>
    )
  }

  const now = new Date()
  const rows = list.rows.map((row, index) => {
    const at = new Date(row.archivedAt)
    const label = monthLabel(at)
    const before = list.rows[index - 1]
    const divider = !before || monthLabel(new Date(before.archivedAt)) !== label
    return (
      <Fragment key={row.uuid}>
        {divider && (
          <div data-archive-month className="archived-month">
            {label}
          </div>
        )}
        <div
          data-archive-row={row.uuid}
          tabIndex={-1}
          className="archived-row rounded-md border border-border bg-surface-1 p-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="archived-row-icon mt-[2px] flex text-text-2">
            {row.isGroup ? (
              <Icon name="layers" size={16} color="var(--text-2)" />
            ) : (
              <StatusDot status={row.status} size={16} />
            )}
          </span>
          <div className="archived-row-title flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs text-text-2">{row.key}</span>
            <HoverTooltip content={row.title}>
              <span className="archived-row-name min-w-0 text-base font-medium leading-[1.4] text-text-1">
                {row.title}
              </span>
            </HoverTooltip>
          </div>
          <div className="archived-row-meta mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-text-2">
            {row.place && <span>{row.place}</span>}
            {row.ownerName && <span>{row.ownerName}</span>}
          </div>
          <HoverTooltip content={deletedAtFull(at)}>
            <span
              tabIndex={-1}
              data-archive-time
              className="archived-row-time font-mono text-xs text-text-2"
            >
              {archivedAtLabel(at, now)}
            </span>
          </HoverTooltip>
          <div className="archived-row-actions flex shrink-0 items-center justify-end">
            {row.canRestore && (
              <Button
                type="button"
                variant="ghost"
                data-restore
                aria-label={`Restore ${row.key}`}
                disabled={restoring.has(row.uuid)}
                className="h-control-sm shrink-0 text-sm text-text-1"
                onClick={() => restore(row)}
              >
                <Icon name="rotateCcw" size={16} />
                {restoring.has(row.uuid) ? 'Restoring…' : 'Restore'}
              </Button>
            )}
          </div>
        </div>
      </Fragment>
    )
  })

  return (
    <>
      <PageTitle sub="Done tasks archive automatically after 30 days. Restoring a task also restores its archived parent tasks.">
        Archived tasks
      </PageTitle>
      <div ref={pageRef} data-archived-tasks>
        <div className="archived-filters flex items-center gap-2">
          <div
            data-archive-search-box
            className="archived-search flex h-control items-center gap-2 rounded-md border border-border bg-surface-1 px-2"
          >
            <Icon name="search" size={16} color="var(--text-3)" />
            <LimitedInput
              limit={LIMITS.search}
              ref={searchRef}
              data-archive-search
              aria-label="Search archived tasks"
              placeholder="Search archived tasks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears a search first; an empty box lets it reach
                // Settings, which closes
                if (e.key === 'Escape' && search) {
                  e.stopPropagation()
                  setSearch('')
                }
              }}
              wrapperClassName="h-full flex-1"
              className="h-full rounded-none border-none bg-transparent p-0 text-base text-text-1 shadow-none focus-visible:ring-0"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label="Clear the search"
                onClick={() => {
                  setSearch('')
                  searchRef.current?.focus()
                }}
              >
                <Icon name="close" size={12} />
              </Button>
            )}
          </div>
          <NativeSelect
            data-archive-project
            aria-label="Project"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="archived-project h-control cursor-pointer bg-surface-1 font-sans text-sm"
          >
            <option value="" disabled hidden>
              Choose a project…
            </option>
            {/* All projects of each organization, first and never chosen
                by itself */}
            {orgs.map((org) => (
              <option key={allOf(org)} value={allOf(org)}>
                {orgs.length === 1
                  ? 'All projects'
                  : `All projects in ${P.orgs.find((o) => o.id === org)?.name ?? 'another organization'}`}
              </option>
            ))}
            {groups.map((g) => (
              <optgroup key={g.meta.id} label={P.projectLabel(g.meta)}>
                <option value={g.meta.id}>{P.projectLabel(g.meta)}, whole project</option>
                {g.subs.map(
                  (sp) =>
                    sp && (
                      // option padding is not portable (phones and Firefox
                      // draw their own list), so NBSPs indent sub-projects
                      // one step under their "whole project" row
                      <option key={sp.id} value={sp.id}>
                        {'    '}
                        {P.projectLabel(sp)}
                      </option>
                    ),
                )}
              </optgroup>
            ))}
          </NativeSelect>
        </div>
        {countText && (
          <div
            role="status"
            data-archive-count
            className="mt-2 mb-1 flex h-control items-center border-b border-border px-1 font-mono text-sm text-text-2"
          >
            {countText}
          </div>
        )}
        {body}
        {!tooLong && rows.length > 0 && (
          <div className="archived-list flex flex-col gap-2">{rows}</div>
        )}
        {!tooLong && fold}
      </div>
    </>
  )
}

/* A quiet line in place of the list: loading, empty or no scope yet. */
function ListNote({ children }: { children: ReactNode }) {
  return <div className="px-2 py-4 text-base italic text-text-2">{children}</div>
}

/* The line that ends the list, in the Deleted items fold style. */
function FoldLine({ children }: { children: ReactNode }) {
  return (
    <div
      data-archive-fold
      className="mt-2 flex min-h-control flex-wrap items-center gap-x-2.5 px-[9px] text-sm text-text-2"
    >
      {children}
    </div>
  )
}

/* A read that failed, with a way to try it again. */
function Failed({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 px-2 py-4 text-base text-text-2">
      {children}
      <Button
        type="button"
        variant="ghost"
        data-archive-retry
        className="h-control-sm text-sm text-text-1"
        onClick={onRetry}
      >
        <Icon name="rotateCcw" size={16} />
        Retry
      </Button>
    </div>
  )
}
