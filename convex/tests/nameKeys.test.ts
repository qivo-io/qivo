/* Tests of name keys, covering the normalizer (lib/nameKey.ts), every
 * writer that stores a key or a copy of one, the copies a rename brings in
 * line in its own transaction and in background steps (model/nameKeys.ts,
 * nameCopies.ts), the readiness stamp (org_ready) and the backfill
 * (internal/nameKeysBackfill.ts).
 *
 * withOrg plants its rows without keys, as rows stored before this release
 * are. Fake timers keep every scheduled step from running until a test
 * releases it. */
/// <reference types="vite/client" />

import { type FunctionArgs, type FunctionReturnType, makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { KEY_PAGE, RUN } from '../internal/nameKeysBackfill'
import { byId } from '../lib/db'
import { nameKey } from '../lib/nameKey'
import type { OrgExportPage, OrgExportSection } from '../lib/orgExport'
import { deleteOrgDeep } from '../model/cascade'
import { NAME_COPIES, nameKeysReady } from '../model/nameKeys'
import { STALLED_MS } from '../nameCopies'
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
  withOrg,
  workspaceOf,
} from './helpers.setup'
import { expectExact, keysOf } from './nameKeys.setup'
import { assertNoDanglingRefs } from './refs.setup'

const START = Date.parse('2026-05-04T10:00:00.000Z')
const COPY_DEFAULTS = structuredClone(NAME_COPIES)
const PAGE_DEFAULTS = { ...KEY_PAGE }
const RUN_DEFAULTS = { ...RUN }
const OPERATOR = { auth_user_id: 'operator-login', email: 'operator@platform.test' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  Object.assign(NAME_COPIES, structuredClone(COPY_DEFAULTS))
  Object.assign(KEY_PAGE, PAGE_DEFAULTS)
  Object.assign(RUN, RUN_DEFAULTS)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Runs every scheduled function, steps included, until none is left. */
const runSteps = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers)

const profileOf = (t: T, id: string) => t.run((ctx) => byId(ctx, 'profiles', id))
const teamOf = (t: T, id: string) => t.run((ctx) => byId(ctx, 'teams', id))
const projectOf = (t: T, id: string) => t.run((ctx) => byId(ctx, 'projects', id))

/** The name key copies of profile `id`, null for one without a key. */
const copiesOf = (t: T, id: string) =>
  t.run(async (ctx) => ({
    team_members: (
      await ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', id))
        .collect()
    ).map((row) => row.name_key ?? null),
    project_access: (
      await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', id))
        .collect()
    ).map((row) => row.name_key ?? null),
  }))

/** The name key copies of team `id`, null for one without a key. */
const sharesOf = (t: T, id: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('project_team_access')
        .withIndex('by_team', (q) => q.eq('team_id', id))
        .collect()
    ).map((row) => row.name_key ?? null),
  )

const jobOf = (t: T, source: 'profiles' | 'teams', id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('name_copies')
      .withIndex('by_source', (q) => q.eq('source', source).eq('source_id', id))
      .unique(),
  )

const stepsRun = (t: T) =>
  t.run(
    async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name.startsWith('nameCopies') && job.state.kind === 'success',
      ).length,
  )

/** A person of the fixture's organization in `count` new teams and with a
 * grant on `count` new projects, none of the rows keyed. */
async function plantBusyPerson(t: T, f: OrgFixture, count: number, name = 'Busy Person') {
  const person = await plantSeat(t, { org_id: f.org.id, name, email: `${uuid()}@testbed.test` })
  await t.run(async (ctx) => {
    for (let n = 0; n < count; n++) {
      const team = uuid()
      await ctx.db.insert('teams', {
        id: team,
        org_id: f.org.id,
        name: `Team ${n}`,
        track_delay_default: true,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: team,
        profile_id: person.id,
        is_leader: false,
      })
    }
  })
  for (let n = 0; n < count; n++) {
    const project = await plantProject(t, { org_id: f.org.id })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: project.id,
        profile_id: person.id,
        level: 'user',
      }),
    )
  }
  return person
}

/** A team of the fixture's organization shared with `count` new projects,
 * none of the rows keyed. */
async function plantSharedTeam(t: T, f: OrgFixture, count: number, name = 'Shared Team') {
  const team = uuid()
  await t.run((ctx) =>
    ctx.db.insert('teams', {
      id: team,
      org_id: f.org.id,
      name,
      track_delay_default: true,
      created_at: NOW,
    }),
  )
  for (let n = 0; n < count; n++) {
    const project = await plantProject(t, { org_id: f.org.id })
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: project.id,
        team_id: team,
        level: 'viewer',
      }),
    )
  }
  return (await teamOf(t, team)) as Doc<'teams'>
}

const renamePerson = (t: T, f: OrgFixture, id: string, name: string) =>
  as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch: { name } })
const renameTeam = (t: T, f: OrgFixture, id: string, name: string) =>
  as(t, f.admin).mutation(api.teams.update, { org_id: f.org.id, id, patch: { name } })

/** A Better Auth login with a live session, as the app's callers hold. */
async function withLogin(on: T, email: string, name: string) {
  const now = Date.now()
  const user = await on.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: { name, email, emailVerified: true, createdAt: now, updatedAt: now },
    },
  })
  const session = await on.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'session',
      data: {
        token: uuid(),
        userId: user._id as string,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  return {
    userId: user._id as string,
    as: on.withIdentity({ subject: user._id as string, sessionId: session._id as string }),
  }
}

describe('nameKey', () => {
  it('folds accents, case, compatibility forms and whitespace', () => {
    expect(nameKey('  Ångström \t Café\n Noël ')).toBe('angstrom cafe noel')
    expect(nameKey('ÉMILE')).toBe(nameKey('emile'))
    expect(nameKey('ﬁle ＡＢＣ')).toBe('file abc')
    expect(nameKey('Zoë Smith')).toBe('zoe smith')
    expect(nameKey('İstanbul')).toBe('istanbul')
  })

  it('keeps scripts without case or marks as they are, lowercasing the others', () => {
    expect(nameKey('東京 チーム')).toBe('東京 チーム')
    expect(nameKey('Ελληνικά')).toBe('ελληνικα')
    expect(nameKey('Москва')).toBe('москва')
  })

  it('tells apart names that differ in more than accents, case and spacing', () => {
    expect(nameKey('Anna')).not.toBe(nameKey('Anne'))
    expect(nameKey('Ann a')).not.toBe(nameKey('Anna'))
    // no decomposition folds them, and no locale rule applies
    expect(nameKey('Straße')).toBe('straße')
    expect(nameKey('Øystein')).not.toBe(nameKey('Oystein'))
    // marks that make another letter are no accents: a Devanagari vowel
    // sign, the kana voicing marks, Hebrew points
    expect(nameKey('किरण')).not.toBe(nameKey('करण'))
    expect(nameKey('が')).not.toBe(nameKey('か'))
    expect(new Set(['ハ', 'バ', 'パ'].map(nameKey)).size).toBe(3)
    expect(nameKey('שָׁלוֹם')).not.toBe(nameKey('שלום'))
  })

  it('gives a key its own key, for every code point', () => {
    for (const name of ['Ångström', 'ﷺ', 'Ǆemal', 'ΟΔΟΣ', ' a  b ', 'K', 'が', 'किरण'])
      expect(nameKey(nameKey(name))).toBe(nameKey(name))
    const changed: number[] = []
    for (let point = 0; point <= 0x10ffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue
      const key = nameKey(`x${String.fromCodePoint(point)}y`)
      if (nameKey(key) !== key) changed.push(point)
    }
    expect(changed).toEqual([])
  })
})

describe('writers', () => {
  it('keys a new person, agent and invitation, with the teams they join', async () => {
    const t = newT()
    const f = await withOrg(t)
    const person = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id: person,
      name: '  Émile   Zola ',
      email: 'emile@testbed.test',
      org_role: 'user',
      kind: 'person',
      color: '#7a7ad0',
      teams: [f.team.id],
    })
    const agent = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id: agent,
      name: 'Relay Two',
      org_role: 'user',
      kind: 'agent',
      color: '#7a7ad0',
    })
    expect((await profileOf(t, person))?.name_key).toBe('emile zola')
    expect((await profileOf(t, agent))?.name_key).toBe('relay two')
    expect(await copiesOf(t, person)).toEqual({ team_members: ['emile zola'], project_access: [] })
    // a claim adopts the seat and keeps its key
    const login = await withLogin(t, 'emile@testbed.test', 'Émile')
    await t.mutation(internal.identity.claimSeatsInternal, {
      userId: login.userId,
      email: 'emile@testbed.test',
      emailVerified: true,
    })
    expect(await profileOf(t, person)).toMatchObject({
      auth_user_id: login.userId,
      name_key: 'emile zola',
    })
  })

  it('keys a guest invitation and its grant, and the grant of a seat the address names', async () => {
    const t = newT()
    const f = await withOrg(t)
    const invite = (email: string, level: 'user' | 'viewer') =>
      as(t, f.user).mutation(api.projects.inviteGuest, {
        org_id: f.org.id,
        project_id: f.meta.id,
        email,
        level,
      })
    const guest = await invite('Ola.Nordmann@elsewhere.test', 'user')
    expect((await profileOf(t, guest.id))?.name_key).toBe('ola.nordmann')
    expect((await copiesOf(t, guest.id)).project_access).toEqual(['ola.nordmann'])
    // the fixture's admin has no grant on the project yet, and no key either
    await invite('admin@testbed.test', 'viewer')
    expect((await copiesOf(t, f.admin.id)).project_access).toEqual(['admin'])
    // a level change of a grant stored before keys gives it one
    await invite('viewer@testbed.test', 'viewer')
    expect((await copiesOf(t, f.viewer.id)).project_access).toEqual(['viewer'])
  })

  it('keys an organization, its people, starter team and leader from its creation', async () => {
    const t = newT()
    const { org_id, profile_ids } = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Nimbus Works',
      people: [
        { name: 'Ada Admin', email: 'ada@nimbus.test', role: 'admin' },
        { name: 'Bo User', email: 'bo@nimbus.test', role: 'user' },
      ],
      actor: OPERATOR,
    })
    expect(await t.run((ctx) => nameKeysReady(ctx, org_id))).toBe(true)
    await expectExact(t, org_id)
    expect((await copiesOf(t, profile_ids[0])).team_members).toEqual(['ada admin'])
    // the operator corrects a pending seat's name, and its membership follows
    await t.mutation(internal.adminOrgs.updateInvite, {
      profile_id: profile_ids[0],
      name: 'Ada Lovelace',
      email: 'ada@nimbus.test',
      actor: OPERATOR,
    })
    expect((await copiesOf(t, profile_ids[0])).team_members).toEqual(['ada lovelace'])
    await expectExact(t, org_id)

    const login = await withLogin(t, 'founder@example.test', 'Fönder')
    const created = await login.as.mutation(api.identity.createOrganization, { name: 'Founded' })
    expect(await t.run((ctx) => nameKeysReady(ctx, created))).toBe(true)
    await expectExact(t, created)
    const keys = await keysOf(t, created)
    expect(keys.team_members).toEqual([{ stored: 'fonder', wanted: 'fonder' }])
  })

  it('keys a renamed person and every membership and grant, and the teams they join', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the viewer holds a grant, the user a leader membership, both unkeyed
    await renamePerson(t, f, f.viewer.id, 'Vera Viewer')
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: f.user.id,
      patch: { name: 'Uma User' },
    })
    expect((await profileOf(t, f.viewer.id))?.name_key).toBe('vera viewer')
    expect(await copiesOf(t, f.viewer.id)).toEqual({
      team_members: [],
      project_access: ['vera viewer'],
    })
    expect((await copiesOf(t, f.user.id)).team_members).toEqual(['uma user'])
    // a team the update adds copies the key, and an unchanged name writes none
    const team = await plantSharedTeam(t, f, 0, 'Second')
    await as(t, f.admin).mutation(api.profiles.update, {
      org_id: f.org.id,
      id: f.agent.id,
      patch: { name: 'Relay', teams: [team.id] },
    })
    expect((await profileOf(t, f.agent.id))?.name_key).toBeUndefined()
    expect((await copiesOf(t, f.agent.id)).team_members).toEqual(['relay'])
  })

  it('renames every seat of a login and its copies, within one budget', async () => {
    NAME_COPIES.inline.rows = 3
    const t = newT()
    const f = await withOrg(t)
    // a second seat of the user's login, in the other organization
    const seat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      email: 'user@testbed.test',
      auth_user_id: f.user.auth_user_id,
      org_role: 'guest',
      name: 'user',
    })
    const project = await plantProject(t, { org_id: f.otherOrg.id })
    await t.run(async (ctx) => {
      for (const p of [f.meta, f.sub, f.sub2])
        await ctx.db.insert('project_access', {
          project_id: p.id,
          profile_id: f.user.id,
          level: 'user',
        })
      await ctx.db.insert('project_access', {
        project_id: project.id,
        profile_id: seat.id,
        level: 'user',
      })
    })
    expect(await as(t, f.user).mutation(api.profiles.setDisplayName, { name: 'Ursula' })).toBe(null)
    expect((await profileOf(t, f.user.id))?.name_key).toBe('ursula')
    expect((await profileOf(t, seat.id))?.name_key).toBe('ursula')
    // one membership and three grants for the first seat and one grant for
    // the second, so the budget of three leaves two for the steps
    const before = [
      ...Object.values(await copiesOf(t, f.user.id)).flat(),
      ...Object.values(await copiesOf(t, seat.id)).flat(),
    ]
    expect(before.filter((key) => key === 'ursula')).toHaveLength(3)
    expect(await jobOf(t, 'profiles', f.user.id)).not.toBeNull()
    expect(await jobOf(t, 'profiles', seat.id)).not.toBeNull()
    await runSteps(t)
    expect(await copiesOf(t, f.user.id)).toEqual({
      team_members: ['ursula'],
      project_access: ['ursula', 'ursula', 'ursula'],
    })
    expect((await copiesOf(t, seat.id)).project_access).toEqual(['ursula'])
    expect(await jobOf(t, 'profiles', f.user.id)).toBeNull()
    expect(await jobOf(t, 'profiles', seat.id)).toBeNull()
  })

  it('keys a team, a renamed team and its shares, and a member it adds', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id, name: 'Ops  Crew' })
    expect((await teamOf(t, id))?.name_key).toBe('ops crew')
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: id,
      profile_id: f.viewer.id,
    })
    expect((await copiesOf(t, f.viewer.id)).team_members).toEqual(['viewer'])
    const shared = await plantSharedTeam(t, f, 2, 'Old Name')
    await renameTeam(t, f, shared.id, 'Ünique')
    expect((await teamOf(t, shared.id))?.name_key).toBe('unique')
    expect(await sharesOf(t, shared.id)).toEqual(['unique', 'unique'])
    expect(await jobOf(t, 'teams', shared.id)).toBeNull()
  })

  it('keys a project, a sub-project, a rename and every grant and share it writes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.projects.create, {
      org_id: f.org.id,
      id,
      type: 'meta',
      key: 'NEW',
      name: 'Nouveau  Projet',
      sort_order: 0,
      lead_id: f.user.id,
      access: { [f.viewer.id]: 'viewer' },
      team_access: { [f.team.id]: 'user' },
    })
    expect((await projectOf(t, id))?.name_key).toBe('nouveau projet')
    const sub = uuid()
    await as(t, f.user).mutation(api.projects.create, {
      org_id: f.org.id,
      id: sub,
      type: 'project',
      parent_id: id,
      key: 'NEWS',
      name: 'Sous-Projet',
      sort_order: 0,
    })
    expect((await projectOf(t, sub))?.name_key).toBe('sous-projet')
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id,
      patch: { name: 'Renamed Project' },
    })
    expect((await projectOf(t, id))?.name_key).toBe('renamed project')
    // one grant and one share through setAccess, a level change of each
    // and the access maps of an update
    const setAccess = (
      target: { user_id: string } | { team_id: string },
      level: 'user' | 'viewer',
    ) => as(t, f.user).mutation(api.projects.setAccess, { org_id: f.org.id, id, ...target, level })
    await setAccess({ user_id: f.guest.id }, 'viewer')
    await setAccess({ user_id: f.guest.id }, 'user')
    const team = await plantSharedTeam(t, f, 0, 'Late Team')
    await setAccess({ team_id: team.id }, 'viewer')
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id,
      // a map names every grant it keeps
      patch: {
        access: { [f.viewer.id]: 'viewer', [f.guest.id]: 'user', [f.admin.id]: 'user' },
        team_access: { [f.team.id]: 'viewer', [team.id]: 'viewer' },
      },
    })
    const rows = await t.run(async (ctx) => ({
      grants: (
        await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .collect()
      ).map((g): [string, string | null] => [g.profile_id, g.name_key ?? null]),
      shares: (
        await ctx.db
          .query('project_team_access')
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .collect()
      ).map((g): [string, string | null] => [g.team_id, g.name_key ?? null]),
    }))
    expect(new Map(rows.grants)).toEqual(
      new Map([
        [f.viewer.id, 'viewer'],
        [f.guest.id, 'guest'],
        [f.admin.id, 'admin'],
      ]),
    )
    expect(new Map(rows.shares)).toEqual(
      new Map([
        [f.team.id, 'hardware'],
        [team.id, 'late team'],
      ]),
    )
  })

  it('keys the Viewer grant that keeps a removed member on their tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const member = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Kept Member',
      email: 'kept@testbed.test',
    })
    const project = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: member.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.hidden.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await plantIssue(t, { org_id: f.org.id, project_id: project.id, assignee_id: member.id })
    await as(t, f.admin).mutation(api.teams.removeMember, {
      org_id: f.org.id,
      team_id: f.team.id,
      profile_id: member.id,
      on_held_tasks: 'keep_as_viewer',
    })
    expect((await copiesOf(t, member.id)).project_access).toEqual(['kept member'])
  })
})

describe('the over-limit name repair', () => {
  it('gives a cut name its key and lets the copies follow', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 80 code points that are 81 UTF-16 units, valid before names counted units
    const long = `${'Ä'.repeat(79)}😀`
    await t.run(async (ctx) => {
      await ctx.db.patch(f.user._id, { name: long })
      await ctx.db.patch(f.team._id, { name: long })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'viewer',
      })
    })
    await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    const cut = 'a'.repeat(79)
    expect((await profileOf(t, f.user.id))?.name_key).toBe(cut)
    expect((await teamOf(t, f.team.id))?.name_key).toBe(cut)
    expect((await copiesOf(t, f.user.id)).team_members).toEqual([cut])
    expect(await sharesOf(t, f.team.id)).toEqual([cut])
  })
})

describe('Deleted items', () => {
  it('writes a project back with the keys of the current names', async () => {
    const t = newT()
    const f = await withOrg(t)
    // keyed with the names they have now, but for one sub-project stored
    // before keys, which comes back with one too
    await t.run(async (ctx) => {
      for (const p of [f.meta, f.sub]) await ctx.db.patch(p._id, { name_key: nameKey(p.name) })
      for (const grant of await ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
        .collect()) {
        const person = await byId(ctx, 'profiles', grant.profile_id)
        await ctx.db.patch(grant._id, { name_key: nameKey(person!.name) })
      }
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'viewer',
        name_key: nameKey(f.team.name),
      })
    })
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    await runSteps(t)
    const stored = await t.run(async (ctx) =>
      (await ctx.db.query('deleted_rows').collect()).flatMap(({ row }) =>
        row.table === 'projects' ||
        row.table === 'project_access' ||
        row.table === 'project_team_access'
          ? [[row.table, row.doc.name_key ?? null]]
          : [],
      ),
    )
    expect(stored.sort()).toEqual(
      [
        ['projects', 'testbed platform'],
        ['projects', 'firmware'],
        ['projects', null],
        ['project_access', 'guest'],
        ['project_access', 'viewer'],
        ['project_team_access', 'hardware'],
      ].sort(),
    )
    // renamed while the project, its grants and its share are stored
    await renamePerson(t, f, f.guest.id, 'Gästa')
    await renameTeam(t, f, f.team.id, 'Hårdvara')
    const item = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', f.meta.id))
        .unique(),
    )
    await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id: f.org.id,
      ids: [item!.id],
    })
    await runSteps(t)
    for (const p of [f.meta, f.sub, f.sub2])
      expect((await projectOf(t, p.id))?.name_key).toBe(nameKey(p.name))
    expect((await copiesOf(t, f.guest.id)).project_access).toEqual(['gasta'])
    expect((await copiesOf(t, f.viewer.id)).project_access).toEqual(['viewer'])
    expect(await sharesOf(t, f.team.id)).toEqual(['hardvara'])
    await assertNoDanglingRefs(t, 'after a project came back with keys')
  })
})

describe('copies after a rename', () => {
  it('brings up to the inline budget in line at once and the rest in steps', async () => {
    NAME_COPIES.inline.rows = 2
    NAME_COPIES.step.rows = 3
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 4)
    await renamePerson(t, f, person.id, 'Renée')
    const copies = Object.values(await copiesOf(t, person.id)).flat()
    expect(copies.filter((key) => key === 'renee')).toHaveLength(2)
    // a copy that trails the rename still has a key or none, never another row's
    expect(copies).toHaveLength(8)
    const job = await jobOf(t, 'profiles', person.id)
    expect(job).toMatchObject({ progress_at: new Date(START).toISOString() })
    expect(job?.scheduled_id).toBeDefined()

    await runSteps(t)
    expect(await copiesOf(t, person.id)).toEqual({
      team_members: Array(4).fill('renee'),
      project_access: Array(4).fill('renee'),
    })
    expect(await jobOf(t, 'profiles', person.id)).toBeNull()
    expect(await stepsRun(t)).toBe(2) // 3 + 3
    await assertNoDanglingRefs(t, 'after the copies followed a rename')
  })

  it('starts no job for a rename whose copies fit the inline budget', async () => {
    NAME_COPIES.inline.rows = 4
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 2)
    await renamePerson(t, f, person.id, 'Fits')
    expect(await copiesOf(t, person.id)).toEqual({
      team_members: ['fits', 'fits'],
      project_access: ['fits', 'fits'],
    })
    expect(await jobOf(t, 'profiles', person.id)).toBeNull()
    // one more copy than the budget starts one
    const busier = await plantBusyPerson(t, f, 3, 'Busier')
    await renamePerson(t, f, busier.id, 'Over')
    expect(await jobOf(t, 'profiles', busier.id)).not.toBeNull()
  })

  it('ends with the last rename when renames and steps interleave', async () => {
    NAME_COPIES.inline.rows = 1
    NAME_COPIES.step.rows = 2
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 3)
    await renamePerson(t, f, person.id, 'First')
    const job = (await jobOf(t, 'profiles', person.id))!
    // a step runs between the renames, then a second rename finds its
    // step waiting and leaves the one row
    await t.mutation(internal.nameCopies.step, { source: 'profiles', source_id: person.id })
    await renamePerson(t, f, person.id, 'Second')
    const second = (await jobOf(t, 'profiles', person.id))!
    expect(second._id).toBe(job._id)
    await renamePerson(t, f, person.id, 'Third')
    expect((await jobOf(t, 'profiles', person.id))?._id).toBe(job._id)
    await runSteps(t)
    expect(Object.values(await copiesOf(t, person.id)).flat()).toEqual(Array(6).fill('third'))
    expect(await jobOf(t, 'profiles', person.id)).toBeNull()
  })

  it('brings a renamed team’s shares in line in steps', async () => {
    NAME_COPIES.inline.rows = 1
    NAME_COPIES.step.rows = 1
    const t = newT()
    const f = await withOrg(t)
    const team = await plantSharedTeam(t, f, 3)
    await renameTeam(t, f, team.id, 'Sharers')
    expect((await sharesOf(t, team.id)).filter((key) => key === 'sharers')).toHaveLength(1)
    await runSteps(t)
    expect(await sharesOf(t, team.id)).toEqual(Array(3).fill('sharers'))
    expect(await jobOf(t, 'teams', team.id)).toBeNull()
    expect(await stepsRun(t)).toBe(2)
  })

  it('resumes a dropped step once it stalls and leaves a waiting step alone', async () => {
    NAME_COPIES.inline.rows = 1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 2)
    await renamePerson(t, f, person.id, 'Stalled')
    const dropped = (await jobOf(t, 'profiles', person.id))!
    await t.run((ctx) => ctx.scheduler.cancel(dropped.scheduled_id!))
    // a fresh row is not stalled yet
    await t.mutation(internal.nameCopies.recover, {})
    expect(await jobOf(t, 'profiles', person.id)).toEqual(dropped)

    vi.setSystemTime(START + STALLED_MS + 1)
    await t.mutation(internal.nameCopies.recover, {})
    const resumed = (await jobOf(t, 'profiles', person.id))!
    expect(resumed.scheduled_id).not.toBe(dropped.scheduled_id)
    expect(resumed.progress_at).toBe(new Date(START + STALLED_MS + 1).toISOString())
    expect(warn).toHaveBeenCalledWith(
      'Name key copies resumed',
      expect.objectContaining({ source: 'profiles', source_id: person.id }),
    )
    // its step waits, so a later sweep starts no second chain
    vi.setSystemTime(START + 3 * STALLED_MS)
    await t.mutation(internal.nameCopies.recover, {})
    expect(await jobOf(t, 'profiles', person.id)).toEqual(resumed)
    // nor does another rename
    await renamePerson(t, f, person.id, 'Resumed')
    expect((await jobOf(t, 'profiles', person.id))?.scheduled_id).toBe(resumed.scheduled_id)

    await runSteps(t)
    expect(Object.values(await copiesOf(t, person.id)).flat()).toEqual(Array(4).fill('resumed'))
    expect(await jobOf(t, 'profiles', person.id)).toBeNull()
  })

  it('restarts a job whose step was dropped when the next rename comes first', async () => {
    NAME_COPIES.inline.rows = 1
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 2)
    await renamePerson(t, f, person.id, 'Dropped')
    const dropped = (await jobOf(t, 'profiles', person.id))!
    await t.run((ctx) => ctx.scheduler.cancel(dropped.scheduled_id!))
    // the next rename comes before recovery would see the row stalled
    vi.setSystemTime(START + 1000)
    await renamePerson(t, f, person.id, 'Restarted')
    const restarted = (await jobOf(t, 'profiles', person.id))!
    expect(restarted._id).toBe(dropped._id)
    expect(restarted.scheduled_id).not.toBe(dropped.scheduled_id)
    expect(restarted.progress_at).toBe(new Date(START + 1000).toISOString())
    const next = await t.run((ctx) => ctx.db.system.get(restarted.scheduled_id!))
    expect(next?.state.kind).toBe('pending')
    const rows = await t.run((ctx) => ctx.db.query('name_copies').collect())
    expect(rows.filter((row) => row.source_id === person.id)).toHaveLength(1)

    await runSteps(t)
    expect(Object.values(await copiesOf(t, person.id)).flat()).toEqual(Array(4).fill('restarted'))
    expect(await jobOf(t, 'profiles', person.id)).toBeNull()
  })

  it('stops a pass at its bytes, one chunk past them at most', async () => {
    NAME_COPIES.chunk = 2
    NAME_COPIES.inline = { rows: 100, bytes: 1 }
    NAME_COPIES.step = { rows: 100, bytes: 1 }
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 4)
    await renamePerson(t, f, person.id, 'Bytes')
    // one chunk of two memberships, then the bytes are spent
    expect(
      Object.values(await copiesOf(t, person.id))
        .flat()
        .filter((k) => k === 'bytes'),
    ).toHaveLength(2)
    await runSteps(t)
    expect(Object.values(await copiesOf(t, person.id)).flat()).toEqual(Array(8).fill('bytes'))
    // the rest of the memberships, then two chunks of grants
    expect(await stepsRun(t)).toBe(3)
  })

  it('never passes a job to a team that takes the id of a deleted one', async () => {
    NAME_COPIES.inline.rows = 1
    const t = newT()
    const f = await withOrg(t)
    const team = await plantSharedTeam(t, f, 2, 'Old Team')
    await renameTeam(t, f, team.id, 'Old Renamed')
    const old = (await jobOf(t, 'teams', team.id))!
    expect(old.source_created).toBe(team._creationTime)
    await t.run((ctx) => ctx.scheduler.cancel(old.scheduled_id!))
    await as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: team.id })
    // another organization's team takes the freed id, with a share whose
    // key a step for it would change
    await as(t, f.otherAdmin).mutation(api.teams.create, {
      org_id: f.otherOrg.id,
      id: team.id,
      name: 'Newcomer',
    })
    const project = await plantProject(t, { org_id: f.otherOrg.id })
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: project.id,
        team_id: team.id,
        level: 'viewer',
        name_key: 'planted',
      }),
    )
    await t.mutation(internal.nameCopies.step, { source: 'teams', source_id: team.id })
    expect(await jobOf(t, 'teams', team.id)).toBeNull()
    expect(await sharesOf(t, team.id)).toEqual(['planted'])
  })

  it('lets a rename of the team that took the id take the job over', async () => {
    NAME_COPIES.inline.rows = 1
    const t = newT()
    const f = await withOrg(t)
    const team = await plantSharedTeam(t, f, 2, 'Old Team')
    await renameTeam(t, f, team.id, 'Old Renamed')
    const old = (await jobOf(t, 'teams', team.id))!
    await t.run((ctx) => ctx.scheduler.cancel(old.scheduled_id!))
    await as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: team.id })
    await as(t, f.otherAdmin).mutation(api.teams.create, {
      org_id: f.otherOrg.id,
      id: team.id,
      name: 'Newcomer',
    })
    const fresh = (await teamOf(t, team.id))!
    await t.run(async (ctx) => {
      for (let n = 0; n < 2; n++) {
        const project = uuid()
        await ctx.db.insert('project_team_access', {
          project_id: project,
          team_id: team.id,
          level: 'viewer',
        })
      }
    })
    await as(t, f.otherAdmin).mutation(api.teams.update, {
      org_id: f.otherOrg.id,
      id: team.id,
      patch: { name: 'Taken Over' },
    })
    const taken = (await jobOf(t, 'teams', team.id))!
    expect(taken._id).toBe(old._id)
    expect(taken.source_created).toBe(fresh._creationTime)
    expect(taken.scheduled_id).not.toBe(old.scheduled_id)
    await runSteps(t)
    expect(await sharesOf(t, team.id)).toEqual(['taken over', 'taken over'])
    expect(await jobOf(t, 'teams', team.id)).toBeNull()
  })

  it('ends a job whose profile or team is gone', async () => {
    NAME_COPIES.inline.rows = 1
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 2)
    const team = await plantSharedTeam(t, f, 2)
    await renamePerson(t, f, person.id, 'Leaving')
    await renameTeam(t, f, team.id, 'Going')
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: person.id })
    await t.run((ctx) => ctx.db.delete(team._id))
    await t.mutation(internal.nameCopies.step, { source: 'profiles', source_id: person.id })
    await t.mutation(internal.nameCopies.step, { source: 'teams', source_id: team.id })
    expect(await jobOf(t, 'profiles', person.id)).toBeNull()
    expect(await jobOf(t, 'teams', team.id)).toBeNull()
    // a step for a job already gone does nothing
    await t.mutation(internal.nameCopies.step, { source: 'teams', source_id: team.id })
  })
})

describe('readiness', () => {
  it('holds for an organization created now and not for one stored before keys', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await t.run((ctx) => nameKeysReady(ctx, f.org.id))).toBe(false)
    const { org_id } = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Fresh',
      people: [],
      actor: OPERATOR,
    })
    expect(await t.run((ctx) => nameKeysReady(ctx, org_id))).toBe(true)
    // a row without the stamp is not ready either
    await t.run((ctx) => ctx.db.insert('org_ready', { org_id: f.org.id }))
    expect(await t.run((ctx) => nameKeysReady(ctx, f.org.id))).toBe(false)
  })

  it('goes with its organization', async () => {
    const t = newT()
    const { org_id } = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Doomed',
      people: [{ name: 'Ada Admin', email: 'ada@doomed.test', role: 'admin' }],
      actor: OPERATOR,
    })
    await t.run(async (ctx) => {
      const org = await byId(ctx, 'organizations', org_id)
      await deleteOrgDeep(ctx, org!)
    })
    expect(await t.run((ctx) => ctx.db.query('org_ready').collect())).toEqual([])
  })

  it('never reaches the app or the export', async () => {
    const t = newT()
    const f = await withOrg(t)
    // keyed rows of every table, from their writers
    const id = uuid()
    await as(t, f.admin).mutation(api.projects.create, {
      org_id: f.org.id,
      id,
      type: 'meta',
      key: 'KEYED',
      name: 'Keyed',
      sort_order: 0,
      lead_id: f.user.id,
      access: { [f.viewer.id]: 'viewer' },
      team_access: { [f.team.id]: 'user' },
    })
    await renamePerson(t, f, f.admin.id, 'Keyed Admin')
    await renameTeam(t, f, f.team.id, 'Keyed Team')
    const keyed = Object.values(await keysOf(t, f.org.id)).map(
      (rows) => rows.filter((row) => row.stored !== undefined).length,
    )
    expect(keyed.every((count) => count > 0)).toBe(true)
    const snap = (await workspaceOf(as(t, f.admin)))!
    const rows = [
      ...snap.profiles,
      ...snap.teamMembers,
      ...snap.teams,
      ...snap.projects,
      ...snap.access,
      ...snap.teamAccess,
    ]
    expect(rows.length).toBeGreaterThan(10)
    for (const row of rows) expect(row).not.toHaveProperty('name_key')
    const page = makeFunctionReference<
      'query',
      { org_id: string; section: OrgExportSection; parent_id?: string; cursor: string | null },
      OrgExportPage
    >('orgExport:page')
    for (const section of ['profiles', 'teams', 'projects'] as const) {
      const exported = await as(t, f.admin).query(page, {
        org_id: f.org.id,
        section,
        cursor: null,
      })
      expect(exported.rows.length).toBeGreaterThan(0)
      for (const row of exported.rows) expect(row).not.toHaveProperty('name_key')
    }
    for (const [section, parent] of [
      ['team_members', f.team.id],
      ['project_access', id],
      ['project_team_access', id],
    ] as const) {
      const exported = await as(t, f.admin).query(page, {
        org_id: f.org.id,
        section,
        parent_id: parent,
        cursor: null,
      })
      expect(exported.rows.length).toBeGreaterThan(0)
      for (const row of exported.rows) expect(row).not.toHaveProperty('name_key')
    }
  })
})

describe('the backfill', () => {
  type RunArgs = FunctionArgs<typeof internal.internal.nameKeysBackfill.run>
  type RunResult = FunctionReturnType<typeof internal.internal.nameKeysBackfill.run>
  const run = (t: T, args: RunArgs) => t.action(internal.internal.nameKeysBackfill.run, args)
  const zero = { missing: 0, stale: 0 }

  /** Calls run, each call from the cursor the one before answered, until it
   * answers `done`, and answers every call's result. */
  async function drain(t: T, dry_run: boolean): Promise<RunResult[]> {
    const calls: RunResult[] = []
    let cursor: RunArgs['cursor']
    for (let n = 0; n < 200; n++) {
      const got = await run(t, { dry_run, ...(cursor === undefined ? {} : { cursor }) })
      calls.push(got)
      if (got.done) return calls
      cursor = got.cursor ?? undefined
    }
    throw new Error('the backfill did not finish in 200 calls')
  }

  /** The keys of `calls` summed by table. */
  const summed = (calls: RunResult[]) =>
    Object.fromEntries(
      Object.keys(calls[0].keys).map((table) => [
        table,
        {
          missing: calls.reduce(
            (sum, call) => sum + call.keys[table as keyof RunResult['keys']].missing,
            0,
          ),
          stale: calls.reduce(
            (sum, call) => sum + call.keys[table as keyof RunResult['keys']].stale,
            0,
          ),
        },
      ]),
    )

  it('reports without writing, then keys and stamps every organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const dry = await run(t, { dry_run: true })
    expect(dry).toMatchObject({
      dry_run: true,
      orgs: 2,
      stamped: 0,
      at_least: false,
      done: true,
      cursor: null,
      keys: {
        // five people and an agent here, an admin in the other organization
        profiles: { missing: 6, stale: 0 },
        teams: { missing: 1, stale: 0 },
        projects: { missing: 5, stale: 0 },
        team_members: { missing: 2, stale: 0 },
        project_access: { missing: 2, stale: 0 },
        project_team_access: zero,
      },
    })
    expect(dry.unstamped?.sort()).toEqual([f.org.id, f.otherOrg.id].sort())
    expect(dry.to_fix.map((o) => o.org_id).sort()).toEqual([f.org.id, f.otherOrg.id].sort())
    // a dry run writes nothing
    expect((await keysOf(t, f.org.id)).profiles.every((p) => p.stored === undefined)).toBe(true)
    expect(await t.run((ctx) => ctx.db.query('org_ready').collect())).toEqual([])

    const done = await run(t, { dry_run: false })
    expect(done).toMatchObject({ dry_run: false, orgs: 2, stamped: 2, done: true })
    expect(done.keys).toEqual(dry.keys)
    await expectExact(t, f.org.id)
    await expectExact(t, f.otherOrg.id)
    expect(await t.run((ctx) => nameKeysReady(ctx, f.org.id))).toBe(true)
    expect(await t.run((ctx) => nameKeysReady(ctx, f.otherOrg.id))).toBe(true)
    const audit = await t.run((ctx) =>
      ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'name_keys_backfill'))
        .collect(),
    )
    expect(audit.map((row) => [row.actor_email, row.detail])).toEqual([
      ['system', { orgs: 2, stamped: 2, missing: 16, stale: 0, done: true, cursor: null }],
    ])

    const again = await run(t, { dry_run: true })
    expect(Object.values(again.keys)).toEqual(Array(6).fill(zero))
    expect(again.unstamped).toEqual([])
    expect(again.to_fix).toEqual([])
    // a run walks the stamped organizations too, and finds nothing
    expect(await run(t, { dry_run: false })).toMatchObject({
      orgs: 2,
      stamped: 0,
      keys: again.keys,
    })
    await assertNoDanglingRefs(t, 'after the name key backfill')
  })

  it('finds stale keys in a stamped organization and mends them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await run(t, { dry_run: false })
    await t.run(async (ctx) => {
      await ctx.db.patch(f.viewer._id, { name_key: 'not the name' })
      const member = await ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', f.admin.id))
        .unique()
      await ctx.db.patch(member!._id, { name_key: 'stale' })
    })
    const dry = await run(t, { dry_run: true })
    expect(dry.keys.profiles).toEqual({ missing: 0, stale: 1 })
    expect(dry.keys.team_members).toEqual({ missing: 0, stale: 1 })
    expect(dry.to_fix).toEqual([{ org_id: f.org.id, missing: 0, stale: 2 }])
    expect(await run(t, { dry_run: false })).toMatchObject({ orgs: 2, stamped: 0, keys: dry.keys })
    await expectExact(t, f.org.id)
  })

  it('finishes a person with more copies than one page brings in line', async () => {
    KEY_PAGE.copies = 3
    KEY_PAGE.rows = 2
    const t = newT()
    const f = await withOrg(t)
    const person = await plantBusyPerson(t, f, 4)
    const dry = await run(t, { dry_run: true })
    // the dry run counts no more copies a page than one step brings in line
    expect(dry.at_least).toBe(true)
    expect(dry.keys.team_members.missing + dry.keys.project_access.missing).toBeLessThan(10)
    await run(t, { dry_run: false })
    expect(await copiesOf(t, person.id)).toEqual({
      team_members: Array(4).fill('busy person'),
      project_access: Array(4).fill('busy person'),
    })
    await expectExact(t, f.org.id)
    expect((await run(t, { dry_run: true })).at_least).toBe(false)
  })

  it.each([1, 100])(
    'stops after a step past its time and goes on inside an organization, %i organizations a read',
    async (orgs) => {
      const t = newT()
      const f = await withOrg(t)
      const whole = await run(t, { dry_run: true })
      expect(whole.done).toBe(true)
      RUN.orgs = orgs
      RUN.ms = 0
      KEY_PAGE.rows = 2
      // every call takes one step, so the counts of a dry run split over
      // calls add up to one call's only when no call walks a page again
      const dry = await drain(t, true)
      expect(summed(dry)).toEqual(whole.keys)
      expect(dry.length).toBeGreaterThan(5)
      const [first] = dry
      expect(first).toMatchObject({ done: false, orgs: 0, cursor: { dry_run: true } })
      const inside = dry.flatMap((call) =>
        call.cursor !== null && 'org_id' in call.cursor ? [call.cursor] : [],
      )
      // some call stopped inside a table, past its first page
      expect(inside.some((cursor) => typeof cursor.page === 'string')).toBe(true)
      // a call that finished an organization answers the next one's start
      expect(
        dry.some(
          (call) =>
            call.orgs === 1 &&
            call.cursor !== null &&
            'org_id' in call.cursor &&
            call.cursor.table === 'profiles' &&
            call.cursor.page === null,
        ),
      ).toBe(true)

      const runs = await drain(t, false)
      expect(summed(runs)).toEqual(whole.keys)
      expect(runs.reduce((sum, call) => sum + call.stamped, 0)).toBe(2)
      await expectExact(t, f.org.id)
      await expectExact(t, f.otherOrg.id)
      expect(await t.run((ctx) => nameKeysReady(ctx, f.org.id))).toBe(true)
      expect(await t.run((ctx) => nameKeysReady(ctx, f.otherOrg.id))).toBe(true)
      // a cursor from a dry run does not resume a run that writes
      await expect(run(t, { dry_run: false, cursor: first.cursor! })).rejects.toThrow(
        'other dry_run',
      )
    },
  )

  it('records what committed when a step throws, and goes on from that step', async () => {
    KEY_PAGE.rows = 1
    // withOrg writes 20 documents in one transaction
    const t = newT({ transactionLimits: { documentsWritten: 20 } })
    const f = await withOrg(t)
    // the fixture's people each write two rows at most, this one 21
    const busy = await plantBusyPerson(t, f, 10)
    const failed = await run(t, { dry_run: false })
    expect(failed).toMatchObject({ done: false, error: expect.any(String) })
    expect(failed.cursor).toMatchObject({ table: 'profiles', page: expect.any(String) })
    const audit = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query('platform_audit_log')
            .filter((q) => q.eq(q.field('action'), 'name_keys_backfill'))
            .collect(),
        )
      ).map((row) => row.detail)
    expect(await audit()).toEqual([
      {
        orgs: failed.orgs,
        stamped: failed.stamped,
        missing: Object.values(failed.keys).reduce((sum, k) => sum + k.missing, 0),
        stale: 0,
        done: false,
        cursor: failed.cursor,
        error: failed.error,
      },
    ])
    expect((await profileOf(t, busy.id))?.name_key).toBeUndefined()
    // a page that brings fewer copies in line at once fits
    KEY_PAGE.copies = 10
    let last = await run(t, { dry_run: false, cursor: failed.cursor! })
    while (!last.done) last = await run(t, { dry_run: false, cursor: last.cursor! })
    expect(last.error).toBeUndefined()
    await expectExact(t, f.org.id)
    await expectExact(t, f.otherOrg.id)
  })

  it('leaves the copies of a removed person alone and keys rows written while it runs', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a membership whose profile is gone, waiting for its cleanup
    const gone = uuid()
    await t.run((ctx) =>
      ctx.db.insert('team_members', { team_id: f.team.id, profile_id: gone, is_leader: false }),
    )
    // one page of each table at a time, and a rename between two of them
    KEY_PAGE.rows = 1
    const page = (cursor: string | null) =>
      t.mutation(internal.internal.nameKeysBackfill.step, {
        org_id: f.org.id,
        table: 'profiles',
        cursor,
      })
    const first = await page(null)
    expect(first.done).toBe(false)
    await renamePerson(t, f, f.admin.id, 'Renamed Admin')
    let at = first.cursor
    for (;;) {
      const got = await page(at)
      if (got.done) break
      at = got.cursor
    }
    expect((await profileOf(t, f.admin.id))?.name_key).toBe('renamed admin')
    expect((await copiesOf(t, f.admin.id)).team_members).toEqual(['renamed admin'])
    const orphan = await t.run((ctx) =>
      ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', gone))
        .unique(),
    )
    expect(orphan?.name_key).toBeUndefined()
    const check = await t.query(internal.internal.nameKeysBackfill.check, {
      org_id: f.org.id,
      table: 'profiles',
    })
    expect(check.keys.team_members).toEqual(zero)
  })
})
