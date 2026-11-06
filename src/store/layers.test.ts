import { describe, expect, it } from 'vitest'
import { createLayers, type View } from './layers'

const paint = () => {}
const seen = { snapshot: 0, thread: 0, view: 0, detail: 0, milestones: 0 }

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

  it('drops saved view parts and keeps their workspace parts', () => {
    const layers = createLayers()
    // a write on a task only a view holds paints both (store/planner.ts
    // updateViewTask)
    const both: View = { workspace: paint, view: paint }
    const a = layers.open('a', both)
    layers.save(a, both)
    layers.dropSaved('view')
    expect(a.view).toEqual({ workspace: paint, view: undefined })
    layers.dropSaved('workspace')
    expect(layers.has(a)).toBe(false)
    // and the other way round: the workspace's delivery first
    const b = layers.open('b', both)
    layers.save(b, both)
    layers.dropSaved('workspace')
    expect(layers.has(b)).toBe(true)
    layers.dropSaved('view')
    expect(layers.has(b)).toBe(false)
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

  it("drops saved detail parts of one task's answer, or of every other task, and keeps the rest", () => {
    const layers = createLayers()
    // a write on a task the window shows from its own answer paints all
    // three (store/planner.ts updateAnswerTask)
    const all: View = { workspace: paint, view: paint, detail: { task: 't1', paint } }
    const a = layers.open('a', all)
    const b = layers.open('b', { detail: { task: 't2', paint } })
    const thread = layers.open('thread', { thread: { task: 't1', paint } })
    for (const layer of [a, b, thread]) layers.save(layer, layer.view)
    // the workspace and the views hold theirs; the answer still paints
    layers.dropSaved('workspace')
    layers.dropSaved('view')
    expect(layers.has(a)).toBe(true)
    expect(a.view).toEqual({ workspace: undefined, view: undefined, detail: { task: 't1', paint } })
    // the answer of t1 holds it; t2's and the thread of t1 stay
    expect(layers.dropSaved('detail', 't1')).toBe(true)
    expect([layers.has(a), layers.has(b), layers.has(thread)]).toEqual([false, true, true])
    // another task opens: every detail part but its own goes
    const c = layers.open('c', { detail: { task: 't3', paint } })
    layers.save(c, c.view)
    layers.dropSaved('detail', 't3', true)
    expect([layers.has(b), layers.has(c), layers.has(thread)]).toEqual([false, true, true])
    // a pending one stays whatever a delivery says
    const d = layers.open('d', { detail: { task: 't3', paint } })
    layers.send(d, seen)
    expect(layers.dropSaved('detail')).toBe(true)
    expect([layers.has(c), layers.has(d)]).toEqual([false, true])
    // and one the store finds held goes by its word (store/planner.ts
    // detailPartHeld)
    layers.save(d, d.view)
    expect(layers.dropSavedIf('detail', () => false)).toBe(false)
    expect(layers.dropSavedIf('detail', () => true)).toBe(true)
    expect(layers.has(d)).toBe(false)
  })

  it('keeps a saved layer whose detail part alone still paints, with the counter it was sent at', () => {
    const layers = createLayers()
    const a = layers.open('a', { workspace: paint, detail: { task: 't1', paint } })
    layers.send(a, { ...seen, detail: 3 })
    expect(a.seen.detail).toBe(3)
    expect(layers.paintedPending('detail')).toBe(true)
    layers.save(a, { detail: { task: 't1', paint } })
    expect(layers.has(a)).toBe(true)
    expect(layers.paintedPending('detail')).toBe(false)
    layers.save(a, {})
    expect(layers.has(a)).toBe(false)
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
