/* The one runner for an app action that sends several calls one after
   another (the limits plan's "Large actions and client-driven batches").
   The Inbox's Mark all as read and Remove all read (store/planner.ts
   bulkInboxAction) and Deleted items' Restore and Delete now
   (store/planner.ts runDeletedItems) run on it. A new app action that
   sends several calls one after another uses it too, so the rules live
   in one place:

   - The action's work splits into lanes, one an organization, and each
     lane sends its batches one after another, never two at once.
   - A large action, one of more than one round (roundsOf), runs its lanes
     on the shared pool LANE_POOL, so the app has at most LANES_AT_ONCE
     writes of large actions in flight in all, whichever actions run. An
     action of one round runs on a pool of its own, so a single Restore
     never waits behind a long Mark all as read.
   - A refusal stops its lane and leaves its later batches unsent, while
     the other lanes go on. The pause (offline, a slow save, a lost seat
     or sign-in) stops every lane before its next batch, the queued ones
     before they send anything. A queued lane that waits for a shared
     place leaves the queue then, so a paused action settles without
     waiting for another action's lanes to free one.
   - Once `live` turns false, as when the store's epoch changes, the run
     ends quietly. A fault, a throw from onStop or onLaneEnd, ends the run
     at once and rejects; no lane sends another batch after it.
   - Before an action of more than one round starts, the app says that
     Qivo must stay open (KEEP_OPEN): closing or reloading stops it, the
     steps already done stay done, and nothing resumes it.

   It imports nothing from the store, so node tests drive it with fakes
   (src/lib/batchRunner.test.ts).

   The audit of the other app actions that send several writes (4 to 6
   November 2026, every store method and every view and panel loop that
   sends writes):

   - The Inbox's message actions on one item's messages (markMessagesRead,
     markMessagesUnread, deleteMessages, snoozeMessages) send one call per
     organization of the loaded messages together: one round.
   - The Roadmap's Auto-move sends one roadmap.change of up to 1,000
     operations, atomic, while the Roadmap visit records changes
     (batchRoadmapChanges). Without a recording visit, after an undo
     conflict, the 24-hour expiry, a disabled visit or with a task window
     open, recordRoadmapChange answers null and each move goes as its own
     issues.update, all at once, with no keep-open notice; a later stage
     sends that fallback as roadmap.change batches or refuses Auto-move
     without a recording visit.
   - The Roadmap's planning confirm sends the few writes of one task's
     plan together: one round.
   - Several files attached to a task, images put into a description and
     background images imported go one upload after another, each its own
     ticket, upload and confirm with its own uploading row or progress
     line and outcome, at most LIMITS.attachments a task. Each file is an
     action of its own, outside this rule.
   - An upload's ticket and confirm, a background (uploadAppearanceImage)
     and a profile picture (setAvatar), are two calls of one upload, an
     action of fixed steps.
   - The organization export is a server job, the owner's exception.
   - The operator console (src/admin/) sends single calls. */

/** The most lanes of large actions the app runs at once, so it has at
    most this many writes of large actions in flight in all. */
export const LANES_AT_ONCE = 2

/** What every keep-open notice ends with (limits plan, "Large actions"). */
export const KEEP_OPEN =
  'Keep Qivo open until it finishes. Closing or reloading Qivo stops it, and the steps already done stay done.'

/**
 * How many rounds lanes of these numbers of calls take at `atOnce` lanes
 * at once, the longest lanes first, each lane going to the first free
 * place. More than one asks the person to keep Qivo open.
 */
export function roundsOf(calls: readonly number[], atOnce = LANES_AT_ONCE): number {
  const places = Array.from({ length: Math.max(1, atOnce) }, () => 0)
  for (const n of [...calls].sort((a, b) => b - a)) {
    const least = places.indexOf(Math.min(...places))
    places[least] += n
  }
  return Math.max(...places)
}

/** Where lanes take their turn. At most `size` lanes run at once, and a
    lane that waits starts once one ends, the first to wait first. `take`
    answers the way to give the place back, at once while one is free, so
    the first batch goes out in the same turn, else once one frees. A wait
    that `cancel` aborts leaves the queue and answers null, holding no
    place. */
export type LanePool = {
  take: (cancel?: AbortSignal) => (() => void) | Promise<(() => void) | null>
}

/** A pool of `size` places (LanePool). */
export function lanePool(size = LANES_AT_ONCE): LanePool {
  let busy = 0
  const waiting: (() => void)[] = []
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else busy -= 1
  }
  const ticket = () => {
    let given = false
    return () => {
      if (given) return
      given = true
      release()
    }
  }
  return {
    take(cancel) {
      if (cancel?.aborted) return Promise.resolve(null)
      if (busy < size) {
        busy += 1
        return ticket()
      }
      return new Promise((resolve) => {
        const wake = () => {
          cancel?.removeEventListener('abort', leave)
          resolve(ticket())
        }
        const leave = () => {
          const at = waiting.indexOf(wake)
          if (at >= 0) waiting.splice(at, 1)
          resolve(null)
        }
        waiting.push(wake)
        cancel?.addEventListener('abort', leave, { once: true })
      })
    },
  }
}

/** The pool every large action shares (LANES_AT_ONCE places). */
export const LANE_POOL = lanePool()

/** A lane a refusal stopped, with the refusal's sentence and whether it
    was the pause, which stops every lane. */
export type LaneStop<Lane> = Readonly<{ lane: Lane; reason: string; paused: boolean }>

/** What runLanes asks of its caller. */
export type LaneRun<Lane, Answer> = {
  lanes: readonly Lane[]
  /** where the lanes take their turn: LANE_POOL for a large action, a
      pool of LANES_AT_ONCE for this run alone when left out */
  pool?: LanePool
  /** whether the run still counts; false ends it quietly */
  live: () => boolean
  /** sends lane `lane`'s next batch after its answer `previous` (null
      before the first) */
  send: (lane: Lane, previous: Answer | null) => Promise<Answer>
  /** whether the lane has another batch after `answer` */
  more: (lane: Lane, answer: Answer) => boolean
  /** the pause's sentence when `error` is the pause, else null */
  pauseOf: (error: unknown) => string | null
  /** the sentence of refusal `error` */
  reasonOf: (error: unknown) => string
  /** hears each answer; a throw here counts as the lane's refusal */
  onAnswer?: (lane: Lane, answer: Answer) => void
  /** hears each stop; a throw here is a fault */
  onStop?: (stop: LaneStop<Lane>) => void
  /** hears each lane end, `last` for the lane that ended last; a throw
      here is a fault */
  onLaneEnd?: (lane: Lane, last: boolean) => void
}

/**
 * Runs each lane's batches one after another, at most the pool's places
 * of lanes at once. A refusal stops its lane; the pause stops every lane
 * before its next batch, the queued ones before they send and without a
 * place, so a paused run never waits for one. Answers the
 * lanes that finished and the stops, or null once `live` turns false,
 * after which no callback runs. A throw from send, onAnswer or more is
 * that lane's refusal; one from pauseOf, reasonOf, onStop or onLaneEnd is
 * a fault, which rejects the run at once, and no lane sends or hears
 * anything after it.
 */
export async function runLanes<Lane, Answer>(
  o: LaneRun<Lane, Answer>,
): Promise<{ finished: Lane[]; stops: LaneStop<Lane>[] } | null> {
  const pool = o.pool ?? lanePool()
  const queue = [...o.lanes]
  const finished: Lane[] = []
  const stops: LaneStop<Lane>[] = []
  // the pause's sentence once a batch met it, which stops every lane
  // before its next batch
  let paused: string | null = null
  // aborted at the pause, so a lane that waits for a shared place leaves
  // the queue and stops without one
  const pausing = new AbortController()
  let faulted = false
  let running = queue.length
  const alive = () => !faulted && o.live()
  /** Runs `step`, a callback whose throw is a fault. */
  const guard = <T>(step: () => T): T => {
    try {
      return step()
    } catch (fault) {
      faulted = true
      throw fault
    }
  }
  const stop = (lane: Lane, reason: string, pause: boolean) => {
    const at: LaneStop<Lane> = { lane, reason, paused: pause }
    stops.push(at)
    guard(() => o.onStop?.(at))
  }

  async function runLane(lane: Lane) {
    let previous: Answer | null = null
    try {
      for (;;) {
        if (!alive()) return
        if (paused !== null) return stop(lane, paused, true)
        let step: { ended: boolean } | { error: unknown }
        try {
          previous = await o.send(lane, previous)
          if (!alive()) return
          o.onAnswer?.(lane, previous)
          step = { ended: !o.more(lane, previous) }
        } catch (error) {
          step = { error }
        }
        if ('error' in step) {
          if (!alive()) return
          const { error } = step
          const pause = guard(() => o.pauseOf(error))
          if (pause !== null && paused === null) {
            paused = pause
            pausing.abort()
          }
          return stop(lane, pause ?? guard(() => o.reasonOf(error)), pause !== null)
        }
        if (step.ended) {
          finished.push(lane)
          return
        }
      }
    } finally {
      running -= 1
      if (alive()) guard(() => o.onLaneEnd?.(lane, running === 0))
    }
  }

  // A worker takes its lane before it waits for a place, so no worker
  // waits in a shared pool with nothing left to run, which would keep
  // the run from ending until another action's lane ends. After the
  // pause a lane takes no place, also one that waited for a place when
  // the pause came, and stops without sending.
  const worker = async () => {
    for (let lane = queue.shift(); lane !== undefined && alive(); lane = queue.shift()) {
      const taken = paused === null ? pool.take(pausing.signal) : null
      const release = taken === null || typeof taken === 'function' ? taken : await taken
      try {
        if (!alive()) return
        await runLane(lane)
      } finally {
        release?.()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LANES_AT_ONCE, queue.length) }, worker))
  return o.live() ? { finished, stops } : null
}
