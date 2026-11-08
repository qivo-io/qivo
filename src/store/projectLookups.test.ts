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

/* The store's project lookups (store/planner.ts P.project, P.heldProject,
   P.levelOn, P.canWrite, P.canSee, P.writeNote and the lookups built on
   them) on the real store, with the double leaving projects out of the
   projects part (Whole unheldProjects) while the navigation stand-in
   answers projectNav.byIds from the whole: a project the part holds
   answers from the part and is never read by id, and one it leaves out
   answers from the project cache once an owner names it, loading until
   then and never with a right before a current answer. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
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

/** The fixture's organization with a held program the caller leads and
    unheld ones: Unheld (a sub-project with User, one with Viewer), Granted
    (a top-level grant with User), Led (the caller leads it), Hidden (no
    access) and a twin of Held's name. */
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
  const held = project('Held program', { lead_id: me })
  const heldSub = project('Held sub', { type: 'project', parent_id: held.id })
  const unheld = project('Unheld program')
  const edits = project('Edits', { type: 'project', parent_id: unheld.id, track_delay: false })
  const views = project('Views', { type: 'project', parent_id: unheld.id })
  const granted = project('Granted program')
  const led = project('Led program', { lead_id: me })
  const hidden = project('Hidden program')
  const twin = project('Held program', { lead_id: me })
  snap.projects = [held, heldSub, unheld, edits, views, granted, led, hidden, twin]
  snap.access = [
    { project_id: edits.id, profile_id: me, level: 'user' },
    { project_id: views.id, profile_id: me, level: 'viewer' },
    { project_id: granted.id, profile_id: me, level: 'user' },
  ]
  snap.unheldProjects = [unheld, edits, views, granted, led, hidden, twin].map((p) => p.id)
  return { snap, org, held, heldSub, unheld, edits, views, granted, led, hidden, twin }
}

/** A fresh store on `snap`, whose byIds reads the stand-in answers with
    `force`, and the ids of every byIds subscription it opened. */
async function start(snap: Whole, force: ForcedProjectNav = {}) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  const byIds: string[][] = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (isProjectNavRead(name)) {
      if (name === 'projectNav:byIds') byIds.push([...(args as { ids: string[] }).ids])
      answerProjectNav(snap, name, args, next, fail, { force })
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./planner')
  const { PROJECT_CACHE } = await import('./projectCache')
  await store.initStore()
  return { P: store.P, byIds, PROJECT_CACHE }
}

describe('the project lookups', () => {
  it('answers a project the part holds from the part, never reading it by id', async () => {
    const w = world()
    const { P, byIds } = await start(w.snap)
    P.nameProjects('test', [w.held.id, w.heldSub.id])
    expect(P.projectState(w.heldSub.id)).toBe('held')
    expect(P.heldProject(w.heldSub.id)?.key).toBe(w.heldSub.key)
    expect(P.levelOn(w.heldSub.id)).toBe('lead')
    expect(byIds).toEqual([])
  })

  it('answers a project the part leaves out from the cache once named, loading until then, and never as held', async () => {
    const w = world()
    const { P, byIds } = await start(w.snap)
    expect(P.projectState(w.edits.id)).toBe('loading')
    expect(P.project(w.edits.id)).toBeUndefined()
    expect(P.canWrite(w.edits.id)).toBe(false)
    expect(P.writeNote(w.edits.id)).toBe('Loading this project…')
    const before = P.contextVersion
    P.nameProjects('test', [w.edits.id, w.views.id])
    expect(byIds).toEqual([[w.edits.id, w.views.id]])
    await vi.waitFor(() => expect(P.project(w.edits.id)?.name).toBe('Edits'))
    expect(P.contextVersion).not.toBe(before)
    expect(P.projectState(w.edits.id)).toBe('ok')
    expect(P.heldProject(w.edits.id)).toBeUndefined()
    expect(P.heldMeta(w.edits.id)).toBeNull()
    expect(P.project(w.edits.id)).toMatchObject({
      org: w.org,
      parent: w.unheld.id,
      type: 'project',
      trackDelay: false,
    })
    // the parent came with it, as a row of its own
    expect(P.metaOf(w.edits.id)?.id).toBe(w.unheld.id)
    expect(P.topLevelOf(w.edits.id)).toBe(w.unheld.id)
    expect(P.orgOf(w.edits.id)).toBe(w.org)
    const place = P.projectPlace(w.edits.id)
    expect(place && P.placeLabel(place)).toBe('Unheld program, Edits')
    expect(P.levelOn(w.edits.id)).toBe('user')
    expect(P.canWrite(w.edits.id)).toBe(true)
    expect(P.writeNote(w.edits.id)).toBeNull()
    expect(P.levelOn(w.views.id)).toBe('viewer')
    expect(P.canSee(w.views.id)).toBe(true)
    expect(P.canWrite(w.views.id)).toBe(false)
    expect(P.writeNote(w.views.id)).toBe('Read-only project access')
    // the parent seen only for navigation answers viewer, so a milestone
    // there takes no add
    expect(P.levelOn(w.unheld.id)).toBe('viewer')
    expect(P.canAddMilestone(w.edits.id)).toBe(false)
  })

  it('answers a cached top-level project for a milestone add and for management, and tells a cached twin from a held one', async () => {
    const w = world()
    const { P } = await start(w.snap)
    P.nameProjects('test', [w.granted.id, w.led.id, w.twin.id])
    await vi.waitFor(() => expect(P.project(w.twin.id)).toBeDefined())
    expect(P.canAddMilestone(w.granted.id)).toBe(true)
    expect(P.canManageOwnProjectAccess(w.granted.id)).toBe(false)
    expect(P.canManageOwnProjectAccess(w.led.id)).toBe(true)
    expect(P.projectTag(w.twin.id)).toBe(`#${w.twin.num}`)
    expect(P.projectTag(w.held.id)).toBe(`#${w.held.num}`)
    expect(P.projectTag(w.granted.id)).toBeNull()
  })

  it('answers gone only where the answer leaves the project out', async () => {
    const w = world()
    const { P } = await start(w.snap)
    P.nameProjects('test', [w.hidden.id])
    await vi.waitFor(() => expect(P.projectState(w.hidden.id)).toBe('gone'))
    expect(P.project(w.hidden.id)).toBeUndefined()
    expect(P.levelOn(w.hidden.id)).toBeNull()
    expect(P.writeNote(w.hidden.id)).toBe("You can't open this project.")
  })

  it('stays loading while byIds has not answered, never gone, with no right', async () => {
    const w = world()
    const { P, byIds } = await start(w.snap, { byIdsLoading: true })
    P.nameProjects('test', [w.edits.id])
    expect(byIds).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(P.projectState(w.edits.id)).toBe('loading')
    expect(P.canWrite(w.edits.id)).toBe(false)
    expect(P.canSee(w.edits.id)).toBe(false)
    expect(P.writeNote(w.edits.id)).toBe('Loading this project…')
  })

  it("says why where the read failed or the server's check stopped", async () => {
    const w = world()
    const failed = await start(w.snap, { fail: true })
    failed.P.nameProjects('test', [w.edits.id])
    await vi.waitFor(() => expect(failed.P.projectState(w.edits.id)).toBe('failed'))
    expect(failed.P.canWrite(w.edits.id)).toBe(false)
    expect(failed.P.writeNote(w.edits.id)).toBe("Couldn't load this project.")
    const stopped = await start(w.snap, { unchecked: NAV_UNCHECKED })
    stopped.P.nameProjects('test', [w.edits.id])
    await vi.waitFor(() => expect(stopped.P.projectState(w.edits.id)).toBe('unchecked'))
    expect(stopped.P.canWrite(w.edits.id)).toBe(false)
    expect(stopped.P.writeNote(w.edits.id)).toBe(NAV_UNCHECKED)
  })

  it('stops naming a project on release and keeps no stale right after it', async () => {
    const w = world()
    const { P } = await start(w.snap)
    P.nameProjects('test', [w.edits.id])
    await vi.waitFor(() => expect(P.canWrite(w.edits.id)).toBe(true))
    P.nameProjects('test', [])
    // the name stays, the right goes with the current answer
    expect(P.projectState(w.edits.id)).toBe('loading')
    expect(P.canWrite(w.edits.id)).toBe(false)
  })

  it('reads 200 named top-level projects in two chunks and keeps all 200 while named, past a lowered bound', async () => {
    const w = world()
    const org = w.org
    const me = w.snap.profiles[0].id
    const tops = Array.from({ length: 200 }, (_, i) => ({
      id: crypto.randomUUID(),
      org_id: org,
      type: 'meta' as const,
      key: `T${i}`,
      num: 1000 + i,
      name: `Top ${String(i).padStart(3, '0')}`,
      description: '',
      sort_order: 1000 + i,
      track_delay: true,
      created_at: NOW,
    }))
    w.snap.projects.push(...tops)
    w.snap.access.push(
      ...tops.map((p) => ({ project_id: p.id, profile_id: me, level: 'user' as const })),
    )
    w.snap.unheldProjects = [...(w.snap.unheldProjects ?? []), ...tops.map((p) => p.id)]
    const { P, byIds, PROJECT_CACHE } = await start(w.snap)
    PROJECT_CACHE.most = 50
    try {
      P.nameProjects(
        'test',
        tops.map((p) => p.id),
      )
      expect(byIds.map((ids) => ids.length)).toEqual([100, 100])
      await vi.waitFor(() => expect(tops.every((p) => P.projectState(p.id) === 'ok')).toBe(true))
      expect(P.cacheStats().cached).toBe(200)
    } finally {
      PROJECT_CACHE.most = 2_000
    }
  })
})
