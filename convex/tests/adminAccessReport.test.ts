/* The read-only admin transition report (internal/adminAccessReport.ts):
 * what each organization admin keeps and loses once admin status stops
 * giving access to project work. The ordinary level it judges by must be
 * the level a standard user with the same rows holds, so these tests
 * compare it with lib/access.ts projectLevel for such a user, over every
 * access shape and the Northstar seed. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { ordinaryOf, ROOM, RUN, reportPage, SUBS } from '../internal/adminAccessReport'
import {
  accessRowsOf,
  canLeadProjects,
  cappedLevel,
  isOrgStaff,
  projectLevel,
  projectLevelsOf,
} from '../lib/access'
import { newWindowKey } from '../lib/db'
import { ACCESS_LEVELS, type AccessLevel } from '../lib/enums'
import { LIMITS } from '../lib/limits'
import { insertTask } from '../model/descriptions'
import { newTeam, SHAPES } from './accessShapes.setup'
import {
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'

type Phase = Parameters<typeof reportPage>[1]
type PageResult = Awaited<ReturnType<typeof reportPage>>
type Finding = PageResult['findings'][number]

const report = internal.internal.adminAccessReport

/* Every page of `phase` from its start, as check answers them. */
async function pagesOf(t: T, phase: Phase, page_size?: number): Promise<PageResult[]> {
  const pages: PageResult[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10_000; i++) {
    const page: PageResult = await t.query(report.check, { phase, cursor, page_size })
    pages.push(page)
    if (page.done) return pages
    cursor = page.cursor
  }
  throw new Error(`the ${phase} phase did not end`)
}

/* The findings of every page of `phase`. */
const findingsOf = async (t: T, phase: Phase, page_size?: number): Promise<Finding[]> =>
  (await pagesOf(t, phase, page_size)).flatMap((page) => page.findings)

/* What `profileId`'s findings of the projects phase say of each project:
 * its kind by project id. */
async function projectKinds(t: T, profileId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const finding of await findingsOf(t, 'projects'))
    if (finding.profile_id === profileId && 'project_id' in finding && finding.project_id)
      out[finding.project_id] = finding.kind
  return out
}

/* `findings` as sorted JSON lines, each with its keys sorted, to compare as
 * sets. */
const lines = (findings: readonly Finding[]): string[] =>
  findings
    .map((finding) => JSON.stringify(Object.fromEntries(Object.entries(finding).sort())))
    .sort()

/* A new active admin seat of `f`'s organization. */
const plantAdmin = (t: T, f: OrgFixture, extra: Partial<Doc<'profiles'>> = {}) =>
  plantSeat(t, { org_id: f.org.id, org_role: 'admin', name: 'Admin seat', ...extra })

/* A grant of `level` on `project` for `profile`. */
const grant = (
  t: T,
  project: Doc<'projects'>,
  profile: Doc<'profiles'>,
  level: 'user' | 'viewer',
) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: project.id, profile_id: profile.id, level }),
  )

/* A new team of `f`'s organization with `profile` as its member, sharing
 * `project` at `level`. */
const shareThroughTeam = (
  t: T,
  f: OrgFixture,
  project: Doc<'projects'>,
  profile: Doc<'profiles'>,
  level: 'user' | 'viewer',
) =>
  t.run(async (ctx) => {
    const team_id = await newTeam(ctx, f.org.id)
    await ctx.db.insert('team_members', { team_id, profile_id: profile.id, is_leader: false })
    await ctx.db.insert('project_team_access', { project_id: project.id, team_id, level })
  })

/* A webhook subscription of `f`'s organization owned by `owner`. */
const plantWebhook = (
  t: T,
  owner: Doc<'profiles'>,
  filters: { task_id?: string; project_id?: string },
  extra: Partial<Doc<'webhook_subscriptions'>> = {},
) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('webhook_subscriptions', {
      id,
      org_id: owner.org_id,
      owner: {
        profile_id: owner.id,
        credential_table: 'mcp_tokens',
        credential_id: uuid(),
        credential_row_id: 'row',
      },
      name: 'task.updated',
      filters,
      url: 'https://receiver.example/hook',
      encrypted_secret: 'test-only',
      created_at: Date.now(),
      ...extra,
    })
    return id
  })

/* A personal token of `profile`. */
const plantToken = (t: T, profile: Doc<'profiles'>, extra: Partial<Doc<'mcp_tokens'>> = {}) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: profile.id,
      name: 'Token',
      token_prefix: 'qvt_test',
      token_hash: uuid(),
      access: 'write',
      created_at: NOW,
      ...extra,
    })
  })

/* An approved connected app of `profile`. */
const plantApp = (t: T, profile: Doc<'profiles'>, extra: Partial<Doc<'oauth_connections'>> = {}) =>
  t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('oauth_connections', {
      id,
      authorization_hash: `hash-${id}`,
      auth_user_id: profile.auth_user_id ?? '',
      profile_id: profile.id,
      org_id: profile.org_id,
      client_id: 'client',
      client_name: 'App',
      resource: 'https://qivo.test/mcp',
      requested_scopes: ['qivo:read'],
      scopes: ['qivo:read'],
      created_at: NOW,
      authorization_expires_at: NOW,
      approved_at: NOW,
      ...extra,
    })
  })

/* How the report should judge each live project of a meta tree under a live
 * top-level project for `asUser`, a profile now a standard user with the
 * rows its admin seat held: by projectLevel, the per-project rule. */
async function expectedKinds(
  ctx: MutationCtx,
  asUser: Doc<'profiles'>,
  projects: readonly Doc<'projects'>[],
): Promise<Record<string, string>> {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const out: Record<string, string> = {}
  for (const p of projects) {
    const root = p.parent_id === undefined ? p : byId.get(p.parent_id)
    const inTree =
      root !== undefined &&
      root.parent_id === undefined &&
      root.type === 'meta' &&
      p.org_id === asUser.org_id
    if (!inTree || p.archived_at !== undefined || root.archived_at !== undefined) continue
    const own = await projectLevel(ctx, asUser, p, false)
    if (own === 'viewer') out[p.id] = 'read_only'
    else if (own === null && (await projectLevel(ctx, asUser, p)) === null) out[p.id] = 'leaves'
  }
  return out
}

/* For every project of `orgIds`: the ordinary levels of `admin` with and
 * without navigation, then, with `admin` stored as a standard user,
 * projectLevel's, which must be equal; and the kinds the report should
 * find. */
async function compareWithUser(t: T, admin: Doc<'profiles'>, orgIds: readonly string[]) {
  return await t.run(async (ctx) => {
    const projects = (
      await Promise.all(
        orgIds.map((org_id) =>
          ctx.db
            .query('projects')
            .withIndex('by_org', (q) => q.eq('org_id', org_id))
            .collect(),
        ),
      )
    ).flat()
    const ordinary = projectLevelsOf(ctx, ordinaryOf(admin))
    const levels = async (
      level: (p: Doc<'projects'>, nav: boolean) => Promise<AccessLevel | null>,
    ) =>
      await Promise.all(
        projects.map(async (p) => [p.key, await level(p, true), await level(p, false)]),
      )
    const report = await levels((p, nav) => ordinary.level(p.id, nav))
    await ctx.db.patch(admin._id, { org_role: 'user' })
    const asUser = await ctx.db.get(admin._id)
    if (asUser === null) throw new Error('the admin seat is gone')
    const user = await levels((p, nav) => projectLevel(ctx, asUser, p, nav))
    return { report, user, expected: await expectedKinds(ctx, asUser, projects) }
  })
}

describe('the projects phase', () => {
  it('reports every in-tree live project as leaving an admin with no grant, share or lead', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the fixture's admin is a plain member of a team that shares nothing
    const findings = await findingsOf(t, 'projects')
    expect(lines(findings)).toEqual(
      lines([
        ...[f.meta, f.sub, f.sub2, f.hidden].map((p) => ({
          kind: 'leaves' as const,
          org_id: f.org.id,
          profile_id: f.admin.id,
          project_id: p.id,
          key: p.key,
          top_level_id: p.parent_id ?? p.id,
        })),
        {
          kind: 'leaves',
          org_id: f.otherOrg.id,
          profile_id: f.otherAdmin.id,
          project_id: f.otherProject.id,
          key: f.otherProject.key,
          top_level_id: f.otherProject.id,
        },
      ]),
    )
    const pages = await pagesOf(t, 'projects')
    expect(pages.reduce((n, page) => n + page.checked, 0)).toBe(5)
    expect(pages.reduce((n, page) => n + page.kept, 0)).toBe(0)
  })

  it('keeps what leadership, grants, team shares and navigation reach', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [byTeam, byGrant, byLead, byViewerTeam] = await Promise.all(
      ['team', 'grant', 'lead', 'viewer'].map((name) => plantAdmin(t, f, { name })),
    )
    await shareThroughTeam(t, f, f.meta, byTeam, 'user')
    await grant(t, f.sub, byGrant, 'user')
    await t.run((ctx) => ctx.db.patch(f.hidden._id, { lead_id: byLead.id }))
    await shareThroughTeam(t, f, f.meta, byViewerTeam, 'viewer')

    // a team share on the top-level project reaches it and every sub-project
    expect(await projectKinds(t, byTeam.id)).toEqual({ [f.hidden.id]: 'leaves' })
    // a grant on one sub-project keeps it and its parent, for navigation
    expect(await projectKinds(t, byGrant.id)).toEqual({
      [f.sub2.id]: 'leaves',
      [f.hidden.id]: 'leaves',
    })
    expect(await projectKinds(t, byLead.id)).toEqual({
      [f.meta.id]: 'leaves',
      [f.sub.id]: 'leaves',
      [f.sub2.id]: 'leaves',
    })
    expect(await projectKinds(t, byViewerTeam.id)).toEqual({
      [f.meta.id]: 'read_only',
      [f.sub.id]: 'read_only',
      [f.sub2.id]: 'read_only',
      [f.hidden.id]: 'leaves',
    })
    const pages = await pagesOf(t, 'projects')
    // five admins of the organization on four projects, and the other's one
    expect(pages.reduce((n, page) => n + page.checked, 0)).toBe(5 * 4 + 1)
    expect(pages.reduce((n, page) => n + page.kept, 0)).toBe(3 + 2 + 1)
  })

  it('leaves out inactive admins, other roles, projects outside a meta tree and archived projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    // an inactive admin and a standard user, each with open work, a follow,
    // a token and a webhook in FW
    const inactive = await plantAdmin(t, f, { active: false })
    for (const profile of [inactive, f.user]) {
      const held = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        assignee_id: profile.id,
      })
      await plantSubscription(t, { issue_id: held.id, profile_id: profile.id })
      await plantToken(t, profile)
      await plantWebhook(t, profile, { project_id: f.sub.id })
    }
    // a top-level project that is no meta, and a sub-project of a sub-project
    await plantProject(t, { org_id: f.org.id, type: 'project' })
    await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.sub.id })
    // an archived sub-project, and a top-level project archived with its live
    // sub-project
    await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const archived = await plantProject(t, { org_id: f.org.id, archived_at: NOW })
    await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: archived.id })

    const findings = await findingsOf(t, 'projects')
    expect(new Set(findings.map((finding) => finding.profile_id))).toEqual(
      new Set([f.admin.id, f.otherAdmin.id]),
    )
    expect(await projectKinds(t, f.admin.id)).toEqual(
      Object.fromEntries([f.meta, f.sub, f.sub2, f.hidden].map((p) => [p.id, 'leaves'])),
    )
    expect(findings).toHaveLength(5)
    const all = await t.action(report.run, {})
    expect(all.findings.filter((finding) => finding.profile_id !== f.admin.id)).toEqual([
      expect.objectContaining({ kind: 'leaves', profile_id: f.otherAdmin.id }),
    ])
  })

  it('leaves a top-level project with more sub-projects than a page reads unchecked', async () => {
    const t = newT()
    const f = await withOrg(t)
    const onParent = await plantAdmin(t, f)
    await grant(t, f.meta, onParent, 'user')
    const third = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const unchecked = {
      kind: 'unchecked',
      org_id: f.org.id,
      profile_id: f.admin.id,
      project_id: f.meta.id,
      key: f.meta.key,
    }
    try {
      for (const bound of [{ most: 2 }, { bytes: 1 }]) {
        Object.assign(SUBS, { most: 1_000, bytes: 2 * 1024 * 1024 }, bound)
        const findings = await findingsOf(t, 'projects')
        // only an admin who would need navigation is left unchecked, and
        // the sub-projects are judged one by one
        expect(findings).toContainEqual(unchecked)
        expect(findings.filter((finding) => finding.kind === 'unchecked')).toHaveLength(1)
        expect(await projectKinds(t, onParent.id)).toEqual({ [f.hidden.id]: 'leaves' })
        expect(await projectKinds(t, f.admin.id)).toEqual({
          [f.meta.id]: 'unchecked',
          [f.sub.id]: 'leaves',
          [f.sub2.id]: 'leaves',
          [third.id]: 'leaves',
          [f.hidden.id]: 'leaves',
        })
      }
    } finally {
      Object.assign(SUBS, { most: 1_000, bytes: 2 * 1024 * 1024 })
    }
    expect(await findingsOf(t, 'projects')).not.toContainEqual(unchecked)
  })
})

describe("an admin's ordinary level", () => {
  it('is what canLeadProjects, isOrgStaff, cappedLevel and team access give a standard user', async () => {
    for (const level of [null, ...ACCESS_LEVELS])
      expect(cappedLevel('admin', level)).toBe(cappedLevel('user', level))
    expect(canLeadProjects({ org_role: 'admin' })).toBe(canLeadProjects({ org_role: 'user' }))
    expect(isOrgStaff({ org_role: 'admin' })).toBe(isOrgStaff({ org_role: 'user' }))
    // team access, which lib/access.ts decides privately, through the rows
    // accessRowsOf reads for each role
    const t = newT()
    const f = await withOrg(t)
    await shareThroughTeam(t, f, f.meta, f.admin, 'user')
    const shares = await t.run(async (ctx) => ({
      admin: (await accessRowsOf(ctx, f.admin)).shares.length,
      user: (await accessRowsOf(ctx, ordinaryOf(f.admin))).shares.length,
    }))
    expect(shares).toEqual({ admin: 1, user: 1 })
  })

  it.each(SHAPES)("with %s is a standard user's with the same rows", async (_, plant) => {
    const t = newT()
    const f = await withOrg(t)
    const subject = await plantAdmin(t, f, { name: 'Subject' })
    await t.run((ctx) => plant(ctx, f, subject))
    const found = await projectKinds(t, subject.id)
    const { report, user, expected } = await compareWithUser(t, subject, [f.org.id, f.otherOrg.id])
    expect(report).toEqual(user)
    expect(found).toEqual(expected)
  })

  it("over the Northstar seed is Nora's level as a standard user, and nothing changes for her", async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    const [nora, ...otherAdmins] = profiles.filter((p) => p.org_role === 'admin')
    expect(nora.name).toBe('Nora Berg')
    expect(otherAdmins).toEqual([])

    const result = await t.action(report.run, {})
    expect(result.cursor).toBeNull()
    expect(result.findings).toEqual([])
    expect(result.counts).toMatchObject({
      leaves: 0,
      read_only: 0,
      unchecked: 0,
      held_task: 0,
      follow: 0,
      webhook: 0,
      credential: 0,
    })
    const projects = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect(),
    )
    // every Northstar project is live and in a meta tree
    expect(projects.filter((p) => p.archived_at !== undefined)).toEqual([])
    expect(result.counts.kept).toBe(projects.length)
    // she holds open work, which the work phase read
    const held = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('issues')
          .withIndex('by_assignee_archived', (q) =>
            q.eq('assignee_id', nora.id).eq('archived_at', undefined),
          )
          .collect()
      ).filter((task) => task.status !== 'done'),
    )
    expect(held.length).toBeGreaterThan(0)
    expect(result.checked).toBeGreaterThanOrEqual(projects.length + held.length)

    const { report: levels, user, expected } = await compareWithUser(t, nora, [org.id])
    expect(levels).toEqual(user)
    expect(expected).toEqual({})
  })
})

describe('the work phase', () => {
  it('reports the open tasks and follows an admin keeps no edit access to', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the admin sees FW no longer, PCB as a Viewer and a third sub-project
    // with User
    await grant(t, f.sub2, f.admin, 'viewer')
    const kept = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    await grant(t, kept, f.admin, 'user')
    const archivedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const archivedTop = await plantProject(t, { org_id: f.org.id, archived_at: NOW })
    const underArchived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: archivedTop.id,
    })
    const task = (project: Doc<'projects'>, extra: Partial<Doc<'issues'>> = {}) =>
      plantIssue(t, { org_id: f.org.id, project_id: project.id, assignee_id: f.admin.id, ...extra })
    const open = await task(f.sub)
    const reviewing = await task(f.sub, {
      assignee_id: f.user.id,
      reviewer_id: f.admin.id,
      status: 'review',
    })
    const seen = await task(f.sub2)
    const parent = await task(f.sub, { assignee_id: undefined, reviewer_id: f.admin.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })
    const keptTask = await task(kept)
    const done = await task(f.sub, { status: 'done', done_at: NOW })
    const archived = await task(f.sub, { archived_at: NOW })
    const inArchivedSub = await task(archivedSub)
    const inArchivedTop = await task(underArchived)
    for (const followed of [open, seen, keptTask, done, archived, inArchivedSub, inArchivedTop])
      await plantSubscription(t, { issue_id: followed.id, profile_id: f.admin.id })
    // a follow whose task is gone, and a standard user's in FW
    await plantSubscription(t, { issue_id: uuid(), profile_id: f.admin.id })
    await plantSubscription(t, { issue_id: open.id, profile_id: f.user.id })

    const held = (
      issue: Doc<'issues'>,
      role: 'assignee' | 'reviewer',
      sight: 'none' | 'viewer',
    ) => ({
      kind: 'held_task' as const,
      org_id: f.org.id,
      profile_id: f.admin.id,
      task_id: issue.id,
      num: issue.num,
      role,
      project_id: issue.project_id,
      sight,
    })
    const follow = (issue: Doc<'issues'>) => ({
      kind: 'follow' as const,
      org_id: f.org.id,
      profile_id: f.admin.id,
      task_id: issue.id,
    })
    expect(lines(await findingsOf(t, 'work'))).toEqual(
      lines([
        held(open, 'assignee', 'none'),
        held(reviewing, 'reviewer', 'none'),
        held(seen, 'assignee', 'viewer'),
        // a reviewer of a task with active subtasks counts too
        held(parent, 'reviewer', 'none'),
        follow(open),
        // a Done task's followers still get its notifications
        follow(done),
      ]),
    )
  })
})

describe('the machine phase', () => {
  it('reports each webhook an admin owns with its scope and whether its project leaves', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grant(t, f.sub2, f.admin, 'user')
    const leaving = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const staying = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const ids = {
      leavingTask: await plantWebhook(t, f.admin, { task_id: leaving.id, project_id: f.sub.id }),
      stayingTask: await plantWebhook(t, f.admin, { task_id: staying.id }),
      goneTask: await plantWebhook(t, f.admin, { task_id: uuid() }),
      leavingProject: await plantWebhook(t, f.admin, { project_id: f.sub.id }),
      stayingProject: await plantWebhook(t, f.admin, { project_id: f.sub2.id }),
      org: await plantWebhook(t, f.admin, {}, { expires_at: Date.now() + 3_600_000 }),
      disabled: await plantWebhook(t, f.admin, {}, { disabled_at: Date.now() }),
    }
    await plantWebhook(t, f.admin, {}, { expires_at: Date.now() - 1 })
    await plantWebhook(t, f.user, { project_id: f.sub.id })
    const webhook = (id: string, scope: 'task' | 'project' | 'org', affected: boolean | null) => ({
      kind: 'webhook' as const,
      org_id: f.org.id,
      profile_id: f.admin.id,
      subscription_id: id,
      scope,
      affected,
    })
    expect(lines(await findingsOf(t, 'machine'))).toEqual(
      lines([
        webhook(ids.leavingTask, 'task', true),
        webhook(ids.stayingTask, 'task', false),
        webhook(ids.goneTask, 'task', false),
        webhook(ids.leavingProject, 'project', true),
        webhook(ids.stayingProject, 'project', false),
        webhook(ids.org, 'org', null),
        webhook(ids.disabled, 'org', null),
      ]),
    )
  })

  it("counts an admin's active personal tokens and approved connected apps only", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantToken(t, f.admin)
    await plantToken(t, f.admin, { expires_at: '2999-01-01T00:00:00.000Z' })
    await plantToken(t, f.admin, { expires_at: '2020-01-01T00:00:00.000Z' })
    await plantToken(t, f.admin, { revoked_at: NOW })
    await plantApp(t, f.admin)
    await plantApp(t, f.admin, { revoked_at: NOW })
    await plantApp(t, f.admin, { approved_at: undefined })
    // an admin with only a revoked token, and a standard user with a live one
    await plantToken(t, f.otherAdmin, { revoked_at: NOW })
    await plantToken(t, f.user)
    expect(await findingsOf(t, 'machine')).toEqual([
      { kind: 'credential', org_id: f.org.id, profile_id: f.admin.id, tokens: 2, apps: 1 },
    ])
  })
})

/* An organization whose every phase spans several pages at a small size:
 * two admins without access, each holding tasks, follows, tokens, apps and
 * webhooks, and another organization's admin. */
async function busyOrg(t: T) {
  const f = await withOrg(t)
  const second = await plantAdmin(t, f)
  for (const admin of [f.admin, second]) {
    for (let i = 0; i < 3; i++) {
      const issue = await plantIssue(t, {
        org_id: f.org.id,
        project_id: i === 0 ? f.sub.id : f.sub2.id,
        assignee_id: admin.id,
        reviewer_id: admin.id === f.admin.id ? second.id : f.admin.id,
      })
      await plantSubscription(t, { issue_id: issue.id, profile_id: admin.id })
      await plantToken(t, admin)
      await plantApp(t, admin)
      await plantWebhook(t, admin, { project_id: f.sub.id })
    }
  }
  return f
}

describe('paging', () => {
  it('walks every phase in small pages to the findings of one page each, without gaps or repeats', async () => {
    const t = newT()
    await busyOrg(t)
    const phases = ['projects', 'work', 'machine'] as const
    const whole = new Map<Phase, Finding[]>()
    for (const phase of phases) {
      const pages = await pagesOf(t, phase, 1_000_000)
      expect(pages).toHaveLength(1)
      whole.set(phase, pages[0].findings)
    }
    expect(lines(whole.get('projects') ?? [])).toHaveLength(9)
    expect(lines(whole.get('work') ?? [])).toHaveLength(18)
    expect(lines(whole.get('machine') ?? [])).toHaveLength(8)
    const cursors: string[] = []
    const walk = async () => {
      for (const phase of phases) {
        const pages = await pagesOf(t, phase)
        expect(pages.length).toBeGreaterThan(1)
        cursors.push(...pages.flatMap((page) => (page.cursor === null ? [] : [page.cursor])))
        const findings = pages.flatMap((page) => page.findings)
        expect(lines(findings)).toEqual(lines(whole.get(phase) ?? []))
      }
    }
    for (const size of [1, 2, 3]) {
      for (const phase of phases) {
        const findings = await findingsOf(t, phase, size)
        expect(lines(findings)).toEqual(lines(whole.get(phase) ?? []))
      }
    }
    // a page that ends at the room as soon as it got further
    ROOM.share = 0
    try {
      await walk()
    } finally {
      ROOM.share = 0.5
    }
    // the cursors went on inside one project's admins and inside one
    // admin's tasks, follows and tokens
    const parsed = cursors.map((cursor) => JSON.parse(cursor))
    expect(parsed).toContainEqual(
      expect.objectContaining({ phase: 'projects', project: expect.any(String) }),
    )
    for (const [phase, part] of [
      ['work', 'assigned'],
      ['work', 'reviewing'],
      ['work', 'follows'],
      ['machine', 'webhooks'],
      ['machine', 'tokens'],
      ['machine', 'apps'],
    ])
      expect(parsed).toContainEqual(
        expect.objectContaining({ phase, part, after: expect.any(Number) }),
      )
    expect(
      parsed.some(
        (cursor) => cursor.phase === 'machine' && cursor.part === 'apps' && cursor.tokens === 3,
      ),
    ).toBe(true)
  })

  it('stops a run past RUN.ms with a cursor that a second call finishes', async () => {
    const t = newT()
    await busyOrg(t)
    const whole = await t.action(report.run, {})
    expect(whole.cursor).toBeNull()
    RUN.ms = 0
    let first: typeof whole
    try {
      first = await t.action(report.run, { page_size: 1 })
    } finally {
      RUN.ms = 5 * 60_000
    }
    expect(first.cursor).not.toBeNull()
    expect(first.checked).toBe(1)
    const second = await t.action(report.run, { cursor: first.cursor, page_size: 1 })
    expect(second.cursor).toBeNull()
    expect(first.checked + second.checked).toBe(whole.checked)
    for (const [kind, count] of Object.entries(whole.counts))
      expect(
        first.counts[kind as keyof typeof whole.counts] +
          second.counts[kind as keyof typeof whole.counts],
      ).toBe(count)
    expect(lines([...first.findings, ...second.findings])).toEqual(lines(whole.findings))
    expect(whole.listed_all).toBe(true)
  })
})

describe('refusals', () => {
  it('refuses a malformed cursor, an unknown phase and a page size below one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org = f.org.id
    const cases: [Phase, string][] = [
      ['projects', 'nope'],
      ['projects', '[]'],
      ['projects', 'null'],
      ['projects', '{"phase":"work"}'],
      ['projects', JSON.stringify({ phase: 'projects', org: 5 })],
      ['projects', JSON.stringify({ phase: 'projects', org, after: -1 })],
      // inside a project the cursor names the admin done last
      ['projects', JSON.stringify({ phase: 'projects', org, after: 0, project: 'p' })],
      ['projects', JSON.stringify({ phase: 'projects', org, part: 'tokens' })],
      ['projects', JSON.stringify({ phase: 'projects', after: 3 })],
      ['work', JSON.stringify({ phase: 'work', org, admin: 'a' })],
      ['work', JSON.stringify({ phase: 'work', org, admin: 'a', part: 'tokens' })],
      ['work', JSON.stringify({ phase: 'work', org, admin: 'a', part: 'assigned', extra: 1 })],
      ['machine', JSON.stringify({ phase: 'machine', org, part: 'tokens' })],
      ['machine', JSON.stringify({ phase: 'machine', org, admin: 'a', part: 'webhooks' })],
      ['machine', JSON.stringify({ phase: 'machine', org, admin: 'a', part: 'apps', apps: 1.5 })],
    ]
    for (const [phase, cursor] of cases)
      await expect(t.query(report.check, { phase, cursor })).rejects.toThrow(
        `cursor must be one a page of the ${phase} phase answered`,
      )
    // the cursors a page answers pass
    for (const cursor of [
      JSON.stringify({ phase: 'work' }),
      JSON.stringify({ phase: 'work', org, admin: 'a', part: 'follows', after: 1 }),
      JSON.stringify({ phase: 'machine', org, part: 'webhooks', after: 1 }),
    ])
      await expect(
        t.query(report.check, { phase: JSON.parse(cursor).phase, cursor }),
      ).resolves.toMatchObject({ done: true })
    await expect(t.query(report.check, { phase: 'nope' as Phase })).rejects.toThrow(/validator/i)
    for (const page_size of [0, -1, 1.5])
      await expect(t.query(report.check, { phase: 'work', page_size })).rejects.toThrow(
        'page_size must be a whole number of at least 1',
      )
    await expect(t.action(report.run, { cursor: '{"phase":"later"}' })).rejects.toThrow(
      'cursor must be one a call of run or check answered',
    )
  })

  it('writes nothing', async () => {
    const t = newT()
    await busyOrg(t)
    const tables = [
      'organizations',
      'profiles',
      'projects',
      'project_access',
      'project_team_access',
      'teams',
      'team_members',
      'issues',
      'issue_descriptions',
      'issue_subscriptions',
      'webhook_subscriptions',
      'mcp_tokens',
      'oauth_connections',
      'used_ids',
    ] as const
    const contents = () =>
      t.run(async (ctx) => {
        const out: Record<string, unknown[]> = {}
        for (const table of tables) out[table] = await ctx.db.query(table).collect()
        return out
      })
    const before = await contents()
    expect((await t.action(report.run, {})).checked).toBeGreaterThan(0)
    expect(await contents()).toEqual(before)
  })
})

/* Whether `metrics` used more than `share` of any limit, as usedMoreThan
 * asks. */
const usedPast = (
  metrics: Record<string, { used: number; remaining: number }>,
  share: number,
): boolean =>
  Object.values(metrics).some(({ used, remaining }) => used > (used + remaining) * share)

/* A page and the transaction metrics it used. */
type Measured = { page: PageResult; metrics: Record<string, { used: number; remaining: number }> }

/* Every page of `phase` at `size`, each in a transaction with Convex's
 * limits, with the metrics each page used. */
async function measuredPages(t: T, phase: Phase, size: number): Promise<Measured[]> {
  const pages: Measured[] = []
  let cursor: string | null = null
  for (;;) {
    const at: string | null = cursor
    const measured: Measured = await t.run(async (ctx) => ({
      page: await reportPage(ctx, phase, at, size),
      metrics: await ctx.meta.getTransactionMetrics(),
    }))
    pages.push(measured)
    if (measured.page.done) return pages
    cursor = measured.page.cursor
  }
}

describe('within Convex limits', () => {
  it('ends each projects page by its room over 3 admins and 2,000 projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const inTeams = await plantAdmin(t, f, { name: 'In teams' })
    const granted = await plantAdmin(t, f, { name: 'Granted' })
    // 40 top-level projects of 49 sub-projects each
    const subs: string[] = []
    for (let m = 0; m < 40; m += 10)
      await t.run(async (ctx) => {
        for (let n = m; n < m + 10; n++) {
          const parent = uuid()
          const row = (id: string, num: number, parent_id?: string) =>
            ctx.db.insert('projects', {
              id,
              org_id: f.org.id,
              type: parent_id === undefined ? 'meta' : 'project',
              parent_id,
              key: `K${num}`,
              name: `Project ${num}`,
              description: 'd'.repeat(LIMITS.projectDescription.max),
              sort_order: num,
              num,
              track_delay: false,
              created_at: NOW,
              window_key: newWindowKey(),
              lead_id: n < 2 && parent_id === undefined ? granted.id : undefined,
            })
          await row(parent, 1_000 + n * 50)
          for (let s = 1; s < 50; s++) {
            const id = uuid()
            subs.push(id)
            await row(id, 1_000 + n * 50 + s, parent)
          }
        }
      })
    // the second admin is in 60 teams, which share every sub-project between
    // them; the third leads the first two top-level projects and holds grants
    // on the next 100 sub-projects, in the next three trees
    await t.run(async (ctx) => {
      for (let team = 0; team < 60; team++) {
        const team_id = await newTeam(ctx, f.org.id)
        await ctx.db.insert('team_members', { team_id, profile_id: inTeams.id, is_leader: false })
        for (let i = team; i < subs.length; i += 60)
          await ctx.db.insert('project_team_access', {
            project_id: subs[i],
            team_id,
            level: 'user',
          })
      }
      for (const project_id of subs.slice(98, 198))
        await ctx.db.insert('project_access', { project_id, profile_id: granted.id, level: 'user' })
    })

    const pages = await measuredPages(t, 'projects', 4_000)
    expect(pages.length).toBeGreaterThan(1)
    for (const { page, metrics } of pages.slice(0, -1)) {
      expect(page.checked).toBeLessThan(4_000)
      expect(usedPast(metrics, ROOM.share)).toBe(true)
    }
    const findings = pages.flatMap(({ page }) => page.findings)
    const count = (profileId: string, kind: string) =>
      findings.filter((finding) => finding.profile_id === profileId && finding.kind === kind).length
    // the fixture's admin keeps nothing, the one in teams every sub-project
    // and its parent, and the third the two trees they lead, their 100
    // sub-projects and those sub-projects' three parents
    expect(count(f.admin.id, 'leaves')).toBe(2_004)
    expect(count(inTeams.id, 'leaves')).toBe(4)
    expect(count(granted.id, 'leaves')).toBe(2_004 - 2 * 50 - 100 - 3)
    expect(findings.filter((finding) => finding.kind !== 'leaves')).toEqual([])
  }, 120_000)

  it('ends each work page by its room over 600 open tasks with full descriptions', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // a description at the cap in a three-byte script, about 60 KB
    const description = '語'.repeat(LIMITS.description.max)
    for (let batch = 0; batch < 600; batch += 50)
      await t.run(async (ctx) => {
        for (let i = batch; i < batch + 50; i++)
          await insertTask(
            ctx.db,
            {
              id: uuid(),
              org_id: f.org.id,
              project_id: f.sub.id,
              num: 10_000 + i,
              title: `Task ${i}`,
              description,
              status: 'todo',
              priority: 'medium',
              assignee_id: f.admin.id,
              paused: false,
              created_at: NOW,
              updated_at: NOW,
              window_key: newWindowKey(),
            },
            'restore',
          )
      })
    const pages = await measuredPages(t, 'work', 2_000)
    expect(pages.length).toBeGreaterThan(1)
    for (const { page, metrics } of pages.slice(0, -1)) {
      expect(page.checked).toBeLessThan(2_000)
      expect(usedPast(metrics, ROOM.share)).toBe(true)
    }
    const findings = pages.flatMap(({ page }) => page.findings)
    expect(findings).toHaveLength(600)
    expect(new Set(findings.map((finding) => 'task_id' in finding && finding.task_id)).size).toBe(
      600,
    )
  }, 120_000)

  it('reads a machine page over 100 subscriptions on full tasks, tokens and apps', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const admins = [f.admin, await plantAdmin(t, f), await plantAdmin(t, f)]
    const description = '語'.repeat(LIMITS.description.max)
    // the organization's most unexpired subscriptions (LIMITS.webhooksPerOrg),
    // each on a task with a description at the cap
    for (let batch = 0; batch < LIMITS.webhooksPerOrg.max; batch += 50)
      await t.run(async (ctx) => {
        for (let i = batch; i < batch + 50; i++) {
          const id = uuid()
          await insertTask(
            ctx.db,
            {
              id,
              org_id: f.org.id,
              project_id: f.sub.id,
              num: 10_000 + i,
              title: `Task ${i}`,
              description,
              status: 'todo',
              priority: 'medium',
              paused: false,
              created_at: NOW,
              updated_at: NOW,
              window_key: newWindowKey(),
            },
            'restore',
          )
          const owner = admins[i % admins.length]
          await ctx.db.insert('webhook_subscriptions', {
            id: uuid(),
            org_id: f.org.id,
            owner: {
              profile_id: owner.id,
              credential_table: 'mcp_tokens',
              credential_id: uuid(),
              credential_row_id: 'row',
            },
            name: 'task.updated',
            filters: { task_id: id },
            url: 'https://receiver.example/hook',
            encrypted_secret: 'test-only',
            created_at: Date.now(),
          })
        }
      })
    for (const admin of admins) {
      for (let i = 0; i < 50; i++) await plantToken(t, admin)
      for (let i = 0; i < 20; i++) await plantApp(t, admin)
    }
    const pages = await measuredPages(t, 'machine', 2_000)
    const findings = pages.flatMap(({ page }) => page.findings)
    expect(findings.filter((finding) => finding.kind === 'webhook')).toHaveLength(100)
    const credentials = findings.filter((finding) => finding.kind === 'credential')
    expect(credentials).toHaveLength(3)
    expect(credentials).toEqual(
      expect.arrayContaining(
        admins.map((admin) => ({
          kind: 'credential',
          org_id: f.org.id,
          profile_id: admin.id,
          tokens: 50,
          apps: 20,
        })),
      ),
    )
  }, 120_000)
})
