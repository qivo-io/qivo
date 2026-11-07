/* Inbox lists the server's pages of task groups (convex/inbox.ts page), one
   row a task with its newest message and unread count, 50 rows a page with
   Previous and Next (lib/pagedList.ts usePagedPages), beside an embedded
   IssueDetail. The order, Unread only, Show snoozed, the kinds and the
   desktop search are the page's arguments (lib/inboxPage.ts inboxArgs):
   the list never filters, searches, sorts or counts rows itself, and only
   the marks of the person's own writes in flight change how a row shows
   (store/planner.ts P.inboxMarks). The page on screen stays live while the
   Inbox shows, reads nothing while the tab hides or another view shows a
   kept Inbox, and only it and the starts behind it are held. Its notes say
   what its answer says: how far a stopped page looked, a seat whose
   messages are being prepared, a group a check left out, and the empty
   sentences only on a complete answer. Opening a row opens its task in the
   pane, whose window freezes the "New" divider from the task's inbox item
   before it reads the item, as every task window does (IssueDetail). Row
   menus act on the row's item by its organization and task with the row's
   cutoff (P.readItem, P.unreadItem, P.removeItem, P.snoozeItem), with
   separate inbox-wide commands. Server rules expose only the viewer's
   messages and allow read/snooze/delete actions; notification content
   remains server-owned. */
import { CheckCheck, ListX, Minus, Plus } from 'lucide-react'
import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownChevron } from '@/components/ui/select'
import {
  HoverTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { api } from '../../convex/_generated/api'
import { LIMITS } from '../../convex/lib/limits'
import { LimitedInput } from '../components/LimitedField'
import { PageFold } from '../components/pageFold'
import { pagesState, useMoveFocus } from '../components/pageMoves'
import {
  AnchoredPop,
  Icon,
  MenuDivider,
  MenuItem,
  Popover,
  ProjectName,
  Seg,
} from '../components/qivo'
import { fmtDateTime } from '../lib/dates'
import { closeOrAsk, typesText } from '../lib/discardQuestion'
import { restoreFocus } from '../lib/focusVisibility'
import {
  emptyLine,
  heldLine,
  type InboxFilters,
  type InboxKind,
  type InboxPageAnswer,
  type InboxPageRow,
  inboxArgs,
  inboxBatch,
  inboxWords,
  maySnooze,
  notReadyLine,
  UNCHECKED_LINE,
} from '../lib/inboxPage'
import { UnsentScopeContext, useUnsentScope } from '../lib/leaveGuard'
import { useLiveView } from '../lib/liveView'
import { noProjectsHint, seesNoProject } from '../lib/noProjects'
import { notificationPermission, requestNotificationPermission } from '../lib/notify'
import { pageEnd, usePagedPages, useSettledSearch } from '../lib/pagedList'
import { sameTask, taskFacts } from '../lib/router'
import { fmtSnoozeUntil, SNOOZE_UNIT_MS, type SnoozeUnit, snoozeStepMax } from '../lib/snooze'
import { taskRef } from '../lib/taskReference'
import { useMobile } from '../lib/useMobile'
import { OUT_OF_USE } from '../lib/viewHidden'
import {
  type BulkAction,
  bulkBusy,
  bulkName,
  bulkNoticeText,
  bulkProgressText,
} from '../store/inboxBulk'
import { P } from '../store/planner'
import { usePlannerVersion } from '../store/usePlannerVersion'
import { type InboxRowVM, inboxMarkKey, markedRow, shapeInboxRow } from '../store/viewModels'
import { IssueDetail } from './IssueDetail'
import { useTaskKey } from './taskKey'

/* Spec'd age form: hours up to 24 h, then days (minutes only under an hour —
   "0h" would read as broken). */
function fmtMsgAge(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (m < 60) return m < 1 ? 'now' : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/* One row of the menu's Snooze section: a unit, its stepper and its own
   Snooze button. The button pressed decides the unit; the other rows'
   numbers are ignored. Stepping never closes the menu, stops at 1 and at the
   server's snooze limit (snoozeStepMax); the button's hover help names the
   exact return time. */
function SnoozeRow({
  unit,
  count,
  onCount,
  onSnooze,
}: {
  unit: SnoozeUnit
  count: number
  onCount: (n: number) => void
  onSnooze: (until: string) => void
}) {
  // oxlint-disable-next-line react/purity -- the picker shows when a snooze from now would end
  const until = new Date(Date.now() + count * SNOOZE_UNIT_MS[unit])
  const max = snoozeStepMax(unit)
  const stepClass =
    'inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-text-1 hover:border-border-strong hover:bg-hover disabled:cursor-default disabled:opacity-55 disabled:hover:border-border disabled:hover:bg-surface-1'
  return (
    <div
      data-msg-snooze-row={unit}
      className="flex min-h-8 items-center gap-2 px-2 py-1 text-base text-text-1"
    >
      <Icon name="clockFading" size={13} />
      {unit.charAt(0).toUpperCase() + unit.slice(1)}
      <div className="[flex:1]" />
      <Button
        type="button"
        variant="unstyled"
        className={stepClass}
        data-control-fill
        aria-label={`Fewer ${unit}`}
        disabled={count <= 1}
        onClick={() => onCount(Math.max(1, count - 1))}
      >
        <Minus size={12} strokeWidth={2} aria-hidden="true" />
      </Button>
      <span
        data-msg-snooze-count
        className="min-w-[18px] text-center !font-mono text-base"
        aria-live="polite"
      >
        {count}
      </span>
      <Button
        type="button"
        variant="unstyled"
        className={stepClass}
        data-control-fill
        aria-label={`More ${unit}`}
        disabled={count >= max}
        onClick={() => onCount(Math.min(max, count + 1))}
      >
        <Plus size={12} strokeWidth={2} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="unstyled"
        data-msg-snooze-go
        data-control-fill
        className="ml-1 inline-flex h-6 shrink-0 items-center rounded-md border border-border bg-surface-1 px-2 text-sm text-text-1 hover:border-border-strong hover:bg-hover"
        title={`Until ${fmtDateTime(until)}`}
        aria-label={`Snooze ${count} ${count === 1 ? unit.slice(0, -1) : unit}`}
        onClick={() => onSnooze(until.toISOString())}
      >
        Snooze
      </Button>
    </div>
  )
}

const KIND_LABELS: Record<string, string> = {
  mention: 'Mentions',
  comment: 'Comments',
  change: 'Changes',
}
const KIND_ICONS: Record<string, string> = {
  mention: 'user',
  comment: 'comment',
  change: 'history',
}

/** The line an inbox row shows when the server's item cap deleted `n` of
    its earlier unread updates. */
const droppedLine = (n: number) =>
  n === 1
    ? '1 earlier update on this task is not listed'
    : `${n.toLocaleString('en-US')} earlier updates on this task are not listed`

function MessageRow({
  row,
  selected,
  menuOpen,
  onSelect,
  onMenu,
}: {
  row: InboxRowVM
  selected: boolean
  menuOpen: boolean
  onSelect: (row: InboxRowVM) => void
  onMenu: (e: React.MouseEvent, row: InboxRowVM) => void
}) {
  // the imperative hover below has to fall back to THIS, not to transparent —
  // the pointer leaves the row the moment its context menu opens
  const bg = selected ? 'var(--accent-soft)' : menuOpen ? 'var(--hover)' : 'transparent'
  const snoozed = row.snoozedUntil !== null
  const places = row.parent ? [row.parent, row.project] : [row.project]
  return (
    <div
      data-message={row.uuid}
      data-message-org={row.org}
      data-message-key={row.key}
      data-selected={selected ? '' : undefined}
      data-kind={row.kind}
      data-kinds={row.kinds.join(' ')}
      data-unread={row.read ? undefined : ''}
      data-snoozed={snoozed ? '' : undefined}
      data-count={row.unreadCount}
      data-held={row.count}
      onContextMenu={(e) => onMenu(e, row)}
      style={{ background: bg }}
      className="[display:flex] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [cursor:pointer]"
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = 'var(--hover)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = bg
      }}
    >
      <Button
        type="button"
        variant="unstyled"
        className="inbox-message-open flex min-w-0 flex-1 items-start gap-2 border-0 bg-transparent p-0 text-left text-text-1"
        onClick={() => onSelect(row)}
      >
        <div className="[flex:1] [min-width:0]">
          <div className="[display:flex] [align-items:baseline] [gap:8px]">
            <span
              data-msg-title
              className={`flex-1 min-w-0 truncate text-base ${snoozed ? 'text-text-2' : 'text-text-1'} ${row.read ? 'font-normal' : 'font-semibold'}`}
            >
              {row.title}
            </span>
            {/* how much has happened to this task since you last read it. The
              line below shows the newest of them; the rest are listed when you
              open it. One alone needs no number — the dot already says it. */}
            {row.unreadCount > 1 && (
              <HoverTooltip content={`${row.unreadCount} new updates`}>
                <span
                  tabIndex={-1}
                  data-msg-count
                  className="[font-size:var(--fs-xs)] [font-weight:700] !font-mono [flex-shrink:0] [color:var(--text-1)] [background:var(--accent-soft)] [border-radius:var(--r-pill)] [padding:1px_6px]"
                >
                  {row.unreadCount}
                </span>
              </HoverTooltip>
            )}
            {/* a sleeping row says when it returns instead of how old it is */}
            {row.snoozedUntil !== null ? (
              <HoverTooltip content={`Returns ${fmtDateTime(new Date(row.snoozedUntil))}`}>
                <span
                  tabIndex={-1}
                  data-msg-until
                  className="[font-size:var(--fs-xs)] [color:var(--text-3)] !font-mono [flex-shrink:0] inline-flex items-center gap-1"
                >
                  <Icon name="clockFading" size={12} color="var(--text-3)" />
                  {fmtSnoozeUntil(row.snoozedUntil)}
                </span>
              </HoverTooltip>
            ) : (
              <HoverTooltip content={new Date(row.ts).toLocaleString()}>
                <span
                  tabIndex={-1}
                  data-msg-age
                  className="[font-size:var(--fs-xs)] [color:var(--text-3)] !font-mono [flex-shrink:0]"
                >
                  {fmtMsgAge(row.ts)}
                </span>
              </HoverTooltip>
            )}
          </div>
          {/* …and under the title, WHERE it is — project → sub-project, the
            same breadcrumb notation the task window's own crumb uses, from
            the page's row, so every row says it, whether or not the
            workspace holds its task. The counter beside the title promises
            the news and the window's Activity section lists it in full;
            the one thing the row could not say was which board the task
            sits on. */}
          <div
            data-msg-line2
            className="[margin-top:3px] [font-size:var(--fs-sm)] [color:var(--text-2)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
          >
            {places.map((p, i) => (
              <React.Fragment key={p.id}>
                {i > 0 && (
                  <Icon
                    name="chevronRight"
                    size={11}
                    color="var(--text-3)"
                    className="[display:inline-block] [vertical-align:-1px] [margin:0_1px]"
                  />
                )}
                <span data-msg-crumb>
                  <ProjectName project={p} />
                </span>
              </React.Fragment>
            ))}
          </div>
          <div className="inbox-message-preview">{row.line}</div>
          {/* an item keeps at most 50 unread updates (convex/model/messages.ts
            ITEM_UNREAD_CAP); say how many older ones it no longer lists */}
          {row.dropped > 0 && (
            <div
              data-msg-dropped={row.dropped}
              className="[margin-top:3px] [font-size:var(--fs-xs)] [color:var(--text-3)]"
            >
              {droppedLine(row.dropped)}
            </div>
          )}
        </div>
        {!row.read && (
          <span
            data-msg-dot
            className="[width:7px] [height:7px] [border-radius:50%] [background:var(--primary)] [flex-shrink:0] [align-self:center]"
          />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="inbox-message-actions"
        aria-label={`Message actions: ${row.title}`}
        onClick={(e) => onMenu(e, row)}
      >
        <Icon name="more" size={16} />
      </Button>
    </div>
  )
}

/* What the pane shows with no task selected. */
function PaneNote({ children }: { children?: React.ReactNode }) {
  return (
    <div data-inbox-detail className="inbox-note">
      <div className="[text-align:center] [color:var(--text-3)] [font-size:var(--fs-base)]">
        {children}
      </div>
    </div>
  )
}

/** A row, by its key (organization and task), and the rows the list showed
    with it, in order, for focus once the row leaves (focusRowAfter). A
    null key stands for the whole list, whose first row takes focus. */
type ListedRows = { id: string | null; ids: string[] }

/** The row menu: where it opened, and the row it opened on as it showed
    then, which its actions name with that row's cutoff, also when the
    live page moves or drops the row while the menu is open. */
type RowMenu = { x: number; y: number; row: InboxRowVM | null }

/** The task a row opens, by its handle where the workspace holds the task
    in the row's organization, else by a reference with the organization,
    the number and the uuid, as two organizations can hold one task id. */
function rowTask(row: InboxRowVM): string {
  const open = P.openTask(row.uuid, row.org, row.num)
  const held = P.issueById[open]
  return held && held.org !== row.org
    ? taskRef({ org: row.org, num: row.num, uuid: row.uuid })
    : open
}

/** The organization `org` as the notes name it. */
const orgName = (org: string) => P.orgs.find((o) => o.id === org)?.name ?? 'an organization'

export function Inbox({ showOnBoard, onExit, openTask, openIssue, onPlanOnRoadmap }) {
  const mobile = useMobile()
  const listScrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const queueScrollTop = useRef(0)
  const [sort, setSort] = useState<'new' | 'old'>('new')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [showSnoozed, setShowSnoozed] = useState(false) // sleeping items are hidden by default
  const [kinds, setKinds] = useState<InboxKind[]>([]) // empty = all
  // the row menu's Hours / Days steppers — back to 1 on every open
  const [snoozeFor, setSnoozeFor] = useState({ hours: 1, days: 1, weeks: 1 })
  const [search, setSearch] = useState('')
  const [, setNoteN] = useState(0) // re-render after a permission grant
  const [menu, setMenu] = useState<RowMenu | null>(null) // right-click menu
  // the rows the list showed when the pane's row was last among them, and
  // when the row menu acted on its row or on the whole list, for focus once
  // that row leaves (focusRowAfter)
  const paneRows = useRef<ListedRows | null>(null)
  const menuRows = useRef<ListedRows | null>(null)
  // the bulk action, which the store runs and keeps (store/inboxBulk.ts),
  // so an Inbox shown again shows it as it goes on, and the marks of the
  // person's writes on rows
  usePlannerVersion('inbox')
  const bulk = P.inboxBulk
  const bulkRuns = bulkBusy(bulk)
  // where the bulk action was pressed: a toolbar button, or the row menu
  const bulkFrom = useRef<BulkAction | 'menu' | null>(null)
  // true while the unread summary has no answer, else from its seat flags,
  // which also count messages no page shows (P.canMarkAllRead,
  // P.canRemoveRead, store/planner.ts deriveInboxFlags)
  const hasReadMessages = P.canRemoveRead
  const hasUnreadMessages = P.canMarkAllRead

  /* The page on screen (lib/pagedList.ts usePagedPages). The desktop
     search goes to the server once typing rests, up to LIMITS.search; past
     it the page keeps the last text within it and the fold says the
     limit. A phone has no search, so its list sends none, and a change of
     width starts the list again. A change of any filter or the search
     starts again at the first page and drops the starts behind it. */
  const { tooLong, settled } = useSettledSearch(mobile ? '' : search, LIMITS.search)
  const filters: InboxFilters = {
    order: sort === 'old' ? 'oldest' : 'newest',
    unreadOnly,
    showSnoozed,
    kinds,
    search: settled,
  }
  const page = usePagedPages<InboxPageAnswer, InboxPageRow>({
    key: JSON.stringify(inboxArgs(filters, null)),
    query: api.inbox.page,
    args: (after) => inboxArgs(filters, after),
    batch: inboxBatch,
  })
  const shaped = useMemo(() => page.rows.map(shapeInboxRow), [page.rows])
  // the rows as the person's own writes in flight show them, which only
  // ever turn a row read, unread, snoozed or woken, or hide it
  const marks = P.inboxMarks
  const rows = shaped.flatMap((row) => {
    const shown = markedRow(row, marks.get(row.key), { unreadOnly, showSnoozed })
    return shown ? [shown] : []
  })
  // A settled mark ends once the page shows an answer that is current
  // after it settled, which holds the write, so the row shows as the
  // server keeps it. A page that waits for a fresh answer, as after a
  // hidden tab, a kept Inbox shown again or a reconnect, keeps the marks.
  // An Inbox mounted afresh reads afresh, so it ends those settled before.
  const settledMarks = page.current ? [...marks.values()].filter((mark) => mark.settled) : []
  useEffect(() => {
    if (settledMarks.length) P.endInboxMarks(settledMarks)
  })
  useLayoutEffect(() => {
    if (page.phase === 'first') P.endInboxMarks([...P.inboxMarks.values()])
  }, [])

  // a search or a filter that narrows the list, which pageEnd answers
  // `none` for; Show snoozed widens it
  const searching = settled !== ''
  const filtered = searching || unreadOnly || kinds.length > 0
  const end = pageEnd(page, filtered)
  /* An empty first page with Show snoozed off cannot tell whether snoozed
     groups exist, so it asks the first page with them once, and says
     "No messages yet." only when that page says there are none. Until it
     answers, the end says it loads. */
  const asksSnoozed = end === 'empty' && !showSnoozed
  const snoozedPage = useLiveView<InboxPageAnswer>(
    api.inbox.page,
    asksSnoozed ? JSON.stringify(inboxArgs({ ...filters, showSnoozed: true }, null)) : null,
  )
  const snoozedKnown = snoozedPage.key !== null && snoozedPage.value !== undefined
  const snoozedMay =
    !asksSnoozed || snoozedPage.error !== undefined
      ? true
      : snoozedPage.value !== undefined && maySnooze(snoozedPage.value)
  const foldEnd = asksSnoozed && !snoozedKnown && snoozedPage.error === undefined ? 'loading' : end
  const words = inboxWords(page.answer, {
    order: filters.order,
    search: searching,
    filtered,
    empty: emptyLine({
      snoozed: asksSnoozed && snoozedMay,
      hint: seesNoProject() ? noProjectsHint() : null,
    }),
    timeOf: (iso) => fmtDateTime(new Date(iso)),
  })
  // the notes above the rows of an answer the page shows; an answer with
  // no rows says them in the fold's held line instead
  const notes =
    page.phase === 'held'
      ? []
      : [
          { key: 'not-ready', text: notReadyLine(page.answer, orgName) },
          { key: 'unchecked', text: page.answer?.unchecked ? UNCHECKED_LINE : null },
        ].filter((note) => note.text !== null)
  // the empty sentences take focus when a phone's list lost its last row
  // (focusRowAfter)
  const emptyEnd = foldEnd === 'none' || foldEnd === 'empty' || foldEnd === 'nomore'
  const state = pagesState(page)
  const move = useMoveFocus(
    page,
    'inbox-page',
    () => listScrollRef.current?.querySelector<HTMLElement>('.inbox-message-open') ?? null,
    () =>
      searchRef.current ?? listScrollRef.current?.querySelector<HTMLElement>('[data-inbox-empty]'),
  )
  // a page move shows the new page from its top
  const at = `${page.starts.length}:${String(page.starts[page.starts.length - 1])}`
  const shownAt = useRef(at)
  useLayoutEffect(() => {
    if (shownAt.current === at) return
    shownAt.current = at
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0
  }, [at])

  /** The rows on screen at a bulk press, which its marks follow. */
  const shownRows = () =>
    rows.map((row) => ({
      org: row.org,
      task: row.uuid,
      through: row.through,
      read: row.read,
      snoozed: row.snoozedUntil !== null,
    }))
  const runBulkAction = (action: BulkAction) => {
    if (bulkRuns || (action === 'read' ? !hasUnreadMessages : !hasReadMessages)) return
    // from the row menu, focus goes to the first row still listed, at once
    // and again once the paint shows; from the toolbar, back to its button
    // once the action ends
    if (menu) menuRows.current = { id: null, ids: [] }
    bulkFrom.current = menu ? 'menu' : action
    setMenu(null)
    // a long action asks first (the keep-open notice below)
    void (action === 'read'
      ? P.markAllMessagesRead(true, shownRows())
      : P.deleteReadMessages(true, shownRows()))
  }
  const bulkActionButtons = (
    <TooltipProvider>
      <fieldset
        className="inbox-bulk-actions m-0 ml-auto flex min-w-0 items-center gap-2 border-0 p-0"
        aria-label="Inbox actions"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                size="icon"
                data-inbox-mark-all-read
                aria-label="Mark all as read"
                aria-busy={bulkRuns && bulk?.action === 'read'}
                disabled={bulkRuns || !hasUnreadMessages}
                onClick={() => runBulkAction('read')}
              >
                <CheckCheck size={16} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Mark all as read</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                size="icon"
                data-inbox-remove-read
                aria-label="Remove all read notifications"
                aria-busy={bulkRuns && bulk?.action === 'remove'}
                disabled={bulkRuns || !hasReadMessages}
                onClick={() => runBulkAction('remove')}
              >
                <ListX size={16} strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Remove all read notifications</TooltipContent>
        </Tooltip>
      </fieldset>
    </TooltipProvider>
  )
  // A long action's progress. The live region stays in the page, empty and
  // without height while nothing runs, so a screen reader hears each step.
  const bulkProgress = (
    <p
      data-inbox-progress
      role="status"
      aria-live="polite"
      className="inbox-bulk-progress m-0 mb-2 min-w-0 text-right text-sm text-text-2 empty:mb-0"
    >
      {bulk?.long && bulk.state === 'running' ? bulkProgressText(bulk) : ''}
    </p>
  )

  /* What the pane shows is the task the ADDRESS names — `openIssue`, which
     is also what `/app/<org>/inbox/tasks/<task>` restores. So a row click, a deep
     link, Back, and following a subtask inside the pane are all one thing,
     and a reload lands where you were reading. A task the workspace does not
     hold opens by a reference with its organization (lib/taskReference.ts),
     and the window shows it from the server, or says it loads, can't be
     opened, or couldn't be opened. */
  const paneId = openIssue ?? null
  // one key while the pane is on the same task, so neither a reference
  // turning into its handle nor a change of the home organization, which
  // moves handles, remounts the pane's window
  const paneKey = useTaskKey(paneId)
  /* The pane is the discussion alone — no details column fits beside a 380px
     message list — so the header offers a way to the rest of it: the SAME
     window, floating, over the inbox. It holds no task of its own, which is
     the point: it is a second frame on the pane's task, so navigating inside
     it moves the pane too and closing it puts you back where you were. */
  const [poppedOut, setPoppedOut] = useState(false)
  // A move with no task here ends it too, such as leaving the Inbox, which
  // stays loaded (components/KeptView): the next task opens in the pane.
  if (poppedOut && !openIssue) setPoppedOut(false)
  // the text typed in the pane and its pop-out, and in the pop-out alone,
  // so closing either asks first (DiscardPrompt)
  const taskScope = useContext(UnsentScopeContext)
  const popScope = useUnsentScope()
  const showTask = (handle: string | null) => openTask(handle || null)
  const closeTask = () => {
    setPoppedOut(false)
    openTask(null)
  }
  // A kept Inbox shown again (components/KeptView) stays where it was: the
  // place goes back only when the pane closed since this last ran.
  const restoredFor = useRef<string | null>(null)
  useEffect(() => {
    const at = `${mobile}\n${!!paneId}`
    if (restoredFor.current === at) return
    restoredFor.current = at
    if (mobile && !paneId && listScrollRef.current) {
      listScrollRef.current.scrollTop = queueScrollTop.current
    }
  }, [mobile, !!paneId])

  // Escape leaves the inbox (Settings/Archive parity) — but only once the
  // pane is clear, innermost first. Anything that owns Escape — popovers, the
  // sort menu, a non-empty search field, a dirty composer, the mention
  // picker, the row menu — consumes it before it reaches window; an open task
  // window closes ITSELF on the same keypress, so this handler must not also
  // exit while one is up.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (paneId) return // the task window has it, and closes on it
      onExit?.()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onExit, paneId, openTask])

  // the lit row is the one whose organization and task the pane holds, by
  // uuid alone while the pane's reference names no organization yet
  const facts = taskFacts(paneId)
  const lit = (row: InboxRowVM) =>
    !!facts?.uuid && facts.uuid === row.uuid && (!facts.org || facts.org === row.org)
  // the pane's row's key, also while the page does not show it
  const paneRow = facts?.uuid
    ? facts.org
      ? inboxMarkKey(facts.org, facts.uuid)
      : (rows.find(lit)?.key ?? null)
    : null
  const select = (row: InboxRowVM) =>
    closeOrAsk([!sameTask(rowTask(row), openIssue) && taskScope], () => selectNow(row))
  // A press only opens the row's task. The pane's window freezes where the
  // unread part starts from the task's inbox item and then reads the whole
  // item, as any task window does, and that read's mark turns the row read
  // (P.inboxMarks). A snoozed row's item is not read, as it is a reminder
  // that returns unread (P.readOnOpen).
  const selectNow = (row: InboxRowVM) => {
    queueScrollTop.current = listScrollRef.current?.scrollTop || 0
    // the list as it shows now, which a read row leaves under Unread only
    paneRows.current = { id: row.key, ids: rows.map((x) => x.key) }
    showTask(rowTask(row))
  }
  const filterCount = (unreadOnly ? 1 : 0) + (showSnoozed ? 1 : 0) + kinds.length
  const toggleKind = (k: InboxKind) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))
  const perm = notificationPermission()

  /* Focus a row took with it. The pane's Archive or delete window takes
     the pane's task away with its row, and the row menu's Remove and Snooze
     take their row; the pane or the menu then closes with focus nowhere.
     Focus goes to the row's open button, else to the row that followed it
     in the list as it showed, else to the one before, else to the first
     row listed, else to the search field, or on a phone, which has none,
     to the empty list's line. The menu's Mark all as read and Remove all
     read start at the first row, and the toolbar's at their own button.
     Focus that went elsewhere stays there. */
  useLayoutEffect(() => {
    if (!paneRow) return
    const ids = rows.map((row) => row.key)
    if (ids.includes(paneRow)) paneRows.current = { id: paneRow, ids }
    else if (paneRows.current?.id !== paneRow) paneRows.current = { id: paneRow, ids: [paneRow] }
  })
  /** Whether the Inbox shows and focus is nowhere, so it can take focus. */
  const focusFree = () => {
    const list = listScrollRef.current
    const active = document.activeElement
    if (!list || list.closest(OUT_OF_USE)) return false
    return !active || active === document.body || !active.isConnected
  }
  // a focus move that found nothing to take focus yet, as a phone's list
  // whose last row left before its page answered with the empty line,
  // which the next renders try again while focus stays nowhere
  const focusLater = useRef<ListedRows | null>(null)
  /** Gives focus to `rows.id`'s row or what took its place, while focus is
      nowhere and the Inbox shows. */
  const focusRowAfter = (listed: ListedRows) => {
    focusLater.current = null
    const list = listScrollRef.current
    if (!list || !focusFree()) return
    const { id, ids } = listed
    const at = id === null ? -1 : ids.indexOf(id)
    const order =
      id === null ? [] : [id, ...ids.slice(at + 1), ...ids.slice(0, Math.max(at, 0)).reverse()]
    const shown = [...list.querySelectorAll<HTMLElement>('[data-message-key]')]
    const byKey = new Map(shown.map((row) => [row.dataset.messageKey, row]))
    const row = order.map((item) => byKey.get(item)).find(Boolean) ?? shown[0]
    const target =
      row?.querySelector<HTMLElement>('.inbox-message-open') ??
      list.closest('[data-inbox]')?.querySelector<HTMLElement>('[data-inbox-search]') ??
      list.querySelector<HTMLElement>('[data-inbox-empty]')
    if (target) restoreFocus(target)
    else focusLater.current = listed
  }
  useEffect(() => {
    const listed = focusLater.current
    if (listed) focusRowAfter(listed)
  })
  // Effects, not layout effects: a phone's task window, which is modal,
  // releases the list it made inert, and gives focus back where it can, in
  // its own effect's cleanup, which runs before these.
  const paneOpen = !!paneId
  const paneWas = useRef(paneOpen)
  useEffect(() => {
    const was = paneWas.current
    paneWas.current = paneOpen
    const rows = paneRows.current
    if (!was || paneOpen || !rows) return
    paneRows.current = null
    focusRowAfter(rows)
  }, [paneOpen])
  useEffect(() => {
    const rows = menuRows.current
    if (menu || !rows) return
    menuRows.current = null
    focusRowAfter(rows)
  }, [menu])
  /** Gives focus back after a bulk action pressed on `from`: to the
      toolbar button when it is enabled again, else to the first row. */
  const focusAfterBulk = (from: BulkAction | 'menu') => {
    const button =
      from === 'menu'
        ? null
        : listScrollRef.current
            ?.closest('[data-inbox]')
            ?.querySelector<HTMLElement>(
              from === 'read' ? '[data-inbox-mark-all-read]' : '[data-inbox-remove-read]',
            )
    if (button && !button.matches(':disabled') && focusFree()) restoreFocus(button)
    else focusRowAfter({ id: null, ids: [] })
  }
  // A toolbar button disables itself while its action runs, and a browser
  // takes focus from a disabled button. Once the action ends, focus goes
  // back to the button when it is enabled again, else to the first row.
  // From the row menu, focus goes to the first row still listed once the
  // action's paint shows. The notice's close gives focus back itself.
  const bulkState = bulk?.state
  const bulkWas = useRef(bulkState)
  useEffect(() => {
    const was = bulkWas.current
    bulkWas.current = bulkState
    const from = bulkFrom.current
    if (!from || was === 'notice') return
    if (bulkState === 'running' && from === 'menu') focusRowAfter({ id: null, ids: [] })
    if (bulkRuns) return
    bulkFrom.current = null
    focusAfterBulk(from)
  }, [bulkState])
  // The notice opens only in a shown Inbox (P.hostInboxNotice). A kept
  // Inbox that hides, or one let go, ends a notice that waits or would
  // open, and sends nothing. Before it opens, the row menu closes, and a
  // notice that would open over a field the person types in does not: the
  // action ends as Cancel ends it.
  useEffect(
    () =>
      P.hostInboxNotice({
        prepare: () => {
          if (typesText(document.activeElement)) return false
          setMenu(null)
          return true
        },
      }),
    [],
  )
  // what a kept Inbox held before it hid (components/KeptView) moves no
  // focus once it shows again
  useEffect(
    () => () => {
      paneRows.current = null
      menuRows.current = null
      bulkFrom.current = null
    },
    [],
  )

  // MENU_W: AnchoredPop centers on x, so a cursor menu shifts by half its width
  const MENU_W = 280
  const openMenu = (e: React.MouseEvent, row?: InboxRowVM) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX + MENU_W / 2, y: e.clientY, row: row ?? null })
    setSnoozeFor({ hours: 1, days: 1, weeks: 1 })
  }
  /** Runs `fn` on the row the menu opened on, as it showed then, and
      closes the menu, giving focus back to the row or to what took its
      place (focusRowAfter), unless `fn` `leaves` the Inbox. */
  const runOnItem = (fn: (row: InboxRowVM) => void, leaves = false) => {
    const row = menu?.row
    if (row) {
      if (!leaves) menuRows.current = { id: row.key, ids: rows.map((x) => x.key) }
      fn(row)
    }
    setMenu(null)
  }
  const menuRow = menu?.row ?? null
  // the row's project, which Open task in board opens the Board of
  const menuBoard = menuRow ? P.project(menuRow.project.id) : undefined

  return (
    <div
      data-inbox
      data-inbox-mobile-detail={mobile && paneId ? '' : undefined}
      className="inbox-layout animate-in fade-in slide-in-from-bottom-1"
    >
      {/* left: the message list */}
      {/* The frame fits a short queue; only the rows scroll when it reaches
          the viewport limit, keeping the filters and rounded edges intact. */}
      <section data-inbox-list className="inbox-message-list">
        <div className="inbox-list-controls [padding:20px_20px_0] [flex-shrink:0]">
          {mobile && (
            <fieldset className="inbox-mobile-filters m-0 border-0 p-0" aria-label="Inbox messages">
              <Seg
                fit
                value={
                  unreadOnly && !kinds.length
                    ? 'unread'
                    : !unreadOnly && kinds.length === 1 && kinds[0] === 'mention'
                      ? 'mentions'
                      : !unreadOnly && !kinds.length
                        ? 'all'
                        : undefined
                }
                onChange={(value) => {
                  setUnreadOnly(value === 'unread')
                  setKinds(value === 'mentions' ? ['mention'] : [])
                }}
                options={[
                  { value: 'unread', label: 'Unread' },
                  { value: 'mentions', label: 'Mentions' },
                  { value: 'all', label: 'All' },
                ]}
              />
            </fieldset>
          )}
          {!mobile && perm === 'default' && (
            <div className="inbox-notification-row flex items-center justify-end gap-2 mb-2 flex-wrap">
              <Button
                type="button"
                variant="ghost"
                data-inbox-enable-notify
                className="h-control-sm [font-size:var(--fs-sm)]"
                title="Desktop notifications for new messages"
                onClick={() => {
                  void requestNotificationPermission().then(() => setNoteN((n) => n + 1))
                }}
              >
                <Icon name="bell" size={16} />
                Enable notifications
              </Button>
            </div>
          )}
          <div className="inbox-options-row flex flex-wrap items-center gap-2 mb-2">
            {!mobile && (
              <Popover
                width={160}
                button={(toggle) => (
                  <Button
                    type="button"
                    variant="quiet"
                    aria-label="Message order"
                    onClick={toggle}
                    className="pr-2 has-[>svg]:pr-2"
                  >
                    {sort === 'new' ? 'Newest first' : 'Oldest first'}
                    <DropdownChevron />
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    {(['new', 'old'] as const).map((order) => (
                      <MenuItem
                        key={order}
                        active={sort === order}
                        aria-pressed={sort === order}
                        onClick={() => {
                          setSort(order)
                          close()
                        }}
                      >
                        {order === 'new' ? 'Newest first' : 'Oldest first'}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}
            <Popover
              width={mobile ? 240 : 190}
              button={(t) => (
                <Button
                  type="button"
                  data-inbox-filter
                  aria-label={mobile ? 'Inbox filters and order' : undefined}
                  variant="quiet"
                  data-on={filterCount ? '' : undefined}
                  onClick={t}
                  className={mobile ? 'h-control' : 'h-control pr-2 has-[>svg]:pr-2'}
                >
                  <Icon name="filter" size={16} />
                  {mobile ? null : 'Filter'}
                  {filterCount ? ` (${filterCount})` : ''}
                  {mobile ? null : <DropdownChevron />}
                </Button>
              )}
            >
              {(close) => (
                <>
                  {mobile && (
                    <>
                      <MenuItem active={sort === 'new'} onClick={() => setSort('new')}>
                        Newest first
                      </MenuItem>
                      <MenuItem active={sort === 'old'} onClick={() => setSort('old')}>
                        Oldest first
                      </MenuItem>
                      <MenuDivider />
                    </>
                  )}
                  <MenuItem active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
                    <Icon name="dot" size={13} />
                    Unread only
                  </MenuItem>
                  <MenuItem
                    data-inbox-show-snoozed
                    active={showSnoozed}
                    onClick={() => setShowSnoozed((v) => !v)}
                  >
                    <Icon name="clockFading" size={13} />
                    Show snoozed
                  </MenuItem>
                  <MenuDivider />
                  {(Object.keys(KIND_LABELS) as InboxKind[]).map((k) => (
                    <MenuItem key={k} active={kinds.includes(k)} onClick={() => toggleKind(k)}>
                      <Icon name={KIND_ICONS[k]} size={13} />
                      {KIND_LABELS[k]}
                    </MenuItem>
                  ))}
                  {mobile && perm === 'default' && (
                    <>
                      <MenuDivider />
                      <MenuItem
                        data-inbox-enable-notify
                        onClick={() => {
                          close()
                          void requestNotificationPermission().then(() => setNoteN((n) => n + 1))
                        }}
                      >
                        <Icon name="bell" size={16} />
                        Enable notifications
                      </MenuItem>
                    </>
                  )}
                </>
              )}
            </Popover>
            {!mobile && bulkActionButtons}
          </div>
          {mobile && bulkActionButtons}
          {bulkProgress}
          {!mobile && (
            <div
              data-filter-search
              className="inbox-search-row [display:flex] [align-items:center] [gap:8px] h-control [padding:0_8px] [margin-bottom:8px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-md)]"
            >
              <Icon name="search" size={16} color="var(--text-3)" />
              {/* the server searches the whole Inbox once typing rests, up
                  to LIMITS.search; past it the fold says the limit */}
              <LimitedInput
                limit={LIMITS.search}
                ref={searchRef}
                data-inbox-search
                aria-label="Search messages"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter messages…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && search) {
                    e.stopPropagation()
                    setSearch('')
                  }
                }}
                wrapperClassName="h-full flex-1"
                className="h-full min-w-0 rounded-none border-none bg-transparent p-0 font-sans text-base text-text-1 shadow-none focus-visible:outline-none focus-visible:ring-0"
              />
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label="Clear the search"
                  onClick={() => setSearch('')}
                >
                  <Icon name="close" size={12} />
                </Button>
              )}
            </div>
          )}
        </div>
        <div
          ref={listScrollRef}
          className="inbox-list-scroll"
          data-inbox-page-state={state}
          aria-busy={
            state === 'loading' || state === 'refreshing' || page.moving !== null || undefined
          }
          onContextMenu={(e) => openMenu(e)}
        >
          {notes.map((note) => (
            <p
              key={note.key}
              data-inbox-note={note.key}
              className="m-0 [padding:10px] [font-size:var(--fs-sm)] [color:var(--text-2)]"
            >
              {note.text}
            </p>
          ))}
          {rows.map((row) => (
            <MessageRow
              key={row.key}
              row={row}
              selected={lit(row)}
              menuOpen={menu?.row?.key === row.key}
              onSelect={select}
              onMenu={openMenu}
            />
          ))}
          {/* the line that ends the page, with Previous and Next, which says
              how far a stopped page looked and calls the Inbox empty only
              on a complete first page; its empty sentences take focus when
              a phone's list lost its last row */}
          <div
            data-inbox-empty={emptyEnd ? '' : undefined}
            tabIndex={emptyEnd ? -1 : undefined}
            className="inbox-page-fold [padding:4px_10px_10px] outline-none"
          >
            <PageFold
              page={page}
              end={foldEnd}
              hook="inbox-page"
              words={words}
              held={(answer) => heldLine(answer, orgName)}
              tooLong={tooLong}
              focus={move}
            />
          </div>
        </div>
      </section>

      {/* right: the task window itself, filling the pane, for every task the
          pane opens: it says itself when the task loads, can't be opened or
          couldn't be opened. Keyed on the task so switching rows remounts
          it, the same reset an in-place issue swap does inside the floating
          window, and the only thing that re-freezes the New mark for the
          item just clicked. The key is the task's (useTaskKey), not the
          string that names it, so a reference that turns into its handle,
          or a handle a change of the home organization moves, keeps it. */}
      <div className={`inbox-detail-frame${paneId ? '' : ' inbox-detail-frame--note'}`}>
        {paneId ? (
          <IssueDetail
            embedded
            modalActive={!poppedOut}
            key={paneKey}
            issueId={paneId}
            onClose={closeTask}
            closeLabel="Back to inbox"
            onOpen={showTask}
            onPlanOnRoadmap={onPlanOnRoadmap}
            onPopOut={() => setPoppedOut(true)}
            onShowOnBoard={showOnBoard}
          />
        ) : (
          <PaneNote>
            <Icon name="mail" size={26} color="var(--text-3)" className="[margin:0_auto_8px]" />
            <div>No message selected.</div>
          </PaneNote>
        )}
      </div>

      {/* right-click menu — item actions followed by Inbox-wide actions.
          AnchoredPop owns Escape in the capture phase, so dismissing the menu
          can't also exit the inbox. */}
      {menu && (
        <AnchoredPop x={menu.x} y={menu.y} width={MENU_W} onClose={() => setMenu(null)}>
          <div data-msg-menu className="[padding:5px]">
            {menuRow && (
              <>
                {/* opening the task is what a plain click does now, so the menu
                offers the one place the pane can't reach: the board it sits
                on, for any task whose project the store holds, which the
                Board needs, held by the workspace or not */}
                {menuBoard && (
                  <MenuItem
                    data-msg-menu-board
                    onClick={() =>
                      runOnItem((row) => showOnBoard(row.project.id, rowTask(row)), true)
                    }
                  >
                    <Icon name="board" size={13} />
                    Open task in board
                  </MenuItem>
                )}
                <MenuItem
                  data-msg-menu-read={menuRow.read ? 'unread' : 'read'}
                  onClick={() =>
                    runOnItem((row) =>
                      row.read
                        ? P.unreadItem({ org: row.org, task: row.uuid, through: row.through })
                        : P.readItem({
                            org: row.org,
                            task: row.uuid,
                            through: row.through,
                            latestAt: row.latestAt,
                          }),
                    )
                  }
                >
                  <Icon name={menuRow.read ? 'dot' : 'check'} size={13} />
                  {menuRow.read ? 'Mark as unread' : 'Mark as read'}
                </MenuItem>
                <MenuItem
                  data-msg-menu-remove
                  onClick={() =>
                    runOnItem((row) => {
                      P.removeItem({
                        org: row.org,
                        task: row.uuid,
                        through: row.through,
                        latestAt: row.latestAt,
                      })
                      if (lit(row)) closeTask() // its pane just went away
                    })
                  }
                >
                  <Icon name="trash" size={13} />
                  Remove notification
                </MenuItem>
                <MenuDivider />
              </>
            )}
            <MenuItem
              data-msg-menu-mark-all-read
              disabled={bulkRuns || !hasUnreadMessages}
              onClick={() => runBulkAction('read')}
            >
              <CheckCheck size={16} strokeWidth={1.75} aria-hidden="true" />
              Mark all as read
            </MenuItem>
            <MenuItem
              data-msg-menu-remove-read
              disabled={bulkRuns || !hasReadMessages}
              onClick={() => runBulkAction('remove')}
            >
              <ListX size={16} strokeWidth={1.75} aria-hidden="true" />
              Remove all read notifications
            </MenuItem>
            {/* last: put the item to sleep, or wake it early. Its own section
                because it is neither a read state nor a removal. */}
            {menuRow && (
              <>
                <MenuDivider />
                <div
                  data-msg-menu-snooze
                  className="[font-size:var(--fs-xs)] [color:var(--text-2)] [padding:6px_8px_2px]"
                >
                  Snooze
                </div>
                {menuRow.snoozedUntil !== null ? (
                  <MenuItem
                    data-msg-menu-unsnooze
                    onClick={() =>
                      runOnItem((row) =>
                        P.snoozeItem({ org: row.org, task: row.uuid, through: row.through }, null),
                      )
                    }
                  >
                    <Icon name="rotateCcw" size={13} />
                    Unsnooze
                    <div className="[flex:1]" />
                    <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono">
                      until {fmtSnoozeUntil(menuRow.snoozedUntil)}
                    </span>
                  </MenuItem>
                ) : (
                  (['hours', 'days', 'weeks'] as const).map((unit) => (
                    <SnoozeRow
                      key={unit}
                      unit={unit}
                      count={snoozeFor[unit]}
                      onCount={(n) => setSnoozeFor((cur) => ({ ...cur, [unit]: n }))}
                      onSnooze={(until) =>
                        runOnItem((row) => {
                          if (lit(row)) closeTask() // it just left the list
                          P.snoozeItem(
                            { org: row.org, task: row.uuid, through: row.through },
                            until,
                          )
                        })
                      }
                    />
                  ))
                )}
              </>
            )}
          </div>
        </AnchoredPop>
      )}

      {/* The keep-open notice of a bulk action that takes more than one
          round (P.answerInboxNotice). Cancel sends nothing. It renders
          only while it asks, so it closes at once, without a fade: a
          fading notice would still hold focus as the action goes on, and
          lose the words of what it asked. */}
      <AlertDialog
        open={bulk?.state === 'notice'}
        onOpenChange={(open) => {
          if (!open) P.answerInboxNotice(false)
        }}
      >
        {bulk?.state === 'notice' && (
          <AlertDialogContent
            data-inbox-notice
            onCloseAutoFocus={(event) => {
              // back to what opened it after Cancel, or once the action
              // ended; while it runs, the toolbar's button stays disabled
              event.preventDefault()
              const from = bulkFrom.current
              if (!from) return
              if (!bulkBusy(P.inboxBulk)) {
                bulkFrom.current = null
                focusAfterBulk(from)
              } else if (from === 'menu') focusRowAfter({ id: null, ids: [] })
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Keep Qivo open</AlertDialogTitle>
              <AlertDialogDescription>{bulkNoticeText(bulk)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-inbox-notice-cancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-inbox-notice-confirm
                onClick={() => P.answerInboxNotice(true)}
              >
                {bulkName(bulk.action)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      {/* The popped-out window: the same component, floating, on the same task
          the pane holds — so `holdThread` keeps it off the store's one comment
          cache, which the pane behind it still owns and would otherwise have
          released out from under itself when this closed. `onOpen` is the
          PANE's, so following a subtask in here moves both and there is never
          a second task to come back to, also to a related task the workspace
          does not hold, which both show from its reference. */}
      {paneId && poppedOut && (
        <UnsentScopeContext.Provider value={popScope}>
          <IssueDetail
            issueId={paneId}
            holdThread
            // the pane behind it showed this visit's New mark already
            unread={{ ts: null, change: false }}
            onPopOut={undefined} // this IS the pop-out
            onShowOnBoard={showOnBoard}
            onClose={() => closeOrAsk([popScope], () => setPoppedOut(false))}
            onOpen={showTask}
            onPlanOnRoadmap={onPlanOnRoadmap}
          />
        </UnsentScopeContext.Provider>
      )}
    </div>
  )
}
