import { describe, expect, it, vi } from 'vitest'
import { createUpdatePrompt } from './updatePrompt'

function setup() {
  const state = { available: true, blocked: false }
  const clicks: (() => void)[] = []
  const confirmInstall = vi.fn(async () => true)
  const install = vi.fn()
  const showNotification = vi.fn((_version: string, onClick: () => void) => {
    clicks.push(onClick)
    return true
  })
  const prompt = createUpdatePrompt({
    isAvailable: () => state.available,
    isBlocked: () => state.blocked,
    confirmInstall,
    install,
    showNotification,
  })
  return { state, clicks, confirmInstall, install, showNotification, prompt }
}

describe('desktop update prompt', () => {
  it('defers a downloaded update notice until editing finishes', async () => {
    const { state, clicks, confirmInstall, install, showNotification, prompt } = setup()
    state.blocked = true
    prompt.notify('1.2.0')
    expect(showNotification).not.toHaveBeenCalled()

    state.blocked = false
    prompt.notify('1.2.0')
    prompt.notify('1.2.0')
    expect(showNotification).toHaveBeenCalledTimes(1)
    clicks[0]()
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(confirmInstall).toHaveBeenCalledTimes(1)
  })

  it('offers the same update again after a notification is clicked during a new edit', async () => {
    const { state, clicks, confirmInstall, install, showNotification, prompt } = setup()
    prompt.notify('1.2.0')
    state.blocked = true
    clicks[0]()
    expect(confirmInstall).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()

    state.blocked = false
    prompt.notify('1.2.0')
    expect(showNotification).toHaveBeenCalledTimes(2)
    clicks[1]()
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  })

  it('rechecks blockers after confirmation and re-arms the notice', async () => {
    const { state, confirmInstall, install, showNotification, prompt } = setup()
    let confirm!: (answer: boolean) => void
    confirmInstall.mockImplementationOnce(() => new Promise((resolve) => (confirm = resolve)))
    prompt.notify('1.2.0')
    const attempt = prompt.install()
    state.blocked = true
    confirm(true)
    expect(await attempt).toBe(false)
    expect(install).not.toHaveBeenCalled()

    state.blocked = false
    prompt.notify('1.2.0')
    expect(showNotification).toHaveBeenCalledTimes(2)
  })

  it('preserves Later without repeating the notice when an unrelated edit finishes', async () => {
    const { state, confirmInstall, install, showNotification, prompt } = setup()
    confirmInstall.mockResolvedValueOnce(false)
    prompt.notify('1.2.0')
    expect(await prompt.install()).toBe(false)
    state.blocked = true
    prompt.notify('1.2.0')
    state.blocked = false
    prompt.notify('1.2.0')
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
  })

  it('does not install an update that becomes unavailable during confirmation', async () => {
    const { state, confirmInstall, install, prompt } = setup()
    confirmInstall.mockImplementationOnce(async () => {
      state.available = false
      return true
    })
    expect(await prompt.install()).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})
