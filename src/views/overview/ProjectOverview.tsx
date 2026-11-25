/* A project or sub-project's Overview: what is left and what needs
   attention. One row on top states the problem in a sentence beside Tasks
   left, Hours left and the lead. Under it, Needs attention ranks every task
   that needs someone, by kind, with filter tabs, and beside it a project's
   Sub-projects, the people's Load this week and the Milestones. Nothing
   finished is counted or drawn.

   Every figure is the server's (convex/overview.ts): the summary's counts
   for Tasks left and Hours left, the Needs attention list's kinds, counts,
   people and Late tasks by due date (overview.needs), and a project's
   health table, sorted by Late, for Sub-projects (overview.health), through
   the store's reads (store/overviewLists.ts, page 'status'). The people's
   loads come from the owner-load cache, as the Roadmap's Team utilization
   reads them (planning.ownerLoads, views/teamWeeks.ts), so a load counts
   the projects the reader can see. A figure the server answers unavailable
   shows a dash or "unknown" and why, never a number. The milestones are
   views/useScopeMilestones.ts's, as My view's Overview reads them. */

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import {
  firstDayOfWeek,
  fmtDate,
  isoToDate,
  isoToWeek,
  relativeWeek,
  TODAY_WEEK,
  WEEKDAYS,
  weekLabel,
  weekNumLabel,
  weekToISO,
} from '@/lib/dates'
import { DELAY_LABELS } from '@/lib/delay'
import { focusAround, useFocusWhenGone } from '@/lib/focusWhenGone'
import { StaticControlsContext, useLiveControls } from '@/lib/liveControls'
import { usePagedList } from '@/lib/pagedList'
import { headingTarget, shownEmptyState } from '@/lib/taskFocus'
import { type SentencePart, syncSentence } from '@/lib/teamSync'
import { useLatest } from '@/lib/useLatest'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { fmtHours, hasPlannableWeek, loadTone } from '@/lib/workload'
import type { HealthView, NeedsView } from '@/store/overviewLists'
import { api } from '../../../convex/_generated/api'
import type { HealthRow } from '../../../convex/lib/overview'
import type { NeedsKind, NeedsRow } from '../../../convex/lib/overviewNeeds'
import { taskOwnerId } from '../../../convex/lib/review'
import type { NavChildRow, NavChildren } from '../../../convex/model/projectNavReads'
import { MilestoneSectionPart } from '../../components/MilestoneSectionPart'
import { navCursors } from '../../components/projectNavRows'
import { Avatar, DateInput, EmptyState, Icon, ProjectName } from '../../components/qivo'
import { personLabel, useOrgPeople, usePeople } from '../../components/usePeople'
import { ViewNote } from '../../components/ViewNote'
import {
  type IssueVM,
  type MilestoneVM,
  OVERVIEW_MILESTONE_SLOTS,
  P,
  type ScopeInfo,
} from '../../store/planner'
import { capacityOf } from '../capacity'
import { figuresOf } from '../teamWeeks'
import { useOverviewPanelClipping } from '../useOverviewPanelClipping'
import { useScopeMilestones } from '../useScopeMilestones'
import { OvSection } from './OvSection'
import {
  given,
  narrower,
  type OverviewActions,
  type OverviewState,
  onePersonAtATime,
  placeholder,
  shownOf,
  useOverviewRead,
} from './overviewParts'
import './ProjectOverview.css'
import '../Overview.css'
import '../../styles/mobile-views.css'

const NEEDS_SLOT = 'overview:needs'

const KIND_LABEL: Record<NeedsKind, string> = {
  overdue: 'Overdue',
  projected: 'Projected to miss',
  behind: DELAY_LABELS.behind,
  blocked: 'Blocked',
  no_reviewer: 'No reviewer',
  paused: 'Paused',
}

/** Each kind's flag: a glyph of its own, so no kind is told by colour
    alone. */
const KIND_ICON: Record<NeedsKind, string> = {
  overdue: 'warning',
  projected: 'alert',
  behind: 'clockFading',
  blocked: 'blocked',
  no_reviewer: 'eye',
  paused: 'pause',
}

const KIND_EMPTY: Record<NeedsKind, string> = {
  overdue: 'No task is overdue.',
  projected: 'No task is projected to miss its due date.',
  behind: 'No task is behind plan.',
  blocked: 'No task is blocked.',
  no_reviewer: 'No task waits for a reviewer.',
  paused: 'No task is paused.',
}

/** What an empty tab says where its count is not a confirmed zero, as
    where some verdict could not be read. */
const KIND_NONE_FOUND: Record<'all' | 'projected' | 'behind', string> = {
  all: 'Qivo found nothing that needs attention among the tasks it could check.',
  projected: 'Qivo found no task projected to miss its due date among the tasks it could check.',
  behind: 'Qivo found no task behind plan among the tasks it could check.',
}

type Filter = 'all' | NeedsKind

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function daysSince(at: number, now: number): number {
  const a = new Date(at)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

const dayOf = (iso: string) => {
  const d = isoToDate(iso)
  return `${WEEKDAYS[d.getDay()]?.slice(0, 3)} ${fmtDate(d)}`
}

const weekOf = (iso: string) => weekNumLabel(isoToWeek(iso))

const plannedEnd = (row: NeedsRow): string | undefined =>
  row.has_subtasks ? row.span?.end_week : (row.end_week ?? undefined)

function factOf(row: NeedsRow, day: string): { fact: string; date: string | null } {
  const due = row.due_date ?? null
  const end = plannedEnd(row)
  const fin = row.needs.finish_week
  switch (row.needs.kind) {
    case 'overdue': {
      const days = Math.max(
        1,
        Math.round((isoToDate(day).getTime() - isoToDate(due ?? day).getTime()) / 86_400_000),
      )
      return { fact: `${days}d overdue`, date: due ? `due ${dayOf(due)}` : null }
    }
    case 'projected':
      return {
        fact: fin ? `finishes ${weekOf(fin)}` : 'projected to miss',
        date: due ? `due ${weekOf(due)}, ${dayOf(due)}` : null,
      }
    case 'behind':
      return {
        fact: fin ? `finishes ${weekOf(fin)}` : DELAY_LABELS.behind.toLowerCase(),
        date: end ? `planned ${weekOf(end)}` : null,
      }
    case 'no_reviewer': {
      const at = row.review_at ? Date.parse(row.review_at) : null
      return {
        fact: 'no reviewer',
        date:
          at === null ? null : `waiting ${plural(Math.max(0, daysSince(at, Date.now())), 'day')}`,
      }
    }
    default:
      return {
        fact:
          row.needs.kind === 'blocked'
            ? `blocked by ${plural(row.needs.blocked_by, 'task')}`
            : 'paused',
        date: due ? `due ${dayOf(due)}` : end ? `planned ${weekOf(end)}` : null,
      }
  }
}

function reasonsOf(row: NeedsRow): string[] {
  const out: string[] = []
  const { needs } = row
  const kinds = needs.also
  if (needs.blocks)
    out.push(
      `blocks ${needs.blocks.first.title}${needs.blocks.count > 1 ? ` and ${plural(needs.blocks.count - 1, 'more')}` : ''}`,
    )
  if (kinds.includes('blocked')) out.push(`blocked by ${plural(needs.blocked_by, 'task')}`)
  if (kinds.includes('no_reviewer')) {
    const days = row.review_at ? daysSince(Date.parse(row.review_at), Date.now()) : null
    out.push(
      days === null
        ? 'no reviewer'
        : days <= 0
          ? 'no reviewer since today'
          : `no reviewer for ${plural(days, 'day')}`,
    )
  }
  if (kinds.includes('paused')) out.push('paused')
  return out
}

function Sentence({ needs, tasksLeft }: { needs: NeedsView; tasksLeft: number | null }) {
  const answer = needs?.value
  let body: ReactNode
  if (needs === null || (answer === undefined && needs.error === undefined)) body = '…'
  else if (answer === undefined) body = 'Qivo could not check what needs attention here.'
  else if (answer.state !== 'ok') body = 'Qivo could not check every task here in one request.'
  else {
    const c = answer.counts
    const projected = c.projected.state === 'ok' ? c.projected.count : null
    if (c.all.state === 'ok' && c.all.count === 0)
      body =
        tasksLeft === 0
          ? 'Nothing is left to do.'
          : tasksLeft === null
            ? 'Nothing needs attention.'
            : `Nothing needs attention. ${plural(tasksLeft, 'task')} ${tasksLeft === 1 ? 'is' : 'are'} left.`
    // the parts alternate text and a count, and each count's clause is
    // its own, so the clause that follows names it
    else
      body = syncSentence({ overdue: c.overdue, projected, blocked: c.blocked }).reduce<
        ReactNode[]
      >((out, part: SentencePart) => {
        out.push(
          typeof part === 'string' ? (
            part
          ) : (
            <b key={`${part.tone}:${out.length}`} className="pov-num" data-tone={part.tone}>
              {part.n}
            </b>
          ),
        )
        return out
      }, [])
  }
  return (
    <p data-ov-sentence className="pov-sentence" aria-busy={body === '…' || undefined}>
      {body}
    </p>
  )
}

function Fact({
  label,
  name,
  state,
  children,
}: {
  label: string
  name: string
  state: string
  children: ReactNode
}) {
  return (
    <div className="pov-fact" data-ov-figure={name} data-ov-figure-state={state}>
      <span className="pov-fact-label">{label}</span>
      <b className="pov-fact-value">{children}</b>
    </div>
  )
}

function LeadFact({ info }: { info: ScopeInfo }) {
  const proj = info.proj
  const leadId = proj ? P.leadOf(proj.id) : null
  const [u] = useOrgPeople(proj?.org ?? '', [leadId])
  if (!u || u.state === 'gone') return null
  const inherited = !!proj && !proj.lead && !!info.meta && info.meta.id !== proj.id
  return (
    <div className="pov-fact pov-lead" data-ov-lead={u.id}>
      <Avatar id={u.id} size={28} />
      <span className="flex min-w-0 flex-col">
        <span className="pov-fact-label">
          {inherited ? `Lead, from ${info.meta?.name}` : 'Lead'}
        </span>
        <span className="pov-lead-name">{personLabel(u, 'No lead')}</span>
      </span>
    </div>
  )
}

type Tab = { id: Filter; label: string; count: number | null }

function Tabs({
  tabs,
  active,
  onChange,
  panel,
  idOf,
}: {
  tabs: Tab[]
  active: Filter
  onChange: (id: Filter) => void
  panel: string
  idOf: (id: Filter) => string
}) {
  const root = useRef<HTMLDivElement>(null)
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const at = tabs.findIndex((t) => t.id === active)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const tab = tabs[next]
    if (!tab) return
    onChange(tab.id)
    root.current?.querySelector<HTMLElement>(`#${CSS.escape(idOf(tab.id))}`)?.focus()
  }
  return (
    <div
      ref={root}
      role="tablist"
      aria-label="Show"
      className="pov-tabs"
      onKeyDown={move}
      data-ov-tabs
    >
      {tabs.map((t) => (
        <Button
          key={t.id}
          id={idOf(t.id)}
          type="button"
          variant="unstyled"
          role="tab"
          aria-selected={t.id === active}
          aria-controls={panel}
          aria-label={`${t.label}, ${t.count === null ? 'count unknown' : plural(t.count, 'task')}`}
          tabIndex={t.id === active ? 0 : -1}
          data-ov-tab={t.id}
          className="pov-tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          <span aria-hidden="true">{t.count === null ? '–' : t.count}</span>
        </Button>
      ))}
    </div>
  )
}

const modelOf = (row: NeedsRow): IssueVM | undefined =>
  P.viewTask(NEEDS_SLOT, row.id) ?? P.anyTask(P.handleNow(row.id, row.org_id, row.num))

function MoveDue({ it }: { it: IssueVM }) {
  if (!P.canWrite(it.project) || P.createOnItsWay(it.uuid)) return null
  return (
    <DateInput
      value={it.due || null}
      onChange={(due) => {
        void P.updateIssue(it.id, { due })
      }}
      className="pov-action"
      label={`Move due date of ${it.title}${it.due ? `, due ${P.fmtISO(it.due)}` : ', no due date'}`}
      face={
        <>
          <Icon name="calendar" size={14} color="var(--text-2)" />
          <span data-action-label>Move due date</span>
        </>
      }
    />
  )
}

/* As a Board card, a row mounts its picker's popover root only once a
   mouse points at it, keyboard focus enters it or a press reaches the
   picker (lib/liveControls.tsx), as the list can hold a thousand rows. */
function NeedRow({
  row,
  day,
  inProject,
  onOpen,
  onFocusIn,
}: {
  row: NeedsRow
  day: string
  inProject: boolean
  onOpen: (id: string) => void
  /** focus entered the row, also its calendar or picker */
  onFocusIn: (handle: string, uuid: string) => void
}) {
  const it = modelOf(row)
  // the handle the row names its task by, as the task window and its focus
  // return name it (lib/taskFocus.ts)
  const handle = it?.id ?? P.handleNow(row.id, row.org_id, row.num)
  const kind = row.needs.kind
  const { fact, date } = factOf(row, day)
  const reasons = reasonsOf(row)
  const owner = it?.owner ?? taskOwnerId(row, row.has_subtasks) ?? null
  const [ownerName] = useOrgPeople(row.org_id, [owner])
  const root = useRef<HTMLLIElement>(null)
  const controls = useLiveControls(root)
  const place = inProject ? P.projectPlace(row.project_id, false) : null
  const placeName = place ? P.placeLabel(place) : null
  const name = [
    `${KIND_LABEL[kind]}: ${row.title}`,
    placeName,
    ...reasons,
    fact,
    date,
    owner ? personLabel(ownerName, 'Unassigned') : 'Unassigned',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <li
      ref={root}
      {...controls.rootProps}
      onFocusCapture={() => onFocusIn(handle, row.id)}
      className="pov-need"
      data-need={handle}
      data-kind={kind}
    >
      <StaticControlsContext.Provider value={controls.value}>
        <span className="pov-flag" data-kind={kind} aria-hidden="true">
          <Icon name={KIND_ICON[kind]} size={13} strokeWidth={2.4} />
        </span>
        <span className="pov-need-main">
          <Button
            type="button"
            variant="unstyled"
            className="pov-need-open"
            data-focus-key="row"
            aria-label={name}
            onClick={() => onOpen(P.openTask(row.id, row.org_id, row.num))}
          >
            {row.title}
          </Button>
          <span className="pov-need-sub">
            {place && (
              <span className="pov-need-place">
                <ProjectName {...place} />
              </span>
            )}
            {reasons.map((r) => (
              <span key={r} className="pov-need-reason">
                {r.startsWith('blocks') || r.startsWith('blocked') ? (
                  <Icon name="link" size={12} color="var(--text-2)" />
                ) : null}
                {r}
              </span>
            ))}
          </span>
        </span>
        {it && (
          <span className="pov-need-actions">
            <AssigneeAvatar issue={it} variant="action" className="pov-action" />
            <MoveDue it={it} />
          </span>
        )}
        <span className="pov-need-fact" data-kind={kind}>
          <b className="pov-fact-top">{fact}</b>
          {date && <span>{date}</span>}
        </span>
        <span className="pov-need-owner">{owner && <Avatar id={owner} size={28} />}</span>
      </StaticControlsContext.Provider>
    </li>
  )
}

function NeedsPanel({
  info,
  needs,
  filter,
  setFilter,
  day,
  onOpen,
}: {
  info: ScopeInfo
  needs: NeedsView
  filter: Filter
  setFilter: (f: Filter) => void
  day: string
  onOpen: (id: string) => void
}) {
  const ids = useId()
  const panel = `${ids}-panel`
  const idOf = (id: Filter) => `${ids}-tab-${id}`
  const answer = needs?.value?.state === 'ok' ? needs.value : null
  const c = answer?.counts
  const figure = (f: { state: string; count?: number } | undefined) =>
    f?.state === 'ok' ? (f.count ?? null) : null
  const tracks = answer?.tracks_delay ?? true
  const tabs: Tab[] = [
    { id: 'all', label: 'All', count: figure(c?.all) },
    { id: 'overdue', label: KIND_LABEL.overdue, count: c?.overdue ?? null },
    ...(tracks
      ? ([
          { id: 'projected', label: KIND_LABEL.projected, count: figure(c?.projected) },
          { id: 'behind', label: KIND_LABEL.behind, count: figure(c?.behind) },
        ] satisfies Tab[])
      : []),
    { id: 'blocked', label: KIND_LABEL.blocked, count: c?.blocked ?? null },
    { id: 'no_reviewer', label: KIND_LABEL.no_reviewer, count: c?.no_reviewer ?? null },
    { id: 'paused', label: KIND_LABEL.paused, count: c?.paused ?? null },
  ]
  const unknown = c !== undefined && c.all.state !== 'ok' ? c.all : null
  const rows = answer?.rows ?? []
  const listRoot = useRef<HTMLDivElement>(null)
  // the row focus was in last, and where focus goes once a change takes it
  // out of the tab: the next row, else the one before, else the heading
  const focused = useRef<{ uuid: string; target: () => HTMLElement | null } | null>(null)
  const heading = () =>
    headingTarget(listRoot.current?.closest('section')?.querySelector<HTMLElement>('h2')) ?? null
  const focusIn = (handle: string, uuid: string) => {
    focused.current = {
      uuid,
      target: focusAround(
        'data-need',
        handle,
        (row) => row.querySelector<HTMLElement>('[data-focus-key="row"]'),
        heading,
      ),
    }
  }
  const was = focused.current
  useFocusWhenGone(was === null || rows.some((r) => r.id === was.uuid), () =>
    focused.current ? focused.current.target() : null,
  )
  // Load more leaves at the end of the list or where its rows failed:
  // focus it left nowhere goes to Retry, else to the list
  useFocusWhenGone(
    (needs?.more ?? null) !== null,
    () => listRoot.current?.querySelector<HTMLElement>('[data-ov-needs-retry]') ?? listRoot.current,
  )
  // the rows the answer shown answers, so a tab on its way keeps the last
  // answer's rows, dimmed, rather than none
  const shownKind = needs?.ask.kind ?? filter
  let body: ReactNode
  if (needs === null || (needs.value === undefined && needs.error === undefined))
    body = (
      <div role="status" className="pov-placeholder" data-ov-needs-state="loading">
        Loading…
      </div>
    )
  else if (needs.value === undefined)
    body = (
      <div role="alert" className="pov-note" data-ov-needs-state="error">
        This list could not be loaded.
        <Button
          type="button"
          variant="ghost"
          className="h-control-sm text-sm"
          onClick={() => {
            P.overviewRetry('needs')
            listRoot.current?.focus()
          }}
        >
          Try again
        </Button>
      </div>
    )
  else if (needs.value.state === 'over_budget')
    body = (
      <div className="pov-note" data-ov-needs-state="over_budget">
        Qivo could not check every task here in one request.
        {info.isMeta ? ' Open a sub-project to see what needs attention there.' : ''}
      </div>
    )
  else if (needs.value.state === 'unavailable')
    body = (
      <div className="pov-note" data-ov-needs-state="unavailable">
        {needs.value.message ?? 'Qivo cannot show this list here.'}
      </div>
    )
  else
    body = (
      <>
        {rows.length > 0 ? (
          <ul
            className={cn('pov-list', needs.kept && 'opacity-60')}
            data-ov-needs-state={needs.kept ? 'refreshing' : 'ok'}
          >
            {rows.map((row) => (
              <NeedRow
                key={row.id}
                row={row}
                day={day}
                inProject={info.isMeta}
                onOpen={onOpen}
                onFocusIn={focusIn}
              />
            ))}
          </ul>
        ) : (
          <p className="pov-empty" data-ov-needs-state="empty">
            {(shownKind === 'all' || shownKind === 'projected' || shownKind === 'behind') &&
            c?.[shownKind].state !== 'ok'
              ? KIND_NONE_FOUND[shownKind]
              : shownKind === 'all'
                ? 'Nothing needs attention.'
                : KIND_EMPTY[shownKind]}
          </p>
        )}
        {needs.more !== null && (
          <Button
            type="button"
            variant="ghost"
            data-ov-more
            aria-disabled={needs.more === 'loading' || undefined}
            className={cn('pov-more', needs.more === 'loading' && 'pointer-events-none italic')}
            onClick={() => {
              if (needs.more === 'ready') P.overviewMore('needs')
            }}
          >
            {needs.more === 'loading' ? 'Loading…' : 'Load more'}
          </Button>
        )}
        {needs.moreFailed && (
          <div role="alert" className="pov-note">
            Couldn't load more tasks.
            <Button
              type="button"
              variant="ghost"
              data-ov-needs-retry
              className="h-control-sm text-sm"
              onClick={() => {
                P.overviewRetry('needs')
                listRoot.current?.focus()
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {answer && answer.rows.length >= answer.most && answer.total > answer.most && (
          <p className="pov-note">
            Qivo shows the first {answer.most.toLocaleString('en-US')} tasks of this list.
          </p>
        )}
      </>
    )
  return (
    <OvSection
      title={
        <>
          Needs attention
          <span className="pov-count" data-ov-figure="needs">
            {c ? (figure(c.all) ?? '') : ''}
          </span>
        </>
      }
    >
      <Tabs tabs={tabs} active={filter} onChange={setFilter} panel={panel} idOf={idOf} />
      {unknown && (
        <p className="pov-note" data-ov-unknown data-ov-reason={unknown.reason}>
          {unknown.reason === 'loads' && onePersonAtATime(info)
            ? 'Your access shows other people’s work one person at a time, so Qivo could not work out every projected delay. Projected to miss and Behind plan may leave tasks out.'
            : unknown.reason === 'loads'
              ? 'Someone here has more open work than Qivo reads at once, so Qivo could not work out every projected delay. Projected to miss and Behind plan may leave tasks out.'
              : 'Qivo could not work out every projected delay here in one request. Projected to miss and Behind plan may leave tasks out.'}
        </p>
      )}
      <div
        ref={listRoot}
        id={panel}
        role="tabpanel"
        tabIndex={-1}
        className="outline-none"
        aria-labelledby={idOf(filter)}
        aria-busy={needs?.kept || needs?.more === 'loading' || undefined}
        data-ov-needs
      >
        {body}
      </div>
    </OvSection>
  )
}

function Chip({ kind, n, label }: { kind: string; n: number; label: string }) {
  return (
    <span className="pov-slot">
      {n > 0 && (
        <HoverTooltip content={label}>
          <span className="pov-chip" data-kind={kind} tabIndex={-1}>
            <Icon
              name={kind === 'late' ? 'warning' : kind === 'behind' ? 'clockFading' : 'pause'}
              size={11}
              strokeWidth={2.6}
            />
            {n}
          </span>
        </HoverTooltip>
      )}
    </span>
  )
}

function SubRow({ row, onOpen }: { row: HealthRow; onOpen: (id: string) => void }) {
  const c = row.counts.state === 'ok' ? row.counts : null
  const left = c ? c.leaves.backlog + c.leaves.todo + c.leaves.progress + c.leaves.review : null
  const d = row.delays.state === 'ok' ? row.delays : null
  // the lead is named in its project's organization only, as the health
  // table names it, since a read in another organization answers them gone
  const org = P.project(row.project_id)?.org ?? null
  const [lead] = useOrgPeople(org ?? '', [org ? row.lead_id : null])
  const parts = [
    row.name,
    lead && lead.state !== 'gone'
      ? `${personLabel(lead, 'No lead assigned')}, Lead`
      : 'No lead assigned',
    c
      ? `${plural(left ?? 0, 'task')} left, ${fmtHours(c.left_tenths / 10)} hours left`
      : 'counts not known',
    d
      ? `${d.late} ${DELAY_LABELS.late.toLowerCase()}, ${d.behind} ${DELAY_LABELS.behind.toLowerCase()}`
      : `${DELAY_LABELS.late} and ${DELAY_LABELS.behind} unknown`,
    c ? `${c.paused} paused` : null,
  ]
  return (
    <li>
      <Button
        type="button"
        variant="unstyled"
        className="pov-sub"
        data-ov-sub={row.project_id}
        aria-label={parts.filter(Boolean).join(', ')}
        onClick={() => onOpen(row.project_id)}
      >
        <span className="pov-sub-lead">
          {lead && lead.state !== 'gone' ? (
            <Avatar id={lead.id} size={28} />
          ) : (
            <Avatar id={null} size={28} />
          )}
        </span>
        <span className="pov-sub-main">
          <span className="pov-sub-name">{row.name}</span>
          <span className="pov-sub-num">
            {c ? (
              <>
                <span className="pov-sub-tasks">
                  <b className="pov-sub-fig">{left}</b> {left === 1 ? 'task' : 'tasks'}
                </span>
                <i aria-hidden="true" />
                <span>
                  <b className="pov-sub-fig">{fmtHours(c.left_tenths / 10)}h</b> left
                </span>
              </>
            ) : row.counts.state === 'unavailable' && row.counts.reason === 'counting' ? (
              'Counting…'
            ) : (
              'unknown'
            )}
          </span>
        </span>
        <span className="pov-slots">
          {d ? (
            <>
              <Chip kind="late" n={d.late} label={DELAY_LABELS.late} />
              <Chip kind="behind" n={d.behind} label={DELAY_LABELS.behind} />
            </>
          ) : (
            <span className="pov-sub-unknown">unknown</span>
          )}
          <Chip kind="paused" n={c?.paused ?? 0} label="Paused" />
        </span>
      </Button>
    </li>
  )
}

function SubProjectsPanel({
  health,
  onOpen,
}: {
  health: HealthView
  onOpen: (id: string) => void
}) {
  const answer = health?.value?.state === 'ok' ? health.value : null
  const root = useRef<HTMLDivElement>(null)
  // Load more leaves at the end of the list or where its rows failed:
  // focus it left nowhere goes to Retry, else to the list
  useFocusWhenGone(
    (health?.more ?? null) !== null,
    () => root.current?.querySelector<HTMLElement>('[data-ov-subs-retry]') ?? root.current,
  )
  /** `step` for a button that goes with its press, with focus on the list. */
  const inList = (step: () => void) => () => {
    step()
    root.current?.focus()
  }
  let body: ReactNode
  if (health === null || (health.value === undefined && health.error === undefined))
    body = (
      <div role="status" className="pov-placeholder pov-placeholder-short">
        Loading…
      </div>
    )
  else if (health.value === undefined)
    body = (
      <div role="alert" className="pov-note">
        The sub-projects could not be loaded.
        <Button
          type="button"
          variant="ghost"
          className="h-control-sm text-sm"
          onClick={inList(() => P.overviewRetry('health'))}
        >
          Try again
        </Button>
      </div>
    )
  else if (!answer)
    body = <div className="pov-note">Qivo could not list the sub-projects in one request.</div>
  else
    body = (
      <>
        <ul className="pov-list" data-ov-subs>
          {answer.rows.map((row) => (
            <SubRow key={row.project_id} row={row} onOpen={onOpen} />
          ))}
        </ul>
        {answer.sort.by_name && (
          <p className="pov-note">
            {answer.sort.missing === 'counting'
              ? 'Qivo is counting the tasks here, so the sub-projects are in name order.'
              : `Qivo could not work out every ${DELAY_LABELS.late} and ${DELAY_LABELS.behind} count, so the sub-projects are in name order.`}
          </p>
        )}
        {health.moreFailed && (
          <div role="alert" className="pov-note">
            Couldn't load more sub-projects.
            <Button
              type="button"
              variant="ghost"
              data-ov-subs-retry
              className="h-control-sm text-sm"
              onClick={inList(() => P.overviewRetry('health'))}
            >
              Retry
            </Button>
          </div>
        )}
        {answer.rows.length >= answer.most && answer.total > answer.rows.length && (
          <p className="pov-note" data-ov-subs-cap>
            Qivo shows the first {answer.rows.length.toLocaleString('en-US')} of{' '}
            {answer.total.toLocaleString('en-US')} sub-projects.
          </p>
        )}
        {health.more !== null && (
          <Button
            type="button"
            variant="ghost"
            data-ov-subs-more
            className={cn('pov-more', health.more === 'loading' && 'pointer-events-none italic')}
            aria-disabled={health.more === 'loading' || undefined}
            onClick={() => {
              if (health.more === 'ready') P.overviewMore('health')
            }}
          >
            {health.more === 'loading' ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </>
    )
  return (
    <OvSection title="Sub-projects">
      <div ref={root} tabIndex={-1} className="outline-none">
        {body}
      </div>
    </OvSection>
  )
}

const PEOPLE_FIRST = 8

function LoadPanel({
  people,
  failed,
  org,
  live,
}: {
  people: readonly { id: string; listed: number }[] | null
  failed: boolean
  org: string
  live: boolean
}) {
  const [all, setAll] = useState(false)
  // the people's loads read while the panel and the tab show, as Team
  // utilization's do, a guest's or Viewer's capped calls going first to
  // those who hold the most listed tasks. A kept page that hides, or a
  // body that gives way to a note, stops the reads and keeps their answers
  // for a return
  const owners = (people ?? []).map((p) => ({ org, owner: p.id, cards: p.listed + 1 }))
  const key = JSON.stringify(owners)
  useEffect(() => {
    const need = JSON.parse(key)
    P.watchOverviewPeople(need, live)
    return () => P.watchOverviewPeople(need, false)
  }, [key, live])
  const named = usePeople((people ?? []).map((p) => ({ org, id: p.id })))
  const week = TODAY_WEEK
  const rows = (people ?? []).map((p, i) => {
    const person = named[i] ?? { state: 'loading' as const, id: p.id }
    const load = P.ownerLoad(org, p.id)
    const items = P.ownerItems(org, p.id)
    const hours: number | 'waiting' | 'unknown' =
      load.state === 'waiting'
        ? 'waiting'
        : items
          ? (figuresOf(p.id, items, { from: week, to: week }, undefined).hours.get(week) ?? 0)
          : 'unknown'
    const cap = capacityOf(person)
    const pct =
      typeof hours === 'number' && cap !== null && hasPlannableWeek(cap)
        ? Math.round((hours / cap) * 100)
        : null
    return { p, person, hours, pct }
  })
  const rank = (r: (typeof rows)[number]) =>
    typeof r.hours !== 'number' ? -2 : r.pct === null ? -1 : r.pct
  rows.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      (typeof b.hours === 'number' ? b.hours : 0) - (typeof a.hours === 'number' ? a.hours : 0) ||
      personLabel(a.person, '').localeCompare(personLabel(b.person, '')),
  )
  const shown = all ? rows : rows.slice(0, PEOPLE_FIRST)
  return (
    <OvSection
      title="Load this week"
      action={<span className="pov-head-note">{`${weekNumLabel(week)}, all projects`}</span>}
    >
      {people === null && failed ? (
        <p className="pov-note">Qivo could not list the people with work here.</p>
      ) : people === null ? (
        <div role="status" className="pov-placeholder pov-placeholder-short">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <p className="pov-empty">No one has open work here.</p>
      ) : (
        <>
          <ul className="pov-list" data-ov-people>
            {shown.map(({ p, person, hours, pct }) => {
              const tone = pct === null ? 'normal' : loadTone(pct)
              const name = personLabel(person, 'Unknown user')
              const value =
                hours === 'waiting'
                  ? '…'
                  : hours === 'unknown'
                    ? 'unknown'
                    : pct === null
                      ? `${fmtHours(hours)}h`
                      : `${pct}%`
              const said =
                hours === 'waiting'
                  ? 'loading'
                  : hours === 'unknown'
                    ? 'load unknown'
                    : pct === null
                      ? `${fmtHours(hours)} hours this week`
                      : `${pct}% of their week, ${fmtHours(hours)} hours`
              return (
                <li
                  key={p.id}
                  className="pov-person"
                  data-tone={tone}
                  data-ov-person={p.id}
                  aria-label={`${name}, ${said}${p.listed ? `, ${plural(p.listed, 'listed task')}` : ''}`}
                >
                  <Avatar id={p.id} size={28} />
                  <span className="pov-person-name">
                    <span>{name}</span>
                    {p.listed > 0 && <small>{p.listed} of the listed tasks</small>}
                  </span>
                  {pct !== null ? (
                    <span className="pov-meter" aria-hidden="true">
                      <i style={{ width: `${Math.min(pct, 100)}%` }} />
                    </span>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <b className="pov-person-pct" aria-hidden="true">
                    {value}
                  </b>
                </li>
              )
            })}
          </ul>
          {rows.length > PEOPLE_FIRST && (
            <Button type="button" variant="ghost" className="pov-more" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </Button>
          )}
        </>
      )}
    </OvSection>
  )
}

/** The line under an upcoming milestone: how many Late tasks are due on or
    before the first day of its week, in the calendar of its organization,
    whose weeks start on `weekStart`, so every reader counts the same
    tasks; those of the milestones above it left out. */
function lateLine(
  days: readonly { due: string; count: number }[],
  m: MilestoneVM,
  before: MilestoneVM | null,
  weekStart: number,
): string {
  const upTo = (row: MilestoneVM) => {
    const day = firstDayOfWeek(row.day, weekStart)
    return days.reduce((n, d) => (d.due <= day ? n + d.count : n), 0)
  }
  const n = upTo(m) - (before ? upTo(before) : 0)
  const late = DELAY_LABELS.late.toLowerCase()
  if (before === null)
    return n === 0
      ? `No ${late} task is due before it`
      : `${plural(n, `${late} task`)} ${n === 1 ? 'is' : 'are'} due before it`
  return n === 0
    ? `No other ${late} task is due before it`
    : `${n} more ${late} ${n === 1 ? 'task is' : 'tasks are'} due before it`
}

function MilestoneRow({
  m,
  next,
  past = false,
  line,
  onEdit,
}: {
  m: MilestoneVM
  next: boolean
  past?: boolean
  line: string | null
  onEdit: (id: string, project: string) => void
}) {
  return (
    <Button
      type="button"
      variant="unstyled"
      onClick={() => onEdit(m.id, m.project)}
      title={`Edit “${m.name}”`}
      data-overview-milestone={m.id}
      data-next={next ? '' : undefined}
      data-past={past ? '' : undefined}
      className="pov-mile"
    >
      <span className="pov-diamond" aria-hidden="true" data-past={past ? '' : undefined} />
      <span className="pov-mile-main">
        <span className="pov-mile-name">{m.name}</span>
        {line && <span className="pov-mile-line">{line}</span>}
      </span>
      <span className="pov-mile-when">
        <b className="pov-mile-rel">{relativeWeek(m.week)}</b>
        <time dateTime={weekToISO(m.week)}>{weekLabel(m.week)}</time>
      </span>
    </Button>
  )
}

export function ProjectOverview({ info, actions }: { info: ScopeInfo; actions: OverviewActions }) {
  const mobile = useMobile()
  const { paneRef } = useOverviewPanelClipping(!mobile)
  const openIssue = useLatest((open: string) => actions.openIssue(open))
  const [filter, setFilter] = useState<Filter>('all')
  const read = useOverviewRead(
    info,
    info.isMeta ? { sort: 'late', dir: 'desc', search: '' } : null,
    { kind: filter },
    'status',
  )
  const ms = useScopeMilestones(info, OVERVIEW_MILESTONE_SLOTS)
  const newMilestone = useRef<HTMLButtonElement>(null)
  const milestonesRoot = useRef<HTMLDivElement>(null)
  const pastBodyId = useId()
  const editMilestone = (id: string, project?: string) =>
    actions.editMilestone(
      id,
      focusAround(
        'data-overview-milestone',
        id,
        (row) => row,
        () =>
          newMilestone.current ??
          milestonesRoot.current?.querySelector<HTMLElement>(
            '[data-milestone-section="upcoming"] [data-milestone-note="empty"]',
          ) ??
          shownEmptyState(),
      ),
      project,
    )

  const summaryAnswer = read.summary?.value
  let state: OverviewState
  if (read.summary === null) state = 'loading'
  else if (read.summary.error !== undefined) state = 'error'
  else if (summaryAnswer?.state === 'unavailable') state = 'unavailable'
  else if (summaryAnswer?.state === 'over_budget') state = 'over_budget'
  else state = read.summary.current ? 'ok' : 'refreshing'
  const ok = summaryAnswer?.state === 'ok' ? summaryAnswer : null
  const counts = shownOf(read.summary, (s) => s.counts)
  const anyTask = shownOf(read.summary, (s) => s.any_task)
  const c = given(counts)
  const tasksLeft = c
    ? c.leaves.backlog + c.leaves.todo + c.leaves.progress + c.leaves.review
    : null
  const day = read.request.base.clock.day
  const needsAnswer = read.needs?.value?.state === 'ok' ? read.needs.value : null
  // a project that tracks no delay has no Projected to miss or Behind plan
  // tab, so a choice of one goes back to All
  if (needsAnswer && !needsAnswer.tracks_delay && (filter === 'projected' || filter === 'behind'))
    setFilter('all')

  // the sub-projects a top-level project past its limits offers
  const overBudgetChoices = usePagedList<NavChildren, NavChildRow>({
    key: state === 'over_budget' && info.isMeta ? JSON.stringify(['ov-children', info.id]) : null,
    source: {
      kind: 'live',
      query: api.projectNav.children,
      args: (at) => ({ project_id: info.id, ...navCursors(at) }),
    },
    batch: (a) => (a.state === 'ok' ? a : null),
    id: (row) => row.id,
    most: 25,
  })

  let note: ReactNode = null
  if (state === 'unavailable')
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
  else if (state === 'over_budget')
    note = (
      <ViewNote
        hooks="ov"
        phone={mobile}
        icon="filter"
        title="This view could not be loaded within the Overview's limits."
        hint={
          info.isMeta
            ? overBudgetChoices.next || overBudgetChoices.stopped
              ? 'Choose a sub-project to see its figures. The sidebar lists the rest.'
              : 'Choose a sub-project to see its figures.'
            : 'Open its Board, or find its tasks with Search.'
        }
        projects={info.isMeta ? overBudgetChoices.rows : undefined}
        onProject={(id) => actions.setScope(id)}
        action={
          !info.isMeta && actions.openPalette
            ? { label: 'Search this sub-project', onClick: () => actions.openPalette?.(info.id) }
            : undefined
        }
      />
    )
  else if (state === 'error')
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
  let emptyNote: ReactNode = null
  if (ok && (state === 'ok' || state === 'refreshing')) {
    if (ok.sub_projects?.length === 0)
      emptyNote = (
        <EmptyState
          icon="chart"
          title="Nothing to summarize yet"
          hint="Tasks live in sub-projects."
          actionLabel={P.canManageOwnProjectAccess(info.id) ? 'New sub-project' : undefined}
          onAction={() => actions.newProject({ parent: info.id })}
        />
      )
    else if (given(anyTask)?.value === false)
      emptyNote = (
        <EmptyState
          icon="chart"
          title="No tasks yet"
          actionLabel={P.canWrite(info.id) ? 'New task' : undefined}
          onAction={() => actions.newIssue({ project: ok.sub_projects?.[0] ?? info.id })}
        />
      )
  }
  const replaced = note ?? emptyNote
  const alone = replaced !== null && !ms.stands
  const busy = state === 'loading' || state === 'refreshing'
  const factState = counts.state
  const canAdd = P.canAddMilestone(info.id)

  const upcomingRows = ms.upcoming.view.rows
  const lateDays = needsAnswer?.late_due.state === 'ok' ? needsAnswer.late_due.days : null
  const milestones = (
    <OvSection
      title="Milestones"
      action={
        canAdd ? (
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
        ) : null
      }
    >
      <div ref={milestonesRoot} data-overview-milestones className="flex flex-col gap-1">
        <MilestoneSectionPart
          side="upcoming"
          section={ms.upcoming}
          open
          searchable={false}
          pastKnown={ms.upcoming.view.past === false}
          header={null}
          scroller="[data-overview-root]"
          rowMark="data-overview-milestone"
          rowsClassName="pov-miles"
          sentences={{
            noneYet: canAdd
              ? 'No milestones yet. Add one with the + button.'
              : 'No milestones yet.',
          }}
        >
          {upcomingRows.map((m, i) => (
            <MilestoneRow
              key={m.id}
              m={m}
              next={m.id === ms.nextId}
              line={
                needsAnswer && !needsAnswer.tracks_delay
                  ? null
                  : lateDays === null
                    ? needsAnswer
                      ? `Qivo could not count the ${DELAY_LABELS.late.toLowerCase()} tasks due before it`
                      : null
                    : lateLine(
                        lateDays,
                        m,
                        i > 0 ? (upcomingRows[i - 1] ?? null) : null,
                        P.orgWeekStart(info.proj?.org ?? ''),
                      )
              }
              onEdit={editMilestone}
            />
          ))}
        </MilestoneSectionPart>
        {ms.showPast && (
          <MilestoneSectionPart
            side="past"
            section={ms.past}
            open={ms.pastOpen}
            searchable={ms.pastSearchable}
            bodyId={pastBodyId}
            scroller="[data-overview-root]"
            rowMark="data-overview-milestone"
            rowsClassName="pov-miles"
            header={
              <Button
                type="button"
                variant="ghost"
                data-milestone-past-toggle
                aria-expanded={ms.pastOpen}
                aria-controls={pastBodyId}
                onClick={() => ms.setPastOpen(!ms.pastOpen)}
                className="pov-past-toggle"
              >
                <Icon
                  name={ms.pastOpen ? 'chevronDown' : 'chevronRight'}
                  size={14}
                  color="var(--text-2)"
                />
                Past
                {ms.pastOpen && ms.past.view.count !== null && (
                  <span data-milestone-count className="font-normal text-text-2">
                    {ms.past.view.count}
                  </span>
                )}
              </Button>
            }
          >
            {ms.pastOpen
              ? ms.past.view.rows.map((m) => (
                  <MilestoneRow
                    key={m.id}
                    m={m}
                    next={false}
                    past
                    line={null}
                    onEdit={editMilestone}
                  />
                ))
              : []}
          </MilestoneSectionPart>
        )}
      </div>
    </OvSection>
  )

  return (
    <div
      ref={paneRef}
      data-scroll
      data-screen-label="Overview"
      data-overview-root
      data-overview-page="status"
      data-overview-state={state}
      {...(state === 'unavailable' && summaryAnswer?.state === 'unavailable' && summaryAnswer.reason
        ? { 'data-ov-reason': summaryAnswer.reason }
        : {})}
      aria-busy={busy || undefined}
      className={cn('overview-view pov [flex:1] [overflow:auto]', alone && 'flex flex-col')}
    >
      {alone ? (
        replaced
      ) : (
        <div className="pov-page">
          {replaced ?? (
            <>
              <section className="pov-head" data-ov-head aria-label="Summary">
                <Sentence needs={read.needs} tasksLeft={tasksLeft} />
                <div className="pov-facts" data-ov-facts>
                  <Fact label="Tasks left" name="tasks-left" state={factState}>
                    {tasksLeft ?? placeholder(counts)}
                  </Fact>
                  <Fact label="Hours left" name="hours-left" state={factState}>
                    {c ? `${fmtHours(c.left_tenths / 10)}h` : placeholder(counts)}
                  </Fact>
                  <LeadFact info={info} />
                </div>
              </section>
              {counts.state === 'unavailable' && (
                <p className="pov-page-note" data-ov-counts-note>
                  Qivo could not count the tasks here in one request.{narrower(info)}
                </p>
              )}
            </>
          )}
          <div className="pov-cols">
            {replaced === null && (
              <div className="pov-col">
                <NeedsPanel
                  info={info}
                  needs={read.needs}
                  filter={filter}
                  setFilter={setFilter}
                  day={day}
                  onOpen={openIssue}
                />
              </div>
            )}
            <div className="pov-col">
              {replaced === null && info.isMeta && (
                <SubProjectsPanel
                  health={read.health}
                  onOpen={(id) => {
                    actions.setScope(id)
                    actions.setView('kanban')
                  }}
                />
              )}
              {replaced === null && (
                <LoadPanel
                  people={needsAnswer?.people ?? null}
                  failed={
                    read.needs !== null &&
                    (read.needs.value === undefined
                      ? read.needs.error !== undefined
                      : read.needs.value.state !== 'ok')
                  }
                  org={info.proj?.org ?? ''}
                  live={read.visible}
                />
              )}
              {milestones}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
