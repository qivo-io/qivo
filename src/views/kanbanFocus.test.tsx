// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cell, loadBoard, taskRow } from './boardFixture.setup'

/* Keyboard focus on a Board card follows the card when another person's
   change moves it to another cell. */

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
  // jsdom forgets the page has focus once the focused element goes; a
  // browser window keeps it
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  // jsdom scrolls nothing
  Element.prototype.scrollIntoView = vi.fn()
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* Task A in To Do beside B, with focus on A's owner button. */
async function focusedOwner() {
  const board = await loadBoard(network, (snap) => {
    snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
  })
  await board.render(root)
  const owner = () => board.card('a')?.querySelector<HTMLElement>('[data-focus-key="owner"]')
  await act(async () => owner()?.focus())
  expect(document.activeElement).toBe(owner())
  /** Another person moves A to In review. */
  const moveA = async () => {
    board.snapshot.issues.find((issue) => issue.id === 'a')!.status = 'review'
    await board.deliver()
  }
  return { board, owner, moveA }
}

describe('focus on a Board card', () => {
  it('follows the card to its new cell', async () => {
    const { owner, moveA } = await focusedOwner()
    await moveA()
    expect(cell('review')?.contains(owner()!)).toBe(true)
    expect(document.activeElement).toBe(owner())
    // a keyboard user sees where focus went
    expect(owner()!.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('stays where a pointer press put it', async () => {
    const { owner, moveA } = await focusedOwner()
    // a press elsewhere on the page, which keeps focus on the page itself
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    await moveA()
    expect(cell('review')?.contains(owner()!)).toBe(true)
    expect(document.activeElement).toBe(document.body)
  })
})
