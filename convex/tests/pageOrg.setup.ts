/* The organization of the active task page measurements
 * (convex/tests/activeTaskPagesScale.test.ts), built at the sizes a case
 * asks for, at most the design size, with ordinary text, and the reads of
 * one page with what it read. Named *.setup.ts so the Convex CLI skips it
 * (see helpers.setup.ts). */
/// <reference types="vite/client" />

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { newWindowKey } from '../lib/db'
import { MIB } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { listIssues, listProjects } from '../machine/rest'
import {
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

/* What one page read, as Convex counts it, and what it answered. */
export type Figures = {
  ranges: number
  documents: number
  mib: number
  rows: number
  answer_kb: number
  next: boolean
}

/* Prints what a page read, the figures ACTIVE_PAGE's docstring quotes. */
export const record = (name: string, figures: Figures) =>
  console.log(`active page figures, ${name}:`, JSON.stringify(figures))

/* A query's handler, run inside a test's own transaction so its metrics
 * can be read after it. */
export const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

export type RestArgs = {
  callerId: string
  access: 'read'
  today: string
  project?: string
  search?: string
  limit?: string
  cursor?: string
  status?: string
}
export type RestPage = { next_cursor: string | null; tasks: { id: string; delay: unknown }[] }

/* One REST page read in a query of its own, with what it read before its rows (the
 * caller, the catalogue and the access rows) and in all. */
export async function readPage(t: T, args: Omit<RestArgs, 'today' | 'access'>) {
  return await t.query(async (ctx) => {
    const page = await handlerOf<RestArgs, RestPage>(listIssues)(ctx, {
      today: TODAY,
      access: 'read',
      ...args,
    })
    const m = await ctx.meta.getTransactionMetrics()
    const figures: Figures = {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
      rows: page.tasks.length,
      answer_kb: Math.round(JSON.stringify(page).length / 1024),
      next: page.next_cursor !== null,
    }
    return { page, figures }
  })
}

/* The reads before a page: the caller, the catalogue and their access, as
 * REST GET /v1/projects reads them, which reads nothing else of size. */
export async function readBefore(t: T, callerId: string) {
  return await t.query(async (ctx) => {
    await handlerOf<{ callerId: string; access: 'read' }, unknown[]>(listProjects)(ctx, {
      callerId,
      access: 'read',
    })
    const m = await ctx.meta.getTransactionMetrics()
    return {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
    }
  })
}

/* Ordinary titles and texts. */
export const TITLES = [
  'Replace the fan controller on the bench rig',
  'Write up the thermal test results for review',
  'Fix the login timeout on the field tablets',
  'Order spare connectors for the next build',
  'Update the assembly guide with the new jig',
  'Check the power budget of the sensor board',
  'Plan the firmware release for the pilot sites',
  'Answer the customer question on the export format',
]
export const TEXT =
  'The readings drift slowly through the morning, so we log them every ten minutes and compare them with the previous build. ' +
  'Once the cause is clear, write the change into the assembly guide and ask the test team to repeat the run on two boards. ' +
  'Keep the old values in the sheet so the difference stays easy to see.'

/* Task numbers clear of the fixtures'. */
let num = 1_000_000

export type PageOrg = OrgFixture & {
  t: T
  member: Doc<'profiles'>
  owners: Doc<'profiles'>[]
  tops: Doc<'projects'>[]
  subs: Doc<'projects'>[]
  /** the sub-projects `member` reads */
  readable: Doc<'projects'>[]
}

/** The sizes of an organization of pageOrg, each at most its design size.
 * withOrg adds two live top-level projects, two live sub-projects and six
 * people. */
export type PageOrgSizes = {
  /** live top-level projects */
  tops: number
  /** live sub-projects, `family` under the first top-level project and the
   * rest spread over the others */
  subs: number
  /** sub-projects under the first top-level project, 3 by default */
  family?: number
  /** archived top-level projects, with `archivedSubs` sub-projects spread
   * over them, none by default */
  archivedTops?: number
  archivedSubs?: number
  /** how many sub-projects `member` reads at least: three teams of theirs
   * share whole top-level projects, from the first, until they hold that
   * many. Every live one by default. */
  memberSubs?: number
  /** people besides withOrg's, `owners` by default */
  people?: number
  /** active tasks spread over the live sub-projects */
  tasks: number
  /** archived tasks beside them, which no page reads */
  archived: number
  /** the people who own the tasks, 50 by default, each owning every 50th
   * task; given, each owns the tasks of a few sub-projects */
  owners?: number
}

/* Runs `fn` and logs how long it took, so a slow fixture shows where. */
async function phase<R>(name: string, fn: () => Promise<R>): Promise<R> {
  const from = Date.now()
  const out = await fn()
  console.log(`page organization phase, ${name}: ${Date.now() - from} ms`)
  return out
}

/* A sub-project row of `top` numbered `i`, live or archived beneath an
 * archived parent. */
const subDoc = (orgId: string, lead: string, top: Doc<'projects'>, i: number) => ({
  id: uuid(),
  org_id: orgId,
  type: 'project' as const,
  parent_id: top.id,
  key: `W${i}`,
  num: 10_000 + i,
  sort_order: 10_000 + i,
  ...named(`Workstream ${i}`),
  description: '',
  lead_id: lead,
  track_delay: true,
  created_at: NOW,
  window_key: newWindowKey(),
  ...(top.archived_at === undefined
    ? { archive_state: 'live' as const }
    : { archive_state: 'under' as const, archived_at: top.archived_at }),
})

/**
 * An organization at `o`'s sizes: the live top-level projects and their
 * sub-projects, the archived ones, `member` in three teams that share
 * top-level projects, the people, and the tasks spread over the live
 * sub-projects, a tenth of them groups of five subtasks stored before the
 * rule of one level, planned and owned by `owners` people in projects that
 * track delay, with archived tasks beside them. No project_reach rows: a
 * list takes the caller's access from their grants and team shares
 * (lib/core.ts accessFlags), so active pages never read them.
 */
export async function pageOrg(o: PageOrgSizes): Promise<PageOrg> {
  const family = o.family ?? 3
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const tops: Doc<'projects'>[] = []
  const subs: Doc<'projects'>[] = []
  await phase('projects', async () => {
    for (let i = 0; i < o.tops; i++)
      tops.push(
        await plantProject(t, {
          org_id: f.org.id,
          lead_id: f.user.id,
          ...named(`Programme ${i}`),
          description: 'A programme of work.',
          track_delay: true,
          archive_state: 'live',
        }),
      )
    const archived: Doc<'projects'>[] = []
    for (let i = 0; i < (o.archivedTops ?? 0); i++)
      archived.push(
        await plantProject(t, {
          org_id: f.org.id,
          lead_id: f.user.id,
          ...named(`Finished programme ${i}`),
          description: 'A finished programme of work.',
          archive_state: 'listed',
          archived_at: NOW,
        }),
      )
    await t.run(async (ctx) => {
      for (let i = 0; i < o.subs; i++) {
        const top = (
          i < family ? tops[0] : tops[1 + ((i - family) % Math.max(1, o.tops - 1))]
        ) as Doc<'projects'>
        const _id = await ctx.db.insert('projects', subDoc(f.org.id, f.user.id, top, i))
        subs.push((await ctx.db.get(_id)) as Doc<'projects'>)
      }
      for (let i = 0; i < (o.archivedSubs ?? 0); i++) {
        const top = archived[i % archived.length] as Doc<'projects'>
        await ctx.db.insert('projects', subDoc(f.org.id, f.user.id, top, o.subs + i))
      }
    })
  })
  const member = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Member',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: NOW,
  })
  // the member's three teams share top-level projects in turn, from the
  // first, until the member reads `memberSubs` sub-projects
  const readable: Doc<'projects'>[] = []
  await phase('teams and shares', () =>
    t.run(async (ctx) => {
      const teams: { id: string; name: string }[] = []
      for (let i = 0; i < 3; i++) {
        const team = { id: uuid(), name: `Team ${i}` }
        teams.push(team)
        await ctx.db.insert('teams', {
          id: team.id,
          org_id: f.org.id,
          ...named(team.name),
          track_delay_default: true,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: team.id,
          profile_id: member.id,
          is_leader: false,
          name_key: nameKey(member.name),
        })
      }
      for (const [i, top] of tops.entries()) {
        if (readable.length >= (o.memberSubs ?? subs.length)) break
        const team = teams[i % teams.length] as { id: string; name: string }
        await ctx.db.insert('project_team_access', {
          project_id: top.id,
          team_id: team.id,
          level: 'user',
          name_key: nameKey(team.name),
        })
        readable.push(...subs.filter((sub) => sub.parent_id === top.id))
      }
    }),
  )
  // the people, `owners` of them owning the tasks
  const owners: Doc<'profiles'>[] = []
  await phase('people', () =>
    t.run(async (ctx) => {
      for (let i = 0; i < Math.max(o.people ?? 0, o.owners ?? 50); i++) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: `Person ${i}`,
          initials: 'PP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
        })
        if (i < (o.owners ?? 50)) owners.push((await ctx.db.get(_id)) as Doc<'profiles'>)
      }
    }),
  )
  // the tasks, oldest first, in batches
  await phase(`${o.tasks} active tasks`, async () => {
    for (let from = 0; from < o.tasks; from += 1000) {
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(o.tasks, from + 1000); i++) {
          const sub = subs[i % subs.length] as Doc<'projects'>
          const id = uuid()
          // with `owners` given, each owns the tasks of a few sub-projects
          const owner = owners[
            o.owners === undefined ? i % owners.length : (i % subs.length) % owners.length
          ] as Doc<'profiles'>
          const week = `2026-0${1 + (i % 9)}-05`
          const doc = {
            id,
            org_id: f.org.id,
            project_id: sub.id,
            num: num++,
            title: TITLES[i % TITLES.length] as string,
            status: i % 5 === 0 ? ('done' as const) : ('progress' as const),
            priority: 'medium' as const,
            paused: false,
            assignee_id: owner.id,
            reporter_id: f.user.id,
            created_by: f.user.id,
            start_week: week,
            end_week: week,
            remaining_hours: 6,
            remaining_set_at: NOW,
            due_date: '2026-06-30',
            created_at: new Date(Date.parse('2025-01-01T00:00:00.000Z') + i * 60_000).toISOString(),
            updated_at: NOW,
            status_at: NOW,
            window_key: newWindowKey(),
          }
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: id,
            description: TEXT,
            org_id: f.org.id,
            project_id: sub.id,
          })
          // a tenth of the tasks are groups of five subtasks in their project
          if (i % 50 === 0) {
            for (let k = 0; k < 5; k++) {
              const kid = uuid()
              await ctx.db.insert('issues', {
                ...doc,
                id: kid,
                num: num++,
                parent_id: id,
                window_key: newWindowKey(),
              })
              await ctx.db.insert('issue_descriptions', {
                issue_id: kid,
                description: '',
                org_id: f.org.id,
                project_id: sub.id,
              })
            }
          }
        }
      })
    }
  })
  await phase(`${o.archived} archived tasks`, async () => {
    for (let from = 0; from < o.archived; from += 1000) {
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(o.archived, from + 1000); i++) {
          const sub = subs[i % subs.length] as Doc<'projects'>
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: sub.id,
            num: num++,
            title: TITLES[i % TITLES.length] as string,
            status: 'done',
            priority: 'medium',
            paused: false,
            archived_at: NOW,
            created_at: '2024-06-01T00:00:00.000Z',
            updated_at: NOW,
          })
        }
      })
    }
  })
  return { t, ...f, member, owners, tops, subs, readable }
}
