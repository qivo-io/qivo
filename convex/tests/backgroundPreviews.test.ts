import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { BACKGROUND_PREVIEW_VERSION } from '../lib/backgroundPreviews'
import { imageRow } from '../panoramaImages'
import { as, expectRefusal, NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function file(t: T, mime = 'image/webp') {
  return t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([uuid()], { type: mime }) as never)
    await ctx.db.patch(id as never, { contentType: mime } as never)
    return id
  })
}
async function libraryImage(t: T) {
  const storage_id = await file(t, 'image/jpeg')
  const id = uuid()
  const rowId = await t.run((ctx) =>
    ctx.db.insert('panorama_images', {
      id,
      storage_id,
      source_id: uuid(),
      source_url: '',
      download_url: '',
      title: 'Lake',
      creator: 'Photographer',
      license: 'CC0',
      license_url: '',
      attribution: '',
      source_metadata: '{}',
      sha256: uuid(),
      width: 1920,
      height: 1080,
      byte_size: 32,
      status: 'pending',
      imported_at: NOW,
    }),
  )
  return { kind: 'library' as const, id, storage_id, rowId }
}
async function customImage(t: T) {
  const storage_id = await file(t, 'image/jpeg')
  const id = uuid()
  const rowId = await t.run((ctx) =>
    ctx.db.insert('custom_backgrounds', {
      id,
      auth_user_id: uuid(),
      storage_id,
      name: 'Private.jpg',
      mime: 'image/jpeg',
      width: 1920,
      height: 1080,
      byte_size: 32,
      sha256: uuid(),
      uploaded_at: NOW,
    }),
  )
  return { kind: 'custom' as const, id, storage_id, rowId }
}
const jobArgs = ({
  kind,
  id,
  storage_id,
}: {
  kind: 'library' | 'custom'
  id: string
  storage_id: Id<'_storage'>
}) => ({
  kind,
  id,
  storage_id,
})
const exists = (t: T, id: Id<'_storage'>) => t.run(async (ctx) => !!(await ctx.db.system.get(id)))

describe('preview identity, storage ownership and cleanup', () => {
  it('attaches once, publishes a preview URL without its storage ID, and deletes race-losing files', async () => {
    const t = newT()
    const image = await libraryImage(t)
    const preview = await file(t)
    expect(
      (await t.run(async (ctx) => imageRow(ctx, (await ctx.db.get(image.rowId))!)))
        .preview_byte_size,
    ).toBeNull()
    const args = {
      ...jobArgs(image),
      preview_storage_id: preview,
      preview_version: BACKGROUND_PREVIEW_VERSION,
    }
    expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(true)
    expect(await t.mutation(internal.backgroundPreviews.attach, args)).toBe(true)
    expect(await t.mutation(internal.backgroundPreviews.attach, args)).toBe(true)
    expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(false)
    const second = await file(t)
    expect(
      await t.mutation(internal.backgroundPreviews.attach, { ...args, preview_storage_id: second }),
    ).toBe(false)
    expect(await exists(t, second)).toBe(false)
    const publicRow = await t.run(async (ctx) => imageRow(ctx, (await ctx.db.get(image.rowId))!))
    expect(publicRow.preview_url).toEqual(expect.any(String))
    expect(publicRow.image_url).toEqual(expect.any(String))
    expect(publicRow.preview_byte_size).toBe(
      (await t.run((ctx) => ctx.db.system.get(preview)))!.size,
    )
    expect(publicRow).not.toHaveProperty('preview_storage_id')
    await t.mutation(internal.panoramaImages.discardImport, { storage_id: preview })
    expect(await exists(t, preview)).toBe(true)
    await t.run((ctx) => ctx.storage.delete(preview))
    expect(
      (await t.run(async (ctx) => imageRow(ctx, (await ctx.db.get(image.rowId))!)))
        .preview_byte_size,
    ).toBeNull()
    expect(await t.mutation(internal.backgroundPreviews.attach, args)).toBe(false)
    expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(true)
  })

  it.each(['removed', 'replaced', 'deleted'] as const)(
    'discards derivatives if the source became %s during encoding',
    async (state) => {
      const t = newT()
      const image = await libraryImage(t)
      const preview = await file(t)
      const replacement = await file(t, 'image/jpeg')
      await t.run(async (ctx) => {
        if (state === 'removed') await ctx.db.patch(image.rowId, { status: 'removed' })
        if (state === 'replaced') await ctx.db.patch(image.rowId, { storage_id: replacement })
        if (state === 'deleted') await ctx.db.delete(image.rowId)
      })
      expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(false)
      expect(
        await t.mutation(internal.backgroundPreviews.attach, {
          ...jobArgs(image),
          preview_storage_id: preview,
          preview_version: BACKGROUND_PREVIEW_VERSION,
        }),
      ).toBe(false)
      expect(await exists(t, preview)).toBe(false)
      expect(await exists(t, image.storage_id)).toBe(true)
      expect(await exists(t, replacement)).toBe(true)
    },
  )

  it('protects both library and private derivatives from attachment/avatar adoption and orphan cleanup', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const library = await libraryImage(t)
    const libraryPreview = await file(t)
    await t.mutation(internal.backgroundPreviews.attach, {
      ...jobArgs(library),
      preview_storage_id: libraryPreview,
      preview_version: BACKGROUND_PREVIEW_VERSION,
    })
    const customOriginal = await file(t, 'image/jpeg')
    const customPreview = await file(t)
    const customId = uuid()
    await t.run((ctx) =>
      ctx.db.insert('custom_backgrounds', {
        id: customId,
        auth_user_id: 'owner',
        storage_id: customOriginal,
        name: 'Private.jpg',
        mime: 'image/jpeg',
        width: 1920,
        height: 1080,
        byte_size: 32,
        sha256: uuid(),
        uploaded_at: NOW,
      }),
    )
    expect(
      await t.mutation(internal.backgroundPreviews.attach, {
        kind: 'custom',
        id: customId,
        storage_id: customOriginal,
        preview_storage_id: customPreview,
        preview_version: BACKGROUND_PREVIEW_VERSION,
      }),
    ).toBe(true)
    for (const storage_id of [libraryPreview, customPreview]) {
      await expectRefusal(
        as(t, f.admin).mutation(api.files.attach, {
          org_id: f.org.id,
          id: uuid(),
          issue_id: issue.id,
          storage_id,
          name: 'preview.webp',
          mime: 'image/webp',
          inline: false,
        }),
        'bad_request',
        /already attached/,
      )
      await expectRefusal(
        as(t, f.admin).mutation(api.files.setAvatar, { profile_id: f.admin.id, storage_id }),
        'bad_request',
        /already in use/,
      )
      // A failed processor cannot destroy an already-referenced derivative.
      await t.mutation(internal.panoramaImages.discardImport, { storage_id })
    }
    vi.setSystemTime(Date.now() + 61 * 60_000)
    expect(await t.mutation(internal.files.reapOrphans, {})).toEqual({ deleted: 0, kept: 4 })
    expect(await exists(t, libraryPreview)).toBe(true)
    expect(await exists(t, customPreview)).toBe(true)
  })

  it('removes library originals and derivatives together', async () => {
    const t = newT()
    const image = await libraryImage(t)
    const preview = await file(t)
    const authId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('platform_admins', {
        auth_user_id: authId,
        note: 'preview removal test',
        created_at: NOW,
      })
      await ctx.db.insert('panorama_library', {
        key: 'default',
        pending: 1,
        approved: 0,
        removed: 0,
      })
    })
    await t.mutation(internal.backgroundPreviews.attach, {
      ...jobArgs(image),
      preview_storage_id: preview,
      preview_version: BACKGROUND_PREVIEW_VERSION,
    })
    await t.withIdentity({ subject: authId }).mutation(api.panoramaImages.remove, { id: image.id })
    expect(await exists(t, image.storage_id)).toBe(false)
    expect(await exists(t, preview)).toBe(false)
    expect(await t.run((ctx) => ctx.db.get(image.rowId))).not.toHaveProperty('preview_storage_id')
    expect(await t.run((ctx) => ctx.db.get(image.rowId))).not.toHaveProperty('preview_version')
  })

  it.each(['library', 'custom'] as const)(
    'replaces a legacy %s preview only after the new version is ready',
    async (kind) => {
      const t = newT()
      const image = await (kind === 'library' ? libraryImage(t) : customImage(t))
      const previous = await file(t)
      await t.run((ctx) => ctx.db.patch(image.rowId, { preview_storage_id: previous }))
      expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(true)
      expect(await t.mutation(internal.backgroundPreviews.backfill, { kind })).toEqual({
        queued: 1,
        isDone: true,
      })
      expect(await exists(t, previous)).toBe(true)
      expect(await t.run((ctx) => ctx.db.get(image.rowId))).toMatchObject({
        preview_storage_id: previous,
      })

      const next = await file(t)
      const args = {
        ...jobArgs(image),
        preview_storage_id: next,
        preview_version: BACKGROUND_PREVIEW_VERSION,
      }
      expect(await t.mutation(internal.backgroundPreviews.attach, args)).toBe(true)
      expect(await t.run((ctx) => ctx.db.get(image.rowId))).toMatchObject({
        storage_id: image.storage_id,
        preview_storage_id: next,
        preview_version: BACKGROUND_PREVIEW_VERSION,
      })
      expect(await exists(t, image.storage_id)).toBe(true)
      expect(await exists(t, previous)).toBe(false)
      expect(await exists(t, next)).toBe(true)
      expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(false)
      expect(await t.mutation(internal.backgroundPreviews.backfill, { kind })).toEqual({
        queued: 0,
        isDone: true,
      })
      expect(await t.mutation(internal.backgroundPreviews.attach, args)).toBe(true)

      for (const version of [1, BACKGROUND_PREVIEW_VERSION]) {
        const loser = await file(t)
        expect(
          await t.mutation(internal.backgroundPreviews.attach, {
            ...args,
            preview_storage_id: loser,
            preview_version: version,
          }),
        ).toBe(false)
        expect(await exists(t, loser)).toBe(false)
        expect(await exists(t, next)).toBe(true)
        expect(await t.run((ctx) => ctx.db.get(image.rowId))).toMatchObject({
          preview_storage_id: next,
          preview_version: BACKGROUND_PREVIEW_VERSION,
        })
      }
    },
  )

  it('rejects an outdated processor even before any replacement has attached', async () => {
    const t = newT()
    const image = await libraryImage(t)
    const previous = await file(t)
    const stale = await file(t)
    await t.run((ctx) =>
      ctx.db.patch(image.rowId, {
        preview_storage_id: previous,
        preview_version: 1,
      }),
    )
    expect(
      await t.mutation(internal.backgroundPreviews.attach, {
        ...jobArgs(image),
        preview_storage_id: stale,
        preview_version: 1,
      }),
    ).toBe(false)
    expect(await exists(t, stale)).toBe(false)
    expect(await exists(t, previous)).toBe(true)
    expect(await t.query(internal.backgroundPreviews.source, jobArgs(image))).toBe(true)
  })

  it('keeps replaced preview bytes if another background still owns them', async () => {
    const t = newT()
    const library = await libraryImage(t)
    const custom = await customImage(t)
    const shared = await file(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(library.rowId, { preview_storage_id: shared })
      await ctx.db.patch(custom.rowId, { preview_storage_id: shared })
    })
    expect(
      await t.mutation(internal.backgroundPreviews.attach, {
        ...jobArgs(library),
        preview_storage_id: await file(t),
        preview_version: BACKGROUND_PREVIEW_VERSION,
      }),
    ).toBe(true)
    expect(await exists(t, shared)).toBe(true)
    expect(await t.run((ctx) => ctx.db.get(custom.rowId))).toMatchObject({
      preview_storage_id: shared,
    })
  })

  it.each(['library', 'custom'] as const)(
    'recovers missing current %s previews without trying to regenerate future versions',
    async (kind) => {
      const t = newT()
      const makeImage = kind === 'library' ? libraryImage : customImage
      const current = await makeImage(t)
      const future = await makeImage(t)
      const missingFile = await file(t)
      await t.run(async (ctx) => {
        await ctx.db.patch(current.rowId, {
          preview_storage_id: missingFile,
          preview_version: BACKGROUND_PREVIEW_VERSION,
        })
        await ctx.db.patch(future.rowId, {
          preview_storage_id: missingFile,
          preview_version: BACKGROUND_PREVIEW_VERSION + 1,
        })
        await ctx.storage.delete(missingFile)
      })
      expect(await t.query(internal.backgroundPreviews.source, jobArgs(current))).toBe(true)
      expect(await t.query(internal.backgroundPreviews.source, jobArgs(future))).toBe(false)
      expect(await t.mutation(internal.backgroundPreviews.backfill, { kind })).toEqual({
        queued: 1,
        isDone: true,
      })
      const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
      expect(jobs).toHaveLength(1)
      expect(jobs[0].args).toEqual([jobArgs(current)])
    },
  )

  it('backfills missing and outdated previews, skipping ready, future and removed images', async () => {
    const t = newT()
    const missing = await libraryImage(t)
    const ready = await libraryImage(t)
    const outdated = await libraryImage(t)
    const future = await libraryImage(t)
    const removed = await libraryImage(t)
    await t.mutation(internal.backgroundPreviews.attach, {
      ...jobArgs(ready),
      preview_storage_id: await file(t),
      preview_version: BACKGROUND_PREVIEW_VERSION,
    })
    const outdatedPreview = await file(t)
    const futurePreview = await file(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(removed.rowId, { status: 'removed' })
      await ctx.db.patch(outdated.rowId, {
        preview_storage_id: outdatedPreview,
        preview_version: 1,
      })
      await ctx.db.patch(future.rowId, {
        preview_storage_id: futurePreview,
        preview_version: BACKGROUND_PREVIEW_VERSION + 1,
      })
    })
    expect(await t.mutation(internal.backgroundPreviews.backfill, { kind: 'library' })).toEqual({
      queued: 2,
      isDone: true,
    })
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(jobs).toHaveLength(2)
    expect(jobs.map((job) => job.args)).toEqual(
      expect.arrayContaining([[jobArgs(missing)], [jobArgs(outdated)]]),
    )
    expect(await exists(t, outdatedPreview)).toBe(true)
    expect(await t.query(internal.backgroundPreviews.source, jobArgs(future))).toBe(false)
    expect(await t.mutation(internal.backgroundPreviews.backfill, { kind: 'custom' })).toEqual({
      queued: 0,
      isDone: true,
    })
  })
})
