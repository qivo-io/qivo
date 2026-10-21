import { isLocalDevelopment } from './deployment'

/* ONE address, and nothing that could be read as two — the recipient is
 * user-typed at sign-up, and whether a comma fans out or a `<` rewrites the
 * From is the provider's business, which is precisely why it must not be
 * decided there. 254 is the RFC 5321 ceiling on a path. */
const ADDR =
  /^[^\s@,;:<>"'\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i

/** `s` itself when it is one bare email address, otherwise null. */
export const address = (s: string): string | null => (s.length <= 254 && ADDR.test(s) ? s : null)

/** MAIL_FROM without surrounding whitespace when it is one bare address,
 * otherwise null. */
export const mailFrom = (): string | null => address((process.env.MAIL_FROM ?? '').trim())

const SEND_URL = 'https://api.lettermint.co/v1/send'
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/** Lettermint's send endpoint. A local development backend may name a
 * loopback stub in LETTERMINT_SEND_URL, to try refused and failed sends
 * without a real token. Every other backend ignores the variable, so the
 * token only ever goes to Lettermint or to this machine. */
export function mailSendUrl(): string {
  const stub = process.env.LETTERMINT_SEND_URL
  if (!stub || !isLocalDevelopment()) return SEND_URL
  try {
    const url = new URL(stub)
    return url.protocol === 'http:' && LOOPBACK.includes(url.hostname) ? url.href : SEND_URL
  } catch {
    return SEND_URL
  }
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
