/* Assignment requires effective Edit access in the destination project.
 * Browser writes and the machine resolvers must agree after grants change. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import {
  activityFor,
  allMessages,
  as,
  countersFor,
  expectRefusal,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  uuid,
  withOrg,
} from './helpers.setup'

const ASSIGNEE_SENTENCE =
  /^a task can only be assigned to an active user with Edit permission or higher on its project$/
const EDIT_REQUIRED = /needs Edit permission or higher on this project to be assigned work$/
const REVIEW_EDIT_REQUIRED = /needs Edit permission or higher on this project to review work$/

describe('assignee project permission', () => {
  it.each(['user', 'guest'] as const)(
    'refuses new assignments to an organization %s with only a direct View grant',
    async (org_role) => {
      const t = newT()
      const f = await withOrg(t)
      const recipient = await plantSeat(t, { org_id: f.org.id, org_role })
      await t.run(async (ctx) => {
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: recipient.id,
          level: 'viewer',
        })
      })
      await expectRefusal(
        as(t, f.admin).mutation(api.issues.create, {
          org_id: f.org.id,
          id: uuid(),
          project_id: f.sub.id,
          title: 'Cannot assign read-only work',
          assignee_id: recipient.id,
        }),
        'rule',
        ASSIGNEE_SENTENCE,
      )
      expect((await countersFor(t, f.org.id)).next_issue_num).toBe(1)
      expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual([])

      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await expectRefusal(
        as(t, f.admin).mutation(api.issues.update, {
          org_id: f.org.id,
          id: task.id,
          patch: { title: 'Must not land', assignee_id: recipient.id },
        }),
        'rule',
        ASSIGNEE_SENTENCE,
      )
      expect(await t.run((ctx) => ctx.db.get(task._id))).toEqual(task)
      expect(await activityFor(t, f.org.id)).toEqual([])
      expect(await allMessages(t)).toEqual([])
    },
  )

  it('uses the highest team or individual grant inherited by a sub-project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const recipient = await plantSeat(t, { org_id: f.org.id })
    const teamGrantId = await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: recipient.id,
        org_id: recipient.org_id,
        is_leader: false,
      })
      return await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        org_id: f.meta.org_id,
        team_id: f.team.id,
        level: 'viewer',
      })
    })
    const create = () =>
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Team recipient',
        assignee_id: recipient.id,
      })
    await expectRefusal(create(), 'rule', ASSIGNEE_SENTENCE)

    const directGrantId = await t.run(async (ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: recipient.id,
        level: 'user',
      }),
    )
    expect((await create()).assignee_id).toBe(recipient.id)

    await t.run(async (ctx) => {
      await ctx.db.patch(directGrantId, { level: 'viewer' })
      await ctx.db.patch(teamGrantId, { level: 'user' })
    })
    expect((await create()).assignee_id).toBe(recipient.id)

    await t.run(async (ctx) => {
      await ctx.db.patch(recipient._id, { org_role: 'viewer' })
    })
    await expectRefusal(create(), 'rule', ASSIGNEE_SENTENCE)
  })

  it('preserves assignment eligibility from admin, project lead and explicit grants', async () => {
    const t = newT()
    const f = await withOrg(t)
    const projectLead = await plantSeat(t, { org_id: f.org.id, org_role: 'user' })
    await t.run(async (ctx) => {
      await ctx.db.patch(f.meta._id, { lead_id: projectLead.id })
      for (const profile of [f.admin, projectLead]) {
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: profile.id,
          level: 'viewer',
        })
      }
    })
    for (const recipient of [f.admin, projectLead, f.guest]) {
      const task = await as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Writable recipient',
        assignee_id: recipient.id,
      })
      expect(task.assignee_id).toBe(recipient.id)
    }
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Team leadership is not project access',
        assignee_id: f.user.id,
      }),
      'rule',
      ASSIGNEE_SENTENCE,
    )
  })

  it('refuses a move when its assignee has View access only at the destination', async () => {
    const t = newT()
    const f = await withOrg(t)
    const destination = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: f.guest.id,
        level: 'viewer',
      })
    })
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.guest.id,
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.move, {
        org_id: f.org.id,
        id: task.id,
        project_id: destination.id,
      }),
      'rule',
      ASSIGNEE_SENTENCE,
    )
    expect(await t.run((ctx) => ctx.db.get(task._id))).toEqual(task)
    expect(await activityFor(t, f.org.id)).toEqual([])
    expect(await allMessages(t)).toEqual([])
  })

  it('keeps existing assignments after a downgrade while refusing reassignment after clearing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Existing work',
      assignee_id: f.guest.id,
    })
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant === null) throw new Error('fixture guest grant missing')
      await ctx.db.patch(grant._id, { level: 'viewer' })
    })
    const updated = await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: task.id,
      patch: { title: 'Existing work edited', assignee_id: f.guest.id },
    })
    expect(updated.assignee_id).toBe(f.guest.id)
    const cleared = await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: task.id,
      patch: { assignee_id: null },
    })
    expect(cleared.assignee_id).toBeUndefined()
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: task.id,
        patch: { assignee_id: f.guest.id },
      }),
      'rule',
      ASSIGNEE_SENTENCE,
    )
  })

  it.each(['REST', 'MCP'] as const)(
    '%s keeps View-only profiles available as reporters but refuses them as assignee or reviewer and marks them unassignable',
    async (surface) => {
      const t = newT()
      const f = await withOrg(t)
      const recipient = await plantSeat(t, { org_id: f.org.id })
      await t.run(async (ctx) => {
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: f.agent.id,
          level: 'user',
        })
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: recipient.id,
          level: 'viewer',
        })
      })
      const rows: { id: string; assignable: boolean }[] =
        surface === 'REST'
          ? await t.query(internal.machine.rest.listProjectUsers, {
              callerId: f.agent.id,
              access: 'read',
              ref: f.sub.id,
            })
          : JSON.parse(
              await t.query(internal.machine.mcp.listProjectUsers, {
                callerId: f.agent.id,
                access: 'read',
                project: f.sub.id,
              }),
            )
      expect(rows.find((row) => row.id === recipient.id)?.assignable).toBe(false)
      expect(rows.find((row) => row.id === f.viewer.id)?.assignable).toBe(false)
      expect(rows.find((row) => row.id === f.guest.id)?.assignable).toBe(true)
      expect(rows.find((row) => row.id === f.agent.id)?.assignable).toBe(true)
      const createArgs = {
        project: f.sub.id,
        title: 'Machine assignment',
        assignee_id: recipient.id,
      }
      await expectRefusal(
        surface === 'REST'
          ? t.mutation(internal.machine.rest.createIssue, {
              callerId: f.agent.id,
              access: 'write',
              keyName: 'assignee test',
              body: JSON.stringify(createArgs),
            })
          : t.mutation(internal.machine.mcp.createIssue, {
              callerId: f.agent.id,
              access: 'write',
              ...createArgs,
            }),
        'bad_request',
        EDIT_REQUIRED,
      )
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await expectRefusal(
        surface === 'REST'
          ? t.mutation(internal.machine.rest.updateIssue, {
              callerId: f.agent.id,
              access: 'write',
              keyName: 'assignee test',
              ref: task.id,
              body: JSON.stringify({ assignee_id: recipient.id }),
            })
          : t.mutation(internal.machine.mcp.updateIssue, {
              callerId: f.agent.id,
              access: 'write',
              ref: task.id,
              assignee_id: recipient.id,
            }),
        'bad_request',
        EDIT_REQUIRED,
      )
      expect(await t.run((ctx) => ctx.db.get(task._id))).toEqual(task)

      const reporterArgs = {
        project: f.sub.id,
        title: 'View-only reporter',
        reporter_id: recipient.id,
      }
      const reported: { id: string } =
        surface === 'REST'
          ? await t.mutation(internal.machine.rest.createIssue, {
              callerId: f.agent.id,
              access: 'write',
              keyName: 'assignee test',
              body: JSON.stringify(reporterArgs),
            })
          : JSON.parse(
              await t.mutation(internal.machine.mcp.createIssue, {
                callerId: f.agent.id,
                access: 'write',
                ...reporterArgs,
              }),
            )
      const stored = await t.run((ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', reported.id))
          .unique(),
      )
      expect(stored?.reporter_id).toBe(recipient.id)

      // the reviewer follows the same rule, with its own last sentence
      const reviewArgs = { project: f.sub.id, title: 'Machine review', reviewer_id: recipient.id }
      await expectRefusal(
        surface === 'REST'
          ? t.mutation(internal.machine.rest.createIssue, {
              callerId: f.agent.id,
              access: 'write',
              keyName: 'assignee test',
              body: JSON.stringify(reviewArgs),
            })
          : t.mutation(internal.machine.mcp.createIssue, {
              callerId: f.agent.id,
              access: 'write',
              ...reviewArgs,
            }),
        'bad_request',
        REVIEW_EDIT_REQUIRED,
      )
      const setReviewer = (reviewer_id: string) =>
        surface === 'REST'
          ? t.mutation(internal.machine.rest.updateIssue, {
              callerId: f.agent.id,
              access: 'write',
              keyName: 'assignee test',
              ref: task.id,
              body: JSON.stringify({ reviewer_id }),
            })
          : t.mutation(internal.machine.mcp.updateIssue, {
              callerId: f.agent.id,
              access: 'write',
              ref: task.id,
              reviewer_id,
            })
      await expectRefusal(setReviewer(recipient.id), 'bad_request', REVIEW_EDIT_REQUIRED)
      expect(await t.run((ctx) => ctx.db.get(task._id))).toEqual(task)
      // `assignable` governs the reviewer too: every listed row is accepted
      // exactly when it is flagged assignable
      for (const row of rows) {
        if (row.assignable) {
          await setReviewer(row.id)
          expect((await t.run((ctx) => ctx.db.get(task._id)))?.reviewer_id).toBe(row.id)
        } else {
          await expectRefusal(setReviewer(row.id), 'bad_request')
        }
      }
    },
  )

  /* Problem 10: the app never checks an unchanged assignee or reviewer again
   * (updateIssueCore), so REST and MCP accept the current one resent too,
   * even after that person was switched off or lost Edit. A change to such
   * a person is still refused with the readable sentence. */
  it.each(['REST', 'MCP'] as const)(
    '%s accepts the current assignee and reviewer resent after they lose eligibility',
    async (surface) => {
      const t = newT()
      const f = await withOrg(t)
      const assignee = await plantSeat(t, { org_id: f.org.id, name: 'Assignee' })
      const reviewer = await plantSeat(t, { org_id: f.org.id, name: 'Reviewer' })
      const other = await plantSeat(t, { org_id: f.org.id, name: 'Other' })
      await t.run(async (ctx) => {
        for (const id of [f.agent.id, assignee.id, reviewer.id, other.id]) {
          await ctx.db.insert('project_access', {
            project_id: f.meta.id,
            profile_id: id,
            level: 'user',
          })
        }
      })
      const task = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        assignee_id: assignee.id,
        reviewer_id: reviewer.id,
      })
      // the assignee is switched off, the reviewer keeps only View
      await t.run(async (ctx) => {
        await ctx.db.patch(assignee._id, { active: false })
        await ctx.db.patch(other._id, { active: false })
        const grant = await ctx.db
          .query('project_access')
          .withIndex('by_project_profile', (q) =>
            q.eq('project_id', f.meta.id).eq('profile_id', reviewer.id),
          )
          .unique()
        if (grant === null) throw new Error('fixture reviewer grant missing')
        await ctx.db.patch(grant._id, { level: 'viewer' })
      })
      const update = (fields: { title?: string; assignee_id?: string; reviewer_id?: string }) =>
        surface === 'REST'
          ? t.mutation(internal.machine.rest.updateIssue, {
              callerId: f.agent.id,
              access: 'write',
              keyName: 'assignee test',
              ref: task.id,
              body: JSON.stringify(fields),
            })
          : t.mutation(internal.machine.mcp.updateIssue, {
              callerId: f.agent.id,
              access: 'write',
              ref: task.id,
              ...fields,
            })
      // a uuid in capitals is the same person, as on every other field
      await update({
        title: 'Resent people',
        assignee_id: assignee.id.toUpperCase(),
        reviewer_id: reviewer.id,
      })
      expect(await t.run((ctx) => ctx.db.get(task._id))).toMatchObject({
        title: 'Resent people',
        assignee_id: assignee.id,
        reviewer_id: reviewer.id,
      })
      await expectRefusal(
        update({ assignee_id: other.id }),
        'bad_request',
        new RegExp(`^user "${other.id}" is switched off and can hold no new work$`),
      )
      await expectRefusal(update({ reviewer_id: assignee.id }), 'bad_request', /is switched off/)
      expect(await t.run((ctx) => ctx.db.get(task._id))).toMatchObject({
        assignee_id: assignee.id,
        reviewer_id: reviewer.id,
      })
    },
  )
})
