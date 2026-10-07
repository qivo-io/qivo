/* Platform-owned curation keys and agent PRECHECKS. Org keys have no access.
 * Agent decisions never approve a file for use, delete bytes or write dates.
 * Source-link submissions need a legitimately obtained file and final human
 * approval. Nothing in this module fetches or scrapes an Unsplash page. */
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { storageIdInUse } from './files'
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  platformAction,
  platformMutation,
  platformQuery,
  rule,
} from './lib/functions'
import {
  jpegDimensions,
  PANORAMA_MAX_BYTES,
  validateCalendarDay,
  vPanoramaStatus,
} from './lib/panorama'
import {
  CURATION_TOKEN_PREFIX,
  parseCurationReview,
  parseCurationSubmission,
  parseUnsplashReference,
} from './lib/panoramaCuration'
import { panoramaFilename } from './lib/panoramaFilename'
import { validatePanoramaFile } from './lib/panoramaImage'
import { sha256hex } from './machine/auth'
import { audit } from './model/admin'
import {
  assignmentForWeek,
  ensureState,
  imageFor,
  imageRow,
  operatorEmail,
  writeCalendarWeek,
} from './panoramaImages'

declare const crypto: { randomUUID(): string }

const vDecision = v.union(v.literal('approved'), v.literal('declined'))
const vReviewFilter = v.union(v.literal('unreviewed'), v.literal('approved'), v.literal('declined'))
const keyFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('panorama_curation_keys')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()
const submissionFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('panorama_submissions')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()

async function requireOperator(ctx: QueryCtx, authId: string) {
  if (
    !(await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
      .first())
  )
    throw forbidden('not a platform operator')
}

async function requireKey(ctx: QueryCtx, id: string) {
  const key = await keyFor(ctx, id)
  if (!key || key.revoked_at || key.expires_at <= new Date().toISOString())
    throw forbidden('invalid or expired curation key')
  if (
    !(await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', key.created_by))
      .first())
  )
    throw forbidden('invalid or expired curation key')
  return key
}

const agentActor = (key: Doc<'panorama_curation_keys'>) => ({
  actor_auth_id: key.created_by,
  actor_email: `${key.created_by_email} / curation: ${key.name}`,
})

async function submissionRow(ctx: QueryCtx, row: Doc<'panorama_submissions'>) {
  const { _id, _creationTime, payload_json, key_id, request_id, reviewed_by, ...value } = row
  const image = row.image_id ? await imageFor(ctx, row.image_id) : null
  const slot = await assignmentForWeek(ctx, row.day)
  const existing = slot ? await imageFor(ctx, slot.image_id) : null
  return {
    ...value,
    ...(!row.agent_review_id && image?.agent_review_id
      ? {
          agent_review: image.agent_review,
          agent_review_note: image.agent_review_note,
          agent_reviewed_at: image.agent_reviewed_at,
          agent_review_id: image.agent_review_id,
          agent_reviewer: image.agent_reviewer,
        }
      : {}),
    image_url: image?.storage_id ? await ctx.storage.getUrl(image.storage_id) : null,
    preview_url: image?.preview_storage_id
      ? await ctx.storage.getUrl(image.preview_storage_id)
      : null,
    existing_image_id: slot?.image_id ?? null,
    existing_image_title: existing?.title ?? null,
  }
}

async function listSubmissions(ctx: QueryCtx, cursor?: string) {
  const page = await ctx.db
    .query('panorama_submissions')
    .order('desc')
    .paginate({ numItems: 24, cursor: cursor ?? null })
  return {
    submissions: await Promise.all(page.page.map((row) => submissionRow(ctx, row))),
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  }
}

export const keys = platformQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query('panorama_curation_keys').order('desc').collect()).map(
      ({ _id, _creationTime, key_hash, request_window_at, request_count, ...row }) => row,
    ),
})

export const mintKey = platformMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<{ id: string; secret: string }> => {
    name = name.trim()
    if (!name || name.length > 80) throw badRequest('use a key name between 1 and 80 characters')
    const own = await ctx.db
      .query('panorama_curation_keys')
      .withIndex('by_creator', (q) => q.eq('created_by', ctx.authUserId))
      .collect()
    if (own.filter((k) => !k.revoked_at && k.expires_at > new Date().toISOString()).length >= 20)
      throw rule('revoke an existing key before creating another')
    const secret =
      CURATION_TOKEN_PREFIX +
      crypto.randomUUID().replaceAll('-', '') +
      crypto.randomUUID().replaceAll('-', '')
    const id = crypto.randomUUID()
    const email = await operatorEmail(ctx, ctx.authUserId)
    await ctx.db.insert('panorama_curation_keys', {
      id,
      name,
      key_hash: await sha256hex(secret),
      key_prefix: `${secret.slice(0, 10)}…${secret.slice(-4)}`,
      created_by: ctx.authUserId,
      created_by_email: email,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: email,
      action: 'panorama_curation_key_created',
      detail: { key_id: id, name },
    })
    return { id, secret }
  },
})

export const revokeKey = platformMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const key = await keyFor(ctx, id)
    if (!key) throw notFound('curation key not found')
    if (key.revoked_at) return
    await ctx.db.patch(key._id, { revoked_at: new Date().toISOString() })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_curation_key_revoked',
      detail: { key_id: id, name: key.name },
    })
  },
})

/* The HTTP edge stamps every authenticated attempt, including later 400/404s.
 * Every dispatched operation rechecks revocation and current operator status. */
export const authorize = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const row = await ctx.db
      .query('panorama_curation_keys')
      .withIndex('by_hash', (q) => q.eq('key_hash', hash))
      .first()
    if (!row) throw forbidden('invalid or expired curation key')
    const key = await requireKey(ctx, row.id)
    const window = key.request_window_at ?? 0
    const fresh = Date.now() - window >= 60_000
    if (!fresh && (key.request_count ?? 0) >= 120)
      throw new ConvexError({
        code: 'rate_limited',
        message: 'curation request limit reached; try again shortly',
        retry_after: Math.max(1, Math.ceil((60_000 - Date.now() + window) / 1000)),
      })
    await ctx.db.patch(key._id, {
      last_used_at: new Date().toISOString(),
      request_window_at: fresh ? Date.now() : window,
      request_count: fresh ? 1 : (key.request_count ?? 0) + 1,
    })
    return { key_id: key.id }
  },
})

export const machineImages = internalQuery({
  args: {
    key_id: v.string(),
    cursor: v.optional(v.string()),
    status: v.optional(vPanoramaStatus),
    agent_review: v.optional(vReviewFilter),
  },
  handler: async (ctx, { key_id, cursor, status = 'pending', agent_review }) => {
    await requireKey(ctx, key_id)
    const decision = agent_review === 'unreviewed' ? undefined : agent_review
    const query = agent_review
      ? ctx.db
          .query('panorama_images')
          .withIndex('by_status_agent_review', (q) =>
            q.eq('status', status).eq('agent_review', decision),
          )
      : ctx.db.query('panorama_images').withIndex('by_status', (q) => q.eq('status', status))
    const page = await query.order('asc').paginate({ numItems: 24, cursor: cursor ?? null })
    return {
      images: await Promise.all(page.page.map((row) => imageRow(ctx, row))),
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const machineImage = internalQuery({
  args: { key_id: v.string(), id: v.string() },
  handler: async (ctx, { key_id, id }) => {
    await requireKey(ctx, key_id)
    const image = await imageFor(ctx, id)
    if (!image) throw notFound('image not found')
    return imageRow(ctx, image)
  },
})

async function recordImageReview(
  ctx: MutationCtx,
  image: Doc<'panorama_images'>,
  key: Doc<'panorama_curation_keys'>,
  decision: 'approved' | 'declined',
  reason: string,
) {
  if (image.status !== 'pending') throw rule('this image already has a final human decision')
  const value = {
    agent_review: decision,
    agent_review_note: reason,
    agent_reviewed_at: new Date().toISOString(),
    agent_review_id: crypto.randomUUID(),
    agent_reviewer: key.name,
  }
  await ctx.db.patch(image._id, value)
  for (const sub of await ctx.db
    .query('panorama_submissions')
    .withIndex('by_image', (q) => q.eq('image_id', image.id))
    .collect()) {
    if (sub.status === 'pending' || sub.status === 'needs_file') await ctx.db.patch(sub._id, value)
  }
  await audit(ctx, {
    ...agentActor(key),
    action: 'panorama_agent_precheck',
    detail: { key_id: key.id, image_id: image.id, decision, reason },
  })
  return value
}

export const machineReview = internalMutation({
  args: {
    key_id: v.string(),
    id: v.string(),
    decision: vDecision,
    reason: v.string(),
    day: v.optional(v.string()),
  },
  handler: async (ctx, { key_id, id, ...input }) => {
    const key = await requireKey(ctx, key_id)
    const review = parseCurationReview(input)
    const image = await imageFor(ctx, id)
    if (!image) throw notFound('image not found')
    const value = await recordImageReview(ctx, image, key, review.decision, review.reason)
    let submission_id: string | null = null
    if (review.day && review.decision === 'approved') {
      await ctx.db.patch(image._id, { requested_day: review.day })
      const request_id = `library:${image.id}:${review.day}`
      const previous = await ctx.db
        .query('panorama_submissions')
        .withIndex('by_key_request', (q) => q.eq('key_id', key.id).eq('request_id', request_id))
        .unique()
      if (previous) submission_id = previous.id
      else {
        submission_id = crypto.randomUUID()
        await ctx.db.insert('panorama_submissions', {
          id: submission_id,
          key_id: key.id,
          request_id,
          payload_json: JSON.stringify({ image_id: image.id, day: review.day }),
          source_id: image.source_id,
          source_url: image.source_url,
          day: review.day,
          title: image.title,
          creator: image.creator,
          reason: review.reason,
          submitted_by: key.name,
          submitted_at: new Date().toISOString(),
          status: 'pending',
          image_id: image.id,
          ...value,
        })
      }
    }
    return { id, agent_review: review.decision, human_status: image.status, submission_id }
  },
})

export const machineSubmit = internalMutation({
  args: {
    key_id: v.string(),
    request_id: v.optional(v.string()),
    input: v.object({
      url: v.string(),
      date: v.string(),
      title: v.optional(v.string()),
      creator: v.optional(v.string()),
      reason: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { key_id, request_id, input }) => {
    const key = await requireKey(ctx, key_id)
    const value = parseCurationSubmission(input)
    if (request_id !== undefined && !/^[A-Za-z0-9._:-]{1,100}$/.test(request_id))
      throw badRequest(
        'Idempotency-Key must contain 1–100 letters, numbers, dots, colons, underscores or hyphens',
      )
    const request = request_id ?? `${value.source_id}:${value.day}`
    const payload_json = JSON.stringify(value)
    const previous = await ctx.db
      .query('panorama_submissions')
      .withIndex('by_key_request', (q) => q.eq('key_id', key.id).eq('request_id', request))
      .unique()
    if (previous) {
      if (previous.payload_json !== payload_json)
        throw conflict(
          'this request key was already used with different content',
          'idempotency_mismatch',
        )
      return { submission: await submissionRow(ctx, previous), idempotent: true }
    }
    const pending = await ctx.db
      .query('panorama_submissions')
      .withIndex('by_status', (q) => q.eq('status', 'needs_file'))
      .take(1000)
    if (pending.length >= 1000)
      throw rule('review existing image-link submissions before adding more')
    const existing = await ctx.db
      .query('panorama_images')
      .withIndex('by_source', (q) => q.eq('source_id', value.source_id))
      .first()
    const id = crypto.randomUUID()
    const _id = await ctx.db.insert('panorama_submissions', {
      ...value,
      id,
      key_id: key.id,
      request_id: request,
      payload_json,
      submitted_by: key.name,
      submitted_at: new Date().toISOString(),
      status: existing?.status === 'removed' ? 'declined' : existing ? 'pending' : 'needs_file',
      ...(existing ? { image_id: existing.id } : {}),
      ...(existing?.status === 'removed'
        ? { review_note: 'This photo was previously removed by a human reviewer.' }
        : {}),
    })
    await audit(ctx, {
      ...agentActor(key),
      action: 'panorama_agent_submission',
      detail: { key_id: key.id, submission_id: id, source_url: value.source_url, day: value.day },
    })
    const row = await ctx.db.get(_id)
    if (!row) throw new Error('submission creation failed')
    return { submission: await submissionRow(ctx, row), idempotent: false }
  },
})

export const submissions = platformQuery({
  args: { cursor: v.optional(v.string()) },
  handler: (ctx, { cursor }) => listSubmissions(ctx, cursor),
})
export const machineSubmissions = internalQuery({
  args: { key_id: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, { key_id, cursor }) => {
    await requireKey(ctx, key_id)
    return listSubmissions(ctx, cursor)
  },
})
export const machineSubmission = internalQuery({
  args: { key_id: v.string(), id: v.string() },
  handler: async (ctx, { key_id, id }) => {
    await requireKey(ctx, key_id)
    const row = await submissionFor(ctx, id)
    if (!row) throw notFound('image submission not found')
    return submissionRow(ctx, row)
  },
})

export const machineReviewSubmission = internalMutation({
  args: { key_id: v.string(), id: v.string(), decision: vDecision, reason: v.string() },
  handler: async (ctx, { key_id, id, ...input }) => {
    const key = await requireKey(ctx, key_id)
    const review = parseCurationReview(input)
    const row = await submissionFor(ctx, id)
    if (!row) throw notFound('image submission not found')
    if (row.status === 'accepted' || row.status === 'declined')
      throw rule('this submission already has a final human decision')
    const image = row.image_id ? await imageFor(ctx, row.image_id) : null
    if (image?.status === 'removed') throw rule('this image was removed by a human reviewer')
    const value =
      image?.status === 'pending'
        ? await recordImageReview(ctx, image, key, review.decision, review.reason)
        : {
            agent_review: review.decision,
            agent_review_note: review.reason,
            agent_reviewed_at: new Date().toISOString(),
            agent_review_id: crypto.randomUUID(),
            agent_reviewer: key.name,
          }
    await ctx.db.patch(row._id, value)
    await audit(ctx, {
      ...agentActor(key),
      action: 'panorama_agent_submission_precheck',
      detail: {
        key_id: key.id,
        submission_id: id,
        decision: review.decision,
        reason: review.reason,
      },
    })
    return { id, agent_review: review.decision, human_status: row.status }
  },
})

export const decline = platformMutation({
  args: { id: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { id, note }) => {
    const row = await submissionFor(ctx, id)
    if (!row) throw notFound('image submission not found')
    if (row.status === 'accepted')
      throw rule(
        'this submission was already accepted; manage its image or date in the library/calendar',
      )
    if (row.status === 'declined') return
    if (note && note.length > 2000) throw badRequest('keep the review note within 2000 characters')
    await ctx.db.patch(row._id, {
      status: 'declined',
      reviewed_at: new Date().toISOString(),
      reviewed_by: ctx.authUserId,
      review_note: note?.trim() || undefined,
    })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_submission_declined',
      detail: { submission_id: id, note: note?.trim() ?? '' },
    })
  },
})

export const accept = platformMutation({
  args: {
    id: v.string(),
    expected_image_id: v.union(v.string(), v.null()),
    expected_agent_review_id: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, expected_image_id, expected_agent_review_id }) => {
    const row = await submissionFor(ctx, id)
    if (!row) throw notFound('image submission not found')
    if (row.status !== 'pending' || !row.image_id)
      throw rule(
        'attach an image file before final approval; closed submissions cannot be accepted',
      )
    const image = await imageFor(ctx, row.image_id)
    if (
      !image ||
      image.status === 'removed' ||
      !image.storage_id ||
      !(await ctx.db.system.get(image.storage_id))
    )
      throw rule('this image file is no longer available')
    if (
      (row.agent_review_id ?? image.agent_review_id ?? null) !== (expected_agent_review_id ?? null)
    )
      throw conflict(
        'the agent precheck changed; review the latest decision before approving',
        'agent_review_changed',
      )
    validateCalendarDay(row.day)
    const slot = await assignmentForWeek(ctx, row.day)
    if ((slot?.image_id ?? null) !== expected_image_id)
      throw conflict(
        'this week changed while you were reviewing; check its current image before replacing it',
        'calendar_changed',
      )
    if (image.status === 'pending') {
      const state = await ensureState(ctx)
      await ctx.db.patch(state._id, { pending: state.pending - 1, approved: state.approved + 1 })
      await ctx.db.patch(image._id, {
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: ctx.authUserId,
      })
    }
    await writeCalendarWeek(ctx, row.day, image.id, ctx.authUserId)
    await ctx.db.patch(row._id, {
      status: 'accepted',
      reviewed_at: new Date().toISOString(),
      reviewed_by: ctx.authUserId,
    })
    await audit(ctx, {
      actor_auth_id: ctx.authUserId,
      actor_email: await operatorEmail(ctx, ctx.authUserId),
      action: 'panorama_submission_accepted',
      detail: {
        submission_id: id,
        image_id: image.id,
        day: row.day,
        previous_image_id: expected_image_id,
        agent_decision: row.agent_review ?? image.agent_review ?? null,
      },
    })
  },
})

type LicensedUpload = {
  source_url: string
  source_id: string
  storage_id: Id<'_storage'>
  title: string
  location?: string
  creator: string
  license_confirmed: boolean
  width: number
  height: number
  auth_user_id: string
}

type LibraryUploadResult = { image: Awaited<ReturnType<typeof imageRow>>; reused: boolean }

async function inspectUpload(ctx: ActionCtx, storage_id: Id<'_storage'>, confirmed: boolean) {
  if (!confirmed)
    throw badRequest('confirm that the file was obtained under the standard Unsplash license')
  const file = await ctx.storage.get(storage_id)
  if (!file) throw badRequest('the uploaded image file is no longer available')
  try {
    validatePanoramaFile(file.type, file.size)
    return jpegDimensions(
      new Uint8Array(await (file as Blob & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()),
    )
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'choose a valid landscape JPEG image')
  }
}

async function discardLooseUpload(ctx: ActionCtx, storage_id: Id<'_storage'>) {
  // A lost acknowledgment can follow a committed attach. Never remove a
  // referenced file; unretained uploads can otherwise wait for the reaper.
  await ctx.runMutation(internal.panoramaImages.discardImport, { storage_id }).catch(() => {})
}

/* Both dated submissions and standalone library additions retain files here.
 * No calendar or proposal writes belong in this helper. */
async function retainUnsplashUpload(
  ctx: MutationCtx,
  {
    source_url,
    source_id,
    storage_id,
    title,
    location,
    creator,
    license_confirmed,
    width,
    height,
    auth_user_id,
  }: LicensedUpload,
): Promise<{ image: Doc<'panorama_images'>; reused: boolean }> {
  await requireOperator(ctx, auth_user_id)
  const source = parseUnsplashReference(source_url)
  if (source.source_id !== source_id || source.source_url !== source_url)
    throw badRequest('use the canonical Unsplash photo reference')
  if (!license_confirmed) throw badRequest('confirm the standard Unsplash license')
  title = title.trim()
  location = location?.trim() || undefined
  creator = creator.trim()
  if (!title || title.length > 300 || !creator || creator.length > 300)
    throw badRequest('provide the image title and creator, each within 300 characters')
  if (location && location.length > 300)
    throw badRequest('keep the image location within 300 characters')
  const file = await ctx.db.system.get(storage_id)
  if (file?.contentType !== 'image/jpeg' || file.size > PANORAMA_MAX_BYTES)
    throw badRequest('choose a JPEG image no larger than 8 MB')
  if (await storageIdInUse(ctx, storage_id)) throw badRequest('this file is already in use')
  const existing =
    (await ctx.db
      .query('panorama_images')
      .withIndex('by_source', (q) => q.eq('source_id', source_id))
      .first()) ??
    (await ctx.db
      .query('panorama_images')
      .withIndex('by_hash', (q) => q.eq('sha256', file.sha256))
      .first())
  if (existing) {
    if (existing.status === 'removed')
      throw rule('this image was previously removed by a human reviewer')
    if (existing.sha256 !== file.sha256)
      throw conflict(
        'a different file is already stored for this source image',
        'source_file_changed',
      )
    if (!existing.storage_id || !(await ctx.db.system.get(existing.storage_id)))
      throw rule('the existing image file is no longer available')
    await ctx.storage.delete(storage_id)
    await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
      kind: 'library',
      id: existing.id,
      storage_id: existing.storage_id,
    })
    return { image: existing, reused: true }
  }
  const now = new Date().toISOString()
  const filename = panoramaFilename(title, creator, file.contentType)
  const rowId = await ctx.db.insert('panorama_images', {
    id: crypto.randomUUID(),
    source_id,
    source_url,
    download_url: source_url,
    title,
    location,
    creator,
    filename,
    license: 'Unsplash License',
    license_url: 'https://unsplash.com/license',
    attribution: `${title} — ${creator} on Unsplash. ${source_url} Standard Unsplash license: https://unsplash.com/license. Display may crop to fit.`,
    source_metadata: JSON.stringify({
      acquisition: 'operator_upload',
      source_url,
      standard_license_confirmed_by: auth_user_id,
      confirmed_at: now,
      title,
      location,
      creator,
      filename,
    }),
    storage_id,
    sha256: file.sha256,
    byte_size: file.size,
    width,
    height,
    imported_at: now,
    status: 'pending',
  })
  const state = await ensureState(ctx)
  await ctx.db.patch(state._id, { pending: state.pending + 1 })
  const image = await ctx.db.get(rowId)
  if (!image) throw new Error('image registration failed')
  await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
    kind: 'library',
    id: image.id,
    storage_id,
  })
  return { image, reused: false }
}

export const libraryImage = platformQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const image = await imageFor(ctx, id)
    return image ? imageRow(ctx, image) : null
  },
})

export const prepareLibraryUpload = platformMutation({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const source = parseUnsplashReference(url)
    const existing = await ctx.db
      .query('panorama_images')
      .withIndex('by_source', (q) => q.eq('source_id', source.source_id))
      .first()
    if (existing?.status === 'removed')
      throw rule('this image was previously removed by a human reviewer')
    if (existing && (!existing.storage_id || !(await ctx.db.system.get(existing.storage_id))))
      throw rule('the existing image file is no longer available')
    return {
      source_url: source.source_url,
      existing_image: existing ? await imageRow(ctx, existing) : null,
      upload_url: existing ? null : await ctx.storage.generateUploadUrl(),
    }
  },
})

export const addLibraryFile = platformAction({
  args: {
    url: v.string(),
    storage_id: v.id('_storage'),
    title: v.string(),
    location: v.optional(v.string()),
    creator: v.string(),
    license_confirmed: v.boolean(),
  },
  handler: async (ctx, { url, ...args }): Promise<LibraryUploadResult> => {
    try {
      const source = parseUnsplashReference(url)
      const dimensions = await inspectUpload(ctx, args.storage_id, args.license_confirmed)
      return await ctx.runMutation(internal.panoramaCuration.retainLibraryFile, {
        ...args,
        ...source,
        ...dimensions,
        auth_user_id: ctx.operator.auth_user_id,
      })
    } catch (error) {
      await discardLooseUpload(ctx, args.storage_id)
      throw error
    }
  },
})

export const retainLibraryFile = internalMutation({
  args: {
    source_url: v.string(),
    source_id: v.string(),
    storage_id: v.id('_storage'),
    title: v.string(),
    location: v.optional(v.string()),
    creator: v.string(),
    license_confirmed: v.boolean(),
    width: v.number(),
    height: v.number(),
    auth_user_id: v.string(),
  },
  handler: async (ctx, args): Promise<LibraryUploadResult> => {
    const { image, reused } = await retainUnsplashUpload(ctx, args)
    await audit(ctx, {
      actor_auth_id: args.auth_user_id,
      actor_email: await operatorEmail(ctx, args.auth_user_id),
      action: 'panorama_library_image_added',
      detail: {
        image_id: image.id,
        source_url: args.source_url,
        license: 'Unsplash License',
        reused,
      },
    })
    return { image: await imageRow(ctx, image), reused }
  },
})

export const uploadUrl = platformMutation({
  args: { submission_id: v.string() },
  handler: async (ctx, { submission_id }) => {
    const row = await submissionFor(ctx, submission_id)
    if (!row) throw notFound('image submission not found')
    if (row.status !== 'needs_file') throw rule('this submission does not need a new image file')
    return ctx.storage.generateUploadUrl()
  },
})

export const attachFile = platformAction({
  args: {
    submission_id: v.string(),
    storage_id: v.id('_storage'),
    title: v.string(),
    location: v.optional(v.string()),
    creator: v.string(),
    license_confirmed: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const dimensions = await inspectUpload(ctx, args.storage_id, args.license_confirmed)
      await ctx.runMutation(internal.panoramaCuration.attachVerifiedFile, {
        ...args,
        ...dimensions,
        auth_user_id: ctx.operator.auth_user_id,
      })
    } catch (error) {
      await discardLooseUpload(ctx, args.storage_id)
      throw error
    }
  },
})

export const attachVerifiedFile = internalMutation({
  args: {
    submission_id: v.string(),
    storage_id: v.id('_storage'),
    title: v.string(),
    location: v.optional(v.string()),
    creator: v.string(),
    license_confirmed: v.boolean(),
    width: v.number(),
    height: v.number(),
    auth_user_id: v.string(),
  },
  handler: async (
    ctx,
    {
      submission_id,
      storage_id,
      title,
      location,
      creator,
      license_confirmed,
      width,
      height,
      auth_user_id,
    },
  ) => {
    await requireOperator(ctx, auth_user_id)
    const row = await submissionFor(ctx, submission_id)
    if (!row) throw notFound('image submission not found')
    if (row.status !== 'needs_file' || !row.source_id.startsWith('unsplash:'))
      throw rule('this submission does not need a new Unsplash image file')
    const { image } = await retainUnsplashUpload(ctx, {
      source_url: row.source_url,
      source_id: row.source_id,
      storage_id,
      title,
      location,
      creator,
      license_confirmed,
      width,
      height,
      auth_user_id,
    })
    const image_id = image.id
    // The actual uploaded file needs its own review. A URL-only recommendation
    // is not proof that the bytes just supplied depict the same photograph.
    await ctx.db.patch(row._id, {
      image_id,
      title: title.trim(),
      creator: creator.trim(),
      status: 'pending',
      agent_review: undefined,
      agent_review_note: undefined,
      agent_reviewed_at: undefined,
      agent_review_id: undefined,
      agent_reviewer: undefined,
    })
    await audit(ctx, {
      actor_auth_id: auth_user_id,
      actor_email: await operatorEmail(ctx, auth_user_id),
      action: 'panorama_submission_file_attached',
      detail: { submission_id, image_id, source_url: row.source_url, license: 'Unsplash License' },
    })
  },
})
