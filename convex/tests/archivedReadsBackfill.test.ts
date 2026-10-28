/* internal/archivedReadsBackfill: the one-time repair that marks read the
 * unread messages about tasks archived before the archive paths did. A
 * dry run finds them without writing, a run schedules the archive's own
 * read steps for them, a call stops past RUN.ms inside an organization
 * and the next goes on, and a page that fails ends the call with its
 * error after the audit row. Every case that writes ends with drift()
 * empty. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { PAGE, RUN } from '../internal/archivedReadsBackfill'
import { SUMMARY } from '../model/inboxReads'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  type T,
  withOrg,
} from './helpers.setup'
import { drift, post } from './inboxItems.setup'
import { installTrashTimers, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_PAGE = { ...PAGE }
const DEFAULT_RUN = { ...RUN }
const DEFAULT_SUMMARY = { ...SUMMARY }
afterEach(() => {
  Object.assign(PAGE, DEFAULT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
  Object.assign(SUMMARY, DEFAULT_SUMMARY)
})

type Run = {
  dry_run: boolean
  tasks: number
  scheduled: number
  pages: number
  listed: string[]
  done: boolean
  org_id: string | null
  cursor: string | null
  error?: string
}

const run = (t: T, args: { dry_run: boolean; org_id?: string | null; cursor?: string | null }) =>
  t.action(internal.internal.archivedReadsBackfill.run, args) as Promise<Run>

/* Calls run until it answers done, passing each place back as it came,
 * and answers every call's result. */
async function runAll(t: T, dry_run: boolean): Promise<Run[]> {
  const calls: Run[] = []
  let at: { org_id: string | null; cursor: string | null } = { org_id: null, cursor: null }
  for (let n = 0; n < 200; n++) {
    const got = await run(t, { dry_run, ...at })
    expect(got.error).toBeUndefined()
    calls.push(got)
    if (got.done) return calls
    at = { org_id: got.org_id, cursor: got.cursor }
  }
  throw new Error('the backfill did not finish in 200 calls')
}

const total = (calls: Run[], field: 'tasks' | 'scheduled') =>
  calls.reduce((n, c) => n + c[field], 0)

/* Archives the tasks as a release before c311ec84 did: the task gets its
 * stamp and its messages stay as they were. */
const archiveRaw = (t: T, tasks: readonly Doc<'issues'>[]) =>
  t.run(async (ctx) => {
    for (const task of tasks) await ctx.db.patch(task._id, { archived_at: NOW })
  })

/* The task's messages that are unread, every recipient's. */
const unreadOf = (t: T, task: Doc<'issues'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('messages')
        .withIndex('by_issue_read', (q) => q.eq('issue_id', task.id).eq('read_at', undefined))
        .collect()
    ).map((m) => m.recipient_id),
  )

/* The platform_audit_log rows of this backfill. */
const audits = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_audit_log').collect()).filter(
      (row) => row.action === 'archived_reads_backfill',
    ),
  )

/* Tasks in both organizations: three archived with unread messages, one
 * archived with only read ones, one archived with none, and one active
 * with an unread message. */
async function plant(t: T, f: OrgFixture) {
  const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const [a, b, read, silent, active] = [
    await task(),
    await task(),
    await task(),
    await task(),
    await task(),
  ]
  for (const [i, x] of [a, b, read, active].entries()) {
    await post(t, f, { to: f.guest, task: x, minute: i })
    await post(t, f, { to: f.user, task: x, minute: i })
  }
  for (const to of [f.guest, f.user]) {
    const [row] = (
      await t.run((ctx) =>
        ctx.db
          .query('messages')
          .withIndex('by_recipient_issue', (q) =>
            q.eq('recipient_id', to.id).eq('issue_id', read.id),
          )
          .collect(),
      )
    ).map((m) => m.id)
    await as(t, to).mutation(api.messages.markRead, { org_id: f.org.id, ids: [row] })
  }
  // the other organization's person, who sees its project
  const elsewhere = await plantSeat(t, {
    org_id: f.otherOrg.id,
    auth_user_id: 'auth_elsewhere',
    org_role: 'user',
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.otherProject.id,
      profile_id: elsewhere.id,
      level: 'user',
    }),
  )
  const other = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
  await post(t, { org: f.otherOrg, admin: f.otherAdmin }, { to: elsewhere, task: other, minute: 9 })
  await archiveRaw(t, [a, b, read, silent, other])
  return { a, b, read, silent, active, other }
}

describe('the archived reads backfill', () => {
  it('finds in a dry run the archived tasks that hold unread messages, writing nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const p = await plant(t, f)
    const calls = await runAll(t, true)
    expect(total(calls, 'tasks')).toBe(3)
    expect(total(calls, 'scheduled')).toBe(0)
    expect(calls.flatMap((c) => c.listed).sort()).toEqual([p.a.id, p.b.id, p.other.id].sort())
    expect(await audits(t)).toEqual([])
    expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual([])
    expect(await unreadOf(t, p.a)).toHaveLength(2)
    // the check pages alike
    let at: { org_id?: string | null; cursor?: string | null } = {}
    let found = 0
    for (let n = 0; n < 10; n++) {
      const page = await t.query(internal.internal.archivedReadsBackfill.remaining, at)
      found += page.tasks
      if (page.done) break
      at = { org_id: page.org_id, cursor: page.cursor }
    }
    expect(found).toBe(3)
  })

  it('marks their messages read through the archive’s steps, and a new dry run finds none', async () => {
    const t = newT()
    const f = await withOrg(t)
    const p = await plant(t, f)
    const calls = await runAll(t, false)
    expect(total(calls, 'scheduled')).toBe(3)
    expect(await audits(t)).toEqual([
      expect.objectContaining({
        actor_email: 'system',
        detail: expect.objectContaining({ tasks: 3, scheduled: 3, done: true }),
      }),
    ])
    await runSteps(t)
    for (const task of [p.a, p.b, p.other]) expect(await unreadOf(t, task)).toEqual([])
    // the active task keeps its unread messages, the read one is unchanged
    expect((await unreadOf(t, p.active)).sort()).toEqual([f.guest.id, f.user.id].sort())
    expect(total(await runAll(t, true), 'tasks')).toBe(0)
    expect(await drift(t)).toEqual([])
  })

  it('lets a summary that the old archived items stopped answer complete again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const old: Doc<'issues'>[] = []
    for (let i = 0; i < 60; i++) {
      old.push(await task())
      await post(t, f, { to: f.guest, task: old[i], minute: i })
    }
    await archiveRaw(t, old)
    for (let i = 0; i < 2; i++) await post(t, f, { to: f.guest, task: await task(), minute: 100 })
    Object.assign(SUMMARY, { batch: 4, room: 0.01 })
    const summary = () => as(t, f.guest).query(api.inbox.summary, {})
    expect(await summary()).toMatchObject({ unread_count: 0, complete: false })
    await runAll(t, false)
    await runSteps(t)
    expect(await summary()).toMatchObject({ unread_count: 2, complete: true })
    expect(await drift(t)).toEqual([])
  })

  it('stops past RUN.ms inside an organization, and the next call goes on there', async () => {
    const t = newT()
    const f = await withOrg(t)
    const p = await plant(t, f)
    Object.assign(PAGE, { tasks: 1 })
    Object.assign(RUN, { ms: 0 })
    const calls = await runAll(t, false)
    // one page a call, and at least one stop inside an organization's tasks
    expect(calls.every((c) => c.pages === 1)).toBe(true)
    expect(calls.some((c) => !c.done && c.cursor !== null)).toBe(true)
    expect(total(calls, 'scheduled')).toBe(3)
    expect(await audits(t)).toHaveLength(calls.length)
    await runSteps(t)
    for (const task of [p.a, p.b, p.other]) expect(await unreadOf(t, task)).toEqual([])
    // a cursor goes back with its organization
    await expectRefusal(run(t, { dry_run: true, cursor: calls[0].cursor ?? 'x' }), 'bad_request')
    expect(await drift(t)).toEqual([])
  })

  it('ends a call whose page fails with its error, after the audit row of what committed', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plant(t, f)
    const failed = await run(t, { dry_run: false, org_id: f.org.id, cursor: 'not a cursor' })
    expect(failed).toMatchObject({ done: false, org_id: f.org.id, cursor: 'not a cursor' })
    expect(failed.error).toBeTruthy()
    expect(await audits(t)).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          done: false,
          org_id: f.org.id,
          cursor: 'not a cursor',
          error: failed.error,
        }),
      }),
    ])
  })

  it('leaves the messages of a task restored before its step ran', async () => {
    const t = newT()
    const f = await withOrg(t)
    const p = await plant(t, f)
    await runAll(t, false)
    await t.run((ctx) => ctx.db.patch(p.a._id, { archived_at: undefined }))
    await runSteps(t)
    expect((await unreadOf(t, p.a)).sort()).toEqual([f.guest.id, f.user.id].sort())
    expect(await unreadOf(t, p.b)).toEqual([])
    expect(await drift(t)).toEqual([])
  })
})
