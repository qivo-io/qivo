import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLoginStartup, linuxAutostartEntry, startupArgument } from './startup'

let directory: string

beforeEach(() => {
  const parent = path.resolve('dev-temp/desktop-startup-tests')
  fs.mkdirSync(parent, { recursive: true })
  directory = fs.mkdtempSync(path.join(parent, 'run-'))
})

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

function setup(platform: NodeJS.Platform = 'linux') {
  let registered = false
  let enabled = false
  const loginItems = {
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: registered,
      executableWillLaunchAtLogin: registered && enabled,
      launchItems: registered
        ? [
            {
              name: 'io.qivo.desktop',
              scope: 'user',
              args: [startupArgument],
              enabled,
            },
          ]
        : [],
    })),
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean; enabled: boolean }) => {
      registered = settings.openAtLogin
      enabled = settings.enabled
    }),
  }
  const options = {
    platform,
    packaged: true,
    executablePath: '/opt/Qivo/qivo',
    configDirectory: directory,
    loginItems,
  }
  return {
    options,
    loginItems,
    filePath: path.join(directory, 'autostart/io.qivo.desktop.desktop'),
  }
}

describe('desktop logon startup', () => {
  it('creates and removes only Qivo’s XDG autostart entry', () => {
    const { options, filePath } = setup()
    const { set: setStartup, get } = createLoginStartup(options)
    setStartup(true)
    expect(get()).toBe(true)
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Exec="/opt/Qivo/qivo" --start-minimized')
    const otherApp = path.join(path.dirname(filePath), 'other.desktop')
    fs.writeFileSync(otherApp, 'other app')
    setStartup(false)
    expect(get()).toBe(false)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fs.readFileSync(otherApp, 'utf8')).toBe('other app')
    expect(() => setStartup(false)).not.toThrow()
  })

  it('registers the stable AppImage path instead of its temporary mount', () => {
    const { options, filePath } = setup()
    createLoginStartup({
      ...options,
      executablePath: '/tmp/.mount_Qivo/qivo',
      appImagePath: '/home/user/Applications/Qivo portable.AppImage',
    }).set(true)
    expect(fs.readFileSync(filePath, 'utf8')).toContain(
      'Exec="/home/user/Applications/Qivo portable.AppImage" --start-minimized',
    )
  })

  it('quotes reserved Exec characters', () => {
    const entry = linuxAutostartEntry('/home/user/Qivo $budget`draft"\\100.AppImage')
    expect(entry).toContain('Exec="/home/user/Qivo \\\\$budget\\\\`draft\\\\"\\\\\\\\100.AppImage"')
  })

  it('rejects percent executable paths that GLib cannot launch', () => {
    expect(() => linuxAutostartEntry('/home/user/Qivo 100%.AppImage')).toThrow(
      'Move Qivo to a path without % to enable logon startup.',
    )
  })

  it.each(['relative/qivo', '/path/new\nline', '/path/return\rline', '/path/zero\0byte'])(
    'rejects unsafe executable paths (%j)',
    (value) => expect(() => linuxAutostartEntry(value)).toThrow('absolute executable path'),
  )

  it('passes the hidden-start argument to Windows and verifies the result', () => {
    const { options, loginItems } = setup('win32')
    const { set: setStartup, get } = createLoginStartup({
      ...options,
      executablePath: 'C:\\Qivo\\Qivo.exe',
    })
    setStartup(true)
    expect(loginItems.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: true,
      enabled: true,
      name: 'io.qivo.desktop',
      path: 'C:\\Qivo\\Qivo.exe',
      args: [startupArgument],
    })
    setStartup(false)
    expect(get()).toBe(false)
  })

  it('reports rejected Windows registration and restores its previous state', () => {
    const { options, loginItems } = setup('win32')
    loginItems.setLoginItemSettings.mockImplementation(() => {})
    expect(() => createLoginStartup(options).set(true)).toThrow('operating system could not change')
    expect(loginItems.setLoginItemSettings.mock.calls.map(([value]) => value.openAtLogin)).toEqual([
      true,
      false,
    ])
  })

  it('never creates startup entries for development launches', () => {
    const { options, filePath, loginItems } = setup()
    createLoginStartup({ ...options, packaged: false }).set(true)
    createLoginStartup({ ...options, platform: 'win32', packaged: false }).set(true)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(loginItems.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('recognizes a Windows Task Manager opt-out even when the registry entry remains', () => {
    const { options, loginItems } = setup('win32')
    loginItems.setLoginItemSettings({ openAtLogin: true, enabled: false })
    expect(createLoginStartup(options).get()).toBe(false)
  })

  it('recognizes a disabled Linux autostart entry', () => {
    const { options, filePath } = setup()
    const startup = createLoginStartup(options)
    startup.set(true)
    fs.appendFileSync(filePath, 'Hidden=true\n')
    expect(startup.get()).toBe(false)
  })
})
