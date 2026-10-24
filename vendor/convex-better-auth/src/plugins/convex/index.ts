/* Copied from get-convex/better-auth src/plugins/convex/index.ts at 3f41cbcf
 * (Apache-2.0, see ../../../LICENSE). Qivo changed it:
 * - Better Auth 1.7 removed the oidc-provider plugin, so the plugin no longer
 *   builds one. Its after hooks and the /convex/.well-known/openid-configuration
 *   endpoint are gone. Convex reads the keys from /convex/jwks
 *   (auth-config.ts), and the JWT is signed as before.
 * - The JWT cookie hook calls the token endpoint with empty Headers, not an
 *   empty object, which Better Auth 1.7 reads with get().
 * - The query-context hook also turns consumeOne and incrementOne into no-ops,
 *   as get-convex/better-auth#430 does, since 1.7 calls them more often.
 * - The static JWKS option, the deprecated jwtExpirationSeconds, the basePath
 *   checks, the key rotation endpoints (/convex/latest-jwks,
 *   /convex/rotate-keys), the automatic key rotation on a token error and the
 *   OpenAPI descriptions are left out. Qivo uses none of them. */
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api'
import { bearer as bearerPlugin } from 'better-auth/plugins/bearer'
import type { Jwk, JwtOptions } from 'better-auth/plugins/jwt'
import { jwt as jwtPlugin } from 'better-auth/plugins/jwt'
import type { AuthConfig, AuthProvider } from 'convex/server'
import { omit } from 'convex-helpers'
import { VERSION } from '../../version'

export const JWT_COOKIE_NAME = 'convex_jwt'

type DefinePayload = NonNullable<NonNullable<JwtOptions['jwt']>['definePayload']>

const getJwksAlg = (authProvider: AuthProvider) => {
  const isCustomJwt = 'type' in authProvider && authProvider.type === 'customJwt'
  if (isCustomJwt && authProvider.algorithm !== 'RS256') {
    throw new Error('Only RS256 is supported for custom JWT with Better Auth')
  }
  return isCustomJwt ? authProvider.algorithm : 'EdDSA'
}

const parseAuthConfig = (authConfig: AuthConfig) => {
  const providerConfigs = authConfig.providers.filter(
    (provider) => provider.applicationID === 'convex',
  )
  if (providerConfigs.length > 1) {
    throw new Error(
      "Multiple auth providers with applicationID 'convex' detected. Please use only one.",
    )
  }
  const providerConfig = providerConfigs[0]
  if (!providerConfig) {
    throw new Error(
      "No auth provider with applicationID 'convex' found. Please add one to your auth config.",
    )
  }
  return providerConfig
}

/** The Better Auth plugin that signs the JWTs Convex checks, serves their
 * keys at /convex/jwks and a fresh token at /convex/token, and keeps the
 * convex_jwt cookie in step with sign-in and sign-out. */
export const convex = (opts: {
  /** The Convex auth config, usually convex/auth.config.ts. */
  authConfig: AuthConfig
  jwt?: {
    /** How long a JWT lasts. 15 minutes when unset. */
    expirationSeconds?: number
    /** The JWT's claims. `sessionId` and `iat` are added to them. */
    definePayload?: DefinePayload
  }
}) => {
  const jwtExpirationSeconds = opts.jwt?.expirationSeconds ?? 60 * 15
  const providerConfig = parseAuthConfig(opts.authConfig)

  const jwtOptions = {
    jwt: {
      issuer: `${process.env.CONVEX_SITE_URL}`,
      audience: 'convex',
      expirationTime: `${jwtExpirationSeconds}s`,
      definePayload: async ({ user, session }) => ({
        ...(opts.jwt?.definePayload
          ? await opts.jwt.definePayload({ user, session })
          : omit(user, ['id', 'image'])),
        sessionId: session.id,
        iat: Math.floor(Date.now() / 1000),
      }),
    },
    jwks: { keyPairConfig: { alg: getJwksAlg(providerConfig) } },
  } satisfies JwtOptions
  const jwt = jwtPlugin({
    ...jwtOptions,
    adapter: {
      // Stores createdAt as a date and reads the stored numbers back as dates.
      createJwk: async (webKey, ctx) =>
        await ctx.context.adapter.create<Omit<Jwk, 'id'>, Jwk>({
          model: 'jwks',
          data: { ...webKey, createdAt: new Date() },
        }),
      getJwks: async (ctx) => {
        const keys = await ctx.context.adapter.findMany<Jwk>({
          model: 'jwks',
          sortBy: { field: 'createdAt', direction: 'desc' },
        })
        return keys.map((key) => ({
          ...key,
          createdAt: new Date(key.createdAt),
          ...(key.expiresAt ? { expiresAt: new Date(key.expiresAt) } : {}),
        }))
      },
    },
  })
  // The bearer plugin turns the session token into a cookie, which
  // cross-domain social sign-in needs after the code is verified.
  const bearer = bearerPlugin()
  const schema = {
    user: { fields: { userId: { type: 'string', required: false, input: false } } } as const,
    ...jwt.schema,
  }

  return {
    id: 'convex',
    version: VERSION,
    hooks: {
      before: [
        ...bearer.hooks.before,
        // In a query context no write can succeed. Turn the adapter's writes
        // and session refresh into no-ops, so fire-and-forget side effects in
        // Better Auth, such as session cleanup, do not fail the request.
        {
          matcher: (ctx) => !ctx.context.adapter.options?.isRunMutationCtx,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.query = { ...(ctx.query as Record<string, unknown>), disableRefresh: true }
            ctx.context.internalAdapter.deleteSession = async () => {}
            const skipWrite = (method: string) => {
              if (ctx.path) {
                console.warn(
                  `[convex-better-auth] Write operation "${method}" skipped in query context for ${ctx.path}`,
                )
              }
            }
            const adapter = ctx.context.adapter
            adapter.create = async () => {
              skipWrite('create')
              return 0 as never
            }
            adapter.update = async () => {
              skipWrite('update')
              return 0 as never
            }
            adapter.updateMany = async () => {
              skipWrite('updateMany')
              return 0
            }
            adapter.delete = async () => {
              skipWrite('delete')
            }
            adapter.deleteMany = async () => {
              skipWrite('deleteMany')
              return 0
            }
            adapter.consumeOne = async () => {
              skipWrite('consumeOne')
              return null
            }
            adapter.incrementOne = async () => {
              skipWrite('incrementOne')
              return null
            }
            return { context: ctx }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            Boolean(
              ctx.path?.startsWith('/sign-in') ||
                ctx.path?.startsWith('/sign-up') ||
                ctx.path?.startsWith('/callback') ||
                ctx.path?.startsWith('/oauth2/callback') ||
                ctx.path?.startsWith('/magic-link/verify') ||
                ctx.path?.startsWith('/email-otp/verify-email') ||
                ctx.path?.startsWith('/phone-number/verify') ||
                ctx.path?.startsWith('/siwe/verify') ||
                ctx.path?.startsWith('/update-session') ||
                (ctx.path?.startsWith('/get-session') && ctx.context.session),
            ),
          handler: createAuthMiddleware(async (ctx) => {
            // Sets the JWT cookie at sign-in, for server-side rendering.
            const originalSession = ctx.context.session
            try {
              ctx.context.session = ctx.context.session ?? ctx.context.newSession
              const { token } = await jwt.endpoints.getToken({
                ...ctx,
                // Better Auth 1.7 reads these with get(), so not a plain object.
                headers: new Headers(),
                body: undefined,
                method: 'GET',
                asResponse: false,
                returnHeaders: false,
                returnStatus: false,
              })
              const jwtCookie = ctx.context.createAuthCookie(JWT_COOKIE_NAME, {
                maxAge: jwtExpirationSeconds,
              })
              ctx.setCookie(jwtCookie.name, token, jwtCookie.attributes)
            } catch {
              // Some sign-in calls answer 401 here, such as one that goes on
              // to a second factor.
            }
            ctx.context.session = originalSession
          }),
        },
        {
          matcher: (ctx) =>
            Boolean(
              ctx.path?.startsWith('/sign-out') ||
                ctx.path?.startsWith('/delete-user') ||
                (ctx.path?.startsWith('/get-session') && !ctx.context.session),
            ),
          handler: createAuthMiddleware(async (ctx) => {
            const jwtCookie = ctx.context.createAuthCookie(JWT_COOKIE_NAME, { maxAge: 0 })
            ctx.setCookie(jwtCookie.name, '', jwtCookie.attributes)
          }),
        },
      ],
    },
    endpoints: {
      getJwks: createAuthEndpoint('/convex/jwks', { method: 'GET' }, async (ctx) =>
        jwt.endpoints.getJwks({
          ...ctx,
          asResponse: false,
          returnHeaders: false,
          returnStatus: false,
        }),
      ),
      getToken: createAuthEndpoint(
        '/convex/token',
        { method: 'GET', requireHeaders: true, use: [sessionMiddleware] },
        async (ctx) => {
          const response = await jwt.endpoints.getToken({
            ...ctx,
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
          })
          const jwtCookie = ctx.context.createAuthCookie(JWT_COOKIE_NAME, {
            maxAge: jwtExpirationSeconds,
          })
          ctx.setCookie(jwtCookie.name, response.token, jwtCookie.attributes)
          return response
        },
      ),
    },
    schema,
  } satisfies BetterAuthPlugin
}
