// @vitest-environment jsdom
import { anyApi } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTransition } from './liveQueries'

/* A view's own live read (lib/liveView.ts) over a transport double: what
   it takes at once, when its watch joined a subscription whose result
   arrived, and what it waits for a transition for; and the kept read
   (useKeptLiveView), which keeps its last answer through a pause, a kept
   page shown again, a reconnect, Try again and a failure. */

const transport = vi.hoisted(() => {
  const handlers = new Set<(transition: LiveTransition) => void>()
  const state = {
    /** whether the next watch joins a subscription whose result arrived */
    joined: false,
    /** what read answers for the one token, or the error it throws */
    value: undefined as unknown,
    error: undefined as unknown,
    stops: 0,
    /** the watches open now, and how many asked the server afresh */
    open: 0,
    fresh: 0,
    handlers,
  }
  const live = {
    watch: (_ref: unknown, _args: unknown, sharing?: { fresh?: boolean }) => {
      state.open++
      if (sharing?.fresh) state.fresh++
      let stopped = false
      return {
        token: 'token',
        joined: state.joined,
        stop: () => {
          if (stopped) return
          stopped = true
          state.stops++
          state.open--
        },
      }
    },
    read: () => {
      if (state.error !== undefined) throw state.error
      return state.value
    },
    onTransition: (fn: (transition: LiveTransition) => void) => {
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    query: async () => null,
  }
  return { state, live }
})
vi.mock('./convex', () => ({ live: transport.live }))

const { useKeptLiveView, useLiveView } = await import('./liveView')

let container: HTMLDivElement
let root: Root
let seen: { key: string | null; value?: unknown; answered: boolean }[] = []

/** Renders a view reading tasks:list for `key`, noting what it held. */
function View({ argsKey }: { argsKey: string }) {
  const view = useLiveView<string>(anyApi.tasks.list, argsKey)
  seen.push({ key: view.key, value: view.value, answered: view.answered })
  return null
}

const transition = (tokens: string[], connection = 1) =>
  act(async () => {
    for (const fn of transport.state.handlers) fn({ tokens: new Set(tokens), at: 0, connection })
  })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  seen = []
  Object.assign(transport.state, {
    joined: false,
    value: undefined,
    error: undefined,
    stops: 0,
    open: 0,
    fresh: 0,
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('a view live read', () => {
  it('takes the result at once when its watch joined one that arrived', async () => {
    Object.assign(transport.state, { joined: true, value: 'shared' })
    await act(async () => root.render(<View argsKey="{}" />))
    expect(seen.at(-1)).toEqual({ key: '{}', value: 'shared', answered: true })
  })

  it('takes no result Convex kept until a transition names the subscription', async () => {
    Object.assign(transport.state, { joined: false, value: 'kept' })
    await act(async () => root.render(<View argsKey="{}" />))
    expect(seen.at(-1)).toEqual({ key: null, value: undefined, answered: false })
    // a transition for other queries brings nothing
    await transition(['other'])
    expect(seen.at(-1)?.key).toBeNull()
    transport.state.value = 'fresh'
    await transition(['token'])
    expect(seen.at(-1)).toEqual({ key: '{}', value: 'fresh', answered: true })
  })

  it('stops its watch and its handler when its arguments change', async () => {
    await act(async () => root.render(<View argsKey="{}" />))
    await act(async () => root.render(<View argsKey='{"a":1}' />))
    expect(transport.state.stops).toBe(1)
    expect(transport.state.handlers.size).toBe(1)
  })
})

describe('a kept live read', () => {
  type Kept = ReturnType<typeof useKeptLiveView<string>>
  // what the reader held at each render, newest last
  const held: Kept[] = []
  /** Renders a reader of tasks:list for `argsKey` that keeps its answer. */
  function KeptView({ argsKey }: { argsKey: string | null }) {
    held.push(useKeptLiveView<string>(anyApi.tasks.list, argsKey))
    return null
  }
  const kept = () => held.at(-1)
  const state = () => ({ state: kept()?.state, value: kept()?.value })
  const answer = async (value: string, connection = 1) => {
    transport.state.value = value
    transport.state.error = undefined
    await transition(['token'], connection)
  }
  const hide = (value: 'hidden' | 'visible') =>
    act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
    })

  it('loads, then keeps its answer refreshing through a pause until the new one arrives', async () => {
    await act(async () => root.render(<KeptView argsKey="{}" />))
    expect(state()).toEqual({ state: 'loading', value: null })
    await answer('one')
    expect(state()).toEqual({ state: 'ok', value: 'one' })
    await hide('hidden')
    // hidden, with no subscription and the answer kept
    expect(transport.state.open).toBe(0)
    expect(state()).toEqual({ state: 'refreshing', value: 'one' })
    await hide('visible')
    expect(transport.state.open).toBe(1)
    expect(state()).toEqual({ state: 'refreshing', value: 'one' })
    await answer('two')
    expect(state()).toEqual({ state: 'ok', value: 'two' })
  })

  it('keeps its answer refreshing when a kept page shows again', async () => {
    await act(async () =>
      root.render(
        <Activity mode="visible">
          <KeptView argsKey="{}" />
        </Activity>,
      ),
    )
    await answer('one')
    // a kept page stops its effects while another page shows, in
    // React's Activity (components/KeptView.tsx), and keeps its state
    const page = (mode: 'hidden' | 'visible') => (
      <Activity mode={mode}>
        <KeptView argsKey="{}" />
      </Activity>
    )
    await act(async () => root.render(page('hidden')))
    expect(transport.state.open).toBe(0)
    await act(async () => root.render(page('visible')))
    expect(transport.state.open).toBe(1)
    expect(state()).toEqual({ state: 'refreshing', value: 'one' })
    await answer('two')
    expect(state()).toEqual({ state: 'ok', value: 'two' })
  })

  it('is refreshing after a reconnect until the answer arrives on the new connection', async () => {
    await act(async () => root.render(<KeptView argsKey="{}" />))
    await answer('one')
    // the new socket's first transition names another query
    await transition(['other'], 2)
    expect(state()).toEqual({ state: 'refreshing', value: 'one' })
    await answer('one', 2)
    expect(state()).toEqual({ state: 'ok', value: 'one' })
  })

  it('keeps its answer refreshing through Try again, which asks the server afresh', async () => {
    await act(async () => root.render(<KeptView argsKey="{}" />))
    await answer('one')
    await act(async () => kept()?.retry())
    expect(transport.state.fresh).toBe(1)
    expect(state()).toEqual({ state: 'refreshing', value: 'one' })
    await answer('two')
    expect(state()).toEqual({ state: 'ok', value: 'two' })
  })

  it('fails with the kept answer for a fault, and drops it for a refusal that ends access', async () => {
    await act(async () => root.render(<KeptView argsKey="{}" />))
    await answer('one')
    transport.state.error = new Error('socket fault')
    await transition(['token'])
    expect(state()).toEqual({ state: 'failed', value: 'one' })
    transport.state.error = new ConvexError({ code: 'forbidden', message: 'not an admin' })
    await transition(['token'])
    expect(state()).toEqual({ state: 'failed', value: null })
  })

  it('drops its answer for a new key', async () => {
    await act(async () => root.render(<KeptView argsKey="{}" />))
    await answer('one')
    await act(async () => root.render(<KeptView argsKey='{"a":1}' />))
    expect(state()).toEqual({ state: 'loading', value: null })
  })
})
