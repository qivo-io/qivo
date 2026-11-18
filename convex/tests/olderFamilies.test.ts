/* The read-only count of subtasks stored in another sub-project than their
 * parent's (internal/olderFamilies.ts). The families are planted as rows,
 * as only data from before the rule holds them: one across sibling
 * sub-projects of TBED and one across top-level projects, beside a family
 * that follows the rule and a task whose parent is gone. */

import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OLDER_FAMILIES, RUN } from '../internal/olderFamilies'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'

const DEFAULTS = { ...OLDER_FAMILIES }
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(OLDER_FAMILIES, DEFAULTS)
  Object.assign(RUN, DEFAULT_RUN)
})

const count = (t: T, cursor: string | null = null) =>
  t.query(internal.internal.olderFamilies.count, { cursor })

/* A task of the fixture's organization. */
const task = (t: T, f: OrgFixture, project_id: string, extra: Partial<Doc<'issues'>> = {}) =>
  plantIssue(t, { org_id: f.org.id, project_id, ...extra })

/* TBED's families and a sub-project of a second top-level project. */
async function scene(t: T) {
  const f = await withReadingAdmin(t)
  const cloud = await plantProject(t, { org_id: f.org.id, key: 'CLD', name: 'Cloud' })
  const backend = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: cloud.id,
    key: 'BE',
    name: 'Backend',
  })
  const parent = await task(t, f, f.sub.id)
  await task(t, f, f.sub.id, { parent_id: parent.id })
  const sibling = await task(t, f, f.sub2.id, { parent_id: parent.id })
  const across = await task(t, f, backend.id, { parent_id: parent.id, archived_at: NOW })
  const orphan = await task(t, f, f.sub.id, { parent_id: uuid() })
  await task(t, f, f.sub.id)
  return { sibling, across, orphan }
}

describe('the count of subtasks in another sub-project than their parent', () => {
  it('counts each kind with its examples, and nothing for a family that follows the rule', async () => {
    const t = newT()
    const { sibling, across, orphan } = await scene(t)
    expect(await count(t)).toEqual({
      scanned: 4,
      counts: { sibling: 1, other_project: 1, missing_parent: 1, held: 0 },
      examples: {
        sibling: [sibling.id],
        other_project: [across.id],
        missing_parent: [orphan.id],
        held: [],
      },
      cursor: null,
    })
    // a task whose project Deleted items holds is left to it
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', sibling.project_id))
        .unique()
      if (row !== null) await ctx.db.delete(row._id)
    })
    expect((await count(t)).counts).toMatchObject({ sibling: 0, held: 1 })
    // and it wrote nothing
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toHaveLength(6)
  })

  it('counts page after page to the end, from where an earlier call stopped', async () => {
    const t = newT()
    const { sibling, across } = await scene(t)
    OLDER_FAMILIES.page = 1
    let scanned = 0
    let cursor: string | null = null
    for (let n = 0; n < 10; n++) {
      const page = await count(t, cursor)
      scanned += page.scanned
      cursor = page.cursor
      if (cursor === null) break
    }
    expect([scanned, cursor]).toEqual([4, null])
    // the run sums them; with no time left each call stops after one page
    const whole = {
      scanned: 4,
      counts: { sibling: 1, other_project: 1, missing_parent: 1, held: 0 },
      examples: { sibling: [sibling.id], other_project: [across.id] },
      done: true,
      cursor: null,
    }
    expect(await t.action(internal.internal.olderFamilies.run, {})).toMatchObject(whole)
    RUN.ms = -1
    let answer = await t.action(internal.internal.olderFamilies.run, {})
    expect(answer).toMatchObject({ scanned: 1, done: false })
    // a call given the previous answer whole goes on from its cursor and
    // totals, so the last answer counts every page of the run
    let calls = 1
    while (!answer.done && calls < 10) {
      answer = await t.action(internal.internal.olderFamilies.run, answer)
      calls += 1
    }
    expect(calls).toBeGreaterThan(3)
    expect(answer).toMatchObject(whole)
  })

  it('refuses a cursor without the totals of the answer it came with', async () => {
    const t = newT()
    await scene(t)
    OLDER_FAMILIES.page = 1
    RUN.ms = -1
    const first = await t.action(internal.internal.olderFamilies.run, {})
    if (first.done) throw new Error('expected a run that stops partway')
    await expectRefusal(
      t.action(internal.internal.olderFamilies.run, { cursor: first.cursor }),
      'bad_request',
      /whole previous answer/,
    )
    await expectRefusal(
      t.action(internal.internal.olderFamilies.run, {
        ...first,
        counts: { ...first.counts, held: first.scanned + 1 },
      }),
      'bad_request',
      /does not hold together/,
    )
  })
})
