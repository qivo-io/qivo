/* Task descriptions in issue_descriptions (schema.ts, model/descriptions.ts),
 * the first of three releases. Every writer keeps exactly one row per live
 * task equal to issues.description. Each case also checks a write that
 * must leave the rows as they were. scripts/check-task-writes.test.mjs
 * covers the check that no other code writes them. */

import { describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
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

describe('Deleted items', () => {
  it('stores the text of the row, drops the row, and a restore writes it back', async () => {
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

  it("takes a project's tasks with their rows and brings them back, and a purge leaves none", async () => {
    const t = newT()
    const f = await withOrg(t)
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Kept',
    })
    for (const description of ['One', 'Two', 'Three'])
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, description })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    // the other project's task keeps its row
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    expect((await rowsOf(t, kept.id))[0].description).toBe('Kept')

    const item = await itemFor(t, f.sub2.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] })
    await runSteps(t)
    expect(await expectDescriptions(t, f.org.id)).toBe(4)

    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const again = await itemFor(t, f.sub2.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [again.id] })
    await runSteps(t)
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    await assertNoDanglingRefs(t, 'after a purge')
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
