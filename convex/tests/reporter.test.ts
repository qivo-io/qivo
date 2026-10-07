/* Reporter attribution is chosen once: browser creation uses its actor,
 * while machine creation may name a real profile with project visibility.
 * Later edits and moves preserve the attribution even if access changes. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { type CreateIssueArgs, createIssueCore, updateIssueCore } from '../model/issues'
import {
  activityFor,
  allMessages,
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  plantIssue,
  plantProject,
  uuid,
  withOrg,
} from './helpers.setup'

const REPORTER_SENTENCE = /^a task's reporter must be a user who can see its project$/
const IMMUTABLE_SENTENCE = /^reporter_id is set when a task is created and cannot be changed$/
const ASSIGNEE_SENTENCE =
  /^a task can only be assigned to an active user with Edit permission or higher on its project$/

describe('reporter attribution', () => {
  it('browser creation sets the authenticated actor as reporter', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Default reporter',
    })

    expect(row.reporter_id).toBe(f.admin.id)
    expect((await activityFor(t, f.org.id))[0].actor_id).toBe(f.admin.id)
  })

  it('machine creation can credit a different visible profile, including an inactive viewer', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.viewer._id, { active: false })
    })
    const row = await t.run(async (ctx) =>
      createIssueCore(ctx, {
        me: f.admin,
        args: {
          id: uuid(),
          project_id: f.sub.id,
          title: 'Reported by viewer',
          reporter_id: f.viewer.id,
        },
        now: NOW,
        machine: { provenance: 'via MCP' },
      }),
    )

    expect(row.created_by).toBe(f.admin.id)
    expect(row.reporter_id).toBe(f.viewer.id)
    expect(await messagesFor(t, f.viewer.id, row.id)).toEqual([])
    const subscriptions = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', row.id))
        .collect(),
    )
    expect(subscriptions.some((s) => s.profile_id === f.viewer.id)).toBe(false)
    const activity = await activityFor(t, f.org.id)
    expect(activity).toHaveLength(1)
    expect(activity[0].actor_id).toBe(f.admin.id)
  })

  it('a visible agent is a valid reporter, including when it is the default actor', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      })
    })
    for (const explicit of [false, true]) {
      const row = await t.run(async (ctx) =>
        createIssueCore(ctx, {
          me: explicit ? f.admin : f.agent,
          args: {
            id: uuid(),
            project_id: f.sub.id,
            title: 'Reported by agent',
            ...(explicit ? { reporter_id: f.agent.id } : {}),
          },
          now: NOW,
          machine: { provenance: 'via the REST API (Relay)' },
        }),
      )
      expect(row.reporter_id).toBe(f.agent.id)
    }
  })

  it('refuses reporter changes and clears atomically, including a repeated current value', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      reporter_id: f.admin.id,
    })
    await as(t, f.admin).mutation(api.issues.subscribe, { org_id: f.org.id, issue_id: issue.id })

    for (const reporter_id of [f.guest.id, null, f.admin.id]) {
      // Extra runtime fields can reach trusted model callers despite the
      // narrower public validator and IssuePatch type. Refuse the whole edit.
      const patch = { title: 'Must not land', assignee_id: f.guest.id, reporter_id }
      await expectRefusal(
        t.run(async (ctx) =>
          updateIssueCore(ctx, {
            me: f.admin,
            issue,
            patch,
            now: '2026-01-02T00:00:00.000Z',
            machine: { provenance: 'via MCP', archive: true },
          }),
        ),
        'bad_request',
        IMMUTABLE_SENTENCE,
      )
      expect(await t.run(async (ctx) => ctx.db.get(issue._id))).toEqual(issue)
      expect(await activityFor(t, f.org.id)).toHaveLength(0)
      expect(await allMessages(t)).toHaveLength(0)
    }
  })

  it('refuses hidden, foreign and nonexistent reporters without consuming a task number', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const reporter_id of [f.agent.id, f.otherAdmin.id, uuid()]) {
      await expectRefusal(
        t.run(async (ctx) =>
          createIssueCore(ctx, {
            me: f.admin,
            args: {
              id: uuid(),
              project_id: f.sub.id,
              title: 'Refused reporter',
              reporter_id,
            },
            now: NOW,
            machine: { provenance: 'via MCP' },
          }),
        ),
        'rule',
        REPORTER_SENTENCE,
      )
    }
    const org = await t.run(async (ctx) => ctx.db.get(f.org._id))
    expect(org?.next_issue_num).toBe(1)
    expect(await t.run(async (ctx) => ctx.db.query('issues').collect())).toEqual([])
    expect(await t.run(async (ctx) => ctx.db.query('issue_subscriptions').collect())).toEqual([])
    expect(await activityFor(t, f.org.id)).toHaveLength(0)
    expect(await allMessages(t)).toHaveLength(0)
  })

  it('refuses an explicit null reporter instead of creating unknown attribution', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = {
      id: uuid(),
      project_id: f.sub.id,
      title: 'Unknown reporter',
      reporter_id: null,
    } as unknown as CreateIssueArgs
    await expectRefusal(
      t.run(async (ctx) => createIssueCore(ctx, { me: f.admin, args, now: NOW })),
      'bad_request',
      /^reporter_id must be a user uuid$/,
    )
    expect(await t.run(async (ctx) => ctx.db.query('issues').collect())).toEqual([])
    expect((await t.run(async (ctx) => ctx.db.get(f.org._id)))?.next_issue_num).toBe(1)
  })

  it('also refuses an otherwise assignable same-org user who cannot see the project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })

    await expectRefusal(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: issue.id,
        patch: { assignee_id: f.agent.id },
      }),
      'rule',
      ASSIGNEE_SENTENCE,
    )
    const after = await t.run(async (ctx) => (await ctx.db.get(issue._id)) as Doc<'issues'>)
    expect(after.assignee_id).toBeUndefined()
  })

  it('preserves reporter through access loss and moves while enforcing destination access for assignees', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const assigned = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.guest.id,
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.move, {
        org_id: f.org.id,
        id: assigned.id,
        project_id: hiddenSub.id,
      }),
      'rule',
      ASSIGNEE_SENTENCE,
    )

    const reported = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      reporter_id: f.guest.id,
      created_by: f.guest.id,
    })
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant === null) throw new Error('fixture reporter grant is missing')
      await ctx.db.delete(grant._id)
    })
    const updated = await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: reported.id,
      patch: { title: 'Access changed' },
    })
    expect(updated.reporter_id).toBe(f.guest.id)

    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: reported.id,
      project_id: hiddenSub.id,
    })
    const rows = await t.run(async (ctx) => [
      (await ctx.db.get(assigned._id)) as Doc<'issues'>,
      (await ctx.db.get(reported._id)) as Doc<'issues'>,
    ])
    expect(rows.map((row) => row.project_id)).toEqual([f.sub.id, hiddenSub.id])
    expect(rows[1].reporter_id).toBe(f.guest.id)
    expect(rows[1].created_by).toBe(f.guest.id)
    expect(rows[1].num).toBe(reported.num)
  })
})
