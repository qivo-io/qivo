/* Task descriptions in issue_descriptions (schema.ts, model/descriptions.ts),
 * the first of three releases. Every writer keeps exactly one row per live
 * task equal to issues.description, and internal/descriptionsBackfill gives
 * older tasks their rows, reports what differs and mends it. Each case also
 * checks a write that must leave the rows as they were. scripts/
 * check-task-writes.test.mjs covers the check that no other code writes
 * them. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import { PAGE, RUN } from '../internal/descriptionsBackfill'
import { newWindowKey } from '../lib/db'
import { LIMITS } from '../lib/limits'
import { deleteOrgDeep } from '../model/cascade'
import { putDescription } from '../model/descriptions'
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
  deleteProject,
  deleteTask,
  installTrashTimers,
  itemFor,
  liveTask,
  runSteps,
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

describe('a task id that comes back', () => {
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
    await t.run((ctx) => putDescription(ctx.db, { id: uuid(), org_id: f.org.id }, 'Orphan'))
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

/** One task of each kind the backfill finds, and one it leaves alone. */
async function plantKinds(t: T, f: OrgFixture) {
  const fine = (
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: 'Fine' })
  ).id
  const missing = await plantOldTask(t, f, 'Missing')
  const differs = (
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: 'Truth' })
  ).id
  const doubled = (
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: 'Twice' })
  ).id
  const orphan = uuid()
  await t.run(async (ctx) => {
    const [row] = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', differs))
      .collect()
    await ctx.db.patch(row._id, { description: 'Stale' })
    await ctx.db.insert('issue_descriptions', {
      issue_id: doubled,
      org_id: f.org.id,
      description: 'Twice',
    })
    await ctx.db.insert('issue_descriptions', {
      issue_id: orphan,
      org_id: f.org.id,
      description: 'Gone',
    })
  })
  return { fine, missing, differs, doubled, orphan }
}

describe('the backfill', () => {
  it('reports in its dry run and writes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const k = await plantKinds(t, f)
    const before = await snapshot(t)
    const report = await backfill(t, { dry_run: true })
    expect(report).toMatchObject({
      tasks: 4,
      missing: 1,
      differ: 1,
      duplicates: 1,
      orphans: 1,
      missing_ids: [k.missing],
      differ_ids: [k.differs],
      duplicate_ids: [k.doubled],
      orphan_ids: [k.orphan],
      done: true,
      cursor: null,
    })
    expect(await snapshot(t)).toEqual(before)
    expect(await audits(t)).toEqual([])
  })

  it('inserts missing rows, mends the rest only with repair, and then reports zeros', async () => {
    const t = newT()
    const f = await withOrg(t)
    const k = await plantKinds(t, f)
    const run = await backfill(t, { dry_run: false })
    expect(run).toMatchObject({ missing: 1, differ: 1, duplicates: 1, orphans: 1, done: true })
    expect((await rowsOf(t, k.missing))[0].description).toBe('Missing')
    // without repair the rest stays, for a person to read first
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      missing: 0,
      differ: 1,
      duplicates: 1,
      orphans: 1,
    })
    expect((await audits(t)).map((row) => row.detail)).toEqual([
      { repair: false, tasks: 4, missing: 1, differ: 1, duplicates: 1, orphans: 1 },
    ])

    await backfill(t, { dry_run: false, repair: true })
    expect((await rowsOf(t, k.differs))[0].description).toBe('Truth')
    expect(await rowsOf(t, k.doubled)).toHaveLength(1)
    expect(await rowsOf(t, k.orphan)).toEqual([])
    expect(await expectDescriptions(t)).toBe(4)
    const zeros = { missing: 0, differ: 0, duplicates: 0, orphans: 0 }
    expect(await backfill(t, { dry_run: true })).toMatchObject({ tasks: 4, ...zeros })

    // running again changes nothing but its audit row
    const settled = await snapshot(t)
    expect(await backfill(t, { dry_run: false, repair: true })).toMatchObject(zeros)
    expect(await snapshot(t)).toEqual(settled)
    expect(await audits(t)).toHaveLength(3)
  })

  it('reads pages within its bytes, two documents a row, and goes on from its cursor', async () => {
    const t = newT()
    const f = await withOrg(t)
    // six tasks of about 300 KB, each with a row of the same size
    const big = 'x'.repeat(300_000)
    for (let i = 0; i < 6; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: `${i}${big}` })
    const check = (after: number) =>
      t.query(internal.internal.descriptionsBackfill.check, { phase: 'tasks', after })
    // At 1 MiB a page, the first read takes one row, which leaves room for
    // one more, and then the page has read past its bytes
    Object.assign(PAGE, { bytes: 1024 * 1024 })
    const pages: number[] = []
    for (let after = 0, done = false; !done; ) {
      const page = await check(after)
      pages.push(page.tasks)
      after = page.after
      done = page.done
    }
    expect(pages).toEqual([2, 2, 2, 0])
    // the same rows in pages of PAGE.rows
    Object.assign(PAGE, { rows: 4, bytes: 8 * 1024 * 1024 })
    const first = await check(0)
    expect({ tasks: first.tasks, done: first.done }).toEqual({ tasks: 4, done: false })

    // a call stops after RUN.ms with a cursor, and the next goes on from it
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('issue_descriptions').collect())
        await ctx.db.delete(row._id)
    })
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
    })
  })
})
