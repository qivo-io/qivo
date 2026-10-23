// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, cell, loadBoard, taskRow } from './boardFixture.setup'

/* Keyboard focus on a Board card follows the card when another person's
   change moves it to another cell. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
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

describe('focus on a Board card', { timeout: BOARD_TEST_TIMEOUT }, () => {
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

  it('stays where wheel scrolling left it', async () => {
    const { owner, moveA } = await focusedOwner()
    await act(async () => window.dispatchEvent(new Event('wheel')))
    await moveA()
    expect(cell('review')?.contains(owner()!)).toBe(true)
    expect(document.activeElement).toBe(document.body)
  })

  it('stays off a Board behind a modal window', async () => {
    const { moveA } = await focusedOwner()
    container.setAttribute('inert', '')
    await moveA()
    expect(document.activeElement).toBe(document.body)
  })

  it('forgets a card whose task went, so a card arriving later never takes focus', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'review', 1), taskRow(snap, 'b', 'todo', 2))
    })
    await board.render(root)
    await act(async () =>
      board.card('a')?.querySelector<HTMLElement>('[data-focus-key="owner"]')?.focus(),
    )
    // A is archived elsewhere: its cell is left empty
    board.snapshot.issues = board.snapshot.issues.filter((issue) => issue.id !== 'a')
    await board.deliver()
    expect(document.activeElement).toBe(document.body)
    board.snapshot.issues.find((issue) => issue.id === 'b')!.status = 'review'
    await board.deliver()
    expect(cell('review')?.contains(board.card('b'))).toBe(true)
    expect(document.activeElement).toBe(document.body)
  })

  it('follows the card when a keyboard owner pick moves it to another lane', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        snap.profiles.push({
          ...snap.profiles[0],
          id: 'second',
          auth_user_id: 'second-account',
          name: 'Second Person',
          initials: 'SP',
        })
        snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
      },
      { metaViz: 'assignees' },
    )
    await board.render(root)
    const owner = () => board.card('a')?.querySelector<HTMLElement>('[data-focus-key="owner"]')
    const lane = () => board.card('a')?.closest('[data-swimlane-panel]')
    const before = lane()
    await act(async () => owner()?.focus())
    // Enter opens the picker; focus moves into its list, outside the Board
    await act(async () => owner()?.click())
    const pick = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) =>
      item.textContent?.includes('Second Person'),
    )
    expect(pick).toBeDefined()
    await act(async () => pick?.focus())
    expect(container.querySelector('[data-scroll]')?.contains(document.activeElement)).toBe(false)
    await act(async () => pick?.click())
    expect(lane()).not.toBe(before)
    expect(document.activeElement).toBe(owner())
  })
})

describe('focus on a phone task row', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('follows the row to its new status section', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
      },
      { phone: true },
    )
    await board.render(root)
    await act(async () => board.card('a')?.focus())
    board.snapshot.issues.find((issue) => issue.id === 'a')!.status = 'review'
    await board.deliver()
    expect(cell('review')?.contains(board.card('a'))).toBe(true)
    expect(document.activeElement).toBe(board.card('a'))
  })
})
