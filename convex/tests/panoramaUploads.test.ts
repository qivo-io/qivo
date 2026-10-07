/* Manual images exercise real actions, mutations and Convex storage. Header
 * fixtures test format/dimension screening; the UI separately decodes images. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { PANORAMA_MAX_BYTES } from '../lib/panoramaImage'
import { as, expectRefusal, NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const INPUT = { title: ' Winter lake ', creator: ' Jane Doe ', rights_confirmed: true }
type Caller = ReturnType<T['withIdentity']>
type Metadata = Partial<typeof INPUT> & { location?: string; source_url?: string }

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

function png(width = 1920, height = 1080, animated = false) {
  const bytes = new Uint8Array(animated ? 65 : 45)
  const view = new DataView(bytes.buffer)
  const word = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  view.setUint32(8, 13)
  word(12, 'IHDR')
  view.setUint32(16, width)
  view.setUint32(20, height)
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

function webp(width = 1920, height = 1080, lossless = false, animated = false) {
  const chunkSize = lossless ? 5 : 10
  const bytes = new Uint8Array(20 + chunkSize + (chunkSize % 2) + (animated ? 18 : 0))
  const view = new DataView(bytes.buffer)
  const word = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  word(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  word(8, 'WEBP')
  let offset = 12
  if (animated) {
    word(offset, 'VP8X')
    view.setUint32(offset + 4, 10, true)
    bytes[offset + 8] = 2
    offset += 18
  }
  word(offset, lossless ? 'VP8L' : 'VP8 ')
  view.setUint32(offset + 4, chunkSize, true)
  const data = offset + 8
  if (lossless) {
    bytes[data] = 0x2f
    view.setUint32(data + 1, width - 1 + ((height - 1) << 14), true)
  } else {
    bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], data)
    view.setUint16(data + 6, width, true)
    view.setUint16(data + 8, height, true)
  }
  return bytes
}

function webpChunks(...chunks: Uint8Array[]) {
  const bytes = new Uint8Array(12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  bytes.set(webp().slice(0, 12))
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  let offset = 12
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function webpCanvas() {
  const chunk = webp(1920, 1080, false, true).slice(12, 30)
  const view = new DataView(chunk.buffer)
  chunk[8] = 0
  view.setUint16(12, 1919, true)
  view.setUint16(15, 1079, true)
  return chunk
}

async function store(t: T, bytes: unknown = jpeg(), mime = 'image/jpeg') {
  return t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([bytes], { type: mime }) as never)
    // convex-test omits the MIME metadata stored by the real storage service.
    await ctx.db.patch(id as never, { contentType: mime } as never)
    return id
  })
}
const exists = (t: T, id: Id<'_storage'>) => t.run(async (ctx) => !!(await ctx.storage.get(id)))
const images = (t: T) => t.run((ctx) => ctx.db.query('panorama_images').collect())
const state = (t: T) => t.run((ctx) => ctx.db.query('panorama_library').unique())

async function setup() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.ts'))
  const authId = uuid()
  const opRow = await t.run((ctx) =>
    ctx.db.insert('platform_admins', {
      auth_user_id: authId,
      note: 'manual image upload tests',
      created_at: NOW,
    }),
  )
  return { t, authId, opRow, op: t.withIdentity({ subject: authId }) }
}

function upload(op: Caller, storage_id: Id<'_storage'>, metadata: Metadata = {}) {
  return op.action(api.panoramaUploads.addFile, { ...INPUT, ...metadata, storage_id })
}

async function noPublication(t: T) {
  expect(await t.run((ctx) => ctx.db.query('panorama_calendar').collect())).toEqual([])
  expect(await t.run((ctx) => ctx.db.query('panorama_submissions').collect())).toEqual([])
  expect(await t.run((ctx) => ctx.db.query('panorama_curation_keys').collect())).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Manual uploads must not fetch external URLs')
    }),
  )
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('manual background library uploads', () => {
  it('refuses anonymous, organization-admin and revoked-operator callers without touching their known file', async () => {
    const { t, op, opRow } = await setup()
    const org = await withOrg(t)
    const sid = await store(t)
    await t.run((ctx) => ctx.db.delete(opRow))
    for (const caller of [t, as(t, org.admin), op]) {
      await expectRefusal(caller.mutation(api.panoramaUploads.uploadUrl, {}), 'forbidden')
      await expectRefusal(
        caller.action(api.panoramaUploads.addFile, { ...INPUT, storage_id: sid }),
        'forbidden',
      )
    }
    expect(await exists(t, sid)).toBe(true)
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
  })

  it('prepares an upload without requiring a source URL, key or calendar date', async () => {
    const { t, op } = await setup()
    const url = await op.mutation(api.panoramaUploads.uploadUrl, {})
    expect(url).toEqual(expect.any(String))
    expect(url.length).toBeGreaterThan(0)
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    await noPublication(t)
  })

  it.each([
    { name: 'JPEG', mime: 'image/jpeg', bytes: () => jpeg() },
    { name: 'PNG', mime: 'image/png', bytes: () => png() },
    { name: 'WebP', mime: 'image/webp', bytes: () => webp() },
    { name: 'lossless WebP', mime: 'image/webp', bytes: () => webp(1920, 1080, true) },
    {
      name: 'extended WebP',
      mime: 'image/webp',
      bytes: () => webpChunks(webpCanvas(), webp().slice(12)),
    },
  ])(
    'retains an inspected $name without a source URL as pending for human review',
    async ({ mime, bytes }) => {
      const { t, op } = await setup()
      const sid = await store(t, bytes(), mime)
      const result = await upload(op, sid)
      expect(result).toMatchObject({
        reused: false,
        image: {
          title: 'Winter lake',
          creator: 'Jane Doe',
          filename: `winter-lake_jane-doe.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`,
          width: 1920,
          height: 1080,
          status: 'pending',
          image_url: expect.any(String),
        },
      })
      for (const hidden of ['storage_id', 'source_metadata', 'download_url', 'reviewed_by'])
        expect(result.image).not.toHaveProperty(hidden)
      const [row] = await images(t)
      const file = await t.run((ctx) => ctx.db.system.get(sid))
      expect(row).toMatchObject({ storage_id: sid, sha256: file!.sha256, byte_size: file!.size })
      expect(row.source_id).toBe(`upload:${file!.sha256}`)
      expect(row.reviewed_at).toBeUndefined()
      expect(row.agent_review).toBeUndefined()
      expect(await exists(t, sid)).toBe(true)
      expect(await state(t)).toMatchObject({ pending: 1, approved: 0, removed: 0 })
      expect(await t.run((ctx) => ctx.db.query('platform_audit_log').collect())).toHaveLength(1)
      await noPublication(t)
    },
  )

  it('stores an optional reference without fetching or treating the URL as permission to publish', async () => {
    const { t, op } = await setup()
    const result = await upload(op, await store(t), {
      source_url: 'https://example.com/photos/winter',
    })
    expect(result.image).toMatchObject({
      source_url: 'https://example.com/photos/winter',
      status: 'pending',
    })
    await noPublication(t)
  })

  it('retains trimmed location and a canonical filename through approval and calendar selection', async () => {
    const { t, op } = await setup()
    const result = await upload(op, await store(t), {
      title: ' Misty mountain peaks ',
      location: ' Huangshan, China ',
      creator: ' Sam Lim ',
    })
    const details = {
      title: 'Misty mountain peaks',
      location: 'Huangshan, China',
      creator: 'Sam Lim',
      filename: 'misty-mountain-peaks_sam-lim.jpg',
    }
    expect(result.image).toMatchObject(details)
    const [image] = await images(t)
    expect(image).toMatchObject(details)
    expect(JSON.parse(image.source_metadata)).toMatchObject(details)
    await op.mutation(api.panoramaImages.approve, { id: result.image.id })
    await op.mutation(api.panoramaImages.assignDate, { day: '09-13', image_id: result.image.id })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-09-13' })).toMatchObject(
      details,
    )
  })

  it.each([undefined, '  \n  '])(
    'omits an empty location instead of storing null: %j',
    async (location) => {
      const { t, op } = await setup()
      await upload(op, await store(t), { location })
      const [image] = await images(t)
      expect(image).not.toHaveProperty('location')
      expect(JSON.parse(image.source_metadata)).not.toHaveProperty('location')
    },
  )

  it.each([
    { title: '' },
    { title: ' ' },
    { title: 'x'.repeat(301) },
    { creator: '' },
    { creator: ' ' },
    { creator: 'x'.repeat(301) },
    { location: 'x'.repeat(301) },
    { rights_confirmed: false },
    { source_url: 'javascript:alert(1)' },
    { source_url: 'http://example.com/photo.jpg' },
    { source_url: 'https://username:password@example.com/photo.jpg' },
  ])(
    'refuses incomplete metadata or unsafe provenance and cleans up the loose file: %j',
    async (metadata) => {
      const { t, op } = await setup()
      const sid = await store(t)
      await expectRefusal(upload(op, sid, metadata), 'bad_request')
      expect(await exists(t, sid)).toBe(false)
      expect(await images(t)).toEqual([])
      expect(await state(t)).toBeNull()
      await noPublication(t)
    },
  )

  it.each([
    { reason: 'unsupported SVG', mime: 'image/svg+xml', bytes: () => '<svg></svg>' },
    { reason: 'unsupported GIF', mime: 'image/gif', bytes: () => jpeg() },
    { reason: 'empty file', mime: 'image/jpeg', bytes: () => new Uint8Array() },
    {
      reason: 'oversized file',
      mime: 'image/jpeg',
      bytes: () => new Uint8Array(PANORAMA_MAX_BYTES + 1),
    },
    { reason: 'HTML labelled JPEG', mime: 'image/jpeg', bytes: () => '<html>not an image</html>' },
    { reason: 'JPEG labelled PNG', mime: 'image/png', bytes: () => jpeg() },
    { reason: 'PNG labelled WebP', mime: 'image/webp', bytes: () => png() },
    { reason: 'WebP labelled JPEG', mime: 'image/jpeg', bytes: () => webp() },
    { reason: 'PNG below minimum width', mime: 'image/png', bytes: () => png(1599, 1000) },
    { reason: 'WebP below minimum height', mime: 'image/webp', bytes: () => webp(1920, 799) },
    { reason: 'portrait PNG', mime: 'image/png', bytes: () => png(1600, 2000) },
    { reason: 'square WebP', mime: 'image/webp', bytes: () => webp(1800, 1800) },
    { reason: 'over-wide JPEG', mime: 'image/jpeg', bytes: () => jpeg(2401, 800) },
    { reason: 'PNG over pixel limit', mime: 'image/png', bytes: () => png(8001, 4000) },
    { reason: 'animated PNG', mime: 'image/png', bytes: () => png(1920, 1080, true) },
    { reason: 'animated WebP', mime: 'image/webp', bytes: () => webp(1920, 1080, false, true) },
    { reason: 'truncated PNG', mime: 'image/png', bytes: () => png().slice(0, -1) },
    { reason: 'truncated WebP', mime: 'image/webp', bytes: () => webp().slice(0, -1) },
    {
      reason: 'oversized WebP frame followed by a misleading smaller canvas',
      mime: 'image/webp',
      bytes: () => webpChunks(webp(16000, 16000).slice(12), webpCanvas()),
    },
    {
      reason: 'late WebP canvas after a suitable frame',
      mime: 'image/webp',
      bytes: () => webpChunks(webp().slice(12), webpCanvas()),
    },
    {
      reason: 'two lossy WebP bitstreams',
      mime: 'image/webp',
      bytes: () => webpChunks(webp().slice(12), webp().slice(12)),
    },
    {
      reason: 'lossy and lossless WebP bitstreams in one still image',
      mime: 'image/webp',
      bytes: () => webpChunks(webp().slice(12), webp(1920, 1080, true).slice(12)),
    },
  ])('refuses $reason and removes only the unretained upload', async ({ mime, bytes }) => {
    const { t, op } = await setup()
    const sid = await store(t, bytes(), mime)
    await expectRefusal(upload(op, sid), 'bad_request')
    expect(await exists(t, sid)).toBe(false)
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    await noPublication(t)
  })

  it('reuses identical bytes without replacing metadata or retaining another file', async () => {
    const { t, op } = await setup()
    const sid = await store(t)
    const original = await upload(op, sid)
    const duplicate = await store(t)
    const result = await upload(op, duplicate, {
      title: 'Different title',
      location: 'New location',
      source_url: 'https://example.com/second',
    })
    expect(result).toMatchObject({
      reused: true,
      image: { id: original.image.id, title: 'Winter lake', filename: 'winter-lake_jane-doe.jpg' },
    })
    expect(result.image.location).toBeUndefined()
    expect(await exists(t, sid)).toBe(true)
    expect(await exists(t, duplicate)).toBe(false)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0 })
  })

  it('refuses removed bytes under a new reference and retains their tombstone', async () => {
    const { t, op } = await setup()
    const original = await upload(op, await store(t))
    await op.mutation(api.panoramaImages.remove, { id: original.image.id })
    const sid = await store(t)
    await expectRefusal(
      upload(op, sid, { source_url: 'https://example.com/new-photo' }),
      'rule',
      /removed/,
    )
    expect(await exists(t, sid)).toBe(false)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 0, approved: 0, removed: 1 })
  })

  it('retains only one file when equivalent uploads finish concurrently', async () => {
    const { t, op } = await setup()
    const first = await store(t)
    const second = await store(t)
    const results = await Promise.all([upload(op, first), upload(op, second)])
    expect(results.map((result) => result.reused).sort()).toEqual([false, true])
    expect(results[0].image.id).toBe(results[1].image.id)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0, removed: 0 })
    expect([await exists(t, first), await exists(t, second)].filter(Boolean)).toHaveLength(1)
  })

  it('refuses a duplicate whose retained file vanished and deletes the new loose copy', async () => {
    const { t, op } = await setup()
    const retained = await store(t)
    await upload(op, retained)
    await t.run((ctx) => ctx.storage.delete(retained))
    const loose = await store(t)
    await expectRefusal(upload(op, loose), 'rule', /available/)
    expect(await exists(t, loose)).toBe(false)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 1 })
  })

  it('refuses removed bytes even when paired with a different source that is still active', async () => {
    const { t, op } = await setup()
    const source_url = 'https://unsplash.com/photos/LBI7cgq3pbM'
    const activeStorage = await store(t, jpeg(1920, 1080, 1))
    const active = await upload(op, activeStorage, { source_url })
    const removed = await upload(op, await store(t, jpeg(1920, 1080, 2)))
    await op.mutation(api.panoramaImages.remove, { id: removed.image.id })
    const loose = await store(t, jpeg(1920, 1080, 2))
    await expectRefusal(upload(op, loose, { source_url }), 'rule', /removed/)
    expect(await exists(t, loose)).toBe(false)
    expect(await exists(t, activeStorage)).toBe(true)
    expect((await images(t)).find((row) => row.id === active.image.id)?.status).toBe('pending')
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0, removed: 1 })
  })

  it('honors source tombstones from the earlier Unsplash manual uploader even for changed bytes', async () => {
    const { t, op } = await setup()
    const source = 'https://unsplash.com/photos/LBI7cgq3pbM'
    const original = await op.action(api.panoramaCuration.addLibraryFile, {
      url: source,
      storage_id: await store(t),
      title: 'Lake',
      creator: 'Photographer',
      license_confirmed: true,
    })
    await op.mutation(api.panoramaImages.remove, { id: original.image.id })
    const sid = await store(t, jpeg(1920, 1080, 1))
    await expectRefusal(
      upload(op, sid, {
        source_url: 'https://www.unsplash.com/photos/winter-LBI7cgq3pbM?utm_source=test',
      }),
      'rule',
      /removed/,
    )
    expect(await exists(t, sid)).toBe(false)
    expect(await images(t)).toHaveLength(1)
  })

  it('preserves claimed attachment, avatar and background files when asked to adopt them', async () => {
    const { t, op } = await setup()
    const org = await withOrg(t)
    const issue = await plantIssue(t, { org_id: org.org.id, project_id: org.sub.id })
    const attached = await store(t, jpeg(1920, 1080, 1))
    const avatar = await store(t, jpeg(1920, 1080, 2))
    const background = await store(t, jpeg(1920, 1080, 3))
    await upload(op, background)
    await as(t, org.admin).mutation(api.files.attach, {
      org_id: org.org.id,
      id: uuid(),
      issue_id: issue.id,
      storage_id: attached,
      name: 'lake.jpg',
      mime: 'image/jpeg',
      inline: false,
    })
    await as(t, org.admin).mutation(api.files.setAvatar, {
      profile_id: org.admin.id,
      storage_id: avatar,
    })
    for (const sid of [attached, avatar, background]) {
      await expectRefusal(upload(op, sid), 'bad_request', /already in use/)
      expect(await exists(t, sid)).toBe(true)
    }
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 1 })
  })

  it('does not publish pending uploads and clears assigned dates when an approved upload is removed', async () => {
    const { t, op } = await setup()
    const sid = await store(t, png(), 'image/png')
    const result = await upload(op, sid)
    await expectRefusal(
      op.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: result.image.id }),
      'rule',
    )
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
    await op.mutation(api.panoramaImages.approve, { id: result.image.id })
    await op.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: result.image.id })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toMatchObject({
      id: result.image.id,
      image_url: expect.any(String),
    })
    await op.mutation(api.panoramaImages.remove, { id: result.image.id })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
    expect(await exists(t, sid)).toBe(false)
    expect(await state(t)).toMatchObject({ pending: 0, approved: 0, removed: 1 })
    await noPublication(t)
  })

  it('rechecks operator authority during final registration', async () => {
    const { t, op, opRow, authId } = await setup()
    await op.mutation(api.panoramaUploads.uploadUrl, {})
    const sid = await store(t)
    await t.run((ctx) => ctx.db.delete(opRow))
    await expectRefusal(
      t.mutation(internal.panoramaUploads.retainFile, {
        ...INPUT,
        storage_id: sid,
        width: 1920,
        height: 1080,
        auth_user_id: authId,
      }),
      'forbidden',
      /operator/,
    )
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    expect(await exists(t, sid)).toBe(true)
  })
})
