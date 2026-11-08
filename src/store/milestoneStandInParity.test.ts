/* The milestone stand-in (store/milestoneStandIn.setup.ts), which the
 * jsdom tests and the browser benchmark answer the app's three milestone
 * reads with, against the real reads (convex/milestones.ts get, section and
 * between) in convex-test over Northstar and a few planted rows: two
 * milestones of one project on one day, days that do not exist
 * (2026-02-31, and 2026-09-31, which shows on the first day of a read from
 * 1 October), stored days just before a read's first day, milestones of an
 * archived top-level project and of an archived sub-project, one stored
 * on a sub-project, a Viewer with a grant on one top-level project, and a
 * guest who sees a top-level project only to reach one of its
 * sub-projects. Each read names every top-level project the person sees,
 * a sub-project, the archived ones and one id twice. For every person,
 * each section walked in batches of two lists the same milestones in the
 * same order, the first upcoming batch says the same `past`, a search
 * finds the same rows, a section read at the cap of 100 rows and one of 50
 * rows after a row of it (a Load more and a move on, src/lib/
 * milestoneSection.ts) answer the same rows, a range of 26 weeks answers
 * the same rows, and
 * every milestone of the organization opens the same way, `can_write`
 * included. The stand-in answers from each person's workspace with every
 * milestone the database holds beside it, as the published whole carries
 * the server's milestones that no part sends, and its own rules leave out
 * what the person cannot list. My view's sections, read with `mine`, list
 * the same projects
 * and walk the same milestones. The stand-in answers `next` null once no
 * milestone follows,
 * where the real read can answer a `next` that leads to an empty batch, so
 * the walks compare rows, not batches. The numbers the stand-in copies
 * equal the server's. A `mine` read of a Northstar person whose work lies
 * in more top-level projects than one read names, with that figure
 * lowered, is refused in the stand-in's words, and the store booted from
 * the person's workspace shows the real refusal as too many. */

import { getFunctionName } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { LIMITS } from '../../convex/lib/limits'
import { MILESTONE_READ, MILESTONE_TOO_MANY, OVERFLOW_DAYS } from '../../convex/model/milestones'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantProject,
  plantSeat,
  type T,
  uuid,
  wholeOf,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { NORTHSTAR_ANCHOR, plantNorthstar } from '../../convex/tests/northstar.setup'
import { withReach } from '../../convex/tests/projectReach.setup'
import type { Whole } from './guard/liveDouble.setup'
import { type MilestonePosition, positionOf } from './milestoneRows'
import {
  isMilestoneRead,
  MILESTONE_STAND_IN_NUMBERS,
  type MilestoneReadArgs,
  milestoneStandIn,
} from './milestoneStandIn.setup'

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

const DAY = 86_400_000
/* `day` moved by `days`. */
const plus = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10)

/* Stores a milestone directly, as rows stored before the weekly rule were. */
const plant = (t: T, projectId: string, week: string, name: string) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('milestones', { id, project_id: projectId, name, week, created_at: NOW })
    return id
  })

type Caller = ReturnType<typeof as>
type Batch = {
  rows: { id: string; name: string; week: string }[]
  next: MilestonePosition | null
  past?: boolean
  projects?: string[]
}

/** Every row of a section from its start, following `next`, from the real
    read or the stand-in, and the first batch's `past`. */
async function walk(
  ask: (after: MilestonePosition | undefined) => Promise<Batch>,
): Promise<{ ids: string[]; past: boolean | undefined }> {
  const ids: string[] = []
  let after: MilestonePosition | undefined
  let past: boolean | undefined
  for (let round = 0; round < 200; round++) {
    const batch = await ask(after)
    if (round === 0) past = batch.past
    ids.push(...batch.rows.map((row) => row.id))
    if (batch.next === null) return { ids, past }
    after = batch.next
  }
  throw new Error('the section did not end')
}

/** The stand-in's answer of `query` with `args` over `snap`, a published
    whole. */
const standIn = (snap: Whole, query: 'get' | 'section' | 'between', args: MilestoneReadArgs) =>
  milestoneStandIn(snap, query, args) as Batch

/** Compares the stand-in's sections and range from `from` with the
    reads for `caller`, over the top-level projects its workspace in `snap`
    shows and the ids `named` (a sub-project, archived projects, an id
    twice), and with `all` every milestone's `get`. `snap` is the whole the
    stand-in answers from, the caller's workspace with the database's
    milestones. Answers the ids the sections listed. */
async function compare(
  caller: Caller,
  snap: Whole,
  all: readonly Doc<'milestones'>[],
  from: string,
  named: readonly string[],
) {
  const tops = snap.projects.filter((p) => p.parent_id === undefined).map((p) => p.id)
  const projects = [...tops, ...named, ...tops.slice(0, 1)]
  const listed = new Set<string>()
  for (const side of ['upcoming', 'past'] as const)
    for (const search of ['', 'review']) {
      const base = { projects, from, side, limit: 2, ...(search ? { search } : {}) }
      const real = await walk(
        (after) =>
          caller.query(api.milestones.section, {
            ...base,
            ...(after ? { after } : {}),
          }) as Promise<Batch>,
      )
      const stand = await walk(async (after) => standIn(snap, 'section', { ...base, after }))
      expect(stand.ids, `${side} "${search}"`).toEqual(real.ids)
      expect(stand.past, `${side} "${search}" past`).toEqual(real.past)
      for (const id of real.ids) listed.add(id)
    }
  // a section grown to the cap in one read, and one moved on after a row
  // of it, as the window's Load more asks them
  for (const side of ['upcoming', 'past'] as const) {
    const grown = { projects, from, side, limit: 100 }
    const real = (await caller.query(api.milestones.section, grown)) as Batch
    const stand = standIn(snap, 'section', grown)
    expect(
      stand.rows.map((r) => r.id),
      `${side} at 100`,
    ).toEqual(real.rows.map((r) => r.id))
    expect(stand.past, `${side} at 100 past`).toEqual(real.past)
    const row = real.rows[0]
    if (!row) continue
    const moved = { ...grown, limit: 50, after: positionOf(row) }
    const realMoved = (await caller.query(api.milestones.section, moved)) as Batch
    expect(
      standIn(snap, 'section', moved).rows.map((r) => r.id),
      `${side} at 50 after a row`,
    ).toEqual(realMoved.rows.map((r) => r.id))
    expect(realMoved.rows.map((r) => r.id)).toEqual(real.rows.slice(1, 51).map((r) => r.id))
  }
  // the whole list, and each id of `named` alone: a sub-project stands for
  // its top-level project, and an archived project for none
  for (const over of [projects, ...named.map((id) => [id])]) {
    const range = { projects: over, from, to: plus(from, 7 * 26) }
    const real = await caller.query(api.milestones.between, range)
    expect(real.next).toBeNull()
    expect(standIn(snap, 'between', range), `range over ${over.length}`).toEqual(real)
  }
  for (const m of all) {
    const got = await caller.query(api.milestones.get, { id: m.id })
    expect(milestoneStandIn(snap, 'get', { id: m.id }), m.name).toEqual(got)
  }
  // My view's sections, whose projects the server finds from the
  // person's own tasks
  for (const side of ['upcoming', 'past'] as const) {
    const base = { projects: [], mine: true as const, from, side, limit: 2 }
    const real = await walk(
      (after) =>
        caller.query(api.milestones.section, {
          ...base,
          ...(after ? { after } : {}),
        }) as Promise<Batch>,
    )
    const stand = await walk(async (after) => standIn(snap, 'section', { ...base, after }))
    expect(stand.ids, `mine ${side}`).toEqual(real.ids)
    expect(stand.past, `mine ${side} past`).toEqual(real.past)
    const whole = { ...base, limit: 100 }
    const got = (await caller.query(api.milestones.section, whole)) as Batch
    expect(standIn(snap, 'section', whole).projects, `mine ${side} projects`).toEqual(got.projects)
  }
  return listed
}

describe('the milestone stand-in against the reads', () => {
  it('copies the numbers of the reads', () => {
    expect(MILESTONE_STAND_IN_NUMBERS).toEqual({
      overflowDays: OVERFLOW_DAYS,
      sectionRows: MILESTONE_READ.rows,
      rangeWeeks: LIMITS.roadmapWeeks.max,
    })
  })

  it('answers every Northstar person and the planted seats as the reads do', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    const admin = profiles.find((p) => p.org_role === 'admin')
    if (!admin) throw new Error('Northstar has no admin')
    const adminSnap = await wholeOf(t, admin)
    if (adminSnap === null) throw new Error('no workspace for the admin')
    const tops = adminSnap.projects.filter((p) => p.parent_id === undefined)
    const parent = tops.find((p) => adminSnap.projects.some((s) => s.parent_id === p.id))
    const child = adminSnap.projects.find((p) => p.parent_id === parent?.id)
    const other = tops.find((p) => p.id !== parent?.id)
    if (!parent || !child || !other) throw new Error('Northstar has too few projects')
    const from = plus(NORTHSTAR_ANCHOR, 7)
    // a second first day, 1 October, which 2026-09-31 shows on
    const october = '2026-10-01'
    // two milestones of one project on one day, days that do not exist, and
    // stored days just before each first day
    const planted = [
      await plant(t, parent.id, plus(NORTHSTAR_ANCHOR, 15), 'Bench review'),
      await plant(t, parent.id, plus(NORTHSTAR_ANCHOR, 15), 'bench review'),
      await plant(t, other.id, '2026-02-31', 'Leap review'),
      await plant(t, other.id, '2026-09-31', 'Overflow review'),
      await plant(t, other.id, plus(from, -1), 'Eve review'),
      await plant(t, parent.id, plus(october, -1), 'Month end review'),
    ]
    // milestones no read lists: of an archived top-level project, of an
    // archived sub-project, and one stored on a sub-project
    const archivedTop = await plantProject(t, { org_id: org.id, archived_at: NOW })
    const archivedSub = await plantProject(t, {
      org_id: org.id,
      type: 'project',
      parent_id: parent.id,
      archived_at: NOW,
    })
    const hidden = [
      await plant(t, archivedTop.id, plus(from, 2), 'Archived plan review'),
      await plant(t, archivedSub.id, plus(from, 3), 'Archived part review'),
      await plant(t, child.id, plus(from, 4), 'Part review'),
    ]
    const named = [child.id, archivedTop.id, archivedSub.id]
    // a Viewer with a grant on one top-level project, and a guest who sees
    // `parent` only to reach `child`
    const viewer = await plantSeat(t, {
      org_id: org.id,
      name: 'Vera Viewer',
      org_role: 'viewer',
      auth_user_id: 'auth_vera',
    })
    const guest = await plantSeat(t, {
      org_id: org.id,
      name: 'Gus Guest',
      org_role: 'guest',
      auth_user_id: 'auth_gus',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: other.id,
        profile_id: viewer.id,
        level: 'viewer',
      })
      await ctx.db.insert('project_access', {
        project_id: child.id,
        profile_id: guest.id,
        level: 'user',
      })
    })
    await withReach(t)
    const all = await t.run((ctx) => ctx.db.query('milestones').collect())
    let writable = 0
    for (const person of [...profiles.filter((p) => p.kind === 'person'), viewer, guest]) {
      const caller = as(t, person)
      const workspace = await wholeOf(t, person)
      if (workspace === null) throw new Error(`${person.name} holds no seat`)
      // the server's whole, the person's workspace with every stored
      // milestone beside it, which no part sends
      const snap = { ...workspace, milestones: all.map(({ _id, _creationTime, ...row }) => row) }
      const listed = await compare(caller, snap, all, from, named)
      for (const id of await compare(caller, snap, [], october, named)) listed.add(id)
      // the admin's sections reach every planted row, and none of the rows
      // no read lists
      if (person === admin) for (const id of planted) expect(listed.has(id)).toBe(true)
      for (const id of hidden) expect(listed.has(id)).toBe(false)
      for (const m of all) {
        const got = milestoneStandIn(snap, 'get', { id: m.id }) as { can_write: boolean } | null
        if (got?.can_write) writable++
      }
    }
    // the guest opens the parent's milestones read-only, the Viewer theirs
    for (const [seat, project] of [
      [guest, parent.id],
      [viewer, other.id],
    ] as const) {
      const id = all.find((m) => m.project_id === project)?.id ?? ''
      const got = await as(t, seat).query(api.milestones.get, { id })
      expect(got?.can_write, seat.name).toBe(false)
    }
    expect(writable).toBeGreaterThan(0)
  })

  it("refuses a mine read past the projects one read names in the stand-in's words, which the store shows as too many", async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    const from = plus(NORTHSTAR_ANCHOR, 7)
    const ask = { projects: [], mine: true as const, from, side: 'upcoming' as const, limit: 10 }
    // a person whose own work lies in at least one top-level project
    let person: Doc<'profiles'> | undefined
    let listed = 0
    for (const p of profiles.filter((x) => x.kind === 'person')) {
      const got = (await as(t, p).query(api.milestones.section, ask)) as Batch
      if ((got.projects?.length ?? 0) > 0) {
        person = p
        listed = got.projects?.length ?? 0
        break
      }
    }
    if (!person) throw new Error('no Northstar person holds work')
    const caller = as(t, person)
    const snap = await workspaceOf(caller)
    if (snap === null) throw new Error(`${person.name} holds no seat`)
    const projects = MILESTONE_READ.projects
    MILESTONE_READ.projects = listed - 1
    try {
      const real = await expectRefusal(caller.query(api.milestones.section, ask), 'rule')
      expect(real.data.reason).toBe(MILESTONE_TOO_MANY)
      let stand: unknown
      try {
        milestoneStandIn(snap, 'section', ask, { mine: 'too_many' })
      } catch (e) {
        stand = e
      }
      expect((stand as { data?: unknown } | undefined)?.data).toEqual(real.data)
      // the store, booted from the person's workspace, asks the real read
      // and shows its refusal as too many. No other case boots it, and a
      // reset of the modules would give the real read a copy of
      // MILESTONE_READ that is not lowered.
      vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
      network.query.mockResolvedValue(null)
      network.mutation.mockResolvedValue(null)
      network.onUpdate.mockImplementation((ref, args, next, fail) => {
        const name = getFunctionName(ref)
        if (name === 'workspace:whole') next(structuredClone(snap))
        else if (isMilestoneRead(name)) caller.query(ref, args).then(next, fail)
        return () => {}
      })
      const store = await import('./planner')
      await store.initStore()
      store.P.watchMilestones('mine', { kind: 'section', ...ask })
      await vi.waitFor(() => expect(store.P.milestoneRead('mine')).toEqual({ state: 'too_many' }), {
        timeout: 10_000,
      })
    } finally {
      MILESTONE_READ.projects = projects
      vi.unstubAllGlobals()
    }
  })
})
