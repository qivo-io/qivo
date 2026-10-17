// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { TooltipProvider } from './ui/tooltip'

/* The snapshot notice on the real store. The network double delivers the
   first snapshot and keeps each snapshot subscription's error callback, so a
   test can fail the live query mid-session. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

// Imported after resetModules, so they share the store's module instances.
let notice: typeof import('./SnapshotNotice')
let store: typeof import('../store/planner')
let fail: (error: Error) => void
let subscribed: number
let container: HTMLDivElement
let root: Root

// 14:32 local time on the day the tests run
const AS_OF = new Date(2026, 9, 16, 14, 32)

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 16, 15, 5))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  const snap: Snapshot = plannerFixture()
  snap.delivered_at = AS_OF.toISOString()
  subscribed = 0
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, deliver, onError) => {
    if (getFunctionName(ref) === 'snapshot:forMe') {
      subscribed++
      fail = onError
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
    await failWith(new Error('[CONVEX Q(snapshot:forMe)] [Request ID: 3f9c] Server Error'))
    expect(shown()?.textContent).toContain('Qivo can’t load the latest changes')
    expect(shown()?.textContent).toContain(
      'You’re seeing your workspace as of 14:32. Editing is paused until it loads again. Qivo keeps trying.',
    )
    expect(shown()?.textContent).not.toContain('Request ID')
    await act(async () => button('Details')?.click())
    expect(shown()?.textContent).toContain(
      '[CONVEX Q(snapshot:forMe)] [Request ID: 3f9c] Server Error',
    )
    expect(button('Hide details')?.getAttribute('aria-expanded')).toBe('true')
    // the error text stays selectable for copying
    expect(
      pressKeepsFocus(
        document.getElementById(button('Hide details')?.getAttribute('aria-controls') ?? ''),
      ),
    ).toBe(false)
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

describe('asOfText', () => {
  it('names the day when the view went stale on an earlier one', () => {
    expect(notice.asOfText(AS_OF.toISOString(), new Date(2026, 9, 16, 18))).toBe('14:32')
    expect(notice.asOfText(AS_OF.toISOString(), new Date(2026, 9, 17, 9))).toBe('16 Oct, 14:32')
  })
})
