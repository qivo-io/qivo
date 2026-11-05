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
   - A list never says it found nothing or ended before the server said so.
     A batch the server stopped says that Qivo checked part of the tasks
     and Load more goes on. The Linked tasks picker ends at the task's own
     project family, and Search all your projects goes on into the
     organization's other projects, which the person chooses.
   - At most PICKER_MOST rows a list (8 batches), then "Search to find more
     tasks.", which is this picker's own choice.
   - The window's own current parent, subtasks and links show first, from
     the window's lists, checked, matched in the browser by the rule the
     server matches with (lib/search.ts matchesAllWords), since the server
     leaves them out of its batches. A task shows once.
   - A pick toggles its row at once and marks it busy until its write
     answers, and back if it is refused, with the store's toast. The row
     keeps what the person now sees, its parent or its link, for the next
     press, also across a new text.
   - Enter picks or creates only when the rows answer the typed text and
     the list has ended. One row on screen picks it, none creates. A text
     that is exactly one task ID picks the row the server found by its
     number (`exact`), whatever the list's end. An Enter pressed while the
     answer for the typed text is on its way acts once it arrives.

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
    row, a Subtasks row the person can change, or a Linked tasks row with
    its relation as seen from the window's task. */
export type CurrentRelation = RelatedTaskVM & { type?: string }

/** The window's current relations of the picker's kind, which show first,
    and a note while the list they come from is not whole. */
export type CurrentRelations = { rows: readonly CurrentRelation[]; note: string | null }

/** One row of the picker: a current relation from the window, or a task
    of the server's batch. */
type Choice = {
  uuid: string
  key: string
  title: string
  current?: CurrentRelation
  candidate?: RelationCandidate
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
  const [seen, setSeen] = useState<ReadonlyMap<string, Seen>>(new Map())
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
  // server's batches, each task once
  const answered =
    !search.tooLong && query === typed && opened.current === listKey && list.phase !== 'first'
  const shownIds = new Set<string>()
  const choices: Choice[] = []
  for (const row of current.rows) {
    const key = issueKey(row.num)
    if (shownIds.has(row.uuid) || !matches(key, row.title)) continue
    shownIds.add(row.uuid)
    choices.push({ uuid: row.uuid, key, title: row.title, current: row })
  }
  // the server's rows only for the text they answer, so a new text's rows
  // start empty until its answer arrives
  if (answered)
    for (const row of list.rows) {
      if (shownIds.has(row.id)) continue
      shownIds.add(row.id)
      choices.push({ uuid: row.id, key: issueKey(row.num), title: row.title, candidate: row })
    }
  const seenNow = (choice: Choice): Seen => seen.get(choice.uuid) ?? seenOf(choice)

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
  const ended = answered && list.phase === 'ready' && !list.next
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
    if (before.busy) return
    const on = !before.on
    setSeen((m) => new Map(m).set(choice.uuid, { ...before, on, busy: true }))
    const settle = (ok: boolean) => {
      setSeen((m) => {
        const now = new Map(m)
        if (!ok) now.set(choice.uuid, { ...before, busy: false })
        else
          now.set(choice.uuid, {
            on,
            busy: false,
            parent: on ? { id: task.uuid, hidden: false } : { id: null, hidden: false },
            link: on ? (linkKind ?? null) : null,
          })
        return now
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
    if (!ended || !typed) return
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
                aria-busy={now.busy || undefined}
                aria-pressed={now.on}
                onClick={() => pick(choice)}
                className={cn(rowClass, now.on && 'font-semibold', now.busy && 'opacity-60')}
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
              {allNext && !list.stopped && empty && query !== '' && (
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
            empty ? (
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
