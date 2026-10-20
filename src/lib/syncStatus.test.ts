import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncStatus, OFFLINE_DELAY_MS, SLOW_SAVE_MS, watchConnection } from './syncStatus'

const UP = { connected: true, everConnected: true }
const DOWN = { connected: false, everConnected: true }

/** Lets the probe's answer reach the status. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('sync status', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A connected status whose probes the test answers by hand, newest last. */
  async function connected() {
    const status = createSyncStatus()
    const heard = vi.fn()
    const probes: (() => void)[] = []
    status.setProbe(() => new Promise<void>((resolve) => probes.push(resolve)))
    status.subscribe(heard)
    status.setSocket(UP)
    probes.at(-1)?.()
    await settle()
    const answer = async () => {
      probes.at(-1)?.()
      await settle()
    }
    return { status, heard, probes, answer }
  }

  it('pauses only after the connection stays down, so a blip shows nothing', async () => {
    const { status, heard, answer } = await connected()
    status.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS - 1)
    status.setSocket(UP)
    await answer()
    vi.advanceTimersByTime(OFFLINE_DELAY_MS * 2)
    expect(status.pause()).toBeNull()
    expect(heard).not.toHaveBeenCalled()

    status.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()).toEqual({ kind: 'offline', waiting: 0 })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('ends a browser-offline pause only once the server answers, also when the socket never dropped', async () => {
    const { status, answer } = await connected()
    status.setOnline(false)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()?.kind).toBe('offline')
    status.setOnline(true)
    // the socket may be dead without knowing it
    expect(status.pause()?.kind).toBe('offline')
    await answer()
    expect(status.pause()).toBeNull()
  })

  it('believes the server over a browser that reports offline while the socket works', async () => {
    const { status, answer } = await connected()
    status.setOnline(false)
    await answer()
    vi.advanceTimersByTime(OFFLINE_DELAY_MS * 2)
    expect(status.pause()).toBeNull()
  })

  it('does not count a socket that never connected as offline', () => {
    const status = createSyncStatus()
    status.setSocket({ connected: false, everConnected: false })
    vi.advanceTimersByTime(OFFLINE_DELAY_MS * 2)
    expect(status.pause()).toBeNull()
  })

  it('counts the changes sent before the drop and ends once they settle and the server answers', async () => {
    const { status, heard, probes, answer } = await connected()
    const first = status.track(true)
    const second = status.track(true)
    const background = status.track(false)
    status.setSocket(DOWN)
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()).toEqual({ kind: 'offline', waiting: 2 })
    expect(status.unconfirmed()).toBe(2)

    status.setSocket(UP)
    const reconnectProbe = probes.length
    first()
    second()
    background()
    // the writes settled, and the probe sent after the reconnect is unanswered
    expect(status.pause()?.kind).toBe('offline')
    // an answer to an older probe proves nothing about the new connection
    probes[reconnectProbe - 2]?.()
    await settle()
    expect(status.pause()?.kind).toBe('offline')
    await answer()
    expect(status.pause()).toBeNull()
    expect(heard).toHaveBeenLastCalledWith('offline')
  })

  it('pauses for a write that waits too long on a connected socket and ends when it settles', async () => {
    const { status, heard } = await connected()
    const settleWrite = status.track(true)
    vi.advanceTimersByTime(SLOW_SAVE_MS - 1)
    expect(status.pause()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(status.pause()).toEqual({ kind: 'slow', waiting: 1 })
    settleWrite()
    expect(status.pause()).toBeNull()
    expect(heard).toHaveBeenLastCalledWith('slow')
  })

  it('times a write sent before a reconnect from the reconnect', async () => {
    const { status } = await connected()
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

  it('reads the Convex connection state and the browser events, and probes with a query', async () => {
    const status = createSyncStatus()
    const state = { isWebSocketConnected: true, hasEverConnected: true }
    let changed = () => {}
    const answers: (() => void)[] = []
    const client = {
      connectionState: () => state,
      subscribeToConnectionState: (cb: () => void) => {
        changed = cb
        return () => {}
      },
      query: vi.fn(() => new Promise<void>((resolve) => answers.push(resolve))),
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
    // one probe for the first connect, one for the reconnect
    expect(client.query).toHaveBeenCalledTimes(2)
    answers[1]()
    await settle()
    expect(status.pause()).toBeNull()

    Object.defineProperty(win.navigator, 'onLine', { value: false })
    win.dispatchEvent(new Event('offline'))
    vi.advanceTimersByTime(OFFLINE_DELAY_MS)
    expect(status.pause()?.kind).toBe('offline')
  })
})
