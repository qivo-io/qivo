/* Operator curation and recurring-calendar guarantees through registered
 * functions. Upload validation is covered by panoramaUploads.test.ts; these
 * fixtures model retained library images, including historical Commons files. */
import type { FunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import * as panoramaModule from '../panoramaImages'
import { as, expectRefusal, NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

type Caller = ReturnType<T['withIdentity']>
const testContext = newT

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function operator(t: T, authId = uuid()) {
  const row = await t.run((ctx) =>
    ctx.db.insert('platform_admins', {
      auth_user_id: authId,
      note: 'panorama test operator',
      created_at: NOW,
    }),
  )
  return { asOp: t.withIdentity({ subject: authId }), authId, row }
}

async function setup() {
  const t = testContext()
  return { t, ...(await operator(t)) }
}

const storage = (t: T, contents = uuid(), mime = 'image/jpeg') =>
  t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([contents]) as never)
    // convex-test omits the upload Content-Type; mirror the real POST metadata.
    await ctx.db.patch(id as never, { contentType: mime } as never)
    return id
  })
const exists = (t: T, id: Id<'_storage'>) =>
  t.run(async (ctx) => (await ctx.storage.get(id)) !== null)
const images = (t: T) => t.run((ctx) => ctx.db.query('panorama_images').collect())
const state = (t: T) => t.run((ctx) => ctx.db.query('panorama_library').unique())
const runs = (t: T) => t.run((ctx) => ctx.db.query('panorama_refills').collect())
const dates = (t: T) => t.run((ctx) => ctx.db.query('panorama_calendar').collect())
const jobs = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (job) => job.state.kind === 'pending',
    ),
  )
const audit = (t: T) => t.run((ctx) => ctx.db.query('platform_audit_log').collect())

const metadata = (source_id = uuid()) => ({
  source_id,
  source_url: `https://commons.wikimedia.org/wiki/File:${source_id}.jpg`,
  download_url: `https://upload.wikimedia.org/example/${source_id}.jpg`,
  title: 'Mountain lake',
  creator: 'Example photographer',
  license: 'CC0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'Mountain lake · Example photographer · CC0',
  source_metadata: '{"review":"source metadata"}',
  width: 2400,
  height: 1600,
})

async function pending(t: T, contents = uuid(), source_id = uuid()) {
  const storage_id = await storage(t, contents)
  const image = await t.run(async (ctx) => {
    const file = await ctx.db.system.get(storage_id)
    if (!file) throw new Error('fixture file missing')
    const library = await panoramaModule.ensureState(ctx)
    const id = await ctx.db.insert('panorama_images', {
      ...metadata(source_id),
      id: uuid(),
      storage_id,
      sha256: file.sha256,
      byte_size: file.size,
      status: 'pending',
      imported_at: NOW,
    })
    await ctx.db.patch(library._id, { pending: library.pending + 1 })
    const row = await ctx.db.get(id)
    if (!row) throw new Error('fixture image missing')
    return row
  })
  return { image, storage_id }
}

const SURFACE: Record<string, { kind: 'query' | 'mutation'; args: Record<string, unknown> }> = {
  summary: { kind: 'query', args: {} },
  library: { kind: 'query', args: {} },
  calendar: { kind: 'query', args: {} },
  approve: { kind: 'mutation', args: { id: 'unknown' } },
  remove: { kind: 'mutation', args: { id: 'unknown' } },
  assignDate: { kind: 'mutation', args: { day: '12-25', image_id: null } },
  setDefaultImage: { kind: 'mutation', args: { image_id: null } },
}

describe('every public image-library function requires a current platform operator', () => {
  it('enumerates registered exports so a new public function cannot evade the refusal sweep', () => {
    const publicFunctions = Object.entries(panoramaModule).filter(([, value]) => {
      const fn = value as unknown as { isPublic?: boolean; exportArgs?: unknown }
      return typeof value === 'function' && typeof fn.exportArgs === 'function' && fn.isPublic
    })
    expect(publicFunctions.map(([name]) => name).sort()).toEqual(Object.keys(SURFACE).sort())
    for (const [name, value] of publicFunctions) {
      expect((value as unknown as { isQuery?: boolean }).isQuery ? 'query' : 'mutation').toBe(
        SURFACE[name].kind,
      )
    }
  })

  for (const [name, spec] of Object.entries(SURFACE)) {
    it(`${name} refuses anonymous, organization-admin and revoked-operator callers`, async () => {
      const t = testContext()
      const f = await withOrg(t)
      const op = await operator(t)
      await t.run((ctx) => ctx.db.delete(op.row))
      const ref = (api.panoramaImages as unknown as Record<string, unknown>)[name]
      const invoke = (caller: Caller) =>
        spec.kind === 'query'
          ? caller.query(
              ref as FunctionReference<'query', 'public', Record<string, unknown>>,
              spec.args,
            )
          : caller.mutation(
              ref as FunctionReference<'mutation', 'public', Record<string, unknown>>,
              spec.args,
            )
      await expectRefusal(invoke(t), 'forbidden', /not signed in/)
      await expectRefusal(invoke(as(t, f.admin)), 'forbidden', /not a platform operator/)
      await expectRefusal(invoke(op.asOp), 'forbidden', /not a platform operator/)
      expect(await images(t)).toEqual([])
      expect(await dates(t)).toEqual([])
      expect(await jobs(t)).toEqual([])
    })
  }
})

describe('manual library counters and retained import history', () => {
  it('creates a counters-only library without settings or scheduled imports', async () => {
    const { t, asOp } = await setup()
    expect(await asOp.query(api.panoramaImages.summary, {})).toEqual({
      pending: 0,
      approved: 0,
      removed: 0,
      total: 0,
    })
    await pending(t)
    const library = await state(t)
    expect(library).toMatchObject({ key: 'default', pending: 1, approved: 0, removed: 0 })
    for (const field of ['target', 'refill_batch_size', 'cursor', 'active_run_id', 'lease_until'])
      expect(library).not.toHaveProperty(field)
    expect(await runs(t)).toEqual([])
    expect(await jobs(t)).toEqual([])
  })

  it('ignores historical refill settings and preserves existing images, dates and run records', async () => {
    const { t, asOp } = await setup()
    const runId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('panorama_library', {
        key: 'default',
        pending: 0,
        approved: 0,
        removed: 0,
        target: 500,
        refill_batch_size: 100,
        cursor: { category: 1, continue: 'old-position' },
        active_run_id: runId,
        lease_until: Date.now() + 60_000,
      })
      await ctx.db.insert('panorama_refills', {
        id: runId,
        trigger: 'daily',
        status: 'completed',
        added: 100,
        skipped: 2,
        pages: 10,
        retries: 0,
        started_at: NOW,
        finished_at: NOW,
      })
    })
    const savedRun = await runs(t)
    const p = await pending(t)
    await asOp.mutation(api.panoramaImages.approve, { id: p.image.id })
    await asOp.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: p.image.id })
    expect(await asOp.query(api.panoramaImages.summary, {})).toEqual({
      pending: 0,
      approved: 1,
      removed: 0,
      total: 1,
    })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toMatchObject({
      id: p.image.id,
      source_id: p.image.source_id,
    })
    expect(await exists(t, p.storage_id)).toBe(true)
    expect(await runs(t)).toEqual(savedRun)
    expect(await jobs(t)).toEqual([])
    expect(await state(t)).toMatchObject({ active_run_id: runId, target: 500 })
  })
})

describe('review, explicit assignment and deletion', () => {
  it('keeps retained images pending and private to the operator until review and explicit assignment', async () => {
    const { t, asOp } = await setup()
    const { image } = await pending(t)
    const listing = await asOp.query(api.panoramaImages.library, { status: 'pending' })
    expect(listing.images).toHaveLength(1)
    expect(listing.images[0]).toMatchObject({
      id: image.id,
      status: 'pending',
      creator: image.creator,
    })
    for (const key of ['storage_id', 'download_url', 'source_metadata', 'reviewed_by']) {
      expect(listing.images[0]).not.toHaveProperty(key)
    }
    expect(listing.images[0].image_url).toEqual(expect.any(String))
    expect((await asOp.query(api.panoramaImages.calendar, {})).approved_images).toEqual([])
    await expectRefusal(
      asOp.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: image.id }),
      'rule',
      /approved image/,
    )
    await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    expect(await asOp.query(api.panoramaImages.summary, {})).toMatchObject({
      pending: 0,
      approved: 1,
      total: 1,
    })
    expect(await dates(t)).toEqual([])
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
    await asOp.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: image.id })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toMatchObject({
      id: image.id,
    })
    expect((await audit(t)).filter((row) => row.action === 'panorama_image_approved')).toHaveLength(
      1,
    )
  })

  it('replaces or clears one assigned week without changing other weeks', async () => {
    const { t, asOp } = await setup()
    const a = await pending(t)
    const b = await pending(t)
    for (const { image } of [a, b])
      await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    for (const day of ['W09', 'W10'])
      await asOp.mutation(api.panoramaImages.assignDate, { day, image_id: a.image.id })
    await asOp.mutation(api.panoramaImages.assignDate, { day: 'W09', image_id: b.image.id })
    expect(await dates(t)).toHaveLength(2)
    expect(await t.query(internal.panoramaImages.forDate, { date: '2028-02-29' })).toMatchObject({
      id: b.image.id,
    })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2028-03-06' })).toMatchObject({
      id: a.image.id,
    })
    await asOp.mutation(api.panoramaImages.assignDate, { day: 'W09', image_id: null })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2028-02-29' })).toBeNull()
    expect(await dates(t)).toHaveLength(1)
  })

  it('removes bytes and every assignment atomically while retaining source/hash tombstones', async () => {
    const { t, asOp } = await setup()
    const contents = 'original photograph bytes'
    const p = await pending(t, contents)
    await asOp.mutation(api.panoramaImages.approve, { id: p.image.id })
    for (const day of ['W09', 'W10', 'W52'])
      await asOp.mutation(api.panoramaImages.assignDate, { day, image_id: p.image.id })
    await asOp.mutation(api.panoramaImages.remove, {
      id: p.image.id,
      note: '  Unsuitable landmark  ',
    })
    await asOp.mutation(api.panoramaImages.remove, { id: p.image.id })
    expect(await exists(t, p.storage_id)).toBe(false)
    expect(await dates(t)).toEqual([])
    const [removed] = await images(t)
    expect(removed).toMatchObject({
      status: 'removed',
      sha256: p.image.sha256,
      source_id: p.image.source_id,
      review_note: 'Unsuitable landmark',
    })
    expect(removed.storage_id).toBeUndefined()
    expect(await asOp.query(api.panoramaImages.summary, {})).toMatchObject({
      pending: 0,
      approved: 0,
      removed: 1,
      total: 0,
    })
    expect((await asOp.query(api.panoramaImages.calendar, {})).approved_images).toEqual([])
    await expectRefusal(
      asOp.mutation(api.panoramaImages.approve, { id: p.image.id }),
      'rule',
      /pending/,
    )
    expect(await images(t)).toHaveLength(1)
    const events = (await audit(t)).filter((row) => row.action === 'panorama_image_removed')
    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({ cleared_dates: ['W09', 'W10', 'W52'] })
  })

  it('also removes pending images and refuses missing files, ids and overlong notes without changing counts', async () => {
    const { t, asOp } = await setup()
    const p = await pending(t)
    await expectRefusal(
      asOp.mutation(api.panoramaImages.remove, { id: p.image.id, note: 'x'.repeat(501) }),
      'bad_request',
      /500/,
    )
    await t.run((ctx) => ctx.storage.delete(p.storage_id))
    await expectRefusal(
      asOp.mutation(api.panoramaImages.approve, { id: p.image.id }),
      'rule',
      /available file/,
    )
    await expectRefusal(asOp.mutation(api.panoramaImages.approve, { id: 'missing' }), 'not_found')
    await expectRefusal(asOp.mutation(api.panoramaImages.remove, { id: 'missing' }), 'not_found')
    await asOp.mutation(api.panoramaImages.remove, { id: p.image.id })
    expect(await asOp.query(api.panoramaImages.summary, {})).toMatchObject({
      pending: 0,
      approved: 0,
      removed: 1,
    })
  })
})

describe('53 recurring ISO week assignments', () => {
  it('keeps all seven weekdays together across leap days, months and ISO year boundaries', async () => {
    const { t, asOp } = await setup()
    const assignments = new Map<string, string>()
    for (const day of ['W01', 'W09', 'W52', 'W53']) {
      const { image } = await pending(t)
      await asOp.mutation(api.panoramaImages.approve, { id: image.id })
      await asOp.mutation(api.panoramaImages.assignDate, { day, image_id: image.id })
      assignments.set(day, image.id)
    }
    const calendar = await asOp.query(api.panoramaImages.calendar, {})
    expect(calendar.slots).toHaveLength(53)
    expect(new Set(calendar.slots.map((slot) => slot.day)).size).toBe(53)
    for (const [week, start] of [
      ['W01', '2025-12-29'],
      ['W09', '2028-02-28'],
      ['W52', '2026-12-21'],
      ['W53', '2026-12-28'],
      ['W01', '2027-01-04'],
    ]) {
      for (let offset = 0; offset < 7; offset++) {
        const date = new Date(`${start}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() + offset)
        expect(
          await t.query(internal.panoramaImages.forDate, { date: date.toISOString().slice(0, 10) }),
        ).toMatchObject({ id: assignments.get(week) })
      }
    }
    expect(await t.query(internal.panoramaImages.forDate, { date: '2028-03-06' })).toBeNull()
  })

  it('preserves legacy daily rows deterministically and consolidates the whole week when edited', async () => {
    const { t, asOp } = await setup()
    const first = await pending(t)
    const latest = await pending(t)
    for (const { image } of [first, latest])
      await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('panorama_calendar', {
        day: '12-24',
        image_id: first.image.id,
        updated_at: '2026-09-01T00:00:00Z',
        updated_by: 'legacy',
      })
      await ctx.db.insert('panorama_calendar', {
        day: '12-25',
        image_id: latest.image.id,
        updated_at: '2026-09-02T00:00:00Z',
        updated_by: 'legacy',
      })
    })
    expect(
      (await asOp.query(api.panoramaImages.calendar, {})).slots.find((slot) => slot.day === 'W52')
        ?.image?.id,
    ).toBe(latest.image.id)
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-21' })).toMatchObject({
      id: latest.image.id,
    })
    await asOp.mutation(api.panoramaImages.assignDate, { day: 'W52', image_id: first.image.id })
    expect(await dates(t)).toHaveLength(1)
    expect((await dates(t))[0]).toMatchObject({ day: 'W52', image_id: first.image.id })
    await asOp.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: null })
    expect(await dates(t)).toEqual([])
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
  })

  it.each([true, false])(
    'removal clears a winning legacy week without reviving aliases (winner=%s)',
    async (removeWinner) => {
      const { t, asOp } = await setup()
      const older = await pending(t)
      const newer = await pending(t)
      const fallback = await pending(t)
      for (const { image } of [older, newer, fallback])
        await asOp.mutation(api.panoramaImages.approve, { id: image.id })
      await asOp.mutation(api.panoramaImages.setDefaultImage, { image_id: fallback.image.id })
      await t.run(async (ctx) => {
        await ctx.db.insert('panorama_calendar', {
          day: '09-14',
          image_id: older.image.id,
          updated_at: '2026-09-01T00:00:00Z',
          updated_by: 'legacy',
        })
        await ctx.db.insert('panorama_calendar', {
          day: '09-15',
          image_id: newer.image.id,
          updated_at: '2026-09-02T00:00:00Z',
          updated_by: 'legacy',
        })
      })
      await asOp.mutation(api.panoramaImages.remove, {
        id: (removeWinner ? newer : older).image.id,
      })
      expect(await t.query(internal.panoramaImages.forDate, { date: '2026-09-16' })).toMatchObject({
        id: (removeWinner ? fallback : newer).image.id,
      })
      expect(await dates(t)).toHaveLength(removeWinner ? 0 : 1)
    },
  )

  it.each(['W00', 'W54', 'W1', 'w01', '02-29', '04-31', '13-01', '00-12', '1-01', '2026-01-01'])(
    'rejects invalid recurring key %s',
    async (day) => {
      const { t, asOp } = await setup()
      await expectRefusal(
        asOp.mutation(api.panoramaImages.assignDate, { day, image_id: null }),
        'bad_request',
        /valid month and day/,
      )
      expect(await dates(t)).toEqual([])
    },
  )

  it.each([
    '2027-02-29',
    '2028-02-30',
    '2028-04-31',
    '2028-13-01',
    '2028-00-01',
    '2028-1-01',
    '2028-01-01T00:00:00Z',
    '',
  ])('rejects invalid date %s', async (date) => {
    await expectRefusal(
      testContext().query(internal.panoramaImages.forDate, { date }),
      'bad_request',
    )
  })
})

describe('approved default Canvas background', () => {
  it('uses the configured default for unassigned weeks while preserving the leap-day week', async () => {
    const { t, asOp } = await setup()
    const fallback = await pending(t)
    const scheduled = await pending(t)
    for (const { image } of [fallback, scheduled])
      await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    expect(await asOp.query(api.panoramaImages.calendar, {})).toMatchObject({
      default_image_id: null,
      default_image: null,
    })
    await asOp.mutation(api.panoramaImages.assignDate, {
      day: 'W09',
      image_id: scheduled.image.id,
    })
    await asOp.mutation(api.panoramaImages.setDefaultImage, { image_id: fallback.image.id })
    expect(await asOp.query(api.panoramaImages.calendar, {})).toMatchObject({
      default_image_id: fallback.image.id,
      default_image: { id: fallback.image.id, image_url: expect.any(String) },
    })
    for (const date of ['2026-12-25', '2028-03-06'])
      expect(await t.query(internal.panoramaImages.forDate, { date })).toMatchObject({
        id: fallback.image.id,
      })
    for (const date of ['2026-02-28', '2028-02-29'])
      expect(await t.query(internal.panoramaImages.forDate, { date })).toMatchObject({
        id: scheduled.image.id,
      })
    expect(await dates(t)).toHaveLength(1)

    // A disappeared scheduled file uses the same fallback as an empty date.
    await t.run((ctx) => ctx.storage.delete(scheduled.storage_id))
    expect(await t.query(internal.panoramaImages.forDate, { date: '2028-02-29' })).toMatchObject({
      id: fallback.image.id,
    })
    await asOp.mutation(api.panoramaImages.setDefaultImage, { image_id: null })
    expect(await state(t)).not.toHaveProperty('default_image_id')
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
    expect(await dates(t)).toHaveLength(1)
    const events = (await audit(t)).filter((row) => row.action === 'panorama_default_image_set')
    expect(events.map((row) => row.detail)).toEqual([
      { image_id: fallback.image.id, previous_image_id: null },
      { image_id: null, previous_image_id: fallback.image.id },
    ])
  })

  it('refuses pending, removed, missing and unavailable images without replacing the current default', async () => {
    const { t, asOp } = await setup()
    const fallback = await pending(t)
    const unreviewed = await pending(t)
    const removed = await pending(t)
    const unavailable = await pending(t)
    for (const { image } of [fallback, unavailable])
      await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    await asOp.mutation(api.panoramaImages.setDefaultImage, { image_id: fallback.image.id })
    await asOp.mutation(api.panoramaImages.remove, { id: removed.image.id })
    await t.run((ctx) => ctx.storage.delete(unavailable.storage_id))
    for (const image_id of [unreviewed.image.id, removed.image.id, unavailable.image.id, uuid()])
      await expectRefusal(
        asOp.mutation(api.panoramaImages.setDefaultImage, { image_id }),
        'rule',
        /approved image with an available file/,
      )
    expect(await state(t)).toMatchObject({ default_image_id: fallback.image.id })
  })

  it('clears the default and its bytes on removal, while keeping another default when removing a date image', async () => {
    const { t, asOp } = await setup()
    const fallback = await pending(t)
    const scheduled = await pending(t)
    for (const { image } of [fallback, scheduled])
      await asOp.mutation(api.panoramaImages.approve, { id: image.id })
    await asOp.mutation(api.panoramaImages.setDefaultImage, { image_id: fallback.image.id })
    await asOp.mutation(api.panoramaImages.assignDate, {
      day: '12-25',
      image_id: scheduled.image.id,
    })
    await asOp.mutation(api.panoramaImages.remove, { id: scheduled.image.id })
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toMatchObject({
      id: fallback.image.id,
    })
    await asOp.mutation(api.panoramaImages.remove, { id: fallback.image.id })
    expect(await exists(t, fallback.storage_id)).toBe(false)
    expect(await state(t)).not.toHaveProperty('default_image_id')
    expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
    expect(await asOp.query(api.panoramaImages.calendar, {})).toMatchObject({
      default_image_id: null,
      default_image: null,
    })
    const removals = (await audit(t)).filter((row) => row.action === 'panorama_image_removed')
    expect(removals.map((row) => row.detail.cleared_default)).toEqual([false, true])
  })

  it.each(['pending', 'removed', 'missing_file'] as const)(
    'does not serve a stale default that became %s',
    async (condition) => {
      const { t, asOp } = await setup()
      const fallback = await pending(t)
      await asOp.mutation(api.panoramaImages.approve, { id: fallback.image.id })
      await asOp.mutation(api.panoramaImages.setDefaultImage, { image_id: fallback.image.id })
      await t.run(async (ctx) => {
        if (condition === 'missing_file') await ctx.storage.delete(fallback.storage_id)
        else await ctx.db.patch(fallback.image._id, { status: condition })
      })
      expect(await t.query(internal.panoramaImages.forDate, { date: '2026-12-25' })).toBeNull()
      expect((await asOp.query(api.panoramaImages.calendar, {})).default_image).toBeNull()
    },
  )
})

describe('identifiable audit actors', () => {
  it.each([true, false])(
    'records the real operator email when available (%s), otherwise their auth id',
    async (withEmail) => {
      const t = testContext()
      let authId = uuid()
      const email = 'image-reviewer@platform.test'
      if (withEmail) {
        t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.ts'))
        const user = await t.mutation(components.betterAuth.adapter.create, {
          input: {
            model: 'user',
            data: {
              name: 'Image reviewer',
              email,
              emailVerified: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        })
        authId = user._id as string
      }
      const { asOp } = await operator(t, authId)
      const p = await pending(t)
      await asOp.mutation(api.panoramaImages.approve, { id: p.image.id })
      await asOp.mutation(api.panoramaImages.assignDate, { day: '12-25', image_id: p.image.id })
      await asOp.mutation(api.panoramaImages.remove, { id: p.image.id })
      const events = (await audit(t)).filter((row) => row.action.startsWith('panorama_'))
      expect(events.map((row) => row.action)).toEqual([
        'panorama_image_approved',
        'panorama_date_assigned',
        'panorama_image_removed',
      ])
      for (const event of events)
        expect(event).toMatchObject({
          actor_auth_id: authId,
          actor_email: withEmail ? email : authId,
        })
    },
  )
})

describe('storage ownership', () => {
  it('prevents attachment/avatar adoption of a library image and preserves existing bytes', async () => {
    const t = testContext()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const user = as(t, f.admin)
    const p = await pending(t)
    const attach = (storage_id: Id<'_storage'>) =>
      user.mutation(api.files.attach, {
        org_id: f.org.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id,
        name: 'photo.jpg',
        mime: 'image/jpeg',
        inline: false,
      })
    await expectRefusal(attach(p.storage_id), 'bad_request', /already attached/)
    await expectRefusal(
      user.mutation(api.files.setAvatar, { profile_id: f.admin.id, storage_id: p.storage_id }),
      'bad_request',
      /already in use/,
    )
    expect(await exists(t, p.storage_id)).toBe(true)
    expect(await images(t)).toHaveLength(1)
  })

  it('orphan cleanup keeps pending and approved backgrounds while removing old unreferenced bytes', async () => {
    const { t, asOp } = await setup()
    const a = await pending(t)
    const b = await pending(t)
    await asOp.mutation(api.panoramaImages.approve, { id: b.image.id })
    const orphan = await storage(t)
    vi.setSystemTime(Date.now() + 61 * 60_000)
    const fresh = await storage(t)
    expect(await t.mutation(internal.files.reapOrphans, {})).toEqual({ deleted: 1, kept: 3 })
    expect(await exists(t, orphan)).toBe(false)
    for (const id of [a.storage_id, b.storage_id, fresh]) expect(await exists(t, id)).toBe(true)
  })

  it('discard after an ambiguous upload response preserves every referenced file and is safe to repeat', async () => {
    const t = testContext()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const p = await pending(t)
    const attached = await storage(t)
    const avatar = await storage(t)
    const loose = await storage(t)
    await as(t, f.admin).mutation(api.files.attach, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: issue.id,
      storage_id: attached,
      name: 'existing.jpg',
      mime: 'image/jpeg',
      inline: false,
    })
    await as(t, f.admin).mutation(api.files.setAvatar, {
      profile_id: f.admin.id,
      storage_id: avatar,
    })
    for (const storage_id of [p.storage_id, attached, avatar, loose]) {
      await t.mutation(internal.panoramaImages.discardImport, { storage_id })
    }
    for (const id of [p.storage_id, attached, avatar]) expect(await exists(t, id)).toBe(true)
    expect(await exists(t, loose)).toBe(false)
    await t.mutation(internal.panoramaImages.discardImport, { storage_id: loose })
    expect(await images(t)).toHaveLength(1)
  })
})
