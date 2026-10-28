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

import { getDocumentSize } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { RUN, TASK_PAGE } from '../internal/commentCountsBackfill'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS, tooManyComments } from '../lib/limits'
import { sha256hex } from '../machine/auth'
import {
  COMMENT_RATE,
  COMMENTS_COUNTING,
  COUNT_BUDGET,
  START as COUNT_START,
  countPage,
  countRow,
  SWEEP_BATCH,
  tallyComments,
} from '../model/commentLimits'
import { STORED_ROW_MAX_BYTES } from '../model/deletedItems'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { deleteTask, installTrashTimers, itemFor, runSteps, START } from './trash.setup'

installTrashTimers()

const DEFAULTS = {
  post: { ...COUNT_BUDGET.post },
  step: { ...COUNT_BUDGET.step },
  page: { ...TASK_PAGE },
  run: { ...RUN },
}
afterEach(() => {
  Object.assign(COUNT_BUDGET.post, DEFAULTS.post)
  Object.assign(COUNT_BUDGET.step, DEFAULTS.step)
  Object.assign(TASK_PAGE, DEFAULTS.page)
  Object.assign(RUN, DEFAULTS.run)
})

type Fx = OrgFixture & { t: T; task: Doc<'issues'> }

/* A task `f.user` creates in the app, so it is counted from its start. */
async function createTask(t: T, f: OrgFixture, title = 'Thread'): Promise<Doc<'issues'>> {
  const id = uuid()
  await as(t, f.user).mutation(api.issues.create, {
    org_id: f.org.id,
    id,
    project_id: f.sub.id,
    title,
  })
  return (await t.run((ctx) => byId(ctx, 'issues', id))) as Doc<'issues'>
}

/* withOrg, with the agent holding Edit on TBED and a task in FW. */
async function setup(): Promise<Fx> {
  const t = newT()
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
  'this task has reached 1,000 comments, the most a task can have, so the archive reason cannot be posted and the task was not archived. Delete comments until it has fewer than 1,000, then archive it again.'

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
      message: "Qivo is still counting this task's comments. Try again shortly.",
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
        "Qivo is still counting this task's comments, so the archive reason cannot be posted and the task was not archived. Try again shortly.",
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

  it('restarts the counts left under way, those counted least far first', async () => {
    const fx = await setup()
    const tasks = [
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id }),
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id }),
    ]
    const rows = await plantComments(fx, 3, { task: tasks[0] })
    await plantComments(fx, 2, { task: tasks[1] })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('task_comment_counts', {
        org_id: fx.org.id,
        issue_id: tasks[0].id,
        count: 1,
        counted: rows[0]._creationTime,
      })
      await ctx.db.insert('task_comment_counts', {
        org_id: fx.org.id,
        issue_id: tasks[1].id,
        count: 0,
        counted: COUNT_START,
      })
    })
    await fx.t.mutation(internal.commentLimits.recover, {})
    await runSteps(fx.t)
    expect(await stateOf(fx.t, tasks[0].id)).toEqual({ count: 3, counting: false })
    expect(await stateOf(fx.t, tasks[1].id)).toEqual({ count: 2, counting: false })
    // an exact count is left alone
    await fx.t.mutation(internal.commentLimits.recover, {})
    await runSteps(fx.t)
    expect(await countOf(fx.t, tasks[0].id)).toBe(3)
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
    expect(await answer(await post(fx.task))).toEqual({
      status: 429,
      retry: '40',
      body: { error: tooManyComments(40) },
    })

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
      body: { error: "Qivo is still counting this task's comments. Try again shortly." },
    })
  })
})
