// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from '../views/boardFixture.setup'

/* The phone's task list on the real store renders again only the row of
   the task that changed. Each row draws its owner's portrait once, so the
   test counts portraits. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
const portraits = vi.hoisted(() => ({ count: 0 }))
vi.mock('./qivo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./qivo')>()
  return {
    ...actual,
    Avatar: (props: Parameters<typeof actual.Avatar>[0]) => {
      portraits.count++
      return actual.Avatar(props)
    },
  }
})

let container: HTMLDivElement
let root: Root
let slices: (() => void)[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  // the slices are MessageChannel tasks, which the test runs one at a time
  slices = []
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: { onmessage: (() => void) | null; close: () => void } = {
        onmessage: null,
        close: () => {},
      }
      port2 = { postMessage: () => slices.push(() => this.port1.onmessage?.()) }
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

describe('the phone task list', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('renders only the row of a renamed task', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        for (let n = 0; n < 30; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n + 1))
      },
      { phone: true },
    )
    await board.render(root)
    expect(document.querySelectorAll('.mobile-task-row')).toHaveLength(30)
    portraits.count = 0
    board.snapshot.issues[4].title = 'Renamed on another device'
    await board.deliver()
    expect(document.querySelector('.mobile-task-list')?.textContent).toContain(
      'Renamed on another device',
    )
    expect(portraits.count).toBe(1)
  })

  it('mounts the rows of its first screen, then the rest in slices', async () => {
    vi.stubGlobal('innerHeight', 400)
    const board = await loadBoard(
      network,
      (snap) => {
        for (let n = 0; n < 500; n++)
          snap.issues.push(taskRow(snap, `t${n}`, n % 2 ? 'todo' : 'progress', n + 1))
      },
      { phone: true },
    )
    await board.render(root)
    const rows = () => document.querySelectorAll('.mobile-task-row')
    const list = document.querySelector('.mobile-task-list')
    // 400px and 500px more, at 64px a row at least
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThanOrEqual(Math.ceil(900 / 64))
    expect(list?.getAttribute('aria-busy')).toBe('true')
    // the sections still count every task
    expect(document.querySelector('.mobile-task-section h2')?.textContent).toContain('250')
    while (slices.length) await act(async () => slices.shift()?.())
    expect(rows()).toHaveLength(500)
    expect(list?.getAttribute('data-board-mount')).toBe('complete')
  })
})
