/* Account appearance uses real registered queries, mutations and HTTP handlers.
 * The upload route's sole storage shim supplies the contentType convex-test
 * omits; file ownership, token checks, cleanup and gateway lookup stay real. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import authSchema from '../betterAuth/schema'
import http from '../http'
import { PANORAMA_MAX_BYTES } from '../lib/panoramaImage'
import {
  as,
  expectRefusal,
  newT,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
  readonly type: string
}
declare class Request {
  constructor(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  )
}
type Caller = ReturnType<T['withIdentity']>

const DEFAULT = { mode: 'blue', image_source: 'daily', custom_image: null }
const headers = { 'Content-Type': 'image/jpeg', Origin: 'http://localhost:5199' }

function jpeg(width = 1920, height = 1080, tag = 0) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
    tag,
  ])
}
function png(animated = false) {
  const bytes = new Uint8Array(animated ? 65 : 45)
  const view = new DataView(bytes.buffer)
  const word = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  view.setUint32(8, 13)
  word(12, 'IHDR')
  view.setUint32(16, 1920)
  view.setUint32(20, 1080)
  bytes[24] = 8
  bytes[25] = 2
  if (animated) {
    view.setUint32(33, 8)
    word(37, 'acTL')
    view.setUint32(41, 2)
  }
  word(bytes.length - 8, 'IEND')
  return bytes
}
function webp(width = 1920, height = 1080) {
  const bytes = new Uint8Array(30)
  const view = new DataView(bytes.buffer)
  bytes.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 10, 0, 0, 0])
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20)
  view.setUint16(26, width, true)
  view.setUint16(28, height, true)
  return bytes
}

async function account(t: T, name: string) {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name,
        email: `${name}@appearance.test`,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  const id = user._id as string
  return { id, caller: t.withIdentity({ subject: id }) }
}
async function setup() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  const owner = await account(t, 'owner')
  const other = await account(t, 'other')
  const org = await withOrg(t)
  await t.run(async (ctx) => {
    await ctx.db.patch(org.user._id, { auth_user_id: owner.id })
    await ctx.db.patch(org.admin._id, { auth_user_id: other.id })
  })
  return { t, owner, other, org }
}

async function uploadRequest(
  t: T,
  url: string,
  bytes: unknown = jpeg(),
  mime = 'image/jpeg',
  options: { origin?: string; afterStore?: (id: Id<'_storage'>) => Promise<unknown> } = {},
) {
  const route = http.lookup(new URL(url).pathname, 'POST')
  if (!route) throw new Error('Custom upload route is not registered')
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
              mutation.db.patch(id as never, { contentType: blob.type } as never),
            )
            await options.afterStore?.(id)
            return id
          },
        },
      },
      new Request(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': mime,
          ...(options.origin ? { Origin: options.origin } : {}),
        },
        body: bytes,
      }),
    )
    return null
  })
  if (!response) throw new Error('Upload handler did not respond')
  return response
}
const getRequest = (t: T, url: string) =>
  (
    t as unknown as {
      fetch(path: string, init?: { headers?: Record<string, string> }): Promise<Response>
    }
  ).fetch(url.replace(new URL(url).origin, ''), { headers: { Origin: 'http://localhost:5199' } })
const settings = (caller: Caller) => caller.query(api.appearance.get, {})
const customRows = (t: T) => t.run((ctx) => ctx.db.query('custom_backgrounds').collect())
const storedRows = (t: T) => t.run((ctx) => ctx.db.system.query('_storage').collect())
const exists = (t: T, sid: Id<'_storage'>) => t.run(async (ctx) => !!(await ctx.storage.get(sid)))
async function upload(
  t: T,
  caller: Caller,
  bytes = jpeg(),
  mime = 'image/jpeg',
  name = 'Lake.jpg',
) {
  const ticket = await caller.mutation(api.appearance.createUpload, { name })
  const response = await uploadRequest(t, ticket.upload_url, bytes, mime)
  expect(response.status, await response.text()).toBe(200)
  const result = await settings(caller)
  expect(result.custom_image).not.toBeNull()
  return { ticket, image: result.custom_image! }
}
async function noLibraryChanges(t: T) {
  for (const table of [
    'panorama_images',
    'panorama_library',
    'panorama_calendar',
    'panorama_submissions',
  ] as const)
    expect(await t.run((ctx) => ctx.db.query(table).collect())).toEqual([])
}

// Generation is exercised with real decoded files in the processor tests.
// This fixture isolates signed delivery and ownership from image encoding.
async function attachPreview(t: T, imageId: string, previewVersion?: number) {
  return t.run(async (ctx) => {
    const image = await ctx.db
      .query('custom_backgrounds')
      .withIndex('by_uuid', (q) => q.eq('id', imageId))
      .unique()
    if (!image) throw new Error('Missing custom image fixture')
    const preview = await ctx.storage.store(new Blob([webp()], { type: 'image/webp' }) as never)
    await ctx.db.patch(image._id, {
      preview_storage_id: preview,
      preview_version: previewVersion,
    })
    return { preview, original: image.storage_id }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'))
  vi.stubEnv('BETTER_AUTH_SECRET', 'appearance-test-secret-not-a-deployment-key')
  vi.stubEnv('CONVEX_SITE_URL', 'https://appearance.convex.site')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('account appearance preferences', () => {
  it('defaults to image mode and the weekly image without creating rows', async () => {
    const { t, owner } = await setup()
    expect(await settings(owner.caller)).toEqual(DEFAULT)
    expect(await owner.caller.query(api.appearance.mintCustomUrl, {})).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('account_appearance').collect())).toEqual([])
    await noLibraryChanges(t)
  })

  it('refuses anonymous callers on every public preference, upload and preview function', async () => {
    const { t } = await setup()
    await expectRefusal(t.query(api.appearance.get, {}), 'forbidden')
    await expectRefusal(t.query(api.appearance.dailyImage, { date: '2026-09-07' }), 'forbidden')
    await expectRefusal(t.query(api.appearance.mintCustomUrl, {}), 'forbidden')
    await expectRefusal(
      t.mutation(api.appearance.save, { mode: 'dark', image_source: 'daily' }),
      'forbidden',
    )
    await expectRefusal(t.mutation(api.appearance.createUpload, { name: 'Lake.jpg' }), 'forbidden')
    await expectRefusal(
      t.mutation(api.appearance.cancelUpload, { ticket_id: 'unknown' }),
      'forbidden',
    )
    await expectRefusal(t.mutation(api.appearance.removeCustom, {}), 'forbidden')
  })

  it.each(['light', 'dark'] as const)(
    'persists %s across organization seats while an organization admin has independent settings',
    async (mode) => {
      const { t, owner, other, org } = await setup()
      const guest = await plantSeat(t, {
        org_id: org.otherOrg.id,
        auth_user_id: owner.id,
        org_role: 'guest',
      })
      await owner.caller.mutation(api.appearance.save, { mode, image_source: 'custom' })
      expect(await settings(as(t, guest))).toEqual({
        ...DEFAULT,
        mode,
        image_source: 'custom',
      })
      expect(await settings(other.caller)).toEqual(DEFAULT)
      await other.caller.mutation(api.appearance.save, { mode: 'dark', image_source: 'daily' })
      expect(await settings(owner.caller)).toMatchObject({ mode, image_source: 'custom' })
      expect(await t.run((ctx) => ctx.db.query('account_appearance').collect())).toHaveLength(2)
      await noLibraryChanges(t)
    },
  )

  it('reads a stored retired Canvas theme as Blue until the next save replaces it', async () => {
    const { t, owner } = await setup()
    await owner.caller.mutation(api.appearance.save, { mode: 'light', image_source: 'custom' })
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query('account_appearance').collect()
      await ctx.db.patch(row._id, { mode: 'image' })
    })
    expect(await settings(owner.caller)).toMatchObject({ mode: 'blue', image_source: 'custom' })
    await owner.caller.mutation(api.appearance.save, { mode: 'dark', image_source: 'custom' })
    const [row] = await t.run((ctx) => ctx.db.query('account_appearance').collect())
    expect(row.mode).toBe('dark')
  })

  it('rejects unsupported modes, sources and owner-selection arguments at the public wire', async () => {
    const { t, owner, other } = await setup()
    for (const args of [
      { mode: 'automatic', image_source: 'daily' },
      // Canvas is the background choice now, no longer a theme.
      { mode: 'image', image_source: 'daily' },
      { mode: 'dark', image_source: 'random' },
      { mode: 'dark', image_source: 'daily', auth_user_id: other.id },
    ])
      await expect(owner.caller.mutation(api.appearance.save, args as never)).rejects.toThrow()
    await expect(
      owner.caller.query(api.appearance.get, { auth_user_id: other.id } as never),
    ).rejects.toThrow()
    await expect(
      owner.caller.mutation(api.appearance.createUpload, {
        name: 'Lake.jpg',
        storage_id: 'known-loose-file',
      } as never),
    ).rejects.toThrow()
    expect(await settings(owner.caller)).toEqual(DEFAULT)
    expect(await settings(other.caller)).toEqual(DEFAULT)
    await noLibraryChanges(t)
  })
})

describe('approved weekly Canvas images', () => {
  async function scheduled(t: T, status: 'pending' | 'approved' = 'approved') {
    return t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob([jpeg()]) as never)
      const id = uuid()
      const row = await ctx.db.insert('panorama_images', {
        id,
        storage_id,
        status,
        source_id: 'canvas-test-image',
        source_url: 'https://example.org/source',
        download_url: 'https://example.org/private-download',
        title: 'Mountain lake',
        creator: 'Example photographer',
        license: 'CC0',
        license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
        attribution: 'Mountain lake · Example photographer · CC0',
        source_metadata: '{"internal":"provider metadata"}',
        sha256: 'test-image-hash',
        width: 1920,
        height: 1080,
        byte_size: jpeg().length,
        imported_at: '2026-09-01T00:00:00Z',
        review_note: 'Operator-only review notes',
      })
      await ctx.db.insert('panorama_library', {
        key: 'default',
        pending: status === 'pending' ? 1 : 0,
        approved: status === 'approved' ? 1 : 0,
        removed: 0,
      })
      await ctx.db.insert('panorama_calendar', {
        day: '09-07',
        image_id: id,
        updated_at: '2026-09-01T00:00:00Z',
        updated_by: 'test-operator',
      })
      return { row, id, storage_id }
    })
  }

  it('returns only an assigned approved image and the retained public credit', async () => {
    const { t, owner } = await setup()
    const image = await scheduled(t)
    await t.run((ctx) =>
      ctx.db.patch(image.row, {
        location: 'Huangshan, China',
        filename: 'mountain-lake_example-photographer.jpg',
      }),
    )
    const result = await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' })
    expect(result).toEqual({
      id: image.id,
      image_url: expect.any(String),
      preview_url: null,
      title: 'Mountain lake',
      location: 'Huangshan, China',
      creator: 'Example photographer',
      filename: 'mountain-lake_example-photographer.jpg',
      license: 'CC0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: 'Mountain lake · Example photographer · CC0',
      source_url: 'https://example.org/source',
    })
    for (const date of ['2026-09-08', '2026-09-13'])
      expect(await owner.caller.query(api.appearance.dailyImage, { date })).toEqual(result)
    // An approved library image is not an implicit default for an unassigned week.
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-14' })).toBeNull()
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2027-09-13' })).toEqual(
      result,
    )
  })

  it('fails closed for a pending slot or an approved image whose file disappeared', async () => {
    const { t, owner } = await setup()
    const image = await scheduled(t, 'pending')
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' })).toBeNull()
    await t.run(async (ctx) => {
      await ctx.db.patch(image.row, { status: 'approved' })
      await ctx.storage.delete(image.storage_id)
    })
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' })).toBeNull()
  })

  it('returns the explicit default with public credits for an empty week and withdraws it on removal', async () => {
    const { t, owner } = await setup()
    const image = await scheduled(t)
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: owner.id,
        note: 'Canvas test operator',
        created_at: '2026-09-01T00:00:00Z',
      }),
    )
    const assigned = await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' })
    await owner.caller.mutation(api.panoramaImages.setDefaultImage, { image_id: image.id })
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-14' })).toEqual(
      assigned,
    )
    await owner.caller.mutation(api.panoramaImages.remove, { id: image.id })
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-14' })).toBeNull()
    expect(await settings(owner.caller)).toEqual(DEFAULT)
  })

  it('removes the weekly image as soon as an operator withdraws it', async () => {
    const { t, owner } = await setup()
    const image = await scheduled(t)
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: owner.id,
        note: 'Canvas test operator',
        created_at: '2026-09-01T00:00:00Z',
      }),
    )
    expect(
      await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' }),
    ).not.toBeNull()
    await owner.caller.mutation(api.panoramaImages.remove, { id: image.id })
    expect(await owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' })).toBeNull()
  })

  it('refuses invalid dates and unavailable accounts through typed errors', async () => {
    const { t, owner } = await setup()
    for (const date of ['09-07', '2026-02-30', '2026-09-07T00:00:00Z'])
      await expectRefusal(owner.caller.query(api.appearance.dailyImage, { date }), 'bad_request')
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: owner.id }],
        update: { banned: true },
      },
    })
    await expectRefusal(
      owner.caller.query(api.appearance.dailyImage, { date: '2026-09-07' }),
      'forbidden',
    )
  })
})

describe('private custom background uploads', () => {
  it.each(['', ' ', '../Lake.jpg', 'x'.repeat(256), 'Lake\n.jpg'])(
    'refuses an invalid upload name without creating a ticket: %j',
    async (name) => {
      const { t, owner } = await setup()
      await expectRefusal(
        owner.caller.mutation(api.appearance.createUpload, { name }),
        'bad_request',
      )
      expect(await t.run((ctx) => ctx.db.query('background_uploads').collect())).toEqual([])
    },
  )

  it.each([
    { name: 'JPEG', mime: 'image/jpeg', bytes: jpeg },
    { name: 'PNG', mime: 'image/png', bytes: png },
    { name: 'WebP', mime: 'image/webp', bytes: webp },
  ])(
    'stores a suitable $name for its account without adding it to the public background library',
    async ({ name, mime, bytes }) => {
      const { t, owner, other } = await setup()
      await owner.caller.mutation(api.appearance.save, { mode: 'light', image_source: 'none' })
      const { image } = await upload(t, owner.caller, bytes(), mime, `Lake.${name.toLowerCase()}`)
      expect(image).toMatchObject({
        name: `Lake.${name.toLowerCase()}`,
        mime,
        width: 1920,
        height: 1080,
        byte_size: bytes().length,
      })
      expect(image).not.toHaveProperty('storage_id')
      expect(image).not.toHaveProperty('auth_user_id')
      // The upload selects the custom image and keeps the chosen theme.
      expect(await settings(owner.caller)).toMatchObject({ mode: 'light', image_source: 'custom' })
      expect(await settings(other.caller)).toEqual(DEFAULT)
      expect(await customRows(t)).toHaveLength(1)
      expect(await storedRows(t)).toHaveLength(1)
      await noLibraryChanges(t)
    },
  )

  it('keeps the uploaded image when switching mode or image source', async () => {
    const { t, owner } = await setup()
    const { image } = await upload(t, owner.caller)
    for (const mode of ['blue', 'dark', 'light'] as const) {
      for (const image_source of ['daily', 'custom', 'none'] as const) {
        await owner.caller.mutation(api.appearance.save, { mode, image_source })
        expect(await settings(owner.caller)).toMatchObject({
          mode,
          image_source,
          custom_image: image,
        })
      }
    }
    expect(await customRows(t)).toHaveLength(1)
    expect(await storedRows(t)).toHaveLength(1)
  })

  it.each([
    { name: 'unsupported SVG', mime: 'image/svg+xml', bytes: () => '<svg></svg>' },
    { name: 'JPEG labelled PNG', mime: 'image/png', bytes: jpeg },
    { name: 'invalid JPEG body', mime: 'image/jpeg', bytes: () => 'not an image' },
    { name: 'empty file', mime: 'image/jpeg', bytes: () => new Uint8Array() },
    {
      name: 'oversized file',
      mime: 'image/jpeg',
      bytes: () => new Uint8Array(PANORAMA_MAX_BYTES + 1),
    },
    { name: 'insufficient width', mime: 'image/jpeg', bytes: () => jpeg(1599, 1000) },
    { name: 'portrait image', mime: 'image/jpeg', bytes: () => jpeg(1600, 2000) },
    { name: 'image over the pixel limit', mime: 'image/jpeg', bytes: () => jpeg(8001, 4000) },
    { name: 'animated PNG', mime: 'image/png', bytes: () => png(true) },
  ])(
    'refuses $name without retaining bytes or changing the existing choice',
    async ({ mime, bytes }) => {
      const { t, owner } = await setup()
      await owner.caller.mutation(api.appearance.save, { mode: 'dark', image_source: 'daily' })
      const ticket = await owner.caller.mutation(api.appearance.createUpload, {
        name: 'Invalid image',
      })
      const response = await uploadRequest(t, ticket.upload_url, bytes(), mime)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
      expect(JSON.parse(await response.text())).toMatchObject({ error: { code: 'bad_request' } })
      expect(await settings(owner.caller)).toEqual({ ...DEFAULT, mode: 'dark' })
      expect(await customRows(t)).toEqual([])
      expect(await storedRows(t)).toEqual([])
      await noLibraryChanges(t)
    },
  )

  it('replaces and removes only its own file while retaining the current mode', async () => {
    const { t, owner, other } = await setup()
    const initial = await upload(t, owner.caller)
    const another = await upload(t, other.caller, jpeg(1920, 1080, 9))
    const oldFile = (await customRows(t)).find((row) => row.id === initial.image.id)!.storage_id
    const replacement = await upload(t, owner.caller, jpeg(1920, 1080, 1))
    expect(replacement.image.id).not.toBe(initial.image.id)
    expect(await exists(t, oldFile)).toBe(false)
    expect(await customRows(t)).toHaveLength(2)
    await owner.caller.mutation(api.appearance.save, { mode: 'light', image_source: 'custom' })
    await owner.caller.mutation(api.appearance.removeCustom, {})
    expect(await settings(owner.caller)).toEqual({ ...DEFAULT, mode: 'light' })
    expect(await settings(other.caller)).toMatchObject({ custom_image: another.image })
    expect(await customRows(t)).toHaveLength(1)
    expect(await storedRows(t)).toHaveLength(1)
    await noLibraryChanges(t)
  })

  it('cancels only the owner’s upload ticket and rejects a canceled URL', async () => {
    const { t, owner, other } = await setup()
    const ticket = await owner.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    await expectRefusal(
      other.caller.mutation(api.appearance.cancelUpload, { ticket_id: ticket.ticket_id }),
      'not_found',
    )
    await owner.caller.mutation(api.appearance.cancelUpload, { ticket_id: ticket.ticket_id })
    expect((await uploadRequest(t, ticket.upload_url)).status).toBe(404)
    expect(await customRows(t)).toEqual([])
    expect(await storedRows(t)).toEqual([])
  })

  it('rejects expired upload URLs before storing bytes', async () => {
    const { t, owner } = await setup()
    const ticket = await owner.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
    expect((await uploadRequest(t, ticket.upload_url)).status).toBe(404)
    expect(await customRows(t)).toEqual([])
    expect(await storedRows(t)).toEqual([])
  })

  it('refuses an explicit foreign upload origin even with a valid ticket', async () => {
    const { t, owner } = await setup()
    const ticket = await owner.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    const response = await uploadRequest(t, ticket.upload_url, jpeg(), 'image/jpeg', {
      origin: 'https://untrusted.example',
    })
    expect(response.status).toBe(404)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(await storedRows(t)).toEqual([])
  })

  it('cleans up newly stored bytes if the ticket is canceled before finalization', async () => {
    const { t, owner } = await setup()
    const current = await upload(t, owner.caller)
    const ticket = await owner.caller.mutation(api.appearance.createUpload, {
      name: 'Canceled.jpg',
    })
    let loose: Id<'_storage'> | undefined
    const response = await uploadRequest(t, ticket.upload_url, jpeg(1920, 1080, 1), 'image/jpeg', {
      afterStore: async (id) => {
        loose = id
        await owner.caller.mutation(api.appearance.cancelUpload, { ticket_id: ticket.ticket_id })
      },
    })
    expect(response.status).toBe(404)
    expect(JSON.parse(await response.text())).toMatchObject({ error: { code: 'not_found' } })
    expect(loose).toBeDefined()
    expect(await exists(t, loose!)).toBe(false)
    expect(await settings(owner.caller)).toMatchObject({ custom_image: current.image })
    expect(await storedRows(t)).toHaveLength(1)
  })

  it('rejects a tampered upload owner and replay of a successfully consumed ticket', async () => {
    const { t, owner, other } = await setup()
    const ticket = await owner.caller.mutation(api.appearance.createUpload, { name: 'Lake.jpg' })
    const tampered = ticket.upload_url.replace(/([?&]m=)[^&]+/, `$1${encodeURIComponent(other.id)}`)
    expect((await uploadRequest(t, tampered)).status).toBe(404)
    expect(await storedRows(t)).toEqual([])
    expect((await uploadRequest(t, ticket.upload_url)).status).toBe(200)
    expect((await uploadRequest(t, ticket.upload_url)).status).toBe(404)
    expect(await customRows(t)).toHaveLength(1)
    expect(await storedRows(t)).toHaveLength(1)
    expect(await settings(other.caller)).toEqual(DEFAULT)
  })

  it('rejects a stale upload prepared before another image was installed', async () => {
    const { t, owner } = await setup()
    const stale = await owner.caller.mutation(api.appearance.createUpload, { name: 'Stale.jpg' })
    const current = await upload(t, owner.caller, jpeg(1920, 1080, 1))
    const response = await uploadRequest(t, stale.upload_url, jpeg(1920, 1080, 2))
    expect(response.status).toBe(409)
    expect(JSON.parse(await response.text())).toMatchObject({ error: { code: 'conflict' } })
    expect(await settings(owner.caller)).toMatchObject({ custom_image: current.image })
    expect(await customRows(t)).toHaveLength(1)
    expect(await storedRows(t)).toHaveLength(1)
  })

  it('prevents a previously prepared upload from undoing explicit image removal', async () => {
    const { t, owner } = await setup()
    await upload(t, owner.caller)
    const stale = await owner.caller.mutation(api.appearance.createUpload, { name: 'Stale.jpg' })
    await owner.caller.mutation(api.appearance.removeCustom, {})
    const response = await uploadRequest(t, stale.upload_url)
    expect(response.status).toBe(409)
    expect(JSON.parse(await response.text())).toMatchObject({ error: { code: 'conflict' } })
    expect(await settings(owner.caller)).toEqual(DEFAULT)
    expect(await customRows(t)).toEqual([])
    expect(await storedRows(t)).toEqual([])
  })

  it('fences custom bytes from attachment, avatar and operator library adoption', async () => {
    const { t, owner, other, org } = await setup()
    await upload(t, owner.caller)
    const [image] = await customRows(t)
    const issue = await plantIssue(t, { org_id: org.org.id, project_id: org.sub.id })
    await expectRefusal(
      other.caller.mutation(api.files.attach, {
        org_id: org.org.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: image.storage_id,
        name: 'Stolen.jpg',
        mime: 'image/jpeg',
        inline: false,
      }),
      'bad_request',
      /already attached/,
    )
    await expectRefusal(
      other.caller.mutation(api.files.setAvatar, {
        profile_id: org.admin.id,
        storage_id: image.storage_id,
      }),
      'bad_request',
      /already in use/,
    )
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: other.id,
        note: 'reference-fence operator',
        created_at: new Date().toISOString(),
      }),
    )
    await expectRefusal(
      other.caller.action(api.panoramaUploads.addFile, {
        storage_id: image.storage_id,
        title: 'Stolen',
        creator: 'Another account',
        rights_confirmed: true,
      }),
      'bad_request',
      /already in use/,
    )
    expect(await exists(t, image.storage_id)).toBe(true)
    expect(await customRows(t)).toHaveLength(1)
    await noLibraryChanges(t)
  })

  it('keeps referenced custom bytes during orphan cleanup and removes abandoned loose bytes', async () => {
    const { t, owner } = await setup()
    await upload(t, owner.caller)
    const [image] = await customRows(t)
    const loose = await t.run((ctx) =>
      ctx.storage.store(new Blob([jpeg(1920, 1080, 3)], { type: 'image/jpeg' }) as never),
    )
    vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
    await t.mutation(internal.files.reapOrphans, {})
    expect(await exists(t, image.storage_id)).toBe(true)
    expect(await exists(t, loose)).toBe(false)
  })
})

describe('private custom background gateway', () => {
  it('serves a separately signed compressed preview while retaining the original bytes', async () => {
    const { t, owner, other } = await setup()
    const { image } = await upload(t, owner.caller)
    expect((await owner.caller.query(api.appearance.mintCustomUrl, {}))?.preview_url).toBeNull()
    expect((await settings(owner.caller)).custom_image?.preview_ready).toBe(false)
    expect((await settings(owner.caller)).custom_image?.preview_version).toBeNull()
    await attachPreview(t, image.id)
    expect((await settings(owner.caller)).custom_image?.preview_ready).toBe(true)
    expect((await settings(owner.caller)).custom_image?.preview_version).toBe(1)
    const urls = await owner.caller.query(api.appearance.mintCustomUrl, {})
    expect(urls?.preview_url).toContain('/background-previews/')
    expect(urls?.preview_url).not.toEqual(urls?.url)
    const response = await getRequest(t, urls!.preview_url!)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(
      new Uint8Array(
        await (response as Response & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
      ),
    ).toEqual(webp())
    const original = await getRequest(t, urls!.url)
    expect(
      new Uint8Array(
        await (original as Response & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
      ),
    ).toEqual(jpeg())
    expect(
      await t.query(internal.appearance.gatewayCustom, {
        id: image.id,
        minter: other.id,
        preview: true,
      }),
    ).toBeNull()
    for (const invalid of [
      urls!.preview_url!.replace('/background-previews/', '/backgrounds/'),
      urls!.url.replace('/backgrounds/', '/background-previews/'),
      urls!.preview_url!.replace(/([?&]m=)[^&]+/, `$1${encodeURIComponent(other.id)}`),
      urls!.preview_url!.split('?')[0],
    ]) {
      const denied = await getRequest(t, invalid)
      expect(denied.status).toBe(404)
      expect(denied.headers.get('Cache-Control')).toBe('no-store')
    }
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
    expect((await getRequest(t, urls!.preview_url!)).status).toBe(404)
  })

  it('refreshes an upgraded private preview in the same second without changing the original URL', async () => {
    const { t, owner } = await setup()
    const { image } = await upload(t, owner.caller)
    const legacy = await attachPreview(t, image.id)
    const before = await owner.caller.query(api.appearance.mintCustomUrl, {})
    expect((await settings(owner.caller)).custom_image?.preview_version).toBe(1)
    expect(new URL(before!.preview_url!).searchParams.get('v')).toBe('1')

    const bytes = webp(960, 540)
    const replacement = await t.run(async (ctx) => {
      const stored = await ctx.storage.store(new Blob([bytes], { type: 'image/webp' }) as never)
      // convex-test omits this storage metadata; production storage supplies it.
      await ctx.db.patch(stored as never, { contentType: 'image/webp' } as never)
      return stored
    })
    expect(
      await t.mutation(internal.backgroundPreviews.attach, {
        kind: 'custom',
        id: image.id,
        storage_id: legacy.original,
        preview_storage_id: replacement,
        preview_version: 2,
      }),
    ).toBe(true)
    const current = await settings(owner.caller)
    expect(current.custom_image).toMatchObject({
      id: image.id,
      preview_ready: true,
      preview_version: 2,
    })
    const after = await owner.caller.query(api.appearance.mintCustomUrl, {})
    expect(after!.expires_at).toBe(before!.expires_at)
    expect(after!.url).toBe(before!.url)
    expect(after!.preview_url).not.toBe(before!.preview_url)
    expect(new URL(after!.preview_url!).searchParams.get('v')).toBe('2')
    expect(new URL(after!.url).searchParams.get('v')).toBeNull()
    const response = await getRequest(t, after!.preview_url!)
    expect(response.status).toBe(200)
    expect(
      new Uint8Array(
        await (response as Response & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
      ),
    ).toEqual(bytes)
    expect(await exists(t, legacy.preview)).toBe(false)
    expect(await exists(t, legacy.original)).toBe(true)
    for (const storageId of [legacy.original, legacy.preview, replacement])
      expect(JSON.stringify({ current, after })).not.toContain(storageId)
  })

  it.each(['replace', 'remove', 'ban', 'delete'] as const)(
    'revokes compressed preview access after %s',
    async (operation) => {
      const { t, owner } = await setup()
      const { image } = await upload(t, owner.caller)
      const files = await attachPreview(t, image.id)
      const urls = await owner.caller.query(api.appearance.mintCustomUrl, {})
      expect((await getRequest(t, urls!.preview_url!)).status).toBe(200)
      if (operation === 'replace') await upload(t, owner.caller, jpeg(1920, 1080, 1))
      if (operation === 'remove') await owner.caller.mutation(api.appearance.removeCustom, {})
      if (operation === 'ban')
        await t.mutation(components.betterAuth.adapter.updateOne, {
          input: {
            model: 'user',
            where: [{ field: '_id', value: owner.id }],
            update: { banned: true },
          },
        })
      if (operation === 'delete')
        await t.mutation(components.betterAuth.adapter.deleteOne, {
          input: { model: 'user', where: [{ field: '_id', value: owner.id }] },
        })
      expect((await getRequest(t, urls!.preview_url!)).status).toBe(404)
      if (operation === 'delete') await t.mutation(internal.files.reapOrphans, {})
      expect(await exists(t, files.preview)).toBe(operation === 'ban')
      expect(await exists(t, files.original)).toBe(operation === 'ban')
    },
  )

  it('does not substitute original bytes when the compressed preview file is unavailable', async () => {
    const { t, owner } = await setup()
    const { image } = await upload(t, owner.caller)
    const files = await attachPreview(t, image.id, 2)
    const urls = await owner.caller.query(api.appearance.mintCustomUrl, {})
    await t.run((ctx) => ctx.storage.delete(files.preview))
    expect((await getRequest(t, urls!.preview_url!)).status).toBe(404)
    expect((await owner.caller.query(api.appearance.mintCustomUrl, {}))?.preview_url).toBeNull()
    expect((await settings(owner.caller)).custom_image?.preview_ready).toBe(false)
    expect((await settings(owner.caller)).custom_image?.preview_version).toBeNull()
    expect((await getRequest(t, urls!.url)).status).toBe(200)
  })

  it('mints only the caller’s preview and serves the bytes with private security headers', async () => {
    const { t, owner, other } = await setup()
    const { image } = await upload(t, owner.caller)
    expect(await other.caller.query(api.appearance.mintCustomUrl, {})).toBeNull()
    await expect(
      other.caller.query(api.appearance.mintCustomUrl, { image_id: image.id } as never),
    ).rejects.toThrow()
    expect(
      await t.query(internal.appearance.gatewayCustom, { id: image.id, minter: other.id }),
    ).toBeNull()
    const minted = await owner.caller.query(api.appearance.mintCustomUrl, {})
    expect(minted).toMatchObject({ image_id: image.id, url: expect.any(String) })
    const response = await getRequest(t, minted!.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(response.headers.get('Cache-Control')).toMatch(/^private,/)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5199')
    const bytes = await (
      response as Response & { arrayBuffer(): Promise<ArrayBuffer> }
    ).arrayBuffer()
    expect(new Uint8Array(bytes)).toEqual(jpeg())
  })

  it('refuses tampered, expired and unsigned preview URLs uniformly', async () => {
    const { t, owner, other } = await setup()
    await upload(t, owner.caller)
    const minted = await owner.caller.query(api.appearance.mintCustomUrl, {})
    const url = minted!.url
    for (const invalid of [
      url.replace(/([?&]t=)[^&]+/, '$1invalid'),
      url.replace(/([?&]m=)[^&]+/, `$1${encodeURIComponent(other.id)}`),
      url.split('?')[0],
    ]) {
      const response = await getRequest(t, invalid)
      expect(response.status).toBe(404)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
    expect((await getRequest(t, url)).status).toBe(404)
  })

  it('revokes previously minted previews immediately after replacement and removal', async () => {
    const { t, owner } = await setup()
    await upload(t, owner.caller)
    const old = await owner.caller.query(api.appearance.mintCustomUrl, {})
    await upload(t, owner.caller, jpeg(1920, 1080, 1))
    expect((await getRequest(t, old!.url)).status).toBe(404)
    const current = await owner.caller.query(api.appearance.mintCustomUrl, {})
    expect((await getRequest(t, current!.url)).status).toBe(200)
    await owner.caller.mutation(api.appearance.removeCustom, {})
    expect((await getRequest(t, current!.url)).status).toBe(404)
    expect(await owner.caller.query(api.appearance.mintCustomUrl, {})).toBeNull()
  })

  it('refuses a deleted account immediately and sweeps only its preferences, tickets and private bytes', async () => {
    const { t, owner, other } = await setup()
    await upload(t, owner.caller)
    const otherImage = await upload(t, other.caller, jpeg(1920, 1080, 2))
    const preview = await owner.caller.query(api.appearance.mintCustomUrl, {})
    const ticket = await owner.caller.mutation(api.appearance.createUpload, { name: 'Later.jpg' })
    // A raw component deletion models CLI/provider cleanup that bypasses the
    // normal auth API hook; the gateway must still revoke without waiting.
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: owner.id }] },
    })
    await expectRefusal(settings(owner.caller), 'forbidden')
    await expectRefusal(owner.caller.query(api.appearance.mintCustomUrl, {}), 'forbidden')
    expect((await getRequest(t, preview!.url)).status).toBe(404)
    expect((await uploadRequest(t, ticket.upload_url)).status).toBe(404)
    await t.mutation(internal.files.reapOrphans, {})
    expect(await t.run((ctx) => ctx.db.query('account_appearance').collect())).toHaveLength(1)
    expect(await t.run((ctx) => ctx.db.query('background_uploads').collect())).toEqual([])
    expect(await customRows(t)).toHaveLength(1)
    expect(await storedRows(t)).toHaveLength(1)
    expect(await settings(other.caller)).toMatchObject({ custom_image: otherImage.image })
    await noLibraryChanges(t)
  })

  it('revokes a banned account’s preview while preserving its saved preferences and image', async () => {
    const { t, owner } = await setup()
    const current = await upload(t, owner.caller)
    const preview = await owner.caller.query(api.appearance.mintCustomUrl, {})
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: owner.id }],
        update: { banned: true },
      },
    })
    await expectRefusal(settings(owner.caller), 'forbidden')
    await expectRefusal(owner.caller.query(api.appearance.mintCustomUrl, {}), 'forbidden')
    expect((await getRequest(t, preview!.url)).status).toBe(404)
    await t.mutation(internal.files.reapOrphans, {})
    expect(await customRows(t)).toHaveLength(1)
    expect(await storedRows(t)).toHaveLength(1)
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: owner.id }],
        update: { banned: false },
      },
    })
    expect(await settings(owner.caller)).toMatchObject({ custom_image: current.image })
  })
})
