// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

/* What the project invite form says about the invitation email to the seat
   it just created, as invites.deliveries changes: a toast once a send went
   out, and a sentence under the form for one that did not. It reads that
   one seat's row, and stops while the tab is hidden. */

type Row = {
  profile_id: string
  email: string
  state: string
  since: string
  free_at?: string | null
}
const network = vi.hoisted(() => ({
  onUpdate: vi.fn(),
  push: (_rows: Row[] | null) => {},
}))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
// UserControls reaches the store, whose auth client needs a backend URL
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: null }) },
  signOut: vi.fn(),
}))

// the component's module graph is large; load it once, outside the tests' time limit
let InviteOutcome: typeof import('./UserControls').InviteOutcome
beforeAll(async () => {
  InviteOutcome = (await import('./UserControls')).InviteOutcome
}, 60_000)

let root: Root
let host: HTMLDivElement
let toast: ReturnType<typeof vi.fn<(message: string, tone?: string) => void>>
beforeEach(() => {
  toast = vi.fn<(message: string, tone?: string) => void>()
  window.showToast = toast
  network.onUpdate.mockImplementation((_ref, _args, next, fail) => {
    network.push = (rows) => (rows === null ? fail(new Error('refused')) : next(rows))
    return () => {}
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(document, 'visibilityState')
})

const seat = 'seat-1'
const email = 'Guest.New@example.test'
// when the first send and a later Send invitation were reserved, recent
// enough that neither reads as uncertain
const FIRST = new Date().toISOString()
const AGAIN = new Date(Date.now() + 1000).toISOString()
const row = (state: string, address = 'guest.new@example.test', since = FIRST): Row => ({
  profile_id: seat,
  email: address,
  state,
  since,
})

async function mount(typed = email) {
  act(() =>
    root.render(
      <TooltipProvider>
        <InviteOutcome orgId="org-1" seat={seat} email={typed} />
      </TooltipProvider>,
    ),
  )
}
/** Mounts the outcome as development does, its effects run twice. */
async function mountStrict() {
  act(() =>
    root.render(
      <StrictMode>
        <TooltipProvider>
          <InviteOutcome orgId="org-1" seat={seat} email={email} />
        </TooltipProvider>
      </StrictMode>,
    ),
  )
}
const setVisibility = (value: 'visible' | 'hidden') =>
  act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  })
const unsent = `${email}: The invitation email could not be sent. Check the address. They can join later by creating an account with it, once Qivo can email them.`
const push = (rows: Row[] | null) => act(() => network.push(rows))
// the sentence, without the Send invitation control after it
const said = () => host.querySelector('[data-invite-outcome]')?.firstChild?.textContent ?? null

describe('the outcome of an invitation from the project form', () => {
  it('reads its own seat alone, and nothing while the tab is hidden', async () => {
    const stop = vi.fn()
    network.onUpdate.mockImplementation((_ref, _args, next, fail) => {
      network.push = (rows) => (rows === null ? fail(new Error('refused')) : next(rows))
      return stop
    })
    await mount()
    expect(network.onUpdate.mock.calls.at(-1)?.[1]).toEqual({
      org_id: 'org-1',
      profile_ids: [seat],
    })
    const watched = network.onUpdate.mock.calls.length
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(network.onUpdate.mock.calls.length).toBe(watched)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    // shown again, it reads once more
    expect(network.onUpdate.mock.calls.length).toBe(watched + 1)
  })

  it('shows nothing while the email is on its way, and a sentence once it could not be sent', async () => {
    await mount()
    push([])
    expect(said()).toBeNull()
    push([row('sending')])
    expect(said()).toBeNull()
    push([row('unsent')])
    expect(said()).toBe(unsent)
    expect(host.querySelector('[data-invite-again]')?.textContent).toBe('Send invitation')
    expect(toast).not.toHaveBeenCalled()
  })

  it('toasts a send that went out once, and shows nothing for it', async () => {
    await mountStrict()
    push([row('sent')])
    expect(said()).toBeNull()
    expect(toast.mock.calls).toEqual([[`Invitation email sent to ${email}.`]])
    // hidden and shown again, the read delivers the same send once more
    await setVisibility('hidden')
    await setVisibility('visible')
    push([row('sent')])
    expect(toast).toHaveBeenCalledTimes(1)
    // the seat claimed, its row leaves the list, and no sentence comes back
    push([])
    expect(said()).toBeNull()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('drops the failure once Send invitation goes out, with one toast', async () => {
    await mountStrict()
    push([row('unsent')])
    expect(said()).toBe(unsent)
    push([row('sending', undefined, AGAIN)])
    expect(said()).toBeNull()
    push([row('sent', undefined, AGAIN)])
    expect(said()).toBeNull()
    expect(toast.mock.calls).toEqual([[`Invitation email sent to ${email}.`]])
  })

  it('keeps the sentence of a failed email once the seat is claimed and leaves the list', async () => {
    await mount()
    push([row('unsent')])
    push([])
    expect(said()).toBe(unsent)
    expect(host.querySelector('[data-invite-again]')).toBeNull()
  })

  it('follows the send to an address with a Unicode domain, stored as punycode', async () => {
    await mount('Anna@Bücher.DE')
    push([row('sent', 'anna@xn--bcher-kva.de')])
    expect(toast).toHaveBeenCalledWith('Invitation email sent to Anna@Bücher.DE.')
  })

  it('reports nothing for a send to an address corrected elsewhere', async () => {
    await mount()
    push([row('unsent', 'corrected@example.test')])
    expect(said()).toBeNull()
    push([row('sent', 'corrected@example.test')])
    expect(toast).not.toHaveBeenCalled()
    // the send to its own address it does report
    push([row('sent')])
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('turns a send that never settles uncertain after five minutes, on a page left open', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      push([row('sending', undefined, new Date().toISOString())])
      expect(said()).toBeNull()
      act(() => vi.advanceTimersByTime(5 * 60_000 + 1))
      expect(said()).toBe(
        `${email}: The mail service did not confirm the invitation email. If it does not arrive, they can still join by creating an account with this address.`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('says when a held invitation can go again, and offers to send it', async () => {
    await mount()
    const freeAt = new Date(Date.now() + 10 * 60_000)
    push([{ ...row('held'), free_at: freeAt.toISOString() }])
    const hhmm = `${String(freeAt.getHours()).padStart(2, '0')}:${String(freeAt.getMinutes()).padStart(2, '0')}`
    expect(said()).toContain(`Send it again after ${hhmm}.`)
    expect(host.querySelector('[data-invite-again]')?.textContent).toBe(`Send after ${hhmm}`)
  })
})
