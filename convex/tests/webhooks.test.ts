import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { profileCanSeeProject } from '../lib/access'
import type { EventOwner } from '../lib/taskEvents'
import { deleteIssueDeep } from '../model/cascade'
import { notifyCommentInsert, notifyIssueInsert, notifyIssueUpdate } from '../model/messages'
import {
  as,
  expectRefusal,
  flushWebhookEvents,
  newT,
  plantIssue,
  uuid,
  withOrg,
} from './helpers.setup'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-10-04T12:00:00Z')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function fixture() {
  const t = newT({ transactionLimits: true })
  const fx = await withOrg(t)
  const owner = await t.run(async (ctx): Promise<EventOwner> => {
    const id = uuid()
    const row = await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: fx.guest.id,
      name: 'Events',
      token_prefix: 'qvt_test',
      token_hash: 'test',
      created_at: new Date().toISOString(),
    })
    return {
      profile_id: fx.guest.id,
      credential_table: 'mcp_tokens',
      credential_id: id,
      credential_row_id: row,
    }
  })
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  const subscribe = async (
    name: 'task.updated' | 'task.created' | 'task.deleted' | 'comment.created',
    filters: { task_id?: string; project_id?: string } = {},
    expires_at: number | null = Date.now() + 60_000,
  ) => {
    const id = uuid()
    await t.mutation(internal.webhooks.save, {
      owner,
      id,
      name,
      filters,
      url: 'https://receiver.example/events',
      encrypted_secret: 'encrypted-test-key',
      expires_at: expires_at ?? undefined,
    })
    return id
  }
  const rows = () => t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
  const update = async (patch: Partial<Doc<'issues'>>, expand = true) => {
    await t.run(async (ctx) => {
      const before = (await ctx.db.get(issue._id))!
      await ctx.db.patch(issue._id, patch)
      const after = (await ctx.db.get(issue._id))!
      await notifyIssueUpdate(ctx, { before, after, actor: fx.user, now: new Date().toISOString() })
    })
    if (expand) await flushWebhookEvents(t)
  }
  return { t, fx, owner, issue, subscribe, rows, update }
}

describe('durable task events', () => {
  it('keeps task references valid when event hooks load before the machine API', async () => {
    vi.resetModules()
    await import('../model/taskEvents')
    const { parseIssueRef, issueKey } = await import('../lib/core')
    expect(issueKey(482)).toBe('QN-482')
    expect(parseIssueRef('QN-482')).toEqual({ num: 482 })
    expect(parseIssueRef('qn-482')).toEqual({ num: 482 })
    expect(parseIssueRef('482')).toEqual({ num: 482 })
    expect(parseIssueRef('undefined-482')).toBeNull()
    expect(parseIssueRef('QN-0')).toBeNull()
  })

  it('queues matching field changes, skips no-ops and detects removed optional fields', async () => {
    const f = await fixture()
    await f.subscribe('task.updated', { task_id: f.issue.id, project_id: f.fx.sub.id })
    await f.subscribe('task.updated', { project_id: f.fx.sub2.id })
    await f.update({ title: f.issue.title })
    expect(await f.rows()).toHaveLength(0)
    await f.update({ due_date: '2026-10-12' })
    await f.update({ due_date: undefined })
    const rows = await f.rows()
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[1].payload)).toMatchObject({
      name: 'task.updated',
      cursor: null,
      data: { task_id: f.issue.id, changed_fields: ['due_date'] },
    })
    expect(rows[0].payload).not.toContain('encrypted-test-key')
  })

  it('emits create, comment and delete through the shared model hooks', async () => {
    const f = await fixture()
    for (const name of ['task.created', 'comment.created', 'task.deleted'] as const)
      await f.subscribe(name)
    await f.t.run(async (ctx) => {
      const a = { issue: f.issue, actor: f.fx.user, now: new Date().toISOString() }
      await notifyIssueInsert(ctx, a)
      await notifyCommentInsert(ctx, { ...a, comment: { body: 'A comment with private content' } })
    })
    await flushWebhookEvents(f.t)
    await f.t.run((ctx) =>
      deleteIssueDeep(ctx, { issue: f.issue, actor: f.fx.user, now: new Date().toISOString() }),
    )
    await flushWebhookEvents(f.t)
    const rows = await f.rows()
    expect(rows.map((row) => row.name)).toEqual(['task.created', 'comment.created', 'task.deleted'])
    expect(rows[1].payload).not.toContain('private content')
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[0].id })).toBeNull()
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[2].id })).not.toBeNull()
  })

  it('refuses unreadable filters and another credential cannot delete a subscription', async () => {
    const f = await fixture()
    await expectRefusal(
      f.t.query(internal.webhooks.authorize, {
        owner: f.owner,
        filters: { project_id: f.fx.hidden.id },
      }),
      'not_found',
      /project not found/,
    )
    const id = await f.subscribe('task.updated')
    const other = await f.t.run(async (ctx): Promise<EventOwner> => {
      const id = uuid()
      const row = await ctx.db.insert('mcp_tokens', {
        id,
        profile_id: f.fx.guest.id,
        name: 'Other',
        token_prefix: 'qvt_other',
        token_hash: 'other',
        created_at: new Date().toISOString(),
      })
      return { ...f.owner, credential_id: id, credential_row_id: row }
    })
    await expectRefusal(
      f.t.mutation(internal.webhooks.remove, { owner: other, id }),
      'not_found',
      /subscription not found/,
    )
    await f.t.mutation(internal.webhooks.remove, { owner: f.owner, id })
    await f.t.mutation(internal.webhooks.remove, { owner: f.owner, id })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toEqual([])
  })

  it('checks access again before delivery and blocks revoked credentials', async () => {
    const f = await fixture()
    await f.subscribe('task.updated')
    await f.update({ title: 'Changed' })
    const row = (await f.rows())[0]
    await f.t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', f.fx.meta.id))
        .filter((q) => q.eq(q.field('profile_id'), f.fx.guest.id))
        .first()
      await ctx.db.delete(grant!._id)
    })
    expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).toBeNull()
    expect((await f.rows())[0].status).toBe('failed')
    await f.t.run(async (ctx) => {
      const token = await ctx.db.query('mcp_tokens').first()
      await ctx.db.patch(token!._id, { revoked_at: new Date().toISOString() })
    })
    await expectRefusal(
      f.t.query(internal.webhooks.list, { owner: f.owner }),
      'forbidden',
      /Credential/,
    )
  })

  it('shares profile permissions without granting a revoked credential another credential’s access', async () => {
    const f = await fixture()
    const valid = await f.subscribe('task.updated', {}, null)
    const credential = await f.t.run(async (ctx) => {
      const id = uuid()
      const row = await ctx.db.insert('mcp_tokens', {
        id,
        profile_id: f.fx.guest.id,
        name: 'Second credential',
        token_prefix: 'qvt_second',
        token_hash: 'second',
        created_at: new Date().toISOString(),
      })
      return { owner: { ...f.owner, credential_id: id, credential_row_id: row }, row }
    })
    await f.t.mutation(internal.webhooks.save, {
      owner: credential.owner,
      id: uuid(),
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/second',
      encrypted_secret: 'second-key',
    })
    await f.t.run((ctx) => ctx.db.patch(credential.row, { revoked_at: new Date().toISOString() }))
    await f.update({ title: 'Only the valid credential receives this change' })
    expect(await f.rows()).toMatchObject([{ subscription_id: valid }])
    expect(await f.rows()).toHaveLength(1)
  })

  it('uses leases, retries with the same event ID, and stops only the event on 410', async () => {
    const f = await fixture()
    await f.subscribe('task.updated')
    await f.update({ title: 'Changed' })
    const row = (await f.rows())[0]
    const first = await f.t.mutation(internal.webhooks.claim, { id: row.id })
    expect(first?.attempt).toBe(1)
    expect((await f.rows())[0]).toMatchObject({
      lease_until: Date.now() + 60_000,
      scheduled_for: Date.now() + 60_000,
    })
    expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).toBeNull()
    await f.t.mutation(internal.webhooks.finish, {
      id: row.id,
      attempt: 1,
      status: 503,
    })
    expect((await f.rows())[0]).toMatchObject({
      status: 'pending',
      lease_until: Date.now() + 10_000,
      scheduled_for: Date.now() + 10_000,
    })
    const subscription = await f.t.query(internal.webhooks.list, { owner: f.owner })
    vi.setSystemTime(Date.now() + 10_001)
    const second = await f.t.mutation(internal.webhooks.claim, { id: row.id })
    expect(second?.attempt).toBe(2)
    expect(second?.delivery.payload).toBe(first?.delivery.payload)
    await f.t.mutation(internal.webhooks.finish, {
      id: row.id,
      attempt: 1,
      status: 200,
    })
    expect((await f.rows())[0].status).toBe('sending')
    await f.t.mutation(internal.webhooks.finish, {
      id: row.id,
      attempt: 2,
      status: 410,
    })
    const completed = (await f.rows())[0]
    expect(completed).toMatchObject({ status: 'failed', last_status: 410 })
    expect(completed).not.toHaveProperty('scheduled_for')
    expect(completed).not.toHaveProperty('lease_until')
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toEqual(subscription)
    await f.update({ title: 'Next event remains deliverable' })
    expect(
      await f.t.mutation(internal.webhooks.claim, { id: (await f.rows())[1].id }),
    ).not.toBeNull()
  })

  it('refreshes one subscription, hides encrypted keys and stops expired or unsubscribed work', async () => {
    const f = await fixture()
    const id = await f.subscribe('task.updated')
    await f.t.mutation(internal.webhooks.save, {
      owner: f.owner,
      id,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'new-key',
      expires_at: Date.now() + 30_000,
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toHaveLength(1)
    expect(
      JSON.stringify(await f.t.query(internal.webhooks.list, { owner: f.owner })),
    ).not.toContain('new-key')
    await f.update({ title: 'Changed' })
    await f.t.mutation(internal.webhooks.remove, { owner: f.owner, id })
    expect(await f.t.mutation(internal.webhooks.claim, { id: (await f.rows())[0].id })).toBeNull()
    await f.subscribe('task.updated')
    vi.setSystemTime(Date.now() + 60_001)
    await f.update({ title: 'Expired change' })
    expect(await f.rows()).toHaveLength(1)
  })

  it('keeps indefinite subscriptions through quiet periods and clears failures on acknowledgment', async () => {
    const f = await fixture()
    await f.subscribe('task.updated', {}, null)
    await f.update({ title: 'First failure' })
    const first = (await f.rows())[0]
    await f.t.mutation(internal.webhooks.claim, { id: first.id })
    await f.t.mutation(internal.webhooks.finish, {
      id: first.id,
      attempt: 1,
      status: 400,
    })
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000)
    await f.t.mutation(internal.webhooks.sweep, {})
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { status: 'active', refreshBefore: null, last_status: 400 },
    ])
    const health = await f.t.query(internal.webhooks.list, { owner: f.owner })
    await f.update({ title: 'This event is no longer wanted' })
    const abandoned = (await f.rows()).at(-1)!
    await f.t.mutation(internal.webhooks.claim, { id: abandoned.id })
    await f.t.mutation(internal.webhooks.finish, {
      id: abandoned.id,
      attempt: 1,
      status: 410,
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toEqual(health)
    await f.update({ title: 'Recovered' })
    const next = (await f.rows()).at(-1)!
    await f.t.mutation(internal.webhooks.claim, { id: next.id })
    await f.t.mutation(internal.webhooks.finish, {
      id: next.id,
      attempt: 1,
      status: 204,
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { status: 'active', failed_since: null, last_status: 204 },
    ])
    await f.update({ title: 'A new failure' })
    const failed = (await f.rows()).at(-1)!
    await f.t.mutation(internal.webhooks.claim, { id: failed.id })
    await f.t.mutation(internal.webhooks.finish, {
      id: failed.id,
      attempt: 1,
      status: 503,
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { status: 'active', failed_since: new Date().toISOString() },
    ])
  })

  it('disables on a further failure after seven days, retains the reason and blocks queued and new work', async () => {
    const f = await fixture()
    await f.subscribe('task.updated', {}, null)
    await f.update({ title: 'First failure' })
    const first = (await f.rows())[0]
    await f.t.mutation(internal.webhooks.claim, { id: first.id })
    await f.t.mutation(internal.webhooks.finish, {
      id: first.id,
      attempt: 1,
      status: 400,
    })
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000)
    await f.update({ title: 'Still failing' })
    await f.update({ title: 'Queued before disable' })
    const rows = await f.rows()
    await f.t.mutation(internal.webhooks.claim, { id: rows[1].id })
    await f.t.mutation(internal.webhooks.finish, {
      id: rows[1].id,
      attempt: 1,
      status: 503,
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { status: 'disabled', disabled_reason: 'delivery_failures', last_status: 503 },
    ])
    expect(await f.t.mutation(internal.webhooks.claim, { id: rows[2].id })).toBeNull()
    await f.update({ title: 'No new deliveries' })
    expect(await f.rows()).toHaveLength(3)
    await f.t.mutation(internal.webhooks.sweep, {})
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toHaveLength(1)
  })

  it('preserves retryable in-flight work and counts its health through active renewal', async () => {
    const f = await fixture()
    const id = await f.subscribe('task.updated', {}, null)
    await f.update({ title: 'Old request' })
    const row = (await f.rows())[0]
    await f.t.mutation(internal.webhooks.claim, { id: row.id })
    await f.t.mutation(internal.webhooks.save, {
      owner: f.owner,
      id,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'new-key',
    })
    await f.t.mutation(internal.webhooks.finish, {
      id: row.id,
      attempt: 1,
      status: 503,
    })
    expect((await f.rows())[0]).toMatchObject({ status: 'pending', attempts: 1 })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      {
        id,
        status: 'active',
        failed_since: new Date().toISOString(),
        last_status: 503,
        refreshBefore: null,
      },
    ])
    vi.setSystemTime(Date.now() + 10_000)
    const retried = await f.t.mutation(internal.webhooks.claim, { id: row.id })
    expect(retried?.attempt).toBe(2)
    expect(retried?.subscription.encrypted_secret).toBe('new-key')
    expect(retried?.delivery.payload).toBe(row.payload)
    await f.t.mutation(internal.webhooks.finish, {
      id: row.id,
      attempt: 2,
      status: 204,
    })
    const completed = (await f.rows())[0]
    expect(completed).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(completed).not.toHaveProperty('scheduled_for')
    expect(completed).not.toHaveProperty('lease_until')
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { id, status: 'active', failed_since: null, last_status: 204 },
    ])
  })

  it.each(['pending', 'failed reply', 'successful reply'] as const)(
    'does not attach %s to a deleted and recreated registration',
    async (kind) => {
      const f = await fixture()
      const id = await f.subscribe('task.updated', {}, null)
      await f.update({ title: 'Original registration event' })
      const original = (await f.rows())[0]
      if (kind !== 'pending')
        expect(await f.t.mutation(internal.webhooks.claim, { id: original.id })).not.toBeNull()
      await f.t.mutation(internal.webhooks.remove, { owner: f.owner, id })
      await f.t.mutation(internal.webhooks.save, {
        owner: f.owner,
        id,
        name: 'task.updated',
        filters: {},
        url: 'https://receiver.example/events',
        encrypted_secret: 'replacement-key',
      })
      if (kind === 'pending')
        expect(await f.t.mutation(internal.webhooks.claim, { id: original.id })).toBeNull()
      else
        await f.t.mutation(internal.webhooks.finish, {
          id: original.id,
          attempt: 1,
          status: kind === 'successful reply' ? 204 : 503,
        })
      const completed = (await f.rows())[0]
      expect(completed.status).toBe(kind === 'successful reply' ? 'delivered' : 'failed')
      expect(completed).not.toHaveProperty('scheduled_for')
      expect(completed).not.toHaveProperty('lease_until')
      expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
        { id, status: 'active', failed_since: null, last_status: null, last_success_at: null },
      ])
      await f.update({ title: 'New registration event' })
      const next = (await f.rows()).at(-1)!
      expect(next.subscription_row_id).not.toBe(original.subscription_row_id)
      expect(await f.t.mutation(internal.webhooks.claim, { id: next.id })).not.toBeNull()
    },
  )

  it('replaces an expired registration before retention cleanup and leaves its old work stopped', async () => {
    const f = await fixture()
    const id = await f.subscribe('task.updated', {}, Date.now() + 1_000)
    for (const title of ['Pending before expiry', 'Retry before expiry', 'In flight before expiry'])
      await f.update({ title })
    const [pending, retry, sending] = await f.rows()
    await f.t.mutation(internal.webhooks.claim, { id: retry.id })
    await f.t.mutation(internal.webhooks.finish, {
      id: retry.id,
      attempt: 1,
      status: 503,
    })
    await f.t.mutation(internal.webhooks.claim, { id: sending.id })

    vi.setSystemTime(Date.now() + 2_000)
    await f.t.mutation(internal.webhooks.save, {
      owner: f.owner,
      id,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'new-registration-key',
    })
    const replacement = (await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first()))!
    expect(replacement._id).not.toBe(pending.subscription_row_id)
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).not.toContainEqual(
      expect.objectContaining({ subscription_row_id: pending.subscription_row_id }),
    )
    expect(replacement).not.toHaveProperty('previous_secret')
    expect(replacement).not.toHaveProperty('rotation_until')
    expect(await f.t.mutation(internal.webhooks.claim, { id: pending.id })).toBeNull()
    await f.t.mutation(internal.webhooks.finish, {
      id: sending.id,
      attempt: 1,
      status: 503,
    })
    vi.setSystemTime(Date.now() + 10_000)
    expect(await f.t.mutation(internal.webhooks.claim, { id: retry.id })).toBeNull()
    expect((await f.rows()).map((row) => row.status)).toEqual(['failed', 'failed', 'failed'])
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { id, status: 'active', failed_since: null, last_status: null },
    ])

    await f.update({ title: 'First event after expiry renewal' })
    const next = (await f.rows()).at(-1)!
    expect(next.subscription_row_id).toBe(replacement._id)
    expect(await f.t.mutation(internal.webhooks.claim, { id: next.id })).not.toBeNull()
    await f.t.mutation(internal.webhooks.finish, {
      id: next.id,
      attempt: 1,
      status: 204,
    })
    expect((await f.rows()).at(-1)).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  it('refuses legacy queued work without an exact registration binding', async () => {
    const f = await fixture()
    await f.subscribe('task.updated', {}, null)
    await f.update({ title: 'Legacy delivery' })
    const row = (await f.rows())[0]
    await f.t.run((ctx) => ctx.db.patch(row._id, { subscription_row_id: undefined }))
    expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).toBeNull()
    const completed = (await f.rows())[0]
    expect(completed).toMatchObject({ status: 'failed', attempts: 0 })
    expect(completed).not.toHaveProperty('scheduled_for')
    expect(completed).not.toHaveProperty('lease_until')
  })

  it.each(['event', 'expansion', 'delivery'] as const)(
    'requires both move projects at the %s stage',
    async (stage) => {
      for (const lost of ['source', 'destination'] as const) {
        const f = await fixture()
        await f.t.run(async (ctx) => {
          const inherited = await ctx.db
            .query('project_access')
            .withIndex('by_project_profile', (q) =>
              q.eq('project_id', f.fx.meta.id).eq('profile_id', f.fx.guest.id),
            )
            .unique()
          await ctx.db.delete(inherited!._id)
          for (const project of [f.fx.sub, f.fx.sub2])
            await ctx.db.insert('project_access', {
              project_id: project.id,
              profile_id: f.fx.guest.id,
              level: 'user',
            })
        })
        await f.subscribe('task.updated', { project_id: f.fx.sub2.id }, null)
        const revoke = () =>
          f.t.run(async (ctx) => {
            const project = lost === 'source' ? f.fx.sub : f.fx.sub2
            const grant = await ctx.db
              .query('project_access')
              .withIndex('by_project_profile', (q) =>
                q.eq('project_id', project.id).eq('profile_id', f.fx.guest.id),
              )
              .unique()
            await ctx.db.delete(grant!._id)
            expect(await profileCanSeeProject(ctx, f.fx.guest, project)).toBe(false)
          })
        if (stage === 'event') await revoke()
        await as(f.t, f.fx.user).mutation(api.issues.move, {
          org_id: f.fx.org.id,
          id: f.issue.id,
          project_id: f.fx.sub2.id,
        })
        if (stage === 'event') {
          expect(await f.t.run((ctx) => ctx.db.query('webhook_events').collect())).toEqual([])
        } else if (stage === 'expansion') {
          expect(await f.t.run((ctx) => ctx.db.query('webhook_events').collect())).toHaveLength(1)
          await revoke()
        }
        await flushWebhookEvents(f.t)
        if (stage !== 'delivery') expect(await f.rows()).toEqual([])
        else {
          const rows = await f.rows()
          expect(rows).toHaveLength(1)
          expect(rows[0].source_project_id).toBe(f.fx.sub.id)
          await revoke()
          expect(await f.t.mutation(internal.webhooks.claim, { id: rows[0].id })).toBeNull()
          expect((await f.rows())[0].status).toBe('failed')
        }
      }
    },
  )

  it('does not give past events to new or replacement registrations', async () => {
    const f = await fixture()
    const original = await f.subscribe('task.updated', {}, null)
    await f.update({ title: 'Before registration change' }, false)
    await f.subscribe('task.updated', {}, null)
    await f.t.mutation(internal.webhooks.remove, { owner: f.owner, id: original })
    await f.t.mutation(internal.webhooks.save, {
      owner: f.owner,
      id: original,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'replacement',
    })
    await flushWebhookEvents(f.t)
    expect(await f.rows()).toEqual([])
    await f.update({ title: 'After registration change' })
    expect(await f.rows()).toHaveLength(2)
  })

  it('keeps routing documents unchanged for ordinary acknowledgments and failures', async () => {
    const f = await fixture()
    await f.subscribe('task.updated', {}, null)
    const subscription = (await f.t.run((ctx) => ctx.db.query('webhook_subscriptions').first()))!
    const attempt = async (title: string, status: number) => {
      await f.update({ title })
      const row = (await f.rows()).at(-1)!
      expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).not.toBeNull()
      await f.t.mutation(internal.webhooks.finish, { id: row.id, attempt: 1, status })
    }
    for (const status of [400, 204, 400]) {
      vi.setSystemTime(Date.now() + 1_000)
      await attempt(`Callback reply ${Date.now()}`, status)
      expect(await f.t.run((ctx) => ctx.db.get(subscription._id))).toEqual(subscription)
      expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
        { last_status: status, failed_since: status === 204 ? null : new Date().toISOString() },
      ])
    }
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000)
    await attempt('Failure after seven days', 503)
    expect(await f.t.run((ctx) => ctx.db.get(subscription._id))).toEqual({
      ...subscription,
      disabled_at: Date.now(),
      disabled_reason: 'delivery_failures',
    })
  })

  it('migrates legacy health without reviving a cleared streak and deletes it with its registration', async () => {
    const f = await fixture()
    const id = await f.subscribe('task.updated', {}, null)
    const legacyFailure = Date.now() - 6 * 24 * 60 * 60_000
    const legacySuccess = legacyFailure - 1_000
    const subscription = await f.t.run(async (ctx) => {
      for (const health of await ctx.db.query('webhook_health').collect())
        await ctx.db.delete(health._id)
      const row = (await ctx.db.query('webhook_subscriptions').first())!
      await ctx.db.patch(row._id, {
        failed_since: legacyFailure,
        last_failure_at: legacyFailure,
        last_success_at: legacySuccess,
        last_status: 400,
      })
      return (await ctx.db.get(row._id))!
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      {
        failed_since: new Date(legacyFailure).toISOString(),
        last_failure_at: new Date(legacyFailure).toISOString(),
        last_success_at: new Date(legacySuccess).toISOString(),
        last_status: 400,
      },
    ])
    await f.update({ title: 'Successful response migrates the legacy state' })
    const delivery = (await f.rows())[0]
    await f.t.mutation(internal.webhooks.claim, { id: delivery.id })
    await f.t.mutation(internal.webhooks.finish, { id: delivery.id, attempt: 1, status: 204 })
    expect(await f.t.run((ctx) => ctx.db.get(subscription._id))).toEqual(subscription)
    const health = await f.t.run((ctx) => ctx.db.query('webhook_health').collect())
    expect(health).toHaveLength(1)
    expect(health[0]).toMatchObject({
      subscription_row_id: subscription._id,
      last_failure_at: legacyFailure,
      last_success_at: Date.now(),
      last_status: 204,
    })
    expect(health[0]).not.toHaveProperty('failed_since')
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      {
        failed_since: null,
        last_failure_at: new Date(legacyFailure).toISOString(),
        last_status: 204,
      },
    ])
    await f.t.mutation(internal.webhooks.remove, { owner: f.owner, id })
    expect(await f.t.run((ctx) => ctx.db.query('webhook_health').collect())).toEqual([])
    await f.t.mutation(internal.webhooks.save, {
      owner: f.owner,
      id,
      name: 'task.updated',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'replacement-key',
    })
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      { failed_since: null, last_failure_at: null, last_success_at: null, last_status: null },
    ])
  })

  it('preserves finite-renewal health and resets only the streak on disabled recovery', async () => {
    const f = await fixture()
    const day = 24 * 60 * 60_000
    const id = await f.subscribe('task.updated', {}, Date.now() + 7 * day)
    const attempt = async (title: string, status: number) => {
      await f.update({ title })
      const row = (await f.rows()).at(-1)!
      expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).not.toBeNull()
      await f.t.mutation(internal.webhooks.finish, { id: row.id, attempt: 1, status })
    }
    await attempt('Acknowledged', 204)
    const successAt = new Date().toISOString()
    vi.setSystemTime(Date.now() + 1_000)
    await attempt('First failure', 400)
    const failedSince = Date.now()
    vi.setSystemTime(failedSince + 6 * day)
    const renew = () =>
      f.t.mutation(internal.webhooks.save, {
        owner: f.owner,
        id,
        name: 'task.updated',
        filters: {},
        url: 'https://receiver.example/events',
        encrypted_secret: 'renewed-key',
        expires_at: Date.now() + 7 * day,
      })
    await renew()
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      {
        status: 'active',
        failed_since: new Date(failedSince).toISOString(),
        last_success_at: successAt,
        last_status: 400,
      },
    ])
    await attempt('Further failure before seven days', 400)
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      {
        status: 'active',
        failed_since: new Date(failedSince).toISOString(),
        last_success_at: successAt,
      },
    ])
    vi.setSystemTime(failedSince + 7 * day)
    await attempt('Further failure at seven days', 503)
    const history = (await f.t.query(internal.webhooks.list, { owner: f.owner }))[0]
    expect(history).toMatchObject({
      status: 'disabled',
      last_status: 503,
      last_success_at: successAt,
    })
    await renew()
    expect(await f.t.query(internal.webhooks.list, { owner: f.owner })).toMatchObject([
      {
        status: 'active',
        failed_since: null,
        disabled_at: null,
        disabled_reason: null,
        last_failure_at: history.last_failure_at,
        last_success_at: successAt,
        last_status: 503,
      },
    ])
  })

  it.each([400, 401, 403, 404, 410, 302])('stops an event on permanent HTTP %s', async (status) => {
    const f = await fixture()
    await f.subscribe('task.updated', {}, null)
    await f.update({ title: 'Permanent response' })
    const row = (await f.rows())[0]
    await f.t.mutation(internal.webhooks.claim, { id: row.id })
    await f.t.mutation(internal.webhooks.finish, { id: row.id, attempt: 1, status })
    expect((await f.rows())[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_status: status,
    })
    expect((await f.rows())[0]).not.toHaveProperty('scheduled_for')
  })

  it.each(['failure', 'crash'] as const)(
    'stops after eight attempts ending in %s',
    async (ending) => {
      const f = await fixture()
      await f.subscribe('task.updated', {}, null)
      await f.update({ title: 'Unavailable callback' })
      const row = (await f.rows())[0]
      for (let attempt = 1; attempt <= 8; attempt++) {
        expect((await f.t.mutation(internal.webhooks.claim, { id: row.id }))?.attempt).toBe(attempt)
        if (attempt < 8 || ending === 'failure')
          await f.t.mutation(internal.webhooks.finish, {
            id: row.id,
            attempt,
            status: 503,
          })
        const current = (await f.rows())[0]
        if (attempt < 8) {
          const retryAt = Date.now() + 10_000 * 2 ** (attempt - 1)
          expect(current).toMatchObject({ status: 'pending', scheduled_for: retryAt })
          vi.setSystemTime(retryAt)
        } else if (ending === 'crash') {
          vi.setSystemTime(current.lease_until!)
          expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).toBeNull()
        }
      }
      const completed = (await f.rows())[0]
      expect(completed).toMatchObject({ status: 'failed', attempts: 8 })
      expect(completed).not.toHaveProperty('scheduled_for')
      expect(completed).not.toHaveProperty('lease_until')
      expect(await f.t.mutation(internal.webhooks.claim, { id: row.id })).toBeNull()
    },
  )
})
