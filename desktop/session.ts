import { restrictPermissions } from './permissions.js'
import { keepSpellcheckOffline } from './privacy.js'

/**
 * Applies the shell's permission and spellcheck policy to a new session.
 * Call it from `session-created`. The permission policy goes first, so a
 * failure in the spellcheck setup cannot leave the session on Electron's
 * default, which grants every permission to every page.
 */
export function secureSession(
  session: Parameters<typeof restrictPermissions>[0] & Parameters<typeof keepSpellcheckOffline>[0],
  appOrigin: string,
  platform: NodeJS.Platform,
): void {
  restrictPermissions(session, appOrigin)
  keepSpellcheckOffline(session, platform)
}
