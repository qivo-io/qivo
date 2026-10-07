/* files.ts (phase 7): attach cap/uniqueness/verbs, removeAttachment rights,
 * avatar set/clear guards, mintUrls visibility fencing, and the fileTokens
 * MAC/exp unit round-trip.
 *
 * Probe fact this suite encodes: ctx.storage.delete ROLLS BACK with a throw
 * in the same mutation (verified live), so attach's oversize path RETURNS
 * { refused } after deleting — the tests assert the bytes are actually gone,
 * which only the return-style refusal can deliver.
 *
 * convex-test's storage.store records size+sha256 but no contentType; the
 * storeBlob helper patches contentType onto the _storage doc directly
 * (verified supported) to stand in for the real upload POST's header. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { attachmentFileUrl, mintFileToken, verifyFileToken } from '../lib/fileTokens'
import {
  activityFor,
  allMessages,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob and URLSearchParams; convex/tsconfig's
 * ESNext-only lib does not declare either. */
declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}
declare class URLSearchParams {
  constructor(init?: string)
  get(name: string): string | null
}

/* fileTokens reads process.env lazily; guarantee the vars exist in this VM
 * (edge-runtime may or may not carry a process global). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'
// This suite asserts exact gateway URLs, overriding the shared auth-discovery default.
g.process.env.CONVEX_SITE_URL = 'https://test.convex.site'

const MiB = 1024 * 1024

/* Store n zero bytes; contentType patched on when given (the upload POST's
 * Content-Type header in production). */
const storeBlob = (t: T, bytes: number, type?: string): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const sid = await ctx.storage.store(new Blob([new Uint8Array(bytes)]) as never)
    if (type !== undefined) await ctx.db.patch(sid as never, { contentType: type } as never)
    return sid
  })

const storageExists = (t: T, sid: Id<'_storage'>): Promise<boolean> =>
  t.run(async (ctx) => (await ctx.db.system.get(sid)) !== null)

const attachmentRows = (t: T): Promise<Doc<'issue_attachments'>[]> =>
  t.run(async (ctx) => await ctx.db.query('issue_attachments').collect())

const profileRow = (t: T, id: string): Promise<Doc<'profiles'> | null> =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query('profiles').collect()
    return rows.find((r) => r.id === id) ?? null
  })

const setOrgCap = (t: T, fx: OrgFixture, mb: number) =>
  as(t, fx.admin).mutation(api.orgs.update, {
    org_id: fx.org.id,
    patch: { max_attachment_mb: mb },
  })

const giveAvatar = async (t: T, profile: Doc<'profiles'>, bytes = 64): Promise<Id<'_storage'>> => {
  const sid = await storeBlob(t, bytes, 'image/png')
  await t.run(async (ctx) => {
    await ctx.db.patch(profile._id, { avatar_storage_id: sid })
  })
  return sid
}

/* attach as `by`, defaulting to a fresh uuid/name; returns the full result. */
const attachAs = (
  t: T,
  fx: OrgFixture,
  by: Doc<'profiles'>,
  issue: Doc<'issues'>,
  sid: Id<'_storage'>,
  extra: { id?: string; name?: string; mime?: string; inline?: boolean } = {},
) =>
  as(t, by).mutation(api.files.attach, {
    org_id: fx.org.id,
    id: extra.id ?? uuid(),
    issue_id: issue.id,
    storage_id: sid,
    name: extra.name ?? 'spec.pdf',
    ...(extra.mime !== undefined ? { mime: extra.mime } : {}),
    inline: extra.inline ?? false,
  })

const setup = async () => {
  const t = newT()
  const fx = await withOrg(t)
  const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
  return { t, fx, issue }
}

describe('files.uploadUrl', () => {
  it('mints for a member, refuses a viewer, hides foreign issues', async () => {
    const { t, fx, issue } = await setup()
    const url = await as(t, fx.user).mutation(api.files.uploadUrl, {
      org_id: fx.org.id,
      issue_id: issue.id,
    })
    expect(typeof url).toBe('string')
    expect(url.length).toBeGreaterThan(0)
    await expectRefusal(
      as(t, fx.viewer).mutation(api.files.uploadUrl, { org_id: fx.org.id, issue_id: issue.id }),
      'forbidden',
    )
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.uploadUrl, {
        org_id: fx.otherOrg.id,
        issue_id: issue.id,
      }),
      'not_found',
    )
  })
})

describe('files.attach', () => {
  it('copies size from storage metadata, fills mime from it, narrates the file verb', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 64, 'application/pdf')
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    expect(result.attachment.size_bytes).toBe(64)
    expect(result.attachment.mime).toBe('application/pdf')
    expect(result.attachment.uploaded_by).toBe(fx.user.id)
    const events = await activityFor(t, fx.org.id)
    const last = events[events.length - 1]
    expect(last.verb).toBe('attached a file to')
    expect(last.detail).toBe('spec.pdf')
    expect(last.target_id).toBe(issue.id)
    // no notify, no updated_at stamp — the SQL had neither
    expect(await allMessages(t)).toEqual([])
    const after = await t.run(async (ctx) =>
      (await ctx.db.query('issues').collect()).find((i) => i.id === issue.id),
    )
    expect(after?.updated_at).toBe(NOW)
  })

  it('inline attach narrates the image verb', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 32, 'image/png')
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'shot.png', inline: true })
    expect('attachment' in result).toBe(true)
    const events = await activityFor(t, fx.org.id)
    expect(events[events.length - 1].verb).toBe('added an image to')
  })

  it('the wire has no size slot — a client-sent size is rejected by the validator', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 32)
    await expect(
      as(t, fx.user).mutation(api.files.attach, {
        org_id: fx.org.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: sid,
        name: 'liar.bin',
        inline: false,
        size_bytes: 1,
      } as never),
    ).rejects.toThrow(/size_bytes/)
  })

  it('exactly at the organization cap passes', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const sid = await storeBlob(t, 1 * MiB)
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'cap.bin' })
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    expect(result.attachment.size_bytes).toBe(1 * MiB)
  })

  it('one byte over the cap returns { refused } AND the bytes die', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const sid = await storeBlob(t, 1 * MiB + 1)
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'big.bin' })
    if (!('refused' in result)) throw new Error('expected a refusal')
    expect(result.refused.code).toBe('bad_request')
    expect(result.refused.message).toBe('attachment exceeds the organization limit of 1 MiB')
    // the commit carried the delete (probe: delete+throw would have rolled back)
    expect(await storageExists(t, sid)).toBe(false)
    expect(await attachmentRows(t)).toEqual([])
    expect(await activityFor(t, fx.org.id)).toEqual([])
  })

  it('ignores legacy team caps in both directions', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 2)
    await t.run((ctx) => ctx.db.patch(fx.team._id, { max_attachment_mb: 1 }))
    const allowed = await storeBlob(t, MiB + 1)
    expect('attachment' in (await attachAs(t, fx, fx.user, issue, allowed))).toBe(true)

    await setOrgCap(t, fx, 1)
    await t.run((ctx) => ctx.db.patch(fx.team._id, { max_attachment_mb: 20 }))
    const denied = await storeBlob(t, MiB + 1)
    const result = await attachAs(t, fx, fx.user, issue, denied)
    expect(result).toEqual({
      refused: {
        code: 'bad_request',
        message: 'attachment exceeds the organization limit of 1 MiB',
      },
    })
    expect(await storageExists(t, denied)).toBe(false)
  })

  it('applies the same organization cap to inline images and projects without a team', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    const teamlessIssue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.hidden.id })
    for (const target of [issue, teamlessIssue]) {
      const sid = await storeBlob(t, MiB + 1, 'image/png')
      const result = await attachAs(t, fx, fx.user, target, sid, { inline: true })
      expect(result).toEqual({
        refused: {
          code: 'bad_request',
          message: 'attachment exceeds the organization limit of 1 MiB',
        },
      })
      expect(await storageExists(t, sid)).toBe(false)
    }
    expect(await attachmentRows(t)).toEqual([])
  })

  it('uses the owning issue organization for a login with seats in two organizations', async () => {
    const { t, fx, issue } = await setup()
    await setOrgCap(t, fx, 1)
    await as(t, fx.otherAdmin).mutation(api.orgs.update, {
      org_id: fx.otherOrg.id,
      patch: { max_attachment_mb: 2 },
    })
    // The Other administrator is also a guest with write access in Testbed Labs.
    await t.run((ctx) => ctx.db.patch(fx.guest._id, { auth_user_id: fx.otherAdmin.auth_user_id }))
    const denied = await storeBlob(t, MiB + 1)
    expect(await attachAs(t, fx, fx.otherAdmin, issue, denied)).toEqual({
      refused: {
        code: 'bad_request',
        message: 'attachment exceeds the organization limit of 1 MiB',
      },
    })
    expect(await storageExists(t, denied)).toBe(false)

    const otherIssue = await plantIssue(t, {
      org_id: fx.otherOrg.id,
      project_id: fx.otherProject.id,
    })
    const allowed = await storeBlob(t, MiB + 1)
    const result = await attachAs(
      t,
      { ...fx, org: fx.otherOrg },
      fx.otherAdmin,
      otherIssue,
      allowed,
    )
    if ('refused' in result) throw new Error(`unexpected refusal: ${result.refused.message}`)
    expect(result.attachment.uploaded_by).toBe(fx.otherAdmin.id)
  })

  it('defaults an older organization to 20 MiB and still enforces the gateway ceiling', async () => {
    const { t, fx, issue } = await setup()
    await t.run((ctx) => ctx.db.patch(fx.org._id, { max_attachment_mb: undefined }))
    const allowed = await storeBlob(t, 20 * MiB)
    expect('attachment' in (await attachAs(t, fx, fx.user, issue, allowed))).toBe(true)
    const denied = await storeBlob(t, 20 * MiB + 1)
    expect(await attachAs(t, fx, fx.user, issue, denied)).toEqual({
      refused: {
        code: 'bad_request',
        message: 'attachment exceeds the organization limit of 20 MiB',
      },
    })
    expect(await storageExists(t, denied)).toBe(false)
  })

  it('a storage id may be referenced by at most ONE attachment row — and the refusal deletes nothing', async () => {
    const { t, fx, issue } = await setup()
    const issue2 = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub2.id })
    const sid = await storeBlob(t, 40)
    const first = await attachAs(t, fx, fx.user, issue, sid)
    expect('attachment' in first).toBe(true)
    await expectRefusal(attachAs(t, fx, fx.user, issue2, sid), 'bad_request', /already attached/)
    expect(await storageExists(t, sid)).toBe(true)
    expect((await attachmentRows(t)).length).toBe(1)
  })

  it('a storage id already serving as an avatar is refused too', async () => {
    const { t, fx, issue } = await setup()
    const avatarSid = await giveAvatar(t, fx.admin)
    await expectRefusal(
      attachAs(t, fx, fx.user, issue, avatarSid),
      'bad_request',
      /already attached/,
    )
    expect(await storageExists(t, avatarSid)).toBe(true)
  })

  it('missing bytes refuse with the diagnosable sentence, never default-to-zero', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 16)
    await t.run(async (ctx) => await ctx.storage.delete(sid))
    await expectRefusal(
      attachAs(t, fx, fx.user, issue, sid),
      'bad_request',
      /bytes not found in storage/,
    )
  })

  it('rights: guest with a member grant attaches; viewer is capped out; foreign org sees nothing', async () => {
    const { t, fx, issue } = await setup()
    const guestSid = await storeBlob(t, 8)
    const result = await attachAs(t, fx, fx.guest, issue, guestSid)
    expect('attachment' in result).toBe(true)
    const viewerSid = await storeBlob(t, 8)
    await expectRefusal(attachAs(t, fx, fx.viewer, issue, viewerSid), 'forbidden')
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.attach, {
        org_id: fx.otherOrg.id,
        id: uuid(),
        issue_id: issue.id,
        storage_id: viewerSid,
        name: 'x.bin',
        inline: false,
      }),
      'not_found',
    )
  })
})

describe('files.removeAttachment', () => {
  const planted = async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 24)
    const result = await attachAs(t, fx, fx.admin, issue, sid, { name: 'doomed.txt' })
    if ('refused' in result) throw new Error('setup attach refused')
    return { t, fx, issue, sid, attId: result.attachment.id }
  }

  it('any project member may delete any attachment (not uploader-only) — row, bytes and verb', async () => {
    const { t, fx, sid, attId, issue } = await planted()
    // guest holds 'user' via the meta grant and did NOT upload this file
    await as(t, fx.guest).mutation(api.files.removeAttachment, { org_id: fx.org.id, id: attId })
    expect(await attachmentRows(t)).toEqual([])
    expect(await storageExists(t, sid)).toBe(false)
    const events = await activityFor(t, fx.org.id)
    const last = events[events.length - 1]
    expect(last.verb).toBe('removed an attachment from')
    expect(last.detail).toBe('doomed.txt')
    expect(last.target_id).toBe(issue.id)
  })

  it('inline rows narrate the image verb', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 24)
    const result = await attachAs(t, fx, fx.user, issue, sid, { name: 'pic.png', inline: true })
    if ('refused' in result) throw new Error('setup attach refused')
    await as(t, fx.user).mutation(api.files.removeAttachment, {
      org_id: fx.org.id,
      id: result.attachment.id,
    })
    const events = await activityFor(t, fx.org.id)
    expect(events[events.length - 1].verb).toBe('removed an image from')
  })

  it('viewer is refused, foreign org and missing ids read not_found', async () => {
    const { t, fx, sid, attId } = await planted()
    await expectRefusal(
      as(t, fx.viewer).mutation(api.files.removeAttachment, { org_id: fx.org.id, id: attId }),
      'forbidden',
    )
    await expectRefusal(
      as(t, fx.otherAdmin).mutation(api.files.removeAttachment, {
        org_id: fx.otherOrg.id,
        id: attId,
      }),
      'not_found',
    )
    await expectRefusal(
      as(t, fx.user).mutation(api.files.removeAttachment, { org_id: fx.org.id, id: uuid() }),
      'not_found',
    )
    expect(await storageExists(t, sid)).toBe(true)
    expect((await attachmentRows(t)).length).toBe(1)
  })
})

describe('files.setAvatar / clearAvatar', () => {
  it('self sets; a swap deletes the OLD bytes in the same mutation', async () => {
    const { t, fx } = await setup()
    const first = await storeBlob(t, 128, 'image/webp')
    await as(t, fx.user).mutation(api.files.setAvatar, {
      profile_id: fx.user.id,
      storage_id: first,
    })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBe(first)
    const second = await storeBlob(t, 128, 'image/png')
    await as(t, fx.user).mutation(api.files.setAvatar, {
      profile_id: fx.user.id,
      storage_id: second,
    })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBe(second)
    expect(await storageExists(t, first)).toBe(false)
    expect(await storageExists(t, second)).toBe(true)
  })

  it('an org admin sets for others; a plain member may not; absent uuids read the same sentence', async () => {
    const { t, fx } = await setup()
    const sid = await storeBlob(t, 64, 'image/jpeg')
    await as(t, fx.admin).mutation(api.files.setAvatar, {
      profile_id: fx.agent.id,
      storage_id: sid,
    })
    expect((await profileRow(t, fx.agent.id))?.avatar_storage_id).toBe(sid)
    const sid2 = await storeBlob(t, 64, 'image/jpeg')
    const wrong = await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: fx.admin.id, storage_id: sid2 }),
      'forbidden',
    )
    const missing = await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: uuid(), storage_id: sid2 }),
      'forbidden',
    )
    // 0099:203 verbatim, identical for invisible and absent (no existence oracle)
    const sentence = 'only this person or an organization admin can change their picture'
    expect((wrong.data as { message: string }).message).toBe(sentence)
    expect((missing.data as { message: string }).message).toBe(sentence)
  })

  it('mime allowlist: SVG and typeless uploads are refused (0096 successor)', async () => {
    const { t, fx } = await setup()
    const svg = await storeBlob(t, 64, 'image/svg+xml')
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: fx.user.id, storage_id: svg }),
      'rule',
      /PNG, JPEG, WebP, or GIF/,
    )
    const typeless = await storeBlob(t, 64)
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, {
        profile_id: fx.user.id,
        storage_id: typeless,
      }),
      'rule',
      /PNG, JPEG, WebP, or GIF/,
    )
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBeUndefined()
  })

  it('2 MB cap: exactly at passes, one byte over refuses', async () => {
    const { t, fx } = await setup()
    const atCap = await storeBlob(t, 2_097_152, 'image/png')
    await as(t, fx.user).mutation(api.files.setAvatar, {
      profile_id: fx.user.id,
      storage_id: atCap,
    })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBe(atCap)
    const over = await storeBlob(t, 2_097_153, 'image/png')
    await expectRefusal(
      as(t, fx.admin).mutation(api.files.setAvatar, { profile_id: fx.admin.id, storage_id: over }),
      'rule',
      /at most 2 MB/,
    )
  })

  it('a storage id referenced elsewhere is refused — the delete paths could destroy foreign bytes', async () => {
    const { t, fx, issue } = await setup()
    const attSid = await storeBlob(t, 32, 'image/png')
    const result = await attachAs(t, fx, fx.user, issue, attSid, { name: 'pic.png', inline: true })
    expect('attachment' in result).toBe(true)
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, { profile_id: fx.user.id, storage_id: attSid }),
      'bad_request',
      /already in use/,
    )
    const otherFace = await giveAvatar(t, fx.admin)
    await expectRefusal(
      as(t, fx.user).mutation(api.files.setAvatar, {
        profile_id: fx.user.id,
        storage_id: otherFace,
      }),
      'bad_request',
      /already in use/,
    )
    expect(await storageExists(t, attSid)).toBe(true)
    expect(await storageExists(t, otherFace)).toBe(true)
  })

  it('clearAvatar deletes the bytes; clearing nothing is a no-op; rights match setAvatar', async () => {
    const { t, fx } = await setup()
    const sid = await giveAvatar(t, fx.user)
    await expectRefusal(
      as(t, fx.guest).mutation(api.files.clearAvatar, { profile_id: fx.user.id }),
      'forbidden',
    )
    await as(t, fx.user).mutation(api.files.clearAvatar, { profile_id: fx.user.id })
    expect((await profileRow(t, fx.user.id))?.avatar_storage_id).toBeUndefined()
    expect(await storageExists(t, sid)).toBe(false)
    // idempotent second clear
    await as(t, fx.user).mutation(api.files.clearAvatar, { profile_id: fx.user.id })
  })
})

describe('files.mintUrls', () => {
  it('mints attachment urls for visible rows and OMITS invisible/missing ids — no existence oracle', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 16, 'image/png')
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error('setup attach refused')
    const attId = result.attachment.id
    // an attachment on the hidden meta — guest holds no grant there
    const hiddenIssue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.hidden.id })
    const hiddenSid = await storeBlob(t, 16)
    const hiddenAtt = await t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('issue_attachments', {
        org_id: hiddenIssue.org_id,
        id,
        issue_id: hiddenIssue.id,
        name: 'secret.txt',
        size_bytes: 16,
        storage_id: hiddenSid,
        inline: false,
        created_at: NOW,
      })
      return id
    })
    const before = Math.floor(Date.now() / 1000)
    const minted = await as(t, fx.guest).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [attId, hiddenAtt, uuid()],
    })
    expect(Object.keys(minted.attachments)).toEqual([attId])
    expect(minted.avatars).toEqual({})
    const { url, exp } = minted.attachments[attId]
    expect(exp).toBeGreaterThanOrEqual(before + 599)
    expect(exp).toBeLessThanOrEqual(before + 601)
    expect(url.startsWith(`https://test.convex.site/files/${attId}?`)).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('e')).toBe(String(exp))
    expect(params.get('m')).toBe(fx.guest.id) // minter = caller's profile uuid
    expect(
      await verifyFileToken({
        kind: 'attachment',
        id: attId,
        minter: fx.guest.id,
        exp,
        token: params.get('t') as string,
      }),
    ).toBe(true)
    // the minter who CAN see hidden gets it
    const adminMinted = await as(t, fx.admin).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [hiddenAtt],
    })
    expect(Object.keys(adminMinted.attachments)).toEqual([hiddenAtt])
  })

  it('a viewer can mint what it can see — read scope, not write scope', async () => {
    const { t, fx, issue } = await setup()
    const sid = await storeBlob(t, 16)
    const result = await attachAs(t, fx, fx.user, issue, sid)
    if ('refused' in result) throw new Error('setup attach refused')
    const minted = await as(t, fx.viewer).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [result.attachment.id],
    })
    expect(Object.keys(minted.attachments)).toEqual([result.attachment.id])
  })

  it('avatar urls carry v=<storage id> and auth-user minter; foreign orgs and avatarless profiles are omitted', async () => {
    const { t, fx } = await setup()
    const faceSid = await giveAvatar(t, fx.admin)
    await giveAvatar(t, fx.otherAdmin)
    const minted = await as(t, fx.guest).query(api.files.mintUrls, {
      org_id: fx.org.id,
      profile_ids: [fx.admin.id, fx.user.id, fx.otherAdmin.id, uuid()],
    })
    // fx.user has no avatar; otherAdmin is a foreign org; the last is missing
    expect(Object.keys(minted.avatars)).toEqual([fx.admin.id])
    const { url, exp } = minted.avatars[fx.admin.id]
    expect(url.startsWith(`https://test.convex.site/avatars/${fx.admin.id}?`)).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('v')).toBe(faceSid)
    expect(params.get('m')).toBe(fx.guest.auth_user_id) // minter = auth-user id
    expect(
      await verifyFileToken({
        kind: 'avatar',
        id: fx.admin.id,
        minter: fx.guest.auth_user_id as string,
        exp,
        token: params.get('t') as string,
      }),
    ).toBe(true)
  })
})

describe('fileTokens', () => {
  const base = { kind: 'attachment' as const, id: 'att-1', minter: 'prof-1' }

  it('round-trips: mint then verify', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const token = await mintFileToken({ ...base, exp })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 HMAC bytes, base64url, no padding
    expect(await verifyFileToken({ ...base, exp, token })).toBe(true)
  })

  it('rejects tampering with any covered field', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const token = await mintFileToken({ ...base, exp })
    expect(
      await verifyFileToken({
        ...base,
        exp,
        token: `A${token.slice(1)}` === token ? `B${token.slice(1)}` : `A${token.slice(1)}`,
      }),
    ).toBe(false)
    expect(await verifyFileToken({ ...base, id: 'att-2', exp, token })).toBe(false)
    expect(await verifyFileToken({ ...base, minter: 'prof-2', exp, token })).toBe(false)
    expect(await verifyFileToken({ ...base, kind: 'avatar', exp, token })).toBe(false)
    expect(await verifyFileToken({ ...base, exp: exp + 1, token })).toBe(false)
    expect(await verifyFileToken({ ...base, exp, token: 'not!base64url' })).toBe(false)
    expect(await verifyFileToken({ ...base, exp, token: '' })).toBe(false)
  })

  it('rejects expired tokens — exp injected, now injected', async () => {
    const exp = 1_000_000 // long past
    const token = await mintFileToken({ ...base, exp })
    expect(await verifyFileToken({ ...base, exp, token })).toBe(false)
    // and a valid MAC exactly AT expiry fails, one second before passes
    expect(await verifyFileToken({ ...base, exp, token, now: exp * 1000 })).toBe(false)
    expect(await verifyFileToken({ ...base, exp, token, now: exp * 1000 - 1000 })).toBe(true)
  })

  it('urls put the token parts where the gateway parses them', () => {
    const url = attachmentFileUrl({ id: 'att-1', minter: 'prof-1', exp: 123, token: 'tok' })
    expect(url).toBe('https://test.convex.site/files/att-1?e=123&m=prof-1&t=tok')
  })
})
