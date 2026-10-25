/* Independent regression checks for capability replay and cleanup progress.
 * Only the uploaded metadata omitted by convex-test is supplied by a shim. */
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import authSchema from '../betterAuth/schema'
import http from '../http'
import { CONFLICT_RETRIES } from '../machine/registry'
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

/* What ctx.runMutation rejects with when a mutation kept conflicting
 * (machine/registry.ts isWriteConflict). */
const USER_CONFLICT =
  'Documents read from or written to the "custom_backgrounds" table changed while this ' +
  'mutation was being run and on every subsequent retry. See https://docs.convex.dev/error#1'

/* POSTs the image to `url`. The first `conflicts` finalizeUpload calls fail
 * with Convex's write conflict, which commits nothing. */
async function uploadBackground(
  t: T,
  url: string,
  afterStore?: () => Promise<void>,
  conflicts = 0,
) {
  const route = http.lookup(new URL(url).pathname, 'POST')!
  const handler = route[0] as unknown as {
    _handler(ctx: ActionCtx, request: Request): Promise<Response>
  }
  const finalize = getFunctionName(internal.appearance.finalizeUpload)
  let response: Response | undefined
  await t.action(async (ctx) => {
    response = await handler._handler(
      {
        ...ctx,
        runMutation: ((mutation, ...args) => {
          if (getFunctionName(mutation) === finalize && conflicts > 0) {
            conflicts--
            return Promise.reject(new Error(USER_CONFLICT))
          }
          return ctx.runMutation(mutation, ...args)
        }) as ActionCtx['runMutation'],
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

  it('answers a persisting write conflict without Retry-After, since the URL is spent', async () => {
    // real waits between the retries, the shortest ones, on the fixed clock
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { t, caller } = await setup()
    const ticket = await caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    const busy = await uploadBackground(t, ticket.upload_url, undefined, CONFLICT_RETRIES + 1)
    expect(busy.status).toBe(503)
    expect(busy.headers.get('Retry-After')).toBeNull()
    expect(JSON.parse(await busy.text())).toEqual({
      error: {
        code: 'conflict',
        message:
          'The server was too busy to save the image, and nothing changed. Choose the image again.',
      },
    })
    expect(await t.run((ctx) => ctx.db.query('custom_backgrounds').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.system.query('_storage').collect())).toEqual([])
    // the cleanup freed the reservation, so the URL is spent
    expect((await uploadBackground(t, ticket.upload_url)).status).toBe(404)
    expect(await t.run((ctx) => ctx.db.query('demo_uploads').collect())).toEqual([])
    vi.restoreAllMocks()
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

  it('checks each stored file once and deletes a crashed receiver file after its lease', async () => {
    const { t, fx, issue, authId } = await setup()
    /** One sweep call, and the documents it read. */
    const sweep = (args: { after?: number; cursor?: string } = {}) =>
      t.run(async (ctx) => {
        await ctx.runMutation(internal.demoUploads.sweep, args)
        return (await ctx.meta.getTransactionMetrics()).documentsRead.used
      })
    const legs = () =>
      t.run(async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).filter(
          (job) => job.name === 'demoUploads:sweep' && job.state.kind === 'pending',
        ),
      )
    const attached = await t.run(async (ctx) => {
      const ids = []
      for (let i = 0; i < 100; i++) {
        const storage_id = await ctx.storage.store(new Blob(['kept']) as never)
        await ctx.db.insert('issue_attachments', {
          org_id: issue.org_id,
          id: uuid(),
          issue_id: issue.id,
          name: `${i}.txt`,
          size_bytes: 4,
          storage_id,
          inline: false,
          uploaded_by: fx.admin.id,
          created_at: new Date(NOW).toISOString(),
        })
        ids.push(storage_id)
      }
      return ids
    })
    vi.setSystemTime(NOW + 121_000)
    // The first pass checks 64 files and queues a leg for the rest. A cron
    // run before that leg takes the rest over, and the leg then stops.
    await sweep()
    const [leg] = await legs()
    await sweep()
    expect(await legs()).toHaveLength(1)
    expect(await sweep(leg.args[0] as { after: number })).toBe(1)
    await t.run((ctx) => ctx.scheduler.cancel(leg._id))
    // and so does a leg the previous release queued
    expect(await sweep({ cursor: 'previous release' })).toBe(0)

    // A receiver stores its bytes and crashes before it records them.
    await t.run(async (ctx) => {
      const reserved = await reserveDemoUpload(ctx, {
        authId,
        kind: 'attachment',
        targetId: issue.id,
        bytes: 100,
      })
      await beginDemoUpload(ctx, reserved.id, authId)
    })
    const crashed = await t.run((ctx) => ctx.storage.store(new Blob(['lost']) as never))
    // While its lease runs, a minute's run reads the progress row and the
    // receiving ticket, not the 100 files it checked before.
    vi.setSystemTime(Date.now() + 60_000)
    expect(await sweep()).toBe(2)
    expect(await legs()).toEqual([])
    expect(await t.run((ctx) => ctx.db.system.get(crashed))).not.toBeNull()

    vi.setSystemTime(Date.now() + 121_000)
    await sweep()
    expect(await t.run((ctx) => ctx.db.system.get(crashed))).toBeNull()
    expect(
      (await t.run((ctx) => Promise.all(attached.map((id) => ctx.db.system.get(id))))).every(
        (file) => file !== null,
      ),
    ).toBe(true)
  })

  /* Stores 63 files created at one time and 2 created a millisecond later,
   * none of them recorded, so a page of 64 ends between the last two.
   * convex-test gives an insert 0.001 ms after the one before, which rounds
   * away above 2^52 ms, so there the inserts of one millisecond share a time,
   * as Convex allows. */
  const TIED = 2 ** 52
  async function tiedFiles(t: T) {
    const store = (n: number) =>
      t.run(async (ctx) => {
        const ids = []
        for (let i = 0; i < n; i++) ids.push(await ctx.storage.store(new Blob(['lost']) as never))
        return ids
      })
    vi.setSystemTime(TIED)
    const files = await store(63)
    vi.setSystemTime(TIED + 1)
    files.push(...(await store(2)))
    const times = await t.run((ctx) =>
      Promise.all(files.map(async (id) => (await ctx.db.system.get(id))!._creationTime)),
    )
    expect(times.filter((time) => time === TIED + 1)).toHaveLength(2)
    return files
  }
  /* Those of `files` still stored. */
  const stored = (t: T, files: Id<'_storage'>[]) =>
    t.run(async (ctx) =>
      (await Promise.all(files.map((id) => ctx.db.system.get(id)))).filter(Boolean),
    )

  it('checks a file created at the same time as the last file of a full page', async () => {
    const { t } = await setup()
    const files = await tiedFiles(t)
    vi.setSystemTime(TIED + 121_000)
    await t.mutation(internal.demoUploads.sweep, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await stored(t, files)).toEqual([])
  })

  it('purges a demo only after it checked the file tied with the last file of a page', async () => {
    const { t, authId } = await setup()
    const receipt = await t.run(async (ctx) => {
      const receipt = (await ctx.db
        .query('demo_sessions')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .unique())!
      await ctx.db.patch(receipt._id, { status: 'deleting' })
      return receipt
    })
    const files = await tiedFiles(t)
    const drain = () => t.run((ctx) => drainDemoUploads(ctx, receipt.id))
    vi.setSystemTime(TIED + 2)
    expect(await drain()).toBe(false)
    const barrier = (await t.run((ctx) => ctx.db.get(receipt._id)))!.cleanup_file_after!
    vi.setSystemTime(barrier + 1)
    // a page of 64, then the 65th file, which shares the last one's time
    expect(await drain()).toBe(false)
    expect(await stored(t, files)).toHaveLength(1)
    expect(await drain()).toBe(true)
    expect(await stored(t, files)).toEqual([])
  })

  it('deletes a demo with its crashed receiver bytes without rereading checked files', async () => {
    const { t, fx, issue, authId } = await setup()
    // Another workspace's 200 attached files, which the minute's sweep checked.
    const attached = await t.run(async (ctx) => {
      const ids = []
      for (let i = 0; i < 200; i++) {
        const storage_id = await ctx.storage.store(new Blob(['kept']) as never)
        await ctx.db.insert('issue_attachments', {
          org_id: fx.otherOrg.id,
          id: uuid(),
          issue_id: uuid(),
          name: `${i}.txt`,
          size_bytes: 4,
          storage_id,
          inline: false,
          uploaded_by: fx.otherAdmin.id,
          created_at: new Date(NOW).toISOString(),
        })
        ids.push(storage_id)
      }
      return ids
    })
    vi.setSystemTime(NOW + 121_000)
    await t.mutation(internal.demoUploads.sweep, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    // The demo's receiver stores its bytes and crashes, and the demo expires.
    const { receipt, crashed } = await t.run(async (ctx) => {
      const reserved = await reserveDemoUpload(ctx, {
        authId,
        kind: 'attachment',
        targetId: issue.id,
        bytes: 100,
      })
      await beginDemoUpload(ctx, reserved.id, authId)
      const crashed = await ctx.storage.store(new Blob(['lost']) as never)
      const receipt = (await ctx.db
        .query('demo_sessions')
        .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
        .unique())!
      await ctx.db.patch(receipt._id, { status: 'deleting' })
      return { receipt, crashed }
    })
    vi.setSystemTime(Date.now() + 121_000)
    let read = 0
    let batches = 0
    for (let done = false; !done; batches++) {
      if (batches === 10) throw new Error('the uploads phase did not finish')
      done = await t.run(async (ctx) => {
        const finished = await drainDemoUploads(ctx, receipt.id)
        read += (await ctx.meta.getTransactionMetrics()).documentsRead.used
        return finished
      })
      const progress = (await t.run((ctx) => ctx.db.get(receipt._id)))!
      vi.setSystemTime(
        Math.max(
          Date.now() + 5000,
          progress.cleanup_file_after ?? 0,
          progress.cleanup_file_wait_until ?? 0,
        ),
      )
    }
    expect(await t.run((ctx) => ctx.db.system.get(crashed))).toBeNull()
    expect(
      (await t.run((ctx) => Promise.all(attached.map((id) => ctx.db.system.get(id))))).every(
        (file) => file !== null,
      ),
    ).toBe(true)
    // the barrier and one check, reading the receipt, its ticket and the
    // crashed file, not the 200 checked files and their attachments
    expect(batches).toBe(2)
    expect(read).toBeLessThan(15)
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
    // The first run extends the 100 retained tickets it reads, so the next
    // minute's run reaches the stale one behind them.
    await t.mutation(internal.demoUploads.sweep, {})
    expect(await t.run((ctx) => ctx.db.get(staleId))).not.toBeNull()
    vi.setSystemTime(NOW + 60_000)
    await t.mutation(internal.demoUploads.sweep, {})
    expect(await t.run((ctx) => ctx.db.get(staleId))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('issue_attachments').collect())).toHaveLength(100)
  })
})
