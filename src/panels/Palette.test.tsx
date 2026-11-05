// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { taskRef } from '../lib/taskReference'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from '../store/projectNavStandIn.setup'

/* Main Search's palette on the real store, with the network mocked. The
   person is an organization admin of Testbed Labs who leads Luma Sensor,
   with its sub-projects Firmware and Electronics, and, with `partner`,
   holds a guest seat in Partner Co with its project Partner portal. Each
   search:page call waits until the test answers it, so a test can answer
   calls out of order. Search in's picker reads the navigation reads from
   their stand-in (store/projectNavStandIn.setup.ts) over the workspace,
   and projectNav.resolve, which the project Search opens on goes through,
   answers when `resolving` lets it. Typing runs on fake timers, so the
   palette's 250 ms pause takes no real time. */

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
let pageStarts: typeof import('../lib/pageStarts')
let store: typeof import('../store/planner')
// what projectNav.resolve answers: the stand-in's answer, or one the test
// gives, and whether it waits until the test lets it go
let resolving: { answer?: () => Promise<unknown>; hold?: Promise<void> }

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
  // the person leads Luma Sensor, so the navigation reads, which judge an
  // admin by ordinary access, list it
  const meta = {
    ...base,
    id: crypto.randomUUID(),
    type: 'meta' as const,
    key: 'LUMA',
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
      lead_id: undefined,
    })
    next.access.push({ project_id: PORTAL, profile_id: seat, level: 'user' })
  }
  return next
}

/** Opens the palette on a fresh store, with or without the Partner Co seat,
    on the scope `searchIn` names once the fixture exists (All projects by
    default). */
async function open({
  partner = false,
  searchIn = () => null,
}: {
  partner?: boolean
  searchIn?: () => string | null
} = {}) {
  vi.resetModules()
  snap = fixture(partner)
  calls = []
  resolving = {}
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail)
    if (name === 'workspace:whole') {
      publish = next
      next(structuredClone(snap))
    }
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'projectNav:resolve') {
      await resolving.hold
      return resolving.answer ? resolving.answer() : queryProjectNav(snap, name, args)
    }
    if (name !== 'search:page') return null
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
  store = await import('../store/planner')
  await store.initStore()
  palette = await import('./Palette')
  pageStarts = await import('../lib/pageStarts')
  const version = await import('../store/usePlannerVersion')
  ctx = {
    setScope: vi.fn<(scopeId: string) => void>(),
    openIssue: vi.fn<(issueId: string) => void>(),
  }
  onClose = vi.fn<() => void>()
  function Live() {
    version.usePlannerVersion()
    return <palette.SearchPalette ctx={ctx} searchIn={searchIn()} onClose={onClose} />
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
/** The reference a result of task number `num` of organization `org`
    opens by when the workspace does not hold it (lib/taskReference.ts). */
const refTo = (org: string, num: number, uuid = `task-${num}`) => taskRef({ org, num, uuid })
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
/** Picks `value` under Search in: '' for All projects, `org:<id>` for an
    organization's All projects, or a project, showing Luma Sensor's
    sub-projects first for one of them. */
async function choose(value: string) {
  await click(find('[data-palette-scope]'))
  if (value === '') return click(find('[data-project-pick-all=""]'))
  if (value.startsWith('org:')) return click(find(`[data-project-pick-all="${value.slice(4)}"]`))
  if (!document.querySelector(`[data-project-pick="${value}"]`))
    await click(find(`[data-project-expand="${META}"]`))
  await click(find(`[data-project-pick="${value}"]`))
}
/** What Search in's trigger says. */
const scopeLabel = () => find('[data-palette-scope]').textContent
const toggle = () => click(find('[data-palette-archived]'))

describe('the Search palette', { timeout: 20_000 }, () => {
  it('reads nothing for no text, blanks, punctuation or a text past 200 characters', async () => {
    await open()
    for (const [text, says] of [
      ['', ''],
      ['   ', ''],
      ['?! —', 'Type a word or a task ID to search.'],
      ['…'.repeat(5), 'Type a word or a task ID to search.'],
      // Convex leaves out words of 32 bytes or more, so these are no search
      [
        `${'a'.repeat(32)} ${'ö'.repeat(16)}`,
        'Words longer than about 30 letters are not searched.',
      ],
      ['  ', ''],
    ]) {
      await type(text)
      expect(status(), JSON.stringify(text)).toBe(says)
    }
    expect(calls).toHaveLength(0)
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

  it('starts Search in on the sub-project it opened for, once the server resolves it', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // resolve waits, so the fixture exists before it answers
    await open({
      searchIn: () => {
        resolving.hold ??= held
        return FW
      },
    })
    expect(scopeLabel()).toBe('Loading…')
    await type('firm')
    // nothing searches a scope wider or narrower than asked meanwhile
    expect(calls).toHaveLength(0)
    expect(find('[cmdk-list]').getAttribute('aria-busy')).toBe('true')
    await act(async () => release())
    await settle()
    expect(scopeLabel()).toBe('Luma Sensor › Firmware')
    expect(calls.map((c) => c.args)).toEqual([
      { text: 'firm', include_archived: false, scope: { org_id: ORG, project_id: FW } },
    ])
    await last().answer([task(14)])
    await choose('')
    expect(last().args).toEqual({ text: 'firm', include_archived: false })
  })

  it('starts on All projects where the project it opened for does not resolve', async () => {
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
      await open({
        searchIn: () => {
          resolving.answer ??= answer
          return FW
        },
      })
      expect(scopeLabel()).toBe('All projects')
      await type('firm')
      expect(last().args).toEqual({ text: 'firm', include_archived: false })
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('asks at once for a pick from the keyboard, with no rest', async () => {
    await open()
    await type('firm')
    await last().answer([task(14)])
    await click(find('[data-palette-scope]'))
    const field = find('[data-project-picker-search]')
    expect(document.activeElement).toBe(field)
    // All projects, then Luma Sensor
    await press(field, 'ArrowDown')
    await press(field, 'ArrowDown')
    await press(field, 'Enter')
    expect(calls).toHaveLength(2)
    expect(last().args.scope).toEqual({ org_id: ORG, project_id: META })
    expect(document.querySelector('[data-project-picker]')).toBeNull()
    expect(document.activeElement).toBe(find('[data-palette-scope]'))
  })

  it('narrows a picked project to one of its sub-projects with one press', async () => {
    await open()
    await type('firm')
    await last().answer([task(14)])
    await choose(META)
    expect(last().args.scope).toEqual({ org_id: ORG, project_id: META })
    await last().answer([task(14)])
    await click(find('[data-palette-scope]'))
    await click(find(`[data-project-expand="${META}"]`))
    // the picked project's sub-projects show as rows to pick, not included
    const firmware = find<HTMLButtonElement>(`[data-project-pick="${FW}"]`)
    expect(firmware.disabled).toBe(false)
    expect(firmware.getAttribute('aria-pressed')).toBe('false')
    expect(firmware.textContent).not.toContain('Included in')
    expect(find(`[data-project-pick="${META}"]`).getAttribute('aria-pressed')).toBe('true')
    await click(firmware)
    expect(last().args.scope).toEqual({ org_id: ORG, project_id: FW })
    expect(scopeLabel()).toBe('Luma Sensor › Firmware')
  })

  it('closes only the picker on Escape, and reads none of the workspace’s projects', async () => {
    await open()
    const spies = [
      vi.spyOn(store.P, 'visibleProjects'),
      vi.spyOn(store.P, 'canSee'),
      vi.spyOn(store.P, 'projectLabel'),
    ]
    await click(find('[data-palette-scope]'))
    const field = find<HTMLInputElement>('[data-project-picker-search]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'lum')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(300)
    await press(field, 'Escape')
    expect(field.value).toBe('')
    await press(field, 'Escape')
    expect(document.querySelector('[data-project-picker]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[cmdk-input]')).not.toBeNull()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
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

  it('marks the list busy only while a request runs or typing rests before one', async () => {
    await open()
    const busy = () => find('[cmdk-list]').getAttribute('aria-busy')
    await key('firm')
    expect(busy()).toBe('true')
    await wait(300)
    expect(busy()).toBe('true')
    await last().answer([task(14)])
    expect(busy()).toBeNull()
    // the same terms ask nothing, so nothing is on its way
    await key('firm ')
    expect(busy()).toBeNull()
    await wait(300)
    // a failed first page, a refused text and a text past the limit wait for nothing
    await type('firmware')
    expect(busy()).toBe('true')
    await last().fail()
    expect(busy()).toBeNull()
    expect(status()).toBe("Couldn't search. Try again.")
    await key('rollback')
    expect(busy()).toBe('true')
    await wait(300)
    await last().refuse('rule', 'a search must be at most 200 characters')
    expect(busy()).toBeNull()
    await type('firmware '.repeat(25))
    expect(busy()).toBeNull()
    // typing back to the failed text asks it again
    await key('firmware')
    expect(busy()).toBe('true')
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

  it('starts the list at its top for each page and search that lands', async () => {
    await open()
    await type('firm')
    await last().answer(
      Array.from({ length: 25 }, (_, i) => task(100 - i)),
      'c1',
    )
    // jsdom keeps no scroll position, so the list gets one of its own
    const list = find('[cmdk-list]')
    let top = 0
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
      },
    })
    const scrolled = () => {
      list.scrollTop = 480
      expect(list.scrollTop).toBe(480)
    }
    scrolled()
    await click(pageButton('next'))
    // the page on screen keeps its place until the next one lands
    expect(list.scrollTop).toBe(480)
    await last().answer([task(75), task(74)], 'c2')
    expect(list.scrollTop).toBe(0)
    expect(selected()?.dataset.value).toBe('issue-QN-75')
    scrolled()
    await toggle()
    await last().answer([task(60), task(59)])
    expect(list.scrollTop).toBe(0)
    scrolled()
    await type('firmware')
    await last().answer([task(14)])
    expect(list.scrollTop).toBe(0)
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
    expect(scopeLabel()).toBe('All projects')
    await click(find('[data-palette-scope]'))
    const fixed = [...document.querySelectorAll<HTMLElement>('[data-project-pick-all]')].map(
      (el) => [el.dataset.projectPickAll, el.textContent],
    )
    expect(fixed).toEqual([
      ['', 'All projects'],
      [ORG, 'All projects in Testbed Labs'],
      [PARTNER, 'All projects in Partner Co'],
    ])
    await click(find(`[data-project-expand="${META}"]`))
    const rows = [...document.querySelectorAll<HTMLElement>('[data-project-pick]')].map((el) => [
      el.dataset.projectPick,
      el.textContent,
    ])
    // a project of another organization names it
    expect(rows).toEqual([
      [META, 'Luma Sensor'],
      [expect.any(String), 'Electronics'],
      [FW, 'Firmware'],
      [PORTAL, 'Partner portalPartner Co'],
    ])
    await press(find('[data-project-picker-search]'), 'Escape')
    await type('portal')
    await choose(`org:${PARTNER}`)
    expect(scopeLabel()).toBe('All projects in Partner Co')
    expect(last().args.scope).toEqual({ org_id: PARTNER })
    await last().answer([])
    // a chosen project that leaves the workspace stays chosen; the server
    // answers it as any project the person cannot see
    await choose(FW)
    expect(last().args.scope).toEqual({ org_id: ORG, project_id: FW })
    await last().answer([])
    const asked = calls.length
    await act(async () =>
      publish({
        ...structuredClone(snap),
        projects: snap.projects.filter((p) => p.id !== FW),
        delivered_at: '2026-09-15T09:00:00.000Z',
      }),
    )
    await settle()
    expect(scopeLabel()).toBe('Luma Sensor › Firmware')
    expect(calls).toHaveLength(asked)
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
    // the offer opens Search in's picker
    await click(find('[data-palette-choose]'))
    expect(document.activeElement).toBe(find('[data-project-picker-search]'))
    await press(find('[data-project-picker-search]'), 'Escape')
    expect(document.querySelector('[data-project-picker]')).toBeNull()
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

  it('asks for more words, not a project, when a chosen project could not be covered', async () => {
    await open({ partner: true })
    const stopped = { complete: false, stopped: 'reads', searched: 1, of: 1 } as const
    await type('the')
    await last().answer([task(3)], null, stopped)
    expect(find('[data-palette-choose]').textContent).toBe('Choose a project')
    await choose(FW)
    expect(last().args.scope).toEqual({ org_id: ORG, project_id: FW })
    await last().answer([task(3)], null, stopped)
    expect(status()).toBe('Some results might be missing. Add more words to narrow the search.')
    expect(document.querySelector('[data-palette-choose]')).toBeNull()
    // an organization chosen whole still offers its projects
    await choose(`org:${ORG}`)
    await last().answer([task(3)], null, stopped)
    expect(status()).toBe('Some results might be missing. Choose a project to search in.')
    expect(find('[data-palette-choose]').textContent).toBe('Choose a project')
  })

  it('offers Retry for a failed read, and restarts once at the first page on a refused cursor', async () => {
    await open()
    await type('firm')
    await last().fail()
    expect(status()).toBe("Couldn't search. Try again.")
    expect(values()).toEqual([])
    // Retry takes focus, as a person presses it, and leaves with the failure
    find('[data-palette-retry]').focus()
    await click(find('[data-palette-retry]'))
    expect(document.activeElement).toBe(input())
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
    find('[data-palette-retry]').focus()
    await click(find('[data-palette-retry]'))
    expect(document.activeElement).toBe(input())
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
    expect(ctx.openIssue).toHaveBeenCalledWith(refTo(ORG, 21))
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a result by the handle the store gives it when it opens, after a role change, else by a reference', async () => {
    await open()
    await type('firm')
    await last().answer([task(14), task(15)])
    expect(values()).toEqual(['issue-QN-14', 'issue-QN-15'])
    // the person becomes a guest of the organization, with a grant on Luma
    // Sensor, and the workspace now holds QN-15, both by uuid
    const next = structuredClone(snap)
    next.profiles[0].org_role = 'guest'
    next.access.push({ project_id: META, profile_id: next.profiles[0].id, level: 'user' })
    next.issues.push({
      id: 'task-15',
      org_id: ORG,
      project_id: FW,
      num: 15,
      title: 'Flash the firmware 15',
      description: '',
      status: 'todo',
      priority: 'medium',
      paused: false,
      created_at: '2026-09-14T08:00:00.000Z',
      updated_at: '2026-09-14T08:00:00.000Z',
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    next.delivered_at = '2026-09-15T09:00:00.000Z'
    await act(async () => publish(next))
    await settle()
    const store = await import('../store/planner')
    expect(store.P.homeOrg).toBe('')
    expect(store.P.handleOf('task-15')).toBe('task-15')
    const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
    // one the workspace does not hold opens by a reference that names its
    // organization, number and uuid, never a handle
    await click(rows()[0])
    expect(ctx.openIssue).toHaveBeenLastCalledWith(refTo(ORG, 14))
    // one it holds by the handle it has now
    await click(rows()[1])
    expect(ctx.openIssue).toHaveBeenLastCalledWith('task-15')
  })

  it('opens a task the workspace does not hold by a reference, and a project the workspace holds as the scope', async () => {
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
    expect(ctx.openIssue).toHaveBeenLastCalledWith(refTo(ORG, 16))
    await click(rows()[2])
    expect(ctx.openIssue).toHaveBeenLastCalledWith(refTo(PARTNER, 5, 'partner-task'))
    await click(rows()[0])
    expect(ctx.openIssue).toHaveBeenLastCalledWith(refTo(ORG, 14))
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
