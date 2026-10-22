import { isLocalDevelopment } from './deployment'
import { address } from './email'

/** `s` itself when it is one bare email address, otherwise null
 * (lib/email.ts, the rule every stored address follows). */
export { address }

/** MAIL_FROM without surrounding whitespace when it is one bare address,
 * otherwise null. */
export const mailFrom = (): string | null => address((process.env.MAIL_FROM ?? '').trim())

const SEND_URL = 'https://api.lettermint.co/v1/send'
// plain http to this machine, with an optional port and path
const LOOPBACK_URL = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/\S*)?$/

/** Lettermint's send endpoint. A local development backend may name a
 * loopback stub in LETTERMINT_SEND_URL, to try refused and failed sends
 * without a real token. Every other backend ignores the variable, so the
 * token only ever goes to Lettermint or to this machine. */
export function mailSendUrl(): string {
  const stub = process.env.LETTERMINT_SEND_URL
  return stub && isLocalDevelopment() && LOOPBACK_URL.test(stub) ? stub : SEND_URL
}

/** Only an explicit local development opt-in may disclose an auth link in logs. */
export function localAuthEmailLogging(): boolean {
  return process.env.QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG === 'true' && isLocalDevelopment()
}

/** Whether authentication mail can go out: Lettermint is configured with a
 * token and a MAIL_FROM of one address, or no token is set and local
 * auth-link logging is allowed. A token without a usable sender never falls
 * back to logging. The demo sends none. */
export function authMailAvailable(): boolean {
  if (process.env.APP_MODE === 'demo') return false
  if (process.env.LETTERMINT_API_KEY) return mailFrom() !== null
  return localAuthEmailLogging()
}
