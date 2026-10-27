// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Settings › Archived tasks on the real store, with the network mocked. The
   fixture's person is an organization admin who sees the top-level project
   Luma Sensor with its sub-projects Firmware and Electronics. Each
   issues.archivedPage call waits until the test answers it, so a test can
   answer calls out of order. The clock reads 15:00 local time on 16 Oct
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

type Args = { project_id: string; cursor?: string; search?: string; limit?: number }
type Row = Record<string, unknown> & { id: string }
type Call = {
  args: Args
  answer: (rows: Row[], next?: string | null, scanned?: number) => Promise<void>
  fail: () => Promise<void>
}

const NOW = new Date(2026, 9, 16, 15, 0)

let snap: Snapshot
let ORG: string
let META: string
let FW: string
let EL: string
let container: HTMLDivElement
let root: Root
let calls: Call[]
let publish: (snapshot: Snapshot) => void
let restores: ((value: unknown) => void)[]

/** Lets pending promises, effects and renders run. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** An archived task row as issues.archivedPage answers it, archived `days`
    before the fixed clock. */
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
    ...patch,
  }
}
/** `n` archived task rows numbered from `from`, archived `days` days back
    and a day earlier every ten rows. */
const many = (from: number, n: number, days = 2) =>
  Array.from({ length: n }, (_, i) => task(from + i, days + Math.floor(i / 10)))

/** The snapshot with Luma Sensor and its sub-projects Firmware and
    Electronics. */
function fixture(): Snapshot {
  const next = plannerFixture()
  const org = next.orgs[0].id
  const base = next.projects[0]
  const meta = {
    ...base,
    id: crypto.randomUUID(),
    type: 'meta' as const,
    key: 'LUMA',
    name: 'Luma Sensor',
    num: 2,
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
  return next
}

/** Renders the page on a fresh store, on a phone or not, opened on Luma
    Sensor or on no project. */
async function open({ phone = false, initial = 'meta' as 'meta' | 'none' } = {}) {
  vi.resetModules()
  snap = fixture()
  calls = []
  restores = []
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') {
      publish = next
      next(structuredClone(snap))
    }
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'issues:archivedPage') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      calls.push({
        args,
        answer: async (rows, next = null, scanned = rows.length) => {
          await act(async () => resolve({ rows, next_cursor: next, scanned }))
          await settle()
        },
        fail: async () => {
          await act(async () => reject(new Error('Too many index ranges read')))
          await settle()
        },
      })
    })
  })
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'issues:unarchive') return new Promise((resolve) => restores.push(resolve))
    return Promise.resolve(null)
  })
  const store = await import('../../store/planner')
  await store.initStore()
  const page = await import('./ArchivedTasks')
  const version = await import('../../store/usePlannerVersion')
  function Live() {
    version.usePlannerVersion()
    return <page.ArchivedTasksPage initialProject={initial === 'meta' ? META : null} />
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
/** Chooses `projectId` in the project select. */
async function choose(projectId: string) {
  const select = find<HTMLSelectElement>('[data-archive-project]')
  await act(async () => {
    select.value = projectId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
/** The newest issues.archivedPage call. */
const last = () => calls[calls.length - 1]

/* This file runs in the node project, whose default timeout is 5 s. Every
   test resets the modules and imports and boots the real planner store
   again. The first one also transforms the store and the page, and took up
   to 9 s on a busy host, so the tests get the 20 s the convex project gives
   its fixtures. */
describe('Archived tasks', { timeout: 20_000 }, () => {
  it('opens on its project with the search focused, newest first, a page at a time', async () => {
    await open()
    expect(calls.map((c) => c.args)).toEqual([{ project_id: META, limit: 100 }])
    expect(document.activeElement).toBe(find('[data-archive-search]'))
    // search comes first in the filters
    expect(
      find('.archived-filters').firstElementChild?.hasAttribute('data-archive-search-box'),
    ).toBe(true)
    expect(text('[data-archived-tasks]')).toContain('Loading archived tasks…')
    await last().answer(many(1, 100, 1), '1~5~k1~x')
    expect(rowIds()).toHaveLength(100)
    expect(text('[data-archive-count]')).toBe('Newest 100 archived tasks')
    expect(text('[data-archive-row="archived-1"]')).toContain('Luma Sensor › Firmware')
    // a month divider heads the list
    expect(text('[data-archive-month]')).toBe('October 2026')

    await click(button('Show 100 older tasks'))
    expect(last().args).toEqual({ project_id: META, cursor: '1~5~k1~x', limit: 100 })
    expect(text('[data-archive-fold]')).toBe('Loading older tasks…')
    await last().answer(many(101, 30, 40))
    expect(rowIds()).toHaveLength(130)
    expect(text('[data-archive-count]')).toBe('130 archived tasks')
    expect(has('[data-archive-fold]')).toBe(false)
    // focus moves to the first new row
    expect(document.activeElement).toBe(find('[data-archive-row="archived-101"]'))
    // dates before yesterday show only the day
    expect(text('[data-archive-row="archived-101"] [data-archive-time]')).toBe('6 Sep')
    expect(text('[data-archive-row="archived-1"] [data-archive-time]')).toBe('Yesterday 15:00')
  })

  it('searches every archived task on the server and offers to search older ones', async () => {
    await open()
    await last().answer(many(1, 100), '1~5~k1~x')
    await type('  drift ')
    expect(last().args).toEqual({ project_id: META, search: 'drift', limit: 100 })
    expect(text('[data-archived-tasks]')).toContain('Searching archived tasks…')
    await last().answer([task(7, 3), task(9, 50)], '1~6~k2~y', 1000)
    expect(rowIds()).toEqual(['archived-7', 'archived-9'])
    expect(text('[data-archive-count]')).toBe('2 found in the newest 1,000')
    expect(text('[data-archive-fold]')).toBe(
      'Searched the newest 1,000 archived tasks.Search older tasks',
    )
    await click(button('Search older tasks'))
    expect(last().args).toEqual({
      project_id: META,
      search: 'drift',
      cursor: '1~6~k2~y',
      limit: 100,
    })
    await last().answer([], '1~7~k3~z', 1000)
    expect(text('[data-archive-count]')).toBe('2 found in the newest 2,000')
    await click(button('Search older tasks'))
    await last().answer([task(400, 300)], null, 140)
    expect(rowIds()).toEqual(['archived-7', 'archived-9', 'archived-400'])
    expect(text('[data-archive-count]')).toBe('3 found')
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
    expect(last().args).toEqual({ project_id: META, search: 'q'.repeat(200), limit: 100 })
  })

  it('says how far a search looked when it found nothing yet, and when it found nothing', async () => {
    await open()
    await last().answer([])
    await type('barometer')
    await last().answer([], '1~6~k2~y', 1000)
    expect(text('[data-archive-fold]')).toBe(
      'No matches in the newest 1,000 archived tasks.Search older tasks',
    )
    expect(has('[data-archive-count]')).toBe(false)
    await click(button('Search older tasks'))
    await last().answer([], null, 12)
    expect(text('[data-archived-tasks]')).toContain('No archived tasks match “barometer”.')
  })

  it('keeps focus on the step button while a search step runs and after it finds nothing', async () => {
    await open()
    await last().answer([])
    await type('barometer')
    await last().answer([], '1~6~k2~y', 1000)
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
    await last().answer([], '1~7~k3~z', 1000)
    expect(document.activeElement).toBe(more)
    expect(text('[data-archive-fold]')).toBe(
      'No matches in the newest 2,000 archived tasks.Search older tasks',
    )
    // a step pressed without taking focus, as a tap may, hands focus to the
    // button when it finds nothing, and to the search once the archive ends
    more.blur()
    await click(more)
    await last().answer([], '1~8~k4~w', 1000)
    expect(document.activeElement).toBe(find('[data-archive-more]'))
    more.blur()
    await click(more)
    await last().answer([], null, 12)
    expect(document.activeElement).toBe(find('[data-archive-search]'))
  })

  it('drops an answer for a project or search the page has left', async () => {
    await open()
    const first = last()
    await choose(FW)
    const second = last()
    expect(second.args).toEqual({ project_id: FW, limit: 100 })
    await second.answer([task(2)])
    await first.answer([task(1)])
    expect(rowIds()).toEqual(['archived-2'])
    // the search follows the project
    await type('fan')
    const fan = last()
    await choose(EL)
    expect(last().args).toEqual({ project_id: EL, search: 'fan', limit: 100 })
    await fan.answer([task(3)])
    expect(rowIds()).toEqual([])
  })

  it('keeps the rows when a later page fails, and tries it again', async () => {
    await open()
    await last().answer(many(1, 100), '1~5~k1~x')
    const more = button('Show 100 older tasks')
    more.focus()
    await click(more)
    await last().fail()
    expect(rowIds()).toHaveLength(100)
    expect(text('[data-archived-tasks]')).toContain("Couldn't load older tasks.")
    // the button left with the failed step, so focus moves to Retry
    expect(document.activeElement).toBe(button('Retry'))
    await click(button('Retry'))
    expect(last().args.cursor).toBe('1~5~k1~x')
    // and Retry leaves too, so focus moves to the step's button
    expect(document.activeElement).toBe(find('[data-archive-more]'))
    await last().answer([task(200, 40)])
    expect(rowIds()).toHaveLength(101)
    expect(document.activeElement).toBe(find('[data-archive-row="archived-200"]'))
  })

  it('shows a failed first page with Retry', async () => {
    await open()
    await last().fail()
    expect(text('[data-archived-tasks]')).toContain("Couldn't load the archive.")
    await click(button('Retry'))
    await last().answer([task(1)])
    expect(rowIds()).toEqual(['archived-1'])
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
  async function restored(...nums: number[]) {
    snap.issues.push(...nums.map(active))
    snap.delivered_at = new Date(Date.parse(snap.delivered_at) + 1000).toISOString()
    await act(async () => publish(structuredClone(snap)))
    await settle()
  }

  it('removes a restored row and its restored parent without reading the list again', async () => {
    await open()
    await last().answer([task(1), task(2), task(3), task(4)])
    const before = calls.length
    // from the keyboard, as focus follows only a restore made from its row
    const restore = find('[data-archive-row="archived-2"] [data-restore]')
    restore.focus()
    await click(restore)
    expect(text('[data-archive-row="archived-2"] [data-restore]')).toBe('Restoring…')
    // as Convex orders them, the snapshot with the task and the parent the
    // server restored with it arrives before the restore's answer
    await restored(2, 3)
    expect(rowIds()).toEqual(['archived-1', 'archived-4'])
    await act(async () => restores[0]({ issue: active(2), left_parent: false }))
    await settle()
    expect(rowIds()).toEqual(['archived-1', 'archived-4'])
    expect(window.showToast).toHaveBeenCalledWith('Restored QN-2')
    // focus moves on to the next row still listed
    expect(document.activeElement).toBe(find('[data-archive-row="archived-4"]'))
    expect(text('[data-archive-count]')).toBe('2 archived tasks')
    expect(calls.length).toBe(before)
    // a task someone else restores leaves too
    await restored(4)
    expect(rowIds()).toEqual(['archived-1'])
  })

  it('still says how far a search looked once every match it found is restored', async () => {
    await open()
    await last().answer([])
    await type('drift')
    await last().answer([task(7, 3)], '1~6~k2~y', 1000)
    await click(find('[data-archive-row="archived-7"] [data-restore]'))
    await restored(7)
    await act(async () => restores[0]({ issue: active(7), left_parent: false }))
    await settle()
    expect(rowIds()).toEqual([])
    expect(has('[data-archive-count]')).toBe(false)
    expect(text('[data-archive-fold]')).toBe(
      'Searched the newest 1,000 archived tasks.Search older tasks',
    )
  })

  it('searches on a phone too, without taking focus', async () => {
    await open({ phone: true })
    expect(has('[data-archive-search]')).toBe(true)
    expect(document.activeElement).not.toBe(find('[data-archive-search]'))
    await last().answer([task(1)])
    await type('drift')
    expect(last().args).toEqual({ project_id: META, search: 'drift', limit: 100 })
  })

  it('asks for nothing before a project is chosen', async () => {
    await open({ initial: 'none' })
    expect(calls).toEqual([])
    expect(text('[data-archived-tasks]')).toContain('Choose a project to see its archived tasks.')
    await choose(META)
    expect(calls.map((c) => c.args)).toEqual([{ project_id: META, limit: 100 }])
  })
})
