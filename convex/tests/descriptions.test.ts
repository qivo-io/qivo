/* Task descriptions in issue_descriptions (schema.ts, model/descriptions.ts),
 * the first of three releases. Every writer keeps exactly one row per live
 * task equal to issues.description, with copies of the task's project and
 * archived state that every move and archive keeps, and
 * internal/descriptionsBackfill gives older tasks their rows, reports what
 * differs and mends it. Each case also checks a write that must leave the
 * rows as they were. scripts/check-task-writes.test.mjs covers the check
 * that no other code writes them. */

import type { WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { PAGE, RUN } from '../internal/descriptionsBackfill'
import { newWindowKey } from '../lib/db'
import { LIMITS } from '../lib/limits'
import { deleteOrgDeep } from '../model/cascade'
import { clearOrgTrash, startPurge, TRASH_BUDGET } from '../model/deletedItems'
import { insertTask, putDescription } from '../model/descriptions'
import { MOVE_TOO_LARGE, SUBTREE_TOO_LARGE } from '../model/issues'
import { wipeWorkStep } from '../model/orgDeletion'
import {
  as,
  expectDescriptions,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'
import {
  comment,
  DEFAULT_BUDGET,
  deleteProject,
  deleteTask,
  installTrashTimers,
  itemById,
  itemFor,
  liveTask,
  runSteps,
  step,
  storedIssue,
} from './trash.setup'

installTrashTimers()
const DEFAULT_PAGE = { ...PAGE }
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(PAGE, DEFAULT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
})

/** withOrg with the agent able to write the fixture's sub-projects, for
 * REST and MCP. */
async function machineOrg(t: T): Promise<OrgFixture> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  return f
}

/** The description rows of task `id`. */
const rowsOf = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect(),
  )

/** A task inserted as it was stored before issue_descriptions existed:
 * with issues.description and without its row. */
const plantOldTask = (t: T, f: OrgFixture, description: string, project_id = f.sub.id) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('issues', {
      id,
      org_id: f.org.id,
      project_id,
      num: 900 + Math.floor(Math.random() * 1_000_000),
      title: 'Stored before the table',
      description,
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      window_key: newWindowKey(),
    })
    return id
  })

const create = (t: T, f: OrgFixture, args: { description?: string | null; id?: string } = {}) =>
  as(t, f.user).mutation(api.issues.create, {
    org_id: f.org.id,
    id: args.id ?? uuid(),
    project_id: f.sub.id,
    title: 'Described',
    ...('description' in args ? { description: args.description } : {}),
  })

const edit = (
  t: T,
  f: OrgFixture,
  id: string,
  patch: { description?: string | null; title?: string },
) => as(t, f.user).mutation(api.issues.update, { org_id: f.org.id, id, patch })

describe('the writers keep one equal row per task', () => {
  it('creates through the app, REST and MCP, and a refused create adds none', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const app = await create(t, f, { description: '\n\nFrom the app  \n' })
    await create(t, f) // no description: ''
    const rest = await t.mutation(internal.machine.rest.createIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      body: JSON.stringify({ project: f.sub.id, title: 'REST', description: 'From REST' }),
    })
    const mcp = JSON.parse(
      await t.mutation(internal.machine.mcp.createIssue, {
        callerId: f.agent.id,
        access: 'write',
        project: f.sub.id,
        title: 'MCP',
        description: 'From MCP',
      }),
    ) as { id: string }
    expect(await expectDescriptions(t, f.org.id)).toBe(4)
    // the row holds what the task row holds, without the blank lines before
    // and the spaces after (lib/limits.ts trimMarkdown)
    expect((await rowsOf(t, app.id))[0].description).toBe('From the app')
    expect((await rowsOf(t, rest.id))[0].description).toBe('From REST')
    expect((await rowsOf(t, mcp.id))[0].description).toBe('From MCP')

    // a used id, an image the task does not have and text past the cap are
    // refused before anything is written
    await expectRefusal(create(t, f, { id: app.id, description: 'Again' }), 'bad_request')
    await expectRefusal(create(t, f, { description: `![x](att:${uuid()})` }), 'rule')
    await expectRefusal(
      create(t, f, { description: 'x'.repeat(LIMITS.description.max + 1) }),
      'rule',
    )
    expect(await expectDescriptions(t, f.org.id)).toBe(4)
    expect((await rowsOf(t, app.id))[0].description).toBe('From the app')
  })

  it('edits through the app, REST and MCP, a clear, and edits that leave it alone', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [before] = await rowsOf(t, task.id)
    await edit(t, f, task.id, { title: 'Only the title' })
    // an edit of other fields does not write the row
    expect(await rowsOf(t, task.id)).toEqual([before])

    await edit(t, f, task.id, { description: 'From the app' })
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      ref: task.id,
      body: JSON.stringify({ description: 'From REST' }),
    })
    expect((await rowsOf(t, task.id))[0].description).toBe('From REST')
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: task.id,
      description: 'From MCP',
    })
    expect((await rowsOf(t, task.id))[0].description).toBe('From MCP')
    await edit(t, f, task.id, { description: null })
    expect(await rowsOf(t, task.id)).toMatchObject([{ _id: before._id, description: '' }])
    await expectDescriptions(t, f.org.id)

    // a refused save leaves both copies as they were
    await expectRefusal(
      edit(t, f, task.id, { description: 'x'.repeat(LIMITS.description.max + 1) }),
      'rule',
    )
    expect((await rowsOf(t, task.id))[0].description).toBe('')
    await expectDescriptions(t, f.org.id)
  })

  it('gives a task stored before the table its row on its first description save', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = await plantOldTask(t, f, 'Old text')
    await edit(t, f, old, { title: 'Renamed' })
    expect(await rowsOf(t, old)).toEqual([])
    await edit(t, f, old, { description: 'New text' })
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
  })

  it('settles description images and the row in one save', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const image = await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('issue_attachments', {
        id,
        org_id: f.org.id,
        issue_id: task.id,
        name: 'photo.png',
        size_bytes: 3,
        storage_id: await ctx.storage.store(new Blob(['png']) as never),
        inline: true,
        created_at: NOW,
      })
      return id
    })
    const attachment = () =>
      t.run((ctx) =>
        ctx.db
          .query('issue_attachments')
          .withIndex('by_uuid', (q) => q.eq('id', image))
          .unique(),
      )
    await edit(t, f, task.id, { description: `Wiring ![photo](att:${image})` })
    expect((await rowsOf(t, task.id))[0].description).toBe(`Wiring ![photo](att:${image})`)
    await edit(t, f, task.id, { description: 'Wiring' })
    expect((await attachment())?.dropped_at).toBeDefined()
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    // an image of another task is refused, and neither copy changes
    await expectRefusal(edit(t, f, task.id, { description: `![x](att:${uuid()})` }), 'rule')
    expect((await rowsOf(t, task.id))[0].description).toBe('Wiring')
  })

  it('the over-cap fix trims both copies, and its dry run neither', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: '\nUntrimmed  ',
    })
    await t.action(internal.internal.overCapRows.fix, { dry_run: true })
    expect((await rowsOf(t, task.id))[0].description).toBe('\nUntrimmed  ')
    await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    expect((await liveTask(t, task.id))?.description).toBe('Untrimmed')
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
  })

  it("the over-cap fix's pages read no description row, within Convex's limits", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 80 untrimmed descriptions of 20,000 three-byte characters. A page
    // reads 4 MiB of them, and their rows, read and patched there, would
    // take it past 16 MiB
    const text = '中'.repeat(LIMITS.description.max)
    for (let from = 0; from < 80; from += 10)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 10; i++)
          await insertTask(ctx.db, {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 5000 + i,
            title: 'Untrimmed',
            description: `${text}  `,
            status: 'todo',
            priority: 'low',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          })
      })
    await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    expect(await expectDescriptions(t, f.org.id)).toBe(80)
    const rows = await t.run((ctx) => ctx.db.query('issue_descriptions').collect())
    expect(rows.every((row) => row.description === text)).toBe(true)
  }, 120_000)
})

/** Gives the description row of task `id` the text `description`, as an
 * earlier release that changed the task row alone leaves it. */
const staleRow = (t: T, id: string, description: string) =>
  t.run(async (ctx) => {
    const [row] = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect()
    await ctx.db.patch(row._id, { description })
  })

describe('Deleted items', () => {
  it("stores the task row's text, else the row's, its steps drop the row, and a restore writes it back", async () => {
    const t = newT()
    const f = await withOrg(t)
    const root = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Root',
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: root.id,
      description: 'Child',
    })
    // as the third release leaves it, with the text only in the row
    await t.run((ctx) => ctx.db.patch(child._id, { description: undefined }))
    const old = await plantOldTask(t, f, 'Before the table')
    await deleteTask(t, f, root.id, { subtask_ids: [child.id] })
    await deleteTask(t, f, old)
    await runSteps(t)
    for (const id of [root.id, child.id, old]) expect(await rowsOf(t, id)).toEqual([])
    expect((await storedIssue(t, root.id))?.description).toBe('Root')
    expect((await storedIssue(t, child.id))?.description).toBe('Child')
    expect((await storedIssue(t, old))?.description).toBe('Before the table')

    const items = [(await itemFor(t, root.id)).id, (await itemFor(t, old)).id]
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: items })
    await runSteps(t)
    expect((await liveTask(t, child.id))?.description).toBe('Child')
    expect((await rowsOf(t, old))[0].description).toBe('Before the table')
    expect(await expectDescriptions(t, f.org.id)).toBe(3)
    await assertNoDanglingRefs(t, 'after a restore')
  })

  it('keeps issues.description over a row an earlier release left behind, in a task and a project item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Task',
    })
    const inProject = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      description: 'In the project',
    })
    // an earlier release edited both tasks without their rows
    await staleRow(t, task.id, 'Stale task')
    await staleRow(t, inProject.id, 'Stale project task')
    await deleteTask(t, f, task.id)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    expect((await storedIssue(t, task.id))?.description).toBe('Task')
    expect((await storedIssue(t, inProject.id))?.description).toBe('In the project')
    for (const id of [task.id, inProject.id]) expect(await rowsOf(t, id)).toEqual([])

    const items = [(await itemFor(t, task.id)).id, (await itemFor(t, f.sub2.id)).id]
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: items })
    await runSteps(t)
    expect((await rowsOf(t, task.id))[0].description).toBe('Task')
    expect((await rowsOf(t, inProject.id))[0].description).toBe('In the project')
    expect(await expectDescriptions(t, f.org.id)).toBe(2)
  })

  it("takes a project's tasks with their rows and brings them back, and a purge leaves none", async () => {
    const t = newT()
    const f = await withOrg(t)
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Kept',
    })
    const ids: string[] = []
    for (const description of ['One', 'Two', 'Three'])
      ids.push((await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, description })).id)
    // as the third release leaves it, with the text only in the row
    await t.run(async (ctx) => {
      const task = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', ids[0]))
        .unique()
      if (task !== null) await ctx.db.patch(task._id, { description: undefined })
    })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    // the other project's task keeps its row
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    expect((await rowsOf(t, kept.id))[0].description).toBe('Kept')
    expect((await storedIssue(t, ids[0]))?.description).toBe('One')

    const item = await itemFor(t, f.sub2.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] })
    await runSteps(t)
    expect(await expectDescriptions(t, f.org.id)).toBe(4)
    expect((await rowsOf(t, ids[0]))[0].description).toBe('One')

    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const again = await itemFor(t, f.sub2.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [again.id] })
    await runSteps(t)
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    await assertNoDanglingRefs(t, 'after a purge')
  })
})

/** A task item whose restore splits off a subtask whose project was
 * purged, stopped after the split deleted the stored task row but before
 * it deleted the task's deleted_tasks row, so the subtask's id is free.
 * Answers the item and the subtask. */
async function splitHalfway(t: T, f: OrgFixture) {
  const org_id = f.org.id
  const gone = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
  const root = await plantIssue(t, { org_id, project_id: f.sub.id })
  const sub = await plantIssue(t, { org_id, project_id: gone.id, parent_id: root.id })
  for (let i = 0; i < 3; i++) await comment(t, sub)
  await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
  await deleteProject(t, f, gone.id)
  await runSteps(t)
  const goneItem = await itemFor(t, gone.id)
  await t.run((ctx) => startPurge(ctx, goneItem, { inline: true }))
  await runSteps(t)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const item = await itemFor(t, root.id)
  // each step deletes one row
  Object.assign(TRASH_BUDGET, { rows: 1 })
  await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
  const marker = () =>
    t.run((ctx) =>
      ctx.db
        .query('deleted_tasks')
        .withIndex('by_task', (q) => q.eq('task_id', sub.id))
        .first(),
    )
  for (let steps = 0; ; steps++) {
    if ((await storedIssue(t, sub.id)) === undefined && (await marker()) !== null) break
    expect(steps).toBeLessThan(40)
    await step(t, item.id)
  }
  Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
  return { item, sub }
}

/** Creates a task with id `id` in `f`'s organization, or in the other
 * organization, and answers that organization's id. */
async function createWithId(t: T, f: OrgFixture, id: string, where: 'same' | 'other') {
  if (where === 'same') {
    await create(t, f, { id, description: 'Mine' })
    return f.org.id
  }
  const sub = await plantProject(t, {
    org_id: f.otherOrg.id,
    type: 'project',
    parent_id: f.otherProject.id,
  })
  await as(t, f.otherAdmin).mutation(api.issues.create, {
    org_id: f.otherOrg.id,
    id,
    project_id: sub.id,
    title: 'Mine',
    description: 'Mine',
  })
  return f.otherOrg.id
}

describe('a task id that comes back', () => {
  it("leaves another organization's row that waits for its own steps when a split stopped partway goes on", async () => {
    const t = newT()
    const f = await withOrg(t)
    const { item, sub } = await splitHalfway(t, f)
    await createWithId(t, f, sub.id, 'other')
    // the other organization deletes the task, and its row waits for that
    // item's steps
    Object.assign(TRASH_BUDGET, { ranges: 1 })
    await as(t, f.otherAdmin).mutation(api.issues.deleteDeep, { org_id: f.otherOrg.id, id: sub.id })
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    expect(await rowsOf(t, sub.id)).toMatchObject([{ org_id: f.otherOrg.id }])
    // only this organization's split goes on
    for (let steps = 0; (await itemById(t, item.id)) !== null; steps++) {
      expect(steps).toBeLessThan(40)
      await step(t, item.id)
    }
    expect(await rowsOf(t, sub.id)).toMatchObject([{ org_id: f.otherOrg.id }])
    // the other item's steps take it
    await runSteps(t)
    expect(await rowsOf(t, sub.id)).toEqual([])
  })

  for (const where of ['same', 'other'] as const) {
    const org = where === 'same' ? 'the same organization' : 'another organization'
    it(`keeps its row when a split stopped partway goes on, in ${org}`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const { sub } = await splitHalfway(t, f)
      const orgId = await createWithId(t, f, sub.id, where)
      await runSteps(t)
      expect(await liveTask(t, sub.id)).toMatchObject({ org_id: orgId, description: 'Mine' })
      expect(await rowsOf(t, sub.id)).toMatchObject([{ org_id: orgId, description: 'Mine' }])
      await expectDescriptions(t, orgId)
    })

    it(`keeps its row when a teardown clears the Deleted items of a split stopped partway, in ${org}`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const { sub } = await splitHalfway(t, f)
      const orgId = await createWithId(t, f, sub.id, where)
      await t.run((ctx) => clearOrgTrash(ctx, f.org.id, { left: Number.POSITIVE_INFINITY }))
      expect(await rowsOf(t, sub.id)).toMatchObject([{ org_id: orgId, description: 'Mine' }])
      await expectDescriptions(t, orgId)
    })
  }

  it("takes over the row with its own organization, which the first one's teardown leaves alone", async () => {
    const t = newT()
    const f = await withOrg(t)
    const first = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'First',
    })
    await deleteTask(t, f, first.id)
    await runSteps(t)
    await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id: f.org.id,
      ids: [(await itemFor(t, first.id)).id],
    })
    await runSteps(t)
    expect(await liveTask(t, first.id)).toBeNull()
    // a row the purged task kept, as an earlier release leaves one
    await t.run((ctx) =>
      ctx.db.insert('issue_descriptions', {
        issue_id: first.id,
        org_id: f.org.id,
        description: 'First',
      }),
    )
    // the id is free, and the other organization's create takes it
    const sub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    await as(t, f.otherAdmin).mutation(api.issues.create, {
      org_id: f.otherOrg.id,
      id: first.id,
      project_id: sub.id,
      title: 'Second',
      description: 'Second',
    })
    expect(await rowsOf(t, first.id)).toMatchObject([
      { org_id: f.otherOrg.id, description: 'Second' },
    ])
    await t.run((ctx) => deleteOrgDeep(ctx, f.org))
    expect(await expectDescriptions(t, f.otherOrg.id)).toBe(1)
  })
})

describe('teardowns', () => {
  /** Plants tasks in both organizations, one of them stored before the
   * table, and a row whose task is gone. */
  async function plantWork(t: T, f: OrgFixture) {
    for (const description of ['A', 'B'])
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })
    await plantOldTask(t, f, 'Old')
    await t.run((ctx) =>
      putDescription(ctx.db, { id: uuid(), org_id: f.org.id, project_id: f.sub.id }, 'Orphan'),
    )
    await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      description: 'Other',
    })
  }
  const orgRows = (t: T, orgId: string) =>
    t.run((ctx) =>
      ctx.db
        .query('issue_descriptions')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )

  it("an organization's deletion in steps deletes its rows and leaves the others", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantWork(t, f)
    await as(t, f.admin).mutation(api.orgRemovals.recordExport, { org_id: f.org.id })
    const { delete_after } = await as(t, f.admin).action(api.orgRemovals.request, {
      org_id: f.org.id,
      confirm: f.org.slug,
    })
    vi.setSystemTime(Date.parse(delete_after) + 60_000)
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    for (let steps = 0; ; steps++) {
      const removal = await t.run((ctx) =>
        ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique(),
      )
      if (removal === null) break
      expect(steps).toBeLessThan(50)
      await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    }
    expect(await orgRows(t, f.org.id)).toEqual([])
    expect(await expectDescriptions(t, f.otherOrg.id)).toBe(1)
  })

  it('the deep delete and the Northstar wipe delete every row of the organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantWork(t, f)
    for (let done = false; !done; )
      done = await t.run((ctx) => wipeWorkStep(ctx, f.org.id, [f.user.id]))
    expect(await orgRows(t, f.org.id)).toEqual([])
    expect(await expectDescriptions(t, f.otherOrg.id)).toBe(1)

    await plantWork(t, f)
    await t.run((ctx) => deleteOrgDeep(ctx, f.org))
    expect(await orgRows(t, f.org.id)).toEqual([])
    // plantWork gave the other organization a second task
    expect(await expectDescriptions(t, f.otherOrg.id)).toBe(2)
  })

  it('the guest organization fixture plants and tears down its tasks with their rows', async () => {
    const t = newT()
    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    expect(await expectDescriptions(t, org_id)).toBe(3)
    // a second run tears the first down and plants it again
    expect(await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})).toMatchObject({
      torn_down: true,
    })
    expect(await expectDescriptions(t)).toBe(3)
  })
})

/* ------------------------------------------- project and archived copies */

/** The only description row of task `id`. */
async function rowOf(t: T, id: string) {
  const rows = await rowsOf(t, id)
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** A sub-project of the fixture's second top-level project, which the
 * agent may write too, for moves that carry subtasks. */
async function awayProject(t: T, f: OrgFixture) {
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.hidden.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  return await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.hidden.id })
}

/** `count` tasks with descriptions of LIMITS.description.max three-byte
 * characters and their rows, ten a transaction. */
async function plantLong(
  t: T,
  count: number,
  task: { org_id: string; project_id: string } & Partial<WithoutSystemFields<Doc<'issues'>>>,
) {
  const text = '中'.repeat(LIMITS.description.max)
  const ids: string[] = []
  for (let from = 0; from < count; from += 10)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + 10); i++) {
        const id = uuid()
        await insertTask(ctx.db, {
          id,
          num: 70_000 + ids.length,
          title: 'Long',
          description: text,
          status: 'todo',
          priority: 'low',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          window_key: newWindowKey(),
          ...task,
        })
        ids.push(id)
      }
    })
  return ids
}

describe('the project and archived copies', () => {
  it('moves through the app and REST carry them, a subtree to another top-level project included', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const away = await awayProject(t, f)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, base)
    const kid = await plantIssue(t, { ...base, parent_id: root.id })
    const shelved = await plantIssue(t, { ...base, parent_id: root.id, archived_at: NOW })
    const lone = await plantIssue(t, base)
    const untouched = await plantIssue(t, base)
    const [before] = await rowsOf(t, untouched.id)
    // to another top-level project the subtasks come along, the archived one
    // too, which stays archived
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: root.id,
      project_id: away.id,
    })
    for (const id of [root.id, kid.id, shelved.id])
      expect((await rowOf(t, id)).project_id).toBe(away.id)
    expect((await rowOf(t, shelved.id)).archived_at).toBe(NOW)
    // REST and MCP move through the same core
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      ref: lone.id,
      body: JSON.stringify({ project: f.sub2.id }),
    })
    expect((await rowOf(t, lone.id)).project_id).toBe(f.sub2.id)
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: lone.id,
      project: f.hidden.id,
      sub_project: away.id,
    })
    expect((await rowOf(t, lone.id)).project_id).toBe(away.id)
    // a move to the project the task is in writes nothing
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: untouched.id,
      project_id: f.sub.id,
    })
    expect(await rowsOf(t, untouched.id)).toEqual([before])
    expect(await expectDescriptions(t, f.org.id)).toBe(5)
  })

  it('archives and restores through the app, REST and MCP carry them, a subtree included', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, base)
    const kids = [
      await plantIssue(t, { ...base, parent_id: root.id }),
      await plantIssue(t, { ...base, parent_id: root.id }),
    ]
    const family = [root.id, ...kids.map((kid) => kid.id)]
    const archivedAt = async (id: string) => (await rowOf(t, id)).archived_at
    await as(t, f.user).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: root.id,
      reason: 'Shipped',
    })
    for (const id of family) expect(await archivedAt(id)).toBeDefined()
    await expectDescriptions(t, f.org.id)
    // restoring a subtask brings its parent back too, and the parent's row
    // with it; the other subtask stays archived
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: kids[0].id })
    expect([await archivedAt(root.id), await archivedAt(kids[0].id)]).toEqual([
      undefined,
      undefined,
    ])
    expect(await archivedAt(kids[1].id)).toBeDefined()
    await expectDescriptions(t, f.org.id)

    // the machine toggle archives the subtree in the task's own write
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      ref: root.id,
      body: JSON.stringify({ archived: true }),
    })
    for (const id of family) expect(await archivedAt(id)).toBeDefined()
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: root.id,
      archived: false,
    })
    expect(await archivedAt(root.id)).toBeUndefined()
    // and the same toggle with an edit writes the row once, text and copies
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: kids[0].id,
      archived: true,
      description: 'Archived with a note',
    })
    expect(await rowOf(t, kids[0].id)).toMatchObject({
      description: 'Archived with a note',
      archived_at: expect.any(String),
    })
    expect(await expectDescriptions(t, f.org.id)).toBe(3)
  })

  it('the nightly archive stamps the rows of the tasks it archives', async () => {
    const t = newT()
    const f = await withOrg(t)
    const done_at = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const due = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at,
    })
    const young = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: new Date().toISOString(),
    })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)
    expect((await rowOf(t, due.id)).archived_at).toBeDefined()
    expect((await rowOf(t, young.id)).archived_at).toBeUndefined()
    expect(await expectDescriptions(t, f.org.id)).toBe(2)
  })

  it('a restore from Deleted items writes the copies of the task as it comes back', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
      description: 'Archived',
    })
    const inProject = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      description: 'In the project',
    })
    await deleteTask(t, f, archived.id)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    for (const id of [archived.id, inProject.id]) expect(await rowsOf(t, id)).toEqual([])
    const items = [(await itemFor(t, archived.id)).id, (await itemFor(t, f.sub2.id)).id]
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: items })
    await runSteps(t)
    expect(await rowOf(t, archived.id)).toMatchObject({ project_id: f.sub.id, archived_at: NOW })
    expect((await rowOf(t, inProject.id)).project_id).toBe(f.sub2.id)
    expect(await expectDescriptions(t, f.org.id)).toBe(2)
  })

  it('a task without a row gets none from a move or an archive, and the backfill inserts it with them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = await plantOldTask(t, f, 'Before the table')
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: old,
      project_id: f.sub2.id,
    })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: old })
    expect(await rowsOf(t, old)).toEqual([])
    expect(await backfill(t, { dry_run: false })).toMatchObject({ missing: 1, differ: 0 })
    expect(await rowOf(t, old)).toMatchObject({
      project_id: f.sub2.id,
      archived_at: expect.any(String),
      description: 'Before the table',
    })
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
  })

  it('a write that skips them leaves the rows stale, which the check sees', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // as an earlier release archives it, without its row
    await t.run((ctx) => ctx.db.patch(task._id, { archived_at: NOW }))
    await expect(expectDescriptions(t, f.org.id)).rejects.toThrow()
  })

  it('search_description filters by organization, project and archived state', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plant = async (project_id: string, archived_at?: string, org_id = f.org.id) =>
      (
        await plantIssue(t, {
          org_id,
          project_id,
          archived_at,
          description: 'Calibrate the torque sensor',
        })
      ).id
    const active = await plant(f.sub.id)
    const elsewhere = await plant(f.sub2.id)
    const shelved = await plant(f.sub.id, NOW)
    await plant(f.otherProject.id, undefined, f.otherOrg.id)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: 'Order cables' })
    const search = (narrow: { project_id?: string; active?: true } = {}) =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query('issue_descriptions')
            .withSearchIndex('search_description', (q) => {
              let filter = q.search('description', 'torque').eq('org_id', f.org.id)
              if (narrow.project_id !== undefined)
                filter = filter.eq('project_id', narrow.project_id)
              if (narrow.active) filter = filter.eq('archived_at', undefined)
              return filter
            })
            .collect()
        )
          .map((row) => row.issue_id)
          .sort(),
      )
    expect(await search()).toEqual([active, elsewhere, shelved].sort())
    expect(await search({ project_id: f.sub.id })).toEqual([active, shelved].sort())
    expect(await search({ active: true })).toEqual([active, elsewhere].sort())
    expect(await search({ project_id: f.sub.id, active: true })).toEqual([active])
    // the writers move rows between the filters
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: shelved })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: active })
    expect(await search({ project_id: f.sub.id, active: true })).toEqual([shelved])
    // a row without the copies, as rows written before them, matches no
    // project, so main Search waits for the backfill
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query('issue_descriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', shelved))
        .unique())!
      await ctx.db.patch(row._id, { project_id: undefined })
    })
    expect(await search({ project_id: f.sub.id, active: true })).toEqual([])
  })
})

describe("the copies at Convex's limits", () => {
  it('the nightly archive takes the largest descriptions in more, smaller legs', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const done_at = new Date(Date.now() - 60 * 86_400_000).toISOString()
    await plantLong(t, 120, { org_id: f.org.id, project_id: f.sub.id, status: 'done', done_at })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)
    expect(errors).not.toHaveBeenCalled()
    const legs = (
      await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    ).filter((job) => job.name.includes('archiveProject'))
    expect(legs.length).toBeGreaterThan(3)
    const rows = await t.run((ctx) => ctx.db.query('issue_descriptions').collect())
    expect(rows.every((row) => row.archived_at !== undefined)).toBe(true)
    expect(await expectDescriptions(t, f.org.id)).toBe(120)
  }, 300_000)

  it('a subtree archive or move of the largest descriptions finishes, or refuses and changes nothing', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const away = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const small = await plantIssue(t, base)
    const large = await plantIssue(t, base)
    await plantLong(t, 30, { ...base, parent_id: small.id })
    await plantLong(t, LIMITS.subtasks.max, { ...base, parent_id: large.id })
    const snapshotOf = () =>
      t.run(async (ctx) => ({
        tasks: await ctx.db.query('issues').collect(),
        rows: await ctx.db.query('issue_descriptions').collect(),
      }))
    const before = await snapshotOf()
    // each subtask reads its row and writes it with the task, so the room
    // check refuses the largest subtree before a Convex limit could stop it
    const move = await expectRefusal(
      as(t, f.admin).mutation(api.issues.move, {
        org_id: f.org.id,
        id: large.id,
        project_id: away.id,
      }),
      'rule',
    )
    expect(move.data.message).toBe(MOVE_TOO_LARGE)
    const archive = await expectRefusal(
      as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: large.id }),
      'rule',
    )
    expect(archive.data.message).toBe(SUBTREE_TOO_LARGE)
    expect(await snapshotOf()).toEqual(before)
    // a smaller one moves and archives, with its rows
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: small.id,
      project_id: away.id,
    })
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: small.id })
    const moved = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', small.id))
        .collect(),
    )
    expect(moved).toHaveLength(30)
    for (const kid of moved) expect(kid.project_id).toBe(away.id)
    expect(await expectDescriptions(t, f.org.id)).toBe(2 + 30 + LIMITS.subtasks.max)
  }, 300_000)

  it('refuses a subtree of descriptions stored before the caps before one patch could pass the read limit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const away = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const base = { org_id: f.org.id, project_id: f.sub.id }
    // five subtasks with descriptions of about 1 MiB from before the caps:
    // the change reads them in about 5 MiB, and each patch reads about
    // 3 MiB more, its task again and its row twice, so the fourth would pass
    // 16 MiB though the transaction had used less than 90 percent before it
    const legacy = 'x'.repeat(1_040_000)
    const root = await plantIssue(t, base)
    for (let i = 0; i < 5; i++)
      await plantIssue(t, { ...base, parent_id: root.id, description: legacy })
    const before = await snapshot(t)
    const archive = await expectRefusal(
      as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: root.id }),
      'rule',
    )
    expect(archive.data.message).toBe(SUBTREE_TOO_LARGE)
    const move = await expectRefusal(
      as(t, f.admin).mutation(api.issues.move, {
        org_id: f.org.id,
        id: root.id,
        project_id: away.id,
      }),
      'rule',
    )
    expect(move.data.message).toBe(MOVE_TOO_LARGE)
    expect(await snapshot(t)).toEqual(before)
    // two such subtasks archive with their rows
    const small = await plantIssue(t, base)
    const kids: string[] = []
    for (let i = 0; i < 2; i++)
      kids.push((await plantIssue(t, { ...base, parent_id: small.id, description: legacy })).id)
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: small.id })
    for (const id of kids) expect((await rowOf(t, id)).archived_at).toBeDefined()
  }, 120_000)
})

/* ------------------------------------------------------------- backfill */

type RunArgs = {
  dry_run: boolean
  repair?: boolean
  cursor?: { phase: 'tasks' | 'rows'; after: number }
}
const backfill = (t: T, args: RunArgs) => t.action(internal.internal.descriptionsBackfill.run, args)

/** Every row of the two tables, to show a call wrote nothing. */
const snapshot = (t: T) =>
  t.run(async (ctx) => ({
    tasks: await ctx.db.query('issues').collect(),
    rows: await ctx.db.query('issue_descriptions').collect(),
  }))

const audits = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_audit_log').collect()).filter(
      (row) => row.action === 'descriptions_backfill',
    ),
  )

/** The live task `id`'s row. */
const taskRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

/** A task of each kind the backfill finds, one it leaves alone and rows
 * that wait for a step or a teardown. */
async function plantKinds(t: T, f: OrgFixture) {
  const task = async (description: string) =>
    (await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })).id
  const fine = await task('Fine')
  const missing = await plantOldTask(t, f, 'Missing')
  const differs = await task('Truth')
  const otherOrg = await task('Mine')
  const doubled = await task('Twice')
  // a duplicate whose first row is the stale one
  const staleFirst = await task('Truth')
  // the third release's state, with no issues.description and the text in
  // the row
  const skipped = await task('Kept')
  // a task item whose steps have not run yet keeps its row
  const moving = await task('Moving')
  Object.assign(TRASH_BUDGET, { ranges: 1 })
  await deleteTask(t, f, moving)
  Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
  const orphan = uuid()
  const tornDown = uuid()
  await t.run(async (ctx) => {
    const rowOf = async (id: string) =>
      (await ctx.db
        .query('issue_descriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', id))
        .unique())!
    await ctx.db.patch((await rowOf(differs))._id, { description: 'Stale' })
    await ctx.db.patch((await rowOf(otherOrg))._id, { org_id: f.otherOrg.id })
    await ctx.db.insert('issue_descriptions', {
      issue_id: doubled,
      org_id: f.org.id,
      description: 'Twice',
    })
    await ctx.db.patch((await rowOf(staleFirst))._id, { description: 'Stale' })
    await ctx.db.insert('issue_descriptions', {
      issue_id: staleFirst,
      org_id: f.org.id,
      description: 'Truth',
    })
    const skippedTask = (await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', skipped))
      .unique())!
    await ctx.db.patch(skippedTask._id, { description: undefined })
    await ctx.db.insert('issue_descriptions', {
      issue_id: orphan,
      org_id: f.org.id,
      description: 'Gone',
    })
    // the other organization is being deleted, and its steps take this row
    await ctx.db.insert('org_removals', {
      org_id: f.otherOrg.id,
      reason: 'requested',
      ended_at: NOW,
      delete_after: NOW,
      phase: 'tasks',
      created_at: NOW,
    })
    await ctx.db.insert('issue_descriptions', {
      issue_id: tornDown,
      org_id: f.otherOrg.id,
      description: 'Being deleted',
    })
  })
  return {
    fine,
    missing,
    differs,
    otherOrg,
    doubled,
    staleFirst,
    skipped,
    moving,
    orphan,
    tornDown,
  }
}

/** What plantKinds plants, as a dry run reports it. */
const KINDS_FOUND = (k: Awaited<ReturnType<typeof plantKinds>>) => ({
  tasks: 7,
  missing: 1,
  differ: 3,
  duplicates: 2,
  orphans: 1,
  waiting: 2,
  skipped: 1,
  ids: {
    missing: [k.missing],
    differ: [k.differs, k.otherOrg, k.staleFirst],
    duplicates: [k.doubled, k.staleFirst],
    orphans: [k.orphan],
    waiting: [k.moving, k.tornDown],
    skipped: [k.skipped],
  },
})

describe('the backfill', () => {
  it('reports every kind in its dry run and writes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const k = await plantKinds(t, f)
    const before = await snapshot(t)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      ...KINDS_FOUND(k),
      done: true,
      cursor: null,
    })
    expect(await snapshot(t)).toEqual(before)
    expect(await audits(t)).toEqual([])
  })

  it('inserts missing rows, mends the rest only with repair, never writes a waiting or skipped row, and then reports zeros', async () => {
    const t = newT()
    const f = await withOrg(t)
    const k = await plantKinds(t, f)
    const found = KINDS_FOUND(k)
    const { ids: _ids, ...counts } = found
    expect(await backfill(t, { dry_run: false })).toMatchObject({ ...found, done: true })
    expect((await rowsOf(t, k.missing))[0].description).toBe('Missing')
    // without repair the rest stays, for a person to read first
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      missing: 0,
      differ: 3,
      duplicates: 2,
      orphans: 1,
    })
    expect((await audits(t)).map((row) => row.detail)).toEqual([
      { repair: false, ...counts, done: true, cursor: null },
    ])

    await backfill(t, { dry_run: false, repair: true })
    expect(await rowsOf(t, k.differs)).toMatchObject([{ description: 'Truth' }])
    expect(await rowsOf(t, k.otherOrg)).toMatchObject([{ org_id: f.org.id, description: 'Mine' }])
    expect(await rowsOf(t, k.doubled)).toMatchObject([{ description: 'Twice' }])
    expect(await rowsOf(t, k.staleFirst)).toMatchObject([{ description: 'Truth' }])
    expect(await rowsOf(t, k.orphan)).toEqual([])
    // its step and the organization's deletion take these
    expect(await rowsOf(t, k.moving)).toHaveLength(1)
    expect(await rowsOf(t, k.tornDown)).toHaveLength(1)
    // a task without issues.description keeps its row as it is
    expect(await rowsOf(t, k.skipped)).toMatchObject([{ description: 'Kept' }])
    expect((await taskRow(t, k.skipped))?.description).toBeUndefined()
    const left = { missing: 0, differ: 0, duplicates: 0, orphans: 0, waiting: 2, skipped: 1 }
    expect(await backfill(t, { dry_run: true })).toMatchObject({ tasks: 7, ...left })

    // running again changes nothing but its audit row
    const settled = await snapshot(t)
    expect(await backfill(t, { dry_run: false, repair: true })).toMatchObject(left)
    expect(await snapshot(t)).toEqual(settled)
    expect(await audits(t)).toHaveLength(3)

    // once the move's steps run, its row is gone
    await runSteps(t)
    expect(await rowsOf(t, k.moving)).toEqual([])
    expect(await backfill(t, { dry_run: true })).toMatchObject({ waiting: 1 })
  })

  it('reports rows without the copies or with stale ones as differ, and only repair stamps them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = async () => (await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })).id
    const fine = await task()
    const unstamped = await task()
    const archived = await task()
    const moved = await task()
    // the third release's state, whose row keeps the text
    const skipped = await task()
    await t.run(async (ctx) => {
      const rowOf = async (id: string) =>
        (await ctx.db
          .query('issue_descriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .unique())!
      const taskOf = async (id: string) =>
        (await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique())!
      // a row written before the copies
      await ctx.db.patch((await rowOf(unstamped))._id, { project_id: undefined })
      // an earlier release archived and moved these tasks without their rows
      await ctx.db.patch((await taskOf(archived))._id, { archived_at: NOW })
      await ctx.db.patch((await taskOf(moved))._id, { project_id: f.sub2.id })
      await ctx.db.patch((await taskOf(skipped))._id, {
        description: undefined,
        archived_at: NOW,
      })
      await ctx.db.patch((await rowOf(skipped))._id, { description: 'Kept' })
    })
    const before = await snapshot(t)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      tasks: 5,
      missing: 0,
      differ: 4,
      skipped: 1,
      ids: { differ: [unstamped, archived, moved, skipped], skipped: [skipped] },
    })
    expect(await snapshot(t)).toEqual(before)
    // a run without repair writes no differing row
    expect(await backfill(t, { dry_run: false })).toMatchObject({ differ: 4 })
    expect(await snapshot(t)).toEqual(before)

    await backfill(t, { dry_run: false, repair: true })
    expect(await rowOf(t, unstamped)).toMatchObject({ project_id: f.sub.id })
    expect(await rowOf(t, archived)).toMatchObject({ project_id: f.sub.id, archived_at: NOW })
    expect(await rowOf(t, moved)).toMatchObject({ project_id: f.sub2.id })
    expect(await rowOf(t, moved)).not.toHaveProperty('archived_at')
    // the skipped task's row keeps its text and takes the copies
    expect(await rowOf(t, skipped)).toMatchObject({ description: 'Kept', archived_at: NOW })
    expect((await rowsOf(t, fine))[0]).toEqual(before.rows.find((row) => row.issue_id === fine))
    expect(await backfill(t, { dry_run: true })).toMatchObject({ differ: 0, skipped: 1 })
  })

  it('counts every document a page reads, near-1 MiB rows and repair pages included', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // four tasks and rows of about 1 MiB; two rows are stale and one task
    // has a second row, so a repair page patches and deletes them
    const near = (c: string) => c.repeat(1_000_000)
    const ids: string[] = []
    for (const c of ['a', 'b', 'c', 'd'])
      ids.push(
        (await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: near(c) })).id,
      )
    for (const [id, text] of [
      [ids[1], 'x'],
      [ids[2], 'y'],
    ])
      await t.run(async (ctx) => {
        const [row] = await ctx.db
          .query('issue_descriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', id))
          .collect()
        await ctx.db.patch(row._id, { description: near(text) })
      })
    await t.run((ctx) =>
      ctx.db.insert('issue_descriptions', {
        issue_id: ids[3],
        org_id: f.org.id,
        description: near('d'),
      }),
    )
    const pageRef = internal.internal.descriptionsBackfill.page
    const checkRef = internal.internal.descriptionsBackfill.check
    const bound = PAGE.bytes + 6 * 1024 * 1024
    /** The pages of `phase` from the start, each with the bytes Convex
     * counted it reading. */
    const pages = async (phase: 'tasks' | 'rows', repair: boolean | null) => {
      const out: { tasks: number; bytes: number; read: number }[] = []
      for (let after = 0, done = false; !done; ) {
        const { result, read } = await t.run(async (ctx) => {
          const before = (await ctx.meta.getTransactionMetrics()).bytesRead.used
          const result =
            repair === null
              ? await ctx.runQuery(checkRef, { phase, after })
              : await ctx.runMutation(pageRef, { phase, after, repair })
          const read = (await ctx.meta.getTransactionMetrics()).bytesRead.used - before
          return { result, read }
        })
        out.push({ tasks: result.tasks, bytes: result.bytes, read })
        after = result.after
        done = result.done
      }
      return out
    }
    for (const repair of [null, true]) {
      const tasks = await pages('tasks', repair)
      const rows = await pages('rows', repair)
      for (const page of [...tasks, ...rows]) {
        expect(page.bytes).toBe(page.read)
        expect(page.read).toBeLessThanOrEqual(bound)
      }
      expect(tasks.reduce((sum, page) => sum + page.tasks, 0)).toBe(4)
      // rows this large end a page after a few tasks
      expect(tasks.length).toBeGreaterThan(1)
    }
    expect(await expectDescriptions(t)).toBe(4)
  }, 120_000)

  it('goes on from its cursor, a call at a time', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 6; i++) await plantOldTask(t, f, `Old ${i}`)
    Object.assign(PAGE, { rows: 2 })
    Object.assign(RUN, { ms: 0 })
    const calls: number[] = []
    let cursor: RunArgs['cursor']
    for (;;) {
      const result = await backfill(t, { dry_run: false, cursor })
      calls.push(result.missing)
      if (result.done) break
      cursor = result.cursor ?? undefined
      expect(calls.length).toBeLessThan(10)
    }
    expect(calls.reduce((sum, n) => sum + n, 0)).toBe(6)
    expect(calls.length).toBeGreaterThan(2)
    expect(await expectDescriptions(t)).toBe(6)
  })

  it('records the pages it committed and where to go on when a page fails', async () => {
    // a page that inserts more than 30 rows fails
    const t = newT({ transactionLimits: { documentsWritten: 30 } })
    const f = await withOrg(t)
    for (let i = 0; i < 15; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let i = 0; i < 55; i++) await plantOldTask(t, f, `Old ${i}`)
    // the first page holds 15 tasks with rows and 20 without, the second 35
    // without, which its inserts cannot write
    Object.assign(PAGE, { rows: 35 })
    await expect(backfill(t, { dry_run: false })).rejects.toThrow()
    const [record] = await audits(t)
    expect(record.detail).toMatchObject({ tasks: 35, missing: 20, done: false })
    const cursor = (record.detail as { cursor: RunArgs['cursor'] }).cursor
    expect(cursor?.phase).toBe('tasks')
    // smaller pages go on from where it stopped
    Object.assign(PAGE, { rows: 20 })
    expect(await backfill(t, { dry_run: false, cursor })).toMatchObject({ missing: 35, done: true })
    expect(await expectDescriptions(t)).toBe(70)
  })

  it('stays exact while the writers change tasks between its pages', async () => {
    const t = newT()
    const f = await withOrg(t)
    const olds: string[] = []
    for (let i = 0; i < 4; i++) olds.push(await plantOldTask(t, f, `Old ${i}`))
    Object.assign(PAGE, { rows: 1 })
    Object.assign(RUN, { ms: 0 })
    // the first page gives the first task its row
    const first = await backfill(t, { dry_run: false })
    expect(first.missing).toBe(1)
    // between pages: an edit of a task the run has passed, one of a task
    // it has not reached, a delete and a new task
    await edit(t, f, olds[0], { description: 'Edited after its page' })
    await edit(t, f, olds[2], { description: 'Edited before its page' })
    await deleteTask(t, f, olds[3])
    await runSteps(t)
    await create(t, f, { description: 'Created meanwhile' })
    let cursor = first.cursor ?? undefined
    for (let calls = 0; cursor !== undefined; calls++) {
      expect(calls).toBeLessThan(20)
      cursor = (await backfill(t, { dry_run: false, cursor })).cursor ?? undefined
    }
    expect(await expectDescriptions(t, f.org.id)).toBe(4)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      missing: 0,
      differ: 0,
      duplicates: 0,
      orphans: 0,
      waiting: 0,
      skipped: 0,
    })
  })
})
