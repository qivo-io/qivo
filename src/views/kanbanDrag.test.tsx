// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IssueVM } from '../store/planner'
import { BOARD_TEST_TIMEOUT, cell, dragEvent, loadBoard, taskRow } from './boardFixture.setup'

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
// The owner's portrait renders once per task row, so it counts card renders.
const portraits = vi.hoisted(() => ({ rendered: [] as string[] }))
vi.mock('@/components/AssigneeAvatar', () => ({
  AssigneeAvatar: ({ issue }: { issue: IssueVM }) => {
    portraits.rendered.push(issue.uuid)
    return null
  },
  OwnerPickList: () => null,
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

/* A card in To Do and twenty in In Progress. */
const crowded = () =>
  loadBoard(network, (snap) => {
    snap.issues.push(taskRow(snap, 'a', 'todo', 1))
    for (let n = 0; n < 20; n++) snap.issues.push(taskRow(snap, `p${n}`, 'progress', n + 2))
  })
const over = (status: string) => act(async () => cell(status)?.dispatchEvent(dragEvent('dragover')))
const highlighted = (status: string) => !!cell(status)?.style.outline.includes('dashed')

describe('dragging a Board card', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('highlights the cell it is over without rendering any card', async () => {
    const board = await crowded()
    await board.render(root)
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    portraits.rendered = []
    await over('progress')
    expect(portraits.rendered).toEqual([])
    expect(highlighted('progress')).toBe(true)
    expect(cell('progress')?.hasAttribute('data-drop-over')).toBe(true)
  })

  it('highlights only the last cell it was over', async () => {
    const board = await crowded()
    await board.render(root)
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await over('progress')
    // no dragleave between them, as a fast drag can deliver it
    await over('review')
    expect(highlighted('progress')).toBe(false)
    expect(highlighted('review')).toBe(true)
    // back over its own cell: no destination, and the source is not one
    await over('todo')
    expect(highlighted('review')).toBe(false)
    expect(highlighted('todo')).toBe(false)
    expect(cell('todo')?.hasAttribute('data-drop-over')).toBe(false)
  })

  it('clears the highlight when the drag drops or ends', async () => {
    const board = await crowded()
    await board.render(root)
    const status = () => board.P.issues.find((it) => it.uuid === 'a')?.status
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await over('review')
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragend')))
    expect(highlighted('review')).toBe(false)
    expect(status()).toBe('todo')
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    await over('progress')
    await act(async () => cell('progress')?.dispatchEvent(dragEvent('drop')))
    expect(status()).toBe('progress')
    expect(highlighted('progress')).toBe(false)
    expect(document.querySelector('[data-drop-over]')).toBeNull()
  })

  it('takes no drop from a drag that did not start on a card', async () => {
    const board = await crowded()
    await board.render(root)
    const status = () => board.P.issues.find((it) => it.uuid === 'a')?.status
    // the card's own drag ends where the Board never hears of it
    await act(async () => board.card('a')?.dispatchEvent(dragEvent('dragstart')))
    // a file dragged in from the desktop carries no task
    const file = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], dropEffect: 'none', getData: () => '' },
      })
      return event
    }
    const offer = file('dragover')
    await act(async () => cell('review')?.dispatchEvent(offer))
    expect(offer.defaultPrevented).toBe(false)
    expect(highlighted('review')).toBe(false)
    await act(async () => cell('review')?.dispatchEvent(file('drop')))
    expect(status()).toBe('todo')
  })

  it('ends once the dragged card has left the page', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1), taskRow(snap, 'b', 'todo', 2))
    })
    await board.render(root)
    const row = (uuid: string) => board.card(uuid)
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragstart')))
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
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragstart')))
    board.snapshot.issues[0].title = 'Renamed elsewhere'
    await board.deliver()
    await act(async () => window.dispatchEvent(new Event('pointermove')))
    expect(isUpdateBlocked()).toBe(true)
    await act(async () => row('a')?.dispatchEvent(dragEvent('dragend')))
    expect(isUpdateBlocked()).toBe(false)
  })
})
