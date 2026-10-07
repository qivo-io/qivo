/** Optional, short-lived country attestation. This runs only during an
 * explicitly requested anonymous sign-in; missing telemetry cannot stop it. */
export async function demoVisitorContext(signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted()
  const controller = new AbortController()
  let finish: (context: null) => void = () => undefined
  const fallback = new Promise<null>((resolve) => {
    finish = resolve
  })
  const cancel = () => {
    controller.abort()
    finish(null)
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 1800)
  try {
    return await Promise.race([
      fallback,
      fetch('/api/demo-visitor', {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      })
        .then(async (response) => {
          if (!response.ok) return null
          const body = await response.json()
          return typeof body?.context === 'string' && body.context.length <= 128
            ? body.context
            : null
        })
        .catch(() => null),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
