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
 *                      allowlist and 2 MiB cap (0096:548-554 — no other
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

import { makeFunctionReference } from 'convex/server'
import { type Infer, type ObjectType, v } from 'convex/values'
import { components } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { canSeeProject, hasProjectLevel } from './lib/access'
import { assertOrgWritable } from './lib/billingAccess'
import { byId } from './lib/db'
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
import { LIMITS, MIB } from './lib/limits'
import { clearAccountAppearance } from './model/appearance'
import {
  type AttachResult,
  assertAttachmentRoom,
  attachFileCore,
  removeAttachmentCore,
  storageIdInUse,
} from './model/attachments'
import {
  assertDemoFileOwnership,
  DEMO_FILE_BYTES,
  demoCanRead,
  demoFileExpiry,
  reserveDemoUpload,
} from './model/demoUploads'
import { reapDroppedImage as reapDropped } from './model/descriptionImages'
import {
  type EraseCounts,
  eraseDueFiles,
  eraseFile,
  eraseOnTime,
  holdAfterRestore,
  noteRestore,
  releaseFile,
  restoreHoldEnd,
  restoreState,
} from './model/fileHolds'
import { assertProfileExpected } from './model/people'

/* The byte-reference fence and the attach result live in the shared
 * attachment model (model/attachments.ts); other modules still import them
 * from here. */
export { type AttachmentRow, type AttachResult, storageIdInUse } from './model/attachments'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }
type AuthedCtx = MutationCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> }

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
    // a full task is refused before any bytes are sent
    await assertAttachmentRoom(ctx, issue.id)
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
  if (!mine) await assertOrgWritable(ctx, target.org_id)
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
 * transaction then carries exactly one effect, the byte delete. The name and
 * type limits, the cap, the byte fence, the row and the activity row are
 * model/attachments.ts attachFileCore, which REST and MCP uploads run too. */
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
    return await attachFileCore(ctx, { me: ctx.me, issue, id, storage_id, name, mime, inline, now })
  },
})

/* ------------------------------------------------------- removeAttachment
 * ia_delete (LAST 0018:38-40): any project member may delete ANY attachment
 * on the issue, not only their own. The row goes and its file is held for a
 * restore (model/fileHolds.ts), through model/attachments.ts
 * removeAttachmentCore, which REST and MCP run too. */
export const removeAttachment = orgMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const now = new Date().toISOString()
    const att = await byId(ctx, 'issue_attachments', id)
    if (att === null) throw notFound('attachment not found')
    const issue = await byId(ctx, 'issues', att.issue_id)
    if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('attachment not found')
    await assertWritable(ctx, issue.project_id)
    await removeAttachmentCore(ctx, { me: ctx.me, attachment: att, issue, now })
    return null
  },
})

/* The step a description save schedules for each image it drops, which
 * deletes it with its bytes unless a later save brought it back
 * (model/descriptionImages.ts reapDroppedImage). */
export const reapDroppedImage = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<null> => {
    await reapDropped(ctx, id)
    return null
  },
})

/* ---------------------------------------------------------------- avatars
 * The old avatars bucket enforced these at the storage layer (0096:548-554);
 * generateUploadUrl enforces nothing, so the mutation must — or an SVG
 * "avatar" walks into the cookie-carrying gateway origin. */
const AVATAR_TYPES = ['image/webp', 'image/png', 'image/jpeg', 'image/gif']
const AVATAR_MAX_BYTES = LIMITS.avatarSize.max * MIB

/* The app's `expected` for a profile picture change: the picture it
 * showed when the person picked the file, null for none. */
const vAvatarExpected = v.object({ avatar_storage_id: v.union(v.string(), v.null()) })

export const setAvatar = authedMutation({
  args: {
    profile_id: v.string(),
    storage_id: v.id('_storage'),
    expected: v.optional(vAvatarExpected),
  },
  handler: async (ctx, { profile_id, storage_id, expected }) => {
    const target = await avatarTarget(ctx, profile_id)
    await assertProfileExpected(ctx, {
      me: ctx.myProfiles.get(target.org_id) ?? target,
      seat: target,
      expected,
      next: { avatar_storage_id: storage_id },
    })
    await assertDemoFileOwnership(ctx, ctx.authUserId, storage_id, 'avatar', profile_id)
    if (target.avatar_storage_id === storage_id) return null
    const meta = await ctx.db.system.get(storage_id)
    if (meta === null) throw badRequest('avatar bytes not found in storage')
    const mime = meta.contentType ?? undefined
    if (mime === undefined || !AVATAR_TYPES.includes(mime)) {
      throw rule('a profile picture must be a PNG, JPEG, WebP, or GIF image')
    }
    if (meta.size > AVATAR_MAX_BYTES) throw rule(LIMITS.avatarSize.refusal)
    if (await storageIdInUse(ctx, storage_id)) throw badRequest('this file is already in use')
    const prev = target.avatar_storage_id
    await ctx.db.patch(target._id, { avatar_storage_id: storage_id })
    // row-swap and the old picture's release commit atomically — the old
    // bytes-first/rows-first ceremony (bc022c2 planner:3402-3440) collapses here
    await releaseFile(ctx, prev)
    return null
  },
})

export const clearAvatar = authedMutation({
  args: { profile_id: v.string(), expected: v.optional(vAvatarExpected) },
  handler: async (ctx, { profile_id, expected }) => {
    const target = await avatarTarget(ctx, profile_id)
    await assertProfileExpected(ctx, {
      me: ctx.myProfiles.get(target.org_id) ?? target,
      seat: target,
      expected,
      next: { avatar_storage_id: null },
    })
    const prev = target.avatar_storage_id
    if (prev === undefined) return null
    await ctx.db.patch(target._id, { avatar_storage_id: undefined })
    await releaseFile(ctx, prev)
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
 * Deletes bytes nothing references: an app upload never attached, a REST or
 * MCP upload never confirmed, and the private backgrounds of a login that no
 * longer exists. The references are issue_attachments.storage_id, the
 * attachments held in Deleted items (deleted_rows.storage_id),
 * profiles.avatar_storage_id and the panorama_images and custom_backgrounds
 * originals and previews (model/attachments.ts storageIdInUse). A deleted
 * file counts as in use while it is held (model/fileHolds.ts), so the sweep
 * leaves it to its scheduled erase or eraseHeldFiles. Component storage
 * (Better Auth) is isolated from this _storage table.
 *
 * A restore rewinds every table but leaves the stored files, so files that
 * only rows written after the restored backup named are named by nothing
 * afterwards. A second restore, of a later backup, would bring their rows
 * back. So a run holds each such file instead of erasing it, until HOLD_MS
 * after the restore was noticed (model/fileHolds.ts noteRestore and
 * restoreHoldEnd), and the eraser erases it when the hold ends.
 * eraseHeldFiles starts such a run when it notices a restore, with
 * `restored: true`. Until the hold would end, later runs hold the files
 * that existed when the restore was noticed, such as an upload of the hour
 * before, which the floor kept from the first run. A run that began before
 * a restore holds instead of erasing from the first leg that follows it. A
 * file a release held is not among them: its hold, or after a restore its
 * scheduled erase, still erases it on time.
 *
 * The weekly cron (crons.ts) starts a run with empty arguments, and so does
 * a manual run, which returns when the first leg ends. Name the deployment
 * with the private helper, because a bare `npx convex run` lands on the
 * deployment in .env.local. TARGET is development, staging or production:
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     TARGET npx convex run files:reapOrphans
 * The demo backend's stored key cannot run internal functions, so on the
 * demo the private with-temp-deploy-key helper runs it with a short-lived key
 * (qivo-internal docs/public-demo-operations.md):
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-temp-deploy-key" \
 *     demo --allow deployment:functions:runInternalMutations --purpose reap-orphans -- \
 *     npx convex run files:reapOrphans
 * A run has three phases: expired upload tickets, then account appearance
 * rows, then every stored file in creation order. Each leg is one
 * transaction that handles at most one REAP_PAGES page of its phase and
 * schedules the next leg with the running counts. The leg with nothing left
 * writes the run's one reap_orphans audit row.
 *
 * The 60-minute floor (0033:34-38) keeps a sweep from racing an upload whose
 * attach is seconds away. It is measured from the run's start, which every
 * leg shares, so a late leg never treats a file as older than it was when
 * the run began. A file's reference check and its delete happen in one leg,
 * so a file attached before its leg runs is kept. An attach racing the leg
 * that checks its file makes one of the two transactions retry. The leg
 * then keeps the file, or the attach finds the bytes gone and refuses. A
 * file that loses its last reference after its leg survives until the next
 * run. A failed leg ends the run without an audit row and earlier legs stay
 * committed, so a missing weekly reap_orphans row in Admin › Audit is the
 * signal. */

/** The most rows one reapOrphans leg handles in each phase. A stored file
 * older than the floor costs storageIdInUse's index ranges, eight with the
 * Deleted items check and the hold, and one more to erase it, so a files
 * leg reads about 2,310 of Convex's 4,096 with the page and the restore
 * check, and has room for more references. A tickets leg reads two ranges
 * and deletes at most two pages. An account costs a Better Auth lookup and,
 * for a removed login, its cleanup. Tests lower these. */
export const REAP_PAGES = { tickets: 1000, accounts: 64, files: 256 }

/* A sweep never deletes a file younger than this when its run starts.
 * Attachment upload tickets (REST and MCP) live exactly this long
 * (model/attachments.ts UPLOAD_TICKET_TTL_MS) and background upload tickets
 * at most 15 minutes (appearance.ts UPLOAD_TTL_SECONDS), so no sweep deletes
 * a file while the ticket it was uploaded for can still confirm it. */
const REAP_FLOOR_MS = 60 * 60 * 1000

const vReapCounts = v.object({
  deleted: v.number(), // unreferenced files deleted
  // unreferenced files held after a restore instead; optional for legs
  // scheduled before the count existed
  held: v.optional(v.number()),
  kept: v.number(), // files kept, in use or younger than the floor
  tickets: v.number(), // expired upload tickets deleted
  accounts: v.number(), // removed logins whose appearance and backgrounds were cleared
})

/** The counts a reapOrphans run records in its reap_orphans audit row. */
export type ReapCounts = Required<Infer<typeof vReapCounts>>

const reapArgs = {
  phase: v.optional(v.union(v.literal('tickets'), v.literal('accounts'), v.literal('files'))),
  cursor: v.optional(v.string()), // the phase's page cursor
  now: v.optional(v.number()), // the run's start, epoch milliseconds
  counts: v.optional(vReapCounts),
  restored: v.optional(v.boolean()), // hold unreferenced files, as after a restore
}
type ReapLeg = ObjectType<typeof reapArgs>

const reapLegRef = makeFunctionReference<'mutation', ReapLeg, null>('files:reapOrphans')

/* One leg of the orphan sweep (header above). Empty arguments start a run. */
export const reapOrphans = internalMutation({
  args: reapArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? Date.now()
    const counts: ReapCounts = {
      held: 0,
      ...(a.counts ?? { deleted: 0, kept: 0, tickets: 0, accounts: 0 }),
    }
    let next: Pick<ReapLeg, 'phase' | 'cursor'> | null = null
    if ((a.phase ?? 'tickets') === 'tickets') {
      // Tickets own no bytes until the receiver commits the completed upload,
      // and an expired upload ticket's unconfirmed bytes fall to the files phase.
      let more = false
      for (const table of ['background_uploads', 'attachment_uploads'] as const) {
        const expired = await ctx.db
          .query(table)
          .withIndex('by_expiry', (q) => q.lte('expires_at', now))
          .take(REAP_PAGES.tickets + 1)
        for (const ticket of expired.slice(0, REAP_PAGES.tickets)) await ctx.db.delete(ticket._id)
        counts.tickets += Math.min(expired.length, REAP_PAGES.tickets)
        more ||= expired.length > REAP_PAGES.tickets
      }
      next = { phase: more ? 'tickets' : 'accounts' }
    } else if (a.phase === 'accounts') {
      // Raw component/CLI deletion can bypass the auth API hook. Preserve a
      // banned user's preferences; only an absent login makes them orphaned.
      const page = await ctx.db
        .query('account_appearance')
        .paginate({ cursor: a.cursor ?? null, numItems: REAP_PAGES.accounts })
      for (const settings of page.page) {
        const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: settings.auth_user_id }],
        })
        if (user) continue
        await clearAccountAppearance(ctx, settings.auth_user_id)
        counts.accounts += 1
      }
      next = page.isDone ? { phase: 'files' } : { phase: 'accounts', cursor: page.continueCursor }
    } else {
      const cutoff = now - REAP_FLOOR_MS
      const restore = await restoreState(ctx)
      const page = await ctx.db.system
        .query('_storage')
        .paginate({ cursor: a.cursor ?? null, numItems: REAP_PAGES.files })
      for (const file of page.page) {
        if (file._creationTime > cutoff || (await storageIdInUse(ctx, file._id))) {
          counts.kept += 1
          continue
        }
        const erase_at = restoreHoldEnd(restore, a.restored === true, file._creationTime, now)
        if (erase_at !== null) {
          await holdAfterRestore(ctx, file, erase_at)
          counts.held += 1
        } else {
          await eraseFile(ctx, file._id)
          counts.deleted += 1
        }
      }
      if (!page.isDone) next = { phase: 'files', cursor: page.continueCursor }
    }
    if (next !== null) {
      await ctx.scheduler.runAfter(0, reapLegRef, {
        ...next,
        now,
        counts,
        ...(a.restored ? { restored: true } : {}),
      })
      return null
    }
    await ctx.db.insert('platform_audit_log', {
      ts: new Date(now).toISOString(),
      actor_email: 'system',
      action: 'reap_orphans',
      detail: counts,
    })
    return null
  },
})

/* ---------------------------------------------------------- eraseHeldFiles
 * Erases the deleted files whose hold has ended and whose scheduled erase
 * (eraseHeldFile below) has not, as after a failed erase, an import into
 * another deployment or a hold the orphan sweep made after a restore
 * (model/fileHolds.ts). The cron (crons.ts) starts a run with empty
 * arguments every ERASE_EVERY_MS. The first leg checks for a restore
 * (noteRestore) and, when it finds one, starts an orphan sweep that holds
 * what the restore left named by nothing. Each leg handles one ERASE_PAGE
 * of the holds due at the run's start and schedules the next leg while due
 * holds are left, so a run reads only due holds. A file a row names again,
 * as after a restore, loses its hold and stays. The last leg logs its counts
 * when it handled any hold. `now` lets a test or a manual check move the
 * clock; the cron never passes it. */

const eraseArgs = {
  now: v.optional(v.number()), // the run's start, epoch milliseconds
  counts: v.optional(v.object({ erased: v.number(), kept: v.number() })),
}

const eraseLegRef = makeFunctionReference<'mutation', ObjectType<typeof eraseArgs>, null>(
  'files:eraseHeldFiles',
)

/* One leg of the eraser (header above). Empty arguments start a run. */
export const eraseHeldFiles = internalMutation({
  args: eraseArgs,
  handler: async (ctx, a): Promise<null> => {
    const now = a.now ?? Date.now()
    if (a.counts === undefined && (await noteRestore(ctx, now))) {
      console.log('restore check: holding the files nothing names (a restore, or the first check)')
      await ctx.scheduler.runAfter(0, reapLegRef, { restored: true })
    }
    const counts: EraseCounts = a.counts ?? { erased: 0, kept: 0 }
    if (await eraseDueFiles(ctx, now, counts)) {
      await ctx.scheduler.runAfter(0, eraseLegRef, { now, counts })
    } else if (counts.erased + counts.kept > 0) console.log('erased held files', counts)
    return null
  },
})

/* A held file's scheduled erase, at the end of the hold that releaseFile
 * made (model/fileHolds.ts eraseOnTime). It is a scheduled function, so a
 * restore that rewinds the hold leaves it in place. */
export const eraseHeldFile = internalMutation({
  args: { storage_id: v.id('_storage') },
  handler: async (ctx, { storage_id }): Promise<null> => {
    await eraseOnTime(ctx, storage_id, Date.now())
    return null
  },
})

/* The restore witness (model/fileHolds.ts noteRestore). Only whether it is
 * still scheduled matters, so it does nothing if it ever runs. */
export const restoreWitness = internalMutation({
  args: {},
  handler: async (): Promise<null> => null,
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
