/* model/billing.ts storageUsage, the attachment bytes an organization
 * stores in total and per project, read in one transaction. The admin
 * Billing page reads the same figures page by page
 * (billing.usageReport, through storagePage), as each new billing period's
 * sample does (covered in billing.test.ts).
 *
 *   1. It reads the organization's attachment rows in one index range and
 *      counts each in its task's project, reading each task once and
 *      counting only projects that still exist.
 *   2. Every move of a task (the app, REST and MCP) moves its usage, and so
 *      do the subtasks a move to another top-level project carries, without
 *      writing an attachment row.
 *   3. The Billing page's paged report gives the same figures at any page
 *      size, and past the size one query can read.
 *
 * The fixtures insert rows directly, in the shape attachFileCore stores. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { BillingUsage } from '../lib/billingTypes'
import { billingUsageHead, STORAGE_PAGE, storageUsage } from '../model/billing'
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

/* An attachment row of `task` holding `bytes`, as attachFileCore stores it. */
async function plantFile(
  t: T,
  storage_id: Id<'_storage'>,
  task: Pick<Doc<'issues'>, 'id' | 'org_id'>,
  bytes: number,
  over: { inline?: boolean; task_archived?: true } = {},
): Promise<Doc<'issue_attachments'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('issue_attachments', {
      org_id: task.org_id,
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
  it("totals each live project from the organization's rows, one task read per task, archived work included", async () => {
    const { t, f, sid, active, archived, shelved, elsewhere } = await fixture()
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, active, 10, { inline: true })
    await plantFile(t, sid, archived, 1000, { task_archived: true })
    await plantFile(t, sid, shelved, 5)
    await plantFile(t, sid, elsewhere, 7)

    // projects, the organization's rows, and one read for each of the three tasks
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 1115,
      projects: [FW(f, 1110), PCB(f, 5)],
      ranges: 2 + 3,
    })
    expect(await usage(t, f.otherOrg.id)).toEqual({
      bytes: 7,
      projects: [{ project_id: f.otherProject.id, name: 'Elsewhere', storage_bytes: 7 }],
      ranges: 2 + 1,
    })
  })

  it('leaves out a row whose task is gone and a task whose project row is gone', async () => {
    const { t, f, sid, active } = await fixture()
    await plantFile(t, sid, active, 100)
    // a row whose task was deleted without it
    await plantFile(t, sid, { ...active, id: uuid() }, 40)
    // a task stranded under a project row deleted directly
    const gone = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const stranded = await plantIssue(t, { org_id: f.org.id, project_id: gone.id })
    await plantFile(t, sid, stranded, 2000)
    await t.run((ctx) => ctx.db.delete(gone._id))

    expect(await usage(t, f.org.id)).toMatchObject({ bytes: 100, projects: [FW(f, 100)] })
  })
})

describe('moving a task', () => {
  it('moves its usage in the app, over REST and over MCP, without writing its rows', async () => {
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
    await plantFile(t, sid, active, 1)
    await plantFile(t, sid, quiet, 5)
    const rows = () =>
      t.run((ctx) =>
        ctx.db
          .query('issue_attachments')
          .withIndex('by_issue', (q) => q.eq('issue_id', active.id))
          .collect(),
      )
    const before = await rows()

    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: active.id,
      project_id: f.sub2.id,
    })
    expect(await rows()).toEqual(before)
    expect(await usage(t, f.org.id)).toMatchObject({ projects: [PCB(f, 111), FW(f, 5)] })

    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'drive',
      ref: active.id,
      body: JSON.stringify({ project: 'FW' }),
    })
    expect(await usage(t, f.org.id)).toMatchObject({ projects: [FW(f, 116)] })

    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: active.id,
      project: 'TBED',
      sub_project: 'PCB',
    })
    expect(await rows()).toEqual(before)
    expect(await usage(t, f.org.id)).toEqual({
      bytes: 116,
      projects: [PCB(f, 111), FW(f, 5)],
      ranges: 2 + 2,
    })
  })

  it('moves the usage of the subtasks a move to another top-level project carries', async () => {
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
    const done = await plantIssue(t, { ...inFw, parent_id: active.id, archived_at: NOW })
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, child, 20)
    await plantFile(t, sid, done, 3, { task_archived: true })
    await plantFile(t, sid, quiet, 5)

    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: active.id,
      project_id: backend.id,
    })
    expect(await usage(t, f.org.id)).toMatchObject({
      bytes: 128,
      projects: [{ project_id: backend.id, name: 'Backend', storage_bytes: 123 }, FW(f, 5)],
    })
  })
})

describe("the Billing page's paged report", () => {
  const defaults = { page: { ...STORAGE_PAGE } }
  afterEach(() => {
    Object.assign(STORAGE_PAGE, defaults.page)
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

  it('gives what the one query gives at any page size', async () => {
    const { t, f, sid, active, archived, shelved, elsewhere } = await fixture()
    await plantFile(t, sid, active, 100)
    await plantFile(t, sid, archived, 1000, { task_archived: true })
    await plantFile(t, sid, shelved, 5)
    await plantFile(t, sid, active, 50)
    await plantFile(t, sid, archived, 20, { task_archived: true })
    await plantFile(t, sid, elsewhere, 7)
    await plantFile(t, sid, { ...active, id: uuid() }, 40)
    const expected = await oneQuery(t, f)
    expect(expected).toMatchObject({ storage_bytes: 1175, projects: [FW(f, 1170), PCB(f, 5)] })

    for (const page of [{}, { rows: 1 }, { taskBytes: 1 }, { rows: 1, bytes: 1 }]) {
      Object.assign(STORAGE_PAGE, defaults.page, page)
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
})
