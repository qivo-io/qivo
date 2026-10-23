// @vitest-environment jsdom
import { act, type ReactNode, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeWaitsForConnection, lazyFromModule, preloadModule } from '../lib/lazyModule'
import { createSyncStatus, OFFLINE_DELAY_MS, type SyncStatus } from '../lib/syncStatus'
import { KeptView } from './KeptView'
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

/** Drops the socket. With `notice`, long enough that Qivo counts as
    offline; without, the boundary sees only that the connection is down. */
const goOffline = ({ notice = true } = {}) =>
  act(async () => {
    status.setSocket({ connected: false, everConnected: true })
    if (notice) vi.advanceTimersByTime(OFFLINE_DELAY_MS)
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
  const View = lazyFromModule(preloadModule(importModule, status), (module) => module.View, status)
  return { View, importModule }
}

/** `View` as App shows a page, in its own boundary. */
const page = (View: ReturnType<typeof flakyView>['View']) => (
  <ViewBoundary onBack={() => {}} status={status}>
    <Suspense fallback="Loading">
      <View />
    </Suspense>
  </ViewBoundary>
)

describe('a view whose code did not load', () => {
  it('waits without a download while the connection is down and opens when it is back', async () => {
    for (const notice of [true, false]) {
      const { View, importModule } = flakyView(0)
      await goOffline({ notice })
      await show(page(View))
      expect(container.textContent).toContain('You’re offline')
      expect(container.textContent).toContain('This view opens when the connection is back.')
      expect(container.textContent).not.toContain('Reload')
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(importModule).not.toHaveBeenCalled()
      await reconnect()
      expect(container.textContent).toBe('Board')
      expect(importModule).toHaveBeenCalledTimes(1)
      await show(null)
    }
  })

  it('offers a reload after a failed download, and promises nothing during a later pause', async () => {
    const { View, importModule } = flakyView(1)
    await show(page(View))
    expect(container.textContent).toContain('This view could not be loaded.')
    expect(container.querySelector('button:last-child')?.textContent).toBe('Reload')
    // the drop is noticed after the download failed: the failure stays
    await goOffline()
    expect(container.textContent).toContain('This view could not be loaded.')
    await reconnect()
    expect(container.textContent).toContain('This view could not be loaded.')
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('loads afresh when reopened after it was closed while waiting', async () => {
    const { View, importModule } = flakyView(0)
    await goOffline()
    await show(page(View))
    expect(container.textContent).toContain('This view opens when the connection is back.')
    await show(null)
    await reconnect()
    await show(page(View))
    expect(container.textContent).toBe('Board')
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('shows its stand-in while waiting and hands a failed download up', async () => {
    const { View, importModule } = flakyView(1)
    await goOffline()
    await show(
      <ViewBoundary onBack={() => {}} status={status}>
        <p>Task</p>
        <ViewBoundary whileWaiting={<p>Plain text</p>} status={status}>
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

  it('mounts again at once when the connection came back before it caught the refusal', async () => {
    // the refusal reached the boundary only after the status stopped waiting;
    // React renders the child more than once before the boundary takes it
    let refusals = 3
    function Stale() {
      if (refusals-- > 0) throw new CodeWaitsForConnection()
      return <p>Board</p>
    }
    await show(
      <ViewBoundary onBack={() => {}} status={status}>
        <Stale />
      </ViewBoundary>,
    )
    expect(container.textContent).toBe('Board')
  })

  it('in a kept view, opens when it shows again after the connection came back while hidden', async () => {
    const { View, importModule } = flakyView(0)
    const kept = (shown: boolean) => (
      <KeptView view="kanban" shown={shown} className="view">
        {page(View)}
      </KeptView>
    )
    await goOffline()
    await show(kept(true))
    expect(container.textContent).toContain('This view opens when the connection is back.')
    // hidden, the boundary does not hear the connection come back
    await show(kept(false))
    await reconnect()
    await show(kept(true))
    expect(container.textContent).toBe('Board')
    expect(importModule).toHaveBeenCalledTimes(1)
  })

  it('in a kept view, tries a view that failed again when it shows again', async () => {
    let broken = true
    function Fragile() {
      if (broken) throw new Error('render failed')
      return <p>Board</p>
    }
    const kept = (shown: boolean) => (
      <KeptView view="kanban" shown={shown} className="view">
        <ViewBoundary onBack={() => {}} status={status}>
          <Fragile />
        </ViewBoundary>
      </KeptView>
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await show(kept(true))
    expect(container.textContent).toContain('This view could not be loaded.')
    broken = false
    await show(kept(false))
    await show(kept(true))
    expect(container.textContent).toBe('Board')
  })

  it('names why in an overlay for screen readers', async () => {
    const { View } = flakyView(0)
    await goOffline()
    await show(
      <ViewBoundary onBack={() => {}} overlay status={status}>
        <Suspense fallback={null}>
          <View />
        </Suspense>
      </ViewBoundary>,
    )
    const dialog = document.querySelector('[role="dialog"]')
    const described = dialog?.getAttribute('aria-describedby')
    expect(described && document.getElementById(described)?.textContent).toBe(
      'This view opens when the connection is back.',
    )
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('You’re offline')
  })
})
