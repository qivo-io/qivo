/* Settings › Projects › Archived tasks. Archived tasks are not part of the
   working snapshot: nothing is read until this page opens, and then one
   project family at a time, 100 tasks a page (P.fetchArchivedPage, server
   issues.archivedPage). Search is the main way to find a task: it asks the
   server, which looks through every archived task of the chosen project, a
   read budget at a time, so a step can stop early and offer to search older
   tasks. Without a search the list shows the newest archived tasks first,
   and older ones a page at a time. Restoring goes through P.unarchiveIssue.
   The server also restores the task's archived parents, so every row whose
   task the snapshot shows as active again leaves the list, with no
   reload. */

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { PageTitle } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { Icon, StatusDot } from '../../components/qivo'
import { archivedAtLabel, deletedAtFull, monthLabel } from '../../lib/deletedTime'
import { restoreFocus } from '../../lib/focusVisibility'
import { useMobile } from '../../lib/useMobile'
import { type ArchivedIssueVM, P } from '../../store/planner'
import '../../styles/archived-tasks.css'

/** How many tasks one page asks for. */
export const PAGE_ROWS = 100

/** How long typing rests before a search goes to the server. */
const SEARCH_DELAY_MS = 250

/** The list for one project and search text, and where its reading stands. */
type Listing = {
  rows: ArchivedIssueVM[]
  /** where the next page starts, or null once the archive is read to its end */
  nextCursor: string | null
  /** the archived tasks the server looked at so far, for a search's reach */
  scanned: number
  phase: 'first' | 'failedFirst' | 'ready' | 'more' | 'failedMore'
}

const START: Listing = { rows: [], nextCursor: null, scanned: 0, phase: 'first' }

const count = (n: number) => n.toLocaleString('en-US')
const tasks = (n: number) => `${count(n)} archived task${n === 1 ? '' : 's'}`

/** "Luma Sensor › Firmware" for a sub-project, the name alone otherwise. */
function placeOf(projectId: string): string {
  const project = P.project(projectId)
  if (!project) return ''
  const parent = project.parent ? P.project(project.parent) : undefined
  return parent ? `${parent.name} › ${project.name}` : project.name
}

export function ArchivedTasksPage({ initialProject }: { initialProject?: string | null }) {
  const mobile = useMobile()
  // every visible project (navigation is flat since 0078) with its visible
  // sub-projects; seeing the archive needs only visibility, and restoring is
  // checked per row
  const groups = P.visibleProjects().map((meta) => ({
    meta,
    subs: (meta.children || [])
      .map((id: string) => P.project(id))
      .filter((sp) => !!sp && P.canSee(sp.id)),
  }))
  const known = (id: string | null | undefined) =>
    !!id && groups.some((g) => g.meta.id === id || g.subs.some((sp) => sp?.id === id))
  const [project, setProject] = useState(known(initialProject) ? (initialProject as string) : '')
  const [search, setSearch] = useState('')
  // the search the list answers: the trimmed text once typing rests, and at
  // once when the box is cleared
  const [query, setQuery] = useState('')
  const text = search.trim()
  useEffect(() => {
    if (!text) {
      setQuery('')
      return
    }
    const timer = window.setTimeout(() => setQuery(text), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  const [list, setList] = useState<Listing>(START)
  const [attempt, setAttempt] = useState(0)
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set())
  // answers for an older project, search or attempt are dropped
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

  /* The first page for the project and search, again on Retry. */
  useEffect(() => {
    const seq = ++seqRef.current
    setList(START)
    if (!project) return
    void P.fetchArchivedPage(project, { search: query, limit: PAGE_ROWS }).then((page) => {
      if (seqRef.current !== seq) return
      setList(
        page
          ? { rows: page.rows, nextCursor: page.nextCursor, scanned: page.scanned, phase: 'ready' }
          : { ...START, phase: 'failedFirst' },
      )
    })
  }, [project, query, attempt])

  const rowElement = (uuid: string) =>
    pageRef.current?.querySelector<HTMLElement>(`[data-archive-row="${uuid}"]`) ?? null

  /* The next page, appended. Focus moves to its first new row, or stays on
     the search when the archive ends without one. */
  const loadMore = () => {
    if (!project || list.nextCursor === null || list.phase === 'more') return
    const seq = seqRef.current
    setList((current) => ({ ...current, phase: 'more' }))
    void P.fetchArchivedPage(project, {
      cursor: list.nextCursor,
      search: query,
      limit: PAGE_ROWS,
    }).then((page) => {
      if (seqRef.current !== seq) return
      if (!page) {
        setList((current) => ({ ...current, phase: 'failedMore' }))
        return
      }
      focusNext.current = () => {
        const fresh = page.rows.find((row) => !P.isLiveTask(row.uuid))
        const rowEl = fresh ? rowElement(fresh.uuid) : null
        // focus goes to the first new row and scrolls it into view; a step
        // that found nothing keeps focus on its button, or on the search
        // once the archive ends
        if (rowEl) rowEl.focus()
        else if (!pageRef.current?.contains(document.activeElement)) restoreFocus(searchRef.current)
      }
      setList((current) => ({
        rows: [...current.rows, ...page.rows],
        nextCursor: page.nextCursor,
        scanned: current.scanned + page.scanned,
        phase: 'ready',
      }))
    })
  }

  // a restored task, and any archived parent the server restored with it,
  // is active in the snapshot again, and so is one someone else restored
  const visible = list.rows.filter((row) => !P.isLiveTask(row.uuid))

  const restore = (row: ArchivedIssueVM) => {
    if (restoring.has(row.uuid)) return
    // the rows around this one, for focus once it leaves. Taken now: the
    // snapshot that shows the task active again arrives before the restore's
    // answer, and the row leaves with it.
    const shown = [...(pageRef.current?.querySelectorAll<HTMLElement>('[data-archive-row]') ?? [])]
    const at = shown.findIndex((el) => el.dataset.archiveRow === row.uuid)
    const around = at < 0 ? [] : [...shown.slice(at + 1), ...shown.slice(0, at).reverse()]
    setRestoring((current) => new Set(current).add(row.uuid))
    void P.unarchiveIssue(row.uuid, row.title, row.project).then((ok) => {
      setRestoring((current) => {
        const next = new Set(current)
        next.delete(row.uuid)
        return next
      })
      if (!ok) return // unarchiveIssue toasted why
      window.showToast?.(`Restored ${row.key}`)
      // focus goes to the next row still listed, else the nearest one
      // before it, unless it has moved on from the row and its button
      const active = document.activeElement
      if (!active || active === document.body || active.closest('[data-archive-row]') === shown[at])
        focusNext.current = () =>
          restoreFocus(around.find((el) => el.isConnected) ?? searchRef.current)
      setList((current) => ({ ...current, rows: current.rows.filter((r) => r.uuid !== row.uuid) }))
    })
  }

  const searching = query !== ''
  const ended = list.nextCursor === null
  const projectName = project ? P.project(project)?.name : undefined
  const reach = count(list.scanned)

  // the count line under the filters, once the first page is in
  let countText = ''
  if (list.phase !== 'first' && list.phase !== 'failedFirst' && visible.length > 0) {
    if (searching)
      countText = ended
        ? `${count(visible.length)} found`
        : `${count(visible.length)} found in the newest ${reach}`
    else countText = ended ? tasks(visible.length) : `Newest ${tasks(visible.length)}`
  }

  let body: ReactNode = null
  if (!project) body = <ListNote>Choose a project to see its archived tasks.</ListNote>
  else if (list.phase === 'first')
    body = (
      <ListNote>{searching ? 'Searching archived tasks…' : 'Loading archived tasks…'}</ListNote>
    )
  else if (list.phase === 'failedFirst')
    body = <Failed onRetry={() => setAttempt((n) => n + 1)}>Couldn't load the archive.</Failed>
  else if (visible.length === 0 && ended)
    body = (
      <ListNote>
        {searching
          ? `No archived tasks match “${query}”.`
          : `No archived tasks in ${projectName ? `“${projectName}”` : 'this project'}.`}
      </ListNote>
    )

  // the line that ends the list: the next step, the step running, or why it failed
  let fold: ReactNode = null
  if (
    project &&
    !ended &&
    (list.phase === 'ready' || list.phase === 'more' || list.phase === 'failedMore')
  ) {
    if (list.phase === 'more')
      fold = (
        <FoldLine>
          <span className="italic">
            {searching ? 'Searching older tasks…' : 'Loading older tasks…'}
          </span>
        </FoldLine>
      )
    else if (list.phase === 'failedMore')
      fold = (
        <Failed onRetry={loadMore}>
          {searching ? "Couldn't search older tasks." : "Couldn't load older tasks."}
        </Failed>
      )
    else
      fold = (
        <FoldLine>
          {searching && (
            <span>
              {visible.length > 0
                ? `Searched the newest ${tasks(list.scanned)}.`
                : `No matches in the newest ${tasks(list.scanned)}.`}
            </span>
          )}
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="text-text-1"
            data-archive-more
            onClick={loadMore}
          >
            {searching ? 'Search older tasks' : `Show ${PAGE_ROWS} older tasks`}
          </Button>
        </FoldLine>
      )
  }

  const now = new Date()
  let month = ''
  const rows = visible.map((row) => {
    const at = new Date(row.archivedAt)
    const label = monthLabel(at)
    const divider = label !== month
    month = label
    const canRestore = ['lead', 'user'].includes(P.levelOn(row.project) || '')
    const place = placeOf(row.project)
    const owner = row.owner ? P.user(row.owner)?.name : undefined
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
            {place && <span>{place}</span>}
            {owner && <span>{owner}</span>}
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
            {canRestore && (
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
            <Input
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
              className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 text-base text-text-1 shadow-none focus-visible:ring-0"
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
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="archived-project h-control cursor-pointer bg-surface-1 font-sans text-sm"
          >
            <option value="" disabled hidden>
              Choose a project…
            </option>
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
        {rows.length > 0 && <div className="archived-list flex flex-col gap-2">{rows}</div>}
        {fold}
      </div>
    </>
  )
}

/* A quiet line in place of the list: loading, empty or no project yet. */
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
