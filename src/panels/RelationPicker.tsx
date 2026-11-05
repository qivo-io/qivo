/* The task window's Parent, Subtasks and Linked tasks pickers. Each reads
   the tasks it offers from the server a batch at a time
   (taskWindow.relationCandidates, through P.relationCandidates), never
   from the workspace's tasks. The server applies ordinary access, the
   picker's scope, the write's own rules and the search, and answers the
   next 25 tasks of its order, with Load more for the next batch. The rules
   are the other pickers' (the limits plan's picker sections, by the
   coordinator's decision of 4 November 2026):

   - A typed search rests for SEARCH_DELAY_MS and starts a list with one
     read, an empty one at once, through the shared paged list
     (lib/pagedList.ts, read once). An older text's answer, and any answer
     after the picker closed, is dropped, and one read runs at a time.
     Rows clear on a new text, and "Loading tasks…" shows until its answer.
   - A list never says it found nothing or ended before the server said so
     and the window's current relations of its kind are whole, since the
     server leaves those out of its batches. A batch the server stopped
     says that Qivo checked part of the tasks and Load more goes on. The
     Linked tasks picker ends at the task's own project family, and Search
     all your projects goes on into the organization's other projects,
     which the person chooses.
   - At most PICKER_MOST rows a list (8 batches), then "Search to find more
     tasks.", which is this picker's own choice.
   - The window's own current relations of the picker's kind show first,
     from the window's lists, checked, matched in the browser by the rule
     the server matches with (lib/search.ts matchesAllWords), those the
     person can change. While the window's own removal of them waits
     (`locked`), they show without taking a press, and so does one the
     person can no longer change, as after their access changed, which
     stays checked as long as the window lists it. In Subtasks and Linked
     tasks a row that showed as current stays listed for the picker's life,
     unchecked once it leaves the window's list, so a relation taken off
     can be chosen again. It shows with its last data from the window, or
     with the server's row of it from a batch read after it left, never
     one read while it was current, which predates its relation. A task
     shows once.
   - A pick toggles its row at once and marks it busy until its write
     answers, and back if it is refused, with the store's toast. The row
     keeps what the person now sees, its parent or its link, for the next
     press, also across a new text, until the window's lists or the
     server's row of it show its relation changed since the press. Then the
     row shows them, so a change someone else made meanwhile, such as a
     link they took off, is not pressed over as if it were not there.
   - Enter picks or creates only when the rows answer the typed text, the
     window's current relations are whole and the list has ended, or in
     Linked tasks reached the family's end, where the create row shows
     beside Search all your projects. One row on screen picks it, none
     creates. A text that is exactly one task ID picks the row the server
     found by its number (`exact`), whatever the list's end. An Enter
     pressed while the answer for the typed text is on its way acts once
     it arrives.

   Every write takes the task as the window shows it (held, or from the
   window's own answer), and a candidate as the server's row showed it,
   with what the person saw as the expected values. */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { LIMITS, type Limit } from '../../convex/lib/limits'
import type {
  RelationBlock,
  RelationCandidate,
  RelationCandidates,
  RelationKind,
} from '../../convex/lib/relationPicker'
import { issueKey } from '../../convex/lib/taskRefs'
import { AnchoredPop, Icon, IssueKey } from '../components/qivo'
import { sentence as asSentence, limitSentence, overLimit } from '../lib/fieldLimits'
import { useFocusWhenGone } from '../lib/focusWhenGone'
import { type ListBatch, listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { parentBlock, subtaskBlock } from '../lib/relationCandidates'
import { matchesAllWords } from '../lib/search'
import { linkBlock } from '../lib/taskCaps'
import { P, type RelatedTaskVM } from '../store/planner'

/** The most rows a picker's list holds; past it, it asks for a search. The
    API access person filter holds 500 (PEOPLE_MOST); a task picker is
    narrowed by typing sooner. */
export const PICKER_MOST = 200

/* In a picker, where its create row would be: why a query too long to
   name the new record creates nothing. */
export function PickerRefusal({ limit }: { limit: Limit }) {
  return (
    <p data-picker-refusal role="status" className="px-2 py-1.5 text-sm text-danger">
      {limitSentence(limit)}
    </p>
  )
}

/** A task of the window's own lists of the picker's relation: the Parent
    row, a Subtasks row, or a Linked tasks row with its relation as seen
    from the window's task. A Subtasks row the workspace does not hold
    carries `row`, its short row as a picker's row without a parent, which
    a press that makes it a subtask again sends. `locked` marks one the
    person cannot change, which the picker lists, checked and without
    taking a press, only once it listed it as one they could, as after
    their access changed while it is open. */
export type CurrentRelation = RelatedTaskVM & {
  type?: string
  row?: RelationCandidate
  locked?: boolean
}

/** The window's current relations of the picker's kind, every one its
    list holds, which show first, a note while that list is not whole, and
    `locked` while the window's own removal of them waits, so they show
    without taking a press. */
export type CurrentRelations = {
  rows: readonly CurrentRelation[]
  note: string | null
  locked?: boolean
}

/** One row of the picker: a current relation from the window, a task of
    the server's batch, or a row that showed as current and has left the
    window's list since (its `candidate` the server's row of it from a
    batch read since, else the row it was shown with, if any). */
type Choice = {
  uuid: string
  key: string
  title: string
  current?: CurrentRelation
  candidate?: RelationCandidate
  locked?: boolean
}

/** What the person now sees of a row whose relation a pick changed: on or
    off, busy while its write is on its way, and the values the next press
    sends as expected, the row's parent pair or its link. */
type Seen = {
  on: boolean
  busy: boolean
  parent?: { id: string | null; hidden: boolean }
  link?: string | null
}

/** A row's pick as the picker keeps it, with what the row now shows and
    `basis`, what the window's lists and the server's row showed of its
    relation when the person pressed. */
type Kept = { now: Seen; basis: Seen }

/* Whether `a` and `b` show the same relation. */
const sameSeen = (a: Seen, b: Seen) =>
  a.on === b.on &&
  (a.parent?.id ?? null) === (b.parent?.id ?? null) &&
  !!a.parent?.hidden === !!b.parent?.hidden &&
  (a.link ?? null) === (b.link ?? null)

/** The window's sentence for the opened task's own block of the picker's
    kind, as its buttons' tooltips word it. */
function blockSentence(kind: RelationKind, block: RelationBlock): string {
  if (block === 'has_subtasks')
    return parentBlock({ id: '', org: '', project: '', hasHiddenSubtasks: true }) ?? ''
  if (block === 'is_subtask')
    return subtaskBlock({ id: '', org: '', project: '', parent: 'x' }) ?? ''
  if (kind === 'link') return linkBlock(Array.from({ length: LIMITS.links.max })) ?? ''
  return (
    subtaskBlock({
      id: '',
      org: '',
      project: '',
      children: Array.from({ length: LIMITS.subtasks.max }, (_, n) => String(n)),
    }) ?? ''
  )
}

/* The batch an answer holds, with Search all your projects as the cursor
   after the family's end. Null for an answer that lists nothing, a block,
   unavailable, refused or over budget, which the picker words. */
const batchOf = (answer: RelationCandidates): ListBatch<RelationCandidate> | null =>
  answer.state === 'ok' && answer.blocked === null
    ? { rows: answer.rows, next: answer.next ?? answer.all_projects, stopped: answer.stopped }
    : null

/** The sentence of an answer that lists nothing, with its state marker. */
function answerNote(
  kind: RelationKind,
  answer: RelationCandidates,
): { state: string; text: string; block?: RelationBlock } | null {
  if (answer.state === 'ok')
    return answer.blocked
      ? { state: 'ready', text: blockSentence(kind, answer.blocked), block: answer.blocked }
      : null
  if (answer.state === 'unavailable')
    return {
      state: 'unavailable',
      text: answer.message ? asSentence(answer.message) : 'Qivo cannot list tasks for this task.',
    }
  if (answer.state === 'refused') return { state: 'refused', text: asSentence(answer.message) }
  return {
    state: 'over_budget',
    text: "Qivo could not list tasks here within the picker's limits.",
  }
}

/** The task window's relation picker of `kind` for task `task`, anchored
    at `anchor`. `current` are the window's own relations of the kind,
    `toggle` makes or undoes one pick with what the row now shows and
    resolves whether the server accepted it, and `onCreate`, when the
    picker may create, creates a task titled by the search. `single`
    closes the picker after one pick (Parent). `header` sits in the search
    row (the link type). */
export function RelationPicker({
  kind,
  task,
  anchor,
  onDone,
  placeholder,
  current,
  toggle,
  seenOf,
  single,
  createLabel,
  onCreate,
  header,
  linkKind,
}: {
  kind: RelationKind
  /** the window's task, with the project it stands in, which names the
      list, so a task that moves reads its list again from the start, as
      the server refuses a cursor read before the move */
  task: { uuid: string; org: string; project: string }
  anchor: { x: number; y: number }
  onDone: () => void
  placeholder: string
  current: CurrentRelations
  /** sends the pick of `choice`: `on` the relation the person chose, and
      `seen` what the row showed before, as the expected values */
  toggle: (
    choice: { uuid: string; candidate?: RelationCandidate },
    on: boolean,
    seen: Seen,
  ) => Promise<boolean> | boolean
  /** what a row shows before any pick of it in this picker */
  seenOf: (choice: { current?: CurrentRelation; candidate?: RelationCandidate }) => Seen
  single?: boolean
  createLabel: string
  onCreate?: (title: string) => void
  header?: React.ReactNode
  /** the relation a link pick makes, as seen from the window's task */
  linkKind?: string
}) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const query = search.settled
  const typed = search.typed
  const listKey = `${task.org}\n${task.uuid}\n${task.project}\n${kind}\n${query}`
  const list = usePagedList<RelationCandidates, RelationCandidate>({
    key: listKey,
    source: {
      kind: 'once',
      read: (at) => P.relationCandidates({ task, kind, search: query, cursor: at.after }),
    },
    batch: batchOf,
    id: (row) => row.id,
    most: PICKER_MOST,
  })
  // what each row shows after a pick, kept for the picker's life, so an
  // answer for a later text never undoes a row whose write is on its way
  const [seen, setSeen] = useState<ReadonlyMap<string, Kept>>(new Map())
  const searchBox = useRef<HTMLInputElement>(null)
  const ql = typed.toLowerCase()
  const matches = (key: string, title: string) => !ql || matchesAllWords(`${key}\n${title}`, ql)

  // the list the paged list opened, which it opens after the render that
  // names a new one, so that render never takes an older text's rows as
  // this text's answer
  const opened = useRef<string | null>(null)
  useEffect(() => {
    opened.current = listKey
  })
  // the rows of this text: the window's current relations first, then the
  // rows that showed as current and left the window's list since, then the
  // server's batches, each task once
  const answered =
    !search.tooLong && query === typed && opened.current === listKey && list.phase !== 'first'
  // every row that showed as current, with its last data, for the
  // picker's life, so one taken off stays listed and can be pressed again;
  // a picker that closes after one pick (Parent) keeps none
  const wasCurrent = useRef(new Map<string, CurrentRelation>())
  // the server's rows that showed while their task was current. The server
  // leaves current relations out of its batches, so such a row was read
  // before the relation the window showed, and its parent is older
  const readBefore = useRef(new WeakSet<RelationCandidate>())
  // the server's rows only for the text they answer, so a new text's rows
  // start empty until its answer arrives
  const served = answered ? list.rows : []
  // a current relation the person cannot change lists only once it showed
  // as one they could, and then stays current, checked and locked, as
  // long as the window lists it, rather than show as taken off
  const listed = (row: CurrentRelation) => !row.locked || wasCurrent.current.has(row.uuid)
  if (!single)
    for (const row of current.rows) {
      if (!listed(row)) continue
      wasCurrent.current.set(row.uuid, row)
      const old = served.find((r) => r.id === row.uuid)
      if (old) readBefore.current.add(old)
    }
  // the server's row of a task that showed as current, from a batch read
  // since it showed, if any
  const servedSince = (uuid: string) =>
    served.find((r) => r.id === uuid && !readBefore.current.has(r))
  const shownIds = new Set<string>()
  const choices: Choice[] = []
  for (const row of current.rows) {
    const key = issueKey(row.num)
    if (shownIds.has(row.uuid)) continue
    // a relation the picker does not list is still current, so no other
    // source lists it as one to make
    if (!listed(row)) shownIds.add(row.uuid)
    if (!listed(row) || !matches(key, row.title)) continue
    shownIds.add(row.uuid)
    const locked = !!current.locked || !!row.locked
    choices.push({ uuid: row.uuid, key, title: row.title, current: row, locked })
  }
  for (const row of wasCurrent.current.values()) {
    const key = issueKey(row.num)
    if (shownIds.has(row.uuid) || !matches(key, row.title)) continue
    shownIds.add(row.uuid)
    // the server's row of it where a batch read since holds it, else the
    // row it showed with
    const fresh = servedSince(row.uuid)
    choices.push({
      uuid: row.uuid,
      key: fresh ? issueKey(fresh.num) : key,
      title: fresh?.title ?? row.title,
      candidate: fresh ?? row.row,
    })
  }
  for (const row of served) {
    if (shownIds.has(row.id)) continue
    shownIds.add(row.id)
    choices.push({ uuid: row.id, key: issueKey(row.num), title: row.title, candidate: row })
  }
  // what the window's lists and the server's rows show of a row's
  // relation now, whatever the text, as the rows above compose it, or
  // undefined for a row the picker knows nothing of now
  const liveOf = (uuid: string): Seen | undefined => {
    const now = current.rows.find((row) => row.uuid === uuid)
    if (now) return seenOf({ current: now })
    const was = wasCurrent.current.get(uuid)
    if (was) return seenOf({ candidate: servedSince(uuid) ?? was.row })
    const fresh = served.find((row) => row.id === uuid)
    return fresh ? seenOf({ candidate: fresh }) : undefined
  }
  // a settled pick shows until the window's lists or the server's row show
  // its relation otherwise than when the person pressed; then they show,
  // and the pick is dropped. A pick whose write is on its way always shows
  const stale = new Set<string>()
  for (const [uuid, kept] of seen) {
    if (kept.now.busy) continue
    const live = liveOf(uuid)
    if (live && !sameSeen(live, kept.basis)) stale.add(uuid)
  }
  useEffect(() => {
    if (stale.size === 0) return
    setSeen((m) => {
      const next = new Map(m)
      for (const uuid of stale) if (!next.get(uuid)?.now.busy) next.delete(uuid)
      return next
    })
  })
  const seenNow = (choice: Choice): Seen => {
    const kept = seen.get(choice.uuid)
    return kept && !stale.has(choice.uuid) ? kept.now : seenOf(choice)
  }

  // what the list says, from its first answer that lists nothing, a later
  // one that failed it, or its end
  const first = list.answers[0]
  const held = answered && list.phase === 'held' && first ? answerNote(kind, first) : null
  const failedWith = answered && list.failure ? answerNote(kind, list.failure) : null
  const end = search.tooLong ? 'too_long' : answered ? listEnd(list, query !== '') : 'loading'
  const last = list.answers[list.answers.length - 1]
  // the family's end of the Linked tasks picker, where the person chooses
  // to go on into the organization's other projects
  const allNext =
    end === 'more' && last?.state === 'ok' && last.next === null && last.all_projects !== null
  // whether the window's current relations are whole, which the server
  // leaves out of its batches, so until then no list ends or says it found
  // nothing
  const whole = current.note === null
  const ended = answered && whole && list.phase === 'ready' && !list.next
  // where Enter picks or creates: the list's end, or the family's end of
  // Linked tasks, as the create row beside Search all your projects does
  const enterEnds = ended || (answered && whole && list.phase === 'ready' && allNext)
  const state = search.tooLong
    ? 'ready'
    : !answered
      ? 'loading'
      : held
        ? held.state
        : list.phase === 'failed'
          ? (failedWith?.state ?? 'failed')
          : list.phase === 'more'
            ? 'more'
            : 'ready'
  // a block or a refusal lists nothing to create beside
  const blocked = !!held
  const createOn =
    !!onCreate &&
    !!typed &&
    !blocked &&
    (search.tooLong || answered) &&
    !choices.some((c) => c.title.trim().toLowerCase() === ql)
  const titleTooLong = overLimit(LIMITS.title, text)

  const pick = (choice: Choice) => {
    const before = seenNow(choice)
    if (before.busy || choice.locked) return
    const on = !before.on
    // the relation as the window's lists and the server's row show it now
    const basis = liveOf(choice.uuid) ?? seenOf(choice)
    setSeen((m) => new Map(m).set(choice.uuid, { now: { ...before, on, busy: true }, basis }))
    const settle = (ok: boolean) => {
      setSeen((m) => {
        const kept = new Map(m)
        if (!ok) kept.set(choice.uuid, { now: { ...before, busy: false }, basis })
        else
          kept.set(choice.uuid, {
            now: {
              on,
              busy: false,
              parent: on ? { id: task.uuid, hidden: false } : { id: null, hidden: false },
              link: on ? (linkKind ?? null) : null,
            },
            basis,
          })
        return kept
      })
    }
    const sent = toggle(choice, on, before)
    if (single) onDone()
    if (typeof sent === 'boolean') settle(sent)
    else void sent.then(settle)
  }
  const create = () => {
    // a paused create keeps the typed title and the picker open
    if (titleTooLong || P.refusePausedEdit()) return
    onCreate?.(typed)
    if (single) onDone()
    else setText('')
  }
  // Enter for a text whose answer is on its way acts once it arrives
  const enterFor = useRef<string | null>(null)
  const onEnter = () => {
    const exact = choices.find((c) => c.candidate?.exact)
    if (answered && exact) return pick(exact)
    if (!enterEnds || !typed) return
    if (choices.length === 1) pick(choices[0])
    else if (choices.length === 0 && createOn) create()
  }
  useEffect(() => {
    if (enterFor.current === null) return
    if (enterFor.current !== typed) {
      enterFor.current = null
      return
    }
    if (!answered || list.phase === 'more') return
    enterFor.current = null
    onEnter()
  })

  // Load more keeps focus while it reads; once it leaves, focus goes back
  // to the search box
  useFocusWhenGone(end === 'more', () => searchBox.current)
  const more = () => {
    if (list.phase === 'more') return
    list.more()
  }

  const rowClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-text-1 hover:bg-hover'
  const noteClass = 'px-[5px] py-1 text-sm text-text-3'
  const empty = choices.length === 0
  return (
    <AnchoredPop
      x={anchor.x}
      y={anchor.y}
      width={Math.min(340, window.innerWidth - 24)}
      onClose={onDone}
    >
      <div
        data-relation-picker={kind}
        data-picker-state={state}
        {...(held?.block ? { 'data-picker-blocked': held.block } : {})}
        {...(ended ? { 'data-picker-end': '' } : {})}
        aria-busy={state === 'loading' || state === 'more' || undefined}
      >
        {/* unruled like the label pop (deviation #65) */}
        <div className="[display:flex] [align-items:center] [gap:8px] [padding:10px_12px_8px]">
          {header}
          <Input
            ref={searchBox}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              if (answered) onEnter()
              else enterFor.current = typed
            }}
            placeholder={placeholder}
            className="[flex:1] [min-width:0] [background:transparent] [border:none] [outline:none] [color:var(--text-1)] [font-size:var(--fs-base)] [font-family:var(--sans)] [padding:0]"
          />
        </div>
        <div className="[display:flex] [flex-direction:column] [gap:2px] [max-height:260px] [overflow-y:auto] [padding:5px]">
          {current.note && <p className={noteClass}>{current.note}</p>}
          {choices.map((choice) => {
            const now = seenNow(choice)
            return (
              <Button
                type="button"
                key={choice.uuid}
                data-picker-row={choice.uuid}
                {...(choice.current ? { 'data-picker-current': '' } : {})}
                {...(now.busy ? { 'data-picker-busy': '' } : {})}
                disabled={choice.locked}
                aria-busy={now.busy || undefined}
                aria-pressed={now.on}
                onClick={() => pick(choice)}
                className={cn(
                  rowClass,
                  now.on && 'font-semibold',
                  (now.busy || choice.locked) && 'opacity-60',
                  choice.locked && 'cursor-default',
                )}
                variant="unstyled"
              >
                <IssueKey id={choice.key} />
                <span className="[flex:1] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                  {choice.title}
                </span>
                {now.on && (
                  <Icon name="check" size={16} strokeWidth={2} color="var(--muted-foreground)" />
                )}
              </Button>
            )
          })}
          {search.tooLong ? (
            <p className="px-[5px] py-1 text-sm text-danger">{limitSentence(LIMITS.search)}</p>
          ) : end === 'loading' ? (
            <p role="status" className={noteClass}>
              Loading tasks…
            </p>
          ) : held ? (
            <p role="status" data-picker-note={held.state} className={noteClass}>
              {held.text}
            </p>
          ) : end === 'failed' ? (
            failedWith ? (
              <p role="status" data-picker-note={failedWith.state} className={noteClass}>
                {failedWith.text}
              </p>
            ) : (
              <div
                role="alert"
                data-picker-failed=""
                className="flex flex-wrap items-center gap-2 px-[5px] py-1 text-sm text-danger"
              >
                {list.rows.length === 0 ? "Couldn't load tasks." : "Couldn't load more tasks."}
                <Button
                  type="button"
                  variant="ghost"
                  className="h-control-sm text-sm"
                  onClick={() => list.retry()}
                >
                  Retry
                </Button>
              </div>
            )
          ) : end === 'full' ? (
            <p className={noteClass}>Search to find more tasks.</p>
          ) : end === 'more' ? (
            <div className="flex flex-col items-start gap-1">
              {list.stopped && (
                <p data-picker-stopped="" className={noteClass}>
                  Qivo checked part of the tasks. Load more continues.
                </p>
              )}
              {allNext && whole && !list.stopped && empty && query !== '' && (
                <p className={noteClass}>No matching tasks in this project.</p>
              )}
              <Button
                type="button"
                variant="ghost"
                {...(allNext ? { 'data-picker-all': '' } : { 'data-picker-more': '' })}
                aria-disabled={list.phase === 'more' || undefined}
                onClick={more}
                className="h-control-sm text-sm"
              >
                {list.phase === 'more'
                  ? 'Loading…'
                  : allNext
                    ? 'Search all your projects'
                    : 'Load more'}
              </Button>
            </div>
          ) : end === 'none' || end === 'end' ? (
            // while the current relations are not whole, their note above
            // says why the list claims nothing
            empty && whole ? (
              <p className={noteClass}>{query ? 'No matching tasks.' : 'No eligible tasks.'}</p>
            ) : null
          ) : null}
          {createOn && titleTooLong && <PickerRefusal limit={LIMITS.title} />}
          {createOn && !titleTooLong && (
            <Button
              type="button"
              data-picker-create=""
              onClick={create}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 pb-1.5 pt-2 text-left text-base text-text-1 hover:bg-hover ${empty ? '' : 'mt-1.5'}`}
              variant="unstyled"
            >
              <Icon name="plus" size={13} color="var(--text-2)" />
              <span className="[font-weight:600]">{createLabel}</span>
              <span className="[color:var(--text-3)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                “{typed}”
              </span>
            </Button>
          )}
        </div>
      </div>
    </AnchoredPop>
  )
}
