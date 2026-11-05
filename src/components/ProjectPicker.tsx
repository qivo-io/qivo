/* The shared project picker, which Search's Search in and Settings ›
   Archived tasks open, and which Deleted items and startup selection can
   take later. It lists the person's projects from the server's navigation
   reads (convex/projectNav.ts), never from the workspace's projects, each
   judged by ordinary access, and picks by the rules of its caller
   (lib/projectPick.ts): one project, or several of one organization, or
   the fixed rows All projects and an organization's All projects.

   - The browse list is projectNav.page, the person's top-level projects 25
     at a time, their favorites first, with Load more. Once typing rests
     SEARCH_DELAY_MS, a text with a name key lists projectNav.search, the
     projects and sub-projects whose own name holds every word typed, each
     sub-project with its project; a text of spaces and accents only, whose
     name key is empty, browses, as the server refuses it. A picker of one
     organization whose pick holds projects sends their organization's
     org_id when the login holds several seats, and shows the other
     organizations' rows without a press; All projects of an organization
     leaves every row open. A top-level row's arrow lists its sub-projects
     (projectNav.children), one row at a time.
   - Each list reads through the shared paged list (lib/pagedList.ts) with
     live batches, which stop while the tab or the desktop window is
     hidden. A new text, organization or expanded row starts its list at
     the first batch and drops the older one's batches, so no older answer
     replaces a newer one, and rows clear until the new one answers. The
     panel mounts only while the picker is open, so a closed picker reads
     nothing.
   - At most PROJECT_PICKER_MOST.list rows a list (eight batches), then
     "Search to find more projects.", and PROJECT_PICKER_MOST.children
     sub-projects under one project (lib/projectPick.ts).
   - No list says it found nothing or ended before the server said so. A
     list the server holds back (not ready, or a check it could not finish)
     says why and never shows an empty list as complete; a stopped batch
     says Qivo checked part of the projects and offers Load more; a failed
     one offers Retry. The fixed rows need no read and stay usable.
   - Equal names of one organization and parent among the rows shown carry
     their number, "Test #4" (store/viewModels.ts duplicateNameTags).

   Keyboard: the search field takes focus as the picker opens. Up and Down
   move between the rows, Enter picks the active row, Right expands and
   Left collapses a top-level row when the caret is at the text's end or
   start, and Escape clears the text first and then closes the picker
   alone, which gives focus back to its trigger. */

import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { limitSentence } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import {
  type BatchAt,
  type ListEnd,
  listEnd,
  type PagedList,
  usePagedList,
  useSettledSearch,
} from '../lib/pagedList'
import {
  covered,
  type FixedPick,
  isFixedPick,
  PICK_MOST,
  type PickedProject,
  type PickRules,
  PROJECT_PICKER_MOST,
  type ProjectPick,
  pickLabel,
  pickRow,
  placeName,
  refusalOf,
} from '../lib/projectPick'
import { useMobile } from '../lib/useMobile'
import { P } from '../store/planner'
import { duplicateNameTags } from '../store/viewModels'
import { Icon, Popover } from './qivo'

/** The cursors of one batch, absent ones left out, as the reads take them. */
const cursors = (at: BatchAt) => ({
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

/** A row of the panel: a fixed row, or a project with its parent and
    favorite state, `child` for one listed under its expanded parent. */
type Entry =
  | { kind: 'fixed'; key: string; fixed: FixedPick; label: string }
  | { kind: 'row'; key: string; row: PickedProject; favorite: boolean | null; child: boolean }

/** The sentence a list's held answer carries, with its note's mark, or
    null for an answer with rows. `what` names what the list holds. */
function heldNote(
  answer: NavPage | NavSearch | NavChildren | undefined,
  what: 'projects' | 'sub-projects',
): { mark: string; text: string } | null {
  if (!answer || answer.state === 'ok') return null
  if (answer.state === 'not_ready')
    return { mark: 'not_ready', text: 'Qivo is still preparing your project list.' }
  if (answer.reason === 'access_unchecked')
    return {
      mark: 'unchecked',
      text: answer.message ?? 'Qivo could not finish checking which projects you can see.',
    }
  return {
    mark: 'unavailable',
    text:
      what === 'sub-projects'
        ? 'You can no longer open this project.'
        : 'Qivo cannot list your projects.',
  }
}

const noteClass = 'px-2 py-1 text-sm text-text-2'

/** A list's notes and its end line, from `end` and its first answer. */
function ListLines({
  list,
  end,
  held,
  what,
  empty,
  none,
  onMore,
}: {
  list: PagedList<unknown, unknown>
  end: ListEnd | 'too_long'
  held: { mark: string; text: string } | null
  what: 'projects' | 'sub-projects'
  /** the line for a list that ended with no row, null for none */
  empty: string | null
  /** the line for a search that matched nothing */
  none: string
  onMore: () => void
}): ReactNode {
  const note = (mark: string, children: ReactNode, alert = false) => (
    <div
      role={alert ? 'alert' : 'status'}
      data-project-picker-note={mark}
      className={cn('flex flex-wrap items-center gap-2', noteClass)}
    >
      {children}
    </div>
  )
  if (end === 'too_long') return note('too_long', limitSentence(LIMITS.search))
  if (end === 'loading') return note('loading', `Loading ${what}…`)
  if (end === 'held') return held ? note(held.mark, held.text) : null
  if (end === 'failed')
    return note(
      'failed',
      <>
        {list.rows.length === 0 ? `Couldn't load your ${what}.` : `Couldn't load more ${what}.`}
        <Button
          type="button"
          variant="ghost"
          className="h-control-sm text-sm"
          onClick={() => list.retry()}
        >
          Retry
        </Button>
      </>,
      true,
    )
  if (end === 'full') return note('full', `Search to find more ${what}.`)
  if (end === 'more')
    return (
      <div className="flex flex-wrap items-center gap-2 px-1">
        {list.stopped && (
          <span data-project-picker-note="stopped" className={noteClass}>
            Qivo checked part of your {what}.
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          data-project-picker-more=""
          aria-disabled={list.phase === 'more' || undefined}
          onClick={onMore}
          className="h-control-sm text-sm"
        >
          {list.phase === 'more' ? 'Loading…' : 'Load more'}
        </Button>
      </div>
    )
  if (end === 'none') return note('none', none)
  if (end === 'end' && list.rows.length === 0 && empty) return note('empty', empty)
  return null
}

/** The notes of batches above the last that failed, and of any batch that
    stopped without moving, with Retry, after that batch's rows. */
function BatchNote({
  list,
  batch,
  last,
  what,
}: {
  list: PagedList<unknown, unknown>
  batch: PagedList<unknown, unknown>['batches'][number]
  last: boolean
  what: 'projects' | 'sub-projects'
}) {
  if (batch.note === null || (batch.note === 'failed' && last)) return null
  return (
    <div
      role="status"
      data-project-picker-note={batch.note === 'stuck' ? 'stopped' : 'failed'}
      className={cn('flex flex-wrap items-center gap-2', noteClass)}
    >
      {batch.note === 'stuck'
        ? `Qivo checked part of your ${what}.`
        : `Couldn't load part of your ${what}.`}
      <Button
        type="button"
        variant="ghost"
        className="h-control-sm text-sm"
        aria-disabled={batch.retrying || undefined}
        onClick={() => list.retry(batch.id)}
      >
        {batch.retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}

/** The organization's name for a row of another organization than the
    home one, as Search's results name it. */
const foreignOrg = (org: string): string | null =>
  org === P.homeOrg ? null : (P.orgs.find((o) => o.id === org)?.name ?? null)

/** What the panel asks of its caller. */
export type ProjectPickerPanelProps = {
  pick: ProjectPick | null
  onPick: (pick: ProjectPick | null) => void
  rules: PickRules
  /** called after a pick in one mode, which closes a popover */
  onDone?: () => void
  /** why another organization's rows take no press under `oneOrg` */
  oneOrgNote?: string
  /** the search field's accessible name */
  label?: string
}

/**
 * The picker's list with its own search field, for a caller that embeds
 * it, as ProjectPicker does in its popover.
 */
export function ProjectPickerPanel({
  pick,
  onPick,
  rules,
  onDone,
  oneOrgNote = 'Choose projects of one organization at a time.',
  label = 'Search projects',
}: ProjectPickerPanelProps) {
  const id = useId()
  // a sub-project's text sits 16 px past its project's, which follows the
  // project's arrow, a 44 px touch target on a phone
  const childIndent = useMobile() ? 'pl-[62px]' : 'pl-[50px]'
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const term = nameKey(search.settled)
  const browsing = term === ''
  // a picker of one organization lists another's rows without a press once
  // its pick holds projects, and searches only theirs
  const orgOnly = rules.oneOrg && pick?.kind === 'projects' ? pick.org_id : null
  // a login of one seat searches that seat alike either way, so its first
  // pick keeps the batches loaded
  const searchOrg = P.orgs.length > 1 ? orgOnly : null
  const mainKey = JSON.stringify(browsing ? ['page'] : ['search', searchOrg, term])
  const main = usePagedList<NavPage | NavSearch, NavPageRow | NavSearchRow>({
    key: mainKey,
    source: {
      kind: 'live',
      query: browsing ? api.projectNav.page : api.projectNav.search,
      args: (at) =>
        browsing
          ? cursors(at)
          : {
              search: search.settled,
              ...(searchOrg === null ? {} : { org_id: searchOrg }),
              ...cursors(at),
            },
    },
    // an answer without rows, not ready or refused, is held and worded
    batch: (answer) => (answer.state === 'ok' ? answer : null),
    id: (row) => row.id,
    most: PROJECT_PICKER_MOST.list,
  })
  // the one top-level row whose sub-projects show; a new list collapses it
  const [expanded, setExpanded] = useState<NavProject | null>(null)
  const kidsKey = expanded ? JSON.stringify(['children', expanded.id]) : null
  const kids = usePagedList<NavChildren, NavChildRow>({
    key: kidsKey,
    source: {
      kind: 'live',
      query: api.projectNav.children,
      args: (at) => ({ project_id: expanded?.id ?? '', ...cursors(at) }),
    },
    batch: (answer) => (answer.state === 'ok' ? answer : null),
    id: (row) => row.id,
    most: PROJECT_PICKER_MOST.children,
  })
  const shownKey = useRef(mainKey)
  useEffect(() => {
    if (shownKey.current === mainKey) return
    shownKey.current = mainKey
    setExpanded(null)
  }, [mainKey])

  // the lists the paged lists opened, which they open after the render
  // that names a new one, so that render never takes an older list's rows
  // as this one's answer
  const opened = useRef<{ main: string | null; kids: string | null }>({ main: null, kids: null })
  useEffect(() => {
    opened.current = { main: mainKey, kids: kidsKey }
  })
  const mainAnswered =
    !search.tooLong &&
    search.settled === search.typed &&
    opened.current.main === mainKey &&
    main.phase !== 'first'
  const kidsAnswered = kidsKey !== null && opened.current.kids === kidsKey && kids.phase !== 'first'
  const mainEnd: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : mainAnswered
      ? listEnd(main, !browsing)
      : 'loading'
  const kidsEnd: ListEnd = kidsAnswered ? listEnd(kids, false) : 'loading'
  const mainHeld = mainEnd === 'held' ? heldNote(main.answers[0], 'projects') : null
  const kidsHeld = kidsEnd === 'held' ? heldNote(kids.answers[0], 'sub-projects') : null

  // the rows, fixed ones first, each sub-project of the expanded row under it
  const orgs = P.orgs
  const fixed: Entry[] = []
  if (rules.all === 'every') {
    fixed.push({ kind: 'fixed', key: 'every', fixed: { kind: 'every' }, label: 'All projects' })
  }
  if (rules.all === 'every' ? orgs.length > 1 : rules.all === 'org')
    for (const o of orgs)
      fixed.push({
        kind: 'fixed',
        key: `org:${o.id}`,
        fixed: { kind: 'org', org_id: o.id },
        label: orgs.length > 1 ? `All projects in ${o.name}` : 'All projects',
      })
  const mainShown = mainAnswered && mainEnd !== 'too_long'
  const kidRows: Entry[] =
    kidsAnswered && expanded
      ? kids.rows.map((row) => ({
          kind: 'row',
          key: `child:${row.id}`,
          row: {
            id: row.id,
            org_id: row.org_id,
            name: row.name,
            num: row.num,
            parent: expanded,
          },
          favorite: null,
          child: true,
        }))
      : []
  const mainEntry = (row: NavPageRow | NavSearchRow): Entry => ({
    kind: 'row',
    key: `row:${row.id}`,
    row: {
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      num: row.num,
      parent: 'parent' in row ? row.parent : null,
    },
    favorite: row.favorite,
    child: false,
  })
  const batches = mainShown
    ? main.batches.map((batch) => ({ batch, entries: batch.rows.map(mainEntry) }))
    : []
  // every row the keyboard walks, in the order shown
  const walk: Entry[] = [...fixed]
  for (const { entries } of batches)
    for (const entry of entries) {
      walk.push(entry)
      if (expanded && entry.kind === 'row' && entry.row.id === expanded.id) walk.push(...kidRows)
    }

  // equal names among the rows shown carry their number
  const taggable = new Map<string, PickedProject>()
  for (const entry of walk) if (entry.kind === 'row') taggable.set(entry.row.id, entry.row)
  const tags = duplicateNameTags(
    [...taggable.values()].map((p) => ({
      id: p.id,
      org: p.org_id,
      parent: p.parent?.id,
      name: p.name,
      num: p.num,
    })),
  )

  const [active, setActive] = useState<string | null>(null)
  const activeEntry = walk.find((entry) => entry.key === active) ?? null
  const domId = (key: string) => `${id}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  useEffect(() => {
    if (activeEntry)
      document.getElementById(domId(activeEntry.key))?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const searchBox = useRef<HTMLInputElement>(null)
  useFocusWhenGone(mainEnd === 'more', () => searchBox.current)

  /** Whether a row shows checked, whether a picked project includes it,
      and why it takes no press, null when it takes one. In one mode only
      the picked row shows checked, since a press on a sub-project of the
      picked project narrows the pick to it. */
  const stateOf = (entry: Entry) => {
    if (entry.kind === 'fixed')
      return { checked: isFixedPick(pick, entry.fixed), included: false, refused: null }
    const state = covered(pick, entry.row)
    const shown = rules.many || state === 'picked' ? state : null
    return {
      checked: shown !== null,
      included: shown === 'included',
      refused: refusalOf(pick, entry.row, rules),
    }
  }
  const press = (entry: Entry) => {
    if (entry.kind === 'fixed') {
      onPick(rules.many && isFixedPick(pick, entry.fixed) ? null : entry.fixed)
      if (!rules.many) onDone?.()
      return
    }
    const next = pickRow(pick, entry.row, rules)
    if ('refused' in next) return
    onPick(next.pick)
    if (!rules.many) onDone?.()
  }
  const toggle = (row: PickedProject) => {
    setExpanded((now) =>
      now?.id === row.id ? null : { id: row.id, org_id: row.org_id, name: row.name, num: row.num },
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const field = event.currentTarget
    const at = activeEntry ? walk.indexOf(activeEntry) : -1
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      if (walk.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next =
        at < 0 ? (step > 0 ? 0 : walk.length - 1) : (at + step + walk.length) % walk.length
      setActive(walk[next]?.key ?? null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (activeEntry) press(activeEntry)
    } else if (
      event.key === 'ArrowRight' &&
      activeEntry?.kind === 'row' &&
      !activeEntry.child &&
      activeEntry.row.parent === null &&
      field.selectionStart === field.value.length
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (expanded?.id !== activeEntry.row.id) toggle(activeEntry.row)
    } else if (
      event.key === 'ArrowLeft' &&
      activeEntry?.kind === 'row' &&
      expanded !== null &&
      (activeEntry.child || activeEntry.row.id === expanded.id) &&
      field.selectionStart === 0 &&
      field.selectionEnd === 0
    ) {
      event.preventDefault()
      event.stopPropagation()
      setActive(`row:${expanded.id}`)
      setExpanded(null)
    } else if (event.key === 'Escape' && text !== '') {
      // the text clears first; an empty field lets Escape close the picker
      event.preventDefault()
      event.stopPropagation()
      setText('')
    }
  }

  // the picks' own limits, which disable the rows they refuse
  const picked = pick?.kind === 'projects' ? pick.projects.length : 0
  const most = rules.most ?? PICK_MOST
  const otherOrg =
    orgOnly !== null && walk.some((entry) => entry.kind === 'row' && entry.row.org_id !== orgOnly)
  const atMost = rules.many && picked >= most

  const rowView = (entry: Entry) => {
    const { checked, included, refused } = stateOf(entry)
    const disabled = refused !== null || included
    const isActive = entry.key === active
    const common = {
      id: domId(entry.key),
      'data-active': isActive || undefined,
      disabled,
      onClick: () => press(entry),
      onMouseMove: () => {
        if (!isActive) setActive(entry.key)
      },
    }
    const role = rules.many
      ? { role: 'checkbox', 'aria-checked': checked }
      : { 'aria-pressed': checked }
    const mark = rules.many ? (
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong',
        )}
      >
        {checked && <Icon name="check" size={12} strokeWidth={2.5} />}
      </span>
    ) : null
    const rowClass = cn(
      'flex min-h-8 w-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-base text-text-1 hover:bg-hover disabled:cursor-default disabled:opacity-60',
      isActive && 'bg-hover',
      !rules.many && checked && 'font-semibold',
    )
    if (entry.kind === 'fixed')
      return (
        <div key={entry.key} className="flex items-center">
          <Button
            type="button"
            variant="unstyled"
            noTooltip
            data-project-pick-all={entry.fixed.kind === 'org' ? entry.fixed.org_id : ''}
            {...common}
            {...role}
            className={rowClass}
          >
            {mark}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {!rules.many && checked && <Icon name="check" size={16} color="var(--text-2)" />}
          </Button>
        </div>
      )
    const { row } = entry
    const top = row.parent === null
    const tag = tags.get(row.id)
    const org = foreignOrg(row.org_id)
    const open = expanded?.id === row.id
    return (
      <div
        key={entry.key}
        className={cn('flex min-w-0 items-center gap-0.5', entry.child && childIndent)}
      >
        {top ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            noTooltip
            tabIndex={-1}
            data-project-expand={row.id}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the sub-projects of ${row.name}`}
            onClick={() => toggle(row)}
            className="size-6 shrink-0"
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} color="var(--text-2)" />
          </Button>
        ) : (
          !entry.child && <span aria-hidden className="size-6 shrink-0" />
        )}
        <Button
          type="button"
          variant="unstyled"
          noTooltip
          data-project-pick={row.id}
          {...common}
          {...role}
          className={rowClass}
        >
          {mark}
          <span className="min-w-0 flex-1 truncate">
            {entry.child ? row.name : placeName(row)}
            {tag && <span className="ml-1 text-text-3">{tag}</span>}
          </span>
          {included && row.parent && (
            <span className="shrink-0 text-xs text-text-3">Included in {row.parent.name}</span>
          )}
          {!included && org && (
            <span data-project-pick-org className="max-w-[40%] shrink truncate text-xs text-text-3">
              {org}
            </span>
          )}
          {entry.favorite === true && (
            <span className="shrink-0">
              <Icon name="star" size={14} color="var(--text-3)" />
              <span className="sr-only">Favorite</span>
            </span>
          )}
          {!rules.many && checked && <Icon name="check" size={16} color="var(--text-2)" />}
        </Button>
      </div>
    )
  }

  const state =
    mainEnd === 'too_long'
      ? 'too_long'
      : mainEnd === 'loading'
        ? 'loading'
        : mainEnd === 'held'
          ? (mainHeld?.mark ?? 'held')
          : mainEnd === 'failed'
            ? 'failed'
            : main.phase === 'more'
              ? 'more'
              : 'ready'
  const lastBatch = batches[batches.length - 1]?.batch
  return (
    <div
      data-project-picker=""
      data-project-picker-state={state}
      aria-busy={state === 'loading' || state === 'more' || undefined}
      className="flex min-h-0 flex-col"
    >
      <div className="flex items-center gap-2 border-b px-2 pb-1.5 pt-1">
        <Icon name="search" size={16} color="var(--text-3)" />
        <Input
          ref={searchBox}
          autoFocus
          data-project-picker-search=""
          aria-label={label}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeEntry ? domId(activeEntry.key) : undefined}
          value={text}
          placeholder="Search projects…"
          onChange={(event) => {
            setText(event.target.value)
            setActive(null)
          }}
          onKeyDown={onKeyDown}
          className="h-control-sm min-w-0 flex-1 rounded-none border-none bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
        />
      </div>
      {(otherOrg || atMost) && (
        <div
          data-project-picker-note={atMost ? 'most' : 'org'}
          className={cn('flex flex-wrap items-center gap-2 border-b', noteClass)}
        >
          {atMost ? `You can choose up to ${most} projects.` : oneOrgNote}
          {otherOrg && (
            <Button
              type="button"
              variant="ghost"
              data-project-picker-clear=""
              className="h-control-sm text-sm"
              onClick={() => onPick(null)}
            >
              Clear
            </Button>
          )}
        </div>
      )}
      <div
        id={`${id}-list`}
        className="flex max-h-[min(360px,55vh)] min-h-0 flex-col gap-px overflow-y-auto overscroll-contain p-1"
      >
        {fixed.map(rowView)}
        {fixed.length > 0 && <div aria-hidden className="mx-2 my-1 border-t" />}
        {batches.map(({ batch, entries }) => (
          <div key={batch.id} className="flex flex-col gap-px">
            {entries.map((entry) => (
              <div key={entry.key} className="flex flex-col gap-px">
                {rowView(entry)}
                {expanded && entry.kind === 'row' && entry.row.id === expanded.id && (
                  <div data-project-children={expanded.id} className="flex flex-col gap-px">
                    {kidRows.map(rowView)}
                    {kidsAnswered &&
                      kids.batches.map((b, i) => (
                        <BatchNote
                          key={b.id}
                          list={kids}
                          batch={b}
                          last={i === kids.batches.length - 1}
                          what="sub-projects"
                        />
                      ))}
                    <div className={childIndent}>
                      <ListLines
                        list={kids}
                        end={kidsEnd}
                        held={kidsHeld}
                        what="sub-projects"
                        empty="No active sub-projects."
                        none="No active sub-projects."
                        onMore={() => {
                          if (kids.phase !== 'more') kids.more()
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
            <BatchNote list={main} batch={batch} last={batch === lastBatch} what="projects" />
          </div>
        ))}
        <ListLines
          list={main}
          end={mainEnd}
          held={mainHeld}
          what="projects"
          empty={browsing ? 'You have no active projects to choose.' : null}
          none={`No projects match “${search.settled}”.`}
          onMore={() => {
            if (main.phase !== 'more') main.more()
          }}
        />
      </div>
    </div>
  )
}

/** What ProjectPicker asks of its caller, beside the panel's props. */
export type ProjectPickerProps = Omit<ProjectPickerPanelProps, 'onDone'> & {
  /** the trigger's attributes: its id, its data attribute and its label */
  trigger: { id?: string; 'aria-label'?: string } & Record<`data-${string}`, string>
  /** what the trigger says before any pick */
  none?: string
  /** what the trigger says instead of the pick, such as while it loads */
  busyLabel?: string | null
  triggerRef?: Ref<HTMLButtonElement>
  className?: string
  /** keeps focus and scrolling inside the open picker, for one over a
      modal dialog (qivo Popover) */
  modal?: boolean
}

/**
 * A trigger naming the pick and the panel in a popover anchored to it, with
 * a phone's Back closing it. Closing gives focus back to the trigger.
 */
export function ProjectPicker({
  trigger,
  none,
  busyLabel = null,
  triggerRef,
  className,
  modal = false,
  ...panel
}: ProjectPickerProps) {
  const mobile = useMobile()
  const width = mobile ? Math.min(358, window.innerWidth - 32) : 360
  const orgName = (orgId: string) =>
    P.orgs.length > 1 ? (P.orgs.find((o) => o.id === orgId)?.name ?? null) : null
  const text = busyLabel ?? pickLabel(panel.pick, orgName, none)
  return (
    <Popover
      width={width}
      // a phone keeps its 16 px gutters whatever the trigger's place
      collisionPadding={16}
      backLayer
      modal={modal}
      onEscapeKeyDown={(event) => {
        // the field's own Escape clears its text first (ProjectPickerPanel)
        const target = event.target
        if (target instanceof HTMLInputElement && target.matches('[data-project-picker-search]'))
          if (target.value !== '') event.preventDefault()
      }}
      button={() => (
        <Button
          ref={triggerRef}
          type="button"
          variant="default"
          {...trigger}
          className={cn(
            'min-w-0 max-w-[260px] justify-between gap-2 bg-surface-1 font-sans text-sm',
            className,
          )}
        >
          <span className="min-w-0 truncate">{text}</span>
          <Icon name="chevronDown" size={14} color="var(--text-2)" />
        </Button>
      )}
    >
      {(close) => <ProjectPickerPanel {...panel} onDone={() => close()} />}
    </Popover>
  )
}
