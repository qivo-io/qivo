// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* A task's holders as the task window names them (useOwnerNames): the
   store's profile at once, else people.byIds, loading until it answers,
   gone only on an answer that leaves the id out, failed on a failed read,
   and a kept name through a read with no answer, within its bound. */

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

type Names = typeof import('./ownerNames')
type Sub = {
  args: { org_id: string; ids: string[] }
  next: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}

let names: Names
let snap: Snapshot
let subs: Sub[]
let container: HTMLDivElement
let root: Root

const row = (id: string, name: string) => ({
  id,
  name,
  org_role: 'user',
  kind: 'person',
  active: true,
  pending: false,
  color: '#335577',
  initials: 'XX',
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
  const store = await import('../store/planner')
  await store.initStore()
  names = await import('./ownerNames')
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

/** Renders the names of `ids` and answers what they show, as text. */
async function show(ids: string[], org = snap.orgs[0].id) {
  function Names() {
    const shown = names.useOwnerNames(org, ids)
    return (
      <ul>
        {shown.map((n) => (
          <li key={n.id}>{n.state === 'ok' ? `${n.id}:${n.name}` : `${n.id}:${n.state}`}</li>
        ))}
      </ul>
    )
  }
  await act(async () => root.render(<Names />))
}
const text = () => [...container.querySelectorAll('li')].map((li) => li.textContent)
const open = () => subs.filter((s) => !s.closed)

describe('useOwnerNames', () => {
  it('names a person the store holds at once, reading nothing', async () => {
    await show(['held'])
    expect(text()).toEqual(['held:Hal Held'])
    expect(subs).toEqual([])
  })

  it('reads the others by id, sorted, loading until the answer, and gone only when it leaves one out', async () => {
    await show(['zed', 'held', 'amy'])
    expect(text()).toEqual(['zed:loading', 'held:Hal Held', 'amy:loading'])
    expect(open().map((s) => s.args)).toEqual([{ org_id: snap.orgs[0].id, ids: ['amy', 'zed'] }])
    await act(async () => open()[0].next({ rows: [row('amy', 'Amy Archer')] }))
    expect(text()).toEqual(['zed:gone', 'held:Hal Held', 'amy:Amy Archer'])
  })

  it('says a failed read failed, never gone', async () => {
    await show(['zed'])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => open()[0].fail(new Error('Server Error')))
    expect(text()).toEqual(['zed:failed'])
  })

  it('keeps an answered name while a new read has no answer', async () => {
    await show(['amy'])
    await act(async () => open()[0].next({ rows: [row('amy', 'Amy Archer')] }))
    await show(['amy', 'bo'])
    // a new set of ids reads again; Amy keeps her name meanwhile
    expect(open().at(-1)?.args.ids).toEqual(['amy', 'bo'])
    expect(text()).toEqual(['amy:Amy Archer', 'bo:loading'])
  })

  it('keeps a picked person’s name, by organization', async () => {
    names.keepOwnerName(snap.orgs[0].id, { id: 'pat', name: 'Pat Picked', active: true })
    await show(['pat'])
    expect(text()).toEqual(['pat:Pat Picked'])
    await show(['pat'], 'another-org')
    expect(text()).toEqual(['pat:loading'])
  })

  // the bound lowered to 3, so the case keeps four names, not 1,001
  it('keeps at most its bound of names, the oldest dropped first', () => {
    const org = snap.orgs[0].id
    const keep = (id: string) =>
      names.keepOwnerName(org, { id, name: `Person ${id}`, active: true })
    const was = names.OWNER_NAMES.kept
    expect(was).toBe(1000)
    names.OWNER_NAMES.kept = 3
    try {
      for (const id of ['p0', 'p1', 'p2', 'p3']) keep(id)
      expect(['p0', 'p1', 'p2', 'p3'].map((id) => names.ownerNameKept(org, id))).toEqual([
        false,
        true,
        true,
        true,
      ])
      // a name kept again is the newest
      keep('p1')
      keep('p4')
      expect(['p1', 'p2', 'p3', 'p4'].map((id) => names.ownerNameKept(org, id))).toEqual([
        true,
        false,
        true,
        true,
      ])
    } finally {
      names.OWNER_NAMES.kept = was
    }
  })
})
