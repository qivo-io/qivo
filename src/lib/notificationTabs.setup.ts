/* Doubles for the browser pieces the notification leader coordinates tabs
   with (lib/notificationLeader.ts): a Web Lock manager and a
   BroadcastChannel shared by simulated tabs of one browser profile, and a
   page's window and document. They run on microtasks, never on timers, so
   tests with fake timers drive them with awaited promises. Used by
   lib/notificationLeader.test.ts and convex/tests/
   notificationFeedClient.test.ts. */

import type { LeaderChannel, LeaderLocks, LeaderTarget } from './notificationLeader'

/** A request waiting for a lock. */
type Waiting = {
  callback: (lock: { name: string } | null) => unknown
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** A Web Lock manager shared by the tabs of one profile: exclusive locks
    granted in request order, `ifAvailable` answered at once, a queued
    request dropped by its signal, and a lock freed when its callback's
    promise settles. `requests` counts every request, for tests. */
export function createLockManager(): LeaderLocks & { requests: number } {
  const held = new Set<string>()
  const queues = new Map<string, Waiting[]>()
  const manager = {
    requests: 0,
    request(
      name: string,
      options: { ifAvailable?: boolean; signal?: AbortSignal },
      callback: (lock: { name: string } | null) => unknown,
    ): Promise<unknown> {
      manager.requests += 1
      return new Promise((resolve, reject) => {
        const waiting: Waiting = { callback, resolve, reject }
        if (options.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        if (!held.has(name)) {
          grant(name, waiting)
          return
        }
        if (options.ifAvailable) {
          queueMicrotask(() => run(waiting, null, () => {}))
          return
        }
        const queue = queues.get(name) ?? []
        queue.push(waiting)
        queues.set(name, queue)
        options.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(waiting)
          if (at < 0) return
          queue.splice(at, 1)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    },
    async query() {
      return {
        held: [...held].map((name) => ({ name })),
        pending: [...queues].flatMap(([name, queue]) => queue.map(() => ({ name }))),
      }
    },
  }
  /* Runs a request's callback with `lock` and settles the request with
     its result, then calls `done`. */
  function run(waiting: Waiting, lock: { name: string } | null, done: () => void) {
    let result: unknown
    try {
      result = waiting.callback(lock)
    } catch (error) {
      done()
      waiting.reject(error)
      return
    }
    void Promise.resolve(result).then(
      (value) => {
        done()
        waiting.resolve(value)
      },
      (error) => {
        done()
        waiting.reject(error)
      },
    )
  }
  function grant(name: string, waiting: Waiting) {
    held.add(name)
    queueMicrotask(() =>
      run(waiting, { name }, () => {
        held.delete(name)
        const next = queues.get(name)?.shift()
        if (next) grant(name, next)
      }),
    )
  }
  return manager
}

/** A BroadcastChannel hub: each channel it opens hears what the others
    post, a copy, on a microtask, and nothing once closed. */
export function createChannelHub() {
  const open = new Set<LeaderChannel>()
  return {
    open(): LeaderChannel {
      const channel: LeaderChannel = {
        onmessage: null,
        postMessage(message: unknown) {
          const copy = structuredClone(message)
          for (const other of open)
            if (other !== channel)
              queueMicrotask(() => {
                if (open.has(other)) other.onmessage?.({ data: copy } as MessageEvent)
              })
        },
        close() {
          open.delete(channel)
        },
      }
      open.add(channel)
      return channel
    },
    /** How many channels are open. */
    size: () => open.size,
  }
}

/** A page double: a window and a document the leader listens on, whose
    events tests fire with the fields they need, trusted unless told. */
export function createPageDouble() {
  type Listener = { type: string; fn: (event: Event) => void }
  const target = () => {
    const listeners: Listener[] = []
    const t: LeaderTarget & { fire(type: string, fields?: Record<string, unknown>): void } = {
      addEventListener(type, fn) {
        listeners.push({ type, fn })
      },
      removeEventListener(type, fn) {
        const at = listeners.findIndex((l) => l.type === type && l.fn === fn)
        if (at >= 0) listeners.splice(at, 1)
      },
      fire(type, fields = {}) {
        const event = { type, isTrusted: true, ...fields } as unknown as Event
        for (const l of listeners.filter((l) => l.type === type)) l.fn(event)
      },
    }
    return { t, count: (type: string) => listeners.filter((l) => l.type === type).length }
  }
  const win = target()
  const doc = target()
  const document = Object.assign(doc.t, { visibilityState: 'visible' })
  return {
    win: win.t,
    doc: document,
    /** Listeners held, for tests that check they went. */
    listening: (type: string) => win.count(type) + doc.count(type),
  }
}
