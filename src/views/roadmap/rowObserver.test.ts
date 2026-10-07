import { describe, expect, it, vi } from 'vitest'
import { createRowObserver } from './rowObserver'

const element = () => ({}) as Element
const fixture = () => {
  const created: {
    deliver: (entries: { target: Element; isIntersecting: boolean }[]) => void
    options: IntersectionObserverInit
    observe: ReturnType<typeof vi.fn>
    unobserve: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  const rows = createRowObserver((deliver, options) => {
    const observer = { deliver, options, observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
    created.push(observer)
    return observer
  })
  return { rows, created }
}

describe('deferred roadmap row controls', () => {
  it('shares one scrollport observer and activates each approaching row only once', () => {
    const { rows, created } = fixture()
    const root = element()
    const first = element()
    const second = element()
    const activateFirst = vi.fn()
    const activateSecond = vi.fn()
    rows.observe(first, activateFirst)
    rows.setRoot(root)
    rows.observe(second, activateSecond)
    expect(created).toHaveLength(1)
    expect(created[0].options).toEqual({ root, rootMargin: '500px' })
    expect(created[0].observe.mock.calls.map(([target]) => target)).toEqual([first, second])
    created[0].deliver([{ target: first, isIntersecting: false }])
    expect(activateFirst).not.toHaveBeenCalled()
    created[0].deliver([{ target: first, isIntersecting: true }])
    expect(activateFirst).toHaveBeenCalledTimes(1)
    expect(created[0].unobserve).toHaveBeenCalledWith(first)
    created[0].deliver([
      { target: first, isIntersecting: true },
      { target: second, isIntersecting: true },
    ])
    expect(activateFirst).toHaveBeenCalledTimes(1)
    expect(activateSecond).toHaveBeenCalledTimes(1)
    rows.dispose()
  })

  it('ignores removed rows and old callbacks after a scrollport replacement or disposal', () => {
    const { rows, created } = fixture()
    const task = element()
    const removed = element()
    const activate = vi.fn()
    const obsolete = vi.fn()
    rows.setRoot(element())
    rows.observe(task, activate)
    const stop = rows.observe(removed, obsolete)
    stop()
    created[0].deliver([{ target: removed, isIntersecting: true }])
    expect(obsolete).not.toHaveBeenCalled()
    rows.setRoot(null)
    rows.setRoot(element())
    expect(created[0].disconnect).toHaveBeenCalledTimes(1)
    expect(created[1].observe).toHaveBeenCalledExactlyOnceWith(task)
    created[0].deliver([{ target: task, isIntersecting: true }])
    expect(activate).not.toHaveBeenCalled()
    rows.dispose()
    created[1].deliver([{ target: task, isIntersecting: true }])
    expect(activate).not.toHaveBeenCalled()
  })

  it('renders every control when IntersectionObserver is unavailable', () => {
    const rows = createRowObserver(null)
    const pending = vi.fn()
    const attached = vi.fn()
    rows.observe(element(), pending)
    expect(pending).not.toHaveBeenCalled()
    rows.setRoot(element())
    expect(pending).toHaveBeenCalledTimes(1)
    rows.observe(element(), attached)
    expect(attached).toHaveBeenCalledTimes(1)
    rows.dispose()
  })
})
