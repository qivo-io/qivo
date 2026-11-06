/* The organization export's delivery: the link orgExport.claimDownload
 * answers an admin, the /exports/ route that streams a ready archive as one
 * ZIP (http.ts), its checks on every request and before every part, its
 * leases, and the record of an archive served whole, the job's served_at
 * alone (orgExport.ts recordDelivery, model/orgExports.ts noteDelivered).
 *
 * Each case prepares a small archive with the real job on fake timers and
 * reads the route through convex-test's fetch. The body is a stream that
 * reads files and records the delivery after fetch has answered, so these
 * cases also show that storage reads, queries and mutations run in a body
 * pulled after the handler returned. convex-test finds its deployment
 * through the async context of the call that runs a function, and a pull
 * started from a test's own code has none, so the tests pull the body
 * inside an action of their own (`pulled`), as the runtime pulls it inside
 * the HTTP action. */
/// <reference types="vite/client" />

import type { Value } from 'convex/values'
import { unzipSync } from 'fflate/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { type FileTokenKind, mintFileToken, verifyFileToken } from '../lib/fileTokens'
import { ZIP_END_BYTES, zipEntryBytes } from '../lib/orgExport'
import { ARCHIVE_TTL_MS, DELIVERY, EXPORT_LIMITS } from '../model/orgExports'
import { scheduleRemoval } from '../model/orgRetention'
import { type DownloadClaim, readDelivery } from '../orgExport'
import {
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
import {
  exportAs,
  filesOf,
  jobOf,
  partsOf,
  requestsOf,
  START,
  settle,
  zipOf,
} from './orgExport.setup'

const DEFAULT_LIMITS = { ...EXPORT_LIMITS }
const DEFAULT_DELIVERY = { ...DELIVERY }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  Object.assign(EXPORT_LIMITS, DEFAULT_LIMITS)
  Object.assign(DELIVERY, DEFAULT_DELIVERY)
  vi.unstubAllEnvs()
  vi.clearAllTimers()
  vi.useRealTimers()
})

/** The app's origin in the tests (env.setup.ts SITE_URL). */
const APP = 'http://localhost:5199'

const claim = (
  t: T,
  profile: Doc<'profiles'>,
  orgId: string,
  exportId: string,
  automatic = false,
) =>
  as(t, profile).mutation(api.orgExport.claimDownload, {
    org_id: orgId,
    export_id: exportId,
    automatic,
  })

/** A fixture organization with a task and a ready archive its admin asked
 * for. */
async function ready(t: T) {
  const f = await withOrg(t)
  await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: '<p>Bench notes</p>' })
  const exportId = await exportAs(t, f.admin, f.org.id)
  expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })
  return { f, exportId }
}

/** The path and query of a claimed link. */
function pathOf(answer: DownloadClaim): string {
  if (answer.url === null) throw new Error(`no link: ${answer.reason}`)
  const url = new URL(answer.url)
  return `${url.pathname}${url.search}`
}

/** A link of `kind` for export `exportId` minted for `minter`, a profile's
 * document id as claimDownload signs it, without a claim, valid
 * DELIVERY.tokenSeconds unless `exp` says otherwise. */
async function mint(
  exportId: string,
  minter: string,
  opts: { kind?: FileTokenKind; exp?: number } = {},
): Promise<string> {
  const exp = opts.exp ?? Math.floor(Date.now() / 1000) + 1 + DELIVERY.tokenSeconds
  const token = await mintFileToken({ kind: opts.kind ?? 'org_export', id: exportId, minter, exp })
  return `/exports/${exportId}?e=${exp}&m=${encodeURIComponent(minter)}&t=${token}`
}

const get = (t: T, path: string, origin = APP) => t.fetch(path, { headers: { Origin: origin } })

/** `pull`, which reads a route's body, run inside an action of the test's
 * deployment, where the body's queries, mutations and storage reads find it
 * as they find the HTTP action's deployment in the runtime. */
const pulled = <R extends Value>(t: T, pull: () => Promise<R>): Promise<R> =>
  t.action(async () => await pull())

/** The next chunk `reader` gives, a copy, or null at the end. */
const nextChunk = async (t: T, reader: ReadableStreamDefaultReader<Uint8Array>) =>
  new Uint8Array(
    (await pulled(t, async () => {
      const { done, value } = await reader.read()
      return done ? null : value.slice().buffer
    })) ?? new ArrayBuffer(0),
  )

/** Every byte of `res`'s body, or those that came before it failed, with
 * the failure's message. */
async function drain(t: T, res: Response): Promise<{ bytes: Uint8Array; error: string | null }> {
  const body = res.body
  if (body === null) return { bytes: new Uint8Array(0), error: null }
  const reader = body.getReader()
  const read = await pulled(t, async () => {
    const chunks: Uint8Array[] = []
    let error: string | null = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
    } catch (e) {
      error = String(e)
    }
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.length
    }
    return { bytes: bytes.buffer, error }
  })
  return { bytes: new Uint8Array(read.bytes), error: read.error }
}

/** Expects `res` to be the gateway's one refusal: 404, no-store, no body,
 * with nosniff, the sandbox CSP and Vary: Origin. */
async function expectRefused(res: Response, label: string) {
  expect(res.status, label).toBe(404)
  expect(res.headers.get('Cache-Control'), label).toBe('no-store')
  expect(res.headers.get('X-Content-Type-Options'), label).toBe('nosniff')
  expect(res.headers.get('Content-Security-Policy'), label).toBe("default-src 'none'; sandbox")
  expect(res.headers.get('Vary'), label).toBe('Origin')
  expect(res.headers.get('Content-Type'), label).toBeNull()
  expect(await res.text(), label).toBe('')
}

/** The current fake time as an ISO string. */
const NOW_ISO = () => new Date(Date.now()).toISOString()

const orgRow = (t: T, id: string) => t.run((ctx) => byId(ctx, 'organizations', id))

const deletionNotices = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('billing_notices').collect()).filter((n) => n.kind === 'deletion'),
  )

describe('the download link', () => {
  it('answers each requesting admin one automatic link, and a manual one every time that writes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { org_role: 'admin' }))
    const asked = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    // a second admin joins while it collects
    await as(t, f.user).mutation(api.orgExport.request, { org_id: f.org.id })
    await settle(t)
    const exportId = asked.export_id
    const first = await claim(t, f.admin, f.org.id, exportId, true)
    expect(first.url).toMatch(new RegExp(`^https://some\\.convex\\.site/exports/${exportId}\\?`))
    // other tabs, devices and reconnects of the same admin get none
    expect(await claim(t, f.admin, f.org.id, exportId, true)).toEqual({
      url: null,
      reason: 'claimed',
    })
    // the joined admin's own attempt is theirs
    expect((await claim(t, f.user, f.org.id, exportId, true)).url).not.toBeNull()
    expect(await claim(t, f.user, f.org.id, exportId, true)).toMatchObject({ reason: 'claimed' })
    const rows = await requestsOf(t, exportId)
    expect(rows.map((row) => row.auto_download_at)).toEqual([NOW_ISO(), NOW_ISO()])

    // an admin who did not ask gets no automatic link, but a manual one
    const late = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.org.id,
        name: 'Late admin',
        initials: 'LA',
        color: '#7a7ad0',
        org_role: 'admin',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
        auth_user_id: f.viewer.auth_user_id,
      })
      await ctx.db.patch(f.viewer._id, { active: false })
      return (await ctx.db.get(_id)) as Doc<'profiles'>
    })
    expect(await claim(t, late, f.org.id, exportId, true)).toEqual({
      url: null,
      reason: 'not_requested',
    })
    const before = await t.run(async (ctx) => ({
      requests: await ctx.db.query('org_export_requests').collect(),
      jobs: await ctx.db.query('org_exports').collect(),
    }))
    for (let i = 0; i < 3; i++) {
      const manual = await claim(t, late, f.org.id, exportId)
      expect(manual.url).not.toBeNull()
      expect((await claim(t, f.admin, f.org.id, exportId)).url).not.toBeNull()
    }
    // manual claims write nothing
    expect(
      await t.run(async (ctx) => ({
        requests: await ctx.db.query('org_export_requests').collect(),
        jobs: await ctx.db.query('org_exports').collect(),
      })),
    ).toEqual(before)
  })

  it("answers not_requested to a profile that took a removed requester's id", async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    vi.advanceTimersByTime(2000)
    // the admin's seat goes and a new profile takes its id and login
    const taker = await t.run(async (ctx) => {
      const { _id, _creationTime, ...seat } = f.admin
      await ctx.db.delete(_id)
      const id = await ctx.db.insert('profiles', seat)
      return (await ctx.db.get(id)) as Doc<'profiles'>
    })
    expect(await claim(t, taker, f.org.id, exportId, true)).toEqual({
      url: null,
      reason: 'not_requested',
    })
    // a manual link it may still have, as any active admin may
    expect((await claim(t, taker, f.org.id, exportId)).url).not.toBeNull()
  })

  it('refuses members, other organizations, foreign and unknown exports, jobs with no archive and an organization being deleted', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    for (const profile of [f.user, f.viewer, f.guest]) {
      await expectRefusal(
        claim(t, profile, f.org.id, exportId),
        'forbidden',
        /only organization admins/,
      )
      await expectRefusal(claim(t, profile, f.org.id, exportId, true), 'forbidden')
    }
    await expectRefusal(claim(t, f.otherAdmin, f.org.id, exportId), 'forbidden')
    // unknown and another organization's export alike
    await expectRefusal(claim(t, f.admin, f.org.id, uuid()), 'not_found', /export not found/)
    await expectRefusal(
      claim(t, f.otherAdmin, f.otherOrg.id, exportId),
      'not_found',
      /export not found/,
    )

    // a read-only organization before its deletion is served
    const removal = await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
      }),
    )
    expect((await claim(t, f.admin, f.org.id, exportId)).url).not.toBeNull()

    // a collecting job has its own sentence
    const next = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    await expectRefusal(claim(t, f.admin, f.org.id, next.export_id), 'rule', /still being prepared/)
    // a cancelled one, and a failed one, are no longer available
    await as(t, f.admin).mutation(api.orgExport.cancel, {
      org_id: f.org.id,
      export_id: next.export_id,
    })
    await expectRefusal(claim(t, f.admin, f.org.id, next.export_id), 'rule', /no longer available/)
    const failed = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    EXPORT_LIMITS.archive = 100
    await settle(t)
    expect(await jobOf(t, failed.export_id)).toMatchObject({ state: 'failed' })
    await expectRefusal(
      claim(t, f.admin, f.org.id, failed.export_id),
      'rule',
      /no longer available/,
    )
    // a ready archive past its four hours before the sweep ends it, and
    // then expired
    vi.setSystemTime(START + ARCHIVE_TTL_MS + 1000)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })
    await expectRefusal(claim(t, f.admin, f.org.id, exportId), 'rule', /no longer available/)
    await t.mutation(internal.orgExport.expire, { export_id: exportId })
    await expectRefusal(claim(t, f.admin, f.org.id, exportId, true), 'rule', /no longer available/)

    // once the deletion has begun its admins hold no active seat
    await t.run((ctx) => ctx.db.patch(removal, { phase: 'profiles' }))
    await expectRefusal(
      claim(t, f.admin, f.org.id, exportId),
      'forbidden',
      /only organization admins/,
    )
  })

  it('refuses an inactive admin', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { active: false }))
    await expectRefusal(claim(t, f.admin, f.org.id, exportId), 'forbidden')
  })

  it('mints an org_export token for the export, the admin and two minutes, which opens nothing else', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const answer = await claim(t, f.admin, f.org.id, exportId)
    if (answer.url === null) throw new Error('no link')
    const url = new URL(answer.url)
    expect(url.pathname).toBe(`/exports/${exportId}`)
    const exp = Number(url.searchParams.get('e'))
    const token = url.searchParams.get('t') as string
    // the profile's document, which no later profile can take, not its uuid
    expect(url.searchParams.get('m')).toBe(f.admin._id)
    expect(exp).toBe(START / 1000 + 1 + DELIVERY.tokenSeconds)
    expect(answer.expires_at).toBe(new Date(exp * 1000).toISOString())
    const base = { id: exportId, minter: f.admin._id, exp, token }
    expect(await verifyFileToken({ ...base, kind: 'org_export' })).toBe(true)
    expect(await verifyFileToken({ ...base, kind: 'attachment' })).toBe(false)
    expect(await verifyFileToken({ ...base, kind: 'org_export', id: uuid() })).toBe(false)
    expect(await verifyFileToken({ ...base, kind: 'org_export', minter: f.user._id })).toBe(false)
    expect(await verifyFileToken({ ...base, kind: 'org_export', minter: f.admin.id })).toBe(false)
    // the token does not open the file gateway either
    const files = await get(t, `/files/${exportId}${url.search}`)
    await expectRefused(files, 'an export token at /files/')
    expect(JSON.stringify(answer)).not.toMatch(/storage/)
  })
})

describe('the /exports/ route', () => {
  it("streams the archive as the tests' own ZIP of its parts, with the gateway's headers", async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const job = await jobOf(t, exportId)
    if (job?.archive === undefined || job.completed_at === undefined) throw new Error('not ready')
    const res = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.headers.entries())).toMatchObject({
      'content-type': 'application/zip',
      'content-length': String(job.archive.bytes),
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      vary: 'Origin',
      'access-control-allow-origin': APP,
      'access-control-expose-headers': 'Content-Disposition',
    })
    const name = `qivo-${f.org.slug}-${job.completed_at.slice(0, 10)}.zip`
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="${name}"; filename*=UTF-8''${name}`,
    )
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    // the body is read after fetch answered: storage reads and the record
    // run in a stream the handler returned
    const { bytes, error } = await drain(t, res)
    expect(error).toBeNull()
    const parts = await partsOf(t, exportId)
    const reference = zipOf(parts, await filesOf(t, parts), job.completed_at)
    expect(bytes.length).toBe(job.archive.bytes)
    expect(bytes).toEqual(reference)
    expect(Object.keys(unzipSync(bytes))).toEqual(parts.map((part) => part.entry))
    // with a foreign origin, no echo
    const foreign = await get(
      t,
      pathOf(await claim(t, f.admin, f.org.id, exportId)),
      'https://evil.example',
    )
    expect(foreign.status).toBe(200)
    expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(foreign.headers.get('Vary')).toBe('Origin')
    await drain(t, foreign)
  })

  it('answers the one 404 for every malformed, foreign or stale link', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const good = pathOf(await claim(t, f.admin, f.org.id, exportId))
    const { search } = new URL(`https://x${good}`)
    const params = new URL(`https://x${good}`).searchParams
    const without = (name: string) => {
      const copy = new URL(`https://x${good}`)
      copy.searchParams.delete(name)
      return `${copy.pathname}${copy.search}`
    }
    const token = params.get('t') as string
    const tampered = good.replace(
      `t=${token}`,
      `t=${token.startsWith('A') ? 'B' : 'A'}${token.slice(1)}`,
    )
    const cases: [string, string][] = [
      ['an empty id', `/exports/${search}`],
      ['an id with a slash', `/exports/${exportId}/x${search}`],
      ['no e', without('e')],
      ['no m', without('m')],
      ['no t', without('t')],
      ['a tampered token', tampered],
      ['an attachment token', await mint(exportId, f.admin._id, { kind: 'attachment' })],
      [
        'a token for another export',
        (await mint(uuid(), f.admin._id)).replace(/^\/exports\/[^?]+/, `/exports/${exportId}`),
      ],
      ['another export', await mint(uuid(), f.admin._id)],
      ['a member', await mint(exportId, f.user._id)],
      ["another organization's admin", await mint(exportId, f.otherAdmin._id)],
      // the admin's uuid, which a later profile can take, instead of the
      // profile document the claim signs
      ["the admin's uuid", await mint(exportId, f.admin.id)],
    ]
    for (const [label, path] of cases) await expectRefused(await get(t, path), label)
    // the good link still works
    expect((await get(t, good)).status).toBe(200)
    // an expired one does not
    vi.advanceTimersByTime((DELIVERY.tokenSeconds + 1) * 1000)
    await expectRefused(await get(t, good), 'an expired token')
  })

  it('checks the minter again on every request: demoted, deactivated, removed, moved or replaced', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const changes: [string, (ctx: MutationCtx) => Promise<unknown>][] = [
      ['demoted', (ctx) => ctx.db.patch(f.admin._id, { org_role: 'user' })],
      ['deactivated', (ctx) => ctx.db.patch(f.admin._id, { active: false })],
      [
        'moved to another organization',
        (ctx) => ctx.db.patch(f.admin._id, { org_id: f.otherOrg.id }),
      ],
      ['removed', (ctx) => ctx.db.delete(f.admin._id)],
    ]
    for (const [label, change] of changes) {
      const link = pathOf(await claim(t, f.admin, f.org.id, exportId))
      const snapshot = await t.run((ctx) => ctx.db.get(f.admin._id))
      await t.run(change)
      await expectRefused(await get(t, link), label)
      // put the admin back for the next change
      await t.run(async (ctx) => {
        if (snapshot === null) return
        const { _id, _creationTime, ...seat } = snapshot
        if ((await ctx.db.get(_id)) === null) {
          const back = await ctx.db.insert('profiles', seat)
          f.admin = (await ctx.db.get(back)) as Doc<'profiles'>
        } else await ctx.db.replace(_id, seat)
      })
    }
    // a profile that takes the minter's uuid after the mint, also within
    // the second the claim rounds the mint up to
    for (const after of [2000, 600]) {
      const link = pathOf(await claim(t, f.admin, f.org.id, exportId))
      vi.advanceTimersByTime(after)
      await t.run(async (ctx) => {
        const { _id, _creationTime, ...seat } = (await ctx.db.get(f.admin._id)) as Doc<'profiles'>
        await ctx.db.delete(_id)
        f.admin = (await ctx.db.get(await ctx.db.insert('profiles', seat))) as Doc<'profiles'>
      })
      await expectRefused(
        await get(t, link),
        `a profile that took the id ${after} ms after the mint`,
      )
      // the new profile's own link works
      const own = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
      expect(own.status).toBe(200)
      await drain(t, own)
    }
  })

  it('refuses a job that is not ready, past its four hours or ended by a newer archive, and an organization being deleted', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    // a link that outlives the archive, so only the job's checks refuse it
    const long = await mint(exportId, f.admin._id, {
      exp: Math.floor(Date.now() / 1000) + 6 * 3600,
    })
    expect((await get(t, long)).status).toBe(200)
    // a collecting job
    const next = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    await expectRefused(await get(t, await mint(next.export_id, f.admin._id)), 'collecting')
    // past expires_at before its expiry runs
    vi.setSystemTime(START + ARCHIVE_TTL_MS + 1000)
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })
    await expectRefused(await get(t, long), 'past its four hours')
    vi.setSystemTime(START + 60_000)
    expect((await get(t, long)).status).toBe(200)
    // a newer archive ends this one
    await settle(t)
    expect(await jobOf(t, next.export_id)).toMatchObject({ state: 'ready' })
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'expired' })
    await expectRefused(await get(t, long), 'ended by a newer archive')
    // the organization's deletion begins
    const newer = await mint(next.export_id, f.admin._id)
    expect((await get(t, newer)).status).toBe(200)
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
        phase: 'profiles',
      }),
    )
    await expectRefused(await get(t, newer), 'deletion begun')
  })

  it("refuses on the public demo once the visitor's session no longer reads the organization", async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    vi.stubEnv('APP_MODE', 'demo')
    const receipt = await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: f.admin.auth_user_id as string,
        org_id: f.org.id,
        created_at: Date.now(),
        expires_at: Date.now() + 86_400_000,
        status: 'ready',
      }),
    )
    const link = await mint(exportId, f.admin._id)
    const res = await get(t, link)
    expect(res.status).toBe(200)
    await drain(t, res)
    await t.run((ctx) => ctx.db.patch(receipt, { expires_at: Date.now() - 1 }))
    await expectRefused(await get(t, link), 'an expired demo')
    await t.run((ctx) =>
      ctx.db.patch(receipt, { expires_at: Date.now() + 1000, status: 'deleting' }),
    )
    await expectRefused(await get(t, link), 'a demo whose cleanup began')
  })

  it('fails a ready archive whose file is gone, answering the one 404', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const parts = await partsOf(t, exportId)
    await t.run((ctx) => ctx.storage.delete(parts[3].storage_id))
    await expectRefused(
      await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId))),
      'a file gone',
    )
    expect(await jobOf(t, exportId)).toMatchObject({
      state: 'failed',
      error: { code: 'incomplete' },
    })
    // and the job's status says so instead of offering the archive
    const status = await as(t, f.admin).query(api.orgExport.status, { org_id: f.org.id })
    expect(status.latest).toMatchObject({ state: 'failed', error: { code: 'incomplete' } })
  })

  it('answers a preflight with GET and OPTIONS, echoing only app origins', async () => {
    const t = newT()
    const { exportId } = await ready(t)
    const preflight = (origin: string) =>
      t.fetch(`/exports/${exportId}`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Headers': 'range' },
      })
    const app = await preflight(APP)
    expect(app.status).toBe(204)
    expect(app.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS')
    expect(app.headers.get('Access-Control-Max-Age')).toBe('86400')
    expect(app.headers.get('Access-Control-Allow-Headers')).toBe('range')
    expect(app.headers.get('Access-Control-Allow-Origin')).toBe(APP)
    expect(app.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const foreign = await preflight('https://evil.example')
    expect(foreign.status).toBe(204)
    expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('what a download records', () => {
  it("records an archive served whole in the job's served_at once its last byte is taken, for any admin, leaving the last export alone and writing no request row", async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { org_role: 'admin' }))
    const user = { ...f.user, org_role: 'admin' as const }
    // a download that has not been read to its end records nothing
    const res = await get(t, pathOf(await claim(t, user, f.org.id, exportId)))
    expect(res.status).toBe(200)
    expect((await jobOf(t, exportId))?.served_at).toBeUndefined()
    vi.advanceTimersByTime(5000)
    const servedAt = NOW_ISO()
    expect((await drain(t, res)).error).toBeNull()
    expect(await jobOf(t, exportId)).toMatchObject({ served_at: servedAt })
    // the backend cannot know that the client received the archive, so the
    // organization's last export stays unset
    expect((await orgRow(t, f.org.id))?.last_export_at).toBeUndefined()
    // an admin who did not ask downloads without a request row
    expect((await requestsOf(t, exportId)).map((row) => row.profile_id)).toEqual([f.admin.id])
    // the browser export still records its own download, and a second
    // served download keeps both the first served_at and that last export
    vi.advanceTimersByTime(60_000)
    await as(t, f.admin).mutation(api.orgRemovals.recordExport, { org_id: f.org.id })
    const browserAt = NOW_ISO()
    vi.advanceTimersByTime(60_000)
    const again = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
    expect((await drain(t, again)).error).toBeNull()
    expect(await jobOf(t, exportId)).toMatchObject({ served_at: servedAt })
    expect((await orgRow(t, f.org.id))?.last_export_at).toBe(browserAt)
    // the leases are gone
    expect((await jobOf(t, exportId))?.streams).toBeUndefined()

    const status = await as(t, f.admin).query(api.orgExport.status, { org_id: f.org.id })
    expect(status.latest).toMatchObject({ served_at: servedAt, auto_download_at: null })
  })

  it('records nothing for a body cancelled part way or one whose file is erased after it started', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    DELIVERY.slice = 64
    const cancelled = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
    const reader = cancelled.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    expect((await nextChunk(t, reader)).length).toBeGreaterThan(0)
    expect((await nextChunk(t, reader)).length).toBeGreaterThan(0)
    await pulled(t, async () => {
      await reader.cancel()
      return null
    })
    expect(await jobOf(t, exportId)).toMatchObject({ state: 'ready' })
    expect((await jobOf(t, exportId))?.served_at).toBeUndefined()
    // the cancel let go of its lease
    expect((await jobOf(t, exportId))?.streams).toBeUndefined()

    const parts = await partsOf(t, exportId)
    const erased = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
    expect(erased.status).toBe(200)
    await t.run((ctx) => ctx.storage.delete(parts[parts.length - 1].storage_id))
    const { bytes, error } = await drain(t, erased)
    expect(error).not.toBeNull()
    expect(bytes.length).toBeLessThan(Number(erased.headers.get('Content-Length')))
    expect((await jobOf(t, exportId))?.served_at).toBeUndefined()
    // a ready archive that lost a file is damaged, so its job fails
    expect(await jobOf(t, exportId)).toMatchObject({
      state: 'failed',
      error: { code: 'incomplete' },
    })
  })

  it('stops a download under way once its admin is demoted, before the next part', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const res = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    // the README's header
    expect((await nextChunk(t, reader)).length).toBeGreaterThan(0)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { org_role: 'user' }))
    let failed = false
    let read = 0
    try {
      for (;;) {
        const chunk = await nextChunk(t, reader)
        if (chunk.length === 0) break
        read += chunk.length
      }
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    // at most the README's bytes went out after the demotion
    const [readme] = await partsOf(t, exportId)
    expect(read).toBeLessThanOrEqual(readme.stored_bytes)
    expect((await jobOf(t, exportId))?.served_at).toBeUndefined()
  })

  it("errors a part whose file is not its stored size, though the row's figures agree", async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const parts = await partsOf(t, exportId)
    const part = parts[2]
    // the part's row, its file's metadata and the archive all say one byte
    // more than the file holds
    await t.run(async (ctx) => {
      await ctx.db.patch(part._id, { stored_bytes: part.stored_bytes + 1 })
      await ctx.db.patch(
        part.storage_id as Id<'_storage'> as never,
        {
          size: part.stored_bytes + 1,
        } as never,
      )
      const job = await byId(ctx, 'org_exports', exportId)
      if (job?.archive === undefined) throw new Error('not ready')
      await ctx.db.patch(job._id, { archive: { ...job.archive, bytes: job.archive.bytes + 1 } })
    })
    const res = await get(t, pathOf(await claim(t, f.admin, f.org.id, exportId)))
    expect(res.status).toBe(200)
    const { bytes, error } = await drain(t, res)
    expect(error).not.toBeNull()
    expect(bytes.length).toBeLessThan(Number(res.headers.get('Content-Length')))
    expect((await jobOf(t, exportId))?.served_at).toBeUndefined()
  })

  it('holds at most DELIVERY.streams downloads of an archive at once, answering 429 past them, until one ends or its lease runs out', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    const long = await mint(exportId, f.admin._id, {
      exp: Math.floor(Date.now() / 1000) + 3 * 3600,
    })
    const first = await get(t, long)
    const second = await get(t, long)
    expect([first.status, second.status]).toEqual([200, 200])
    const third = await get(t, long)
    expect(third.status).toBe(429)
    expect(third.headers.get('Retry-After')).toBe(String(DELIVERY.retrySeconds))
    expect(third.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await third.text()).toBe('')
    // one download ends, so another may start
    expect((await drain(t, first)).error).toBeNull()
    const fourth = await get(t, long)
    expect(fourth.status).toBe(200)
    expect((await get(t, long)).status).toBe(429)
    // a lease whose download never ends runs out
    vi.advanceTimersByTime(DELIVERY.streamMs + 1000)
    const fifth = await get(t, long)
    expect(fifth.status).toBe(200)
    await drain(t, fifth)
    // nothing about the archive changed for the readers that hold it
    expect((await drain(t, second)).error).toBeNull()
  })

  it('caps the downloads of the whole public demo deployment', async () => {
    const t = newT()
    const { f, exportId } = await ready(t)
    vi.stubEnv('APP_MODE', 'demo')
    await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: f.admin.auth_user_id as string,
        org_id: f.org.id,
        created_at: Date.now(),
        expires_at: Date.now() + 86_400_000,
        status: 'ready',
      }),
    )
    DELIVERY.demoStreams = 1
    const link = await mint(exportId, f.admin._id)
    const first = await get(t, link)
    expect(first.status).toBe(200)
    // the archive's own two would allow it; the deployment's one does not
    expect((await get(t, link)).status).toBe(429)
    await drain(t, first)
    const next = await get(t, link)
    expect(next.status).toBe(200)
    await drain(t, next)
  })

  it("sends a deletion's reminder after a served archive as after one only prepared", async () => {
    const prepared = newT()
    const a = await ready(prepared)
    const remove = (t: T, f: OrgFixture) =>
      t.run((ctx) =>
        scheduleRemoval(ctx, { orgId: f.org.id, reason: 'requested', endedAt: NOW_ISO() }),
      )
    await remove(prepared, a.f)
    const notices = (await deletionNotices(prepared)).length
    expect(notices).toBeGreaterThan(0)

    // a served archive says the backend read it whole, not that the client
    // received it, so it does not hold the reminder back
    const served = newT()
    const b = await ready(served)
    const res = await get(served, pathOf(await claim(served, b.f.admin, b.f.org.id, b.exportId)))
    expect((await drain(served, res)).error).toBeNull()
    expect((await jobOf(served, b.exportId))?.served_at).toBe(NOW_ISO())
    await remove(served, b.f)
    expect(await deletionNotices(served)).toHaveLength(notices)
  })

  it("answers each admin's own automatic attempt in status, never another's", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { org_role: 'admin' }))
    const user = { ...f.user, org_role: 'admin' as const }
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    await as(t, user).mutation(api.orgExport.request, { org_id: f.org.id })
    await settle(t)
    await claim(t, f.admin, f.org.id, export_id, true)
    const mine = await as(t, f.admin).query(api.orgExport.status, { org_id: f.org.id })
    const theirs = await as(t, user).query(api.orgExport.status, { org_id: f.org.id })
    expect(mine.latest).toMatchObject({
      requested: true,
      auto_download_at: NOW_ISO(),
      served_at: null,
    })
    expect(theirs.latest).toMatchObject({
      requested: true,
      auto_download_at: null,
      served_at: null,
    })
    expect(JSON.stringify(mine)).not.toMatch(/stream|storage/)
  })
})

describe("the delivery inside Convex's limits", () => {
  /* What one transaction that runs `read` read, with what it answered. */
  const measured = <R>(t: T, read: (ctx: QueryCtx) => Promise<R>) =>
    t.run(async (ctx) => {
      const answer = await read(ctx)
      const m = await ctx.meta.getTransactionMetrics()
      return {
        answer,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / 1024 / 1024) * 1000) / 1000,
      }
    })

  it('checks an archive of EXPORT_LIMITS.parts data parts in one query', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // the parts cap case's archive: every table's first file, the rest tasks
    const entries = Array.from(
      { length: EXPORT_LIMITS.parts },
      (_, i) => `data/tasks/${String(i + 1).padStart(4, '0')}.json`,
    )
    const exportId = uuid()
    // each part a file of 3 bytes and its ZIP headers, and the end record
    let bytes = ZIP_END_BYTES
    for (const entry of ['README.txt', 'manifest.json', ...entries])
      bytes += 3 + zipEntryBytes(entry)
    await t.run((ctx) =>
      ctx.db.insert('org_exports', {
        id: exportId,
        org_id: f.org.id,
        state: 'ready',
        requested_by: f.admin.id,
        started_at: NOW_ISO(),
        progress_at: NOW_ISO(),
        completed_at: NOW_ISO(),
        expires_at: new Date(Date.now() + ARCHIVE_TTL_MS).toISOString(),
        progress: { section: '', records: 0, sections_done: 26, sections_total: 26 },
        step: {
          n: 1,
          section: 26,
          cursor: null,
          part: 1,
          seq: entries.length + 2,
          bytes,
          counts: {},
        },
        attempts: 0,
        format_version: 4,
        archive: { bytes, parts: entries.length + 2 },
      }),
    )
    const all = [
      { entry: 'README.txt', kind: 'readme' as const },
      { entry: 'manifest.json', kind: 'manifest' as const },
      ...entries.map((entry) => ({ entry, kind: 'data' as const })),
    ]
    for (let from = 0; from < all.length; from += 500)
      await t.run(async (ctx) => {
        for (const [i, { entry, kind }] of all.slice(from, from + 500).entries())
          await ctx.db.insert('org_export_parts', {
            export_id: exportId,
            org_id: f.org.id,
            seq: from + i,
            entry,
            kind,
            storage_id: await ctx.storage.store(new Blob(['[]\n'])),
            raw_bytes: 3,
            stored_bytes: 3,
            crc32: 0,
            records: 0,
          })
      })
    const exp = Math.floor(Date.now() / 1000) + 1 + DELIVERY.tokenSeconds
    const read = await measured(t, (ctx) =>
      readDelivery(ctx, { export_id: exportId, minter: f.admin._id, exp }),
    )
    console.info('delivery: deliveryOf at EXPORT_LIMITS.parts data parts', {
      ranges: read.ranges,
      documents: read.documents,
      mib: read.mib,
      answer_kib: Math.round(JSON.stringify(read.answer).length / 1024),
    })
    if (read.answer === null || 'missing' in read.answer) throw new Error('not deliverable')
    expect(read.answer.parts).toHaveLength(EXPORT_LIMITS.parts + 2)
    expect(read.answer.bytes).toBe(bytes)
    expect(read.ranges).toBeLessThan(4096)
    expect(JSON.stringify(read.answer).length).toBeLessThan(1_000_000)
  })
})
