/* snapshot.forMe + snapshot.commentsForIssue — the phase-3 read-path gate.
 *
 * Extra scenery beside withOrg's mini-Testbed:
 * - hiddenSub: a sub under f.hidden (lead: user) — invisible to guest/viewer,
 *   visible to admin (org admin) and user (lead)
 * - hidden2 / hidden2Sub: a second hidden family led by ADMIN — the project
 *   plain staff `user` cannot see, which is what the staff-anonymization
 *   assertions need (admin sees everything, so f.hidden can't test it)
 * - issueVis: scheduled+estimated work in f.sub, the identified control row */

import type { WithoutSystemFields } from 'convex/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
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

  it('caps at 500 with unread rows sorted in first — a long absence cannot push unread past the cap', async () => {
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
    expect(snap.readMessageCount).toBe(501)
    // the three old unread rows survive, ahead of every read row
    expect(snap.messages.slice(0, 3).every((m) => m.read_at === undefined)).toBe(true)
    expect(snap.messages.filter((m) => m.read_at === undefined)).toHaveLength(3)
    // unread tiebreak is created_at desc
    expect(snap.messages[0]?.created_at).toBe(new Date(base - day).toISOString())
    // read survivors are the 497 EARLIEST read_at rows (read_at asc after nulls)
    const lastKept = snap.messages[snap.messages.length - 1]
    expect(lastKept?.read_at).toBe(new Date(base + (496 + 600) * 1000).toISOString())
  })

  it('counts read messages across own seats even when 500 unread messages hide every read row', async () => {
    const seat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.user.auth_user_id,
      org_role: 'guest',
      email: 'user@testbed.test',
    })
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW))
      }
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert('messages', msg(f.user.id, NOW, NOW))
      }
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('messages', { ...msg(seat.id, NOW, NOW), org_id: f.otherOrg.id })
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

  it('branch fences: org-wide reaches every member; team rows need admin or leader; project rows follow visibility', async () => {
    const ids = await t.run(async (ctx) => {
      const orgWide = ev({})
      const teamRow = ev({ team_id: f.team.id, target_type: 'team' as const })
      const hiddenRow = ev({ project_id: f.hidden.id, target_type: 'project' as const })
      const visibleRow = ev({ project_id: f.sub.id, target_type: 'project' as const })
      for (const row of [orgWide, teamRow, hiddenRow, visibleRow])
        await ctx.db.insert('activity_events', row)
      return {
        orgWide: orgWide.id,
        teamRow: teamRow.id,
        hiddenRow: hiddenRow.id,
        visibleRow: visibleRow.id,
      }
    })

    const seen = async (p: Doc<'profiles'>) => (await snapFor(p)).activity.map((a) => a.id).sort()
    // admin: all four; user: leads the team AND f.hidden — all four
    expect(await seen(f.admin)).toEqual(Object.values(ids).sort())
    expect(await seen(f.user)).toEqual(Object.values(ids).sort())
    // guest and viewer: org-wide + the visible project row only
    expect(await seen(f.guest)).toEqual([ids.orgWide, ids.visibleRow].sort())
    expect(await seen(f.viewer)).toEqual([ids.orgWide, ids.visibleRow].sort())
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
