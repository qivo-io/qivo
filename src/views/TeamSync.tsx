/* Team sync: the page for the short, regular team meeting agile teams call a
   standup (deviation #316; the Update Estimate walk, grown).
   A walk over one scope (all projects, a team's projects, or one project):
   the team opening first, then one page per person with three columns (Done
   since their last sync, On it, Next), then one collapsed page for the
   agents. Rows are the open leaf tasks each person OWNS inside the scope
   (convex/lib/review.ts: the reviewer while a task waits In Review with one,
   else the assignee); the rules live in src/lib/teamSync.ts.
   · The meeting is the server's agenda for the scope (convex/teamSync.ts
     agenda, views/teamSync/useSyncMeeting.ts): its tasks, its people with
     their stamps and weeks, each row's blockers and verdict. The page never
     reads the workspace's task lists, so it opens without every task and
     asks for none. It is live: a change made here or on anyone's screen
     reruns the agenda, and the person's own pending writes move rows
     between sections at once.
   · A scope comes from a pick or an address only. With none, or one the
     server cannot honour, the page asks to choose, never All projects. A
     meeting past its limits says so in place of the meeting, and one that
     stops fitting while it is open stays as it last fitted, marked as no
     longer updating, so its cards keep their unsent text. One some of whose
     tasks have not reached the page shows without its counts, and STALL.ms
     later under a note that says so.
   · Every change made from a card (Remaining, status, pause, owner, a
     mention) stamps the page owner (P.syncStamp) and ticks the row. The tick
     alone stamps nothing, and naming someone from the team opening stamps
     no one.
   · Ticks are session-local; the one stored value is each person's
     last-sync stamp.
   · Where the page is (scope and step) lives in App and the URL; the page
     reports moves through `onPlace` and corrects a step it cannot show once
     its meeting has answered. It never corrects a scope. */
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NoProjects } from '@/components/NoProjects'
import { openResolved } from '@/components/projectNavRows'
import { Avatar, Icon } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { useHolds } from '@/components/useHolds'
import { usePeople } from '@/components/usePeople'
import { WalkFooter, WalkRail } from '@/components/walk'
import { flushWalkInput, useReviewed } from '@/components/walkRows'
import type { UnsentScope } from '@/lib/leaveGuard'
import { syncNoProjectsHint } from '@/lib/noProjects'
import {
  dayLabel,
  doneSince,
  parseSyncScope,
  personGroups,
  previousSync,
  type SyncCardPlace,
  type SyncDay,
  type SyncGroupId,
  type SyncLoad,
  type SyncPerson,
  type SyncVerdict,
  stampLabel,
  syncDay,
  waitingOnReview,
} from '@/lib/teamSync'
import { useLatest } from '@/lib/useLatest'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { useViewVisibility } from '@/lib/viewVisibility'
import { type IssueVM, P } from '@/store/planner'
import { usePlannerVersion } from '@/store/usePlannerVersion'
import { DoneItem, LoadChip, type PageCtx, SyncCard, WaitingItem } from './teamSync/SyncCard'
import { IncompleteNote, StaleNote, SyncNote } from './teamSync/SyncNote'
import { SyncScopeMenu } from './teamSync/SyncScopeMenu'
import { TeamOpening } from './teamSync/TeamOpening'
import {
  type SyncMeeting,
  stoppedTitle,
  useSyncFigures,
  useSyncMeeting,
} from './teamSync/useSyncMeeting'
import { useOverviewPanelClipping } from './useOverviewPanelClipping'
import './Overview.css'
import '../styles/mobile-views.css'

/** Where the page is: `scope` as `UIPrefs.teamSyncScope` (`'all'`,
    `'team:<uuid>'`, `'project:<uuid>'`), `'unresolved:<segment>'` for an
    address's project the app cannot resolve, or `''` for none; `step` is
    `'team'`, `'agents'` or a person's profile uuid (an agent's opens the
    agents step with it open). */
export type SyncPlace = { scope: string; step: string }

/** What a person's page and the agents' lines read besides the meeting:
    the week and the verdicts of the people on screen (useSyncFigures). */
type Figures = {
  verdict: (uuid: string) => SyncVerdict
  load: (person: SyncPerson) => SyncLoad
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
  /** the column's count, or null, "…", while some task the meeting names
      has not reached the page */
  count: number | null
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
        {title} <span className="text-sm font-normal text-text-3">{count ?? '…'}</span>
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
    week, then Later behind a toggle), over the meeting's tasks. The person
    page and each expanded agent draw the same. Laid out by the width it
    gets (a container query, so an agent's inset columns follow too): three
    columns from 820px; below that Done since becomes a band over On it and
    Next side by side, its items flowing in a grid; below 560px, and always
    on a phone, one column. A card's controls wrap to a second line rather
    than clip. */
function PersonColumns({
  person,
  ctx,
  meeting,
  figures,
  laterOpen,
  onToggleLater,
}: {
  person: SyncPerson
  ctx: PageCtx
  meeting: SyncMeeting
  figures: Figures
  laterOpen: boolean
  onToggleLater: () => void
}) {
  /* A card with what its memo compares (SyncCard). */
  const card = (it: IssueVM, later?: boolean) => (
    <SyncCard
      key={it.uuid}
      it={it}
      ctx={ctx}
      later={later}
      verdict={figures.verdict(it.uuid)}
      blockedBy={meeting.blockedBy(it.uuid)}
      context={P.contextVersion}
      lastComment={P.lastComments.get(it.uuid)}
      reviewed={ctx.reviewed.has(it.uuid)}
    />
  )
  const groups = personGroups(person.id, meeting.rows, ctx.day)
  const group = (id: SyncGroupId) => groups.find((g) => g.id === id)?.rows ?? []
  const onIt = [...group('progress'), ...group('review')]
  const week = group('week')
  const later = group('later')
  const waiting = waitingOnReview(person.id, meeting.rows)
  const done = doneSince(person.id, meeting.tasks, meeting.subIds, ctx.since)
  const sinceLabel = dayLabel(ctx.since, ctx.now)
  // the counts wait while some task the meeting names has not arrived
  const count = (n: number) => (meeting.counted ? n : null)
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
          count={count(done.length)}
          className={cn(!ctx.mobile && '@min-[560px]:col-span-2 @min-[820px]:col-span-1')}
          bodyClassName={cn(
            !ctx.mobile &&
              '@min-[560px]:grid @min-[560px]:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] @min-[820px]:flex',
          )}
        >
          {done.map((d) => (
            <DoneItem
              key={d.issue.uuid}
              it={d.issue}
              kind={d.kind}
              context={P.contextVersion}
              ctx={ctx}
            />
          ))}
          {!done.length && <Empty>Nothing finished since {sinceLabel}</Empty>}
        </SyncCol>
        <SyncCol id="onit" title="On it" count={count(onIt.length)}>
          {onIt.map((it) => card(it))}
          {!onIt.length && <Empty>Nothing under way</Empty>}
          {waiting.length > 0 && (
            <div data-sync-waiting-foot className="mt-1 flex flex-col gap-1.5">
              <div className="px-1 text-sm font-semibold text-text-2">
                Waiting on review{' '}
                <span className="font-normal text-text-3">{count(waiting.length) ?? '…'}</span>
              </div>
              {waiting.map((w) => (
                <WaitingItem
                  key={w.issue.uuid}
                  it={w.issue}
                  reviewer={w.reviewer}
                  since={w.since}
                  context={P.contextVersion}
                  ctx={ctx}
                />
              ))}
            </div>
          )}
        </SyncCol>
        <SyncCol id="next" title="Next" count={count(week.length + later.length)}>
          {week.map((it) => card(it))}
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
              Later <span className="font-normal text-text-3">{count(later.length) ?? '…'}</span>
            </Button>
          )}
          {laterOpen && later.map((it) => card(it, true))}
        </SyncCol>
      </div>
    </div>
  )
}

/* The way out to where re-planning happens: the Board and the Roadmap,
   filtered to the person, on the sync's project, or, over all projects or
   a team, with no project chosen, where the project chooser says whose
   tasks a pick will show. The jump passes the person's first name for that
   line, as the agenda names them. */
function PersonJumps({
  person,
  onShowPerson,
}: {
  person: SyncPerson
  onShowPerson: (view: 'kanban' | 'roadmap', profileId: string, first: string) => void
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
        onClick={() => onShowPerson('kanban', person.id, first)}
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
        onClick={() => onShowPerson('roadmap', person.id, first)}
      >
        <Icon name="timeline" size={15} color="var(--text-2)" />
      </Button>
    </span>
  )
}

/* The agents' page: each agent collapsed to one line (hours this week, what
   they are on, and a Delayed / Slipping count so a late agent task is not
   missed, or "Delays unknown" where the agenda could not judge one of
   their rows), expanding to the same three columns. Their supervisor
   answers. */
function AgentsPage({
  agents,
  meeting,
  figures,
  ctxFor,
  open,
  onToggle,
  laterOpen,
  onToggleLater,
}: {
  agents: SyncPerson[]
  meeting: SyncMeeting
  figures: Figures
  ctxFor: (owner: SyncPerson) => PageCtx
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
        const groups = personGroups(a.id, meeting.rows, ctx.day)
        const count = (ids: string[]) =>
          groups.filter((g) => ids.includes(g.id)).reduce((n, g) => n + g.rows.length, 0)
        const verdicts = meeting.rows
          .filter((it) => it.owner === a.id)
          .map((it) => figures.verdict(it.uuid))
        const unknown = verdicts.includes('unknown')
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
              <LoadChip load={figures.load(a)} />
              <span className="text-sm text-text-3">
                {meeting.counted
                  ? `${count(['progress', 'review'])} on it, ${count(['week', 'later'])} next`
                  : '…'}
              </span>
              {!meeting.counted ? null : unknown ? (
                <span data-sync-agent-delays="unknown" className="text-sm text-text-3">
                  Delays unknown
                </span>
              ) : (
                <>
                  {delayed > 0 && (
                    <span className="text-sm font-semibold text-danger">{delayed} Delayed</span>
                  )}
                  {slipping > 0 && (
                    <span className="text-sm font-semibold text-warning">{slipping} Slipping</span>
                  )}
                </>
              )}
            </Button>
            {expanded && (
              <div className="border-t border-border p-2">
                <PersonColumns
                  person={a}
                  ctx={ctx}
                  meeting={meeting}
                  figures={figures}
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

/** The notice for cards without a since-last-sync mark, because the
    latest-comment read of `names` came back cut short. It names no cause,
    as a read is cut short for more than one reason (convex/teamSync.ts
    lastComments). */
const marksCutLine = (names: string[]) => {
  const own = names.map((name) => `${name}'s`)
  const whose =
    own.length === 1 ? own[0] : `${own.slice(0, -1).join(', ')} and ${own.at(-1) as string}`
  return `Some cards show no mark for what changed since the last sync, because Qivo could not check all of ${whose} open tasks at once.`
}

export function TeamSync({
  place,
  onPlace,
  onCorrect = onPlace,
  onClose,
  onOpenTask: openTask,
  onShowTask: showTask,
  onShowPerson,
  onShowBoard,
}: {
  place: SyncPlace
  /** App stores it, saves a new scope as the person's pick, and REPLACES
      the URL; it asks first while the step holds unsent text, or while
      `closes`, the windows the move takes away, holds some */
  onPlace: (next: SyncPlace, closes?: UnsentScope[]) => void
  /** as onPlace, without asking or saving, for a step the walk cannot show */
  onCorrect?: (next: SyncPlace) => void
  /** Done on the last step: App returns to the scope and view underneath */
  onClose: () => void
  /** the task window over the page, by what opening a task passes on
      (P.openTarget), so a task only the agenda brings opens too */
  onOpenTask: (target: string) => void
  onShowTask: (view: 'kanban' | 'roadmap', handle: string) => void
  /** a person's Board or Roadmap jump, with their first name */
  onShowPerson: (view: 'kanban' | 'roadmap', profileId: string, first: string) => void
  /** a sub-project's Board, for one past Team sync's limits */
  onShowBoard: (projectId: string) => void
}) {
  usePlannerVersion('teamSync')
  // App makes these again every render; the memoized rows keep one identity
  const onOpenTask = useLatest((handle: string) => openTask(P.openTarget(handle)))
  const onShowTask = useLatest(showTask)
  const mobile = useMobile()
  const { visible } = useViewVisibility()
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
  // the scope of each card on the page, with its task and section's person
  // (PageCtx.cards)
  const [cards] = useState(() => new Map<UnsentScope, SyncCardPlace>())
  // the step last shown, its index and scope, for a person who leaves mid-sitting
  const shown = useRef<{ step: string; idx: number; scope: string } | null>(null)
  const onCorrectRef = useRef(onCorrect)
  onCorrectRef.current = onCorrect

  // oxlint-disable-next-line react/purity -- Team sync shows today, read from the clock at each render
  const now = Date.now()
  const day: SyncDay = syncDay(now)
  const scopeKey = place.scope
  const scope = parseSyncScope(scopeKey)
  const meeting = useSyncMeeting(scopeKey, now)
  // whether the person sees no project of the home organization, which the
  // server confirms (projectNav.holds) while no meeting shows
  const noProject = useHolds(!meeting.shows, P.homeOrg) === 'none'
  // a Team sync address names a project by its number (`unresolved:<n>`),
  // which the server resolves in the home organization into the project's
  // scope, its facts seeded, so the page never asks to choose a project the
  // person can open
  const unresolvedNum =
    scope.kind === 'unresolved' && /^\d+$/.test(scope.segment) ? Number(scope.segment) : null
  useEffect(() => {
    if (unresolvedNum === null || !P.homeOrg) return
    let live = true
    const stop = openResolved({ org_id: P.homeOrg, num: unresolvedNum }, (opening) => {
      if (!live || opening.state !== 'open') return
      onCorrectRef.current({ scope: `project:${opening.id}`, step: place.step })
    })
    return () => {
      live = false
      stop()
    }
  }, [unresolvedNum])
  const { humans, agents } = meeting
  // the people the page shows, named while it shows: the walk's people and
  // the meeting's tasks' assignees and reviewers, in the walk's order
  usePeople([
    ...[...humans, ...agents].map((u) => ({ org: P.homeOrg, id: u.id })),
    ...meeting.tasks.flatMap((it) => [
      { org: it.org, id: it.assignee ?? '' },
      { org: it.org, id: it.reviewer ?? '' },
    ]),
  ])
  const steps = ['team', ...humans.map((u) => u.id), ...(agents.length ? ['agents'] : [])]
  const walkers = new Set([...humans, ...agents].map((u) => u.id))
  // the footer's total: every row on some page of the walk (the Waiting on
  // review foot and the Done column are not rows)
  const walked = meeting.rows.filter((it) => walkers.has(it.owner))

  /* The step `place` asks for, as the walk can show it: an agent's id opens
     the agents step; the person just shown who has left the walk (their last
     row handed on) gives their place to the neighbour at the same index;
     anything else unknown, the phone's default own page included when the
     viewer owns nothing in scope, opens the team. So does a new scope the
     person has nothing in: its walk is another list, with no neighbour.
     While no meeting shows, the place keeps its step, as nothing is known
     of the walk yet. */
  const want = place.step
  let step = 'team'
  if (steps.includes(want)) step = want
  else if (agents.some((u) => u.id === want)) step = 'agents'
  else if (shown.current?.step === want && shown.current.scope === scopeKey && want !== 'team')
    step = steps[Math.min(shown.current.idx, steps.length - 1)]
  const idx = steps.indexOf(step)

  // the latest comment per open task, the one fact the agenda lacks, for
  // the people whose cards this step shows and then those of the steps on
  // either side, so Next and Previous open with their marks. The order
  // matters, because an answer cut short covers the first ones. An
  // organization Viewer's page reads the same people's loads.
  const cardOwners = (s: string | undefined): string[] =>
    s === 'agents'
      ? agents.filter((a) => openAgents.has(a.id)).map((a) => a.id)
      : s === undefined || s === 'team'
        ? []
        : [s]
  const syncOwners = [
    ...new Set([...cardOwners(step), ...cardOwners(steps[idx - 1]), ...cardOwners(steps[idx + 1])]),
  ]
  const ownerKey = syncOwners.join(',')
  const figures: Figures = useSyncFigures(meeting, syncOwners)
  // the people on this step whose latest-comment read came back cut short,
  // so some of their cards lack a mark (P.watchTeamSync)
  const marksCut = cardOwners(step)
    .filter((id) => P.lastCommentsCut.includes(id))
    .map((id) => [...humans, ...agents].find((u) => u.id === id)?.name ?? 'Someone')
  // on the hidden-tab gate: hidden, or a kept page behind another
  // (components/KeptView), the parts stop and the marks stay; App's
  // P.releaseSync empties them when the page leaves the kept pages
  useEffect(() => {
    const org = P.homeOrg || null
    const owners = ownerKey ? ownerKey.split(',') : []
    P.watchTeamSync(org, owners, visible)
    return () => P.watchTeamSync(org, owners, false)
  }, [ownerKey, visible])

  useEffect(() => {
    if (meeting.shows) shown.current = { step, idx, scope: scopeKey }
  })
  // each step opens at its top, header first (Next sits at the bottom of a
  // long page); instant, since the page never animates. A kept page shown
  // again (components/KeptView) stays where it was.
  const scrolledFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    const at = `${scopeKey}\n${step}`
    if (scrolledFor.current === at) return
    scrolledFor.current = at
    scroller.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [step, scopeKey])
  // correct a step the walk cannot show, in place (App replaces the URL);
  // only once a current ok answer for the scope came, so a deep link to a
  // person keeps its step while the meeting loads. The scope is never
  // corrected.
  const ready = meeting.state === 'ok'
  useEffect(() => {
    if (!ready) return
    if (agents.some((u) => u.id === place.step)) setOpenAgents((s) => new Set(s).add(place.step))
    if (step !== place.step) onCorrectRef.current({ scope: place.scope, step })
  }, [ready, step, place.scope, place.step])

  const go = (next: string) => {
    flushWalkInput()
    setPrompt(null)
    onPlace({ scope: scopeKey, step: next })
  }
  /* Another scope keeps the step (the phone's own page included), and asks
     about every card that holds unsent text, as the new scope's walk is not
     known until its answer arrives. A typed Remaining is committed first. */
  const pickScope = (key: string) => {
    flushWalkInput()
    setPrompt(null)
    onPlace({ scope: key, step: meeting.shows ? step : place.step }, [...cards.keys()])
  }
  const pick = (id: string) => {
    if (agents.some((u) => u.id === id)) {
      setOpenAgents((s) => new Set(s).add(id))
      go('agents')
    } else go(id)
  }
  const close = () => {
    flushWalkInput()
    onClose()
  }

  // a stale meeting's task controls are off, their title saying why, and
  // the reviewer prompt a move into In Review opened closes with them
  const frozen = meeting.state === 'stale' ? stoppedTitle(meeting.note) : null
  useEffect(() => {
    if (frozen !== null) setPrompt(null)
  }, [frozen])
  // the cards' rights: the agenda's `editable` of the answer the meeting
  // shows, which reruns on access changes, never the store's levels
  const editableIds = new Set(meeting.answer?.editable ?? [])
  const ctxFor = (owner: SyncPerson): PageCtx => {
    // P.syncStamp sends nothing for a viewer who is not staff (the server's
    // rule), so a read-only visitor earns no refusal toasts. It takes the
    // page owner and their stamp from the agenda's row, as the store holds
    // no one else, and the agenda's rerun brings the new stamp
    const stamp = () => P.syncStamp(owner, P.homeOrg)
    return {
      owner: owner.id,
      // from the agenda's stamp, which its Done tasks were read by
      since: meeting.since(owner),
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
      cards,
      frozen,
      editable: (id) => editableIds.has(id),
    }
  }

  const person = humans.find((u) => u.id === step) || null
  // the owners with a counted task still to review, found once per render;
  // no one reads as done while some task the meeting names has not
  // arrived, as the missing one may be theirs
  const unfinished = new Set(walked.filter((it) => !reviewed.has(it.uuid)).map((it) => it.owner))
  const allDone = (uid: string) => meeting.counted && !unfinished.has(uid)
  const today = new Date(now)
  const last = idx >= steps.length - 1
  // the scope the menu names: none where the page asks to choose
  const named = meeting.state !== 'choose' && meeting.state !== 'unavailable'

  let body: ReactNode
  // with no project of the home organization to see, no step has anything
  // to show, which the server's answer says (useHolds), read only while no
  // meeting shows and never taken as none before it confirmed it
  if (noProject)
    body = <NoProjects icon="people" title="Nothing to review yet" hint={syncNoProjectsHint()} />
  else if (!meeting.shows)
    body = (
      <SyncNote
        meeting={meeting}
        scopeKey={scopeKey}
        onPick={pickScope}
        onShowBoard={onShowBoard}
      />
    )
  else if (person) {
    const ctx = ctxFor(person)
    const prev = previousSync(person.stamp, now)
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
              <LoadChip load={figures.load(person)} />
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
          meeting={meeting}
          figures={figures}
          laterOpen={laterOpen.has(person.id)}
          onToggleLater={() => setLaterOpen((s) => flipped(s, person.id))}
        />
      </>
    )
  } else if (step === 'agents') {
    body = (
      <AgentsPage
        agents={agents}
        meeting={meeting}
        figures={figures}
        ctxFor={ctxFor}
        open={openAgents}
        onToggle={(id) => setOpenAgents((s) => flipped(s, id))}
        laterOpen={laterOpen}
        onToggleLater={(id) => setLaterOpen((s) => flipped(s, id))}
      />
    )
  } else {
    // the opening is the agenda's, an organization Viewer's included
    body = (
      <TeamOpening
        rows={meeting.rows}
        tasks={meeting.tasks}
        humans={humans}
        subIds={meeting.subIds}
        metaIds={meeting.metaIds}
        day={day}
        now={now}
        onOpenTask={onOpenTask}
        verdictOf={meeting.verdict}
        blockedOf={meeting.blockedBy}
        loadOf={meeting.load}
        counted={meeting.counted}
        frozen={frozen}
      />
    )
  }

  return (
    <div
      ref={setPane}
      data-sync-page
      data-sync-state={meeting.state}
      data-sync-stale={frozen !== null ? '' : undefined}
      aria-busy={meeting.busy || undefined}
      data-scroll
      data-screen-label="Team sync"
      className="overview-view [flex:1] [overflow:auto]"
    >
      <div className="[padding:0_20px_40px] [max-width:var(--workspace-content-max)] [margin:0_auto] [display:flex] [flex-direction:column]">
        <section className="overview-section">
          <div className="overview-section-body">
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <SyncScopeMenu scope={scope} named={named} onPick={pickScope} />
              <span data-sync-today className="whitespace-nowrap text-sm text-text-3">
                {P.WEEKDAYS[today.getDay()].slice(0, 3)} {P.fmtDate(today)}
              </span>
              <div className="flex-1" />
              <WalkRail
                people={meeting.shows ? [...humans, ...agents] : []}
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
                  meeting.shows ? (
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
                  ) : undefined
                }
              />
            </div>
            {!noProject && (
              <>
                <StaleNote
                  meeting={meeting}
                  scopeKey={scopeKey}
                  onPick={pickScope}
                  onShowBoard={onShowBoard}
                />
                {meeting.state === 'incomplete' && <IncompleteNote onRetry={meeting.retry} />}
              </>
            )}
            {body}
            {meeting.shows && marksCut.length > 0 && (
              <p data-sync-marks-cut className="mt-4 text-sm text-text-3">
                {marksCutLine(marksCut)}
              </p>
            )}
            {meeting.shows && (
              <div className="mt-6 flex items-center gap-2 border-t border-border pt-4">
                {/* no total while tasks the answer names have not arrived:
                    a total of 0 shows none */}
                <WalkFooter
                  reviewed={reviewed.count(walked)}
                  total={meeting.counted ? walked.length : 0}
                  atStart={idx <= 0}
                  last={last}
                  onPrev={() => go(steps[Math.max(0, idx - 1)])}
                  onNext={() => (last ? close() : go(steps[idx + 1]))}
                />
              </div>
            )}
          </div>
          <div className="overview-section-foot" aria-hidden="true" />
        </section>
      </div>
    </div>
  )
}
