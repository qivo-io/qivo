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

/** Only an explicit local development opt-in may disclose an auth link in logs. */
export function localAuthEmailLogging(): boolean {
  return process.env.QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG === 'true' && isLocalDevelopment()
}

/** Throws unless Lettermint delivery is configured with a token and a
 * MAIL_FROM of one address, or no token is set and local auth-link logging is
 * allowed. A token without a usable sender never falls back to logging. */
export function requireAuthMailDelivery(): void {
  if (process.env.LETTERMINT_API_KEY && mailFrom() !== null) return
  if (!process.env.LETTERMINT_API_KEY && localAuthEmailLogging()) return
  throw new Error(
    'Authentication email is unavailable. Configure LETTERMINT_API_KEY and set MAIL_FROM to one address.',
  )
}
