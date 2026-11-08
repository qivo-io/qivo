import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { forwardResume, POWER_RESUME, type ResumeTarget } from './power.js'

/* The desktop shell's wake from sleep, forwarded to the page. */
describe('the power resume forwarding', () => {
  /** A window double that records what it was sent. */
  const windowDouble = () => {
    const sent: string[] = []
    let destroyed = false
    const win: ResumeTarget = {
      isDestroyed: () => destroyed,
      webContents: { send: (channel: string) => void sent.push(channel) },
    }
    const destroy = () => {
      destroyed = true
    }
    return { win, sent, destroy }
  }

  it('sends one resume a wake to the window, with no payload', () => {
    const monitor = new EventEmitter()
    const { win, sent } = windowDouble()
    const send = vi.spyOn(win.webContents, 'send')
    forwardResume(monitor, () => win)
    monitor.emit('resume')
    expect(sent).toEqual([POWER_RESUME])
    expect(send).toHaveBeenCalledWith('qivo:power:resume')
    expect(send.mock.calls[0]).toHaveLength(1)
    monitor.emit('resume')
    expect(sent).toHaveLength(2)
  })

  it('sends nothing without a window or to a destroyed one', () => {
    const monitor = new EventEmitter()
    const { win, sent, destroy } = windowDouble()
    let current: ResumeTarget | null = null
    forwardResume(monitor, () => current)
    monitor.emit('resume')
    current = win
    destroy()
    monitor.emit('resume')
    expect(sent).toEqual([])
  })

  it('stops on dispose', () => {
    const monitor = new EventEmitter()
    const { win, sent } = windowDouble()
    const stop = forwardResume(monitor, () => win)
    stop()
    monitor.emit('resume')
    expect(sent).toEqual([])
    expect(monitor.listenerCount('resume')).toBe(0)
  })
})
