import { type AuthFunctions, createClient, type GenericCtx } from '@convex-dev/better-auth'
import { convex, crossDomain } from '@convex-dev/better-auth/plugins'
import { requireRunMutationCtx } from '@convex-dev/better-auth/utils'
import { type BetterAuthOptions, betterAuth } from 'better-auth/minimal'
import { admin } from 'better-auth/plugins'
import { anonymous } from 'better-auth/plugins/anonymous'
import { makeFunctionReference } from 'convex/server'
import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import authConfig from './auth.config'
import authSchema from './betterAuth/schema'
import {
  clampDemoSession,
  DEMO_TTL_MS,
  demoRefusal,
  expireDeletedDemoUser,
  isDemoDeployment,
  registerDemoUser,
  requireDemoDeployment,
} from './lib/demo'
import { deploymentEnvironment } from './lib/deployment'
import { requireAuthMailDelivery } from './lib/mailConfig'
import { oauthAdapter } from './lib/oauthAdapter'
import { oauthHooks, qivoOAuthProvider, registerOAuthCode } from './lib/oauthProvider'

/* SITE_URL = the APP origin (http://localhost:5199 in dev, https://qivo.io in
 * prod) — NOT the convex.site URL. baseURL is the auto-provided CONVEX_SITE_URL.
 *
 * Read at call time and checked, the way fileTokens.ts reads CONVEX_SITE_URL.
 * It used to be asserted non-null at module scope, which on a deployment
 * missing the var handed `undefined` (typed `string`) to trustedOrigins and to
 * crossDomain's redirect target — every OAuth and reset round trip then fails
 * originCheck with nothing naming the var that is missing. Staying out of
 * module scope also keeps that failure on the auth surface that needs the
 * origin, rather than on every module that imports this one for authComponent
 * alone (identity.ts does exactly that). */
const requireSiteUrl = () => {
  const url = process.env.SITE_URL
  if (!url) throw new Error('SITE_URL is not set — the app origin is unknown')
  return url
}

/* The Better Auth component (convex/betterAuth/) bundles this module and
 * evaluates it during push ANALYSIS — inside the component sandbox, which by
 * design sees NONE of the deployment's environment variables. Its two
 * consumers (adapter.ts's createApi, auth.ts's generate-only instance) only
 * ever read table SHAPES off the options, so they build with this inert
 * placeholder origin instead of refusing the whole push; every instance that
 * actually serves auth (createAuth / createCaptureAuth below) still refuses
 * an unset SITE_URL by name. `.invalid` is RFC 2606-reserved: were the
 * placeholder ever to leak into a real redirect it could not resolve. */
const SCHEMA_ONLY_ORIGIN = 'http://schema-only.invalid'

/* SITE_URL remains the canonical app origin for redirects. A developer may
 * expose the same Vite process through another exact
 * origin (for example a Tailnet IP), so ADDITIONAL_APP_ORIGINS extends only
 * the trust/CORS set. It is deliberately a comma-separated list of complete
 * origins, never a wildcard or host suffix. */
const exactOrigin = (value: string, envName: string): string => {
  const trimmed = value.trim().replace(/\/$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${envName} contains an invalid origin`)
  }
  if (!/^https?:\/\//.test(trimmed) || url.origin !== trimmed) {
    throw new Error(`${envName} entries must be exact http(s) origins`)
  }
  return url.origin
}

export const appOrigins = (opts?: { schemaOnly?: boolean }): string[] => {
  if (opts?.schemaOnly) return [SCHEMA_ONLY_ORIGIN]
  const primary = exactOrigin(requireSiteUrl(), 'SITE_URL')
  const additional = (process.env.ADDITIONAL_APP_ORIGINS || '')
    .split(',')
    .filter((value) => value.trim() !== '')
    .map((value) => exactOrigin(value, 'ADDITIONAL_APP_ORIGINS'))
  const origins = [...new Set([primary, ...additional])]
  if (
    deploymentEnvironment() !== 'development' &&
    origins.some((origin) => !origin.startsWith('https://'))
  ) {
    throw new Error('Hosted authentication requires HTTPS for every app origin')
  }
  return origins
}

const authFunctions = {
  onCreate: makeFunctionReference('demo:onCreate'),
  onDelete: makeFunctionReference('demo:onDelete'),
} as unknown as AuthFunctions

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
  authFunctions,
  triggers: {
    user: {
      onCreate: registerDemoUser,
      onDelete: async (ctx, user) => expireDeletedDemoUser(ctx, user._id),
    },
    session: { onCreate: clampDemoSession },
  },
})

/* Split from createAuth so betterAuth/adapter.ts (createApi) and the schema
 * generator can consume the options. registerRoutes calls createAuth({}), so
 * ctx must only be dereferenced inside callbacks and the lazy adapter. */
export const createAuthOptions = (ctx: GenericCtx<DataModel>, opts?: { schemaOnly?: boolean }) => {
  const siteUrl = opts?.schemaOnly ? SCHEMA_ONLY_ORIGIN : requireSiteUrl()
  const environment = opts?.schemaOnly ? undefined : deploymentEnvironment()
  if (environment && environment !== 'development' && !siteUrl.startsWith('https://')) {
    throw new Error('Hosted authentication requires an HTTPS SITE_URL')
  }
  const demo = !opts?.schemaOnly && isDemoDeployment()
  if (environment === 'demo' && !demo)
    throw new Error('The demo environment requires APP_MODE=demo')
  if (demo) requireDemoDeployment()
  return {
    baseURL: process.env.CONVEX_SITE_URL,
    /* crossDomain does not feed ctx.trustedOrigins — must be explicit or
     * originCheck rejects OAuth/reset redirects back to the app. */
    trustedOrigins: appOrigins(opts),
    database: oauthAdapter(ctx, authComponent.adapter(ctx)),
    hooks: demo ? {} : oauthHooks(ctx),
    session: demo ? { expiresIn: DEMO_TTL_MS / 1_000, disableSessionRefresh: true } : undefined,
    disabledPaths: demo
      ? [
          '/sign-up/email',
          '/sign-in/email',
          '/sign-in/social',
          '/request-password-reset',
          '/reset-password',
          '/send-verification-email',
          '/verify-email',
          '/change-email',
          '/change-password',
          '/set-password',
          '/link-social',
          '/delete-user',
          '/delete-anonymous-user',
        ]
      : ['/sign-in/anonymous', '/delete-anonymous-user'],
    databaseHooks: {
      ...(demo
        ? {
            session: {
              create: {
                // Marketing analytics retain broad categories separately.
                // Clear Better Auth's default raw network/browser metadata
                // before it reaches the demo session database.
                before: async (session) => ({
                  data: { ...session, ipAddress: undefined, userAgent: undefined },
                }),
              },
            },
          }
        : {}),
      verification: { create: { after: (verification) => registerOAuthCode(ctx, verification) } },
      user: {
        delete: {
          after: async (user) => {
            await requireRunMutationCtx(ctx).runMutation(internal.appearance.clearForDeletedLogin, {
              auth_user_id: user.id,
            })
          },
        },
      },
    },
    emailAndPassword: {
      enabled: !demo,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        requireAuthMailDelivery()
        // The operator recovery-link flow replaces this callback wholesale —
        // see createCaptureAuth below; the browser's "Forgot password?" mails.
        await requireRunMutationCtx(ctx).scheduler.runAfter(0, internal.mail.send, {
          to: user.email,
          intent: 'reset',
          url,
        })
      },
    },
    emailVerification: {
      /* A confirmation link nobody can re-request is a dead end, and the token
       * lives an hour. sendOnSignUp covers BOTH registrations: an OAuth one
       * (Microsoft does not verify its mutable email claim, so Entra logins
       * arrive unverified) and a password one, where it now stands in for the
       * `?? requireEmailVerification` fallback better-auth reads otherwise.
       * sendOnSignIn mails a fresh link when an unverified password login
       * tries again — better-auth never re-sends on its own. */
      sendOnSignUp: !demo,
      sendOnSignIn: !demo,
      sendVerificationEmail: async ({ user, url }) => {
        requireAuthMailDelivery()
        await requireRunMutationCtx(ctx).scheduler.runAfter(0, internal.mail.send, {
          to: user.email,
          intent: 'verify',
          url,
        })
      },
    },
    /* Each provider joins only once its OAuth app is registered and its env
     * vars are set — the password flow must work before that. */
    socialProviders: {
      ...(!demo && process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
        ? {
            microsoft: {
              clientId: process.env.MICROSOFT_CLIENT_ID,
              clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
              tenantId: 'common',
              prompt: 'select_account' as const,
            },
          }
        : {}),
      ...(!demo && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              prompt: 'select_account' as const,
            },
          }
        : {}),
    },
    plugins: [
      convex({
        authConfig,
        ...(demo
          ? {
              jwt: {
                definePayload: async ({
                  user,
                  session,
                }: {
                  user: { id: string }
                  session: { expiresAt: Date }
                }) => {
                  if (!('runQuery' in ctx)) throw demoRefusal()
                  const deadline = await ctx.runQuery(
                    makeFunctionReference<'query', { auth_user_id: string }, number>(
                      'demo:tokenDeadline',
                    ),
                    { auth_user_id: user.id },
                  )
                  return {
                    exp: Math.floor(
                      Math.min(
                        Date.now() + 900_000,
                        new Date(session.expiresAt).getTime(),
                        deadline,
                      ) / 1_000,
                    ),
                  }
                },
              },
            }
          : {}),
      }),
      ...(!demo ? [qivoOAuthProvider(ctx, siteUrl, opts?.schemaOnly)] : []),
      crossDomain({ siteUrl }),
      admin(),
      anonymous({ emailDomainName: 'demo.qivo.invalid', generateName: () => 'Nora' }),
    ],
  } satisfies BetterAuthOptions
}

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth(createAuthOptions(ctx))

/* Operator recovery-link capture (adminAuth.ts): a SECOND Better Auth
 * instance over the same options whose sendResetPassword writes the minted
 * URL into the caller's ref instead of scheduling mail. requestPasswordReset
 * awaits the callback inline (better-auth runs it in-transaction, nothing
 * defers), so the action reads the ref right after the call returns — no
 * table, no read-back, and the console's "it is not stored anywhere" stays
 * literally true. The normal flow above is untouched: two instances, one
 * options base, zero flags. An email with no login never invokes the
 * callback (anti-enumeration), so a still-null ref means user-not-found. */
export const createCaptureAuth = (ctx: GenericCtx<DataModel>, captured: { url: string | null }) => {
  const opts = createAuthOptions(ctx)
  return betterAuth({
    ...opts,
    emailAndPassword: {
      ...opts.emailAndPassword,
      sendResetPassword: async ({ url }) => {
        captured.url = url
      },
    },
  })
}
