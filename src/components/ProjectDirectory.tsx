/* The All projects directory, which the sidebar's All projects row and the
   phone's Projects tab open (`/app/~/projects`). It lists the person's
   projects from the server's navigation reads (convex/projectNav.ts), each
   judged by ordinary access, so an organization admin finds here the
   projects they take part in, and Settings › Projects › All projects keeps
   every project of the organization. It reads no task, and of the store
   only the organizations' names, the home organization, whether the person
   is an organization admin, whether the login may create a project or an
   organization, and whether the workspace holds a project it opens.

   - Browsing lists projectNav.page, the top-level projects, the favorites
     first and then the rest, each in the server's name order, 25 a page
     shown one page at a time (lib/pagedList.ts usePagedPages), which
     Previous and Next replace, with no later page read ahead. Once typing
     rests SEARCH_DELAY_MS, a text with a name key lists projectNav.search
     instead, 25 results a page, top-level projects and sub-projects
     matched by their own names, each sub-project after its project; a new
     search starts at its first page and drops the older one's read, so no
     older answer replaces a newer one. A text of spaces and accents only
     browses, and a text past LIMITS.search says so and asks nothing new.
     It never sends an org_id, so a search covers every seat.
   - A page holding a favorite heads its groups Favorites and Other
     projects. A row of another organization than the home one carries
     that organization's name, and equal names among the rows shown carry
     their number (store/viewModels.ts duplicateNameTags), never through
     the workspace's ProjectName. These rules, the sentences of the lists
     and the open rule below live in components/projectNavRows.tsx, which
     the sidebar's project tree shares.
   - A top-level row's star stars or unstars it (P.setFavorite), showing
     the new state at once, busy until the server answers; the row moves
     between the groups as the page's next answer orders it. A refused star
     goes back and the store toasts why. Focus that was on a star whose row
     leaves the page goes to the star now at its place.
   - A top-level row's Sub-projects button lists its sub-projects
     (projectNav.children), 25 at first and 25 more as the list's end
     scrolls into view or Load more is pressed, at most 100
     (lib/projectPick.ts DIRECTORY_MOST), then a search. One project is expanded at a time, and a
     new search, a page move or the row leaving the page collapses it,
     which stops its read.
   - A press on a name opens the project as the sidebar does, by the
     lists' open rule (projectNavRows.tsx useNavOpen): one the workspace
     holds at once, and one it does not hold yet through
     projectNav.resolve, saying "Opening <name>…" in the status line until
     it opens, or why it cannot. A page move or a new search drops the
     wait, and so does the page hiding.
   - No list says it found nothing or ended before the server said so: not
     ready, the access_unchecked refusal, a stopped page or batch and a
     failure each show as themselves, the refusal and a failure with Retry.

   The page is a kept page (lib/keptPages.ts): while another page shows,
   its reads stop and it keeps what it shows, and coming back shows the
   page the person was on and reads it again (lib/pagedList.ts). */

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils'
import { api } from '../../convex/_generated/api'
import { LIMITS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import type {
  NavChildRow,
  NavChildren,
  NavPage,
  NavPageRow,
  NavProject,
  NavSearch,
  NavSearchRow,
} from '../../convex/model/projectNavReads'
import { restoreFocus } from '../lib/focusVisibility'
import { menuTrigger } from '../lib/focusWhenGone'
import { useLiveView } from '../lib/liveView'
import { useLoadMore } from '../lib/loadMore'
import {
  type ListEnd,
  listEnd,
  type PagedList,
  type PageEnd,
  pageEnd,
  usePagedList,
  usePagedPages,
  useSettledSearch,
} from '../lib/pagedList'
import { DIRECTORY_MOST } from '../lib/projectPick'
import { P, type ProjectSettingsAnswer } from '../store/planner'
import { type HeldLine, PageFold } from './pageFold'
import { pagesState, useMoveFocus } from './pageMoves'
import {
  CHILDREN_WORDS,
  foreignOrg,
  heldText,
  navCursors,
  navTags,
  noNavProjectsHint,
  tagged,
  useNavOpen,
} from './projectNavRows'
import { Icon, MenuItem, Popover } from './qivo'
import { Button } from './ui/button'
import { Input } from './ui/input'

type Actions = Record<string, (...args: unknown[]) => void>

/** A row of the shown page: a browsed top-level project, or a search's
    project or sub-project. */
type Row = NavPageRow | NavSearchRow

/** The project above a search's sub-project row, null for a top-level row. */
const parentOf = (row: Row): NavProject | null => ('parent' in row ? row.parent : null)

/** A star the person pressed: the state it shows, and whether the write is
    still on its way. */
type Pending = { want: boolean; busy: boolean }

/**
 * The All projects directory, on the rules in the module header. `actions`
 * are App's: openProject, openSettings, openArchivedTasks, newProject and
 * createOrg.
 */
export function ProjectDirectory({ actions }: { actions: Actions }) {
  const directory = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const term = nameKey(search.settled)
  const browsing = term === ''
  const key = JSON.stringify(browsing ? ['page'] : ['search', term])
  const page = usePagedPages<NavPage | NavSearch, Row>({
    key,
    query: browsing ? api.projectNav.page : api.projectNav.search,
    args: (after) => ({
      ...(browsing ? {} : { search: search.settled }),
      ...(after === null ? {} : { after }),
    }),
    // an answer without rows, not ready or refused, is held and worded
    batch: (answer) => (answer.state === 'ok' ? answer : null),
  })
  // the list the page opened, which it opens after the render that names a
  // new one, so that render never shows an older list's rows as this one's
  const opened = useRef<string | null>(null)
  useEffect(() => {
    opened.current = key
  })
  const current = opened.current === key
  const rows = current ? page.rows : []
  const end: PageEnd = current ? pageEnd(page, !browsing) : 'loading'
  const state = current ? pagesState(page) : 'loading'

  // a status line for stars and for a project the workspace does not hold;
  // `n` tells two equal sentences apart, so each is read out
  const [status, setStatus] = useState<{ text: string; n: number } | null>(null)
  const say = (line: string) => setStatus((was) => ({ text: line, n: (was?.n ?? 0) + 1 }))
  /** Opens a row as the sidebar does, by the lists' open rule, which
      words in the status line what it waits for and why it cannot open. */
  const nav = useNavOpen(
    (id) => actions.openProject(id),
    (line) => (line === null ? setStatus(null) : say(line)),
  )

  // the one expanded top-level project, collapsed by a page move, a new
  // search, or its row leaving the page for any reason; a page move or a
  // new search also scrolls the list to its top
  const [expanded, setExpanded] = useState<NavProject | null>(null)
  const place = `${key} ${String(page.starts[page.starts.length - 1])}`
  const placed = useRef(place)
  useEffect(() => {
    if (placed.current === place) return
    placed.current = place
    setExpanded(null)
    // a new page or search starts at its top, and an older note goes, with
    // an open that waits
    nav.cancel()
    setStatus(null)
    if (directory.current) directory.current.scrollTop = 0
  }, [place])
  const lost =
    expanded !== null &&
    current &&
    page.phase !== 'first' &&
    !rows.some((r) => r.id === expanded.id)
  useEffect(() => {
    if (lost) setExpanded(null)
  }, [lost])

  // stars on their way, and stars accepted until the page shows them
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(() => new Map())
  const edit = (id: string, next: Pending | null) =>
    setPending((was) => {
      const out = new Map(was)
      if (next === null) out.delete(id)
      else out.set(id, next)
      return out
    })
  // an accepted star ends once the page shows its row with it, or no
  // longer holds the row
  useEffect(() => {
    if (!current) return
    for (const [id, p] of pending) {
      if (p.busy) continue
      const row = rows.find((r) => r.id === id)
      if (!row || row.favorite === p.want) edit(id, null)
    }
  })
  // when a focused star's row leaves the page, focus goes to the star at
  // its place among the page's stars, which a search's sub-project rows
  // do not have
  const follow = useRef<{ id: string; index: number } | null>(null)
  useLayoutEffect(() => {
    const f = follow.current
    if (f === null || !current || page.phase === 'first') return
    if (rows.some((r) => r.id === f.id)) {
      if (!pending.has(f.id)) follow.current = null
      return
    }
    follow.current = null
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    const stars = directory.current?.querySelectorAll<HTMLElement>('[data-directory-star]')
    restoreFocus(stars?.[f.index] ?? stars?.[(stars?.length ?? 0) - 1] ?? field.current)
  })
  const star = (row: NavProject & { favorite: boolean }) => {
    if (pending.has(row.id)) return
    const want = !row.favorite
    edit(row.id, { want, busy: true })
    follow.current = {
      id: row.id,
      index: rows.filter((r) => r.favorite !== null).findIndex((r) => r.id === row.id),
    }
    void P.setFavorite({ id: row.id, org_id: row.org_id }, want).then((ok) => {
      // a refused or paused star goes back, and the store says why
      if (!ok) return edit(row.id, null)
      say(want ? `${row.name} is now a favorite.` : `${row.name} is no longer a favorite.`)
      setPending((was) => {
        if (!was.has(row.id)) return was
        const out = new Map(was)
        out.set(row.id, { want, busy: false })
        return out
      })
    })
  }

  /** Opens `row` as the sidebar does (useNavOpen). */
  const open = (row: NavProject) => nav.open(row)

  const move = useMoveFocus(
    page,
    'project-directory',
    () => directory.current?.querySelector<HTMLElement>('[data-directory-open]') ?? null,
    () => field.current,
  )

  // equal names among the rows shown carry their number, and so do the
  // projects a search's sub-project rows name before their own
  const tags = navTags(rows, parentOf)

  const grouped = rows.some((r) => r.favorite === true)
  const firstFavorite = rows.findIndex((r) => r.favorite === true)
  const firstRest = rows.findIndex((r) => r.favorite !== true)
  const heading = (group: 'favorites' | 'rest') => (
    <h2
      key={`group:${group}`}
      data-directory-group={group}
      className="directory-group text-xs font-semibold text-text-2"
    >
      {group === 'favorites' ? 'Favorites' : 'Other projects'}
    </h2>
  )

  const topRow = (row: Row & { favorite: boolean }) => {
    const p = pending.get(row.id)
    const favorite = p?.want ?? row.favorite
    const isOpen = expanded?.id === row.id
    const org = foreignOrg(row.org_id)
    return (
      <section key={row.id} className="mobile-project-card" data-directory-row={row.id}>
        <div className="mobile-project-row items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            noTooltip
            data-directory-star=""
            aria-pressed={favorite}
            aria-busy={p?.busy || undefined}
            aria-label={
              favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`
            }
            onClick={() => star(row)}
            className={cn('shrink-0', favorite ? 'text-warning' : 'text-text-3')}
          >
            <Icon name="star" size={18} className={favorite ? 'fill-current' : undefined} />
          </Button>
          <Button
            variant="unstyled"
            className="mobile-project-open"
            data-directory-open=""
            onClick={() => open(row)}
          >
            <span className="min-w-0 flex-1 text-left">
              <span className="block break-words font-semibold">
                {tagged({ name: row.name, tag: tags.get(row.id) })}
              </span>
              {org && (
                <span data-directory-org="" className="block text-xs text-text-2">
                  {org}
                </span>
              )}
            </span>
            <Icon name="chevronRight" size={16} />
          </Button>
        </div>
        <div className="mobile-project-actions">
          <Button variant="ghost" onClick={() => actions.openSettings(`project:${row.id}`)}>
            <Icon name="people" size={16} /> People & settings
          </Button>
          <RowMenu row={row} actions={actions} />
        </div>
        <div className="mobile-subprojects">
          <Button
            variant="unstyled"
            className="directory-expand"
            data-directory-expand=""
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Hide' : 'Show'} sub-projects of ${row.name}`}
            onClick={() =>
              setExpanded(
                isOpen ? null : { id: row.id, org_id: row.org_id, name: row.name, num: row.num },
              )
            }
          >
            Sub-projects
            <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={16} />
          </Button>
          {isOpen && expanded && <SubProjects key={expanded.id} parent={expanded} onOpen={open} />}
        </div>
      </section>
    )
  }

  const subRow = (row: NavSearchRow, up: NavProject) => {
    const org = foreignOrg(row.org_id)
    return (
      <section
        key={row.id}
        className="mobile-project-card"
        data-directory-row={row.id}
        data-directory-parent={up.id}
      >
        <div className="mobile-project-row">
          <Button
            variant="unstyled"
            className="mobile-project-open"
            data-directory-open=""
            onClick={() => open(row)}
          >
            <span className="min-w-0 flex-1 text-left">
              <span className="block break-words font-semibold">
                {tagged({ name: up.name, tag: tags.get(up.id) })}
                {' › '}
                {tagged({ name: row.name, tag: tags.get(row.id) })}
              </span>
              {org && (
                <span data-directory-org="" className="block text-xs text-text-2">
                  {org}
                </span>
              )}
            </span>
            <Icon name="chevronRight" size={16} />
          </Button>
        </div>
      </section>
    )
  }

  const listed: ReactNode[] = []
  rows.forEach((row, i) => {
    if (grouped && i === firstFavorite) listed.push(heading('favorites'))
    if (grouped && i === firstRest) listed.push(heading('rest'))
    const up = parentOf(row)
    if (up !== null && 'parent' in row) listed.push(subRow(row, up))
    else if (row.favorite !== null) listed.push(topRow({ ...row, favorite: row.favorite }))
  })

  const searching = !browsing
  const empty = noNavProjectsHint()
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Escape clears a typed search before anything else hears it
    if (event.key === 'Escape' && text !== '') {
      event.stopPropagation()
      setText('')
    }
  }
  return (
    <div
      ref={directory}
      className="mobile-project-directory"
      data-project-directory=""
      data-project-directory-state={state}
      aria-busy={state === 'loading' || state === 'refreshing' || undefined}
    >
      <Input
        ref={field}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find a project…"
        className="bg-surface-1"
        aria-label="Find a project or sub-project"
        data-directory-search=""
      />
      {P.canCreateProject() && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button data-new-project onClick={() => actions.newProject({ kind: 'program' })}>
            <Icon name="plus" size={16} /> New project
          </Button>
        </div>
      )}
      <p
        role="status"
        data-directory-status=""
        className={cn('directory-note text-sm text-text-2', !status && 'sr-only')}
      >
        {status && <span key={status.n}>{status.text}</span>}
      </p>
      {listed}
      <PageFold
        page={page}
        end={end}
        hook="project-directory"
        tooLong={search.tooLong}
        focus={move}
        held={(answer): HeldLine => ({
          line: heldText(answer, 'page'),
          retry: answer?.state !== 'not_ready',
        })}
        words={{
          loading: 'Loading projects…',
          failed: "Couldn't load your projects.",
          none: `No projects match “${search.settled}”.`,
          empty,
          nomore: searching ? 'No more matches.' : 'No more projects.',
          stopped: 'Qivo checked part of your projects. Next continues.',
          stoppedEmpty:
            'Qivo checked part of your projects and found nothing there yet. Next continues.',
          stuck: 'Qivo could not check part of your projects.',
        }}
      />
      {/* while the server would create one (P.orgCreate) */}
      {!P.homeOrg && P.orgCreate === 'now' && (
        <Button
          onClick={(e) => {
            const opener = e.currentTarget
            // the button leaves once the organization exists, and New
            // project comes, as the organization's first admin can create one
            actions.createOrg(() =>
              opener.isConnected
                ? null
                : (directory.current?.querySelector<HTMLElement>('[data-new-project]') ??
                  field.current),
            )
          }}
        >
          <Icon name="plus" size={16} /> Create your organization
        </Button>
      )}
    </div>
  )
}

/* A top-level row's actions menu: Archived tasks, and New sub-project… once
   the project's settings answer that the person may create one there
   (projectSettings.get can_create_sub_project), after Archived tasks, so
   the first item and the keyboard's place do not move as it comes. It
   offers nothing more while the read fails or the project is unavailable. */
function RowMenu({ row, actions }: { row: NavProject; actions: Actions }) {
  return (
    <Popover
      width={230}
      align="right"
      button={(toggle) => (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${row.name} actions`}
          data-directory-menu=""
          onClick={toggle}
        >
          <Icon name="more" size={16} />
        </Button>
      )}
    >
      {(close) => <RowMenuItems row={row} close={close} actions={actions} />}
    </Popover>
  )
}

/** The open menu's items, which read the project's settings while the
    menu is open, sharing the New sub-project dialog's subscription. */
function RowMenuItems({
  row,
  close,
  actions,
}: {
  row: NavProject
  close: () => void
  actions: Actions
}) {
  const key = JSON.stringify({ id: row.id })
  const read = useLiveView<ProjectSettingsAnswer>(api.projectSettings.get, key)
  const answer = read.key === key ? read.value : undefined
  const creates = answer?.state === 'ok' && answer.can_create_sub_project
  return (
    <>
      <MenuItem
        onClick={() => {
          close()
          actions.openArchivedTasks(row.id)
        }}
      >
        <Icon name="inbox" size={16} /> Archived tasks
      </MenuItem>
      {creates && (
        <MenuItem
          data-directory-new-sub=""
          onClick={(e) => {
            const trigger = menuTrigger(e.currentTarget)
            close()
            actions.newProject({ parent: row.id }, () => trigger)
          }}
        >
          <Icon name="plus" size={16} /> New sub-project…
        </MenuItem>
      )}
    </>
  )
}

const noteClass = 'directory-note px-2 py-1 text-sm text-text-2'

/* The live sub-projects of the expanded project `parent`
   (projectNav.children), 25 at first and 25 more as the list's end scrolls
   into view or Load more is pressed, up to DIRECTORY_MOST.children. It
   reads only while it is mounted, so collapsing stops it. */
function SubProjects({
  parent,
  onOpen,
}: {
  parent: NavProject
  onOpen: (row: NavProject) => void
}) {
  const list = usePagedList<NavChildren, NavChildRow>({
    key: JSON.stringify(['children', parent.id]),
    source: {
      kind: 'live',
      query: api.projectNav.children,
      args: (at) => ({ project_id: parent.id, ...navCursors(at) }),
    },
    // an answer without rows, not ready or unavailable, is held and worded
    batch: (answer) => (answer.state === 'ok' ? answer : null),
    id: (row) => row.id,
    most: DIRECTORY_MOST.children,
  })
  const end = listEnd(list, false)
  const { more, marker } = useLoadMore(
    list,
    end,
    (id) => document.querySelector<HTMLElement>(`[data-directory-child="${id}"]`),
    () =>
      document.querySelector<HTMLElement>(
        `[data-directory-row="${parent.id}"] [data-directory-expand]`,
      ),
  )
  const tags = navTags(list.rows, () => parent)
  return (
    <div data-directory-children={parent.id}>
      {list.batches.map((batch, i) => (
        <div key={batch.id}>
          {batch.rows.map((r) => (
            <Button
              key={r.id}
              variant="ghost"
              className="mobile-subproject-row"
              data-directory-child={r.id}
              onClick={() => onOpen(r)}
            >
              <span className="min-w-0 flex-1 whitespace-normal text-left">
                {tagged({ name: r.name, tag: tags.get(r.id) })}
              </span>
              <Icon name="chevronRight" size={16} />
            </Button>
          ))}
          <BatchNote list={list} batch={batch} last={i === list.batches.length - 1} />
        </div>
      ))}
      {/* the marker comes with the first rows, below them, so it is not
         taken as in view from before they landed, which would load the
         next batch at once */}
      {list.rows.length > 0 && <div ref={marker} aria-hidden="true" className="h-px" />}
      <ChildrenEnd list={list} end={end} onMore={more} />
    </div>
  )
}

/** The note of a batch above the last that failed, or of any batch that
    stopped without moving, with Retry, after that batch's rows. */
function BatchNote({
  list,
  batch,
  last,
}: {
  list: PagedList<NavChildren, NavChildRow>
  batch: PagedList<NavChildren, NavChildRow>['batches'][number]
  last: boolean
}) {
  if (batch.note === null || (batch.note === 'failed' && last)) return null
  return (
    <div
      role="status"
      data-directory-children-note={batch.note}
      className={cn('flex flex-wrap items-center gap-2', noteClass)}
    >
      {batch.note === 'stuck' ? CHILDREN_WORDS.stuck : CHILDREN_WORDS.partFailed}
      <Button
        variant="ghost"
        className="h-control-sm text-sm"
        aria-disabled={batch.retrying || undefined}
        onClick={() => !batch.retrying && list.retry(batch.id)}
      >
        {batch.retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}

/* The line that ends an expanded list (lib/pagedList.ts listEnd). Its Load
   more stays in place while it reads, so keyboard focus stays on it. A
   failed list and the access_unchecked refusal offer Retry. Retry reads the
   refused or wholly failed list again from its first batch, and otherwise
   reads only its failed and stuck batches again (lib/pagedList.ts retry). */
function ChildrenEnd({
  list,
  end,
  onMore,
}: {
  list: PagedList<NavChildren, NavChildRow>
  end: ListEnd
  onMore: () => void
}) {
  const line = (text: string, role?: 'status' | 'alert') => (
    <p data-directory-children-end={end} role={role} className={noteClass}>
      {text}
    </p>
  )
  switch (end) {
    case 'loading':
      return line(CHILDREN_WORDS.loading, 'status')
    case 'held': {
      const answer = list.answers[0]
      // the refusal of a check the server could not finish offers Retry,
      // which reads the list again; not ready answers by itself once the
      // server is ready, and a project the person cannot open has nothing
      // to read again
      if (answer?.state !== 'unavailable' || answer.reason !== 'access_unchecked')
        return line(heldText(answer, 'children'))
      return (
        <div
          data-directory-children-end={end}
          className={cn('flex flex-wrap items-center gap-2', noteClass)}
        >
          {heldText(answer, 'children')}
          <Button
            variant="ghost"
            className="h-control-sm text-sm"
            data-directory-children-retry=""
            onClick={() => list.retry()}
          >
            Retry
          </Button>
        </div>
      )
    }
    case 'failed':
      return (
        <div
          role="alert"
          data-directory-children-end={end}
          className={cn('flex flex-wrap items-center gap-2', noteClass)}
        >
          {list.rows.length === 0 ? CHILDREN_WORDS.failed : CHILDREN_WORDS.failedMore}
          <Button variant="ghost" className="h-control-sm text-sm" onClick={() => list.retry()}>
            Retry
          </Button>
        </div>
      )
    case 'full':
      return line(CHILDREN_WORDS.full)
    case 'more':
      return (
        <div data-directory-children-end={end} className="flex flex-wrap items-center gap-2 px-1">
          {list.stopped && <span className={noteClass}>{CHILDREN_WORDS.stopped}</span>}
          <Button
            variant="ghost"
            data-directory-more=""
            aria-disabled={list.phase === 'more' || undefined}
            onClick={() => list.phase !== 'more' && onMore()}
            className="h-control-sm text-sm"
          >
            {list.phase === 'more' ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )
    case 'end':
      // the list's end after its rows says nothing
      return list.rows.length === 0 ? (
        line(CHILDREN_WORDS.empty)
      ) : (
        <span data-directory-children-end={end} hidden />
      )
    default:
      return null
  }
}
