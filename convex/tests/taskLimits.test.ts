/* The size limits of one task's family and followers (lib/limits.ts),
 * on the app's mutations, REST and MCP, which share one model rule each.
 *
 *   1. One level of subtasks: no subtask as a parent, no parent for a task
 *      with subtasks, archived ones included, and at most
 *      LIMITS.subtasks.max active subtasks. A restore under a full parent
 *      brings the task back as a top-level task, and a move carries at most
 *      LIMITS.moveSubtree.max subtasks. At most LIMITS.attachments.max
 *      attachments, LIMITS.links.max links and LIMITS.labels.max labels per
 *      task, on every write path.
 *   2. At most LIMITS.followers.max followers: a follow by hand is refused
 *      there, a comment or a mention adds no follower but still goes
 *      through, and a new assignee or reviewer still follows.
 *   3. A comment on a task with many followers whose items sit at the item
 *      cap reads a bounded share of each item and trims the rest in the
 *      background. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal, RefusalCode } from '../lib/functions'
import {
  LIMITS,
  linksFull,
  PARENT_IS_SUBTASK,
  SUBTASK_WITH_SUBTASKS,
  TEXT_MAX,
} from '../lib/limits'
import { ARCHIVED_DETACH, STALLED_MS } from '../model/deletedItems'
import { DROPPED_IMAGES_MAX, DROPPED_KEEP_MS, IMAGE_NOT_ATTACHED } from '../model/descriptionImages'
import { insertTask, patchTask } from '../model/descriptions'
import { MOVE_TOO_LARGE, PARENT_DELETED_SINCE } from '../model/issues'
import { INLINE_TRIMS, ITEM_UNREAD_CAP, notifyCommentInsert } from '../model/messages'
import {
  as,
  expectRefusal,
  fileState,
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

  it(`counts only active subtasks toward ${LIMITS.subtasks.max} and refuses the next active one`, async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Recurring' })
    // a full archive of Done subtasks takes nothing from the limit
    await plantSubtasks(fx, parent, LIMITS.subtasks.max, { archived_at: NOW })
    const kit = creates(fx, parent)
    await kit.app()
    await plantSubtasks(fx, parent, LIMITS.subtasks.max - 2)
    // the hundredth active one fits
    await kit.rest()
    for (const make of Object.values(kit)) await refused(make(), 'rule', LIMITS.subtasks.refusal)
    const lone = await task(fx)
    for (const change of Object.values(reparents(fx, lone, parent))) {
      await refused(change(), 'rule', LIMITS.subtasks.refusal)
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
      // with its description row and the used_ids row of its id, as every
      // writer stores a task
      const _id = await insertTask(
        ctx.db,
        {
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
        },
        'restore',
      )
      out.push((await ctx.db.get(_id)) as Doc<'issues'>)
    }
    return out
  })
}

describe('restoring a subtask under a parent with the most active subtasks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /* A parent with LIMITS.subtasks.max active subtasks and one archived subtask. */
  async function fullParent(fx: Fx) {
    const parent = await task(fx, { title: 'Full' })
    await plantSubtasks(fx, parent, LIMITS.subtasks.max)
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
    expect(answer.left_parent).toBe('full')
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

  it('signs the detach row of a machine restore, and refuses one that names the full parent', async () => {
    const fx = await setup()
    const { old } = await fullParent(fx)
    await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(old),
      body: JSON.stringify({ archived: false }),
    })
    const rows = await fx.t.run((ctx) =>
      ctx.db
        .query('activity_events')
        .filter((q) => q.eq(q.field('target_id'), old.id))
        .collect(),
    )
    expect(rows.find((e) => e.verb === 'detached')?.detail).toMatch(/via the REST API \(limits\)$/)
    const named = await fullParent(fx)
    await refused(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(named.old),
        archived: false,
        parent: key(named.parent),
      }),
      'rule',
      LIMITS.subtasks.refusal,
    )
    expect(await row(fx.t, named.old.id)).toEqual(named.old)
  })

  it('checks the people of a machine restore without the parent it leaves', async () => {
    const fx = await setup()
    // the parent sits in a sub-project the guest cannot see
    const hidden = await plantHiddenSibling(fx.t, fx, fx.guest)
    const parent = await task(fx, { project_id: hidden.id, title: 'Full elsewhere' })
    await plantSubtasks(fx, parent, LIMITS.subtasks.max, { project_id: hidden.id })
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
    await plantSubtasks(fx, parent, LIMITS.subtasks.max - 1)
    const [old] = await plantSubtasks(fx, parent, LIMITS.subtasks.max, { archived_at: NOW })
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
    await plantSubtasks(fx, parent, LIMITS.subtasks.max, { archived_at: NOW })
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
  it(`refuses past ${LIMITS.moveSubtree.max} subtasks, archived ones included, with what to do`, async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Long history' })
    await plantSubtasks(fx, parent, LIMITS.moveSubtree.max + 1, { archived_at: NOW })
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
      LIMITS.moveSubtree.refusal,
    )
  })

  /* A sub-project in another top-level project, where the agent has Edit. */
  const elsewhere = async (fx: Fx) => {
    const other = await plantProject(fx.t, { org_id: fx.org.id, type: 'meta' })
    await fx.t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: other.id,
        profile_id: fx.agent.id,
        level: 'user',
      }),
    )
    return await plantProject(fx.t, { org_id: fx.org.id, type: 'project', parent_id: other.id })
  }

  /* Plants `active` and `archived` subtasks of `parent` with the longest
   * title and description, about 60 KB each and as much again in their
   * description rows, at most fifty per write. */
  const plantLong = async (
    fx: Fx,
    parent: Doc<'issues'>,
    count: { active: number; archived: number },
  ) => {
    const long = { description: 'あ'.repeat(TEXT_MAX), title: 'あ'.repeat(LIMITS.title.max) }
    const kids: Doc<'issues'>[] = []
    for (const [n, over] of [
      [count.archived, { archived_at: NOW }],
      [count.active, {}],
    ] as const)
      for (let left = n; left > 0; left -= 50)
        kids.push(...(await plantSubtasks(fx, parent, Math.min(50, left), { ...long, ...over })))
    return kids
  }

  /* A REST move of `parent` to `dest`. */
  const restMove = (fx: Fx, parent: Doc<'issues'>, dest: Doc<'projects'>) =>
    fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(parent),
      body: JSON.stringify({ project: dest.id }),
    })

  it('moves fifty subtasks with the longest descriptions over REST within the real limits, and answers in full', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const parent = await task(fx, { title: 'Long family' })
    const kids = await plantLong(fx, parent, { active: 25, archived: 25 })
    const dest = await elsewhere(fx)
    const answer = await restMove(fx, parent, dest)
    expect(answer.project_id).toBe(dest.id)
    // an active task's answer lists its active subtasks
    expect(answer.subtasks).toHaveLength(25)
    for (const kid of kids) expect((await row(fx.t, kid.id)).project_id).toBe(dest.id)
  }, 120_000)

  it('refuses a move of a hundred such subtasks, which reads each one and its row twice, and changes nothing', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const parent = await task(fx, { title: 'Long family' })
    const kids = await plantLong(fx, parent, { active: 50, archived: 50 })
    const dest = await elsewhere(fx)
    await refused(restMove(fx, parent, dest), 'rule', MOVE_TOO_LARGE)
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: parent.id,
        project_id: dest.id,
      }),
      'rule',
      MOVE_TOO_LARGE,
    )
    for (const t of [parent, ...kids]) expect((await row(fx.t, t.id)).project_id).toBe(fx.sub.id)
  }, 120_000)

  it('refuses a REST move whose answer could not read its active subtasks again, which MCP and the app move', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const parent = await task(fx, { title: 'Long family' })
    // the move fits, but REST's answer reads the 58 active subtasks again
    // (lib/core.ts taskOut), past Convex's 16 MiB of reads
    const kids = await plantLong(fx, parent, { active: 58, archived: 0 })
    const dest = await elsewhere(fx)
    const family = [parent, ...kids]
    await refused(restMove(fx, parent, dest), 'rule', MOVE_TOO_LARGE)
    for (const t of family) expect((await row(fx.t, t.id)).project_id).toBe(fx.sub.id)
    // MCP's answer names the task and what changed, and reads nothing
    const mcp = JSON.parse(
      await fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(parent),
        project: dest.id,
      }),
    ) as { id: string; updated: string[] }
    expect(mcp).toMatchObject({ id: parent.id, updated: ['project_id'] })
    for (const t of family) expect((await row(fx.t, t.id)).project_id).toBe(dest.id)
    // the app's answer is the task alone, and it carries them back
    await as(fx.t, fx.admin).mutation(api.issues.move, {
      org_id: fx.org.id,
      id: parent.id,
      project_id: fx.sub.id,
    })
    for (const t of family) expect((await row(fx.t, t.id)).project_id).toBe(fx.sub.id)
  }, 120_000)

  it(`refuses a move of ${LIMITS.moveSubtree.max} such subtasks with what to do, on every surface`, async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const parent = await task(fx, { title: 'Longer family' })
    const kids = await plantLong(fx, parent, {
      active: LIMITS.moveSubtree.max / 2,
      archived: LIMITS.moveSubtree.max / 2,
    })
    const dest = await elsewhere(fx)
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: parent.id,
        project_id: dest.id,
      }),
      'rule',
      MOVE_TOO_LARGE,
    )
    await refused(
      fx.t.mutation(internal.machine.rest.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: 'limits',
        ref: key(parent),
        body: JSON.stringify({ project: dest.id }),
      }),
      'rule',
      MOVE_TOO_LARGE,
    )
    await refused(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(parent),
        project: dest.id,
      }),
      'rule',
      MOVE_TOO_LARGE,
    )
    for (const t of [parent, kids[0], kids[LIMITS.moveSubtree.max - 1]]) {
      expect((await row(fx.t, t.id)).project_id).toBe(fx.sub.id)
    }
  }, 120_000)
})

describe('deleting a task with archived subtasks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.assign(ARCHIVED_DETACH, { page: 100, room: 0.5 })
  })

  const detaches = (t: T) => t.run((ctx) => ctx.db.query('archived_detaches').collect())

  it('detaches its archived subtasks in background steps', async () => {
    ARCHIVED_DETACH.page = 2
    const fx = await setup()
    const parent = await task(fx, { title: 'Gone' })
    const kids = await plantSubtasks(fx, parent, 5, { archived_at: NOW })
    await deleteTask(fx.t, fx, parent.id)
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const kid of kids) expect((await row(fx.t, kid.id)).parent_id).toBeUndefined()
    expect(await detaches(fx.t)).toEqual([])
  })

  it('resumes a step that failed halfway with a smaller page', async () => {
    Object.assign(ARCHIVED_DETACH, { page: 4, room: 0.99 })
    // each subtask's description takes about 60 KB, so four detaches pass
    // the write limit and the step fails after its third
    const fx = await setup(newT({ transactionLimits: { bytesWritten: 200_000 } }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parent = await task(fx, { title: 'Long subtasks' })
    const kids: Doc<'issues'>[] = []
    for (let i = 0; i < 5; i++) {
      kids.push(
        ...(await plantSubtasks(fx, parent, 1, {
          archived_at: NOW,
          description: 'あ'.repeat(TEXT_MAX),
        })),
      )
    }
    await deleteTask(fx.t, fx, parent.id)
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    // the failed step committed nothing and left its job
    expect((await detaches(fx.t)).map((job) => job.attempts)).toEqual([0])
    for (const kid of kids) expect((await row(fx.t, kid.id)).parent_id).toBe(parent.id)
    for (let round = 0; round < 10 && (await detaches(fx.t)).length > 0; round++) {
      vi.advanceTimersByTime(STALLED_MS + 1)
      await fx.t.mutation(internal.deletedItems.recover, {})
      await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    }
    expect(await detaches(fx.t)).toEqual([])
    for (const kid of kids) expect((await row(fx.t, kid.id)).parent_id).toBeUndefined()
  })

  it('detaches a subtask restored from the archive after its parent came back', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Back again' })
    const [first, second, third] = await plantSubtasks(fx, parent, 3, { archived_at: NOW })
    await deleteTask(fx.t, fx, parent.id)
    await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
      org_id: fx.org.id,
      ids: [(await itemFor(fx.t, parent.id)).id],
    })
    // restored from the archive before the steps after the delete ran
    const answer = await as(fx.t, fx.admin).mutation(api.issues.unarchive, {
      org_id: fx.org.id,
      id: first.id,
    })
    expect(answer.left_parent).toBe('deleted')
    expect((await row(fx.t, first.id)).parent_id).toBeUndefined()
    // a machine restore that names the parent to keep is refused
    await refused(
      fx.t.mutation(internal.machine.rest.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: 'limits',
        ref: key(second),
        body: JSON.stringify({ archived: false, parent: key(parent) }),
      }),
      'rule',
      PARENT_DELETED_SINCE,
    )
    // a task this update gives the parent was never its subtask, so it keeps it
    const stranger = await task(fx, { title: 'Stranger', archived_at: NOW })
    const joined = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'limits',
      ref: key(stranger),
      body: JSON.stringify({ archived: false, parent: key(parent) }),
    })
    expect(joined).toMatchObject({ archived: false, parent_id: parent.id })
    await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
    for (const kid of [first, second, third]) {
      expect((await row(fx.t, kid.id)).parent_id).toBeUndefined()
    }
    // once the steps are done, a subtask archived under the parent later keeps it
    const [later] = await plantSubtasks(fx, parent, 1, { archived_at: new Date().toISOString() })
    const kept = await as(fx.t, fx.admin).mutation(api.issues.unarchive, {
      org_id: fx.org.id,
      id: later.id,
    })
    expect(kept.left_parent).toBe(false)
    expect((await row(fx.t, later.id)).parent_id).toBe(parent.id)
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

  it(`refuses an attachment past ${LIMITS.attachments.max} before any bytes are sent, on every surface`, async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Scans' })
    await plantAttachments(fx, issue, LIMITS.attachments.max - 1)
    // the hundredth fits, description images counted
    await as(fx.t, fx.admin).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    await plantAttachments(fx, issue, 1)
    await refused(
      as(fx.t, fx.admin).mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id }),
      'rule',
      LIMITS.attachments.refusal,
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
      LIMITS.attachments.refusal,
    )
    await refused(
      fx.t.mutation(internal.machine.records.restStartUpload, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        body: JSON.stringify({ name: 'wiring.pdf', size: 10 }),
      }),
      'rule',
      LIMITS.attachments.refusal,
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
      LIMITS.attachments.refusal,
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
      LIMITS.attachments.refusal,
    )
    const files = await fx.t.run((ctx) =>
      ctx.db
        .query('issue_attachments')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .collect(),
    )
    expect(files).toHaveLength(LIMITS.attachments.max)
  })

  /* Plants a description image on `issue`, uploaded at `at`, or `n` files. */
  const plantImage = (fx: Fx, issue: Doc<'issues'>, at = new Date().toISOString()) =>
    fx.t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('issue_attachments', {
        id,
        org_id: fx.org.id,
        issue_id: issue.id,
        name: 'photo.png',
        size_bytes: 3,
        storage_id: await ctx.storage.store(new Blob(['png']) as never),
        inline: true,
        created_at: at,
      })
      return id
    })
  const plantFiles = (fx: Fx, issue: Doc<'issues'>, n: number) =>
    fx.t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < n; i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('issue_attachments', {
          id,
          org_id: fx.org.id,
          issue_id: issue.id,
          name: `file-${i}.pdf`,
          size_bytes: 3,
          storage_id: await ctx.storage.store(new Blob(['pdf']) as never),
          inline: false,
          created_at: NOW,
        })
      }
      return ids
    })
  const attachment = (fx: Fx, id: string) =>
    fx.t.run((ctx) =>
      ctx.db
        .query('issue_attachments')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
    )
  const saveDescription = (fx: Fx, issue: Doc<'issues'>, description: string) =>
    as(fx.t, fx.admin).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: issue.id,
      patch: { description },
    })

  it('frees an image’s place when a save takes it out of the description, and brings it back', async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Pictures' })
    const image = await plantImage(fx, issue)
    const shown = `Wiring ![photo](att:${image})`
    await saveDescription(fx, issue, shown)
    const files = await plantFiles(fx, issue, LIMITS.attachments.max - 1)
    const upload = () =>
      as(fx.t, fx.admin).mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id })
    await refused(upload(), 'rule', LIMITS.attachments.refusal)
    // the save that takes the image out frees its place at once
    await saveDescription(fx, issue, 'Wiring')
    expect((await attachment(fx, image))?.dropped_at).toBeDefined()
    await upload()
    vi.stubEnv('BETTER_AUTH_SECRET', 'task-limits-test-secret')
    const read = await fx.t.query(internal.machine.rest.getIssue, {
      today: NOW.slice(0, 10),
      callerId: fx.agent.id,
      access: 'read',
      ref: key(issue),
    })
    vi.unstubAllEnvs()
    expect(read.attachments.map((a) => a.id)).not.toContain(image)
    // a file takes the place, so a save that shows the image again is refused
    const [late] = await plantFiles(fx, issue, 1)
    await refused(saveDescription(fx, issue, shown), 'rule', LIMITS.attachments.refusal)
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('issue_attachments')
        .withIndex('by_uuid', (q) => q.eq('id', late))
        .unique()
      if (row !== null) await ctx.db.delete(row._id)
    })
    await saveDescription(fx, issue, shown)
    expect((await attachment(fx, image))?.dropped_at).toBeUndefined()
    await refused(upload(), 'rule', LIMITS.attachments.refusal)
    expect(files).toHaveLength(LIMITS.attachments.max - 1)
  })

  it('keeps an image no saved description names yet until a day after its upload', async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Draft' })
    // pasted into a draft just now, and left by a closed tab two days ago
    const pasted = await plantImage(fx, issue)
    const left = await plantImage(
      fx,
      issue,
      new Date(Date.now() - 2 * DROPPED_KEEP_MS).toISOString(),
    )
    await saveDescription(fx, issue, 'Someone else saves other text')
    expect((await attachment(fx, pasted))?.dropped_at).toBeUndefined()
    expect((await attachment(fx, left))?.dropped_at).toBeDefined()
    // the draft saves its image later
    await saveDescription(fx, issue, `With the photo ![photo](att:${pasted})`)
    expect((await attachment(fx, pasted))?.dropped_at).toBeUndefined()
  })

  it('refuses a description that adds an image of another task, on every surface', async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Copy target' })
    const theirs = await plantImage(fx, await task(fx, { title: 'Image owner' }))
    const text = `Copied ![photo](att:${theirs})`
    const machine = { callerId: fx.agent.id, access: 'write' as const }
    for (const write of [
      () => saveDescription(fx, issue, text),
      () =>
        as(fx.t, fx.admin).mutation(api.issues.create, {
          org_id: fx.org.id,
          id: uuid(),
          project_id: fx.sub.id,
          title: 'New',
          description: text,
        }),
      () =>
        fx.t.mutation(internal.machine.rest.updateIssue, {
          ...machine,
          keyName: 'limits',
          ref: key(issue),
          body: JSON.stringify({ description: text }),
        }),
      () =>
        fx.t.mutation(internal.machine.rest.createIssue, {
          ...machine,
          keyName: 'limits',
          body: JSON.stringify({ project: fx.sub.key, title: 'New', description: text }),
        }),
      () =>
        fx.t.mutation(internal.machine.mcp.updateIssue, {
          ...machine,
          ref: key(issue),
          description: text,
        }),
      () =>
        fx.t.mutation(internal.machine.mcp.createIssue, {
          ...machine,
          project: fx.sub.key,
          title: 'New',
          description: text,
        }),
    ]) {
      await refused(write(), 'rule', IMAGE_NOT_ATTACHED)
    }
    // an id the saved text only named in prose is still no image of this
    // task when a later save shows it
    await saveDescription(fx, issue, `Mentions att:${theirs}`)
    await refused(
      saveDescription(fx, issue, `Shows ![photo](att:${theirs})`),
      'rule',
      IMAGE_NOT_ATTACHED,
    )
    // an id in prose or in code shows no image, so it is no reference
    const quoted = `See att:${theirs}, \`![photo](att:${theirs})\` and\n\`\`\`\n![photo](att:${theirs})\n\`\`\``
    await saveDescription(fx, issue, quoted)
    expect((await row(fx.t, issue.id)).description).toBe(quoted)
    // a reference the saved text already has, such as one to an image
    // deleted since, stays through a save of other text. Both copies hold
    // the saved text, and the save reads it from the description row.
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', issue.id))
        .unique()
      if (row !== null) await patchTask(ctx.db, row, { description: text })
    })
    await saveDescription(fx, issue, `${text} and more`)
    expect((await row(fx.t, issue.id)).description).toBe(`${text} and more`)
  })

  it('deletes a dropped image with its bytes a day later, unless a save brought it back', async () => {
    vi.useFakeTimers()
    try {
      const fx = await setup()
      const issue = await task(fx, { title: 'Undo' })
      const [gone, back] = [await plantImage(fx, issue), await plantImage(fx, issue)]
      const both = `![a](att:${gone}) ![b](att:${back})`
      await saveDescription(fx, issue, both)
      await saveDescription(fx, issue, 'Neither')
      // an undo brings one back
      await saveDescription(fx, issue, `![b](att:${back})`)
      const bytes = (await attachment(fx, gone))?.storage_id
      vi.advanceTimersByTime(DROPPED_KEEP_MS + 1)
      // only what is due now, so the held file's erase a week later waits
      await fx.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0))
      expect(await attachment(fx, gone)).toBeNull()
      expect(await fileState(fx.t, bytes!)).toBe('held')
      expect((await attachment(fx, back))?.dropped_at).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes overdue dropped images, and the oldest past the cap, on a description save', async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Many drops' })
    const minute = 60_000
    // DROPPED_IMAGES_MAX dropped in the last hours, one older among them,
    // and one dropped two days ago
    const recent = await fx.t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i <= DROPPED_IMAGES_MAX; i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('issue_attachments', {
          id,
          org_id: fx.org.id,
          issue_id: issue.id,
          name: `drop-${i}.png`,
          size_bytes: 3,
          storage_id: await ctx.storage.store(new Blob(['png']) as never),
          inline: true,
          created_at: NOW,
          dropped_at: new Date(Date.now() - (i + 1) * minute).toISOString(),
        })
      }
      return ids
    })
    const overdue = await plantImage(fx, issue)
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('issue_attachments')
        .withIndex('by_uuid', (q) => q.eq('id', overdue))
        .unique()
      if (row !== null) {
        await ctx.db.patch(row._id, {
          dropped_at: new Date(Date.now() - 2 * DROPPED_KEEP_MS).toISOString(),
        })
      }
    })
    await saveDescription(fx, issue, 'Text without images')
    expect(await attachment(fx, overdue)).toBeNull()
    // the oldest of the recent ones goes, the newest DROPPED_IMAGES_MAX stay
    expect(await attachment(fx, recent[DROPPED_IMAGES_MAX])).toBeNull()
    for (const id of recent.slice(0, DROPPED_IMAGES_MAX)) {
      expect((await attachment(fx, id))?.dropped_at).toBeDefined()
    }
  })

  it('deletes a dropped image of a task restored from Deleted items after its day', async () => {
    vi.useFakeTimers()
    try {
      const fx = await setup()
      const issue = await task(fx, { title: 'Deleted with a dropped image' })
      const image = await plantImage(fx, issue)
      await saveDescription(fx, issue, `![a](att:${image})`)
      await saveDescription(fx, issue, 'Without it')
      await deleteTask(fx.t, fx, issue.id)
      // the step its drop scheduled runs while the image is in Deleted items
      vi.advanceTimersByTime(DROPPED_KEEP_MS + 1)
      await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
      await as(fx.t, fx.user).mutation(api.deletedItems.restore, {
        org_id: fx.org.id,
        ids: [(await itemFor(fx.t, issue.id)).id],
      })
      await fx.t.finishAllScheduledFunctions(vi.runAllTimers)
      expect((await row(fx.t, issue.id)).description).toBe('Without it')
      expect(await attachment(fx, image)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it(`refuses a link to a task that is an end of ${LIMITS.links.max} links, naming it, on every surface`, async () => {
    const fx = await setup()
    const hub = await task(fx, { title: 'Hub' })
    const ends = await plantSubtasks(fx, await task(fx), LIMITS.links.max - 1, {
      parent_id: undefined,
    })
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

  it(`leaves out a restored link to a task that reached ${LIMITS.links.max} links meanwhile`, async () => {
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
        await plantSubtasks(fx, await task(fx), LIMITS.links.max, { parent_id: undefined }),
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
      expect(links).toHaveLength(LIMITS.links.max)
      expect(links.some((l) => l.target_id === gone.id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it(`refuses a label past ${LIMITS.labels.max}, and lets one update swap labels on a full task`, async () => {
    const fx = await setup()
    const issue = await task(fx, { title: 'Tagged' })
    const labels = await fx.t.run(async (ctx) => {
      const out: string[] = []
      for (let i = 0; i < LIMITS.labels.max + 1; i++) {
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
      for (const label_id of out.slice(0, LIMITS.labels.max - 1))
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
    await toggle(labels[LIMITS.labels.max - 1], true)
    await refused(toggle(labels[LIMITS.labels.max], true), 'rule', LIMITS.labels.refusal)
    const patch = (body: object) =>
      fx.t.mutation(internal.machine.rest.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        keyName: 'limits',
        ref: key(issue),
        body: JSON.stringify(body),
      })
    await refused(patch({ add_labels: [labels[LIMITS.labels.max]] }), 'rule', LIMITS.labels.refusal)
    await refused(
      fx.t.mutation(internal.machine.mcp.updateIssue, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        add_labels: [labels[LIMITS.labels.max]],
      }),
      'rule',
      LIMITS.labels.refusal,
    )
    await patch({ remove_labels: [labels[0]], add_labels: [labels[LIMITS.labels.max]] })
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
  it(`refuses a follow by hand past ${LIMITS.followers.max} on every surface, and never refuses a follower`, async () => {
    const fx = await setup()
    const issue = await task(fx)
    await plantFollowers(fx, issue, LIMITS.followers.max - 1)
    const app = (who: Doc<'profiles'>) =>
      as(fx.t, who).mutation(api.issues.subscribe, { org_id: fx.org.id, issue_id: issue.id })
    // the hundredth follows
    await app(fx.user)
    expect(await followers(fx.t, issue.id)).toHaveLength(LIMITS.followers.max)
    await refused(app(fx.admin), 'rule', LIMITS.followers.refusal)
    await refused(
      as(fx.t, fx.admin).mutation(api.issues.setSubscriber, {
        org_id: fx.org.id,
        issue_id: issue.id,
        profile_id: fx.guest.id,
        subscribed: true,
      }),
      'rule',
      LIMITS.followers.refusal,
    )
    await refused(
      fx.t.mutation(internal.machine.discussion.restFollowTask, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
      }),
      'rule',
      LIMITS.followers.refusal,
    )
    await refused(
      fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
        callerId: fx.agent.id,
        access: 'write',
        ref: key(issue),
        following: true,
      }),
      'rule',
      LIMITS.followers.refusal,
    )
    // following again changes nothing and is no refusal; leaving makes room
    await app(fx.user)
    await as(fx.t, fx.user).mutation(api.issues.unsubscribe, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    await app(fx.admin)
    const now = await followers(fx.t, issue.id)
    expect(now).toHaveLength(LIMITS.followers.max)
    expect(now).toContain(fx.admin.id)
    expect(now).not.toContain(fx.user.id)
  })

  it('adds no follower on a comment or a mention past the limit, and still delivers both', async () => {
    const fx = await setup()
    const full = await task(fx, { title: 'Full' })
    const crowd = await plantFollowers(fx, full, LIMITS.followers.max)
    const comment = (issue: Doc<'issues'>) =>
      as(fx.t, fx.user).mutation(api.comments.create, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: issue.id,
        body: `Over to @[Admin](user:${fx.admin.id})`,
      })
    await comment(full)
    const after = await followers(fx.t, full.id)
    expect(after).toHaveLength(LIMITS.followers.max)
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
    await plantFollowers(fx, roomy, LIMITS.followers.max - 2)
    await comment(roomy)
    expect(await followers(fx.t, roomy.id)).toEqual(
      expect.arrayContaining([fx.user.id, fx.admin.id]),
    )
  })

  it('lists followers and candidates for a lead in an organization of thousands', async () => {
    // one sight check per person passed 4,096 index ranges here
    const fx = await setup(newT({ transactionLimits: true }))
    const issue = await task(fx)
    const crowd = await plantFollowers(fx, issue, LIMITS.followers.max)
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
    expect(roster.subscribers).toHaveLength(LIMITS.followers.max)
    expect(roster.subscribers).toEqual(expect.arrayContaining(crowd.map((p) => p.id)))
    // people who see TBED, the team's 1,200 included, and none of the 3,300
    // who do not
    expect(roster.candidates).toEqual(expect.arrayContaining([fx.user.id, fx.agent.id, ...team]))
    expect(roster.candidates.length).toBeLessThan(team.length + 10)
  })

  it('lets a new assignee and a new reviewer pass the limit', async () => {
    const fx = await setup()
    const issue = await task(fx, { status: 'progress' })
    await plantFollowers(fx, issue, LIMITS.followers.max)
    const update = (patch: Record<string, unknown>) =>
      as(fx.t, fx.admin).mutation(api.issues.update, { org_id: fx.org.id, id: issue.id, patch })
    await update({ assignee_id: fx.user.id })
    expect(await followers(fx.t, issue.id)).toHaveLength(LIMITS.followers.max + 1)
    await update({ reviewer_id: fx.admin.id, status: 'review' })
    const now = await followers(fx.t, issue.id)
    expect(now).toHaveLength(LIMITS.followers.max + 2)
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
  const at = (p: Doc<'profiles'>) => `@[${p.name}](user:${p.id})`

  it(`reach all of ${LIMITS.mentions.max} people, and a text that mentions more is refused on every surface`, async () => {
    const fx = await setup()
    const issue = await task(fx)
    const people = await plantFollowers(fx, await task(fx), LIMITS.mentions.max + 1)
    const full = people.slice(0, LIMITS.mentions.max).map(at).join(' ')
    // a repeated mention, one in a code span and a plain link count no one more
    const over = `${people.map(at).join(' ')}`
    const fine = `${full} ${at(people[0])} \`${at(people[LIMITS.mentions.max])}\` [x](user:${people[LIMITS.mentions.max].id})`
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id: uuid(),
      issue_id: issue.id,
      body: fine,
    })
    const mentioned = async (p: Doc<'profiles'>, on = issue) =>
      (await messagesFor(fx.t, p.id, on.id)).filter((m) => m.kind === 'mention').length
    expect(await mentioned(people[LIMITS.mentions.max - 1])).toBe(1)
    expect(await mentioned(people[LIMITS.mentions.max])).toBe(0)

    const comment = (await fx.t.run((ctx) => ctx.db.query('comments').collect()))[0]
    const described = await task(fx)
    const writes = {
      appComment: () =>
        as(fx.t, fx.user).mutation(api.comments.create, {
          org_id: fx.org.id,
          id: uuid(),
          issue_id: issue.id,
          body: over,
        }),
      appEdit: () =>
        as(fx.t, fx.user).mutation(api.comments.update, {
          org_id: fx.org.id,
          id: comment.id,
          body: over,
        }),
      appCreate: () =>
        as(fx.t, fx.admin).mutation(api.issues.create, {
          org_id: fx.org.id,
          id: uuid(),
          project_id: fx.sub.id,
          title: 'Crowded',
          description: over,
        }),
      appUpdate: () =>
        as(fx.t, fx.admin).mutation(api.issues.update, {
          org_id: fx.org.id,
          id: described.id,
          patch: { description: over },
        }),
      restComment: () =>
        fx.t.mutation(internal.machine.rest.addComment, {
          callerId: fx.agent.id,
          access: 'write',
          ref: key(issue),
          body: JSON.stringify({ body: over }),
        }),
      restUpdate: () =>
        fx.t.mutation(internal.machine.rest.updateIssue, {
          callerId: fx.agent.id,
          access: 'write',
          keyName: 'limits',
          ref: key(described),
          body: JSON.stringify({ description: over }),
        }),
      mcpComment: () =>
        fx.t.mutation(internal.machine.mcp.addComment, {
          callerId: fx.agent.id,
          access: 'write',
          ref: key(issue),
          body: over,
        }),
      mcpCreate: () =>
        fx.t.mutation(internal.machine.mcp.createIssue, {
          callerId: fx.agent.id,
          access: 'write',
          project: fx.sub.key,
          title: 'Crowded',
          description: over,
        }),
    }
    for (const write of Object.values(writes))
      await refused(write(), 'rule', LIMITS.mentions.refusal)
    // nothing saved and nobody heard
    expect((await row(fx.t, described.id)).description).toBe(described.description)
    expect(await mentioned(people[LIMITS.mentions.max])).toBe(0)
    expect(await mentioned(people[0], described)).toBe(0)
  })

  it('re-notify no one who stayed mentioned when an edit drops another', async () => {
    const fx = await setup()
    const people = await plantFollowers(fx, await task(fx), LIMITS.mentions.max)
    const described = await task(fx, { description: people.map(at).join(' ') })
    await as(fx.t, fx.admin).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: described.id,
      patch: { description: people.slice(1).map(at).join(' ') },
    })
    expect(
      (await messagesFor(fx.t, people[1].id, described.id)).filter((m) => m.kind === 'mention'),
    ).toEqual([])
  })

  it('refuses a stored text over the limit even when sent back unchanged, and an edit within it re-notifies no one', async () => {
    const fx = await setup()
    const people = await plantFollowers(fx, await task(fx), LIMITS.mentions.max + 2)
    const stored = people.map(at).join(' ')
    // planted past the limit, which no write can store
    const described = await task(fx, { description: stored })
    const update = (description: string) =>
      as(fx.t, fx.admin).mutation(api.issues.update, {
        org_id: fx.org.id,
        id: described.id,
        patch: { description },
      })
    // the limit comes before the check for an unchanged text
    await refused(update(stored), 'rule', LIMITS.mentions.refusal)
    // dropping the first mention leaves one past the limit
    await refused(update(people.slice(1).map(at).join(' ')), 'rule', LIMITS.mentions.refusal)
    // dropping two fits: everyone left was mentioned before, so hears
    // nothing new
    await update(people.slice(2).map(at).join(' '))
    expect(
      (await messagesFor(fx.t, people[LIMITS.mentions.max].id, described.id)).filter(
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
