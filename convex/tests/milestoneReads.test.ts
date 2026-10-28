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
import { LIMITS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { rowOf } from '../lib/workspaceParts'
import {
  MILESTONE_READ,
  MILESTONE_READ_TOO_LARGE,
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
type Caller = ReturnType<typeof as>

const READ = { ...MILESTONE_READ }
afterEach(() => {
  Object.assign(MILESTONE_READ, READ)
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

/* The reads' order: stored day, then name key, then id. */
const compared = (a: Doc<'milestones'>, b: Doc<'milestones'>): number => {
  const x = [a.week, nameKey(a.name), a.id]
  const y = [b.week, nameKey(b.name), b.id]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}
const ascending = (rows: readonly Doc<'milestones'>[]) => [...rows].sort(compared).map((m) => m.id)
const descending = (rows: readonly Doc<'milestones'>[]) => ascending(rows).reverse()

/* Every batch of a section from its start, following `next`. */
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
    if (batch.next === null)
      return { ids: batches.flatMap((b) => b.rows.map((r) => r.id)), batches }
    after = batch.next
  }
  throw new Error('a section did not end within 500 batches')
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
      ).toEqual({ rows: [], stopped: null })
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

  it('stops at a day under a lowered budget, with every milestone before it', async () => {
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
    const range = await as(t, f.user).query(api.milestones.between, {
      projects: [f.meta.id, f.hidden.id],
      from: MONDAY,
      to: plus(MONDAY, 7 * 260),
    })
    const stopped = range.stopped
    if (stopped === null) throw new Error('the range read every milestone')
    expect(stopped > MONDAY).toBe(true)
    expect(range.rows.map((r) => r.id)).toEqual(ascending(rows.filter((m) => m.week < stopped)))
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
    expect(ahead).toEqual({ rows: [thisWeek, nextWeek].map(rowOf), stopped: null })
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
      { week: MONDAY, key: 'x', id: 'not-an-id' },
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
    ).toEqual({ rows: [], stopped: null })
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
 * newT({ transactionLimits: true }) enforces Convex's own limits per
 * transaction, the plants' writes included. Each read runs once through its
 * public query and once inline, with the caller's seat as the only one, to
 * log what the transaction read. */

/* What reads cost so far, from a transaction's metrics. */
const usedOf = (m: TransactionMetrics) => ({
  ranges: m.databaseQueries.used,
  documents: m.documentsRead.used,
  bytes: m.bytesRead.used,
})

/* A read inline as `me` over `projects` with options `o`, its answer and
 * what it read: the whole transaction, and the milestone read alone from
 * its start. */
const measured = (
  t: T,
  me: Doc<'profiles'>,
  projects: string[],
  o: Parameters<typeof readMilestones>[2],
) =>
  t.query(async (ctx) => {
    const ids = await milestoneProjects(ctx, new Map([[me.org_id, me]]), projects)
    const before = usedOf(await ctx.meta.getTransactionMetrics())
    const answer = await readMilestones(ctx, ids, o)
    const total = usedOf(await ctx.meta.getTransactionMetrics())
    const read = {
      ranges: total.ranges - before.ranges,
      documents: total.documents - before.documents,
      bytes: total.bytes - before.bytes,
    }
    return { answer, total, read }
  })

describe('under Convex limits', () => {
  it('refuses a read whose navigation-only parents need more reads than the request allows', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    const { ids, milestones } = await navigationOnly(t, f, f.guest, 5, 600)
    const guest = as(t, f.guest)
    const section = { from: MONDAY, side: 'upcoming' as const, limit: 10 }
    // two of them fit, and their milestones are listed read-only
    const two = await guest.query(api.milestones.section, { ...section, projects: ids.slice(0, 2) })
    expect(two.rows.map((r) => r.id)).toEqual(ascending(milestones.slice(0, 2)))
    // five would read 3,000 sub-projects, past the request's 2,500
    // documents, so the check stops before it would and refuses
    for (const call of [
      guest.query(api.milestones.section, { ...section, projects: ids }),
      guest.query(api.milestones.between, { projects: ids, from: MONDAY, to: plus(MONDAY, 7) }),
    ]) {
      const e = await expectRefusal(call, 'rule', /Choose fewer projects/)
      expect(e.data.reason).toBe(MILESTONE_READ_TOO_LARGE)
    }
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
      await annotate(
        `search over 200 projects x ${per}: stopped ${inline.answer.stopped}; the read ${JSON.stringify(inline.read)}, the transaction ${JSON.stringify(inline.total)}; a milestone is ${getDocumentSize(rows[0])} bytes`,
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
      await annotate(
        `first upcoming batch of 25 over 200 projects x ${per}: the read ${JSON.stringify(first.read)}, the transaction ${JSON.stringify(first.total)}`,
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
      const before = range.stopped
      const want = before === null ? rows : rows.filter((m) => m.week < before)
      expect(range.rows.map((r) => r.id)).toEqual(ascending(want))
      const inline = await measured(t, f.user, projects, {
        span: { from: MONDAY, to: args.to, order: 'asc' },
        after: null,
        search: '',
        limit: Infinity,
      })
      expect(inline.read.documents).toBeLessThanOrEqual(MILESTONE_READ.documents + 1)
      await annotate(
        `260 weeks over 200 projects, ${dense} dense: stopped ${inline.answer.stopped}, ${range.rows.length} rows; the read ${JSON.stringify(inline.read)}, the transaction ${JSON.stringify(inline.total)}`,
      )
    },
  )
})
