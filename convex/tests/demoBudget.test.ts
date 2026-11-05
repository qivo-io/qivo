/* The private demo's shared 5 MiB (model/demoUploads.ts), with reservations of
 * the declared size against the kind's per-file limit and the free space,
 * sizeless calls from an app loaded before sizes were declared, the
 * receivers' bound and the refusals, which say how much is free and delete
 * nothing. Each case plants the files it needs through the app's own upload
 * path, apart from the fail-safe cases, which plant ledger rows. */
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import authSchema from '../betterAuth/schema'
import http from '../http'
import { BACKGROUND_PREVIEW_VERSION } from '../lib/backgroundPreviews'
import { LIMITS } from '../lib/limits'
import { UPLOAD_SIZE_SHAPE } from '../model/attachments'
import {
  DEMO_BODY_TOO_LONG,
  DEMO_FILE_TOO_LARGE,
  DEMO_FILES_FULL,
  DEMO_STORAGE_BYTES,
  DEMO_UPLOAD_ROWS,
  demoStorageFull,
} from '../model/demoUploads'
import { as, expectRefusal, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'
import { runSteps } from './trash.setup'

declare class Request {
  constructor(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: unknown },
  )
}
declare class URL {
  constructor(url: string)
  pathname: string
}
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const KiB = 1024
const MiB = 1024 * 1024
const NOW = Date.parse('2026-09-16T12:00:00Z')
const ORIGIN = 'http://localhost:5199'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', ORIGIN)
  vi.stubEnv('CONVEX_SITE_URL', 'https://demo-test.convex.site')
  vi.stubEnv('BETTER_AUTH_SECRET', 'demo-budget-secret')
  vi.stubEnv('DEMO_ADMISSION_OPEN', 'true')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

type Demo = Awaited<ReturnType<typeof setup>>

/* A ready demo whose admin is a real anonymous login, as the demo makes. */
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
  const receipt = await t.run(async (ctx) => {
    await ctx.db.patch(fx.admin._id, { auth_user_id: user._id })
    const id = await ctx.db.insert('demo_sessions', {
      id: uuid(),
      auth_user_id: user._id,
      org_id: fx.org.id,
      created_at: NOW,
      expires_at: NOW + 86_400_000,
      status: 'ready',
    })
    return (await ctx.db.get(id))!
  })
  const admin = { ...fx.admin, auth_user_id: user._id }
  return { t, fx, issue, receipt, authId: user._id, admin, caller: as(t, admin) }
}

/* A JPEG header of 1920 × 1080 padded to `size` bytes, which the image
 * checks accept as a background. */
function jpegOf(size: number) {
  const out = new Uint8Array(size)
  out.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 4, 56, 7, 128, 1, 1, 0x11, 0, 0xff, 0xd9])
  return out
}

/* POSTs `body` to upload URL `url` from the app's origin, as `type`, and
 * answers the response. `finishLost` makes the receiver's finish commit and
 * then fail, as when its answer is lost. */
async function post(t: T, url: string, body: Uint8Array, type = 'image/png', finishLost = false) {
  const route = http.lookup(new URL(url).pathname, 'POST')!
  const handler = route[0] as unknown as {
    _handler(ctx: ActionCtx, request: Request): Promise<Response>
  }
  const finish = getFunctionName(internal.demoUploads.finish)
  let response: Response | undefined
  await t.action(async (ctx) => {
    response = await handler._handler(
      {
        ...ctx,
        runMutation: (async (mutation, ...args) => {
          const answer = await ctx.runMutation(mutation, ...args)
          if (finishLost && getFunctionName(mutation) === finish) throw new Error('connection lost')
          return answer
        }) as ActionCtx['runMutation'],
        storage: {
          ...ctx.storage,
          store: async (blob) => {
            const id = await ctx.storage.store(blob)
            await t.run((inner) => inner.db.patch(id as never, { contentType: type } as never))
            return id
          },
        },
      },
      new Request(url, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': type }, body }),
    )
  })
  return response!
}

/* Uploads and attaches a file of `bytes` to `issue`, declaring `declared`. */
async function attachFile(d: Demo, bytes: number, issue = d.issue, declared: number = bytes) {
  const url = await d.caller.mutation(api.files.uploadUrl, {
    org_id: d.fx.org.id,
    issue_id: issue.id,
    size: declared,
    name: 'notes.bin',
  })
  const response = await post(d.t, url, new Uint8Array(bytes))
  expect(response.status).toBe(200)
  const { storageId } = (await response.json()) as { storageId: Id<'_storage'> }
  const id = uuid()
  const out = await d.caller.mutation(api.files.attach, {
    org_id: d.fx.org.id,
    id,
    issue_id: issue.id,
    storage_id: storageId,
    name: 'notes.bin',
    inline: false,
  })
  expect(out).toHaveProperty('attachment')
  return { id, storageId }
}

/* The bytes the demo's live rows store or reserve, and how many rows. */
const ledger = (t: T) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('demo_uploads').collect()
    return { bytes: rows.reduce((sum, row) => sum + row.reserved_bytes, 0), rows: rows.length }
  })

const files = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)

const reserve = (d: Demo, size?: number, issue = d.issue) =>
  d.caller.mutation(api.files.uploadUrl, {
    org_id: d.fx.org.id,
    issue_id: issue.id,
    ...(size === undefined ? {} : { size }),
  })

describe('the private demo shares 5 MiB', () => {
  it('fits ten 400 KiB attachments stored at their sizes, then a 500 KiB picture', async () => {
    const d = await setup()
    for (let i = 0; i < 10; i++) await attachFile(d, 400 * KiB)
    const url = await d.caller.mutation(api.files.avatarUploadUrl, {
      profile_id: d.admin.id,
      size: 500 * KiB,
    })
    const response = await post(d.t, url, new Uint8Array(500 * KiB))
    const { storageId } = (await response.json()) as { storageId: Id<'_storage'> }
    await d.caller.mutation(api.files.setAvatar, { profile_id: d.admin.id, storage_id: storageId })
    expect(await ledger(d.t)).toEqual({ bytes: 4_500 * KiB, rows: 11 })
    expect(DEMO_STORAGE_BYTES).toBe(5_242_880)
  })

  it('reserves up to exactly 5,242,880 bytes and refuses one byte more everywhere, changing nothing', async () => {
    const d = await setup()
    await reserve(d, 3 * MiB)
    await d.caller.mutation(api.files.avatarUploadUrl, {
      profile_id: d.admin.id,
      size: 2 * MiB - 1,
    })
    const past = await expectRefusal(reserve(d, 2), 'rule')
    expect(past.data.message).toBe(demoStorageFull(1))
    expect(past.data.message).toContain('less than 0.1 MiB of it is free')
    await reserve(d, 1)
    expect(await ledger(d.t)).toEqual({ bytes: 5_242_880, rows: 3 })
    const before = { ledger: await ledger(d.t), files: await files(d.t) }
    for (const call of [
      reserve(d, 1),
      d.caller.mutation(api.files.avatarUploadUrl, { profile_id: d.admin.id, size: 1 }),
      d.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg', size: 1 }),
    ]) {
      const refusal = await expectRefusal(call, 'rule')
      expect(refusal.data.message).toBe(
        'the demo stores at most 5 MiB of files in total, and none of it is free. Remove a file, a picture or your background, or delete items for good in Settings → Projects → Deleted items, then try again.',
      )
    }
    expect({ ledger: await ledger(d.t), files: await files(d.t) }).toEqual(before)
    expect(await d.t.run((ctx) => ctx.db.query('background_uploads').collect())).toEqual([])
  })

  it('says how much is free, rounded down to a tenth of a MiB', async () => {
    expect(demoStorageFull(Math.ceil(0.4 * MiB))).toContain(', and 0.4 MiB of it is free. Remove')
    expect(demoStorageFull(Math.ceil(0.4 * MiB) - 1)).toContain(', and 0.3 MiB of it is free.')
    expect(demoStorageFull(0.1 * MiB - 1)).toContain(', and less than 0.1 MiB of it is free.')
    expect(demoStorageFull(0)).toContain(', and none of it is free.')
    expect(demoStorageFull(2 * MiB)).toContain(', and 2 MiB of it is free.')
    // and the refusal says it for what the demo holds
    const d = await setup()
    await reserve(d, DEMO_STORAGE_BYTES - Math.ceil(0.4 * MiB))
    const refusal = await expectRefusal(reserve(d, Math.ceil(0.4 * MiB) + 1), 'rule')
    expect(refusal.data.message).toBe(demoStorageFull(Math.ceil(0.4 * MiB)))
  })

  it('frees what a file stored smaller than declared did not use, and a pending reservation past its expiry', async () => {
    const d = await setup()
    await attachFile(d, 1 * MiB, d.issue, 4 * MiB)
    expect(await ledger(d.t)).toEqual({ bytes: 1 * MiB, rows: 1 })
    await reserve(d, 4 * MiB)
    await expectRefusal(reserve(d, 1), 'rule')
    // the unused reservation stops counting once it expires
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await reserve(d, 4 * MiB)
    expect(await ledger(d.t)).toEqual({ bytes: 5 * MiB, rows: 2 })
  })

  it('frees a removed attachment and a file deleted for good, and counts one in Deleted items', async () => {
    const d = await setup()
    const other = await plantIssue(d.t, { org_id: d.fx.org.id, project_id: d.fx.sub.id })
    const first = await attachFile(d, 2 * MiB)
    await attachFile(d, 2 * MiB, other)
    await expectRefusal(reserve(d, 2 * MiB), 'rule')
    await d.caller.mutation(api.files.removeAttachment, { org_id: d.fx.org.id, id: first.id })
    expect(await d.t.run((ctx) => ctx.db.system.get(first.storageId))).toBeNull()
    await reserve(d, 3 * MiB)
    vi.setSystemTime(Date.now() + 10 * 60_000)
    // a task in Deleted items keeps its file, which keeps counting
    await d.caller.mutation(api.issues.deleteDeep, { org_id: d.fx.org.id, id: other.id })
    await runSteps(d.t)
    const refusal = await expectRefusal(reserve(d, 3.5 * MiB), 'rule')
    expect(refusal.data.message).toBe(demoStorageFull(3 * MiB))
    const [item] = await d.t.run((ctx) => ctx.db.query('deleted_items').collect())
    await d.caller.mutation(api.deletedItems.purge, { org_id: d.fx.org.id, ids: [item.id] })
    await runSteps(d.t)
    await reserve(d, 3.5 * MiB)
  })

  it('reserves the per-file limit or the free space for a call without a size', async () => {
    const d = await setup()
    // an app loaded before uploads declared their size
    await reserve(d)
    expect(await ledger(d.t)).toEqual({ bytes: 5 * MiB, rows: 1 })
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await attachFile(d, 1 * MiB)
    const url = await reserve(d)
    expect(await ledger(d.t)).toEqual({ bytes: 5 * MiB, rows: 2 })
    expect((await post(d.t, url, new Uint8Array(3 * MiB))).status).toBe(200)
    // one small file still fits beside the others, up to the free space
    const avatar = await d.caller.mutation(api.files.avatarUploadUrl, { profile_id: d.admin.id })
    const longer = await post(d.t, avatar, new Uint8Array(1 * MiB + 1))
    expect(longer.status).toBe(400)
    expect(await longer.json()).toEqual({ error: demoStorageFull(1 * MiB) })
    expect(await ledger(d.t)).toEqual({ bytes: 4 * MiB, rows: 2 })
    expect(await files(d.t)).toBe(2)
    const fits = await d.caller.mutation(api.files.avatarUploadUrl, { profile_id: d.admin.id })
    expect((await post(d.t, fits, new Uint8Array(1 * MiB))).status).toBe(200)
    const refusal = await expectRefusal(reserve(d), 'rule')
    expect(refusal.data.message).toBe(demoStorageFull(0))
  })

  it('admits nothing while it holds more than 5 MiB, and deletes nothing', async () => {
    const d = await setup()
    // files stored while the demo allowed 50 MiB
    const stored = await d.t.run(async (ctx) => {
      const ids: Id<'_storage'>[] = []
      for (let i = 0; i < 2; i++) {
        const storage_id = await ctx.storage.store(new Blob([new Uint8Array(3 * MiB)]) as never)
        await ctx.db.insert('demo_uploads', {
          id: uuid(),
          demo_id: d.receipt.id,
          auth_user_id: d.authId,
          kind: 'attachment',
          target_id: d.issue.id,
          reserved_bytes: 3 * MiB,
          expires_at: d.receipt.expires_at,
          state: 'stored',
          storage_id,
        })
        ids.push(storage_id)
      }
      return ids
    })
    const before = { ledger: await ledger(d.t), files: await files(d.t) }
    const refusal = await expectRefusal(reserve(d, 1), 'rule')
    expect(refusal.data.message).toBe(demoStorageFull(0))
    await expectRefusal(reserve(d), 'rule')
    expect({ ledger: await ledger(d.t), files: await files(d.t) }).toEqual(before)
    for (const id of stored) expect(await d.t.run((ctx) => ctx.db.system.get(id))).not.toBeNull()
  })

  it("refuses a declared size over each kind's limit and a size that is not whole bytes", async () => {
    const d = await setup()
    const over = [
      [reserve(d, 5 * MiB + 1), DEMO_FILE_TOO_LARGE],
      [
        d.caller.mutation(api.files.avatarUploadUrl, { profile_id: d.admin.id, size: 2 * MiB + 1 }),
        LIMITS.avatarSize.refusal,
      ],
      [
        d.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg', size: 5 * MiB + 1 }),
        DEMO_FILE_TOO_LARGE,
      ],
    ] as const
    for (const [call, sentence] of over) {
      const refusal = await expectRefusal(call, 'rule')
      expect(refusal.data.message).toBe(sentence)
    }
    expect(DEMO_FILE_TOO_LARGE).toBe('a demo file must be at most 5 MiB. Choose a smaller file.')
    for (const size of [-1, 1.5, Number.NaN]) {
      const refusal = await expectRefusal(reserve(d, size), 'bad_request')
      expect(refusal.data.message).toBe(UPLOAD_SIZE_SHAPE)
    }
    expect(await ledger(d.t)).toEqual({ bytes: 0, rows: 0 })
    // at the limit itself it reserves
    await reserve(d, 5 * MiB)
  })

  it(`refuses an upload once the demo holds ${DEMO_UPLOAD_ROWS} files`, async () => {
    const d = await setup()
    const plant = (count: number) =>
      d.t.run(async (ctx) => {
        for (let i = 0; i < count; i++)
          await ctx.db.insert('demo_uploads', {
            id: uuid(),
            demo_id: d.receipt.id,
            auth_user_id: d.authId,
            kind: 'attachment',
            target_id: d.issue.id,
            reserved_bytes: 1,
            expires_at: d.receipt.expires_at,
            state: 'pending',
          })
      })
    await plant(DEMO_UPLOAD_ROWS - 1)
    await reserve(d, 1)
    const refusal = await expectRefusal(reserve(d, 1), 'rule')
    expect(refusal.data.message).toBe(DEMO_FILES_FULL)
    expect(DEMO_FILES_FULL).toBe(
      'the demo stores at most 200 files. Remove a file, a picture or your background, or delete items for good in Settings → Projects → Deleted items, then try again.',
    )
  })

  it('refuses a body one byte over its declared size in both receivers, keeping nothing', async () => {
    const d = await setup()
    const url = await reserve(d, 100)
    const response = await post(d.t, url, new Uint8Array(101))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: DEMO_BODY_TOO_LONG })
    const ticket = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Lake.jpg',
      size: 100,
    })
    const image = await post(d.t, ticket.upload_url, jpegOf(101), 'image/jpeg')
    expect(image.status).toBe(400)
    expect(await image.json()).toEqual({
      error: { code: 'bad_request', message: DEMO_BODY_TOO_LONG },
    })
    expect(await files(d.t)).toBe(0)
    expect(await ledger(d.t)).toEqual({ bytes: 0, rows: 0 })
    // the declared size itself is stored
    const fits = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Lake.jpg',
      size: 100,
    })
    expect((await post(d.t, fits.upload_url, jpegOf(100), 'image/jpeg')).status).toBe(200)
    expect(await ledger(d.t)).toEqual({ bytes: 100, rows: 1 })
  })

  it('refuses a replacement background that does not fit beside the old one until it is removed', async () => {
    const d = await setup()
    const first = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Lake.jpg',
      size: 3 * MiB,
    })
    expect((await post(d.t, first.upload_url, jpegOf(3 * MiB), 'image/jpeg')).status).toBe(200)
    const refusal = await expectRefusal(
      d.caller.mutation(api.appearance.createUpload, { name: 'Fjord.jpg', size: 3 * MiB }),
      'rule',
    )
    expect(refusal.data.message).toBe(demoStorageFull(2 * MiB))
    await d.caller.mutation(api.appearance.removeCustom, {})
    const second = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Fjord.jpg',
      size: 3 * MiB,
    })
    expect((await post(d.t, second.upload_url, jpegOf(3 * MiB), 'image/jpeg')).status).toBe(200)
  })

  it('refuses exactly one of two reservations sent at once that together pass the budget', async () => {
    const d = await setup()
    const answers = await Promise.allSettled([reserve(d, 3 * MiB), reserve(d, 3 * MiB)])
    expect(answers.map((a) => a.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await ledger(d.t)).toEqual({ bytes: 3 * MiB, rows: 1 })
  })

  it('answers the stored file when the answer of its finish was lost', async () => {
    const d = await setup()
    const url = await reserve(d, 10)
    const response = await post(d.t, url, new Uint8Array(10), 'image/png', true)
    expect(response.status).toBe(200)
    const { storageId } = (await response.json()) as { storageId: Id<'_storage'> }
    expect(await d.t.run((ctx) => ctx.db.system.get(storageId))).not.toBeNull()
    const out = await d.caller.mutation(api.files.attach, {
      org_id: d.fx.org.id,
      id: uuid(),
      issue_id: d.issue.id,
      storage_id: storageId,
      name: 'notes.bin',
      inline: false,
    })
    expect(out).toHaveProperty('attachment')
    expect(await ledger(d.t)).toEqual({ bytes: 10, rows: 1 })
  })
})

describe('a demo upload that never attaches', () => {
  it('stops counting once its reservation expired and the sweep ran, while an attached one keeps counting', async () => {
    const d = await setup()
    const url = await reserve(d, 2 * MiB)
    const loose = (await (await post(d.t, url, new Uint8Array(2 * MiB))).json()) as {
      storageId: Id<'_storage'>
    }
    const kept = await attachFile(d, 2 * MiB)
    await expectRefusal(reserve(d, 2 * MiB), 'rule')
    // within its reservation the unattached file still counts and attaches
    const [row] = await d.t.run((ctx) =>
      ctx.db
        .query('demo_uploads')
        .withIndex('by_storage', (q) => q.eq('storage_id', loose.storageId))
        .collect(),
    )
    expect(row.expires_at).toBeLessThanOrEqual(NOW + 10 * 60_000)
    vi.setSystemTime(row.expires_at + 1)
    await d.t.mutation(internal.demoUploads.sweep, {})
    expect(await d.t.run((ctx) => ctx.db.system.get(loose.storageId))).toBeNull()
    expect(await d.t.run((ctx) => ctx.db.get(row._id))).toBeNull()
    // the attached file stays, counted until the demo ends
    const [used] = await d.t.run((ctx) =>
      ctx.db
        .query('demo_uploads')
        .withIndex('by_storage', (q) => q.eq('storage_id', kept.storageId))
        .collect(),
    )
    expect(used.expires_at).toBe(d.receipt.expires_at)
    expect(await d.t.run((ctx) => ctx.db.system.get(kept.storageId))).not.toBeNull()
    await reserve(d, 3 * MiB)
    await expectRefusal(reserve(d, 1), 'rule')
    // the unattached file's attach is refused once the sweep erased it
    await expectRefusal(
      d.caller.mutation(api.files.attach, {
        org_id: d.fx.org.id,
        id: uuid(),
        issue_id: d.issue.id,
        storage_id: loose.storageId,
        name: 'notes.bin',
        inline: false,
      }),
      'forbidden',
    )
  })
})

describe("a demo background's preview", () => {
  /* Uploads a background of `bytes` and answers the preview job's arguments. */
  async function background(d: Demo, bytes: number) {
    const ticket = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Lake.jpg',
      size: bytes,
    })
    expect((await post(d.t, ticket.upload_url, jpegOf(bytes), 'image/jpeg')).status).toBe(200)
    const [image] = await d.t.run((ctx) => ctx.db.query('custom_backgrounds').collect())
    return { kind: 'custom' as const, id: image.id, storage_id: image.storage_id }
  }
  const skipped = async (d: Demo) =>
    (await d.caller.query(api.appearance.get, {})).custom_image?.preview_skipped
  const webp = (t: T) =>
    t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob([new Uint8Array(100)]) as never)
      await ctx.db.patch(id as never, { contentType: 'image/webp' } as never)
      return id
    })

  it('reserves 1 MiB or the free space, and stores a preview that fits with no mark', async () => {
    const d = await setup()
    const job = await background(d, 3 * MiB)
    await reserve(d, 1.5 * MiB)
    const work = await d.t.mutation(internal.backgroundPreviews.beginDemoWork, job)
    expect(work).toMatchObject({ authId: d.authId, bytes: 0.5 * MiB })
    expect(
      await d.t.mutation(internal.backgroundPreviews.attach, {
        ...job,
        preview_storage_id: await webp(d.t),
        preview_version: BACKGROUND_PREVIEW_VERSION,
        demo_ticket_id: work!.id,
      }),
    ).toBe(true)
    expect(await d.caller.query(api.appearance.get, {})).toMatchObject({
      custom_image: { preview_ready: true, preview_skipped: false },
    })
  })

  it('marks the skip when nothing is free, and a later preview clears it', async () => {
    const d = await setup()
    const job = await background(d, 3 * MiB)
    await reserve(d, 2 * MiB)
    expect(await d.t.mutation(internal.backgroundPreviews.beginDemoWork, job)).toBeNull()
    expect(await skipped(d)).toBe(true)
    expect(await ledger(d.t)).toEqual({ bytes: 5 * MiB, rows: 2 })
    // the reservation expires, and a preview made later clears the mark
    vi.setSystemTime(Date.now() + 10 * 60_000)
    const work = await d.t.mutation(internal.backgroundPreviews.beginDemoWork, job)
    expect(work?.bytes).toBe(1 * MiB)
    await d.t.mutation(internal.backgroundPreviews.attach, {
      ...job,
      preview_storage_id: await webp(d.t),
      preview_version: BACKGROUND_PREVIEW_VERSION,
      demo_ticket_id: work!.id,
    })
    expect(await skipped(d)).toBe(false)
  })

  it('marks the skip when the demo holds 200 files', async () => {
    const d = await setup()
    const job = await background(d, 1 * MiB)
    await d.t.run(async (ctx) => {
      for (let i = 1; i < DEMO_UPLOAD_ROWS; i++)
        await ctx.db.insert('demo_uploads', {
          id: uuid(),
          demo_id: d.receipt.id,
          auth_user_id: d.authId,
          kind: 'attachment',
          target_id: d.issue.id,
          reserved_bytes: 1,
          expires_at: d.receipt.expires_at,
          state: 'pending',
        })
    })
    expect(await d.t.mutation(internal.backgroundPreviews.beginDemoWork, job)).toBeNull()
    expect(await skipped(d)).toBe(true)
  })

  it('records a preview larger than its reservation as skipped for the current background only', async () => {
    const d = await setup()
    const old = await background(d, 1 * MiB)
    expect(await skipped(d)).toBe(false)
    await d.caller.mutation(api.appearance.removeCustom, {})
    const ticket = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Fjord.jpg',
      size: 1 * MiB,
    })
    await post(d.t, ticket.upload_url, jpegOf(1 * MiB), 'image/jpeg')
    const [current] = await d.t.run((ctx) => ctx.db.query('custom_backgrounds').collect())
    // a job for the background the person replaced marks nothing
    await d.t.mutation(internal.backgroundPreviews.skipDemoPreview, old)
    expect(await skipped(d)).toBe(false)
    await d.t.mutation(internal.backgroundPreviews.skipDemoPreview, {
      kind: 'custom',
      id: current.id,
      storage_id: current.storage_id,
    })
    expect(await skipped(d)).toBe(true)
  })
})

describe('outside the demo', () => {
  it('takes a size for a picture or background, checks its shape and reserves nothing', async () => {
    vi.stubEnv('APP_MODE', '')
    const d = await setup()
    const avatar = await d.caller.mutation(api.files.avatarUploadUrl, {
      profile_id: d.admin.id,
      size: 100 * MiB,
    })
    expect(avatar).not.toContain('/demo-uploads/')
    const ticket = await d.caller.mutation(api.appearance.createUpload, {
      name: 'Lake.jpg',
      size: 100 * MiB,
    })
    expect(ticket.upload_url).toContain('/background-uploads/')
    expect(await ledger(d.t)).toEqual({ bytes: 0, rows: 0 })
    for (const call of [
      d.caller.mutation(api.files.avatarUploadUrl, { profile_id: d.admin.id, size: -1 }),
      d.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg', size: 0.5 }),
    ]) {
      const refusal = await expectRefusal(call, 'bad_request')
      expect(refusal.data.message).toBe(UPLOAD_SIZE_SHAPE)
    }
  })
})
