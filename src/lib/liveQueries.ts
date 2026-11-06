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

/** How a watch meets the other watches of its query and arguments
    (LiveQueries watch). */
export type WatchSharing = {
  /** asks the server to run the query again, also while other watches
      share its subscription, as Try again does */
  fresh?: boolean
  /** hears that another watch's `fresh` started the shared subscription
      again, so what this one read before answers the earlier run */
  restarted?: () => void
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
      after the last unsubscribe. A `fresh` watch that other watches share
      stops the subscription and opens it again for all of them, so the
      server runs the query once more for every one. That watch is not
      `joined`, and each other watch hears `restarted` and gets the new
      run's result with the transition that names the token. A `fresh`
      watch alone subscribes afresh anyway, since the last stop ended the
      subscription. */
  watch(
    ref: FunctionReference<'query'>,
    args: Record<string, Value>,
    sharing?: WatchSharing,
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
  // what each watched token names, its watches, each with the client
  // subscription it holds, and whether a transition named it since its
  // subscription started
  type Watcher = { unsubscribe: () => void; restarted?: () => void }
  const watched = new Map<
    string,
    { name: string; args: Record<string, Value>; watchers: Set<Watcher>; answered: boolean }
  >()
  let warned = false
  return {
    watch(ref, args, sharing) {
      const name = getFunctionName(ref)
      const { queryToken, unsubscribe } = client.subscribe(name, args)
      const self: Watcher = { unsubscribe, restarted: sharing?.restarted }
      const known = watched.get(queryToken)
      const entry = known ?? { name, args, watchers: new Set<Watcher>(), answered: false }
      if (!known) watched.set(queryToken, entry)
      entry.watchers.add(self)
      if (known && sharing?.fresh) {
        // Every watch's subscription stops, so the client drops the query,
        // and starts again, so the client asks the server for it under a
        // new query id. The client keeps the earlier run's result by token
        // until the next transition, and a watch reads only what a
        // transition names, so none takes it for the new run's.
        for (const w of entry.watchers) w.unsubscribe()
        for (const w of entry.watchers) w.unsubscribe = client.subscribe(name, args).unsubscribe
        entry.answered = false
        for (const w of entry.watchers) if (w !== self) w.restarted?.()
      }
      const joined = entry.answered
      let stopped = false
      return {
        token: queryToken,
        joined,
        stop: () => {
          if (stopped) return
          stopped = true
          self.unsubscribe()
          entry.watchers.delete(self)
          if (entry.watchers.size === 0) watched.delete(queryToken)
        },
      }
    },
    read(token) {
      const entry = watched.get(token)
      return entry ? client.localQueryResult(entry.name, entry.args) : undefined
    },
    onTransition(fn) {
      // the newest database time this handler was told of, in nanoseconds:
      // each handler keeps its own, as the one that runs first must not
      // make a later one miss a transition
      let last = 0n
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
