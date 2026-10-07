/* Registered-function checks for platform curation credentials, machine
 * prechecks, source-link proposals and final human publication. HTTP framing
 * is covered separately. No source downloads or live credentials are used. */
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { PANORAMA_MAX_BYTES } from '../lib/panorama'
import { sha256hex } from '../machine/auth'
import { as, expectRefusal, NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

type Caller = ReturnType<T['withIdentity']>
const PHOTO_ID = 'LBI7cgq3pbM'
const PHOTO_URL = `https://unsplash.com/photos/${PHOTO_ID}`
const proposal = { url: PHOTO_URL, date: '12-25' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function jpeg(tag = 0) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    0x04,
    0x38,
    0x07,
    0x80,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
    tag,
  ])
}

async function storage(t: T, content: unknown = jpeg(), mime = 'image/jpeg') {
  return t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([content], { type: mime }) as never)
    // convex-test stores Blob bytes and hash but omits real storage's type.
    await ctx.db.patch(id as never, { contentType: mime } as never)
    return id
  })
}
const exists = (t: T, id: Id<'_storage'>) => t.run(async (ctx) => !!(await ctx.storage.get(id)))
const images = (t: T) => t.run((ctx) => ctx.db.query('panorama_images').collect())
const submissions = (t: T) => t.run((ctx) => ctx.db.query('panorama_submissions').collect())
const calendar = (t: T) => t.run((ctx) => ctx.db.query('panorama_calendar').collect())
const keys = (t: T) => t.run((ctx) => ctx.db.query('panorama_curation_keys').collect())
const state = (t: T) => t.run((ctx) => ctx.db.query('panorama_library').unique())
const audit = (t: T) => t.run((ctx) => ctx.db.query('platform_audit_log').collect())

async function setup() {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.ts'))
  const authId = uuid()
  const opRow = await t.run((ctx) =>
    ctx.db.insert('platform_admins', {
      auth_user_id: authId,
      note: 'curation reviewer',
      created_at: NOW,
    }),
  )
  const op = t.withIdentity({ subject: authId })
  const key = await op.mutation(api.panoramaCuration.mintKey, { name: 'Seasonal curator' })
  const hash = await sha256hex(key.secret)
  return { t, op, authId, opRow, key, hash }
}

async function plantImage(
  t: T,
  options: {
    source_id?: string
    status?: 'pending' | 'approved' | 'removed'
    tag?: number
  } = {},
) {
  const storage_id = await storage(t, jpeg(options.tag ?? 0))
  const id = uuid()
  return t.run(async (ctx) => {
    const file = await ctx.db.system.get(storage_id)
    const status = options.status ?? 'pending'
    const _id = await ctx.db.insert('panorama_images', {
      id,
      source_id: options.source_id ?? `commons:${uuid()}`,
      source_url: 'https://commons.wikimedia.org/wiki/File:Lake.jpg',
      download_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Lake.jpg',
      title: 'Alpine lake',
      creator: 'Jane Doe',
      license: 'CC0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: 'Alpine lake — Jane Doe',
      source_metadata: '{}',
      ...(status === 'removed' ? {} : { storage_id }),
      sha256: file!.sha256,
      byte_size: file!.size,
      width: 1920,
      height: 1080,
      status,
      imported_at: NOW,
    })
    if (status === 'removed') await ctx.storage.delete(storage_id)
    const library = await ctx.db.query('panorama_library').unique()
    if (library) await ctx.db.patch(library._id, { [status]: library[status] + 1 })
    else
      await ctx.db.insert('panorama_library', {
        key: 'default',
        pending: status === 'pending' ? 1 : 0,
        approved: status === 'approved' ? 1 : 0,
        removed: status === 'removed' ? 1 : 0,
        cursor: { category: 0 },
      })
    return { ...(await ctx.db.get(_id))!, original_storage_id: storage_id }
  })
}

async function submit(t: T, key_id: string, input = proposal, request_id?: string) {
  return t.mutation(internal.panoramaCuration.machineSubmit, {
    key_id,
    input,
    ...(request_id ? { request_id } : {}),
  })
}

async function attach(op: Caller, submission_id: string, storage_id: Id<'_storage'>) {
  return op.action(api.panoramaCuration.attachFile, {
    submission_id,
    storage_id,
    title: ' Winter lake ',
    location: ' Jotunheimen, Norway ',
    creator: ' Jane Doe ',
    license_confirmed: true,
  })
}

describe('platform-only curation credential management', () => {
  it('refuses anonymous and organization-admin callers on every public operation', async () => {
    const { t, key } = await setup()
    const org = await withOrg(t)
    const sid = await storage(t)
    for (const caller of [t, as(t, org.admin)]) {
      const checks = [
        caller.query(api.panoramaCuration.keys, {}),
        caller.query(api.panoramaCuration.submissions, {}),
        caller.mutation(api.panoramaCuration.mintKey, { name: 'Unauthorized' }),
        caller.mutation(api.panoramaCuration.revokeKey, { id: key.id }),
        caller.mutation(api.panoramaCuration.decline, { id: 'missing' }),
        caller.mutation(api.panoramaCuration.accept, { id: 'missing', expected_image_id: null }),
        caller.mutation(api.panoramaCuration.uploadUrl, { submission_id: 'missing' }),
        caller.action(api.panoramaCuration.attachFile, {
          submission_id: 'missing',
          storage_id: sid,
          title: 'Lake',
          creator: 'Jane',
          license_confirmed: true,
        }),
      ]
      await Promise.all(checks.map((check) => expectRefusal(check, 'forbidden')))
    }
    expect((await keys(t))[0].revoked_at).toBeUndefined()
  })

  it('reveals a new secret once, storing only its hash and display fingerprint', async () => {
    const { t, op, key, hash, authId } = await setup()
    expect(key.secret).toMatch(/^qvc_[a-f0-9]{64}$/)
    const rows = await keys(t)
    expect(rows[0]).toMatchObject({ key_hash: hash, created_by: authId, name: 'Seasonal curator' })
    expect(rows[0].expires_at).toBe('2027-09-06T12:00:00.000Z')
    expect(JSON.stringify({ rows, audit: await audit(t) })).not.toContain(key.secret)
    const listed = await op.query(api.panoramaCuration.keys, {})
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('key_hash')
    expect(listed[0]).not.toHaveProperty('request_count')
    expect(listed[0]).not.toHaveProperty('secret')
    expect(await t.mutation(internal.panoramaCuration.authorize, { hash })).toEqual({
      key_id: key.id,
    })
    expect((await keys(t))[0]).toMatchObject({
      last_used_at: new Date().toISOString(),
      request_count: 1,
    })
  })

  it.each(['revoked', 'expired', 'issuer removed'] as const)(
    'rechecks a %s key after earlier authentication',
    async (kind) => {
      const { t, op, opRow, key, hash } = await setup()
      await t.mutation(internal.panoramaCuration.authorize, { hash })
      const link = await submit(t, key.id)
      const image = await plantImage(t)
      if (kind === 'revoked') await op.mutation(api.panoramaCuration.revokeKey, { id: key.id })
      else if (kind === 'expired') vi.setSystemTime(new Date('2027-09-06T12:00:00Z'))
      else await t.run((ctx) => ctx.db.delete(opRow))
      const attempts = [
        t.mutation(internal.panoramaCuration.authorize, { hash }),
        t.query(internal.panoramaCuration.machineImages, { key_id: key.id }),
        t.query(internal.panoramaCuration.machineImage, { key_id: key.id, id: image.id }),
        t.query(internal.panoramaCuration.machineSubmissions, { key_id: key.id }),
        t.query(internal.panoramaCuration.machineSubmission, {
          key_id: key.id,
          id: link.submission.id,
        }),
        t.mutation(internal.panoramaCuration.machineReview, {
          key_id: key.id,
          id: image.id,
          decision: 'approved',
          reason: 'Reviewed',
        }),
        t.mutation(internal.panoramaCuration.machineReviewSubmission, {
          key_id: key.id,
          id: link.submission.id,
          decision: 'approved',
          reason: 'Reviewed',
        }),
        submit(t, key.id),
      ]
      await Promise.all(attempts.map((attempt) => expectRefusal(attempt, 'forbidden', /key/)))
      expect((await images(t))[0].agent_review).toBeUndefined()
      expect(await calendar(t)).toEqual([])
    },
  )

  it('rejects unknown hashes and caps authenticated attempts per rolling minute', async () => {
    const { t, hash } = await setup()
    await expectRefusal(
      t.mutation(internal.panoramaCuration.authorize, { hash: 'not-a-key' }),
      'forbidden',
    )
    await t.mutation(internal.panoramaCuration.authorize, { hash })
    await t.run(async (ctx) => {
      const key = await ctx.db.query('panorama_curation_keys').unique()
      await ctx.db.patch(key!._id, { request_count: 119 })
    })
    await t.mutation(internal.panoramaCuration.authorize, { hash })
    let caught: unknown
    try {
      await t.mutation(internal.panoramaCuration.authorize, { hash })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConvexError)
    expect(
      (caught as ConvexError<{ code: string; message: string; retry_after: number }>).data,
    ).toMatchObject({
      code: 'rate_limited',
      retry_after: 60,
    })
    expect((await keys(t))[0].request_count).toBe(120)
    vi.setSystemTime(Date.now() + 60_000)
    await t.mutation(internal.panoramaCuration.authorize, { hash })
    expect((await keys(t))[0].request_count).toBe(1)
  })

  it('limits active keys and lets revocation free one slot', async () => {
    const { t, op, key } = await setup()
    for (let i = 1; i < 20; i++)
      await op.mutation(api.panoramaCuration.mintKey, { name: `Curator ${i}` })
    await expectRefusal(
      op.mutation(api.panoramaCuration.mintKey, { name: 'Too many' }),
      'rule',
      /revoke/,
    )
    await op.mutation(api.panoramaCuration.revokeKey, { id: key.id })
    await op.mutation(api.panoramaCuration.revokeKey, { id: key.id })
    await op.mutation(api.panoramaCuration.mintKey, { name: 'Replacement' })
    expect(await keys(t)).toHaveLength(21)
    expect(
      (await audit(t)).filter((row) => row.action === 'panorama_curation_key_revoked'),
    ).toHaveLength(1)
    await expectRefusal(
      op.mutation(api.panoramaCuration.mintKey, { name: ' ' }),
      'bad_request',
      /name/,
    )
  })
})

describe('machine prechecks never publish or remove images', () => {
  it.each(['approved', 'declined'] as const)(
    'records %s independently of human status and calendar',
    async (decision) => {
      const { t, key } = await setup()
      const image = await plantImage(t)
      const before = await state(t)
      const result = await t.mutation(internal.panoramaCuration.machineReview, {
        key_id: key.id,
        id: image.id,
        decision,
        reason: ' Considered image content and contrast. ',
        day: '12-25',
      })
      expect(result).toMatchObject({ agent_review: decision, human_status: 'pending' })
      expect((await images(t))[0]).toMatchObject({
        status: 'pending',
        agent_review: decision,
        agent_review_note: 'Considered image content and contrast.',
        agent_reviewer: 'Seasonal curator',
      })
      expect(await state(t)).toEqual(before)
      expect(await exists(t, image.original_storage_id)).toBe(true)
      expect(await calendar(t)).toEqual([])
      expect((await submissions(t)).length).toBe(decision === 'approved' ? 1 : 0)
      if (decision === 'approved')
        expect((await submissions(t))[0]).toMatchObject({
          status: 'pending',
          image_id: image.id,
          day: '12-25',
        })
    },
  )

  it('lists only pending by default, supports agent filters and reads one image without internal fields', async () => {
    const { t, key } = await setup()
    const fresh = await plantImage(t)
    const reviewed = await plantImage(t, { tag: 1 })
    await plantImage(t, { status: 'approved', tag: 2 })
    await plantImage(t, { status: 'removed', tag: 3 })
    await t.mutation(internal.panoramaCuration.machineReview, {
      key_id: key.id,
      id: reviewed.id,
      decision: 'declined',
      reason: 'Busy composition.',
    })
    expect(
      (await t.query(internal.panoramaCuration.machineImages, { key_id: key.id })).images,
    ).toHaveLength(2)
    const unreviewed = await t.query(internal.panoramaCuration.machineImages, {
      key_id: key.id,
      agent_review: 'unreviewed',
    })
    expect(unreviewed.images.map((row) => row.id)).toEqual([fresh.id])
    const declined = await t.query(internal.panoramaCuration.machineImages, {
      key_id: key.id,
      agent_review: 'declined',
    })
    expect(declined.images.map((row) => row.id)).toEqual([reviewed.id])
    const read = await t.query(internal.panoramaCuration.machineImage, {
      key_id: key.id,
      id: fresh.id,
    })
    expect(read.image_url).toEqual(expect.any(String))
    for (const hidden of ['storage_id', 'download_url', 'source_metadata', 'reviewed_by'])
      expect(read).not.toHaveProperty(hidden)
    await expectRefusal(
      t.query(internal.panoramaCuration.machineImage, { key_id: key.id, id: 'missing' }),
      'not_found',
    )
  })

  it.each(['approved', 'removed'] as const)(
    'refuses to revise a human %s image',
    async (status) => {
      const { t, key } = await setup()
      const image = await plantImage(t, { status })
      await expectRefusal(
        t.mutation(internal.panoramaCuration.machineReview, {
          key_id: key.id,
          id: image.id,
          decision: 'approved',
          reason: 'Reviewed',
        }),
        'rule',
        /human/,
      )
      expect((await images(t))[0].status).toBe(status)
    },
  )
})

describe('agent source-link proposals', () => {
  it('persists URL/date metadata without adding stock, downloading or assigning a date', async () => {
    const { t, op, key } = await setup()
    const result = await submit(t, key.id)
    expect(result).toMatchObject({
      idempotent: false,
      submission: {
        status: 'needs_file',
        source_id: `unsplash:${PHOTO_ID}`,
        source_url: PHOTO_URL,
        day: '12-25',
        image_url: null,
        existing_image_id: null,
      },
    })
    const listed = await t.query(internal.panoramaCuration.machineSubmissions, { key_id: key.id })
    expect(listed.submissions.map((row) => row.id)).toEqual([result.submission.id])
    const read = await t.query(internal.panoramaCuration.machineSubmission, {
      key_id: key.id,
      id: result.submission.id,
    })
    expect(read).toEqual(result.submission)
    for (const hidden of ['payload_json', 'key_id', 'request_id', 'reviewed_by'])
      expect(read).not.toHaveProperty(hidden)
    expect((await op.query(api.panoramaCuration.submissions, {})).submissions).toEqual(
      listed.submissions,
    )
    expect(await state(t)).toBeNull()
    expect(await images(t)).toEqual([])
    expect(await calendar(t)).toEqual([])
    expect(
      await op.mutation(api.panoramaCuration.uploadUrl, { submission_id: result.submission.id }),
    ).toEqual(expect.any(String))
  })

  it('deduplicates normalized repeated requests and rejects changed payload under the same key', async () => {
    const { t, op, key } = await setup()
    const first = await submit(t, key.id, proposal, 'agent:christmas-1')
    const repeated = await submit(
      t,
      key.id,
      {
        ...proposal,
        url: `https://www.unsplash.com/photos/winter-lake-${PHOTO_ID}?utm_source=agent`,
      },
      'agent:christmas-1',
    )
    expect(repeated).toMatchObject({ idempotent: true, submission: { id: first.submission.id } })
    const conflict = await expectRefusal(
      submit(t, key.id, { ...proposal, date: '12-24' }, 'agent:christmas-1'),
      'conflict',
      /different content/,
    )
    expect(conflict.data.reason).toBe('idempotency_mismatch')
    const key2 = await op.mutation(api.panoramaCuration.mintKey, { name: 'Other curator' })
    expect((await submit(t, key2.id, proposal, 'agent:christmas-1')).idempotent).toBe(false)
    const defaults = await submit(t, key.id)
    expect((await submit(t, key.id)).submission.id).toBe(defaults.submission.id)
    await expectRefusal(
      submit(t, key.id, proposal, 'invalid request key'),
      'bad_request',
      /Idempotency-Key/,
    )
  })

  it('requires recurring valid dates and rejects raw CDN links', async () => {
    const { t, key } = await setup()
    for (const date of ['2026-12-25', '02-29', '04-31'])
      await expectRefusal(submit(t, key.id, { ...proposal, date }), 'bad_request')
    await expectRefusal(
      submit(t, key.id, { ...proposal, url: 'https://images.unsplash.com/photo-123' }),
      'bad_request',
      /photo page/,
    )
    expect(await submissions(t)).toEqual([])
  })

  it('links an existing source file and keeps previously removed sources closed', async () => {
    const { t, key } = await setup()
    const image = await plantImage(t, { source_id: `unsplash:${PHOTO_ID}` })
    expect((await submit(t, key.id)).submission).toMatchObject({
      status: 'pending',
      image_id: image.id,
    })
    await t.run((ctx) => ctx.db.patch(image._id, { status: 'removed' }))
    const removed = await submit(t, key.id, { ...proposal, date: '12-24' })
    expect(removed.submission).toMatchObject({ status: 'declined', image_id: image.id })
    expect(removed.submission.review_note).toContain('previously removed')
  })

  it('allows proposal prechecks before a file exists while retaining human status', async () => {
    const { t, key } = await setup()
    const link = await submit(t, key.id)
    for (const decision of ['approved', 'declined'] as const) {
      const review = await t.mutation(internal.panoramaCuration.machineReviewSubmission, {
        key_id: key.id,
        id: link.submission.id,
        decision,
        reason: 'Assessed the proposal.',
      })
      expect(review).toMatchObject({ agent_review: decision, human_status: 'needs_file' })
      expect((await submissions(t))[0]).toMatchObject({
        status: 'needs_file',
        agent_review: decision,
      })
    }
    expect(await images(t)).toEqual([])
    expect(await calendar(t)).toEqual([])
  })
})

describe('licensed files and final human decisions', () => {
  it('attaches an inspected JPEG with acquisition evidence, then a human approves and schedules it', async () => {
    const { t, op, key, authId } = await setup()
    const link = await submit(t, key.id)
    await expectRefusal(
      op.mutation(api.panoramaCuration.accept, { id: link.submission.id, expected_image_id: null }),
      'rule',
      /attach/,
    )
    const sid = await storage(t)
    await attach(op, link.submission.id, sid)
    const image = (await images(t))[0]
    expect(image).toMatchObject({
      storage_id: sid,
      status: 'pending',
      width: 1920,
      height: 1080,
      title: 'Winter lake',
      location: 'Jotunheimen, Norway',
      creator: 'Jane Doe',
      filename: 'winter-lake_jane-doe.jpg',
      license: 'Unsplash License',
    })
    expect(JSON.parse(image.source_metadata)).toMatchObject({
      acquisition: 'operator_upload',
      standard_license_confirmed_by: authId,
      source_url: PHOTO_URL,
    })
    expect(
      await t.query(internal.panoramaCuration.machineImage, { key_id: key.id, id: image.id }),
    ).toMatchObject({
      location: 'Jotunheimen, Norway',
      filename: 'winter-lake_jane-doe.jpg',
    })
    expect((await submissions(t))[0]).toMatchObject({ status: 'pending', image_id: image.id })
    expect(await calendar(t)).toEqual([])
    await op.mutation(api.panoramaCuration.accept, {
      id: link.submission.id,
      expected_image_id: null,
      expected_agent_review_id: null,
    })
    expect((await images(t))[0]).toMatchObject({ status: 'approved', reviewed_by: authId })
    expect((await submissions(t))[0].status).toBe('accepted')
    expect(await state(t)).toMatchObject({ pending: 0, approved: 1 })
    expect((await calendar(t))[0]).toMatchObject({ day: 'W52', image_id: image.id })
    await expectRefusal(
      op.mutation(api.panoramaCuration.decline, { id: link.submission.id }),
      'rule',
      /accepted/,
    )
  })

  it('refuses stale calendar state atomically, then explicitly replaces the reviewed assignment', async () => {
    const { t, op, key } = await setup()
    const candidate = await plantImage(t, { source_id: `unsplash:${PHOTO_ID}` })
    const existing = await plantImage(t, { status: 'approved', tag: 1 })
    const link = await submit(t, key.id)
    await op.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: existing.id })
    const refusal = await expectRefusal(
      op.mutation(api.panoramaCuration.accept, { id: link.submission.id, expected_image_id: null }),
      'conflict',
      /week changed/,
    )
    expect(refusal.data.reason).toBe('calendar_changed')
    expect((await images(t)).find((row) => row.id === candidate.id)!.status).toBe('pending')
    expect((await calendar(t))[0].image_id).toBe(existing.id)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 1 })
    await op.mutation(api.panoramaCuration.accept, {
      id: link.submission.id,
      expected_image_id: existing.id,
    })
    expect((await calendar(t))[0].image_id).toBe(candidate.id)
    expect(await state(t)).toMatchObject({ pending: 0, approved: 2 })
  })

  it('refuses a changed agent precheck until the human acknowledges its current revision', async () => {
    const { t, op, key } = await setup()
    const image = await plantImage(t, { source_id: `unsplash:${PHOTO_ID}` })
    const link = await submit(t, key.id)
    await t.mutation(internal.panoramaCuration.machineReview, {
      key_id: key.id,
      id: image.id,
      decision: 'approved',
      reason: 'Good crop.',
    })
    const old = (await images(t))[0].agent_review_id!
    await t.mutation(internal.panoramaCuration.machineReviewSubmission, {
      key_id: key.id,
      id: link.submission.id,
      decision: 'declined',
      reason: 'Spotted a prominent logo.',
    })
    const latest = (await images(t))[0].agent_review_id!
    expect(latest).not.toBe(old)
    const refusal = await expectRefusal(
      op.mutation(api.panoramaCuration.accept, {
        id: link.submission.id,
        expected_image_id: null,
        expected_agent_review_id: old,
      }),
      'conflict',
      /precheck changed/,
    )
    expect(refusal.data.reason).toBe('agent_review_changed')
    expect(await calendar(t)).toEqual([])
    expect((await images(t))[0].status).toBe('pending')
    // A human can disagree with an agent, but must acknowledge the latest note.
    await op.mutation(api.panoramaCuration.accept, {
      id: link.submission.id,
      expected_image_id: null,
      expected_agent_review_id: latest,
    })
    expect((await submissions(t))[0].status).toBe('accepted')
  })

  it('declines only the proposal, preserving its file and other calendar assignments', async () => {
    const { t, op, key } = await setup()
    const image = await plantImage(t, { source_id: `unsplash:${PHOTO_ID}`, status: 'approved' })
    await op.mutation(api.panoramaImages.assignDate, { day: '12-24', image_id: image.id })
    const link = await submit(t, key.id)
    await op.mutation(api.panoramaCuration.decline, {
      id: link.submission.id,
      note: ' Prefer this on Christmas Eve. ',
    })
    await op.mutation(api.panoramaCuration.decline, { id: link.submission.id })
    expect((await submissions(t))[0]).toMatchObject({
      status: 'declined',
      review_note: 'Prefer this on Christmas Eve.',
    })
    expect((await images(t))[0].status).toBe('approved')
    expect(await exists(t, image.original_storage_id)).toBe(true)
    expect((await calendar(t))[0]).toMatchObject({ day: 'W52', image_id: image.id })
    await expectRefusal(
      t.mutation(internal.panoramaCuration.machineReviewSubmission, {
        key_id: key.id,
        id: link.submission.id,
        decision: 'approved',
        reason: 'Try again',
      }),
      'rule',
      /human/,
    )
  })

  it('requires license confirmation, valid JPEG bytes, bounded file size and author details', async () => {
    const { t, op, key } = await setup()
    const link = await submit(t, key.id)
    const sid = await storage(t)
    await expectRefusal(
      op.action(api.panoramaCuration.attachFile, {
        submission_id: link.submission.id,
        storage_id: sid,
        title: 'Lake',
        creator: 'Jane',
        license_confirmed: false,
      }),
      'bad_request',
      /license/,
    )
    for (const invalid of [
      await storage(t, 'SVG', 'image/svg+xml'),
      await storage(t, 'not a JPEG'),
      await storage(t, 'x'.repeat(PANORAMA_MAX_BYTES + 1)),
    ])
      await expectRefusal(attach(op, link.submission.id, invalid), 'bad_request', /JPEG/)
    await expectRefusal(
      op.action(api.panoramaCuration.attachFile, {
        submission_id: link.submission.id,
        storage_id: await storage(t),
        title: ' ',
        creator: 'Jane',
        license_confirmed: true,
      }),
      'bad_request',
      /title/,
    )
    expect(await images(t)).toEqual([])
    expect((await submissions(t))[0].status).toBe('needs_file')
  })

  it('clears URL-only prechecks when a file arrives, requiring review of those actual bytes', async () => {
    const { t, op, key } = await setup()
    const link = await submit(t, key.id)
    await t.mutation(internal.panoramaCuration.machineReviewSubmission, {
      key_id: key.id,
      id: link.submission.id,
      decision: 'approved',
      reason: 'The linked photo looks appropriate.',
    })
    const oldRevision = (await submissions(t))[0].agent_review_id!
    await attach(op, link.submission.id, await storage(t))
    const image = (await images(t))[0]
    const row = (await submissions(t))[0]
    expect(image.agent_review).toBeUndefined()
    expect(image.agent_review_id).toBeUndefined()
    expect(row.agent_review).toBeUndefined()
    expect(row.agent_review_id).toBeUndefined()
    await expectRefusal(
      op.mutation(api.panoramaCuration.accept, {
        id: row.id,
        expected_image_id: null,
        expected_agent_review_id: oldRevision,
      }),
      'conflict',
      /precheck changed/,
    )
    expect(await calendar(t)).toEqual([])
  })

  it('checks agent review revisions on direct human library approval too', async () => {
    const { t, op, key } = await setup()
    const image = await plantImage(t)
    await t.mutation(internal.panoramaCuration.machineReview, {
      key_id: key.id,
      id: image.id,
      decision: 'declined',
      reason: 'Busy composition.',
    })
    await expectRefusal(
      op.mutation(api.panoramaImages.approve, { id: image.id }),
      'conflict',
      /precheck changed/,
    )
    const revision = (await images(t))[0].agent_review_id!
    await op.mutation(api.panoramaImages.approve, {
      id: image.id,
      expected_agent_review_id: revision,
    })
    expect((await images(t))[0].status).toBe('approved')
    expect(await calendar(t)).toEqual([])
  })

  it('uses the latest proposal precheck when an already approved image has an older image review', async () => {
    const { t, op, key } = await setup()
    const image = await plantImage(t, { source_id: `unsplash:${PHOTO_ID}` })
    await t.mutation(internal.panoramaCuration.machineReview, {
      key_id: key.id,
      id: image.id,
      decision: 'approved',
      reason: 'Suitable as a background.',
    })
    const oldRevision = (await images(t))[0].agent_review_id!
    await op.mutation(api.panoramaImages.approve, {
      id: image.id,
      expected_agent_review_id: oldRevision,
    })
    const link = await submit(t, key.id)
    await t.mutation(internal.panoramaCuration.machineReviewSubmission, {
      key_id: key.id,
      id: link.submission.id,
      decision: 'declined',
      reason: 'The photo is good, but not seasonal for this date.',
    })
    const latest = (await submissions(t))[0].agent_review_id!
    expect(latest).not.toBe(oldRevision)
    const displayed = await t.query(internal.panoramaCuration.machineSubmission, {
      key_id: key.id,
      id: link.submission.id,
    })
    expect(displayed).toMatchObject({ agent_review_id: latest, agent_review: 'declined' })
    await expectRefusal(
      op.mutation(api.panoramaCuration.accept, {
        id: link.submission.id,
        expected_image_id: null,
        expected_agent_review_id: oldRevision,
      }),
      'conflict',
      /precheck changed/,
    )
    await op.mutation(api.panoramaCuration.accept, {
      id: link.submission.id,
      expected_image_id: null,
      expected_agent_review_id: latest,
    })
    expect(await state(t)).toMatchObject({ pending: 0, approved: 1 })
    expect((await calendar(t))[0].image_id).toBe(image.id)
    const accepted = (await audit(t)).find((row) => row.action === 'panorama_submission_accepted')
    expect(accepted!.detail).toMatchObject({ agent_decision: 'declined' })
  })

  it('deduplicates an uploaded copy against an existing file and deletes only the loose copy', async () => {
    const { t, op, key } = await setup()
    const link = await submit(t, key.id)
    const original = await plantImage(t)
    const duplicate = await storage(t)
    await attach(op, link.submission.id, duplicate)
    expect(await images(t)).toHaveLength(1)
    expect((await submissions(t))[0]).toMatchObject({ status: 'pending', image_id: original.id })
    expect(await exists(t, duplicate)).toBe(false)
    expect(await exists(t, original.original_storage_id)).toBe(true)
    expect(await state(t)).toMatchObject({ pending: 1, approved: 0 })
  })

  it('refuses removed hashes and a changed file for a source created during upload', async () => {
    const { t, op, key } = await setup()
    const link = await submit(t, key.id)
    await plantImage(t, { status: 'removed' })
    await expectRefusal(attach(op, link.submission.id, await storage(t)), 'rule', /removed/)
    await plantImage(t, { source_id: `unsplash:${PHOTO_ID}`, tag: 1 })
    const refusal = await expectRefusal(
      attach(op, link.submission.id, await storage(t, jpeg(2))),
      'conflict',
      /different file/,
    )
    expect(refusal.data.reason).toBe('source_file_changed')
    expect((await submissions(t))[0].status).toBe('needs_file')
  })

  it('rechecks operator authority inside final attachment registration', async () => {
    const { t, opRow, authId, key } = await setup()
    const link = await submit(t, key.id)
    const sid = await storage(t)
    await t.run((ctx) => ctx.db.delete(opRow))
    await expectRefusal(
      t.mutation(internal.panoramaCuration.attachVerifiedFile, {
        submission_id: link.submission.id,
        storage_id: sid,
        title: 'Lake',
        creator: 'Jane',
        license_confirmed: true,
        width: 1920,
        height: 1080,
        auth_user_id: authId,
      }),
      'forbidden',
      /operator/,
    )
    expect(await exists(t, sid)).toBe(true)
    expect(await images(t)).toEqual([])
  })

  it('refuses attachment, avatar and background storage IDs without harming existing files', async () => {
    const { t, op, key } = await setup()
    const org = await withOrg(t)
    const issue = await plantIssue(t, { org_id: org.org.id, project_id: org.sub.id })
    const link = await submit(t, key.id)
    const attached = await storage(t, jpeg(1))
    const avatar = await storage(t, jpeg(2))
    const image = await plantImage(t, { tag: 3 })
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
    for (const sid of [attached, avatar, image.original_storage_id]) {
      await expectRefusal(attach(op, link.submission.id, sid), 'bad_request', /already in use/)
      expect(await exists(t, sid)).toBe(true)
    }
    expect(await images(t)).toHaveLength(1)
    expect((await submissions(t))[0].status).toBe('needs_file')
  })
})
