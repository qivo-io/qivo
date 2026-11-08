import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import {
  rootOf,
  type Seatless,
  splitWorkspace,
  type Workspace,
} from '../../../convex/lib/workspaceJoin'
import type { LiveQueries, LiveTransition } from '../../lib/liveQueries'
import {
  type ForcedInbox,
  INBOX_NO_ANSWER,
  INBOX_STAND_IN,
  inboxItemStandIn,
  inboxPageStandIn,
  inboxSummaryStandIn,
  type PageArgs,
} from '../inboxStandIn.setup'
import type { MilestoneRow } from '../milestoneRows'
import type { Row } from '../rows'

/* The live transport (lib/liveQueries.ts) for store tests, over a Convex
   client double with onUpdate. A test publishes the server's data as one
   value of the stand-in query WHOLE (Whole: the workspace's sections with
   every profile of each organization, its Team sync stamps, every team,
   membership and label, or null for no seat, or a seatless answer such as
   SEATS_DELETING when an organization deletion holds the seats, or fails
   it), and the double answers every workspace part from it as the server
   would: the root with the caller's own profiles, memberships and teams
   alone (convex/lib/workspaceJoin.ts rootOf), and each window with the
   rows whose ids fall in it, and tells the store of the parts whose answer
   changed in one transition, as Convex would. So the store holds nobody
   but the caller, and every other person, team and label reaches it only
   through the stand-ins that answer the reads by id and the pickers from
   the same whole (peopleSettingsStandIn, teamSettingsStandIn,
   labelPagesStandIn, mentionStandIn, teamSyncStandIn). A test can hold back one task window (holdWindow). Any other
   query, such as a task's thread or the Board's, is watched through the
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

   It may name projects the projects part leaves out (`unheldProjects`):
   the part sends neither them nor their grants and team shares, while
   every stand-in that reads the whole, the navigation reads' byIds among
   them (store/projectNavStandIn.setup.ts), answers them as the server
   does, so a view, the task window and the store's project cache
   (store/projectCache.ts) meet a project the workspace does not hold.

   The two inbox reads every store watches beside the parts, the unread
   summary and the open task's item (convex/inbox.ts summary and item), and
   the Inbox list's page (convex/inbox.ts page), which the Inbox watches as
   a view's read (lib/pagedList.ts usePagedPages), are answered from the
   published whole too, through their stand-in (store/inboxStandIn.setup.ts),
   on the parts' path, so each publish answers them again and a failed
   whole or a reconnect reaches them, and no test mocks them unless it
   forces a state (forceInbox). A page watch counts among the generation's
   parts, so the whole stays subscribed while an Inbox shows. That is new
   beside the other stand-ins, which tests wire through the client's
   onUpdate one by one; these run in every store.

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
    stand-ins read: the workspace's sections, with `profiles`, `teams` and
    `teamMembers` holding every person, team and membership of each
    organization and each profile's Team sync stamp (`sync_at`,
    `sync_since`), which no part sends but the agenda's stand-in answers,
    and every label (`labels`), which no part sends either. The root part
    answers only the caller's own rows of them (rootOf). It may name
    messagesCut false, may leave out `create`, which the root then answers
    as 'now', and may hold messages the server keeps beyond the inbox
    part's cut (`beyondCut`, the part's INBOX_LIMIT across the seats),
    which the inbox reads count and list and the parts leave out, as for an
    Inbox past 500 messages, tasks and projects the server holds that the
    parts do not send (`unheld`), which the page names its rows by, such as
    another organization's task of the same id as one the workspace holds,
    and the server's milestones (`milestones`), which no part sends and the
    milestone stand-in answers from, and the projects the projects part
    leaves out with their grants and team shares (`unheldProjects`, by id),
    which the stand-ins answer from `projects`. */
export type Whole = Omit<Workspace, 'messagesCut' | 'profiles' | 'create'> & {
  profiles: (Workspace['profiles'][number] & { sync_at?: string; sync_since?: string })[]
  labels: Row<'labels'>[]
  create?: Workspace['create']
  messagesCut?: boolean
  beyondCut?: Workspace['messages']
  unheld?: Partial<Pick<Workspace, 'issues' | 'projects'>>
  milestones?: MilestoneRow[]
  unheldProjects?: readonly string[]
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

const KINDS = ['tasks', 'projects'] as const
const PARTS: Record<string, string> = {
  'workspace:inbox': 'inbox',
  'workspace:tasks': 'tasks',
  'workspace:projects': 'projects',
}

/* The inbox reads answered from the whole, beside the parts. */
const INBOX_READS = new Set(['inbox:summary', 'inbox:item', 'inbox:page'])

/** The inbox reads a test may force alone (forceInbox). */
export type InboxRead = 'inbox:summary' | 'inbox:item' | 'inbox:page'

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
  const w =
    whole === null || seatless(whole)
      ? {
          myProfileIds: [],
          profiles: [],
          messages: [],
          readMessageCount: 0,
          unreadTruncated: false,
          readTruncated: false,
          issues: [],
          projects: [],
        }
      : whole
  const held = {
    ...w,
    messages: 'beyondCut' in w && w.beyondCut ? [...w.messages, ...w.beyondCut] : w.messages,
    issues: [...w.issues, ...(('unheld' in w && w.unheld?.issues) || [])],
    projects: [...w.projects, ...(('unheld' in w && w.unheld?.projects) || [])],
  }
  if (name === 'inbox:summary') return inboxSummaryStandIn(held, force)
  if (name === 'inbox:page') return inboxPageStandIn(held, args as PageArgs, force)
  return inboxItemStandIn(
    held,
    { org_id: String(args.org_id), issue_id: String(args.issue_id) },
    force,
  )
}

/** What the workspace part `name` with `args` answers while the server
    holds `whole`. */
function answerOf(whole: Published, name: string, args: Record<string, unknown>): unknown {
  if (seatless(whole)) return name === 'workspace:root' ? whole : { state: 'gone' }
  if (name === 'workspace:root') return whole === null ? null : rootOf(whole)
  // the window asked for; the inbox names none
  const window = {
    from: typeof args.from === 'string' ? args.from : '',
    to: typeof args.to === 'string' ? args.to : null,
  }
  // the projects the part leaves out go before the split, with their
  // grants and team shares, which the split sends only for its projects
  const left = whole?.unheldProjects ? new Set(whole.unheldProjects) : null
  const sent =
    whole && left ? { ...whole, projects: whole.projects.filter((p) => !left.has(p.id)) } : whole
  const org = sent
    ? splitWorkspace(sent, () => [window]).find((o) => o.org_id === args.org_id)
    : undefined
  if (!org) return { state: 'gone' }
  const part = PARTS[name]
  if (part === 'inbox') return { state: 'ok', ...org.inbox }
  const kind = part as (typeof KINDS)[number]
  const rows = org[kind][0]
  // the hidden load rows ride with the first task window only
  if (kind === 'tasks' && window.from !== '') return { state: 'ok', ...rows, orgLoad: [] }
  return { state: 'ok', ...rows }
}

/** The live transport over `client`. `batch(step)` sends everything
    `step` delivers as one transition, as Convex sends the results one
    server state changed. */
export function liveOver(client: Client): LiveQueries & {
  batch(step: () => void): void
  hold(orgId: string | null): void
  holdWindow(from: string | null): void
  failWindow(from: string | null, error?: unknown, later?: boolean): void
  reconnect(only?: readonly string[]): void
  forceInbox(force: ForcedInbox | null, only?: InboxRead): void
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

  const isPart = (name: string) =>
    name === 'workspace:root' || name in PARTS || INBOX_READS.has(name)
  // the state the inbox reads answer whatever the whole says, and which of
  // them, until forceInbox(null)
  let inboxForce: { force: ForcedInbox; only?: string } | null = null
  // the tokens a batch() gathers, sent as one transition at its end
  let batching: Set<string> | null = null
  // the organization whose parts answer nothing until hold(null)
  let heldOrg: string | null = null
  // where the task windows start that answer nothing until holdWindow(null)
  let heldWindow: string | null = null
  // where the task windows start that fail until failWindow(null)
  let failedWindow: { from: string; error: unknown } | null = null
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
      if (heldWindow !== null && w.name === 'workspace:tasks' && w.args.from === heldWindow)
        continue
      if (
        failedWindow !== null &&
        w.name === 'workspace:tasks' &&
        w.args.from === failedWindow.from
      ) {
        if (w.error === failedWindow.error) continue
        w.error = failedWindow.error
        w.json = undefined
        changed.add(token)
        continue
      }
      if ('error' in whole) {
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
      } else value = answerOf(whole.value, w.name, w.args)
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
    /** Keeps the parts of organization `orgId` from answering, such as a
        new seat's still loading, and with null lets them answer. */
    hold(orgId) {
      heldOrg = orgId
      if (orgId === null) fire(refresh())
    },
    /** Keeps every task window that starts at `from` from answering, as a
        window of a load of every task that has not answered yet, and lets
        the one held before answer; null holds none. */
    holdWindow(from) {
      heldWindow = from
      fire(refresh())
    },
    /** Fails every task window that starts at `from` with `error`, as a
        window the server could not load, now, or with `later` only for the
        next watch of such a window, as a fresh registry's. With null it
        lets such a window answer once the store runs it again (Convex
        keeps a failed run until then), with no transition now. */
    failWindow(from, error = new Error('task window failed'), later = false) {
      if (from === null) {
        failedWindow = null
        refresh()
        return
      }
      failedWindow = { from, error }
      if (later) return
      fire(refresh())
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
