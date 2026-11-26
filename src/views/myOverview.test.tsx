// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForcedOverview } from '../store/overviewStandIn.setup'
import type { ScopeInfo } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* My view's Overview (views/overview/MyOverview.tsx) from the server's
   answers, through the Overview's stand-in (store/overviewStandIn.setup.ts),
   whose Your work holds the stored facts' kinds: the groups and their rows,
   the hours left edited in place, the actions' status changes, a reader who
   may not edit, keyboard focus when a row leaves its group, the empty
   states and a delay Qivo could not work out. Which tasks each group holds
   and in what order is the server's rule, which
   convex/tests/overviewWork.test.ts tests. */

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
  Element.prototype.getAnimations = () => []
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
  network.mutation.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Today's date `offset` days on, YYYY-MM-DD, local time. */
const day = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Plan over the fixture's sub-project One, and the person's tasks there:
    two In Progress, one of them overdue; one In Review waiting for a
    reviewer; one they review for Ben; two To Do; and one in Backlog and one
    Done, which Your work does not show. */
const work = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One' })
  const me = snap.profiles[0]
  snap.profiles.push({ ...me, id: 'ben', name: 'Ben Carter', auth_user_id: undefined })
  snap.issues.push(
    { ...taskRow(snap, 'wire', 'progress', 1), remaining_hours: 4 },
    { ...taskRow(snap, 'late', 'progress', 2), due_date: day(-3), remaining_hours: 8 },
    { ...taskRow(snap, 'spec', 'review', 3) },
    { ...taskRow(snap, 'check', 'review', 4), assignee_id: 'ben', reviewer_id: me.id },
    { ...taskRow(snap, 'first', 'todo', 5), due_date: day(20), remaining_hours: 6 },
    { ...taskRow(snap, 'second', 'todo', 6), due_date: day(40) },
    taskRow(snap, 'someday', 'backlog', 7),
    taskRow(snap, 'shipped', 'done', 8),
  )
}

async function overview(prepare: (snap: Snapshot) => void, { force = {} as ForcedOverview } = {}) {
  const board = await loadBoard(network, prepare, { scope: 'mine' })
  board.server.overview.force = force
  const { Overview } = await import('./Overview')
  const actions = new Proxy({}, { get: () => () => {} }) as never
  await board.renderView(root, (info: ScopeInfo) => <Overview info={info} actions={actions} />)
  return { board }
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const text = (selector: string) => q(selector)?.textContent ?? ''
/** The titles group `group` shows, in order. */
const titles = (group: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-ov-group="${group}"] [data-work]`)].map(
    (row) => row.querySelector('[data-focus-key="row"]')?.textContent,
  )
const row = (uuid: string) => q(`[data-work-id="${uuid}"]`)
const hours = (uuid: string) => row(uuid)?.querySelector<HTMLInputElement>('input')
/** The task updates sent. */
const updates = () =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === 'issues:update')
    .map(([, args]) => args as { patch: unknown; expected?: unknown })
/** The task updates sent, by their patches. */
const patches = () => updates().map((u) => u.patch)
/** Task updates answer when the test settles them, in the order sent:
    saved, refused, or with the error given. */
function heldUpdates() {
  const settle: ((outcome: boolean | Error) => void)[] = []
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'issues:update'
      ? new Promise((resolve, reject) => {
          settle.push((outcome) =>
            outcome === true
              ? resolve(null)
              : reject(
                  outcome === false
                    ? new ConvexError({ code: 'rule', message: 'Not allowed' })
                    : outcome,
                ),
          )
        })
      : Promise.resolve(null),
  )
  return (outcome: boolean | Error = true) => act(async () => settle.shift()?.(outcome))
}
/** The server's refusal of a value someone else changed first. */
const changedFirst = () =>
  new ConvexError({ code: 'conflict', reason: 'field_changed', message: 'changed' })

/** Types `value` into `input`, as a keyboard does. */
async function type(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error('no field')
  await act(async () => {
    input.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string) =>
  act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    )
  })
const blur = (input: HTMLInputElement | null | undefined) => act(async () => input?.blur())
/** A mouse press on `target`, which takes focus from `field` where one is
    given, as a browser blurs it on the press, held until `release`, which
    lets go and clicks in one task, as a browser does. */
async function hold(target: HTMLElement | null | undefined, field?: HTMLInputElement | null) {
  if (!target) throw new Error('nothing to press')
  const pointer = (type: string, buttons: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
      }),
    )
  await act(async () => {
    pointer('pointerdown', 1)
    field?.blur()
  })
  return {
    release: () =>
      act(async () => {
        pointer('pointerup', 0)
        target.click()
        await new Promise((r) => setTimeout(r, 0))
      }),
  }
}
/** What of a row takes room: its elements with their classes and, for each
    one not visually hidden, whether it holds text. */
const room = (el: Element | null | undefined): string =>
  !el || el.classList.contains('sr-only')
    ? ''
    : `${el.tagName}.${el.getAttribute('class') ?? ''}${el.textContent ? '+' : ''}(${[
        ...el.children,
      ]
        .map(room)
        .join()})`
/** Lets the store's repaint of the views, which runs on a timer, happen. */
async function repaint() {
  for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

describe("My view's Overview", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('shows the person’s open work in its three groups, with the status beside it', async () => {
    await overview(work)
    expect(titles('progress')).toEqual(['Task late', 'Task spec', 'Task wire'])
    expect(row('late')?.dataset.kind).toBe('overdue')
    expect(row('spec')?.dataset.kind).toBe('no_reviewer')
    expect(titles('review')).toEqual(['Task check'])
    expect(titles('next')).toEqual(['Task first', 'Task second'])
    expect(text('[data-ov-figure="work-progress"]')).toBe('3')
    expect(text('[data-ov-sentence]')).toBe('1 task is overdue.')
    // Backlog counts as left, as on a project's Overview
    expect(text('[data-ov-figure="tasks-left"]')).toBe('Tasks left7')
  })

  it('saves hours left on Enter, says so while it saves, and keeps what was typed where the save fails', async () => {
    await overview(work)
    let settle: (value: unknown) => void = () => {}
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'issues:update'
        ? new Promise((resolve) => {
            settle = resolve
          })
        : Promise.resolve(null),
    )
    // the row's status is in the page before it says anything, so a screen
    // reader hears it when its text changes
    const status = row('wire')?.querySelector('[role="status"]')
    expect(status?.textContent).toBe('')
    // a keypad that writes decimals with a comma
    await type(hours('wire'), '6,5')
    await press('Enter')
    expect(patches()).toEqual([{ remaining_hours: 6.5 }])
    expect(row('wire')?.querySelector('[role="status"]')).toBe(status)
    expect(status?.textContent).toBe('Saving…')
    await act(async () => settle(null))
    expect(row('wire')?.textContent).not.toContain('Saving…')
    // the next one is refused: the field keeps the text and says so
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'issues:update'
        ? Promise.reject(new ConvexError({ code: 'rule', message: 'Not allowed' }))
        : Promise.resolve(null),
    )
    await type(hours('late'), '3')
    await press('Enter')
    await act(async () => {})
    expect(row('late')?.textContent).toContain('The remaining hours were not saved')
    expect(hours('late')?.value).toBe('3')
    expect(hours('late')?.getAttribute('aria-invalid')).toBe('true')
  })

  it('writes nothing for hours that are not a number, says so, and puts the saved hours back on Escape', async () => {
    await overview(work)
    await type(hours('wire'), 'four')
    await blur(hours('wire'))
    expect(patches()).toEqual([])
    expect(row('wire')?.textContent).toContain('Enter the remaining hours as a number.')
    expect(hours('wire')?.value).toBe('four')
    await act(async () => hours('wire')?.focus())
    await press('Escape')
    expect(hours('wire')?.value).toBe('4')
    expect(row('wire')?.textContent).not.toContain('Enter the remaining hours')
  })

  it('sends the hours shown when typing began as the ones seen, and keeps the text where someone saved others first', async () => {
    const { board } = await overview(work)
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'issues:update'
        ? Promise.reject(
            new ConvexError({ code: 'conflict', reason: 'field_changed', message: 'changed' }),
          )
        : Promise.resolve(null),
    )
    await type(hours('first'), '12')
    const task = board.snapshot.issues.find((t) => t.id === 'first')
    if (task) task.remaining_hours = 9
    await board.deliver()
    await blur(hours('first'))
    await act(async () => {})
    expect(updates()).toMatchObject([
      { patch: { remaining_hours: 12 }, expected: { remaining_hours: 6 } },
    ])
    expect(hours('first')?.value).toBe('12')
    expect(row('first')?.textContent).toContain('The remaining hours were not saved')
    // saving again on purpose replaces the value they saved
    await act(async () => hours('first')?.focus())
    await blur(hours('first'))
    expect(updates()[1]).toMatchObject({
      patch: { remaining_hours: 12 },
      expected: { remaining_hours: 9 },
    })
  })

  it('saves hours typed while a save is on its way once that save answers', async () => {
    await overview(work)
    const settle = heldUpdates()
    await type(hours('wire'), '5')
    await blur(hours('wire'))
    await type(hours('wire'), '6')
    await blur(hours('wire'))
    expect(patches()).toEqual([{ remaining_hours: 5 }])
    await settle()
    expect(updates()).toMatchObject([
      { patch: { remaining_hours: 5 } },
      { patch: { remaining_hours: 6 }, expected: { remaining_hours: 5 } },
    ])
    expect(hours('wire')?.value).toBe('6')
    await settle()
    expect(hours('wire')?.value).toBe('6')
    expect(row('wire')?.textContent).not.toContain('Saving…')
  })

  it('sends the hours submitted during a save, never what is typed after them', async () => {
    await overview(work)
    const settle = heldUpdates()
    await type(hours('wire'), '5')
    await press('Enter')
    await type(hours('wire'), '6')
    await press('Enter')
    // back in the field, cleared to type something else, not submitted
    await type(hours('wire'), '')
    await settle()
    expect(updates()).toMatchObject([
      { patch: { remaining_hours: 5 } },
      { patch: { remaining_hours: 6 }, expected: { remaining_hours: 5 } },
    ])
    await settle()
    expect(updates()).toHaveLength(2)
    expect(hours('wire')?.value).toBe('')
    expect(document.activeElement).toBe(hours('wire'))
  })

  it('sends no hours submitted during a save that a value someone else saved refuses, also where a press held through the refusal submitted them', async () => {
    const { board } = await overview(work)
    const settle = heldUpdates()
    await type(hours('first'), '7')
    await press('Enter')
    await type(hours('first'), '8')
    const held = await hold(q('[data-work-id="second"] [data-ov-start]'), hours('first'))
    const task = board.snapshot.issues.find((t) => t.id === 'first')
    if (task) task.remaining_hours = 9
    await board.deliver()
    await settle(changedFirst())
    await held.release()
    await repaint()
    expect(updates()).toMatchObject([
      { patch: { remaining_hours: 7 }, expected: { remaining_hours: 6 } },
      { patch: { status: 'progress' } },
    ])
    expect(hours('first')?.value).toBe('8')
    expect(row('first')?.textContent).toContain('The remaining hours were not saved')
  })

  it('saves the hours of a field a press leaves at the press, also where the press opens another page', async () => {
    const { board } = await overview(work)
    heldUpdates()
    await type(hours('wire'), '5')
    const project = q('[data-ov-sub]')
    // as the project's Board does, which takes the Overview's page and rows
    project?.addEventListener('click', () => {
      root.unmount()
      board.P.releaseOverview()
    })
    const held = await hold(project, hours('wire'))
    await held.release()
    await repaint()
    expect(updates()).toMatchObject([
      { patch: { remaining_hours: 5 }, expected: { remaining_hours: 4 } },
    ])
  })

  it('sends hours submitted during a save when a press opens another page before that save answers, with that save’s hours as the ones seen, and nothing more where they are refused', async () => {
    const { board } = await overview(work)
    const settle = heldUpdates()
    await type(hours('wire'), '7')
    await press('Enter')
    await type(hours('wire'), '8')
    const project = q('[data-ov-sub]')
    project?.addEventListener('click', () => {
      root.unmount()
      board.P.releaseOverview()
    })
    const held = await hold(project, hours('wire'))
    await held.release()
    await repaint()
    // the first save lands, and someone else saves before the second
    await settle()
    await settle(
      new ConvexError({
        code: 'conflict',
        reason: 'field_changed',
        message: 'changed',
        changes: [
          {
            record: 'task',
            id: 'wire',
            field: 'remaining_hours',
            by: null,
            at: '2026-11-25T10:00:00.000Z',
          },
        ],
      }),
    )
    await repaint()
    expect(updates()).toMatchObject([
      { patch: { remaining_hours: 7 }, expected: { remaining_hours: 4 } },
      { patch: { remaining_hours: 8 }, expected: { remaining_hours: 7 } },
    ])
    // the page that held the text is gone, so the notice says it was discarded
    const said = vi
      .mocked(window.showToast)
      .mock.calls.map(([text]) => String(text))
      .join(' ')
    expect(said).toContain('discarded')
    expect(said).not.toContain('still in the')
  })

  it('says the hours were discarded where their save is refused after the page went to a project that keeps the Overview’s rows', async () => {
    const { board } = await overview(work)
    const settle = heldUpdates()
    await type(hours('wire'), '7')
    await press('Enter')
    // as a project in the sidebar does, which takes the page and keeps the rows
    await act(async () => {
      root.unmount()
      board.P.leaveOverviewPage()
    })
    await settle(
      new ConvexError({
        code: 'conflict',
        reason: 'field_changed',
        message: 'changed',
        changes: [
          {
            record: 'task',
            id: 'wire',
            field: 'remaining_hours',
            by: null,
            at: '2026-11-25T10:00:00.000Z',
          },
        ],
      }),
    )
    const said = vi
      .mocked(window.showToast)
      .mock.calls.map(([text]) => String(text))
      .join(' ')
    expect(said).toContain('discarded')
    expect(said).not.toContain('still in the')
  })

  it('adds no line to a row and takes none away while it saves, nor while a press is held when the save answers', async () => {
    await overview(work)
    const settle = heldUpdates()
    const status = () => row('wire')?.querySelector('[role="status"]')?.textContent
    const before = room(row('wire'))
    await type(hours('wire'), '5')
    await press('Enter')
    expect(status()).toBe('Saving…')
    expect(room(row('wire'))).toBe(before)
    let held = await hold(q('[data-ov-board]'))
    await settle()
    expect(status()).toBe('')
    expect(room(row('wire'))).toBe(before)
    await held.release()
    await type(hours('wire'), '6')
    await press('Enter')
    held = await hold(q('[data-ov-board]'))
    await settle(false)
    expect(room(row('wire'))).toBe(before)
    expect(row('wire')?.textContent).not.toContain('not saved')
    await held.release()
    expect(row('wire')?.textContent).toContain('The remaining hours were not saved')
  })

  it('shows and takes away the line a press that leaves the field brings only once its click is in', async () => {
    await overview(work)
    const settle = heldUpdates()
    await type(hours('wire'), 'four')
    let held = await hold(q('[data-ov-board]'), hours('wire'))
    expect(row('wire')?.textContent).not.toContain('Enter the remaining hours as a number.')
    await held.release()
    expect(row('wire')?.textContent).toContain('Enter the remaining hours as a number.')
    // a press that saves again takes a failed save's line away, and saves at the press
    await type(hours('late'), '3')
    await press('Enter')
    await settle(false)
    await act(async () => hours('late')?.focus())
    held = await hold(q('[data-ov-board]'), hours('late'))
    expect(patches()).toEqual([{ remaining_hours: 3 }, { remaining_hours: 3 }])
    expect(row('late')?.textContent).toContain('The remaining hours were not saved')
    await held.release()
    expect(row('late')?.textContent).not.toContain('The remaining hours were not saved')
  })

  it('keeps Your work, its rows’ fields and actions and the figures beside it as they were through a press that an answer reordering the rows arrives in, and shows that answer once the press is over', async () => {
    const { board } = await overview(work)
    heldUpdates()
    await type(hours('wire'), '5')
    const work_ = () => room(q('[data-ov-work]'))
    const before = work_()
    const held = await hold(q('[data-work-id="second"] [data-ov-start]'), hours('wire'))
    // the answer moves Task wire up, as new hours can, and Task first leaves Your work
    for (const t of board.snapshot.issues) {
      if (t.id === 'wire') t.due_date = day(-1)
      if (t.id === 'first') t.status = 'done'
    }
    await board.deliver()
    await repaint()
    expect(titles('progress')).toEqual(['Task late', 'Task spec', 'Task wire'])
    expect(titles('next')).toEqual(['Task first', 'Task second'])
    expect(work_()).toBe(before)
    expect(text('[data-ov-figure="work-next"]')).toBe('2')
    expect(text('[data-ov-figure="tasks-left"]')).toBe('Tasks left7')
    await held.release()
    await repaint()
    expect(patches()).toEqual([{ remaining_hours: 5 }, { status: 'progress' }])
    expect(titles('progress')).toEqual(['Task late', 'Task wire', 'Task spec'])
    expect(row('first')).toBeNull()
    expect(text('[data-ov-figure="tasks-left"]')).toBe('Tasks left6')
  })

  it('keeps hours being typed in a row that moves to another group, with focus in the field', async () => {
    const { board } = await overview(work)
    await type(hours('first'), '7')
    const task = board.snapshot.issues.find((t) => t.id === 'first')
    if (task) task.status = 'progress'
    await board.deliver()
    expect(titles('progress')).toContain('Task first')
    expect(hours('first')?.value).toBe('7')
    expect(document.activeElement).toBe(hours('first'))
  })

  it('keeps every row’s hours field and actions while Load more loads, with focus in the field being typed in', async () => {
    const { board } = await overview((snap) => {
      work(snap)
      for (let i = 0; i < 10; i++) snap.issues.push(taskRow(snap, `more-${i}`, 'todo', 20 + i))
    })
    expect(titles('next')).toHaveLength(10)
    await type(hours('wire'), '7')
    board.server.overview.hold = (query) => query === 'work'
    await act(async () => q('[data-ov-group="next"] [data-ov-more]')?.click())
    expect(text('[data-ov-group="next"] [data-ov-more]')).toBe('Loading…')
    expect(hours('wire')?.value).toBe('7')
    expect(document.activeElement).toBe(hours('wire'))
    expect(hours('first')).not.toBeNull()
    expect(q('[data-work-id="first"] [data-ov-start]')).not.toBeNull()
    board.server.overview.hold = false
    await board.answer()
    await repaint()
    expect(titles('next')).toHaveLength(12)
    expect(hours('wire')?.value).toBe('7')
    expect(document.activeElement).toBe(hours('wire'))
  })

  it('keeps every row’s hours field and actions while Retry asks a failed Load more again', async () => {
    const { board } = await overview((snap) => {
      work(snap)
      for (let i = 0; i < 10; i++) snap.issues.push(taskRow(snap, `more-${i}`, 'todo', 20 + i))
    })
    board.server.overview.fail = new Error('offline')
    board.server.overview.failing = (query, args) => query === 'work' && (args.next ?? 0) > 10
    await act(async () => q('[data-ov-group="next"] [data-ov-more]')?.click())
    await board.answer()
    await repaint()
    expect(q('[data-ov-work-retry]')).not.toBeNull()
    await type(hours('wire'), '7')
    board.server.overview.fail = undefined
    board.server.overview.hold = (query) => query === 'work'
    await act(async () => q('[data-ov-work-retry]')?.click())
    expect(hours('wire')?.value).toBe('7')
    expect(q('[data-work-id="first"] [data-ov-start]')).not.toBeNull()
    board.server.overview.hold = false
    await board.answer()
    await repaint()
    expect(titles('next')).toHaveLength(12)
  })

  /** Types 7 in Task wire's hours, asks Next for 20 rows with Load more and
      fails that read, while the read back to the first 10 is held. */
  async function failedLoadMore() {
    const { board } = await overview((snap) => {
      work(snap)
      for (let i = 0; i < 10; i++) snap.issues.push(taskRow(snap, `more-${i}`, 'todo', 20 + i))
    })
    await type(hours('wire'), '7')
    board.server.overview.hold = (query) => query === 'work'
    await act(async () => q('[data-ov-group="next"] [data-ov-more]')?.click())
    board.server.overview.fail = new Error('offline')
    board.server.overview.failing = (query, args) => query === 'work' && (args.next ?? 0) > 10
    await board.answer()
    await repaint()
    return board
  }

  it('keeps every row’s hours field and actions through a failed Load more, with focus in the field being typed in', async () => {
    await failedLoadMore()
    expect(q('[data-ov-work-retry]')).not.toBeNull()
    expect(titles('next')).toHaveLength(10)
    expect(hours('wire')?.value).toBe('7')
    expect(document.activeElement).toBe(hours('wire'))
    expect(hours('first')).not.toBeNull()
    expect(q('[data-work-id="first"] [data-ov-start]')).not.toBeNull()
  })

  it('asks the longer list with a Retry pressed while the rows a failed Load more went back to are read again, which only its own answer settles', async () => {
    const board = await failedLoadMore()
    const nextAsked = () =>
      [...board.server.overview.open].filter((s) => s.query === 'work').map((s) => s.args.next)
    await act(async () => q('[data-ov-work-retry]')?.click())
    await repaint()
    expect(nextAsked()).toEqual([20])
    expect(text('[data-ov-group="next"] [data-ov-more]')).toBe('Loading…')
    expect(hours('wire')?.value).toBe('7')
    // its own failure takes the list back to its rows, with Retry
    await board.answer()
    await repaint()
    expect(nextAsked()).toEqual([10])
    expect(q('[data-ov-work-retry]')).not.toBeNull()
    expect(titles('next')).toHaveLength(10)
    // and its own answer brings the longer list
    await act(async () => q('[data-ov-work-retry]')?.click())
    board.server.overview.fail = undefined
    board.server.overview.hold = false
    await board.answer()
    await repaint()
    expect(titles('next')).toHaveLength(12)
    expect(hours('wire')?.value).toBe('7')
  })

  it('lets the rows go and shows the error where the rows a failed Load more went back to fail too', async () => {
    const board = await failedLoadMore()
    expect(board.P.viewTask('overview:work', 'wire')?.uuid).toBe('wire')
    board.server.overview.failing = (query) => query === 'work'
    await board.answer()
    await repaint()
    expect(q('[data-ov-work]')?.dataset.ovWorkState).toBe('error')
    expect(board.P.viewTask('overview:work', 'wire')).toBeUndefined()
  })

  it('keeps an action on its way when Escape puts the hours back', async () => {
    await overview(work)
    await act(async () => q('[data-work-id="first"] [data-ov-start]')?.click())
    await type(hours('first'), '3')
    await press('Escape')
    expect(hours('first')?.value).toBe('6')
    expect(row('first')?.textContent).toContain('Saving…')
    await act(async () => q('[data-work-id="first"] [data-ov-start]')?.click())
    expect(patches()).toEqual([{ status: 'progress' }])
  })

  it('takes no Escape while the hours save, and keeps the text where that save fails', async () => {
    await overview(work)
    const settle = heldUpdates()
    await type(hours('wire'), '5')
    await press('Enter')
    await act(async () => hours('wire')?.focus())
    await press('Escape')
    expect(hours('wire')?.value).toBe('5')
    await settle(false)
    expect(hours('wire')?.value).toBe('5')
    expect(row('wire')?.textContent).toContain('The remaining hours were not saved')
  })

  it('keeps hours being typed while a live update renders the rows again', async () => {
    const { board } = await overview(work)
    await type(hours('first'), '12')
    for (const t of board.snapshot.issues) {
      if (t.id === 'second') t.title = 'Task second, renamed'
      if (t.id === 'first') t.remaining_hours = 9
    }
    await board.deliver()
    expect(titles('next')).toEqual(['Task first', 'Task second, renamed'])
    expect(hours('first')?.value).toBe('12')
    expect(document.activeElement).toBe(hours('first'))
  })

  it('sends Start and Send back as the status changes the task window makes, one at a time a row', async () => {
    await overview(work)
    await act(async () => q('[data-work-id="first"] [data-ov-start]')?.click())
    await act(async () => q('[data-work-id="check"] [data-ov-send-back]')?.click())
    expect(patches()).toEqual([{ status: 'progress' }, { status: 'progress' }])
    // a row whose change is on its way takes no second press
    await act(async () => q('[data-work-id="check"] [data-ov-approve]')?.click())
    expect(patches()).toHaveLength(2)
    expect(row('check')?.textContent).toContain('Saving…')
  })

  it('approves a review by moving it to Done', async () => {
    await overview(work)
    await act(async () => q('[data-work-id="check"] [data-ov-approve]')?.click())
    expect(patches()).toEqual([{ status: 'done' }])
  })

  it('shows no field and no action to a reader who may not edit the task', async () => {
    await overview((snap) => {
      work(snap)
      snap.profiles[0].org_role = 'viewer'
      snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'viewer' })
    })
    expect(titles('progress')).toHaveLength(3)
    expect(document.querySelector('[data-work] input')).toBeNull()
    expect(document.querySelector('[data-work] .mov-actions button')).toBeNull()
    expect(row('wire')?.querySelector('.mov-hours')?.textContent).toBe('4hleft')
  })

  it('keeps keyboard focus on a row that moves to another group, and moves it to the next row when its task leaves', async () => {
    const { board } = await overview(work)
    const open = (uuid: string) => row(uuid)?.querySelector<HTMLElement>('[data-focus-key="row"]')
    await act(async () => open('first')?.focus())
    const task = board.snapshot.issues.find((t) => t.id === 'first')
    if (task) task.status = 'progress'
    await board.deliver()
    expect(titles('next')).toEqual(['Task second'])
    expect(titles('progress')).toEqual(['Task late', 'Task spec', 'Task first', 'Task wire'])
    expect(document.activeElement).toBe(open('first'))
    if (task) task.status = 'done'
    await board.deliver()
    expect(document.activeElement).toBe(open('wire'))
  })

  it('moves keyboard focus to the empty state once approving the only review leaves nothing assigned', async () => {
    const { board } = await overview((snap) => {
      work(snap)
      snap.issues = snap.issues.filter((t) => t.id === 'check')
    })
    const approve = q('[data-work-id="check"] [data-ov-approve]')
    await act(async () => {
      approve?.focus()
      approve?.click()
    })
    expect(patches()).toEqual([{ status: 'done' }])
    const task = board.snapshot.issues.find((t) => t.id === 'check')
    if (task) task.status = 'done'
    await board.deliver()
    await repaint()
    const title = q('[data-empty-state-title]')
    expect(title?.textContent).toBe('Nothing assigned to you')
    expect(document.activeElement).toBe(title)
  })

  it('says plainly when a group, all of Your work or the whole view holds nothing', async () => {
    await overview((snap) => {
      work(snap)
      snap.issues = snap.issues.filter((t) => t.id !== 'check')
    })
    expect(text('[data-ov-group="review"] [data-ov-group-empty]')).toBe(
      'Nothing waits for your review.',
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview((snap) => {
      work(snap)
      snap.issues = snap.issues.filter((t) => t.id === 'someday')
    })
    expect(text('[data-ov-work-empty]')).toBe(
      'Nothing of yours is in progress, waiting on your review or next.',
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview((snap) => {
      work(snap)
      snap.issues = []
    })
    expect(text('[data-empty-state-title]')).toBe('Nothing assigned to you')
  })

  it('says a milestone’s Late tasks could not be counted where Your work answers unavailable', async () => {
    const { board } = await overview((snap) => {
      work(snap)
      snap.projects[0].track_delay = true
      snap.milestones.push({
        id: 'launch',
        project_id: 'plan',
        name: 'Launch',
        week: day(21),
        created_at: '2026-09-14T08:00:00.000Z',
      })
    })
    const line = () => text('[data-overview-milestone="launch"] .pov-mile-line')
    expect(line()).toContain('1 late task is due before it')
    board.server.overview.edit = (query, answer) =>
      query === 'work'
        ? { state: 'unavailable', reason: 'access_unchecked', message: 'Try again in a moment.' }
        : answer
    await board.answer()
    expect(line()).toContain('Qivo could not count the late tasks due before it')
  })

  it('says a delay it could not work out is unknown, never on track', async () => {
    await overview(
      (snap) => {
        work(snap)
        snap.projects[0].track_delay = true
      },
      { force: { work: 'unknown' } },
    )
    expect(row('wire')?.textContent).toContain('Delay unknown')
    expect(row('late')?.textContent).not.toContain('Delay unknown')
    expect(q('[data-ov-unknown]')).not.toBeNull()
    expect(text('[data-ov-sentence]')).toBe(
      '1 task is overdue. Qivo could not work out every projected delay.',
    )
  })
})
