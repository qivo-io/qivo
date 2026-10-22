import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'

/* The console's changes pause with the app's (./convex.ts). The Convex
   client is a double that records what is sent; the status is the real one
   the console's notice reads. */

const client = vi.hoisted(() => {
  const listeners = new Set<(state: { isWebSocketConnected: boolean }) => void>()
  const double = {
    socket: true,
    connections: 1,
    mutation: vi.fn(),
    action: vi.fn(),
    connectionState: () => ({
      isWebSocketConnected: double.socket,
      connectionCount: double.connections,
    }),
    subscribeToConnectionState(listener: (state: { isWebSocketConnected: boolean }) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Opens or closes the socket and tells the listeners. */
    setSocket(connected: boolean) {
      if (connected && !double.socket) double.connections++
      double.socket = connected
      for (const listener of Array.from(listeners)) listener(double.connectionState())
    },
  }
  return double
})
vi.mock('../lib/convex', () => ({ convex: client }))

let gate: typeof import('./convex')
let sync: typeof import('../lib/syncStatus')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  client.socket = true
  client.connections = 1
  client.mutation.mockReset().mockResolvedValue(null)
  client.action.mockReset().mockResolvedValue(null)
  sync = await import('../lib/syncStatus')
  gate = await import('./convex')
  sync.syncStatus.setSocket({ connected: true, everConnected: true })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Opens or closes the socket, for the client and the status alike. */
function socket(connected: boolean) {
  client.setSocket(connected)
  sync.syncStatus.setSocket({ connected, everConnected: true })
}

/** Drops the socket for long enough that saving pauses. */
function goOffline() {
  socket(false)
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

  it('sends a changing action only on a connected socket, waiting out a short drop', async () => {
    socket(false)
    expect(sync.syncStatus.pause()).toBeNull()
    const refused = gate.runAction(api.adminOrgs.createOrganization, {} as never)
    vi.advanceTimersByTime(sync.OFFLINE_DELAY_MS)
    await expect(refused).rejects.toThrow(OFFLINE)
    expect(client.action).not.toHaveBeenCalled()
    socket(true)
    socket(false)
    const sent = gate.runAction(api.adminAuth.banUser, { email: 'a@example.test' })
    vi.advanceTimersByTime(sync.OFFLINE_DELAY_MS / 2)
    expect(client.action).not.toHaveBeenCalled()
    socket(true)
    await sent
    expect(client.action).toHaveBeenCalledOnce()
  })

  it('does not go ahead with a change that read first once the socket dropped meanwhile', () => {
    const unchanged = gate.beginChange()
    expect(() => unchanged()).not.toThrow()
    socket(false)
    socket(true)
    expect(() => unchanged()).toThrow(gate.DROPPED_TEXT)
    socket(false)
    expect(() => gate.beginChange()).toThrow(OFFLINE)
  })

  it('still runs the actions that only read while offline', async () => {
    goOffline()
    await gate.runAction(api.adminStats.listOrgs, {})
    await gate.runAction(api.adminPeople.userPage, { search: '', cursor: null })
    expect(client.action).toHaveBeenCalledTimes(2)
  })

  it('pauses the other changes while a changing action takes too long, without counting it', async () => {
    let answer: (value: null) => void = () => {}
    client.action.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const running = gate.runAction(api.adminOrgs.createOrganization, {} as never)
    vi.advanceTimersByTime(sync.SLOW_SAVE_MS)
    expect(sync.syncStatus.pause()).toEqual({ kind: 'slow', waiting: 0 })
    await expect(
      gate.runAction(api.adminAuth.banUser, { email: 'a@example.test' }),
    ).rejects.toThrow('Saving is taking longer than usual. Editing is paused until it finishes.')
    answer(null)
    await running
    expect(sync.syncStatus.pause()).toBeNull()
    // a read takes as long as it takes
    client.action.mockReturnValueOnce(new Promise(() => {}))
    void gate.runAction(api.adminStats.platformStats, {})
    vi.advanceTimersByTime(sync.SLOW_SAVE_MS)
    expect(sync.syncStatus.pause()).toBeNull()
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
      .filter(
        ([, text]) =>
          // a call, a reference, an optional call or a destructuring
          /\bconvex\s*\??\.\s*(mutation|action)\b/.test(text) ||
          /\{[^}]*\b(mutation|action)\b[^}]*\}\s*=\s*convex\b/.test(text),
      )
      .map(([path]) => path)
    expect(direct).toEqual([])
  })
})
