/* The row of one Deleted items entry as one person reads it (design 6.2),
 * which deletedItems.item answers and the page (model/deletedItemsPage.ts)
 * builds each entry's row with: rowOf for one seat's sight, rowFor across
 * the login's seats, and their pieces (deleterOf, howOf, hitPath). Each
 * item is judged with the seat in its own organization, never the home
 * one. Rows are projections for that seat (model/deletedItems.ts viewOf),
 * never stored documents. It also holds the metering the page spends its
 * budgets with (Reads, spent, spending).
 *
 * deletedItems.list and matches, the list and search of the apps from
 * before the page, are gone, with their code here and the search_title
 * index of deleted_tasks that they and the page's older rows read. The
 * file keeps its name, which the design notes use. */

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

/** What one call has left of a read budget, as the page counts it
 * (model/deletedItemsPage.ts DELETED_PAGE): estimated `bytes`, documents
 * (`rows`) and index `ranges`. */
export type Reads = { bytes: number; rows: number; ranges: number }

/** Whether `reads` has nothing left to open a range or read a document. */
export const spent = (reads: Reads): boolean =>
  reads.bytes <= 0 || reads.rows <= 0 || reads.ranges <= 0

/** `ctx` whose every read spends each of `budgets`: a range per query read
 * or read by id, and a row and its estimated bytes per document read. */
export const spending = (ctx: QueryCtx, ...budgets: Reads[]): QueryCtx =>
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
 * viewer can see instead of the root. An organization admin's row shows the
 * whole item, and a hidden one, a task item whose root's project the admin
 * cannot read, its key with an empty title and no status or reason.
 * `blocked` explains a ready row that cannot be restored by the viewer;
 * rows in other states say so by `state`. */
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
  /** an admin's task item whose root they cannot read, with an empty
   * `title` and no `status` or `reason` (model/deletedItems.ts ItemView) */
  hidden?: true
  can_restore: boolean
  blocked?: BlockDetail
  can_purge: boolean
}

/**
 * `item` as `sight`'s person sees it, or null when it is hidden from them.
 * An organization admin's row is the whole item, and a task item whose
 * root's project they cannot read is a hidden row, with its key, path,
 * counts and deleter and no title, status or reason (model/deletedItems.ts
 * ItemView). With `out`, the caller's
 * check of its read budget, a redacted task item's row checks it after
 * each of the item's tasks it reads to find the one it shows, and answers
 * 'unread' when the budget ran out first, as each task's row holds its
 * searchable text, so the row is not built.
 */
export async function rowOf(
  ctx: QueryCtx,
  sight: Sight,
  orgName: string,
  item: Item,
): Promise<DeletedRow | null>
export async function rowOf(
  ctx: QueryCtx,
  sight: Sight,
  orgName: string,
  item: Item,
  out: () => boolean,
): Promise<DeletedRow | null | 'unread'>
export async function rowOf(
  ctx: QueryCtx,
  sight: Sight,
  orgName: string,
  item: Item,
  out?: () => boolean,
): Promise<DeletedRow | null | 'unread'> {
  const { me, memo } = sight
  const view = await viewOf(ctx, memo, me, item)
  // viewOf never shows a purging item; the check narrows the state
  if (view === null || item.state === 'purging') return null
  const shown = view.redacted ? await shownTask(ctx, item, view, out) : null
  if (shown === 'unread') return shown
  if (view.redacted && shown === null) return null
  const ready = item.state === 'ready'
  const block = view.redacted ? 'no_access' : await restoreBlock(ctx, me, item, memo)
  let blocked: BlockDetail | undefined
  if (ready && block !== null)
    blocked = view.redacted ? { reason: block } : await blockDetail(ctx, memo, me, item, block)
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
  if (view.hidden)
    return {
      ...base,
      key: issueKey(item.num),
      title: '',
      path: pathOf(sight, item),
      archived: item.archived,
      hidden: true,
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

/** Item `id` as its row would show it to the caller's seat in the item's
 * organization, or null when that seat does not see it: unknown, purging,
 * hidden and other organizations' items alike (deletedItems.item). The app
 * asks for the project item a blocked row must restore first when no page
 * it holds has that item, and for an item a restore deferred. */
export async function rowFor(
  ctx: QueryCtx,
  seats: Iterable<Doc<'profiles'>>,
  id: string,
): Promise<DeletedRow | null> {
  const item = await byId(ctx, 'deleted_items', id)
  if (item === null) return null
  for (const me of seats) {
    if (me.org_id !== item.org_id) continue
    const sight = await sightOf(ctx, me)
    const orgName = (await byId(ctx, 'organizations', me.org_id))?.name ?? ''
    return await rowOf(ctx, sight, orgName, item)
  }
  return null
}

/** The task a redacted row shows: one of its tasks in a project the viewer
 * can see. It checks the item's tasks itself rather than filter the range,
 * so a metered ctx (the page's rows) counts every task it passes over, as
 * Convex does, and answers 'unread' once `out` says the reads ran out
 * before it found one. */
async function shownTask(ctx: QueryCtx, item: Item, view: ItemView, out?: () => boolean) {
  const seen = new Set(view.projects.map((p) => p.id))
  const tasks = ctx.db.query('deleted_tasks').withIndex('by_item', (q) => q.eq('item_id', item.id))
  for await (const task of tasks) {
    if (seen.has(task.project_id)) return task
    if (out?.() === true) return 'unread'
  }
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

/** Whether `me` may know which credential deleted `item` (design 1.6): an
 * agent key's to everyone, a personal token's or connected app's to
 * organization admins and to its owner, the deleter. */
const namesCredential = (me: Doc<'profiles'>, item: Item): boolean =>
  item.via !== undefined &&
  (item.via.table === 'agent_keys' ||
    me.org_role === 'admin' ||
    namesProfile(item, item.deleted_by, me))

/** How `item` was deleted, as `me` may know it: 'app', the table of the
 * credential of a REST or MCP delete, or `table:id` where `me` may know
 * which credential (namesCredential). The deleter line's `who` ends with
 * it, and the page's `via` filter matches it, or its table for a bare
 * table, which every viewer may know (model/deletedItemsPage.ts
 * deletedAsAsked), so an id `me` may not know matches nothing, as an
 * unknown one does. */
export function howOf(me: Doc<'profiles'>, item: Item): string {
  const { via } = item
  if (via === undefined) return 'app'
  return namesCredential(me, item) ? `${via.table}:${via.id}` : via.table
}

/** The deleter line's parts for `sight`'s person (design 1.6, 6.2). */
export function deleterOf(sight: Sight, item: Item): Deleter {
  const { me } = sight
  const id = item.deleted_by
  const profile = id === undefined ? undefined : sight.profiles.get(id)
  const known = sameReference(profile, item)
  const { via } = item
  const named = namesCredential(me, item)
  return {
    you: namesProfile(item, id, me),
    profile_id: known ? id : undefined,
    name: known ? profile.name : undefined,
    kind: via?.table ?? 'app',
    credential_name: named ? via?.name : undefined,
    who: `${known ? id : ''}|${howOf(me, item)}`,
  }
}

/** Where a task of `item` in its project `project` sat. A project item's
 * task: the parent of the item's root project, or the item's root, then
 * the task's project. A task item's task in the root's project: the
 * item's path; in another project, that project after its top-level
 * project, with the names they carry now. */
export function hitPath(sight: Sight, item: Item, project: Item['projects'][number]): string[] {
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
