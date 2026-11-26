/* The components a project's Overview (ProjectOverview.tsx) and My view's
   (MyOverview.tsx) share, so one thing reads the same on both: the
   sentence and the top figures, a task's flag, Load more, a project's or
   sub-project's row and its panel, and the milestone panel. Their words
   and rules are overviewFacts.ts, their styles ProjectOverview.css. */

import { type ReactNode, useId, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { relativeWeek, weekLabel, weekToISO } from '@/lib/dates'
import { DELAY_LABELS } from '@/lib/delay'
import { useFocusWhenGone } from '@/lib/focusWhenGone'
import { type SentencePart, syncSentence } from '@/lib/teamSync'
import { cn } from '@/lib/utils'
import { fmtHours } from '@/lib/workload'
import type { HealthView } from '@/store/overviewLists'
import type { HealthRow } from '../../../convex/lib/overview'
import type { NeedsKind } from '../../../convex/lib/overviewNeeds'
import { MilestoneSectionPart } from '../../components/MilestoneSectionPart'
import { Avatar, Icon, ProjectName } from '../../components/qivo'
import { personLabel, useOrgPeople } from '../../components/usePeople'
import { type MilestoneVM, P } from '../../store/planner'
import type { ScopeMilestones } from '../useScopeMilestones'
import { OvSection } from './OvSection'
import { MINE_MILESTONES_HINT, MINE_TOO_MANY, plural, useHeldFocus } from './overviewFacts'

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

/** A kind's flag, beside the row's title. */
export function NeedFlag({ kind }: { kind: NeedsKind }) {
  return (
    <span className="pov-flag" data-kind={kind} aria-hidden="true">
      <Icon name={KIND_ICON[kind]} size={13} strokeWidth={2.4} />
    </span>
  )
}

/** The opening sentence of a scope, the one Team sync opens with: on its
    way, failed, past one request, all clear with how many tasks are left,
    or what is overdue, projected to miss and blocked. */
export type SentenceFacts =
  | 'loading'
  | 'error'
  | 'partial'
  | {
      overdue: number
      /** null where some projected delay is not known */
      projected: number | null
      blocked: number
      /** whether no task has any kind, null where that is not known */
      clear: boolean | null
    }

export function Sentence({ facts, tasksLeft }: { facts: SentenceFacts; tasksLeft: number | null }) {
  let body: ReactNode
  if (facts === 'loading') body = '…'
  else if (facts === 'error') body = 'Qivo could not check what needs attention here.'
  else if (facts === 'partial') body = 'Qivo could not check every task here in one request.'
  else if (facts.clear === true)
    body =
      tasksLeft === 0
        ? 'Nothing is left to do.'
        : tasksLeft === null
          ? 'Nothing needs attention.'
          : `Nothing needs attention. ${plural(tasksLeft, 'task')} ${tasksLeft === 1 ? 'is' : 'are'} left.`
  // the parts alternate text and a count, and each count's clause is its
  // own, so the clause that follows names it
  else
    body = syncSentence(facts).reduce<ReactNode[]>((out, part: SentencePart) => {
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
  return (
    <p data-ov-sentence className="pov-sentence" aria-busy={body === '…' || undefined}>
      {body}
    </p>
  )
}

export function Fact({
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

/** Load more of a list, which keeps keyboard focus while its rows load,
    and the line a failed one leaves with Retry. Where Load more leaves, at
    the end of the list or where its rows failed, focus it held goes to
    Retry, else to `root`. `more` is null for none. */
export function LoadMore({
  more,
  failed,
  what,
  root,
  onMore,
  onRetry,
  hook,
}: {
  more: 'ready' | 'loading' | null
  failed: boolean
  /** what failed to load, as "tasks" in "Couldn't load more tasks." */
  what: string
  root: () => HTMLElement | null
  onMore: () => void
  onRetry: () => void
  /** the data attribute names of the button and Retry */
  hook: { more: string; retry: string }
}) {
  const held = useHeldFocus()
  const retry = useRef<HTMLButtonElement>(null)
  useFocusWhenGone(more !== null, () => (held.held() ? (retry.current ?? root()) : null))
  return (
    <>
      {more !== null && (
        <Button
          type="button"
          variant="ghost"
          {...{ [hook.more]: '' }}
          {...held.props}
          aria-disabled={more === 'loading' || undefined}
          className={cn('pov-more', more === 'loading' && 'pointer-events-none italic')}
          onClick={() => {
            if (more === 'ready') onMore()
          }}
        >
          {more === 'loading' ? 'Loading…' : 'Load more'}
        </Button>
      )}
      {failed && (
        <div role="alert" className="pov-note">
          Couldn't load more {what}.
          <Button
            ref={retry}
            type="button"
            variant="ghost"
            {...{ [hook.retry]: '' }}
            className="h-control-sm text-sm"
            onClick={() => {
              onRetry()
              root()?.focus()
            }}
          >
            Retry
          </Button>
        </div>
      )}
    </>
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

function ProjectRow({
  row,
  org,
  onOpen,
}: {
  row: HealthRow
  /** the organization the row's lead is named in, '' while the page knows
      none */
  org: string
  onOpen: (id: string) => void
}) {
  const c = row.counts.state === 'ok' ? row.counts : null
  const left = c ? c.leaves.backlog + c.leaves.todo + c.leaves.progress + c.leaves.review : null
  const d = row.delays.state === 'ok' ? row.delays : null
  // a read in another organization answers the lead gone
  const [lead] = useOrgPeople(org, [org ? row.lead_id : null])
  const project = { id: row.project_id, name: P.project(row.project_id)?.name ?? row.name }
  const parts = [
    P.projectLabel(project),
    row.lead_id
      ? `${lead ? personLabel(lead, 'Unknown person') : 'Loading…'}, Lead`
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
          <Avatar id={row.lead_id} size={28} />
        </span>
        <span className="pov-sub-main">
          <span className="pov-sub-name">
            <ProjectName project={project} wrap />
          </span>
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

/** A health table's rows as a panel, a project's sub-projects or My
    view's projects (`noun`), each with its lead, tasks and hours left and
    its Late, Behind plan and Paused counts, in the server's order, with
    Load more. */
export function ProjectsPanel({
  title,
  noun,
  health,
  orgOf,
  onOpen,
}: {
  title: string
  noun: 'sub-projects' | 'projects'
  health: HealthView
  /** the organization a row's lead is named in, '' while the page knows
      none */
  orgOf: (row: HealthRow) => string
  onOpen: (id: string) => void
}) {
  const answer = health?.value?.state === 'ok' ? health.value : null
  // where the list stands, as its root's data-ov-subs-state names it
  const state =
    health === null || (health.value === undefined && health.error === undefined)
      ? 'loading'
      : health.value === undefined
        ? 'error'
        : health.value.state !== 'ok'
          ? health.value.state
          : health.current && !health.kept
            ? 'ok'
            : 'refreshing'
  const root = useRef<HTMLDivElement>(null)
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
        The {noun} could not be loaded.
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
    body = <div className="pov-note">Qivo could not list the {noun} in one request.</div>
  else if (answer.uncounted)
    body = (
      <div className="pov-note" data-ov-subs-uncounted={answer.uncounted}>
        {answer.uncounted === 'counting'
          ? `Qivo is counting the tasks here, so it cannot list the ${noun} yet.`
          : `Qivo could not count the tasks here in one request, so it cannot list the ${noun}.`}
      </div>
    )
  else
    body = (
      <>
        {answer.rows.length === 0 && noun === 'projects' ? (
          <p className="pov-empty">No project holds work of yours that is left.</p>
        ) : (
          <ul className="pov-list" data-ov-subs>
            {answer.rows.map((row) => (
              <ProjectRow key={row.project_id} row={row} org={orgOf(row)} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {answer.sort.by_name && (
          <p className="pov-note">
            {answer.sort.missing === 'counting'
              ? `Qivo is counting the tasks here, so the ${noun} are in name order.`
              : `Qivo could not work out every ${DELAY_LABELS.late} and ${DELAY_LABELS.behind} count, so the ${noun} are in name order.`}
          </p>
        )}
        {answer.rows.length >= answer.most && answer.total > answer.rows.length && (
          <p className="pov-note" data-ov-subs-cap>
            Qivo shows the first {answer.rows.length.toLocaleString('en-US')} of{' '}
            {answer.total.toLocaleString('en-US')} {noun}.
          </p>
        )}
        <LoadMore
          more={health.more}
          failed={health.moreFailed}
          what={noun}
          root={() => root.current}
          onMore={() => P.overviewMore('health')}
          onRetry={() => P.overviewRetry('health')}
          hook={{ more: 'data-ov-subs-more', retry: 'data-ov-subs-retry' }}
        />
      </>
    )
  return (
    <OvSection title={title}>
      <div
        ref={root}
        tabIndex={-1}
        data-ov-subs-state={state}
        aria-busy={state === 'loading' || state === 'refreshing' || undefined}
        className="outline-none"
      >
        {body}
      </div>
    </OvSection>
  )
}

function MilestoneRow({
  m,
  next,
  past = false,
  project,
  line,
  onEdit,
}: {
  m: MilestoneVM
  next: boolean
  past?: boolean
  /** the milestone's project, named where milestones of several projects
      are listed */
  project: string | null
  line: string | null
  onEdit: (id: string, project: string) => void
}) {
  return (
    <Button
      type="button"
      variant="unstyled"
      onClick={() => onEdit(m.id, m.project)}
      title={`Edit “${m.name}”${project ? `, ${project}` : ''}`}
      data-overview-milestone={m.id}
      data-next={next ? '' : undefined}
      data-past={past ? '' : undefined}
      className="pov-mile"
    >
      <span className="pov-diamond" aria-hidden="true" data-past={past ? '' : undefined} />
      <span className="pov-mile-main">
        <span className="pov-mile-name">{m.name}</span>
        {(project || line) && (
          <span className="pov-mile-line">
            {project && <span className="pov-mile-project">{project}</span>}
            {line && <span>{line}</span>}
          </span>
        )}
      </span>
      <span className="pov-mile-when">
        <b className="pov-mile-rel">{relativeWeek(m.week)}</b>
        <time dateTime={weekToISO(m.week)}>{weekLabel(m.week)}</time>
      </span>
    </Button>
  )
}

/**
 * The Milestones panel: Upcoming, the next milestone emphasised, each
 * upcoming row with the line `lineOf` gives it, then Past, collapsed
 * until the person opens it, with the + where `onNew` is given. In My view
 * (`mine`) each row names its project and the notes say what My view can
 * do where a read needs more than one request allows.
 */
export function MilestonesPanel({
  ms,
  mine,
  onNew,
  newRef,
  rootRef,
  lineOf,
  onEdit,
}: {
  ms: ScopeMilestones
  mine: boolean
  /** adds a milestone, where the person may */
  onNew: (() => void) | null
  newRef?: React.Ref<HTMLButtonElement>
  rootRef?: React.Ref<HTMLDivElement>
  /** the line under upcoming row `m`, the `i`th of `rows` */
  lineOf: (m: MilestoneVM, i: number, rows: readonly MilestoneVM[]) => string | null
  onEdit: (id: string, project: string) => void
}) {
  const pastBodyId = useId()
  const projectOf = (m: MilestoneVM) => (mine ? P.projectLabelOf(m.project) : null)
  const hint = mine ? MINE_MILESTONES_HINT : undefined
  const tooMany = mine ? MINE_TOO_MANY : undefined
  const upcomingRows = ms.upcoming.view.rows
  return (
    <OvSection
      title="Milestones"
      action={
        onNew ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-control-xs h-control-xs"
            aria-label="New milestone"
            title="New milestone"
            ref={newRef}
            onClick={onNew}
          >
            <Icon name="plus" size={16} />
          </Button>
        ) : null
      }
    >
      <div ref={rootRef} data-overview-milestones className="flex flex-col gap-1">
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
            noneYet: mine
              ? 'No milestones in any of your projects yet.'
              : onNew
                ? 'No milestones yet. Add one with the + button.'
                : 'No milestones yet.',
            tooMany,
          }}
          hint={hint}
        >
          {upcomingRows.map((m, i) => (
            <MilestoneRow
              key={m.id}
              m={m}
              next={m.id === ms.nextId}
              project={projectOf(m)}
              line={lineOf(m, i, upcomingRows)}
              onEdit={onEdit}
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
            sentences={{ tooMany }}
            hint={hint}
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
                    project={projectOf(m)}
                    line={null}
                    onEdit={onEdit}
                  />
                ))
              : []}
          </MilestoneSectionPart>
        )}
      </div>
    </OvSection>
  )
}
