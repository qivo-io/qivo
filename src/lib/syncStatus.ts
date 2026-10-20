import type { ConvexClient } from 'convex/browser'

/* Whether Qivo can save right now.

   Convex keeps a write it cannot send in memory, with no time limit, and
   sends it when the socket comes back. Nothing is saved locally, and tasks
   can change by other people meanwhile, so while saving cannot happen Qivo
   pauses edits instead of queueing them (store/planner.ts, write()). Saving
   pauses when the browser reports it is offline, when the socket has been
   down for OFFLINE_DELAY_MS, or when a sent write has waited SLOW_SAVE_MS on
   a socket that counts as connected (a half-open socket can take Convex up
   to a minute to notice). The pause ends once the socket is back, every
   write waiting has settled, and the server has sent the query results of
   the new connection (a Transition after the latest connect), so the screen
   holds a fresh delivery before anyone edits again. */

/** How long the connection must stay down before edits pause, so a short
    blip does not flash a notice. */
export const OFFLINE_DELAY_MS = 2_000
/** How long a sent write may wait on a connected socket before edits pause. */
export const SLOW_SAVE_MS = 10_000

/** Why saving pauses: `offline` while the connection is down, `slow` while a
    write takes longer than SLOW_SAVE_MS. `waiting` counts the changes sent
    before the pause that have not been confirmed yet. */
export type SavePause = { kind: 'offline' | 'slow'; waiting: number }

/** What the status reads from the Convex socket. */
export type SocketState = { connected: boolean; everConnected: boolean }

/** A listener hears every change of the pause, and of its `waiting` count
    during one. `ended` is the kind of a pause that just ended. */
export type SyncListener = (ended: SavePause['kind'] | null) => void

/** Creates the status. It starts as able to save, and learns about the
    connection only through setSocket and setOnline (watchConnection). */
export function createSyncStatus(now = () => Date.now()) {
  let socket: SocketState = { connected: false, everConnected: false }
  let online = true
  // whether the server sent query results since the socket last connected
  let fresh = true
  // when the socket last became connected, so a write sent before a
  // reconnect waits SLOW_SAVE_MS from the reconnect, not from its send
  let connectedAt = Number.NEGATIVE_INFINITY
  let downSince: number | null = null
  let kind: SavePause['kind'] | null = null
  let waiting = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const writes = new Map<symbol, { sentAt: number; counted: boolean }>()
  const listeners = new Set<SyncListener>()

  const countWaiting = () => [...writes.values()].filter((write) => write.counted).length

  /** Works the pause out again, arms the timer for the next change that
      time alone can bring, and tells the listeners when anything changed. */
  function evaluate() {
    const at = now()
    const down = !online || (socket.everConnected && !socket.connected)
    if (!down) downSince = null
    else downSince ??= at
    const before = kind
    let wake: number | null = null
    if (down) {
      if (at - (downSince ?? at) >= OFFLINE_DELAY_MS) kind = 'offline'
      else wake = (downSince ?? at) + OFFLINE_DELAY_MS
    } else if (writes.size && socket.connected) {
      // also after a reconnect, when the writes from before it stay unanswered
      const oldest = Math.min(...[...writes.values()].map((w) => Math.max(w.sentAt, connectedAt)))
      if (at - oldest >= SLOW_SAVE_MS) kind = 'slow'
      else wake = oldest + SLOW_SAVE_MS
    } else if (fresh) kind = null
    if (timer) clearTimeout(timer)
    timer = wake === null ? null : setTimeout(evaluate, Math.max(0, wake - at))
    const count = countWaiting()
    // the count shows only during a pause
    if (kind === before && (count === waiting || !kind)) return
    waiting = count
    const ended = before && !kind ? before : null
    for (const listener of listeners) listener(ended)
  }

  return {
    /** Why saving pauses now, or null while Qivo can save. */
    pause: (): SavePause | null => (kind ? { kind, waiting } : null),
    /** How many changes are sent and not confirmed yet. */
    unconfirmed: countWaiting,
    /** Records the socket's state. */
    setSocket(next: SocketState) {
      if (next.connected && !socket.connected) {
        connectedAt = now()
        fresh = false
      }
      socket = next
      evaluate()
    },
    /** Records that the server sent query results (a Convex Transition). */
    transitioned() {
      if (fresh) return
      fresh = true
      evaluate()
    },
    /** Records whether the browser reports a network connection. */
    setOnline(next: boolean) {
      online = next
      evaluate()
    },
    /** Records a write that was just sent and answers the function to call
        once it settles. `counted` says it is a change the person made, which
        the notice counts and the close warning protects. */
    track(counted: boolean): () => void {
      const id = Symbol()
      writes.set(id, { sentAt: now(), counted })
      evaluate()
      return () => {
        if (writes.delete(id)) evaluate()
      }
    },
    /** Calls `listener` on every change (see SyncListener). */
    subscribe(listener: SyncListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type SyncStatus = ReturnType<typeof createSyncStatus>

/** The one status the app's store reads. */
export const syncStatus = createSyncStatus()

/** Feeds `status` from the Convex client's connection state and its
    Transitions, and from the browser's `online` and `offline` events, which
    Convex does not read for going offline. Answers a function that stops it. */
export function watchConnection(
  status: SyncStatus,
  client: Pick<ConvexClient, 'connectionState' | 'subscribeToConnectionState' | 'client'>,
  win: Window = window,
) {
  const readSocket = () => {
    const state = client.connectionState()
    status.setSocket({
      connected: state.isWebSocketConnected,
      everConnected: state.hasEverConnected,
    })
  }
  const readOnline = () => status.setOnline(win.navigator.onLine !== false)
  readSocket()
  readOnline()
  const stop = client.subscribeToConnectionState(readSocket)
  const stopTransitions = client.client.addOnTransitionHandler(() => status.transitioned())
  win.addEventListener('online', readOnline)
  win.addEventListener('offline', readOnline)
  return () => {
    stop()
    stopTransitions()
    win.removeEventListener('online', readOnline)
    win.removeEventListener('offline', readOnline)
  }
}
