/* The team opening, the walk's first step: the state of the team before
   anyone speaks. The Overview's facts over the walk's rows, the people near
   or over capacity, the milestones this week and next, and the two lists
   that ask for a person: work with no owner and reviews with no reviewer.
   Naming someone here stamps no one: it is not a change made on a person's
   page. Finished work is not listed: it belongs to each person's page,
   since each person's "since" differs. */
import type { ReactNode } from 'react'
import { AssigneeAvatar } from '@/components/AssigneeAvatar'
import { Avatar, Icon, IssueKey } from '@/components/qivo'
import { relativeWeek } from '@/lib/dates'
import {
  bannerVerdict,
  milestonesAhead,
  nearCapacity,
  needsOwner,
  needsReviewer,
  nextMilestone,
  openingFacts,
  type SyncDay,
  syncSentence,
  waitingLabel,
} from '@/lib/teamSync'
import { cn } from '@/lib/utils'
import { type IssueVM, P, type UserVM } from '@/store/planner'
import { LoadChip, type PageCtx, TitleButton, weekFigure, whereLabel } from './SyncCard'

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
  metaIds: Set<string>
  day: SyncDay
  now: number
  onOpenTask: (handle: string) => void
}) {
  const ctx = { onOpenTask }
  const facts = openingFacts(rows, {
    verdictOf: (it) => bannerVerdict(P.delayOf(it), P.tracksDelay(it)),
    issueById: P.issueById,
    today: day.today,
  })
  const next = nextMilestone(P.milestones, metaIds, day.todayWeek)
  const ahead = milestonesAhead(P.milestones, metaIds, day.todayWeek)
  const busy = nearCapacity(humans, weekFigure)
  const unowned = needsOwner(P.issues, subIds, day)
  const unreviewed = needsReviewer(rows, P.activity)
  return (
    <div data-sync-opening className="@container">
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
        <div className="min-w-0 [grid-column:span_2] max-[520px]:[grid-column:auto]">
          <div className="text-sm text-text-2">Next milestone</div>
          {next ? (
            <>
              <div className="truncate text-base font-semibold text-text-1">{next.name}</div>
              <div className="text-xs text-text-3">
                {P.project(next.project)?.name}, {P.weekLabel(next.week)}
              </div>
            </>
          ) : (
            <div className="text-base text-text-3">None scheduled</div>
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
          <div data-sync-milestones className="flex flex-col gap-1.5">
            {ahead.map((m) => {
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
                  <span className="truncate text-xs text-text-3">{P.project(m.project)?.name}</span>
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
            {!ahead.length && <Empty>No milestones this week or next</Empty>}
          </div>
        </div>

        <div className="min-w-0">
          <ListHeading title="Needs an owner" count={unowned.length} />
          {unowned.length ? (
            <div className="mb-6 overflow-hidden rounded-lg border border-border">
              {unowned.map((it) => {
                const urgent = it.priority === 'urgent'
                return (
                  <AskRow
                    key={it.uuid}
                    it={it}
                    ctx={ctx}
                    hook={{ 'data-sync-needs-owner': it.id }}
                    meta={
                      <>
                        <span className="truncate">{whereLabel(it)}</span>
                        {(urgent || it.priority === 'high') && (
                          <span className={urgent ? 'font-semibold text-danger' : 'text-text-2'}>
                            {P.PRIORITIES[it.priority].name}
                          </span>
                        )}
                        {it.due && <span className="!font-mono">due {P.fmtISO(it.due)}</span>}
                      </>
                    }
                    control={
                      <AssigneeAvatar issue={it} field="assignee" variant="label" backLayer />
                    }
                  />
                )
              })}
            </div>
          ) : (
            <div className="mb-6">
              <Empty>Every task that needs one has an owner</Empty>
            </div>
          )}

          <ListHeading title="Needs a reviewer" count={unreviewed.length} />
          {unreviewed.length ? (
            <div className="overflow-hidden rounded-lg border border-border">
              {unreviewed.map(({ issue: it, since }) => (
                <AskRow
                  key={it.uuid}
                  it={it}
                  ctx={ctx}
                  hook={{ 'data-sync-needs-reviewer': it.id }}
                  meta={
                    <>
                      <span className="truncate">{whereLabel(it)}</span>
                      {since != null && <span>{waitingLabel(since, now)}</span>}
                    </>
                  }
                  control={<AssigneeAvatar issue={it} field="reviewer" variant="label" backLayer />}
                />
              ))}
            </div>
          ) : (
            <Empty>Every review has a reviewer</Empty>
          )}
        </div>
      </div>
    </div>
  )
}
