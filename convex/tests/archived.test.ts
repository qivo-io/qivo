/* The Archived tasks page's on-demand reads, outside the snapshot.
 *
 * issues.archivedPage (P.fetchArchivedPage) pages the archived tasks of a
 * scope, some projects of one organization or all of them, with a cursor
 * sealed to that scope, and searches them on the server
 * (lib/archivedTasks.ts). issues.archivedTask (P.fetchArchivedTask) finds
 * one archived task by id for the task window. Fence: can_see_project
 * through the caller's seat in the project's OWN org; an unknown or
 * invisible project answers nothing (no existence oracle). Only archived
 * rows come back. */

import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  ARCHIVE_LABELS,
  ARCHIVE_PAGE,
  ARCHIVED_SCOPE,
  archiveCursorText,
  archivedPageCore,
  archivedTaskMatcher,
  parseArchiveCursor,
} from '../lib/archivedTasks'
import { ARCHIVED_TOO_WIDE } from '../lib/core'
import type { OrgRole } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { matchesAllWords, taskSearchText } from '../lib/search'
import { issueKey } from '../lib/taskRefs'
import { insertTask } from '../model/descriptions'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  restArchivedPage,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'
import { withReach } from './projectReach.setup'

/* Archive cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts), so every page with a next cursor needs one. */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'archived-test-secret-not-a-deployment-key'

/* ------------------------------------------------------------ archivedPage */

type Page = FunctionReturnType<typeof api.issues.archivedPage>
type PageArgs = FunctionArgs<typeof api.issues.archivedPage>

/** One archivedPage call as `profile`. */
const pageOf = (t: T, profile: Doc<'profiles'>, args: PageArgs): Promise<Page> =>
  as(t, profile).query(api.issues.archivedPage, args)

/** The scope of `projectIds` in the organization `orgId`. */
const scopeOf = (orgId: string, ...projectIds: string[]) => ({
  scope: { org_id: orgId, project_ids: projectIds },
})

/** The scope of every project of the organization `orgId`. */
const allOf = (orgId: string) => ({ scope: { org_id: orgId, all: true as const } })

/** Every page of archived tasks `args` asks for as `profile`, with the ids in
 * the order they came, the page sizes and the sum of `scanned`. */
async function everyPage(
  t: T,
  profile: Doc<'profiles'>,
  args: Omit<PageArgs, 'cursor'>,
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

/** Gives the fixture's agent a grant on TBED, so REST and MCP list its
 * tasks. */
const grantAgent = (t: T, f: OrgFixture) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )

/** Makes the archived tasks `ids` active again. */
const unarchive = (t: T, ids: readonly string[]) =>
  t.run(async (ctx) => {
    for (const id of ids) {
      const row = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
      if (row !== null) await ctx.db.patch(row._id, { archived_at: undefined })
    }
  })

/** The empty last page, as for an unknown id or an empty archive. */
const EMPTY = { rows: [], next_cursor: null, scanned: 0 }

/** The answer to a scope with more projects than one page merges side by
 * side, for anyone but an organization admin. */
const TOO_WIDE = { rows: [], next_cursor: null, scanned: 0, too_wide: true }

/** A person of `f`'s organization who can sign in, with role `org_role` and
 * no grant on any project. */
async function plantPerson(t: T, f: OrgFixture, org_role: OrgRole = 'user') {
  const seat = await plantSeat(t, { org_id: f.org.id, name: 'Ungranted', org_role })
  return await plantLogin(t, seat)
}

describe('issues.archivedPage', () => {
  const page = { ...ARCHIVE_PAGE }
  const labels = { ...ARCHIVE_LABELS }
  const expansion = { ...ARCHIVED_SCOPE }
  afterEach(() => {
    Object.assign(ARCHIVE_PAGE, page)
    Object.assign(ARCHIVE_LABELS, labels)
    Object.assign(ARCHIVED_SCOPE, expansion)
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
    const one = await pageOf(t, f.admin, scopeOf(f.org.id, f.meta.id))
    expect(one.rows.map((row) => row.id)).toEqual([tieNew.id, tieOld.id, early.id])
    expect(one.next_cursor).toBeNull()
    expect(one.scanned).toBe(3)
    // a sub-project lists only its own
    const fw = await pageOf(t, f.admin, scopeOf(f.org.id, f.sub.id))
    expect(fw.rows.map((row) => row.id)).toEqual([tieOld.id, early.id])
  })

  it('pages 230 tasks over three sub-projects once each, 25 a page, across a tie of 40', async () => {
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
    const family = await everyPage(t, f.admin, scopeOf(f.org.id, f.meta.id))
    expect(family.ids).toEqual(expected)
    // the last page knows it is the last one, so no empty page follows it
    expect(family.sizes).toEqual([...Array(9).fill(25), 5])
    expect(family.scanned).toBe(230)
    // All projects reads the organization's archive and lists the same
    const all = await everyPage(t, f.admin, allOf(f.org.id))
    expect(all.ids).toEqual(expected)
    expect(all.sizes).toEqual([...Array(9).fill(25), 5])
    // a family whose size is a multiple of the limit ends on its last full
    // page, with no empty page after it
    const exact = await everyPage(t, f.admin, { ...scopeOf(f.org.id, f.meta.id), limit: 23 })
    expect(exact.sizes).toEqual(Array(10).fill(23))
    // 1 and 25 are the smallest and the largest pages
    expect((await pageOf(t, f.admin, { ...allOf(f.org.id), limit: 1 })).rows).toHaveLength(1)
    expect((await pageOf(t, f.admin, { ...allOf(f.org.id), limit: 25 })).rows).toHaveLength(25)
  })

  it('answers rows with their place, owner and Restore, without descriptions or parents', async () => {
    const t = newT()
    const f = await withOrg(t)
    const gone = await plantSeat(t, { org_id: f.org.id, name: 'Gone' })
    const group = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(5),
      description: 'a long story',
      assignee_id: f.user.id,
    })
    const kid = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: group.id,
      archived_at: day(5),
      relations_marked: true,
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
    })
    const unowned = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      archived_at: day(4),
    })
    const orphaned = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      archived_at: day(3),
      assignee_id: gone.id,
    })
    const foreign = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      archived_at: day(2),
      assignee_id: f.otherAdmin.id,
    })
    await t.run(async (ctx) => await ctx.db.delete(gone._id))
    // a task stored in a top-level project, which no write makes now
    const top = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.hidden.id,
      archived_at: day(1),
    })
    const { rows } = await pageOf(t, f.admin, scopeOf(f.org.id, f.meta.id, f.hidden.id))
    const shown = (row: Page['rows'][number]) => [
      row.id,
      row.is_group,
      row.place,
      row.owner_name,
      row.can_restore,
    ]
    const fw = { project_name: 'Firmware', parent_name: 'Testbed platform' }
    const pcb = { project_name: 'Board rev', parent_name: 'Testbed platform' }
    expect(rows.map(shown)).toEqual([
      // a group's owner is its assignee, a task in review its reviewer
      [kid.id, false, fw, 'guest', true],
      [group.id, true, fw, 'user', true],
      [unowned.id, false, pcb, null, true],
      // a profile that is gone, or of another organization, names no one
      [orphaned.id, false, pcb, null, true],
      [foreign.id, false, pcb, null, true],
      [top.id, false, { project_name: 'Skunkworks', parent_name: null }, null, true],
    ])
    for (const row of rows) {
      for (const key of ['_id', '_creationTime', 'description', 'parent_id', 'relations_marked']) {
        expect(row).not.toHaveProperty(key)
      }
      expect(row).toMatchObject({ org_id: f.org.id })
    }
    // Restore follows the caller's level: Edit (the guest's grant) and lead
    // (the project's lead) may, a Viewer may not
    const restores = async (profile: Doc<'profiles'>) =>
      (await pageOf(t, profile, scopeOf(f.org.id, f.sub.id))).rows.map((row) => row.can_restore)
    expect(await restores(f.guest)).toEqual([true, true])
    expect(await restores(f.user)).toEqual([true, true])
    expect(await restores(f.viewer)).toEqual([false, false])
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

  it('searches every field of the task search rule, as REST does, with either label read', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grantAgent(t, f)
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
    const rest = async (search: string) =>
      (
        await restArchivedPage(t, {
          callerId: f.agent.id,
          access: 'read',
          project: 'TBED',
          search,
        })
      ).tasks.map((task) => task.id)
    // the organization's labels read at once, then each task's own by id
    for (const scan of [1000, 0]) {
      ARCHIVE_LABELS.scan = scan
      for (const [search, ids] of cases) {
        const all = await everyPage(t, f.admin, { ...scopeOf(f.org.id, f.meta.id), search })
        expect(new Set(all.ids), `${search} ${scan}`).toEqual(new Set(ids))
        expect(new Set(all.ids), search).toEqual(new Set(await reference(t, f, family, search)))
        expect(new Set(await rest(search)), search).toEqual(new Set(ids))
      }
    }
    // blank text is no search
    const blank = await pageOf(t, f.admin, { ...scopeOf(f.org.id, f.meta.id), search: '   ' })
    expect(blank.rows.length).toBe((await archiveOrder(t, f.org.id, family)).length)
  })

  it('keeps label names in the organization’s order for REST’s wildcard, with either label read', async () => {
    const t = newT()
    const f = await withOrg(t)
    const label = async (name: string) => {
      const id = uuid()
      await t.run(async (ctx) => {
        await ctx.db.insert('labels', {
          id,
          org_id: f.org.id,
          name,
          name_lower: name.toLowerCase(),
          color: '#F0555D',
          created_at: NOW,
        })
      })
      return id
    }
    await grantAgent(t, f)
    const alpha = await label('Alpha')
    const beta = await label('Beta')
    const both = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(2),
    })
    await t.run(async (ctx) => {
      // assigned in the other order, which the task's own read follows
      for (const label_id of [beta, alpha])
        await ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id: both.id, label_id })
    })
    const rest = async (search: string) =>
      (
        await restArchivedPage(t, { callerId: f.agent.id, access: 'read', project: 'FW', search })
      ).tasks.map((task) => task.id)
    for (const scan of [1000, 0]) {
      ARCHIVE_LABELS.scan = scan
      expect(await rest('alp*bet'), String(scan)).toEqual([both.id])
      expect(await rest('bet*alp'), String(scan)).toEqual([])
    }
  })

  it('reads only the profiles of the tasks a search judges, and each task’s labels past the scan', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 3,000 people and 150 labels, past a scan lowered to 100
    const people = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 3000; i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: i === 2900 ? 'Quentin Marsh' : `Person ${i}`,
          initials: 'PP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
      }
      return ids
    })
    const labelIds = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 150; i++) {
        const id = uuid()
        ids.push(id)
        const name = i === 120 ? 'Zeta cooling' : `Label ${i}`
        await ctx.db.insert('labels', {
          id,
          org_id: f.org.id,
          name,
          name_lower: name.toLowerCase(),
          color: '#F0555D',
          created_at: NOW,
        })
      }
      return ids
    })
    const ids = await plantMany(t, f, 30, (i) => ({
      project_id: f.sub.id,
      archived_at: day(1 + i),
      assignee_id: people[i * 100],
    }))
    await t.run(async (ctx) => {
      for (const [i, issue_id] of ids.entries())
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id,
          label_id: labelIds[i === 7 ? 120 : i],
        })
    })
    /** The page of the search `search` and the documents it read. */
    const measured = (search: string) =>
      t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const found = await archivedPageCore(
          ctx,
          f.admin,
          { kind: 'projects', orgId: f.org.id, projectIds: [f.sub.id] },
          { cursor: null, search, limit: 25 },
        )
        const after = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        return { ids: found.rows.map((row) => row.id), next: found.next, read: after - before }
      })
    ARCHIVE_LABELS.scan = 100
    const byTask = await measured('zeta')
    expect(byTask.ids).toEqual([ids[7]])
    expect(byTask.next).toBeNull()
    // the scan's 101 labels, which tells it there are more, then 30 tasks,
    // their 30 assignees, one label row and one label each, and the project:
    // never the roster or every label
    expect(byTask.read).toBeLessThan(101 + 150)
    // an assignee's name finds its task through that one profile
    expect((await measured('quentin')).ids).toEqual([ids[29]])
    ARCHIVE_LABELS.scan = 1000
    const scanned = await measured('zeta')
    expect(scanned.ids).toEqual([ids[7]])
    // the 150 labels once, then the label rows of tasks that might hold one
    expect(scanned.read).toBeGreaterThanOrEqual(150)
    expect(scanned.read).toBeLessThan(150 + 200)
  })

  it('reads 1,000 labels at the longest names in one range, under 300 KiB', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < ARCHIVE_LABELS.scan; i++) {
        const name = `${String(i).padStart(4, '0')} ${'w'.repeat(LIMITS.labelName.max - 5)}`
        await ctx.db.insert('labels', {
          id: uuid(),
          org_id: f.org.id,
          name,
          name_lower: name.toLowerCase(),
          color: '#F0555D',
          created_at: NOW,
        })
      }
    })
    const cost = await t.run(async (ctx) => {
      const before = await ctx.meta.getTransactionMetrics()
      await archivedTaskMatcher(ctx, f.org.id, 'www', {
        stars: false,
        nameOf: async () => undefined,
      })
      const after = await ctx.meta.getTransactionMetrics()
      return {
        ranges: after.databaseQueries.used - before.databaseQueries.used,
        documents: after.documentsRead.used - before.documentsRead.used,
        bytes: after.bytesRead.used - before.bytesRead.used,
      }
    })
    expect(cost.ranges).toBe(1)
    expect(cost.documents).toBe(ARCHIVE_LABELS.scan)
    expect(cost.bytes).toBeLessThan(300 * 1024)
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
    const scope = scopeOf(f.org.id, f.meta.id)
    const first = await pageOf(t, f.admin, { ...scope, search: 'gasket' })
    expect(first.rows.length).toBeLessThan(10)
    expect(first.next_cursor).not.toBeNull()
    expect(first.scanned).toBe(50)
    const all = await everyPage(t, f.admin, { ...scope, search: 'gasket' })
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
    const scope = scopeOf(f.org.id, f.meta.id)
    const first = await pageOf(t, f.admin, { ...scope, limit: 25 })
    expect(first.rows).toHaveLength(25)
    expect(first.next_cursor).not.toBeNull()
    // the label matches every task, so the search reads each one's labels
    const found = await pageOf(t, f.admin, { ...scope, search: 'hardware' })
    expect(found.rows).toHaveLength(25)
    const missing = await pageOf(t, f.admin, { ...allOf(f.org.id), search: 'hardwarez' })
    expect(missing.rows).toHaveLength(0)
    expect(missing.next_cursor).not.toBeNull()
  }, 120_000)

  it('keeps paging in order while tasks are archived and restored', async () => {
    for (const scopeFor of [
      (f: OrgFixture) => scopeOf(f.org.id, f.sub.id),
      (f: OrgFixture) => allOf(f.org.id),
    ]) {
      const t = newT()
      const f = await withOrg(t)
      await plantMany(t, f, 25, (i) => ({ project_id: f.sub.id, archived_at: day(1 + (i % 9)) }))
      const expected = (await archiveOrder(t, f.org.id, [f.sub.id])).map((row) => row.id)
      const restore = expected[10]
      let added = ''
      const all = await everyPage(t, f.admin, { ...scopeFor(f), limit: 4 }, async (n) => {
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
    }
  })

  it('answers an empty last page alike for ids the caller cannot see, and without a seat', async () => {
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
    // invisible, unknown, of another organization, and an organization where
    // the caller has no seat
    for (const [profile, args] of [
      [f.guest, scopeOf(f.org.id, f.hidden.id)],
      [f.guest, scopeOf(f.org.id, 'no-such-project')],
      [f.guest, scopeOf(f.org.id, f.hidden.id, 'no-such-project')],
      [f.admin, scopeOf(f.org.id, f.otherProject.id)],
      [f.admin, scopeOf(f.otherOrg.id, f.otherProject.id)],
      [f.admin, allOf(f.otherOrg.id)],
      [f.admin, allOf('no-such-organization')],
    ] as const) {
      expect(await pageOf(t, profile, args), JSON.stringify(args)).toEqual(empty)
    }
    // the other organization's own admin sees its archive
    for (const args of [scopeOf(f.otherOrg.id, f.otherProject.id), allOf(f.otherOrg.id)])
      expect((await pageOf(t, f.otherAdmin, args)).rows).toHaveLength(1)
  })

  it('never shows an out-of-scope task in the cursor of an admin page that reads the whole archive', async () => {
    const t = newT()
    const f = await withOrg(t)
    // an archived top-level project, whose tasks the page leaves out, archived most recently
    const secret = await plantProject(t, {
      org_id: f.org.id,
      type: 'meta',
      key: 'SEC',
      archived_at: day(19),
    })
    const secretSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: secret.id,
      archived_at: day(19),
    })
    const shelved: Doc<'issues'>[] = []
    for (let d = 20; d <= 23; d++) {
      shelved.push(
        await plantIssue(t, { org_id: f.org.id, project_id: secretSub.id, archived_at: day(d) }),
      )
    }
    for (let d = 1; d <= 3; d++) {
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(d) })
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: day(d) })
    }
    const listed = (await archiveOrder(t, f.org.id, [f.sub.id, f.sub2.id])).map((row) => row.id)
    // no share for opening projects one by one, so an admin's family pages
    // read the organization's archive, as All projects does for an admin,
    // and a budget of one document ends each page after its first task
    ARCHIVE_PAGE.opening = 0
    ARCHIVE_PAGE.documents = 1
    for (const scope of [scopeOf(f.org.id, f.meta.id), allOf(f.org.id)]) {
      const first = await pageOf(t, f.admin, scope)
      // the budget ran out on a task outside the scope: no rows, none counted, more to read
      expect(first.rows).toEqual([])
      expect(first.scanned).toBe(0)
      expect(first.next_cursor).toMatch(/^3~[0-9a-f]+$/)
      for (const task of shelved) {
        for (const part of [
          task._id,
          String(Math.trunc(task._creationTime)),
          task.archived_at ?? '',
        ]) {
          expect(first.next_cursor).not.toContain(part)
        }
      }
      // the pages still move past them and list the family's once each
      const all = await everyPage(t, f.admin, scope)
      expect(all.ids).toEqual(listed)
      expect(all.scanned).toBe(listed.length)
    }
    // a guest's page reads only their own projects, which do not fit that
    // budget side by side, so it is refused
    expect(await pageOf(t, f.guest, scopeOf(f.org.id, f.meta.id))).toEqual(TOO_WIDE)
  })

  it('refuses a cursor from another scope, organization, kind or version', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let d = 1; d <= 3; d++) {
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(d) })
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: day(d) })
    }
    const sentence = 'cursor must be the next_cursor of an earlier page'
    const fwOnly = scopeOf(f.org.id, f.sub.id)
    const first = await pageOf(t, f.admin, { ...fwOnly, limit: 1 })
    const cursor = first.next_cursor ?? ''
    expect(cursor).toMatch(/^3~/)
    for (const args of [
      scopeOf(f.org.id, f.sub2.id),
      scopeOf(f.org.id, f.sub.id, f.sub2.id),
      allOf(f.org.id),
      scopeOf(f.otherOrg.id, f.sub.id),
    ]) {
      await badRequest(pageOf(t, f.admin, { ...args, cursor }), sentence)
    }
    // the same ids in another order, or repeated, are the same scope
    for (const args of [fwOnly, scopeOf(f.org.id, f.sub.id, f.sub.id)])
      expect((await pageOf(t, f.admin, { ...args, cursor, limit: 1 })).rows).toHaveLength(1)
    const both = await pageOf(t, f.admin, { ...scopeOf(f.org.id, f.sub.id, f.sub2.id), limit: 1 })
    const swapped = scopeOf(f.org.id, f.sub2.id, f.sub.id)
    expect(
      (await pageOf(t, f.admin, { ...swapped, cursor: both.next_cursor ?? '', limit: 1 })).rows,
    ).toHaveLength(1)
    // an All projects cursor opens only for All projects of its organization
    const all = await pageOf(t, f.admin, { ...allOf(f.org.id), limit: 1 })
    await badRequest(pageOf(t, f.admin, { ...fwOnly, cursor: all.next_cursor ?? '' }), sentence)
    await badRequest(
      pageOf(t, f.admin, { ...allOf(f.otherOrg.id), cursor: all.next_cursor ?? '' }),
      sentence,
    )
    // a `2~` cursor of REST and MCP archived lists opens for no scope
    const position = { created: 1, id: 'k1', archived_at: day(1) }
    const old = await archiveCursorText(position, f.sub.id)
    expect(await parseArchiveCursor(old, f.sub.id)).toEqual(position)
    await badRequest(pageOf(t, f.admin, { ...fwOnly, cursor: old }), sentence)
    // a `3~` cursor sealed around a `2~` cursor's text opens for neither
    expect(await parseArchiveCursor(`2~${cursor.slice(2)}`, f.sub.id)).toBeNull()
    await badRequest(pageOf(t, f.admin, { ...fwOnly, cursor: `3~${old.slice(2)}` }), sentence)
  })

  it('merges named projects of different families in archive order, each id once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const other = await plantProject(t, { org_id: f.org.id, type: 'meta' })
    const otherSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: other.id,
    })
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'meta',
      archived_at: day(1),
    })
    const shelvedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: shelved.id,
      archived_at: day(1),
    })
    for (let d = 1; d <= 6; d++) {
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: d % 2 ? f.sub.id : otherSub.id,
        archived_at: day(d),
      })
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: day(d) })
      await plantIssue(t, { org_id: f.org.id, project_id: shelvedSub.id, archived_at: day(d) })
    }
    const named = await everyPage(t, f.admin, {
      ...scopeOf(f.org.id, f.sub.id, otherSub.id, f.sub.id, shelved.id, shelvedSub.id),
      limit: 4,
    })
    expect(named.ids).toEqual(
      (await archiveOrder(t, f.org.id, [f.sub.id, otherSub.id])).map((row) => row.id),
    )
    // a top-level id stands for its live sub-projects
    const families = await everyPage(t, f.admin, scopeOf(f.org.id, f.meta.id, other.id))
    expect(families.ids).toEqual(
      (await archiveOrder(t, f.org.id, [f.sub.id, f.sub2.id, otherSub.id])).map((row) => row.id),
    )
  })

  it('refuses a family past its sub-project bound for anyone but an admin, who reads it whole', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest sees FW and PCB, not this third sub-project of TBED
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const doc = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: doc.id,
        profile_id: f.guest.id,
        level: 'viewer',
      })
    })
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: day(1),
    })
    const other = await plantProject(t, { org_id: f.org.id, type: 'meta' })
    const otherSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: other.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: otherSub.id,
        profile_id: f.guest.id,
        level: 'user',
      })
    })
    // the guest sees TBED only to reach their sub-projects, through their reach rows
    await withReach(t)
    const projects = [f.sub.id, f.sub2.id, sibling.id, doc.id, shelved.id, otherSub.id, f.hidden.id]
    await plantMany(t, f, 70, (i) => ({
      project_id: projects[i % projects.length],
      archived_at: day(1 + (i % 25)),
    }))
    const order = async (ids: string[]) =>
      (await archiveOrder(t, f.org.id, ids)).map((row) => row.id)
    const scope = scopeOf(f.org.id, f.meta.id)
    // within the bound the guest's visible sub-projects merge one by one
    expect((await everyPage(t, f.guest, scope)).ids).toEqual(
      await order([f.sub.id, f.sub2.id, doc.id]),
    )
    // past it a guest's page would have to read projects they cannot see
    ARCHIVED_SCOPE.subProjects = 2
    expect(await pageOf(t, f.guest, scope)).toEqual(TOO_WIDE)
    expect(await pageOf(t, f.guest, scopeOf(f.org.id, f.meta.id, otherSub.id))).toEqual(TOO_WIDE)
    // a narrower scope still lists
    expect((await everyPage(t, f.guest, scopeOf(f.org.id, otherSub.id))).ids).toEqual(
      await order([otherSub.id]),
    )
    // an admin, who sees every project, reads the organization's archive past it
    const admin = await everyPage(t, f.admin, { ...scope, limit: 5 })
    const live = await order([f.sub.id, f.sub2.id, sibling.id, doc.id])
    expect(admin.ids).toEqual(live)
    expect(admin.scanned).toBe(live.length)
  })

  it('lists for All projects every archived task of the live projects the caller sees, only', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ungranted = await plantPerson(t, f)
    const shelvedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: day(1),
    })
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'meta',
      archived_at: day(1),
    })
    const underShelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: shelved.id,
      archived_at: day(1),
    })
    const skunkSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const projects = [f.sub.id, f.sub2.id, shelvedSub.id, underShelved.id, skunkSub.id]
    await plantMany(t, f, 40, (i) => ({
      project_id: projects[i % projects.length],
      archived_at: day(1 + (i % 20)),
    }))
    await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      archived_at: day(25),
    })
    const order = async (ids: string[]) =>
      (await archiveOrder(t, f.org.id, ids)).map((row) => row.id)
    const scope = allOf(f.org.id)
    for (const ready of [false, true]) {
      if (ready) await withReach(t)
      // an admin sees every live project, Skunkworks too, through the organization's archive
      expect((await everyPage(t, f.admin, scope)).ids).toEqual(
        await order([f.sub.id, f.sub2.id, skunkSub.id]),
      )
      if (!ready) {
        // without complete reach rows no one else's projects can be found
        expect(await pageOf(t, f.guest, scope)).toEqual(TOO_WIDE)
        expect(await pageOf(t, ungranted, scope)).toEqual(TOO_WIDE)
        continue
      }
      // a guest sees TBED's sub-projects through their grant
      expect((await everyPage(t, f.guest, scope)).ids).toEqual(await order([f.sub.id, f.sub2.id]))
      // a member without a grant sees none
      expect(await pageOf(t, ungranted, scope)).toEqual(EMPTY)
    }
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
    await withReach(t)
    const { rows } = await pageOf(t, reader, scopeOf(f.org.id, f.meta.id))
    expect(rows.map((row) => row.id)).toEqual([fw.id])
    expect((await pageOf(t, reader, scopeOf(f.org.id, f.sub2.id))).rows).toEqual([])
    expect((await pageOf(t, reader, allOf(f.org.id))).rows.map((row) => row.id)).toEqual([fw.id])
  })

  it('answers a member, a Viewer and a guest alike with or without archived tasks they cannot see', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a member with a grant on TBED, in the Hardware team; the Viewer and
    // the guest hold grants on TBED too
    const member = await plantPerson(t, f)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: member.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: member.id,
        is_leader: false,
      })
    })
    // Skunkworks, led by the user, holds what none of them sees
    const skunkSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    await withReach(t)
    await plantMany(t, f, 9, (i) => ({
      project_id: i % 2 ? f.sub.id : f.sub2.id,
      archived_at: day(3 + 2 * i),
    }))
    const visible = (await archiveOrder(t, f.org.id, [f.sub.id, f.sub2.id])).map((row) => row.id)
    // a budget that a few dozen hidden tasks read would exhaust
    ARCHIVE_PAGE.documents = 40
    const callers = { member, viewer: f.viewer, guest: f.guest }
    type Pages = (string[] | boolean | number)[][] | string
    /** Every page of the app's list as `profile` sees it: rows, whether
     * more follow and scanned, or the refusal. */
    const appPages = async (profile: Doc<'profiles'>, args: PageArgs): Promise<Pages> => {
      const pages = []
      let cursor: string | undefined
      do {
        const page = await pageOf(t, profile, { ...args, cursor, limit: 4 })
        if (page.too_wide) return 'too wide'
        pages.push([page.rows.map((row) => row.id), page.next_cursor !== null, page.scanned])
        cursor = page.next_cursor ?? undefined
      } while (cursor !== undefined)
      return pages
    }
    /** Every page of TBED's archived tasks over REST or MCP: rows and
     * whether more follow, or the refusal. */
    const machinePages = async (callerId: string, surface: 'rest' | 'mcp'): Promise<Pages> => {
      const pages = []
      let cursor: string | undefined
      try {
        do {
          const page: { tasks: { id: string }[]; next_cursor: string | null } =
            surface === 'rest'
              ? await restArchivedPage(t, {
                  callerId,
                  access: 'read',
                  project: 'TBED',
                  limit: '4',
                  cursor,
                })
              : JSON.parse(
                  await t.query(internal.machine.mcp.listIssues, {
                    callerId,
                    access: 'read',
                    today: TODAY,
                    project: 'TBED',
                    archived: true,
                    limit: 4,
                    ...(cursor ? { cursor } : {}),
                  }),
                )
          pages.push([page.tasks.map((task) => task.id), page.next_cursor !== null])
          cursor = page.next_cursor ?? undefined
        } while (cursor !== undefined)
      } catch (e) {
        return `refused: ${(e as { data?: Refusal }).data?.message}`
      }
      return pages
    }
    /** What each of them sees on each surface, as the bounds and the reach rows stand. */
    const lists = async () => {
      const out: Record<string, Record<string, Pages>> = {}
      for (const [who, caller] of Object.entries(callers))
        out[who] = {
          all: await appPages(caller, allOf(f.org.id)),
          family: await appPages(caller, scopeOf(f.org.id, f.meta.id)),
          rest: await machinePages(caller.id, 'rest'),
          mcp: await machinePages(caller.id, 'mcp'),
        }
      return out
    }
    const stamp = (name_keys_at: string | undefined) =>
      t.run(async (ctx) => {
        for (const row of await ctx.db.query('org_ready').collect())
          await ctx.db.patch(row._id, { name_keys_at })
      })
    /** The lists merged, past the sub-project bound, past the team bound
     * and while the reach rows are not complete. */
    const settings = async () => {
      const merged = await lists()
      ARCHIVED_SCOPE.subProjects = 1
      const wide = await lists()
      ARCHIVED_SCOPE.subProjects = expansion.subProjects
      ARCHIVED_SCOPE.teams = 0
      const teams = await lists()
      ARCHIVED_SCOPE.teams = expansion.teams
      await stamp(undefined)
      const unready = await lists()
      await stamp(NOW)
      return { merged, wide, teams, unready }
    }
    const without = await settings()
    const ids = (pages: Pages) =>
      typeof pages === 'string' ? pages : pages.flatMap((page) => page[0] as string[])
    for (const who of Object.keys(callers))
      for (const list of ['all', 'family', 'rest', 'mcp'])
        expect(ids(without.merged[who][list]), `${who} ${list}`).toEqual(visible)
    // past the bound every list is refused, past the team bound only the
    // member's All projects, and before the reach rows every All projects
    const machineRefusal = `refused: ${ARCHIVED_TOO_WIDE}`
    for (const who of Object.keys(callers))
      expect(without.wide[who], who).toEqual({
        all: 'too wide',
        family: 'too wide',
        rest: machineRefusal,
        mcp: machineRefusal,
      })
    expect(without.teams.member.all).toBe('too wide')
    expect(ids(without.teams.guest.all)).toEqual(visible)
    for (const who of Object.keys(callers)) {
      expect(without.unready[who].all, who).toBe('too wide')
      expect(ids(without.unready[who].family), who).toEqual(visible)
    }
    // (i) one hidden archived task older than every task they see
    const older = await plantMany(t, f, 1, () => ({ project_id: skunkSub.id, archived_at: day(1) }))
    expect(await settings()).toEqual(without)
    // (ii) 60 hidden archived tasks newer than every task they see, more
    // than the budget would read
    await unarchive(t, older)
    const newer = await plantMany(t, f, 60, () => ({
      project_id: skunkSub.id,
      archived_at: day(25),
    }))
    expect(await settings()).toEqual(without)
    // an admin reaches every archived task, the hidden ones too, through
    // the organization's archive
    ARCHIVE_PAGE.documents = page.documents
    expect(new Set((await everyPage(t, f.admin, allOf(f.org.id))).ids)).toEqual(
      new Set([...visible, ...newer]),
    )
  })

  it('answers a family the caller cannot see past the bound as it answers an unknown id', async () => {
    const t = newT()
    const f = await withOrg(t)
    // Skunkworks gets three sub-projects, none of which the guest can see
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 3; i++)
      subs.push(
        await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.hidden.id }),
      )
    await withReach(t)
    await plantMany(t, f, 9, (i) => ({ project_id: subs[i % 3].id, archived_at: day(1 + i) }))
    ARCHIVED_SCOPE.subProjects = 2
    // a read of the organization's archive would end after one task, with more to read
    ARCHIVE_PAGE.documents = 1
    expect(await pageOf(t, f.guest, scopeOf(f.org.id, f.hidden.id))).toEqual(EMPTY)
    expect(await pageOf(t, f.guest, scopeOf(f.org.id, uuid()))).toEqual(EMPTY)
    // its lead sees it, so past the bound they are told to choose a sub-project
    expect(await pageOf(t, f.user, scopeOf(f.org.id, f.hidden.id))).toEqual(TOO_WIDE)
    // an admin reads it through the organization's archive
    expect((await everyPage(t, f.admin, scopeOf(f.org.id, f.hidden.id))).ids).toHaveLength(9)
  })

  it('counts only live sub-projects toward the bound, with or without their archive state', async () => {
    const t = newT()
    const f = await withOrg(t)
    // five archived sub-projects beside TBED's two live ones
    for (let i = 0; i < 5; i++)
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.meta.id,
        archived_at: day(1),
      })
    const other = await plantProject(t, { org_id: f.org.id, type: 'meta' })
    const otherSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: other.id,
    })
    // 60 newer archived tasks outside the scope, which only a read of the
    // organization's archive passes
    await plantMany(t, f, 60, () => ({ project_id: otherSub.id, archived_at: day(20) }))
    const kept = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(2),
    })
    ARCHIVED_SCOPE.subProjects = 2
    const read = () =>
      t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const page = await archivedPageCore(
          ctx,
          f.admin,
          { kind: 'projects', orgId: f.org.id, projectIds: [f.meta.id] },
          { cursor: null, search: '', limit: 1 },
        )
        const after = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        return { ids: page.rows.map((row) => row.id), read: after - before }
      })
    // before the backfill wrote archive states, and after
    for (const ready of [false, true]) {
      if (ready) await withReach(t)
      const page = await read()
      expect(page.ids).toEqual([kept.id])
      // TBED's two live sub-projects merge side by side, reading none of the 60
      expect(page.read).toBeLessThan(40)
    }
  })

  it('answers Restore and owners on All projects for a Viewer and a guest, and past the bound for an admin', async () => {
    const t = newT()
    const f = await withOrg(t)
    await withReach(t)
    const owned = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(3),
      assignee_id: f.user.id,
    })
    const reviewed = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      archived_at: day(2),
      status: 'review',
      assignee_id: f.user.id,
      reviewer_id: f.guest.id,
    })
    const shown = (page: Page) => page.rows.map((row) => [row.id, row.owner_name, row.can_restore])
    for (const scope of [allOf(f.org.id), scopeOf(f.org.id, f.meta.id)]) {
      // a Viewer may not restore, a guest with Edit may
      expect(shown(await pageOf(t, f.viewer, scope))).toEqual([
        [owned.id, 'user', false],
        [reviewed.id, 'guest', false],
      ])
      expect(shown(await pageOf(t, f.guest, scope))).toEqual([
        [owned.id, 'user', true],
        [reviewed.id, 'guest', true],
      ])
    }
    // past the bound only an admin's page lists, through the organization's archive
    ARCHIVED_SCOPE.subProjects = 1
    for (const scope of [allOf(f.org.id), scopeOf(f.org.id, f.meta.id)]) {
      expect(await pageOf(t, f.viewer, scope)).toEqual(TOO_WIDE)
      expect(shown(await pageOf(t, f.admin, scope))).toEqual([
        [owned.id, 'user', true],
        [reviewed.id, 'guest', true],
      ])
    }
  })

  it('leaves out a task stored in a top-level project its caller sees only to reach a sub-project', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest's grant moves from TBED onto FW
    await t.run(async (ctx) => {
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
    })
    await withReach(t)
    // a task stored in TBED itself, which no write makes now
    const inTop = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.meta.id,
      archived_at: day(5),
    })
    const fw = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(3) })
    const scopes = [
      allOf(f.org.id),
      scopeOf(f.org.id, f.meta.id),
      scopeOf(f.org.id, f.meta.id, f.sub.id),
    ]
    for (const scope of scopes)
      expect((await everyPage(t, f.guest, scope)).ids, JSON.stringify(scope)).toEqual([fw.id])
    // past the bound the guest is refused, and the admin sees both
    ARCHIVED_SCOPE.subProjects = 0
    for (const scope of scopes) expect(await pageOf(t, f.guest, scope)).toEqual(TOO_WIDE)
    for (const bound of [200, 0]) {
      ARCHIVED_SCOPE.subProjects = bound
      expect((await everyPage(t, f.admin, allOf(f.org.id))).ids).toEqual([inTop.id, fw.id])
    }
  })

  it('counts every reach row it reads toward its bound, navigation-only and repeated ones too', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest's grant moves from TBED onto FW, and they get one on a sub-project
    // of another top-level project: two root rows for navigation only and two child rows
    const other = await plantProject(t, { org_id: f.org.id, type: 'meta' })
    const otherSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: other.id,
    })
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
      for (const project_id of [f.sub.id, otherSub.id])
        await ctx.db.insert('project_access', { project_id, profile_id: f.guest.id, level: 'user' })
    })
    await withReach(t)
    const fw = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: day(3) })
    const away = await plantIssue(t, {
      org_id: f.org.id,
      project_id: otherSub.id,
      archived_at: day(4),
    })
    // four rows find two projects
    ARCHIVED_SCOPE.rows = 4
    expect((await everyPage(t, f.guest, allOf(f.org.id))).ids).toEqual([away.id, fw.id])
    ARCHIVED_SCOPE.rows = 3
    expect(await pageOf(t, f.guest, allOf(f.org.id))).toEqual(TOO_WIDE)
    // under TBED, which the guest sees only to reach FW, one child row
    ARCHIVED_SCOPE.rows = 1
    expect((await everyPage(t, f.guest, scopeOf(f.org.id, f.meta.id))).ids).toEqual([fw.id])
    ARCHIVED_SCOPE.rows = 0
    expect(await pageOf(t, f.guest, scopeOf(f.org.id, f.meta.id))).toEqual(TOO_WIDE)
    // and the two live sub-projects of a top-level project the caller holds access on
    ARCHIVED_SCOPE.rows = 1
    expect(await pageOf(t, f.viewer, scopeOf(f.org.id, f.meta.id))).toEqual(TOO_WIDE)
    ARCHIVED_SCOPE.rows = 2
    expect(await pageOf(t, f.viewer, scopeOf(f.org.id, f.meta.id))).toMatchObject({
      next_cursor: null,
    })
  })

  it('counts a project once toward the bound when the seat and a team both reach it', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a member with grants of their own on FW and PCB, in the Hardware team,
    // which gets a share on TBED: the seat's child rows come before the
    // team's root row, whose family holds FW and PCB again
    const member = await plantPerson(t, f)
    await t.run(async (ctx) => {
      for (const project_id of [f.sub.id, f.sub2.id])
        await ctx.db.insert('project_access', { project_id, profile_id: member.id, level: 'user' })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: member.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await withReach(t)
    await plantMany(t, f, 4, (i) => ({
      project_id: i % 2 ? f.sub.id : f.sub2.id,
      archived_at: day(1 + i),
    }))
    const listed = (await archiveOrder(t, f.org.id, [f.sub.id, f.sub2.id])).map((row) => row.id)
    // TBED, FW and PCB are three projects
    ARCHIVED_SCOPE.subProjects = 3
    expect((await everyPage(t, member, allOf(f.org.id))).ids).toEqual(listed)
    ARCHIVED_SCOPE.subProjects = 2
    expect(await pageOf(t, member, allOf(f.org.id))).toEqual(TOO_WIDE)
  })

  it('refuses a scope whose projects’ newest tasks at the longest text do not fit one page side by side', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 199 more sub-projects of TBED, 200 projects with TBED itself, the most a page merges
    const subs = [f.sub.id, f.sub2.id]
    await t.run(async (ctx) => {
      for (let i = 0; i < 197; i++) {
        const id = uuid()
        subs.push(id)
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: f.meta.id,
          key: `S${i}`,
          name: `Sub ${i}`,
          description: '',
          sort_order: i,
          num: 1000 + i,
          track_delay: false,
          created_at: NOW,
        })
      }
    })
    // each holds one archived task at the description cap in a three-byte
    // script, on the task row and on its description row, as release 2 stores it
    const text = '漢'.repeat(LIMITS.description.max)
    const tasks: string[] = []
    for (let batch = 0; batch < subs.length; batch += 25) {
      await t.run(async (ctx) => {
        for (const [i, project_id] of subs.slice(batch, batch + 25).entries()) {
          const id = uuid()
          tasks.push(id)
          await insertTask(
            ctx.db,
            {
              id,
              org_id: f.org.id,
              project_id,
              num: bulkNum++,
              title: `Long ${batch + i}`,
              description: text,
              status: 'done',
              priority: 'medium',
              paused: false,
              created_at: NOW,
              updated_at: NOW,
              archived_at: day(1 + ((batch + i) % 28)),
            },
            'restore',
          )
        }
      })
    }
    /** The guest's first page of TBED, and what the request read. */
    const measured = () =>
      t.run(async (ctx) => {
        const found = await archivedPageCore(
          ctx,
          f.guest,
          { kind: 'projects', orgId: f.org.id, projectIds: [f.meta.id] },
          { cursor: null, search: '', limit: 25 },
        )
        const m = await ctx.meta.getTransactionMetrics()
        return {
          rows: found.rows.length,
          tooWide: found.tooWide === true,
          ranges: m.databaseQueries.used,
          documents: m.documentsRead.used,
          bytes: m.bytesRead.used,
        }
      })
    const full = await measured()
    // 200 newest tasks of about 61 KB pass the page's 8 MiB, so the page is refused
    expect(full.tooWide).toBe(true)
    expect(full.bytes).toBeLessThan(16 << 20)
    // with 120 of them archived it opens them side by side and lists
    await unarchive(t, tasks.slice(120))
    const fits = await measured()
    console.info('archived projects side by side', { full, fits })
    expect(fits).toMatchObject({ rows: 25, tooWide: false })
  }, 300_000)

  it('answers each organization of a login with two seats through its seat there', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the user also holds a guest seat in Other, with Viewer on one of two sub-projects
    const away = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const elsewhere = await plantProject(t, {
      org_id: f.otherOrg.id,
      type: 'project',
      parent_id: f.otherProject.id,
    })
    const seat = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'user',
      org_role: 'guest',
      auth_user_id: f.user.auth_user_id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: away.id,
        profile_id: seat.id,
        level: 'viewer',
      })
    })
    await withReach(t)
    const home = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: day(2),
      assignee_id: f.user.id,
    })
    const there = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: away.id,
      archived_at: day(3),
      assignee_id: f.otherAdmin.id,
    })
    await plantIssue(t, { org_id: f.otherOrg.id, project_id: elsewhere.id, archived_at: day(4) })
    const shown = (page: Page) => page.rows.map((row) => [row.id, row.owner_name, row.can_restore])
    // the lead of TBED at home, a Viewer guest in Other
    expect(shown(await pageOf(t, f.user, allOf(f.org.id)))).toEqual([[home.id, 'user', true]])
    expect(shown(await pageOf(t, f.user, allOf(f.otherOrg.id)))).toEqual([
      [there.id, 'otherAdmin', false],
    ])
    expect(shown(await pageOf(t, f.user, scopeOf(f.otherOrg.id, f.otherProject.id)))).toEqual([
      [there.id, 'otherAdmin', false],
    ])
    // a project of Other named in a scope of the home organization answers nothing
    expect(await pageOf(t, f.user, scopeOf(f.org.id, away.id))).toEqual(EMPTY)
  })

  it('leaves out a sub-project archived on its own', async () => {
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
    await plantIssue(t, { org_id: f.org.id, project_id: shelved.id, archived_at: day(3) })
    const ids = async (args: PageArgs) => (await pageOf(t, f.admin, args)).rows.map((row) => row.id)
    expect(await ids(scopeOf(f.org.id, f.meta.id))).toEqual([kept.id])
    expect(await ids(allOf(f.org.id))).toEqual([kept.id])
    // named itself, an archived project drops out like an invisible one
    expect(await ids(scopeOf(f.org.id, shelved.id))).toEqual([])
    // a task stored under another organization never shows
    await plantIssue(t, { org_id: uuid(), project_id: f.sub.id, archived_at: day(9) })
    expect(await ids(scopeOf(f.org.id, f.sub.id))).toEqual([kept.id])
    expect(await ids(allOf(f.org.id))).toEqual([kept.id])
  })

  it('refuses a malformed cursor or limit, and a search past its limit', async () => {
    const t = newT()
    const f = await withOrg(t)
    const scope = scopeOf(f.org.id, f.meta.id)
    // a plain position is refused too, so a caller cannot choose where a page starts
    for (const cursor of [
      'abc',
      '2~1~k1~x',
      '3~1~k1~x',
      '1~-1~k1~x',
      '',
      '1~5~k1~2026-03-01T09:00:00.000Z',
      `3~${'ab'.repeat(400)}`,
    ]) {
      await badRequest(
        pageOf(t, f.admin, { ...scope, cursor }),
        'cursor must be the next_cursor of an earlier page',
      )
    }
    for (const limit of [0, 26, 2.5, -1]) {
      await badRequest(
        pageOf(t, f.admin, { ...scope, limit }),
        'limit must be a whole number from 1 to 25',
      )
    }
    // a search counts after trimming and is refused past LIMITS.search as a rule
    const long = await expectRefusal(
      pageOf(t, f.admin, { ...scope, search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(long.data.message).toBe(LIMITS.search.refusal)
    // the refusals come before the fence, the same for any scope
    await badRequest(
      pageOf(t, f.guest, { ...scopeOf(f.org.id, f.hidden.id), limit: 0 }),
      'limit must be a whole number from 1 to 25',
    )
    await badRequest(
      pageOf(t, f.admin, { ...allOf(f.otherOrg.id), limit: 26 }),
      'limit must be a whole number from 1 to 25',
    )
    const atCap = ` ${'x'.repeat(LIMITS.search.max)} `
    expect((await pageOf(t, f.admin, { ...scope, search: atCap })).rows).toEqual([])
  })

  it('refuses a call without a scope or with project_id, and project ids past the bound', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a call needs a scope, and project_id is no argument
    for (const args of [
      {},
      { project_id: f.sub.id },
      { ...scopeOf(f.org.id, f.sub.id), project_id: f.sub.id },
    ])
      await expect(pageOf(t, f.admin, args as never)).rejects.toThrowError(/Validator error/)
    const ids = 'scope.project_ids must name 1 to 50 projects'
    // an empty list is never All projects
    await badRequest(pageOf(t, f.admin, scopeOf(f.org.id)), ids)
    const many = Array.from({ length: 51 }, () => uuid())
    await badRequest(pageOf(t, f.admin, scopeOf(f.org.id, ...many)), ids)
    // a repeated id counts once
    const fifty = [...many.slice(0, 49), f.sub.id]
    const repeated = scopeOf(f.org.id, ...fifty, ...fifty.slice(0, 10))
    expect(await pageOf(t, f.admin, repeated)).toEqual({ rows: [], next_cursor: null, scanned: 0 })
  })

  it('answers an All projects search of 2,500 long archived tasks inside Convex’s limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 3,000 people and 1,500 labels, past ARCHIVE_LABELS.scan
    await t.run(async (ctx) => {
      for (let i = 0; i < 3000; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: `Person ${i}`,
          initials: 'PP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    const labelIds = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 1500; i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('labels', {
          id,
          org_id: f.org.id,
          name: `Label ${i}`,
          name_lower: `label ${i}`,
          color: '#F0555D',
          created_at: NOW,
        })
      }
      return ids
    })
    // descriptions at the 20,000-character cap in a three-byte script, on
    // the task row and on its description row, as release 2 stores them
    const text = '漢'.repeat(LIMITS.description.max)
    for (let batch = 0; batch < 50; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 50; i++) {
          const n = batch * 50 + i
          const id = uuid()
          await insertTask(
            ctx.db,
            {
              id,
              org_id: f.org.id,
              project_id: n % 2 ? f.sub.id : f.sub2.id,
              num: bulkNum++,
              title: `Bulk ${n}`,
              description: text,
              status: 'done',
              priority: 'medium',
              paused: false,
              created_at: NOW,
              updated_at: NOW,
              archived_at: day(1 + (n % 28)),
            },
            'restore',
          )
          await ctx.db.insert('issue_labels', {
            org_id: f.org.id,
            issue_id: id,
            label_id: labelIds[n % labelIds.length],
          })
        }
      })
    }
    /** What one call of archivedPageCore answers and reads. */
    const measured = (search: string) =>
      t.run(async (ctx) => {
        const found = await archivedPageCore(
          ctx,
          f.admin,
          { kind: 'all', orgId: f.org.id },
          { cursor: null, search, limit: 25 },
        )
        const m = await ctx.meta.getTransactionMetrics()
        return {
          rows: found.rows.length,
          next: found.next !== null,
          scanned: found.scanned,
          ranges: m.databaseQueries.used,
          documents: m.documentsRead.used,
          bytes: m.bytesRead.used,
        }
      })
    const browse = await measured('')
    const nothing = await measured('nothing matches this')
    const label = await measured('label 7')
    console.info('archived All projects metrics', { browse, nothing, label })
    expect(browse).toMatchObject({ rows: 25, next: true })
    // a search that matches nothing stops at its budget, with a cursor
    expect(nothing).toMatchObject({ rows: 0, next: true })
    expect(nothing.scanned).toBeGreaterThan(0)
    expect(label.next).toBe(true)
    for (const m of [browse, nothing, label]) {
      expect(m.ranges).toBeLessThan(4096)
      expect(m.documents).toBeLessThan(32_000)
      expect(m.bytes).toBeLessThan(16 << 20)
    }
    // and the public query answers alike, inside the limits
    const page = await pageOf(t, f.admin, { ...allOf(f.org.id), search: 'nothing matches this' })
    expect(page.rows).toEqual([])
    expect(page.next_cursor).not.toBeNull()
  }, 300_000)
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
    const scope = scopeOf(f.org.id, f.sub.id)
    const first = await pageOf(t, f.admin, { ...scope, search: 'soak', limit: 10 })
    expect(first.rows.map((row) => row.id)).not.toContain(soak.id)
    const { rows } = await pageOf(t, f.admin, scope)
    const listed = rows.find((row) => row.id === soak.id)
    expect(listed).toBeDefined()
    // the page's row without what only the list shows
    const { place: _place, owner_name: _owner, can_restore: _restore, ...shown } = listed ?? {}
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
