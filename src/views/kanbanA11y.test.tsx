// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A screen reader finds each Board cell as a named list of cards, and
   hears a card's priority, hours, pause and delay after its title. */

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
  // slices never run, so a large Board keeps its waiting space
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { onmessage: null, close() {} }
      port2 = { postMessage() {} }
    },
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

/** What a screen reader reads for `element`: an image's label, else text. */
function spoken(element: Element): string {
  if (element.getAttribute('role') === 'img') return element.getAttribute('aria-label') ?? ''
  return [...element.childNodes]
    .map((node) => (node instanceof Element ? ` ${spoken(node)} ` : (node.textContent ?? '')))
    .join('')
}
/** The text of the elements `element`'s aria-describedby names, in order. */
const description = (element: Element | null | undefined) =>
  (element?.getAttribute('aria-describedby') ?? '').split(' ').map((id) => {
    const target = document.getElementById(id)
    expect(target, `description ${id}`).not.toBeNull()
    return spoken(target as Element)
      .replace(/\s+/g, ' ')
      .trim()
  })

const tasks = (snap: Snapshot) => {
  snap.issues.push(
    {
      ...taskRow(snap, 'a', 'todo', 1),
      remaining_hours: 4,
      remaining_set_at: new Date().toISOString(),
    },
    { ...taskRow(snap, 'b', 'todo', 2), paused: true },
    taskRow(snap, 'c', 'progress', 3),
  )
}

describe('the Board for a screen reader', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('names each status cell as a list of its cards', async () => {
    const board = await loadBoard(network, tasks)
    await board.render(root)
    const lane = document.querySelector('[data-lane]')?.textContent?.trim()
    const lists = [...document.querySelectorAll('[data-board-cell][role="list"]')]
    expect(lists).toHaveLength(board.P.STATUSES.length)
    const todo = document.querySelector('[data-board-cell][data-status="todo"]')
    expect(todo?.getAttribute('aria-label')).toBe(lane ? `To Do, ${lane}` : 'To Do')
    const items = todo?.querySelectorAll(':scope > [role="listitem"]')
    expect(items).toHaveLength(2)
    expect(
      [...(todo?.children ?? [])].every((child) => child.getAttribute('role') === 'listitem'),
    ).toBe(true)
  })

  it('describes a card title with its priority, hours and pause', async () => {
    const board = await loadBoard(network, tasks)
    await board.render(root)
    const title = (uuid: string) => board.card(uuid)?.querySelector('[data-focus-key="title"]')
    const a = description(title('a')).join(' | ')
    expect(a).toContain('Medium priority')
    expect(a).toContain('4h')
    const b = description(title('b'))
    expect(b[0]).toBe('Paused')
    expect(b[1]).toContain('Medium priority')
  })

  it('describes a parent heading with its owner and priority', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(
        { ...taskRow(snap, 'p', 'todo', 1), due_date: '2026-11-12' },
        {
          ...taskRow(snap, 'k', 'todo', 2),
          parent_id: 'p',
        },
      )
    })
    await board.render(root)
    const heading = document.querySelector('[data-focus-key="parent"]')
    const text = description(heading).join(' ')
    expect(text).toBe('Planner, Medium priority, due 2026-11-12')
    // not the owner button's own name, which repeats the title
  })

  it('keeps the cards and waiting space of a large Board items of its list', async () => {
    const board = await loadBoard(network, (snap) => {
      for (let n = 0; n < 400; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n + 1))
    })
    await board.render(root)
    const todo = document.querySelector('[data-board-cell][data-status="todo"]')
    const space = todo?.querySelector('[data-board-pending]')
    expect(space?.getAttribute('aria-label')).toMatch(/^Loading \d+ more cards$/)
    expect(space?.parentElement?.getAttribute('role')).toBe('listitem')
    expect(space?.parentElement?.parentElement).toBe(todo)
    // the cards sit in block boxes with no role of their own
    const children = [...(todo?.children ?? [])]
    expect(
      children.every(
        (child) =>
          child.getAttribute('role') === 'listitem' ||
          (child.getAttribute('role') === 'none' &&
            [...child.children].every((card) => card.getAttribute('role') === 'listitem')),
      ),
    ).toBe(true)
    expect(todo?.querySelectorAll('[role="none"] > [role="listitem"]').length).toBeGreaterThan(0)
  })
})
