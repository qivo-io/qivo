/* The `mine` scope of the app's section read (milestones.ts section,
 * model/milestones.ts mineMilestoneProjects): My view's milestones, those of
 * the top-level projects above the caller's own tasks by the Reviewer rule
 * across every seat of the login, by the rule of My view's health table
 * (lib/overview.ts myViewProjects), judged as named projects are; its Load
 * more, search and `past` probe; its refusals; and its reads at the design
 * size under Convex's transaction limits, which `--reporter=verbose`
 * prints. */

import type { FunctionArgs, TransactionMetrics } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, OWN_READS } from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId, newWindowKey } from '../lib/db'
import { LIMITS, MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { myViewProjects } from '../lib/overview'
import { type ViewAccess, viewAccess, viewBudget } from '../lib/viewReads'
import {
  MILESTONE_MINE,
  MILESTONE_READ,
  MILESTONE_READ_TOO_LARGE,
  MILESTONE_TOO_MANY,
  milestoneProjects,
  mineMilestoneProjects,
  readMilestones,
} from '../model/milestones'
import { plantTasks } from './board.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
import { NORTHSTAR_ANCHOR, plantNorthstar } from './northstar.setup'
import { DAY, plantShared, weeksOf } from './overview.setup'
import { withReach } from './projectReach.setup'
import { roadmapFor } from './roadmap.setup'

process.env.BETTER_AUTH_SECRET ??= 'milestone-mine-test-secret-not-a-deployment-key'

const DEFAULT_READ = structuredClone(MILESTONE_READ)
const DEFAULT_MINE = structuredClone(MILESTONE_MINE)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(MILESTONE_READ, structuredClone(DEFAULT_READ))
  Object.assign(MILESTONE_MINE, structuredClone(DEFAULT_MINE))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

const MS_DAY = 86_400_000
/* `day` moved by `days`. */
const plus = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * MS_DAY).toISOString().slice(0, 10)

/* A Monday, the first day of a week in the fixtures' organizations. */
const MONDAY = '2026-06-01'

type SectionArgs = FunctionArgs<typeof api.milestones.section>
type Caller = ReturnType<typeof as>

/* A `mine` section ask from MONDAY, with `over` over it. */
const mineAsk = (over: Partial<SectionArgs> = {}): SectionArgs => ({
  projects: [],
  mine: true,
  from: MONDAY,
  side: 'upcoming',
  limit: 100,
  ...over,
})

/* A section ask naming `projects`, with `over` over mineAsk's other
 * arguments. */
const namedAsk = (projects: string[], over: Partial<SectionArgs> = {}): SectionArgs => {
  const { mine: _mine, ...rest } = mineAsk(over)
  return { ...rest, projects }
}

/* A seat of `orgId` with a login of its own, staff unless `over` says. */
const seatOf = async (t: T, orgId: string, over: Partial<Doc<'profiles'>> = {}) =>
  await plantLogin(t, await plantSeat(t, { org_id: orgId, accepted_at: NOW, ...over }))

/* Stores a milestone directly, as rows stored before the weekly rule were. */
const plant = (t: T, projectId: string, week: string, name = 'Planted') =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('milestones', { id, project_id: projectId, name, week, created_at: NOW })
    return id
  })

/* Stores many milestones directly, in one transaction. */
const plantMany = (t: T, rows: readonly { project: string; week: string; name: string }[]) =>
  t.run(async (ctx) => {
    for (const row of rows)
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: row.project,
        name: row.name,
        week: row.week,
        created_at: NOW,
      })
  })

/* A grant of `level` on `project` to `profile`. */
const grant = (t: T, project: Doc<'projects'>, profile: Doc<'profiles'>, level = 'user' as const) =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: project.id,
      profile_id: profile.id,
      level,
    })
  })

/* A top-level project of `org` named `name`, with one sub-project. */
async function program(t: T, orgId: string, name: string, over: Partial<Doc<'projects'>> = {}) {
  const top = await plantProject(t, { org_id: orgId, name, ...over })
  const sub = await plantProject(t, {
    org_id: orgId,
    type: 'project',
    parent_id: top.id,
    name: `${name} work`,
  })
  return { top, sub }
}

/* `n` top-level projects of `orgId` in a few transactions, each with one
 * live sub-project and `archivedOf(i)` archived ones as archiving a
 * sub-project leaves it (model/projects.ts archiveProjectCore), archived
 * and listed under its live parent with its tasks untouched. Each
 * sub-project gets a grant to `me` and one open task `me` is assigned. */
async function plantTrees(
  t: T,
  orgId: string,
  me: Doc<'profiles'>,
  n: number,
  archivedOf: (i: number) => number,
) {
  const out = {
    tops: [] as Doc<'projects'>[],
    live: [] as Doc<'projects'>[],
    archived: [] as Doc<'projects'>[],
  }
  for (let from = 0; from < n; from += 50)
    await t.run(async (ctx) => {
      let num = 10_000 + from * 10
      const project = async (over: Partial<Doc<'projects'>>, name: string) => {
        num++
        const _id = await ctx.db.insert('projects', {
          id: uuid(),
          org_id: orgId,
          type: 'meta',
          key: `T${num}`,
          name,
          description: '',
          sort_order: num,
          num,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
          ...over,
        })
        return (await ctx.db.get(_id)) as Doc<'projects'>
      }
      const work = async (sub: Doc<'projects'>) => {
        await ctx.db.insert('project_access', {
          project_id: sub.id,
          profile_id: me.id,
          level: 'user',
        })
        const id = uuid()
        await ctx.db.insert('issues', {
          id,
          org_id: orgId,
          project_id: sub.id,
          num: num * 10,
          title: 'Replace the fan controller',
          status: 'todo',
          priority: 'medium',
          paused: false,
          assignee_id: me.id,
          status_at: NOW,
          created_at: NOW,
          updated_at: NOW,
          window_key: newWindowKey(),
        })
        await ctx.db.insert('issue_descriptions', {
          issue_id: id,
          description: '',
          org_id: orgId,
          project_id: sub.id,
        })
      }
      for (let i = from; i < Math.min(n, from + 50); i++) {
        const top = await project({}, `Programme ${i}`)
        out.tops.push(top)
        const live = await project(
          { type: 'project', parent_id: top.id, archive_state: 'live' },
          `Workstream ${i}`,
        )
        out.live.push(live)
        await work(live)
        for (let k = 0; k < archivedOf(i); k++) {
          const gone = await project(
            {
              type: 'project',
              parent_id: top.id,
              archived_at: NOW,
              archive_state: 'listed',
            },
            `Closed ${i}-${k}`,
          )
          out.archived.push(gone)
          await work(gone)
        }
      }
    })
  return out
}

/* The section's every row from its start, following `next`, `limit` at a
 * time. */
async function walk(caller: Caller, args: SectionArgs): Promise<string[]> {
  const ids: string[] = []
  let after: SectionArgs['after']
  for (let round = 0; round < 100; round++) {
    const batch = await caller.query(api.milestones.section, {
      ...args,
      ...(after === undefined ? {} : { after }),
    })
    ids.push(...batch.rows.map((r) => r.id))
    if (batch.next === null) return ids
    after = batch.next
  }
  throw new Error('the section did not end')
}

/* What reads cost so far, from a transaction's metrics. */
const usedOf = (m: TransactionMetrics) => ({
  ranges: m.databaseQueries.used,
  documents: m.documentsRead.used,
  mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
})

/* What `read` took in one transaction, as Convex counts its reads. */
const took = <R>(t: T, read: (ctx: QueryCtx) => Promise<R>) =>
  t.query(async (ctx) => {
    const answer = await read(ctx)
    return { answer, took: usedOf(await ctx.meta.getTransactionMetrics()) }
  })

/* The finding of My view's projects alone (lib/overview.ts myViewProjects)
 * under `reads`, MILESTONE_MINE unless given, as mineMilestoneProjects runs
 * it, before the check of the projects, with the guard it read under. */
const resolveOnly = async (
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  reads: ReadCeiling = MILESTONE_MINE,
) => {
  const guard = viewBudget(ctx, reads)
  const seats = new Map(
    [...profiles.values()].map((me): [string, ViewAccess] => [
      me.org_id,
      viewAccess(ctx, guard, me),
    ]),
  )
  return { found: await myViewProjects(ctx, guard, seats), guard }
}

/* The bytes a measured finding may read, past MILESTONE_MINE.bytes so a
 * finding that does not fit it still ends and says by how much, and below
 * lib/viewReads.ts REAL_BYTES, so its guard's ceiling.bytes is these less
 * the fixed charges. */
const FINDING_BYTES = 12 * MIB

/* `read` as took answers it, or the reason of its refusal. */
async function tried<R>(t: T, read: (ctx: QueryCtx) => Promise<R>) {
  try {
    return await took(t, read)
  } catch (e) {
    const data = (e as { data?: { reason?: string } }).data
    return { refused: data?.reason ?? String(e) }
  }
}

/* Logs what a design-size `mine` read took, each step in a transaction of
 * its own: the finding of the projects alone, the check of the projects
 * it found alone (milestoneProjects), the read of their first batch of
 * `limit` rows alone, with its `past` probe on Upcoming, and the whole
 * request, as milestones.section reads it. Answers the whole request's. */
async function measureMine(
  t: T,
  me: Doc<'profiles'>,
  label: string,
  limit: number,
  side: 'upcoming' | 'past' = 'upcoming',
  search = '',
) {
  const profiles = new Map([[me.org_id, me]])
  // the finding's bytes may pass MILESTONE_MINE.bytes, so a finding that
  // does not fit them is measured too
  const measuring = (): ReadCeiling => ({ ...MILESTONE_MINE, bytes: FINDING_BYTES })
  const found = await t.query(async (ctx) =>
    (await resolveOnly(ctx, profiles, measuring())).found.map((r) => r.project.id),
  )
  const batchOf = (ctx: QueryCtx, ids: readonly string[]) =>
    readMilestones(ctx, ids, {
      span: side === 'upcoming' ? { from: MONDAY, order: 'asc' } : { to: MONDAY, order: 'desc' },
      after: null,
      search,
      limit,
      ...(side === 'upcoming' ? { pastBefore: MONDAY } : {}),
    })
  // the finding under MILESTONE_MINE's ranges and documents and up to
  // FINDING_BYTES, with the bytes its guard decides by, which
  // MILESTONE_MINE.bytes bounds. They are the real bytes with each row it
  // charges at a fixed size (lib/viewReads.ts viewBudget charge) counted at
  // that size
  const finding = await tried(t, async (ctx) => {
    const reads = measuring()
    const { found, guard } = await resolveOnly(ctx, profiles, reads)
    const used = (await ctx.meta.getTransactionMetrics()).bytesRead.used
    const decided = used + reads.bytes - guard.ceiling.bytes
    return { projects: found.length, decisionMib: Math.round((decided / MIB) * 100) / 100 }
  })
  const check = await tried(
    t,
    async (ctx) => (await milestoneProjects(ctx, profiles, found)).length,
  )
  const read = await tried(t, async (ctx) => (await batchOf(ctx, found)).rows.length)
  const whole = await tried(t, async (ctx) => {
    const ids = await mineMilestoneProjects(ctx, profiles)
    const batch = await batchOf(ctx, ids)
    return {
      projects: ids.length,
      rows: batch.rows.length,
      next: batch.next !== null,
      stopped: batch.stopped,
      past: batch.past,
    }
  })
  console.log(`mine reads, ${label}: ${JSON.stringify({ finding, check, read, whole })}`)
  return whole
}

// ------------------------------------------------------------- which projects

describe('which projects a mine read lists', () => {
  it("lists the projects above the caller's own tasks by the Reviewer rule across two seats, and no other", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = f.user
    const org = f.org.id
    // TBED: an open task the user is assigned
    await plantIssue(t, { org_id: org, project_id: f.sub.id, assignee_id: me.id })
    // a task In Review the user reviews, whose assignee is another
    const reviewing = await program(t, org, 'Reviewing')
    await grant(t, reviewing.top, me)
    await plantIssue(t, {
      org_id: org,
      project_id: reviewing.sub.id,
      status: 'review',
      assignee_id: f.admin.id,
      reviewer_id: me.id,
    })
    // a group In Review the user is assigned, whose reviewer is another:
    // a group stays with its assignee
    const grouped = await program(t, org, 'Grouped')
    await grant(t, grouped.top, me)
    const group = await plantIssue(t, {
      org_id: org,
      project_id: grouped.sub.id,
      status: 'review',
      assignee_id: me.id,
      reviewer_id: f.admin.id,
    })
    await plantIssue(t, {
      org_id: org,
      project_id: grouped.sub.id,
      parent_id: group.id,
      assignee_id: f.admin.id,
    })
    // a Done task the nightly archive has not taken yet
    const done = await program(t, org, 'Done lately')
    await grant(t, done.top, me)
    await plantIssue(t, {
      org_id: org,
      project_id: done.sub.id,
      status: 'done',
      done_at: NOW,
      assignee_id: me.id,
    })
    // the user holds a grant on this sub-project alone, so its top-level
    // project shows only to reach it
    const reach = await program(t, org, 'Reach only')
    await grant(t, reach.sub, me)
    await plantIssue(t, { org_id: org, project_id: reach.sub.id, assignee_id: me.id })
    // a second seat of the same login, in another organization
    const seat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'user',
      auth_user_id: me.auth_user_id,
      org_role: 'admin',
      accepted_at: NOW,
    })
    const otherSub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    await plantIssue(t, { org_id: f.otherOrg.id, project_id: otherSub.id, assignee_id: seat.id })

    // Left out: a group the user reviews whose assignee is another, and a
    // task without subtasks the user is assigned whose reviewer is another
    const handed = await program(t, org, 'Handed on')
    await grant(t, handed.top, me)
    const theirGroup = await plantIssue(t, {
      org_id: org,
      project_id: handed.sub.id,
      status: 'review',
      assignee_id: f.admin.id,
      reviewer_id: me.id,
    })
    await plantIssue(t, {
      org_id: org,
      project_id: handed.sub.id,
      parent_id: theirGroup.id,
      assignee_id: f.admin.id,
    })
    await plantIssue(t, {
      org_id: org,
      project_id: handed.sub.id,
      status: 'review',
      assignee_id: me.id,
      reviewer_id: f.admin.id,
    })
    // a project the user sees and leads with only another's task
    const skunk = await plantProject(t, { org_id: org, type: 'project', parent_id: f.hidden.id })
    await plantIssue(t, { org_id: org, project_id: skunk.id, assignee_id: f.admin.id })
    // an archived task's project
    const archivedTask = await program(t, org, 'Archived task')
    await grant(t, archivedTask.top, me)
    await plantIssue(t, {
      org_id: org,
      project_id: archivedTask.sub.id,
      assignee_id: me.id,
      archived_at: NOW,
    })
    // an archived sub-project, and an archived top-level project
    const archivedSub = await program(t, org, 'Archived part')
    await grant(t, archivedSub.top, me)
    await t.run((ctx) => ctx.db.patch(archivedSub.sub._id, { archived_at: NOW }))
    await plantIssue(t, { org_id: org, project_id: archivedSub.sub.id, assignee_id: me.id })
    const archivedTop = await program(t, org, 'Archived plan', { archived_at: NOW })
    await grant(t, archivedTop.top, me)
    await plantIssue(t, { org_id: org, project_id: archivedTop.sub.id, assignee_id: me.id })
    // a seat of the same login that is gone
    const goneOrg = uuid()
    await t.run((ctx) =>
      ctx.db.insert('organizations', {
        id: goneOrg,
        name: 'Gone',
        slug: 'gone',
        created_at: NOW,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      }),
    )
    const goneSeat = await plantSeat(t, {
      org_id: goneOrg,
      auth_user_id: me.auth_user_id,
      org_role: 'admin',
      active: false,
      accepted_at: NOW,
    })
    const gone = await program(t, goneOrg, 'Gone work')
    await plantIssue(t, { org_id: goneOrg, project_id: gone.sub.id, assignee_id: goneSeat.id })

    const listed = [
      f.meta,
      reviewing.top,
      grouped.top,
      done.top,
      reach.top,
      f.otherProject,
    ] as const
    const left = [
      handed.top,
      f.hidden,
      archivedTask.top,
      archivedSub.top,
      archivedTop.top,
      gone.top,
    ] as const
    const upcoming = new Map<string, string>()
    const past = new Map<string, string>()
    for (const p of [...listed, ...left]) {
      upcoming.set(p.id, await plant(t, p.id, plus(MONDAY, 7), `${p.name} gate`))
      past.set(p.id, await plant(t, p.id, plus(MONDAY, -7), `${p.name} review`))
    }
    await withReach(t)

    const caller = as(t, me)
    const want = listed.map((p) => p.id).sort()
    const up = await caller.query(api.milestones.section, mineAsk())
    expect(up.projects).toEqual(want)
    expect(up.rows.map((r) => r.id).sort()).toEqual(
      listed.map((p) => upcoming.get(p.id) ?? '').sort(),
    )
    expect(up.past).toBe(true)
    const back = await caller.query(api.milestones.section, mineAsk({ side: 'past' }))
    expect(back.projects).toEqual(want)
    expect(back.rows.map((r) => r.id).sort()).toEqual(
      listed.map((p) => past.get(p.id) ?? '').sort(),
    )
    // this must fail for a rule that takes the assignee as the owner, which
    // lists Handed on and leaves Reviewing out
    const tasks = await t.run((ctx) => ctx.db.query('issues').collect())
    const byAssignee = new Set(
      tasks
        .filter((x) => x.assignee_id === me.id && x.archived_at === undefined)
        .map((x) => x.project_id),
    )
    expect(byAssignee.has(handed.sub.id)).toBe(true)
    expect(byAssignee.has(reviewing.sub.id)).toBe(false)
    // a named read of the same ids answers the same rows, with no projects
    const named = await caller.query(api.milestones.section, namedAsk(want))
    expect(named.rows).toEqual(up.rows)
    expect(named).not.toHaveProperty('projects')

    // once the user no longer holds the grant, Reach only goes
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
        .filter((q) => q.eq(q.field('project_id'), reach.sub.id))
        .unique()
      if (row) await ctx.db.delete(row._id)
    })
    await withReach(t)
    const after = await caller.query(api.milestones.section, mineAsk())
    expect(after.projects).toEqual(want.filter((id) => id !== reach.top.id))
  })

  it("lists for every Northstar person the projects of My view's health table and the Roadmap's tracks", async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    await withReach(t)
    let some = 0
    let fewer = 0
    for (const person of profiles.filter((p) => p.kind === 'person')) {
      const caller = as(t, person)
      const answer = await caller.query(api.milestones.section, {
        ...mineAsk(),
        from: plus(NORTHSTAR_ANCHOR, 7),
        limit: 1,
      })
      const roadmap = await roadmapFor(t, person, { kind: 'mine' })
      if (roadmap.state !== 'ok') throw new Error(`${person.name}: ${roadmap.state}`)
      const tops = await t.run(async (ctx) => {
        const out = new Set<string>()
        for (const id of roadmap.held_sub_projects ?? []) {
          const sub = await byId(ctx, 'projects', id)
          if (sub?.parent_id) out.add(sub.parent_id)
        }
        return [...out].sort()
      })
      const health = await caller.query(api.overview.health, {
        scope: { kind: 'mine' },
        ...weeksOf(DAY),
        sort: 'name',
        dir: 'asc',
        limit: 200,
      })
      if (health.state !== 'ok') throw new Error(`${person.name}: ${health.state}`)
      expect(answer.projects, person.name).toEqual(tops)
      expect(answer.projects, person.name).toEqual(health.rows.map((r) => r.project_id).sort())
      // the check of named projects keeps every one of them
      const checked = await t.query((ctx) =>
        milestoneProjects(ctx, new Map([[person.org_id, person]]), answer.projects ?? []),
      )
      expect(checked.sort(), person.name).toEqual(answer.projects)
      if ((answer.projects ?? []).length > 0) some++
      const snap = await workspaceOf(caller)
      const seen = snap?.projects.filter((p) => p.parent_id === undefined).length ?? 0
      if ((answer.projects ?? []).length < seen) {
        fewer++
        console.log(
          `mine projects, ${person.name}: ${answer.projects?.length} of ${seen} top-level projects`,
        )
      }
    }
    expect(some).toBeGreaterThan(0)
    // My view is not every project a person sees
    expect(fewer).toBeGreaterThan(0)
  })
})

// --------------------------------------------------------- Load more and search

describe('a mine read the app grows', () => {
  it('answers Load more, a moved-on batch, a past search and the past probe as a read of its projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = f.user
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: me.id })
    const second = await program(t, f.org.id, 'Second')
    await grant(t, second.top, me)
    await plantIssue(t, { org_id: f.org.id, project_id: second.sub.id, assignee_id: me.id })
    // one milestone a project week, twelve weeks either way
    const rows: { project: string; week: string; name: string }[] = []
    for (const [i, p] of [f.meta, second.top].entries())
      for (let w = 1; w <= 12; w++) {
        rows.push({ project: p.id, week: plus(MONDAY, 7 * w + i), name: `Gate ${w} ${p.name}` })
        rows.push({ project: p.id, week: plus(MONDAY, -7 * w + i), name: `Review ${w} ${p.name}` })
      }
    await plantMany(t, rows)
    await withReach(t)
    const caller = as(t, me)
    const projects = [f.meta.id, second.top.id].sort()
    for (const side of ['upcoming', 'past'] as const)
      for (const search of ['', 'Gate 1', 'review 3']) {
        const over = { side, limit: 5, ...(search ? { search } : {}) }
        expect(await walk(caller, mineAsk(over)), `${side} "${search}"`).toEqual(
          await walk(caller, namedAsk(projects, over)),
        )
      }
    // a first batch of 10, grown to 20 and to 100, and one moved on after
    // its tenth row, as the Overview's Upcoming asks them
    const first = await caller.query(api.milestones.section, mineAsk({ limit: 10 }))
    expect(first.projects).toEqual(projects)
    expect(first.rows).toHaveLength(10)
    expect(first.past).toBe(true)
    const grown = await caller.query(api.milestones.section, mineAsk({ limit: 20 }))
    expect(grown.rows.slice(0, 10)).toEqual(first.rows)
    const whole = await caller.query(api.milestones.section, mineAsk({ limit: 100 }))
    expect(whole.rows).toHaveLength(24)
    expect(whole.next).toBeNull()
    const tenth = first.rows[9] as { id: string; name: string; week: string }
    const moved = await caller.query(
      api.milestones.section,
      mineAsk({ limit: 10, after: { week: tenth.week, key: nameKey(tenth.name), id: tenth.id } }),
    )
    expect(moved.rows).toEqual(whole.rows.slice(10, 20))
    expect(moved).not.toHaveProperty('past')
    // a person with no past milestone in their projects hears past false
    const fresh = await program(t, f.org.id, 'Fresh')
    const newcomer = await seatOf(t, f.org.id)
    await grant(t, fresh.top, newcomer)
    await plantIssue(t, { org_id: f.org.id, project_id: fresh.sub.id, assignee_id: newcomer.id })
    await plant(t, fresh.top.id, plus(MONDAY, 3), 'Fresh start')
    await withReach(t)
    const theirs = await as(t, newcomer).query(api.milestones.section, mineAsk({ limit: 10 }))
    expect(theirs.projects).toEqual([fresh.top.id])
    expect(theirs.rows.map((r) => r.name)).toEqual(['Fresh start'])
    expect(theirs.past).toBe(false)
  })
})

// ------------------------------------------------------------------- refusals

describe('refusals of a mine read', () => {
  it('refuses named projects beside mine, mine false and a caller who is not signed in', async () => {
    const t = newT()
    const f = await withOrg(t)
    const caller = as(t, f.user)
    await expectRefusal(
      caller.query(api.milestones.section, mineAsk({ projects: [f.meta.id] })),
      'bad_request',
      /^projects must be empty when mine is true$/,
    )
    // the validator takes only true; with false the read would list nothing
    await expect(
      caller.query(api.milestones.section, {
        ...mineAsk(),
        mine: false as unknown as true,
      }),
    ).rejects.toThrow()
    await expectRefusal(t.query(api.milestones.section, mineAsk()), 'forbidden', /not signed in/)
    // with no projects named and no mine, the read lists nothing
    expect(await caller.query(api.milestones.section, namedAsk([]))).toMatchObject({
      rows: [],
      next: null,
    })
  })

  it('refuses more projects than one read names with the limit sentence, and answers at the limit', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = f.user
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: me.id })
    for (const name of ['Second', 'Third']) {
      const p = await program(t, f.org.id, name)
      await grant(t, p.top, me)
      await plantIssue(t, { org_id: f.org.id, project_id: p.sub.id, assignee_id: me.id })
      await plant(t, p.top.id, plus(MONDAY, 7), `${name} gate`)
    }
    await withReach(t)
    const caller = as(t, me)
    Object.assign(MILESTONE_READ, { projects: 2 })
    const refused = await expectRefusal(caller.query(api.milestones.section, mineAsk()), 'rule')
    expect(refused.data.reason).toBe(MILESTONE_TOO_MANY)
    expect(refused.data.message).toBe(LIMITS.milestoneProjects.refusal)
    Object.assign(MILESTONE_READ, { projects: 3 })
    const answer = await caller.query(api.milestones.section, mineAsk())
    expect(answer.projects).toHaveLength(3)
    expect(answer.rows).toHaveLength(2)
  })

  it('refuses past its own read budget, and answers one step up', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = f.user
    for (let i = 0; i < 4; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: me.id })
    const m = await plant(t, f.meta.id, plus(MONDAY, 7), 'Launch')
    await withReach(t)
    const caller = as(t, me)
    const asks = async (ranges: number) => {
      Object.assign(MILESTONE_MINE, { ranges })
      try {
        return await caller.query(api.milestones.section, mineAsk())
      } catch (e) {
        return e
      }
    }
    // the fewest ranges that answer, found by halving
    let low = 0
    let high = DEFAULT_MINE.ranges
    expect((await asks(high)) as { rows: unknown[] }).toMatchObject({ rows: [{ id: m }] })
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if ((await asks(mid)) instanceof Error) low = mid
      else high = mid
    }
    const refused = await expectRefusal(
      (async () => {
        const got = await asks(high - 1)
        if (got instanceof Error) throw got
        return got
      })(),
      'rule',
    )
    expect(refused.data.reason).toBe(MILESTONE_READ_TOO_LARGE)
    expect((await asks(high)) as { rows: unknown[] }).toMatchObject({ rows: [{ id: m }] })
    console.log(
      `mine reads, the fewest MILESTONE_MINE ranges that answer one sub-project's 4 tasks: ${high}`,
    )
  })

  it("refuses with access_unchecked where a bound of the caller's own reads stops a check, and answers one bound up", async () => {
    const t = newT()
    const f = await withOrg(t)
    // a member of a team sharing FW, with a task there
    const me = await seatOf(t, f.org.id)
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
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: me.id })
    const m = await plant(t, f.meta.id, plus(MONDAY, 7), 'Launch')
    await withReach(t)
    const caller = as(t, me)
    const usual = await caller.query(api.milestones.section, mineAsk())
    expect(usual.rows.map((r) => r.id)).toEqual([m])
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    const refused = await expectRefusal(caller.query(api.milestones.section, mineAsk()), 'rule')
    expect(refused.data.reason).toBe(ACCESS_UNCHECKED)
    Object.assign(OWN_READS, { lookups: 1, teamReads: 2 })
    expect(await caller.query(api.milestones.section, mineAsk())).toEqual(usual)
  })
})

// ---------------------------------------------------------------- design size
// newT({ transactionLimits }) enforces Convex's own limits per transaction.
// Each case raises one figure, or two a read covers at their sum.

describe('a mine read at the design size', () => {
  it("lists 200 top-level projects of one sub-project each, the caller's task in each, 100 rows with a next", async () => {
    // the 200 top-level projects and the 200 sub-projects one person can
    // read, at their sum, 150 through the shares of the person's three
    // teams, 50 each as a team's design size allows, and 50 through a
    // grant on the top-level project
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f.org.id, { org_role: 'user' })
    const shared = await plantShared(t, f.org.id, f.user, me, { tops: 150, subs: 1 })
    // TBED and SKNK are the organization's other two top-level projects;
    // TBED keeps FW alone and SKNK gets one sub-project
    await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
    const skunk = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const granted = [f.meta, f.hidden]
    const grantedSubs = [f.sub, skunk]
    for (let i = 0; i < 48; i++) {
      const p = await program(t, f.org.id, `Granted ${i}`)
      granted.push(p.top)
      grantedSubs.push(p.sub)
    }
    for (const top of granted) await grant(t, top, me)
    const subs = [...shared.subs, ...grantedSubs]
    const tops = [...shared.tops, ...granted]
    expect(tops).toHaveLength(200)
    for (const sub of subs)
      await plantTasks(t, sub, 1, () => ({
        assignee_id: me.id,
        title: 'Replace the fan controller',
      }))
    await plantMany(
      t,
      tops.map((p, i) => ({ project: p.id, week: plus(MONDAY, i % 60), name: `Gate ${i}` })),
    )
    await withReach(t)
    const answer = await as(t, me).query(api.milestones.section, mineAsk({ limit: 100 }))
    expect(answer.projects).toHaveLength(200)
    expect(answer.rows).toHaveLength(100)
    expect(answer.next).not.toBeNull()
    expect(answer.stopped).toBeNull()
    const first = await as(t, me).query(api.milestones.section, mineAsk({ limit: 10 }))
    expect(first.rows).toHaveLength(10)
    expect(first.stopped).toBeNull()
    await measureMine(t, me, '200 projects through team shares and grants, limit 10', 10)
    const got = await measureMine(
      t,
      me,
      '200 projects through team shares and grants, limit 100',
      100,
    )
    expect(got).toMatchObject({ answer: { projects: 200, rows: 100, next: true, stopped: null } })
  })

  it('lists 200 top-level projects the caller reaches through a grant on their one sub-project each', async () => {
    // every top-level project shows only for navigation; the 200 top-level
    // projects and the 200 sub-projects one person can read at their sum
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f.org.id, { org_role: 'user' })
    await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
    const skunk = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const tops = [f.meta, f.hidden]
    const subs = [f.sub, skunk]
    for (let i = 0; i < 198; i++) {
      const p = await program(t, f.org.id, `Programme ${i}`)
      tops.push(p.top)
      subs.push(p.sub)
    }
    await t.run(async (ctx) => {
      for (const sub of subs)
        await ctx.db.insert('project_access', {
          project_id: sub.id,
          profile_id: me.id,
          level: 'user',
        })
    })
    for (const sub of subs)
      await plantTasks(t, sub, 1, () => ({
        assignee_id: me.id,
        title: 'Replace the fan controller',
      }))
    await plantMany(
      t,
      tops.map((p, i) => ({ project: p.id, week: plus(MONDAY, i % 60), name: `Gate ${i}` })),
    )
    await withReach(t)
    const answer = await as(t, me).query(api.milestones.section, mineAsk({ limit: 100 }))
    expect(answer.projects).toHaveLength(200)
    expect(answer.rows).toHaveLength(100)
    expect(answer.next).not.toBeNull()
    expect(answer.stopped).toBeNull()
    await measureMine(t, me, '200 projects for navigation only, limit 10', 10)
    const got = await measureMine(t, me, '200 projects for navigation only, limit 100', 100)
    expect(got).toMatchObject({ answer: { projects: 200, rows: 100, next: true, stopped: null } })
  })

  it("lists 200 top-level projects whose 200 live and 500 archived sub-projects each hold one of the caller's open tasks", async () => {
    // the 200 live and 500 archived sub-projects one person can read, at
    // their sum, each by a grant on it, under 200 top-level projects that
    // show only for navigation, 2 or 3 archived beside each live one; an
    // archived sub-project keeps its open tasks, so the finding reads the
    // caller's 500 there and judges each project not live
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f.org.id, { org_role: 'user' })
    const trees = await plantTrees(t, f.org.id, me, 200, (i) => (i < 100 ? 3 : 2))
    expect(trees.live).toHaveLength(200)
    expect(trees.archived).toHaveLength(500)
    // FW, PCB and SKNK are the fixture's own and hold none of the
    // caller's work
    await plantMany(
      t,
      trees.tops.map((p, i) => ({ project: p.id, week: plus(MONDAY, i % 60), name: `Gate ${i}` })),
    )
    await withReach(t)
    const got = await measureMine(
      t,
      me,
      '200 projects, 200 live and 500 archived sub-projects, limit 10',
      10,
    )
    expect(got).toMatchObject({ answer: { projects: 200, rows: 10, next: true, stopped: null } })
    const answer = await as(t, me).query(api.milestones.section, mineAsk({ limit: 10 }))
    expect(answer.projects).toEqual(trees.tops.map((p) => p.id).sort())
    expect(answer.rows).toHaveLength(10)
    expect(answer.stopped).toBeNull()
  })

  it('lists the one project of a sub-project where the caller holds 300 open and 150 Done tasks', async () => {
    // open and Done not yet archived at their sum, in one sub-project
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await seatOf(t, f.org.id, { org_role: 'user' })
    const shared = await plantShared(t, f.org.id, f.user, me, { tops: 1, subs: 1 })
    const sub = shared.subs[0] as Doc<'projects'>
    const top = shared.tops[0] as Doc<'projects'>
    const statuses = ['todo', 'progress', 'review', 'backlog'] as const
    await plantTasks(t, sub, 300, (i) => ({
      assignee_id: me.id,
      status: statuses[i % statuses.length],
      ...(statuses[i % statuses.length] === 'review' ? { reviewer_id: f.admin.id } : {}),
      title: 'Replace the fan controller on the bench rig and log the readings',
    }))
    await plantTasks(t, sub, 150, () => ({
      assignee_id: me.id,
      status: 'done',
      done_at: NOW,
      title: 'Replace the fan controller on the bench rig and log the readings',
    }))
    const rows: { project: string; week: string; name: string }[] = []
    for (let w = 0; w < 30; w++)
      rows.push({ project: top.id, week: plus(MONDAY, 7 * w), name: `Gate ${w}` })
    await plantMany(t, rows)
    await withReach(t)
    // a task In Review whose reviewer is another belongs to the reviewer,
    // so a quarter of the open tasks are not the caller's; the rest hold
    // the project
    const answer = await as(t, me).query(api.milestones.section, mineAsk({ limit: 10 }))
    expect(answer.projects).toEqual([top.id])
    expect(answer.rows).toHaveLength(10)
    expect(answer.stopped).toBeNull()
    const got = await measureMine(
      t,
      me,
      'one sub-project, 300 open and 150 Done tasks, limit 10',
      10,
    )
    expect(got).toMatchObject({ answer: { projects: 1, rows: 10, next: true, stopped: null } })
  })
})
