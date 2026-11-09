// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { Activity, act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { answerProjectNav, isProjectNavRead, NAV_UNCHECKED } from '../store/projectNavStandIn.setup'
import { Button } from './ui/button'

/* The open rule of the lists on the navigation reads
   (components/projectNavRows.tsx useNavOpen and openResolved), which the
   All projects directory, the sidebar's tree, Search's project results and
   the project chooser share, on the real store. The store holds no
   project, so a press opens the row's project at once with its facts
   seeded into the project cache, and App's scope check (P.scopeInfo)
   decides what the main pane shows. projectNav.resolve, which startup's
   check of an address by number reads (openResolved), is a one-shot query
   the test answers itself. Everyday size: a handful of projects. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { hold(org: string | null): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('../store/guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

/** A resolve the test answers: its arguments, and how to answer it. */
type Ask = {
  args: unknown
  ok: (id: string) => void
  answer: (value: unknown) => void
  fail: () => void
}

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let publish: (next: Snapshot) => void
let asks: Ask[]
let go: ReturnType<typeof vi.fn<(id: string) => void>>
let rows: typeof import('./projectNavRows')
let store: typeof import('../store/planner')
let ORG: string

/** The fixture with its projects cleared and the person a user. */
function base(): Snapshot {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  next.profiles[0] = { ...next.profiles[0], org_role: 'user' }
  next.projects = []
  return next
}

/** Lets answers and renders land, timers included. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await vi.advanceTimersByTimeAsync(0))
}

/** Boots the real store on `next`. */
async function load(next: Snapshot) {
  vi.resetModules()
  snap = next
  asks = []
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publish = (value) => {
        snap = value
        receive(structuredClone(value))
      }
      publish(next)
    } else if (isProjectNavRead(name)) answerProjectNav(snap, name, args, receive, fail)
    return () => {}
  })
  network.query.mockImplementation((ref, args) => {
    if (getFunctionName(ref) !== 'projectNav:resolve') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      asks.push({
        args,
        answer: resolve,
        ok: (id) =>
          resolve({
            state: 'ok',
            project: { id, org_id: ORG, name: 'Answered', num: 1, parent: null, favorite: false },
          }),
        fail: () => reject(new Error('the read failed')),
      })
    })
  })
  // a project's rename never answers, so its paint waits; the boot's own
  // writes answer
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'projects:update' ? new Promise(() => {}) : Promise.resolve(null),
  )
  store = await import('../store/planner')
  await store.initStore()
  rows = await import('./projectNavRows')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** Rows that open through the rule, with the line it says. */
function Opener({ list }: { list: { id: string; name: string; org_id: string; num: number }[] }) {
  const [line, setLine] = useState<string | null>(null)
  const nav = rows.useNavOpen(go, setLine)
  return (
    <div>
      {list.map((row) => (
        <Button
          key={row.id}
          type="button"
          noTooltip
          data-open={row.id}
          onClick={() => nav.open(row)}
        >
          {row.name}
        </Button>
      ))}
      <Button type="button" noTooltip data-cancel onClick={() => nav.cancel()}>
        Cancel
      </Button>
      <p data-line>{line}</p>
    </div>
  )
}

/** Renders the rows, shown or hidden as a kept page is (Activity). */
async function render(
  list: { id: string; name: string; org_id: string; num: number }[],
  mode: 'visible' | 'hidden' = 'visible',
) {
  await act(async () =>
    root.render(
      <Activity mode={mode}>
        <Opener list={list} />
      </Activity>,
    ),
  )
  await settle()
}

const line = () => document.querySelector('[data-line]')?.textContent ?? ''
const press = async (id: string) => {
  await act(async () => document.querySelector<HTMLElement>(`[data-open="${id}"]`)?.click())
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  go = vi.fn<(id: string) => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  double.live?.hold(null)
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  network.query.mockReset()
  network.onUpdate.mockReset()
  network.mutation.mockReset()
})

const ORG_OF = () => store.P.homeOrg
const row = (id: string, name: string, num: number) => ({ id, name, num, org_id: ORG_OF() })

describe('the open rule', { timeout: 30_000 }, () => {
  it('opens any row at once with its facts seeded, reading no resolve', async () => {
    await load(base())
    await render([row('far', 'Far away', 7)])
    await press('far')
    expect(go).toHaveBeenCalledWith('far')
    expect(asks).toHaveLength(0)
    // the seeded facts name it before the project cache answers
    expect(store.P.project('far')).toMatchObject({ name: 'Far away', num: 7, org: ORG_OF() })
    // must fail: a seed gives no level, so nothing is offered for it yet
    expect(store.P.canWrite('far')).toBe(false)
    expect(line()).toBe('')
  })

  it("seeds a sub-project's row with its parent, so the scope names its top-level project", async () => {
    await load(base())
    seedRow({
      id: 'sub',
      org_id: ORG_OF(),
      name: 'Sub',
      num: 9,
      parent: { id: 'top', org_id: ORG_OF(), name: 'Top', num: 8 },
    })
    expect(store.P.project('sub')?.parent).toBe('top')
    expect(store.P.project('top')?.name).toBe('Top')
  })

  it('resolves an address by number into the project it names, with its facts seeded', async () => {
    await load(base())
    let opened: unknown = null
    rows.openResolved({ org_id: ORG_OF(), num: 3 }, (o) => {
      opened = o
    })
    await settle()
    expect(asks).toHaveLength(1)
    asks[0].ok('resolved')
    await settle()
    expect(opened).toEqual({ state: 'open', id: 'resolved' })
    expect(store.P.project('resolved')?.name).toBe('Answered')
  })

  it('answers unavailable, the refusal and a failure apart, opening nothing', async () => {
    await load(base())
    const got: unknown[] = []
    rows.openResolved({ org_id: ORG_OF(), num: 3 }, (o) => got.push(o))
    rows.openResolved({ org_id: ORG_OF(), num: 4 }, (o) => got.push(o))
    rows.openResolved({ org_id: ORG_OF(), num: 5 }, (o) => got.push(o))
    await settle()
    asks[0].answer({ state: 'unavailable' })
    asks[1].answer({ state: 'unavailable', reason: 'access_unchecked', message: NAV_UNCHECKED })
    asks[2].fail()
    await settle()
    expect(got).toEqual([
      { state: 'unavailable' },
      { state: 'unchecked', message: NAV_UNCHECKED },
      { state: 'failed' },
    ])
  })
})

/** Seeds a row through the rule's own helper. */
const seedRow = (r: Parameters<typeof rows.seedNavRow>[0]) => rows.seedNavRow(r)
