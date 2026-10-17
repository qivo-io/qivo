/* Deleted items as people read them (design 6.2): the Settings list and the
 * search for tasks inside deleted projects. Both read every active seat of
 * the login, because Deleted items spans organizations as Archived projects
 * does, and judge each item with the seat in its own organization, never
 * the home one. Rows are projections for that seat (model/deletedItems.ts
 * viewOf), never stored documents.
 *
 * A seat reads only the index ranges that can hold what it sees. An admin
 * reads the organization's items newest first. Anyone else reads their own
 * deletes, the projects they led that are now in Deleted items (stored
 * leads, deleted_rows.by_org_lead), and for each live project they lead,
 * the items under it (by_org_parent for a top-level project, by_org_project
 * for a sub-project) and the task items with a subtask in it
 * (deleted_tasks.by_org_cross_project). Every range is read newest first up
 * to LIST.cap items, and a seat lists at most LIST.cap; `capped` says when
 * more may exist. A `deleted_by` filter narrows every seat to one person's
 * deletes, so an admin can reach older ones. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import type { CredentialTable } from '../lib/enums'
import { issueKey } from '../lib/taskRefs'
import {
  type BlockDetail,
  blockDetail,
  type ItemView,
  namesProfile,
  restoreBlock,
  type Sight,
  sameReference,
  sightOf,
  viewOf,
} from './deletedItems'

type Item = Doc<'deleted_items'>

/** The most items one organization lists. A mutable object, so tests can
 * lower it. */
export const LIST = { cap: 2000 }

/** The most hits one search returns, and the search results it looks at per
 * organization to find them. */
export const MATCHES = { max: 50, scan: 256 }

/** Who deleted an item, as one viewer may know it (design 1.6). A
 * personal token's or connected app's name shows only to organization
 * admins and to its owner, the deleter; an agent key's to everyone. `who`
 * is an opaque key for grouping rows by person and credential: it names the
 * credential only to those who may see its name. */
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

/** A task inside a deleted project that a search found, with what the row
 * of its project item says: it can only come back with that item. */
export type DeletedMatch = {
  item_id: string
  org_id: string
  org_name: string
  key: string
  title: string
  archived: boolean
  path: string[]
  deleted_at: string
  deleter: Deleter
  state: DeletedRow['state']
  can_restore: boolean
  blocked?: BlockDetail
}

const newestFirst = (
  a: { deleted_at: string; id: string },
  b: { deleted_at: string; id: string },
) => (a.deleted_at === b.deleted_at ? (a.id < b.id ? 1 : -1) : a.deleted_at < b.deleted_at ? 1 : -1)

/** The Deleted items of every seat in `seats`, newest first. */
export async function listFor(
  ctx: QueryCtx,
  seats: Iterable<Doc<'profiles'>>,
  deletedBy: string | undefined,
): Promise<{ items: DeletedRow[]; capped: boolean }> {
  const items: DeletedRow[] = []
  let capped = false
  for (const me of seats) {
    const seat = await seatList(ctx, me, deletedBy)
    items.push(...seat.items)
    capped ||= seat.capped
  }
  return { items: items.sort(newestFirst), capped }
}

async function seatList(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  deletedBy: string | undefined,
): Promise<{ items: DeletedRow[]; capped: boolean }> {
  const sight = await sightOf(ctx, me)
  const orgName = (await byId(ctx, 'organizations', me.org_id))?.name ?? ''
  const { items, truncated } = await candidatesOf(ctx, sight, deletedBy)
  const rows: DeletedRow[] = []
  for (const item of items) {
    const row = await rowOf(ctx, sight, orgName, item)
    if (row !== null) rows.push(row)
  }
  rows.sort(newestFirst)
  return { items: rows.slice(0, LIST.cap), capped: truncated || rows.length > LIST.cap }
}

/** The items `sight`'s person may see, from the ranges that can hold them
 * (see the file comment). `truncated` when a range held more than it read. */
async function candidatesOf(
  ctx: QueryCtx,
  sight: Sight,
  deletedBy: string | undefined,
): Promise<{ items: Item[]; truncated: boolean }> {
  const { me, levels } = sight
  const org = me.org_id
  const found = new Map<string, Item>()
  let truncated = false
  const take = async <R>(rows: { take: (n: number) => Promise<R[]> }): Promise<R[]> => {
    const read = await rows.take(LIST.cap + 1)
    if (read.length > LIST.cap) truncated = true
    return read
  }
  const items = ctx.db.query('deleted_items')
  const add = (rows: Item[]) => {
    for (const item of rows) found.set(item.id, item)
  }
  const addIds = async (ids: Iterable<string>) => {
    for (const id of ids) {
      if (found.has(id)) continue
      const item = await byId(ctx, 'deleted_items', id)
      if (item !== null) found.set(id, item)
    }
  }
  if (deletedBy !== undefined || me.org_role === 'admin') {
    add(
      await take(
        deletedBy === undefined
          ? items.withIndex('by_org_deleted', (q) => q.eq('org_id', org)).order('desc')
          : items
              .withIndex('by_org_deleter', (q) => q.eq('org_id', org).eq('deleted_by', deletedBy))
              .order('desc'),
      ),
    )
    return { items: [...found.values()], truncated }
  }
  add(
    await take(
      items
        .withIndex('by_org_deleter', (q) => q.eq('org_id', org).eq('deleted_by', me.id))
        .order('desc'),
    ),
  )
  const led = await take(
    ctx.db
      .query('deleted_rows')
      .withIndex('by_org_lead', (q) => q.eq('org_id', org).eq('lead_id', me.id)),
  )
  await addIds(led.map((row) => row.item_id))
  const leads = (p: Doc<'projects'> | undefined) => p !== undefined && levels.levelOf(p) === 'lead'
  for (const p of sight.projects.values()) {
    if (p.type === 'meta') {
      if (leads(p))
        add(
          await take(
            items
              .withIndex('by_org_parent', (q) => q.eq('org_id', org).eq('parent_project_id', p.id))
              .order('desc'),
          ),
        )
      continue
    }
    const topLed = p.parent_id !== undefined && leads(sight.projects.get(p.parent_id))
    if (!leads(p) && !topLed) continue
    if (!topLed)
      add(
        await take(
          items
            .withIndex('by_org_project', (q) => q.eq('org_id', org).eq('project_id', p.id))
            .order('desc'),
        ),
      )
    const cross = await take(
      ctx.db
        .query('deleted_tasks')
        .withIndex('by_org_cross_project', (q) => q.eq('org_id', org).eq('cross_project_id', p.id))
        .order('desc'),
    )
    await addIds(cross.map((task) => task.item_id))
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
    can_purge: me.org_role === 'admin' && (ready || item.state === 'stuck'),
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
 * can see. */
const shownTask = (ctx: QueryCtx, item: Item, view: ItemView) =>
  ctx.db
    .query('deleted_tasks')
    .withIndex('by_item', (q) => q.eq('item_id', item.id))
    .filter((q) => q.or(...view.projects.map((p) => q.eq(q.field('project_id'), p.id))))
    .first()

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
    who: `${id ?? ''}|${how}`,
  }
}

/** A task reference as the search box takes it: QN-482 or a bare 482. */
const TASK_REF = /^(?:QN-)?(\d+)$/i

/**
 * The tasks inside deleted projects that `text` names, by task key or by
 * title (deleted_tasks search_title), at most MATCHES.max, for every seat in
 * `seats`. Only tasks of project items the seat sees, in projects their
 * level reaches, count; task items are listed whole by listFor already.
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
  for (const me of seats) {
    if (out.length >= MATCHES.max) break
    const org = me.org_id
    const hits = ctx.db.query('deleted_tasks')
    const found = [
      ...(ref === null
        ? []
        : await hits
            .withIndex('by_org_num', (q) => q.eq('org_id', org).eq('num', Number(ref[1])))
            .collect()),
      ...(await hits
        .withSearchIndex('search_title', (q) => q.search('title', query).eq('org_id', org))
        .take(MATCHES.scan)),
    ]
    if (found.length === 0) continue
    const sight = await sightOf(ctx, me)
    const orgName = (await byId(ctx, 'organizations', org))?.name ?? ''
    const items = new Map<string, Promise<{ item: Item; view: ItemView } | null>>()
    const seen = new Set<string>()
    for (const task of found) {
      if (out.length >= MATCHES.max) break
      if (seen.has(task.task_id)) continue
      seen.add(task.task_id)
      let read = items.get(task.item_id)
      if (read === undefined) {
        read = visibleProjectItem(ctx, sight, task.item_id)
        items.set(task.item_id, read)
      }
      const visible = await read
      const project = visible?.view.projects.find((p) => p.id === task.project_id)
      if (visible === null || project === undefined) continue
      const { item } = visible
      // viewOf never shows a purging item; the check narrows the state
      if (item.state === 'purging') continue
      const block = await restoreBlock(ctx, me, item, sight.memo)
      const ready = item.state === 'ready'
      out.push({
        item_id: item.id,
        org_id: org,
        org_name: orgName,
        key: issueKey(task.num),
        title: task.title,
        archived: task.archived,
        path: [
          project.id === item.target_id ? (pathOf(sight, item)[0] ?? '') : item.name,
          project.name,
        ],
        deleted_at: item.deleted_at,
        deleter: deleterOf(sight, item),
        state: item.state,
        can_restore: ready && block === null,
        blocked:
          ready && block !== null ? await blockDetail(ctx, sight.memo, item, block) : undefined,
      })
    }
  }
  return out
}

/** Project item `id` with what `sight`'s person sees of it, when they see it. */
async function visibleProjectItem(ctx: QueryCtx, sight: Sight, id: string) {
  const item = await byId(ctx, 'deleted_items', id)
  if (item === null || item.kind !== 'project') return null
  const view = await viewOf(ctx, sight.memo, sight.me, item)
  return view === null ? null : { item, view }
}
