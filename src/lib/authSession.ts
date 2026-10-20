import type { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { createAuthClient } from 'better-auth/client'
import { anonymousClient } from 'better-auth/client/plugins'
import type { ConvexClient } from 'convex/browser'
import { convexSiteUrl } from './backendUrl'

/** The first wait between auth retries. Each wait doubles, up to RETRY_MAX_MS. */
const RETRY_FIRST_MS = 1_000
const RETRY_MAX_MS = 30_000
/** How long one auth request may take before it counts as unanswered. */
const REQUEST_TIMEOUT_MS = 15_000
/** Re-arms in a row that may fail while the session lasts before the sign-in
    counts as lost. Stops a server that refuses every token from looping. */
const MAX_REARMS = 3

/** What an auth request gets when the service gave no answer. */
const UNANSWERED = Symbol('unanswered')

/** Whether an HTTP status is the auth service's answer that the session does
    not exist or may not be used. Any other failure, such as a fault, a rate
    limit or a proxy's 404, is no answer about the session. */
const refusesSession = (status: number) => status === 401 || status === 403

/** Whether a thrown request failed in the browser itself, such as storage
    that is full, rather than on the network. Fetch reports a network failure
    as a TypeError and a timeout as an abort, and a captive portal's page is
    not the JSON the service answers with. */
const failedInBrowser = (error: unknown) =>
  error instanceof DOMException &&
  !['AbortError', 'TimeoutError', 'NetworkError'].includes(error.name)

/** Waits out retry `attempt`'s backoff, with jitter so many pages do not
    retry together. Ends early when the browser reports it is back online,
    or when the caller calls the `wake` it hands to `onWait`. */
function retryPause(attempt: number, onWait?: (wake: () => void) => void): Promise<void> {
  const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** attempt) * (0.75 + Math.random() / 2)
  const events = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      if (events) window.removeEventListener('online', done)
      resolve()
    }
    const timer = setTimeout(done, delay)
    if (events) window.addEventListener('online', done)
    onWait?.(done)
  })
}

/* Each entry point creates its own session. The cross-domain plugin stores
 * its cookie jar and session cache under this prefix, sends only that jar in
 * Better-Auth-Cookie, and omits ambient browser cookies. App/admin pages can
 * therefore use independent sessions against the same account database. */
export function createAuthSession(
  storagePrefix: string,
  client: ConvexClient,
  oauthPlugin?: ReturnType<typeof oauthProviderClient>,
  anonymous = false,
) {
  const authClient = createAuthClient({
    // Better Auth treats a URL containing a path as the complete auth root.
    // Include /api/auth explicitly so the local proxy prefix is preserved.
    baseURL: `${convexSiteUrl().replace(/\/$/, '')}/api/auth`,
    plugins: [
      convexClient(),
      ...(anonymous ? [anonymousClient()] : []),
      ...(oauthPlugin ? [oauthPlugin] : []),
      crossDomainClient({ storagePrefix }),
    ],
  })

  /** Asks /convex/token once for a fresh 15-minute JWT from this session's
      own jar. Null is the server's answer that there is no session (401 or
      403), or a failure in the browser itself. UNANSWERED is anything else
      that brought no token: a failed or timed-out fetch, a service fault,
      or a page that is not the service's answer. */
  async function requestToken(): Promise<string | null | typeof UNANSWERED> {
    try {
      const { data, error } = await authClient.convex.token({
        fetchOptions: { throw: false, timeout: REQUEST_TIMEOUT_MS },
      })
      if (error) return refusesSession(error.status) ? null : UNANSWERED
      return typeof data?.token === 'string' ? data.token : UNANSWERED
    } catch (error) {
      return failedInBrowser(error) ? null : UNANSWERED
    }
  }

  /* The one retry loop every caller shares while /convex/token gives no
     answer, so an outage costs one request per backoff step. `wakeRetry`
     ends its current wait. */
  let retrying: Promise<string | null> | null = null
  let wakeRetry: (() => void) | null = null
  /* Whether an arm waits for Convex's first answer. Its fetches answer at
     once, so a page that cannot reach the service says so instead of
     loading for good, even while Convex still holds an older token. */
  let arming = false
  /* A token recover() already got, for the first fetch of the arm it starts. */
  let primed: string | null = null

  /** Asks again with backoff until the service answers, for as long as
      Convex holds a token. A sign-out clears the token, and a newer arm or
      sign-out starts a new generation; either ends the loop with null. */
  function retryToken(): Promise<string | null> {
    const generation = armGeneration
    retrying ??= (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          await retryPause(attempt, (wake) => {
            wakeRetry = wake
          })
          wakeRetry = null
          if (generation !== armGeneration || !client.client.hasAuth()) return null
          const answer = await requestToken()
          if (answer !== UNANSWERED) return answer
          if (generation !== armGeneration) return null
        }
      } finally {
        retrying = null
      }
    })()
    return retrying
  }

  /* Convex's token fetcher. Null tells Convex the sign-in ended, and Convex
     then clears it for good, so a network failure must never answer null
     while there is a sign-in to keep. A refresh (forceRefreshToken) while
     Convex holds a token waits for a real answer instead. The old token
     stays in place meanwhile, and a write that reaches the server after it
     expires gets an auth error and waits in Convex's queue while Convex
     stops the socket and asks here again. Every fetch of an arm (arming)
     answers at once, and so does every fetch at boot, which has no token to
     keep. */
  const fetchConvexToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    if (!forceRefreshToken && primed) {
      const token = primed
      primed = null
      return token
    }
    // Convex asks again after the server refused the old token, so the
    // server is reachable again: the loop asks at once
    if (forceRefreshToken && retrying && !arming) {
      wakeRetry?.()
      return retrying
    }
    const answer = await requestToken()
    if (answer !== UNANSWERED) return answer
    if (!forceRefreshToken || arming || !client.client.hasAuth()) return null
    return retryToken()
  }

  /** Asks the server, not the session cache, whether this page's session
      still exists. False and UNANSWERED as null and UNANSWERED in
      requestToken. */
  async function requestSession(): Promise<boolean | typeof UNANSWERED> {
    try {
      const { data, error } = await authClient.getSession({
        query: { disableCookieCache: true },
        fetchOptions: { timeout: REQUEST_TIMEOUT_MS },
      })
      if (!error) return !!data?.session
      return refusesSession(error.status) ? false : UNANSWERED
    } catch (error) {
      return failedInBrowser(error) ? false : UNANSWERED
    }
  }

  /** Asks with `ask` until the service answers, with backoff between tries,
      because offline is no answer about the session. Undefined when a newer
      arm or a sign-out took over meanwhile. */
  async function untilAnswered<T>(
    generation: number,
    ask: () => Promise<T | typeof UNANSWERED>,
  ): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      const answer = await ask()
      if (generation !== armGeneration) return undefined
      if (answer !== UNANSWERED) return answer
      await retryPause(attempt)
      if (generation !== armGeneration) return undefined
    }
  }

  /* Each arm and sign-out starts a new generation, so a recovery still
     running for an older one stops instead of arming over it. */
  let armGeneration = 0

  /** Installs the token fetcher on the socket. Resolves with Convex's first
      answer, and recovers a sign-in Convex drops after that. */
  function connect(generation: number, onLost?: () => void): Promise<boolean> {
    arming = true
    return new Promise((resolve) => {
      let settled = false
      client.setAuth(fetchConvexToken, (isAuthenticated) => {
        if (!settled) {
          settled = true
          arming = false
          resolve(isAuthenticated)
        } else if (!isAuthenticated) void recover(generation, onLost)
      })
    })
  }

  /** Convex dropped the sign-in after its first answer and does not try
      again. Arms the socket again while the session lasts, and reports
      `onLost` once the session is gone or MAX_REARMS arms in a row fail.
      It waits for both the session and a token to be answered first, since
      an arm with no token to keep fails at once without one, so an outage
      of either service never counts as a failed arm. */
  async function recover(generation: number, onLost?: () => void) {
    for (let rearm = 0; rearm < MAX_REARMS; rearm++) {
      if (rearm) await retryPause(rearm)
      if (generation !== armGeneration) return
      const lasts = await untilAnswered(generation, requestSession)
      if (lasts === undefined) return
      if (!lasts) break
      const token = await untilAnswered(generation, requestToken)
      if (token === undefined) return
      if (token === null) break
      // the arm's first fetch uses it, so a flaky service cannot fail the arm
      primed = token
      const armed = await connect(generation, onLost)
      if (generation !== armGeneration || armed) return
    }
    if (generation === armGeneration) onLost?.()
  }

  /* The app, operator and demo gates call this once they have established a
   * session, before issuing authenticated operations. Arming during module
   * import would request a token before that session check (or before sign-in)
   * and then immediately repeat the request here. Convex owns token refresh
   * after this callback is installed. Resolves with the first answer.
   * A sign-in Convex drops later is armed again while the session lasts.
   * `onLost` runs when that fails: the session ended on the server, or the
   * server kept refusing new tokens. The page must then sign in again.
   * A refresh still waiting in the retry loop ends first, as failed. Convex
   * may have stopped the socket for it, and only that refresh restarts the
   * socket once Convex has its answer, so the arm waits for that. Resolves
   * false when a newer arm or a sign-out takes over meanwhile. */
  async function armConvexAuth(onLost?: () => void): Promise<boolean> {
    const generation = ++armGeneration
    primed = null
    const pending = retrying
    if (pending) {
      wakeRetry?.()
      await pending
      // Convex handles the answer in later microtasks
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (generation !== armGeneration) return false
    }
    return connect(generation, onLost)
  }

  // The plugin clears only this prefix; the server revokes only its session.
  // Callers reload afterward, re-arming this page's socket on the next mount.
  async function signOut(): Promise<void> {
    armGeneration++
    try {
      await authClient.signOut()
    } finally {
      client.client.clearAuth()
    }
  }

  // Expiry is enforced on the server. This removes the local credential even
  // when an offline browser cannot complete a sign-out request.
  function clearLocalSession() {
    armGeneration++
    client.client.clearAuth()
    for (const suffix of ['_cookie', '_session_data']) {
      try {
        localStorage.removeItem(`${storagePrefix}${suffix}`)
      } catch {
        // The browser can deny storage access in a private context.
      }
    }
  }

  return { authClient, armConvexAuth, signOut, clearLocalSession }
}
