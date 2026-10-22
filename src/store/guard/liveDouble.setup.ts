import { type FunctionReference, getFunctionName, makeFunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { splitWorkspace, type Workspace } from '../../../convex/lib/workspaceJoin'
import type { LiveQueries, LiveTransition } from '../../lib/liveQueries'

/* The live transport (lib/liveQueries.ts) for store tests, over a Convex
   client double with onUpdate. A test publishes the whole workspace as one
   value of the stand-in query WHOLE, in the shape the store keeps it (or
   null for no seat, or fails it), and the double answers every workspace
   part from it, each organization in one window, and tells the store of the
   parts whose answer changed in one transition, as Convex would. Any other
   query, such as a task's thread, is watched through the client's own
   onUpdate, each result a transition of its own.

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

/* The workspace a test publishes, which may name messagesCut false. */
type Whole = Omit<Workspace, 'messagesCut'> & { messagesCut?: boolean }

const KINDS = ['tasks', 'people', 'projects'] as const
const PARTS: Record<string, string> = {
  'workspace:catalog': 'catalog',
  'workspace:inbox': 'inbox',
  'workspace:tasks': 'tasks',
  'workspace:people': 'people',
  'workspace:projects': 'projects',
}

/** What the workspace part `name` with `args` answers while the server
    holds `whole`. */
function answerOf(whole: Whole | null, name: string, args: Record<string, unknown>): unknown {
  if (name === 'workspace:root')
    return whole === null
      ? null
      : { auth_user_id: whole.auth_user_id, myProfileIds: whole.myProfileIds, orgs: whole.orgs }
  const org = whole
    ? splitWorkspace(whole, () => [{ from: '', to: null }]).find((o) => o.org_id === args.org_id)
    : undefined
  if (!org) return { state: 'gone' }
  const part = PARTS[name]
  if (part === 'catalog' || part === 'inbox') return { state: 'ok', ...org[part] }
  const kind = part as (typeof KINDS)[number]
  // one window per kind, the first; any later window is empty
  const window = args.from === '' ? org[kind][0] : undefined
  const empty = {
    tasks: { issues: [], links: [], issueLabels: [], attachments: [], issueSubs: [], orgLoad: [] },
    people: { profiles: [], teamMembers: [] },
    projects: { projects: [], access: [], teamAccess: [], milestones: [] },
  }
  return { state: 'ok', ...(window ?? empty[kind]) }
}

/** The live transport over `client`. `batch(step)` sends everything
    `step` delivers as one transition, as Convex sends the results one
    server state changed. */
export function liveOver(client: Client): LiveQueries & { batch(step: () => void): void } {
  const handlers = new Set<(transition: LiveTransition) => void>()
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
  let whole: { value: Whole | null } | { error: unknown } | undefined
  let stopWhole: (() => void) | null = null
  let at = 0
  let watches = 0
  // a store registers its handler before it watches the root part, so each
  // handler starts a generation, and only the newest one's watches count
  let generation = 0

  const isPart = (name: string) => name === 'workspace:root' || name in PARTS
  // the tokens a batch() gathers, sent as one transition at its end
  let batching: Set<string> | null = null
  const fire = (tokens: Set<string>, when?: string) => {
    if (batching) {
      for (const token of tokens) batching.add(token)
      return
    }
    const t = when ? Date.parse(when) : Number.NaN
    // the workspace's delivery time, which a test sets, or the last one
    if (Number.isFinite(t)) at = Math.max(at, t)
    for (const fn of handlers) fn({ tokens, at, connection: 1 })
  }
  /** Brings every workspace part in line with `whole`, answering the tokens
      whose result changed. */
  const refresh = (only?: string): Set<string> => {
    const changed = new Set<string>()
    for (const [token, w] of watched) {
      if (!isPart(w.name) || (only && token !== only) || whole === undefined) continue
      if ('error' in whole) {
        w.error = whole.error
        w.json = undefined
        changed.add(token)
        continue
      }
      const value = answerOf(whole.value, w.name, w.args)
      const json = JSON.stringify(value)
      if (json === w.json && w.error === undefined) continue
      w.json = json
      w.value = structuredClone(value)
      w.error = undefined
      changed.add(token)
    }
    return changed
  }
  const receiveWhole = (value: Whole | null) => {
    whole = { value }
    const changed = refresh()
    fire(changed, value?.delivered_at)
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
    // more of it
    const newest = [...handlers].at(-1)
    handlers.clear()
    if (newest) handlers.add(newest)
    const stop = client.onUpdate(
      makeFunctionReference<'query'>(WHOLE),
      {},
      (value: unknown) => receiveWhole(value as Whole | null),
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
      // stores while this double lives on.
      const token = isPart(name)
        ? `${name}:${JSON.stringify(args)}`
        : `${name}:${JSON.stringify(args)}#${++watches}`
      const known = watched.get(token)
      if (known) {
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
    onTransition(fn) {
      generation++
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
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
