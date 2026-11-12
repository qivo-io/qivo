import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { HoverTooltip } from '@/components/ui/tooltip'
import { api } from '../../convex/_generated/api'
import { LIMITS } from '../../convex/lib/limits'
import { useKeptLiveView } from '../lib/liveView'
import { listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { PICKER_CAPS } from '../lib/pickerCaps'
import { useViewVisibility } from '../lib/viewVisibility'
import {
  type FollowerChoice,
  type FollowerChoices,
  type IssueVM,
  P,
  type IssueSubscribers as SubscriberRoster,
} from '../store/planner'
import { ChoiceEnd } from './pickerParts'
import { type ChoiceWords, heldLine } from './pickerWords'
import { Avatar, Icon, MenuItem } from './qivo'
import { RowAvatar } from './RowAvatar'
import { usePeople } from './usePeople'

/** The words of the follower popover's Add list. */
const FOLLOWER_WORDS: ChoiceWords = {
  held: (held) => heldLine(held, true),
  failed: "Couldn't load people.",
  stopped: 'Showing the people found so far.',
  empty: 'No other users to add.',
  none: 'No users found.',
}

/** The eye remains personal; opening its roster never changes a subscription.
    The roster, Me and a lead's add and remove take the task's organization
    and uuid from `issue`, the workspace's model or the window's from its
    own read, so they work for a task the workspace does not hold. With
    `disabled`, its hint, the eye only shows whether the person follows the
    task, as while the window's read of such a task failed or runs again.
    With `rosterWaits`, its hint, the eye follows and unfollows the task at
    once and its roster does not open, as for the person's own new task
    before the server stored it, which has no roster to read yet.

    The roster names its followers from its own answer's rows
    (issues.subscribers), read live while the popover is open and paused
    while the tab or window is hidden (lib/liveView.ts useKeptLiveView). On
    return it shows the roster it held, marked busy, until the new answer
    arrives, with add and remove enabled, since issues.setSubscriber
    checks the person and the task. Each opening starts from nothing. It
    lists them in name order, and paints each portrait from the
    row's initials and color with the picture the store holds; it names
    the followers while open, so their pictures load. A lead's **+ Add**
    reads the people who may follow the task a batch at a time from the
    server (pickers.taskFollowers), with a search over names, and
    names none of them, so opening it loads no one's face. */
export function IssueSubscribers({
  issue,
  disabled,
  rosterWaits,
}: {
  issue: IssueVM
  disabled?: string
  rosterWaits?: string
}) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const me = P.myProfileIds.find((id) => P.user(id)?.org === issue.org)

  // the roster follows the task, not the model object a repaint replaces,
  // and a close drops it, so an opening starts from nothing
  const read = useKeptLiveView<SubscriberRoster>(
    api.issues.subscribers,
    open ? JSON.stringify({ org_id: issue.org, issue_id: issue.uuid }) : null,
  )
  // what the popover showed as it closed, which it shows until it has faded
  const [closed, setClosed] = useState<{ roster: SubscriberRoster | null; failed: boolean }>({
    roster: null,
    failed: false,
  })
  const refreshing = open && read.state === 'refreshing'
  const failed = open ? read.state === 'failed' : closed.failed
  const roster = open
    ? read.state === 'ok' || read.state === 'refreshing'
      ? read.value
      : null
    : closed.roster

  useEffect(() => {
    if (adding) searchRef.current?.focus()
  }, [adding])

  // An opening starts over. A close leaves the search as it was, which the
  // popover shows until it has faded.
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setClosed({ roster, failed })
      return
    }
    setAdding(false)
    setSearch('')
  }
  // A task takes no new follower by hand past LIMITS.followers.max; leaving it and
  // removing others still work. A new assignee or reviewer still follows.
  const full = !!roster && (roster.more || roster.subscribers.length >= LIMITS.followers.max)
  const fullTip = `This task has ${LIMITS.followers.max} followers, the most a task can have`
  // the followers as the answer names them, in its name order
  const others = (roster?.subscribers ?? []).filter((row) => row.id !== me)
  const following = new Set((roster?.subscribers ?? []).map((row) => row.id))
  // the followers, named while the popover is open, so their pictures load
  usePeople(open ? others.map((row) => ({ org: issue.org, id: row.id })) : [])
  const changeSubscriber = (id: string, subscribed: boolean) => {
    setPending((ids) => [...ids, id])
    P.setIssueSubscriber(
      issue,
      id,
      subscribed,
      () => setPending((ids) => ids.filter((pendingId) => pendingId !== id)),
      subscribed
        ? () => {
            setAdding(false)
            setSearch('')
            requestAnimationFrame(() => {
              contentRef.current
                ?.querySelector<HTMLButtonElement>('[data-task-subscriber-add-open]')
                ?.focus()
            })
          }
        : undefined,
    )
  }

  if (rosterWaits && !disabled)
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-task-subscribe={issue.subscribed ? 'on' : 'off'}
        aria-label={
          issue.subscribed ? 'Unsubscribe from task updates' : 'Subscribe to task updates'
        }
        aria-pressed={!!issue.subscribed}
        className="w-control-sm h-control-sm"
        title={`${issue.subscribed ? 'Subscribed' : 'Not subscribed'} · Task subscribers: ${rosterWaits}`}
        onClick={() => P.setIssueSubscribed(issue.id, !issue.subscribed)}
      >
        <Icon name={issue.subscribed ? 'eye' : 'eyeOff'} size={16} />
      </Button>
    )

  if (disabled)
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-task-subscribe={issue.subscribed ? 'on' : 'off'}
        aria-label={`Task subscribers: ${issue.subscribed ? 'subscribed' : 'not subscribed'}`}
        className="w-control-sm h-control-sm"
        title={disabled}
        disabled
      >
        <Icon name={issue.subscribed ? 'eye' : 'eyeOff'} size={16} />
      </Button>
    )

  return (
    <Popover modal open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-task-subscribe={issue.subscribed ? 'on' : 'off'}
          aria-label={`Task subscribers: ${issue.subscribed ? 'subscribed' : 'not subscribed'}`}
          className="w-control-sm h-control-sm"
          title={`Task subscribers · ${issue.subscribed ? 'Subscribed' : 'Not subscribed'}`}
        >
          <Icon name={issue.subscribed ? 'eye' : 'eyeOff'} size={16} />
        </Button>
      </PopoverTrigger>
      {open &&
        createPortal(
          <div
            data-task-subscribers-backdrop
            className="fixed inset-0 z-[110] pointer-events-auto"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              changeOpen(false)
            }}
          />,
          document.body,
        )}
      <PopoverContent
        ref={contentRef}
        data-task-subscribers
        aria-label="Task subscribers"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        className="z-[120] flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border-border p-1 shadow-pop"
        onPointerDownOutside={(event) => {
          // Keep the transparent backdrop through the whole click, like
          // AnchoredPop. It consumes dismissal before the task scrim can.
          event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          changeOpen(false)
        }}
      >
        <MenuItem
          data-task-subscribe-me={issue.subscribed ? 'on' : 'off'}
          aria-label={
            issue.subscribed ? 'Unsubscribe from task updates' : 'Subscribe to task updates'
          }
          aria-pressed={!!issue.subscribed}
          disabled={!issue.subscribed && full}
          title={!issue.subscribed && full ? fullTip : undefined}
          onClick={() => P.setIssueSubscribed(issue.id, !issue.subscribed)}
        >
          <Avatar id={me} size={28} />
          <span className="flex-1">Me</span>
          <Icon name={issue.subscribed ? 'eye' : 'eyeOff'} size={16} />
        </MenuItem>
        {full && (
          <p data-task-subscribers-full className="px-2 pb-1 text-sm text-text-2">
            {fullTip}.
          </p>
        )}
        <Separator className="my-1" />
        <div
          data-task-subscribers-roster={refreshing ? 'refreshing' : roster ? 'current' : undefined}
          aria-busy={refreshing || undefined}
          className="min-h-0 overflow-y-auto overscroll-contain"
        >
          {failed ? (
            <p role="alert" className="px-2 py-2 text-sm text-text-2">
              Couldn’t load subscribers. Close and reopen to try again.
            </p>
          ) : !roster ? (
            <p role="status" className="px-2 py-2 text-sm text-text-2">
              Loading subscribers…
            </p>
          ) : others.length ? (
            <>
              {others.map((row) => (
                <div
                  key={row.id}
                  data-task-subscriber={row.id}
                  {...(row.active ? {} : { 'data-task-subscriber-off': '' })}
                  className="flex min-h-10 items-center gap-2 px-2 py-1"
                >
                  <RowAvatar row={row} org={issue.org} size={28} named />
                  <HoverTooltip content={row.name}>
                    <span className="min-w-0 flex-1 truncate text-base">
                      {row.name}
                      {!row.active && <span className="text-sm text-text-2"> (off)</span>}
                    </span>
                  </HoverTooltip>
                  {roster.canManage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-control-sm w-control-sm shrink-0"
                      data-task-subscriber-remove={row.id}
                      aria-label={`Remove ${row.name} from subscribers`}
                      title={`Remove ${row.name} from subscribers`}
                      disabled={pending.includes(row.id)}
                      onClick={() => changeSubscriber(row.id, false)}
                    >
                      <Icon name="close" size={16} />
                    </Button>
                  )}
                </div>
              ))}
              {roster.more && (
                <p data-task-subscribers-more className="px-2 py-1 text-sm text-text-2">
                  Showing the {LIMITS.followers.max} earliest followers. Later ones show here as
                  earlier ones unfollow.
                </p>
              )}
            </>
          ) : (
            <p className="px-2 py-2 text-sm text-text-2">No other subscribers.</p>
          )}
        </div>
        {roster?.canManage && (
          <div className="flex min-h-0 shrink-0 flex-col">
            <Separator className="my-1" />
            {adding ? (
              <>
                <div className="flex items-center gap-1 p-1">
                  <Input
                    ref={searchRef}
                    data-task-subscriber-search
                    aria-label="Search users to subscribe"
                    placeholder="Search users…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="h-control w-full bg-surface-1 text-base"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Cancel adding subscriber"
                    onClick={() => setAdding(false)}
                  >
                    <Icon name="close" size={16} />
                  </Button>
                </div>
                <FollowerAddList
                  issue={issue}
                  me={me}
                  search={search}
                  following={following}
                  pending={pending}
                  onAdd={(id) => changeSubscriber(id, true)}
                />
              </>
            ) : (
              <MenuItem
                data-task-subscriber-add-open
                disabled={full}
                title={full ? fullTip : undefined}
                onClick={() => setAdding(true)}
              >
                <Icon name="plus" size={16} />
                Add
              </MenuItem>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/* The people the follower popover's Add list offers, a batch at a time from
   the server (pickers.taskFollowers, P.followerChoices) while the list is
   open and the page shows, with the server's search over names,
   Load more and the list's end lines, at most PICKER_CAPS.owners kept. A
   person who follows the task since the batch was read leaves the list
   from the roster's live answer (`following`). Each portrait comes from the
   row's initials and color, and the list names no one, so opening it loads
   no face or picture. */
function FollowerAddList({
  issue,
  me,
  search: text,
  following,
  pending,
  onAdd,
}: {
  issue: IssueVM
  me: string | undefined
  search: string
  following: ReadonlySet<string>
  pending: readonly string[]
  onAdd: (id: string) => void
}) {
  const search = useSettledSearch(text, LIMITS.search)
  const { visible } = useViewVisibility()
  const list = usePagedList<FollowerChoices, FollowerChoice>({
    key: visible ? `${issue.org}\n${issue.uuid}\n${search.settled}` : null,
    source: {
      kind: 'once',
      read: (at) =>
        P.followerChoices({
          task: { uuid: issue.uuid, org: issue.org },
          search: search.settled,
          cursor: at.after,
        }),
    },
    batch: (answer) => (answer.state === 'ready' ? answer : null),
    id: (row) => row.id,
    most: PICKER_CAPS.owners,
  })
  const answered = !search.tooLong && search.settled === search.typed && list.phase !== 'first'
  const end = answered ? listEnd(list, search.settled !== '') : 'loading'
  const rows = list.rows.filter((row) => row.id !== me && !following.has(row.id))
  return (
    <div
      data-task-subscriber-candidates
      data-picker-state={answered ? list.phase : 'loading'}
      className="max-h-40 overflow-y-auto overscroll-contain"
    >
      {rows.map((row) => (
        <MenuItem
          key={row.id}
          data-task-subscriber-add={row.id}
          aria-label={`Subscribe ${row.name}`}
          disabled={pending.includes(row.id) || !answered}
          onClick={() => onAdd(row.id)}
        >
          <RowAvatar row={row} org={issue.org} size={28} />
          <HoverTooltip content={row.name}>
            <span tabIndex={-1} className="min-w-0 flex-1 truncate">
              {row.name}
            </span>
          </HoverTooltip>
          <Icon name="plus" size={14} />
        </MenuItem>
      ))}
      <ChoiceEnd end={end} tooLong={search.tooLong} list={list} words={FOLLOWER_WORDS} />
    </div>
  )
}
