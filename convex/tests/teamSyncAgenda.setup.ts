/* Helpers of Team sync's agenda suites (convex/tests/teamSyncAgenda.test.ts,
 * src/store/teamSyncParity.test.ts): the query as a caller asks it, the
 * read inside one transaction with what it read, the client's clock on UTC
 * weeks, shares and stamps planted raw, and open tasks in bulk. Named
 * *.setup.ts, as two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import type { WithoutSystemFields } from 'convex/server'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { IssueStatus } from '../lib/enums'
import { MIB } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { type AgendaAnswer, type AgendaScope, readAgenda } from '../lib/teamSyncAgenda'
import { plantTasks, type ReadFigures } from './board.setup'
import { as, NOW, type T, uuid } from './helpers.setup'
import { dayPlus, ordinary } from './roadmap.setup'

const DAY_MS = 86_400_000

/** The client's clock on day `day` of the week that begins on `week`, both
 * YYYY-MM-DD, on UTC weeks: the arguments lib/viewLoads.ts clockOf takes. */
export const clockOn = (day: string, week: string) => {
  const start = Date.parse(`${week}T00:00:00.000Z`)
  return {
    day,
    week,
    week_starts: Array.from({ length: 53 }, (_, i) => start - (52 - i) * 7 * DAY_MS),
    week_end: start + 7 * DAY_MS,
  }
}

/** A client clock (clockOn). */
export type AgendaClock = ReturnType<typeof clockOn>

/** The Monday of helpers.setup.ts NOW's week, 2025-12-29. */
export const NOW_WEEK = '2025-12-29'

/** NOW's day, Thursday 1 January 2026, in its Monday week: the fixtures'
 * dates sit around it. A walker without a stamp reads Done since from
 * Wednesday's midnight, 2025-12-31T00:00Z, on these UTC weeks. */
export const NOW_CLOCK = clockOn(NOW.slice(0, 10), NOW_WEEK)

/** teamSync.agenda for `profile`'s login in its organization. */
export const agendaFor = (
  t: T,
  profile: Doc<'profiles'>,
  scope: AgendaScope,
  clock: AgendaClock = NOW_CLOCK,
  orgId: string = profile.org_id,
): Promise<AgendaAnswer> =>
  as(t, profile).query(api.teamSync.agenda, { org_id: orgId, scope, ...clock })

/* What the transaction of `ctx` read so far, as Convex counts it. */
export async function figures(ctx: Pick<QueryCtx, 'meta'>): Promise<ReadFigures> {
  const m = await ctx.meta.getTransactionMetrics()
  return {
    mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
    documents: m.documentsRead.used,
    ranges: m.databaseQueries.used,
  }
}

/** The agenda for `profile`, read in one t.run as the query reads it, with
 * what it read. */
export const agendaRead = (
  t: T,
  profile: Doc<'profiles'>,
  scope: AgendaScope,
  clock: AgendaClock = NOW_CLOCK,
): Promise<{ answer: AgendaAnswer; read: ReadFigures }> =>
  t.run(async (ctx) => {
    const answer = await readAgenda(ctx, new Map([[profile.org_id, profile]]), {
      org_id: profile.org_id,
      scope,
      ...clock,
    })
    return { answer, read: await figures(ctx) }
  })

/** The ok answer of `answer`, or a throw naming its state. */
export function okOf(answer: AgendaAnswer): Extract<AgendaAnswer, { state: 'ok' }> {
  if (answer.state !== 'ok') throw new Error(`the agenda answered ${JSON.stringify(answer)}`)
  return answer
}

/** A team of organization `orgId`, with `members` and a share of each of
 * `projects` at `level`, planted raw. */
export async function plantTeam(
  t: T,
  orgId: string,
  name: string,
  members: readonly Doc<'profiles'>[],
  projects: readonly Doc<'projects'>[],
  level: 'viewer' | 'user' = 'user',
): Promise<string> {
  const id = uuid()
  await t.run(async (ctx) => {
    await ctx.db.insert('teams', {
      id,
      org_id: orgId,
      name,
      name_key: nameKey(name),
      track_delay_default: true,
      created_at: NOW,
    })
    for (const p of members)
      await ctx.db.insert('team_members', {
        team_id: id,
        profile_id: p.id,
        is_leader: false,
        name_key: nameKey(p.name),
      })
    for (const p of projects)
      await ctx.db.insert('project_team_access', {
        project_id: p.id,
        team_id: id,
        level,
        name_key: nameKey(name),
      })
  })
  return id
}

/** Gives `profile` the sync stamp `stamp`, planted raw. */
export const plantStamp = (
  t: T,
  profile: Doc<'profiles'>,
  stamp: { at: string; since?: string },
): Promise<unknown> =>
  t.run((ctx) =>
    ctx.db.insert('sync_stamps', { org_id: profile.org_id, profile_id: profile.id, ...stamp }),
  )

/** The open statuses a fixture's open tasks cycle through, one in ten
 * Backlog, as the Roadmap suite's. */
const OPEN: readonly IssueStatus[] = [
  'todo',
  'progress',
  'todo',
  'review',
  'todo',
  'progress',
  'todo',
  'backlog',
  'todo',
  'progress',
]

/** An open fixture task `i` with ordinary text, three in five scheduled
 * around NOW's week, half of those with remaining hours, and one in three
 * due in the weeks around NOW, owned by `owners` in turn, one place later
 * every ten tasks, so each owns tasks in every status and is a walker. Each
 * has an assignee, so none is one Needs an owner lists. */
export function openTask(
  i: number,
  owners: readonly Doc<'profiles'>[],
): Partial<WithoutSystemFields<Doc<'issues'>>> & { text?: string } {
  const status = OPEN[i % OPEN.length]
  const start = dayPlus(NOW_WEEK, 7 * ((i % 12) - 6))
  const turn = i + Math.floor(i / 10)
  const owner = owners[turn % owners.length]
  const reviewer = owners[(turn + 1) % owners.length]
  const due = dayPlus(NOW_WEEK, 7 * ((i % 9) - 3) + 4)
  return {
    ...ordinary(i),
    status,
    ...(owner === undefined ? {} : { assignee_id: owner.id }),
    ...(status === 'review' && reviewer !== undefined && reviewer.id !== owner?.id
      ? { reviewer_id: reviewer.id }
      : {}),
    ...(i % 5 < 3 ? { start_week: start, end_week: dayPlus(start, 7 * (i % 3)) } : {}),
    ...(i % 5 < 3 && i % 2 === 0 ? { remaining_hours: (i % 16) + 1 } : {}),
    ...(i % 3 === 0 ? { due_date: due } : {}),
  }
}

/** `n` open tasks in `project` owned in turn by `owners`: per ten, one
 * parent, two subtasks of the set's parents and seven plain tasks. */
export async function plantOpen(
  t: T,
  project: Doc<'projects'>,
  n: number,
  owners: readonly Doc<'profiles'>[],
  from = 0,
): Promise<Doc<'issues'>[]> {
  const parents = await plantTasks(t, project, Math.round(n / 10), (i) =>
    openTask(from + i, owners),
  )
  const plain = await plantTasks(t, project, n - 3 * parents.length, (i) =>
    openTask(from + 1000 + i, owners),
  )
  const kids = await plantTasks(t, project, 2 * parents.length, (i) => ({
    ...openTask(from + 2000 + i, owners),
    parent_id: parents[Math.floor(i / 2)].id,
  }))
  return [...parents, ...plain, ...kids]
}

/** `n` Done tasks not yet archived in `project`, owned in turn by `owners`,
 * Done in the `days` days before NOW, each since the previous working
 * day's midnight with `days` 1. */
export const plantDone = (
  t: T,
  project: Doc<'projects'>,
  n: number,
  owners: readonly Doc<'profiles'>[],
  days = 1,
): Promise<Doc<'issues'>[]> =>
  plantTasks(t, project, n, (i) => ({
    ...ordinary(500 + i),
    status: 'done',
    assignee_id: owners[i % owners.length]?.id,
    done_at: new Date(Date.parse(NOW) - 1 - ((i * 3_600_000) % (days * DAY_MS))).toISOString(),
  }))

/** Blocks links from `sources` to `targets`, one each in turn, planted raw. */
export async function plantBlocks(
  t: T,
  pairs: readonly [source: Doc<'issues'>, target: Doc<'issues'>][],
  type: 'blocks' | 'relates' = 'blocks',
): Promise<void> {
  await t.run(async (ctx) => {
    for (const [k, [source, target]] of pairs.entries()) {
      const [a, b] = [source.id, target.id].sort()
      await ctx.db.insert('issue_links', {
        org_id: source.org_id,
        id: uuid(),
        source_id: source.id,
        target_id: target.id,
        type,
        pair_key: `${a}:${b}`,
        created_at: new Date(Date.parse(NOW) + k * 1000).toISOString(),
        task_key: source.window_key,
      })
    }
  })
}
