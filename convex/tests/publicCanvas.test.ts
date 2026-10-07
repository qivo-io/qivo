import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import authSchema from '../betterAuth/schema'
import { as, expectRefusal, NOW, newT, type T, uuid, withOrg } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[])
}

beforeEach(() => vi.stubEnv('APP_MODE', 'normal'))
afterEach(() => vi.unstubAllEnvs())

function request(
  t: T,
  query = '?date=2026-09-14',
  method = 'GET',
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return (
    t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string> },
      ): Promise<Response>
    }
  ).fetch(`/public/canvas${query}`, {
    method,
    headers: { Origin: 'https://demo.qivo.io', ...extraHeaders },
  })
}

async function libraryImage(t: T, status: 'approved' | 'pending' | 'removed' = 'approved') {
  return t.run(async (ctx) => {
    const storage_id = await ctx.storage.store(new Blob(['original photograph']) as never)
    const preview_storage_id = await ctx.storage.store(new Blob(['preview photograph']) as never)
    const file = await ctx.db.system.get(storage_id)
    if (!file) throw new Error('fixture file missing')
    const _id = await ctx.db.insert('panorama_images', {
      id: uuid(),
      source_id: 'private-ingestion-reference',
      source_url: 'https://photographer.example/photo',
      download_url: 'https://private-import.example/file?key=operator-only',
      title: 'Upper Austria at sunset',
      location: 'Upper Austria',
      creator: 'Photographer',
      filename: 'sunset.jpg',
      license: 'Permission confirmed by uploader',
      license_url: '',
      attribution: 'Upper Austria at sunset — Photographer',
      source_metadata: '{"private":"operator source metadata"}',
      review_note: 'Private review note',
      reviewed_by: 'private-operator-account',
      agent_reviewer: 'private-agent-account',
      storage_id,
      preview_storage_id,
      width: 1920,
      height: 1280,
      byte_size: file.size,
      sha256: file.sha256,
      status,
      imported_at: NOW,
    })
    const row = await ctx.db.get(_id)
    if (!row) throw new Error('fixture image missing')
    return {
      ...row,
      image_url: await ctx.storage.getUrl(storage_id),
      preview_url: await ctx.storage.getUrl(preview_storage_id),
    }
  })
}

const defaultImage = (t: T, image_id: string) =>
  t.run((ctx) =>
    ctx.db.insert('panorama_library', {
      key: 'default',
      pending: 0,
      approved: 1,
      removed: 0,
      default_image_id: image_id,
    }),
  )
const weeklyImage = (t: T, image_id: string) =>
  t.run((ctx) =>
    ctx.db.insert('panorama_calendar', {
      day: 'W38',
      image_id,
      updated_at: NOW,
      updated_by: 'private-operator-account',
    }),
  )
async function read(t: T, query?: string) {
  const response = await request(t, query)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return JSON.parse(await response.text())
}

describe('public approved Canvas feed', () => {
  it('returns the app display DTO without authentication or operator metadata', async () => {
    const t = newT()
    const image = await libraryImage(t)
    await weeklyImage(t, image.id)
    // The anonymous endpoint needs no Better Auth component or user to exist.
    const response = await request(t, undefined, 'GET', {
      Cookie: 'untrusted=ignored',
      'Better-Auth-Cookie': 'untrusted=ignored',
      Authorization: 'Bearer ignored',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const publicImage = JSON.parse(await response.text())
    expect(publicImage).toEqual({
      id: image.id,
      image_url: image.image_url,
      preview_url: image.preview_url,
      title: image.title,
      location: image.location,
      creator: image.creator,
      filename: image.filename,
      attribution: image.attribution,
      source_url: image.source_url,
      license: image.license,
      license_url: image.license_url,
    })

    t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
    const org = await withOrg(t)
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name: 'Viewer',
          email: 'viewer@canvas.test',
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    await t.run((ctx) => ctx.db.patch(org.user._id, { auth_user_id: user._id as string }))
    expect(
      await as(t, { ...org.user, auth_user_id: user._id as string }).query(
        api.appearance.dailyImage,
        { date: '2026-09-14' },
      ),
    ).toEqual(publicImage)
    await expectRefusal(
      t.query(api.appearance.dailyImage, { date: '2026-09-14' }),
      'forbidden',
      /not signed in/,
    )
  })

  it('uses the same ISO week, falls back to the approved default, and observes withdrawal', async () => {
    const t = newT()
    const scheduled = await libraryImage(t)
    const fallback = await libraryImage(t)
    await libraryImage(t) // An unselected approved photo cannot fill a gap.
    await weeklyImage(t, scheduled.id)
    await defaultImage(t, fallback.id)
    expect((await read(t)).id).toBe(scheduled.id)
    expect((await read(t, '?date=2026-09-20')).id).toBe(scheduled.id)
    expect((await read(t, '?date=2026-09-21')).id).toBe(fallback.id)
    await t.run((ctx) => ctx.db.patch(scheduled._id, { status: 'pending' }))
    expect((await read(t)).id).toBe(fallback.id)
    await t.run((ctx) => ctx.db.patch(scheduled._id, { status: 'removed' }))
    expect((await read(t)).id).toBe(fallback.id)
    await t.run(async (ctx) => {
      await ctx.db.patch(scheduled._id, { status: 'approved' })
      await ctx.storage.delete(scheduled.storage_id!)
    })
    expect((await read(t)).id).toBe(fallback.id)
    await t.run((ctx) => ctx.db.patch(fallback._id, { status: 'removed' }))
    expect(await read(t)).toBeNull()
  })

  it('never resolves a personal background even if its id is placed in shared selection', async () => {
    const t = newT()
    const privateId = uuid()
    await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob(['private photo']) as never)
      await ctx.db.insert('custom_backgrounds', {
        id: privateId,
        auth_user_id: 'private-owner',
        storage_id,
        name: 'Private family photograph.jpg',
        mime: 'image/jpeg',
        width: 1920,
        height: 1280,
        byte_size: 13,
        sha256: 'private-file-hash',
        uploaded_at: NOW,
      })
      await ctx.db.insert('account_appearance', {
        auth_user_id: 'private-owner',
        mode: 'blue',
        image_source: 'custom',
        custom_image_id: privateId,
        revision: uuid(),
        updated_at: NOW,
      })
    })
    await weeklyImage(t, privateId)
    await defaultImage(t, privateId)
    expect(await read(t)).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('custom_backgrounds').collect())).toHaveLength(1)
  })

  it.each([
    '',
    '?date=',
    '?date=2026-9-14',
    '?date=2026-02-29',
    '?date=2026-09-31',
    '?date=2026-09-14T00:00:00Z',
    '?date=https://example.test/image',
    '?date=2026-09-14&date=2026-09-15',
    '?date=2026-09-14&url=https://example.test/image',
    '?date=2026-09-14&image_id=private',
  ])('refuses malformed or additional input: %s', async (query) => {
    const response = await request(newT(), query)
    expect(response.status).toBe(400)
    expect(JSON.parse(await response.text())).toEqual({
      error: 'Use one valid date in YYYY-MM-DD format.',
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('accepts leap-day dates and public preflight without creating a login', async () => {
    const t = newT()
    expect(await read(t, '?date=2028-02-29')).toBeNull()
    const response = await request(t, '', 'OPTIONS')
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect((await request(t, '', 'POST')).status).toBe(404)
  })

  it('refuses the feed on demo deployments even when an approved library exists', async () => {
    const t = newT()
    const image = await libraryImage(t)
    await defaultImage(t, image.id)
    vi.stubEnv('APP_MODE', 'demo')
    for (const method of ['GET', 'OPTIONS']) {
      const response = await request(t, undefined, method)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
    expect(await t.query(internal.appearance.publicCanvas, { date: '2026-09-14' })).toBeNull()
  })
})
