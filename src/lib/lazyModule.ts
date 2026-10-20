import { type ComponentType, createElement, lazy, useRef } from 'react'
import { type SyncStatus, syncStatus } from './syncStatus'

/* A browser keeps a failed module download for the life of the page, and
   the failure covers every file the import needed, including the ones
   Vite's modulepreload links asked for. A later import of the same code
   fails at once, with or without a fresh address for the first file, and
   Vite never asks again for a stylesheet that failed once. So a failed
   import is kept, and its view offers a reload. To keep that rare, no import
   starts while the connection is down: the call is refused instead, and the
   view waits for the connection (components/ViewBoundary) and then loads
   normally. The workspace also downloads every view soon after it opens
   (preloadInBackground), so a later drop finds the code already there. */

/** Why a load was refused: the connection is down, so the download would
 * fail and stay failed. A later call once it is back loads normally. */
export class CodeWaitsForConnection extends Error {
  constructor() {
    super('This code loads when the connection is back.')
    this.name = 'CodeWaitsForConnection'
  }
}

/** Whether a load must wait for the connection: it is down now, or Qivo
 * still counts as offline. */
export function codeWaits(status: SyncStatus): boolean {
  return status.down() || status.pause()?.kind === 'offline'
}

/** Calls `listener` whenever `codeWaits(status)` may have changed. Answers
 * a function that stops it. */
export function watchCodeWaits(status: SyncStatus, listener: () => void): () => void {
  const stopPause = status.subscribe(() => listener())
  const stopDown = status.subscribeDown(listener)
  return () => {
    stopPause()
    stopDown()
  }
}

/** A module that loads on demand. `peek` answers it once it has loaded, and
 * `failed` tells whether its download failed for good. */
export type ModuleLoader<Module extends object> = (() => Promise<Module>) & {
  peek: () => Module | undefined
  failed: () => boolean
  /** Whether a load is under way. */
  loading: () => boolean
}

/** Share an import with boot preloading and retain its resolved module. A
 * call while the code must wait for the connection is refused and not kept,
 * so a later call tries. A failed import is kept, as the browser keeps it. */
export function preloadModule<Module extends object>(
  importModule: () => Promise<Module>,
  status: SyncStatus = syncStatus,
): ModuleLoader<Module> {
  let loaded: Module | undefined
  let failed = false
  let pending: Promise<Module> | undefined
  const load = () => {
    if (!pending && codeWaits(status)) return Promise.reject(new CodeWaitsForConnection())
    pending ??= importModule().then(
      (module) => {
        loaded = module
        return module
      },
      (error: unknown) => {
        failed = true
        throw error
      },
    )
    return pending
  }
  return Object.assign(load, {
    peek: () => loaded,
    failed: () => failed,
    loading: () => pending !== undefined && !loaded && !failed,
  })
}

/** A preloaded view renders without a Suspense fallback. Keep its component
 * type stable for the mounted lifetime so later renders preserve drafts.
 * React.lazy keeps a rejection for good, so an attempt that was refused is
 * replaced on a later mount once the code may load. While it still must
 * wait, React's renders of the same attempt reach the error boundary instead
 * of trying again. */
export function lazyFromModule<Module extends object, Props extends object>(
  load: ModuleLoader<Module>,
  select: (module: Module) => ComponentType<Props>,
  status: SyncStatus = syncStatus,
) {
  const attempt = () => {
    const state = { refused: false }
    const component: ComponentType<Props> = lazy(() =>
      load().then(
        (module) => ({ default: select(module) }),
        (error: unknown) => {
          if (error instanceof CodeWaitsForConnection) state.refused = true
          throw error
        },
      ),
    )
    return { component, state }
  }
  let current = attempt()
  return function Deferred(props: Props) {
    const loaded = load.peek()
    if (!loaded && current.state.refused && !codeWaits(status)) current = attempt()
    const component = useRef(loaded ? select(loaded) : current.component)
    return createElement(component.current, props)
  }
}

/** Loads each module `loaders` lists, one at a time while the browser is
 * idle, so a view opened later, after the connection drops, needs no
 * download. First it lets the loads already under way, such as the visible
 * view's, finish. It waits during any pause or while the connection is down,
 * and goes on when the status changes back. The first failure stops it, as
 * the connection may be down before Qivo notices, and a module that failed is
 * not tried again. `loaders` is asked on every run, so it can follow access
 * changes. Answers a function that stops it. */
export function preloadInBackground(
  loaders: () => readonly ModuleLoader<object>[],
  status: SyncStatus = syncStatus,
  idle: (next: () => void) => () => void = whenIdle,
) {
  let stopped = false
  let running = false
  // a change of the status during a pass, which the pass may have missed
  let again = false
  let cancelIdle = () => {}
  const waits = () => stopped || status.pause() !== null || codeWaits(status)
  const run = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    if (waits()) return
    running = true
    again = false
    try {
      const list = loaders()
      await Promise.allSettled(list.filter((load) => load.loading()).map((load) => load()))
      for (const load of list) {
        if (waits()) break
        if (load.peek() || load.failed()) continue
        await new Promise<void>((next) => {
          cancelIdle = idle(next)
        })
        if (waits()) break
        try {
          await load()
        } catch {
          break
        }
      }
    } finally {
      running = false
    }
    if (again) await run()
  }
  const unsubscribe = watchCodeWaits(status, () => void run())
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
