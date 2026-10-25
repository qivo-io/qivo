// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeatsDeleting } from '../../convex/lib/workspaceJoin'
import { asOfText } from '../lib/noticeText'
import { SEATS_DELETING } from '../store/guard/liveDouble.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { TooltipProvider } from './ui/tooltip'

/* The snapshot notice on the real store. The network double delivers the
   first snapshot and keeps each snapshot subscription's callbacks, so a test
   can fail the live query or deliver a later result mid-session. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
// The note of the page under test. Each boot opens a new page, and every
// other page has closed (Web Locks). Mocked modules outlive resetModules, so
// the mock forwards to the page's own note.
const page = vi.hoisted(() => ({
  note: null as null | ReturnType<typeof import('../lib/unconfirmedNote')['createUnconfirmedNote']>,
}))
vi.mock('../lib/unconfirmedNote', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/unconfirmedNote')>()
  const open = () =>
    (page.note = original.createUnconfirmedNote({
      storage: () => localStorage,
      page: crypto.randomUUID(),
      livePages: async () => new Set(),
    }))
  return {
    ...original,
    unconfirmedNote: {
      add: (...args: Parameters<NonNullable<typeof page.note>['add']>) =>
        (page.note ?? open()).add(...args),
      forgetAll: () => (page.note ?? open()).forgetAll(),
      collect: (scopes: Iterable<string>) => (page.note ?? open()).collect(scopes),
    },
  }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

// Imported after resetModules, so they share the store's module instances.
let notice: typeof import('./SnapshotNotice')
let store: typeof import('../store/planner')
let fail: (error: Error) => void
let deliverLater: (snap: Snapshot | SeatsDeleting | null) => void
let subscribed: number
let firstSnapshot: Snapshot
let container: HTMLDivElement
let root: Root

// 14:32 local time on the day the tests run
const AS_OF = new Date(2026, 9, 16, 14, 32)

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // jsdom has no layout, so the column's measuring sees nothing to measure
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 16, 15, 5))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  const snap: Snapshot = plannerFixture()
  snap.delivered_at = AS_OF.toISOString()
  firstSnapshot = snap
  subscribed = 0
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, deliver, onError) => {
    if (getFunctionName(ref) === 'workspace:whole') {
      subscribed++
      fail = onError
      deliverLater = deliver
      if (subscribed === 1) deliver(structuredClone(snap))
    }
    return () => {}
  })
  store = await import('../store/planner')
  await store.initStore()
  notice = await import('./SnapshotNotice')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <notice.SnapshotNotice />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.querySelector('[data-float-stack]')?.remove()
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const shown = () => document.querySelector<HTMLElement>('[data-snapshot-notice]')
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-snapshot-notice] button')].find(
    (element) => element.textContent === label,
  )
async function failWith(error: Error) {
  await act(async () => fail(error))
}
/** Presses the mouse on `target` and answers whether the notice kept focus
    where it was (the default action prevented). */
function pressKeepsFocus(target: Element | null | undefined) {
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target?.dispatchEvent(press)
  return press.defaultPrevented
}

describe('SnapshotNotice', () => {
  it('renders nothing while the snapshot is current', () => {
    expect(shown()).toBeNull()
    // the live region is in place before any trouble, in the floating column
    expect(document.querySelector('[data-float-slot="snapshot"] [aria-live="polite"]')).not.toBe(
      null,
    )
  })

  it('says when the view was current, that editing is paused, and shows the error on request', async () => {
    await failWith(new Error('[CONVEX Q(workspace:tasks)] [Request ID: 3f9c] Server Error'))
    expect(shown()?.textContent).toContain('Qivo can’t load the latest changes')
    expect(shown()?.textContent).toContain(
      'You’re seeing your workspace as of 14:32. Editing is paused until it loads again. Qivo keeps trying.',
    )
    expect(shown()?.textContent).not.toContain('Request ID')
    await act(async () => button('Details')?.click())
    expect(shown()?.textContent).toContain(
      '[CONVEX Q(workspace:tasks)] [Request ID: 3f9c] Server Error',
    )
    expect(button('Hide details')?.getAttribute('aria-expanded')).toBe('true')
    // the error text stays selectable for copying
    expect(
      pressKeepsFocus(
        document.getElementById(button('Hide details')?.getAttribute('aria-controls') ?? ''),
      ),
    ).toBe(false)
  })

  it('shows the sentence of a part that refused to load, as text, and does not promise to keep trying', async () => {
    const sentence =
      'One part of this organization holds more than Qivo can load at once. Contact support so we can help reduce it.'
    await failWith(new ConvexError({ code: 'rule', message: sentence }))
    expect(shown()?.textContent).toContain(
      `You’re seeing your workspace as of 14:32. ${sentence} Editing is paused until it loads again.`,
    )
    expect(shown()?.textContent).not.toContain('keeps trying')
    await act(async () => button('Details')?.click())
    expect(shown()?.textContent).not.toContain('"code"')
    expect(button('Try again')).toBeDefined()
  })

  it('offers a reload, not a retry, after the sign-in ended', async () => {
    await failWith(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    expect(shown()?.textContent).toContain('You’re signed out')
    expect(shown()?.textContent).toContain(
      'Reload Qivo to sign in again. Text you haven’t saved will be lost.',
    )
    expect(button('Reload')).toBeDefined()
    expect(button('Try again')).toBeUndefined()
    expect(button('Details')).toBeUndefined()
  })

  it('says access ended and offers a reload once every seat is gone', async () => {
    await act(async () => deliverLater(null))
    expect(shown()?.dataset.snapshotNotice).toBe('no_access')
    expect(shown()?.textContent).toContain('You no longer have access to this workspace')
    expect(shown()?.textContent).toContain(
      'You’re seeing your workspace as of 14:32. Reload Qivo to continue. Text you haven’t saved will be lost.',
    )
    expect(button('Reload')).toBeDefined()
    expect(button('Try again')).toBeUndefined()
    expect(button('Details')).toBeUndefined()
  })

  it('says the organization is being deleted when its deletion took the last seats', async () => {
    await act(async () => deliverLater(SEATS_DELETING))
    expect(shown()?.dataset.snapshotNotice).toBe('no_access')
    expect(shown()?.textContent).toContain('This organization is being deleted')
    expect(shown()?.textContent).not.toContain('You no longer have access')
    expect(button('Reload')).toBeDefined()
    expect(button('Try again')).toBeUndefined()
    // once the deletion is over, there is no seat and nothing more to say
    await act(async () => deliverLater(null))
    expect(shown()?.textContent).toContain('You no longer have access to this workspace')
  })

  it('tries again through the store and holds the button while it runs', async () => {
    await failWith(new Error('Server Error'))
    const retry = vi.spyOn(store.P, 'retrySnapshot')
    // pressing it leaves focus in an open dialog, whose field keeps its text
    expect(pressKeepsFocus(button('Try again'))).toBe(true)
    await act(async () => button('Try again')?.click())
    expect(retry).toHaveBeenCalledTimes(1)
    expect(subscribed).toBe(2)
    expect(button('Trying again…')?.disabled).toBe(true)
    expect(button('Try again')).toBeUndefined()
  })
})

describe('SnapshotNotice while Qivo cannot save', () => {
  async function offline() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const { syncStatus, OFFLINE_DELAY_MS } = await import('../lib/syncStatus')
    await act(async () => {
      syncStatus.setSocket({ connected: true, everConnected: true })
      syncStatus.setSocket({ connected: false, everConnected: true })
      vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    })
    return syncStatus
  }

  it('says editing is paused offline and counts the changes still waiting', async () => {
    network.mutation.mockReturnValue(new Promise(() => {}))
    void store.P.addTeam('Field crew')
    await offline()
    expect(shown()?.dataset.snapshotNotice).toBe('offline')
    expect(shown()?.textContent).toContain('You’re offline')
    expect(shown()?.textContent).toContain(
      'Editing is paused until the connection is back. 1 change made before the connection dropped will save when it is back. Keep Qivo open until then.',
    )
    expect(shown()?.closest('[aria-live="polite"]')).not.toBeNull()
    // nothing hides it while editing is paused
    expect(document.querySelectorAll('[data-snapshot-notice] button')).toHaveLength(0)
  })

  it('puts snapshot trouble before the connection, and the connection before the crash note', async () => {
    const status = await offline()
    await failWith(new Error('[CONVEX Q(workspace:tasks)] Server Error'))
    expect(shown()?.dataset.snapshotNotice).toBe('failed')
    expect(document.querySelectorAll('[data-snapshot-notice]')).toHaveLength(1)
    await act(async () => deliverLater(plannerFixture()))
    expect(shown()?.dataset.snapshotNotice).toBe('offline')
    await act(async () => {
      status.setSocket({ connected: true, everConnected: true })
    })
    expect(shown()).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith('Back online. Editing is on again.', 'success')
  })

  it('says how long saving takes, and nothing once it caught up', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const { syncStatus, SLOW_SAVE_MS } = await import('../lib/syncStatus')
    let answer = () => {}
    network.mutation.mockReturnValue(new Promise<null>((resolve) => (answer = () => resolve(null))))
    await act(async () => {
      syncStatus.setSocket({ connected: true, everConnected: true })
      void store.P.addTeam('Field crew')
      vi.advanceTimersByTime(SLOW_SAVE_MS)
    })
    expect(shown()?.dataset.snapshotNotice).toBe('slow')
    expect(shown()?.textContent).toContain('Saving is taking longer than usual')
    expect(shown()?.textContent).toContain(
      'Editing is paused until it finishes. 1 change is still saving.',
    )
    await act(async () => answer())
    expect(shown()).toBeNull()
  })
})

describe('SnapshotNotice after a page closed with changes unconfirmed', () => {
  it('tells which change it could not confirm until dismissed', async () => {
    const { P } = store
    localStorage.setItem(
      `qivo.unconfirmed.v1:${P.org.id}:${P.CURRENT_USER}:closed-page`,
      JSON.stringify([{ task: 'QN-3', what: 'title', id: '1', at: Date.now() }]),
    )
    // the next start, on the same browser storage
    page.note = null
    await act(async () => {
      const booted = store.initStore()
      await vi.waitFor(() => expect(subscribed).toBe(2))
      deliverLater(structuredClone(firstSnapshot))
      await booted
    })
    expect(shown()?.dataset.snapshotNotice).toBe('unconfirmed')
    expect(shown()?.textContent).toContain(
      'Qivo closed before it could confirm 1 change to QN-3 (title). Check the task.',
    )
    expect(Object.keys(localStorage).filter((key) => key.startsWith('qivo.unconfirmed'))).toEqual(
      [],
    )
    await act(async () => button('Dismiss')?.click())
    expect(shown()).toBeNull()
  })
})

describe('asOfText', () => {
  it('names the day when the view went stale on an earlier one', () => {
    expect(asOfText(AS_OF.toISOString(), new Date(2026, 9, 16, 18))).toBe('14:32')
    expect(asOfText(AS_OF.toISOString(), new Date(2026, 9, 17, 9))).toBe('16 Oct, 14:32')
  })
})
