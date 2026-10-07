import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import { as, expectRefusal, newT, plantIssue, uuid, withOrg } from './helpers.setup'

/* The pause follows the status (model/issues.ts isPausable): only a To Do,
 * In Progress or In Review task holds one, a move into Done or Backlog
 * clears it, and asking to pause a task that sits there is refused. */
describe('paused tasks', () => {
  it('a pause sticks on a task under way and a move to Done or Backlog resumes it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const client = as(t, f.admin)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'progress',
    })
    const read = async () =>
      (await t.query(internal.machine.rest.getIssue, { callerId: f.admin.id, ref: issue.id }))
        .paused
    const update = (patch: { status?: 'todo' | 'done' | 'backlog'; paused?: boolean }) =>
      client.mutation(api.issues.update, { org_id: f.org.id, id: issue.id, patch })

    await update({ paused: true })
    expect(await read()).toBe(true)
    await update({ status: 'todo' }) // still under way: the pause survives
    expect(await read()).toBe(true)
    await update({ status: 'done' }) // the move itself resumes the task
    expect(await read()).toBe(false)
    await update({ status: 'todo', paused: true })
    expect(await read()).toBe(true)
    await update({ status: 'backlog' })
    expect(await read()).toBe(false)
  })

  it('a Done or Backlog task cannot be paused, on update or at creation', async () => {
    const t = newT()
    const f = await withOrg(t)
    const client = as(t, f.admin)
    const done = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'done' })
    await expectRefusal(
      client.mutation(api.issues.update, {
        org_id: f.org.id,
        id: done.id,
        patch: { paused: true },
      }),
      'rule',
      /cannot be paused/,
    )
    // a patch that moves the task there and pauses it at once is refused too
    const open = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'todo' })
    await expectRefusal(
      client.mutation(api.issues.update, {
        org_id: f.org.id,
        id: open.id,
        patch: { status: 'backlog', paused: true },
      }),
      'rule',
      /cannot be paused/,
    )
    await expectRefusal(
      client.mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Born on hold',
        paused: true, // no status: a new task starts in Backlog
      }),
      'rule',
      /cannot be paused/,
    )
    const born = await client.mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Born on hold',
      status: 'progress',
      paused: true,
    })
    expect(born.paused).toBe(true)
  })
})
