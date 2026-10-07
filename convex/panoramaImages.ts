/* Operator-only curation. No ordinary client receives pending images, and no
 * upload or approval assigns dates. Personal Canvas appearance reads only the
 * explicit approved calendar or default image. Files live in Convex storage. */
import { v } from 'convex/values'
import { components } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { storageIdInUse } from './files'
import {
  badRequest,
  conflict,
  notFound,
  platformMutation,
  platformQuery,
  rule,
} from './lib/functions'
import {
  calendarDayForDate,
  calendarDays,
  validateCalendarDay,
  vPanoramaStatus,
} from './lib/panorama'
import { calendarWeekForKey } from './lib/panoramaWeeks'
import { audit } from './model/admin'

const stateFor = (ctx: QueryCtx) =>
  ctx.db
    .query('panorama_library')
    .withIndex('by_key', (q) => q.eq('key', 'default'))
    .unique()
export const imageFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('panorama_images')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()

async function availableApprovedImage(ctx: QueryCtx, id: string | undefined) {
  const image = id ? await imageFor(ctx, id) : null
  return image?.status === 'approved' &&
    image.storage_id &&
    (await ctx.db.system.get(image.storage_id))
    ? image
    : null
}

export async function operatorEmail(ctx: MutationCtx, authUserId: string): Promise<string> {
  try {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: authUserId }],
    })) as { email?: string } | null
    return user?.email || authUserId
  } catch {
    return authUserId
  }
}

export async function ensureState(ctx: MutationCtx): Promise<Doc<'panorama_library'>> {
  const existing = await stateFor(ctx)
  if (existing) return existing
  const id = await ctx.db.insert('panorama_library', {
    key: 'default',
    pending: 0,
    approved: 0,
    removed: 0,
  })
  const row = await ctx.db.get(id)
  if (!row) throw new Error('image library creation failed')
  return row
}

export async function imageRow(ctx: QueryCtx, image: Doc<'panorama_images'>) {
  const {
    _id,
    _creationTime,
    source_metadata,
    storage_id,
    preview_storage_id,
    download_url,
    reviewed_by,
    ...row
  } = image
  const preview = preview_storage_id ? await ctx.db.system.get(preview_storage_id) : null
  return {
    ...row,
    image_url: storage_id ? await ctx.storage.getUrl(storage_id) : null,
    preview_url: preview_storage_id ? await ctx.storage.getUrl(preview_storage_id) : null,
    preview_byte_size: preview?.size ?? null,
  }
}

export const summary = platformQuery({
  args: {},
  handler: async (ctx) => {
    const state = await stateFor(ctx)
    return {
      pending: state?.pending ?? 0,
      approved: state?.approved ?? 0,
      removed: state?.removed ?? 0,
      total: (state?.pending ?? 0) + (state?.approved ?? 0),
    }
  },
})

export const library = platformQuery({
  args: {
    status: v.optional(vPanoramaStatus),
    cursor: v.optional(v.string()),
    agent_review: v.optional(
      v.union(v.literal('unreviewed'), v.literal('approved'), v.literal('declined')),
    ),
  },
  handler: async (ctx, { status, cursor, agent_review }) => {
    let query = status
      ? ctx.db.query('panorama_images').withIndex('by_status', (q) => q.eq('status', status))
      : ctx.db.query('panorama_images')
    if (agent_review) {
      const decision = agent_review === 'unreviewed' ? undefined : agent_review
      query = status
        ? ctx.db
            .query('panorama_images')
            .withIndex('by_status_agent_review', (q) =>
              q.eq('status', status).eq('agent_review', decision),
            )
        : query.filter((q) => q.eq(q.field('agent_review'), decision))
    }
    // New arrivals must not move the photo an operator is currently reviewing.
    const page = await query.order('asc').paginate({ cursor: cursor ?? null, numItems: 24 })
    return {
      images: await Promise.all(page.page.map((row) => imageRow(ctx, row))),
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const approve = platformMutation({
  args: { id: v.string(), expected_agent_review_id: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { id, expected_agent_review_id }) => {
    const image = await imageFor(ctx, id)
    if (!image) throw notFound('image not found')
    if (image.status === 'approved') return
    if ((image.agent_review_id ?? null) !== (expected_agent_review_id ?? null)) {
      throw conflict(
        'the agent precheck changed; review the latest decision before approving',
        'agent_review_changed',
      )
    }
    if (
      image.status !== 'pending' ||
      !image.storage_id ||
      !(await ctx.db.system.get(image.storage_id))
    ) {
      throw rule('only a pending image with an available file can be approved')
    }
    const state = await ensureState(ctx)
    await ctx.db.patch(image._id, {
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: ctx.authUserId,
    })
    await ctx.db.patch(state._id, { pending: state.pending - 1, approved: state.approved + 1 })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_image_approved',
      detail: { image_id: id, title: image.title },
    })
  },
})

export const remove = platformMutation({
  args: { id: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { id, note }) => {
    if (note && note.length > 500) throw badRequest('keep the review note within 500 characters')
    const image = await imageFor(ctx, id)
    if (!image) throw notFound('image not found')
    if (image.status === 'removed') return
    const calendarRows = await ctx.db.query('panorama_calendar').collect()
    const clearedWeeks = new Set(
      [...assignmentsByWeek(calendarRows)]
        .filter(([, row]) => row.image_id === id)
        .map(([week]) => week),
    )
    // Removing a winning legacy assignment must not reveal its superseded photo.
    const dates = calendarRows.filter(
      (row) => row.image_id === id || clearedWeeks.has(calendarWeekForKey(row.day)),
    )
    for (const date of dates) await ctx.db.delete(date._id)
    if (image.storage_id && (await ctx.db.system.get(image.storage_id)))
      await ctx.storage.delete(image.storage_id)
    if (image.preview_storage_id && (await ctx.db.system.get(image.preview_storage_id)))
      await ctx.storage.delete(image.preview_storage_id)
    await ctx.db.patch(image._id, {
      status: 'removed',
      storage_id: undefined,
      preview_storage_id: undefined,
      preview_version: undefined,
      reviewed_at: new Date().toISOString(),
      reviewed_by: ctx.authUserId,
      review_note: note?.trim() || undefined,
    })
    const state = await ensureState(ctx)
    await ctx.db.patch(state._id, {
      [image.status]: state[image.status] - 1,
      removed: state.removed + 1,
      ...(state.default_image_id === id ? { default_image_id: undefined } : {}),
    })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_image_removed',
      detail: {
        image_id: id,
        title: image.title,
        cleared_dates: dates.map((d) => d.day),
        cleared_default: state.default_image_id === id,
        note: note?.trim() ?? '',
      },
    })
  },
})

/** Newest legacy daily assignment wins when several fall in the same week.
 * Saving or clearing that week consolidates all its old rows atomically. */
export function assignmentsByWeek(rows: Doc<'panorama_calendar'>[]) {
  const byWeek = new Map<string, Doc<'panorama_calendar'>>()
  for (const row of [...rows].sort(
    (a, b) =>
      a.updated_at.localeCompare(b.updated_at) ||
      a._creationTime - b._creationTime ||
      a.day.localeCompare(b.day),
  ))
    byWeek.set(calendarWeekForKey(row.day), row)
  return byWeek
}

export async function assignmentForWeek(ctx: QueryCtx, key: string) {
  return (
    assignmentsByWeek(await ctx.db.query('panorama_calendar').collect()).get(
      calendarWeekForKey(key),
    ) ?? null
  )
}

export async function writeCalendarWeek(
  ctx: MutationCtx,
  key: string,
  imageId: string | null,
  authUserId: string,
) {
  const week = calendarWeekForKey(key)
  const rows = (await ctx.db.query('panorama_calendar').collect()).filter(
    (row) => calendarWeekForKey(row.day) === week,
  )
  for (const row of rows) await ctx.db.delete(row._id)
  if (imageId !== null)
    await ctx.db.insert('panorama_calendar', {
      day: week,
      image_id: imageId,
      updated_at: new Date().toISOString(),
      updated_by: authUserId,
    })
}

export const calendar = platformQuery({
  args: {},
  handler: async (ctx) => {
    const approved = await ctx.db
      .query('panorama_images')
      .withIndex('by_status', (q) => q.eq('status', 'approved'))
      .collect()
    const images = await Promise.all(approved.map((row) => imageRow(ctx, row)))
    images.sort((a, b) => a.title.localeCompare(b.title))
    const byId = new Map(images.map((row) => [row.id, row]))
    const dates = await ctx.db.query('panorama_calendar').collect()
    const byDay = assignmentsByWeek(dates)
    const state = await stateFor(ctx)
    const defaultImage = await availableApprovedImage(ctx, state?.default_image_id)
    return {
      slots: calendarDays().map((day) => ({
        day,
        image: byId.get(byDay.get(day)?.image_id ?? '') ?? null,
      })),
      approved_images: images,
      default_image_id: state?.default_image_id ?? null,
      default_image: defaultImage ? (byId.get(defaultImage.id) ?? null) : null,
    }
  },
})

export const assignDate = platformMutation({
  args: { day: v.string(), image_id: v.union(v.string(), v.null()) },
  handler: async (ctx, { day, image_id }) => {
    validateCalendarDay(day)
    const week = calendarWeekForKey(day)
    const existing = await assignmentForWeek(ctx, week)
    if (image_id !== null && !(await availableApprovedImage(ctx, image_id)))
      throw rule('choose an approved image with an available file')
    await writeCalendarWeek(ctx, week, image_id, ctx.authUserId)
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_date_assigned',
      detail: { day: week, image_id, previous_image_id: existing?.image_id ?? null },
    })
  },
})

export const setDefaultImage = platformMutation({
  args: { image_id: v.union(v.string(), v.null()) },
  handler: async (ctx, { image_id }) => {
    if (image_id !== null && !(await availableApprovedImage(ctx, image_id))) {
      throw rule('choose an approved image with an available file')
    }
    const state = await ensureState(ctx)
    if ((state.default_image_id ?? null) === image_id) return
    await ctx.db.patch(state._id, { default_image_id: image_id ?? undefined })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_default_image_set',
      detail: { image_id, previous_image_id: state.default_image_id ?? null },
    })
  },
})

/* Shared resolution for the account renderer and internal calendar checks.
 * Calendar assignments take precedence over the explicit default. Both must
 * remain approved and retain their file; an arbitrary library image never fills
 * a gap. Every UTC date in an ISO Monday–Sunday week resolves the same slot. */
export async function approvedImageForDate(ctx: QueryCtx, date: string) {
  const day = calendarDayForDate(date)
  const slot = await assignmentForWeek(ctx, day)
  const image = await availableApprovedImage(ctx, slot?.image_id)
  if (image) return image
  const state = await stateFor(ctx)
  return availableApprovedImage(ctx, state?.default_image_id)
}

/** Display-only projection shared by the signed-in app and public demo feed.
 * Deliberately do not use imageRow: operator review/source records stay private. */
export async function canvasImageForDate(ctx: QueryCtx, date: string) {
  const image = await approvedImageForDate(ctx, date)
  if (!image?.storage_id) return null
  return {
    id: image.id,
    image_url: await ctx.storage.getUrl(image.storage_id),
    preview_url: image.preview_storage_id
      ? await ctx.storage.getUrl(image.preview_storage_id)
      : null,
    title: image.title,
    location: image.location,
    creator: image.creator,
    filename: image.filename,
    attribution: image.attribution,
    source_url: image.source_url,
    license: image.license,
    license_url: image.license_url,
  }
}

export const forDate = internalQuery({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const image = await approvedImageForDate(ctx, date)
    return image ? imageRow(ctx, image) : null
  },
})

/* A mutation acknowledgment can fail after a successful commit. Cleanup must
 * check references before deleting, even if a manual upload or proposal
 * attachment appears to have failed. */
export const discardImport = internalMutation({
  args: { storage_id: v.id('_storage') },
  handler: async (ctx, { storage_id }) => {
    if ((await ctx.db.system.get(storage_id)) && !(await storageIdInUse(ctx, storage_id)))
      await ctx.storage.delete(storage_id)
  },
})
