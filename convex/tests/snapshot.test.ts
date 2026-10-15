/* snapshot.forMe + snapshot.commentsForIssue — the phase-3 read-path gate.
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
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import schema from '../schema'
import {
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
  const snap = await as(t, profile).query(api.snapshot.forMe, {})
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

describe('forMe scoping', () => {
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
      await t.withIdentity({ subject: 'auth_nobody' }).query(api.snapshot.forMe, {}),
    ).toBeNull()
    await expectRefusal(t.query(api.snapshot.forMe, {}), 'forbidden')
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
      await ctx.db.insert('activity_events', {
        id: uuid(),
        org_id: f.org.id,
        ts: NOW,
        actor_id: f.admin.id,
        verb: 'updated',
        target_type: 'issue',
        target_id: archivedIssue.id,
        label: 'Archived task update',
        project_id: f.sub.id,
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
    expect(snap.activity.some((row) => row.target_id === archivedIssue.id)).toBe(false)
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
    expect(admin.orgLoad.find((r) => r.owner_id === f.admin.id)?.issue_id).toBe(hid2Issue.id)
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
    expect(snap.orgLoad.filter((r) => r.owner_id === f.user.id).map((r) => r.issue_id)).toEqual([
      issueVis.id,
    ])
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
    expect(snap.orgLoad).toEqual([
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
    expect(snap.orgLoad.filter((r) => r.owner_id === f.user.id).map((r) => r.issue_id)).toEqual([
      issueVis.id,
    ])
    expect(snap.orgLoad.some((r) => r.owner_id === f.agent.id && r.remaining === 6)).toBe(true)
    expect(snap.orgLoad.some((r) => r.owner_id === inactive.id && r.remaining === 8)).toBe(true)
    expect(snap.orgLoad.some((r) => r.remaining === 9)).toBe(false)
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
      snap.orgLoad.filter((r) => r.issue_id === id).map((r) => r.owner_id)
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
  })

  it('answers over a backlog larger than one transaction may read; visible rows past the bound wait', async () => {
    // The old full read of the inbox scanned every row and failed here.
    t = convexTest({
      schema,
      modules: import.meta.glob('../**/*.*s'),
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
    // each walk examines at most 1,000 rows, all hidden here, so the older
    // visible rows are not reached: the accepted cost of the bound
    expect(snap.messages).toEqual([])
    expect(snap.readMessageCount).toBe(0)
    expect(snap.issues.map((i) => i.id)).toContain(visibleTask.id)
  })

  it('lists no read rows while hidden rows leave unread ones unexamined, but still counts them', async () => {
    const hiddenTask = await plantIssue(t, { org_id: f.org.id, project_id: hidden2Sub.id })
    const visible = { unread: msg(f.user.id, NOW), read: msg(f.user.id, NOW, NOW) }
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', visible.unread)
      await ctx.db.insert('messages', visible.read)
      // newer unread rows about a hidden task, more than the unread walk
      // examines (2 * 500)
      for (let i = 0; i < 1100; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW, undefined, hiddenTask.id))
      }
    })
    let snap = await snapFor(f.user)
    // listing the read row would show the task as read while its unread row
    // was never reached; the machine inbox lists no read row then either
    expect(snap.messages).toEqual([])
    expect(snap.readMessageCount).toBe(1)

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

describe('activity', () => {
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

  const seen = async (p: Doc<'profiles'>) => (await snapFor(p)).activity.map((a) => a.id).sort()

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
  const joinTeam = (profileId: string, is_leader: boolean) =>
    t.run((ctx) =>
      ctx.db.insert('team_members', { team_id: f.team.id, profile_id: profileId, is_leader }),
    )

  it('each row reaches only the people who can access its subject', async () => {
    const subOnly = await seatOn(f.sub.id)
    // A guest seat that kept a leader membership from an earlier staff role.
    const guestLeader = await seatOn(f.sub.id, 'guest')
    await joinTeam(guestLeader.id, true)
    const teamMember = await seatOn(f.sub.id)
    await joinTeam(teamMember.id, false)
    const ids = await t.run(async (ctx) => {
      const rows = {
        people: ev({ target_type: 'user', target_id: f.viewer.id, verb: 'renamed' }),
        label: ev({ target_type: 'org', target_id: uuid(), verb: 'created label' }),
        team: ev({ team_id: f.team.id, target_type: 'user', target_id: f.viewer.id }),
        parent: ev({ project_id: f.meta.id, target_type: 'project', target_id: f.meta.id }),
        sub: ev({ project_id: f.sub.id, target_type: 'project', target_id: f.sub.id }),
        hidden: ev({ project_id: f.hidden.id, target_type: 'project', target_id: f.hidden.id }),
        task: ev({ project_id: f.sub.id, target_id: issueVis.id }),
        // names a second project, such as a move's destination
        taskToHidden: ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          related_project_id: f.hidden.id,
        }),
        statusMove: ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          detail: 'from To Do to Done',
        }),
        // a project move written before related_project_id existed
        unrecordedMove: ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          detail: 'to the Secret sub-project (from Firmware)',
        }),
        // The task was deleted; its project remains.
        deletedTask: ev({ project_id: f.sub.id }),
        // Deleting a project clears project_id on its rows (model/cascade.ts):
        // a task that moved out first keeps them, other rows go to admins.
        survivingTask: ev({ target_id: issueVis.id }),
        orphanTask: ev({}),
        orphanMilestone: ev({ target_type: 'milestone' }),
        // A deleted top-level project with a legacy owning team.
        orphanProject: ev({ team_id: f.team.id, target_type: 'project', verb: 'deleted' }),
        // A deleted team keeps its id on its rows (model/cascade.ts).
        deadTeam: ev({ team_id: uuid(), target_type: 'user', verb: 'added', detail: 'to Gone' }),
        // Team rows whose id an earlier team deletion cleared.
        legacyAdded: ev({ target_type: 'user', verb: 'added', detail: 'to Hardware' }),
        legacyRemoved: ev({ target_type: 'user', verb: 'removed', detail: 'from Hardware' }),
        legacyMade: ev({ target_type: 'user', verb: 'made', detail: 'a leader of Hardware' }),
        legacyDemoted: ev({
          target_type: 'user',
          verb: 'demoted',
          detail: 'from leader of Hardware',
        }),
        // Roster rows share those verbs and may be a deleted team named "the
        // organization", so they reach admins only too.
        rosterAdded: ev({ target_type: 'user', verb: 'added', detail: 'to the organization' }),
        rosterAgent: ev({
          target_type: 'user',
          verb: 'added',
          detail: 'to the organization as an agent',
        }),
        rosterRemoved: ev({
          target_type: 'user',
          verb: 'removed',
          detail: 'from the organization',
        }),
        renamed: ev({ target_type: 'user', verb: 'renamed', detail: 'from “Old name”' }),
      }
      for (const row of Object.values(rows)) await ctx.db.insert('activity_events', row)
      return Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.id]))
    })
    const only = (...keys: string[]) => keys.map((key) => ids[key]).sort()
    const shared = ['people', 'label', 'sub', 'task', 'statusMove', 'survivingTask', 'renamed']

    expect(await seen(f.admin)).toEqual(Object.values(ids).sort())
    // user: leads f.meta, f.hidden and the team
    expect(await seen(f.user)).toEqual(only(...shared, 'team', 'parent', 'hidden', 'taskToHidden'))
    // guest and viewer: granted on f.meta, so its sub-projects too
    for (const p of [f.guest, f.viewer]) expect(await seen(p)).toEqual(only(...shared, 'parent'))
    // Navigation-only access to f.meta reveals none of its own history. Team
    // history needs a leader on the organization staff.
    for (const p of [subOnly, guestLeader, teamMember])
      expect(await seen(p)).toEqual(only(...shared))
  })

  it("a deleted team's membership history reaches only organization admins", async () => {
    const subOnly = await seatOn(f.sub.id)
    const teamMember = await seatOn(f.sub.id)
    await joinTeam(teamMember.id, false)
    // a second team, so the last-team guard lets f.team go
    await as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id: uuid(), name: 'Other' })
    const leader = as(t, f.user)
    const team = { org_id: f.org.id, team_id: f.team.id }
    await leader.mutation(api.teams.addMember, { ...team, profile_id: f.viewer.id })
    await leader.mutation(api.teams.setLeader, { ...team, profile_id: f.admin.id, is_leader: true })
    await leader.mutation(api.teams.removeMember, { ...team, profile_id: f.viewer.id })
    const teamRows = async (p: Doc<'profiles'>) =>
      (await snapFor(p)).activity
        .filter((a) => a.target_type === 'user')
        .map((a) => `${a.verb} ${a.detail}`)
        .sort()
    const history = ['added to Hardware', 'made a leader of Hardware', 'removed from Hardware']
    for (const p of [f.admin, f.user]) expect(await teamRows(p)).toEqual(history)
    for (const p of [f.viewer, f.guest, subOnly, teamMember]) expect(await teamRows(p)).toEqual([])

    await as(t, f.admin).mutation(api.teams.deleteDeep, { org_id: f.org.id, id: f.team.id })
    expect(await teamRows(f.admin)).toEqual(history)
    for (const p of [f.user, f.viewer, f.guest, subOnly, teamMember]) {
      expect(await teamRows(p)).toEqual([])
    }
  })

  it('sub-project-only members receive no history of the parent, its other sub-projects or deleted projects', async () => {
    const subOnly = await seatOn(f.sub.id)
    const subGuest = await seatOn(f.sub.id, 'guest')
    const writer = as(t, f.user)
    await writer.mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub2.id,
      title: 'Sibling task',
    })
    await writer.mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub2.id })
    await writer.mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.hidden.id })
    await writer.mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    await writer.mutation(api.projects.unarchive, { org_id: f.org.id, id: f.meta.id })

    const rows = async (p: Doc<'profiles'>) =>
      (await snapFor(p)).activity
        .map((a) => `${a.verb} ${a.label}${a.detail ? ` ${a.detail}` : ''}`)
        .sort()
    const parentHistory = [
      'archived Testbed platform with 1 sub-project',
      'deleted Board rev',
      'restored Testbed platform from the archive',
    ]
    for (const p of [subOnly, subGuest]) expect(await rows(p)).toEqual([])
    // f.guest holds a grant on f.meta, so it could see every sub-project
    expect(await rows(f.guest)).toEqual(parentHistory)
    expect(await rows(f.admin)).toEqual(
      [...parentHistory, 'created Sibling task', 'deleted Skunkworks'].sort(),
    )
  })

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
      (await snapFor(p)).activity
        .filter((a) => a.target_id === taskId)
        .map((a) => `${a.verb}${a.detail ? ` ${a.detail}` : ''}`)
        .sort()
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

  it('a task that moved out of a deleted project keeps its earlier history', async () => {
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
      (await snapFor(p)).activity
        .filter((a) => a.target_id === taskId)
        .map((a) => a.verb)
        .sort()
    expect(await taskRows(destinationOnly)).toEqual([])

    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub2.id })
    for (const p of [destinationOnly, f.guest, f.user]) {
      expect(await taskRows(p)).toEqual(['created', 'moved'])
    }
  })

  it('a row that names another task reaches only people who can access that task where it is now', async () => {
    const subOnly = await seatOn(f.sub.id)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const task = (project_id: string) => plantIssue(t, { org_id: f.org.id, project_id })
    const child = await task(f.sub.id)
    const sameParent = await task(f.sub.id)
    const siblingParent = await task(f.sub2.id)
    const hiddenParent = await task(hiddenSub.id)
    const linkSame = await task(f.sub.id)
    const linkSibling = await task(f.sub2.id)
    const writer = as(t, f.user) // leads f.meta and f.hidden
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
      E: `linked — relates to ${key(linkSame)}`,
      F: `linked — relates to ${key(linkSibling)}`,
      G: `moved under ${key(hiddenParent)}`,
      H: `moved under ${key(sameParent)} (from ${key(hiddenParent)})`,
    }
    const seenRows = async (p: Doc<'profiles'>) => {
      const mine = new Set(
        (await snapFor(p)).activity
          .filter((a) => a.target_id === child.id)
          .map((a) => `${a.verb} ${a.detail}`),
      )
      return Object.entries(rowsAbout)
        .filter(([, row]) => mine.has(row))
        .map(([name]) => name)
    }
    const all = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    for (const p of [f.admin, f.user]) expect(await seenRows(p)).toEqual(all)
    expect(await seenRows(f.guest)).toEqual(['A', 'B', 'E', 'F'])
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
    expect(await seenRows(f.guest)).toEqual(['E', 'F'])
    expect(await seenRows(f.admin)).toEqual(all)
  })

  it('task rows with unknown relation wording and agent key rows reach admins only', async () => {
    const ids = await t.run(async (ctx) => {
      const rows = {
        unknownLink: ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          verb: 'linked',
          detail: '— blocks PCB-12',
        }),
        missingTask: ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          verb: 'linked',
          detail: '— blocks QN-999999',
        }),
        // a key inside other text is not a relation
        renamed: ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          verb: 'renamed',
          detail: '“Fix QN-999999”',
        }),
        keyCreated: ev({ target_type: 'user', verb: 'created', detail: 'a new key “CI”' }),
        keyRevoked: ev({ target_type: 'user', verb: 'revoked', detail: 'the key “CI”' }),
      }
      for (const row of Object.values(rows)) await ctx.db.insert('activity_events', row)
      return Object.fromEntries(Object.entries(rows).map(([k, row]) => [k, row.id]))
    })
    expect(await seen(f.admin)).toEqual(Object.values(ids).sort())
    for (const p of [f.user, f.guest]) expect(await seen(p)).toEqual([ids.renamed])
  })

  it('older task archive rows lose their subtask count for members, not admins', async () => {
    await t.run(async (ctx) => {
      for (const row of [
        ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          verb: 'archived',
          detail: 'with 3 subtasks',
        }),
        ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          verb: 'archived',
          detail: 'with 1 subtask',
        }),
        // a project archive keeps its count; a different verb is not touched
        ev({
          project_id: f.meta.id,
          target_type: 'project',
          target_id: f.meta.id,
          verb: 'archived',
          detail: 'with 1 sub-project',
        }),
        ev({
          project_id: f.sub.id,
          target_id: issueVis.id,
          verb: 'moved',
          detail: 'with 3 subtasks',
        }),
      ])
        await ctx.db.insert('activity_events', row)
    })
    const details = async (p: Doc<'profiles'>) =>
      (await snapFor(p)).activity.map((a) => `${a.verb}|${a.detail ?? ''}`).sort()
    expect(await details(f.admin)).toEqual(
      [
        'archived|with 1 sub-project',
        'archived|with 1 subtask',
        'archived|with 3 subtasks',
        'moved|with 3 subtasks',
      ].sort(),
    )
    expect(await details(f.guest)).toEqual(
      ['archived|', 'archived|', 'archived|with 1 sub-project', 'moved|with 3 subtasks'].sort(),
    )
  })

  it('caps at 500 across the blend, ts desc — the oldest rows fall out', async () => {
    const base = Date.parse(NOW)
    await t.run(async (ctx) => {
      for (let i = 0; i < 505; i++) {
        await ctx.db.insert('activity_events', ev({ ts: new Date(base + i * 1000).toISOString() }))
      }
    })
    const snap = await snapFor(f.admin)
    expect(snap.activity).toHaveLength(500)
    expect(snap.activity[0]?.ts).toBe(new Date(base + 504 * 1000).toISOString())
    const kept = new Set(snap.activity.map((a) => a.ts))
    expect(kept.has(new Date(base + 4 * 1000).toISOString())).toBe(false)
    expect(kept.has(new Date(base + 5 * 1000).toISOString())).toBe(true)
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
        stale_days: 14,
        archive_days: 30,
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
    })

    const snap = await snapFor(subOnly)
    expect(snap.projects.map((p) => p.id).sort()).toEqual([f.meta.id, f.sub.id].sort())
    // A new project field reaches navigation-only parents unless it is
    // judged here first.
    const meta = snap.projects.find((p) => p.id === f.meta.id)!
    expect(Object.keys(meta).sort()).toEqual([
      'created_at',
      'description',
      'icon',
      'icon_color',
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
    const archived = await as(t, f.guest).query(api.issues.archivedFor, {
      project_ids: [f.sub.id],
    })
    const row = archived.find((i) => i.id === child.id)
    expect(row && 'parent_id' in row).toBe(false)
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
      ...snap.activity.filter((a) => a.target_type === 'issue').map((a) => a.target_id),
    ]
    expect(referenced.filter((id) => !known.has(id))).toEqual([])
    expect(JSON.stringify(snap)).not.toContain(hiddenTask.id)
  })
})

describe('commentsForIssue', () => {
  it("returns a visible issue's thread, created_at ascending, as pure app rows", async () => {
    const [c1, c2] = await t.run(async (ctx) => {
      const first = {
        id: uuid(),
        issue_id: issueVis.id,
        author: f.user.id,
        body: 'first',
        created_at: '2026-01-01T01:00:00.000Z',
      }
      const second = {
        id: uuid(),
        issue_id: issueVis.id,
        author: f.admin.id,
        body: 'second',
        created_at: '2026-01-01T02:00:00.000Z',
      }
      // inserted out of order on purpose
      await ctx.db.insert('comments', second)
      await ctx.db.insert('comments', first)
      return [first, second]
    })
    const rows = await as(t, f.guest).query(api.snapshot.commentsForIssue, {
      org_id: f.org.id,
      issue_id: issueVis.id,
    })
    expect(rows.map((r) => r.id)).toEqual([c1.id, c2.id])
    expect(rows[0]).toEqual(c1)
  })

  it('hidden, foreign and unknown issues are uniformly not found', async () => {
    const hid = await plantIssue(t, { org_id: f.org.id, project_id: hiddenSub.id })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await expectRefusal(
      as(t, f.guest).query(api.snapshot.commentsForIssue, { org_id: f.org.id, issue_id: hid.id }),
      'not_found',
    )
    await expectRefusal(
      as(t, f.admin).query(api.snapshot.commentsForIssue, {
        org_id: f.org.id,
        issue_id: foreign.id,
      }),
      'not_found',
    )
    await expectRefusal(
      as(t, f.guest).query(api.snapshot.commentsForIssue, { org_id: f.org.id, issue_id: uuid() }),
      'not_found',
    )
  })

  it('requires a seat in the named org', async () => {
    await expectRefusal(
      as(t, f.guest).query(api.snapshot.commentsForIssue, {
        org_id: f.otherOrg.id,
        issue_id: issueVis.id,
      }),
      'forbidden',
    )
  })
})
