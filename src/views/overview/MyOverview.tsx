/* My view's Overview: the person's own work that is left, beside their
   status, the milestones of their projects and those projects.

   Your work is the server's (overview.work, convex/lib/overviewWork.ts),
   in three groups with their order and kinds; the status's figures are the
   summary's counts, the projects My view's health table with only the
   projects that hold work left (overview.health with open_only), and the
   milestones views/useScopeMilestones.ts's, through the store's reads
   (store/overviewLists.ts, page 'mine'). Each row's hours and actions
   write through the store (P.updateIssue) with the task window's rules,
   and only for a task the person may edit. Every row of every group lays
   its values on the same columns (MyOverview.css). */

import { type FocusEvent, type ReactNode, useRef, useState } from 'react'
import { StatusSelect } from '@/components/StatusSelect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isoToWeek, TODAY_WEEK } from '@/lib/dates'
import { focusAround } from '@/lib/focusWhenGone'
import { remainingPatch, remainingValue } from '@/lib/remaining'
import { shownEmptyState } from '@/lib/taskFocus'
import { useLatest } from '@/lib/useLatest'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { fmtHours } from '@/lib/workload'
import type { WorkView } from '@/store/overviewLists'
import type { WorkAnswer, WorkRow } from '../../../convex/lib/overviewWork'
import { WORK_GROUPS, type WorkGroup } from '../../../convex/lib/workGroups'
import { NoProjects } from '../../components/NoProjects'
import { Avatar, EmptyState, Icon, ProjectName, StatusDot } from '../../components/qivo'
import { useHolds } from '../../components/useHolds'
import { personLabel, useOrgPeople } from '../../components/usePeople'
import { ViewNote } from '../../components/ViewNote'
import {
  type IssueVM,
  type MilestoneVM,
  OVERVIEW_MILESTONE_SLOTS,
  P,
  type ScopeInfo,
} from '../../store/planner'
import { useOverviewPanelClipping } from '../useOverviewPanelClipping'
import { useScopeMilestones } from '../useScopeMilestones'
import { OvSection } from './OvSection'
import {
  dayOf,
  factOf,
  KIND_LABEL,
  LATE_UNKNOWN,
  lateLine,
  reasonsOf,
  useRowFocus,
  weekOf,
} from './overviewFacts'
import {
  given,
  narrower,
  type OverviewActions,
  type OverviewState,
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
  Sentence,
  type SentenceFacts,
} from './overviewRows'
import './ProjectOverview.css'
import './MyOverview.css'
import '../Overview.css'
import '../../styles/mobile-views.css'

const WORK_SLOT = 'overview:work'

const GROUP_TITLE: Record<WorkGroup, string> = {
  progress: 'In progress',
  review: 'Waiting on your review',
  next: 'Next',
}

const GROUP_EMPTY: Record<WorkGroup, string> = {
  progress: 'Nothing is in progress.',
  review: 'Nothing waits for your review.',
  next: 'Nothing is next.',
}

const modelOf = (row: WorkRow): IssueVM | undefined =>
  P.viewTask(WORK_SLOT, row.id) ?? P.anyTask(P.handleNow(row.id, row.org_id, row.num))

/** When a To Do task is planned to start, from its start week. */
function startOf(row: WorkRow): string | null {
  if (!row.start_week) return null
  const week = isoToWeek(row.start_week)
  if (week === TODAY_WEEK) return 'starts this week'
  return week > TODAY_WEEK
    ? `starts ${weekOf(row.start_week)}`
    : `planned to start ${weekOf(row.start_week)}`
}

/** What a row is doing with its writes: saving one, one that failed, or
    hours it could not read. */
type Save = { what: 'hours' | 'change'; state: 'saving' | 'failed' | 'invalid' } | null

/**
 * A task's hours left, as the task window's Remaining reads and writes
 * them (lib/remaining): empty clears them, 0 is a value, and text that is
 * not a number writes nothing and says so. It saves on Enter or on leaving
 * the field; Escape puts back the saved hours. What was typed stays in the
 * field while it saves, where the save fails, and while a live update
 * renders the row again.
 */
function HoursField({ it, onSave }: { it: IssueVM; onSave: (save: Save) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'failed' | 'invalid'>('idle')
  const commit = () => {
    if (draft === null || state === 'saving') return
    const text = draft.trim()
    if (text !== '' && !Number.isFinite(Number(text))) {
      setState('invalid')
      onSave({ what: 'hours', state: 'invalid' })
      return
    }
    const patch = remainingPatch(text, it.remaining)
    if (!patch.write) {
      setDraft(null)
      setState('idle')
      onSave(null)
      return
    }
    setState('saving')
    onSave({ what: 'hours', state: 'saving' })
    void P.updateIssue(it.id, { remaining: patch.value }).then((saved) => {
      if (saved) {
        setDraft(null)
        setState('idle')
        onSave(null)
      } else {
        setState('failed')
        onSave({ what: 'hours', state: 'failed' })
      }
    })
  }
  return (
    <span className="mov-hours-box" data-state={state}>
      <Input
        type="text"
        inputMode="decimal"
        aria-label={`Hours left for ${it.title}`}
        aria-invalid={state === 'invalid' || state === 'failed' || undefined}
        data-ov-hours={it.id}
        placeholder="—"
        value={draft ?? String(remainingValue(it.remaining))}
        onChange={(e) => {
          setDraft(e.target.value)
          if (state === 'invalid' || state === 'failed') setState('idle')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation()
            setDraft(null)
            setState('idle')
            onSave(null)
          }
        }}
        onBlur={commit}
      />
      <span aria-hidden="true">h</span>
    </span>
  )
}

/** A row's note on its writes: saving, or what failed. */
function SaveNote({ save }: { save: Save }) {
  if (save?.state === 'invalid')
    return (
      <span className="mov-note" data-tone="danger" role="alert">
        Enter the hours left as a number.
      </span>
    )
  if (save === null) return null
  if (save.state === 'saving')
    return (
      <span className="mov-note" role="status">
        Saving…
      </span>
    )
  return (
    <span className="mov-note" data-tone="danger" role="alert">
      {save.what === 'hours'
        ? 'The hours were not saved. Your text is still in the field.'
        : 'The change was not saved.'}
    </span>
  )
}

/** The actions of a row in `group`, each the status change the task
    window offers: Start moves a To Do task to In Progress, Send back an
    In Review one to In Progress, which hands it back to its assignee, and
    Approve to Done. */
function Actions({
  it,
  group,
  busy,
  onSave,
}: {
  it: IssueVM
  group: WorkGroup
  busy: boolean
  onSave: (save: Save) => void
}) {
  const move = (status: 'progress' | 'done') => {
    if (busy) return
    onSave({ what: 'change', state: 'saving' })
    void P.updateIssue(it.id, { status }).then((saved) =>
      onSave(saved ? null : { what: 'change', state: 'failed' }),
    )
  }
  if (group === 'progress')
    return (
      <StatusSelect
        it={it}
        labelled
        disabled={busy}
        className="mov-status h-control-sm"
        onStatus={() => onSave({ what: 'change', state: 'saving' })}
        onSaved={(saved) => onSave(saved ? null : { what: 'change', state: 'failed' })}
      />
    )
  if (group === 'review')
    return (
      <>
        <Button
          type="button"
          variant="unstyled"
          className="pov-action"
          aria-label={`Send back ${it.title}`}
          aria-disabled={busy || undefined}
          data-ov-send-back
          onClick={() => move('progress')}
        >
          Send back
        </Button>
        <Button
          type="button"
          variant="unstyled"
          className="pov-action mov-approve"
          aria-label={`Approve ${it.title}`}
          aria-disabled={busy || undefined}
          data-ov-approve
          onClick={() => move('done')}
        >
          <Icon name="check" size={14} strokeWidth={2.4} />
          Approve
        </Button>
      </>
    )
  return (
    <Button
      type="button"
      variant="unstyled"
      className="pov-action"
      aria-label={`Start ${it.title}`}
      aria-disabled={busy || undefined}
      data-ov-start
      onClick={() => move('progress')}
    >
      Start
    </Button>
  )
}

function WorkRowView({
  row,
  group,
  day,
  me,
  onOpen,
  onFocusIn,
  onFocusOut,
}: {
  row: WorkRow
  group: WorkGroup
  day: string
  /** the person's profile ids, for a review they hand themselves */
  me: ReadonlySet<string>
  onOpen: (open: string) => void
  onFocusIn: (handle: string, uuid: string) => void
  onFocusOut: (e: FocusEvent) => void
}) {
  const it = modelOf(row)
  const handle = it?.id ?? P.handleNow(row.id, row.org_id, row.num)
  const kind = row.needs.kind
  const fact = kind === null ? null : factOf({ ...row, needs: { ...row.needs, kind } }, day)
  const reasons = reasonsOf(row)
  const place = P.projectPlace(row.project_id, true)
  const placeName = place ? P.placeLabel(place) : null
  const from = group === 'review' ? (row.assignee_id ?? null) : null
  const [fromName] = useOrgPeople(row.org_id, [from])
  const fromText =
    from === null
      ? null
      : me.has(from)
        ? 'from you'
        : `from ${fromName ? personLabel(fromName, 'Unknown person') : '…'}`
  const start = group === 'next' ? startOf(row) : null
  const due = kind === null && row.due_date ? `due ${dayOf(row.due_date)}` : null
  const parent = row.parent_title ? `part of ${row.parent_title}` : null
  const unknown = row.needs.delay_unknown === true
  const [save, setSave] = useState<Save>(null)
  const editable = !!it && P.canWrite(it.project) && !P.createOnItsWay(it.uuid)
  const remaining = it?.remaining ?? row.remaining_hours ?? null
  const hoursText = remaining === null ? 'no estimate' : `${fmtHours(remaining)} hours left`
  const name = [
    kind ? `${KIND_LABEL[kind]}: ${row.title}` : row.title,
    placeName,
    fact?.fact,
    fact?.date,
    due,
    unknown ? 'Delay unknown' : null,
    ...reasons,
    parent,
    fromText,
    start,
    hoursText,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <li
      onFocusCapture={() => onFocusIn(handle, row.id)}
      onBlurCapture={onFocusOut}
      className="mov-row"
      data-work={handle}
      data-work-id={row.id}
      data-group={group}
      data-kind={kind ?? undefined}
      data-saving={save?.state === 'saving' || undefined}
    >
      <span className="mov-flag">
        {kind ? <NeedFlag kind={kind} /> : <StatusDot status={row.status} />}
      </span>
      <span className="pov-need-main mov-main">
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
          {fact && (
            <span className="mov-fact" data-kind={kind ?? undefined}>
              {fact.date ? `${fact.fact}, ${fact.date}` : fact.fact}
            </span>
          )}
          {due && <span>{due}</span>}
          {unknown && <span className="mov-unknown">Delay unknown</span>}
          {reasons.map((r) => (
            <span key={r} className="pov-need-reason">
              {r}
            </span>
          ))}
          {parent && <span className="mov-parent">{parent}</span>}
          {fromText && <span>{fromText}</span>}
          {start && <span>{start}</span>}
        </span>
        <SaveNote save={save} />
      </span>
      <span className="mov-hours">
        {it && editable ? (
          <HoursField it={it} onSave={setSave} />
        ) : (
          <span className="mov-hours-box mov-hours-text">
            {remaining === null ? '—' : `${fmtHours(remaining)}h`}
          </span>
        )}
        <span className="mov-hours-left">left</span>
      </span>
      <span className="mov-actions">
        {it && editable && (
          <Actions it={it} group={group} busy={save?.state === 'saving'} onSave={setSave} />
        )}
      </span>
    </li>
  )
}

function WorkGroupList({
  group,
  work,
  answer,
  day,
  me,
  onOpen,
}: {
  group: WorkGroup
  work: NonNullable<WorkView>
  answer: Extract<WorkAnswer, { state: 'ok' }>
  day: string
  me: ReadonlySet<string>
  onOpen: (open: string) => void
}) {
  const { rows, total } = answer.groups[group]
  const root = useRef<HTMLDivElement>(null)
  const { focusIn, focusOut } = useRowFocus(
    'work',
    (uuid) => rows.some((r) => r.id === uuid),
    () => root.current?.querySelector<HTMLElement>('h3'),
  )
  const failed = work.failedAt !== null && rows.length < work.failedAt[group] && rows.length < total
  return (
    <div ref={root} tabIndex={-1} className="mov-group outline-none" data-ov-group={group}>
      <h3 className="mov-group-title">
        {GROUP_TITLE[group]}
        <span className="pov-count" data-ov-figure={`work-${group}`}>
          {total}
        </span>
      </h3>
      {rows.length > 0 ? (
        <ul className="pov-list">
          {rows.map((row) => (
            <WorkRowView
              key={row.id}
              row={row}
              group={group}
              day={day}
              me={me}
              onOpen={onOpen}
              onFocusIn={focusIn}
              onFocusOut={focusOut}
            />
          ))}
        </ul>
      ) : (
        <p className="pov-empty" data-ov-group-empty>
          {GROUP_EMPTY[group]}
        </p>
      )}
      <LoadMore
        more={work.more[group]}
        failed={failed}
        what="tasks"
        root={() => root.current}
        onMore={() => P.overviewMore(group)}
        onRetry={() => P.overviewRetry('work')}
        hook={{ more: 'data-ov-more', retry: 'data-ov-work-retry' }}
      />
      {rows.length >= answer.most && total > answer.most && (
        <p className="pov-note">
          Qivo shows the first {answer.most.toLocaleString('en-US')} tasks of this group.
        </p>
      )}
    </div>
  )
}

function WorkPanel({
  info,
  work,
  day,
  onOpen,
  onBoard,
}: {
  info: ScopeInfo
  work: WorkView
  day: string
  onOpen: (open: string) => void
  onBoard: () => void
}) {
  const answer = work?.value?.state === 'ok' ? work.value : null
  const me = new Set(P.myProfileIds)
  const state =
    work === null || (work.value === undefined && work.error === undefined)
      ? 'loading'
      : work.value === undefined
        ? 'error'
        : work.value.state !== 'ok'
          ? work.value.state
          : work.current && !work.kept
            ? 'ok'
            : 'refreshing'
  const root = useRef<HTMLDivElement>(null)
  const empty = answer !== null && WORK_GROUPS.every((g) => answer.groups[g].total === 0)
  let body: ReactNode
  if (work === null || (work.value === undefined && work.error === undefined))
    body = (
      <div role="status" className="pov-placeholder">
        Loading…
      </div>
    )
  else if (work.value === undefined)
    body = (
      <div role="alert" className="pov-note">
        Your work could not be loaded.
        <Button
          type="button"
          variant="ghost"
          className="h-control-sm text-sm"
          onClick={() => {
            P.overviewRetry('work')
            root.current?.focus()
          }}
        >
          Try again
        </Button>
      </div>
    )
  else if (work.value.state === 'over_budget')
    body = (
      <div className="pov-note">
        Qivo could not check all of your tasks in one request.{narrower(info)}
      </div>
    )
  else if (work.value.state === 'unavailable')
    body = (
      <div className="pov-note">{work.value.message ?? 'Qivo cannot show your work here.'}</div>
    )
  else if (empty)
    body = (
      <p className="pov-empty" data-ov-work-empty>
        Nothing of yours is in progress, waiting on your review or next.
      </p>
    )
  else
    body = WORK_GROUPS.map((g) =>
      answer ? (
        <WorkGroupList
          key={g}
          group={g}
          work={work}
          answer={answer}
          day={day}
          me={me}
          onOpen={onOpen}
        />
      ) : null,
    )
  const unknown = answer !== null && answer.counts.projected.state !== 'ok'
  return (
    <OvSection
      title={
        <>
          <Avatar id={P.CURRENT_USER} size={28} />
          Your work
        </>
      }
      action={
        <Button type="button" variant="quiet" className="mov-board" data-ov-board onClick={onBoard}>
          Open on the Board
          <Icon name="arrowRight" size={14} />
        </Button>
      }
    >
      {unknown && (
        <p className="pov-note" data-ov-unknown>
          Qivo could not work out every projected delay of your tasks, so a task marked Delay
          unknown may be late.
        </p>
      )}
      <div
        ref={root}
        tabIndex={-1}
        className={cn('outline-none', state === 'refreshing' && 'opacity-60')}
        data-ov-work
        data-ov-work-state={state}
        aria-busy={state === 'loading' || state === 'refreshing' || undefined}
      >
        {body}
      </div>
    </OvSection>
  )
}

/** The sentence's facts from Your work's answer. */
function sentenceFacts(work: WorkView): SentenceFacts {
  if (work === null || (work.value === undefined && work.error === undefined)) return 'loading'
  if (work.value === undefined) return 'error'
  if (work.value.state !== 'ok') return 'partial'
  const c = work.value.counts
  const projected = c.projected.state === 'ok' ? c.projected.count : null
  const behind = c.behind.state === 'ok' ? c.behind.count : null
  const any = c.overdue + c.blocked + c.no_reviewer + c.paused + (projected ?? 0) + (behind ?? 0)
  return {
    overdue: c.overdue,
    projected,
    blocked: c.blocked,
    clear: any > 0 ? false : projected === null || behind === null ? null : true,
  }
}

export function MyOverview({ info, actions }: { info: ScopeInfo; actions: OverviewActions }) {
  const mobile = useMobile()
  const { paneRef } = useOverviewPanelClipping(!mobile)
  const openIssue = useLatest((open: string) => actions.openIssue(open))
  const read = useOverviewRead(
    info,
    { sort: 'late', dir: 'desc', search: '', openOnly: true },
    null,
    'mine',
  )
  const ms = useScopeMilestones(info, OVERVIEW_MILESTONE_SLOTS)
  const milestonesRoot = useRef<HTMLDivElement>(null)
  // a milestone deleted from its window takes its row: focus goes to the
  // next row, the one before, Upcoming's empty line or the page's note
  const editMilestone = (id: string, project?: string) =>
    actions.editMilestone(
      id,
      focusAround(
        'data-overview-milestone',
        id,
        (row) => row,
        () =>
          milestonesRoot.current?.querySelector<HTMLElement>(
            '[data-milestone-section="upcoming"] [data-milestone-note="empty"]',
          ) ?? shownEmptyState(),
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
  const counts = shownOf(read.summary, (s) => s.counts)
  const anyTask = shownOf(read.summary, (s) => s.any_task)
  const c = given(counts)
  const tasksLeft = c
    ? c.leaves.backlog + c.leaves.todo + c.leaves.progress + c.leaves.review
    : null
  const day = read.request.base.clock.day

  // why My view has no task to summarize, once the answer that decides it
  // arrived: no project, no sub-project, or nothing of the person's; a
  // kept answer decides it while it refreshes, so the note stays through a
  // return or a reconnect
  const noTasks = given(anyTask)?.value === false
  const holds = useHolds((state === 'ok' || state === 'refreshing') && noTasks)
  let emptyNote: ReactNode = null
  if (holds === 'none')
    emptyNote = (
      <NoProjects
        icon="chart"
        title="Nothing to summarize yet"
        onNewProject={() => actions.newProject({ kind: 'program' })}
      />
    )
  else if (holds === 'no_sub')
    emptyNote = (
      <EmptyState
        icon="chart"
        title="Nothing to summarize yet"
        hint="Tasks live in sub-projects."
      />
    )
  else if ((state === 'ok' || state === 'refreshing') && noTasks)
    emptyNote = <EmptyState icon="user" title="Nothing assigned to you" />

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
            : 'Qivo cannot show this Overview here.'
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
        hint="Open a project or sub-project."
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
  // without a milestone the note is the page, as the note for a person who
  // sees no project is too
  const replaced = note ?? emptyNote
  const alone = replaced !== null && !ms.stands
  const busy = state === 'loading' || state === 'refreshing'

  const workAnswer = read.work?.value?.state === 'ok' ? read.work.value : null
  const late = workAnswer?.late_due ?? null
  const lateOf = new Map(
    late?.state === 'ok' ? late.projects.map((p) => [p.project_id, p.days]) : [],
  )
  const lineOf = (m: MilestoneVM, i: number, rows: readonly MilestoneVM[]) => {
    if (late === null) return null
    if (late.state !== 'ok') return LATE_UNKNOWN
    const days = lateOf.get(m.project)
    if (days === undefined) return null
    const before = rows
      .slice(0, i)
      .reverse()
      .find((r) => r.project === m.project)
    return lateLine(days, m, before ?? null, P.orgWeekStart(P.project(m.project)?.org ?? ''))
  }

  const status = (
    <OvSection title="Your status">
      <div className="mov-status-panel" data-ov-status>
        <Sentence facts={sentenceFacts(read.work)} tasksLeft={tasksLeft} />
        <div className="pov-facts" data-ov-facts>
          <Fact label="Tasks left" name="tasks-left" state={counts.state}>
            {tasksLeft ?? placeholder(counts)}
          </Fact>
          <Fact label="Hours left" name="hours-left" state={counts.state}>
            {c ? `${fmtHours(c.left_tenths / 10)}h` : placeholder(counts)}
          </Fact>
        </div>
        {counts.state === 'unavailable' && (
          <p className="pov-note" data-ov-counts-note>
            Qivo could not count your tasks in one request.{narrower(info)}
          </p>
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
      data-overview-page="mine"
      data-overview-state={state}
      {...(state === 'unavailable' && summaryAnswer?.state === 'unavailable' && summaryAnswer.reason
        ? { 'data-ov-reason': summaryAnswer.reason }
        : {})}
      aria-busy={busy || undefined}
      className={cn('overview-view pov mov [flex:1] [overflow:auto]', alone && 'flex flex-col')}
    >
      {alone ? (
        replaced
      ) : (
        <div className="pov-page">
          <div className="pov-cols">
            <div className="pov-col">
              {replaced ?? (
                <WorkPanel
                  info={info}
                  work={read.work}
                  day={day}
                  onOpen={openIssue}
                  onBoard={() => actions.setView('kanban')}
                />
              )}
            </div>
            <div className="pov-col">
              {replaced === null && status}
              <MilestonesPanel
                ms={ms}
                mine
                onNew={null}
                rootRef={milestonesRoot}
                lineOf={lineOf}
                onEdit={editMilestone}
              />
              {replaced === null && (
                <ProjectsPanel
                  title="Your projects"
                  noun="projects"
                  health={read.health}
                  orgOf={(row) => P.project(row.project_id)?.org ?? ''}
                  onOpen={(id) => {
                    actions.setScope(id)
                    actions.setView('kanban')
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
