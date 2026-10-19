/* The size limits of one task's family and followers (lib/taskLimits.ts),
 * on the app's mutations, REST and MCP, which share one model rule each.
 *
 *   1. One level of subtasks: no subtask as a parent, no parent for a task
 *      with subtasks, archived ones included, and at most SUBTASK_MAX
 *      subtasks. Shapes stored before the rules stay readable and can be
 *      taken apart.
 *   2. At most FOLLOWER_MAX followers: a follow by hand is refused there, a
 *      comment or a mention adds no follower but still goes through, and a
 *      new assignee or reviewer still follows.
 *   3. A comment on a task with many followers whose items sit at the item
 *      cap reads a bounded share of each item and trims the rest in the
 *      background. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal, RefusalCode } from '../lib/functions'
import {
  FOLLOWER_MAX,
  FOLLOWERS_FULL,
  PARENT_FULL,
  PARENT_IS_SUBTASK,
  SUBTASK_MAX,
  SUBTASK_WITH_SUBTASKS,
} from '../lib/taskLimits'
import { INLINE_TRIMS, ITEM_UNREAD_CAP, notifyCommentInsert } from '../model/messages'
import {
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  plantSubscription,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

type Fx = OrgFixture & { t: T }

/* withOrg, with the agent holding Edit on TBED for REST and MCP. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  return { t, ...f }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

const key = (issue: Doc<'issues'>) => `QN-${issue.num}`

const row = (t: T, id: string) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()) as Doc<'issues'>,
  )

/* The three ways to create a subtask, each as its own surface's caller. */
const creates = (fx: Fx, parent: Doc<'issues'>) => ({
  app: () =>
    as(fx.t, fx.admin).mutation(api.issues.create, {
      org_id: fx.org.id,
      id: uuid(),
      project_id: fx.sub.id,
      title: 'New subtask',
      parent_id: parent.id,
    }),
  rest: () =>
    fx.t.mutation(internal.machine.rest.createIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      body: JSON.stringify({ project: fx.sub.key, title: 'New subtask', parent: key(parent) }),
    }),
  mcp: () =>
    fx.t.mutation(internal.machine.mcp.createIssue, {
      callerId: fx.agent.id,
      access: 'write',
      project: fx.sub.key,
      title: 'New subtask',
      parent: key(parent),
    }),
})

/* The three ways to give `child` the parent `parent`. */
const reparents = (fx: Fx, child: Doc<'issues'>, parent: Doc<'issues'>) => ({
  app: () =>
    as(fx.t, fx.admin).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: child.id,
      patch: { parent_id: parent.id },
    }),
  rest: () =>
    fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(child),
      body: JSON.stringify({ parent: key(parent) }),
    }),
  mcp: () =>
    fx.t.mutation(internal.machine.mcp.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      ref: key(child),
      parent: key(parent),
    }),
})

/* -------------------------------------------------- 1. one level of subtasks */

describe('one level of subtasks', () => {
  it('refuses a parent that is a subtask on every surface, and takes a top-level one', async () => {
    const fx = await setup()
    const top = await task(fx, { title: 'Top' })
    const sub = await task(fx, { parent_id: top.id })
    const lone = await task(fx)
    for (const make of Object.values(creates(fx, sub))) {
      await refused(make(), 'rule', PARENT_IS_SUBTASK)
    }
    for (const change of Object.values(reparents(fx, lone, sub))) {
      await refused(change(), 'rule', PARENT_IS_SUBTASK)
    }
    expect(await row(fx.t, lone.id)).toEqual(lone)
    for (const make of Object.values(creates(fx, top))) await make()
    const kids = await fx.t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', top.id))
        .collect(),
    )
    expect(kids).toHaveLength(4)
  })

  it('refuses a parent for a task with subtasks, archived ones included, and always detaches', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent' })
    const group = await task(fx, { title: 'Group' })
    await task(fx, { parent_id: group.id, archived_at: NOW })
    for (const change of Object.values(reparents(fx, group, parent))) {
      await refused(change(), 'rule', SUBTASK_WITH_SUBTASKS)
    }
    expect(await row(fx.t, group.id)).toEqual(group)
    // a task without subtasks takes the same parent
    const lone = await task(fx)
    await reparents(fx, lone, parent).app()
    expect((await row(fx.t, lone.id)).parent_id).toBe(parent.id)
  })

  it('tells the app whether a task can take a parent, archived subtasks included', async () => {
    const fx = await setup()
    const lone = await task(fx)
    const former = await task(fx)
    await task(fx, { parent_id: former.id, archived_at: NOW })
    const takes = (issue: Doc<'issues'>) =>
      as(fx.t, fx.admin).query(api.issues.takesParent, { org_id: fx.org.id, id: issue.id })
    expect(await takes(lone)).toBe(true)
    expect(await takes(former)).toBe(false)
  })

  it('keeps a legacy chain readable and editable, and lets it be taken apart', async () => {
    const fx = await setup()
    // a chain from before the one level of subtasks
    const top = await task(fx, { title: 'Top' })
    const mid = await task(fx, { parent_id: top.id, title: 'Mid' })
    const leaf = await task(fx, { parent_id: mid.id, title: 'Leaf' })
    const read = await fx.t.query(internal.machine.rest.getIssue, {
      callerId: fx.agent.id,
      access: 'read',
      ref: key(leaf),
      today: TODAY,
    })
    expect(read).toMatchObject({ parent_id: mid.id, has_hidden_parent: false })
    const renamed = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(mid),
      body: JSON.stringify({ title: 'Mid, renamed' }),
    })
    expect(renamed).toMatchObject({ title: 'Mid, renamed', parent_id: top.id })
    // detaching always passes, and the detached middle keeps its subtask
    await as(fx.t, fx.admin).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: mid.id,
      patch: { parent_id: null },
    })
    expect((await row(fx.t, mid.id)).parent_id).toBeUndefined()
    expect((await row(fx.t, leaf.id)).parent_id).toBe(mid.id)
  })

  it(`counts archived subtasks toward ${SUBTASK_MAX} and refuses the next one`, async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Full soon' })
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < SUBTASK_MAX - 1; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: fx.org.id,
          project_id: fx.sub.id,
          parent_id: parent.id,
          num: 50_000 + i,
          title: `Step ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          ...(i === 0 ? { archived_at: NOW } : {}),
          created_at: NOW,
          updated_at: NOW,
        })
    })
    const kit = creates(fx, parent)
    // the hundredth fits, the archived subtask included
    await kit.app()
    for (const make of Object.values(kit)) await refused(make(), 'rule', PARENT_FULL)
    const lone = await task(fx)
    for (const change of Object.values(reparents(fx, lone, parent))) {
      await refused(change(), 'rule', PARENT_FULL)
    }
    expect(await row(fx.t, lone.id)).toEqual(lone)
  })
})

/* -------------------------------------------------------- 2. follower limit */

/* Plants `n` people who can see TBED, each following `issue`, and answers
 * their profiles. */
async function plantFollowers(fx: Fx, issue: Doc<'issues'>, n: number) {
  return await fx.t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (let i = 0; i < n; i++) {
      const id = uuid()
      const _id = await ctx.db.insert('profiles', {
        id,
        org_id: fx.org.id,
        name: `Follower ${i}`,
        initials: 'FO',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: fx.meta.id,
        profile_id: id,
        level: 'viewer',
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: issue.id,
        profile_id: id,
        created_at: NOW,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })
}

const followers = (t: T, issueId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issueId))
        .collect()
    ).map((s) => s.profile_id),
  )

describe('the follower limit', () => {
  it(`refuses a follow by hand past ${FOLLOWER_MAX} on every surface, and never refuses a follower`, async () => {
    const fx = await setup()
    const issue = await task(fx)
    await plantFollowers(fx, issue, FOLLOWER_MAX - 1)
    const app = (who: Doc<'profiles'>) =>
      as(fx.t, who).mutation(api.issues.subscribe, { org_id: fx.org.id, issue_id: issue.id })
    // the hundredth follows
    await app(fx.user)
    expect(await followers(fx.t, issue.id)).toHaveLength(FOLLOWER_MAX)
    await refused(app(fx.admin), 'rule', FOLLOWERS_FULL)
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.setSubscriber, {
        org_id: fx.org.id,
        issue_id: issue.id,
        profile_id: fx.guest.id,
        subscribed: true,
      }),
      'rule',
      FOLLOWERS_FULL,
    )
    await refused(
      fx.t.mutation(internal.machine.discussion.restFollowTask, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
      }),
      'rule',
      FOLLOWERS_FULL,
    )
    await refused(
      fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        following: true,
      }),
      'rule',
      FOLLOWERS_FULL,
    )
    // following again changes nothing and is no refusal; leaving makes room
    await app(fx.user)
    await as(fx.t, fx.user).mutation(api.issues.unsubscribe, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    await app(fx.admin)
    const now = await followers(fx.t, issue.id)
    expect(now).toHaveLength(FOLLOWER_MAX)
    expect(now).toContain(fx.admin.id)
    expect(now).not.toContain(fx.user.id)
  })

  it('adds no follower on a comment or a mention past the limit, and still delivers both', async () => {
    const fx = await setup()
    const full = await task(fx, { title: 'Full' })
    const crowd = await plantFollowers(fx, full, FOLLOWER_MAX)
    const comment = (issue: Doc<'issues'>) =>
      as(fx.t, fx.user).mutation(api.comments.create, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: issue.id,
        body: `Over to @[Admin](user:${fx.admin.id})`,
      })
    await comment(full)
    const after = await followers(fx.t, full.id)
    expect(after).toHaveLength(FOLLOWER_MAX)
    expect(after).not.toContain(fx.user.id)
    expect(after).not.toContain(fx.admin.id)
    expect((await messagesFor(fx.t, fx.admin.id, full.id)).map((m) => m.detail)).toEqual([
      'Mentioned you in a comment',
    ])
    expect((await messagesFor(fx.t, crowd[0].id, full.id)).map((m) => m.detail)).toEqual([
      'New comment',
    ])
    // below the limit both the author and the mentioned person follow
    const roomy = await task(fx, { title: 'Roomy' })
    await plantFollowers(fx, roomy, FOLLOWER_MAX - 2)
    await comment(roomy)
    expect(await followers(fx.t, roomy.id)).toEqual(
      expect.arrayContaining([fx.user.id, fx.admin.id]),
    )
  })

  it('lists followers and candidates for a lead in an organization of thousands', async () => {
    // one sight check per person passed 4,096 index ranges here
    const fx = await setup(newT({ transactionLimits: true }))
    const issue = await task(fx)
    const crowd = await plantFollowers(fx, issue, FOLLOWER_MAX)
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 3000; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: fx.org.id,
          name: `Elsewhere ${i}`,
          initials: 'EL',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    const roster = await as(fx.t, fx.admin).query(api.issues.subscribers, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    expect(roster.canManage).toBe(true)
    expect(roster.subscribers).toHaveLength(FOLLOWER_MAX)
    expect(roster.subscribers).toEqual(expect.arrayContaining(crowd.map((p) => p.id)))
    // people who see TBED, and none of the 3,000 who do not
    expect(roster.candidates).toEqual(expect.arrayContaining([fx.user.id, fx.agent.id]))
    expect(roster.candidates.length).toBeLessThan(10)
  })

  it('lets a new assignee and a new reviewer pass the limit', async () => {
    const fx = await setup()
    const issue = await task(fx, { status: 'progress' })
    await plantFollowers(fx, issue, FOLLOWER_MAX)
    const update = (patch: Record<string, unknown>) =>
      as(fx.t, fx.admin).mutation(api.issues.update, { org_id: fx.org.id, id: issue.id, patch })
    await update({ assignee_id: fx.user.id })
    expect(await followers(fx.t, issue.id)).toHaveLength(FOLLOWER_MAX + 1)
    await update({ reviewer_id: fx.admin.id, status: 'review' })
    const now = await followers(fx.t, issue.id)
    expect(now).toHaveLength(FOLLOWER_MAX + 2)
    expect(now).toEqual(expect.arrayContaining([fx.user.id, fx.admin.id]))
    expect((await messagesFor(fx.t, fx.admin.id, issue.id)).map((m) => m.detail)).toEqual([])
    expect((await messagesFor(fx.t, fx.user.id, issue.id)).map((m) => m.detail)[0]).toBe(
      'Assigned to you',
    )
  })
})

/* ------------------------------------------------- 3. bounded inbox reads */

describe('a comment on a task with many followers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads a bounded share of each item and trims the rest in the background', async () => {
    const t = newT({ transactionLimits: true })
    const fx = await setup(t)
    const issue = await task(fx)
    const crowd = await plantFollowers(fx, issue, 120)
    // every follower's item sits at the cap, as for an agent that never reads
    await t.run(async (ctx) => {
      for (const p of crowd)
        for (let i = 0; i < ITEM_UNREAD_CAP; i++)
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: fx.org.id,
            recipient_id: p.id,
            issue_id: issue.id,
            issue_title: issue.title,
            kind: 'change',
            detail: `Old news ${i}`,
            created_at: `2025-12-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          })
    })
    await plantMessage(t, { org_id: fx.org.id, recipient_id: fx.admin.id, issue_id: issue.id })
    await plantSubscription(t, { issue_id: issue.id, profile_id: fx.admin.id })
    const read = await t.run(async (ctx) => {
      await notifyCommentInsert(ctx, {
        comment: { body: 'Any news?' },
        issue,
        actor: fx.user,
        now: NOW,
      })
      return (await ctx.meta.getTransactionMetrics()).documentsRead.used
    })
    // reading each item whole would read 121 x 51 rows, past 6,000
    expect(read).toBeLessThan(INLINE_TRIMS * (ITEM_UNREAD_CAP + 2) + 121 * 8)
    // until the background trim runs, the later items hold one row more
    const sizes = async () =>
      await t.run(async (ctx) => {
        const out: number[] = []
        for (const p of crowd)
          out.push(
            (
              await ctx.db
                .query('messages')
                .withIndex('by_recipient_issue', (q) =>
                  q.eq('recipient_id', p.id).eq('issue_id', issue.id),
                )
                .collect()
            ).length,
          )
        return out
      })
    expect(Math.max(...(await sizes()))).toBe(ITEM_UNREAD_CAP + 1)
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(new Set(await sizes())).toEqual(new Set([ITEM_UNREAD_CAP]))
    // the newest row of every item is the comment
    const last = await messagesFor(t, crowd[119].id, issue.id)
    expect(last.at(-1)?.detail).toBe('New comment')
  })
})
