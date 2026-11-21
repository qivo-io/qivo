/* internal/unreadFieldsRemoval, which unsets the window keys earlier
 * releases wrote in the live rows and in the copies Deleted items keeps,
 * and organizations' last_export_at and upload tickets' up_to, and the
 * writers of this release, which give no row and no stored copy a key, so
 * a run that reports zeros stays at zeros. */

import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { PAGE, RUN } from '../internal/unreadFieldsRemoval'
import { byId } from '../lib/db'
import {
  activityFor,
  as,
  NOW,
  newT,
  plantIssue,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import {
  deleteProject,
  deleteTask,
  installTrashTimers,
  itemFor,
  plantRows,
  runSteps,
} from './trash.setup'
import { plantTicket } from './uploadTickets.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it (as snapshot.test.ts) */
declare class Blob {
  constructor(parts: string[])
}

installTrashTimers()
const DEFAULT_PAGE = { ...PAGE }
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(PAGE, DEFAULT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
})

/** The tables the removal walks whose copies Deleted items keeps, and all
 * the tables it walks. */
const STORED = [
  'issues',
  'projects',
  'issue_labels',
  'issue_attachments',
  'issue_links',
  'issue_subscriptions',
] as const
const TABLES = [...STORED, 'organizations', 'attachment_uploads'] as const
const each = (tables: readonly string[], n: number) =>
  Object.fromEntries(tables.map((table) => [table, n]))
const NONE = { live: each(TABLES, 0), stored: each(STORED, 0) }
const ONE_EACH = { live: each(TABLES, 1), stored: each(STORED, 1) }

type RunArgs = FunctionArgs<typeof internal.internal.unreadFieldsRemoval.run>
type RunResult = FunctionReturnType<typeof internal.internal.unreadFieldsRemoval.run>
type RunCursor = NonNullable<RunResult['cursor']>
const runOnce = (t: T, args: RunArgs): Promise<RunResult> =>
  t.action(internal.internal.unreadFieldsRemoval.run, args)

/** Calls run until it is done, and answers its summed counts and calls. */
async function runAll(t: T, dry_run: boolean) {
  const live: Record<string, number> = each(TABLES, 0)
  const stored: Record<string, number> = each(STORED, 0)
  let calls = 0
  let cursor: RunCursor | undefined
  for (;;) {
    const got = await runOnce(t, { dry_run, ...(cursor === undefined ? {} : { cursor }) })
    calls++
    expect(got.error).toBeUndefined()
    for (const table of TABLES) live[table] += got.live[table]
    for (const table of STORED) stored[table] += got.stored[table]
    if (got.done) return { live, stored, calls }
    if (got.cursor === null) throw new Error('a call that is not done answered no cursor')
    cursor = got.cursor
  }
}

/** The live relation rows of task `taskId`, the links from it only. */
async function relationRows(ctx: MutationCtx, taskId: string) {
  return [
    ...(await ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
      .collect()),
    ...(await ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
      .collect()),
    ...(await ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', taskId))
      .collect()),
    ...(await ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', taskId))
      .collect()),
  ]
}

/** Gives live task `taskId` the key `key`, and its relation rows the same,
 * as earlier releases wrote them. */
const keyLive = (t: T, taskId: string, key: string) =>
  t.run(async (ctx) => {
    const task = await byId(ctx, 'issues', taskId)
    if (task === null) throw new Error(`no task ${taskId}`)
    await ctx.db.patch(task._id, { window_key: key })
    for (const row of await relationRows(ctx, taskId))
      await ctx.db.patch(row._id, { task_key: key })
  })

/** Gives live project `id` the key `key`, as earlier releases wrote it. */
const keyProject = (t: T, id: string, key: string) =>
  t.run(async (ctx) => {
    const project = await byId(ctx, 'projects', id)
    if (project === null) throw new Error(`no project ${id}`)
    await ctx.db.patch(project._id, { window_key: key })
  })

/** The copies Deleted items keeps of task or project `id`, and of a task's
 * relation rows, the links from it only. */
const copiesOf = async (ctx: MutationCtx, id: string) =>
  (await ctx.db.query('deleted_rows').collect()).filter(({ row }) =>
    row.table === 'issues' || row.table === 'projects'
      ? row.doc.id === id
      : row.table === 'issue_links'
        ? row.doc.source_id === id
        : row.table === 'issue_labels' ||
            row.table === 'issue_attachments' ||
            row.table === 'issue_subscriptions'
          ? row.doc.issue_id === id
          : false,
  )

/** Gives the copies of `id` (copiesOf) the key `key`, as earlier releases
 * stored them. */
const keyStored = (t: T, id: string, key: string) =>
  t.run(async (ctx) => {
    for (const stored of await copiesOf(ctx, id)) {
      const { row } = stored
      const field = row.table === 'issues' || row.table === 'projects' ? 'window_key' : 'task_key'
      await ctx.db.patch(stored._id, {
        row: { table: row.table, doc: { ...row.doc, [field]: key } } as Doc<'deleted_rows'>['row'],
      })
    }
  })

/** Every row of the tables and of deleted_rows, ordered by creation. */
const everyRow = (t: T) =>
  t.run(async (ctx) => {
    const all: Record<string, unknown[]> = {}
    for (const table of [...TABLES, 'deleted_rows'] as const)
      all[table] = await ctx.db.query(table).collect()
    return all
  })

const UNREAD = ['window_key', 'task_key', 'last_export_at', 'up_to']
const without = <V>(value: V, fields: readonly string[] = UNREAD): V =>
  JSON.parse(JSON.stringify(value, (key, v) => (fields.includes(key) ? undefined : v)))

const keyed = (row: object) => 'window_key' in row || 'task_key' in row

/* The fields as earlier releases left them: live task `a` with its
 * relation rows in Firmware, whose project row holds a key too; the stored
 * copies of task `c`, deleted with its rows, and of project Board rev,
 * deleted; the organization's last_export_at and an upload ticket's up_to;
 * and tasks `b` and `b2` with rows, a link each to and from `a` and `c`,
 * Board rev's tasks and a second ticket, which hold none. One row or copy
 * of each table holds its field. */
async function plantKeys() {
  const t = newT()
  const f = await withReadingAdmin(t)
  const org_id = f.org.id
  const a = await plantIssue(t, { org_id, project_id: f.sub.id })
  const b = await plantIssue(t, { org_id, project_id: f.sub.id })
  const b2 = await plantIssue(t, { org_id, project_id: f.sub.id })
  const c = await plantIssue(t, { org_id, project_id: f.sub.id })
  const onBoard = await plantIssue(t, { org_id, project_id: f.sub2.id })
  await plantRows(t, f, a, { to: b, from: b2 })
  await plantRows(t, f, c, { to: b, from: b2 })
  await plantRows(t, f, onBoard, { to: b, from: b2 })
  await keyLive(t, a.id, 'aaaaaaaa')
  await keyProject(t, f.sub.id, 'bbbbbbbb')
  await deleteTask(t, f, c.id)
  await deleteProject(t, f, f.sub2.id)
  await runSteps(t)
  await keyStored(t, c.id, 'cccccccc')
  await keyStored(t, f.sub2.id, 'dddddddd')
  await t.run(async (ctx) => {
    const org = await byId(ctx, 'organizations', org_id)
    if (org !== null) await ctx.db.patch(org._id, { last_export_at: NOW })
  })
  for (const up_to of [true, undefined] as const) {
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['x']) as never))
    const ticket = await plantTicket(t, { profile: f.admin, issue: b, storageId })
    await t.run((ctx) => ctx.db.patch(ticket._id, { up_to }))
  }
  return { t, f, a, b, c }
}

describe('the unread fields removal', () => {
  it('counts the fields by table, live rows apart from stored copies, in the check and the dry run, and writes nothing', async () => {
    const { t } = await plantKeys()
    const before = await everyRow(t)
    const checked = { live: each(TABLES, 0), stored: each(STORED, 0) }
    for (const table of TABLES)
      for (const stored of (STORED as readonly string[]).includes(table)
        ? [false, true]
        : [false]) {
        let cursor: string | null = null
        for (;;) {
          const page: { rows: number; cursor: string; done: boolean } = await t.query(
            internal.internal.unreadFieldsRemoval.check,
            { table, stored, cursor },
          )
          checked[stored ? 'stored' : 'live'][table] += page.rows
          if (page.done) break
          cursor = page.cursor
        }
      }
    expect(checked).toEqual(ONE_EACH)
    const dry = await runAll(t, true)
    expect({ live: dry.live, stored: dry.stored }).toEqual(ONE_EACH)
    expect(await everyRow(t)).toEqual(before)
    expect(await t.run((ctx) => ctx.db.query('platform_audit_log').collect())).toEqual([])
  })

  it('unsets every field and nothing else, records the run, and a second run finds none', async () => {
    const { t, f, a } = await plantKeys()
    const reads = () =>
      Promise.all([
        as(t, f.user).query(api.taskWindow.task, { org_id: f.org.id, ref: a.id }),
        as(t, f.user).query(api.taskWindow.links, { org_id: f.org.id, issue_id: a.id }),
        as(t, f.user).query(api.projectNav.byIds, { ids: [f.sub.id] }),
        as(t, f.user).query(api.workspace.root, {}),
      ])
    const answered = await reads()
    const before = await everyRow(t)
    const activity = await activityFor(t, f.org.id)
    const quiet = () =>
      t.run(async (ctx) => ({
        messages: await ctx.db.query('messages').collect(),
      }))
    const was = await quiet()

    expect(JSON.stringify(answered)).not.toMatch(/window_key|task_key/)
    expect(JSON.stringify(answered)).toContain('last_export_at')

    const ran = await runOnce(t, { dry_run: false })
    expect(ran).toEqual({ dry_run: false, ...ONE_EACH, done: true, cursor: null })
    // the root part answers the organization's last_export_at until the run
    // unsets it
    expect(await reads()).toEqual(without(answered, ['last_export_at']))
    // each row as it was, updated_at included, without its field
    expect(await everyRow(t)).toEqual(without(before))
    expect(without(before)).not.toEqual(before)
    expect(await activityFor(t, f.org.id)).toEqual(activity)
    expect(await quiet()).toEqual(was)
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit.map((row) => [row.action, row.actor_email, row.detail])).toEqual([
      ['unread_fields_removal', 'system', { ...ONE_EACH, done: true, cursor: null }],
    ])

    const dry = await runAll(t, true)
    expect({ live: dry.live, stored: dry.stored }).toEqual(NONE)
    expect(await runOnce(t, { dry_run: false })).toMatchObject({ ...NONE, done: true })
    expect(await everyRow(t)).toEqual(without(before))
  })

  it("leaves a task's window key out of a write's answer and the Archived tasks page before the run", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const live = await plantIssue(t, { org_id, project_id: f.sub.id, window_key: 'aaaaaaaa' })
    const archived = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      window_key: 'bbbbbbbb',
      archived_at: NOW,
    })
    const updated = await as(t, f.user).mutation(api.issues.update, {
      org_id,
      id: live.id,
      patch: { title: 'Renamed' },
    })
    expect(updated).toMatchObject({ id: live.id, title: 'Renamed' })
    expect(updated).not.toHaveProperty('window_key')
    const page = await as(t, f.user).query(api.issues.archivedPage, {
      scope: { org_id, project_ids: [f.sub.id] },
    })
    expect(page.rows.map((row) => row.id)).toEqual([archived.id])
    expect(page.rows[0]).not.toHaveProperty('window_key')
  })

  it('ends a call whose page throws with the counts of the pages before it, the cursor of that page, its error and its audit row', async () => {
    const t = newT()
    for (const window_key of ['aaaaaaaa', 'bbbbbbbb'])
      await plantIssue(t, { org_id: uuid(), project_id: uuid(), window_key })
    // the first page reads one row and every later page throws, until
    // PAGE.rows is set again, as afterEach does
    let pages = 0
    Object.defineProperty(PAGE, 'rows', {
      configurable: true,
      enumerable: true,
      get: () => {
        if (++pages > 1) throw new Error('a page after the first fails')
        return 1
      },
      set: (rows: number) =>
        Object.defineProperty(PAGE, 'rows', {
          value: rows,
          writable: true,
          configurable: true,
          enumerable: true,
        }),
    })
    const failed = await runOnce(t, { dry_run: false })
    const keys = await t.run(async (ctx) =>
      (await ctx.db.query('issues').collect()).map((task) => task.window_key ?? null),
    )
    expect(keys).toEqual([null, 'bbbbbbbb'])
    const counts = { live: { ...NONE.live, issues: 1 }, stored: NONE.stored }
    expect(failed).toMatchObject({
      ...counts,
      done: false,
      cursor: { dry_run: false, table: 'issues', stored: false, page: expect.any(String) },
    })
    expect(failed.error).toContain('a page after the first fails')
    const cursor = failed.cursor as RunCursor
    const again = await runOnce(t, { dry_run: false, cursor })
    PAGE.rows = DEFAULT_PAGE.rows
    expect(again).toMatchObject({ ...NONE, done: false, cursor })
    expect(again.error).toContain('a page after the first fails')
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit.map((row) => row.detail)).toEqual([
      { ...counts, done: false, cursor, error: failed.error },
      { ...NONE, done: false, cursor, error: again.error },
    ])
    // from the failed page, the second task still holds its key
    const rest = await runOnce(t, { dry_run: false, cursor })
    expect(rest).toMatchObject({ live: { ...NONE.live, issues: 1 }, done: true })
  })

  it('goes on from its cursor after a stop, a page a call, and refuses a cursor of the other kind of call', async () => {
    const { t } = await plantKeys()
    PAGE.rows = 1
    RUN.ms = 0
    const first = await runOnce(t, { dry_run: true })
    expect(first.done).toBe(false)
    expect(first.cursor).toMatchObject({ dry_run: true, table: 'issues', stored: false })
    const cursor = first.cursor as RunCursor
    await expect(runOnce(t, { dry_run: false, cursor })).rejects.toThrow(
      'this cursor is from a call with the other dry_run',
    )

    const run = await runAll(t, false)
    // a page of one row a call, so more calls than the rows that held a field
    expect(run.calls).toBeGreaterThan(14)
    expect({ live: run.live, stored: run.stored }).toEqual(ONE_EACH)
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit).toHaveLength(run.calls)
    expect(audit.at(-1)?.detail).toMatchObject({ done: true, cursor: null })
    expect(audit.slice(0, -1).every((row) => row.detail.done === false)).toBe(true)

    Object.assign(PAGE, DEFAULT_PAGE)
    Object.assign(RUN, DEFAULT_RUN)
    const dry = await runAll(t, true)
    expect({ live: dry.live, stored: dry.stored }).toEqual(NONE)
  })
})

describe('no key after a run', () => {
  it('no create and no writer of a relation row gives a row a key', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    const [a, b] = [uuid(), uuid()]
    for (const id of [a, b])
      await admin.mutation(api.issues.create, { org_id, id, project_id: f.sub.id, title: 'New' })
    await admin.mutation(api.projects.create, {
      org_id,
      id: uuid(),
      type: 'project',
      parent_id: f.meta.id,
      key: 'NEW',
      name: 'New board',
      sort_order: 9,
    })
    const label = uuid()
    await admin.mutation(api.labels.create, { org_id, id: label, name: 'New', color: '#335577' })
    await admin.mutation(api.labels.toggle, { org_id, issue_id: a, label_id: label, on: true })
    await admin.mutation(api.issues.addLink, {
      org_id,
      id: uuid(),
      source_id: b,
      target_id: a,
      type: 'blocks',
    })
    await as(t, f.user).mutation(api.issues.subscribe, { org_id, issue_id: a })
    const storage_id = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(['spec']) as never),
    )
    const task = await t.run((ctx) => byId(ctx, 'issues', a))
    if (task === null) throw new Error('no task a')
    await plantTicket(t, { profile: f.admin, issue: task, storageId: storage_id })
    await admin.mutation(api.files.attach, {
      org_id,
      id: uuid(),
      issue_id: a,
      storage_id,
      name: 'spec.pdf',
      inline: false,
    })
    await admin.mutation(api.files.uploadUrl, { org_id, issue_id: a, size: 4, name: 'more.txt' })
    const rows = await everyRow(t)
    for (const table of TABLES) expect(rows[table].length, table).toBeGreaterThan(0)
    const dry = await runAll(t, true)
    expect({ live: dry.live, stored: dry.stored }).toEqual(NONE)
  })

  it('a delete stores no key, and a restore writes none back', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const a = await plantIssue(t, { org_id, project_id: f.sub.id })
    const to = await plantIssue(t, { org_id, project_id: f.sub.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantRows(t, f, a, { to, from })
    await keyLive(t, a.id, 'aaaaaaaa')
    await keyProject(t, f.sub2.id, 'bbbbbbbb')
    await deleteTask(t, f, a.id)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const stored = await t.run(async (ctx) => [
      ...(await copiesOf(ctx, a.id)),
      ...(await copiesOf(ctx, f.sub2.id)),
    ])
    expect(stored.map(({ row }) => row.table).sort()).toEqual([...STORED].sort())
    expect(stored.filter(({ row }) => keyed(row.doc))).toEqual([])

    await keyStored(t, a.id, 'cccccccc')
    await keyStored(t, f.sub2.id, 'dddddddd')
    for (const id of [a.id, f.sub2.id])
      await as(t, f.user).mutation(api.deletedItems.restore, {
        org_id,
        ids: [(await itemFor(t, id)).id],
      })
    await runSteps(t)
    const back = await t.run(async (ctx) => [
      await byId(ctx, 'issues', a.id),
      await byId(ctx, 'projects', f.sub2.id),
      ...(await relationRows(ctx, a.id)),
    ])
    expect(back).toHaveLength(stored.length)
    expect(back).not.toContain(null)
    expect(back.filter((row) => row !== null && keyed(row))).toEqual([])
  })

  it('a delete and a restore while a run goes on leave no field behind it', async () => {
    const { t, f, a, c } = await plantKeys()
    RUN.ms = 0
    // the run past live label assignments, before their stored copies
    let cursor: RunCursor | undefined
    for (;;) {
      const got: RunResult = await runOnce(t, {
        dry_run: false,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(got.done).toBe(false)
      cursor = got.cursor as RunCursor
      if (cursor.table === 'issue_labels' && cursor.stored) break
    }
    // `c`'s stored label assignment, still keyed, goes back to the live
    // table the run passed, and `a`'s keyed rows the run has not reached go
    // to Deleted items
    const copies = await t.run((ctx) => copiesOf(ctx, c.id))
    expect(copies.find(({ row }) => row.table === 'issue_labels')?.row.doc).toHaveProperty(
      'task_key',
      'cccccccc',
    )
    await deleteTask(t, f, a.id)
    await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id: f.org.id,
      ids: [(await itemFor(t, c.id)).id],
    })
    await runSteps(t)

    for (;;) {
      const got: RunResult = await runOnce(t, { dry_run: false, cursor })
      if (got.done) break
      cursor = got.cursor as RunCursor
    }
    const dry = await runAll(t, true)
    expect({ live: dry.live, stored: dry.stored }).toEqual(NONE)
  })
})
