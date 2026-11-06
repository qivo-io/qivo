// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELD_CHANGED } from '../../convex/lib/fieldPrints'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  answerMilestones,
  type ForcedMilestones,
  isMilestoneRead,
  MILESTONE_TOO_LARGE,
  MILESTONES_UNCHECKED,
} from '../store/milestoneStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Milestones window opened on a milestone (panels/Modals.tsx
   MilestoneModal with init.id), on the real store: it reads that milestone
   from the server (milestones.get) through the milestone stand-in
   (store/milestoneStandIn.setup.ts), shows nothing of a project before the
   answer names it, opens the editor only where the answer says the person
   may write, and says when the milestone loads, cannot be opened, fails,
   or goes away. The first case opens it from an Overview row in App; the
   others render the window alone, as App renders it. */

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

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let snap: Snapshot
/* the server's own copy, which the milestone read answers from */
let server: Snapshot
let force: ForcedMilestones
let subs: {
  name: string
  args: Record<string, unknown>
  next: (v: unknown) => void
  fail: (e: unknown) => void
  stopped: boolean
}[]
let modals: typeof import('./Modals')
let version: typeof import('../store/usePlannerVersion')

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.getAnimations = () => []
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
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  force = {}
  subs = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  setHidden(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The Monday `weeks` weeks after this week's, as a milestone's week. */
function mondayIn(weeks: number) {
  const day = new Date()
  day.setDate(day.getDate() + 7 * weeks - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** Plan, a top-level project with sub-project Work, milestones Alpha and
    Beta, and `edit`'s changes. I am the organization's admin unless `edit`
    says otherwise. `inWorkspace` false leaves the milestones out of the
    projects part, so only the window's read holds them. */
function fixture(edit: (s: Snapshot) => void = () => {}, inWorkspace = true) {
  snap = plannerFixture()
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan' },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
  ]
  snap.milestones.push(
    { id: 'alpha', project_id: 'plan', name: 'Alpha', week: mondayIn(1), created_at: AT },
    { id: 'beta', project_id: 'plan', name: 'Beta', week: mondayIn(3), created_at: AT },
  )
  edit(snap)
  server = structuredClone(snap)
  if (!inWorkspace) snap.milestones = []
}

/** Starts the store over the fixture. */
async function start() {
  vi.resetModules()
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    else if (isMilestoneRead(name)) {
      const sub = { name, args, next, fail, stopped: false }
      subs.push(sub)
      answerMilestones(server, name, args, next, fail, force)
      return () => {
        sub.stopped = true
      }
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('../store/planner')
  await store.initStore()
  modals = await import('./Modals')
  version = await import('../store/usePlannerVersion')
  return store
}

/* Re-renders on every store change, as App does. */
function Live({ page }: { page: () => React.ReactNode }) {
  version.usePlannerVersion()
  return page()
}

/** Renders the window opened on milestone `id`. */
async function open(id = 'alpha') {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live page={() => <modals.MilestoneModal init={{ id }} onClose={vi.fn()} />} />
      </TooltipProvider>,
    ),
  )
  await settle()
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** Answers the live milestone reads again from the server's copy. */
async function rerun() {
  for (const sub of subs)
    if (!sub.stopped) answerMilestones(server, sub.name, sub.args, sub.next, sub.fail, force)
  await settle()
}

/** Hides or shows the page, as a minimized window or another tab does. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const line = () => q('[data-milestone-open]')
const windowState = () => q('[data-milestone-window]')?.getAttribute('data-milestone-open-state')
const nameBox = () =>
  q('[data-milestone-editor] input[aria-label="Name"]') as HTMLInputElement | null
const liveGets = () => subs.filter((s) => s.name === 'milestones:get' && !s.stopped)

describe('opened from an Overview row', { timeout: 30_000 }, () => {
  it('says it is loading at once, then shows the editor from the answer beside the list', async () => {
    fixture((s) => {
      s.projects[0].lead_id = s.profiles[0].id
    })
    force = { get: 'loading' }
    await start()
    const { syncStatus } = await import('../lib/syncStatus')
    syncStatus.setSocket({ connected: true, everConnected: true })
    const { default: App } = await import('../App')
    await act(async () =>
      root.render(
        <TooltipProvider>
          <App />
        </TooltipProvider>,
      ),
    )
    const row = await vi.waitFor(
      () => {
        const found = q('[data-overview-milestone="alpha"]')
        if (!found) throw new Error('missing the Overview row')
        return found
      },
      { timeout: 10_000 },
    )
    await act(async () => row.click())
    await settle()
    expect(line()?.getAttribute('data-milestone-open')).toBe('loading')
    expect(line()?.textContent).toBe('Loading this milestone…')
    expect(q('[data-milestone-new]')).toBeNull()
    expect(q('[data-milestone-row]')).toBeNull()
    expect(q('[data-milestone-editor]')).toBeNull()
    force = {}
    await rerun()
    expect(nameBox()?.value).toBe('Alpha')
    expect(q('[data-milestone-editor="alpha"]')?.textContent).toContain('Week')
    expect(q('[data-milestone-row="beta"]')).not.toBeNull()
    expect(q('[data-milestone-new]')).not.toBeNull()
    expect(windowState()).toBe('ok')
    // the Name box takes focus as the answer arrives
    expect(document.activeElement).toBe(nameBox())
  })
})

describe('the rights the answer gives', () => {
  it.each([
    [
      'a Viewer',
      (s: Snapshot) => {
        s.profiles[0].org_role = 'viewer'
        s.access.push({ project_id: 'plan', profile_id: s.profiles[0].id, level: 'viewer' })
      },
    ],
    [
      'a person who sees Plan only to reach Work',
      (s: Snapshot) => {
        s.profiles[0].org_role = 'user'
        s.access.push({ project_id: 'work', profile_id: s.profiles[0].id, level: 'user' })
      },
    ],
  ])('shows %s the opened milestone as its row, with no Edit and no add row', async (_, edit) => {
    fixture(edit)
    await start()
    await open('alpha')
    const opened = q('[data-milestone-row="alpha"]')
    expect(opened?.hasAttribute('data-milestone-opened')).toBe(true)
    expect(q('[data-milestone-editor]')).toBeNull()
    expect(q('button[aria-label^="Edit"]')).toBeNull()
    expect(q('[data-milestone-new]')).toBeNull()
  })

  it('must fail: opens no editor where the answer says no, whatever the store says', async () => {
    // the store's level says I may write, as the organization's admin
    fixture()
    force = { canWrite: false }
    await start()
    await open('alpha')
    expect(q('[data-milestone-row="alpha"]')).not.toBeNull()
    expect(q('[data-milestone-editor]')).toBeNull()
    expect(q('[data-milestone-new]')).toBeNull()
  })

  it('keeps the typed name read-only once the person may no longer change it', async () => {
    fixture()
    await start()
    await open('alpha')
    const box = nameBox()
    if (!box) throw new Error('no editor')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'Al')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    force = { canWrite: false }
    await rerun()
    expect(nameBox()?.value).toBe('Al')
    expect(nameBox()?.readOnly).toBe(true)
    expect(q('[data-milestone-locked-note]')?.textContent).toBe(
      'You can no longer change this milestone.',
    )
  })
})

describe('a save refused because someone changed the milestone first', () => {
  it("keeps the draft on the server's row, so the next Save sends it against that row", async () => {
    fixture()
    await start()
    const writes: { args: Record<string, unknown>; reject: (e: unknown) => void }[] = []
    network.mutation.mockImplementation((ref, args) =>
      getFunctionName(ref) === 'projects:updateMilestone'
        ? new Promise((_, reject) => writes.push({ args, reject }))
        : Promise.resolve(null),
    )
    await open('alpha')
    // someone renames it, which the window's read shows
    const theirs = server.milestones.find((m) => m.id === 'alpha')
    if (!theirs) throw new Error('no alpha')
    theirs.name = 'Alpha 2'
    await rerun()
    const box = nameBox()
    if (!box) throw new Error('no editor')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'Al')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-milestone-editor] button')].find(
        (b) => b.textContent === 'Save',
      )
    await act(async () => save()?.click())
    await settle()
    expect(writes).toHaveLength(1)
    expect(writes[0].args).toMatchObject({ patch: { name: 'Al' }, expected: { name: 'Alpha' } })
    writes[0].reject(
      new ConvexError({
        code: 'conflict',
        reason: FIELD_CHANGED,
        message: 'the name of the milestone changed since you read it',
        changes: [{ record: 'milestone', id: 'alpha', field: 'name', by: 'someone', at: AT }],
      }),
    )
    await settle()
    expect(nameBox()?.value).toBe('Al')
    await act(async () => save()?.click())
    await settle()
    // the draft goes out against their name, never as already saved
    expect(writes).toHaveLength(2)
    expect(writes[1].args).toMatchObject({
      id: 'alpha',
      patch: { name: 'Al' },
      expected: { name: 'Alpha 2' },
    })
  })
})

describe('a milestone the list does not hold', () => {
  it('shows a past milestone only the read holds as its editor, above the list', async () => {
    fixture((s) => {
      s.milestones[0].week = mondayIn(-6)
    }, false)
    await start()
    await open('alpha')
    expect(nameBox()?.value).toBe('Alpha')
    expect(q('[data-milestone-row="beta"]')).toBeNull()
    expect(q('[data-milestone-window]')?.textContent).toContain('No milestones yet.')
  })
})

describe('a milestone that cannot be shown', () => {
  it.each([
    ['unavailable', { get: 'unavailable' }, "This milestone can't be opened."],
    ['refused', { get: 'refused' }, MILESTONE_TOO_LARGE.slice(1)],
    ['refused', { get: 'unchecked' }, MILESTONES_UNCHECKED.slice(1)],
    ['failed', { get: 'error' }, "Couldn't open this milestone."],
  ] as const)(
    'says %s, with no list and no add row, and stays open',
    async (state, forced, text) => {
      fixture()
      force = forced
      await start()
      await open('alpha')
      expect(line()?.getAttribute('data-milestone-open')).toBe(state)
      expect(line()?.textContent).toContain(text)
      expect(q('[data-milestone-row]')).toBeNull()
      expect(q('[data-milestone-new]')).toBeNull()
      expect(q('[data-milestone-editor]')).toBeNull()
      expect(q('[data-modal-shell]')).not.toBeNull()
      const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
      expect(!!retry).toBe(state === 'failed')
      if (!retry) return
      force = {}
      const before = subs.length
      await act(async () => retry.click())
      await settle()
      expect(subs.length).toBe(before + 1)
      expect(nameBox()?.value).toBe('Alpha')
    },
  )

  it('must fail: shows no project before the server named it', async () => {
    fixture()
    force = { get: 'loading' }
    await start()
    await open('alpha')
    expect(q('[data-modal-shell]')?.textContent).not.toContain('Plan')
    expect(q('[data-milestone-row]')).toBeNull()
  })
})

describe('a failure or refusal after an answer', () => {
  it.each([
    ['failed', { get: 'error' }, "Couldn't load the latest version of this milestone."],
    ['refused', { get: 'refused' }, MILESTONE_TOO_LARGE.slice(1)],
  ] as const)(
    'keeps the answer and the draft under the %s note until the read answers again',
    async (state, forced, text) => {
      fixture()
      await start()
      await open('alpha')
      const box = nameBox()
      if (!box) throw new Error('no editor')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'Al 2')
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      force = forced
      await rerun()
      expect(line()?.getAttribute('data-milestone-open')).toBe(state)
      expect(line()?.textContent).toContain(text)
      // the editor keeps the draft, and the person may still save it
      expect(nameBox()?.value).toBe('Al 2')
      expect(nameBox()?.readOnly).toBe(false)
      expect(q('[data-milestone-row="beta"]')).not.toBeNull()
      const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
      expect(!!retry).toBe(state === 'failed')
      force = {}
      if (retry) {
        const before = subs.length
        await act(async () => retry.click())
        await settle()
        expect(subs.length).toBe(before + 1)
      } else await rerun()
      expect(line()).toBeNull()
      expect(windowState()).toBe('ok')
      expect(nameBox()?.value).toBe('Al 2')
    },
  )
})

describe('a milestone that goes away', () => {
  it('closes its editor and says so, keeping the window and its list', async () => {
    fixture()
    await start()
    await open('alpha')
    expect(nameBox()).not.toBeNull()
    server.milestones = server.milestones.filter((m) => m.id !== 'alpha')
    await rerun()
    expect(q('[data-milestone-editor]')).toBeNull()
    expect(line()?.getAttribute('data-milestone-open')).toBe('gone')
    expect(line()?.textContent).toBe(
      'This milestone is no longer here. It was deleted, or you can no longer open it.',
    )
    expect(q('[data-milestone-row="beta"]')).not.toBeNull()
    expect(q('[data-milestone-row="alpha"]')).toBeNull()
    // the window keeps the project it was fixed on, and says so
    expect(q('[data-modal-shell]')?.textContent).toContain('Plan')
  })

  it('says nothing after the person deleted it here, and keeps the add row and the Edit of the rest', async () => {
    fixture()
    await start()
    await open('alpha')
    vi.useFakeTimers({ toFake: ['Date'] })
    const del = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-milestone-editor] button')].find(
        (b) => b.textContent?.includes('elete'),
      )
    await act(async () => del()?.click())
    vi.setSystemTime(Date.now() + 1_000)
    await act(async () => del()?.click())
    vi.useRealTimers()
    await settle()
    expect(q('[data-milestone-editor]')).toBeNull()
    server.milestones = server.milestones.filter((m) => m.id !== 'alpha')
    await rerun()
    expect(line()).toBeNull()
    expect(q('[data-milestone-row="beta"]')).not.toBeNull()
    // the person still leads the project: they add and change the rest
    expect(q('[data-milestone-new]')).not.toBeNull()
    const edit = q('[data-milestone-row="beta"] button[aria-label^="Edit"]')
    expect(edit).not.toBeNull()
    await act(async () => edit?.click())
    expect(nameBox()?.value).toBe('Beta')
    expect(nameBox()?.readOnly).toBe(false)
  })

  it("keeps another milestone's open editor and its draft, locked, when the opened one goes", async () => {
    fixture()
    await start()
    await open('alpha')
    await act(async () => q('[data-milestone-row="beta"] button[aria-label^="Edit"]')?.click())
    const box = nameBox()
    if (!box) throw new Error('no editor on Beta')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'Beta 2')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // someone deletes Alpha: the answer names no project any more
    server.milestones = server.milestones.filter((m) => m.id !== 'alpha')
    await rerun()
    expect(line()?.getAttribute('data-milestone-open')).toBe('gone')
    expect(q('[data-milestone-editor="beta"]')).not.toBeNull()
    expect(nameBox()?.value).toBe('Beta 2')
    expect(nameBox()?.readOnly).toBe(true)
    expect(q('[data-milestone-locked-note]')).not.toBeNull()
    expect(q('[data-milestone-new]')).toBeNull()
  })

  it('says so again once a delete the server refused brought it back and it then went', async () => {
    fixture()
    await start()
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'projects:removeMilestone'
        ? Promise.reject(new Error('the server refused the delete'))
        : Promise.resolve(null),
    )
    await open('alpha')
    vi.useFakeTimers({ toFake: ['Date'] })
    const del = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-milestone-editor] button')].find(
        (b) => b.textContent?.includes('elete'),
      )
    await act(async () => del()?.click())
    vi.setSystemTime(Date.now() + 1_000)
    await act(async () => del()?.click())
    vi.useRealTimers()
    await settle()
    // the refusal took the paint back: the milestone shows again
    expect(q('[data-milestone-row="alpha"]')).not.toBeNull()
    expect(line()).toBeNull()
    server.milestones = server.milestones.filter((m) => m.id !== 'alpha')
    await rerun()
    expect(line()?.getAttribute('data-milestone-open')).toBe('gone')
  })
})

describe('the hidden tab', () => {
  it('stops the read while hidden, keeps the draft, and is busy until current again', async () => {
    fixture()
    await start()
    await open('alpha')
    const box = nameBox()
    if (!box) throw new Error('no editor')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'Al 2')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => setHidden(true))
    await settle()
    expect(liveGets()).toHaveLength(0)
    expect(nameBox()?.value).toBe('Al 2')
    expect(windowState()).toBe('refreshing')
    force = { get: 'loading' }
    await act(async () => setHidden(false))
    await settle()
    expect(liveGets()).toHaveLength(1)
    expect(q('[data-milestone-window]')?.getAttribute('aria-busy')).toBe('true')
    expect(nameBox()?.value).toBe('Al 2')
    force = {}
    await rerun()
    expect(windowState()).toBe('ok')
    expect(q('[data-milestone-window]')?.hasAttribute('aria-busy')).toBe(false)
    expect(nameBox()?.value).toBe('Al 2')
  })
})

describe('focus as the answer arrives', () => {
  it('stays on a control the person moved to while the window loaded', async () => {
    fixture()
    force = { get: 'loading' }
    await start()
    await open('alpha')
    const done = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Done',
    )
    done?.focus()
    force = {}
    await rerun()
    expect(nameBox()).not.toBeNull()
    expect(document.activeElement).toBe(done)
  })
})
