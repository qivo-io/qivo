/* Settings › Labels: the organization's labels with their colors, names,
   active-task counts and deletion, for organization admins.

   The page reads its rows from the server a batch at a time in name order
   (labels.settingsPage), with a search over the whole list and Load more,
   through the shared paged list's live source (lib/pagedList.ts): the
   loaded batches stay live while the page shows, stop while the tab is
   hidden and go when the page is left, so a later visit reads again.
   Nothing it reads goes into the store. Each row's count is the server's
   count of the organization's active tasks that carry the label, archived
   projects included, and never a count the server did not give.

   A row's name and color come from the store's catalogue while it holds
   the label, which paints this session's writes at once and gives the
   writes their `expected`; until then the row shows the answer's and its
   controls wait. A name is a draft against the saved name it began from
   (lib/savedDraft.ts). The page also keeps, for this visit, the labels it
   created, the labels renamed here and the rows that hold an unsaved name,
   above the list while no loaded batch holds them, so a label made past
   the loaded rows shows, and a search never drops typed text. */
import type { FunctionReturnType } from 'convex/server'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { api } from '../../../convex/_generated/api'
import { grouped, LIMITS } from '../../../convex/lib/limits'
import { LimitedInput } from '../../components/LimitedField'
import { Icon, Popover } from '../../components/qivo'
import { FieldHint, PageTitle, SettingsGroup, SettingsSection } from '../../components/settingsPage'
import { limitSentence, overLimit } from '../../lib/fieldLimits'
import { focusAround, useFocusWhenGone } from '../../lib/focusWhenGone'
import { LABEL_COLORS } from '../../lib/labelColors'
import { useUnsaved } from '../../lib/leaveGuard'
import {
  type BatchAt,
  type ListEnd,
  listEnd,
  usePagedList,
  useSettledSearch,
} from '../../lib/pagedList'
import { TRIMMED, useSavedDraft } from '../../lib/savedDraft'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { P } from '../../store/planner'
import { ModalShell } from '../Modals'
import { DraftConflictLine } from './controls'

/** The most labels Load more gathers, eight batches; past it, a search
    narrows the list. */
export const LABEL_LIST_MOST = 200

/** One answer of labels.settingsPage. */
type LabelAnswer = FunctionReturnType<typeof api.labels.settingsPage>
/** One label as the answer lists it. */
type LabelRowAnswer = LabelAnswer['rows'][number]

/** The arguments of one batch, in a fixed key order with empty fields
    left out, so equal batches share one subscription. */
const labelArgs = (org: string, search: string, at: BatchAt) => ({
  org_id: org,
  ...(search === '' ? {} : { search }),
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

/** "12 active tasks", or "1 active task". */
const activeTasks = (n: number) => `${grouped(n)} active task${n === 1 ? '' : 's'}`

/** What the delete window says for a label used by `count` active tasks,
    or by a count the server did not give (null). */
function labelDeleteSentence(count: number | null): string {
  const used =
    count === null
      ? ''
      : count === 0
        ? 'Used by no active tasks. '
        : `Used by ${activeTasks(count)}. `
  return `${used}Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.`
}

/** The home organization's label `id` in the store's catalogue, if it
    holds it. */
const storeLabel = (id: string) => {
  const label = P.labelById[id]
  return label && label.org === P.homeOrg ? label : null
}

/** Whether another label of the home organization is named `name`, in any
    case: the store's catalogue holds every one (store/planner.ts
    orgLabels), so the check does not rest on the loaded batches. */
const nameTaken = (name: string, id: string | null) =>
  P.orgLabels().some((l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase())

/** The name input of row `id`, for focus. */
const nameOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-label-row="${id}"] [data-label-name]`)

function LabelRow({
  id,
  name,
  color,
  count,
  counting,
  kept,
  canEdit,
  onUnsaved,
  onRenamed,
  onDelete,
}: {
  id: string
  /** the name and color shown: the store's while it holds the label, else
      the answer's */
  name: string
  color: string
  /** the answer's count, null for none given, undefined for a kept row */
  count: number | null | undefined
  counting: boolean
  /** a kept row's note in place of the count */
  kept: 'Added' | 'Not in this list' | null
  canEdit: boolean
  onUnsaved: (id: string, unsaved: boolean) => void
  onRenamed: (id: string) => void
  onDelete: (id: string) => void
}) {
  // the controls wait for the store's row, which the writes need
  const held = storeLabel(id) !== null
  const ready = canEdit && held
  const draft = useSavedDraft(`${id}:name`, name, TRIMMED, 'label name', !ready)
  useEffect(() => onUnsaved(id, draft.unsaved), [id, draft.unsaved])
  useEffect(() => () => onUnsaved(id, false), [id])
  const waiting = held ? undefined : 'Loading this label…'
  // an empty or unchanged name shows the saved one; a conflict waits for
  // Use saved or Keep mine; a name over the cap, one another label holds,
  // a paused rename and a refused one stay typed and unsaved
  const commit = () => {
    const next = draft.text.trim()
    if (!next || draft.isSaved(next)) return draft.showSaved()
    if (overLimit(LIMITS.labelName, next)) {
      window.showToast?.(limitSentence(LIMITS.labelName), 'error')
      return
    }
    if (draft.conflict || P.refusePausedEdit()) return
    if (nameTaken(next, id)) {
      window.showToast?.('A label with that name already exists', 'error')
      return
    }
    const save = draft.save(next)
    if (P.updateLabel(id, { name: next }, save.as('name'))) onRenamed(id)
    else save.keepUnsaved()
  }
  return (
    <div
      data-label-row={id}
      data-label-waiting={held ? undefined : ''}
      className="[display:flex] [flex-direction:column] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
    >
      <div data-label-line="" className="[display:flex] [align-items:center] [gap:8px]">
        <Popover
          width={208}
          wrapStyle={{ display: 'flex', flexShrink: 0 }}
          button={(toggle) => (
            <Button
              type="button"
              disabled={!ready}
              onClick={toggle}
              data-field-trigger
              aria-label={`Change color for ${name}`}
              title={canEdit ? (waiting ?? 'Change label color') : undefined}
              className="size-8 disabled:cursor-default"
              variant="ghost"
              size="icon"
            >
              <span
                style={{ background: color }}
                className="size-4 rounded-full [box-shadow:0_0_0_2px_var(--surface-1),_0_0_0_3px_var(--border-strong)]"
              />
            </Button>
          )}
        >
          {(close) => (
            <fieldset aria-label="Label colors" className="grid grid-cols-5 gap-1 p-2">
              {LABEL_COLORS.map(({ color: option, name: colorName }) => (
                <Button
                  key={option}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={!ready}
                  aria-label={colorName}
                  aria-pressed={color.toLowerCase() === option.toLowerCase()}
                  onClick={() => {
                    if (option.toLowerCase() !== color.toLowerCase())
                      P.updateLabel(id, { color: option })
                    close()
                  }}
                >
                  <span
                    style={{ background: option }}
                    className={cn(
                      'size-5 rounded-full',
                      color.toLowerCase() === option.toLowerCase() &&
                        'ring-2 ring-foreground ring-offset-2 ring-offset-popover',
                    )}
                  />
                </Button>
              ))}
            </fieldset>
          )}
        </Popover>
        {canEdit ? (
          <LimitedInput
            limit={LIMITS.labelName}
            value={draft.text}
            data-label-name=""
            disabled={!held}
            title={waiting}
            aria-label={`Name of label ${name}`}
            aria-describedby={draft.conflict ? draft.conflictId : undefined}
            onChange={(e) => draft.edit(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                // rendered before the blur, whose save then finds nothing typed
                flushSync(draft.discard)
                e.currentTarget.blur()
              }
            }}
            wrapperClassName="min-w-0 flex-1"
            className="h-control-sm w-full border-transparent bg-transparent px-[7px] py-0 font-sans text-base font-medium text-text-1 hover:border-border focus:bg-hover"
          />
        ) : (
          <span className="[flex:1] [font-size:var(--fs-base)] [font-weight:500]">{name}</span>
        )}
        <span
          data-label-count=""
          className="shrink-0 text-right [font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono"
        >
          {kept !== null ? (
            <span data-label-kept="">{kept}</span>
          ) : count !== null && count !== undefined ? (
            activeTasks(count)
          ) : counting ? (
            'Counting…'
          ) : (
            'Not counted yet'
          )}
        </span>
        {canEdit && (
          <Button
            type="button"
            data-delete-label={id}
            variant="ghost"
            size="icon-sm"
            disabled={!held}
            aria-label={`Delete ${name}`}
            title={waiting ?? 'Delete label'}
            onClick={() => onDelete(id)}
          >
            <Icon name="trash" size={16} />
          </Button>
        )}
      </div>
      {ready && (
        <div className="pl-[47px]">
          <DraftConflictLine draft={draft} text={(saved) => saved} compact />
        </div>
      )}
    </div>
  )
}

/* The window that deletes a label. It says how many active tasks use it,
   that deleting removes it from every task, archived ones too, and that
   this cannot be undone. */
function LabelDeleteWindow({
  name,
  count,
  onClose,
  onDelete,
  focusAfterClose,
}: {
  name: string
  count: number | null
  onClose: () => void
  onDelete: () => void
  focusAfterClose: () => HTMLElement | null
}) {
  return (
    <ModalShell
      icon="warning"
      title={`Delete “${name}”?`}
      danger
      width={440}
      onClose={onClose}
      onSubmit={onDelete}
      canSubmit
      submitLabel="Delete"
      focusAfterClose={focusAfterClose}
    >
      <p data-label-delete-sentence="" className="text-base leading-normal text-text-2">
        {labelDeleteSentence(count)}
      </p>
    </ModalShell>
  )
}

/* What a batch says in place, after its rows, when it is not the list's
   end: it failed, or its read stopped without checking anything, each with
   Retry. */
function BatchNote({
  note,
  retrying,
  onRetry,
}: {
  note: 'failed' | 'stuck'
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      data-labels-batch-note={note}
      className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
    >
      {note === 'failed' ? "Couldn't load these labels." : 'Qivo could not check part of the list.'}
      <Button
        type="button"
        variant="ghost"
        className="h-control-sm text-sm"
        aria-disabled={retrying || undefined}
        onClick={() => !retrying && onRetry()}
      >
        {retrying ? 'Loading…' : 'Retry'}
      </Button>
    </div>
  )
}

const noteClass = '[font-size:var(--fs-sm)] [color:var(--text-2)] [padding:4px_2px]'

/* Labels survive task moves within the organization. Settings opens this
   page for organization admins only, the same people the server lets read
   the list with its counts and rename, recolor and delete labels. */
export function OrgLabelsPage() {
  const admin = P.isAdmin()
  const org = P.homeOrg
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: admin
      ? JSON.stringify(labelArgs(org, search.settled, { after: null, through: null }))
      : null,
    source: {
      kind: 'live',
      query: api.labels.settingsPage,
      args: (at) => labelArgs(org, search.settled, at),
    },
    batch: (answer: LabelAnswer) => answer,
    id: (row: LabelRowAnswer) => row.id,
    most: LABEL_LIST_MOST,
  })
  const counting = list.answers.some((answer) => answer.counting)
  // the labels this visit created and renamed, the rows holding an unsaved
  // name, and the labels whose delete is on its way, which hide at once
  const [made, setMade] = useState<ReadonlySet<string>>(() => new Set())
  const [renamed, setRenamed] = useState<ReadonlySet<string>>(() => new Set())
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(() => new Set())
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set())
  const onUnsaved = useCallback((id: string, unsaved: boolean) => {
    setDrafts((s) => (unsaved === s.has(id) ? s : toggled(s, id, unsaved)))
  }, [])
  const onRenamed = useCallback((id: string) => setRenamed((s) => toggled(s, id, true)), [])
  const loaded = new Map(list.rows.map((row) => [row.id, row]))
  // a created or renamed label goes from the kept rows once a loaded batch
  // holds it under the name the store holds, or the store no longer does
  useEffect(() => {
    const settled = (id: string) => {
      const label = storeLabel(id)
      return !label || loaded.get(id)?.name === label.name
    }
    setMade((s) => without(s, settled))
    setRenamed((s) => without(s, settled))
  })
  const kept = [...new Set([...made, ...renamed, ...drafts])].filter(
    (id) => !loaded.has(id) && !deleting.has(id) && storeLabel(id) !== null,
  )

  const [newLabel, setNewLabel] = useState('')
  // a create in flight: Add waits for the server's answer
  const [adding, setAdding] = useState(false)
  useUpdateBlocker(!!newLabel)
  useUnsaved(!!newLabel.trim(), 'label name')
  const dup = nameTaken(newLabel.trim(), null)
  const tooLong = overLimit(LIMITS.labelName, newLabel)
  const addLabel = () => {
    const v = newLabel.trim()
    if (!v || dup || tooLong || adding) return
    // The typed name stays until the server creates the label, and after a
    // refusal, so a paused or refused create can be sent again.
    const created = P.addLabel({ name: v })
    if (!created) return
    setAdding(true)
    void created.saved.then((saved) => {
      setAdding(false)
      if (!saved) return
      setMade((s) => toggled(s, created.id, true))
      window.showToast?.(`Label “${v}” created`)
      setNewLabel((typed) => (typed.trim() === v ? '' : typed))
    })
  }

  // The delete window, the row whose Delete opened the latest one, and
  // where focus goes once that row has left. That is the next row's name,
  // else the previous one's, else the search box. A window closed without
  // a delete leaves the row in place, and its Delete button takes focus
  // back (ModalShell).
  const [asked, setAsked] = useState<{ id: string; name: string; count: number | null } | null>(
    null,
  )
  const searchBox = useRef<HTMLInputElement>(null)
  const after = useRef<() => HTMLElement | null>(() => null)
  const [opener, setOpener] = useState<string | null>(null)
  useFocusWhenGone(
    opener !== null && !deleting.has(opener),
    () => after.current() ?? searchBox.current,
  )
  const askDelete = (id: string) => {
    const label = storeLabel(id)
    if (!label) return
    // no target from an earlier delete, so a close without one gives focus
    // back to this Delete button
    after.current = () => null
    setOpener(id)
    setAsked({ id, name: label.name, count: loaded.get(id)?.active_tasks ?? null })
  }
  const remove = () => {
    if (!asked) return
    const { id, name } = asked
    after.current = focusAround('data-label-row', id, (row) =>
      row.querySelector<HTMLElement>('[data-label-name]'),
    )
    setAsked(null)
    setDeleting((s) => toggled(s, id, true))
    void P.removeLabel(id).then((saved) => {
      if (saved) window.showToast?.(`Label “${name}” deleted`)
      // a refusal, toasted by the store, brings the row back
      else setDeleting((s) => toggled(s, id, false))
    })
  }

  // Load more keeps focus while it reads, and the Retry that takes its
  // place after a failure keeps it too (EndLine). When Load more goes,
  // focus moves to the first new row's name, else to the search box. While
  // a split reads its halves focus stays put, and Load more comes back
  // once they answer.
  const moreFrom = useRef<number | null>(null)
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = moreFrom.current === null ? undefined : list.rows[moreFrom.current]
    return row ? nameOf(row.id) : searchBox.current
  })
  const more = () => {
    if (list.phase === 'more') return
    moreFrom.current = list.rows.length
    list.more()
  }

  const state =
    list.phase === 'first'
      ? 'loading'
      : list.phase === 'failed' || list.batches.some((b) => b.note === 'failed')
        ? 'failed'
        : list.refreshing
          ? 'refreshing'
          : 'ok'

  const row = (
    id: string,
    answer: LabelRowAnswer | null,
    note: 'Added' | 'Not in this list' | null,
  ) => {
    const label = storeLabel(id)
    return (
      <LabelRow
        key={id}
        id={id}
        name={label?.name ?? answer?.name ?? ''}
        color={label?.color ?? answer?.color ?? 'var(--border-strong)'}
        count={note === null ? (answer?.active_tasks ?? null) : undefined}
        counting={counting}
        kept={note}
        canEdit={admin}
        onUnsaved={onUnsaved}
        onRenamed={onRenamed}
        onDelete={askDelete}
      />
    )
  }
  const items: ReactNode[] = kept.map((id) =>
    row(id, null, made.has(id) ? 'Added' : 'Not in this list'),
  )
  list.batches.forEach((batch, i) => {
    for (const answer of batch.rows)
      if (!deleting.has(answer.id)) items.push(row(answer.id, answer, null))
    const last = i === list.batches.length - 1
    if (batch.note === 'stuck' || (batch.note === 'failed' && !last))
      items.push(
        <BatchNote
          key={`note:${batch.id}`}
          note={batch.note}
          retrying={batch.retrying}
          onRetry={() => list.retry(batch.id)}
        />,
      )
  })
  const shown = list.rows.some((r) => !deleting.has(r.id)) || kept.length > 0

  return (
    <>
      <PageTitle>Labels</PageTitle>
      <SettingsSection
        title="Labels"
        description="Showing active tasks, archived projects included."
      >
        {admin ? (
          <>
            <LimitedInput
              ref={searchBox}
              limit={LIMITS.search}
              aria-label="Search labels"
              data-labels-search=""
              placeholder="Search labels"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears a typed search first
                if (e.key === 'Escape' && text) {
                  e.stopPropagation()
                  setText('')
                }
              }}
              wrapperClassName="mb-2"
              className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
            />
            {counting && (
              <p data-labels-counting="" className={cn(noteClass, 'mb-1')}>
                Qivo is counting how many tasks use each label. The counts show when it has
                finished.
              </p>
            )}
            <div
              data-org-labels=""
              data-labels-state={state}
              aria-busy={state === 'loading' || state === 'refreshing' || undefined}
              className="[display:flex] [flex-direction:column] [gap:6px]"
            >
              {items}
              <EndLine
                end={end}
                shown={shown}
                stopped={list.stopped}
                none={list.rows.length === 0}
                loading={list.phase === 'more'}
                searching={search.settled !== ''}
                onMore={more}
                onRetry={() => list.retry()}
              />
            </div>
          </>
        ) : (
          <FieldHint>Only organization admins can manage labels.</FieldHint>
        )}
        {admin && (
          <SettingsGroup legend="New label">
            <div className="[display:flex] [gap:8px]">
              <LimitedInput
                limit={LIMITS.labelName}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="New label name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addLabel()
                }}
                wrapperClassName="[flex:1]"
                className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
              />
              <Button
                type="button"
                disabled={!newLabel.trim() || dup || tooLong || adding}
                title={dup && !adding ? 'A label with that name already exists' : 'Add label'}
                onClick={addLabel}
              >
                <Icon name="plus" size={16} />
                Add label
              </Button>
            </div>
          </SettingsGroup>
        )}
      </SettingsSection>
      {asked && (
        <LabelDeleteWindow
          name={asked.name}
          count={asked.count}
          onClose={() => setAsked(null)}
          onDelete={remove}
          focusAfterClose={() => after.current()}
        />
      )}
    </>
  )
}

/* The line that ends the list (lib/pagedList.ts listEnd), with its Load
   more and Retry. The failure's Retry is the same button as Load more, in
   the same place in the same element, so React keeps it and focus stays on
   it when a Load more fails. */
function EndLine({
  end,
  shown,
  stopped,
  none,
  loading,
  searching,
  onMore,
  onRetry,
}: {
  end: ListEnd | 'too_long'
  /** whether any row shows, kept rows included */
  shown: boolean
  stopped: boolean
  /** whether no loaded batch holds a row */
  none: boolean
  /** whether a Load more is on its way */
  loading: boolean
  searching: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const line = (text: string, status = false) => (
    <p data-labels-end={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  switch (end) {
    case 'too_long':
      return line(limitSentence(LIMITS.search))
    case 'loading':
      return line('Loading labels…', true)
    case 'held':
      return line('The label list is not ready yet. Try again in a few minutes.')
    case 'failed':
      return (
        <div
          role="alert"
          data-labels-end={end}
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          {none ? "Couldn't load labels." : "Couldn't load more labels."}
          <Button type="button" variant="ghost" className="h-control-sm text-sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )
    case 'full':
      return line('Search to find more labels.')
    case 'more':
      return (
        <div data-labels-end={end} className="flex flex-col items-start gap-1">
          {stopped && (
            <p className={noteClass}>
              {none
                ? 'Qivo checked part of the list and found no matches there. Load more continues.'
                : 'Qivo checked part of the list. Load more continues.'}
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            data-labels-more=""
            aria-disabled={loading || undefined}
            onClick={onMore}
            className="h-control-sm text-sm"
          >
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )
    case 'partial':
      return null
    case 'none':
      return line('No labels match.')
    case 'end':
      return shown || searching ? null : line('No labels yet.')
  }
}

/** `set` with `id` in it or not. */
function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** `set` without the ids `gone` answers true for, the same set when it
    drops none. */
function without(set: ReadonlySet<string>, gone: (id: string) => boolean): ReadonlySet<string> {
  const left = [...set].filter((id) => !gone(id))
  return left.length === set.size ? set : new Set(left)
}
