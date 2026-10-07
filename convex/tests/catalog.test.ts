/* Phase-5 catalog surfaces: orgs (settings/slug), comments, messages
 * (markRead + prune), labels (+toggle), prefs, tokens. Sentences asserted
 * verbatim where the contract is byte-level (rule refusals, narration
 * verbs/details, curly quotes U+201C/U+201D, the ' → ' arrow). */
/// <reference types="vite/client" />

import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import schema from '../schema'
import {
  activityFor,
  as,
  drainActivity,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

const HEX64 = 'ab'.repeat(32)

const plantLabel = (t: T, org_id: string, name: string, color = '#6D7BF2') =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('labels', {
      id: uuid(),
      org_id,
      name,
      name_lower: name.toLowerCase(),
      color,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'labels'>
  })

const commentById = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('comments')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const orgRow = (t: T, id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

describe('orgs.update — settings, silently', () => {
  it('patches validated fields, clamps hours, and narrates nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.orgs.update, {
      org_id: f.org.id,
      patch: {
        name: 'Testbed Industries',
        date_format: 'DD.MM.YYYY',
        week_start: 0,
        week_one_rule: 'jan1',
        default_plannable_hours: 500,
        gravatar_avatars: true,
      },
    })
    const org = await orgRow(t, f.org.id)
    expect(org?.name).toBe('Testbed Industries')
    expect(org?.date_format).toBe('DD.MM.YYYY')
    expect(org?.week_start).toBe(0)
    expect(org?.week_one_rule).toBe('jan1')
    expect(org?.default_plannable_hours).toBe(168) // clamped, like the client
    expect(org?.gravatar_avatars).toBe(true)
    expect(await activityFor(t, f.org.id)).toEqual([]) // settings + rename never narrate
  })

  it('refuses a bad week_start, a blank name, and a non-admin', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.orgs.update, { org_id: f.org.id, patch: { week_start: 7 } }),
      'bad_request',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.orgs.update, { org_id: f.org.id, patch: { name: '  ' } }),
      'bad_request',
    )
    await expectRefusal(
      as(t, f.user).mutation(api.orgs.update, { org_id: f.org.id, patch: { name: 'Coup' } }),
      'forbidden',
    )
  })

  it('only an administrator of this organization can change its attachment cap', async () => {
    const t = newT()
    const f = await withOrg(t)
    // `user` leads Hardware; team leadership grants no organization settings rights.
    for (const actor of [f.user, f.viewer, f.guest, f.otherAdmin]) {
      await expectRefusal(
        as(t, actor).mutation(api.orgs.update, {
          org_id: f.org.id,
          patch: { max_attachment_mb: 1 },
        }),
        'forbidden',
      )
    }
    expect((await orgRow(t, f.org.id))?.max_attachment_mb).toBe(10)
    await as(t, f.admin).mutation(api.orgs.update, {
      org_id: f.org.id,
      patch: { max_attachment_mb: 4 },
    })
    expect((await orgRow(t, f.org.id))?.max_attachment_mb).toBe(4)
    expect(await orgRow(t, f.otherOrg.id)).toEqual(f.otherOrg)
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('clamps the attachment cap to whole MiB from 1 to 20 and refuses non-finite input', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const [input, stored] of [
      [0, 1],
      [999, 20],
      [4.6, 5],
    ]) {
      await as(t, f.admin).mutation(api.orgs.update, {
        org_id: f.org.id,
        patch: { max_attachment_mb: input },
      })
      expect((await orgRow(t, f.org.id))?.max_attachment_mb).toBe(stored)
    }
    for (const input of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expectRefusal(
        as(t, f.admin).mutation(api.orgs.update, {
          org_id: f.org.id,
          patch: { max_attachment_mb: input },
        }),
        'bad_request',
        /max_attachment_mb must be a number/,
      )
    }
    expect((await orgRow(t, f.org.id))?.max_attachment_mb).toBe(5)
  })
})

describe('orgs.setSlug — the one narrated org write', () => {
  it('changes the address and writes exactly the 0108 row', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'testbed-2' })
    expect((await orgRow(t, f.org.id))?.slug).toBe('testbed-2')
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'changed the address of',
      target_type: 'org',
      target_id: f.org.id,
      label: 'Testbed Labs', // the org NAME, not the slug
      detail: 'testbed → testbed-2',
      actor_id: f.admin.id,
    })
    expect(events[0].project_id).toBeUndefined()
    expect(events[0].team_id).toBeUndefined()
  })

  it('a same-value write is a silent no-op (the 0108 probe)', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'testbed' })
    expect(await activityFor(t, f.org.id)).toEqual([])
    expect((await orgRow(t, f.org.id))?.slug).toBe('testbed')
  })

  it('taken / reserved / malformed refuse with the conflict taxonomy', async () => {
    const t = newT()
    const f = await withOrg(t)
    const taken = await expectRefusal(
      as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'other' }),
      'conflict',
    )
    expect(taken.data.reason).toBe('slug_taken')
    const reserved = await expectRefusal(
      as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'admin' }),
      'conflict',
    )
    expect(reserved.data.reason).toBe('slug_reserved')
    const shape = await expectRefusal(
      as(t, f.admin).mutation(api.orgs.setSlug, { org_id: f.org.id, slug: 'Bad Slug' }),
      'conflict',
    )
    expect(shape.data.reason).toBe('slug_shape')
    expect(await activityFor(t, f.org.id)).toEqual([])
  })
})

describe('comments — create/update/remove', () => {
  const setup = async (t: T) => {
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    return { f, issue }
  }

  it('create posts the row and fans out sharing ONE instant (0111)', async () => {
    const t = newT()
    const { f, issue } = await setup(t)
    await as(t, f.admin).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: issue.id })
    const id = uuid()
    await as(t, f.user).mutation(api.comments.create, {
      org_id: f.org.id,
      id,
      issue_id: issue.id,
      body: '  ship it  ',
    })
    const comment = await commentById(t, id)
    expect(comment?.body).toBe('ship it') // trimmed
    expect(comment?.author).toBe(f.user.id)
    expect(comment?.edited_at).toBeUndefined()
    const inbox = await messagesFor(t, f.admin.id, issue.id)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].kind).toBe('comment')
    expect(inbox[0].detail).toBe('New comment')
    expect(inbox[0].created_at).toBe(comment?.created_at) // shared `now`
    // the author subscribed but got no message of their own
    expect(await messagesFor(t, f.user.id, issue.id)).toEqual([])
  })

  it('fences: unknown issue, write level, blank body, replayed uuid', async () => {
    const t = newT()
    const { f, issue } = await setup(t)
    await expectRefusal(
      as(t, f.user).mutation(api.comments.create, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: uuid(),
        body: 'x',
      }),
      'not_found',
      /^task not found$/,
    )
    // viewer sees the thread (grant on meta) but the ceiling caps writes
    await expectRefusal(
      as(t, f.viewer).mutation(api.comments.create, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: issue.id,
        body: 'x',
      }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.user).mutation(api.comments.create, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: issue.id,
        body: '   ',
      }),
      'bad_request',
    )
    const id = uuid()
    const args = { org_id: f.org.id, id, issue_id: issue.id, body: 'once' }
    await as(t, f.user).mutation(api.comments.create, args)
    await expectRefusal(as(t, f.user).mutation(api.comments.create, args), 'bad_request')
  })

  it('update: author or lead only; same body stamps nothing', async () => {
    const t = newT()
    const { f, issue } = await setup(t)
    const id = uuid()
    await as(t, f.guest).mutation(api.comments.create, {
      org_id: f.org.id,
      id,
      issue_id: issue.id,
      body: 'v1',
    })
    // an unknown comment id is a uniform not-found, never an oracle
    await expectRefusal(
      as(t, f.guest).mutation(api.comments.update, { org_id: f.org.id, id: uuid(), body: 'x' }),
      'not_found',
    )
    // not the author, no lead standing (a viewer never has it) — refused
    await expectRefusal(
      as(t, f.viewer).mutation(api.comments.update, { org_id: f.org.id, id, body: 'x' }),
      'forbidden',
    )
    await tick()
    // admin ranks as lead — may edit another's comment; edited_by pins THEM
    await as(t, f.admin).mutation(api.comments.update, { org_id: f.org.id, id, body: 'v2' })
    const edited = await commentById(t, id)
    expect(edited?.body).toBe('v2')
    expect(edited?.edited_by).toBe(f.admin.id)
    expect(edited?.edited_at).not.toBeUndefined()
    expect(edited?.author).toBe(f.guest.id) // author immutable
    const stamp = edited?.edited_at
    // same-value write: silent no-op, no re-stamp (comments_guard)
    await tick()
    await as(t, f.guest).mutation(api.comments.update, { org_id: f.org.id, id, body: 'v2' })
    expect((await commentById(t, id))?.edited_at).toBe(stamp)
  })

  it('remove: the author, or lead level; a guest cannot delete another user’s', async () => {
    const t = newT()
    const { f, issue } = await setup(t)
    const id = uuid()
    await as(t, f.user).mutation(api.comments.create, {
      org_id: f.org.id,
      id,
      issue_id: issue.id,
      body: 'gone soon',
    })
    await expectRefusal(
      as(t, f.guest).mutation(api.comments.remove, { org_id: f.org.id, id }),
      'forbidden',
    )
    await as(t, f.user).mutation(api.comments.remove, { org_id: f.org.id, id })
    expect(await commentById(t, id)).toBeNull()
    // an admin ranks as lead — another author's comment is theirs to delete
    const other = uuid()
    await as(t, f.guest).mutation(api.comments.create, {
      org_id: f.org.id,
      id: other,
      issue_id: issue.id,
      body: 'also gone',
    })
    await as(t, f.admin).mutation(api.comments.remove, { org_id: f.org.id, id: other })
    expect(await commentById(t, other)).toBeNull()
  })

  it('a mention reads the mention message, not the change echo — and starts following', async () => {
    const t = newT()
    const { f, issue } = await setup(t)
    await as(t, f.guest).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: issue.id })
    const id = uuid()
    await as(t, f.user).mutation(api.comments.create, {
      org_id: f.org.id,
      id,
      issue_id: issue.id,
      body: `over to @[admin](user:${f.admin.id})`,
    })
    // the mentioned: exactly ONE message, kind mention — never also 'New comment'
    const adminInbox = await messagesFor(t, f.admin.id, issue.id)
    expect(adminInbox).toHaveLength(1)
    expect(adminInbox[0].kind).toBe('mention')
    expect(adminInbox[0].detail).toBe('Mentioned you in a comment')
    expect(adminInbox[0].actor_id).toBe(f.user.id)
    // a plain subscriber reads the comment echo; the author hears nothing
    const guestInbox = await messagesFor(t, f.guest.id, issue.id)
    expect(guestInbox).toHaveLength(1)
    expect(guestInbox[0].kind).toBe('comment')
    expect(guestInbox[0].detail).toBe('New comment')
    expect(await messagesFor(t, f.user.id, issue.id)).toEqual([])
    // both the mentioned and the author now follow the thread
    const subscribed = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .collect(),
    )
    expect(new Set(subscribed.map((s) => s.profile_id))).toEqual(
      new Set([f.guest.id, f.admin.id, f.user.id]),
    )
    // an edit notifies only mentions ADDED by it — no comment echo, no re-mention
    await tick()
    await as(t, f.user).mutation(api.comments.update, {
      org_id: f.org.id,
      id,
      body: `over to @[admin](user:${f.admin.id}) and @[viewer](user:${f.viewer.id})`,
    })
    const viewerInbox = await messagesFor(t, f.viewer.id, issue.id)
    expect(viewerInbox).toHaveLength(1)
    expect(viewerInbox[0].kind).toBe('mention')
    expect(viewerInbox[0].detail).toBe('Mentioned you in a comment')
    expect(await messagesFor(t, f.admin.id, issue.id)).toHaveLength(1) // unchanged
    expect(await messagesFor(t, f.guest.id, issue.id)).toHaveLength(1) // unchanged
  })
})

describe('messages — markRead / markUnread / remove', () => {
  it('markRead stamps still-unread own rows and prunes each pair to its newest', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const m1 = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: issue.id,
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const m2 = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: issue.id,
      created_at: '2026-01-01T00:00:01.000Z',
    })
    const foreign = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.user.id,
      issue_id: issue.id,
    })
    await as(t, f.admin).mutation(api.messages.markRead, {
      org_id: f.org.id,
      ids: [m1.id, m2.id, foreign.id, uuid()],
    })
    const mine = await messagesFor(t, f.admin.id, issue.id)
    expect(mine.map((m) => m.id)).toEqual([m2.id]) // m1 pruned, newest survives read
    expect(mine[0].read_at).not.toBeUndefined()
    // the foreign row was silently skipped, not an error
    const theirs = await messagesFor(t, f.user.id, issue.id)
    expect(theirs[0].read_at).toBeUndefined()
  })

  it('markAllRead batches over 500 unread rows, prunes each task, and preserves later arrivals', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue_id = uuid()
    const base = { org_id: f.org.id, recipient_id: f.admin.id, issue_id }
    const ids = Array.from({ length: 600 }, () => uuid())
    await t.run(async (ctx) => {
      for (const [index, id] of ids.entries()) {
        await ctx.db.insert('messages', {
          ...base,
          id,
          issue_title: 'Task with many updates',
          kind: 'change',
          detail: 'Status changed',
          created_at: new Date(Date.parse(NOW) + index * 1000).toISOString(),
        })
      }
    })
    const alreadyRead = await plantMessage(t, { ...base, issue_id: uuid(), read_at: NOW })
    const foreign = await plantMessage(t, { ...base, recipient_id: f.user.id })
    const caller = as(t, f.admin)
    const first = await caller.mutation(api.messages.markAllRead, { org_id: f.org.id })
    expect(first).toMatchObject({ marked: 256, hasMore: true })
    expect((await messagesFor(t, f.admin.id, issue_id)).filter((row) => !row.read_at)).toHaveLength(
      344,
    )

    await tick()
    // Backdated narration must not let a newly delivered notification get
    // caught by later batches. The boundary is storage creation time.
    const arrival = await plantMessage(t, { ...base, created_at: '2025-01-01T00:00:00.000Z' })
    expect(arrival._creationTime).toBeGreaterThan(first.before)
    expect(
      await caller.mutation(api.messages.markAllRead, { org_id: f.org.id, before: first.before }),
    ).toEqual({
      marked: 256,
      hasMore: true,
      before: first.before,
    })
    expect(
      await caller.mutation(api.messages.markAllRead, { org_id: f.org.id, before: first.before }),
    ).toEqual({
      marked: 88,
      hasMore: false,
      before: first.before,
    })
    const remaining = await messagesFor(t, f.admin.id, issue_id)
    expect(remaining.map((row) => row.id).sort()).toEqual([ids[599], arrival.id].sort())
    expect(remaining.find((row) => row.id === ids[599])?.read_at).toEqual(expect.any(String))
    expect(remaining.find((row) => row.id === arrival.id)?.read_at).toBeUndefined()
    expect((await messagesFor(t, f.admin.id, alreadyRead.issue_id))[0].read_at).toBe(NOW)
    expect((await messagesFor(t, f.user.id))[0]).toEqual(foreign)
  })

  it('bounds pruning reads across large task backlogs and keeps the newest read timestamp on ties', async () => {
    const t = convexTest({
      schema,
      modules: import.meta.glob('../**/*.*s'),
      // A full scan of even two of these four task backlogs would exceed
      // this budget. Indexed pruning must stay under it for the whole act.
      transactionLimits: { documentsRead: 1200 },
    })
    const f = await withOrg(t)
    const tasks = Array.from({ length: 4 }, () => uuid())
    const retained = await t.run(async (ctx) => {
      const base = {
        org_id: f.org.id,
        recipient_id: f.admin.id,
        issue_title: 'Task with a large notification backlog',
        kind: 'change' as const,
        detail: 'Status changed',
        created_at: NOW,
      }
      // Interleave tasks so every batch touches all four large backlogs.
      for (let index = 0; index < 750; index++) {
        for (const [task, issue_id] of tasks.entries()) {
          await ctx.db.insert('messages', {
            ...base,
            issue_id,
            id: `00000000-0000-4000-8000-${(index * 4 + task).toString(16).padStart(12, '0')}`,
          })
        }
      }
      const retained = []
      for (const [index, issue_id] of tasks.entries()) {
        const id = `ffffffff-ffff-ffff-ffff-fffffffffff${index}`
        await ctx.db.insert('messages', { ...base, issue_id, id, read_at: NOW })
        retained.push(id)
      }
      return retained
    })
    const first = await as(t, f.admin).mutation(api.messages.markAllRead, { org_id: f.org.id })
    expect(first).toMatchObject({ marked: 256, hasMore: true })
    for (const [index, issue_id] of tasks.entries()) {
      const state = await t.run(async (ctx) => ({
        read: await ctx.db
          .query('messages')
          .withIndex('by_recipient_issue_read_order', (q) =>
            q.eq('recipient_id', f.admin.id).eq('issue_id', issue_id).gt('read_at', undefined),
          )
          .take(2),
        unread: await ctx.db
          .query('messages')
          .withIndex('by_recipient_issue_read_order', (q) =>
            q.eq('recipient_id', f.admin.id).eq('issue_id', issue_id).eq('read_at', undefined),
          )
          .take(750),
      }))
      expect(state.unread).toHaveLength(686)
      expect(state.read).toHaveLength(1)
      expect(state.read[0]).toMatchObject({ id: retained[index], read_at: NOW })
    }
  })

  it('markAllRead is empty for a read inbox and refuses another organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: uuid(),
      read_at: NOW,
    })
    const foreign = await plantMessage(t, {
      org_id: f.otherOrg.id,
      recipient_id: f.otherAdmin.id,
      issue_id: uuid(),
    })
    expect(await as(t, f.admin).mutation(api.messages.markAllRead, { org_id: f.org.id })).toEqual({
      marked: 0,
      hasMore: false,
      before: 0,
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.messages.markAllRead, { org_id: f.otherOrg.id }),
      'forbidden',
      /no profile in this organization/,
    )
    expect((await messagesFor(t, f.otherAdmin.id))[0]).toEqual(foreign)
  })

  it('markUnread clears without pruning; remove deletes own rows only', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const m = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: issue.id,
      read_at: NOW,
    })
    await as(t, f.admin).mutation(api.messages.markUnread, { org_id: f.org.id, ids: [m.id] })
    expect((await messagesFor(t, f.admin.id, issue.id))[0].read_at).toBeUndefined()
    const foreign = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.user.id,
      issue_id: issue.id,
    })
    await as(t, f.admin).mutation(api.messages.remove, {
      org_id: f.org.id,
      ids: [m.id, foreign.id],
    })
    expect(await messagesFor(t, f.admin.id, issue.id)).toEqual([])
    expect(await messagesFor(t, f.user.id, issue.id)).toHaveLength(1)
  })

  it('read cleanup deletes every own read row and preserves unread and foreign rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, recipient_id: f.admin.id }
    const read = await plantMessage(t, { ...base, issue_id: uuid(), read_at: NOW })
    const unread = await plantMessage(t, { ...base, issue_id: read.issue_id })
    await plantMessage(t, { ...base, issue_id: uuid(), read_at: NOW })
    const foreign = await plantMessage(t, {
      ...base,
      recipient_id: f.user.id,
      issue_id: read.issue_id,
      read_at: NOW,
    })

    const result = await as(t, f.admin).mutation(api.messages.removeRead, { org_id: f.org.id })

    expect(result).toEqual({ removed: 2, hasMore: false })
    expect((await messagesFor(t, f.admin.id)).map((message) => message.id)).toEqual([unread.id])
    expect((await messagesFor(t, f.user.id)).map((message) => message.id)).toEqual([foreign.id])
  })

  it('read cleanup preserves a message reopened by another device and new unread arrivals', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, recipient_id: f.admin.id }
    const reopened = await plantMessage(t, { ...base, issue_id: uuid(), read_at: NOW })
    const read = await plantMessage(t, { ...base, issue_id: uuid(), read_at: NOW })
    await as(t, f.admin).mutation(api.messages.markUnread, {
      org_id: f.org.id,
      ids: [reopened.id],
    })
    const arrival = await plantMessage(t, { ...base, issue_id: read.issue_id })
    await as(t, f.admin).mutation(api.messages.removeRead, {
      org_id: f.org.id,
    })

    const remaining = await messagesFor(t, f.admin.id)
    expect(remaining.map((message) => message.id).sort()).toEqual([reopened.id, arrival.id].sort())
    expect(remaining.every((message) => message.read_at === undefined)).toBe(true)
  })

  it('read cleanup drains bounded batches beyond the 500-message display limit', async () => {
    const t = newT()
    const f = await withOrg(t)
    const readIds = Array.from({ length: 600 }, () => uuid())
    const unreadIds = Array.from({ length: 500 }, () => uuid())
    await t.run(async (ctx) => {
      const base = {
        org_id: f.org.id,
        recipient_id: f.admin.id,
        issue_id: uuid(),
        issue_title: 'Task with a long notification history',
        kind: 'change' as const,
        detail: 'Status changed',
      }
      for (const id of readIds) {
        await ctx.db.insert('messages', {
          ...base,
          id,
          created_at: '2026-01-01T00:00:00.000Z',
          read_at: NOW,
        })
      }
      // All 500 displayed messages would be unread; read cleanup must still
      // reach older read rows without first fetching them into the snapshot.
      for (const id of unreadIds) {
        await ctx.db.insert('messages', { ...base, id, created_at: NOW })
      }
    })

    const caller = as(t, f.admin)
    expect(await caller.mutation(api.messages.removeRead, { org_id: f.org.id })).toEqual({
      removed: 256,
      hasMore: true,
    })
    expect(await caller.mutation(api.messages.removeRead, { org_id: f.org.id })).toEqual({
      removed: 256,
      hasMore: true,
    })
    expect(await caller.mutation(api.messages.removeRead, { org_id: f.org.id })).toEqual({
      removed: 88,
      hasMore: false,
    })
    expect(await caller.mutation(api.messages.removeRead, { org_id: f.org.id })).toEqual({
      removed: 0,
      hasMore: false,
    })
    expect((await messagesFor(t, f.admin.id)).map((message) => message.id).sort()).toEqual(
      [...unreadIds].sort(),
    )
  })

  it('read cleanup refuses an organization without an active seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    const message = await plantMessage(t, {
      org_id: f.otherOrg.id,
      recipient_id: f.otherAdmin.id,
      issue_id: uuid(),
      read_at: NOW,
    })

    await expectRefusal(
      as(t, f.admin).mutation(api.messages.removeRead, {
        org_id: f.otherOrg.id,
      }),
      'forbidden',
      /no profile in this organization/,
    )
    expect((await messagesFor(t, f.otherAdmin.id)).map((row) => row.id)).toEqual([message.id])
  })
})

describe('labels — vocabulary + toggle', () => {
  it('create narrates against the org; the name is unique case-insensitively', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.labels.create, {
      org_id: f.org.id,
      id,
      name: ' Bug ',
      color: '#F0555D',
    })
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'created label',
      target_type: 'org',
      target_id: id,
      label: 'Bug',
    })
    expect(events[0].detail).toBeUndefined()
    // `user` is a curator (leads a meta) — and still refused on the dup name
    const dup = await expectRefusal(
      as(t, f.user).mutation(api.labels.create, {
        org_id: f.org.id,
        id: uuid(),
        name: 'bug',
        color: '#000000',
      }),
      'rule',
    )
    expect(dup.data.message).toBe('a label with that name already exists')
    // a guest is not staff — never a curator
    await expectRefusal(
      as(t, f.guest).mutation(api.labels.create, {
        org_id: f.org.id,
        id: uuid(),
        name: 'Sneak',
        color: '#000000',
      }),
      'forbidden',
    )
  })

  it('update narrates NOTHING and keeps name_lower in step', async () => {
    const t = newT()
    const f = await withOrg(t)
    const label = await plantLabel(t, f.org.id, 'Bug')
    const other = await plantLabel(t, f.org.id, 'Feature')
    await as(t, f.admin).mutation(api.labels.update, {
      org_id: f.org.id,
      id: label.id,
      patch: { name: 'Defect', color: '#111111' },
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('labels')
        .withIndex('by_uuid', (q) => q.eq('id', label.id))
        .unique(),
    )
    expect(row?.name).toBe('Defect')
    expect(row?.name_lower).toBe('defect')
    expect(row?.color).toBe('#111111')
    expect(await activityFor(t, f.org.id)).toEqual([])
    await expectRefusal(
      as(t, f.admin).mutation(api.labels.update, {
        org_id: f.org.id,
        id: label.id,
        patch: { name: 'FEATURE' },
      }),
      'rule',
      /already exists/,
    )
    // a case-only rename of itself is not "taken" by its own row
    await as(t, f.admin).mutation(api.labels.update, {
      org_id: f.org.id,
      id: other.id,
      patch: { name: 'FEATURE' },
    })
  })

  it('toggle attaches then detaches, narrating against the issue', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const label = await plantLabel(t, f.org.id, 'Bug')
    const pairs = () =>
      t.run(async (ctx) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
          .collect(),
      )
    await as(t, f.user).mutation(api.labels.toggle, {
      org_id: f.org.id,
      issue_id: issue.id,
      label_id: label.id,
    })
    expect(await pairs()).toHaveLength(1)
    await as(t, f.user).mutation(api.labels.toggle, {
      org_id: f.org.id,
      issue_id: issue.id,
      label_id: label.id,
    })
    expect(await pairs()).toHaveLength(0)
    const events = await activityFor(t, f.org.id)
    expect(events.map((e) => e.verb)).toEqual(['labeled', 'removed a label from'])
    for (const e of events) {
      expect(e).toMatchObject({
        target_type: 'issue',
        target_id: issue.id,
        label: issue.title,
        detail: `— ${label.name}`,
        project_id: issue.project_id,
      })
    }
  })

  it('toggle refuses a foreign label with the 0078 sentence, verbatim', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const foreign = await plantLabel(t, f.otherOrg.id, 'Elsewhere')
    const refusal = await expectRefusal(
      as(t, f.user).mutation(api.labels.toggle, {
        org_id: f.org.id,
        issue_id: issue.id,
        label_id: foreign.id,
      }),
      'rule',
    )
    expect(refusal.data.message).toBe('label and task must belong to the same organization')
    // a viewer never writes labels onto issues
    const label = await plantLabel(t, f.org.id, 'Bug')
    await expectRefusal(
      as(t, f.viewer).mutation(api.labels.toggle, {
        org_id: f.org.id,
        issue_id: issue.id,
        label_id: label.id,
      }),
      'forbidden',
    )
  })

  it('remove cascades issue_labels and narrates the deletion', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const label = await plantLabel(t, f.org.id, 'Bug')
    await as(t, f.user).mutation(api.labels.toggle, {
      org_id: f.org.id,
      issue_id: issue.id,
      label_id: label.id,
    })
    await drainActivity(t)
    await as(t, f.admin).mutation(api.labels.remove, { org_id: f.org.id, id: label.id })
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_label', (q) => q.eq('label_id', label.id))
          .collect(),
      ),
    ).toEqual([])
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ verb: 'deleted label', target_type: 'org', label: 'Bug' })
  })
})

describe('prefs — self-service blob', () => {
  it('save upserts with an updated_at stamp; get is fenced to own seats', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.prefs.save, {
      profile_id: f.admin.id,
      prefs: { roadmapWin: [0, 12] },
    })
    const first = await as(t, f.admin).query(api.prefs.get, { profile_id: f.admin.id })
    expect(first?.prefs).toEqual({ roadmapWin: [0, 12] })
    const stamp = first?.updated_at
    await tick()
    await as(t, f.admin).mutation(api.prefs.save, {
      profile_id: f.admin.id,
      prefs: { roadmapWin: [4, 16] },
    })
    const second = await as(t, f.admin).query(api.prefs.get, { profile_id: f.admin.id })
    expect(second?.prefs).toEqual({ roadmapWin: [4, 16] })
    expect(second?.updated_at).not.toBe(stamp)
    // one row, not two
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('user_prefs')
          .withIndex('by_profile', (q) => q.eq('profile_id', f.admin.id))
          .collect(),
      ),
    ).toHaveLength(1)
    // another seat's prefs do not exist for me
    await expectRefusal(as(t, f.user).query(api.prefs.get, { profile_id: f.admin.id }), 'not_found')
    await expectRefusal(
      as(t, f.user).mutation(api.prefs.save, { profile_id: f.admin.id, prefs: {} }),
      'not_found',
    )
    // no seat ever reads null-for-missing as an error
    expect(await as(t, f.user).query(api.prefs.get, { profile_id: f.user.id })).toBeNull()
  })
})

describe('tokens — agent keys are the admin’s, MCP tokens are yours', () => {
  const mintArgs = (f: OrgFixture, over: Record<string, string> = {}) => ({
    org_id: f.org.id,
    id: uuid(),
    agent_id: f.agent.id,
    name: 'CI key',
    key_prefix: 'qva_012...abcde',
    key_hash: HEX64,
    ...over,
  })

  it('createAgentKey narrates against the AGENT with curly quotes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = mintArgs(f)
    expect(await as(t, f.admin).mutation(api.tokens.createAgentKey, args)).toEqual({
      id: args.id,
    })
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'created',
      target_type: 'user',
      target_id: f.agent.id,
      label: 'Relay',
      detail: 'a new key “CI key”',
      actor_id: f.admin.id,
    })
    const listed = await as(t, f.admin).query(api.tokens.listAgentKeys, {})
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: args.id,
      agentId: f.agent.id,
      prefix: 'qva_012...abcde',
      revokedAt: null,
    })
    // a non-admin sees no rows at all
    expect(await as(t, f.user).query(api.tokens.listAgentKeys, {})).toEqual([])
    expect(await as(t, f.otherAdmin).query(api.tokens.listAgentKeys, {})).toEqual([])
  })

  it('refuses non-admins, person targets, bad hashes and replayed secrets', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(as(t, f.user).mutation(api.tokens.createAgentKey, mintArgs(f)), 'forbidden')
    await expectRefusal(
      as(t, f.admin).mutation(api.tokens.createAgentKey, mintArgs(f, { agent_id: f.user.id })),
      'not_found',
      /^agent not found$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.tokens.createAgentKey, mintArgs(f, { key_hash: 'QQ' })),
      'bad_request',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.tokens.createAgentKey, mintArgs(f, { name: '  ' })),
      'bad_request',
    )
    await as(t, f.admin).mutation(api.tokens.createAgentKey, mintArgs(f))
    await expectRefusal(
      as(t, f.admin).mutation(api.tokens.createAgentKey, mintArgs(f)),
      'rule',
      /already exists/,
    )
  })

  it('revoke stamps + narrates; delete removes silently; both fenced per org', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = mintArgs(f)
    await as(t, f.admin).mutation(api.tokens.createAgentKey, args)
    await drainActivity(t)
    expect(
      await as(t, f.admin).mutation(api.tokens.revokeAgentKey, { org_id: f.org.id, id: args.id }),
    ).toBe(true)
    const events = await activityFor(t, f.org.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      verb: 'revoked',
      target_id: f.agent.id,
      label: 'Relay',
      detail: 'the key “CI key”',
    })
    const listed = await as(t, f.admin).query(api.tokens.listAgentKeys, {})
    expect(listed[0].revokedAt).not.toBeNull() // revoked keys stay listed
    // another org's admin cannot even see the key exists
    await expectRefusal(
      as(t, f.otherAdmin).mutation(api.tokens.revokeAgentKey, {
        org_id: f.otherOrg.id,
        id: args.id,
      }),
      'not_found',
    )
    await as(t, f.admin).mutation(api.tokens.deleteAgentKey, { org_id: f.org.id, id: args.id })
    expect(await as(t, f.admin).query(api.tokens.listAgentKeys, {})).toEqual([])
    expect(await activityFor(t, f.org.id)).toHaveLength(1) // delete narrates nothing
  })

  it('MCP tokens are strictly self-service and never narrate', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    expect(
      await as(t, f.user).mutation(api.tokens.createMcpToken, {
        id,
        profile_id: f.user.id,
        name: 'Claude',
        token_prefix: 'qvt_0123456',
        token_hash: HEX64,
      }),
    ).toEqual({ id })
    await expectRefusal(
      as(t, f.user).mutation(api.tokens.createMcpToken, {
        id: uuid(),
        profile_id: f.admin.id,
        name: 'Sneak',
        token_prefix: 'qvt_0123456',
        token_hash: 'cd'.repeat(32),
      }),
      'not_found',
    )
    expect(await as(t, f.user).query(api.tokens.listMcpTokens, {})).toHaveLength(1)
    expect(await as(t, f.admin).query(api.tokens.listMcpTokens, {})).toEqual([])
    await expectRefusal(as(t, f.admin).mutation(api.tokens.revokeMcpToken, { id }), 'not_found')
    expect(await as(t, f.user).mutation(api.tokens.revokeMcpToken, { id })).toBe(true)
    expect((await as(t, f.user).query(api.tokens.listMcpTokens, {}))[0].revokedAt).not.toBeNull()
    expect(await as(t, f.user).mutation(api.tokens.deleteMcpToken, { id })).toBe(true)
    expect(await as(t, f.user).query(api.tokens.listMcpTokens, {})).toEqual([])
    expect(await activityFor(t, f.org.id)).toEqual([]) // token churn is private
  })
})
