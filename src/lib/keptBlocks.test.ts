// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleHiddenBlocks } from './keptBlocks'

/** A container with `n` blocks, and the blocks whose style was read. */
function setup(n: number) {
  const container = document.createElement('div')
  for (let i = 0; i < n; i++) {
    const block = document.createElement('div')
    block.className = 'deferred-block'
    container.append(block)
  }
  container.append(document.createElement('div'))
  document.body.append(container)
  const read: Element[] = []
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    read.push(element)
    return real(element)
  })
  return { container, read }
}

/** An idle queue run by hand: each step gets `perStep` reads of time. */
function idleQueue(perStep: number) {
  const queue: ((deadline: { timeRemaining: () => number }) => void)[] = []
  let cancelled = 0
  return {
    idle: (step: (deadline: { timeRemaining: () => number }) => void) => {
      queue.push(step)
      return () => {
        cancelled++
        queue.splice(queue.indexOf(step), 1)
      }
    },
    run() {
      const step = queue.shift()
      let left = perStep
      // each read takes one unit, and two are left for the browser
      step?.({ timeRemaining: () => left-- + 2 })
    },
    get waiting() {
      return queue.length
    },
    get cancelled() {
      return cancelled
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('settleHiddenBlocks', () => {
  it('reads every block once, a few per idle step, and nothing else', () => {
    const { container, read } = setup(10)
    const queue = idleQueue(4)
    settleHiddenBlocks(container, queue)
    expect(read).toHaveLength(0)
    queue.run()
    expect(read).toHaveLength(4)
    queue.run()
    queue.run()
    expect(read).toEqual([...container.getElementsByClassName('deferred-block')])
    expect(queue.waiting).toBe(0)
  })

  it('marks each block before it reads its style', () => {
    const { container } = setup(3)
    const queue = idleQueue(4)
    const marks: boolean[] = []
    vi.mocked(window.getComputedStyle).mockImplementation((element) => {
      marks.push(element.hasAttribute('data-kept-hidden'))
      return {} as CSSStyleDeclaration
    })
    settleHiddenBlocks(container, queue)
    queue.run()
    expect(marks).toEqual([true, true, true])
    expect(container.querySelectorAll('[data-kept-hidden]')).toHaveLength(3)
  })

  it('stops when the view shows again before it is done, and takes its marks off', () => {
    const { container, read } = setup(10)
    const queue = idleQueue(4)
    const stop = settleHiddenBlocks(container, queue)
    queue.run()
    expect(container.querySelectorAll('[data-kept-hidden]')).toHaveLength(4)
    stop()
    expect(queue.cancelled).toBe(1)
    expect(queue.waiting).toBe(0)
    expect(read).toHaveLength(4)
    expect(container.querySelectorAll('[data-kept-hidden]')).toHaveLength(0)
  })
})
