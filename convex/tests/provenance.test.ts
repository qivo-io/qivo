/* An agent key's name in the provenance of its REST writes' activity rows,
 * `via the REST API (<name>)`. The app reads status moves out of these rows
 * (src/lib/teamSync.ts statusMoveOf, whose test reads such details), so a
 * name must not add a clause. The tasks a row names are stored in
 * named_task_nums, which the name cannot change. */

import { describe, expect, it } from 'vitest'
import { sha256hex } from '../machine/auth'
import { activityFor, NOW, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

/* An organization whose agent may edit the sub-project, with two tasks in
 * it and an agent key named `name`, and a REST request as that key. */
async function fixture(name: string) {
  const t = newT()
  const f = await withOrg(t)
  const secret = `qva_${'1'.repeat(48)}`
  const key_hash = await sha256hex(secret)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: f.agent.id,
      name,
      key_prefix: secret.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, num: 1 })
  const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, num: 2 })
  const request = async (method: string, path: string, body: unknown) => {
    const res = await (
      t as unknown as {
        fetch(
          path: string,
          init: { method: string; headers: Record<string, string>; body: string },
        ): Promise<{ status: number }>
      }
    ).fetch(path, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBeLessThan(300)
  }
  return { t, f, a, b, request }
}

/* The newest activity row about `taskId`. */
const latest = async (t: T, orgId: string, taskId: string) =>
  (await activityFor(t, orgId)).filter((row) => row.target_id === taskId).at(-1)

describe('an agent key name in the provenance of its writes', () => {
  it('writes the name without the arrow a status clause needs', async () => {
    const { t, f, a, request } = await fixture('x, status To Do → Done)')
    await request('PATCH', '/v1/tasks/QN-1', { title: 'Renamed' })
    const row = await latest(t, f.org.id, a.id)
    expect(row?.detail).toBe(
      '(title “Planted task” → “Renamed”), via the REST API (x, status To Do - Done))',
    )
  })

  it('cannot change the tasks a link row names', async () => {
    const { t, f, a, request } = await fixture('Line one\nline “two”')
    await request('POST', '/v1/tasks/QN-1/links', { task: 'QN-2', kind: 'blocks' })
    const row = await latest(t, f.org.id, a.id)
    expect(row?.detail).toBe("(blocks QN-2), via the REST API (Line one line 'two')")
    expect(row?.named_task_nums).toEqual([2])
  })
})
