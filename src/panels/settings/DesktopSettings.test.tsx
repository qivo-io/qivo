// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { isUpdateBlocked } from '../../lib/updateSafety'
import { DesktopSettingsPage } from './DesktopSettings'

// Shared controls import the planner through Icon, but this page uses only
// its native settings bridge and must not start an application data client.
vi.mock('../../store/planner', () => ({ P: {} }))

const confirmedSettings: QivoDesktopSettings = {
  startAtLogin: true,
  closeToTray: true,
  minimizeToTray: false,
  showNotifications: true,
}

type SettingsBridge = NonNullable<QivoDesktopBridge['settings']>

function bridge() {
  return {
    get: vi.fn<SettingsBridge['get']>().mockResolvedValue({ ...confirmedSettings }),
    update: vi.fn<SettingsBridge['update']>(),
  }
}

function pendingSnapshot() {
  let resolve!: (value: QivoDesktopSettingsSnapshot) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<QivoDesktopSettingsSnapshot>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(settings: SettingsBridge) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <DesktopSettingsPage settings={settings} />
      </TooltipProvider>,
    ),
  )
}

function toggle(label: string) {
  const control = container.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${label}"]`,
  )
  if (!control) throw new Error(`Missing switch ${label}`)
  return control
}

function retryButton() {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Retry',
  )
  if (!button) throw new Error('Missing Retry button')
  return button
}

function expectSwitchesDisabled(disabled: boolean) {
  const controls = container.querySelectorAll<HTMLButtonElement>('[role="switch"]')
  expect(controls).toHaveLength(4)
  for (const control of controls) expect(control.disabled).toBe(disabled)
}

describe('desktop settings page recovery', () => {
  it('retries a failed load and replaces the error with the confirmed settings', async () => {
    const settings = bridge()
    const retry = pendingSnapshot()
    settings.get
      .mockRejectedValueOnce(new Error('Settings unavailable'))
      .mockReturnValueOnce(retry.promise)
    await render(settings)

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load desktop settings.",
    )
    expect(container.querySelector('[role="switch"]')).toBeNull()
    await act(async () => retryButton().click())
    expect(settings.get).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Loading desktop settings…',
    )

    await act(async () => retry.resolve({ ...confirmedSettings }))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(toggle('Start Qivo at logon').getAttribute('aria-checked')).toBe('true')
    expect(toggle('Minimize to tray').getAttribute('aria-checked')).toBe('false')
    expectSwitchesDisabled(false)
  })

  it('keeps confirmed values after a rejected save and failed readback, then allows another save', async () => {
    const settings = bridge()
    const save = pendingSnapshot()
    settings.get
      .mockResolvedValueOnce({ ...confirmedSettings })
      .mockRejectedValueOnce(new Error('Readback unavailable'))
    settings.update.mockReturnValueOnce(save.promise).mockResolvedValueOnce({
      ...confirmedSettings,
      showNotifications: false,
    })
    await render(settings)

    await act(async () => toggle('Show notifications').click())
    expect(settings.update).toHaveBeenCalledWith({ showNotifications: false })
    expect(toggle('Show notifications').getAttribute('aria-checked')).toBe('true')
    expectSwitchesDisabled(true)
    expect(isUpdateBlocked()).toBe(true)

    await act(async () => save.reject(new Error('Save unavailable')))
    expect(settings.get).toHaveBeenCalledTimes(2)
    expect(toggle('Show notifications').getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save desktop settings. Try again.",
    )
    expectSwitchesDisabled(false)
    expect(isUpdateBlocked()).toBe(false)

    await act(async () => toggle('Show notifications').click())
    expect(settings.update).toHaveBeenCalledTimes(2)
    expect(toggle('Show notifications').getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expectSwitchesDisabled(false)
  })

  it('reads back a rejected startup warning, saves another setting and retries the unchanged startup choice', async () => {
    const settings = bridge()
    const warning = 'Qivo couldn’t apply logon startup. Change this setting or try again.'
    settings.get.mockResolvedValueOnce({ ...confirmedSettings }).mockResolvedValueOnce({
      ...confirmedSettings,
      startAtLoginError: warning,
    })
    settings.update
      .mockRejectedValueOnce(new Error('Startup registration failed'))
      .mockResolvedValueOnce({
        ...confirmedSettings,
        showNotifications: false,
        startAtLoginError: warning,
      })
      .mockResolvedValueOnce({ ...confirmedSettings, showNotifications: false })
    await render(settings)

    await act(async () => toggle('Start Qivo at logon').click())
    expect(settings.update).toHaveBeenNthCalledWith(1, { startAtLogin: false })
    expect(settings.get).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain(warning)
    expect(toggle('Start Qivo at logon').getAttribute('aria-checked')).toBe('true')
    expectSwitchesDisabled(false)

    await act(async () => toggle('Show notifications').click())
    expect(settings.update).toHaveBeenNthCalledWith(2, { showNotifications: false })
    expect(toggle('Show notifications').getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain(warning)
    expect(retryButton().disabled).toBe(false)

    await act(async () => retryButton().click())
    expect(settings.update).toHaveBeenNthCalledWith(3, { startAtLogin: true })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain('Retry')
    expect(toggle('Start Qivo at logon').getAttribute('aria-checked')).toBe('true')
    expect(toggle('Show notifications').getAttribute('aria-checked')).toBe('false')
    expectSwitchesDisabled(false)
  })
})
