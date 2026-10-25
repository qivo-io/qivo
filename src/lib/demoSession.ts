import { ConvexError } from 'convex/values'
import { DEMO_UNAVAILABLE } from '../../convex/lib/demoRefusals'

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
  progress: DemoProgress | null
  serverNow: number
}
/** The provisioning steps done so far, and how many there are. */
export type DemoProgress = { step: number; steps: number }
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

const REFUSALS: readonly string[] = Object.values(DEMO_UNAVAILABLE)

/** How a failed demo start or lifecycle check ends the demo: expired, or
 * lost with the demo backend's own sentence when the refusal carries one of
 * them (convex/lib/demoRefusals.ts), never other text a server error
 * carries. Null for any other failure, which the gate offers to retry. */
export function demoEnding(error: unknown): { phase: 'expired' | 'lost'; detail?: string } | null {
  if (error instanceof DemoSessionEnded) return { phase: error.phase }
  if (!(error instanceof ConvexError) || typeof error.data !== 'object' || !error.data) return null
  const data: { reason?: unknown; message?: unknown } = error.data
  if (data.reason === 'demo_expired') return { phase: 'expired' }
  if (data.reason !== 'demo_unavailable') return null
  const detail =
    typeof data.message === 'string' && REFUSALS.includes(data.message) ? data.message : undefined
  return { phase: 'lost', detail }
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

/* The channel on which the tab preparing a demo tells the others it moved. */
const DEMO_STARTUP_CHANNEL = 'qivo-demo-startup'

/** One deadline includes both queued Web Lock time and work performed while
 * holding it. The operation's `progressed` restarts it, so provisioning
 * that keeps moving a step at a time may take longer than one deadline
 * while a stalled step still times out. It also tells tabs waiting for the
 * lock, which restart theirs, so a tab opened during a slow preparation
 * waits for it while a stalled one still times them out. Cancelling the
 * active callback releases the lock even if its underlying transport never
 * settles. */
export async function runDemoStartup<T>(
  operation: (signal: AbortSignal, progressed: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    if (controller.signal.aborted) return
    timer = setTimeout(() => controller.abort(new DemoStartupTimeout()), DEMO_STARTUP_TIMEOUT_MS)
  }
  arm()
  const tabs =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DEMO_STARTUP_CHANNEL)
  tabs?.addEventListener('message', arm)
  const progressed = () => {
    arm()
    tabs?.postMessage('progressed')
  }
  try {
    return await withDemoStartupLock(
      () => demoStartupStep(() => operation(controller.signal, progressed), controller.signal),
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
    tabs?.close()
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
  /** Called before each provisioning step with the steps done so far. */
  onProgress?: (progress: DemoProgress) => void
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
  // The server builds a demo one bounded call at a time, each a few seed
  // steps and each answer a step of progress further until it is ready. An
  // answer that is not refuses, so a stuck demo never loops.
  let ready = current
  while (ready.status === 'unprovisioned') {
    const done = ready.progress?.step ?? 0
    if (ready.progress) deps.onProgress?.(ready.progress)
    ready = await demoStartupStep(deps.ensureMine, signal)
    signal?.throwIfAborted()
    if (ready.status === 'unprovisioned' && (ready.progress?.step ?? 0) <= done)
      throw new Error('Your demo stopped while it was being prepared. Please retry.')
  }
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
