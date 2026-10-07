/* A Team sync row and the quiet items around it: the card with its marks
   and one-click controls, the mention window, the Done-since and Waiting-on-
   review items, and the load chip. Everything reads the live store; every
   change made from a card stamps the page owner and ticks the row
   (docs/team-sync-brief.md, "Each row carries"). */
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AssigneeAvatar, OwnerPickList } from '@/components/AssigneeAvatar'
import {
  AnchoredPop,
  Avatar,
  FieldSelect,
  Icon,
  IssueKey,
  MenuItem,
  PausedMark,
  StatusDot,
} from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { PopoverContent, Popover as PopoverRoot, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { HoverTooltip } from '@/components/ui/tooltip'
import { planHint, RemainingInput, type Reviewed, ReviewTick } from '@/components/walk'
import {
  bannerVerdict,
  dayLabel,
  type LoadFigure,
  loadFigure,
  mentionBody,
  rowMarks,
  type SinceMark,
  type SyncDay,
  waitingLabel,
} from '@/lib/teamSync'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { useMenuBackLayer, useMobileBackLayer } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { fmtHours, plannableHoursOf } from '@/lib/workload'
import { type IssueVM, P, type UserVM } from '@/store/planner'
import { DelayBanner } from '../kanbanCards'

/** What every card on one page shares: whose page it is, their reading
    point, and the page's callbacks. */
export type PageCtx = {
  /** the page owner's profile id: every change made from a card stamps them */
  owner: string
  /** the page owner's reading point (ms): "Done since", untouched, changed */
  since: number
  now: number
  day: SyncDay
  mobile: boolean
  reviewed: Reviewed
  /** stamp the page owner (a change was made on them through the sync) */
  stamp: () => void
  /** a change was made from this row: stamp the page owner and tick it */
  touched: (it: IssueVM) => void
  /** the row whose reviewer prompt is open, after a move into In Review */
  prompt: string | null
  setPrompt: (handle: string | null) => void
  onOpenTask: (handle: string) => void
  onShowTask: (view: 'kanban' | 'roadmap', handle: string) => void
}

/* The task window's words for every control a read-only viewer finds off. */
const READ_ONLY = 'Read-only project access'

const firstName = (name: string) => name.split(' ')[0]

/** Where a task lives: the sub-project, after its project when they differ. */
export function whereLabel(it: IssueVM) {
  const sub = P.project(it.project)
  const meta = P.metaOf(it.project)
  return meta && sub && meta.id !== sub.id ? `${meta.name}, ${sub.name}` : sub?.name || ''
}

/** A person's week as the Team strip reads it: org-wide hours (P.weekLoadOf)
    over plannable hours, in the strip's colour rule. */
export function weekFigure(u: UserVM): LoadFigure {
  return loadFigure(P.weekLoadOf(u.id, P.TODAY_WEEK), plannableHoursOf(u))
}

const LOAD_FILL: Record<LoadFigure['tone'], string> = {
  normal: 'bg-[color-mix(in_oklab,var(--primary)_16%,transparent)]',
  near: 'bg-[var(--heat-near-fill,color-mix(in_oklab,var(--pressure-warn)_14%,transparent))]',
  over: 'bg-[var(--heat-over-fill,color-mix(in_oklab,var(--pressure-over)_18%,transparent))]',
  agent: 'bg-[color-mix(in_oklab,var(--primary)_8%,transparent)]',
}

/** "88% of 32 h this week", or an agent's "12 h scheduled this week". */
export function LoadChip({ user }: { user: UserVM }) {
  const f = weekFigure(user)
  return (
    <span
      data-sync-load={f.tone}
      className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-sm text-text-2"
    >
      <span
        className={cn(
          'rounded-sm px-1.5 py-px !font-mono font-medium text-text-1',
          LOAD_FILL[f.tone],
        )}
      >
        {f.pct == null ? `${fmtHours(f.hours)} h` : `${f.pct}%`}
      </span>
      {f.capacity == null ? 'scheduled this week' : `of ${fmtHours(f.capacity)} h this week`}
    </span>
  )
}

/** A task title that opens the task window: tasks open on request, never
    required. */
export function TitleButton({
  it,
  ctx,
  className,
}: {
  it: IssueVM
  ctx: Pick<PageCtx, 'onOpenTask'>
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="unstyled"
      data-sync-open={it.id}
      onClick={() => ctx.onOpenTask(it.id)}
      className={cn(
        'min-w-0 cursor-pointer rounded-sm text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
    >
      {it.title}
    </Button>
  )
}

/* The one "since the last sync" mark, in the brief's words. */
function SinceText({ mark, now }: { mark: SinceMark; now: number }) {
  const when = dayLabel(mark.at, now)
  if (mark.kind === 'untouched' || mark.kind === 'waiting')
    return (
      <span data-sync-since={mark.kind} className="inline-flex items-center gap-1 text-warning">
        {mark.kind === 'untouched' && <Icon name="history" size={12} strokeWidth={2} />}
        {mark.kind === 'untouched' ? 'untouched' : 'waiting'} since {when}
      </span>
    )
  return (
    <span data-sync-since={mark.kind} className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-primary" />
      {mark.kind === 'handed' ? 'handed to you' : mark.what} {when}
    </span>
  )
}

/** The row's status: the task window's Status menu (five statuses, then
    Pause / Resume) behind a select-look trigger showing only the dot. A move
    into In Review with no reviewer offers the reviewer picker right after. */
function StatusCtl({ it, ctx, canWrite }: { it: IssueVM; ctx: PageCtx; canWrite: boolean }) {
  return (
    <span data-sync-status={it.id} className="inline-flex shrink-0">
      <FieldSelect
        aria-label={`Status of ${it.title}`}
        value={it.status}
        menuWidth={180}
        backLayer
        disabled={!canWrite}
        title={canWrite ? undefined : READ_ONLY}
        className="min-w-control justify-center gap-0 [&>svg]:hidden [&_[data-slot=select-value]>.truncate]:hidden"
        options={P.STATUSES.map((s) => ({
          value: s.id,
          label: s.name,
          icon: <StatusDot status={s.id} />,
        }))}
        onChange={(v) => {
          P.updateIssue(it.id, { status: v })
          ctx.touched(it)
          if (v === 'review' && !it.reviewer) ctx.setPrompt(it.id)
        }}
        action={{
          label: it.paused ? 'Resume' : 'Pause',
          icon: (
            <Icon
              name={it.paused ? 'play' : 'pause'}
              size={14}
              color={it.paused ? 'var(--success)' : 'var(--text-2)'}
            />
          ),
          onSelect: () => {
            P.updateIssue(it.id, { paused: !it.paused })
            ctx.touched(it)
          },
        }}
      />
    </span>
  )
}

/** The reviewer picker a move into In Review offers, anchored to the row's
    owner control. Escape, a click outside or a phone's Back skips it; a pick
    is a change made from the row, written once the prompt's Back step has
    landed. Closing hands focus back to the owner control while the row is
    still on the page (a pick usually moves it to the reviewer's page). */
function ReviewerPrompt({
  it,
  ctx,
  anchor,
}: {
  it: IssueVM
  ctx: PageCtx
  anchor: RefObject<HTMLElement>
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const skip = useMenuBackLayer(true, () => ctx.setPrompt(null))
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect()
    if (r) setAt({ x: r.right, y: r.bottom })
  }, [])
  // on close the focused search box goes with the prompt: return focus to
  // the row, unless the close already put it somewhere
  useEffect(
    () => () => {
      const lost = !document.activeElement || document.activeElement === document.body
      if (lost && anchor.current?.isConnected)
        anchor.current.querySelector('button')?.focus({ preventScroll: true })
    },
    [],
  )
  // Focus the search box so typing a name just works. The status menu hands
  // focus back to its trigger once its close animation ends, after this
  // opens: while that can still happen, a return to this row's status
  // trigger is taken back for the box.
  const placed = at != null
  useEffect(() => {
    if (!placed) return
    const take = () => body.current?.querySelector('input')?.focus({ preventScroll: true })
    const t = window.setTimeout(take, 0)
    const back = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.closest(`[data-sync-status="${it.id}"]`)) take()
    }
    document.addEventListener('focusin', back)
    const done = window.setTimeout(() => document.removeEventListener('focusin', back), 1000)
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(done)
      document.removeEventListener('focusin', back)
    }
  }, [placed, it.id])
  if (!at) return null
  return (
    <AnchoredPop x={at.x} y={at.y} width={260} align="right" gap={6} onClose={() => skip()}>
      <div ref={body} data-sync-reviewer-prompt={it.id} className="p-1">
        <OwnerPickList issue={it} field="reviewer" onClose={skip} onPick={() => ctx.touched(it)} />
      </div>
    </AnchoredPop>
  )
}

/** The @ glyph and its window: pick a person, write a line, Send. It posts
    an ordinary comment carrying the @mention, so the person gets it in the
    Inbox and the task's discussion keeps it. `initial` is the task's other
    party (the assignee on a reviewer's row, the reviewer on a waiting row). */
export function MentionCtl({
  it,
  initial,
  onSent,
}: {
  it: IssueVM
  initial: string | null
  onSent: () => void
}) {
  const [open, setOpen] = useState(false)
  const [who, setWho] = useState<string | null>(null)
  const [text, setText] = useState('')
  const close = useMobileBackLayer(open, () => setOpen(false))
  useUpdateBlocker(open && text.trim() !== '')
  const canWrite = P.canWrite(it.project)
  // the people who can see the task (a mention of anyone else notifies no
  // one), humans only, never the writer
  const people = P.issueUsersFor(it.project).filter(
    (u) => u.active && !u.isAgent && u.id !== P.CURRENT_USER,
  )
  const person = people.find((u) => u.id === who) || null
  const ready = !!person && text.trim() !== ''
  const send = () => {
    if (!ready) return
    P.addComment(it.uuid, mentionBody(person, text))
    close()
    onSent()
  }
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) return close()
        setWho(initial && people.some((u) => u.id === initial) ? initial : null)
        setText('')
        setOpen(true)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-sync-mention={it.id}
          disabled={!canWrite}
          title={canWrite ? 'Mention someone on this task' : READ_ONLY}
          aria-label="Mention someone on this task"
          className={cn(
            'w-control-sm h-control-sm shrink-0 text-text-3 hover:text-text-1',
            open && 'bg-hover text-text-1',
          )}
        >
          <Icon name="at" size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        data-sync-mention-window={it.id}
        className="z-[120] w-[min(340px,calc(100vw-32px))] rounded-lg p-3 shadow-pop"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-semibold text-text-1">Mention on</span>
          <IssueKey id={it.key} />
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {people.map((u) => (
            <Button
              key={u.id}
              type="button"
              variant="unstyled"
              data-sync-mention-person={u.id}
              onClick={() => setWho(u.id)}
              aria-label={u.name}
              aria-pressed={who === u.id}
              className="grid size-8 cursor-pointer place-items-center rounded-sm border-none bg-transparent p-0 aria-pressed:shadow-[0_0_0_2px_var(--primary)]"
            >
              <Avatar id={u.id} size={28} />
            </Button>
          ))}
        </div>
        <Textarea
          rows={2}
          aria-label="Note"
          placeholder="A short note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          className="mb-2 min-h-0 resize-none bg-surface-1 text-sm"
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-text-3">
            {person ? (
              <>
                Posted as a comment;{' '}
                <b className="font-medium text-text-2">@{firstName(person.name)}</b> gets it in the
                Inbox
              </>
            ) : (
              'Pick who gets it'
            )}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-sync-mention-send
            disabled={!ready}
            onClick={send}
            className="font-semibold"
          >
            Send
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}

const JUMP_GLYPH = 'w-control-sm h-control-sm shrink-0 text-text-3 hover:text-text-1'

/* The phone's fold of the two jumps: one menu that holds a Back layer while
   open, so the system Back closes the menu instead of leaving the page. A
   jump first consumes that layer, then leaves, so Back from the Board or
   the Roadmap returns to the sync (the Palette's order). */
function PhoneJumps({ it, ctx }: { it: IssueVM; ctx: PageCtx }) {
  const [open, setOpen] = useState(false)
  const close = useMenuBackLayer(open, () => setOpen(false))
  const jump = (view: 'kanban' | 'roadmap') => close(() => ctx.onShowTask(view, it.id))
  return (
    <PopoverRoot open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-sync-jumps={it.id}
          aria-label="Show elsewhere"
          className={JUMP_GLYPH}
        >
          <Icon name="more" size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="z-[120] w-[200px] rounded-lg p-1 shadow-pop"
      >
        <MenuItem data-sync-board={it.id} onClick={() => jump('kanban')}>
          <Icon name="board" size={15} />
          Show on the Board
        </MenuItem>
        <MenuItem data-sync-roadmap={it.id} onClick={() => jump('roadmap')}>
          <Icon name="timeline" size={15} />
          Show on the Roadmap
        </MenuItem>
      </PopoverContent>
    </PopoverRoot>
  )
}

/* The two quiet ways out to where re-planning happens. On a phone they fold
   into one menu so the controls row stays one line. */
function RowJumps({ it, ctx }: { it: IssueVM; ctx: PageCtx }) {
  if (ctx.mobile) return <PhoneJumps it={it} ctx={ctx} />
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-sync-board={it.id}
        title="Show on the Board"
        aria-label="Show on the Board"
        onClick={() => ctx.onShowTask('kanban', it.id)}
        className={JUMP_GLYPH}
      >
        <Icon name="board" size={15} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-sync-roadmap={it.id}
        title="Show on the Roadmap"
        aria-label="Show on the Roadmap"
        onClick={() => ctx.onShowTask('roadmap', it.id)}
        className={JUMP_GLYPH}
      >
        <Icon name="timeline" size={15} />
      </Button>
    </>
  )
}

/** One row of a person's page, as a board card: the delay banner, the
    title, the meta and marks lines, then the controls. `later` quiets a
    To Do row planned past this week. */
export function SyncCard({ it, ctx, later }: { it: IssueVM; ctx: PageCtx; later?: boolean }) {
  const ownerRef = useRef<HTMLSpanElement>(null)
  const canWrite = P.canWrite(it.project)
  const marks = rowMarks(it, {
    person: ctx.owner,
    since: ctx.since,
    verdict: bannerVerdict(P.delayOf(it), P.tracksDelay(it)),
    issueById: P.issueById,
    lastCommentAt: P.lastComments.get(it.uuid),
    activity: P.activity,
  })
  // untouched / changed read the latest comments too: say nothing until
  // they have arrived rather than call a discussed task untouched
  const since = P.lastCommentsLoaded ? marks.since : null
  const hint = planHint(it)
  const dueLate = !!it.due && (it.due < ctx.day.today || marks.verdict === 'late')
  const reviewFor = marks.reviewFor ? P.user(marks.reviewFor) : null
  const hasMarks =
    marks.noEstimate || marks.noReviewer || marks.blockedBy.length > 0 || !!since || !!reviewFor
  const tick = (
    <ReviewTick
      hook="sync"
      it={it}
      on={ctx.reviewed.has(it.uuid)}
      onToggle={() => ctx.reviewed.toggle(it.uuid)}
      markTitle="Mark reviewed"
    />
  )
  return (
    <div
      data-sync-card={it.id}
      className={cn(
        'board-card overflow-hidden rounded-md border border-border bg-surface-1 shadow-card',
        later && 'opacity-60 focus-within:opacity-100 hover:opacity-100',
      )}
    >
      <DelayBanner it={it} />
      <div className="flex flex-col gap-2 p-2">
        <div className="flex items-start gap-2">
          <TitleButton
            it={it}
            ctx={ctx}
            className="flex-1 break-words text-base font-medium leading-[1.35]"
          />
          {it.paused && (
            <HoverTooltip content="Paused">
              <PausedMark className="mt-0.5" />
            </HoverTooltip>
          )}
          {ctx.mobile && tick}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
          <IssueKey id={it.key} dim />
          <span className="truncate">{P.project(it.project)?.name}</span>
          {hint && <span className="!font-mono">{hint}</span>}
          {it.start != null && it.due && (
            <span className={cn('!font-mono', dueLate && 'font-semibold text-danger')}>
              due {P.fmtISO(it.due)}
            </span>
          )}
        </div>
        {hasMarks && (
          <div
            data-sync-marks
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3"
          >
            {marks.noEstimate && <span className="text-warning">no estimate</span>}
            {marks.noReviewer && <span className="text-warning">no reviewer</span>}
            {marks.blockedBy.length > 0 && (
              <span data-sync-blocked className="inline-flex items-center gap-1 text-text-2">
                <Icon name="blocked" size={12} color="var(--danger)" strokeWidth={2.2} />
                blocked by <span className="!font-mono">{marks.blockedBy.join(', ')}</span>
              </span>
            )}
            {since && <SinceText mark={since} now={ctx.now} />}
            {reviewFor && (
              <span className="inline-flex items-center gap-1.5 text-text-2">
                <Avatar id={reviewFor.id} size={20} />
                for {firstName(reviewFor.name)}
              </span>
            )}
          </div>
        )}
        {/* Two groups that wrap rather than clip: the edits (Remaining,
            status, owner) and, pushed right, the ways out (mention, jumps,
            tick), which drop to a second line when the column is narrow. One
            line on a phone, whose controls are 44px: tighter gaps and a
            narrower box, the two jumps folded into one menu (RowJumps) and
            the tick up beside the title. */}
        <div
          data-sync-controls
          className={cn(
            'mt-1 flex flex-wrap items-center gap-y-1.5 border-t border-border pt-2',
            ctx.mobile ? 'gap-x-1' : 'gap-x-2',
          )}
        >
          <span className={cn('inline-flex shrink-0 items-center', ctx.mobile ? 'gap-1' : 'gap-2')}>
            <RemainingInput
              hook="sync"
              it={it}
              title={canWrite ? 'Remaining hours, empty means unset' : READ_ONLY}
              disabled={!canWrite}
              onCommit={ctx.touched}
              className={cn(ctx.mobile && 'w-12', it.remaining == null && 'border-warning')}
            />
            <span className="text-sm text-text-3">h</span>
            <StatusCtl it={it} ctx={ctx} canWrite={canWrite} />
            <span ref={ownerRef} data-sync-owner={it.id} className="inline-flex shrink-0">
              <AssigneeAvatar
                issue={it}
                variant="chevron"
                backLayer
                onPick={() => ctx.touched(it)}
              />
            </span>
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center">
            <MentionCtl it={it} initial={marks.reviewFor} onSent={() => ctx.touched(it)} />
            <RowJumps it={it} ctx={ctx} />
            {!ctx.mobile && <span className="ml-2 inline-flex">{tick}</span>}
          </span>
        </div>
      </div>
      {ctx.prompt === it.id && <ReviewerPrompt it={it} ctx={ctx} anchor={ownerRef} />}
    </div>
  )
}

/** A task finished since the page owner's reading point: quiet, not a row. */
export function DoneItem({
  it,
  kind,
  ctx,
}: {
  it: IssueVM
  kind: 'done' | 'reviewed'
  ctx: PageCtx
}) {
  return (
    <div data-sync-done-row={it.id} className="rounded-md border border-border p-2 opacity-80">
      <div className="flex items-start gap-2">
        <span className="mt-[3px] inline-flex">
          <StatusDot status="done" size={13} />
        </span>
        <TitleButton
          it={it}
          ctx={ctx}
          className="flex-1 break-words text-base leading-[1.35] text-text-2"
        />
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-3">
        <IssueKey id={it.key} dim />
        <span className="truncate">
          {P.project(it.project)?.name}, {dayLabel(it.doneAt ?? ctx.now, ctx.now)}
          {kind === 'reviewed' && ', reviewed'}
        </span>
      </div>
    </div>
  )
}

/** One line of the quiet "Waiting on review" foot: the page owner's own task
    that someone else reviews. Not editable, not counted; the @ asks the
    reviewer. */
export function WaitingItem({
  it,
  reviewer,
  since,
  ctx,
}: {
  it: IssueVM
  reviewer: string
  /** the hand-off instant, null when unknown: then no age is shown */
  since: number | null
  ctx: PageCtx
}) {
  return (
    <div data-sync-waiting={it.id} className="flex min-w-0 items-center gap-2 px-1 text-sm">
      <span className="inline-flex shrink-0">
        <IssueKey id={it.key} dim />
      </span>
      <TitleButton it={it} ctx={ctx} className="flex-1 truncate text-text-2" />
      <Avatar id={reviewer} size={20} />
      {since != null && (
        <span className="whitespace-nowrap text-xs text-text-3">
          {waitingLabel(since, ctx.now)}
        </span>
      )}
      <MentionCtl it={it} initial={reviewer} onSent={ctx.stamp} />
    </div>
  )
}
