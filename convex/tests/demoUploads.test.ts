import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import http from '../http'
import { DEMO_STORAGE_BYTES, drainDemoUploads } from '../model/demoUploads'
import { as, expectRefusal, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Request {
  constructor(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: unknown },
  )
}
declare class Blob {
  constructor(parts: unknown[], opts?: { type: string })
}
declare class URL {
  constructor(url: string)
  pathname: string
  searchParams: { get(key: string): string | null }
}

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', 'http://localhost:5199')
  vi.stubEnv('CONVEX_SITE_URL', 'https://demo-test.convex.site')
  vi.stubEnv('BETTER_AUTH_SECRET', 'demo-test-secret')
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function setup() {
  const t = newT(),
    fx = await withOrg(t)
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  const receipt = await t.run(async (ctx) => {
    const id = uuid()
    const row = await ctx.db.insert('demo_sessions', {
      id,
      auth_user_id: fx.admin.auth_user_id!,
      org_id: fx.org.id,
      created_at: Date.now(),
      expires_at: Date.now() + 86_400_000,
      status: 'ready',
      seed_version: 1,
      anchor: '2026-09-14',
    })
    return (await ctx.db.get(row))!
  })
  return { t, fx, issue, receipt, caller: as(t, fx.admin) }
}
async function receive(
  t: T,
  url: string,
  afterStore?: (storageId: Id<'_storage'>) => Promise<void>,
) {
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
            await t.run(async (mutation) =>
              mutation.db.patch(id as never, { contentType: 'image/png' } as never),
            )
            await afterStore?.(id)
            return id
          },
        },
      },
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Origin: 'http://localhost:5199' },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
  })
  return response!
}
const uploadArgs = (url: string) => {
  const parsed = new URL(url)
  return {
    id: parsed.pathname.split('/').pop()!,
    minter: parsed.searchParams.get('m')!,
    exp: Number(parsed.searchParams.get('e')),
  }
}

describe('private demo upload boundaries', () => {
  it('uses an owned receiver and refuses arbitrary storage ids or another target', async () => {
    const { t, fx, issue, caller } = await setup()
    const url = await caller.mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    expect(url).toContain('/demo-uploads/')
    const response = await receive(t, url)
    expect(response.status).toBe(200)
    const { storageId } = JSON.parse(await response.text()) as { storageId: Id<'_storage'> }
    const attach = {
      org_id: fx.org.id,
      issue_id: issue.id,
      id: uuid(),
      storage_id: storageId,
      name: 'test.png',
      inline: false,
    }
    const otherIssue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
    await expectRefusal(
      caller.mutation(api.files.attach, { ...attach, issue_id: otherIssue.id }),
      'forbidden',
      /belong/,
    )
    await expectRefusal(
      caller.mutation(api.files.setAvatar, { profile_id: fx.admin.id, storage_id: storageId }),
      'forbidden',
      /belong/,
    )
    const random = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([9])]) as never))
    await expectRefusal(
      caller.mutation(api.files.attach, { ...attach, storage_id: random }),
      'forbidden',
      /belong/,
    )
    expect(await caller.mutation(api.files.attach, attach)).toHaveProperty('attachment')
    expect((await receive(t, url)).status).toBe(400)
    expect(await t.run((ctx) => ctx.db.system.get(storageId))).not.toBeNull()
  })

  it('denies saved file URLs exactly at expiry and deletes a late upload', async () => {
    const { t, fx, issue, receipt, caller } = await setup()
    const url = await caller.mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    const response = await receive(t, url)
    const { storageId } = JSON.parse(await response.text()) as { storageId: Id<'_storage'> }
    const id = uuid()
    await caller.mutation(api.files.attach, {
      org_id: fx.org.id,
      issue_id: issue.id,
      id,
      storage_id: storageId,
      name: 'file.png',
      inline: true,
    })
    expect(
      await t.query(internal.files.gatewayAttachment, { id, minter: fx.admin.id }),
    ).not.toBeNull()
    const lateUrl = await caller.mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    let lateId: Id<'_storage'> | undefined
    const late = await receive(t, lateUrl, async (sid) => {
      lateId = sid
      await t.run((ctx) => ctx.db.patch(receipt._id, { expires_at: Date.now() }))
    })
    expect(late.status).toBe(400)
    expect(await t.run((ctx) => ctx.db.system.get(lateId!))).toBeNull()
    expect(await t.query(internal.files.gatewayAttachment, { id, minter: fx.admin.id })).toBeNull()
    await expectRefusal(caller.query(api.snapshot.forMe, {}), 'forbidden', /expired/)
  })

  it('reserves simultaneous upload quota and waits for receiving work during purge', async () => {
    const { t, fx, issue, receipt, caller } = await setup()
    const urls = await Promise.all(
      Array.from({ length: 10 }, () =>
        caller.mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id }),
      ),
    )
    await expectRefusal(
      caller.mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id }),
      'rule',
      /50 MiB/,
    )
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query('demo_uploads').collect()).reduce(
          (sum, x) => sum + x.reserved_bytes,
          0,
        ),
      ),
    ).toBe(DEMO_STORAGE_BYTES)
    const upload = uploadArgs(urls[0])
    await t.mutation(internal.demoUploads.begin, upload)
    expect(await t.run((ctx) => drainDemoUploads(ctx, receipt.id))).toBe(false)
    await t.mutation(internal.demoUploads.abandon, { id: upload.id, minter: upload.minter })
    expect(await t.run((ctx) => drainDemoUploads(ctx, receipt.id))).toBe(false)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 120_001)
    expect(await t.run((ctx) => drainDemoUploads(ctx, receipt.id))).toBe(true)
  })

  it('caps pre-auth admissions durably and closes admission without disabling cleanup', async () => {
    const t = newT()
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => t.mutation(internal.demoUploads.admit, {})),
    )
    expect(answers.filter(Boolean)).toHaveLength(10)
    vi.stubEnv('DEMO_ADMISSION_OPEN', 'false')
    expect(await t.mutation(internal.demoUploads.admit, {})).toBe(false)
    const file = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([1])]) as never))
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 180_000)
    await t.mutation(internal.demoUploads.sweep, {})
    expect(await t.run((ctx) => ctx.db.system.get(file))).toBeNull()
  })
})
