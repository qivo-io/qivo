/* Read-only check of the rows stored before the weekly milestone rule
 * (LIMITS.milestonesPerWeek, model/milestones.ts assertWeekFree) that break
 * it. The rule makes no exception for them, so every deployment that holds
 * data is checked once the rule is on, and the owner decides how to resolve
 * each finding. Nothing here writes, deletes, merges or moves a milestone,
 * and there is no fix.
 *
 * It finds, among live milestones and the copies Deleted items keeps of a
 * deleted project's milestones (deleted_rows), which a restore writes back
 * unchanged:
 *   duplicate_week  two or more milestones of one top-level project in one
 *                   week, as its organization's week_start draws weeks now.
 *                   The rule refuses to add or move another milestone into
 *                   that week, and the organization cannot change its
 *                   first day of the week until one of them moves.
 *   impossible_day  a stored day that does not exist, such as 2026-02-31,
 *                   which writes took until 2026-10-16. `shown` is the day
 *                   the app shows it on, whose week the rule counts it in.
 *                   A write's check of one week reads the days of that
 *                   week as text, so it can miss such a row.
 *   sub_project     a milestone stored on a sub-project, as writes did
 *                   before 2026-10-14. Neither the app nor REST shows it,
 *                   and the rule counts only the top-level project's own.
 *   orphan          a live milestone whose project is neither live nor in
 *                   Deleted items.
 *   unchecked       a project with more than PROJECT_MOST milestones, more
 *                   than a page reads at once. Check it by hand.
 * Deleted items that can no longer be restored (stuck or purging) are left
 * out, as the rule leaves them out.
 *
 * The `live` phase walks milestones project by project in by_project_week
 * order. The `deleted` phase walks the project items of Deleted items, with
 * the copies they store and the live rows a move has not taken yet or a
 * restore has written back. A finding names ids, days and weeks, never a
 * name.
 *
 * The check ships in the release that turns the rule on. The owner has
 * approved these releases and has said that no deployment holds real user
 * data. Right after the release deploys to a deployment that holds data
 * (staging, the demo, production, a branch preview that keeps data), run the
 * check there through the private helpers and report every finding to the
 * owner. `check` is a query, so it cannot write, and a key that may only run
 * internal queries can run it. It reports one page of one phase. Start with
 * `{"phase": "live"}`, pass the returned `cursor` back until `done` is true,
 * then do the same for `"deleted"`. `run` walks every page of both phases
 * and answers the counts and the first FINDINGS_MOST findings. With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/milestoneWeeks:check '{"phase": "live"}'
 *   "$H" staging npx convex run internal/milestoneWeeks:run '{}'
 *
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs each command with a short-lived key,
 * which is a key permission change and needs the owner's approval of the
 * command: `check` needs deployment:functions:runInternalQueries and `run`,
 * an internal action, deployment:functions:runInternalActions.
 *
 * Each page reads in its own transaction, so a milestone written between
 * two pages can be missed or seen twice; run it again after a change. A
 * page reads at most PROJECT_MOST + 1 rows of each kind for one project, and
 * looks at its room before each project, so its cursor can point into a
 * Deleted items item with many projects. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalAction, internalQuery, type QueryCtx } from '../_generated/server'
import { byId, usedMoreThan } from '../lib/db'
import type { DeletedItemState } from '../lib/enums'
import { shownDay, weekDays } from '../model/orgs'
import { isCalendarDay } from '../model/taskValues'

/** The milestones the `live` phase reads a page, and the project items of
 * Deleted items the `deleted` phase does. A page ends at a project or an
 * item, or sooner at ROOM.share. `page_size` lowers them, for tests. */
const PAGE = { live: 2_000, deleted: 100 }

/** The share of Convex's limits for one transaction a page uses before it
 * ends at the next project. One project reads at most PROJECT_MOST + 1 live
 * rows and as many Deleted items copies, about 3 MiB, so a page stays inside
 * the limits past its room. Tests lower it. */
export const ROOM = { share: 0.5 }

/** The most milestones of one project a page reads, live rows and Deleted
 * items copies together, about 1 MiB. A project with more is reported as
 * `unchecked`. */
export const PROJECT_MOST = 2_000

/** The most findings `run` lists. It counts every one. */
const FINDINGS_MOST = 2_000

/* The Deleted items states whose project items can still be restored. */
const RESTORABLE: readonly DeletedItemState[] = ['moving', 'ready', 'restoring']

const PHASES = ['live', 'deleted'] as const
type Phase = (typeof PHASES)[number]
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))

const KINDS = ['duplicate_week', 'impossible_day', 'sub_project', 'orphan', 'unchecked'] as const
type Kind = (typeof KINDS)[number]

/** One finding. `org_id` is the organization of the project, null when it
 * is not known. `item_id` names the Deleted items item that holds the
 * project. `week` is the first day of a duplicate week. Each milestone
 * names its id, its stored day and, for a day that does not exist, the
 * day the app shows it on (null for text that names no day). */
type Finding = {
  kind: Kind
  org_id: string | null
  project_id: string
  item_id?: string
  week?: string
  milestones: { id: string; day: string; shown?: string | null }[]
}

/** What one page found, and where the next one starts. */
type PageResult = { findings: Finding[]; checked: number; cursor: string; done: boolean }

const checkRef = makeFunctionReference<
  'query',
  { phase: Phase; cursor?: string | null; page_size?: number },
  PageResult
>('internal/milestoneWeeks:check')

/* A stored milestone, live or a Deleted items copy. */
type Stored = Pick<Doc<'milestones'>, 'id' | 'week'>

/* The findings of `rows`, the milestones of top-level project `project_id`
 * under `org`'s week start: each day that does not exist, and each week
 * that holds more than one of them. */
function judgeTopLevel(
  rows: Stored[],
  org: Pick<Doc<'organizations'>, 'id' | 'week_start'>,
  where: Pick<Finding, 'project_id' | 'item_id'>,
): Finding[] {
  const found: Finding[] = []
  const weeks = new Map<string, Stored[]>()
  for (const row of rows) {
    if (!isCalendarDay(row.week))
      found.push({
        kind: 'impossible_day',
        org_id: org.id,
        ...where,
        milestones: [{ id: row.id, day: row.week, shown: shownDay(row.week) }],
      })
    const first = weekDays(row.week, org)?.first
    if (first !== undefined) weeks.set(first, [...(weeks.get(first) ?? []), row])
  }
  for (const [week, held] of [...weeks].sort(([a], [b]) => a.localeCompare(b)))
    if (held.length > 1)
      found.push({
        kind: 'duplicate_week',
        org_id: org.id,
        ...where,
        week,
        milestones: held.map((row) => ({ id: row.id, day: row.week })),
      })
  return found
}

/* `rows` as finding milestones. */
const listed = (rows: Stored[]): Finding['milestones'] =>
  rows.map((row) => ({ id: row.id, day: row.week }))

/* One page of the live phase: the milestones of the projects after
 * `cursor`, a project id, in by_project_week order. */
async function livePage(ctx: QueryCtx, cursor: string | null, size: number): Promise<PageResult> {
  const findings: Finding[] = []
  const orgs = new Map<string, Promise<Doc<'organizations'> | null>>()
  const orgOf = (id: string) => {
    let org = orgs.get(id)
    if (org === undefined) {
      org = byId(ctx, 'organizations', id)
      orgs.set(id, org)
    }
    return org
  }
  // the milestones the page read, and those it judged
  let read = 0
  let checked = 0
  // the findings of one project's milestones, all of them
  const judge = async (rows: Doc<'milestones'>[]) => {
    read += rows.length
    const projectId = rows[0].project_id
    const project = await byId(ctx, 'projects', projectId)
    if (project === null) {
      // a project in Deleted items, whose rows the deleted phase judges
      const held = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', projectId))
        .first()
      if (held !== null) return
      checked += rows.length
      findings.push({
        kind: 'orphan',
        org_id: null,
        project_id: projectId,
        milestones: listed(rows),
      })
      return
    }
    checked += rows.length
    if (project.parent_id !== undefined) {
      findings.push({
        kind: 'sub_project',
        org_id: project.org_id,
        project_id: projectId,
        milestones: listed(rows),
      })
      return
    }
    const org = await orgOf(project.org_id)
    if (org === null) {
      findings.push({
        kind: 'orphan',
        org_id: project.org_id,
        project_id: projectId,
        milestones: listed(rows),
      })
      return
    }
    findings.push(...judgeTopLevel(rows, org, { project_id: projectId }))
  }
  const rows = ctx.db
    .query('milestones')
    .withIndex('by_project_week', (q) => (cursor === null ? q : q.gt('project_id', cursor)))
  let group: Doc<'milestones'>[] = []
  for await (const row of rows) {
    if (group.length > 0 && row.project_id !== group[0].project_id) {
      await judge(group)
      const last = group[0].project_id
      group = []
      if (read >= size || (await usedMoreThan(ctx, ROOM.share)))
        return { findings, checked, cursor: last, done: false }
    }
    group.push(row)
    if (group.length > PROJECT_MOST) {
      // the next page starts after this project
      findings.push({
        kind: 'unchecked',
        org_id: null,
        project_id: row.project_id,
        milestones: [],
      })
      return { findings, checked, cursor: row.project_id, done: false }
    }
  }
  if (group.length > 0) await judge(group)
  return { findings, checked, cursor: '', done: true }
}

/* Where a deleted-phase page starts, after item `after`, or at project
 * `from` of it when the room ran out within it (a cursor `<item id>#<n>`). */
function deletedStart(cursor: string | null): { after: string | null; from: number | null } {
  if (cursor === null || cursor === '') return { after: null, from: null }
  const [after, at] = cursor.split('#')
  return { after, from: at === undefined ? null : Number(at) }
}

/* One page of the deleted phase, the project items from `cursor` in id
 * order. An item whose project a restore has already revealed is the live
 * phase's. */
async function deletedPage(
  ctx: QueryCtx,
  cursor: string | null,
  size: number,
): Promise<PageResult> {
  const { after, from } = deletedStart(cursor)
  const findings: Finding[] = []
  let checked = 0
  let items = 0
  // whether the page has read a project yet, so it always gets further
  let moved = false
  const orgs = new Map<string, Promise<Doc<'organizations'> | null>>()
  const all = ctx.db
    .query('deleted_items')
    .withIndex('by_uuid', (q) =>
      after === null ? q : from === null ? q.gt('id', after) : q.gte('id', after),
    )
  for await (const item of all) {
    if (
      item.kind === 'project' &&
      RESTORABLE.includes(item.state) &&
      (await byId(ctx, 'projects', item.target_id)) === null
    ) {
      for (let i = item.id === after ? (from ?? 0) : 0; i < item.projects.length; i++) {
        if (moved && (await usedMoreThan(ctx, ROOM.share)))
          return { findings, checked, cursor: `${item.id}#${i}`, done: false }
        moved = true
        const project = item.projects[i]
        // the live rows a move has not taken yet or a restore has written
        // back, then the stored copies
        const live = await ctx.db
          .query('milestones')
          .withIndex('by_project_week', (q) => q.eq('project_id', project.id))
          .take(PROJECT_MOST + 1)
        const copies = await ctx.db
          .query('deleted_rows')
          .withIndex('by_item_table_owner', (q) =>
            q.eq('item_id', item.id).eq('table', 'milestones').eq('owner_id', project.id),
          )
          .take(PROJECT_MOST + 1)
        const rows = new Map<string, Stored>(live.map((row) => [row.id, row]))
        for (const copy of copies)
          if (copy.row.table === 'milestones') rows.set(copy.row.doc.id, copy.row.doc)
        if (rows.size === 0) continue
        const where = { project_id: project.id, item_id: item.id }
        if (rows.size > PROJECT_MOST) {
          findings.push({ kind: 'unchecked', org_id: item.org_id, ...where, milestones: [] })
          continue
        }
        checked += rows.size
        if (project.id !== item.target_id || item.parent_project_id !== undefined) {
          findings.push({
            kind: 'sub_project',
            org_id: item.org_id,
            ...where,
            milestones: listed([...rows.values()]),
          })
          continue
        }
        let known = orgs.get(item.org_id)
        if (known === undefined) {
          known = byId(ctx, 'organizations', item.org_id)
          orgs.set(item.org_id, known)
        }
        const calendar = await known
        if (calendar === null)
          findings.push({
            kind: 'orphan',
            org_id: item.org_id,
            ...where,
            milestones: listed([...rows.values()]),
          })
        else findings.push(...judgeTopLevel([...rows.values()], calendar, where))
      }
    }
    if (++items >= size || (await usedMoreThan(ctx, ROOM.share)))
      return { findings, checked, cursor: item.id, done: false }
  }
  return { findings, checked, cursor: '', done: true }
}

/** Reports, without writing, one page of `phase`. Leave out `cursor`, or
 * pass null, for the first page, then call again with the returned
 * `cursor` until `done`. `checked` counts the milestones the page judged,
 * as the live phase leaves the rows of a project in Deleted items to the
 * deleted phase. */
export const check = internalQuery({
  args: {
    phase: vPhase,
    cursor: v.optional(v.union(v.string(), v.null())),
    page_size: v.optional(v.number()),
  },
  handler: async (ctx, { phase, cursor, page_size }): Promise<PageResult> =>
    phase === 'live'
      ? await livePage(ctx, cursor ?? null, page_size ?? PAGE.live)
      : await deletedPage(ctx, cursor ?? null, page_size ?? PAGE.deleted),
})

/** Walks every page of both phases, without writing, and answers how many
 * milestones it checked, how many findings of each kind it made, and the
 * first FINDINGS_MOST of them, with `listed_all` false when it left some
 * out. */
export const run = internalAction({
  args: { page_size: v.optional(v.number()) },
  handler: async (
    ctx,
    { page_size },
  ): Promise<{
    checked: number
    counts: Record<Kind, number>
    findings: Finding[]
    listed_all: boolean
  }> => {
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<Kind, number>
    const findings: Finding[] = []
    let checked = 0
    let total = 0
    for (const phase of PHASES) {
      let cursor: string | null = null
      for (;;) {
        const page: PageResult = await ctx.runQuery(checkRef, { phase, cursor, page_size })
        checked += page.checked
        for (const finding of page.findings) {
          counts[finding.kind]++
          total++
          if (findings.length < FINDINGS_MOST) findings.push(finding)
        }
        if (page.done) break
        cursor = page.cursor
      }
    }
    return { checked, counts, findings, listed_all: findings.length === total }
  },
})
