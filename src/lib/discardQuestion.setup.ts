/* For tests of a close that may ask first (discardQuestion.ts closeOrAsk). */

/** Resolves once the timers a close set before this call, and the ones
    those set, have run, and at least 10 ms have passed. closeOrAsk asks
    two 0 ms timers later (afterRenders). Timers of the same delay run in
    the order they were set, so three rounds of them end after its two
    however late a busy machine runs the first round. A fixed wait alone
    loses that race: the close's second timer can then fall due after it. */
export function pastCloseTicks(): Promise<unknown> {
  const rounds = new Promise((resolve) =>
    setTimeout(() => setTimeout(() => setTimeout(resolve, 0), 0), 0),
  )
  return Promise.all([rounds, new Promise((resolve) => setTimeout(resolve, 10))])
}
