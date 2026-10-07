import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
/* Overview — dashboard rollup: what to do, the scope's state in one box,
   health per group as a sortable table, then at-risk tasks, paused tasks and milestones. */

import { type ReactNode, useState as useStateO } from 'react'
import { relativeWeek, weekToISO } from '@/lib/dates'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { Avatar, EmptyState, Icon, PausedMark, ProgressBar, StatusDot } from '../components/qivo'
import { type IssueVM, type MilestoneVM, P, type ScopeInfo } from '../store/planner'
import { useOverviewPanelClipping } from './useOverviewPanelClipping'
import './Overview.css'
import '../styles/mobile-views.css'

function OvSection({
  title,
  action,
  children,
}: {
  title: string
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
  children,
}: {
  label: string
  value: ReactNode
  sub?: string
  valueClassName?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn('min-w-0 break-words', className)}>
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

function OvStatusBar({
  items,
  height = 7,
}: {
  items: IssueVM[]
  height?: keyof typeof statusBarSizeClasses
}) {
  const tasks = items.filter((it) => !P.isGroup(it))
  const total = tasks.length
  if (!total) return <div className={cn('bg-surface-3', statusBarSizeClasses[height])} />
  return (
    <div className={cn('flex overflow-hidden bg-surface-3', statusBarSizeClasses[height])}>
      {P.STATUSES.map((s) => {
        const n = tasks.filter((i) => i.status === s.id).length
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

function OvStatusLegend({ items }: { items: IssueVM[] }) {
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
            {items.filter((i) => !P.isGroup(i) && i.status === s.id).length}
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
              <strong>{r.proj.name}</strong>
              <Icon name="chevronRight" size={16} />
            </span>
            <span className="mobile-health-progress" data-ovcell="progress">
              <span>
                <OvStatusBar items={r.issues} height={6} />
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
                      {r.proj.name}
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
                        <OvStatusBar items={r.issues} height={6} />
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

/* these rows no longer carry the board's delay edge, only a plain border:
   every row in an "Overdue & at risk" section is at risk by definition, so the
   edge was restating the heading above it rather than adding anything */
function OvPausedRow({
  it,
  label,
  wide,
  onOpen,
}: {
  it: IssueVM
  label: string
  wide: boolean
  onOpen: (id: string) => void
}) {
  return (
    <Button
      type="button"
      data-ovrow={it.id}
      onClick={() => onOpen(it.id)}
      title={it.title}
      className="[display:flex] [align-items:center] [gap:8px] [width:100%] [text-align:left] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)] [color:var(--text-1)] [transition:background-color_var(--dur-fast)_var(--ease-out),_border-color_var(--dur-fast)_var(--ease-out)] [font-family:var(--sans)] [cursor:pointer]"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--hover)'
        e.currentTarget.style.borderColor = 'var(--border-strong)'
      }}
      onMouseLeave={(e) => {
        // Hand the rest state back to CSS: themes paint these rows clear
        // over the translucent section material.
        e.currentTarget.style.removeProperty('background')
        e.currentTarget.style.removeProperty('border-color')
      }}
      variant="unstyled"
    >
      <PausedMark />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 break-words text-base leading-[1.4]">{it.title}</span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
          <HoverTooltip content={label}>
            <span
              tabIndex={-1}
              className={cn('truncate', wide ? 'max-w-[190px]' : 'max-w-[120px]')}
            >
              {label}
            </span>
          </HoverTooltip>
        </span>
      </span>
      {it.owner && <Avatar id={it.owner} size={28} />}
    </Button>
  )
}

/* one deadline row — either already overdue, or (delay-tracking projects,
   0064) projected by the capacity walk to miss its due date */
function OvAtRiskRow({
  it,
  label,
  wide,
  onOpen,
}: {
  it: IssueVM
  label: string
  wide: boolean
  onOpen: (id: string) => void
}) {
  const overdue = it.due < P.TODAY_ISO
  const delay = overdue ? null : P.delayOf(it)
  const days = overdue
    ? Math.round((P.isoToDate(P.TODAY_ISO).getTime() - P.isoToDate(it.due).getTime()) / 86400000)
    : 0
  const finNote =
    delay && delay.fin != null
      ? ` — projected to finish in the week of ${P.fmtDate(P.weekToDate(delay.fin))}`
      : ''
  return (
    <Button
      type="button"
      data-atrisk={it.id}
      onClick={() => onOpen(it.id)}
      title={`${it.title} — due ${P.fmtISO(it.due)}${finNote}`}
      className="[display:flex] [align-items:center] [gap:8px] [width:100%] [text-align:left] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)] [color:var(--text-1)] [transition:background-color_var(--dur-fast)_var(--ease-out),_border-color_var(--dur-fast)_var(--ease-out)] [font-family:var(--sans)] [cursor:pointer]"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--hover)'
        e.currentTarget.style.borderColor = 'var(--border-strong)'
      }}
      onMouseLeave={(e) => {
        // Hand the rest state back to CSS: themes paint these rows clear
        // over the translucent section material.
        e.currentTarget.style.removeProperty('background')
        e.currentTarget.style.removeProperty('border-color')
      }}
      variant="unstyled"
    >
      {/* the icon separates this section's rows from the paused ones by SHAPE —
          the red date text beside it is the one signal that carries a number */}
      <Icon name="calendar" size={13} color="var(--text-3)" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 break-words text-base leading-[1.4]">{it.title}</span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
          <span className="whitespace-nowrap !font-mono text-danger">
            {P.fmtISO(it.due)}, {overdue ? `${days}d overdue` : 'projected to miss'}
          </span>
          <HoverTooltip content={label}>
            <span
              tabIndex={-1}
              className={cn('truncate', wide ? 'max-w-[190px]' : 'max-w-[120px]')}
            >
              {label}
            </span>
          </HoverTooltip>
        </span>
      </span>
      {it.owner && <Avatar id={it.owner} size={28} />}
    </Button>
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
   cannot disturb the layout. It is a first-match ladder over facts the page has
   already computed, ordered by how much a person can do about them:

     a lost deadline  →  a deadline about to be lost  →  something stuck  →
     nothing moving   →  nothing wrong

   Two rules it must keep whatever replaces it. It may not state a number this
   page does not also show, or the sentence and the strip under it will disagree
   the first time a filter or a scope changes one of them. And it must have
   something to say when everything is fine: a line that appears only in trouble
   trains people to read its absence as "the page is broken".

   The exception numbers are painted, the rest are not — colour marks the
   exception (tokens.css), and "6 under way" is not one. */
function OvSummary({
  overdue,
  projected,
  paused,
  inProgress,
  prog,
}: {
  overdue: number
  projected: number
  paused: number
  inProgress: number
  prog: { done: number; total: number }
}) {
  const num = (n: number, tone: 'danger' | 'warning' | 'neutral' = 'neutral') => (
    <b
      className={cn(
        '!font-mono font-semibold',
        { danger: 'text-danger', warning: 'text-warning', neutral: 'text-text-1' }[tone],
      )}
    >
      {n}
    </b>
  )
  const task = (n: number) => (n === 1 ? ' task' : ' tasks')
  let body: ReactNode
  if (overdue > 0) {
    body = (
      <>
        {num(overdue, 'danger')}
        {task(overdue)} {overdue === 1 ? 'is' : 'are'} overdue
        {projected > 0 ? (
          <>; {num(projected, 'danger')} more projected to miss their due date</>
        ) : (
          ''
        )}
        .
      </>
    )
  } else if (projected > 0) {
    body = (
      <>
        {num(projected, 'danger')}
        {task(projected)} {projected === 1 ? 'is' : 'are'} projected to miss
        {projected === 1 ? ' its' : ' their'} due date.
      </>
    )
  } else if (paused > 0) {
    body = (
      <>
        {num(paused, 'warning')}
        {task(paused)} {paused === 1 ? 'is' : 'are'} paused.
      </>
    )
  } else if (prog.total > 0 && prog.done === prog.total) {
    body = (
      <>
        {num(prog.total)}
        {task(prog.total)} done.
      </>
    )
  } else if (inProgress === 0) {
    body = (
      <>
        {num(prog.total - prog.done)}
        {task(prog.total - prog.done)} {prog.total - prog.done === 1 ? 'remains' : 'remain'}.
      </>
    )
  } else {
    body = (
      <>
        {num(inProgress)}
        {task(inProgress)} in progress. No deadline warnings or paused tasks.
      </>
    )
  }
  return (
    <p data-ov-summary className="m-0 max-w-[65ch] text-base leading-relaxed text-text-1">
      {body}
    </p>
  )
}

/* the slice of the app's action surface this view calls */
type OverviewActions = {
  setScope: (id: string) => void
  setView: (view: string) => void
  openIssue: (id: string) => void
  newIssue: (init: { project?: string }) => void
  newProject: (init: { parent?: string }) => void
  newMilestone: (init: { week?: number }) => void
  editMilestone: (id: string) => void
}

function Overview({ info, actions }: { info: ScopeInfo; actions: OverviewActions }) {
  const mobile = useMobile()
  const { paneRef } = useOverviewPanelClipping(!mobile)
  /* Which column the health table is sorted on. It opens on the worst first —
     "which of these is in trouble" is the question the section exists to
     answer, and a table that opens alphabetically makes you click to ask it.
     Held here rather than inside the table so it survives the table
     re-rendering under a store update. */
  const [sort, setSort] = useStateO({ key: 'late', dir: 'desc' })
  // `wide` = a scope that names no project (All projects, My view); `mine` is
  // the one of those that also narrows to my own tasks. The Overview renders
  // no filter row, so it takes no `filters` — the scope's own `only` predicate
  // is the whole narrowing, and nothing invisible can be left switched on.
  const wide = info.wide
  const mine = info.mine
  // "grouped" scopes get health cards, a lone sub-project gets the status
  // distribution — one project's sub-projects, or every project (deviation #47)
  const grouped = wide || info.isMeta
  const subIds = info.subIds

  if (subIds.length === 0) {
    if (wide) {
      return (
        <EmptyState
          icon="chart"
          title="Nothing to summarize yet"
          hint={
            info.metas.length === 0
              ? 'No projects are available to you yet.'
              : 'Tasks live in sub-projects.'
          }
        />
      )
    }
    return (
      <EmptyState
        icon="chart"
        title="Nothing to summarize yet"
        hint="Tasks live in sub-projects."
        actionLabel={P.canWrite(info.id) ? 'New sub-project' : undefined}
        onAction={() => actions.newProject({ parent: info.id })}
      />
    )
  }

  const scoped = P.scopedIssues(info)
  if (scoped.length === 0) {
    // My view can be empty while the projects around it are full — say which
    // of the two it is rather than claiming nobody has created anything
    if (mine) {
      return <EmptyState icon="user" title="Nothing assigned to you" />
    }
    // no action across all projects: creating means choosing where, and this
    // scope is the one with nothing to choose from
    if (wide) {
      return <EmptyState icon="chart" title="No tasks yet" />
    }
    return (
      <EmptyState
        icon="chart"
        title="No tasks yet"
        actionLabel={P.canWrite(info.id) ? 'New task' : undefined}
        onAction={() => actions.newIssue({ project: subIds[0] })}
      />
    )
  }

  const prog = P.progressIn(subIds, info.only)
  const inProgress = scoped.filter((i) => !P.isGroup(i) && i.status === 'progress').length
  const inReview = scoped.filter((i) => !P.isGroup(i) && i.status === 'review').length
  const pausedIssues = scoped.filter((i) => i.paused)
  /* The two halves of "at risk", counted apart for the summary sentence: a date
     already lost reads differently from one the plan says is about to be. The
     list below merges them because the ROWS are the same shape; the sentence
     must not, because the advice differs. */
  const overdueCount = scoped.filter((i) => !P.isDone(i) && i.due && i.due < P.TODAY_ISO).length
  // deadlines lost or being lost: past-due (any project) plus, for
  // delay-tracking projects, issues the capacity projection says will miss
  // their due date (0064). A 'late' verdict implies a due date, so every
  // row has one to sort and render by.
  const atRiskIssues = scoped
    .filter((i) => {
      if (P.isDone(i)) return false
      if (i.due && i.due < P.TODAY_ISO) return true
      const d = P.tracksDelay(i) ? P.delayOf(i) : null
      return !!(d && d.status === 'late')
    })
    .sort((a, b) => (a.due < b.due ? -1 : 1))
  const msSorted = info.milestones.slice().sort((a, b) => a.week - b.week)
  const nextMs = msSorted.find((m) => m.week >= P.TODAY_WEEK)
  // where a row's task lives — the sub-project alone inside one project, the
  // owning project too when every project is on screen at once
  const rowLabel = (it: IssueVM) => {
    const p = P.project(it.project)
    const m = wide ? P.metaOf(it.project) : null
    return m && p && m.id !== p.id ? `${m.name}, ${p.name}` : p ? p.name : ''
  }

  return (
    <div
      ref={paneRef}
      data-scroll
      data-screen-label="Overview"
      className="overview-view [flex:1] [overflow:auto]"
    >
      <div className="[padding:0_20px_40px] [max-width:var(--workspace-content-max)] [margin:0_auto] [display:flex] [flex-direction:column] [gap:24px]">
        {/* What to do, then the state it is drawn from. The sentence leads
            because it is the only thing on this page that says which of the
            numbers under it you should act on. */}
        <OvSummary
          overdue={overdueCount}
          projected={atRiskIssues.length - overdueCount}
          paused={pausedIssues.length}
          inProgress={inProgress}
          prog={prog}
        />

        {/* A single facts row, with enough width for a readable identity.
            Cells wrap at compact widths without truncating milestone names. */}
        <div
          data-ov-strip
          className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-start gap-x-6 gap-y-6 border-y border-border py-6"
        >
          <OvLeadStat info={info} />
          <OvStat
            label="Completion"
            value={`${prog.pct}%`}
            sub={`${prog.done} of ${prog.total} tasks done`}
            className={cn(!mobile && 'min-w-[132px]')}
          >
            <ProgressBar value={prog.pct} height={5} />
          </OvStat>
          <OvStat
            label="In progress"
            value={inProgress}
            sub={inReview ? `${inReview} in review` : undefined}
          />
          <OvStat label="Paused" value={pausedIssues.length} />
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

        {grouped ? (
          (() => {
            /* A row per group, over the group's issues as this scope sees them.
             In My view a project I have nothing in gets no row at all — an
             all-zero health row would say "this project is stalled" when it
             only means the work there isn't mine. */
            const rows = info.groups
              .map((g) => {
                const set = new Set(g.subIds)
                const issues = scoped.filter((i) => set.has(i.project))
                const gp = P.progressIn(g.subIds, info.only)
                const leadId = P.leadOf(g.proj.id)
                /* Projected verdicts (0064), gated PER ISSUE: `delayOf` returns the
               raw projection for every issue — only `delayColor` consults the
               tracking toggle — so the gate has to be asked here, and asking it
               per issue is what a group spanning several sub-projects needs. */
                const delayCount = (s: string) =>
                  issues.filter((i) => {
                    if (!P.tracksDelay(i)) return false
                    const d = P.delayOf(i)
                    return d && d.status === s
                  }).length
                return {
                  proj: g.proj,
                  issues,
                  pct: gp.pct,
                  done: gp.done,
                  total: gp.total,
                  remaining: P.remainingIn(g.subIds, info.only),
                  lead: leadId ? P.user(leadId) : null,
                  late: delayCount('late'),
                  behind: delayCount('behind'),
                  paused: issues.filter((i) => i.paused).length,
                }
              })
              .filter((r) => !mine || r.issues.length > 0)

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
        ) : (
          <OvSection title="Status distribution">
            <div className="[background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [padding:20px] [box-shadow:var(--qivo-shadow-card)] [display:flex] [flex-direction:column] [gap:8px]">
              <OvStatusBar items={scoped} height={8} />
              <OvStatusLegend items={scoped} />
            </div>
          </OvSection>
        )}

        <div className="flex flex-col gap-6">
          <div className="[display:flex] [flex-direction:column] [gap:24px]">
            <OvSection
              title={`Overdue & at risk${atRiskIssues.length ? `, ${atRiskIssues.length}` : ''}`}
            >
              {atRiskIssues.length ? (
                <div className="[display:flex] [flex-direction:column] [gap:8px]">
                  {atRiskIssues.map((it) => (
                    <OvAtRiskRow
                      key={it.id}
                      it={it}
                      label={rowLabel(it)}
                      wide={wide}
                      onOpen={actions.openIssue}
                    />
                  ))}
                </div>
              ) : (
                <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic] [padding:4px_2px]">
                  No deadlines are overdue or at risk.
                </div>
              )}
            </OvSection>
            <OvSection
              title={`Paused tasks${pausedIssues.length ? `, ${pausedIssues.length}` : ''}`}
            >
              {pausedIssues.length ? (
                <div className="[display:flex] [flex-direction:column] [gap:8px]">
                  {pausedIssues.map((it) => (
                    <OvPausedRow
                      key={it.id}
                      it={it}
                      label={rowLabel(it)}
                      wide={wide}
                      onOpen={actions.openIssue}
                    />
                  ))}
                </div>
              ) : (
                <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic] [padding:4px_2px]">
                  Nothing is paused right now.
                </div>
              )}
            </OvSection>
          </div>
          {/* a milestone belongs to ONE project's roadmap (0078) — a scope
              spanning every project names none to add it to, so the + is a
              project scope's affordance only */}
          <OvSection
            title="Milestones"
            action={
              wide || !P.canWrite(info.id) ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="w-control-xs h-control-xs"
                  aria-label="New milestone"
                  title="New milestone"
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
                  owner={wide ? P.project(m.project)?.name : null}
                  onEdit={actions.editMilestone}
                />
              ))}
              {msSorted.length === 0 && (
                <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic] [padding:4px_2px]">
                  {wide
                    ? 'No milestones in any of your projects yet.'
                    : 'No milestones yet — add one with the + button.'}
                </div>
              )}
            </div>
          </OvSection>
        </div>
      </div>
    </div>
  )
}

export { Overview }
