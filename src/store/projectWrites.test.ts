import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A project's writes as its Settings page sends them, with what the page
 * showed (P.updateProject, setProjectAccess, setProjectTeamAccess,
 * inviteToProject, archiveProject, removeProject, projectRemovalSummary and
 * a grant's removal), on the real store. The workspace holds Plan, a
 * top-level project led by the signed-in Planner, an organization admin,
 * with Leo's User grant; the server also holds Away, which the workspace
 * leaves out, as it does for a project an admin manages without taking
 * part in it since the admin access split. Each case sends a write
 * with and without `shown`, held and not, and checks its organization, its
 * `expected` and what it painted. */

type Planner = typeof import('./planner')['P']

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

const NOW = '2026-09-14T08:00:00.000Z'
/* The organization the page shows for Away, which the workspace's own
   organization never names, so a write that took the workspace's would
   send the wrong one. */
const AWAY_ORG = 'away-org'

let P: Planner
let org: string
let me: string
let plan: string
let sent: { name: string; args: Record<string, unknown> }[]
let asked: { name: string; args: Record<string, unknown> }[]
// a write's answer, held until the test settles it
let answers: { name: string; settle: (outcome: 'accept' | Error) => void }[]

async function load() {
  vi.resetModules()
  sent = []
  asked = []
  answers = []
  const snap: Snapshot = plannerFixture()
  org = snap.orgs[0].id
  me = snap.profiles[0].id
  plan = snap.projects[0].id
  Object.assign(snap.projects[0], { type: 'meta', name: 'Plan', lead_id: me })
  snap.profiles.push({
    ...snap.profiles[0],
    id: 'leo',
    auth_user_id: undefined,
    name: 'Leo Berg',
    org_role: 'user',
    email: 'leo@example.test',
  })
  snap.teams.push({
    id: 'crew',
    org_id: org,
    name: 'Crew',
    track_delay_default: false,
    created_at: NOW,
  })
  snap.access.push({ project_id: plan, profile_id: 'leo', level: 'user' })
  network.onUpdate.mockImplementation((ref, _args, next) => {
    if (getFunctionName(ref) === 'workspace:whole') next(structuredClone(snap))
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    asked.push({ name, args })
    if (name === 'projectSettings:candidates')
      return { state: 'ready', rows: [], next: null, stopped: false }
    if (name === 'projectSettings:inviteTarget') throw new Error('offline')
    if (name === 'projects:removalSummary') return { sub_projects: [], tasks: 0, more: false }
    return null
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    sent.push({ name, args })
    return new Promise((resolve, reject) =>
      answers.push({
        name,
        settle: (outcome) => (outcome === 'accept' ? resolve(null) : reject(outcome)),
      }),
    )
  })
  vi.stubGlobal('window', { showToast: vi.fn() })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const store = await import('./planner')
  P = store.P
  await store.initStore()
}

/* Settles the oldest write named `name` and lets its answer land. */
async function settle(name: string, outcome: 'accept' | Error = 'accept') {
  const at = answers.findIndex((a) => a.name === name)
  if (at < 0) throw new Error(`${name} was not sent`)
  const [answer] = answers.splice(at, 1)
  answer?.settle(outcome)
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const last = (name: string) => {
  const write = sent.filter((s) => s.name === name).at(-1)
  if (!write) throw new Error(`${name} was not sent`)
  return write.args
}

beforeEach(load)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a project's writes with what its Settings page showed", () => {
  it('sends the expected values the page showed, not the workspace’s, and paints a held project', async () => {
    // the page showed delay tracking off while the workspace holds it on
    void P.updateProject(
      plan,
      { trackDelay: true },
      { seen: { track_delay: false } },
      { orgId: org },
    )
    expect(last('projects:update')).toMatchObject({
      org_id: org,
      id: plan,
      patch: { track_delay: true },
      expected: { track_delay: false },
    })
    expect(P.project(plan)?.trackDelay).toBe(true)
    // without `shown` the workspace's row gives what was on screen
    await settle('projects:update')
    void P.updateProject(plan, { name: 'Plan B' })
    expect(last('projects:update')).toMatchObject({ expected: { name: 'Plan' } })
  })

  it('sends a project the workspace does not hold to the organization the page showed, and paints nothing', async () => {
    const saved = P.updateProject(
      'away',
      { lead: 'leo' },
      { seen: { lead_id: null } },
      { orgId: AWAY_ORG },
    )
    expect(last('projects:update')).toEqual({
      org_id: AWAY_ORG,
      id: 'away',
      patch: { lead_id: 'leo' },
      expected: { lead_id: null },
    })
    expect(P.project('away')).toBeUndefined()
    await settle('projects:update')
    expect(await saved).toBe(true)
    // without `shown` such a project is missing here and nothing is sent
    expect(await P.updateProject('away', { name: 'Away' })).toBe(false)
    expect(sent.filter((s) => s.name === 'projects:update')).toHaveLength(1)
  })

  it('decides and checks a grant from the level and lead the page showed', async () => {
    // the page's list showed Leo as Viewer, which the workspace holds as User
    void P.setProjectAccess(plan, 'leo', 'user', { orgId: org, level: 'viewer', leadId: me })
    expect(last('projects:setAccess')).toEqual({
      org_id: org,
      id: plan,
      user_id: 'leo',
      level: 'user',
      expected: { level: 'viewer' },
    })
    await settle('projects:setAccess')
    // a level the page showed already sends nothing, whatever the workspace holds
    expect(
      await P.setProjectAccess(plan, 'leo', 'viewer', { orgId: org, level: 'viewer', leadId: me }),
    ).toBe(true)
    expect(sent.filter((s) => s.name === 'projects:setAccess')).toHaveLength(1)
    // the lead the page showed is the Lead field's, never a grant
    expect(
      await P.setProjectAccess(plan, 'ada', 'viewer', { orgId: org, level: null, leadId: 'ada' }),
    ).toBe(false)
    // without `shown` the expected level is the workspace's, which holds
    // no one else's grant, so the server refuses it over Leo's
    void P.setProjectAccess(plan, 'leo', 'viewer')
    expect(last('projects:setAccess')).toMatchObject({ expected: { level: null } })
  })

  it('hands the lead over with the lead the page showed as expected', async () => {
    void P.setProjectAccess(plan, 'leo', 'lead', { orgId: org, level: 'user', leadId: 'mira' })
    expect(last('projects:update')).toMatchObject({
      org_id: org,
      patch: { lead_id: 'leo' },
      expected: { lead_id: 'mira' },
    })
    // the shown lead already leads: nothing to send
    expect(
      await P.setProjectAccess(plan, 'mira', 'lead', { orgId: org, level: null, leadId: 'mira' }),
    ).toBe(true)
    expect(sent.filter((s) => s.name === 'projects:update')).toHaveLength(1)
  })

  it("adds a team's grant to a project the workspace does not hold without painting it", async () => {
    void P.setProjectTeamAccess('away', 'crew', 'viewer', { orgId: AWAY_ORG, level: null })
    expect(last('projects:setAccess')).toEqual({
      org_id: AWAY_ORG,
      id: 'away',
      team_id: 'crew',
      level: 'viewer',
      expected: { level: null },
    })
    // the workspace holds no project, so a share paints nothing
    expect(P.project('away')).toBeUndefined()
    // without `shown` a project the workspace does not hold sends nothing
    expect(await P.setProjectTeamAccess('away', 'crew', 'user')).toBe(false)
  })

  it('always sends the level the invite lookup found as expected', async () => {
    void P.inviteToProject('away', 'new@example.test', 'viewer', { orgId: AWAY_ORG, level: null })
    expect(last('projects:inviteGuest')).toEqual({
      org_id: AWAY_ORG,
      project_id: 'away',
      email: 'new@example.test',
      level: 'viewer',
      expected: { level: null },
    })
    // the lookup's level, not the workspace's, for a seat it found
    void P.inviteToProject(plan, 'leo@example.test', 'user', { orgId: org, level: 'viewer' })
    expect(last('projects:inviteGuest')).toMatchObject({ expected: { level: 'viewer' } })
    // without `shown`, an address the workspace holds no seat for sends none
    void P.inviteToProject(plan, 'someone@example.test', 'user')
    expect(last('projects:inviteGuest')).not.toHaveProperty('expected')
  })

  it("archives, counts and deletes a project the workspace does not hold in the page's organization", async () => {
    P.archiveProject('away', { orgId: AWAY_ORG })
    expect(last('projects:archive')).toEqual({ org_id: AWAY_ORG, id: 'away' })
    expect(await P.projectRemovalSummary('away', { orgId: AWAY_ORG })).not.toBeNull()
    expect(asked.find((q) => q.name === 'projects:removalSummary')?.args).toEqual({
      org_id: AWAY_ORG,
      id: 'away',
    })
    const deleted = P.removeProject('away', 'Gone', { orgId: AWAY_ORG })
    expect(last('projects:deleteDeep')).toEqual({ org_id: AWAY_ORG, id: 'away', reason: 'Gone' })
    await settle('projects:deleteDeep')
    expect(await deleted).toBe(true)
    // without `shown` none of them reaches the server
    P.archiveProject('away')
    expect(await P.projectRemovalSummary('away')).toBeNull()
    expect(await P.removeProject('away')).toBe(false)
    expect(sent.filter((s) => s.name !== 'projects:update')).toHaveLength(2)
    // a held project's archive still paints it gone at once
    P.archiveProject(plan, { orgId: org })
    expect(P.project(plan)).toBeUndefined()
  })

  it("restores a project the workspace does not hold in the page's organization, and a held one in its own", async () => {
    const restored = P.unarchiveProject('away', { orgId: AWAY_ORG })
    expect(last('projects:unarchive')).toEqual({ org_id: AWAY_ORG, id: 'away' })
    await settle('projects:unarchive')
    expect(await restored).toBe(true)
    // the workspace's row decides for a project it holds, whatever was shown
    const held = P.unarchiveProject(plan, { orgId: AWAY_ORG })
    expect(last('projects:unarchive')).toEqual({ org_id: org, id: plan })
    await settle('projects:unarchive', new ConvexError({ code: 'forbidden', message: 'no' }))
    expect(await held).toBe(false)
    // without `shown`, one the workspace does not hold sends nothing
    const count = sent.length
    expect(await P.unarchiveProject('away')).toBe(false)
    expect(sent).toHaveLength(count)
  })
})

describe("a grant's removal from the Settings page", () => {
  it('goes to the organization the change names, and says while its write is on its way', async () => {
    const { grantRemoval } = await import('./planner')
    const change = grantRemoval('user', 'away', 'leo', AWAY_ORG, true)
    // the keys come in one order, whatever the kind
    expect(Object.keys(change)).toEqual(['kind', 'projectId', 'userId', 'orgId', 'topLevel'])
    expect(Object.keys(grantRemoval('team', 'away', 'crew', AWAY_ORG, true))).toEqual([
      'kind',
      'projectId',
      'teamId',
      'orgId',
      'topLevel',
    ])
    expect(P.removingAccess(change)).toBe(false)
    const removed = P.removeAccess(change, { to: null })
    expect(last('projects:removeAccess')).toEqual({
      org_id: AWAY_ORG,
      id: 'away',
      user_id: 'leo',
      on_held_tasks: 'leave',
    })
    // the change's organization does not count for the question
    expect(P.removingAccess({ kind: 'userGrant', projectId: 'away', userId: 'leo' })).toBe(true)
    expect(P.removingAccess(grantRemoval('user', 'away', 'ada', AWAY_ORG, true))).toBe(false)
    await settle('projects:removeAccess', new ConvexError({ code: 'forbidden', message: 'no' }))
    expect(await removed).toBe(false)
    expect(P.removingAccess(change)).toBe(false)
    // the preview names the same organization
    await P.previewRemoval(change)
    expect(asked.find((q) => q.name === 'accessRemovals:preview')?.args).toMatchObject({
      org_id: AWAY_ORG,
    })
    // the Keep text reads the page's top-level project where the preview
    // names none of it
    const keep = (topLevel: boolean) =>
      P.keepText(grantRemoval('user', 'away', 'leo', AWAY_ORG, topLevel), {
        state: 'ok',
        pending: true,
        leave_only: false,
        people: [{ id: 'leo', name: 'Leo Berg', kind: 'person', org_role: 'user' }],
        tasks: 1,
        items: [],
        items_total: 1,
        hidden: 0,
        projects: [],
        keep: {
          targets: [],
          changers: [],
          allowed: true,
          refusal: null,
          offered: true,
          permitted: true,
        },
        reassign: { allowed: true, refusal: null, permitted: true },
      })
    expect(keep(true)).toContain('can see the whole project')
    expect(keep(false)).toContain('can see the whole sub-project')
    // without an organization a project the workspace does not hold is
    // previewed nowhere and removes nothing
    expect(await P.previewRemoval({ kind: 'userGrant', projectId: 'away', userId: 'leo' })).toBe(
      null,
    )
  })
})

describe("the Settings page's one-shot reads", () => {
  it('reads a picker batch with its arguments, and answers null for a read that fails', async () => {
    expect(await P.accessChoices({ org_id: org, project_id: plan }, 'leo', 'cursor')).toEqual({
      state: 'ready',
      rows: [],
      next: null,
      stopped: false,
    })
    expect(asked.at(-1)).toEqual({
      name: 'projectSettings:candidates',
      args: { org_id: org, project_id: plan, search: 'leo', after: 'cursor' },
    })
    await P.leadChoices({ org_id: org, project_id: plan }, '', null)
    expect(asked.at(-1)).toEqual({
      name: 'projectSettings:leadCandidates',
      args: { org_id: org, project_id: plan },
    })
    expect(await P.projectInviteTarget(org, plan, ' leo@example.test ')).toBeNull()
    expect(asked.at(-1)?.args).toEqual({ org_id: org, project_id: plan, email: 'leo@example.test' })
  })
})
