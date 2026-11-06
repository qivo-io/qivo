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
  MILESTONES_TOO_LARGE,
} from '../store/milestoneStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Milestones window's two sections (panels/Modals.tsx MilestoneModal,
   views/useMilestoneSection.ts), on the real store, with the milestone
   reads answered by the stand-in (store/milestoneStandIn.setup.ts) from the
   server's copy: Upcoming's batches, Load more and the move on at the cap,
   Past collapsed and read only once expanded, the server's search, every
   state a section says, the hidden tab and a new week, the person's writes
   painted over the sections, the milestone the window opened on in its
   place, an open editor that keeps its draft and focus wherever its row
   goes, and no task read. Cases that need Load more or a move on lower
   MILESTONE_SECTION to batches of 2 and a cap of 4. */

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

type Sub = {
  name: string
  args: Record<string, unknown>
  next: (v: unknown) => void
  fail: (e: unknown) => void
  stopped: boolean
}

let container: HTMLDivElement
let root: Root
let snap: Snapshot
/* the server's own copy, which the milestone reads answer from */
let server: Snapshot
let force: ForcedMilestones
let deliverWorkspace: (snapshot: Snapshot) => void
let subs: Sub[]
let modals: typeof import('./Modals')
let version: typeof import('../store/usePlannerVersion')
let store: typeof import('../store/planner')
let section: typeof import('../lib/milestoneSection')

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
  setHidden(false)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The Monday `weeks` weeks after this week's, as a milestone's week. */
function mondayIn(weeks: number, from = new Date()) {
  const day = new Date(from)
  day.setDate(day.getDate() + 7 * weeks - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** Plan, a top-level project with sub-project Work, `up` weekly milestones
    from this week on (u1 first, named Step 1 and on) and `past` weekly ones
    before it (p1 newest, Audit or Review by turns), and `edit`'s changes.
    I am the organization's admin unless `edit` says otherwise. */
function fixture(o: { up?: number; past?: number; edit?: (s: Snapshot) => void } = {}) {
  snap = plannerFixture()
  const base = snap.projects[0]
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', name: 'Plan' },
    { ...base, id: 'work', key: 'WORK', num: 2, name: 'Work', parent_id: 'plan' },
  ]
  for (let i = 0; i < (o.up ?? 0); i++)
    snap.milestones.push({
      id: `u${i + 1}`,
      project_id: 'plan',
      name: `Step ${i + 1}`,
      week: mondayIn(i),
      created_at: AT,
    })
  for (let i = 0; i < (o.past ?? 0); i++)
    snap.milestones.push({
      id: `p${i + 1}`,
      project_id: 'plan',
      name: `${i % 2 ? 'Review' : 'Audit'} ${i + 1}`,
      week: mondayIn(-1 - i),
      created_at: AT,
    })
  o.edit?.(snap)
  server = structuredClone(snap)
}

/** Starts the store over the fixture, with sections of `batch` and `rows`
    when given. */
async function start(lowered?: { batch: number; rows: number }) {
  vi.resetModules()
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliverWorkspace = (snapshot) => next(structuredClone(snapshot))
      deliverWorkspace(snap)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
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
  store = await import('../store/planner')
  await store.initStore()
  modals = await import('./Modals')
  version = await import('../store/usePlannerVersion')
  section = await import('../lib/milestoneSection')
  if (lowered) {
    Object.assign(section.MILESTONE_SECTION, lowered)
    force.firstBatch = lowered.batch
  }
}

/* Re-renders on every store change, as App does. */
function Live({ page }: { page: () => React.ReactNode }) {
  version.usePlannerVersion()
  return page()
}

/** Renders the window with `init`. */
async function open(init: { id?: string; week?: number; project?: string | null }) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Live page={() => <modals.MilestoneModal init={init} onClose={vi.fn()} />} />
      </TooltipProvider>,
    ),
  )
  await settle()
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

/** Waits past the search box's settling delay (lib/pagedList.ts). */
const searchSettles = async () => {
  await act(async () => await new Promise((r) => setTimeout(r, 320)))
  await settle()
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
const sectionOf = (side: 'upcoming' | 'past') => q(`[data-milestone-section="${side}"]`)
const stateOf = (side: 'upcoming' | 'past') =>
  sectionOf(side)?.getAttribute('data-milestone-section-state')
/** The ids of the rows and editors a section shows, in order. */
const shown = (side: 'upcoming' | 'past') =>
  [
    ...(sectionOf(side)?.querySelectorAll<HTMLElement>(
      '[data-milestone-rows] > [data-milestone-row], [data-milestone-rows] > [data-milestone-editor]',
    ) ?? []),
  ].map((e) => e.dataset.milestoneRow ?? e.dataset.milestoneEditor)
/** The names of the rows a section shows, in order. */
const namesOf = (side: 'upcoming' | 'past') =>
  [
    ...(sectionOf(side)?.querySelectorAll<HTMLElement>('[data-milestone-row] span.truncate') ?? []),
  ].map((e) => e.textContent)
const noteOf = (side: 'upcoming' | 'past') =>
  [...(sectionOf(side)?.querySelectorAll<HTMLElement>('[data-milestone-note]') ?? [])].map(
    (e) => `${e.dataset.milestoneNote}: ${e.textContent}`,
  )
const sectionSubs = (side?: 'upcoming' | 'past') =>
  subs.filter((s) => s.name === 'milestones:section' && (!side || s.args.side === side))
const live = (list: Sub[]) => list.filter((s) => !s.stopped)
const button = (text: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)
const nameBox = () =>
  q('[data-milestone-editor] input[aria-label="Name"]') as HTMLInputElement | null

async function press(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('nothing to press')
  await act(async () => element.click())
  await settle()
}

/** Types `text` into `box` as a person does. */
async function typeInto(box: HTMLInputElement | null, text: string) {
  if (!box) throw new Error('no box')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Moves milestone `id` on the server to `week`, as someone else does. */
function moveOnServer(id: string, week: string) {
  const row = server.milestones.find((m) => m.id === id)
  if (!row) throw new Error(`no ${id}`)
  row.week = week
}

describe('Upcoming', { timeout: 30_000 }, () => {
  it('reads its first batch, grows it by Load more while the first stays live, and moves on at the cap', async () => {
    fixture({ up: 6 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(stateOf('upcoming')).toBe('ok')
    expect(sectionOf('upcoming')?.querySelector('[data-milestone-count]')).toBeNull()
    // the Load more's read is held: the first batch stays, live
    force.more = 'loading'
    const more = q('[data-milestone-more]')
    more?.focus()
    await press(more)
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(live(sectionSubs('upcoming'))).toHaveLength(2)
    expect(q('[data-milestone-more]')?.textContent).toBe('Loading…')
    expect(sectionOf('upcoming')?.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(q('[data-milestone-more]'))
    force.more = undefined
    await rerun()
    expect(shown('upcoming')).toEqual(['u1', 'u2', 'u3', 'u4'])
    expect(live(sectionSubs('upcoming'))).toHaveLength(1)
    expect(live(sectionSubs('upcoming'))[0].args).toMatchObject({ limit: 4 })
    // at the cap, Load more moves on after the row the first batch ends on
    await press(q('[data-milestone-more]'))
    const moved = live(sectionSubs('upcoming'))
    expect(moved).toHaveLength(1)
    expect(moved[0].args).toMatchObject({ limit: 4, after: { id: 'u2' } })
    expect(shown('upcoming')).toEqual(['u3', 'u4', 'u5', 'u6'])
    expect(q('[data-milestone-dropped]')?.textContent).toContain(
      'Earlier milestones are not shown.',
    )
    // a moved-on section is never whole: no count, no empty line
    expect(sectionOf('upcoming')?.querySelector('[data-milestone-count]')).toBeNull()
    await press(q('[data-milestone-from-start]'))
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(q('[data-milestone-dropped]')).toBeNull()
    expect(document.activeElement).toBe(sectionOf('upcoming'))
  })

  it.each([
    ['upcoming milestones and no past', { up: 3 }, ['u1', 'u2', 'u3'], '3', [], false],
    ['no milestone at all', {}, [], '0', ['empty: No milestones yet.'], false],
    ['past milestones only', { past: 2 }, [], '0', ['empty: No upcoming milestones.'], true],
  ] as const)(
    'counts a whole answer and says when it is empty, for a project with %s',
    async (_, counts, rows, count, notes, past) => {
      fixture(counts)
      await start()
      await open({ project: 'plan' })
      expect(shown('upcoming')).toEqual(rows)
      expect(sectionOf('upcoming')?.querySelector('[data-milestone-count]')?.textContent).toBe(
        count,
      )
      expect(noteOf('upcoming')).toEqual(notes)
      expect(!!q('[data-milestone-past-toggle]')).toBe(past)
      expect(q('[data-milestone-more]')).toBeNull()
      expect(q('[data-milestone-search]')).toBeNull()
    },
  )

  it('must fail: counts an answer with more after it, or offers its search box only then', async () => {
    fixture({ up: 3 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    expect(sectionOf('upcoming')?.querySelector('[data-milestone-count]')).toBeNull()
    expect(q('[data-milestone-search]')?.getAttribute('aria-label')).toBe(
      'Search upcoming milestones',
    )
  })

  it("emphasises the next milestone's phrase on the first row only", async () => {
    fixture({ up: 2 })
    await start()
    await open({ project: 'plan' })
    const emphasised = (id: string) =>
      q(`[data-milestone-row="${id}"] span.text-xs`)?.classList.contains('font-medium')
    expect(emphasised('u1')).toBe(true)
    expect(emphasised('u2')).toBe(false)
  })
})

describe('Past', { timeout: 30_000 }, () => {
  it('reads nothing while collapsed, then its first batch newest first once expanded', async () => {
    fixture({ up: 2, past: 5 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    const toggle = q('[data-milestone-past-toggle]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(sectionSubs('past')).toHaveLength(0)
    expect(shown('past')).toEqual([])
    expect(stateOf('past')).toBeNull()
    await press(toggle)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    const body = document.getElementById(toggle?.getAttribute('aria-controls') ?? '')
    expect(body?.closest('[data-milestone-section="past"]')).toBe(sectionOf('past'))
    expect(live(sectionSubs('past'))).toHaveLength(1)
    expect(live(sectionSubs('past'))[0].args).toMatchObject({ side: 'past', limit: 2 })
    expect(shown('past')).toEqual(['p1', 'p2'])
    await press(q('[data-milestone-section="past"] [data-milestone-more]'))
    expect(shown('past')).toEqual(['p1', 'p2', 'p3', 'p4'])
    await press(q('[data-milestone-section="past"] [data-milestone-more]'))
    expect(q('[data-milestone-section="past"] [data-milestone-dropped]')?.textContent).toContain(
      'More recent milestones are not shown.',
    )
  })

  it('searches every past milestone on the server and shows only its answer', async () => {
    fixture({ up: 1, past: 6 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    await press(q('[data-milestone-past-toggle]'))
    expect(shown('past')).toEqual(['p1', 'p2'])
    const box = q('[data-milestone-section="past"] [data-milestone-search]') as HTMLInputElement
    expect(box?.getAttribute('aria-label')).toBe('Search past milestones')
    await typeInto(box, 'review')
    await searchSettles()
    const asked = live(sectionSubs('past'))
    expect(asked).toHaveLength(1)
    expect(asked[0].args).toMatchObject({ search: 'review', limit: 2 })
    // the second and fourth past milestones are Reviews; p4 was never loaded
    expect(shown('past')).toEqual(['p2', 'p4'])
    await typeInto(box, 'nothing like it')
    await searchSettles()
    expect(noteOf('past')).toEqual(['empty: No past milestones match.'])
  })

  it('releases its reads and forgets its search and place when collapsed', async () => {
    fixture({ up: 1, past: 6 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    const toggle = q('[data-milestone-past-toggle]')
    await press(toggle)
    await press(q('[data-milestone-section="past"] [data-milestone-more]'))
    await typeInto(
      q('[data-milestone-section="past"] [data-milestone-search]') as HTMLInputElement,
      'audit',
    )
    await searchSettles()
    await press(toggle)
    expect(live(sectionSubs('past'))).toHaveLength(0)
    expect(shown('past')).toEqual([])
    await press(toggle)
    expect(live(sectionSubs('past'))).toHaveLength(1)
    expect(live(sectionSubs('past'))[0].args).not.toHaveProperty('search')
    expect(live(sectionSubs('past'))[0].args).toMatchObject({ limit: 2 })
    expect(
      (q('[data-milestone-section="past"] [data-milestone-search]') as HTMLInputElement).value,
    ).toBe('')
  })
})

describe('what a section says', { timeout: 30_000 }, () => {
  it.each([
    ['loading', { upcoming: 'loading' }, 'loading', ['loading: Loading milestones…']],
    ['failed', { upcoming: 'error' }, 'failed', ["failed: Couldn't load milestones.Retry"]],
    [
      'refused',
      { upcoming: 'refused' },
      'refused',
      [
        `refused: ${MILESTONES_TOO_LARGE.slice(0, 1).toUpperCase()}${MILESTONES_TOO_LARGE.slice(1)}`,
      ],
    ],
  ] as const)('Upcoming %s before any answer, never as empty', async (_, forced, state, notes) => {
    fixture({ up: 2, past: 1 })
    force = { ...forced }
    await start()
    await open({ project: 'plan' })
    expect(stateOf('upcoming')).toBe(state)
    expect(noteOf('upcoming')).toEqual(notes)
    expect(shown('upcoming')).toEqual([])
    expect(sectionOf('upcoming')?.querySelector('[data-milestone-count]')).toBeNull()
  })

  it('must fail: an empty line for a read that stopped with no row, which Load more continues', async () => {
    fixture({ past: 1 })
    force = { upcoming: 'stopped' }
    await start()
    await open({ project: 'plan' })
    expect(noteOf('upcoming')).toEqual([
      'stopped: Qivo checked part of the list. Load more continues.',
    ])
    expect(q('[data-milestone-more]')).not.toBeNull()
  })

  it('keeps the rows of a failure after an answer, with Retry', async () => {
    fixture({ up: 2 })
    await start()
    await open({ project: 'plan' })
    force = { upcoming: 'error' }
    await rerun()
    expect(stateOf('upcoming')).toBe('failed')
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(noteOf('upcoming')).toEqual(["failed: Couldn't load the latest milestones.Retry"])
    force = {}
    const before = sectionSubs('upcoming').length
    await press(button('Retry', sectionOf('upcoming') ?? document))
    expect(sectionSubs('upcoming')).toHaveLength(before + 1)
    expect(stateOf('upcoming')).toBe('ok')
  })

  it('fails Past while Upcoming answers', async () => {
    fixture({ up: 2, past: 2 })
    force = { past: 'error' }
    await start()
    await open({ project: 'plan' })
    await press(q('[data-milestone-past-toggle]'))
    expect(stateOf('upcoming')).toBe('ok')
    expect(stateOf('past')).toBe('failed')
    expect(noteOf('past')).toEqual(["failed: Couldn't load milestones.Retry"])
  })

  it('keeps the rows before a Load more that failed, live, and gives Retry the focus', async () => {
    fixture({ up: 4 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    force = { more: 'error', firstBatch: 2 }
    const more = q('[data-milestone-more]')
    more?.focus()
    await press(more)
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(stateOf('upcoming')).toBe('failed')
    expect(noteOf('upcoming')).toEqual(["more-failed: Couldn't load more milestones.Retry"])
    expect(q('[data-milestone-more]')).toBeNull()
    expect(live(sectionSubs('upcoming')).some((s) => s.args.limit === 2)).toBe(true)
    expect(document.activeElement).toBe(button('Retry', sectionOf('upcoming') ?? document))
    force = { firstBatch: 2 }
    await press(button('Retry', sectionOf('upcoming') ?? document))
    expect(shown('upcoming')).toEqual(['u1', 'u2', 'u3', 'u4'])
    expect(stateOf('upcoming')).toBe('ok')
  })
})

describe('the hidden tab and a new week', { timeout: 30_000 }, () => {
  it('stops every section read while hidden, keeps the rows and a draft, and is busy until current', async () => {
    fixture({ up: 2, past: 2 })
    await start()
    await open({ project: 'plan' })
    await press(q('[data-milestone-past-toggle]'))
    await press(q('[data-milestone-row="u1"] button[aria-label^="Edit"]'))
    await typeInto(nameBox(), 'Step one, renamed')
    await act(async () => setHidden(true))
    await settle()
    expect(live(sectionSubs())).toHaveLength(0)
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(shown('past')).toEqual(['p1', 'p2'])
    expect(stateOf('upcoming')).toBe('refreshing')
    expect(nameBox()?.value).toBe('Step one, renamed')
    force = { section: 'loading' }
    await act(async () => setHidden(false))
    await settle()
    expect(live(sectionSubs())).toHaveLength(2)
    expect(sectionOf('upcoming')?.getAttribute('aria-busy')).toBe('true')
    force = {}
    await rerun()
    expect(stateOf('upcoming')).toBe('ok')
    expect(sectionOf('upcoming')?.hasAttribute('aria-busy')).toBe(false)
    expect(nameBox()?.value).toBe('Step one, renamed')
  })

  it('must fail: a section that reads while the tab is hidden', async () => {
    fixture({ up: 2 })
    await start()
    await act(async () => setHidden(true))
    await open({ project: 'plan' })
    expect(live(sectionSubs())).toHaveLength(0)
    expect(stateOf('upcoming')).toBe('loading')
  })

  it('asks a new `from` once the week rolls over and starts again at the first batch', async () => {
    fixture({ up: 6, past: 1 })
    await start({ batch: 2, rows: 4 })
    await open({ project: 'plan' })
    await press(q('[data-milestone-past-toggle]'))
    await press(q('[data-milestone-more]'))
    expect(shown('upcoming')).toEqual(['u1', 'u2', 'u3', 'u4'])
    // a week later, the grid re-anchors as the workspace delivers again
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 7 * 86_400_000)
    snap.projects[1].description = 'A week later'
    await act(async () => deliverWorkspace(snap))
    await settle()
    const asked = live(sectionSubs('upcoming'))
    expect(asked).toHaveLength(1)
    expect(asked[0].args).toMatchObject({ from: mondayIn(0), limit: 2 })
    expect(shown('upcoming')).toEqual(['u2', 'u3'])
    // Past stays expanded, and holds last week's milestone now
    expect(q('[data-milestone-past-toggle]')?.getAttribute('aria-expanded')).toBe('true')
    expect(shown('past')).toEqual(['u1', 'p1'])
  })
})

describe("the person's writes", { timeout: 30_000 }, () => {
  it('paints an upcoming add in its place in Upcoming', async () => {
    fixture({
      up: 2,
      edit: (s) => {
        s.milestones[1].week = mondayIn(2)
      },
    })
    await start()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live
            page={() => (
              <modals.MilestoneModal
                init={{ project: 'plan', week: store.P.TODAY_WEEK + 1 }}
                onClose={vi.fn()}
              />
            )}
          />
        </TooltipProvider>,
      ),
    )
    await settle()
    await typeInto(q('[data-milestone-new]') as HTMLInputElement, 'Between')
    await press(button('Add'))
    expect(namesOf('upcoming')).toEqual(['Step 1', 'Between', 'Step 2'])
    expect(window.showToast).toHaveBeenLastCalledWith('Milestone “Between” added')
  })

  it.each([
    ['collapsed', false, 'Milestone “Old review” added to Past', []],
    ['expanded', true, 'Milestone “Old review” added', ['Audit 1', 'Old review']],
  ] as const)('says where a past add went with Past %s', async (_, expanded, toast, pastNames) => {
    fixture({ up: 1, past: 1 })
    await start()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live
            page={() => (
              <modals.MilestoneModal
                init={{ project: 'plan', week: store.P.TODAY_WEEK - 3 }}
                onClose={vi.fn()}
              />
            )}
          />
        </TooltipProvider>,
      ),
    )
    await settle()
    if (expanded) await press(q('[data-milestone-past-toggle]'))
    await typeInto(q('[data-milestone-new]') as HTMLInputElement, 'Old review')
    await press(button('Add'))
    expect(window.showToast).toHaveBeenLastCalledWith(toast)
    expect(q('[data-milestone-section="upcoming"]')?.textContent).not.toContain('Old review')
    expect(namesOf('past')).toEqual(pastNames)
  })

  it("shows Past's disclosure once a past add is painted, where Upcoming had moved on", async () => {
    fixture({ up: 6 })
    await start({ batch: 2, rows: 4 })
    await act(async () =>
      root.render(
        <TooltipProvider>
          <Live
            page={() => (
              <modals.MilestoneModal
                init={{ project: 'plan', week: store.P.TODAY_WEEK - 2 }}
                onClose={vi.fn()}
              />
            )}
          />
        </TooltipProvider>,
      ),
    )
    await settle()
    expect(q('[data-milestone-past-toggle]')).toBeNull()
    await press(q('[data-milestone-more]'))
    await press(q('[data-milestone-more]'))
    expect(q('[data-milestone-dropped]')).not.toBeNull()
    await typeInto(q('[data-milestone-new]') as HTMLInputElement, 'Kickoff')
    await press(button('Add'))
    expect(q('[data-milestone-past-toggle]')).not.toBeNull()
  })

  it('paints a rename and a move at once', async () => {
    fixture({ up: 3 })
    let resolve: (v: unknown) => void = () => {}
    await start()
    network.mutation.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    await open({ project: 'plan' })
    await press(q('[data-milestone-row="u2"] button[aria-label^="Edit"]'))
    await typeInto(nameBox(), 'Step two, renamed')
    await press(button('Save'))
    await act(async () => resolve(null))
    await settle()
    // the server's copy still holds the old name: the row shows the paint
    expect(q('[data-milestone-editor]')).toBeNull()
    expect(namesOf('upcoming')).toEqual(['Step 1', 'Step two, renamed', 'Step 3'])
    // a drag on the Roadmap moves u3 into the past while the window shows
    await act(async () => store.P.setMilestone('u3', store.P.TODAY_WEEK - 1))
    await settle()
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
  })
})

describe('an open editor whose row moves', { timeout: 30_000 }, () => {
  it('keeps its place, draft and node when its milestone leaves Upcoming, and saves against its own read', async () => {
    fixture({ up: 3 })
    await start()
    const writes: { args: Record<string, unknown>; reject: (e: unknown) => void }[] = []
    network.mutation.mockImplementation((ref, args) =>
      getFunctionName(ref) === 'projects:updateMilestone'
        ? new Promise((_, reject) => writes.push({ args, reject }))
        : Promise.resolve(null),
    )
    await open({ project: 'plan' })
    await press(q('[data-milestone-row="u2"] button[aria-label^="Edit"]'))
    const editor = q('[data-milestone-editor="u2"]')
    await typeInto(nameBox(), 'Step two, drafted')
    // someone else moves it into the past
    moveOnServer('u2', mondayIn(-2))
    server.milestones[1].name = 'Step two, theirs'
    await rerun()
    expect(q('[data-milestone-editor="u2"]')).toBe(editor)
    expect(shown('upcoming')).toEqual(['u1', 'u2', 'u3'])
    expect(nameBox()?.value).toBe('Step two, drafted')
    // the window reads the milestone no section shows on its own
    const kept = live(subs).filter((s) => s.name === 'milestones:get')
    expect(kept.map((s) => s.args)).toEqual([{ id: 'u2' }])
    // the first Save goes against what the editor showed as it opened
    await press(button('Save'))
    expect(writes).toHaveLength(1)
    expect(writes[0].args).toMatchObject({
      id: 'u2',
      patch: { name: 'Step two, drafted' },
      expected: { name: 'Step 2' },
    })
    writes[0].reject(
      new ConvexError({
        code: 'conflict',
        reason: FIELD_CHANGED,
        message: 'the name of the milestone changed since you read it',
        changes: [{ record: 'milestone', id: 'u2', field: 'name', by: 'someone', at: AT }],
      }),
    )
    await settle()
    expect(q('[data-milestone-editor="u2"]')).toBe(editor)
    expect(nameBox()?.value).toBe('Step two, drafted')
    // the draft rebased on its own read's row, so the next Save replaces theirs
    await press(button('Save'))
    expect(writes).toHaveLength(2)
    expect(writes[1].args).toMatchObject({
      id: 'u2',
      patch: { name: 'Step two, drafted' },
      expected: { name: 'Step two, theirs' },
    })
  })

  it('closes and says so when the kept milestone is gone', async () => {
    fixture({ up: 2 })
    await start()
    await open({ project: 'plan' })
    await press(q('[data-milestone-row="u2"] button[aria-label^="Edit"]'))
    server.milestones = server.milestones.filter((m) => m.id !== 'u2')
    await rerun()
    // the section no longer holds it; its own read answers null
    await rerun()
    expect(q('[data-milestone-editor]')).toBeNull()
    expect(q('[data-milestone-open="gone"]')?.textContent).toBe(
      'This milestone is no longer here. It was deleted, or you can no longer open it.',
    )
  })

  it.each([
    ['a later', () => moveOnServer('u2', mondayIn(3)), ['u1', 'u3', 'u2']],
    [
      'an earlier',
      () => {
        moveOnServer('u1', mondayIn(1))
        server.milestones[0].name = 'Zed 1'
      },
      ['u2', 'u1', 'u3'],
    ],
  ])(
    'keeps the draft and focus of an editor that moves to %s place in its section',
    async (_, move, order) => {
      fixture({ up: 3 })
      await start()
      await open({ project: 'plan' })
      await press(q('[data-milestone-row="u2"] button[aria-label^="Edit"]'))
      const editor = q('[data-milestone-editor="u2"]')
      await typeInto(nameBox(), 'Step two, drafted')
      nameBox()?.focus()
      expect(document.activeElement).toBe(nameBox())
      move()
      await rerun()
      expect(shown('upcoming')).toEqual(order)
      expect(q('[data-milestone-editor="u2"]')).toBe(editor)
      expect(nameBox()?.value).toBe('Step two, drafted')
      expect(document.activeElement).toBe(nameBox())
    },
  )
})

describe('opened on a milestone', { timeout: 30_000 }, () => {
  it('says it is loading until the milestone and Upcoming answered, then shows the editor in its place', async () => {
    fixture({ up: 3 })
    force = { upcoming: 'loading' }
    await start()
    await open({ id: 'u2', project: 'plan' })
    expect(q('[data-milestone-open]')?.textContent).toBe('Loading this milestone…')
    expect(q('[data-milestone-window]')?.getAttribute('data-milestone-open-state')).toBe('loading')
    expect(q('[data-milestone-editor]')).toBeNull()
    expect(sectionOf('upcoming')).toBeNull()
    // Upcoming reads beside the milestone, for the project the opener named
    expect(live(sectionSubs('upcoming'))).toHaveLength(1)
    force = {}
    await rerun()
    expect(shown('upcoming')).toEqual(['u1', 'u2', 'u3'])
    expect(q('[data-milestone-section="upcoming"] [data-milestone-editor="u2"]')).not.toBeNull()
    expect(q('[data-milestone-window]')?.getAttribute('data-milestone-open-state')).toBe('ok')
  })

  it("asks the answer's project once the opener named another", async () => {
    fixture({
      up: 1,
      edit: (s) => {
        s.projects.push({ ...s.projects[0], id: 'other', key: 'OTH', num: 3, name: 'Other' })
      },
    })
    await start()
    await open({ id: 'u1', project: 'other' })
    expect(live(sectionSubs('upcoming')).map((s) => s.args.projects)).toEqual([['plan']])
    expect(shown('upcoming')).toEqual(['u1'])
  })

  it('shows the opened milestone above the sections where Upcoming fails, with its line', async () => {
    fixture({ up: 2 })
    force = { upcoming: 'error' }
    await start()
    await open({ id: 'u1' })
    expect(q('[data-milestone-top] [data-milestone-editor="u1"]')).not.toBeNull()
    expect(noteOf('upcoming')).toEqual(["failed: Couldn't load milestones.Retry"])
  })

  it('keeps the opened editor and its draft in Upcoming when its milestone moves into the past', async () => {
    fixture({ up: 2 })
    await start()
    await open({ id: 'u1' })
    const editor = q('[data-milestone-editor="u1"]')
    await typeInto(nameBox(), 'Kept draft')
    nameBox()?.focus()
    moveOnServer('u1', mondayIn(-3))
    await rerun()
    expect(q('[data-milestone-editor="u1"]')).toBe(editor)
    expect(sectionOf('upcoming')?.contains(editor)).toBe(true)
    expect(nameBox()?.value).toBe('Kept draft')
    expect(document.activeElement).toBe(nameBox())
  })
})

describe('rights', { timeout: 30_000 }, () => {
  it('shows a Viewer the sections with no Edit and no add row', async () => {
    fixture({
      up: 2,
      past: 1,
      edit: (s) => {
        s.profiles[0].org_role = 'viewer'
        s.access.push({ project_id: 'plan', profile_id: s.profiles[0].id, level: 'viewer' })
      },
    })
    await start()
    await open({ project: 'plan' })
    expect(shown('upcoming')).toEqual(['u1', 'u2'])
    expect(q('button[aria-label^="Edit"]')).toBeNull()
    expect(q('[data-milestone-new]')).toBeNull()
  })

  it('shows no section for a project the store does not hold', async () => {
    fixture({ up: 1 })
    await start()
    await open({ project: 'missing' })
    expect(sectionOf('upcoming')).toBeNull()
    expect(sectionSubs()).toHaveLength(0)
  })
})

describe('tasks on demand', { timeout: 30_000 }, () => {
  it('reads no task as the window opens from an Overview row, Past expands, a search runs and Load more grows', async () => {
    fixture({ up: 3, past: 3 })
    const { TASKS } = await import('../store/liveParts')
    TASKS.atBoot = false
    try {
      await start({ batch: 2, rows: 4 })
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
          const found = q('[data-overview-milestone="u1"]')
          if (!found) throw new Error('missing the Overview row')
          return found
        },
        { timeout: 10_000 },
      )
      await press(row)
      await press(q('[data-milestone-past-toggle]'))
      await press(q('[data-milestone-section="past"] [data-milestone-more]'))
      await typeInto(
        q('[data-milestone-section="past"] [data-milestone-search]') as HTMLInputElement,
        'audit',
      )
      await searchSettles()
      await press(q('[data-milestone-section="upcoming"] [data-milestone-more]'))
      expect(shown('past').length).toBeGreaterThan(0)
      expect(store.__layerProbe?.asks()).toEqual([])
      expect(store.__layerProbe?.faults()).toEqual([])
    } finally {
      TASKS.atBoot = true
    }
  })
})
