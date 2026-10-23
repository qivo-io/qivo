// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markTaskFocus, registerTaskMount, restoreTaskFocus } from './taskFocus'

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

  it('passes by a card in a view kept hidden behind another page', () => {
    document.body.innerHTML = cell('todo', card('A'))
    const mark = markTaskFocus(control('data-card="A"', 'owner'))!
    // the kept Board, hidden, holds the card first; the shown view after it
    document.body.innerHTML = `<div data-hidden-view="kanban">${cell('todo', card('A'))}</div><div data-workspace-view="roadmap">${cell('todo', card('A'))}</div>`
    expect(restoreTaskFocus(mark, { scroll: false })).toBe(true)
    expect(document.activeElement?.closest('[data-workspace-view]')).not.toBeNull()
  })

  it('takes only the remembered occurrence when asked to be exact', () => {
    document.body.innerHTML = cell('todo', family('P', 'A')) + cell('progress', family('P', 'B'))
    const mark = markTaskFocus(
      document.querySelector('[data-status="progress"] [data-focus-key="parent"]'),
    )
    expect(mark?.status).toBe('progress')
    // the progress occurrence waits to mount; the todo one is on the page
    document.body.innerHTML = cell('todo', family('P', 'A')) + cell('progress', '')
    expect(restoreTaskFocus(mark!, { scroll: false, mount: false, exact: true })).toBe(false)
    expect(document.activeElement).toBe(document.body)
    // mounting brings it back, and that occurrence takes focus
    const unregister = registerTaskMount(() => {
      const progress = document.querySelector('[data-status="progress"]')
      if (progress && !progress.innerHTML) progress.innerHTML = family('P', 'B')
    })
    try {
      expect(restoreTaskFocus(mark!, { scroll: false })).toBe(true)
      expect(document.activeElement?.closest('[data-status]')?.getAttribute('data-status')).toBe(
        'progress',
      )
    } finally {
      unregister()
    }
  })

  it('takes no neighbour when asked to be exact', () => {
    document.body.innerHTML = cell('todo', card('X') + family('P', 'A'))
    const mark = markTaskFocus(control('data-parent-heading="P"', 'parent'))!
    // P's heading leaves the cell, which stays on the page with X in it
    document.querySelector('[data-parent-heading="P"]')?.parentElement?.remove()
    expect(restoreTaskFocus(mark, { scroll: false, mount: false, exact: true })).toBe(false)
    expect(document.activeElement).toBe(document.body)
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
    // the same cell element, without B
    document.querySelector('[data-card="B"]')!.remove()
    expect(restoreTaskFocus(mark, { scroll: false, nearby: false })).toBe(false)
    expect(restoreTaskFocus(mark, { scroll: false })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'C' }, key: 'title' })
    expect(document.activeElement?.scrollIntoView).not.toHaveBeenCalled()
  })

  it('never falls back into a cell drawn again, such as another scope with the same lane key', () => {
    document.body.innerHTML = cell('todo', card('A') + card('B'))
    const mark = markTaskFocus(control('data-card="B"', 'title'))!
    document.body.innerHTML = cell('todo', card('X') + card('Y'))
    expect(restoreTaskFocus(mark, { scroll: false })).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('never focuses a card behind a modal window', () => {
    document.body.innerHTML = cell('todo', card('A'))
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    document.body.innerHTML = `<div inert>${cell('review', card('A'))}</div>`
    expect(restoreTaskFocus(mark, { scroll: true })).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('lets a registered view mount the card before it searches', () => {
    document.body.innerHTML = cell('todo', card('A'))
    const mark = markTaskFocus(control('data-card="A"', 'owner'))!
    document.body.innerHTML = cell('review', '')
    const unregister = registerTaskMount((asked) => {
      document.querySelector('[data-status="review"]')!.innerHTML = card(asked.taskId)
    })
    try {
      expect(restoreTaskFocus(mark, { scroll: false })).toBe(true)
      expect(focused()).toEqual({ task: { card: 'A' }, key: 'owner' })
    } finally {
      unregister()
    }
  })
})
