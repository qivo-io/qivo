/** Release the review dialog after a stalled post-approval read. A subscription
 * lets us stop the read on timeout, including when the connection is offline. */
export function readBackgroundReviewQueue<T>(
  subscribe: (receive: (value: T) => void, fail: (error: Error) => void) => () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    const cleanup = () => {
      clearTimeout(timer)
      const stop = unsubscribe
      unsubscribe = undefined
      stop?.()
    }
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      complete()
    }
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error('Loading timed out. Check your connection and try again.'))),
      10_000,
    )
    try {
      unsubscribe = subscribe(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
      // A cached result may arrive while subscribe is still returning its cleanup.
      if (settled) cleanup()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
