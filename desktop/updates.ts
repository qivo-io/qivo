import fs from 'node:fs'
import path from 'node:path'
import type { AppUpdater } from 'electron-updater'
import { appImagePath } from './startup.js'

/**
 * electron-updater's test hooks. One picks the Linux package manager that
 * installs an update as root, the other the architecture whose files it
 * downloads. An installed app takes neither from its environment.
 */
const updaterTestVariables = ['ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER', 'TEST_UPDATER_ARCH']

type UpdateInputs = {
  packaged: boolean
  env: NodeJS.ProcessEnv
  resourcesPath: string
  executablePath: string
}

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

/**
 * Points the updater at the built-in feed and returns whether it may check.
 * Before the first check it also removes the environment values the updater
 * would otherwise follow: its test hooks, and an `APPIMAGE` that no AppImage
 * launcher set, which the AppImage updater would delete and replace. Leaves
 * the updater untouched when the build never checks.
 */
export function useBuiltInFeed(
  updater: Pick<AppUpdater, 'updateConfigPath'>,
  { packaged, env, resourcesPath, executablePath }: UpdateInputs,
): boolean {
  const updateConfig = builtInUpdateConfig(packaged, env, resourcesPath)
  if (!updateConfig) return false
  updater.updateConfigPath = updateConfig
  for (const name of updaterTestVariables) delete env[name]
  if (!appImagePath(executablePath, env)) delete env.APPIMAGE
  return true
}
