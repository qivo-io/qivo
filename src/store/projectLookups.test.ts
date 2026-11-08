import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import type { RoadmapAnswer } from '../../convex/lib/roadmap'
import type { ViewRow } from '../../convex/lib/viewReads'
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
const double = vi.hoisted(() => ({
  live: null as null | { reconnect(only?: readonly string[]): void },
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
    `force`, the ids of every byIds subscription it opened, and a way to
    answer every open byIds read again from `snap` as it stands, as the
    server reruns them after an access change. The Board's and the
    Roadmap's reads answer `views.board` and `views.roadmap`, with
    `views.once` only their first subscription each, and `views.reads`
    counts each one's subscriptions by name. */
async function start(
  snap: Whole,
  force: ForcedProjectNav = {},
  views: {
    board?: BoardAnswer
    roadmap?: RoadmapAnswer
    once?: boolean
    reads?: Map<string, number>
  } = {},
) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  const byIds: string[][] = []
  const open = new Set<() => void>()
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    const count = (views.reads?.get(name) ?? 0) + 1
    views.reads?.set(name, count)
    const answers = !views.once || count === 1
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'tasks:board' && views.board) {
      if (answers) next(structuredClone(views.board))
    } else if (name === 'tasks:roadmap' && views.roadmap) {
      if (answers) next(structuredClone(views.roadmap))
    } else if (isProjectNavRead(name)) {
      const answer = () => answerProjectNav(snap, name, args, next, fail, { force })
      if (name === 'projectNav:byIds') {
        byIds.push([...(args as { ids: string[] }).ids])
        open.add(answer)
      }
      answer()
      return () => open.delete(answer)
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./planner')
  const { PROJECT_CACHE } = await import('./projectCache')
  await store.initStore()
  const rerun = () => {
    for (const answer of open) answer()
  }
  return { P: store.P, byIds, PROJECT_CACHE, rerun }
}

/** Task `id` of project `project` as a view's answer sends it. */
const viewRow = (snap: Whole, id: string, project: string): ViewRow => ({
  id,
  org_id: snap.orgs[0].id,
  project_id: project,
  num: 90,
  title: `Task ${id}`,
  status: 'todo',
  priority: 'medium',
  paused: false,
  assignee_id: snap.profiles[0].id,
  created_at: NOW,
  updated_at: NOW,
  has_subtasks: false,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
})

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

  it('names nothing of a project it answered once the answer leaves it out, as after access goes', async () => {
    const w = world()
    const { P, rerun } = await start(w.snap)
    P.nameProjects('test', [w.twin.id])
    await vi.waitFor(() => expect(P.projectState(w.twin.id)).toBe('ok'))
    expect(P.projectTag(w.twin.id)).toBe(`#${w.twin.num}`)
    expect(P.projectTag(w.held.id)).toBe(`#${w.held.num}`)
    // the caller no longer leads the twin, so the server's next answer
    // leaves it out
    const twin = w.snap.projects.find((p) => p.id === w.twin.id)
    if (!twin) throw new Error('no twin')
    twin.lead_id = undefined
    rerun()
    await vi.waitFor(() => expect(P.projectState(w.twin.id)).toBe('gone'))
    // the facts follow with the cache's repaint, a frame later
    await vi.waitFor(() => expect(P.project(w.twin.id)).toBeUndefined())
    expect(P.metaOf(w.twin.id)).toBeNull()
    expect(P.orgOf(w.twin.id)).toBe('')
    expect(P.projectTag(w.twin.id)).toBeNull()
    // the held project has no twin left to be told apart from
    expect(P.projectTag(w.held.id)).toBeNull()
    expect(P.writeNote(w.twin.id)).toBe("You can't open this project.")
  })

  it("names the projects a Board's and a Roadmap's answer name while their slots hold them", async () => {
    const w = world()
    const board: BoardAnswer = {
      state: 'ok',
      rows: [viewRow(w.snap, 'board-task', w.edits.id)],
      parents: [],
      held_projects: [w.granted.id],
    }
    const roadmap: RoadmapAnswer = {
      state: 'ok',
      rows: [viewRow(w.snap, 'roadmap-task', w.led.id)],
      parents: [],
      subtasks: [],
      held_sub_projects: [w.views.id],
      remaining: { state: 'ok', tenths: {} },
    }
    const { P } = await start(w.snap, {}, { board, roadmap })
    const read = () => P.cacheStats().reads.flat()
    P.watchBoard('board:desktop', '{"board":1}', 0, 0, false)
    await vi.waitFor(() =>
      expect(read()).toEqual(expect.arrayContaining([w.edits.id, w.granted.id])),
    )
    await vi.waitFor(() => expect(P.project(w.edits.id)?.name).toBe('Edits'))
    P.releaseView('board:desktop')
    expect(read()).toEqual([])
    P.watchRoadmap('{"roadmap":1}')
    await vi.waitFor(() => expect(read()).toEqual(expect.arrayContaining([w.led.id, w.views.id])))
    P.releaseRoadmap()
    expect(read()).toEqual([])
  })

  it("lets a kept page's projects go while it hides, and names them again from its kept answer as it shows", async () => {
    const w = world()
    const board: BoardAnswer = {
      state: 'ok',
      rows: [viewRow(w.snap, 'board-task', w.edits.id)],
      parents: [],
      held_projects: [w.granted.id],
    }
    const roadmap: RoadmapAnswer = {
      state: 'ok',
      rows: [viewRow(w.snap, 'roadmap-task', w.led.id)],
      parents: [],
      subtasks: [],
      held_sub_projects: [w.views.id],
      remaining: { state: 'ok', tenths: {} },
    }
    const reads = new Map<string, number>()
    const { P } = await start(w.snap, {}, { board, roadmap, once: true, reads })
    const named = () => P.cacheStats().reads.flat().sort()
    const sorted = (ids: readonly string[]) => [...ids].sort()
    P.watchBoard('board:desktop', '{"board":1}', 0, 0, false)
    await vi.waitFor(() => expect(named()).toEqual(sorted([w.edits.id, w.granted.id])))
    await vi.waitFor(() => expect(P.canWrite(w.edits.id)).toBe(true))
    // the Board's page hides behind the Roadmap's, as App keeps both
    P.watchBoard('board:desktop', null, 0, 0, false)
    P.watchRoadmap('{"roadmap":1}')
    await vi.waitFor(() => expect(named()).toEqual(sorted([w.led.id, w.views.id])))
    // the hidden Board's project keeps its name and gives no right
    expect(P.project(w.edits.id)?.name).toBe('Edits')
    expect(P.canWrite(w.edits.id)).toBe(false)
    // back to the Board: its projects read again at once, from the answer
    // it kept, while its own read has not answered again
    P.watchRoadmap(null)
    P.watchBoard('board:desktop', '{"board":1}', 0, 0, false)
    expect(named()).toEqual(sorted([w.edits.id, w.granted.id]))
    await vi.waitFor(() => expect(P.canWrite(w.edits.id)).toBe(true))
    expect(reads.get('tasks:board')).toBe(2)
    expect(P.boardRead('board:desktop').current).toBe(false)
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

  it('gives no right from an answer of before a reconnect until byIds answers again, keeping the name', async () => {
    const w = world()
    const { P } = await start(w.snap)
    P.nameProjects('test', [w.edits.id])
    await vi.waitFor(() => expect(P.canWrite(w.edits.id)).toBe(true))
    // the socket connects again, and no result has arrived again yet
    double.live?.reconnect(['no:query'])
    expect(P.projectState(w.edits.id)).toBe('loading')
    expect(P.canWrite(w.edits.id)).toBe(false)
    expect(P.writeNote(w.edits.id)).toBe('Loading this project…')
    expect(P.project(w.edits.id)?.name).toBe('Edits')
    // every result arrives again on the new connection
    double.live?.reconnect()
    expect(P.projectState(w.edits.id)).toBe('ok')
    expect(P.canWrite(w.edits.id)).toBe(true)
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

  it('reads the 199 unheld of 200 top-level projects in two chunks and keeps them while named, past a lowered bound', async () => {
    const w = world()
    const org = w.org
    const me = w.snap.profiles[0].id
    // beside the fixture's 6 top-level projects, so the organization holds
    // 200, the design size, 199 of them left out of the projects part
    const tops = Array.from({ length: 194 }, (_, i) => ({
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
    const unheld = w.snap.projects.filter((p) => !p.parent_id && p.id !== w.held.id)
    expect(unheld).toHaveLength(199)
    PROJECT_CACHE.most = 50
    try {
      P.nameProjects(
        'test',
        unheld.map((p) => p.id),
      )
      expect(byIds.map((ids) => ids.length)).toEqual([100, 99])
      await vi.waitFor(() => expect(tops.every((p) => P.projectState(p.id) === 'ok')).toBe(true))
      await vi.waitFor(() => expect(P.projectState(w.hidden.id)).toBe('gone'))
      // every answered project but Hidden, which the person cannot open
      expect(P.cacheStats().cached).toBe(198)
    } finally {
      PROJECT_CACHE.most = 2_000
    }
  })
})
