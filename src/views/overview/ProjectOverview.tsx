/* A project or sub-project's Overview: what is left and what needs
   attention. One row on top states the problem in a sentence beside Tasks
   left, Hours left and the lead. Under it, Needs attention ranks every task
   that needs someone, by kind, with filter tabs, and beside it a project's
   Sub-projects, the people's Load this week and the Milestones. Nothing
   finished is counted or drawn.

   Every figure is the server's (convex/overview.ts): the summary's counts
   for Tasks left and Hours left, and the Needs attention list's kinds,
   counts, people and Late tasks by due date (overview.needs), whose answer
   for a project also holds its health table, sorted by Late, for
   Sub-projects, through the store's reads (store/overviewLists.ts, page
   'status'). Sub-projects shows that answer's rows 10 at a time. The people's
   loads come from the owner-load cache, as the Roadmap's Team utilization
   reads them (planning.ownerLoads, views/teamWeeks.ts), so a load counts
   the projects the reader can see. A figure the server answers unavailable
   shows a dash or "unknown" and why, never a number. The milestones are
   views/useScopeMilestones.ts's, as My view's Overview reads them. */

import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { Button } from '@/components/ui/button'
import { afterPress, pressing } from '@/lib/afterPress'
import { TODAY_WEEK, weekNumLabel } from '@/lib/dates'
import { focusAround } from '@/lib/focusWhenGone'
import { StaticControlsContext, useLiveControls } from '@/lib/liveControls'
import { usePagedList } from '@/lib/pagedList'
import { shownEmptyState } from '@/lib/taskFocus'
import { useLatest } from '@/lib/useLatest'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { fmtHours, hasPlannableWeek, loadTone } from '@/lib/workload'
import { type NeedsView, OVERVIEW_BATCH } from '@/store/overviewLists'
import { api } from '../../../convex/_generated/api'
import type { NeedsKind, NeedsRow } from '../../../convex/lib/overviewNeeds'
import { taskOwnerId } from '../../../convex/lib/review'
import type { NavChildRow, NavChildren } from '../../../convex/model/projectNavReads'
import { navCursors } from '../../components/projectNavRows'
import { Avatar, DateInput, EmptyState, Icon, ProjectName } from '../../components/qivo'
import { personLabel, useOrgPeople, usePeople } from '../../components/usePeople'
import { ViewNote } from '../../components/ViewNote'
import { type IssueVM, OVERVIEW_MILESTONE_SLOTS, P, type ScopeInfo } from '../../store/planner'
import { capacityOf } from '../capacity'
import { figuresOf } from '../teamWeeks'
import { useOverviewPanelClipping } from '../useOverviewPanelClipping'
import { useScopeMilestones } from '../useScopeMilestones'
import { OvSection } from './OvSection'
import {
  factOf,
  KIND_LABEL,
  LATE_UNKNOWN,
  lateLine,
  plural,
  reasonsOf,
  useRowFocus,
} from './overviewFacts'
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
import {
  Fact,
  LoadMore,
  MilestonesPanel,
  NeedFlag,
  ProjectsPanel,
  type ProjectsView,
  Sentence,
  type SentenceFacts,
} from './overviewRows'
import './ProjectOverview.css'
import '../Overview.css'
import '../../styles/mobile-views.css'

const NEEDS_SLOT = 'overview:needs'

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
  onFocusOut,
}: {
  row: NeedsRow
  day: string
  inProject: boolean
  onOpen: (id: string) => void
  /** focus entered the row, also its calendar or picker */
  onFocusIn: (handle: string, uuid: string) => void
  /** focus left an element of the row, for another one or for none */
  onFocusOut: (e: FocusEvent) => void
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
  const [keepActions, setKeepActions] = useState(false)
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
      onBlurCapture={onFocusOut}
      onBlur={(e) => {
        if (!pressing()) return
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setKeepActions(true)
        afterPress(() => setKeepActions(false))
      }}
      className="pov-need"
      data-need={handle}
      data-need-id={row.id}
      data-kind={kind}
      data-keep-actions={keepActions || undefined}
    >
      <StaticControlsContext.Provider value={controls.value}>
        <NeedFlag kind={kind} />
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
  const { focusIn, focusOut } = useRowFocus(
    'need',
    (uuid) => rows.some((r) => r.id === uuid),
    () => listRoot.current?.closest('section')?.querySelector<HTMLElement>('h2'),
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
            className={cn('pov-list', (!needs.current || needs.kept) && 'opacity-60')}
            data-ov-needs-state={!needs.current || needs.kept ? 'refreshing' : 'ok'}
          >
            {rows.map((row) => (
              <NeedRow
                key={row.id}
                row={row}
                day={day}
                inProject={info.isMeta}
                onOpen={onOpen}
                onFocusIn={focusIn}
                onFocusOut={focusOut}
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
        <LoadMore
          more={needs.more}
          failed={needs.moreFailed}
          what="tasks"
          root={() => listRoot.current}
          onMore={() => P.overviewMore('needs')}
          onRetry={() => P.overviewRetry('needs')}
          hook={{ more: 'data-ov-more', retry: 'data-ov-needs-retry' }}
        />
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
        aria-busy={
          (needs && (!needs.current || needs.kept)) || needs?.more === 'loading' || undefined
        }
        data-ov-needs
      >
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
  // those who hold the most listed tasks. A new count replaces the
  // registration in place, so the reads it keeps go on without a restart.
  // A kept page that hides, or a body that gives way to a note, stops the
  // reads and keeps their answers for a return
  const owners = (people ?? []).map((p) => ({ org, owner: p.id, cards: p.listed + 1 }))
  const key = JSON.stringify(owners)
  useEffect(() => {
    P.watchOverviewPeople(JSON.parse(key), live)
  }, [key, live])
  useEffect(() => () => P.stopOverviewPeople(), [])
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
  // where the panel stands, as its root's data-ov-people-state names it:
  // loading until every person's load and name has answered
  const state =
    people === null
      ? failed
        ? 'unavailable'
        : 'loading'
      : rows.some((r) => r.hours === 'waiting' || r.person.state === 'loading')
        ? 'loading'
        : 'ok'
  return (
    <OvSection
      title="Load this week"
      action={<span className="pov-head-note">{`${weekNumLabel(week)}, all projects`}</span>}
    >
      <div data-ov-people-state={state} aria-busy={state === 'loading' || undefined}>
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
              <Button
                type="button"
                variant="ghost"
                className="pov-more"
                onClick={() => setAll(!all)}
              >
                {all ? 'Show fewer' : `Show all ${rows.length}`}
              </Button>
            )}
          </>
        )}
      </div>
    </OvSection>
  )
}

/** The Sub-projects a top-level project's Needs attention answer holds
    (convex/lib/overviewNeeds.ts NeedsAnswer health), as ProjectsPanel
    shows them: the first `shown` rows, with Load more while the answer
    holds more. */
function subProjectsOf(needs: NeedsView, shown: number): ProjectsView {
  if (needs === null) return null
  const read = { current: needs.current, kept: needs.kept, more: null, moreFailed: false }
  if (needs.value === undefined)
    return needs.error === undefined ? null : { ...read, error: needs.error }
  if (needs.value.state !== 'ok') return { ...read, value: needs.value }
  const table = needs.value.health
  if (table === undefined) return null
  return {
    ...read,
    value: { ...table, rows: table.rows.slice(0, shown) },
    more: shown < table.rows.length ? 'ready' : null,
  }
}

/** The sentence's facts from the Needs attention list's answer. */
function sentenceFacts(needs: NeedsView): SentenceFacts {
  if (needs === null || (needs.value === undefined && needs.error === undefined)) return 'loading'
  if (needs.value === undefined) return 'error'
  if (needs.value.state !== 'ok') return 'partial'
  const c = needs.value.counts
  return {
    overdue: c.overdue,
    projected: c.projected.state === 'ok' ? c.projected.count : null,
    blocked: c.blocked,
    clear: c.all.state === 'ok' && c.all.count === 0,
  }
}

export function ProjectOverview({ info, actions }: { info: ScopeInfo; actions: OverviewActions }) {
  const mobile = useMobile()
  const { paneRef } = useOverviewPanelClipping(!mobile)
  const openIssue = useLatest((open: string) => actions.openIssue(open))
  const [filter, setFilter] = useState<Filter>('all')
  const read = useOverviewRead(info, null, { kind: filter }, 'status')
  const [subsShown, setSubsShown] = useState(OVERVIEW_BATCH)
  const ms = useScopeMilestones(info, OVERVIEW_MILESTONE_SLOTS)
  const newMilestone = useRef<HTMLButtonElement>(null)
  const milestonesRoot = useRef<HTMLDivElement>(null)
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

  const lateDays = needsAnswer?.late_due.state === 'ok' ? needsAnswer.late_due.days : null
  const milestones = (
    <MilestonesPanel
      ms={ms}
      mine={false}
      onNew={canAdd ? () => actions.newMilestone({}) : null}
      newRef={newMilestone}
      rootRef={milestonesRoot}
      lineOf={(m, i, rows) =>
        needsAnswer && !needsAnswer.tracks_delay
          ? null
          : lateDays === null
            ? needsAnswer
              ? LATE_UNKNOWN
              : null
            : lateLine(
                lateDays,
                m,
                i > 0 ? (rows[i - 1] ?? null) : null,
                P.orgWeekStart(info.proj?.org ?? ''),
              )
      }
      onEdit={editMilestone}
    />
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
                <Sentence facts={sentenceFacts(read.needs)} tasksLeft={tasksLeft} />
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
                <ProjectsPanel
                  title="Sub-projects"
                  noun="sub-projects"
                  health={subProjectsOf(read.needs, subsShown)}
                  orgOf={() => info.proj?.org ?? ''}
                  onOpen={(id) => {
                    actions.setScope(id)
                    actions.setView('kanban')
                  }}
                  onMore={() => setSubsShown((n) => n + OVERVIEW_BATCH)}
                  onRetry={() => P.overviewRetry('needs')}
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
