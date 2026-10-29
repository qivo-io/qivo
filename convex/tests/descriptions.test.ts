/* Task descriptions in issue_descriptions (schema.ts, model/descriptions.ts),
 * the third of three releases. Every writer keeps exactly one row per live
 * task, with copies of the task's project and archived state that every
 * move and archive keeps, and writes the text to the row alone: a task row
 * keeps the copy of its text an earlier release wrote only until a
 * description write or internal/descriptionsBackfill's clear unsets it.
 * The backfill gives older tasks their rows, reports what differs, mends
 * it and clears the copies. Each case also checks a write that must leave
 * the rows as they were. scripts/check-task-writes.test.mjs covers the
 * check that no other code writes them. */

import type { WithoutSystemFields } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { PAGE, RUN } from '../internal/descriptionsBackfill'
import { newWindowKey } from '../lib/db'
import { LIMITS } from '../lib/limits'
import { deleteOrgDeep } from '../model/cascade'
import { clearOrgTrash, startPurge, TRASH_BUDGET } from '../model/deletedItems'
import { descriptionOf, insertTask, putDescription } from '../model/descriptions'
import { archiveIssueCore, MOVE_TOO_LARGE, moveIssueCore, SUBTREE_TOO_LARGE } from '../model/issues'
import { wipeWorkStep } from '../model/orgDeletion'
import {
  activityFor,
  as,
  copyTaskTexts,
  expectDescriptions,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantCopiedIssue,
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
  forgetUsedId,
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

/** The copy of its text that task `id`'s row in issues still holds, which
 * only an earlier release writes, or undefined. */
const copyOf = async (t: T, id: string) => (await taskRow(t, id))?.description

/** Expects the rows in issues of tasks `ids` to hold no copy of their text,
 * as every writer of this release leaves them. */
async function expectNoCopy(t: T, ids: readonly string[]) {
  for (const id of ids) expect(await copyOf(t, id), id).toBeUndefined()
}

describe('the writers keep one equal row per task', () => {
  it('creates through the app, REST and MCP, and a refused create adds none', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const app = await create(t, f, { description: '\n\nFrom the app  \n' })
    const blank = await create(t, f) // no description: ''
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
    expect((await rowsOf(t, blank.id))[0].description).toBe('')
    // the text is in the row alone
    await expectNoCopy(t, [app.id, blank.id, rest.id, mcp.id])

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
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Planted',
    })
    // the task row holds the copy an earlier release wrote
    const recopy = () => copyTaskTexts(t, f.org.id, [task.id])
    await recopy()
    const [before] = await rowsOf(t, task.id)
    await edit(t, f, task.id, { title: 'Only the title' })
    // an edit of other fields writes neither the row nor the copy
    expect(await rowsOf(t, task.id)).toEqual([before])
    expect(await copyOf(t, task.id)).toBe('Planted')

    // each description save unsets the copy and writes the row
    await edit(t, f, task.id, { description: 'From the app' })
    await expectNoCopy(t, [task.id])
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    expect((await rowsOf(t, task.id))[0].description).toBe('From the app')
    await recopy()
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      ref: task.id,
      body: JSON.stringify({ description: 'From REST' }),
    })
    expect((await rowsOf(t, task.id))[0].description).toBe('From REST')
    await expectNoCopy(t, [task.id])
    await recopy()
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: task.id,
      description: 'From MCP',
    })
    expect((await rowsOf(t, task.id))[0].description).toBe('From MCP')
    await expectNoCopy(t, [task.id])
    await recopy()
    await edit(t, f, task.id, { description: null })
    expect(await rowsOf(t, task.id)).toMatchObject([{ _id: before._id, description: '' }])
    await expectNoCopy(t, [task.id])
    await expectDescriptions(t, f.org.id)

    // a refused save leaves the row and the copy as they were
    await t.run((ctx) => ctx.db.patch(task._id, { description: '' }))
    await expectRefusal(
      edit(t, f, task.id, { description: 'x'.repeat(LIMITS.description.max + 1) }),
      'rule',
    )
    expect((await rowsOf(t, task.id))[0].description).toBe('')
    expect(await copyOf(t, task.id)).toBe('')
    await expectDescriptions(t, f.org.id)
  })

  it('gives a task stored before the table its row on its first description save', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = await plantOldTask(t, f, 'Old text')
    await edit(t, f, old, { title: 'Renamed' })
    expect(await rowsOf(t, old)).toEqual([])
    expect(await copyOf(t, old)).toBe('Old text')
    await edit(t, f, old, { description: 'New text' })
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    expect((await rowsOf(t, old))[0].description).toBe('New text')
    await expectNoCopy(t, [old])
  })

  it('settles description images and the row in one save', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await copyTaskTexts(t, f.org.id)
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
    await expectNoCopy(t, [task.id])
    await copyTaskTexts(t, f.org.id)
    await edit(t, f, task.id, { description: 'Wiring' })
    expect((await attachment())?.dropped_at).toBeDefined()
    // the save that settled the image unset the copy too
    await expectNoCopy(t, [task.id])
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    // an image of another task is refused, and neither copy changes
    await expectRefusal(edit(t, f, task.id, { description: `![x](att:${uuid()})` }), 'rule')
    expect((await rowsOf(t, task.id))[0].description).toBe('Wiring')
  })

  it('the over-cap fix trims the row and unsets the copy, and its dry run neither', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: '\nUntrimmed  ',
    })
    await copyTaskTexts(t, f.org.id)
    await t.action(internal.internal.overCapRows.fix, { dry_run: true })
    expect((await rowsOf(t, task.id))[0].description).toBe('\nUntrimmed  ')
    expect(await copyOf(t, task.id)).toBe('\nUntrimmed  ')
    await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    expect((await rowsOf(t, task.id))[0].description).toBe('Untrimmed')
    await expectNoCopy(t, [task.id])
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
  })

  it("the over-cap fix's pages read each task's description row, within Convex's limits", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 20 rows near Convex's 1 MiB document limit beside task rows without
    // text, as the third release leaves them, planted first, then 80
    // untrimmed descriptions of 20,000 three-byte characters in both
    // copies, about 4.6 MiB a copy. A page of the first tasks by their own
    // bytes, which are small, that read each one's row would pass 16 MiB.
    const text = '中'.repeat(LIMITS.description.max)
    const task = (i: number, description?: string) => ({
      id: uuid(),
      org_id: f.org.id,
      project_id: f.sub.id,
      num: 5000 + i,
      title: 'Untrimmed',
      ...(description === undefined ? {} : { description }),
      status: 'todo' as const,
      priority: 'low' as const,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      window_key: newWindowKey(),
    })
    const large = '0123456789'.repeat(100_000)
    for (let from = 0; from < 20; from += 5)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 5; i++) {
          const doc = task(i)
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            org_id: f.org.id,
            project_id: f.sub.id,
            description: large,
          })
        }
      })
    const trimmed: string[] = []
    for (let from = 20; from < 100; from += 10)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 10; i++) {
          const doc = task(i, `${text}  `)
          await insertTask(ctx.db, doc, 'restore')
          trimmed.push(doc.id)
        }
      })
    // with the copy an earlier release wrote, as every deployment holds
    // them until the backfill's clear
    await copyTaskTexts(t, f.org.id, trimmed)
    const { counts } = await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    expect(counts['issues.description fixed']).toBe(80)
    // a trim leaves those over TEXT_MAX, for a person to shorten
    expect(counts['issues.description reported']).toBe(20)
    for (const id of trimmed)
      expect((await rowsOf(t, id)).map((row) => row.description)).toEqual([text])
    await expectNoCopy(t, trimmed)
  }, 180_000)
})

/** Records each task event of task `taskId` for a webhook of the admin, who
 * reads every project, and answers the changed fields of the events written
 * after `count` of them, and how many there are. */
async function watchEvents(t: T, f: OrgFixture, taskId: string) {
  const owner = await t.run(async (ctx) => {
    const id = uuid()
    const credential_row_id = await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: f.admin.id,
      name: 'Events',
      token_prefix: 'qvt_test',
      token_hash: 'test',
      access: 'read',
      created_at: NOW,
    })
    return {
      profile_id: f.admin.id,
      credential_table: 'mcp_tokens' as const,
      credential_id: id,
      credential_row_id,
    }
  })
  await t.mutation(internal.webhooks.save, {
    owner,
    id: uuid(),
    name: 'task.updated',
    filters: { task_id: taskId },
    url: 'https://receiver.example/events',
    encrypted_secret: 'encrypted-test-key',
    expires_at: Date.now() + 600_000,
  })
  const events = () => t.run((ctx) => ctx.db.query('webhook_events').collect())
  return {
    count: async () => (await events()).length,
    after: async (count: number) =>
      (await events())
        .slice(count)
        .map(
          (row) =>
            (JSON.parse(row.payload) as { data: { changed_fields: string[] } }).data.changed_fields,
        ),
  }
}

describe('a task row that still holds a copy of its text', () => {
  it('keeps it through every write that leaves the text alone, which narrates, prints and sends nothing about it', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const text = `Wiring @[admin](user:${f.admin.id})`
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.guest.id,
      description: text,
    })
    await copyTaskTexts(t, f.org.id)
    const events = await watchEvents(t, f, task.id)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const writes: [string, () => Promise<unknown>][] = [
      ['title', () => edit(t, f, task.id, { title: 'Renamed' })],
      [
        'roadmap dates',
        () =>
          as(t, f.admin).mutation(api.roadmap.change, {
            session_id: uuid(),
            operations: [
              {
                kind: 'task',
                id: task.id,
                patch: { start_week: '2026-09-21', end_week: '2026-09-28' },
              },
            ],
          }),
      ],
      [
        'bulk reassign',
        () =>
          as(t, f.admin).mutation(api.projects.removeAccess, {
            org_id: f.org.id,
            id: f.meta.id,
            user_id: f.guest.id,
            on_held_tasks: { reassign_to: null },
          }),
      ],
      [
        'move',
        () =>
          as(t, f.admin).mutation(api.issues.move, {
            org_id: f.org.id,
            id: task.id,
            project_id: f.sub2.id,
          }),
      ],
      [
        'archive',
        () => as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: task.id }),
      ],
      [
        'restore',
        () => as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: task.id }),
      ],
      [
        'nightly archive',
        async () => {
          const done_at = new Date(Date.now() - 60 * 86_400_000).toISOString()
          await t.run((ctx) => ctx.db.patch(task._id, { status: 'done', done_at }))
          await t.mutation(internal.jobs.archiveDoneIssues, {})
          await runSteps(t)
        },
      ],
    ]
    // the task events the writes sent, counted before the nightly archive's
    // steps deliver and delete them
    let sent = 0
    for (const [name, write] of writes) {
      const activity = (await activityFor(t, f.org.id)).length
      const count = await events.count()
      await write()
      expect(await copyOf(t, task.id), name).toBe(text)
      const rows = (await activityFor(t, f.org.id)).slice(activity)
      for (const row of rows) {
        expect(row.verb, name).not.toMatch(/description/)
        expect(row.detail ?? '', name).not.toMatch(/description/i)
        expect(row.field_prints ?? {}, name).not.toHaveProperty('description')
      }
      for (const fields of await events.after(count)) {
        expect(fields, name).not.toContain('description')
        sent += 1
      }
    }
    // the writes narrated and sent, so the checks above saw what they wrote
    expect((await activityFor(t, f.org.id)).length).toBeGreaterThan(4)
    expect(sent).toBeGreaterThan(4)
    // no mention was diffed, so the admin the text names heard nothing new
    expect((await messagesFor(t, f.admin.id, task.id)).map((m) => m.kind)).not.toContain('mention')
    expect(await rowOf(t, task.id)).toMatchObject({
      description: text,
      project_id: f.sub2.id,
      archived_at: expect.any(String),
    })
    await expectDescriptions(t, f.org.id)
  })

  it("a move, an archive and the nightly archive keep the row's text when the copy differs", async () => {
    const t = newT()
    const f = await withOrg(t)
    const done_at = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const base = { org_id: f.org.id, project_id: f.sub.id, description: 'Row text' }
    const moved = await plantIssue(t, base)
    const archived = await plantIssue(t, base)
    const nightly = await plantIssue(t, { ...base, status: 'done', done_at })
    // copies that differ from the rows, as only a rollback leaves them
    await t.run(async (ctx) => {
      for (const task of [moved, archived, nightly])
        await ctx.db.patch(task._id, { description: 'Copy text' })
    })
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: moved.id,
      project_id: f.sub2.id,
    })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: archived.id })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)
    expect(await rowOf(t, moved.id)).toMatchObject({
      description: 'Row text',
      project_id: f.sub2.id,
    })
    for (const task of [archived, nightly])
      expect(await rowOf(t, task.id)).toMatchObject({
        description: 'Row text',
        archived_at: expect.any(String),
      })
    // the copies stay for the backfill, which reports them as differing
    for (const task of [moved, archived, nightly])
      expect(await copyOf(t, task.id)).toBe('Copy text')
    expect(await backfill(t, { dry_run: true })).toMatchObject({ differ: 3, held: 0 })
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
    // the root holds the copy an earlier release wrote, and the child, as
    // this release writes it, the text only in the row
    await copyTaskTexts(t, f.org.id, [root.id])
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
    // a restore writes the stored text to the row alone
    expect((await rowsOf(t, root.id))[0].description).toBe('Root')
    expect((await rowsOf(t, child.id))[0].description).toBe('Child')
    expect((await rowsOf(t, old))[0].description).toBe('Before the table')
    await expectNoCopy(t, [root.id, child.id, old])
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
    await copyTaskTexts(t, f.org.id)
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
    await expectNoCopy(t, [task.id, inProject.id])
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
    // the first has the text only in the row, as this release writes it,
    // and the others hold the copy an earlier release wrote
    await copyTaskTexts(t, f.org.id, ids.slice(1))
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
    expect((await rowsOf(t, ids[2]))[0].description).toBe('Three')
    await expectNoCopy(t, ids)

    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const again = await itemFor(t, f.sub2.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [again.id] })
    await runSteps(t)
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
    await assertNoDanglingRefs(t, 'after a purge')
  })

  it('charges a move for both rows it reads of a task without a copy whose first row is stale', async () => {
    const t = newT()
    const f = await withOrg(t)
    const filler = 'x'.repeat(300_000)
    // the person's delete moves the first task of the project itself, then
    // two tasks each with two rows of about 300 KB as its bytes allow
    const lead = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const first = await twoRows(t, f, f.sub2.id, `Old ${filler}`, `Current ${filler}`)
    const second = await twoRows(t, f, f.sub2.id, `Old ${filler}`, `Current ${filler}`)
    // the call spends a quarter of this, about 2.8 MB, which holds both
    // tasks with one row read each, not the first with both of its rows read
    TRASH_BUDGET.bytes = 11_200_000
    await deleteProject(t, f, f.sub2.id)
    expect(await liveTask(t, lead.id)).toBeNull()
    expect(await liveTask(t, first.id)).toBeNull()
    expect(await liveTask(t, second.id)).not.toBeNull()
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    for (const task of [first, second])
      expect((await storedIssue(t, task.id))?.description).toBe(`Current ${filler}`)
  })
})

/** A task in project `projectId` with no copy of its text, whose first
 * description row has a stale archived copy and the text `old`, and whose
 * second holds its copies and `current`, which readers show, as repeated
 * rollbacks can leave it. */
async function twoRows(t: T, f: OrgFixture, projectId: string, old: string, current: string) {
  const task = await plantIssue(t, { org_id: f.org.id, project_id: projectId, description: old })
  await t.run(async (ctx) => {
    const [row] = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .collect()
    await ctx.db.patch(row._id, { archived_at: NOW })
    await ctx.db.insert('issue_descriptions', {
      issue_id: task.id,
      org_id: f.org.id,
      project_id: projectId,
      description: current,
    })
  })
  return task
}

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
 * organization, and answers that organization's id. The id is one from
 * before used_ids, which a create refuses otherwise (forgetUsedId). */
async function createWithId(t: T, f: OrgFixture, id: string, where: 'same' | 'other') {
  await forgetUsedId(t, id)
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
      expect(await liveTask(t, sub.id)).toMatchObject({ org_id: orgId })
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
    // the id, one from before used_ids, is free, and the other
    // organization's create takes it
    await forgetUsedId(t, first.id)
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
    // its texts are in the rows alone
    const tasks = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .collect(),
    )
    await expectNoCopy(
      t,
      tasks.map((task) => task.id),
    )
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

let longNum = 70_000

/** `count` tasks with descriptions of `text`, by default
 * LIMITS.description.max three-byte characters, in their rows, ten a
 * transaction. `copied` gives their task rows the copy too, as every
 * deployment holds them until the backfill's clear. */
async function plantLong(
  t: T,
  count: number,
  task: { org_id: string; project_id: string } & Partial<WithoutSystemFields<Doc<'issues'>>>,
  how: { text?: string; copied?: boolean } = {},
) {
  const text = how.text ?? '中'.repeat(LIMITS.description.max)
  const ids: string[] = []
  for (let from = 0; from < count; from += 10)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + 10); i++) {
        const id = uuid()
        const _id = await insertTask(
          ctx.db,
          {
            id,
            num: longNum++,
            title: 'Long',
            description: text,
            status: 'todo',
            priority: 'low',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...task,
          },
          'restore',
        )
        if (how.copied) await ctx.db.patch(_id, { description: text })
        ids.push(id)
      }
    })
  return ids
}

/** The admin's change of live task `id` in one transaction of its own, run
 * by `body`, and what it read and wrote, which the cases log. */
async function measured(
  t: T,
  body: (ctx: MutationCtx, issue: Doc<'issues'>) => Promise<unknown>,
  id: string,
) {
  return await t.run(async (ctx) => {
    const issue = await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (issue === null) throw new Error('no such task')
    await body(ctx, issue)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      bytesRead: m.bytesRead.used,
      documentsRead: m.documentsRead.used,
      databaseQueries: m.databaseQueries.used,
      bytesWritten: m.bytesWritten.used,
      documentsWritten: m.documentsWritten.used,
    }
  })
}

/** The arguments the app's move and archive give their cores for the
 * admin's change of `issue`. */
const core = (f: OrgFixture, issue: Doc<'issues'>) => ({ me: f.admin, issue, now: NOW })

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
    // and the same toggle with an edit, on the active task, writes the row
    // once, with the text and the new stamp
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: root.id,
      archived: true,
      description: 'Archived with a note',
    })
    const stamp = (await liveTask(t, root.id))?.archived_at
    expect(stamp).toBeDefined()
    expect(await rowOf(t, root.id)).toMatchObject({
      description: 'Archived with a note',
      archived_at: stamp,
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

  it('a second row of a task stops no move, archive, restore or nightly archive, and the repair deletes it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Twice',
      status: 'done',
      done_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    })
    // as no writer of this release leaves it
    await t.run((ctx) =>
      ctx.db.insert('issue_descriptions', {
        issue_id: task.id,
        org_id: f.org.id,
        description: 'Twice',
      }),
    )
    const first = async () => (await rowsOf(t, task.id))[0]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)
    expect(errors).not.toHaveBeenCalled()
    const archived = (await liveTask(t, task.id))?.archived_at
    expect(archived).toBeDefined()
    expect((await first()).archived_at).toBe(archived)
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: task.id })
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: task.id,
      project_id: f.sub2.id,
    })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: task.id })
    expect(await first()).toMatchObject({
      project_id: f.sub2.id,
      archived_at: (await liveTask(t, task.id))?.archived_at,
    })
    // the first row holds the copies, and the repair deletes the second
    expect(await backfill(t, { dry_run: true })).toMatchObject({ duplicates: 1, differ: 0 })
    await backfill(t, { dry_run: false, repair: true })
    expect(await expectDescriptions(t, f.org.id)).toBe(1)
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
    await plantLong(
      t,
      120,
      { org_id: f.org.id, project_id: f.sub.id, status: 'done', done_at },
      { copied: true },
    )
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

  it('with both copies, a subtree archive or move of the largest descriptions finishes, or refuses and changes nothing', async () => {
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
    // the task rows hold the text too, as until the backfill's clear and
    // again after a rollback to the second release
    await plantLong(t, 30, { ...base, parent_id: small.id }, { copied: true })
    await plantLong(t, LIMITS.subtasks.max, { ...base, parent_id: large.id }, { copied: true })
    const before = await snapshot(t)
    // each subtask reads its task row and its row twice, so the room check
    // refuses the largest subtree before a Convex limit could stop it
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
    expect(await snapshot(t)).toEqual(before)
    // a smaller one moves and archives, with its rows
    console.info(
      'with both copies, 30 subtasks at the three-byte cap move',
      await measured(
        t,
        (ctx, issue) => moveIssueCore(ctx, { ...core(f, issue), project_id: away.id }),
        small.id,
      ),
    )
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

  it('with cleared task rows, 100 active subtasks at the three-byte cap move through the app and REST, and archive', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    const away = await awayProject(t, f)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const family = await plantIssue(t, base)
    const archived = await plantIssue(t, base)
    const kids = await plantLong(t, LIMITS.subtasks.max, { ...base, parent_id: family.id })
    await plantLong(t, LIMITS.subtasks.max, { ...base, parent_id: archived.id })
    const move = await measured(
      t,
      (ctx, issue) => moveIssueCore(ctx, { ...core(f, issue), project_id: away.id }),
      family.id,
    )
    console.info('cleared, 100 active subtasks at the three-byte cap move', move)
    for (const id of kids) expect((await rowOf(t, id)).project_id).toBe(away.id)
    // REST moves them back, and its answer reads them again
    const answer = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      ref: family.id,
      body: JSON.stringify({ project: f.sub.id }),
    })
    expect(answer).toMatchObject({ project_id: f.sub.id })
    for (const id of kids) expect((await rowOf(t, id)).project_id).toBe(f.sub.id)
    const archive = await measured(
      t,
      (ctx, issue) => archiveIssueCore(ctx, core(f, issue)),
      archived.id,
    )
    console.info('cleared, 100 active subtasks at the three-byte cap archive', archive)
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: family.id })
    for (const id of kids) expect((await rowOf(t, id)).archived_at).toBeDefined()
    expect(await expectDescriptions(t, f.org.id)).toBe(2 + 2 * LIMITS.subtasks.max)
  }, 300_000)

  it(`with cleared task rows, ${LIMITS.moveSubtree.max} subtasks at the cap move in ASCII and are refused in a three-byte script, changing nothing`, async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const away = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const half = LIMITS.moveSubtree.max / 2
    const ascii = await plantIssue(t, base)
    const text = 'a'.repeat(LIMITS.description.max)
    await plantLong(t, half, { ...base, parent_id: ascii.id }, { text })
    await plantLong(t, half, { ...base, parent_id: ascii.id, archived_at: NOW }, { text })
    const wide = await plantIssue(t, base)
    await plantLong(t, half, { ...base, parent_id: wide.id })
    await plantLong(t, half, { ...base, parent_id: wide.id, archived_at: NOW })
    const fits = await measured(
      t,
      (ctx, issue) => moveIssueCore(ctx, { ...core(f, issue), project_id: away.id }),
      ascii.id,
    )
    console.info(`cleared, ${LIMITS.moveSubtree.max} ASCII subtasks at the cap move`, fits)
    const before = await snapshot(t)
    const refused = await expectRefusal(
      as(t, f.admin).mutation(api.issues.move, {
        org_id: f.org.id,
        id: wide.id,
        project_id: away.id,
      }),
      'rule',
    )
    expect(refused.data.message).toBe(MOVE_TOO_LARGE)
    expect(await snapshot(t)).toEqual(before)
  }, 300_000)

  it('a REST or MCP move folded with an archive archives the light subtasks after a heavy carry', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    const away = await awayProject(t, f)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    // the move carries 110 archived subtasks at the three-byte cap, most of
    // the room, and the archive then stamps two short active ones, whose
    // rows are small
    const family = async () => {
      const root = await plantIssue(t, base)
      await plantLong(t, 110, { ...base, parent_id: root.id, archived_at: NOW })
      const kids = [
        await plantIssue(t, { ...base, parent_id: root.id, description: 'Short' }),
        await plantIssue(t, { ...base, parent_id: root.id, description: 'Short too' }),
      ]
      return { root, kids }
    }
    const rest = await family()
    const answer = await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'descriptions',
      ref: rest.root.id,
      body: JSON.stringify({ project: away.id, archived: true }),
    })
    expect(answer).toMatchObject({ project_id: away.id, archived: true })
    const mcp = await family()
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: mcp.root.id,
      project: f.hidden.id,
      sub_project: away.id,
      archived: true,
    })
    for (const { root, kids } of [rest, mcp])
      for (const task of [root, ...kids])
        expect(await rowOf(t, task.id)).toMatchObject({
          project_id: away.id,
          archived_at: expect.any(String),
        })
  }, 300_000)

  for (const copied of [true, false])
    it(`refuses a subtree of descriptions stored before the caps before one patch could pass the read limit, ${copied ? 'with both copies' : 'with cleared task rows'}`, async () => {
      const t = newT({ transactionLimits: true })
      const f = await withOrg(t)
      const away = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.hidden.id,
      })
      const base = { org_id: f.org.id, project_id: f.sub.id }
      // descriptions of about 1 MiB from before the caps. With both copies
      // each subtask's task row is that large too, so five read about 5 MiB
      // in the walk, and each patch about 2 MiB more, its task again and its
      // row. With the task rows cleared each subtask costs its row twice,
      // about 2 MiB, so ten pass 16 MiB; one of them has a second such row,
      // as a rollback can leave.
      const legacy = 'x'.repeat(1_040_000)
      const plant = copied ? plantCopiedIssue : plantIssue
      const root = await plantIssue(t, base)
      const kids: Doc<'issues'>[] = []
      for (let i = 0; i < (copied ? 5 : 10); i++)
        kids.push(await plant(t, { ...base, parent_id: root.id, description: legacy }))
      await t.run((ctx) =>
        ctx.db.insert('issue_descriptions', {
          issue_id: kids[0].id,
          org_id: f.org.id,
          project_id: f.sub.id,
          description: legacy,
        }),
      )
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
      const ids: string[] = []
      for (let i = 0; i < 2; i++)
        ids.push((await plant(t, { ...base, parent_id: small.id, description: legacy })).id)
      console.info(
        `two subtasks of 1 MiB archive, ${copied ? 'with both copies' : 'cleared'}`,
        await measured(t, (ctx, issue) => archiveIssueCore(ctx, core(f, issue)), small.id),
      )
      for (const id of ids) expect((await rowOf(t, id)).archived_at).toBeDefined()
    }, 120_000)
})

/* ------------------------------------------------------------- backfill */

type RunArgs = {
  dry_run: boolean
  repair?: boolean
  clear?: boolean
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

/** A task of each kind the backfill finds, in creation order, and rows that
 * wait for a step or a teardown. */
async function plantKinds(t: T, f: OrgFixture) {
  const copied = async (description: string) =>
    (await plantCopiedIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })).id
  const task = async (description: string) =>
    (await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })).id
  // the copy an earlier release wrote, equal to the row: a clear unsets it
  const held = await copied('Held')
  const missing = await plantOldTask(t, f, 'Missing')
  const differs = await copied('Truth')
  const otherOrg = await copied('Mine')
  const doubled = await copied('Twice')
  // a duplicate whose first row is the stale one
  const staleFirst = await copied('Truth')
  // this release's state, with no copy and the text in the row
  const skipped = await task('Kept')
  // a task without a copy whose row is gone, and one with a second row
  const blank = await task('Gone')
  const skippedTwice = await task('Kept twice')
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
    await ctx.db.delete((await rowOf(blank))._id)
    await ctx.db.insert('issue_descriptions', {
      issue_id: skippedTwice,
      org_id: f.org.id,
      description: 'A second row',
    })
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
    held,
    missing,
    differs,
    otherOrg,
    doubled,
    staleFirst,
    skipped,
    blank,
    skippedTwice,
    moving,
    orphan,
    tornDown,
  }
}

/** What plantKinds plants, as a dry run reports it. */
const KINDS_FOUND = (k: Awaited<ReturnType<typeof plantKinds>>) => ({
  tasks: 9,
  missing: 2,
  differ: 3,
  duplicates: 3,
  orphans: 1,
  waiting: 2,
  skipped: 2,
  held: 1,
  cleared: 0,
  ids: {
    missing: [k.missing, k.blank],
    differ: [k.differs, k.otherOrg, k.staleFirst],
    duplicates: [k.doubled, k.staleFirst, k.skippedTwice],
    orphans: [k.orphan],
    waiting: [k.moving, k.tornDown],
    skipped: [k.skipped, k.skippedTwice],
    held: [k.held],
    cleared: [],
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
    // a task without a copy or a row gets what readers showed for it, with
    // its copies
    expect(await rowOf(t, k.blank)).toMatchObject({ description: '', project_id: f.sub.id })
    // without repair the rest stays, for a person to read first
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      missing: 0,
      differ: 3,
      duplicates: 3,
      orphans: 1,
    })
    expect((await audits(t)).map((row) => row.detail)).toEqual([
      { repair: false, clear: false, ...counts, done: true, cursor: null },
    ])

    await backfill(t, { dry_run: false, repair: true })
    expect(await rowsOf(t, k.differs)).toMatchObject([{ description: 'Truth' }])
    expect(await rowsOf(t, k.otherOrg)).toMatchObject([{ org_id: f.org.id, description: 'Mine' }])
    expect(await rowsOf(t, k.doubled)).toMatchObject([{ description: 'Twice' }])
    expect(await rowsOf(t, k.staleFirst)).toMatchObject([{ description: 'Truth' }])
    // the first row of a task without a copy holds its copies, so it keeps
    // its text and the second goes
    expect(await rowsOf(t, k.skippedTwice)).toMatchObject([{ description: 'Kept twice' }])
    expect(await rowsOf(t, k.orphan)).toEqual([])
    // its step and the organization's deletion take these
    expect(await rowsOf(t, k.moving)).toHaveLength(1)
    expect(await rowsOf(t, k.tornDown)).toHaveLength(1)
    // a task without issues.description keeps its row as it is
    expect(await rowsOf(t, k.skipped)).toMatchObject([{ description: 'Kept' }])
    expect((await taskRow(t, k.skipped))?.description).toBeUndefined()
    // no repair unsets a copy; the clear does that
    for (const id of [k.held, k.missing, k.differs, k.otherOrg, k.doubled, k.staleFirst])
      expect(await copyOf(t, id), id).toBeDefined()
    const left = {
      missing: 0,
      differ: 0,
      duplicates: 0,
      orphans: 0,
      waiting: 2,
      skipped: 3,
      held: 6,
      cleared: 0,
    }
    expect(await backfill(t, { dry_run: true })).toMatchObject({ tasks: 9, ...left })

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
    // this release's state, whose row keeps the text
    const skipped = await task()
    // the others hold the copy an earlier release wrote
    await copyTaskTexts(t, f.org.id, [fine, unstamped, archived, moved])
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
      await ctx.db.patch((await taskOf(skipped))._id, { archived_at: NOW })
      await ctx.db.patch((await rowOf(skipped))._id, { description: 'Kept' })
    })
    const before = await snapshot(t)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      tasks: 5,
      missing: 0,
      differ: 4,
      skipped: 1,
      held: 1,
      ids: { differ: [unstamped, archived, moved, skipped], skipped: [skipped], held: [fine] },
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
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      differ: 0,
      skipped: 1,
      held: 4,
    })
  })

  it('counts a second row of a task without a copy, and its repair keeps the text readers showed', async () => {
    const t = newT()
    const f = await withOrg(t)
    const plant = async (description: string) =>
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })
    // the first row's archived copy is stale and the second holds the
    // copies, so readers show the second row's text
    const staleFirst = await plant('Old text')
    // the first row holds the copies, so readers show its text
    const freshFirst = await plant('Shown text')
    await t.run(async (ctx) => {
      const [row] = await ctx.db
        .query('issue_descriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', staleFirst.id))
        .collect()
      await ctx.db.patch(row._id, { archived_at: NOW })
      for (const [task, description] of [
        [staleFirst, 'Current text'],
        [freshFirst, 'Hidden text'],
      ] as const)
        await ctx.db.insert('issue_descriptions', {
          issue_id: task.id,
          org_id: f.org.id,
          project_id: task.project_id,
          description,
        })
    })
    const shown = (id: string) =>
      t.run(async (ctx) => {
        const task = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique()
        return task === null ? null : await descriptionOf(ctx.db, task)
      })
    expect([await shown(staleFirst.id), await shown(freshFirst.id)]).toEqual([
      'Current text',
      'Shown text',
    ])
    const before = await snapshot(t)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      tasks: 2,
      skipped: 2,
      duplicates: 2,
      differ: 1,
      held: 0,
      ids: { duplicates: [staleFirst.id, freshFirst.id], differ: [staleFirst.id] },
    })
    // a clear leaves both alone, and a run without repair too
    expect(await backfill(t, { dry_run: false, clear: true })).toMatchObject({
      duplicates: 2,
      cleared: 0,
    })
    expect(await snapshot(t)).toEqual(before)

    await backfill(t, { dry_run: false, repair: true })
    expect(await rowsOf(t, staleFirst.id)).toMatchObject([
      { description: 'Current text', project_id: f.sub.id },
    ])
    expect(await rowOf(t, staleFirst.id)).not.toHaveProperty('archived_at')
    expect(await rowsOf(t, freshFirst.id)).toMatchObject([{ description: 'Shown text' }])
    expect([await shown(staleFirst.id), await shown(freshFirst.id)]).toEqual([
      'Current text',
      'Shown text',
    ])
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      skipped: 2,
      duplicates: 0,
      differ: 0,
    })
    expect(await expectDescriptions(t, f.org.id)).toBe(2)
  })

  it('a clear unsets exactly the held copies, no task of another kind, with its audit row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const k = await plantKinds(t, f)
    const before = await snapshot(t)
    const result = await backfill(t, { dry_run: false, clear: true })
    // a clear inserts missing rows too, as every run does, and unsets the
    // held task's copy, counted as cleared
    expect(result).toMatchObject({
      ...KINDS_FOUND(k),
      held: 0,
      cleared: 1,
      ids: { ...KINDS_FOUND(k).ids, held: [], cleared: [k.held] },
      done: true,
    })
    expect(await copyOf(t, k.held)).toBeUndefined()
    expect((await rowsOf(t, k.held))[0].description).toBe('Held')
    // every other copy and every row it did not insert stay as they were
    const after = await snapshot(t)
    expect(after.tasks.filter((task) => task.id !== k.held)).toEqual(
      before.tasks.filter((task) => task.id !== k.held),
    )
    const { _id, _creationTime, ...unset } = before.tasks.find((task) => task.id === k.held)!
    expect(after.tasks.find((task) => task.id === k.held)).toEqual({
      _id,
      _creationTime,
      ...unset,
      description: undefined,
    })
    const inserted = new Set([k.missing, k.blank])
    expect(after.rows.filter((row) => !inserted.has(row.issue_id))).toEqual(before.rows)
    expect((await audits(t)).map((row) => row.detail)).toEqual([
      expect.objectContaining({ repair: false, clear: true, held: 0, cleared: 1, done: true }),
    ])
  })

  it('clears a clean deployment, writes no time, event or activity, and a second clear clears nothing', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const ids: string[] = []
    for (const description of ['One', 'Two', 'Three'])
      ids.push((await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description })).id)
    // an archived task in another project too
    ids.push(
      (
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: f.sub2.id,
          archived_at: NOW,
          description: 'Four',
        })
      ).id,
    )
    const created = (await create(t, f, { description: 'Written by this release' })).id
    await copyTaskTexts(t, f.org.id, ids)
    const activity = (await activityFor(t, f.org.id)).length
    const rowsBefore = (await snapshot(t)).rows
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      tasks: 5,
      held: 4,
      skipped: 1,
      missing: 0,
      differ: 0,
      duplicates: 0,
      orphans: 0,
      ids: { held: ids, skipped: [created] },
    })
    const tasksBefore = (await snapshot(t)).tasks
    expect(await backfill(t, { dry_run: false, clear: true })).toMatchObject({
      held: 0,
      cleared: 4,
      ids: { cleared: ids },
    })
    await expectNoCopy(t, [...ids, created])
    const settled = await snapshot(t)
    // only the copies went: no updated_at, no row, no activity
    expect(settled.rows).toEqual(rowsBefore)
    expect(settled.tasks.map(({ description: _d, ...task }) => task)).toEqual(
      tasksBefore.map(({ description: _d, ...task }) => task),
    )
    expect(await activityFor(t, f.org.id)).toHaveLength(activity)
    expect(await expectDescriptions(t, f.org.id)).toBe(5)
    expect(await backfill(t, { dry_run: true })).toMatchObject({ held: 0, skipped: 5 })
    expect(await backfill(t, { dry_run: false, clear: true })).toMatchObject({ cleared: 0 })
    expect(await snapshot(t)).toEqual(settled)
  })

  it('refuses a clear with repair or with a dry run before it reads', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantCopiedIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: 'Held' })
    const before = await snapshot(t)
    await expect(backfill(t, { dry_run: false, clear: true, repair: true })).rejects.toThrow(
      'a clear repairs nothing, so run the repair, read a dry run, then clear',
    )
    await expect(backfill(t, { dry_run: true, clear: true })).rejects.toThrow(
      'a dry run reports as held what a clear unsets, so it takes no clear',
    )
    expect(await snapshot(t)).toEqual(before)
    expect(await audits(t)).toEqual([])
  })

  it('counts every document a page reads, near-1 MiB rows, repair and clear pages included', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // four tasks whose texts are about 1 MiB in both copies; two rows are
    // stale and one task has a second row, so a repair page patches and
    // deletes them, and a fifth whose copy a clear page unsets
    const near = (c: string) => c.repeat(1_000_000)
    const ids: string[] = []
    for (const c of ['a', 'b', 'c', 'd', 'e'])
      ids.push(
        (
          await plantCopiedIssue(t, {
            org_id: f.org.id,
            project_id: f.sub.id,
            description: near(c),
          })
        ).id,
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
    type Mode = 'check' | 'repair' | 'clear'
    /** The pages of `phase` from the start, each with the bytes Convex
     * counted it reading. */
    const pages = async (phase: 'tasks' | 'rows', mode: Mode) => {
      const out: { tasks: number; bytes: number; read: number; cleared: number }[] = []
      for (let after = 0, done = false; !done; ) {
        const { result, read } = await t.run(async (ctx) => {
          const before = (await ctx.meta.getTransactionMetrics()).bytesRead.used
          const result =
            mode === 'check'
              ? await ctx.runQuery(checkRef, { phase, after })
              : await ctx.runMutation(pageRef, {
                  phase,
                  after,
                  repair: mode === 'repair',
                  clear: mode === 'clear',
                })
          const read = (await ctx.meta.getTransactionMetrics()).bytesRead.used - before
          return { result, read }
        })
        out.push({ tasks: result.tasks, bytes: result.bytes, read, cleared: result.cleared })
        after = result.after
        done = result.done
      }
      return out
    }
    // a page reads PAGE.bytes and its row documents' worth past them at most
    const extra = { check: 4, clear: 5, repair: 6 } as const
    for (const mode of ['check', 'clear', 'repair'] as const) {
      const tasks = await pages('tasks', mode)
      const rows = await pages('rows', mode)
      for (const page of [...tasks, ...rows]) {
        expect(page.bytes).toBe(page.read)
        expect(page.read).toBeLessThanOrEqual(PAGE.bytes + extra[mode] * 1024 * 1024)
      }
      expect(tasks.reduce((sum, page) => sum + page.tasks, 0)).toBe(5)
      // rows this large end a page after a few tasks
      expect(tasks.length).toBeGreaterThan(1)
      if (mode === 'clear') {
        console.info('clear pages near 1 MiB', tasks)
        expect(tasks.reduce((sum, page) => sum + page.cleared, 0)).toBe(2)
      }
    }
    // the clear unset the two copies its rows held, and the repair then
    // mended the rest from theirs
    await expectNoCopy(t, [ids[0], ids[4]])
    expect(await expectDescriptions(t)).toBe(5)
  }, 180_000)

  it('goes on from its cursor, a call at a time', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 6; i++) await plantOldTask(t, f, `Old ${i}`)
    Object.assign(PAGE, { rows: 2 })
    Object.assign(RUN, { ms: 0 })
    /** The counts of `kind` each call of `args` answered, a call at a time
     * from its cursor. */
    const calls = async (args: RunArgs, kind: 'missing' | 'cleared') => {
      const out: number[] = []
      let cursor: RunArgs['cursor']
      for (;;) {
        const result = await backfill(t, { ...args, cursor })
        out.push(result[kind])
        if (result.done) break
        cursor = result.cursor ?? undefined
        expect(out.length).toBeLessThan(10)
      }
      return out
    }
    const inserted = await calls({ dry_run: false }, 'missing')
    expect(inserted.reduce((sum, n) => sum + n, 0)).toBe(6)
    expect(inserted.length).toBeGreaterThan(2)
    expect(await expectDescriptions(t)).toBe(6)
    // a clear goes on inside the tasks phase the same way
    const cleared = await calls({ dry_run: false, clear: true }, 'cleared')
    expect(cleared.reduce((sum, n) => sum + n, 0)).toBe(6)
    expect(cleared.length).toBeGreaterThan(2)
    Object.assign(PAGE, DEFAULT_PAGE)
    expect(await backfill(t, { dry_run: true })).toMatchObject({ held: 0, skipped: 6 })
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

    // a clear page of 35 held tasks cannot write their 35 patches either
    Object.assign(PAGE, { rows: 35 })
    await expect(backfill(t, { dry_run: false, clear: true })).rejects.toThrow()
    const [, , clearing] = await audits(t)
    // the first page cleared the 20 copies after the 15 tasks without one
    expect(clearing.detail).toMatchObject({
      clear: true,
      tasks: 35,
      cleared: 20,
      skipped: 15,
      done: false,
    })
    const from = (clearing.detail as { cursor: RunArgs['cursor'] }).cursor
    expect(from?.phase).toBe('tasks')
    Object.assign(PAGE, { rows: 20 })
    expect(await backfill(t, { dry_run: false, clear: true, cursor: from })).toMatchObject({
      cleared: 35,
      done: true,
    })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ held: 0, skipped: 70 })
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
    // the edits unset their copies, and the new task never had one
    Object.assign(PAGE, DEFAULT_PAGE)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      missing: 0,
      differ: 0,
      duplicates: 0,
      orphans: 0,
      waiting: 0,
      skipped: 3,
      held: 1,
    })
  })

  it('stays exact while the writers change tasks between the pages of a clear', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ids: string[] = []
    for (let i = 0; i < 4; i++)
      ids.push((await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })).id)
    await copyTaskTexts(t, f.org.id)
    Object.assign(PAGE, { rows: 1 })
    Object.assign(RUN, { ms: 0 })
    const first = await backfill(t, { dry_run: false, clear: true })
    expect(first.cleared).toBe(1)
    // between pages: an edit that unsets a copy the clear has not reached, a
    // delete of another and a new task without one
    await edit(t, f, ids[1], { description: 'Edited before its page' })
    await deleteTask(t, f, ids[2])
    await runSteps(t)
    const created = (await create(t, f, { description: 'Created meanwhile' })).id
    let cleared = first.cleared
    let cursor = first.cursor ?? undefined
    for (let calls = 0; cursor !== undefined; calls++) {
      expect(calls).toBeLessThan(20)
      const result = await backfill(t, { dry_run: false, clear: true, cursor })
      cleared += result.cleared
      cursor = result.cursor ?? undefined
    }
    // only the last original task still held its copy when its page came
    expect(cleared).toBe(2)
    await expectNoCopy(t, [ids[0], ids[1], ids[3], created])
    expect((await rowsOf(t, ids[1]))[0].description).toBe('Edited before its page')
    Object.assign(PAGE, DEFAULT_PAGE)
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      tasks: 4,
      held: 0,
      skipped: 4,
      missing: 0,
      differ: 0,
      duplicates: 0,
    })
  })
})
