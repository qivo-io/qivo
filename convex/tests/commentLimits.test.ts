/* The comment cap and the posting rate (model/commentLimits.ts).
 *
 *   1. The cap: a task takes its 1,000th comment and refuses the next on
 *      every path, a task that held more keeps them and takes none until
 *      deletes bring it under, a delete frees one slot and a refused or
 *      repeated one none, and an archive with a reason at the cap is
 *      refused whole while one without a reason goes through.
 *   2. The rate: 10 posts by one author on one task in any 60 seconds, the
 *      11th refused with the wait until the oldest is a minute old, no post
 *      given back by a delete, one allowance per author and task shared by
 *      the app, REST and MCP, archive reasons included.
 *   3. Counting: a task not counted yet is counted by its first post, a
 *      thread too long for that is refused for now, a count is exact
 *      through posts and deletes while it runs and over comments that share
 *      a _creationTime, and a restore, the recovery and the sweep do their
 *      parts.
 *   4. Deleted items keep a count through a move and a restore, and a purge
 *      deletes it with the task.
 *   5. The backfill: a dry run writes nothing and reports, a run counts and
 *      goes on from its cursor, and a recount mends a count.
 *   6. Over HTTP: REST answers the cap 400, the rate 429 and the count 503,
 *      the last two with Retry-After. */
/// <reference types="vite/client" />

import { type FunctionReference, type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError, getDocumentSize } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { RECOVER } from '../commentLimits'
import { ROW_PAGE, RUN, rowsAfter, TASK_PAGE } from '../internal/commentCountsBackfill'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { COMMENT_RATE, COMMENTS_COUNTING, LIMITS, tooManyComments } from '../lib/limits'
import { sha256hex } from '../machine/auth'
import { runEntry } from '../machine/registry'
import {
  COUNT_BUDGET,
  START as COUNT_START,
  countPage,
  countRow,
  SWEEP_BATCH,
  tallyComments,
} from '../model/commentLimits'
import { STORED_ROW_MAX_BYTES, TRASH_BUDGET } from '../model/deletedItems'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import {
  deleteProject,
  deleteTask,
  installTrashTimers,
  itemFor,
  runSteps,
  START,
} from './trash.setup'

installTrashTimers()

const DEFAULTS = {
  post: { ...COUNT_BUDGET.post },
  step: { ...COUNT_BUDGET.step },
  page: { ...TASK_PAGE },
  rows: { ...ROW_PAGE },
  run: { ...RUN },
  recover: { ...RECOVER },
}
afterEach(() => {
  Object.assign(COUNT_BUDGET.post, DEFAULTS.post)
  Object.assign(COUNT_BUDGET.step, DEFAULTS.step)
  Object.assign(TASK_PAGE, DEFAULTS.page)
  Object.assign(ROW_PAGE, DEFAULTS.rows)
  Object.assign(RUN, DEFAULTS.run)
  Object.assign(RECOVER, DEFAULTS.recover)
})

type Fx = OrgFixture & { t: T; task: Doc<'issues'> }

/** What one call of the comment count backfill answers. */
type RunAnswer = FunctionReturnType<typeof internal.internal.commentCountsBackfill.run>

/* A task `f.user` creates in the app, so it is counted from its start, in
 * FW unless `o` names another project, with the id `o.id` when given. */
async function createTask(
  t: T,
  f: OrgFixture,
  title = 'Thread',
  o: { project_id?: string; id?: string; parent_id?: string } = {},
): Promise<Doc<'issues'>> {
  const id = o.id ?? uuid()
  await as(t, f.user).mutation(api.issues.create, {
    org_id: f.org.id,
    id,
    project_id: o.project_id ?? f.sub.id,
    title,
    ...(o.parent_id === undefined ? {} : { parent_id: o.parent_id }),
  })
  return (await t.run((ctx) => byId(ctx, 'issues', id))) as Doc<'issues'>
}

/* withOrg, with the agent holding Edit on TBED and a task in FW. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  return { t, ...f, task: await createTask(t, f) }
}

/* `n` comments by the guest on `task`, written as the Northstar seed writes
 * them, so they spend no posting rate. With `counted` they also move the
 * task's count, as the seed does; without, the task stays as a release
 * before counts left it. */
async function plantComments(
  fx: Fx,
  n: number,
  o: { task?: Doc<'issues'>; counted?: boolean; body?: string } = {},
): Promise<Doc<'comments'>[]> {
  const task = o.task ?? fx.task
  return await fx.t.run(async (ctx) => {
    const rows: Doc<'comments'>[] = []
    for (let i = 0; i < n; i++) {
      const _id = await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        author: fx.guest.id,
        body: o.body ?? `#${i}`,
        created_at: NOW,
      })
      rows.push((await ctx.db.get(_id)) as Doc<'comments'>)
    }
    if (o.counted)
      await tallyComments(
        ctx,
        rows.map((row) => [row, 1] as const),
      )
    return rows
  })
}

const counter = (t: T, issueId: string) => t.run((ctx) => countRow(ctx, issueId))
const countOf = async (t: T, issueId: string) => (await counter(t, issueId))?.count
/* The task's count and whether a count of it is still under way. */
const stateOf = async (t: T, issueId: string) => {
  const row = await counter(t, issueId)
  return row === null ? null : { count: row.count, counting: row.counted !== undefined }
}
const commentsOn = (t: T, issueId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
      .collect(),
  )
const rateOf = (t: T, author: string, issueId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('comment_rates')
      .withIndex('by_author_issue', (q) => q.eq('author', author).eq('issue_id', issueId))
      .unique(),
  )

const appPost = (fx: Fx, who = fx.user, task = fx.task) =>
  as(fx.t, who).mutation(api.comments.create, {
    org_id: fx.org.id,
    id: uuid(),
    issue_id: task.id,
    body: 'A note',
  })
const restPost = (fx: Fx, who = fx.agent, task = fx.task) =>
  fx.t.mutation(internal.machine.rest.addComment, {
    callerId: who.id,
    access: 'write',
    ref: `QN-${task.num}`,
    body: JSON.stringify({ body: 'Through REST' }),
  })
const mcpPost = (fx: Fx, who = fx.agent, task = fx.task) =>
  fx.t.mutation(internal.machine.mcp.addComment, {
    callerId: who.id,
    access: 'write',
    ref: `QN-${task.num}`,
    body: 'Through MCP',
  })
const appDelete = (fx: Fx, who: Doc<'profiles'>, comment: Doc<'comments'>) =>
  as(fx.t, who).mutation(api.comments.remove, { org_id: fx.org.id, id: comment.id })

const appArchive = (fx: Fx, reason?: string, task = fx.task) =>
  as(fx.t, fx.user).mutation(api.issues.archive, {
    org_id: fx.org.id,
    id: task.id,
    ...(reason === undefined ? {} : { reason }),
  })
const restArchive = (fx: Fx, reason?: string) =>
  fx.t.mutation(internal.machine.rest.updateIssue, {
    callerId: fx.agent.id,
    access: 'write',
    keyName: 'drive',
    ref: `QN-${fx.task.num}`,
    body: JSON.stringify({
      archived: true,
      ...(reason === undefined ? {} : { archive_reason: reason }),
    }),
  })
const mcpArchive = (fx: Fx, reason?: string) =>
  fx.t.mutation(internal.machine.mcp.updateIssue, {
    callerId: fx.agent.id,
    access: 'write',
    ref: `QN-${fx.task.num}`,
    archived: true,
    ...(reason === undefined ? {} : { archive_reason: reason }),
  })
const unarchive = (fx: Fx) =>
  as(fx.t, fx.user).mutation(api.issues.unarchive, { org_id: fx.org.id, id: fx.task.id })

/* The refusal `post` ends in, with its data. */
async function refusal(post: Promise<unknown>): Promise<Refusal> {
  return (await expectRefusal(post, 'rule')).data as Refusal
}

/* Moves the clock on by `ms`. */
const later = (ms: number) => vi.setSystemTime(Date.now() + ms)

const ARCHIVE_CAP =
  'this task has reached 1,000 comments, the most a task can have, so the archive reason cannot be posted and the task was not archived. Archive it without a reason, which the app allows once its work is Done, or ask a project lead to delete comments until it has fewer than 1,000.'

describe('the cap of 1,000 comments on a task', () => {
  it('takes the 1,000th comment and refuses the next from the app, REST and MCP', async () => {
    const fx = await setup()
    await plantComments(fx, 999, { counted: true })
    expect(await countOf(fx.t, fx.task.id)).toBe(999)
    await appPost(fx)
    expect(await countOf(fx.t, fx.task.id)).toBe(1000)
    // the app's composer and Team sync notes both post through comments.create
    for (const post of [appPost(fx), restPost(fx), mcpPost(fx)])
      expect((await refusal(post)).message).toBe(LIMITS.comments.refusal)
    expect(await commentsOn(fx.t, fx.task.id)).toHaveLength(1000)
    expect(await countOf(fx.t, fx.task.id)).toBe(1000)
    // a refused post spends none of the author's rate
    expect((await rateOf(fx.t, fx.user.id, fx.task.id))?.posts).toHaveLength(1)
    expect(await rateOf(fx.t, fx.agent.id, fx.task.id)).toBeNull()
  })

  it('keeps a longer history from before the cap and takes nothing until deletes bring it under', async () => {
    const fx = await setup()
    // a task stored before counts, with 1,001 comments and no count
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const rows = await plantComments(fx, 1001, { task })
    expect((await refusal(appPost(fx, fx.user, task))).message).toBe(LIMITS.comments.refusal)
    // the refusal stores nothing, so the backfill counts it
    expect(await counter(fx.t, task.id)).toBeNull()
    await fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: false })
    expect(await countOf(fx.t, task.id)).toBe(1001)
    await appDelete(fx, fx.guest, rows[0])
    expect(await countOf(fx.t, task.id)).toBe(1000)
    await refusal(appPost(fx, fx.user, task))
    await appDelete(fx, fx.guest, rows[1])
    expect(await countOf(fx.t, task.id)).toBe(999)
    await appPost(fx, fx.user, task)
    expect(await countOf(fx.t, task.id)).toBe(1000)
    await refusal(appPost(fx, fx.user, task))
    // every comment of the history is still there, readable
    expect(await commentsOn(fx.t, task.id)).toHaveLength(1000)
  })

  it('frees one slot for each comment deleted, and none for a refused or repeated delete', async () => {
    const fx = await setup()
    const rows = await plantComments(fx, 1000, { counted: true })
    // only the author or a lead deletes, and reaching the cap changes nothing
    await expectRefusal(appDelete(fx, fx.viewer, rows[0]), 'forbidden')
    await expectRefusal(
      as(fx.t, fx.guest).mutation(api.comments.remove, {
        org_id: fx.org.id,
        id: rows[0].id,
        expected: { body: 'not what it says' },
      }),
      'conflict',
    )
    expect(await countOf(fx.t, fx.task.id)).toBe(1000)
    await appDelete(fx, fx.guest, rows[0])
    expect(await countOf(fx.t, fx.task.id)).toBe(999)
    await expectRefusal(appDelete(fx, fx.guest, rows[0]), 'not_found')
    expect(await countOf(fx.t, fx.task.id)).toBe(999)
    // an edit is no new comment
    await as(fx.t, fx.guest).mutation(api.comments.update, {
      org_id: fx.org.id,
      id: rows[1].id,
      body: 'Edited',
    })
    expect(await countOf(fx.t, fx.task.id)).toBe(999)
    // REST and MCP deletes free a slot too, the lead deleting the guest's
    await fx.t.mutation(internal.machine.discussion.restDeleteComment, {
      callerId: fx.user.id,
      access: 'write',
      ref: rows[2].id,
    })
    await fx.t.mutation(internal.machine.discussion.mcpDeleteComment, {
      callerId: fx.user.id,
      access: 'write',
      comment: rows[3].id,
    })
    expect(await countOf(fx.t, fx.task.id)).toBe(997)
    for (let i = 0; i < 3; i++) await appPost(fx, [fx.user, fx.admin, fx.guest][i])
    expect(await countOf(fx.t, fx.task.id)).toBe(1000)
    await refusal(appPost(fx))
  })

  it('refuses an archive with a reason at the cap whole, and lets one without a reason through', async () => {
    const fx = await setup()
    const child = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      parent_id: fx.task.id,
    })
    await plantSubscription(fx.t, { issue_id: fx.task.id, profile_id: fx.admin.id })
    await plantComments(fx, 1000, { counted: true })
    const messages = () =>
      fx.t.run(async (ctx) => (await ctx.db.query('messages').collect()).length)
    const before = await messages()
    for (const archive of [
      appArchive(fx, 'Done elsewhere'),
      restArchive(fx, 'Done elsewhere'),
      mcpArchive(fx, 'Done elsewhere'),
    ])
      expect((await refusal(archive)).message).toBe(ARCHIVE_CAP)
    // nothing archived, detached, posted or delivered
    for (const id of [fx.task.id, child.id]) {
      const row = await fx.t.run((ctx) => byId(ctx, 'issues', id))
      expect(row?.archived_at).toBeUndefined()
      expect(row?.parent_id).toBe(id === child.id ? fx.task.id : undefined)
    }
    expect(await commentsOn(fx.t, fx.task.id)).toHaveLength(1000)
    expect(await messages()).toBe(before)
    // without a reason it archives, through each surface
    await appArchive(fx)
    await unarchive(fx)
    await restArchive(fx)
    await unarchive(fx)
    await mcpArchive(fx)
    expect((await fx.t.run((ctx) => byId(ctx, 'issues', fx.task.id)))?.archived_at).toBeDefined()
    expect(await countOf(fx.t, fx.task.id)).toBe(1000)
  })

  it('takes an archive reason as the 1,000th comment', async () => {
    const fx = await setup()
    await plantComments(fx, 999, { counted: true })
    expect(await appArchive(fx, 'Shipped in 2.4')).toMatchObject({ archived: true })
    expect(await countOf(fx.t, fx.task.id)).toBe(1000)
    const thread = await commentsOn(fx.t, fx.task.id)
    expect(thread.at(-1)).toMatchObject({ body: 'Shipped in 2.4', author: fx.user.id })
  })
})

describe('the posting rate of 10 comments in any 60 seconds', () => {
  it('refuses the 11th post with the wait until the oldest is a minute old', async () => {
    const fx = await setup()
    for (let i = 0; i < 10; i++) {
      await appPost(fx)
      later(1000)
    }
    // the oldest post was at START, ten seconds ago
    const refused = await refusal(appPost(fx))
    expect(refused).toMatchObject({
      reason: COMMENT_RATE,
      retry_after: 50,
      message: tooManyComments(50),
    })
    vi.setSystemTime(START + 59_999)
    expect((await refusal(appPost(fx))).retry_after).toBe(1)
    vi.setSystemTime(START + 60_000)
    await appPost(fx)
    // the next waits for the post made a second after the first
    expect((await refusal(appPost(fx))).retry_after).toBe(1)
    expect(await countOf(fx.t, fx.task.id)).toBe(11)
    expect((await rateOf(fx.t, fx.user.id, fx.task.id))?.posts).toHaveLength(10)
  })

  it('takes 10 posts at one instant, gives none back for a delete, and an edit changes nothing', async () => {
    const fx = await setup()
    for (let i = 0; i < 10; i++) await appPost(fx)
    const thread = await commentsOn(fx.t, fx.task.id)
    await appDelete(fx, fx.user, thread[0])
    await as(fx.t, fx.user).mutation(api.comments.update, {
      org_id: fx.org.id,
      id: thread[1].id,
      body: 'Edited',
    })
    expect(await refusal(appPost(fx))).toMatchObject({ reason: COMMENT_RATE, retry_after: 60 })
    expect(await countOf(fx.t, fx.task.id)).toBe(9)
    later(60_000)
    await appPost(fx)
  })

  it('keeps one allowance per author and task, shared by the app, REST and MCP', async () => {
    const fx = await setup()
    // a person posts through the app and a token of theirs, REST and MCP
    for (let i = 0; i < 4; i++) await appPost(fx)
    for (let i = 0; i < 3; i++) await restPost(fx, fx.user)
    for (let i = 0; i < 3; i++) await mcpPost(fx, fx.user)
    for (const post of [appPost(fx), restPost(fx, fx.user), mcpPost(fx, fx.user)])
      expect((await refusal(post)).reason).toBe(COMMENT_RATE)
    // another author on the task, and the person on another task, post on
    await appPost(fx, fx.admin)
    await restPost(fx, fx.agent)
    const other = await createTask(fx.t, fx, 'Another thread')
    await appPost(fx, fx.user, other)
    expect(await countOf(fx.t, fx.task.id)).toBe(12)
  })

  it('counts archive reasons, and lets an archive without a reason through', async () => {
    const fx = await setup()
    for (let i = 0; i < 10; i++) await appPost(fx)
    later(15_000)
    expect(await refusal(appArchive(fx, 'Out of scope'))).toMatchObject({
      reason: COMMENT_RATE,
      retry_after: 45,
      message:
        'too many comments on this task, at most 10 in any 60 seconds from one person or agent, so the archive reason cannot be posted and the task was not archived. Try again in 45 seconds.',
    })
    expect((await fx.t.run((ctx) => byId(ctx, 'issues', fx.task.id)))?.archived_at).toBeUndefined()
    await appArchive(fx)
    expect((await fx.t.run((ctx) => byId(ctx, 'issues', fx.task.id)))?.archived_at).toBeDefined()
    await unarchive(fx)
    later(45_000)
    // the reason is the author's 11th post in 60 seconds, so it waits
    await appArchive(fx, 'Out of scope')
    expect(await countOf(fx.t, fx.task.id)).toBe(11)
  })
})

describe('counting a task', () => {
  it('counts a task not counted yet when someone posts on it', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 5, { task })
    await appPost(fx, fx.user, task)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 6, counting: false })
  })

  it('refuses a post for now when the thread is too long to count in it, until the backfill counts it', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 20, { task, body: 'x'.repeat(1000) })
    // a post counts only about four of these comments
    Object.assign(COUNT_BUDGET.post, { bytes: 4_000, part: 8_000 })
    expect(await refusal(appPost(fx, fx.user, task))).toMatchObject({
      reason: COMMENTS_COUNTING,
      retry_after: 60,
      message: "Qivo is still counting this task's comments. Try again in 60 seconds.",
    })
    expect(
      await refusal(
        as(fx.t, fx.user).mutation(api.issues.archive, {
          org_id: fx.org.id,
          id: task.id,
          reason: 'Moved',
        }),
      ),
    ).toMatchObject({
      reason: COMMENTS_COUNTING,
      message:
        "Qivo is still counting this task's comments, so the archive reason cannot be posted and the task was not archived. Try again in 60 seconds.",
    })
    expect(await counter(fx.t, task.id)).toBeNull()
    expect(await commentsOn(fx.t, task.id)).toHaveLength(20)
    expect((await fx.t.run((ctx) => byId(ctx, 'issues', task.id)))?.archived_at).toBeUndefined()
    await fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: false })
    await appPost(fx, fx.user, task)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 21, counting: false })
  })

  it('stays exact through posts and deletes while a count runs', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const rows = await plantComments(fx, 10, { task })
    Object.assign(COUNT_BUDGET.step, { rows: 4 })
    await fx.t.run((ctx) =>
      ctx.db.insert('task_comment_counts', {
        org_id: fx.org.id,
        issue_id: task.id,
        count: 0,
        counted: COUNT_START,
        revision: 0,
      }),
    )
    const step = () =>
      fx.t.mutation(internal.internal.commentCountsBackfill.step, {
        issue_id: task.id,
        restart: false,
      })
    expect(await step()).toBeNull()
    expect(await counter(fx.t, task.id)).toMatchObject({
      count: 4,
      counted: rows[3]._creationTime,
    })
    // one delete the count has passed, and one it has not reached
    await appDelete(fx, fx.guest, rows[1])
    await appDelete(fx, fx.guest, rows[8])
    expect(await countOf(fx.t, task.id)).toBe(3)
    // a comment written past the count, as Deleted items writes one back
    await fx.t.run(async (ctx) => {
      const _id = await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        author: fx.guest.id,
        body: 'Back',
        created_at: NOW,
      })
      await tallyComments(ctx, [[{ _id, issue_id: task.id }, 1]])
    })
    expect(await countOf(fx.t, task.id)).toBe(3)
    let got = await step()
    while (got === null) got = await step()
    expect(got).toBe(9)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 9, counting: false })
    expect(await commentsOn(fx.t, task.id)).toHaveLength(9)
  })

  it('lets a post finish a count under way', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const rows = await plantComments(fx, 6, { task })
    await fx.t.run((ctx) =>
      ctx.db.insert('task_comment_counts', {
        org_id: fx.org.id,
        issue_id: task.id,
        count: 2,
        counted: rows[1]._creationTime,
        revision: 0,
      }),
    )
    await appPost(fx, fx.user, task)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 7, counting: false })
  })

  it('starts a count when a task stored before counts comes back from Deleted items', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 12, { task })
    await deleteTask(fx.t, fx, task.id)
    await runSteps(fx.t)
    expect(await counter(fx.t, task.id)).toBeNull()
    Object.assign(COUNT_BUDGET.step, { rows: 5 })
    const item = await itemFor(fx.t, task.id)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [item.id],
    })
    await runSteps(fx.t)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 12, counting: false })
  })

  it('restarts the stalled counts, least recently moved first, and leaves moving ones', async () => {
    const fx = await setup()
    RECOVER.batch = 3
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 5; i++)
      tasks.push(await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id }))
    for (const task of tasks) await plantComments(fx, 2, { task })
    // the fourth moved last of the stalled ones, the fifth moves now
    const moved = [5, 1, 3, 4, 0].map((minutes) => START - (minutes + 1) * 60_000)
    moved[4] = START
    await fx.t.run(async (ctx) => {
      for (const [i, task] of tasks.entries())
        await ctx.db.insert('task_comment_counts', {
          org_id: fx.org.id,
          issue_id: task.id,
          count: 0,
          counted: COUNT_START,
          revision: 0,
          progress_at: moved[i],
        })
    })
    await fx.t.mutation(internal.commentLimits.recover, {})
    const rows = await Promise.all(tasks.map((task) => counter(fx.t, task.id)))
    // the three that moved least recently, 6, 5 and 4 minutes ago
    expect(rows.map((row) => row?.attempts)).toEqual([1, undefined, 1, 1, undefined])
    expect(rows.map((row) => row?.progress_at)).toEqual([START, moved[1], START, START, START])
    await runSteps(fx.t)
    for (const i of [0, 2, 3])
      expect(await stateOf(fx.t, tasks[i].id)).toEqual({ count: 2, counting: false })
    // a later run takes the one left, and the moving one when it stalls
    vi.setSystemTime(START + 2 * 60_000)
    await fx.t.mutation(internal.commentLimits.recover, {})
    await runSteps(fx.t)
    for (const task of tasks)
      expect(await stateOf(fx.t, task.id)).toEqual({ count: 2, counting: false })
    // an exact count is never restarted
    await fx.t.mutation(internal.commentLimits.recover, {})
    expect((await counter(fx.t, tasks[0].id))?.attempts).toBeUndefined()
  })

  it("halves a failing count's step after each restart and marks one that keeps failing stuck", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 300, { task })
    const plant = (attempts: number) =>
      fx.t.run(async (ctx) => {
        const row = await countRow(ctx, task.id)
        const fields = {
          org_id: fx.org.id,
          issue_id: task.id,
          count: 0,
          counted: COUNT_START,
          revision: 0,
          progress_at: Date.now() - 2 * 60_000,
          attempts,
        }
        if (row === null) await ctx.db.insert('task_comment_counts', fields)
        else await ctx.db.replace(row._id, fields)
      })
    // a fourth restart counts a sixteenth of the step's 2,000 comments
    await plant(3)
    await fx.t.mutation(internal.commentLimits.recover, {})
    expect((await counter(fx.t, task.id))?.attempts).toBe(4)
    await fx.t.mutation(internal.commentLimits.step, { issue_id: task.id })
    const stepped = await counter(fx.t, task.id)
    expect(stepped?.count).toBe(125)
    expect(stepped?.attempts).toBeUndefined()
    // a step that commits brings the full budget back
    await runSteps(fx.t)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 300, counting: false })
    // the tenth restart in a row gives up, and nothing counts on
    await plant(9)
    await fx.t.mutation(internal.commentLimits.recover, {})
    expect(await counter(fx.t, task.id)).toMatchObject({ stuck: true, attempts: 10 })
    expect((await counter(fx.t, task.id))?.progress_at).toBeUndefined()
    expect(error).toHaveBeenCalledWith('A comment count kept failing and stopped', {
      issue_id: task.id,
      attempts: 9,
    })
    await runSteps(fx.t)
    expect(await countOf(fx.t, task.id)).toBe(0)
    // posts stay refused for now, and the backfill finishes the count
    Object.assign(COUNT_BUDGET.post, { bytes: 1_000, part: 4 * 1024 * 1024 })
    expect((await refusal(appPost(fx, fx.user, task))).reason).toBe(COMMENTS_COUNTING)
    expect(await counter(fx.t, task.id)).toMatchObject({ stuck: true })
    const dry = await fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: true })
    expect(dry).toMatchObject({ stuck: 1, stuck_tasks: [task.id] })
    await fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: false })
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 300, counting: false })
    expect((await counter(fx.t, task.id))?.stuck).toBeUndefined()
  })

  it('deletes the post logs whose posts stopped counting, in legs', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < SWEEP_BATCH + 2; i++)
        await ctx.db.insert('comment_rates', {
          org_id: fx.org.id,
          issue_id: uuid(),
          author: fx.user.id,
          posts: [START - 60_000 - i],
          until: START - i,
        })
    })
    await appPost(fx)
    await fx.t.mutation(internal.commentLimits.sweep, {})
    await runSteps(fx.t)
    const left = await fx.t.run((ctx) => ctx.db.query('comment_rates').collect())
    expect(left.map((row) => row.issue_id)).toEqual([fx.task.id])
    // a row the sweep has not reached gives the author no fewer posts
    later(60_000)
    for (let i = 0; i < 10; i++) await appPost(fx)
  })
})

/* ---- comments that share a _creationTime
 * Convex can give two comments one _creationTime and convex-test never
 * does, so a count over them runs on this QueryCtx of one thread. */

type Bound = { eq?: number; gt?: number }
type Builder = {
  eq(field: string, value: unknown): Builder
  gt(field: string, value: number): Builder
  bound: Bound
}
const builder = (bound: Bound): Builder => ({
  eq: (field, value) =>
    builder(field === '_creationTime' ? { ...bound, eq: value as number } : bound),
  gt: (_, value) => builder({ ...bound, gt: value }),
  bound,
})

function threadCtx(thread: Doc<'comments'>[]): QueryCtx {
  const ordered = [...thread].sort(
    (a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : 1),
  )
  const query = () => ({
    withIndex: (_index: string, build: (q: Builder) => Builder) => {
      const { eq, gt } = build(builder({})).bound
      const rows = ordered.filter(
        (c) =>
          (eq === undefined || c._creationTime === eq) &&
          (gt === undefined || c._creationTime > gt),
      )
      return { take: async (n: number) => rows.slice(0, n), collect: async () => rows }
    },
  })
  return { db: { query } } as unknown as QueryCtx
}

const fakeComment = (n: number, time: number): Doc<'comments'> =>
  ({
    _id: `c${String(n).padStart(2, '0')}`,
    _creationTime: time,
    id: uuid(),
    issue_id: 'task',
    author: 'guest',
    body: `#${n}`,
    created_at: NOW,
  }) as unknown as Doc<'comments'>

describe('a count over comments that share a _creationTime', () => {
  it('counts each of them once, whatever the page size', async () => {
    // 13 comments, three to an instant
    const ctx = threadCtx(
      Array.from({ length: 13 }, (_, n) => fakeComment(n, 1_000 + Math.floor(n / 3))),
    )
    for (const rows of [1, 2, 4, 5, 13]) {
      let count = 0
      let after = COUNT_START
      for (;;) {
        const page = await countPage(ctx, 'task', after, {
          bytes: 4 * 1024 * 1024,
          part: 8 * 1024 * 1024,
          rows,
        })
        count += page.rows
        after = page.through
        if (page.done) break
      }
      expect(count).toBe(13)
    }
  })

  it('reads in parts no larger than its unspent bytes could hold at the document limit', async () => {
    const big = 'a'.repeat(900_000)
    const thread = Array.from({ length: 12 }, (_, n) => ({
      ...fakeComment(n, 1_000 + n),
      body: big,
    }))
    const page = await countPage(threadCtx(thread), 'task', COUNT_START, {
      ...COUNT_BUDGET.post,
      rows: LIMITS.comments.max,
    })
    const read = thread.slice(0, page.rows).reduce((n, c) => n + getDocumentSize(c), 0)
    expect(page.done).toBe(false)
    expect(read).toBeLessThan(COUNT_BUDGET.post.part + 1024 * 1024)
    expect(read).toBeGreaterThanOrEqual(COUNT_BUDGET.post.bytes)
  })
})

describe('Deleted items', () => {
  it('keeps a count through a move and a restore, and a purge deletes it with the task', async () => {
    const fx = await setup()
    await plantComments(fx, 4, { counted: true })
    await appPost(fx)
    expect(await countOf(fx.t, fx.task.id)).toBe(5)
    await deleteTask(fx.t, fx, fx.task.id)
    await runSteps(fx.t)
    // the comments are stored, so the row counts none while the task is away
    expect(await stateOf(fx.t, fx.task.id)).toEqual({ count: 0, counting: false })
    const item = await itemFor(fx.t, fx.task.id)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [item.id],
    })
    await runSteps(fx.t)
    expect(await stateOf(fx.t, fx.task.id)).toEqual({ count: 5, counting: false })
    // the restore spent no post of the rate, and gave none back
    expect((await rateOf(fx.t, fx.user.id, fx.task.id))?.posts).toHaveLength(1)
    await appPost(fx)
    expect(await countOf(fx.t, fx.task.id)).toBe(6)

    await deleteTask(fx.t, fx, fx.task.id)
    await runSteps(fx.t)
    const again = await itemFor(fx.t, fx.task.id)
    await as(fx.t, fx.admin).mutation(api.deletedItems.purge, {
      org_id: fx.org.id,
      ids: [again.id],
    })
    await runSteps(fx.t)
    expect(await counter(fx.t, fx.task.id)).toBeNull()
  })
})

describe('Deleted items, rows too large to store', () => {
  it('counts out a comment a move drops, so the restore brings back the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      const rows: Doc<'comments'>[] = []
      for (const body of ['Kept', 'x'.repeat(STORED_ROW_MAX_BYTES)]) {
        const _id = await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: fx.task.id,
          author: fx.guest.id,
          body,
          created_at: NOW,
        })
        rows.push((await ctx.db.get(_id)) as Doc<'comments'>)
      }
      await tallyComments(
        ctx,
        rows.map((row) => [row, 1] as const),
      )
    })
    expect(await countOf(fx.t, fx.task.id)).toBe(2)
    await deleteTask(fx.t, fx, fx.task.id)
    await runSteps(fx.t)
    const item = await itemFor(fx.t, fx.task.id)
    expect(item.dropped_rows).toBe(1)
    expect(await countOf(fx.t, fx.task.id)).toBe(0)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [item.id],
    })
    await runSteps(fx.t)
    expect(await stateOf(fx.t, fx.task.id)).toEqual({ count: 1, counting: false })
    expect(await commentsOn(fx.t, fx.task.id)).toHaveLength(1)
  })
})

describe('the backfill', () => {
  it('reports without writing, counts what is not counted, goes on from its cursor and mends with a recount', async () => {
    const fx = await setup()
    const plain = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const full = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const wrong = await createTask(fx.t, fx, 'Miscounted')
    await plantComments(fx, 3, { task: plain })
    await plantComments(fx, 1000, { task: full })
    await plantComments(fx, 2, { task: wrong })
    // fx.task is counted from its start and holds no comment
    await fx.t.run(async (ctx) => {
      const row = await countRow(ctx, wrong.id)
      if (row !== null) await ctx.db.patch(row._id, { count: 5 })
    })
    const run = (args: { dry_run: boolean; recount?: boolean; cursor?: string }) =>
      fx.t.action(internal.internal.commentCountsBackfill.run, args)

    const dry = await run({ dry_run: true })
    expect(dry).toMatchObject({ done: true, counted: 2, comments: 1003, full: 1, differing: 1 })
    expect(dry.to_count.map((task) => task.issue_id).sort()).toEqual([plain.id, full.id].sort())
    expect(dry.full_tasks).toEqual([{ issue_id: full.id, org_id: fx.org.id, count: 1000 }])
    expect(dry.differ).toEqual([{ issue_id: wrong.id, org_id: fx.org.id, count: 2, stored: 5 }])
    expect(await counter(fx.t, plain.id)).toBeNull()

    // one page of a task a call, so each call goes on from the cursor
    Object.assign(TASK_PAGE, { rows: 1 })
    Object.assign(RUN, { ms: 0 })
    let calls = 0
    let cursor: string | undefined
    for (;;) {
      const got = await run({ dry_run: false, cursor })
      calls++
      if (got.done) break
      cursor = got.cursor ?? undefined
    }
    expect(calls).toBeGreaterThan(3)
    expect(await stateOf(fx.t, plain.id)).toEqual({ count: 3, counting: false })
    expect(await stateOf(fx.t, full.id)).toEqual({ count: 1000, counting: false })
    // a run leaves exact counts alone, the wrong one too
    expect(await countOf(fx.t, wrong.id)).toBe(5)
    const audits = await fx.t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audits.filter((row) => row.action === 'comment_counts_backfill')).toHaveLength(calls)

    Object.assign(TASK_PAGE, DEFAULTS.page)
    Object.assign(RUN, DEFAULTS.run)
    expect(await run({ dry_run: true })).toMatchObject({ counted: 0, differing: 1, full: 1 })
    await run({ dry_run: false, recount: true })
    expect(await countOf(fx.t, wrong.id)).toBe(2)
    expect(await run({ dry_run: true })).toMatchObject({ counted: 0, differing: 0 })
  }, 60_000)
})

describe('over HTTP', () => {
  it('answers the cap 400, the rate 429 and a count under way 503, the waits in Retry-After', async () => {
    const fx = await setup()
    const secret = `qva_${'comment-limits'.repeat(4)}`
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: fx.agent.id,
        name: 'drive',
        key_prefix: secret.slice(0, 11),
        key_hash: await sha256hex(secret),
        created_at: NOW,
      })
    })
    const http = fx.t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ): Promise<Response>
    }
    const post = (task: Doc<'issues'>) =>
      http.fetch(`/v1/tasks/QN-${task.num}/comments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Status' }),
      })
    const answer = async (response: Response) => ({
      status: response.status,
      retry: response.headers.get('Retry-After'),
      body: JSON.parse(
        await (response as unknown as { text(): Promise<string> }).text(),
      ) as unknown,
    })

    for (let i = 0; i < 10; i++) expect((await post(fx.task)).status).toBe(201)
    later(20_000)
    const limited = await post(fx.task)
    // a browser can read the wait
    expect(limited.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After')
    expect(await answer(limited)).toEqual({
      status: 429,
      retry: '40',
      body: { error: tooManyComments(40) },
    })
    // an archive with a reason past the rate changes nothing, its title neither
    const patched = await http.fetch(`/v1/tasks/QN-${fx.task.num}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed', archived: true, archive_reason: 'Shipped' }),
    })
    expect(await answer(patched)).toMatchObject({ status: 429, retry: '40' })
    const unchanged = await fx.t.run((ctx) => byId(ctx, 'issues', fx.task.id))
    expect(unchanged?.archived_at).toBeUndefined()
    expect(unchanged?.title).toBe(fx.task.title)

    const full = await createTask(fx.t, fx, 'Full')
    await plantComments(fx, 1000, { task: full, counted: true })
    expect(await answer(await post(full))).toEqual({
      status: 400,
      retry: null,
      body: { error: LIMITS.comments.refusal },
    })

    const long = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 10, { task: long, body: 'x'.repeat(1000) })
    Object.assign(COUNT_BUDGET.post, { bytes: 2_000, part: 4_000 })
    expect(await answer(await post(long))).toEqual({
      status: 503,
      retry: '60',
      body: { error: "Qivo is still counting this task's comments. Try again in 60 seconds." },
    })
    // the refusal started the count, which finishes without the backfill
    expect(await stateOf(fx.t, long.id)).toEqual({ count: 0, counting: true })
    await runSteps(fx.t)
    expect(await stateOf(fx.t, long.id)).toEqual({ count: 10, counting: false })
    expect((await post(long)).status).toBe(201)
    expect(await countOf(fx.t, long.id)).toBe(11)
  })
})

describe('starting a count after a refusal', () => {
  it('lets the app start the count of a task whose post it was refused for, behind its checks', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 12, { task, body: 'x'.repeat(1000) })
    Object.assign(COUNT_BUDGET.post, { bytes: 3_000, part: 4 * 1024 * 1024 })
    expect(await refusal(appPost(fx, fx.user, task))).toMatchObject({
      reason: COMMENTS_COUNTING,
      task_id: task.id,
    })
    expect(await counter(fx.t, task.id)).toBeNull()
    const count = (who: Doc<'profiles'>, issue: Doc<'issues'>) =>
      as(fx.t, who).mutation(api.comments.countThread, { org_id: fx.org.id, issue_id: issue.id })
    await count(fx.user, task)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 0, counting: true })
    // again while it moves starts no second count
    await count(fx.user, task)
    await runSteps(fx.t)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 12, counting: false })
    await appPost(fx, fx.user, task)
    expect(await countOf(fx.t, task.id)).toBe(13)
    // an exact count stays as it is
    await count(fx.user, task)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 13, counting: false })
    // a task the caller cannot see is not found, and starts nothing
    const hidden = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.hidden.id })
    await expectRefusal(count(fx.guest, hidden), 'not_found')
    expect(await counter(fx.t, hidden.id)).toBeNull()
  })

  /* A caller that retries a minute after each refusal, as the refusal
   * asks, with the recovery every ten minutes, for 30 minutes, on a thread
   * of comments near 900 KB under `bytesRead`. Answers the task's row once
   * the count is exact, stuck or the half hour is over. */
  async function retryHalfHour(bytesRead: number) {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fx = await setup(newT({ transactionLimits: { bytesRead } }))
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    for (let i = 0; i < 10; i++) await plantComments(fx, 1, { task, body: 'x'.repeat(900_000) })
    const begin = () =>
      as(fx.t, fx.user).mutation(api.comments.countThread, {
        org_id: fx.org.id,
        issue_id: task.id,
      })
    await begin()
    await runSteps(fx.t)
    for (let minute = 1; minute <= 30; minute++) {
      vi.setSystemTime(START + minute * 60_000)
      await begin()
      if (minute % 10 === 0) await fx.t.mutation(internal.commentLimits.recover, {})
      await runSteps(fx.t)
      const row = await counter(fx.t, task.id)
      if (row?.counted === undefined || row.stuck === true) return { row, minute }
    }
    return { row: await counter(fx.t, task.id), minute: 30 }
  }

  it('finishes a count whose step fails at full budget, however often a caller restarts it', async () => {
    // a full step reads eight of the comments, more than 4 MiB; half reads four
    const { row, minute } = await retryHalfHour(4 * 1024 * 1024)
    expect(row?.count).toBe(10)
    expect(row?.counted).toBeUndefined()
    expect(row?.stuck).toBeUndefined()
    expect(minute).toBeLessThan(10)
  }, 120_000)

  it('marks a count whose step always fails stuck, however often a caller restarts it', async () => {
    // even the smallest step reads two of the comments, more than 1 MiB
    const { row, minute } = await retryHalfHour(1024 * 1024)
    expect(row).toMatchObject({ stuck: true, count: 0 })
    expect(minute).toBe(10)
  }, 120_000)

  it('starts the count after a REST or MCP write refused while it counts, and passes others on', async () => {
    const calls: { name: string; args: unknown }[] = []
    const runners = {
      runQuery: async () => null,
      runMutation: async (ref: unknown, args: unknown) => {
        calls.push({ name: getFunctionName(ref as FunctionReference<'mutation'>), args })
        return null
      },
      runAction: async () => null,
    } as unknown as Parameters<typeof runEntry>[0]
    const refusing = (data: Refusal) => ({
      access: 'write' as const,
      run: async () => {
        throw new ConvexError(data)
      },
    })
    const counting = { code: 'rule' as const, message: 'counting', reason: COMMENTS_COUNTING }
    await expect(
      runEntry(runners, refusing({ ...counting, task_id: 'task-1' }), null),
    ).rejects.toThrow(ConvexError)
    expect(calls).toEqual([{ name: 'commentLimits:begin', args: { issue_id: 'task-1' } }])
    // another refusal, or one without its task, starts nothing
    await expect(
      runEntry(runners, refusing({ code: 'rule', message: 'no', reason: COMMENT_RATE }), null),
    ).rejects.toThrow(ConvexError)
    await expect(runEntry(runners, refusing(counting), null)).rejects.toThrow(ConvexError)
    expect(calls).toHaveLength(1)
  })
})

describe('the backfill, call by call', () => {
  it('goes on inside a task and inside its count when RUN.ms has passed, in a dry run and a run', async () => {
    const fx = await setup()
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 40, { task })
    Object.assign(COUNT_BUDGET.step, { rows: 7 })
    Object.assign(RUN, { ms: 0 })
    const calls = async (dry_run: boolean) => {
      const cursors: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 100; i++) {
        const got = await fx.t.action(internal.internal.commentCountsBackfill.run, {
          dry_run,
          cursor,
        })
        if (got.done) return { got, cursors }
        cursor = got.cursor ?? undefined
        if (cursor !== undefined) cursors.push(cursor)
      }
      throw new Error('the backfill did not finish')
    }
    const dry = await calls(true)
    expect(dry.got.to_count).toEqual([])
    // the calls reported the task's count in parts; the totals are per call
    expect(dry.cursors.some((c) => JSON.parse(c).dry !== undefined)).toBe(true)
    expect(await counter(fx.t, task.id)).toBeNull()
    const wet = await calls(false)
    expect(wet.cursors.some((c) => JSON.parse(c).task === task.id)).toBe(true)
    expect(await stateOf(fx.t, task.id)).toEqual({ count: 40, counting: false })
    // each call recorded its cursor
    const audits = await fx.t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audits.filter((row) => row.action === 'comment_counts_backfill')).toHaveLength(
      wet.cursors.length + 1,
    )
  })

  it('counts a thread again when a delete and a post changed it between two pages', async () => {
    const fx = await setup()
    const task = await createTask(fx.t, fx, 'Busy thread')
    const rows = await plantComments(fx, 20, { task, counted: true })
    Object.assign(COUNT_BUDGET.step, { rows: 5 })
    Object.assign(RUN, { ms: 0 })
    let cursor: string | undefined
    // the calls before the dry count of the task stops inside it
    for (;;) {
      const got = await fx.t.action(internal.internal.commentCountsBackfill.run, {
        dry_run: true,
        cursor,
      })
      cursor = got.cursor ?? undefined
      if (cursor !== undefined && JSON.parse(cursor).task === task.id) break
      if (got.done) throw new Error('the dry run passed the task in one call')
    }
    // the same total, but another thread than the pages counted
    await appDelete(fx, fx.guest, rows[0])
    await appPost(fx, fx.user, task)
    expect(await countOf(fx.t, task.id)).toBe(20)
    const totals = { differing: 0, unsettled: 0 }
    for (;;) {
      const got: RunAnswer = await fx.t.action(internal.internal.commentCountsBackfill.run, {
        dry_run: true,
        cursor,
      })
      totals.differing += got.differing
      totals.unsettled += got.unsettled
      if (got.done) break
      cursor = got.cursor ?? undefined
    }
    expect(totals).toEqual({ differing: 0, unsettled: 0 })
  })

  it('records the call that failed with its cursor, after the counts it committed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // a step that reads past 3 MiB fails
    const fx = await setup(newT({ transactionLimits: { bytesRead: 3 * 1024 * 1024 } }))
    const small = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const large = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 2, { task: small })
    for (let i = 0; i < 5; i++)
      await plantComments(fx, 1, { task: large, body: 'x'.repeat(900_000) })
    await expect(
      fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: false }),
    ).rejects.toThrow()
    expect(await stateOf(fx.t, small.id)).toEqual({ count: 2, counting: false })
    const audit = await fx.t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).find(
        (row) => row.action === 'comment_counts_backfill',
      ),
    )
    const detail = audit?.detail as { counted: number; cursor: string; failed?: string }
    expect(detail.counted).toBe(1)
    expect(detail.failed).toBeDefined()
    expect(JSON.parse(detail.cursor)).toMatchObject({
      org: fx.org.id,
      phase: 'tasks',
      after: small.num,
    })
    expect(error).toHaveBeenCalled()
  })

  it('deletes the count rows a rollback can leave that name no task of their organization', async () => {
    const fx = await setup()
    const stored = await createTask(fx.t, fx, 'In Deleted items')
    await deleteTask(fx.t, fx, stored.id)
    await runSteps(fx.t)
    const foreign = await plantIssue(fx.t, {
      org_id: fx.otherOrg.id,
      project_id: fx.otherProject.id,
    })
    const orphan = uuid()
    await fx.t.run(async (ctx) => {
      for (const issue_id of [orphan, foreign.id])
        await ctx.db.insert('task_comment_counts', {
          org_id: fx.org.id,
          issue_id,
          count: 4,
          revision: 0,
        })
    })
    Object.assign(ROW_PAGE, { rows: 1 })
    const dry = await fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: true })
    expect(dry).toMatchObject({ drift: 2, dropped: 0 })
    expect(dry.drift_rows.map((row) => [row.issue_id, row.where]).sort()).toEqual(
      [
        [orphan, 'orphan'],
        [foreign.id, 'other_org'],
      ].sort(),
    )
    const run = await fx.t.action(internal.internal.commentCountsBackfill.run, { dry_run: false })
    expect(run.dropped).toBeGreaterThan(0)
    expect(await counter(fx.t, orphan)).toBeNull()
    // the other organization's task has a count of its own, whichever came first
    expect(await counter(fx.t, foreign.id)).toMatchObject({ org_id: fx.otherOrg.id, count: 0 })
    expect((await counter(fx.t, foreign.id))?.counted).toBeUndefined()
    // the task in Deleted items keeps its count
    expect(await stateOf(fx.t, stored.id)).toEqual({ count: 0, counting: false })
  })
})

/* A QueryCtx over `tables` that keeps an index's order, _creationTime and
 * then the document id, and reads equality on any field, `gt` on
 * _creationTime and `take`, `collect`, `first` and `unique`. Convex can give
 * two count rows one _creationTime and convex-test never does. */
function tablesCtx(tables: Record<string, Record<string, unknown>[]>): QueryCtx {
  type Range = { eq: [string, unknown][]; gt?: number }
  type RowBuilder = {
    eq(field: string, value: unknown): RowBuilder
    gt(field: string, value: number): RowBuilder
    range: Range
  }
  const builder = (range: Range): RowBuilder => ({
    eq: (field, value) => builder({ ...range, eq: [...range.eq, [field, value]] }),
    gt: (_, value) => builder({ ...range, gt: value }),
    range,
  })
  const query = (table: string) => ({
    withIndex: (_index: string, build: (q: RowBuilder) => RowBuilder) => {
      const { eq, gt } = build(builder({ eq: [] })).range
      const rows = (tables[table] ?? [])
        .filter(
          (row) =>
            eq.every(([field, value]) => row[field] === value) &&
            (gt === undefined || (row._creationTime as number) > gt),
        )
        .sort(
          (a, b) =>
            (a._creationTime as number) - (b._creationTime as number) ||
            String(a._id).localeCompare(String(b._id)),
        )
      return {
        take: async (n: number) => rows.slice(0, n),
        collect: async () => rows,
        first: async () => rows[0] ?? null,
        unique: async () => rows[0] ?? null,
      }
    },
  })
  return { db: { query } } as unknown as QueryCtx
}

describe('the drift check across a page boundary', () => {
  it('checks every row that shares the time a page ends at', async () => {
    Object.assign(ROW_PAGE, { rows: 1 })
    const row = (n: number, issue_id: string) => ({
      _id: `r${n}`,
      _creationTime: 1_000,
      org_id: 'org',
      issue_id,
      count: 0,
      revision: 0,
    })
    const ctx = tablesCtx({
      task_comment_counts: [row(1, 'live'), row(2, 'gone')],
      issues: [{ _id: 'i1', _creationTime: 1, id: 'live', org_id: 'org' }],
      deleted_rows: [],
    })
    const seen: { issue_id: string; where: string }[] = []
    let after = COUNT_START
    for (let pages = 0; pages < 5; pages++) {
      const page = await rowsAfter(ctx, 'org', after)
      seen.push(...page.rows)
      after = page.through
      if (page.done) break
    }
    expect(seen).toEqual([
      { issue_id: 'live', where: 'live' },
      { issue_id: 'gone', where: 'orphan' },
    ])
  })
})

describe('ids that come back', () => {
  it('gives a task that takes a purged id no count and no posts of the task before', async () => {
    const fx = await setup()
    const id = fx.task.id
    for (let i = 0; i < 10; i++) await appPost(fx)
    await deleteTask(fx.t, fx, id)
    await runSteps(fx.t)
    await as(fx.t, fx.admin).mutation(api.deletedItems.purge, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, id)).id],
    })
    await runSteps(fx.t)
    expect(await counter(fx.t, id)).toBeNull()
    expect(await rateOf(fx.t, fx.user.id, id)).toBeNull()
    // the id again, within the same minute
    const again = await createTask(fx.t, fx, 'Same id', { id })
    for (let i = 0; i < 10; i++) await appPost(fx, fx.user, again)
    expect(await countOf(fx.t, id)).toBe(10)
  })

  it("counts nothing from rows another organization's task left under the id", async () => {
    const fx = await setup()
    const id = uuid()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('task_comment_counts', {
        org_id: fx.otherOrg.id,
        issue_id: id,
        count: 999,
        revision: 3,
      })
      await ctx.db.insert('comment_rates', {
        org_id: fx.otherOrg.id,
        issue_id: id,
        author: fx.user.id,
        posts: Array.from({ length: 10 }, () => Date.now()),
        until: Date.now() + 60_000,
      })
    })
    // a task inserted without a count, as an earlier release inserts one
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, id })
    await appPost(fx, fx.user, task)
    expect(await counter(fx.t, id)).toMatchObject({ org_id: fx.org.id, count: 1 })
    expect(await rateOf(fx.t, fx.user.id, id)).toMatchObject({
      org_id: fx.org.id,
      posts: [Date.now()],
    })
  })

  it('keeps the count of a live task that took the id while a purge of the earlier one waited', async () => {
    const fx = await setup()
    const id = fx.task.id
    await appPost(fx)
    await deleteTask(fx.t, fx, id)
    await runSteps(fx.t)
    const item = await itemFor(fx.t, id)
    // a purge the release before left part done deleted the stored task row
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', id))
        .unique()
      if (row !== null) await ctx.db.delete(row._id)
    })
    const again = await createTask(fx.t, fx, 'Took the id', { id })
    await appPost(fx, fx.admin, again)
    await as(fx.t, fx.admin).mutation(api.deletedItems.purge, { org_id: fx.org.id, ids: [item.id] })
    await runSteps(fx.t)
    // the purge keeps the live task's count and post log, and its count
    // holds the comments the purge left, which takes the live rows of its
    // stored tasks (model/deletedItems.ts purgeLive)
    const left = (await commentsOn(fx.t, id)).length
    expect(await stateOf(fx.t, id)).toEqual({ count: left, counting: false })
    expect(await rateOf(fx.t, fx.admin.id, id)).not.toBeNull()
  })
})

describe('Deleted items, project items and subtasks', () => {
  it("keeps a project's task counts through a move, a restore and a purge in small steps", async () => {
    const fx = await setup()
    Object.assign(TRASH_BUDGET, { rows: 4 })
    const tasks = [
      await createTask(fx.t, fx, 'One', { project_id: fx.sub2.id }),
      await createTask(fx.t, fx, 'Two', { project_id: fx.sub2.id }),
    ]
    for (const task of tasks) await plantComments(fx, 6, { task, counted: true })
    await appPost(fx, fx.user, tasks[0])
    await deleteProject(fx.t, fx, fx.sub2.id)
    await runSteps(fx.t)
    expect(await Promise.all(tasks.map((task) => countOf(fx.t, task.id)))).toEqual([0, 0])
    const item = await itemFor(fx.t, fx.sub2.id)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [item.id],
    })
    await runSteps(fx.t)
    expect(await Promise.all(tasks.map((task) => stateOf(fx.t, task.id)))).toEqual([
      { count: 7, counting: false },
      { count: 6, counting: false },
    ])
    await deleteProject(fx.t, fx, fx.sub2.id)
    await runSteps(fx.t)
    const again = await itemFor(fx.t, fx.sub2.id)
    await as(fx.t, fx.admin).mutation(api.deletedItems.purge, {
      org_id: fx.org.id,
      ids: [again.id],
    })
    await runSteps(fx.t)
    for (const task of tasks) expect(await counter(fx.t, task.id)).toBeNull()
    expect(await rateOf(fx.t, fx.user.id, tasks[0].id)).toBeNull()
  })

  it('keeps the count of a subtask a restore hands to its project item, and deletes it with a purged one', async () => {
    const fx = await setup()
    const root = await createTask(fx.t, fx, 'Root')
    const sub = await createTask(fx.t, fx, 'Sub', { project_id: fx.sub2.id, parent_id: root.id })
    await plantComments(fx, 3, { task: sub, counted: true })
    await deleteTask(fx.t, fx, root.id, { subtask_ids: [sub.id] })
    await deleteProject(fx.t, fx, fx.sub2.id)
    await runSteps(fx.t)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, root.id)).id],
    })
    await runSteps(fx.t)
    // the subtask waits in the project's item, its comments with it
    expect(await countOf(fx.t, sub.id)).toBe(0)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, fx.sub2.id)).id],
    })
    await runSteps(fx.t)
    expect(await stateOf(fx.t, sub.id)).toEqual({ count: 3, counting: false })

    // a subtask whose project item is purged goes for good with its count
    const third = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
    })
    const root2 = await createTask(fx.t, fx, 'Root 2')
    const lost = await createTask(fx.t, fx, 'Lost', { project_id: third.id, parent_id: root2.id })
    await appPost(fx, fx.user, lost)
    await deleteTask(fx.t, fx, root2.id, { subtask_ids: [lost.id] })
    await deleteProject(fx.t, fx, third.id)
    await runSteps(fx.t)
    await as(fx.t, fx.admin).mutation(api.deletedItems.purge, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, third.id)).id],
    })
    await runSteps(fx.t)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, root2.id)).id],
    })
    await runSteps(fx.t)
    expect(await counter(fx.t, lost.id)).toBeNull()
    expect(await rateOf(fx.t, fx.user.id, lost.id)).toBeNull()
  })
})

describe('archive refusals over REST and MCP', () => {
  it('refuses the whole update past the rate and while the count runs, its field changes too', async () => {
    const fx = await setup()
    for (let i = 0; i < 5; i++) await restPost(fx)
    for (let i = 0; i < 5; i++) await mcpPost(fx)
    const rest = (task: Doc<'issues'>) =>
      fx.t.mutation(internal.machine.rest.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: 'drive',
        ref: `QN-${task.num}`,
        body: JSON.stringify({ title: 'Renamed', archived: true, archive_reason: 'Shipped' }),
      })
    const mcp = (task: Doc<'issues'>) =>
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        ref: `QN-${task.num}`,
        title: 'Renamed',
        archived: true,
        archive_reason: 'Shipped',
      })
    for (const update of [rest(fx.task), mcp(fx.task)])
      expect(await refusal(update)).toMatchObject({ reason: COMMENT_RATE, retry_after: 60 })
    const counting = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantComments(fx, 6, { task: counting, body: 'x'.repeat(1000) })
    Object.assign(COUNT_BUDGET.post, { bytes: 2_000, part: 4 * 1024 * 1024 })
    for (const update of [rest(counting), mcp(counting)])
      expect(await refusal(update)).toMatchObject({ reason: COMMENTS_COUNTING })
    for (const task of [fx.task, counting]) {
      const row = await fx.t.run((ctx) => byId(ctx, 'issues', task.id))
      expect(row?.title).toBe(task.title)
      expect(row?.archived_at).toBeUndefined()
    }
  })
})

describe('reading a count in parts', () => {
  /* The QueryCtx of threadCtx, counting its reads. */
  function countedCtx(thread: Doc<'comments'>[]) {
    const reads = { take: 0, collect: 0 }
    const inner = threadCtx(thread)
    const query = () => ({
      withIndex: (index: string, build: (q: Builder) => Builder) => {
        const range = inner.db.query('comments').withIndex(index as 'by_issue', build as never)
        return {
          take: (n: number) => {
            reads.take++
            return range.take(n)
          },
          collect: () => {
            reads.collect++
            return range.collect()
          },
        }
      },
    })
    return { ctx: { db: { query } } as unknown as QueryCtx, reads }
  }

  it('reads one range a part, and a group of one time again only when a part ends inside it', async () => {
    const budget = { ...COUNT_BUDGET.post, rows: LIMITS.comments.max }
    const apart = countedCtx(Array.from({ length: 30 }, (_, n) => fakeComment(n, 1_000 + n)))
    expect(await countPage(apart.ctx, 'task', COUNT_START, budget)).toMatchObject({
      rows: 30,
      done: true,
    })
    // five comments, then four, and one past them a part
    expect(apart.reads).toEqual({ take: 8, collect: 0 })
    const tied = countedCtx(
      Array.from({ length: 30 }, (_, n) => fakeComment(n, 1_000 + Math.floor(n / 2))),
    )
    expect(await countPage(tied.ctx, 'task', COUNT_START, budget)).toMatchObject({
      rows: 30,
      done: true,
    })
    expect(tied.reads.collect).toBeGreaterThan(0)
  })

  it("counts about 1.5 MiB of short comments in a post's own transaction, and no more", async () => {
    const fx = await setup()
    const fits = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const long = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    for (let i = 0; i < 6; i++)
      await plantComments(fx, 100, { task: fits, body: 'x'.repeat(2_000) })
    for (let i = 0; i < 9; i++)
      await plantComments(fx, 100, { task: long, body: 'x'.repeat(2_000) })
    await appPost(fx, fx.user, fits)
    expect(await countOf(fx.t, fits.id)).toBe(601)
    expect((await refusal(appPost(fx, fx.user, long))).reason).toBe(COMMENTS_COUNTING)
  })
})
