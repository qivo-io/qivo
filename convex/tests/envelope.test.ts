/* The scheduling envelope invariants, driven through the PUBLIC issue
 * mutations: clamp (parent side, 0070), the widen cascade (child side, 0070 —
 * per-ancestor touch AND notify, the phase-4 headline), the hierarchy depth
 * caps (0057/0038), the parent org/archive fences and the week-pair CHECKs.
 * Refusal sentences are asserted byte-for-byte via err.data.message. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { CreateIssueArgs, IssuePatch } from '../model/issues'
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

const createAs = (t: T, f: OrgFixture, extra: Partial<CreateIssueArgs> = {}) =>
  as(t, f.admin).mutation(api.issues.create, {
    org_id: f.org.id,
    id: uuid(),
    project_id: f.sub.id,
    title: 'Envelope task',
    ...extra,
  })

const updateAs = (t: T, f: OrgFixture, id: string, patch: IssuePatch) =>
  as(t, f.admin).mutation(api.issues.update, { org_id: f.org.id, id, patch })

/* A parent_id chain of n rows in f.sub, index 0 the root, n-1 the deepest. */
async function plantChain(t: T, f: OrgFixture, n: number): Promise<Doc<'issues'>[]> {
  const rows: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++) {
    const prev = rows[rows.length - 1]
    rows.push(
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        ...(prev === undefined ? {} : { parent_id: prev.id }),
      }),
    )
  }
  return rows
}

describe('issue scheduling envelope', () => {
  it('a parent edit lands pre-clamped to cover its active children; archived children do not constrain', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const parent = await plantIssue(t, {
      ...base,
      start_week: '2026-03-02',
      end_week: '2026-03-08',
    })
    await plantIssue(t, {
      ...base,
      parent_id: parent.id,
      start_week: '2026-03-02',
      end_week: '2026-03-15',
    })
    await plantIssue(t, {
      ...base,
      parent_id: parent.id,
      start_week: '2026-01-05',
      end_week: '2026-06-01',
      archived_at: NOW,
    })
    const ret = await updateAs(t, f, parent.id, {
      start_week: '2026-03-09',
      end_week: '2026-03-22',
    })
    // pulled back to the active child's start (never the archived one's); the
    // asked-for end already covered — the returned row carries what landed
    expect(ret.start_week).toBe('2026-03-02')
    expect(ret.end_week).toBe('2026-03-22')
    const row = await issueRow(t, parent.id)
    expect(row.start_week).toBe('2026-03-02')
    expect(row.end_week).toBe('2026-03-22')
  })

  it('a child reschedule cascades: EACH touched ancestor is stamped and its subscribers hear the new span', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const ggp = await plantIssue(t, { ...base, title: 'unscheduled top' })
    const gp = await plantIssue(t, {
      ...base,
      parent_id: ggp.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
    })
    const parent = await plantIssue(t, {
      ...base,
      parent_id: gp.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
    })
    const child = await plantIssue(t, {
      ...base,
      parent_id: parent.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
    })
    for (const target of [parent.id, gp.id, ggp.id]) await subscribe(t, target, f.user.id)

    const ret = await updateAs(t, f, child.id, { start_week: '2026-02-02', end_week: '2026-02-15' })
    expect(ret.end_week).toBe('2026-02-15')

    for (const id of [parent.id, gp.id]) {
      const row = await issueRow(t, id)
      expect(row.start_week).toBe('2026-02-02')
      expect(row.end_week).toBe('2026-02-15')
      expect(row.updated_at).toBe(ret.updated_at) // stamped with the mutation's ONE now
      const msgs = await inbox(t, f.user.id, id)
      expect(msgs.map((m) => m.detail)).toEqual(['Schedule: 2 Feb – 8 Feb → 2 Feb – 15 Feb'])
      expect(msgs[0].kind).toBe('change')
      expect(msgs[0].actor_id).toBe(f.admin.id)
      expect(msgs[0].created_at).toBe(ret.updated_at)
    }

    // the walk stops at the first unscheduled ancestor: untouched, unmessaged
    const top = await issueRow(t, ggp.id)
    expect(top.start_week).toBeUndefined()
    expect(top.updated_at).toBe(NOW)
    expect(await inbox(t, f.user.id, ggp.id)).toEqual([])
  })

  it('the widen fires on INSERT too: creating a scheduled child widens a narrower parent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
    })
    await subscribe(t, parent.id, f.user.id)
    await createAs(t, f, { parent_id: parent.id, start_week: '2026-01-26', end_week: '2026-02-08' })
    const row = await issueRow(t, parent.id)
    expect(row.start_week).toBe('2026-01-26')
    expect(row.end_week).toBe('2026-02-08')
    expect(row.updated_at).not.toBe(NOW)
    const msgs = await inbox(t, f.user.id, parent.id)
    expect(msgs.map((m) => m.detail)).toEqual(['Schedule: 2 Feb – 8 Feb → 26 Jan – 8 Feb'])
  })

  it('depth caps: the up-walk refuses past 20, and a reparent may not merge two legal chains past the budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    const deep = await plantChain(t, f, 21)
    const up = await expectRefusal(createAs(t, f, { parent_id: deep[20].id }), 'rule')
    expect(up.data.message).toBe('task hierarchy too deep or cyclic')

    const a = await plantChain(t, f, 10)
    const b = await plantChain(t, f, 11)
    const merged = await expectRefusal(updateAs(t, f, b[0].id, { parent_id: a[9].id }), 'rule')
    expect(merged.data.message).toBe('task hierarchy too deep')

    // the boundary itself is legal: 10 above + the row + 9 below = 20
    const c = await plantChain(t, f, 10)
    const d = await plantChain(t, f, 10)
    const moved = await updateAs(t, f, d[0].id, { parent_id: c[9].id })
    expect(moved.parent_id).toBe(c[9].id)
  })

  it('the parent fence: a foreign-org parent answers the same-org rule, a missing one not_found, self is refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const crossCreate = await expectRefusal(createAs(t, f, { parent_id: foreign.id }), 'rule')
    expect(crossCreate.data.message).toBe(
      'a subtask and its parent must belong to the same organization',
    )
    const missing = await expectRefusal(createAs(t, f, { parent_id: uuid() }), 'not_found')
    expect(missing.data.message).toBe('parent task not found')

    const mine = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const crossPatch = await expectRefusal(
      updateAs(t, f, mine.id, { parent_id: foreign.id }),
      'rule',
    )
    expect(crossPatch.data.message).toBe(
      'a subtask and its parent must belong to the same organization',
    )
    const self = await expectRefusal(updateAs(t, f, mine.id, { parent_id: mine.id }), 'rule')
    expect(self.data.message).toBe('a task cannot be its own parent')
  })

  it('week pair: both-or-neither and ordering, on create and on a half-clear', async () => {
    const t = newT()
    const f = await withOrg(t)
    const half = await expectRefusal(createAs(t, f, { start_week: '2026-02-02' }), 'bad_request')
    expect(half.data.message).toBe('start_week and end_week must be set (or cleared) together')
    const backwards = await expectRefusal(
      createAs(t, f, { start_week: '2026-02-09', end_week: '2026-02-02' }),
      'bad_request',
    )
    expect(backwards.data.message).toBe('start_week must not be after end_week')
    const scheduled = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-02-02',
      end_week: '2026-02-08',
    })
    const halfClear = await expectRefusal(
      updateAs(t, f, scheduled.id, { end_week: null }),
      'bad_request',
    )
    expect(halfClear.data.message).toBe('start_week and end_week must be set (or cleared) together')
  })

  it('archived-parent guard, non-inverted: no ACTIVE row under an archived parent — yet archiving a parent with active children is the normal cascade', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
    const buried = await plantIssue(t, { ...base, archived_at: NOW })
    const onCreate = await expectRefusal(createAs(t, f, { parent_id: buried.id }), 'rule')
    expect(onCreate.data.message).toBe('the parent task is archived — restore it first')
    const mine = await plantIssue(t, { ...base })
    const onPatch = await expectRefusal(updateAs(t, f, mine.id, { parent_id: buried.id }), 'rule')
    expect(onPatch.data.message).toBe('the parent task is archived — restore it first')

    // the direction the survey had backwards: archived child under an active
    // parent IS archiving — the cascade makes it, no guard fires
    const parent = await plantIssue(t, { ...base })
    const kid = await plantIssue(t, { ...base, parent_id: parent.id })
    const { issue: archived, descendants } = await as(t, f.admin).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: parent.id,
    })
    expect(descendants).toBe(1)
    const kidRow = await issueRow(t, kid.id)
    expect(kidRow.archived_at).toBe(archived.archived_at) // the subtree shares one now
    const p2 = await plantIssue(t, { ...base })
    const k2 = await plantIssue(t, { ...base, parent_id: p2.id })
    const solo = await as(t, f.admin).mutation(api.issues.archive, { org_id: f.org.id, id: k2.id })
    expect(solo.descendants).toBe(0)
    expect((await issueRow(t, p2.id)).archived_at).toBeUndefined()
  })
})
