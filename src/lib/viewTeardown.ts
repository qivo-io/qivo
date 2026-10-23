import { createContext, useContext, useLayoutEffect, useReducer } from 'react'
import { postMessageTask } from './postTask'

/* Takes apart a kept view that left (components/KeptView.tsx) a slice at
   a time. React deletes a view's components in one commit, and a Board of
   10,000 tasks holds about 300,000 of them on 130,000 elements, so deleting
   it whole blocks input for more than half a second on a slow machine, most
   of it the browser removing the elements. The view stays in the page,
   hidden, and once the next view has painted its parts (DeferredList
   blocks) unmount a few at a time, each slice in a commit of its own, and
   the rest goes with the view at the end.

   The view is hidden in React's Activity, which renders its updates only
   when nothing else waits, after the task that made them. So a slice asks
   its parts to unmount and the next slice waits for the commit that removed
   them (`committed`, which the view watches its elements for). */

/** The parts one slice unmounts: at 16 cards a Board block, four blocks
    take a few milliseconds to remove at 4x CPU slowdown. */
const SLICE = 4
/** How long a slice waits for its commit before the next one: parts that
    unmounted on their own while hidden make no commit. */
const COMMIT_WAIT_MS = 500

type Options = {
  /** runs a task soon, without the clamping nested timers get */
  post?: (task: () => void) => void
  /** runs a callback once the next frame has painted */
  painted?: (callback: () => void) => void
  /** runs a callback after `ms` */
  later?: (callback: () => void, ms: number) => () => void
}

const afterPaint = (callback: () => void) => requestAnimationFrame(() => postMessageTask(callback))
const afterMs = (callback: () => void, ms: number) => {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

/** A kept view's teardown. Its parts register how they unmount; `leave`
    unmounts them in slices once the next frame has painted and calls
    `done` when none is left. */
export function createTeardown({
  post = postMessageTask,
  painted = afterPaint,
  later = afterMs,
}: Options = {}) {
  const parts = new Set<() => void>()
  let holding = false
  let commit: (() => void) | null = null
  return {
    /** Registers `drop`, which unmounts a part, and answers its removal.
        While `hold` is on, as Activity hides the view and runs every
        effect's cleanup, removals keep the part: a hidden part must still
        be found when the view leaves. A part that unmounts while hidden
        stays registered, and its drop does nothing. */
    part(drop: () => void) {
      parts.add(drop)
      return () => {
        if (!holding) parts.delete(drop)
      }
    },
    /** Turns on or off the keeping of parts that `part` describes. */
    hold(on: boolean) {
      holding = on
    },
    /** Tells a waiting slice that a commit changed the view. */
    committed() {
      const next = commit
      commit = null
      next?.()
    },
    /** Starts taking the view apart; answers a function that stops it. */
    leave(done: () => void) {
      let stopped = false
      let stopWaiting = () => {}
      const slice = () => {
        if (stopped) return
        if (!parts.size) {
          done()
          return
        }
        const batch = [...parts].slice(0, SLICE)
        for (const drop of batch) {
          parts.delete(drop)
          drop()
        }
        // on to the next slice in a task after the commit, or after a wait
        const next = () => {
          stopWaiting()
          commit = null
          post(slice)
        }
        commit = next
        stopWaiting = later(next, COMMIT_WAIT_MS)
      }
      painted(slice)
      return () => {
        stopped = true
        commit = null
        stopWaiting()
      }
    },
  }
}

export type Teardown = ReturnType<typeof createTeardown>

/** The teardown of the kept view the calling component is in, if any. */
export const TeardownContext = createContext<Teardown | null>(null)

/** Whether the kept view this part is in dropped it while leaving. A part
    that calls it renders nothing once it is dropped. */
export function useDropped() {
  const teardown = useContext(TeardownContext)
  // `drop` keeps its identity, so showing the view again registers it once
  const [dropped, drop] = useReducer(() => true, false)
  useLayoutEffect(() => teardown?.part(drop), [teardown])
  return dropped
}
