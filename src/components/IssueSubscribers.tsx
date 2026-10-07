import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { HoverTooltip } from '@/components/ui/tooltip'
import { matchesAllWords } from '../lib/search'
import { type IssueVM, P, type IssueSubscribers as SubscriberRoster } from '../store/planner'
import { Avatar, Icon, MenuItem } from './qivo'

/** The eye remains personal; opening its roster never changes a subscription. */
export function IssueSubscribers({ issue }: { issue: IssueVM }) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [roster, setRoster] = useState<SubscriberRoster | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const me = P.myProfileIds.find((id) => P.user(id)?.org === issue.org)

  useEffect(() => {
    if (!open) return
    setRoster(null)
    setFailed(false)
    return P.watchIssueSubscribers(issue.id, setRoster, () => {
      setRoster(null)
      setFailed(true)
    })
  }, [open, issue.id])

  useEffect(() => {
    if (adding) searchRef.current?.focus()
  }, [adding])

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) {
      setRoster(null)
      setFailed(false)
    } else {
      setAdding(false)
      setSearch('')
    }
  }
  const nameOf = (id: string) => P.user(id)?.name || 'Unavailable user'
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b))
  const others = (roster?.subscribers ?? []).filter((id) => id !== me).sort(byName)
  const candidates = (roster?.candidates ?? [])
    .filter((id) => id !== me)
    .filter((id) => matchesAllWords(`${nameOf(id)} ${P.user(id)?.email || ''}`, search))
    .sort(byName)
  const changeSubscriber = (id: string, subscribed: boolean) => {
    setPending((ids) => [...ids, id])
    P.setIssueSubscriber(
      issue.id,
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
          onClick={() => P.setIssueSubscribed(issue.id, !issue.subscribed)}
        >
          <Avatar id={me} size={28} />
          <span className="flex-1">Me</span>
          <Icon name={issue.subscribed ? 'eye' : 'eyeOff'} size={16} />
        </MenuItem>
        <Separator className="my-1" />
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {failed ? (
            <p role="alert" className="px-2 py-2 text-sm text-text-2">
              Couldn’t load subscribers. Close and reopen to try again.
            </p>
          ) : !roster ? (
            <p role="status" className="px-2 py-2 text-sm text-text-2">
              Loading subscribers…
            </p>
          ) : others.length ? (
            others.map((id) => (
              <div
                key={id}
                data-task-subscriber={id}
                className="flex min-h-10 items-center gap-2 px-2 py-1"
              >
                <Avatar id={id} size={28} />
                <HoverTooltip content={nameOf(id)}>
                  <span className="min-w-0 flex-1 truncate text-base">{nameOf(id)}</span>
                </HoverTooltip>
                {roster.canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-control-sm w-control-sm shrink-0"
                    data-task-subscriber-remove={id}
                    aria-label={`Remove ${nameOf(id)} from subscribers`}
                    title={`Remove ${nameOf(id)} from subscribers`}
                    disabled={pending.includes(id)}
                    onClick={() => changeSubscriber(id, false)}
                  >
                    <Icon name="close" size={16} />
                  </Button>
                )}
              </div>
            ))
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
                <div className="max-h-40 overflow-y-auto overscroll-contain">
                  {candidates.map((id) => (
                    <MenuItem
                      key={id}
                      data-task-subscriber-add={id}
                      aria-label={`Subscribe ${nameOf(id)}`}
                      disabled={pending.includes(id)}
                      onClick={() => changeSubscriber(id, true)}
                    >
                      <Avatar id={id} size={28} />
                      <HoverTooltip content={nameOf(id)}>
                        <span tabIndex={-1} className="min-w-0 flex-1 truncate">
                          {nameOf(id)}
                        </span>
                      </HoverTooltip>
                      <Icon name="plus" size={14} />
                    </MenuItem>
                  ))}
                  {!candidates.length && (
                    <p className="px-2 py-2 text-sm text-text-2">
                      {search.trim() ? 'No users found.' : 'No other users to add.'}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <MenuItem data-task-subscriber-add-open onClick={() => setAdding(true)}>
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
