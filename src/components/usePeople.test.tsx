// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersonFaceRow } from '../../convex/model/peopleSettings'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The people a view shows as it names them (usePeople, through the store's
   profile cache and P.person): the store's profile at once, else
   people.byIds, loading until it answers, gone only on an answer that
   leaves the id out, failed on a failed read, a picker's name at once; and
   the names follow the component's life: named while mounted and shown,
   released on unmount and while a kept page is hidden by Activity, named
   again on return. */

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

type Hook = typeof import('./usePeople')
type Store = typeof import('../store/planner')
type Sub = {
  args: { org_id: string; ids: string[] }
  next: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}

let hook: Hook
let store: Store
let snap: Snapshot
let subs: Sub[]
let container: HTMLDivElement
let root: Root

const row = (id: string, name: string): PersonFaceRow => ({
  id,
  name,
  org_role: 'user',
  kind: 'person',
  active: true,
  pending: false,
  color: '#335577',
  initials: 'XX',
  avatar: null,
  sample_avatar: null,
  plannable_hours: 32,
})

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  snap = plannerFixture()
  snap.profiles.push({ ...snap.profiles[0], id: 'held', name: 'Hal Held', auth_user_id: 'a-held' })
  subs = []
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      next(structuredClone(snap))
      return () => {}
    }
    if (name !== 'people:byIds') return () => {}
    const sub: Sub = { args, next, fail, closed: false }
    subs.push(sub)
    return () => {
      sub.closed = true
    }
  })
  store = await import('../store/planner')
  await store.initStore()
  hook = await import('./usePeople')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The names a list of `ids` shows. */
function Names({ ids, org }: { ids: string[]; org: string }) {
  const shown = hook.usePeople(ids.map((id) => ({ org, id })))
  return (
    <ul>
      {shown.map((n) => (
        <li key={n.id}>{n.state === 'ok' ? `${n.id}:${n.name}` : `${n.id}:${n.state}`}</li>
      ))}
    </ul>
  )
}

/** Renders the names of `ids`, inside an Activity `mode`. */
async function show(ids: string[], org = snap.orgs[0].id, mode: 'visible' | 'hidden' = 'visible') {
  await act(async () =>
    root.render(
      <Activity mode={mode}>
        <Names ids={ids} org={org} />
      </Activity>,
    ),
  )
}
/** Lets the store's frame-batched repaint run. */
const frame = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)))
const text = () => [...container.querySelectorAll('li')].map((li) => li.textContent)
const open = () => subs.filter((s) => !s.closed)
const named = () => store.P.fileStats().people.named

describe('usePeople', () => {
  it('names a person the store holds at once, reading nothing', async () => {
    await show(['held'])
    expect(text()).toEqual(['held:Hal Held'])
    expect(subs).toEqual([])
  })

  it('reads the others by id in the order named, loading until the answer, and gone only when it leaves one out', async () => {
    await show(['zed', 'held', 'amy'])
    expect(text()).toEqual(['zed:loading', 'held:Hal Held', 'amy:loading'])
    expect(open().map((s) => s.args)).toEqual([{ org_id: snap.orgs[0].id, ids: ['zed', 'amy'] }])
    await act(async () => open()[0].next({ rows: [row('amy', 'Amy Archer')] }))
    await frame()
    // the face arrived and the component rendered again
    expect(text()).toEqual(['zed:gone', 'held:Hal Held', 'amy:Amy Archer'])
  })

  it("keeps a person gone while the current answer leaves them out, whatever a picker's older row says", async () => {
    const org = snap.orgs[0].id
    await show(['zed'])
    await act(async () => open()[0].next({ rows: [] }))
    await frame()
    expect(text()).toEqual(['zed:gone'])
    // a picker still holds Zed's row from before, and takes it now
    store.P.takePeople(org, [row('zed', 'Zed From Picker')])
    await frame()
    expect(store.P.person('zed', org)?.state).toBe('gone')
    expect(text()).toEqual(['zed:gone'])
    // the next answer that holds Zed names them
    await act(async () => open()[0].next({ rows: [row('zed', 'Zed Zane')] }))
    await frame()
    expect(text()).toEqual(['zed:Zed Zane'])
  })

  it('says a failed read failed, never gone', async () => {
    await show(['zed'])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => open()[0].fail(new Error('Server Error')))
    await frame()
    expect(text()).toEqual(['zed:failed'])
  })

  it('keeps an answered face while a longer list reads again', async () => {
    await show(['amy'])
    await act(async () => open()[0].next({ rows: [row('amy', 'Amy Archer')] }))
    await frame()
    await show(['amy', 'bo'])
    // the chunk reads again with Bo added; Amy keeps her face meanwhile
    expect(open().at(-1)?.args.ids).toEqual(['amy', 'bo'])
    await frame()
    expect(text()).toEqual(['amy:Amy Archer', 'bo:loading'])
  })

  it("names a picker's person at once, by organization", async () => {
    store.P.takePeople(snap.orgs[0].id, [row('pat', 'Pat Picked')])
    await frame()
    await show(['pat'])
    expect(text()).toEqual(['pat:Pat Picked'])
    await show(['pat'], 'another-org')
    expect(text()).toEqual(['pat:loading'])
  })

  it('names while mounted, releases on unmount and while hidden by Activity, and names again on return', async () => {
    await show(['zed', 'amy'])
    expect(named()).toBe(2)
    expect(open()).toHaveLength(1)
    await show(['zed', 'amy'], snap.orgs[0].id, 'hidden')
    expect(named()).toBe(0)
    expect(open()).toHaveLength(0)
    await show(['zed', 'amy'])
    expect(named()).toBe(2)
    expect(open()).toHaveLength(1)
    await act(async () => root.render(<div />))
    expect(named()).toBe(0)
    expect(open()).toHaveLength(0)
  })

  it('names the same people again without a registration when the list only renders again', async () => {
    await show(['zed', 'amy'])
    const reads = subs.length
    await show(['zed', 'amy'])
    await show(['zed', 'amy'])
    expect(subs).toHaveLength(reads)
  })
})
