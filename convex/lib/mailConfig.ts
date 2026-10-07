import { isLocalDevelopment } from './deployment'

/** Only an explicit local development opt-in may disclose an auth link in logs. */
export function localAuthEmailLogging(): boolean {
  return process.env.QIVO_ALLOW_LOCAL_AUTH_EMAIL_LOG === 'true' && isLocalDevelopment()
}

export function requireAuthMailDelivery(): void {
  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX) return
  if (!process.env.AGENTMAIL_API_KEY && localAuthEmailLogging()) return
  throw new Error(
    'Authentication email is unavailable. Configure AGENTMAIL_API_KEY and AGENTMAIL_INBOX.',
  )
}
