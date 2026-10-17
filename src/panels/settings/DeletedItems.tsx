/* Settings › Projects › Deleted items (design 10): the tasks and projects in
   the trash that this login may see in each of its organizations, live from
   deletedItems.list, with tasks inside deleted projects found by search
   (deletedItems.matches). One item restores without asking; several open a
   window that says where they go back. An organization admin can delete an
   item for good from its row menu. The page never names the 30 days an item
   stays: only the user guide does. Row text, folding and the filters live in
   lib/deletedItems.ts; times in lib/deletedTime.ts. */

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { PageTitle } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { convex } from '@/lib/convex'
import { cn } from '@/lib/utils'
import { api } from '../../../convex/_generated/api'
import { Icon, MenuItem, Popover, Seg, StatusDot } from '../../components/qivo'
import {
  ANYONE,
  andList,
  blockedText,
  byTime,
  chosenProfile,
  type DeletedList,
  type DeletedMatch,
  type DeletedRow,
  deletedBy,
  deletedByOptions,
  deleterName,
  deleterSentence,
  destinations,
  FOLD,
  fold,
  foldText,
  itemName,
  itemSuffix,
  type KindFilter,
  type Line,
  lineItem,
  type Piece,
  placeText,
  plural,
  type RestoreRefusal,
  refusalText,
  restoreNoun,
  rowHasText,
  stateText,
  viaText,
} from '../../lib/deletedItems'
import { deletedAtFull, deletedAtLabel } from '../../lib/deletedTime'
import { restoreFocus } from '../../lib/focusVisibility'
import { type DeletedItemsOutcome, P } from '../../store/planner'
import { ModalShell } from '../Modals'
import '../../styles/deleted-items.css'

type Role = 'admin' | 'lead' | 'user'

const SUBTITLES: Record<Role, string> = {
  admin: 'Tasks and projects deleted in your organization.',
  lead: 'Tasks and projects you deleted, and those deleted in projects you lead.',
  user: 'Tasks and projects you deleted.',
}

/* Who the page speaks to: an organization admin sees every delete, a lead
   their own and those in the projects they lead, everyone else their own
   (design 6.1). A lead of any project in any of the login's organizations
   reads as a lead. */
function viewerRole(): Role {
  if (P.isAdmin()) return 'admin'
  return P.projects.some((p) => P.levelOn(p.id) === 'lead') ? 'lead' : 'user'
}

/** deletedItems.list, live: undefined while loading, null after an error.
    `deleted_by` narrows it to one person on the server. `latest` holds the
    newest answer at once, for code that runs before the page renders it. */
function useDeletedList(deletedBy: string | undefined, enabled: boolean) {
  const [list, setList] = useState<DeletedList | null | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef<DeletedList | null>(null)
  useEffect(() => {
    latest.current = null
    setList(undefined)
    if (!enabled) return
    let active = true
    const unsubscribe = convex.onUpdate(
      api.deletedItems.list,
      deletedBy === undefined ? {} : { deleted_by: deletedBy },
      (answer) => {
        if (!active) return
        latest.current = answer
        setList(answer)
      },
      (cause) => {
        console.error('[qivo] deleted items failed:', cause)
        if (active) setList(null)
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [deletedBy, enabled, attempt])
  return { list, latest, retry: () => setAttempt((n) => n + 1) }
}

/** The windows the page opens: restore several items, restore an item that
    waits for a deleted project, or delete one for good. `line` is the row
    that opened it, for focus. */
type Ask =
  | { kind: 'bulk'; rows: DeletedRow[] }
  | { kind: 'project'; line: Line; key: string }
  | { kind: 'purge'; row: DeletedRow; key: string }

/** The rows on either side of a row that may leave the list. */
type Around = { next?: string; previous?: string }

const toast = (text: string, tone?: 'error') => window.showToast?.(text, tone)

export function DeletedItemsPage() {
  const role = viewerRole()
  const main = useDeletedList(undefined, true)
  const [kind, setKind] = useState<KindFilter>('all')
  const [search, setSearch] = useState('')
  const [by, setBy] = useState(ANYONE)
  const all = main.list?.items ?? []
  // A capped list may not hold a person's older deletes; ask the server for
  // that person alone then (only an admin's seat reaches further).
  const person = main.list?.capped ? chosenProfile(by, all) : undefined
  const narrowed = useDeletedList(person, person !== undefined)
  const source = person === undefined ? main : narrowed
  const rows = source.list?.items ?? []
  const loaded = source.list !== undefined && source.list !== null
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const allById = useMemo(() => new Map(all.map((row) => [row.id, row])), [all])

  const [found, setFound] = useState<DeletedMatch[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [refusals, setRefusals] = useState<ReadonlyMap<string, RestoreRefusal>>(() => new Map())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [ask, setAsk] = useState<Ask | null>(null)
  const [saving, setSaving] = useState(false)
  // items deferred behind a project item of the same restore: sent again once
  // the list shows them restorable (design 5)
  const waiting = useRef(new Set<string>())
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

  /* Search hits inside deleted projects, 250ms after typing stops. The
     sequence drops an answer that a newer text overtook. */
  const text = search.trim()
  const sequence = useRef(0)
  useEffect(() => {
    const mine = ++sequence.current
    if (!text) {
      setFound([])
      return
    }
    const timer = window.setTimeout(() => {
      convex.query(api.deletedItems.matches, { text }).then(
        (answer) => {
          if (sequence.current === mine) setFound(answer)
        },
        (cause) => {
          console.error('[qivo] deleted items search failed:', cause)
          if (sequence.current === mine) setFound([])
        },
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [text])

  /* Each delivery: drop selected ids that left the list or became blocked
     (an id the last restore refused stays, with its reason), forget
     refusals of rows that left, and send again the deferred items the list
     now shows restorable. */
  useEffect(() => {
    if (!loaded) return
    setSelected((current) => {
      const next = new Set(
        [...current].filter((id) => {
          const row = byId.get(id)
          return row !== undefined && (row.can_restore || refusals.has(id))
        }),
      )
      return next.size === current.size ? current : next
    })
    setRefusals((current) => {
      const next = new Map([...current].filter(([id]) => byId.has(id)))
      return next.size === current.size ? current : next
    })
    const ready: DeletedRow[] = []
    for (const id of waiting.current) {
      const row = byId.get(id)
      if (row === undefined) waiting.current.delete(id)
      else if (row.can_restore) {
        waiting.current.delete(id)
        ready.push(row)
      }
    }
    if (ready.length) void restore(ready)
    // restore reads the newest state through refs and setters
  }, [byId, loaded, refusals])

  const options = useMemo(
    () => deletedByOptions(all, new Set(all.map((row) => row.org_id)).size > 1),
    [all],
  )
  // a person whose deletes all left the list leaves the select too
  useEffect(() => {
    if (main.list && by !== ANYONE && !options.some((o) => o.value === by)) setBy(ANYONE)
  }, [main.list, by, options])

  /* ---------------------------------------------------------- the lines */
  const lower = text.toLowerCase()
  const lines: Line[] = []
  for (const row of rows)
    if (
      (kind === 'all' || row.kind === kind) &&
      deletedBy(row.deleter, by) &&
      (!lower || rowHasText(row, lower))
    )
      lines.push({ kind: 'item', row })
  // matches are not reactive: a hit whose project item left the list goes
  if (lower && kind !== 'project')
    for (const match of found) {
      const item = byId.get(match.item_id)
      if (item && deletedBy(match.deleter, by)) lines.push({ kind: 'match', match, item })
    }
  lines.sort(byTime)
  const filtered = kind !== 'all' || !!lower || by !== ANYONE
  const orgs = [...new Set(all.map((row) => row.org_id))]
  const grouped = orgs.length > 1
  const groups = grouped
    ? orgs
        .map((org) => ({
          org,
          name: all.find((row) => row.org_id === org)?.org_name ?? '',
          lines: lines.filter((line) => lineItem(line).org_id === org),
        }))
        .filter((group) => group.lines.length > 0)
        .sort(
          (a, b) =>
            Number(b.org === P.homeOrg) - Number(a.org === P.homeOrg) ||
            a.name.localeCompare(b.name),
        )
    : [{ org: '', name: '', lines }]
  const shownIds = [
    ...new Set(
      lines
        .map(lineItem)
        .filter((row) => row.can_restore)
        .map((r) => r.id),
    ),
  ]
  const chosen = [...selected].flatMap((id) => byId.get(id) ?? [])
  const chosenReady = chosen.filter((row) => row.can_restore)
  const wide = rows.some((row) => row.can_purge)
  const now = new Date()

  /* ---------------------------------------------------------- selection */
  const choose = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  const boxState = (ids: string[]): boolean | 'indeterminate' => {
    const on = ids.filter((id) => selected.has(id)).length
    return on === 0 ? false : on === ids.length ? true : 'indeterminate'
  }

  /* -------------------------------------------------------------- focus */
  const lineEls = () => [...(pageRef.current?.querySelectorAll<HTMLElement>('[data-line]') ?? [])]
  const findLine = (key: string | undefined) =>
    key === undefined ? null : (lineEls().find((el) => el.dataset.line === key) ?? null)
  const around = (key: string): Around => {
    const els = lineEls()
    const at = els.findIndex((el) => el.dataset.line === key)
    return at < 0 ? {} : { next: els[at + 1]?.dataset.line, previous: els[at - 1]?.dataset.line }
  }
  const controlOf = (el: HTMLElement | null, prefer = '[data-restore]') =>
    el?.querySelector<HTMLElement>(`${prefer}:not(:disabled)`) ??
    el?.querySelector<HTMLElement>(
      '[data-restore]:not(:disabled), [data-select]:not(:disabled), [data-row-menu]',
    ) ??
    null
  /** Where focus goes after an action on row `key`: back to the row while it
      is there, else the next row's Restore, the previous row's, or the
      search box (the review's keyboard rules). */
  const targetAround = (key: string, sides: Around, prefer?: string) => {
    const here = findLine(key)
    if (here) return controlOf(here, prefer)
    return (
      controlOf(findLine(sides.next)) ?? controlOf(findLine(sides.previous)) ?? searchRef.current
    )
  }
  /* After an action that did not open a window: move focus only when it was
     on the row (or fell to the page when the row left). */
  const settleFocus = (key: string, sides: Around) => () => {
    const active = document.activeElement
    const here = findLine(key)
    const lost = !active || active === document.body || !active.isConnected
    if (!lost && !here?.contains(active)) return
    restoreFocus(targetAround(key, sides))
  }

  /** After a restore of the selection: the select-all box, or the search box
      when nothing is left to select. */
  const selectAllOrSearch = () =>
    pageRef.current?.querySelector<HTMLElement>('[data-select-all]:not(:disabled)') ??
    searchRef.current

  /* ----------------------------------------------------------- restoring */
  /** Restores `items` and says how it went. `announce` are the items the
      person asked for; others in the call are what they wait for. `settle`
      moves focus once the page shows the answer. */
  async function restore(items: DeletedRow[], announce = items, settle?: () => void) {
    const ids = items.map((row) => row.id)
    setBusy((current) => new Set([...current, ...ids]))
    setRefusals((current) => new Map([...current].filter(([id]) => !ids.includes(id))))
    const outcome = await P.restoreDeletedItems(items)
    for (const id of outcome.deferred) waiting.current.add(id)
    if (settle) focusNext.current = settle
    setBusy((current) => new Set([...current].filter((id) => !ids.includes(id))))
    setRefusals((current) => {
      const next = new Map(current)
      for (const { id, reason } of outcome.refused) next.set(id, reason)
      return next
    })
    const back = new Set([...outcome.done, ...outcome.deferred])
    setSelected((current) => new Set([...current].filter((id) => !back.has(id))))
    announceRestore(announce, outcome, back)
    return outcome
  }

  /* The toast after a restore (the review's spec): one item by name, many by
     count, and a partial failure as an error that counts what failed. */
  function announceRestore(
    items: DeletedRow[],
    outcome: DeletedItemsOutcome<RestoreRefusal>,
    back: ReadonlySet<string>,
  ) {
    const done = items.filter((row) => back.has(row.id))
    const missed = items.length - done.length
    if (missed === 0) {
      if (done.length !== 1) {
        toast(`Restored ${restoreNoun(done)}`)
        return
      }
      const row = done[0]
      if (row.kind === 'task') {
        toast(`Restored ${row.key}${row.archived ? ' to Archived tasks' : ''}`)
        return
      }
      // a project too large for one call goes on in steps, and its row says so
      const stepping = (source.latest.current?.items ?? []).some(
        (r) => r.id === row.id && r.state === 'restoring',
      )
      toast(
        stepping
          ? `Restoring “${row.title}”…`
          : `Restored “${row.title}”${row.archived ? ' to Archived projects' : ''}`,
      )
      return
    }
    if (items.length === 1) {
      const row = items[0]
      const reason = outcome.refused.find((r) => r.id === row.id)?.reason
      const name = row.kind === 'task' ? row.key : `“${row.title}”`
      toast(
        reason
          ? `Couldn't restore ${name}. ${refusalText(reason)}`
          : (outcome.error ?? `Couldn't restore ${name}.`),
        'error',
      )
      return
    }
    if (done.length === 0) {
      toast(outcome.error ?? `Couldn't restore ${restoreNoun(items)}.`, 'error')
      return
    }
    toast(
      `Restored ${done.length.toLocaleString('en-US')} of ${restoreNoun(items)}. ${missed.toLocaleString('en-US')} couldn't be restored.`,
      'error',
    )
  }

  /** A row's Restore: at once for one item, through the project window for
      a search hit or an item whose project is deleted too. */
  const restoreLine = (line: Line, key: string) => {
    const row = lineItem(line)
    const reason = row.blocked?.reason
    if (line.kind === 'match' || reason === 'project_deleted' || reason === 'parent_deleted') {
      windowSides.current = {}
      setAsk({ kind: 'project', line, key })
      return
    }
    if (!row.can_restore || busy.has(row.id)) return
    void restore([row], [row], settleFocus(key, around(key)))
  }

  /** Restore N selected: one item at once, more after the window asks. */
  const restoreSelected = () => {
    if (chosenReady.length === 0) return
    if (chosenReady.length > 1) {
      setAsk({ kind: 'bulk', rows: chosenReady })
      return
    }
    void restore(chosenReady, chosenReady, () => restoreFocus(selectAllOrSearch()))
  }

  /* --------------------------------------------------------------- render */
  // a list narrowed to one person on the server has no total to count against
  const countText =
    filtered && person === undefined
      ? `${lines.length.toLocaleString('en-US')} of ${plural(rows.length, 'item')}`
      : plural(lines.length, 'item')

  const selectionBar = (place: 'top' | 'bottom') => (
    <>
      {place === 'bottom' && (
        <span className="text-sm font-semibold text-text-1">
          {selected.size.toLocaleString('en-US')} selected
        </span>
      )}
      <Button
        type="button"
        variant="quiet"
        size="sm"
        data-clear-selection
        onClick={() => setSelected(new Set())}
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
        disabled={chosenReady.length === 0}
        onClick={restoreSelected}
      >
        <Icon name="rotateCcw" size={16} />
        Restore {chosenReady.length.toLocaleString('en-US')} selected
      </Button>
    </>
  )

  const renderLine = (line: Line, key: string) => {
    const item = lineItem(line)
    const match = line.kind === 'match' ? line.match : null
    const state = match ? match.state : item.state
    const ready = state === 'ready'
    const blocked = match ? match.blocked : item.blocked
    const deleter = match ? match.deleter : item.deleter
    const name = match ? match.key : itemName(item)
    const opensWindow =
      match !== null ||
      blocked?.reason === 'project_deleted' ||
      blocked?.reason === 'parent_deleted'
    const canRestore = ready && !item.redacted && (item.can_restore || opensWindow)
    const holder = blocked?.item_id ? allById.get(blocked.item_id) : undefined
    const refused = refusals.get(item.id)
    // the reason given at deletion, then why the row cannot be restored now
    const notes: { key: string; text: ReactNode }[] = []
    if (!match && item.reason)
      notes.push({
        key: 'reason',
        text: (
          <>
            Reason <span className="text-text-1">“{item.reason}”</span>
          </>
        ),
      })
    const stateLine = stateText(state)
    const blockedLine = blocked && !item.redacted ? blockedText(blocked, holder?.title) : null
    if (stateLine) notes.push({ key: 'state', text: stateLine })
    else if (blockedLine) notes.push({ key: 'blocked', text: blockedLine })
    else if (refused) notes.push({ key: 'refused', text: refusalText(refused) })
    const place = match ? match.path.filter(Boolean).join(' › ') : placeText(item)
    const archived = match ? match.archived : item.archived
    const time = new Date(item.deleted_at)
    const status = !match && !item.redacted && item.kind === 'task' ? item.status : undefined
    return (
      <div
        key={key}
        data-line={key}
        data-deleted-row={match ? undefined : item.id}
        data-deleted-match={match ? match.key : undefined}
        data-state={state}
        className={cn(
          'deleted-row rounded-md border border-border bg-surface-1 p-2',
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
              disabled={!item.can_restore}
              onCheckedChange={(on) => choose([item.id], on === true)}
            />
          ) : (
            <span className="size-4" />
          )}
        </div>
        <span className="deleted-row-icon mt-[2px] flex text-text-2">
          {item.kind === 'project' && !match ? (
            <Icon name="layers" size={16} color="var(--text-2)" />
          ) : status ? (
            <StatusDot status={status} size={16} />
          ) : (
            <Icon name="circleDot" size={16} />
          )}
        </span>
        <div className="deleted-row-title flex min-w-0 items-baseline gap-2">
          {(match || item.kind === 'task') && (
            <span className="shrink-0 font-mono text-xs text-text-2">{name}</span>
          )}
          <span className="line-clamp-2 min-w-0 break-words text-base font-medium leading-[1.4] text-text-1">
            {match ? match.title : item.title}
          </span>
          {!match && itemSuffix(item) && (
            <span className="shrink-0 text-sm text-text-2">{itemSuffix(item)}</span>
          )}
        </div>
        <div className="deleted-row-meta mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-2">
          {(place || item.redacted || archived) && (
            <span data-row-place className="deleted-row-where flex flex-wrap gap-x-3">
              {item.redacted && !match ? (
                <span>Deleted with a task in a project you can't open</span>
              ) : (
                place && (
                  <span>
                    {place}
                    {match && <span className="text-danger">, deleted with the project</span>}
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
        {notes.length > 0 && (
          <div data-row-notes className="deleted-row-notes">
            {notes.map((note) => (
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
        <div
          className={cn(
            'deleted-row-actions flex shrink-0 items-center justify-end gap-0.5',
            wide ? 'w-[128px]' : 'w-[96px]',
          )}
        >
          {canRestore && (
            <Button
              type="button"
              variant="ghost"
              data-restore
              aria-label={`Restore ${name}`}
              disabled={busy.has(item.id)}
              className="h-control-sm shrink-0 text-sm text-text-1"
              onClick={() => restoreLine(line, key)}
            >
              <Icon name="rotateCcw" size={16} />
              <span className="deleted-restore-label">
                {busy.has(item.id) ? 'Restoring…' : 'Restore'}
              </span>
            </Button>
          )}
          {item.can_purge && (
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
                  onClick={() =>
                    close(() => {
                      windowSides.current = {}
                      setAsk({ kind: 'purge', row: item, key })
                    })
                  }
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
    if (piece.kind === 'line') {
      const { line } = piece
      const key = line.kind === 'item' ? line.row.id : `${line.match.item_id}:${line.match.key}`
      return renderLine(line, key)
    }
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
              setOpen((current) => new Set([...current].filter((k) => k !== piece.key)))
            }}
          >
            Show fewer
          </Button>
        </div>
      )
    const ids = piece.run.filter((row) => row.can_restore).map((row) => row.id)
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
          disabled={!ids.length}
          onCheckedChange={(on) => choose(ids, on === true)}
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

  let body: ReactNode
  if (source.list === undefined) body = <ListNote>Loading…</ListNote>
  else if (source.list === null)
    body = (
      <div role="alert" className="flex items-center gap-3 px-2 py-4">
        <span className="text-base text-text-2">Couldn't load deleted items.</span>
        <Button type="button" size="sm" onClick={source.retry}>
          Try again
        </Button>
      </div>
    )
  else if (rows.length === 0) body = <ListNote>No deleted items.</ListNote>
  else if (lines.length === 0) body = <ListNote>No deleted items match the filter.</ListNote>
  else
    body = groups.map((group) => (
      <div key={group.org} data-org-group={group.org || undefined} className="mb-2 last:mb-0">
        {grouped && (
          <div className="mt-4 mb-2 px-1 text-sm font-semibold text-text-1">{group.name}</div>
        )}
        <div className="flex flex-col gap-2">{fold(group.lines, open).map(renderPiece)}</div>
      </div>
    ))

  return (
    <>
      <PageTitle sub={SUBTITLES[role]}>Deleted items</PageTitle>
      <div ref={pageRef} data-deleted-items>
        <div className="deleted-filter-block sticky top-[-16px] z-10 -mx-1 mb-2 px-1 pt-1 pb-1">
          <div className="deleted-filters flex items-center gap-2">
            <Seg<KindFilter>
              value={kind}
              onChange={setKind}
              options={[
                { value: 'all', label: 'All' },
                { value: 'task', label: 'Tasks' },
                { value: 'project', label: 'Projects' },
              ]}
            />
            <div className="flex h-control w-[220px] shrink-0 items-center gap-2 rounded-md border border-border bg-surface-1 px-2">
              <Icon name="search" size={16} color="var(--text-3)" />
              <Input
                ref={searchRef}
                data-deleted-search
                aria-label="Filter deleted items"
                placeholder="Filter deleted items…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  // Escape clears a live filter first; an empty field lets it
                  // reach Settings, which closes
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
                  aria-label="Clear the filter"
                  onClick={() => {
                    setSearch('')
                    searchRef.current?.focus()
                  }}
                >
                  <Icon name="close" size={12} />
                </Button>
              )}
            </div>
            {role !== 'user' && (
              <NativeSelect
                aria-label="Deleted by"
                data-deleted-by
                value={by}
                onChange={(e) => setBy(e.target.value)}
                className="h-control w-[270px] shrink-0 cursor-pointer bg-surface-1 font-sans text-sm"
              >
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
          <div className="mt-2 flex h-control items-center gap-2.5 border-b border-border pr-1 pl-[9px]">
            <Checkbox
              data-select-all
              aria-label="Select all shown"
              checked={shownIds.length ? boxState(shownIds) : false}
              disabled={!shownIds.length}
              onCheckedChange={(on) => choose(shownIds, on === true)}
            />
            <span role="status" data-deleted-count>
              {selected.size > 0 ? (
                <span className="text-sm font-semibold text-text-1">
                  {selected.size.toLocaleString('en-US')} selected
                </span>
              ) : (
                loaded && <span className="font-mono text-sm text-text-2">{countText}</span>
              )}
            </span>
            {selected.size > 0 && (
              <div className="deleted-selection-actions flex min-w-0 flex-1 items-center gap-2.5">
                {selectionBar('top')}
              </div>
            )}
          </div>
        </div>
        {body}
        {source.list?.capped && (
          <p className="mt-3 px-1 text-sm text-text-2">Showing the newest 2,000 items.</p>
        )}
        {selected.size > 0 && (
          <div data-selection-bar className="deleted-selection-bar">
            {selectionBar('bottom')}
          </div>
        )}
      </div>
      {ask?.kind === 'bulk' && (
        <BulkRestoreWindow
          rows={ask.rows}
          now={now}
          saving={saving}
          onClose={() => setAsk(null)}
          onRestore={async () => {
            setSaving(true)
            const outcome = await restore(ask.rows)
            setSaving(false)
            // refused whole (billing, offline): stay open for another try
            if (outcome.error === null || outcome.done.length > 0) setAsk(null)
          }}
          focusAfterClose={selectAllOrSearch}
        />
      )}
      {ask?.kind === 'project' && (
        <ProjectFirstWindow
          line={ask.line}
          holder={(() => {
            const item = lineItem(ask.line)
            const id = ask.line.kind === 'match' ? item.id : item.blocked?.item_id
            return id === undefined ? undefined : allById.get(id)
          })()}
          saving={saving}
          onClose={() => setAsk(null)}
          onRestore={async (holder) => {
            const item = lineItem(ask.line)
            windowSides.current = around(ask.key)
            setSaving(true)
            // a search hit comes back with its project; an item that waits
            // for its project goes in the same call and is deferred
            const outcome = await restore(ask.line.kind === 'match' ? [holder] : [holder, item], [
              holder,
            ])
            setSaving(false)
            // refused whole (billing, offline): stay open for another try
            if (outcome.error === null || outcome.done.length > 0) setAsk(null)
          }}
          focusAfterClose={() => targetAround(ask.key, windowSides.current)}
        />
      )}
      {ask?.kind === 'purge' && (
        <PurgeWindow
          row={ask.row}
          saving={saving}
          onClose={() => setAsk(null)}
          onPurge={async () => {
            const { row } = ask
            windowSides.current = around(ask.key)
            setSaving(true)
            const outcome = await P.purgeDeletedItems([row])
            setSaving(false)
            const name = row.kind === 'task' ? row.key : `“${row.title}”`
            const refused = outcome.refused[0]
            if (outcome.done.includes(row.id)) toast(`Deleted ${name} for good`)
            else if (refused)
              toast(`Couldn't delete ${name} for good. ${refusalText(refused.reason)}`, 'error')
            else {
              // refused whole (billing, offline): stay open for another try
              toast(outcome.error ?? `Couldn't delete ${name} for good.`, 'error')
              return
            }
            setAsk(null)
          }}
          focusAfterClose={() => targetAround(ask.key, windowSides.current, '[data-row-menu]')}
        />
      )}
    </>
  )
}

/** The list area's one line when it has no rows. */
function ListNote({ children }: { children: ReactNode }) {
  return <div className="px-2 py-4 text-base italic text-text-2">{children}</div>
}

/** The bulk restore window: who deleted the items and when, where they go
    back, and what does not come back with them. */
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
  const noun = restoreNoun(rows)
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
    archived === 0 ? '' : tasks === 1 ? ', which is archived' : `, ${archived} of them archived`
  return `${holder.title} comes back with ${andList(parts)}${kept}. They keep their keys.`
}

/** "<key> is in a deleted project": a search hit inside a deleted project, or
    (for admins) an item deleted before its project, can only come back with
    that project item. Restore brings the project back first. When the
    project item cannot be restored, the window says why and offers Close. */
function ProjectFirstWindow({
  line,
  holder,
  saving,
  onClose,
  onRestore,
  focusAfterClose,
}: {
  line: Line
  holder: DeletedRow | undefined
  saving: boolean
  onClose: () => void
  onRestore: (holder: DeletedRow) => void
  focusAfterClose: () => HTMLElement | null
}) {
  const item = lineItem(line)
  const name = line.kind === 'match' ? line.match.key : itemName(item)
  const canRestore = holder?.can_restore === true
  const reason = !holder
    ? null
    : (stateText(holder.state) ??
      (holder.blocked ? blockedText(holder.blocked) : null) ??
      (canRestore ? null : refusalText('no_access')))
  return (
    <ModalShell
      icon="rotateCcw"
      title={`${name} is in a deleted project`}
      width={440}
      onClose={saving ? () => false : onClose}
      onSubmit={() => holder && onRestore(holder)}
      canSubmit={canRestore && !saving}
      submitLabel={saving ? 'Restoring…' : `Restore ${holder?.title ?? 'the project'} and ${name}`}
      focusAfterClose={focusAfterClose}
      footer={
        canRestore ? undefined : (
          <>
            <div className="min-w-0 flex-1" />
            <Button type="button" variant="ghost" className="text-text-1" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      <div data-project-first className="flex flex-col gap-3 text-base leading-normal text-text-2">
        {holder ? (
          <p>
            <b className="font-semibold text-text-1">{name}</b>
            {line.kind === 'match'
              ? ' was deleted together with its project '
              : ' was deleted before its project '}
            <b className="font-semibold text-text-1">{holder.title}</b>
            {line.kind === 'match'
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
    </ModalShell>
  )
}

/** Delete now: an organization admin deletes one item for good. */
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
  return (
    <ModalShell
      icon="warning"
      title={`Delete ${itemName(row)} for good?`}
      width={440}
      danger
      onClose={saving ? () => false : onClose}
      onSubmit={onPurge}
      canSubmit={!saving}
      submitLabel={saving ? 'Deleting…' : 'Delete for good'}
      focusAfterClose={focusAfterClose}
    >
      <p data-purge className="text-base leading-normal text-text-2">
        Deletes{' '}
        <b className="font-semibold text-text-1">
          {row.kind === 'task' ? `${row.key} ${row.title}` : row.title}
        </b>
        {rest} This cannot be undone.
      </p>
    </ModalShell>
  )
}
