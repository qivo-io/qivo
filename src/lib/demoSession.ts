export const DEMO_MARKER_KEY = 'qivo-demo-lifecycle-v1'
export const DEMO_STARTUP_TIMEOUT_MS = 30_000

export type DemoMarker = {
  state: 'started' | 'expired' | 'lost'
  expiresAt: number | null
}
export type DemoLifecycle = {
  mode: string
  status: 'unprovisioned' | 'ready' | 'deleting' | 'expired' | 'missing'
  expiresAt: number | null
  orgId: string | null
  orgSlug: string | null
  serverNow: number
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readDemoMarker(storage: StorageLike): DemoMarker | null {
  try {
    const value = JSON.parse(storage.getItem(DEMO_MARKER_KEY) || 'null')
    if (
      value &&
      ['started', 'expired', 'lost'].includes(value.state) &&
      (value.expiresAt === null ||
        (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)))
    )
      return { state: value.state, expiresAt: value.expiresAt }
  } catch {
    // Malformed/browser-blocked storage never establishes access.
  }
  return null
}

export function saveDemoMarker(storage: StorageLike, marker: DemoMarker) {
  try {
    storage.setItem(DEMO_MARKER_KEY, JSON.stringify(marker))
  } catch {
    // The live session still works when persistent storage is unavailable.
  }
}

export class DemoSessionEnded extends Error {
  constructor(public readonly phase: 'expired' | 'lost') {
    super(
      phase === 'expired' ? 'Your demo has expired.' : 'Your demo session is no longer available.',
    )
  }
}

export class DemoStartupTimeout extends Error {
  constructor() {
    super('The demo is taking too long to respond. Please retry in a moment.')
  }
}

/** Convex queries and token settlement can remain pending while disconnected.
 * Race their result against cancellation and fence their continuation. The
 * server may finish an already submitted mutation; its owned receipt remains
 * authoritative and the browser retains its marker for a deliberate retry. */
export function demoStartupStep<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return operation()
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

/** A single deadline includes both queued Web Lock time and work performed
 * while holding it. Cancelling the active callback releases the lock even if
 * its underlying transport never settles. */
export async function runDemoStartup<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DemoStartupTimeout()),
    DEMO_STARTUP_TIMEOUT_MS,
  )
  try {
    return await withDemoStartupLock(
      () => demoStartupStep(() => operation(controller.signal), controller.signal),
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

type Startup = {
  storage: StorageLike
  create?: boolean
  configuration: () => Promise<{ mode: string; admissionOpen: boolean }>
  hasSession: () => Promise<boolean>
  signIn: () => Promise<void>
  authenticate: () => Promise<boolean>
  current: () => Promise<DemoLifecycle>
  ensureMine: () => Promise<DemoLifecycle>
}

/** Called inside the browser's shared startup lock. A lost response never
 * silently allocates a replacement identity; the retained marker requires a
 * deliberate Try again, including after the backend has deleted its receipt. */
export async function startDemo(
  deps: Startup,
  signal?: AbortSignal,
): Promise<DemoLifecycle | null> {
  signal?.throwIfAborted()
  const marker = readDemoMarker(deps.storage)
  // Landing on the demo is informational. Only explicit creation intent or
  // a previous attempt may enter authentication and provisioning.
  if (!marker && deps.create !== true) return null
  if (marker?.state === 'expired' || marker?.state === 'lost')
    throw new DemoSessionEnded(marker.state)
  const recoveryPhase = marker?.expiresAt && marker.expiresAt <= Date.now() ? 'expired' : 'lost'
  const config = await demoStartupStep(deps.configuration, signal)
  signal?.throwIfAborted()
  if (config.mode !== 'demo') throw new Error('The demo service is not configured correctly.')
  const hasSession = await demoStartupStep(deps.hasSession, signal)
  signal?.throwIfAborted()
  if (!hasSession) {
    if (marker) throw new DemoSessionEnded(recoveryPhase)
    if (!config.admissionOpen)
      throw new Error('The demo is temporarily unavailable. Please try again later.')
    saveDemoMarker(deps.storage, { state: 'started', expiresAt: null })
    await demoStartupStep(deps.signIn, signal)
  }
  if (!(await demoStartupStep(deps.authenticate, signal))) throw new DemoSessionEnded(recoveryPhase)
  const current = await demoStartupStep(deps.current, signal)
  if (['expired', 'deleting'].includes(current.status)) throw new DemoSessionEnded('expired')
  if (current.status === 'missing') throw new DemoSessionEnded('lost')
  const ready =
    current.status === 'ready' ? current : await demoStartupStep(deps.ensureMine, signal)
  signal?.throwIfAborted()
  if (ready.status !== 'ready' || !ready.expiresAt || !ready.orgId || !ready.orgSlug)
    throw new Error('Your demo is still being prepared. Please retry.')
  saveDemoMarker(deps.storage, { state: 'started', expiresAt: ready.expiresAt })
  return ready
}

export async function withDemoStartupLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    if (signal) return navigator.locks.request('qivo-demo-startup', { signal }, operation)
    return navigator.locks.request('qivo-demo-startup', operation)
  }
  return demoStartupStep(operation, signal)
}

export function demoCountdown(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}
