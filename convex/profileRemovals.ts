/* Background cleanup after a profile removal. model/cascade.ts removeProfile
 * deletes the profile and ends its access in one transaction. It also
 * clears the profile from project leads, the activity feed and as many open
 * tasks as one budget allows. It then inserts a profile_removals row and
 * schedules `step`. Each step clears a bounded part of the remaining rows
 * that name the removed id, phase by phase (REMOVAL_PHASES), and
 * schedules the next step until nothing names the id. Then it deletes the
 * row, which also frees the id for profiles.create.
 *
 * Every phase reads the same index prefix again with take(n). Clearing a
 * row moves it out of that range, so no cursor is kept, and a repeated step
 * can neither skip a row nor clear one twice. A step stops when it has
 * cleared REMOVAL_BUDGET.rows rows or about REMOVAL_BUDGET.bytes of
 * documents, but always clears at least one row. The byte budget matters
 * because comment bodies and task descriptions are large. They hold up to
 * TEXT_MAX characters (lib/textLimits.ts, about 60 KB stored), and rows
 * saved before that cap can be near the 1 MiB document limit. The finish
 * phase checks every range once more and starts again from the first phase
 * if a row is left.
 *
 * Convex drops the calls a failed mutation scheduled, so a step that fails
 * leaves the row at its last committed phase. `recover` runs every minute
 * (crons.ts) and restarts a row whose last step committed more than
 * STALLED_MS ago and that has no step waiting or running. The job is keyed
 * by profile id, not organization, so it also finishes after deleteOrgDeep
 * removed the organization. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { byId, LARGE_ROWS_PER_READ } from './lib/db'
import { REMOVAL_PHASES, type RemovalPhase } from './lib/enums'
import {
  budgetSpent,
  clearHolder,
  heldTasks,
  pendingRemoval,
  REMOVAL_BUDGET,
  type RemovalBudget,
  sweep,
  TASK_HOLDERS,
} from './model/cascade'
import { estimateDocumentBytes } from './model/demoMetrics'

/** A row whose last step committed longer ago than this is restarted. */
export const STALLED_MS = 60_000

const RECOVER_BATCH = 32
/* The most stalled rows one recovery looks at, oldest progress first. Rows
 * whose step still waits are skipped without counting toward RECOVER_BATCH,
 * so waiting rows hide a failed one only while RECOVER_SCAN or more of them
 * are older. Such a backlog only delays its restart, because each waiting
 * step that runs moves its row's progress_at past the failed row's. */
const RECOVER_SCAN = 512

const stepRef = makeFunctionReference<'mutation', { profile_id: string }, null>(
  'profileRemovals:step',
)

/** One index range whose rows still name the removed profile. */
type Edge = {
  /** Clears rows until the range is empty (true) or the budget is spent. */
  sweep: (
    ctx: MutationCtx,
    profileId: string,
    budget: RemovalBudget,
    now: string,
  ) => Promise<boolean>
  /** Whether any row is left in the range. */
  remains: (ctx: MutationCtx, profileId: string) => Promise<boolean>
}

/** An Edge over `range`, a new query for each read, whose rows `clear`
 * patches or deletes. `large` marks rows without a size cap. */
function edge<Row>(a: {
  range: (
    ctx: MutationCtx,
    profileId: string,
  ) => { take(n: number): Promise<Row[]>; first(): Promise<Row | null> }
  clear: (ctx: MutationCtx, row: Row, now: string) => Promise<void>
  large?: boolean
}): Edge {
  return {
    sweep: (ctx, profileId, budget, now) =>
      sweep(
        budget,
        (n) => a.range(ctx, profileId).take(n),
        (row) => a.clear(ctx, row, now),
        a.large ? LARGE_ROWS_PER_READ : Number.POSITIVE_INFINITY,
      ),
    remains: async (ctx, profileId) => (await a.range(ctx, profileId).first()) !== null,
  }
}

/** The OAuth connections of `profileId`, as a new query for each read. */
const connectionsOf = (ctx: MutationCtx, profileId: string) =>
  ctx.db.query('oauth_connections').withIndex('by_profile', (q) => q.eq('profile_id', profileId))

/* A connection is deleted after its replay hashes, which grow by one row per
 * refresh. removeProfile revoked only the newest REVOKE_AT_ONCE connections,
 * so older ones are deleted here unrevoked, which is safe because every
 * OAuth path already refuses once the profile row is gone. */
const oauthEdge: Edge = {
  sweep: async (ctx, profileId, budget) => {
    while (!budgetSpent(budget)) {
      const connection = await connectionsOf(ctx, profileId).first()
      if (connection === null) return true
      const usesCleared = await sweep(
        budget,
        (n) =>
          ctx.db
            .query('oauth_credential_uses')
            .withIndex('by_connection', (q) => q.eq('connection_id', connection.id))
            .take(n),
        (use) => ctx.db.delete(use._id),
        Number.POSITIVE_INFINITY,
      )
      if (!usesCleared) return false
      await ctx.db.delete(connection._id)
      budget.rows -= 1
      budget.bytes -= estimateDocumentBytes(connection)
    }
    return false
  },
  remains: async (ctx, profileId) => (await connectionsOf(ctx, profileId).first()) !== null,
}

/* The ranges each phase clears, in order. The SET NULLs keep their rows;
 * the inbox, subscriptions and connections are deleted. */
const PHASE_EDGES: Record<Exclude<RemovalPhase, 'finish'>, Edge[]> = {
  // open tasks the removal transaction left, archived tasks, and any task
  // restored before this step reached it
  tasks: TASK_HOLDERS.map((holder) =>
    edge({
      range: (ctx, profileId) => heldTasks(ctx, holder, profileId, false),
      clear: (ctx, task: Doc<'issues'>, now) => clearHolder(ctx, task, holder, now),
      large: true,
    }),
  ),
  comments: [
    edge({
      range: (ctx, profileId) =>
        ctx.db.query('comments').withIndex('by_author', (q) => q.eq('author', profileId)),
      clear: (ctx, comment) => ctx.db.patch(comment._id, { author: undefined }),
      large: true,
    }),
    edge({
      range: (ctx, profileId) =>
        ctx.db.query('comments').withIndex('by_edited_by', (q) => q.eq('edited_by', profileId)),
      clear: (ctx, comment) => ctx.db.patch(comment._id, { edited_by: undefined }),
      large: true,
    }),
  ],
  sent_messages: [
    edge({
      range: (ctx, profileId) =>
        ctx.db.query('messages').withIndex('by_actor', (q) => q.eq('actor_id', profileId)),
      clear: (ctx, message) => ctx.db.patch(message._id, { actor_id: undefined }),
    }),
  ],
  inbox: [
    edge({
      range: (ctx, profileId) =>
        ctx.db.query('messages').withIndex('by_recipient', (q) => q.eq('recipient_id', profileId)),
      clear: (ctx, message) => ctx.db.delete(message._id),
    }),
  ],
  subscriptions: [
    edge({
      range: (ctx, profileId) =>
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_profile_task_archived', (q) => q.eq('profile_id', profileId)),
      clear: (ctx, subscription) => ctx.db.delete(subscription._id),
    }),
  ],
  attachments: [
    edge({
      range: (ctx, profileId) =>
        ctx.db
          .query('issue_attachments')
          .withIndex('by_uploaded_by', (q) => q.eq('uploaded_by', profileId)),
      clear: (ctx, attachment) => ctx.db.patch(attachment._id, { uploaded_by: undefined }),
      large: true, // file names stored before attachFileCore capped them have no size cap
    }),
  ],
  agent_keys: [
    edge({
      range: (ctx, profileId) =>
        ctx.db.query('agent_keys').withIndex('by_created_by', (q) => q.eq('created_by', profileId)),
      clear: (ctx, key) => ctx.db.patch(key._id, { created_by: undefined }),
      large: true, // key names stored before NAME_MAX capped them can be large
    }),
  ],
  oauth: [oauthEdge],
}

/** The first phase whose ranges still hold a row, or null when none does. */
async function phaseWithRows(
  ctx: MutationCtx,
  profileId: string,
): Promise<Exclude<RemovalPhase, 'finish'> | null> {
  for (const phase of REMOVAL_PHASES) {
    if (phase === 'finish') continue
    for (const e of PHASE_EDGES[phase]) if (await e.remains(ctx, profileId)) return phase
  }
  return null
}

/** One bounded step of a removal. Safe to run twice or after the row is
 * gone. A live profile with the id ends the job with an error log. Only a
 * fixture or demo re-seed creates one (profiles.create refuses a pending
 * id), and the rows left can no longer be told apart from the new
 * profile's. */
export const step = internalMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }): Promise<null> => {
    const job = await pendingRemoval(ctx, profile_id)
    if (job === null) return null
    if ((await byId(ctx, 'profiles', profile_id)) !== null) {
      console.error('Profile removal stopped because a live profile has its id', {
        profile_id,
        phase: job.phase,
      })
      await ctx.db.delete(job._id)
      return null
    }
    // Archived tasks are stamped with the step's own time, so a task
    // restored after the removal never moves back in time.
    const now = new Date().toISOString()
    const budget: RemovalBudget = { ...REMOVAL_BUDGET }
    let phase: RemovalPhase = job.phase
    for (;;) {
      if (phase === 'finish') {
        const left = await phaseWithRows(ctx, profile_id)
        if (left === null) {
          await ctx.db.delete(job._id)
          console.info('Profile removal completed', {
            profile_id,
            lag_ms: Math.max(0, Date.now() - Date.parse(job.removed_at)),
          })
          return null
        }
        // A row named the profile after its phase had passed.
        console.warn('Profile removal starts again', { profile_id, phase: left })
        phase = REMOVAL_PHASES[0]
        break
      }
      let done = true
      for (const e of PHASE_EDGES[phase]) {
        if (!(await e.sweep(ctx, profile_id, budget, now))) {
          done = false
          break
        }
      }
      if (!done) break
      phase = REMOVAL_PHASES[REMOVAL_PHASES.indexOf(phase) + 1]
    }
    const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { profile_id })
    await ctx.db.patch(job._id, { phase, progress_at: now, scheduled_id })
    return null
  },
})

/** Restarts removals whose last step committed more than STALLED_MS ago,
 * for example after a step failed. A row whose next step still waits or
 * runs is left alone, because a second chain would only repeat its work. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const stalled = await ctx.db
      .query('profile_removals')
      .withIndex('by_progress', (q) =>
        q.lt('progress_at', new Date(now - STALLED_MS).toISOString()),
      )
      .take(RECOVER_SCAN)
    let restarted = 0
    for (const job of stalled) {
      if (restarted === RECOVER_BATCH) break
      const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
      if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
      restarted += 1
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { profile_id: job.profile_id })
      await ctx.db.patch(job._id, { progress_at: new Date(now).toISOString(), scheduled_id })
      console.warn('Profile removal resumed', {
        profile_id: job.profile_id,
        phase: job.phase,
        stalled_ms: now - Date.parse(job.progress_at),
      })
    }
    return null
  },
})
