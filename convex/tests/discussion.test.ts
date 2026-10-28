/* Comments, the inbox and follows over REST and MCP (machine/discussion.ts),
 * through the model functions the app runs too.
 *
 *   1. Editing and deleting a comment: the author or a project lead, mention
 *      fan-out on edit, and comments on hidden tasks answering like unknown
 *      ones.
 *   2. Following: own follows only, the single-task read's `following` and
 *      `followers`, and news reaching an agent that follows a task.
 *   3. Reading the inbox: what the app lists (tasks in the caller's working
 *      set, so not archived ones), the live title, the app's item fold,
 *      filters, paging and the bounded read of a large backlog.
 *   4. Changing the inbox: each action by task, `all` for read and remove
 *      with only readable tasks named, the input rules on both surfaces, and
 *      own rows only.
 *   5. Over HTTP: the routes, their status codes, and a Viewer agent's key
 *      refused even for its own inbox and follows. The read-only sweep for
 *      every write entry is credentialAccess.test.ts. */
/// <reference types="vite/client" />

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal, RefusalCode } from '../lib/functions'
import { INBOX_LIMIT, LIMITS } from '../lib/limits'
import { sha256hex } from '../machine/auth'
import { INBOX_TASKS_MAX } from '../machine/discussion'
import { OFFSET_SENTENCE } from '../machine/shared'
import { ITEM_UNREAD_CAP } from '../model/messages'
import {
  allMessages,
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  plantSeat,
  plantSubscription,
  type T,
  TODAY,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

type Fx = OrgFixture & {
  t: T
  /** a task in FW the agent can read and write */
  task: Doc<'issues'>
  /** a task in SKNK, which the agent cannot see */
  secret: Doc<'issues'>
}

/* withOrg, with the agent holding Edit on TBED (FW and PCB) and no access to
 * SKNK. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Visible' })
  const secret = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id, title: 'Secret' })
  return { t, ...f, task, secret }
}

const W = { access: 'write' } as const
const R = { access: 'read' } as const
const key = (issue: Doc<'issues'>) => `QN-${issue.num}`

/* A comment on `issue` by `author`. */
async function plantComment(
  t: T,
  issue: Doc<'issues'>,
  author: Doc<'profiles'>,
  body = 'Original',
): Promise<Doc<'comments'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('comments', {
      id: uuid(),
      issue_id: issue.id,
      author: author.id,
      body,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'comments'>
  })
}

const commentRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('comments')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const follows = (t: T, issueId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issueId))
        .collect()
    ).map((row) => row.profile_id),
  )

const mention = (p: Doc<'profiles'>) => `@[${p.name}](user:${p.id})`

/* ------------------------------------------------------------- 1. comments */

describe('editing and deleting comments', () => {
  it('the author edits on both surfaces; the same text again changes and stamps nothing', async () => {
    const fx = await setup()
    const own = await plantComment(fx.t, fx.task, fx.agent)
    const viaMcp = JSON.parse(
      await fx.t.mutation(internal.machine.discussion.mcpUpdateComment, {
        callerId: fx.agent.id,
        ...W,
        comment: own.id.toUpperCase(),
        body: '\nEdited over MCP  ',
      }),
    )
    expect(Object.keys(viaMcp).slice(0, 4)).toEqual(['id', 'task', 'changed', 'body'])
    expect(viaMcp).toMatchObject({
      id: own.id,
      task: key(fx.task),
      changed: true,
      body: 'Edited over MCP',
      author_id: fx.agent.id,
      edited_by_id: fx.agent.id,
      edited_by_name: 'Relay',
    })
    const stamped = await commentRow(fx.t, own.id)
    expect(stamped?.edited_at).toBe(viaMcp.edited_at)
    const again = JSON.parse(
      await fx.t.mutation(internal.machine.discussion.mcpUpdateComment, {
        callerId: fx.agent.id,
        ...W,
        comment: own.id,
        body: 'Edited over MCP',
      }),
    )
    expect(again.changed).toBe(false)
    expect(await commentRow(fx.t, own.id)).toEqual(stamped)
    const viaRest = await fx.t.mutation(internal.machine.discussion.restUpdateComment, {
      callerId: fx.agent.id,
      ...W,
      ref: own.id,
      body: JSON.stringify({ body: 'Edited over REST' }),
    })
    expect(viaRest).toMatchObject({ id: own.id, task_id: fx.task.id, body: 'Edited over REST' })
  })

  it('an edit notifies only the mentions it adds', async () => {
    const fx = await setup()
    const own = await plantComment(fx.t, fx.task, fx.agent, `Hi ${mention(fx.user)}`)
    await fx.t.mutation(internal.machine.discussion.mcpUpdateComment, {
      callerId: fx.agent.id,
      ...W,
      comment: own.id,
      body: `Hi ${mention(fx.user)} and ${mention(fx.admin)}`,
    })
    expect(await messagesFor(fx.t, fx.user.id, fx.task.id)).toEqual([])
    const told = await messagesFor(fx.t, fx.admin.id, fx.task.id)
    expect(told.map((m) => [m.kind, m.detail, m.actor_id])).toEqual([
      ['mention', 'Mentioned you in a comment', fx.agent.id],
    ])
    // the person mentioned follows the task now
    expect(await follows(fx.t, fx.task.id)).toContain(fx.admin.id)
  })

  it("someone else's comment needs a lead of its project; the lead may edit and delete it", async () => {
    const fx = await setup()
    const theirs = await plantComment(fx.t, fx.task, fx.user)
    await refused(
      fx.t.mutation(internal.machine.discussion.mcpUpdateComment, {
        callerId: fx.agent.id,
        ...W,
        comment: theirs.id,
        body: 'Not mine',
      }),
      'forbidden',
      'only the author or a project lead can edit this comment',
    )
    await refused(
      fx.t.mutation(internal.machine.discussion.restDeleteComment, {
        callerId: fx.agent.id,
        ...W,
        ref: theirs.id,
      }),
      'forbidden',
      'only the author or a project lead can delete this comment',
    )
    const byAgent = await plantComment(fx.t, fx.task, fx.agent)
    // f.user leads TBED, so FW too
    const edited = await fx.t.mutation(internal.machine.discussion.restUpdateComment, {
      callerId: fx.user.id,
      ...W,
      ref: byAgent.id,
      body: JSON.stringify({ body: 'Tidied by the lead' }),
    })
    expect(edited).toMatchObject({ author_id: fx.agent.id, edited_by_id: fx.user.id })
    expect(
      await fx.t.mutation(internal.machine.discussion.restDeleteComment, {
        callerId: fx.user.id,
        ...W,
        ref: byAgent.id,
      }),
    ).toEqual({ deleted: true, id: byAgent.id, task_id: fx.task.id })
    expect(await commentRow(fx.t, byAgent.id)).toBeNull()
  })

  it('a comment on a hidden task answers like an unknown one, before any rule', async () => {
    const fx = await setup()
    // the agent's own comment, on a task it can no longer see
    const hidden = await plantComment(fx.t, fx.secret, fx.agent)
    for (const ref of [hidden.id, uuid(), 'nope']) {
      await refused(
        fx.t.mutation(internal.machine.discussion.mcpDeleteComment, {
          callerId: fx.agent.id,
          ...W,
          comment: ref,
        }),
        'not_found',
        `comment "${ref}" not found (or not visible to you)`,
      )
      await refused(
        fx.t.mutation(internal.machine.discussion.restUpdateComment, {
          callerId: fx.agent.id,
          ...W,
          ref,
          body: 'not even JSON',
        }),
        'not_found',
        'comment not found',
      )
    }
    expect(await commentRow(fx.t, hidden.id)).not.toBeNull()
  })

  it('refuses a blank body and a REST body without one', async () => {
    const fx = await setup()
    const own = await plantComment(fx.t, fx.task, fx.agent)
    await refused(
      fx.t.mutation(internal.machine.discussion.mcpUpdateComment, {
        callerId: fx.agent.id,
        ...W,
        comment: own.id,
        body: '   ',
      }),
      'rule',
      'a comment cannot be empty',
    )
    for (const [body, code, sentence] of [
      ['{', 'bad_request', 'request body must be JSON'],
      ['{}', 'bad_request', 'body must be a non-empty string'],
      ['{"body":""}', 'rule', 'a comment cannot be empty'],
    ] as const) {
      await refused(
        fx.t.mutation(internal.machine.discussion.restUpdateComment, {
          callerId: fx.agent.id,
          ...W,
          ref: own.id,
          body,
        }),
        code,
        sentence,
      )
    }
    expect((await commentRow(fx.t, own.id))?.body).toBe('Original')
  })

  it('the app edits and deletes through the same rule', async () => {
    const fx = await setup()
    const theirs = await plantComment(fx.t, fx.task, fx.admin)
    // f.guest holds User on TBED but did not write it and leads nothing
    await refused(
      as(fx.t, fx.guest).mutation(api.comments.update, {
        org_id: fx.org.id,
        id: theirs.id,
        body: 'Guest edit',
      }),
      'forbidden',
      'only the author or a project lead can edit this comment',
    )
    await as(fx.t, fx.user).mutation(api.comments.update, {
      org_id: fx.org.id,
      id: theirs.id,
      body: 'Lead edit',
    })
    expect(await commentRow(fx.t, theirs.id)).toMatchObject({
      body: 'Lead edit',
      edited_by: fx.user.id,
    })
    await as(fx.t, fx.admin).mutation(api.comments.remove, { org_id: fx.org.id, id: theirs.id })
    expect(await commentRow(fx.t, theirs.id)).toBeNull()
  })
})

/* -------------------------------------------------------------- 2. follows */

describe('following tasks', () => {
  it('follows and unfollows on both surfaces; asking for the current state changes nothing', async () => {
    const fx = await setup()
    const follow = (following: boolean) =>
      fx.t
        .mutation(internal.machine.discussion.mcpSetFollowing, {
          callerId: fx.agent.id,
          ...W,
          ref: String(fx.task.num),
          following,
        })
        .then((text) => JSON.parse(text))
    expect(await follow(true)).toEqual({ key: key(fx.task), following: true, changed: true })
    expect(await follow(true)).toEqual({ key: key(fx.task), following: true, changed: false })
    expect(await follows(fx.t, fx.task.id)).toEqual([fx.agent.id])
    const off = await fx.t.mutation(internal.machine.discussion.restUnfollowTask, {
      callerId: fx.agent.id,
      ...W,
      ref: key(fx.task),
    })
    expect(off).toEqual({ id: fx.task.id, key: key(fx.task), following: false, changed: true })
    expect(await follows(fx.t, fx.task.id)).toEqual([])
  })

  it('the single-task read shows whether I follow and who does', async () => {
    const fx = await setup()
    await plantSubscription(fx.t, { issue_id: fx.task.id, profile_id: fx.user.id })
    await plantSubscription(fx.t, { issue_id: fx.task.id, profile_id: fx.admin.id })
    const before = await fx.t.query(internal.machine.rest.getIssue, {
      today: TODAY,
      callerId: fx.agent.id,
      ...R,
      ref: key(fx.task),
    })
    expect(before.following).toBe(false)
    // by name: admin, user
    expect(before.followers).toEqual([
      { id: fx.admin.id, name: 'admin' },
      { id: fx.user.id, name: 'user' },
    ])
    await fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
      callerId: fx.agent.id,
      ...W,
      ref: key(fx.task),
      following: true,
    })
    const after = JSON.parse(
      await fx.t.query(internal.machine.mcp.getIssue, {
        today: TODAY,
        callerId: fx.agent.id,
        ...R,
        ref: key(fx.task),
      }),
    )
    expect(after.following).toBe(true)
    expect(after.followers.map((p: { name: string }) => p.name)).toEqual(['admin', 'Relay', 'user'])
  })

  it('a hidden task answers like an unknown one and gains no follower', async () => {
    const fx = await setup()
    for (const ref of [key(fx.secret), fx.secret.id, 'QN-999999']) {
      await refused(
        fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
          callerId: fx.agent.id,
          ...W,
          ref,
          following: true,
        }),
        'not_found',
        `task "${ref}" not found (or not visible to you)`,
      )
      await refused(
        fx.t.mutation(internal.machine.discussion.restFollowTask, {
          callerId: fx.agent.id,
          ...W,
          ref,
        }),
        'not_found',
        'task not found',
      )
    }
    expect(await follows(fx.t, fx.secret.id)).toEqual([])
  })

  it('an agent that follows a task hears about changes to it in its inbox', async () => {
    const fx = await setup()
    await fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
      callerId: fx.agent.id,
      ...W,
      ref: key(fx.task),
      following: true,
    })
    await as(fx.t, fx.user).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: fx.task.id,
      patch: { priority: 'high' },
    })
    const { items } = JSON.parse(
      await fx.t.query(internal.machine.discussion.mcpListInbox, { callerId: fx.agent.id, ...R }),
    )
    expect(items).toHaveLength(1)
    expect(items[0].task.key).toBe(key(fx.task))
    expect(items[0].messages[0]).toMatchObject({
      kind: 'change',
      detail: 'Priority: Medium → High',
      actor_id: fx.user.id,
      actor_name: 'user',
      read_at: null,
    })
  })
})

/* ------------------------------------------------------------ 3. the inbox */

/* list_inbox's whole answer. */
const pageMcp = async (fx: Fx, args: Record<string, unknown> = {}, callerId = fx.agent.id) =>
  JSON.parse(
    await fx.t.query(internal.machine.discussion.mcpListInbox, { callerId, ...R, ...args }),
  ) as {
    items: {
      task: { id: string; key: string; title: string }
      unread_count: number
      dropped_count: number
      latest_at: string
      snoozed_until: string | null
      messages: { id: string; detail: string; read_at: string | null }[]
    }[]
    truncated: boolean
  }

/* list_inbox's items. */
const listMcp = async (fx: Fx, args: Record<string, unknown> = {}, callerId = fx.agent.id) =>
  (await pageMcp(fx, args, callerId)).items

describe('reading the inbox', () => {
  it('lists only tasks the caller can read, with the live title, one item per task', async () => {
    const fx = await setup()
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id }
    const older = await plantMessage(fx.t, {
      ...base,
      issue_id: fx.task.id,
      issue_title: 'Stale stored title',
      created_at: '2026-01-02T00:00:00.000Z',
      read_at: '2026-01-02T01:00:00.000Z',
    })
    const newer = await plantMessage(fx.t, {
      ...base,
      issue_id: fx.task.id,
      actor_id: fx.user.id,
      created_at: '2026-01-03T00:00:00.000Z',
    })
    // a task the agent lost sight of, and a deleted one
    await plantMessage(fx.t, { ...base, issue_id: fx.secret.id, issue_title: 'Secret' })
    await plantMessage(fx.t, { ...base, issue_id: uuid(), issue_title: 'Deleted' })
    const items = await listMcp(fx)
    expect(items).toEqual([
      {
        task: { id: fx.task.id, key: key(fx.task), title: 'Visible', status: 'todo' },
        unread_count: 1,
        dropped_count: 0,
        latest_at: '2026-01-03T00:00:00.000Z',
        snoozed_until: null,
        messages: [
          {
            id: older.id,
            kind: 'change',
            detail: 'planted',
            actor_id: null,
            actor_name: null,
            created_at: older.created_at,
            read_at: older.read_at,
          },
          {
            id: newer.id,
            kind: 'change',
            detail: 'planted',
            actor_id: fx.user.id,
            actor_name: 'user',
            created_at: newer.created_at,
            read_at: null,
          },
        ],
      },
    ])
    expect(JSON.stringify(items)).not.toContain('Secret')
    // the rows about the hidden task stay stored for when access returns
    expect(await messagesFor(fx.t, fx.agent.id, fx.secret.id)).toHaveLength(1)
    // REST answers the same items
    expect(
      await fx.t.query(internal.machine.discussion.restListInbox, { callerId: fx.agent.id, ...R }),
    ).toEqual({ items, truncated: false })
  })

  it('keeps the dropped count of every item it lists when the inbox holds more unread messages than it reads', async () => {
    const fx = await setup()
    const tasks = await Promise.all(
      Array.from({ length: 11 }, () =>
        plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id }),
      ),
    )
    // 51 unread messages on each, more than INBOX_LIMIT in all
    for (const task of tasks) {
      await plantSubscription(fx.t, { issue_id: task.id, profile_id: fx.agent.id })
      await fx.t.run(async (ctx) => {
        for (let n = 0; n < ITEM_UNREAD_CAP + 1; n++) {
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: fx.org.id,
            recipient_id: fx.agent.id,
            issue_id: task.id,
            issue_title: task.title,
            kind: 'change',
            detail: `change ${n}`,
            created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
          })
        }
      })
    }
    // a comment on each makes its item drop two
    for (const task of tasks)
      await as(fx.t, fx.user).mutation(api.comments.create, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: task.id,
        body: 'news',
      })
    const page = await pageMcp(fx)
    expect(page.truncated).toBe(true)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((item) => item.dropped_count === 2)).toBe(true)
  })

  it(`says how many earlier unread messages an item past ${ITEM_UNREAD_CAP} dropped, until it is read`, async () => {
    const fx = await setup()
    await plantSubscription(fx.t, { issue_id: fx.task.id, profile_id: fx.agent.id })
    // a minute between bursts keeps the person inside the posting rate
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const comment = async () => {
      vi.setSystemTime(Date.now() + 60_000 / LIMITS.commentRate.max)
      await as(fx.t, fx.user).mutation(api.comments.create, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: fx.task.id,
        body: 'news',
      })
    }
    for (let n = 0; n < ITEM_UNREAD_CAP + 3; n++) await comment()
    const [item] = await listMcp(fx)
    expect([item.unread_count, item.dropped_count]).toEqual([ITEM_UNREAD_CAP, 3])
    const rest = await fx.t.query(internal.machine.discussion.restListInbox, {
      callerId: fx.agent.id,
      ...R,
    })
    expect(rest.items[0].dropped_count).toBe(3)
    // reading the item ends the unread run and its count
    await updateMcp(fx, { action: 'read', tasks: [key(fx.task)] })
    await comment()
    expect((await listMcp(fx))[0].dropped_count).toBe(0)
  })

  it('filters unread and snoozed items, orders by latest activity and pages', async () => {
    const fx = await setup()
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id }
    const tasks: Doc<'issues'>[] = []
    for (const day of [1, 2, 3, 4]) {
      const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
      tasks.push(task)
      await plantMessage(fx.t, {
        ...base,
        issue_id: task.id,
        created_at: `2026-02-0${day}T00:00:00.000Z`,
        // the second task's item is read
        read_at: day === 2 ? '2026-02-05T00:00:00.000Z' : undefined,
        // the third is snoozed
        snoozed_until: day === 3 ? '2099-01-01T00:00:00.000Z' : undefined,
      })
    }
    // a woken item floats by its wake time
    await fx.t.run(async (ctx) => {
      const rows = await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', fx.agent.id).eq('issue_id', tasks[0].id),
        )
        .collect()
      await ctx.db.patch(rows[0]._id, { woke_at: '2026-02-09T00:00:00.000Z' })
    })
    const keys = (items: { task: { key: string } }[]) => items.map((i) => i.task.key)
    const [a, b, c, d] = tasks.map(key)
    expect(keys(await listMcp(fx))).toEqual([a, d, b])
    expect((await listMcp(fx))[0].latest_at).toBe('2026-02-09T00:00:00.000Z')
    expect(keys(await listMcp(fx, { unread_only: true }))).toEqual([a, d])
    expect(keys(await listMcp(fx, { include_snoozed: true }))).toEqual([a, d, c, b])
    expect(keys(await listMcp(fx, { limit: 1, offset: 1 }))).toEqual([d])
    const rest = async (q: Record<string, string>) =>
      (
        await fx.t.query(internal.machine.discussion.restListInbox, {
          callerId: fx.agent.id,
          ...R,
          ...q,
        })
      ).items
    expect(keys(await rest({ unread_only: 'true', include_snoozed: 'true' }))).toEqual([a, d, c])
    expect(keys(await rest({ limit: '2', offset: '1' }))).toEqual([d, b])
    for (const [q, sentence] of [
      [{ unread_only: 'yes' }, 'unread_only must be true or false'],
      [{ include_snoozed: '1' }, 'include_snoozed must be true or false'],
      [{ offset: '-1' }, OFFSET_SENTENCE],
      [{ offset: '1.5' }, OFFSET_SENTENCE],
    ] as const) {
      await refused(rest(q), 'bad_request', sentence)
    }
    // a page size outside 1 to 200 is the registry's refusal on both surfaces
    for (const limit of [0, 201, 1.5]) {
      await refused(rest({ limit: String(limit) }), 'rule', LIMITS.listInbox.refusal)
      await refused(listMcp(fx, { limit }), 'rule', LIMITS.listInbox.refusal)
    }
    await refused(listMcp(fx, { offset: -1 }), 'bad_request', OFFSET_SENTENCE)
  })

  it('lists what the app lists: an archived task or one in an archived project leaves until restored', async () => {
    const fx = await setup()
    const archived = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const shelved = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub2.id })
    // the admin follows three tasks, and the user changes each of them
    for (const task of [fx.task, archived, shelved]) {
      await fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
        callerId: fx.admin.id,
        ...W,
        ref: key(task),
        following: true,
      })
      await as(fx.t, fx.user).mutation(api.issues.update, {
        org_id: fx.org.id,
        id: task.id,
        patch: { priority: 'high' },
      })
    }
    await as(fx.t, fx.user).mutation(api.issues.archive, { org_id: fx.org.id, id: archived.id })
    await as(fx.t, fx.admin).mutation(api.projects.archive, { org_id: fx.org.id, id: fx.sub2.id })
    // the background steps that mark the hidden tasks' messages read
    await fx.t.finishAllScheduledFunctions(() => {})
    // the admin keeps messages about all three, read for the hidden two. The
    // Archived notice arrived read and replaced the read priority change.
    const held = async (task: Doc<'issues'>) =>
      (await messagesFor(fx.t, fx.admin.id, task.id)).map((m) => [
        m.detail,
        m.read_at !== undefined,
      ])
    expect(await held(fx.task)).toEqual([['Priority: Medium → High', false]])
    expect(await held(archived)).toEqual([['Archived', true]])
    expect(await held(shelved)).toEqual([['Priority: Medium → High', true]])
    const listed = async () =>
      (await listMcp(fx, { include_snoozed: true }, fx.admin.id)).map((i) => i.task.id).sort()
    const inApp = async () => {
      const snapshot = await workspaceOf(as(fx.t, fx.admin))
      return [...new Set((snapshot?.messages ?? []).map((m) => m.issue_id))].sort()
    }
    expect(await listed()).toEqual([fx.task.id])
    expect(await inApp()).toEqual([fx.task.id])
    const rest = await fx.t.query(internal.machine.discussion.restListInbox, {
      callerId: fx.admin.id,
      ...R,
    })
    expect(rest.items.map((i) => i.task.id)).toEqual([fx.task.id])
    // unread refuses an archived task the caller can read, and read still
    // reaches it (archiveReads.test.ts covers every action)
    await refused(
      updateMcp(fx, { action: 'unread', tasks: [key(archived)] }, fx.admin.id),
      'rule',
      `${key(archived)} is archived and must be restored first`,
    )
    expect(await held(archived)).toEqual([['Archived', true]])
    const read = await updateMcp(fx, { action: 'read', tasks: [key(archived)] }, fx.admin.id)
    expect(read).toEqual({ action: 'read', tasks: [], has_more: false })
    // a restore brings the item back on both, with its stored messages
    await as(fx.t, fx.user).mutation(api.issues.unarchive, { org_id: fx.org.id, id: archived.id })
    await as(fx.t, fx.admin).mutation(api.projects.unarchive, {
      org_id: fx.org.id,
      id: fx.sub2.id,
    })
    const ids = [fx.task.id, archived.id, shelved.id].sort()
    expect(await listed()).toEqual(ids)
    expect(await inApp()).toEqual(ids)
    // the read Archived notice made way for the unread Restored one, as in the app
    const back = (await listMcp(fx, {}, fx.admin.id)).find((i) => i.task.id === archived.id)
    expect(back?.messages).toMatchObject([{ detail: 'Restored', read_at: null }])
  })

  it('reads only the newest messages of a backlog that outgrows one transaction, and says so', async () => {
    // Folding every message would read more documents than this allows.
    const fx = await setup(
      newT({
        transactionLimits: { documentsRead: 2 * INBOX_LIMIT + 100 },
      }),
    )
    const fresh = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await fx.t.run(async (ctx) => {
      for (let n = 0; n < 2 * INBOX_LIMIT + 200; n++) {
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: fx.org.id,
          recipient_id: fx.agent.id,
          issue_id: fx.task.id,
          issue_title: 'Backlog',
          kind: 'change',
          detail: 'backlog',
          created_at: `2026-01-01T00:00:00.${String(n % 1000).padStart(3, '0')}Z`,
        })
      }
    })
    await plantMessage(fx.t, {
      org_id: fx.org.id,
      recipient_id: fx.agent.id,
      issue_id: fresh.id,
      created_at: '2026-02-01T00:00:00.000Z',
    })
    const page = await pageMcp(fx)
    expect(page.truncated).toBe(true)
    expect(page.items.map((i) => [i.task.key, i.unread_count])).toEqual([
      [key(fresh), 1],
      [key(fx.task), INBOX_LIMIT - 1],
    ])
    const rest = await fx.t.query(internal.machine.discussion.restListInbox, {
      callerId: fx.agent.id,
      ...R,
      unread_only: 'true',
      limit: '1',
    })
    expect(rest).toEqual({ items: [page.items[0]], truncated: true })
  })

  it('reads unread messages newest first and read ones most recently read first, as the app does', async () => {
    const fx = await setup()
    const busy = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    // the n-th message, created n ms and read n s after the start of its day
    const row = (issue: Doc<'issues'>, n: number, read: boolean) => ({
      id: uuid(),
      org_id: fx.org.id,
      recipient_id: fx.agent.id,
      issue_id: issue.id,
      issue_title: 'Backlog',
      kind: 'change' as const,
      detail: `n${n}`,
      created_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + n).toISOString(),
      ...(read
        ? { read_at: new Date(Date.parse('2026-02-01T00:00:00.000Z') + n * 1000).toISOString() }
        : {}),
    })
    // three old unread messages, then newer unread ones about a hidden task,
    // then read messages about another task, three more than the read walk
    // keeps
    await fx.t.run(async (ctx) => {
      for (let n = 0; n < 3; n++) await ctx.db.insert('messages', row(fx.task, n, false))
      for (let n = 0; n < 5; n++) await ctx.db.insert('messages', row(fx.secret, n, false))
      for (let n = 0; n < INBOX_LIMIT + 3; n++) {
        await ctx.db.insert('messages', row(busy, n, true))
      }
    })
    const counts = (page: Awaited<ReturnType<typeof pageMcp>>) =>
      page.items.map((i) => [i.task.key, i.unread_count, i.messages.length])
    let page = await pageMcp(fx)
    // the unread ones all come back, and the most recently read fill the
    // read walk's own limit
    expect(counts(page)).toEqual([
      [key(busy), 0, INBOX_LIMIT],
      [key(fx.task), 3, 3],
    ])
    expect(page.items[0].messages.at(-1)?.detail).toBe(`n${INBOX_LIMIT + 2}`)
    expect(page.items[0].messages.map((m) => m.detail)).not.toContain('n2')
    expect(page.truncated).toBe(true)
    const unread = await listMcp(fx, { unread_only: true })
    expect(unread.map((i) => i.task.key)).toEqual([key(fx.task)])

    // with the three least recently read gone, everything fits in one read
    await fx.t.run(async (ctx) => {
      for (const m of await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', fx.agent.id).eq('issue_id', busy.id),
        )
        .collect()) {
        if (['n0', 'n1', 'n2'].includes(m.detail)) await ctx.db.delete(m._id)
      }
    })
    page = await pageMcp(fx)
    expect(counts(page)).toEqual([
      [key(busy), 0, INBOX_LIMIT],
      [key(fx.task), 3, 3],
    ])
    expect(page.truncated).toBe(false)
  })

  it('each walk examines at most 2 * INBOX_LIMIT rows, so hidden rows cannot widen the read', async () => {
    // Examining every row of either walk would pass this limit.
    const fx = await setup(
      newT({
        transactionLimits: { documentsRead: 4 * INBOX_LIMIT + 200 },
      }),
    )
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id, issue_title: 'T' }
    await fx.t.run(async (ctx) => {
      const read = (n: number) => new Date(Date.parse(NOW) + n * 1000).toISOString()
      const row = (issue: Doc<'issues'>, read_at?: string) => ({
        ...base,
        id: uuid(),
        issue_id: issue.id,
        kind: 'change' as const,
        detail: 'd',
        created_at: NOW,
        ...(read_at === undefined ? {} : { read_at }),
      })
      // the visible message was read before every hidden one
      await ctx.db.insert('messages', row(fx.task, read(0)))
      for (let n = 1; n <= 1500; n++) {
        await ctx.db.insert('messages', row(fx.secret))
        await ctx.db.insert('messages', row(fx.secret, read(n)))
      }
    })
    // each walk examines 2 * INBOX_LIMIT hidden rows and stops, so the
    // visible read one is not reached, as in the app
    expect(await pageMcp(fx)).toEqual({ items: [], truncated: true })
  })

  it("lists only the caller's own rows", async () => {
    const fx = await setup()
    await plantMessage(fx.t, {
      org_id: fx.org.id,
      recipient_id: fx.user.id,
      issue_id: fx.task.id,
    })
    expect(await listMcp(fx)).toEqual([])
    expect(await listMcp(fx, {}, fx.user.id)).toHaveLength(1)
  })
})

/* ------------------------------------------------------ 4. inbox changes */

const updateMcp = async (fx: Fx, args: Record<string, unknown>, callerId = fx.agent.id) =>
  JSON.parse(
    await fx.t.mutation(internal.machine.discussion.mcpUpdateInbox, {
      callerId,
      ...W,
      ...(args as { action: 'read' }),
    }),
  ) as { action: string; tasks: string[]; has_more: boolean; before?: number }

/* `count` unread messages for the agent about fx.task, in one transaction. */
const plantUnread = (fx: Fx, count: number) =>
  fx.t.run(async (ctx) => {
    for (let n = 0; n < count; n++) {
      await ctx.db.insert('messages', {
        id: uuid(),
        org_id: fx.org.id,
        recipient_id: fx.agent.id,
        issue_id: fx.task.id,
        issue_title: 'Bulk',
        kind: 'change',
        detail: 'bulk',
        created_at: NOW,
      })
    }
  })

/* Each POST /v1/inbox/{action} route's internal function. */
const REST_INBOX = {
  read: internal.machine.discussion.restReadInbox,
  unread: internal.machine.discussion.restUnreadInbox,
  remove: internal.machine.discussion.restRemoveInbox,
  snooze: internal.machine.discussion.restSnoozeInbox,
}

const updateRest = (fx: Fx, action: keyof typeof REST_INBOX, body: unknown) =>
  fx.t.mutation(REST_INBOX[action], {
    callerId: fx.agent.id,
    ...W,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('changing the inbox', () => {
  it('marks items read and unread by task, pruning read rows like the app', async () => {
    const fx = await setup()
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id, issue_id: fx.task.id }
    const first = await plantMessage(fx.t, { ...base, created_at: '2026-03-01T00:00:00.000Z' })
    const last = await plantMessage(fx.t, { ...base, created_at: '2026-03-02T00:00:00.000Z' })
    // someone else's row about the same task is never touched
    const theirs = await plantMessage(fx.t, { ...base, recipient_id: fx.user.id })
    expect(await updateMcp(fx, { action: 'read', tasks: [key(fx.task), fx.task.id] })).toEqual({
      action: 'read',
      tasks: [key(fx.task)],
      has_more: false,
    })
    // reading keeps only the item's newest message
    const kept = await messagesFor(fx.t, fx.agent.id, fx.task.id)
    expect(kept.map((m) => m.id)).toEqual([last.id])
    expect(kept[0].read_at).toBeDefined()
    expect(kept.map((m) => m.id)).not.toContain(first.id)
    // asking again changes nothing
    expect((await updateMcp(fx, { action: 'read', tasks: [key(fx.task)] })).tasks).toEqual([])
    expect(await updateRest(fx, 'unread', { tasks: [key(fx.task)] })).toEqual({
      action: 'unread',
      tasks: [key(fx.task)],
      has_more: false,
    })
    expect((await messagesFor(fx.t, fx.agent.id, fx.task.id))[0].read_at).toBeUndefined()
    expect((await messagesFor(fx.t, fx.user.id, fx.task.id))[0]).toEqual(theirs)
  })

  it('removes and snoozes items by task; null brings a snoozed item back', async () => {
    const fx = await setup()
    const other = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id }
    await plantMessage(fx.t, { ...base, issue_id: fx.task.id, read_at: NOW })
    await plantMessage(fx.t, { ...base, issue_id: other.id })
    vi.useFakeTimers()
    try {
      const until = new Date(Date.now() + 3_600_000).toISOString()
      expect(await updateMcp(fx, { action: 'snooze', tasks: [key(fx.task)], until })).toMatchObject(
        { tasks: [key(fx.task)] },
      )
      const snoozed = await messagesFor(fx.t, fx.agent.id, fx.task.id)
      // a snoozed item returns unread
      expect(snoozed[0].snoozed_until).toBe(until)
      expect(snoozed[0].read_at).toBeUndefined()
      expect((await listMcp(fx)).map((i) => i.task.key)).toEqual([key(other)])
      expect(
        await updateRest(fx, 'snooze', { tasks: [key(fx.task), key(other)], until: null }),
      ).toMatchObject({ tasks: [key(fx.task)] })
      expect((await messagesFor(fx.t, fx.agent.id, fx.task.id))[0].snoozed_until).toBeUndefined()
      await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    } finally {
      vi.useRealTimers()
    }
    expect(await updateRest(fx, 'remove', { tasks: [key(other)] })).toMatchObject({
      tasks: [key(other)],
    })
    expect(await messagesFor(fx.t, fx.agent.id, other.id)).toEqual([])
  })

  it('all: read marks every item and remove clears read ones, naming only readable tasks', async () => {
    const fx = await setup()
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id }
    await plantMessage(fx.t, { ...base, issue_id: fx.task.id })
    // a row about a task the agent lost sight of is marked too, as in the
    // app, but never named
    await plantMessage(fx.t, { ...base, issue_id: fx.secret.id })
    // a snoozed item stays out of both
    const snoozedTask = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantMessage(fx.t, {
      ...base,
      issue_id: snoozedTask.id,
      snoozed_until: '2099-01-01T00:00:00.000Z',
    })
    expect(await updateMcp(fx, { action: 'read', all: true })).toEqual({
      action: 'read',
      tasks: [key(fx.task)],
      has_more: false,
      before: expect.any(Number),
    })
    const mine = await messagesFor(fx.t, fx.agent.id)
    const unread = mine.filter((m) => m.read_at === undefined).map((m) => m.issue_id)
    expect(unread).toEqual([snoozedTask.id])
    expect(await updateRest(fx, 'remove', { all: true })).toEqual({
      action: 'remove',
      tasks: [key(fx.task)],
      has_more: false,
    })
    expect((await messagesFor(fx.t, fx.agent.id)).map((m) => m.issue_id)).toEqual([snoozedTask.id])
  })

  it('all: one bounded batch per call, with has_more until done', async () => {
    const fx = await setup()
    await plantUnread(fx, 300)
    expect((await updateMcp(fx, { action: 'read', all: true })).has_more).toBe(true)
    expect((await updateMcp(fx, { action: 'read', all: true })).has_more).toBe(false)
    expect((await messagesFor(fx.t, fx.agent.id)).every((m) => m.read_at !== undefined)).toBe(true)
  })

  it('all: read with the before it answered leaves a message arriving between batches unread', async () => {
    /* Two batches of read with all on one surface, MCP's handler or REST
     * over HTTP, with a message arriving between them. Returns whether the
     * arrival ended up read. */
    const arrivalRead = async (surface: 'mcp' | 'rest', passBack: boolean): Promise<boolean> => {
      const fx = await setup()
      const other = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
      const secret = await plantKey(fx.t, fx.agent)
      const readAll = async (body: Record<string, unknown>) =>
        (surface === 'mcp'
          ? await updateMcp(fx, { action: 'read', ...body })
          : (await http(fx.t, secret, 'POST', '/v1/inbox/read', body)).body) as Awaited<
          ReturnType<typeof updateMcp>
        >
      await plantUnread(fx, 300)
      const first = await readAll({ all: true })
      expect(first).toMatchObject({ tasks: [key(fx.task)], has_more: true })
      expect(first.before).toEqual(expect.any(Number))
      const arrival = await plantMessage(fx.t, {
        org_id: fx.org.id,
        recipient_id: fx.agent.id,
        issue_id: other.id,
      })
      const second = await readAll(passBack ? { all: true, before: first.before } : { all: true })
      expect(second.has_more).toBe(false)
      if (passBack) expect(second).toEqual({ ...first, has_more: false })
      // the batches read all 300 either way, and the item keeps its newest
      const task = await messagesFor(fx.t, fx.agent.id, fx.task.id)
      expect(task.map((m) => m.read_at !== undefined)).toEqual([true])
      const [row] = await messagesFor(fx.t, fx.agent.id, other.id)
      expect(row.id).toBe(arrival.id)
      return row.read_at !== undefined
    }
    for (const surface of ['mcp', 'rest'] as const) {
      expect(await arrivalRead(surface, true), surface).toBe(false)
      // without it the second batch chooses a later cutoff and reads the arrival
      expect(await arrivalRead(surface, false), surface).toBe(true)
    }
  })

  it('refuses requests that name nothing, too much or the wrong instant, alike on both surfaces', async () => {
    const fx = await setup()
    await plantMessage(fx.t, { org_id: fx.org.id, recipient_id: fx.agent.id, issue_id: fx.task.id })
    const t = [key(fx.task)]
    for (const [action, body, sentence] of [
      ['read', {}, 'name the inbox items with tasks, or set all to true'],
      ['read', { all: false }, 'name the inbox items with tasks, or set all to true'],
      ['read', { tasks: [] }, 'tasks must be a non-empty list of task refs'],
      ['read', { tasks: t, all: true }, 'name tasks or set all, not both'],
      ['unread', { all: true }, 'all applies to read and remove only'],
      ['snooze', { all: true, until: null }, 'all applies to read and remove only'],
      ['read', { tasks: t, until: null }, 'until applies to snooze only'],
      ['snooze', { tasks: t }, 'snooze needs until, an ISO date-time, or null to end the snooze'],
      ['snooze', { tasks: t, until: 'tomorrow' }, 'snooze: until must be an ISO instant'],
      [
        'snooze',
        { tasks: t, until: '2020-01-01T00:00:00Z' },
        'snooze: until must be in the future',
      ],
      ['read', { tasks: t, before: 1 }, 'before applies to read with all only'],
      ['remove', { all: true, before: 1 }, 'before applies to read with all only'],
      ['snooze', { tasks: t, until: null, before: 1 }, 'before applies to read with all only'],
      ['read', { all: true, before: -1 }, 'before must be the number an earlier call returned'],
    ] as const) {
      const label = `${action} ${JSON.stringify(body)}`
      const mcp = expectRefusal(updateMcp(fx, { action, ...body }), 'bad_request')
      expect(((await mcp).data as Refusal).message, label).toBe(sentence)
      const rest = expectRefusal(updateRest(fx, action, body), 'bad_request')
      expect(((await rest).data as Refusal).message, label).toBe(sentence)
    }
    // a snooze past the limit is the registry's refusal
    const far = { tasks: t, until: '2099-01-01T00:00:00Z' }
    await refused(updateMcp(fx, { action: 'snooze', ...far }), 'rule', LIMITS.snooze.refusal)
    await refused(updateRest(fx, 'snooze', far), 'rule', LIMITS.snooze.refusal)
    // REST-only shapes
    for (const [body, sentence] of [
      ['[', 'request body must be JSON'],
      [{ tasks: 'QN-1' }, 'tasks must be a non-empty list of task refs'],
      [{ tasks: [1] }, 'tasks must be a non-empty list of task refs'],
      [{ all: 'yes' }, 'all must be true or false'],
      [
        { all: true, before: '1760000000000' },
        'before must be the number an earlier call returned',
      ],
      [{ all: true, before: null }, 'before must be the number an earlier call returned'],
    ] as const) {
      await refused(updateRest(fx, 'read', body), 'bad_request', sentence)
    }
    expect((await messagesFor(fx.t, fx.agent.id))[0].read_at).toBeUndefined()
  })

  it('tasks names at most INBOX_TASKS_MAX tasks, and that many full items fit one transaction', async () => {
    // Convex's own limits apply to every call here
    const fx = await setup(newT({ transactionLimits: true }))
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < INBOX_TASKS_MAX; n++) {
      tasks.push(await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id }))
    }
    // every item as full as it gets, all unread as after a snooze
    await fx.t.run(async (ctx) => {
      for (const task of tasks) {
        for (let n = 0; n <= ITEM_UNREAD_CAP; n++) {
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: fx.org.id,
            recipient_id: fx.agent.id,
            issue_id: task.id,
            issue_title: task.title,
            kind: 'change',
            detail: `change ${n}`,
            created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
          })
        }
      }
    })
    const refs = tasks.map(key)
    const sentence = LIMITS.inboxTasks.refusal
    // one more, even a repeat, is refused on both surfaces before anything changes
    for (const over of [
      [...refs, key(fx.task)],
      [...refs, refs[0]],
    ]) {
      await refused(updateMcp(fx, { action: 'read', tasks: over }), 'rule', sentence)
      await refused(updateRest(fx, 'read', { tasks: over }), 'rule', sentence)
    }
    expect((await messagesFor(fx.t, fx.agent.id)).every((m) => m.read_at === undefined)).toBe(true)
    // at the limit, the heaviest action, mark read, patches and prunes every item
    expect((await updateMcp(fx, { action: 'read', tasks: refs })).tasks).toEqual(refs)
    const kept = await messagesFor(fx.t, fx.agent.id)
    expect(kept).toHaveLength(INBOX_TASKS_MAX)
    expect(
      kept.every((m) => m.read_at !== undefined && m.detail === `change ${ITEM_UNREAD_CAP}`),
    ).toBe(true)
    expect((await updateRest(fx, 'unread', { tasks: refs })).tasks).toEqual(refs)
  })

  it('a task the caller cannot read refuses the whole change like an unknown one', async () => {
    const fx = await setup()
    const base = { org_id: fx.org.id, recipient_id: fx.agent.id }
    await plantMessage(fx.t, { ...base, issue_id: fx.task.id })
    await plantMessage(fx.t, { ...base, issue_id: fx.secret.id })
    for (const ref of [key(fx.secret), 'QN-999999']) {
      await refused(
        updateMcp(fx, { action: 'remove', tasks: [key(fx.task), ref] }),
        'not_found',
        `task "${ref}" not found (or not visible to you)`,
      )
      await refused(
        updateRest(fx, 'remove', { tasks: [key(fx.task), ref] }),
        'bad_request',
        'tasks must name tasks by key, number or uuid',
      )
    }
    expect(await messagesFor(fx.t, fx.agent.id)).toHaveLength(2)
  })

  it('the app runs the same writes on message ids, own rows only', async () => {
    const fx = await setup()
    const mine = await plantMessage(fx.t, {
      org_id: fx.org.id,
      recipient_id: fx.user.id,
      issue_id: fx.task.id,
    })
    const theirs = await plantMessage(fx.t, {
      org_id: fx.org.id,
      recipient_id: fx.agent.id,
      issue_id: fx.task.id,
    })
    await as(fx.t, fx.user).mutation(api.messages.markRead, {
      org_id: fx.org.id,
      ids: [mine.id, theirs.id, uuid()],
    })
    const rows = new Map((await allMessages(fx.t)).map((m) => [m.id, m]))
    expect(rows.get(mine.id)?.read_at).toBeDefined()
    expect(rows.get(theirs.id)?.read_at).toBeUndefined()
    await as(fx.t, fx.user).mutation(api.messages.remove, {
      org_id: fx.org.id,
      ids: [mine.id, theirs.id],
    })
    expect((await allMessages(fx.t)).map((m) => m.id)).toEqual([theirs.id])
  })
})

/* ------------------------------------------------------------ 5. over HTTP */

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

async function http(
  t: T,
  secret: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: JSON.parse(await res.text()) }
}

async function plantKey(t: T, agent: Doc<'profiles'>): Promise<string> {
  const secret = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(secret)
  await t.run(async (ctx) => {
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'Inbox key',
      key_prefix: secret.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  return secret
}

describe('the routes over HTTP', () => {
  it('serves following, the inbox and comment edits at their documented paths', async () => {
    const fx = await setup()
    const secret = await plantKey(fx.t, fx.agent)
    const ref = key(fx.task)
    expect(await http(fx.t, secret, 'PUT', `/v1/tasks/${ref}/following`)).toEqual({
      status: 200,
      body: { id: fx.task.id, key: ref, following: true, changed: true },
    })
    // another method on the same path is the unknown route
    expect((await http(fx.t, secret, 'POST', `/v1/tasks/${ref}/following`)).status).toBe(404)
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id: uuid(),
      issue_id: fx.task.id,
      body: 'Over to you',
    })
    const inbox = await http(fx.t, secret, 'GET', '/v1/inbox?unread_only=true')
    expect(inbox.status).toBe(200)
    expect(inbox.body).toMatchObject({
      items: [{ task: { key: ref }, unread_count: 1 }],
      truncated: false,
    })
    expect(await http(fx.t, secret, 'POST', '/v1/inbox/read', { tasks: [ref] })).toEqual({
      status: 200,
      body: { action: 'read', has_more: false, tasks: [ref] },
    })
    expect((await http(fx.t, secret, 'POST', '/v1/inbox/archive', { all: true })).status).toBe(404)
    const own = await plantComment(fx.t, fx.task, fx.agent)
    const edited = await http(fx.t, secret, 'PATCH', `/v1/comments/${own.id}`, { body: 'Fixed' })
    expect(edited).toMatchObject({
      status: 200,
      body: { body: 'Fixed', edited_by_id: fx.agent.id },
    })
    expect(await http(fx.t, secret, 'DELETE', `/v1/comments/${own.id}`)).toEqual({
      status: 200,
      body: { deleted: true, id: own.id, task_id: fx.task.id },
    })
    expect(await http(fx.t, secret, 'DELETE', `/v1/tasks/${ref}/following`)).toMatchObject({
      status: 200,
      body: { following: false, changed: true },
    })
  })

  it("a Viewer agent's key reads its inbox but cannot change it or its follows", async () => {
    const fx = await setup()
    const viewerAgent = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Ledger',
      org_role: 'viewer',
      kind: 'agent',
      plannable_hours: undefined,
    })
    await fx.t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: fx.meta.id,
        profile_id: viewerAgent.id,
        level: 'user',
      }),
    )
    const own = await plantComment(fx.t, fx.task, viewerAgent)
    await plantMessage(fx.t, {
      org_id: fx.org.id,
      recipient_id: viewerAgent.id,
      issue_id: fx.task.id,
    })
    const secret = await plantKey(fx.t, viewerAgent)
    const ref = key(fx.task)
    expect((await http(fx.t, secret, 'GET', '/v1/inbox')).body).toMatchObject({
      items: [{ task: { key: ref } }],
    })
    const readOnly = { status: 403, body: { error: 'this agent is a Viewer and can only read' } }
    for (const [method, path, body] of [
      ['POST', '/v1/inbox/read', { tasks: [ref] }],
      ['POST', '/v1/inbox/remove', { all: true }],
      ['PUT', `/v1/tasks/${ref}/following`, undefined],
      ['PATCH', `/v1/comments/${own.id}`, { body: 'Mine to change?' }],
      ['DELETE', `/v1/comments/${own.id}`, undefined],
    ] as const) {
      expect(await http(fx.t, secret, method, path, body), `${method} ${path}`).toEqual(readOnly)
    }
    expect((await messagesFor(fx.t, viewerAgent.id))[0].read_at).toBeUndefined()
    expect(await follows(fx.t, fx.task.id)).toEqual([])
    expect((await commentRow(fx.t, own.id))?.body).toBe('Original')
  })
})
