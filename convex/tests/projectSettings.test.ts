/* A project's Settings page read from the server (projectSettings.ts,
 * through model/projectSettings.ts): the one gate, which answers the same
 * `unavailable` for every project the caller cannot reach; get's fields and
 * rights, each right checked against its write's own rule over every grant
 * shape and role and against the write itself in a covering set; the Users
 * and Teams lists and the two pickers in name order a batch at a time, with
 * search, cursors, readiness and the rows they leave out; and the invite
 * form's lookup. The last suite runs the reads at scale under Convex's
 * transaction limits and logs what each call read. */

import { ConvexError, compareValues } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  ACCESS_NEEDS_A_PERSON,
  canChangeAccess,
  canManageProjectTeams,
  canManageProjectUsers,
  canSeeProject,
  hasProjectLevel,
  NO_USER_MANAGEMENT,
  projectLevel,
} from '../lib/access'
import { newWindowKey } from '../lib/db'
import { DEMO_FEATURE_REFUSAL } from '../lib/demo'
import { type GrantLevel, ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { DEFAULT_REVIEW_HOURS } from '../lib/review'
import { insertTask } from '../model/descriptions'
import { setProjectGrantCore } from '../model/projectAccess'
import {
  candidatesOf,
  inviteTargetOf,
  type ListBatch,
  leadCandidatesOf,
  type ProjectSettings,
  projectSettingsOf,
  projectUsersOf,
  type SettingsRights,
  UNKEYED_MOST,
} from '../model/projectSettings'
import {
  LEAD_ACCESS_NEEDED,
  PARENT_ARCHIVED,
  PARENT_NOT_TOP_LEVEL,
  updateProjectCore,
} from '../model/projects'
import { SHAPES } from './accessShapes.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'project-settings-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_UNKEYED = { ...UNKEYED_MOST }
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(UNKEYED_MOST, DEFAULT_UNKEYED)
  vi.unstubAllEnvs()
})

/* --------------------------------------------------------------- fixtures */

/** A person of the fixture's organization with a login and its name key,
 * planted raw. */
const seat = (t: T, f: OrgFixture, name: string, extra: Partial<Doc<'profiles'>> = {}) =>
  plantSeat(t, {
    org_id: f.org.id,
    name,
    name_key: nameKey(name),
    auth_user_id: `auth_${uuid()}`,
    ...extra,
  })

/** A grant of `profileId` on `project` with the copy of key `name_key`. */
const grant = (
  t: T,
  project: Doc<'projects'>,
  profileId: string,
  name_key: string,
  level: GrantLevel = 'user',
) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: project.id,
      profile_id: profileId,
      level,
      name_key,
    }),
  )

/** A team of organization `orgId` with its key, planted raw. */
async function team(t: T, orgId: string, name: string): Promise<Doc<'teams'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('teams', {
      id: uuid(),
      org_id: orgId,
      name,
      name_key: nameKey(name),
      track_delay_default: false,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'teams'>
  })
}

/** A share of `teamId` on `project` with the copy of key `name_key`. */
const share = (
  t: T,
  project: Doc<'projects'>,
  teamId: string,
  name_key: string,
  level: GrantLevel = 'user',
) =>
  t.run((ctx) =>
    ctx.db.insert('project_team_access', {
      project_id: project.id,
      team_id: teamId,
      level,
      name_key,
    }),
  )

/** A top-level project of the fixture's organization led by `lead`. */
const meta = (t: T, f: OrgFixture, lead?: Doc<'profiles'>) =>
  plantProject(t, { org_id: f.org.id, type: 'meta', lead_id: lead?.id })

/** `n` names that sort in the order given, `prefix00`, `prefix01`, …, with
 * as many digits as the last needs. */
const names = (prefix: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}${String(i).padStart(Math.max(2, String(n - 1).length), '0')}`,
  )

/** People named `names`, keyed, each with a grant on `project`, in one
 * transaction. */
async function grantees(
  t: T,
  f: OrgFixture,
  project: Doc<'projects'>,
  all: readonly string[],
): Promise<Doc<'profiles'>[]> {
  return await t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (const name of all) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.org.id,
        name,
        name_key: nameKey(name),
        initials: 'GR',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        auth_user_id: `auth_${uuid()}`,
        created_at: NOW,
      })
      const p = (await ctx.db.get(_id)) as Doc<'profiles'>
      await ctx.db.insert('project_access', {
        project_id: project.id,
        profile_id: p.id,
        level: 'user',
        name_key: p.name_key,
      })
      out.push(p)
    }
    return out
  })
}

/** People of the fixture's organization named `all`, keyed, planted 1,000 a
 * transaction, each with a grant on `project` when `granted` says so. */
async function plantPeople(
  t: T,
  f: OrgFixture,
  all: readonly string[],
  o: { project?: Doc<'projects'>; granted?: (i: number) => boolean; active?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; from < all.length; from += 1000) {
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(all.length, from + 1000); i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: all[i],
          name_key: nameKey(all[i]),
          initials: 'PP',
          color: '#7a7ad0',
          email: `${id}@example.se`,
          org_role: 'user',
          active: o.active ?? true,
          kind: 'person',
          auth_user_id: `auth_${id}`,
          plannable_hours: 40,
          created_at: NOW,
        })
        if (o.project !== undefined && (o.granted?.(i) ?? true))
          await ctx.db.insert('project_access', {
            project_id: o.project.id,
            profile_id: id,
            level: 'user',
            name_key: nameKey(all[i]),
          })
      }
    })
  }
  return ids
}

/** The row the lists show for `p`. */
const personOf = (p: Doc<'profiles'>) => ({
  id: p.id,
  name: p.name,
  org_role: p.org_role,
  kind: p.kind,
  active: p.active,
  pending: p.kind === 'person' && p.auth_user_id === undefined,
})

/** The grant choices the lists show for `p`. */
const choices = (p: Doc<'profiles'>) => ({
  levels: p.org_role === 'viewer' ? ['viewer'] : ['user', 'viewer'],
  can_lead: p.active && p.org_role !== 'viewer',
})

type ListArgs = { search?: string; after?: string; through?: string }

const read = {
  get: (t: T, who: Doc<'profiles'>, id: string) =>
    as(t, who).query(api.projectSettings.get, { id }),
  users: (t: T, who: Doc<'profiles'>, project_id: string, a: ListArgs = {}) =>
    as(t, who).query(api.projectSettings.users, { org_id: who.org_id, project_id, ...a }),
  teams: (t: T, who: Doc<'profiles'>, project_id: string, a: ListArgs = {}) =>
    as(t, who).query(api.projectSettings.teams, { org_id: who.org_id, project_id, ...a }),
  candidates: (
    t: T,
    who: Doc<'profiles'>,
    a: ListArgs & { project_id?: string; lead_id?: string } = {},
  ) => as(t, who).query(api.projectSettings.candidates, { org_id: who.org_id, ...a }),
  leadCandidates: (
    t: T,
    who: Doc<'profiles'>,
    a: ListArgs & { project_id?: string; parent_id?: string } = {},
  ) => as(t, who).query(api.projectSettings.leadCandidates, { org_id: who.org_id, ...a }),
  inviteTarget: (t: T, who: Doc<'profiles'>, project_id: string, email: string) =>
    as(t, who).query(api.projectSettings.inviteTarget, { org_id: who.org_id, project_id, email }),
}

/** The batch `answer` holds, failing unless it is one. */
function ready<B extends { state: string }>(answer: B): Extract<B, { state: 'ready' }> {
  if (answer.state !== 'ready') throw new Error(`expected a batch, got ${JSON.stringify(answer)}`)
  return answer as Extract<B, { state: 'ready' }>
}

/** Every batch of a list from its start, following `next` until it is null. */
async function walk<R>(
  readOne: (after?: string) => Promise<{ state: string } & Partial<ListBatch<R>>>,
): Promise<ListBatch<R>[]> {
  const out: ListBatch<R>[] = []
  let after: string | undefined
  for (let round = 0; round < 1_000; round++) {
    const batch = ready(await readOne(after)) as unknown as ListBatch<R>
    out.push(batch)
    if (batch.next === null) return out
    after = batch.next
  }
  throw new Error('the list did not end')
}

/** The ids of the rows of `batches`, in order. */
const idsOf = (batches: readonly { rows: { id: string }[] }[]) =>
  batches.flatMap((b) => b.rows.map((row) => row.id))

/** `refusal`'s data, failing unless the call threw a refusal with `code`. */
async function refusal(call: Promise<unknown>, code: string): Promise<string> {
  try {
    await call
  } catch (e) {
    if (!(e instanceof ConvexError)) throw e
    expect((e.data as { code: string }).code).toBe(code)
    return (e.data as { message: string }).message
  }
  throw new Error(`expected a ${code} refusal`)
}

/* --------------------------------------------------------------- the gate */

describe('the gate', () => {
  it('answers every project the caller cannot reach exactly as an unknown id, in every function', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a legacy top-level project that is not a meta, granted to the guest
    const legacy = await plantProject(t, { org_id: f.org.id, type: 'project' })
    // a sub-project of a sub-project whose top-level row is gone
    const gone = await meta(t, f, f.user)
    const middle = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: gone.id })
    const deep = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: middle.id })
    await t.run((ctx) => ctx.db.delete(gone._id))
    // a row that is its own parent
    const loopId = uuid()
    const loop = await plantProject(t, {
      id: loopId,
      org_id: f.org.id,
      type: 'project',
      parent_id: loopId,
    })
    // a sub-project moved to Deleted items
    const trashed = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
    })
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: trashed.id })
    for (const p of [legacy, middle, deep, loop])
      await grant(t, p, f.guest.id, nameKey(f.guest.name))
    await keyOrg(t, f.org.id)
    // every function a caller names a project in, for `id`
    const all = async (who: Doc<'profiles'>, id: string) => ({
      get: await read.get(t, who, id),
      users: await read.users(t, who, id),
      teams: await read.teams(t, who, id),
      candidates: await read.candidates(t, who, { project_id: id }),
      lead: await read.leadCandidates(t, who, { project_id: id }),
      parent: await read.leadCandidates(t, who, { parent_id: id }),
      invite: await read.inviteTarget(t, who, id, 'anyone@testbed.test'),
    })
    const unknown = await all(f.admin, uuid())
    expect(Object.values(unknown).every((a) => a.state === 'unavailable')).toBe(true)
    // the admin, who manages every project of a meta tree, and the guest,
    // who holds a grant on each of the rows outside one
    for (const who of [f.admin, f.guest]) {
      for (const p of [f.otherProject, legacy, middle, deep, loop, trashed]) {
        expect(await all(who, p.id), `${who.name}: ${p.key}`).toEqual(unknown)
      }
    }
    // a project the caller can neither see nor manage
    expect(await all(f.guest, f.hidden.id)).toEqual(unknown)
    expect(await all(f.viewer, f.hidden.id)).toEqual(unknown)
    // and the guest reaches what the fixture grants them
    expect((await all(f.guest, f.meta.id)).get.state).toBe('ok')
  })

  it('answers archived, with names only, for an archived project the caller sees, and unavailable for one they cannot', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.sub2._id, { archived_at: NOW })
      await ctx.db.patch(f.hidden._id, { archived_at: NOW })
    })
    await keyOrg(t, f.org.id)
    expect(await read.get(t, f.guest, f.sub2.id)).toEqual({
      state: 'archived',
      project: {
        id: f.sub2.id,
        org_id: f.org.id,
        key: f.sub2.key,
        num: f.sub2.num,
        name: f.sub2.name,
        type: 'project',
      },
      parent: { id: f.meta.id, name: f.meta.name, key: f.meta.key, num: f.meta.num },
    })
    for (const answer of [
      await read.users(t, f.guest, f.sub2.id),
      await read.teams(t, f.guest, f.sub2.id),
      await read.candidates(t, f.admin, { project_id: f.sub2.id }),
      await read.leadCandidates(t, f.admin, { project_id: f.sub2.id }),
      await read.inviteTarget(t, f.admin, f.sub2.id, 'guest@testbed.test'),
    ])
      expect(answer).toEqual({ state: 'archived' })
    expect(await read.get(t, f.guest, f.hidden.id)).toEqual({ state: 'unavailable' })
    expect((await read.get(t, f.admin, f.hidden.id)).state).toBe('archived')
  })

  it("resolves a project with the caller's seat in its own organization, a guest seat included", async () => {
    const t = newT()
    const f = await withOrg(t)
    // the user's login also holds a guest seat in the other organization
    const guestSeat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'user',
      org_role: 'guest',
      auth_user_id: f.user.auth_user_id,
    })
    await grant(t, f.otherProject, guestSeat.id, 'user')
    const answer = await read.get(t, f.user, f.otherProject.id)
    expect(answer).toMatchObject({ state: 'ok', level: 'user', can_edit: false })
    // the admin of this organization holds no seat there
    expect(await read.get(t, f.admin, f.otherProject.id)).toEqual({ state: 'unavailable' })
  })
})

/* -------------------------------------------------------------------- get */

describe('projectSettings.get', () => {
  it('answers the stored fields, the parent, the effective lead and the review time an empty field means', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.meta._id, { review_hours: 5, description: 'Platform' })
      await ctx.db.patch(f.sub2._id, { lead_id: f.guest.id, review_hours: 3 })
    })
    const settings = (id: string) => read.get(t, f.admin, id)
    const tbed = await settings(f.meta.id)
    expect(tbed).toEqual({
      state: 'ok',
      project: {
        id: f.meta.id,
        org_id: f.org.id,
        key: 'TBED',
        num: f.meta.num,
        name: f.meta.name,
        type: 'meta',
        description: 'Platform',
        track_delay: false,
        review_hours: 5,
        lead_id: f.user.id,
      },
      parent: null,
      inherited_review_hours: DEFAULT_REVIEW_HOURS,
      lead: { ...personOf(f.user), inherited: false },
      // The admin access split makes an admin's level their ordinary one,
      // projectLevel of internal/adminAccessReport.ts ordinaryOf(admin),
      // here null; no right below changes with it.
      level: 'lead',
      can_edit: true,
      can_change_lead: true,
      can_manage_users: true,
      can_manage_teams: true,
      can_invite: true,
      can_archive: true,
      can_delete: true,
      can_create_sub_project: true,
    })
    // a legacy sub-project without a lead of its own: the stored lead_id is
    // null, the lead its parent's, and an empty review time its parent's
    expect(await settings(f.sub.id)).toMatchObject({
      state: 'ok',
      project: { lead_id: null, review_hours: null, type: 'project' },
      parent: { id: f.meta.id, name: f.meta.name, key: 'TBED', num: f.meta.num },
      inherited_review_hours: 5,
      lead: { ...personOf(f.user), inherited: true },
      can_create_sub_project: false,
    })
    // a sub-project with a lead and a review time of its own
    expect(await settings(f.sub2.id)).toMatchObject({
      project: { lead_id: f.guest.id, review_hours: 3 },
      inherited_review_hours: 5,
      lead: { ...personOf(f.guest), inherited: false },
    })
    // a lead whose profile is gone, or in another organization, is none
    await t.run((ctx) => ctx.db.patch(f.sub2._id, { lead_id: f.otherAdmin.id }))
    expect(await settings(f.sub2.id)).toMatchObject({ lead: null })
    await t.run((ctx) => ctx.db.patch(f.hidden._id, { lead_id: uuid() }))
    expect(await settings(f.hidden.id)).toMatchObject({
      lead: null,
      inherited_review_hours: DEFAULT_REVIEW_HOURS,
    })
  })

  it('reads the same documents whatever the project holds in tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const reads = () =>
      t.run(async (ctx) => {
        const answer = await projectSettingsOf(ctx, new Map([[f.org.id, f.guest]]), f.sub.id)
        const m = await ctx.meta.getTransactionMetrics()
        return { answer, documents: m.documentsRead.used, ranges: m.databaseQueries.used }
      })
    const before = await reads()
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++)
        await insertTask(
          ctx.db,
          {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 1000 + i,
            title: `Task ${i}`,
            description: 'Words '.repeat(50),
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          },
          'restore',
        )
    })
    const after = await reads()
    expect(after).toEqual(before)
    expect(before.answer.state).toBe('ok')
  })
})

/* ----------------------------------------------------------------- rights */

/** The rights every write's own rule gives `me` on `p`, read with the
 * predicates the writes call (model/projects.ts, model/projectAccess.ts,
 * projects.ts): the reference get's rights must equal. can_create_sub_project
 * is the create's rule, which checks only that the parent is a meta, where
 * get also asks for a top-level one; the two differ only for a legacy meta
 * row with a parent, which SHAPES does not plant (tested on its own
 * below). */
async function writeRules(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<SettingsRights> {
  const lead = await hasProjectLevel(ctx, me, p.id, 'lead')
  const person = canChangeAccess(me)
  const users = await canManageProjectUsers(ctx, me, p)
  return {
    can_edit: lead,
    can_change_lead: person && (p.type === 'meta' ? users : lead),
    can_manage_users: person && users,
    can_manage_teams: person && (await canManageProjectTeams(ctx, me, p)),
    can_invite: users,
    can_archive: lead,
    can_delete: lead,
    can_create_sub_project:
      (await canSeeProject(ctx, me, p)) && p.type === 'meta' && p.archived_at === undefined && lead,
  }
}

const RIGHTS: (keyof SettingsRights)[] = [
  'can_edit',
  'can_change_lead',
  'can_manage_users',
  'can_manage_teams',
  'can_invite',
  'can_archive',
  'can_delete',
  'can_create_sub_project',
]

describe('rights', () => {
  it("equal each write's own rule for every grant shape, role, kind and project", async () => {
    // every value each right takes over the shapes
    const seen = new Map<string, Set<boolean>>()
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        const projects = await Promise.all(
          [f.meta, f.sub, f.sub2, f.hidden, f.otherProject].map(
            async (p) => (await ctx.db.get(p._id)) as Doc<'projects'>,
          ),
        )
        for (const org_role of ORG_ROLES) {
          for (const kind of PROFILE_KINDS) {
            const me = { ...subject, org_role, kind }
            for (const p of projects) {
              const label = `${name}: ${org_role} ${kind} on ${p.key}`
              const answer = await projectSettingsOf(ctx, new Map([[f.org.id, me]]), p.id)
              const sees = p.org_id === me.org_id && (await projectLevel(ctx, me, p)) !== null
              const manages = p.org_id === me.org_id && (await canManageProjectUsers(ctx, me, p))
              if (!sees && !manages) {
                expect(answer, label).toEqual({ state: 'unavailable' })
                continue
              }
              if (p.archived_at !== undefined) {
                expect(answer.state, label).toBe('archived')
                continue
              }
              const rules = await writeRules(ctx, me, p)
              const ok = answer as Extract<ProjectSettings, { state: 'ok' }>
              expect(ok.state, label).toBe('ok')
              expect(ok.level, label).toBe(await projectLevel(ctx, me, p))
              for (const right of RIGHTS) {
                expect(ok[right], `${label}, ${right}`).toBe(rules[right])
                const values = seen.get(right) ?? new Set()
                values.add(ok[right])
                seen.set(right, values)
              }
            }
          }
        }
      })
    }
    // the shapes reach every right both ways
    for (const right of RIGHTS)
      expect([...(seen.get(right) ?? [])].sort(), right).toEqual([false, true])
  }, 120_000)

  /* The writes of each right. Each runs in a fresh build, and whether it
   * goes through must be what get answered. */
  type Build = {
    t: T
    f: OrgFixture
    me: Doc<'profiles'>
    project: Doc<'projects'>
    target: Doc<'profiles'>
  }
  const WRITES: Record<keyof SettingsRights, (b: Build) => Promise<unknown>> = {
    can_edit: ({ t, f, me, project }) =>
      as(t, me).mutation(api.projects.update, {
        org_id: f.org.id,
        id: project.id,
        patch: { description: 'Changed' },
      }),
    can_change_lead: ({ t, f, me, project, target }) =>
      as(t, me).mutation(api.projects.update, {
        org_id: f.org.id,
        id: project.id,
        patch: { lead_id: target.id },
      }),
    can_manage_users: ({ t, f, me, project, target }) =>
      as(t, me).mutation(api.projects.setAccess, {
        org_id: f.org.id,
        id: project.id,
        user_id: target.id,
        level: 'viewer',
      }),
    can_manage_teams: ({ t, f, me, project }) =>
      as(t, me).mutation(api.projects.setAccess, {
        org_id: f.org.id,
        id: project.id,
        team_id: f.team.id,
        level: 'viewer',
      }),
    can_invite: ({ t, f, me, project }) =>
      as(t, me).mutation(api.projects.inviteGuest, {
        org_id: f.org.id,
        project_id: project.id,
        email: `invited-${uuid().slice(0, 8)}@example.se`,
        level: 'viewer',
      }),
    can_archive: ({ t, f, me, project }) =>
      as(t, me).mutation(api.projects.archive, { org_id: f.org.id, id: project.id }),
    can_delete: ({ t, f, me, project }) =>
      as(t, me).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: project.id }),
    can_create_sub_project: ({ t, f, me, project }) =>
      as(t, me).mutation(api.projects.create, {
        org_id: f.org.id,
        id: uuid(),
        type: 'project',
        parent_id: project.id,
        key: 'NEWP',
        name: 'New sub-project',
        sort_order: 9,
      }),
  }

  /* The covering set: who, on which project, after which setup, and the
   * rights get answers there today. */
  type Case = {
    name: string
    plant: (t: T, f: OrgFixture) => Promise<{ me: Doc<'profiles'>; project: Doc<'projects'> }>
    rights: 'all' | 'none' | 'all but a sub-project'
  }
  const CASES: Case[] = [
    {
      name: 'an admin without a grant on a top-level project',
      plant: async (_, f) => ({ me: f.admin, project: f.meta }),
      rights: 'all',
    },
    {
      name: 'an admin without a grant on a legacy sub-project without a lead',
      plant: async (_, f) => ({ me: f.admin, project: f.sub }),
      rights: 'all but a sub-project',
    },
    {
      name: "the top-level project's lead",
      plant: async (_, f) => ({ me: f.user, project: f.meta }),
      rights: 'all',
    },
    {
      name: 'the parent lead on a legacy sub-project without a lead of its own',
      plant: async (_, f) => ({ me: f.user, project: f.sub }),
      rights: 'all but a sub-project',
    },
    {
      name: 'a guest who leads a top-level project',
      plant: async (t, f) => {
        await t.run((ctx) => ctx.db.patch(f.hidden._id, { lead_id: f.guest.id }))
        return { me: f.guest, project: f.hidden }
      },
      rights: 'all',
    },
    {
      name: 'a guest who leads a sub-project',
      plant: async (t, f) => {
        await t.run((ctx) => ctx.db.patch(f.sub2._id, { lead_id: f.guest.id }))
        return { me: f.guest, project: f.sub2 }
      },
      rights: 'all but a sub-project',
    },
    {
      name: 'the lead of the parent on a sub-project someone else leads',
      plant: async (t, f) => {
        const me = await seat(t, f, 'Parent lead')
        await t.run(async (ctx) => {
          await ctx.db.patch(f.meta._id, { lead_id: me.id })
          await ctx.db.patch(f.sub2._id, { lead_id: f.user.id })
        })
        return { me, project: f.sub2 }
      },
      rights: 'none',
    },
    {
      name: 'a standard user with a User grant on the top-level project',
      plant: async (t, f) => {
        const me = await seat(t, f, 'Member')
        await grant(t, f.meta, me.id, nameKey(me.name))
        return { me, project: f.meta }
      },
      rights: 'none',
    },
    {
      name: 'a viewer with a User grant on the top-level project',
      plant: async (_, f) => ({ me: f.viewer, project: f.meta }),
      rights: 'none',
    },
    {
      name: 'a guest with a User grant on the parent, on a sub-project',
      plant: async (_, f) => ({ me: f.guest, project: f.sub }),
      rights: 'none',
    },
  ]

  for (const c of CASES) {
    it(`answers what each write does for ${c.name}`, async () => {
      const build = async (): Promise<Build> => {
        const t = newT()
        const f = await withOrg(t)
        const target = await seat(t, f, 'Target')
        return { t, f, target, ...(await c.plant(t, f)) }
      }
      const first = await build()
      const answer = await read.get(first.t, first.me, first.project.id)
      if (answer.state !== 'ok') throw new Error(`${c.name}: ${answer.state}`)
      for (const right of RIGHTS) {
        const expected =
          c.rights === 'all' ||
          (c.rights === 'all but a sub-project' && right !== 'can_create_sub_project')
        expect(answer[right], `${c.name}: ${right}`).toBe(expected)
        const b = await build()
        const went = await WRITES[right](b).then(
          () => true,
          (e) => {
            if (!(e instanceof ConvexError)) throw e
            return false
          },
        )
        expect(went, `${c.name}: the write behind ${right}`).toBe(answer[right])
      }
    })
  }

  it('answers can_invite false on a demo deployment, with the other rights unchanged, and refuses the invite lookup with the demo sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a public call on the demo needs a demo session, so these call the readers
    const settings = () =>
      t.run((ctx) => projectSettingsOf(ctx, new Map([[f.org.id, f.user]]), f.meta.id))
    const lookup = (me: Doc<'profiles'>) =>
      t.run((ctx) =>
        inviteTargetOf(ctx, me, { project_id: f.meta.id, email: 'guest@testbed.test' }),
      )
    const regular = await settings()
    expect(regular).toMatchObject({ state: 'ok', can_invite: true })
    expect((await lookup(f.user)).state).toBe('ready')
    vi.stubEnv('APP_MODE', 'demo')
    expect(await settings()).toEqual({ ...regular, can_invite: false })
    // the demo refuses first, for a manager and anyone else, as inviteGuest does
    for (const me of [f.user, f.guest])
      expect(await lookup(me)).toEqual({ state: 'refused', message: DEMO_FEATURE_REFUSAL })
    vi.stubEnv('APP_MODE', '')
    expect(await lookup(f.guest)).toEqual({ state: 'refused', message: NO_USER_MANAGEMENT })
  })

  it('offers no sub-project under a legacy meta row that has a parent, where the create would take one', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a meta-typed row under TBED, which create and the header of
    // projects.ts rule out for new rows; TBED's lead and the admin lead it
    const legacy = await plantProject(t, { org_id: f.org.id, type: 'meta', parent_id: f.meta.id })
    await keyOrg(t, f.org.id)
    for (const me of [f.admin, f.user]) {
      expect(await read.get(t, me, legacy.id), me.name).toMatchObject({
        state: 'ok',
        level: 'lead',
        can_edit: true,
        can_create_sub_project: false,
      })
      // the lead picker of a new sub-project follows the create's own checks
      // (model/projects.ts subProjectParent), which take the row
      expect((await read.leadCandidates(t, me, { parent_id: legacy.id })).state, me.name).toBe(
        'ready',
      )
    }
    // and the create takes it: the flag is stricter, as a sub-project there
    // would sit outside every meta tree, where nobody could reach it
    const created = await as(t, f.admin).mutation(api.projects.create, {
      org_id: f.org.id,
      id: uuid(),
      type: 'project',
      parent_id: legacy.id,
      key: 'LOST',
      name: 'Out of reach',
      sort_order: 9,
    })
    expect(await read.get(t, f.admin, created.id)).toEqual({ state: 'unavailable' })
  })

  it('leaves the rights that change access to people: an agent that leads a project may edit but not change access', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.hidden._id, { lead_id: f.agent.id }))
    const project = (await t.run((ctx) => ctx.db.get(f.hidden._id))) as Doc<'projects'>
    const answer = await t.run((ctx) =>
      projectSettingsOf(ctx, new Map([[f.org.id, f.agent]]), project.id),
    )
    expect(answer).toMatchObject({
      state: 'ok',
      level: 'lead',
      can_edit: true,
      can_change_lead: false,
      can_manage_users: false,
      can_manage_teams: false,
      can_invite: true,
      can_archive: true,
      can_delete: true,
      can_create_sub_project: true,
    })
    const now = new Date().toISOString()
    // a settings edit goes through, and the writes that change access refuse
    await t.run((ctx) =>
      updateProjectCore(ctx, { me: f.agent, project, patch: { description: 'By the agent' }, now }),
    )
    const refusals = await t.run(async (ctx) => {
      const out: string[] = []
      const tryIt = async (w: () => Promise<unknown>) => {
        try {
          await w()
          out.push('went through')
        } catch (e) {
          out.push(e instanceof ConvexError ? (e.data as { message: string }).message : String(e))
        }
      }
      await tryIt(() =>
        updateProjectCore(ctx, { me: f.agent, project, patch: { lead_id: f.admin.id }, now }),
      )
      await tryIt(() =>
        setProjectGrantCore(ctx, {
          me: f.agent,
          project,
          subject: { profile: f.viewer },
          level: 'viewer',
          now,
        }),
      )
      await tryIt(() =>
        setProjectGrantCore(ctx, {
          me: f.agent,
          project,
          subject: { team: f.team },
          level: 'viewer',
          now,
        }),
      )
      return out
    })
    expect(refusals).toEqual([ACCESS_NEEDS_A_PERSON, ACCESS_NEEDS_A_PERSON, ACCESS_NEEDS_A_PERSON])
    // and the pickers refuse it with the same sentence
    await keyOrg(t, f.org.id)
    const pickers = await t.run(async (ctx) => [
      await candidatesOf(ctx, f.agent, { project_id: project.id }),
      await leadCandidatesOf(ctx, f.agent, { project_id: project.id }),
      await leadCandidatesOf(ctx, f.agent, { parent_id: project.id }),
      await candidatesOf(ctx, f.agent, {}),
      await leadCandidatesOf(ctx, f.agent, {}),
    ])
    for (const p of pickers) expect(p).toEqual({ state: 'refused', message: ACCESS_NEEDS_A_PERSON })
  })
})

/* ------------------------------------------------------------------ users */

/** `rows` sorted as a name index orders them: key bytes, then id. */
const inIndexOrder = <R extends { key: string; id: string }>(rows: R[]) =>
  [...rows].sort((a, b) => compareValues([a.key, a.id], [b.key, b.id]))

describe('projectSettings.users', () => {
  it('names the effective lead in a first batch only, outside the rows, when the search matches', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the lead's own legacy grant, which the lead row stands for
    await grant(t, f.meta, f.user.id, 'user')
    await keyOrg(t, f.org.id)
    const row = (p: Doc<'profiles'>) => ({ ...personOf(p), level: 'user', ...choices(p) })
    expect(await read.users(t, f.admin, f.meta.id)).toEqual({
      state: 'ready',
      rows: [row(f.guest), row(f.viewer)],
      next: null,
      stopped: false,
      lead: { ...personOf(f.user), inherited: false },
    })
    // the viewer holds a User grant but may only be given Viewer, and cannot lead
    expect(row(f.viewer)).toMatchObject({ levels: ['viewer'], can_lead: false })
    // a legacy sub-project shows its parent's lead
    expect(await read.users(t, f.guest, f.sub.id)).toMatchObject({
      rows: [],
      lead: { id: f.user.id, inherited: true },
    })
    // the lead row follows the search
    expect(await read.users(t, f.admin, f.meta.id, { search: 'USER' })).toMatchObject({
      rows: [],
      lead: { id: f.user.id },
    })
    expect(await read.users(t, f.admin, f.meta.id, { search: 'gue' })).toMatchObject({
      rows: [{ id: f.guest.id }],
      lead: null,
    })
    // and only a first batch names it
    await grantees(t, f, f.meta, names('Person ', 30))
    const first = ready(await read.users(t, f.admin, f.meta.id))
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first.lead).toMatchObject({ id: f.user.id })
    const second = ready(await read.users(t, f.admin, f.meta.id, { after: first.next ?? '' }))
    expect('lead' in second).toBe(false)
    expect(second.rows.map((r) => r.id)).not.toContain(f.user.id)
  })

  it('lists every grant once in name-key order with the id tie, across batches with equal names', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const project = await meta(t, f)
    const people = [
      ...(await grantees(t, f, project, Array(30).fill('Same Name'))),
      ...(await grantees(t, f, project, names('Person ', 30))),
      ...(await grantees(t, f, project, ['Émile', 'emile', 'Zoë', 'Åsa'])),
    ]
    const batches = await walk((after) => read.users(t, f.admin, project.id, { after }))
    expect(batches.map((b) => b.rows.length)).toEqual([25, 25, 14])
    expect(batches.every((b) => !b.stopped)).toBe(true)
    expect(idsOf(batches)).toEqual(
      inIndexOrder(people.map((p) => ({ key: nameKey(p.name), id: p.id }))).map((r) => r.id),
    )
    // a search over the whole list, ignoring case and accents
    const emile = await walk((after) =>
      read.users(t, f.admin, project.id, { search: 'EMILE', after }),
    )
    expect(idsOf(emile)).toHaveLength(2)
    const same = await walk((after) =>
      read.users(t, f.admin, project.id, { search: 'name same', after }),
    )
    expect(idsOf(same)).toHaveLength(30)
  })

  it('keeps a loaded batch live between its cursors with through', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const project = await meta(t, f)
    await grantees(t, f, project, names('Person ', 60))
    const first = ready(await read.users(t, f.admin, project.id))
    const next = first.next ?? ''
    // a grant that sorts first arrives, and the loaded batch keeps its end
    const [early] = await grantees(t, f, project, ['Aaron'])
    const live = ready(await read.users(t, f.admin, project.id, { through: next }))
    expect(live.rows.map((r) => r.id)).toEqual([early.id, ...first.rows.map((r) => r.id)])
    expect(live.stopped).toBe(false)
    const after = ready(await read.users(t, f.admin, project.id, { after: next }))
    const afterLive = ready(await read.users(t, f.admin, project.id, { after: live.next ?? '' }))
    expect(afterLive.rows).toEqual(after.rows)
    // more than four batches before its end stops it, for the app to split
    await grantees(t, f, project, names('Abel ', 4 * LIST_BATCH))
    const full = ready(await read.users(t, f.admin, project.id, { through: next }))
    expect(full.rows).toHaveLength(4 * LIST_BATCH)
    expect(full.stopped).toBe(true)
  })

  it("leaves out a grant whose profile is gone, one of another organization's profile and the lead's own", async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    await grant(t, f.meta, uuid(), 'aaa gone')
    await grant(t, f.meta, f.otherAdmin.id, 'aaa other')
    await grant(t, f.meta, f.user.id, 'user')
    const batch = ready(await read.users(t, f.admin, f.meta.id))
    expect(batch.rows.map((r) => r.id)).toEqual([f.guest.id, f.viewer.id])
  })

  it('leaves out an unkeyed grant or share whose profile or team is gone, and fails closed on one whose is not', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    // a removed person's grant and a deleted team's share, left without a
    // key from before the backfill stamped the organization
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: uuid(),
        level: 'user',
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: uuid(),
        level: 'user',
      })
    })
    expect(await read.users(t, f.admin, f.meta.id)).toMatchObject({
      state: 'ready',
      rows: [{ id: f.guest.id }, { id: f.viewer.id }],
    })
    expect(await read.teams(t, f.admin, f.meta.id)).toMatchObject({ state: 'ready', rows: [] })
    const offered = () =>
      walk((after) => read.candidates(t, f.admin, { project_id: f.meta.id, after })).then(idsOf)
    expect(await offered()).toEqual([f.team.id, f.admin.id, f.agent.id])
    // past the most it checks, a list fails closed
    Object.assign(UNKEYED_MOST, { rows: 0 })
    expect(await read.users(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
    expect(await read.teams(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
    Object.assign(UNKEYED_MOST, DEFAULT_UNKEYED)
    // an unkeyed grant or share of someone still in the organization: the
    // lists fail closed, and the picker still leaves them out
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    expect(await read.users(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
    expect(await read.teams(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
    expect(await offered()).toEqual([f.admin.id])
  })

  it('lists a renamed person at the place their copy holds until the copy follows the rename', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    // the guest is renamed; their grant's copy still holds the old key
    await t.run((ctx) => ctx.db.patch(f.guest._id, { name: 'Zed', name_key: 'zed' }))
    const browse = ready(await read.users(t, f.admin, f.meta.id))
    expect(browse.rows.map((r) => [r.id, r.name])).toEqual([
      [f.guest.id, 'Zed'],
      [f.viewer.id, 'viewer'],
    ])
    expect(ready(await read.users(t, f.admin, f.meta.id, { search: 'guest' })).rows).toHaveLength(1)
    expect(ready(await read.users(t, f.admin, f.meta.id, { search: 'zed' })).rows).toEqual([])
  })

  it('answers not_ready until the organization is keyed', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await read.users(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
    expect(await read.teams(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
    expect(await read.candidates(t, f.admin, { project_id: f.meta.id })).toEqual({
      state: 'not_ready',
    })
    expect(await read.leadCandidates(t, f.admin)).toEqual({ state: 'not_ready' })
    await keyOrg(t, f.org.id)
    expect((await read.users(t, f.admin, f.meta.id)).state).toBe('ready')
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('org_ready').collect())
        await ctx.db.patch(row._id, { name_keys_at: undefined })
    })
    expect(await read.users(t, f.admin, f.meta.id)).toEqual({ state: 'not_ready' })
  })

  it('refuses a cursor of another list, project or search, a tampered one and a through before after', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    await grantees(t, f, f.meta, names('Person ', 60))
    await grantees(t, f, f.hidden, names('Person ', 30))
    for (let i = 0; i < 30; i++) {
      const one = await team(t, f.org.id, `Team ${String(i).padStart(2, '0')}`)
      await share(t, f.meta, one.id, one.name_key ?? '')
    }
    const first = ready(await read.users(t, f.admin, f.meta.id)).next ?? ''
    const second = ready(await read.users(t, f.admin, f.meta.id, { after: first })).next ?? ''
    const teamCursor = ready(await read.teams(t, f.admin, f.meta.id)).next ?? ''
    const searched = ready(await read.users(t, f.admin, f.meta.id, { search: 'person' })).next ?? ''
    const tampered = `${first.slice(0, -2)}${first.endsWith('00') ? '11' : '00'}`
    const cases: [string, Promise<unknown>][] = [
      ['another list', read.users(t, f.admin, f.meta.id, { after: teamCursor })],
      ['another project', read.users(t, f.admin, f.hidden.id, { after: first })],
      ['another search', read.users(t, f.admin, f.meta.id, { after: searched })],
      ['tampered', read.users(t, f.admin, f.meta.id, { after: tampered })],
      ['not a cursor', read.users(t, f.admin, f.meta.id, { through: 'abc' })],
      ['a users cursor in teams', read.teams(t, f.admin, f.meta.id, { after: first })],
    ]
    for (const [name, call] of cases)
      expect(await refusal(call, 'bad_request'), name).toMatch(/cursors from an earlier answer/)
    expect(
      await refusal(
        read.users(t, f.admin, f.meta.id, { after: second, through: first }),
        'bad_request',
      ),
    ).toMatch(/through must be a cursor after/)
    expect(
      await refusal(
        read.users(t, f.admin, f.meta.id, { search: 'x'.repeat(LIMITS.search.max + 1) }),
        'rule',
      ),
    ).toBe(LIMITS.search.refusal)
    // the same search with another case and accents shares the cursors
    expect(
      ready(await read.users(t, f.admin, f.meta.id, { search: 'PÉRSON', after: searched })).rows,
    ).toHaveLength(LIST_BATCH)
  })
})

/* ------------------------------------------------------------------ teams */

describe('projectSettings.teams', () => {
  it("lists a project's shares in name order and leaves out a gone team and another organization's", async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const teams = [f.team]
    for (const name of names('Squad ', 30)) teams.push(await team(t, f.org.id, name))
    for (const one of teams) await share(t, f.sub, one.id, nameKey(one.name), 'viewer')
    const foreign = await team(t, f.otherOrg.id, 'Alpha foreign')
    await share(t, f.sub, foreign.id, 'alpha foreign')
    await share(t, f.sub, uuid(), 'alpha gone')
    const batches = await walk((after) => read.teams(t, f.guest, f.sub.id, { after }))
    expect(batches.map((b) => b.rows.length)).toEqual([25, 6])
    expect(idsOf(batches)).toEqual(
      inIndexOrder(teams.map((one) => ({ key: nameKey(one.name), id: one.id }))).map((r) => r.id),
    )
    expect(batches[0].rows[0]).toEqual({ id: f.team.id, name: 'Hardware', level: 'viewer' })
    // every fragment, in any order: Squad 02, 12 and 20 to 29
    expect(
      idsOf(await walk((after) => read.teams(t, f.guest, f.sub.id, { search: 'squad 2', after }))),
    ).toHaveLength(12)
    // a share on the parent is not a share on this project
    expect(ready(await read.teams(t, f.guest, f.meta.id)).rows).toEqual([])
  })
})

/* ------------------------------------------------------------- candidates */

describe('projectSettings.candidates', () => {
  it('offers teams and then people in one order, with batches and through across the boundary', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const project = await meta(t, f, f.user)
    const teams = [f.team]
    for (const name of names('Crew ', 20)) teams.push(await team(t, f.org.id, name))
    const people = [f.admin, f.agent, f.guest, f.viewer]
    for (const name of names('Member ', 10)) people.push(await seat(t, f, name))
    const expected = [
      ...inIndexOrder(teams.map((one) => ({ key: nameKey(one.name), id: one.id }))),
      // the project's lead is left out
      ...inIndexOrder(people.map((p) => ({ key: nameKey(p.name), id: p.id }))),
    ].map((r) => r.id)
    const batches = await walk((after) =>
      read.candidates(t, f.admin, { project_id: project.id, after }),
    )
    expect(batches.map((b) => b.rows.length)).toEqual([25, 10])
    expect(idsOf(batches)).toEqual(expected)
    const firstTeam = teams.find((one) => one.id === expected[0])
    expect(batches[0].rows[0]).toEqual({ type: 'team', id: firstTeam?.id, name: firstTeam?.name })
    expect(batches[0].rows[24]).toMatchObject({ type: 'user' })
    // the first batch's end is a person; a team that arrives stays before it
    const end = batches[0].next ?? ''
    const late = await team(t, f.org.id, 'Crew late')
    const live = ready(await read.candidates(t, f.admin, { project_id: project.id, through: end }))
    expect(live.rows).toHaveLength(26)
    expect(live.rows.map((r) => r.id)).toContain(late.id)
    expect(live.rows.at(-1)).toEqual(batches[0].rows.at(-1))
    // a search across both groups starts with matches only
    const crew = ready(await read.candidates(t, f.admin, { project_id: project.id, search: 'r' }))
    expect(crew.rows.every((r) => r.name.toLowerCase().includes('r'))).toBe(true)
    expect(
      crew.rows.some((r) => r.type === 'team') && crew.rows.some((r) => r.type === 'user'),
    ).toBe(true)
  })

  it("leaves out what the project already holds and the lead, and nobody for a parent's grants, a team's members or admin status", async () => {
    const t = newT()
    const f = await withOrg(t)
    const inactive = await seat(t, f, 'Inactive', { active: false })
    const invited = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Invited',
      org_role: 'guest',
    })
    await keyOrg(t, f.org.id)
    // TBED's grants (guest, viewer) and a share of Hardware on TBED
    await share(t, f.meta, f.team.id, 'hardware')
    const ids = async (project: Doc<'projects'>) =>
      idsOf(await walk((after) => read.candidates(t, f.admin, { project_id: project.id, after })))
    // on TBED: Hardware is shared, the guest and the viewer hold grants, the user leads
    expect(await ids(f.meta)).toEqual([f.admin.id, invited.id, f.agent.id])
    // on FW: the parent's share and grants exclude nobody; its lead is the parent's
    const fw = await walk((after) => read.candidates(t, f.admin, { project_id: f.sub.id, after }))
    expect(idsOf(fw)).toEqual([
      f.team.id,
      f.admin.id,
      f.guest.id,
      invited.id,
      f.agent.id,
      f.viewer.id,
    ])
    const rows = new Map(fw.flatMap((b) => b.rows).map((r) => [r.id, r]))
    expect(rows.get(f.viewer.id)).toEqual({
      type: 'user',
      ...personOf(f.viewer),
      levels: ['viewer'],
      can_lead: false,
    })
    expect(rows.get(f.agent.id)).toMatchObject({ kind: 'agent', pending: false, can_lead: true })
    expect(rows.get(invited.id)).toMatchObject({ org_role: 'guest', pending: true, can_lead: true })
    expect(rows.has(inactive.id)).toBe(false)
    // a share and a grant on FW itself leave those out, a member of the team stays
    await share(t, f.sub, f.team.id, 'hardware')
    await grant(t, f.sub, f.guest.id, 'guest')
    expect(await ids(f.sub)).toEqual([f.admin.id, invited.id, f.agent.id, f.viewer.id])
  })

  it('leaves out a share or grant whose copy trails a rename, and never a held choice when the budget stops a batch', async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const project = await meta(t, f, f.admin)
    // Hardware and the guest are renamed; their copies on the project still
    // hold the old keys, so the walk beside them misses both
    await share(t, project, f.team.id, 'hardware')
    await grant(t, project, f.guest.id, 'guest')
    await t.run(async (ctx) => {
      await ctx.db.patch(f.team._id, { name: 'Zz hardware', name_key: 'zz hardware' })
      await ctx.db.patch(f.guest._id, { name: 'Zz guest', name_key: 'zz guest' })
    })
    const offered = idsOf(
      await walk((after) => read.candidates(t, f.admin, { project_id: project.id, after })),
    )
    expect(offered).toEqual([f.agent.id, f.user.id, f.viewer.id])
    // 60 granted people and 20 shared teams first, then 12 people and 3
    // teams to offer, under a budget that stops batches early
    const sharedTeams: Doc<'teams'>[] = []
    for (const name of names('Aa crew ', 20)) {
      const one = await team(t, f.org.id, name)
      await share(t, project, one.id, one.name_key ?? '')
      sharedTeams.push(one)
    }
    const freeTeams = [await team(t, f.org.id, 'Mid crew 1'), await team(t, f.org.id, 'Mid crew 2')]
    await grantees(t, f, project, names('Aa person ', 60))
    const free = await plantPeople(t, f, names('Mm person ', 12))
    Object.assign(NAMED_READ, { documents: 40 })
    const batches = await walk((after) =>
      read.candidates(t, f.admin, { project_id: project.id, after }),
    )
    expect(batches.length).toBeGreaterThan(3)
    expect(batches.some((b) => b.stopped)).toBe(true)
    expect(idsOf(batches)).toEqual([
      ...freeTeams.map((one) => one.id),
      ...free,
      f.agent.id,
      f.user.id,
      f.viewer.id,
    ])
  })

  it('tells a team from a person with the same id when it leaves out what the project holds', async () => {
    const t = newT()
    const f = await withOrg(t)
    const project = await meta(t, f, f.user)
    // teams take client-chosen ids: Twin has the admin's, Echo the guest's
    const twin = async (id: string, name: string) =>
      t.run((ctx) =>
        ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name,
          track_delay_default: false,
          created_at: NOW,
        }),
      )
    await twin(f.admin.id, 'Twin')
    await twin(f.guest.id, 'Echo')
    await keyOrg(t, f.org.id)
    // Twin is shared and the guest granted; the admin and Echo are not
    await share(t, project, f.admin.id, 'twin')
    await grant(t, project, f.guest.id, 'guest')
    const batches = await walk((after) =>
      read.candidates(t, f.admin, { project_id: project.id, after }),
    )
    expect(batches.flatMap((b) => b.rows.map((r) => [r.type, r.name]))).toEqual([
      ['team', 'Echo'],
      ['team', 'Hardware'],
      ['user', 'admin'],
      ['user', 'Relay'],
      ['user', 'viewer'],
    ])
  })

  it('offers a new project every team and the active admins, users and viewers, without guests or the chosen lead', async () => {
    const t = newT()
    const f = await withOrg(t)
    await seat(t, f, 'Inactive', { active: false })
    await keyOrg(t, f.org.id)
    const ids = async (lead_id?: string) =>
      idsOf(await walk((after) => read.candidates(t, f.user, { lead_id, after })))
    const all = [f.team.id, f.admin.id, f.agent.id, f.user.id, f.viewer.id]
    expect(await ids()).toEqual(all)
    expect(await ids(f.user.id)).toEqual(all.filter((id) => id !== f.user.id))
    // an unknown id leaves out nobody
    expect(await ids(uuid())).toEqual(all)
    // a cursor for one lead does not open for another
    await grantees(t, f, f.hidden, names('Person ', 30))
    const next = ready(await read.candidates(t, f.user, { lead_id: f.admin.id })).next ?? ''
    expect(
      await refusal(
        read.candidates(t, f.user, { lead_id: f.viewer.id, after: next }),
        'bad_request',
      ),
    ).toMatch(/cursors from an earlier answer/)
    expect(
      await refusal(
        read.candidates(t, f.user, { project_id: f.meta.id, lead_id: f.admin.id }),
        'bad_request',
      ),
    ).toMatch(/lead_id/)
  })

  it("refuses with the write's sentences a caller who may not give access or create a project", async () => {
    const t = newT()
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    // the guest sees TBED but does not manage it
    expect(await read.candidates(t, f.guest, { project_id: f.meta.id })).toEqual({
      state: 'refused',
      message: NO_USER_MANAGEMENT,
    })
    const creators = async (setting: 'admins' | 'users' | 'selected') => {
      await t.run((ctx) => ctx.db.patch(f.org._id, { project_creators: setting }))
      return await read.candidates(t, f.user)
    }
    expect(await creators('admins')).toEqual({
      state: 'refused',
      message: 'only org admins can create projects',
    })
    expect(await creators('selected')).toEqual({
      state: 'refused',
      message: 'only org admins and selected standard users can create projects',
    })
    await t.run((ctx) => ctx.db.patch(f.user._id, { can_create_projects: true }))
    expect((await creators('selected')).state).toBe('ready')
    expect((await creators('users')).state).toBe('ready')
    expect(await read.candidates(t, f.viewer)).toEqual({
      state: 'refused',
      message: 'only org admins and standard users can create projects',
    })
    expect((await read.candidates(t, f.admin)).state).toBe('ready')
    // a cursor for one project does not open for another
    await grantees(t, f, f.hidden, names('Person ', 30))
    const next = ready(await read.candidates(t, f.admin, { project_id: f.meta.id })).next ?? ''
    expect(
      await refusal(
        read.candidates(t, f.admin, { project_id: f.hidden.id, after: next }),
        'bad_request',
      ),
    ).toMatch(/cursors from an earlier answer/)
  })
})

/* --------------------------------------------------------- leadCandidates */

describe('projectSettings.leadCandidates', () => {
  it('offers the active admins, users and guests in one name order, agents with the user role included', async () => {
    const t = newT()
    const f = await withOrg(t)
    const extra = [
      await seat(t, f, 'Anna', { org_role: 'admin' }),
      await seat(t, f, 'Bert', { org_role: 'guest' }),
      await seat(t, f, 'Cara'),
      await seat(t, f, 'Dan', { org_role: 'viewer' }),
      await seat(t, f, 'Eve', { active: false }),
    ]
    await keyOrg(t, f.org.id)
    const offered = [f.admin, f.guest, f.agent, f.user, extra[0], extra[1], extra[2]]
    const expected = inIndexOrder(offered.map((p) => ({ key: nameKey(p.name), id: p.id }))).map(
      (r) => r.id,
    )
    const ids = async (a: { project_id?: string; parent_id?: string } = {}) =>
      idsOf(await walk((after) => read.leadCandidates(t, f.admin, { ...a, after })))
    expect(await ids({ project_id: f.meta.id })).toEqual(expected)
    expect(await ids({ project_id: f.sub.id })).toEqual(expected)
    expect(await ids({ parent_id: f.meta.id })).toEqual(expected)
    // a new top-level project offers admins and users only
    expect(await ids()).toEqual(expected.filter((id) => id !== f.guest.id && id !== extra[1].id))
    const rows = ready(await read.leadCandidates(t, f.admin, { search: 'relay' })).rows
    expect(rows).toEqual([personOf(f.agent)])
  })

  it("refuses each target with its write's sentences", async () => {
    const t = newT()
    const f = await withOrg(t)
    const archivedParent = await meta(t, f, f.user)
    await t.run((ctx) => ctx.db.patch(archivedParent._id, { archived_at: NOW }))
    await keyOrg(t, f.org.id)
    const answer = (who: Doc<'profiles'>, a: { project_id?: string; parent_id?: string }) =>
      read.leadCandidates(t, who, a)
    // the Lead field: of a top-level project as a user manager, of a
    // sub-project as Lead access
    expect(await answer(f.guest, { project_id: f.meta.id })).toEqual({
      state: 'refused',
      message: NO_USER_MANAGEMENT,
    })
    expect(await answer(f.guest, { project_id: f.sub.id })).toEqual({
      state: 'refused',
      message: LEAD_ACCESS_NEEDED,
    })
    // a new sub-project: the create's parent checks in their order
    expect(await answer(f.guest, { parent_id: f.meta.id })).toEqual({
      state: 'refused',
      message: LEAD_ACCESS_NEEDED,
    })
    expect(await answer(f.user, { parent_id: f.sub.id })).toEqual({
      state: 'refused',
      message: PARENT_NOT_TOP_LEVEL,
    })
    expect(await answer(f.user, { parent_id: archivedParent.id })).toEqual({
      state: 'refused',
      message: PARENT_ARCHIVED,
    })
    // a parent the caller cannot see reads as missing
    expect(await answer(f.guest, { parent_id: f.hidden.id })).toEqual({ state: 'unavailable' })
    expect(await answer(f.guest, { parent_id: uuid() })).toEqual({ state: 'unavailable' })
    // a new top-level project follows project_creators
    await t.run((ctx) => ctx.db.patch(f.org._id, { project_creators: 'admins' }))
    expect(await answer(f.user, {})).toEqual({
      state: 'refused',
      message: 'only org admins can create projects',
    })
    expect(
      await refusal(
        answer(f.admin, { project_id: f.meta.id, parent_id: f.meta.id }),
        'bad_request',
      ),
    ).toMatch(/not both/)
    // each target seals its own cursors
    await grantees(t, f, f.hidden, names('Person ', 30))
    const next = ready(await answer(f.admin, { project_id: f.meta.id })).next ?? ''
    expect(
      await refusal(
        read.leadCandidates(t, f.admin, { parent_id: f.meta.id, after: next }),
        'bad_request',
      ),
    ).toMatch(/cursors from an earlier answer/)
  })
})

/* ------------------------------------------------------------ inviteTarget */

describe('projectSettings.inviteTarget', () => {
  it('answers the seat an address names and its grant on the project, for a caller who may invite', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await read.inviteTarget(t, f.user, f.meta.id, '  GUEST@testbed.test ')).toEqual({
      state: 'ready',
      person: personOf(f.guest),
      level: 'user',
    })
    // a grant on the parent is not a grant on the sub-project
    expect(await read.inviteTarget(t, f.user, f.sub.id, 'guest@testbed.test')).toEqual({
      state: 'ready',
      person: personOf(f.guest),
      level: null,
    })
    expect(await read.inviteTarget(t, f.user, f.meta.id, 'nobody@example.se')).toEqual({
      state: 'ready',
      person: null,
      level: null,
    })
    // another organization's seat with the address is not this one's
    expect(await read.inviteTarget(t, f.user, f.meta.id, 'otherAdmin@testbed.test')).toEqual({
      state: 'ready',
      person: null,
      level: null,
    })
    expect(await read.inviteTarget(t, f.guest, f.meta.id, 'guest@testbed.test')).toEqual({
      state: 'refused',
      message: NO_USER_MANAGEMENT,
    })
    expect(
      await refusal(
        read.inviteTarget(t, f.user, f.meta.id, `${'a'.repeat(LIMITS.email.max)}@x.se`),
        'rule',
      ),
    ).toBe(LIMITS.email.refusal)
  })
})

/* ---------------------------------------------------------- real limits */

/** What one transaction read, from Convex's metrics. */
type Read = { ranges: number; documents: number; bytes: number }

/** `run` in its own transaction, with what that transaction read. */
async function measured<R>(
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

/** The batches a call of `run` answers from the start, each measured: to
 * the end, or the first `most` of them. */
async function measuredWalk<B extends { state: string }>(
  t: T,
  run: (ctx: QueryCtx, after?: string) => Promise<B>,
  most?: number,
): Promise<(Read & { rows: number; stopped: boolean })[]> {
  const calls: (Read & { rows: number; stopped: boolean })[] = []
  let after: string | undefined
  for (let round = 0; round < (most ?? 50); round++) {
    const { out, read: r } = await measured(t, (ctx) => run(ctx, after))
    const batch = ready(out) as unknown as ListBatch<unknown>
    calls.push({ ...r, rows: batch.rows.length, stopped: batch.stopped })
    if (batch.next === null) return calls
    after = batch.next
  }
  if (most !== undefined) return calls
  throw new Error('the list did not end')
}

describe('real limits', () => {
  it('reads 5,000 grants a batch at a time, and a search for the last few in one call or with a cursor that resumes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const project = await meta(t, f)
    await plantPeople(t, f, [...names('Person ', 4997), 'Zeta one', 'Zeta two', 'Zeta three'], {
      project,
    })
    const first = await measured(t, (ctx) =>
      projectUsersOf(ctx, f.admin, { project_id: project.id }),
    )
    console.log('users, first batch of 5,000 grants', first.read)
    expect(ready(first.out).rows).toHaveLength(LIST_BATCH)
    expect(first.read.ranges).toBeLessThan(60)
    expect(first.read.documents).toBeLessThan(80)
    const search = await measuredWalk(t, (ctx, after) =>
      projectUsersOf(ctx, f.admin, { project_id: project.id, search: 'zeta', after }),
    )
    console.log('users, a search for the last 3 of 5,000 grants, per call', search)
    expect(search.reduce((n, c) => n + c.rows, 0)).toBe(3)
    for (const call of search) {
      expect(call.documents).toBeLessThanOrEqual(NAMED_READ.documents + 64)
      expect(call.bytes).toBeLessThan(NAMED_READ.bytes + 64 * 1024)
    }
    // the public query answers the same without a limit error
    expect(ready(await read.users(t, f.admin, project.id, { search: 'zeta' })).rows.length).toBe(
      search[0].rows,
    )
  }, 120_000)

  it('offers choices among 5,000 people and 300 teams on a project with 2,000 grants', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    const project = await meta(t, f, f.admin)
    const teams: Doc<'teams'>[] = []
    await t.run(async (ctx) => {
      for (const name of names('Team ', 300)) {
        const _id = await ctx.db.insert('teams', {
          id: uuid(),
          org_id: f.org.id,
          name,
          name_key: nameKey(name),
          track_delay_default: false,
          created_at: NOW,
        })
        teams.push((await ctx.db.get(_id)) as Doc<'teams'>)
      }
    })
    // the 2,000 people granted come first in name order
    await plantPeople(t, f, names('Person ', 5000), { project, granted: (i) => i < 2000 })
    const ask = (ctx: QueryCtx, a: { search?: string; after?: string } = {}) =>
      candidatesOf(ctx, f.admin, { project_id: project.id, ...a })
    const plain = await measured(t, (ctx) => ask(ctx))
    console.log('candidates, first batch, teams unshared', plain.read)
    expect(ready(plain.out).rows).toHaveLength(LIST_BATCH)
    // a search no team matches walks past the teams and the granted people
    const people = await measuredWalk(t, (ctx, after) => ask(ctx, { search: 'person', after }), 3)
    console.log(
      'candidates, search "person" to the end, per call',
      people.slice(0, 3),
      `${people.length} calls`,
    )
    // every team shared: the first batch walks 300 shares and 2,000 grants
    await t.run(async (ctx) => {
      for (const one of teams)
        await ctx.db.insert('project_team_access', {
          project_id: project.id,
          team_id: one.id,
          level: 'user',
          name_key: one.name_key,
        })
    })
    const shared = await measured(t, (ctx) => ask(ctx))
    console.log('candidates, first batch, every team shared', shared.read, {
      rows: ready(shared.out).rows.length,
      stopped: ready(shared.out).stopped,
    })
    // the shares and grants walked beside the choices fill no index ranges
    expect(people[0]).toMatchObject({ rows: LIST_BATCH, stopped: false })
    expect(ready(shared.out)).toMatchObject({ stopped: false })
    expect(ready(shared.out).rows).toHaveLength(LIST_BATCH)
    expect(shared.read.ranges).toBeLessThan(60)
    for (const call of [plain.read, ...people, shared.read]) {
      expect(call.ranges).toBeLessThanOrEqual(NAMED_READ.ranges + 16)
      expect(call.documents).toBeLessThanOrEqual(NAMED_READ.documents + 64)
    }
    expect(ready(await read.candidates(t, f.admin, { project_id: project.id })).rows.length).toBe(
      ready(shared.out).rows.length,
    )
  }, 120_000)

  it('offers leads past 5,000 inactive people', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    // inactive people that sort before every active one
    await plantPeople(t, f, names('Aaa inactive ', 5000), { active: false })
    const calls = await measuredWalk(t, (ctx, after) => leadCandidatesOf(ctx, f.admin, { after }))
    console.log('leadCandidates past 5,000 inactive people, per call', calls)
    expect(calls.reduce((n, c) => n + c.rows, 0)).toBe(3) // admin, Relay, user
    for (const call of calls) {
      expect(call.documents).toBeLessThanOrEqual(NAMED_READ.documents + 64)
      expect(call.bytes).toBeLessThan(NAMED_READ.bytes + 64 * 1024)
    }
  }, 120_000)

  /** A top-level project led by the fixture's user with 300 sub-projects,
   * each shared with six teams the caller is not in, and a caller whose only
   * grant is on the last, so the project shows to them for navigation only. */
  async function farParent(t: T, f: OrgFixture) {
    await keyOrg(t, f.org.id)
    const top = await meta(t, f, f.user)
    const me = await seat(t, f, 'Far member')
    const crews: Doc<'teams'>[] = []
    for (const name of names('Crew ', 6)) crews.push(await team(t, f.org.id, name))
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: top.id,
          key: `S${i}`,
          name: `Sub ${i}`,
          name_key: `sub ${i}`,
          description: '',
          sort_order: i,
          num: 1000 + i,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
        })
        for (const crew of crews)
          await ctx.db.insert('project_team_access', {
            project_id: id,
            team_id: crew.id,
            level: 'user',
            name_key: crew.name_key,
          })
        if (i === 299)
          await ctx.db.insert('project_access', {
            project_id: id,
            profile_id: me.id,
            level: 'user',
            name_key: me.name_key,
          })
      }
    })
    return { top, me }
  }

  it('reads the settings of a parent shown only for navigation, whose 300 sub-projects carry six team shares each, within the limits', async () => {
    // the reference: canSeeProject's walk, without limits
    const free = newT()
    const plain = await withOrg(free)
    const reference = await farParent(free, plain)
    expect(
      await free.run(async (ctx) => [
        await canSeeProject(ctx, reference.me, reference.top),
        await projectLevel(ctx, reference.me, reference.top),
      ]),
    ).toEqual([true, 'viewer'])
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const { top, me } = await farParent(t, f)
    // the walk reads each sub-project's shares, their teams and memberships,
    // past Convex's 4,096 index ranges
    await expect(t.run((ctx) => canSeeProject(ctx, me, top))).rejects.toThrow(
      /Too many index ranges/,
    )
    const got = await measured(t, (ctx) =>
      projectSettingsOf(ctx, new Map([[f.org.id, me]]), top.id),
    )
    console.log(
      'get, a parent shown for navigation, 300 sub-projects with six shares each',
      got.read,
    )
    expect(got.out).toMatchObject({ state: 'ok', level: 'viewer', can_edit: false })
    expect(got.read.ranges).toBeLessThan(100)
    // every read behind the gate answers within the limits
    expect(await read.get(t, me, top.id)).toMatchObject({ state: 'ok', level: 'viewer' })
    expect((await read.users(t, me, top.id)).state).toBe('ready')
    expect((await read.teams(t, me, top.id)).state).toBe('ready')
    for (const answer of [
      await read.candidates(t, me, { project_id: top.id }),
      await read.leadCandidates(t, me, { project_id: top.id }),
      await read.inviteTarget(t, me, top.id, 'guest@testbed.test'),
    ])
      expect(answer).toEqual({ state: 'refused', message: NO_USER_MANAGEMENT })
    // and a new sub-project under it is refused as the create refuses it
    expect(await read.leadCandidates(t, me, { parent_id: top.id })).toEqual({
      state: 'refused',
      message: LEAD_ACCESS_NEEDED,
    })
  }, 120_000)
})
