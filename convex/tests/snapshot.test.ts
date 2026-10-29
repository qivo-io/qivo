/* The workspace parts (workspace.ts) joined as the app joins them
 * (helpers.setup.ts workspaceOf), the read-path gate, and the task history
 * that snapshot.threadHistory answers beside a task's comments.
 *
 * Extra scenery beside withOrg's mini-Testbed:
 * - hiddenSub: a sub under f.hidden (lead: user) — invisible to guest/viewer,
 *   visible to admin (org admin) and user (lead)
 * - hidden2 / hidden2Sub: a second hidden family led by ADMIN — the project
 *   plain staff `user` cannot see, which is what the staff-anonymization
 *   assertions need (admin sees everything, so f.hidden can't test it)
 * - issueVis: scheduled+estimated work in f.sub, the identified control row */

/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { HISTORY_PAGE_MAX, WINDOW_HISTORY_PAGE } from '../lib/activityVisibility'
import { byId } from '../lib/db'
import { loadInbox } from '../lib/inbox'
import { INBOX_LIMIT } from '../lib/limits'
import { insertActivity } from '../model/activity'
import { startPurge } from '../model/deletedItems'
import {
  appLoadRows,
  as,
  expectRefusal,
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

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it (same situation as helpers.setup's crypto) */
declare class Blob {
  constructor(parts: string[])
}

let t: T
let f: OrgFixture
let hiddenSub: Doc<'projects'>
let hidden2: Doc<'projects'>
let hidden2Sub: Doc<'projects'>
let issueVis: Doc<'issues'>

beforeEach(async () => {
  t = newT()
  f = await withOrg(t)
  hiddenSub = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.hidden.id })
  hidden2 = await plantProject(t, { org_id: f.org.id, lead_id: f.admin.id })
  hidden2Sub = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: hidden2.id })
  issueVis = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    assignee_id: f.user.id,
    status: 'progress',
    start_week: '2026-01-05',
    end_week: '2026-01-12',
    remaining_hours: 5,
    remaining_set_at: NOW,
  })
})

const snapFor = async (profile: Doc<'profiles'>) => {
  const snap = await workspaceOf(as(t, profile))
  if (snap === null) throw new Error('expected a snapshot, got the noProfile null')
  return snap
}

const plantLabel = (name: string) =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('labels', {
      id: uuid(),
      org_id: f.org.id,
      name,
      name_lower: name.toLowerCase(),
      color: '#F0555D',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'labels'>
  })

describe('workspace scoping', () => {
  it('guest: the granted meta family only — hidden absent from projects, access AND issues', async () => {
    const issueHid = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      assignee_id: f.user.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      remaining_hours: 4,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: f.agent.id,
        level: 'user',
      })
    })
    const snap = await snapFor(f.guest)
    const projectIds = snap.projects.map((p) => p.id)
    expect(projectIds.sort()).toEqual([f.meta.id, f.sub.id, f.sub2.id].sort())
    expect(snap.access.every((a) => a.project_id === f.meta.id)).toBe(true)
    expect(snap.access.map((a) => a.profile_id).sort()).toEqual([f.guest.id, f.viewer.id].sort())
    expect(snap.issues.map((i) => i.id)).toContain(issueVis.id)
    expect(snap.issues.map((i) => i.id)).not.toContain(issueHid.id)
    expect(snap.auth_user_id).toBe(f.guest.auth_user_id)
    expect(snap.myProfileIds).toEqual([f.guest.id])
  })

  it('guest: full member roster and the host label vocabulary ride along', async () => {
    const label = await plantLabel('Bug')
    const snap = await snapFor(f.guest)
    expect(snap.profiles.map((p) => p.id).sort()).toEqual(
      [f.admin.id, f.user.id, f.viewer.id, f.guest.id, f.agent.id].sort(),
    )
    expect(snap.labels.map((l) => l.id)).toContain(label.id)
    // auth_user_id stays on the rows — the client's `pending` derivation needs it
    expect(snap.profiles.find((p) => p.id === f.user.id)?.auth_user_id).toBe(f.user.auth_user_id)
  })

  it('a stored label color that is not #rrggbb goes out as gray; valid colors pass unchanged', async () => {
    const valid = await plantLabel('Bug')
    const unsafe = await t.run(async (ctx) => {
      const ids: string[] = []
      for (const color of ['url(https://example.test/p.png)', 'red', '#fff']) {
        const id = uuid()
        await ctx.db.insert('labels', {
          id,
          org_id: f.org.id,
          name: `Old ${ids.length}`,
          name_lower: `old ${ids.length}`,
          color,
          created_at: NOW,
        })
        ids.push(id)
      }
      return ids
    })
    const colorById = new Map((await snapFor(f.guest)).labels.map((l) => [l.id, l.color]))
    expect(colorById.get(valid.id)).toBe('#F0555D')
    expect(unsafe.map((id) => colorById.get(id))).toEqual(['#8A8F98', '#8A8F98', '#8A8F98'])
    // the read does not rewrite the row; an admin recolor replaces it
    const stored = await t.run(async (ctx) => ctx.db.query('labels').collect())
    expect(stored.find((l) => l.id === unsafe[0])?.color).toBe('url(https://example.test/p.png)')
  })

  it('a stored avatar color that is not #rrggbb goes out as gray; valid colors pass unchanged', async () => {
    const unsafe: Doc<'profiles'>[] = []
    for (const color of ['url(https://example.test/p.png)', 'red', '#fff']) {
      unsafe.push(await plantSeat(t, { org_id: f.org.id, color }))
    }
    const colorById = new Map((await snapFor(f.guest)).profiles.map((p) => [p.id, p.color]))
    expect(colorById.get(f.user.id)).toBe(f.user.color)
    expect(unsafe.map((p) => colorById.get(p.id))).toEqual(['#8A8F98', '#8A8F98', '#8A8F98'])
    // the read does not rewrite the row
    const stored = await t.run(async (ctx) => ctx.db.get(unsafe[0]._id))
    expect(stored?.color).toBe('url(https://example.test/p.png)')
  })

  it('viewer reaches the family via the grant only — dropping the grant drops everything', async () => {
    const snap = await snapFor(f.viewer)
    expect(snap.projects.map((p) => p.id).sort()).toEqual([f.meta.id, f.sub.id, f.sub2.id].sort())
    expect(snap.issues.map((i) => i.id)).toContain(issueVis.id)

    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.viewer.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    const bare = await snapFor(f.viewer)
    expect(bare.projects).toEqual([])
    expect(bare.issues).toEqual([])
    expect(bare.access).toEqual([])
  })

  it('cross-org fence: the second org is absent in both directions', async () => {
    const otherIssue = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const mine = await snapFor(f.admin)
    expect(mine.orgs.map((o) => o.id)).toEqual([f.org.id])
    expect(mine.projects.map((p) => p.id)).not.toContain(f.otherProject.id)
    expect(mine.profiles.map((p) => p.id)).not.toContain(f.otherAdmin.id)
    expect(mine.issues.map((i) => i.id)).not.toContain(otherIssue.id)

    const theirs = await snapFor(f.otherAdmin)
    expect(theirs.orgs.map((o) => o.id)).toEqual([f.otherOrg.id])
    expect(theirs.projects.map((p) => p.id)).toEqual([f.otherProject.id])
    expect(theirs.issues.map((i) => i.id)).toEqual([otherIssue.id])
    expect(theirs.profiles.map((p) => p.id)).toEqual([f.otherAdmin.id])
  })

  it('a second seat blends its org into the one snapshot', async () => {
    const seat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.admin.auth_user_id,
      org_role: 'guest',
      email: 'admin@testbed.test',
    })
    const snap = await snapFor(f.admin)
    expect(snap.orgs.map((o) => o.id).sort()).toEqual([f.org.id, f.otherOrg.id].sort())
    expect(snap.myProfileIds.sort()).toEqual([f.admin.id, seat.id].sort())
    // the guest seat has no grant in the other org: its org row rides, its projects do not
    expect(snap.projects.map((p) => p.id)).not.toContain(f.otherProject.id)
  })

  it('signed in without any seat returns null — the noProfile signal, distinct from forbidden', async () => {
    expect(
      await t.withIdentity({ subject: 'auth_nobody' }).query(api.workspace.root, {}),
    ).toBeNull()
    await expectRefusal(t.query(api.workspace.root, {}), 'forbidden')
    await expectRefusal(
      t.query(api.workspace.tasks, { org_id: f.org.id, from: '', to: null }),
      'forbidden',
    )
  })

  it('rows are pure snake_case app rows — no Convex system fields anywhere', async () => {
    const snap = await snapFor(f.admin)
    const sections = [
      snap.orgs,
      snap.teams,
      snap.profiles,
      snap.projects,
      snap.issues,
      snap.orgLoad,
    ]
    for (const section of sections) {
      for (const row of section) {
        expect(Object.keys(row)).not.toContain('_id')
        expect(Object.keys(row)).not.toContain('_creationTime')
      }
    }
  })
})

describe('billing redaction', () => {
  it('only an admin seat gets the billing object; counters ride for everyone', async () => {
    const admin = await snapFor(f.admin)
    expect(admin.orgs[0]?.billing).toEqual({ plan: 'team', seats: 5, renewal_date: null })

    const user = await snapFor(f.user)
    expect(user.orgs[0]?.billing).toBeUndefined()
    expect(user.orgs[0]?.next_issue_num).toBe(1)
    expect(user.orgs[0]?.next_project_num).toBe(5)

    const guest = await snapFor(f.guest)
    expect(guest.orgs[0]?.billing).toBeUndefined()
  })

  it('leaves out the retired Gravatar setting, whatever an older row stored', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { gravatar_avatars: true })
    })
    expect((await snapFor(f.user)).orgs[0]).not.toHaveProperty('gravatar_avatars')
  })
})

describe('projectAccess', () => {
  it("carries EVERYONE'S grants on visible projects and nothing on hidden ones", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: f.agent.id,
        level: 'user',
      })
    })
    const guest = await snapFor(f.guest)
    // the viewer's grant arrives in the guest's snapshot — not "own grants"
    expect(
      guest.access.some((a) => a.profile_id === f.viewer.id && a.project_id === f.meta.id),
    ).toBe(true)
    expect(guest.access.some((a) => a.project_id === f.hidden.id)).toBe(false)

    const admin = await snapFor(f.admin)
    expect(
      admin.access.some((a) => a.project_id === f.hidden.id && a.profile_id === f.agent.id),
    ).toBe(true)
  })
})

describe('archived split', () => {
  it('projects stay visible for archive navigation while archived task rows stay out of the snapshot', async () => {
    await t.run(async (ctx) => {
      const sub2 = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique()
      await ctx.db.patch(sub2!._id, { archived_at: NOW })
    })
    const archivedIssue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    const issueInArchived = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const label = await plantLabel('Old')
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['x']) as never))
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', {
        org_id: archivedIssue.org_id,
        issue_id: archivedIssue.id,
        label_id: label.id,
      })
      await ctx.db.insert('issue_links', {
        org_id: archivedIssue.org_id,
        id: uuid(),
        source_id: archivedIssue.id,
        target_id: issueVis.id,
        type: 'relates',
        pair_key: [archivedIssue.id, issueVis.id].sort().join(':'),
        created_at: NOW,
      })
      await ctx.db.insert('issue_attachments', {
        org_id: archivedIssue.org_id,
        id: uuid(),
        issue_id: archivedIssue.id,
        name: 'x.txt',
        size_bytes: 1,
        storage_id: storageId,
        inline: false,
        created_at: NOW,
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: archivedIssue.id,
        profile_id: f.admin.id,
        created_at: NOW,
      })
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: f.meta.id,
        name: 'Freeze',
        week: '2026-03-02',
        created_at: NOW,
      })
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: f.sub2.id,
        name: 'Dead',
        week: '2026-03-02',
        created_at: NOW,
      })
    })

    const snap = await snapFor(f.admin)
    expect(snap.projects.map((p) => p.id)).toContain(f.sub2.id)
    expect(snap.issues.map((i) => i.id)).toContain(issueVis.id)
    expect(snap.issues.map((i) => i.id)).not.toContain(archivedIssue.id)
    expect(snap.issues.map((i) => i.id)).not.toContain(issueInArchived.id)
    // The archive list is an on-demand read. Its labels, attachments and
    // links must not make the initial working snapshot (or its storage
    // metadata) grow with archived work.
    expect(snap.issueLabels.some((r) => r.issue_id === archivedIssue.id)).toBe(false)
    expect(snap.attachments.some((a) => a.issue_id === archivedIssue.id)).toBe(false)
    expect(
      snap.links.some((l) => l.source_id === archivedIssue.id || l.target_id === archivedIssue.id),
    ).toBe(false)
    expect(snap.issueSubs.some((row) => row.issue_id === archivedIssue.id)).toBe(false)
    // milestones follow the project-not-archived fence
    expect(snap.milestones.map((m) => m.project_id)).toContain(f.meta.id)
    expect(snap.milestones.map((m) => m.project_id)).not.toContain(f.sub2.id)
  })
})

describe('org_load', () => {
  it('staff who cannot see a project get its rows as anonymized busy time; those who can get the id', async () => {
    const hid2Issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: hidden2Sub.id,
      assignee_id: f.admin.id,
      start_week: '2026-01-05',
      end_week: '2026-01-19',
      remaining_hours: 3,
      remaining_set_at: NOW,
    })
    const staff = await snapFor(f.user) // staff, no standing on hidden2
    expect(staff.orgLoad.find((r) => r.owner_id === f.admin.id)).toEqual({
      issue_id: null,
      owner_id: f.admin.id,
      start_week: '2026-01-05',
      end_week: '2026-01-19',
      remaining: 3,
      remaining_set_at: NOW,
    })
    const admin = await snapFor(f.admin)
    expect(appLoadRows(admin).find((r) => r.owner_id === f.admin.id)?.issue_id).toBe(hid2Issue.id)
    // the snapshot sends only the rows of tasks its reader is not shown; the
    // app derives the others from the task rows
    expect(staff.orgLoad.length).toBeGreaterThan(0)
    expect(staff.orgLoad.every((r) => r.issue_id === null)).toBe(true)
    expect(admin.orgLoad.some((r) => r.issue_id === hid2Issue.id)).toBe(false)
  })

  it("guest: other people's hidden rows are excluded entirely; own hidden rows arrive anonymized", async () => {
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      assignee_id: f.user.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      remaining_hours: 4,
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      assignee_id: f.guest.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      remaining_hours: 7,
    })
    const snap = await snapFor(f.guest)
    // user's only surviving row is the visible one, identified — the hidden
    // 4h row does not arrive even anonymously
    expect(
      appLoadRows(snap)
        .filter((r) => r.owner_id === f.user.id)
        .map((r) => r.issue_id),
    ).toEqual([issueVis.id])
    expect(snap.orgLoad.find((r) => r.owner_id === f.guest.id)).toEqual({
      issue_id: null,
      owner_id: f.guest.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      remaining: 7,
      remaining_set_at: null,
    })
  })

  it("viewer: others' hidden work never arrives; granted work is identified", async () => {
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      assignee_id: f.user.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      remaining_hours: 4,
    })
    const snap = await snapFor(f.viewer)
    expect(appLoadRows(snap)).toEqual([
      {
        issue_id: issueVis.id,
        owner_id: f.user.id,
        start_week: '2026-01-05',
        end_week: '2026-01-12',
        remaining: 5,
        remaining_set_at: NOW,
      },
    ])
  })

  it('filters: remaining>0, not done, not paused, scheduled, active issue+project — but inactive, agent and any-org-profile assignees count', async () => {
    const scheduled = { start_week: '2026-02-02', end_week: '2026-02-09' }
    const inSub = { org_id: f.org.id, project_id: f.sub.id }
    await plantIssue(t, { ...inSub, ...scheduled, assignee_id: f.user.id, remaining_hours: 0 })
    await plantIssue(t, { ...inSub, ...scheduled, assignee_id: f.user.id }) // unestimated
    await plantIssue(t, {
      ...inSub,
      ...scheduled,
      assignee_id: f.user.id,
      remaining_hours: 2,
      status: 'done',
    })
    await plantIssue(t, { ...inSub, assignee_id: f.user.id, remaining_hours: 2 }) // unscheduled
    // paused: the assignee is free for other work until it resumes
    await plantIssue(t, {
      ...inSub,
      ...scheduled,
      assignee_id: f.user.id,
      remaining_hours: 2,
      paused: true,
    })
    await plantIssue(t, {
      ...inSub,
      ...scheduled,
      assignee_id: f.user.id,
      remaining_hours: 2,
      archived_at: NOW,
    })
    await plantIssue(t, { ...inSub, ...scheduled, assignee_id: uuid(), remaining_hours: 9 }) // dangling assignee
    await t.run(async (ctx) => {
      const sub2 = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique()
      await ctx.db.patch(sub2!._id, { archived_at: NOW })
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      ...scheduled,
      assignee_id: f.user.id,
      remaining_hours: 2,
    })
    // no active/kind fence on the assignee side
    await plantIssue(t, { ...inSub, ...scheduled, assignee_id: f.agent.id, remaining_hours: 6 })
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      active: false,
      auth_user_id: 'auth_inactive',
      email: 'inactive@testbed.test',
    })
    await plantIssue(t, { ...inSub, ...scheduled, assignee_id: inactive.id, remaining_hours: 8 })

    const snap = await snapFor(f.admin)
    expect(
      appLoadRows(snap)
        .filter((r) => r.owner_id === f.user.id)
        .map((r) => r.issue_id),
    ).toEqual([issueVis.id])
    expect(appLoadRows(snap).some((r) => r.owner_id === f.agent.id && r.remaining === 6)).toBe(true)
    expect(appLoadRows(snap).some((r) => r.owner_id === inactive.id && r.remaining === 8)).toBe(
      true,
    )
    expect(appLoadRows(snap).some((r) => r.remaining === 9)).toBe(false)
  })

  it('the owner carries the load: the reviewer while In Review with one set, else the assignee', async () => {
    const work = {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-03-02',
      end_week: '2026-03-09',
      remaining_hours: 2,
    }
    const pair = { assignee_id: f.user.id, reviewer_id: f.admin.id }
    const reviewing = await plantIssue(t, { ...work, ...pair, status: 'review' })
    const building = await plantIssue(t, { ...work, ...pair, status: 'progress' })
    const noReviewer = await plantIssue(t, { ...work, assignee_id: f.user.id, status: 'review' })
    const noAssignee = await plantIssue(t, { ...work, reviewer_id: f.admin.id, status: 'review' })
    const paused = await plantIssue(t, { ...work, ...pair, status: 'review', paused: true })

    const snap = await snapFor(f.admin)
    const ownersOf = (id: string) =>
      appLoadRows(snap)
        .filter((r) => r.issue_id === id)
        .map((r) => r.owner_id)
    expect(ownersOf(reviewing.id)).toEqual([f.admin.id])
    expect(ownersOf(building.id)).toEqual([f.user.id])
    expect(ownersOf(noReviewer.id)).toEqual([f.user.id])
    expect(ownersOf(noAssignee.id)).toEqual([f.admin.id])
    expect(ownersOf(paused.id)).toEqual([])
  })

  it('guest disclosure follows the owner: hidden work they review arrives anonymized, hidden work they only assign does not', async () => {
    const hiddenReview = {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      status: 'review',
      start_week: '2026-01-05',
      end_week: '2026-01-12',
    } as const
    await plantIssue(t, {
      ...hiddenReview,
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
      remaining_hours: 7,
    })
    await plantIssue(t, {
      ...hiddenReview,
      assignee_id: f.guest.id,
      reviewer_id: f.user.id,
      remaining_hours: 4,
    })
    const snap = await snapFor(f.guest)
    expect(snap.orgLoad.filter((r) => r.issue_id === null)).toEqual([
      {
        issue_id: null,
        owner_id: f.guest.id,
        start_week: '2026-01-05',
        end_week: '2026-01-12',
        remaining: 7,
        remaining_set_at: null,
      },
    ])
  })
})

describe('messages', () => {
  const msg = (
    recipient_id: string,
    created_at: string,
    read_at?: string,
    issue_id: string = issueVis.id,
  ) => ({
    id: uuid(),
    org_id: f.org.id,
    recipient_id,
    issue_id,
    issue_title: 'T',
    kind: 'change' as const,
    detail: 'd',
    created_at,
    ...(read_at === undefined ? {} : { read_at }),
  })

  /* A second seat of user's login: a guest in the other organization with
   * access to one task there. */
  const guestSeatOfUser = async () => {
    const profile = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.user.auth_user_id,
      org_role: 'guest',
      email: 'user@testbed.test',
    })
    const otherSub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const task = await plantIssue(t, { org_id: f.otherOrg.id, project_id: otherSub.id })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.otherProject.id,
        profile_id: profile.id,
        level: 'user',
      }),
    )
    return { profile, task }
  }

  /* The machine inbox (GET /v1/inbox) of `profile`, snoozed items included,
   * as message ids per task id. */
  const machineInbox = async (profile: Doc<'profiles'>) => {
    const page = await t.query(internal.machine.discussion.restListInbox, {
      callerId: profile.id,
      access: 'read',
      include_snoozed: 'true',
      limit: '200',
    })
    return {
      items: Object.fromEntries(page.items.map((i) => [i.task.id, i.messages.map((m) => m.id)])),
      truncated: page.truncated,
    }
  }

  it('own inbox only', async () => {
    const mine = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('messages', msg(f.guest.id, NOW))
      await ctx.db.insert('messages', msg(f.user.id, NOW, NOW))
      return (await ctx.db.get(_id)) as Doc<'messages'>
    })
    const snap = await snapFor(f.guest)
    expect(snap.messages.map((m) => m.id)).toEqual([mine.id])
    expect(snap.readMessageCount).toBe(0)
  })

  it('does not carry archived task messages in the working snapshot', async () => {
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    const ids = await t.run(async (ctx) => {
      const active = msg(f.user.id, NOW)
      const old = msg(f.user.id, NOW, undefined, archived.id)
      await ctx.db.insert('messages', active)
      await ctx.db.insert('messages', old)
      return { active: active.id, archived: old.id }
    })
    const snap = await snapFor(f.user)
    expect(snap.messages.map((m) => m.id)).toEqual([ids.active])
    expect(snap.messages.map((m) => m.id)).not.toContain(ids.archived)
  })

  it('caps at 500 with unread rows first, then the most recently read, so a long absence cannot push unread past the cap', async () => {
    const base = Date.parse('2026-01-02T00:00:00.000Z')
    const day = 86_400_000
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        // read long after creation, read_at strictly increasing with i
        await ctx.db.insert(
          'messages',
          msg(
            f.user.id,
            new Date(base + i * 1000).toISOString(),
            new Date(base + (i + 600) * 1000).toISOString(),
          ),
        )
      }
      for (let i = 1; i <= 3; i++) {
        await ctx.db.insert('messages', msg(f.user.id, new Date(base - i * day).toISOString()))
      }
    })
    const snap = await snapFor(f.user)
    expect(snap.messages).toHaveLength(500)
    // the bounded read keeps at most 500 read rows per seat, so the count
    // stops there; the client only asks whether it is above zero
    expect(snap.readMessageCount).toBe(500)
    // the three old unread rows survive, ahead of every read row
    expect(snap.messages.slice(0, 3).every((m) => m.read_at === undefined)).toBe(true)
    expect(snap.messages.filter((m) => m.read_at === undefined)).toHaveLength(3)
    // unread rows run newest first
    expect(snap.messages[0]?.created_at).toBe(new Date(base - day).toISOString())
    // read survivors are the 497 most recently read, newest read first, the
    // ones the list shows at the top
    expect(snap.messages[3]?.read_at).toBe(new Date(base + (500 + 600) * 1000).toISOString())
    const lastKept = snap.messages[snap.messages.length - 1]
    expect(lastKept?.read_at).toBe(new Date(base + (4 + 600) * 1000).toISOString())
  })

  it('across seats: unread rows newest first (id breaks a tie), then read rows most recently read first', async () => {
    const seat = await guestSeatOfUser()
    const at = (minute: number) => `2026-01-02T00:${String(minute).padStart(2, '0')}:00.000Z`
    const ids = await t.run(async (ctx) => {
      const rows = {
        u1: msg(f.user.id, at(1)),
        u2: { ...msg(seat.profile.id, at(2), undefined, seat.task.id), org_id: f.otherOrg.id },
        u3a: { ...msg(f.user.id, at(3)), id: 'aaaaaaaa-0000-4000-8000-000000000000' },
        u3b: {
          ...msg(seat.profile.id, at(3), undefined, seat.task.id),
          org_id: f.otherOrg.id,
          id: 'bbbbbbbb-0000-4000-8000-000000000000',
        },
        // created late, read early
        r1: msg(f.user.id, at(9), at(10)),
        r2: { ...msg(seat.profile.id, at(0), at(20), seat.task.id), org_id: f.otherOrg.id },
        r3: msg(f.user.id, at(0), at(30)),
      }
      for (const row of Object.values(rows)) await ctx.db.insert('messages', row)
      return Object.fromEntries(Object.entries(rows).map(([name, row]) => [row.id, name]))
    })
    const snap = await snapFor(f.user)
    expect(snap.messages.map((m) => ids[m.id])).toEqual([
      'u3b',
      'u3a',
      'u2',
      'u1',
      'r3',
      'r2',
      'r1',
    ])
    expect(snap.readMessageCount).toBe(3)
  })

  it('skips rows about tasks the caller is not shown, within the scan bound', async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    const ids = await t.run(async (ctx) => {
      const visible = [msg(f.user.id, NOW), msg(f.user.id, NOW, NOW)]
      for (const row of visible) await ctx.db.insert('messages', row)
      // newer rows about hidden and archived tasks, fewer than the bound
      for (let i = 0; i < 400; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW, undefined, hiddenTask.id))
        await ctx.db.insert('messages', msg(f.user.id, NOW, undefined, archived.id))
        await ctx.db.insert('messages', msg(f.user.id, NOW, NOW, hiddenTask.id))
      }
      return visible.map((row) => row.id)
    })
    const snap = await snapFor(f.user)
    expect(snap.messages.map((m) => m.id)).toEqual(ids)
    expect(snap.readMessageCount).toBe(1)
    // both walks reached every row, so the bulk actions need no flag
    expect(snap.unreadTruncated).toBe(false)
    expect(snap.readTruncated).toBe(false)
  })

  it('answers over a backlog larger than one transaction may read; visible rows past the bound wait', async () => {
    // The old full read of the inbox scanned every row and failed here.
    t = newT({
      transactionLimits: { documentsRead: 2600 },
    })
    f = await withOrg(t)
    const hidden = await plantProject(t, { org_id: f.org.id, lead_id: f.admin.id })
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden.id })
    const visibleTask = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      // older visible rows first, then a newer backlog about a hidden task
      await ctx.db.insert('messages', msg(f.user.id, NOW, undefined, visibleTask.id))
      await ctx.db.insert('messages', msg(f.user.id, NOW, NOW, visibleTask.id))
      for (let i = 0; i < 1500; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW, undefined, hiddenTask.id))
        await ctx.db.insert('messages', msg(f.user.id, NOW, NOW, hiddenTask.id))
      }
    })
    const snap = await snapFor(f.user)
    // each walk examines at most 2 * INBOX_LIMIT rows, all hidden here, so
    // the older visible rows are not reached, the accepted cost of the bound
    expect(snap.messages).toEqual([])
    expect(snap.readMessageCount).toBe(0)
    expect(snap.issues.map((i) => i.id)).toContain(visibleTask.id)
    // nothing visible was kept, but rows were left unexamined, so the app
    // keeps Mark all as read and Remove all read available
    expect(snap.unreadTruncated).toBe(true)
    expect(snap.readTruncated).toBe(true)
  })

  it('lists read rows even while hidden rows leave unread ones unexamined, as the machine inbox does', async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const visible = { unread: msg(f.user.id, NOW), read: msg(f.user.id, NOW, NOW) }
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', visible.unread)
      await ctx.db.insert('messages', visible.read)
      // newer unread rows about a hidden task, more than the unread walk
      // examines (2 * INBOX_LIMIT)
      for (let i = 0; i < 2 * INBOX_LIMIT + 100; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW, undefined, hiddenTask.id))
      }
    })
    let snap = await snapFor(f.user)
    // the read walk is bounded on its own, so the read row is listed; the
    // older unread row is past the unread walk's bound and listed by neither
    // surface, so both show the task as read
    expect(snap.messages.map((m) => m.id)).toEqual([visible.read.id])
    expect(snap.readMessageCount).toBe(1)
    expect(snap.unreadTruncated).toBe(true)
    expect(snap.readTruncated).toBe(false)
    expect(await machineInbox(f.user)).toEqual({
      items: { [issueVis.id]: [visible.read.id] },
      truncated: true,
    })

    // once the walk reaches every unread row, both are listed, unread first
    await t.run(async (ctx) => {
      const hiddenRows = await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.user.id).eq('issue_id', hiddenTask.id),
        )
        .take(200)
      for (const row of hiddenRows) await ctx.db.delete(row._id)
    })
    snap = await snapFor(f.user)
    expect(snap.messages.map((m) => m.id)).toEqual([visible.unread.id, visible.read.id])
    expect(snap.readMessageCount).toBe(1)
    expect(snap.unreadTruncated).toBe(false)
    expect(snap.messagesCut).toBeUndefined()
    // the machine inbox runs an item's messages oldest first, and these
    // share created_at, so their ids order them
    expect(await machineInbox(f.user)).toEqual({
      items: { [issueVis.id]: [visible.unread.id, visible.read.id].sort() },
      truncated: false,
    })
  })

  it('reads past a stopped walk for a row the bulk actions reach, passing at most `peek` snoozed rows', async () => {
    const until = '2027-01-01T00:00:00.000Z'
    const ids = await t.run(async (ctx) => {
      const inserted = []
      // oldest first, one row that is not snoozed and then three snoozed ones
      for (const snoozed of [false, true, true, true]) {
        const row = msg(f.user.id, NOW)
        inserted.push(
          await ctx.db.insert('messages', snoozed ? { ...row, snoozed_until: until } : row),
        )
      }
      return inserted
    })
    // keeps one row, the newest, then reads on past the snoozed ones
    const load = (peek?: number) => t.run((ctx) => loadInbox(ctx, f.user.id, () => true, 1, peek))

    // two snoozed rows, then the oldest one, which Mark all as read reaches
    expect(await load(3)).toMatchObject({ unreadTruncated: true, truncated: true })
    await t.run((ctx) => ctx.db.patch(ids[0], { snoozed_until: until }))
    // every row past the stop is snoozed, which neither action touches
    expect(await load(3)).toMatchObject({
      unreadTruncated: false,
      readTruncated: false,
      truncated: true,
    })
    // after two snoozed rows another follows, so it stops reading and counts
    // one as possible
    expect(await load(2)).toMatchObject({ unreadTruncated: true, truncated: true })
    // without a peek the flag is the walk's truncation, as the machine inbox reads
    expect(await load()).toMatchObject({ unreadTruncated: true, truncated: true })
  })

  it('does not flag a backlog past the bound when every row left is snoozed', async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const until = '2027-01-01T00:00:00.000Z'
    const oldestId = await t.run(async (ctx) => {
      // the oldest row, about a task the caller is not shown
      const oldest = await ctx.db.insert('messages', {
        ...msg(f.user.id, NOW, undefined, hiddenTask.id),
        snoozed_until: until,
      })
      // more snoozed unread rows than one walk keeps
      for (let i = 0; i < INBOX_LIMIT + 20; i++) {
        await ctx.db.insert('messages', { ...msg(f.user.id, NOW), snoozed_until: until })
      }
      return oldest
    })
    let snap = await snapFor(f.user)
    expect(snap.messages).toHaveLength(INBOX_LIMIT)
    expect(snap.unreadTruncated).toBe(false)
    // the Inbox still says it lists fewer messages than there are
    expect(snap.messagesCut).toBe(true)
    // the machine inbox still reports rows it did not look at
    expect((await machineInbox(f.user)).truncated).toBe(true)

    // once that row is no longer snoozed, Mark all as read has it to reach
    await t.run((ctx) => ctx.db.patch(oldestId, { snoozed_until: undefined }))
    snap = await snapFor(f.user)
    expect(snap.unreadTruncated).toBe(true)
  })

  it('flags unread rows of another seat that the shared cap drops behind snoozed ones', async () => {
    const seat = await guestSeatOfUser()
    const until = '2027-01-01T00:00:00.000Z'
    const otherId = await t.run(async (ctx) => {
      // older than every row of the first seat, so the cut drops it
      const other = await ctx.db.insert('messages', {
        ...msg(seat.profile.id, '2025-12-31T00:00:00.000Z', undefined, seat.task.id),
        org_id: f.otherOrg.id,
        snoozed_until: until,
      })
      // exactly as many as one walk keeps, so no walk stops early
      for (let i = 0; i < INBOX_LIMIT; i++) {
        await ctx.db.insert('messages', { ...msg(f.user.id, NOW), snoozed_until: until })
      }
      return other
    })
    let snap = await snapFor(f.user)
    expect(snap.messages).toHaveLength(INBOX_LIMIT)
    expect(snap.messages.every((m) => m.snoozed_until === until)).toBe(true)
    expect(snap.unreadTruncated).toBe(false)

    await t.run((ctx) => ctx.db.patch(otherId, { snoozed_until: undefined }))
    snap = await snapFor(f.user)
    // still cut, but now a row Mark all as read reaches
    expect(snap.messages.map((m) => m.recipient_id)).not.toContain(seat.profile.id)
    expect(snap.unreadTruncated).toBe(true)
  })

  it('keeps recent unread and read rows ahead of an old unread backlog about archived tasks', async () => {
    // Unread rows about an auto-archived task are never deleted, so they pile
    // up behind a person's current work.
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const at = (minute: number) => `2026-02-01T00:${String(minute).padStart(2, '0')}:00.000Z`
    const recent = {
      unread1: msg(f.user.id, at(1)),
      unread2: msg(f.user.id, at(2)),
      // opened in the app, so read, the latest read first
      read1: msg(f.user.id, at(3), at(10), other.id),
      read2: msg(f.user.id, at(4), at(11), other.id),
    }
    await t.run(async (ctx) => {
      for (let i = 0; i < 2 * INBOX_LIMIT + 100; i++) {
        await ctx.db.insert(
          'messages',
          msg(f.user.id, '2026-01-01T00:00:00.000Z', undefined, archived.id),
        )
      }
      for (const row of Object.values(recent)) await ctx.db.insert('messages', row)
    })
    const snap = await snapFor(f.user)
    expect(snap.messages.map((m) => m.id)).toEqual([
      recent.unread2.id,
      recent.unread1.id,
      recent.read2.id,
      recent.read1.id,
    ])
    expect(snap.readMessageCount).toBe(2)
    // the machine inbox lists both items; the backlog was not all examined
    expect(await machineInbox(f.user)).toEqual({
      items: {
        [issueVis.id]: [recent.unread1.id, recent.unread2.id],
        [other.id]: [recent.read1.id, recent.read2.id],
      },
      truncated: true,
    })
  })

  it('counts read messages across own seats even when 500 unread messages hide every read row', async () => {
    const { profile: seat, task: otherTask } = await guestSeatOfUser()
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW))
      }
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW, NOW))
      }
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('messages', {
          ...msg(seat.id, NOW, NOW, otherTask.id),
          org_id: f.otherOrg.id,
        })
      }
      // Read notifications belonging to other people must not enter the count.
      await ctx.db.insert('messages', msg(f.admin.id, NOW, NOW))
      await ctx.db.insert('messages', {
        ...msg(f.otherAdmin.id, NOW, NOW),
        org_id: f.otherOrg.id,
      })
    })

    const snap = await snapFor(f.user)
    expect(snap.messages).toHaveLength(500)
    expect(snap.messages.every((message) => message.read_at === undefined)).toBe(true)
    expect(snap.readMessageCount).toBe(5)
  })

  it('a task the recipient can no longer access takes its messages out of the inbox until access returns', async () => {
    const ids = await t.run(async (ctx) => {
      const unread = msg(f.guest.id, NOW)
      const read = msg(f.guest.id, NOW, NOW)
      const admins = msg(f.admin.id, NOW)
      for (const row of [unread, read, admins]) await ctx.db.insert('messages', row)
      return { unread: unread.id, read: read.id, admins: admins.id }
    })
    const inbox = async (p: Doc<'profiles'>) => {
      const snap = await snapFor(p)
      return { ids: snap.messages.map((m) => m.id).sort(), read: snap.readMessageCount }
    }
    expect(await inbox(f.guest)).toEqual({ ids: [ids.read, ids.unread].sort(), read: 1 })
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique(),
    )
    await t.run((ctx) => ctx.db.delete(grant!._id))
    expect(await inbox(f.guest)).toEqual({ ids: [], read: 0 })
    // the rows stay stored and return with access
    expect(await t.run((ctx) => ctx.db.query('messages').collect())).toHaveLength(3)
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.guest.id,
        level: 'user',
      }),
    )
    expect(await inbox(f.guest)).toEqual({ ids: [ids.read, ids.unread].sort(), read: 1 })
    // a move into a project the guest cannot access hides them again
    await t.run((ctx) => ctx.db.patch(issueVis._id, { project_id: hidden2Sub.id }))
    expect(await inbox(f.guest)).toEqual({ ids: [], read: 0 })
    expect((await inbox(f.admin)).ids).toEqual([ids.admins])
  })

  it('a message about a task that no longer exists reaches nobody', async () => {
    const orphan = await t.run(async (ctx) => {
      const row = msg(f.admin.id, NOW, NOW, uuid())
      await ctx.db.insert('messages', row)
      return row.id
    })
    const snap = await snapFor(f.admin)
    expect(snap.messages.map((m) => m.id)).not.toContain(orphan)
    expect(snap.readMessageCount).toBe(0)
  })
})

describe('task history visibility', () => {
  const ev = (extra: Partial<WithoutSystemFields<Doc<'activity_events'>>>) => ({
    id: uuid(),
    org_id: f.org.id,
    ts: NOW,
    actor_id: f.admin.id,
    verb: 'moved',
    target_type: 'issue' as const,
    target_id: uuid(),
    label: 'x',
    ...extra,
  })

  /* The rows about `taskId` that `p` receives in the task window: its
   * thread's history when `p` is shown the task, else none. */
  const historyOf = async (p: Doc<'profiles'>, taskId: string) => {
    const snap = await snapFor(p)
    if (!snap.issues.some((i) => i.id === taskId)) return []
    const page = await as(t, p).query(api.snapshot.threadHistory, {
      org_id: f.org.id,
      issue_id: taskId,
    })
    return page.events
  }
  const seen = async (p: Doc<'profiles'>) =>
    (await historyOf(p, issueVis.id)).map((a) => a.id).sort()

  /* A person granted only one sub-project; for f.sub or f.sub2 that shows
   * f.meta for navigation alone. */
  const seatOn = async (projectId: string, org_role: 'user' | 'guest' = 'user') => {
    const seat = await plantSeat(t, {
      org_id: f.org.id,
      auth_user_id: `seat_${uuid()}`,
      email: `${uuid()}@testbed.test`,
      org_role,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: projectId,
        profile_id: seat.id,
        level: 'user',
      }),
    )
    return seat
  }

  it("a moved task's history reaches only people who can access both ends of each move", async () => {
    const sourceOnly = await seatOn(f.sub.id)
    const destinationOnly = await seatOn(f.sub2.id)
    const taskId = uuid()
    const move = (project_id: string) =>
      as(t, f.user).mutation(api.issues.move, { org_id: f.org.id, id: taskId, project_id })
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id: taskId,
      project_id: f.sub.id,
      title: 'Travelling task',
    })
    const taskRows = async (p: Doc<'profiles'>) =>
      (await historyOf(p, taskId)).map((a) => `${a.verb}${a.detail ? ` ${a.detail}` : ''}`).sort()
    const created = 'created'
    const there = 'moved to the Board rev sub-project (from Firmware)'
    const back = 'moved to the Firmware sub-project (from Board rev)'
    expect(await taskRows(sourceOnly)).toEqual([created])

    await move(f.sub2.id)
    expect(await taskRows(sourceOnly)).toEqual([])
    // the earlier rows were filed under f.sub
    expect(await taskRows(destinationOnly)).toEqual([])
    expect(await taskRows(f.guest)).toEqual([created, there].sort())

    // Back in f.sub, the first move still names Board rev.
    await move(f.sub.id)
    expect(await taskRows(sourceOnly)).toEqual([created])
    expect(await taskRows(destinationOnly)).toEqual([])
    expect(await taskRows(f.guest)).toEqual([created, back, there].sort())
  })

  /* Activity rows keep a deleted project's id while it is in Deleted items,
   * so a restore finds them filed under it again. Members who cannot see a
   * project lose its rows meanwhile, and get the moved task's earlier rows
   * back once the purge clears that id (model/deletedItems.ts). */
  it('a task that moved out of a deleted project gets its earlier history back once the project is purged', async () => {
    const destinationOnly = await seatOn(f.sub.id)
    const taskId = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id: taskId,
      project_id: f.sub2.id,
      title: 'Rescued task',
    })
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: taskId,
      project_id: f.sub.id,
    })
    const taskRows = async (p: Doc<'profiles'>) =>
      (await historyOf(p, taskId)).map((a) => a.verb).sort()
    expect(await taskRows(destinationOnly)).toEqual([])

    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub2.id })
    for (const p of [destinationOnly, f.guest, f.user]) expect(await taskRows(p)).toEqual([])
    expect(await taskRows(f.admin)).toEqual(['created', 'moved'])
    await t.run(async (ctx) => {
      const item = await ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', f.sub2.id))
        .unique()
      if (item === null) throw new Error('the project did not move to Deleted items')
      await startPurge(ctx, item, { inline: true })
    })
    for (const p of [destinationOnly, f.guest, f.user]) {
      expect(await taskRows(p)).toEqual(['created', 'moved'])
    }
  })

  it('a row that names another task reaches only people who can access that task where it is now', async () => {
    const subOnly = await seatOn(f.sub.id)
    // a subtask stays in its parent's top-level project, so the parent the
    // seats cannot see is in a third sub-project of Testbed
    const bothSubs = await seatOn(f.sub.id)
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: bothSubs.id,
        level: 'user',
      }),
    )
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
    })
    const task = (project_id: string) => plantIssue(t, { org_id: f.org.id, project_id })
    const child = await task(f.sub.id)
    const sameParent = await task(f.sub.id)
    const siblingParent = await task(f.sub2.id)
    const hiddenParent = await task(hiddenSub.id)
    const linkSame = await task(f.sub.id)
    const linkSibling = await task(f.sub2.id)
    const writer = as(t, f.user) // leads f.meta
    const reparent = (parent_id: string | null) =>
      writer.mutation(api.issues.update, { org_id: f.org.id, id: child.id, patch: { parent_id } })
    const link = (target_id: string) =>
      writer.mutation(api.issues.addLink, {
        org_id: f.org.id,
        id: uuid(),
        source_id: child.id,
        target_id,
        type: 'relates',
      })
    await reparent(sameParent.id)
    await reparent(siblingParent.id)
    await reparent(hiddenParent.id)
    await reparent(null)
    await link(linkSame.id)
    await link(linkSibling.id)
    // back under the hidden parent, then away to a visible one: the row
    // still names the hidden parent it came from
    await reparent(hiddenParent.id)
    await reparent(sameParent.id)
    const key = (i: Doc<'issues'>) => `QN-${i.num}`
    const rowsAbout = {
      A: `moved under ${key(sameParent)}`,
      B: `moved under ${key(siblingParent)} (from ${key(sameParent)})`,
      C: `moved under ${key(hiddenParent)} (from ${key(siblingParent)})`,
      D: `detached from ${key(hiddenParent)}`,
      E: `linked (relates to ${key(linkSame)})`,
      F: `linked (relates to ${key(linkSibling)})`,
      G: `moved under ${key(hiddenParent)}`,
      H: `moved under ${key(sameParent)} (from ${key(hiddenParent)})`,
    }
    const seenRows = async (p: Doc<'profiles'>) => {
      const mine = new Set((await historyOf(p, child.id)).map((a) => `${a.verb} ${a.detail}`))
      return Object.entries(rowsAbout)
        .filter(([, row]) => mine.has(row))
        .map(([name]) => name)
    }
    const all = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    for (const p of [f.admin, f.user]) expect(await seenRows(p)).toEqual(all)
    expect(await seenRows(bothSubs)).toEqual(['A', 'B', 'E', 'F'])
    expect(await seenRows(subOnly)).toEqual(['A', 'E'])
    // the named task's CURRENT project decides
    await writer.mutation(api.issues.move, {
      org_id: f.org.id,
      id: linkSibling.id,
      project_id: f.sub.id,
    })
    expect(await seenRows(subOnly)).toEqual(['A', 'E', 'F'])
    // a deleted named task, or wording no writer produces, reaches admins only
    await writer.mutation(api.issues.deleteDeep, { org_id: f.org.id, id: sameParent.id })
    expect(await seenRows(bothSubs)).toEqual(['E', 'F'])
    expect(await seenRows(f.admin)).toEqual(all)
  })

  it('a relation row reaches the people who can read every task its list names', async () => {
    const member = await seatOn(f.sub.id)
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hiddenSub.id })
    const ids = await t.run(async (ctx) => {
      const on = { project_id: f.sub.id, target_id: issueVis.id }
      const rows = {
        link: ev({
          ...on,
          verb: 'linked',
          detail: `(blocks QN-${other.num}), via MCP`,
          named_task_nums: [other.num],
        }),
        detach: ev({
          ...on,
          verb: 'detached',
          detail: `from QN-${other.num}, via the REST API (CI key)`,
          named_task_nums: [other.num],
        }),
        // the other end is a task the member cannot read
        hidden: ev({
          ...on,
          verb: 'linked',
          detail: `(relates to QN-${hiddenTask.num})`,
          named_task_nums: [hiddenTask.num],
        }),
      }
      for (const row of Object.values(rows)) await ctx.db.insert('activity_events', row)
      return rows
    })
    expect(await seen(f.admin)).toEqual(
      Object.values(ids)
        .map((r) => r.id)
        .sort(),
    )
    expect(await seen(member)).toEqual([ids.link.id, ids.detach.id].sort())
  })
})

describe('issueSubs', () => {
  it('own rows only, across seats', async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_subscriptions', {
        issue_id: issueVis.id,
        profile_id: f.guest.id,
        created_at: NOW,
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: issueVis.id,
        profile_id: f.user.id,
        created_at: NOW,
      })
    })
    const snap = await snapFor(f.guest)
    expect(snap.issueSubs).toEqual([
      { issue_id: issueVis.id, profile_id: f.guest.id, created_at: NOW },
    ])
  })

  it('a subscription to a task the person cannot access stays out, whatever its state', async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    await t.run(async (ctx) => {
      for (const issue_id of [issueVis.id, hiddenTask.id]) {
        await ctx.db.insert('issue_subscriptions', {
          issue_id,
          profile_id: f.guest.id,
          created_at: NOW,
        })
      }
    })
    const subs = async () => (await snapFor(f.guest)).issueSubs.map((s) => s.issue_id)
    expect(await subs()).toEqual([issueVis.id])
    // archiving or restoring the hidden task changes nothing the guest sees
    await t.run((ctx) => ctx.db.patch(hiddenTask._id, { archived_at: NOW }))
    expect(await subs()).toEqual([issueVis.id])
    await t.run((ctx) => ctx.db.patch(hiddenTask._id, { archived_at: undefined }))
    expect(await subs()).toEqual([issueVis.id])
  })
})

describe('links', () => {
  const link = (source_id: string, target_id: string) => ({
    id: uuid(),
    org_id: f.org.id,
    source_id,
    target_id,
    type: 'relates' as const,
    pair_key: [source_id, target_id].sort().join(':'),
    created_at: NOW,
  })

  it('a link reaches a person only when both tasks are in their working set', async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const siblingTask = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const ids = await t.run(async (ctx) => {
      const rows = {
        hidden: link(issueVis.id, hiddenTask.id),
        sibling: link(siblingTask.id, issueVis.id),
        dangling: link(issueVis.id, uuid()),
      }
      for (const row of Object.values(rows)) await ctx.db.insert('issue_links', row)
      return Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.id]))
    })
    const links = async (p: Doc<'profiles'>) => (await snapFor(p)).links.map((l) => l.id).sort()
    expect(await links(f.admin)).toEqual([ids.hidden, ids.sibling].sort())
    for (const p of [f.guest, f.viewer]) expect(await links(p)).toEqual([ids.sibling])
  })
})

/* A grant on one sub-project shows its parent for navigation only. The
 * parent's grants, team grants and milestones still arrive, because the
 * sub-project inherits the grants and shows the milestones. A sibling
 * sub-project, its tasks, grants and milestones never arrive. */
describe('navigation-only parents', () => {
  it('send the parent row and what the sub-project inherits, and nothing of its siblings', async () => {
    const subOnly = await plantSeat(t, {
      org_id: f.org.id,
      auth_user_id: `seat_${uuid()}`,
      email: `${uuid()}@testbed.test`,
      org_role: 'user',
    })
    const siblingOnly = await plantSeat(t, {
      org_id: f.org.id,
      auth_user_id: `seat_${uuid()}`,
      email: `${uuid()}@testbed.test`,
      org_role: 'user',
    })
    const sibling = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const parentTeam = uuid()
    const milestone = (project_id: string, name: string) => ({
      id: uuid(),
      project_id,
      name,
      week: '2026-01-05',
      created_at: NOW,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subOnly.id,
        level: 'user',
      })
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: siblingOnly.id,
        level: 'user',
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'viewer',
      })
      // a team subOnly is not in, granted on the parent: the sub-project inherits it
      await ctx.db.insert('teams', {
        id: parentTeam,
        org_id: f.org.id,
        name: 'Parent planners',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: parentTeam,
        level: 'user',
      })
      await ctx.db.insert('milestones', milestone(f.meta.id, 'Parent launch'))
      await ctx.db.insert('milestones', milestone(f.sub2.id, 'Sibling demo'))
      // every optional project field set, so the key list below is complete
      const meta = await ctx.db.get(f.meta._id)
      await ctx.db.patch(meta!._id, {
        lead_id: f.user.id,
        icon: 'rocket',
        icon_color: '#335577',
        review_hours: 3,
        team_id: f.team.id,
        description: 'Parent plans',
      })
      // a legacy team icon of any length, as stored before icons were dropped
      await ctx.db.patch(f.team._id, { icon: 'x'.repeat(5000), icon_color: '#335577' })
    })

    const snap = await snapFor(subOnly)
    expect(snap.projects.map((p) => p.id).sort()).toEqual([f.meta.id, f.sub.id].sort())
    // A new project field reaches navigation-only parents unless it is
    // judged here first.
    const meta = snap.projects.find((p) => p.id === f.meta.id)!
    // the legacy icon and its color stay on the server
    expect(Object.keys(meta).sort()).toEqual([
      'created_at',
      'description',
      'id',
      'key',
      'lead_id',
      'name',
      'num',
      'org_id',
      'review_hours',
      'sort_order',
      'team_id',
      'track_delay',
      'type',
    ])
    const team = snap.teams.find((row) => row.id === f.team.id)!
    expect('icon' in team || 'icon_color' in team).toBe(false)
    expect(snap.issues.some((i) => i.id === sibling.id)).toBe(false)
    expect(new Set(snap.access.map((a) => a.project_id))).toEqual(new Set([f.meta.id, f.sub.id]))
    expect(snap.access.some((a) => a.profile_id === siblingOnly.id)).toBe(false)
    expect(snap.teamAccess.some((g) => g.project_id === f.sub2.id)).toBe(false)
    expect(snap.teamAccess).toContainEqual({
      project_id: f.meta.id,
      team_id: parentTeam,
      level: 'user',
    })
    expect(snap.milestones.map((m) => m.name)).toEqual(['Parent launch'])
  })
})

describe('hidden parents', () => {
  it('a task row names its parent only when the parent is in the working set', async () => {
    const hiddenParent = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: hiddenParent.id,
    })
    const near = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: issueVis.id,
    })
    const row = async (p: Doc<'profiles'>, id: string) =>
      (await snapFor(p)).issues.find((i) => i.id === id)
    const guestChild = await row(f.guest, child.id)
    expect(guestChild && 'parent_id' in guestChild).toBe(false)
    expect(guestChild?.has_hidden_parent).toBe(true)
    expect(await row(f.admin, child.id)).toMatchObject({
      parent_id: hiddenParent.id,
      has_hidden_parent: false,
    })
    expect(await row(f.guest, near.id)).toMatchObject({
      parent_id: issueVis.id,
      has_hidden_parent: false,
    })
    // a parent in an archived project is outside everyone's working set
    await t.run(async (ctx) => {
      const sub2 = await ctx.db.get(f.sub2._id)
      await ctx.db.patch(sub2!._id, { archived_at: NOW })
      await ctx.db.patch(near._id, { parent_id: undefined })
    })
    const inSub2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const underArchived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: inSub2.id,
    })
    for (const p of [f.guest, f.admin]) {
      expect(await row(p, underArchived.id)).toMatchObject({ has_hidden_parent: true })
    }
  })

  it('browser task results never return a parent the caller cannot see', async () => {
    const hiddenParent = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: hiddenParent.id,
    })
    const updated = await as(t, f.guest).mutation(api.issues.update, {
      org_id: f.org.id,
      id: child.id,
      patch: { title: 'Renamed' },
    })
    expect('parent_id' in updated).toBe(false)
    const adminUpdated = await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: child.id,
      patch: { title: 'Renamed again' },
    })
    expect(adminUpdated.parent_id).toBe(hiddenParent.id)
    await t.run((ctx) => ctx.db.patch(child._id, { archived_at: NOW }))
    const row = await as(t, f.guest).query(api.issues.archivedTask, { id: child.id })
    expect(row).toMatchObject({ id: child.id })
    expect(JSON.stringify(row)).not.toContain(hiddenParent.id)
  })

  it("no task id outside a person's working set leaves the snapshot", async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: hiddenTask.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_links', {
        id: uuid(),
        org_id: f.org.id,
        source_id: child.id,
        target_id: hiddenTask.id,
        type: 'blocks',
        pair_key: [child.id, hiddenTask.id].sort().join(':'),
        created_at: NOW,
      })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: hiddenTask.id,
        profile_id: f.guest.id,
        created_at: NOW,
      })
      await ctx.db.insert('messages', {
        id: uuid(),
        org_id: f.org.id,
        recipient_id: f.guest.id,
        issue_id: hiddenTask.id,
        issue_title: 'Hidden',
        kind: 'change',
        detail: 'd',
        created_at: NOW,
      })
    })
    const snap = await snapFor(f.guest)
    const known = new Set(snap.issues.map((i) => i.id))
    const referenced = [
      ...snap.issues.flatMap((i) => (i.parent_id ? [i.parent_id] : [])),
      ...snap.links.flatMap((l) => [l.source_id, l.target_id]),
      ...snap.issueSubs.map((s) => s.issue_id),
      ...snap.messages.map((m) => m.issue_id),
      ...snap.issueLabels.map((l) => l.issue_id),
      ...snap.attachments.map((a) => a.issue_id),
    ]
    expect(referenced.filter((id) => !known.has(id))).toEqual([])
    expect(JSON.stringify(snap)).not.toContain(hiddenTask.id)
  })
})

/* The task window's history under All (threadHistory), by the rule REST
 * and MCP follow. */
describe('threadHistory events', () => {
  /* A seat with User on each of `projectIds`. */
  const seatOn = async (...projectIds: string[]) => {
    const seat = await plantSeat(t, {
      org_id: f.org.id,
      auth_user_id: `seat_${uuid()}`,
      email: `${uuid()}@testbed.test`,
    })
    await t.run(async (ctx) => {
      for (const project_id of projectIds)
        await ctx.db.insert('project_access', { project_id, profile_id: seat.id, level: 'user' })
    })
    return seat
  }
  const thread = (p: Doc<'profiles'>, issue_id: string) =>
    as(t, p).query(api.snapshot.threadHistory, { org_id: f.org.id, issue_id })
  const events = async (p: Doc<'profiles'>, issue_id: string) =>
    (await thread(p, issue_id)).events.map((e) => e.id)
  const rest = async (p: Doc<'profiles'>, issue_id: string) =>
    (
      await t.query(internal.machine.records.restTaskActivity, {
        callerId: p.id,
        access: 'read',
        ref: issue_id,
      })
    ).map((row) => row.id)
  const mcp = async (p: Doc<'profiles'>, issue_id: string) =>
    (
      JSON.parse(
        await t.query(internal.machine.records.mcpTaskActivity, {
          callerId: p.id,
          access: 'read',
          ref: issue_id,
        }),
      ) as { id: string }[]
    ).map((row) => row.id)
  const ev = (extra: Partial<WithoutSystemFields<Doc<'activity_events'>>>) => ({
    id: uuid(),
    org_id: f.org.id,
    ts: NOW,
    actor_id: f.admin.id,
    verb: 'changed',
    target_type: 'issue' as const,
    target_id: issueVis.id,
    label: 'x',
    project_id: f.sub.id,
    ...extra,
  })
  /* Raw rows, one second apart in this order. A task row names no task
   * unless it brings its own list, as the app writes it. */
  const plantRows = (rows: ReturnType<typeof ev>[]) =>
    t.run(async (ctx) => {
      const base = Date.parse(NOW)
      for (const [i, row] of rows.entries())
        await ctx.db.insert('activity_events', {
          named_task_nums: row.target_type === 'issue' ? [] : undefined,
          ...row,
          ts: new Date(base + i * 1000).toISOString(),
        })
      return rows.map((row) => row.id)
    })

  it('gives every seat the rows REST and MCP give it, fewer than an admin', async () => {
    const writer = as(t, f.admin)
    const create = async (project_id: string, title: string) => {
      const id = uuid()
      await writer.mutation(api.issues.create, { org_id: f.org.id, id, project_id, title })
      return id
    }
    const update = (id: string, patch: Record<string, unknown>) =>
      writer.mutation(api.issues.update, { org_id: f.org.id, id, patch })
    const move = (id: string, project_id: string) =>
      writer.mutation(api.issues.move, { org_id: f.org.id, id, project_id })
    const link = (source_id: string, target_id: string) =>
      writer.mutation(api.issues.addLink, {
        org_id: f.org.id,
        id: uuid(),
        source_id,
        target_id,
        type: 'blocks',
      })
    const inSkunk = await create(hiddenSub.id, 'Skunk task')
    const inBoard = await create(f.sub2.id, 'Board task')
    const parent = await create(f.sub.id, 'Parent')
    // stays in Firmware: links to tasks some seats cannot read, and a parent
    const t1 = await create(f.sub.id, 'Stays')
    await update(t1, { status: 'progress' })
    await link(t1, inSkunk)
    await link(t1, inBoard)
    await update(t1, { parent_id: parent })
    // from Board rev to Firmware, and from Firmware to Board rev
    const t2 = await create(f.sub2.id, 'Comes over')
    await move(t2, f.sub.id)
    await update(t2, { priority: 'high' })
    const t3 = await create(f.sub.id, 'Goes over')
    await move(t3, f.sub2.id)
    await update(t3, { priority: 'high' })
    // from a project only admins see
    const t4 = await create(hidden2Sub.id, 'Surfaces')
    await move(t4, f.sub.id)
    await update(t4, { priority: 'high' })
    const tasks = [t1, t2, t3, t4]
    const seats = [
      f.admin,
      f.user,
      f.guest,
      f.viewer,
      await seatOn(f.sub.id),
      await seatOn(f.sub2.id),
      await seatOn(f.sub.id, f.sub2.id),
    ]
    const everyRow = new Set<string>()
    for (const task of tasks) for (const id of await events(f.admin, task)) everyRow.add(id)
    for (const seat of seats) {
      const shown = new Set((await snapFor(seat)).issues.map((i) => i.id))
      const received: string[] = []
      for (const task of tasks.filter((id) => shown.has(id))) {
        const got = await events(seat, task)
        expect(await rest(seat, task)).toEqual(got)
        expect(await mcp(seat, task)).toEqual(got)
        received.push(...got)
      }
      expect(received.length).toBeGreaterThan(0)
      if (seat !== f.admin) expect(received.length).toBeLessThan(everyRow.size)
    }
  })

  it('sends no history for an archived task or a task in an archived project, which REST and MCP still answer', async () => {
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
    })
    const archivedProject = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const inArchived = await plantIssue(t, { org_id: f.org.id, project_id: archivedProject.id })
    for (const task of [archived, inArchived]) {
      await plantRows([ev({ target_id: task.id, project_id: task.project_id })])
      await t.run((ctx) =>
        ctx.db.insert('comments', {
          id: uuid(),
          issue_id: task.id,
          author: f.user.id,
          body: 'still here',
          created_at: NOW,
        }),
      )
      for (const p of [f.admin, f.guest]) {
        const comments = await as(t, p).query(api.snapshot.threadComments, {
          org_id: f.org.id,
          issue_id: task.id,
        })
        expect(comments.comments.map((c) => c.body)).toEqual(['still here'])
        expect(await thread(p, task.id)).toEqual({ events: [], earlier: false, next: null })
        const anchor = (await rest(f.admin, task.id))[0]
        const before = await as(t, p).query(api.snapshot.historyBefore, {
          org_id: f.org.id,
          issue_id: task.id,
          before: anchor,
        })
        expect(before).toEqual({ events: [], earlier: false, next: null })
        expect(await rest(p, task.id)).toHaveLength(1)
        expect(await mcp(p, task.id)).toHaveLength(1)
      }
    }
  })

  it("drops only an archive row's legacy subtask count, singular or plural, for members", async () => {
    const counted = { named_task_nums: [] as number[] }
    const ids = await plantRows([
      ev({ ...counted, verb: 'archived', detail: 'with 1 subtask' }),
      ev({ ...counted, verb: 'archived', detail: 'with 2 subtasks' }),
      // the same words under another verb are not a count
      ev({ ...counted, verb: 'renamed', detail: 'with 3 subtasks' }),
    ])
    const details = async (p: Doc<'profiles'>) =>
      (await thread(p, issueVis.id)).events.map((e) => [e.id, e.detail])
    expect(await details(f.admin)).toEqual([
      [ids[0], 'with 1 subtask'],
      [ids[1], 'with 2 subtasks'],
      [ids[2], 'with 3 subtasks'],
    ])
    expect(await details(f.guest)).toEqual([
      [ids[0], undefined],
      [ids[1], undefined],
      [ids[2], 'with 3 subtasks'],
    ])
  })

  it('gives admins every row and members the rows the rule allows, without legacy counts', async () => {
    const ids = await plantRows([
      ev({ verb: 'created' }),
      ev({ verb: 'moved', detail: 'to the Firmware sub-project (from Secret)' }),
      ev({ verb: 'archived', detail: 'with 3 subtasks' }),
      // filed under the parent, which the sub-only seat sees for navigation only
      ev({ verb: 'changed', project_id: f.meta.id }),
      // filed under a project deleted later, which cleared project_id
      ev({ verb: 'changed', project_id: undefined }),
      // a move whose other end is a project the guest cannot access
      ev({
        verb: 'moved',
        related_project_id: hiddenSub.id,
        detail: 'to the Firmware sub-project',
      }),
    ])
    const admin = (await thread(f.admin, issueVis.id)).events
    expect(admin.map((e) => e.id)).toEqual(ids)
    expect(admin[2].detail).toBe('with 3 subtasks')
    const guest = (await thread(f.guest, issueVis.id)).events
    expect(guest.map((e) => e.id)).toEqual([ids[0], ids[2], ids[3], ids[4]])
    expect(guest[1]).not.toHaveProperty('detail')
    const subOnly = await seatOn(f.sub.id)
    const page = await thread(subOnly, issueVis.id)
    expect(page.events.map((e) => e.id)).toEqual([ids[0], ids[2], ids[4]])
    expect(await rest(subOnly, issueVis.id)).toEqual([ids[0], ids[2], ids[4]])
  })

  it('shows a move row only to seats that can access both ends', async () => {
    const taskId = uuid()
    const writer = as(t, f.user)
    await writer.mutation(api.issues.create, {
      org_id: f.org.id,
      id: taskId,
      project_id: f.sub2.id,
      title: 'Travelling task',
    })
    await writer.mutation(api.issues.move, { org_id: f.org.id, id: taskId, project_id: f.sub.id })
    const verbs = async (p: Doc<'profiles'>) => (await thread(p, taskId)).events.map((e) => e.verb)
    expect(await verbs(f.guest)).toEqual(['created', 'moved'])
    expect(await verbs(await seatOn(f.sub.id, f.sub2.id))).toEqual(['created', 'moved'])
    // the destination alone: the move names Board rev, and created was filed there
    expect(await verbs(await seatOn(f.sub.id))).toEqual([])
    // revoking the source drops the move row on the next read
    const both = await seatOn(f.sub.id, f.sub2.id)
    expect(await verbs(both)).toEqual(['created', 'moved'])
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub2.id).eq('profile_id', both.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    expect(await verbs(both)).toEqual([])
    // the task's own project: the thread answers as for an unknown task
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub.id).eq('profile_id', both.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    const refusal = await expectRefusal(thread(both, taskId), 'not_found')
    expect((refusal.data as { message: string }).message).toBe('task not found')
  })

  it('holds only rows about this task in this organization', async () => {
    const ids = await plantRows([
      ev({ verb: 'created' }),
      // the same target id in another organization, and a non-task row with it
      ev({ org_id: f.otherOrg.id, project_id: f.otherProject.id }),
      ev({ target_type: 'project', project_id: f.sub.id }),
      ev({ target_type: 'user', project_id: undefined }),
    ])
    for (const p of [f.admin, f.guest]) expect(await events(p, issueVis.id)).toEqual([ids[0]])
  })

  it("pages a task's whole history whatever other tasks and organizations write", async () => {
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // the admin's seat in the other organization
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.admin.auth_user_id,
      email: f.admin.email,
      org_role: 'admin',
    })
    const base = Date.parse(NOW)
    const entry = (target: string, org_id: string, i: number) => ({
      org_id,
      actor_id: f.admin.id,
      verb: 'changed',
      target_type: 'issue' as const,
      target_id: target,
      label: 'x',
      ts: new Date(base + i * 1000).toISOString(),
      project_id: org_id === f.org.id ? f.sub.id : f.otherProject.id,
      named_task_nums: [],
    })
    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i++) await insertActivity(ctx, entry(issueVis.id, f.org.id, i))
      // newer rows about another task and in the other organization
      for (let i = 0; i < 300; i++) {
        await insertActivity(ctx, entry(other.id, f.org.id, 1_000 + i))
        await insertActivity(ctx, entry(uuid(), f.otherOrg.id, 1_000 + i))
      }
    })
    const times = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => new Date(base + (from + i) * 1000).toISOString())
    // the window opens at the newest WINDOW_HISTORY_PAGE rows
    const page = await thread(f.admin, issueVis.id)
    expect(page.events.map((e) => e.ts)).toEqual(times(550, 50))
    expect(page.earlier).toBe(true)
    expect(page.next).toBe(page.events[0].id)
    // "Show earlier activity" reads the rest 50 at a time, each row once
    let read = page.events
    for (let next = page.next; next !== null; ) {
      const earlier = await as(t, f.admin).query(api.snapshot.historyBefore, {
        org_id: f.org.id,
        issue_id: issueVis.id,
        before: next,
      })
      expect(earlier.events.length).toBe(WINDOW_HISTORY_PAGE)
      expect(earlier.events.every((e) => !('field_prints' in e))).toBe(true)
      read = [...earlier.events, ...read]
      next = earlier.next
      expect(next !== null).toBe(earlier.earlier)
    }
    expect(read.map((e) => e.ts)).toEqual(times(0, 600))
    // REST and MCP keep pages of HISTORY_PAGE_MAX
    const restPage = await t.query(internal.machine.records.restTaskActivity, {
      callerId: f.admin.id,
      access: 'read',
      ref: issueVis.id,
    })
    expect(restPage.map((row) => row.created_at)).toEqual(times(100, HISTORY_PAGE_MAX))
    expect(await mcp(f.admin, issueVis.id)).toEqual(restPage.map((row) => row.id))
    const before = restPage[0].id
    const restBefore = await t.query(internal.machine.records.restTaskActivity, {
      callerId: f.admin.id,
      access: 'read',
      ref: issueVis.id,
      before,
    })
    expect(restBefore.map((row) => row.created_at)).toEqual(times(0, 100))
    const mcpBefore = JSON.parse(
      await t.query(internal.machine.records.mcpTaskActivity, {
        callerId: f.admin.id,
        access: 'read',
        ref: issueVis.id,
        before: before.toUpperCase(),
      }),
    ) as { id: string }[]
    expect(mcpBefore.map((row) => row.id)).toEqual(restBefore.map((row) => row.id))
    // a row of another task is no place in this history
    const elsewhere = await t.run((ctx) =>
      ctx.db
        .query('activity_events')
        .withIndex('by_target', (q) =>
          q.eq('org_id', f.org.id).eq('target_type', 'issue').eq('target_id', other.id),
        )
        .first(),
    )
    await expectRefusal(
      as(t, f.admin).query(api.snapshot.historyBefore, {
        org_id: f.org.id,
        issue_id: issueVis.id,
        before: elsewhere!.id,
      }),
      'bad_request',
      /^before must be the id of a row in this task's history$/,
    )
  })
})

/* The task window's history pages: the live page a window subscribes to
 * under All (threadHistory) and the earlier ones it reads once
 * (historyBefore), each WINDOW_HISTORY_PAGE rows. REST and MCP keep
 * HISTORY_PAGE_MAX. */
describe('the task window history pages', () => {
  /* `n` rows about `task`, one second apart, oldest first, as their ids. */
  const plantHistory = (task: Doc<'issues'>, n: number) =>
    t.run(async (ctx) => {
      const base = Date.parse(NOW)
      const ids: string[] = []
      for (let i = 0; i < n; i++) {
        const id = uuid()
        await ctx.db.insert('activity_events', {
          id,
          org_id: f.org.id,
          ts: new Date(base + i * 1000).toISOString(),
          actor_id: f.admin.id,
          verb: 'changed',
          target_type: 'issue',
          target_id: task.id,
          label: 'x',
          project_id: task.project_id,
          named_task_nums: [],
        })
        ids.push(id)
      }
      return ids
    })
  const live = (p: Doc<'profiles'>, task: Doc<'issues'>) =>
    as(t, p).query(api.snapshot.threadHistory, { org_id: f.org.id, issue_id: task.id })
  const earlierPage = (p: Doc<'profiles'>, task: Doc<'issues'>, row: string) =>
    as(t, p).query(api.snapshot.historyBefore, {
      org_id: f.org.id,
      issue_id: task.id,
      before: row,
    })

  it('holds the newest 50 rows, and historyBefore pages back 50 at a time', async () => {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const ids = await plantHistory(task, 120)
    const newest = await live(f.admin, task)
    expect(newest.events.map((e) => e.id)).toEqual(ids.slice(70))
    expect(newest.earlier).toBe(true)
    expect(newest.next).toBe(ids[70])
    const middle = await earlierPage(f.admin, task, ids[70])
    expect(middle.events.map((e) => e.id)).toEqual(ids.slice(20, 70))
    expect(middle.earlier).toBe(true)
    const first = await earlierPage(f.admin, task, ids[20])
    expect(first.events.map((e) => e.id)).toEqual(ids.slice(0, 20))
    expect(first).toMatchObject({ earlier: false, next: null })
  })

  it('says there is more only past 50 rows', async () => {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const ids = await plantHistory(task, 50)
    expect(await live(f.guest, task)).toMatchObject({ earlier: false, next: null })
    expect((await live(f.guest, task)).events.map((e) => e.id)).toEqual(ids)
    const [newer] = await plantHistory(task, 1)
    const page = await live(f.guest, task)
    expect(page.events.map((e) => e.id)).toEqual([...ids.slice(1), newer])
    expect(page).toMatchObject({ earlier: true, next: ids[1] })
    expect((await earlierPage(f.guest, task, ids[1])).events.map((e) => e.id)).toEqual([ids[0]])
  })

  it("pages a member past the rows it does not receive, and an admin's pages hold every row", async () => {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // every third row is a move from a project the guest cannot access
    const ids = await t.run(async (ctx) => {
      const base = Date.parse(NOW)
      const out: { id: string; hidden: boolean }[] = []
      for (let i = 0; i < 130; i++) {
        const id = uuid()
        const hidden = i % 3 === 0
        await ctx.db.insert('activity_events', {
          id,
          org_id: f.org.id,
          ts: new Date(base + i * 1000).toISOString(),
          actor_id: f.admin.id,
          verb: hidden ? 'moved' : 'changed',
          target_type: 'issue',
          target_id: task.id,
          label: 'x',
          project_id: f.sub.id,
          ...(hidden
            ? { related_project_id: hiddenSub.id, detail: 'to the Firmware sub-project' }
            : {}),
          named_task_nums: [],
        })
        out.push({ id, hidden })
      }
      return out
    })
    const received = ids.filter((row) => !row.hidden).map((row) => row.id)
    /* Every row `p` reads from the live page back to the start, and the
     * size of each page. */
    const walk = async (p: Doc<'profiles'>) => {
      const page = await live(p, task)
      let rows = page.events.map((e) => e.id)
      const sizes = [rows.length]
      for (let next = page.next; next !== null; ) {
        const older = await earlierPage(p, task, next)
        rows = [...older.events.map((e) => e.id), ...rows]
        sizes.unshift(older.events.length)
        next = older.next
      }
      return { rows, sizes }
    }
    const guest = await walk(f.guest)
    expect(guest.rows).toEqual(received)
    expect(guest.sizes).toEqual([received.length - 50, 50])
    const admin = await walk(f.admin)
    expect(admin.rows).toEqual(ids.map((row) => row.id))
    expect(admin.sizes).toEqual([30, 50, 50])
    expect((await live(f.admin, task)).events.some((e) => e.verb === 'moved')).toBe(true)
  })

  it('refuses an unknown, foreign or hidden task alike, and a before from another task', async () => {
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [row] = await plantHistory(task, 1)
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    for (const other of [hidden, foreign]) {
      for (const query of [api.snapshot.threadHistory, api.snapshot.threadComments])
        await expectRefusal(
          as(t, f.guest).query(query, { org_id: f.org.id, issue_id: other.id }),
          'not_found',
          /^task not found$/,
        )
    }
    await expectRefusal(
      as(t, f.guest).query(api.snapshot.threadHistory, { org_id: f.org.id, issue_id: uuid() }),
      'not_found',
      /^task not found$/,
    )
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await expectRefusal(earlierPage(f.guest, other, row), 'bad_request', /^before must be the id/)
  })
})

describe('the task window history near the read limits', () => {
  it("stops looking up named tasks before Convex's limits and leaves their rows out", async () => {
    const big = newT({ transactionLimits: true })
    const g = await withOrg(big)
    const task = await plantIssue(big, { org_id: g.org.id, project_id: g.sub.id })
    // 40 tasks of about 500 KB each, more than one read may hold, 20 to a write
    const named: Doc<'issues'>[] = []
    for (let from = 0; from < 40; from += 20)
      named.push(
        ...(await big.run(async (ctx) => {
          const out: Doc<'issues'>[] = []
          for (let i = from; i < from + 20; i++) {
            const _id = await ctx.db.insert('issues', {
              id: uuid(),
              org_id: g.org.id,
              project_id: g.sub2.id,
              num: 5_000 + i,
              title: `Long ${i}`,
              description: 'd'.repeat(500_000),
              status: 'todo',
              priority: 'medium',
              paused: false,
              created_at: NOW,
              updated_at: NOW,
            })
            out.push((await ctx.db.get(_id)) as Doc<'issues'>)
          }
          return out
        })),
      )
    // the task's rows: a link to each long task, and after every tenth a row
    // that names none
    const rows = await big.run(async (ctx) => {
      const base = Date.parse(NOW)
      const out: { id: string; names: boolean }[] = []
      let n = 0
      const add = async (names?: Doc<'issues'>) => {
        const id = uuid()
        n++
        await ctx.db.insert('activity_events', {
          id,
          org_id: g.org.id,
          ts: new Date(base + n * 1000).toISOString(),
          actor_id: g.user.id,
          verb: names === undefined ? 'changed' : 'linked',
          target_type: 'issue',
          target_id: task.id,
          label: task.title,
          detail: names === undefined ? undefined : `(blocks QN-${names.num})`,
          project_id: g.sub.id,
          named_task_nums: names === undefined ? [] : [names.num],
        })
        out.push({ id, names: names !== undefined })
      }
      for (const [i, other] of named.entries()) {
        await add(other)
        if (i % 10 === 9) await add()
      }
      return out
    })
    const all = rows.map((row) => row.id)
    /* `got` is the newest rows, links among them, up to the link the read
     * had no room to check, since a page reads newest first and ends there. */
    const fits = (got: string[]) => {
      expect(got).toEqual(all.slice(all.length - got.length))
      expect(got.some((id) => rows.find((row) => row.id === id)?.names)).toBe(true)
      expect(got.length).toBeLessThan(all.length)
    }
    const overRest = await big.query(internal.machine.records.restTaskActivity, {
      callerId: g.guest.id,
      access: 'read',
      ref: task.id,
    })
    fits(overRest.map((row) => row.id))
    // so does the window's own history page, and its earlier pages, each
    // with room of its own, reach every row once
    const live = await as(big, g.guest).query(api.snapshot.threadHistory, {
      org_id: g.org.id,
      issue_id: task.id,
    })
    fits(live.events.map((e) => e.id))
    expect(live.earlier).toBe(true)
    let shown = live.events.map((e) => e.id)
    let next = live.next
    for (let pages = 0; next !== null && pages < 40; pages++) {
      const older = await as(big, g.guest).query(api.snapshot.historyBefore, {
        org_id: g.org.id,
        issue_id: task.id,
        before: next,
      })
      expect(older.events.length).toBeGreaterThan(0)
      shown = [...older.events.map((e) => e.id), ...shown]
      next = older.next
    }
    expect(shown).toEqual(all)
    const overMcp = JSON.parse(
      await big.query(internal.machine.records.mcpTaskActivity, {
        callerId: g.guest.id,
        access: 'read',
        ref: task.id,
      }),
    ) as { id: string }[]
    expect(overMcp.map((row) => row.id)).toEqual(overRest.map((row) => row.id))
    // paging back with before reaches every row, each page with room of its own
    let read = overRest.map((row) => row.id)
    for (let pages = 0; read.length < all.length && pages < 40; pages++) {
      const older = await big.query(internal.machine.records.restTaskActivity, {
        callerId: g.guest.id,
        access: 'read',
        ref: task.id,
        before: read[0],
      })
      expect(older.length).toBeGreaterThan(0)
      read = [...older.map((row) => row.id), ...read]
    }
    expect(read).toEqual(all)
    // admins look up no named task, so they receive every row
    const admin = await big.query(internal.machine.records.restTaskActivity, {
      callerId: g.admin.id,
      access: 'read',
      ref: task.id,
    })
    expect(admin.map((row) => row.id)).toEqual(rows.map((row) => row.id))
  }, 120_000)
})

describe('the status stamp in the snapshot', () => {
  const update = (id: string, patch: Record<string, unknown>) =>
    as(t, f.user).mutation(api.issues.update, { org_id: f.org.id, id, patch })
  const rowOf = async (p: Doc<'profiles'>, id: string) =>
    (await snapFor(p)).issues.find((i) => i.id === id)

  it('reaches every seat shown the task, and a title edit leaves it', async () => {
    const changed = await update(issueVis.id, { status: 'todo' })
    expect(changed.status_at).toBe(changed.updated_at)
    for (const p of [f.admin, f.guest]) {
      expect((await rowOf(p, issueVis.id))?.status_at).toBe(changed.updated_at)
    }
    await update(issueVis.id, { title: 'Renamed' })
    expect((await rowOf(f.guest, issueVis.id))?.status_at).toBe(changed.updated_at)
  })

  it('never carries a change made where the reader could not see the task', async () => {
    const id = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: hiddenSub.id,
      title: 'Planned in private',
    })
    await update(id, { status: 'progress' })
    const stored = await t.run((ctx) => byId(ctx, 'issues', id))
    expect(stored?.status_at).toBeDefined()
    await as(t, f.user).mutation(api.issues.move, { org_id: f.org.id, id, project_id: f.sub.id })
    const shown = await rowOf(f.guest, id)
    expect(shown).toBeDefined()
    expect(shown).not.toHaveProperty('status_at')
    // the next status change, made where the guest sees it, does
    const next = await update(id, { status: 'review' })
    expect((await rowOf(f.guest, id))?.status_at).toBe(next.updated_at)
  })
})

describe('the task window history', () => {
  it('holds the task’s own rows and no other subject’s or organization’s', async () => {
    const created = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id: created,
      project_id: f.sub.id,
      title: 'With history',
    })
    await t.run(async (ctx) => {
      const row = {
        ts: NOW,
        actor_id: f.admin.id,
        verb: 'created',
        label: 'x',
      }
      await ctx.db.insert('activity_events', {
        ...row,
        id: uuid(),
        org_id: f.org.id,
        target_type: 'project',
        target_id: f.sub.id,
        project_id: f.sub.id,
      })
      // another organization's row about a task with the same id
      await ctx.db.insert('activity_events', {
        ...row,
        id: uuid(),
        org_id: f.otherOrg.id,
        target_type: 'issue',
        target_id: created,
        project_id: f.otherProject.id,
      })
    })
    for (const p of [f.admin, f.user, f.guest, f.viewer]) {
      const history = await as(t, p).query(api.snapshot.threadHistory, {
        org_id: f.org.id,
        issue_id: created,
      })
      expect(history.events.map((e) => e.verb)).toEqual(['created'])
    }
  })
})
