// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { type BoardArgs, boardStandIn } from '../store/boardStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  NAV_UNCHECKED,
  projectNavStandIn,
} from '../store/projectNavStandIn.setup'

/* The New task dialog's one Sub-project picker (panels/Modals.tsx
   NewIssueModal, components/TargetPicker.tsx) on App and the real store,
   which holds no project: it lists the sub-projects the person may add
   tasks to from projectNav.targets, in the server's order, answered here by the navigation
   stand-in with `targets`' force. Opened in a top-level project, it opens
   on that project's first writable sub-project once a batch holds it;
   only a confirmed end says no sub-project takes tasks, and a stopped
   batch, the refusal and a failure each say so and offer no choice, with
   Create off. The phone's New task names no project: in a project scope
   the dialog opens in that project, and in My view on no choice. Everyday
   values: one top-level project with three sub-projects. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
// the live double of the store that loaded last, whose project cache reads
// a case can leave to the client's onUpdate
const double = vi.hoisted(() => ({
  live: null as null | { forceProjectNav(force: 'client' | null): void },
}))
vi.mock('../lib/convex', async () => {
  double.live = (await import('../store/guard/liveDouble.setup')).liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let container: HTMLDivElement
let root: Root
// how the server answers projectNav.targets
let targets: ForcedProjectNav
// whether the project cache's byIds reads go to onUpdate below, and the
// ids whose next such read fails, once each
let byIdsHere: boolean
let failByIds: Set<string>

beforeEach(() => {
  targets = {}
  byIdsHere = false
  failByIds = new Set()
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // the phone's layout, whose New task names no project
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
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
  // the dialog's kept draft and the preferences, which an earlier case left
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Plan, a top-level project the person leads, so they may add tasks to
    each of its sub-projects, Gamma, Alpha and Beta, made in that order;
    with `writes` false they view Plan, and so its sub-projects, only. */
function world(writes = true): Snapshot {
  const snap = plannerFixture()
  const me = snap.profiles[0].id
  snap.profiles[0].org_role = 'user'
  const base = snap.projects[0]
  const sub = (id: string, name: string, num: number) => ({
    ...base,
    id,
    type: 'project' as const,
    key: id.toUpperCase().slice(0, 4),
    num,
    name,
    parent_id: 'plan',
    lead_id: undefined,
  })
  snap.projects = [
    {
      ...base,
      id: 'plan',
      type: 'meta',
      key: 'PLAN',
      num: 1,
      name: 'Plan',
      lead_id: writes ? me : undefined,
    },
    sub('gamma', 'Gamma', 2),
    sub('alpha', 'Alpha', 3),
    sub('beta', 'Beta', 4),
  ]
  snap.access = writes ? [] : [{ project_id: 'plan', profile_id: me, level: 'viewer' }]
  snap.issues = []
  return snap
}

/** Renders App at `path`, Plan's Board by default, on `snap`, in a store
    that never asked for every task, as the app boots. */
async function app(snap: Snapshot, path = '/app/testbed/board/p/1') {
  vi.resetModules()
  history.replaceState(null, '', path)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
    else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    else if (name === 'projectNav:byIds' && failByIds.size > 0) {
      const ids = (args as { ids: string[] }).ids
      if (ids.some((id) => failByIds.has(id))) {
        for (const id of ids) failByIds.delete(id)
        fail?.(new Error('the byIds read failed'))
      } else answerProjectNav(snap, name, args, next, fail)
    } else if (isProjectNavRead(name))
      answerProjectNav(snap, name, args, next, fail, {
        force: name === 'projectNav:targets' ? targets : {},
      })
    return () => {}
  })
  // a numbered project address resolves through projectNav.resolve
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? projectNavStandIn(snap, 'projectNav:resolve', args)
      : null,
  )
  network.mutation.mockResolvedValue(null)
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = false
  const store = await import('../store/planner')
  // the double outlives the store, so each load says where its reads go
  double.live?.forceProjectNav(byIdsHere ? 'client' : null)
  await store.initStore()
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
}

/** Waits for `find` to answer, inside act, so a repaint the store made in
    a frame of its own commits first. */
function waitFor<T>(find: () => T | null | undefined, what: string) {
  return vi.waitFor(
    async () => {
      await act(async () => {})
      const found = find()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}
const buttonNamed = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )
const picker = () => document.querySelector<HTMLElement>('[data-target-picker]')
const chosen = () =>
  document
    .querySelector<HTMLInputElement>('[data-target-picker] input[type="radio"]:checked')
    ?.closest<HTMLElement>('[data-target]')?.dataset.target

/** Opens the New task dialog from the phone's New task and types a
    title. */
async function openDialog() {
  const add = await waitFor(
    () =>
      document.querySelector<HTMLElement>('[data-mobile-new-task]') ??
      document.querySelector<HTMLElement>('button[aria-label="New task"]'),
    'the New task button',
  )
  await act(async () => add.click())
  const field = await waitFor(
    () => document.querySelector<HTMLInputElement>('input[aria-label="Title"]'),
    'the Title field',
  )
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      field,
      'Write the notes',
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await waitFor(picker, 'the Sub-project picker')
}

describe("the New task dialog's Sub-project picker", { timeout: 30_000 }, () => {
  it('opens in a top-level project on the first sub-project the person may add tasks to, once a batch holds it', async () => {
    await app(world())
    await openDialog()
    await waitFor(() => document.querySelector('[data-target="gamma"]'), "Gamma's row")
    // the server's order, by name under the project: Alpha first
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-target]')].map((r) => r.dataset.target),
    ).toEqual(['alpha', 'beta', 'gamma'])
    // must fail for a dialog that opens on no choice in a top-level project
    await waitFor(() => chosen() === 'alpha' || null, 'the default')
    // Create turns on once the cache answered the choice writable
    await waitFor(() => buttonNamed('Create')?.disabled === false || null, 'Create turned on')
  })

  it("opens in a top-level project on its first writable sub-project where the browse list's first batch does not reach it", async () => {
    const snap = world()
    const me = snap.profiles[0].id
    const base = snap.projects[0]
    // Atlas sorts before Plan, and a batch of two holds only its sub-projects
    snap.projects.push(
      { ...base, id: 'atlas', type: 'meta', key: 'ATL', num: 10, name: 'Atlas', lead_id: me },
      ...['One', 'Two'].map((name, i) => ({
        ...base,
        id: `atlas-${i}`,
        type: 'project' as const,
        key: `AT${i}`,
        num: 11 + i,
        name,
        parent_id: 'atlas',
        lead_id: undefined,
      })),
    )
    targets = { batch: 2 }
    await app(snap)
    await openDialog()
    await waitFor(() => document.querySelector('[data-target="atlas-0"]'), "Atlas One's row")
    // must fail for a default taken only from the browse list's batches
    await waitFor(() => chosen() === 'alpha' || null, 'the default')
    // the default shows at the top, under its project's name, as the
    // browse list has not reached it
    const groups = [...document.querySelectorAll<HTMLElement>('[data-target-group]')]
    expect(groups.map((g) => g.dataset.targetGroup)).toEqual(['plan', 'atlas'])
    expect(
      document.getElementById(groups[0].getAttribute('aria-labelledby') ?? '')?.textContent,
    ).toBe('Plan')
    expect(groups[0].querySelector('[data-target]')?.textContent).toBe('Alpha')
    await waitFor(() => buttonNamed('Create')?.disabled === false || null, 'Create turned on')
    // a search that matches neither Plan nor Alpha shows no pinned row
    // beside the end that says nothing matches
    const search = (text: string) => {
      const box = document.querySelector<HTMLInputElement>('[data-target-search]')
      if (!box) throw new Error('no search box')
      return act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await search('Zulu')
    await waitFor(
      () => picker()?.textContent?.includes('No matching sub-project you can add tasks to.'),
      'the end of the search',
    )
    // must fail for a pinned row drawn during a search it does not match
    expect(document.querySelector('[data-target-group]')).toBeNull()
    // and it comes back once the search clears
    await search('')
    await waitFor(
      () =>
        document.querySelector<HTMLElement>('[data-target-group]')?.dataset.targetGroup === 'plan',
      'the pinned row again',
    )
    expect(chosen()).toBe('alpha')
  })

  it('tells two sub-projects of one name apart by their numbers, which the project cache does not hold', async () => {
    const snap = world()
    // Gamma (2) and Alpha (3) share a name under Plan
    for (const p of snap.projects) if (p.id === 'gamma' || p.id === 'alpha') p.name = 'Design'
    // from My view, which names neither, so the cache holds no namesake
    await app(snap, '/app/~/board/mine')
    await openDialog()
    await waitFor(() => document.querySelector('[data-target="gamma"]'), "Gamma's row")
    const label = (id: string) =>
      document.querySelector(`[data-target="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim()
    // must fail for labels that take their tags from the project cache
    expect(label('gamma')).toBe('Design #2')
    expect(label('alpha')).toBe('Design #3')
    expect(label('beta')).toBe('Beta')
    // each group is announced by its project's name
    const group = document.querySelector<HTMLElement>('[data-target-group="plan"]')
    expect(group?.tagName).toBe('FIELDSET')
    const heading = document.getElementById(group?.getAttribute('aria-labelledby') ?? '')
    expect(heading?.textContent).toBe('Plan')
  })

  it("says a failed read of the chosen sub-project with Retry, keeping the draft, and turns Create on once Retry's read answers", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    byIdsHere = true
    await app(world(), '/app/~/board/mine')
    await openDialog()
    const row = await waitFor(
      () => document.querySelector<HTMLInputElement>('[data-target="beta"] input'),
      "Beta's row",
    )
    // the project cache's first read of Beta fails
    failByIds.add('beta')
    await act(async () => row.click())
    const note = () => document.querySelector<HTMLElement>('[data-target-note]')
    await waitFor(() => note()?.dataset.targetNote === 'failed' || null, 'the failed note')
    expect(note()?.textContent).toContain("Couldn't open Beta.")
    expect(buttonNamed('Create')?.disabled).toBe(true)
    // must fail for a note whose Retry reads nothing again
    await act(async () => note()?.querySelector<HTMLElement>('[data-target-retry]')?.click())
    await waitFor(() => buttonNamed('Create')?.disabled === false || null, 'Create turned on')
    expect(note()).toBeNull()
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')?.value).toBe(
      'Write the notes',
    )
  })

  it('says at a confirmed empty end that no sub-project takes tasks, and keeps Create off', async () => {
    // from My view, which names no project, for a person who views Plan only
    await app(world(false), '/app/~/board/mine')
    await openDialog()
    await waitFor(
      () => picker()?.textContent?.includes('No sub-project you can add tasks to.'),
      'the empty end',
    )
    expect(document.querySelector('[data-target]')).toBeNull()
    expect(buttonNamed('Create')?.disabled).toBe(true)
  })

  it('says a stopped batch beside Load more, never as the end', async () => {
    // the read budget stops each batch after one candidate it judged
    targets = { stop: 1 }
    await app(world(), '/app/~/board/mine')
    await openDialog()
    await waitFor(
      () => picker()?.textContent?.includes('Showing the sub-projects found so far.'),
      'the stopped batch',
    )
    // must fail for a stopped batch shown as the list's end
    expect(picker()?.textContent).not.toContain('No sub-project you can add tasks to.')
  })

  it("says the refusal's sentence and a failure's, offering no choice, with Create off", async () => {
    for (const [force, sentence] of [
      [{ unchecked: NAV_UNCHECKED }, NAV_UNCHECKED],
      [{ fail: true }, "Couldn't load the sub-projects you can add tasks to."],
    ] as const) {
      targets = force
      await app(world(), '/app/~/board/mine')
      await openDialog()
      await waitFor(() => picker()?.textContent?.includes(sentence), sentence)
      expect(picker()?.textContent).not.toContain('No sub-project you can add tasks to.')
      expect(document.querySelector('[data-target]')).toBeNull()
      expect(buttonNamed('Create')?.disabled).toBe(true)
      await act(async () => root.unmount())
      root = createRoot(container)
      localStorage.clear()
      sessionStorage.clear()
    }
  })
})
