/* internal/attachmentScopeBackfill, the one-time pass that gives older
 * attachment rows their task's organization and project. The fixtures
 * insert that older state directly, as rows without project_id or without
 * both fields. The steps run when the test fires the fake timers. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { SCOPE_PAGE, start } from '../internal/attachmentScopeBackfill'
import { NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const DEFAULT_PAGE = { ...SCOPE_PAGE }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.assign(SCOPE_PAGE, DEFAULT_PAGE)
})

const backfill = internal.internal.attachmentScopeBackfill

/* Runs every scheduled function, and anything they schedule, to completion. */
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

/* A full run from empty arguments. */
async function run(t: T): Promise<void> {
  await t.mutation(backfill.start, {})
  await runSteps(t)
}

const allRows = (t: T) => t.run((ctx) => ctx.db.query('issue_attachments').collect())

const handler = (
  start as unknown as {
    _handler: (ctx: MutationCtx, args: Record<string, unknown>) => Promise<null>
  }
)._handler

/* The documents one step with `args` writes. The steps it schedules are
 * canceled, so only this one runs. */
const stepWrites = (t: T, args: Record<string, unknown>) =>
  t.mutation(async (ctx) => {
    await handler(ctx, args)
    const written = (await ctx.meta.getTransactionMetrics()).documentsWritten.used
    for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
      if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
    }
    return written
  })

/* The arguments of every backfill step scheduled so far. */
const steps = async (t: T): Promise<Record<string, unknown>[]> =>
  (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()))
    .filter((job) => job.name === 'internal/attachmentScopeBackfill:start')
    .map((job) => job.args[0] as Record<string, unknown>)

/* An attachment row of the task `issue_id`, with only the scope fields
 * `scope` gives, as older rows were stored. */
async function plantRow(
  t: T,
  storage_id: Id<'_storage'>,
  issue_id: string,
  scope: { org_id?: string; project_id?: string; task_archived?: true } = {},
): Promise<Doc<'issue_attachments'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('issue_attachments', {
      ...scope,
      id: uuid(),
      issue_id,
      name: 'old.bin',
      size_bytes: 3,
      storage_id,
      inline: false,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'issue_attachments'>
  })
}

/* withOrg with an active and an archived task in FW, a task in PCB and a
 * task in Other, and one stored file the rows share. */
async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const sid = await t.run((ctx) => ctx.storage.store(new Blob(['x']) as never))
  const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const archived = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    archived_at: NOW,
  })
  const board = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
  const elsewhere = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
  return { t, f, sid, active, archived, board, elsewhere }
}

const scopeOf = (row: Doc<'issue_attachments'> | undefined) => ({
  org_id: row?.org_id,
  project_id: row?.project_id,
  task_archived: row?.task_archived,
})

describe('internal/attachmentScopeBackfill', () => {
  it('fills rows from their tasks in every organization and marks the rows of archived tasks', async () => {
    // spied before newT, which takes the console the functions log to
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, f, sid, active, archived, board, elsewhere } = await fixture()
    const noProject = await plantRow(t, sid, active.id, { org_id: f.org.id })
    const noScope = await plantRow(t, sid, active.id)
    // a row naming another organization, marked in that organization's range
    const astray = await plantRow(t, sid, active.id, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      task_archived: true,
    })
    const shelved = await plantRow(t, sid, archived.id)
    const current = await plantRow(t, sid, board.id, { org_id: f.org.id, project_id: f.sub2.id })
    const other = await plantRow(t, sid, elsewhere.id)

    await run(t)

    const rows = new Map((await allRows(t)).map((row) => [row.id, row]))
    const fw = { org_id: f.org.id, project_id: f.sub.id, task_archived: undefined }
    expect(scopeOf(rows.get(noProject.id))).toEqual(fw)
    expect(scopeOf(rows.get(noScope.id))).toEqual(fw)
    // its old mark belonged to the other range, and its task is active
    expect(scopeOf(rows.get(astray.id))).toEqual(fw)
    // the archived task's row joins the organization's range, then is marked
    expect(scopeOf(rows.get(shelved.id))).toEqual({ ...fw, task_archived: true })
    expect(scopeOf(rows.get(current.id))).toEqual({
      org_id: f.org.id,
      project_id: f.sub2.id,
      task_archived: undefined,
    })
    expect(scopeOf(rows.get(other.id))).toEqual({
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      task_archived: undefined,
    })
    const flagged = await t.run(async (ctx) => ({
      archived: (await ctx.db.get(archived._id))?.relations_marked,
      active: (await ctx.db.get(active._id))?.relations_marked,
    }))
    expect(flagged).toEqual({ archived: true, active: undefined })

    expect(warn).toHaveBeenCalledWith('Attachment scope backfill corrected an organization', {
      id: astray.id,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    const done = info.mock.calls.filter(([message]) => message === 'Attachment scope backfill done')
    expect(done).toEqual([['Attachment scope backfill done', { rows: 6, filled: 5, orphans: 0 }]])
  })

  it('pages through the rows, fills those with a task and leaves orphans alone', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, f, sid } = await fixture()
    const more: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      more.push(await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id }))
    }
    for (const task of more) await plantRow(t, sid, task.id)
    // rows whose task was deleted without them, with and without a scope
    const orphans = [
      await plantRow(t, sid, uuid()),
      await plantRow(t, sid, uuid(), { org_id: f.org.id, project_id: f.sub.id }),
    ]
    // a task whose organization is gone
    const unowned = await plantIssue(t, { org_id: uuid(), project_id: f.sub.id })
    const adrift = await plantRow(t, sid, unowned.id)
    SCOPE_PAGE.rows = 2

    await run(t)

    const rows = new Map((await allRows(t)).map((row) => [row.id, row]))
    for (const task of more) {
      const row = [...rows.values()].find((r) => r.issue_id === task.id)
      expect(scopeOf(row)).toEqual({
        org_id: f.org.id,
        project_id: f.sub2.id,
        task_archived: undefined,
      })
    }
    expect(scopeOf(rows.get(adrift.id))).toEqual({
      org_id: unowned.org_id,
      project_id: f.sub.id,
      task_archived: undefined,
    })
    for (const orphan of orphans) {
      expect(rows.get(orphan.id)).toEqual(orphan)
      expect(warn).toHaveBeenCalledWith('Attachment scope backfill found a row without a task', {
        id: orphan.id,
      })
    }
    // 6 rows at 2 a step, the run's first one and two it scheduled
    expect(await steps(t)).toHaveLength(2)
    const done = info.mock.calls.filter(([message]) => message === 'Attachment scope backfill done')
    expect(done).toEqual([['Attachment scope backfill done', { rows: 6, filled: 4, orphans: 2 }]])
  })

  it('reads and writes at most one page of rows a step, and finishes a task with more rows across steps', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { t, f, sid, active, board } = await fixture()
    for (let i = 0; i < 5; i++) await plantRow(t, sid, active.id)
    await plantRow(t, sid, board.id)
    SCOPE_PAGE.rows = 2

    expect(await stepWrites(t, {})).toBe(2)

    await run(t)
    for (const row of await allRows(t)) {
      expect(scopeOf(row)).toEqual({
        org_id: f.org.id,
        project_id: row.issue_id === board.id ? f.sub2.id : f.sub.id,
        task_archived: undefined,
      })
    }
    const done = info.mock.calls.filter(([message]) => message === 'Attachment scope backfill done')
    // the step above filled two of them
    expect(done).toEqual([['Attachment scope backfill done', { rows: 6, filled: 4, orphans: 0 }]])
  })

  it('stops before a task past the task byte budget and starts the next step at it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { t, sid, active, archived, board, elsewhere } = await fixture()
    for (const task of [active, active, archived, board, elsewhere]) await plantRow(t, sid, task.id)
    // one task passes a 1-byte budget, so each step reads one task and its rows
    SCOPE_PAGE.taskBytes = 1

    await run(t)

    for (const row of await allRows(t)) expect(row.project_id).toBeDefined()
    // after the run's first step, one step starts at each of the other tasks
    const started = (await steps(t)).map((args) => args.from)
    expect(started).toHaveLength(3)
    expect(new Set(started).size).toBe(3)
    expect(started).not.toContain(undefined)
    const done = info.mock.calls.filter(([message]) => message === 'Attachment scope backfill done')
    expect(done).toEqual([['Attachment scope backfill done', { rows: 5, filled: 5, orphans: 0 }]])
  })

  it('writes nothing for a row that matches its task, so a second run changes nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { t, f, sid, active, board, elsewhere } = await fixture()
    await plantRow(t, sid, active.id)
    await plantRow(t, sid, board.id, { org_id: f.org.id, project_id: f.sub2.id })
    await plantRow(t, sid, elsewhere.id, { org_id: f.otherOrg.id })

    // the first step fills the two rows that differ, and a step over the
    // same rows again writes no document
    expect(await stepWrites(t, {})).toBe(2)
    expect(await stepWrites(t, {})).toBe(0)
    info.mockClear()

    await plantRow(t, sid, board.id)
    await run(t)
    const before = await allRows(t)
    await run(t)
    expect(await allRows(t)).toEqual(before)
    const done = info.mock.calls.filter(([message]) => message === 'Attachment scope backfill done')
    expect(done).toEqual([
      ['Attachment scope backfill done', { rows: 4, filled: 1, orphans: 0 }],
      ['Attachment scope backfill done', { rows: 4, filled: 0, orphans: 0 }],
    ])
  })
})
