import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { EventOwner } from '../lib/taskEvents'
import { deleteProjectDeep } from '../model/cascade'
import {
  flushWebhookEvents,
  messagesFor,
  newT,
  plantIssue,
  plantSubscription,
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
  const f = await withOrg(t)
  const owner = await t.run(async (ctx): Promise<EventOwner> => {
    const id = uuid()
    const row = await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: f.admin.id,
      name: 'Cascade events',
      token_prefix: 'qvt_test',
      token_hash: uuid(),
      created_at: new Date().toISOString(),
    })
    return {
      profile_id: f.admin.id,
      credential_table: 'mcp_tokens',
      credential_id: id,
      credential_row_id: row,
    }
  })
  for (const name of ['task.updated', 'task.deleted'] as const) {
    await t.mutation(internal.webhooks.save, {
      owner,
      id: uuid(),
      name,
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'test-only',
    })
  }
  return { t, f }
}

describe('webhooks during project deletion', () => {
  it('queues nothing for tasks in a deleted parent project and its children', async () => {
    const { t, f } = await fixture()
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      parent_id: parent.id,
    })

    await t.run(async (ctx) => {
      await deleteProjectDeep(ctx, {
        project: f.meta,
        actor: f.admin,
        now: new Date().toISOString(),
      })
    })

    expect(await t.run((ctx) => ctx.db.get(parent._id))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(child._id))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('webhook_events').collect())).toEqual([])
    await flushWebhookEvents(t)
    expect(await t.run((ctx) => ctx.db.query('webhook_deliveries').collect())).toEqual([])
  })

  it('keeps the surviving child detach event and inbox notification', async () => {
    const { t, f } = await fixture()
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const doomedChild = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    const survivingChild = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      parent_id: parent.id,
    })
    await plantSubscription(t, { issue_id: survivingChild.id, profile_id: f.guest.id })

    await t.run(async (ctx) => {
      await deleteProjectDeep(ctx, {
        project: f.sub,
        actor: f.admin,
        now: new Date().toISOString(),
      })
    })

    expect(await t.run((ctx) => ctx.db.get(parent._id))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(doomedChild._id))).toBeNull()
    const survivor = await t.run((ctx) => ctx.db.get(survivingChild._id))
    expect(survivor).toMatchObject({
      id: survivingChild.id,
      updated_at: new Date().toISOString(),
    })
    expect(survivor?.parent_id).toBeUndefined()
    await flushWebhookEvents(t)
    const deliveries = await t.run((ctx) => ctx.db.query('webhook_deliveries').collect())
    expect(deliveries).toHaveLength(1)
    expect(JSON.parse(deliveries[0].payload)).toMatchObject({
      name: 'task.updated',
      data: { task_id: survivingChild.id, changed_fields: ['parent_id'] },
    })
    expect((await messagesFor(t, f.guest.id, survivingChild.id)).map((row) => row.detail)).toEqual([
      'Detached from its parent',
    ])
  })
})
