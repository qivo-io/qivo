/* The fixtures and helpers of the project navigation suites
 * (projectNav.test.ts and projectNavSearch.test.ts): seats as the readers
 * take them, calls of the readers under test, the planting of projects,
 * grants, shares, teams and stars, the readiness every deployment holds,
 * and the measuring of what one call reads. The rule the readers are held
 * to is worked out apart from them, in projectNav.setup.ts. Two dots in
 * the basename keep the Convex CLI from deploying this module, as
 * helpers.setup.ts. */

import { ConvexError } from 'convex/values'
import { expect } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId, newWindowKey } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { openNamedCursor } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import {
  type NavBatch,
  type NavCursorArgs,
  type NavRefusal,
  type NavResolveArgs,
  navChildrenOf,
  navPageOf,
  navResolveOf,
  PAGE_LIST,
} from '../model/projectNavReads'
import { NOW, type OrgFixture, plantSeat, type T, uuid } from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { withReach } from './projectReach.setup'

export type Seats = readonly Doc<'profiles'>[]

/** A login's active seats by organization, as lib/functions.ts myProfiles. */
export const mapOf = (seats: Seats) => new Map(seats.map((seat) => [seat.org_id, seat]))

export const page = (t: T, seats: Seats, a: NavCursorArgs = {}) =>
  t.run((ctx) => navPageOf(ctx, mapOf(seats), a))

export const kids = (t: T, seats: Seats, project_id: string, a: NavCursorArgs = {}) =>
  t.run((ctx) => navChildrenOf(ctx, mapOf(seats), { project_id, ...a }))

export const resolved = (t: T, seats: Seats, a: NavResolveArgs) =>
  t.run((ctx) => navResolveOf(ctx, mapOf(seats), a))

/** The batch `answer` holds, failing unless it holds one. */
export function ok<R>(answer: NavBatch<R> | NavRefusal): NavBatch<R> {
  if (answer.state !== 'ok') throw new Error(`not a batch: ${JSON.stringify(answer)}`)
  return answer
}

/** Every batch of a list from its start, following `next`. */
export async function walk<R>(
  read: (after?: string) => Promise<NavBatch<R> | NavRefusal>,
  most = 60,
) {
  const rows: R[] = []
  const batches: NavBatch<R>[] = []
  let after: string | undefined
  for (let round = 0; round < most; round++) {
    const batch = ok(await read(after))
    batches.push(batch)
    rows.push(...batch.rows)
    if (batch.next === null) return { rows, batches }
    after = batch.next
  }
  throw new Error('the list did not end')
}

/* Distinct numbers and keys for the projects these suites plant. */
let planted = 5000

/** Top-level metas of `orgId`, one for each name, planted raw with `extra`,
 * in order. Their name keys and archive states come from ready. */
export const plantMetas = (
  t: T,
  orgId: string,
  names: readonly string[],
  extra: Partial<Doc<'projects'>> = {},
): Promise<Doc<'projects'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'projects'>[] = []
    for (const name of names) {
      const n = planted++
      const _id = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: orgId,
        type: 'meta',
        key: n.toString(36).toUpperCase(),
        name,
        description: '',
        sort_order: n,
        num: n,
        track_delay: false,
        created_at: NOW,
        window_key: newWindowKey(),
        ...extra,
      })
      out.push((await ctx.db.get(_id)) as Doc<'projects'>)
    }
    return out
  })

/** Sub-projects of `parent`, one for each name, planted raw. */
export const plantSubs = (
  t: T,
  parent: Doc<'projects'>,
  names: readonly string[],
  extra: Partial<Doc<'projects'>> = {},
) => plantMetas(t, parent.org_id, names, { type: 'project', parent_id: parent.id, ...extra })

/** User grants of `seat` on `projects`, planted raw. */
export const plantGrants = (
  t: T,
  seat: Doc<'profiles'>,
  projects: readonly Doc<'projects'>[],
  level: 'user' | 'viewer' = 'user',
) =>
  t.run(async (ctx) => {
    for (const p of projects)
      await ctx.db.insert('project_access', { project_id: p.id, profile_id: seat.id, level })
  })

/** Team shares of `teamId` on `projects`, planted raw. */
export const plantShares = (t: T, teamId: string, projects: readonly Doc<'projects'>[]) =>
  t.run(async (ctx) => {
    for (const p of projects)
      await ctx.db.insert('project_team_access', {
        project_id: p.id,
        team_id: teamId,
        level: 'user',
      })
  })

/** A team of `orgId` with `members`, planted raw, and its id. */
export const plantTeam = (t: T, orgId: string, name: string, members: Seats = []) =>
  t.run(async (ctx) => {
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
  })

/** A favorites row of `seat` on `p` with its copies, as a star writes it,
 * and `fields` over it. */
export const plantStar = (
  t: T,
  seat: Doc<'profiles'>,
  p: Doc<'projects'>,
  fields: Partial<Doc<'project_favorites'>> = {},
) =>
  t.run((ctx) =>
    ctx.db.insert('project_favorites', {
      org_id: seat.org_id,
      profile_id: seat.id,
      project_id: p.id,
      name_key: nameKey(p.name),
      live: p.archived_at === undefined,
      created_at: NOW,
      ...fields,
    }),
  )

/** A person of `orgId` who can call as(), planted raw. */
export const person = (t: T, orgId: string, name: string, extra: Partial<Doc<'profiles'>> = {}) =>
  plantSeat(t, { org_id: orgId, name, auth_user_id: `auth_${uuid()}`, ...extra })

/** Names `prefix` 000 to `prefix` n-1, in the order they sort. */
export const names = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

/** The name keys, archive states and reach rows of every organization, as
 * on every deployment. Call after the last project, grant or share a case
 * plants raw. */
export async function ready(t: T, f: Pick<OrgFixture, 'org' | 'otherOrg'>): Promise<void> {
  await keyOrg(t, f.org.id)
  await keyOrg(t, f.otherOrg.id)
  await withReach(t)
}

/** `p` as a navigation row. */
export const row = (p: Doc<'projects'>) => ({
  id: p.id,
  org_id: p.org_id,
  name: p.name,
  num: p.num,
})

/** The project with id `id` as it is stored now. */
export const now = (t: T, id: string) =>
  t.run(async (ctx) => {
    const p = await byId(ctx, 'projects', id)
    if (p === null) throw new Error(`no project ${id}`)
    return p
  })

/** The refusal `promise` rejects with, failing unless it is a bad_request. */
export async function badRequest(promise: Promise<unknown>): Promise<string> {
  const e = await promise.then(
    () => null,
    (error: unknown) => error,
  )
  if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
  const data = e.data as Refusal
  expect(data.code).toBe('bad_request')
  return data.message
}

/** What one transaction read, from Convex's metrics. */
export type Read = { ranges: number; documents: number; bytes: number }

/** `run` in its own transaction, with what that transaction read. */
export async function measured<R>(
  t: T,
  run: (ctx: QueryCtx) => Promise<R>,
): Promise<{ out: R; read: Read }> {
  return await t.run(async (ctx) => {
    const out = await run(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      out,
      read: {
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      },
    }
  })
}

/** Every batch of a list from its start, each measured. */
export async function measuredWalk<R>(
  t: T,
  read: (ctx: QueryCtx, after?: string) => Promise<NavBatch<R> | NavRefusal>,
) {
  const calls: (Read & { rows: number; stopped: boolean })[] = []
  const rows: R[] = []
  let after: string | undefined
  for (let round = 0; round < 60; round++) {
    const { out, read: r } = await measured(t, (ctx) => read(ctx, after))
    const batch = ok(out)
    calls.push({ ...r, rows: batch.rows.length, stopped: batch.stopped })
    rows.push(...batch.rows)
    if (batch.next === null) return { calls, rows }
    after = batch.next
  }
  throw new Error('the list did not end')
}

/** The position `cursor` of the page seals, opened. */
export const pageAt = (cursor: string | null) =>
  cursor === null ? Promise.resolve(null) : openNamedCursor(cursor, PAGE_LIST, [])
