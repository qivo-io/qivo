// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import {
  type DeletedFixture,
  deletedFixtureOf,
  deletedPurge,
  deletedRestore,
  deletedStandIn,
  type ForcedDeleted,
  isDeletedRead,
} from '../../store/deletedItemsStandIn.setup'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'
import { answerProjectNav, isProjectNavRead } from '../../store/projectNavStandIn.setup'

/* The Deleted items page on the real store, with its reads and writes
   answered by the stand-in (store/deletedItemsStandIn.setup.ts), which
   src/store/deletedItemsParity.test.ts holds to the server's, over a
   workspace the case builds: Testbed Labs' top-level project Luma Sensor
   with the sub-projects Firmware, which is deleted whole with its tasks,
   and Electronics, whose tasks are deleted one by one, mostly by the
   person, every third by Daniel Berg and every seventh by the agent Relay
   through its key. The person is an admin unless a case says otherwise.
   Every live read is recorded with whether it is still open, and answered
   again after each write, as Convex would. Typing runs on fake timers, so
   the search's 250 ms rest takes no real time. Restores of more than 25
   items use 30 to 60 items, never a design-size figure, and the caps are
   reached by lowering them. */

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

/** One live read the page opened, open until it stops. */
type Sub = {
  name: string
  args: Record<string, unknown>
  next: (value: unknown) => void
  fail: (error: unknown) => void
  open: boolean
}
/** One write the page sent, which `hold` keeps waiting. */
type Call = {
  name: string
  args: { org_id: string; ids: string[]; bulk?: boolean }
  go?: () => void
}

const NOW = new Date('2026-10-16T15:00:00.000Z')

let snap: Snapshot
let fx: DeletedFixture
let force: ForcedDeleted
let subs: Sub[]
let calls: Call[]
let peopleAsked: Record<string, unknown>[]
// writes wait until the case lets them go
let holding: boolean
// the reads whose answers wait until the case delivers them
let holdReads: ((sub: Sub) => boolean) | null
// a write changed the fixture, so the open reads answer again
let dirty: boolean
let container: HTMLDivElement
let root: Root
let store: typeof import('../../store/planner')
let lib: typeof import('../../lib/deletedItems')
let ORG: string
let ME: string
let DANIEL: string
let RELAY: string
let MIRA: string
let PARTNER: string
let LUMA: string
let FW: string
let EL: string

/** Testbed Labs with Luma Sensor's Firmware and Electronics, `tasks`
    Electronics tasks, Daniel Berg, Mira (invited, never joined) and the
    agent Relay, and with `partner` a seat in Partner Co too. */
function world(o: { tasks?: number; role?: 'admin' | 'user'; partner?: boolean } = {}) {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  ME = next.profiles[0].id
  next.profiles[0] = { ...next.profiles[0], name: 'Nora', org_role: o.role ?? 'admin' }
  const person = (name: string, extra: object = {}) => {
    const id = crypto.randomUUID()
    next.profiles.push({
      ...next.profiles[0],
      id,
      name,
      auth_user_id: `auth-${name}`,
      org_role: 'user',
      ...extra,
    })
    return id
  }
  DANIEL = person('Daniel Berg')
  MIRA = person('Mira Holm', { auth_user_id: undefined })
  RELAY = person('Relay', { kind: 'agent', auth_user_id: undefined })
  const base = next.projects[0]
  const luma = {
    ...base,
    id: crypto.randomUUID(),
    type: 'meta' as const,
    key: 'LUMA',
    name: 'Luma Sensor',
  }
  const firmware = {
    ...base,
    id: crypto.randomUUID(),
    key: 'FW',
    num: 2,
    name: 'Firmware',
    parent_id: luma.id,
  }
  const electronics = {
    ...base,
    id: crypto.randomUUID(),
    key: 'EL',
    num: 3,
    name: 'Electronics',
    parent_id: luma.id,
  }
  next.projects = [luma, firmware, electronics]
  LUMA = luma.id
  FW = firmware.id
  EL = electronics.id
  // the picker judges by ordinary access, so the person holds a grant
  next.access.push({ project_id: luma.id, profile_id: ME, level: 'user' })
  const task = (project: string, num: number, title: string, extra: object = {}) =>
    next.issues.push({
      id: crypto.randomUUID(),
      org_id: ORG,
      project_id: project,
      num,
      title,
      description: '',
      status: 'todo',
      priority: 'medium',
      paused: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ...extra,
    } as Snapshot['issues'][number])
  task(firmware.id, 1, 'Flash the bootloader')
  task(firmware.id, 2, 'Book test sites in Umeå', { assignee_id: DANIEL })
  for (let i = 0; i < (o.tasks ?? 5); i++)
    task(electronics.id, 10 + i, `Route board ${10 + i}`, {
      ...(i === 1 ? { description: 'Check the antenna clearance' } : {}),
      ...(i % 4 === 0 ? { assignee_id: DANIEL } : {}),
    })
  PARTNER = crypto.randomUUID()
  if (o.partner) {
    const seat = crypto.randomUUID()
    next.orgs.push({ ...next.orgs[0], id: PARTNER, name: 'Partner Co', slug: 'partner' })
    next.profiles.push({ ...next.profiles[0], id: seat, org_id: PARTNER, org_role: 'user' })
    next.myProfileIds.push(seat)
    const top = {
      ...base,
      id: crypto.randomUUID(),
      org_id: PARTNER,
      type: 'meta' as const,
      key: 'PC',
      name: 'Partner launch',
    }
    next.projects.push(top, {
      ...base,
      id: crypto.randomUUID(),
      org_id: PARTNER,
      key: 'PCW',
      num: 2,
      name: 'Partner web',
      parent_id: top.id,
    })
  }
  return next
}

/** Answers `sub` from the stand-in now, or its refusal. */
function answer(sub: Sub) {
  try {
    sub.next(structuredClone(deletedStandIn(fx, sub.name, sub.args, force)))
  } catch (error) {
    sub.fail(error)
  }
}

/** Loads the store over `next`, with the Deleted items reads on the
    stand-in over `fixture`. */
async function load(next: Snapshot, fixture?: DeletedFixture) {
  vi.resetModules()
  snap = next
  fx = fixture ?? deletedFixtureOf(snap, { tasks: 60, at: NOW.toISOString() })
  force = {}
  subs = []
  calls = []
  peopleAsked = []
  holding = false
  holdReads = null
  dirty = false
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') receive(structuredClone(snap))
    if (isProjectNavRead(name)) answerProjectNav(snap, name, args, receive, fail)
    if (!isDeletedRead(name)) return () => {}
    const sub: Sub = { name, args, next: receive, fail, open: true }
    subs.push(sub)
    if (!holdReads?.(sub)) answer(sub)
    return () => {
      sub.open = false
    }
  })
  network.query.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name !== 'deletedItems:people') return Promise.resolve(null)
    peopleAsked.push(args)
    try {
      return Promise.resolve(structuredClone(deletedStandIn(fx, name, args, force)))
    } catch (error) {
      return Promise.reject(error)
    }
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    const call: Call = { name, args }
    calls.push(call)
    // the reads a write changed answer before the write does, as Convex
    // sends a transition before the answer it holds
    const run = () => {
      const value =
        name === 'deletedItems:restore'
          ? deletedRestore(fx, args, force)
          : name === 'deletedItems:purge'
            ? deletedPurge(fx, args, force)
            : null
      for (const sub of subs.filter((x) => x.open)) answer(sub)
      return value
    }
    if (!holding) {
      try {
        return Promise.resolve(run())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise((resolve, reject) => {
      call.go = () => {
        try {
          resolve(run())
        } catch (error) {
          reject(error)
        }
      }
    })
  })
  store = await import('../../store/planner')
  lib = await import('../../lib/deletedItems')
  await store.initStore()
}

/* The first import of the store and the page compiles them, which takes
   seconds on a loaded machine. Loading them once here waits for that before
   any test starts. */
beforeAll(async () => {
  await import('../../store/planner')
  await import('../../store/usePlannerVersion')
  await import('./DeletedItems')
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = () => {}
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW)
  window.showToast = vi.fn()
  window.dismissToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'visibilityState')
  if (lib) lib.SELECT_MOST.items = 1000
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/** Lets answers and renders land, answering the open reads again after a
    write. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => await vi.advanceTimersByTimeAsync(0))
    if (dirty) {
      dirty = false
      await act(async () => {
        for (const sub of subs.filter((x) => x.open)) answer(sub)
      })
    }
  }
}
async function wait(ms: number) {
  await act(async () => await vi.advanceTimersByTimeAsync(ms))
  await settle()
}

/** Renders the page as Settings does, again when `again`. */
async function open(next?: Snapshot, fixture?: DeletedFixture, again = false) {
  if (!again) await load(next ?? world(), fixture)
  const page = await import('./DeletedItems')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <page.DeletedItemsPage />
      </TooltipProvider>,
    ),
  )
  await settle()
}
async function leave() {
  await act(async () => root.render(<div />))
  await settle()
}

function find<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
const has = (selector: string) => document.querySelector(selector) !== null
const text = (selector: string) => find(selector).textContent ?? ''
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const lineKeys = () => all('[data-line]').map((el) => el.dataset.line)
const button = (label: string) => {
  const match = all('button').find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`Missing button ${label}`)
  return match
}
async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => element.click())
  await settle()
}
async function type(selector: string, value: string) {
  const input = find<HTMLInputElement>(selector)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await wait(300)
}
async function press(element: Element, name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  await act(async () => element.dispatchEvent(event))
  await settle()
}
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}
/** The open page reads, by name, with their arguments. */
const pageReads = () => subs.filter((s) => s.open && s.name === 'deletedItems:page')
const openNames = () => [...new Set(subs.filter((s) => s.open).map((s) => s.name))].sort()
const restores = () => calls.filter((c) => c.name === 'deletedItems:restore')
const toasts = () => (window.showToast as ReturnType<typeof vi.fn>).mock.calls.map(([t]) => t)
/** Lets held write `call` go, and the page take its answer. */
async function release(call: Call | undefined) {
  if (!call?.go) throw new Error('no held write')
  await act(async () => call.go?.())
  await settle()
}
/** Makes `value` the page's pick in Projects: `all:<org>` for All
    projects of an organization, or a project id, then closes the picker. */
async function choose(value: string) {
  await click(find('[data-deleted-scope]'))
  if (value.startsWith('all:')) await click(find(`[data-project-pick-all="${value.slice(4)}"]`))
  else {
    if (value !== LUMA && !has(`[data-project-children="${LUMA}"]`))
      await click(find(`[data-project-expand="${LUMA}"]`))
    await click(find(`[data-project-pick="${value}"]`))
  }
  const field = document.querySelector('[data-project-picker-search]')
  if (field) await press(field, 'Escape')
}

const PROJECT_ITEM = () => `deleted-${FW}`
const taskItem = (num: number) => {
  const issue = snap.issues.find((t) => t.num === num)
  if (!issue) throw new Error(`no task ${num}`)
  return `deleted-${issue.id}`
}

describe('what the page reads', () => {
  it('opens on deleted projects and the roles, reading no task, list or match', async () => {
    await open()
    expect(openNames()).toEqual(['deletedItems:page', 'deletedItems:roles'])
    expect(pageReads()[0].args).toEqual({})
    expect(subs.some((s) => /list|matches/.test(s.name))).toBe(false)
    expect(lineKeys()).toEqual([PROJECT_ITEM()])
    expect(text('[data-deleted-note="scope"]')).toBe('Deleted tasks show once you choose projects.')
    expect(text('.settings-page-title')).toContain(
      'Tasks and projects deleted in your organization. Their files count toward its storage until they are deleted for good.',
    )
    // nothing but its row says the item holds tasks
    expect(text(`[data-deleted-row="${PROJECT_ITEM()}"]`)).toContain('and its 2 tasks')
  })

  it('says there are no deleted projects, never that nothing is deleted, without a scope', async () => {
    const next = world()
    await open(next, deletedFixtureOf(next, { tasks: 3, projectItem: false }))
    expect(lineKeys()).toEqual([])
    expect(text('[data-deleted-page-end]')).toBe(
      'No deleted projects. Choose projects to see deleted tasks.',
    )
    expect(document.body.textContent).not.toContain('No deleted items.')
  })

  it('says deleted tasks need projects, never that no project is deleted, for Tasks without a scope', async () => {
    await open()
    await click(button('Tasks'))
    expect(pageReads()[0].args).toEqual({ kind: 'task' })
    expect(lineKeys()).toEqual([])
    expect(text('[data-deleted-page-end]')).toBe('Deleted tasks show once you choose projects.')
    expect(document.body.textContent).not.toContain('No deleted projects')
    // a filter that leaves the deleted project out says it was the filter
    await click(button('All'))
    await click(find('[data-deleted-by]'))
    await click(find(`[data-deleted-person="${DANIEL}"]`))
    expect(pageReads()[0].args).toEqual({ deleted_by: DANIEL })
    expect(lineKeys()).toEqual([])
    expect(text('[data-deleted-page-end]')).toBe(
      'No deleted projects match the filters. Choose projects to see deleted tasks.',
    )
  })

  it('reads the task entries of a pick from its first page, and drops the pick with its chip', async () => {
    await open(world({ tasks: 3 }))
    await choose(LUMA)
    expect(pageReads().map((s) => s.args)).toEqual([
      { scope: { org_id: ORG, project_ids: [LUMA] } },
    ])
    expect(lineKeys()).toEqual([PROJECT_ITEM(), taskItem(10), taskItem(11), taskItem(12)])
    expect(has('[data-deleted-note="scope"]')).toBe(false)
    expect(all('[data-deleted-pick]').map((el) => el.dataset.deletedPick)).toEqual([LUMA])
    await click(find(`[data-deleted-pick="${LUMA}"]`))
    expect(pageReads().map((s) => s.args)).toEqual([{}])
    expect(has('[data-deleted-picks]')).toBe(false)
  })

  it('pages with Next and Previous, focus on the first row, and counts the page', async () => {
    await open(world({ tasks: 30 }))
    await choose(`all:${ORG}`)
    expect(lineKeys()).toHaveLength(25)
    expect(text('[data-deleted-count]')).toBe('25 items on this page')
    // a press focuses the button, as a browser does
    find('[data-deleted-page-next]').focus()
    await click(find('[data-deleted-page-next]'))
    expect(lineKeys()).toHaveLength(6)
    expect(pageReads()[0].args.cursor).toBeTypeOf('string')
    expect(document.activeElement?.closest('[data-line]')?.getAttribute('data-line')).toBe(
      lineKeys()[0],
    )
    await click(find('[data-deleted-page-previous]'))
    expect(lineKeys()[0]).toBe(PROJECT_ITEM())
    expect(text('[data-deleted-page-end]')).not.toContain('No more')
  })

  it('says a stopped page goes on with Next, and never that it ended', async () => {
    await load(world({ tasks: 3 }))
    force.stopped = 2
    await open(undefined, undefined, true)
    await choose(`all:${ORG}`)
    expect(lineKeys()).toHaveLength(2)
    expect(text('[data-deleted-page-end]')).toContain(
      'Qivo checked part of Deleted items. Next continues.',
    )
    expect(text('[data-deleted-page-end]')).not.toMatch(/No deleted|No more/)
  })

  it('holds a scope too wide to list, and a part Qivo could not check, with no empty line', async () => {
    await load(world())
    force.tooWide = true
    await open(undefined, undefined, true)
    await choose(`all:${ORG}`)
    expect(lineKeys()).toEqual([])
    expect(text('[data-deleted-page-end]')).toBe(
      "Qivo can't list the deleted items of these projects together. Choose fewer projects.",
    )
    expect(has('[data-deleted-page-end] [data-page-retry]')).toBe(false)
    force.tooWide = false
    force.missing = 'reads'
    fx.items = []
    await type('[data-deleted-search]', 'nothing')
    expect(text('[data-deleted-page-end]')).toContain(
      "Qivo couldn't check the deleted items here. Choose fewer projects.",
    )
    expect(has('[data-deleted-page-end] [data-page-retry]')).toBe(true)
  })

  it('says both missing notes and the older rows as standing notes', async () => {
    await load(world())
    force.missing = 'reads'
    force.legacy = true
    await open(undefined, undefined, true)
    await choose(`all:${ORG}`)
    expect(all('[data-deleted-note]').map((el) => el.dataset.deletedNote)).toEqual([
      'reads',
      'legacy',
    ])
    force.missing = 'matches'
    await type('[data-deleted-search]', 'route')
    expect(text('[data-deleted-note="matches"]')).toBe('Some matching tasks might not be listed.')
    expect(has('[data-deleted-items] [role="alert"]')).toBe(false)
  })

  it('stops its reads while the tab is hidden, and refreshes on return', async () => {
    await open()
    await setVisibility('hidden')
    expect(subs.filter((s) => s.open)).toEqual([])
    // what it showed stays, and so does the subtitle
    expect(lineKeys()).toEqual([PROJECT_ITEM()])
    expect(text('.settings-page-title')).toContain('your organization')
    holdReads = () => true
    await setVisibility('visible')
    expect(openNames()).toEqual(['deletedItems:page', 'deletedItems:roles'])
    expect(find('[data-deleted-state]').dataset.deletedState).toBe('refreshing')
    expect(text('.settings-page-title')).toContain('your organization')
    holdReads = null
    await act(async () => {
      for (const s of subs.filter((x) => x.open)) answer(s)
    })
    await settle()
    expect(find('[data-deleted-state]').dataset.deletedState).toBe('ok')
  })

  it('ends every read when the page is left', async () => {
    await open()
    await leave()
    expect(subs.filter((s) => s.open)).toEqual([])
  })

  it('fails the page when the roles cannot be read, and tries both again', async () => {
    await load(world())
    force.fail = ['roles']
    await open(undefined, undefined, true)
    expect(text('[data-deleted-items] [role="alert"]')).toContain("Couldn't load deleted items.")
    expect(lineKeys()).toEqual([])
    force.fail = []
    await click(button('Try again'))
    expect(lineKeys()).toEqual([PROJECT_ITEM()])
  })

  it('reads nothing of the workspace’s roster, projects or admin rule', async () => {
    const source = readFileSync('src/panels/settings/DeletedItems.tsx', 'utf8')
    for (const read of [
      'P.isAdmin',
      'P.users',
      'P.projects',
      'P.archivedProjects',
      'P.levelOn',
      'deletedItems.list',
      'deletedItems.matches',
    ])
      expect(source, read).not.toContain(read)
    await load(world())
    const isAdmin = vi.spyOn(store.P, 'isAdmin')
    await open(undefined, undefined, true)
    await choose(`all:${ORG}`)
    expect(isAdmin).not.toHaveBeenCalled()
  })
})

describe('the filters', () => {
  it('sends the search once typing rests, says its limit and clears on Escape first', async () => {
    await open()
    await choose(`all:${ORG}`)
    await type('[data-deleted-search]', 'antenna')
    expect(pageReads()[0].args).toEqual({ scope: { org_id: ORG, all: true }, search: 'antenna' })
    expect(lineKeys()).toEqual([taskItem(11)])
    await type('[data-deleted-search]', 'x'.repeat(201))
    // past the limit nothing new goes out
    expect(pageReads()[0].args.search).toBe('antenna')
    expect(text('[data-deleted-page-end]')).toContain('200 characters')
    await press(find('[data-deleted-search]'), 'Escape')
    await wait(300)
    expect(find<HTMLInputElement>('[data-deleted-search]').value).toBe('')
    expect(pageReads()[0].args).toEqual({ scope: { org_id: ORG, all: true } })
  })

  it('shows a task found inside a deleted project as its own line, which acts on the project', async () => {
    await open()
    await choose(LUMA)
    await type('[data-deleted-search]', 'sites')
    expect(lineKeys()).toEqual([`${PROJECT_ITEM()}:QN-2`])
    expect(text('[data-deleted-hit="QN-2"]')).toContain('Book test sites in Umeå')
    expect(text('[data-deleted-hit="QN-2"]')).toContain('deleted with the project')
    await click(find('[data-deleted-hit="QN-2"] [data-restore]'))
    expect(text('[role="dialog"]')).toContain('QN-2 is in a deleted project')
    await click(button('Restore Firmware and QN-2'))
    expect(restores().map((c) => c.args.ids)).toEqual([[PROJECT_ITEM()]])
    expect(toasts()).toContain('Restored “Firmware”.')
  })

  it('asks the server for one kind, and keeps Projects off while Assigned to names someone', async () => {
    await open()
    await choose(`all:${ORG}`)
    await click(button('Tasks'))
    expect(pageReads()[0].args).toEqual({ scope: { org_id: ORG, all: true }, kind: 'task' })
    expect(lineKeys()).not.toContain(PROJECT_ITEM())
    await click(button('Projects'))
    expect(text('[data-deleted-assignee]')).toBe('Assigned to anyone')
    expect(find('[data-deleted-assignee]').dataset.disabledWhy).toBe('Projects have no assignee.')
    await click(button('All'))
    await click(find('[data-deleted-assignee]'))
    await click(find(`[data-deleted-person="${DANIEL}"]`))
    expect(pageReads()[0].args).toEqual({ scope: { org_id: ORG, all: true }, assignee: DANIEL })
    expect(button('Projects').hasAttribute('disabled')).toBe(true)
  })

  it('offers Deleted by with You and Someone first, no unclaimed seat, and a way for a person only', async () => {
    await open()
    await click(find('[data-deleted-by]'))
    expect(all('[data-deleted-people-fixed]').map((el) => el.textContent)).toEqual([
      'Deleted by anyone',
      'You',
      'Someone no longer in the organization',
    ])
    const people = all('[data-deleted-person]').map((el) => el.dataset.deletedPerson)
    expect(people).toContain(DANIEL)
    expect(people).toContain(RELAY)
    // Mira never joined, and the person is You
    expect(people).not.toContain(MIRA)
    expect(people).not.toContain(ME)
    expect(peopleAsked).toEqual([{ org_id: ORG }])
    await click(find(`[data-deleted-person="${DANIEL}"]`))
    expect(pageReads()[0].args).toEqual({ deleted_by: DANIEL })
    expect(text('[data-deleted-by]')).toBe('Deleted by Daniel Berg')
    await act(async () => {
      const select = find<HTMLSelectElement>('[data-deleted-by-way]')
      select.value = 'mcp_tokens'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(pageReads()[0].args).toEqual({ deleted_by: DANIEL, via: 'mcp_tokens' })
    expect(text('[data-deleted-by]')).toBe('Deleted by Daniel Berg via a personal token')
    // an agent deletes through its keys alone
    await click(find('[data-deleted-by]'))
    await click(find(`[data-deleted-person="${RELAY}"]`))
    expect(has('[data-deleted-by-way]')).toBe(false)
    expect(pageReads()[0].args).toEqual({ deleted_by: RELAY })
    await click(find('[data-deleted-by]'))
    await click(find('[data-deleted-people-fixed="someone"]'))
    // someone never goes with a person
    expect(pageReads()[0].args).toEqual({ someone: true })
    await click(find('[data-deleted-by]'))
    await click(find('[data-deleted-people-fixed="you"]'))
    expect(pageReads()[0].args).toEqual({ deleted_by: ME })
    expect(text('[data-deleted-by]')).toBe('Deleted by you')
  })

  it('reads the people only while a popover is open, and says a stopped batch as such', async () => {
    await load(world())
    force.peopleStopped = 2
    await open(undefined, undefined, true)
    expect(peopleAsked).toEqual([])
    await click(find('[data-deleted-by]'))
    expect(peopleAsked).toHaveLength(1)
    expect(text('[data-deleted-people]')).toContain('Showing the people found so far.')
    expect(text('[data-deleted-people]')).not.toContain('No one')
    await press(find('[data-deleted-people-search]'), 'Escape')
    expect(has('[data-deleted-people]')).toBe(false)
    await wait(1000)
    expect(peopleAsked).toHaveLength(1)
  })

  it('needs a scope for Deleted by in a login of two seats, and for Assigned to always', async () => {
    await open(world({ partner: true }))
    expect(find('[data-deleted-by]').dataset.disabledWhy).toBe(
      'Choose projects to filter by who deleted.',
    )
    expect(find('[data-deleted-assignee]').dataset.disabledWhy).toBe(
      'Choose projects to filter by assignee.',
    )
    await click(find('[data-deleted-by]'))
    expect(has('[data-deleted-people]')).toBe(false)
    expect(peopleAsked).toEqual([])
    await choose(`all:${ORG}`)
    expect(find('[data-deleted-by]').dataset.disabledWhy).toBeUndefined()
    await click(find('[data-deleted-by]'))
    await click(find(`[data-deleted-person="${DANIEL}"]`))
    await click(find('[data-deleted-assignee]'))
    await click(find(`[data-deleted-person="${DANIEL}"]`))
    expect(pageReads()[0].args).toEqual({
      scope: { org_id: ORG, all: true },
      deleted_by: DANIEL,
      assignee: DANIEL,
    })
    // clearing the scope clears what needs it
    await click(find('[data-deleted-scope]'))
    await click(find(`[data-project-pick-all="${ORG}"]`))
    await press(find('[data-project-picker-search]'), 'Escape')
    expect(pageReads()[0].args).toEqual({})
    expect(text('[data-deleted-by]')).toBe('Deleted by anyone')
    expect(text('[data-deleted-assignee]')).toBe('Assigned to anyone')
  })

  it('drops a Deleted by choice once the roles take Deleted by away, and keeps it while they read again', async () => {
    await load(world({ role: 'user' }))
    fx.seats[0].role = 'lead'
    await open(undefined, undefined, true)
    await click(find('[data-deleted-by]'))
    await click(find(`[data-deleted-person="${DANIEL}"]`))
    expect(pageReads()[0].args).toEqual({ deleted_by: DANIEL })
    // a hidden tab, then roles that wait and fail on return, keep the choice
    await setVisibility('hidden')
    holdReads = (sub) => sub.name === 'deletedItems:roles'
    await setVisibility('visible')
    const roles = () => subs.filter((s) => s.open && s.name === 'deletedItems:roles')
    expect(text('[data-deleted-by]')).toBe('Deleted by Daniel Berg')
    await act(async () => roles()[0].fail(new Error('offline')))
    await settle()
    expect(text('[data-deleted-by]')).toBe('Deleted by Daniel Berg')
    expect(pageReads()[0].args).toEqual({ deleted_by: DANIEL })
    // the person's last lead role ends
    holdReads = null
    fx.seats[0].role = 'user'
    await act(async () => {
      for (const sub of roles()) answer(sub)
    })
    await settle()
    expect(has('[data-deleted-by]')).toBe(false)
    expect(pageReads().map((s) => s.args)).toEqual([{}])
  })

  it('names each row’s organization when a page holds two', async () => {
    await open(world({ partner: true }))
    expect(lineKeys()).toHaveLength(2)
    // the server orders the page, newest first across both
    expect(all('[data-row-org]').map((el) => el.textContent)).toEqual([
      'Partner Co',
      'Testbed Labs',
    ])
    expect(has('[data-org-group]')).toBe(false)
  })

  it('shows a row whose task the admin cannot read without its title, and with its counts', async () => {
    await load(world({ tasks: 1 }))
    force.hidden = true
    const task = fx.items.find((i) => i.row.kind === 'task')
    if (!task) throw new Error('no task item')
    task.row = { ...task.row, counts: { ...task.row.counts, subtasks: 1 } }
    await open(undefined, undefined, true)
    await choose(`all:${ORG}`)
    const row = find(`[data-deleted-row="${taskItem(10)}"]`)
    expect(row.hasAttribute('data-hidden-row')).toBe(true)
    expect(row.textContent).toContain('QN-10')
    expect(row.textContent).toContain('Title not shown')
    expect(row.textContent).toContain('and 1 subtask')
    expect(row.textContent).not.toContain('Route board 10')
    expect(row.textContent).toContain(
      "You can't open this task's project, so its title isn't shown.",
    )
    expect(row.querySelector('[data-restore]')).not.toBeNull()
  })
})

describe('the selection', () => {
  it('keeps the rows of earlier pages, counts them, and clears on a filter change', async () => {
    await open(world({ tasks: 30 }))
    await choose(`all:${ORG}`)
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('25 selected')
    await click(find('[data-deleted-page-next]'))
    expect(text('[data-deleted-count]')).toBe('25 selected, 25 on other pages')
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('31 selected, 25 on other pages')
    expect(button('Restore 31 selected')).toBeDefined()
    await click(button('Tasks'))
    expect(has('[data-deleted-count]') && text('[data-deleted-count]')).not.toContain('selected')
  })

  it('selects up to the cap and says so', async () => {
    await open(world({ tasks: 30 }))
    lib.SELECT_MOST.items = 30
    await choose(`all:${ORG}`)
    await click(find('[data-select-all]'))
    await click(find('[data-deleted-page-next]'))
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('30 selected, 25 on other pages')
    expect(text('[data-deleted-cap]')).toBe('You can select up to 30 items at a time.')
    const free = all('[data-line] [data-select]').filter(
      (el) => el.getAttribute('aria-checked') !== 'true',
    )
    expect(free.length).toBeGreaterThan(0)
    for (const box of free) expect(box.hasAttribute('disabled')).toBe(true)
  })
})

describe('restoring', () => {
  it('restores one row at once and moves focus to the next Restore', async () => {
    await open(world({ tasks: 3 }))
    await choose(`all:${ORG}`)
    const row = find(`[data-deleted-row="${taskItem(10)}"] [data-restore]`)
    row.focus()
    await click(row)
    expect(restores().map((c) => c.args)).toEqual([{ org_id: ORG, ids: [taskItem(10)] }])
    expect(toasts()).toContain('Restored QN-10.')
    expect(lineKeys()).not.toContain(taskItem(10))
    expect(document.activeElement?.closest('[data-line]')?.getAttribute('data-line')).toBe(
      taskItem(11),
    )
  })

  it('asks before several, and keeps the window of one round without a keep-open line', async () => {
    await open(world({ tasks: 3 }))
    await choose(`all:${ORG}`)
    await click(find('[data-select-all]'))
    await click(button('Restore 4 selected'))
    expect(text('[data-bulk-restore]')).toContain('They come back where they were')
    expect(has('[data-keep-open]')).toBe(false)
    await click(button('Restore 4 items'))
    expect(restores()).toHaveLength(1)
    expect(restores()[0].args.bulk).toBe(true)
    expect(has('[data-bulk-restore]')).toBe(false)
    expect(toasts()).toContain('Restored 4 items.')
  })

  it('says to keep Qivo open past one round, closes at the press and shows its progress', async () => {
    await open(world({ tasks: 60 }))
    await choose(`all:${ORG}`)
    await click(find('[data-select-all]'))
    await click(find('[data-deleted-page-next]'))
    await click(find('[data-select-all]'))
    await click(find('[data-deleted-page-next]'))
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('61 selected, 50 on other pages')
    holding = true
    await click(button('Restore 61 selected'))
    expect(text('[data-keep-open]')).toBe(
      'Restoring them runs in steps. Keep Qivo open until it finishes. Closing or reloading Qivo stops it, and the steps already done stay done.',
    )
    await click(button('Restore 61 items'))
    // the window closed at once and the store runs it
    expect(has('[data-bulk-restore]')).toBe(false)
    expect(restores().map((c) => c.args.ids.length)).toEqual([25])
    expect(text('[data-deleted-progress]')).toBe('Restoring 61 items, 0 done')
    for (const el of all('[data-restore]')) expect(el.hasAttribute('disabled')).toBe(true)
    await release(restores()[0])
    expect(text('[data-deleted-progress]')).toBe('Restoring 61 items, 25 done')
    // leaving and coming back shows the action as it runs
    await leave()
    await open(undefined, undefined, true)
    expect(text('[data-deleted-progress]')).toBe('Restoring 61 items, 25 done')
    await release(restores()[1])
    await release(restores()[2])
    expect(restores().map((c) => c.args.ids.length)).toEqual([25, 25, 11])
    expect(text('[data-deleted-progress]')).toBe('')
    expect(toasts()).toContain('Restored 61 items.')
  })

  it('keeps the window and the selection when the pause refuses a long restore, and says why', async () => {
    await open(world({ tasks: 30 }))
    await choose(`all:${ORG}`)
    await click(find('[data-select-all]'))
    await click(find('[data-deleted-page-next]'))
    await click(find('[data-select-all]'))
    expect(text('[data-deleted-count]')).toBe('31 selected, 25 on other pages')
    await click(button('Restore 31 selected'))
    expect(has('[data-keep-open]')).toBe(true)
    // Qivo goes offline while the window is open
    const sync = await import('../../lib/syncStatus')
    sync.syncStatus.setSocket({ connected: true, everConnected: true })
    sync.syncStatus.setSocket({ connected: false, everConnected: true })
    await wait(sync.OFFLINE_DELAY_MS)
    await click(button('Restore 31 items'))
    expect(restores()).toEqual([])
    const errors = (window.showToast as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, tone]) => tone === 'error')
      .map(([t]) => t)
    expect(errors).toEqual([store.OFFLINE_TEXT])
    expect(has('[data-bulk-restore]')).toBe(true)
    expect(text('[data-deleted-count]')).toBe('31 selected, 25 on other pages')
    expect(text('[data-deleted-progress]')).toBe('')
  })

  it('opens the whole item window for a single item selected through its hit alone', async () => {
    await open()
    await choose(LUMA)
    await type('[data-deleted-search]', 'sites')
    await click(find(`[data-line="${PROJECT_ITEM()}:QN-2"] [data-select]`))
    await click(button('Restore 1 selected'))
    expect(text('[role="dialog"]')).toContain('QN-2 is in a deleted project')
    expect(restores()).toEqual([])
  })

  it('restores an item deleted before its project with that project, and the store sends it once it is back', async () => {
    const next = world({ tasks: 1 })
    const fixture = deletedFixtureOf(next, { tasks: 1, at: NOW.toISOString() })
    const task = fixture.items.find((i) => i.row.kind === 'task')
    if (!task) throw new Error('no task item')
    task.row = {
      ...task.row,
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: `deleted-${FW}` },
    }
    // the page that shows the task holds no project item
    fixture.items = fixture.items.filter((i) => i.row.kind === 'task')
    const held = deletedFixtureOf(next, { tasks: 0, at: NOW.toISOString() }).items
    await load(next, fixture)
    force.deferred = true
    await open(undefined, undefined, true)
    await choose(EL)
    fx.items.push(...held)
    await click(find(`[data-deleted-row="${task.row.id}"] [data-restore]`))
    // the window reads the project item it waits for
    expect(subs.filter((s) => s.open && s.name === 'deletedItems:item').map((s) => s.args)).toEqual(
      [{ id: `deleted-${FW}` }],
    )
    await click(button('Restore Firmware and QN-10'))
    expect(restores().map((c) => c.args.ids)).toEqual([
      [`deleted-${FW}`, task.row.id],
      [task.row.id],
    ])
    expect(toasts()).toContain('Restored “Firmware”. QN-10 follows once its project is back.')
    expect(toasts().some((t) => /Restored 2/.test(String(t)))).toBe(false)
  })

  it('says a failed read of the project an item waits for with Try again, and one it cannot see, apart from loading', async () => {
    const next = world({ tasks: 1 })
    const fixture = deletedFixtureOf(next, { tasks: 1, at: NOW.toISOString() })
    const task = fixture.items.find((i) => i.row.kind === 'task')
    if (!task) throw new Error('no task item')
    task.row = {
      ...task.row,
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: `deleted-${FW}` },
    }
    // the page that shows the task holds no project item
    const projects = fixture.items.filter((i) => i.row.kind === 'project')
    fixture.items = fixture.items.filter((i) => i.row.kind === 'task')
    await load(next, fixture)
    holdReads = (sub) => sub.name === 'deletedItems:item'
    await open(undefined, undefined, true)
    await choose(EL)
    await click(find(`[data-deleted-row="${task.row.id}"] [data-restore]`))
    const dialog = () => find('[role="dialog"]')
    const restore = () => button('Restore the project and QN-10')
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe('Loading its project…')
    expect(restore().hasAttribute('disabled')).toBe(true)
    const reads = () => subs.filter((s) => s.open && s.name === 'deletedItems:item')
    await act(async () => reads()[0].fail(new Error('offline')))
    await settle()
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load its project.",
    )
    expect(restore().hasAttribute('disabled')).toBe(true)
    // Try again reads it afresh, and the person cannot see it now
    holdReads = null
    await click(find('[data-whole-retry]'))
    expect(text('[data-whole-gone]')).toBe("Qivo can't find its project in Deleted items now.")
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
    expect(all('[role="dialog"] button').map((b) => b.textContent)).not.toContain(
      'Restore the project and QN-10',
    )
    expect(button('Close')).toBeDefined()
    // once the project item answers, Restore names it and may be pressed
    fx.items.push(...projects)
    await act(async () => {
      for (const sub of reads()) answer(sub)
    })
    await settle()
    expect(has('[data-whole-gone]')).toBe(false)
    expect(button('Restore Firmware and QN-10').hasAttribute('disabled')).toBe(false)
  })

  it('restores a subtask search found in a task deleted before its project, sending that project first', async () => {
    const next = world({ tasks: 1 })
    const fixture = deletedFixtureOf(next, { tasks: 1, at: NOW.toISOString() })
    const task = fixture.items.find((i) => i.row.kind === 'task')
    if (!task) throw new Error('no task item')
    // QN-10 was deleted with its subtask QN-99, then their project Firmware
    task.row = {
      ...task.row,
      path: ['Luma Sensor', 'Firmware'],
      counts: { ...task.row.counts, subtasks: 1 },
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: `deleted-${FW}` },
    }
    task.scope = [FW]
    task.tasks.push({
      num: 99,
      title: 'Seal the enclosure gasket',
      description: '',
      project_id: FW,
      archived: false,
      path: ['Luma Sensor', 'Firmware'],
    })
    await load(next, fixture)
    force.deferred = true
    await open(undefined, undefined, true)
    await choose(LUMA)
    await type('[data-deleted-search]', 'gasket')
    const hit = `${task.row.id}:QN-99`
    expect(lineKeys()).toEqual([hit])
    await click(find(`[data-line="${hit}"] [data-restore]`))
    // the page holds no Firmware row, so the window reads it
    expect(subs.filter((s) => s.open && s.name === 'deletedItems:item').map((s) => s.args)).toEqual(
      [{ id: `deleted-${FW}` }],
    )
    expect(text('[role="dialog"]')).toContain('QN-99 is a subtask of a deleted task')
    expect(text('[data-task-first]')).toContain(
      'QN-10 was deleted before its project Firmware, which is in Deleted items too.',
    )
    expect(text('[data-task-first]')).toContain(
      'QN-10 and its subtasks follow once the project is back.',
    )
    await click(button('Restore Firmware, QN-10 and QN-99'))
    expect(restores().map((c) => c.args.ids)).toEqual([
      [`deleted-${FW}`, task.row.id],
      [task.row.id],
    ])
    expect(toasts()).toContain('Restored “Firmware”. QN-10 follows once its project is back.')
  })

  it('keeps sending a deferred item after the page is left', async () => {
    const next = world({ tasks: 1 })
    const fixture = deletedFixtureOf(next, { tasks: 1, at: NOW.toISOString() })
    const task = fixture.items.find((i) => i.row.kind === 'task')
    if (!task) throw new Error('no task item')
    task.row = {
      ...task.row,
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: `deleted-${FW}` },
    }
    await load(next, fixture)
    force.deferred = true
    holding = true
    await open(undefined, undefined, true)
    await choose(LUMA)
    await click(find(`[data-deleted-row="${task.row.id}"] [data-restore]`))
    await click(button('Restore Firmware and QN-10'))
    await release(restores()[0])
    await leave()
    // the watch lives in the store, so the item goes once its row says so
    expect(restores().map((c) => c.args.ids)).toEqual([
      [`deleted-${FW}`, task.row.id],
      [task.row.id],
    ])
  })
})

describe('Delete now', () => {
  it('counts what a project takes along before Delete for good, and reads nothing for a task', async () => {
    await load(world({ tasks: 1 }))
    holdReads = (sub) => sub.name === 'deletedItems:purgeSummary'
    await open(undefined, undefined, true)
    await choose(`all:${ORG}`)
    await click(find(`[data-deleted-row="${PROJECT_ITEM()}"] [data-row-menu]`))
    await click(find('[data-delete-now]'))
    expect(text('[data-purge-along]')).toBe(' Counting the items deleted from the project earlier…')
    expect(button('Delete for good').hasAttribute('disabled')).toBe(true)
    const count = subs.find((s) => s.name === 'deletedItems:purgeSummary' && s.open)
    await act(async () => count?.next({ along: 3, exact: true }))
    await settle()
    expect(text('[data-purge-along]')).toBe(
      ' It also deletes 3 items deleted from the project earlier.',
    )
    await act(async () => count?.next({ along: 1000, exact: false }))
    await settle()
    expect(text('[data-purge-along]')).toBe(
      ' It also deletes at least 1,000 items deleted from the project earlier.',
    )
    await act(async () => count?.fail(new Error('offline')))
    await settle()
    expect(text('[data-purge-along]')).toContain("Qivo couldn't count the items")
    expect(button('Delete for good').hasAttribute('disabled')).toBe(false)
    await click(button('Cancel'))
    await click(find(`[data-deleted-row="${taskItem(10)}"] [data-row-menu]`))
    await click(find('[data-delete-now]'))
    expect(subs.filter((s) => s.open && s.name === 'deletedItems:purgeSummary')).toEqual([])
    await click(button('Delete for good'))
    expect(calls.filter((c) => c.name === 'deletedItems:purge').map((c) => c.args)).toEqual([
      { org_id: ORG, ids: [taskItem(10)] },
    ])
    expect(toasts()).toContain('Deleted QN-10 for good.')
  })

  it('takes an item deleted for good out of the selection, so Restore offers only what is left', async () => {
    await open(world({ tasks: 3 }))
    await choose(`all:${ORG}`)
    await click(find(`[data-deleted-row="${taskItem(10)}"] [data-select]`))
    await click(find(`[data-deleted-row="${taskItem(11)}"] [data-select]`))
    expect(text('[data-deleted-count]')).toBe('2 selected')
    await click(find(`[data-deleted-row="${taskItem(10)}"] [data-row-menu]`))
    await click(find('[data-delete-now]'))
    await click(button('Delete for good'))
    expect(toasts()).toContain('Deleted QN-10 for good.')
    expect(has(`[data-deleted-row="${taskItem(10)}"]`)).toBe(false)
    expect(text('[data-deleted-count]')).toBe('1 selected')
    await click(button('Restore 1 selected'))
    expect(restores().map((c) => c.args)).toEqual([{ org_id: ORG, ids: [taskItem(11)] }])
  })

  it('says Deleting… on the row while Delete now runs, and Restoring… only while a restore does', async () => {
    await open(world({ tasks: 2 }))
    await choose(`all:${ORG}`)
    holding = true
    const label = (num: number) => text(`[data-deleted-row="${taskItem(num)}"] [data-restore]`)
    await click(find(`[data-deleted-row="${taskItem(10)}"] [data-row-menu]`))
    await click(find('[data-delete-now]'))
    await click(button('Delete for good'))
    expect(label(10)).toBe('Deleting…')
    await release(calls.find((c) => c.name === 'deletedItems:purge'))
    expect(has(`[data-deleted-row="${taskItem(10)}"]`)).toBe(false)
    await click(find(`[data-deleted-row="${taskItem(11)}"] [data-restore]`))
    expect(label(11)).toBe('Restoring…')
    await release(restores()[0])
  })
})
