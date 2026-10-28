/* The Archived tasks page's on-demand reads, outside the snapshot.
 *
 * issues.archivedPage (P.fetchArchivedPage) pages one project family's
 * archived tasks with a cursor and searches them on the server
 * (lib/archivedTasks.ts). issues.archivedFor is the deprecated whole-archive
 * read that clients from before it still call. issues.archivedTask
 * (P.fetchArchivedTask) finds one archived task by id for the task window.
 * Fence: can_see_project through the caller's seat in the project's OWN org;
 * an unknown or invisible project answers nothing (no existence oracle).
 * Only archived rows come back. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ARCHIVE_PAGE } from '../lib/archivedTasks'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { matchesAllWords, taskSearchText } from '../lib/search'
import { issueKey } from '../lib/taskRefs'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* Archive cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts), so every page with a next cursor needs one. */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'archived-test-secret-not-a-deployment-key'

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

/* ------------------------------------------------------------ archivedPage */

type Page = {
  rows: (Doc<'issues'> & { is_group: boolean })[]
  next_cursor: string | null
  scanned: number
}

/** One archivedPage call as `profile`. */
const pageOf = (
  t: T,
  profile: Doc<'profiles'>,
  args: { project_id: string; cursor?: string; search?: string; limit?: number },
) => as(t, profile).query(api.issues.archivedPage, args) as Promise<Page>

/** Every page of `project_id`'s archived tasks as `profile`, with the ids in
 * the order they came, the page count and the sum of `scanned`. */
async function everyPage(
  t: T,
  profile: Doc<'profiles'>,
  args: { project_id: string; search?: string; limit?: number },
  between: (page: number) => Promise<void> = async () => {},
) {
  const ids: string[] = []
  const sizes: number[] = []
  let scanned = 0
  let cursor: string | undefined
  do {
    const page = await pageOf(t, profile, { ...args, cursor })
    ids.push(...page.rows.map((row) => row.id))
    sizes.push(page.rows.length)
    scanned += page.scanned
    cursor = page.next_cursor ?? undefined
    await between(sizes.length)
    if (sizes.length > 200) throw new Error('paging does not end')
  } while (cursor !== undefined)
  return { ids, sizes, scanned }
}

/** The archived tasks of `projectIds` in archive order: most recently
 * archived first, then newest created first, then by document id. */
const archiveOrder = (t: T, orgId: string, projectIds: string[]) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    return rows
      .filter((row) => row.archived_at !== undefined && projectIds.includes(row.project_id))
      .sort((a, b) =>
        a.archived_at !== b.archived_at
          ? (b.archived_at ?? '') < (a.archived_at ?? '')
            ? -1
            : 1
          : a._creationTime !== b._creationTime
            ? b._creationTime - a._creationTime
            : b._id < a._id
              ? -1
              : 1,
      )
  })

/* Task numbers for plantMany, clear of plantIssue's. */
let bulkNum = 200_000

/* `count` archived tasks in one transaction, without reading anything. */
const plantMany = (
  t: T,
  f: OrgFixture,
  count: number,
  over: (i: number) => Partial<Doc<'issues'>> & { project_id: string },
) =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = uuid()
      ids.push(id)
      await ctx.db.insert('issues', {
        id,
        org_id: f.org.id,
        num: bulkNum++,
        title: `Bulk ${i}`,
        description: '',
        status: 'done',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        archived_at: NOW,
        ...over(i),
      })
    }
    return ids
  })

/** 09:00 UTC on day `d` of March 2026, as an archive time. */
const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}T09:00:00.000Z`

/** Expects `p` to be refused as bad_request with exactly `sentence`. */
async function badRequest(p: Promise<unknown>, sentence: string): Promise<void> {
  const e = await expectRefusal(p, 'bad_request')
  expect((e.data as Refusal).message).toBe(sentence)
}

describe('issues.archivedPage', () => {
  const page = { ...ARCHIVE_PAGE }
  afterEach(() => {
    Object.assign(ARCHIVE_PAGE, page)
  })

  it('lists a project family’s archived tasks, newest archived first, ties newest created first', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'active' })
    const early = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(2),
    })
    const tieOld = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(3),
      num: 9_000,
    })
    // created later with a lower number, as creation decides a tie, not num
    const tieNew = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      archived_at: day(3),
      num: 10,
    })
    const one = await pageOf(t, f.admin, { project_id: f.meta.id })
    expect(one.rows.map((row) => row.id)).toEqual([tieNew.id, tieOld.id, early.id])
    expect(one.next_cursor).toBeNull()
    expect(one.scanned).toBe(3)
    // a sub-project lists only its own
    const fw = await pageOf(t, f.admin, { project_id: f.sub.id })
    expect(fw.rows.map((row) => row.id)).toEqual([tieOld.id, early.id])
  })

  it('pages 230 tasks over three sub-projects once each, across a tie of 40', async () => {
    const t = newT()
    const f = await withOrg(t)
    const doc = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const subs = [f.sub.id, f.sub2.id, doc.id]
    // interleaved stamps, then 40 that share one moment from task 80 to 119
    await plantMany(t, f, 230, (i) => ({
      project_id: subs[i % 3],
      archived_at: i >= 80 && i < 120 ? day(15) : day(1 + (i % 28)),
    }))
    const expected = (await archiveOrder(t, f.org.id, subs)).map((row) => row.id)
    const all = await everyPage(t, f.admin, { project_id: f.meta.id })
    expect(all.ids).toEqual(expected)
    // the third page knows it is the last one, so no empty fourth is asked for
    expect(all.sizes).toEqual([100, 100, 30])
    expect(all.scanned).toBe(230)
    // a family whose size is a multiple of the limit ends on its last full
    // page, with no empty page after it
    const exact = await everyPage(t, f.admin, { project_id: f.meta.id, limit: 46 })
    expect(exact.sizes).toEqual([46, 46, 46, 46, 46])
  })

  it('answers rows without descriptions or parents, with is_group', async () => {
    const t = newT()
    const f = await withOrg(t)
    const group = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(5),
      description: 'a long story',
    })
    const kid = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: group.id,
      archived_at: day(5),
      relations_marked: true,
    })
    const { rows } = await pageOf(t, f.admin, { project_id: f.sub.id })
    expect(rows.map((row) => [row.id, row.is_group])).toEqual([
      [kid.id, false],
      [group.id, true],
    ])
    for (const row of rows) {
      for (const key of ['_id', '_creationTime', 'description', 'parent_id', 'relations_marked']) {
        expect(row).not.toHaveProperty(key)
      }
      expect(row).toMatchObject({ org_id: f.org.id, archived_at: day(5) })
    }
  })

  /* Archived tasks of FW that each match a search through one field. */
  async function searchable(t: T, f: OrgFixture) {
    const nora = uuid()
    const thermal = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        id: nora,
        org_id: f.org.id,
        name: 'Nora Berg',
        initials: 'NB',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      await ctx.db.insert('labels', {
        id: thermal,
        org_id: f.org.id,
        name: 'Thermal',
        name_lower: 'thermal',
        color: '#F0555D',
        created_at: NOW,
      })
    })
    const task = (over: Partial<Doc<'issues'>>) =>
      plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        status: 'done',
        priority: 'medium',
        archived_at: day(4),
        ...over,
      })
    const titled = await task({ title: 'Calibrate the drift sensor' })
    const described = await task({ description: 'Measured the flux at noon' })
    const reviewLeaf = await task({ status: 'review' })
    const reviewGroup = await task({ status: 'review' })
    await task({ parent_id: reviewGroup.id })
    const urgent = await task({ priority: 'urgent', description: 'flux again' })
    const assigned = await task({ assignee_id: nora })
    const labelled = await task({})
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: labelled.id,
        label_id: thermal,
      })
    })
    // a match in a sibling sub-project and outside the family
    const pcb = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      archived_at: day(3),
      title: 'Drift on the PCB',
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      archived_at: day(3),
      title: 'Drift in the skunkworks',
    })
    return { titled, described, reviewLeaf, reviewGroup, urgent, assigned, labelled, pcb, nora }
  }

  /* The ids of the family's archived tasks that `search` finds, by the
   * rule the app filter and REST share, built here from the rows. */
  const reference = (t: T, f: OrgFixture, projectIds: string[], search: string) =>
    t.run(async (ctx) => {
      const names = new Map(
        (await ctx.db.query('profiles').collect()).map((p) => [p.id, p.name] as const),
      )
      const labels = new Map(
        (await ctx.db.query('labels').collect()).map((l) => [l.id, l.name] as const),
      )
      const all = await ctx.db.query('issues').collect()
      const parents = new Set(all.map((row) => row.parent_id))
      const links = await ctx.db.query('issue_labels').collect()
      const found = all.filter(
        (row) =>
          row.archived_at !== undefined &&
          row.org_id === f.org.id &&
          projectIds.includes(row.project_id) &&
          matchesAllWords(
            taskSearchText({
              key: issueKey(row.num),
              title: row.title,
              description: row.description ?? '',
              status: row.status,
              group: parents.has(row.id),
              priority: row.priority,
              assigneeName: row.assignee_id === undefined ? null : names.get(row.assignee_id),
              labelNames: links
                .filter((link) => link.issue_id === row.id)
                .map((link) => labels.get(link.label_id)),
            }),
            search,
          ),
      )
      return found.map((row) => row.id)
    })

  it('searches every field of the task search rule on the server', async () => {
    const t = newT()
    const f = await withOrg(t)
    const x = await searchable(t, f)
    const family = [f.meta.id, f.sub.id, f.sub2.id]
    const cases: [string, string[]][] = [
      [issueKey(x.titled.num), [x.titled.id]],
      ['drift', [x.titled.id, x.pcb.id]],
      ['FLUX', [x.described.id, x.urgent.id]],
      // a group's status is dormant and is not searched
      ['in review', [x.reviewLeaf.id]],
      ['urgent', [x.urgent.id]],
      ['nora', [x.assigned.id]],
      ['therm', [x.labelled.id]],
      // two words may land on two fields
      ['flux urgent', [x.urgent.id]],
      ['zzz', []],
    ]
    for (const [search, ids] of cases) {
      const all = await everyPage(t, f.admin, { project_id: f.meta.id, search })
      expect(new Set(all.ids), search).toEqual(new Set(ids))
      expect(new Set(all.ids), search).toEqual(new Set(await reference(t, f, family, search)))
    }
    // blank text is no search
    const blank = await pageOf(t, f.admin, { project_id: f.meta.id, search: '   ' })
    expect(blank.rows.length).toBe((await archiveOrder(t, f.org.id, family)).length)
  })

  it('ends a search page at its scan budget and finds every match once', async () => {
    const t = newT()
    const f = await withOrg(t)
    // every 30th of 300 tasks holds the word
    const ids = await plantMany(t, f, 300, (i) => ({
      project_id: i % 2 === 0 ? f.sub.id : f.sub2.id,
      archived_at: day(1 + (i % 20)),
      title: i % 30 === 0 ? `Gasket ${i}` : `Bulk ${i}`,
    }))
    const wanted = ids.filter((_, i) => i % 30 === 0)
    ARCHIVE_PAGE.tasks = 50
    const first = await pageOf(t, f.admin, { project_id: f.meta.id, search: 'gasket' })
    expect(first.rows.length).toBeLessThan(10)
    expect(first.next_cursor).not.toBeNull()
    expect(first.scanned).toBe(50)
    const all = await everyPage(t, f.admin, { project_id: f.meta.id, search: 'gasket' })
    expect(all.ids).toHaveLength(wanted.length)
    expect(new Set(all.ids)).toEqual(new Set(wanted))
    expect(all.scanned).toBe(300)
    expect(all.sizes).toHaveLength(6)
  })

  it('loads a page and a search of 2,500 archived tasks inside one transaction', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const label = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: label,
        org_id: f.org.id,
        name: 'Hardware',
        name_lower: 'hardware',
        color: '#F0555D',
        created_at: NOW,
      })
    })
    const text = 'x'.repeat(1000)
    for (let batch = 0; batch < 5; batch++) {
      const ids = await plantMany(t, f, 500, (i) => ({
        project_id: i % 2 === 0 ? f.sub.id : f.sub2.id,
        archived_at: day(1 + ((batch * 500 + i) % 28)),
        description: text,
      }))
      await t.run(async (ctx) => {
        for (const issue_id of ids) {
          await ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id, label_id: label })
        }
      })
    }
    const first = await pageOf(t, f.admin, { project_id: f.meta.id })
    expect(first.rows).toHaveLength(100)
    expect(first.next_cursor).not.toBeNull()
    // the label matches every task, so the search reads each one's labels
    const found = await pageOf(t, f.admin, { project_id: f.meta.id, search: 'hardware' })
    expect(found.rows).toHaveLength(100)
    const missing = await pageOf(t, f.admin, { project_id: f.meta.id, search: 'hardwarez' })
    expect(missing.rows).toHaveLength(0)
    expect(missing.next_cursor).not.toBeNull()
    // the old whole-archive read passes the transaction's limits here
    await expect(
      as(t, f.admin).query(api.issues.archivedFor, {
        project_ids: [f.meta.id, f.sub.id, f.sub2.id],
      }),
    ).rejects.toThrow(/Too many index ranges/)
  }, 120_000)

  it('keeps paging in order while tasks are archived and restored', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantMany(t, f, 25, (i) => ({ project_id: f.sub.id, archived_at: day(1 + (i % 9)) }))
    const expected = (await archiveOrder(t, f.org.id, [f.sub.id])).map((row) => row.id)
    const restore = expected[10]
    let added = ''
    const all = await everyPage(t, f.admin, { project_id: f.sub.id, limit: 4 }, async (n) => {
      if (n !== 1) return
      added = (
        await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(28) })
      ).id
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', restore))
          .unique()
        if (row !== null) await ctx.db.patch(row._id, { archived_at: undefined })
      })
    })
    expect(all.ids).toEqual(expected.filter((id) => id !== restore))
    expect(all.ids).not.toContain(added)
  })

  it('answers an empty last page for a project the caller cannot see', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const project_id of [f.hidden.id, f.otherProject.id]) {
      await plantIssue(t, {
        org_id: project_id === f.hidden.id ? f.org.id : f.otherOrg.id,
        project_id,
        archived_at: day(2),
      })
    }
    const empty = { rows: [], next_cursor: null, scanned: 0 }
    // invisible, unknown, and in an organization where the caller has no seat
    expect(await pageOf(t, f.guest, { project_id: f.hidden.id })).toEqual(empty)
    expect(await pageOf(t, f.guest, { project_id: 'no-such-project' })).toEqual(empty)
    expect(await pageOf(t, f.admin, { project_id: f.otherProject.id })).toEqual(empty)
    // the other organization's own admin sees its archive
    expect((await pageOf(t, f.otherAdmin, { project_id: f.otherProject.id })).rows).toHaveLength(1)
  })

  it('never shows a hidden task in the cursor of a page that reads the whole archive', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a top-level project the guest cannot see, archived most recently
    const secret = await plantProject(t, { org_id: f.org.id, type: 'meta', key: 'SEC' })
    const hidden: Doc<'issues'>[] = []
    for (let d = 20; d <= 23; d++) {
      hidden.push(
        await plantIssue(t, { org_id: f.org.id, project_id: secret.id, archived_at: day(d) }),
      )
    }
    for (let d = 1; d <= 3; d++) {
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(d) })
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: day(d) })
    }
    // no share for opening projects one by one, so the family's pages read
    // the organization's archive and look at two tasks each
    ARCHIVE_PAGE.opening = 0
    ARCHIVE_PAGE.tasks = 2
    const first = await pageOf(t, f.guest, { project_id: f.meta.id })
    expect(first.rows).toEqual([])
    expect(first.next_cursor).toMatch(/^2~[0-9a-f]+$/)
    for (const task of hidden) {
      for (const part of [
        task._id,
        String(Math.trunc(task._creationTime)),
        task.archived_at ?? '',
      ]) {
        expect(first.next_cursor).not.toContain(part)
      }
    }
    // the pages still move past the hidden tasks and list the family's once each
    const all = await everyPage(t, f.guest, { project_id: f.meta.id })
    expect(all.ids).toEqual(
      (await archiveOrder(t, f.org.id, [f.sub.id, f.sub2.id])).map((row) => row.id),
    )
  })

  it('refuses a cursor from another project’s list', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let d = 1; d <= 3; d++) {
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(d) })
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: day(d) })
    }
    const first = await pageOf(t, f.admin, { project_id: f.sub.id, limit: 1 })
    const cursor = first.next_cursor ?? ''
    expect(cursor).toMatch(/^2~/)
    await badRequest(
      pageOf(t, f.admin, { project_id: f.sub2.id, cursor }),
      'cursor must be the next_cursor of an earlier page',
    )
    expect(
      (await pageOf(t, f.admin, { project_id: f.sub.id, cursor, limit: 1 })).rows,
    ).toHaveLength(1)
  })

  it('lists only the sub-projects a guest can see under the top-level project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const fw = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(3) })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: day(4) })
    const reader = await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: f.guest.id,
        level: 'user',
      })
      return f.guest
    })
    const { rows } = await pageOf(t, reader, { project_id: f.meta.id })
    expect(rows.map((row) => row.id)).toEqual([fw.id])
    expect((await pageOf(t, reader, { project_id: f.sub2.id })).rows).toEqual([])
  })

  it('leaves out a sub-project archived on its own under an active project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: day(1),
    })
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(2),
    })
    const left = await plantIssue(t, {
      org_id: f.org.id,
      project_id: shelved.id,
      archived_at: day(3),
    })
    const ids = (await pageOf(t, f.admin, { project_id: f.meta.id })).rows.map((row) => row.id)
    expect(ids).toEqual([kept.id])
    // named itself, it lists its own
    const own = await pageOf(t, f.admin, { project_id: shelved.id })
    expect(own.rows.map((row) => row.id)).toEqual([left.id])
    // a task stored under another organization never shows
    await plantIssue(t, { org_id: uuid(), project_id: f.sub.id, archived_at: day(9) })
    expect((await pageOf(t, f.admin, { project_id: f.sub.id })).rows.map((r) => r.id)).toEqual([
      kept.id,
    ])
  })

  it('refuses a malformed cursor or limit, and a search past its limit', async () => {
    const t = newT()
    const f = await withOrg(t)
    const project_id = f.meta.id
    // a plain position is refused too, so a caller cannot choose where a page starts
    for (const cursor of ['abc', '2~1~k1~x', '1~-1~k1~x', '', '1~5~k1~2026-03-01T09:00:00.000Z']) {
      await badRequest(
        pageOf(t, f.admin, { project_id, cursor }),
        'cursor must be the next_cursor of an earlier page',
      )
    }
    for (const limit of [0, 101, 2.5, -1]) {
      await badRequest(
        pageOf(t, f.admin, { project_id, limit }),
        'limit must be a whole number from 1 to 100',
      )
    }
    // a search counts after trimming and is refused past LIMITS.search as a rule
    const long = await expectRefusal(
      pageOf(t, f.admin, { project_id, search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(long.data.message).toBe(LIMITS.search.refusal)
    // the refusals come before the fence, the same for any project
    await badRequest(
      pageOf(t, f.guest, { project_id: f.hidden.id, limit: 0 }),
      'limit must be a whole number from 1 to 100',
    )
    const atCap = ` ${'x'.repeat(LIMITS.search.max)} `
    expect((await pageOf(t, f.admin, { project_id, search: atCap })).rows).toEqual([])
  })
})

/* ------------------------------------------------------------ archivedTask */

describe('issues.archivedTask', () => {
  /** One archivedTask call as `profile`. */
  const taskOf = (t: T, profile: Doc<'profiles'>, id: string) =>
    as(t, profile).query(api.issues.archivedTask, { id })

  it('finds an archived task that a full first search page leaves out, as the page shows it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const soak = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Soak test',
      archived_at: day(3),
    })
    // archived with it and created after it, so they come first in the archive
    for (let i = 0; i < 10; i++) {
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        title: `Soak test step ${i}`,
        archived_at: day(3),
      })
    }
    const first = await pageOf(t, f.admin, { project_id: f.sub.id, search: 'soak', limit: 10 })
    expect(first.rows.map((row) => row.id)).not.toContain(soak.id)
    const { rows } = await pageOf(t, f.admin, { project_id: f.sub.id })
    const shown = rows.find((row) => row.id === soak.id)
    expect(shown).toBeDefined()
    expect(await taskOf(t, f.admin, soak.id)).toEqual(shown)
    // a guest with a grant on the top-level project sees its sub-project's task
    expect((await taskOf(t, f.guest, soak.id))?.id).toBe(soak.id)
  })

  it('answers null for a project the caller cannot see, in their organization or another', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hidden = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      archived_at: day(2),
    })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      archived_at: day(2),
    })
    expect(await taskOf(t, f.guest, hidden.id)).toBeNull()
    // no seat in the other organization
    expect(await taskOf(t, f.admin, foreign.id)).toBeNull()
    // the same tasks, to someone who can see their projects
    expect((await taskOf(t, f.admin, hidden.id))?.id).toBe(hidden.id)
    expect((await taskOf(t, f.otherAdmin, foreign.id))?.id).toBe(foreign.id)
  })

  it('answers null for an active, a deleted or an unknown task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const deleted = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(2),
    })
    expect((await taskOf(t, f.admin, deleted.id))?.id).toBe(deleted.id)
    await as(t, f.admin).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: deleted.id })
    expect(await taskOf(t, f.admin, active.id)).toBeNull()
    expect(await taskOf(t, f.admin, deleted.id)).toBeNull()
    expect(await taskOf(t, f.admin, uuid())).toBeNull()
  })
})
