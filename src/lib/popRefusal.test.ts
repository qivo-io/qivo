// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installHistoryIndex } from './historyIndex'
import { createUnsentScope } from './leaveGuard'
import { createPopRefusal } from './popRefusal'

/* A refused Back or Forward steps back over the same distance, keeps the
   entries on both sides, hides both popstates from later listeners, asks
   only once it is back, and takes the step again after Discard. */

let remove = () => {}
let listeners: ((event: PopStateEvent) => void)[] = []
beforeEach(() => {
  remove = installHistoryIndex()
})
afterEach(() => {
  remove()
  for (const listener of listeners) window.removeEventListener('popstate', listener)
  listeners = []
})

const listen = (listener: (event: PopStateEvent) => void) => {
  listeners.push(listener)
  window.addEventListener('popstate', listener)
}
/** Waits until the history moves have settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Three entries a, b and c, on b, with a listener that refuses while
    `refusing`, and a later listener, as a phone layer is. */
async function setUp() {
  history.pushState(null, '', '/app/a')
  history.pushState(null, '', '/app/b')
  history.pushState(null, '', '/app/c')
  history.back()
  await settle()
  const scope = createUnsentScope()
  scope.hold('comment')
  const ask = vi.fn()
  const refusal = createPopRefusal(ask)
  const state = { refusing: true, applied: [] as string[] }
  listen((event) => {
    if (refusal.landed(event)) return
    if (state.refusing && refusal.refuse(event, [scope])) return
    state.applied.push(location.pathname)
  })
  const later = vi.fn()
  listen(later)
  return { ask, refusal, state, later, scope }
}

describe('a refused Back or Forward', () => {
  it('steps back to where it was and asks there, unseen by later listeners', async () => {
    const { ask, refusal, state, later, scope } = await setUp()
    history.back()
    await vi.waitFor(() => expect(ask).toHaveBeenCalled())
    expect(location.pathname).toBe('/app/b')
    expect(refusal.stepping()).toBe(false)
    expect(state.applied).toEqual([])
    expect(later).not.toHaveBeenCalled()
    expect(ask.mock.calls[0][0]).toEqual([scope])
    // Keep editing: the entries on both sides are still there
    state.refusing = false
    history.forward()
    await settle()
    expect(location.pathname).toBe('/app/c')
    history.go(-2)
    await settle()
    expect(location.pathname).toBe('/app/a')
  })

  it('ends a refusal that another Back or Forward overtook', async () => {
    history.pushState(null, '', '/app/x')
    history.pushState(null, '', '/app/y')
    const scope = createUnsentScope()
    scope.hold('comment')
    // a step back that never lands, as when another move overtakes it
    const refusal = createPopRefusal(vi.fn(), { ...history, go: vi.fn() })
    const refused = new Promise<void>((resolve) =>
      listen((event) => {
        refusal.refuse(event, [scope])
        resolve()
      }),
    )
    history.back()
    await refused
    expect(refusal.stepping()).toBe(true)
    // the next popstate is somewhere else, so it is the move, and history
    // writes resume
    expect(refusal.landed(new PopStateEvent('popstate'))).toBe(false)
    expect(refusal.stepping()).toBe(false)
  })

  it('takes the same step again after Discard', async () => {
    const { ask, state } = await setUp()
    history.forward()
    await vi.waitFor(() => expect(ask).toHaveBeenCalled())
    expect(location.pathname).toBe('/app/b')
    state.refusing = false
    ask.mock.calls[0][1]()
    await settle()
    expect(location.pathname).toBe('/app/c')
    expect(state.applied).toEqual(['/app/c'])
  })
})
