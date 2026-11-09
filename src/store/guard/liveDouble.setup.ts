import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { rootOf, type Seatless, type Workspace } from '../../../convex/lib/workspaceJoin'
import type { TaskSections } from '../../../convex/tests/tasksOracle.setup'
import type { LiveQueries, LiveTransition } from '../../lib/liveQueries'
import {
  type ForcedInbox,
  INBOX_NO_ANSWER,
  INBOX_STAND_IN,
  inboxFeedStandIn,
  inboxItemStandIn,
  inboxPageStandIn,
  inboxSummaryStandIn,
  type PageArgs,
} from '../inboxStandIn.setup'
import type { MilestoneRow } from '../milestoneRows'
import {
  answerProjectNav,
  type ForcedProjectNav,
  type ProjectNavRead,
} from '../projectNavStandIn.setup'
import type { Row } from '../rows'
import {
  type ForcedTaskWindow,
  isTaskWindowRead,
  TASK_WINDOW_NO_ANSWER,
  type TaskWindowRead,
  taskWindowStandIn,
} from '../taskWindowStandIn.setup'

/* The live transport (lib/liveQueries.ts) for store tests, over a Convex
   client double with onUpdate. A test publishes the server's data as one
   value of the stand-in query WHOLE (Whole: the workspace's sections with
   the caller's tasks, every profile of each organization, its Team sync
   stamps, every team, membership and label, or null for no seat, or a
   seatless answer such as SEATS_DELETING when an organization deletion
   holds the seats, or fails it), and the double answers the workspace's
   one part from it as the server would, the root with the caller's own
   profiles, memberships and teams alone (convex/lib/workspaceJoin.ts
   rootOf), and tells the store of the reads whose answer changed in one
   transition, as
   Convex would. So the store holds nobody but the caller, no project and
   no task, and every other person, team and label, every project and
   every task reaches it only through the stand-ins that answer the reads
   by id, the pickers, the views' reads and the window's reads from the
   same whole (peopleSettingsStandIn, teamSettingsStandIn,
   labelPagesStandIn, mentionStandIn, teamSyncStandIn, projectNavStandIn,
   boardStandIn and the other views' stand-ins, taskWindowStandIn). Any
   other query, such as a task's thread or the Board's, is watched through the
   client's own onUpdate, each result a transition of its own, and no
   other watch shares its subscription, so a view's `fresh` watch
   (lib/liveQueries.ts) has nothing more to start again. The task
   window's side queries (SHARED) share one subscription and one token per
   store between watches of the same arguments, as Convex does, and a watch
   that joins one whose answer arrived hears no transition for it
   (`joined`), so a registry that starts a second watch of a side query
   and waits for its first answer waits for ever, as it would in the app.
   A view's own handler (onTransition `view`) hears every transition but
   starts no store generation.

   The whole may hold the server's milestones (`milestones`), which no part
   sends, as the projects part sends none; the milestone stand-in answers
   the milestone reads from them (store/milestoneStandIn.setup.ts), and
   the store never receives them otherwise.

   The whole holds the server's projects with every grant and team grant
   (`projects`, `access`, `teamAccess`), which no part sends: the store's
   project cache (store/projectCache.ts) reads every project it shows
   through projectNav.byIds, which this double answers from the whole on
   the parts' path, as the server does (store/projectNavStandIn.setup.ts),
   so each publish answers it again, as the server reruns it after an
   access change. A test forces its states (forceProjectNav: a read that
   never answers, the refusal, a failure), lists the reads it opened
   (byIdsReads), or leaves it to the client's own onUpdate
   (forceProjectNav('client')) to answer it by hand. The other
   navigation reads go to the client like any other query.

   The inbox reads every store watches beside the parts, the unread
   summary and the open task's item (convex/inbox.ts summary and item), the
   Inbox list's page (convex/inbox.ts page), which the Inbox watches as a
   view's read (lib/pagedList.ts usePagedPages), and the feed the desktop
   alert client watches where the session can notify (convex/inbox.ts
   feed), are answered from the published whole's stored messages, which
   no part sends, through their stand-in (store/inboxStandIn.setup.ts), on
   the parts' path, so each publish answers them again and a failed whole
   or a reconnect reaches them, and no test mocks them unless it forces a
   state (forceInbox). A page watch counts among the generation's parts, so
   the whole stays subscribed while an Inbox shows. That is new beside the
   other stand-ins, which tests wire through the client's onUpdate one by
   one; these run in every store. jsdom has no Notification, so a store
   test that does not stub one runs no beat, feed or claim; one that does
   answers the session functions through store/notificationsStandIn.setup.ts.

   The task window's three reads (convex/taskWindow.ts task, links and
   attachments) are answered from the published whole too, through their
   stand-in (store/taskWindowStandIn.setup.ts), on the parts' path, so a
   window shows the whole's task from its own answer, each publish answers
   it again, and no test wires them unless it forces a state
   (forceTaskWindow: a read that never answers, fails, answers
   unavailable or an incomplete list) or answers them by hand: a double
   made with `{ taskWindow: 'client' }`, or after forceTaskWindow('client'),
   leaves them to the client's own onUpdate, sharing one token per store
   between watches of the same arguments (SHARED).

   Each store test file mocks lib/convex with `{ convex: network, live:
   liveOver(network) }`. */

/** The stand-in query a test publishes the whole workspace on. */
export const WHOLE = 'workspace:whole'

type Client = {
  onUpdate(
    ref: FunctionReference<'query'>,
    args: Record<string, unknown>,
    receive: (value: unknown) => void,
    fail?: (error: unknown) => void,
  ): unknown
  query?(ref: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>
}

/** The server's data a test publishes, the one server-side whole the
    stand-ins read: the workspace's sections, the caller's tasks with their
    relation rows and the anonymized load of the tasks the caller is not
    shown (TaskSections, as the tests' oracle answers them,
    convex/tests/tasksOracle.setup.ts), which no part sends and the views'
    and the window's stand-ins answer from, with `profiles`, `teams` and
    `teamMembers` holding every person, team and membership of each
    organization and each profile's Team sync stamp (`sync_at`,
    `sync_since`), which no part sends but the agenda's stand-in answers,
    and every label (`labels`), which no part sends either. The root part
    answers only the caller's own rows of them (rootOf). It may leave out
    `create`, which the root then answers as 'now', and holds the messages
    the server stores for the caller's seats (`messages`, none when left
    out), which no part sends and the inbox reads count, list and feed,
    tasks and projects the server holds that the page names its rows by
    (`unheld`), such as another organization's task of the same id as one
    the workspace holds, the server's milestones (`milestones`), which no
    part sends and the milestone stand-in answers from, and the server's
    projects with every grant and team grant on them (`projects`, `access`,
    `teamAccess`), which no part sends and every stand-in of a read that
    judges projects answers from. */
export type Whole = Omit<Workspace, 'profiles' | 'create'> &
  TaskSections & {
    profiles: (Workspace['profiles'][number] & { sync_at?: string; sync_since?: string })[]
    labels: Row<'labels'>[]
    projects: Row<'projects'>[]
    access: Row<'project_access'>[]
    teamAccess: Row<'project_team_access'>[]
    create?: Workspace['create']
    messages?: Row<'messages'>[]
    unheld?: { issues?: TaskSections['issues']; projects?: Row<'projects'>[] }
    milestones?: MilestoneRow[]
  }

/** What a test publishes for a login whose seats a running organization
    deletion holds. The root part answers it, as it answers any seatless
    state (convex/lib/workspaceParts.ts readRoot), and every other part that
    it has no seat. */
export const SEATS_DELETING: Seatless = { deleting: true, create: 'after_deletion' }
type Published = Whole | Seatless | null
const seatless = (value: Published): value is Seatless => value !== null && 'deleting' in value

/* The task window's side queries (store/liveParts.ts SIDE_NAMES), whose
   watches of the same arguments share one token, as in Convex. */
const SHARED = new Set([
  'snapshot:threadComments',
  'snapshot:threadHistory',
  'taskWindow:task',
  'taskWindow:links',
  'taskWindow:attachments',
])

/* The inbox reads answered from the whole, beside the parts. */
const INBOX_READS = new Set(['inbox:summary', 'inbox:item', 'inbox:page', 'inbox:feed'])

/* The project cache's read, answered from the whole beside the parts
   unless a test leaves it to the client (forceProjectNav('client')). */
const BY_IDS: ProjectNavRead = 'projectNav:byIds'

/* What a byIds read that never answers holds back. */
const NO_ANSWER = Symbol('no answer')

/** What projectNav.byIds with `args` answers while the server holds
    `whole`, NO_ANSWER for a read `force` keeps from answering; throws a
    failure or a refusal. A login with no seat holds no project. */
function byIdsAnswerOf(
  whole: Published,
  args: Record<string, unknown>,
  force: ForcedProjectNav | undefined,
): unknown {
  if (whole === null || seatless(whole)) return { rows: [], unchecked: [], message: null }
  let answer: unknown = NO_ANSWER
  let failure: unknown
  answerProjectNav(
    whole,
    BY_IDS,
    args,
    (value) => {
      answer = value
    },
    (error) => {
      failure = error
    },
    force ? { force } : undefined,
  )
  if (failure !== undefined) throw failure
  return answer
}

/** The inbox reads a test may force alone (forceInbox). */
export type InboxRead = 'inbox:summary' | 'inbox:item' | 'inbox:page' | 'inbox:feed'

/** What the inbox read `name` with `args` answers while the server holds
    `whole`, or INBOX_NO_ANSWER for none; throws a failure or a refusal. A
    login with no seat holds an empty summary, and its item read is
    refused, as the orgQuery refuses it. */
function inboxAnswerOf(
  whole: Published,
  name: string,
  args: Record<string, unknown>,
  force: ForcedInbox | undefined,
): unknown {
  const w: Pick<
    Whole,
    'myProfileIds' | 'profiles' | 'messages' | 'issues' | 'projects' | 'unheld'
  > =
    whole === null || seatless(whole)
      ? { myProfileIds: [], profiles: [], messages: [], issues: [], projects: [] }
      : whole
  const held = {
    ...w,
    messages: w.messages ?? [],
    issues: [...w.issues, ...(w.unheld?.issues ?? [])],
    projects: [...w.projects, ...(w.unheld?.projects ?? [])],
  }
  if (name === 'inbox:summary') return inboxSummaryStandIn(held, force)
  if (name === 'inbox:page') return inboxPageStandIn(held, args as PageArgs, force)
  if (name === 'inbox:feed') return inboxFeedStandIn(held, { after: Number(args.after) }, force)
  return inboxItemStandIn(
    held,
    { org_id: String(args.org_id), issue_id: String(args.issue_id) },
    force,
  )
}

/** What the root part answers while the server holds `whole`. */
function rootAnswerOf(whole: Published): unknown {
  if (seatless(whole)) return whole
  return whole === null ? null : rootOf(whole)
}

/** What the task window's read `name` with `args` answers while the
    server holds `whole`, or TASK_WINDOW_NO_ANSWER for none; throws a
    failure. A login with no seat is refused, as the server's orgQuery
    refuses a caller without a seat in the organization. */
function taskWindowAnswerOf(
  whole: Published,
  name: TaskWindowRead,
  args: Record<string, unknown>,
  force: ForcedTaskWindow | undefined,
): unknown {
  if (whole === null || seatless(whole))
    throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  return taskWindowStandIn(whole, name, args, force)
}

/** The live transport over `client`. `batch(step)` sends everything
    `step` delivers as one transition, as Convex sends the results one
    server state changed. With `taskWindow: 'client'` the task window's
    reads go to the client's own onUpdate, for a test that answers them by
    hand (forceTaskWindow). */
export function liveOver(
  client: Client,
  options: { taskWindow?: 'whole' | 'client' } = {},
): LiveQueries & {
  batch(step: () => void): void
  hold(orgId: string | null): void
  reconnect(only?: readonly string[]): void
  forceInbox(force: ForcedInbox | null, only?: InboxRead): void
  forceProjectNav(force: ForcedProjectNav | 'client' | null): void
  forceTaskWindow(force: ForcedTaskWindow | 'client' | null, only?: TaskWindowRead): void
  byIdsReads(): string[][]
  /** The subscriptions open now, each query's name with its arguments, so
      a test can tell what a page holds, as while it is hidden
      (src/hiddenReads.test.tsx). A store an earlier test left running
      holds its own, so `since` leaves out those watched last before the
      store generation it names (generation()). */
  opened(since?: number): { name: string; args: Record<string, unknown> }[]
  /** The newest store generation, which each registry's start moves on. */
  generation(): number
  /** the bounds of the stand-in this double answers the inbox reads with
      (store/inboxStandIn.setup.ts INBOX_STAND_IN), which a test lowers
      here, since vi.resetModules keeps this double and the module it
      loaded */
  inboxStandIn: typeof INBOX_STAND_IN
} {
  const handlers = new Set<(transition: LiveTransition) => void>()
  // the handlers of views' own reads, which start no generation
  const viewHandlers = new Set<(transition: LiveTransition) => void>()
  // what each watched token names, its latest result as JSON, and how many
  // watch it; a workspace part's result follows `whole`
  type Watch = {
    name: string
    args: Record<string, unknown>
    count: number
    /** the store generation that watched it last */
    gen: number
    json?: string
    value?: unknown
    error?: unknown
    stop?: () => void
  }
  const watched = new Map<string, Watch>()
  let whole: { value: Published } | { error: unknown } | undefined
  let stopWhole: (() => void) | null = null
  let at = 0
  let watches = 0
  // the socket's connection count, which reconnect() moves on
  let connection = 1
  // a store registers its handler before it watches the root part, so each
  // handler starts a generation, and only the newest one's watches count
  let generation = 0

  // what the project cache's read answers whatever the whole says, or
  // 'client' to leave it to the client's own onUpdate, until null
  let navForce: ForcedProjectNav | 'client' | null = null
  // the ids of every byIds read a store opened, in order
  const byIdsOpened: string[][] = []
  // what the task window's reads answer whatever the whole says, which of
  // them, or 'client' to leave them to the client's own onUpdate
  let windowForce: { force: ForcedTaskWindow | 'client'; only?: TaskWindowRead } | null =
    options.taskWindow === 'client' ? { force: 'client' } : null
  const windowToClient = (name: string) =>
    windowForce?.force === 'client' && (!windowForce.only || windowForce.only === name)
  const isPart = (name: string) =>
    name === 'workspace:root' ||
    INBOX_READS.has(name) ||
    (name === BY_IDS && navForce !== 'client') ||
    (isTaskWindowRead(name) && !windowToClient(name))
  // the state the inbox reads answer whatever the whole says, and which of
  // them, until forceInbox(null)
  let inboxForce: { force: ForcedInbox; only?: string } | null = null
  // the tokens a batch() gathers, sent as one transition at its end
  let batching: Set<string> | null = null
  // the organization whose reads answer nothing until hold(null)
  let heldOrg: string | null = null
  const fire = (tokens: Set<string>, when?: string) => {
    if (batching) {
      for (const token of tokens) batching.add(token)
      return
    }
    const t = when ? Date.parse(when) : Number.NaN
    // the workspace's delivery time, which a test sets, or the last one
    if (Number.isFinite(t)) at = Math.max(at, t)
    for (const fn of handlers) fn({ tokens, at, connection })
  }
  /** Brings every workspace part in line with `whole`, answering the tokens
      whose result changed. */
  const refresh = (only?: string): Set<string> => {
    const changed = new Set<string>()
    for (const [token, w] of watched) {
      if (!isPart(w.name) || (only && token !== only) || whole === undefined) continue
      if (heldOrg !== null && w.args.org_id === heldOrg) continue
      if ('error' in whole) {
        // the task window's reads are queries of their own, which a failed
        // workspace part does not fail
        if (isTaskWindowRead(w.name)) continue
        w.error = whole.error
        w.json = undefined
        changed.add(token)
        continue
      }
      let value: unknown
      if (INBOX_READS.has(w.name)) {
        const force =
          inboxForce && (!inboxForce.only || inboxForce.only === w.name)
            ? inboxForce.force
            : undefined
        try {
          value = inboxAnswerOf(whole.value, w.name, w.args, force)
        } catch (error) {
          if (w.error !== undefined && w.json === `error:${String(error)}`) continue
          w.error = error
          w.json = `error:${String(error)}`
          changed.add(token)
          continue
        }
        // a read that never answers holds what it had, which is nothing
        // when the stand-in is told to wait from its first answer
        if (value === INBOX_NO_ANSWER) continue
      } else if (w.name === BY_IDS) {
        try {
          value = byIdsAnswerOf(
            whole.value,
            w.args,
            navForce === 'client' ? undefined : (navForce ?? undefined),
          )
        } catch (error) {
          if (w.error !== undefined && w.json === `error:${String(error)}`) continue
          w.error = error
          w.json = `error:${String(error)}`
          changed.add(token)
          continue
        }
        if (value === NO_ANSWER) continue
      } else if (isTaskWindowRead(w.name)) {
        const force =
          windowForce &&
          windowForce.force !== 'client' &&
          (!windowForce.only || windowForce.only === w.name)
            ? windowForce.force
            : undefined
        try {
          value = taskWindowAnswerOf(whole.value, w.name, w.args, force)
        } catch (error) {
          if (w.error !== undefined && w.json === `error:${String(error)}`) continue
          w.error = error
          w.json = `error:${String(error)}`
          changed.add(token)
          continue
        }
        // a read that never answers holds what it had
        if (value === TASK_WINDOW_NO_ANSWER) continue
      } else value = rootAnswerOf(whole.value)
      const json = JSON.stringify(value)
      if (json === w.json && w.error === undefined) continue
      w.json = json
      w.value = structuredClone(value)
      w.error = undefined
      changed.add(token)
    }
    return changed
  }
  const receiveWhole = (value: Published) => {
    whole = { value }
    const changed = refresh()
    fire(changed, value === null || seatless(value) ? undefined : value.delivered_at)
  }
  const failWhole = (error: unknown) => {
    whole = { error }
    fire(refresh())
  }

  /** Subscribes to WHOLE through the client, replacing any subscription
      before. */
  const subscribeWhole = () => {
    stopWhole?.()
    // nothing is known of the new subscription until the client answers it
    whole = undefined
    at = 0
    for (const w of watched.values())
      if (isPart(w.name)) Object.assign(w, { value: undefined, error: undefined, json: undefined })
    // a test drives one store at a time: the one that just started, whose
    // handler came last, so a store an earlier test left running hears no
    // more of it; views' handlers stay
    const newest = [...handlers].filter((fn) => !viewHandlers.has(fn)).at(-1)
    for (const fn of handlers) if (fn !== newest && !viewHandlers.has(fn)) handlers.delete(fn)
    const stop = client.onUpdate(
      makeFunctionReference<'query'>(WHOLE),
      {},
      (value: unknown) => receiveWhole(value as Published),
      failWhole,
    )
    stopWhole = typeof stop === 'function' ? (stop as () => void) : () => {}
  }

  return {
    watch(ref, args) {
      const name = getFunctionName(ref)
      if (name === BY_IDS) byIdsOpened.push([...((args as { ids?: string[] }).ids ?? [])])
      // A store starts with the root part, so each store, also one a test
      // starts after vi.resetModules, which keeps this double, subscribes to
      // the whole workspace afresh and gets the test's own.
      if (name === 'workspace:root') subscribeWhole()
      // Any other query is watched through the client's own onUpdate, one
      // subscription per watch, since a test resets the client between
      // stores while this double lives on, but a side query's watches of
      // one store share one (SHARED).
      const token = isPart(name)
        ? `${name}:${JSON.stringify(args)}`
        : SHARED.has(name)
          ? `${name}:${JSON.stringify(args)}@${generation}`
          : `${name}:${JSON.stringify(args)}#${++watches}`
      const known = watched.get(token)
      // a side query's watch that joins one whose answer arrived reads it at
      // once and hears no transition for it
      let joined = false
      if (known && !isPart(name)) {
        known.count++
        joined = known.value !== undefined || known.error !== undefined
      } else if (known) {
        // a store an earlier test left running holds no count of it
        known.count = known.gen === generation ? known.count + 1 : 1
        known.gen = generation
        // A store a test left running can still watch the same part, and
        // vi.resetModules keeps this double, so each watch hears its first
        // answer, as a store's own subscription would.
        queueMicrotask(() => {
          if (
            watched.get(token) === known &&
            (known.value !== undefined || known.error !== undefined)
          )
            fire(new Set([token]))
        })
      } else {
        const w: Watch = { name, args, count: 1, gen: generation }
        watched.set(token, w)
        if (isPart(name)) {
          if (!stopWhole) subscribeWhole()
          // a new subscription's first answer comes in a later transition,
          // also when the client delivered while it subscribed
          queueMicrotask(() => {
            if (watched.get(token) !== w || whole === undefined) return
            refresh(token)
            fire(new Set([token]))
          })
        } else {
          // an answer the client gives while it subscribes arrives in a
          // later transition, once the store holds the subscription
          let subscribing = true
          const arrive = (step: () => void) => {
            const run = () => {
              if (watched.get(token) !== w) return
              step()
              fire(new Set([token]))
            }
            if (subscribing) queueMicrotask(run)
            else run()
          }
          const stop = client.onUpdate(
            ref,
            args,
            (value: unknown) =>
              arrive(() => {
                w.value = value
                w.error = undefined
              }),
            (error: unknown) =>
              arrive(() => {
                w.error = error
              }),
          )
          subscribing = false
          w.stop = typeof stop === 'function' ? (stop as () => void) : undefined
        }
      }
      let stopped = false
      return {
        token,
        // every other watch hears its first answer in a transition of its
        // own (above), so none reads one at once
        joined,
        stop: () => {
          if (stopped) return
          stopped = true
          const w = watched.get(token)
          if (!w || --w.count > 0) return
          watched.delete(token)
          w.stop?.()
          if (![...watched.values()].some((x) => isPart(x.name) && x.gen === generation)) {
            stopWhole?.()
            stopWhole = null
            whole = undefined
          }
        },
      }
    },
    read(token) {
      const w = watched.get(token)
      if (!w) return undefined
      if (w.error !== undefined) throw w.error
      return w.value
    },
    onTransition(fn, options) {
      if (options?.view) viewHandlers.add(fn)
      else generation++
      handlers.add(fn)
      return () => {
        handlers.delete(fn)
        viewHandlers.delete(fn)
      }
    },
    /** Keeps the reads of organization `orgId` that the double answers
        from the whole (the window's reads, the open task's item) from
        answering, and with null lets them answer. */
    hold(orgId) {
      heldOrg = orgId
      if (orgId === null) fire(refresh())
    },
    /** Makes the inbox reads, the Inbox's page among them, or the one
        `only` names, answer `force` whatever the whole says
        (store/inboxStandIn.setup.ts), from now on and at once for the ones
        watched, and with null as the whole says again. A state one read
        does not know, such as the page's `stopped` for the summary, leaves
        that read as the whole says. */
    forceInbox(force, only) {
      inboxForce = force === null ? null : { force, ...(only ? { only } : {}) }
      fire(refresh())
    },
    /** Drops the socket and connects again, as Convex does after a network
        blip: the connection count moves on, and every watched result
        arrives again in one transition, as it stands now. With `only`, the
        results of the queries it names arrive and the rest have not yet, as
        between the transitions that bring them again. */
    reconnect(only) {
      connection++
      const names = only && new Set(only)
      fire(
        new Set([...watched].flatMap(([token, w]) => (!names || names.has(w.name) ? [token] : []))),
      )
    },
    /** Makes the project cache's read (projectNav.byIds) answer with
        `force` whatever the whole says (store/projectNavStandIn.setup.ts:
        `byIdsLoading` never answers, `unchecked` lists every asked id
        apart, `fail` fails), from now on and at once for the reads watched,
        or, with 'client', leaves the reads watched from now on to the
        client's own onUpdate, and with null answers from the whole again. */
    forceProjectNav(force) {
      navForce = force
      fire(refresh())
    },
    /** Makes the task window's reads, or the one `only` names, answer
        `force` whatever the whole says (store/taskWindowStandIn.setup.ts:
        `loading` never answers, `failed` fails, `unavailable` and
        `incomplete`), from now on and at once for the reads watched, or,
        with 'client', leaves the reads watched from now on to the
        client's own onUpdate, and with null answers from the whole
        again. */
    forceTaskWindow(force, only) {
      windowForce = force === null ? null : { force, ...(only ? { only } : {}) }
      fire(refresh())
    },
    /** The ids of every projectNav.byIds read a store opened, in order. */
    byIdsReads: () => byIdsOpened.map((ids) => [...ids]),
    opened: (since = 0) =>
      [...watched.values()]
        .filter((w) => w.count > 0 && w.gen > since)
        .map((w) => ({ name: w.name, args: structuredClone(w.args) })),
    generation: () => generation,
    inboxStandIn: INBOX_STAND_IN,
    batch(step) {
      batching = new Set()
      try {
        step()
      } finally {
        const tokens = batching
        batching = null
        fire(tokens)
      }
    },
    query: (async (ref: FunctionReference<'query'>, args: Record<string, Value>) => {
      return client.query ? client.query(ref, args) : null
    }) as LiveQueries['query'],
  }
}
