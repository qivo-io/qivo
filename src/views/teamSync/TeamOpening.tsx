/* The team opening, the walk's first step: the state of the team before
   anyone speaks. The Overview's facts over the walk's rows, the people near
   or over capacity, the milestones this week and next, and the two lists
   that ask for a person: work with no owner and reviews with no reviewer.
   Naming someone here stamps no one: it is not a change made on a person's
   page. Finished work is not listed: it belongs to each person's page,
   since each person's "since" differs. The milestones come from the
   server's bounded reads over the scope's top-level projects
   (useSyncMilestoneReads); the rest still reads the workspace. */
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { DeferredList } from '@/components/DeferredList'
import { Avatar, Icon, IssueKey, ProjectNameOf } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { SYNC_LIMIT } from '@/lib/boardGroups'
import { relativeWeek, weekToISO } from '@/lib/dates'
import { limitSentence } from '@/lib/fieldLimits'
import { createMountScheduler, useMountGuards } from '@/lib/mountScheduler'
import {
  bannerVerdict,
  nearCapacity,
  needsOwner,
  needsReviewer,
  openingFacts,
  SYNC_MILESTONE_SLOTS,
  type SyncDay,
  syncMilestones,
  syncSentence,
  waitingLabel,
} from '@/lib/teamSync'
import { cn } from '@/lib/utils'
import { useViewVisibility } from '@/lib/viewVisibility'
import { type IssueVM, type MilestoneVM, P, type UserVM } from '@/store/planner'
import type { StoreVersion } from '@/store/updates'
import { LIMITS } from '../../../convex/lib/limits'
import { useViewsNews } from '../useViewsNews'
import { LoadChip, type PageCtx, TitleButton } from './SyncCard'
import { weekFigure } from './weekFigure'

function Fact({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'danger' | 'warning'
}) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-text-2">{label}</div>
      <div
        className={cn(
          '!font-mono text-2xl leading-tight text-text-1',
          value > 0 && tone === 'danger' && 'text-danger',
          value > 0 && tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ListHeading({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="m-0 mb-2 text-sm font-semibold text-text-1">
      {title} {count != null && <span className="font-normal text-text-3">{count}</span>}
    </h3>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-text-3">{children}</div>
}

/* A task that asks for a person: key and title, where it lives and why it is
   listed, and the control that names someone. */
function AskRow({
  it,
  hook,
  meta,
  control,
  ctx,
}: {
  it: IssueVM
  hook: Record<string, string>
  meta: ReactNode
  control: ReactNode
  ctx: Pick<PageCtx, 'onOpenTask'>
}) {
  return (
    <div
      {...hook}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border p-2 first:border-t-0"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0">
            <IssueKey id={it.key} />
          </span>
          <TitleButton it={it} ctx={ctx} className="truncate text-base" />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-3">{meta}</div>
      </div>
      {control}
    </div>
  )
}

/* The two lists can hold a large share of the organization's tasks, and the
   opening renders again on each store change. A row renders the same while
   its task keeps its object (P.issues), with the same context
   (P.contextVersion) and label, so it skips. TeamSync keeps onOpenTask. */

/** A "Needs an owner" row. */
const OwnerAsk = memo(function OwnerAsk({
  it,
  onOpenTask,
}: {
  it: IssueVM
  onOpenTask: (handle: string) => void
  context: StoreVersion
}) {
  const urgent = it.priority === 'urgent'
  return (
    <AskRow
      it={it}
      ctx={{ onOpenTask }}
      hook={{ 'data-sync-needs-owner': it.id }}
      meta={
        <>
          <span className="truncate">
            <ProjectNameOf id={it.project} withOwner />
          </span>
          {(urgent || it.priority === 'high') && (
            <span className={urgent ? 'font-semibold text-danger' : 'text-text-2'}>
              {P.PRIORITIES[it.priority].name}
            </span>
          )}
          {it.due && <span className="!font-mono">due {P.fmtISO(it.due)}</span>}
        </>
      }
      control={<AssigneeAvatar issue={it} field="assignee" variant="label" backLayer />}
    />
  )
})

/** A "Needs a reviewer" row; `waiting` is its age, or null when unknown. */
const ReviewerAsk = memo(function ReviewerAsk({
  it,
  waiting,
  onOpenTask,
}: {
  it: IssueVM
  waiting: string | null
  onOpenTask: (handle: string) => void
  context: StoreVersion
}) {
  return (
    <AskRow
      it={it}
      ctx={{ onOpenTask }}
      hook={{ 'data-sync-needs-reviewer': it.id }}
      meta={
        <>
          <span className="truncate">
            <ProjectNameOf id={it.project} withOwner />
          </span>
          {waiting != null && <span>{waiting}</span>}
        </>
      }
      control={<AssigneeAvatar issue={it} field="reviewer" variant="label" backLayer />}
    />
  )
})

/* An ask row's height before it renders, and the least it takes, for the
   rows a first screen holds. */
const ASK_ESTIMATE_PX = 61
const ASK_MIN_PX = 48
const askKey = (it: IssueVM) => it.uuid
const askEstimate = () => ASK_ESTIMATE_PX
const pendingAsks = (n: number) => `Loading ${n} more ${n === 1 ? 'task' : 'tasks'}`
/* A long list mounts in blocks (DeferredList.css); the rows keep their
   rule where a block follows a block or a row. */
const ASK_LIST =
  'overflow-hidden rounded-lg border border-border [&>*+.deferred-block>*:first-child]:border-t'

/* How many openings mounted, each one's milestone read owner
   (P.watchMilestones). */
let syncReaders = 0

/* What Team sync offers for a scope of more top-level projects than one
   milestone read names, after the limit's own sentence: its Scope menu
   picks a team or a project. */
const TOO_MANY_HINT = 'Pick a team or a project with fewer top-level projects.'

/** The opening's two milestone reads, which it registers with the store
    while it and the tab show: its next milestone, the first row of the
    upcoming section of the scope's top-level projects `metaIds` from this
    week on (milestones.section), and the milestones of this week and next
    (milestones.between, from this week's first day in the app's week grid
    to the first day two weeks later), with Retry. A scope with no
    top-level project asks nothing, and one of more than the store's cap
    (MILESTONE_READS.projects) answers too_many without a read. Leaving
    the opening, as for a person's page, stops them and keeps their
    answers, which show as refreshing on return; App releases them once
    the page is no longer kept. A new week asks anew. Renders again on the
    store's `views` news. */
function useSyncMilestoneReads(metaIds: Set<string>, todayWeek: number, owner: number) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  useViewsNews()
  const projects = [...metaIds].sort()
  const scope = projects.join()
  const from = weekToISO(todayWeek)
  const to = weekToISO(todayWeek + 2)
  const empty = projects.length === 0
  useEffect(() => {
    if (empty) return
    const ask = visible
    const list = scope.split(',')
    P.watchMilestones(
      SYNC_MILESTONE_SLOTS.next,
      ask ? { kind: 'section', projects: list, from, side: 'upcoming', limit: 1 } : null,
      owner,
      attempt,
    )
    P.watchMilestones(
      SYNC_MILESTONE_SLOTS.ahead,
      ask ? { kind: 'between', projects: list, from, to } : null,
      owner,
      attempt,
    )
    return () => {
      P.watchMilestones(SYNC_MILESTONE_SLOTS.next, null, owner, attempt)
      P.watchMilestones(SYNC_MILESTONE_SLOTS.ahead, null, owner, attempt)
    }
  }, [empty, visible, scope, from, to, owner, attempt])
  // with no top-level project in scope the answer is known: none
  const shown = empty
    ? syncMilestones<MilestoneVM>(
        { state: 'ok', current: true, answer: { rows: [], next: null, stopped: null } },
        { state: 'ok', current: true, answer: { rows: [], next: null, stopped: null } },
      )
    : syncMilestones<MilestoneVM>(
        P.milestoneRead(SYNC_MILESTONE_SLOTS.next),
        P.milestoneRead(SYNC_MILESTONE_SLOTS.ahead),
      )
  return { ...shown, retry: () => setAttempt((n) => n + 1) }
}

/** The muted "unknown" the strip shows for a fact Qivo could not read
    whole, with what it means on hover. */
function Unknown({ why }: { why: string }) {
  return (
    <HoverTooltip content={why}>
      <div data-sync-fact="unknown" className="w-fit text-base text-text-3">
        unknown
      </div>
    </HoverTooltip>
  )
}

export function TeamOpening({
  rows,
  humans,
  subIds,
  metaIds,
  day,
  now,
  onOpenTask,
}: {
  /** the walk's rows: open leaf tasks in scope */
  rows: IssueVM[]
  /** the people in the walk */
  humans: UserVM[]
  subIds: Set<string>
  /** the scope's top-level projects, whose milestones the opening reads */
  metaIds: Set<string>
  day: SyncDay
  now: number
  onOpenTask: (handle: string) => void
}) {
  const facts = openingFacts(rows, {
    verdictOf: (it) => bannerVerdict(P.delayOf(it), P.tracksDelay(it)),
    issueById: P.issueById,
    today: day.today,
  })
  // this mounted opening, which owns the milestone reads while it asks
  const [owner] = useState(() => ++syncReaders)
  const milestones = useSyncMilestoneReads(metaIds, day.todayWeek, owner)
  const next = milestones.next.kind === 'milestone' ? milestones.next.milestone : null
  const ahead = milestones.ahead
  const busy = nearCapacity(humans, weekFigure)
  const unowned = needsOwner(P.issues, subIds, day)
  const unreviewed = needsReviewer(rows).map((ask) => ask.issue)
  /* Lists of more than SYNC_LIMIT asks mount the rows of the first screen
     at once and the rest in slices, in the page's scrolling pane. */
  const opening = useRef<HTMLDivElement>(null)
  const [scheduler] = useState(createMountScheduler)
  useMountGuards(scheduler)
  // the page's pane outlives the opening, so the marks go with the opening
  useLayoutEffect(() => {
    scheduler.setRoot(opening.current?.closest<HTMLElement>('[data-scroll]') ?? null)
    return () => scheduler.setRoot(null)
  }, [scheduler])
  const [firstScreen] = useState(() => Math.ceil((window.innerHeight + 500) / ASK_MIN_PX))
  const initialOf = (count: number) =>
    count <= SYNC_LIMIT ? Number.POSITIVE_INFINITY : firstScreen
  const ownerRow = (it: IssueVM) => (
    <OwnerAsk key={it.uuid} it={it} onOpenTask={onOpenTask} context={P.contextVersion} />
  )
  const reviewerRow = (it: IssueVM) => (
    <ReviewerAsk
      key={it.uuid}
      it={it}
      waiting={it.reviewAt != null ? waitingLabel(it.reviewAt, now) : null}
      onOpenTask={onOpenTask}
      context={P.contextVersion}
    />
  )
  return (
    <div ref={opening} data-sync-opening className="@container">
      <p data-sync-sentence className="m-0 mb-5 max-w-[64ch] text-md text-text-1">
        {syncSentence(facts).map((part, i) =>
          typeof part === 'string' ? (
            part
          ) : (
            <b
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never reorder
              key={i}
              className={cn(
                '!font-mono font-semibold',
                part.tone === 'danger' ? 'text-danger' : 'text-warning',
              )}
            >
              {part.n}
            </b>
          ),
        )}
      </p>

      <div
        data-sync-facts
        className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-x-6 gap-y-3 rounded-lg border border-border p-4"
      >
        <Fact label="Overdue" value={facts.overdue} tone="danger" />
        <Fact label="Projected to miss" value={facts.projected} tone="danger" />
        <Fact label="Slipping" value={facts.slipping} tone="warning" />
        <Fact label="Blocked" value={facts.blocked} />
        <Fact label="Paused" value={facts.paused} />
        <div
          data-sync-next-milestone={milestones.next.kind}
          className="min-w-0 [grid-column:span_2] max-[520px]:[grid-column:auto]"
        >
          <div className="text-sm text-text-2">Next milestone</div>
          {next ? (
            <>
              <div className="truncate text-base font-semibold text-text-1">{next.name}</div>
              <div className="text-xs text-text-3">
                {P.projectLabelOf(next.project)}, {P.weekLabel(next.week)}
              </div>
            </>
          ) : milestones.next.kind === 'none' ? (
            <div className="text-base text-text-3">None scheduled</div>
          ) : milestones.next.kind === 'loading' ? (
            <div className="text-base text-text-3">
              <span aria-hidden="true">…</span>
              <span className="sr-only">Loading the next milestone</span>
            </div>
          ) : (
            <Unknown why="Qivo could not read every milestone of these projects." />
          )}
        </div>
      </div>

      {/* two columns once each list has room for a row and its control */}
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 @min-[720px]:grid-cols-2">
        <div className="min-w-0">
          <ListHeading title="Near or over capacity" count={busy.length} />
          <div data-sync-capacity className="flex flex-col gap-1.5">
            {busy.map(({ user }) => (
              <div key={user.id} className="flex min-w-0 items-center gap-2">
                <Avatar id={user.id} size={20} />
                <span className="min-w-0 flex-1 truncate text-sm text-text-1">{user.name}</span>
                <LoadChip user={user} />
              </div>
            ))}
            {!busy.length && <Empty>Everyone is under 90% this week</Empty>}
          </div>

          <div className="mt-6">
            <ListHeading title="Milestones" />
          </div>
          <div
            data-sync-milestones
            aria-busy={ahead.refreshing || undefined}
            className="flex flex-col gap-1.5"
          >
            {ahead.rows.map((m) => {
              const lead = m.id === next?.id
              return (
                <div key={m.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <Icon
                    name="diamond"
                    size={12}
                    color={lead ? 'var(--primary)' : 'var(--text-3)'}
                    strokeWidth={2}
                  />
                  <span className={cn('min-w-0 truncate text-text-1', lead && 'font-semibold')}>
                    {m.name}
                  </span>
                  <span className="truncate text-xs text-text-3">
                    <ProjectNameOf id={m.project} />
                  </span>
                  <span className="flex-1" />
                  <span
                    className={cn(
                      'whitespace-nowrap text-xs',
                      lead ? 'text-text-1' : 'text-text-3',
                    )}
                  >
                    {relativeWeek(m.week)}
                  </span>
                  <span className="whitespace-nowrap !font-mono text-xs text-text-3">
                    {P.weekLabel(m.week)}
                  </span>
                </div>
              )
            })}
            {ahead.note === 'empty' && <Empty>No milestones this week or next</Empty>}
            {ahead.note === 'loading' && <Empty>Loading milestones…</Empty>}
            {ahead.note && ahead.note !== 'empty' && ahead.note !== 'loading' && (
              <div
                data-sync-milestones-note={ahead.note}
                className="flex flex-wrap items-center gap-x-2 text-sm text-text-3"
              >
                {ahead.note === 'partial'
                  ? 'Some milestones of this week and next may be missing.'
                  : ahead.note === 'failed'
                    ? "Couldn't load milestones."
                    : ahead.note === 'too_many'
                      ? `${limitSentence(LIMITS.milestoneProjects)} ${TOO_MANY_HINT}`
                      : ahead.sentence}
                {ahead.note === 'failed' && (
                  <Button type="button" variant="ghost" size="sm" onClick={milestones.retry}>
                    Retry
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <ListHeading title="Needs an owner" count={unowned.length} />
          {unowned.length ? (
            <div className={cn('mb-6', ASK_LIST)}>
              <DeferredList
                id="sync-needs-owner"
                items={unowned}
                keyOf={askKey}
                render={ownerRow}
                estimate={askEstimate}
                gap={0}
                initial={initialOf(unowned.length)}
                scheduler={scheduler}
                label={pendingAsks}
              />
            </div>
          ) : (
            <div className="mb-6">
              <Empty>Every task that needs one has an owner</Empty>
            </div>
          )}

          <ListHeading title="Needs a reviewer" count={unreviewed.length} />
          {unreviewed.length ? (
            <div className={ASK_LIST}>
              <DeferredList
                id="sync-needs-reviewer"
                items={unreviewed}
                keyOf={askKey}
                render={reviewerRow}
                estimate={askEstimate}
                gap={0}
                initial={initialOf(unreviewed.length)}
                scheduler={scheduler}
                label={pendingAsks}
              />
            </div>
          ) : (
            <Empty>Every review has a reviewer</Empty>
          )}
        </div>
      </div>
    </div>
  )
}
