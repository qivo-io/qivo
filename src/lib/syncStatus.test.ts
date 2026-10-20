import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncStatus, OFFLINE_DELAY_MS, SLOW_SAVE_MS, watchConnection } from './syncStatus'

const UP = { connected: true, everConnected: true }
const DOWN = { connected: false, everConnected: true }

describe('sync status', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function connected() {
    const status = createSyncStatus()
    const heard = vi.fn()
    status.subscribe(heard)
    status.setSocket(UP)
    // the first query results of the connection
    status.transitioned()
    return { status, heard }
  }

  it('pauses only after the connection stays down, so a blip shows nothing', () => {
    const { status, heard } = connected()
    status.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS - 1)
    status.setSocket(UP)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS * 2)
    expect(status.pause()).toBeNull()
    expect(heard).not.toHaveBeenCalled()

    status.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()).toEqual({ kind: 'offline', waiting: 0 })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('reads the browser going offline while the socket still counts as connected', () => {
    const { status } = connected()
    status.setOnline(false)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()?.kind).toBe('offline')
    status.setOnline(true)
    expect(status.pause()).toBeNull()
  })

  it('does not count a socket that never connected as offline', () => {
    const status = createSyncStatus()
    status.setSocket({ connected: false, everConnected: false })
    vi.advanceTimersByTime(OFFLINE_DELAY_MS * 2)
    expect(status.pause()).toBeNull()
  })

  it('counts the changes sent before the drop and ends once they settle and fresh results arrive', () => {
    const { status, heard } = connected()
    const first = status.track(true)
    const second = status.track(true)
    const background = status.track(false)
    status.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()).toEqual({ kind: 'offline', waiting: 2 })
    expect(status.unconfirmed()).toBe(2)

    status.setSocket(UP)
    first()
    second()
    background()
    // the writes settled, but the results of the new connection have not arrived
    expect(status.pause()?.kind).toBe('offline')
    status.transitioned()
    expect(status.pause()).toBeNull()
    expect(heard).toHaveBeenLastCalledWith('offline')
  })

  it('pauses for a write that waits too long on a connected socket and ends when it settles', () => {
    const { status, heard } = connected()
    const settle = status.track(true)
    vi.advanceTimersByTime(SLOW_SAVE_MS - 1)
    expect(status.pause()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(status.pause()).toEqual({ kind: 'slow', waiting: 1 })
    settle()
    expect(status.pause()).toBeNull()
    expect(heard).toHaveBeenLastCalledWith('slow')
  })

  it('times a write sent before a reconnect from the reconnect', () => {
    const { status } = connected()
    status.track(true)
    status.setSocket(DOWN)
    vi.advanceTimersByTime(SLOW_SAVE_MS * 3)
    expect(status.pause()?.kind).toBe('offline')
    status.setSocket(UP)
    vi.advanceTimersByTime(SLOW_SAVE_MS - 1)
    expect(status.pause()?.kind).toBe('offline')
    vi.advanceTimersByTime(1)
    expect(status.pause()?.kind).toBe('slow')
  })

  it('reads the Convex connection state, its Transitions and the browser events', () => {
    const status = createSyncStatus()
    const state = { isWebSocketConnected: true, hasEverConnected: true }
    let changed = () => {}
    let transition = () => {}
    const client = {
      connectionState: () => state,
      subscribeToConnectionState: (cb: () => void) => {
        changed = cb
        return () => {}
      },
      client: {
        addOnTransitionHandler: (cb: () => void) => {
          transition = cb
          return () => true
        },
      },
    } as unknown as Parameters<typeof watchConnection>[1]
    const win = new EventTarget() as Window
    Object.defineProperty(win, 'navigator', { value: { onLine: true } })
    watchConnection(status, client, win)
    Object.assign(state, { isWebSocketConnected: false })
    changed()
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()?.kind).toBe('offline')
    Object.assign(state, { isWebSocketConnected: true })
    changed()
    expect(status.pause()?.kind).toBe('offline')
    transition()
    expect(status.pause()).toBeNull()

    Object.defineProperty(win.navigator, 'onLine', { value: false })
    win.dispatchEvent(new Event('offline'))
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()?.kind).toBe('offline')
  })
})
