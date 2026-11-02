/* The envelope organization of the active task page measurements
 * (convex/tests/activeTaskPagesScale.test.ts in every run, and
 * convex/tests/activeTaskPages.envelope.ts on demand), built at the sizes a
 * case asks for, and the reads of one page with what it read. Named
 * *.setup.ts so the Convex CLI skips it (see helpers.setup.ts). */
/// <reference types="vite/client" />

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { newWindowKey } from '../lib/db'
import { LIMITS, MIB, NAME_MAX } from '../lib/limits'
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
import { withReach } from './projectReach.setup'

/* What one page read, as Convex counts it, and what it answered. */
export type Figures = {
  ranges: number
  documents: number
  mib: number
  rows: number
  answer_kb: number
  next: boolean
}

const FIGURES: Record<string, Figures> = {}
export const record = (name: string, figures: Figures) => {
  FIGURES[name] = figures
  console.log(`active page figures, ${name}:`, JSON.stringify(figures))
}

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

/* Real titles and texts. */
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
export const JP_TITLE = '計'.repeat(LIMITS.title.max)
export const JP_NAME = (i: number) => String.fromCodePoint(0x4e00 + i) + '班'.repeat(NAME_MAX - 1)

/* Task numbers clear of the fixtures'. */
let num = 1_000_000

export type Envelope = OrgFixture & {
  t: T
  member: Doc<'profiles'>
  owners: Doc<'profiles'>[]
  tops: Doc<'projects'>[]
  subs: Doc<'projects'>[]
}

/** The sizes of an envelope organization (envelope). */
export type EnvelopeSizes = {
  /** active tasks spread over the sub-projects */
  tasks: number
  /** archived tasks beside them, which no page reads */
  archived: number
  /** sub-projects under the 10 top-level projects, 1,986 by default, which
   * with withOrg's makes the envelope's 2,000 projects */
  subs?: number
  /** people besides withOrg's, 993 by default, the envelope's 1,000 */
  people?: number
  /** names, project descriptions, titles and texts in a three-byte script
   * at the caps */
  three?: boolean
  /** older active tasks before `tasks`, in a sub-project archived since */
  oldInArchived?: number
  /** the people who own the tasks, 50 by default, each owning every 50th
   * task; given, each owns the tasks of a few sub-projects */
  owners?: number
  /** whether to write the project_reach rows every deployment holds
   * (internal/navBackfill), true by default. In convex-test that backfill
   * takes about four minutes for 2,000 projects. Active pages never read
   * them, since a list takes the caller's access from their grants and team
   * shares (lib/core.ts accessFlags), and a page's delays ask about the
   * sub-projects of owners' tasks, which navigation does not decide. */
  reach?: boolean
}

/* Runs `fn` and logs how long it took, so a slow fixture shows where. */
async function phase<R>(name: string, fn: () => Promise<R>): Promise<R> {
  const from = Date.now()
  const out = await fn()
  console.log(`envelope phase, ${name}: ${Date.now() - from} ms`)
  return out
}

/**
 * The envelope's organization at `o`'s sizes: 10 top-level projects and
 * their sub-projects, 25 teams that each share 200 sub-projects (or every
 * one when there are fewer), so `member`, in all 25, reads every
 * sub-project, the people, and the tasks spread over the sub-projects, a
 * tenth of them groups of five subtasks stored before the rule of one
 * level, planned and owned by `owners` people in projects that track
 * delay, with archived tasks beside them.
 */
export async function envelope(o: EnvelopeSizes): Promise<Envelope> {
  const subCount = o.subs ?? 1986
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const tops: Doc<'projects'>[] = []
  await phase('top-level projects', async () => {
    for (let i = 0; i < 10; i++)
      tops.push(
        await plantProject(t, {
          org_id: f.org.id,
          lead_id: f.user.id,
          ...named(o.three ? JP_NAME(i) : `Programme ${i}`),
          description: o.three
            ? '計'.repeat(LIMITS.projectDescription.max)
            : 'A programme of work.',
          track_delay: true,
          archive_state: 'live',
        }),
      )
  })
  const subs: Doc<'projects'>[] = []
  await phase('sub-projects', () =>
    t.run(async (ctx) => {
      for (let i = 0; i < subCount; i++) {
        const top = tops[Math.floor((i * 10) / subCount)] as Doc<'projects'>
        const id = uuid()
        const name = o.three ? JP_NAME(100 + i) : `Workstream ${i}`
        const _id = await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: top.id,
          key: `W${i}`,
          num: 10_000 + i,
          sort_order: 10_000 + i,
          ...named(name),
          description: o.three ? '計'.repeat(LIMITS.projectDescription.max) : '',
          lead_id: f.user.id,
          track_delay: true,
          archive_state: 'live',
          created_at: NOW,
          window_key: newWindowKey(),
        })
        subs.push((await ctx.db.get(_id)) as Doc<'projects'>)
      }
    }),
  )
  const member = await plantSeat(t, {
    org_id: f.org.id,
    name: o.three ? JP_NAME(9000) : 'Member',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: NOW,
  })
  await phase('teams and shares', () =>
    t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        const team = uuid()
        const name = o.three ? JP_NAME(5000 + i) : `Team ${i}`
        await ctx.db.insert('teams', {
          id: team,
          org_id: f.org.id,
          ...named(name),
          track_delay_default: true,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: team,
          profile_id: member.id,
          is_leader: false,
          name_key: nameKey(member.name),
        })
        for (let k = 0; k < Math.min(200, subs.length); k++) {
          const sub = subs[(Math.ceil(subs.length / 25) * i + k) % subs.length] as Doc<'projects'>
          await ctx.db.insert('project_team_access', {
            project_id: sub.id,
            team_id: team,
            level: 'user',
            name_key: nameKey(name),
          })
        }
      }
    }),
  )
  // the people, `owners` of them owning the tasks
  const owners: Doc<'profiles'>[] = []
  await phase('people', () =>
    t.run(async (ctx) => {
      for (let i = 0; i < Math.max(o.people ?? 993, o.owners ?? 50); i++) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: o.three ? JP_NAME(2000 + i) : `Person ${i}`,
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
  // the tasks, oldest first, in batches; the oldest `oldInArchived` in
  // projects archived since
  const shelf = o.oldInArchived
    ? await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: tops[0].id,
        archived_at: NOW,
      })
    : null
  const planted = o.tasks + (o.oldInArchived ?? 0)
  await phase(`${planted} active tasks`, async () => {
    for (let from = 0; from < planted; from += 1000) {
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(planted, from + 1000); i++) {
          const old = shelf !== null && i < (o.oldInArchived ?? 0)
          const sub = old ? shelf : (subs[i % subs.length] as Doc<'projects'>)
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
            title: o.three ? JP_TITLE : (TITLES[i % TITLES.length] as string),
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
            description: o.three ? '計'.repeat(390) : TEXT,
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
  if (o.reach !== false) await phase('reach rows', () => withReach(t))
  return { t, ...f, member, owners, tops, subs }
}
