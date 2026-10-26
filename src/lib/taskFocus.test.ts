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

  it("falls back to its column's new task button once its cell is empty", () => {
    document.body.innerHTML =
      '<button data-status-add="todo">New task in To Do</button>' +
      `<div>${cell('todo', card('A'))}${cell('review', card('B'))}</div>`
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    document.querySelector('[data-card="A"]')!.remove()
    expect(restoreTaskFocus(mark, { scroll: false })).toBe(false)
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement?.textContent).toBe('New task in To Do')
  })

  it('falls back to a card in the nearest cell beside an empty one, the next one first', () => {
    // no new task buttons, as in side-boards and across all projects
    document.body.innerHTML = `<div>${cell('backlog', card('X'))}${cell('todo', card('A'))}${cell('progress', '')}${cell('review', card('B'))}</div>`
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    document.querySelector('[data-card="A"]')!.remove()
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'X' }, key: 'title' })
    document.querySelector('[data-card="X"]')!.remove()
    // nothing next to it now: the one two cells on
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'B' }, key: 'title' })
  })

  /** A shown Board view holding `html`. */
  const board = (html: string) => `<div data-workspace-view="kanban">${html}</div>`
  /** A lane of cells, as Kanban draws one. */
  const lane = (html: string) => `<div data-lane>${html}</div>`

  it("falls back to its column's new task button once its lane is gone", () => {
    document.body.innerHTML = board(
      '<button data-status-add="todo">New task in To Do</button>' +
        lane(cell('todo', card('A'))) +
        lane(cell('todo', '') + cell('review', card('B'))),
    )
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    // a filter hides the lane once its last card goes
    document.querySelector('[data-lane]')!.remove()
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement?.textContent).toBe('New task in To Do')
  })

  it('falls back to a card in another cell of its column once its lane is gone', () => {
    // no new task buttons, as across all projects
    document.body.innerHTML = board(
      lane(cell('todo', card('A'))) + lane(cell('todo', card('C')) + cell('review', card('B'))),
    )
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    document.querySelector('[data-lane]')!.remove()
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'C' }, key: 'title' })
  })

  it("falls back to the Board's filter row when no card of its column and no empty state is left", () => {
    // across all projects, with a filter on: no new task buttons, and the
    // lane goes with its last card while the other lanes stay
    document.body.innerHTML =
      '<div data-filter-row><input placeholder="Filter tasks…"><button>Me only</button></div>' +
      board(lane(cell('todo', card('A'))) + lane(cell('todo', '') + cell('review', card('B'))))
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    document.querySelector('[data-lane]')!.remove()
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('[data-filter-row] input'))
  })

  it("falls back to the title of the Board's empty state when it has no control, for that focus only", () => {
    document.body.innerHTML = board(lane(cell('todo', card('A'))))
    const mark = markTaskFocus(control('data-card="A"', 'title'))!
    // the scope's last task went: the view shows its empty state instead
    document.querySelector('[data-workspace-view]')!.innerHTML =
      '<div data-empty-state><div data-empty-state-title>No tasks yet</div></div>'
    const title = document.querySelector<HTMLElement>('[data-empty-state-title]')!
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement).toBe(title)
    title.blur()
    expect(title.hasAttribute('tabindex')).toBe(false)
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

describe("restoreTaskFocus on another view's rows", () => {
  /** A view's list under `heading`, its rows naming their tasks. */
  const view = (heading: string, ids: string[]) =>
    `<div data-workspace-view="overview"><h2>${heading}</h2>${ids.map((id) => `<button data-ovrow="${id}">${id}</button>`).join('')}</div>`
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-ovrow="${id}"]`)!

  it('takes no mark for an element that does not name the task', () => {
    document.body.innerHTML = view('Paused', ['A'])
    expect(markTaskFocus(row('A'), 'B')).toBeNull()
    expect(markTaskFocus(row('A'))).toBeNull()
  })

  it('finds the task in a row drawn again, else the row now in its place', () => {
    document.body.innerHTML = view('Paused', ['A', 'B', 'C'])
    const mark = markTaskFocus(row('B'), 'B')!
    document.querySelector('[data-workspace-view]')!.innerHTML = `<h2>Paused</h2>${['A', 'B', 'C']
      .map((id) => `<button data-ovrow="${id}">${id}</button>`)
      .join('')}`
    expect(restoreTaskFocus(mark, { scroll: false, nearby: false })).toBe(true)
    expect(document.activeElement).toBe(row('B'))
    row('B').remove()
    expect(restoreTaskFocus(mark, { scroll: false })).toBe(true)
    expect(document.activeElement).toBe(row('C'))
  })

  it('falls back to the heading above it once no such row is left, for that focus only', () => {
    document.body.innerHTML = view('Paused', ['A'])
    const mark = markTaskFocus(row('A'), 'A')!
    row('A').remove()
    const heading = document.querySelector<HTMLElement>('h2')!
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement).toBe(heading)
    heading.blur()
    expect(heading.hasAttribute('tabindex')).toBe(false)
  })

  it("falls back to the view's empty state once its list went with the heading above it", () => {
    document.body.innerHTML = view('Paused', ['A'])
    const mark = markTaskFocus(row('A'), 'A')!
    document.querySelector('[data-workspace-view]')!.innerHTML =
      '<div data-empty-state><div data-empty-state-title>No tasks yet</div><button>New task</button></div>'
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement?.textContent).toBe('New task')
  })
})

describe('restoreTaskFocus on Roadmap rows', () => {
  /** A Roadmap view with a track named by its button, and a task row
      under it for each id. */
  const roadmap = (ids: string[]) =>
    `<div data-workspace-view="roadmap"><div data-track="p1"><button data-lane-open="p1">Website</button></div>${ids
      .map((id) => `<div><button data-roadmap-task-open="${id}">${id}</button></div>`)
      .join('')}</div>`
  const task = (id: string) =>
    document.querySelector<HTMLElement>(`[data-roadmap-task-open="${id}"]`)!

  it("falls back to its track's button once the track's last task left, and keeps it in the Tab order", () => {
    document.body.innerHTML = roadmap(['A'])
    const mark = markTaskFocus(task('A'), 'A')!
    task('A').parentElement!.remove()
    const track = document.querySelector<HTMLElement>('[data-lane-open]')!
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(document.activeElement).toBe(track)
    // a button is in the Tab order on its own
    expect(track.hasAttribute('tabindex')).toBe(false)
  })
})

describe('restoreTaskFocus on the phone Board', () => {
  /** The phone's Board: a section with a heading and one cell for each
      status that holds cards, as MobileWorkspace draws them. */
  const phone = (groups: [string, string[]][]) =>
    `<div data-workspace-view="kanban">${groups
      .map(
        ([status, ids]) =>
          `<section><h2>${status}</h2><div data-board-cell="phone" data-status="${status}">${ids.map(card).join('')}</div></section>`,
      )
      .join('')}</div>`

  it('falls back to a card in the group now in its place once its group left, else the one before', () => {
    document.body.innerHTML = phone([
      ['todo', ['A']],
      ['progress', ['B']],
      ['review', ['C']],
    ])
    const mark = markTaskFocus(control('data-card="B"', 'title'))!
    // the phone drops a group with no card left
    document.querySelectorAll('section')[1].remove()
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'C' }, key: 'title' })
    const last = markTaskFocus(control('data-card="C"', 'title'))!
    document.querySelectorAll('section')[1].remove()
    expect(restoreTaskFocus(last, { scroll: false, beside: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'A' }, key: 'title' })
  })

  it('falls back to the nearest group before it once one archive took several groups', () => {
    document.body.innerHTML = phone([
      ['backlog', ['A']],
      ['todo', ['B']],
      ['progress', ['C']],
    ])
    const mark = markTaskFocus(control('data-card="C"', 'title'))!
    // a parent archived with its subtask empties To Do and In Progress
    document.querySelectorAll('section')[2].remove()
    document.querySelectorAll('section')[1].remove()
    expect(restoreTaskFocus(mark, { scroll: false, beside: true })).toBe(true)
    expect(focused()).toEqual({ task: { card: 'A' }, key: 'title' })
  })
})
