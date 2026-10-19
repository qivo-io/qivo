import { isLocalDevelopment } from './deployment'

/** Only an explicit local development opt-in may disclose an auth link in logs. */
export function localAuthEmailLogging(): boolean {
  return process.env.QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG === 'true' && isLocalDevelopment()
}

/** Throws unless Lettermint delivery is configured, or no token is set and
 * local auth-link logging is allowed. A token without a sender never falls
 * back to logging. */
export function requireAuthMailDelivery(): void {
  if (process.env.LETTERMINT_API_KEY && process.env.MAIL_FROM) return
  if (!process.env.LETTERMINT_API_KEY && localAuthEmailLogging()) return
  throw new Error(
    'Authentication email is unavailable. Configure LETTERMINT_API_KEY and MAIL_FROM.',
  )
}
