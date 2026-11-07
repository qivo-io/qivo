/* The sidebar's project tree: the Projects header with New project and the
   person's projects below it, from the server's navigation reads
   (convex/projectNav.ts), each judged by ordinary access, so an
   organization admin's tree holds the projects they take part in, as All
   projects (components/ProjectDirectory.tsx) does. It reads no task.

   - The top-level list is projectNav.page: the person's favorites across
     every seat first, then the rest, each in the server's name order, each
     project once. The favorites sit in a group named Favorite projects,
     each with a star mark that is not a control; stars are set in All
     projects. It loads 25 at first and 25 more as its end scrolls into
     view or Load more is pressed, at most SIDEBAR_MOST.list
     (lib/projectPick.ts), past which it points to All projects.
   - The scope's top-level project, from the workspace (P.project), is the
     one expanded project once a loaded row holds it. Its sub-projects come
     from projectNav.children the same way, at most SIDEBAR_MOST.children,
     past which it asks for a search. A scope move to another project, My
     view or All projects unmounts that list, which stops its read.
   - When the scope's project is not among the loaded rows, the tree reads
     its next batches, one at a time, until one holds it, the list ends,
     reaches its bound, a batch fails or stops without moving, or the rows
     have passed its place in the server's order; the expanded list does
     the same for a scoped sub-project. The row the scope names scrolls
     into the tree's view once, the first time it renders after a scope
     change or the boot, by the tree's own scrollTop, so nothing else
     scrolls and the person's own scrolling is left alone.
   - Rows carry the shared rules of components/projectNavRows.tsx: another
     organization's name on a second line inside the name button, so a
     foreign row's accessible name includes it, number tags for equal
     names among the rows shown, and the open rule, which opens a project
     as the sidebar always has, and for one the workspace does not hold
     yet says so in a toast and moves nothing.
   - New sub-project… in a row's menu, and Add sub-project at a confirmed
     empty end of the expanded list, show where the person leads the
     project in the workspace (P.levelOn), which answers nothing for a
     project the workspace does not hold, so such a row offers neither.
   - No list says it is empty or ended before the server said so: not
     ready, the access_unchecked refusal, a stopped batch, a failure and
     the bound each show as themselves, the refusal and a failure with
     Retry.
   - The tree scrolls without a visible scrollbar (styles/appearance.css),
     and a row that takes focus by anything but a press inside the tree
     scrolls into its view, as a Tab focus does by itself. Load more gives
     focus to the first new row only for the batch the person's press asked
     for; the tree's own loads, as its end scrolls into view or the scope
     rule reads on, never move focus, also after a pressed batch landed.
   - App asks for focus on a row once the tree shows it (FocusRow), as
     after a create whose row comes with the server's answer. The row's
     name button takes focus in the first commit that renders it, if focus
     is nowhere or in a hidden view, and the request goes once the row
     rendered, the scope moved, nothing reads toward the row any more, or
     the tree hides.

   While Settings shows, App keeps the tree mounted and hidden
   (components/KeptView.tsx KeptInPlace): its reads stop and it keeps its
   rows and its place, and coming back reads the same batches again,
   `refreshing` until they answered (lib/pagedList.ts). While the tab is
   hidden every read stops and the scope rule waits. */

import { compareValues } from 'convex/values'
import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { api } from '../../convex/_generated/api'
import { nameKey } from '../../convex/lib/nameKey'
import type {
  NavChildRow,
  NavChildren,
  NavPage,
  NavPageRow,
  NavProject,
} from '../../convex/model/projectNavReads'
import { restoreFocus } from '../lib/focusVisibility'
import { menuTrigger } from '../lib/focusWhenGone'
import { useLoadMore } from '../lib/loadMore'
import { type ListEnd, listEnd, type PagedList, usePagedList } from '../lib/pagedList'
import { SIDEBAR_MOST } from '../lib/projectPick'
import { cn } from '../lib/utils'
import { OUT_OF_USE } from '../lib/viewHidden'
import { useViewVisibility } from '../lib/viewVisibility'
import { P } from '../store/planner'
import { navRowDiv } from './navRow'
import {
  CHILDREN_WORDS,
  foreignOrg,
  heldText,
  navCursors,
  navTags,
  openNavProject,
  tagged,
} from './projectNavRows'
import { Icon, MenuItem, Popover } from './qivo'
import { Button } from './ui/button'

type Actions = Record<string, (...args: unknown[]) => void>

/** App's request to focus row `id` once the tree shows it; `n` tells two
    requests apart. */
export type FocusRow = { id: string; n: number }

/** The top-level list's identity, one list across every seat. */
const TREE_KEY = JSON.stringify(['sidebar'])

const noteClass = 'px-2 py-1 text-sm text-text-2'
const childNoteClass = 'py-1 pr-2 pl-6 text-sm text-text-2'

/** The place of a project named `name` with id `id` in the server's name
    order, tied by the id. */
const placeOf = (name: string, id: string) => [nameKey(name), id]

/** Whether `last`, the last row a list in the server's name order has
    loaded, sorts after the place of a project named `name` with id `id`,
    so no later batch of that order holds it. */
const after = (last: NavProject | undefined, name: string, id: string) =>
  !!last && compareValues(placeOf(last.name, last.id), placeOf(name, id)) > 0

/** Whether the top-level rows `rows` have passed the place of the project
    named `name` with id `id`: a row that is no favorite has loaded, so the
    favorites are complete, and the last row sorts after it among the rest. */
function passedTop(rows: readonly NavPageRow[], name: string, id: string) {
  const last = rows.at(-1)
  return last?.favorite === false && after(last, name, id)
}

/** Scrolls the tree `list` by its own scrollTop, and nothing around it, so
    `row` shows whole in it, or from its top where it is taller. */
function intoTreeView(list: HTMLElement, row: Element) {
  const box = row.getBoundingClientRect()
  const view = list.getBoundingClientRect()
  if (box.top < view.top) list.scrollTop -= view.top - box.top
  else if (box.bottom > view.bottom)
    list.scrollTop += Math.min(box.bottom - view.bottom, box.top - view.top)
}

/** Whether focus is nowhere, or in a view hidden behind another page. */
const focusOutOfUse = () => {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected || !!active.closest(OUT_OF_USE)
}

/** Whether a list reads now or is about to: its first batch or a split on
    their way, Load more, or the same batches again after it showed again,
    whose answers may hold what the earlier ones did not. */
const reading = (list: Pick<PagedList<unknown, unknown>, 'phase' | 'refreshing'>, end: ListEnd) =>
  end === 'loading' || list.phase === 'more' || list.refreshing

/**
 * The sidebar's project tree, on the rules in the module header. `scope`
 * is App's scope, `lit` whether a row lights for it, `actions` App's
 * (openProject, openProjects, openSettings, openArchivedTasks and
 * newProject) and `focusRow` App's latest focus request.
 */
export function SidebarProjects({
  scope,
  lit,
  actions,
  focusRow,
}: {
  scope: string
  lit: (id: string) => boolean
  actions: Actions
  focusRow: FocusRow | null
}) {
  const tree = useRef<HTMLDivElement>(null)
  const { visible } = useViewVisibility()
  const list = usePagedList<NavPage, NavPageRow>({
    key: TREE_KEY,
    source: { kind: 'live', query: api.projectNav.page, args: navCursors },
    // an answer without rows, not ready or refused, is held and worded
    batch: (answer) => (answer.state === 'ok' ? answer : null),
    id: (row) => row.id,
    most: SIDEBAR_MOST.list,
  })
  const end = listEnd(list, false)

  // the scope's top-level project, its own id or its parent's
  const scopeProject = P.project(scope)
  const owner = scopeProject
    ? scopeProject.type === 'meta'
      ? scopeProject.id
      : (scopeProject.parent ?? null)
    : null
  const ownerName = owner === null ? undefined : P.project(owner)?.name
  const ownerRow = owner === null ? undefined : list.rows.find((r) => r.id === owner)

  /* Whether the batch the person asked for by pressing Load more is still
     on its way, so its focus rule, which moves focus that is nowhere once
     Load more goes, acts only for that press's own batch: the tree loads
     by itself as its end comes into view and as the scope rule reads on,
     also before anyone touched the page and after a pressed batch landed
     with more to come, and must never take focus for that. */
  const pressedMore = useRef(false)
  const { more, marker } = useLoadMore(
    list,
    end,
    (id) =>
      pressedMore.current
        ? (tree.current?.querySelector<HTMLElement>(`[data-project-row="${id}"] button`) ?? null)
        : null,
    () =>
      !pressedMore.current
        ? null
        : (tree.current?.querySelector<HTMLElement>('[data-sidebar-all]') ??
          [
            ...(tree.current?.querySelectorAll<HTMLElement>('[data-project-row] > button') ?? []),
          ].at(-1) ??
          null),
  )
  // after useLoadMore's focus rule, which reads the flag first; a pressed
  // batch that landed with more to come counts no more
  useLayoutEffect(() => {
    if (end !== 'more' || list.phase === 'ready') pressedMore.current = false
  })

  // the scope rule: read on, a batch at a time, until a batch holds the
  // scope's project, within the bound and while each batch moved
  const seek =
    owner !== null &&
    !ownerRow &&
    visible &&
    end === 'more' &&
    list.phase === 'ready' &&
    !list.partial &&
    !(ownerName !== undefined && passedTop(list.rows, ownerName, owner))
  // each landed batch asks again, also where its render met seek unchanged
  useEffect(() => {
    if (!seek) return
    pressedMore.current = false
    list.more()
  }, [seek, list.batches.length, list.rows.length])

  // whether the expanded list still reads toward the scope's sub-project,
  // which its own layout effect writes before this component's run
  const childrenSeek = useRef(false)

  // the row the scope names, revealed once after a scope change, and App's
  // focus request, taken once for the scope it was made in
  const revealed = useRef<string | null>(null)
  const taken = useRef<number | null>(null)
  const request = useRef<{ id: string; scope: string } | null>(null)
  /* Looks at the rows after each commit of the tree, and of its expanded
     list, which renders on its own as its batches land: the row the scope
     names scrolls into view the first time it shows after a scope change,
     and the requested row takes focus the first time it shows. It reads
     this render's values, which stay the tree's latest until it renders
     again. */
  const settle = useRef(() => {})
  settle.current = () => {
    const box = tree.current
    if (!box) return
    if (revealed.current !== scope) {
      const row = box.querySelector(
        `[data-project-row="${scope}"], [data-subproject-row="${scope}"]`,
      )
      if (row) {
        revealed.current = scope
        intoTreeView(box, row)
      }
    }
    const asked = request.current
    if (!asked) return
    if (asked.scope !== scope) {
      request.current = null
      return
    }
    const control = box.querySelector<HTMLElement>(
      `[data-project-row="${asked.id}"] > button, [data-subproject-row="${asked.id}"] > button`,
    )
    if (control) {
      request.current = null
      if (focusOutOfUse()) restoreFocus(control)
      return
    }
    // nothing reads toward the row any more
    if (!seek && !reading(list, end) && !childrenSeek.current) request.current = null
  }
  useLayoutEffect(() => {
    if (focusRow && taken.current !== focusRow.n) {
      taken.current = focusRow.n
      request.current = { id: focusRow.id, scope }
    }
    settle.current()
  })
  // a tree that hides drops the request, so it takes no focus on return
  useLayoutEffect(
    () => () => {
      request.current = null
    },
    [],
  )

  // a row focused by anything but a press inside the tree scrolls into its
  // view, as a Tab focus does by itself
  const pressed = useRef(false)

  const tags = navTags(list.rows)
  const say = (line: string) => window.showToast?.(line, 'info')
  const open = (row: NavProject) => openNavProject(row, actions, say)
  /* A press on a row opens it. A pick in its menu, portaled out of the
     row, reaches the row too, and moves the scope as it always has, only
     where the workspace holds the project, never saying it has not
     loaded. */
  const pressRow = (e: MouseEvent<HTMLElement>, row: NavProject) => {
    if (e.target instanceof Node && e.currentTarget.contains(e.target)) open(row)
    else if (P.project(row.id)) actions.openProject(row.id)
  }

  const topRow = (row: NavPageRow) => {
    const org = foreignOrg(row.org_id)
    const on = lit(row.id)
    return (
      <div key={row.id} className="[margin-bottom:2px]">
        <div
          data-project-row={row.id}
          data-on={on ? '' : undefined}
          className={cn(navRowDiv, 'hoverrow gap-1 font-semibold')}
          onClick={(e) => pressRow(e, row)}
        >
          <Button
            variant="unstyled"
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={(e) => {
              e.stopPropagation()
              open(row)
            }}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
          >
            {org ? (
              <>
                <span className="block truncate">
                  {tagged({ name: row.name, tag: tags.get(row.id), truncate: true })}
                </span>
                <span
                  data-sidebar-org=""
                  className="block truncate text-xs font-normal text-text-2"
                >
                  {org}
                </span>
              </>
            ) : (
              tagged({ name: row.name, tag: tags.get(row.id), truncate: true })
            )}
          </Button>
          {/* the favorites' mark, not a control: a press on it opens the
             project through the row, and stars are set in All projects */}
          {row.favorite && (
            <span data-sidebar-favorite="" aria-hidden="true" className="flex text-text-3">
              <Icon name="star" size={14} className="fill-current" />
            </span>
          )}
          {/* Keep one trailing action target so ordinary project names
            fit the rail. The menu retains New sub-project for leads. */}
          <Popover
            width={196}
            align="right"
            button={(t) => (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="w-control-xs h-control-xs"
                aria-label="Project actions"
                onClick={(e) => {
                  e.stopPropagation()
                  t()
                }}
              >
                <Icon name="more" size={16} />
              </Button>
            )}
          >
            {(close) => (
              <>
                {P.levelOn(row.id) === 'lead' && (
                  <MenuItem
                    onClick={(e) => {
                      const trigger = menuTrigger(e.currentTarget)
                      close()
                      actions.newProject({ parent: row.id }, () => trigger)
                    }}
                  >
                    <Icon name="plus" size={16} />
                    New sub-project…
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    close()
                    actions.openSettings(`project:${row.id}`)
                  }}
                >
                  <Icon name="cog" size={16} />
                  Project settings
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    actions.openArchivedTasks(row.id)
                  }}
                >
                  <Icon name="inbox" size={14} />
                  Archived tasks
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
        {row.id === owner && (
          <SidebarChildren
            key={row.id}
            parent={row}
            scope={scope}
            lit={lit}
            actions={actions}
            onOpen={open}
            onPress={pressRow}
            onSeeking={(on) => {
              childrenSeek.current = on
            }}
            onCommit={settle}
          />
        )}
      </div>
    )
  }

  // the rows in the server's order, the leading favorites in their group,
  // each batch's note after its rows in the group of its last row
  const favorites: ReactNode[] = []
  const rest: ReactNode[] = []
  let group = rest
  list.batches.forEach((batch, i) => {
    for (const row of batch.rows) {
      group = row.favorite ? favorites : rest
      group.push(topRow(row))
    }
    group.push(
      <BatchNote
        key={`note:${batch.id}`}
        list={list}
        batch={batch}
        last={i === list.batches.length - 1}
        what="your projects"
        hook="data-sidebar-note"
        className={noteClass}
      />,
    )
  })

  const state =
    list.phase === 'first'
      ? 'loading'
      : list.phase === 'held'
        ? 'held'
        : list.phase === 'failed'
          ? 'failed'
          : list.refreshing
            ? 'refreshing'
            : 'ok'
  const canCreateProject = P.canCreateProject()
  return (
    <div
      ref={tree}
      data-sidebar-projects=""
      data-sidebar-projects-state={state}
      aria-busy={state === 'loading' || state === 'refreshing' || undefined}
      className="planner-project-list min-h-0 flex-[0_1_auto] overflow-y-auto overscroll-contain [padding:4px_12px_0]"
      onPointerDownCapture={() => {
        pressed.current = true
        setTimeout(() => {
          pressed.current = false
        })
      }}
      onFocus={(e) => {
        const row =
          e.target instanceof Element
            ? e.target.closest('[data-project-row], [data-subproject-row]')
            : null
        if (!pressed.current && row && tree.current?.contains(row)) intoTreeView(tree.current, row)
      }}
    >
      <div className="[display:flex] [align-items:center] [gap:8px] [min-height:32px] [padding:8px_8px]">
        <span className="[font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-3)]">
          Projects
        </span>
        <div className="[flex:1]" />
        {canCreateProject && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-control-xs h-control-xs"
            aria-label="New project"
            onClick={() => actions.newProject({ kind: 'program' })}
          >
            <Icon name="plus" size={16} />
          </Button>
        )}
      </div>
      {favorites.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: a group of rows, not a form's fieldset
        <div role="group" aria-label="Favorite projects" data-sidebar-group="favorites">
          {favorites}
        </div>
      )}
      {rest.length > 0 && <div data-sidebar-group="rest">{rest}</div>}
      {/* the marker comes with the first rows, below them, so it is not
         taken as in view from before they landed, which would load the
         next batch at once */}
      {list.rows.length > 0 && <div ref={marker} aria-hidden="true" className="h-px" />}
      <TreeEnd
        list={list}
        end={end}
        onMore={() => {
          pressedMore.current = true
          more()
        }}
        onAll={() => actions.openProjects()}
      />
    </div>
  )
}

/** The note of a batch above the last that failed, or of any batch that
    stopped without moving, with Retry, after that batch's rows. */
function BatchNote<A, Row>({
  list,
  batch,
  last,
  what,
  hook,
  className,
}: {
  list: PagedList<A, Row>
  batch: PagedList<A, Row>['batches'][number]
  last: boolean
  what: string
  hook: 'data-sidebar-note' | 'data-sidebar-children-note'
  className: string
}) {
  if (batch.note === null || (batch.note === 'failed' && last)) return null
  return (
    <div
      role="status"
      {...{ [hook]: batch.note }}
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      {batch.note === 'stuck'
        ? `Qivo could not check part of ${what}.`
        : `Couldn't load part of ${what}.`}
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

/* The line that ends the top-level list (lib/pagedList.ts listEnd). Its
   Load more stays in place while it reads, so keyboard focus stays on it.
   The access_unchecked refusal and a failure offer Retry; not ready
   answers by itself once the server is ready. Past the bound it points to
   All projects. Its end says nothing after rows, and that the person has
   no active project only with none. */
function TreeEnd({
  list,
  end,
  onMore,
  onAll,
}: {
  list: PagedList<NavPage, NavPageRow>
  end: ListEnd
  onMore: () => void
  onAll: () => void
}) {
  const line = (text: string, role?: 'status' | 'alert') => (
    <p data-sidebar-end={end} role={role} className={noteClass}>
      {text}
    </p>
  )
  const retry = (text: string, role?: 'alert') => (
    <div
      data-sidebar-end={end}
      role={role}
      className={cn('flex flex-wrap items-center gap-2', noteClass)}
    >
      {text}
      <Button variant="ghost" className="h-control-sm text-sm" onClick={() => list.retry()}>
        Retry
      </Button>
    </div>
  )
  switch (end) {
    case 'loading':
      return line('Loading projects…', 'status')
    case 'held': {
      const answer = list.answers[0]
      return answer?.state === 'unavailable' && answer.reason === 'access_unchecked'
        ? retry(heldText(answer, 'page'))
        : line(heldText(answer, 'page'))
    }
    case 'failed':
      return retry(
        list.rows.length === 0 ? "Couldn't load your projects." : "Couldn't load more projects.",
        'alert',
      )
    case 'full':
      return (
        <div data-sidebar-end={end} className={cn('flex flex-wrap items-center gap-2', noteClass)}>
          More projects are in All projects.
          <Button
            variant="ghost"
            data-sidebar-all=""
            className="h-control-sm text-sm"
            onClick={onAll}
          >
            Open All projects
          </Button>
        </div>
      )
    case 'more':
      return (
        <div data-sidebar-end={end} className="flex flex-wrap items-center gap-2 px-1 pb-2">
          {list.stopped && <span className={noteClass}>Qivo checked part of your projects.</span>}
          <Button
            variant="ghost"
            data-sidebar-more=""
            aria-disabled={list.phase === 'more' || undefined}
            onClick={() => list.phase !== 'more' && onMore()}
            className="h-control-sm text-sm text-text-2"
          >
            {list.phase === 'more' ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )
    case 'end':
      // the list's end after its rows says nothing
      if (list.rows.length > 0) return <span data-sidebar-end={end} hidden />
      return line(
        P.isAdmin()
          ? 'No active projects. Settings › Projects › All projects lists every project of your organization.'
          : 'No active projects.',
      )
    default:
      // a batch's own note says why the end is unknown
      return <span data-sidebar-end={end} hidden />
  }
}

/* The live sub-projects of the expanded project `parent`
   (projectNav.children), 25 at first and 25 more as the list's end scrolls
   into view or Load more is pressed, up to SIDEBAR_MOST.children. The rows
   are siblings in one container with each batch's note after its rows, so
   the branch line ends on the last row (styles/appearance.css), and the
   marker and the end line follow it. It reads only while it is mounted, so
   a scope move away stops it. A scoped sub-project the rows do not hold is
   read on toward, as the top-level list reads on toward the scope's
   project, and `onSeeking` tells the tree whether it still is. After each
   of its commits it hands the rows to the tree's `onCommit`. */
function SidebarChildren({
  parent,
  scope,
  lit,
  actions,
  onOpen,
  onPress,
  onSeeking,
  onCommit,
}: {
  parent: NavProject
  scope: string
  lit: (id: string) => boolean
  actions: Actions
  onOpen: (row: NavProject) => void
  onPress: (e: MouseEvent<HTMLElement>, row: NavProject) => void
  onSeeking: (seeking: boolean) => void
  onCommit: { current: () => void }
}) {
  const { visible } = useViewVisibility()
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
    most: SIDEBAR_MOST.children,
  })
  const end = listEnd(list, false)

  // the scoped sub-project, when the scope is one of this project's
  const scoped = P.project(scope)
  const target = scoped && scoped.type !== 'meta' && scoped.parent === parent.id ? scoped : null
  // as the tree's own list, Load more's focus rule acts only for the batch
  // a press asked for
  const pressedMore = useRef(false)
  const { more, marker } = useLoadMore(
    list,
    end,
    (id) =>
      pressedMore.current
        ? document.querySelector<HTMLElement>(
            `[data-sidebar-children="${parent.id}"] [data-subproject-row="${id}"] > button`,
          )
        : null,
    () =>
      pressedMore.current
        ? document.querySelector<HTMLElement>(
            `[data-sidebar-projects] [data-project-row="${parent.id}"] > button`,
          )
        : null,
  )
  useLayoutEffect(() => {
    if (end !== 'more' || list.phase === 'ready') pressedMore.current = false
  })
  const seek =
    target !== null &&
    !list.rows.some((r) => r.id === target.id) &&
    visible &&
    end === 'more' &&
    list.phase === 'ready' &&
    !list.partial &&
    !after(list.rows.at(-1), target.name, target.id)
  // each landed batch asks again, also where its render met seek unchanged
  useEffect(() => {
    if (!seek) return
    pressedMore.current = false
    list.more()
  }, [seek, list.batches.length, list.rows.length])
  // the tree's focus request waits while this list still reads toward the
  // scope's sub-project
  useLayoutEffect(() => {
    onSeeking(
      target !== null && !list.rows.some((r) => r.id === target.id) && (seek || reading(list, end)),
    )
  })
  useLayoutEffect(() => () => onSeeking(false), [])
  // after onSeeking, so the tree reads this commit's seeking
  useLayoutEffect(() => onCommit.current())

  const tags = navTags(list.rows, () => parent)
  const lead = P.levelOn(parent.id) === 'lead'
  return (
    <>
      <div data-sidebar-children={parent.id}>
        {list.batches.flatMap((batch, i) => [
          ...batch.rows.map((row) => (
            // Compact branch lines show the hierarchy beside the names.
            // ONE SELECTION IDIOM in the rail: a selected sub-project is
            // the same LIFTED TILE as a selected project row, the inbox
            // and the two sentinels — --surface-1 under --qivo-shadow-card.
            // Depth is carried by this indent and the 600 weight, not by a
            // second colour language, which is what frees --accent-soft
            // from doing six unrelated jobs at once.
            <div
              key={row.id}
              data-subproject-row={row.id}
              data-on={lit(row.id) ? '' : undefined}
              onClick={(e) => onPress(e, row)}
              className={cn(navRowDiv, 'planner-subproject relative pl-6')}
            >
              <Button
                variant="unstyled"
                type="button"
                aria-current={lit(row.id) ? 'page' : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(row)
                }}
                className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
              >
                {tagged({ name: row.name, tag: tags.get(row.id) })}
              </Button>
              <Popover
                width={206}
                align="right"
                button={(t) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="w-control-xs h-control-xs"
                    aria-label="Sub-project actions"
                    onClick={(e) => {
                      e.stopPropagation()
                      t()
                    }}
                  >
                    <Icon name="more" size={16} />
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem
                      onClick={() => {
                        close()
                        actions.openSettings(`project:${row.id}`)
                      }}
                    >
                      <Icon name="cog" size={16} />
                      Sub-project settings
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close()
                        actions.openArchivedTasks(row.id)
                      }}
                    >
                      <Icon name="inbox" size={14} />
                      Archived tasks
                    </MenuItem>
                  </>
                )}
              </Popover>
            </div>
          )),
          <BatchNote
            key={`note:${batch.id}`}
            list={list}
            batch={batch}
            last={i === list.batches.length - 1}
            what="the sub-projects"
            hook="data-sidebar-children-note"
            className={childNoteClass}
          />,
        ])}
      </div>
      {list.rows.length > 0 && <div ref={marker} aria-hidden="true" className="h-px" />}
      <ChildrenEnd
        list={list}
        end={end}
        onMore={() => {
          pressedMore.current = true
          more()
        }}
        onAdd={lead ? () => actions.newProject({ parent: parent.id }) : null}
      />
    </>
  )
}

/* The line that ends the expanded list, in the directory's words
   (projectNavRows.tsx CHILDREN_WORDS). At a confirmed empty end a lead
   gets Add sub-project, and anyone else the sentence that they can open
   none; Add sub-project never shows while the list loads, is held, failed
   or stopped. */
function ChildrenEnd({
  list,
  end,
  onMore,
  onAdd,
}: {
  list: PagedList<NavChildren, NavChildRow>
  end: ListEnd
  onMore: () => void
  onAdd: (() => void) | null
}) {
  const line = (text: string, role?: 'status') => (
    <p data-sidebar-children-end={end} role={role} className={childNoteClass}>
      {text}
    </p>
  )
  const retry = (text: string, role?: 'alert') => (
    <div
      data-sidebar-children-end={end}
      role={role}
      className={cn('flex flex-wrap items-center gap-2', childNoteClass)}
    >
      {text}
      <Button variant="ghost" className="h-control-sm text-sm" onClick={() => list.retry()}>
        Retry
      </Button>
    </div>
  )
  switch (end) {
    case 'loading':
      return line(CHILDREN_WORDS.loading, 'status')
    case 'held': {
      const answer = list.answers[0]
      // the refusal of a check the server could not finish offers Retry;
      // not ready answers by itself, and a project the person cannot open
      // has nothing to read again
      return answer?.state === 'unavailable' && answer.reason === 'access_unchecked'
        ? retry(heldText(answer, 'children'))
        : line(heldText(answer, 'children'))
    }
    case 'failed':
      return retry(
        list.rows.length === 0 ? CHILDREN_WORDS.failed : CHILDREN_WORDS.failedMore,
        'alert',
      )
    case 'full':
      return line(CHILDREN_WORDS.full)
    case 'more':
      return (
        <div data-sidebar-children-end={end} className="flex flex-wrap items-center gap-2 pl-5">
          {list.stopped && <span className={noteClass}>{CHILDREN_WORDS.stopped}</span>}
          <Button
            variant="ghost"
            data-sidebar-children-more=""
            aria-disabled={list.phase === 'more' || undefined}
            onClick={() => list.phase !== 'more' && onMore()}
            className="h-control-sm text-sm text-text-2"
          >
            {list.phase === 'more' ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )
    case 'end':
      if (list.rows.length > 0) return <span data-sidebar-children-end={end} hidden />
      return onAdd ? (
        <Button
          type="button"
          data-sidebar-children-end={end}
          onClick={onAdd}
          variant="ghost"
          className="[margin:8px_0_8px_24px] h-control-sm [font-size:var(--fs-sm)] [color:var(--text-3)]"
        >
          <Icon name="plus" size={16} />
          Add sub-project
        </Button>
      ) : (
        line(CHILDREN_WORDS.empty)
      )
    default:
      return <span data-sidebar-children-end={end} hidden />
  }
}
