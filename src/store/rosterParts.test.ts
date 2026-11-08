import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { DELAY_UNKNOWN } from '../lib/delay'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The workspace without its people and catalog parts, on the real store:
   the root part sends the signed-in person's own profiles, memberships and
   teams (convex/lib/workspaceJoin.ts rootOf), so an organization of 1,000
   people and an organization of 50 teams, each with 60 labels, reach the
   store as one profile, the teams the person is in and no label. Each case
   raises one figure to its design size and keeps the others at everyday
   values. Everyone else is named through the profile cache's people.byIds
   reads, which answer from the server's data
   (store/peopleSettingsStandIn.setup.ts), a delay waits for its owner's
   face, whose hours it is judged by, and a desktop notification names its
   actor from those reads. */

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
// the desktop notifications the store raises, by their title
const notes = vi.hoisted(() => ({ titles: [] as string[] }))
vi.mock('../lib/notify', async (original) => ({
  ...(await original<typeof import('../lib/notify')>()),
  desktopNotify: (_tag: string, title: string) => notes.titles.push(title),
}))

const AT = '2026-09-14T08:00:00.000Z'

const pad = (n: number, width: number) => String(n).padStart(width, '0')

/** Person `n` of the organization, a standard user like the signed-in one
    with a 10-hour week. */
const personOf = (me: Snapshot['profiles'][number], n: number) => ({
  ...me,
  id: `person-${pad(n, 4)}`,
  auth_user_id: `account-${n}`,
  name: `Person ${pad(n, 4)}`,
  plannable_hours: 10,
})

/** An organization of `people` people, the signed-in user, a standard
    user, among them, and `teams` teams, of which the user leads the first
    and is in two more, the eighth and the last, every other person in one
    team, and 60 labels, with `extra` changes. */
function organization(
  { people, teams }: { people: number; teams: number },
  extra?: (snap: Snapshot) => void,
): Snapshot {
  const snap = plannerFixture()
  const org = snap.orgs[0].id
  const me = snap.profiles[0]
  me.org_role = 'user'
  for (let i = 1; i < people; i++) snap.profiles.push(personOf(me, i))
  for (let i = 0; i < teams; i++)
    snap.teams.push({
      id: `team-${pad(i, 2)}`,
      org_id: org,
      name: `Team ${pad(i, 2)}`,
      track_delay_default: true,
      created_at: AT,
    })
  for (const [n, leads] of [
    [0, true],
    [7, false],
    [teams - 1, false],
  ] as const)
    snap.teamMembers.push({ team_id: `team-${pad(n, 2)}`, profile_id: me.id, is_leader: leads })
  for (let i = 1; i < people; i++)
    snap.teamMembers.push({
      team_id: `team-${pad(i % teams, 2)}`,
      profile_id: `person-${pad(i, 4)}`,
      is_leader: i < teams,
    })
  for (let i = 0; i < 60; i++)
    snap.labels.push({
      id: `label-${i}`,
      org_id: org,
      name: `Label ${i}`,
      name_lower: `label ${i}`,
      color: '#335577',
      created_at: AT,
    })
  extra?.(snap)
  return snap
}

/** The people figure at its design size: 1,000 people, with an everyday
    10 teams. */
const crowd = () => organization({ people: 1000, teams: 10 })

/** The fixture with the one owner a delay case judges, Person 0001, at
    everyday values, with `extra` changes. */
function withOwner(extra: (snap: Snapshot) => void): Snapshot {
  const snap = plannerFixture()
  const me = snap.profiles[0]
  me.org_role = 'user'
  snap.profiles.push(personOf(me, 1))
  extra(snap)
  return snap
}

describe('the store without the people and catalog parts', () => {
  let store: typeof import('./planner')
  let byIds: {
    args: { org_id: string; ids: string[] }
    next: (value: unknown) => void
    fail: (error: unknown) => void
  }[]
  /** publishes the server's data again, as a new delivery */
  let deliver: (snap: Snapshot) => void
  const P = () => store.P

  async function boot(snap: Snapshot, { faces = true } = {}) {
    byIds = []
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      const name = getFunctionName(ref)
      if (name === 'people:byIds') {
        const read = { args, next, fail }
        byIds.push(read)
        if (faces) next(peopleSettingsStandIn(snap, name, args))
      } else {
        if (name === 'workspace:whole') deliver = (value) => next(structuredClone(value))
        next(structuredClone(snap))
      }
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('holds the signed-in person’s own profile, memberships and teams of 1,000 people, and no label', async () => {
    const snap = crowd()
    await boot(snap)
    const me = snap.profiles[0].id
    expect(P().users.map((u) => u.id)).toEqual([me])
    expect(
      P()
        .teams.map((t) => t.id)
        .sort(),
    ).toEqual(['team-00', 'team-07', 'team-09'])
    expect(P().user(me)?.teams.sort()).toEqual(['team-00', 'team-07', 'team-09'])
    expect(P().user('person-0001')).toBeUndefined()
    expect(P().teamById('team-01')).toBeUndefined()
    // no label reaches the store
    expect('labels' in P()).toBe(false)
    // nobody is read by id while no view names anyone
    expect(byIds).toEqual([])
    // a standard user who leads a team keeps Settings' Teams item, from
    // their own membership
    expect(P().isAdmin()).toBe(false)
    expect(P().isTeamLeader('team-00')).toBe(true)
    expect(P().isTeamLeader('team-07')).toBe(false)
  })

  it('holds only the signed-in person’s own three of 50 teams, with everyday people', async () => {
    const snap = organization({ people: 30, teams: 50 })
    await boot(snap)
    const me = snap.profiles[0].id
    expect(
      P()
        .teams.map((t) => t.id)
        .sort(),
    ).toEqual(['team-00', 'team-07', 'team-49'])
    expect(P().user(me)?.teams.sort()).toEqual(['team-00', 'team-07', 'team-49'])
    expect(P().teamById('team-42')).toBeUndefined()
    expect(P().isTeamLeader('team-00')).toBe(true)
    expect(P().users.map((u) => u.id)).toEqual([me])
  })

  it('names another person once a view names them, through one read by id', async () => {
    const snap = crowd()
    await boot(snap)
    const org = snap.orgs[0].id
    expect(P().person('person-0500', org)?.state).toBe('loading')
    P().namePeople('a view', [{ org, id: 'person-0500' }])
    await vi.waitFor(() => expect(P().person('person-0500', org)?.state).toBe('ok'))
    expect(P().person('person-0500', org)).toMatchObject({
      name: 'Person 0500',
      plannableHours: 10,
    })
    expect(byIds.map((read) => read.args.ids)).toEqual([['person-0500']])
    // the store still holds nobody else
    expect(P().users).toHaveLength(1)
  })

  describe('a delay, judged by the owner’s hours', () => {
    /* A task of Person 0001's, 30 hours to do in one week, planned over
       this week alone in a tracked project: late against the person's
       10-hour week, on track against the default 40. */
    const planned = (owner: string) => (snap: Snapshot) => {
      snap.projects[0].track_delay = true
      snap.issues.push({
        id: 'task-1',
        org_id: snap.orgs[0].id,
        project_id: snap.projects[0].id,
        num: 1,
        title: 'Calibrate the sensor',
        description: '',
        status: 'todo',
        priority: 'medium',
        assignee_id: owner,
        start_week: weekToISO(TODAY_WEEK),
        end_week: weekToISO(TODAY_WEEK),
        due_date: weekToISO(TODAY_WEEK + 1),
        remaining_hours: 30,
        remaining_set_at: AT,
        paused: false,
        created_at: AT,
        updated_at: AT,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      })
    }

    it('says nothing until the owner’s face brings their hours, never judging the default week', async () => {
      const snap = withOwner(planned('person-0001'))
      await boot(snap, { faces: false })
      await P().askTasks('script')
      await vi.waitFor(() => expect(P().tasksHeld()).toBe(true))
      const key = P().handleOf('task-1') ?? ''
      // the face is on its way, so no verdict, none against 40 hours and
      // no Delay unknown before the face could tell
      expect(P().delayOf(key)).toBeNull()
      expect(P().delayUnknown(key)).toBe(false)
      P().namePeople('the board', [{ org: snap.orgs[0].id, id: 'person-0001' }])
      await vi.waitFor(() => expect(byIds.length).toBeGreaterThan(0))
      const read = byIds.at(-1)
      read?.next(peopleSettingsStandIn(snap, 'people:byIds', read.args))
      // the face's 10 hours judge it late, once the cache turns
      await vi.waitFor(() => expect(P().delayOf(key)?.status).toBe('late'))
    })

    it('says Delay unknown for a held task whose owner’s face could not be read, never on track', async () => {
      const snap = withOwner(planned('person-0001'))
      await boot(snap, { faces: false })
      await P().askTasks('script')
      await vi.waitFor(() => expect(P().tasksHeld()).toBe(true))
      const key = P().handleOf('task-1') ?? ''
      P().namePeople('the board', [{ org: snap.orgs[0].id, id: 'person-0001' }])
      await vi.waitFor(() => expect(byIds.length).toBeGreaterThan(0))
      byIds.at(-1)?.fail(new Error('people.byIds is down'))
      await vi.waitFor(() =>
        expect(P().person('person-0001', snap.orgs[0].id)?.state).toBe('failed'),
      )
      // no verdict against a default week, and the card says it cannot tell
      await vi.waitFor(() => expect(P().delayUnknown(key)).toBe(true))
      expect(P().delayOf(key)).toBeNull()
    })

    it('judges an owner a current answer leaves out against the default week', async () => {
      const snap = withOwner(planned('person-gone'))
      await boot(snap)
      await P().askTasks('script')
      await vi.waitFor(() => expect(P().tasksHeld()).toBe(true))
      const key = P().handleOf('task-1') ?? ''
      P().namePeople('the board', [{ org: snap.orgs[0].id, id: 'person-gone' }])
      await vi.waitFor(() => expect(P().person('person-gone', snap.orgs[0].id)?.state).toBe('gone'))
      // 30 of 40 hours fit the week
      await vi.waitFor(() => expect(P().delayOf(key)?.status).toBe('ok'))
      expect(P().delayOf(key)).not.toBe(DELAY_UNKNOWN)
    })
  })

  describe('a desktop notification', () => {
    /** A new mention of the signed-in person by `actor` on task 1. */
    const mention = (snap: Snapshot, id: string, actor: string) => ({
      id,
      org_id: snap.orgs[0].id,
      recipient_id: snap.profiles[0].id,
      actor_id: actor,
      issue_id: 'task-1',
      issue_title: 'Calibrate the sensor',
      kind: 'mention' as const,
      detail: 'Mentioned you',
      created_at: '2026-09-14T10:00:00.000Z',
    })

    it('names an actor a view named from the profile cache, and says Someone for one it did not', async () => {
      const snap = withOwner(() => {})
      snap.profiles.push(personOf(snap.profiles[0], 2))
      snap.delivered_at = '2026-09-14T09:00:00.000Z'
      notes.titles.length = 0
      await boot(snap)
      const org = snap.orgs[0].id
      // the Inbox list named Person 0001, whose face the cache holds
      P().namePeople('the inbox', [{ org, id: 'person-0001' }])
      await vi.waitFor(() => expect(P().person('person-0001', org)?.state).toBe('ok'))
      snap.messages.push(mention(snap, 'm1', 'person-0001'), {
        ...mention(snap, 'm2', 'person-0002'),
        created_at: '2026-09-14T10:01:00.000Z',
      })
      snap.delivered_at = '2026-09-14T10:30:00.000Z'
      deliver(snap)
      await vi.waitFor(() => expect(notes.titles).toHaveLength(2))
      expect(notes.titles).toEqual([
        'Person 0001 mentioned you, Calibrate the sensor',
        'Someone mentioned you, Calibrate the sensor',
      ])
    })
  })
})
