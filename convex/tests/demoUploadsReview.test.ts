/* Independent regression checks for capability replay and cleanup progress.
 * Only the uploaded metadata omitted by convex-test is supplied by a shim. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import authSchema from '../betterAuth/schema'
import http from '../http'
import {
  beginDemoUpload,
  demoUploadFor,
  drainDemoUploads,
  reserveDemoUpload,
  retainDemoUpload,
} from '../model/demoUploads'
import { as, expectRefusal, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Request {
  constructor(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: unknown },
  )
}
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}
const NOW = Date.parse('2026-09-16T12:00:00Z')
const ORIGIN = 'http://localhost:5199'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', ORIGIN)
  vi.stubEnv('CONVEX_SITE_URL', 'https://demo-test.convex.site')
  vi.stubEnv('BETTER_AUTH_SECRET', 'demo-upload-review-secret')
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function setup() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  const fx = await withOrg(t)
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: 'Nora',
        email: `${uuid()}@demo.invalid`,
        emailVerified: false,
        isAnonymous: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  })) as { _id: string }
  await t.run(async (ctx) => {
    await ctx.db.patch(fx.admin._id, { auth_user_id: user._id })
    await ctx.db.insert('demo_sessions', {
      id: uuid(),
      auth_user_id: user._id,
      org_id: fx.org.id,
      created_at: NOW,
      expires_at: NOW + 86_400_000,
      status: 'ready',
    })
  })
  return { t, fx, issue, authId: user._id, caller: as(t, { ...fx.admin, auth_user_id: user._id }) }
}

function jpeg() {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 4, 56, 7, 128, 1, 1, 0x11, 0, 0xff, 0xd9, 0,
  ])
}

async function uploadBackground(t: T, url: string, afterStore?: () => Promise<void>) {
  const route = http.lookup(new URL(url).pathname, 'POST')!
  const handler = route[0] as unknown as {
    _handler(ctx: ActionCtx, request: Request): Promise<Response>
  }
  let response: Response | undefined
  await t.action(async (ctx) => {
    response = await handler._handler(
      {
        ...ctx,
        storage: {
          ...ctx.storage,
          store: async (blob) => {
            const id = await ctx.storage.store(blob)
            await t.run((inner) =>
              inner.db.patch(id as never, { contentType: 'image/jpeg' } as never),
            )
            await afterStore?.()
            return id
          },
        },
      },
      new Request(url, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'image/jpeg' },
        body: jpeg(),
      }),
    )
  })
  return response!
}

describe('demo upload independent review regressions', () => {
  it('rejects a concurrent background URL replay without abandoning the first receiver', async () => {
    const { t, caller } = await setup()
    const ticket = await caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    let replayStatus: number | undefined
    const first = await uploadBackground(t, ticket.upload_url, async () => {
      replayStatus = (await uploadBackground(t, ticket.upload_url)).status
    })
    expect(replayStatus).toBe(404)
    expect(first.status).toBe(200)
    expect(await t.run((ctx) => ctx.db.query('custom_backgrounds').collect())).toHaveLength(1)
  })

  it('releases a canceled pending background reservation immediately', async () => {
    const { t, caller } = await setup()
    for (let i = 0; i < 10; i++) {
      const ticket = await caller.mutation(api.appearance.createUpload, {
        name: 'Changed my mind.jpg',
      })
      await caller.mutation(api.appearance.cancelUpload, { ticket_id: ticket.ticket_id })
    }
    const ticket = await caller.mutation(api.appearance.createUpload, {
      name: 'Actually upload.jpg',
    })
    expect(ticket.upload_url).toContain('/background-uploads/')
    expect(await t.run((ctx) => ctx.db.query('demo_uploads').collect())).toHaveLength(1)
  })

  it('refuses finalization after a receiver lease expires even while the demo remains live', async () => {
    const { t, issue, authId } = await setup()
    const ticket = await t.run(async (ctx) => {
      const reserved = await reserveDemoUpload(ctx, {
        authId,
        kind: 'attachment',
        targetId: issue.id,
        bytes: 100,
      })
      await beginDemoUpload(ctx, reserved.id, authId)
      return (await demoUploadFor(ctx, reserved.id))!
    })
    const file = await t.run((ctx) => ctx.storage.store(new Blob(['late']) as never))
    vi.setSystemTime(ticket.lease_until!)
    await expectRefusal(
      t.run((ctx) => retainDemoUpload(ctx, ticket.id, authId, file)),
      'forbidden',
      /expired/,
    )
  })

  it('finishes its orphan barrier only after pre-barrier bytes have been removed', async () => {
    const { t, authId } = await setup()
    const { receipt, file } = await t.run(async (ctx) => {
      const receipt = (await ctx.db
        .query('demo_sessions')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .unique())!
      await ctx.db.patch(receipt._id, { status: 'deleting' })
      // A worker crashed after storing but before recording its storage id.
      const file = await ctx.storage.store(new Blob(['untracked owner bytes']) as never)
      return { receipt, file }
    })
    expect(await t.run((ctx) => drainDemoUploads(ctx, receipt.id))).toBe(false)
    const barrier = (await t.run((ctx) => ctx.db.get(receipt._id)))!
    vi.setSystemTime(barrier.cleanup_file_after! + 1)
    expect(await t.run((ctx) => drainDemoUploads(ctx, receipt.id))).toBe(true)
    expect(await t.run((ctx) => ctx.db.system.get(file))).toBeNull()
  })

  it('waits for another old receiver before scanning its temporarily untracked bytes', async () => {
    const { t, fx, authId } = await setup()
    const otherAuth = fx.otherAdmin.auth_user_id!
    const { owner, ticket, file } = await t.run(async (ctx) => {
      const owner = (await ctx.db
        .query('demo_sessions')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .unique())!
      await ctx.db.patch(owner._id, { status: 'deleting' })
      await ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: otherAuth,
        org_id: fx.otherOrg.id,
        status: 'ready',
        created_at: NOW,
        expires_at: NOW + 86_400_000,
      })
      const ticket = await reserveDemoUpload(ctx, {
        authId: otherAuth,
        kind: 'preview',
        targetId: uuid(),
        bytes: 100,
      })
      await beginDemoUpload(ctx, ticket.id, otherAuth, true)
      const file = await ctx.storage.store(new Blob(['another receiver output']) as never)
      return { owner, ticket, file }
    })
    expect(await t.run((ctx) => drainDemoUploads(ctx, owner.id))).toBe(false)
    const barrier = (await t.run((ctx) => ctx.db.get(owner._id)))!
    vi.setSystemTime(barrier.cleanup_file_after! + 1)
    expect(await t.run((ctx) => drainDemoUploads(ctx, owner.id))).toBe(false)
    expect(await t.run((ctx) => ctx.db.system.get(file))).not.toBeNull()
    await t.run((ctx) => retainDemoUpload(ctx, ticket.id, otherAuth, file))
    expect(await t.run((ctx) => drainDemoUploads(ctx, owner.id))).toBe(true)
    expect(await t.run((ctx) => ctx.db.system.get(file))).not.toBeNull()
  })

  it('makes expiry-sweep progress past retained attachments', async () => {
    const { t, fx, issue, authId } = await setup()
    const staleId = await t.run(async (ctx) => {
      const receipt = (await ctx.db
        .query('demo_sessions')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .unique())!
      for (let i = 0; i < 100; i++) {
        const storageId = await ctx.storage.store(new Blob(['file']) as never)
        await ctx.db.insert('issue_attachments', {
          org_id: issue.org_id,
          id: uuid(),
          issue_id: issue.id,
          name: `${i}.txt`,
          size_bytes: 4,
          storage_id: storageId,
          inline: false,
          uploaded_by: fx.admin.id,
          created_at: new Date(NOW).toISOString(),
        })
        await ctx.db.insert('demo_uploads', {
          id: uuid(),
          demo_id: receipt.id,
          auth_user_id: authId,
          kind: 'attachment',
          target_id: issue.id,
          expires_at: NOW - 1000,
          reserved_bytes: 4,
          state: 'stored',
          storage_id: storageId,
        })
      }
      return ctx.db.insert('demo_uploads', {
        id: uuid(),
        demo_id: receipt.id,
        auth_user_id: authId,
        kind: 'background',
        target_id: uuid(),
        expires_at: NOW - 1,
        reserved_bytes: 100,
        state: 'pending',
      })
    })
    await t.mutation(internal.demoUploads.sweep, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await t.run((ctx) => ctx.db.get(staleId))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('issue_attachments').collect())).toHaveLength(100)
  })
})
