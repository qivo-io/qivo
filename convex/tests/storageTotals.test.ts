/* The stored-byte totals of task files (schema.ts storage_org_totals,
 * storage_project_totals and storage_task_totals, kept by
 * model/storageTotals.ts) and their backfill
 * (internal/storageTotalsBackfill.ts).
 *
 *   1. An attach counts its file once, in the app, over REST and over MCP,
 *      a description image included. A refused attach counts nothing.
 *   2. A delete for good takes the file out, whether a removal, the reap of a
 *      dropped description image, a purge step by step, a restore that
 *      drops a subtask whose project is gone, an organization's deletion
 *      and deleteOrgDeep. A dropped image counts until its reap.
 *   3. A move between projects moves the bytes, with every subtask a move
 *      to another top-level project carries. A move to Deleted items and a
 *      restore change nothing, step by step. A rename renames the
 *      project's row.
 *   4. The backfill counts an organization exactly while attaches, removals
 *      and moves land between its steps. Its dry run reports differences
 *      and attachment rows whose task is gone without writing, and a
 *      recount mends the differences.
 *   5. Profile pictures and backgrounds never count, and an organization
 *      reads as counted only once it is.
 * The public demo's cleanup is covered in demoCleanup.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { COUNT_PAGE, RUN } from '../internal/storageTotalsBackfill'
import { byId } from '../lib/db'
import { LIMITS } from '../lib/limits'
import { deleteOrgDeep, REMOVAL_BUDGET } from '../model/cascade'
import { TRASH_BUDGET } from '../model/deletedItems'
import { DROPPED_KEEP_MS } from '../model/descriptionImages'
import { wipeWorkStep } from '../model/orgDeletion'
import { insertOrgRows, newOrgDefaults } from '../model/orgs'
import {
  type Amount,
  addToOrg,
  addToProject,
  orgTotalsRow,
  storageTotalsOf,
} from '../model/storageTotals'
import {
  as,
  fileState,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import {
  DEFAULT_BUDGET,
  deleteProject,
  deleteTask,
  installTrashTimers,
  itemFor,
  runSteps,
  step as trashStep,
} from './trash.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

/* Download links and upload URLs read this lazily (attachments.test.ts
 * plants the same). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'

const MiB = 1024 * 1024
const DEFAULT_REMOVAL = { ...REMOVAL_BUDGET }
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
})

const countStep = (t: T, orgId: string, recount = false) =>
  t.mutation(internal.internal.storageTotalsBackfill.step, { org_id: orgId, recount })
const backfill = (t: T, args: { dry_run: boolean; recount?: boolean }) =>
  t.action(internal.internal.storageTotalsBackfill.run, args)

/** Counts organization `orgId` step by step, as a run does. */
async function countStorage(t: T, orgId: string, recount = false): Promise<Amount> {
  for (let i = 0; i < 1000; i++) {
    const got = await countStep(t, orgId, recount)
    if (got === 'skipped') throw new Error(`organization ${orgId} was skipped`)
    if (got !== null) return got
  }
  throw new Error('the count did not finish')
}

/** The organization's totals rows as stored, the project and task rows in
 * id order. */
const rowsOf = (t: T, orgId: string) =>
  t.run(async (ctx) => ({
    org: await ctx.db
      .query('storage_org_totals')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
    projects: (
      await ctx.db
        .query('storage_project_totals')
        .withIndex('by_org_bytes', (q) => q.eq('org_id', orgId))
        .collect()
    )
      .map(({ project_id, name, bytes, files }) => ({ project_id, name, bytes, files }))
      .sort((x, y) => x.project_id.localeCompare(y.project_id)),
    tasks: (
      await ctx.db
        .query('storage_task_totals')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
    )
      .map(({ issue_id, project_id, bytes, files }) => ({ issue_id, project_id, bytes, files }))
      .sort((x, y) => x.issue_id.localeCompare(y.issue_id)),
  }))

/** The organization's attachment rows, live and stored in Deleted items. */
const filesOf = (t: T, orgId: string) =>
  t.run(async (ctx) => [
    ...(await ctx.db
      .query('issue_attachments')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()),
    ...(
      await ctx.db
        .query('deleted_rows')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect()
    ).flatMap((row) => (row.row.table === 'issue_attachments' ? [row.row.doc] : [])),
  ])

/** The bytes and files of `files`. */
const sum = (files: readonly { size_bytes: number }[]): Amount => ({
  bytes: files.reduce((n, file) => n + file.size_bytes, 0),
  files: files.length,
})

/**
 * Expects organization `orgId` counted, with the rows its files give. Each
 * attachment row, live or stored, of a task in issues or deleted_tasks counts
 * in that task's project. Answers the organization's totals.
 */
async function expectTotals(t: T, orgId: string): Promise<Amount> {
  const projectOf = new Map(
    await t.run(async (ctx) => [
      ...(
        await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .collect()
      ).map((task): [string, string] => [task.id, task.project_id]),
      ...(
        await ctx.db
          .query('deleted_tasks')
          .withIndex('by_org_num', (q) => q.eq('org_id', orgId))
          .collect()
      ).map((task): [string, string] => [task.task_id, task.project_id]),
    ]),
  )
  const tasks = new Map<string, { issue_id: string; project_id: string } & Amount>()
  for (const file of await filesOf(t, orgId)) {
    const project_id = projectOf.get(file.issue_id)
    if (project_id === undefined) continue
    const task = tasks.get(file.issue_id) ?? { issue_id: file.issue_id, project_id, ...sum([]) }
    task.bytes += file.size_bytes
    task.files += 1
    tasks.set(file.issue_id, task)
  }
  const projects = new Map<string, { project_id: string } & Amount>()
  for (const task of tasks.values()) {
    const project = projects.get(task.project_id) ?? { project_id: task.project_id, ...sum([]) }
    project.bytes += task.bytes
    project.files += task.files
    projects.set(task.project_id, project)
  }
  const org = { bytes: 0, files: 0 }
  for (const task of tasks.values()) {
    org.bytes += task.bytes
    org.files += task.files
  }
  const held = await rowsOf(t, orgId)
  expect(held.org, 'the organization is counted').not.toBeNull()
  expect(held.org?.counting).toBeUndefined()
  expect({ bytes: held.org?.bytes, files: held.org?.files }).toEqual(org)
  expect(held.projects.map(({ name: _name, ...row }) => row)).toEqual(
    [...projects.values()].sort((x, y) => x.project_id.localeCompare(y.project_id)),
  )
  expect(held.tasks).toEqual(
    [...tasks.values()].sort((x, y) => x.issue_id.localeCompare(y.issue_id)),
  )
  return org
}

/** `bytes` zero bytes stored, with `type` as their content type when given. */
const storeBlob = (t: T, bytes: number, type?: string): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const sid = await ctx.storage.store(new Blob([new Uint8Array(bytes)]) as never)
    if (type !== undefined) await ctx.db.patch(sid as never, { contentType: type } as never)
    return sid
  })

/** An attachment row of `bytes` on `task`, planted without any writer, as
 * a release before this one stored it. */
const plantFile = (t: T, task: Pick<Doc<'issues'>, 'id' | 'org_id'>, bytes: number) =>
  t.run(async (ctx) => {
    const storage_id = await ctx.storage.store(new Blob([new Uint8Array(1)]) as never)
    const _id = await ctx.db.insert('issue_attachments', {
      org_id: task.org_id,
      id: uuid(),
      issue_id: task.id,
      name: 'planted.bin',
      size_bytes: bytes,
      storage_id,
      inline: false,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_attachments'>
  })

/** Attaches `bytes` new bytes to `issue` in the app, as `by`. */
async function attach(
  t: T,
  f: OrgFixture,
  issue: Doc<'issues'>,
  bytes: number,
  extra: { inline?: boolean; by?: Doc<'profiles'> } = {},
) {
  const storage_id = await storeBlob(t, bytes, extra.inline ? 'image/png' : undefined)
  const out = await as(t, extra.by ?? f.user).mutation(api.files.attach, {
    org_id: f.org.id,
    id: uuid(),
    issue_id: issue.id,
    storage_id,
    name: extra.inline ? 'shot.png' : 'spec.pdf',
    inline: extra.inline ?? false,
  })
  if (!('attachment' in out)) throw new Error(`the attach was refused: ${out.refused.message}`)
  return { ...out.attachment, storage_id }
}

/* withOrg with the agent holding Edit on TBED (FW, PCB), counted. */
async function setup(t: T = newT()) {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  await countStorage(t, f.org.id)
  return { t, f }
}

/* POSTs `size` bytes to the upload URL `uploadUrl` as a client would and
 * answers the stored file (records.test.ts sends the same). */
async function upload(t: T, uploadUrl: string, size: number): Promise<string> {
  const url = new URL(uploadUrl)
  const res = await (
    t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body: Uint8Array },
      ): Promise<{ text(): Promise<string> }>
    }
  ).fetch(`${url.pathname}${url.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(size),
  })
  const json = JSON.parse(await res.text()) as { storageId?: string; error?: string }
  if (json.storageId === undefined) throw new Error(`upload failed: ${json.error}`)
  return json.storageId
}

describe('attaching', () => {
  it('counts each attached file once, in the app, over REST and over MCP', async () => {
    const { t, f } = await setup()
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 0, files: 0 })

    // the app: a file and a description image
    await attach(t, f, issue, 100)
    await attach(t, f, issue, 10, { inline: true })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 110, files: 2 })

    // REST: the ticket, the upload and the confirm
    const rest = await t.mutation(internal.machine.records.restStartUpload, {
      callerId: f.agent.id,
      access: 'write',
      ref: issue.id,
      body: JSON.stringify({ name: 'wiring.pdf', size: 2048 }),
    })
    // an upload alone counts nothing
    const restFile = await upload(t, rest.upload_url, 2048)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 110, files: 2 })
    await t.mutation(internal.machine.records.restConfirmUpload, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'CI key',
      ref: issue.id,
      ticket: rest.ticket,
      body: JSON.stringify({ storage_id: restFile }),
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 2158, files: 3 })

    // MCP: the upload tools and attach_text_file
    const mcp = JSON.parse(
      await t.mutation(internal.machine.records.mcpStartUpload, {
        callerId: f.agent.id,
        access: 'write',
        ref: issue.id,
        name: 'log.bin',
        size: 300,
      }),
    ) as { ticket: string; upload_url: string }
    const mcpFile = await upload(t, mcp.upload_url, 300)
    await t.mutation(internal.machine.records.mcpConfirmUpload, {
      callerId: f.agent.id,
      access: 'write',
      ref: issue.id,
      ticket: mcp.ticket,
      storage_id: mcpFile,
    })
    await t.action(internal.machine.records.mcpAttachTextFile, {
      callerId: f.agent.id,
      access: 'write',
      ref: issue.id,
      name: 'notes.txt',
      text: 'abc',
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 2461, files: 5 })
    expect((await rowsOf(t, f.org.id)).projects).toEqual([
      { project_id: f.sub.id, name: 'Firmware', bytes: 2461, files: 5 },
    ])
    expect(await t.run((ctx) => storageTotalsOf(ctx, f.org.id))).toEqual({
      bytes: 2461,
      files: 5,
    })
    // the other organization counts nothing of it
    expect(await t.run((ctx) => storageTotalsOf(ctx, f.otherOrg.id))).toBeNull()
  })

  it('counts nothing for an attach that is refused, on a full task or over the cap', async () => {
    const t = newT()
    const f = await withOrg(t)
    const full = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let i = 0; i < LIMITS.attachments.max; i++) await plantFile(t, full, 2)
    await countStorage(t, f.org.id)
    const before = await rowsOf(t, f.org.id)
    expect(before.org).toMatchObject({ bytes: 2 * LIMITS.attachments.max })

    const extra = await storeBlob(t, 50)
    await expect(
      as(t, f.user).mutation(api.files.attach, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: full.id,
        storage_id: extra,
        name: 'one-too-many.pdf',
        inline: false,
      }),
    ).rejects.toThrow(LIMITS.attachments.refusal)
    // the organization's cap of 10 MiB: the bytes are deleted and nothing counts
    const big = await storeBlob(t, 10 * MiB + 1)
    const out = await as(t, f.user).mutation(api.files.attach, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: other.id,
      storage_id: big,
      name: 'huge.bin',
      inline: false,
    })
    expect(out).toHaveProperty('refused')
    expect(await fileState(t, big)).toBe('gone')
    // a file attached already cannot count twice
    const once = await attach(t, f, other, 7)
    await expect(
      as(t, f.user).mutation(api.files.attach, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: other.id,
        storage_id: once.storage_id,
        name: 'again.pdf',
        inline: false,
      }),
    ).rejects.toThrow('this file is already attached')
    expect(await expectTotals(t, f.org.id)).toEqual({
      bytes: 2 * LIMITS.attachments.max + 7,
      files: LIMITS.attachments.max + 1,
    })
  })

  it('leaves an organization that is not counted alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const file = await attach(t, f, issue, 40)
    expect(await rowsOf(t, f.org.id)).toEqual({ org: null, projects: [], tasks: [] })
    await as(t, f.user).mutation(api.files.removeAttachment, { org_id: f.org.id, id: file.id })
    expect(await rowsOf(t, f.org.id)).toEqual({ org: null, projects: [], tasks: [] })
    expect(await t.run((ctx) => storageTotalsOf(ctx, f.org.id))).toBeNull()
  })
})

describe('deleting files', () => {
  it('takes a removed file out, in the app, over REST and over MCP', async () => {
    const { t, f } = await setup()
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [a, b, c] = [
      await attach(t, f, issue, 1),
      await attach(t, f, issue, 20),
      await attach(t, f, issue, 300),
    ]
    await attach(t, f, issue, 4000)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 4321, files: 4 })
    await as(t, f.user).mutation(api.files.removeAttachment, { org_id: f.org.id, id: a.id })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 4320, files: 3 })
    await t.mutation(internal.machine.records.restDeleteAttachment, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'CI key',
      ref: issue.id,
      id: b.id,
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 4300, files: 2 })
    await t.mutation(internal.machine.records.mcpDeleteAttachment, {
      callerId: f.agent.id,
      access: 'write',
      ref: issue.id,
      attachment: c.id,
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 4000, files: 1 })
    // a refused removal changes nothing
    await expect(
      as(t, f.viewer).mutation(api.files.removeAttachment, { org_id: f.org.id, id: a.id }),
    ).rejects.toThrow()
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 4000, files: 1 })
  })

  it('keeps a dropped description image counted until its reap deletes it', async () => {
    vi.useFakeTimers()
    try {
      const { t, f } = await setup()
      const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      const image = await attach(t, f, issue, 64, { inline: true })
      await attach(t, f, issue, 1000)
      const save = (description: string) =>
        as(t, f.admin).mutation(api.issues.update, {
          org_id: f.org.id,
          id: issue.id,
          patch: { description },
        })
      await save(`Wiring ![photo](att:${image.id})`)
      // the save that takes it out drops it, and its file is still stored
      await save('Wiring')
      const row = await t.run((ctx) =>
        ctx.db
          .query('issue_attachments')
          .withIndex('by_uuid', (q) => q.eq('id', image.id))
          .unique(),
      )
      expect(row?.dropped_at).toBeDefined()
      expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 1064, files: 2 })
      vi.advanceTimersByTime(DROPPED_KEEP_MS + 1)
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0))
      expect(await fileState(t, image.storage_id)).toBe('held')
      // a held file belongs to no organization
      expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 1000, files: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes every total of an organization with its deletion in steps', async () => {
    vi.useFakeTimers()
    try {
      const { t, f } = await setup()
      const kept = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
      await countStorage(t, f.otherOrg.id)
      await plantFile(t, kept, 9)
      await countStorage(t, f.otherOrg.id, true)
      for (let i = 0; i < 3; i++) {
        const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
        await attach(t, f, issue, 10 + i)
        await attach(t, f, issue, 100)
      }
      // and a task whose move to Deleted items stopped after its task row,
      // its files still live
      const trashed = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await attach(t, f, trashed, 1000)
      await attach(t, f, trashed, 2000)
      TRASH_BUDGET.rows = 1
      await deleteTask(t, f, trashed.id)
      Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
      expect(await t.run((ctx) => byId(ctx, 'issues', trashed.id))).toBeNull()
      expect(
        (await filesOf(t, f.org.id)).filter((file) => file.issue_id === trashed.id),
      ).toHaveLength(2)
      expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 3333, files: 8 })
      await t.run((ctx) =>
        ctx.db.insert('org_removals', {
          org_id: f.org.id,
          reason: 'requested',
          ended_at: NOW,
          delete_after: NOW,
          phase: 'profiles',
          created_at: NOW,
        }),
      )
      // a count of an organization being deleted leaves it to the deletion
      expect(await countStep(t, f.org.id, true)).toBe('skipped')
      REMOVAL_BUDGET.rows = 3
      for (let i = 0; i < 200; i++) {
        if ((await t.run((ctx) => ctx.db.get(f.org._id))) === null) break
        // while its row lasts, it holds every file still stored
        const { org } = await rowsOf(t, f.org.id)
        if (org !== null) expect(org).toMatchObject(sum(await filesOf(t, f.org.id)))
        await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
      }
      expect(await t.run((ctx) => ctx.db.get(f.org._id))).toBeNull()
      expect(await rowsOf(t, f.org.id)).toEqual({ org: null, projects: [], tasks: [] })
      expect(await expectTotals(t, f.otherOrg.id)).toEqual({ bytes: 9, files: 1 })
    } finally {
      Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
      Object.assign(REMOVAL_BUDGET, DEFAULT_REMOVAL)
      vi.useRealTimers()
    }
  })

  it("keeps an organization's totals through the Northstar wipe of its work", async () => {
    const { t, f } = await setup()
    for (let i = 0; i < 4; i++) {
      const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await attach(t, f, issue, 3)
      await attach(t, f, issue, 4, { inline: true })
    }
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 28, files: 8 })
    for (let i = 0; i < 100; i++) {
      const done = await t.run((ctx) => wipeWorkStep(ctx, f.org.id, [], { rows: 3, bytes: MiB }))
      expect((await rowsOf(t, f.org.id)).org).toMatchObject(sum(await filesOf(t, f.org.id)))
      if (done) break
    }
    expect(await rowsOf(t, f.org.id)).toMatchObject({
      org: { bytes: 0, files: 0 },
      projects: [],
      tasks: [],
    })
  })

  it('takes every total of an organization with deleteOrgDeep', async () => {
    const { t, f } = await setup()
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await attach(t, f, issue, 5)
    await countStorage(t, f.otherOrg.id)
    await t.run(async (ctx) =>
      deleteOrgDeep(ctx, (await ctx.db.get(f.org._id)) as Doc<'organizations'>),
    )
    expect(await rowsOf(t, f.org.id)).toEqual({ org: null, projects: [], tasks: [] })
    expect(await rowsOf(t, f.otherOrg.id)).toMatchObject({ org: { bytes: 0, files: 0 } })
  })
})

describe('moving tasks', () => {
  it("moves a task's bytes to its new project, with the subtasks a move to another top-level project carries", async () => {
    const { t, f } = await setup()
    const cloud = await plantProject(t, { org_id: f.org.id, key: 'CLD', name: 'Cloud' })
    const backend = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: cloud.id,
      key: 'BE',
      name: 'Backend',
    })
    const inFw = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, inFw)
    const quiet = await plantIssue(t, inFw)
    const kids: Doc<'issues'>[] = []
    for (let i = 0; i < 30; i++)
      kids.push(
        await plantIssue(t, {
          ...inFw,
          parent_id: root.id,
          ...(i % 3 ? {} : { archived_at: NOW }),
        }),
      )
    await attach(t, f, root, 100, { by: f.admin })
    await attach(t, f, quiet, 5, { by: f.admin })
    for (const kid of kids) {
      await attach(t, f, kid, 2, { by: f.admin })
      await attach(t, f, kid, 1, { by: f.admin, inline: true })
    }
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 195, files: 62 })

    // within its top-level project the task moves alone
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: root.id,
      project_id: f.sub2.id,
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 195, files: 62 })
    expect((await rowsOf(t, f.org.id)).projects).toEqual(
      [
        { project_id: f.sub.id, name: 'Firmware', bytes: 95, files: 61 },
        { project_id: f.sub2.id, name: 'Board rev', bytes: 100, files: 1 },
      ].sort((x, y) => x.project_id.localeCompare(y.project_id)),
    )

    // to another top-level project its subtasks come along
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: root.id,
      project_id: backend.id,
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 195, files: 62 })
    expect((await rowsOf(t, f.org.id)).projects).toEqual(
      [
        { project_id: f.sub.id, name: 'Firmware', bytes: 5, files: 1 },
        { project_id: backend.id, name: 'Backend', bytes: 190, files: 61 },
      ].sort((x, y) => x.project_id.localeCompare(y.project_id)),
    )

    // REST and MCP move through the same core; a task without files moves
    // nothing
    const bare = await plantIssue(t, inFw)
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      keyName: 'drive',
      ref: quiet.id,
      body: JSON.stringify({ project: 'PCB' }),
    })
    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: bare.id,
      project: 'TBED',
      sub_project: 'PCB',
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 195, files: 62 })
    expect((await rowsOf(t, f.org.id)).projects.map((p) => [p.project_id, p.bytes])).toEqual(
      [
        [f.sub2.id, 5],
        [backend.id, 190],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    )
  })

  it("renames the project's row with the project", async () => {
    const { t, f } = await setup()
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await attach(t, f, issue, 3)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { name: 'Firmware 2' },
    })
    expect((await rowsOf(t, f.org.id)).projects).toEqual([
      { project_id: f.sub.id, name: 'Firmware 2', bytes: 3, files: 1 },
    ])
  })
})

describe('Deleted items', () => {
  installTrashTimers()

  /** Runs `item`'s steps one at a time, expecting the totals unchanged
   * after each. */
  async function stepExpecting(t: T, orgId: string, itemId: string, totals: Amount) {
    for (let i = 0; i < 500; i++) {
      expect(await expectTotals(t, orgId)).toEqual(totals)
      const job = await t.run((ctx) =>
        ctx.db
          .query('deleted_item_jobs')
          .withIndex('by_item', (q) => q.eq('item_id', itemId))
          .unique(),
      )
      if (job === null) return
      await trashStep(t, itemId)
    }
    throw new Error('the item did not settle')
  }

  it('keeps every file counted once, where its task counts, through a move to Deleted items and a restore', async () => {
    const { t, f } = await setup()
    const inFw = { org_id: f.org.id, project_id: f.sub.id }
    const root = await plantIssue(t, inFw)
    const kid = await plantIssue(t, { ...inFw, parent_id: root.id })
    const inPcb = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    for (let i = 0; i < 4; i++) {
      await attach(t, f, root, 10)
      await attach(t, f, kid, 1)
      await attach(t, f, inPcb, 100)
    }
    const totals = await expectTotals(t, f.org.id)
    expect(totals).toEqual({ bytes: 444, files: 12 })
    const before = await rowsOf(t, f.org.id)
    // small steps, so each move and restore takes several
    TRASH_BUDGET.rows = 2

    // a task item, with its subtask
    await deleteTask(t, f, root.id, { subtask_ids: [kid.id] })
    const taskItem = await itemFor(t, root.id)
    await stepExpecting(t, f.org.id, taskItem.id, totals)
    expect(await rowsOf(t, f.org.id)).toEqual(before)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [taskItem.id] })
    await stepExpecting(t, f.org.id, taskItem.id, totals)
    expect(await rowsOf(t, f.org.id)).toEqual(before)

    // a project item keeps its row, by name, while it is in Deleted items
    await deleteProject(t, f, f.sub2.id)
    const projectItem = await itemFor(t, f.sub2.id)
    await stepExpecting(t, f.org.id, projectItem.id, totals)
    expect(await rowsOf(t, f.org.id)).toEqual(before)
    await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id: f.org.id,
      ids: [projectItem.id],
    })
    await stepExpecting(t, f.org.id, projectItem.id, totals)
    expect(await rowsOf(t, f.org.id)).toEqual(before)
  })

  it('takes purged files out step by step, and only those already deleted', async () => {
    const { t, f } = await setup()
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const kept = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let i = 1; i <= 6; i++) await attach(t, f, root, i)
    await attach(t, f, kept, 1000)
    await deleteTask(t, f, root.id)
    await runSteps(t)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 1021, files: 7 })
    const item = await itemFor(t, root.id)
    TRASH_BUDGET.rows = 2
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] })
    const seen: number[] = []
    for (let i = 0; i < 100; i++) {
      // what is still stored still counts, whatever the purge has deleted
      const left = await filesOf(t, f.org.id)
      expect((await rowsOf(t, f.org.id)).org).toMatchObject(sum(left))
      seen.push(sum(left).files)
      if ((await t.run((ctx) => ctx.db.get(item._id))) === null) break
      await trashStep(t, item.id)
    }
    expect(seen.at(-1)).toBe(1)
    expect(new Set(seen).size).toBeGreaterThan(2)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 1000, files: 1 })
  })

  it('takes out the live files a stuck item left when its purge deletes them', async () => {
    const { t, f } = await setup()
    const stranded = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const kept = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await attach(t, f, stranded, 40)
    await attach(t, f, stranded, 2, { inline: true })
    await attach(t, f, kept, 1)
    // the move stores the project rows and stops, and its job gives up
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job?.scheduled_id !== undefined) await ctx.scheduler.cancel(job.scheduled_id)
      if (job !== null) await ctx.db.delete(job._id)
      await ctx.db.patch(item._id, { state: 'stuck' })
    })
    expect(await t.run((ctx) => byId(ctx, 'issues', stranded.id))).not.toBeNull()
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 43, files: 3 })
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] })
    await runSteps(t)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 1, files: 1 })
  })

  it('takes out the files of a subtask whose project is gone when a restore deletes it', async () => {
    const { t, f } = await setup()
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const kid = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, parent_id: root.id })
    await attach(t, f, root, 10)
    await attach(t, f, kid, 300)
    await deleteTask(t, f, root.id, { subtask_ids: [kid.id] })
    await runSteps(t)
    const taskItem = await itemFor(t, root.id)
    // the subtask's project goes to Deleted items and for good, and its
    // row still holds the subtask's files, which the task item keeps
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const projectItem = await itemFor(t, f.sub2.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id: f.org.id,
      ids: [projectItem.id],
    })
    await runSteps(t)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 310, files: 2 })
    expect((await rowsOf(t, f.org.id)).projects).toContainEqual({
      project_id: f.sub2.id,
      name: 'Board rev',
      bytes: 300,
      files: 1,
    })
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [taskItem.id] })
    await runSteps(t)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 10, files: 1 })
  })
})

describe('the backfill', () => {
  installTrashTimers()

  it('counts every file once while files are attached, removed and moved between its steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inFw = { org_id: f.org.id, project_id: f.sub.id }
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 6; i++) tasks.push(await plantIssue(t, inFw))
    const [first, second, third, , , last] = tasks
    for (const task of tasks) await plantFile(t, task, 10)
    const firstFile = await plantFile(t, first, 1)
    // one task in Deleted items, its files stored
    await deleteTask(t, f, third.id)
    await runSteps(t)
    COUNT_PAGE.tasks = 1

    // the first step starts the count and counts the first task
    expect(await countStep(t, f.org.id)).toBeNull()
    const started = await rowsOf(t, f.org.id)
    expect(started.org).toMatchObject({ bytes: 11, files: 2, counting: { through: first.num } })
    expect(await t.run((ctx) => storageTotalsOf(ctx, f.org.id))).toBeNull()

    // a task the count has not reached waits for it
    await attach(t, f, last, 500)
    expect(await rowsOf(t, f.org.id)).toEqual(started)
    // a counted one counts at once, its removals too
    await attach(t, f, first, 7)
    await as(t, f.user).mutation(api.files.removeAttachment, {
      org_id: f.org.id,
      id: firstFile.id,
    })
    expect((await rowsOf(t, f.org.id)).org).toMatchObject({ bytes: 17, files: 2 })

    expect(await countStep(t, f.org.id)).toBeNull()
    // a counted task moves its bytes, one not counted yet moves alone
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: second.id,
      project_id: f.sub2.id,
    })
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: last.id,
      project_id: f.sub2.id,
    })
    await attach(t, f, second, 3)
    // a task row the count has not reached, which no writer leaves, written
    // with its project's and organization's totals as a writer writes one:
    // the count replaces it rather than counting the task twice
    await t.run(async (ctx) => {
      const stray = { bytes: 999, files: 3 }
      await ctx.db.insert('storage_task_totals', {
        org_id: f.org.id,
        issue_id: tasks[4].id,
        project_id: f.sub2.id,
        ...stray,
      })
      await addToProject(ctx, f.org.id, f.sub2.id, stray)
      const org = await orgTotalsRow(ctx, f.org.id)
      if (org !== null) await addToOrg(ctx, org, stray)
    })
    expect(await countStorage(t, f.org.id)).toEqual({ bytes: 570, files: 9 })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 570, files: 9 })
    expect(await t.run((ctx) => storageTotalsOf(ctx, f.org.id))).toEqual({ bytes: 570, files: 9 })
    // a counted organization is left as it is
    expect(await countStep(t, f.org.id)).toEqual({ bytes: 570, files: 9 })
  })

  it('reports in a dry run what it would count, the rows that differ and the files whose task is gone, and writes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await plantFile(t, issue, 100)
    await plantFile(t, other, 20)
    await countStorage(t, f.org.id)
    const elsewhere = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await plantFile(t, elsewhere, 7)
    // rows that went out of step, and a live and a stored file whose task
    // is gone
    const gone = { id: uuid(), org_id: f.org.id }
    const orphan = await plantFile(t, gone, 9)
    const storedOrphan = await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('deleted_rows', {
        item_id: uuid(),
        org_id: f.org.id,
        table: 'issue_attachments',
        owner_id: gone.id,
        row_id: id,
        created_ts: Date.now(),
        storage_id: orphan.storage_id,
        row: {
          table: 'issue_attachments',
          doc: {
            org_id: f.org.id,
            id,
            issue_id: gone.id,
            name: 'stored.bin',
            size_bytes: 4,
            storage_id: orphan.storage_id,
            inline: false,
            created_at: NOW,
          },
        },
      })
      const task = await ctx.db
        .query('storage_task_totals')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .unique()
      if (task !== null) await ctx.db.patch(task._id, { bytes: 105 })
      const project = await ctx.db
        .query('storage_project_totals')
        .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
        .unique()
      if (project !== null) await ctx.db.patch(project._id, { bytes: 25 })
      return id
    })
    const before = await t.run(async (ctx) => ({
      org: await ctx.db.query('storage_org_totals').collect(),
      projects: await ctx.db.query('storage_project_totals').collect(),
      tasks: await ctx.db.query('storage_task_totals').collect(),
      audit: await ctx.db.query('platform_audit_log').collect(),
    }))

    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({
      dry_run: true,
      orgs: 2,
      counted: 1,
      bytes: 7,
      files: 1,
      to_count: [{ org_id: f.otherOrg.id, bytes: 7, files: 1 }],
      differing: 1,
      differ: [
        {
          org_id: f.org.id,
          bytes: 120,
          files: 2,
          stored: { bytes: 120, files: 2 },
          projects_differing: 1,
          projects: [
            {
              project_id: f.sub2.id,
              counted: { bytes: 20, files: 1 },
              stored: { bytes: 25, files: 1 },
            },
          ],
          tasks_differing: 1,
          tasks: [
            {
              task_id: issue.id,
              counted: { project_id: f.sub.id, bytes: 100, files: 1 },
              stored: { project_id: f.sub.id, bytes: 105, files: 1 },
            },
          ],
        },
      ],
      unsettled: 0,
      skipped: 0,
      orphan_rows: 2,
      orphan_bytes: 13,
      done: true,
    })
    expect(dry.orphans).toEqual(
      expect.arrayContaining([
        {
          org_id: f.org.id,
          attachment_id: orphan.id,
          task_id: gone.id,
          size_bytes: 9,
          stored: false,
        },
        {
          org_id: f.org.id,
          attachment_id: storedOrphan,
          task_id: gone.id,
          size_bytes: 4,
          stored: true,
        },
      ]),
    )
    expect(
      await t.run(async (ctx) => ({
        org: await ctx.db.query('storage_org_totals').collect(),
        projects: await ctx.db.query('storage_project_totals').collect(),
        tasks: await ctx.db.query('storage_task_totals').collect(),
        audit: await ctx.db.query('platform_audit_log').collect(),
      })),
    ).toEqual(before)

    // a run counts the other organization, a recount mends this one, and
    // neither counts the files whose task is gone
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 1, bytes: 7 })
    expect(await expectTotals(t, f.otherOrg.id)).toEqual({ bytes: 7, files: 1 })
    expect(await backfill(t, { dry_run: false, recount: true })).toMatchObject({
      counted: 2,
      bytes: 127,
      files: 3,
    })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 120, files: 2 })
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      counted: 0,
      differing: 0,
      orphan_rows: 2,
    })
    const audits = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audits.map((row) => row.action)).toEqual([
      'storage_totals_backfill',
      'storage_totals_backfill',
    ])
  })

  it('reads in bounded pages, a task with many files and many tasks alike', async () => {
    const t = newT()
    const f = await withOrg(t)
    const heavy = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let i = 0; i < 30; i++) await plantFile(t, heavy, 1)
    for (let i = 0; i < 12; i++)
      await plantFile(t, await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id }), 2)
    Object.assign(COUNT_PAGE, { tasks: 5, files: 10, orphans: 3, drain: 2 })
    let steps = 0
    for (let got: Amount | 'skipped' | null = null; got === null; steps++) {
      got = await countStep(t, f.org.id)
      if (got === 'skipped') throw new Error('skipped')
    }
    expect(steps).toBeGreaterThan(3)
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 54, files: 42 })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ differing: 0, orphan_rows: 0 })
    // a recount drains in steps of its own before it counts again
    expect(await countStorage(t, f.org.id, true)).toEqual({ bytes: 54, files: 42 })
    expect(await expectTotals(t, f.org.id)).toEqual({ bytes: 54, files: 42 })
  })
})

describe('what never counts', () => {
  it('counts no profile picture or personal background', async () => {
    // the background's preview step stays scheduled, as in appearance.test.ts
    vi.useFakeTimers()
    vi.stubEnv('CONVEX_SITE_URL', 'https://storage-totals.convex.site')
    try {
      const { t, f } = await setup()
      const picture = await storeBlob(t, 2048, 'image/png')
      await as(t, f.user).mutation(api.files.setAvatar, {
        profile_id: f.user.id,
        storage_id: picture,
      })
      const ticket = await as(t, f.user).mutation(api.appearance.createUpload, {
        name: 'Lake.jpg',
      })
      const background = await storeBlob(t, 4096, 'image/jpeg')
      await t.mutation(internal.appearance.finalizeUpload, {
        ticket_id: ticket.ticket_id,
        minter: f.user.auth_user_id as string,
        storage_id: background,
        width: 2400,
        height: 1200,
      })
      expect(await t.run((ctx) => ctx.db.query('custom_backgrounds').collect())).toHaveLength(1)
      expect(await rowsOf(t, f.org.id)).toMatchObject({
        org: { bytes: 0, files: 0 },
        projects: [],
        tasks: [],
      })
      // nor does a count find them
      expect(await countStorage(t, f.org.id, true)).toEqual({ bytes: 0, files: 0 })
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })

  it('starts a new organization counted at zero, and reads one that is not counted as unknown', async () => {
    const t = newT()
    const f = await withOrg(t)
    const orgId = uuid()
    await t.run((ctx) =>
      insertOrgRows(ctx, { id: orgId, name: 'Fresh', slug: 'fresh', ...newOrgDefaults(NOW) }),
    )
    expect(await t.run((ctx) => storageTotalsOf(ctx, orgId))).toEqual({ bytes: 0, files: 0 })
    expect(await t.run((ctx) => storageTotalsOf(ctx, f.org.id))).toBeNull()
  })
})
