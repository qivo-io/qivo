/* Deleted items as people read them (design 6.2): the Settings list and the
 * search for deleted tasks by key or title. Both read every active seat of
 * the login, because Deleted items spans organizations as Archived projects
 * does, and judge each item with the seat in its own organization, never
 * the home one. Rows are projections for that seat (model/deletedItems.ts
 * viewOf), never stored documents.
 *
 * The search finds any stored task, a task item's root or subtask or a task
 * inside a deleted project, so it reaches the older items a capped list
 * leaves out. Each match names the kind of its item: a task item's match
 * is restored with that item like a row of the list, its root and every
 * subtask together, and a project item's only with its whole project. A
 * match of a task item's subtask names the item's root, as its row does. It
 * judges each item as the list does and shows only tasks in the projects
 * the seat's view of the item holds, so the match of a redacted task item
 * never names its root.
 *
 * A seat reads only the index ranges that can hold what it sees. An admin
 * reads the organization's items newest first. Anyone else reads their own
 * deletes, the projects they led that are now in Deleted items (stored
 * leads, deleted_rows.by_org_lead), and for each live project they lead,
 * the items under it (by_org_parent for a top-level project, by_org_project
 * for a sub-project) and the task items with a subtask in it
 * (deleted_tasks.by_org_cross_project). Every range is read newest first up
 * to LIST.cap items, and a seat lists at most LIST.cap; `capped` says when
 * more may exist. The two ranges of stored rows hold a row per project the
 * person led and per subtask, so several of their rows can name one item.
 * They count distinct items and read each new one by id.
 *
 * Every read of one list call, across all its seats, spends one budget
 * (LIST.call): each seat's sight, the ranges that find its items and the
 * reads that build each item's row. The reads that find items also spend
 * LIST.find, a smaller share, so some of the call is always left to build
 * rows. A seat builds its rows newest first. Once a budget is spent the
 * call stops reading and reports `capped`, so it lists the newest items it
 * got to rather than fail. The search (matchesFor) spends a LIST.call
 * budget the same way, and answers the matches it found before it ran out.
 *
 * A `deleted_by` filter keeps one person's deletes, judged by the reference
 * predicate, so a seat that reuses the id of someone removed does not take
 * over their deletes. An admin's seat reads that person's range instead of
 * the newest items, so it reaches older ones. Every other seat filters the
 * ranges it reads anyway: a range of someone else's deletes would hold
 * items hidden from the seat, and `capped` would then tell how many there
 * are. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { CredentialTable } from '../lib/enums'
import { issueKey } from '../lib/taskRefs'
import {
  type BlockDetail,
  blockDetail,
  type ItemView,
  meterDb,
  namesProfile,
  orgReadOnly,
  restoreBlock,
  type Sight,
  sameReference,
  sightOf,
  viewOf,
} from './deletedItems'
import { estimateDocumentBytes } from './demoMetrics'

type Item = Doc<'deleted_items'>

/**
 * The most items one organization lists (`cap`), and what one list or
 * search call may read, in estimated `bytes`, documents (`rows`) and index
 * `ranges`, each query read or read by id being one. Convex stops a query
 * at 16 MiB, 32,000 documents or 4,096 ranges.
 *
 * `call` covers every read of the call: each seat's sight (sightOf: the
 * organization's projects, profiles and teams and the person's grants), the
 * reads that find its items (candidatesOf) and those that build its rows
 * (rowOf). It takes five eighths of each limit: 10 MiB, 20,000 documents and
 * 2,560 ranges. The other three eighths hold what can run past the call's
 * last check, which comes before each seat, range, document and row: the
 * sight of the seat it opened last, the reads of the row it built last (a
 * project item's stored projects, grants and shares, or a redacted task
 * item's tasks, no more than one delete moved in its own transaction), and
 * the reads authedQuery makes for the login before the call.
 *
 * `find` is the share of `call` the reads that find items may spend: 6 MiB,
 * 12,000 documents and 1,024 ranges. Finding reads mostly bytes and
 * documents, whole items and the stored rows that name them. It leaves the
 * rest, about 4 MiB, 8,000 documents and 1,536 ranges, for sights and rows,
 * which read mostly ranges. A row reads nothing past the sight's memo
 * except reads the memo keeps for the rest of the call (whether the
 * organization is read-only, the person's teams, and a few per deleted
 * project an item names), a redacted task item's tasks up to one the viewer
 * sees, and, for a seat that is not an admin, a project item's stored
 * projects, grants and team shares (3 ranges). So 1,536 ranges build about
 * 500 such rows, and more when finding spent less. A mutable object, so
 * tests can lower it; replace `call` and `find` whole rather than change
 * their fields.
 */
export const LIST = {
  cap: 2000,
  call: { bytes: 10 * 1024 * 1024, rows: 20_000, ranges: 2560 },
  find: { bytes: 6 * 1024 * 1024, rows: 12_000, ranges: 1024 },
}

/** What one call has left of a LIST budget. */
type Reads = { bytes: number; rows: number; ranges: number }

/** Whether `reads` has nothing left to open a range or read a document. */
const spent = (reads: Reads): boolean => reads.bytes <= 0 || reads.rows <= 0 || reads.ranges <= 0

/** `ctx` whose every read spends each of `budgets`: a range per query read
 * or read by id, and a row and its estimated bytes per document read. */
const spending = (ctx: QueryCtx, ...budgets: Reads[]): QueryCtx =>
  meterDb(ctx, {
    range: () => {
      for (const b of budgets) b.ranges -= 1
    },
    doc: (doc) => {
      const bytes = estimateDocumentBytes(doc)
      for (const b of budgets) {
        b.rows -= 1
        b.bytes -= bytes
      }
    },
  })

/** The most hits one search returns, and the search results it looks at per
 * organization to find them. */
export const MATCHES = { max: 50, scan: 256 }

/** Who deleted an item, as one viewer may know it (design 1.6). A
 * personal token's or connected app's name shows only to organization
 * admins and to its owner, the deleter; an agent key's to everyone. `who`
 * is an opaque key for grouping rows by person and credential: it names the
 * credential only to those who may see its name, and the person only while
 * their profile is the one that deleted, so every "Someone" row shares one
 * key and none folds into a later seat that reuses a removed person's id. */
export type Deleter = {
  /** the viewer deleted it */
  you: boolean
  /** while the profile that deleted it is the one stored */
  profile_id?: string
  /** absent once that profile is gone ("Someone") */
  name?: string
  /** how it was deleted: in the app, or over REST or MCP with this credential */
  kind: 'app' | CredentialTable
  credential_name?: string
  who: string
}

/** One Deleted items row, projected for its viewer. `key` is a task item's
 * task key or a project item's project key. `counts`, `projects` and `path`
 * show only what the viewer may see; a redacted row shows one task the
 * viewer can see instead of the root. `blocked` explains a ready row that
 * cannot be restored by the viewer; rows in other states say so by `state`. */
export type DeletedRow = {
  id: string
  org_id: string
  org_name: string
  kind: Item['kind']
  key: string
  title: string
  status?: Item['status']
  counts: Item['counts']
  projects: Item['projects']
  path: string[]
  archived: boolean
  deleted_at: string
  deleter: Deleter
  reason?: string
  state: Exclude<Item['state'], 'purging'>
  redacted?: true
  can_restore: boolean
  blocked?: BlockDetail
  can_purge: boolean
}

/** A deleted task that a search found, with what the row of its item says:
 * it can only come back with that item, which `item_kind` names. `key`,
 * `title`, `archived` and `path` are the task's own; `path` is where it
 * sat, its project after the top-level or parent project, empty for a
 * redacted task item as on its row. `root_key` and `root_title` name a task
 * item's root when the task found is one of its subtasks, as the item's row
 * would, so the page can say that the root and its other subtasks come back
 * too. A redacted match has neither, since its row never names the root. */
export type DeletedMatch = {
  item_id: string
  item_kind: Item['kind']
  org_id: string
  org_name: string
  key: string
  title: string
  root_key?: string
  root_title?: string
  archived: boolean
  path: string[]
  deleted_at: string
  deleter: Deleter
  state: DeletedRow['state']
  redacted?: true
  can_restore: boolean
  blocked?: BlockDetail
}

const newestFirst = (
  a: { deleted_at: string; id: string },
  b: { deleted_at: string; id: string },
) => (a.deleted_at === b.deleted_at ? (a.id < b.id ? 1 : -1) : a.deleted_at < b.deleted_at ? 1 : -1)

/** The Deleted items of every seat in `seats`, newest first, read while
 * the call's budgets last (LIST). */
export async function listFor(
  ctx: QueryCtx,
  seats: Iterable<Doc<'profiles'>>,
  deletedBy: string | undefined,
): Promise<{ items: DeletedRow[]; capped: boolean }> {
  const items: DeletedRow[] = []
  let capped = false
  const call: Reads = { ...LIST.call }
  const find: Reads = { ...LIST.find }
  for (const me of seats) {
    // a seat the budgets cannot read lists nothing, and capped says so
    if (spent(call) || spent(find)) {
      capped = true
      break
    }
    const seat = await seatList(ctx, me, deletedBy, call, find)
    items.push(...seat.items)
    capped ||= seat.capped
  }
  return { items: items.sort(newestFirst), capped }
}

/** One seat's rows, newest first. Its sight and its rows spend `call`, the
 * reads that find its items `find` too. It builds rows from the newest item
 * on, and stops at LIST.cap rows and one more to tell whether there are
 * more, or once `call` is spent. */
async function seatList(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  deletedBy: string | undefined,
  call: Reads,
  find: Reads,
): Promise<{ items: DeletedRow[]; capped: boolean }> {
  const reader = spending(ctx, call)
  const sight = await sightOf(reader, me)
  const orgName = (await byId(reader, 'organizations', me.org_id))?.name ?? ''
  const found = await candidatesOf(spending(ctx, find, call), sight, deletedBy, [find, call])
  const deleter = deletedBy === undefined ? undefined : sight.profiles.get(deletedBy)
  const rows: DeletedRow[] = []
  let capped = found.truncated
  for (const item of found.items.sort(newestFirst)) {
    if (rows.length > LIST.cap) break
    if (deletedBy !== undefined && !(item.deleted_by === deletedBy && sameReference(deleter, item)))
      continue
    if (spent(call)) {
      capped = true
      break
    }
    const row = await rowOf(reader, sight, orgName, item)
    if (row !== null) rows.push(row)
  }
  return { items: rows.slice(0, LIST.cap), capped: capped || rows.length > LIST.cap }
}

/** The items `sight`'s person may see, from the ranges that can hold them
 * (see the file comment), read through `ctx`, which spends `budgets`, while
 * they last. `truncated` when a range held more than it read, or when a
 * budget ran out first. Only an admin's seat reads `deletedBy`'s range;
 * seatList filters. */
async function candidatesOf(
  ctx: QueryCtx,
  sight: Sight,
  deletedBy: string | undefined,
  budgets: Reads[],
): Promise<{ items: Item[]; truncated: boolean }> {
  const { me, levels } = sight
  const org = me.org_id
  const found = new Map<string, Item>()
  let truncated = false
  // Whether a range or a read by id may start, or a budget is spent.
  const open = (): boolean => {
    if (!budgets.some(spent)) return true
    truncated = true
    return false
  }
  // Whether the document just read used up a budget's documents or bytes,
  // so no further document may be read. A range already open reads on
  // after the last range is spent.
  const full = (): boolean => {
    if (!budgets.some((b) => b.rows <= 0 || b.bytes <= 0)) return false
    truncated = true
    return true
  }
  // A range of items, up to LIST.cap of them and one more to tell whether
  // it held more.
  const take = async (rows: AsyncIterable<Item>): Promise<void> => {
    if (!open()) return
    let count = 0
    for await (const item of rows) {
      found.set(item.id, item)
      if (full()) return
      if (++count > LIST.cap) {
        truncated = true
        return
      }
    }
  }
  // A range of stored rows can name one item several times, so it counts
  // the items it names, and reads each one it has not found yet.
  const takeNamed = async (rows: AsyncIterable<{ item_id: string }>): Promise<void> => {
    if (!open()) return
    const named = new Set<string>()
    for await (const row of rows) {
      if (full()) return
      if (named.has(row.item_id)) continue
      named.add(row.item_id)
      if (named.size > LIST.cap) {
        truncated = true
        return
      }
      if (found.has(row.item_id)) continue
      if (!open()) return
      const item = await byId(ctx, 'deleted_items', row.item_id)
      if (item === null) continue
      found.set(item.id, item)
      if (full()) return
    }
  }
  const items = ctx.db.query('deleted_items')
  if (me.org_role === 'admin') {
    await take(
      deletedBy === undefined
        ? items.withIndex('by_org_deleted', (q) => q.eq('org_id', org)).order('desc')
        : items
            .withIndex('by_org_deleter', (q) => q.eq('org_id', org).eq('deleted_by', deletedBy))
            .order('desc'),
    )
    return { items: [...found.values()], truncated }
  }
  await take(
    items
      .withIndex('by_org_deleter', (q) => q.eq('org_id', org).eq('deleted_by', me.id))
      .order('desc'),
  )
  await takeNamed(
    ctx.db
      .query('deleted_rows')
      .withIndex('by_org_lead', (q) => q.eq('org_id', org).eq('lead_id', me.id))
      .order('desc'),
  )
  const leads = (p: Doc<'projects'> | undefined) => p !== undefined && levels.levelOf(p) === 'lead'
  for (const p of sight.projects.values()) {
    if (p.type === 'meta') {
      if (leads(p))
        await take(
          items
            .withIndex('by_org_parent', (q) => q.eq('org_id', org).eq('parent_project_id', p.id))
            .order('desc'),
        )
      continue
    }
    const topLed = p.parent_id !== undefined && leads(sight.projects.get(p.parent_id))
    if (!leads(p) && !topLed) continue
    if (!topLed)
      await take(
        items
          .withIndex('by_org_project', (q) => q.eq('org_id', org).eq('project_id', p.id))
          .order('desc'),
      )
    await takeNamed(
      ctx.db
        .query('deleted_tasks')
        .withIndex('by_org_cross_project', (q) => q.eq('org_id', org).eq('cross_project_id', p.id))
        .order('desc'),
    )
  }
  return { items: [...found.values()], truncated }
}

/** `item` as `sight`'s person sees it, or null when it is hidden from them. */
async function rowOf(
  ctx: QueryCtx,
  sight: Sight,
  orgName: string,
  item: Item,
): Promise<DeletedRow | null> {
  const { me, memo } = sight
  const view = await viewOf(ctx, memo, me, item)
  // viewOf never shows a purging item; the check narrows the state
  if (view === null || item.state === 'purging') return null
  const shown = view.redacted ? await shownTask(ctx, item, view) : null
  if (view.redacted && shown === null) return null
  const ready = item.state === 'ready'
  const block = view.redacted ? 'no_access' : await restoreBlock(ctx, me, item, memo)
  let blocked: BlockDetail | undefined
  if (ready && block !== null)
    blocked = view.redacted ? { reason: block } : await blockDetail(ctx, memo, item, block)
  const base = {
    id: item.id,
    org_id: item.org_id,
    org_name: orgName,
    kind: item.kind,
    counts: countsOf(item, view),
    projects: view.projects.map((p) => {
      const live = sight.projects.get(p.id)
      return sameReference(live, item) ? { ...p, name: live.name, key: live.key } : p
    }),
    deleted_at: item.deleted_at,
    deleter: deleterOf(sight, item),
    state: item.state,
    can_restore: ready && block === null,
    blocked,
    // Delete now is an adminMutation, which a read-only organization refuses
    can_purge:
      me.org_role === 'admin' &&
      (ready || item.state === 'stuck') &&
      !(await orgReadOnly(ctx, memo, item.org_id)),
  }
  if (shown !== null)
    return {
      ...base,
      key: issueKey(shown.num),
      title: shown.title,
      path: [],
      archived: shown.archived,
      redacted: true,
    }
  return {
    ...base,
    key: item.kind === 'task' ? issueKey(item.num) : (item.key ?? ''),
    title: item.name,
    status: item.status,
    path: pathOf(sight, item),
    archived: item.archived,
    reason: item.reason,
  }
}

/** The task a redacted row shows: one of its tasks in a project the viewer
 * can see. It checks the item's tasks itself rather than filter the range,
 * so a metered ctx (seatList) counts every task it passes over, as Convex
 * does. */
async function shownTask(ctx: QueryCtx, item: Item, view: ItemView) {
  const seen = new Set(view.projects.map((p) => p.id))
  const tasks = ctx.db.query('deleted_tasks').withIndex('by_item', (q) => q.eq('item_id', item.id))
  for await (const task of tasks) if (seen.has(task.project_id)) return task
  return null
}

/** What the row counts: everything when the viewer sees all the item's
 * projects, else only the tasks and sub-projects in the projects they see. */
function countsOf(item: Item, view: ItemView): Item['counts'] {
  if (view.projects.length === item.projects.length) return item.counts
  const tasks = view.projects.reduce((n, p) => n + p.tasks, 0)
  return {
    tasks,
    archived_tasks: view.projects.reduce((n, p) => n + p.archived_tasks, 0),
    subtasks: item.kind === 'task' ? Math.max(0, tasks - 1) : 0,
    sub_projects:
      item.kind === 'project' ? view.projects.filter((p) => p.id !== item.target_id).length : 0,
  }
}

/** Where the item sat, with the names its live projects carry now: a task
 * item's top-level project and project, a sub-project item's parent, nothing
 * for a top-level project. */
function pathOf(sight: Sight, item: Item): string[] {
  const live = (id: string | undefined, at: number) => {
    const project = id === undefined ? undefined : sight.projects.get(id)
    return sameReference(project, item) ? project.name : item.path[at]
  }
  if (item.kind === 'project')
    return item.parent_project_id === undefined ? [] : [live(item.parent_project_id, 0) ?? '']
  if (item.parent_project_id === undefined) return [live(item.project_id, 0) ?? '']
  return [live(item.parent_project_id, 0) ?? '', live(item.project_id, 1) ?? '']
}

/** The deleter line's parts for `sight`'s person (design 1.6, 6.2). */
function deleterOf(sight: Sight, item: Item): Deleter {
  const { me } = sight
  const id = item.deleted_by
  const profile = id === undefined ? undefined : sight.profiles.get(id)
  const known = sameReference(profile, item)
  const you = namesProfile(item, id, me)
  const { via } = item
  const named = via !== undefined && (via.table === 'agent_keys' || me.org_role === 'admin' || you)
  const how = via === undefined ? 'app' : named ? `${via.table}:${via.id}` : via.table
  return {
    you,
    profile_id: known ? id : undefined,
    name: known ? profile.name : undefined,
    kind: via?.table ?? 'app',
    credential_name: named ? via.name : undefined,
    who: `${known ? id : ''}|${how}`,
  }
}

/** A task reference as the search box takes it: QN-482 or a bare 482. */
const TASK_REF = /^(?:QN-)?(\d+)$/i

/**
 * The deleted tasks that `text` names, by task key or by title
 * (deleted_tasks search_title), at most MATCHES.max, for every seat in
 * `seats`: the roots and subtasks of task items and the tasks inside
 * project items. Only tasks of items the seat sees (viewOf), in projects
 * their view of the item holds, count, and each match says what the row of
 * its item would: a redacted task item's match has no path and cannot be
 * restored by the seat, as its row (rowOf), and a subtask of any other task
 * item names the item's root. Every read of the call spends
 * one LIST.call budget, as a list call's do: the hits, each seat's sight
 * and each item it judges. Once it is spent, the search answers the
 * matches it found so far.
 */
export async function matchesFor(
  ctx: QueryCtx,
  seats: Iterable<Doc<'profiles'>>,
  text: string,
): Promise<DeletedMatch[]> {
  const query = text.trim()
  if (query === '') return []
  const ref = TASK_REF.exec(query)
  const out: DeletedMatch[] = []
  const call: Reads = { ...LIST.call }
  const reader = spending(ctx, call)
  for (const me of seats) {
    if (out.length >= MATCHES.max || spent(call)) break
    const org = me.org_id
    const hits = reader.db.query('deleted_tasks')
    const found = [
      ...(ref === null
        ? []
        : await hits
            .withIndex('by_org_num', (q) => q.eq('org_id', org).eq('num', Number(ref[1])))
            .take(MATCHES.scan)),
      ...(await hits
        .withSearchIndex('search_title', (q) => q.search('title', query).eq('org_id', org))
        .take(MATCHES.scan)),
    ]
    if (found.length === 0) continue
    const sight = await sightOf(reader, me)
    const orgName = (await byId(reader, 'organizations', org))?.name ?? ''
    const items = new Map<string, Promise<{ item: Item; view: ItemView } | null>>()
    const seen = new Set<string>()
    for (const task of found) {
      if (out.length >= MATCHES.max || spent(call)) break
      if (seen.has(task.task_id)) continue
      seen.add(task.task_id)
      let read = items.get(task.item_id)
      if (read === undefined) {
        read = visibleItem(reader, sight, task.item_id)
        items.set(task.item_id, read)
      }
      const visible = await read
      // a task in a project hidden from the seat, a redacted item's root too
      const project = visible?.view.projects.find((p) => p.id === task.project_id)
      if (visible === null || project === undefined) continue
      const { item, view } = visible
      // viewOf never shows a purging item; the check narrows the state
      if (item.state === 'purging') continue
      const ready = item.state === 'ready'
      const block = view.redacted ? 'no_access' : await restoreBlock(reader, me, item, sight.memo)
      let blocked: BlockDetail | undefined
      if (ready && block !== null)
        blocked = view.redacted
          ? { reason: block }
          : await blockDetail(reader, sight.memo, item, block)
      // the row of a task item names its root, unless it is redacted
      const subtask = item.kind === 'task' && !view.redacted && task.task_id !== item.target_id
      out.push({
        item_id: item.id,
        item_kind: item.kind,
        org_id: org,
        org_name: orgName,
        key: issueKey(task.num),
        title: task.title,
        ...(subtask ? { root_key: issueKey(item.num), root_title: item.name } : {}),
        archived: task.archived,
        path: view.redacted ? [] : hitPath(sight, item, project),
        deleted_at: item.deleted_at,
        deleter: deleterOf(sight, item),
        state: item.state,
        redacted: view.redacted || undefined,
        can_restore: ready && block === null,
        blocked,
      })
    }
  }
  return out
}

/** Item `id` with what `sight`'s person sees of it, when they see it. */
async function visibleItem(ctx: QueryCtx, sight: Sight, id: string) {
  const item = await byId(ctx, 'deleted_items', id)
  if (item === null) return null
  const view = await viewOf(ctx, sight.memo, sight.me, item)
  return view === null ? null : { item, view }
}

/** Where a task of `item` in its project `project` sat. A project item's
 * task: the parent of the item's root project, or the item's root, then
 * the task's project. A task item's task in the root's project: the
 * item's path; in another project, that project after its top-level
 * project, with the names they carry now. */
function hitPath(sight: Sight, item: Item, project: Item['projects'][number]): string[] {
  if (item.kind === 'project')
    return [
      project.id === item.target_id ? (pathOf(sight, item)[0] ?? '') : item.name,
      project.name,
    ]
  if (project.id === item.project_id) return pathOf(sight, item)
  const live = sight.projects.get(project.id)
  if (!sameReference(live, item)) return [project.name]
  const top = live.parent_id === undefined ? undefined : sight.projects.get(live.parent_id)
  return sameReference(top, item) ? [top.name, live.name] : [live.name]
}
