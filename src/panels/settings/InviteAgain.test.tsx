// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { UserVM } from '../../store/planner'

/* A pending seat whose invitation email the hourly cap held back: it says
   so, and its Send invitation waits until the hour frees a send. */

type Row = { profile_id: string; email: string; state: string; free_at?: string | null }
const network = vi.hoisted(() => ({
  onUpdate: vi.fn(),
  mutation: vi.fn(),
  query: vi.fn(),
  push: (_rows: Row[]) => {},
}))
vi.mock('../../lib/convex', () => ({ convex: network }))
// UserControls reaches the store, whose auth client needs a backend URL
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: null }) },
  signOut: vi.fn(),
}))

// the component's module graph is large; load it once, outside the tests' time limit
let InviteLabel: typeof import('./UserControls').InviteLabel
let P: typeof import('../../store/planner').P
beforeAll(async () => {
  InviteLabel = (await import('./UserControls')).InviteLabel
  P = (await import('../../store/planner')).P
}, 60_000)

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-21T10:00:00.000Z') })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    network.push = next
    return () => {}
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const user = { id: 'seat-1', org: 'org-1', pending: true } as UserVM
const control = () => host.querySelector<HTMLButtonElement>('[data-invite-again]')

describe('a held invitation', () => {
  it('offers Send invitation once the hour frees a send, and only then sends', async () => {
    const again = vi.spyOn(P, 'sendInvitationAgain').mockResolvedValue(true)
    act(() =>
      root.render(
        <TooltipProvider>
          <InviteLabel user={user} />
        </TooltipProvider>,
      ),
    )
    expect(control()).toBeNull()
    act(() =>
      network.push([
        {
          profile_id: user.id,
          email: 'anna@example.test',
          state: 'held',
          free_at: '2026-10-21T10:20:00.000Z',
        },
      ]),
    )
    expect(host.querySelector('[data-invite-state]')?.textContent).toBe('invitation not sent')
    expect(control()?.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(20 * 60_000 + 1000))
    expect(control()?.disabled).toBe(false)
    await act(async () => control()?.click())
    expect(again).toHaveBeenCalledWith('org-1', 'seat-1')
    // a delivered invitation offers nothing
    act(() => network.push([{ profile_id: user.id, email: 'anna@example.test', state: 'sent' }]))
    expect(control()).toBeNull()
  })
})
