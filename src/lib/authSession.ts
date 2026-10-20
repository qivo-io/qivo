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

/** Whether an HTTP status means the auth service could not answer right now,
    as opposed to an answer about the session. */
const isTransient = (status: number) => status >= 500 || status === 408 || status === 429

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
      own jar. Null is the server's answer that there is no session (401).
      UNANSWERED is a failed or timed-out fetch, or a service fault. */
  async function requestToken(): Promise<string | null | typeof UNANSWERED> {
    try {
      const { data, error } = await authClient.convex.token({
        fetchOptions: { throw: false, timeout: REQUEST_TIMEOUT_MS },
      })
      if (error) return isTransient(error.status) ? UNANSWERED : null
      return data?.token ?? null
    } catch {
      return UNANSWERED
    }
  }

  /* The one retry loop every caller shares while /convex/token gives no
     answer, so an outage costs one request per backoff step. `wakeRetry`
     ends its current wait. */
  let retrying: Promise<string | null> | null = null
  let wakeRetry: (() => void) | null = null

  /** Asks again with backoff until the service answers, for as long as
      Convex holds a token. A sign-out clears the token and ends the loop. */
  function retryToken(): Promise<string | null> {
    retrying ??= (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          await retryPause(attempt, (wake) => {
            wakeRetry = wake
          })
          wakeRetry = null
          if (!client.client.hasAuth()) return null
          const answer = await requestToken()
          if (answer !== UNANSWERED) return answer
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
     stops the socket and asks here again. An arm's first fetch answers at
     once, and so does every fetch at boot, which has no token to keep, so a
     page that cannot reach the service says so instead of loading for good. */
  const fetchConvexToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    // Convex asks again after the server refused the old token, so the
    // server is reachable again: the loop asks at once
    if (forceRefreshToken && retrying) {
      wakeRetry?.()
      return retrying
    }
    const answer = await requestToken()
    if (answer !== UNANSWERED) return answer
    if (!forceRefreshToken || !client.client.hasAuth()) return null
    return retryToken()
  }

  /** Asks whether this page's session still exists, from the server rather
      than the session cache. Retries with backoff while the service gives
      no answer, because offline is no answer about the session. Undefined
      when a newer arm or a sign-out took over meanwhile. */
  async function sessionLasts(generation: number): Promise<boolean | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data, error } = await authClient.getSession({
          query: { disableCookieCache: true },
          fetchOptions: { timeout: REQUEST_TIMEOUT_MS },
        })
        if (generation !== armGeneration) return undefined
        if (!error) return !!data?.session
        if (!isTransient(error.status)) return false
      } catch {
        if (generation !== armGeneration) return undefined
      }
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
    return new Promise((resolve) => {
      let settled = false
      client.setAuth(fetchConvexToken, (isAuthenticated) => {
        if (!settled) {
          settled = true
          resolve(isAuthenticated)
        } else if (!isAuthenticated) void recover(generation, onLost)
      })
    })
  }

  /** Convex dropped the sign-in after its first answer and does not try
      again. Arms the socket again while the session lasts, and reports
      `onLost` once the session is gone or MAX_REARMS arms in a row fail. */
  async function recover(generation: number, onLost?: () => void) {
    for (let rearm = 0; rearm < MAX_REARMS; rearm++) {
      if (rearm) await retryPause(rearm)
      const lasts = await sessionLasts(generation)
      if (lasts === undefined) return
      if (!lasts) break
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
   * server kept refusing new tokens. The page must then sign in again. */
  function armConvexAuth(onLost?: () => void): Promise<boolean> {
    return connect(++armGeneration, onLost)
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
