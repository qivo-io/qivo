// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PickRules, ProjectPick } from '../lib/projectPick'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from '../store/projectNavStandIn.setup'
import { TooltipProvider } from './ui/tooltip'

/* The shared project picker (components/ProjectPicker.tsx) on the real
   store, with the navigation reads answered by their stand-in
   (store/projectNavStandIn.setup.ts) from the workspace the test holds.
   The person holds a user seat in Testbed Labs, with a grant on each
   top-level project the case plants, and with `partner` a user seat in
   Partner Co. Typing runs on fake timers, so the picker's 250 ms rest
   takes no real time. Each case raises at most one figure of the design
   size and reaches the cap notes by lowering a cap. */

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

const NOW = '2026-09-14T08:00:00.000Z'

/** One subscription of a navigation read, open until the picker drops it. */
type Sub = {
  name: string
  args: Record<string, unknown>
  next: (value: unknown) => void
  fail: (error: unknown) => void
  open: boolean
}

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let subs: Sub[]
let force: ForcedProjectNav
// reads whose answers wait until the test delivers them
let holding: ((sub: Sub) => boolean) | null
let ORG: string
let ME: string
let PARTNER: string
let picker: typeof import('./ProjectPicker')
let pickLib: typeof import('../lib/projectPick')
let version: typeof import('../store/usePlannerVersion')
let store: typeof import('../store/planner')
let picked: ProjectPick | null
let done: ReturnType<typeof vi.fn<() => void>>

/** Lets answers and renders land. */
const settle = async () => {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
      else await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

/** A name of ordinary length, about 30 characters, numbered. */
const named = (n: number, what = 'Sensor programme') => `${what} ${String(n).padStart(3, '0')}`

/** The fixture with the person's seat, Testbed Labs' projects cleared, and
    with `partner` a user seat in Partner Co. */
function base(partner = false): Snapshot {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  ME = next.profiles[0].id
  next.profiles[0] = { ...next.profiles[0], org_role: 'user' }
  next.projects = []
  PARTNER = crypto.randomUUID()
  if (partner) {
    const seat = crypto.randomUUID()
    next.orgs.push({ ...next.orgs[0], id: PARTNER, name: 'Partner Co', slug: 'partner' })
    next.profiles.push({ ...next.profiles[0], id: seat, org_id: PARTNER, org_role: 'user' })
    next.myProfileIds.push(seat)
  }
  return next
}

let num = 10
/** Adds a top-level project to `next` with a grant for the person's seat
    in its organization (none with `grant` false), answering its id. */
function top(next: Snapshot, name: string, o: { org?: string; grant?: boolean } = {}) {
  const org = o.org ?? ORG
  const id = crypto.randomUUID()
  next.projects.push({
    ...plannerFixture().projects[0],
    id,
    org_id: org,
    type: 'meta',
    key: `P${num}`,
    num: num++,
    name,
    created_at: NOW,
  })
  const seat = next.profiles.find((p) => p.org_id === org && next.myProfileIds.includes(p.id))
  if (seat && o.grant !== false)
    next.access.push({ project_id: id, profile_id: seat.id, level: 'user' })
  return id
}
/** Adds a sub-project of `parent` to `next`, with a grant of its own when
    `grant`, answering its id. */
function sub(next: Snapshot, parent: string, name: string, grant = false) {
  const p = next.projects.find((x) => x.id === parent)
  if (!p) throw new Error('no parent')
  const id = crypto.randomUUID()
  next.projects.push({
    ...p,
    id,
    type: 'project',
    parent_id: parent,
    key: `S${num}`,
    num: num++,
    name,
  })
  if (grant) next.access.push({ project_id: id, profile_id: ME, level: 'user' })
  return id
}

/** Loads the store from `next`, with the navigation reads answered by the
    stand-in. */
async function load(next: Snapshot) {
  vi.resetModules()
  snap = next
  subs = []
  force = {}
  holding = null
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    if (isProjectNavRead(name)) {
      const s: Sub = { name, args, next: receive, fail, open: true }
      subs.push(s)
      if (!holding?.(s)) answerProjectNav(snap, name, args, receive, fail, { force })
      return () => {
        s.open = false
      }
    }
    if (name === 'workspace:whole') receive(structuredClone(snap))
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    return isProjectNavRead(name)
      ? queryProjectNav(snap, name, args, { force })
      : Promise.resolve(null)
  })
  network.mutation.mockResolvedValue(null)
  store = await import('../store/planner')
  await store.initStore()
  picker = await import('./ProjectPicker')
  pickLib = await import('../lib/projectPick')
  version = await import('../store/usePlannerVersion')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** Delivers a held subscription's answer now. */
const deliver = (s: Sub) =>
  act(async () => answerProjectNav(snap, s.name as never, s.args, s.next, s.fail, { force }))

const SEARCH_RULES: PickRules = { many: false, oneOrg: false, all: 'every' }
const ARCHIVE_RULES: PickRules = { many: true, most: 50, oneOrg: true, all: 'org' }

/** Renders the panel alone, with `rules`, from `initial`. */
async function panel(rules: PickRules = SEARCH_RULES, initial: ProjectPick | null = null) {
  picked = initial
  done = vi.fn<() => void>()
  function Harness() {
    version.usePlannerVersion()
    const [pick, setPick] = useState<ProjectPick | null>(initial)
    useEffect(() => {
      picked = pick
    })
    return <picker.ProjectPickerPanel pick={pick} onPick={setPick} rules={rules} onDone={done} />
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Harness />
      </TooltipProvider>,
    ),
  )
  await settle()
}

/** Renders the trigger with its popover, with `rules`. */
async function withTrigger(rules: PickRules = SEARCH_RULES) {
  picked = null
  function Harness() {
    version.usePlannerVersion()
    const [pick, setPick] = useState<ProjectPick | null>(null)
    useEffect(() => {
      picked = pick
    })
    return (
      <picker.ProjectPicker
        trigger={{ 'data-test-trigger': '' }}
        name="Projects"
        pick={pick}
        onPick={setPick}
        rules={rules}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Harness />
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
  Reflect.deleteProperty(document, 'visibilityState')
  if (pickLib) Object.assign(pickLib.PROJECT_PICKER_MOST, { list: 200, children: 50 })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/** The element `selector` names, or a thrown error. */
function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const field = () => find<HTMLInputElement>('[data-project-picker-search]')
/** The project rows' ids in order, children under their parent. */
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-pick]')].map(
    (el) => el.dataset.projectPick,
  )
/** The project rows' text in order. */
const rowText = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-pick]')].map(
    (el) => el.textContent ?? '',
  )
const notes = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-picker-note]')].map(
    (el) => `${el.dataset.projectPickerNote}: ${el.textContent}`,
  )
const pickerText = () => find('[data-project-picker]').textContent ?? ''
const open = () => subs.filter((s) => s.open)
const asked = (name: string) => subs.filter((s) => s.name === `projectNav:${name}`)

async function key(value: string) {
  const input = field()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function wait(ms: number) {
  await act(async () => await vi.advanceTimersByTimeAsync(ms))
  await settle()
}
/** Types `value` and rests past the picker's pause. */
async function type(value: string) {
  await key(value)
  await wait(300)
}
async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => element.click())
  await settle()
}
async function press(element: Element, name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  await act(async () => element.dispatchEvent(event))
  await settle()
  return event
}
const more = () => click(find('[data-project-picker-more]'))
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}

describe('the project picker', { timeout: 30_000 }, () => {
  it('browses the person’s projects 25 at a time, favorites first with a star, to the end', async () => {
    const next = base()
    const ids = Array.from({ length: 30 }, (_, n) => top(next, named(29 - n)))
    await load(next)
    force.favorites = [ids[0], ids[5]]
    await panel()
    // the favorites (programmes 029 and 024) first, then the rest by name
    expect(rowText().slice(0, 3)).toEqual([
      expect.stringContaining('Sensor programme 024'),
      expect.stringContaining('Sensor programme 029'),
      expect.stringContaining('Sensor programme 000'),
    ])
    expect(document.querySelectorAll('[data-project-pick] svg.lucide-star')).toHaveLength(2)
    expect(rowIds()).toHaveLength(25)
    expect(asked('page').map((s) => s.args)).toEqual([{}])
    await more()
    expect(rowIds()).toHaveLength(30)
    expect(new Set(rowIds()).size).toBe(30)
    expect(document.querySelector('[data-project-picker-more]')).toBeNull()
    expect(notes()).toEqual([])
    // the pinned first batch and the open second stay live
    expect(open().map((s) => Object.keys(s.args).sort())).toEqual([['through'], ['after']])
  })

  it('lists one project’s sub-projects under it, one at a time, and drops the read on collapse', async () => {
    const next = base()
    const luma = top(next, 'Luma Sensor')
    const orbit = top(next, 'Orbit Camera')
    sub(next, luma, 'Firmware')
    sub(next, luma, 'Electronics')
    sub(next, orbit, 'Optics')
    await load(next)
    await panel()
    await click(find(`[data-project-expand="${luma}"]`))
    expect(rowText()).toEqual([
      expect.stringContaining('Luma Sensor'),
      'Electronics',
      'Firmware',
      expect.stringContaining('Orbit Camera'),
    ])
    expect(find(`[data-project-expand="${luma}"]`).getAttribute('aria-expanded')).toBe('true')
    const first = asked('children')[0]
    expect(first.args).toEqual({ project_id: luma })
    // another row's arrow drops the first one's read
    await click(find(`[data-project-expand="${orbit}"]`))
    expect(first.open).toBe(false)
    expect(rowText()).toEqual([
      expect.stringContaining('Luma Sensor'),
      expect.stringContaining('Orbit Camera'),
      'Optics',
    ])
    await click(find(`[data-project-expand="${orbit}"]`))
    expect(open().filter((s) => s.name === 'projectNav:children')).toEqual([])
    expect(rowIds()).toHaveLength(2)
  })

  it('says a project it can no longer open, never that it has no sub-projects', async () => {
    const next = base()
    const luma = top(next, 'Luma Sensor')
    sub(next, luma, 'Firmware')
    await load(next)
    await panel()
    holding = (s) => s.name === 'projectNav:children'
    await click(find(`[data-project-expand="${luma}"]`))
    // the person's grant goes while the read is on its way
    snap.access = snap.access.filter((a) => a.project_id !== luma)
    await deliver(asked('children')[0])
    await settle()
    expect(notes()).toContain('unavailable: You can no longer open this project.')
    expect(pickerText()).not.toContain('No active sub-projects.')
  })

  it('tells equal names apart by their number, and leaves other names alone', async () => {
    const next = base()
    const first = top(next, 'Test')
    const second = top(next, 'Test')
    const other = top(next, 'Other')
    for (const [id, n] of [
      [first, 4],
      [second, 7],
    ] as const) {
      const p = next.projects.find((x) => x.id === id)
      if (p) p.num = n
    }
    await load(next)
    await panel()
    expect(find(`[data-project-pick="${first}"]`).textContent).toMatch(/Test#4$/)
    expect(find(`[data-project-pick="${second}"]`).textContent).toMatch(/Test#7$/)
    expect(find(`[data-project-pick="${other}"]`).textContent).toBe('Other')
  })

  it('tags the equal names of the projects a search’s sub-projects name', async () => {
    const next = base()
    const first = top(next, 'Test')
    const second = top(next, 'Test')
    const other = top(next, 'Other')
    const fws = [first, second, other].map((parent) => sub(next, parent, 'Firmware'))
    for (const [id, n] of [
      [first, 4],
      [second, 7],
    ] as const) {
      const p = next.projects.find((x) => x.id === id)
      if (p) p.num = n
    }
    await load(next)
    await panel()
    await type('firmware')
    // each sub-project row names its project, and the two named Test carry
    // their number; Other's name is its own
    expect(new Set(rowIds())).toEqual(new Set(fws))
    expect(find(`[data-project-pick="${fws[0]}"]`).textContent).toBe('Test#4 › Firmware')
    expect(find(`[data-project-pick="${fws[1]}"]`).textContent).toBe('Test#7 › Firmware')
    expect(find(`[data-project-pick="${fws[2]}"]`).textContent).toBe('Other › Firmware')
  })

  it('searches once typing rests, every word of a project’s own name, ignoring accents', async () => {
    const next = base()
    const cafe = top(next, 'Café Ordering')
    const luma = top(next, 'Luma Sensor')
    const fw = sub(next, luma, 'Firmware Builds')
    await load(next)
    await panel()
    await key('fir')
    await wait(100)
    await key('firm')
    await wait(100)
    expect(asked('search')).toEqual([])
    expect(notes()).toEqual(['loading: Loading projects…'])
    expect(rowIds()).toEqual([])
    await wait(200)
    expect(asked('search').map((s) => s.args)).toEqual([{ search: 'firm' }])
    // a sub-project names its project
    expect(rowText()).toEqual(['Luma Sensor › Firmware Builds'])
    expect(rowIds()).toEqual([fw])
    await type('cafe ORDER')
    expect(rowIds()).toEqual([cafe])
    // a parent's name finds the parent, never its sub-projects
    await type('luma')
    expect(rowIds()).toEqual([luma])
    await type('nothing like it')
    expect(notes()).toEqual(['none: No projects match “nothing like it”.'])
  })

  it('drops an older text’s answer that lands after a newer one', async () => {
    const next = base()
    const luma = top(next, 'Luma Sensor')
    top(next, 'Orbit Camera')
    await load(next)
    await panel()
    holding = (s) => s.name === 'projectNav:search'
    await type('orbit')
    await type('luma')
    const [older, newer] = asked('search')
    expect(older.open).toBe(false)
    await deliver(newer)
    await settle()
    expect(rowIds()).toEqual([luma])
    await deliver(older)
    await settle()
    expect(rowIds()).toEqual([luma])
  })

  it('browses for a text of spaces and accents only, and asks nothing past 200 characters', async () => {
    const next = base()
    top(next, 'Luma Sensor')
    await load(next)
    await panel()
    await type('   ')
    await type(' ́́ ')
    expect(asked('search')).toEqual([])
    expect(rowIds()).toHaveLength(1)
    await type('x'.repeat(201))
    expect(asked('search')).toEqual([])
    expect(notes()).toEqual([
      'too_long: A search must be at most 200 characters. Search for fewer words.',
    ])
    expect(rowIds()).toEqual([])
  })

  it('keeps a pick in one organization, searching only it, until Clear', async () => {
    const next = base(true)
    const luma = top(next, 'Luma Sensor')
    const portal = top(next, 'Partner portal', { org: PARTNER })
    const lumaApi = top(next, 'Luma API')
    await load(next)
    await panel(ARCHIVE_RULES)
    // both organizations' All projects come first, and a foreign row names
    // its organization
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-project-pick-all]')].map(
        (el) => `${el.dataset.projectPickAll}: ${el.textContent}`,
      ),
    ).toEqual([`${ORG}: All projects in Testbed Labs`, `${PARTNER}: All projects in Partner Co`])
    expect(find(`[data-project-pick="${portal}"]`).textContent).toContain('Partner Co')
    await click(find(`[data-project-pick="${luma}"]`))
    expect(picked).toMatchObject({ kind: 'projects', org_id: ORG })
    expect(find<HTMLButtonElement>(`[data-project-pick="${portal}"]`).disabled).toBe(true)
    expect(notes()).toContain('org: Choose projects of one organization at a time.Clear')
    await type('luma')
    expect(asked('search').at(-1)?.args).toEqual({ search: 'luma', org_id: ORG })
    expect(rowIds()).toEqual([lumaApi, luma])
    await type('')
    await click(find('[data-project-picker-clear]'))
    expect(picked).toBeNull()
    expect(find<HTMLButtonElement>(`[data-project-pick="${portal}"]`).disabled).toBe(false)
    await type('portal')
    expect(asked('search').at(-1)?.args).toEqual({ search: 'portal' })
    // no read ever names an empty organization
    expect(subs.some((s) => s.args.org_id === '')).toBe(false)
  })

  it('keeps the expanded project open when a pick narrows the search to its organization', async () => {
    const next = base(true)
    const luma = top(next, 'Luma Sensor')
    const el = sub(next, luma, 'Electronics')
    const fw = sub(next, luma, 'Firmware')
    const kit = top(next, 'Luma partner kit', { org: PARTNER })
    await load(next)
    await panel(ARCHIVE_RULES)
    await type('luma')
    expect(rowIds()).toEqual([kit, luma])
    await click(find(`[data-project-expand="${luma}"]`))
    await click(find(`[data-project-pick="${fw}"]`))
    // the search now reads Luma's organization alone, and Luma stays open
    // on the same read of its sub-projects
    expect(asked('search').at(-1)?.args).toEqual({ search: 'luma', org_id: ORG })
    expect(find(`[data-project-expand="${luma}"]`).getAttribute('aria-expanded')).toBe('true')
    expect(rowIds()).toEqual([luma, el, fw])
    expect(asked('children')).toHaveLength(1)
    expect(asked('children')[0].open).toBe(true)
    // taking the pick off widens the search again, still open
    await click(find(`[data-project-pick="${fw}"]`))
    expect(asked('search').at(-1)?.args).toEqual({ search: 'luma' })
    expect(rowIds()).toEqual([kit, luma, el, fw])
    // a new text collapses it
    await type('lum')
    expect(rowIds()).toEqual([kit, luma])
    expect(open().filter((s) => s.name === 'projectNav:children')).toEqual([])
  })

  it('collapses an expanded project that the narrowed search no longer lists, and drops its read', async () => {
    const next = base(true)
    for (let n = 1; n <= 5; n++) top(next, `Luma ${n}`)
    const luma = top(next, 'Luma Sensor')
    const fw = sub(next, luma, 'Firmware')
    top(next, 'Luma partner kit', { org: PARTNER })
    await load(next)
    force.batch = 5
    await panel(ARCHIVE_RULES)
    await type('luma')
    await more()
    await click(find(`[data-project-expand="${luma}"]`))
    await click(find(`[data-project-pick="${fw}"]`))
    // the narrowed search's first batch ends before Luma Sensor
    expect(asked('search').at(-1)?.args).toEqual({ search: 'luma', org_id: ORG })
    expect(rowIds()).toHaveLength(5)
    expect(rowIds()).not.toContain(luma)
    expect(open().filter((s) => s.name === 'projectNav:children')).toEqual([])
    await more()
    expect(find(`[data-project-expand="${luma}"]`).getAttribute('aria-expanded')).toBe('false')
  })

  it('says why a list is held, with no count or empty line, and keeps the fixed rows', async () => {
    const next = base()
    top(next, 'Luma Sensor')
    await load(next)
    force.notReady = true
    await panel()
    expect(notes()).toEqual(['not_ready: Qivo is still preparing your project list.'])
    expect(pickerText()).not.toMatch(/\d|No projects/)
    await click(find('[data-project-pick-all=""]'))
    expect(picked).toEqual({ kind: 'every' })
    expect(done).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    root = createRoot(container)
    force = { unchecked: 'Qivo could not finish checking which projects you can see.' }
    await panel()
    expect(notes()).toEqual([
      'unchecked: Qivo could not finish checking which projects you can see.',
    ])
    expect(pickerText()).not.toMatch(/\d|No projects/)
    expect(find('[data-project-pick-all=""]')).not.toBeNull()
  })

  it('says Qivo checked part where a batch stopped, and never that nothing matched', async () => {
    const next = base()
    for (let n = 0; n < 6; n++) top(next, named(n))
    await load(next)
    force.stop = 2
    await panel()
    expect(rowIds()).toHaveLength(2)
    expect(notes()).toEqual(['stopped: Qivo checked part of your projects.'])
    await type('nothing')
    // the last batch stopped, so its end is unknown
    expect(notes()).toEqual(['stopped: Qivo checked part of your projects.'])
    expect(pickerText()).not.toContain('No projects match')
    force = {}
    await more()
    expect(notes()).toEqual(['none: No projects match “nothing”.'])
  })

  it('offers Retry where a read failed, and says the list is full at the cap', async () => {
    const next = base()
    for (let n = 0; n < 12; n++) top(next, named(n))
    await load(next)
    force.fail = true
    await panel()
    expect(notes()).toEqual(["failed: Couldn't load your projects.Retry"])
    force = {}
    await click(
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry') ?? null,
    )
    expect(rowIds()).toHaveLength(12)
    await act(async () => root.unmount())
    root = createRoot(container)
    // two batches of five gather a list of at most 50 rows
    pickLib.PROJECT_PICKER_MOST.list = 50
    force = { batch: 5 }
    await panel()
    await more()
    expect(rowIds()).toHaveLength(10)
    expect(notes()).toEqual(['full: Search to find more projects.'])
    expect(document.querySelector('[data-project-picker-more]')).toBeNull()
  })

  it('reads nothing while hidden, and none of the workspace’s projects', async () => {
    const next = base()
    top(next, 'Luma Sensor')
    await load(next)
    const spies = [
      vi.spyOn(store.P, 'visibleProjects'),
      vi.spyOn(store.P, 'project'),
      vi.spyOn(store.P, 'canSee'),
    ]
    await withTrigger()
    // a closed picker holds no read
    expect(subs).toEqual([])
    await click(find('[data-test-trigger]'))
    expect(open().map((s) => s.name)).toEqual(['projectNav:page'])
    await setVisibility('hidden')
    expect(open()).toEqual([])
    await setVisibility('visible')
    expect(open().map((s) => s.name)).toEqual(['projectNav:page'])
    expect(rowIds()).toHaveLength(1)
    await type('luma')
    expect(open().map((s) => s.name)).toEqual(['projectNav:search'])
    await press(field(), 'Escape')
    await press(field(), 'Escape')
    expect(document.querySelector('[data-project-picker]')).toBeNull()
    expect(open()).toEqual([])
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('moves through the rows from the field, picks with Enter and gives focus back on close', async () => {
    const next = base()
    const luma = top(next, 'Luma Sensor')
    const fw = sub(next, luma, 'Firmware')
    top(next, 'Orbit Camera')
    await load(next)
    await withTrigger()
    const trigger = find('[data-test-trigger]')
    await click(trigger)
    expect(document.activeElement).toBe(field())
    // All projects, then Luma Sensor
    await press(field(), 'ArrowDown')
    await press(field(), 'ArrowDown')
    expect(field().getAttribute('aria-activedescendant')).toBe(
      find(`[data-project-pick="${luma}"]`).id,
    )
    await press(field(), 'ArrowRight')
    expect(rowIds()).toEqual([luma, fw, expect.any(String)])
    await press(field(), 'ArrowDown')
    await press(field(), 'ArrowLeft')
    expect(rowIds()).toHaveLength(2)
    // Left gave the active row back to Luma Sensor
    await press(field(), 'ArrowRight')
    await press(field(), 'ArrowDown')
    await press(field(), 'Enter')
    expect(picked).toMatchObject({ projects: [{ id: fw, parent: { id: luma } }] })
    expect(document.querySelector('[data-project-picker]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.textContent).toBe('Luma Sensor › Firmware')
    // a screen reader hears the trigger's label with the pick
    expect(trigger.getAttribute('aria-label')).toBe('Projects, Luma Sensor › Firmware')
  })

  it('clears the text on the first Escape and closes on the next, which goes no further', async () => {
    const next = base()
    top(next, 'Luma Sensor')
    await load(next)
    const outer = vi.fn()
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) outer()
    })
    await withTrigger()
    await click(find('[data-test-trigger]'))
    await type('luma')
    expect((await press(field(), 'Escape')).defaultPrevented).toBe(true)
    expect(field().value).toBe('')
    expect((await press(field(), 'Escape')).defaultPrevented).toBe(true)
    expect(document.querySelector('[data-project-picker]')).toBeNull()
    expect(outer).not.toHaveBeenCalled()
  })

  it('closes on a phone’s Back', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    const next = base()
    top(next, 'Luma Sensor')
    await load(next)
    vi.useRealTimers()
    // the page's history and the layers' listener, as main.tsx and App add them
    const pageHistory = await import('../lib/pageHistory')
    onTestFinished(pageHistory.installPageHistory())
    onTestFinished(pageHistory.listenBackLayers())
    await withTrigger()
    await click(find('[data-test-trigger]'))
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
    expect(document.querySelector('[data-project-picker]')).not.toBeNull()
    expect(history.state?.qivoLayer).toBeTruthy()
    await act(async () => {
      history.back()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(document.querySelector('[data-project-picker]')).toBeNull()
    expect(history.state?.qivoLayer).toBeUndefined()
  })

  it('covers a picked project’s sub-projects and refuses a pick past the cap', async () => {
    const next = base()
    const luma = top(next, 'Luma Sensor')
    const fw = sub(next, luma, 'Firmware')
    const orbit = top(next, 'Orbit Camera')
    await load(next)
    await panel({ ...ARCHIVE_RULES, most: 2 })
    await click(find(`[data-project-expand="${luma}"]`))
    await click(find(`[data-project-pick="${fw}"]`))
    await click(find(`[data-project-pick="${luma}"]`))
    // the project's pick dropped its sub-project's
    expect(picked).toMatchObject({ projects: [{ id: luma }] })
    const included = find<HTMLButtonElement>(`[data-project-pick="${fw}"]`)
    expect(included.disabled).toBe(true)
    expect(included.getAttribute('aria-checked')).toBe('true')
    expect(included.textContent).toContain('Included in Luma Sensor')
    await click(find(`[data-project-pick="${orbit}"]`))
    expect(notes()).toContain('most: You can choose up to 2 projects.')
    await click(find(`[data-project-pick="${luma}"]`))
    expect(picked).toMatchObject({ projects: [{ id: orbit }] })
  })
})

describe('the project picker at the design size', { timeout: 60_000 }, () => {
  it('browses 200 top-level projects in eight batches to the end', async () => {
    const next = base()
    for (let n = 0; n < 200; n++) top(next, named(n))
    await load(next)
    await panel()
    for (let n = 0; n < 7; n++) await more()
    expect(rowIds()).toHaveLength(200)
    expect(new Set(rowIds()).size).toBe(200)
    expect(asked('page').filter((s) => s.open)).toHaveLength(8)
    expect(notes()).toEqual([])
    expect(document.querySelector('[data-project-picker-more]')).toBeNull()
  })

  it('lists 25 and then 5 more of one project’s 30 sub-projects', async () => {
    const next = base()
    const luma = top(next, 'Luma Sensor')
    for (let n = 0; n < 30; n++) sub(next, luma, named(n, 'Firmware track'))
    await load(next)
    await panel()
    await click(find(`[data-project-expand="${luma}"]`))
    expect(rowIds()).toHaveLength(26)
    await more()
    expect(rowIds()).toHaveLength(31)
    expect(notes()).toEqual([])
  })

  it('finds 200 sub-projects the person reads 25 a batch and picks 50, refusing the 51st', async () => {
    const next = base()
    const parents = Array.from({ length: 67 }, (_, n) =>
      top(next, named(n, 'Programme'), { grant: false }),
    )
    for (let n = 0; n < 200; n++) sub(next, parents[n % 67], named(n, 'Workstream'), true)
    await load(next)
    await panel(ARCHIVE_RULES)
    await type('workstream')
    for (let n = 0; n < 7; n++) await more()
    const ids = rowIds()
    expect(ids).toHaveLength(200)
    expect(asked('search').filter((s) => s.open)).toHaveLength(8)
    for (const id of ids.slice(0, 50)) await click(find(`[data-project-pick="${id}"]`))
    expect(picked?.kind === 'projects' && picked.projects).toHaveLength(50)
    const fifty1 = find<HTMLButtonElement>(`[data-project-pick="${ids[50]}"]`)
    expect(fifty1.disabled).toBe(true)
    await click(fifty1)
    expect(picked?.kind === 'projects' && picked.projects).toHaveLength(50)
    expect(notes()).toContain('most: You can choose up to 50 projects.')
  })
})
