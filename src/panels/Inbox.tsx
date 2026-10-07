/* Inbox groups messages by task, displaying the newest message and unread
   count beside an embedded IssueDetail. Capture the unread boundary before
   marking the selection read so the task can retain its "New" divider.
   Reading prunes the group to its latest message; retention or removal clears
   it. Row menus act on the whole group, with separate inbox-wide commands.
   Snoozed groups stay hidden until server wake unless "Show snoozed" is set.
   Server rules expose only the viewer's messages and allow read/snooze/delete
   actions; notification content remains server-owned. */
import { CheckCheck, ListX, Minus, Plus } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  HoverTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AnchoredPop, Icon, MenuDivider, MenuItem, Popover, Seg } from '../components/qivo'
import { fmtDateTime } from '../lib/dates'
import { notificationPermission, requestNotificationPermission } from '../lib/notify'
import { matchesAllWords } from '../lib/search'
import { fmtSnoozeUntil, SNOOZE_STEP_MAX, SNOOZE_UNIT_MS, type SnoozeUnit } from '../lib/snooze'
import { firstUnreadTs } from '../lib/spine'
import { useMobile } from '../lib/useMobile'
import { type MessageGroupVM, type MessageVM, P } from '../store/planner'
import { IssueDetail } from './IssueDetail'

/* Spec'd age form: hours up to 24 h, then days (minutes only under an hour —
   "0h" would read as broken). */
export function fmtMsgAge(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (m < 60) return m < 1 ? 'now' : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/* One row of the menu's Snooze section: a unit, its stepper and its own
   Snooze button. The button pressed decides the unit; the other row's number
   is ignored. Stepping never closes the menu and stops at 1; the button's
   hover help names the exact return time. */
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
  const until = new Date(Date.now() + count * SNOOZE_UNIT_MS[unit])
  const stepClass =
    'inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-text-1 hover:border-border-strong hover:bg-hover disabled:cursor-default disabled:opacity-55 disabled:hover:border-border disabled:hover:bg-surface-1'
  return (
    <div
      data-msg-snooze-row={unit}
      className="flex min-h-8 items-center gap-2 px-2 py-1 text-base text-text-1"
    >
      <Icon name="clockFading" size={13} />
      {unit === 'hours' ? 'Hours' : 'Days'}
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
        disabled={count >= SNOOZE_STEP_MAX}
        onClick={() => onCount(Math.min(SNOOZE_STEP_MAX, count + 1))}
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

/* 0075 persisted one privacy-fenced fallback with the former UI noun.
   Normalize those old rows at render time; new messages already use task. */
function detailText(m: MessageVM): string {
  return String(m.detail || '').replace('an issue in another project', 'a task in another project')
}

/* A null actor is a since-deleted user (the FK
   set-null cascade can't tell them apart) — the same neutral "Someone" the
   activity feed and comments use, never a false "API" claim. */
function secondLine(m: MessageVM): string {
  if (m.kind === 'mention') {
    const u = m.actor ? P.user(m.actor) : null
    return `from @${u ? u.name : 'Someone'}`
  }
  if (m.kind === 'comment') return 'New comment'
  return detailText(m)
}

/* Where the row's task lives: its project, then its sub-project. Null while
   the task is not loaded here — an older message can briefly outlive a
   working snapshot update, and it still carries the title it was written
   with even though it cannot say where the task is. */
function itemPlace(g: MessageGroupVM) {
  const it = g.issueKey ? P.issueById[g.issueKey] : null
  if (!it) return null
  const meta = P.metaOf(it.project)
  const sub = P.project(it.project)
  const parts = [meta, meta && sub && meta.id !== sub.id ? sub : null].filter(Boolean)
  return parts.length ? { meta, parts } : null
}

function MessageRow({
  g,
  selected,
  menuOpen,
  onSelect,
  onMenu,
}: {
  g: MessageGroupVM
  selected: boolean
  menuOpen: boolean
  onSelect: (g: MessageGroupVM) => void
  onMenu: (e: React.MouseEvent, g: MessageGroupVM) => void
}) {
  const place = itemPlace(g)
  // the imperative hover below has to fall back to THIS, not to transparent —
  // the pointer leaves the row the moment its context menu opens
  const bg = selected ? 'var(--accent-soft)' : menuOpen ? 'var(--hover)' : 'transparent'
  return (
    <div
      data-message={g.id}
      data-kind={g.kind}
      data-kinds={g.kinds.join(' ')}
      data-unread={g.read ? undefined : ''}
      data-snoozed={g.snoozed ? '' : undefined}
      data-count={g.unreadCount}
      data-held={g.count}
      onContextMenu={(e) => onMenu(e, g)}
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
        onClick={() => onSelect(g)}
      >
        <div className="[flex:1] [min-width:0]">
          <div className="[display:flex] [align-items:baseline] [gap:8px]">
            <span
              data-msg-title
              className={`flex-1 min-w-0 truncate text-base ${g.snoozed ? 'text-text-2' : 'text-text-1'} ${g.read ? 'font-normal' : 'font-semibold'}`}
            >
              {g.issueTitle}
            </span>
            {/* how much has happened to this task since you last read it. The
              line below shows the newest of them; the rest are listed when you
              open it. One alone needs no number — the dot already says it. */}
            {g.unreadCount > 1 && (
              <HoverTooltip content={`${g.unreadCount} new updates`}>
                <span
                  tabIndex={-1}
                  data-msg-count
                  className="[font-size:var(--fs-xs)] [font-weight:700] !font-mono [flex-shrink:0] [color:var(--text-1)] [background:var(--accent-soft)] [border-radius:var(--r-pill)] [padding:1px_6px]"
                >
                  {g.unreadCount}
                </span>
              </HoverTooltip>
            )}
            {/* a sleeping row says when it returns instead of how old it is */}
            {g.snoozedUntil !== null ? (
              <HoverTooltip content={`Returns ${fmtDateTime(new Date(g.snoozedUntil))}`}>
                <span
                  tabIndex={-1}
                  data-msg-until
                  className="[font-size:var(--fs-xs)] [color:var(--text-3)] !font-mono [flex-shrink:0] inline-flex items-center gap-1"
                >
                  <Icon name="clockFading" size={12} color="var(--text-3)" />
                  {fmtSnoozeUntil(g.snoozedUntil)}
                </span>
              </HoverTooltip>
            ) : (
              <HoverTooltip content={new Date(g.ts).toLocaleString()}>
                <span
                  tabIndex={-1}
                  data-msg-age
                  className="[font-size:var(--fs-xs)] [color:var(--text-3)] !font-mono [flex-shrink:0]"
                >
                  {fmtMsgAge(g.ts)}
                </span>
              </HoverTooltip>
            )}
          </div>
          {/* …and under the title, WHERE it is — project → sub-project, the
            same breadcrumb notation the task window's own crumb uses. This
            line used to carry the newest message ("Priority: High → Urgent"),
            which the counter beside the title already promises and the
            window's Activity section already enumerates in full; the one
            thing the row could not say was which board the task sits on.
            An item whose task is not loaded here has no location to give, so
            it falls back to saying what happened. */}
          <div
            data-msg-line2
            className="[margin-top:3px] [font-size:var(--fs-sm)] [color:var(--text-2)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
          >
            {place
              ? place.parts.map((p, i) => (
                  <React.Fragment key={p.id}>
                    {i > 0 && (
                      <Icon
                        name="chevronRight"
                        size={11}
                        color="var(--text-3)"
                        className="[display:inline-block] [vertical-align:-1px] [margin:0_1px]"
                      />
                    )}
                    <span data-msg-crumb>{p.name}</span>
                  </React.Fragment>
                ))
              : secondLine(g)}
          </div>
          <div className="inbox-message-preview">{secondLine(g)}</div>
        </div>
        {!g.read && (
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
        aria-label={`Message actions: ${g.issueTitle}`}
        onClick={(e) => onMenu(e, g)}
      >
        <Icon name="more" size={16} />
      </Button>
    </div>
  )
}

/* The two things the task window cannot be asked to show: nothing selected,
   and an item whose task is not loaded here (its messages carry the title
   they were written with, so the row can still say what it was). */
function PaneNote({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div data-inbox-detail className="inbox-note">
      <div className="[text-align:center] [color:var(--text-3)] [font-size:var(--fs-base)]">
        {title && (
          <div className="[font-weight:600] [color:var(--text-1)] [margin-bottom:4px]">{title}</div>
        )}
        {children}
      </div>
    </div>
  )
}

export function Inbox({ showOnBoard, onExit, openTask, openIssue, onPlanOnRoadmap }) {
  const mobile = useMobile()
  const listScrollRef = useRef<HTMLDivElement>(null)
  const queueScrollTop = useRef(0)
  const [sort, setSort] = useState('new') // "new" | "old"
  // where this visit's unread part starts, frozen at select time — WITH the
  // task it was asked about, so in-pane navigation can't inherit it
  const [frozen, setFrozen] = useState(null as { uuid: string; ts: number | null } | null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [showSnoozed, setShowSnoozed] = useState(false) // sleeping items are hidden by default
  const [kinds, setKinds] = useState([] as string[]) // empty = all
  // the row menu's Hours / Days steppers — back to 1 on every open
  const [snoozeFor, setSnoozeFor] = useState({ hours: 1, days: 1 })
  const [search, setSearch] = useState('')
  const [, setNoteN] = useState(0) // re-render after a permission grant
  const [menu, setMenu] = useState(null as { x: number; y: number; id: string | null } | null) // right-click menu
  const [bulkAction, setBulkAction] = useState<'read' | 'remove' | null>(null)
  const hasReadMessages = P.readMessageCount > 0
  const hasUnreadMessages = P.unreadMessages > 0
  const runBulkAction = async (action: 'read' | 'remove') => {
    if (bulkAction || (action === 'read' ? !hasUnreadMessages : !hasReadMessages)) return
    setMenu(null)
    setBulkAction(action)
    try {
      if (action === 'read') await P.markAllMessagesRead()
      else await P.deleteReadMessages()
    } finally {
      setBulkAction(null)
    }
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
                aria-busy={bulkAction === 'read'}
                disabled={!!bulkAction || !hasUnreadMessages}
                onClick={() => void runBulkAction('read')}
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
                aria-busy={bulkAction === 'remove'}
                disabled={!!bulkAction || !hasReadMessages}
                onClick={() => void runBulkAction('remove')}
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

  /* What the pane shows is the task the ADDRESS names — `openIssue`, which
     is also what `/app/<org>/inbox/tasks/<task>` restores. So a row click, a deep
     link, Back, and following a subtask inside the pane are all one thing,
     and a reload lands where you were reading. The single exception can't be
     addressed at all: an item whose task is not loaded here has no handle to
     put in a URL, so the row that was clicked is remembered
     instead and the pane says so. */
  const paneIssue = openIssue ? P.issueById[openIssue] : null
  const [deadItem, setDeadItem] = useState(null as string | null) // item id (= issue uuid)
  /* The pane is the discussion alone — no details column fits beside a 380px
     message list — so the header offers a way to the rest of it: the SAME
     window, floating, over the inbox. It holds no task of its own, which is
     the point: it is a second frame on the pane's task, so navigating inside
     it moves the pane too and closing it puts you back where you were. */
  const [poppedOut, setPoppedOut] = useState(false)
  const showTask = (handle: string | null) => {
    setDeadItem(null)
    openTask(handle || null)
  }
  const closeTask = () => {
    setDeadItem(null)
    setPoppedOut(false)
    openTask(null)
  }
  useEffect(() => {
    if (mobile && !paneIssue && !deadItem && listScrollRef.current) {
      listScrollRef.current.scrollTop = queueScrollTop.current
    }
  }, [mobile, !!paneIssue, deadItem])

  // Escape leaves the inbox (Settings/Archive parity) — but only once the
  // pane is clear, innermost first. Anything that owns Escape — popovers, the
  // sort menu, a non-empty search field, a dirty composer, the mention
  // picker, the row menu — consumes it before it reaches window; an open task
  // window closes ITSELF on the same keypress, so this handler must not also
  // exit while one is up.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (paneIssue) return // the task window has it, and closes on it
      if (deadItem) {
        setDeadItem(null)
        return
      }
      onExit?.()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onExit, paneIssue, deadItem])

  const q = mobile ? '' : search.trim()
  const visible = P.messageGroups
    .filter((g) => showSnoozed || !g.snoozed)
    .filter((g) => !unreadOnly || !g.read)
    // an item matches a kind filter when ANY of its folded messages does, so
    // a mention that arrived behind a change is still findable
    .filter((g) => !kinds.length || g.kinds.some((k) => kinds.includes(k)))
    .filter((g) => {
      if (!q) return true
      const place = itemPlace(g)
      // the folded messages and their actors stay in the haystack even though
      // the row no longer prints them — searching for what somebody changed is
      // still how you find the item it changed. The project names are new
      // here because they are now ON the row: what you can read, you can find.
      const hay = [g.issueTitle, g.issueLabel, secondLine(g)]
        .concat(place ? place.parts.map((p) => p.name) : [])
        .concat(
          g.items.map((m) => {
            const actor = m.actor ? P.user(m.actor) : null
            return `${actor ? actor.name : 'API'}\n${detailText(m)}`
          }),
        )
        .filter(Boolean)
        .join('\n')
      return matchesAllWords(hay, q)
    })
  if (sort === 'old') visible.reverse() // P.messageGroups is newest-first

  // which row is lit: the one whose task the pane holds
  const selected = deadItem || (paneIssue ? paneIssue.uuid : null)
  // Freeze what this visit found BEFORE marking it read — the order of these
  // lines is the feature. markMessagesRead is synchronous and reading closes
  // the New mark (and prunes the item back to its last message, 0109), so a
  // mark computed after it would show nothing at all. The task window is
  // mounted by the render this click schedules — far too late to ask — so the
  // answer is handed to it.
  const select = (g: MessageGroupVM) => {
    queueScrollTop.current = listScrollRef.current?.scrollTop || 0
    setFrozen({ uuid: g.issueUuid, ts: firstUnreadTs(P.messages, g.issueUuid) })
    // a sleeping row is a reminder that returns unread; looking does not read it
    if (!g.snoozed) P.markMessagesRead(g.ids)
    if (g.issueKey) showTask(g.issueKey)
    else {
      openTask(null)
      setDeadItem(g.id)
    }
  }
  // …and only for the task it was frozen about
  const unreadTs = frozen && paneIssue && frozen.uuid === paneIssue.uuid ? frozen.ts : undefined
  const menuGroup = menu ? P.messageGroups.find((g) => g.id === menu.id) : null
  const filterCount = (unreadOnly ? 1 : 0) + (showSnoozed ? 1 : 0) + kinds.length
  const toggleKind = (k: string) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))
  const perm = notificationPermission()

  // MENU_W: AnchoredPop centers on x, so a cursor menu shifts by half its width
  const MENU_W = 280
  const openMenu = (e: React.MouseEvent, g?: MessageGroupVM) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX + MENU_W / 2, y: e.clientY, id: g?.id ?? null })
    setSnoozeFor({ hours: 1, days: 1 })
  }
  const runOnItem = (fn: (g: MessageGroupVM) => void) => {
    if (menuGroup) fn(menuGroup)
    setMenu(null)
  }

  return (
    <div
      data-inbox
      data-inbox-mobile-detail={mobile && (paneIssue || deadItem) ? '' : undefined}
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
                  <Button type="button" variant="quiet" aria-label="Message order" onClick={toggle}>
                    {sort === 'new' ? 'Newest first' : 'Oldest first'}
                    <Icon name="chevronDown" size={12} color="var(--text-3)" />
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
                        <span className="flex-1" />
                        {sort === order && <Icon name="check" size={16} />}
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
                  className="h-control"
                >
                  <Icon name="filter" size={16} />
                  {mobile ? null : 'Filter'}
                  {filterCount ? ` (${filterCount})` : ''}
                </Button>
              )}
            >
              {(close) => (
                <>
                  {mobile && (
                    <>
                      <MenuItem active={sort === 'new'} onClick={() => setSort('new')}>
                        Newest first
                        {sort === 'new' && <Icon name="check" size={16} />}
                      </MenuItem>
                      <MenuItem active={sort === 'old'} onClick={() => setSort('old')}>
                        Oldest first
                        {sort === 'old' && <Icon name="check" size={16} />}
                      </MenuItem>
                      <MenuDivider />
                    </>
                  )}
                  <MenuItem active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
                    <Icon name="dot" size={13} />
                    Unread only
                    <div className="[flex:1]" />
                    {unreadOnly && <Icon name="check" size={13} />}
                  </MenuItem>
                  <MenuItem
                    data-inbox-show-snoozed
                    active={showSnoozed}
                    onClick={() => setShowSnoozed((v) => !v)}
                  >
                    <Icon name="clockFading" size={13} />
                    Show snoozed
                    <div className="[flex:1]" />
                    {showSnoozed && <Icon name="check" size={13} />}
                  </MenuItem>
                  <MenuDivider />
                  {Object.keys(KIND_LABELS).map((k) => (
                    <MenuItem key={k} active={kinds.includes(k)} onClick={() => toggleKind(k)}>
                      <Icon name={KIND_ICONS[k]} size={13} />
                      {KIND_LABELS[k]}
                      <div className="[flex:1]" />
                      {kinds.includes(k) && <Icon name="check" size={13} />}
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
          {!mobile && (
            <div
              data-filter-search
              className="inbox-search-row [display:flex] [align-items:center] [gap:8px] h-control [padding:0_8px] [margin-bottom:8px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-md)]"
            >
              <Icon name="search" size={16} color="var(--text-3)" />
              <Input
                data-inbox-search
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter messages…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && search) {
                    e.stopPropagation()
                    setSearch('')
                  }
                }}
                className="h-full min-w-0 flex-1 rounded-none border-none bg-transparent p-0 font-sans text-base text-text-1 shadow-none focus-visible:outline-none focus-visible:ring-0"
              />
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  onClick={() => setSearch('')}
                >
                  <Icon name="close" size={12} />
                </Button>
              )}
            </div>
          )}
        </div>
        <div ref={listScrollRef} className="inbox-list-scroll" onContextMenu={(e) => openMenu(e)}>
          {visible.map((g) => (
            <MessageRow
              key={g.id}
              g={g}
              selected={g.id === selected}
              menuOpen={!!menu && menu.id === g.id}
              onSelect={select}
              onMenu={openMenu}
            />
          ))}
          {visible.length === 0 && (
            <div
              data-inbox-empty
              className="[font-size:var(--fs-base)] [color:var(--text-3)] [font-style:italic] [padding:14px_10px]"
            >
              {P.messageGroups.length === 0 ? 'No messages yet.' : 'No messages match the filters.'}
            </div>
          )}
        </div>
      </section>

      {/* right: the task window itself, filling the pane. Keyed on the task so
          switching rows remounts it — the same reset an in-place issue swap
          does inside the floating window, and the only thing that re-freezes
          the New mark for the item just clicked. */}
      <div className={`inbox-detail-frame${paneIssue ? '' : ' inbox-detail-frame--note'}`}>
        {paneIssue ? (
          <IssueDetail
            embedded
            modalActive={!poppedOut}
            key={paneIssue.id}
            issueId={paneIssue.id}
            unreadTs={unreadTs}
            onClose={closeTask}
            closeLabel="Back to inbox"
            onOpen={showTask}
            onPlanOnRoadmap={onPlanOnRoadmap}
            onPopOut={() => setPoppedOut(true)}
            onShowOnBoard={showOnBoard}
          />
        ) : deadItem ? (
          <>
            {mobile && (
              <Button
                type="button"
                variant="ghost"
                className="inbox-mobile-back"
                onClick={closeTask}
              >
                <Icon name="chevronLeft" size={20} />
                Back to inbox
              </Button>
            )}
            <PaneNote
              title={`“${P.messageGroups.find((g) => g.id === deadItem)?.issueTitle || 'This task'}”`}
            >
              This task is archived or unavailable.
            </PaneNote>
          </>
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
            {menuGroup && (
              <>
                {/* opening the task is what a plain click does now, so the menu
                offers the one place the pane can't reach: the board it sits
                on, which is where the old breadcrumb used to lead */}
                {menuGroup.issueKey && (
                  <MenuItem
                    data-msg-menu-board
                    onClick={() =>
                      runOnItem((g) => {
                        const it = P.issueById[g.issueKey]
                        if (it) showOnBoard(it.project, it.id)
                      })
                    }
                  >
                    <Icon name="board" size={13} />
                    Open task in board
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() =>
                    runOnItem((g) =>
                      g.read ? P.markMessagesUnread(g.ids) : P.markMessagesRead(g.ids),
                    )
                  }
                >
                  <Icon name={menuGroup.read ? 'dot' : 'check'} size={13} />
                  {menuGroup.read ? 'Mark as unread' : 'Mark as read'}
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    runOnItem((g) => {
                      P.deleteMessages(g.ids)
                      if (selected === g.id) closeTask() // its pane just went away
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
              disabled={!!bulkAction || !hasUnreadMessages}
              onClick={() => void runBulkAction('read')}
            >
              <CheckCheck size={16} strokeWidth={1.75} aria-hidden="true" />
              Mark all as read
            </MenuItem>
            <MenuItem
              data-msg-menu-remove-read
              disabled={!!bulkAction || !hasReadMessages}
              onClick={() => void runBulkAction('remove')}
            >
              <ListX size={16} strokeWidth={1.75} aria-hidden="true" />
              Remove all read notifications
            </MenuItem>
            {/* last: put the item to sleep, or wake it early. Its own section
                because it is neither a read state nor a removal. */}
            {menuGroup && (
              <>
                <MenuDivider />
                <div
                  data-msg-menu-snooze
                  className="[font-size:var(--fs-xs)] [color:var(--text-2)] [padding:6px_8px_2px]"
                >
                  Snooze
                </div>
                {menuGroup.snoozedUntil !== null ? (
                  <MenuItem
                    data-msg-menu-unsnooze
                    onClick={() => runOnItem((g) => P.snoozeMessages(g.ids, null))}
                  >
                    <Icon name="rotateCcw" size={13} />
                    Unsnooze
                    <div className="[flex:1]" />
                    <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono">
                      until {fmtSnoozeUntil(menuGroup.snoozedUntil)}
                    </span>
                  </MenuItem>
                ) : (
                  (['hours', 'days'] as const).map((unit) => (
                    <SnoozeRow
                      key={unit}
                      unit={unit}
                      count={snoozeFor[unit]}
                      onCount={(n) => setSnoozeFor((cur) => ({ ...cur, [unit]: n }))}
                      onSnooze={(until) =>
                        runOnItem((g) => {
                          if (selected === g.id) closeTask() // it just left the list
                          P.snoozeMessages(g.ids, until)
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

      {/* The popped-out window: the same component, floating, on the same task
          the pane holds — so `holdThread` keeps it off the store's one comment
          cache, which the pane behind it still owns and would otherwise have
          released out from under itself when this closed. `onOpen` is the
          PANE's, so following a subtask in here moves both and there is never
          a second task to come back to. */}
      {paneIssue && poppedOut && (
        <IssueDetail
          issueId={paneIssue.id}
          holdThread
          unreadTs={undefined} // the pane already consumed this visit's New mark
          onPopOut={undefined} // this IS the pop-out
          onShowOnBoard={showOnBoard}
          onClose={() => setPoppedOut(false)}
          onOpen={showTask}
          onPlanOnRoadmap={onPlanOnRoadmap}
        />
      )}
    </div>
  )
}
