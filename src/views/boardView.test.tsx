// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../store/plannerFixture.setup'
import { staleCutoff } from './board/boardArgs'
import {
  BOARD_TEST_TIMEOUT,
  cell,
  dragEvent,
  loadBoard,
  spread,
  taskRow,
} from './boardFixture.setup'

/* The Board from the server's answer (board/useBoardView.ts): the answer
   decides which tasks show, each as the model of its row
   (store/viewRows.ts); the filter row on screen narrows at once; another
   person's edits show with the next answer; the person's own pending
   writes show as painted; until the answer for the arguments on screen
   arrives the Board shows its loading frame, or narrows the answer on
   screen while typing only adds to its text filter; a Board that cannot
   show its tasks says why. */

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

/** `hours`:`minutes` today, local time: a faked clock stays on the day the
    stores of earlier tests in this file watch (lib/localDay.ts), which
    would otherwise rebuild for a day that moved back. */
const today = (hours: number, minutes: number) => new Date().setHours(hours, minutes, 0, 0)

/** Three To Do tasks, a, b and c, of medium priority, numbered as the
    organization handed out, so a new task takes the next number. */
const three = (snap: Snapshot) => {
  for (const [n, id] of ['a', 'b', 'c'].entries())
    snap.issues.push(taskRow(snap, id, 'todo', n + 1))
  snap.orgs[0].next_issue_num = 3
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

/** Holds every create the store sends until the test accepts the newest
    one, with the number the server gave it, or refuses it. Other writes
    never answer, as in loadBoard. */
function holdCreates() {
  const held: {
    args: Record<string, unknown>
    resolve: (v: unknown) => void
    reject: (e: unknown) => void
  }[] = []
  network.mutation.mockImplementation((ref, args) =>
    getFunctionName(ref) === 'issues:create'
      ? new Promise((resolve, reject) => held.push({ args, resolve, reject }))
      : new Promise(() => {}),
  )
  return {
    /** Accepts the newest create, answered with its stored number. */
    accept: (num: number) => {
      const create = held.pop()
      create?.resolve({ ...create.args, num })
    },
    refuse: (error: unknown) => held.pop()?.reject(error),
  }
}

/** Creates a task in the fixture's project, as the New task dialog does,
    and answers what it opens by and its uuid. */
async function addTask(
  board: Awaited<ReturnType<typeof loadBoard>>,
  input: Partial<Parameters<Awaited<ReturnType<typeof loadBoard>>['P']['addIssue']>[0]>,
) {
  let open: string | null = null
  await act(async () => {
    open = board.P.addIssue({ project: board.snapshot.projects[0].id, title: 'New', ...input })
  })
  const { refParts } = await import('../lib/taskReference')
  const uuid = refParts(open)?.uuid
  if (!open || !uuid) throw new Error('the create answered no reference')
  return { open: open as string, uuid }
}

/** Makes the Board's row source bring no row for the tasks `uuids` (as a
    source that brings rows in batches could, which useBoardView counts as
    missing), while the answer still names them. */
function withoutRows(P: { viewTask: (slot: string, uuid: string) => unknown }, uuids: string[]) {
  const original = P.viewTask.bind(P)
  vi.spyOn(P, 'viewTask').mockImplementation((slot: string, uuid: string) =>
    uuids.includes(uuid) ? undefined : original(slot, uuid),
  )
}

/** Sets the page's visibility, as the browser does when a tab hides. */
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

describe('the Board from its answer', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows the answer's tasks as the models of its rows, and only those", async () => {
    const board = await loadBoard(network, three)
    board.server.edit = (answer) =>
      answer.state === 'ok' ? { ...answer, rows: answer.rows.filter((r) => r.id !== 'c') } : answer
    await board.render(root)
    expect(state()).toBe('ok')
    expect(board.card('a')?.dataset.card).toBe(board.P.viewTask('board:desktop', 'a')?.id)
    expect(board.card('b')).not.toBeNull()
    // the server holds c, but the answer leaves it out
    expect(board.snapshot.issues.some((it) => it.id === 'c')).toBe(true)
    expect(board.card('c')).toBeNull()
    expect(count('todo')).toBe('2')
    expect(busy()).toBe(false)
  })

  it('narrows and widens with the answer when another person edits a task across the filters', async () => {
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
    // another person's edits reach the Board only with its answer
    const task = (id: string) => {
      const found = board.snapshot.issues.find((t) => t.id === id)
      if (!found) throw new Error(`no task ${id}`)
      return found
    }
    task('a').priority = 'low'
    task('d').priority = 'medium'
    await board.deliver()
    expect(board.card('a')).not.toBeNull()
    expect(board.card('d')).toBeNull()
    expect(state()).toBe('ok')
    await board.answer()
    expect(board.card('d')).not.toBeNull()
    expect(board.card('a')).toBeNull()
  })

  it('narrows with the answer when another person moves a task out of the selection, to Done under Focus or out of a search', async () => {
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
    // every card stays until the answer leaves it out
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, true, true])
    board.server.hold = false
    await board.answer()
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([false, false, false])
    expect(state()).toBe('ok')
  })

  it("shows the person's own pending writes as painted, and a task they create", async () => {
    const board = await loadBoard(network, three)
    await board.render(root)
    await board.filter({ mine: true })
    await board.answer()
    board.server.hold = true
    const { P } = board
    const handle = (uuid: string) => P.viewTask('board:desktop', uuid)?.id ?? ''
    // an edit of their own takes a task out at once
    await act(async () => void P.updateIssue(handle('b'), { assignee: null }))
    expect(board.card('b')).toBeNull()
    expect(board.card('a')).not.toBeNull()
    // a task they create shows before any answer names it
    let created: string | null = null
    await act(async () => {
      created = P.addIssue({
        project: board.snapshot.projects[0].id,
        title: 'New one',
        status: 'todo',
        priority: 'medium',
        assignee: board.snapshot.profiles[0].id,
      })
    })
    expect(created).not.toBeNull()
    const { refParts } = await import('../lib/taskReference')
    expect(board.card(refParts(created)?.uuid ?? '')).not.toBeNull()
    expect(state()).toBe('ok')
  })

  it("keeps the answer's order for the person's own pending writes among cards of one priority", async () => {
    const board = await loadBoard(network, (snap) => {
      three(snap)
      snap.orgs[0].next_issue_num = 3
    })
    await board.render(root)
    board.server.hold = true
    const { P } = board
    const handle = (uuid: string) => P.viewTask('board:desktop', uuid)?.id ?? ''
    const order = () =>
      [...(cell('todo')?.querySelectorAll<HTMLElement>('[data-card]') ?? [])].map(
        (card) => card.dataset.card,
      )
    const keys = ['a', 'b', 'c'].map(handle)
    expect(order()).toEqual(keys)
    // a pending edit keeps its card in its number's place…
    await act(async () => void P.updateIssue(handle('b'), { remaining: 5 }))
    expect(order()).toEqual(keys)
    // …and a pending new task, numbered after them, lands last
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
    // the card names the new task by the handle its reference opens
    expect(order()).toEqual([...keys, P.handleOfOpen(created ?? '')])
  })

  it("shows the person's new task at once in its place, asking for no task, and from the answer once the server took it", async () => {
    const board = await loadBoard(network, three)
    const create = holdCreates()
    await board.render(root)
    board.server.hold = true
    const { P } = board
    const made = await addTask(board, { title: 'New one', status: 'todo', priority: 'medium' })
    // a reference: the workspace holds no task, and nothing asked for any
    const order = () =>
      [...(cell('todo')?.querySelectorAll<HTMLElement>('[data-card]') ?? [])].map(
        (card) => card.dataset.card,
      )
    // numbered after a, b and c, it lands last, by the handle it opens by
    expect(order().at(-1)).toBe(P.handleOfOpen(made.open))
    expect(count('todo')).toBe('4')
    // the server stores it: the answer that holds it arrives, then the create answers
    board.snapshot.issues.push({
      ...taskRow(board.snapshot, made.uuid, 'todo', 4),
      title: 'New one',
    })
    board.server.hold = false
    await board.answer()
    await act(async () => create.accept(4))
    await wait(10)
    expect(order().at(-1)).toBe(P.handleOfOpen(made.open))
    expect(P.ownPaintedTasks().has(made.uuid)).toBe(false)
    expect(count('todo')).toBe('4')
  })

  it('takes a refused create away again', async () => {
    const board = await loadBoard(network, three)
    const create = holdCreates()
    await board.render(root)
    board.server.hold = true
    const made = await addTask(board, { title: 'Doomed', status: 'todo' })
    expect(board.card(made.uuid)).not.toBeNull()
    await act(async () => create.refuse(new Error('no write access')))
    await wait(10)
    expect(board.card(made.uuid)).toBeNull()
  })

  it("puts the person's new task in its place on a project's Board at its design size", async () => {
    // 798 open tasks over the project's three sub-projects, 266 each, the
    // design size of open tasks in a project; Done stays at everyday values
    const board = await loadBoard(
      network,
      (snap) => {
        spread(266)(snap)
        snap.orgs[0].next_issue_num = 798
      },
      { scope: 'plan' },
    )
    holdCreates()
    await board.render(root)
    expect(state()).toBe('ok')
    const cards = () => document.querySelectorAll('[data-card]').length
    await vi.waitFor(() => expect(cards()).toBe(798), { timeout: 15_000 })
    board.server.hold = true
    let open: string | null = null
    await act(async () => {
      open = board.P.addIssue({
        project: 'two',
        title: 'Calibrate the second bench',
        status: 'todo',
      })
    })
    const { refParts } = await import('../lib/taskReference')
    const uuid = refParts(open)?.uuid ?? ''
    await vi.waitFor(() => expect(board.card(uuid)).not.toBeNull(), { timeout: 15_000 })
    const lane = (card: HTMLElement | null) =>
      card
        ?.closest('[data-swimlane-panel]')
        ?.querySelector('[data-lane]')
        ?.getAttribute('data-lane')
    // in sub-project Two's lane, after its last task by number
    expect(lane(board.card(uuid))).toBe(lane(board.card('t532')))
    const inCell = [
      ...(board
        .card(uuid)
        ?.closest('[data-board-cell]')
        ?.querySelectorAll<HTMLElement>('[data-card]') ?? []),
    ]
    expect(inCell.at(-1)).toBe(board.card(uuid))
    expect(inCell.at(-2)).toBe(board.card('t532'))
    expect(cards()).toBe(799)
  })

  it("checks the person's new task against the whole text filter, its description included, before the server holds it", async () => {
    const board = await loadBoard(network, three)
    holdCreates()
    await board.render(root)
    await board.search('harness')
    await wait(300)
    await board.answer()
    board.server.hold = true
    // the description holds the word, which no row of the Board sends
    const found = await addTask(board, {
      title: 'Wire the rack',
      description: 'Use the spare harness.',
      status: 'todo',
    })
    const missed = await addTask(board, { title: 'Paint the rack', status: 'todo' })
    expect(board.card(found.uuid)).not.toBeNull()
    expect(board.card(missed.uuid)).toBeNull()
    // the counts know both, and do not wait
    expect(count('todo')).toBe('1')
    expect(busy()).toBe(false)
  })

  it('shows a parent heading the answer names before the store holds it', async () => {
    const board = await loadBoard(network, three)
    await board.render(root)
    await board.filter({ priority: 'high' })
    expect(state()).toBe('ok')
    // the server holds a new subtask and its parent, which the filter
    // leaves a heading; the workspace has brought neither
    board.snapshot.issues.push(taskRow(board.snapshot, 'par', 'todo', 9), {
      ...taskRow(board.snapshot, 'kid', 'todo', 10),
      parent_id: 'par',
      priority: 'high',
    })
    await board.answer()
    // the heading and the card are the answer's rows, and the count stands
    expect(state()).toBe('ok')
    expect(document.querySelector('[data-parent-heading]')?.textContent).toContain('Task par')
    expect(board.card('kid')).not.toBeNull()
    expect(count('todo')).toBe('1')
    await board.deliver()
    expect(state()).toBe('ok')
    expect(document.querySelector('[data-parent-heading]')?.textContent).toContain('Task par')
  })

  it('never looks empty or unmatched while a row the answer names has not arrived', async () => {
    const board = await loadBoard(network, () => {})
    const { STALL } = await import('../store/liveParts')
    const stall = STALL.ms
    STALL.ms = 40
    try {
      await board.render(root)
      expect(document.body.textContent).toContain('No tasks yet')
      withoutRows(board.P, ['late'])
      board.snapshot.issues.push({
        ...taskRow(board.snapshot, 'late', 'todo', 1),
        priority: 'high',
      })
      await board.answer()
      expect(state()).toBe('loading')
      expect(count('todo')).toBe('…')
      expect(document.body.textContent).not.toContain('No tasks yet')
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

  it('says rows are missing on side-boards, not that nothing matches', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan', metaViz: 'sideboards' })
    const { STALL } = await import('../store/liveParts')
    const stall = STALL.ms
    STALL.ms = 40
    try {
      await board.render(root)
      expect(state()).toBe('ok')
      withoutRows(board.P, ['late'])
      board.snapshot.issues.push({
        ...taskRow(board.snapshot, 'late', 'todo', 9),
        project_id: 'two',
        priority: 'high',
      })
      await board.filter({ priority: 'high' })
      await wait(100)
      expect(state()).toBe('incomplete')
      expect(document.querySelector('[data-board-incomplete]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('Nothing matches your filters')
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
      withoutRows(board.P, ['late', 'urgent'])
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

  it('stays loading while a row the answer names has not arrived, then says so past the bound', async () => {
    const board = await loadBoard(network, three)
    const { STALL } = await import('../store/liveParts')
    const stall = STALL.ms
    STALL.ms = 60
    try {
      await board.render(root)
      expect(state()).toBe('ok')
      // the server holds a task whose row the source has not brought
      withoutRows(board.P, ['late'])
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
      // the row arrives with the answer Try again asked for, and the Board
      // is whole
      vi.mocked(board.P.viewTask).mockRestore()
      await board.answer()
      expect(state()).toBe('ok')
      expect(board.card('late')).not.toBeNull()
      expect(count('todo')).toBe('4')
    } finally {
      STALL.ms = stall
    }
  })

  it('shows its loading frame, with no card, until the answer for the filter row on screen arrives', async () => {
    const board = await loadBoard(network, three)
    board.server.hold = true
    await board.render(root)
    expect(state()).toBe('loading')
    expect(busy()).toBe(true)
    // the columns stand, with no card, counts "…" and no empty note
    expect(document.querySelector('[data-card]')).toBeNull()
    expect(cell('todo')).not.toBeNull()
    expect(count('todo')).toBe('…')
    expect(message()).toBeNull()
    await board.answer()
    expect(state()).toBe('ok')
    expect(count('todo')).toBe('3')
    // a new filter shows the frame, no card of the earlier arguments, and
    // waits for its own answer
    await board.filter({ priority: 'high' })
    expect(state()).toBe('refreshing')
    expect(busy()).toBe(true)
    expect(document.querySelector('[data-card]')).toBeNull()
    expect(count('todo')).toBe('…')
    expect(document.body.textContent).not.toContain('Nothing matches your filters')
    await board.answer()
    expect(state()).toBe('ok')
    expect(document.body.textContent).toContain('Nothing matches your filters')
  })

  it('shows its frame with no lane or side-board until the answer names them, also under a clearable filter', async () => {
    for (const metaViz of ['swimlanes', 'sideboards'] as const) {
      const board = await loadBoard(network, plan, { scope: 'plan', metaViz })
      await board.render(root)
      expect(state()).toBe('ok')
      const groups = () =>
        document.querySelectorAll(metaViz === 'swimlanes' ? '[data-lane]' : '[data-board-group]')
          .length
      const shown = groups()
      expect(shown).toBe(2)
      board.server.hold = true
      await board.filter({ priority: 'urgent' })
      expect(state()).toBe('refreshing')
      // the groups come from the answer (store/scopeGroups.ts), so the
      // frame stands its columns with none until it arrives
      expect(groups()).toBe(0)
      expect(busy()).toBe(true)
      expect(document.querySelector('[data-card]')).toBeNull()
      expect(document.body.textContent).not.toContain('Nothing matches your filters')
      // the answer drops the lanes without cards and says nothing matches
      await board.answer()
      expect(state()).toBe('ok')
      expect(document.body.textContent).toContain('Nothing matches your filters')
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('narrows the answer on screen while typing only adds to its text, and shows the frame otherwise', async () => {
    const board = await loadBoard(network, (snap) => {
      three(snap)
      for (const [id, title] of [
        ['a', 'Order cables'],
        ['b', 'Order the case'],
        ['c', 'Wire the sensor'],
      ])
        Object.assign(snap.issues.find((t) => t.id === id) ?? {}, { title })
    })
    await board.render(root)
    await board.search('order')
    await wait(300)
    expect(state()).toBe('ok')
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, true, false])
    board.server.hold = true
    // letters added: the cards that still match stay, marked refreshing
    await board.search('order ca')
    expect(state()).toBe('refreshing')
    expect(busy()).toBe(true)
    expect(count('todo')).toBe('…')
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, true, false])
    await board.search('order cab')
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, false, false])
    // a narrowing that leaves no card says nothing matches only with the answer
    await board.search('order cabx')
    expect(state()).toBe('refreshing')
    expect(document.querySelector('[data-card]')).toBeNull()
    expect(document.body.textContent).not.toContain('Nothing matches your filters')
    // a deleted letter is no narrowing: the frame, no card
    await board.search('order ca')
    await wait(300)
    await board.answer()
    expect(state()).toBe('ok')
    await board.search('order c')
    expect(state()).toBe('refreshing')
    expect(document.querySelector('[data-card]')).toBeNull()
    // nor is another filter beside the text
    await wait(300)
    await board.answer()
    expect(document.querySelector('[data-card]')).not.toBeNull()
    await board.filter({ priority: 'high' })
    expect(document.querySelector('[data-card]')).toBeNull()
  })

  it('keeps the cards a narrowed text still matches once it goes out, until its answer arrives', async () => {
    const board = await loadBoard(network, (snap) => {
      three(snap)
      for (const [id, title] of [
        ['a', 'Order cables'],
        ['b', 'Order the case'],
        ['c', 'Wire the sensor'],
      ])
        Object.assign(snap.issues.find((t) => t.id === id) ?? {}, { title })
    })
    await board.render(root)
    await board.search('order')
    await wait(300)
    expect(state()).toBe('ok')
    board.server.hold = true
    await board.search('order cab')
    // typing rests and the new text goes out, its answer held back
    await wait(300)
    expect(board.server.asked.at(-1)?.filters.search).toBe('order cab')
    expect(state()).toBe('refreshing')
    expect(busy()).toBe(true)
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, false, false])
    // more letters narrow the same answer while the new text's waits
    await board.search('order cabl')
    await wait(300)
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, false, false])
    // the answer takes over
    await board.answer()
    expect(state()).toBe('ok')
    expect(['a', 'b', 'c'].map((id) => board.card(id) !== null)).toEqual([true, false, false])
  })

  it('says the selection holds no task from the answer, and that nothing matches under a clearable filter', async () => {
    const board = await loadBoard(network, () => {})
    await board.render(root)
    expect(state()).toBe('ok')
    expect(message()?.textContent).toBe('No tasks yet')
    expect(document.body.textContent).not.toContain('Tasks are still arriving')
    // a clearable filter that matches nothing keeps the columns, with Clear
    await board.filter({ priority: 'high' })
    await board.answer()
    expect(message()?.textContent).toBe('Nothing matches your filters')
    expect(cell('todo')).not.toBeNull()
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'Clear filters'),
    ).toBe(true)
    // Focus alone is no clearable filter
    await board.filter({ priority: null, focus: true })
    await board.answer()
    expect(message()?.textContent).toBe('No tasks yet')
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
    vi.setSystemTime(today(12, 20))
    const board = await loadBoard(network, three)
    await board.render(root)
    await board.filter({ stale: true })
    await wait(0)
    const first = board.server.asked.at(-1)?.filters.stale_before
    expect(first).toBe(staleCutoff(today(12, 0)))
    await setVisibility('hidden')
    vi.setSystemTime(today(12, 50))
    await setVisibility('visible')
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe(first)
    await setVisibility('hidden')
    vi.setSystemTime(today(14, 5))
    await setVisibility('visible')
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe(staleCutoff(today(14, 0)))
  })

  it('asks with a Stale cutoff taken again when a kept Board shows again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(today(12, 20))
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
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe(staleCutoff(today(12, 0)))
    // another page shows while the hour turns; the tab stays visible
    await render(false)
    vi.setSystemTime(today(14, 5))
    await render(true)
    expect(board.server.asked.at(-1)?.filters.stale_before).toBe(staleCutoff(today(14, 0)))
    expect(state()).toBe('ok')
  })

  it('waits for the answer before it takes a reveal', async () => {
    const board = await loadBoard(network, three)
    board.server.hold = true
    await board.render(root)
    const org = board.snapshot.orgs[0].id
    const a = board.P.handleNow('a', org, 1)
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
      const a = board.P.handleNow('a', board.snapshot.orgs[0].id, 1)
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
    // a task only the answer brings takes an owner change from its row
    const a = board.card('a')?.dataset.card ?? ''
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
    // while a write waits, the answer paints a timer turn later, with the
    // workspace (store/planner.ts owe)
    await wait(1)
    expect(state()).toBe('ok')
    await act(async () => void board.P.updateIssue(a, { assignee: me }))
    await board.answer()
    await wait(1)
    expect(lanes()).toEqual([`assignee:${me}`])
  })
})

describe('what the Board says in place of its columns', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('scrolls a message taller than the pane from its title, so every choice stays in reach', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.server.force = 'over_ceiling'
    await board.render(root)
    const card = document.querySelector<HTMLElement>('[data-board-root] > [data-empty-state]')
    expect(card?.classList).toContain('overflow-y-auto')
    expect(card?.classList).not.toContain('justify-center')
    // one block inside, centered by auto margins, holds the title and choices
    const block = card?.firstElementChild
    expect(block?.classList).toContain('m-auto')
    expect(block?.querySelector('[data-empty-state-title]')).not.toBeNull()
    expect(block?.querySelectorAll('[data-board-choice]').length).toBe(2)
  })

  it('asks to narrow a top-level project past the ceiling, offering its sub-projects', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        // after One among the lanes, before it by name
        const two = snap.projects.find((p) => p.id === 'two')
        if (two) two.name = 'Alpha'
      },
      { scope: 'plan' },
    )
    board.server.force = 'over_ceiling'
    await board.render(root)
    expect(state()).toBe('over_ceiling')
    expect(message()?.textContent).toBe("This selection exceeds the Board's 1,000-task limit.")
    expect(document.body.textContent).toContain('Choose a sub-project or narrow your filters.')
    expect(document.querySelector('[data-status-count]')).toBeNull()
    expect(document.querySelector('[data-card]')).toBeNull()
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[data-board-choice]')]
    // the answer's sub-projects in the sidebar's order, by name; must fail
    // for the lane order
    expect(choices.map((b) => b.dataset.boardChoice)).toEqual([
      'two',
      board.snapshot.projects[0].id,
    ])
    await act(async () => choices[0].click())
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
    board.server.hold = true
    const asked = board.server.asked.length
    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    await act(async () => retry?.click())
    expect(board.server.asked.length).toBe(asked + 1)
    // the error goes at once, and the Board waits for the fresh answer
    expect(state()).toBe('loading')
    expect(busy()).toBe(true)
    expect(message()).toBeNull()
    await board.answer()
    expect(state()).toBe('ok')
    expect(board.card('a')).not.toBeNull()
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

  it('shows its frame, not cards, until a selection past the ceiling answers', async () => {
    const board = await loadBoard(network, three)
    board.server.hold = true
    board.server.force = 'over_ceiling'
    await board.render(root)
    expect(state()).toBe('loading')
    expect(busy()).toBe(true)
    expect(document.querySelector('[data-card]')).toBeNull()
    expect(message()).toBeNull()
    await board.answer()
    expect(state()).toBe('over_ceiling')
  })

  it('ends a drag and the slices when a live answer leaves ok', async () => {
    // more cards than the Board mounts at once, 134 in each of three
    // sub-projects, under the design size of one
    const board = await loadBoard(network, spread(134), { scope: 'plan' })
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
