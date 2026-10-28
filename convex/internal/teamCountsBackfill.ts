/* One-time migration that counts every team's members (schema.ts
 * team_counts), which Settings > Teams, the team page and the REST and MCP
 * team summaries are to show. No reader uses the counts yet. Until a team
 * is counted it has no row, and a reader is to show its count as
 * unavailable (model/teamCounts.ts memberCount). Teams created since this
 * release start with a row, and every write keeps the rows that exist.
 *
 * A team's count runs in steps, each its own transaction. The first step
 * gives the team its row at zero with `through` below every membership.
 * Each step reads the team's memberships created after `through`
 * (team_members.by_team, in _creationTime order), adds those that count
 * (model/teamCounts.ts countingOrgOf: the profile exists in the team's
 * organization and is no guest, or its removal still counts it) and moves
 * `through` on. A write in between moves the count only for a membership at
 * or below `through`, and a new membership comes after every one counted,
 * so the count is exact however the memberships change while it runs. A
 * profile change that would move a membership's answer deletes the
 * membership in the same transaction. The last step unsets `through`. A
 * reader is to show no count while it is set.
 *
 * Read the dry run first. It writes nothing and reports, for every team,
 * the count a run would write (`to_count`), for a team counted already
 * whether its count matches its memberships (`differ`), and the teams with
 * a count left unfinished (`running_teams`), which it cannot check. It
 * lists a team whose row's revision writes kept moving while it counted as
 * unsettled, to check again with a later dry run (dryCount). With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/teamCountsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/teamCountsBackfill:run '{"dry_run": false}'
 * A call stops after RUN.ms, well inside Convex's action time limit, before
 * its next team, step or page, and then answers `done: false` with a
 * `cursor`, which can point inside a team's count. Call it again with the
 * same arguments and `"cursor"` set to it until `done` is true. Each call
 * reports the teams it went through. A dry run checks the time between
 * every two pages of a team's count too: a team whose count the deadline
 * cuts short is listed as unchecked (`unchecked_teams`), never as settled or
 * differing, and the next call goes on with the next team.
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). On the demo, whose stored key cannot run internal
 * functions, the private with-temp-deploy-key helper runs each command with a
 * short-lived key; `run`, an internal action, needs
 * deployment:functions:runInternalActions.
 *
 * A run counts the teams without a row or with a count left unfinished,
 * going on with that count where it stopped, and leaves the others as they
 * are. `"recount": true` counts every team again, to mend counts a dry run
 * lists as differing, and starts an unfinished count again from its start
 * unless the call goes on inside that team's count from its own cursor.
 * After the teams, a call goes through every team_counts row and deletes
 * the rows whose team is gone or belongs to another organization
 * (`orphans`), which a dry run counts without deleting. Only an earlier
 * release leaves such rows, or wrong counts: run back on a deployment after
 * this one, it deletes teams without their rows, moves no count, and leaves
 * a count it finds unfinished wrong below where it stopped. After such a
 * rollback, read a dry run, then run with `"recount": true` until `done`,
 * which mends them all. Every call that is no dry run adds one
 * platform_audit_log row (action 'team_counts_backfill', actor 'system')
 * with its totals and where it stopped, also when a step throws, with the
 * error. Running it again is safe. It writes no activity and changes
 * nothing a person sees. */
import { makeFunctionReference } from 'convex/server'
import { type Infer, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { audit as writeAudit } from '../model/admin'
import { countingOrgOf, teamCountRow } from '../model/teamCounts'

/** Memberships one step reads, and the most teams a dry run lists. Each
 * membership costs at most three index ranges (itself, its profile and a
 * removed profile's removal row), so a step reads at most 1,502, inside
 * Convex's 4,096. These rows are small: a profile holds a short name, an
 * email and ids, so a step reads well under 2 MiB. Tests lower them. */
export const COUNT_PAGE = { members: 500, listed: 100 }

/** Teams one page of a run reads, team_counts rows one orphan step reads,
 * and how long one call of run goes on before it answers where to go on
 * from. Tests lower them. */
export const RUN = { teams: 100, rows: 500, ms: 5 * 60_000 }

/** Below every _creationTime: a count that has read no membership. */
const START = Number.MIN_SAFE_INTEGER

/** One page of the team's memberships created after `after`: how many
 * count, and the _creationTime counted through, or null when no membership
 * is past `after`. Every membership with the page's last _creationTime is
 * in it, should two share one, as an import can leave. */
async function memberPage(
  ctx: QueryCtx,
  team: Doc<'teams'>,
  after: number,
): Promise<{ members: number; through: number } | null> {
  const part = await ctx.db
    .query('team_members')
    .withIndex('by_team', (q) => q.eq('team_id', team.id).gt('_creationTime', after))
    .take(COUNT_PAGE.members)
  const last = part.at(-1)?._creationTime
  if (last === undefined) return null
  const full = part.length === COUNT_PAGE.members
  const tail = full
    ? await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', team.id).eq('_creationTime', last))
        .collect()
    : []
  let members = 0
  for (const row of [...part.filter((row) => row._creationTime < last || !full), ...tail])
    if ((await countingOrgOf(ctx, row.profile_id)) === team.org_id) members++
  return { members, through: last }
}

/** One step of the team's count, in its own transaction. It starts the
 * count, counts one page of memberships and ends the count once no
 * membership is past where it counted. A count left unfinished goes on
 * where it stopped, and a team counted already is left alone, unless
 * `restart`, which counts it again from its start, as a recount does: an
 * earlier release run in between moves no count, so a count it left
 * unfinished can be wrong below where it stopped. Every write of the row
 * gives it a later revision. Answers the count once it is counted, null
 * while it counts, and 'skipped' for a team deleted meanwhile. */
export const step = internalMutation({
  args: { team_id: v.string(), restart: v.optional(v.boolean()) },
  handler: async (ctx, { team_id, restart = false }): Promise<number | 'skipped' | null> => {
    const team = await byId(ctx, 'teams', team_id)
    if (team === null) return 'skipped'
    let row = await teamCountRow(ctx, team.id)
    const fresh = { team_id: team.id, org_id: team.org_id, members: 0, through: START }
    if (row === null) {
      const _id = await ctx.db.insert('team_counts', { ...fresh, revision: 0 })
      row = (await ctx.db.get(_id)) as Doc<'team_counts'>
    } else if (restart || row.org_id !== team.org_id) {
      await ctx.db.replace(row._id, { ...fresh, revision: row.revision + 1 })
      row = (await ctx.db.get(row._id)) as Doc<'team_counts'>
    } else if (row.through === undefined) return row.members
    const revision = row.revision + 1
    const page = await memberPage(ctx, team, row.through ?? START)
    if (page === null) {
      await ctx.db.patch(row._id, { through: undefined, revision })
      return row.members
    }
    await ctx.db.patch(row._id, {
      members: row.members + page.members,
      through: page.through,
      revision,
    })
    return null
  },
})

/** A team as a run reads it: whether it has a row, its stored count as a
 * reader would show it, whether a count of it is unfinished, and the
 * revision of its row, which goes up with each write. */
type TeamState = {
  team_id: string
  org_id: string
  has_row: boolean
  stored: number | null
  counting: boolean
  revision: number | null
}

/** The team's state (TeamState). */
async function stateOf(ctx: QueryCtx, team: Doc<'teams'>): Promise<TeamState> {
  const row = await teamCountRow(ctx, team.id)
  const own = row !== null && row.org_id === team.org_id
  return {
    team_id: team.id,
    org_id: team.org_id,
    has_row: own,
    stored: own && row.through === undefined ? row.members : null,
    counting: own && row.through !== undefined,
    revision: own ? row.revision : null,
  }
}

/** A page of teams with their states. */
type TeamPage = { teams: TeamState[]; cursor: string; done: boolean }

/** One page of teams, by creation, with their states. */
export const teamPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<TeamPage> => {
    const page = await ctx.db.query('teams').paginate({ cursor, numItems: RUN.teams })
    const teams: TeamState[] = []
    for (const team of page.page) teams.push(await stateOf(ctx, team))
    return { teams, cursor: page.continueCursor, done: page.isDone }
  },
})

/** One team's state, as a dry run reads it after a count; null once the
 * team is gone. */
export const state = internalQuery({
  args: { team_id: v.string() },
  handler: async (ctx, { team_id }): Promise<TeamState | null> => {
    const team = await byId(ctx, 'teams', team_id)
    return team === null ? null : await stateOf(ctx, team)
  },
})

/** Counts, without writing, one page of the team's memberships created
 * after `after` (memberPage); null also for a team that is gone. */
export const check = internalQuery({
  args: { team_id: v.string(), after: v.number() },
  handler: async (ctx, { team_id, after }) => {
    const team = await byId(ctx, 'teams', team_id)
    return team === null ? null : await memberPage(ctx, team, after)
  },
})

/** One page of team_counts from `cursor`: how many of its rows name a team
 * that is gone or of another organization, and, unless `dry_run`, deletes
 * them. */
export const orphans = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { dry_run, cursor }) => {
    const page = await ctx.db.query('team_counts').paginate({ cursor, numItems: RUN.rows })
    let found = 0
    for (const row of page.page) {
      if ((await byId(ctx, 'teams', row.team_id))?.org_id === row.org_id) continue
      found++
      if (!dry_run) await ctx.db.delete(row._id)
    }
    return { found, cursor: page.continueCursor, done: page.isDone }
  },
})

/** Where a call of run goes on: a page of teams from `cursor`, at team
 * `team` when it stopped before or inside it (`started`), then the
 * team_counts rows. */
const vPosition = v.union(
  v.object({
    table: v.literal('teams'),
    cursor: v.union(v.string(), v.null()),
    team: v.optional(v.object({ id: v.string(), started: v.optional(v.literal(true)) })),
  }),
  v.object({ table: v.literal('team_counts'), cursor: v.union(v.string(), v.null()) }),
)
type Position = Infer<typeof vPosition>

/** Records a call that may have written, with its totals, where it
 * stopped (null once done) and the error that ended it, if any. */
export const audit = internalMutation({
  args: {
    counted: v.number(),
    members: v.number(),
    orphans: v.number(),
    cursor: v.union(vPosition, v.null()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, detail) => {
    await writeAudit(ctx, { actor_email: 'system', action: 'team_counts_backfill', detail })
    return null
  },
})

const teamPageRef = makeFunctionReference<'query', { cursor: string | null }, TeamPage>(
  'internal/teamCountsBackfill:teamPage',
)
const stateRef = makeFunctionReference<'query', { team_id: string }, TeamState | null>(
  'internal/teamCountsBackfill:state',
)
const checkRef = makeFunctionReference<
  'query',
  { team_id: string; after: number },
  { members: number; through: number } | null
>('internal/teamCountsBackfill:check')
const stepRef = makeFunctionReference<
  'mutation',
  { team_id: string; restart?: boolean },
  number | 'skipped' | null
>('internal/teamCountsBackfill:step')
const orphansRef = makeFunctionReference<
  'mutation',
  { dry_run: boolean; cursor: string | null },
  { found: number; cursor: string; done: boolean }
>('internal/teamCountsBackfill:orphans')
const auditRef = makeFunctionReference<
  'mutation',
  {
    counted: number
    members: number
    orphans: number
    cursor: Position | null
    error?: string
  },
  null
>('internal/teamCountsBackfill:audit')

/** How many times a dry run counts a team whose state a write moves while
 * it counts. */
const DRY_TRIES = 3

/** Counts the team's members without writing, page by page in queries of
 * their own, then reads its state again. Writes can land between those
 * queries, so the count matches a state only when no write moved it across
 * the count, which its row's revision shows even for a write another undid;
 * it counts again while one did, at most DRY_TRIES times, and no more once
 * `late` answers true. Answers the count, the state read after it, null
 * once the team is gone, and whether nothing moved (`settled`). It asks
 * `late` between every two pages, and answers null when that says true in
 * the middle of the count: the team is then unchecked, as no partial count
 * says anything. */
export async function dryCount(
  ctx: Pick<ActionCtx, 'runQuery'>,
  before: TeamState,
  late: () => boolean = () => false,
): Promise<{ members: number; state: TeamState | null; settled: boolean } | null> {
  let state = before
  for (let tries = 1; ; tries++) {
    let members = 0
    let after = START
    for (;;) {
      const got = await ctx.runQuery(checkRef, { team_id: state.team_id, after })
      if (got === null) break
      members += got.members
      after = got.through
      if (late()) return null
    }
    const now = await ctx.runQuery(stateRef, { team_id: state.team_id })
    // stateOf builds both, so their keys come in the same order
    const settled = JSON.stringify(now) === JSON.stringify(state)
    if (settled || tries === DRY_TRIES || now === null || late())
      return { members, state: now, settled }
    state = now
  }
}

/** Counts every team not counted yet or with a count left unfinished, or
 * every one with `recount`, from `cursor` on, then deletes the orphan rows,
 * and answers how many teams it counted with their members. A recount
 * starts again from its start a count it does not resume from its own
 * cursor. Past RUN.ms it stops before the next team, step or page, after
 * doing at least one, and answers the `cursor` to go on from, else `done`.
 * A dry run writes nothing. It counts each team's members (dryCount),
 * answers the same totals for those it would count, lists up to
 * COUNT_PAGE.listed of them, lists the teams counted already whose counts
 * their memberships do not give (`differ`, `differing` in all), the teams
 * whose state writes kept moving (`unsettled_teams`, `unsettled` in all)
 * those with a count left unfinished (`running_teams`, `running` in all),
 * which it cannot check and a recount starts again, and those whose count
 * the deadline cut short (`unchecked_teams`, `unchecked` in all), for a
 * later dry run to check, and counts the orphan rows. A call that is no dry
 * run ends with its audit row, also when a step throws. */
export const run = internalAction({
  args: { dry_run: v.boolean(), recount: v.optional(v.boolean()), cursor: v.optional(vPosition) },
  handler: async (ctx, { dry_run, recount = false, cursor: from }) => {
    const until = Date.now() + RUN.ms
    const totals = { teams: 0, counted: 0, members: 0, orphans: 0 }
    const toCount: { team_id: string; org_id: string; members: number }[] = []
    const differ: { team_id: string; org_id: string; members: number; stored: number }[] = []
    const unsettledTeams: string[] = []
    const runningTeams: string[] = []
    const uncheckedTeams: string[] = []
    let differing = 0
    let unsettled = 0
    let running = 0
    let unchecked = 0
    let at: Position = from ?? { table: 'teams', cursor: null }
    let done = false
    const pastDeadline = () => Date.now() >= until
    // whether this call did anything yet, so it always gets somewhere
    let worked = false
    const late = () => worked && pastDeadline()
    // the team the call works on, inside its count once `started`, for the
    // audit row of a call a step ends with an error
    let here: { id: string; started?: true } | undefined
    /** A dry run of one team. */
    const dryTeam = async (team: TeamState): Promise<void> => {
      const counted = await dryCount(ctx, team, pastDeadline)
      // one whose count the deadline cut short, and the call goes on
      if (counted === null) {
        if (unchecked++ < COUNT_PAGE.listed) uncheckedTeams.push(team.team_id)
        return
      }
      const { members, state, settled } = counted
      if (state === null) return
      const report = { team_id: team.team_id, org_id: team.org_id, members }
      if (state.counting) {
        if (running++ < COUNT_PAGE.listed) runningTeams.push(team.team_id)
      } else if (!settled) {
        if (unsettled++ < COUNT_PAGE.listed) unsettledTeams.push(team.team_id)
      } else if (state.stored !== null && state.stored !== members) {
        if (differing++ < COUNT_PAGE.listed) differ.push({ ...report, stored: state.stored })
      }
      if (state.has_row && !state.counting && !recount) return
      totals.counted++
      totals.members += members
      if (toCount.length < COUNT_PAGE.listed) toCount.push(report)
    }
    /** A run of one team, inside its own count when `started`. Answers
     * false when time ran out inside it. */
    const countTeam = async (team: TeamState, started: boolean): Promise<boolean> => {
      if (!started && !recount && team.has_row && !team.counting) return true
      let restart = recount && !started
      let got: number | 'skipped' | null = null
      while (got === null) {
        got = await ctx.runMutation(stepRef, { team_id: team.team_id, restart })
        worked = true
        restart = false
        here = { id: team.team_id, started: true }
        if (got === null && late()) return false
      }
      if (got !== 'skipped') {
        totals.counted++
        totals.members += got
      }
      return true
    }
    let error: string | undefined
    try {
      for (;;) {
        if (at.table === 'teams') {
          const page: TeamPage = await ctx.runQuery(teamPageRef, { cursor: at.cursor })
          const resume = at.team
          const ids = page.teams.map((team) => team.team_id)
          const from = resume === undefined ? -1 : ids.indexOf(resume.id)
          let stopped: { id: string; started?: true } | undefined
          for (const team of page.teams.slice(Math.max(0, from))) {
            if (late()) {
              stopped = { id: team.team_id }
              break
            }
            const started = resume?.id === team.team_id && resume.started === true
            here = started ? { id: team.team_id, started: true } : { id: team.team_id }
            if (dry_run) await dryTeam(team)
            else if (!(await countTeam(team, started)))
              stopped = { id: team.team_id, started: true }
            worked = true
            here = undefined
            if (stopped !== undefined) break
            totals.teams++
          }
          if (stopped !== undefined) {
            at = { table: 'teams', cursor: at.cursor, team: stopped }
            break
          }
          at = page.done
            ? { table: 'team_counts', cursor: null }
            : { table: 'teams', cursor: page.cursor }
        } else {
          const got: { found: number; cursor: string; done: boolean } = await ctx.runMutation(
            orphansRef,
            { dry_run, cursor: at.cursor },
          )
          worked = true
          totals.orphans += got.found
          if (got.done) {
            done = true
            break
          }
          at = { table: 'team_counts', cursor: got.cursor }
        }
        if (late()) break
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (at.table === 'teams' && here !== undefined) at = { ...at, team: here }
      throw e
    } finally {
      if (!dry_run)
        await ctx.runMutation(auditRef, {
          counted: totals.counted,
          members: totals.members,
          orphans: totals.orphans,
          cursor: done ? null : at,
          ...(error === undefined ? {} : { error }),
        })
    }
    return {
      dry_run,
      ...totals,
      differing,
      to_count: toCount,
      differ,
      unsettled,
      unsettled_teams: unsettledTeams,
      running,
      running_teams: runningTeams,
      unchecked,
      unchecked_teams: uncheckedTeams,
      done,
      cursor: done ? null : at,
    }
  },
})
