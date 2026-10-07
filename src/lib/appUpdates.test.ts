import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdateMonitor } from './appUpdates'

type UpdateOptions = Parameters<typeof createAppUpdateMonitor>[0]

function sessionStorage(): NonNullable<UpdateOptions['storage']> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('safe application updates', () => {
  const monitors: ReturnType<typeof createAppUpdateMonitor>[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'))
  })

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function setup(options: Partial<UpdateOptions> = {}) {
    const safety = { blocked: false, visible: true }
    const fetchVersion = vi.fn<UpdateOptions['fetchVersion']>().mockResolvedValue({
      buildId: 'build-2',
    })
    const reload = vi.fn()
    const onChange = vi.fn<UpdateOptions['onChange']>()
    const monitor = createAppUpdateMonitor({
      buildId: 'build-1',
      fetchVersion,
      isBlocked: () => safety.blocked,
      isVisible: () => safety.visible,
      reload,
      onChange,
      ...options,
    })
    monitors.push(monitor)
    return {
      monitor,
      safety,
      fetchVersion,
      reload,
      onChange,
      state: () => onChange.mock.calls.at(-1)?.[0],
    }
  }

  it('announces a new build, gives the user five quiet seconds, and reloads once', async () => {
    const app = setup()
    await app.monitor.check()
    expect(app.state()).toMatchObject({ available: true, blocked: false, reloading: false })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(app.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.reload).toHaveBeenCalledOnce()
    expect(app.state()).toMatchObject({ reloading: true })

    await app.monitor.check()
    app.monitor.reconsider()
    app.monitor.reloadNow()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('waits for a fresh quiet period whenever the user resumes interacting', async () => {
    const app = setup()
    await app.monitor.check()
    await vi.advanceTimersByTimeAsync(4_000)
    app.monitor.activity()
    await vi.advanceTimersByTimeAsync(4_000)
    app.monitor.activity()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(app.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('keeps an available update pending throughout a draft and applies it after release', async () => {
    const app = setup()
    app.safety.blocked = true
    await app.monitor.check()
    expect(app.state()).toMatchObject({ available: true, blocked: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(app.reload).not.toHaveBeenCalled()

    app.safety.blocked = false
    app.monitor.activity()
    app.monitor.reconsider()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(app.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('checks the current draft state at reload time even without a change notification', async () => {
    const app = setup()
    await app.monitor.check()
    await vi.advanceTimersByTimeAsync(4_999)
    // A save or editor may become busy between the scheduled check and navigation.
    app.safety.blocked = true
    await vi.advanceTimersByTimeAsync(1)
    expect(app.reload).not.toHaveBeenCalled()
    expect(app.state()).toMatchObject({ available: true, blocked: true })
  })

  it('leaves background tabs alone, then updates after returning and becoming quiet', async () => {
    const app = setup()
    await app.monitor.check()
    app.safety.visible = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(app.reload).not.toHaveBeenCalled()

    app.safety.visible = true
    app.monitor.activity()
    app.monitor.reconsider()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('allows an explicit reload immediately when no draft or hidden tab blocks it', async () => {
    const app = setup()
    await app.monitor.check()
    app.monitor.reloadNow()
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it.each(['blocked', 'hidden'] as const)(
    'does not let an explicit reload discard work in a %s page',
    async (reason) => {
      const app = setup()
      await app.monitor.check()
      if (reason === 'blocked') app.safety.blocked = true
      else app.safety.visible = false
      app.monitor.reloadNow()
      expect(app.reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(app.reload).not.toHaveBeenCalled()
    },
  )

  it('cancels a pending update when the server reports the running build again', async () => {
    const app = setup()
    await app.monitor.check()
    await vi.advanceTimersByTimeAsync(3_000)
    app.fetchVersion.mockResolvedValue({ buildId: 'build-1' })
    await app.monitor.check()
    expect(app.state()).toMatchObject({ available: false, reloading: false })
    await vi.advanceTimersByTimeAsync(30_000)
    app.monitor.reloadNow()
    expect(app.reload).not.toHaveBeenCalled()
  })

  it.each([
    null,
    undefined,
    '<!doctype html>',
    {},
    { buildId: '' },
    { buildId: 2 },
    { buildId: 'next build' },
    { buildId: '../next/build' },
    { buildId: 'x'.repeat(129) },
  ])('ignores malformed version metadata: %j', async (response) => {
    const app = setup()
    app.fetchVersion.mockResolvedValue(response)
    await app.monitor.check()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(app.state()?.available ?? false).toBe(false)
    expect(app.reload).not.toHaveBeenCalled()
  })

  it('recovers from an offline check without treating the failure as an update', async () => {
    const app = setup()
    app.fetchVersion.mockRejectedValueOnce(new TypeError('Network request failed'))
    await expect(app.monitor.check()).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(app.reload).not.toHaveBeenCalled()
    expect(app.state()?.available ?? false).toBe(false)

    await app.monitor.check()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('retries after a fetch adapter throws before returning its promise', async () => {
    const app = setup()
    app.fetchVersion.mockImplementationOnce(() => {
      throw new TypeError('Could not construct the version request')
    })
    await expect(app.monitor.check()).resolves.toBeUndefined()
    expect(app.reload).not.toHaveBeenCalled()

    await app.monitor.check()
    expect(app.fetchVersion).toHaveBeenCalledTimes(2)
    expect(app.state()).toMatchObject({ available: true })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('pauses automatic reloads if a reload returns the same stale page, but permits retry', async () => {
    const storage = sessionStorage()
    const first = setup({ storage })
    await first.monitor.check()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(first.reload).toHaveBeenCalledOnce()
    first.monitor.dispose()

    const stale = setup({ storage })
    await stale.monitor.check()
    expect(stale.state()).toMatchObject({ available: true, automaticPaused: true })
    await vi.advanceTimersByTimeAsync(60_000)
    stale.monitor.activity()
    stale.monitor.reconsider()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stale.reload).not.toHaveBeenCalled()

    stale.monitor.reloadNow()
    expect(stale.reload).toHaveBeenCalledOnce()
  })

  it('does not let the loop guard prevent a later successful build from updating again', async () => {
    const storage = sessionStorage()
    const first = setup({ storage })
    await first.monitor.check()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(first.reload).toHaveBeenCalledOnce()
    first.monitor.dispose()

    const next = setup({ buildId: 'build-2', storage })
    next.fetchVersion.mockResolvedValue({ buildId: 'build-3' })
    await next.monitor.check()
    expect(next.state()).toMatchObject({ available: true, automaticPaused: false })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(next.reload).toHaveBeenCalledOnce()
  })

  it('remains usable when the browser refuses session storage access', async () => {
    const storage = {
      getItem: () => {
        throw new Error('Storage is disabled')
      },
      setItem: () => {
        throw new Error('Storage is disabled')
      },
    }
    const app = setup({ storage })
    await app.monitor.check()
    app.monitor.reloadNow()
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('requires an explicit retry if saving the reload-loop guard fails', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('Storage quota exceeded')
      },
    }
    const app = setup({ storage })
    await app.monitor.check()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(app.reload).not.toHaveBeenCalled()
    expect(app.state()).toMatchObject({ available: true, automaticPaused: true })
    app.monitor.reloadNow()
    expect(app.reload).toHaveBeenCalledOnce()
  })

  it('cancels scheduled navigation when the monitor is disposed', async () => {
    const app = setup()
    await app.monitor.check()
    app.monitor.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    app.monitor.reconsider()
    app.monitor.activity()
    app.monitor.reloadNow()
    expect(app.reload).not.toHaveBeenCalled()
  })

  it('ignores a version response that arrives after disposal', async () => {
    const app = setup()
    let resolveVersion: (value: unknown) => void
    app.fetchVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveVersion = resolve
        }),
    )
    const pending = app.monitor.check()
    await Promise.resolve()
    expect(app.fetchVersion).toHaveBeenCalledOnce()
    app.monitor.dispose()
    const notificationsAtDisposal = app.onChange.mock.calls.length
    resolveVersion!({ buildId: 'build-2' })
    await pending
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.onChange).toHaveBeenCalledTimes(notificationsAtDisposal)
    expect(app.reload).not.toHaveBeenCalled()
  })
})
