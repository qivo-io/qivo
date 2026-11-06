import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELD_CHANGED } from '../../convex/lib/fieldPrints'
import type { MilestoneAsk } from './milestoneRows'
import {
  answerMilestones,
  type ForcedMilestones,
  isMilestoneRead,
  MILESTONE_TOO_LARGE,
  MILESTONES_UNCHECKED,
} from './milestoneStandIn.setup'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The milestone reads the store holds (store/planner.ts P.watchMilestones,
   P.milestoneRead) on the real store over the live double, answered by the
   milestone stand-in (store/milestoneStandIn.setup.ts) from the server's
   own copy of the workspace: their keys and states, the hidden tab and the
   reconnect, and the person's milestone writes, which paint every copy a
   read holds (the `milestones` part of store/layers.ts) until a delivery
   holds them, also for a milestone only a read holds. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { reconnect(only?: readonly string[]): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  const live = liveOver(network)
  double.live = live
  return { convex: network, live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
const FROM = '2026-09-14'
const TO = '2026-09-28'

let store: typeof import('./planner')
/* the workspace the projects part sends, and the server's own, which the
   milestone reads answer from */
let snapshot: Snapshot
let server: Snapshot
let force: ForcedMilestones
/* the milestone subscriptions, newest last */
let subs: {
  name: string
  args: Record<string, unknown>
  receive: (v: unknown) => void
  fail: (e: unknown) => void
}[]
let writes: {
  name: string
  args: Record<string, unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}[]

/** A turn for the double's microtasks and the store's 0 ms paint timer. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
const turns = async () => {
  for (let i = 0; i < 4; i++) await turn()
}

/** Milestone `id` of project `project` on `week`. */
const ms = (id: string, week: string, name: string, project = 'plan') => ({
  id,
  project_id: project,
  name,
  week,
  created_at: AT,
})

/** Answers every live milestone subscription again from the server's copy,
    as Convex reruns a read whose data changed. */
async function rerun() {
  for (const sub of subs) answerMilestones(server, sub.name, sub.args, sub.receive, sub.fail, force)
  await turns()
}

/** Boots the store. `withMilestones` false leaves the milestones out of the
    projects part, so only a read holds them, as t3/limits-milestone-part
    makes it. */
async function boot(withMilestones = true) {
  vi.resetModules()
  const org = snapshot.orgs[0].id
  for (const [id, key, name] of [
    ['plan', 'PLAN', 'Plan'],
    ['ship', 'SHIP', 'Ship'],
  ])
    snapshot.projects.push({
      id,
      org_id: org,
      type: 'meta',
      key,
      num: id === 'plan' ? 2 : 3,
      name,
      description: '',
      sort_order: id === 'plan' ? 1 : 2,
      track_delay: false,
      created_at: AT,
    })
  snapshot.projects.push({
    ...snapshot.projects[0],
    id: 'docs',
    key: 'DOCS',
    num: 4,
    name: 'Docs',
    parent_id: 'plan',
  })
  snapshot.milestones.push(
    ms('alpha', '2026-09-15', 'Alpha'),
    ms('beta', '2026-09-22', 'Beta'),
    ms('later', '2026-10-27', 'Later'),
    ms('old', '2026-08-03', 'Old'),
    ms('sail', '2026-09-16', 'Sail', 'ship'),
  )
  server = structuredClone(snapshot)
  if (!withMilestones) snapshot.milestones = []
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') receive(structuredClone(snapshot))
    else if (isMilestoneRead(name)) {
      subs.push({ name, args, receive, fail })
      answerMilestones(server, name, args, receive, fail, force)
    }
    return () => {}
  })
  store = await import('./planner')
  await store.initStore()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  snapshot = plannerFixture()
  force = {}
  subs = []
  writes = []
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref, args) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise((resolve, reject) =>
          writes.push({ name: getFunctionName(ref), args, resolve, reject }),
        ),
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const upcoming = (projects: string[] = ['plan'], over: object = {}): MilestoneAsk => ({
  kind: 'section',
  projects,
  from: FROM,
  side: 'upcoming',
  limit: 25,
  ...over,
})
const range = (projects: string[] = ['plan']): MilestoneAsk => ({
  kind: 'between',
  projects,
  from: FROM,
  to: TO,
})

/** Registers `ask` on `slot` and waits for its answer. */
async function watch(slot: string, ask: MilestoneAsk | null, owner = 0, attempt = 0) {
  store.P.watchMilestones(slot, ask, owner, attempt)
  await turns()
}

/** The names a read shows, in order. */
function names(slot: string): string[] {
  const read = store.P.milestoneRead(slot)
  return read.state === 'ok' ? read.answer.rows.map((m) => m.name) : []
}

const milestoneSubs = () =>
  network.onUpdate.mock.calls.filter(([ref]) => isMilestoneRead(getFunctionName(ref))).length

describe('the asks', () => {
  it('shares one subscription between equal asks, whatever the order of their projects', async () => {
    await boot()
    await watch('a', upcoming(['ship', 'plan', 'ship']))
    const after = milestoneSubs()
    expect(after).toBe(1)
    expect(subs[0].args).toEqual({
      projects: ['plan', 'ship'],
      from: FROM,
      side: 'upcoming',
      limit: 25,
    })
    // the same ask again, with an empty search left out, asks nothing new
    await watch('a', upcoming(['plan', 'ship'], { search: '  ' }))
    expect(milestoneSubs()).toBe(after)
    expect(names('a')).toEqual(['Alpha', 'Sail', 'Beta', 'Later'])
  })

  it('drops the answer for new arguments, asks afresh for a new attempt, and forgets on release', async () => {
    await boot()
    await watch('a', upcoming())
    expect(names('a')).toEqual(['Alpha', 'Beta', 'Later'])
    force = { section: 'loading' }
    store.P.watchMilestones('a', upcoming(['ship']))
    expect(store.P.milestoneRead('a').state).toBe('loading')
    force = {}
    await watch('a', upcoming(['ship']), 0, 1)
    expect(names('a')).toEqual(['Sail'])
    expect(milestoneSubs()).toBe(3)
    store.P.releaseMilestones('a')
    expect(store.P.milestoneRead('a').state).toBe('loading')
  })
})

describe('the states', () => {
  it('is loading, then ok and current', async () => {
    await boot()
    force = { get: 'loading' }
    await watch('open', { kind: 'get', id: 'alpha' })
    expect(store.P.milestoneRead('open')).toEqual({ state: 'loading' })
    force = {}
    await rerun()
    const read = store.P.milestoneRead('open')
    expect(read.state).toBe('ok')
    if (read.state !== 'ok') return
    expect(read.current).toBe(true)
    expect(read.answer.rows.map((m) => m.name)).toEqual(['Alpha'])
    expect(read.answer.project?.name).toBe('Plan')
    expect(read.answer.canWrite).toBe(true)
  })

  it.each([
    ['refused', MILESTONE_TOO_LARGE],
    ['unchecked', MILESTONES_UNCHECKED],
  ] as const)('is refused (%s) with the server sentence', async (kind, sentence) => {
    await boot()
    force = { get: kind }
    await watch('open', { kind: 'get', id: 'alpha' })
    const read = store.P.milestoneRead('open')
    expect(read.state).toBe('refused')
    if (read.state === 'refused') {
      expect(read.sentence).toBe(sentence.charAt(0).toUpperCase() + sentence.slice(1))
      expect(read.kept).toBeNull()
    }
  })

  it('fails, keeps the last answer beside the failure, and keeps it through a Retry', async () => {
    await boot()
    await watch('open', { kind: 'get', id: 'alpha' })
    force = { get: 'error' }
    await rerun()
    let read = store.P.milestoneRead('open')
    expect(read.state).toBe('failed')
    if (read.state === 'failed') expect(read.kept?.rows.map((m) => m.name)).toEqual(['Alpha'])
    force = { get: 'loading' }
    await watch('open', { kind: 'get', id: 'alpha' }, 0, 1)
    read = store.P.milestoneRead('open')
    expect(read).toMatchObject({ state: 'ok', current: false })
    force = {}
    await rerun()
    expect(store.P.milestoneRead('open')).toMatchObject({ state: 'ok', current: true })
  })

  it('asks nothing for more projects than one read names', async () => {
    await boot()
    const projects = store.MILESTONE_READS.projects
    store.MILESTONE_READS.projects = 3
    try {
      const before = milestoneSubs()
      await watch('sync', upcoming(['plan', 'ship', 'docs', 'other']))
      expect(milestoneSubs()).toBe(before)
      expect(store.P.milestoneRead('sync')).toEqual({ state: 'too_many' })
      // three projects fit
      await watch('sync', upcoming(['plan', 'ship', 'other']))
      expect(milestoneSubs()).toBe(before + 1)
      expect(store.P.milestoneRead('sync').state).toBe('ok')
    } finally {
      store.MILESTONE_READS.projects = projects
    }
  })
})

describe('the hidden tab and the reconnect', () => {
  it('keeps the answer while stopped, and is current again only after a fresh delivery', async () => {
    await boot()
    await watch('sync', range(), 7)
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
    // another owner's null asks nothing
    await watch('sync', null, 8)
    expect(store.P.milestoneRead('sync')).toMatchObject({ state: 'ok', current: true })
    await watch('sync', null, 7)
    expect(store.P.milestoneRead('sync')).toMatchObject({ state: 'ok', current: false })
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
    // back with the same key: a fresh subscription, kept until it answers
    force = { between: 'loading' }
    await watch('sync', range(), 7)
    expect(store.P.milestoneRead('sync')).toMatchObject({ state: 'ok', current: false })
    force = {}
    await rerun()
    expect(store.P.milestoneRead('sync')).toMatchObject({ state: 'ok', current: true })
    // a reconnect: not current until the answer arrives again on it
    double.live?.reconnect(['workspace:root'])
    await turns()
    expect(store.P.milestoneRead('sync')).toMatchObject({ state: 'ok', current: false })
    await rerun()
    expect(store.P.milestoneRead('sync')).toMatchObject({ state: 'ok', current: true })
  })
})

describe('the writes', () => {
  it.each([
    ['holds', true],
    ['lacks', false],
  ])(
    'renames and moves a milestone the workspace %s, from what the read showed, painting every copy until a delivery holds it',
    async (_, withMilestones) => {
      await boot(withMilestones)
      await watch('open', { kind: 'get', id: 'alpha' })
      await watch('sync', range())
      const P = store.P
      const shown = P.milestoneRead('open')
      if (shown.state !== 'ok') throw new Error('no answer')
      const seen = shown.answer.stored.get('alpha')
      const saved = P.updateMilestone('alpha', { name: 'Alpha 2' }, seen)
      expect(writes.map((w) => w.name)).toEqual(['projects:updateMilestone'])
      expect(writes[0].args).toEqual({
        org_id: snapshot.orgs[0].id,
        id: 'alpha',
        patch: { name: 'Alpha 2' },
        expected: { name: 'Alpha' },
      })
      expect(names('open')).toEqual(['Alpha 2'])
      expect(names('sync')).toEqual(['Alpha 2', 'Beta'])
      // accepted before any read delivered it: the paint stays
      writes[0].resolve(null)
      await expect(saved).resolves.toBe(true)
      await turns()
      expect(names('sync')).toEqual(['Alpha 2', 'Beta'])
      // the reads deliver it, which holds the write, so someone's later
      // rename shows
      server.milestones[0].name = 'Alpha 2'
      await rerun()
      expect(names('sync')).toEqual(['Alpha 2', 'Beta'])
      server.milestones[0].name = 'Alpha 3'
      await rerun()
      expect(names('sync')).toEqual(['Alpha 3', 'Beta'])
      expect(names('open')).toEqual(['Alpha 3'])
      // a move out of the two weeks takes it out of the range at once
      const week = P.isoToWeek('2026-10-12')
      void P.updateMilestone('alpha', { week })
      expect(writes[1].args).toMatchObject({ patch: { week: '2026-10-12' } })
      expect(names('sync')).toEqual(['Beta'])
      expect(names('open')).toEqual(['Alpha 3'])
    },
  )

  it('deletes from every copy, and a refusal takes the paint back and keeps the draft', async () => {
    await boot(false)
    await watch('open', { kind: 'get', id: 'beta' })
    await watch('sync', range())
    const P = store.P
    void P.removeMilestone('beta', { name: 'Beta', week: '2026-09-22' })
    expect(writes[0]).toMatchObject({ name: 'projects:removeMilestone', args: { id: 'beta' } })
    expect(names('open')).toEqual([])
    expect(names('sync')).toEqual(['Alpha'])
    writes[0].reject(new ConvexError({ code: 'rule', message: 'the server said no' }))
    await turns()
    expect(names('open')).toEqual(['Beta'])
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
    // a move refused because someone changed it first
    const keepDraft = vi.fn(() => true)
    const saved = P.updateMilestone(
      'beta',
      { week: P.isoToWeek('2026-09-14') },
      undefined,
      keepDraft,
    )
    expect(names('sync')).toEqual(['Beta', 'Alpha'])
    writes[1].reject(
      new ConvexError({
        code: 'conflict',
        reason: FIELD_CHANGED,
        message: 'the date of the milestone changed since you read it',
        changes: [{ record: 'milestone', id: 'beta', field: 'week', by: 'someone', at: AT }],
      }),
    )
    await expect(saved).resolves.toBe(false)
    expect(keepDraft).toHaveBeenCalledOnce()
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
    // the notice names the milestone from the read's row
    const notices = vi.mocked(window.showToast).mock.calls.map(([text]) => String(text))
    expect(notices.some((text) => text.includes('milestone “Beta”'))).toBe(true)
  })

  it('creates into the workspace and every section that covers it, not one it falls past', async () => {
    await boot()
    await watch('up', upcoming())
    await watch('next', upcoming(['plan'], { limit: 1 }))
    expect(names('next')).toEqual(['Alpha'])
    const P = store.P
    void P.addMilestone({ project: 'docs', name: 'Gamma', week: P.isoToWeek('2026-10-05') })
    expect(writes[0]).toMatchObject({ name: 'projects:addMilestone', args: { project_id: 'plan' } })
    expect(P.milestones.some((m) => m.name === 'Gamma')).toBe(true)
    expect(names('up')).toEqual(['Alpha', 'Beta', 'Gamma', 'Later'])
    // the one-row section's next is Alpha, which Gamma falls past
    expect(names('next')).toEqual(['Alpha'])
  })

  it('sends nothing for a milestone neither the workspace nor a read holds', async () => {
    await boot(false)
    await expect(store.P.updateMilestone('alpha', { name: 'X' })).resolves.toBe(false)
    await expect(store.P.removeMilestone('alpha')).resolves.toBe(false)
    expect(writes).toEqual([])
  })

  it('keeps a saved rename on a read that has not delivered since, and drops it once one did', async () => {
    await boot()
    await watch('sync', range(), 3)
    // the read stops, as on a hidden tab, and keeps its answer
    await watch('sync', null, 3)
    const P = store.P
    const saved = P.updateMilestone('alpha', { name: 'Alpha 2' })
    writes[0].resolve(null)
    await expect(saved).resolves.toBe(true)
    await turns()
    expect(names('sync')).toEqual(['Alpha 2', 'Beta'])
    // back, with the server holding the rename and then someone's revert
    server.milestones[0].name = 'Alpha 2'
    await watch('sync', range(), 3)
    expect(names('sync')).toEqual(['Alpha 2', 'Beta'])
    server.milestones[0].name = 'Alpha'
    await rerun()
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
  })

  it('lets a live read hold a rename a stopped read also shows, whose copy then follows it', async () => {
    await boot()
    // a kept, hidden page's range holds Alpha, and the window opens it
    await watch('sync', range(), 3)
    await watch('sync', null, 3)
    await watch('open', { kind: 'get', id: 'alpha' })
    const P = store.P
    const saved = P.updateMilestone(
      'alpha',
      { name: 'Alpha 2' },
      { name: 'Alpha', week: '2026-09-15' },
    )
    writes[0].resolve(null)
    await expect(saved).resolves.toBe(true)
    server.milestones[0].name = 'Alpha 2'
    await rerun()
    expect(names('open')).toEqual(['Alpha 2'])
    expect(names('sync')).toEqual(['Alpha 2', 'Beta'])
    // someone renames it again: the window shows theirs, and sends it as
    // what the person saw
    server.milestones[0].name = 'Alpha 3'
    await rerun()
    expect(names('open')).toEqual(['Alpha 3'])
    expect(names('sync')).toEqual(['Alpha 3', 'Beta'])
    const read = P.milestoneRead('open')
    expect(read.state === 'ok' && read.answer.stored.get('alpha')?.name).toBe('Alpha 3')
    // and a move out of the two weeks takes the kept copy out of the range
    server.milestones[0].week = '2026-10-12'
    await rerun()
    expect(names('sync')).toEqual(['Beta'])
  })

  it("shows a live read's own answers once it holds a move that a hidden range still paints", async () => {
    await boot()
    // a kept, hidden page's range of the two weeks, and the window on Later,
    // five weeks out
    await watch('sync', range(), 3)
    await watch('sync', null, 3)
    await watch('open', { kind: 'get', id: 'later' })
    const P = store.P
    const later = server.milestones.find((m) => m.id === 'later')
    if (!later) throw new Error('no later')
    // the person moves it into the two weeks, which the hidden range shows
    const first = P.updateMilestone('later', { week: P.isoToWeek('2026-09-21') })
    writes[0].resolve(null)
    await expect(first).resolves.toBe(true)
    later.week = '2026-09-21'
    await rerun()
    expect(names('sync')).toEqual(['Alpha', 'Later', 'Beta'])
    // and moves it again, out of them: the window shows the server's day
    const second = P.updateMilestone('later', { week: P.isoToWeek('2026-10-05') })
    writes[1].resolve(null)
    await expect(second).resolves.toBe(true)
    later.week = '2026-10-05'
    await rerun()
    const read = P.milestoneRead('open')
    expect(read.state === 'ok' && read.answer.stored.get('later')?.week).toBe('2026-10-05')
    // the hidden range shows the second move over the first
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
    // someone else moves it: the window shows theirs too
    later.week = '2026-10-12'
    await rerun()
    const theirs = P.milestoneRead('open')
    expect(theirs.state === 'ok' && theirs.answer.stored.get('later')?.week).toBe('2026-10-12')
    // the range, back, shows the server's answer
    await watch('sync', range(), 3)
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
  })

  it("opens a restored project's milestone that a hidden read's archive paint still hides", async () => {
    await boot()
    await watch('sync', range(['plan', 'ship']), 3)
    await watch('sync', null, 3)
    const P = store.P
    P.archiveProject('ship')
    writes[0].resolve(null)
    await turns()
    expect(names('sync')).toEqual(['Alpha', 'Beta'])
    const restored = P.unarchiveProject('ship')
    writes[1].resolve(null)
    await expect(restored).resolves.toBe(true)
    // the window on Ship's milestone shows the server's answer
    await watch('open', { kind: 'get', id: 'sail' })
    expect(names('open')).toEqual(['Sail'])
    // and the range, back, shows it again
    await watch('sync', range(['plan', 'ship']), 3)
    expect(names('sync')).toEqual(['Alpha', 'Sail', 'Beta'])
  })

  it("hides a project's milestones in every read when it is archived or deleted", async () => {
    await boot()
    await watch('up', upcoming(['plan', 'ship']))
    const P = store.P
    P.archiveProject('ship')
    expect(names('up')).toEqual(['Alpha', 'Beta', 'Later'])
    writes[0].reject(new ConvexError({ code: 'rule', message: 'no' }))
    await turns()
    expect(names('up')).toEqual(['Alpha', 'Sail', 'Beta', 'Later'])
    const removed = P.removeProject('plan')
    writes[1].resolve(null)
    await expect(removed).resolves.toBe(true)
    await turns()
    expect(names('up')).toEqual(['Sail'])
  })
})

describe('the Roadmap journal', () => {
  it('records a rename with its milestone paint, and its Undo shows from the read', async () => {
    await boot(false)
    await watch('open', { kind: 'get', id: 'alpha' })
    const P = store.P
    P.roadmapContext(true, false)
    try {
      const saved = P.updateMilestone(
        'alpha',
        { name: 'Alpha 2' },
        { name: 'Alpha', week: '2026-09-15' },
      )
      expect(writes[0]).toMatchObject({
        name: 'roadmap:change',
        args: {
          operations: [
            {
              kind: 'milestone_update',
              id: 'alpha',
              patch: { name: 'Alpha 2' },
              expected: { name: 'Alpha' },
            },
          ],
        },
      })
      expect(names('open')).toEqual(['Alpha 2'])
      server.milestones[0].name = 'Alpha 2'
      await rerun()
      writes[0].resolve({ count: 1 })
      await expect(saved).resolves.toBe(true)
      await turns()
      P.undoRoadmap()
      expect(writes[1].name).toBe('roadmap:undo')
      server.milestones[0].name = 'Alpha'
      await rerun()
      writes[1].resolve({ count: 0 })
      await turns()
      expect(names('open')).toEqual(['Alpha'])
    } finally {
      P.roadmapContext(false, false)
    }
  })

  it('folds the milestone paints of a batch into its one layer', async () => {
    await boot(false)
    await watch('sync', range())
    const P = store.P
    P.roadmapContext(true, false)
    try {
      P.batchRoadmapChanges(() => {
        P.setMilestone('alpha', P.isoToWeek('2026-09-21'))
        P.setMilestone('beta', P.isoToWeek('2026-09-14'))
      })
      expect(writes.map((w) => w.name)).toEqual(['roadmap:change'])
      expect(names('sync')).toEqual(['Beta', 'Alpha'])
      // a delivery repaints from the answer, under the batch's one layer
      await rerun()
      expect(names('sync')).toEqual(['Beta', 'Alpha'])
      writes[0].reject(new ConvexError({ code: 'rule', message: 'no' }))
      await turns()
      expect(names('sync')).toEqual(['Alpha', 'Beta'])
    } finally {
      P.roadmapContext(false, false)
    }
  })
})
