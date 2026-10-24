/* Copied from get-convex/better-auth src/plugins/cross-domain/client.ts at
 * 3f41cbcf (Apache-2.0, see ../../../LICENSE). Qivo changed it:
 * - A sign-out clears the stored cookies and session only once the server
 *   answers that it ended the session, and only while they still hold the
 *   session it ended. Upstream clears them before the request, so a
 *   sign-out the server refused left the session alive on the server with
 *   no way to end it from this browser.
 * - Formatting and types: the fetch option type comes from Better Auth's
 *   client plugin type instead of @better-fetch/fetch, which Qivo does not
 *   install directly. */
import type { BetterAuthClientPlugin, ClientStore } from 'better-auth/client'
import { parseSetCookieHeader } from 'better-auth/cookies'
import { VERSION } from '../../version'
import type { crossDomain } from './index'

type FetchPlugin = NonNullable<BetterAuthClientPlugin['fetchPlugins']>[number]
type FetchOptions = NonNullable<Parameters<NonNullable<FetchPlugin['init']>>[1]>

interface StoredCookie {
  value: string
  expires: string | null
}

type CrossDomainActions = {
  getCookie: () => string
  updateSession: () => void
  getSessionData: () => Record<string, unknown> | null
}

type CrossDomainClientPlugin = Omit<BetterAuthClientPlugin, '$InferServerPlugin' | 'getActions'> & {
  $InferServerPlugin: ReturnType<typeof crossDomain>
  getActions: (
    ...args: Parameters<NonNullable<BetterAuthClientPlugin['getActions']>>
  ) => CrossDomainActions
}

/** Merges a Set-Cookie header into the stored cookie JSON. */
export function getSetCookie(header: string, prevCookie?: string) {
  const parsed = parseSetCookieHeader(header)
  let toSetCookie: Record<string, StoredCookie> = {}
  parsed.forEach((cookie, key) => {
    const expiresAt = cookie.expires
    const maxAge = cookie['max-age']
    const expires = expiresAt
      ? new Date(String(expiresAt))
      : maxAge
        ? new Date(Date.now() + Number(maxAge) * 1000)
        : null
    toSetCookie[key] = { value: cookie.value, expires: expires ? expires.toISOString() : null }
  })
  if (prevCookie) {
    try {
      toSetCookie = { ...JSON.parse(prevCookie), ...toSetCookie }
    } catch {
      // A stored value that is not JSON is replaced.
    }
  }
  return JSON.stringify(toSetCookie)
}

/** The session token in a Cookie header value, if it holds one. */
const sessionToken = (cookie: string) => /(?:^|;\s*)[^=;]*session_token=([^;]*)/.exec(cookie)?.[1]

/** The Cookie header value for the stored cookies that have not expired. */
export function getCookie(cookie: string) {
  let parsed: Record<string, StoredCookie> = {}
  try {
    parsed = JSON.parse(cookie) as Record<string, StoredCookie>
  } catch {
    // A stored value that is not JSON holds no cookies.
  }
  return Object.entries(parsed)
    .filter(([, value]) => !value.expires || new Date(value.expires) >= new Date())
    .map(([key, value]) => `${key}=${value.value}`)
    .join('; ')
}

/** The browser side of the crossDomain() plugin. It keeps the cookies in
 * storage (localStorage by default) and sends them with every request. */
export const crossDomainClient = (
  opts: {
    storage?: {
      setItem: (key: string, value: string) => unknown
      getItem: (key: string) => string | null
    }
    storagePrefix?: string
    disableCache?: boolean
  } = {},
): CrossDomainClientPlugin => {
  let store: ClientStore | null = null
  const cookieName = `${opts?.storagePrefix || 'better-auth'}_cookie`
  const localCacheName = `${opts?.storagePrefix || 'better-auth'}_session_data`
  const storage = opts?.storage || (typeof window !== 'undefined' ? localStorage : undefined)

  return {
    id: 'cross-domain',
    version: VERSION,
    $InferServerPlugin: {} as ReturnType<typeof crossDomain>,
    getActions(_, $store) {
      store = $store
      return {
        /** The stored cookies as a Cookie header value. */
        getCookie: () => getCookie(storage?.getItem(cookieName) || '{}'),
        /** Notifies the session signal, as after a new session token is set. */
        updateSession: () => {
          $store.notify('$sessionSignal')
        },
        /** The stored session data, or null when there is none. */
        getSessionData: (): Record<string, unknown> | null => {
          const sessionData = storage?.getItem(localCacheName)
          if (!sessionData) return null
          try {
            const parsed = JSON.parse(sessionData)
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) {
              return null
            }
            return parsed
          } catch {
            return null
          }
        },
      }
    },
    fetchPlugins: [
      {
        id: 'cross-domain',
        name: 'Cross Domain',
        hooks: {
          async onSuccess(context) {
            if (!storage) return
            if (context.request.url.toString().includes('/sign-out')) {
              // A sign-in in another tab while this sign-out ran stored a
              // newer session under the same prefix, which stays.
              const sent = sessionToken(context.request.headers.get('Better-Auth-Cookie') ?? '')
              const stored = sessionToken(getCookie(storage.getItem(cookieName) || '{}'))
              if (stored && stored !== sent) return
              await storage.setItem(cookieName, '{}')
              store?.atoms.session?.set({ data: null, error: null, isPending: false })
              await storage.setItem(localCacheName, '{}')
              return
            }
            const setCookie = context.response.headers.get('set-better-auth-cookie')
            if (setCookie) {
              const prevCookie = storage.getItem(cookieName)
              const toSetCookie = getSetCookie(setCookie || '', prevCookie ?? undefined)
              await storage.setItem(cookieName, toSetCookie)
              // Only notify when the session token value actually changed.
              // max-age recalculation with Date.now() causes the stored
              // cookie JSON to always differ, so comparing values directly
              // prevents infinite get-session polling loops.
              if (setCookie.includes('.session_token=')) {
                const parsed = parseSetCookieHeader(setCookie)
                let prevParsed: Record<string, StoredCookie> = {}
                try {
                  prevParsed = JSON.parse(prevCookie || '{}')
                } catch {
                  // A stored value that is not JSON holds no cookies.
                }
                const tokenKey = [...parsed.keys()].find((k) => k.includes('session_token'))
                if (tokenKey && prevParsed[tokenKey]?.value !== parsed.get(tokenKey)?.value) {
                  store?.notify('$sessionSignal')
                }
              }
            }

            if (context.request.url.toString().includes('/get-session') && !opts?.disableCache) {
              const data = context.data
              storage.setItem(localCacheName, JSON.stringify(data))
              if (data === null) {
                // Keep the cookies that are not the session's, such as a
                // second factor's challenge, when get-session returns null.
                const prev = storage.getItem(cookieName)
                try {
                  const parsed = JSON.parse(prev || '{}') as Record<string, unknown>
                  const preserved: Record<string, unknown> = {}
                  for (const [key, val] of Object.entries(parsed)) {
                    if (
                      !key.includes('session_token') &&
                      !key.includes('session_data') &&
                      !key.includes('convex_jwt')
                    ) {
                      preserved[key] = val
                    }
                  }
                  storage.setItem(cookieName, JSON.stringify(preserved))
                } catch {
                  storage.setItem(cookieName, '{}')
                }
              }
            }
          },
        },
        async init(url, options) {
          if (!storage) return { url, options: options as FetchOptions }
          options = options || {}
          const cookie = getCookie(storage.getItem(cookieName) || '{}')
          options.credentials = 'omit'
          options.headers = { ...options.headers, 'Better-Auth-Cookie': cookie }
          return { url, options: options as FetchOptions }
        },
      },
    ],
  }
}
