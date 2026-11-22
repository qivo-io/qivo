/* The row of one Deleted items entry as one person reads it (design 6.2),
 * which deletedItems.item answers and the page (model/deletedItemsPage.ts)
 * builds each entry's row with: rowOf for one seat's sight, rowFor across
 * the login's seats, and their pieces (deleterOf, howOf, hitPath). Each
 * item is judged with the seat in its own organization, never the home
 * one. Rows are projections for that seat (model/deletedItems.ts viewOf),
 * never stored documents. It also holds the metering the page spends its
 * budgets with (Reads, spent, spending). */

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
 * show only what the viewer may see. An organization admin's row shows the
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
 * ItemView).
 */
export async function rowOf(
  ctx: QueryCtx,
  sight: Sight,
  orgName: string,
  item: Item,
): Promise<DeletedRow | null> {
  const { me, memo } = sight
  const view = await viewOf(ctx, memo, me, item)
  // viewOf never shows a purging item; the check narrows the state
  if (view === null || item.state === 'purging') return null
  const ready = item.state === 'ready'
  const block = await restoreBlock(ctx, me, item, memo)
  let blocked: BlockDetail | undefined
  if (ready && block !== null) blocked = await blockDetail(ctx, memo, me, item, block)
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

/** What the row counts: everything when the viewer sees all the item's
 * projects, else only the tasks and sub-projects in the projects they see.
 * A task item has one project, its root's, so only a project item's view
 * leaves projects out. */
function countsOf(item: Item, view: ItemView): Item['counts'] {
  if (view.projects.length === item.projects.length) return item.counts
  return {
    tasks: view.projects.reduce((n, p) => n + p.tasks, 0),
    archived_tasks: view.projects.reduce((n, p) => n + p.archived_tasks, 0),
    subtasks: 0,
    sub_projects: view.projects.filter((p) => p.id !== item.target_id).length,
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
 * the task's project. A task item's task: the item's path, as every task
 * of a task item is in its root's project. */
export function hitPath(sight: Sight, item: Item, project: Item['projects'][number]): string[] {
  if (item.kind === 'project')
    return [
      project.id === item.target_id ? (pathOf(sight, item)[0] ?? '') : item.name,
      project.name,
    ]
  return pathOf(sight, item)
}
