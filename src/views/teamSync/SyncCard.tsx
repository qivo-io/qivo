/* A Team sync row and the quiet items around it: the card with its marks
   and one-click controls, the mention window, the Done-since and Waiting-on-
   review items, and the load chip. Everything reads the live store; every
   change made from a card stamps the page owner and ticks the row
   (docs/team-sync-brief.md, "Each row carries"). */
import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AssigneeAvatar, OwnerPickList } from '@/components/AssigneeAvatar'
import { LimitedTextarea } from '@/components/LimitedField'
import {
  AnchoredPop,
  Avatar,
  FieldSelect,
  Icon,
  IssueKey,
  MenuItem,
  PausedMark,
  ProjectNameOf,
  StatusDot,
} from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { PopoverContent, Popover as PopoverRoot, PopoverTrigger } from '@/components/ui/popover'
import { HoverTooltip } from '@/components/ui/tooltip'
import { RemainingInput, ReviewTick } from '@/components/walk'
import { planHint, type Reviewed } from '@/components/walkRows'
import { clampedTitleTip } from '@/lib/clampedTitle'
import { closeOrAsk, questionOpen } from '@/lib/discardQuestion'
import { overLimit } from '@/lib/fieldLimits'
import { type UnsentScope, UnsentScopeContext, useUnsaved, useUnsentScope } from '@/lib/leaveGuard'
import {
  bannerVerdict,
  dayLabel,
  type LoadFigure,
  mentionBody,
  rowMarks,
  type SinceMark,
  type SyncCardPlace,
  type SyncDay,
  waitingLabel,
} from '@/lib/teamSync'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { useMenuBackLayer, useMobileBackLayer } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { fmtHours } from '@/lib/workload'
import { type IssueVM, P, type UserVM } from '@/store/planner'
import type { StoreVersion } from '@/store/updates'
import { LIMITS } from '../../../convex/lib/limits'
import { DelayBanner } from '../kanbanCards'
import { weekFigure } from './weekFigure'

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
  /** each mounted card's scope of unsent text, with its task and section's
      person, which a scope switch reads to ask only about the cards it
      takes away */
  cards: Map<UnsentScope, SyncCardPlace>
}

/** The scope of the text typed in one card, inside the page's, registered
    in `ctx.cards` while the card is mounted. */
function useCardScope(ctx: PageCtx, uuid: string) {
  const scope = useUnsentScope()
  const { cards, owner } = ctx
  useLayoutEffect(() => {
    cards.set(scope, { task: uuid, owner })
    return () => {
      cards.delete(scope)
    }
  }, [cards, scope, uuid, owner])
  return scope
}

/* The task window's words for every control a read-only viewer finds off. */
const READ_ONLY = 'Read-only project access'

const firstName = (name: string) => name.split(' ')[0]

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
    required. `clamp` holds a long title to four lines, the whole of it in
    a tooltip. */
export function TitleButton({
  it,
  ctx,
  className,
  clamp = false,
}: {
  it: IssueVM
  ctx: Pick<PageCtx, 'onOpenTask'>
  className?: string
  clamp?: boolean
}) {
  return (
    <Button
      type="button"
      variant="unstyled"
      data-sync-open={it.id}
      data-focus-key="title"
      onClick={() => ctx.onOpenTask(it.id)}
      title={clamp ? clampedTitleTip(it.title) : undefined}
      className={cn(
        'min-w-0 cursor-pointer rounded-sm text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
    >
      {/* a button does not clamp in every browser, so a span inside does */}
      {clamp ? <span className="line-clamp-4">{it.title}</span> : it.title}
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
    Pause / Resume) behind a select-look trigger showing the dot and the
    dropdown arrow (deviation #326). A move into In Review with no reviewer
    offers the reviewer picker right after. */
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
        className="min-w-control [&_[data-slot=select-value]>.truncate]:hidden"
        options={P.STATUSES.map((s) => ({
          value: s.id,
          label: s.name,
          icon: <StatusDot status={s.id} />,
        }))}
        onChange={(v) => {
          // the row counts as touched once the server saves the move
          void P.updateIssue(it.id, { status: v }).then((saved) => {
            if (saved) ctx.touched(it)
          })
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
            void P.updateIssue(it.id, { paused: !it.paused }).then((saved) => {
              if (saved) ctx.touched(it)
            })
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
  // a note on its way to the server. The window locks it until the answer.
  const [sending, setSending] = useState(false)
  // The note stays when the window closes while it is sent, or after a
  // refusal, so reopening shows it again. A save or Cancel lets it go. A
  // kept note holds back an app update even while the window is closed.
  const [kept, setKept] = useState(false)
  useUpdateBlocker((open || kept) && text.trim() !== '')
  // a Discard throws the note away even while its card stays on the page
  useUnsaved((open || kept) && text.trim() !== '', 'note', undefined, () => {
    setKept(false)
    setText('')
  })
  // A note neither sent nor kept is gone once the window closes, so a close
  // asks first (DiscardPrompt), except the one Cancel or a saved note makes.
  const noteWindow = useUnsentScope()
  useUnsaved(open && !kept && text.trim() !== '', 'note', noteWindow)
  const letGo = useRef(false)
  const close = useMobileBackLayer(open, (again) => {
    const meant = letGo.current
    letGo.current = false
    if (!meant && noteWindow.held().length) {
      closeOrAsk([noteWindow], () => {
        letGo.current = true
        again()
      })
      return false
    }
    setOpen(false)
  })
  const canWrite = P.canWrite(it.project)
  // the people who can see the task (a mention of anyone else notifies no
  // one), humans only, never the writer
  const people = P.issueUsersFor(it.project).filter(
    (u) => u.active && !u.isAgent && u.id !== P.CURRENT_USER,
  )
  const person = people.find((u) => u.id === who) || null
  // the note is saved as a comment, so a comment's cap holds it
  const ready = !!person && text.trim() !== '' && !overLimit(LIMITS.comment, text) && !sending
  const send = () => {
    if (!ready) return
    // The window closes once the server saves the note. A refused one (the
    // store toasts why, such as lost access or a body over the length cap
    // once escaped) keeps the window open, so the note is not lost.
    setKept(true)
    setSending(true)
    void P.addComment(it.uuid, mentionBody(person, text)).then((saved) => {
      setSending(false)
      if (!saved) return
      setKept(false)
      letGo.current = true
      close()
      onSent()
    })
  }
  const cancel = () => {
    setKept(false)
    letGo.current = true
    close()
  }
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) return close()
        if (!kept) {
          setWho(initial && people.some((u) => u.id === initial) ? initial : null)
          setText('')
        }
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
        // the discard question takes focus without closing the note window
        onFocusOutside={(event) => {
          if (questionOpen()) event.preventDefault()
        }}
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
              disabled={sending}
              onClick={() => setWho(u.id)}
              aria-label={u.name}
              aria-pressed={who === u.id}
              className="grid size-8 cursor-pointer place-items-center rounded-sm border-none bg-transparent p-0 aria-pressed:shadow-[0_0_0_2px_var(--primary)] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <Avatar id={u.id} size={28} />
            </Button>
          ))}
        </div>
        <LimitedTextarea
          limit={LIMITS.comment}
          rows={2}
          aria-label="Note"
          placeholder="A short note…"
          readOnly={sending}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          wrapperClassName="mb-2"
          className="max-h-[min(48dvh,260px)] min-h-0 resize-none overflow-y-auto bg-surface-1 text-sm"
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
          <Button type="button" variant="ghost" size="sm" disabled={sending} onClick={cancel}>
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

type SyncCardProps = {
  it: IssueVM
  ctx: PageCtx
  later?: boolean
  /** P.contextVersion, for what the row reads besides its task */
  context: StoreVersion
  /** the task's latest comment (P.lastComments), which the marks read */
  lastComment: number | null | undefined
  /** whether the row is ticked (ctx.reviewed) */
  reviewed: boolean
}

/** One row of a person's page, as a board card: the delay banner, the
    title, the meta and marks lines, then the controls. `later` quiets a
    To Do row planned past this week. */
function SyncCardView({ it, ctx, later }: SyncCardProps) {
  const ownerRef = useRef<HTMLSpanElement>(null)
  const canWrite = P.canWrite(it.project)
  const marks = rowMarks(it, {
    person: ctx.owner,
    since: ctx.since,
    verdict: bannerVerdict(P.delayOf(it), P.tracksDelay(it)),
    issueById: P.issueById,
    // absent until an answer covers this task, so no since mark shows
    lastCommentAt: P.lastComments.get(it.uuid),
  })
  const hint = planHint(it)
  const dueLate = !!it.due && (it.due < ctx.day.today || marks.verdict === 'late')
  const reviewFor = marks.reviewFor ? P.user(marks.reviewFor) : null
  const hasMarks =
    marks.noEstimate ||
    marks.noReviewer ||
    marks.blockedBy.length > 0 ||
    !!marks.since ||
    !!reviewFor
  const tick = (
    <ReviewTick
      hook="sync"
      it={it}
      on={ctx.reviewed.has(it.uuid)}
      onToggle={() => ctx.reviewed.toggle(it.uuid)}
      markTitle="Mark reviewed"
    />
  )
  const scope = useCardScope(ctx, it.uuid)
  return (
    <UnsentScopeContext.Provider value={scope}>
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
              clamp
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
            <span className="truncate">
              <ProjectNameOf id={it.project} />
            </span>
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
              {marks.since && <SinceText mark={marks.since} now={ctx.now} />}
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
            <span
              className={cn('inline-flex shrink-0 items-center', ctx.mobile ? 'gap-1' : 'gap-2')}
            >
              <RemainingInput
                hook="sync"
                it={it}
                title={canWrite ? 'Remaining hours. Leave empty for no estimate' : READ_ONLY}
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
    </UnsentScopeContext.Provider>
  )
}

/* A person's page renders every card again on each store change. A card
   renders the same while its task keeps its object (P.issues keeps it while
   the task, its delay, its family and the tasks linked to it stay the
   same), with the same context, comment, tick and prompt, the same page
   owner and reading point, on the same day (every label it shows counts
   whole days) and layout, so it skips. Its callbacks act the same for the
   same page owner: TeamSync keeps onOpenTask and onShowTask, and the
   reviewed set's mark and toggle update its latest state. */
export const SyncCard = memo(
  SyncCardView,
  (a, b) =>
    a.it === b.it &&
    a.later === b.later &&
    a.context === b.context &&
    a.lastComment === b.lastComment &&
    a.reviewed === b.reviewed &&
    a.ctx.owner === b.ctx.owner &&
    a.ctx.since === b.ctx.since &&
    a.ctx.day.today === b.ctx.day.today &&
    a.ctx.mobile === b.ctx.mobile &&
    (a.ctx.prompt === a.it.id) === (b.ctx.prompt === b.it.id) &&
    a.ctx.onOpenTask === b.ctx.onOpenTask &&
    a.ctx.onShowTask === b.ctx.onShowTask,
)

/** A task finished since the page owner's reading point: quiet, not a row. */
function DoneItemView({
  it,
  kind,
  ctx,
}: {
  it: IssueVM
  kind: 'done' | 'reviewed'
  /** P.contextVersion, for the project name it reads */
  context: StoreVersion
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
          clamp
          className="flex-1 break-words text-base leading-[1.35] text-text-2"
        />
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-3">
        <IssueKey id={it.key} dim />
        <span className="truncate">
          <ProjectNameOf id={it.project} />, {dayLabel(it.doneAt ?? ctx.now, ctx.now)}
          {kind === 'reviewed' && ', reviewed'}
        </span>
      </div>
    </div>
  )
}

/* A done task renders the same while its task keeps its object, with the
   same kind and context, on the same day (its label counts whole days),
   and the same way to open it, as SyncCard does. */
export const DoneItem = memo(
  DoneItemView,
  (a, b) =>
    a.it === b.it &&
    a.kind === b.kind &&
    a.context === b.context &&
    a.ctx.day.today === b.ctx.day.today &&
    a.ctx.onOpenTask === b.ctx.onOpenTask,
)

/** One line of the quiet "Waiting on review" foot: the page owner's own task
    that someone else reviews. Not editable, not counted; the @ asks the
    reviewer. */
function WaitingItemView({
  it,
  reviewer,
  since,
  ctx,
}: {
  it: IssueVM
  reviewer: string
  /** the hand-off instant, null when unknown: then no age is shown */
  since: number | null
  /** P.contextVersion, for the names it reads */
  context: StoreVersion
  ctx: PageCtx
}) {
  const scope = useCardScope(ctx, it.uuid)
  return (
    <UnsentScopeContext.Provider value={scope}>
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
    </UnsentScopeContext.Provider>
  )
}

/* A waiting line renders the same while its task keeps its object, with
   the same reviewer, hand-off and context, on the same day, for the same
   page owner and cards: its @ stamps the page owner, as SyncCard's
   callbacks do. */
export const WaitingItem = memo(
  WaitingItemView,
  (a, b) =>
    a.it === b.it &&
    a.reviewer === b.reviewer &&
    a.since === b.since &&
    a.context === b.context &&
    a.ctx.owner === b.ctx.owner &&
    a.ctx.cards === b.ctx.cards &&
    a.ctx.day.today === b.ctx.day.today &&
    a.ctx.onOpenTask === b.ctx.onOpenTask,
)
