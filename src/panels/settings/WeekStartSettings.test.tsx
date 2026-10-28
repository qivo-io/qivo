// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEEK_START_REFUSALS } from '../../../convex/lib/limits'
import { TooltipProvider } from '../../components/ui/tooltip'
import { plannerFixture } from '../../store/plannerFixture.setup'

/* "Workdays start on" in Organization settings, on the real store. The
   server refuses a first day of the week that would put two milestones of
   one project in one week (convex/model/milestones.ts assertWeekStartFits);
   the setting stays and the refusal shows under it instead of a toast. */

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

type Planner = typeof import('../../store/planner')['P']

let P: Planner
let page: typeof import('./OrganizationSettings')
let version: typeof import('../../store/usePlannerVersion')
let answers: (() => Promise<unknown>)[]
let sent: number
let container: HTMLDivElement
let root: Root

const CONFLICT =
  'workdays cannot start on Sunday, because a project can have at most 1 milestone a week, and then Testbed platform (TBED) would have “Alpha” on 2026-05-10 and “Beta” on 2026-05-11 in the week of 2026-05-10 (W19). Move or delete milestones so that no project has two in one week, then change the first day again.'

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  window.showToast = vi.fn()
  const snap = plannerFixture()
  answers = []
  sent = 0
  network.query.mockResolvedValue([])
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    if (name === 'orgs:update') {
      sent++
      return answers.shift()?.() ?? Promise.resolve(null)
    }
    return new Promise(() => {})
  })
  const store = await import('../../store/planner')
  P = store.P
  await store.initStore()
  page = await import('./OrganizationSettings')
  version = await import('../../store/usePlannerVersion')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/* Re-renders on every store change, as the app's shell does. */
function Live() {
  version.usePlannerVersion()
  return <page.OrgGeneralPage setPage={vi.fn()} />
}

const render = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <Live />
      </TooltipProvider>,
    ),
  )
const select = () => container.querySelector<HTMLSelectElement>('[data-week-start]')
const refusal = () => container.querySelector('[data-week-start-refusal]')

async function choose(day: number) {
  await act(async () => {
    const field = select()
    if (!field) throw new Error('no Workdays start on field')
    field.value = String(day)
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('Workdays start on', () => {
  it('keeps the day and shows a refused change under the setting', async () => {
    await render()
    expect(select()?.value).toBe('1')
    answers.push(() =>
      Promise.reject(
        new ConvexError({ code: 'rule', reason: WEEK_START_REFUSALS.conflicts, message: CONFLICT }),
      ),
    )
    await choose(0)
    expect(refusal()?.textContent).toBe(`W${CONFLICT.slice(1)}`)
    expect(refusal()?.getAttribute('role')).toBe('alert')
    // the select shows the saved day again, which is valid; the refusal
    // still describes it
    expect(select()?.hasAttribute('aria-invalid')).toBe(false)
    expect(select()?.getAttribute('aria-describedby')).toBe('week-start-refusal')
    expect(select()?.value).toBe('1')
    expect(P.org.weekStart).toBe(1)
    expect(window.showToast).not.toHaveBeenCalled()

    // another refusal is toasted as before
    answers.push(() =>
      Promise.reject(new ConvexError({ code: 'forbidden', message: 'not an admin' })),
    )
    await choose(2)
    expect(refusal()).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )

    // a change the server takes says so
    await choose(0)
    expect(refusal()).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith('Workdays now start on Sunday')
  })

  it('waits for an answer before another choice, so the answer belongs to the day on screen', async () => {
    await render()
    let refuse = (_error: unknown) => {}
    answers.push(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        }),
    )
    await choose(0)
    expect(sent).toBe(1)
    expect(select()?.disabled).toBe(true)
    // a second choice while the first waits sends nothing
    await choose(3)
    expect(sent).toBe(1)
    await act(async () =>
      refuse(
        new ConvexError({ code: 'rule', reason: WEEK_START_REFUSALS.conflicts, message: CONFLICT }),
      ),
    )
    expect(refusal()?.textContent).toBe(`W${CONFLICT.slice(1)}`)
    expect(select()?.disabled).toBe(false)
    expect(select()?.value).toBe('1')
    // the next choice goes out against the saved day
    await choose(3)
    expect(sent).toBe(2)
    const update = network.mutation.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'orgs:update',
    )
    expect(update.at(-1)?.[1]).toMatchObject({
      patch: { week_start: 3 },
      expected: { week_start: 1 },
    })
  })

  it('toasts a refusal that comes after the page has gone', async () => {
    await render()
    let refuse = (_error: unknown) => {}
    answers.push(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        }),
    )
    await choose(0)
    await act(async () => root.render(<div />))
    await act(async () =>
      refuse(
        new ConvexError({ code: 'rule', reason: WEEK_START_REFUSALS.conflicts, message: CONFLICT }),
      ),
    )
    expect(window.showToast).toHaveBeenCalledWith(`W${CONFLICT.slice(1)} Change reverted.`, 'error')
    expect(P.org.weekStart).toBe(1)
  })
})
