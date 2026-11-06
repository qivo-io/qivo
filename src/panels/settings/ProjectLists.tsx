/* Settings › Projects and Archived projects, and the sub-project lists a
   project's Settings page shares with them.

   Both pages read the server's project lists of one organization at a
   time (projectSettings.projects and archived,
   convex/model/projectSettingsLists.ts), 25 a page through the shared
   list's page mode (lib/pagedList.ts usePagedPages), which Previous and
   Next replace, with a search on the server, for a login with seats in
   several organizations after an Organization select, the home
   organization first. An opened project's live sub-projects
   (projectSettings.subProjects) load 25 at a time as the list's end
   scrolls into view or Load more is pressed, one project open at a time,
   and an archived project's sub-projects (archivedSubProjects) only when
   asked for, one entry at a time, each live while it shows. Every row,
   chip and row right comes from those answers: an organization admin's
   rows are every project of the organization, anyone else's what their
   seat sees, and Restore and Delete come from each row's own rights.
   New sub-project… and Add sub-project are the one exception. They need
   the row's own right and also the store's Lead level on a project the
   workspace holds, because the New sub-project dialog they open still
   takes its parents from the workspace and keeps Create off for any other
   (offersSubProject). The pages read no task, and of the store only the
   organizations to choose from, the home organization and whether the
   login may create a project there (P.canCreateProject, for New project),
   the login's seats for the page memory, that Lead level, and a
   sub-project created here until the server's list holds it. Each read
   stops while the tab is hidden and when the page is left, and keeps no
   answer past it. */
import React, { useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { api } from '../../../convex/_generated/api'
import { LIMITS } from '../../../convex/lib/limits'
import type {
  ArchivedChildRow,
  ArchivedProjectRow,
  SettingsListAnswer,
  SettingsProjectRow,
} from '../../../convex/model/projectSettingsLists'
import { LimitedInput } from '../../components/LimitedField'
import { navRowDiv } from '../../components/navRow'
import { Icon, MenuItem, Popover } from '../../components/qivo'
import { FieldHint, PageTitle, SettingsSection } from '../../components/settingsPage'
import { dayInSentence, deletedAtFull } from '../../lib/deletedTime'
import { limitSentence } from '../../lib/fieldLimits'
import { restoreFocus } from '../../lib/focusVisibility'
import {
  focusAround,
  menuTrigger,
  useFocusAfterRender,
  useFocusWhenGone,
} from '../../lib/focusWhenGone'
import {
  type ListEnd,
  listEnd,
  type PagedList,
  type PagedPages,
  type PageEnd,
  pageEnd,
  usePagedList,
  usePagedPages,
  useSettledSearch,
} from '../../lib/pagedList'
import { P } from '../../store/planner'
import { ArchiveOrDeleteProjectModal } from '../Modals'
import {
  BATCH_START,
  childArgs,
  heldSentence,
  PROJECT_LIST_LIMITS,
  readyBatch,
  tagsOf,
  useLoadMore,
  useSubProjects,
} from './projectListReads'

const noteClass = 'text-sm text-text-2 px-0.5 py-1'

/** The organizations a page lists from, the login's seats (P.orgs): the
    home organization first, then the others by name. */
function orgChoices() {
  const home = P.homeOrg
  return [...P.orgs].sort((a, b) =>
    a.id === home ? -1 : b.id === home ? 1 : a.name.localeCompare(b.name),
  )
}

/** The organization a page opens on: `kept` while the login holds a seat
    there, else the home organization, else the first. */
function orgFor(kept: string | null | undefined): string {
  const choices = orgChoices()
  if (kept && choices.some((o) => o.id === kept)) return kept
  return choices[0]?.id ?? ''
}

/**
 * The organization a page lists, first `initial` and then what the
 * Organization select chose, held to the login's seats. Once the chosen
 * one leaves P.orgs, as when its seat is removed or deactivated while the
 * page shows, the page lists the home organization or the first at once,
 * at its first page with the search kept, and `onGone` drops what the page
 * kept for the old one. Answers the organization and the select's setter.
 */
function useChosenOrg(initial: () => string, onGone?: () => void) {
  const [chosen, setChosen] = useStateS(initial)
  const org = orgFor(chosen)
  React.useEffect(() => {
    if (org === chosen) return
    setChosen(org)
    onGone?.()
  }, [org, chosen])
  return [org, setChosen] as const
}

/** The Organization select of a login with seats in several
    organizations; nothing for one. `hook` is its data attribute. */
function OrgChoice({
  value,
  onChange,
  hook,
}: {
  value: string
  onChange: (org: string) => void
  hook: string
}) {
  const id = React.useId()
  const choices = orgChoices()
  if (choices.length < 2) return null
  return (
    <div className="settings-list-org mb-2 flex flex-wrap items-center gap-2 text-base text-text-2">
      <label htmlFor={id}>Organization</label>
      <NativeSelect
        id={id}
        {...{ [hook]: '' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-control min-w-0 flex-1 bg-surface-1 text-base font-sans"
      >
        {choices.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}

/** A project's name, with its `#num` tag where a twin shows beside it. */
export function TaggedName({ name, tag }: { name: string; tag?: string }) {
  return (
    <>
      {name}
      {tag && (
        <>
          {' '}
          <span
            data-project-tag
            className="whitespace-nowrap !font-mono text-xs leading-none font-normal text-text-2"
          >
            {tag}
          </span>
        </>
      )}
    </>
  )
}

/** Whether a click on a row landed in the row itself, not in its actions
    menu, whose content a portal draws elsewhere while React still bubbles
    its clicks through the row. */
const inRow = (e: React.MouseEvent<HTMLElement>) =>
  e.target instanceof Node && e.currentTarget.contains(e.target)

/** A row's actions menu button. */
const menuButton = (label: string) => (toggle: () => void) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    className="w-control-xs h-control-xs"
    aria-label={label}
    onClick={(e) => {
      e.stopPropagation()
      toggle()
    }}
  >
    <Icon name="more" size={16} />
  </Button>
)

/** A page's search box, whose Escape clears a typed search before
    Settings' own Escape leaves. */
function ListSearch({
  box,
  hook,
  label,
  value,
  onChange,
}: {
  box: React.RefObject<HTMLInputElement | null>
  hook: string
  label: string
  value: string
  onChange: (text: string) => void
}) {
  return (
    <LimitedInput
      ref={box}
      limit={LIMITS.search}
      aria-label={label}
      placeholder={label}
      {...{ [hook]: '' }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value) {
          e.stopPropagation()
          onChange('')
        }
      }}
      wrapperClassName="mb-2"
      className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
    />
  )
}

/** A page list's state for its `data-*-state` and aria-busy: loading,
    failed, refreshing after the tab showed again, or ok. */
const pagesState = (page: Pick<PagedPages<unknown, unknown>, 'phase' | 'refreshing'>) =>
  page.phase === 'first'
    ? 'loading'
    : page.phase === 'failed'
      ? 'failed'
      : page.refreshing
        ? 'refreshing'
        : 'ok'

/** The sentences of one paged page (PageFold). */
type PageWords = {
  loading: string
  notReady: string
  failed: string
  none: string
  empty: string
  nomore: string
}

/* The line that ends a page of Settings › Projects or Archived projects
   (lib/pagedList.ts pageEnd), with Previous and Next. `hook` names its
   data attributes. A move that runs keeps its button with static text and
   no action, so keyboard focus stays on it; a move that failed keeps the
   page, says so with Retry, and keeps the other move beside it. */
function PageFold({
  page,
  end,
  hook,
  words,
  tooLong,
  onMove,
}: {
  page: PagedPages<SettingsListAnswer<unknown>, unknown>
  end: PageEnd
  hook: string
  words: PageWords
  tooLong: boolean
  onMove: (to: 'next' | 'previous') => void
}) {
  const running = page.moving
  const button = (to: 'next' | 'previous') => (
    <Button
      key={to}
      type="button"
      variant="quiet"
      size="sm"
      {...{ [`data-${hook}-${to}`]: '' }}
      className={running === to ? 'pointer-events-none italic' : 'text-text-1'}
      aria-disabled={running !== null || undefined}
      onClick={() => running === null && onMove(to)}
    >
      {running === to ? 'Loading…' : to === 'next' ? 'Next' : 'Previous'}
    </Button>
  )
  const retry = (
    <Button
      key="retry"
      type="button"
      variant="ghost"
      className="h-control-sm text-sm"
      data-page-retry=""
      onClick={() => page.retry()}
    >
      {end === 'failed' && page.failedMove === null ? 'Try again' : 'Retry'}
    </Button>
  )
  const moves = (failed: 'next' | 'previous' | null) => (
    <>
      {page.hasPrevious && failed !== 'previous' && button('previous')}
      {page.hasNext && failed !== 'next' && button('next')}
    </>
  )
  let line: React.ReactNode = null
  let alert = false
  let action: React.ReactNode = null
  if (tooLong) line = limitSentence(LIMITS.search)
  else if (page.failedMove !== null) {
    alert = true
    line = `Couldn't load the ${page.failedMove} page.`
    action = retry
  } else
    switch (end) {
      case 'loading':
        line = words.loading
        break
      case 'held':
        line = heldSentence(page.answer, { notReady: words.notReady, unavailable: words.failed })
        action = page.answer?.state === 'not_ready' ? null : retry
        break
      case 'failed':
        alert = true
        line = words.failed
        action = retry
        break
      case 'stuck':
        line = 'Qivo could not check part of the list.'
        action = retry
        break
      case 'more':
        if (page.stopped)
          line =
            page.rows.length === 0
              ? 'Qivo checked part of the list and found nothing there yet. Next continues.'
              : 'Qivo checked part of the list. Next continues.'
        break
      case 'none':
        line = words.none
        break
      case 'empty':
        line = words.empty
        break
      case 'nomore':
        line = words.nomore
        break
      case 'end':
        break
    }
  const shownMoves = tooLong || end === 'loading' ? null : moves(page.failedMove)
  if (line === null && action === null && !page.hasPrevious && !page.hasNext) return null
  return (
    <div
      {...{ [`data-${hook}-end`]: tooLong ? 'too_long' : end }}
      role={alert ? 'alert' : end === 'loading' ? 'status' : undefined}
      className={cn(
        'settings-page-fold flex flex-wrap items-center gap-2 pt-2 text-sm',
        alert ? 'text-danger' : 'text-text-2',
      )}
    >
      {line !== null && <span>{line}</span>}
      {action}
      {shownMoves}
    </div>
  )
}

/**
 * Focus for a page shown a page at a time: after a move that replaced the
 * page, `first()`, the first row's button, else `rest()`, the search box;
 * after one that failed, its Retry. Only while focus is on the page's
 * fold or nowhere, so focus that moved on stays. Answers the move to call
 * for Previous and Next.
 */
function useMoveFocus(
  page: PagedPages<unknown, unknown>,
  hook: string,
  first: () => HTMLElement | null,
  rest: () => HTMLElement | null,
) {
  const moved = React.useRef(false)
  const at = `${page.starts.length}:${String(page.starts[page.starts.length - 1])}`
  React.useLayoutEffect(() => {
    if (!moved.current || page.moving !== null) return
    moved.current = false
    const active = document.activeElement
    const free =
      !active ||
      active === document.body ||
      !active.isConnected ||
      !!active.closest(`[data-${hook}-end]`)
    if (!free) return
    if (page.failedMove !== null)
      restoreFocus(document.querySelector<HTMLElement>(`[data-${hook}-end] [data-page-retry]`))
    else restoreFocus(first() ?? rest())
  }, [at, page.moving, page.failedMove])
  return (to: 'next' | 'previous') => {
    moved.current = true
    if (to === 'next') page.next()
    else page.previous()
  }
}

/**
 * Whether New sub-project… and Add sub-project show for `row`. The row's
 * own `can_create_sub_project` must allow it, and so must the New
 * sub-project dialog's parent rule (Modals.tsx NewSubProjectModal), a
 * top-level project the workspace holds on which the store's level gives
 * the caller Lead. That dialog still takes its parents and the create's
 * organization from the workspace, so for any other project it would open
 * with Create off. t3/limits-project-dialogs moves the dialog onto the
 * server's parents and the list's organization, which removes the store's
 * half.
 */
const offersSubProject = (row: Pick<SettingsProjectRow, 'id' | 'can_create_sub_project'>) =>
  row.can_create_sub_project && P.project(row.id)?.type === 'meta' && P.levelOn(row.id) === 'lead'

/* What Settings › Projects keeps for the browser session, so Back from a
   project's page lands on the page it came from, read again: the
   organization, the settled search, the page starts and the open project,
   for the login that left them, and never an answer. */
let projectsKept: {
  login: string
  org: string
  search: string
  starts: readonly (string | null)[]
  open: string | null
} | null = null
const loginNow = () => P.myProfileIds.join(',')

/** The arguments of one page of projectSettings.projects, in a fixed key
    order with empty fields left out. */
const projectsArgs = (org: string, search: string, after: string | null) => ({
  org_id: org,
  ...(search === '' ? {} : { search }),
  ...(after === null ? {} : { after }),
})

/**
 * Settings › Projects: one organization's projects 25 a page from the
 * server (projectSettings.projects), every project for an organization
 * admin and what the seat sees for anyone else, in name order with a
 * search over its projects and sub-projects. A project row opens its live
 * sub-projects below it, one project at a time; a search lists matching
 * sub-projects too, each in its project. A row's New sub-project… needs
 * its own `can_create_sub_project` and the dialog's parent rule
 * (offersSubProject).
 */
export function OrgProjectsPage({
  setPage,
  onNewProject,
  onNewSubProject,
  onOpenArchivedTasks,
}: {
  setPage: (page: string) => void
  onNewProject: () => void
  /** opens New sub-project; `focusAfterClose` is what takes focus as it
      closes, and `onCreated` hears the id of the sub-project it created */
  onNewSubProject: (
    parent: string,
    focusAfterClose?: () => HTMLElement | null,
    onCreated?: (id: string) => void,
  ) => void
  onOpenArchivedTasks: (projectId: string) => void
}) {
  const kept = projectsKept?.login === loginNow() ? projectsKept : null
  const [open, setOpen] = useStateS<string | null>(kept?.open ?? null)
  const [org, setOrg] = useChosenOrg(
    () => orgFor(kept?.org),
    () => setOpen(null),
  )
  const [text, setText] = useStateS(kept?.search ?? '')
  const search = useSettledSearch(text, LIMITS.search)
  const searchBox = React.useRef<HTMLInputElement>(null)
  const page = usePagedPages({
    key: org ? JSON.stringify(projectsArgs(org, search.settled, null)) : null,
    query: api.projectSettings.projects,
    args: (after) => projectsArgs(org, search.settled, after),
    batch: readyBatch<SettingsProjectRow>,
    starts: kept && kept.org === org && kept.search === search.settled ? kept.starts : undefined,
  })
  // the sub-projects New sub-project made here, by project, which its open
  // list keeps until a loaded batch holds them
  const [made, setMade] = useStateS<ReadonlyMap<string, readonly string[]>>(() => new Map())
  React.useEffect(() => {
    projectsKept = { login: loginNow(), org, search: search.settled, starts: page.starts, open }
  })
  const toggle = (id: string) => setOpen((was) => (was === id ? null : id))
  const newSubProject = (parent: string, focusAfterClose?: () => HTMLElement | null) =>
    onNewSubProject(parent, focusAfterClose, (id) =>
      setMade((was) => new Map(was).set(parent, [...(was.get(parent) ?? []), id])),
    )
  const canCreate = org === P.homeOrg && P.canCreateProject()
  const searching = search.settled !== ''
  const end = pageEnd(page, searching)
  const move = useMoveFocus(
    page,
    'settings-projects',
    () =>
      document.querySelector<HTMLElement>(
        '[data-settings-projects] [data-project-row] button, [data-settings-projects] [data-subproject-row] button',
      ),
    () => searchBox.current,
  )
  const rows = page.rows
  const tags = tagsOf(
    org,
    rows.map((r) => ({ ...r, parent: r.parent?.id })),
  )
  const orgName = P.orgs.length > 1 ? P.orgs.find((o) => o.id === org)?.name : undefined
  const state = pagesState(page)

  const projectRow = (row: SettingsProjectRow) => {
    const isOpen = open === row.id
    return (
      <div key={row.id} className="[margin-bottom:2px]">
        <div
          data-project-row={row.id}
          data-on={isOpen ? '' : undefined}
          className={cn(navRowDiv, 'gap-1 font-semibold')}
          onClick={(e) => {
            if (inRow(e)) toggle(row.id)
          }}
        >
          <Button
            variant="unstyled"
            type="button"
            aria-expanded={isOpen}
            onClick={(e) => {
              e.stopPropagation()
              toggle(row.id)
            }}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
          >
            <TaggedName name={row.name} tag={tags.get(row.id)} />
          </Button>
          <Popover width={196} align="right" button={menuButton('Project actions')}>
            {(close) => (
              <>
                {offersSubProject(row) && (
                  <MenuItem
                    onClick={(e) => {
                      const trigger = menuTrigger(e.currentTarget)
                      close()
                      newSubProject(row.id, () => trigger)
                    }}
                  >
                    <Icon name="plus" size={16} />
                    New sub-project…
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    close()
                    setPage(`project:${row.id}`)
                  }}
                >
                  <Icon name="cog" size={16} />
                  Project settings
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    onOpenArchivedTasks(row.id)
                  }}
                >
                  <Icon name="inbox" size={14} />
                  Archived tasks
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
        {isOpen && (
          <SettingsSubProjects
            org={org}
            parent={row}
            made={made.get(row.id) ?? []}
            setPage={setPage}
            onOpenArchivedTasks={onOpenArchivedTasks}
            onAdd={() => newSubProject(row.id)}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <PageTitle
        action={
          canCreate ? (
            <Button type="button" data-new-settings-project onClick={onNewProject}>
              <Icon name="plus" size={16} />
              New project
            </Button>
          ) : undefined
        }
      >
        Projects
      </PageTitle>
      <SettingsSection title="Projects">
        <div className="[max-width:480px]">
          <OrgChoice
            value={org}
            hook="data-settings-projects-org"
            onChange={(next) => {
              setOrg(next)
              setOpen(null)
            }}
          />
          <ListSearch
            box={searchBox}
            hook="data-settings-projects-search"
            label="Search projects and sub-projects"
            value={text}
            onChange={setText}
          />
          <div
            data-settings-projects=""
            data-settings-projects-state={state}
            aria-busy={state === 'loading' || state === 'refreshing' || undefined}
          >
            {rows.map((row) =>
              row.parent === null ? (
                projectRow(row)
              ) : (
                <SubProjectRow
                  key={row.id}
                  id={row.id}
                  name={<TaggedName name={row.name} tag={tags.get(row.id)} />}
                  within={row.parent.name}
                  setPage={setPage}
                  onOpenArchivedTasks={onOpenArchivedTasks}
                />
              ),
            )}
            <PageFold
              page={page}
              end={end}
              hook="settings-projects"
              tooLong={search.tooLong}
              onMove={move}
              words={{
                loading: 'Loading projects…',
                notReady: "Projects can't be listed yet. Try again in a few minutes.",
                failed: "Couldn't load projects.",
                none: 'No projects match.',
                empty: orgName
                  ? `No projects in ${orgName} you can see.`
                  : 'You don’t have access to any project yet.',
                nomore: searching ? 'No more matches.' : 'No more projects.',
              }}
            />
          </div>
        </div>
      </SettingsSection>
    </>
  )
}

/* A sub-project's row in Settings › Projects, under its open project or,
   in a search, with the project it is in (`within`). A click opens its
   page; its menu has Sub-project settings and Archived tasks. */
function SubProjectRow({
  id,
  name,
  within,
  setPage,
  onOpenArchivedTasks,
}: {
  id: string
  name: React.ReactNode
  within?: string
  setPage: (page: string) => void
  onOpenArchivedTasks: (projectId: string) => void
}) {
  return (
    <div
      data-subproject-row={id}
      onClick={(e) => {
        if (inRow(e)) setPage(`project:${id}`)
      }}
      // under its open project it hangs from the project's tree line; a
      // search hit stands on its own, naming its project instead
      className={cn(navRowDiv, 'relative', within === undefined && 'planner-subproject pl-6')}
    >
      <Button
        variant="unstyled"
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setPage(`project:${id}`)
        }}
        className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
      >
        {name}
        {within !== undefined && (
          <>
            {' '}
            <span data-subproject-in="" className="ml-1 text-xs font-normal text-text-2">
              in {within}
            </span>
          </>
        )}
      </Button>
      <Popover width={206} align="right" button={menuButton('Sub-project actions')}>
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                close()
                setPage(`project:${id}`)
              }}
            >
              <Icon name="cog" size={16} />
              Sub-project settings
            </MenuItem>
            <MenuItem
              onClick={() => {
                close()
                onOpenArchivedTasks(id)
              }}
            >
              <Icon name="inbox" size={14} />
              Archived tasks
            </MenuItem>
          </>
        )}
      </Popover>
    </div>
  )
}

/** What a batch says in place, after its rows, with Retry: a read that
    stopped without checking anything, anywhere, or a failure of a batch
    before the last, whose own failure the end line gives. */
export function BatchNotes<A, Row>({
  list,
  batch,
  last,
  what,
}: {
  list: PagedList<A, Row>
  batch: PagedList<A, Row>['batches'][number]
  last: boolean
  what: string
}) {
  if (batch.note === null || (batch.note === 'failed' && last)) return null
  return (
    <div
      role="alert"
      data-batch-note={batch.note}
      className={cn(noteClass, 'flex items-center gap-2')}
    >
      {batch.note === 'failed'
        ? `Couldn't load these ${what}.`
        : 'Qivo could not check part of the list.'}
      <Button
        type="button"
        variant="ghost"
        className="h-control-sm text-sm"
        aria-disabled={batch.retrying || undefined}
        onClick={() => !batch.retrying && list.retry(batch.id)}
      >
        {batch.retrying ? 'Loading…' : 'Retry'}
      </Button>
    </div>
  )
}

/* The line that ends an open sub-project list (lib/pagedList.ts listEnd),
   in Settings › Projects (`place` 'settings') or on a project's page. Its
   Load more stays in place, and the Retry of a failed one takes its
   place, so keyboard focus stays. A later batch's refusal or
   `unavailable` shows as a failure, since the live engine fails a later
   batch that answers no rows. */
export function SubProjectsEnd({
  list,
  end,
  place,
  shown,
  onAdd,
  onMore,
  hooks,
  what = 'sub-projects',
  emptyLine,
}: {
  list: PagedList<SettingsListAnswer<unknown>, unknown>
  end: ListEnd
  place: 'settings' | 'page'
  /** whether a row shows, kept rows included */
  shown: boolean
  /** Add sub-project at the real end with no row, for a project the
      caller may create one under */
  onAdd?: (() => void) | null
  onMore: () => void
  /** the data attributes of the end line and of its Load more */
  hooks: { end: string; more: string }
  what?: string
  emptyLine: string
}) {
  const hook = hooks.end
  const line = (text: string, status = false) => (
    <p {...{ [hook]: end }} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  switch (end) {
    case 'loading':
      return line(`Loading ${what}…`, true)
    case 'held':
      return line(
        heldSentence(list.answers[0], {
          notReady: `Sub-projects can't be listed yet. Try again in a few minutes.`,
          unavailable: "This project's sub-projects can't be listed.",
        }),
      )
    case 'failed':
      return (
        <div
          role="alert"
          {...{ [hook]: end }}
          className={cn(noteClass, 'flex flex-wrap items-center gap-2 text-danger')}
        >
          {list.rows.length === 0 ? `Couldn't load its ${what}.` : `Couldn't load more ${what}.`}
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm text-sm"
            onClick={() => list.retry()}
          >
            Retry
          </Button>
        </div>
      )
    case 'full':
      return line(
        place === 'settings'
          ? `Search to find more ${what}.`
          : `Open Settings › Projects and search to find more ${what}.`,
      )
    case 'more':
      return (
        <div {...{ [hook]: end }} className="flex flex-col items-start gap-1">
          {list.stopped && (
            <p className={noteClass}>
              {list.rows.length === 0
                ? 'Qivo checked part of the list and found nothing there yet. Load more continues.'
                : 'Qivo checked part of the list. Load more continues.'}
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            {...{ [hooks.more]: '' }}
            aria-disabled={list.phase === 'more' || undefined}
            onClick={() => list.phase !== 'more' && onMore()}
            className="h-control-sm text-sm"
          >
            {list.phase === 'more' ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )
    case 'partial':
    case 'none':
      return null
    case 'end':
      if (shown) return null
      if (onAdd)
        return (
          <Button
            type="button"
            onClick={onAdd}
            variant="ghost"
            className="[margin:8px_0_8px_24px] h-control-sm [font-size:var(--fs-sm)] [color:var(--text-3)]"
          >
            <Icon name="plus" size={16} />
            Add sub-project
          </Button>
        )
      return line(emptyLine)
  }
}

/* An open project's live sub-projects in Settings › Projects, a batch at a
   time as the list's end scrolls into view or Load more is pressed, up to
   PROJECT_LIST_LIMITS.subProjects. It reads only while it is mounted, so
   closing the project, leaving its page or the page changing stops it.
   A sub-project New sub-project made here (`made`) shows first while the
   store holds it and no loaded batch does. */
function SettingsSubProjects({
  org,
  parent,
  made,
  setPage,
  onOpenArchivedTasks,
  onAdd,
}: {
  org: string
  parent: SettingsProjectRow
  made: readonly string[]
  setPage: (page: string) => void
  onOpenArchivedTasks: (projectId: string) => void
  onAdd: () => void
}) {
  const list = useSubProjects({ org, project: parent.id })
  const end = listEnd(list, false)
  const loaded = new Set(list.rows.map((r) => r.id))
  const keptRows = made.flatMap((id) => {
    const p = loaded.has(id) ? null : P.project(id)
    return p && p.parent === parent.id ? [{ id, name: p.name, num: p.num ?? 0 }] : []
  })
  const tags = tagsOf(org, [
    ...keptRows.map((r) => ({ ...r, parent: parent.id })),
    ...list.rows.map((r) => ({ ...r, parent: parent.id })),
  ])
  const { more, marker } = useLoadMore(
    list,
    end,
    (id) => document.querySelector<HTMLElement>(`[data-subproject-row="${id}"] button`),
    () => document.querySelector<HTMLElement>(`[data-project-row="${parent.id}"] button`),
  )
  const row = (id: string, name: string) => (
    <SubProjectRow
      key={id}
      id={id}
      name={<TaggedName name={name} tag={tags.get(id)} />}
      setPage={setPage}
      onOpenArchivedTasks={onOpenArchivedTasks}
    />
  )
  return (
    <div data-subproject-list={parent.id}>
      {/* one keyed list, so a kept row the server's list takes in keeps
          its element and its focus, and the last row ends the tree line */}
      <div>
        {[
          ...keptRows.map((r) => row(r.id, r.name)),
          ...list.batches.flatMap((batch, i) => [
            ...batch.rows.map((r) => row(r.id, r.name)),
            <BatchNotes
              key={`note:${batch.id}`}
              list={list}
              batch={batch}
              last={i === list.batches.length - 1}
              what="sub-projects"
            />,
          ]),
        ]}
      </div>
      <div ref={marker} aria-hidden="true" className="h-px" />
      <div className="pl-6">
        <SubProjectsEnd
          list={list}
          end={end}
          place="settings"
          shown={list.rows.length + keptRows.length > 0}
          onAdd={offersSubProject(parent) ? onAdd : null}
          onMore={more}
          hooks={{ end: 'data-subprojects-end', more: 'data-subproject-more' }}
          emptyLine="No sub-projects."
        />
      </div>
    </div>
  )
}

/** The arguments of one page of projectSettings.archived, in a fixed key
    order with empty fields left out. */
const archivedArgs = (org: string, search: string, after: string | null) => ({
  org_id: org,
  ...(search === '' ? {} : { search }),
  ...(after === null ? {} : { after }),
})

/** What an open entry's sub-projects told its Restore title: whether a
    loaded one comes back with it, and whether every one has loaded. */
type ChipsInfo = { id: string; withParent: boolean; complete: boolean }

/**
 * Archived projects: one organization's archive 25 entries a page from the
 * server (projectSettings.archived), newest archived first, with a search
 * that also finds sub-projects beneath an archived project. An entry is an
 * archived project or an archived sub-project of a live one; its Restore
 * and Delete come from its own `can_restore` and `can_delete`, and a
 * top-level entry's archived sub-projects load only when asked for, one
 * entry at a time. A search hit beneath an archived project acts only
 * through that project's Restore.
 */
export function ArchivedProjectsPage() {
  // an entry's open sub-projects close as the organization changes (pageAt)
  const [org, setOrg] = useChosenOrg(() => orgFor(null))
  const [text, setText] = useStateS('')
  const search = useSettledSearch(text, LIMITS.search)
  const searchBox = React.useRef<HTMLInputElement>(null)
  const page = usePagedPages({
    key: org ? JSON.stringify(archivedArgs(org, search.settled, null)) : null,
    query: api.projectSettings.archived,
    args: (after) => archivedArgs(org, search.settled, after),
    batch: readyBatch<ArchivedProjectRow>,
  })
  const rows = page.rows
  const searching = search.settled !== ''
  const end = pageEnd(page, searching)
  const heading = () => document.querySelector<HTMLElement>('.settings-page-title h1')
  const move = useMoveFocus(
    page,
    'archived-projects',
    () => document.querySelector<HTMLElement>('[data-archived-project] button:not(:disabled)'),
    () => searchBox.current,
  )
  // the projects whose restore is on its way
  const [busy, setBusy] = useStateS<ReadonlySet<string>>(() => new Set())
  const busyAs = (id: string, on: boolean) =>
    setBusy((was) => {
      const next = new Set(was)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // the entry whose Delete window is open, and the rows on either side of
  // it when it opened, for focus
  const [deleting, setDeleting] = useStateS<ArchivedProjectRow | null>(null)
  const deleteSides = React.useRef<{ next?: string; previous?: string }>({})
  // the entry whose sub-projects show, and what they told its Restore
  const [chipsOpen, setChipsOpen] = useStateS<string | null>(null)
  const [chips, setChips] = useStateS<ChipsInfo | null>(null)
  const pageAt = `${org}:${search.settled}:${page.starts.length}:${String(page.starts.at(-1))}`
  React.useEffect(() => {
    setChipsOpen(null)
    setChips(null)
  }, [pageAt])
  const tags = tagsOf(
    org,
    rows.map((r) => ({ ...r, parent: r.parent?.id })),
  )
  const orgName = P.orgs.length > 1 ? P.orgs.find((o) => o.id === org)?.name : undefined
  const state = pagesState(page)

  const askDelete = (r: ArchivedProjectRow) => {
    const entries = rows.filter((row) => !row.under)
    const at = entries.findIndex((row) => row.id === r.id)
    deleteSides.current = { next: entries[at + 1]?.id, previous: entries[at - 1]?.id }
    setDeleting(r)
  }
  /* Where focus goes when the Delete window closes. That is the row's Delete
     while the row is there, else the next row's first button, the previous
     row's, or the page heading, so focus never falls to the page body. */
  const afterDelete = (id: string) => {
    const own = document.querySelector<HTMLElement>(`[data-delete-project="${id}"]`)
    if (own) return own
    const buttonOf = (row?: string) =>
      row === undefined
        ? null
        : document.querySelector<HTMLElement>(
            `[data-archived-project="${row}"] button:not(:disabled)`,
          )
    const { next, previous } = deleteSides.current
    return buttonOf(next) ?? buttonOf(previous) ?? heading()
  }
  /* The row whose Restore was pressed last, with where focus goes once that
     button has left: the row's own first button where it stays, as a
     sub-project archived on its own does once its project came back, else
     the next row's, the previous row's or the page heading. The row leaves
     with the delivery that restores it, and its Restore, disabled while it
     waits, has left focus nowhere. */
  type Pressed = { row: string; under: boolean; focus: () => HTMLElement | null }
  const [restored, setRestored] = useStateS<Pressed>()
  const pressedShows = (p: Pressed) => rows.some((row) => row.id === p.row && row.under === p.under)
  useFocusWhenGone(!!restored && pressedShows(restored), () => restored?.focus() ?? null)
  // a restore whose button has left is done, so a later change that lists
  // the project and takes it away again moves nothing
  React.useLayoutEffect(() => {
    if (restored && !pressedShows(restored)) setRestored(undefined)
  })
  const focusAfterRender = useFocusAfterRender()
  /** Restores `pressed`'s project, or for a row beneath an archived
      project that project, with the page's organization. */
  const restore = (pressed: ArchivedProjectRow) => {
    const target = pressed.under && pressed.parent ? pressed.parent : pressed
    if (busy.has(target.id)) return
    setRestored({
      row: pressed.id,
      under: pressed.under,
      focus: focusAround(
        'data-archived-project',
        pressed.id,
        (row) => row.querySelector<HTMLElement>('button:not(:disabled)'),
        heading,
      ),
    })
    busyAs(target.id, true)
    void P.unarchiveProject(target.id, { orgId: org }).then((ok: boolean) => {
      busyAs(target.id, false)
      if (ok) {
        window.showToast?.(`Restored “${target.name}”`)
        return
      }
      // the row stays, so a later change that takes it away moves nothing,
      // and its Restore takes back the focus it lost while disabled
      setRestored((shown) => (shown?.row === pressed.id ? undefined : shown))
      focusAfterRender(() =>
        document.querySelector<HTMLElement>(
          pressed.under
            ? `[data-restore-parent="${pressed.id}"]`
            : `[data-restore-project="${pressed.id}"]`,
        ),
      )
    })
  }
  // the window waits for the server, so a refusal leaves it open
  const del = async (r: ArchivedProjectRow, reason: string) => {
    if (!(await P.removeProject(r.id, reason, { orgId: org }))) return false
    setDeleting(null)
    window.showToast?.(`Deleted “${r.name}”`)
    return true
  }
  /** Restore's title for entry `r`: a top-level project with archived
      sub-projects names those archived with it once they loaded, and says
      they come back too before. */
  const restoreTitle = (r: ArchivedProjectRow) => {
    if (r.parent !== null || !r.has_sub_projects) return `Restore “${r.name}”`
    const told = chips?.id === r.id ? chips : null
    if (told?.withParent) return `Restore “${r.name}” and the sub-projects archived with it`
    if (told?.complete) return `Restore “${r.name}”`
    return `Restore “${r.name}”. Sub-projects archived with it come back too.`
  }

  const entry = (r: ArchivedProjectRow) => {
    const parent = r.parent
    const target = r.under && parent ? parent.id : r.id
    const shut = !r.can_restore && !r.can_delete
    return (
      <div
        key={`${r.id}:${r.under ? 'under' : 'entry'}`}
        data-archived-project={r.id}
        data-archived-under={r.under ? '' : undefined}
        className="[border:1px_solid_var(--border)] [border-radius:var(--r-md)] [background:var(--surface-1)] [padding:8px]"
      >
        <div className="[display:flex] [align-items:center] [gap:8px]">
          <div className="[flex:1] [min-width:0]">
            <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
              <TaggedName name={r.name} tag={tags.get(r.id)} />
              {parent && (
                <span className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:500] [color:var(--text-2)]">
                  sub-project of {parent.name}
                  {r.under ? ' (archived)' : ''}
                </span>
              )}
            </div>
            <HoverTooltip content={deletedAtFull(new Date(r.archived_at))}>
              <div
                data-archived-when
                className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono"
              >
                archived {dayInSentence(new Date(r.archived_at), new Date())}
              </div>
            </HoverTooltip>
            {r.under && parent && (
              <div data-archived-under-note="" className="text-xs text-text-2">
                {r.with_parent
                  ? `Comes back when “${parent.name}” is restored.`
                  : `Archived separately. Restore “${parent.name}” first, then restore this sub-project.`}
              </div>
            )}
          </div>
          {r.under && parent ? (
            r.can_restore ? (
              <Button
                type="button"
                data-restore-parent={r.id}
                disabled={busy.has(target)}
                title={`Restore “${parent.name}”. Sub-projects archived with it come back too.`}
                onClick={() => restore(r)}
              >
                <Icon name="rotateCcw" size={16} />
                {busy.has(target) ? 'Restoring…' : `Restore “${parent.name}”`}
              </Button>
            ) : (
              <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] [font-style:italic]">
                only the project's lead can restore it
              </span>
            )
          ) : shut ? (
            <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] [font-style:italic]">
              only the project's lead can restore it
            </span>
          ) : (
            <>
              {r.can_restore && (
                <Button
                  type="button"
                  data-restore-project={r.id}
                  disabled={busy.has(r.id)}
                  title={restoreTitle(r)}
                  onClick={() => restore(r)}
                >
                  <Icon name="rotateCcw" size={16} />
                  {busy.has(r.id) ? 'Restoring…' : 'Restore'}
                </Button>
              )}
              {r.can_delete && (
                <Button
                  type="button"
                  data-delete-project={r.id}
                  className="text-danger"
                  onClick={() => askDelete(r)}
                >
                  <Icon name="trash" size={16} />
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
        {!r.under && parent === null && r.has_sub_projects && (
          <div className="[margin-top:8px]">
            <Button
              type="button"
              variant="ghost"
              data-archived-subs-toggle={r.id}
              aria-expanded={chipsOpen === r.id}
              className="h-control-sm px-1.5 text-sm text-text-2"
              onClick={() => {
                setChips(null)
                setChipsOpen((was) => (was === r.id ? null : r.id))
              }}
            >
              <Icon
                name="chevronRight"
                size={14}
                className={chipsOpen === r.id ? '[transform:rotate(90deg)]' : undefined}
              />
              {chipsOpen === r.id ? 'Hide sub-projects' : 'Show sub-projects'}
            </Button>
            {chipsOpen === r.id && <ArchivedChips org={org} entry={r} onInfo={setChips} />}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <PageTitle>Archived projects</PageTitle>
      <SettingsSection title="Archived projects">
        <OrgChoice
          value={org}
          hook="data-archived-projects-org"
          onChange={(next) => setOrg(next)}
        />
        <ListSearch
          box={searchBox}
          hook="data-archived-projects-search"
          label="Search archived projects and sub-projects"
          value={text}
          onChange={setText}
        />
        <div
          data-archived-projects=""
          data-archived-projects-state={state}
          aria-busy={state === 'loading' || state === 'refreshing' || undefined}
          className="[display:flex] [flex-direction:column] [gap:8px]"
        >
          {rows.map(entry)}
          <PageFold
            page={page}
            end={end}
            hook="archived-projects"
            tooLong={search.tooLong}
            onMove={move}
            words={{
              loading: 'Loading archived projects…',
              notReady: "Archived projects can't be listed yet. Try again in a few minutes.",
              failed: "Couldn't load archived projects.",
              none: 'No archived projects match.',
              empty: orgName ? `No archived projects in ${orgName}.` : 'No archived projects.',
              nomore: searching ? 'No more matches.' : 'No more archived projects.',
            }}
          />
        </div>
        {rows.length > 0 && (
          <FieldHint>
            Sub-projects archived separately need to be restored separately. Deleting a project
            deletes its sub-projects and tasks.
          </FieldHint>
        )}
      </SettingsSection>
      {deleting && (
        <ArchiveOrDeleteProjectModal
          key={deleting.id}
          project={{
            id: deleting.id,
            name: deleting.name,
            type: deleting.parent === null ? 'meta' : 'project',
            orgId: org,
          }}
          deleteOnly
          onClose={() => setDeleting(null)}
          onDelete={(reason) => del(deleting, reason)}
          focusAfterClose={() => afterDelete(deleting.id)}
        />
      )}
    </>
  )
}

/* An archived top-level entry's archived sub-projects
   (projectSettings.archivedSubProjects), read only while shown, a batch at
   a time with Load more up to PROJECT_LIST_LIMITS.chips, each a chip:
   solid when it comes back with the project, dashed when it was archived
   on its own. It tells the page (onInfo) what its Restore title needs. */
function ArchivedChips({
  org,
  entry,
  onInfo,
}: {
  org: string
  entry: ArchivedProjectRow
  onInfo: (info: ChipsInfo) => void
}) {
  const list = usePagedList({
    key: JSON.stringify(childArgs(org, entry.id, BATCH_START)),
    source: {
      kind: 'live',
      query: api.projectSettings.archivedSubProjects,
      args: (b) => childArgs(org, entry.id, b),
    },
    batch: readyBatch<ArchivedChildRow>,
    id: (row: ArchivedChildRow) => row.id,
    most: PROJECT_LIST_LIMITS.chips,
  })
  const end = listEnd(list, false)
  const withParent = list.rows.some((c) => c.with_parent)
  const complete = end === 'end'
  React.useEffect(() => {
    onInfo({ id: entry.id, withParent, complete })
  }, [entry.id, withParent, complete])
  const tags = tagsOf(
    org,
    list.rows.map((r) => ({ ...r, parent: entry.id })),
  )
  const { more } = useLoadMore(
    list,
    end,
    (id) => document.querySelector<HTMLElement>(`[data-archived-sub="${id}"]`),
    () => document.querySelector<HTMLElement>(`[data-archived-subs-toggle="${entry.id}"]`),
  )
  return (
    <div data-archived-subs={entry.id} className="[margin-top:8px]">
      {list.rows.length > 0 && (
        <div className="[display:flex] [flex-wrap:wrap] [gap:8px]">
          {list.rows.map((k) => (
            <HoverTooltip
              content={
                k.with_parent
                  ? `Comes back when “${entry.name}” is restored`
                  : 'Archived separately. Restore the project first, then restore this sub-project.'
              }
              key={k.id}
            >
              <span
                data-archived-sub={k.id}
                data-with-parent={k.with_parent ? '' : undefined}
                tabIndex={-1}
                className={cn(
                  'inline-flex h-6 items-center [font-size:var(--fs-xs)] [padding:0_8px] [border-radius:var(--r-sm)] [border-width:1px] [border-color:var(--border)] [background:var(--surface-1)] outline-none',
                  k.with_parent
                    ? '[border-style:solid] [color:var(--text-1)]'
                    : '[border-style:dashed] [color:var(--text-2)]',
                )}
              >
                <TaggedName name={k.name} tag={tags.get(k.id)} />
              </span>
            </HoverTooltip>
          ))}
        </div>
      )}
      {list.batches.map((batch, i) => (
        <BatchNotes
          key={batch.id}
          list={list}
          batch={batch}
          last={i === list.batches.length - 1}
          what="sub-projects"
        />
      ))}
      <SubProjectsEnd
        list={list}
        end={end}
        place="settings"
        shown={list.rows.length > 0}
        onMore={more}
        hooks={{ end: 'data-archived-subs-end', more: 'data-archived-subs-more' }}
        emptyLine="No archived sub-projects."
      />
    </div>
  )
}
