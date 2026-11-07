/* Settings › Labels: the organization's labels with their colors, names,
   active-task counts and deletion, for organization admins.

   The page reads its rows from the server a batch at a time in name order
   (labels.settingsPage), with a search over the whole list and Load more,
   through the shared paged list's live source (lib/pagedList.ts). The
   loaded batches stay live while the page shows, stop while the tab is
   hidden and go when the page is left, so a later visit reads again.
   Nothing it reads goes into the store. Each row's count is the server's
   count of the organization's active tasks that carry the label, archived
   projects included, and never a count the server did not give.

   A row's name and color come from the store's catalogue while it holds
   the label, which paints this session's writes at once, else from the
   page's answers with what the server accepted from the page over them,
   so a refused rename or recolor never shows as saved. Every write sends
   what the row showed (store/planner.ts LabelShown) to the page's
   organization with its `expected` from it, so no control waits for the
   store. A name is a draft against the saved name it began from
   (lib/savedDraft.ts); a rename to a name another label holds is refused
   by the server and keeps the typed text. New label checks the typed name
   once typing rests, on labels.picker's `exact` (P.labelChoices): Add is
   on only once the answer for the text on screen names no label of that
   name, in any case, says so beside the button while the check runs or
   when a label holds the name, and after a failed check stays on and lets
   the server decide. A new label takes its color from its id
   (lib/labelColors.ts labelColorFor). The page also keeps, for this visit,
   the labels it created, the labels renamed here and the rows that hold an
   unsaved name, above the list while no loaded batch holds them under the
   name the page saved, each with the name and color of the answer the
   page last held for it or that it was created with, so a label made past
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
import { type LabelShown, P } from '../../store/planner'
import { ModalShell } from '../Modals'
import { keepNamed } from '../taskLabels'
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
    holds it, which a row paints over the answer so this session's writes
    show at once. */
const storeLabel = (id: string) => {
  const label = P.labelById[id]
  return label && label.org === P.homeOrg ? label : null
}

/** What New label says beside Add while it checks the typed name, and
    once the server's answer names a label of that name. */
export const NAME_CHECKING = 'Checking the name…'
export const NAME_TAKEN = 'A label with that name already exists'

/** Where New label's check of a typed name stands: on its way, free (the
    answer's `exact` is null), taken by a label, or failed, when Add stays
    on and the server decides. */
type NameCheck = { name: string; state: 'checking' | 'free' | 'taken' | 'failed' }

/** A name or color the server accepted from the page over a label the
    store does not hold, with the values the page showed before its writes
    (`under`), which an answer that has not caught up with them still
    holds. */
type SavedOver = { value: string; under: readonly string[] }

/** `value`, accepted over what the page showed before the write
    (`before`), on top of what it had saved over the label's field. */
const savedOver = (was: SavedOver | undefined, value: string, before: string): SavedOver => ({
  value,
  under: [...(was?.under ?? []), before],
})

/** Whether the answer's `now` has caught up with what the page saved
    over the field, as when it shows the saved value or a value the page
    did not show before its writes, such as a newer change by someone
    else. */
const caughtUp = (over: SavedOver, now: string, same: (a: string, b: string) => boolean) =>
  same(now, over.value) || !over.under.some((was) => same(now, was))

const sameName = (a: string, b: string) => a === b
const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The name input of row `id`, for focus. */
const nameOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-label-row="${id}"] [data-label-name]`)

function LabelRow({
  id,
  org,
  name,
  color,
  count,
  counting,
  kept,
  canEdit,
  onUnsaved,
  onRenamed,
  onRecolored,
  onDelete,
}: {
  id: string
  org: string
  /** the name and color shown: the store's while it holds the label, else
      the answer's with what the page saved over it */
  name: string
  color: string
  /** the answer's count, null for none given, undefined for a kept row */
  count: number | null | undefined
  counting: boolean
  /** a kept row's note in place of the count */
  kept: 'Added' | 'Not in this list' | null
  canEdit: boolean
  onUnsaved: (id: string, unsaved: boolean) => void
  /** a rename the page sent, with the name, the name the row showed
      before it and the write's answer, whether the server accepted it */
  onRenamed: (id: string, name: string, before: string, accepted: Promise<boolean>) => void
  /** a recolor the page sent, with the color, the color the row showed
      before it and the write's answer */
  onRecolored: (id: string, color: string, before: string, accepted: Promise<boolean>) => void
  onDelete: (id: string, name: string, color: string) => void
}) {
  const ready = canEdit
  const draft = useSavedDraft(`${id}:name`, name, TRIMMED, 'label name', !ready)
  useEffect(() => onUnsaved(id, draft.unsaved), [id, draft.unsaved])
  useEffect(() => () => onUnsaved(id, false), [id])
  // the label as the row shows it, which each write sends
  const shown: LabelShown = { orgId: org, name, color }
  // an empty or unchanged name shows the saved one; a conflict waits for
  // Use saved or Keep mine; a name over the cap, a paused rename and a
  // refused one, as for a name another label holds, stay typed and unsaved
  const commit = () => {
    const next = draft.text.trim()
    if (!next || draft.isSaved(next)) return draft.showSaved()
    if (overLimit(LIMITS.labelName, next)) {
      window.showToast?.(limitSentence(LIMITS.labelName), 'error')
      return
    }
    if (draft.conflict || P.refusePausedEdit()) return
    const save = draft.save(next)
    const sent = P.updateLabel(id, { name: next }, save.as('name'), shown)
    if (sent) onRenamed(id, next, name, sent)
    else save.keepUnsaved()
  }
  return (
    <div
      data-label-row={id}
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
              title={canEdit ? 'Change label color' : undefined}
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
                    const sent =
                      option.toLowerCase() !== color.toLowerCase() &&
                      P.updateLabel(id, { color: option }, {}, shown)
                    if (sent) onRecolored(id, option, color, sent)
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
            aria-label={`Delete ${name}`}
            title="Delete label"
            onClick={() => onDelete(id, name, color)}
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

/* The window that deletes a label. It says how many active tasks use it
   when the page has the server's count for it (labelDeleteSentence), that
   deleting removes it from every task, archived ones too, and that this
   cannot be undone. */
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

/* What a batch says in place, after its rows, with Retry. A batch whose
   read stopped without checking anything says so wherever it is, the last
   one included, since the end line then says nothing. One that failed says
   so when it is not the last, as the end line gives the last one's
   failure. */
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
  // the name and color the page last showed for each label, from its
  // answers or as it created the label, and what the server accepted from
  // the page over them since, which a kept row shows and a loaded row shows
  // until the answer has caught up with it (caughtUp), by showing it or a
  // newer change. A rename or recolor counts as saved only once the server
  // accepts it, so a refused one never shows as the label's name or color,
  // or goes out later as `expected`.
  const known = useRef(new Map<string, { name: string; color: string }>())
  // the labels of the kept rows the store's catalogue held during this
  // visit. One it no longer holds was deleted, here or by someone else
  const heldHere = useRef(new Set<string>())
  const [saved, setSaved] = useState<ReadonlyMap<string, { name?: SavedOver; color?: SavedOver }>>(
    () => new Map(),
  )
  // the names on their way, by label, which a renamed label's kept row
  // waits for in a loaded batch until the server answers
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(() => new Map())
  const onUnsaved = useCallback((id: string, unsaved: boolean) => {
    setDrafts((s) => (unsaved === s.has(id) ? s : toggled(s, id, unsaved)))
  }, [])
  const onRenamed = (id: string, name: string, before: string, accepted: Promise<boolean>) => {
    setRenamed((s) => toggled(s, id, true))
    setSending((m) => new Map(m).set(id, name))
    void accepted.then((ok) => {
      setSending((m) => {
        if (m.get(id) !== name) return m
        const next = new Map(m)
        next.delete(id)
        return next
      })
      if (!ok) return
      setSaved((m) => {
        const was = m.get(id)
        return new Map(m).set(id, { ...was, name: savedOver(was?.name, name, before) })
      })
    })
  }
  const onRecolored = (id: string, color: string, before: string, accepted: Promise<boolean>) => {
    void accepted.then((ok) => {
      if (!ok) return
      setSaved((m) => {
        const was = m.get(id)
        return new Map(m).set(id, { ...was, color: savedOver(was?.color, color, before) })
      })
    })
  }
  const loaded = new Map(list.rows.map((row) => [row.id, row]))
  for (const row of list.rows) known.current.set(row.id, { name: row.name, color: row.color })
  // a created or renamed label goes from the kept rows once a loaded batch
  // holds it under the name the page sent or saved; each field the page
  // saved goes once the answer has caught up with it
  useEffect(() => {
    const settled = (id: string) => {
      const row = loaded.get(id)
      return (
        !!row &&
        row.name === (sending.get(id) ?? saved.get(id)?.name?.value ?? known.current.get(id)?.name)
      )
    }
    setMade((s) => without(s, settled))
    setRenamed((s) => without(s, settled))
    setSaved((m) => {
      let next: Map<string, { name?: SavedOver; color?: SavedOver }> | null = null
      for (const [id, over] of m) {
        const row = loaded.get(id)
        if (!row) continue
        const name = over.name && !caughtUp(over.name, row.name, sameName) ? over.name : undefined
        const color =
          over.color && !caughtUp(over.color, row.color, sameColor) ? over.color : undefined
        if (name === over.name && color === over.color) continue
        next ??= new Map(m)
        if (name || color) next.set(id, { name, color })
        else next.delete(id)
      }
      return next ?? m
    })
  })
  // a created or renamed label, or one with an unsaved name, that no loaded
  // batch shows, while the store holds it or while the page knows it and
  // the store never held it, as a label the answers show before the
  // catalogue does. One the store held and no longer holds is gone.
  const candidates = [...new Set([...made, ...renamed, ...drafts])]
  for (const id of candidates) if (storeLabel(id) !== null) heldHere.current.add(id)
  const kept = candidates.filter(
    (id) =>
      !loaded.has(id) &&
      !deleting.has(id) &&
      (storeLabel(id) !== null || (known.current.has(id) && !heldHere.current.has(id))),
  )
  // forget the labels neither a batch, a kept row nor a delete on its way
  // shows
  for (const id of known.current.keys())
    if (!loaded.has(id) && !kept.includes(id) && !deleting.has(id)) known.current.delete(id)
  /** Label `id` as the page shows it: the store's while it holds it, else
      what the page last held or created, with what it saved over that. */
  const shownLabel = (id: string, answer: LabelRowAnswer | null) => {
    const label = storeLabel(id)
    if (label) return { name: label.name, color: label.color }
    const base = answer ?? known.current.get(id)
    const over = saved.get(id)
    return {
      name: over?.name?.value ?? base?.name ?? '',
      color: over?.color?.value ?? base?.color ?? 'var(--border-strong)',
    }
  }

  const [newLabel, setNewLabel] = useState('')
  // a create in flight: Add waits for the server's answer
  const [adding, setAdding] = useState(false)
  useUpdateBlocker(!!newLabel)
  useUnsaved(!!newLabel.trim(), 'label name')
  const tooLong = overLimit(LIMITS.labelName, newLabel)
  // the typed name, checked once typing rests on labels.picker's `exact`,
  // one read a name, never subscribed; a name past LIMITS.labelName or
  // LIMITS.search reads nothing
  const typedName = useSettledSearch(newLabel, LIMITS.search)
  const checkName = typedName.settled
  const [check, setCheck] = useState<NameCheck | null>(null)
  useEffect(() => {
    if (!admin || checkName === '' || typedName.tooLong || overLimit(LIMITS.labelName, checkName))
      return setCheck(null)
    let live = true
    setCheck({ name: checkName, state: 'checking' })
    void P.labelChoices({ org, search: checkName, cursor: null }).then((answer) => {
      if (!live) return
      setCheck({
        name: checkName,
        state: answer?.state === 'ready' ? (answer.exact === null ? 'free' : 'taken') : 'failed',
      })
    })
    return () => {
      live = false
    }
  }, [admin, org, checkName, typedName.tooLong])
  // the check for the text on screen, else one on its way
  const name = newLabel.trim()
  const checked = check !== null && check.name === name ? check.state : 'checking'
  const nameNote =
    name === '' || tooLong
      ? null
      : checked === 'checking'
        ? NAME_CHECKING
        : checked === 'taken'
          ? NAME_TAKEN
          : null
  const canAdd = name !== '' && !tooLong && !adding && (checked === 'free' || checked === 'failed')
  const addLabel = () => {
    const v = newLabel.trim()
    if (!canAdd) return
    // The typed name stays until the server creates the label, and after a
    // refusal, so a paused or refused create can be sent again.
    const created = P.addLabel({ name: v })
    if (!created) return
    setAdding(true)
    void created.saved.then((ok) => {
      setAdding(false)
      if (!ok) return
      known.current.set(created.id, { name: v, color: created.color })
      // its chip names it at once on any task, whether or not the
      // catalogue holds it
      keepNamed(org, { id: created.id, name: v, color: created.color })
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
  const [asked, setAsked] = useState<{
    id: string
    name: string
    color: string
    count: number | null
  } | null>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const after = useRef<() => HTMLElement | null>(() => null)
  const [opener, setOpener] = useState<string | null>(null)
  useFocusWhenGone(
    opener !== null && !deleting.has(opener),
    () => after.current() ?? searchBox.current,
  )
  const askDelete = (id: string, name: string, color: string) => {
    // no target from an earlier delete, so a close without one gives focus
    // back to this Delete button
    after.current = () => null
    setOpener(id)
    setAsked({ id, name, color, count: loaded.get(id)?.active_tasks ?? null })
  }
  const remove = () => {
    if (!asked) return
    const { id, name, color } = asked
    after.current = focusAround('data-label-row', id, (row) =>
      row.querySelector<HTMLElement>('[data-label-name]'),
    )
    setAsked(null)
    setDeleting((s) => toggled(s, id, true))
    void P.removeLabel(id, { orgId: org, name, color }).then((saved) => {
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
    const shown = shownLabel(id, answer)
    return (
      <LabelRow
        key={id}
        id={id}
        org={org}
        name={shown.name}
        color={shown.color}
        count={note === null ? (answer?.active_tasks ?? null) : undefined}
        counting={counting}
        kept={note}
        canEdit={admin}
        onUnsaved={onUnsaved}
        onRenamed={onRenamed}
        onRecolored={onRecolored}
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
                first={list.batches.length <= 1}
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
              <Button type="button" data-label-add="" disabled={!canAdd} onClick={addLabel}>
                <Icon name="plus" size={16} />
                Add label
              </Button>
            </div>
            {/* said beside Add, not only in a disabled button's title,
                which browsers do not show */}
            {nameNote && (
              <p data-label-name-check={checked} role="status" className="mt-1 text-sm text-text-2">
                {nameNote}
              </p>
            )}
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
  first,
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
  /** whether the list holds its first batch at most, so a failure is the
      list's, not a Load more's */
  first: boolean
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
          {none || first ? "Couldn't load labels." : "Couldn't load more labels."}
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
