import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { McpIssueOut } from '../lib/core'
import {
  appLoadRows,
  as,
  expectRefusal,
  newT,
  plantIssue,
  restTasks,
  TODAY,
  uuid,
  wholeOf,
  withReadingAdmin,
  workingSetOf,
} from './helpers.setup'

describe('parent task status', () => {
  it.each(['detach', 'delete', 'archive'] as const)(
    'preserves dormant status while grouped and restores it after last-child %s',
    async (remove) => {
      const t = newT()
      const f = await withReadingAdmin(t)
      const client = as(t, f.admin)
      const parent = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        status: 'review',
      })
      const child = await client.mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        parent_id: parent.id,
        title: 'Subtask',
      })
      const getParent = () =>
        t.query(internal.machine.rest.getIssue, {
          today: TODAY,
          callerId: f.admin.id,
          access: 'read',
          ref: parent.id,
        })
      expect(await getParent()).toMatchObject({ status: 'review', is_group: true })
      await expectRefusal(
        client.mutation(api.issues.update, {
          org_id: f.org.id,
          id: parent.id,
          patch: { status: 'done' },
        }),
        'rule',
        /status cannot be set on a task with subtasks/,
      )
      expect(await getParent()).toMatchObject({ status: 'review', is_group: true })

      if (remove === 'detach') {
        await client.mutation(api.issues.update, {
          org_id: f.org.id,
          id: child.id,
          patch: { parent_id: null },
        })
      } else if (remove === 'delete') {
        await client.mutation(api.issues.deleteDeep, { org_id: f.org.id, id: child.id })
      } else {
        await client.mutation(api.issues.archive, { org_id: f.org.id, id: child.id })
      }
      expect(await getParent()).toMatchObject({ status: 'review', is_group: false })
      const normal = await client.mutation(api.issues.update, {
        org_id: f.org.id,
        id: parent.id,
        patch: { status: 'done' },
      })
      expect(normal.status).toBe('done')
      expect(normal.done_at).toBe(normal.updated_at)
      if (remove === 'archive') {
        await client.mutation(api.issues.unarchive, { org_id: f.org.id, id: child.id })
        expect(await getParent()).toMatchObject({ status: 'done', is_group: true })
      }
    },
  )

  it('status filters and writes use leaves across nested groups on REST and MCP', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const base = { org_id: f.org.id, project_id: f.sub.id, status: 'review' as const }
    const root = await plantIssue(t, base)
    const middle = await plantIssue(t, { ...base, parent_id: root.id })
    const leaf = await plantIssue(t, { ...base, parent_id: middle.id })
    const rest = await restTasks(t, {
      callerId: f.admin.id,
      access: 'read',
      status: 'review',
    })
    const mcp = JSON.parse(
      await t.query(internal.machine.mcp.listIssues, {
        today: TODAY,
        callerId: f.admin.id,
        access: 'read',
        status: 'review',
      }),
    ) as { next_cursor: string | null; tasks: McpIssueOut[] }
    expect(rest.map((i) => i.id)).toEqual([leaf.id])
    expect(mcp.tasks.map((i) => i.id)).toEqual([leaf.id])
    expect(mcp.next_cursor).toBeNull()
    expect(
      JSON.parse(
        await t.query(internal.machine.mcp.getIssue, {
          today: TODAY,
          callerId: f.admin.id,
          access: 'read',
          ref: root.id,
        }),
      ),
    ).toMatchObject({ is_group: true, status: 'review' })
    await expectRefusal(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.admin.id,
        access: 'write',
        keyName: 'test',
        ref: root.id,
        body: JSON.stringify({ status: 'done', archived: true }),
      }),
      'rule',
      /status cannot be set/,
    )
    await expectRefusal(
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.admin.id,
        access: 'write',
        ref: middle.id,
        status: 'todo',
      }),
      'rule',
      /status cannot be set/,
    )
    const snapshot = await workingSetOf(as(t, f.admin))
    expect(snapshot?.issues.map((i) => i.id).sort()).toEqual([root.id, middle.id, leaf.id].sort())
  })

  it('groups contribute no independent planning load regardless of stored status', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const base = {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.user.id,
      start_week: '2026-09-07',
      end_week: '2026-09-14',
    }
    for (const status of ['todo', 'done'] as const) {
      // Raw legacy hours must also be ignored, even if no attach mutation
      // has yet repaired them via clearParentRemaining.
      const parent = await plantIssue(t, { ...base, status, remaining_hours: 99 })
      await plantIssue(t, { ...base, parent_id: parent.id, remaining_hours: 3 })
    }
    const load = await as(t, f.admin).query(api.planning.assigneeLoad, { assignee_id: f.user.id })
    expect(load).toHaveLength(2)
    expect(load.map((r) => r.remaining)).toEqual([3, 3])
    const snapshot = await wholeOf(t, f.admin)
    expect(snapshot && appLoadRows(snapshot).map((r) => r.remaining)).toEqual([3, 3])
  })

  it('archived groups retain grouping metadata and refuse status changes', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })
    await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: parent.id })
    const { rows: archived } = await as(t, f.admin).query(api.issues.archivedPage, {
      scope: { org_id: f.org.id, project_ids: [f.sub.id] },
    })
    expect(archived).toHaveLength(2)
    expect(archived.find((i) => i.id === parent.id)?.is_group).toBe(true)
    expect(archived.find((i) => i.id !== parent.id)?.is_group).toBe(false)
    expect(
      await t.query(internal.machine.rest.getIssue, {
        today: TODAY,
        callerId: f.admin.id,
        access: 'read',
        ref: parent.id,
      }),
    ).toMatchObject({ is_group: true })
    await expectRefusal(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: parent.id,
        patch: { status: 'done' },
      }),
      'rule',
      /status cannot be set/,
    )
  })
})
