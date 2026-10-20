import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'

/* The console's changes pause with the app's (./convex.ts). The Convex
   client is a double that records what is sent; the status is the real one
   the console's notice reads. */

const client = vi.hoisted(() => ({
  socket: true,
  mutation: vi.fn(),
  action: vi.fn(),
  connectionState: () => ({ isWebSocketConnected: client.socket }),
}))
vi.mock('../lib/convex', () => ({ convex: client }))

let gate: typeof import('./convex')
let sync: typeof import('../lib/syncStatus')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  client.socket = true
  client.mutation.mockReset().mockResolvedValue(null)
  client.action.mockReset().mockResolvedValue(null)
  sync = await import('../lib/syncStatus')
  gate = await import('./convex')
  sync.syncStatus.setSocket({ connected: true, everConnected: true })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Drops the socket for long enough that saving pauses. */
function goOffline() {
  client.socket = false
  sync.syncStatus.setSocket({ connected: false, everConnected: true })
  vi.advanceTimersByTime(sync.OFFLINE_DELAY_MS)
  expect(sync.syncStatus.pause()?.kind).toBe('offline')
}

const OFFLINE = 'You’re offline. Editing is paused until the connection is back.'

describe('console changes', () => {
  it('sends a change while Qivo can save, and counts it until it is answered', async () => {
    let answer: (value: null) => void = () => {}
    client.mutation.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const sent = gate.sendMutation(api.adminOrgs.cancelInvite, { profile_id: 'p1' })
    expect(client.mutation).toHaveBeenCalledOnce()
    expect(sync.syncStatus.unconfirmed()).toBe(1)
    answer(null)
    await sent
    expect(sync.syncStatus.unconfirmed()).toBe(0)
    await gate.runAction(api.adminAuth.banUser, { email: 'a@example.test' })
    expect(client.action).toHaveBeenCalledOnce()
  })

  it('refuses a mutation and a changing action offline before sending them', async () => {
    goOffline()
    await expect(
      gate.sendMutation(api.adminOrgs.cancelInvite, { profile_id: 'p1' }),
    ).rejects.toThrow(OFFLINE)
    await expect(
      gate.runAction(api.adminAuth.banUser, { email: 'a@example.test' }),
    ).rejects.toThrow(OFFLINE)
    expect(client.mutation).not.toHaveBeenCalled()
    expect(client.action).not.toHaveBeenCalled()
    expect(sync.syncStatus.unconfirmed()).toBe(0)
  })

  it('refuses a changing action on a dropped socket before the pause, so Convex never queues it', async () => {
    client.socket = false
    sync.syncStatus.setSocket({ connected: false, everConnected: true })
    expect(sync.syncStatus.pause()).toBeNull()
    await expect(gate.runAction(api.adminOrgs.createOrganization, {} as never)).rejects.toThrow(
      OFFLINE,
    )
    expect(client.action).not.toHaveBeenCalled()
  })

  it('still runs the actions that only read while offline', async () => {
    goOffline()
    await gate.runAction(api.adminStats.listOrgs, {})
    await gate.runAction(api.adminPeople.userPage, { search: '', cursor: null })
    expect(client.action).toHaveBeenCalledTimes(2)
  })

  it('says a changing action may have happened when the dropped socket lost its answer', async () => {
    client.action.mockRejectedValue(new Error('Connection lost while action was in flight'))
    await expect(
      gate.runAction(api.adminAuth.banUser, { email: 'a@example.test' }),
    ).rejects.toThrow(gate.LOST_TEXT)
    client.action.mockRejectedValue(new Error('This person is already banned.'))
    await expect(
      gate.runAction(api.adminAuth.banUser, { email: 'a@example.test' }),
    ).rejects.toThrow('This person is already banned.')
  })
})

describe('console call sites', () => {
  // Every console module, read as text. A change sent around ./convex.ts
  // would go out, or wait in Convex's queue, while the console is offline.
  const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('send every change through the pause', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    const direct = Object.entries(sources)
      .filter(([path]) => path !== './convex.ts')
      .filter(([, text]) => /\bconvex\s*\.\s*(mutation|action)\s*\(/.test(text))
      .map(([path]) => path)
    expect(direct).toEqual([])
  })
})
