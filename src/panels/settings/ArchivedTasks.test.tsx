// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, useEffect, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { taskRef } from '../../lib/taskReference'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from '../../store/projectNavStandIn.setup'

/* Settings › Archived tasks on the real store, with the network mocked. The
   fixture's person is an organization admin who leads the top-level
   project Luma Sensor with its sub-projects Firmware and Electronics, and,
   with `partner`, holds a guest seat in Partner Co with its project
   Partner portal. The project picker reads the navigation reads from
   their stand-in (store/projectNavStandIn.setup.ts) over the workspace,
   and so does projectNav.resolve, which the project the page opens on
   goes through, unless `resolveAnswer` gives its answer. Each
   issues.archivedPage call waits until the test answers it, so a test can
   answer calls out of order, and so does each restore. `whenAsked` runs
   inside each archivedPage call, as the page makes it. `publish` delivers
   a changed snapshot. `setTaskOpen` says whether the task window shows
   over the page, as App does. The clock reads 15:00 local time on 16 Oct
   2026. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Args = {
  scope: { org_id: string; project_ids?: string[]; all?: true }
  cursor?: string
  search?: string
  limit?: number
}
type Row = Record<string, unknown> & { id: string }
type Call = {
  args: Args
  answer: (rows: Row[], next?: string | null, scanned?: number) => Promise<void>
  /** answers at once, outside act, from wherever the test is */
  answerNow: (rows: Row[], next?: string | null) => void
  /** answers that the scope is too wide to list side by side */
  tooWide: () => Promise<void>
  fail: () => Promise<void>
}
type Restore = {
  args: { org_id: string; id: string }
  answer: () => Promise<void>
  /** resolves the restore at once, outside act, from wherever the test is */
  answerNow: () => void
  refuse: () => Promise<void>
}

const NOW = new Date(2026, 9, 16, 15, 0)

let snap: Snapshot
let ORG: string
let META: string
let FW: string
let EL: string
let PARTNER: string
let PORTAL: string
let container: HTMLDivElement
let root: Root
let calls: Call[]
let restores: Restore[]
let whenAsked: ((args: Args) => void) | null
let publish: (snapshot: Snapshot) => void
let resolveAnswer: (() => Promise<unknown>) | null
let opened: ReturnType<typeof vi.fn<(task: string) => void>>
let store: typeof import('../../store/planner')
let setTaskOpen: (open: boolean) => Promise<void>
let ORBIT: string

/** Lets pending promises, effects and renders run. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** An archived task row as issues.archivedPage answers it, archived `days`
    before the fixed clock, in Firmware and owned by no one unless `patch`
    says otherwise. */
function task(num: number, days = 1, patch: Record<string, unknown> = {}): Row {
  return {
    id: `archived-${num}`,
    org_id: ORG,
    project_id: FW,
    num,
    title: `Task ${num}`,
    status: 'done',
    priority: 'medium',
    paused: false,
    created_at: '2026-01-01T08:00:00.000Z',
    updated_at: '2026-01-01T08:00:00.000Z',
    archived_at: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
    is_group: false,
    place: { project_name: 'Firmware', parent_name: 'Luma Sensor' },
    owner_name: null,
    can_restore: true,
    ...patch,
  }
}
/** `n` archived task rows numbered from `from`, archived `days` days back
    and a day earlier every ten rows. */
const many = (from: number, n: number, days = 2) =>
  Array.from({ length: n }, (_, i) => task(from + i, days + Math.floor(i / 10)))

/** The snapshot with Luma Sensor and its sub-projects Firmware and
    Electronics, and with `partner` a guest seat in Partner Co. */
function fixture(partner: boolean): Snapshot {
  const next = plannerFixture()
  const org = next.orgs[0].id
  const base = next.projects[0]
  // the person leads Luma Sensor, so the navigation reads, which judge an
  // admin by ordinary access, list it and its sub-projects
  const meta = {
    ...base,
    id: crypto.randomUUID(),
    type: 'meta' as const,
    key: 'LUMA',
    name: 'Luma Sensor',
    num: 2,
    lead_id: next.profiles[0].id,
  }
  const sub = (key: string, name: string, num: number) => ({
    ...base,
    id: crypto.randomUUID(),
    type: 'project' as const,
    parent_id: meta.id,
    key,
    name,
    num,
  })
  next.projects = [meta, sub('FW', 'Firmware', 3), sub('EL', 'Electronics', 4)]
  ORG = org
  META = meta.id
  FW = next.projects[1].id
  EL = next.projects[2].id
  PARTNER = crypto.randomUUID()
  PORTAL = crypto.randomUUID()
  if (partner) {
    const seat = crypto.randomUUID()
    next.orgs.push({ ...next.orgs[0], id: PARTNER, name: 'Partner Co', slug: 'partner' })
    next.profiles.push({ ...next.profiles[0], id: seat, org_id: PARTNER, org_role: 'guest' })
    next.myProfileIds.push(seat)
    next.projects.push({
      ...meta,
      id: PORTAL,
      org_id: PARTNER,
      key: 'PART',
      name: 'Partner portal',
      lead_id: undefined,
    })
    next.access.push({ project_id: PORTAL, profile_id: seat, level: 'user' })
  }
  return next
}

/** Renders the page on a fresh store, on a phone or not, opened on Luma
    Sensor or on no scope, with or without the Partner Co seat, and with
    `shape` changing the fixture first. */
async function open({
  phone = false,
  initial = 'meta' as 'meta' | 'none',
  partner = false,
  shape = (_snap: Snapshot) => {},
} = {}) {
  vi.resetModules()
  snap = fixture(partner)
  calls = []
  restores = []
  whenAsked = null
  resolveAnswer = null
  opened = vi.fn<(task: string) => void>()
  shape(snap)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail)
    if (name === 'workspace:whole') {
      publish = next
      next(structuredClone(snap))
    }
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'projectNav:resolve')
      return resolveAnswer ? resolveAnswer() : queryProjectNav(snap, name, args)
    if (name !== 'issues:archivedPage') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      calls.push({
        args,
        answer: async (rows, next = null, scanned = rows.length) => {
          await act(async () => resolve({ rows, next_cursor: next, scanned }))
          await settle()
        },
        answerNow: (rows, next = null) =>
          resolve({ rows, next_cursor: next, scanned: rows.length }),
        tooWide: async () => {
          await act(async () =>
            resolve({ rows: [], next_cursor: null, scanned: 0, too_wide: true }),
          )
          await settle()
        },
        fail: async () => {
          await act(async () => reject(new Error('Too many index ranges read')))
          await settle()
        },
      })
      whenAsked?.(args)
    })
  })
  network.mutation.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'issues:unarchive') return Promise.resolve(null)
    return new Promise((resolve, reject) =>
      restores.push({
        args,
        answer: async () => {
          await act(async () => resolve({ issue: { id: args.id }, left_parent: false }))
          await settle()
        },
        answerNow: () => resolve({ issue: { id: args.id }, left_parent: false }),
        refuse: async () => {
          await act(async () =>
            reject(
              new ConvexError({
                code: 'forbidden',
                message: 'requires edit access to this project',
              }),
            ),
          )
          await settle()
        },
      }),
    )
  })
  store = await import('../../store/planner')
  await store.initStore()
  const page = await import('./ArchivedTasks')
  const version = await import('../../store/usePlannerVersion')
  // whether the task window shows over the page, which Live re-renders on
  const shown = { taskOpen: false, rerender: () => {} }
  setTaskOpen = async (next) => {
    shown.taskOpen = next
    await act(async () => shown.rerender())
    await settle()
  }
  function Live() {
    version.usePlannerVersion()
    const [, rerender] = useReducer((n: number) => n + 1, 0)
    useEffect(() => {
      shown.rerender = rerender
    })
    const taskOpen = shown.taskOpen
    return (
      <page.ArchivedTasksPage
        initialProject={initial === 'meta' ? META : null}
        onOpenTask={opened}
        taskOpen={taskOpen}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
  await settle()
}

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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/** The element `selector` names, or a thrown error when there is none. */
function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
/** Whether the page shows `selector`. */
const has = (selector: string) => document.querySelector(selector) !== null
/** The text of the element `selector` names. */
const text = (selector: string) => find(selector).textContent ?? ''
/** The task ids of the listed rows, in order. */
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-archive-row]')].map(
    (el) => el.dataset.archiveRow,
  )
/** The button whose text is `label`. */
const button = (label: string) => {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}
/** Clicks `element` and lets the page settle. */
async function click(element: HTMLElement) {
  await act(async () => element.click())
  await settle()
}
/** Types `value` into the search and waits past its 250ms pause. The typing
    and the pause run with timeouts on fake time, so the pause takes no real
    time. The fixed clock moves with the pause and is set back before the
    page renders. Going back to real time drops any timeout still pending, so
    none may be. */
async function type(value: string) {
  const input = find<HTMLInputElement>('[data-archive-search]')
  const now = Date.now()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      vi.setSystemTime(now)
    })
    expect(vi.getTimerCount(), 'timeouts pending after the pause').toBe(0)
  } finally {
    vi.useFakeTimers({ toFake: ['Date'] })
  }
  await settle()
}
/** Opens the project picker. */
const openPicker = () => click(find('[data-archive-project]'))
/** Closes the project picker, as Escape in its empty field does. */
async function closePicker() {
  const field = find('[data-project-picker-search]')
  await act(async () =>
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  await settle()
}
/** Shows Luma Sensor's sub-projects in the open picker, unless they show. */
async function expandLuma() {
  if (!has(`[data-project-children="${META}"]`))
    await click(find(`[data-project-expand="${META}"]`))
}
/** Makes `value` the page's only choice in the picker: `all:<org>` for
    All projects of an organization, or a project id. A project's choice
    takes the projects chosen before off first, which reads nothing. */
async function choose(value: string) {
  await openPicker()
  if (value.startsWith('all:')) await click(find(`[data-project-pick-all="${value.slice(4)}"]`))
  else {
    await expandLuma()
    for (const row of document.querySelectorAll<HTMLElement>(
      '[data-project-pick][aria-checked="true"]:not(:disabled)',
    ))
      if (row.dataset.projectPick !== value) await click(row)
    if (find(`[data-project-pick="${value}"]`).getAttribute('aria-checked') !== 'true')
      await click(find(`[data-project-pick="${value}"]`))
  }
  await closePicker()
}
/** Adds project `id` to the page's choice in the picker. */
async function add(id: string) {
  await openPicker()
  await expandLuma()
  await click(find(`[data-project-pick="${id}"]`))
  await closePicker()
}
/** Adds Orbit Camera to `next`, a second top-level project the person
    leads. */
const orbit = (next: Snapshot) => {
  ORBIT = crypto.randomUUID()
  next.projects.push({ ...next.projects[0], id: ORBIT, key: 'ORB', num: 9, name: 'Orbit Camera' })
}
/** What the picker's trigger says. */
const trigger = () => text('[data-archive-project]')
/** The chosen projects' chips. */
const chips = () =>
  [...document.querySelectorAll<HTMLElement>('[data-archive-pick]')].map(
    (el) => el.dataset.archivePick,
  )
/** What the page says when the project it opened on did not resolve. */
const MISSED =
  "Couldn't open this page on that project. The project list shows the projects you take part in."
/** The newest issues.archivedPage call. */
const last = () => calls[calls.length - 1]
/** The scope argument of the project `id` of Testbed Labs. */
const project = (id: string) => ({ org_id: ORG, project_ids: [id] })

/* This file runs in the node project, whose default timeout is 5 s. Every
   test resets the modules and imports and boots the real planner store
   again. The first one also transforms the store and the page, and took up
   to 9 s on a busy host, so the tests get the 20 s the convex project gives
   its fixtures. */
describe('Archived tasks', { timeout: 20_000 }, () => {
  it('opens on its project with the search focused, 25 a page, Next and Previous replacing them', async () => {
    await open()
    expect(calls.map((c) => c.args)).toEqual([{ scope: project(META), limit: 25 }])
    expect(document.activeElement).toBe(find('[data-archive-search]'))
    // search comes first in the filters
    expect(
      find('.archived-filters').firstElementChild?.hasAttribute('data-archive-search-box'),
    ).toBe(true)
    expect(text('[data-archived-tasks]')).toContain('Loading archived tasks…')
    await last().answer(many(1, 25, 1), '3~p2')
    expect(rowIds()).toHaveLength(25)
    expect(text('[data-archive-count]')).toBe('Archived tasks 1 to 25')
    expect(text('[data-archive-row="archived-1"]')).toContain('Luma Sensor › Firmware')
    // a month divider heads the list
    expect(text('[data-archive-month]')).toBe('October 2026')
    expect(has('[data-archive-previous]')).toBe(false)
    expect(text('[data-archive-row="archived-1"] [data-archive-time]')).toBe('Yesterday 15:00')

    await click(button('Next'))
    expect(last().args).toEqual({ scope: project(META), cursor: '3~p2', limit: 25 })
    // the rows stay while the next page loads
    expect(text('[data-archive-fold]')).toBe('Loading…')
    expect(rowIds()).toHaveLength(25)
    await last().answer(many(26, 25, 30), '3~p3')
    // the page replaces the rows, and focus moves to its first row
    expect(rowIds()).toEqual(many(26, 25).map((row) => row.id))
    expect(text('[data-archive-count]')).toBe('Archived tasks 26 to 50')
    expect(document.activeElement).toBe(find('[data-archive-row="archived-26"]'))
    // dates before yesterday show only the day
    expect(text('[data-archive-row="archived-26"] [data-archive-time]')).toBe('16 Sep')

    await click(button('Next'))
    expect(last().args.cursor).toBe('3~p3')
    await last().answer(many(51, 5, 60))
    expect(rowIds()).toHaveLength(5)
    expect(text('[data-archive-count]')).toBe('Archived tasks 51 to 55')
    expect(text('[data-archive-fold]')).toBe('These are the oldest archived tasks.Previous')

    // Previous asks again from where the page before started
    await click(button('Previous'))
    expect(last().args).toEqual({ scope: project(META), cursor: '3~p2', limit: 25 })
    await last().answer(many(26, 25, 30), '3~p3')
    expect(text('[data-archive-count]')).toBe('Archived tasks 26 to 50')
    await click(button('Previous'))
    expect(last().args).toEqual({ scope: project(META), limit: 25 })
    await last().answer(many(1, 25, 1), '3~p2')
    expect(rowIds()).toHaveLength(25)
    expect(text('[data-archive-count]')).toBe('Archived tasks 1 to 25')
    expect(has('[data-archive-previous]')).toBe(false)
  })

  it('searches on the server a page at a time, and says how far it has read', async () => {
    await open()
    await last().answer(many(1, 25), '3~p2')
    await type('  drift ')
    expect(last().args).toEqual({ scope: project(META), search: 'drift', limit: 25 })
    expect(text('[data-archived-tasks]')).toContain('Searching archived tasks…')
    await last().answer([task(7, 3), task(9, 50)], '3~s2', 1000)
    expect(rowIds()).toEqual(['archived-7', 'archived-9'])
    expect(text('[data-archive-count]')).toBe('Matches 1 to 2')
    expect(text('[data-archive-fold]')).toBe(
      'Searched the newest 1,000 archived tasks.Search older tasks',
    )
    await click(button('Search older tasks'))
    expect(last().args).toEqual({
      scope: project(META),
      search: 'drift',
      cursor: '3~s2',
      limit: 25,
    })
    await last().answer([], '3~s3', 1000)
    expect(rowIds()).toEqual([])
    expect(has('[data-archive-count]')).toBe(false)
    expect(text('[data-archive-fold]')).toBe(
      'No more matches in the newest 2,000 archived tasks.PreviousSearch older tasks',
    )
    await click(button('Search older tasks'))
    await last().answer([task(400, 300)], null, 140)
    expect(rowIds()).toEqual(['archived-400'])
    expect(text('[data-archive-count]')).toBe('Match 3')
    expect(text('[data-archive-fold]')).toBe('These are the oldest matches.Previous')
    // a search that ends on its first page counts what it found
    await type('soak')
    await last().answer([task(12)], null, 300)
    expect(text('[data-archive-count]')).toBe('1 found')
    expect(has('[data-archive-fold]')).toBe(false)
  })

  it('keeps a search over the cap, sends nothing for it and says why', async () => {
    await open()
    await last().answer(many(1, 3), null)
    const sent = calls.length
    await type(`  ${'q'.repeat(201)} `)
    expect(find<HTMLInputElement>('[data-archive-search]').value).toHaveLength(204)
    expect(calls).toHaveLength(sent)
    expect(text('[data-archived-tasks]')).toContain(
      'A search must be at most 200 characters. Search for fewer words.',
    )
    expect(rowIds()).toEqual([])
    await type('q'.repeat(200))
    expect(last().args).toEqual({ scope: project(META), search: 'q'.repeat(200), limit: 25 })
  })

  it('says how far a search looked when it found nothing yet, and when it found nothing', async () => {
    await open()
    await last().answer([])
    await type('barometer')
    await last().answer([], '3~s2', 1000)
    expect(text('[data-archive-fold]')).toBe(
      'No matches in the newest 1,000 archived tasks.Search older tasks',
    )
    expect(has('[data-archive-count]')).toBe(false)
    await click(button('Search older tasks'))
    await last().answer([], null, 12)
    expect(text('[data-archived-tasks]')).toContain('No archived tasks match “barometer”.')
  })

  it('says a page without a search found nothing it may show yet, and offers Next', async () => {
    await open()
    // All projects read tasks of projects this person cannot see
    await last().answer([], '3~h2', 0)
    expect(has('[data-archive-count]')).toBe(false)
    expect(text('[data-archived-tasks]')).not.toContain('No archived tasks in')
    expect(text('[data-archive-fold]')).toBe(
      'No archived task you can see is among those read so far.Next',
    )
    await click(button('Next'))
    expect(last().args.cursor).toBe('3~h2')
    await last().answer([task(1)], null, 1)
    expect(rowIds()).toEqual(['archived-1'])
    expect(text('[data-archive-count]')).toBe('Archived task 1')
  })

  it('keeps focus on the step button while a search step runs and after it finds nothing', async () => {
    await open()
    await last().answer([])
    await type('barometer')
    await last().answer([], '3~s2', 1000)
    const more = find('[data-archive-more]')
    more.focus()
    await click(more)
    // the button stays, with the step's text, so focus stays on it
    expect(find('[data-archive-more]')).toBe(more)
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-disabled')).toBe('true')
    expect(text('[data-archive-fold]')).toBe(
      'No matches in the newest 1,000 archived tasks.Searching older tasks…',
    )
    // pressing it again while the step runs asks for nothing
    const asked = calls.length
    await click(more)
    expect(calls.length).toBe(asked)
    await last().answer([], '3~s3', 1000)
    expect(document.activeElement).toBe(find('[data-archive-more]'))
    expect(text('[data-archive-fold]')).toBe(
      'No matches in the newest 2,000 archived tasks.PreviousSearch older tasks',
    )
    // a step pressed without taking focus, as a tap may, hands focus to the
    // button when it finds nothing, and to Previous once the archive ends
    more.blur()
    await click(more)
    await last().answer([], '3~s4', 1000)
    expect(document.activeElement).toBe(find('[data-archive-more]'))
    find<HTMLElement>('[data-archive-more]').blur()
    await click(find('[data-archive-more]'))
    await last().answer([], null, 12)
    expect(document.activeElement).toBe(find('[data-archive-previous]'))
    expect(text('[data-archived-tasks]')).toContain('No archived tasks match “barometer”.')
  })

  it('starts again at the first page on a new scope or search, and drops late answers', async () => {
    await open()
    const first = last()
    await choose(FW)
    const second = last()
    expect(second.args).toEqual({ scope: project(FW), limit: 25 })
    await second.answer([task(2)])
    await first.answer([task(1)])
    expect(rowIds()).toEqual(['archived-2'])
    // the search follows the project
    await type('fan')
    const fan = last()
    await choose(EL)
    expect(last().args).toEqual({ scope: project(EL), search: 'fan', limit: 25 })
    await fan.answer([task(3)])
    expect(rowIds()).toEqual([])
    // a later page asked before the search changed is dropped too
    await last().answer(many(1, 25), '3~f2')
    await click(button('Search older tasks'))
    const older = last()
    await type('fans')
    const fans = last()
    expect(fans.args).toEqual({ scope: project(EL), search: 'fans', limit: 25 })
    await older.answer([task(99)], null)
    expect(rowIds()).toEqual([])
    await fans.answer([task(4)])
    expect(rowIds()).toEqual(['archived-4'])
    expect(has('[data-archive-previous]')).toBe(false)
  })

  it('keeps the rows when Next or Previous fails, and tries it again', async () => {
    await open()
    await last().answer(many(1, 25), '3~p2')
    const next = button('Next')
    next.focus()
    await click(next)
    await last().fail()
    expect(rowIds()).toHaveLength(25)
    expect(text('[data-archived-tasks]')).toContain("Couldn't load the next page.")
    // the button left with the failed step, so focus moves to Retry
    expect(document.activeElement).toBe(button('Retry'))
    await click(button('Retry'))
    expect(last().args.cursor).toBe('3~p2')
    // and Retry leaves too, so focus moves to the step's button
    expect(document.activeElement).toBe(find('[data-archive-more]'))
    await last().answer([task(200, 40)])
    expect(rowIds()).toEqual(['archived-200'])
    expect(document.activeElement).toBe(find('[data-archive-row="archived-200"]'))
    await click(button('Previous'))
    await last().fail()
    expect(rowIds()).toEqual(['archived-200'])
    expect(text('[data-archived-tasks]')).toContain("Couldn't load the previous page.")
    await click(button('Retry'))
    expect(last().args).toEqual({ scope: project(META), limit: 25 })
    await last().answer(many(1, 25), '3~p2')
    expect(rowIds()).toHaveLength(25)
  })

  it('shows a failed first page with Retry', async () => {
    await open()
    await last().fail()
    expect(text('[data-archived-tasks]')).toContain("Couldn't load the archive.")
    await click(button('Retry'))
    await last().answer([task(1)])
    expect(rowIds()).toEqual(['archived-1'])
  })

  it('offers All projects for each organization, never on its own, and asks for all', async () => {
    await open({ initial: 'none', partner: true })
    expect(calls).toEqual([])
    expect(trigger()).toBe('Choose projects…')
    await openPicker()
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-project-pick-all]')].map((el) => [
        el.dataset.projectPickAll,
        el.textContent,
      ]),
    ).toEqual([
      [ORG, 'All projects in Testbed Labs'],
      [PARTNER, 'All projects in Partner Co'],
    ])
    await closePicker()
    expect(calls).toEqual([])
    await choose(`all:${PARTNER}`)
    expect(trigger()).toBe('All projects in Partner Co')
    expect(chips()).toEqual([])
    expect(calls.map((c) => c.args)).toEqual([{ scope: { org_id: PARTNER, all: true }, limit: 25 }])
    await last().answer([], null, 0)
    // with two organizations the note names the one it read
    expect(text('[data-archived-tasks]')).toContain(
      'No archived tasks in any project you can see in Partner Co.',
    )
    // one organization names it All projects, and a project opens on itself
    await open()
    expect(trigger()).toBe('Luma Sensor')
    expect(chips()).toEqual([META])
    await openPicker()
    expect(text('[data-project-pick-all]')).toBe('All projects')
    await closePicker()
    await choose(`all:${ORG}`)
    expect(last().args).toEqual({ scope: { org_id: ORG, all: true }, limit: 25 })
    await last().answer([], null, 0)
    expect(text('[data-archived-tasks]')).toContain('No archived tasks in any project you can see.')
  })

  it('takes place, owner and Restore from the answer, and restores with the row’s organization', async () => {
    await open({ partner: true })
    await last().answer([
      task(1, 1, { owner_name: 'Rui Costa', place: { project_name: 'Lab', parent_name: null } }),
      task(2, 1, { can_restore: false }),
    ])
    // the planner knows no Rui Costa and no project Lab, and this admin could
    // restore anything there, so all of it is the server's
    expect(text('[data-archive-row="archived-1"]')).toContain('Lab')
    expect(text('[data-archive-row="archived-1"]')).toContain('Rui Costa')
    expect(has('[data-archive-row="archived-1"] [data-restore]')).toBe(true)
    expect(has('[data-archive-row="archived-2"] [data-restore]')).toBe(false)
    // a task of the guest seat's organization restores there, also from a
    // project the planner has not loaded
    await choose(`all:${PARTNER}`)
    expect(last().args).toEqual({ scope: { org_id: PARTNER, all: true }, limit: 25 })
    await last().answer([task(5, 1, { org_id: PARTNER, project_id: crypto.randomUUID() })])
    await click(find('[data-archive-row="archived-5"] [data-restore]'))
    expect(restores.map((r) => r.args)).toEqual([{ org_id: PARTNER, id: 'archived-5' }])
  })

  it('removes a restored row, asks for its page again and moves focus to the next row', async () => {
    await open()
    await last().answer(many(1, 25), '3~p2')
    await click(button('Next'))
    await last().answer([task(26), task(27), task(28), task(29)], '3~p3')
    const asked = calls.length
    // from the keyboard, as focus follows only a restore made from its row
    const restore = find('[data-archive-row="archived-27"] [data-restore]')
    restore.focus()
    await click(restore)
    expect(text('[data-archive-row="archived-27"] [data-restore]')).toBe('Restoring…')
    expect(calls.length).toBe(asked)
    await restores[0].answer()
    expect(window.showToast).toHaveBeenCalledWith('Restored QN-27')
    expect(rowIds()).toEqual(['archived-26', 'archived-28', 'archived-29'])
    // focus moves on to the next row still listed
    expect(document.activeElement).toBe(find('[data-archive-row="archived-28"]'))
    // the page asks again from where it started, and the next task fills it;
    // the server restored 28 too, as the parent of 27
    expect(last().args).toEqual({ scope: project(META), cursor: '3~p2', limit: 25 })
    await last().answer([task(26), task(29), task(30)], '3~p3')
    expect(rowIds()).toEqual(['archived-26', 'archived-29', 'archived-30'])
    expect(text('[data-archive-count]')).toBe('Archived tasks 26 to 28')
    expect(document.activeElement).not.toBe(document.body)
  })

  it('keeps a row whose restore is refused, and asks for nothing', async () => {
    await open()
    await last().answer([task(1), task(2)])
    const asked = calls.length
    await click(find('[data-archive-row="archived-2"] [data-restore]'))
    await restores[0].refuse()
    expect(rowIds()).toEqual(['archived-1', 'archived-2'])
    expect(text('[data-archive-row="archived-2"] [data-restore]')).toBe('Restore')
    expect(calls.length).toBe(asked)
    expect(window.showToast).not.toHaveBeenCalledWith('Restored QN-2')
  })

  /** The snapshot row of an active task, as it reads once restored. */
  const active = (num: number) => ({
    id: `archived-${num}`,
    org_id: ORG,
    project_id: FW,
    num,
    title: `Task ${num}`,
    description: '',
    status: 'done' as const,
    priority: 'medium' as const,
    paused: false,
    created_at: '2026-01-01T08:00:00.000Z',
    updated_at: '2026-01-01T08:00:00.000Z',
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  /** Delivers the snapshot with `nums` active again. */
  async function restoredElsewhere(...nums: number[]) {
    snap.issues.push(...nums.map(active))
    snap.delivered_at = new Date(Date.parse(snap.delivered_at) + 1000).toISOString()
    await act(async () => publish(structuredClone(snap)))
    await settle()
  }

  it('lets a task someone else restores leave as soon as the snapshot shows it', async () => {
    await open()
    await last().answer([task(1), task(2), task(3)])
    const asked = calls.length
    await restoredElsewhere(2)
    expect(rowIds()).toEqual(['archived-1', 'archived-3'])
    expect(text('[data-archive-count]')).toBe('2 archived tasks')
    expect(calls.length).toBe(asked)
  })

  it('lets a restore that lands just after a change of scope touch nothing', async () => {
    await open()
    await last().answer([task(1), task(2)])
    await click(find('[data-archive-row="archived-2"] [data-restore]'))
    const asked = calls.length
    // the restore lands while the page makes its first call for Firmware,
    // before React has run anything after that commit
    whenAsked = (args) => {
      if (args.scope.project_ids?.[0] === FW) restores[0].answerNow()
    }
    // Luma Sensor comes off first, which reads nothing
    await openPicker()
    await expandLuma()
    await click(find(`[data-project-pick="${META}"]`))
    expect(calls.length).toBe(asked)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    find(`[data-project-pick="${FW}"]`).click()
    await new Promise((done) => setTimeout(done, 50))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    whenAsked = null
    await settle()
    // only Firmware's first page was asked for, and its answer shows
    expect(calls.slice(asked).map((c) => c.args)).toEqual([{ scope: project(FW), limit: 25 }])
    await last().answer([task(7)])
    expect(rowIds()).toEqual(['archived-7'])
    expect(text('[data-archived-tasks]')).not.toContain('Loading archived tasks…')
  })

  it('reads the new page again once a restore that landed during Next settles', async () => {
    await open()
    await last().answer(many(1, 25), '3~p2')
    await click(button('Next'))
    // Restore on the page still on screen, which lands while Next runs
    await click(find('[data-archive-row="archived-3"] [data-restore]'))
    await restores[0].answer()
    const asked = calls.length
    await last().answer(many(26, 25, 30), '3~p3')
    // the page Next brought is asked for again from where it starts
    expect(calls.length).toBe(asked + 1)
    expect(last().args).toEqual({ scope: project(META), cursor: '3~p2', limit: 25 })
    await last().answer(many(26, 25, 30), '3~p3')
    expect(text('[data-archive-count]')).toBe('Archived tasks 26 to 50')
  })

  it('reads the new page again when Next and a restore both land before one commit', async () => {
    await open()
    await last().answer(many(1, 25), '3~p2')
    await click(button('Next'))
    const next = last()
    await click(find('[data-archive-row="archived-3"] [data-restore]'))
    const asked = calls.length
    // Next's answer lands first and the restore right after it, while the
    // page still shows Next running, and React commits both together
    await act(async () => {
      next.answerNow(many(26, 25, 30), '3~p3')
      for (let i = 0; i < 20; i++) await Promise.resolve()
      restores[0].answerNow()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    await settle()
    // the page Next brought is asked for again from where it starts
    expect(calls.length).toBe(asked + 1)
    expect(last().args).toEqual({ scope: project(META), cursor: '3~p2', limit: 25 })
  })

  it('asks for a narrower scope when the chosen one is too wide to list together', async () => {
    await open({ partner: true })
    await last().tooWide()
    expect(text('[data-archived-tasks]')).toContain(
      'This project has too many sub-projects to list their archived tasks together. Choose one of its sub-projects.',
    )
    expect(has('[data-archive-count]')).toBe(false)
    expect(has('[data-archive-fold]')).toBe(false)
    await choose(`all:${ORG}`)
    await last().tooWide()
    expect(text('[data-archived-tasks]')).toContain(
      'You see too many projects to list their archived tasks together. Choose a project.',
    )
    // the chooser still works, and a sub-project lists
    await choose(FW)
    expect(last().args).toEqual({ scope: project(FW), limit: 25 })
    await last().answer([task(1)])
    expect(rowIds()).toEqual(['archived-1'])
    expect(text('[data-archived-tasks]')).not.toContain('too many')
  })

  it('moves focus to the next row still listed when the page read again drops the focused one', async () => {
    await open()
    await last().answer([task(1), task(2), task(3), task(4)])
    const restore = find('[data-archive-row="archived-2"] [data-restore]')
    restore.focus()
    await click(restore)
    await restores[0].answer()
    expect(document.activeElement).toBe(find('[data-archive-row="archived-3"]'))
    // the server restored 3 with 2, as its parent, so the page read again leaves it out
    await last().answer([task(1), task(4), task(5)])
    expect(rowIds()).toEqual(['archived-1', 'archived-4', 'archived-5'])
    expect(document.activeElement).toBe(find('[data-archive-row="archived-4"]'))
  })

  it('keeps a chosen project that leaves the person’s sight, which the server answers', async () => {
    await open()
    await last().answer([task(1)])
    const asked = calls.length
    // Luma Sensor is archived, so the snapshot no longer holds it or its sub-projects
    snap.projects = snap.projects.filter((p) => p.id !== META && p.parent_id !== META)
    snap.delivered_at = new Date(Date.parse(snap.delivered_at) + 1000).toISOString()
    await act(async () => publish(structuredClone(snap)))
    await settle()
    // nothing tells the page; the choice stays, with the name it was chosen
    // by, and a search asks the server, which answers it as any project the
    // person cannot see
    expect(trigger()).toBe('Luma Sensor')
    expect(calls.length).toBe(asked)
    await type('drift')
    expect(last().args).toEqual({ scope: project(META), search: 'drift', limit: 25 })
    await last().answer([], null, 0)
    expect(text('[data-archived-tasks]')).toContain('No archived tasks match “drift”.')
  })

  it('reads several chosen projects in the order chosen, and starts again when one comes off', async () => {
    await open({ initial: 'none', shape: orbit })
    await add(FW)
    expect(last().args).toEqual({ scope: project(FW), limit: 25 })
    await last().answer([task(1)])
    await add(EL)
    expect(last().args).toEqual({ scope: { org_id: ORG, project_ids: [FW, EL] }, limit: 25 })
    expect(trigger()).toBe('Luma Sensor › Firmware and 1 more')
    expect(chips()).toEqual([FW, EL])
    await last().answer([task(2), task(1)], '3~p2')
    await click(button('Next'))
    await last().answer([task(3)])
    // a chip's remove button takes its project off, from the first page
    await click(find(`[data-archive-pick="${FW}"]`))
    expect(last().args).toEqual({ scope: project(EL), limit: 25 })
    await last().answer([], null, 0)
    expect(text('[data-archived-tasks]')).toContain('No archived tasks in “Electronics”.')
    expect(has('[data-archive-previous]')).toBe(false)
    // the whole project over its chosen sub-project, one id that stands for both
    await add(META)
    expect(last().args).toEqual({ scope: project(META), limit: 25 })
    expect(chips()).toEqual([META])
    await last().answer([], null, 0)
    // two projects with no archived task, and two too wide to list together
    await add(ORBIT)
    expect(last().args.scope.project_ids).toEqual([META, ORBIT])
    await last().answer([], null, 0)
    expect(text('[data-archived-tasks]')).toContain('No archived tasks in the projects you chose.')
    await type('x')
    await last().tooWide()
    expect(text('[data-archived-tasks]')).toContain(
      "Qivo can't list the archived tasks of these projects together. Choose fewer projects.",
    )
  })

  it('opens a row’s task over the page, then reads its page again and gives focus back', async () => {
    await open()
    await last().answer([task(1), task(2), task(3)])
    const openButton = find('[data-archive-open="archived-2"]')
    expect(openButton.getAttribute('aria-label')).toBe('Open QN-2')
    expect(openButton.textContent).toBe('QN-2Task 2')
    openButton.focus()
    await click(openButton)
    // an archived task is never in the workspace, so it opens by reference
    expect(opened).toHaveBeenCalledWith(taskRef({ org: ORG, num: 2, uuid: 'archived-2' }))
    const asked = calls.length
    await setTaskOpen(true)
    expect(calls.length).toBe(asked)
    // the window restored the task, took focus with it and closed
    openButton.blur()
    await setTaskOpen(false)
    expect(last().args).toEqual({ scope: project(META), limit: 25 })
    await last().answer([task(1), task(3)])
    expect(rowIds()).toEqual(['archived-1', 'archived-3'])
    expect(document.activeElement).toBe(find('[data-archive-row="archived-3"]'))
    // a window that closes while Next runs owes its read until Next lands
    await click(find('[data-archive-open="archived-1"]'))
    await setTaskOpen(true)
    await type('task')
    await last().answer([task(1)], '3~s2')
    await click(button('Search older tasks'))
    const next = last()
    await setTaskOpen(false)
    expect(calls.at(-1)).toBe(next)
    await next.answer([task(9)])
    expect(last().args).toEqual({ scope: project(META), search: 'task', cursor: '3~s2', limit: 25 })
  })

  it('opens on no choice and reads nothing where its project does not resolve', async () => {
    for (const answer of [
      async () => ({ state: 'unavailable' }),
      async () => ({
        state: 'unavailable',
        reason: 'access_unchecked',
        message: 'Qivo could not finish checking which projects you can see.',
      }),
      async () => {
        throw new Error('the read failed')
      },
    ]) {
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await open({
        shape: () => {
          resolveAnswer = async () => {
            await held
            return answer()
          }
        },
      })
      // nothing reads while the project resolves
      expect(trigger()).toBe('Loading…')
      expect(text('[data-archived-tasks]')).toContain('Loading archived tasks…')
      await act(async () => release())
      await settle()
      expect(calls).toEqual([])
      expect(trigger()).toBe('Choose projects…')
      expect(text('[data-archived-tasks]')).toContain(MISSED)
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('says an admin’s project it could not open on, and lets them choose in the picker', async () => {
    // the admin reaches Luma Sensor only as an admin, without a lead
    await open({ shape: (next) => Object.assign(next.projects[0], { lead_id: undefined }) })
    expect(calls).toEqual([])
    expect(trigger()).toBe('Choose projects…')
    expect(text('[data-archived-tasks]')).toContain(MISSED)
    expect(text('[data-archived-tasks]')).not.toContain('Choose a project to see')
    // the picker lists the projects they take part in, none here, and its
    // All projects still reads
    await openPicker()
    expect(has(`[data-project-pick="${META}"]`)).toBe(false)
    await click(find(`[data-project-pick-all="${ORG}"]`))
    await closePicker()
    expect(calls.map((c) => c.args)).toEqual([{ scope: { org_id: ORG, all: true }, limit: 25 }])
    expect(text('[data-archived-tasks]')).not.toContain(MISSED)
  })

  it('keeps a choice made while the project it opened on still resolves', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await open({
      shape: () => {
        resolveAnswer = async () => {
          await held
          return queryProjectNav(snap, 'projectNav:resolve', { project_id: META })
        }
      },
    })
    expect(trigger()).toBe('Loading…')
    expect(calls).toEqual([])
    // the person's choice shows and reads at once, without waiting for the
    // server
    await add(FW)
    expect(trigger()).toBe('Luma Sensor › Firmware')
    expect(calls.map((c) => c.args)).toEqual([{ scope: project(FW), limit: 25 }])
    await last().answer([task(1)])
    expect(rowIds()).toEqual(['archived-1'])
    expect(text('[data-archived-tasks]')).not.toContain('Loading archived tasks…')
    await act(async () => release())
    await settle()
    // the resolved project replaces nothing and reads nothing
    expect(trigger()).toBe('Luma Sensor › Firmware')
    expect(chips()).toEqual([FW])
    expect(calls).toHaveLength(1)
    expect(rowIds()).toEqual(['archived-1'])
  })

  it('reads none of the workspace’s projects', async () => {
    await open({ initial: 'none', partner: true })
    const spies = [vi.spyOn(store.P, 'visibleProjects'), vi.spyOn(store.P, 'canSee')]
    await add(FW)
    await last().answer([task(1)])
    await choose(`all:${PARTNER}`)
    await last().answer([task(2)])
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('refuses a 51st project of one organization', async () => {
    const ids: string[] = []
    await open({
      initial: 'none',
      shape: (next) => {
        for (let n = 0; n < 51; n++) {
          const id = crypto.randomUUID()
          ids.push(id)
          next.projects.push({
            ...next.projects[0],
            id,
            key: `R${n}`,
            num: 100 + n,
            name: `Research programme ${String(n).padStart(3, '0')}`,
          })
        }
      },
    })
    await openPicker()
    await click(find('[data-project-picker-more]'))
    await click(find('[data-project-picker-more]'))
    for (const id of ids.slice(0, 50)) await click(find(`[data-project-pick="${id}"]`))
    expect(find<HTMLButtonElement>(`[data-project-pick="${ids[50]}"]`).disabled).toBe(true)
    expect(text('[data-project-picker-note="most"]')).toBe('You can choose up to 50 projects.')
    await closePicker()
    expect(last().args.scope.project_ids).toEqual(ids.slice(0, 50))
    // six chips show, and the rest behind Show all
    expect(chips()).toHaveLength(6)
    await click(find('[data-archive-picks-more]'))
    expect(chips()).toHaveLength(50)
  })

  it('keeps the other move beside a failed one, and gives Retry of a failed read a place for focus', async () => {
    await open()
    await last().answer(many(1, 25), '3~p2')
    await click(button('Next'))
    await last().answer(many(26, 25, 30), '3~p3')
    await click(button('Next'))
    await last().fail()
    // Previous stays beside the failure, and works
    expect(text('[data-archived-tasks]')).toContain("Couldn't load the next page.")
    await click(button('Previous'))
    expect(last().args).toEqual({ scope: project(META), limit: 25 })
    await last().answer(many(1, 25), '3~p2')
    expect(text('[data-archive-count]')).toBe('Archived tasks 1 to 25')
    // a read of the page again after a restore fails, and its Retry hands
    // focus to Next, which stays
    await click(find('[data-archive-row="archived-1"] [data-restore]'))
    await restores[0].answer()
    await last().fail()
    expect(text('[data-archived-tasks]')).toContain("Couldn't load this page again.")
    expect(has('[data-archive-more]')).toBe(true)
    const retry = button('Retry')
    retry.focus()
    await click(retry)
    expect(last().args).toEqual({ scope: project(META), limit: 25 })
    expect(document.activeElement).toBe(find('[data-archive-more]'))
    await last().answer(many(2, 25), '3~p2')
    expect(rowIds()).toHaveLength(25)
  })

  it('searches on a phone too, without taking focus', async () => {
    await open({ phone: true })
    expect(has('[data-archive-search]')).toBe(true)
    expect(document.activeElement).not.toBe(find('[data-archive-search]'))
    await last().answer([task(1)])
    await type('drift')
    expect(last().args).toEqual({ scope: project(META), search: 'drift', limit: 25 })
  })

  it('asks for nothing before a scope is chosen', async () => {
    await open({ initial: 'none' })
    expect(calls).toEqual([])
    expect(text('[data-archived-tasks]')).toContain('Choose a project to see its archived tasks.')
    await choose(META)
    expect(calls.map((c) => c.args)).toEqual([{ scope: project(META), limit: 25 }])
  })
})
