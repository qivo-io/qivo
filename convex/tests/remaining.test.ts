/* The remaining-time and done-stamp invariants through the PUBLIC mutations:
 * the server-owned remaining_set_at (0072 — stamped on change, kept on no-op,
 * cleared with the value, never on the wire), the sub-issues guard raising
 * before any stamp (0066/0072 order), clear-on-attach with its subscriber
 * fan-out (0066/0067 + 0075 fix 4), the per-surface sentence pair, and the
 * 0071 done stamp including restore-while-done restarting the archive clock. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { assertNoSubtasks, type IssuePatch } from '../model/issues'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const issueRow = (t: T, id: string): Promise<Doc<'issues'>> =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (row === null) throw new Error(`issue ${id} vanished`)
    return row
  })

const subscribe = (t: T, issue_id: string, profile_id: string): Promise<void> =>
  t.run(async (ctx) => {
    await ctx.db.insert('issue_subscriptions', { issue_id, profile_id, created_at: NOW })
  })

const inbox = (t: T, recipient_id: string, issue_id: string): Promise<Doc<'messages'>[]> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', recipient_id).eq('issue_id', issue_id),
        )
        .collect(),
  )

const updateAs = (t: T, f: OrgFixture, id: string, patch: IssuePatch) =>
  as(t, f.admin).mutation(api.issues.update, { org_id: f.org.id, id, patch })

describe('remaining time', () => {
  it('the server owns remaining_set_at: stamped on change, kept on a same-value write, cleared with the value', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }

    const created = await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Hours',
      remaining_hours: 4,
    })
    expect(created.remaining_hours).toBe(4)
    expect(created.remaining_set_at).toBe(created.updated_at)

    const planted = await plantIssue(t, { ...base, remaining_hours: 5, remaining_set_at: NOW })
    const changed = await updateAs(t, f, planted.id, { remaining_hours: 6 })
    expect(changed.remaining_hours).toBe(6)
    expect(changed.remaining_set_at).toBe(changed.updated_at)
    expect(changed.remaining_set_at).not.toBe(NOW)

    const same = await plantIssue(t, { ...base, remaining_hours: 5, remaining_set_at: NOW })
    const noop = await updateAs(t, f, same.id, { remaining_hours: 5 })
    expect(noop.remaining_set_at).toBe(NOW) // untouched: the value did not change
    expect(noop.updated_at).not.toBe(NOW)

    const cleared = await updateAs(t, f, planted.id, { remaining_hours: null })
    expect(cleared.remaining_hours).toBeUndefined()
    expect(cleared.remaining_set_at).toBeUndefined() // the 0072 pairing

    // numeric(6,1) parity: one decimal is what lands
    const rounded = await updateAs(t, f, same.id, { remaining_hours: 5.25 })
    expect(rounded.remaining_hours).toBe(5.3)
  })

  it('a client-sent remaining_set_at never sticks: no wire slot carries it, on update or create', async () => {
    const t = newT()
    const f = await withOrg(t)
    const row = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await expect(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: row.id,
        patch: {
          remaining_hours: 2,
          remaining_set_at: '2020-01-01T00:00:00.000Z',
        } as unknown as never,
      }),
    ).rejects.toThrow(/remaining_set_at/)
    await expect(
      as(t, f.admin).mutation(api.issues.create, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Stamp smuggler',
        remaining_set_at: '2020-01-01T00:00:00.000Z',
      } as unknown as never),
    ).rejects.toThrow(/remaining_set_at/)
    const after = await issueRow(t, row.id)
    expect(after.remaining_set_at).toBeUndefined()
    expect(after.updated_at).toBe(NOW)
  })

  it('the sub-issues guard raises BEFORE any stamp: the refused parent row is untouched', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, { ...base })
    await plantIssue(t, { ...base, parent_id: parent.id })
    const err = await expectRefusal(updateAs(t, f, parent.id, { remaining_hours: 3 }), 'rule')
    expect(err.data.message).toBe(
      'a task with subtasks has no remaining time of its own — it shows the sum of its subtasks',
    )
    const row = await issueRow(t, parent.id)
    expect(row.remaining_hours).toBeUndefined()
    expect(row.remaining_set_at).toBeUndefined()
    expect(row.updated_at).toBe(NOW) // nothing of the refused write landed

    // archived children do not hold the value hostage (0070's child filter)
    const parent2 = await plantIssue(t, { ...base })
    await plantIssue(t, { ...base, parent_id: parent2.id, archived_at: NOW })
    const ok = await updateAs(t, f, parent2.id, { remaining_hours: 3 })
    expect(ok.remaining_hours).toBe(3)
    expect(ok.remaining_set_at).toBe(ok.updated_at)
  })

  it('a parent gaining a subtask loses its own hours AND its subscribers hear it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, { ...base, remaining_hours: 6.5, remaining_set_at: NOW })
    const orphan = await plantIssue(t, { ...base })
    await subscribe(t, parent.id, f.user.id)

    await updateAs(t, f, orphan.id, { parent_id: parent.id })
    const p = await issueRow(t, parent.id)
    expect(p.remaining_hours).toBeUndefined()
    expect(p.remaining_set_at).toBeUndefined() // stamp pairing holds on the side-effect write too
    expect(p.updated_at).not.toBe(NOW) // touched by the attach
    const msgs = await inbox(t, f.user.id, parent.id)
    // to_char(…, 'FM999990.#') rounded to an integer — 6.5 reads as 7
    expect(msgs.map((m) => m.detail)).toEqual(['Remaining cleared (was 7 h)'])
    expect(msgs[0].kind).toBe('change')
    expect(msgs[0].actor_id).toBe(f.admin.id)

    // the create path clears too (attach on INSERT)
    const parent2 = await plantIssue(t, { ...base, remaining_hours: 3, remaining_set_at: NOW })
    await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Born attached',
      parent_id: parent2.id,
    })
    const p2 = await issueRow(t, parent2.id)
    expect(p2.remaining_hours).toBeUndefined()
    expect(p2.remaining_set_at).toBeUndefined()
  })

  it('the two per-surface sentences stay distinct, and a negative value is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, { ...base })
    await plantIssue(t, { ...base, parent_id: parent.id })
    // The machine refusal identifies the field; both surfaces say task/subtasks.
    const machine = await expectRefusal(
      t.run(async (ctx) => {
        await assertNoSubtasks(ctx, parent.id)
      }),
      'bad_request',
    )
    expect(machine.data.message).toBe(
      'remaining_hours cannot be set on a task with subtasks — it is the sum of their remaining time',
    )
    const childless = await plantIssue(t, { ...base })
    const neg = await expectRefusal(
      updateAs(t, f, childless.id, { remaining_hours: -1 }),
      'bad_request',
    )
    expect(neg.data.message).toBe('remaining_hours must be a non-negative number or null')
  })

  it('done stamp (0071): set on entering done, kept on unrelated edits, never invented, cleared on leaving', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }

    const born = await as(t, f.admin).mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'Born done',
      status: 'done',
    })
    expect(born.done_at).toBe(born.updated_at)

    const row = await plantIssue(t, { ...base })
    const entered = await updateAs(t, f, row.id, { status: 'done' })
    expect(entered.done_at).toBe(entered.updated_at)

    const steady = await plantIssue(t, { ...base, status: 'done', done_at: NOW })
    const renamed = await updateAs(t, f, steady.id, { title: 'still done' })
    expect(renamed.done_at).toBe(NOW) // the old stamp survives an unrelated edit
    expect(renamed.updated_at).not.toBe(NOW)

    const stampless = await plantIssue(t, { ...base, status: 'done' })
    const touched = await updateAs(t, f, stampless.id, { title: 'no clock' })
    expect(touched.done_at).toBeUndefined() // a side edit must not stamp a stampless row

    const left = await updateAs(t, f, steady.id, { status: 'todo' })
    expect(left.done_at).toBeUndefined()
  })

  it('restore-while-done restarts the archive clock; archiving alone never restamps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }

    const buried = await plantIssue(t, { ...base, status: 'done', done_at: NOW, archived_at: NOW })
    const restored = await as(t, f.admin).mutation(api.issues.unarchive, {
      org_id: f.org.id,
      id: buried.id,
    })
    expect(restored.archived_at).toBeUndefined()
    expect(restored.done_at).toBe(restored.updated_at)
    expect(restored.done_at).not.toBe(NOW) // 0071 fix 1: the auto-archive clock restarted

    const doneRow = await plantIssue(t, { ...base, status: 'done', done_at: NOW })
    const { issue: archived } = await as(t, f.admin).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: doneRow.id,
    })
    expect(archived.done_at).toBe(NOW) // archiving keeps the stamp as it was
    expect(archived.archived_at).toBe(archived.updated_at)

    const plain = await plantIssue(t, { ...base, archived_at: NOW })
    const back = await as(t, f.admin).mutation(api.issues.unarchive, {
      org_id: f.org.id,
      id: plain.id,
    })
    expect(back.done_at).toBeUndefined() // restoring a not-done row invents no stamp
  })
})
