/* Settings › Projects › Deleted items (design 10). The page reads the
   server's Deleted items a page of 25 entries at a time, deleted projects
   first (deletedItems.page), with Previous and Next. Without a scope it
   lists every seat's deleted projects and says that deleted tasks show
   once projects are chosen; Projects, the shared project picker with
   Archived tasks' rules, picks up to 50 projects of one organization or
   All projects in it, and only then are deleted tasks read. The kind
   control, the search, Deleted by (a person and the way they deleted, or
   Someone) and Assigned to go to the server as the page's filters, their
   people read 25 at a time from deletedItems.people while a popover is
   open. The subtitle and whether Deleted by shows come from each seat's
   role (deletedItems.roles), and Delete now's count from
   deletedItems.purgeSummary. The page never sorts, filters, groups or
   counts entries itself, and its notes say what the answer says, never an
   empty or complete list the server did not answer.

   The selection is kept across the pages of one list, at most
   SELECT_MOST.items, and cleared when a filter changes or an action
   starts. One item restores at once; several open a window that says where
   they go back and, when the restore runs in more than one round, that
   Qivo must stay open. The store runs every restore and Delete now
   (store/planner.ts runDeletedItems) on the shared runner, keeps its
   progress, which the page shows however often it is left and opened
   again, and sends a deferred item again once its project is back. A line
   that can only come back with a whole item, a task found inside a deleted
   project or a subtask of a deleted task, and an item deleted before its
   project, opens a window that says what else comes back. An organization
   admin can delete an item for good from its row menu.

   Every read stops while the tab is hidden and ends when the page is left.
   Of the store the page reads only the organizations, the login's own
   seats and the running action. The page never names the 30 days an item
   stays, which only the user guide does. Row text, folding and the
   sentences live in lib/deletedItems.ts, and times in lib/deletedTime.ts. */

import { type ReactNode, useEffect, useRef, useState } from 'react'
import { PageTitle } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { api } from '../../../convex/_generated/api'
import { LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { PickChips, ProjectPicker } from '../../components/ProjectPicker'
import { PageFold } from '../../components/pageFold'
import { pagesState, useMoveFocus } from '../../components/pageMoves'
import { ChoiceEnd, PickerSearch } from '../../components/pickerParts'
import { type ChoiceWords, escapeClearsFirst, heldLine } from '../../components/pickerWords'
import { Icon, MenuItem, Popover, Seg, StatusDot } from '../../components/qivo'
import { ACCESS_CAPS } from '../../lib/accessCaps'
import { KEEP_OPEN } from '../../lib/batchRunner'
import {
  alongText,
  andList,
  blockedText,
  type DeletedEntry,
  type DeletedHit,
  type DeletedPage,
  type DeletedPeople,
  type DeletedPerson,
  type DeletedRole,
  type DeletedRow,
  deletedBusy,
  deleterName,
  deleterSentence,
  destinations,
  FOLD,
  fold,
  foldText,
  heldAnswer,
  heldOf,
  itemName,
  itemSuffix,
  itemsNoun,
  type KindFilter,
  type Line,
  lineItem,
  lineKey,
  linesOf,
  notesOf,
  PAGE_ROWS,
  type Piece,
  type PurgeSummary,
  placeText,
  planOf,
  plural,
  progressText,
  type RestoreRefusal,
  refusalText,
  restoreToast,
  SELECT_MOST,
  stateText,
  subtitleOf,
  viaText,
} from '../../lib/deletedItems'
import { deletedAtFull, deletedAtLabel } from '../../lib/deletedTime'
import { restoreFocus } from '../../lib/focusVisibility'
import { useLiveView } from '../../lib/liveView'
import {
  listEnd,
  pageEnd,
  usePagedList,
  usePagedPages,
  useSettledSearch,
} from '../../lib/pagedList'
import {
  deletedScopeOf,
  PICK_MOST,
  type PickRules,
  type ProjectPick,
  pickedProjects,
  unpick,
} from '../../lib/projectPick'
import { P } from '../../store/planner'
import { usePlannerVersion } from '../../store/usePlannerVersion'
import { ModalShell } from '../Modals'
import '../../styles/deleted-items.css'

/** How the page picks projects: up to PICK_MOST of one organization, or
    All projects of one, as Archived tasks picks them. */
const PICK_RULES: PickRules = { many: true, most: PICK_MOST, oneOrg: true, all: 'org' }

/** Who Deleted by asks for: anyone, one person or agent, with whether it
    is the login's own seat and its name kept for the trigger, or the
    deletes of people no longer in the organization. */
type ByChoice =
  | { kind: 'anyone' }
  | { kind: 'person'; id: string; name: string; agent: boolean; you: boolean }
  | { kind: 'someone' }

/** The way a person deleted, which Deleted by narrows to (`via`). */
type Way = 'any' | 'app' | 'mcp_tokens' | 'oauth_connections'

/** Who Assigned to asks for, with the name kept for the trigger. */
type Assignee = { id: string; name: string; you: boolean }

const ANYONE: ByChoice = { kind: 'anyone' }

const WAYS: { value: Way; label: string; trigger: string }[] = [
  { value: 'any', label: 'Any way', trigger: '' },
  { value: 'app', label: 'In the app', trigger: ' in the app' },
  { value: 'mcp_tokens', label: 'Via a personal token', trigger: ' via a personal token' },
  { value: 'oauth_connections', label: 'Via a connected app', trigger: ' via a connected app' },
]

/** What the Deleted by trigger says: "Deleted by anyone", "Deleted by
    Daniel Berg via a personal token". */
function byLabel(by: ByChoice, way: Way): string {
  if (by.kind === 'anyone') return 'Deleted by anyone'
  if (by.kind === 'someone') return 'Deleted by someone no longer here'
  const how = WAYS.find((w) => w.value === way)?.trigger ?? ''
  return `Deleted by ${by.you ? 'you' : by.name}${by.agent ? '' : how}`
}

/** An item the selection holds: the row it was selected from, and the hit
    line it was selected through, when no line of its own was. */
type Picked = { row: DeletedRow; hit?: DeletedHit }

/** The windows the page opens: restore several items, restore a line that
    can only come back with a whole item (WholeItemWindow), or delete one for
    good. `key` is the line that opened it, for focus. `selection` marks a
    whole item window that Restore N selected opened, which hands focus back
    like the bulk one. */
type Ask =
  | { kind: 'bulk'; rows: DeletedRow[] }
  | { kind: 'whole'; line: Line; key: string; selection?: boolean }
  | { kind: 'purge'; row: DeletedRow; key: string }

/** The rows on either side of a row that may leave the list. */
type Around = { next?: string; previous?: string }

const toast = (text: string, tone?: 'error') => window.showToast?.(text, tone)

/** The people popovers' words (components/pickerWords.ts). */
const PEOPLE_WORDS: ChoiceWords = {
  held: (held) => heldLine(held, true),
  failed: "Couldn't load people.",
  stopped: 'Showing the people found so far.',
  empty: 'No one else to choose.',
  none: 'No one matches.',
}

export function DeletedItemsPage() {
  usePlannerVersion('deleted')
  // each seat's role, kept across a hide, so the subtitle and Deleted by
  // stay while the read starts again
  const roles = useLiveView<DeletedRole[]>(api.deletedItems.roles, '{}')
  const knownRoles = useRef<DeletedRole[] | null>(null)
  if (roles.value !== undefined) knownRoles.current = roles.value
  const seats = knownRoles.current
  // a backend without roles cannot show the page as it should
  const rolesFailed = seats === null && roles.error !== undefined

  const [pick, setPick] = useState<ProjectPick | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const [by, setBy] = useState<ByChoice>(ANYONE)
  const [way, setWay] = useState<Way>('any')
  const [assignee, setAssignee] = useState<Assignee | null>(null)
  const scope = pick === null ? undefined : deletedScopeOf(pick)
  // the organization the people popovers list: the scope's, or the only
  // seat's; a login of several seats has none without a scope
  const listOrg = scope?.org_id ?? (P.orgs.length === 1 ? (P.orgs[0]?.id ?? null) : null)
  const shownRoles = (seats ?? []).filter((r) => scope === undefined || r.org_id === scope.org_id)
  const showsBy = shownRoles.some((r) => r.role !== 'user')

  /* The list's ask, in a fixed key order with empty fields left out. */
  const ask = {
    ...(scope === undefined ? {} : { scope }),
    ...(kind === 'all' ? {} : { kind }),
    ...(search.settled === '' ? {} : { search: search.settled }),
    ...(by.kind === 'person'
      ? { deleted_by: by.id, ...(way === 'any' || by.agent ? {} : { via: way }) }
      : {}),
    ...(by.kind === 'someone' ? { someone: true as const } : {}),
    ...(assignee === null ? {} : { assignee: assignee.id }),
  }
  const key = JSON.stringify(ask)
  const page = usePagedPages<DeletedPage, DeletedEntry>({
    key,
    query: api.deletedItems.page,
    args: (after) => ({ ...ask, ...(after === null ? {} : { cursor: after }) }),
    // a scope too wide to list, or a part Qivo could not check, shows no
    // rows and no end line calls it empty
    batch: (answer) =>
      heldAnswer(answer)
        ? null
        : {
            rows: answer.entries,
            next: answer.next_cursor,
            stopped: answer.entries.length < PAGE_ROWS && answer.next_cursor !== null,
          },
  })
  // the rows of the entries on screen, also beside a failed move
  const lastAnswer = useRef<DeletedPage | null>(null)
  if (page.answer !== null) lastAnswer.current = page.answer
  const items = (page.answer ?? lastAnswer.current)?.items ?? []
  const lines = linesOf({ entries: page.rows, items })
  const onPage = new Map(items.map((row) => [row.id, row]))
  const searching = search.settled !== ''
  const end = pageEnd(page, searching)
  const notes = notesOf(page.answer, searching)

  const action = P.deletedAction
  const running = deletedBusy(action)
  const pending = new Set(running ? (action?.pending ?? []) : [])
  const waiting = P.deletedWaiting

  const [selected, setSelected] = useState<ReadonlyMap<string, Picked>>(() => new Map())
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [refusals, setRefusals] = useState<ReadonlyMap<string, RestoreRefusal>>(() => new Map())
  const [ask2, setAsk] = useState<Ask | null>(null)
  const [saving, setSaving] = useState(false)
  // whether the open window did what it asks, for where focus goes after it
  const acted = useRef(false)
  const pageRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // a focus move for after the next commit, once rows that left are gone
  const focusNext = useRef<(() => void) | null>(null)
  // the rows around the one a window acts on, taken when it acts, for the
  // window's focus after it closes
  const windowSides = useRef<Around>({})
  useEffect(() => {
    const run = focusNext.current
    focusNext.current = null
    run?.()
  })

  /* A filter change starts a new list, whose selection starts empty. */
  useEffect(() => {
    setSelected((current) => (current.size === 0 ? current : new Map()))
  }, [key])

  /* The selection holds what the person can still act on. A selected row
     the page shows in a state that cannot be restored leaves it, unless the
     last restore refused it with a reason or an action still answers for
     it; one of another page stays until a restore answers for it. A row the
     page shows again replaces the one kept. */
  useEffect(() => {
    setSelected((current) => {
      let next: Map<string, Picked> | null = null
      for (const row of onPage.values()) {
        const had = current.get(row.id)
        if (!had) continue
        next ??= new Map(current)
        if (!row.can_restore && !refusals.has(row.id) && !pending.has(row.id)) next.delete(row.id)
        else if (had.row !== row) next.set(row.id, { ...had, row })
      }
      return next ?? current
    })
  }, [page.answer])

  /* Who deleted and who is assigned follow the scope's organization. A
     pick in another organization, or clearing the scope, which Assigned to
     needs, start them again; for a login of several seats Deleted by needs
     a scope too. */
  const choosePick = (next: ProjectPick | null) => {
    const was = pick === null ? null : (deletedScopeOf(pick)?.org_id ?? null)
    const now = next === null ? null : (deletedScopeOf(next)?.org_id ?? null)
    setPick(next)
    if (was === now) return
    setAssignee(null)
    if ((was !== null && now !== null) || (now === null && P.orgs.length > 1)) {
      setBy(ANYONE)
      setWay('any')
    }
  }

  /* -------------------------------------------------------------- focus */
  const lineEls = () => [...(pageRef.current?.querySelectorAll<HTMLElement>('[data-line]') ?? [])]
  const findLine = (k: string | undefined) =>
    k === undefined ? null : (lineEls().find((el) => el.dataset.line === k) ?? null)
  const around = (k: string): Around => {
    const els = lineEls()
    const at = els.findIndex((el) => el.dataset.line === k)
    return at < 0 ? {} : { next: els[at + 1]?.dataset.line, previous: els[at - 1]?.dataset.line }
  }
  const controlOf = (el: HTMLElement | null, prefer = '[data-restore]') =>
    el?.querySelector<HTMLElement>(`${prefer}:not(:disabled)`) ??
    el?.querySelector<HTMLElement>(
      '[data-restore]:not(:disabled), [data-select]:not(:disabled), [data-row-menu]',
    ) ??
    null
  /** Where focus goes after an action on row `k`: back to the row while it
      is there, else the next row's Restore, the previous row's, or the
      search box (the review's keyboard rules). */
  const targetAround = (k: string, sides: Around, prefer?: string) => {
    const here = findLine(k)
    if (here) return controlOf(here, prefer)
    return (
      controlOf(findLine(sides.next)) ?? controlOf(findLine(sides.previous)) ?? searchRef.current
    )
  }
  /* After an action that did not open a window, focus moves only when it was
     on the row, or fell to the page when the row left. */
  const settleFocus = (k: string, sides: Around) => () => {
    const active = document.activeElement
    const here = findLine(k)
    const lost = !active || active === document.body || !active.isConnected
    if (!lost && !here?.contains(active)) return
    restoreFocus(targetAround(k, sides))
  }
  /** Where focus goes after a restore of the selection: the select-all
      box, or the search box when nothing is left to select. */
  const selectAllOrSearch = () =>
    pageRef.current?.querySelector<HTMLElement>('[data-select-all]:not(:disabled)') ??
    searchRef.current
  /** Focus after a window that Restore N selected opened. A restore sends it
      to the select-all box, and a Cancel back to the button (ModalShell's
      own return, when this answers null). */
  const afterSelectionWindow = () => (acted.current ? selectAllOrSearch() : null)
  const openAsk = (next: Ask) => {
    acted.current = false
    windowSides.current = {}
    setAsk(next)
  }
  const closeActed = () => {
    acted.current = true
    setAsk(null)
  }
  const move = useMoveFocus(
    page,
    'deleted-page',
    () => controlOf(lineEls()[0] ?? null, '[data-select]'),
    () => searchRef.current,
  )

  /* ----------------------------------------------------------- restoring */
  /** Restores `rows`, an action of one round, and says how it went. `announce`
      are the items the person asked for; others in the call are what they
      wait for. `settle` moves focus once the page shows the answer. `bulk`
      marks a restore of several items the person chose, which sends no
      Restored notice however the calls split it (design 5.4). */
  async function restore(
    rows: DeletedRow[],
    {
      announce = rows,
      settle,
      bulk = false,
    }: { announce?: DeletedRow[]; settle?: () => void; bulk?: boolean } = {},
  ) {
    const ids = new Set(rows.map((row) => row.id))
    setRefusals((current) => new Map([...current].filter(([id]) => !ids.has(id))))
    // the store sends a deferred item again once its project is back
    const outcome = await P.restoreDeletedItems(rows, { bulk })
    if (settle) focusNext.current = settle
    setRefusals((current) => {
      const next = new Map(current)
      for (const { id, reason } of outcome.refused) next.set(id, reason)
      return next
    })
    const back = new Set([...outcome.done, ...outcome.deferred])
    setSelected((current) => new Map([...current].filter(([id]) => !back.has(id))))
    const said = restoreToast(announce, outcome, undefined, rows)
    if (said.text) toast(said.text, said.tone)
    return outcome
  }

  /** A row's Restore. One item restores at once. A hit line, and an item
      whose project is deleted too, go through the whole item window. */
  const restoreLine = (line: Line, k: string) => {
    const row = lineItem(line)
    const reason = row.blocked?.reason
    if (line.kind === 'hit' || reason === 'project_deleted' || reason === 'parent_deleted') {
      openAsk({ kind: 'whole', line, key: k })
      return
    }
    if (!row.can_restore || running) return
    void restore([row], { settle: settleFocus(k, around(k)) })
  }

  const chosen = [...selected.values()]
  const chosenReady = chosen.map((p) => p.row).filter((row) => row.can_restore)
  /** Restore N selected. One item restores at once, unless it was selected
      through a hit line alone, which opens the whole item window, so the
      person learns that the whole project or task comes back. More open
      the bulk window. */
  const restoreSelected = () => {
    if (chosenReady.length === 0 || running) return
    if (chosenReady.length > 1) {
      openAsk({ kind: 'bulk', rows: chosenReady })
      return
    }
    const [only] = chosen.filter((p) => p.row.can_restore)
    if (only?.hit) {
      const line: Line = { kind: 'hit', hit: only.hit, item: only.row }
      openAsk({ kind: 'whole', line, key: lineKey(line), selection: true })
      return
    }
    void restore(chosenReady, { settle: () => restoreFocus(selectAllOrSearch()) })
  }

  /* ---------------------------------------------------------- selection */
  const full = selected.size >= SELECT_MOST.items
  /** Selects or clears `picks`, at most SELECT_MOST.items in all. A line of
      its own wins over a hit line of the same item. */
  const choose = (picks: Picked[], on: boolean) =>
    setSelected((current) => {
      const next = new Map(current)
      for (const p of picks) {
        if (!on) {
          next.delete(p.row.id)
          continue
        }
        const had = next.get(p.row.id)
        if (had) {
          if (had.hit && !p.hit) next.set(p.row.id, p)
          continue
        }
        if (next.size >= SELECT_MOST.items) break
        next.set(p.row.id, p)
      }
      return next
    })
  const pickOf = (line: Line): Picked =>
    line.kind === 'item' ? { row: line.row } : { row: line.item, hit: line.hit }
  const shownPicks = lines.map(pickOf).filter((p) => p.row.can_restore && p.row.state === 'ready')
  const shownIds = [...new Set(shownPicks.map((p) => p.row.id))]
  const boxState = (ids: string[]): boolean | 'indeterminate' => {
    const on = ids.filter((id) => selected.has(id)).length
    return on === 0 ? false : on === ids.length ? true : 'indeterminate'
  }
  const elsewhere = chosen.filter((p) => !onPage.has(p.row.id)).length

  /* --------------------------------------------------------------- render */
  const orgs = new Set(lines.map((line) => lineItem(line).org_id))
  const namesOrg = orgs.size > 1
  const wide = lines.some((line) => lineItem(line).can_purge)
  const now = new Date()
  const itemCount = new Set(lines.map((line) => lineItem(line).id)).size
  const countText =
    page.phase === 'first' || page.phase === 'failed' || page.phase === 'held'
      ? ''
      : page.hasNext || page.hasPrevious
        ? `${plural(itemCount, 'item')} on this page`
        : plural(itemCount, 'item')
  const filtered = kind !== 'all' || by.kind !== 'anyone' || assignee !== null
  const progress = running && action?.long ? progressText(action) : ''

  function selectedText() {
    const n = selected.size.toLocaleString('en-US')
    return elsewhere > 0
      ? `${n} selected, ${elsewhere.toLocaleString('en-US')} on other pages`
      : `${n} selected`
  }
  const selectionBar = (place: 'top' | 'bottom') => (
    <>
      {place === 'bottom' && (
        <span className="text-sm font-semibold text-text-1">{selectedText()}</span>
      )}
      <Button
        type="button"
        variant="quiet"
        size="sm"
        data-clear-selection
        onClick={() => setSelected(new Map())}
      >
        Clear
      </Button>
      <div className="min-w-0 flex-1" />
      <Button
        type="button"
        variant="primary"
        size="sm"
        className="font-semibold"
        data-restore-selected
        disabled={chosenReady.length === 0 || running}
        onClick={restoreSelected}
      >
        <Icon name="rotateCcw" size={16} />
        Restore {chosenReady.length.toLocaleString('en-US')} selected
      </Button>
    </>
  )

  const renderLine = (line: Line, k: string) => {
    const item = lineItem(line)
    const hit = line.kind === 'hit' ? line.hit : null
    const { state, blocked, deleter } = item
    const ready = state === 'ready'
    const hidden = !hit && item.hidden === true
    const name = hit ? hit.key : itemName(item)
    const opensWindow =
      hit !== null || blocked?.reason === 'project_deleted' || blocked?.reason === 'parent_deleted'
    const canRestore = ready && !item.redacted && (item.can_restore || opensWindow)
    const holder = blocked?.item_id === undefined ? undefined : onPage.get(blocked.item_id)
    const refused = refusals.get(item.id)
    const restoring = pending.has(item.id)
    // the reason given at deletion, then why the row cannot be restored now
    const rowNotes: { key: string; text: ReactNode }[] = []
    if (!hit && item.reason && !hidden)
      rowNotes.push({
        key: 'reason',
        text: (
          <>
            Reason <span className="text-text-1">“{item.reason}”</span>
          </>
        ),
      })
    const stateLine = stateText(state)
    const blockedLine = blocked && !item.redacted ? blockedText(blocked, holder?.title) : null
    if (stateLine) rowNotes.push({ key: 'state', text: stateLine })
    else if (waiting.has(item.id))
      rowNotes.push({ key: 'waiting', text: 'Qivo restores it once its project is back.' })
    else if (blockedLine) rowNotes.push({ key: 'blocked', text: blockedLine })
    else if (refused) rowNotes.push({ key: 'refused', text: refusalText(refused) })
    if (hidden)
      rowNotes.push({
        key: 'hidden',
        text: "You can't open this task's project, so its title isn't shown.",
      })
    const place = hit ? hit.path.filter(Boolean).join(' › ') : placeText(item)
    const archived = hit ? hit.archived : item.archived
    // a row with no place line puts its deleter there on a phone
    const placed = !!place || item.redacted === true || archived || namesOrg
    const time = new Date(item.deleted_at)
    const status =
      !hit && !item.redacted && !hidden && item.kind === 'task' ? item.status : undefined
    const selectable = item.can_restore || selected.has(item.id)
    return (
      <div
        key={k}
        data-line={k}
        data-deleted-row={hit ? undefined : item.id}
        data-deleted-hit={hit ? hit.key : undefined}
        data-hidden-row={hidden ? '' : undefined}
        data-state={state}
        className={cn(
          'deleted-row rounded-md border border-border bg-surface-1 p-2',
          !placed && 'deleted-row-unplaced',
          selected.has(item.id) && 'bg-lit',
          (state === 'moving' || state === 'restoring') && 'opacity-60',
        )}
      >
        <div className="deleted-row-check mt-[3px] flex">
          {ready ? (
            <Checkbox
              data-select
              aria-label={`Select ${name}`}
              checked={selected.has(item.id)}
              // a refused row that stays selected can still be cleared, and
              // at the cap only a selected row's box takes a press
              disabled={!selectable || (full && !selected.has(item.id))}
              onCheckedChange={(on) => choose([pickOf(line)], on === true)}
            />
          ) : (
            <span className="size-4" />
          )}
        </div>
        <span className="deleted-row-icon mt-[2px] flex text-text-2">
          {item.kind === 'project' && !hit ? (
            <Icon name="layers" size={16} color="var(--text-2)" />
          ) : status ? (
            <StatusDot status={status} size={16} />
          ) : (
            <Icon name="circleDot" size={16} />
          )}
        </span>
        <div className="deleted-row-title flex min-w-0 items-baseline gap-2">
          {(hit || item.kind === 'task') && (
            <span className="shrink-0 font-mono text-xs text-text-2">{name}</span>
          )}
          {hidden ? (
            <span className="min-w-0 text-base italic text-text-2">Title not shown</span>
          ) : (
            <span className="line-clamp-2 min-w-0 break-words text-base font-medium leading-[1.4] text-text-1">
              {hit ? hit.title : item.title}
            </span>
          )}
          {!hit && !hidden && itemSuffix(item) && (
            <span className="shrink-0 text-sm text-text-2">{itemSuffix(item)}</span>
          )}
        </div>
        <div className="deleted-row-meta mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-2">
          {placed && (
            <span data-row-place className="deleted-row-where flex flex-wrap gap-x-3">
              {namesOrg && <span data-row-org>{item.org_name}</span>}
              {item.redacted && !hit ? (
                <span>Deleted with a task in a project you can't open</span>
              ) : (
                place && (
                  <span>
                    {place}
                    {hit && (
                      <span className="text-danger">
                        , deleted with{' '}
                        {item.kind === 'project' ? 'the project' : (hit.root_key ?? 'its task')}
                      </span>
                    )}
                  </span>
                )
              )}
              {archived && <span>archived</span>}
            </span>
          )}
          <span data-row-who className="deleted-row-who">
            <span className="text-text-1">{deleterName(deleter)}</span>
            {viaText(deleter, 'row')}
          </span>
        </div>
        {rowNotes.length > 0 && (
          <div data-row-notes className="deleted-row-notes">
            {rowNotes.map((note) => (
              <div key={note.key} data-row-note={note.key} className="mt-1 text-xs text-text-2">
                {note.text}
              </div>
            ))}
          </div>
        )}
        <HoverTooltip content={deletedAtFull(time)}>
          <span
            tabIndex={-1}
            data-row-time
            className="deleted-row-time font-mono text-xs text-text-2"
          >
            {deletedAtLabel(time, now)}
          </span>
        </HoverTooltip>
        {/* at least the width of Restore and the menu, so the times line up,
            and wider while a row says Restoring…, which never runs into its time */}
        <div
          className={cn(
            'deleted-row-actions flex shrink-0 items-center justify-end gap-0.5',
            wide ? 'min-w-[128px]' : 'min-w-[96px]',
          )}
        >
          {canRestore && (
            <Button
              type="button"
              variant="ghost"
              data-restore
              aria-label={`Restore ${name}`}
              disabled={running}
              className="h-control-sm shrink-0 text-sm text-text-1"
              onClick={() => restoreLine(line, k)}
            >
              <Icon name="rotateCcw" size={16} />
              <span className="deleted-restore-label">{restoring ? 'Restoring…' : 'Restore'}</span>
            </Button>
          )}
          {item.can_purge && !hit && (
            <Popover
              width={200}
              align="right"
              button={(toggle, menuOpen) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-row-menu
                  data-on={menuOpen ? '' : undefined}
                  aria-label={`More actions for ${name}`}
                  onClick={toggle}
                >
                  <Icon name="more" size={16} />
                </Button>
              )}
            >
              {(close) => (
                <MenuItem
                  danger
                  data-delete-now
                  disabled={running}
                  onClick={() => close(() => openAsk({ kind: 'purge', row: item, key: k }))}
                >
                  <Icon name="trash" size={14} />
                  Delete now…
                </MenuItem>
              )}
            </Popover>
          )}
        </div>
      </div>
    )
  }

  const renderPiece = (piece: Piece) => {
    if (piece.kind === 'line') return renderLine(piece.line, lineKey(piece.line))
    if (piece.kind === 'fewer')
      return (
        <div key={`fewer-${piece.key}`} className="flex min-h-control items-center px-[9px]">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="text-text-1"
            data-show-fewer
            onClick={() => {
              focusNext.current = () =>
                restoreFocus(
                  [
                    ...(pageRef.current?.querySelectorAll<HTMLElement>('[data-show-all]') ?? []),
                  ].find((el) => el.dataset.showAll === piece.key),
                )
              setOpen((current) => new Set([...current].filter((x) => x !== piece.key)))
            }}
          >
            Show fewer
          </Button>
        </div>
      )
    const runPicks = piece.run.filter((row) => row.can_restore).map((row) => ({ row }))
    const ids = runPicks.map((p) => p.row.id)
    return (
      <div
        key={`fold-${piece.key}`}
        data-fold={piece.key}
        className="flex min-h-control items-center gap-2.5 px-[9px]"
      >
        <Checkbox
          data-select-run
          aria-label={`Select all ${plural(piece.run.length, 'task')} in this run`}
          checked={ids.length ? boxState(ids) : false}
          disabled={!ids.length || (full && boxState(ids) === false)}
          onCheckedChange={(on) => choose(runPicks, on === true)}
        />
        <span className="text-sm text-text-2">{foldText(piece.hidden, now)}</span>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="text-text-1"
          data-show-all={piece.key}
          onClick={() => {
            // focus goes to the first row the run shows now
            const first = piece.run[FOLD.shown]?.id
            focusNext.current = () => restoreFocus(controlOf(findLine(first), '[data-select]'))
            setOpen((current) => new Set([...current, piece.key]))
          }}
        >
          Show all
        </Button>
      </div>
    )
  }

  const scopeNeeded = page.answer?.scope_needed === true
  const words = {
    loading: 'Loading…',
    failed: "Couldn't load deleted items.",
    stopped: 'Qivo checked part of Deleted items. Next continues.',
    stoppedEmpty: 'Qivo checked part of Deleted items and found nothing there yet. Next continues.',
    stuck: 'Qivo could not check part of Deleted items.',
    none: `No deleted items match “${search.settled}”.`,
    empty: scopeNeeded
      ? 'No deleted projects. Choose projects to see deleted tasks.'
      : filtered
        ? 'No deleted items match the filters.'
        : pick?.kind === 'projects'
          ? 'No deleted items in the projects you chose.'
          : 'No deleted items.',
    nomore: 'No more deleted items.',
  }
  const state = rolesFailed ? 'failed' : pagesState(page)
  const subtitle = subtitleOf(shownRoles)

  return (
    <>
      <PageTitle sub={subtitle || undefined}>Deleted items</PageTitle>
      <div ref={pageRef} data-deleted-items>
        <div className="deleted-filter-block sticky top-[-16px] z-10 -mx-1 mb-2 px-1 pt-1 pb-1">
          <div className="deleted-filters flex flex-col gap-2">
            <div className="deleted-filters-row flex items-center gap-2">
              <ProjectPicker
                trigger={{ 'data-deleted-scope': '' }}
                name="Projects"
                none="Choose projects…"
                pick={pick}
                rules={PICK_RULES}
                label="Search projects"
                oneOrgNote="Deleted items lists one organization at a time."
                onPick={choosePick}
                className="deleted-scope h-control"
              />
              <div className="deleted-search flex h-control items-center gap-2 rounded-md border border-border bg-surface-1 px-2">
                <Icon name="search" size={16} color="var(--text-3)" />
                <LimitedInput
                  limit={LIMITS.search}
                  ref={searchRef}
                  data-deleted-search
                  aria-label="Search deleted items"
                  placeholder="Search deleted items…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape clears the search first; an empty field lets it
                    // reach Settings, which closes
                    if (e.key === 'Escape' && text) {
                      e.stopPropagation()
                      setText('')
                    }
                  }}
                  wrapperClassName="h-full flex-1"
                  className="h-full rounded-none border-none bg-transparent p-0 text-base text-text-1 shadow-none focus-visible:ring-0"
                />
                {text && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label="Clear the search"
                    onClick={() => {
                      setText('')
                      searchRef.current?.focus()
                    }}
                  >
                    <Icon name="close" size={12} />
                  </Button>
                )}
              </div>
            </div>
            <div className="deleted-filters-row flex flex-wrap items-center gap-2">
              <Seg<KindFilter>
                value={kind}
                onChange={setKind}
                label="Kind"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'task', label: 'Tasks' },
                  // the server lists no project entry for an assignee
                  { value: 'project', label: 'Projects', disabled: assignee !== null },
                ]}
              />
              {showsBy && (
                <PeoplePicker
                  hook="data-deleted-by"
                  label={byLabel(by, way)}
                  org={listOrg}
                  why={listOrg === null ? 'Choose projects to filter by who deleted.' : null}
                  fixed={[
                    { id: 'anyone', label: 'Deleted by anyone', on: by.kind === 'anyone' },
                    ...(listOrg !== null && P.seatIn(listOrg) !== ''
                      ? [{ id: 'you', label: 'You', on: by.kind === 'person' && by.you }]
                      : []),
                    {
                      id: 'someone',
                      label: 'Someone no longer in the organization',
                      on: by.kind === 'someone',
                    },
                  ]}
                  chosen={by.kind === 'person' && !by.you ? by.id : null}
                  // pending seats have deleted nothing, and You is fixed
                  keep={(person) => !person.you && !person.pending}
                  onFixed={(id) => {
                    setWay('any')
                    if (id === 'anyone') setBy(ANYONE)
                    else if (id === 'someone') setBy({ kind: 'someone' })
                    else if (listOrg !== null)
                      setBy({
                        kind: 'person',
                        id: P.seatIn(listOrg),
                        name: 'you',
                        agent: false,
                        you: true,
                      })
                  }}
                  onPerson={(person) => {
                    setWay('any')
                    setBy({
                      kind: 'person',
                      id: person.id,
                      name: person.name,
                      agent: person.kind === 'agent',
                      you: false,
                    })
                  }}
                />
              )}
              {showsBy && by.kind === 'person' && !by.agent && (
                <NativeSelect
                  aria-label="How they deleted"
                  data-deleted-by-way
                  value={way}
                  onChange={(e) => setWay(e.target.value as Way)}
                  className="deleted-way h-control cursor-pointer bg-surface-1 font-sans text-sm"
                >
                  {WAYS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <PeoplePicker
                hook="data-deleted-assignee"
                label={
                  assignee === null
                    ? 'Assigned to anyone'
                    : `Assigned to ${assignee.you ? 'you' : assignee.name}`
                }
                org={scope === undefined ? null : scope.org_id}
                why={
                  scope === undefined
                    ? 'Choose projects to filter by assignee.'
                    : kind === 'project'
                      ? 'Projects have no assignee.'
                      : null
                }
                fixed={[
                  { id: 'anyone', label: 'Assigned to anyone', on: assignee === null },
                  ...(scope !== undefined && P.seatIn(scope.org_id) !== ''
                    ? [{ id: 'you', label: 'You', on: assignee?.you === true }]
                    : []),
                ]}
                chosen={assignee !== null && !assignee.you ? assignee.id : null}
                keep={(person) => !person.you}
                onFixed={(id) => {
                  if (id === 'anyone' || scope === undefined) setAssignee(null)
                  else setAssignee({ id: P.seatIn(scope.org_id), name: 'you', you: true })
                }}
                onPerson={(person) => setAssignee({ id: person.id, name: person.name, you: false })}
              />
            </div>
          </div>
          <PickChips
            picked={pickedProjects(pick)}
            onRemove={(id) => choosePick(unpick(pick, id))}
            hooks={{
              row: 'data-deleted-picks',
              chip: 'data-deleted-pick',
              more: 'data-deleted-picks-more',
            }}
            className="mt-2"
          />
          <div
            data-deleted-progress
            role="status"
            aria-live="polite"
            className={cn('deleted-progress text-sm text-text-2', progress && 'mt-2')}
          >
            {progress}
          </div>
          <div className="mt-2 flex h-control items-center gap-2.5 border-b border-border pr-1 pl-[9px]">
            <Checkbox
              data-select-all
              aria-label="Select all shown"
              checked={shownIds.length ? boxState(shownIds) : false}
              disabled={!shownIds.length || (full && boxState(shownIds) === false)}
              onCheckedChange={(on) => choose(shownPicks, on === true)}
            />
            <span role="status" data-deleted-count>
              {selected.size > 0 ? (
                <span className="text-sm font-semibold text-text-1">{selectedText()}</span>
              ) : (
                countText && <span className="font-mono text-sm text-text-2">{countText}</span>
              )}
            </span>
            {selected.size > 0 && (
              <div className="deleted-selection-actions flex min-w-0 flex-1 items-center gap-2.5">
                {selectionBar('top')}
              </div>
            )}
          </div>
          {full && (
            <p data-deleted-cap className="mt-1 px-1 text-sm text-text-2">
              You can select up to {SELECT_MOST.items.toLocaleString('en-US')} items at a time.
            </p>
          )}
        </div>
        {notes.map((note) => (
          <p key={note.key} data-deleted-note={note.key} className="mb-2 px-1 text-sm text-text-2">
            {note.text}
          </p>
        ))}
        <div
          className="deleted-list"
          data-deleted-state={state}
          aria-busy={state === 'loading' || state === 'refreshing' || undefined}
        >
          {rolesFailed ? (
            <div role="alert" className="flex items-center gap-3 px-2 py-4">
              <span className="text-base text-text-2">Couldn't load deleted items.</span>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  roles.retry()
                  page.retry()
                }}
              >
                Try again
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">{fold(lines, open).map(renderPiece)}</div>
              <PageFold
                page={page}
                end={end}
                hook="deleted-page"
                words={words}
                held={heldOf}
                tooLong={search.tooLong}
                focus={move}
              />
            </>
          )}
        </div>
        {selected.size > 0 && (
          <div data-selection-bar className="deleted-selection-bar">
            {selectionBar('bottom')}
          </div>
        )}
      </div>
      {ask2?.kind === 'bulk' && (
        <BulkRestoreWindow
          rows={ask2.rows}
          now={now}
          saving={saving}
          onClose={() => setAsk(null)}
          onRestore={async () => {
            const { rows } = ask2
            if (planOf(rows, LIMITS.restoreBatch.max).long) {
              // the store runs it and says how it went, wherever the
              // person is; the window closes at once. An action that
              // starts sets P.deletedAction before its first call, so an
              // unchanged one means the store refused it at the press (the
              // pause, another action) and sent nothing, so the window and
              // the selection stay and the page says why.
              const before = P.deletedAction
              const started = P.restoreDeletedItems(rows, { bulk: true })
              if (P.deletedAction === before) {
                const outcome = await started
                if (outcome.error !== null) toast(outcome.error, 'error')
                return
              }
              setSelected(new Map())
              closeActed()
              return
            }
            setSaving(true)
            const outcome = await restore(rows, { bulk: true })
            setSaving(false)
            // a call refused whole (billing, offline) keeps it open for another try
            if (outcome.error === null || outcome.done.length > 0) closeActed()
          }}
          focusAfterClose={afterSelectionWindow}
        />
      )}
      {ask2?.kind === 'whole' && (
        <WholeItemWindow
          line={ask2.line}
          onPage={onPage}
          saving={saving}
          onClose={() => setAsk(null)}
          onRestore={async (holder) => {
            const { line } = ask2
            windowSides.current = around(ask2.key)
            setSaving(true)
            // a hit comes back with its item; an item that waits for its
            // project goes in the same call and is deferred
            const outcome = await restore(line.kind === 'hit' ? [holder] : [holder, line.row], {
              announce: [holder],
            })
            setSaving(false)
            // a call refused whole (billing, offline) keeps it open for another try
            if (outcome.error === null || outcome.done.length > 0) closeActed()
          }}
          focusAfterClose={
            ask2.selection
              ? afterSelectionWindow
              : () => targetAround(ask2.key, windowSides.current)
          }
        />
      )}
      {ask2?.kind === 'purge' && (
        <PurgeWindow
          row={ask2.row}
          saving={saving}
          onClose={() => setAsk(null)}
          onPurge={async () => {
            const { row } = ask2
            windowSides.current = around(ask2.key)
            setSaving(true)
            const outcome = await P.purgeDeletedItems([row])
            setSaving(false)
            const name = row.kind === 'task' ? row.key : `“${row.title}”`
            const refused = outcome.refused[0]
            if (outcome.done.includes(row.id)) toast(`Deleted ${name} for good.`)
            else if (refused)
              toast(`Couldn't delete ${name} for good. ${refusalText(refused.reason)}`, 'error')
            else {
              // a call refused whole (billing, offline) keeps it open for another try
              toast(outcome.error ?? `Couldn't delete ${name} for good.`, 'error')
              return
            }
            closeActed()
          }}
          focusAfterClose={() => targetAround(ask2.key, windowSides.current, '[data-row-menu]')}
        />
      )}
    </>
  )
}

/** A fixed row of a people popover. */
type FixedChoice = { id: string; label: string; on: boolean }

/**
 * Deleted by or Assigned to: a trigger naming the choice and a popover of
 * fixed rows and organization `org`'s people from deletedItems.people, 25
 * a batch with a search and Load more, read once a batch and only while
 * open. `keep` leaves rows out of the batches, the login's own seat, which
 * a fixed You row stands for, and for Deleted by the seats nobody has
 * claimed, which deleted nothing. With `why` the trigger takes no press and
 * says why in its tooltip.
 */
function PeoplePicker({
  hook,
  label,
  org,
  why,
  fixed,
  chosen,
  keep,
  onFixed,
  onPerson,
}: {
  hook: `data-${string}`
  label: string
  org: string | null
  why: string | null
  fixed: FixedChoice[]
  chosen: string | null
  keep: (person: DeletedPerson) => boolean
  onFixed: (id: string) => void
  onPerson: (person: DeletedPerson) => void
}) {
  const trigger = (toggle: () => void, open: boolean) => (
    <Button
      type="button"
      variant="default"
      {...{ [hook]: '' }}
      data-on={open ? '' : undefined}
      aria-disabled={why !== null || undefined}
      data-disabled-why={why ?? undefined}
      onClick={() => why === null && toggle()}
      className={cn(
        'deleted-person h-control min-w-0 max-w-[260px] justify-between gap-2 bg-surface-1 font-sans text-sm',
        why !== null && 'cursor-default text-text-2',
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <Icon name="chevronDown" size={14} color="var(--text-2)" />
    </Button>
  )
  if (why !== null || org === null)
    return <HoverTooltip content={why ?? undefined}>{trigger(() => undefined, false)}</HoverTooltip>
  return (
    <Popover
      width={280}
      backLayer
      collisionPadding={16}
      onEscapeKeyDown={escapeClearsFirst('data-deleted-people-search')}
      wrapStyle={{ minWidth: 0 }}
      button={trigger}
    >
      {(close) => (
        <PeopleChoices
          org={org}
          fixed={fixed}
          chosen={chosen}
          keep={keep}
          onFixed={(id) => close(() => onFixed(id))}
          onPerson={(person) => close(() => onPerson(person))}
        />
      )}
    </Popover>
  )
}

/* The open people popover: its fixed rows, a search and the server's
   people with Load more. A batch whose rows `keep` leaves out says so,
   never that nobody is there. */
function PeopleChoices({
  org,
  fixed,
  chosen,
  keep,
  onFixed,
  onPerson,
}: {
  org: string
  fixed: FixedChoice[]
  chosen: string | null
  keep: (person: DeletedPerson) => boolean
  onFixed: (id: string) => void
  onPerson: (person: DeletedPerson) => void
}) {
  const [text, setText] = useState('')
  const { tooLong, settled } = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: JSON.stringify([org, settled]),
    source: { kind: 'once', read: (at) => P.deletedPeople(org, settled, at.after) },
    batch: (answer: DeletedPeople) => (answer.state === 'ready' ? answer : null),
    id: (person: DeletedPerson) => person.id,
    most: ACCESS_CAPS.choices,
  })
  const end = listEnd(list, settled !== '')
  const shown = list.rows.filter(keep)
  const leftOut = shown.length === 0 && list.rows.length > 0
  return (
    <div data-deleted-people="" className="flex flex-col gap-1">
      {fixed.map((row) => (
        <MenuItem
          key={row.id}
          active={row.on}
          data-deleted-people-fixed={row.id}
          onClick={() => onFixed(row.id)}
        >
          {row.label}
        </MenuItem>
      ))}
      <PickerSearch
        text={text}
        onText={setText}
        label="Search people"
        probe="data-deleted-people-search"
      />
      <div className="max-h-[280px] overflow-y-auto">
        {shown.map((person) => (
          <MenuItem
            key={person.id}
            active={chosen === person.id}
            data-deleted-person={person.id}
            onClick={() => onPerson(person)}
          >
            <span className="min-w-0 truncate">{person.name}</span>
            {person.kind === 'agent' && <span className="ml-auto text-xs text-text-2">agent</span>}
            {person.pending && person.kind === 'person' && (
              <span className="ml-auto text-xs text-text-2">invited</span>
            )}
          </MenuItem>
        ))}
        {leftOut && end === 'more' && (
          <p className="px-2 py-1 text-sm text-text-2">
            No one else to choose in this part. Load more continues.
          </p>
        )}
        {leftOut && end === 'end' ? (
          <p data-picker-empty="" className="px-2 py-1 text-sm text-text-2">
            {PEOPLE_WORDS.empty}
          </p>
        ) : (
          <ChoiceEnd end={end} tooLong={tooLong} list={list} words={PEOPLE_WORDS} />
        )}
      </div>
    </div>
  )
}

/** The bulk restore window: who deleted the items and when, where they go
    back, what does not come back with them, and, for a restore of more
    than one round, that it runs in steps and Qivo must stay open. */
function BulkRestoreWindow({
  rows,
  now,
  saving,
  onClose,
  onRestore,
  focusAfterClose,
}: {
  rows: DeletedRow[]
  now: Date
  saving: boolean
  onClose: () => void
  onRestore: () => void
  focusAfterClose: () => HTMLElement | null
}) {
  const who = deleterSentence(rows, now)
  const noun = itemsNoun(rows)
  const { long } = planOf(rows, LIMITS.restoreBatch.max)
  return (
    <ModalShell
      icon="rotateCcw"
      title={`Restore ${noun}?`}
      width={480}
      onClose={saving ? () => false : onClose}
      onSubmit={onRestore}
      canSubmit={!saving}
      submitLabel={saving ? 'Restoring…' : `Restore ${noun}`}
      focusAfterClose={focusAfterClose}
    >
      <div data-bulk-restore className="flex flex-col gap-3 text-base leading-normal text-text-2">
        <p>
          {who ? `${who} ` : ''}
          They come back where they were, with comments and attachments.
        </p>
        <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-surface-1">
          {destinations(rows).map((place) => (
            <div
              key={place.key}
              data-destination
              className="flex items-center gap-2 px-2.5 py-[5px] text-sm leading-[1.4]"
            >
              <Icon name="layers" size={14} color="var(--text-2)" />
              <span className="min-w-0 flex-1 truncate text-text-1">{place.name}</span>
              <span className="shrink-0 text-text-2">{place.count}</span>
            </div>
          ))}
        </div>
        <p className="text-sm">They keep their keys. Labels deleted since then are gone.</p>
        {long && (
          <p data-keep-open className="text-sm text-text-1">
            Restoring them runs in steps. {KEEP_OPEN}
          </p>
        )}
      </div>
    </ModalShell>
  )
}

/** What a project item brings back with it: "with its 2 sub-projects and all
    48 tasks, 9 of them archived". */
function comesBack(holder: DeletedRow): string {
  const { sub_projects: subs, tasks, archived_tasks: archived } = holder.counts
  const parts = [
    subs > 0 ? `its ${plural(subs, 'sub-project')}` : '',
    tasks === 1 ? 'its task' : tasks > 1 ? `all ${plural(tasks, 'task')}` : '',
  ].filter(Boolean)
  if (parts.length === 0) return `${holder.title} comes back on its own. It keeps its key.`
  const kept =
    archived === 0 ? '' : tasks === 1 ? ', which is archived' : `, ${archived} of them archived`
  return `${holder.title} comes back with ${andList(parts)}${kept}. They keep their keys.`
}

/** The window of a line that can only come back with a whole item. A hit
    inside a deleted project, or (for admins) an item deleted before its
    project, comes back with that project item ("<key> is in a deleted
    project"), so Restore brings the project back first. A hit on a subtask
    of a deleted task comes back with the whole item, its root and every
    other subtask ("<key> is a subtask of a deleted task"). A hit's item is
    the entry's own; the project item a blocked row waits for is the page's
    when it holds it, and is read from deletedItems.item while the window
    shows otherwise, Restore waiting for it. When the item cannot be
    restored, the window says why and offers Close. While a restore is
    saving, the window waits for it, also when the page meanwhile shows the
    item restoring or gone. */
function WholeItemWindow({
  line,
  onPage,
  saving,
  onClose,
  onRestore,
  focusAfterClose,
}: {
  line: Line
  onPage: ReadonlyMap<string, DeletedRow>
  saving: boolean
  onClose: () => void
  onRestore: (holder: DeletedRow) => void
  focusAfterClose: () => HTMLElement | null
}) {
  const item = lineItem(line)
  const waitsFor = line.kind === 'item' ? item.blocked?.item_id : undefined
  const held = waitsFor === undefined ? undefined : onPage.get(waitsFor)
  const read = useLiveView<DeletedRow | null>(
    api.deletedItems.item,
    waitsFor !== undefined && held === undefined ? JSON.stringify({ id: waitsFor }) : null,
  )
  const holder = line.kind === 'hit' ? line.item : (held ?? read.value ?? undefined)
  const asking = waitsFor !== undefined && held === undefined && read.value === undefined
  const name = line.kind === 'hit' ? line.hit.key : itemName(item)
  // the task item a subtask's hit belongs to, by its root
  const root =
    line.kind === 'hit' && line.item.kind === 'task'
      ? { key: line.hit.root_key ?? line.item.key, title: line.hit.root_title ?? '' }
      : undefined
  const project = holder?.kind === 'project' ? holder.title : undefined
  const canRestore = holder?.can_restore === true
  const reason = !holder
    ? null
    : (stateText(holder.state) ??
      (holder.blocked ? blockedText(holder.blocked) : null) ??
      (canRestore ? null : refusalText('no_access')))
  return (
    <ModalShell
      icon="rotateCcw"
      title={root ? `${name} is a subtask of a deleted task` : `${name} is in a deleted project`}
      width={440}
      onClose={saving ? () => false : onClose}
      onSubmit={() => holder && onRestore(holder)}
      canSubmit={canRestore && !saving}
      submitLabel={
        saving ? 'Restoring…' : `Restore ${root?.key ?? project ?? 'the project'} and ${name}`
      }
      focusAfterClose={focusAfterClose}
      footer={
        canRestore || saving || asking ? undefined : (
          <>
            <div className="min-w-0 flex-1" />
            <Button type="button" variant="ghost" className="text-text-1" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {root ? (
        <div
          data-task-first
          className="flex flex-col gap-3 break-words text-base leading-normal text-text-2"
        >
          <p>
            <b className="font-semibold text-text-1">{name}</b> was deleted together with{' '}
            <b className="font-semibold text-text-1">
              {root.key} {root.title}
            </b>
            . It can only come back with that task.
          </p>
          <p className="text-sm">
            {reason ?? `${root.key} and its subtasks come back. They keep their keys.`}
          </p>
        </div>
      ) : (
        <div
          data-project-first
          className="flex flex-col gap-3 break-words text-base leading-normal text-text-2"
        >
          {holder ? (
            <p>
              <b className="font-semibold text-text-1">{name}</b>
              {line.kind === 'hit'
                ? ' was deleted together with its project'
                : ' was deleted before its project'}
              {project !== undefined && (
                <>
                  {' '}
                  <b className="font-semibold text-text-1">{project}</b>
                </>
              )}
              {line.kind === 'hit'
                ? '. It can only come back with the project.'
                : ', which is in Deleted items too. It can only come back after the project.'}
            </p>
          ) : (
            <p>
              <b className="font-semibold text-text-1">{name}</b> is in a project that is in Deleted
              items too. It can only come back after the project.
            </p>
          )}
          {holder && <p className="text-sm">{reason ?? comesBack(holder)}</p>}
        </div>
      )}
    </ModalShell>
  )
}

/** The Delete now window, where an organization admin deletes one item for
    good. A project item's window reads how many items deleted from the
    project earlier go with it (deletedItems.purgeSummary) while it shows,
    and keeps Delete for good off until the count or its failure, which
    says it could not count. A task item takes nothing along. */
function PurgeWindow({
  row,
  saving,
  onClose,
  onPurge,
  focusAfterClose,
}: {
  row: DeletedRow
  saving: boolean
  onClose: () => void
  onPurge: () => void
  focusAfterClose: () => HTMLElement | null
}) {
  const count = useLiveView<PurgeSummary | null>(
    api.deletedItems.purgeSummary,
    row.kind === 'project' ? JSON.stringify({ id: row.id }) : null,
  )
  const { subtasks, sub_projects: subs, tasks } = row.counts
  let rest: string
  if (row.kind === 'task')
    rest = subtasks
      ? ` and its ${plural(subtasks, 'subtask')}, comments and attachments.`
      : ' and its comments and attachments.'
  else if (subs && tasks)
    rest = `, its ${plural(subs, 'sub-project')} and ${plural(tasks, 'task')} with their comments and attachments.`
  else if (tasks) rest = ` and its ${plural(tasks, 'task')} with their comments and attachments.`
  else if (subs) rest = ` and its ${plural(subs, 'sub-project')}.`
  else rest = '.'
  const along =
    row.kind === 'task'
      ? { text: '', ready: true }
      : alongText(count.error !== undefined ? 'failed' : count.value)
  return (
    <ModalShell
      icon="warning"
      title={`Delete ${itemName(row)} for good?`}
      width={440}
      danger
      onClose={saving ? () => false : onClose}
      onSubmit={onPurge}
      canSubmit={!saving && along.ready}
      submitLabel={saving ? 'Deleting…' : 'Delete for good'}
      focusAfterClose={focusAfterClose}
    >
      <p data-purge className="break-words text-base leading-normal text-text-2">
        Deletes{' '}
        <b className="font-semibold text-text-1">
          {row.kind === 'task' ? `${row.key} ${row.title}` : row.title}
        </b>
        {rest}
        <span data-purge-along>{along.text}</span> This cannot be undone. Its files then stop
        counting toward your organization’s storage.
      </p>
    </ModalShell>
  )
}
