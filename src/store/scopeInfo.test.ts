import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Whole } from './guard/liveDouble.setup'
import { plannerFixture } from './plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  NAV_UNCHECKED,
} from './projectNavStandIn.setup'
import { scopeGroups } from './scopeGroups'
import type { ProjectFacts } from './viewModels'

/* The scope the Overview, the Board and the Roadmap share (store/planner.ts
   P.scopeInfo) on the real store, which holds no project: its identity and
   facts come from the project cache, and its state is the worse of the
   scope's and its top-level project's cache states, so only a current
   answer that leaves one of them out loses it and a scope the cache has
   not answered reads as loading, never as lost. And the groups a view
   shows its scope in (store/scopeGroups.ts), from the view's own answer:
   a group whose project the cache has not answered keeps its rows under a
   loading heading, never drops them. Everyday values: a project with 3
   sub-projects; one case raises the sub-projects under one project to
   their design size, 30. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { forceProjectNav(force: 'client' | null): void },
}))
vi.mock('../lib/convex', async () => {
  double.live = (await import('./guard/liveDouble.setup')).liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const NOW = '2026-09-14T08:00:00.000Z'

/** The fixture's organization with Plan, a top-level project the caller
    leads, its three sub-projects, and Hidden, which the caller cannot
    open. */
function world() {
  const snap = plannerFixture()
  const org = snap.orgs[0].id
  const me = snap.profiles[0].id
  snap.profiles[0].org_role = 'user'
  let num = 10
  const project = (name: string, extra: Partial<Whole['projects'][number]> = {}) => ({
    id: crypto.randomUUID(),
    org_id: org,
    type: 'meta' as const,
    key: `K${num}`,
    num: num++,
    name,
    description: '',
    sort_order: num,
    track_delay: true,
    created_at: NOW,
    ...extra,
  })
  const plan = project('Plan', { lead_id: me })
  const subs = ['Alpha', 'Beta', 'Gamma'].map((name) =>
    project(name, { type: 'project', parent_id: plan.id }),
  )
  const hidden = project('Hidden')
  snap.projects = [plan, ...subs, hidden]
  snap.access = []
  return { snap, plan, subs, hidden }
}

/** A fresh store on `snap`, whose project cache reads the navigation
    stand-in answers with `force`. */
async function start(snap: Whole, force: ForcedProjectNav = {}) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail, { force })
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./planner')
  // the cases answer the cache's reads themselves, with `force`
  double.live?.forceProjectNav('client')
  await store.initStore()
  return store.P
}

describe("the scope's identity and state (P.scopeInfo)", () => {
  it('answers My view as itself, ok and naming no project', async () => {
    const { snap } = world()
    const P = await start(snap)
    expect(P.scopeInfo(P.MINE_SCOPE)).toMatchObject({
      mine: true,
      name: 'My view',
      proj: null,
      meta: null,
      topId: null,
      state: 'ok',
    })
  })

  it('reads a project scope as loading with no facts until the cache answers, then ok with its facts', async () => {
    const { snap, plan, subs } = world()
    const P = await start(snap)
    // must fail for a scope shown as lost before an answer
    expect(P.scopeInfo(subs[0].id)).toMatchObject({
      mine: false,
      name: '',
      proj: null,
      topId: null,
      state: 'loading',
    })
    P.nameProjects('scope', [subs[0].id])
    await vi.waitFor(() => expect(P.scopeInfo(subs[0].id).state).toBe('ok'))
    const info = P.scopeInfo(subs[0].id)
    expect(info).toMatchObject({ name: 'Alpha', isMeta: false, topId: plan.id })
    expect(info.proj?.parent).toBe(plan.id)
    expect(info.meta?.id).toBe(plan.id)
    // a top-level project is its own top-level project
    P.nameProjects('scope', [plan.id])
    await vi.waitFor(() => expect(P.scopeInfo(plan.id).state).toBe('ok'))
    expect(P.scopeInfo(plan.id)).toMatchObject({ isMeta: true, topId: plan.id })
    expect(P.scopeInfo(plan.id).meta?.id).toBe(plan.id)
  })

  it('reads a seeded scope as loading with the seed’s facts, which the views ask with', async () => {
    const { snap, plan, subs } = world()
    const P = await start(snap, { byIdsLoading: true })
    P.seedProjects([
      {
        id: subs[1].id,
        org_id: subs[1].org_id,
        name: 'Beta',
        num: subs[1].num,
        parent_id: plan.id,
      },
    ])
    P.nameProjects('scope', [subs[1].id])
    const info = P.scopeInfo(subs[1].id)
    expect(info.state).toBe('loading')
    expect(info.name).toBe('Beta')
    expect(info.proj?.org).toBe(subs[1].org_id)
    // a seed gives no level
    expect(P.canWrite(subs[1].id)).toBe(false)
  })

  it('reads gone only where a current answer leaves the project out', async () => {
    const { snap, hidden } = world()
    const P = await start(snap)
    expect(P.scopeInfo(hidden.id).state).toBe('loading')
    P.nameProjects('scope', [hidden.id])
    await vi.waitFor(() => expect(P.scopeInfo(hidden.id).state).toBe('gone'))
    expect(P.scopeInfo(hidden.id).proj).toBeNull()
  })

  it('reads the refusal as unchecked and a failed read as failed, never as gone', async () => {
    const { snap, subs } = world()
    for (const [force, state] of [
      [{ unchecked: NAV_UNCHECKED }, 'unchecked'],
      [{ fail: true }, 'failed'],
      [{ byIdsLoading: true }, 'loading'],
    ] as const) {
      const P = await start(snap, force)
      P.nameProjects('scope', [subs[2].id])
      await vi.waitFor(() => expect(P.scopeInfo(subs[2].id).state).toBe(state))
      expect(P.canWrite(subs[2].id)).toBe(false)
    }
  })
})

describe("a view's groups from its own answer (scopeGroups)", () => {
  /** Facts of a project `id` named `name`, a sub-project of `parent`, or a
      top-level project without one. */
  const facts = (id: string, name: string, parent?: string): ProjectFacts => ({
    id,
    org: 'org',
    name,
    num: 1,
    parent,
    type: parent ? 'project' : 'meta',
    trackDelay: true,
    lead: undefined,
    reviewHours: undefined,
  })
  const known = (...list: ProjectFacts[]) => {
    const byId = new Map(list.map((f) => [f.id, f]))
    return (id: string) => byId.get(id)
  }
  const project = { mine: false, id: 'plan', isMeta: true }
  const sub = { mine: false, id: 'alpha', isMeta: false }
  const mine = { mine: true, id: 'mine', isMeta: false }

  it("gives a top-level project's scope a group per sub-project its answer names, in the answer's order, and none before an answer", () => {
    const f = known(
      facts('plan', 'Plan'),
      facts('beta', 'Beta', 'plan'),
      facts('alpha', 'Alpha', 'plan'),
    )
    expect(scopeGroups(project, null, f)).toEqual([])
    const groups = scopeGroups(project, { projects: ['beta', 'alpha', 'beta'] }, f)
    expect(groups.map((g) => [g.id, g.proj?.name, g.subIds])).toEqual([
      ['beta', 'Beta', ['beta']],
      ['alpha', 'Alpha', ['alpha']],
    ])
  })

  it("gives a sub-project's scope itself, whatever its answer names", () => {
    const f = known(facts('alpha', 'Alpha', 'plan'))
    expect(scopeGroups(sub, { projects: ['other'] }, f)).toEqual([
      { id: 'alpha', proj: f('alpha'), subIds: ['alpha'] },
    ])
  })

  it('keeps a group whose project the cache has not answered, under a loading heading', () => {
    const f = known(facts('plan', 'Plan'), facts('alpha', 'Alpha', 'plan'))
    // must fail for a group dropped while its project loads
    const groups = scopeGroups(project, { projects: ['alpha', 'beta'] }, f)
    expect(groups.map((g) => [g.id, g.proj?.name ?? null])).toEqual([
      ['alpha', 'Alpha'],
      ['beta', null],
    ])
  })

  it('folds My view under the top-level projects, the kept ones first, and keeps a sub-project whose parent loads in a loading group of its own', () => {
    const f = known(
      facts('plan', 'Plan'),
      facts('ops', 'Ops'),
      facts('alpha', 'Alpha', 'plan'),
      facts('bench', 'Bench', 'ops'),
      facts('gamma', 'Gamma', 'plan'),
    )
    const groups = scopeGroups(
      mine,
      { tops: ['ops'], subs: ['alpha', 'bench', 'loose', 'gamma', 'alpha'] },
      f,
    )
    expect(groups.map((g) => [g.id, g.proj?.name ?? null, g.subIds])).toEqual([
      ['ops', 'Ops', ['bench']],
      ['plan', 'Plan', ['alpha', 'gamma']],
      // a sub-project the cache has not answered stands for itself, with
      // its rows, never under a wrong heading
      ['loose', null, ['loose']],
    ])
  })

  it("gives the Board 30 lanes from one answer for a project's 30 sub-projects, the figure under one project", () => {
    const ids = Array.from({ length: 30 }, (_, n) => `sub-${n}`)
    const f = known(facts('plan', 'Plan'), ...ids.map((id, n) => facts(id, `Module ${n}`, 'plan')))
    const groups = scopeGroups(project, { projects: ids }, f)
    expect(groups).toHaveLength(30)
    expect(groups.every((g) => g.proj !== null && g.subIds.length === 1)).toBe(true)
  })
})
