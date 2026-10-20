// @vitest-environment jsdom
import { act, type ReactNode, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lazyFromModule, preloadModule } from '../lib/lazyModule'
import {
  syncStatus as appStatus,
  createSyncStatus,
  OFFLINE_DELAY_MS,
  type SyncStatus,
} from '../lib/syncStatus'
import { TooltipProvider } from './ui/tooltip'
import { ViewBoundary } from './ViewBoundary'

/* A lazily loaded view (lib/lazyModule) inside the boundary, on a status the
   test drives: the view's code fails or waits, and the boundary shows why
   and loads it again once Qivo can reach the server. */

let container: HTMLDivElement
let root: Root
let status: SyncStatus

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  status = createSyncStatus()
  status.setSocket({ connected: true, everConnected: true })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Renders `node` as the app does, inside its tooltip provider. */
const show = (node: ReactNode) =>
  act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))

const goOffline = () =>
  act(async () => {
    status.setSocket({ connected: false, everConnected: true })
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
  })
const reconnect = () =>
  act(async () => {
    status.setSocket({ connected: true, everConnected: true })
    await vi.advanceTimersByTimeAsync(0)
  })

/** A view whose import fails `failures` times before it loads. */
function flakyView(failures: number) {
  const importModule = vi.fn(async () => {
    if (failures-- > 0) throw new Error('Failed to fetch dynamically imported module')
    return { View: () => <p>Board</p> }
  })
  const View = lazyFromModule(preloadModule(importModule, status), (module) => module.View)
  return { View, importModule }
}

describe('a view whose code did not load', () => {
  it('waits while offline without a download and opens when the connection is back', async () => {
    const { View, importModule } = flakyView(0)
    await goOffline()
    await show(
      <ViewBoundary onBack={() => {}} status={status}>
        <Suspense fallback="Loading">
          <View />
        </Suspense>
      </ViewBoundary>,
    )
    expect(container.textContent).toContain('You’re offline')
    expect(container.textContent).toContain('This view opens when the connection is back.')
    expect(container.textContent).not.toContain('Reload')
    expect(importModule).not.toHaveBeenCalled()
    await reconnect()
    expect(container.textContent).toBe('Board')
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('offers a reload after a failure while Qivo can save, and loads afresh after a pause', async () => {
    const { View, importModule } = flakyView(1)
    await show(
      <ViewBoundary onBack={() => {}} status={status}>
        <Suspense fallback="Loading">
          <View />
        </Suspense>
      </ViewBoundary>,
    )
    expect(container.textContent).toContain('This view could not be loaded.')
    expect(container.querySelector('button:last-child')?.textContent).toBe('Reload')
    // the drop is noticed after the download failed
    await goOffline()
    expect(container.textContent).toContain('This view opens when the connection is back.')
    await reconnect()
    expect(container.textContent).toBe('Board')
    expect(importModule).toHaveBeenCalledTimes(2)
  })

  it('loads afresh when reopened after it was closed during a pause', async () => {
    // the app's own status, which no mounted boundary watches meanwhile
    appStatus.setSocket({ connected: true, everConnected: true })
    const importModule = vi.fn(async () => ({ View: () => <p>Board</p> }))
    const View = lazyFromModule(preloadModule(importModule), (module) => module.View)
    const view = (
      <ViewBoundary onBack={() => {}}>
        <Suspense fallback="Loading">
          <View />
        </Suspense>
      </ViewBoundary>
    )
    await act(async () => {
      appStatus.setSocket({ connected: false, everConnected: true })
      vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    })
    await show(view)
    expect(container.textContent).toContain('This view opens when the connection is back.')
    await show(null)
    await act(async () => appStatus.setSocket({ connected: true, everConnected: true }))
    await show(view)
    expect(container.textContent).toBe('Board')
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('shows its stand-in during a pause and hands a failure while Qivo can save up', async () => {
    const { View, importModule } = flakyView(1)
    await goOffline()
    await show(
      <ViewBoundary onBack={() => {}} status={status}>
        <p>Task</p>
        <ViewBoundary whilePaused={<p>Plain text</p>} status={status}>
          <Suspense fallback={<p>Plain text</p>}>
            <View />
          </Suspense>
        </ViewBoundary>
      </ViewBoundary>,
    )
    expect(container.textContent).toBe('TaskPlain text')
    await reconnect()
    expect(importModule).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('This view could not be loaded.')
    expect(container.textContent).not.toContain('Task')
  })
})
