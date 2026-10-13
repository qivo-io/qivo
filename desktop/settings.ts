import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type DesktopSettings = {
  startAtLogin: boolean
  closeToTray: boolean
  minimizeToTray: boolean
  showNotifications: boolean
}

export type DesktopSettingsSnapshot = DesktopSettings & { startAtLoginError?: string }

const startupWarning = 'Qivo couldn’t apply logon startup. Change this setting or try again.'
export const unsupportedStartupPathMessage =
  'Move Qivo to a path without % to enable logon startup.'

function startupFailureMessage(error: unknown): string {
  return error instanceof Error && error.message === unsupportedStartupPathMessage
    ? unsupportedStartupPathMessage
    : startupWarning
}

export const defaultDesktopSettings: DesktopSettings = {
  startAtLogin: true,
  closeToTray: true,
  minimizeToTray: false,
  showNotifications: true,
}

const settingNames = Object.keys(defaultDesktopSettings) as (keyof DesktopSettings)[]

function validatePatch(value: unknown): Partial<DesktopSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Desktop settings must be an object.')
  const patch: Partial<DesktopSettings> = {}
  for (const [key, enabled] of Object.entries(value)) {
    if (!settingNames.includes(key as keyof DesktopSettings) || typeof enabled !== 'boolean')
      throw new Error('Desktop settings must contain only supported boolean values.')
    patch[key as keyof DesktopSettings] = enabled
  }
  return patch
}

/** Replace a local settings file without leaving a partly written document. */
export function writeFileAtomically(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

/** Keep device preferences local and undo login changes if saving fails. */
export function createDesktopSettingsStore(options: {
  filePath: string
  getStartAtLogin?: () => boolean | undefined
  setStartAtLogin: (enabled: boolean) => void
}) {
  let settings = { ...defaultDesktopSettings }
  let exists = false
  let startAtLoginError: string | undefined
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(options.filePath, 'utf8'))
    settings = { ...settings, ...validatePatch(saved) }
    exists = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw new Error('Qivo could not read desktop settings.', { cause: error })
  }

  const save = (next: DesktopSettings): void => {
    writeFileAtomically(options.filePath, `${JSON.stringify(next, null, 2)}\n`)
    exists = true
  }

  const snapshot = (): DesktopSettingsSnapshot => ({
    ...settings,
    ...(startAtLoginError ? { startAtLoginError } : {}),
  })

  return {
    get: snapshot,
    initialize: (): void => {
      let previousLogin: boolean | undefined
      let next: DesktopSettings
      try {
        previousLogin = options.getStartAtLogin?.()
        next = {
          ...settings,
          startAtLogin: exists ? (previousLogin ?? settings.startAtLogin) : settings.startAtLogin,
        }
        options.setStartAtLogin(next.startAtLogin)
      } catch (error) {
        // A login registration failure must not block unrelated preferences.
        // Keep the saved choice because a failed OS read cannot prove it is off.
        startAtLoginError = startupFailureMessage(error)
        return
      }
      if (!exists || next.startAtLogin !== settings.startAtLogin) {
        try {
          save(next)
        } catch (error) {
          options.setStartAtLogin(previousLogin ?? false)
          throw error
        }
      }
      settings = next
      startAtLoginError = undefined
    },
    update: (value: unknown): DesktopSettingsSnapshot => {
      const patch = validatePatch(value)
      const next = { ...settings, ...patch }
      const startupRequested = patch.startAtLogin !== undefined
      if (!startupRequested && !settingNames.some((key) => next[key] !== settings[key]) && exists)
        return snapshot()
      let previousLogin = settings.startAtLogin
      if (startupRequested) {
        try {
          previousLogin = options.getStartAtLogin?.() ?? settings.startAtLogin
          options.setStartAtLogin(next.startAtLogin)
        } catch (error) {
          startAtLoginError = startupFailureMessage(error)
          throw new Error(startAtLoginError, { cause: error })
        }
      }
      try {
        save(next)
      } catch (error) {
        if (startupRequested) {
          try {
            options.setStartAtLogin(previousLogin)
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Qivo could not save settings or restore the previous logon setting.',
            )
          }
        }
        throw new Error('Qivo could not save desktop settings.', { cause: error })
      }
      settings = next
      if (startupRequested) startAtLoginError = undefined
      return snapshot()
    },
  }
}
