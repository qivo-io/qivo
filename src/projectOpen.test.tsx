// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerMilestones, isMilestoneRead } from './store/milestoneStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  NAV_UNCHECKED,
  queryProjectNav,
} from './store/projectNavStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'

/* How App opens a project scope (App.tsx scopeShows, the access guard) on
   the real store, which holds no project: the scope is set at once and the
   project cache checks it (projectNav.byIds, answered here by hand, so a
   case can hold, fail or refuse it, or list a parent apart). A row's open
   seeds the project's facts, so its views mount at once; an address by
   uuid says "Opening that project…" until the cache answers; a project the
   cache answers gone shows the chooser's lost note, the address giving way
   in place; a failed read and the refusal show their sentence with Retry;
   and once the scope was ok its views stay through a hidden tab and a
   reread. Everyday values: one top-level project with one sub-project the
   person uses, and one they cannot open. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => {
  const live = (await import('./store/guard/liveDouble.setup')).liveOver(network)
  // the cases answer the project cache's reads themselves
  live.forceProjectNav('client')
  return { convex: network, live }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

/** A project cache read (projectNav.byIds) the store opened. */
type ByIdsRead = {
  ids: string[]
  next: (value: unknown) => void
  fail: (error: unknown) => void
  open: boolean
}

let container: HTMLDivElement
let root: Root
let server: Snapshot
// every project cache read the store opened, in order
let byIds: ByIdsRead[]
/* How the cases answer a project cache read: from the server's copy, not
   at all ('hold'), with a failure, with the refusal, or by hand. */
let cacheAnswer: 'server' | 'hold' | 'fail' | 'refuse' | ((read: ByIdsRead) => void)

beforeEach(() => {
  byIds = []
  cacheAnswer = 'server'
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
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
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  Reflect.deleteProperty(document, 'visibilityState')
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const PLAN = '0a000000-0000-4000-8000-000000000001'
const ALPHA = '0a000000-0000-4000-8000-000000000002'
const HIDDEN = '0a000000-0000-4000-8000-000000000003'

/** Plan, a top-level project the person holds User on, with its
    sub-project Alpha, and Hidden, which they cannot open. */
function world(): Snapshot {
  const snap = plannerFixture()
  const me = snap.profiles[0].id
  snap.profiles[0].org_role = 'user'
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: PLAN, type: 'meta', key: 'PLAN', num: 1, name: 'Plan', lead_id: undefined },
    {
      ...base,
      id: ALPHA,
      type: 'project',
      key: 'ALP',
      num: 2,
      name: 'Alpha',
      parent_id: PLAN,
      lead_id: undefined,
    },
    { ...base, id: HIDDEN, type: 'meta', key: 'HID', num: 3, name: 'Hidden', lead_id: undefined },
  ]
  snap.access = [{ project_id: PLAN, profile_id: me, level: 'user' }]
  snap.issues = []
  return snap
}

/** Answers project cache read `read` as `cacheAnswer` says. */
function answer(read: ByIdsRead) {
  if (!read.open || cacheAnswer === 'hold') return
  if (cacheAnswer === 'fail') return read.fail(new Error('the read failed'))
  if (cacheAnswer === 'refuse')
    return read.next({ rows: [], unchecked: [...read.ids], message: NAV_UNCHECKED })
  if (typeof cacheAnswer === 'function') return cacheAnswer(read)
  answerProjectNav(server, 'projectNav:byIds', { ids: read.ids }, read.next, read.fail)
}

/** Answers every open project cache read again, as the server reruns
    them after a change of access. */
const rerun = () =>
  act(async () => {
    for (const read of byIds) answer(read)
  })

/** Boots the real store on `snap` and renders App at `path`. */
async function app(snap: Snapshot, path: string) {
  vi.resetModules()
  history.replaceState(null, '', path)
  server = snap
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(server))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(server, name, args))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (isMilestoneRead(name)) answerMilestones(server, name, args, next, fail)
    else if (name === 'projectNav:byIds') {
      const read: ByIdsRead = {
        ids: [...(args as { ids: string[] }).ids],
        next,
        fail,
        open: true,
      }
      byIds.push(read)
      answer(read)
      return () => {
        read.open = false
      }
    } else if (isProjectNavRead(name)) answerProjectNav(server, name, args, next, fail)
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? queryProjectNav(server, 'projectNav:resolve', args)
      : null,
  )
  network.mutation.mockResolvedValue(null)
  const { TASKS } = await import('./store/liveParts')
  TASKS.atBoot = false
  const store = await import('./store/planner')
  await store.initStore()
  const { syncStatus } = await import('./lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('./App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
  return store.P
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/** Waits for `find` to hold, through lazy views that can take seconds.
    Each look runs inside act, so a repaint the store made in a frame of
    its own, as for the project cache's answers, commits with its effects
    first. */
const until = (find: () => unknown, what: string) =>
  vi.waitFor(
    async () => {
      await act(async () => {})
      if (!find()) throw new Error(`missing ${what}`)
    },
    { timeout: 10_000 },
  )
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const chooserState = () => q('[data-project-chooser]')?.getAttribute('data-project-chooser-state')
const line = () => q('[data-project-chooser-line]')?.textContent
const note = () => q('[data-project-chooser-note]')?.textContent
const shown = () => q('[data-workspace-view]')?.getAttribute('data-workspace-view')
/** Presses the top bar's view switch `label`. */
async function switchView(label: string) {
  const find = () =>
    [...document.querySelectorAll<HTMLElement>('[data-view-switch] button')].find(
      (b) => b.textContent?.trim() === label,
    )
  await until(find, `the ${label} switch`)
  await act(async () => find()?.click())
  await settle()
}
/** A record of the page's session history beside jsdom's, from the entry
    the page is on: every entry's address and the current entry's place, as
    the page's pushState and replaceState and the browser's Back and
    Forward (go) change them. */
function recordHistory() {
  const entries = [location.pathname]
  let at = 0
  const push = history.pushState.bind(history)
  const replace = history.replaceState.bind(history)
  vi.spyOn(history, 'pushState').mockImplementation((state, unused, url) => {
    push(state, unused, url)
    entries.splice(at + 1, entries.length, location.pathname)
    at += 1
  })
  vi.spyOn(history, 'replaceState').mockImplementation((state, unused, url) => {
    replace(state, unused, url)
    entries[at] = location.pathname
  })
  return {
    entries: () => [...entries],
    at: () => at,
    /** Moves `step` entries as the browser's Back or Forward does, and lets App follow. */
    async go(step: number) {
      const moved = new Promise((resolve) =>
        window.addEventListener('popstate', resolve, { once: true }),
      )
      await act(async () => {
        history.go(step)
        await moved
      })
      at += step
      await settle()
    },
  }
}
/** Sets whether the tab shows, as the browser tells the page. */
const setVisibility = (state: 'visible' | 'hidden') =>
  act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  })

describe('opening a project scope from the project cache', { timeout: 30_000 }, () => {
  it("opens a sidebar row's project at once, its facts seeded, and mounts its views while the cache reads it", async () => {
    const P = await app(world(), '/app/~/overview/mine')
    await until(() => shown() === 'overview', "My view's Overview")
    cacheAnswer = 'hold'
    await until(() => q(`aside [data-project-row="${PLAN}"] button`), "Plan's row")
    await act(async () => q(`aside [data-project-row="${PLAN}"] button`)?.click())
    await settle()
    // must fail for a seeded scope whose views wait for the answer
    expect(P.scopeInfo(PLAN)).toMatchObject({ name: 'Plan', state: 'loading' })
    expect(shown()).toBe('overview')
    expect(q('[data-project-chooser]')).toBeNull()
    expect(q('[data-scope-crumb] h1')?.textContent).toBe('Plan')
    expect(byIds.some((read) => read.open && read.ids.includes(PLAN))).toBe(true)
    // a seed gives no level until the cache answers
    expect(P.canWrite(PLAN)).toBe(false)
    cacheAnswer = 'server'
    await rerun()
    await until(() => P.projectState(PLAN) === 'ok', "the cache's answer")
    expect(location.pathname).toBe('/app/testbed/overview/p/1')
  })

  it('says Opening that project… for an address by uuid until the cache answers, mounting no view, then shows the views', async () => {
    cacheAnswer = 'hold'
    await app(world(), `/app/testbed/board/p/${PLAN}`)
    await until(() => chooserState() === 'checking', 'the checking chooser')
    expect(line()).toBe('Opening that project…')
    // must fail for a loading scope's views mounted
    expect(shown()).toBeUndefined()
    expect(location.pathname).toBe(`/app/testbed/board/p/${PLAN}`)
    cacheAnswer = 'server'
    await rerun()
    await until(() => shown() === 'kanban', "Plan's Board")
    expect(q('[data-project-chooser]')).toBeNull()
  })

  it('shows the lost note when the cache answers a project gone, the address giving way in place', async () => {
    // the boot replaces the address it starts on, so the entries now are
    // those the page has
    const entries = history.length
    await app(world(), `/app/testbed/overview/p/${HIDDEN}`)
    await until(() => chooserState() === 'lost', 'the lost chooser')
    expect(note()).toBe('That project is not available to you.')
    expect(shown()).toBeUndefined()
    expect(location.pathname).toBe('/app/testbed')
    expect(history.length).toBe(entries)
  })

  it('loses a scope its views showed once a current answer leaves it out, with its name in the note, and never another project', async () => {
    await app(world(), `/app/testbed/overview/p/${ALPHA}`)
    await until(() => shown() === 'overview', "Alpha's Overview")
    // the person loses Plan's grant, which carried Alpha
    server = { ...server, access: [] }
    await rerun()
    // the chooser says so, and as the person now opens no project its list
    // ends empty beneath the note
    await until(() => note() === 'Alpha is no longer available to you.', "the chooser's note")
    expect(shown()).toBeUndefined()
    expect(location.pathname).toBe('/app/testbed')
  })

  it("replaces a numbered scope's own entry with the front door once the cache answers it gone, keeping the place and the Forward entry", async () => {
    await app(world(), `/app/testbed/board/p/${ALPHA}`)
    await until(
      () => shown() === 'kanban' && location.pathname === '/app/testbed/board/p/2',
      "Alpha's Board by its number",
    )
    const record = recordHistory()
    // the Overview's entry, which Back leaves as the Forward entry
    await switchView('Overview')
    await until(() => shown() === 'overview', "Alpha's Overview")
    expect(record.entries()).toEqual(['/app/testbed/board/p/2', '/app/testbed/overview/p/2'])
    await record.go(-1)
    await until(() => shown() === 'kanban', "Alpha's Board again")
    expect(record.at()).toBe(0)
    // the person loses Plan's grant, which carried Alpha
    server = { ...server, access: [] }
    await rerun()
    await until(() => note() === 'Alpha is no longer available to you.', "the chooser's note")
    await settle()
    // must fail for an address sync that pushes the front door over the
    // lost entry before the access guard replaces it, dropping the Forward
    // entry
    expect(record.entries()).toEqual(['/app/testbed', '/app/testbed/overview/p/2'])
    expect(record.at()).toBe(0)
    expect(location.pathname).toBe('/app/testbed')
  })

  it("says a failed read's sentence and the refusal's with Retry, which reads again, and opens once it answers ok", async () => {
    cacheAnswer = 'fail'
    await app(world(), `/app/testbed/overview/p/${PLAN}`)
    await until(() => chooserState() === 'retry', 'the retry chooser')
    expect(line()).toBe("Couldn't check that project.")
    expect(shown()).toBeUndefined()
    // the refusal says its own sentence
    cacheAnswer = 'refuse'
    let reads = byIds.length
    await act(async () => q('[data-project-chooser-retry]')?.click())
    await settle()
    expect(byIds.length).toBeGreaterThan(reads)
    await until(() => line() === NAV_UNCHECKED, "the refusal's sentence")
    expect(chooserState()).toBe('retry')
    expect(shown()).toBeUndefined()
    // and Retry once the server answers opens the views
    cacheAnswer = 'server'
    reads = byIds.length
    await act(async () => q('[data-project-chooser-retry]')?.click())
    await settle()
    expect(byIds.length).toBeGreaterThan(reads)
    await until(() => shown() === 'overview', "Plan's Overview")
  })

  it("says the refusal's sentence of a top-level project the cache lists apart, for a sub-project it answered", async () => {
    // Alpha's row comes, and Plan is listed apart with the refusal
    cacheAnswer = (read) => {
      const alpha = byIdsRow(ALPHA)
      read.next({
        rows: read.ids.includes(ALPHA) ? [alpha] : [],
        unchecked: read.ids.filter((id) => id === PLAN),
        message: read.ids.includes(PLAN) ? NAV_UNCHECKED : null,
      })
    }
    const P = await app(world(), `/app/testbed/overview/p/${ALPHA}`)
    await until(() => chooserState() === 'retry', 'the retry chooser')
    expect(P.projectState(ALPHA)).toBe('ok')
    expect(P.projectState(PLAN)).toBe('unchecked')
    // must fail for the line taken from the sub-project's own note
    expect(line()).toBe(NAV_UNCHECKED)
    expect(shown()).toBeUndefined()
  })

  it('keeps the views through a hidden tab, a reread and a failed reread once the scope was ok', async () => {
    const P = await app(world(), `/app/testbed/board/p/${PLAN}`)
    await until(() => shown() === 'kanban', "Plan's Board")
    const board = q('[data-workspace-view="kanban"]')
    // hidden, the cache's reads stop, so it holds no current answer
    await setVisibility('hidden')
    await settle()
    expect(byIds.filter((read) => read.open)).toEqual([])
    expect(P.projectState(PLAN)).not.toBe('ok')
    // must fail for views that unmount when the cache reads again
    expect(shown()).toBe('kanban')
    expect(q('[data-project-chooser]')).toBeNull()
    // shown again, the reread is on its way and the same Board stays
    cacheAnswer = 'hold'
    await setVisibility('visible')
    await settle()
    expect(byIds.some((read) => read.open && read.ids.includes(PLAN))).toBe(true)
    expect(q('[data-workspace-view="kanban"]')).toBe(board)
    expect(q('[data-project-chooser]')).toBeNull()
    cacheAnswer = 'server'
    await rerun()
    await until(() => P.projectState(PLAN) === 'ok', "the reread's answer")
    expect(q('[data-workspace-view="kanban"]')).toBe(board)
    // a reread that fails after the first ok keeps the views too, which
    // say so themselves; only gone loses the scope
    await setVisibility('hidden')
    cacheAnswer = 'fail'
    await setVisibility('visible')
    await until(() => P.projectState(PLAN) === 'failed', 'the failed reread')
    // must fail for views that unmount on a failed reread
    expect(q('[data-workspace-view="kanban"]')).toBe(board)
    expect(q('[data-project-chooser]')).toBeNull()
  })
})

/** Project `id`'s row as projectNav.byIds answers it from the server's
    copy for the person. */
function byIdsRow(id: string) {
  let row: unknown = null
  answerProjectNav(
    server,
    'projectNav:byIds',
    { ids: [id] },
    (value) => {
      row = (value as { rows: { id: string }[] }).rows.find((r) => r.id === id) ?? null
    },
    () => {},
  )
  return row
}
