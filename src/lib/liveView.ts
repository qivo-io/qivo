/* A live read a view owns, over the app's live transport (lib/liveQueries.ts),
   which the one gate of lib/viewVisibility.ts pauses while the tab or the
   desktop window is hidden.

   The view subscribes from an effect, so a kept page (components/KeptView.tsx)
   stops its read with its other effects while another page shows, and reads
   afresh when it shows again. A result counts only for the subscription that
   brought it. After a pause, a kept page shown again, new arguments or Try
   again, the view has no current result until a transition brings one, so
   it can say that it is refreshing.

   A known cost: a kept page shown again first shows what it held and
   renders its parent's new props a frame later (KeptView), and its effects
   run in both commits. So when its arguments changed while it hid, such as
   a filter changed on another page or the Board's Stale hour turned
   (views/board/boardArgs.ts useStaleCutoff), the view subscribes once with
   the arguments it held and again with the current ones, and the server
   runs a query whose result nobody reads. Waiting until the page is current
   would avoid that run but delay every page shown again by a frame, also
   when nothing changed, so the view does not wait. */

import { type FunctionReference, getFunctionName } from 'convex/server'
import type { Value } from 'convex/values'
import { useEffect, useState } from 'react'
import { live } from './convex'
import { useViewVisibility } from './viewVisibility'

/** What a live view read holds now. */
export type LiveView<T> = {
  /** the arguments' key the value or error answers; null while the read
      holds no current result */
  key: string | null
  value?: T
  error?: unknown
  /** whether the read held a result before, so a wait is a refresh */
  answered: boolean
  /** Subscribes afresh, as Try again does. */
  retry: () => void
}

type Held<T> = { key: string; value?: T; error?: unknown }

/** What a live watch took: the query's value, or the error it failed with. */
export type LiveResult<T> = { value: T } | { error: unknown }

/**
 * Watches query `ref` with `args` on the app's live transport and hands
 * `take` each result that counts for this subscription: one a transition
 * names it in, with that transition's connection count, or one at once
 * when the watch joined a subscription whose result had arrived
 * (LiveQueries watch `joined`), with no count. A result Convex kept from an
 * earlier subscription is never taken as current. `seen`, when given,
 * hears the connection count of every transition, so a reader can tell a
 * result from before a reconnect. Answers the way to stop, after which
 * nothing is taken. useLiveView and lib/pagedList.ts read through it.
 */
export function watchLive<T>(
  ref: FunctionReference<'query'>,
  args: Record<string, Value>,
  take: (result: LiveResult<T>, connection: number | null) => void,
  seen?: (connection: number) => void,
): () => void {
  const watch = live.watch(ref, args)
  let stopped = false
  const read = (connection: number | null) => {
    let result: LiveResult<T>
    try {
      const value = live.read(watch.token) as T | undefined
      if (value === undefined) return
      result = { value }
    } catch (error) {
      result = { error }
    }
    take(result, connection)
  }
  const stopTransitions = live.onTransition(
    (transition) => {
      if (stopped) return
      seen?.(transition.connection)
      if (transition.tokens.has(watch.token)) read(transition.connection)
    },
    { view: true },
  )
  if (watch.joined) read(null)
  return () => {
    stopped = true
    stopTransitions()
    watch.stop()
  }
}

/**
 * The live result of query `ref` for the arguments `key` holds, the JSON of
 * the arguments in a fixed key order (null reads nothing). It subscribes
 * while the page shows, through the shared transport, so equal arguments
 * share one subscription, and stops while the page is hidden, on new
 * arguments and when the view's effects stop. A result is taken as
 * watchLive takes one, so a result Convex kept from an earlier
 * subscription is never taken as current. A failed read holds its error
 * until a result replaces it.
 */
export function useLiveView<T>(ref: FunctionReference<'query'>, key: string | null): LiveView<T> {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  const [held, setHeld] = useState<Held<T> | null>(null)
  const [answered, setAnswered] = useState(false)
  const name = getFunctionName(ref)
  // `name` stands for `ref`, whose object is new on each read of the api;
  // `attempt` subscribes afresh
  useEffect(() => {
    // what came before answers an earlier subscription
    setHeld(null)
    if (key === null || !visible) return
    return watchLive<T>(ref, JSON.parse(key) as Record<string, Value>, (result) => {
      setHeld('value' in result ? { key, value: result.value } : { key, error: result.error })
      if ('value' in result) setAnswered(true)
    })
  }, [name, key, visible, attempt])
  return {
    key: held?.key ?? null,
    ...(held && 'value' in held ? { value: held.value } : {}),
    ...(held && 'error' in held ? { error: held.error } : {}),
    answered,
    retry: () => setAttempt((n) => n + 1),
  }
}
