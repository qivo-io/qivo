/* A change to the page between a pointer's press and its release moves what
   was under the pointer, so the release lands elsewhere and the click misses
   the control the person pressed. Work that a press sets off, such as the
   save of a field the press takes focus from, waits for the release here. */

/** How long work waits for a release, for one that never arrives, as where
    the window lost the pointer while it was pressed. */
export const RELEASE_WAIT_MS = 1000

const pressed = new Set<number>()
const waiting: (() => void)[] = []
let limit: ReturnType<typeof setTimeout> | undefined

function runWaiting() {
  clearTimeout(limit)
  limit = undefined
  for (const work of waiting.splice(0)) work()
}

if (typeof window !== 'undefined') {
  const listen = { capture: true, passive: true }
  window.addEventListener('pointerdown', (e) => pressed.add(e.pointerId), listen)
  for (const end of ['pointerup', 'pointercancel'] as const)
    window.addEventListener(
      end,
      (e) => {
        pressed.delete(e.pointerId)
        // the release's click is dispatched in the same task as the release
        if (pressed.size === 0 && waiting.length > 0) setTimeout(runWaiting)
      },
      listen,
    )
}

/**
 * Runs `work` now where no pointer is pressed, else once every pressed
 * pointer is released and the click of the release has been dispatched,
 * or after RELEASE_WAIT_MS where a release never comes. Work that waits
 * runs whatever became of the component that asked for it.
 */
export function afterPress(work: () => void) {
  if (pressed.size === 0) {
    work()
    return
  }
  waiting.push(work)
  limit ??= setTimeout(() => {
    pressed.clear()
    runWaiting()
  }, RELEASE_WAIT_MS)
}
