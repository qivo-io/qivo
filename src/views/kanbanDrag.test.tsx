// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cell, dragEvent, loadBoard, taskRow } from './boardFixture.setup'

/* Dragging a Board card on the real store. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('dragging a Board card', () => {
  it('ends once the dragged card has left the page', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
    })
    await board.render(root)
    const row = (uuid: string) => board.card(uuid)
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragstart', 'a')))
    expect(isUpdateBlocked()).toBe(true)
    expect(row('a')?.classList.contains('opacity-40')).toBe(true)
    // another person moves the task, which replaces its row in In Progress;
    // dragend then fires on the removed row and never reaches the Board
    board.snapshot.issues.find((issue) => issue.id === 'a')!.status = 'progress'
    await board.deliver()
    expect(cell('progress')?.contains(row('a'))).toBe(true)
    expect(isUpdateBlocked()).toBe(true)
    await act(async () => window.dispatchEvent(new Event('pointermove')))
    expect(isUpdateBlocked()).toBe(false)
    expect(document.querySelector('.opacity-40')).toBeNull()
  })

  it('keeps a drag whose card is still on the page', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1))
    })
    await board.render(root)
    const row = (uuid: string) => board.card(uuid)
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragstart', 'a')))
    board.snapshot.issues[0].title = 'Renamed elsewhere'
    await board.deliver()
    await act(async () => window.dispatchEvent(new Event('pointermove')))
    expect(isUpdateBlocked()).toBe(true)
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragend', 'a')))
    expect(isUpdateBlocked()).toBe(false)
  })
})
