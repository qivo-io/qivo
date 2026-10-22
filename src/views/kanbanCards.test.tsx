// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* Board cards mount no Radix tooltip or popover roots until someone uses
   them, and a card that goes live renders the same DOM. The mock counts
   the roots mounted at any moment. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
const roots = vi.hoisted(() => ({ tooltip: 0, popover: 0 }))
vi.mock('radix-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('radix-ui')>()
  const React = await import('react')
  /** `Root`, counted in `roots[kind]` while it is mounted. */
  const counted = <P extends object>(Root: React.ComponentType<P>, kind: keyof typeof roots) =>
    function Counted(props: P) {
      React.useEffect(() => {
        roots[kind]++
        return () => {
          roots[kind]--
        }
      }, [])
      return React.createElement(Root, props)
    }
  return {
    ...actual,
    Tooltip: { ...actual.Tooltip, Root: counted(actual.Tooltip.Root, 'tooltip') },
    Popover: { ...actual.Popover, Root: counted(actual.Popover.Root, 'popover') },
  }
})

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
  // cmdk scrolls its chosen row into view
  Element.prototype.scrollIntoView = () => {}
  window.showToast = vi.fn()
  roots.tooltip = 0
  roots.popover = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete document.documentElement.dataset.focusModality
  vi.unstubAllGlobals()
})

/** A pointer event of `type` from a `pointerType` pointer with no button held. */
function pointer(type: string, pointerType = 'mouse') {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  return event
}

const cards = () => [...document.querySelectorAll<HTMLElement>('.board-card')]
/** Every card's markup, without the live mark and with React's ids made equal. */
const markup = () =>
  cards().map((card) =>
    card.outerHTML.replace(/ data-card-live=""/g, '').replace(/«[^»]*»|_r_[0-9a-z]+_/g, 'ID'),
  )
const focusKeys = () =>
  cards().map((card) =>
    [...card.querySelectorAll<HTMLElement>('[data-focus-key]')].map((el) => el.dataset.focusKey),
  )

/** Twenty writable tasks in To Do. */
const twenty = (snap: Snapshot) => {
  for (let n = 0; n < 20; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n + 1))
}

describe('static Board cards', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('mount no tooltip or popover roots until a mouse points at one', async () => {
    // the Board's own controls, and one card: a card adds none, so twenty add none
    const chrome = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'lone', 'done', 1))
    })
    await chrome.render(root)
    const own = { ...roots }
    await act(async () => root.unmount())
    root = createRoot(container)
    const board = await loadBoard(network, twenty)
    await board.render(root)
    expect(cards()).toHaveLength(20)
    expect(roots).toEqual(own)
    await act(async () => {
      cards()[3].querySelector('[data-focus-key="title"]')?.dispatchEvent(pointer('pointermove'))
    })
    // the priority, the place, the owner button and its portrait; the picker
    expect(roots).toEqual({ tooltip: own.tooltip + 4, popover: own.popover + 1 })
    expect(cards()[3].hasAttribute('data-card-live')).toBe(true)
    expect(cards().filter((card) => card.hasAttribute('data-card-live'))).toHaveLength(1)
  })

  it('give only a title long enough to be clamped a tooltip with its whole text', async () => {
    const long = `Investigate ${'intermittent pairing failures '.repeat(8)}`.trim()
    const board = await loadBoard(network, (snap) => {
      snap.issues.push({ ...taskRow(snap, 'short', 'todo', 1) })
      snap.issues.push({ ...taskRow(snap, 'long', 'todo', 2), title: long })
    })
    await board.render(root)
    const titles = [
      ...container.querySelectorAll<HTMLElement>('[data-focus-key="title"] .line-clamp-4'),
    ]
    // only the long title is a tooltip trigger
    expect(titles.map((el) => [el.textContent, el.hasAttribute('data-tooltip-trigger')])).toEqual([
      ['Task short', false],
      [long, true],
    ])
    // the button carries the title for keyboard users, so the text takes no tab stop
    expect(titles[1].getAttribute('tabindex')).toBe('-1')
  })

  it('stay static under a touch', async () => {
    const board = await loadBoard(network, twenty)
    await board.render(root)
    const before = { ...roots }
    await act(async () => {
      cards()[0].dispatchEvent(pointer('pointerover', 'touch'))
      cards()[0].dispatchEvent(pointer('pointermove', 'touch'))
    })
    expect(cards()[0].hasAttribute('data-card-live')).toBe(false)
    expect(roots).toEqual(before)
  })

  it('keep keyboard focus on the same title node when a card goes live', async () => {
    const board = await loadBoard(network, twenty)
    await board.render(root)
    const title = cards()[5].querySelector<HTMLElement>('[data-focus-key="title"]')
    await act(async () => title?.focus())
    expect(cards()[5].hasAttribute('data-card-live')).toBe(true)
    expect(document.activeElement).toBe(title)
    expect(title?.isConnected).toBe(true)
  })

  it('put keyboard focus back on the owner button the switch remounted', async () => {
    const board = await loadBoard(network, twenty)
    await board.render(root)
    const owner = cards()[2].querySelector<HTMLElement>('[data-focus-key="owner"]')
    await act(async () => owner?.focus())
    const live = cards()[2].querySelector<HTMLElement>('[data-focus-key="owner"]')
    expect(cards()[2].hasAttribute('data-card-live')).toBe(true)
    expect(document.activeElement).toBe(live)
  })

  it('open the owner picker on one press of a static owner button', async () => {
    const board = await loadBoard(network, twenty)
    await board.render(root)
    // a tap: focus from a pointer does not make the card live by itself
    document.documentElement.dataset.focusModality = 'pointer'
    const owner = cards()[7].querySelector<HTMLElement>('[data-focus-key="owner"]')
    expect(owner?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => owner?.click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.contains(document.activeElement)).toBe(true)
    expect(
      cards()[7].querySelector('[data-focus-key="owner"]')?.getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it('open the owner picker when a press lands before the pointer made the card live', async () => {
    const board = await loadBoard(network, twenty)
    await board.render(root)
    const owner = cards()[6].querySelector<HTMLElement>('[data-focus-key="owner"]')
    // the mouse arrives and presses before React renders the live card
    await act(async () => {
      owner?.dispatchEvent(pointer('pointerover'))
      owner?.click()
    })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })

  it('keep keyboard focus that arrives while a pointer has the card going live', async () => {
    const board = await loadBoard(network, twenty)
    await board.render(root)
    const owner = cards()[4].querySelector<HTMLElement>('[data-focus-key="owner"]')
    await act(async () => {
      cards()[4].dispatchEvent(pointer('pointerover'))
      owner?.focus()
    })
    expect(document.activeElement?.getAttribute('data-focus-key')).toBe('owner')
    expect(cards()[4].contains(document.activeElement)).toBe(true)
  })

  it('render the same markup and tab stops static and live, for every card shape', async () => {
    const shapes = (readOnly: boolean) => async () => {
      const board = await loadBoard(network, (snap) => {
        const { TODAY_WEEK, weekToISO } = dates
        snap.projects[0].track_delay = true
        const add = (id: string, change: Partial<Snapshot['issues'][number]> = {}) =>
          snap.issues.push({ ...taskRow(snap, id, 'todo', snap.issues.length + 1), ...change })
        add('plain')
        add('unassigned', { assignee_id: undefined })
        add('paused', { paused: true })
        add('due', { due_date: '2026-01-05' })
        add('long', { title: 'A long title '.repeat(8) })
        add('late', {
          start_week: weekToISO(TODAY_WEEK),
          end_week: weekToISO(TODAY_WEEK),
          due_date: weekToISO(TODAY_WEEK),
          remaining_hours: 400,
          remaining_set_at: new Date().toISOString(),
        })
        add('top')
        add('parent', { parent_id: 'top', due_date: '2026-12-01' })
        add('child-a', { parent_id: 'parent' })
        add('child-b', { parent_id: 'parent', paused: true })
      })
      if (readOnly) vi.spyOn(board.P, 'canWrite').mockReturnValue(false)
      await board.render(root)
      const html = document.body.innerHTML
      // every shape is on the Board
      for (const shape of ['data-paused', 'data-focus-key="due"', 'data-parent-heading'])
        expect(html).toContain(shape)
      expect(html).toContain('Unassigned')
      expect(html).toMatch(/Delayed|Slipping/)
      expect(document.querySelectorAll('[data-focus-key="owner"]').length > 0).toBe(!readOnly)
      const staticMarkup = markup()
      const staticKeys = focusKeys()
      await act(async () => {
        for (const card of cards()) card.dispatchEvent(pointer('pointerover'))
      })
      expect(cards().every((card) => card.hasAttribute('data-card-live'))).toBe(true)
      expect(markup()).toEqual(staticMarkup)
      expect(focusKeys()).toEqual(staticKeys)
    }
    const dates = await import('../lib/dates')
    await shapes(false)()
    await act(async () => root.unmount())
    root = createRoot(container)
    await shapes(true)()
  })
})
