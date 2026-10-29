/* The app's bounded milestone reads (milestones.ts, model/milestones.ts
 * readMilestones): a section of upcoming or past milestones a batch at a
 * time over projects of several organizations, the milestones of a range of
 * days, and one milestone by id. Rows are planted directly where the weekly
 * rule would refuse them (two on one day, days that do not exist), as rows
 * stored before the rule are. */
/// <reference types="vite/client" />

import type { FunctionArgs, FunctionReturnType, TransactionMetrics } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ACCESS_UNCHECKED, OWN_READS, projectLevelsOf } from '../lib/access'
import { LIMITS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { rowOf } from '../lib/workspaceParts'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import {
  MILESTONE_NAV,
  MILESTONE_READ,
  MILESTONE_READ_TOO_LARGE,
  type MilestonePosition,
  milestoneProjects,
  readMilestones,
} from '../model/milestones'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
import { NORTHSTAR_ANCHOR, plantNorthstar } from './northstar.setup'

const DAY = 86_400_000

/* `day` moved by `days`. */
const plus = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10)

/* A Monday, the first day of a week in the fixture's organization. */
const MONDAY = '2026-06-01'

type SectionArgs = FunctionArgs<typeof api.milestones.section>
type Section = FunctionReturnType<typeof api.milestones.section>
type RangeArgs = FunctionArgs<typeof api.milestones.between>
type Range = FunctionReturnType<typeof api.milestones.between>
type Caller = ReturnType<typeof as>

const READ = { ...MILESTONE_READ }
const NAV = { ...MILESTONE_NAV }
afterEach(() => {
  Object.assign(MILESTONE_READ, READ)
  Object.assign(MILESTONE_NAV, NAV)
})

/* Stores a milestone directly, as rows stored before the weekly rule were. */
const plant = (t: T, projectId: string, week: string, name = 'Planted') =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('milestones', {
      id: uuid(),
      project_id: projectId,
      name,
      week,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'milestones'>
  })

/* Stores many milestones directly, in transactions of at most 2,000. */
async function plantMany(
  t: T,
  rows: readonly { project: string; week: string; name: string }[],
): Promise<Doc<'milestones'>[]> {
  const out: Doc<'milestones'>[] = []
  for (let at = 0; at < rows.length; at += 2000)
    out.push(
      ...(await t.run(async (ctx) => {
        const planted: Doc<'milestones'>[] = []
        for (const row of rows.slice(at, at + 2000)) {
          const _id = await ctx.db.insert('milestones', {
            id: uuid(),
            project_id: row.project,
            name: row.name,
            week: row.week,
            created_at: NOW,
          })
          planted.push((await ctx.db.get(_id)) as Doc<'milestones'>)
        }
        return planted
      })),
    )
  return out
}

/* A milestone or a position as the reads order it: stored day, then name
 * key, then id. */
type Placed = Pick<Doc<'milestones'>, 'week' | 'name' | 'id'> | MilestonePosition
const orderOf = (m: Placed) =>
  'key' in m ? [m.week, m.key, m.id] : [m.week, nameKey(m.name), m.id]

/* The reads' order. */
const compared = (a: Placed, b: Placed): number => {
  const x = orderOf(a)
  const y = orderOf(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}
const ascending = (rows: readonly Doc<'milestones'>[]) => [...rows].sort(compared).map((m) => m.id)
const descending = (rows: readonly Doc<'milestones'>[]) => ascending(rows).reverse()

/* Every batch of a section from its start, following `next`, each of
 * which must move past the position it started after. */
async function walk(
  caller: Caller,
  args: Omit<SectionArgs, 'after'>,
): Promise<{ ids: string[]; batches: Section[] }> {
  const batches: Section[] = []
  let after: SectionArgs['after']
  for (let round = 0; round < 500; round++) {
    const batch = await caller.query(api.milestones.section, {
      ...args,
      ...(after === undefined ? {} : { after }),
    })
    batches.push(batch)
    const { next } = batch
    if (next === null) return { ids: batches.flatMap((b) => b.rows.map((r) => r.id)), batches }
    if (after !== undefined)
      expect(args.side === 'upcoming' ? compared(next, after) : compared(after, next)).toBe(1)
    after = next
  }
  throw new Error('a section did not end within 500 batches')
}

/* Every batch of a range from its start, following `next`, each of which
 * must move past the position it started after. */
async function walkRange(
  caller: Caller,
  args: Omit<RangeArgs, 'after'>,
): Promise<{ ids: string[]; batches: Range[] }> {
  const batches: Range[] = []
  let after: RangeArgs['after']
  for (let round = 0; round < 500; round++) {
    const batch = await caller.query(api.milestones.between, {
      ...args,
      ...(after === undefined ? {} : { after }),
    })
    batches.push(batch)
    const { next } = batch
    if (next === null) return { ids: batches.flatMap((b) => b.rows.map((r) => r.id)), batches }
    if (after !== undefined) expect(compared(next, after)).toBe(1)
    after = next
  }
  throw new Error('a range did not end within 500 batches')
}

/* `count` top-level projects of the fixture's organization, each shared with
 * `f.user` at User level, so a read asks access project by project. */
async function shared(t: T, f: OrgFixture, count: number): Promise<string[]> {
  return await t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = uuid()
      await ctx.db.insert('projects', {
        id,
        org_id: f.org.id,
        type: 'meta',
        key: `L${i}`,
        name: `Load ${i}`,
        description: '',
        sort_order: 1000 + i,
        num: 1000 + i,
        track_delay: false,
        created_at: NOW,
        window_key: uuid().slice(0, 8),
      })
      await ctx.db.insert('project_access', {
        project_id: id,
        profile_id: f.user.id,
        level: 'user',
      })
      ids.push(id)
    }
    return ids
  })
}

/* `projects` top-level projects, each shared with each of `teams` teams that
 * `f.user` belongs to, with a milestone on the first. Their shares are more
 * than projectLevelsOf reads at once (lib/access.ts OWN_READS.rows), so a
 * check reads each project's shares one by one. */
async function sharedWithTeams(
  t: T,
  f: OrgFixture,
  projects: number,
  teams: number,
): Promise<{ ids: string[]; milestone: Doc<'milestones'> }> {
  return await t.run(async (ctx) => {
    const teamIds: string[] = []
    for (let i = 0; i < teams; i++) {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name: `Team ${i}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: id, profile_id: f.user.id, is_leader: false })
      teamIds.push(id)
    }
    const ids: string[] = []
    for (let i = 0; i < projects; i++) {
      const id = uuid()
      await ctx.db.insert('projects', {
        id,
        org_id: f.org.id,
        type: 'meta',
        key: `S${i}`,
        name: `Shared ${i}`,
        description: '',
        sort_order: 2000 + i,
        num: 2000 + i,
        track_delay: false,
        created_at: NOW,
        window_key: uuid().slice(0, 8),
      })
      for (const team_id of teamIds)
        await ctx.db.insert('project_team_access', { project_id: id, team_id, level: 'user' })
      ids.push(id)
    }
    const _id = await ctx.db.insert('milestones', {
      id: uuid(),
      project_id: ids[0],
      name: 'Shared milestone',
      week: MONDAY,
      created_at: NOW,
    })
    return { ids, milestone: (await ctx.db.get(_id)) as Doc<'milestones'> }
  })
}

/* `count` top-level projects, each with a grant for `who`, in transactions
 * of 1,000. */
async function grantsOn(t: T, f: OrgFixture, who: Doc<'profiles'>, count: number): Promise<void> {
  for (let at = 0; at < count; at += 1000)
    await t.run(async (ctx) => {
      for (let i = at; i < Math.min(count, at + 1000); i++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'meta',
          key: `G${i}`,
          name: `Granted ${i}`,
          description: '',
          sort_order: 50_000 + i,
          num: 50_000 + i,
          track_delay: false,
          created_at: NOW,
          window_key: uuid().slice(0, 8),
        })
        await ctx.db.insert('project_access', { project_id: id, profile_id: who.id, level: 'user' })
      }
    })
}

/* A team that `who` belongs to, shared on `count` top-level projects, in
 * transactions of 1,000. */
async function teamOn(t: T, f: OrgFixture, who: Doc<'profiles'>, count: number): Promise<void> {
  const team = uuid()
  await t.run(async (ctx) => {
    await ctx.db.insert('teams', {
      id: team,
      org_id: f.org.id,
      name: 'Everywhere',
      track_delay_default: false,
      created_at: NOW,
    })
    await ctx.db.insert('team_members', { team_id: team, profile_id: who.id, is_leader: false })
  })
  for (let at = 0; at < count; at += 1000)
    await t.run(async (ctx) => {
      for (let i = at; i < Math.min(count, at + 1000); i++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'meta',
          key: `T${i}`,
          name: `Team project ${i}`,
          description: '',
          sort_order: 70_000 + i,
          num: 70_000 + i,
          track_delay: false,
          created_at: NOW,
          window_key: uuid().slice(0, 8),
        })
        await ctx.db.insert('project_team_access', { project_id: id, team_id: team, level: 'user' })
      }
    })
}

/* `parents` top-level projects of `children` sub-projects each, with a
 * milestone on each parent. `who` holds a grant only on each parent's last
 * sub-project, so the parents show to them for navigation only, and a check
 * of each reads all its sub-projects. */
async function navigationOnly(
  t: T,
  f: OrgFixture,
  who: Doc<'profiles'>,
  parents: number,
  children: number,
): Promise<{ ids: string[]; milestones: Doc<'milestones'>[] }> {
  const ids: string[] = []
  const milestones: Doc<'milestones'>[] = []
  for (let p = 0; p < parents; p++)
    await t.run(async (ctx) => {
      const project = (extra: Partial<Doc<'projects'>>, n: number) => ({
        id: uuid(),
        org_id: f.org.id,
        type: 'meta' as const,
        key: `N${p}X${n}`,
        name: `Nav ${p} ${n}`,
        description: '',
        sort_order: n,
        num: 10_000 * (p + 1) + n,
        track_delay: false,
        created_at: NOW,
        window_key: uuid().slice(0, 8),
        ...extra,
      })
      const parent = project({}, 0)
      await ctx.db.insert('projects', parent)
      let last = ''
      for (let c = 1; c <= children; c++) {
        const child = project({ type: 'project', parent_id: parent.id }, c)
        await ctx.db.insert('projects', child)
        last = child.id
      }
      await ctx.db.insert('project_access', { project_id: last, profile_id: who.id, level: 'user' })
      const _id = await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: parent.id,
        name: `Nav milestone ${p}`,
        week: plus(MONDAY, p),
        created_at: NOW,
      })
      milestones.push((await ctx.db.get(_id)) as Doc<'milestones'>)
      ids.push(parent.id)
    })
  return { ids, milestones }
}

/* `f.user`'s guest seat in the other organization, with User access on its
 * project, so one login reads projects of two organizations. */
async function guestElsewhere(t: T, f: OrgFixture): Promise<Doc<'profiles'>> {
  const seat = await plantSeat(t, {
    org_id: f.otherOrg.id,
    auth_user_id: f.user.auth_user_id,
    org_role: 'guest',
    name: 'user',
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.otherProject.id,
      profile_id: seat.id,
      level: 'user',
    }),
  )
  return seat
}

/* What reads cost so far, from a transaction's metrics. */
const usedOf = (m: TransactionMetrics) => ({
  ranges: m.databaseQueries.used,
  documents: m.documentsRead.used,
  bytes: m.bytesRead.used,
})

/* A read inline as `me` over `projects` with options `o`, its answer, what
 * it read (the whole transaction, and the milestone read alone from its
 * start) and how often the milestone read looked at the metrics. */
const measured = (
  t: T,
  me: Doc<'profiles'>,
  projects: string[],
  o: Parameters<typeof readMilestones>[2],
) =>
  t.query(async (ctx) => {
    const ids = await milestoneProjects(ctx, new Map([[me.org_id, me]]), projects)
    const metrics = ctx.meta.getTransactionMetrics.bind(ctx.meta)
    let looks = 0
    const counted = {
      ...ctx,
      meta: {
        ...ctx.meta,
        getTransactionMetrics: () => {
          looks += 1
          return metrics()
        },
      },
    }
    const before = usedOf(await metrics())
    const answer = await readMilestones(counted, ids, o)
    const total = usedOf(await metrics())
    const read = {
      ranges: total.ranges - before.ranges,
      documents: total.documents - before.documents,
      bytes: total.bytes - before.bytes,
    }
    return { answer, total, read, looks }
  })

describe('a section', () => {
  it('starts upcoming at `from`, nearest first, and lists past newest first', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = await plant(t, f.meta.id, plus(MONDAY, -10), 'Old')
    const before = await plant(t, f.meta.id, plus(MONDAY, -1), 'Day before')
    const on = await plant(t, f.meta.id, MONDAY, 'On the day')
    const later = await plant(t, f.meta.id, plus(MONDAY, 3), 'Later that week')
    const far = await plant(t, f.meta.id, plus(MONDAY, 14), 'Far')
    const user = as(t, f.user)
    const base = { projects: [f.meta.id], from: MONDAY, limit: 25 }
    const upcoming = await user.query(api.milestones.section, { ...base, side: 'upcoming' })
    expect(upcoming.rows).toEqual([on, later, far].map(rowOf))
    expect(upcoming).toMatchObject({ next: null, stopped: null, past: true })
    const past = await user.query(api.milestones.section, { ...base, side: 'past' })
    expect(past.rows).toEqual([before, old].map(rowOf))
    expect(past).toEqual({ rows: past.rows, next: null, stopped: null })
  })

  it('sorts milestones of one day by name key and then id, in one project and across two', async () => {
    const t = newT()
    const f = await withOrg(t)
    const day = plus(MONDAY, 2)
    // two on one day of TBED, stored before the weekly rule, and one of SKNK
    const rows = [
      await plant(t, f.meta.id, day, 'Zeta'),
      await plant(t, f.meta.id, day, 'alpha'),
      await plant(t, f.hidden.id, day, 'Beta'),
      await plant(t, f.meta.id, plus(day, 7), 'Café'),
      await plant(t, f.hidden.id, plus(day, 7), 'cafe'),
      await plant(t, f.meta.id, plus(day, 7), 'CAFE'),
    ]
    const user = as(t, f.user)
    const base = { projects: [f.hidden.id, f.meta.id], limit: 25 }
    const upcoming = await user.query(api.milestones.section, {
      ...base,
      from: MONDAY,
      side: 'upcoming',
    })
    expect(upcoming.rows.slice(0, 3).map((r) => r.name)).toEqual(['alpha', 'Beta', 'Zeta'])
    // accents and case leave the three Cafés one key, so their ids decide
    const cafes = rows.slice(3).sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(upcoming.rows.slice(3)).toEqual(cafes.map(rowOf))
    expect(upcoming.rows.map((r) => r.id)).toEqual(ascending(rows))
    const past = await user.query(api.milestones.section, {
      ...base,
      from: plus(MONDAY, 21),
      side: 'past',
    })
    expect(past.rows.map((r) => r.id)).toEqual(descending(rows))
  })

  it.each([10, 25])(
    'reads 37 milestones in batches of %i, each once and in order, in one project',
    async (limit) => {
      const t = newT()
      const f = await withOrg(t)
      const rows = await plantMany(
        t,
        Array.from({ length: 37 }, (_, i) => ({
          project: f.meta.id,
          week: plus(MONDAY, 7 * i + (i % 3)),
          name: `Step ${(i * 7) % 37}`,
        })),
      )
      const user = as(t, f.user)
      const upcoming = await walk(user, {
        projects: [f.meta.id],
        from: MONDAY,
        side: 'upcoming',
        limit,
      })
      expect(upcoming.ids).toEqual(ascending(rows))
      expect(upcoming.batches.map((b) => b.rows.length)).toEqual(
        limit === 10 ? [10, 10, 10, 7] : [25, 12],
      )
      const past = await walk(user, {
        projects: [f.meta.id],
        from: plus(MONDAY, 7 * 40),
        side: 'past',
        limit,
      })
      expect(past.ids).toEqual(descending(rows))
    },
  )

  it.each([10, 25])(
    'merges 37 milestones of three projects in two organizations in batches of %i',
    async (limit) => {
      const t = newT()
      const f = await withOrg(t)
      await guestElsewhere(t, f)
      // TBED and SKNK share their Wednesdays, the other organization's
      // project alternates between Wednesdays and Fridays
      const rows = await plantMany(t, [
        ...Array.from({ length: 15 }, (_, i) => ({
          project: f.meta.id,
          week: plus(MONDAY, 7 * i + 2),
          name: `Build ${i}`,
        })),
        ...Array.from({ length: 12 }, (_, i) => ({
          project: f.hidden.id,
          week: plus(MONDAY, 7 * i + 2),
          name: `Audit ${i}`,
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          project: f.otherProject.id,
          week: plus(MONDAY, 7 * i + (i % 2 === 0 ? 2 : 4)),
          name: `Elsewhere ${i}`,
        })),
      ])
      const user = as(t, f.user)
      const projects = [f.meta.id, f.otherProject.id, f.hidden.id]
      const upcoming = await walk(user, { projects, from: MONDAY, side: 'upcoming', limit })
      expect(upcoming.ids).toEqual(ascending(rows))
      expect(upcoming.batches.at(-1)?.next).toBeNull()
      const past = await walk(user, {
        projects,
        from: plus(MONDAY, 7 * 20),
        side: 'past',
        limit,
      })
      expect(past.ids).toEqual(descending(rows))
    },
  )

  it('leaves out a milestone added before the cursor between two batches and returns one added after it', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMany(
      t,
      Array.from({ length: 6 }, (_, i) => ({
        project: f.meta.id,
        week: plus(MONDAY, 7 * i),
        name: `M ${i}`,
      })),
    )
    const user = as(t, f.user)
    const base = { projects: [f.meta.id], from: MONDAY, side: 'upcoming' as const, limit: 3 }
    const first = await user.query(api.milestones.section, base)
    expect(first.rows.map((r) => r.name)).toEqual(['M 0', 'M 1', 'M 2'])
    const after = first.next
    expect(after).toEqual({ week: plus(MONDAY, 14), key: 'm 2', id: first.rows[2].id })
    if (after === null) throw new Error('the first batch ends the section')
    await plant(t, f.meta.id, plus(MONDAY, 8), 'Earlier')
    await plant(t, f.meta.id, plus(MONDAY, 14), 'A same day, before') // key 'a ...' < 'm 2'
    await plant(t, f.meta.id, plus(MONDAY, 14), 'Z same day, after')
    await plant(t, f.meta.id, plus(MONDAY, 15), 'Later')
    const second = await user.query(api.milestones.section, { ...base, after, limit: 25 })
    expect(second.rows.map((r) => r.name)).toEqual([
      'Z same day, after',
      'Later',
      'M 3',
      'M 4',
      'M 5',
    ])
    expect(second).toMatchObject({ next: null, stopped: null })
    expect('past' in second).toBe(false)
  })

  it('pages past a milestone whose id, made before 2026-10-19, is not a UUID', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plant(t, f.meta.id, MONDAY, 'First')
    await t.run((ctx) =>
      ctx.db.insert('milestones', {
        id: 'legacy-milestone-1',
        project_id: f.meta.id,
        name: 'Legacy',
        week: plus(MONDAY, 7),
        created_at: NOW,
      }),
    )
    await plant(t, f.meta.id, plus(MONDAY, 14), 'Last')
    for (const side of ['upcoming', 'past'] as const) {
      const { batches } = await walk(as(t, f.user), {
        projects: [f.meta.id],
        from: side === 'upcoming' ? MONDAY : plus(MONDAY, 21),
        side,
        limit: 1,
      })
      const names = batches.flatMap((b) => b.rows.map((r) => r.name))
      expect(names).toEqual(
        side === 'upcoming' ? ['First', 'Legacy', 'Last'] : ['Last', 'Legacy', 'First'],
      )
    }
  })

  it('pages past a legacy name whose name key is longer than a document', async () => {
    const t = newT()
    const f = await withOrg(t)
    // stored before names had a limit; NFKD turns each U+FDFA into 18
    // characters, so its key passes DOCUMENT_MAX_BYTES characters
    const long = '\ufdfa'.repeat(60_000)
    expect(nameKey(long).length).toBeGreaterThan(DOCUMENT_MAX_BYTES)
    const rows = await plantMany(t, [
      { project: f.meta.id, week: MONDAY, name: 'First' },
      { project: f.meta.id, week: plus(MONDAY, 7), name: long },
      { project: f.meta.id, week: plus(MONDAY, 14), name: 'Last' },
    ])
    for (const side of ['upcoming', 'past'] as const) {
      const { ids } = await walk(as(t, f.user), {
        projects: [f.meta.id],
        from: side === 'upcoming' ? MONDAY : plus(MONDAY, 21),
        side,
        limit: 1,
      })
      expect(ids).toEqual(side === 'upcoming' ? ascending(rows) : descending(rows))
    }
  })

  it('searches every fragment in any order, ignoring case and accents, across the whole section', async () => {
    const t = newT()
    const f = await withOrg(t)
    const rows = await plantMany(t, [
      ...Array.from({ length: 30 }, (_, i) => ({
        project: f.meta.id,
        week: plus(MONDAY, 7 * i),
        name: `Routine ${i}`,
      })),
      { project: f.meta.id, week: plus(MONDAY, 7 * 30), name: 'Pilot launch review' },
      { project: f.hidden.id, week: plus(MONDAY, 7 * 31), name: 'Launch the pilot batch' },
      { project: f.hidden.id, week: plus(MONDAY, 7 * 32), name: 'Pilot batch ready' },
      { project: f.meta.id, week: plus(MONDAY, 7 * 33), name: 'Café opening' },
    ])
    const user = as(t, f.user)
    const base = {
      projects: [f.meta.id, f.hidden.id],
      from: MONDAY,
      side: 'upcoming' as const,
      limit: 1,
    }
    const names = async (search: string) =>
      (await walk(user, { ...base, search })).batches.flatMap((b) => b.rows.map((r) => r.name))
    // the first batch of the section holds none of them
    expect((await user.query(api.milestones.section, base)).rows[0].name).toBe('Routine 0')
    expect(await names('LAUNCH pilot')).toEqual(['Pilot launch review', 'Launch the pilot batch'])
    expect(await names('  batch   PILOT ')).toEqual(['Launch the pilot batch', 'Pilot batch ready'])
    expect(await names('cafe')).toEqual(['Café opening'])
    expect(await names('CAFÉ OPEN')).toEqual(['Café opening'])
    expect(await names('pilot nowhere')).toEqual([])
    // a blank search lists everything
    expect((await walk(user, { ...base, limit: 25, search: '   ' })).ids).toEqual(ascending(rows))
    // past searches newest first
    const past = await walk(user, {
      ...base,
      from: plus(MONDAY, 7 * 40),
      side: 'past',
      search: 'pilot',
    })
    expect(past.batches.flatMap((b) => b.rows.map((r) => r.name))).toEqual([
      'Pilot batch ready',
      'Launch the pilot batch',
      'Pilot launch review',
    ])
  })

  it('stops a search at the read budget, with every match up to the day it reached, and goes on to find every match', async () => {
    const t = newT()
    const f = await withOrg(t)
    const rows = await plantMany(
      t,
      Array.from({ length: 60 }, (_, i) => ({
        project: f.meta.id,
        week: plus(MONDAY, 7 * i),
        name: i % 40 === 3 ? `Pilot ${i}` : `Routine ${i}`,
      })),
    )
    const matches = rows.filter((m) => m.name.startsWith('Pilot'))
    expect(matches).toHaveLength(2)
    MILESTONE_READ.documents = 20
    const user = as(t, f.user)
    for (const side of ['upcoming', 'past'] as const) {
      const from = side === 'upcoming' ? MONDAY : plus(MONDAY, 7 * 70)
      const { ids, batches } = await walk(user, {
        projects: [f.meta.id],
        from,
        side,
        search: 'pilot',
        limit: 25,
      })
      expect(ids).toEqual(side === 'upcoming' ? ascending(matches) : descending(matches))
      const stops = batches.filter((b) => b.stopped !== null)
      expect(stops.length).toBeGreaterThan(1)
      for (const { rows, next, stopped } of stops) {
        if (next === null || stopped === null) throw new Error('a stopped batch has no next')
        expect(next.week).toBe(stopped)
        for (const row of rows)
          expect(side === 'upcoming' ? row.week <= stopped : row.week >= stopped).toBe(true)
      }
      // a batch that found nothing before the budget ran out still goes on
      expect(stops.some((b) => b.rows.length === 0)).toBe(true)
    }
  })

  it('stays exact at every budget, over a dense and a sparse project that share days', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shared = [3, 7, 8].map((i) => plus(MONDAY, 7 * i + 2))
    const rows = await plantMany(t, [
      ...Array.from({ length: 24 }, (_, i) => ({
        project: f.meta.id,
        week: plus(MONDAY, 7 * i + 2),
        name: i % 4 === 0 ? `Pilot ${i}` : `Routine ${i}`,
      })),
      // two on one day of TBED, stored before the weekly rule
      { project: f.meta.id, week: shared[1], name: 'Pilot twin' },
      ...shared.map((week, i) => ({ project: f.hidden.id, week, name: `Pilot sparse ${i}` })),
    ])
    const matches = rows.filter((m) => m.name.startsWith('Pilot'))
    const user = as(t, f.user)
    const stoppedOn = new Set<string>()
    for (let documents = 1; documents <= 41; documents += 4) {
      MILESTONE_READ.documents = documents
      for (const side of ['upcoming', 'past'] as const)
        for (const search of ['', 'pilot']) {
          const { ids, batches } = await walk(user, {
            projects: [f.meta.id, f.hidden.id],
            from: side === 'upcoming' ? MONDAY : plus(MONDAY, 7 * 30),
            side,
            search,
            limit: 4,
          })
          const want = search === '' ? rows : matches
          expect(ids).toEqual(side === 'upcoming' ? ascending(want) : descending(want))
          for (const b of batches) if (b.stopped !== null) stoppedOn.add(b.stopped)
        }
    }
    // some batches stopped on a day both projects hold a milestone on
    expect(shared.some((day) => stoppedOn.has(day))).toBe(true)
  })

  it('counts each milestone at its size, so a read looks at the metrics a few times', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMany(
      t,
      Array.from({ length: 300 }, (_, i) => ({
        project: f.meta.id,
        week: plus(MONDAY, 7 * i),
        name: `Routine ${i}`,
      })),
    )
    const { answer, read, looks } = await measured(t, f.user, [f.meta.id], {
      span: { from: MONDAY, order: 'asc' },
      after: null,
      search: 'pilot',
      limit: 25,
    })
    expect(answer).toEqual({ rows: [], next: null, stopped: null })
    expect(read.documents).toBe(300)
    // one look before the first range and one before the first document
    expect(looks).toBeLessThanOrEqual(3)
  })

  it('says on a first upcoming batch whether a project holds past milestones', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plant(t, f.meta.id, plus(MONDAY, -7), 'Done')
    const user = as(t, f.user)
    const first = (projects: string[]) =>
      user.query(api.milestones.section, { projects, from: MONDAY, side: 'upcoming', limit: 10 })
    expect(await first([f.meta.id])).toEqual({ rows: [], next: null, stopped: null, past: true })
    expect(await first([f.hidden.id])).toEqual({ rows: [], next: null, stopped: null, past: false })
    expect((await first([f.hidden.id, f.meta.id])).past).toBe(true)
    // a day that does not exist, shown after `from`, is not past
    await plant(t, f.hidden.id, '2026-02-31', 'Overflow')
    const overflow = await user.query(api.milestones.section, {
      projects: [f.hidden.id],
      from: '2026-03-02',
      side: 'upcoming',
      limit: 10,
    })
    expect(overflow).toMatchObject({ past: false, rows: [{ name: 'Overflow' }] })
  })

  it('folds a sub-project, lists a navigation-only parent and leaves archived projects out', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plant(t, f.meta.id, MONDAY, 'Launch')
    const base = { from: MONDAY, side: 'upcoming' as const, limit: 10 }
    const listed = (who: Doc<'profiles'>, projects: string[]) =>
      as(t, who)
        .query(api.milestones.section, { ...base, projects })
        .then((b) => b.rows.map((r) => r.id))
    expect(await listed(f.user, [f.sub.id])).toEqual([row.id])
    // a sub-project and its parent are one project
    expect(await listed(f.user, [f.sub.id, f.meta.id, f.sub2.id, f.sub.id])).toEqual([row.id])
    // the guest holds grants only on the sub-projects now, so TBED shows for navigation
    await plantHiddenSibling(t, f, f.guest)
    expect(await listed(f.guest, [f.meta.id])).toEqual([row.id])
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: NOW }))
    expect(await listed(f.user, [f.sub.id])).toEqual([])
    expect(await listed(f.user, [f.meta.id])).toEqual([row.id])
    await t.run((ctx) => ctx.db.patch(f.meta._id, { archived_at: NOW }))
    expect(await listed(f.user, [f.meta.id])).toEqual([])
    expect(await listed(f.user, [f.sub2.id])).toEqual([])
  })

  it.each([64, 0])(
    'decides navigation as the access layer does, asking up to %i sub-projects one by one',
    async (children) => {
      const t = newT()
      const f = await withOrg(t)
      const parent = () => plantProject(t, { org_id: f.org.id })
      const child = (p: Doc<'projects'>, extra: Partial<Doc<'projects'>> = {}) =>
        plantProject(t, { org_id: f.org.id, type: 'project', parent_id: p.id, ...extra })
      // A: the guest holds a grant on its second sub-project
      const a = await parent()
      await child(a)
      const a2 = await child(a)
      // B: the guest leads its sub-project
      const b = await parent()
      await child(b, { lead_id: f.guest.id })
      // C: a team of the viewer and the guest is shared on its sub-project,
      // which reaches the viewer but never a guest
      const c = await parent()
      const c1 = await child(c)
      // D: nothing of the guest's or the viewer's
      const d = await parent()
      await child(d)
      const parents = [a, b, c, d]
      await t.run(async (ctx) => {
        await ctx.db.insert('project_access', {
          project_id: a2.id,
          profile_id: f.guest.id,
          level: 'user',
        })
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: f.org.id,
          name: 'Reviewers',
          track_delay_default: false,
          created_at: NOW,
        })
        for (const who of [f.viewer, f.guest])
          await ctx.db.insert('team_members', {
            team_id: team,
            profile_id: who.id,
            is_leader: false,
          })
        await ctx.db.insert('project_team_access', {
          project_id: c1.id,
          team_id: team,
          level: 'user',
        })
      })
      const milestones = await plantMany(
        t,
        parents.map((p, i) => ({ project: p.id, week: plus(MONDAY, i), name: `Of ${i}` })),
      )
      MILESTONE_NAV.children = children
      for (const [who, shown] of [
        [f.guest, [a, b]],
        [f.viewer, [c]],
      ] as const) {
        // the access layer's own answer, navigation included
        const visible = await t.run(async (ctx) => {
          const levels = projectLevelsOf(ctx, who)
          const out: string[] = []
          for (const p of parents) if ((await levels.level(p.id)) !== null) out.push(p.id)
          return out
        })
        expect(visible).toEqual(shown.map((p) => p.id))
        const batch = await as(t, who).query(api.milestones.section, {
          projects: parents.map((p) => p.id),
          from: MONDAY,
          side: 'upcoming',
          limit: 10,
        })
        expect(batch.rows.map((r) => r.project_id)).toEqual(visible)
        for (const m of milestones) {
          const got = await as(t, who).query(api.milestones.get, { id: m.id })
          if (visible.includes(m.project_id)) expect(got).toMatchObject({ can_write: false })
          else expect(got).toBeNull()
        }
      }
    },
  )

  it('lists nothing for projects the caller cannot see and refuses none of them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plant(t, f.hidden.id, MONDAY, 'Secret')
    await plant(t, f.otherProject.id, MONDAY, 'Elsewhere')
    const lone = await plantProject(t, { org_id: f.org.id })
    await plant(t, lone.id, MONDAY, 'Unshared')
    for (const projects of [[uuid()], [f.otherProject.id], [f.hidden.id], [lone.id]]) {
      for (const side of ['upcoming', 'past'] as const)
        expect(
          await as(t, f.guest).query(api.milestones.section, {
            projects,
            from: side === 'upcoming' ? MONDAY : plus(MONDAY, 7),
            side,
            limit: 10,
          }),
        ).toEqual({
          rows: [],
          next: null,
          stopped: null,
          ...(side === 'upcoming' ? { past: false } : {}),
        })
      expect(
        await as(t, f.guest).query(api.milestones.between, {
          projects,
          from: MONDAY,
          to: plus(MONDAY, 7),
        }),
      ).toEqual({ rows: [], next: null, stopped: null })
    }
  })
})

describe('a range of days', () => {
  it('answers the milestones shown in [from, to), in upcoming order', async () => {
    const t = newT()
    const f = await withOrg(t)
    const from = '2026-03-02'
    const to = '2026-03-16'
    // stored before 2026-10-16: 2026-02-31 shows on 3 March, 2026-02-29 on 1 March
    const overflow = await plant(t, f.meta.id, '2026-02-31', 'Overflow')
    await plant(t, f.meta.id, '2026-02-29', 'Before the range')
    const inside = [
      await plant(t, f.meta.id, from, 'First day'),
      await plant(t, f.hidden.id, '2026-03-03', 'Same day elsewhere'),
      await plant(t, f.hidden.id, '2026-03-15', 'Last day'),
    ]
    await plant(t, f.meta.id, to, 'On to')
    await plant(t, f.meta.id, '2026-03-01', 'Day before')
    const range = await as(t, f.user).query(api.milestones.between, {
      projects: [f.meta.id, f.hidden.id],
      from,
      to,
    })
    expect(range.stopped).toBeNull()
    expect(range.rows.map((r) => r.name)).toEqual([
      'Overflow',
      'First day',
      'Same day elsewhere',
      'Last day',
    ])
    expect(range.rows).toEqual(
      [overflow, ...inside].sort((a, b) => compared(a, b)).map((m) => rowOf(m)),
    )
  })

  it('stops under a lowered budget at a position, and goes on from it to every milestone once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const rows = await plantMany(t, [
      ...Array.from({ length: 40 }, (_, i) => ({
        project: f.meta.id,
        week: plus(MONDAY, 7 * i),
        name: `Dense ${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        project: f.hidden.id,
        week: plus(MONDAY, 7 * 8 * i),
        name: `Sparse ${i}`,
      })),
    ])
    MILESTONE_READ.documents = 30
    const { ids, batches } = await walkRange(as(t, f.user), {
      projects: [f.meta.id, f.hidden.id],
      from: MONDAY,
      to: plus(MONDAY, 7 * 260),
    })
    expect(ids).toEqual(ascending(rows))
    expect(batches.length).toBeGreaterThan(1)
    for (const { rows: answered, next, stopped } of batches.slice(0, -1)) {
      if (next === null) throw new Error('a stopped range has no next')
      expect(stopped).toBe(next.week)
      for (const row of answered) expect(compared(row, next)).toBeLessThanOrEqual(0)
    }
  })

  it('stops on 2026-02-31 under a lowered budget and goes on past it', async () => {
    const t = newT()
    const f = await withOrg(t)
    // stored before 2026-10-16, shown on 3 March, sorted before 1 March
    const rows = await plantMany(t, [
      { project: f.meta.id, week: '2026-02-31', name: 'Overflow' },
      { project: f.meta.id, week: '2026-03-09', name: 'Ninth' },
      { project: f.meta.id, week: '2026-03-16', name: 'Sixteenth' },
      { project: f.hidden.id, week: '2026-03-02', name: 'Second' },
      { project: f.hidden.id, week: '2026-03-03', name: 'Third' },
      { project: f.hidden.id, week: '2026-03-10', name: 'Tenth' },
    ])
    const stoppedOn = new Set<string>()
    for (let documents = 1; documents <= 6; documents++) {
      MILESTONE_READ.documents = documents
      const { ids, batches } = await walkRange(as(t, f.user), {
        projects: [f.meta.id, f.hidden.id],
        from: '2026-03-02',
        to: '2026-03-30',
      })
      expect(ids).toEqual(ascending(rows))
      for (const b of batches) if (b.stopped !== null) stoppedOn.add(b.stopped)
    }
    // a stop on the day that does not exist, which `from` refuses, goes on
    // through `after`
    expect(stoppedOn.has('2026-02-31')).toBe(true)
  })

  it('places 2026-02-31 in upcoming from 3 March and in past from 4 March', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMany(t, [
      { project: f.meta.id, week: '2026-02-31', name: 'Overflow' },
      { project: f.meta.id, week: '2026-03-01', name: 'First' },
      { project: f.meta.id, week: '2026-03-03', name: 'Third' },
    ])
    const user = as(t, f.user)
    const names = async (from: string, side: 'upcoming' | 'past') =>
      (await walk(user, { projects: [f.meta.id], from, side, limit: 1 })).batches.flatMap((b) =>
        b.rows.map((r) => r.name),
      )
    expect(await names('2026-03-03', 'past')).toEqual(['First'])
    expect(await names('2026-03-03', 'upcoming')).toEqual(['Overflow', 'Third'])
    // newest first by stored day, so the overflow day comes after 1 March,
    // two days out of order
    expect(await names('2026-03-04', 'past')).toEqual(['Third', 'First', 'Overflow'])
    expect(await names('2026-03-04', 'upcoming')).toEqual([])
  })

  it('leaves the access checks before the read out of its budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 30 projects shared with the user one by one, so checking them reads
    // more documents than the lowered budget holds
    const projects = await shared(t, f, 30)
    const rows = await plantMany(t, [
      ...[0, 1, 2].map((i) => ({
        project: projects[0],
        week: plus(MONDAY, 7 * i),
        name: `A ${i}`,
      })),
      { project: projects[1], week: plus(MONDAY, 21), name: 'B' },
    ])
    MILESTONE_READ.documents = 40
    const range = await as(t, f.user).query(api.milestones.between, {
      projects,
      from: MONDAY,
      to: plus(MONDAY, 7 * 10),
    })
    expect(range.stopped).toBeNull()
    expect(range.rows.map((r) => r.id)).toEqual(ascending(rows))
  })
})

describe('one milestone by id', () => {
  it('answers a milestone the caller can see, and whether they may change it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plant(t, f.meta.id, MONDAY, 'Launch')
    const project = { id: f.meta.id, name: f.meta.name, key: f.meta.key, org_id: f.org.id }
    const get = (who: Doc<'profiles'>) => as(t, who).query(api.milestones.get, { id: row.id })
    // the lead, an admin, a guest with User access, a viewer capped at Viewer
    expect(await get(f.user)).toEqual({ row: rowOf(row), project, can_write: true })
    expect(await get(f.admin)).toMatchObject({ can_write: true })
    expect(await get(f.guest)).toMatchObject({ can_write: true })
    expect(await get(f.viewer)).toEqual({ row: rowOf(row), project, can_write: false })
    // a parent shown only for navigation to a sub-project
    await plantHiddenSibling(t, f, f.guest)
    expect(await get(f.guest)).toEqual({ row: rowOf(row), project, can_write: false })
  })

  it("answers a milestone through the caller's seat in another organization until the grant goes", async () => {
    const t = newT()
    const f = await withOrg(t)
    const seat = await guestElsewhere(t, f)
    const row = await plant(t, f.otherProject.id, MONDAY, 'Elsewhere')
    const user = as(t, f.user)
    expect(await user.query(api.milestones.get, { id: row.id })).toEqual({
      row: rowOf(row),
      project: {
        id: f.otherProject.id,
        name: f.otherProject.name,
        key: f.otherProject.key,
        org_id: f.otherOrg.id,
      },
      can_write: true,
    })
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.otherProject.id).eq('profile_id', seat.id),
        )
        .unique()
      if (grant === null) throw new Error('the guest seat holds no grant')
      await ctx.db.delete(grant._id)
    })
    expect(await user.query(api.milestones.get, { id: row.id })).toBeNull()
  })

  it('answers null for what the caller cannot see or the app does not show', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await plant(t, f.otherProject.id, MONDAY, 'Elsewhere')
    const hidden = await plant(t, f.hidden.id, MONDAY, 'Secret')
    const onSub = await plant(t, f.sub.id, MONDAY, 'Stored on a sub-project')
    const deleted = await plant(t, f.meta.id, MONDAY, 'Deleted')
    await t.run((ctx) => ctx.db.delete(deleted._id))
    const guest = as(t, f.guest)
    for (const id of [uuid(), elsewhere.id, hidden.id, onSub.id, deleted.id])
      expect(await guest.query(api.milestones.get, { id })).toBeNull()
    // the lead of SKNK sees its milestone until it is archived
    expect(await as(t, f.user).query(api.milestones.get, { id: hidden.id })).not.toBeNull()
    await t.run((ctx) => ctx.db.patch(f.hidden._id, { archived_at: NOW }))
    expect(await as(t, f.user).query(api.milestones.get, { id: hidden.id })).toBeNull()
  })
})

describe('Team sync', () => {
  it('reads the next milestone and those of this week and next', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plant(t, f.meta.id, plus(MONDAY, -3), 'Last week')
    const thisWeek = await plant(t, f.hidden.id, plus(MONDAY, 4), 'Friday review')
    const nextWeek = await plant(t, f.meta.id, plus(MONDAY, 8), 'Next Tuesday')
    await plant(t, f.meta.id, plus(MONDAY, 14), 'In two weeks')
    const user = as(t, f.user)
    // the scope's top-level projects (src/lib/teamSync.ts scopeMetaIds)
    const projects = [f.meta.id, f.hidden.id]
    const next = await user.query(api.milestones.section, {
      projects,
      from: MONDAY,
      side: 'upcoming',
      limit: 1,
    })
    expect(next.rows).toEqual([rowOf(thisWeek)])
    expect(next.next).not.toBeNull()
    const ahead = await user.query(api.milestones.between, {
      projects,
      from: MONDAY,
      to: plus(MONDAY, 14),
    })
    expect(ahead).toEqual({ rows: [thisWeek, nextWeek].map(rowOf), next: null, stopped: null })
  })
})

describe('parity with the projects part', () => {
  it('lists for each Northstar person the milestones the workspace gives them', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    const from = plus(NORTHSTAR_ANCHOR, 7 * 3)
    let pastSeen = 0
    let upcomingSeen = 0
    for (const person of profiles.filter((p) => p.kind === 'person')) {
      const caller = as(t, person)
      const snap = await workspaceOf(caller)
      if (snap === null) throw new Error(`${person.name} holds no seat`)
      const projects = snap.projects.filter((p) => p.parent_id === undefined).map((p) => p.id)
      const base = { projects, from, limit: 25 }
      const upcoming = await walk(caller, { ...base, side: 'upcoming' })
      const past = await walk(caller, { ...base, side: 'past' })
      expect([...upcoming.ids, ...past.ids].sort()).toEqual(snap.milestones.map((m) => m.id).sort())
      for (const m of snap.milestones) expect(upcoming.ids.includes(m.id)).toBe(m.week >= from)
      pastSeen += past.ids.length
      upcomingSeen += upcoming.ids.length
    }
    expect(pastSeen).toBeGreaterThan(0)
    expect(upcomingSeen).toBeGreaterThan(0)
  })
})

describe('refusals', () => {
  it('refuses arguments out of shape with bad_request', async () => {
    const t = newT()
    const f = await withOrg(t)
    const user = as(t, f.user)
    const base: SectionArgs = { projects: [f.meta.id], from: MONDAY, side: 'upcoming', limit: 10 }
    const tooMany = Array.from({ length: 201 }, () => uuid())
    await expectRefusal(
      user.query(api.milestones.section, { ...base, projects: tooMany }),
      'bad_request',
      /at most 200 projects/,
    )
    for (const limit of [0, 26, 2.5])
      await expectRefusal(
        user.query(api.milestones.section, { ...base, limit }),
        'bad_request',
        /limit must be a whole number from 1 to 25/,
      )
    await expectRefusal(
      user.query(api.milestones.section, { ...base, from: '2026-02-30' }),
      'bad_request',
      /from must be a valid calendar date/,
    )
    for (const after of [
      { week: 'soon', key: 'x', id: uuid() },
      { week: MONDAY, key: 'x', id: 'x'.repeat(DOCUMENT_MAX_BYTES + 1) },
    ])
      await expectRefusal(
        user.query(api.milestones.section, { ...base, after }),
        'bad_request',
        /after must be the next of an earlier batch/,
      )
    // a legacy day that does not exist can be a position
    expect(
      await user.query(api.milestones.section, {
        ...base,
        after: { week: '2026-02-31', key: 'x', id: uuid() },
      }),
    ).toMatchObject({ rows: [] })
    const search = await expectRefusal(
      user.query(api.milestones.section, { ...base, search: 'x'.repeat(201) }),
      'rule',
    )
    expect(search.data.message).toBe(LIMITS.search.refusal)
    const range = { projects: [f.meta.id], from: MONDAY }
    await expectRefusal(
      user.query(api.milestones.between, { ...range, projects: tooMany, to: plus(MONDAY, 7) }),
      'bad_request',
      /at most 200 projects/,
    )
    await expectRefusal(
      user.query(api.milestones.between, { ...range, to: MONDAY }),
      'bad_request',
      /to must be after from/,
    )
    await expectRefusal(
      user.query(api.milestones.between, { ...range, to: plus(MONDAY, 7 * 261) }),
      'bad_request',
      /at most 260 weeks after from/,
    )
    await expectRefusal(
      user.query(api.milestones.between, { ...range, to: '2026-13-01' }),
      'bad_request',
      /to must be a valid calendar date/,
    )
    expect(
      await user.query(api.milestones.between, { ...range, to: plus(MONDAY, 7 * 260) }),
    ).toEqual({ rows: [], next: null, stopped: null })
  })

  it('refuses a caller who is not signed in', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { projects: [f.meta.id], from: MONDAY }
    await expectRefusal(
      t.query(api.milestones.section, { ...base, side: 'upcoming', limit: 10 }),
      'forbidden',
      /not signed in/,
    )
    await expectRefusal(
      t.query(api.milestones.between, { ...base, to: plus(MONDAY, 7) }),
      'forbidden',
      /not signed in/,
    )
    await expectRefusal(t.query(api.milestones.get, { id: uuid() }), 'forbidden', /not signed in/)
  })
})

/* ------------------------------------------------------------- real limits
 * newT({ transactionLimits }) enforces Convex's own limits per transaction,
 * or lower ones, the plants' writes included. The large reads run once
 * through their public query and once inline (measured), with the caller's
 * seat as the only one, and record what they read as test annotations,
 * which `--reporter=verbose` prints. */

describe('under Convex limits', () => {
  it('reads one milestone of a parent shown only for navigation to its last of 2,100 sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const { milestones } = await navigationOnly(t, f, f.viewer, 1, 2100)
    const [row] = milestones
    expect(await as(t, f.viewer).query(api.milestones.get, { id: row.id })).toMatchObject({
      row: rowOf(row),
      can_write: false,
    })
  })

  it('opens every project before it asks about the past, and answers past true when the request ran out first', async () => {
    const t = newT({ transactionLimits: { databaseQueries: 100 } })
    const projects = [uuid(), uuid(), uuid()]
    const rows = await plantMany(
      t,
      projects.map((project, i) => ({ project, week: plus(MONDAY, i), name: `M ${i}` })),
    )
    // a first upcoming batch that may start `left` more index ranges
    const read = (left: number) =>
      t.query(async (ctx) => {
        while ((await ctx.meta.getTransactionMetrics()).databaseQueries.remaining > left)
          await ctx.db.query('organizations').first()
        const batch = await readMilestones(ctx, projects, {
          span: { from: MONDAY, order: 'asc' },
          after: null,
          search: '',
          limit: 10,
          pastBefore: MONDAY,
        })
        return { ...batch, rows: batch.rows.map((m) => m.id) }
      })
    const all = { rows: ascending(rows), next: null, stopped: null }
    // three ranges open the projects, and three more ask about their past
    expect(await read(6)).toEqual({ ...all, past: false })
    // with one range left for the past, two projects' history goes unasked
    expect(await read(4)).toEqual({ ...all, past: true })
    // without room to open every project the read is refused
    const e = await expectRefusal(read(2), 'rule', /Choose fewer projects/)
    expect(e.data.reason).toBe(MILESTONE_READ_TOO_LARGE)
  })

  it('stops at its frontier once the past probe has used the request, with documents near 1 MiB', async () => {
    const t = newT({ transactionLimits: { bytesRead: 8 * 1024 * 1024 } })
    const [upcoming, history] = [uuid(), uuid()]
    // names stored before names had a limit, about 900 KB a milestone
    const big = (project: string, week: string, n: number) =>
      t.run((ctx) =>
        ctx.db.insert('milestones', {
          id: uuid(),
          project_id: project,
          name: `${n} ${'L'.repeat(900_000)}`,
          week,
          created_at: NOW,
        }),
      )
    const first = await big(upcoming, MONDAY, 0)
    await big(upcoming, plus(MONDAY, 7), 1)
    await big(upcoming, plus(MONDAY, 14), 2)
    // past of `from` by their text but naming no day, so the probe reads
    // past every one of them
    for (let n = 0; n < 9; n++) await big(history, '0000-xx-xx', n)
    const batch = await t.query(async (ctx) => {
      const read = await readMilestones(ctx, [upcoming, history], {
        span: { from: MONDAY, order: 'asc' },
        after: null,
        search: '',
        limit: 10,
        pastBefore: MONDAY,
      })
      return { ...read, rows: read.rows.map((m) => m._id) }
    })
    // the probe stopped before it had asked every project, so past is true,
    // and the read answered what it had read whole without another read
    expect(batch.past).toBe(true)
    expect(batch.rows).toEqual([first])
    expect(batch.stopped).toBe(MONDAY)
    expect(batch.next?.week).toBe(MONDAY)
  })

  it('refuses a read whose projects are shared with more teams than the request can check', async () => {
    const t = newT({ transactionLimits: { documentsRead: 1500 } })
    const f = await withOrg(t)
    const { ids, milestone } = await sharedWithTeams(t, f, 30, 60)
    const user = as(t, f.user)
    const section = { from: MONDAY, side: 'upcoming' as const, limit: 10 }
    // eight projects' 480 shares fit
    const eight = await user.query(api.milestones.section, {
      ...section,
      projects: ids.slice(0, 8),
    })
    expect(eight.rows).toEqual([rowOf(milestone)])
    // thirty projects' 1,800 shares pass the request's 1,500 documents, so
    // the check stops between two batches and refuses
    for (const call of [
      user.query(api.milestones.section, { ...section, projects: ids }),
      user.query(api.milestones.between, { projects: ids, from: MONDAY, to: plus(MONDAY, 7) }),
    ]) {
      const e = await expectRefusal(call, 'rule', /Choose fewer projects/)
      expect(e.data.reason).toBe(MILESTONE_READ_TOO_LARGE)
    }
  })

  it('shows parents of 600 sub-projects through one grant each', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    const { ids, milestones } = await navigationOnly(t, f, f.guest, 5, 600)
    const guest = as(t, f.guest)
    // five parents hold 3,000 sub-projects, past the request's 2,500
    // documents, so the check looks among the guest's own grants instead
    const five = await guest.query(api.milestones.section, {
      from: MONDAY,
      side: 'upcoming',
      limit: 10,
      projects: ids,
    })
    expect(five.rows.map((r) => r.id)).toEqual(ascending(milestones))
    expect(await guest.query(api.milestones.get, { id: milestones[4].id })).toMatchObject({
      row: rowOf(milestones[4]),
      can_write: false,
    })
  })

  it('shows a parent of one sub-project to a person with 3,000 grants', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    await grantsOn(t, f, f.guest, 3000)
    const { ids, milestones } = await navigationOnly(t, f, f.guest, 1, 1)
    const guest = as(t, f.guest)
    // the check asks the one sub-project, not every grant of the guest
    expect(
      await guest.query(api.milestones.section, {
        from: MONDAY,
        side: 'upcoming',
        limit: 10,
        projects: ids,
      }),
    ).toMatchObject({ rows: [rowOf(milestones[0])] })
    expect(await guest.query(api.milestones.get, { id: milestones[0].id })).toMatchObject({
      can_write: false,
    })
  })

  it('shows a parent of 100 sub-projects to a guest whose old team is shared on 2,000 projects', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    // a membership left from before guests lost team access; the team's
    // shares can never reach the guest, so the check does not read them
    await teamOn(t, f, f.guest, 2000)
    const { ids, milestones } = await navigationOnly(t, f, f.guest, 1, 100)
    const guest = as(t, f.guest)
    expect(
      await guest.query(api.milestones.section, {
        from: MONDAY,
        side: 'upcoming',
        limit: 10,
        projects: ids,
      }),
    ).toMatchObject({ rows: [rowOf(milestones[0])] })
    expect(await guest.query(api.milestones.get, { id: milestones[0].id })).toMatchObject({
      can_write: false,
    })
  })

  it('refuses when a parent of 600 sub-projects meets a person with 3,000 grants', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    await grantsOn(t, f, f.guest, 3000)
    const { ids, milestones } = await navigationOnly(t, f, f.guest, 1, 600)
    const guest = as(t, f.guest)
    // neither the sub-projects asked one by one nor the guest's own grants
    // fit, so both reads refuse instead of passing the request's limits
    const many = await expectRefusal(
      guest.query(api.milestones.section, {
        from: MONDAY,
        side: 'upcoming',
        limit: 10,
        projects: ids,
      }),
      'rule',
      /Choose fewer projects/,
    )
    const one = await expectRefusal(
      guest.query(api.milestones.get, { id: milestones[0].id }),
      'rule',
      /Contact support@qivo.io/,
    )
    for (const e of [many, one]) expect(e.data.reason).toBe(MILESTONE_READ_TOO_LARGE)
  })

  it.for([
    { per: 30, completes: true },
    { per: 45, completes: false },
  ])(
    'searches $per milestones in each of 200 projects for a name none has',
    { timeout: 120_000 },
    async ({ per, completes }, { annotate }) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const projects = await shared(t, f, 200)
      const rows = await plantMany(
        t,
        projects.flatMap((project, p) =>
          Array.from({ length: per }, (_, i) => ({
            project,
            week: plus(MONDAY, 7 * i + (p % 7)),
            name: `Routine milestone number ${i} of project ${p}`,
          })),
        ),
      )
      const args = { projects, from: MONDAY, side: 'upcoming' as const, limit: 25 }
      const batch = await as(t, f.user).query(api.milestones.section, { ...args, search: 'pilot' })
      expect(batch.rows).toEqual([])
      expect(batch.stopped === null).toBe(completes)
      expect(batch.next === null).toBe(completes)
      const inline = await measured(t, f.user, projects, {
        span: { from: MONDAY, order: 'asc' },
        after: null,
        search: 'pilot',
        limit: 25,
        pastBefore: MONDAY,
      })
      expect(inline.answer.stopped).toBe(batch.stopped)
      expect(inline.read.documents).toBeLessThanOrEqual(MILESTONE_READ.documents + 1)
      expect(inline.looks).toBeLessThanOrEqual(8)
      await annotate(
        `search over 200 projects x ${per}: stopped ${inline.answer.stopped}; the read ${JSON.stringify(inline.read)} with ${inline.looks} looks, the transaction ${JSON.stringify(inline.total)}; a milestone is ${getDocumentSize(rows[0])} bytes`,
      )
      // the first batch without search
      const first = await measured(t, f.user, projects, {
        span: { from: MONDAY, order: 'asc' },
        after: null,
        search: '',
        limit: 25,
        pastBefore: MONDAY,
      })
      expect(first.answer.rows).toHaveLength(25)
      expect(first.answer.stopped).toBeNull()
      expect(first.looks).toBeLessThanOrEqual(8)
      await annotate(
        `first upcoming batch of 25 over 200 projects x ${per}: the read ${JSON.stringify(first.read)} with ${first.looks} looks, the transaction ${JSON.stringify(first.total)}`,
      )
    },
  )

  it.for([
    { dense: 20, completes: true },
    { dense: 35, completes: false },
  ])(
    'reads 260 weeks of 200 projects with a milestone every week in $dense of them',
    { timeout: 120_000 },
    async ({ dense, completes }, { annotate }) => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const projects = await shared(t, f, 200)
      const rows = await plantMany(
        t,
        projects.slice(0, dense).flatMap((project, p) =>
          Array.from({ length: 260 }, (_, i) => ({
            project,
            week: plus(MONDAY, 7 * i + (p % 7)),
            name: `Weekly ${i}`,
          })),
        ),
      )
      const args = { projects, from: MONDAY, to: plus(MONDAY, 7 * 260) }
      const range = await as(t, f.user).query(api.milestones.between, args)
      expect(range.stopped === null).toBe(completes)
      const until = range.next
      const want = until === null ? rows : rows.filter((m) => compared(m, until) <= 0)
      expect(range.rows.map((r) => r.id)).toEqual(ascending(want))
      const inline = await measured(t, f.user, projects, {
        span: { from: MONDAY, to: args.to, order: 'asc' },
        after: null,
        search: '',
        limit: Infinity,
      })
      expect(inline.read.documents).toBeLessThanOrEqual(MILESTONE_READ.documents + 1)
      expect(inline.looks).toBeLessThanOrEqual(8)
      await annotate(
        `260 weeks over 200 projects, ${dense} dense: stopped ${inline.answer.stopped}, ${range.rows.length} rows; the read ${JSON.stringify(inline.read)} with ${inline.looks} looks, the transaction ${JSON.stringify(inline.total)}`,
      )
    },
  )
})

describe('a check of the caller access that a bound stops', () => {
  const DEFAULT_OWN_READS = structuredClone(OWN_READS)
  afterEach(() => {
    Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  })

  it('refuses the reads with its own reason beside MILESTONE_READ_TOO_LARGE, and one bound up answers as with the default bounds', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a member of a team sharing FW, who sees TBED's milestones read-only
    const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const m = await plant(t, f.meta.id, MONDAY, 'Launch')
    const caller = as(t, me)
    const read = async () => ({
      section: await caller.query(api.milestones.section, {
        projects: [f.sub.id],
        from: MONDAY,
        limit: 25,
        side: 'upcoming',
      }),
      get: await caller.query(api.milestones.get, { id: m.id }),
    })
    const usual = await read()
    expect(usual.section.rows.map((row) => row.id)).toEqual([m.id])
    expect(usual.get).toMatchObject({ can_write: false })
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    for (const refused of [
      caller.query(api.milestones.section, {
        projects: [f.sub.id],
        from: MONDAY,
        limit: 25,
        side: 'upcoming',
      }),
      caller.query(api.milestones.get, { id: m.id }),
    ])
      expect((await expectRefusal(refused, 'rule')).data.reason).toBe(ACCESS_UNCHECKED)
    Object.assign(OWN_READS, { lookups: 1, teamReads: 2 })
    expect(await read()).toEqual(usual)
  })
})
