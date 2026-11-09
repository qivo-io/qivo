import type { BoardAnswer } from '../../../convex/lib/board'
import type { AgendaAnswer } from '../../../convex/lib/teamSyncAgenda'
import { type BoardArgs, boardStandIn, type ForcedBoard } from '../boardStandIn.setup'
import { answerMilestones, type ForcedMilestones, isMilestoneRead } from '../milestoneStandIn.setup'
import type { OverviewQuery } from '../overviewLists'
import { type ForcedOverview, type OverviewArgs, overviewStandIn } from '../overviewStandIn.setup'
import { type OwnerLoadsArgs, ownerLoadsStandIn } from '../ownerLoadsStandIn.setup'
import {
  isOwnerPickerRead,
  type OwnerPickerArgs,
  ownerPickersStandIn,
} from '../ownerPickersStandIn.setup'
import { peopleSettingsStandIn } from '../peopleSettingsStandIn.setup'
import type { Snapshot } from '../plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  type ProjectNavRead,
} from '../projectNavStandIn.setup'
import { answerRoadmap, type ForcedRoadmap } from '../roadmapStandIn.setup'
import { type ForcedSync, type SyncArgs, teamSyncStandIn } from '../teamSyncStandIn.setup'

/* The views' reads for store tests, answered from the published test
   workspace through the shared stand-ins, as the server would answer them:
   the Board's query (tasks:board, store/boardStandIn.setup.ts), the owner
   loads the cards' delays read (planning:ownerLoads,
   store/ownerLoadsStandIn.setup.ts), the Overview's queries
   (store/overviewStandIn.setup.ts), Team sync's agenda and last comments
   (store/teamSyncStandIn.setup.ts), the Roadmap's two reads
   (store/roadmapStandIn.setup.ts), the milestone reads
   (store/milestoneStandIn.setup.ts), the navigation reads the views and
   dialogs subscribe to (store/projectNavStandIn.setup.ts, the double
   answers the project cache's byIds), people:byIds
   (store/peopleSettingsStandIn.setup.ts) and a task's people pickers
   (store/ownerPickersStandIn.setup.ts). Each answers at once and again on
   each answerAll, unless a test holds, forces, fails or edits it through
   `server`. A test file's client double routes its subscriptions here
   (watch) and its one-shot reads (query), as the Board fixture
   (views/boardFixture.setup.tsx) does. */

/** What the caller may see and write, by project id, as the server judges
    it (store/oracleScope.setup.ts oracleLevels). */
export type ServerRule = { sees: (id: string) => boolean; writes: (id: string) => boolean }

/** The views' reads over `snapshot` as it is at each answer, judged by
    `rule`, read at each answer. */
export function viewReadsOver(snapshot: Snapshot, rule: () => ServerRule) {
  /** What the Board's query does: `hold` keeps answers back until
      `answer()`, `force` answers a state, `fail` fails the read and `edit`
      changes an answer. */
  const server: {
    hold: boolean
    force: ForcedBoard | null
    fail: unknown
    edit: ((answer: BoardAnswer) => BoardAnswer) | null
    /** the arguments of every subscription, newest last */
    asked: BoardArgs[]
    /** the subscriptions open now */
    open: Set<{ args: BoardArgs; next: (value: unknown) => void; fail?: (e: unknown) => void }>
    /** the owners whose loads answer unavailable */
    unavailable: string[]
    /** whether the owner-load calls wait for `answer()` */
    holdLoads: boolean
    /** what the owner-load calls fail with, while set */
    failLoads: unknown
    /** the owner-load calls open now */
    loads: Set<{
      args: OwnerLoadsArgs
      next: (value: unknown) => void
      fail?: (e: unknown) => void
    }>
    /** the Overview's queries: `hold` keeps their answers back, or those
        of the queries it names, `force` answers states the workspace
        cannot reach, `fail` fails a query `failing` names, `edit` changes
        an answer, `asked` is every subscription's query and arguments,
        newest last, and `open` those
        open now */
    /** the Roadmap's two reads: `hold` keeps their answers back, or those
        of the query it names, `force` answers states the workspace cannot
        reach, `fail` fails them, `ceiling` and `partTasks` lower the
        Roadmap's bounds, `edit` changes an answer, `asked` is every
        subscription's query and arguments, newest last, and `open` those
        open now */
    roadmap: {
      hold: boolean | ((name: string) => boolean)
      force: ForcedRoadmap[]
      fail: unknown
      ceiling?: number
      partTasks?: number
      edit: ((name: string, answer: unknown, args: unknown) => unknown) | null
      asked: { name: string; args: unknown }[]
      open: Set<{
        name: string
        args: unknown
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
    overview: {
      hold: boolean | ((query: OverviewQuery) => boolean)
      force: ForcedOverview
      fail: unknown
      failing: (query: OverviewQuery, args: OverviewArgs) => boolean
      edit: ((query: OverviewQuery, answer: unknown, args: OverviewArgs) => unknown) | null
      asked: { query: OverviewQuery; args: OverviewArgs }[]
      open: Set<{
        query: OverviewQuery
        args: OverviewArgs
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
    /** Team sync's agenda: `hold` keeps its answers back, `force` answers
        states and unknown figures the workspace cannot reach, `fail`
        fails the read, `edit` changes an answer, `asked` is every
        subscription's arguments, newest last, and `open` those open now */
    sync: {
      hold: boolean
      force: ForcedSync
      fail: unknown
      edit: ((answer: AgendaAnswer, args: SyncArgs) => AgendaAnswer) | null
      asked: SyncArgs[]
      open: Set<{ args: SyncArgs; next: (value: unknown) => void; fail?: (e: unknown) => void }>
    }
    /** the last comments' subscriptions open now, each with its owners */
    comments: Set<{ owners: string[] }>
    /** a task's people pickers (pickers:taskOwners, syncRecipients and
        canOwn) and people:byIds: `force` answers the stand-in's states,
        `asked` is every read's name and arguments, oldest first */
    owners: { force: Set<string>; asked: { name: string; args: unknown }[] }
    /** people.byIds' answers: `hold` keeps them back until `answer()`,
        `force` answers every read failed (`error`) or without any asked
        id (`gone`), and `open` holds the reads open now */
    people: {
      hold: boolean
      force: 'error' | 'gone' | null
      open: Set<{ args: unknown; next: (value: unknown) => void; fail?: (e: unknown) => void }>
    }
    /** the milestone reads: `hold` keeps their answers back, `force`
        answers states the workspace cannot reach, `asked` is every
        subscription's query and arguments, newest last, and `open` those
        open now, which a delivery answers again */
    milestones: {
      hold: boolean
      force: ForcedMilestones
      asked: { name: string; args: unknown }[]
      open: Set<{
        name: string
        args: unknown
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
    /** the navigation reads the views and dialogs subscribe to (children,
        page, search, resolve, targets and holds; the double answers the
        project cache's byIds), which answer from the snapshot through
        their stand-in, `force` forcing its states; `open` holds those open
        now, which a delivery answers again */
    nav: {
      force: ForcedProjectNav
      open: Set<{
        name: ProjectNavRead
        args: unknown
        next: (value: unknown) => void
        fail?: (e: unknown) => void
      }>
    }
  } = {
    hold: false,
    force: null,
    fail: undefined,
    edit: null,
    asked: [],
    open: new Set(),
    unavailable: [],
    holdLoads: false,
    failLoads: undefined,
    loads: new Set(),
    roadmap: {
      hold: false,
      force: [],
      fail: undefined,
      edit: null,
      asked: [],
      open: new Set(),
    },
    overview: {
      hold: false,
      force: {},
      fail: undefined,
      failing: () => true,
      edit: null,
      asked: [],
      open: new Set(),
    },
    sync: { hold: false, force: {}, fail: undefined, edit: null, asked: [], open: new Set() },
    comments: new Set(),
    owners: { force: new Set(), asked: [] },
    people: { hold: false, force: null, open: new Set() },
    milestones: { hold: false, force: {}, asked: [], open: new Set() },
    nav: { force: {}, open: new Set() },
  }
  /** Answers people:byIds read `read` from the snapshot as it is now, with
      the state the test forces. */
  const answerPeople = (read: {
    args: unknown
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    try {
      read.next(
        peopleSettingsStandIn(
          snapshot,
          'people:byIds',
          read.args as Record<string, unknown>,
          server.people.force ? { byIds: server.people.force } : {},
        ),
      )
    } catch (e) {
      read.fail?.(e)
    }
  }
  /** Answers Team sync subscription `sub` from the snapshot as it is now,
      or fails it. */
  const answerSync = (sub: {
    args: SyncArgs
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    const s = server.sync
    if (s.fail !== undefined) return sub.fail?.(s.fail)
    const { sees, writes } = rule()
    const answer = teamSyncStandIn(snapshot, sub.args, { sees, writes, force: s.force })
    sub.next(structuredClone(s.edit ? s.edit(answer, sub.args) : answer))
  }
  /** Answers Roadmap subscription `sub` from the snapshot as it is now, or
      fails it, as the test says. */
  const answerRoadmapSub = (sub: {
    name: string
    args: unknown
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    const r = server.roadmap
    if (r.fail !== undefined) return sub.fail?.(r.fail)
    const { sees, writes } = rule()
    const answer = answerRoadmap(snapshot, sub.name, sub.args, {
      sees,
      canEdit: writes,
      force: r.force,
      ceiling: r.ceiling,
      partTasks: r.partTasks,
    })
    sub.next(structuredClone(r.edit ? r.edit(sub.name, answer, sub.args) : answer))
  }
  /** Answers owner-load call `call` from the snapshot as it is now, or
      fails it, as the test says. */
  const answerLoads = (call: {
    args: OwnerLoadsArgs
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) =>
    server.failLoads !== undefined
      ? call.fail?.(server.failLoads)
      : call.next(ownerLoadsStandIn(snapshot, call.args, { unavailable: server.unavailable }))
  const answerOf = (args: BoardArgs): BoardAnswer => {
    const { sees } = rule()
    const answer = boardStandIn(snapshot, args, { sees, force: server.force ?? undefined })
    return server.edit ? server.edit(answer) : answer
  }
  /** Answers Overview subscription `sub` from the snapshot as it is now,
      or fails it: as the test says, or where its stand-in refuses a
      position. */
  const answerOverview = (sub: {
    query: OverviewQuery
    args: OverviewArgs
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => {
    const o = server.overview
    if (o.fail !== undefined && o.failing(sub.query, sub.args)) return sub.fail?.(o.fail)
    let answer: unknown
    const { sees } = rule()
    try {
      answer = overviewStandIn(snapshot, sub.query, sub.args, { sees, force: o.force })
    } catch (error) {
      return sub.fail?.(error)
    }
    sub.next(structuredClone(o.edit ? o.edit(sub.query, answer, sub.args) : answer))
  }
  /** Answers milestone subscription `sub` from the snapshot as it is now,
      with the states the test forces. */
  const answerMilestoneSub = (sub: {
    name: string
    args: unknown
    next: (value: unknown) => void
    fail?: (e: unknown) => void
  }) => answerMilestones(snapshot, sub.name, sub.args, sub.next, sub.fail, server.milestones.force)
  /** Answers every open subscription of the Board's query from the
      snapshot as it is now, and the other views' reads. */
  const answerAll = () => {
    for (const sub of server.open)
      if (server.fail !== undefined) sub.fail?.(server.fail)
      else sub.next(structuredClone(answerOf(sub.args)))
    for (const call of server.loads) answerLoads(call)
    for (const sub of server.overview.open) answerOverview(sub)
    for (const sub of server.sync.open) answerSync(sub)
    for (const sub of server.roadmap.open) answerRoadmapSub(sub)
    if (!server.milestones.hold) for (const sub of server.milestones.open) answerMilestoneSub(sub)
    if (!server.people.hold) for (const read of server.people.open) answerPeople(read)
    for (const sub of server.nav.open)
      answerProjectNav(snapshot, sub.name, sub.args, sub.next, sub.fail, {
        force: server.nav.force,
      })
  }
  /** One-shot read `name` with `args`: a task's people pickers from their
      stand-in, else null. */
  const query = (name: string, args: OwnerPickerArgs): unknown => {
    if (!isOwnerPickerRead(name)) return null
    server.owners.asked.push({ name, args })
    return structuredClone(ownerPickersStandIn(snapshot, name, args, server.owners.force))
  }
  /** Watches view read `name` with `args`, answering `next` or `fail`
      from the snapshot now and on each answerAll, and answers its stop,
      or undefined for a read none of the views' stand-ins answers. */
  const watch = (
    name: string,
    args: unknown,
    next: (value: unknown) => void,
    fail?: (e: unknown) => void,
  ): (() => void) | undefined => {
    if (name === 'people:byIds') {
      server.owners.asked.push({ name, args })
      const read = { args, next, fail }
      server.people.open.add(read)
      if (!server.people.hold) answerPeople(read)
      return () => server.people.open.delete(read)
    }
    if (name === 'tasks:board') {
      const sub = { args: args as BoardArgs, next, fail }
      server.asked.push(sub.args)
      server.open.add(sub)
      if (!server.hold)
        if (server.fail !== undefined) fail?.(server.fail)
        else next(structuredClone(answerOf(sub.args)))
      return () => server.open.delete(sub)
    }
    if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies') {
      const sub = { name, args, next, fail }
      server.roadmap.asked.push({ name, args })
      server.roadmap.open.add(sub)
      const hold = server.roadmap.hold
      if (!(typeof hold === 'function' ? hold(name) : hold)) answerRoadmapSub(sub)
      return () => server.roadmap.open.delete(sub)
    }
    if (isMilestoneRead(name)) {
      const sub = { name, args, next, fail }
      server.milestones.asked.push({ name, args })
      server.milestones.open.add(sub)
      if (!server.milestones.hold) answerMilestoneSub(sub)
      return () => server.milestones.open.delete(sub)
    }
    if (name === 'planning:ownerLoads') {
      const call = { args: args as OwnerLoadsArgs, next, fail }
      server.loads.add(call)
      if (!server.holdLoads) answerLoads(call)
      return () => server.loads.delete(call)
    }
    if (name === 'teamSync:agenda') {
      const sub = { args: args as SyncArgs, next, fail }
      server.sync.asked.push(sub.args)
      server.sync.open.add(sub)
      if (!server.sync.hold) answerSync(sub)
      return () => server.sync.open.delete(sub)
    }
    if (isProjectNavRead(name) && name !== 'projectNav:byIds') {
      const sub = { name, args, next, fail }
      server.nav.open.add(sub)
      answerProjectNav(snapshot, name, args, next, fail, { force: server.nav.force })
      return () => server.nav.open.delete(sub)
    }
    if (name === 'teamSync:lastComments') {
      const sub = { owners: [...((args as { owner_ids: string[] }).owner_ids ?? [])] }
      server.comments.add(sub)
      next({ rows: [], complete: true })
      return () => server.comments.delete(sub)
    }
    if (name.startsWith('overview:')) {
      const sub = {
        query: name.slice('overview:'.length) as OverviewQuery,
        args: args as OverviewArgs,
        next,
        fail,
      }
      server.overview.asked.push({ query: sub.query, args: sub.args })
      server.overview.open.add(sub)
      const hold = server.overview.hold
      if (!(typeof hold === 'function' ? hold(sub.query) : hold)) answerOverview(sub)
      return () => server.overview.open.delete(sub)
    }
    return undefined
  }
  return { server, answerAll, answerPeople, query, watch }
}

/** The views' reads of one test (viewReadsOver). */
export type ViewReads = ReturnType<typeof viewReadsOver>
