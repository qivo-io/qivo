/* Team sync's agenda (convex/teamSync.ts agenda) against what the page
 * derived from the workspace before it read the agenda, and Team sync's
 * stand-in (store/teamSyncStandIn.setup.ts) against the agenda, as
 * boardParity.test.ts pins the Board's. Each case boots the real store from the
 * caller's real workspace, as roadmapParity.test.ts does, with the clock
 * frozen before the store loads, sends the clock the Overview's page sends
 * (src/views/overview/overviewArgs.ts overviewClock), and compares the
 * agenda of every scope the page offers, All projects, each team of the
 * home organization, each top-level project and each sub-project, with
 * the page's own rules (store/teamSyncOracle.setup.ts): the sub-projects
 * and top-level projects (scopeProjectIds, scopeMetaIds), the rows
 * (syncRows), the walk's people (syncRoster), Needs an owner beside the
 * rows (needsOwner), each walker's Done since kept from the answer's Done
 * tasks by the exact reading point (doneSince, syncSince), each row's
 * blockers (blockersOf) and banner verdict (bannerVerdict over P.delayOf,
 * `unknown` for an organization Viewer exactly where the verdict needs a
 * load), each walker's week hours (P.weekLoadOf, at the server's rounding
 * to tenths) and the sub-projects the person may edit (P.canWrite).
 *
 * The process runs in New York's time zone, so the client's local days and
 * weeks differ from UTC ones near midnight; vitest runs each file in a
 * process of its own. Northstar runs as Nora (admin), Leo and Ben with
 * stamps planted in a sitting and after one; the small fixture runs every
 * access shape for a user, a guest and a viewer, and the admin. Cases that
 * must fail if a rule drifts compare a drifted rule with the answer. */

import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { roundTenths } from '../../convex/lib/numbers'
import { taskOwnerId } from '../../convex/lib/review'
import { readingBounds } from '../../convex/lib/teamSync'
import { AGENDA, type AgendaAnswer, type AgendaScope } from '../../convex/lib/teamSyncAgenda'
import { plannableHoursOf } from '../../convex/lib/workload'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import {
  as,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  wholeOf,
  withReadingAdmin,
} from '../../convex/tests/helpers.setup'
import { northstarId, plantNorthstar } from '../../convex/tests/northstar.setup'
import { countOrg } from '../../convex/tests/overviewCounts.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import { plantBlocks, plantStamp, plantTeam } from '../../convex/tests/teamSyncAgenda.setup'
import type { SyncScope } from '../lib/teamSync'
import type { Whole as Snapshot } from './guard/liveDouble.setup'
import { oracleStore } from './oracleScope.setup'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { nameEveryone } from './personShown.setup'
import {
  type ForcedSync,
  SYNC_CONTEXT,
  type SyncArgs,
  teamSyncStandIn,
} from './teamSyncStandIn.setup'

vi.hoisted(() => {
  // the client's zone, set before any module reads the clock
  process.env.TZ = 'America/New_York'
  process.env.BETTER_AUTH_SECRET ??= 'team-sync-parity-secret-not-a-deployment-key'
})

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
  vi.useRealTimers()
})

/** A fresh store whose first delivery is `snap`, with the oracle, the
 * page's rules and the Overview's clock read from the same store. */
async function start(snap: Snapshot) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  // the faces the views name come from the server's data, as the store
  // holds nobody but the caller
  network.onUpdate.mockImplementation((ref, args, next) => {
    if (getFunctionName(ref) === 'people:byIds')
      next(peopleSettingsStandIn(snap, 'people:byIds', args))
    else next(structuredClone(snap))
    return () => {}
  })
  // the store half of this parity derives from every task held, which only a store that asked for every task has
  const { TASKS } = await import('./liveParts')
  TASKS.atBoot = true
  const store = await import('./planner')
  await store.initStore()
  await nameEveryone(store.P, snap)
  return Object.assign(store.P, {
    oracle: await import('./teamSyncOracle.setup'),
    rules: await import('../lib/teamSync'),
    args: await import('../views/overview/overviewArgs'),
    snap,
  })
}

type Store = Awaited<ReturnType<typeof start>>
type Issue = Store['issues'][number]

/** The store booted for `profile` from their workspace, with the clock at
 * `now` before the store's modules load. */
async function storeOf(t: T, profile: Doc<'profiles'>, now: number): Promise<Store> {
  const snap = await wholeOf(t, profile)
  if (snap === null) throw new Error(`no workspace for ${profile.name}`)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  return await start(snap)
}

const sorted = (ids: Iterable<string>) => [...ids].sort()

/** The agenda's arguments for `profile` and `scope` on the store's clock. */
const argsOf = (P: Store, profile: Doc<'profiles'>, scope: AgendaScope): SyncArgs => ({
  org_id: profile.org_id,
  scope,
  ...P.args.overviewClock(),
})

/** teamSync.agenda for `profile` on the store's clock. */
const agendaOf = (t: T, P: Store, profile: Doc<'profiles'>, scope: AgendaScope) => {
  const args = argsOf(P, profile, scope)
  return as(t, profile).query(api.teamSync.agenda, { ...args, week_starts: [...args.week_starts] })
}

/** What Team sync's stand-in answers `profile` for `scope` from the
 * workspace the store booted from, reading sight and edit rights from that
 * store, as the jsdom fixture does, on `args` when given, with `force`. */
const standInOf = (
  P: Store,
  profile: Doc<'profiles'>,
  scope: AgendaScope,
  args: SyncArgs = argsOf(P, profile, scope),
  force?: ForcedSync,
) =>
  teamSyncStandIn(P.snap, args, {
    sees: (id) => P.canSee(id),
    writes: (id) => P.canWrite(id),
    force,
  })

/** The scopes the page offers, as the server and the page name them. */
function scopesOf(P: Store): [label: string, server: AgendaScope, page: SyncScope][] {
  const out: [string, AgendaScope, SyncScope][] = [
    ['All projects', { kind: 'all' }, { kind: 'all' }],
  ]
  for (const team of P.teams.filter((x) => x.org === P.homeOrg))
    out.push([
      `team ${team.name}`,
      { kind: 'team', team_id: team.id },
      { kind: 'team', id: team.id },
    ])
  for (const meta of oracleStore(P.snap)
    .visibleProjects()
    .filter((p) => p.org === P.homeOrg)) {
    out.push([
      meta.name,
      { kind: 'project', project_id: meta.id },
      { kind: 'project', id: meta.id },
    ])
    for (const id of meta.children ?? [])
      if (P.canSee(id))
        out.push([
          P.project(id)?.name ?? id,
          { kind: 'project', project_id: id },
          { kind: 'project', id },
        ])
  }
  return out
}

/** Whether row `r`'s verdict needs its owner's load (convex/lib/viewLoads.ts
 * verdicts needs), which an organization Viewer's agenda does not read. */
function needsLoad(P: Store, r: Extract<AgendaAnswer, { state: 'ok' }>['rows'][number]): boolean {
  if (r.end_week === undefined && r.due_date === undefined) return false
  if (!((r.remaining_hours ?? 0) > 0)) return false
  const owner = taskOwnerId(r, false)
  // the owner's face, which the test named (nameEveryone)
  const u = owner === undefined ? null : P.person(owner)
  if (u?.state !== 'ok') return false
  const capacity = plannableHoursOf(u)
  return Number.isFinite(capacity) && capacity > 0
}

/** Compares the agenda of `server` for `profile` with what store `P`
 * derives for `page` at `now`, and answers it. */
async function expectMeeting(
  t: T,
  P: Store,
  profile: Doc<'profiles'>,
  server: AgendaScope,
  page: SyncScope,
  now: number,
  label: string,
) {
  const answer = await agendaOf(t, P, profile, server)
  if (answer.state !== 'ok') throw new Error(`${label}: ${JSON.stringify(answer)}`)
  // the stand-in answers the same, field for field
  expect(standInOf(P, profile, server), `${label}: the stand-in`).toEqual(answer)
  const m = P.oracle.meetingOf(page, now, P.snap)
  expect(answer.sub_projects, `${label}: sub-projects`).toEqual(sorted(m.subIds))
  expect(answer.top_projects, `${label}: top-level projects`).toEqual(sorted(m.metaIds))
  const rowIds = new Set(answer.rows.map((r) => r.id))
  expect(sorted(rowIds), `${label}: rows`).toEqual(sorted(m.rows.map((it) => it.uuid)))
  expect(
    answer.people.map((p) => p.id),
    `${label}: people`,
  ).toEqual(sorted(m.walkers.map((u) => u.id)))
  // Needs an owner, the rows it lists and the asks
  expect(sorted(answer.asks.map((r) => r.id)), `${label}: asks`).toEqual(
    sorted(m.asks.filter((it) => !rowIds.has(it.uuid)).map((it) => it.uuid)),
  )
  const byUuid = new Map(P.issues.map((it) => [it.uuid, it]))
  const vm = (id: string): Issue => {
    const it = byUuid.get(id)
    if (it === undefined) throw new Error(`${label}: the store does not show ${id}`)
    return it
  }
  // each walker's Done since from the answer's Done tasks, by the page's
  // exact reading point
  const done = answer.done.map((r) => vm(r.id))
  for (const u of m.walkers) {
    const exact = (m.doneOf.get(u.id) ?? []).map((d) => [d.issue.uuid, d.kind])
    const kept = P.rules
      .doneSince(u.id, done, m.subIds, m.sinceOf(u))
      .map((d) => [d.issue.uuid, d.kind])
    expect(kept, `${label}: Done since of ${u.name}`).toEqual(exact)
  }
  // each row's blockers and verdict
  const staff = profile.org_role === 'admin' || profile.org_role === 'user'
  for (const r of answer.rows) {
    const it = vm(r.id)
    expect(r.blocked_by, `${label}: blockers of ${it.key}`).toEqual(m.blockers(it))
    const tracks = P.tracksDelay(it)
    const expected = staff || !tracks || !needsLoad(P, r) ? m.verdict(it) : 'unknown'
    expect(r.delay, `${label}: verdict of ${it.key}`).toBe(expected)
  }
  // each walker's week
  for (const p of answer.people) {
    const u = m.walkers.find((w) => w.id === p.id)
    if (u === undefined) throw new Error(`${label}: no ${p.id}`)
    expect(p.week, `${label}: week of ${u.name}`).toEqual(
      staff
        ? { state: 'ok', hours: roundTenths(m.week(u)) }
        : { state: 'unavailable', reason: 'loads' },
    )
    expect(p.stamp ?? null, `${label}: stamp of ${u.name}`).toEqual(
      u.sync === null ? null : JSON.parse(JSON.stringify(u.sync)),
    )
  }
  expect(answer.editable, `${label}: editable`).toEqual(sorted(m.editable))
  // the shown ancestors of the agenda's tasks that are none of them
  const inAgenda = new Set([
    ...rowIds,
    ...answer.asks.map((r) => r.id),
    ...answer.done.map((r) => r.id),
  ])
  const ancestors = new Set<string>()
  for (const id of inAgenda) {
    const seen = new Set([id])
    for (
      let p = P.issueById[vm(id).parent ?? ''];
      p !== undefined && !seen.has(p.uuid);
      p = P.issueById[p.parent ?? '']
    ) {
      seen.add(p.uuid)
      if (!inAgenda.has(p.uuid)) ancestors.add(p.uuid)
    }
  }
  expect(sorted(answer.parents.map((r) => r.id)), `${label}: parents`).toEqual(sorted(ancestors))
  return answer
}

/** Every scope of store `P` for `profile`, compared; answers how many rows,
 * asks, Done tasks and blocked rows they held. */
async function compareAll(t: T, P: Store, profile: Doc<'profiles'>, now: number) {
  const found = { rows: 0, asks: 0, done: 0, blocked: 0, unknown: 0 }
  for (const [label, server, page] of scopesOf(P)) {
    const ok = await expectMeeting(t, P, profile, server, page, now, `${profile.name}, ${label}`)
    found.rows += ok.rows.length
    found.asks += ok.asks.length
    found.done += ok.done.length
    found.blocked += ok.rows.filter((r) => r.blocked_by.length > 0).length
    found.unknown += ok.rows.filter((r) => r.delay === 'unknown').length
  }
  return found
}

// ---------------------------------------------------------------- Northstar

describe('Northstar', () => {
  it('answers what the page derives, for Nora, Leo and Ben, every scope', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    await withReach(t)
    await countOrg(t, profiles[0].org_id)
    const person = async (key: string) => {
      const id = await northstarId(`person:${key}`)
      const p = profiles.find((profile) => profile.id === id)
      if (p === undefined) throw new Error(`no ${key}`)
      return p
    }
    const [nora, leo, ben, aisha, daniel] = await Promise.all(
      ['nora', 'leo', 'ben', 'aisha', 'daniel'].map(person),
    )
    // two days into the dataset's anchor week, 14:00 in New York; Aisha's
    // sitting runs, Daniel's ended this morning
    const now = Date.parse('2026-09-09T18:00:00.000Z')
    await t.run(async (ctx) => {
      for (const [p, stamp] of [
        [aisha, { at: '2026-09-09T17:00:00.000Z', since: '2026-09-01T15:00:00.000Z' }],
        [daniel, { at: '2026-09-09T11:00:00.000Z', since: '2026-09-04T15:00:00.000Z' }],
      ] as const) {
        const row = await ctx.db
          .query('sync_stamps')
          .withIndex('by_profile', (q) => q.eq('profile_id', p.id))
          .unique()
        if (row !== null) await ctx.db.delete(row._id)
        await ctx.db.insert('sync_stamps', { org_id: p.org_id, profile_id: p.id, ...stamp })
      }
    })
    const totals = []
    for (const profile of [nora, leo, ben]) {
      const P = await storeOf(t, profile, now)
      totals.push(await compareAll(t, P, profile, now))
    }
    console.log('Team sync parity over Northstar:', JSON.stringify(totals))
    expect(totals[0].rows).toBeGreaterThan(0)
    expect(totals[0].done).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------- access shapes

/** The tasks every access case plants over the withOrg fixture for
 * `subject`. FW tracks delay. In FW, PCB, a sibling sub-project and a
 * sub-project of SKNK: rows of the subject and the user, an In Review row
 * the user reviews, scheduled rows with hours, Backlog asks, Done tasks
 * reviewed with and without a hand-off, a group in FW with a subtask in
 * the sibling, and blocks links from tasks in PCB, the sibling and SKNK to
 * a row in FW, and a team of the user that shares TBED and PCB. The
 * subject's sitting runs, and so does the user's, from another point. */
async function plantCase(t: T, f: OrgFixture, subject: Doc<'profiles'>) {
  const org_id = f.org.id
  const skunk = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
  const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
  await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
  const team = await plantTeam(t, org_id, 'Platform', [f.user], [f.meta, f.sub2])
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>>) =>
    plantIssue(t, { org_id, project_id: project.id, ...fields })
  const week = '2025-12-29'
  const blocked = await task(f.sub, {
    title: 'Blocked in FW',
    assignee_id: subject.id,
    start_week: week,
    end_week: week,
    due_date: '2026-01-02',
    remaining_hours: 50,
  })
  for (const project of [f.sub, f.sub2, sibling, skunk]) {
    await task(project, {
      title: 'The user’s',
      assignee_id: f.user.id,
      start_week: week,
      end_week: week,
      remaining_hours: 30,
    })
    await task(project, {
      title: 'Reviewed by the user',
      status: 'review',
      assignee_id: subject.id,
      reviewer_id: f.user.id,
    })
    await task(project, {
      title: 'An ask',
      status: 'backlog',
      due_date: '2026-01-10',
      priority: 'high',
    })
    await task(project, {
      title: 'Done, handed',
      status: 'done',
      assignee_id: subject.id,
      reviewer_id: f.user.id,
      review_at: '2025-12-31T20:00:00.000Z',
      done_at: '2025-12-31T21:00:00.000Z',
    })
    await task(project, {
      title: 'Done, no hand-off',
      status: 'done',
      assignee_id: subject.id,
      reviewer_id: f.user.id,
      done_at: '2025-12-31T21:00:00.000Z',
    })
    await task(project, {
      title: 'Done long ago',
      status: 'done',
      assignee_id: f.user.id,
      done_at: '2025-12-20T12:00:00.000Z',
    })
    const blocker = await task(project, { title: 'A blocker', status: 'todo' })
    await plantBlocks(t, [[blocker, blocked]])
  }
  const group = await task(f.sub, { title: 'A group', assignee_id: subject.id })
  await task(sibling, { title: 'Its subtask', parent_id: group.id, assignee_id: f.user.id })
  await task(f.sub, { title: 'Unassigned urgent', priority: 'urgent' })
  await plantStamp(t, subject, {
    at: '2026-01-01T15:30:00.000Z',
    since: '2025-12-24T15:00:00.000Z',
  })
  await plantStamp(t, f.user, { at: '2026-01-01T13:00:00.000Z', since: '2025-12-31T14:00:00.000Z' })
  await withReach(t)
  await countOrg(t, org_id)
  return { team, sibling, skunk, blocked }
}

/** One access case, `shape` planted for a fresh seat of `role`, or the
 * fixture's admin, who reads by grants, without a shape, compared over every scope. */
async function compareShape(
  shape: (typeof SHAPES)[number] | null,
  role: 'user' | 'guest' | 'viewer' | 'admin',
) {
  const t = newT()
  const f = await withReadingAdmin(t)
  const subject =
    role === 'admin' && shape === null
      ? f.admin
      : await plantSeat(t, { org_id: f.org.id, org_role: role, auth_user_id: `auth_${uuid()}` })
  if (shape !== null) await t.run((ctx) => shape[1](ctx, f, subject))
  const planted = await plantCase(t, f, subject)
  // noon in New York on NOW's day, Thursday 1 January 2026
  const now = Date.parse('2026-01-01T17:00:00.000Z')
  const P = await storeOf(t, subject, now)
  if (role === 'guest') {
    // a guest never reaches the page, and the agenda answers alike, as does
    // the stand-in
    for (const [label, server] of scopesOf(P)) {
      expect(await agendaOf(t, P, subject, server), label).toEqual({ state: 'unavailable' })
      expect(standInOf(P, subject, server), label).toEqual({ state: 'unavailable' })
    }
    return { found: null, t, f, P, subject, now, ...planted }
  }
  return { found: await compareAll(t, P, subject, now), t, f, P, subject, now, ...planted }
}

describe('access shapes', () => {
  it('answers what the page derives for the fixture’s admin, who reads by grants', async () => {
    const { found } = await compareShape(null, 'admin')
    expect(found?.rows).toBeGreaterThan(0)
    expect(found?.asks).toBeGreaterThan(0)
    expect(found?.done).toBeGreaterThan(0)
    expect(found?.blocked).toBeGreaterThan(0)
  })

  // an admin's seat is judged by its own rows, as any member's
  for (const role of ['admin', 'user', 'guest', 'viewer'] as const)
    it(`answers what the page derives for ${role === 'admin' ? 'an' : 'a'} ${role} in every shape`, async () => {
      let showing = 0
      for (const shape of SHAPES) {
        const { found } = await compareShape(shape, role)
        if ((found?.rows ?? 0) > 0) showing++
      }
      if (role === 'guest') expect(showing).toBe(0)
      else expect(showing).toBeGreaterThan(SHAPES.length / 3)
    })
})

// ------------------------------------------------- the rules that must hold

describe('the rules that must hold', () => {
  it('differs from a Backlog task or a group taken as a row, from a review without a hand-off, from a fallback to All projects and from a blocker past sight', async () => {
    const { t, f, P, subject, now, blocked } = await compareShape(null, 'admin')
    const answer = await agendaOf(t, P, subject, { kind: 'project', project_id: f.meta.id })
    if (answer.state !== 'ok') throw new Error(answer.state)
    const rows = sorted(answer.rows.map((r) => r.id))
    const m = P.oracle.meetingOf({ kind: 'project', id: f.meta.id }, now, P.snap)
    const inScope = (it: Issue) => m.subIds.has(it.project)
    const open = ['todo', 'progress', 'review']
    // a Backlog task as a row
    const withBacklog = P.issues.filter(
      (it) => inScope(it) && [...open, 'backlog'].includes(it.status) && !P.isGroup(it),
    )
    expect(sorted(withBacklog.map((it) => it.uuid))).not.toEqual(rows)
    // a group as a row
    const withGroups = P.issues.filter((it) => inScope(it) && open.includes(it.status))
    expect(sorted(withGroups.map((it) => it.uuid))).not.toEqual(rows)
    // a review counted without its hand-off
    const done = answer.done.map((r) => P.issues.find((it) => it.uuid === r.id) as Issue)
    const user = m.walkers.find((w) => w.id === f.user.id)
    if (!user) throw new Error('user')
    const drifted = done.filter(
      (it) =>
        it.reviewer === f.user.id &&
        it.assignee !== f.user.id &&
        (it.doneAt ?? 0) >= m.sinceOf(user),
    )
    const kept = P.rules.doneSince(f.user.id, done, m.subIds, m.sinceOf(user))
    expect(drifted.length).toBeGreaterThan(kept.filter((d) => d.kind === 'reviewed').length)
    // a scope the page would answer as All projects: the agenda and the
    // stand-in answer unavailable, where a stand-in that fell back would
    // answer All projects' meeting, an ok one here
    const unknown = uuid()
    expect(
      P.oracle.resolveSyncScope({ kind: 'team', id: unknown }, P.oracle.worldOf(P.snap)),
    ).toEqual({
      kind: 'all',
    })
    const refused = await agendaOf(t, P, subject, { kind: 'team', team_id: unknown })
    expect(refused).toEqual({ state: 'unavailable' })
    expect(standInOf(P, subject, { kind: 'team', team_id: unknown })).toEqual(refused)
    expect(standInOf(P, subject, { kind: 'all' }).state).toBe('ok')
    // the stand-in's context bound is the agenda's
    expect(SYNC_CONTEXT).toBe(AGENDA.context)
    // a blocker read past sight, as the stored links name one in SKNK's
    // sub-project, which the admin sees, so read as the viewer instead
    const viewer = f.viewer
    const V = await storeOf(t, viewer, now)
    const theirs = await agendaOf(t, V, viewer, { kind: 'project', project_id: f.meta.id })
    if (theirs.state !== 'ok') throw new Error(theirs.state)
    const row = theirs.rows.find((r) => r.id === blocked.id)
    const stored = await t.run(async (ctx) => {
      const links = await ctx.db
        .query('issue_links')
        .withIndex('by_target', (q) => q.eq('target_id', blocked.id))
        .collect()
      const keys: string[] = []
      for (const link of links) {
        const source = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', link.source_id))
          .unique()
        if (source !== null) keys.push(`QN-${source.num}`)
      }
      return keys
    })
    expect(row?.blocked_by.length).toBeLessThan(stored.length)
    expect(sorted(row?.blocked_by ?? [])).not.toEqual(sorted(stored))
  })

  it('differs from a stand-in that reads its floors from UTC midnights or adds a week up without rounding', async () => {
    const { t, f, subject, now } = await compareShape(null, 'admin')
    // Carol has no stamp, so she reads from the local midnight of the
    // working day before today, Wednesday 31 December in New York, which is
    // 05:00 UTC. She finished a task at 02:00 UTC, between the two
    // midnights, and holds 10 hours over this week and the next two.
    const carol = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      name: 'Carol',
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Carol’s spread',
      assignee_id: carol.id,
      start_week: '2025-12-29',
      end_week: '2026-01-12',
      remaining_hours: 10,
    })
    const late = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Done before the local midnight',
      status: 'done',
      assignee_id: carol.id,
      done_at: '2025-12-31T02:00:00.000Z',
    })
    await withReach(t)
    await countOrg(t, f.org.id)
    const P = await storeOf(t, subject, now)
    const scope = { kind: 'project', project_id: f.meta.id } as const
    const answer = await agendaOf(t, P, subject, scope)
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(standInOf(P, subject, scope)).toEqual(answer)
    expect(answer.done.map((r) => r.id)).not.toContain(late.id)
    // floors from UTC midnights take the task in, which must fail
    const args = argsOf(P, subject, scope)
    const utc = (ms: number) => {
      const d = new Date(ms)
      return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
    }
    const drifted = {
      ...args,
      week_starts: args.week_starts.map(utc),
      week_end: utc(args.week_end),
    }
    expect(readingBounds(null, drifted).floor).toBeLessThan(readingBounds(null, args).floor)
    const fromUtc = standInOf(P, subject, scope, drifted)
    if (fromUtc.state !== 'ok') throw new Error(fromUtc.state)
    expect(fromUtc.done.map((r) => r.id)).toContain(late.id)
    expect(fromUtc).not.toEqual(answer)
    // a third of 10 hours is not a whole tenth: the answer rounds it once,
    // and a week left unrounded must fail
    const week = answer.people.find((p) => p.id === carol.id)?.week
    expect(week).toEqual({ state: 'ok', hours: 3.3 })
    expect(week).not.toEqual({ state: 'ok', hours: 10 / 3 })
  })

  it('refuses past a lowered ceiling as the agenda does, over_ceiling from rows, asks and certain Done tasks and over_budget where only those the floor reads pass it', async () => {
    const { t, f, subject, now } = await compareShape(null, 'admin')
    // a Done task after the subject's latest reading point, the start of
    // their sitting, so certain; the case's other Done tasks are older and
    // only their reading floors read them
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Done in the sitting',
      status: 'done',
      assignee_id: subject.id,
      done_at: '2026-01-01T16:00:00.000Z',
    })
    await withReach(t)
    await countOrg(t, f.org.id)
    const P = await storeOf(t, subject, now)
    const scope = { kind: 'project', project_id: f.meta.id } as const
    const whole = await agendaOf(t, P, subject, scope)
    if (whole.state !== 'ok') throw new Error(whole.state)
    const fixed = whole.rows.length + whole.asks.length
    // the agenda's module as the server reads it after the store's reset
    const { AGENDA: agenda } = await import('../../convex/lib/teamSyncAgenda')
    const was = agenda.ceiling
    const states = new Map<number, string>()
    try {
      for (let ceiling = fixed - 1; ceiling <= fixed + whole.done.length; ceiling++) {
        agenda.ceiling = ceiling
        const real = await agendaOf(t, P, subject, scope)
        expect(
          standInOf(P, subject, scope, argsOf(P, subject, scope), { ceiling }),
          `ceiling ${ceiling}`,
        ).toEqual(real)
        states.set(ceiling, real.state)
      }
    } finally {
      agenda.ceiling = was
    }
    // past the rows and asks; at them, the certain Done task passes it, which
    // a stand-in that judged the floors first would answer over_budget
    expect(states.get(fixed - 1)).toBe('over_ceiling')
    expect(states.get(fixed)).toBe('over_ceiling')
    expect([...states.values()]).toContain('over_budget')
    expect(states.get(fixed + whole.done.length)).toBe('ok')
  })
})
