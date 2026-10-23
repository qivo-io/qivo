import fs from 'node:fs'
import path from 'node:path'
import { unsupportedStartupPathMessage, writeFileAtomically } from './settings.js'

export const startupArgument = '--start-minimized'
const startupName = 'io.qivo.desktop'

type LoginItemOptions = { path: string; args: string[] }

type StartupOptions = {
  platform: NodeJS.Platform
  packaged: boolean
  executablePath: string
  appImagePath?: string
  configDirectory: string
  loginItems: {
    getLoginItemSettings: (options: LoginItemOptions) => {
      openAtLogin: boolean
      executableWillLaunchAtLogin: boolean
      launchItems: { name: string; scope: string; args: string[]; enabled: boolean }[]
    }
    setLoginItemSettings: (
      options: LoginItemOptions & {
        openAtLogin: boolean
        enabled: boolean
        name: string
      },
    ) => void
  }
}

/** Quote both the desktop-entry string and its Exec argument expansion. */
export function linuxAutostartEntry(executablePath: string): string {
  if (!path.isAbsolute(executablePath) || /[\r\n\0]/.test(executablePath))
    throw new Error('Qivo needs an absolute executable path for logon startup.')
  // GLib checks the executable before expanding escaped percent field codes.
  // Such a path can pass desktop-file validation but still fail at logon.
  if (executablePath.includes('%')) throw new Error(unsupportedStartupPathMessage)
  const argument = executablePath.replace(/["`$\\]/g, '\\$&').replace(/\\/g, '\\\\')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Qivo',
    `Exec="${argument}" ${startupArgument}`,
    'Icon=io.qivo.desktop',
    'Terminal=false',
    'StartupNotify=false',
    '',
  ].join('\n')
}

/**
 * Returns the AppImage file to start at logon, or undefined when Qivo is not
 * running from an AppImage. The AppImage runtime sets `APPIMAGE` to the file
 * it started, replacing any inherited value, and runs Qivo from a temporary
 * `.mount_*` or `appimage_extracted_*` folder. Qivo reads `APPIMAGE` only
 * when it runs from such a folder, so a value inherited by a .deb or .rpm
 * install cannot make its logon entry start another program.
 */
export function appImagePath(executablePath: string, env: NodeJS.ProcessEnv): string | undefined {
  const folder = path.basename(path.dirname(executablePath))
  return /^(\.mount_|appimage_extracted_)/.test(folder) ? env.APPIMAGE : undefined
}

/** Development launches never register the development Electron executable. */
export function createLoginStartup(options: StartupOptions) {
  const loginOptions = { path: options.executablePath, args: [startupArgument] }
  const filePath = path.join(options.configDirectory, 'autostart', `${startupName}.desktop`)
  const get = (): boolean | undefined => {
    if (!options.packaged) return undefined
    if (options.platform === 'win32') {
      const status = options.loginItems.getLoginItemSettings(loginOptions)
      return (
        status.openAtLogin &&
        status.executableWillLaunchAtLogin &&
        status.launchItems.some(
          (item) =>
            item.name === startupName &&
            item.scope === 'user' &&
            item.enabled &&
            item.args.length === 1 &&
            item.args[0] === startupArgument,
        )
      )
    }
    if (options.platform !== 'linux')
      throw new Error('Logon startup is unavailable on this operating system.')
    try {
      const contents = fs.readFileSync(filePath, 'utf8')
      return (
        /^Type=Application\r?$/m.test(contents) &&
        /^Exec=.+$/m.test(contents) &&
        !/^(Hidden=true|X-GNOME-Autostart-enabled=false)\r?$/m.test(contents)
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  const set = (enabled: boolean): void => {
    if (!options.packaged) return
    if (options.platform === 'win32') {
      const previous = options.loginItems.getLoginItemSettings(loginOptions)
      const previousEnabled = get() ?? false
      options.loginItems.setLoginItemSettings({
        ...loginOptions,
        openAtLogin: enabled,
        enabled,
        name: startupName,
      })
      if (get() !== enabled) {
        options.loginItems.setLoginItemSettings({
          ...loginOptions,
          openAtLogin: previous.openAtLogin,
          enabled: previousEnabled,
          name: startupName,
        })
        throw new Error('The operating system could not change Qivo logon startup.')
      }
      return
    }
    if (options.platform !== 'linux')
      throw new Error('Logon startup is unavailable on this operating system.')
    if (!enabled) {
      fs.rmSync(filePath, { force: true })
      return
    }
    const executablePath = options.appImagePath || options.executablePath
    writeFileAtomically(filePath, linuxAutostartEntry(executablePath))
  }
  return { get, set }
}
