/* planning.assigneeLoad — plan_assignee_load's port (0106). The load is the
 * person's owned work (lib/review.ts: the reviewer while In Review with one
 * set, else the assignee). The org is that person's own, resolved
 * server-side; the disclosure fence and projection are shared with org_load,
 * but there is NO remaining>0 filter here, and the projection adds
 * title/project_id/project_name (nulled when invisible). */
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

let t: T
let f: OrgFixture
let hiddenSub: Doc<'projects'>
let hidden2: Doc<'projects'>
let hidden2Sub: Doc<'projects'>
let issueVis: Doc<'issues'> // in f.sub, assignee user — visible to everyone with the meta
let ownHidden: Doc<'issues'> // in hidden2Sub (lead: admin), assignee user — user can NOT see it

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
  ownHidden = await plantIssue(t, {
    org_id: f.org.id,
    project_id: hidden2Sub.id,
    assignee_id: f.user.id,
    start_week: '2026-01-12',
    end_week: '2026-01-19',
    remaining_hours: 3,
    remaining_set_at: NOW,
  })
})

const loadFor = (caller: Doc<'profiles'>, assignee_id: string) =>
  as(t, caller).query(api.planning.assigneeLoad, { assignee_id })

describe('assigneeLoad', () => {
  it('wire shape: the exact SQL column names, identified when the project is visible', async () => {
    const rows = await loadFor(f.admin, f.user.id)
    expect(rows.find((r) => r.issue_id === issueVis.id)).toEqual({
      issue_id: issueVis.id,
      title: issueVis.title,
      project_id: f.sub.id,
      project_name: 'Firmware',
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      remaining: 5,
      remaining_set_at: NOW,
      visible: true,
    })
    // the org admin sees the hidden family too
    expect(rows.find((r) => r.issue_id === ownHidden.id)?.visible).toBe(true)
  })

  it('every identifying field is nulled when the caller cannot see the project — busy time, not identity', async () => {
    // self-load: user is staff but has no standing on hidden2
    const rows = await loadFor(f.user, f.user.id)
    expect(rows.find((r) => r.start_week === '2026-01-12')).toEqual({
      issue_id: null,
      title: null,
      project_id: null,
      project_name: null,
      start_week: '2026-01-12',
      end_week: '2026-01-19',
      remaining: 3,
      remaining_set_at: NOW,
      visible: false,
    })
    // the visible row still arrives identified
    expect(rows.find((r) => r.issue_id === issueVis.id)?.visible).toBe(true)
  })

  it('self-load is always visible: a guest gets their own hidden rows (anonymized) — and unestimated rows are included', async () => {
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: hiddenSub.id,
      assignee_id: f.guest.id,
      start_week: '2026-01-05',
      end_week: '2026-01-12',
      // no remaining_hours: unlike org_load there is no remaining>0 fence
    })
    const rows = await loadFor(f.guest, f.guest.id)
    expect(rows).toEqual([
      {
        issue_id: null,
        title: null,
        project_id: null,
        project_name: null,
        start_week: '2026-01-05',
        end_week: '2026-01-12',
        remaining: null,
        remaining_set_at: null,
        visible: false,
      },
    ])
  })

  it("a guest caller gets visible rows identified and other people's hidden rows excluded entirely", async () => {
    const rows = await loadFor(f.guest, f.user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.issue_id).toBe(issueVis.id)
  })

  it('zero-remaining scheduled rows are included — the org_load filter must not leak across', async () => {
    const zero = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.user.id,
      start_week: '2026-02-02',
      end_week: '2026-02-09',
      remaining_hours: 0,
      remaining_set_at: NOW,
    })
    const rows = await loadFor(f.admin, f.user.id)
    const row = rows.find((r) => r.issue_id === zero.id)
    expect(row?.remaining).toBe(0)
  })

  it('done, paused, unscheduled, archived-issue and archived-project rows are all out', async () => {
    const inSub = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    const scheduled = { start_week: '2026-02-02', end_week: '2026-02-09' }
    await plantIssue(t, { ...inSub, ...scheduled, status: 'done', remaining_hours: 2 })
    await plantIssue(t, { ...inSub, ...scheduled, paused: true, remaining_hours: 2 })
    await plantIssue(t, { ...inSub, remaining_hours: 2 }) // unscheduled
    await plantIssue(t, { ...inSub, ...scheduled, remaining_hours: 2, archived_at: NOW })
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
      assignee_id: f.user.id,
      ...scheduled,
      remaining_hours: 2,
    })

    const rows = await loadFor(f.admin, f.user.id)
    expect(rows.map((r) => r.issue_id).sort()).toEqual([issueVis.id, ownHidden.id].sort())
  })

  it("a Review task with a reviewer is the reviewer's load until it leaves Review; without one it stays with the assignee", async () => {
    const work = {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.user.id,
      status: 'review',
      start_week: '2026-03-02',
      end_week: '2026-03-09',
      remaining_hours: 2,
    } as const
    const reviewed = await plantIssue(t, { ...work, reviewer_id: f.admin.id })
    const unreviewed = await plantIssue(t, work)
    const ids = async (owner: Doc<'profiles'>) =>
      (await loadFor(f.admin, owner.id)).map((r) => r.issue_id)

    expect(await ids(f.admin)).toContain(reviewed.id)
    expect(await ids(f.user)).not.toContain(reviewed.id)
    expect(await ids(f.user)).toContain(unreviewed.id)
    expect(await ids(f.admin)).not.toContain(unreviewed.id)

    await t.run(async (ctx) => {
      await ctx.db.patch(reviewed._id, { status: 'progress' })
    })
    expect(await ids(f.admin)).not.toContain(reviewed.id)
    expect(await ids(f.user)).toContain(reviewed.id)
  })

  it("unknown assignee and a caller without a seat in the assignee's org get an empty array, not an error", async () => {
    expect(await loadFor(f.admin, uuid())).toEqual([])
    expect(await loadFor(f.otherAdmin, f.user.id)).toEqual([])
  })

  it('an inactive seat is no seat: the whole org contributes nothing', async () => {
    await plantSeat(t, {
      org_id: f.org.id,
      active: false,
      auth_user_id: 'auth_benched',
      email: 'benched@testbed.test',
    })
    const rows = await t
      .withIdentity({ subject: 'auth_benched' })
      .query(api.planning.assigneeLoad, { assignee_id: f.user.id })
    expect(rows).toEqual([])
  })

  it('not signed in is forbidden — the transport error, never an empty result', async () => {
    await expectRefusal(t.query(api.planning.assigneeLoad, { assignee_id: f.user.id }), 'forbidden')
  })
})
