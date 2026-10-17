import type { AppUpdater } from 'electron-updater'

/** The nil UUID. Every install sends it, so the staging header identifies no one. */
export const sharedStagingUserId = '00000000-0000-0000-0000-000000000000'

/**
 * Stops electron-updater from creating, storing and sending a per-install ID.
 *
 * electron-updater 6.8 writes a random UUID to `.updaterId` in the user data
 * folder and sends it as the `x-user-staging-id` header with every update
 * check. The ID only serves staged rollouts, which Qivo does not use, and the
 * library has no option to turn it off. Settling its lazy ID to the nil UUID
 * means the file is never read or written and every install sends the same
 * value. A staged rollout percentage then includes every install, and 0
 * includes none. Call this before the first update check.
 */
export function disableStagingUserId(updater: AppUpdater): void {
  // The lazy ID is protected. TypeScript permits element access to it and
  // still checks its type, so a renamed member fails the desktop typecheck.
  // biome-ignore lint/complexity/useLiteralKeys: dot access to a protected member does not compile.
  updater['stagingUserIdPromise'].value = Promise.resolve(sharedStagingUserId)
}

type SpellcheckSession = Pick<
  Electron.Session,
  'setSpellCheckerLanguages' | 'setSpellCheckerDictionaryDownloadURL'
>

/**
 * Keeps Chromium's spellchecker from downloading dictionaries from Google.
 *
 * macOS checks spelling with the system spellchecker and downloads nothing.
 * Windows uses its own spellchecker for the languages it supports and falls
 * back to a Hunspell dictionary from a Google server for the others. Linux
 * has only Hunspell, so each session downloads the dictionary for the system
 * language as soon as it is created. Electron starts that download for every
 * session, including electron-updater's, so call this from `session-created`.
 */
export function keepSpellcheckOffline(session: SpellcheckSession, platform: NodeJS.Platform): void {
  if (platform === 'darwin') return
  if (platform === 'win32') {
    // A data URL never reaches the network, so a fallback download fails
    // locally and that language goes unchecked.
    session.setSpellCheckerDictionaryDownloadURL('data:,')
    return
  }
  // An empty language list turns the spellchecker off before it can request
  // a dictionary. Linux therefore has no spellcheck. The data URL keeps any
  // later language change from reaching the network as well.
  session.setSpellCheckerDictionaryDownloadURL('data:,')
  session.setSpellCheckerLanguages([])
}
