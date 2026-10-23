import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopSettingsStore, defaultDesktopSettings } from './settings.js'

let directory: string

beforeEach(() => {
  const parent = path.resolve('dev-temp/desktop-settings-tests')
  fs.mkdirSync(parent, { recursive: true })
  directory = fs.mkdtempSync(path.join(parent, 'run-'))
})

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

function setup() {
  const filePath = path.join(directory, 'desktop-settings.json')
  const setStartAtLogin = vi.fn<(enabled: boolean) => void>()
  const createStore = () => createDesktopSettingsStore({ filePath, setStartAtLogin })
  return { filePath, setStartAtLogin, createStore }
}

describe('desktop settings', () => {
  it('initializes first-run defaults and preserves every disabled preference after restart', () => {
    const { filePath, setStartAtLogin, createStore } = setup()
    const store = createStore()
    store.initialize()
    expect(store.get()).toEqual(defaultDesktopSettings)
    expect(setStartAtLogin).toHaveBeenCalledWith(true)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(defaultDesktopSettings)

    const disabled = {
      startAtLogin: false,
      closeToTray: false,
      minimizeToTray: false,
      showNotifications: false,
    }
    store.update(disabled)
    const restarted = createStore()
    restarted.initialize()
    expect(restarted.get()).toEqual(disabled)
    expect(setStartAtLogin).toHaveBeenLastCalledWith(false)
  })

  it('uses defaults for new fields without replacing saved choices', () => {
    const { filePath, createStore } = setup()
    fs.writeFileSync(filePath, JSON.stringify({ startAtLogin: false }))
    expect(createStore().get()).toEqual({ ...defaultDesktopSettings, startAtLogin: false })
  })

  it.each([null, [], 'enabled', { showNotifications: 'false' }, { arbitraryCommand: true }])(
    'rejects invalid patches without changing settings or registration (%j)',
    (patch) => {
      const { setStartAtLogin, createStore } = setup()
      const store = createStore()
      store.initialize()
      setStartAtLogin.mockClear()
      expect(() => store.update(patch)).toThrow()
      expect(store.get()).toEqual(defaultDesktopSettings)
      expect(setStartAtLogin).not.toHaveBeenCalled()
    },
  )

  it('preserves the file and settings when the operating system rejects startup changes', () => {
    const { filePath, setStartAtLogin, createStore } = setup()
    const store = createStore()
    store.initialize()
    setStartAtLogin.mockImplementationOnce(() => {
      throw new Error('Operating system error')
    })
    expect(() => store.update({ startAtLogin: false })).toThrow('couldn’t apply logon startup')
    expect(store.get().startAtLogin).toBe(true)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).startAtLogin).toBe(true)
  })

  it('rolls back logon registration if the preferences file cannot be replaced', () => {
    const { filePath, setStartAtLogin, createStore } = setup()
    const store = createStore()
    store.initialize()
    fs.rmSync(filePath)
    fs.mkdirSync(filePath)
    expect(() => store.update({ startAtLogin: false })).toThrow('could not save')
    expect(setStartAtLogin.mock.calls.slice(-2)).toEqual([[false], [true]])
    expect(store.get().startAtLogin).toBe(true)
    expect(fs.readdirSync(directory)).toEqual(['desktop-settings.json'])
  })

  it('keeps a failed rollback warning until an explicit retry reconciles logon startup', () => {
    const { filePath } = setup()
    let startupEnabled = false
    let failRestore = false
    const store = createDesktopSettingsStore({
      filePath,
      getStartAtLogin: () => startupEnabled,
      setStartAtLogin: (enabled) => {
        if (enabled && failRestore) throw new Error('Rollback denied')
        startupEnabled = enabled
      },
    })
    store.initialize()
    expect(startupEnabled).toBe(true)

    fs.rmSync(filePath)
    fs.mkdirSync(filePath)
    failRestore = true
    expect(() => store.update({ startAtLogin: false })).toThrow(AggregateError)
    expect(startupEnabled).toBe(false)
    expect(store.get().startAtLogin).toBe(true)
    const warning = store.get().startAtLoginError
    expect(warning).toContain('couldn’t apply logon startup')

    fs.rmSync(filePath, { recursive: true })
    const changed = store.update({ showNotifications: false })
    expect(changed.showNotifications).toBe(false)
    expect(changed.startAtLoginError).toBe(warning)
    expect(startupEnabled).toBe(false)

    failRestore = false
    const retried = store.update({ startAtLogin: true })
    expect(retried).toEqual({ ...defaultDesktopSettings, showNotifications: false })
    expect(startupEnabled).toBe(true)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(retried)
  })

  it('does not overwrite a malformed preferences file or register defaults over it', () => {
    const { filePath, setStartAtLogin, createStore } = setup()
    fs.writeFileSync(filePath, '{malformed')
    expect(createStore).toThrow('could not read')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{malformed')
    expect(setStartAtLogin).not.toHaveBeenCalled()
  })

  it('preserves an operating-system startup opt-out on later launches', () => {
    const { filePath, setStartAtLogin } = setup()
    fs.writeFileSync(filePath, JSON.stringify(defaultDesktopSettings))
    const store = createDesktopSettingsStore({
      filePath,
      setStartAtLogin,
      getStartAtLogin: () => false,
    })
    store.initialize()
    expect(store.get().startAtLogin).toBe(false)
    expect(setStartAtLogin).toHaveBeenCalledWith(false)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).startAtLogin).toBe(false)
  })

  it('keeps unrelated settings available after startup failure and retries an unchanged choice', () => {
    const { filePath, setStartAtLogin, createStore } = setup()
    setStartAtLogin.mockImplementation(() => {
      throw new Error('Startup denied')
    })
    const store = createStore()
    expect(() => store.initialize()).not.toThrow()
    expect(store.get().startAtLogin).toBe(true)
    expect(store.get().startAtLoginError).toContain('couldn’t apply logon startup')
    expect(fs.existsSync(filePath)).toBe(false)

    const changed = store.update({ showNotifications: false })
    expect(changed.showNotifications).toBe(false)
    expect(changed.startAtLoginError).toBeDefined()
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      ...defaultDesktopSettings,
      showNotifications: false,
    })

    setStartAtLogin.mockReset()
    expect(store.update({ startAtLogin: true }).startAtLoginError).toBeUndefined()
    expect(setStartAtLogin).toHaveBeenCalledWith(true)
  })

  it('allows disabling a saved startup choice after registration fails', () => {
    const { filePath, setStartAtLogin, createStore } = setup()
    fs.writeFileSync(filePath, JSON.stringify(defaultDesktopSettings))
    setStartAtLogin.mockImplementation((enabled) => {
      if (enabled) throw new Error('Startup denied')
    })
    const store = createStore()
    store.initialize()
    expect(store.get().startAtLoginError).toBeDefined()
    expect(store.update({ startAtLogin: false })).toEqual({
      ...defaultDesktopSettings,
      startAtLogin: false,
    })
  })

  it('keeps persistence failures distinct from startup registration warnings', () => {
    const filePath = path.join(directory, 'blocked/settings.json')
    const store = createDesktopSettingsStore({ filePath, setStartAtLogin: vi.fn() })
    fs.writeFileSync(path.dirname(filePath), 'not a directory')
    expect(() => store.initialize()).toThrow()
    expect(store.get().startAtLoginError).toBeUndefined()
  })
})
