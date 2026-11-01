// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, dragEvent, loadBoard, taskRow } from './boardFixture.setup'

/* The Board from the server's answer (board/useBoardView.ts): the answer
   decides which tasks show, each as the store's own card; the filter row
   on screen narrows at once; the person's own pending writes show as
   painted; until the answer for the arguments on screen arrives the store's
   own result shows, marked; a Board that cannot show its tasks says why. */

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
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const frame = () => document.querySelector<HTMLElement>('[data-board-root]')
const state = () => frame()?.dataset.boardState
const busy = () => frame()?.getAttribute('aria-busy') === 'true'
const count = (status: string) =>
  document.querySelector(`[data-status-count="${status}"]`)?.textContent
const message = () => document.querySelector('[data-empty-state] [data-empty-state-title]')
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

/** Three To Do tasks, a, b and c, of medium priority. */
const three = (snap: Snapshot) => {
  for (const [n, id] of ['a', 'b', 'c'].entries())
    snap.issues.push(taskRow(snap, id, 'todo', n + 1))
}

/** A top-level project, Plan, over two sub-projects, One (the fixture's) and
    Two, each with a task. */
const plan = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One' })
  snap.projects.push({ ...base, id: 'two', key: 'TWO', num: 3, name: 'Two', parent_id: 'plan' })
  snap.issues.push(taskRow(snap, 'one-1', 'todo', 1))
  snap.issues.push({ ...taskRow(snap, 'two-1', 'todo', 2), project_id: 'two' })
}

/** Sets the page's visibility, as the browser does when a tab hides. */
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

describe('the Board from its answer', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows the answer's tasks as the store's own cards, and only those", async () => {
    const board = await loadBoard(network, three)
    board.server.edit = (answer) =>
      answer.state === 'ok' ? { ...answer, rows: answer.rows.filter((r) => r.id !== 'c') } : answer
    await board.render(root)
    expect(state()).toBe('ok')
    expect(board.card('a')?.dataset.card).toBe(board.P.issues.find((it) => it.uuid === 'a')?.id)
    expect(board.card('b')).not.toBeNull()
    // the store holds c, but the answer leaves it out
    expect(board.P.issues.some((it) => it.uuid === 'c')).toBe(true)
    expect(board.card('c')).toBeNull()
    expect(count('todo')).toBe('2')
    expect(busy()).toBe(false)
  })

  it('narrows at once when another person edits a task out of the filters, and widens only with the answer', async () => {
    const board = await loadBoard(network, (snap) => {
      three(snap)
      snap.issues.push({ ...taskRow(snap, 'd', 'todo', 4), priority: 'low' })
    })
    await board.render(root)
    await board.filter({ priority: 'medium' })
    await board.answer()
    expect(state()).toBe('ok')
    expect([board.card('a'), board.card('d')].map((card) => card !== null)).toEqual([true, false])
    board.server.hold = true
    // the workspace brings each edit before the Board's answer does
    const task = (id: string) => {
      const found = board.snapshot.issues.find((t) => t.id === id)
      if (!found) throw new Error(`no task ${id}`)
      return found
    }
    task('a').priority = 'low'
    await board.deliver()
    expect(board.card('a')).toBeNull()
    expect(state()).toBe('ok')
    // one edited into the filters waits for the answer
    task('d').priority = 'medium'
    await board.deliver()
    expect(board.card('d')).toBeNull()
    await board.answer()
    expect(board.card('d')).not.toBeNull()
    expect(board.card('a')).toBeNull()
  })

  it('narrows at once when another person moves a task out of the selection, to Done under Focus or out of a search', async () => {
    const board = await loadBoard(network, (snap) => {
      plan(snap)
      for (const [n, id] of ['a', 'b', 'c'].entries())
        snap.issues.push({ ...taskRow(snap, id, 'todo', n + 10), title: `Order cable ${id}` })
    })
    await board.render(root)
    expect(state()).toBe('ok')
    await board.filter({ focus: true })
    await board.search('cable')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await board.answer()
    expect(state()).toBe('ok')
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, true, true])
    board.server.hold = true
    const task = (id: string) => {
      const found = board.snapshot.issues.find((t) => t.id === id)
      if (!found) throw new Error(`no task ${id}`)
      return found
    }
    // out of the selection, to Done under Focus, out of the search
    task('a').project_id = 'two'
    task('b').status = 'done'
    task('c').title = 'Order the case'
    await board.deliver()
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([false, false, false])
    expect(state()).toBe('ok')
  })

  it("shows the person's own pending writes as painted, both ways", async () => {
    const board = await loadBoard(network, (snap) => {
      three(snap)
      snap.issues.push({ ...taskRow(snap, 'd', 'todo', 4), priority: 'low' })
    })
    await board.render(root)
    await board.filter({ priority: 'medium' })
    await board.answer()
    board.server.hold = true
    const { P } = board
    const handle = (uuid: string) => P.issues.find((it) => it.uuid === uuid)?.id ?? ''
    // an edit of their own takes a task out at once…
    await act(async () => void P.updateIssue(handle('b'), { priority: 'low' }))
    expect(board.card('b')).toBeNull()
    // …and brings one the answer left out in at once
    expect(board.card('d')).toBeNull()
    await act(async () => void P.updateIssue(handle('d'), { priority: 'medium' }))
    expect(board.card('d')).not.toBeNull()
    // a task they create shows before any answer names it
    let created: string | null = null
    await act(async () => {
      created = P.addIssue({
        project: board.snapshot.projects[0].id,
        title: 'New one',
        status: 'todo',
        priority: 'medium',
      })
    })
    expect(created).not.toBeNull()
    expect(board.card(P.issueById[created ?? '']?.uuid ?? '')).not.toBeNull()
    expect(state()).toBe('ok')
  })

  it('takes a refused create away again', async () => {
    const board = await loadBoard(network, three)
    let refuse: (error: unknown) => void = () => {}
    network.mutation.mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = reject
        }),
    )
    await board.render(root)
    board.server.hold = true
    let created: string | null = null
    await act(async () => {
      created = board.P.addIssue({
        project: board.snapshot.projects[0].id,
        title: 'Doomed',
        status: 'todo',
      })
    })
    const uuid = board.P.issueById[created ?? '']?.uuid ?? ''
    expect(board.card(uuid)).not.toBeNull()
    await act(async () => refuse(new Error('no write access')))
    await wait(10)
    expect(board.card(uuid)).toBeNull()
  })

  it('stays loading while the store lacks a parent heading the answer names', async () => {
    const board = await loadBoard(network, three)
    await board.render(root)
    await board.filter({ priority: 'high' })
    const a = board.snapshot.issues.find((t) => t.id === 'a')
    if (!a) throw new Error('no task a')
    a.priority = 'high'
    await board.deliver()
    expect(state()).toBe('ok')
    // the server holds a parent of a, which the filter leaves a heading
    board.snapshot.issues.push(taskRow(board.snapshot, 'par', 'todo', 9))
    a.parent_id = 'par'
    await board.answer()
    expect(state()).toBe('loading')
    expect(count('todo')).toBe('…')
    await board.deliver()
    expect(state()).toBe('ok')
    expect(document.body.textContent).toContain('Task par')
  })

  it('never looks empty or unmatched while tasks the answer names are missing', async () => {
    const board = await loadBoard(network, () => {})
    const { STALL } = await import('../store/liveParts')
    const stall = STALL.ms
    STALL.ms = 40
    try {
      await board.render(root)
      expect(document.body.textContent).toContain('No tasks yet')
      board.snapshot.issues.push({
        ...taskRow(board.snapshot, 'late', 'todo', 1),
        priority: 'high',
      })
      await board.answer()
      expect(state()).toBe('loading')
      expect(document.body.textContent).toContain('Loading tasks…')
      await wait(100)
      expect(state()).toBe('incomplete')
      expect(document.body.textContent).not.toContain('No tasks yet')
      expect(document.querySelector('[data-board-incomplete]')).not.toBeNull()
      // a filter the tasks held miss says nothing matches only once all arrived
      await board.filter({ priority: 'high' })
      await board.answer()
      await wait(100)
      expect(state()).toBe('incomplete')
      expect(document.body.textContent).not.toContain('Nothing matches your filters')
      expect(document.querySelector('[data-board-incomplete]')).not.toBeNull()
    } finally {
      STALL.ms = stall
    }
  })

  it('puts the phone note above its sections, with no empty card', async () => {
    const board = await loadBoard(network, three, { phone: true })
    const { STALL } = await import('../store/liveParts')
    const stall = STALL.ms
    STALL.ms = 40
    try {
      await board.render(root)
      board.snapshot.issues.push(taskRow(board.snapshot, 'late', 'todo', 4))
      await board.answer()
      await wait(100)
      expect(state()).toBe('incomplete')
      const note = document.querySelector('[data-board-incomplete]')
      const section = document.querySelector('.mobile-task-section')
      expect(note && section).toBeTruthy()
      expect(
        note && section
          ? note.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy()
      // with no task held, the note stands alone
      await board.filter({ priority: 'urgent' })
      board.snapshot.issues.push({
        ...taskRow(board.snapshot, 'urgent', 'todo', 5),
        priority: 'urgent',
      })
      await board.answer()
      await wait(100)
      expect(state()).toBe('incomplete')
      expect(document.querySelector('.mobile-task-row')).toBeNull()
      expect(document.body.textContent).not.toContain('No tasks here')
    } finally {
      STALL.ms = stall
    }
  })

  it('stays loading while the store lacks a task the answer names, then says so past the bound', async () => {
    const board = await loadBoard(network, three)
    const { STALL } = await import('../store/liveParts')
    const stall = STALL.ms
    STALL.ms = 60
    try {
      await board.render(root)
      expect(state()).toBe('ok')
      // the server holds a task the workspace has not brought yet
      board.snapshot.issues.push(taskRow(board.snapshot, 'late', 'todo', 4))
      await board.answer()
      expect(state()).toBe('loading')
      expect(busy()).toBe(true)
      expect(count('todo')).toBe('…')
      // the tasks it holds still show
      expect(board.card('a')).not.toBeNull()
      expect(document.querySelector('[data-board-incomplete]')).toBeNull()
      await wait(120)
      expect(state()).toBe('incomplete')
      expect(busy()).toBe(false)
      expect(count('todo')).toBe('…')
      expect(board.card('a')).not.toBeNull()
      const retry = document.querySelector<HTMLButtonElement>('[data-board-incomplete] button')
      const asked = board.server.asked.length
      await act(async () => retry?.click())
      expect(board.server.asked.length).toBe(asked + 1)
      // the workspace brings it, and the Board is whole
      await board.deliver()
      expect(state()).toBe('ok')
      expect(board.card('late')).not.toBeNull()
      expect(count('todo')).toBe('4')
    } finally {
      STALL.ms = stall
    }
  })

  it("shows the store's own result, marked, until the answer for the filter row on screen arrives", async () => {
    const board = await loadBoard(network, three)
    board.server.hold = true
    await board.render(root)
    expect(state()).toBe('loading')
    expect(busy()).toBe(true)
    expect(board.card('a')).not.toBeNull()
    expect(count('todo')).toBe('…')
    await board.answer()
    expect(state()).toBe('ok')
    expect(count('todo')).toBe('3')
    // a new filter narrows at once and waits for its own answer
    const b = board.snapshot.issues.find((t) => t.id === 'b')
    if (b) b.priority = 'high'
    await board.deliver()
    await board.filter({ priority: 'high' })
    expect(state()).toBe('refreshing')
    expect(busy()).toBe(true)
    expect(board.card('a')).toBeNull()
    expect(board.card('b')).not.toBeNull()
    expect(count('todo')).toBe('…')
    await board.answer()
    expect(state()).toBe('ok')
    expect(count('todo')).toBe('1')
  })

  it('asks the server once typing rests, and sends no text past its limit', async () => {
    const board = await loadBoard(network, (snap) => {
      three(snap)
      for (const [id, title] of [
        ['a', 'Order cables'],
        ['b', 'Wire the sensor'],
        ['c', 'Order the case'],
      ])
        Object.assign(snap.issues.find((t) => t.id === id) ?? {}, { title })
    })
    await board.render(root)
    const asked = board.server.asked.length
    await board.search('Order')
    await board.search('Order cab')
    // the store's own result shows at once
    expect(state()).toBe('refreshing')
    expect(board.card('a')).not.toBeNull()
    expect(board.card('b')).toBeNull()
    expect(board.server.asked.length).toBe(asked)
    await wait(300)
    expect(board.server.asked.slice(asked).map((args) => args.filters.search)).toEqual([
      'Order cab',
    ])
    expect(state()).toBe('ok')
    // spaces around it ask for the same
    await board.search('  Order cab ')
    await wait(300)
    expect(board.server.asked.length).toBe(asked + 1)
    expect(state()).toBe('ok')
    // past the limit the Board says so in place of its columns
    await board.search('x'.repeat(201))
    await wait(300)
    expect(state()).toBe('search_limit')
    expect(message()?.textContent).toBe(
      'A search must be at most 200 characters. Search for fewer words.',
    )
    expect(board.card('a')).toBeNull()
    expect(board.server.asked.length).toBe(asked + 1)
    expect(board.server.open.size).toBe(0)
  })

  it('pauses while the tab is hidden and says it refreshes until a fresh answer arrives', async () => {
    const board = await loadBoard(network, three)
    await board.render(root)
    expect(board.server.open.size).toBe(1)
    await setVisibility('hidden')
    expect(board.server.open.size).toBe(0)
    board.server.hold = true
    const asked = board.server.asked.length
    await setVisibility('visible')
    expect(board.server.open.size).toBe(1)
    expect(board.server.asked.length).toBe(asked + 1)
    expect(state()).toBe('refreshing')
    // a workspace delivery is no fresh answer
    await board.deliver()
    expect(state()).toBe('refreshing')
    await board.answer()
    expect(state()).toBe('ok')
  })

  it('asks with a Stale cutoff taken again when the tab shows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T10:20:00.000Z'))
    const board = await loadBoard(network, three)
    await board.render(root)
    await board.filter({ stale: true })
    await wait(0)
    const first = board.server.asked.at(-1)?.filters.stale_before
    expect(first).toBe('2026-07-03T10:00:00.000Z')
    await setVisibility('hidden')
    vi.setSystemTime(Date.parse('2026-10-31T10:50:00.000Z'))
    await setVisibility('visible')
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe(first)
    await setVisibility('hidden')
    vi.setSystemTime(Date.parse('2026-10-31T12:05:00.000Z'))
    await setVisibility('visible')
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe('2026-07-03T12:00:00.000Z')
  })

  it('asks with a Stale cutoff taken again when a kept Board shows again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-31T10:20:00.000Z'))
    const board = await loadBoard(network, three)
    const { Kanban } = await import('./Kanban')
    const { KeptView } = await import('../components/KeptView')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Kanban
    >[0]['actions']
    const filters = {
      mine: false,
      assignees: [],
      priority: null,
      stale: true,
      focus: false,
      search: '',
    }
    const render = (shown: boolean) =>
      board.renderView(root, (info) => (
        <KeptView view="board" shown={shown} className="view">
          <Kanban
            info={info}
            filters={filters}
            tweaks={{ metaViz: 'swimlanes' }}
            actions={actions}
          />
        </KeptView>
      ))
    await render(true)
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe('2026-07-03T10:00:00.000Z')
    // another page shows while the hour turns; the tab stays visible
    await render(false)
    vi.setSystemTime(Date.parse('2026-10-31T12:05:00.000Z'))
    await render(true)
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe('2026-07-03T12:00:00.000Z')
    expect(state()).toBe('ok')
  })

  it('waits for the answer before it takes a reveal', async () => {
    const board = await loadBoard(network, three)
    board.server.hold = true
    await board.render(root)
    const a = board.P.issues.find((it) => it.uuid === 'a')?.id ?? ''
    await board.reveal(a)
    expect(board.consumed.count).toBe(0)
    await board.answer()
    expect(board.consumed.count).toBe(1)
  })

  it('takes a reveal without showing it where a message replaces the Board', async () => {
    for (const phone of [false, true]) {
      const board = await loadBoard(network, three, { phone })
      board.server.force = 'unavailable'
      await board.render(root)
      expect(state()).toBe('unavailable')
      const a = board.P.issues.find((it) => it.uuid === 'a')?.id ?? ''
      await board.reveal(a)
      expect(board.consumed.count).toBe(1)
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('builds owner lanes from the cards, so a reassignment moves the card at once', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        three(snap)
        snap.profiles.push({
          ...snap.profiles[0],
          id: 'other',
          name: 'Olle Other',
          auth_user_id: undefined,
        })
        const c = snap.issues.find((t) => t.id === 'c')
        if (c) c.status = 'done'
      },
      { metaViz: 'assignees' },
    )
    await board.render(root)
    const lanes = () =>
      [...document.querySelectorAll<HTMLElement>('[data-lane]')].map((l) => l.dataset.lane)
    const me = board.snapshot.profiles[0].id
    expect(lanes()).toEqual([`assignee:${me}`])
    const a = board.P.issues.find((it) => it.uuid === 'a')?.id ?? ''
    board.server.hold = true
    await act(async () => void board.P.updateIssue(a, { assignee: 'other' }))
    expect(lanes()).toContain('assignee:other')
    expect(
      board
        .card('a')
        ?.closest('[data-swimlane-panel]')
        ?.querySelector('[data-lane]')
        ?.getAttribute('data-lane'),
    ).toBe('assignee:other')
    // under Focus alone, a person whose only cards it hides has no lane
    board.server.hold = false
    await board.filter({ focus: true })
    await board.answer()
    expect(state()).toBe('ok')
    await act(async () => void board.P.updateIssue(a, { assignee: me }))
    await board.answer()
    expect(lanes()).toEqual([`assignee:${me}`])
  })
})

describe('what the Board says in place of its columns', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('asks to narrow a top-level project past the ceiling, offering its sub-projects', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.server.force = 'over_ceiling'
    await board.render(root)
    expect(state()).toBe('over_ceiling')
    expect(message()?.textContent).toBe("This selection exceeds the Board's 1,000-task limit.")
    expect(document.body.textContent).toContain('Choose a sub-project or narrow your filters.')
    expect(document.querySelector('[data-status-count]')).toBeNull()
    expect(document.querySelector('[data-card]')).toBeNull()
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[data-board-choice]')]
    expect(choices.map((b) => b.dataset.boardChoice)).toEqual(
      board.P.scopeInfo('plan')?.groups.map((g) => g.proj.id),
    )
    await act(async () => choices[1].click())
    expect(board.actions.setScope).toHaveBeenCalledWith('two')
  })

  it('offers only the filters for one sub-project, and Search when it could not be read', async () => {
    const board = await loadBoard(network, plan, { scope: 'two' })
    board.server.force = 'over_ceiling'
    await board.render(root)
    expect(document.body.textContent).toContain('Narrow your filters.')
    expect(document.querySelector('[data-board-choice]')).toBeNull()
    board.server.force = 'over_budget'
    await board.answer()
    expect(state()).toBe('over_budget')
    expect(message()?.textContent).toBe(
      "This selection could not be loaded within the Board's limits.",
    )
    expect(document.body.textContent).not.toContain('1,000')
    const search = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Search this sub-project',
    )
    await act(async () => search?.click())
    expect(board.actions.openPalette).toHaveBeenCalledWith('two')
  })

  it('offers the sub-projects, not Search, for a top-level project it could not read', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.server.force = 'over_budget'
    await board.render(root)
    expect(document.querySelectorAll('[data-board-choice]')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Search this sub-project')
  })

  it('names the filters and projects to narrow My view by', async () => {
    const board = await loadBoard(network, three, { scope: 'mine' })
    board.server.force = 'over_ceiling'
    await board.render(root)
    expect(state()).toBe('over_ceiling')
    expect(document.body.textContent).toContain(
      'Narrow your filters, such as Focus, Priority, Stale or the text filter, or open a project.',
    )
  })

  it('says a Board is not available, with the reason the server gives', async () => {
    const board = await loadBoard(network, three)
    board.server.force = 'unavailable'
    await board.render(root)
    expect(state()).toBe('unavailable')
    expect(message()?.textContent).toBe('This Board is not available')
    expect(document.body.textContent).not.toContain('No tasks yet')
    board.server.force = 'access_unchecked'
    await board.answer()
    expect(document.body.textContent).toContain('Qivo could not check all of your access in time.')
  })

  it('says a failed read failed, shows no cards and asks again on Try again', async () => {
    const board = await loadBoard(network, three)
    board.server.fail = new Error('the read failed')
    await board.render(root)
    expect(state()).toBe('error')
    expect(document.querySelector('[data-card]')).toBeNull()
    expect(message()?.textContent).toBe('The Board could not be loaded')
    board.server.fail = undefined
    const asked = board.server.asked.length
    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    await act(async () => retry?.click())
    expect(board.server.asked.length).toBe(asked + 1)
    expect(state()).toBe('ok')
    expect(board.card('a')).not.toBeNull()
  })

  it('asks to choose a project in All projects, and asks the server nothing', async () => {
    const board = await loadBoard(network, plan, { scope: 'all' })
    await board.render(root)
    expect(state()).toBe('choose')
    expect(board.server.asked).toEqual([])
    expect(document.querySelector('[data-empty-state]')).not.toBeNull()
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[data-board-choice]')]
    expect(choices.map((b) => b.dataset.boardChoice)).toEqual(
      board.P.visibleProjects().map((p) => p.id),
    )
    await act(async () => choices[0].click())
    expect(board.actions.setScope).toHaveBeenCalledWith(choices[0].dataset.boardChoice)
  })

  it('opens a project from the phone chooser and keeps the tools row', async () => {
    const board = await loadBoard(network, plan, { scope: 'all', phone: true })
    await board.render(root)
    expect(state()).toBe('choose')
    expect(document.querySelector('.mobile-task-tools')).not.toBeNull()
    const choice = document.querySelector<HTMLButtonElement>('[data-board-choice]')
    await act(async () => choice?.click())
    expect(board.actions.openProject).toHaveBeenCalledWith(choice?.dataset.boardChoice)
    expect(board.actions.setScope).not.toHaveBeenCalled()
  })

  it('shows the narrowing message on the phone in place of its sections', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan', phone: true })
    await board.render(root)
    expect(document.querySelectorAll('.mobile-task-row')).toHaveLength(2)
    board.server.force = 'over_ceiling'
    await board.answer()
    expect(state()).toBe('over_ceiling')
    expect(document.querySelectorAll('.mobile-task-row')).toHaveLength(0)
    expect(document.querySelector('.mobile-task-tools')).not.toBeNull()
    expect(document.querySelector('[data-empty-state]')).not.toBeNull()
  })

  it('shows Loading, not cards, while the store holds more than the ceiling', async () => {
    const many = (snap: Snapshot) => {
      for (let n = 1; n <= 1001; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n))
    }
    const board = await loadBoard(network, many)
    board.server.hold = true
    await board.render(root)
    expect(state()).toBe('loading')
    expect(busy()).toBe(true)
    expect(document.querySelector('[data-card]')).toBeNull()
    expect(message()?.textContent).toBe('Loading tasks…')
    await board.answer()
    expect(state()).toBe('over_ceiling')
  })

  it('ends a drag and the slices when a live answer leaves ok', async () => {
    const many = (snap: Snapshot) => {
      for (let n = 1; n <= 400; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n))
    }
    const board = await loadBoard(network, many)
    await board.render(root)
    expect(state()).toBe('ok')
    const { isUpdateBlocked } = await import('../lib/updateSafety')
    const first = document.querySelector<HTMLElement>('[data-card]')?.closest('[draggable]')
    await act(async () => first?.dispatchEvent(dragEvent('dragstart')))
    expect(isUpdateBlocked()).toBe(true)
    board.server.force = 'over_ceiling'
    await board.answer()
    expect(state()).toBe('over_ceiling')
    expect(isUpdateBlocked()).toBe(false)
    expect(document.querySelector('[data-board-cell]')).toBeNull()
    expect(document.querySelector('[data-board-mount]')).toBeNull()
  })
})
