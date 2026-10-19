/* model/billing.ts storageUsage, the attachment bytes an organization
 * stores in total and per project, read in one transaction. The admin
 * Billing page reads the same figures page by page
 * (billing.usageReport, through storagePage), as each new billing period's
 * sample does (covered in billing.test.ts).
 *
 *   1. It reads the organization's attachment rows in one index range and
 *      groups them by the project each row carries, counting only projects
 *      that still exist.
 *   2. Older rows without a project take their task's, and older rows
 *      without an organization count in their task's organization. Past
 *      UNSCOPED_READ, those are found through the organization's own tasks,
 *      so other organizations' rows cannot take its read past the limits.
 *   3. Every move of a task (the app, REST and MCP) moves its rows' project,
 *      and so do the subtasks a move to another top-level project carries.
 *   4. The Billing page's paged report gives the same figures at any page
 *      size, and past the size one query can read.
 *
 * The fixtures insert rows directly, in the shape attachFileCore stores, or
 * without the fields older rows lack. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { BillingUsage } from '../lib/billingTypes'
import { billingUsageHead, STORAGE_PAGE, storageUsage, UNSCOPED_READ } from '../model/billing'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* A REST task answer mints attachment links (attachments.test.ts plants the
 * same). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

/* One stored file that every planted row names. Its real size does not
 * matter, because storageUsage adds the rows' size_bytes. */
const storedFile = (t: T): Promise<Id<'_storage'>> =>
  t.run((ctx) => ctx.storage.store(new Blob(['x']) as never))

/* An attachment row of `task` holding `bytes`, as attachFileCore stores it.
 * `legacy` leaves out what older rows lack: the project, or the
 * organization and the project. */
async function plantFile(
  t: T,
  storage_id: Id<'_storage'>,
  task: Pick<Doc<'issues'>, 'id' | 'org_id' | 'project_id'>,
  bytes: number,
  over: { inline?: boolean; task_archived?: true; legacy?: 'project' | 'scope' } = {},
): Promise<Doc<'issue_attachments'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('issue_attachments', {
      ...(over.legacy === 'scope' ? {} : { org_id: task.org_id }),
      ...(over.legacy === undefined ? { project_id: task.project_id } : {}),
      id: uuid(),
      issue_id: task.id,
      name: 'file.bin',
      size_bytes: bytes,
      storage_id,
      inline: over.inline ?? false,
      created_at: NOW,
      ...(over.task_archived ? { task_archived: true as const } : {}),
    })
    return (await ctx.db.get(_id)) as Doc<'issue_attachments'>
  })
}

/* storageUsage for `orgId`, with the index ranges the read used. */
const usage = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const before = await ctx.meta.getTransactionMetrics()
    const result = await storageUsage(ctx, orgId)
    const after = await ctx.meta.getTransactionMetrics()
    return { ...result, ranges: after.databaseQueries.used - before.databaseQueries.used }
  })

/* withOrg with PCB archived and four Testbed tasks: two active ones in FW,
 * an archived one in FW and one in PCB. Other holds one task. */
async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const sid = await storedFile(t)
  await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
  const inFw = { org_id: f.org.id, project_id: f.sub.id }
  const active = await plantIssue(t, inFw)
  const quiet = await plantIssue(t, inFw)
  const archived = await plantIssue(t, { ...inFw, archived_at: NOW })
  const shelved = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
  const elsewhere = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
  return { t, f, sid, active, quiet, archived, shelved, elsewhere }
}

const FW = (f: OrgFixture, storage_bytes: number) => ({
  project_id: f.sub.id,
  name: 'Firmware',
  storage_bytes,
})
const PCB = (f: OrgFixture, storage_bytes: number) => ({
  project_id: f.sub2.id,
  name: 'Board rev',
  storage_bytes,
})

describe('storageUsage', () => {
  it("totals each live project from the organization's rows in three index ranges, archived work included", async () => {
    const { t, f, sid, active, archived, shelved, elsewhere } = await fixture()
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, active, 10, { inline: true })
    await plantFile(t, sid, archived, 1000, { task_archived: true })
    await plantFile(t, sid, shelved, 5)
    await plantFile(t, sid, elsewhere, 7)

    // projects, the organization's rows and the rows without org_id
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 1115,
      projects: [FW(f, 1110), PCB(f, 5)],
      ranges: 3,
    })
    expect(await usage(t, f.otherOrg.id)).toEqual({
      bytes: 7,
      projects: [{ project_id: f.otherProject.id, name: 'Elsewhere', storage_bytes: 7 }],
      ranges: 3,
    })
  })

  it("gives rows stored without a project their task's, one task read per task", async () => {
    const { t, f, sid, active, archived, shelved } = await fixture()
    await plantFile(t, sid, active, 100, { legacy: 'project' })
    await plantFile(t, sid, active, 10, { legacy: 'project' })
    await plantFile(t, sid, archived, 1000, { task_archived: true })
    await plantFile(t, sid, shelved, 5, { legacy: 'project' })

    expect(await usage(t, f.org.id)).toEqual({
      bytes: 1115,
      projects: [FW(f, 1110), PCB(f, 5)],
      // the two tasks that hold such rows, each read once
      ranges: 3 + 2,
    })
  })

  it('leaves out a row whose task is gone and a task whose project row is gone', async () => {
    const { t, f, sid, active } = await fixture()
    await plantFile(t, sid, active, 100)
    // a row without a project whose task was deleted without it
    await plantFile(t, sid, { ...active, id: uuid() }, 40, { legacy: 'project' })
    // a task stranded under a project row deleted directly
    const gone = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const stranded = await plantIssue(t, { org_id: f.org.id, project_id: gone.id })
    await plantFile(t, sid, stranded, 2000)
    await plantFile(t, sid, stranded, 3000, { legacy: 'project' })
    await t.run((ctx) => ctx.db.delete(gone._id))

    expect(await usage(t, f.org.id)).toMatchObject({ bytes: 100, projects: [FW(f, 100)] })
  })

  it("counts a row stored without its organization in its task's organization only, reading each task once", async () => {
    const { t, f, sid, active, archived, shelved, elsewhere } = await fixture()
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, archived, 1000, { task_archived: true })
    await plantFile(t, sid, shelved, 5, { legacy: 'project' })
    // rows without org_id: another organization's, two on one of this
    // organization's tasks, and one whose task is gone
    await plantFile(t, sid, elsewhere, 7, { legacy: 'scope' })
    await plantFile(t, sid, active, 50, { legacy: 'scope' })
    await plantFile(t, sid, active, 20, { legacy: 'scope' })
    await plantFile(t, sid, { ...active, id: uuid() }, 40, { legacy: 'scope' })

    // projects, the organization's rows, the rows without org_id, and one
    // read for each task those name: shelved, elsewhere, active and the gone one
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 1175,
      projects: [FW(f, 1170), PCB(f, 5)],
      ranges: 3 + 4,
    })
    expect(await usage(t, f.otherOrg.id)).toEqual({
      bytes: 7,
      projects: [{ project_id: f.otherProject.id, name: 'Elsewhere', storage_bytes: 7 }],
      ranges: 3 + 3,
    })
  })
})

describe('rows stored without an organization past UNSCOPED_READ', () => {
  const defaults = { ...UNSCOPED_READ }
  afterEach(() => Object.assign(UNSCOPED_READ, defaults))

  it("are found through the organization's own tasks, whatever other organizations store", async () => {
    const { t, f, sid, active, shelved, elsewhere } = await fixture()
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, active, 50, { legacy: 'scope' })
    await plantFile(t, sid, shelved, 5, { legacy: 'scope' })
    await plantFile(t, sid, elsewhere, 7, { legacy: 'scope' })
    UNSCOPED_READ.lookups = 2

    // projects, the organization's rows, the rows without org_id up to the
    // bound, then the organization's tasks and each one's attachments
    const before = await usage(t, f.org.id)
    expect(before).toEqual({ bytes: 155, projects: [FW(f, 150), PCB(f, 5)], ranges: 3 + 1 + 4 })
    // more rows without org_id elsewhere, here of tasks that are gone
    for (let i = 0; i < 10; i++) {
      await plantFile(t, sid, { ...elsewhere, id: uuid() }, 40, { legacy: 'scope' })
    }
    expect(await usage(t, f.org.id)).toEqual(before)
    expect(await usage(t, f.otherOrg.id)).toMatchObject({
      bytes: 7,
      projects: [{ project_id: f.otherProject.id, name: 'Elsewhere', storage_bytes: 7 }],
    })
  })

  it("get the task lookups the organization's own rows without a project leave", async () => {
    const { t, f, sid, active, quiet, shelved } = await fixture()
    await plantFile(t, sid, active, 50, { legacy: 'scope' })
    await plantFile(t, sid, shelved, 5, { legacy: 'scope' })
    UNSCOPED_READ.lookups = 3

    // two lookups for the rows without org_id
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 55,
      projects: [FW(f, 50), PCB(f, 5)],
      ranges: 3 + 2,
    })
    // two of the organization's rows lack their project, which leaves one
    await plantFile(t, sid, active, 100, { legacy: 'project' })
    await plantFile(t, sid, quiet, 10, { legacy: 'project' })
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 165,
      projects: [FW(f, 160), PCB(f, 5)],
      ranges: 3 + 2 + 1 + 4,
    })
  })

  it("are found through the organization's own tasks once other organizations' tasks pass the byte budget", async () => {
    const { t, f, sid, active } = await fixture()
    // another organization's task, first in the range of rows without org_id
    const first = await plantIssue(t, {
      id: '00000000-0000-4000-8000-000000000000',
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
    })
    await plantFile(t, sid, first, 7, { legacy: 'scope' })
    await plantFile(t, sid, active, 50, { legacy: 'scope' })
    UNSCOPED_READ.taskBytes = 1

    // the read of rows without org_id and its one task lookup, then the
    // organization's tasks and each one's attachments
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 50,
      projects: [FW(f, 50)],
      ranges: 3 + 1 + 1 + 4,
    })
  })
})

describe('moving a task', () => {
  it("moves its rows' project in the app, over REST and over MCP, and its usage with them", async () => {
    const { t, f, sid, active, quiet } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.patch(f.sub2._id, { archived_at: undefined })
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      })
    })
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, active, 10, { inline: true })
    // an older row without a project gets the new one too
    await plantFile(t, sid, active, 1, { legacy: 'project' })
    await plantFile(t, sid, quiet, 5)
    const projects = () =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query('issue_attachments')
            .withIndex('by_issue', (q) => q.eq('issue_id', active.id))
            .collect()
        ).map((row) => row.project_id ?? null),
      )

    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: active.id,
      project_id: f.sub2.id,
    })
    expect(await projects()).toEqual([f.sub2.id, f.sub2.id, f.sub2.id])
    expect(await usage(t, f.org.id)).toMatchObject({ projects: [PCB(f, 111), FW(f, 5)] })

    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'drive',
      ref: active.id,
      body: JSON.stringify({ project: 'FW' }),
    })
    expect(await projects()).toEqual([f.sub.id, f.sub.id, f.sub.id])
    expect(await usage(t, f.org.id)).toMatchObject({ projects: [FW(f, 116)] })

    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: active.id,
      project: 'TBED',
      sub_project: 'PCB',
    })
    expect(await projects()).toEqual([f.sub2.id, f.sub2.id, f.sub2.id])
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 116,
      projects: [PCB(f, 111), FW(f, 5)],
      ranges: 3,
    })
  })

  it('moves the rows of the subtasks a move to another top-level project carries', async () => {
    const { t, f, sid, active, quiet } = await fixture()
    const cloud = await plantProject(t, { org_id: f.org.id, key: 'CLD', name: 'Cloud' })
    const backend = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: cloud.id,
      key: 'BE',
      name: 'Backend',
    })
    const inFw = { org_id: f.org.id, project_id: f.sub.id }
    const child = await plantIssue(t, { ...inFw, parent_id: active.id })
    const done = await plantIssue(t, { ...inFw, parent_id: child.id, archived_at: NOW })
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, child, 20)
    await plantFile(t, sid, done, 3, { task_archived: true })
    await plantFile(t, sid, quiet, 5)

    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: active.id,
      project_id: backend.id,
    })
    const rows = await t.run((ctx) => ctx.db.query('issue_attachments').collect())
    expect(rows.map((row) => [row.issue_id, row.project_id]).sort()).toEqual(
      [
        [active.id, backend.id],
        [child.id, backend.id],
        [done.id, backend.id],
        [quiet.id, f.sub.id],
      ].sort(),
    )
    expect(await usage(t, f.org.id)).toMatchObject({
      bytes: 128,
      projects: [{ project_id: backend.id, name: 'Backend', storage_bytes: 123 }, FW(f, 5)],
    })
  })
})

describe("the Billing page's paged report", () => {
  const defaults = { page: { ...STORAGE_PAGE }, unscoped: { ...UNSCOPED_READ } }
  afterEach(() => {
    Object.assign(STORAGE_PAGE, defaults.page)
    Object.assign(UNSCOPED_READ, defaults.unscoped)
  })

  const report = (t: T, f: OrgFixture): Promise<BillingUsage> =>
    as(t, f.admin).action(api.billing.usageReport, { org_id: f.org.id })
  /* The same report read in one transaction, storageUsage for its storage. */
  const oneQuery = (t: T, f: OrgFixture): Promise<BillingUsage> =>
    t.run(async (ctx) => {
      const storage = await storageUsage(ctx, f.org.id)
      const head = await billingUsageHead(ctx, f.org.id)
      return { ...head, storage_bytes: storage.bytes, projects: storage.projects }
    })

  it('gives what the one query gives at any page size, rows without org_id included', async () => {
    const { t, f, sid, active, archived, shelved, elsewhere } = await fixture()
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, archived, 1000, { task_archived: true })
    await plantFile(t, sid, shelved, 5, { legacy: 'project' })
    await plantFile(t, sid, active, 50, { legacy: 'scope' })
    await plantFile(t, sid, archived, 20, { legacy: 'scope', task_archived: true })
    await plantFile(t, sid, elsewhere, 7, { legacy: 'scope' })
    await plantFile(t, sid, { ...active, id: uuid() }, 40, { legacy: 'scope' })
    const expected = await oneQuery(t, f)
    expect(expected).toMatchObject({ storage_bytes: 1175, projects: [FW(f, 1170), PCB(f, 5)] })

    for (const [page, lookups] of [
      [{}, 3000],
      [{ rows: 1, tasks: 1 }, 3000],
      [{ taskBytes: 1 }, 3000],
      // the rows without org_id are read through the organization's tasks
      [{}, 2],
      [{ rows: 1, tasks: 1, bytes: 1 }, 2],
    ] as const) {
      Object.assign(STORAGE_PAGE, defaults.page, page)
      UNSCOPED_READ.lookups = lookups
      expect(await report(t, f)).toEqual(expected)
    }
  })

  it('refuses anyone but an organization admin', async () => {
    const { t, f } = await fixture()
    await expect(
      as(t, f.user).action(api.billing.usageReport, { org_id: f.org.id }),
    ).rejects.toThrow(/admin only/)
    await expect(
      as(t, f.otherAdmin).action(api.billing.usageReport, { org_id: f.org.id }),
    ).rejects.toThrow(/admin only/)
  })

  it('reads 1,500 attachment rows under 1,000 documents a read, where the one query fails', async () => {
    const t = newT({ transactionLimits: { documentsRead: 1000 } })
    const f = await withOrg(t)
    const sid = await storedFile(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 1500; i++)
        await ctx.db.insert('issue_attachments', {
          org_id: f.org.id,
          project_id: f.sub.id,
          id: uuid(),
          issue_id: task.id,
          name: 'file.bin',
          size_bytes: 3,
          storage_id: sid,
          inline: false,
          created_at: NOW,
        })
    })
    STORAGE_PAGE.rows = 400
    expect(await report(t, f)).toMatchObject({ storage_bytes: 4500, projects: [FW(f, 4500)] })
    await expect(oneQuery(t, f)).rejects.toThrow(/Scanned too many documents/)
  })

  it('reads a task with more rows without org_id than a page, a page at a time', async () => {
    const t = newT({ transactionLimits: { documentsRead: 1000 } })
    const f = await withOrg(t)
    const sid = await storedFile(t)
    const plant = (task: Pick<Doc<'issues'>, 'id'>, n: number, task_archived?: true) =>
      t.run(async (ctx) => {
        for (let i = 0; i < n; i++)
          await ctx.db.insert('issue_attachments', {
            id: uuid(),
            issue_id: task.id,
            name: 'file.bin',
            size_bytes: 3,
            storage_id: sid,
            inline: false,
            created_at: NOW,
            ...(task_archived ? { task_archived } : {}),
          })
      })
    // a small task first, so the page splits before the large one
    const small = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const large = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plant(small, 5)
    await plant(large, 1200)
    await plant(large, 300, true)
    UNSCOPED_READ.lookups = 2
    STORAGE_PAGE.rows = 400
    expect(await report(t, f)).toMatchObject({ storage_bytes: 4515, projects: [FW(f, 4515)] })
    // a page boundary on the last row of the task's other rows
    STORAGE_PAGE.rows = 300
    expect(await report(t, f)).toMatchObject({ storage_bytes: 4515, projects: [FW(f, 4515)] })
  })

  it('starts the next task from its first row when the task a page stopped in is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sid = await storedFile(t)
    const first = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const next = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // the next task's rows are older than the first task's, so a resume
    // point carried over to it would skip them
    for (let i = 0; i < 2; i++) await plantFile(t, sid, next, 5, { legacy: 'scope' })
    for (let i = 0; i < 6; i++) await plantFile(t, sid, first, 3, { legacy: 'scope' })
    STORAGE_PAGE.rows = 4
    const page = (cursor: string | null) =>
      t.query(internal.billing.storageNowPage, { org_id: f.org.id, phase: 'tasks', cursor })
    const opening = await page(null)
    if ('split' in opening || opening.next === null)
      throw new Error('expected a page inside a task')
    expect(opening.bytes).toBe(12)
    // the first task leaves with its rows, as a move to Deleted items takes them
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('issue_attachments').collect())
        if (row.issue_id === first.id) await ctx.db.delete(row._id)
      const task = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .filter((q) => q.eq(q.field('id'), first.id))
        .unique()
      if (task) await ctx.db.delete(task._id)
    })
    let bytes = opening.bytes
    let cursor: string | null = opening.next
    while (cursor !== null) {
      const rest = await page(cursor)
      if ('split' in rest) throw new Error('a page of one task does not split')
      bytes += rest.bytes
      cursor = rest.next
    }
    expect(bytes).toBe(22)
  })
})
