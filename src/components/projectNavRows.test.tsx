// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { Activity, act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { answerProjectNav, isProjectNavRead, NAV_UNCHECKED } from '../store/projectNavStandIn.setup'

/* The open rule of the lists on the navigation reads
   (components/projectNavRows.tsx useNavOpen and openResolved), which the
   All projects directory, the sidebar's tree, Search's project results and
   the project chooser share, on the real store. projectNav.resolve is a
   one-shot query the test answers itself, as it chooses, so a case can
   answer ok for a project the workspace does not hold yet and order that
   answer against the workspace's deliveries as Convex does: a delivery and
   the answer of one transition, an answer while a painted write waits, an
   answer while a new seat's parts are still on their way, and an answer
   while every task loads. Everyday size: a handful of projects. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { hold(org: string | null): void; holdWindow(from: string | null): void },
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

const NOW = '2026-09-14T08:00:00.000Z'
// where the last task window starts, which a load of every task holds
const LAST_WINDOW = 'fc000000'

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

let num = 10
/** Adds a top-level project to `next` with a grant for the person's seat
    in `org`, answering its id. */
function top(next: Snapshot, name: string, org = ORG) {
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
  if (seat) next.access.push({ project_id: id, profile_id: seat.id, level: 'user' })
  return id
}

/** The fixture with its projects cleared and the person a user. */
function base(): Snapshot {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  next.profiles[0] = { ...next.profiles[0], org_role: 'user' }
  next.projects = []
  return next
}

/** A copy of `next` delivered a minute later, for a case to add to. */
function later(next: Snapshot): Snapshot {
  const copy = structuredClone(next)
  copy.delivered_at = new Date(Date.parse(next.delivered_at) + 60_000).toISOString()
  return copy
}

/** `next` with a seat in Partner Co added, answering the organization's id. */
function withPartner(next: Snapshot): string {
  const away = crypto.randomUUID()
  const seat = crypto.randomUUID()
  next.orgs.push({ ...next.orgs[0], id: away, name: 'Partner Co', slug: 'partner' })
  next.profiles.push({ ...next.profiles[0], id: seat, org_id: away, org_role: 'user' })
  next.myProfileIds.push(seat)
  return away
}

/** Lets answers and renders land, timers included. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await vi.advanceTimersByTimeAsync(0))
}

/** Boots the real store on `next`; with `loading`, every task's load
    stays on its way. */
async function load(next: Snapshot, loading = false) {
  vi.resetModules()
  // 12,800 task numbers make 64 task windows, the last held on its way
  if (loading) next.orgs[0].next_issue_num = 64 * 200
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
  // tasks load on demand, as in the app, but for a load held on its way
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = loading
  if (loading) double.live?.holdWindow(LAST_WINDOW)
  store = await import('../store/planner')
  await store.initStore()
  rows = await import('./projectNavRows')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** Rows that open through the rule, with the line it says. */
function Opener({ list }: { list: { id: string; name: string }[] }) {
  const [line, setLine] = useState<string | null>(null)
  const nav = rows.useNavOpen(go, setLine)
  return (
    <div>
      {list.map((row) => (
        <button key={row.id} type="button" data-open={row.id} onClick={() => nav.open(row)}>
          {row.name}
        </button>
      ))}
      <button type="button" data-cancel onClick={() => nav.cancel()}>
        Cancel
      </button>
      <p data-line>{line}</p>
    </div>
  )
}

/** Renders the rows, shown or hidden as a kept page is (Activity). */
async function render(
  list: { id: string; name: string }[],
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
  double.live?.holdWindow(null)
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

describe('the open rule', { timeout: 30_000 }, () => {
  it('opens a project the workspace holds at once, reading nothing', async () => {
    const next = base()
    const plan = top(next, 'Plan')
    await load(next)
    await render([{ id: plan, name: 'Plan' }])
    await press(plan)
    expect(go).toHaveBeenCalledExactlyOnceWith(plan)
    expect(asks).toEqual([])
    expect(line()).toBe('')
  })

  it('opens one it does not hold once the server says so and the delivery that brings it lands with the answer', async () => {
    const next = base()
    await load(next)
    const after = later(next)
    const late = top(after, 'Late arrival')
    await render([{ id: late, name: 'Late arrival' }])
    await press(late)
    expect(line()).toBe('Opening Late arrival…')
    // the id alone, never beside an organization
    expect(asks.map((a) => a.args)).toEqual([{ project_id: late }])
    expect(go).not.toHaveBeenCalled()
    // the projects part's delivery and the answer of one transition
    await act(async () => {
      publish(after)
      asks[0].ok(late)
    })
    expect(go).toHaveBeenCalledExactlyOnceWith(late)
    expect(line()).toBe('')
  })

  it('says each answer it cannot open on, and opens nothing', async () => {
    const next = base()
    await load(next)
    const late = crypto.randomUUID()
    await render([{ id: late, name: 'Late arrival' }])
    const tries: [(ask: Ask) => void, string][] = [
      [(a) => a.answer({ state: 'unavailable' }), 'You can no longer open Late arrival.'],
      [
        (a) =>
          a.answer({ state: 'unavailable', reason: 'access_unchecked', message: NAV_UNCHECKED }),
        NAV_UNCHECKED,
      ],
      [(a) => a.fail(), "Couldn't open Late arrival. Try again."],
      // the server's ok while the workspace, current, does not hold it
      [(a) => a.ok(late), 'Late arrival has not loaded yet. Try again in a moment.'],
    ]
    for (const [answer, said] of tries) {
      await press(late)
      expect(line()).toBe('Opening Late arrival…')
      await act(async () => answer(asks[asks.length - 1]))
      await settle()
      expect(line()).toBe(said)
    }
    expect(asks).toHaveLength(4)
    expect(go).not.toHaveBeenCalled()
  })

  it('waits once for a second press, lets another row replace the wait, and drops it on cancel', async () => {
    const next = base()
    await load(next)
    const after = later(next)
    const a = top(after, 'Alpha')
    const b = top(after, 'Beta')
    await render([
      { id: a, name: 'Alpha' },
      { id: b, name: 'Beta' },
    ])
    await press(a)
    await press(a)
    expect(asks).toHaveLength(1)
    await press(b)
    expect(asks).toHaveLength(2)
    expect(line()).toBe('Opening Beta…')
    // the replaced wait opens nothing when its answer comes
    await act(async () => {
      publish(after)
      asks[0].ok(a)
    })
    await settle()
    expect(go).not.toHaveBeenCalled()
    expect(line()).toBe('Opening Beta…')
    await act(async () => document.querySelector<HTMLElement>('[data-cancel]')?.click())
    await act(async () => asks[1].ok(b))
    await settle()
    expect(go).not.toHaveBeenCalled()
  })

  it('drops the wait when its caller hides or goes, so nothing opens in a place the person left', async () => {
    const next = base()
    await load(next)
    const after = later(next)
    const late = top(after, 'Late arrival')
    const gone = top(after, 'Gone too')
    const list = [
      { id: late, name: 'Late arrival' },
      { id: gone, name: 'Gone too' },
    ]
    await render(list)
    await press(late)
    // hidden, as a kept page or the tree under Settings is
    await render(list, 'hidden')
    await act(async () => {
      publish(after)
      asks[0].ok(late)
    })
    await settle()
    await render(list)
    expect(go).not.toHaveBeenCalled()
    // and gone, as the palette closing; the workspace holds Late arrival now
    const more = later(after)
    const last = top(more, 'Last one')
    await render([{ id: last, name: 'Last one' }])
    await press(last)
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      publish(more)
      asks[1].ok(last)
    })
    await settle()
    expect(go).not.toHaveBeenCalled()
  })
})

describe('the wait for the workspace, in the order Convex delivers', { timeout: 30_000 }, () => {
  it('decides after the repaint a painted write holds back, which brings the project', async () => {
    const next = base()
    const plan = top(next, 'Plan')
    await load(next)
    const after = later(next)
    const late = top(after, 'Late arrival')
    await render([{ id: late, name: 'Late arrival' }])
    await press(late)
    // a write whose paint waits for its answer, which never comes
    void store.P.updateProject(plan, { name: 'Plan renamed' })
    await act(async () => {
      publish(after)
      asks[0].ok(late)
      // the answer's own turn, before the 0 ms timer the paint waits for
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(store.P.workspaceCurrent()).toBe(false)
    expect(store.P.project(late)).toBeUndefined()
    expect(line()).toBe('Opening Late arrival…')
    await settle()
    expect(store.P.workspaceCurrent()).toBe(true)
    expect(go).toHaveBeenCalledExactlyOnceWith(late)
  })

  it("waits while a new seat's parts are on their way, and opens once they answer", async () => {
    const next = base()
    await load(next)
    const after = later(next)
    const away = withPartner(after)
    const shared = top(after, 'Partner portal', away)
    await render([{ id: shared, name: 'Partner portal' }])
    await press(shared)
    double.live?.hold(away)
    await act(async () => {
      publish(after)
      asks[0].ok(shared)
    })
    await settle()
    expect(store.P.workspaceCurrent()).toBe(false)
    expect(line()).toBe('Opening Partner portal…')
    expect(go).not.toHaveBeenCalled()
    await act(async () => double.live?.hold(null))
    await settle()
    expect(go).toHaveBeenCalledExactlyOnceWith(shared)
  })

  it('ends a wait the workspace never answers after its bound', async () => {
    const next = base()
    await load(next)
    const after = later(next)
    const away = withPartner(after)
    const shared = top(after, 'Partner portal', away)
    await render([{ id: shared, name: 'Partner portal' }])
    await press(shared)
    double.live?.hold(away)
    await act(async () => {
      publish(after)
      asks[0].ok(shared)
    })
    await act(async () => await vi.advanceTimersByTimeAsync(rows.NAV_OPEN_WAIT_MS - 100))
    expect(line()).toBe('Opening Partner portal…')
    await act(async () => await vi.advanceTimersByTimeAsync(200))
    expect(line()).toBe('Partner portal has not loaded yet. Try again in a moment.')
    expect(go).not.toHaveBeenCalled()
  })

  it('counts a delivery while every task loads, opening a project it brings and saying at once of one it lacks', async () => {
    const next = base()
    await load(next, true)
    expect(store.P.stillLoading()).not.toBeNull()
    const after = later(next)
    const late = top(after, 'Late arrival')
    const missing = crypto.randomUUID()
    await render([
      { id: late, name: 'Late arrival' },
      { id: missing, name: 'Not delivered' },
    ])
    await press(missing)
    await act(async () => asks[0].ok(missing))
    await settle()
    // the load's report holds the projects, so it waits for no bound
    expect(line()).toBe('Not delivered has not loaded yet. Try again in a moment.')
    await press(late)
    await act(async () => {
      publish(after)
      asks[1].ok(late)
    })
    await settle()
    expect(store.P.stillLoading()).not.toBeNull()
    expect(go).toHaveBeenCalledExactlyOnceWith(late)
  })
})
