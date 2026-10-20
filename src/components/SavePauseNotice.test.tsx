// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncStatus, OFFLINE_DELAY_MS, SLOW_SAVE_MS } from '../lib/syncStatus'

/* The operator console's notice (./SavePauseNotice) on a status the test
   drives, and the console's modules, which must not load the planner store
   (the store runs its own page logic). */

vi.mock('../lib/convex', () => ({ convex: {} }))
vi.mock('../store/planner', () => {
  throw new Error('the operator console loaded the planner store')
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.querySelector('[data-float-stack]')?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const shown = () => document.querySelector<HTMLElement>('[data-snapshot-notice]')

describe('the console notice', () => {
  it('says why changes pause, counts the waiting ones, and goes when saving can go on', async () => {
    const { SavePauseNotice } = await import('./SavePauseNotice')
    const status = createSyncStatus()
    status.setSocket({ connected: true, everConnected: true })
    await act(async () => root.render(<SavePauseNotice status={status} />))
    expect(shown()).toBeNull()
    expect(document.querySelector('[data-float-slot="snapshot"] [aria-live]')).not.toBeNull()

    const settle = status.track(true)
    await act(async () => vi.advanceTimersByTime(SLOW_SAVE_MS))
    expect(shown()?.dataset.snapshotNotice).toBe('slow')
    expect(shown()?.textContent).toContain('1 change is still saving.')

    await act(async () => {
      status.setSocket({ connected: false, everConnected: true })
      vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    })
    expect(shown()?.dataset.snapshotNotice).toBe('offline')
    expect(shown()?.textContent).toContain(
      '1 change made before the connection dropped will save when it is back.',
    )

    await act(async () => {
      status.setSocket({ connected: true, everConnected: true })
      settle()
    })
    expect(shown()).toBeNull()
  })

  it('loads without the planner store, as the console does', async () => {
    await expect(import('./SavePauseNotice')).resolves.toBeDefined()
    await expect(import('./AppUpdates')).resolves.toBeDefined()
    await expect(import('../admin/AdminGate')).resolves.toBeDefined()
  })
})
