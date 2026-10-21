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
  ATTACHMENT_MAX,
  ATTACHMENTS_FULL,
  FOLLOWER_MAX,
  FOLLOWERS_FULL,
  LABEL_MAX,
  LABELS_FULL,
  LINK_MAX,
  linksFull,
  PARENT_FULL,
  PARENT_IS_SUBTASK,
  SUBTASK_MAX,
  SUBTASK_WITH_SUBTASKS,
} from '../lib/taskLimits'
import { ARCHIVED_DETACH } from '../model/deletedItems'
import { MOVE_SUBTREE_MAX, MOVE_SUBTREE_TOO_LARGE } from '../model/issues'
import { INLINE_TRIMS, ITEM_UNREAD_CAP, MENTION_MAX, notifyCommentInsert } from '../model/messages'
import {
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantMessage,
  plantProject,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { deleteTask, itemFor } from './trash.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: string[])
}

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

  it('creates a parent and attaches the task in one write, or neither', async () => {
    const fx = await setup()
    const lone = await task(fx)
    const former = await task(fx)
    await task(fx, { parent_id: former.id, archived_at: NOW })
    const createParent = (issue: Doc<'issues'>, parent_id = uuid()) =>
      as(fx.t, fx.admin).mutation(api.issues.createParent, {
        org_id: fx.org.id,
        id: issue.id,
        parent_id,
        title: 'New parent',
      })
    const parent_id = uuid()
    const answer = await createParent(lone, parent_id)
    const parent = await row(fx.t, parent_id)
    expect(parent).toMatchObject({ title: 'New parent', project_id: fx.sub.id })
    // the answer names the task and the number the new parent got
    expect(answer).toMatchObject({ parent_id, parent_num: parent?.num })
    // the archived subtask refuses the attach, and the new task goes with it
    const refusedId = uuid()
    await refused(createParent(former, refusedId), 'rule', SUBTASK_WITH_SUBTASKS)
    expect(
      await fx.t.run((ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', refusedId))
          .unique(),
      ),
    ).toBeNull()
    // a task the caller cannot see is refused as issues.update refuses it
    const hidden = await task(fx, { project_id: fx.hidden.id })
    await refused(
      as(fx.t, fx.guest).mutation(api.issues.createParent, {
        org_id: fx.org.id,
        id: hidden.id,
        parent_id: uuid(),
        title: 'Probe',
      }),
      'forbidden',
      'no write access to this project',
    )
  })

  it("refuses a create whose id Deleted items holds before it looks at that task's subtasks", async () => {
    const fx = await setup()
    const top = await task(fx)
    // a parent held by Deleted items while a project delete still moves its
    // subtasks, which are live until their step
    const parent = await task(fx, { project_id: fx.hidden.id })
    await task(fx, { project_id: fx.hidden.id, parent_id: parent.id })
    await fx.t.run(async (ctx) => {
      const { _id, _creationTime, ...doc } = (await ctx.db.get(parent._id)) as Doc<'issues'>
      await ctx.db.insert('deleted_rows', {
        item_id: uuid(),
        org_id: fx.org.id,
        table: 'issues',
        owner_id: parent.id,
        row_id: parent.id,
        created_ts: _creationTime,
        row: { table: 'issues', doc },
      })
      await ctx.db.delete(_id)
    })
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.create, {
        org_id: fx.org.id,
        id: parent.id,
        project_id: fx.sub.id,
        title: 'Probe',
        parent_id: top.id,
      }),
      'bad_request',
      'a task with this id already exists',
    )
  })

  it("refuses a create whose id names a task before it looks at that task's subtasks", async () => {
    const fx = await setup()
    const top = await task(fx)
    // another organization's task with a subtask, whose uuid the caller holds
    const other = await task(fx, { org_id: uuid(), project_id: uuid() })
    await task(fx, { org_id: other.org_id, project_id: other.project_id, parent_id: other.id })
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.create, {
        org_id: fx.org.id,
        id: other.id,
        project_id: fx.sub.id,
        title: 'Probe',
        parent_id: top.id,
      }),
      'bad_request',
      'a task with this id already exists',
    )
  })

  it(`counts only active subtasks toward ${SUBTASK_MAX} and refuses the next active one`, async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Recurring' })
    // a full archive of Done subtasks takes nothing from the limit
    await plantSubtasks(fx, parent, SUBTASK_MAX, { archived_at: NOW })
    const kit = creates(fx, parent)
    await kit.app()
    await plantSubtasks(fx, parent, SUBTASK_MAX - 2)
    // the hundredth active one fits
    await kit.rest()
    for (const make of Object.values(kit)) await refused(make(), 'rule', PARENT_FULL)
    const lone = await task(fx)
    for (const change of Object.values(reparents(fx, lone, parent))) {
      await refused(change(), 'rule', PARENT_FULL)
    }
    expect(await row(fx.t, lone.id)).toEqual(lone)
  })
})

/* Plants `n` subtasks of `parent` in TBED's first sub-project. */
async function plantSubtasks(
  fx: Fx,
  parent: Doc<'issues'>,
  n: number,
  over: Partial<Doc<'issues'>> = {},
): Promise<Doc<'issues'>[]> {
  return await fx.t.run(async (ctx) => {
    const out: Doc<'issues'>[] = []
    const base = await ctx.db.query('issues').collect()
    for (let i = 0; i < n; i++) {
      const _id = await ctx.db.insert('issues', {
        id: uuid(),
        org_id: fx.org.id,
        project_id: fx.sub.id,
        parent_id: parent.id,
        num: 50_000 + base.length + i,
        title: `Step ${i}`,
        description: '',
        status: 'done',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        ...over,
      })
      out.push((await ctx.db.get(_id)) as Doc<'issues'>)
    }
    return out
  })
}

describe('restoring a subtask under a parent with the most active subtasks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /* A parent with SUBTASK_MAX active subtasks and one archived subtask. */
  async function fullParent(fx: Fx) {
    const parent = await task(fx, { title: 'Full' })
    await plantSubtasks(fx, parent, SUBTASK_MAX)
    const [old] = await plantSubtasks(fx, parent, 1, { archived_at: NOW, title: 'Old step' })
    return { parent, old }
  }

  it('brings it back from the archive as a top-level task, in the app and over REST and MCP', async () => {
    const fx = await setup()
    const app = await fullParent(fx)
    const answer = await as(fx.t, fx.admin).mutation(api.issues.unarchive, {
      org_id: fx.org.id,
      id: app.old.id,
    })
    expect(answer.left_parent).toBe(true)
    const back = await row(fx.t, app.old.id)
    expect([back.archived_at, back.parent_id]).toEqual([undefined, undefined])
    const told = await fx.t.run((ctx) =>
      ctx.db
        .query('activity_events')
        .filter((q) => q.eq(q.field('target_id'), app.old.id))
        .collect(),
    )
    expect(told.map((e) => e.verb)).toEqual(['restored', 'detached'])
    const rest = await fullParent(fx)
    const restored = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(rest.old),
      body: JSON.stringify({ archived: false }),
    })
    expect(restored).toMatchObject({ archived: false, parent_id: null })
    const mcp = await fullParent(fx)
    await fx.t.mutation(internal.machine.mcp.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      ref: key(mcp.old),
      archived: false,
    })
    expect((await row(fx.t, mcp.old.id)).parent_id).toBeUndefined()
  })

  it('checks the people of a machine restore without the parent it leaves', async () => {
    const fx = await setup()
    // the parent sits in a sub-project the guest cannot see
    const hidden = await plantHiddenSibling(fx.t, fx, fx.guest)
    const parent = await task(fx, { project_id: hidden.id, title: 'Full elsewhere' })
    await plantSubtasks(fx, parent, SUBTASK_MAX, { project_id: hidden.id })
    const [old] = await plantSubtasks(fx, parent, 1, { archived_at: NOW, title: 'Old step' })
    const restored = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(old),
      body: JSON.stringify({ archived: false, assignee_id: fx.guest.id }),
    })
    expect(restored).toMatchObject({ archived: false, parent_id: null, assignee_id: fx.guest.id })
  })

  it('leaves a parent that is in Deleted items, and the steps after its delete detach the rest', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Deleted parent' })
    const [first, second] = await plantSubtasks(fx, parent, 2, { archived_at: NOW })
    await deleteTask(fx.t, fx, parent.id)
    // restored before the steps after the delete ran
    const answer = await as(fx.t, fx.admin).mutation(api.issues.unarchive, {
      org_id: fx.org.id,
      id: first.id,
    })
    expect(answer.left_parent).toBe(false)
    expect((await row(fx.t, first.id)).parent_id).toBeUndefined()
    // the parent comes back before the steps, and they still detach the
    // subtask its delete left archived
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, parent.id)).id],
    })
    expect(await row(fx.t, parent.id)).not.toBeNull()
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await row(fx.t, second.id)).parent_id).toBeUndefined()
  })

  it('keeps the parent when it has room, archived subtasks aside', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Roomy' })
    await plantSubtasks(fx, parent, SUBTASK_MAX - 1)
    const [old] = await plantSubtasks(fx, parent, SUBTASK_MAX, { archived_at: NOW })
    const answer = await as(fx.t, fx.admin).mutation(api.issues.unarchive, {
      org_id: fx.org.id,
      id: old.id,
    })
    expect(answer.left_parent).toBe(false)
    expect((await row(fx.t, old.id)).parent_id).toBe(parent.id)
  })

  it('brings it back from Deleted items under a parent whose other subtasks are archived', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Archive heavy' })
    const [child] = await plantSubtasks(fx, parent, 1, { status: 'todo', title: 'Deleted step' })
    await deleteTask(fx.t, fx, child.id)
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    await plantSubtasks(fx, parent, SUBTASK_MAX, { archived_at: NOW })
    const item = await itemFor(fx.t, child.id)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [item.id],
    })
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await row(fx.t, child.id)).parent_id).toBe(parent.id)
  })
})

describe('a move that carries archived subtasks', () => {
  it(`refuses past ${MOVE_SUBTREE_MAX} subtasks, archived ones included, with what to do`, async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Long history' })
    await plantSubtasks(fx, parent, MOVE_SUBTREE_MAX + 1, { archived_at: NOW })
    const other = await plantProject(fx.t, { org_id: fx.org.id, type: 'meta' })
    const dest = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: other.id,
    })
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: parent.id,
        project_id: dest.id,
      }),
      'rule',
      MOVE_SUBTREE_TOO_LARGE,
    )
  })
})

describe('deleting a task with archived subtasks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    ARCHIVED_DETACH.page = 100
  })

  it('detaches its archived subtasks in background steps', async () => {
    ARCHIVED_DETACH.page = 2
    const fx = await setup()
    const parent = await task(fx, { title: 'Gone' })
    const kids = await plantSubtasks(fx, parent, 5, { archived_at: NOW })
    await deleteTask(fx.t, fx, parent.id)
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const kid of kids) expect((await row(fx.t, kid.id)).parent_id).toBeUndefined()
  })
})

/* Links `hub` to each of `ends`, `hub` blocking them. */
const plantLinks = (fx: Fx, hub: Doc<'issues'>, ends: readonly Doc<'issues'>[]) =>
  fx.t.run(async (ctx) => {
    for (const end of ends) {
      await ctx.db.insert('issue_links', {
        id: uuid(),
        org_id: fx.org.id,
        source_id: hub.id,
        target_id: end.id,
        type: 'blocks',
        pair_key: hub.id < end.id ? `${hub.id}:${end.id}` : `${end.id}:${hub.id}`,
        created_at: NOW,
      })
    }
  })

describe('the attachment, link and label limits', () => {
  /* Plants `n` attachment rows on `issue`, each with stored bytes. */
  const plantAttachments = (fx: Fx, issue: Doc<'issues'>, n: number) =>
    fx.t.run(async (ctx) => {
      for (let i = 0; i < n; i++)
        await ctx.db.insert('issue_attachments', {
          id: uuid(),
          org_id: fx.org.id,
          issue_id: issue.id,
          name: `scan-${i}.png`,
          size_bytes: 3,
          storage_id: await ctx.storage.store(new Blob(['png']) as never),
          inline: i % 2 === 0,
          created_at: NOW,
        })
    })

  it(`refuses an attachment past ${ATTACHMENT_MAX} before any bytes are sent, on every surface`, async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Scans' })
    await plantAttachments(fx, issue, ATTACHMENT_MAX - 1)
    // the hundredth fits, description images counted
    await as(fx.t, fx.admin).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    await plantAttachments(fx, issue, 1)
    await refused(
      as(fx.t, fx.admin).mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id }),
      'rule',
      ATTACHMENTS_FULL,
    )
    const stored = await fx.t.run((ctx) => ctx.storage.store(new Blob(['late']) as never))
    await refused(
      as(fx.t, fx.admin).mutation(api.files.attach, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: stored,
        name: 'late.txt',
        inline: false,
      }),
      'rule',
      ATTACHMENTS_FULL,
    )
    await refused(
      fx.t.mutation(internal.machine.records.restStartUpload, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        body: JSON.stringify({ name: 'wiring.pdf', size: 10 }),
      }),
      'rule',
      ATTACHMENTS_FULL,
    )
    await refused(
      fx.t.mutation(internal.machine.records.mcpStartUpload, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        name: 'wiring.pdf',
        size: 10,
      }),
      'rule',
      ATTACHMENTS_FULL,
    )
    await refused(
      fx.t.action(internal.machine.records.mcpAttachTextFile, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        name: 'notes.txt',
        text: 'notes',
      }),
      'rule',
      ATTACHMENTS_FULL,
    )
    const files = await fx.t.run((ctx) =>
      ctx.db
        .query('issue_attachments')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .collect(),
    )
    expect(files).toHaveLength(ATTACHMENT_MAX)
  })

  it(`refuses a link to a task that is an end of ${LINK_MAX} links, naming it, on every surface`, async () => {
    const fx = await setup()
    const hub = await task(fx, { title: 'Hub' })
    const ends = await plantSubtasks(fx, await task(fx), LINK_MAX - 1, { parent_id: undefined })
    await fx.t.run(async (ctx) => {
      for (const [i, end] of ends.entries()) {
        // both directions count
        const [source_id, target_id] = i % 2 ? [end.id, hub.id] : [hub.id, end.id]
        await ctx.db.insert('issue_links', {
          id: uuid(),
          org_id: fx.org.id,
          source_id,
          target_id,
          type: 'blocks',
          pair_key:
            source_id < target_id ? `${source_id}:${target_id}` : `${target_id}:${source_id}`,
          created_at: NOW,
        })
      }
    })
    const one = await task(fx, { title: 'One more' })
    // the hundredth fits
    await as(fx.t, fx.admin).mutation(api.issues.addLink, {
      org_id: fx.org.id,
      id: uuid(),
      source_id: one.id,
      target_id: hub.id,
      type: 'relates',
    })
    const late = await task(fx, { title: 'Too late' })
    const sentence = linksFull(key(hub))
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.addLink, {
        org_id: fx.org.id,
        id: uuid(),
        source_id: hub.id,
        target_id: late.id,
        type: 'blocks',
      }),
      'rule',
      sentence,
    )
    await refused(
      fx.t.mutation(internal.machine.rest.addLink, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: 'limits',
        ref: key(late),
        body: JSON.stringify({ task: key(hub), kind: 'relates' }),
      }),
      'rule',
      sentence,
    )
    await refused(
      fx.t.mutation(internal.machine.mcp.setTaskLink, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(late),
        other: key(hub),
        kind: 'blocked_by',
        linked: true,
      }),
      'rule',
      sentence,
    )
  })

  it(`leaves out a restored link to a task that reached ${LINK_MAX} links meanwhile`, async () => {
    vi.useFakeTimers()
    try {
      const fx = await setup()
      const hub = await task(fx, { title: 'Hub' })
      const gone = await task(fx, { title: 'Deleted' })
      await plantLinks(fx, hub, [gone])
      await deleteTask(fx.t, fx, gone.id)
      await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
      await plantLinks(
        fx,
        hub,
        await plantSubtasks(fx, await task(fx), LINK_MAX, { parent_id: undefined }),
      )
      const item = await itemFor(fx.t, gone.id)
      await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
        org_id: fx.org.id,
        ids: [item.id],
      })
      await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
      expect(await row(fx.t, gone.id)).not.toBeNull()
      const links = await fx.t.run((ctx) =>
        ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', hub.id))
          .collect(),
      )
      expect(links).toHaveLength(LINK_MAX)
      expect(links.some((l) => l.target_id === gone.id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it(`refuses a label past ${LABEL_MAX}, and lets one update swap labels on a full task`, async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Tagged' })
    const labels = await fx.t.run(async (ctx) => {
      const out: string[] = []
      for (let i = 0; i < LABEL_MAX + 1; i++) {
        const id = uuid()
        await ctx.db.insert('labels', {
          id,
          org_id: fx.org.id,
          name: `Tag ${i}`,
          name_lower: `tag ${i}`,
          color: '#4C9AFF',
          created_at: NOW,
        })
        out.push(id)
      }
      for (const label_id of out.slice(0, LABEL_MAX - 1))
        await ctx.db.insert('issue_labels', { org_id: fx.org.id, issue_id: issue.id, label_id })
      return out
    })
    const toggle = (label_id: string, on: boolean) =>
      as(fx.t, fx.admin).mutation(api.labels.toggle, {
        org_id: fx.org.id,
        issue_id: issue.id,
        label_id,
        on,
      })
    // the twentieth fits
    await toggle(labels[LABEL_MAX - 1], true)
    await refused(toggle(labels[LABEL_MAX], true), 'rule', LABELS_FULL)
    const patch = (body: object) =>
      fx.t.mutation(internal.machine.rest.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: 'limits',
        ref: key(issue),
        body: JSON.stringify(body),
      })
    await refused(patch({ add_labels: [labels[LABEL_MAX]] }), 'rule', LABELS_FULL)
    await refused(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        add_labels: [labels[LABEL_MAX]],
      }),
      'rule',
      LABELS_FULL,
    )
    await patch({ remove_labels: [labels[0]], add_labels: [labels[LABEL_MAX]] })
    const held = await fx.t.run((ctx) =>
      ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .collect(),
    )
    expect(held.map((l) => l.label_id).sort()).toEqual(labels.slice(1).sort())
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
    // 4,500 more people, 1,200 of them in a team that shares TBED, more
    // than a bulk sight check reads in full (lib/access.ts SIGHT_READ)
    const team = await fx.t.run(async (ctx) => {
      const team = uuid()
      await ctx.db.insert('teams', {
        id: team,
        org_id: fx.org.id,
        name: 'Everyone',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('project_team_access', {
        project_id: fx.meta.id,
        team_id: team,
        level: 'viewer',
      })
      const members: string[] = []
      for (let i = 0; i < 4500; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: fx.org.id,
          name: `Elsewhere ${i}`,
          initials: 'EL',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
        if (i < 1200) {
          await ctx.db.insert('team_members', { team_id: team, profile_id: id, is_leader: false })
          members.push(id)
        }
      }
      return members
    })
    const roster = await as(fx.t, fx.admin).query(api.issues.subscribers, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    expect(roster.canManage).toBe(true)
    expect(roster.subscribers).toHaveLength(FOLLOWER_MAX)
    expect(roster.subscribers).toEqual(expect.arrayContaining(crowd.map((p) => p.id)))
    // people who see TBED, the team's 1,200 included, and none of the 3,300
    // who do not
    expect(roster.candidates).toEqual(expect.arrayContaining([fx.user.id, fx.agent.id, ...team]))
    expect(roster.candidates.length).toBeLessThan(team.length + 10)
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

/* ------------------------------------------------------------- 4. mentions */

describe('mentions', () => {
  it(`reach at most ${MENTION_MAX} people, and an edit re-notifies no one who stayed mentioned`, async () => {
    const fx = await setup()
    const issue = await task(fx)
    const people = await plantFollowers(fx, await task(fx), MENTION_MAX + 2)
    const at = (p: Doc<'profiles'>) => `@[${p.name}](user:${p.id})`
    const body = people.map(at).join(' ')
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id: uuid(),
      issue_id: issue.id,
      body,
    })
    const mentioned = async (p: Doc<'profiles'>) =>
      (await messagesFor(fx.t, p.id, issue.id)).filter((m) => m.kind === 'mention').length
    expect(await mentioned(people[MENTION_MAX - 1])).toBe(1)
    expect(await mentioned(people[MENTION_MAX])).toBe(0)
    // a description that names them all; dropping the first mention moves
    // the 101st into the first 100, and they hear nothing new
    const described = await task(fx, { description: body })
    await as(fx.t, fx.admin).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: described.id,
      patch: { description: people.slice(1).map(at).join(' ') },
    })
    expect(
      (await messagesFor(fx.t, people[MENTION_MAX].id, described.id)).filter(
        (m) => m.kind === 'mention',
      ),
    ).toEqual([])
  })
})

/* -------------------------------------------- 5. an arrival's item, edge cases */

describe("an arrival on an item's edges", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /* Plants `unread` unread rows for `p` about `issue`, then one read row
   * newer than them, and answers the read row. */
  const plantItem = async (fx: Fx, p: Doc<'profiles'>, issue: Doc<'issues'>, unread: number) => {
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < unread; i++)
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: fx.org.id,
          recipient_id: p.id,
          issue_id: issue.id,
          issue_title: issue.title,
          kind: 'change',
          detail: `Old news ${i}`,
          created_at: `2025-12-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        })
    })
    return await plantMessage(fx.t, {
      org_id: fx.org.id,
      recipient_id: p.id,
      issue_id: issue.id,
      created_at: '2025-12-02T00:00:00.000Z',
      read_at: '2025-12-02T00:00:00.000Z',
    })
  }

  it('prunes the read row of an item past the cap from before it', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const [p] = await plantFollowers(fx, issue, 1)
    const readRow = await plantItem(fx, p, issue, 110)
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id: uuid(),
      issue_id: issue.id,
      body: 'Any news?',
    })
    const item = await messagesFor(fx.t, p.id, issue.id)
    expect(item.some((m) => m.id === readRow.id)).toBe(false)
    expect(item.filter((m) => m.read_at === undefined)).toHaveLength(110 + 1 - ITEM_UNREAD_CAP)
  })

  it('wakes a snoozed item and prunes its read row past the inline trims', async () => {
    const fx = await setup()
    const issue = await task(fx)
    const crowd = await plantFollowers(fx, issue, INLINE_TRIMS + 8)
    const last = crowd.at(-1) as Doc<'profiles'>
    const readRow = await plantItem(fx, last, issue, 3)
    await fx.t.run(async (ctx) => {
      for (const m of await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', last.id).eq('issue_id', issue.id),
        )
        .collect())
        await ctx.db.patch(m._id, { snoozed_until: '2027-01-01T00:00:00.000Z' })
    })
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id: uuid(),
      issue_id: issue.id,
      body: 'Any news?',
    })
    const item = await messagesFor(fx.t, last.id, issue.id)
    expect(item.some((m) => m.id === readRow.id)).toBe(false)
    expect(item.filter((m) => m.snoozed_until !== undefined)).toEqual([])
    expect(item.at(-1)?.detail).toBe('New comment')
  })
})
