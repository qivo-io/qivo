/* Archiving makes a task's inbox messages read (model/messages.ts, "archived
 * tasks"). News about an archived task, or one in an archived project, is
 * stored read, and every archive path schedules background steps that mark
 * what was stored before read for every recipient and prune each item to its
 * newest message. The steps run when the test fires the fake timers, so each
 * case can look before and after them. While the archive stands, mark
 * unread and snooze refuse the task in the app, over REST and over MCP, and
 * mark read and remove still work. Deleting a task or a project deletes its
 * messages. */
/// <reference types="vite/client" />

import type { FunctionArgs } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal, RefusalCode } from '../lib/functions'
import { sha256hex } from '../machine/auth'
import {
  allMessages,
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type Patch = FunctionArgs<typeof api.issues.update>['patch']

/* Every case drives the scheduler itself, so none may await real time. */
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/* Runs every scheduled function, and anything they schedule, to completion,
 * later ones such as a snooze's wake included. */
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

/* Moves the frozen clock on without firing a timer, so the next mutation
 * stamps a later instant. */
const later = () => vi.setSystemTime(Date.now() + 1000)

const subscribe = (t: T, who: Doc<'profiles'>, issueId: string) =>
  as(t, who).mutation(api.issues.subscribe, { org_id: who.org_id, issue_id: issueId })

const update = (t: T, actor: Doc<'profiles'>, id: string, patch: Patch) =>
  as(t, actor).mutation(api.issues.update, { org_id: actor.org_id, id, patch })

const archive = (t: T, actor: Doc<'profiles'>, id: string, reason?: string) =>
  as(t, actor).mutation(api.issues.archive, { org_id: actor.org_id, id, reason })

/* What a recipient's item about one task holds, oldest first. */
const item = async (t: T, who: Doc<'profiles'>, issueId: string) =>
  (await messagesFor(t, who.id, issueId)).map((m) => ({
    detail: m.detail,
    read: m.read_at !== undefined,
  }))

/* Three changes by `user`, a second apart, reach every follower unread. */
async function threeChanges(t: T, f: OrgFixture, issueId: string): Promise<void> {
  for (const patch of [
    { priority: 'high' },
    { status: 'progress' },
    { title: 'Renamed' },
  ] as Patch[]) {
    await update(t, f.user, issueId, patch)
    later()
  }
}

/* The agent reads and writes the Testbed tree, like a Standard user agent
 * with a grant. */
const grantAgent = (t: T, f: OrgFixture) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )

describe('archiving a task', () => {
  it('stores the Archived notice read, then marks every recipient read and keeps each item to its newest message', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const who of [f.admin, f.guest]) await subscribe(t, who, task.id)
    await subscribe(t, f.admin, other.id)
    await threeChanges(t, f, task.id)
    await update(t, f.user, other.id, { priority: 'high' })
    later()

    await archive(t, f.user, task.id)

    // the steps have not run, so the earlier messages wait unread; the notice
    // arrived read
    for (const who of [f.admin, f.guest]) {
      expect(await item(t, who, task.id)).toEqual([
        { detail: 'Priority: Medium → High', read: false },
        { detail: 'Status: To Do → In Progress', read: false },
        { detail: 'Title: “Planted task” → “Renamed”', read: false },
        { detail: 'Archived', read: true },
      ])
    }

    await runSteps(t)

    for (const who of [f.admin, f.guest]) {
      expect(await item(t, who, task.id)).toEqual([{ detail: 'Archived', read: true }])
    }
    // another task's item is untouched
    expect(await item(t, f.admin, other.id)).toEqual([
      { detail: 'Priority: Medium → High', read: false },
    ])
  })

  it('stores the archive reason read and reaches every subtask', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      parent_id: parent.id,
    })
    const sibling = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    for (const id of [parent.id, child.id, sibling.id]) await subscribe(t, f.guest, id)
    await threeChanges(t, f, sibling.id)
    await update(t, f.user, child.id, { priority: 'high' })
    later()

    await archive(t, f.user, parent.id, 'Superseded')
    expect((await item(t, f.guest, parent.id)).every((m) => m.read)).toBe(true)
    expect((await item(t, f.guest, sibling.id)).some((m) => !m.read)).toBe(true)

    await runSteps(t)

    // one read row per item. The subtree's echoes stay silent, so each keeps
    // its own newest message.
    expect(await item(t, f.guest, child.id)).toEqual([
      { detail: 'Priority: Medium → High', read: true },
    ])
    expect(await item(t, f.guest, sibling.id)).toEqual([
      { detail: 'Title: “Planted task” → “Renamed”', read: true },
    ])
    const root = await item(t, f.guest, parent.id)
    expect(root).toHaveLength(1)
    expect(root[0].read).toBe(true)
  })

  it('the machine toggle (update_task archived) reaches the subtree too', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grantAgent(t, f)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    await subscribe(t, f.guest, child.id)
    await threeChanges(t, f, child.id)

    await t.mutation(internal.machine.mcp.updateIssue, {
      callerId: f.agent.id,
      access: 'write',
      ref: `QN-${parent.num}`,
      archived: true,
    })
    await runSteps(t)

    expect(await item(t, f.guest, child.id)).toEqual([
      { detail: 'Title: “Planted task” → “Renamed”', read: true },
    ])
  })

  it('a restore before the step runs keeps the messages unread; the Restored notice arrives unread', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, task.id)
    await update(t, f.user, task.id, { priority: 'high' })
    later()
    await archive(t, f.user, task.id)
    later()
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: task.id })

    await runSteps(t)

    // the read Archived notice made way for the newer Restored one (the prune)
    expect(await item(t, f.guest, task.id)).toEqual([
      { detail: 'Priority: Medium → High', read: false },
      { detail: 'Restored', read: false },
    ])
  })

  it('after the step, a restore brings only the Restored notice unread', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, task.id)
    await update(t, f.user, task.id, { priority: 'high' })
    later()
    await archive(t, f.user, task.id)
    await runSteps(t)
    later()

    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: task.id })

    expect(await item(t, f.guest, task.id)).toEqual([{ detail: 'Restored', read: false }])
  })

  it('a snoozed item becomes read and loses its snooze, and its scheduled wake finds nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.admin, task.id)
    await threeChanges(t, f, task.id)
    const ids = (await messagesFor(t, f.admin.id, task.id)).map((m) => m.id)
    const until = new Date(Date.now() + 3_600_000).toISOString()
    await as(t, f.admin).mutation(api.messages.snooze, { org_id: f.org.id, ids, until })
    // the follower archives it, so no Archived notice reaches their item
    await archive(t, f.admin, task.id)
    expect(
      (await messagesFor(t, f.admin.id, task.id)).every((m) => m.snoozed_until === until),
    ).toBe(true)

    // the step is due now; the wake an hour later runs after it
    vi.advanceTimersByTime(0)
    await t.finishInProgressScheduledFunctions()
    await runSteps(t)

    const rows = await messagesFor(t, f.admin.id, task.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ detail: 'Title: “Planted task” → “Renamed”' })
    expect(rows[0].read_at).toBeDefined()
    expect(rows[0].snoozed_until).toBeUndefined()
    expect(rows[0].woke_at).toBeUndefined()
  })
  it('a snooze set on the item of an archived task wakes it read, not unread', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: 'x' })
    const until = '2026-01-05T00:00:00.000Z'
    // snoozed before the archive step reached it: unread rows and one read
    const base = { org_id: f.org.id, recipient_id: f.admin.id, issue_id: task.id }
    await plantMessage(t, {
      ...base,
      detail: 'older',
      created_at: '2026-01-01T00:00:00.000Z',
      read_at: '2026-01-02T00:00:00.000Z',
      snoozed_until: until,
    })
    for (const n of [2, 3]) {
      await plantMessage(t, {
        ...base,
        detail: `unread ${n}`,
        created_at: `2026-01-0${n}T00:00:00.000Z`,
        snoozed_until: until,
      })
    }

    await t.mutation(internal.messages.wake, {
      recipient_id: f.admin.id,
      issue_id: task.id,
      until,
    })

    // read and pruned to the newest, like a mark read; no snooze, no wake
    const rows = await messagesFor(t, f.admin.id, task.id)
    expect(rows.map((row) => row.detail)).toEqual(['unread 3'])
    expect(rows[0].read_at).toBeDefined()
    expect(rows[0].snoozed_until).toBeUndefined()
    expect(rows[0].woke_at).toBeUndefined()
  })
})

describe('arrivals about archived tasks', () => {
  it('a comment, a mention and an edit about an archived task or one in an archived project arrive read', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const shelved = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    for (const id of [archived.id, shelved.id]) await subscribe(t, f.guest, id)
    await archive(t, f.user, archived.id)
    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: f.sub2.id })
    await runSteps(t)
    later()

    await as(t, f.user).mutation(api.comments.create, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: archived.id,
      body: `Still relevant, @[admin](user:${f.admin.id})`,
    })
    await update(t, f.user, shelved.id, { priority: 'high' })

    expect(await item(t, f.guest, archived.id)).toEqual([{ detail: 'New comment', read: true }])
    expect(await item(t, f.admin, archived.id)).toEqual([
      { detail: 'Mentioned you in a comment', read: true },
    ])
    expect(await item(t, f.guest, shelved.id)).toEqual([
      { detail: 'Priority: Medium → High', read: true },
    ])
    // the same edit on an active task still arrives unread
    const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, active.id)
    await update(t, f.user, active.id, { priority: 'high' })
    expect(await item(t, f.guest, active.id)).toEqual([
      { detail: 'Priority: Medium → High', read: false },
    ])
  })
})

describe('the nightly archive and archiving a project', () => {
  it('the nightly sweep posts nothing and marks the messages about the tasks it archives read', async () => {
    const t = newT()
    const f = await withOrg(t)
    const done = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    })
    // a follower, so a notice from the sweep would land here
    await plantSubscription(t, { issue_id: done.id, profile_id: f.guest.id })
    const base = { org_id: f.org.id, recipient_id: f.guest.id, issue_id: done.id }
    await plantMessage(t, { ...base, detail: 'older', created_at: '2026-01-02T00:00:00.000Z' })
    await plantMessage(t, { ...base, detail: 'newest', created_at: '2026-01-03T00:00:00.000Z' })

    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)

    const row = await t.run((ctx) => ctx.db.get(done._id))
    expect(row?.archived_at).toBeDefined()
    expect(await item(t, f.guest, done.id)).toEqual([{ detail: 'newest', read: true }])
    expect(await allMessages(t)).toHaveLength(1)
  })

  it('archiving a project reaches the active tasks of every sub-project it carries; a restore before the step keeps them unread', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inSub = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const inSub2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const outside = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    for (const issue of [inSub, inSub2, outside]) {
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: issue.id })
    }
    const meta = { org_id: f.org.id, id: f.meta.id }

    // after a quick restore the steps find the projects active and leave them
    await as(t, f.user).mutation(api.projects.archive, meta)
    await as(t, f.user).mutation(api.projects.unarchive, meta)
    await runSteps(t)
    for (const issue of [inSub, inSub2]) {
      expect(await item(t, f.admin, issue.id)).toEqual([{ detail: 'planted', read: false }])
    }

    await as(t, f.user).mutation(api.projects.archive, meta)
    await runSteps(t)

    for (const issue of [inSub, inSub2]) {
      expect(await item(t, f.admin, issue.id)).toEqual([{ detail: 'planted', read: true }])
      // the tasks themselves are untouched
      expect((await t.run((ctx) => ctx.db.get(issue._id)))?.archived_at).toBeUndefined()
    }
    expect(await item(t, f.admin, outside.id)).toEqual([{ detail: 'planted', read: false }])
  })
})

describe('the background steps', () => {
  it('continue across steps with a lowered batch and change nothing when run again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: 'x' })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: 'x' })
    const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`
    for (let n = 1; n <= 5; n++) {
      await plantMessage(t, {
        org_id: f.org.id,
        recipient_id: f.admin.id,
        issue_id: a.id,
        detail: `a${n}`,
        created_at: at(n),
      })
    }
    const bBase = { org_id: f.org.id, recipient_id: f.guest.id, issue_id: b.id }
    await plantMessage(t, { ...bBase, detail: 'b1', created_at: at(1) })
    await plantMessage(t, { ...bBase, detail: 'b2', created_at: at(2), snoozed_until: at(9) })
    await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.guest.id,
      issue_id: active.id,
      detail: 'active',
    })

    const issues = [a.id, active.id, b.id]
    await t.mutation(internal.messages.readArchivedTasks, { issues, batch: 2 })

    // two of a's five rows were marked; a's newest is still unread, so the
    // prune dropped both, and the next step continues at a
    expect(await item(t, f.admin, a.id)).toEqual([
      { detail: 'a3', read: false },
      { detail: 'a4', read: false },
      { detail: 'a5', read: false },
    ])
    const pending = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(pending.map((job) => [job.name, job.args[0]])).toEqual([
      ['messages:readArchivedTasks', { issues, batch: 2 }],
    ])

    await runSteps(t)

    const steps = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(steps).toHaveLength(3) // rows a3+a4, a5+b1, b2
    expect(await item(t, f.admin, a.id)).toEqual([{ detail: 'a5', read: true }])
    const bRows = await messagesFor(t, f.guest.id, b.id)
    expect(bRows.map((m) => [m.detail, m.read_at !== undefined, m.snoozed_until])).toEqual([
      ['b2', true, undefined],
    ])
    expect(await item(t, f.guest, active.id)).toEqual([{ detail: 'active', read: false }])

    const before = await allMessages(t)
    await t.mutation(internal.messages.readArchivedTasks, { issues })
    await runSteps(t)
    expect(await allMessages(t)).toEqual(before)
  })

  it('mark only the rows that need a change when hundreds of followers already read the task', async () => {
    // One read row per follower stays after the prune. The step selects the
    // unread rows by index instead of scanning these (convex-test counts only
    // returned rows, so the scan itself cannot be measured here).
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: 'x' })
    await t.run(async (ctx) => {
      for (let n = 0; n < 300; n++) {
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: f.org.id,
          recipient_id: uuid(),
          issue_id: task.id,
          issue_title: 'Planted task',
          kind: 'change',
          detail: `read ${n}`,
          created_at: '2026-01-01T00:00:00.000Z',
          read_at: '2026-01-02T00:00:00.000Z',
        })
      }
    })
    const base = { org_id: f.org.id, recipient_id: f.admin.id, issue_id: task.id }
    await plantMessage(t, { ...base, detail: 'u1', created_at: '2026-01-03T00:00:00.000Z' })
    await plantMessage(t, { ...base, detail: 'u2', created_at: '2026-01-04T00:00:00.000Z' })

    await t.mutation(internal.messages.readArchivedTasks, { issues: [task.id] })

    expect(await item(t, f.admin, task.id)).toEqual([{ detail: 'u2', read: true }])
    const others = (await allMessages(t)).filter((m) => m.recipient_id !== f.admin.id)
    expect(others).toHaveLength(300)
    expect(others.every((m) => m.read_at === '2026-01-02T00:00:00.000Z')).toBe(true)
  })

  it('release a read snoozed row even when the unread rows fill the batch exactly', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: 'x' })
    for (let n = 1; n <= 2; n++) {
      await plantMessage(t, {
        org_id: f.org.id,
        recipient_id: f.admin.id,
        issue_id: task.id,
        detail: `u${n}`,
        created_at: `2026-01-0${n}T00:00:00.000Z`,
      })
    }
    // read through a named action after a snooze, so it kept the snooze
    await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.guest.id,
      issue_id: task.id,
      detail: 'kept snooze',
      read_at: '2026-01-02T00:00:00.000Z',
      snoozed_until: '2026-02-01T00:00:00.000Z',
    })

    await t.mutation(internal.messages.readArchivedTasks, { issues: [task.id], batch: 2 })
    await runSteps(t)

    const [kept] = await messagesFor(t, f.guest.id, task.id)
    expect(kept.snoozed_until).toBeUndefined()
    expect(kept.read_at).toBe('2026-01-02T00:00:00.000Z')
    expect(await item(t, f.admin, task.id)).toEqual([{ detail: 'u2', read: true }])
  })

  it('walk an archived project from where the last step stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = []
    for (let n = 0; n < 3; n++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: task.id })
      tasks.push(task)
    }
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: 'x' }))

    await t.mutation(internal.messages.readArchivedProject, { project_id: f.sub.id, batch: 1 })

    expect(await item(t, f.admin, tasks[0].id)).toEqual([{ detail: 'planted', read: true }])
    expect(await item(t, f.admin, tasks[1].id)).toEqual([{ detail: 'planted', read: false }])
    // the budget ran out inside the page, so the next step reads it again
    const [next] = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(next.args[0]).toEqual({ project_id: f.sub.id, batch: 1 })

    await runSteps(t)
    for (const task of tasks) {
      expect(await item(t, f.admin, task.id)).toEqual([{ detail: 'planted', read: true }])
    }
  })

  it('continue past a task deleted between steps without skipping another', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < 3; n++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: task.id })
      tasks.push(task)
    }
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: 'x' }))

    await t.mutation(internal.messages.readArchivedProject, { project_id: f.sub.id, tasks: 2 })
    await t.run((ctx) => ctx.db.delete(tasks[1]._id))
    await runSteps(t)

    expect(await item(t, f.admin, tasks[0].id)).toEqual([{ detail: 'planted', read: true }])
    expect(await item(t, f.admin, tasks[2].id)).toEqual([{ detail: 'planted', read: true }])
  })

  it('stop a project walk after `tasks` tasks, also when none of them holds a row to mark', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = []
    for (let n = 0; n < 3; n++) {
      tasks.push(await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }))
    }
    // only the last task holds a message, so the row budget never stops the
    // first step
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.admin.id, issue_id: tasks[2].id })
    await t.run((ctx) => ctx.db.patch(f.sub._id, { archived_at: 'x' }))

    await t.mutation(internal.messages.readArchivedProject, { project_id: f.sub.id, tasks: 2 })

    expect(await item(t, f.admin, tasks[2].id)).toEqual([{ detail: 'planted', read: false }])
    const [next] = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(next.args[0]).toEqual({
      project_id: f.sub.id,
      cursor: expect.any(String),
      tasks: 2,
    })

    await runSteps(t)
    expect(await item(t, f.admin, tasks[2].id)).toEqual([{ detail: 'planted', read: true }])
  })
})

describe('the machine inbox', () => {
  it('lists the active tasks it listed before, unread as before, once an archived task is marked read', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grantAgent(t, f)
    const kept = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const gone = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const id of [kept.id, gone.id]) {
      await t.mutation(internal.machine.discussion.mcpSetFollowing, {
        callerId: f.agent.id,
        access: 'write',
        ref: id,
        following: true,
      })
      await update(t, f.user, id, { priority: 'high' })
    }
    later()
    const list = async () =>
      JSON.parse(
        await t.query(internal.machine.discussion.mcpListInbox, {
          callerId: f.agent.id,
          access: 'read',
        }),
      ) as { items: { task: { id: string }; unread_count: number }[]; truncated: boolean }
    const before = await list()

    await archive(t, f.user, gone.id)
    await runSteps(t)

    expect(await list()).toEqual({
      items: before.items.filter((i) => i.task.id === kept.id),
      truncated: false,
    })
    expect((await list()).items).toMatchObject([{ task: { id: kept.id }, unread_count: 1 }])
    expect(await item(t, f.agent, gone.id)).toEqual([{ detail: 'Archived', read: true }])
  })
})

describe('deleting', () => {
  it('a task or a project deletes its messages, archived or not', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const inSub2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const kept = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const issue of [task, inSub2, kept]) {
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.guest.id, issue_id: issue.id })
    }
    await archive(t, f.user, task.id)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.sub2.id })
    await runSteps(t)
    expect(await messagesFor(t, f.guest.id, task.id)).toHaveLength(1)

    await as(t, f.user).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: task.id })
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub2.id })

    expect(await messagesFor(t, f.guest.id, task.id)).toEqual([])
    expect(await messagesFor(t, f.guest.id, inSub2.id)).toEqual([])
    expect(await item(t, f.guest, kept.id)).toEqual([{ detail: 'planted', read: false }])
  })
})

/* ------------------------------------------------------------ inbox writes */

type InboxAction = 'read' | 'unread' | 'remove' | 'snooze'
type InboxBody = { tasks: string[]; until?: string | null }

const keyOf = (task: Doc<'issues'>) => `QN-${task.num}`

/* update_inbox for the agent, answering the parsed result. */
const viaMcp = async (t: T, f: OrgFixture, action: InboxAction, body: InboxBody) =>
  JSON.parse(
    await t.mutation(internal.machine.discussion.mcpUpdateInbox, {
      callerId: f.agent.id,
      access: 'write',
      action,
      ...body,
    }),
  ) as { action: string; tasks: string[]; has_more: boolean }

/* Each POST /v1/inbox/{action} route's internal function. */
const REST_INBOX = {
  read: internal.machine.discussion.restReadInbox,
  unread: internal.machine.discussion.restUnreadInbox,
  remove: internal.machine.discussion.restRemoveInbox,
  snooze: internal.machine.discussion.restSnoozeInbox,
}

/* POST /v1/inbox/{action} for the agent. */
const viaRest = (t: T, f: OrgFixture, action: InboxAction, body: InboxBody) =>
  t.mutation(REST_INBOX[action], {
    callerId: f.agent.id,
    access: 'write',
    body: JSON.stringify(body),
  })

/* The app's own inbox writes for `who`, on message ids. */
const viaApp = (
  t: T,
  who: Doc<'profiles'>,
  action: InboxAction,
  ids: string[],
  until?: string | null,
) => {
  const args = { org_id: who.org_id, ids }
  const app = as(t, who)
  if (action === 'read') return app.mutation(api.messages.markRead, args)
  if (action === 'unread') return app.mutation(api.messages.markUnread, args)
  if (action === 'remove') return app.mutation(api.messages.remove, args)
  return app.mutation(api.messages.snooze, { ...args, until: until ?? null })
}

/* Asserts a refusal with exactly this code and sentence. */
async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())

/* A snooze an hour ahead of the frozen clock. */
const anHourAhead = () => new Date(Date.now() + 3_600_000).toISOString()

/* The rule sentences, as the model writes them. */
const isArchived = (task: Doc<'issues'>) => `${keyOf(task)} is archived and must be restored first`
const inArchivedProject = (task: Doc<'issues'>) =>
  `${keyOf(task)} is in an archived project, which must be restored first`
const bothArchived = (task: Doc<'issues'>) =>
  `${keyOf(task)} and its project are archived and must be restored first`

/* withOrg with the agent on TBED, an active and an archived task in FW, and
 * PCB archived with one active and one archived task in it. The agent and
 * the guest hold one message about each task, as `row` plants it. */
async function archivedInbox(t: T, row: { read_at?: string; snoozed_until?: string }) {
  const f = await withOrg(t)
  await grantAgent(t, f)
  const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const archived = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
  const shelved = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
  const both = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: NOW })
  await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
  const rows = new Map<string, Doc<'messages'>>()
  for (const who of [f.agent, f.guest]) {
    for (const task of [active, archived, shelved, both]) {
      const m = await plantMessage(t, {
        org_id: f.org.id,
        recipient_id: who.id,
        issue_id: task.id,
        ...row,
      })
      rows.set(`${who.id}:${task.id}`, m)
    }
  }
  /* the id of `who`'s message about `task` */
  const idOf = (who: Doc<'profiles'>, task: Doc<'issues'>) =>
    rows.get(`${who.id}:${task.id}`)?.id ?? ''
  return { f, active, archived, shelved, both, idOf }
}

describe('inbox writes on an archived task', () => {
  it('unread and snooze, dated or null, refuse an archived task or one in an archived project on every surface, and change nothing', async () => {
    const t = newT()
    // read rows that kept a snooze, so mark unread, a new snooze and an
    // early end would each change them
    const fx = await archivedInbox(t, { read_at: NOW, snoozed_until: '2099-01-01T00:00:00.000Z' })
    const { f } = fx
    const before = await allMessages(t)
    const until = anHourAhead()
    for (const [task, sentence] of [
      [fx.archived, isArchived(fx.archived)],
      [fx.shelved, inArchivedProject(fx.shelved)],
      [fx.both, bothArchived(fx.both)],
    ] as const) {
      for (const [action, body] of [
        ['unread', {}],
        ['snooze', { until }],
        ['snooze', { until: null }],
      ] as const) {
        const tasks = [keyOf(task)]
        await refused(viaMcp(t, f, action, { tasks, ...body }), 'rule', sentence)
        await refused(viaRest(t, f, action, { tasks, ...body }), 'rule', sentence)
        const ids = [fx.idOf(f.guest, task)]
        const appUntil = 'until' in body ? body.until : undefined
        await refused(viaApp(t, f.guest, action, ids, appUntil), 'rule', sentence)
      }
    }
    expect(await allMessages(t)).toEqual(before)
    // no wake was scheduled either
    expect(await scheduled(t)).toEqual([])
  })

  it('REST answers the refusal as a 400 with the sentence', async () => {
    const t = newT()
    const fx = await archivedInbox(t, { read_at: NOW })
    const secret = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
    const key_hash = await sha256hex(secret)
    await t.run((ctx) =>
      ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: fx.f.agent.id,
        name: 'Inbox key',
        key_prefix: secret.slice(0, 11),
        key_hash,
        created_at: NOW,
      }),
    )
    const res = await (
      t as unknown as {
        fetch(
          path: string,
          init: { method: string; headers: Record<string, string>; body: string },
        ): Promise<{ status: number; text(): Promise<string> }>
      }
    ).fetch('/v1/inbox/unread', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [keyOf(fx.archived)] }),
    })
    expect({ status: res.status, body: JSON.parse(await res.text()) }).toEqual({
      status: 400,
      body: { error: isArchived(fx.archived) },
    })
  })

  it('read and remove still work there, so the item can be cleaned up', async () => {
    const t = newT()
    // unread rows stored before archiving marked them read
    const fx = await archivedInbox(t, {})
    const { f } = fx
    const tasks = [keyOf(fx.archived), keyOf(fx.shelved)]

    expect(await viaMcp(t, f, 'read', { tasks })).toEqual({
      action: 'read',
      tasks,
      has_more: false,
    })
    for (const task of [fx.archived, fx.shelved]) {
      expect(await item(t, f.agent, task.id)).toEqual([{ detail: 'planted', read: true }])
    }
    expect(await viaRest(t, f, 'remove', { tasks })).toEqual({
      action: 'remove',
      tasks,
      has_more: false,
    })
    for (const task of [fx.archived, fx.shelved]) {
      expect(await messagesFor(t, f.agent.id, task.id)).toEqual([])
    }

    const ids = [fx.idOf(f.guest, fx.archived), fx.idOf(f.guest, fx.both)]
    await viaApp(t, f.guest, 'read', ids)
    for (const task of [fx.archived, fx.both]) {
      expect(await item(t, f.guest, task.id)).toEqual([{ detail: 'planted', read: true }])
    }
    await viaApp(t, f.guest, 'remove', ids)
    for (const task of [fx.archived, fx.both]) {
      expect(await messagesFor(t, f.guest.id, task.id)).toEqual([])
    }
  })

  it('one archived task among several refuses the whole request, also when it holds no message', async () => {
    const t = newT()
    const fx = await archivedInbox(t, { read_at: NOW })
    const { f } = fx
    const before = await allMessages(t)
    const active = keyOf(fx.active)

    await refused(
      viaMcp(t, f, 'unread', { tasks: [active, keyOf(fx.archived)] }),
      'rule',
      isArchived(fx.archived),
    )
    await refused(
      viaRest(t, f, 'snooze', { tasks: [active, keyOf(fx.shelved)], until: anHourAhead() }),
      'rule',
      inArchivedProject(fx.shelved),
    )
    await refused(
      viaApp(t, f.guest, 'unread', [fx.idOf(f.guest, fx.active), fx.idOf(f.guest, fx.archived)]),
      'rule',
      isArchived(fx.archived),
    )
    // an archived task the agent holds no message about refuses too
    const quiet = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
    await refused(
      viaMcp(t, f, 'snooze', { tasks: [active, keyOf(quiet)], until: null }),
      'rule',
      isArchived(quiet),
    )
    expect(await allMessages(t)).toEqual(before)
    expect(await scheduled(t)).toEqual([])

    // the active task alone goes through
    expect(await viaMcp(t, f, 'unread', { tasks: [active] })).toEqual({
      action: 'unread',
      tasks: [active],
      has_more: false,
    })
    expect(await item(t, f.agent, fx.active.id)).toEqual([{ detail: 'planted', read: false }])
  })

  it('a hidden archived task answers like an unknown one, before any archived task is refused', async () => {
    const t = newT()
    const fx = await archivedInbox(t, { read_at: NOW })
    const { f } = fx
    // SKNK, which neither the agent nor the guest can see
    const hidden = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      archived_at: NOW,
    })
    const hiddenRows = []
    for (const who of [f.agent, f.guest]) {
      hiddenRows.push(
        await plantMessage(t, {
          org_id: f.org.id,
          recipient_id: who.id,
          issue_id: hidden.id,
          read_at: NOW,
        }),
      )
    }
    const before = await allMessages(t)

    for (const ref of [keyOf(hidden), 'QN-999999']) {
      // the visible archived task comes first and is still not the one named
      const tasks = [keyOf(fx.archived), ref]
      for (const [action, body] of [
        ['unread', {}],
        ['snooze', { until: null }],
      ] as const) {
        await refused(
          viaMcp(t, f, action, { tasks, ...body }),
          'not_found',
          `task "${ref}" not found (or not visible to you)`,
        )
        await refused(
          viaRest(t, f, action, { tasks, ...body }),
          'bad_request',
          'tasks must name tasks by key, number or uuid',
        )
      }
    }
    // the app skips a message about a hidden archived task silently, as it
    // skips an unknown id, and schedules no wake for it
    const guestRow = hiddenRows[1].id
    for (const ids of [[guestRow], [uuid()]]) {
      expect(await viaApp(t, f.guest, 'unread', ids)).toBeNull()
      expect(await viaApp(t, f.guest, 'snooze', ids, anHourAhead())).toBeNull()
      expect(await viaApp(t, f.guest, 'snooze', ids, null)).toBeNull()
    }
    expect(await allMessages(t)).toEqual(before)
    expect(await scheduled(t)).toEqual([])
  })

  it('after a restore, unread and snooze work again', async () => {
    const t = newT()
    const fx = await archivedInbox(t, { read_at: NOW })
    const { f } = fx
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: fx.archived.id })
    await as(t, f.user).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub2.id })

    expect((await viaMcp(t, f, 'unread', { tasks: [keyOf(fx.archived)] })).tasks).toEqual([
      keyOf(fx.archived),
    ])
    const until = anHourAhead()
    expect((await viaRest(t, f, 'snooze', { tasks: [keyOf(fx.shelved)], until })).tasks).toEqual([
      keyOf(fx.shelved),
    ])
    await viaApp(t, f.guest, 'unread', [fx.idOf(f.guest, fx.archived)])
    expect(await item(t, f.agent, fx.archived.id)).toEqual([{ detail: 'planted', read: false }])
    expect(await item(t, f.guest, fx.archived.id)).toEqual([{ detail: 'planted', read: false }])
    const [snoozed] = await messagesFor(t, f.agent.id, fx.shelved.id)
    expect([snoozed.snoozed_until, snoozed.read_at]).toEqual([until, undefined])
    // the task archived on its own in PCB stays archived after PCB's restore
    await refused(viaMcp(t, f, 'unread', { tasks: [keyOf(fx.both)] }), 'rule', isArchived(fx.both))
  })
})
