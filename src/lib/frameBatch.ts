/* Coalesces work asked for many times into one run a frame, such as the
   store's repaint for profile pictures that become ready one after the
   other: a thousand ready pictures repaint the app once a frame, not a
   thousand times. */

/** Runs a callback at the start of the next frame. */
export type FrameScheduler = (callback: () => void) => void

/* requestAnimationFrame where the page has it, else a timer of about one
   frame, as in node tests and workers. */
const nextFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback())
  else setTimeout(callback, 16)
}

/** Runs `run` once in the frame after the first `schedule()`, however many
    calls follow before it runs. `cancel()` drops a run not yet made. */
export function frameBatch(run: () => void, frame: FrameScheduler = nextFrame) {
  let scheduled = false
  let generation = 0
  return {
    schedule() {
      if (scheduled) return
      scheduled = true
      const mine = generation
      frame(() => {
        if (mine !== generation) return
        scheduled = false
        run()
      })
    },
    cancel() {
      generation++
      scheduled = false
    },
  }
}
