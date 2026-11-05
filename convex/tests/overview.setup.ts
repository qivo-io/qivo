/* Fixtures and reads for the Overview's tests (overview.test.ts): rows as
 * the app's writers make them, with ordinary titles and names, projects a
 * reader's teams share, the client's day and weeks, and a read of one
 * Overview query inside one transaction with what it took, as Convex counts
 * it.
 *
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import type { WithoutSystemFields } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { IssueStatus } from '../lib/enums'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { plantTasks } from './board.setup'
import { NOW, plantProject, plantSeat, type T, uuid } from './helpers.setup'

/** The day the fixtures' due dates are set around, a Monday. */
export const DAY = '2026-11-02'

/** An instant before the rule of one level (lib/viewReads.ts
 * ONE_LEVEL_SINCE): helpers.setup.ts NOW. */
export const BEFORE_RULE = NOW

/** An ordinary title of about 80 characters. */
export const TITLE =
  'Replace the fan controller on the bench rig and log the readings for the review'

/** `day` moved by `days`, as an ISO day. */
export const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** The client's day and weeks for `day`, a Monday, on UTC weeks: the
 * arguments lib/viewLoads.ts clockOf takes. */
export const weeksOf = (day: string) => ({
  day,
  week: day,
  week_starts: Array.from(
    { length: 53 },
    (_, i) => Date.parse(`${day}T00:00:00.000Z`) - (52 - i) * 7 * 86_400_000,
  ),
  week_end: Date.parse(`${day}T00:00:00.000Z`) + 7 * 86_400_000,
})

/** The statuses a fixture's leaves cycle through: 30% Done, 30% To do, 20%
 * In progress, 10% In review, 10% Backlog. */
const LEAF_STATUSES: IssueStatus[] = [
  'todo',
  'progress',
  'done',
  'todo',
  'backlog',
  'review',
  'done',
  'todo',
  'progress',
  'done',
]

/** A fixture task's fields. `i` numbers it in its set; `owners` assign it
 * and review it; `kind` says whether it is a parent, a subtask or a plain
 * task. Three in five are dated, from 60 days before DAY to 120 after (or
 * all before DAY with `overdue`), half are planned with remaining hours, one
 * To do or In progress task in twelve is paused, and a parent keeps a
 * dormant status, Done for one in five, and a pause for one in four. */
export function mixOf(
  i: number,
  owners: readonly Doc<'profiles'>[],
  kind: 'parent' | 'subtask' | 'plain',
  created: string,
  overdue = false,
): Partial<WithoutSystemFields<Doc<'issues'>>> {
  const status: IssueStatus =
    kind === 'parent' ? (i % 5 === 0 ? 'done' : 'progress') : LEAF_STATUSES[i % 10]
  const owner = owners[i % owners.length]
  const reviewer = owners[(i + 1) % owners.length]
  const dated = overdue || i % 5 < 3
  const planned = i % 2 === 0
  const start = shift(DAY, 7 * ((i % 9) - 4))
  return {
    title: TITLE,
    status,
    assignee_id: owner.id,
    ...(status === 'review' && reviewer.id !== owner.id ? { reviewer_id: reviewer.id } : {}),
    paused:
      kind === 'parent'
        ? status !== 'done' && i % 4 === 1
        : (status === 'todo' || status === 'progress') && i % 12 === 1,
    ...(dated ? { due_date: shift(DAY, overdue ? -1 - (i % 60) : ((i * 37) % 181) - 60) } : {}),
    ...(planned && kind !== 'parent'
      ? {
          start_week: start,
          end_week: shift(start, 7 * (i % 3)),
          remaining_hours: status === 'done' ? 0 : ((i % 16) + 1) / 2,
          remaining_set_at: created,
        }
      : {}),
    ...(status === 'done' ? { done_at: created } : {}),
    created_at: created,
    status_at: created,
    updated_at: created,
  }
}

/** `n` tasks of the fixture mix in `project`: per ten, one parent, two
 * subtasks under parents of the same set, and seven plain tasks, created
 * at `created`, all due before DAY with `overdue`. */
export async function plantMix(
  t: T,
  project: Doc<'projects'>,
  n: number,
  owners: readonly Doc<'profiles'>[],
  created: string,
  overdue = false,
): Promise<Doc<'issues'>[]> {
  const parents = await plantTasks(t, project, n / 10, (i) =>
    mixOf(i, owners, 'parent', created, overdue),
  )
  const plain = await plantTasks(t, project, (7 * n) / 10, (i) =>
    mixOf(i, owners, 'plain', created, overdue),
  )
  const kids = await plantTasks(t, project, (2 * n) / 10, (i) => ({
    ...mixOf(i + 3, owners, 'subtask', created, overdue),
    parent_id: parents[Math.floor(i / 2)].id,
  }))
  return [...parents, ...plain, ...kids]
}

/** `n` seats of the organization, each a person with 40 plannable hours. */
export async function plantPeople(t: T, orgId: string, n: number): Promise<Doc<'profiles'>[]> {
  const out: Doc<'profiles'>[] = []
  for (let i = 0; i < n; i++)
    out.push(await plantSeat(t, { org_id: orgId, name: `Owner ${i}`, accepted_at: BEFORE_RULE }))
  return out
}

/* A row's name with its copy of the name key. */
const named = (name: string) => ({ name, name_key: nameKey(name) })

/** `tops` top-level projects of `orgId`, each with `subs` sub-projects
 * that track delay (or as many as `subs(i)` gives the top-level project
 * numbered `i`), and `me` in three teams that share the top-level projects
 * in turn, so `me` reads every sub-project through its project's share. */
export async function plantShared(
  t: T,
  orgId: string,
  lead: Doc<'profiles'>,
  me: Doc<'profiles'>,
  o: { tops: number; subs: number | ((top: number) => number) },
): Promise<{ tops: Doc<'projects'>[]; subs: Doc<'projects'>[] }> {
  const tops: Doc<'projects'>[] = []
  const planted: Doc<'projects'>[] = []
  for (let i = 0; i < o.tops; i++) {
    const top = await plantProject(t, {
      org_id: orgId,
      lead_id: lead.id,
      ...named(`Programme ${i}`),
    })
    tops.push(top)
    const subs = typeof o.subs === 'number' ? o.subs : o.subs(i)
    for (let k = 0; k < subs; k++)
      planted.push(
        await plantProject(t, {
          org_id: orgId,
          type: 'project',
          parent_id: top.id,
          ...named(`Workstream ${i}-${k}`),
          lead_id: lead.id,
          track_delay: true,
          archive_state: 'live',
        }),
      )
  }
  await t.run(async (ctx) => {
    const teams: { id: string; name: string }[] = []
    for (let i = 0; i < 3; i++) {
      const team = { id: uuid(), name: `Team ${i}` }
      teams.push(team)
      await ctx.db.insert('teams', {
        id: team.id,
        org_id: orgId,
        ...named(team.name),
        track_delay_default: true,
        created_at: BEFORE_RULE,
      })
      await ctx.db.insert('team_members', {
        team_id: team.id,
        profile_id: me.id,
        is_leader: false,
        name_key: nameKey(me.name),
      })
    }
    for (const [i, top] of tops.entries()) {
      const team = teams[i % teams.length] as { id: string; name: string }
      await ctx.db.insert('project_team_access', {
        project_id: top.id,
        team_id: team.id,
        level: 'user',
        name_key: nameKey(team.name),
      })
    }
  })
  return { tops, subs: planted }
}

/** What one read took, as Convex counts a transaction's reads. */
export type Took = { ranges: number; documents: number; mib: number }

/** `read`'s answer inside one transaction and what the transaction read,
 * as the real-limit tests record it. */
export async function measured<R>(
  t: T,
  read: (ctx: QueryCtx) => Promise<R>,
): Promise<{ answer: R; took: Took }> {
  return await t.run(async (ctx) => {
    const answer = await read(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      took: {
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
      },
    }
  })
}
