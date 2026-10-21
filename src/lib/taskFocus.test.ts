// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markTaskFocus, restoreTaskFocus } from './taskFocus'

/* Focus put back on a task's card after the Board drew it again, on DOM
   shaped like the Board's cells, cards and parent headings. */

beforeEach(() => {
  // jsdom scrolls nothing
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  document.body.innerHTML = ''
})

/** A cell holding `html`, as Kanban draws one. */
const cell = (status: string, html: string) =>
  `<div data-board-cell="pool" data-status="${status}">${html}</div>`
const card = (id: string) =>
  `<div data-card="${id}"><button data-focus-key="title">${id}</button><button data-focus-key="owner">owner</button></div>`
const family = (parent: string, child: string) =>
  `<div><div data-parent-heading="${parent}"><button data-focus-key="parent">${parent}</button></div>${card(child)}</div>`
const focused = () => {
  const el = document.activeElement
  const row = el?.closest<HTMLElement>('[data-card], [data-parent-heading]')
  return {
    task: row ? { ...row.dataset } : null,
    key: el?.getAttribute('data-focus-key') ?? null,
  }
}
const control = (row: string, key: string) =>
  document.querySelector<HTMLElement>(`[${row}] [data-focus-key="${key}"]`)!

describe('restoreTaskFocus', () => {
  it('finds the same control on the moved card', () => {
    document.body.innerHTML = cell('todo', card('A') + card('B')) + cell('review', '')
    const mark = markTaskFocus(control('data-card="A"', 'owner'))!
    document.body.innerHTML = cell('todo', card('B')) + cell('review', card('A'))
    expect(restoreTaskFocus(mark, { scroll: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'A' }, key: 'owner' })
  })

  it('finds a parent that became a card instead of focusing another task', () => {
    document.body.innerHTML = cell('review', family('P', 'C'))
    const mark = markTaskFocus(control('data-parent-heading="P"', 'parent'))!
    // its last subtask left: P is a card of its own, beside C
    document.body.innerHTML = cell('review', card('C') + card('P'))
    expect(restoreTaskFocus(mark, { scroll: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'P' }, key: 'title' })
  })

  it('finds a card that became a parent heading', () => {
    document.body.innerHTML = cell('todo', card('P'))
    const mark = markTaskFocus(control('data-card="P"', 'title'))!
    document.body.innerHTML = cell('todo', family('P', 'C'))
    expect(restoreTaskFocus(mark, { scroll: true })).toBe(true)
    expect(focused()).toEqual({ task: { parentHeading: 'P' }, key: 'parent' })
  })

  it('falls back to the card in the same place only once the task is gone', () => {
    document.body.innerHTML = cell('todo', card('A') + card('B') + card('C'))
    const mark = markTaskFocus(control('data-card="B"', 'title'))!
    document.body.innerHTML = cell('todo', card('A') + card('C'))
    expect(restoreTaskFocus(mark, { scroll: false })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'C' }, key: 'title' })
    expect(document.activeElement?.scrollIntoView).not.toHaveBeenCalled()
  })

  it('leaves focus alone when nothing fits', () => {
    document.body.innerHTML = cell('todo', card('A'))
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    document.body.innerHTML = cell('review', card('B'))
    document.body.setAttribute('inert', '')
    try {
      expect(restoreTaskFocus(mark, { scroll: true })).toBe(false)
    } finally {
      document.body.removeAttribute('inert')
    }
  })
})
