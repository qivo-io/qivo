import fs from 'node:fs'
import path from 'node:path'

/**
 * electron-updater's test hooks. One picks the Linux package manager that
 * installs an update as root, the other the architecture whose files it
 * downloads. An installed app takes neither from its environment.
 */
const updaterTestVariables = ['ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER', 'TEST_UPDATER_ARCH']

/**
 * Returns the update configuration a build checks, or null when it never
 * checks. Only a packaged build checks, and only the feed electron-builder
 * wrote into `app-update.yml` from the build-time `QIVO_DESKTOP_UPDATE_URL`.
 * Nothing read at run time names another feed. `QIVO_DISABLE_UPDATES=1` can
 * only turn checks off, for diagnostics. A build without the file, such as a
 * local package or a Desktop test build, never checks.
 */
export function builtInUpdateConfig(
  packaged: boolean,
  env: NodeJS.ProcessEnv,
  resourcesPath: string,
): string | null {
  if (!packaged || env.QIVO_DISABLE_UPDATES === '1') return null
  const configPath = path.join(resourcesPath, 'app-update.yml')
  return fs.existsSync(configPath) ? configPath : null
}

/** Removes electron-updater's test hooks before the updater reads them. */
export function ignoreUpdaterTestHooks(env: NodeJS.ProcessEnv): void {
  for (const name of updaterTestVariables) delete env[name]
}
