/* A live read a view owns, over the app's live transport (lib/liveQueries.ts),
   which the one gate of lib/viewVisibility.ts pauses while the tab or the
   desktop window is hidden.

   The view subscribes from an effect, so a kept page (components/KeptView.tsx)
   stops its read with its other effects while another page shows, and reads
   afresh when it shows again. A result counts only for the subscription that
   brought it. After a pause, a kept page shown again, new arguments or Try
   again, the view has no current result until a transition brings one, so
   it can say that it is refreshing. Views that read the same query with
   equal arguments share one subscription, so Try again in any of them asks
   the server again for all of them (lib/liveQueries.ts watch `fresh`), and
   each has no current result until the new run's arrives. Otherwise one
   view's Try again, such as a dialog's over a page that reads the same
   project, would join the other's subscription and read its failure back.

   A known cost: a kept page shown again first shows what it held and
   renders its parent's new props a frame later (KeptView), and its effects
   run in both commits. So when its arguments changed while it hid, such as
   a filter changed on another page or the Board's Stale hour turned
   (views/board/boardArgs.ts useStaleCutoff), the view subscribes once with
   the arguments it held and again with the current ones, and the server
   runs a query whose result nobody reads. Waiting until the page is current
   would avoid that run but delay every page shown again by a frame, also
   when nothing changed, so the view does not wait.

   A reader that shows its last answer while its read is paused or
   refreshing uses useKeptLiveView, which keeps that answer through a
   pause, a kept page shown again, a reconnect, Try again and a failure.
   useLiveView's own rule, no value until a transition brings one, stays.

   One path per query. A query a view reads on the live transport is never
   also held through convex.onUpdate (lib/liveQueries.ts), since a live
   watch that comes second to such a listener hears nothing until the
   answer changes (store/guard/liveRoutes.test.ts holds the app to it). */

import { type FunctionReference, getFunctionName } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { useEffect, useRef, useState } from 'react'
import { live } from './convex'
import type { WatchSharing } from './liveQueries'
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
  /** Subscribes afresh, as Try again does, and has the server run the
      query again for every view that reads it with equal arguments. */
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
 * result from before a reconnect. `sharing` goes to the transport's watch,
 * where `fresh` has the server run the query again for every watch of
 * equal arguments and `restarted` hears another watch's `fresh` until this
 * watch stops. Answers the way to stop, after which nothing is taken.
 * useLiveView, useLiveViews and lib/pagedList.ts read through it.
 */
export function watchLive<T>(
  ref: FunctionReference<'query'>,
  args: Record<string, Value>,
  take: (result: LiveResult<T>, connection: number | null) => void,
  seen?: (connection: number) => void,
  sharing?: WatchSharing,
): () => void {
  let stopped = false
  const watch = live.watch(ref, args, {
    fresh: sharing?.fresh,
    restarted: () => {
      if (!stopped) sharing?.restarted?.()
    },
  })
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
 * until a result replaces it. Try again (`retry`) subscribes afresh with
 * `fresh`, so the server runs the query again also while another view
 * shares the subscription, and every view of equal arguments then waits
 * for the new run's result.
 */
export function useLiveView<T>(ref: FunctionReference<'query'>, key: string | null): LiveView<T> {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // the attempt the open subscription started at, so one started for a
  // newer attempt, Try again's, asks the server again
  const opened = useRef(attempt)
  const [held, setHeld] = useState<Held<T> | null>(null)
  const [answered, setAnswered] = useState(false)
  const name = getFunctionName(ref)
  // `name` stands for `ref`, whose object is new on each read of the api;
  // `attempt` subscribes afresh
  useEffect(() => {
    // what came before answers an earlier subscription
    setHeld(null)
    if (key === null || !visible) return
    const fresh = attempt !== opened.current
    opened.current = attempt
    return watchLive<T>(
      ref,
      JSON.parse(key) as Record<string, Value>,
      (result) => {
        setHeld('value' in result ? { key, value: result.value } : { key, error: result.error })
        if ('value' in result) setAnswered(true)
      },
      undefined,
      // another view's Try again started the shared subscription again, so
      // what this one holds answers the earlier run
      { fresh, restarted: () => setHeld(null) },
    )
  }, [name, key, visible, attempt])
  return {
    key: held?.key ?? null,
    ...(held && 'value' in held ? { value: held.value } : {}),
    ...(held && 'error' in held ? { error: held.error } : {}),
    answered,
    retry: () => setAttempt((n) => n + 1),
  }
}

/** What useLiveViews holds now. */
export type LiveViews<T> = {
  /** each key's current value or error, absent while it holds none */
  held: ReadonlyMap<string, LiveResult<T>>
  /** Subscribes every key afresh, as useLiveView's Try again does. */
  retry: () => void
}

/**
 * The live results of query `ref` for each arguments key of `keys`, as
 * useLiveView reads one key, for a reader that splits its arguments over
 * several calls, such as more seats than one call may name. Every key
 * subscribes while the page shows and stops while it is hidden and when
 * the view's effects stop, and a change to the keys subscribes them all
 * afresh, so no key holds a result from before it. A key's failure holds
 * its error until a result replaces it, beside the other keys' results.
 */
export function useLiveViews<T>(
  ref: FunctionReference<'query'>,
  keys: readonly string[],
): LiveViews<T> {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // as in useLiveView, so a subscription for a newer attempt asks again
  const opened = useRef(attempt)
  const [held, setHeld] = useState<ReadonlyMap<string, LiveResult<T>>>(() => new Map())
  const name = getFunctionName(ref)
  const all = JSON.stringify(keys)
  useEffect(() => {
    setHeld(new Map())
    if (keys.length === 0 || !visible) return
    const fresh = attempt !== opened.current
    opened.current = attempt
    const forget = (key: string) =>
      setHeld((was) => {
        if (!was.has(key)) return was
        const next = new Map(was)
        next.delete(key)
        return next
      })
    const stops = keys.map((key) =>
      watchLive<T>(
        ref,
        JSON.parse(key) as Record<string, Value>,
        (result) => setHeld((was) => new Map(was).set(key, result)),
        undefined,
        { fresh, restarted: () => forget(key) },
      ),
    )
    return () => {
      for (const stop of stops) stop()
    }
  }, [name, all, visible, attempt])
  return { held, retry: () => setAttempt((n) => n + 1) }
}

/** What useKeptLiveView holds now: `loading` before a first answer for
    the key, `ok` with a current one, `refreshing` while it keeps an
    earlier answer and has no current one, and `failed` once the read
    failed, with the answer it kept, if any. */
export type KeptLiveView<T> = {
  state: 'loading' | 'ok' | 'refreshing' | 'failed'
  value: T | null
  error?: unknown
  /** Subscribes afresh, as Try again does, keeping the value shown as
      refreshing until the new run answers. */
  retry: () => void
}

type Kept<T> = { key: string; value?: T; error?: unknown; current: boolean }

/* Whether `error` is a refusal that ends the caller's access to what the
   read showed, after which a kept value must not stay on screen. */
const endsAccess = (error: unknown) => {
  if (!(error instanceof ConvexError)) return false
  const code = (error.data as { code?: unknown } | null)?.code
  return code === 'forbidden' || code === 'not_found'
}

/**
 * The live result of query `ref` for the arguments `key` holds, as
 * useLiveView reads it, for a reader that shows its last answer while the
 * read is paused or refreshing. It subscribes while the page shows and
 * stops while it is hidden, through watchLive with `seen`, so it knows the
 * connection each result came on. It keeps the last value for the same key
 * through a pause, a kept page shown again, a reconnect, Try again and a
 * transport failure, and is `refreshing` while it holds that value and no
 * current one. A new key, or null, drops it, and so does a refusal that
 * ends access (forbidden or not_found), so a value never outlives the
 * caller's right to see it. useLiveView's own rule is unchanged.
 */
export function useKeptLiveView<T>(
  ref: FunctionReference<'query'>,
  key: string | null,
): KeptLiveView<T> {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // as in useLiveView, so a subscription for a newer attempt asks again
  const opened = useRef(attempt)
  const [held, setHeld] = useState<Kept<T> | null>(null)
  const name = getFunctionName(ref)
  useEffect(() => {
    // a kept value is not current until this subscription answers
    const stale = (was: Kept<T> | null) =>
      was?.key === key ? (was.current ? { ...was, current: false } : was) : null
    setHeld(stale)
    if (key === null || !visible) return
    const fresh = attempt !== opened.current
    opened.current = attempt
    // the newest connection a transition named, and the one the latest
    // result came on, null for one read at once from a joined watch
    let newest = 0
    let came: number | null | undefined
    return watchLive<T>(
      ref,
      JSON.parse(key) as Record<string, Value>,
      (result, connection) => {
        came = connection
        if (connection !== null && connection > newest) newest = connection
        setHeld((was) => {
          if ('value' in result) return { key, value: result.value, current: true }
          const keep = was?.key === key && !endsAccess(result.error) ? was.value : undefined
          return {
            key,
            ...(keep !== undefined ? { value: keep } : {}),
            error: result.error,
            current: true,
          }
        })
      },
      (connection) => {
        if (connection <= newest) return
        const first = newest === 0
        newest = connection
        // a joined result takes the connection of the first transition
        if (came === null && first) came = connection
        if (came !== undefined && came !== connection) setHeld(stale)
      },
      { fresh, restarted: () => setHeld(stale) },
    )
  }, [name, key, visible, attempt])
  const retry = () => setAttempt((n) => n + 1)
  if (!held || held.key !== key) return { state: 'loading', value: null, retry }
  const value = held.value ?? null
  if (held.current && held.error !== undefined)
    return { state: 'failed', value, error: held.error, retry }
  if (held.value === undefined) return { state: 'loading', value: null, retry }
  return { state: held.current ? 'ok' : 'refreshing', value, retry }
}
