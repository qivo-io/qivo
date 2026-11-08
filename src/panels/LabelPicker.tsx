/* The task window's label picker and the labels its Labels section shows.

   The picker reads the labels it offers from the server a batch at a time
   (labels.picker, through P.labelChoices), as the store holds no label, on
   the rules the window's other pickers follow
   (panels/RelationPicker.tsx, the coordinator's decisions of 4 and 6
   November 2026):

   - A typed search rests for SEARCH_DELAY_MS and starts a list with one
     read, an empty one at once, through the shared paged list
     (lib/pagedList.ts, read once). The server searches every label of the
     task's organization, each word in any order, ignoring case and
     accents, and answers 25 in name order, with Load more for the next
     25, at most PICKER_CAPS.labels kept. An older text's answer, and any
     after the picker closed, is dropped, and one read runs at a time.
   - The task's own labels show first, checked and removable, matched by
     the server's rule (convex/lib/search.ts over convex/lib/nameKey.ts),
     whether or not a loaded batch holds them; one whose name has not
     loaded yet shows under an empty search only. Then the server's
     labels, each once, the server's `exact` label first when no other row
     shows it. A label whose toggle the server refused because it no
     longer exists (P.labelGone) leaves the server's rows.
   - Create new label shows only once the answer for exactly the typed
     name has arrived and says no label of that name exists in any case
     (`exact` null) and the person may create labels (`can_create`), in
     the home organization, on a task that is not full. A check that could
     not finish says so in its place (LABEL_RIGHTS_UNCHECKED). After a
     failed read of the typed name it shows too, as Settings › Labels'
     Add stays on then, and the server refuses a name another label holds
     or a person who may not create labels. The new label takes its color
     from its id (P.addLabel) and its chip shows its name at once
     (keepNamed).
   - Enter acts only on the answer for the typed text: it picks `exact`
     once that answer is in, and otherwise, once the list has ended
     without a stop, picks the one row shown, or creates when no row shows
     and Create new label does. An Enter pressed while the answer is on
     its way acts once it arrives. An empty field's Enter does nothing.
   - At the cap on a task's labels (LIMITS.labels) a label off the task is
     disabled with the cap's sentence, and the task's labels still come
     off.

   The window's Labels section and the picker name the task's labels
   through useTaskLabels (taskLabels.ts): the workspace's label when it
   holds it, else from labels.byIds, so a label not loaded shows as
   loading, never as taken off, and only the server's answer hides one as
   deleted. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { LABEL_RIGHTS_UNCHECKED, LIMITS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import { ChoiceEnd } from '../components/pickerParts'
import { LABEL_WORDS } from '../components/pickerWords'
import { AnchoredPop, Icon } from '../components/qivo'
import { overLimit, sentence } from '../lib/fieldLimits'
import { restoreFocus } from '../lib/focusVisibility'
import { type ListEnd, listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { PICKER_CAPS } from '../lib/pickerCaps'
import { labelBlock } from '../lib/taskCaps'
import { type IssueVM, type LabelChoice, type LabelChoices, P } from '../store/planner'
import { PickerRefusal } from './RelationPicker'
import { keepNamed, useTaskLabels } from './taskLabels'

/* -------------------------------------------------------------- the picker */

/** One row of the picker: a label of the task (`current`), or one of the
    server's; a task label without a name yet has none. */
type PickRow = {
  id: string
  name: string | null
  color: string | null
  current: boolean
  failed?: boolean
}

/**
 * The task label picker for task `it`, anchored at `anchor`, on the rules
 * in the module header. It stays open for several picks and closes on
 * Escape or a press outside (AnchoredPop).
 */
export function LabelPickerPopup({
  it,
  anchor,
  onDone,
}: {
  it: IssueVM
  anchor: { x: number; y: number }
  onDone: () => void
}) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const typed = search.typed
  const query = search.settled
  const listKey = `${it.org}\n${query}`
  const list = usePagedList<LabelChoices, LabelChoice>({
    key: listKey,
    source: {
      kind: 'once',
      read: (at) => P.labelChoices({ org: it.org, search: query, cursor: at.after }),
    },
    batch: (answer) => (answer.state === 'ready' ? answer : null),
    id: (row) => row.id,
    most: PICKER_CAPS.labels,
  })
  const own = useTaskLabels(it)
  const box = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)

  // the list the paged list opened, which it opens after the render that
  // names a new one, so that render never takes an older text's rows as
  // this text's answer
  const opened = useRef<string | null>(null)
  useEffect(() => {
    opened.current = listKey
  })
  const answered =
    !search.tooLong && query === typed && opened.current === listKey && list.phase !== 'first'
  const first = answered ? list.answers[0] : undefined
  const ready = first?.state === 'ready' ? first : undefined
  const served = answered ? list.rows : []

  // the task's labels that match the typed text first, then the server's
  // rows, each label once, `exact` first among them
  const onTask = new Set(it.labels ?? [])
  const matches = allWordsMatcher(nameKey(typed))
  const servedById = new Map(served.map((row) => [row.id, row]))
  const rows: PickRow[] = []
  const shown = new Set<string>()
  for (const label of own.labels) {
    if (label.state === 'gone') continue
    const name = label.state === 'ok' ? label : servedById.get(label.id)
    if (name ? !matches(nameKey(name.name)) : typed !== '') continue
    shown.add(label.id)
    rows.push({
      id: label.id,
      name: name?.name ?? null,
      color: name?.color ?? null,
      current: true,
      failed: label.state === 'failed',
    })
  }
  const exact = ready?.exact ?? null
  // the ids shown at their place in the server's order, where the rows of
  // a Load more's batch begin; a task label and `exact` show above them
  const inOrder = new Set<string>()
  for (const row of exact ? [exact, ...served] : served) {
    // a label a toggle found deleted since its batch was read goes
    if (shown.has(row.id) || P.labelGone(row.id)) continue
    shown.add(row.id)
    if (row !== exact) inOrder.add(row.id)
    rows.push({ id: row.id, name: row.name, color: row.color, current: false })
  }

  // the cap on a task's labels: a full task only takes labels off
  const full = labelBlock(it.labels ?? [])
  // creating one lands in the home organization, so it is offered only
  // there, and only from the answer for the typed name
  // a failed read of the typed name offers the create too, and the server
  // decides, as Settings › Labels does
  const readFailed = answered && !ready && list.phase === 'failed' && list.answers.length === 0
  const mayCreate =
    typed !== '' &&
    !full &&
    it.org === P.homeOrg &&
    ((!!ready && ready.exact === null) || readFailed)
  const createOn = mayCreate && (readFailed || ready?.can_create === true)
  const unchecked = mayCreate && !readFailed && ready?.can_create === null
  const nameTooLong = overLimit(LIMITS.labelName, typed)
  const end: ListEnd = answered ? listEnd(list, query !== '') : 'loading'
  const ended = end === 'end' || end === 'none'

  const pick = (row: PickRow) => {
    if (!onTask.has(row.id) && full) return
    if (row.name !== null && row.color !== null)
      keepNamed(it.org, { id: row.id, name: row.name, color: row.color })
    P.toggleIssueLabel(it.id, row.id)
  }
  const create = () => {
    // A paused create keeps the typed name in the search field, and a
    // refused one puts it back when the field is still empty. The field
    // clears at once otherwise, so a second Enter cannot create it twice.
    if (nameTooLong) return
    const name = typed
    const made = P.addLabel({ name })
    if (!made) return
    // its chip names it at once, as the store holds no label to name it,
    // also while the create is on its way
    keepNamed(it.org, { id: made.id, name: name.trim(), color: made.color }, made.saved)
    if (!onTask.has(made.id)) P.toggleIssueLabel(it.id, made.id, made.saved)
    setText('')
    void made.saved.then((saved) => {
      if (!saved) setText((now) => now || name)
    })
  }
  // Enter picks `exact` once its answer is in, else the one row or a new
  // label once the list for the typed text has ended. It clears the field,
  // so a second Enter in the empty field does nothing.
  const onEnter = () => {
    if (!typed || !answered) return
    const exactRow = exact ? rows.find((row) => row.id === exact.id) : undefined
    const chosen = exactRow ?? (ended && rows.length === 1 ? rows[0] : undefined)
    if (chosen) {
      if (!onTask.has(chosen.id) && full) return
      pick(chosen)
      setText('')
    } else if (ended && rows.length === 0 && createOn) create()
  }
  // Enter for a text whose answer is on its way acts once it arrives
  const enterFor = useRef<string | null>(null)
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

  // Load more keeps focus while it reads; once its batch lands, focus on
  // it, or nowhere, moves to the first row of the batch that shows in the
  // server's order, not one shown above (a task label or `exact`), else
  // to the search box
  const from = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (from.current === null || list.phase === 'more') return
    const at = from.current
    from.current = null
    const active = document.activeElement
    const onMore = active instanceof HTMLElement && active.matches('[data-picker-more]')
    if (!onMore && active && active !== document.body && active.isConnected) return
    const row =
      list.phase === 'ready' ? list.rows.slice(at).find((r) => inOrder.has(r.id)) : undefined
    const target = row
      ? [...(box.current?.querySelectorAll<HTMLElement>('[data-label-option]') ?? [])].find(
          (option) => option.dataset.labelOption === row.id,
        )
      : undefined
    restoreFocus(target ?? searchBox.current)
  })
  const more = () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }

  const state = search.tooLong
    ? 'ready'
    : !answered
      ? 'loading'
      : list.phase === 'held' || list.phase === 'failed' || list.phase === 'more'
        ? list.phase
        : 'ready'
  const rowClass =
    'flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-text-1 hover:bg-hover'
  const noteClass = 'text-sm text-text-3 [padding:4px_5px]'
  return (
    <AnchoredPop
      x={anchor.x}
      y={anchor.y}
      width={Math.min(300, window.innerWidth - 24)}
      onClose={onDone}
    >
      <div
        ref={box}
        data-label-picker=""
        data-picker-state={state}
        {...(answered && ended ? { 'data-picker-end': '' } : {})}
        aria-busy={state === 'loading' || state === 'more' || undefined}
      >
        {/* no rule under the search row (deviation #65): the pop is the
            task view's own, so it loses its hairlines with the window */}
        <div className="[display:flex] [align-items:center] [gap:8px] [padding:10px_12px_8px]">
          <Input
            ref={searchBox}
            autoFocus
            value={text}
            aria-label="Search labels"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !typed) return
              if (answered) onEnter()
              else enterFor.current = typed
            }}
            placeholder="Add labels…"
            className="[flex:1] [min-width:0] [background:transparent] [border:none] [outline:none] [color:var(--text-1)] [font-size:var(--fs-base)] [font-family:var(--sans)] [padding:0]"
          />
        </div>
        <div className="[display:flex] [flex-direction:column] [gap:2px] [max-height:240px] [overflow-y:auto] [padding:5px]">
          {rows.map((row) => {
            const on = onTask.has(row.id)
            const blocked = !on && !!full
            return (
              <Button
                type="button"
                key={row.id}
                data-label-option={row.id}
                {...(row.current ? { 'data-label-current': '' } : {})}
                aria-pressed={on}
                disabled={blocked}
                title={blocked ? full : undefined}
                onClick={() => pick(row)}
                className={cn(
                  rowClass,
                  on && 'font-semibold',
                  blocked && 'cursor-not-allowed opacity-50',
                )}
                variant="unstyled"
              >
                <span
                  style={row.color ? { background: row.color } : undefined}
                  className="[width:9px] [height:9px] [border-radius:50%] [flex-shrink:0] bg-text-3"
                />
                <span
                  className={cn(
                    '[flex:1] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]',
                    row.name === null && 'text-text-3',
                  )}
                >
                  {row.name ?? (row.failed ? "Couldn't load this label" : 'Loading label…')}
                </span>
                {on && (
                  <Icon name="check" size={16} strokeWidth={2} color="var(--muted-foreground)" />
                )}
              </Button>
            )
          })}
          {/* the list's end; that nothing is there only shows without a row */}
          {!(ended && rows.length > 0) && (
            <ChoiceEnd
              end={end}
              tooLong={search.tooLong}
              list={list}
              words={LABEL_WORDS}
              menu={false}
              onMore={more}
            />
          )}
          {full && <div className={noteClass}>{full}</div>}
          {createOn && nameTooLong && <PickerRefusal limit={LIMITS.labelName} />}
          {createOn && !nameTooLong && (
            <Button
              type="button"
              data-label-create=""
              onClick={create}
              className={cn(rowClass, 'pb-1.5 pt-2', rows.length > 0 && 'mt-1.5')}
              variant="unstyled"
            >
              <Icon name="plus" size={13} color="var(--text-2)" />
              <span className="[font-weight:600]">Create new label:</span>
              <span className="[color:var(--text-3)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                “{typed}”
              </span>
            </Button>
          )}
          {unchecked && (
            <p data-label-create-unchecked="" role="status" className={noteClass}>
              {sentence(LABEL_RIGHTS_UNCHECKED)}
            </p>
          )}
        </div>
      </div>
    </AnchoredPop>
  )
}
