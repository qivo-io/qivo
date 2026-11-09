/* The workspace's one part (workspace.ts root, lib/workspaceParts.ts
 * readRoot): what it sends and reads, and an answer that stays the same
 * while the data it reads does, so Convex re-sends it only when it
 * changes, never for a task. Beside it, what the tasks part left: the
 * window keys every writer still gives a task and its relation rows, with
 * the indexes that read them gone, and where a person is shown a task by
 * each kind of grant, on the task window's read (taskWindow.task). */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { accessUnchecked, OWN_READS } from '../lib/access'
import { newWindowKey } from '../lib/db'
import { navByIdsOf } from '../model/projectNavReads'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  patchCounters,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
  withReadingAdmin,
  workspaceOf,
} from './helpers.setup'
import { ready } from './projectNavFixtures.setup'
import { plantTicket } from './uploadTickets.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it (as snapshot.test.ts) */
declare class Blob {
  constructor(parts: string[])
}

const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  vi.restoreAllMocks()
})

/* `n` tasks in the sub-project the fixture's guest can see, each with a
 * label, oldest first. */
async function plantTasks(t: T, f: OrgFixture, n: number, extra: Partial<Doc<'issues'>> = {}) {
  const tasks: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++) {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...extra })
    await t.run((ctx) =>
      ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: task.id,
        label_id: 'label',
        task_key: task.window_key,
      }),
    )
    tasks.push(task)
  }
  return tasks
}

/* Convex's limits on what one transaction may read. */
const REAL_LIMITS = {
  transactionLimits: { bytesRead: 16 * 1024 * 1024, documentsRead: 32_000, databaseQueries: 4096 },
}

describe('window keys', () => {
  it("the server picks a new task's key, so a writer who crowds ids into one window does not crowd the windows", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const ids = [0, 1, 2].map((i) => `abc00000-0000-4000-8000-00000000000${i}`)
    for (const id of ids)
      await as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Crowded',
      })
    const keys = await t.run(async (ctx) =>
      Promise.all(
        ids.map(
          async (id) =>
            (await ctx.db
              .query('issues')
              .withIndex('by_uuid', (q) => q.eq('id', id))
              .unique())!.window_key,
        ),
      ),
    )
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}$/)
    expect(new Set(keys).size).toBe(3)
  })

  it("every writer of a relation row gives it its task's key", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [a, b] = [uuid(), uuid()]
    const admin = as(t, f.admin)
    for (const id of [a, b])
      await admin.mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Keyed',
      })
    const label = uuid()
    await admin.mutation(api.labels.create, {
      org_id: f.org.id,
      id: label,
      name: 'Keyed',
      color: '#335577',
    })
    await admin.mutation(api.labels.toggle, {
      org_id: f.org.id,
      issue_id: a,
      label_id: label,
      on: true,
    })
    await admin.mutation(api.issues.addLink, {
      org_id: f.org.id,
      id: uuid(),
      source_id: b,
      target_id: a,
      type: 'blocks',
    })
    await as(t, f.user).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: a })
    // a file, attached as the app attaches one after its upload
    const storage_id = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(['spec']) as never),
    )
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', a))
        .unique(),
    )
    if (stored === null) throw new Error('no task a')
    await plantTicket(t, { profile: f.admin, issue: stored, storageId: storage_id })
    await admin.mutation(api.files.attach, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: a,
      storage_id,
      name: 'spec.pdf',
      inline: false,
    })
    const keyed = await t.run(async (ctx) => {
      const keyOf = async (id: string) =>
        (await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique())!.window_key
      return {
        a: await keyOf(a),
        b: await keyOf(b),
        labels: (
          await ctx.db
            .query('issue_labels')
            .withIndex('by_issue', (q) => q.eq('issue_id', a))
            .collect()
        ).map((r) => r.task_key),
        links: (
          await ctx.db
            .query('issue_links')
            .withIndex('by_source', (q) => q.eq('source_id', b))
            .collect()
        ).map((r) => r.task_key),
        follows: (
          await ctx.db
            .query('issue_subscriptions')
            .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', a))
            .collect()
        ).map((r) => r.task_key),
        attachments: (
          await ctx.db
            .query('issue_attachments')
            .withIndex('by_issue', (q) => q.eq('issue_id', a))
            .collect()
        ).map((r) => r.task_key),
      }
    })
    expect(keyed.a).toMatch(/^[0-9a-f]{8}$/)
    expect(keyed.labels).toEqual([keyed.a])
    expect(keyed.links).toEqual([keyed.b])
    expect(keyed.follows.length).toBeGreaterThan(0)
    for (const key of keyed.follows) expect(key).toBe(keyed.a)
    expect(keyed.attachments).toEqual([keyed.a])
  })
})

describe('an answer Convex need not re-send', () => {
  it('is the same on every run of the same data, and logs nothing', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await plantTasks(t, f, 3)
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const first = await workspaceOf(as(t, f.user))
    expect(await workspaceOf(as(t, f.user))).toEqual(first)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays the same through a task rename, archive and delete, and changes with a task create', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [a, b] = await plantTasks(t, f, 2)
    const read = async () => JSON.stringify(await as(t, f.user).query(api.workspace.root, {}))
    const before = await read()
    await as(t, f.user).mutation(api.issues.update, {
      org_id: f.org.id,
      id: a.id,
      patch: { title: 'Renamed elsewhere' },
    })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: b.id })
    expect(await read()).toBe(before)
    // a create moves the task number the creates preview from, and nothing
    // else of the answer
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Another',
    })
    const after = JSON.parse(await read()) as { orgs: { next_issue_num: number }[] }
    const was = JSON.parse(before) as typeof after
    expect(after.orgs[0].next_issue_num).toBe(was.orgs[0].next_issue_num + 1)
    expect({ ...after, orgs: was.orgs }).toEqual(was)
  })
})

/* `n` more people of organization `orgId`, inserted in writes of 100. */
async function plantRoster(t: T, orgId: string, n: number) {
  for (let from = 0; from < n; from += 100)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 100); i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: orgId,
          name: `Person ${i}`,
          initials: 'PE',
          color: '#7a7ad0',
          email: `person${i}@testbed.test`,
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
        })
    })
}

/* `n` teams of organization `orgId`, with `member` in each. */
async function plantTeamsOf(t: T, orgId: string, member: Doc<'profiles'>, n: number) {
  return await t.run(async (ctx) => {
    const teams: string[] = []
    for (let i = 0; i < n; i++) {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: orgId,
        name: `Crew ${i}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: id, profile_id: member.id, is_leader: false })
      teams.push(id)
    }
    return teams
  })
}

/* The root part's answer for `who`'s login and the documents it read. */
const rootRead = (t: T, who: Doc<'profiles'>) =>
  as(t, who).query(async (ctx) => {
    const { readRoot } = await import('../lib/workspaceParts')
    const { loginMemberships } = await import('../lib/functions')
    const authUserId = who.auth_user_id ?? ''
    const { myProfiles } = await loginMemberships(ctx, authUserId)
    const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
    const answer = await readRoot(Object.assign(ctx, { authUserId, myProfiles }))
    const documents = (await ctx.meta.getTransactionMetrics()).documentsRead.used - before
    return { answer, documents }
  })

/* The root part's answer for a caller with a seat. */
function seated(answer: unknown) {
  if (answer === null || typeof answer !== 'object' || 'deleting' in answer)
    throw new Error('the root answered no seat')
  return answer as {
    myProfileIds: string[]
    profiles: Record<string, unknown>[]
    teamMembers: { team_id: string; profile_id: string }[]
    teams: { id: string; org_id: string; name: string }[]
  }
}

describe('the root part', () => {
  it("answers the caller's own profiles, memberships and teams in seat order, and nothing else of the organization", async () => {
    const t = newT()
    const f = await withOrg(t)
    // the user in 3 teams at home (the fixture's and two more) and a guest
    // seat elsewhere
    const more = await plantTeamsOf(t, f.org.id, f.user, 2)
    const guestSeat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.user.auth_user_id,
      email: f.user.email,
      name: 'user',
      org_role: 'guest',
      accepted_at: NOW,
    })
    // a team the user is not in
    await plantTeamsOf(t, f.org.id, f.admin, 1)
    const root = seated((await rootRead(t, f.user)).answer)
    expect(root.myProfileIds).toEqual([f.user.id, guestSeat.id])
    expect(root.profiles.map((p) => p.id)).toEqual([f.user.id, guestSeat.id])
    for (const p of root.profiles) {
      expect(p).not.toHaveProperty('name_key')
      expect(p).not.toHaveProperty('sync_at')
      expect(p).not.toHaveProperty('_id')
    }
    expect(root.profiles[0]).toMatchObject({ name: 'user', email: 'user@testbed.test' })
    expect(root.teamMembers.map((m) => [m.team_id, m.profile_id])).toEqual(
      [f.team.id, ...more].map((id) => [id, f.user.id]),
    )
    expect(root.teams.map((team) => team.id)).toEqual([f.team.id, ...more])
    for (const team of root.teams) expect(team).not.toHaveProperty('name_key')
    const text = JSON.stringify(root)
    for (const other of [f.admin, f.viewer, f.guest, f.agent, f.otherAdmin])
      expect(text).not.toContain(other.id)
  })

  it('reads as many documents in an organization of 1,000 people as in one of ten', async () => {
    const t = newT()
    const small = await withOrg(t)
    const before = await rootRead(t, small.user)
    const big = await withOrg(t)
    // the people figure: 1,000 people (the fixture's 5 and 995 more)
    await plantRoster(t, big.org.id, 995)
    const after = await rootRead(t, big.user)
    expect(seated(after.answer).profiles.map((p) => p.id)).toEqual([big.user.id])
    expect(seated(after.answer).teamMembers).toHaveLength(1)
    expect(after.documents).toBe(before.documents)
  })

  it('answers a caller in 5 teams their 5 memberships and 5 teams', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the teams-one-person-belongs-to figure: the fixture's team and 4 more
    const more = await plantTeamsOf(t, f.org.id, f.user, 4)
    const root = seated((await rootRead(t, f.user)).answer)
    expect(root.teamMembers).toHaveLength(5)
    expect(root.teams.map((team) => team.id)).toEqual([f.team.id, ...more])
  })

  it('refuses with the access check sentence past OWN_READS.teams memberships rather than send part of them', async () => {
    const t = newT()
    const f = await withOrg(t)
    OWN_READS.teams = 2
    // the user in 2 teams is answered, the admin in 3 is refused
    await plantTeamsOf(t, f.org.id, f.user, 1)
    await plantTeamsOf(t, f.org.id, f.admin, 2)
    expect(seated(await as(t, f.user).query(api.workspace.root, {})).teams).toHaveLength(2)
    await expectRefusal(
      as(t, f.admin).query(api.workspace.root, {}),
      'rule',
      new RegExp(`^${accessUnchecked().data.message.replace(/[.]/g, '\\.')}$`),
    )
  })

  it('names no team for a membership whose team is gone or of another organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [elsewhere] = await plantTeamsOf(t, f.otherOrg.id, f.otherAdmin, 1)
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: 'gone-team',
        profile_id: f.user.id,
        is_leader: false,
      })
      await ctx.db.insert('team_members', {
        team_id: elsewhere,
        profile_id: f.user.id,
        is_leader: false,
      })
    })
    const root = seated((await rootRead(t, f.user)).answer)
    expect(root.teams.map((team) => team.id)).toEqual([f.team.id])
    // the workspace keeps the membership of its own team only
    const snap = await workspaceOf(as(t, f.user))
    expect(
      snap?.teamMembers.filter((m) => m.profile_id === f.user.id).map((m) => m.team_id),
    ).toEqual([f.team.id])
  })

  it("changes when one of the caller's teams is renamed, and not for another team, a new person or a new label", async () => {
    const t = newT()
    const f = await withOrg(t)
    const [other] = await plantTeamsOf(t, f.org.id, f.admin, 1)
    const read = async () => JSON.stringify(await as(t, f.user).query(api.workspace.root, {}))
    const first = await read()
    await t.run(async (ctx) => {
      const team = await ctx.db
        .query('teams')
        .withIndex('by_uuid', (q) => q.eq('id', other))
        .unique()
      await ctx.db.patch(team!._id, { name: 'Renamed elsewhere' })
      await ctx.db.insert('labels', {
        id: uuid(),
        org_id: f.org.id,
        name: 'Fresh',
        name_lower: 'fresh',
        color: '#50b070',
        created_at: NOW,
      })
    })
    await plantSeat(t, { org_id: f.org.id, name: 'Newcomer' })
    expect(await read()).toBe(first)
    await t.run(async (ctx) => {
      const team = await ctx.db
        .query('teams')
        .withIndex('by_uuid', (q) => q.eq('id', f.team.id))
        .unique()
      await ctx.db.patch(team!._id, { name: 'Hardware crew' })
    })
    const renamed = await read()
    expect(renamed).not.toBe(first)
    expect(renamed).toContain('Hardware crew')
  })
})

describe('many projects', () => {
  it("shows a parent of 30 sub-projects for navigation through projectNav.byIds within the real limits, and the task window reads only its task's projects", async () => {
    const t = newT(REAL_LIMITS)
    const f = await withReadingAdmin(t)
    // a parent the viewer reaches only through the last of its 30
    // sub-projects, as many as the design size puts under one project
    const parent = uuid()
    const subs = await t.run(async (ctx) => {
      const row = (n: number, parent_id?: string) => ({
        id: n === 0 ? parent : uuid(),
        window_key: newWindowKey(),
        org_id: f.org.id,
        type: parent_id === undefined ? ('meta' as const) : ('project' as const),
        parent_id,
        key: `M${n}`,
        name: `Many ${n}`,
        description: '',
        sort_order: 1000 + n,
        num: 1000 + n,
        track_delay: false,
        created_at: NOW,
      })
      await ctx.db.insert('projects', row(0))
      const ids: string[] = []
      for (let n = 1; n <= 30; n++)
        ids.push((await ctx.db.get(await ctx.db.insert('projects', row(n, parent))))!.id)
      await ctx.db.insert('project_access', {
        project_id: ids[29],
        profile_id: f.viewer.id,
        level: 'viewer',
      })
      await patchCounters(ctx, f.org.id, { next_project_num: 1031 })
      return ids
    })
    const task = await plantIssue(t, { org_id: f.org.id, project_id: subs[29] })
    // the read the app takes its projects from, projectNav.byIds, asked for
    // all 30 sub-projects with the real limits, once the organization's
    // reach rows and name keys are complete: the one the viewer reads, with
    // its parent, which shows for navigation through it
    await ready(t, f)
    const answer = await as(t, f.viewer).query(api.projectNav.byIds, { ids: subs })
    const shown = new Set(answer.rows.map((p) => p.id))
    expect(shown.has(parent)).toBe(true)
    expect(shown.has(subs[29])).toBe(true)
    expect(subs.filter((id) => shown.has(id))).toHaveLength(1)
    expect(answer.unchecked).toEqual([])
    // the task window opens the task, reading its task and projects, not
    // the parent's 30 sub-projects
    const read = await t.run(async (ctx) => {
      const { readWindowTask } = await import('../lib/taskWindow')
      const answer = await readWindowTask(ctx, f.viewer, task.id)
      return { answer, documents: (await ctx.meta.getTransactionMetrics()).documentsRead.used }
    })
    expect(read.answer.state).toBe('ok')
    expect(read.documents).toBeLessThan(30)
  })

  it('opens a task in its window exactly where the person sees its project, for every kind of grant, however their own rows are read', async () => {
    const shownProjects = {
      // an admin by their own rows, as a user
      admin: ['led', 'grant', 'viewerGrant', 'share', 'parentShared', 'parentLed', 'parentGrant'],
      user: ['led', 'grant', 'viewerGrant', 'share', 'parentShared', 'parentLed', 'parentGrant'],
      // a viewer leads nothing
      viewer: ['grant', 'viewerGrant', 'share', 'parentShared', 'parentGrant'],
      // a guest gets nothing through teams
      guest: ['led', 'grant', 'viewerGrant', 'parentLed', 'parentGrant'],
    } as const
    for (const [role, expected] of Object.entries(shownProjects)) {
      const t = newT()
      const f = await withReadingAdmin(t)
      const me = await plantSeat(t, {
        org_id: f.org.id,
        org_role: role as keyof typeof shownProjects,
      })
      const { kinds: byProject } = await t.run(async (ctx) => {
        const team = async (orgId: string) => {
          const id = uuid()
          await ctx.db.insert('teams', {
            id,
            org_id: orgId,
            name: 'Team',
            track_delay_default: false,
            created_at: NOW,
          })
          return id
        }
        const [mine, other, foreign] = [
          await team(f.org.id),
          await team(f.org.id),
          await team(f.otherOrg.id),
        ]
        for (const team_id of [mine, foreign])
          await ctx.db.insert('team_members', { team_id, profile_id: me.id, is_leader: false })
        const project = async (extra: Partial<Doc<'projects'>>) => {
          const id = uuid()
          await ctx.db.insert('projects', {
            id,
            org_id: f.org.id,
            type: 'project',
            key: id.slice(0, 5).toUpperCase(),
            name: 'Kind',
            description: '',
            sort_order: 1,
            num: 1,
            track_delay: false,
            created_at: NOW,
            window_key: newWindowKey(),
            ...extra,
          })
          return id
        }
        const grant = (project_id: string, level: 'user' | 'viewer') =>
          ctx.db.insert('project_access', { project_id, profile_id: me.id, level })
        const share = (project_id: string, team_id: string) =>
          ctx.db.insert('project_team_access', { project_id, team_id, level: 'user' })
        const parent = await project({ type: 'meta' })
        const sub = (extra: Partial<Doc<'projects'>> = {}) =>
          project({ parent_id: parent, ...extra })
        const ids = {
          led: await sub({ lead_id: me.id }),
          grant: await sub(),
          viewerGrant: await sub(),
          share: await sub(),
          otherTeam: await sub(),
          foreignTeam: await sub(),
          none: await sub(),
          archived: await sub({ archived_at: NOW }),
          deleted: await sub(),
          parentShared: await project({ parent_id: await project({ type: 'meta' }) }),
          parentLed: await project({ parent_id: await project({ type: 'meta', lead_id: me.id }) }),
          parentGrant: await project({ parent_id: await project({ type: 'meta' }) }),
        }
        await grant(ids.grant, 'user')
        await grant(ids.viewerGrant, 'viewer')
        await grant(ids.archived, 'user')
        await grant(ids.deleted, 'user')
        await share(ids.share, mine)
        await share(ids.otherTeam, other)
        await share(ids.foreignTeam, foreign)
        const parentOf = async (id: string) =>
          (await ctx.db
            .query('projects')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique())!.parent_id!
        await share(await parentOf(ids.parentShared), mine)
        await grant(await parentOf(ids.parentGrant), 'viewer')
        for (const [kind, project_id] of Object.entries(ids)) {
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id,
            num: 1,
            title: kind,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          })
        }
        // a deleted project leaves no row
        const gone = await ctx.db
          .query('projects')
          .withIndex('by_uuid', (q) => q.eq('id', ids.deleted))
          .unique()
        await ctx.db.delete(gone!._id)
        return {
          parent,
          kinds: Object.fromEntries(Object.entries(ids).map(([kind, id]) => [id, kind])),
        }
      })
      // the navigation reads' reach rows and name keys for the rows planted
      await ready(t, f)
      for (const own of [
        DEFAULT_OWN_READS,
        // the person's five grants and two teams read at once
        { ...DEFAULT_OWN_READS, steps: [1, 8], manyTeams: 1 },
        {
          ...DEFAULT_OWN_READS,
          steps: [1],
          lookups: 0,
          rows: 0,
          manyTeams: 1,
          orgTeams: 0,
          bytes: 0,
        },
      ]) {
        Object.assign(OWN_READS, structuredClone(own))
        // the task window, the app's read of one task, opens each planted
        // task exactly where the person sees its project
        const shown = await t.run(async (ctx) => {
          const { readWindowTask } = await import('../lib/taskWindow')
          const tasks = await ctx.db
            .query('issues')
            .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
            .collect()
          const kinds: string[] = []
          for (const task of tasks) {
            const answer = await readWindowTask(ctx, me, task.id)
            if (answer.state === 'ok') kinds.push(byProject[task.project_id])
          }
          return kinds.sort()
        })
        expect(shown, `${role}, own reads ${JSON.stringify(own)}`).toEqual([...expected].sort())
        // projectNav.byIds, the app's only source of projects and levels,
        // answers the same projects of every planted one, and leaves the
        // others out, never listing one apart as unchecked
        const planted = Object.keys(byProject)
        const named = await t.run(async (ctx) => {
          const answer = await navByIdsOf(ctx, new Map([[me.org_id, me]]), planted)
          return {
            rows: answer.rows.flatMap((row) => (byProject[row.id] ? [byProject[row.id]] : [])),
            unchecked: answer.unchecked,
          }
        })
        expect(named.rows.sort(), `${role} byIds, own reads ${JSON.stringify(own)}`).toEqual(
          [...expected].sort(),
        )
        expect(named.unchecked).toEqual([])
        // a guest gets nothing through a team, nor through a parent shared
        // with one
        if (role === 'guest')
          for (const kind of ['share', 'otherTeam', 'foreignTeam', 'parentShared'])
            expect(named.rows).not.toContain(kind)
      }
    }
  }, 60_000)
})
