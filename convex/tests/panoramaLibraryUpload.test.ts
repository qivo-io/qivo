/* Standalone operator uploads use real Convex actions, mutations and storage.
 * Source URLs are provenance only; this suite never downloads a photograph. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { PANORAMA_MAX_BYTES } from '../lib/panorama'
import { as, expectRefusal, NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const PHOTO_ID = 'LBI7cgq3pbM'
const PHOTO_URL = `https://unsplash.com/photos/${PHOTO_ID}`
const OTHER_URL = 'https://unsplash.com/photos/eOcyhe5-9sQ'
const INPUT = {
  url: PHOTO_URL,
  title: ' Winter lake ',
  location: ' Jotunheimen, Norway ',
  creator: ' Jane Doe ',
  license_confirmed: true,
}
type Caller = ReturnType<T['withIdentity']>

function jpeg(tag = 0, width = 1920, height = 1080) {
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

async function store(t: T, bytes: unknown = jpeg(), mime = 'image/jpeg') {
  return t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([bytes], { type: mime }) as never)
    // convex-test omits the contentType real Convex storage records.
    await ctx.db.patch(id as never, { contentType: mime } as never)
    return id
  })
}
const exists = (t: T, id: Id<'_storage'>) => t.run(async (ctx) => !!(await ctx.storage.get(id)))
const images = (t: T) => t.run((ctx) => ctx.db.query('panorama_images').collect())
const state = (t: T) => t.run((ctx) => ctx.db.query('panorama_library').unique())
const audit = (t: T) => t.run((ctx) => ctx.db.query('platform_audit_log').collect())

async function setup() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.ts'))
  const authId = uuid()
  const opRow = await t.run((ctx) =>
    ctx.db.insert('platform_admins', {
      auth_user_id: authId,
      note: 'library uploader',
      created_at: NOW,
    }),
  )
  return { t, authId, opRow, op: t.withIdentity({ subject: authId }) }
}

function upload(op: Caller, storage_id: Id<'_storage'>, changes: Partial<typeof INPUT> = {}) {
  return op.action(api.panoramaCuration.addLibraryFile, { ...INPUT, ...changes, storage_id })
}

async function expectNoPublication(t: T) {
  expect(await t.run((ctx) => ctx.db.query('panorama_submissions').collect())).toEqual([])
  expect(await t.run((ctx) => ctx.db.query('panorama_calendar').collect())).toEqual([])
  expect(await t.run((ctx) => ctx.db.query('panorama_curation_keys').collect())).toEqual([])
  expect(await t.run((ctx) => ctx.db.query('panorama_refills').collect())).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected external download')
    }),
  )
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('operator-only standalone image upload', () => {
  it('refuses anonymous, organization-admin and revoked-operator callers on all public surfaces', async () => {
    const { t, op, opRow } = await setup()
    const org = await withOrg(t)
    const sid = await store(t)
    await t.run((ctx) => ctx.db.delete(opRow))
    for (const caller of [t, as(t, org.admin), op]) {
      await expectRefusal(
        caller.mutation(api.panoramaCuration.prepareLibraryUpload, { url: PHOTO_URL }),
        'forbidden',
      )
      await expectRefusal(
        caller.action(api.panoramaCuration.addLibraryFile, { ...INPUT, storage_id: sid }),
        'forbidden',
      )
      await expectRefusal(
        caller.query(api.panoramaCuration.libraryImage, { id: 'unknown' }),
        'forbidden',
      )
    }
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    // An unauthorized caller cannot delete a storage id they merely know.
    expect(await exists(t, sid)).toBe(true)
    await expectNoPublication(t)
  })

  it('normalizes a source URL and prepares an upload without creating library or calendar records', async () => {
    const { t, op } = await setup()
    const prepared = await op.mutation(api.panoramaCuration.prepareLibraryUpload, {
      url: ` https://www.unsplash.com/photos/a-beautiful-lake-${PHOTO_ID}?utm_source=qivo#photo `,
    })
    expect(prepared.source_url).toBe(PHOTO_URL)
    expect(prepared.existing_image).toBeNull()
    expect(prepared.upload_url).toEqual(expect.any(String))
    expect(prepared.upload_url).not.toBe('')
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    expect(await audit(t)).toEqual([])
    await expectNoPublication(t)
  })

  it.each([
    'http://unsplash.com/photos/LBI7cgq3pbM',
    'https://images.unsplash.com/photo-123.jpg',
    'https://unsplash.com/plus/photos/LBI7cgq3pbM',
    'https://example.test/photos/LBI7cgq3pbM',
  ])('refuses an unsupported source URL: %s', async (url) => {
    const { t, op } = await setup()
    await expectRefusal(
      op.mutation(api.panoramaCuration.prepareLibraryUpload, { url }),
      'bad_request',
    )
    expect(await images(t)).toEqual([])
  })

  it('stores an inspected JPEG as pending with licensing provenance and no submission or date', async () => {
    const { t, op, authId } = await setup()
    const sid = await store(t)
    const result = await upload(op, sid, {
      url: `https://www.unsplash.com/photos/winter-${PHOTO_ID}?utm_source=test`,
    })
    expect(result.reused).toBe(false)
    expect(result.image).toMatchObject({
      source_id: `unsplash:${PHOTO_ID}`,
      source_url: PHOTO_URL,
      title: 'Winter lake',
      location: 'Jotunheimen, Norway',
      creator: 'Jane Doe',
      filename: 'winter-lake_jane-doe.jpg',
      status: 'pending',
      width: 1920,
      height: 1080,
      license: 'Unsplash License',
      license_url: 'https://unsplash.com/license',
      image_url: expect.any(String),
    })
    for (const hidden of ['storage_id', 'source_metadata', 'download_url', 'reviewed_by'])
      expect(result.image).not.toHaveProperty(hidden)
    const [image] = await images(t)
    const file = await t.run((ctx) => ctx.db.system.get(sid))
    expect(image).toMatchObject({
      storage_id: sid,
      sha256: file!.sha256,
      byte_size: file!.size,
      status: 'pending',
    })
    expect(image.agent_review).toBeUndefined()
    expect(image.reviewed_at).toBeUndefined()
    expect(JSON.parse(image.source_metadata)).toMatchObject({
      acquisition: 'operator_upload',
      source_url: PHOTO_URL,
      standard_license_confirmed_by: authId,
      confirmed_at: new Date().toISOString(),
      title: 'Winter lake',
      location: 'Jotunheimen, Norway',
      creator: 'Jane Doe',
      filename: 'winter-lake_jane-doe.jpg',
    })
    expect(image.attribution).toContain('Jane Doe')
    expect(image.attribution).toContain(PHOTO_URL)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0, removed: 0 })
    expect(await exists(t, sid)).toBe(true)
    const logs = await audit(t)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ actor_auth_id: authId, action: 'panorama_library_image_added' })
    expect(logs[0].detail).toMatchObject({
      image_id: image.id,
      source_url: PHOTO_URL,
      license: 'Unsplash License',
      reused: false,
    })
    await expectNoPublication(t)
  })

  it('queries the current image without internal storage metadata and retains removed tombstone details', async () => {
    const { t, op } = await setup()
    expect(await op.query(api.panoramaCuration.libraryImage, { id: 'unknown' })).toBeNull()
    const original = await upload(op, await store(t))
    const pending = await op.query(api.panoramaCuration.libraryImage, { id: original.image.id })
    expect(pending).toEqual(original.image)
    for (const hidden of [
      '_id',
      '_creationTime',
      'storage_id',
      'source_metadata',
      'download_url',
      'reviewed_by',
    ])
      expect(pending).not.toHaveProperty(hidden)
    await op.mutation(api.panoramaImages.approve, { id: original.image.id })
    expect(
      await op.query(api.panoramaCuration.libraryImage, { id: original.image.id }),
    ).toMatchObject({ status: 'approved' })
    await op.mutation(api.panoramaImages.remove, { id: original.image.id })
    expect(
      await op.query(api.panoramaCuration.libraryImage, { id: original.image.id }),
    ).toMatchObject({
      id: original.image.id,
      title: 'Winter lake',
      status: 'removed',
      image_url: null,
    })
  })

  it.each(['pending', 'approved'] as const)(
    'finds an existing %s source before requesting another upload',
    async (status) => {
      const { t, op } = await setup()
      const original = await upload(op, await store(t))
      if (status === 'approved')
        await op.mutation(api.panoramaImages.approve, { id: original.image.id })
      const before = await state(t)
      const prepared = await op.mutation(api.panoramaCuration.prepareLibraryUpload, {
        url: PHOTO_URL,
      })
      expect(prepared).toMatchObject({
        source_url: PHOTO_URL,
        upload_url: null,
        existing_image: { id: original.image.id, status },
      })
      expect(await images(t)).toHaveLength(1)
      expect(await state(t)).toEqual(before)
      await expectNoPublication(t)
    },
  )

  it.each(['source', 'hash'] as const)(
    'reuses a duplicate %s and deletes only the new loose copy',
    async (kind) => {
      const { t, op } = await setup()
      const originalStorage = await store(t)
      const original = await upload(op, originalStorage)
      const originalRow = (await images(t))[0]
      const before = await state(t)
      const duplicate = await store(t)
      const result = await upload(op, duplicate, {
        url: kind === 'source' ? PHOTO_URL : OTHER_URL,
        title: 'Replacement title',
      })
      expect(result).toMatchObject({
        reused: true,
        image: { id: original.image.id, title: 'Winter lake', status: 'pending' },
      })
      expect(await images(t)).toEqual([originalRow])
      expect(await state(t)).toEqual(before)
      expect(await exists(t, duplicate)).toBe(false)
      expect(await exists(t, originalStorage)).toBe(true)
      expect((await audit(t)).at(-1)?.detail).toMatchObject({
        image_id: original.image.id,
        reused: true,
      })
      await expectNoPublication(t)
    },
  )

  it('refuses a source removed before preparation, and a source removed while an upload was in flight', async () => {
    const { t, op } = await setup()
    await op.mutation(api.panoramaCuration.prepareLibraryUpload, { url: PHOTO_URL })
    const original = await upload(op, await store(t))
    await op.mutation(api.panoramaImages.remove, { id: original.image.id })
    await expectRefusal(
      op.mutation(api.panoramaCuration.prepareLibraryUpload, { url: PHOTO_URL }),
      'rule',
      /removed/,
    )
    const loose = await store(t, jpeg(1))
    await expectRefusal(upload(op, loose), 'rule', /removed/)
    expect(await exists(t, loose)).toBe(false)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 0, approved: 0, removed: 1 })
    await expectNoPublication(t)
  })

  it('refuses a removed hash even when a new source URL is supplied', async () => {
    const { t, op } = await setup()
    const original = await upload(op, await store(t))
    await op.mutation(api.panoramaImages.remove, { id: original.image.id })
    const loose = await store(t)
    await expectRefusal(upload(op, loose, { url: OTHER_URL }), 'rule', /removed/)
    expect(await exists(t, loose)).toBe(false)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 0, approved: 0, removed: 1 })
  })

  it('refuses a different file registered for the source during upload and preserves the retained file', async () => {
    const { t, op } = await setup()
    await op.mutation(api.panoramaCuration.prepareLibraryUpload, { url: PHOTO_URL })
    const retained = await store(t, jpeg(1))
    const original = await upload(op, retained)
    const loose = await store(t, jpeg(2))
    const refusal = await expectRefusal(upload(op, loose), 'conflict', /different file/)
    expect(refusal.data.reason).toBe('source_file_changed')
    expect(await exists(t, retained)).toBe(true)
    expect(await exists(t, loose)).toBe(false)
    expect((await images(t))[0].id).toBe(original.image.id)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0 })
  })

  it('refuses an unavailable existing file during preparation and final deduplication', async () => {
    const { t, op } = await setup()
    const originalStorage = await store(t)
    await upload(op, originalStorage)
    await t.run((ctx) => ctx.storage.delete(originalStorage))
    await expectRefusal(
      op.mutation(api.panoramaCuration.prepareLibraryUpload, { url: PHOTO_URL }),
      'rule',
      /available/,
    )
    const loose = await store(t)
    await expectRefusal(upload(op, loose), 'rule', /available/)
    expect(await exists(t, loose)).toBe(false)
    expect(await images(t)).toHaveLength(1)
  })

  it('refuses claimed attachment, avatar and background IDs without deleting those files', async () => {
    const { t, op } = await setup()
    const org = await withOrg(t)
    const issue = await plantIssue(t, { org_id: org.org.id, project_id: org.sub.id })
    const attached = await store(t, jpeg(1))
    const avatar = await store(t, jpeg(2))
    const background = await store(t, jpeg(3))
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
    for (const storageId of [attached, avatar, background]) {
      await expectRefusal(
        upload(op, storageId, { url: OTHER_URL }),
        'bad_request',
        /already in use/,
      )
      expect(await exists(t, storageId)).toBe(true)
    }
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 1 })
    await expectNoPublication(t)
  })

  it.each([
    { title: ' ' },
    { creator: ' ' },
    { title: 'x'.repeat(301) },
    { creator: 'x'.repeat(301) },
    { location: 'x'.repeat(301) },
    { license_confirmed: false },
    { url: 'https://images.unsplash.com/photo-123.jpg' },
  ])('refuses invalid metadata and cleans up the unretained upload: %j', async (changes) => {
    const { t, op } = await setup()
    const sid = await store(t)
    await expectRefusal(upload(op, sid, changes), 'bad_request')
    expect(await exists(t, sid)).toBe(false)
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    expect(await audit(t)).toEqual([])
    await expectNoPublication(t)
  })

  it.each([
    { description: 'wrong MIME', bytes: () => jpeg(), mime: 'image/png', reason: /JPEG/ },
    {
      description: 'invalid JPEG',
      bytes: () => 'not an image',
      mime: 'image/jpeg',
      reason: /JPEG/,
    },
    {
      description: 'empty file',
      bytes: () => new Uint8Array(),
      mime: 'image/jpeg',
      reason: /empty/,
    },
    {
      description: 'small image',
      bytes: () => jpeg(0, 800, 600),
      mime: 'image/jpeg',
      reason: /(?=.*800 × 600)(?=.*at least 1600 × 800)/,
    },
    {
      description: 'image one pixel below the minimum width',
      bytes: () => jpeg(0, 1599, 1000),
      mime: 'image/jpeg',
      reason: /(?=.*1599 × 1000)(?=.*at least 1600 × 800)/,
    },
    {
      description: 'image one pixel below the minimum height',
      bytes: () => jpeg(0, 1920, 799),
      mime: 'image/jpeg',
      reason: /(?=.*1920 × 799)(?=.*at least 1600 × 800)/,
    },
    {
      description: 'portrait image',
      bytes: () => jpeg(0, 1600, 1920),
      mime: 'image/jpeg',
      reason: /(?=.*aspect ratio)(?=.*1\.3:1 and 3:1)/,
    },
    {
      description: 'square image',
      bytes: () => jpeg(0, 1600, 1600),
      mime: 'image/jpeg',
      reason: /(?=.*aspect ratio)(?=.*1\.3:1 and 3:1)/,
    },
    {
      description: 'image just below the minimum aspect ratio',
      bytes: () => jpeg(0, 1949, 1500),
      mime: 'image/jpeg',
      reason: /(?=.*aspect ratio)(?=.*1\.3:1 and 3:1)/,
    },
    {
      description: 'image just above the maximum aspect ratio',
      bytes: () => jpeg(0, 2401, 800),
      mime: 'image/jpeg',
      reason: /(?=.*aspect ratio)(?=.*1\.3:1 and 3:1)/,
    },
    {
      description: 'very wide image',
      bytes: () => jpeg(0, 8000, 1080),
      mime: 'image/jpeg',
      reason: /(?=.*aspect ratio)(?=.*1\.3:1 and 3:1)/,
    },
    {
      description: 'image exceeding the pixel limit',
      bytes: () => jpeg(0, 8001, 4000),
      mime: 'image/jpeg',
      reason: /32 megapixels/,
    },
    {
      description: 'oversized file',
      bytes: () => new Uint8Array(PANORAMA_MAX_BYTES + 1),
      mime: 'image/jpeg',
      reason: /8 MB/,
    },
  ])(
    'refuses $description with a specific reason and deletes only the unretained upload',
    async ({ bytes, mime, reason }) => {
      const { t, op } = await setup()
      const sid = await store(t, bytes(), mime)
      await expectRefusal(upload(op, sid), 'bad_request', reason)
      expect(await exists(t, sid)).toBe(false)
      expect(await images(t)).toEqual([])
      expect(await state(t)).toBeNull()
      expect(await audit(t)).toEqual([])
      await expectNoPublication(t)
    },
  )

  it.each([
    { description: 'minimum dimensions', width: 1600, height: 800 },
    { description: 'minimum aspect ratio', width: 1950, height: 1500 },
    { description: 'maximum aspect ratio', width: 2400, height: 800 },
    { description: 'maximum pixel count', width: 8000, height: 4000 },
  ])('retains an image at the $description as pending', async ({ width, height }) => {
    const { t, op } = await setup()
    const sid = await store(t, jpeg(0, width, height))
    const result = await upload(op, sid)
    expect(result.image).toMatchObject({ status: 'pending', width, height })
    expect(result.reused).toBe(false)
    expect(await exists(t, sid)).toBe(true)
    expect(await images(t)).toHaveLength(1)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0 })
    await expectNoPublication(t)
  })

  it('retains a file at the byte-size limit as pending', async () => {
    const { t, op } = await setup()
    const bytes = new Uint8Array(PANORAMA_MAX_BYTES)
    bytes.set(jpeg())
    const sid = await store(t, bytes)
    const result = await upload(op, sid)
    expect(result.image).toMatchObject({ status: 'pending', byte_size: PANORAMA_MAX_BYTES })
    expect(await exists(t, sid)).toBe(true)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0 })
    await expectNoPublication(t)
  })

  it('revalidates operator authority at final registration after upload preparation', async () => {
    const { t, op, opRow, authId } = await setup()
    await op.mutation(api.panoramaCuration.prepareLibraryUpload, { url: PHOTO_URL })
    const sid = await store(t)
    await t.run((ctx) => ctx.db.delete(opRow))
    await expectRefusal(
      t.mutation(internal.panoramaCuration.retainLibraryFile, {
        source_url: PHOTO_URL,
        source_id: `unsplash:${PHOTO_ID}`,
        storage_id: sid,
        title: 'Winter lake',
        creator: 'Jane Doe',
        license_confirmed: true,
        width: 1920,
        height: 1080,
        auth_user_id: authId,
      }),
      'forbidden',
      /operator/,
    )
    expect(await images(t)).toEqual([])
    expect(await state(t)).toBeNull()
    expect(await audit(t)).toEqual([])
    expect(await exists(t, sid)).toBe(true)
    await expectNoPublication(t)
  })
})
