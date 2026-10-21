/* The field check on the app's writes (model/expected.ts): task edits,
 * moves and parents, links, roadmap batches, comments and milestones. An
 * edit that carries `expected` is refused with `conflict` and the reason
 * field_changed when someone else changed a field it names since the sender
 * read it, and then writes nothing. The app sends the print of a task's
 * title and description and of a comment's body (lib/fieldPrints.ts). */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import { descriptionForm, printOf, trimmedForm } from '../lib/fieldPrints'
import type { Refusal } from '../lib/functions'
import type { EventOwner } from '../lib/taskEvents'
import { removeProfile } from '../model/cascade'
import {
  activityFor,
  allMessages,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* The print the app sends for a title or a comment body it read. */
const titlePrint = (text: string) => printOf(trimmedForm(text))
/* The print the app sends for a description it read. */
const descriptionPrint = (text: string | null) => printOf(descriptionForm(text))

const key = (task: Doc<'issues'>) => `QN-${task.num}`
const sentence = (who: string | null, what: string, label: string) =>
  `${who === null ? `${what} of ${label} changed` : `${who} changed ${what} of ${label}`} since you read it, so nothing was saved; read ${label} again and resend your change`

/** Expects a field_changed refusal and answers its data. */
async function fieldChanged(p: Promise<unknown>): Promise<Refusal> {
  const data = (await expectRefusal(p, 'conflict')).data as Refusal
  expect(data.reason).toBe('field_changed')
  return data
}

const task = (t: T, id: string) => t.run((ctx) => byId(ctx, 'issues', id))

type Fx = OrgFixture & { t: T }

async function setup(): Promise<Fx> {
  const t = newT()
  return { t, ...(await withOrg(t)) }
}

/* issues.update as `who`. */
const edit = (
  fx: Fx,
  who: Doc<'profiles'>,
  id: string,
  patch: Record<string, unknown>,
  expected?: Record<string, unknown>,
) =>
  as(fx.t, who).mutation(api.issues.update, {
    org_id: fx.org.id,
    id,
    patch,
    ...(expected === undefined ? {} : { expected }),
  })

describe('task edits', () => {
  it('refuses a stale description and leaves the task, its history, messages and events alone', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      description: 'Old text',
    })
    await plantSubscription(fx.t, { issue_id: row.id, profile_id: fx.guest.id })
    // a webhook subscription on the project, so a write would queue an event
    const owner = await fx.t.run(async (ctx): Promise<EventOwner> => {
      const id = uuid()
      const credential_row_id = await ctx.db.insert('mcp_tokens', {
        id,
        profile_id: fx.guest.id,
        name: 'Events',
        token_prefix: 'qvt_test',
        token_hash: 'test',
        access: 'read',
        created_at: NOW,
      })
      return {
        profile_id: fx.guest.id,
        credential_table: 'mcp_tokens',
        credential_id: id,
        credential_row_id,
      }
    })
    await fx.t.mutation(internal.webhooks.save, {
      owner,
      id: uuid(),
      name: 'task.updated',
      filters: { project_id: fx.sub.id },
      url: 'https://receiver.example/events',
      encrypted_secret: 'encrypted-test-key',
      expires_at: Date.now() + 600_000,
    })
    const events = () => fx.t.run((ctx) => ctx.db.query('webhook_events').collect())

    // the user saves over the text both read
    await edit(
      fx,
      fx.user,
      row.id,
      { description: 'User text' },
      { description: descriptionPrint('Old text') },
    )
    expect((await task(fx.t, row.id))?.description).toBe('User text')
    expect(await events()).toHaveLength(1)

    const before = {
      task: await task(fx.t, row.id),
      activity: await activityFor(fx.t, fx.org.id),
      messages: await allMessages(fx.t),
      events: await events(),
    }
    const data = await fieldChanged(
      edit(
        fx,
        fx.admin,
        row.id,
        { description: 'Admin text' },
        { description: descriptionPrint('Old text') },
      ),
    )
    const userRow = before.activity.at(-1)!
    expect(data).toEqual({
      code: 'conflict',
      reason: 'field_changed',
      message: sentence('user', 'description', key(row)),
      changes: [
        { record: 'task', id: row.id, field: 'description', by: fx.user.id, at: userRow.ts },
      ],
    })
    expect({
      task: await task(fx.t, row.id),
      activity: await activityFor(fx.t, fx.org.id),
      messages: await allMessages(fx.t),
      events: await events(),
    }).toEqual(before)
  })

  it('lets a title edit through a status change it does not name', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    await edit(fx, fx.user, row.id, { status: 'progress' }, { status: 'todo' })
    await edit(fx, fx.admin, row.id, { title: 'Two' }, { title: titlePrint('One') })
    expect(await task(fx.t, row.id)).toMatchObject({ title: 'Two', status: 'progress' })
    // the status the admin read is stale, so naming it refuses
    await fieldChanged(edit(fx, fx.admin, row.id, { status: 'done' }, { status: 'todo' }))
    expect((await task(fx.t, row.id))?.status).toBe('progress')
  })

  it('saves two edits chained through expected and refuses a replay of the first', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    const first = { patch: { title: 'Two' }, expected: { title: titlePrint('One') } }
    await edit(fx, fx.user, row.id, first.patch, first.expected)
    await edit(fx, fx.user, row.id, { title: 'Three' }, { title: titlePrint('Two') })
    await fieldChanged(edit(fx, fx.user, row.id, first.patch, first.expected))
    expect((await task(fx.t, row.id))?.title).toBe('Three')
  })

  it('passes a value already stored and a value changed and changed back', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    await edit(fx, fx.user, row.id, { title: 'Two' })
    // the admin read One but sends what is stored now
    await edit(fx, fx.admin, row.id, { title: ' Two ' }, { title: titlePrint('One') })
    await edit(fx, fx.user, row.id, { title: 'One' })
    await edit(fx, fx.admin, row.id, { title: 'Four' }, { title: titlePrint('One') })
    expect((await task(fx.t, row.id))?.title).toBe('Four')
  })

  it('compares remaining hours to the tenth, and the app reads a group by its stored hours', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      remaining_hours: 8,
    })
    await edit(fx, fx.user, row.id, { remaining_hours: 5 }, { remaining_hours: 8.01 })
    expect((await task(fx.t, row.id))?.remaining_hours).toBe(5)
    await fieldChanged(edit(fx, fx.user, row.id, { remaining_hours: 3 }, { remaining_hours: 8 }))
    // a group that still stores hours from before its subtasks. The app
    // shows them, so a sender that read none is stale
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      remaining_hours: 5,
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, parent_id: group.id })
    await fieldChanged(
      edit(fx, fx.user, group.id, { remaining_hours: null }, { remaining_hours: null }),
    )
    expect((await task(fx.t, group.id))?.remaining_hours).toBe(5)
  })
})

describe('who changed it, after a write that logs no row', () => {
  it('names nobody once the task was touched after its newest row', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'One',
      remaining_hours: 4,
    })
    await edit(fx, fx.user, row.id, { title: 'Two' })
    const named = await fieldChanged(
      edit(fx, fx.admin, row.id, { title: 'Three' }, { title: titlePrint('One') }),
    )
    expect(named.changes?.[0]?.by).toBe(fx.user.id)
    // attaching a subtask clears the task's own hours with no row of its own
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Kid' }).then((kid) =>
      edit(fx, fx.user, kid.id, { parent_id: row.id }),
    )
    const after = await fieldChanged(
      edit(fx, fx.admin, row.id, { title: 'Three' }, { title: titlePrint('One') }),
    )
    expect(after.changes?.[0]?.by).toBeNull()
  })
})

describe('entering Review', () => {
  it('compares cleared hours as the review time the move into Review stores', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      status: 'progress',
      remaining_hours: 5,
    })
    // someone clears the estimate the sender read as 5 hours
    await edit(fx, fx.user, row.id, { remaining_hours: null })
    await fieldChanged(
      edit(
        fx,
        fx.admin,
        row.id,
        { status: 'review', remaining_hours: null },
        { remaining_hours: 5 },
      ),
    )
    expect(await task(fx.t, row.id)).toMatchObject({ status: 'progress' })
    // read as cleared, the same request saves and gets the review time
    await edit(
      fx,
      fx.admin,
      row.id,
      { status: 'review', remaining_hours: null },
      { remaining_hours: null },
    )
    expect((await task(fx.t, row.id))?.status).toBe('review')
  })
})

describe('task parents', () => {
  it('compares a hidden parent without telling which one it is', async () => {
    const fx = await setup()
    const sibling = await plantHiddenSibling(fx.t, fx, fx.guest)
    const parent = await plantIssue(fx.t, { org_id: fx.org.id, project_id: sibling.id })
    const child = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      parent_id: parent.id,
    })
    const detach = (expected: Record<string, unknown>) =>
      edit(fx, fx.guest, child.id, { parent_id: null }, expected)
    // the guest read no parent, but one is stored
    const data = await fieldChanged(detach({ parent_id: null, has_hidden_parent: false }))
    expect(data.changes).toEqual([
      { record: 'task', id: child.id, field: 'parent_id', by: null, at: null },
    ])
    expect(JSON.stringify(data)).not.toContain(parent.id)
    expect((await task(fx.t, child.id))?.parent_id).toBe(parent.id)
    await detach({ parent_id: null, has_hidden_parent: true })
    expect((await task(fx.t, child.id))?.parent_id).toBeUndefined()

    // a parent seen by id still matches after it becomes hidden
    const later = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub2.id })
    const second = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      parent_id: later.id,
    })
    await fx.t.run(async (ctx) => {
      const row = (await byId(ctx, 'issues', later.id))!
      await ctx.db.patch(row._id, { project_id: sibling.id })
    })
    await edit(
      fx,
      fx.guest,
      second.id,
      { parent_id: null },
      { parent_id: later.id, has_hidden_parent: false },
    )
    expect((await task(fx.t, second.id))?.parent_id).toBeUndefined()
  })

  it('reads an archived parent as hidden in the app and by id over REST', async () => {
    const fx = await setup()
    const parent = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub2.id,
      archived_at: NOW,
    })
    const plant = () =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, parent_id: parent.id })
    const hidden = { parent_id: null, has_hidden_parent: true }
    const shown = { parent_id: parent.id, has_hidden_parent: false }

    const inApp = await plant()
    await fieldChanged(
      edit(
        fx,
        fx.user,
        inApp.id,
        { parent_id: null },
        { parent_id: null, has_hidden_parent: false },
      ),
    )
    await edit(fx, fx.user, inApp.id, { parent_id: null }, hidden)
    expect((await task(fx.t, inApp.id))?.parent_id).toBeUndefined()

    const rest = (ref: string, expected: Record<string, unknown>) =>
      fx.t.mutation(internal.machine.rest.updateIssue, {
        callerId: fx.user.id,
        access: 'write',
        keyName: 'drive',
        ref,
        body: JSON.stringify({ parent: null, expected }),
      })
    const overRest = await plant()
    await fieldChanged(rest(overRest.id, hidden))
    expect((await task(fx.t, overRest.id))?.parent_id).toBe(parent.id)
    await rest(overRest.id, shown)
    expect((await task(fx.t, overRest.id))?.parent_id).toBeUndefined()
  })
})

describe('task moves', () => {
  it('refuses a move whose project the sender read is stale', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const move = (expected: string) =>
      as(fx.t, fx.user).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: row.id,
        project_id: fx.sub2.id,
        expected: { project_id: expected },
      })
    const data = await fieldChanged(move(fx.hidden.id))
    expect(data.changes?.map((c) => c.field)).toEqual(['project_id'])
    expect((await task(fx.t, row.id))?.project_id).toBe(fx.sub.id)
    await move(fx.sub.id)
    expect((await task(fx.t, row.id))?.project_id).toBe(fx.sub2.id)
  })
})

describe('who changed it', () => {
  it('names a writer only where an activity row the caller may see proves it', async () => {
    const fx = await setup()
    // a subtask's attach clears its new parent's hours and logs no print
    const parent = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await edit(fx, fx.user, parent.id, { remaining_hours: 6 })
    await as(fx.t, fx.user).mutation(api.issues.create, {
      org_id: fx.org.id,
      id: uuid(),
      project_id: fx.sub.id,
      title: 'Subtask',
      parent_id: parent.id,
    })
    expect((await task(fx.t, parent.id))?.remaining_hours).toBeUndefined()
    const cleared = await fieldChanged(
      edit(fx, fx.admin, parent.id, { remaining_hours: 3 }, { remaining_hours: 6 }),
    )
    expect(cleared.changes).toEqual([
      { record: 'task', id: parent.id, field: 'remaining_hours', by: null, at: null },
    ])
    expect(cleared.message).toBe(sentence(null, 'remaining_hours', key(parent)))

    // a removed profile names nobody
    const rita = await plantLogin(
      fx.t,
      await plantSeat(fx.t, { org_id: fx.org.id, name: 'Rita', email: 'rita@testbed.test' }),
    )
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: fx.sub.id,
        profile_id: rita.id,
        level: 'user',
      })
    })
    const hers = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'A' })
    await edit(fx, rita, hers.id, { title: 'B' })
    const named = await fieldChanged(
      edit(fx, fx.admin, hers.id, { title: 'C' }, { title: titlePrint('A') }),
    )
    expect(named.changes?.[0].by).toBe(rita.id)
    expect(named.message).toBe(sentence('Rita', 'title', key(hers)))
    await fx.t.run(async (ctx) => {
      const row = (await byId(ctx, 'profiles', rita.id))!
      await removeProfile(ctx, { profile: row, now: new Date().toISOString() })
    })
    const gone = await fieldChanged(
      edit(fx, fx.admin, hers.id, { title: 'C' }, { title: titlePrint('A') }),
    )
    expect(gone.changes?.[0]).toMatchObject({ by: null, at: null })
  })

  it('names nobody to a member who may not see the row that wrote the value', async () => {
    const fx = await setup()
    const sibling = await plantHiddenSibling(fx.t, fx, fx.guest)
    const hiddenParent = await plantIssue(fx.t, { org_id: fx.org.id, project_id: sibling.id })
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    // the row of the attach names a parent the guest cannot see
    await edit(fx, fx.user, row.id, { parent_id: hiddenParent.id })
    const stale = { parent_id: null, has_hidden_parent: false }
    const guest = await fieldChanged(edit(fx, fx.guest, row.id, { parent_id: null }, stale))
    expect(guest.changes).toEqual([
      { record: 'task', id: row.id, field: 'parent_id', by: null, at: null },
    ])
    expect(guest.message).toBe(sentence(null, 'parent', key(row)))
    const admin = await fieldChanged(edit(fx, fx.admin, row.id, { parent_id: null }, stale))
    expect(admin.changes?.[0].by).toBe(fx.user.id)
  })
})

describe('labels on a task', () => {
  it('sets a label on once however often on:true is sent, and off with on:false', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const label = uuid()
    await as(fx.t, fx.admin).mutation(api.labels.create, {
      org_id: fx.org.id,
      id: label,
      name: 'Urgent',
      color: '#d04040',
    })
    const toggle = (on: boolean) =>
      as(fx.t, fx.user).mutation(api.labels.toggle, {
        org_id: fx.org.id,
        issue_id: row.id,
        label_id: label,
        on,
      })
    const pairs = () =>
      fx.t.run((ctx) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_issue_label', (q) => q.eq('issue_id', row.id))
          .collect(),
      )
    const taskRows = async () =>
      (await activityFor(fx.t, fx.org.id)).filter((e) => e.target_id === row.id)
    await toggle(true)
    await toggle(true)
    expect(await pairs()).toHaveLength(1)
    expect((await taskRows()).map((e) => e.verb)).toEqual(['labeled'])
    await toggle(false)
    expect(await pairs()).toHaveLength(0)
    expect((await taskRows()).map((e) => e.verb)).toEqual(['labeled', 'removed a label from'])
  })
})

describe('link removal', () => {
  it('refuses a link of another kind than the one seen and passes over a missing link', async () => {
    const fx = await setup()
    const a = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const b = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await as(fx.t, fx.user).mutation(api.issues.addLink, {
      org_id: fx.org.id,
      id: uuid(),
      source_id: a.id,
      target_id: b.id,
      type: 'blocks',
    })
    const links = () => fx.t.run((ctx) => ctx.db.query('issue_links').collect())
    const remove = (kind: 'blocks' | 'blocked_by' | 'relates') =>
      as(fx.t, fx.user).mutation(api.issues.removeLink, {
        org_id: fx.org.id,
        a: a.id,
        b: b.id,
        expected: { kind },
      })
    const data = await fieldChanged(remove('relates'))
    expect(data.changes).toEqual([
      { record: 'link', id: a.id, of: b.id, field: 'kind', by: null, at: null },
    ])
    expect(await links()).toHaveLength(1)
    await remove('blocks')
    expect(await links()).toEqual([])
    expect(await remove('relates')).toBeNull()
  })
})

describe('roadmap batches', () => {
  it('saves and journals nothing when one operation is stale', async () => {
    const fx = await setup()
    const a = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const b = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      start_week: '2026-03-02',
      end_week: '2026-03-02',
    })
    const session_id = uuid()
    const change = (bSeen: string | null) =>
      as(fx.t, fx.user).mutation(api.roadmap.change, {
        session_id,
        operations: [
          {
            kind: 'task',
            id: a.id,
            patch: { start_week: '2026-04-06', end_week: '2026-04-06' },
            expected: { start_week: null, end_week: null },
          },
          {
            kind: 'task',
            id: b.id,
            patch: { start_week: '2026-04-13', end_week: '2026-04-13' },
            expected: { start_week: bSeen, end_week: '2026-03-02' },
          },
        ],
      })
    const history = () => fx.t.run((ctx) => ctx.db.query('roadmap_history').collect())
    const data = await fieldChanged(change(null))
    expect(data.changes?.map((c) => [c.id, c.field])).toEqual([[b.id, 'start_week']])
    expect((await task(fx.t, a.id))?.start_week).toBeUndefined()
    expect(await history()).toEqual([])
    expect(await activityFor(fx.t, fx.org.id)).toEqual([])
    expect(await change('2026-03-02')).toEqual({ count: 1 })
    expect(await history()).toHaveLength(1)
  })
})

describe('comments', () => {
  it('names the last editor of a changed body', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const id = uuid()
    await as(fx.t, fx.user).mutation(api.comments.create, {
      org_id: fx.org.id,
      id,
      issue_id: row.id,
      body: 'First words',
    })
    await as(fx.t, fx.admin).mutation(api.comments.update, {
      org_id: fx.org.id,
      id,
      body: 'Admin words',
      expected: { body: titlePrint('First words') },
    })
    const update = (body: string, seen: string) =>
      as(fx.t, fx.user).mutation(api.comments.update, {
        org_id: fx.org.id,
        id,
        body,
        expected: { body: titlePrint(seen) },
      })
    const data = await fieldChanged(update('User words', 'First words'))
    const stored = await fx.t.run((ctx) => byId(ctx, 'comments', id))
    expect(data.changes).toEqual([
      { record: 'comment', id, field: 'body', by: fx.admin.id, at: stored?.edited_at },
    ])
    expect(data.message).toBe(sentence('admin', 'body', `comment ${id} on ${key(row)}`))
    expect(stored?.body).toBe('Admin words')
    await update('User words', 'Admin words')
    expect((await fx.t.run((ctx) => byId(ctx, 'comments', id)))?.body).toBe('User words')
  })
})

describe('milestones', () => {
  it('lets a rename through a stale week it does not name', async () => {
    const fx = await setup()
    const id = uuid()
    await as(fx.t, fx.user).mutation(api.projects.addMilestone, {
      org_id: fx.org.id,
      id,
      project_id: fx.meta.id,
      name: 'Launch',
      week: '2026-06-01',
    })
    const update = (who: Doc<'profiles'>, patch: Record<string, string>, expected: object) =>
      as(fx.t, who).mutation(api.projects.updateMilestone, {
        org_id: fx.org.id,
        id,
        patch,
        expected,
      })
    await update(fx.user, { week: '2026-06-08' }, { week: '2026-06-01' })
    await update(fx.admin, { name: 'Ship' }, { name: 'Launch' })
    const milestone = () => fx.t.run((ctx) => byId(ctx, 'milestones', id))
    expect(await milestone()).toMatchObject({ name: 'Ship', week: '2026-06-08' })
    // the week the admin read is stale, so naming it refuses, and so does
    // the same rename in a roadmap batch
    await fieldChanged(
      update(fx.admin, { name: 'Go', week: '2026-06-15' }, { name: 'Ship', week: '2026-06-01' }),
    )
    await fieldChanged(
      as(fx.t, fx.admin).mutation(api.roadmap.change, {
        session_id: uuid(),
        operations: [
          {
            kind: 'milestone_update',
            id,
            patch: { name: 'Go' },
            expected: { name: 'Launch' },
          },
        ],
      }),
    )
    expect(await milestone()).toMatchObject({ name: 'Ship', week: '2026-06-08' })
  })
})

describe('field prints', () => {
  it('stores them on task rows but leaves them out of the task window and the export', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    await edit(fx, fx.user, row.id, { title: 'Two' })
    const [stored] = await activityFor(fx.t, fx.org.id)
    expect(stored.field_prints).toEqual({ title: titlePrint('Two') })
    const thread = await as(fx.t, fx.admin).query(api.snapshot.commentThread, {
      org_id: fx.org.id,
      issue_id: row.id,
    })
    expect(thread.events.map((e) => e.id)).toEqual([stored.id])
    expect(thread.events[0]).not.toHaveProperty('field_prints')
    const exported = await as(fx.t, fx.admin).query(api.orgExport.page, {
      org_id: fx.org.id,
      section: 'activity_events',
      cursor: null,
    })
    expect(exported.rows.map((r) => r.id)).toEqual([stored.id])
    expect(exported.rows[0]).not.toHaveProperty('field_prints')
  })
})
