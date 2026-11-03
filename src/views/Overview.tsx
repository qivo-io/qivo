import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
/* Overview — dashboard rollup: what to do, the scope's state in one box,
   health per group as a sortable table, then at-risk tasks, paused tasks and
   milestones.

   The summary, the projected delays and the two lists come from the
   server (convex/overview.ts), through the reads the store owns
   (P.watchOverview, store/overviewLists.ts), registered from an effect
   while the page and the tab show (lib/viewVisibility.ts). The store keeps
   their answers while they stop, and the page shows them marked
   refreshing until fresh ones arrive. A figure the server answers
   unavailable shows a dash and why, never a number. Each list shows the
   server's batches in the server's order, never sorted or cut here. The
   health table and the milestones still read the workspace until their
   own stages (t3/limits-overview-health, t3/limits-milestone-overview),
   and the health table waits for every task. */

import {
  type MouseEvent,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState as useStateO,
} from 'react'
import { relativeWeek, weekToISO } from '@/lib/dates'
import { focusAround } from '@/lib/focusWhenGone'
import { StaticControlsContext, useLiveControls } from '@/lib/liveControls'
import { shownEmptyState } from '@/lib/taskFocus'
import { useLatest } from '@/lib/useLatest'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { useViewVisibility } from '@/lib/viewVisibility'
import { STALL } from '@/store/liveParts'
import type { FigureView, ListKind, ListView, OverviewView } from '@/store/overviewLists'
import type { StoreVersion } from '@/store/updates'
import type { Figure, Missing, OverviewRow } from '../../convex/lib/overview'
import { NoProjects } from '../components/NoProjects'
import {
  Avatar,
  EmptyState,
  Icon,
  PausedMark,
  ProgressBar,
  ProjectName,
  StatusDot,
} from '../components/qivo'
import { TasksLoadingView } from '../components/TasksLoading'
import { ViewNote } from '../components/ViewNote'
import { type IssueVM, type MilestoneVM, P, type ScopeInfo } from '../store/planner'
import { overviewRequest } from './overview/overviewArgs'
import { healthRows, statusCounts } from './overviewFigures'
import { useOverviewPanelClipping } from './useOverviewPanelClipping'
import { useViewsNews } from './useViewsNews'
import './Overview.css'
import '../styles/mobile-views.css'

function OvSection({
  title,
  action,
  children,
}: {
  title: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="overview-section">
      <div className="overview-section-body">
        <div className="overview-section-heading [display:flex] [align-items:center] [min-height:32px] [gap:8px] [margin-bottom:8px]">
          <h2 className="m-0 text-md font-semibold text-text-1">{title}</h2>
          {action && (
            <>
              <div className="[flex:1]" />
              {action}
            </>
          )}
        </div>
        {children}
      </div>
      <div className="overview-section-foot" aria-hidden="true" />
    </section>
  )
}

/* ═══ The figures as the page shows them ════════════════════════════════════
   Each figure is on its way, kept from before and refreshing, given,
   counting, unavailable for a reason, or failed. A figure that is not
   given never shows a number, so a count the server could not read whole
   never reads as a smaller one or as zero. */

/** What a figure's element says of its state (data-ov-figure-state). */
type FigureState = 'loading' | 'refreshing' | 'ok' | 'counting' | 'unavailable' | 'error'

/** A figure as the page shows it. `scope` is a refusal of the read's whole
    scope, which only the figure shows where the read is not the summary. */
type Shown<T> =
  | { state: 'loading' | 'error' | 'counting' }
  | { state: 'ok' | 'refreshing'; value: T }
  | { state: 'unavailable'; reason: Exclude<Missing, 'counting'> | 'scope' }

/** The figure `pick` takes from read `read`'s ok answer, as the page shows
    it: refreshing where the answer was kept, not current. */
function shownOf<A extends { state: string }, F extends object>(
  read: FigureView<A>,
  pick: (ok: Extract<A, { state: 'ok' }>) => Figure<F>,
): Shown<F> {
  if (read === null) return { state: 'loading' }
  if (read.error !== undefined) return { state: 'error' }
  const answer = read.value as A
  if (answer.state !== 'ok') return { state: 'unavailable', reason: 'scope' }
  const figure = pick(answer as Extract<A, { state: 'ok' }>)
  if (figure.state === 'ok') return { state: read.current ? 'ok' : 'refreshing', value: figure }
  if (figure.reason === 'counting') return { state: 'counting' }
  return { state: 'unavailable', reason: figure.reason }
}

/** The value of `figure` where it is given, else null. */
const given = <T,>(figure: Shown<T>): T | null =>
  figure.state === 'ok' || figure.state === 'refreshing' ? figure.value : null

/** The data attributes of figure `name` in `figure`'s state. */
const figureAttrs = (name: string, figure: Shown<unknown>) => ({
  'data-ov-figure': name,
  'data-ov-figure-state': figure.state satisfies FigureState,
  ...(figure.state === 'unavailable' && figure.reason !== 'scope'
    ? { 'data-ov-reason': figure.reason }
    : {}),
})

/** What a figure cell shows where no number is given: "…" on its way,
    "Counting…" while the counts are not whole, and the dash the page uses
    for a missing value otherwise. */
const placeholder = (figure: Shown<unknown>) =>
  figure.state === 'loading' ? '…' : figure.state === 'counting' ? 'Counting…' : '—'

/* ═══ The status strip ══════════════════════════════════════════════════════
   One box carrying every scope-level fact, where a row of five separate tiles
   used to stand.

   The tiles were not wrong about WHAT to show — they were wrong about weight.
   Five equal cards, each with its own border, its own shadow and its own 24px
   mono number, spent the whole top of the page saying that "Blocked · 3" and
   "Next milestone" are the same size of thing. They are not: one is an
   emergency and one is a date. Collapsing them into a single bordered box
   costs nothing in content — every number below is the number that was in a
   tile — and buys back roughly half the vertical space before the first row of
   real information, plus one border instead of five.

   The values are mono because they are measurements. The lead is NOT: a name
   set in mono at 24px reads as a measurement, which is why that cell keeps its
   own shape — an avatar and a name in the sans face — exactly as the tile it
   replaces did (#76: the top bar's 20px lead avatar had no name, no label and
   no room for either, and this is where it went). */
const statLabelClass = 'mb-2 text-sm text-text-2'
const statSubClass = 'mt-2 text-sm leading-relaxed text-text-2'

function OvStat({
  label,
  value,
  sub,
  valueClassName,
  className,
  figure,
  children,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  valueClassName?: string
  className?: string
  /** the figure the cell shows (data-ov-figure), with its state */
  figure?: { name: string; shown: Shown<unknown> }
  children?: ReactNode
}) {
  return (
    <div
      className={cn('min-w-0 break-words', className)}
      {...(figure ? figureAttrs(figure.name, figure.shown) : {})}
    >
      <div className={statLabelClass}>{label}</div>
      <div
        className={cn('font-mono text-xl leading-tight font-semibold text-text-1', valueClassName)}
      >
        {value}
      </div>
      {children && <div className="[margin-top:8px]">{children}</div>}
      {sub && <div className={statSubClass}>{sub}</div>}
    </div>
  )
}

/* Who is accountable for this scope — the strip's first cell, and the one that
   names a PERSON rather than a number.
   Only a scope that NAMES a project has a lead: across all of them there is no
   such person, so the cell is absent and the strip closes over the gap. A
   project whose lead seat is empty has none either. */
function OvLeadStat({ info }: { info: ScopeInfo }) {
  const proj = info.proj
  const leadId = proj ? P.leadOf(proj.id) : null
  const u = leadId ? P.user(leadId) : null
  if (!u) return null
  // Inheritance changes who is accountable, so keep it explicit. The owning
  // team remains in project settings; repeating it here dilutes the identity.
  const meta = info.metas[0]
  const inherited = !proj.lead && !!meta && meta.id !== proj.id
  return (
    <div data-ov-lead={u.id} className="flex min-w-0 items-center gap-3">
      <Avatar id={u.id} size={40} />
      <div className="min-w-0 break-words">
        <div className="mb-1 text-sm text-text-2">Lead</div>
        <div className="text-md font-semibold leading-snug text-text-1">{u.name}</div>
        {inherited && <div className={statSubClass}>Inherited from {meta.name}</div>}
      </div>
    </div>
  )
}

/* stacked status-distribution bar; a segment paints the palette's
   --status-fill-<status> where one is set, else the status ink */
const statusBarSizeClasses = {
  6: 'h-[6px] rounded-[6px]',
  7: 'h-[7px] rounded-[7px]',
  8: 'h-[8px] rounded-[8px]',
} as const

/** The stacked status bar of `counts`, the leaves by status, empty while
    they are not given (null). */
function OvStatusBar({
  counts,
  height = 7,
}: {
  counts: Record<string, number> | null
  height?: keyof typeof statusBarSizeClasses
}) {
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0
  if (!counts || !total) return <div className={cn('bg-surface-3', statusBarSizeClasses[height])} />
  return (
    <div className={cn('flex overflow-hidden bg-surface-3', statusBarSizeClasses[height])}>
      {P.STATUSES.map((s) => {
        const n = counts[s.id]
        return n ? (
          <HoverTooltip key={s.id} content={`${s.name}, ${n}`}>
            <div
              style={{
                width: `${(n / total) * 100}%`,
                background: `var(--status-fill-${s.id}, ${s.tone})`,
              }}
            />
          </HoverTooltip>
        ) : null
      })}
    </div>
  )
}

/** The legend of `counts`, each status with its count, or `missing` in
    place of every count while they are not given (null). */
function OvStatusLegend({
  counts,
  missing,
}: {
  counts: Record<string, number> | null
  missing: string
}) {
  return (
    <div className="[display:flex] [flex-wrap:wrap] [gap:4px_16px]">
      {P.STATUSES.map((s) => (
        <span
          key={s.id}
          className="[display:inline-flex] [align-items:center] [gap:5px] [font-size:var(--fs-xs)] [color:var(--text-2)]"
        >
          <StatusDot status={s.id} size={12} />
          {s.name}{' '}
          <span className="!font-mono [color:var(--text-3)]">
            {counts ? (counts[s.id] ?? 0) : missing}
          </span>
        </span>
      ))}
    </div>
  )
}

/* ═══ Health, as a table ════════════════════════════════════════════════════
   One row per group: a sub-project inside one project, a whole project across
   all of them (deviation #47). Everything is derived from the group's ISSUES
   and sub-project ids, so the same row serves both altitudes.

   THIS WAS A GRID OF CARDS. Cards are right for four of them and wrong for
   twenty: a wall you scan rather than read, with no way to ask the one question
   the section exists to answer — WHICH of these is worst. Every number the card
   carried is still here; what the table adds is that any of them can be sorted
   on, and what it costs is the per-card status bar's size, now a 110px sparkbar
   in the Progress cell. That bar is deliberately the STACKED distribution
   rather than a plain progress bar: its done segment already IS the progress,
   so the stacked one says strictly more in the same width.

   NO MILESTONE COLUMN. A milestone belongs to a project (0078), not to a
   sub-project — the Milestones section below is where it lives, and at this
   altitude the same date would either repeat down every row of a project's
   table or be blank on all of them.

   The columns that count trouble are BLANK at zero, not "0". Colour marks the
   exception (tokens.css), and so does presence: a column of noughts is a column
   of decorations of exactly the weight of the one number that matters. */
const HEALTH_COLS = [
  { id: 'name', label: '', align: 'left', dir: 'asc', title: '' },
  { id: 'lead', label: 'Lead', align: 'left', dir: 'asc', title: '' },
  {
    id: 'progress',
    label: 'Progress',
    align: 'left',
    dir: 'desc',
    title: '',
  },
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
  {
    id: 'paused',
    label: 'Paused',
    align: 'right',
    dir: 'desc',
    title: 'Tasks on hold',
  },
] as const

const tdClass = 'border-b border-border px-3 py-2 text-base text-text-1'
const troubleToneClasses = {
  late: 'text-[color:var(--pressure-over)]',
  behind: 'text-[color:var(--pressure-warn)]',
  paused: 'text-[color:var(--warn)]',
} as const

/* A count that says nothing when there is nothing to say. The `data-ovcell`
   hook is how a drive reads one number off one row: the health CARD had no hook
   at all and verify-delay-status had to find it by "the button containing
   'Enclosure' and the words 'tasks done'". A cell that a check depends on gets
   a name (design-spec §7.2 — renaming these is a breaking change). */
function TroubleCell({
  id,
  n,
  last,
}: {
  id: keyof typeof troubleToneClasses
  n: number
  last: boolean
}) {
  return (
    <td
      data-ovcell={id}
      className={cn(
        tdClass,
        'text-right font-mono',
        n > 0 ? troubleToneClasses[id] : 'text-text-3',
        last && 'border-b-0',
      )}
    >
      {n > 0 ? n : '—'}
    </td>
  )
}

function OvHealthTable({ rows, unit, sort, setSort, onOpen, mobile }) {
  /* Clicking a heading sorts by it; clicking the one already sorted flips the
     direction. Every column has its OWN natural first direction — a name wants
     A→Z and a delay count wants worst-first — because a table that always
     starts ascending makes you click twice to ask the question you meant. */
  const click = (c: (typeof HEALTH_COLS)[number]) =>
    setSort((s) =>
      s.key === c.id
        ? { key: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key: c.id, dir: c.dir },
    )
  if (mobile) {
    return (
      <div className="mobile-health-list" data-ov-table>
        <div className="mobile-health-sort">
          <label htmlFor="overview-health-sort">Sort by</label>
          <NativeSelect
            id="overview-health-sort"
            className="shadow-none"
            value={sort.key}
            onChange={(e) => {
              const col = HEALTH_COLS.find((c) => c.id === e.target.value)
              if (col) setSort({ key: col.id, dir: col.dir })
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
            aria-label={`Sort ${sort.dir === 'asc' ? 'descending' : 'ascending'}`}
            onClick={() => setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))}
          >
            <Icon name={sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={16} />
          </Button>
        </div>
        {rows.map((r) => (
          <Button
            key={r.proj.id}
            type="button"
            variant="unstyled"
            data-ovcard={r.proj.id}
            className="mobile-health-card"
            onClick={() => onOpen(r.proj.id)}
          >
            <span className="mobile-health-heading">
              <strong>
                <ProjectName project={r.proj} wrap />
              </strong>
              <Icon name="chevronRight" size={16} />
            </span>
            <span className="mobile-health-progress" data-ovcell="progress">
              <span>
                <OvStatusBar counts={statusCounts(r.issues)} height={6} />
              </span>
              <span className="font-mono">{r.pct}%</span>
            </span>
            <span className="mobile-health-facts">
              <span data-ovcell="done">
                {r.done}/{r.total} done
              </span>
              <span data-ovcell="left">{r.remaining}h left</span>
              <span data-ovcell="late" className={cn(r.late && troubleToneClasses.late)}>
                {r.late} delayed
              </span>
              <span data-ovcell="behind" className={cn(r.behind && troubleToneClasses.behind)}>
                {r.behind} slipping
              </span>
              <span data-ovcell="paused" className={cn(r.paused && troubleToneClasses.paused)}>
                {r.paused} paused
              </span>
            </span>
            <span className="mobile-health-lead" data-ovcell="lead">
              {r.lead ? (
                <>
                  <Avatar id={r.lead.id} size={28} />
                  <span>{r.lead.name}, Lead</span>
                </>
              ) : (
                'No lead assigned'
              )}
            </span>
          </Button>
        ))}
      </div>
    )
  }
  return (
    <div
      data-ov-table
      className="[background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-card)] [overflow-x:auto]"
    >
      <table className="[width:100%] [border-collapse:collapse]">
        <thead>
          <tr>
            {HEALTH_COLS.map((c) => (
              /* One tooltip, on the BUTTON: a tooltip on the <th> as well would
                 only ever show in the cell's padding, and the two would take
                 turns depending on where the pointer landed. */
              <th
                key={c.id}
                className={cn(
                  'border-b border-border px-3 py-2 text-sm font-medium text-text-2 whitespace-nowrap',
                  c.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                <Button
                  type="button"
                  onClick={() => click(c)}
                  title={c.title || undefined}
                  className={cn(
                    '[display:inline-flex] [align-items:center] [min-height:32px] [gap:4px] [border:none] [background:transparent] [padding:0] [font:inherit] [letter-spacing:inherit] [text-transform:inherit] [cursor:pointer]',
                    sort.key === c.id ? 'text-text-1' : 'text-inherit',
                  )}
                  variant="unstyled"
                >
                  {c.label || unit}
                  {sort.key === c.id && (
                    <Icon
                      name={sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'}
                      size={11}
                      color="var(--primary)"
                    />
                  )}
                </Button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i: number) => {
            // the last row's rule would land one pixel inside the panel's own
            // bottom border — two lines where the card had one
            const last = i === rows.length - 1
            return (
              /* The row is the target for a pointer and the NAME is the target for
               a keyboard. Keep the row out of the Tab order; focus on its name
               also opens the shared tooltip. The button stops the
               click from reaching the row so one press is one navigation. */
              <HoverTooltip key={r.proj.id} content={`Open the ${r.proj.name} board`}>
                <tr
                  data-ovcard={r.proj.id}
                  onClick={() => onOpen(r.proj.id)}
                  tabIndex={-1}
                  className="[cursor:pointer] [transition:background-color_var(--dur-fast)_var(--ease-out)]"
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--hover)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <td
                    className={cn(
                      tdClass,
                      'max-w-60 font-medium text-text-1',
                      last && 'border-b-0',
                    )}
                  >
                    <Button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpen(r.proj.id)
                      }}
                      className="[border:none] [background:transparent] [padding:0] [font:inherit] [color:inherit] [cursor:pointer] [max-width:100%] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] [display:block] [text-align:left]"
                      variant="unstyled"
                    >
                      <ProjectName project={r.proj} />
                    </Button>
                  </td>
                  <td data-ovcell="lead" className={cn(tdClass, last && 'border-b-0')}>
                    {r.lead ? (
                      <Avatar id={r.lead.id} size={28} />
                    ) : (
                      <span className="[color:var(--text-3)]">—</span>
                    )}
                  </td>
                  <td data-ovcell="progress" className={cn(tdClass, last && 'border-b-0')}>
                    <span className="[display:inline-flex] [align-items:center] [gap:8px]">
                      <span className="[width:110px] [display:inline-block]">
                        <OvStatusBar counts={statusCounts(r.issues)} height={6} />
                      </span>
                      <span className="!font-mono [font-size:var(--fs-xs)] [color:var(--text-1)]">
                        {r.pct}%
                      </span>
                    </span>
                  </td>
                  <td
                    data-ovcell="done"
                    className={cn(
                      tdClass,
                      'text-right font-mono whitespace-nowrap',
                      last && 'border-b-0',
                    )}
                  >
                    {r.done}/{r.total}
                  </td>
                  <td
                    data-ovcell="left"
                    className={cn(tdClass, 'text-right font-mono', last && 'border-b-0')}
                  >
                    {r.remaining > 0 ? (
                      `${r.remaining}h`
                    ) : (
                      <span className="[color:var(--text-3)]">—</span>
                    )}
                  </td>
                  <TroubleCell id="late" last={last} n={r.late} />
                  <TroubleCell id="behind" last={last} n={r.behind} />
                  <TroubleCell id="paused" last={last} n={r.paused} />
                </tr>
              </HoverTooltip>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* The two task lists show the server's batches. A row renders again only
   when its task object, its marker, the store's context (P.contextVersion,
   for the names it reads) or `wide` changes, and mounts no tooltip roots
   until a mouse points at it or keyboard focus reaches it. */
type OvRowProps = {
  it: IssueVM
  wide: boolean
  context: StoreVersion
  onOpen: (id: string) => void
}

/** A list row's frame: a static scope until it is used, around the row's
    button, which carries the task's title as its tooltip. */
function OvRowFrame({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const controls = useLiveControls(root)
  return (
    <div ref={root} {...controls.rootProps}>
      <StaticControlsContext.Provider value={controls.value}>
        {children}
      </StaticControlsContext.Provider>
    </div>
  )
}

const OV_ROW =
  '[display:flex] [align-items:center] [gap:8px] [width:100%] [text-align:left] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)] [color:var(--text-1)] [transition:background-color_var(--dur-fast)_var(--ease-out),_border-color_var(--dur-fast)_var(--ease-out)] [font-family:var(--sans)] [cursor:pointer]'
const hoverOn = (e: MouseEvent<HTMLElement>) => {
  e.currentTarget.style.background = 'var(--hover)'
  e.currentTarget.style.borderColor = 'var(--border-strong)'
}
const hoverOff = (e: MouseEvent<HTMLElement>) => {
  // Hand the rest state back to CSS: themes paint these rows clear
  // over the translucent section material.
  e.currentTarget.style.removeProperty('background')
  e.currentTarget.style.removeProperty('border-color')
}

/** Where a row's task lives: the sub-project alone inside one project, the
    owning project too in My view, where every project is on screen at
    once. */
function OvRowPlace({ it, wide }: { it: IssueVM; wide: boolean }) {
  const place = P.projectPlace(it.project, wide)
  if (!place) return null
  return (
    <HoverTooltip content={P.placeLabel(place)}>
      <span tabIndex={-1} className={cn('truncate', wide ? 'max-w-[190px]' : 'max-w-[120px]')}>
        <ProjectName {...place} />
      </span>
    </HoverTooltip>
  )
}

/* these rows no longer carry the board's delay edge, only a plain border:
   every row in an "Overdue & at risk" section is at risk by definition, so the
   edge was restating the heading above it rather than adding anything */
const OvPausedRow = memo(function OvPausedRow({ it, wide, onOpen }: OvRowProps) {
  return (
    <OvRowFrame>
      <Button
        type="button"
        data-ovrow={it.id}
        data-focus-key="row"
        onClick={() => onOpen(it.id)}
        title={it.title}
        className={OV_ROW}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        variant="unstyled"
      >
        <PausedMark />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 break-words text-base leading-[1.4]">{it.title}</span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
            <OvRowPlace it={it} wide={wide} />
          </span>
        </span>
        {it.owner && <Avatar id={it.owner} size={28} />}
      </Button>
    </OvRowFrame>
  )
})

/** An At-risk row's verdict as its answer judged it on the server, with the
    due date it judged and the day it judged on, so the row's date and its
    marker never come from two sources. */
type AtRisk = {
  risk: NonNullable<OverviewRow['at_risk']>
  due: string
  day: string
}

/* Whether two verdicts say the same. */
const sameRisk = (a: AtRisk['risk'], b: AtRisk['risk']) =>
  a.kind === b.kind &&
  (a.kind !== 'projected' || (b.kind === 'projected' && a.finish_week === b.finish_week))

/* one deadline row: overdue, projected by the capacity walk (0064) to miss
   its due date in a project that tracks delay, or a candidate whose risk
   the server could not judge, which may not be late */
const OvAtRiskRow = memo(
  function OvAtRiskRow({ it, wide, onOpen, risk, due, day }: OvRowProps & AtRisk) {
    // never less than a day: the answer judged it overdue on `day`
    const days = Math.max(
      1,
      Math.round((P.isoToDate(day).getTime() - P.isoToDate(due).getTime()) / 86400000),
    )
    const fin =
      risk.kind === 'projected' && risk.finish_week
        ? `, projected to finish in the week of ${P.fmtDate(P.isoToDate(risk.finish_week))}`
        : ''
    const marker =
      risk.kind === 'overdue'
        ? `${days}d overdue`
        : risk.kind === 'projected'
          ? 'projected to miss'
          : 'risk unknown'
    return (
      <OvRowFrame>
        <Button
          type="button"
          data-atrisk={it.id}
          data-risk={risk.kind}
          data-focus-key="row"
          onClick={() => onOpen(it.id)}
          title={`${it.title}, due ${P.fmtISO(due)}${fin}${risk.kind === 'unknown' ? ', risk unknown' : ''}`}
          className={OV_ROW}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
          variant="unstyled"
        >
          {/* the icon separates this section's rows from the paused ones by SHAPE —
            the red date text beside it is the one signal that carries a number */}
          <Icon name="calendar" size={13} color="var(--text-3)" />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 break-words text-base leading-[1.4]">{it.title}</span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
              <span
                className={cn(
                  'whitespace-nowrap !font-mono',
                  risk.kind === 'unknown' ? 'text-text-3' : 'text-danger',
                )}
              >
                {P.fmtISO(due)}, {marker}
              </span>
              <OvRowPlace it={it} wide={wide} />
            </span>
          </span>
          {it.owner && <Avatar id={it.owner} size={28} />}
        </Button>
      </OvRowFrame>
    )
  },
  (a, b) =>
    a.it === b.it &&
    a.wide === b.wide &&
    a.context === b.context &&
    a.onOpen === b.onOpen &&
    a.due === b.due &&
    a.day === b.day &&
    sameRisk(a.risk, b.risk),
)

/** The model a list row shows: the workspace's where it holds the task,
    else the model the store shaped from the answer's row, in the batch's
    view slot or any other (store/viewRows.ts). */
function modelOf(slot: string, row: OverviewRow): IssueVM | undefined {
  const handle = P.handleOf(row.id)
  if (handle !== null) return P.issueById[handle]
  return P.viewTask(slot, row.id) ?? P.anyTask(P.handleNow(row.id, row.org_id, row.num))
}

/** `active` once it held for STALL.ms under the same `key`. */
function useStall(active: boolean, key: string): boolean {
  const [fired, setFired] = useStateO<string | null>(null)
  useEffect(() => {
    if (!active) {
      setFired(null)
      return
    }
    const timer = setTimeout(() => setFired(key), STALL.ms)
    return () => clearTimeout(timer)
  }, [active, key])
  return active && fired === key
}

const listNoteClass =
  '[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic] [padding:4px_2px]'

/** What one batch says in place, after its rows: its reads stopped, or it
    failed, with Try again (a failed Load more's Retry keeps its place). */
function BatchNote({
  note,
  first,
  last,
  onRetry,
}: {
  note: NonNullable<ListView['batches'][number]['note']>
  first: boolean
  last: boolean
  onRetry: () => void
}) {
  if (note.kind === 'incomplete')
    return (
      <div data-ov-incomplete className={listNoteClass}>
        Qivo checked part of the list. Load more continues.
      </div>
    )
  const text =
    note.kind === 'over_budget'
      ? first
        ? 'Qivo could not check this list.'
        : last
          ? 'Qivo could not check the rest of this list.'
          : 'Qivo could not check part of this list.'
      : note.kind === 'unavailable'
        ? (note.message ?? 'Qivo cannot show this list here.')
        : first
          ? 'This list could not be loaded.'
          : "Couldn't load more tasks."
  return (
    <div
      role="alert"
      data-ov-batch-note={note.kind}
      className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
    >
      {text}
      <Button type="button" variant="ghost" className="h-control-sm text-sm" onClick={onRetry}>
        {note.kind === 'error' && !first ? 'Retry' : 'Try again'}
      </Button>
    </div>
  )
}

/** One of the Overview's lists: its batches' rows in the server's order,
    each batch's note in place, Load more, and at the top where the cap
    dropped earlier batches, a way back to the start. A row the person's
    own pending archive or delete took away leaves at once; every other
    change waits for the answers. A row whose task has no model to show
    leaves the list loading, and STALL.ms after the workspace loaded,
    incomplete, never at its end. */
function OvList({
  kind,
  list,
  wide,
  day,
  emptyText,
  onOpen,
}: {
  kind: ListKind
  list: ListView
  wide: boolean
  /** the day the At-risk list's answers were judged on */
  day: string
  emptyText: string
  onOpen: (id: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const own = P.ownPaintedTasks()
  let missing = 0
  let shown = 0
  let unknown = false
  const batches = list.batches.map((batch, i) => {
    const rows: ReactNode[] = []
    for (const row of batch.rows) {
      // the person's own archive or delete takes the row away at once
      if (own.has(row.id) && !P.ownOnScreen(batch.slot, row.id)) continue
      const it = modelOf(batch.slot, row)
      if (!it) {
        missing++
        continue
      }
      shown++
      if (kind === 'paused') {
        rows.push(
          <OvPausedRow
            key={row.id}
            it={it}
            wide={wide}
            context={P.contextVersion}
            onOpen={onOpen}
          />,
        )
        continue
      }
      const risk = row.at_risk ?? { kind: 'unknown' as const }
      if (risk.kind === 'unknown') unknown = true
      rows.push(
        <OvAtRiskRow
          key={row.id}
          it={it}
          wide={wide}
          context={P.contextVersion}
          onOpen={onOpen}
          risk={risk}
          due={row.due_date ?? it.due}
          day={day}
        />,
      )
    }
    // a batch with nothing to show takes no room in the list
    if (rows.length === 0 && !batch.waiting && !batch.note) return null
    return (
      <div key={batch.id} data-ov-batch={batch.id} className="flex flex-col gap-2">
        {rows}
        {batch.waiting && (
          <div role="status" className={listNoteClass}>
            Loading…
          </div>
        )}
        {batch.note && (
          <BatchNote
            note={batch.note}
            first={i === 0 && !list.dropped}
            last={i === list.batches.length - 1}
            onRetry={() => P.overviewRetry(kind, batch.id)}
          />
        )}
      </div>
    )
  })
  const stalled = useStall(missing > 0 && P.stillLoading() === null, kind)
  const end = list.end && missing === 0
  const state = missing > 0 ? (stalled ? 'incomplete' : 'loading') : list.state
  // where earlier batches went, the first batch left on screen keeps its
  // place in the pane, measured from the pane's top in its content
  const first = list.batches[0]?.id
  const places = useRef(new Map<number, number>())
  const lastFirst = useRef(first)
  useLayoutEffect(() => {
    const pane = root.current?.closest<HTMLElement>('[data-scroll]')
    if (!root.current || !pane) return
    const top = pane.getBoundingClientRect().top - pane.scrollTop
    const measure = () => {
      const now = new Map<number, number>()
      for (const element of root.current?.querySelectorAll<HTMLElement>('[data-ov-batch]') ?? [])
        now.set(Number(element.dataset.ovBatch), element.getBoundingClientRect().top - top)
      return now
    }
    const now = measure()
    if (first !== lastFirst.current && first !== undefined && list.dropped) {
      const was = places.current.get(first)
      const is = now.get(first)
      if (was !== undefined && is !== undefined && was !== is) pane.scrollTop += is - was
    }
    lastFirst.current = first
    places.current = measure()
  })
  return (
    <div
      ref={root}
      data-ov-list={kind}
      data-ov-list-state={state}
      data-ov-list-end={end ? '' : undefined}
      data-ov-batches={list.batches.length}
      aria-busy={
        state === 'loading' || state === 'refreshing' || list.more === 'loading' || undefined
      }
      className="[display:flex] [flex-direction:column] [gap:8px]"
    >
      {list.dropped && (
        <div
          data-ov-dropped
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
        >
          Earlier tasks are not shown.
          <Button
            type="button"
            variant="ghost"
            data-ov-from-start
            className="h-control-sm text-sm"
            onClick={() => P.overviewFromStart(kind)}
          >
            Show from the start
          </Button>
        </div>
      )}
      {list.failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-text-2"
        >
          This list could not be loaded.
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm text-sm"
            onClick={() => P.overviewFromStart(kind)}
          >
            Try again
          </Button>
        </div>
      ) : list.batches.length === 0 || (list.state === 'loading' && shown === 0) ? (
        <div role="status" className={listNoteClass}>
          Loading…
        </div>
      ) : (
        batches
      )}
      {unknown && (
        <div data-ov-unknown className="text-sm text-text-2">
          Qivo could not read some owners' other work, so tasks marked risk unknown may not be late.
        </div>
      )}
      {/* only once the list's answer ends with no row: a row the person's
          own archive took away leaves no empty line before the answer */}
      {end && !list.dropped && list.batches.every((b) => b.rows.length === 0) && (
        <div className={listNoteClass}>{emptyText}</div>
      )}
      {list.more !== null && (
        <Button
          type="button"
          variant="outline"
          data-ov-more
          disabled={list.more === 'loading'}
          aria-busy={list.more === 'loading' || undefined}
          className="self-start"
          onClick={() => P.overviewMore(kind)}
        >
          {list.more === 'loading' ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

function OvMilestoneRow({
  m,
  next,
  owner,
  onEdit,
}: {
  m: MilestoneVM
  next: boolean
  owner?: string | null
  onEdit: (id: string) => void
}) {
  const delta = relativeWeek(m.week)
  return (
    <Button
      type="button"
      onClick={() => onEdit(m.id)}
      title={`Edit “${m.name}”${owner ? `, ${owner}` : ''}`}
      data-overview-milestone={m.id}
      data-next={next ? '' : undefined}
      className={cn(
        'overview-milestone min-h-16 w-full justify-start gap-3 whitespace-normal rounded-md p-3 text-left font-sans',
        next && 'border-primary bg-primary-soft hover:border-primary hover:bg-primary-soft',
      )}
    >
      <span
        aria-hidden="true"
        className="size-[9px] shrink-0 rotate-45 rounded-[var(--r-2xs)] bg-[var(--milestone)]"
      />
      <span className="overview-milestone-text flex min-w-0 flex-1 flex-col gap-1">
        {/* Project context stays with the name instead of competing with the dates. */}
        {owner && <span className="break-words text-xs text-text-3">{owner}</span>}
        <span
          className={cn(
            'break-words text-base leading-snug',
            next ? 'font-semibold' : 'font-medium',
          )}
        >
          {m.name}
        </span>
      </span>
      <span className="overview-milestone-date flex shrink-0 flex-col items-end gap-1">
        <Badge variant="secondary" className="bg-hover font-medium text-text-1">
          {delta}
        </Badge>
        <time
          dateTime={weekToISO(m.week)}
          className="whitespace-nowrap font-mono text-xs text-text-2"
        >
          {P.weekLabel(m.week)}
        </time>
      </span>
    </Button>
  )
}

/* ═══ What to do ════════════════════════════════════════════════════════════
   The page's opening line: one sentence naming the thing worth doing next.

   THE LOGIC HERE IS PROVISIONAL AND DELIBERATELY DULL, and this function is the
   only place it lives — nothing below reads these branches, so rewriting it
   cannot disturb the layout. It is a first-match ladder over the figures the
   page shows, ordered by how much a person can do about them:

     a lost deadline  →  a deadline about to be lost  →  a deadline Qivo
     could not check  →  something stuck  →  nothing moving  →  nothing wrong

   Two rules it must keep whatever replaces it. It may not state a number this
   page does not also show, or the sentence and the strip under it will disagree
   the first time a filter or a scope changes one of them. And it must have
   something to say when everything is fine: a line that appears only in trouble
   trains people to read its absence as "the page is broken". It never says
   there are no deadline warnings while Overdue or the projection is not
   given, and it waits while either is on its way.

   The exception numbers are painted, the rest are not — colour marks the
   exception (tokens.css), and "6 under way" is not one. */
function OvSummary({
  overdue,
  projected,
  counts,
}: {
  overdue: Shown<{ count: number }>
  projected: Shown<{ count: number }>
  counts: Shown<{ leaves: Record<string, number>; paused: number }>
}) {
  const num = (
    n: number,
    tone: 'danger' | 'warning' | 'neutral' = 'neutral',
    figure?: [string, Shown<unknown>],
  ) => (
    <b
      {...(figure ? figureAttrs(figure[0], figure[1]) : {})}
      className={cn(
        '!font-mono font-semibold',
        { danger: 'text-danger', warning: 'text-warning', neutral: 'text-text-1' }[tone],
      )}
    >
      {n}
    </b>
  )
  const task = (n: number) => (n === 1 ? ' task' : ' tasks')
  const late = given(overdue)?.count ?? null
  const miss = given(projected)?.count ?? null
  const c = given(counts)
  const waits =
    overdue.state === 'loading' ||
    projected.state === 'loading' ||
    (late === 0 && miss === 0 && counts.state === 'loading')
  let body: ReactNode
  if (waits) body = '…'
  else if (late !== null && late > 0) {
    body = (
      <>
        {num(late, 'danger', ['overdue', overdue])}
        {task(late)} {late === 1 ? 'is' : 'are'} overdue
        {miss !== null && miss > 0 ? (
          <>
            ; {num(miss, 'danger', ['projected', projected])} more projected to miss their due date
          </>
        ) : (
          ''
        )}
        .
      </>
    )
  } else if (late === 0 && miss !== null && miss > 0) {
    body = (
      <>
        {num(miss, 'danger', ['projected', projected])}
        {task(miss)} {miss === 1 ? 'is' : 'are'} projected to miss
        {miss === 1 ? ' its' : ' their'} due date.
      </>
    )
  } else if (late === null || miss === null) {
    body = 'Qivo could not check every deadline here.'
  } else if (counts.state === 'counting') {
    body = 'Qivo is counting the tasks here.'
  } else if (c === null) {
    body = 'Qivo could not count the tasks here.'
  } else {
    const leaves = Object.values(c.leaves).reduce((n, v) => n + v, 0)
    const done = c.leaves.done ?? 0
    const inProgress = c.leaves.progress ?? 0
    if (c.paused > 0)
      body = (
        <>
          {num(c.paused, 'warning')}
          {task(c.paused)} {c.paused === 1 ? 'is' : 'are'} paused.
        </>
      )
    else if (leaves > 0 && done === leaves)
      body = (
        <>
          {num(leaves)}
          {task(leaves)} done.
        </>
      )
    else if (inProgress === 0)
      body = (
        <>
          {num(leaves - done)}
          {task(leaves - done)} {leaves - done === 1 ? 'remains' : 'remain'}.
        </>
      )
    else
      body = (
        <>
          {num(inProgress)}
          {task(inProgress)} in progress. No deadline warnings or paused tasks.
        </>
      )
  }
  return (
    <p
      data-ov-summary
      aria-busy={waits || undefined}
      className="m-0 max-w-[65ch] text-base leading-relaxed text-text-1"
    >
      {body}
    </p>
  )
}

/** Where a figure that does not fit one request can still be read: a
    top-level project's sub-projects, My view's projects. */
const narrower = (info: ScopeInfo) =>
  info.isMeta
    ? ' Open a sub-project to see its figures.'
    : info.mine
      ? ' Open a project to see its figures.'
      : ''

/** Whether every seat of the login that `info` reads is a guest's or an
    organization Viewer's, whose reads see other people's work one person
    at a time (convex/lib/overview.ts verdicts). */
function onePersonAtATime(info: ScopeInfo): boolean {
  const seats = P.myProfileIds.map((id) => P.user(id)).filter((u) => !!u)
  const read = info.mine ? seats : seats.filter((u) => u.org === info.proj?.org)
  return read.length > 0 && read.every((u) => u.orgRole !== 'admin' && u.orgRole !== 'user')
}

/** Why a figure is not given, as the strip's last row, each line naming
    its figure (data-ov-figure): the counts while Qivo counts them or could
    not, Overdue, and the projection. */
function OvFigureNotes({
  info,
  counts,
  overdue,
  projected,
  onRetry,
}: {
  info: ScopeInfo
  counts: Shown<unknown>
  overdue: Shown<unknown>
  projected: Shown<unknown>
  onRetry: () => void
}) {
  const lines: ReactNode[] = []
  if (counts.state === 'counting')
    lines.push(
      <p key="counting" data-ov-counting>
        Qivo is counting the tasks here. The figures show once it is done.
      </p>,
    )
  if (counts.state === 'unavailable')
    lines.push(
      <p key="counts" data-ov-counts-note>
        Qivo could not count the tasks here in one request.{narrower(info)}
      </p>,
    )
  if (overdue.state === 'unavailable')
    lines.push(
      <p key="overdue" {...figureAttrs('overdue', overdue)}>
        Qivo could not count every overdue task here in one request. Done tasks count toward that
        until the nightly archive takes them, 30 days after they were done.{narrower(info)}
      </p>,
    )
  if (projected.state === 'unavailable')
    lines.push(
      <p key="projected" {...figureAttrs('projected', projected)}>
        {projected.reason === 'budget'
          ? 'Qivo could not work out every projected delay here in one request.'
          : projected.reason === 'loads'
            ? onePersonAtATime(info)
              ? 'Your access shows other people’s work one person at a time, so projected delays are not available here.'
              : info.mine
                ? 'Qivo could not read everyone’s other work, so projected delays are not available here.'
                : 'Someone here has more open work than Qivo reads at once, so projected delays are not available.'
            : 'Qivo cannot work out projected delays here.'}
      </p>,
    )
  const failed = overdue.state === 'error' || projected.state === 'error'
  if (failed)
    lines.push(
      <p
        key="error"
        {...figureAttrs(projected.state === 'error' ? 'projected' : 'overdue', { state: 'error' })}
        className="flex flex-wrap items-center gap-2"
      >
        Qivo could not check the deadlines here.
        <Button type="button" variant="ghost" className="h-control-sm text-sm" onClick={onRetry}>
          Try again
        </Button>
      </p>,
    )
  if (!lines.length) return null
  return (
    <div
      data-ov-notes
      className="flex flex-col gap-1 border-t border-border pt-4 text-sm leading-relaxed text-text-2 [&>p]:max-w-[80ch]"
    >
      {lines}
    </div>
  )
}

/* the slice of the app's action surface this view calls */
type OverviewActions = {
  setScope: (id: string) => void
  setView: (view: string) => void
  openIssue: (id: string) => void
  newIssue: (init: { project?: string }) => void
  newProject: (init: { parent?: string; kind?: 'program' }) => void
  newMilestone: (init: { week?: number }) => void
  /** `focusAfterClose` is what takes focus as the Milestones window closes */
  editMilestone: (id: string, focusAfterClose?: () => HTMLElement | null) => void
  /** opens Search, on the project `searchIn` names */
  openPalette?: (searchIn?: unknown) => void
}

/** Where the Overview stands, as its root's data-overview-state names it. */
type OverviewState =
  /** All projects, where the Overview asks to choose a project */
  | 'choose'
  /** no answer of the summary for these arguments yet */
  | 'loading'
  /** the answers kept for these arguments while the reads stopped, or
      before they arrived again after a reconnect */
  | 'refreshing'
  | 'ok'
  | 'unavailable'
  | 'over_budget'
  /** the summary failed */
  | 'error'

/* How many Overviews mounted, each one's read owner (P.watchOverview). */
let overviewReaders = 0

/** The Overview's reads for `info`, which the page registers with the store
    while it and the tab show, with Try again; the store's answers for the
    arguments on screen. Renders again on the store's `views` news. In All
    projects, which asks for none, it releases the reads and rows of the
    page it replaced, which only stopped them: App mounts one Overview page
    for one scope, so no other page holds them. */
function useOverviewRead(info: ScopeInfo) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useStateO(0)
  // this mounted page, which owns the reads while it asks
  const [owner] = useStateO(() => ++overviewReaders)
  useViewsNews()
  const request = overviewRequest(info)
  const key = request.kind === 'ask' ? request.key : null
  const ask = visible ? key : null
  useEffect(() => {
    if (request.kind === 'choose') {
      P.releaseOverview()
      return
    }
    P.watchOverview(ask, owner, attempt)
    return () => P.watchOverview(null, owner, attempt)
  }, [ask, owner, attempt, request.kind])
  const view: OverviewView = P.overviewRead()
  // answers count only for the arguments on screen
  const mine = key !== null && view.key === key
  return {
    request,
    view,
    summary: mine ? view.summary : null,
    risk: mine ? view.risk : null,
    lists: mine ? { attention: view.attention, paused: view.paused } : null,
    retry: () => setAttempt((n) => n + 1),
  }
}

/** A list before any answer for the arguments on screen. */
const WAITING: ListView = {
  state: 'loading',
  batches: [],
  dropped: false,
  end: false,
  more: null,
  failed: false,
  reads: 0,
}

function Overview({ info, actions }: { info: ScopeInfo; actions: OverviewActions }) {
  const mobile = useMobile()
  const { paneRef } = useOverviewPanelClipping(!mobile)
  // App makes its actions again every render; the rows keep one identity
  const openIssue = useLatest((id: string) => {
    // a task only the answer brings opens from the window's own read
    P.noteViewTask(id)
    actions.openIssue(id)
  })
  /* Which column the health table is sorted on. It opens on the worst first —
     "which of these is in trouble" is the question the section exists to
     answer, and a table that opens alphabetically makes you click to ask it.
     Held here rather than inside the table so it survives the table
     re-rendering under a store update. */
  const [sort, setSort] = useStateO({ key: 'late', dir: 'desc' })
  /* The Milestones window opened from a row can delete that milestone, and
     the row with it. Focus then goes to the next row, the previous one, the
     + or the empty list's line, else, once the last one went from a scope
     with no task to show, the note the page shows instead. */
  const newMilestone = useRef<HTMLButtonElement>(null)
  const noMilestones = useRef<HTMLDivElement>(null)
  const editMilestone = (id: string) =>
    actions.editMilestone(
      id,
      focusAround(
        'data-overview-milestone',
        id,
        (row) => row,
        () => newMilestone.current ?? noMilestones.current ?? shownEmptyState(),
      ),
    )
  const read = useOverviewRead(info)
  // `wide` = a scope that names no project (All projects, My view); `mine` is
  // the one of those that also narrows to my own tasks. The Overview renders
  // no filter row, so it takes no `filters` — the scope's own `only` predicate
  // is the whole narrowing, and nothing invisible can be left switched on.
  const wide = info.wide
  const mine = info.mine
  // "grouped" scopes get health cards, a lone sub-project gets the status
  // distribution — one project's sub-projects, or My view's projects
  const grouped = wide || info.isMeta

  const summaryAnswer = read.summary?.value
  let state: OverviewState
  if (read.request.kind === 'choose') state = 'choose'
  else if (read.summary === null) state = 'loading'
  else if (read.summary.error !== undefined) state = 'error'
  else if (summaryAnswer?.state === 'unavailable') state = 'unavailable'
  else if (summaryAnswer?.state === 'over_budget') state = 'over_budget'
  else state = read.summary.current ? 'ok' : 'refreshing'
  const ok = summaryAnswer?.state === 'ok' ? summaryAnswer : null
  const counts = shownOf(read.summary, (s) => s.counts)
  const overdue = shownOf(read.summary, (s) => s.overdue)
  const anyTask = shownOf(read.summary, (s) => s.any_task)
  const projected = shownOf(read.risk, (r) => r.projected)
  // the day the answers were asked for
  const day = read.request.kind === 'ask' ? read.request.base.clock.day : P.TODAY_ISO

  /* Why a scope has no task to summarize, once the answer that decides it
     arrived: a project without sub-projects, one without tasks, My view
     with no project, no sub-project or nothing of the person's. Without a
     milestone the note is the page. With one, the note takes the place of
     the task sections and the Milestones section stays under it, as the
     Roadmap keeps its flags behind the same note. The note says why
     nothing is counted, not that the scope plans nothing. */
  let emptyNote: ReactNode = null
  // a kept answer still decides it while it refreshes, so the note stays
  // through a return or a reconnect
  const noTasks = given(anyTask)?.value === false
  if (mine) {
    // My view's projects are the ones the app holds (coordinator, 1 November 2026)
    if (info.metas.length === 0)
      emptyNote = (
        <NoProjects
          icon="chart"
          title="Nothing to summarize yet"
          onNewProject={() => actions.newProject({ kind: 'program' })}
        />
      )
    else if (info.subIds.length === 0)
      emptyNote = (
        <EmptyState
          icon="chart"
          title="Nothing to summarize yet"
          hint="Tasks live in sub-projects."
        />
      )
    else if ((state === 'ok' || state === 'refreshing') && noTasks)
      // My view can be empty while the projects around it are full — say which
      // of the two it is rather than claiming nobody has created anything
      emptyNote = <EmptyState icon="user" title="Nothing assigned to you" />
  } else if (ok && (state === 'ok' || state === 'refreshing')) {
    if (ok.sub_projects?.length === 0)
      emptyNote = (
        <EmptyState
          icon="chart"
          title="Nothing to summarize yet"
          hint="Tasks live in sub-projects."
          actionLabel={P.levelOn(info.id) === 'lead' ? 'New sub-project' : undefined}
          onAction={() => actions.newProject({ parent: info.id })}
        />
      )
    else if (noTasks)
      emptyNote = (
        <EmptyState
          icon="chart"
          title="No tasks yet"
          actionLabel={P.canWrite(info.id) ? 'New task' : undefined}
          onAction={() => actions.newIssue({ project: ok.sub_projects?.[0] ?? info.subIds[0] })}
        />
      )
  }

  // a project the chooser and the narrowing offer opens its own Overview
  const open = (id: string) => actions.setScope(id)
  let note: ReactNode = null
  if (state === 'choose')
    note =
      info.metas.length === 0 ? (
        <NoProjects
          icon="chart"
          title="Nothing to summarize yet"
          onNewProject={() => actions.newProject({ kind: 'program' })}
        />
      ) : (
        <ViewNote
          hooks="ov"
          phone={mobile}
          icon="chart"
          title="Choose a project"
          hint="The Overview shows one project at a time. Pick one to see its summary."
          projects={info.metas}
          onProject={open}
        />
      )
  else if (state === 'unavailable')
    note = (
      <ViewNote
        hooks="ov"
        phone={mobile}
        icon="eyeOff"
        title="This Overview is not available"
        hint={
          summaryAnswer?.state === 'unavailable' && summaryAnswer.message
            ? summaryAnswer.message
            : 'Qivo cannot show this project here. Choose another project.'
        }
      />
    )
  else if (state === 'over_budget') {
    const sub = !mine && !info.isMeta
    note = (
      <ViewNote
        hooks="ov"
        phone={mobile}
        icon="filter"
        title="This view could not be loaded within the Overview's limits."
        hint={
          info.isMeta
            ? 'Choose a sub-project to see its figures.'
            : mine
              ? 'Open a project or sub-project.'
              : 'Open its Board, or find its tasks with Search.'
        }
        projects={info.isMeta ? info.groups.map((g) => g.proj) : undefined}
        onProject={open}
        action={
          sub && actions.openPalette
            ? { label: 'Search this sub-project', onClick: () => actions.openPalette?.(info.id) }
            : undefined
        }
      />
    )
  } else if (state === 'error')
    note = (
      <ViewNote
        hooks="ov"
        phone={mobile}
        icon="alert"
        title="The Overview could not be loaded"
        hint="Try again asks the server for this Overview once more."
        action={{ label: 'Try again', onClick: read.retry }}
      />
    )
  const replaced = note ?? emptyNote
  const alone = replaced !== null && info.milestones.length === 0 && state !== 'choose'

  const msSorted = info.milestones.slice().sort((a, b) => a.week - b.week)
  const nextMs = msSorted.find((m) => m.week >= P.TODAY_WEEK)
  const c = given(counts)
  const leaves = c ? Object.values(c.leaves).reduce((n, v) => n + v, 0) : 0
  const done = c?.leaves.done ?? 0
  const pct = leaves ? Math.round((done / leaves) * 100) : 0
  const lateCount = given(overdue)?.count
  const missCount = given(projected)?.count
  const atRisk: Shown<{ count: number }> =
    lateCount !== undefined && missCount !== undefined
      ? {
          state: overdue.state === 'ok' && projected.state === 'ok' ? 'ok' : 'refreshing',
          value: { count: lateCount + missCount },
        }
      : overdue.state === 'loading' || projected.state === 'loading'
        ? { state: 'loading' }
        : overdue.state === 'error' || projected.state === 'error'
          ? { state: 'error' }
          : overdue.state === 'unavailable'
            ? overdue
            : projected.state === 'unavailable'
              ? projected
              : { state: 'counting' }
  const pausedTitle = c ? c.paused : null
  const lists = read.lists ?? { attention: WAITING, paused: WAITING }
  const busy = state === 'loading' || state === 'refreshing'

  return (
    <div
      ref={paneRef}
      data-scroll
      data-screen-label="Overview"
      data-overview-root
      data-overview-state={state}
      {...(state === 'unavailable' && summaryAnswer?.state === 'unavailable' && summaryAnswer.reason
        ? { 'data-ov-reason': summaryAnswer.reason }
        : {})}
      aria-busy={busy || undefined}
      className={cn('overview-view [flex:1] [overflow:auto]', alone && 'flex flex-col')}
    >
      {alone ? (
        replaced
      ) : (
        <div className="[padding:0_20px_40px] [max-width:var(--workspace-content-max)] [margin:0_auto] [display:flex] [flex-direction:column] [gap:var(--panel-gap)]">
          {replaced ?? (
            <>
              {/* What to do, then the state it is drawn from. The sentence leads
                  because it is the only thing on this page that says which of the
                  numbers under it you should act on. */}
              <OvSummary overdue={overdue} projected={projected} counts={counts} />

              {/* A single facts row, with enough width for a readable identity.
                  Cells wrap at compact widths without truncating milestone names. */}
              <div data-ov-strip className="flex flex-col gap-6 border-y border-border py-6">
                <div
                  data-ov-strip-cells
                  className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-start gap-x-6 gap-y-6"
                >
                  <OvLeadStat info={info} />
                  <OvStat
                    label="Completion"
                    figure={{ name: 'completion', shown: counts }}
                    value={c ? `${pct}%` : placeholder(counts)}
                    sub={c ? `${done} of ${leaves} tasks done` : undefined}
                    className={cn(!mobile && 'min-w-[132px]')}
                  >
                    <ProgressBar value={c ? pct : 0} height={5} />
                  </OvStat>
                  <OvStat
                    label="In progress"
                    figure={{ name: 'progress', shown: counts }}
                    value={c ? (c.leaves.progress ?? 0) : placeholder(counts)}
                    sub={
                      c?.leaves.review ? (
                        <span {...figureAttrs('review', counts)}>{c.leaves.review} in review</span>
                      ) : undefined
                    }
                  />
                  <OvStat
                    label="Paused"
                    figure={{ name: 'paused', shown: counts }}
                    value={c ? c.paused : placeholder(counts)}
                  />
                  <OvStat
                    label="Next milestone"
                    value={nextMs ? nextMs.name : '—'}
                    valueClassName="font-sans text-md"
                    sub={
                      nextMs
                        ? `${P.weekNumLabel(nextMs.week)}, ${P.fmtDate(P.weekToDate(nextMs.week))}`
                        : 'None scheduled'
                    }
                  />
                </div>
                {/* why a figure above or in the sentence is not given */}
                <OvFigureNotes
                  info={info}
                  counts={counts}
                  overdue={overdue}
                  projected={projected}
                  onRetry={read.retry}
                />
              </div>

              {grouped ? (
                P.stillLoading() !== null ? (
                  // the table reads every task of the scope, which the
                  // workspace is still loading, and never shows part of it
                  <OvSection title={wide ? 'Project health' : 'Sub-project health'}>
                    <TasksLoadingView what={wide ? 'Project health' : 'Sub-project health'} />
                  </OvSection>
                ) : (
                  (() => {
                    const rows = healthRows(info, P.scopedIssues(info), mine)

                    /* The sort. Name and lead compare as text, everything else as a
                     number, and NAME is always the last tiebreak so the order is total:
                     without it two groups with the same delay count would swap places on
                     every unrelated store update. */
                    const key = (r) => {
                      switch (sort.key) {
                        case 'name':
                          return r.proj.name.toLowerCase()
                        case 'lead':
                          return (r.lead ? r.lead.name : '￿').toLowerCase()
                        case 'progress':
                          return r.pct
                        case 'done':
                          return r.total ? r.done / r.total : 0
                        case 'left':
                          return r.remaining
                        default:
                          return r[sort.key] || 0
                      }
                    }
                    const sorted = rows.slice().sort((a, b) => {
                      const ka = key(a),
                        kb = key(b)
                      const d = ka < kb ? -1 : ka > kb ? 1 : 0
                      return (sort.dir === 'asc' ? d : -d) || a.proj.name.localeCompare(b.proj.name)
                    })
                    return (
                      <OvSection title={wide ? 'Project health' : 'Sub-project health'}>
                        <OvHealthTable
                          rows={sorted}
                          unit={wide ? 'Project' : 'Sub-project'}
                          sort={sort}
                          setSort={setSort}
                          mobile={mobile}
                          onOpen={(id: string) => {
                            actions.setScope(id)
                            actions.setView('kanban')
                          }}
                        />
                      </OvSection>
                    )
                  })()
                )
              ) : (
                <OvSection title="Status distribution">
                  <div
                    {...figureAttrs('status', counts)}
                    className="[background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [padding:20px] [box-shadow:var(--qivo-shadow-card)] [display:flex] [flex-direction:column] [gap:8px]"
                  >
                    <OvStatusBar counts={c ? c.leaves : null} height={8} />
                    <OvStatusLegend counts={c ? c.leaves : null} missing={placeholder(counts)} />
                  </div>
                </OvSection>
              )}

              <OvSection
                title={
                  <>
                    Overdue & at risk
                    {/* a count only where both halves are given, and above
                        zero, as the title always showed it */}
                    <span {...figureAttrs('at-risk', atRisk)}>
                      {(given(atRisk)?.count ?? 0) > 0 ? `, ${given(atRisk)?.count}` : ''}
                    </span>
                  </>
                }
              >
                <OvList
                  kind="attention"
                  list={lists.attention}
                  wide={wide}
                  day={day}
                  emptyText="No deadlines are overdue or at risk."
                  onOpen={openIssue}
                />
              </OvSection>
              <OvSection
                title={
                  <>
                    Paused tasks
                    <span {...figureAttrs('paused', counts)}>
                      {pausedTitle !== null && pausedTitle > 0 ? `, ${pausedTitle}` : ''}
                    </span>
                  </>
                }
              >
                <OvList
                  kind="paused"
                  list={lists.paused}
                  wide={wide}
                  day={day}
                  emptyText="Nothing is paused right now."
                  onOpen={openIssue}
                />
              </OvSection>
            </>
          )}
          {/* a milestone belongs to ONE project's roadmap (0078) — a scope
              spanning every project names none to add it to, so the + is a
              project scope's affordance only */}
          <OvSection
            title="Milestones"
            action={
              wide || !P.canAddMilestone(info.id) ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="w-control-xs h-control-xs"
                  aria-label="New milestone"
                  title="New milestone"
                  ref={newMilestone}
                  onClick={() => actions.newMilestone({})}
                >
                  <Icon name="plus" size={16} />
                </Button>
              )
            }
          >
            <div className="[display:flex] [flex-direction:column] [gap:8px]">
              {msSorted.map((m) => (
                <OvMilestoneRow
                  key={m.id}
                  m={m}
                  next={nextMs && m.id === nextMs.id}
                  owner={wide ? P.projectLabelOf(m.project) : null}
                  onEdit={editMilestone}
                />
              ))}
              {msSorted.length === 0 && (
                <div
                  ref={noMilestones}
                  tabIndex={-1}
                  className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic] [padding:4px_2px]"
                >
                  {wide
                    ? 'No milestones in any of your projects yet.'
                    : 'No milestones yet. Add one with the + button.'}
                </div>
              )}
            </div>
          </OvSection>
        </div>
      )}
    </div>
  )
}

export { Overview }
