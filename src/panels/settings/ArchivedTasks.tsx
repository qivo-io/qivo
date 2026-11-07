/* Settings › Projects › Archived tasks. Archived tasks are not part of the
   working snapshot. Nothing is read until this page opens and projects are
   chosen in the shared project picker (components/ProjectPicker.tsx), which
   lists the person's projects from the server's navigation reads, never
   from the workspace: up to PICK_MOST projects and sub-projects of one
   organization, a top-level project standing for its sub-projects, or,
   only when chosen, All projects of one organization. The page opens on
   the project it was opened for once the server resolves it for this
   person (P.resolveProject), and otherwise on no choice, telling the three
   outcomes apart: a project the person cannot open, as for an admin who
   only manages it, whose lists hold the projects they take part in, says
   so in words that hold whatever the reason, as the answer carries none
   (unknown, in Deleted items, archived or under an archived parent); a
   check the server could not finish shows its own sentence with Retry;
   and a read that failed says it couldn't check that project, with
   Retry. Then one
   page of 25 tasks at a time (P.fetchArchivedPage, server
   issues.archivedPage), which Previous and Next replace, so the page
   holds one page of rows however far it goes. A chosen project that is
   later archived, deleted or hidden stays chosen and answers as any
   project the person cannot see.
   Search is the main way to find a task. It asks the server, which looks
   through the scope's archived tasks a read budget at a time, so a page can
   stop early, even with no matches, and Search older tasks goes on from
   there. Without a search the list shows the newest archived tasks first.
   Each row comes with its place, its owner's name and whether this person
   may restore it, so the page reads no task, person or level from the
   snapshot and opens at once, before every task is held. A row's key and
   title open its task read-only in the task window over the page
   (onOpenTask, by the reference P.openTask gives), with Restore for someone
   who can edit its project; the page keeps its choice, search and page
   while it shows, and reads its page again once it closes. Restoring goes
   through P.unarchiveIssue. The row leaves at once and the page asks for
   its tasks again, so tasks the server restored with it, such as archived
   parents, leave too, and the page fills from the next ones. A row whose
   task the snapshot holds as active, as when someone else restored it,
   leaves as soon as the snapshot shows it, which it does only once it
   holds every task for a page that needs them; before that such a row
   stays until the page reads again. */

import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PageTitle } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { PickChips, ProjectPicker } from '../../components/ProjectPicker'
import { Icon, StatusDot } from '../../components/qivo'
import { archivedAtLabel, deletedAtFull, monthLabel } from '../../lib/deletedTime'
import { limitSentence, overLimit } from '../../lib/fieldLimits'
import { restoreFocus } from '../../lib/focusVisibility'
import {
  archivedScopeOf,
  PICK_MOST,
  type PickRules,
  type ProjectPick,
  unpick,
} from '../../lib/projectPick'
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
  /** whether the scope holds more of this person's projects than one page
      lists side by side, which a narrower scope lists */
  tooWide: boolean
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
  tooWide: false,
  phase: 'first',
  moving: null,
}

/** `n` with thousands separators, "1,000". */
const count = (n: number) => n.toLocaleString('en-US')
/** "1 archived task", "1,000 archived tasks". */
const tasks = (n: number) => `${count(n)} archived task${n === 1 ? '' : 's'}`

/** How the page picks projects: up to PICK_MOST of one organization, or
    All projects of one (lib/projectPick.ts). */
const PICK_RULES: PickRules = { many: true, most: PICK_MOST, oneOrg: true, all: 'org' }

/** The Archived tasks page, opened on `initialProject` once the server
    resolves it as a project the person can open, else on no choice, which
    says so until they choose. A row's open button calls `onOpenTask` with
    the task's reference; `taskOpen` says the task window shows over the
    page, which reads its page again once that window closes. */
export function ArchivedTasksPage({
  initialProject,
  onOpenTask,
  taskOpen = false,
}: {
  initialProject?: string | null
  onOpenTask?: (task: string) => void
  taskOpen?: boolean
}) {
  const mobile = useMobile()
  // the chosen projects, or All projects of one organization, null until
  // the person chooses; and whether the project the page opened for still
  // waits for the server, while nothing is read
  const [pick, setPick] = useState<ProjectPick | null>(null)
  const [resolving, setResolving] = useState(!!initialProject)
  // what became of the project the page opened for when it did not
  // resolve, which the page says until the person chooses: a project the
  // person cannot open, a check the server could not finish, with its
  // sentence, or a read that failed
  const [missed, setMissed] = useState<
    { kind: 'unavailable' } | { kind: 'unchecked'; message: string } | { kind: 'failed' } | null
  >(null)
  // a new resolve of the project the page opened for, after Retry
  const [resolveAttempt, setResolveAttempt] = useState(0)
  // whether the person chose in the picker, which the resolved project
  // never replaces
  const chose = useRef(false)
  /* The person's choice in the picker, which reads at once, also while
     the project the page opened on still resolves. */
  const choose = (next: ProjectPick | null) => {
    chose.current = true
    setResolving(false)
    setMissed(null)
    setPick(next)
  }
  useEffect(() => {
    if (!initialProject) return
    let live = true
    void P.resolveProject(initialProject).then((answer) => {
      if (!live) return
      // a project the person cannot open, a check the server could not
      // finish and a failed read all leave no choice, each said apart, and
      // a choice the person made meanwhile stands
      if (!chose.current) {
        if (answer === null) setMissed({ kind: 'failed' })
        else if (answer.state === 'ok') {
          const { id, org_id, name, num, parent } = answer.project
          setPick({ kind: 'projects', org_id, projects: [{ id, org_id, name, num, parent }] })
        } else if (answer.reason !== undefined)
          setMissed({ kind: 'unchecked', message: answer.message ?? UNCHECKED_FALLBACK })
        else setMissed({ kind: 'unavailable' })
      }
      setResolving(false)
    })
    return () => {
      live = false
    }
  }, [resolveAttempt])
  /* Retry of a resolve that failed or that the server could not finish. */
  const retryResolve = () => {
    setMissed(null)
    setResolving(true)
    setResolveAttempt((n) => n + 1)
  }
  const scope: ArchivedScope | null = (pick && archivedScopeOf(pick)) ?? null
  const scopeKey = JSON.stringify(scope)
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
  // the listing as last committed, for moves and restores that end later,
  // and the generation of the newest first page, both set during the commit
  // so no answer that lands after a change of scope or search acts on the
  // listing before it
  const listRef = useRef(list)
  const genRef = useRef(0)
  useLayoutEffect(() => {
    listRef.current = list
  })
  const [attempt, setAttempt] = useState(0)
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set())
  // answers for an older scope, search, page or attempt are dropped
  const seqRef = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  // a focus move for after the next commit, once new rows are in or a
  // restored one has left, and a read of the page again that a restore
  // owes once the Next or Previous it landed during settles
  const focusNext = useRef<(() => void) | null>(null)
  const afterCommit = useRef<(() => void) | null>(null)
  // the generation a restore owes a read of the page again, if any
  const owedRef = useRef<number | null>(null)
  // the rows that followed a restored row, then those before it nearest
  // first, for focus once the page is read again without it
  const followRef = useRef<string[]>([])
  // the rows around the row whose task the window shows, as followRef
  // keeps them, for focus once the page is read again without it
  const openedRef = useRef<string[] | null>(null)
  useEffect(() => {
    const focus = focusNext.current
    const then = afterCommit.current
    focusNext.current = null
    afterCommit.current = null
    focus?.()
    then?.()
  })

  // Search is the main control, so it takes focus as the page opens. A
  // phone would raise its keyboard over the list, so it does not.
  useEffect(() => {
    if (!mobile) restoreFocus(searchRef.current)
  }, [mobile])

  /* The first page for the scope and search, again on Retry. Any change
     starts again at the first page and forgets the pages walked and any
     read a restore owed. It runs during the commit, so the generation
     changes before any later answer can look at it. */
  useLayoutEffect(() => {
    const seq = ++seqRef.current
    genRef.current = seq
    owedRef.current = null
    setList({ ...START, gen: seq, scope, query })
    if (!scope) return
    void P.fetchArchivedPage(scope, { search: query, limit: PAGE_ROWS }).then((page) => {
      if (seqRef.current !== seq) return
      setList((current) =>
        current.gen !== seq
          ? current
          : page
            ? {
                ...current,
                rows: page.rows,
                nextCursor: page.nextCursor,
                scanned: page.scanned,
                answered: page.rows.length,
                tooWide: page.tooWide,
                phase: 'ready',
              }
            : { ...current, phase: 'failedFirst' },
      )
    })
  }, [scopeKey, query, attempt])

  /* The element inside the page that `selector` names, or null. */
  const pageElement = (selector: string) =>
    pageRef.current?.querySelector<HTMLElement>(selector) ?? null
  /* The button of move `to`, or null when it is not shown. */
  const buttonOf = (to: Move) =>
    pageElement(to === 'previous' ? '[data-archive-previous]' : '[data-archive-more]')

  /* The first listed row, or null. */
  const firstRow = () => pageElement('[data-archive-row]')
  /* Where focus goes when nothing in the page holds it: `first` if given,
     else Next or Previous, else the search, which a phone leaves alone. */
  const focusInPage = (first: HTMLElement | null) => {
    const button = buttonOf('next') ?? buttonOf('previous')
    if (first) restoreFocus(first)
    else if (button) restoreFocus(button)
    else if (!mobile) restoreFocus(searchRef.current)
  }

  /* Moves from the page on screen, `to` the next page, the previous one, or
     the same page again. The rows on screen stay until the answer replaces
     them, and a failed move keeps them with a Retry. Focus moves to the
     first row of a new page. A Next or Previous waits for no restore's read
     of the page again, which it replaces, and a read a restore owed runs
     once it lands. Nothing it does reaches a listing of another
     generation. */
  const go = (to: Move) => {
    const current = listRef.current
    const { scope, moving, gen } = current
    if (gen !== genRef.current || !scope || current.phase !== 'ready') return
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
    // a Retry leaves with its failed line, so focus goes to the move's
    // button, or for a read of the page again into the page
    if (moving?.failed)
      focusNext.current = () => {
        if (pageRef.current?.contains(document.activeElement)) return
        if (to === 'again') focusInPage(null)
        else restoreFocus(buttonOf(to))
      }
    setList((c) => (c.gen !== gen ? c : { ...c, moving: { to, failed: false } }))
    void P.fetchArchivedPage(scope, {
      cursor: start.cursor,
      search: current.query,
      limit: PAGE_ROWS,
    }).then((page) => {
      if (seqRef.current !== seq || genRef.current !== gen) return
      if (!page) {
        // the move's button leaves with the failed move, so focus goes to Retry
        focusNext.current = () => {
          if (!pageRef.current?.contains(document.activeElement))
            restoreFocus(pageElement('[data-archive-retry]'))
        }
        setList((c) => (c.gen !== gen ? c : { ...c, moving: { to, failed: true } }))
        return
      }
      const follow = to === 'again' ? followRef.current : []
      if (to === 'again') followRef.current = []
      focusNext.current = () => {
        const active = document.activeElement
        // a new page: focus goes to its first row, which scrolls into view.
        // The same page asked again leaves focus where it is, unless it was
        // on a row that left; then it goes to the first row still listed of
        // those that followed a restored row.
        if (to !== 'again') {
          const first = firstRow()
          if (first) first.focus()
          else if (!pageRef.current?.contains(active)) focusInPage(null)
        } else if (!active || active === document.body) {
          const kept = follow
            .map((uuid) => pageElement(`[data-archive-row="${uuid}"]`))
            .find((el) => el !== null)
          focusInPage(kept ?? null)
        }
      }
      setList((c) =>
        c.gen !== gen
          ? c
          : {
              ...c,
              rows: page.rows,
              nextCursor: page.nextCursor,
              scanned: page.scanned,
              answered: page.rows.length,
              tooWide: page.tooWide,
              starts,
              moving: null,
            },
      )
    })
  }

  /* A restore that landed while a move ran owes the page a read, which goes
     once a listing of its generation commits ready with no move running,
     whichever of the two landed first. It runs during the commit, after
     listRef holds the listing. */
  useLayoutEffect(() => {
    if (owedRef.current === list.gen && list.phase === 'ready' && list.moving === null) {
      owedRef.current = null
      afterCommit.current = () => go('again')
    }
  })

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
      if (genRef.current !== gen) return
      // focus goes to the next row still listed, else the nearest one
      // before it, unless it has moved on from the row and its button
      const active = document.activeElement
      if (!active || active === document.body || active.closest('[data-archive-row]') === shown[at])
        focusNext.current = () =>
          restoreFocus(around.find((el) => el.isConnected) ?? (mobile ? null : searchRef.current))
      followRef.current = around.flatMap((el) => el.dataset.archiveRow ?? [])
      setList((current) =>
        current.gen === gen
          ? { ...current, rows: current.rows.filter((r) => r.uuid !== row.uuid) }
          : current,
      )
      // a Next or Previous running now replaces the page, so the read waits
      // for it
      const moving = listRef.current.moving
      if (moving && !moving.failed && moving.to !== 'again') owedRef.current = gen
      else go('again')
    })
  }

  /* Opens `row`'s task in the window over the page. The rows around it are
     kept for focus, in case the read once the window closes no longer
     lists it, as a restore keeps them. */
  const open = (row: ArchivedListRowVM) => {
    const shown = [...(pageRef.current?.querySelectorAll<HTMLElement>('[data-archive-row]') ?? [])]
    const at = shown.findIndex((el) => el.dataset.archiveRow === row.uuid)
    const around = at < 0 ? [] : [...shown.slice(at + 1), ...shown.slice(0, at).reverse()]
    openedRef.current = around.flatMap((el) => el.dataset.archiveRow ?? [])
    onOpenTask?.(P.openTask(row.uuid, row.org, row.num))
  }
  /* Once the window closes, the page reads its page again, so a task the
     window restored leaves, as after a restore, and a read on its way, a
     Next or Previous, owes it until it lands. Focus stays on the row's open
     button, which the window gives it back, while the row is listed, else
     goes to the rows around it. */
  const wasOpen = useRef(taskOpen)
  useEffect(() => {
    const was = wasOpen.current
    wasOpen.current = taskOpen
    if (!was || taskOpen) return
    const opened = openedRef.current
    openedRef.current = null
    const current = listRef.current
    if (!current.scope || current.gen !== genRef.current) return
    followRef.current = opened ?? []
    const moving = current.moving
    if (current.phase !== 'ready' || (moving && !moving.failed && moving.to !== 'again'))
      owedRef.current = current.gen
    else go('again')
  }, [taskOpen])

  const searching = list.query !== ''
  const ended = list.nextCursor === null
  const start = list.starts[list.starts.length - 1]
  const later = list.starts.length > 1
  const ready = list.phase === 'ready'
  // a task the snapshot holds is active, whoever restored it, also before
  // it holds every task
  const visible = list.rows.filter((row) => !P.isLiveTask(row.uuid))
  const rowsShown = visible.length
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

  // the one project chosen, for the notes that name it
  const picked = pick?.kind === 'projects' ? pick.projects : []
  const projectName = picked.length === 1 ? picked[0]?.name : undefined
  const several = picked.length > 1
  let body: ReactNode = null
  if (resolving) body = <ListNote>Loading archived tasks…</ListNote>
  else if (!list.scope && missed?.kind === 'failed')
    body = <Failed onRetry={retryResolve}>Couldn't check that project.</Failed>
  else if (!list.scope && missed?.kind === 'unchecked')
    body = <Failed onRetry={retryResolve}>{missed.message}</Failed>
  else if (!list.scope)
    body = (
      <ListNote>
        {missed?.kind === 'unavailable'
          ? UNAVAILABLE_NOTE
          : 'Choose a project to see its archived tasks.'}
      </ListNote>
    )
  else if (tooLong) body = <ListNote>{limitSentence(LIMITS.search)}</ListNote>
  else if (list.phase === 'first')
    body = (
      <ListNote>{searching ? 'Searching archived tasks…' : 'Loading archived tasks…'}</ListNote>
    )
  else if (list.phase === 'failedFirst')
    body = <Failed onRetry={() => setAttempt((n) => n + 1)}>Couldn't load the archive.</Failed>
  else if (list.tooWide)
    // a page reads only this person's own projects, and these are too many
    // to read side by side, so a narrower scope lists them
    body = (
      <ListNote>
        {'all' in list.scope
          ? 'You see too many projects to list their archived tasks together. Choose a project.'
          : several
            ? "Qivo can't list the archived tasks of these projects together. Choose fewer projects."
            : 'This project has too many sub-projects to list their archived tasks together. Choose one of its sub-projects.'}
      </ListNote>
    )
  else if (rowsShown === 0 && ended) {
    let note: string
    if (start.found > 0) note = searching ? 'No older matches.' : 'No older archived tasks.'
    else if (searching) note = `No archived tasks match “${list.query}”.`
    else if ('all' in list.scope) {
      const org = list.scope.org
      const name = P.orgs.length > 1 ? P.orgs.find((o) => o.id === org)?.name : undefined
      note = `No archived tasks in any project you can see${name ? ` in ${name}` : ''}.`
    } else if (several) note = 'No archived tasks in the projects you chose.'
    else note = `No archived tasks in ${projectName ? `“${projectName}”` : 'this project'}.`
    body = <ListNote>{note}</ListNote>
  }

  // the line that ends the list: how far the scope is read, then Previous
  // and Next, or why a move failed. While a move runs its button stays, with
  // static text and no action, so keyboard focus stays on it.
  let fold: ReactNode = null
  const moving = list.moving
  const running = moving && !moving.failed && moving.to !== 'again' ? moving.to : null
  const previousButton = later && (
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
  )
  const nextButton = !ended && (
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
  )
  if (list.scope && ready && moving?.failed)
    // the other move stays beside the failure, so the person can go on
    fold = (
      <Failed
        onRetry={() => go(moving.to)}
        after={
          <>
            {moving.to !== 'previous' && previousButton}
            {moving.to !== 'next' && nextButton}
          </>
        }
      >
        {moving.to === 'again'
          ? "Couldn't load this page again."
          : searching && moving.to === 'next'
            ? "Couldn't search older tasks."
            : `Couldn't load the ${moving.to} page.`}
      </Failed>
    )
  else if (list.scope && ready && !list.tooWide && (later || !ended)) {
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
        {previousButton}
        {nextButton}
      </FoldLine>
    )
  }

  const now = new Date()
  const rows = visible.map((row, index) => {
    const at = new Date(row.archivedAt)
    const label = monthLabel(at)
    const before = visible[index - 1]
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
          <HoverTooltip content={row.title}>
            <Button
              type="button"
              variant="unstyled"
              noTooltip
              data-archive-open={row.uuid}
              aria-label={`Open ${row.key}`}
              onClick={() => open(row)}
              className="archived-row-title flex min-w-0 cursor-pointer items-baseline gap-2 rounded-sm border-0 bg-transparent p-0 text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="shrink-0 font-mono text-xs text-text-2">{row.key}</span>
              <span className="archived-row-name min-w-0 text-base font-medium leading-[1.4] text-text-1">
                {row.title}
              </span>
            </Button>
          </HoverTooltip>
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
          <ProjectPicker
            trigger={{ 'data-archive-project': '' }}
            name="Projects"
            none="Choose projects…"
            busyLabel={resolving ? 'Loading…' : null}
            pick={pick}
            rules={PICK_RULES}
            label="Search projects"
            oneOrgNote="Archived tasks lists one organization at a time."
            onPick={choose}
            className="h-control w-full max-w-none"
          />
        </div>
        <PickChips
          picked={picked}
          onRemove={(id) => setPick((now) => unpick(now, id))}
          hooks={{
            row: 'data-archive-picks',
            chip: 'data-archive-pick',
            more: 'data-archive-picks-more',
          }}
          className="archived-picks mt-2"
        />
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

/** What the page says when the project it was opened for does not open
    for this person. The answer carries no cause, so the words hold for an
    unknown project, one in Deleted items, an archived one and one the
    person cannot read, as an admin who only manages it. */
const UNAVAILABLE_NOTE =
  "This page can't show the tasks of the project it was opened for. The project list shows the projects you take part in."

/* The sentence of a check the server could not finish, should its answer
   carry none (convex/lib/access.ts accessUnchecked). */
const UNCHECKED_FALLBACK =
  'Qivo could not finish checking which projects you can see in one request. Contact support@qivo.io so we can help.'

/* A read that failed, with a way to try it again, and `after` it what else
   the person can do, such as the other move. */
function Failed({
  children,
  onRetry,
  after,
}: {
  children: ReactNode
  onRetry: () => void
  after?: ReactNode
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 px-2 py-4 text-base text-text-2">
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
      {after}
    </div>
  )
}
