/* Copied from get-convex/better-auth src/plugins/cross-domain/index.ts at
 * 3f41cbcf (Apache-2.0, see ../../../LICENSE). Changed by Qivo only in
 * formatting and types; the behavior is upstream's. */
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, createAuthMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { generateRandomString } from 'better-auth/crypto'
import { oneTimeToken as oneTimeTokenPlugin } from 'better-auth/plugins/one-time-token'
import { z } from 'zod'
import { VERSION } from '../../version'

/** The Better Auth plugin that lets an app on another origin sign in. The
 * browser keeps the cookies in storage and sends them in a
 * Better-Auth-Cookie header, the server answers with Set-Better-Auth-Cookie,
 * and a provider callback hands the app a one-time token to trade for its
 * session. */
export const crossDomain = ({ siteUrl }: { siteUrl: string }) => {
  const oneTimeToken = oneTimeTokenPlugin()

  const rewriteCallbackURL = (callbackURL?: string) => {
    if (!callbackURL?.startsWith('/')) return callbackURL
    return new URL(callbackURL, siteUrl).toString()
  }

  const isExpoNative = (ctx: { headers?: Headers }) => ctx.headers?.has('expo-origin')

  return {
    id: 'cross-domain',
    version: VERSION,
    // Upstream notes that this does not reach ctx.trustedOrigins. The CORS
    // allowed origins read it through options.trustedOrigins.
    init() {
      return {
        options: { trustedOrigins: [siteUrl] },
        context: {
          oauthConfig: {
            storeStateStrategy: 'database',
            // The state cookie cannot be set on the identity provider's
            // redirect, so a flow started in one browser could go on in
            // another. The state in the query string is still checked
            // against the database.
            skipStateCookieCheck: true,
          },
        },
      }
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            Boolean(
              ctx.request?.headers.has('better-auth-cookie') ||
                ctx.headers?.has('better-auth-cookie'),
            ) && !isExpoNative(ctx),
          handler: createAuthMiddleware(async (ctx) => {
            const existingHeaders = ctx.request?.headers || ctx.headers
            const headers = new Headers(Object.fromEntries(existingHeaders?.entries() ?? []))
            // Skip if the request has an authorization header
            if (headers.get('authorization')) return
            const cookie = headers.get('better-auth-cookie')
            if (!cookie) return
            headers.append('cookie', cookie)
            return { context: { headers } }
          }),
        },
        {
          matcher: (ctx) =>
            Boolean(
              ctx.method === 'GET' && ctx.path?.startsWith('/verify-email') && !isExpoNative(ctx),
            ),
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.query?.callbackURL) {
              ctx.query.callbackURL = rewriteCallbackURL(ctx.query.callbackURL)
            }
            return { context: ctx }
          }),
        },
        {
          matcher: (ctx) => Boolean(ctx.method === 'POST' && !isExpoNative(ctx)),
          handler: createAuthMiddleware(async (ctx) => {
            // Set callbackURL to siteUrl for redirect-triggering paths with
            // no callbackURL defined.
            if (
              ctx.body &&
              !ctx.body.callbackURL &&
              (ctx.path?.startsWith('/sign-in/social') ||
                ctx.path?.startsWith('/sign-in/oauth2') ||
                ctx.path?.startsWith('/sign-in/magic-link') ||
                ctx.path?.startsWith('/send-verification-email'))
            ) {
              ctx.body.callbackURL = siteUrl
            }
            if (ctx.body?.callbackURL)
              ctx.body.callbackURL = rewriteCallbackURL(ctx.body.callbackURL)
            if (ctx.body?.newUserCallbackURL) {
              ctx.body.newUserCallbackURL = rewriteCallbackURL(ctx.body.newUserCallbackURL)
            }
            if (ctx.body?.errorCallbackURL) {
              ctx.body.errorCallbackURL = rewriteCallbackURL(ctx.body.errorCallbackURL)
            }
            return { context: ctx }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            Boolean(
              ctx.request?.headers.has('better-auth-cookie') ||
                ctx.headers?.has('better-auth-cookie'),
            ) && !isExpoNative(ctx),
          handler: createAuthMiddleware(async (ctx) => {
            const setCookie = ctx.context.responseHeaders?.get('set-cookie')
            if (!setCookie) return
            ctx.context.responseHeaders?.delete('set-cookie')
            ctx.setHeader('Set-Better-Auth-Cookie', setCookie)
          }),
        },
        {
          matcher: (ctx) =>
            Boolean(
              (ctx.path?.startsWith('/callback') ||
                ctx.path?.startsWith('/oauth2/callback') ||
                ctx.path?.startsWith('/magic-link/verify')) &&
                !isExpoNative(ctx),
            ),
          handler: createAuthMiddleware(async (ctx) => {
            // Mostly copied from the one-time-token plugin
            const session = ctx.context.newSession
            if (!session) {
              ctx.context.logger.error('No session found')
              return
            }
            const token = generateRandomString(32)
            const expiresAt = new Date(Date.now() + 3 * 60 * 1000)
            await ctx.context.internalAdapter.createVerificationValue({
              value: session.session.token,
              identifier: `one-time-token:${token}`,
              expiresAt,
            })
            const redirectTo = ctx.context.responseHeaders?.get('location')
            if (!redirectTo) {
              ctx.context.logger.error('No redirect to found')
              return
            }
            const url = new URL(redirectTo)
            url.searchParams.set('ott', token)
            throw ctx.redirect(url.toString())
          }),
        },
      ],
    },
    endpoints: {
      verifyOneTimeToken: createAuthEndpoint(
        '/cross-domain/one-time-token/verify',
        { method: 'POST', body: z.object({ token: z.string() }) },
        async (ctx) => {
          const response = await oneTimeToken.endpoints.verifyOneTimeToken({
            ...ctx,
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
          })
          await setSessionCookie(ctx, response)
          return response
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
