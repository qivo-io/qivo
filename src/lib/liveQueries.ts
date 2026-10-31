/* Live queries read by Convex transition (store/liveParts.ts), over the
   base client that ConvexClient wraps.

   ConvexClient.onUpdate calls each listener on its own, and hands a new
   listener a result it already holds on a 0 ms timer, so a store with
   several queries could not tell which results one server state brought,
   nor a replay from news. Here a handler runs once per transition, after
   the client took in every result the transition brought and before any
   write it holds resolves (lib/convexOrdering.test.ts pins that), and names
   the queries whose results changed. A value is read only for a query a
   transition names, so a held result is never taken for a new one. */

import type { BaseConvexClient } from 'convex/browser'
import {
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  getFunctionName,
} from 'convex/server'
import type { Value } from 'convex/values'

/** What one transition brought to the queries being watched. */
export type LiveTransition = {
  /** the watched queries whose result changed, by token */
  tokens: ReadonlySet<string>
  /** the server time of the state it brought, in ms */
  at: number
  /** the socket's connection count; after a change every result arrives
      again before it can be trusted (store/liveParts.ts) */
  connection: number
}

/** The live query transport the store uses. Tests and the browser
    benchmark stand in for it (store/guard/liveDouble.setup.ts,
    scripts/perf/transport.mjs). */
export type LiveQueries = {
  /** Subscribes to `ref` with `args`. Watching the same query twice shares
      one subscription and one token. `joined` says the watch joined a
      subscription whose result already arrived, so `read` answers its
      current result at once; otherwise the first result comes with a
      transition that names the token. A result read before then may be
      one Convex kept from an earlier subscription to the same query and
      arguments, as it keeps a result by token until the next transition
      after the last unsubscribe. */
  watch(
    ref: FunctionReference<'query'>,
    args: Record<string, Value>,
  ): {
    token: string
    stop: () => void
    joined: boolean
  }
  /** The latest result of the query `token` names, undefined while none
      arrived. Throws the query's error when it failed. */
  read(token: string): unknown
  /** Calls `fn` once per transition. Answers the way to stop. `view` marks
      the handler of a view's own read (lib/liveView.ts) rather than the
      store's, which the transport treats alike and test doubles tell
      apart. */
  onTransition(fn: (transition: LiveTransition) => void, options?: { view?: boolean }): () => void
  /** Runs one-shot query `ref`. */
  query<Q extends FunctionReference<'query'>>(
    ref: Q,
    args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>
}

/* A transition time further than this from the local clock is taken as a
   fault, and the local clock stands in. */
const CLOCK_SLACK_MS = 24 * 60 * 60 * 1000

/** The transport over `client`, ConvexClient's base client, with `query`
    for its one-shot reads. */
export function createLiveQueries(
  client: BaseConvexClient,
  query: LiveQueries['query'],
): LiveQueries {
  // what each watched token names, how many watch it, and whether a
  // transition named it since its subscription started
  const watched = new Map<
    string,
    { name: string; args: Record<string, Value>; count: number; answered: boolean }
  >()
  // the newest transition's database time, in nanoseconds
  let last = 0n
  let warned = false
  return {
    watch(ref, args) {
      const name = getFunctionName(ref)
      const { queryToken, unsubscribe } = client.subscribe(name, args)
      const entry = watched.get(queryToken)
      const joined = entry?.answered === true
      if (entry) entry.count++
      else watched.set(queryToken, { name, args, count: 1, answered: false })
      let stopped = false
      return {
        token: queryToken,
        joined,
        stop: () => {
          if (stopped) return
          stopped = true
          unsubscribe()
          const left = watched.get(queryToken)
          if (left && --left.count === 0) watched.delete(queryToken)
        },
      }
    },
    read(token) {
      const entry = watched.get(token)
      return entry ? client.localQueryResult(entry.name, entry.args) : undefined
    },
    onTransition(fn) {
      return client.addOnTransitionHandler((transition) => {
        const tokens = new Set<string>()
        for (const { token } of transition.queries) {
          const entry = watched.get(token)
          if (!entry) continue
          tokens.add(token)
          entry.answered = true
        }
        // the database clock in nanoseconds (a Long)
        const ns = BigInt(transition.timestamp.toString())
        const advanced = ns > last
        if (advanced) last = ns
        let at = Number(ns / 1_000_000n)
        if (Math.abs(at - Date.now()) > CLOCK_SLACK_MS) {
          if (!warned) console.error('[qivo] transition time far from the clock:', at)
          warned = true
          at = Date.now()
        }
        // a refused write tells the handlers with nothing changed and no
        // newer state, which brings nothing
        if (tokens.size === 0 && !advanced) return
        fn({ tokens, at, connection: client.connectionState().connectionCount })
      })
    },
    query,
  }
}
