/* Team sync: the page for the short, regular team meeting agile teams call a
   standup (docs/team-sync-brief.md; the Update Estimate walk, grown).
   A walk over one scope (all projects, a team's projects, or one project):
   the team opening first, then one page per person with three columns (Done
   since their last sync, On it, Next), then one collapsed page for the
   agents. Rows are the open leaf tasks each person OWNS inside the scope
   (convex/lib/review.ts: the reviewer while a task waits In Review with one,
   else the assignee); the rules live in src/lib/teamSync.ts.
   · Everything is live: rows re-derive from the store on every render, so a
     change made here or on anyone's screen moves rows between pages.
   · Every change made from a card (Remaining, status, pause, owner, a
     mention) stamps the page owner (P.syncStamp) and ticks the row. The tick
     alone stamps nothing, and naming someone from the team opening stamps
     no one.
   · Ticks are session-local, as in the Estimates walk; the one stored value
     is each person's last-sync stamp.
   · Where the page is (scope and step) lives in App and the URL; the page
     reports moves through `onPlace` and corrects a place it cannot show. */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Avatar, FieldSelect, Icon } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { flushWalkInput, useReviewed, WalkFooter, WalkRail } from '@/components/walk'
import {
  bannerVerdict,
  dayLabel,
  doneSince,
  parseSyncScope,
  personGroups,
  previousSync,
  resolveSyncScope,
  type ScopeWorld,
  type SyncDay,
  type SyncGroupId,
  type SyncScope,
  scopeMetaIds,
  scopeProjectIds,
  stampLabel,
  syncDay,
  syncRoster,
  syncRows,
  syncScopeKey,
  waitingOnReview,
} from '@/lib/teamSync'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { type IssueVM, P, type UserVM } from '@/store/planner'
import { usePlannerVersion } from '@/store/usePlannerVersion'
import { syncSince } from '../../convex/lib/teamSync'
import { DoneItem, LoadChip, type PageCtx, SyncCard, WaitingItem } from './teamSync/SyncCard'
import { TeamOpening } from './teamSync/TeamOpening'
import { useOverviewPanelClipping } from './useOverviewPanelClipping'
import './Overview.css'
import '../styles/mobile-views.css'

/** Where the page is: `scope` as `UIPrefs.syncScope` (`'all'`,
    `'team:<uuid>'`, `'project:<uuid>'`); `step` is `'team'`, `'agents'` or a
    person's profile uuid (an agent's opens the agents step with it open). */
export type SyncPlace = { scope: string; step: string }

/* The walk's scope choice, saved per user by App: all projects, each team of
   the home organization, each of its projects. */
function ScopeCtl({ scope, onPick }: { scope: SyncScope; onPick: (key: string) => void }) {
  const teams = P.teams
    .filter((t) => t.org === P.homeOrg)
    .sort((a, b) => a.name.localeCompare(b.name))
  const projects = P.visibleProjects().filter((p) => p.org === P.homeOrg)
  // a sub-project scope (a /sync/p/<n> link) is offered as itself
  const own = scope.kind === 'project' ? P.project(scope.id) : null
  if (own && !projects.some((p) => p.id === own.id)) projects.push(own)
  return (
    <span data-sync-scope className="inline-flex min-w-0">
      <FieldSelect
        aria-label="Sync scope"
        value={syncScopeKey(scope)}
        menuWidth={220}
        backLayer
        className="max-w-[260px] text-sm"
        options={[
          { value: 'all', label: 'All projects', icon: <Icon name="layers" size={14} /> },
          ...teams.map((t) => ({
            value: `team:${t.id}`,
            label: t.name,
            icon: <Icon name="people" size={14} />,
          })),
          ...projects.map((p) => ({ value: `project:${p.id}`, label: p.name })),
        ]}
        onChange={onPick}
      />
    </span>
  )
}

function SyncCol({
  id,
  title,
  count,
  className,
  bodyClassName,
  children,
}: {
  id: 'done' | 'onit' | 'next'
  title: string
  count: number
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <div
      data-sync-col={id}
      className={cn('flex min-w-0 flex-col rounded-lg border border-border', className)}
    >
      <h3 className="m-0 flex items-baseline gap-2 border-b border-border px-3 py-2 text-base font-semibold text-text-1">
        {title} <span className="text-sm font-normal text-text-3">{count}</span>
      </h3>
      <div className={cn('flex flex-col gap-2 p-2', bodyClassName)}>{children}</div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="col-span-full px-1 py-3 text-center text-sm text-text-3">{children}</div>
}

/** One person's three columns: Done since their reading point, On it (In
    Progress, In Review, then the quiet Waiting on review foot), Next (this
    week, then Later behind a toggle). The person page and each expanded
    agent draw the same. Laid out by the width it gets (a container query,
    so an agent's inset columns follow too): three columns from 820px; below
    that Done since becomes a band over On it and Next side by side, its
    items flowing in a grid; below 560px, and always on a phone, one column.
    A card's controls wrap to a second line rather than clip. */
function PersonColumns({
  person,
  ctx,
  rows,
  subIds,
  laterOpen,
  onToggleLater,
}: {
  person: UserVM
  ctx: PageCtx
  rows: IssueVM[]
  subIds: Set<string>
  laterOpen: boolean
  onToggleLater: () => void
}) {
  const groups = personGroups(person.id, rows, ctx.day)
  const group = (id: SyncGroupId) => groups.find((g) => g.id === id)?.rows ?? []
  const onIt = [...group('progress'), ...group('review')]
  const week = group('week')
  const later = group('later')
  const waiting = waitingOnReview(person.id, rows, P.activity)
  const done = doneSince(person.id, P.issues, subIds, ctx.since)
  const sinceLabel = dayLabel(ctx.since, ctx.now)
  return (
    <div className="@container">
      <div
        className={cn(
          'grid grid-cols-1 gap-3',
          !ctx.mobile &&
            '@min-[560px]:grid-cols-2 @min-[820px]:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.2fr)_minmax(0,1.2fr)]',
        )}
      >
        <SyncCol
          id="done"
          title={`Done since ${sinceLabel}`}
          count={done.length}
          className={cn(!ctx.mobile && '@min-[560px]:col-span-2 @min-[820px]:col-span-1')}
          bodyClassName={cn(
            !ctx.mobile &&
              '@min-[560px]:grid @min-[560px]:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] @min-[820px]:flex',
          )}
        >
          {done.map((d) => (
            <DoneItem key={d.issue.uuid} it={d.issue} kind={d.kind} ctx={ctx} />
          ))}
          {!done.length && <Empty>Nothing finished since {sinceLabel}</Empty>}
        </SyncCol>
        <SyncCol id="onit" title="On it" count={onIt.length}>
          {onIt.map((it) => (
            <SyncCard key={it.uuid} it={it} ctx={ctx} />
          ))}
          {!onIt.length && <Empty>Nothing under way</Empty>}
          {waiting.length > 0 && (
            <div data-sync-waiting-foot className="mt-1 flex flex-col gap-1.5">
              <div className="px-1 text-sm font-semibold text-text-2">
                Waiting on review <span className="font-normal text-text-3">{waiting.length}</span>
              </div>
              {waiting.map((w) => (
                <WaitingItem
                  key={w.issue.uuid}
                  it={w.issue}
                  reviewer={w.reviewer}
                  since={w.since}
                  ctx={ctx}
                />
              ))}
            </div>
          )}
        </SyncCol>
        <SyncCol id="next" title="Next" count={week.length + later.length}>
          {week.map((it) => (
            <SyncCard key={it.uuid} it={it} ctx={ctx} />
          ))}
          {!week.length && !later.length && <Empty>Nothing planned</Empty>}
          {later.length > 0 && (
            <Button
              type="button"
              variant="quiet"
              size="sm"
              data-sync-later={person.id}
              aria-expanded={laterOpen}
              onClick={onToggleLater}
              className="gap-1.5 self-start px-1.5 text-sm font-semibold"
            >
              <Icon name={laterOpen ? 'chevronDown' : 'chevronRight'} size={14} />
              Later <span className="font-normal text-text-3">{later.length}</span>
            </Button>
          )}
          {laterOpen && later.map((it) => <SyncCard key={it.uuid} it={it} ctx={ctx} later />)}
        </SyncCol>
      </div>
    </div>
  )
}

/* The way out to where re-planning happens: the Board and the Roadmap,
   filtered to the person. */
function PersonJumps({
  person,
  onShowPerson,
}: {
  person: UserVM
  onShowPerson: (view: 'kanban' | 'roadmap', profileId: string) => void
}) {
  const first = person.name.split(' ')[0]
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="default"
        size="icon-sm"
        data-sync-person-board={person.id}
        title={`${first}'s tasks on the Board`}
        aria-label={`${first}'s tasks on the Board`}
        onClick={() => onShowPerson('kanban', person.id)}
      >
        <Icon name="board" size={15} color="var(--text-2)" />
      </Button>
      <Button
        type="button"
        variant="default"
        size="icon-sm"
        data-sync-person-roadmap={person.id}
        title={`${first}'s tasks on the Roadmap`}
        aria-label={`${first}'s tasks on the Roadmap`}
        onClick={() => onShowPerson('roadmap', person.id)}
      >
        <Icon name="timeline" size={15} color="var(--text-2)" />
      </Button>
    </span>
  )
}

/* The agents' page: each agent collapsed to one line (hours this week, what
   they are on, and a Delayed / Slipping count so a late agent task is not
   missed), expanding to the same three columns. Their supervisor answers. */
function AgentsPage({
  agents,
  rows,
  subIds,
  ctxFor,
  open,
  onToggle,
  laterOpen,
  onToggleLater,
}: {
  agents: UserVM[]
  rows: IssueVM[]
  subIds: Set<string>
  ctxFor: (owner: UserVM) => PageCtx
  open: Set<string>
  onToggle: (id: string) => void
  laterOpen: Set<string>
  onToggleLater: (id: string) => void
}) {
  return (
    <div data-sync-agents className="flex flex-col gap-3">
      <h2 className="m-0 text-base font-semibold text-text-1">
        Agents <span className="text-sm font-normal text-text-3">{agents.length}</span>
      </h2>
      {agents.map((a) => {
        const ctx = ctxFor(a)
        const groups = personGroups(a.id, rows, ctx.day)
        const count = (ids: string[]) =>
          groups.filter((g) => ids.includes(g.id)).reduce((n, g) => n + g.rows.length, 0)
        const verdicts = rows
          .filter((it) => it.owner === a.id)
          .map((it) => bannerVerdict(P.delayOf(it), P.tracksDelay(it)))
        const delayed = verdicts.filter((v) => v === 'late').length
        const slipping = verdicts.filter((v) => v === 'behind').length
        const expanded = open.has(a.id)
        return (
          <section key={a.id} data-sync-agent={a.id} className="rounded-lg border border-border">
            <Button
              type="button"
              variant="unstyled"
              data-sync-agent-toggle={a.id}
              aria-expanded={expanded}
              onClick={() => onToggle(a.id)}
              className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-3 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
              <Avatar id={a.id} size={28} />
              <span className="text-base font-semibold text-text-1">{a.name}</span>
              <LoadChip user={a} />
              <span className="text-sm text-text-3">
                {count(['progress', 'review'])} on it, {count(['week', 'later'])} next
              </span>
              {delayed > 0 && (
                <span className="text-sm font-semibold text-danger">{delayed} Delayed</span>
              )}
              {slipping > 0 && (
                <span className="text-sm font-semibold text-warning">{slipping} Slipping</span>
              )}
            </Button>
            {expanded && (
              <div className="border-t border-border p-2">
                <PersonColumns
                  person={a}
                  ctx={ctx}
                  rows={rows}
                  subIds={subIds}
                  laterOpen={laterOpen.has(a.id)}
                  onToggleLater={() => onToggleLater(a.id)}
                />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/* A set with one id flipped, for the page's open/closed sections. */
function flipped(set: Set<string>, id: string): Set<string> {
  const n = new Set(set)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  return n
}

export function TeamSync({
  place,
  onPlace,
  onClose,
  onOpenTask,
  onShowTask,
  onShowPerson,
}: {
  place: SyncPlace
  /** App stores it, saves the scope when it changed, and REPLACES the URL */
  onPlace: (next: SyncPlace) => void
  /** Done on the last step: App returns to the scope and view underneath */
  onClose: () => void
  /** the task window over the page */
  onOpenTask: (handle: string) => void
  onShowTask: (view: 'kanban' | 'roadmap', handle: string) => void
  onShowPerson: (view: 'kanban' | 'roadmap', profileId: string) => void
}) {
  usePlannerVersion('teamSync')
  const mobile = useMobile()
  const { paneRef } = useOverviewPanelClipping(!mobile)
  // the page's scroller, which the clipping hook also measures
  const scroller = useRef<HTMLDivElement | null>(null)
  const setPane = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el
      paneRef(el)
    },
    [paneRef],
  )
  const reviewed = useReviewed()
  const [prompt, setPrompt] = useState<string | null>(null)
  const [openAgents, setOpenAgents] = useState(() => new Set<string>())
  const [laterOpen, setLaterOpen] = useState(() => new Set<string>())
  // the step last shown, its index and scope, for a person who leaves mid-sitting
  const shown = useRef<{ step: string; idx: number; scope: string } | null>(null)
  const onPlaceRef = useRef(onPlace)
  onPlaceRef.current = onPlace

  // the latest comment per open task: the one fact the snapshot lacks
  useEffect(() => {
    P.watchTeamSync(P.homeOrg || null)
    return () => P.watchTeamSync(null)
  }, [P.homeOrg])

  const now = Date.now()
  const day: SyncDay = syncDay(now)
  const world: ScopeWorld = {
    homeOrg: P.homeOrg,
    projects: P.projects,
    teams: P.teams,
    canSee: (id) => P.canSee(id),
  }
  const scope = resolveSyncScope(parseSyncScope(place.scope), world)
  const scopeKey = syncScopeKey(scope)
  const subIds = scopeProjectIds(scope, world)
  const rows = syncRows(P.issues, subIds)
  const { humans, agents } = syncRoster(rows, P.users, scope)
  const walkers = new Set([...humans, ...agents].map((u) => u.id))
  // the footer's total: every row on some page of the walk (the Waiting on
  // review foot and the Done column are not rows)
  const counted = rows.filter((it) => walkers.has(it.owner))
  const steps = ['team', ...humans.map((u) => u.id), ...(agents.length ? ['agents'] : [])]

  /* The step `place` asks for, as the walk can show it: an agent's id opens
     the agents step; the person just shown who has left the walk (their last
     row handed on) gives their place to the neighbour at the same index;
     anything else unknown, the phone's default own page included when the
     viewer owns nothing in scope, opens the team. So does a new scope the
     person has nothing in: its walk is another list, with no neighbour. */
  const want = place.step
  let step = 'team'
  if (steps.includes(want)) step = want
  else if (agents.some((u) => u.id === want)) step = 'agents'
  else if (shown.current?.step === want && shown.current.scope === scopeKey && want !== 'team')
    step = steps[Math.min(shown.current.idx, steps.length - 1)]
  const idx = steps.indexOf(step)

  useEffect(() => {
    shown.current = { step, idx, scope: scopeKey }
  })
  // each step opens at its top, header first (Next sits at the bottom of a
  // long page); instant, since the page never animates
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [step, scopeKey])
  // correct a place the walk cannot show, in place (App replaces the URL);
  // only once the store has loaded, or a deep link would fall back to the
  // team before the roster exists
  useEffect(() => {
    if (!P.loaded) return
    if (agents.some((u) => u.id === place.step)) setOpenAgents((s) => new Set(s).add(place.step))
    if (scopeKey !== place.scope || step !== place.step)
      onPlaceRef.current({ scope: scopeKey, step })
  }, [P.loaded, scopeKey, step, place.scope, place.step])

  const go = (next: string, nextScope = scopeKey) => {
    flushWalkInput('sync')
    setPrompt(null)
    onPlace({ scope: nextScope, step: next })
  }
  const pick = (id: string) => {
    if (agents.some((u) => u.id === id)) {
      setOpenAgents((s) => new Set(s).add(id))
      go('agents')
    } else go(id)
  }
  const close = () => {
    flushWalkInput('sync')
    onClose()
  }

  const ctxFor = (owner: UserVM): PageCtx => {
    // P.syncStamp sends nothing for a viewer who is not staff (the server's
    // rule), so a read-only visitor earns no refusal toasts
    const stamp = () => P.syncStamp(owner.id)
    return {
      owner: owner.id,
      since: syncSince(owner.sync ?? null, now, P.org.weekStart ?? 1),
      now,
      day,
      mobile,
      reviewed,
      stamp,
      touched: (it) => {
        stamp()
        reviewed.mark(it.uuid)
      },
      prompt,
      setPrompt,
      onOpenTask,
      onShowTask,
    }
  }

  const person = humans.find((u) => u.id === step) || null
  const allDone = (uid: string) => counted.every((it) => it.owner !== uid || reviewed.has(it.uuid))
  const today = new Date(now)
  const last = idx >= steps.length - 1

  let body: ReactNode
  if (person) {
    const ctx = ctxFor(person)
    const prev = previousSync(person.sync ?? null, now)
    body = (
      <>
        <div data-sync-person={person.id} className="mb-5 flex flex-wrap items-center gap-3">
          <Avatar id={person.id} size={40} />
          <div className="min-w-0">
            <div className="text-base font-semibold text-text-1">
              {person.name}
              <span className="ml-2 text-sm font-normal text-text-3">
                ({idx} of {humans.length})
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <LoadChip user={person} />
              {prev != null && (
                <span data-sync-last className="text-sm text-text-3">
                  {stampLabel(prev, now)}
                </span>
              )}
            </div>
          </div>
          <div className="flex-1" />
          <PersonJumps person={person} onShowPerson={onShowPerson} />
        </div>
        <PersonColumns
          person={person}
          ctx={ctx}
          rows={rows}
          subIds={subIds}
          laterOpen={laterOpen.has(person.id)}
          onToggleLater={() => setLaterOpen((s) => flipped(s, person.id))}
        />
      </>
    )
  } else if (step === 'agents') {
    body = (
      <AgentsPage
        agents={agents}
        rows={rows}
        subIds={subIds}
        ctxFor={ctxFor}
        open={openAgents}
        onToggle={(id) => setOpenAgents((s) => flipped(s, id))}
        laterOpen={laterOpen}
        onToggleLater={(id) => setLaterOpen((s) => flipped(s, id))}
      />
    )
  } else {
    body = (
      <TeamOpening
        rows={rows}
        humans={humans}
        subIds={subIds}
        metaIds={scopeMetaIds(scope, world)}
        day={day}
        now={now}
        onOpenTask={onOpenTask}
      />
    )
  }

  return (
    <div
      ref={setPane}
      data-sync-page
      data-scroll
      data-screen-label="Team sync"
      className="overview-view [flex:1] [overflow:auto]"
    >
      <div className="[padding:0_20px_40px] [max-width:var(--workspace-content-max)] [margin:0_auto] [display:flex] [flex-direction:column]">
        <section className="overview-section">
          <div className="overview-section-body">
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <ScopeCtl scope={scope} onPick={(key) => go(step, key)} />
              <span data-sync-today className="whitespace-nowrap text-sm text-text-3">
                {P.WEEKDAYS[today.getDay()].slice(0, 3)} {P.fmtDate(today)}
              </span>
              <div className="flex-1" />
              <WalkRail
                hook="sync"
                people={[...humans, ...agents]}
                gapAt={humans.length}
                isCurrent={(id) =>
                  id === step || (step === 'agents' && agents.some((u) => u.id === id))
                }
                allDone={allDone}
                onPick={pick}
                label={(name) => `Open ${name}'s page`}
                className={cn(
                  mobile &&
                    'w-full [flex-wrap:nowrap] [justify-content:flex-start] overflow-x-auto p-0.5',
                )}
                lead={
                  <Button
                    type="button"
                    variant="unstyled"
                    data-sync-jump="team"
                    onClick={() => go('team')}
                    title="Team"
                    aria-label="Team opening"
                    aria-current={step === 'team' ? 'true' : undefined}
                    className="mr-1 grid size-8 shrink-0 cursor-pointer place-items-center rounded-sm border-none bg-transparent p-0 aria-[current=true]:shadow-[0_0_0_2px_var(--primary)]"
                  >
                    <span className="grid size-7 place-items-center rounded-[5px] border border-border bg-surface-1">
                      <Icon name="people" size={15} color="var(--text-2)" />
                    </span>
                  </Button>
                }
              />
            </div>
            {body}
            <div className="mt-6 flex items-center gap-2 border-t border-border pt-4">
              <WalkFooter
                hook="sync"
                reviewed={reviewed.count(counted)}
                total={counted.length}
                showPrev
                atStart={idx <= 0}
                last={last}
                onPrev={() => go(steps[Math.max(0, idx - 1)])}
                onNext={() => (last ? close() : go(steps[idx + 1]))}
              />
            </div>
          </div>
          <div className="overview-section-foot" aria-hidden="true" />
        </section>
      </div>
    </div>
  )
}
