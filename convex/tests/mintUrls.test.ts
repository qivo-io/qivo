/* files.mintUrls (files.ts mintFileUrls): its caps, which refuse a call
 * whole before the handler reads anything, and its reads of each task and
 * each project's sight once a call, which answer exactly the ids one-id
 * calls answer.
 *
 * The design-size cases run the handler's body in one transaction under
 * Convex's real limits and print what it read, the figures MINT_IDS'
 * docstring quotes. Each raises one figure and keeps the others at
 * everyday values (a person in 3 teams, 20 sub-projects a team, 3
 * sub-projects a project): the people of one organization, the 100 images
 * of one task (the existing per-task limit), the teams a project is shared
 * with, the sub-projects under one project and the sub-projects one person
 * reads. The mint reads by id, so the tasks the projects hold besides the
 * ones it is asked about change nothing it reads, and no case plants them.
 * The pictures share one stored blob. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { MINT_IDS, mintFileUrls } from '../files'
import { newWindowKey } from '../lib/db'
import { MIB } from '../lib/limits'
import { SHAPES } from './accessShapes.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'

/* fileTokens reads process.env lazily; guarantee the vars exist in this VM
 * (edge-runtime may or may not carry a process global). */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.BETTER_AUTH_SECRET ??= 'test-files-secret'
g.process.env.CONVEX_SITE_URL ??= 'https://test.convex.site'

const CAPS = structuredClone(MINT_IDS)
afterEach(() => {
  Object.assign(MINT_IDS, structuredClone(CAPS))
})

/* One stored file of a few bytes, the bytes every planted row shares. */
const storeBlob = (t: T): Promise<Id<'_storage'>> =>
  t.run(async (ctx) => {
    const sid = await ctx.storage.store(new Blob([new Uint8Array(16)]) as never)
    await ctx.db.patch(sid as never, { contentType: 'image/png' } as never)
    return sid
  })

/* An attachment row of `issue` on stored file `sid`, its id. */
async function insertAttachment(
  ctx: MutationCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
  sid: Id<'_storage'>,
  i = 0,
): Promise<string> {
  const id = uuid()
  await ctx.db.insert('issue_attachments', {
    org_id: issue.org_id,
    id,
    issue_id: issue.id,
    name: `board-photo-${i}.webp`,
    size_bytes: 16,
    mime: 'image/webp',
    storage_id: sid,
    inline: true,
    created_at: NOW,
  })
  return id
}

/* `n` attachments of `issue`, their ids. */
const attach = (t: T, issue: Doc<'issues'>, sid: Id<'_storage'>, n: number): Promise<string[]> =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push(await insertAttachment(ctx, issue, sid, i))
    return ids
  })

/* The caller as the orgQuery wrapper hands it to the handler. */
const minter = (me: Doc<'profiles'>) => ({
  me,
  authUserId: me.auth_user_id ?? `login-${me.id}`,
  myProfiles: new Map([[me.org_id, me]]),
})

type Figures = { ranges: number; documents: number; mib: number; answered: number }

/* What one call's handler body read, in a transaction of its own, and how
 * many ids it answered. */
async function measure(
  t: T,
  me: Doc<'profiles'>,
  args: { attachment_ids?: string[]; profile_ids?: string[] },
): Promise<Figures> {
  return await t.run(async (ctx) => {
    const answer = await mintFileUrls(ctx, minter(me), args)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
      answered: Object.keys(answer.attachments).length + Object.keys(answer.avatars).length,
    }
  })
}

/* Checks that a call over `ids`, which name tasks of `projects` alike
 * projects, read each attachment and each task once and checked each
 * project once: what one id of them reads, an attachment, a task and one
 * project's check, for each project, and an attachment and a task for each
 * further id. */
async function expectOneCheckEach(
  t: T,
  me: Doc<'profiles'>,
  ids: string[],
  projects: number,
  f: Figures,
) {
  const one = await measure(t, me, { attachment_ids: ids.slice(0, 1) })
  expect(f.ranges).toBe(ids.length * 2 + projects * (one.ranges - 2))
}

/* Prints what a call read and checks it stays inside Convex's limits. */
function record(name: string, f: Figures) {
  console.log(`files.mintUrls figures, ${name}:`, JSON.stringify(f))
  expect(f.ranges, name).toBeLessThan(4096)
  expect(f.documents, name).toBeLessThan(32_000)
  expect(f.mib, name).toBeLessThan(16)
}

/* A team of `orgId` named `name`, with `members` in it, its id. */
async function insertTeam(
  ctx: MutationCtx,
  orgId: string,
  name: string,
  members: Doc<'profiles'>[] = [],
): Promise<string> {
  const id = uuid()
  await ctx.db.insert('teams', {
    id,
    org_id: orgId,
    name,
    track_delay_default: false,
    created_at: NOW,
  })
  for (const m of members)
    await ctx.db.insert('team_members', { team_id: id, profile_id: m.id, is_leader: false })
  return id
}

const shareWith = (ctx: MutationCtx, projectId: string, teamId: string) =>
  ctx.db.insert('project_team_access', { project_id: projectId, team_id: teamId, level: 'user' })

/** An organization of top-level projects with sub-projects under each, and
 * a plain user in 3 teams who reads them through team shares. `tops` and
 * `subs` set its shape; `shares` is how many teams share each project, the
 * caller's team among them. The caller's 3 teams share the projects in
 * turn, and the other teams share about 20 projects each. */
async function sharedOrg(o: { tops: number; subs: (top: number) => number; shares: number }) {
  const t = newT({ transactionLimits: true })
  const f = await withReadingAdmin(t)
  const caller = await plantSeat(t, { org_id: f.org.id, name: 'Member', accepted_at: NOW })
  const tops: Doc<'projects'>[] = []
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < o.tops; i++) {
    const top = await plantProject(t, { org_id: f.org.id, name: `Programme ${i}` })
    tops.push(top)
    for (let s = 0; s < o.subs(i); s++)
      subs.push(
        await plantProject(t, {
          org_id: f.org.id,
          type: 'project',
          parent_id: top.id,
          name: `Workstream ${i}.${s}`,
        }),
      )
  }
  await t.run(async (ctx) => {
    const mine: string[] = []
    for (let i = 0; i < 3; i++) mine.push(await insertTeam(ctx, f.org.id, `Team ${i}`, [caller]))
    const projects = [...tops, ...subs]
    const others: string[] = []
    const otherShares = projects.length * (o.shares - 1)
    for (let i = 0; i < Math.ceil(otherShares / 20); i++)
      others.push(await insertTeam(ctx, f.org.id, `Other ${i}`))
    let next = 0
    for (const [i, project] of projects.entries()) {
      await shareWith(ctx, project.id, mine[i % mine.length] as string)
      for (let s = 1; s < o.shares; s++)
        await shareWith(ctx, project.id, others[next++ % others.length] as string)
    }
  })
  return { t, f, caller, tops, subs }
}

/* One task in each of `projects`, in turn, until there are `n` tasks, and
 * one attachment on each, the attachments' ids. */
async function spread(t: T, projects: Doc<'projects'>[], n: number, sid: Id<'_storage'>) {
  return await t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const project = projects[i % projects.length] as Doc<'projects'>
      const task = {
        id: uuid(),
        org_id: project.org_id,
        project_id: project.id,
        num: 3_000_000 + i,
        title: `Check the power rails of board ${i} before the firmware team flashes it`,
        status: 'todo' as const,
        priority: 'medium' as const,
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        window_key: newWindowKey(),
      }
      await ctx.db.insert('issues', task)
      ids.push(await insertAttachment(ctx, task, sid, i))
    }
    return ids
  })
}

describe('files.mintUrls caps', () => {
  it('refuses more than 100 attachment ids or 1,000 profile ids whole, naming the array, before the handler reads anything', async () => {
    const t = newT({ transactionLimits: true })
    const fx = await withReadingAdmin(t)
    const tooMany = { attachment_ids: Array.from({ length: 101 }, uuid) }
    await expect(
      as(t, fx.user).query(api.files.mintUrls, { org_id: fx.org.id, ...tooMany }),
    ).rejects.toThrow('attachment_ids must name at most 100 attachments')
    await expect(
      as(t, fx.user).query(api.files.mintUrls, {
        org_id: fx.org.id,
        profile_ids: Array.from({ length: 1001 }, uuid),
      }),
    ).rejects.toThrow('profile_ids must name at most 1000 profiles')
    // a repeated id counts as sent, since the cap is on the array
    await expect(
      as(t, fx.user).query(api.files.mintUrls, {
        org_id: fx.org.id,
        attachment_ids: Array.from({ length: 101 }, () => tooMany.attachment_ids[0] as string),
      }),
    ).rejects.toThrow('attachment_ids must name at most 100 attachments')
    await expect(
      as(t, fx.user).query(api.files.mintUrls, {
        org_id: fx.org.id,
        attachment_ids: Array.from({ length: 101 }, () => uuid().slice(0, 8)),
      }),
    ).rejects.toThrow('attachment_ids must name at most 100 attachments')
    // the refused body read nothing at all
    for (const args of [tooMany, { profile_ids: Array.from({ length: 1001 }, uuid) }]) {
      const read = await t.run(async (ctx) => {
        await expect(mintFileUrls(ctx, minter(fx.user), args)).rejects.toThrow('must name at most')
        const m = await ctx.meta.getTransactionMetrics()
        return { ranges: m.databaseQueries.used, documents: m.documentsRead.used }
      })
      expect(read).toEqual({ ranges: 0, documents: 0 })
    }
  })

  it('answers absent and empty arrays empty, and both kinds at their caps in one call', async () => {
    const t = newT()
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
    const atts = await attach(t, issue, sid, 3)
    await t.run(async (ctx) => {
      for (const p of [fx.admin, fx.user, fx.viewer, fx.guest])
        await ctx.db.patch(p._id, { avatar_storage_id: sid })
    })
    const ask = (args: { attachment_ids?: string[]; profile_ids?: string[] }) =>
      as(t, fx.user).query(api.files.mintUrls, { org_id: fx.org.id, ...args })
    expect(await ask({})).toEqual({ attachments: {}, avatars: {} })
    expect(await ask({ attachment_ids: [], profile_ids: [] })).toEqual({
      attachments: {},
      avatars: {},
    })
    // lowered caps stand in for 100 and 1,000, so no case holds two
    // figures at their design size
    MINT_IDS.attachments = 3
    MINT_IDS.profiles = 4
    const people = [fx.admin, fx.user, fx.viewer, fx.guest].map((p) => p.id)
    const both = await ask({ attachment_ids: atts, profile_ids: people })
    expect(Object.keys(both.attachments).sort()).toEqual([...atts].sort())
    expect(Object.keys(both.avatars).sort()).toEqual([...people].sort())
    await expect(ask({ attachment_ids: [...atts, uuid()], profile_ids: people })).rejects.toThrow(
      'attachment_ids must name at most 3 attachments',
    )
    await expect(ask({ attachment_ids: atts, profile_ids: [...people, uuid()] })).rejects.toThrow(
      'profile_ids must name at most 4 profiles',
    )
  })
})

describe('files.mintUrls reads shared within a call', () => {
  it('answers a batch exactly as one-id calls answer, for every grant shape, as a guest, a viewer, a user and an admin', async () => {
    const seen = new Set<string>()
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f: OrgFixture = await withReadingAdmin(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      const sid = await storeBlob(t)
      // a project whose parent is gone, which canSeeProject refuses
      const broken = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: uuid(),
      })
      const ids: string[] = []
      for (const project of [f.meta, f.sub, f.sub2, f.hidden, broken, f.otherProject]) {
        const issue = await plantIssue(t, { org_id: project.org_id, project_id: project.id })
        ids.push(...(await attach(t, issue, sid, 2)))
      }
      // an attachment whose task is gone, and an id nobody holds
      ids.push(
        await t.run((ctx) => insertAttachment(ctx, { id: uuid(), org_id: f.org.id }, sid)),
        uuid(),
      )
      await t.run(async (ctx) => {
        for (const org_role of ['guest', 'viewer', 'user', 'admin'] as const) {
          const me = { ...subject, org_role }
          const batch = await mintFileUrls(ctx, minter(me), { attachment_ids: ids })
          const one: string[] = []
          for (const id of ids)
            one.push(
              ...Object.keys(
                (await mintFileUrls(ctx, minter(me), { attachment_ids: [id] })).attachments,
              ),
            )
          expect(Object.keys(batch.attachments).sort(), `${name}, as ${org_role}`).toEqual(
            one.sort(),
          )
          // never the gone task's, the unknown id, another organization's or
          // the broken project's
          expect(
            one.every((id) => ids.indexOf(id) < 8),
            `${name}, as ${org_role}`,
          ).toBe(true)
          seen.add(`${org_role}:${one.length}`)
        }
      })
    }
    // the shapes reach callers who see nothing, some and everything
    expect([...seen].some((s) => s.endsWith(':0'))).toBe(true)
    // and an admin sees what a user with the same rows sees, no more
    const of = (role: string) =>
      [...seen].filter((s) => s.startsWith(`${role}:`)).map((s) => s.split(':')[1])
    expect(of('admin').sort()).toEqual(of('user').sort())
    expect([...seen].some((s) => /:(2|4|6)$/.test(s))).toBe(true)
  })

  it('answers each caller their own files when two ask in turn', async () => {
    const t = newT()
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    const shown = await attach(
      t,
      await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id }),
      sid,
      1,
    )
    const hidden = await attach(
      t,
      await plantIssue(t, { org_id: fx.org.id, project_id: fx.hidden.id }),
      sid,
      1,
    )
    const ask = (p: Doc<'profiles'>) =>
      as(t, p)
        .query(api.files.mintUrls, { org_id: fx.org.id, attachment_ids: [...hidden, ...shown] })
        .then((r) => Object.keys(r.attachments).sort())
    for (const order of [
      [fx.admin, fx.guest],
      [fx.guest, fx.admin],
    ])
      for (const p of order)
        expect(await ask(p), p.name).toEqual(
          p === fx.admin ? [...hidden, ...shown].sort() : [...shown],
        )
  })

  it('omits a broken project’s files and answers the visible ones beside them', async () => {
    const t = newT()
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    const broken = await plantProject(t, { org_id: fx.org.id, type: 'project', parent_id: uuid() })
    const lost = await attach(
      t,
      await plantIssue(t, { org_id: fx.org.id, project_id: broken.id }),
      sid,
      2,
    )
    const shown = await attach(
      t,
      await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id }),
      sid,
      2,
    )
    const minted = await as(t, fx.admin).query(api.files.mintUrls, {
      org_id: fx.org.id,
      attachment_ids: [...lost, ...shown],
    })
    expect(Object.keys(minted.attachments).sort()).toEqual([...shown].sort())
  })

  it('omits an attachment of another organization before it reads its task', async () => {
    const t = newT({ transactionLimits: true })
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    const issue = await plantIssue(t, { org_id: fx.org.id, project_id: fx.sub.id })
    // a row that names this organization's task under another organization
    const foreign = await t.run((ctx) =>
      insertAttachment(ctx, { id: issue.id, org_id: fx.otherOrg.id }, sid),
    )
    const f = await measure(t, fx.admin, { attachment_ids: [foreign] })
    expect(f).toMatchObject({ answered: 0, ranges: 1 })
  })

  it('answers pictures of its own row, its organization and the login’s other organizations, and omits the rest', async () => {
    const t = newT()
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    // the guest's login also holds a seat in the other organization
    const elsewhere = await plantSeat(t, {
      org_id: fx.otherOrg.id,
      auth_user_id: fx.guest.auth_user_id,
      name: 'guest',
      accepted_at: NOW,
    })
    const stranger = await plantSeat(t, { org_id: uuid(), name: 'Stranger', accepted_at: NOW })
    await t.run(async (ctx) => {
      for (const p of [fx.guest, fx.admin, fx.otherAdmin, elsewhere, stranger])
        await ctx.db.patch(p._id, { avatar_storage_id: sid })
    })
    const minted = await as(t, fx.guest).query(api.files.mintUrls, {
      org_id: fx.org.id,
      profile_ids: [fx.guest.id, fx.admin.id, fx.user.id, fx.otherAdmin.id, stranger.id, uuid()],
    })
    // fx.user has no picture, the stranger's organization holds no seat of
    // this login and the last id is unknown
    expect(Object.keys(minted.avatars).sort()).toEqual(
      [fx.guest.id, fx.admin.id, fx.otherAdmin.id].sort(),
    )
  })
})

describe('files.mintUrls reads at the design size', () => {
  it('reads 1,000 profile ids of an organization of 1,000 people, each with a picture, the older app’s call', async () => {
    const t = newT({ transactionLimits: true })
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    const fixture = [fx.admin, fx.user, fx.viewer, fx.guest, fx.agent]
    const ids = await t.run(async (ctx) => {
      for (const p of fixture) await ctx.db.patch(p._id, { avatar_storage_id: sid })
      const out = fixture.map((p) => p.id)
      for (let i = out.length; i < 1000; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: fx.org.id,
          name: `Person ${i}`,
          initials: 'PE',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
          avatar_storage_id: sid,
        })
        out.push(id)
      }
      return out
    })
    const f = await measure(t, fx.user, { profile_ids: ids })
    record('1,000 profile ids', f)
    expect(f.answered).toBe(1000)
    const chunk = await measure(t, fx.user, { profile_ids: ids.slice(0, 100) })
    record('100 profile ids, the app’s chunk', chunk)
    expect(chunk.answered).toBe(100)
  })

  it('reads 100 images of one task once for its task and project, as a user and as an admin with a team grant', async () => {
    const e = await sharedOrg({ tops: 20, subs: () => 3, shares: 1 })
    const sid = await storeBlob(e.t)
    const issue = await plantIssue(e.t, {
      org_id: e.f.org.id,
      project_id: (e.subs[0] as Doc<'projects'>).id,
    })
    const ids = await attach(e.t, issue, sid, 100)
    for (const [who, me] of [
      ['a user with a team grant', e.caller],
      [
        'an organization admin with the same team grant',
        { ...e.caller, org_role: 'admin' as const },
      ],
    ] as const) {
      const all = await measure(e.t, me, { attachment_ids: ids })
      record(`100 images of one task, ${who}`, all)
      expect(all.answered).toBe(100)
      // one task read and one access check a call: each further id adds
      // only its own attachment read
      const one = await measure(e.t, me, { attachment_ids: ids.slice(0, 1) })
      expect(all.ranges - one.ranges, who).toBe(99)
    }
  })

  it('reads 100 attachments over the everyday 60 sub-projects, each and its top-level project shared with 5 teams', async () => {
    const e = await sharedOrg({ tops: 20, subs: () => 3, shares: 5 })
    const ids = await spread(e.t, e.subs, 100, await storeBlob(e.t))
    const f = await measure(e.t, e.caller, { attachment_ids: ids })
    record('100 attachments over 60 sub-projects shared with 5 teams', f)
    expect(f.answered).toBe(100)
    await expectOneCheckEach(e.t, e.caller, ids, 60, f)
  })

  it('reads 100 attachments over 30 sub-projects under one top-level project', async () => {
    const e = await sharedOrg({ tops: 11, subs: (i) => (i === 0 ? 30 : 3), shares: 1 })
    const under = e.subs.slice(0, 30)
    const ids = await spread(e.t, under, 100, await storeBlob(e.t))
    const f = await measure(e.t, e.caller, { attachment_ids: ids })
    record('100 attachments over 30 sub-projects under one project', f)
    expect(f.answered).toBe(100)
    await expectOneCheckEach(e.t, e.caller, ids, 30, f)
  })

  it('reads 100 attachments over 100 sub-projects the caller reads, 3 under each top-level project', async () => {
    const e = await sharedOrg({ tops: 34, subs: (i) => (i === 33 ? 1 : 3), shares: 1 })
    expect(e.subs.length).toBe(100)
    const ids = await spread(e.t, e.subs, 100, await storeBlob(e.t))
    const f = await measure(e.t, e.caller, { attachment_ids: ids })
    record('100 attachments over 100 sub-projects', f)
    expect(f.answered).toBe(100)
    await expectOneCheckEach(e.t, e.caller, ids, 100, f)
  })

  it('walks a legacy top-level task’s navigation once a call for its 100 images', async () => {
    const t = newT({ transactionLimits: true })
    const fx = await withReadingAdmin(t)
    const sid = await storeBlob(t)
    const caller = await plantSeat(t, { org_id: fx.org.id, name: 'Member', accepted_at: NOW })
    // a top-level project of everyday sub-projects, the caller seeing it
    // only for navigation, through a grant on its last sub-project
    const top = await plantProject(t, { org_id: fx.org.id, name: 'Legacy programme' })
    let last: Doc<'projects'> | null = null
    for (let s = 0; s < 3; s++)
      last = await plantProject(t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: top.id,
        name: `Workstream ${s}`,
      })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: (last as Doc<'projects'>).id,
        profile_id: caller.id,
        level: 'user',
      }),
    )
    const legacy = await plantIssue(t, { org_id: fx.org.id, project_id: top.id })
    const ids = await attach(t, legacy, sid, 100)
    const all = await measure(t, caller, { attachment_ids: ids })
    record('100 images of a legacy task on a top-level project', all)
    expect(all.answered).toBe(100)
    const one = await measure(t, caller, { attachment_ids: ids.slice(0, 1) })
    expect(all.ranges - one.ranges).toBe(99)
  })
})
