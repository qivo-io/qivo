/* The storage surface (phase 7): attachment upload/attach/remove, avatar
 * set/clear, and the batched short-lived-URL mint the /files//avatars gateway
 * verifies.
 *
 * Ported rights (final SQL state):
 *   uploadUrl          attachments_objects_insert 0090:31-40 — bytes may only
 *                      enter under an issue you hold member on
 *   attach             ia_insert 0081:307-311 ('member'→'user' by 0098) +
 *                      attachments_check_size 0089 (size from storage
 *                      metadata, NEVER the client; binary MiB cap) +
 *                      storage_path unique 0018:22 (→ by_storage uniqueness)
 *   removeAttachment   ia_delete 0018:38-40 — ANY project member, not
 *                      uploader-only
 *   setAvatar/clear    set_avatar 0099:189-210 (self-or-admin, one sentence
 *                      for absent AND invisible) + the avatars bucket's mime
 *                      allowlist and 2 MB cap (0096:548-554 — no other
 *                      successor exists)
 *   mintUrls           ia_select (can_see_project) / profiles_select
 *                      disjunction (0099:246-248); invisible ids are OMITTED,
 *                      never errors (RLS silence, no existence oracle)
 *
 * Oversize-delete PROBE VERDICT (run live against admired-wildcat-470):
 * ctx.storage.delete ROLLS BACK when the same mutation throws — mutations are
 * transactional storage included. attach's oversize path therefore deletes
 * the bytes and RETURNS a structured refusal ({ refused }) instead of
 * throwing, so the commit carries the delete. Every
 * other refusal throws as usual and deletes nothing.
 *
 * attach writes activity ('attached a file to' / 'added an image to' — the
 * verbs are icon-load-bearing) but does NOT notify and does NOT stamp
 * issue.updated_at: the SQL had neither (issues_touch was UPDATE-only, and
 * issue_attachments had no notify trigger). ATTACH_SLOT in model/messages.ts
 * is the PARENT-attach narration sentinel — none of this file's business.
 *
 * mintUrls is a QUERY but must be consumed ONE-SHOT (convex.query), never
 * subscribed: exp comes from Date.now(), which is not a reactive dependency —
 * a subscription would pin a stale exp forever. */

import { v } from 'convex/values'
import { components } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { canSeeProject, hasProjectLevel } from './lib/access'
import { assertBillingWritable } from './lib/billingAccess'
import { byId, insertUnique } from './lib/db'
import { isDemoDeployment } from './lib/demo'
import {
  attachmentFileUrl,
  avatarFileUrl,
  FILE_TOKEN_TTL_SECONDS,
  mintFileToken,
} from './lib/fileTokens'
import {
  authedMutation,
  badRequest,
  forbidden,
  notFound,
  orgMutation,
  orgQuery,
  rule,
} from './lib/functions'
import { logActivity } from './model/activity'
import { clearAccountAppearance } from './model/appearance'
import {
  assertDemoFileOwnership,
  DEMO_FILE_BYTES,
  demoCanRead,
  demoFileExpiry,
  reserveDemoUpload,
} from './model/demoUploads'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }
type AuthedCtx = MutationCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> }

/* System fields stay internal; optional columns come back ABSENT. */
const pub = ({ _id, _creationTime, org_id: _orgId, ...row }: Doc<'issue_attachments'>) => row

export type AttachmentRow = ReturnType<typeof pub>

/* The structured refusal attach returns when the byte-delete must commit
 * (probe verdict above). The client wrapper toasts message and resolves null,
 * its existing failure contract. */
export type AttachResult =
  | { refused: { code: 'bad_request'; message: string } }
  | { attachment: AttachmentRow }

/* Missing and foreign-org issues are indistinguishable (0056). */
async function myIssue(ctx: MeCtx, id: string): Promise<Doc<'issues'>> {
  const issue = await byId(ctx, 'issues', id)
  if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
  return issue
}

async function assertWritable(ctx: MeCtx, projectId: string): Promise<void> {
  if (!(await hasProjectLevel(ctx, ctx.me, projectId, 'user'))) {
    throw forbidden('no write access to this project')
  }
}

/* The cross-tenant byte-destruction fence (0089 §3's vector, reborn as
 * storage ids): a storage id referenced by ANY attachment row or ANY
 * profile's avatar, curated background, or private custom background must never gain a second referent — the second row's
 * delete would destroy the first row's bytes. */
export async function storageIdInUse(ctx: QueryCtx, storageId: Id<'_storage'>): Promise<boolean> {
  const att = await ctx.db
    .query('issue_attachments')
    .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
    .first()
  if (att !== null) return true
  const prof = await ctx.db
    .query('profiles')
    .withIndex('by_avatar', (q) => q.eq('avatar_storage_id', storageId))
    .first()
  if (prof !== null) return true
  const panorama =
    (await ctx.db
      .query('panorama_images')
      .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
      .first()) !== null
  if (panorama) return true
  if (
    await ctx.db
      .query('panorama_images')
      .withIndex('by_preview_storage', (q) => q.eq('preview_storage_id', storageId))
      .first()
  )
    return true
  if (
    await ctx.db
      .query('custom_backgrounds')
      .withIndex('by_preview_storage', (q) => q.eq('preview_storage_id', storageId))
      .first()
  )
    return true
  return (
    (await ctx.db
      .query('custom_backgrounds')
      .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
      .first()) !== null
  )
}

/* The issue's owning organization controls all attachments, including inline
 * images and projects without a team. Older org rows default to the gateway's
 * 20 MiB serving ceiling; legacy team caps have no effect. */
async function attachmentCapMb(ctx: QueryCtx, orgId: string): Promise<number> {
  const org = await byId(ctx, 'organizations', orgId)
  return Math.min(org?.max_attachment_mb ?? 20, 20)
}

/* ---------------------------------------------------------------- uploads
 * generateUploadUrl is a blank cheque for one POST, so the MINT is gated:
 * write level on the target issue's project (attachments) or the set_avatar
 * right (avatars). A minted URL can still park bytes without attaching —
 * that residual (unchanged from 0090:20-29) is what reapOrphans exists for. */

export const uploadUrl = orgMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const issue = await myIssue(ctx, issue_id)
    await assertWritable(ctx, issue.project_id)
    if (isDemoDeployment())
      return demoUploadUrl(ctx, ctx.authUserId, 'attachment', issue_id, DEMO_FILE_BYTES)
    return await ctx.storage.generateUploadUrl()
  },
})

/* set_avatar's one sentence for absent AND invisible targets (0099:203, the
 * 0049 no-existence-oracle rule). authedMutation, not orgMutation: an admin
 * sets pictures for agents/unclaimed seats; the org resolves from the TARGET. */
const AVATAR_RIGHT = 'only this person or an organization admin can change their picture'

async function avatarTarget(ctx: AuthedCtx, profileId: string): Promise<Doc<'profiles'>> {
  const target = await byId(ctx, 'profiles', profileId)
  if (target === null) throw forbidden(AVATAR_RIGHT)
  const me = ctx.myProfiles.get(target.org_id)
  const mine = me !== undefined && me.id === target.id
  const admin = me !== undefined && me.org_role === 'admin'
  if (!mine && !admin) throw forbidden(AVATAR_RIGHT)
  // Personal account settings remain available during billing recovery.
  // Managing another org account's picture is an organization write.
  if (!mine) await assertBillingWritable(ctx, target.org_id)
  return target
}

export const avatarUploadUrl = authedMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }) => {
    await avatarTarget(ctx, profile_id)
    if (isDemoDeployment())
      return demoUploadUrl(ctx, ctx.authUserId, 'avatar', profile_id, AVATAR_MAX_BYTES)
    return await ctx.storage.generateUploadUrl()
  },
})

/* ----------------------------------------------------------------- attach
 * Order is load-bearing: every throw happens BEFORE any write, and the
 * oversize refusal-return happens before the row insert — the committed
 * transaction then carries exactly one effect, the byte delete. */
export const attach = orgMutation({
  args: {
    id: v.string(), // client-generated attachment uuid
    issue_id: v.string(),
    storage_id: v.id('_storage'),
    name: v.string(),
    mime: v.optional(v.string()),
    inline: v.boolean(),
  },
  handler: async (ctx, { id, issue_id, storage_id, name, mime, inline }): Promise<AttachResult> => {
    const now = new Date().toISOString()
    const issue = await myIssue(ctx, issue_id)
    await assertWritable(ctx, issue.project_id)
    await assertDemoFileOwnership(ctx, ctx.authUserId, storage_id, 'attachment', issue_id)
    if (await storageIdInUse(ctx, storage_id)) {
      // never delete here — the bytes belong to the EXISTING referent
      throw badRequest('this file is already attached')
    }
    const meta = await ctx.db.system.get(storage_id)
    if (meta === null) throw badRequest('attachment bytes not found in storage')
    const cap = await attachmentCapMb(ctx, issue.org_id)
    if (meta.size > cap * 1024 * 1024) {
      await ctx.storage.delete(storage_id)
      return {
        refused: {
          code: 'bad_request',
          message: `attachment exceeds the organization limit of ${cap} MiB`,
        },
      }
    }
    const rowId = await insertUnique(
      ctx,
      'issue_attachments',
      'by_uuid',
      { id },
      {
        id,
        org_id: issue.org_id,
        issue_id: issue.id,
        name,
        size_bytes: meta.size, // server truth — NEVER a client number (0089)
        mime: mime ?? meta.contentType ?? undefined,
        storage_id,
        inline,
        uploaded_by: ctx.me.id,
        created_at: now,
      },
      badRequest('an attachment with this id already exists'),
    )
    await logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: ctx.me.id,
      verb: inline ? 'added an image to' : 'attached a file to',
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      detail: name,
      project_id: issue.project_id,
      ts: now,
    })
    const row = (await ctx.db.get(rowId)) as Doc<'issue_attachments'>
    return { attachment: pub(row) }
  },
})

/* ------------------------------------------------------- removeAttachment
 * ia_delete (LAST 0018:38-40): any project member may delete ANY attachment
 * on the issue, not only their own. Row + bytes die in one transaction
 * (success path — no rollback concern). */
export const removeAttachment = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const att = await byId(ctx, 'issue_attachments', id)
    if (att === null) throw notFound('attachment not found')
    const issue = await byId(ctx, 'issues', att.issue_id)
    if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('attachment not found')
    await assertWritable(ctx, issue.project_id)
    await ctx.storage.delete(att.storage_id)
    await ctx.db.delete(att._id)
    await logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: ctx.me.id,
      verb: att.inline ? 'removed an image from' : 'removed an attachment from',
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      detail: att.name,
      project_id: issue.project_id,
      ts: now,
    })
    return null
  },
})

/* ---------------------------------------------------------------- avatars
 * The old avatars bucket enforced these at the storage layer (0096:548-554);
 * generateUploadUrl enforces nothing, so the mutation must — or an SVG
 * "avatar" walks into the cookie-carrying gateway origin. */
const AVATAR_TYPES = ['image/webp', 'image/png', 'image/jpeg', 'image/gif']
const AVATAR_MAX_BYTES = 2_097_152

export const setAvatar = authedMutation({
  args: { profile_id: v.string(), storage_id: v.id('_storage') },
  handler: async (ctx, { profile_id, storage_id }) => {
    const target = await avatarTarget(ctx, profile_id)
    await assertDemoFileOwnership(ctx, ctx.authUserId, storage_id, 'avatar', profile_id)
    if (target.avatar_storage_id === storage_id) return null
    const meta = await ctx.db.system.get(storage_id)
    if (meta === null) throw badRequest('avatar bytes not found in storage')
    const mime = meta.contentType ?? undefined
    if (mime === undefined || !AVATAR_TYPES.includes(mime)) {
      throw rule('a profile picture must be a PNG, JPEG, WebP, or GIF image')
    }
    if (meta.size > AVATAR_MAX_BYTES) throw rule('a profile picture is at most 2 MB')
    if (await storageIdInUse(ctx, storage_id)) throw badRequest('this file is already in use')
    const prev = target.avatar_storage_id
    await ctx.db.patch(target._id, { avatar_storage_id: storage_id })
    // row-swap and old-byte delete commit atomically — the old bytes-first/
    // rows-first ceremony (bc022c2 planner:3402-3440) collapses here
    if (prev !== undefined) await ctx.storage.delete(prev)
    return null
  },
})

export const clearAvatar = authedMutation({
  args: { profile_id: v.string() },
  handler: async (ctx, { profile_id }) => {
    const target = await avatarTarget(ctx, profile_id)
    const prev = target.avatar_storage_id
    if (prev === undefined) return null
    await ctx.db.patch(target._id, { avatar_storage_id: undefined })
    await ctx.storage.delete(prev)
    return null
  },
})

/* --------------------------------------------------------------- mintUrls
 * Batched signed-URL mint. Access is checked per item with the SAME
 * predicates the gateway re-checks per request; invisible/missing ids are
 * silently omitted (the caller renders "Image unavailable"). minter =
 * caller's profile uuid (attachments) / auth-user id (avatars — the gateway
 * re-derives "active profile in the target's org" itself). ONE-SHOT ONLY —
 * see the header. */
export const mintUrls = orgQuery({
  args: {
    attachment_ids: v.optional(v.array(v.string())),
    profile_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { attachment_ids, profile_ids }) => {
    const exp = await demoFileExpiry(
      ctx,
      ctx.authUserId,
      Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS,
    )
    const attachments: Record<string, { url: string; exp: number }> = {}
    const avatars: Record<string, { url: string; exp: number }> = {}
    for (const id of new Set(attachment_ids ?? [])) {
      const att = await byId(ctx, 'issue_attachments', id)
      if (att === null) continue
      const issue = await byId(ctx, 'issues', att.issue_id)
      if (issue === null || issue.org_id !== ctx.me.org_id) continue
      const project = await byId(ctx, 'projects', issue.project_id)
      if (project === null || !(await canSeeProject(ctx, ctx.me, project))) continue
      const minter = ctx.me.id
      const token = await mintFileToken({ kind: 'attachment', id: att.id, minter, exp })
      attachments[att.id] = { url: attachmentFileUrl({ id: att.id, minter, exp, token }), exp }
    }
    for (const id of new Set(profile_ids ?? [])) {
      const target = await byId(ctx, 'profiles', id)
      if (target === null) continue
      // profiles_select disjunction (0099:246-248): active profile in the
      // target's org (guests and viewers qualify — 0097:20-26), or own active row
      const visible =
        ctx.myProfiles.has(target.org_id) ||
        (target.auth_user_id !== undefined &&
          target.auth_user_id === ctx.authUserId &&
          target.active)
      if (!visible) continue
      const sid = target.avatar_storage_id
      if (sid === undefined) continue
      const minter = ctx.authUserId
      const token = await mintFileToken({ kind: 'avatar', id: target.id, minter, exp })
      avatars[target.id] = {
        url: avatarFileUrl({ id: target.id, minter, exp, token, v: sid }),
        exp,
      }
    }
    return { attachments, avatars }
  },
})

/* ---------------------------------------------------------------- gateway
 * Per-request re-checks for the /files//avatars HTTP gateway (http.ts). The
 * request itself carries no identity (an <img> fetch is credential-less
 * cross-site), so after the MAC verifies the check runs against the MINTER
 * named in the token — the same predicates mintUrls applied at mint time.
 * Access revoked after mint dies on the NEXT fetch, not at token expiry.
 * One shape, one null: the gateway answers a uniform 404 (no existence
 * oracle). mime is the ROW's fallback — the gateway prefers the stored
 * blob's contentType. */

type GatewayFile = { storage_id: Id<'_storage'>; name: string; mime: string | null }

export const gatewayAttachment = internalQuery({
  args: { id: v.string(), minter: v.string() },
  handler: async (ctx, { id, minter }): Promise<GatewayFile | null> => {
    const att = await byId(ctx, 'issue_attachments', id)
    if (att === null) return null
    const issue = await byId(ctx, 'issues', att.issue_id)
    if (issue === null) return null
    const project = await byId(ctx, 'projects', issue.project_id)
    if (project === null) return null
    // minter = profile uuid; must still be ACTIVE (mint ran under loadMember,
    // which only surfaces active profiles) and still pass ia_select's
    // can_see_project (0018:31-33)
    const me = await byId(ctx, 'profiles', minter)
    if (me === null || !me.active) return null
    if (!(await demoCanRead(ctx, me.auth_user_id ?? '', issue.org_id))) return null
    if (!(await canSeeProject(ctx, me, project))) return null
    return { storage_id: att.storage_id, name: att.name, mime: att.mime ?? null }
  },
})

export const gatewayAvatar = internalQuery({
  args: { id: v.string(), minter: v.string() },
  handler: async (ctx, { id, minter }): Promise<GatewayFile | null> => {
    const target = await byId(ctx, 'profiles', id)
    if (target === null) return null
    if (!(await demoCanRead(ctx, minter, target.org_id))) return null
    const sid = target.avatar_storage_id
    if (sid === undefined) return null
    // minter = auth-user id; profiles_select disjunction (0099:246-248):
    // the login holds an ACTIVE profile in the target's org (guests and
    // viewers qualify — 0097:20-26), or the target is the login's own
    // active row
    const own = target.auth_user_id === minter && target.active
    if (!own) {
      const mine = await ctx.db
        .query('profiles')
        .withIndex('by_org_auth', (q) => q.eq('org_id', target.org_id).eq('auth_user_id', minter))
        .collect()
      if (!mine.some((p) => p.active)) return null
    }
    return { storage_id: sid, name: 'avatar', mime: null }
  },
})

/* ------------------------------------------------------------ reapOrphans
 * Uploaded-never-attached bytes are referenced by NOTHING. Reference points
 * are issue_attachments.storage_id, profiles.avatar_storage_id and
 * panorama_images/custom_backgrounds originals and preview_storage_id. Runnable
 * via `npx convex run files:reapOrphans` until phase 9's cron schedules it.
 * The 60-min floor (0033:34-38): a sweep must never race an upload whose
 * attach is seconds away. Component storage (Better Auth) is isolated from
 * this _storage table. */
export const reapOrphans = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - 60 * 60 * 1000
    let deleted = 0
    let kept = 0
    // Tickets own no bytes until the receiver commits the completed upload.
    // Bound each ticket sweep; the next run resumes from the oldest expiry.
    for (const ticket of await ctx.db
      .query('background_uploads')
      .withIndex('by_expiry', (q) => q.lte('expires_at', now))
      .take(1000))
      await ctx.db.delete(ticket._id)
    // Raw component/CLI deletion can bypass the auth API hook. Preserve a
    // banned user's preferences; only an absent login makes them orphaned.
    for (const settings of await ctx.db.query('account_appearance').collect()) {
      const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: '_id', value: settings.auth_user_id }],
      })
      if (!user) await clearAccountAppearance(ctx, settings.auth_user_id)
    }
    for (const file of await ctx.db.system.query('_storage').collect()) {
      if (file._creationTime > cutoff) {
        kept += 1
        continue
      }
      if (await storageIdInUse(ctx, file._id)) {
        kept += 1
        continue
      }
      await ctx.storage.delete(file._id)
      deleted += 1
    }
    await ctx.db.insert('platform_audit_log', {
      ts: new Date(now).toISOString(),
      actor_email: 'system',
      action: 'reap_orphans',
      detail: { deleted, kept },
    })
    return { deleted, kept }
  },
})

async function demoUploadUrl(
  ctx: MutationCtx,
  authId: string,
  kind: 'attachment' | 'avatar',
  targetId: string,
  bytes: number,
) {
  const requested = await demoFileExpiry(ctx, authId, Math.floor(Date.now() / 1000) + 600)
  const ticket = await reserveDemoUpload(ctx, {
    authId,
    kind,
    targetId,
    bytes,
    expiresAt: requested * 1000,
  })
  const exp = ticket.expiresAt / 1000
  const token = await mintFileToken({ kind: 'demo_upload', id: ticket.id, minter: authId, exp })
  const site = process.env.CONVEX_SITE_URL
  if (!site) throw new Error('CONVEX_SITE_URL is not set')
  return `${site}/demo-uploads/${ticket.id}?e=${exp}&m=${encodeURIComponent(authId)}&t=${token}`
}
