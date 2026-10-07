import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEMO_MARKER_KEY,
  DEMO_STARTUP_TIMEOUT_MS,
  type DemoLifecycle,
  demoStartupStep,
  readDemoMarker,
  runDemoStartup,
  saveDemoMarker,
  startDemo,
  withDemoStartupLock,
} from './demoSession'

function scenario() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  let hasSession = false
  let provisioned = false
  const ready: DemoLifecycle = {
    mode: 'demo',
    status: 'ready',
    expiresAt: Date.now() + 86_400_000,
    orgId: 'private-org',
    orgSlug: 'northstar-private',
    serverNow: Date.now(),
  }
  const deps = {
    storage,
    configuration: vi.fn(async () => ({ mode: 'demo', admissionOpen: true })),
    hasSession: vi.fn(async () => hasSession),
    signIn: vi.fn(async () => {
      hasSession = true
    }),
    authenticate: vi.fn(async () => true),
    current: vi.fn(
      async (): Promise<DemoLifecycle> =>
        provisioned
          ? ready
          : {
              ...ready,
              status: 'unprovisioned',
              orgId: null,
              orgSlug: null,
            },
    ),
    ensureMine: vi.fn(async () => {
      provisioned = true
      return ready
    }),
  }
  return {
    deps,
    ready,
    loseSession: () => {
      hasSession = false
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve: (value: T) => resolve(value) }
}

describe('bounded private demo startup', () => {
  it('times out an unreachable configuration query without allowing its late reply to allocate an identity', async () => {
    vi.useFakeTimers()
    const { deps } = scenario()
    const configuration = deferred<{ mode: string; admissionOpen: boolean }>()
    deps.configuration.mockReturnValue(configuration.promise)
    const result = runDemoStartup((signal) => startDemo({ ...deps, create: true }, signal))
    const refused = expect(result).rejects.toThrow('taking too long')
    await vi.advanceTimersByTimeAsync(DEMO_STARTUP_TIMEOUT_MS)
    await refused
    configuration.resolve({ mode: 'demo', admissionOpen: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.hasSession).not.toHaveBeenCalled()
    expect(deps.signIn).not.toHaveBeenCalled()
    expect(readDemoMarker(deps.storage)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('includes waiting for another tab’s Web Lock in the deadline and cancels its queued callback', async () => {
    vi.useFakeTimers()
    let pending: () => Promise<unknown>
    let waitingSignal: AbortSignal
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          (_name: string, options: { signal: AbortSignal }, operation: () => Promise<unknown>) => {
            pending = operation
            waitingSignal = options.signal
            return new Promise((_resolve, reject) =>
              options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                once: true,
              }),
            )
          },
        ),
      },
    })
    const { deps } = scenario()
    const result = runDemoStartup((signal) => startDemo({ ...deps, create: true }, signal))
    const refused = expect(result).rejects.toThrow('taking too long')
    await vi.advanceTimersByTimeAsync(DEMO_STARTUP_TIMEOUT_MS)
    await refused
    expect(waitingSignal!.aborted).toBe(true)
    // Even a callback incorrectly delivered after cancellation is fenced.
    await expect(Promise.resolve().then(() => pending!())).rejects.toThrow('taking too long')
    expect(deps.configuration).not.toHaveBeenCalled()
    expect(deps.signIn).not.toHaveBeenCalled()
  })

  it('releases a held lock after stalled sign-in and retains the marker through late completion and retry', async () => {
    vi.useFakeTimers()
    let occupied = false
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (
            _name: string,
            _options: { signal: AbortSignal },
            operation: () => Promise<unknown>,
          ) => {
            expect(occupied).toBe(false)
            occupied = true
            try {
              return await operation()
            } finally {
              occupied = false
            }
          },
        ),
      },
    })
    const { deps } = scenario()
    const signIn = deferred<void>()
    deps.signIn.mockReturnValue(signIn.promise)
    const result = runDemoStartup((signal) => startDemo({ ...deps, create: true }, signal))
    const refused = expect(result).rejects.toThrow('taking too long')
    await vi.advanceTimersByTimeAsync(0)
    expect(occupied).toBe(true)
    expect(readDemoMarker(deps.storage)).toEqual({ state: 'started', expiresAt: null })
    await vi.advanceTimersByTimeAsync(DEMO_STARTUP_TIMEOUT_MS)
    await refused
    expect(occupied).toBe(false)
    signIn.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.authenticate).not.toHaveBeenCalled()
    expect(deps.ensureMine).not.toHaveBeenCalled()
    await expect(runDemoStartup((signal) => startDemo(deps, signal))).rejects.toMatchObject({
      phase: 'lost',
    })
    expect(deps.signIn).toHaveBeenCalledOnce()
    expect(readDemoMarker(deps.storage)).toEqual({ state: 'started', expiresAt: null })
  })

  it('also bounds workspace loading and resumes its provisioned identity without a second sign-in', async () => {
    vi.useFakeTimers()
    const { deps, ready } = scenario()
    const workspace = deferred<void>()
    const paint = vi.fn()
    const result = runDemoStartup(async (signal) => {
      await startDemo({ ...deps, create: true }, signal)
      await demoStartupStep(() => workspace.promise, signal)
      paint()
    })
    const refused = expect(result).rejects.toThrow('taking too long')
    await vi.advanceTimersByTimeAsync(DEMO_STARTUP_TIMEOUT_MS)
    await refused
    workspace.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(paint).not.toHaveBeenCalled()
    expect(readDemoMarker(deps.storage)).toEqual({ state: 'started', expiresAt: ready.expiresAt })
    expect(await runDemoStartup((signal) => startDemo(deps, signal))).toEqual(ready)
    expect(deps.signIn).toHaveBeenCalledOnce()
    expect(deps.ensureMine).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an unmounted attempt immediately and never resumes it after transport recovery', async () => {
    vi.useFakeTimers()
    const { deps } = scenario()
    const configuration = deferred<{ mode: string; admissionOpen: boolean }>()
    deps.configuration.mockReturnValue(configuration.promise)
    const controller = new AbortController()
    const result = runDemoStartup(
      (signal) => startDemo({ ...deps, create: true }, signal),
      controller.signal,
    )
    const refused = expect(result).rejects.toThrow('View unmounted')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('View unmounted'))
    await refused
    configuration.resolve({ mode: 'demo', admissionOpen: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.signIn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('private demo startup', () => {
  it('leaves a new visitor on the intro without authenticating or allocating a demo', async () => {
    const { deps } = scenario()
    expect(await startDemo(deps)).toBeNull()
    expect(await startDemo({ ...deps, create: false })).toBeNull()
    expect(deps.configuration).not.toHaveBeenCalled()
    expect(deps.hasSession).not.toHaveBeenCalled()
    expect(deps.signIn).not.toHaveBeenCalled()
    expect(deps.authenticate).not.toHaveBeenCalled()
    expect(deps.current).not.toHaveBeenCalled()
    expect(deps.ensureMine).not.toHaveBeenCalled()
    expect(readDemoMarker(deps.storage)).toBeNull()
  })

  it('creates and signs in only after explicit intent, then resumes without renewing its deadline', async () => {
    const { deps, ready } = scenario()
    expect(await startDemo(deps)).toBeNull()
    expect(await startDemo({ ...deps, create: true })).toEqual(ready)
    vi.spyOn(Date, 'now').mockReturnValue(ready.serverNow + 60 * 60_000)
    expect(await startDemo(deps)).toEqual(ready)
    expect(deps.signIn).toHaveBeenCalledTimes(1)
    expect(deps.authenticate).toHaveBeenCalledTimes(2)
    expect(deps.ensureMine).toHaveBeenCalledTimes(1)
    expect(readDemoMarker(deps.storage)).toEqual({ state: 'started', expiresAt: ready.expiresAt })
  })

  it('retries provisioning with its original identity after a lost seed response', async () => {
    const { deps, ready } = scenario()
    deps.ensureMine.mockRejectedValueOnce(new Error('Response lost'))
    await expect(startDemo({ ...deps, create: true })).rejects.toThrow('Response lost')
    expect(readDemoMarker(deps.storage)).toEqual({ state: 'started', expiresAt: null })
    expect(await startDemo(deps)).toEqual(ready)
    expect(deps.signIn).toHaveBeenCalledTimes(1)
  })

  it('retains an attempted login even when its HTTP response never arrives', async () => {
    const { deps } = scenario()
    deps.signIn.mockRejectedValueOnce(new Error('Response lost'))
    await expect(startDemo({ ...deps, create: true })).rejects.toThrow('Response lost')
    await expect(startDemo(deps)).rejects.toMatchObject({ phase: 'lost' })
    expect(deps.signIn).toHaveBeenCalledTimes(1)
  })

  it('requires Try again after session deletion and after reloading its expired screen', async () => {
    const { deps, ready, loseSession } = scenario()
    await startDemo({ ...deps, create: true })
    loseSession()
    vi.spyOn(Date, 'now').mockReturnValue(ready.expiresAt! + 1)
    await expect(startDemo(deps)).rejects.toMatchObject({ phase: 'expired' })
    saveDemoMarker(deps.storage, { state: 'expired', expiresAt: ready.expiresAt })
    deps.configuration.mockRejectedValue(new Error('Offline'))
    await expect(startDemo(deps)).rejects.toMatchObject({ phase: 'expired' })
    expect(deps.signIn).toHaveBeenCalledTimes(1)
    deps.storage.removeItem(DEMO_MARKER_KEY) // explicit Try again
    deps.configuration.mockResolvedValue({ mode: 'demo', admissionOpen: true })
    expect(await startDemo(deps)).toBeNull()
    await startDemo({ ...deps, create: true })
    expect(deps.signIn).toHaveBeenCalledTimes(2)
  })

  it('refuses the normal backend before allocating an anonymous identity', async () => {
    const { deps } = scenario()
    deps.configuration.mockResolvedValue({ mode: 'normal', admissionOpen: true })
    await expect(startDemo({ ...deps, create: true })).rejects.toThrow('not configured correctly')
    expect(deps.signIn).not.toHaveBeenCalled()
    expect(deps.ensureMine).not.toHaveBeenCalled()
  })

  it('keeps existing demos usable when admission is closed', async () => {
    const { deps, ready } = scenario()
    await startDemo({ ...deps, create: true })
    deps.configuration.mockResolvedValue({ mode: 'demo', admissionOpen: false })
    expect(await startDemo(deps)).toEqual(ready)
    const fresh = scenario().deps
    fresh.configuration.mockResolvedValue({ mode: 'demo', admissionOpen: false })
    await expect(startDemo({ ...fresh, create: true })).rejects.toThrow('temporarily unavailable')
    expect(fresh.signIn).not.toHaveBeenCalled()
  })

  it('checks the backend lifecycle even if the browser clock moves backwards', async () => {
    const { deps, ready } = scenario()
    await startDemo({ ...deps, create: true })
    vi.spyOn(Date, 'now').mockReturnValue(1)
    deps.current.mockResolvedValue({ ...ready, status: 'deleting' })
    await expect(startDemo(deps)).rejects.toMatchObject({ phase: 'expired' })
    expect(deps.signIn).toHaveBeenCalledTimes(1)
  })

  it('serializes explicit creation across tabs and rechecks authentication inside the lock', async () => {
    const { deps } = scenario()
    let queue = Promise.resolve<unknown>(undefined)
    const request = vi.fn((_key: string, operation: () => Promise<unknown>) => {
      const result = queue.then(operation)
      queue = result.catch(() => {})
      return result
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const [first, second] = await Promise.all([
      withDemoStartupLock(() => startDemo({ ...deps, create: true })),
      withDemoStartupLock(() => startDemo({ ...deps, create: true })),
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first.orgId).toBe(second.orgId)
    expect(deps.signIn).toHaveBeenCalledTimes(1)
    expect(deps.ensureMine).toHaveBeenCalledTimes(1)
  })
})
