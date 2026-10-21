/* What a person is told when an authentication email could not go out.
 *
 * Better Auth runs every mail callback through runInBackgroundOrAwait, which
 * swallows what the callback throws, so a failed send used to end in a 200
 * and a log line. auth.ts now sends each letter while the request waits,
 * records the outcome in an AuthMailState that lives as long as one auth
 * instance (createAuth builds one per request), and the plugin below turns a
 * failed outcome into a refusal with a sentence that says what to do.
 *
 * Account enumeration stays closed because every sign-up and every reset
 * request sends exactly one letter to the typed address, whether or not an
 * account uses it: a confirmation link or an "already has an account" note
 * for sign-up, a reset link or a "no account uses this address" note for a
 * reset. A failure therefore depends on the address and the provider, never
 * on whether the account exists, and the person who typed the address hears
 * about it either way. Mail that is off for everyone is refused before the
 * endpoint runs, so no account is created that could never be confirmed. A
 * resend of the confirmation link needs a session, because without one Better
 * Auth sends only for an existing unconfirmed account. */

import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { authMailAvailable } from './mailConfig'

/** How one authentication letter went: delivered to the provider, refused
 * (nothing was sent), uncertain (a timeout or server error after which it may
 * still arrive), or unavailable (mail is not configured). */
export type AuthMailOutcome = 'sent' | 'unsent' | 'uncertain' | 'unavailable'

/** The outcome of one auth instance's letters. A failure is kept over a later
 * success. */
export type AuthMailState = { outcome: AuthMailOutcome | null }

export const SIGN_UP = '/sign-up/email'
export const SIGN_IN = '/sign-in/email'
export const RESET = '/request-password-reset'
export const RESEND = '/send-verification-email'
type MailPath = typeof SIGN_UP | typeof SIGN_IN | typeof RESET | typeof RESEND

/** Records `outcome` unless an earlier letter of the same request failed. */
export function recordAuthMail(state: AuthMailState, outcome: AuthMailOutcome): void {
  if (state.outcome === null || state.outcome === 'sent') state.outcome = outcome
}

/* Each sentence says what happened and what to do next. A sign-up that could
 * not send its letter still created (or already had) the account, and signing
 * in mails a fresh confirmation link, so that is the way forward there. */
const REFUSALS: Record<MailPath, Record<Exclude<AuthMailOutcome, 'sent'>, string>> = {
  [SIGN_UP]: {
    unavailable:
      'Qivo cannot send email right now, so it cannot confirm a new account. Try again later.',
    unsent:
      'We could not send the confirmation email. Wait a few minutes, then sign in to get a new one.',
    uncertain:
      'We could not confirm that the email was sent. If it does not arrive, wait a few minutes, then sign in to get a new one.',
  },
  [SIGN_IN]: {
    unavailable:
      'Confirm your email first. Qivo cannot send email right now, so no new link was sent. Try again later.',
    unsent:
      'Confirm your email first. We could not send a new link, so try again in a few minutes.',
    uncertain:
      'Confirm your email first. We could not confirm that a new link was sent. If it does not arrive, try again in a few minutes.',
  },
  [RESET]: {
    unavailable:
      'Qivo cannot send email right now, so it cannot send a reset link. Try again later.',
    unsent: 'We could not send the email. Try again in a few minutes.',
    uncertain:
      'We could not confirm that the email was sent. If it does not arrive, try again in a few minutes.',
  },
  [RESEND]: {
    unavailable:
      'Qivo cannot send email right now, so it cannot send a confirmation link. Try again later.',
    unsent: 'We could not send the confirmation email. Try again in a few minutes.',
    uncertain:
      'We could not confirm that the email was sent. If it does not arrive, try again in a few minutes.',
  },
}

const isMailPath = (path: string | undefined): path is MailPath =>
  path === SIGN_UP || path === SIGN_IN || path === RESET || path === RESEND

/** The refusal for a failed outcome on `path`. A sign-in keeps the 403 of
 * the unconfirmed address it replaces (Better Auth keeps an endpoint's own
 * refusal status anyway); the others are 503, mail being out of service. */
export function authMailRefusal(path: MailPath, outcome: Exclude<AuthMailOutcome, 'sent'>) {
  return APIError.from(path === SIGN_IN ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE', {
    code: outcome === 'unavailable' ? 'AUTH_MAIL_UNAVAILABLE' : 'AUTH_MAIL_NOT_SENT',
    message: REFUSALS[path][outcome],
  })
}

/** Better Auth hooks that report this request's authentication mail.
 * `unknownAddress` sends the reset note when no account uses the address and
 * records its outcome in `state`. It sits after crossDomain in the plugin list, but needs nothing
 * from it: the session it reads is the one the endpoint itself resolved. */
export function authMailPlugin(
  state: AuthMailState,
  unknownAddress: (email: string) => Promise<void>,
): BetterAuthPlugin {
  return {
    id: 'qivo-auth-mail',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === SIGN_UP || ctx.path === RESET || ctx.path === RESEND,
          handler: createAuthMiddleware(async (ctx) => {
            if (isMailPath(ctx.path) && !authMailAvailable())
              throw authMailRefusal(ctx.path, 'unavailable')
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => isMailPath(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const path = ctx.path
            if (!isMailPath(path)) return
            const refused = ctx.context.returned instanceof APIError
            if (path === RESEND && !ctx.context.session) {
              // the callback sent nothing (auth.ts), whoever the address is
              throw APIError.from('UNAUTHORIZED', {
                code: 'SESSION_REQUIRED',
                message: 'Sign in to get a new confirmation link.',
              })
            }
            if (path === RESET && !refused && state.outcome === null) {
              const email = (ctx.body as { email?: unknown } | undefined)?.email
              if (typeof email === 'string') await unknownAddress(email)
            }
            // Only a request that tried to send has an outcome. On sign-in that
            // is the unconfirmed-address refusal, which this replaces.
            const outcome = state.outcome
            if (outcome !== null && outcome !== 'sent') throw authMailRefusal(path, outcome)
          }),
        },
      ],
    },
  }
}
