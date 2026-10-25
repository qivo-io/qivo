/* Work that waits until the page is idle. Safari has no
   requestIdleCallback, so there the work runs in a timer task a moment
   later, after the frame in between has painted, with a short time of its
   own: the browser cannot tell how long it may take. */

/** What an idle step learns: how long it may still take, in ms. */
export type IdleDeadline = { timeRemaining: () => number }

/** How long the stand-in waits before the step, and how long it lets the
    step take. */
const FALLBACK_WAIT_MS = 50
const FALLBACK_BUDGET_MS = 10

/** Runs `step` once the page is idle, or after `timeout` ms at most where
    the browser can tell, and answers a function that cancels it. Where it
    cannot (Safari), `step` runs FALLBACK_WAIT_MS later with
    FALLBACK_BUDGET_MS to take. */
export function whenIdle(
  step: (deadline: IdleDeadline) => void,
  { timeout }: { timeout?: number } = {},
): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(step, timeout === undefined ? undefined : { timeout })
    return () => cancelIdleCallback(id)
  }
  const timer = setTimeout(() => {
    const end = performance.now() + FALLBACK_BUDGET_MS
    step({ timeRemaining: () => Math.max(0, end - performance.now()) })
  }, FALLBACK_WAIT_MS)
  return () => clearTimeout(timer)
}
