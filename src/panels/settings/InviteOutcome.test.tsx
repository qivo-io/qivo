// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* The line under the project invite form: what it says about the invitation
   email to the seat the form just created, as invites.deliveries changes. */

type Row = { profile_id: string; email: string; state: string; since: string }
const network = vi.hoisted(() => ({
  onUpdate: vi.fn(),
  push: (_rows: Row[] | null) => {},
}))
vi.mock('../../lib/convex', () => ({ convex: network }))

// the component's module graph is large; load it once, outside the tests' time limit
let InviteOutcome: typeof import('./UserControls').InviteOutcome
beforeAll(async () => {
  InviteOutcome = (await import('./UserControls')).InviteOutcome
}, 60_000)

let root: Root
let host: HTMLDivElement
beforeEach(() => {
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
})

const seat = 'seat-1'
const email = 'Guest.New@example.test'
const row = (state: string, address = 'guest.new@example.test'): Row => ({
  profile_id: seat,
  email: address,
  state,
  since: new Date().toISOString(),
})

async function mount() {
  act(() => root.render(<InviteOutcome orgId="org-1" seat={seat} email={email} />))
}
const push = (rows: Row[] | null) => act(() => network.push(rows))
const said = () => host.querySelector('[data-invite-outcome]')?.textContent ?? null

describe('the outcome of an invitation from the project form', () => {
  it('says nothing until the deliveries load, then follows the send', async () => {
    await mount()
    expect(said()).toBeNull()
    push([])
    expect(said()).toBe(`Sending the invitation email to ${email}…`)
    push([row('sending')])
    expect(said()).toBe(`Sending the invitation email to ${email}…`)
    push([row('unsent')])
    expect(said()).toBe(
      `${email}: The invitation email could not be sent. Check the address. They can join later by creating an account with it, once Qivo can email them.`,
    )
  })

  it('keeps the result once the seat is claimed and leaves the list', async () => {
    await mount()
    push([row('sent')])
    expect(said()).toBe(`Invitation email sent to ${email}.`)
    push([])
    expect(said()).toBe(`Invitation email sent to ${email}.`)
  })

  it('reports nothing for a send to an address corrected elsewhere', async () => {
    await mount()
    push([row('sent', 'corrected@example.test')])
    expect(said()).toBeNull()
  })

  it('stops saying Sending when no send is recorded within two minutes', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      push([])
      expect(said()).toBe(`Sending the invitation email to ${email}…`)
      act(() => vi.advanceTimersByTime(2 * 60_000 + 1))
      expect(said()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a send that never settles uncertain after five minutes, on a page left open', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      push([row('sending')])
      expect(said()).toBe(`Sending the invitation email to ${email}…`)
      act(() => vi.advanceTimersByTime(5 * 60_000 + 1))
      expect(said()).toBe(
        `${email}: The mail service did not confirm the invitation email. If it does not arrive, they can still join by creating an account with this address.`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not claim a send is still in flight when its row vanished or the query failed', async () => {
    await mount()
    push([row('sending')])
    push([])
    expect(said()).toBeNull()
    push(null)
    expect(said()).toBeNull()
  })
})
