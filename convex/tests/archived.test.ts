/* issues.archivedFor — the Archive page's on-demand read (P.fetchArchived).
 * Fence: can_see_project per project id, through the caller's seat in that
 * project's OWN org; unknown/invisible ids contribute nothing (no existence
 * oracle). Only archived rows come back, archived_at desc then num desc. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { as, newT, plantIssue, uuid, withOrg } from './helpers.setup'

describe('issues.archivedFor', () => {
  it('returns only archived issues of the named projects, newest-archived first, num desc tiebreak', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'live' })
    const early = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'early',
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    const labelId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: labelId,
        org_id: f.org.id,
        name: 'Old',
        name_lower: 'old',
        color: '#F0555D',
        created_at: '2026-01-01T00:00:00.000Z',
      })
      await ctx.db.insert('issue_labels', {
        org_id: early.org_id,
        issue_id: early.id,
        label_id: labelId,
      })
    })
    const lateA = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'lateA',
      archived_at: '2026-01-03T00:00:00.000Z',
    })
    const lateB = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      title: 'lateB',
      archived_at: '2026-01-03T00:00:00.000Z',
    })
    const rows = await as(t, f.admin).query(api.issues.archivedFor, {
      project_ids: [f.meta.id, f.sub.id, f.sub2.id],
    })
    const higherNum = lateB.num > lateA.num ? lateB : lateA
    const lowerNum = lateB.num > lateA.num ? lateA : lateB
    expect(rows.map((r) => r.id)).toEqual([higherNum.id, lowerNum.id, early.id])
    // raw app rows: uuid key kept, system fields stripped
    expect(rows[0]).not.toHaveProperty('_id')
    expect(rows[0].title).toBe(higherNum.title)
    expect(rows.find((row) => row.id === early.id)?.label_ids).toEqual([labelId])
  })

  it('an invisible or unknown project id contributes nothing, without erroring', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hiddenRow = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      title: 'hidden archived',
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    const visible = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'mine archived',
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    // guest holds a grant on meta only — hidden and a bogus id fall away silently
    const rows = await as(t, f.guest).query(api.issues.archivedFor, {
      project_ids: [f.sub.id, f.hidden.id, 'no-such-project'],
    })
    expect(rows.map((r) => r.id)).toEqual([visible.id])
    expect(rows.some((r) => r.id === hiddenRow.id)).toBe(false)
  })

  it('spans organizations: each id is fenced through the caller seat in ITS org', async () => {
    const t = newT()
    const f = await withOrg(t)
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      title: 'foreign archived',
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    // admin of Testbed Labs holds no seat in Other — the foreign id yields nothing
    const refused = await as(t, f.admin).query(api.issues.archivedFor, {
      project_ids: [f.otherProject.id],
    })
    expect(refused).toEqual([])
    // the Other org's own admin sees it
    const rows = await as(t, f.otherAdmin).query(api.issues.archivedFor, {
      project_ids: [f.otherProject.id],
    })
    expect(rows.map((r) => r.id)).toEqual([foreign.id])
  })
})
