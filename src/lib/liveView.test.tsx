// @vitest-environment jsdom
import { anyApi } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveTransition } from './liveQueries'

/* A view's own live read (lib/liveView.ts) over a transport double: what
   it takes at once, when its watch joined a subscription whose result
   arrived, and what it waits for a transition for. */

const transport = vi.hoisted(() => {
  const handlers = new Set<(transition: LiveTransition) => void>()
  const state = {
    /** whether the next watch joins a subscription whose result arrived */
    joined: false,
    /** what read answers for the one token */
    value: undefined as unknown,
    stops: 0,
    handlers,
  }
  const live = {
    watch: () => ({
      token: 'token',
      joined: state.joined,
      stop: () => {
        state.stops++
      },
    }),
    read: () => state.value,
    onTransition: (fn: (transition: LiveTransition) => void) => {
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    query: async () => null,
  }
  return { state, live }
})
vi.mock('./convex', () => ({ live: transport.live }))

const { useLiveView } = await import('./liveView')

let container: HTMLDivElement
let root: Root
let seen: { key: string | null; value?: unknown; answered: boolean }[] = []

/** Renders a view reading tasks:list for `key`, noting what it held. */
function View({ argsKey }: { argsKey: string }) {
  const view = useLiveView<string>(anyApi.tasks.list, argsKey)
  seen.push({ key: view.key, value: view.value, answered: view.answered })
  return null
}

const transition = (tokens: string[]) =>
  act(async () => {
    for (const fn of transport.state.handlers) fn({ tokens: new Set(tokens), at: 0, connection: 1 })
  })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  seen = []
  Object.assign(transport.state, { joined: false, value: undefined, stops: 0 })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
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
