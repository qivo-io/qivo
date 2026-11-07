/* A Team sync row and the quiet items around it: the card with its marks
   and one-click controls, the mention window, the Done-since and Waiting-on-
   review items, and the load chip. A card shows its task as the page's
   meeting gives it (views/teamSync/useSyncMeeting.ts), the workspace's
   model or the one shaped from the agenda's row, with the agenda's verdict
   and blockers; its controls write through the store either way. Every
   change made from a card stamps the page owner and ticks the row
   (deviation #316). */
import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AssigneeAvatar, OwnerPickList } from '@/components/AssigneeAvatar'
import { LimitedTextarea } from '@/components/LimitedField'
import { ChoiceEnd, PickerSearch } from '@/components/pickerParts'
import { escapeClearsFirst, RECIPIENT_WORDS } from '@/components/pickerWords'
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
import { useClosingWords } from '@/lib/closingWords'
import { closeOrAsk, questionOpen } from '@/lib/discardQuestion'
import { overLimit, sentence } from '@/lib/fieldLimits'
import { type UnsentScope, UnsentScopeContext, useUnsaved, useUnsentScope } from '@/lib/leaveGuard'
import { listEnd, usePagedList, useSettledSearch } from '@/lib/pagedList'
import { PICKER_CAPS } from '@/lib/pickerCaps'
import {
  dayLabel,
  type LoadFigure,
  mentionBody,
  rowMarks,
  type SinceMark,
  type SyncCardPlace,
  type SyncDay,
  type SyncLoad,
  type SyncVerdict,
  waitingLabel,
} from '@/lib/teamSync'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { useMenuBackLayer, useMobileBackLayer } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { fmtHours } from '@/lib/workload'
import { type IssueVM, type OwnerChoice, type OwnerChoices, P } from '@/store/planner'
import type { StoreVersion } from '@/store/updates'
import { LIMITS } from '../../../convex/lib/limits'
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
  /** the row whose reviewer prompt is open, after a move into In Review;
      the page clears it, and the card hides it, while the meeting is stale
      (`frozen`) */
  prompt: string | null
  setPrompt: (handle: string | null) => void
  onOpenTask: (handle: string) => void
  onShowTask: (view: 'kanban' | 'roadmap', handle: string) => void
  /** each mounted card's scope of unsent text, with its task and section's
      person, which a scope switch asks about */
  cards: Map<UnsentScope, SyncCardPlace>
  /** while the meeting stopped updating (state stale), the title of the
      task controls it turns off (stoppedTitle), else null: the cards'
      typed text stays and the Mention window still lists its people and
      sends, while an owner list, the status menu or the reviewer prompt
      open before it closes and writes nothing */
  frozen: string | null
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

/** "88% of 32 h this week", or an agent's "12 h scheduled this week"; a
    muted "…" while an organization Viewer's read of the week is on its
    way, and a muted "unknown" where it could not be read, never a 0. */
export function LoadChip({ load }: { load: SyncLoad }) {
  if (load.state === 'waiting')
    return (
      <HoverTooltip content="Loading this week's load">
        <span
          data-sync-load="waiting"
          className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-sm text-text-3"
        >
          <span aria-hidden="true" className="rounded-sm px-1.5 py-px !font-mono font-medium">
            …
          </span>
          <span className="sr-only">Loading this week's load</span>
        </span>
      </HoverTooltip>
    )
  if (load.state === 'unknown')
    return (
      <span
        data-sync-load="unknown"
        className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-sm text-text-3"
      >
        <span className="rounded-sm px-1.5 py-px font-medium">unknown</span>
        this week
      </span>
    )
  const f = load.figure
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

/* The one "since the last sync" mark. */
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
function StatusCtl({
  it,
  ctx,
  canWrite,
  offTitle,
}: {
  it: IssueVM
  ctx: PageCtx
  canWrite: boolean
  /** why the control is off */
  offTitle: string
}) {
  return (
    <span data-sync-status={it.id} className="inline-flex shrink-0">
      <FieldSelect
        aria-label={`Status of ${it.title}`}
        value={it.status}
        menuWidth={180}
        backLayer
        disabled={!canWrite}
        title={canWrite ? undefined : offTitle}
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
    owner control. An Escape in its search clears typed text first, as in
    every owner list. After that Escape, a click outside or a phone's Back
    skips it; a pick is a change made from the row, written as the prompt
    closes, which takes no history step (lib/useMobile useMenuBackLayer).
    Closing hands focus back to the owner control while the row is still on
    the page (a pick usually moves it to the reviewer's page). */
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

/** A person the Mention window may send to, by id and name. */
type Recipient = { id: string; name: string }

/* The Mention window's search box, which Escape clears before it closes
   the window (escapeClearsFirst). */
const MENTION_SEARCH = 'data-sync-mention-search'

/** The people of the Mention window, read while it is open
    (pickers.syncRecipients through P.recipientChoices), 25 a batch with
    the server's search and Load more, at most PICKER_CAPS.recipients kept;
    the chosen person `who` first, checked, whatever the batches hold, then
    the batches' rows, each once. On open it sends one pickers.canOwn check
    with the first batch, for the kept choice, else for `initial`. A kept
    choice the check finds no longer eligible goes to `onGone`, which
    clears it, says why and leaves the choice to the person, but only while
    it is still the choice, so a person picked before the answer keeps
    their pick. A check that answers once this window's list has gone,
    after its closing fade, changes nothing, as the next opening sends its
    own check. A reopening inside the fade keeps this check, under the same
    guard. `initial` is chosen (`onWho` without a press) once a batch row or
    an `eligible` answer holds them, while the person has picked no one
    (`picked`). A failed or refused check chooses nothing. The list's end
    shows only once the list for the typed text has opened, so a changed
    search never shows the older search's end. */
function MentionPeople({
  it,
  initial,
  who,
  picked,
  locked,
  onWho,
  onGone,
}: {
  it: IssueVM
  initial: string | null
  who: Recipient | null
  picked: boolean
  locked: boolean
  onWho: (person: Recipient | null, pressed: boolean) => void
  onGone: (person: Recipient) => void
}) {
  const task = { uuid: it.uuid, org: it.org }
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const query = search.settled
  const listKey = `${it.org}\n${it.uuid}\n${query}`
  const list = usePagedList<OwnerChoices, OwnerChoice>({
    key: listKey,
    source: {
      kind: 'once',
      read: (at) => P.recipientChoices({ task, search: query, cursor: at.after }),
    },
    batch: (answer) => (answer.state === 'ready' ? answer : null),
    id: (row) => row.id,
    most: PICKER_CAPS.recipients,
  })
  // the list the paged list opened, which it opens after the render that
  // names a new one, so that render never ends with an older text's end
  const opened = useRef<string | null>(null)
  useEffect(() => {
    opened.current = listKey
  })
  // the choice the window opened with, kept from before; `initial` is
  // chosen only for a window that opened without one
  const [openedWith] = useState(who)
  // the choice as it stands when the check below answers
  const whoNow = useRef(who)
  whoNow.current = who
  // the one check of the person the window opens with
  const [suggested, setSuggested] = useState<Recipient | null>(null)
  useEffect(() => {
    const id = openedWith?.id ?? initial
    if (!id) return
    // an answer after this list unmounted, once the window has faded out,
    // is an older opening's, which says nothing of the choice a later
    // opening holds
    let live = true
    void P.ownerChecks({ task, field: 'recipient', ids: [id] }).then((answer) => {
      if (!live) return
      const row = answer?.state === 'ready' ? answer.rows.find((r) => r.id === id) : undefined
      if (!row) return
      if (openedWith) {
        // a person picked since the window opened keeps their pick
        if (row.eligible || whoNow.current?.id !== openedWith.id) return
        onGone(openedWith)
      } else if (row.eligible && row.person) setSuggested(row.person)
    })
    return () => {
      live = false
    }
  }, [])
  // `initial`, once a batch or the check says they may be mentioned
  const fromBatch = initial ? list.rows.find((row) => row.id === initial) : undefined
  const offered = openedWith ? undefined : (fromBatch ?? suggested)
  useEffect(() => {
    if (offered && !picked && who === null) onWho(offered, false)
  }, [offered, picked, who])
  const rows = list.rows.filter((row) => row.id !== who?.id)
  const answered = query === search.typed && !search.tooLong && opened.current === listKey
  const end = answered ? listEnd(list, query !== '') : 'loading'
  const row = (person: Recipient, chosen: boolean) => (
    <Button
      key={person.id}
      type="button"
      variant="unstyled"
      data-sync-mention-person={person.id}
      disabled={locked}
      onClick={() => onWho(chosen ? null : person, true)}
      aria-pressed={chosen}
      className={cn(
        'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-sm border-none bg-transparent px-2 py-2 text-left text-base text-text-1 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-55',
        chosen && 'font-semibold',
      )}
    >
      <MentionFace id={person.id} />
      <span className="min-w-0 flex-1 truncate">{person.name}</span>
      {chosen && <Icon name="check" size={16} strokeWidth={2} color="var(--muted-foreground)" />}
    </Button>
  )
  return (
    <div className="mb-2 flex flex-col gap-1" data-sync-mention-people="">
      <PickerSearch text={text} onText={setText} label="Search people" probe={MENTION_SEARCH} />
      <div
        data-sync-mention-list=""
        data-picker-state={list.phase}
        aria-busy={list.phase === 'first' || list.phase === 'more' || undefined}
        className="flex max-h-[min(232px,40dvh)] flex-col overflow-y-auto"
      >
        {who && row(who, true)}
        {rows.map((person) => row(person, false))}
        {!(end === 'end' && list.rows.length > 0) && (
          <ChoiceEnd
            end={end}
            tooLong={search.tooLong}
            list={list}
            words={RECIPIENT_WORDS}
            menu={false}
          />
        )}
      </div>
    </div>
  )
}

/* A recipient's face. It is the store's portrait, or a plain square while
   the store does not hold them. */
function MentionFace({ id }: { id: string }) {
  if (P.user(id)) return <Avatar id={id} size={28} />
  return <span aria-hidden="true" className="size-7 shrink-0 rounded-[5px] bg-surface-3" />
}

/* The line for a chosen person the server says can no longer be
   mentioned. */
const goneLine = (name: string) =>
  `${firstName(name)} can no longer be mentioned on this task. Pick someone else.`

/** The @ glyph and its window: pick a person, write a line, Send. It posts
    an ordinary comment carrying the @mention, so the person gets it in the
    Inbox and the task's discussion keeps it. `initial` is the task's other
    party (the assignee on a reviewer's row, the reviewer on a waiting row),
    chosen once the server says they can be mentioned. The window lists its
    people from the server only while open (MentionPeople), and Send asks
    pickers.canOwn first and posts only when the chosen person can still be
    mentioned; otherwise nothing posts, the window unlocks with the note
    and says why. The note and the choice stay through searches, batches,
    live updates and a stale meeting, which leaves this window sending. */
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
  const [who, setWho] = useState<Recipient | null>(null)
  // whether the person pressed a row, or a check at Send or at a kept
  // note's reopening cleared their choice, since the window last opened
  // without a kept note. After that `initial` is never chosen for them.
  const [picked, setPicked] = useState(false)
  // why the last Send or the opening check posted nothing, which a kept
  // note keeps
  const [line, setLine] = useState<string | null>(null)
  // Clears a chosen person the server says can no longer be mentioned,
  // with the line that says why. The choice is then the person's to make
  // again, never `initial`'s, though no row was pressed.
  const drop = (gone: Recipient) => {
    setWho(null)
    setPicked(true)
    setLine(goneLine(gone.name))
  }
  const [text, setText] = useState('')
  // a note on its way to the server. The window locks it until the answer,
  // and after a save until the window has closed.
  const [sending, setSending] = useState(false)
  // The note stays when the window closes while it is sent, or after a
  // refusal, so reopening shows it again. A save or Cancel lets it go. A
  // kept note holds back an app update even while the window is closed.
  const [kept, setKept] = useState(false)
  useUpdateBlocker((open || kept) && text.trim() !== '')
  // a Discard throws the note away and closes the window, even while its
  // card stays on the page, hidden in a kept Team sync (components/KeptView)
  useUnsaved((open || kept) && text.trim() !== '', 'note', undefined, () => {
    setKept(false)
    setText('')
    setOpen(false)
  })
  // A note neither sent nor kept is gone once the window closes, so a close
  // asks first (DiscardPrompt), except the one Cancel or a saved note makes.
  const noteWindow = useUnsentScope()
  useUnsaved(open && !kept && text.trim() !== '', 'note', noteWindow)
  // why the next close asks nothing: the note was saved, or Cancel or a
  // Discard let it go
  const letGo = useRef<'saved' | 'dropped' | null>(null)
  const close = useMobileBackLayer(open, (again) => {
    const meant = letGo.current
    letGo.current = null
    if (!meant && noteWindow.held().length) {
      closeOrAsk([noteWindow], () => {
        letGo.current = 'dropped'
        again()
      })
      return false
    }
    setOpen(false)
    // a save unlocks the window once it has closed. Any other close while
    // the note is sent keeps the lock until the answer.
    if (meant === 'saved') setSending(false)
  })
  // the lock the window last showed, which it keeps while it fades out.
  // Handlers read `sending`.
  const locked = useClosingWords(open, sending)
  const canWrite = P.canWrite(it.project)
  const person = who
  // the note is saved as a comment, so a comment's cap holds it
  const ready = !!person && text.trim() !== '' && !overLimit(LIMITS.comment, text) && !sending
  const send = () => {
    if (!ready || !person) return
    // The press locks the window, then checks that the person can still be
    // mentioned (pickers.canOwn), and posts only on a current yes. The
    // window closes once the server saves the note. A refused one (the
    // store toasts why, such as lost access or a body over the length cap
    // once escaped), and a check that says no or could not answer, keep
    // the window open, so the note is not lost.
    setKept(true)
    setSending(true)
    setLine(null)
    const body = mentionBody(person, text)
    void P.ownerChecks({
      task: { uuid: it.uuid, org: it.org },
      field: 'recipient',
      ids: [person.id],
    }).then((answer) => {
      const row =
        answer?.state === 'ready' ? answer.rows.find((r) => r.id === person.id) : undefined
      if (!row?.eligible) {
        setSending(false)
        if (row) drop(person)
        else if (answer?.state === 'refused') setLine(sentence(answer.message))
        else if (answer?.state === 'unavailable') setLine('This task is no longer available.')
        else setLine(`Couldn't check ${firstName(person.name)}. Press Send to try again.`)
        return
      }
      void P.addComment(it.uuid, body).then((saved) => {
        if (!saved) return setSending(false)
        setKept(false)
        letGo.current = 'saved'
        close()
        onSent()
      })
    })
  }
  const cancel = () => {
    setKept(false)
    letGo.current = 'dropped'
    close()
  }
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) return close()
        // a kept note keeps its choice, whether the person made it and the
        // line that says why the last Send posted nothing, so a note meant
        // for someone the check dropped never goes to `initial`
        if (!kept) {
          setWho(null)
          setText('')
          setPicked(false)
          setLine(null)
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
        // an Escape in the search clears it first
        onEscapeKeyDown={escapeClearsFirst(MENTION_SEARCH)}
        data-sync-mention-window={it.id}
        className="z-[120] w-[min(340px,calc(100vw-32px))] rounded-lg p-3 shadow-pop"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-semibold text-text-1">Mention on</span>
          <IssueKey id={it.key} />
        </div>
        <MentionPeople
          it={it}
          initial={initial}
          who={who}
          picked={picked}
          locked={locked}
          onWho={(next, pressed) => {
            if (pressed) {
              setPicked(true)
              setLine(null)
            }
            setWho(next)
          }}
          onGone={drop}
        />
        <LimitedTextarea
          limit={LIMITS.comment}
          rows={2}
          aria-label="Note"
          placeholder="A short note…"
          readOnly={locked}
          value={text}
          onChange={(e) => setText(e.target.value)}
          wrapperClassName="mb-2"
          className="max-h-[min(48dvh,260px)] min-h-0 resize-none overflow-y-auto bg-surface-1 text-sm"
        />
        {line && (
          <p role="status" data-sync-mention-line="" className="mb-2 text-sm text-text-2">
            {line}
          </p>
        )}
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
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={cancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-sync-mention-send
            disabled={!ready || locked}
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
  /** the agenda's verdict of the row (its banner), null for none */
  verdict: SyncVerdict
  /** the keys of its open blockers the agenda names, the same array while
      they stay the same */
  blockedBy: readonly string[]
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
function SyncCardView({ it, ctx, later, verdict, blockedBy }: SyncCardProps) {
  const ownerRef = useRef<HTMLSpanElement>(null)
  // the project's level decides (the projects part holds every level a
  // card reads), and a stale meeting turns the task controls off
  const canWrite = P.canWrite(it.project)
  const editable = canWrite && ctx.frozen === null
  const offTitle = canWrite ? (ctx.frozen ?? READ_ONLY) : READ_ONLY
  const marks = rowMarks(it, {
    person: ctx.owner,
    since: ctx.since,
    verdict,
    blockedBy,
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
      it={it}
      on={ctx.reviewed.has(it.uuid)}
      onToggle={() => ctx.reviewed.toggle(it.uuid)}
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
        <DelayBanner it={it} verdict={verdict} />
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
                it={it}
                title={
                  canWrite
                    ? (ctx.frozen ?? 'Remaining hours. Leave empty for no estimate')
                    : READ_ONLY
                }
                disabled={!canWrite}
                readOnly={ctx.frozen !== null}
                onCommit={ctx.touched}
                className={cn(ctx.mobile && 'w-12', it.remaining == null && 'border-warning')}
              />
              <span className="text-sm text-text-3">h</span>
              <StatusCtl it={it} ctx={ctx} canWrite={editable} offTitle={offTitle} />
              <span ref={ownerRef} data-sync-owner={it.id} className="inline-flex shrink-0">
                <AssigneeAvatar
                  issue={it}
                  variant="chevron"
                  backLayer
                  offTitle={ctx.frozen ?? undefined}
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
        {/* a stale meeting writes nothing, so the prompt goes with it */}
        {ctx.prompt === it.id && ctx.frozen === null && (
          <ReviewerPrompt it={it} ctx={ctx} anchor={ownerRef} />
        )}
      </div>
    </UnsentScopeContext.Provider>
  )
}

/* A person's page renders every card again on each store change. A card
   renders the same while its task keeps its object (the workspace and the
   views' shaped models keep it while the task's data stays the same), with
   the same verdict and the same blockers array (the meeting keeps it while
   its keys stay the same), the same context, comment, tick and prompt, the
   same page owner and reading point, on the same day (every label it
   shows counts whole days), layout and stale state, so it skips. Its
   callbacks act the same for the same page owner: TeamSync keeps
   onOpenTask and onShowTask, and the reviewed set's mark and toggle update
   its latest state. */
export const SyncCard = memo(
  SyncCardView,
  (a, b) =>
    a.it === b.it &&
    a.verdict === b.verdict &&
    a.blockedBy === b.blockedBy &&
    a.ctx.frozen === b.ctx.frozen &&
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
