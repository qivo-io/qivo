import { type ComponentType, createElement, lazy, useRef } from 'react'
import { type SyncStatus, syncStatus } from './syncStatus'

/* A browser keeps a failed module download for the life of the page, and
   the failure covers every file the import needed, including the ones
   Vite's modulepreload links asked for. A later import of the same code
   fails at once, with or without a fresh address for the first file. So no
   import starts while Qivo knows it is offline: the view waits for the
   connection instead (components/ViewBoundary) and then loads normally. */

/** A module that loads on demand. `peek` answers it once it has loaded. */
export type ModuleLoader<Module extends object> = (() => Promise<Module>) & {
  peek: () => Module | undefined
}

/** Share an import with boot preloading and retain its resolved module. An
 * import that fails, or would start while `status` is offline, is not kept,
 * so the next call tries again. */
export function preloadModule<Module extends object>(
  importModule: () => Promise<Module>,
  status: SyncStatus = syncStatus,
): ModuleLoader<Module> {
  let loaded: Module | undefined
  let pending: Promise<Module> | undefined
  const load = () => {
    if (!pending && status.pause()?.kind === 'offline')
      return Promise.reject(new Error('This code loads when the connection is back.'))
    pending ??= importModule().then(
      (module) => {
        loaded = module
        return module
      },
      (error: unknown) => {
        pending = undefined
        throw error
      },
    )
    return pending
  }
  return Object.assign(load, { peek: () => loaded })
}

// bumps when an error boundary tries its view again, and when a pause ends,
// so a view closed while its code could not load starts afresh when reopened
let retries = 0
const stopCountingPauses = syncStatus.subscribe((ended) => {
  if (ended && !syncStatus.pause()) retries++
})
import.meta.hot?.dispose(stopCountingPauses)

/** Lets each lazily loaded view whose code failed start a new attempt the
 * next time it mounts. An error boundary calls it before it renders its
 * children again (components/ViewBoundary), and the end of every pause of
 * the app's status counts as one too. */
export function retryFailedLoads() {
  retries++
}

/** A preloaded view renders without a Suspense fallback. Keep its component
 * type stable for the mounted lifetime so later renders preserve drafts.
 * React.lazy keeps a rejection for good, so after retryFailedLoads a failed
 * attempt is replaced. Until then the failure stays, and React's own renders
 * of the same attempt reach the error boundary instead of downloading again. */
export function lazyFromModule<Module extends object, Props extends object>(
  load: ModuleLoader<Module>,
  select: (module: Module) => ComponentType<Props>,
) {
  let current = { failed: false, retries }
  const attempt = (): ComponentType<Props> =>
    lazy(() =>
      load().then(
        (module) => ({ default: select(module) }),
        (error: unknown) => {
          current.failed = true
          throw error
        },
      ),
    )
  let Lazy = attempt()
  return function Deferred(props: Props) {
    const loaded = load.peek()
    if (!loaded && current.failed && current.retries !== retries) {
      current = { failed: false, retries }
      Lazy = attempt()
    }
    const component = useRef(loaded ? select(loaded) : Lazy)
    return createElement(component.current, props)
  }
}

/** Loads each module in `loaders` in turn while the browser is idle, so a
 * view opened later, after the connection drops, needs no download. Waits
 * while `status` is offline and goes on when the pause ends. Answers a
 * function that stops it. */
export function preloadInBackground(
  loaders: readonly ModuleLoader<object>[],
  status: SyncStatus = syncStatus,
  idle: (next: () => void) => () => void = whenIdle,
) {
  let stopped = false
  let running = false
  let cancelIdle = () => {}
  const run = async () => {
    if (running) return
    running = true
    for (const load of loaders) {
      if (stopped || status.pause()?.kind === 'offline') break
      if (load.peek()) continue
      await new Promise<void>((next) => {
        cancelIdle = idle(next)
      })
      if (stopped) break
      // a failure is tried again when the next pause ends
      await load().catch(() => undefined)
    }
    running = false
  }
  const unsubscribe = status.subscribe((ended) => {
    if (ended && !status.pause()) void run()
  })
  void run()
  return () => {
    stopped = true
    cancelIdle()
    unsubscribe()
  }
}

/** Calls `next` once the browser is idle, or after a short wait where it
 * cannot tell. Answers a function that cancels the call. */
function whenIdle(next: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(next, { timeout: 2_000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(next, 50)
  return () => clearTimeout(id)
}
