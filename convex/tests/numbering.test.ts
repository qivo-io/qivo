/* Issue numbering (0050): dense per-org at assignment, never reused, immutable
 * for life — the QN-<num> key survives edits and moves, and each organization
 * counts alone. The immutability sentence is structural on the browser surface
 * (no patch slot carries num), so the exported sentence is pinned byte-for-
 * byte for phase 8's machine surface. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { type CreateIssueArgs, NUM_IMMUTABLE_SENTENCE } from '../model/issues'
import {
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantProject,
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

const createAs = (t: T, f: OrgFixture, extra: Partial<CreateIssueArgs> = {}) =>
  as(t, f.admin).mutation(api.issues.create, {
    org_id: f.org.id,
    id: uuid(),
    project_id: f.sub.id,
    title: 'Numbered task',
    ...extra,
  })

describe('issue numbering', () => {
  it('numbers are dense per org, and a refused duplicate uuid consumes nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sharedId = uuid()
    const a = await createAs(t, f, { id: sharedId })
    const b = await createAs(t, f)
    expect(typeof a.num).toBe('number')
    expect(b.num).toBe(a.num + 1)
    expect(a).not.toHaveProperty('_id') // pub rows: uuid key, no system fields

    const dup = await expectRefusal(
      createAs(t, f, { id: sharedId, title: 'Impostor' }),
      'bad_request',
    )
    expect(dup.data.message).toBe('a task with this id already exists')
    const c = await createAs(t, f)
    expect(c.num).toBe(b.num + 1) // the refused attempt's counter bump rolled back
  })

  it('num is immutable: no public patch carries it, edits keep it, and the sentence is pinned', async () => {
    const t = newT()
    const f = await withOrg(t)
    const created = await createAs(t, f)
    await expect(
      as(t, f.admin).mutation(api.issues.update, {
        org_id: f.org.id,
        id: created.id,
        patch: { num: 999 } as unknown as never,
      }),
    ).rejects.toThrow()
    const row = await issueRow(t, created.id)
    expect(row.num).toBe(created.num)

    const renamed = await as(t, f.admin).mutation(api.issues.update, {
      org_id: f.org.id,
      id: created.id,
      patch: { title: 'renamed, same key' },
    })
    expect(renamed.num).toBe(created.num)

    expect(NUM_IMMUTABLE_SENTENCE).toBe(
      'task numbers are assigned once by the server and never change',
    )
  })

  it('move keeps the num: the QN key survives a project change', async () => {
    const t = newT()
    const f = await withOrg(t)
    const created = await createAs(t, f)
    const moved = await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: created.id,
      project_id: f.sub2.id,
    })
    expect(moved.project_id).toBe(f.sub2.id)
    expect(moved.num).toBe(created.num)
    expect((await issueRow(t, created.id)).num).toBe(created.num)
  })

  it('organizations count independently', async () => {
    const t = newT()
    const f = await withOrg(t)
    const otherSub = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const a1 = await createAs(t, f)
    const o1 = await as(t, f.otherAdmin).mutation(api.issues.create, {
      org_id: f.otherOrg.id,
      id: uuid(),
      project_id: otherSub.id,
      title: 'Elsewhere task',
    })
    // both fixtures start from the same counter — the sequences never interleave
    expect(o1.num).toBe(a1.num)
    const a2 = await createAs(t, f)
    expect(a2.num).toBe(a1.num + 1) // unaffected by the other org's create
  })
})
