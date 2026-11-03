/* The Overview's health table (views/Overview.tsx): a top-level project's
   sub-projects, or My view's projects, a row each, as the server answers
   them (convex/overview.ts health, through the store's health read,
   P.watchOverviewTable). The server applies the search and the column's
   order to the whole table and answers its first rows, 10 at first and 10
   more for each Load more, so nothing here sorts, cuts or counts a task.

   THIS WAS A GRID OF CARDS. Cards are right for four of them and wrong for
   twenty: a wall you scan rather than read, with no way to ask the one
   question the section exists to answer, WHICH of these is worst. Every
   number the card carried is still here; what the table adds is that any
   of them can be sorted on, and what it costs is the per-card status bar's
   size, now a 110px sparkbar in the Progress cell. That bar is
   deliberately the STACKED distribution rather than a plain progress bar:
   its done segment already IS the progress, so the stacked one says
   strictly more in the same width.

   NO MILESTONE COLUMN. A milestone belongs to a project (0078), not to a
   sub-project. The Milestones section below is where it lives, and at
   this altitude the same date would either repeat down every row of a
   project's table or be blank on all of them.

   The columns that count trouble are BLANK at zero, not "0". Colour marks
   the exception (tokens.css), and so does presence: a column of noughts is
   a column of decorations of exactly the weight of the one number that
   matters. A figure the server did not give never shows a digit or that
   blank: Delayed and Slipping it could not work out read a muted
   "unknown", and counts it is still counting read "Counting…" and "…". */

import { type ReactNode, type RefObject, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { limitSentence } from '@/lib/fieldLimits'
import { useFocusWhenGone } from '@/lib/focusWhenGone'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../../convex/lib/limits'
import type { Figure, HealthRow, HealthSort } from '../../../convex/lib/overview'
import { Avatar, Icon, ProjectName } from '../../components/qivo'
import type { HealthView } from '../../store/overviewLists'
import { P } from '../../store/planner'
import { OvStatusBar } from './StatusBar'

/** An order of the health table: its column and direction. */
export type HealthOrder = { key: HealthSort; dir: 'asc' | 'desc' }

/** The health table's columns, each with its first direction: a name wants
    A to Z and a delay count wants worst first. */
const HEALTH_COLS = [
  { id: 'name', label: '', align: 'left', dir: 'asc', title: '' },
  { id: 'lead', label: 'Lead', align: 'left', dir: 'asc', title: '' },
  { id: 'progress', label: 'Progress', align: 'left', dir: 'desc', title: '' },
  { id: 'done', label: 'Done', align: 'right', dir: 'desc', title: '' },
  {
    id: 'left',
    label: 'Left',
    align: 'right',
    dir: 'desc',
    title: 'Remaining hours on unfinished tasks',
  },
  {
    id: 'late',
    label: 'Delayed',
    align: 'right',
    dir: 'desc',
    title: 'Tasks projected to miss their due date',
  },
  {
    id: 'behind',
    label: 'Slipping',
    align: 'right',
    dir: 'desc',
    title: 'Tasks running past their planned end',
  },
  { id: 'paused', label: 'Paused', align: 'right', dir: 'desc', title: 'Tasks on hold' },
] as const satisfies readonly {
  id: HealthSort
  label: string
  align: 'left' | 'right'
  dir: 'asc' | 'desc'
  title: string
}[]

/** Where the table stands, as data-ov-health-state names it. */
type HealthState =
  /** no answer for this scope and clock yet */
  | 'loading'
  /** an answer kept from before: for these arguments while the read
      stopped or before it arrived again after a reconnect, or for other
      table arguments while theirs is on its way (data-ov-health-kept) */
  | 'refreshing'
  | 'ok'
  | 'unavailable'
  | 'over_budget'
  /** the first answer failed */
  | 'error'

const tdClass = 'border-b border-border px-3 py-2 text-base text-text-1'
const troubleToneClasses = {
  late: 'text-[color:var(--pressure-over)]',
  behind: 'text-[color:var(--pressure-warn)]',
  paused: 'text-[color:var(--warn)]',
} as const
/* What a cell shows where the server gave no figure. */
const unknownClass = 'font-sans italic text-text-3'

/** The markers of a cell over `figure`: its state, and where it is
    unavailable, why (data-ov-figure-state, data-ov-reason). Counting is a
    state, never a reason. */
function figureMarks(figure: Figure<object>) {
  if (figure.state === 'ok') return { 'data-ov-figure-state': 'ok' }
  if (figure.reason === 'counting') return { 'data-ov-figure-state': 'counting' }
  return { 'data-ov-figure-state': 'unavailable', 'data-ov-reason': figure.reason }
}

/** A count's cell content where the counts are not given: "…" while Qivo
    counts, "unknown" where it could not. */
const notCounted = (counts: Figure<object>, counting = '…') =>
  counts.state === 'unavailable' && counts.reason === 'counting' ? (
    counting
  ) : (
    <span className={unknownClass}>unknown</span>
  )

/** A row's figures as its cells show them, or null for each one the
    server did not give. */
function figuresOf(row: HealthRow) {
  const c = row.counts.state === 'ok' ? row.counts : null
  const total = c ? Object.values(c.leaves).reduce((n, x) => n + x, 0) : 0
  return {
    leaves: c ? c.leaves : null,
    done: c ? c.leaves.done : null,
    total,
    pct: c && total ? Math.round((c.leaves.done / total) * 100) : 0,
    left: c ? c.left_tenths / 10 : null,
    paused: c ? c.paused : null,
    late: row.delays.state === 'ok' ? row.delays.late : null,
    behind: row.delays.state === 'ok' ? row.delays.behind : null,
  }
}

/* A count that says nothing when there is nothing to say. The `data-ovcell`
   hook is how a drive reads one number off one row: the health CARD had no
   hook at all and verify-delay-status had to find it by "the button
   containing 'Enclosure' and the words 'tasks done'". A cell that a check
   depends on gets a name (design-spec §7.2: renaming these is a breaking
   change). */
function TroubleCell({
  id,
  n,
  figure,
  last,
}: {
  id: keyof typeof troubleToneClasses
  n: number | null
  /** the figure the count comes from, for its markers and its note */
  figure: Figure<object>
  last: boolean
}) {
  return (
    <td
      data-ovcell={id}
      {...figureMarks(figure)}
      className={cn(
        tdClass,
        'text-right font-mono',
        n !== null && n > 0 ? troubleToneClasses[id] : 'text-text-3',
        last && 'border-b-0',
      )}
    >
      {n === null ? notCounted(figure) : n > 0 ? n : '—'}
    </td>
  )
}

/** A row's name as the workspace names its project where it holds it,
    else as the answer does. */
const nameOf = (row: HealthRow) => ({
  id: row.project_id,
  name: P.project(row.project_id)?.name ?? row.name,
})

/** The health table's section: its search, its rows in the server's order
    with Load more, and its notes. `asked` is the order the page asks for;
    the headings show the order the rows are in, which the server answers.
    A press, the phone's Sort by and its direction build on that order
    where the rows answer the order asked, as in a name-order fallback,
    and on `asked` while a new order is on its way. */
export function OvHealthTable({
  view,
  mine,
  asked,
  onSort,
  search,
  onSearch,
  searching,
  searched,
  onePerson,
  mobile,
  onOpen,
}: {
  view: HealthView
  /** My view, whose rows are projects; a project's are sub-projects */
  mine: boolean
  asked: HealthOrder
  onSort: (order: HealthOrder) => void
  /** the search as typed */
  search: string
  onSearch: (text: string) => void
  /** whether the search box shows */
  searching: boolean
  /** whether the answer shown is for a search */
  searched: boolean
  /** whether the reader sees other people's work one person at a time */
  onePerson: boolean
  mobile: boolean
  onOpen: (id: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const unit = mine ? 'Project' : 'Sub-project'
  const thing = mine ? 'project' : 'sub-project'
  const things = mine ? 'projects' : 'sub-projects'
  const answer = view?.value
  const ok = answer?.state === 'ok' ? answer : null
  const state: HealthState =
    view === null
      ? 'loading'
      : answer === undefined
        ? 'error'
        : answer.state === 'unavailable'
          ? 'unavailable'
          : answer.state === 'over_budget'
            ? 'over_budget'
            : view.current && !view.kept
              ? 'ok'
              : 'refreshing'
  // the order the rows are in, which the headings show
  const shown: HealthOrder = ok ? { key: ok.sort.key, dir: ok.sort.dir } : asked
  // the order the controls build on: the rows' where they answer the order
  // asked, else the one asked, so a pick on the phone stays and a second
  // press reverses it while its rows are on their way
  const current: HealthOrder =
    ok && view?.table.sort === asked.key && view.table.dir === asked.dir ? shown : asked
  const more = view?.more ?? null
  const rows = ok?.rows ?? []
  const kept = !!view?.kept
  // Load more leaves at the end or where its next rows failed: focus it
  // left nowhere goes to Retry, else to the table
  useFocusWhenGone(
    more !== null,
    () => root.current?.querySelector<HTMLElement>('[data-ov-health-retry]') ?? root.current,
  )
  /* A press on a heading sorts by it, a press on the one of the order the
     controls build on flips its direction: a table that always starts
     ascending makes you click twice to ask the question you meant. */
  const press = (c: (typeof HEALTH_COLS)[number]) =>
    onSort(
      current.key === c.id
        ? { key: c.id, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key: c.id, dir: c.dir },
    )
  const overLimit = search.trim().length > LIMITS.search.max

  /* Why the rows are in name order, from the answer's order, which names
     why for every row the order needed, also those past the rows shown,
     and, unless that is the delays, why rows shown read unknown. */
  const notes: ReactNode[] = []
  if (ok?.sort.by_name === 'delays')
    notes.push(
      <p key="by-name" data-ov-health-by-name="delays">
        {onePerson && ok.sort.missing === 'loads'
          ? 'Sorted by name, because your access shows other people’s work one person at a time.'
          : `Sorted by name, because Qivo could not work out the delays of every ${thing} here.`}
      </p>,
    )
  else if (ok?.sort.by_name === 'counts')
    notes.push(
      <p key="by-name" data-ov-health-by-name="counts">
        {ok.sort.missing === 'counting'
          ? 'Sorted by name while Qivo counts the tasks here.'
          : 'Sorted by name, because Qivo could not count the tasks here in one request.'}
      </p>,
    )
  if (ok?.sort.by_name !== 'delays' && rows.some((r) => r.delays.state !== 'ok'))
    notes.push(
      <p key="unknown" data-ov-health-unknown>
        Qivo could not work out the delays of the {things} marked unknown.
      </p>,
    )
  if (ok && searched && !kept && ok.total === 0)
    notes.push(
      <p key="none" data-ov-health-none>
        No {thing} matches this search.
      </p>,
    )
  if (ok && rows.length >= ok.most && ok.total > rows.length)
    notes.push(
      <p key="cap" data-ov-health-cap>
        Qivo shows the first {ok.most} {things} here. Search to find the others.
      </p>,
    )

  let body: ReactNode
  if (state === 'unavailable' && answer?.state === 'unavailable')
    body = (
      <HealthNote>
        {answer.message ?? 'Qivo cannot show this table here.'}
        {answer.reason === undefined && <TryAgain table={root} />}
      </HealthNote>
    )
  else if (state === 'over_budget')
    body = (
      <HealthNote>
        This table could not be loaded within the Overview's limits.{' '}
        {mine
          ? 'Open a project to see its sub-projects.'
          : 'Open a sub-project to see its figures.'}
        <TryAgain table={root} />
      </HealthNote>
    )
  else if (state === 'error')
    body = (
      <HealthNote>
        The health table could not be loaded.
        <TryAgain table={root} />
      </HealthNote>
    )
  else if (mobile)
    body = (
      <div className="mobile-health-list" data-ov-table>
        <div className="mobile-health-sort">
          <label htmlFor="overview-health-sort">Sort by</label>
          <NativeSelect
            id="overview-health-sort"
            className="shadow-none"
            value={current.key}
            onChange={(e) => {
              const col = HEALTH_COLS.find((c) => c.id === e.target.value)
              if (col) onSort({ key: col.id, dir: col.dir })
            }}
          >
            {HEALTH_COLS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || unit}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Sort ${current.dir === 'asc' ? 'descending' : 'ascending'}`}
            onClick={() => onSort({ ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' })}
          >
            <Icon name={current.dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={16} />
          </Button>
        </div>
        {state === 'loading' ? (
          <div role="status" className="px-0.5 py-1 text-sm text-text-3 italic">
            Loading…
          </div>
        ) : (
          rows.map((r) => <HealthCard key={r.project_id} row={r} kept={kept} onOpen={onOpen} />)
        )}
      </div>
    )
  else
    body = (
      <div
        data-ov-table
        className="[background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-card)] [overflow-x:auto]"
      >
        <table className="[width:100%] [border-collapse:collapse]">
          <thead>
            <tr>
              {HEALTH_COLS.map((c) => (
                /* One tooltip, on the BUTTON: a tooltip on the <th> as well
                   would only ever show in the cell's padding, and the two
                   would take turns depending on where the pointer landed. */
                <th
                  key={c.id}
                  aria-sort={
                    shown.key === c.id
                      ? shown.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'border-b border-border px-3 py-2 text-sm font-medium text-text-2 whitespace-nowrap',
                    c.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  <Button
                    type="button"
                    onClick={() => press(c)}
                    title={c.title || undefined}
                    className={cn(
                      '[display:inline-flex] [align-items:center] [min-height:32px] [gap:4px] [border:none] [background:transparent] [padding:0] [font:inherit] [letter-spacing:inherit] [text-transform:inherit] [cursor:pointer]',
                      shown.key === c.id ? 'text-text-1' : 'text-inherit',
                    )}
                    variant="unstyled"
                  >
                    {c.label || unit}
                    {shown.key === c.id && (
                      <Icon
                        name={shown.dir === 'asc' ? 'chevronUp' : 'chevronDown'}
                        size={11}
                        color="var(--primary)"
                      />
                    )}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={cn(kept && 'opacity-60')}>
            {state === 'loading' ? (
              <tr>
                <td
                  colSpan={HEALTH_COLS.length}
                  role="status"
                  className={cn(tdClass, 'border-b-0 text-sm text-text-3 italic')}
                >
                  Loading…
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <HealthTableRow
                  key={r.project_id}
                  row={r}
                  last={i === rows.length - 1}
                  onOpen={onOpen}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    )

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-ov-health
      data-ov-health-state={state}
      data-ov-health-kept={kept ? '' : undefined}
      data-ov-health-end={ok && !kept && view?.current && rows.length >= ok.total ? '' : undefined}
      aria-busy={state === 'loading' || state === 'refreshing' || undefined}
      className="flex flex-col gap-2 outline-none"
    >
      {searching && (
        <div className="flex flex-col gap-1">
          <Input
            type="search"
            data-ov-health-search
            aria-label={`Search ${things}`}
            placeholder={`Search ${things}`}
            value={search}
            aria-invalid={overLimit || undefined}
            onChange={(e) => onSearch(e.target.value)}
            className="max-w-80"
          />
          {overLimit && (
            <p role="alert" data-ov-health-search-limit className="m-0 text-sm text-text-2">
              {limitSentence(LIMITS.search)}
            </p>
          )}
        </div>
      )}
      {body}
      {notes.length > 0 && (
        <div
          data-ov-health-notes
          className="flex flex-col gap-1 text-sm leading-relaxed text-text-2 [&>p]:m-0 [&>p]:max-w-[80ch]"
        >
          {notes}
        </div>
      )}
      {view?.moreFailed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
        >
          Couldn't load more {things}.
          <Button
            type="button"
            variant="ghost"
            data-ov-health-retry
            className="h-control-sm text-sm"
            onClick={() => {
              P.overviewRetry('health')
              root.current?.focus()
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {more !== null && (
        // while its rows load it stays, with no action, so keyboard focus
        // stays on it
        <Button
          type="button"
          variant="outline"
          data-ov-health-more
          aria-disabled={more === 'loading' || undefined}
          aria-busy={more === 'loading' || undefined}
          className={cn('self-start', more === 'loading' && 'pointer-events-none italic')}
          onClick={() => {
            if (more === 'ready') P.overviewMore('health')
          }}
        >
          {more === 'loading' ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

/** What the table says in place of its rows. */
function HealthNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      data-ov-health-note
      className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
    >
      {children}
    </div>
  )
}

/** The table's Try again, which asks the health read afresh and moves
    focus to `table`, the table's root, as its note leaves with the press. */
function TryAgain({ table }: { table: RefObject<HTMLDivElement | null> }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-control-sm text-sm"
      onClick={() => {
        P.overviewRetry('health')
        table.current?.focus()
      }}
    >
      Try again
    </Button>
  )
}

/** One desktop row: the row is the target for a pointer and the NAME is
    the target for a keyboard. The row stays out of the Tab order; focus on
    its name also opens the shared tooltip. The button stops the click from
    reaching the row so one press is one navigation. */
function HealthTableRow({
  row,
  last,
  onOpen,
}: {
  row: HealthRow
  /* the last row's rule would land one pixel inside the panel's own bottom
     border, two lines where the card had one */
  last: boolean
  onOpen: (id: string) => void
}) {
  const f = figuresOf(row)
  const lead = row.lead_id ? P.user(row.lead_id) : undefined
  const project = nameOf(row)
  return (
    <HoverTooltip content={`Open the ${project.name} board`}>
      <tr
        data-ovcard={row.project_id}
        onClick={() => onOpen(row.project_id)}
        tabIndex={-1}
        className="[cursor:pointer] [transition:background-color_var(--dur-fast)_var(--ease-out)]"
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--hover)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
      >
        <td className={cn(tdClass, 'max-w-60 font-medium text-text-1', last && 'border-b-0')}>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(row.project_id)
            }}
            className="[border:none] [background:transparent] [padding:0] [font:inherit] [color:inherit] [cursor:pointer] [max-width:100%] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] [display:block] [text-align:left]"
            variant="unstyled"
          >
            <ProjectName project={project} />
          </Button>
        </td>
        <td data-ovcell="lead" className={cn(tdClass, last && 'border-b-0')}>
          {lead ? (
            <Avatar id={lead.id} size={28} />
          ) : (
            <span className="[color:var(--text-3)]">—</span>
          )}
        </td>
        <td
          data-ovcell="progress"
          {...figureMarks(row.counts)}
          className={cn(tdClass, last && 'border-b-0')}
        >
          <span className="[display:inline-flex] [align-items:center] [gap:8px]">
            <span className="[width:110px] [display:inline-block]">
              <OvStatusBar counts={f.leaves} height={6} />
            </span>
            <span className="!font-mono [font-size:var(--fs-xs)] [color:var(--text-1)]">
              {f.leaves ? `${f.pct}%` : notCounted(row.counts, 'Counting…')}
            </span>
          </span>
        </td>
        <td
          data-ovcell="done"
          {...figureMarks(row.counts)}
          className={cn(tdClass, 'text-right font-mono whitespace-nowrap', last && 'border-b-0')}
        >
          {f.done === null ? notCounted(row.counts) : `${f.done}/${f.total}`}
        </td>
        <td
          data-ovcell="left"
          {...figureMarks(row.counts)}
          className={cn(tdClass, 'text-right font-mono', last && 'border-b-0')}
        >
          {f.left === null ? (
            notCounted(row.counts)
          ) : f.left > 0 ? (
            `${f.left}h`
          ) : (
            <span className="[color:var(--text-3)]">—</span>
          )}
        </td>
        <TroubleCell id="late" last={last} n={f.late} figure={row.delays} />
        <TroubleCell id="behind" last={last} n={f.behind} figure={row.delays} />
        <TroubleCell id="paused" last={last} n={f.paused} figure={row.counts} />
      </tr>
    </HoverTooltip>
  )
}

/** One phone card: the row's name, its sparkbar and Progress, its facts
    and its lead, a press opening its Board. */
function HealthCard({
  row,
  kept,
  onOpen,
}: {
  row: HealthRow
  /** whether it answers other table arguments than those asked now */
  kept: boolean
  onOpen: (id: string) => void
}) {
  const f = figuresOf(row)
  const lead = row.lead_id ? P.user(row.lead_id) : undefined
  const counting = row.counts.state === 'unavailable' && row.counts.reason === 'counting'
  /* a count's fact, or what stands in for it where the counts are not given */
  const fact = (n: number | null, text: string) =>
    n === null ? (
      <span className={unknownClass}>
        {counting ? '…' : 'unknown'} {text}
      </span>
    ) : (
      `${n} ${text}`
    )
  return (
    <Button
      type="button"
      variant="unstyled"
      data-ovcard={row.project_id}
      className={cn('mobile-health-card', kept && 'opacity-60')}
      onClick={() => onOpen(row.project_id)}
    >
      <span className="mobile-health-heading">
        <strong>
          <ProjectName project={nameOf(row)} wrap />
        </strong>
        <Icon name="chevronRight" size={16} />
      </span>
      <span className="mobile-health-progress" data-ovcell="progress" {...figureMarks(row.counts)}>
        <span>
          <OvStatusBar counts={f.leaves} height={6} />
        </span>
        <span className="font-mono">
          {f.leaves ? `${f.pct}%` : notCounted(row.counts, 'Counting…')}
        </span>
      </span>
      <span className="mobile-health-facts">
        <span data-ovcell="done" {...figureMarks(row.counts)}>
          {f.done === null ? fact(null, 'done') : `${f.done}/${f.total} done`}
        </span>
        <span data-ovcell="left" {...figureMarks(row.counts)}>
          {f.left === null ? fact(null, 'left') : `${f.left}h left`}
        </span>
        {row.delays.state === 'ok' ? (
          <>
            <span data-ovcell="late" className={cn(row.delays.late && troubleToneClasses.late)}>
              {row.delays.late} delayed
            </span>
            <span
              data-ovcell="behind"
              className={cn(row.delays.behind && troubleToneClasses.behind)}
            >
              {row.delays.behind} slipping
            </span>
          </>
        ) : (
          <span data-ovcell="late" {...figureMarks(row.delays)} className={unknownClass}>
            delays unknown
          </span>
        )}
        <span
          data-ovcell="paused"
          {...figureMarks(row.counts)}
          className={cn(f.paused && troubleToneClasses.paused)}
        >
          {fact(f.paused, 'paused')}
        </span>
      </span>
      <span className="mobile-health-lead" data-ovcell="lead">
        {lead ? (
          <>
            <Avatar id={lead.id} size={28} />
            <span>{lead.name}, Lead</span>
          </>
        ) : (
          'No lead assigned'
        )}
      </span>
    </Button>
  )
}
