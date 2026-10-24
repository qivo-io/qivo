import { getCurrentAuthContext } from '@better-auth/core/context'
import { type BetterAuthOptions, betterAuth } from 'better-auth/minimal'
import { admin } from 'better-auth/plugins'
import { anonymous } from 'better-auth/plugins/anonymous'
import { makeFunctionReference } from 'convex/server'
import {
  type AuthFunctions,
  createClient,
  type GenericCtx,
} from '../vendor/convex-better-auth/src/client'
import { convex, crossDomain } from '../vendor/convex-better-auth/src/plugins'
import { requireRunMutationCtx } from '../vendor/convex-better-auth/src/utils'
import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import authConfig from './auth.config'
import authSchema from './betterAuth/schema'
import {
  fieldsSetTo,
  holdsAny,
  PROVIDER_TOKEN_FIELDS,
  SESSION_REQUEST_FIELDS,
  USER_PROFILE_FIELDS,
} from './lib/authData'
import { type AuthMailState, authMailPlugin, RESEND, recordAuthMail } from './lib/authMail'
import { servedAuthRoutes, serveOnly } from './lib/authRoutes'
import { stopValidationEarly } from './lib/authValidation'
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
import {
  type MicrosoftSignIn,
  recordMicrosoftTenant,
  rekeyMicrosoftAccount,
} from './lib/microsoftAccounts'
import { oauthAdapter } from './lib/oauthAdapter'
import {
  oauthHooks,
  qivoOAuthProvider,
  registerOAuthCode,
  revokeSessionAccess,
} from './lib/oauthProvider'
import { type AuthLetterIntent, sendAuthLetter } from './mail'

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
  if (!url) throw new Error('SITE_URL is not set, so the app origin is unknown')
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

/* The endpoint a mail callback runs in, or null outside one (a direct call). */
const currentEndpoint = () => getCurrentAuthContext().catch(() => null)

/* A provider sign-in that registers a login whose address the provider did
 * not confirm. Its first confirmation link is sent by the app's confirm
 * screen (AuthGate), where a failed send can be shown, rather than here,
 * where the redirect back to the app could not carry it. */
const registersThroughProvider = (path: string | undefined) =>
  path === '/sign-in/social' || path?.startsWith('/callback/') === true

/** The user claims the Convex plugin puts in a token by default: every user
    field but its id and image. */
const userClaims = (user: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(user).filter(([key]) => key !== 'id' && key !== 'image'))

/* Every token gets its own `jti`. Two tokens minted for one session in the
   same second are otherwise the same bytes, and the Convex client, which
   then sees no new sign-in, never schedules the next refresh. The app asks
   twice at boot, so that is common. The rest is the plugin's own payload,
   every user field but its id and image, or for the demo only an expiry
   that ends with the demo. */
export const tokenPayload =
  (ctx: GenericCtx<DataModel>, demo: boolean) =>
  async ({
    user,
    session,
  }: {
    user: { id: string } & Record<string, unknown>
    session: { expiresAt: Date }
  }) => {
    const jti = crypto.randomUUID()
    if (!demo) return { ...userClaims(user), jti }
    if (!('runQuery' in ctx)) throw demoRefusal()
    const deadline = await ctx.runQuery(
      makeFunctionReference<'query', { auth_user_id: string }, number>('demo:tokenDeadline'),
      { auth_user_id: user.id },
    )
    return {
      exp: Math.floor(
        Math.min(Date.now() + 900_000, new Date(session.expiresAt).getTime(), deadline) / 1_000,
      ),
      jti,
    }
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
 * ctx must only be dereferenced inside callbacks and the lazy adapter.
 *
 * Every authentication letter is sent while its request waits, and `mail`
 * holds how it went for lib/authMail.ts to report. One options object serves
 * one request: registerRoutes and every action build a fresh instance.
 * `recovery` is the operator's recovery-link capture (createCaptureAuth). */
export const createAuthOptions = (
  ctx: GenericCtx<DataModel>,
  opts?: { schemaOnly?: boolean; recovery?: { url: string | null } },
) => {
  const siteUrl = opts?.schemaOnly ? SCHEMA_ONLY_ORIGIN : requireSiteUrl()
  const environment = opts?.schemaOnly ? undefined : deploymentEnvironment()
  if (environment && environment !== 'development' && !siteUrl.startsWith('https://')) {
    throw new Error('Hosted authentication requires an HTTPS SITE_URL')
  }
  const demo = !opts?.schemaOnly && isDemoDeployment()
  if (environment === 'demo' && !demo)
    throw new Error('The demo environment requires APP_MODE=demo')
  if (demo) requireDemoDeployment()
  const mail: AuthMailState = { outcome: null }
  const deliver = async (intent: AuthLetterIntent, to: string, url: string) =>
    recordAuthMail(mail, await sendAuthLetter({ intent, to, url }))
  const recovery = opts?.recovery
  const microsoft: { signIn: MicrosoftSignIn } = { signIn: null }
  return {
    baseURL: process.env.CONVEX_SITE_URL,
    /* crossDomain does not feed ctx.trustedOrigins — must be explicit or
     * originCheck rejects OAuth/reset redirects back to the app. */
    trustedOrigins: appOrigins(opts),
    database: oauthAdapter(ctx, authComponent.adapter(ctx)),
    hooks: demo ? {} : oauthHooks(ctx),
    session: demo ? { expiresIn: DEMO_TTL_MS / 1_000, disableSessionRefresh: true } : undefined,
    /* No deployment stores the personal data lib/authData.ts lists. A create
     * leaves those fields out. An update that carries a provider token or a
     * picture writes null instead, which also clears what an older row held.
     * Writes without one, such as a password change or a ban, pass through
     * unchanged. The OAuth provider's own tables are other models and keep
     * what MCP connections need. */
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, ...fieldsSetTo(SESSION_REQUEST_FIELDS, undefined) },
          }),
        },
        // The demo has no OAuth provider, so no session holds an access token.
        delete: demo ? undefined : { after: (session) => revokeSessionAccess(ctx, session.id) },
      },
      account: {
        create: {
          before: async (account) =>
            holdsAny(account, PROVIDER_TOKEN_FIELDS)
              ? { data: { ...account, ...fieldsSetTo(PROVIDER_TOKEN_FIELDS, undefined) } }
              : undefined,
          after: (account) => recordMicrosoftTenant(ctx, account, microsoft.signIn),
        },
        update: {
          before: async (update) =>
            holdsAny(update, PROVIDER_TOKEN_FIELDS)
              ? { data: { ...update, ...fieldsSetTo(PROVIDER_TOKEN_FIELDS, null) } }
              : undefined,
          after: (account) => recordMicrosoftTenant(ctx, account, microsoft.signIn),
        },
      },
      verification: { create: { after: (verification) => registerOAuthCode(ctx, verification) } },
      user: {
        create: {
          before: async (user) =>
            holdsAny(user, USER_PROFILE_FIELDS)
              ? { data: { ...user, ...fieldsSetTo(USER_PROFILE_FIELDS, undefined) } }
              : undefined,
        },
        update: {
          before: async (update) =>
            holdsAny(update, USER_PROFILE_FIELDS)
              ? { data: { ...update, ...fieldsSetTo(USER_PROFILE_FIELDS, null) } }
              : undefined,
        },
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
        // The operator's recovery link is returned, never mailed.
        if (recovery) recovery.url = url
        else await deliver('reset', user.email, url)
      },
      /* A sign-up for an address that already has an account mails that
       * account a note instead of a link, so every sign-up sends one letter
       * (lib/authMail.ts). */
      onExistingUserSignUp: async ({ user }) => {
        await deliver('existing', user.email, `${siteUrl}/app`)
      },
    },
    emailVerification: {
      /* A confirmation link nobody can re-request is a dead end, and the token
       * lives an hour. sendOnSignUp mails a password registration's link,
       * standing in for the `?? requireEmailVerification` fallback
       * better-auth reads otherwise. A provider registration (Microsoft does
       * not verify its mutable email claim, so Entra logins arrive
       * unverified) also reaches the callback, which leaves that first link
       * to the app's confirm screen. sendOnSignIn mails a fresh link when an
       * unverified password login tries again — better-auth never re-sends
       * on its own. */
      sendOnSignUp: !demo,
      sendOnSignIn: !demo,
      sendVerificationEmail: async ({ user, url }) => {
        const endpoint = await currentEndpoint()
        if (registersThroughProvider(endpoint?.path)) return
        // a resend without a session is refused for every address (lib/authMail.ts)
        if (endpoint?.path === RESEND && !endpoint.context.session) return
        await deliver('verify', user.email, url)
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
              /* better-auth reads the id, name and email from the ID token,
               * so sign-in needs only the OpenID scopes. The defaults also
               * asked for User.Read, used only to fetch the profile photo,
               * and offline_access, a refresh token Qivo never stores.
               * better-auth still requests the photo with the access token,
               * and Microsoft may still grant User.Read to people or tenants
               * that consented earlier, so disableProfilePhoto is what keeps
               * the photo out of user.image. */
              disableDefaultScope: true,
              scope: ['openid', 'profile', 'email'],
              disableProfilePhoto: true,
              /* Changes no user field. Better Auth calls it with the ID
               * token before it looks the account up, which is when an
               * account Better Auth 1.6 keyed by `sub` moves to `oid`. The
               * account hooks record the token's tenant beside it. */
              mapProfileToUser: async (profile) => {
                microsoft.signIn = await rekeyMicrosoftAccount(ctx, profile)
                return {}
              },
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
        jwt: { definePayload: tokenPayload(ctx, demo) },
      }),
      ...(!demo ? [qivoOAuthProvider(ctx, siteUrl, opts?.schemaOnly)] : []),
      crossDomain({ siteUrl }),
      ...(recovery
        ? []
        : [authMailPlugin(mail, (email) => deliver('unknown', email, `${siteUrl}/app#signup`))]),
      admin(),
      anonymous({ emailDomainName: 'demo.qivo.invalid', generateName: () => 'Nora' }),
    ],
  } satisfies BetterAuthOptions
}

/* Every instance that serves auth answers only the routes Qivo uses
 * (lib/authRoutes.ts) and checks a large request only until its first
 * problem (lib/authValidation.ts). */
export const createAuth = (ctx: GenericCtx<DataModel>) =>
  serveOnly(stopValidationEarly(betterAuth(createAuthOptions(ctx))), servedAuthRoutes())

/* Operator recovery-link capture (adminAuth.ts): a SECOND Better Auth
 * instance over the same options whose sendResetPassword writes the minted
 * URL into the caller's ref instead of mailing it, and which has no mail
 * hooks, so it works while mail is off and mails nobody about an unknown
 * address. requestPasswordReset awaits the callback inline, so the action
 * reads the ref right after the call returns: no table, no read-back, and the
 * console's "it is not stored anywhere" stays literally true. An email with
 * no login never invokes the callback (anti-enumeration), so a still-null ref
 * means user-not-found. */
export const createCaptureAuth = (ctx: GenericCtx<DataModel>, captured: { url: string | null }) =>
  serveOnly(
    stopValidationEarly(betterAuth(createAuthOptions(ctx, { recovery: captured }))),
    servedAuthRoutes(),
  )
