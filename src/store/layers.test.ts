import { describe, expect, it } from 'vitest'
import { createLayers, type View } from './layers'

const paint = () => {}
const seen = { snapshot: 0, thread: 0 }

describe('the layer registry', () => {
  it('orders saved layers by acceptance, then the rest by creation', () => {
    const layers = createLayers()
    const a = layers.open('a', { workspace: paint })
    const b = layers.open('b', { workspace: paint })
    const c = layers.open('c', { workspace: paint })
    for (const layer of [a, b, c]) layers.send(layer, seen)
    layers.save(c, c.view)
    layers.save(a, a.view)
    expect(layers.ordered().map((l) => l.name)).toEqual(['c', 'a', 'b'])
    expect(layers.ordered().map((l) => l.state)).toEqual(['saved', 'saved', 'pending'])
  })

  it('removes a layer saved with nothing left to paint', () => {
    const layers = createLayers()
    const a = layers.open('a', { workspace: paint })
    layers.send(a, seen)
    layers.save(a, {})
    expect(layers.has(a)).toBe(false)
    expect(layers.ordered()).toEqual([])
  })

  it('drops saved workspace parts and keeps their thread parts', () => {
    const layers = createLayers()
    const both: View = { workspace: paint, thread: { task: 't1', paint } }
    const a = layers.open('a', both)
    const b = layers.open('b', { workspace: paint })
    layers.save(a, both)
    layers.save(b, b.view)
    layers.dropSaved('workspace')
    expect(layers.has(b)).toBe(false)
    expect(a.view).toEqual({ workspace: undefined, thread: { task: 't1', paint } })
    // a pending layer is never dropped by a delivery
    const c = layers.open('c', { workspace: paint })
    layers.send(c, seen)
    layers.dropSaved('workspace')
    expect(layers.has(c)).toBe(true)
  })

  it('drops saved thread parts of one task, or of every other task', () => {
    const layers = createLayers()
    const one = layers.open('one', { thread: { task: 't1', paint } })
    const two = layers.open('two', { thread: { task: 't2', paint } })
    layers.save(one, one.view)
    layers.save(two, two.view)
    layers.dropSaved('thread', 't2')
    expect([layers.has(one), layers.has(two)]).toEqual([true, false])
    const three = layers.open('three', { thread: { task: 't3', paint } })
    layers.save(three, three.view)
    layers.dropSaved('thread', 't3', true)
    expect([layers.has(one), layers.has(three)]).toEqual([false, true])
  })

  it('answers whether an open or pending layer paints', () => {
    const layers = createLayers()
    expect(layers.paintedPending()).toBe(false)
    const none = layers.open('none', {})
    layers.send(none, seen)
    expect(layers.paintedPending()).toBe(false)
    const thread = layers.open('thread', { thread: { task: 't1', paint } })
    expect(layers.paintedPending()).toBe(true)
    expect(layers.paintedPending('workspace')).toBe(false)
    expect(layers.paintedPending('thread')).toBe(true)
    layers.save(thread, thread.view)
    expect(layers.paintedPending()).toBe(false)
    layers.clear()
    expect(layers.ordered()).toEqual([])
  })
})
