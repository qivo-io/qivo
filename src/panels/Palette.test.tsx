// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* Main Search's palette on the real store, with the network mocked. The
   person is an organization admin of Testbed Labs, who sees Luma Sensor
   with its sub-projects Firmware and Electronics, and, with `partner`,
   holds a guest seat in Partner Co with its project Partner portal. Each
   search:page call waits until the test answers it, so a test can answer
   calls out of order. Typing runs on fake timers, so the palette's 250 ms
   pause takes no real time. */

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

type Args = {
  text: string
  include_archived: boolean
  scope?: { org_id: string; project_id?: string }
  cursor?: string
}
type Coverage =
  | { complete: true }
  | { complete: false; stopped: string; searched: number; of: number }
type Row = Record<string, unknown> & { kind: 'task' | 'project'; id: string }
type Call = {
  args: Args
  answer: (rows: Row[], next?: string | null, coverage?: Coverage) => Promise<void>
  fail: () => Promise<void>
  refuse: (code: 'bad_request' | 'rule', message: string) => Promise<void>
}

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let publish: (snapshot: Snapshot) => void
let calls: Call[]
let ctx: {
  setScope: ReturnType<typeof vi.fn<(scopeId: string) => void>>
  openIssue: ReturnType<typeof vi.fn<(issueId: string) => void>>
}
let onClose: ReturnType<typeof vi.fn<() => void>>
let ORG: string
let META: string
let FW: string
let PARTNER: string
let PORTAL: string
let palette: typeof import('./Palette')
let opened: typeof import('../lib/openedTasks')
let pageStarts: typeof import('../lib/pageStarts')

/* Lets answers and renders land. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await vi.advanceTimersByTimeAsync(0))
}

/** A task row as search:page answers it, in Firmware under Luma Sensor of
    Testbed Labs unless `patch` says otherwise. */
const task = (num: number, patch: Record<string, unknown> = {}): Row => ({
  kind: 'task',
  org_id: ORG,
  id: `task-${num}`,
  num,
  title: `Flash the firmware ${num}`,
  status: 'todo',
  is_group: false,
  archived: false,
  project: { id: FW, name: 'Firmware' },
  parent: { id: META, name: 'Luma Sensor' },
  ...patch,
})
/** A project row as search:page answers it. */
const project = (id: string, name: string, parent: { id: string; name: string } | null): Row => ({
  kind: 'project',
  org_id: ORG,
  id,
  name,
  parent,
})

/** The snapshot with Luma Sensor and its sub-projects Firmware and
    Electronics, and with `partner` a guest seat in Partner Co. */
function fixture(partner: boolean): Snapshot {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  const base = next.projects[0]
  const meta = { ...base, id: crypto.randomUUID(), type: 'meta' as const, key: 'LUMA' }
  const sub = (key: string, name: string, num: number) => ({
    ...base,
    id: crypto.randomUUID(),
    type: 'project' as const,
    parent_id: meta.id,
    key,
    name,
    num,
    sort_order: num,
  })
  next.projects = [
    { ...meta, name: 'Luma Sensor', num: 2 },
    sub('FW', 'Firmware', 3),
    sub('EL', 'Electronics', 4),
  ]
  META = meta.id
  FW = next.projects[1].id
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
    })
    next.access.push({ project_id: PORTAL, profile_id: seat, level: 'user' })
  }
  return next
}

/** Opens the palette on a fresh store, with or without the Partner Co seat. */
async function open({ partner = false } = {}) {
  vi.resetModules()
  snap = fixture(partner)
  calls = []
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') {
      publish = next
      next(structuredClone(snap))
    }
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'search:page') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      calls.push({
        args,
        answer: async (rows, next = null, coverage = { complete: true }) => {
          await act(async () => resolve({ rows, next_cursor: next, coverage }))
          await settle()
        },
        fail: async () => {
          await act(async () => reject(new Error('Too many index ranges read')))
          await settle()
        },
        refuse: async (code, message) => {
          await act(async () => reject(new ConvexError({ code, message })))
          await settle()
        },
      })
    })
  })
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  await store.initStore()
  palette = await import('./Palette')
  opened = await import('../lib/openedTasks')
  pageStarts = await import('../lib/pageStarts')
  const version = await import('../store/usePlannerVersion')
  ctx = {
    setScope: vi.fn<(scopeId: string) => void>(),
    openIssue: vi.fn<(issueId: string) => void>(),
  }
  onClose = vi.fn<() => void>()
  function Live() {
    version.usePlannerVersion()
    return <palette.SearchPalette ctx={ctx} onClose={onClose} />
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  vi.spyOn(console, 'error').mockImplementation(() => {})
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
const input = () => find<HTMLInputElement>('input[aria-label="Search tasks and projects"]')
const status = () => find('[data-palette-status]').textContent ?? ''
const values = () =>
  [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].map((el) => el.dataset.value)
const selected = () => document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')
const last = () => {
  const call = calls.at(-1)
  if (!call) throw new Error('nothing was asked')
  return call
}
const pageButton = (to: 'previous' | 'next') =>
  document.querySelector<HTMLButtonElement>(`[data-palette-page="${to}"]`)

/** Types `value` into the search without waiting. */
async function key(value: string) {
  const field = input()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** Waits `ms` on fake time. */
async function wait(ms: number) {
  await act(async () => await vi.advanceTimersByTimeAsync(ms))
  await settle()
}
/** Types `value` and rests past the palette's pause. */
async function type(value: string) {
  await key(value)
  await wait(300)
}
/** Presses `name` on `element` and answers the event, to read whether
    anything took it from the browser. */
async function press(element: Element, name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  await act(async () => element.dispatchEvent(event))
  await settle()
  return event
}
async function click(element: HTMLElement | null) {
  if (!element) throw new Error('nothing to click')
  await act(async () => element.click())
  await settle()
}
/** Chooses `value` under Search in. */
async function choose(value: string) {
  const select = find<HTMLSelectElement>('[data-palette-scope]')
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
const toggle = () => click(find('[data-palette-archived]'))

describe('the Search palette', { timeout: 20_000 }, () => {
  it('reads nothing for no text, blanks, punctuation or a text past 200 characters', async () => {
    await open()
    for (const text of ['', '   ', '?! —', '…'.repeat(5)]) await type(text)
    expect(calls).toHaveLength(0)
    expect(status()).toBe('')
    // a scope or toggle change with no term asks nothing either
    await toggle()
    await choose(META)
    expect(calls).toHaveLength(0)
    await type(`${'firmware '.repeat(25)}`)
    expect(calls).toHaveLength(0)
    expect(status()).toBe('A search must be at most 200 characters. Search for fewer words.')
  })

  it('asks once typing rests, not once a key, and not again for the same terms', async () => {
    await open()
    for (const text of ['f', 'fi', 'fir', 'firm']) {
      await key(text)
      await wait(100)
    }
    expect(calls).toHaveLength(0)
    expect(status()).toBe('Searching…')
    await wait(250)
    expect(calls.map((c) => c.args)).toEqual([{ text: 'firm', include_archived: false }])
    await last().answer([task(14)])
    // the same terms, spaced or capitalized otherwise, are the same search
    await type('firm ')
    await type('FIRM')
    expect(calls).toHaveLength(1)
    expect(values()).toEqual(['issue-QN-14'])
  })

  it('asks at once, from the first page, when the scope or the toggle changes', async () => {
    await open()
    await type('firm')
    await last().answer([task(14)], 's1~a')
    await click(pageButton('next'))
    expect(last().args.cursor).toBe('s1~a')
    await last().answer([task(13)])
    await toggle()
    expect(last().args).toEqual({ text: 'firm', include_archived: true })
    await last().answer([task(14), task(12, { archived: true })])
    await choose(FW)
    expect(last().args).toEqual({
      text: 'firm',
      include_archived: true,
      scope: { org_id: ORG, project_id: FW },
    })
    await last().answer([task(14)])
    await choose(META)
    expect(last().args.scope).toEqual({ org_id: ORG, project_id: META })
    await last().answer([])
    await choose('')
    expect(last().args).toEqual({ text: 'firm', include_archived: true })
    expect(calls).toHaveLength(6)
  })

  it('shows only the newest answer, also when an older one lands later', async () => {
    await open()
    await type('fir')
    await type('firmware')
    const [older, newer] = calls
    await newer.answer([task(14)])
    await older.answer([task(99)])
    expect(values()).toEqual(['issue-QN-14'])
    // an answer for the toggle off that lands after the one for it on
    await type('rollback')
    await toggle()
    const [off, on] = calls.slice(2)
    expect(off.args.include_archived).toBe(false)
    expect(on.args.include_archived).toBe(true)
    await on.answer([task(7, { archived: true })])
    await off.answer([task(8)])
    expect(values()).toEqual(['issue-QN-7'])
  })

  it('drops the answer on its way when the text returns to the search on screen', async () => {
    await open()
    await type('firmware')
    await last().answer([task(14)])
    await type('firmware x')
    const away = last()
    expect(away.args.text).toBe('firmware x')
    await type('firmware')
    // nothing new to ask, and the answer for "firmware x" lands too late
    expect(calls).toHaveLength(2)
    await away.answer([task(77)])
    expect(values()).toEqual(['issue-QN-14'])
    expect(status()).toBe('')
    expect(find('[cmdk-list]').getAttribute('aria-busy')).toBeNull()
  })

  it('pages with Previous and Next, dropping the oldest start past the bound', async () => {
    await open()
    pageStarts.PAGE_STARTS.most = 3
    try {
      await type('firm')
      await last().answer([task(30)], 'c1')
      expect(pageButton('previous')).toBeNull()
      await click(pageButton('next'))
      expect(pageButton('next')?.textContent).toBe('Loading…')
      await last().answer([task(29)], 'c2')
      // focus goes back to the search, so the arrows and Enter act on the rows
      expect(document.activeElement).toBe(input())
      expect(selected()?.dataset.value).toBe('issue-QN-29')
      await click(pageButton('next'))
      await last().answer([task(28)], 'c3')
      await click(pageButton('next'))
      expect(last().args.cursor).toBe('c3')
      await last().answer([task(27)])
      expect(pageButton('next')).toBeNull()
      await click(pageButton('previous'))
      expect(last().args.cursor).toBe('c2')
      await last().answer([task(28)], 'c3')
      await click(pageButton('previous'))
      expect(last().args.cursor).toBe('c1')
      await last().answer([task(29)], 'c2')
      // the first page's start was dropped, so Previous stops here
      expect(pageButton('previous')).toBeNull()
      // a new text starts again at the first page
      await type('firmware')
      expect(last().args.cursor).toBeUndefined()
      await last().answer([task(30)], 'd1')
      expect(pageButton('previous')).toBeNull()
    } finally {
      pageStarts.PAGE_STARTS.most = 1000
    }
  })

  it('labels each row and shows its key, status, place, Archived and organization', async () => {
    await open({ partner: true })
    await type('firm')
    await last().answer([
      task(14),
      task(15, { status: null, is_group: true, title: 'Ship the firmware group' }),
      task(16, { archived: true, title: 'Old firmware notes' }),
      task(5, {
        org_id: PARTNER,
        id: 'partner-task',
        project: { id: PORTAL, name: 'Partner portal' },
        parent: null,
      }),
      project(FW, 'Firmware', { id: META, name: 'Luma Sensor' }),
      project(META, 'Luma Sensor', null),
    ])
    expect(values()).toEqual([
      'issue-QN-14',
      'issue-QN-15',
      'issue-QN-16',
      // a guest seat's task opens by its uuid, as two organizations can each have a QN-5
      'issue-partner-task',
      `project-${FW}`,
      `project-${META}`,
    ])
    const rows = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
    expect(rows.map((row) => row.querySelector('[data-result-kind]')?.textContent)).toEqual([
      'Task',
      'Task',
      'Task',
      'Task',
      'Project',
      'Project',
    ])
    expect(rows[0].textContent).toContain('QN-14')
    expect(rows[0].textContent).toContain('Flash the firmware 14')
    expect(rows[0].textContent).toContain('Luma Sensor, Firmware')
    expect(rows[0].querySelector('[aria-label="To Do"]')).not.toBeNull()
    // a group has no status of its own
    expect(rows[1].querySelector('[role="img"]')).toBeNull()
    expect(rows[2].querySelector('[data-result-archived]')?.textContent).toBe('Archived')
    expect(rows[0].querySelector('[data-result-archived]')).toBeNull()
    expect(rows[3].querySelector('[data-result-org]')?.textContent).toBe('Partner Co')
    expect(rows[0].querySelector('[data-result-org]')).toBeNull()
    expect(rows[4].textContent).toContain('Luma Sensor')
    // the first row is selected, so Enter opens the best match
    expect(selected()?.dataset.value).toBe('issue-QN-14')
  })

  it('offers All projects, each organization, and each project with its sub-projects', async () => {
    await open({ partner: true })
    const options = [...find<HTMLSelectElement>('[data-palette-scope]').options].map((o) => [
      o.value,
      o.textContent?.trim(),
    ])
    expect(options).toEqual([
      ['', 'All projects'],
      [`org:${ORG}`, 'All projects in Testbed Labs'],
      [`org:${PARTNER}`, 'All projects in Partner Co'],
      [META, 'Luma Sensor, whole project'],
      [FW, 'Firmware'],
      [expect.any(String), 'Electronics'],
      [PORTAL, 'Partner portal, whole project'],
    ])
    expect(find<HTMLSelectElement>('[data-palette-scope]').value).toBe('')
    await type('portal')
    await choose(`org:${PARTNER}`)
    expect(last().args.scope).toEqual({ org_id: PARTNER })
    await last().answer([])
    // a chosen project that leaves the list returns the search to All projects
    await choose(FW)
    await last().answer([])
    await act(async () =>
      publish({
        ...structuredClone(snap),
        projects: snap.projects.filter((p) => p.id !== FW),
        delivered_at: '2026-09-15T09:00:00.000Z',
      }),
    )
    await settle()
    expect(find<HTMLSelectElement>('[data-palette-scope]').value).toBe('')
    expect(last().args).toEqual({ text: 'portal', include_archived: false })
  })

  it('says what a page could not cover, never no results, and offers a project', async () => {
    await open()
    await type('firm')
    await last().answer([], null)
    expect(status()).toBe('No results for “firm”')
    for (const stopped of ['projects', 'reads', 'candidates']) {
      await type(`firm ${stopped}`)
      await last().answer([], null, { complete: false, stopped, searched: 1, of: 1 })
      expect(status(), stopped).toBe(
        'Some results might be missing. Choose a project to search in.',
      )
      expect(status()).not.toMatch(/no results/i)
    }
    await click(find('[data-palette-choose]'))
    expect(document.activeElement).toBe(find('[data-palette-scope]'))
    await type('firm organizations')
    await last().answer([task(3)], null, {
      complete: false,
      stopped: 'organizations',
      searched: 1,
      of: 2,
    })
    expect(status()).toBe(
      'Some organizations were not searched. Choose an organization to search in.',
    )
    // a page with nothing left to show while more follow
    await type('firm empty')
    await last().answer([], 's1~more')
    expect(status()).toBe('Nothing on this page can still be shown. Next goes on with the search.')
    expect(pageButton('next')).not.toBeNull()
  })

  it('offers Retry for a failed read, and restarts once at the first page on a refused cursor', async () => {
    await open()
    await type('firm')
    await last().fail()
    expect(status()).toBe("Couldn't search. Try again.")
    expect(values()).toEqual([])
    await click(find('[data-palette-retry]'))
    expect(calls.map((c) => c.args)).toEqual([
      { text: 'firm', include_archived: false },
      { text: 'firm', include_archived: false },
    ])
    await last().answer([task(14)], 'c1')
    // a failed move keeps the page
    await click(pageButton('next'))
    await last().fail()
    expect(values()).toEqual(['issue-QN-14'])
    expect(status()).toBe("Couldn't search. Try again.")
    await click(find('[data-palette-retry]'))
    expect(last().args.cursor).toBe('c1')
    // a cursor the server no longer takes restarts at the first page, once
    await last().refuse('bad_request', 'cursor must be the next_cursor of an earlier page')
    expect(last().args).toEqual({ text: 'firm', include_archived: false })
    await last().refuse('bad_request', 'cursor must be the next_cursor of an earlier page')
    expect(calls).toHaveLength(5)
    expect(status()).toBe("Couldn't search. Try again.")
    // a refused text shows the server's sentence
    await type('firmware')
    await last().refuse('rule', 'a search must be at most 200 characters')
    expect(status()).toBe('A search must be at most 200 characters.')
    expect(calls).toHaveLength(6)
  })

  it('moves with the arrows and opens with Enter, but not from a control or with older rows', async () => {
    await open()
    await type('firm')
    await last().answer([task(14), task(13), task(12)], 'c1')
    await press(input(), 'ArrowDown')
    expect(selected()?.dataset.value).toBe('issue-QN-13')
    await press(input(), 'ArrowUp')
    expect(selected()?.dataset.value).toBe('issue-QN-14')
    // Home and End move the caret, not the selection
    await press(input(), 'End')
    await press(input(), 'Home')
    expect(selected()?.dataset.value).toBe('issue-QN-14')
    // Enter and Space on a control do its own action or nothing
    for (const control of [
      find('[data-palette-scope]'),
      find('[data-palette-archived]'),
      pageButton('next') as HTMLElement,
    ])
      for (const name of ['Enter', ' ', 'ArrowDown', 'End']) {
        const event = await press(control, name)
        if (control.dataset.paletteArchived === undefined || name !== 'Enter')
          expect(event.defaultPrevented, `${name} on ${control.tagName}`).toBe(false)
        expect(selected()?.dataset.value).toBe('issue-QN-14')
      }
    expect(ctx.openIssue).not.toHaveBeenCalled()
    // while the rows answer an older text, Enter waits
    await key('firmware')
    expect(status()).toBe('Updating results…')
    expect(find('[cmdk-list]').getAttribute('aria-busy')).toBe('true')
    await press(input(), 'Enter')
    expect(ctx.openIssue).not.toHaveBeenCalled()
    await wait(300)
    await last().answer([task(20), task(21)])
    await press(input(), 'ArrowDown')
    await press(input(), 'Enter')
    expect(ctx.openIssue).toHaveBeenCalledWith('QN-21')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a task by its handle, noting it, and a project the workspace holds as the scope', async () => {
    await open({ partner: true })
    await type('firm')
    const partnerTask = task(5, {
      org_id: PARTNER,
      id: 'partner-task',
      project: { id: PORTAL, name: 'Partner portal' },
      parent: null,
    })
    await last().answer([
      task(14),
      task(16, { archived: true, title: 'Old firmware notes' }),
      partnerTask,
      project(FW, 'Firmware', { id: META, name: 'Luma Sensor' }),
      project('not-loaded', 'Firmware tools', null),
    ])
    const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
    await click(rows()[1])
    expect(ctx.openIssue).toHaveBeenLastCalledWith('QN-16')
    expect(opened.openedTask('QN-16')).toEqual({
      uuid: 'task-16',
      key: 'QN-16',
      title: 'Old firmware notes',
      project: FW,
      org: ORG,
      archived: true,
    })
    await click(rows()[2])
    expect(ctx.openIssue).toHaveBeenLastCalledWith('partner-task')
    expect(opened.openedTask('partner-task')).toMatchObject({ key: 'QN-5', org: PARTNER })
    await click(rows()[0])
    expect(ctx.openIssue).toHaveBeenLastCalledWith('QN-14')
    expect(opened.openedTask('QN-14')).toMatchObject({ archived: false })
    await click(rows()[3])
    expect(ctx.setScope).toHaveBeenCalledWith(FW)
    // a project the workspace does not hold yet stays unopened
    const closes = onClose.mock.calls.length
    await click(rows()[4])
    expect(ctx.setScope).toHaveBeenCalledTimes(1)
    expect(onClose.mock.calls.length).toBe(closes)
    expect(status()).toBe('Firmware tools has not loaded yet. Try again in a moment.')
  })
})
