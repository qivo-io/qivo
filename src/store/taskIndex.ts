/* The task view models (P.issues), their handles and delays, kept up to date
   from the workspace rows (store/rowMap.ts) a task at a time.

   `full` shapes every task, as the store did on every repaint before.
   `update` reshapes only the tasks a change can reach: the changed tasks,
   the tasks whose children, parent, links or handles name them, their
   ancestors (a group's dates, completion and delay come from its
   subtasks), and judges again the delays of each owner whose load or
   capacity changed. Test builds check every update against a full build
   (store/planner.ts checkTasks).

   Every list a task holds is in a total order, so the result never depends
   on the order rows arrive in: subtasks by number, then id; links by
   creation time, then id; labels by name, then id; attachments by creation
   time, then id; and the tasks by number, organization and id.

   Each owner's load is the server's rows for tasks this person is not shown
   (`orgLoad`) and a row for each shown task that passes the server's fence
   (convex/lib/loadRows.ts loadRowFor), taken from the rows on screen, so a
   pending hours or owner edit moves its owner's load and delays at once.
   An owner's spans are in the server's total order (canonicalLoad), so the
   weekly sums match the REST and MCP reads whatever order rows arrive in. */

import { delayProjector } from '../../convex/lib/delay'
import { loadRowFor } from '../../convex/lib/loadRows'
import { canonicalLoad } from '../../convex/lib/workload'
import { isoToWeek, TODAY_ISO, TODAY_WEEK, tsToWeek } from '../lib/dates'
import type { DelayInfo } from '../lib/delay'
import { groupSpan, isIssueDone, isIssueGroup } from '../lib/issueGroups'
import type { LoadSpan } from '../lib/workload'
import type { RowMap } from './rowMap'
import type { Row } from './rows'
import { sameData } from './stable'
import { type AttachmentVM, type IssueVM, shapeAttachment, shapeIssue } from './viewModels'

/** One organization-wide load row as the snapshot sends it: one of a task
    this person is not shown, so `issue_id` is null. */
export type LoadRow = {
  issue_id: string | null
  owner_id: string
  start_week: string
  end_week: string
  remaining?: number | null
  remaining_set_at?: string | null
}

/** The rows the tasks are built from, read outside any paint. */
export type TaskSources = {
  issues: RowMap<Row<'issues'>>
  links: RowMap<Row<'issue_links'>>
  attachments: RowMap<Row<'issue_attachments'>>
  labels: RowMap<Row<'labels'>>
  issueLabels: readonly Row<'issue_labels'>[]
  issueSubs: readonly Row<'issue_subscriptions'>[]
  /** the load rows of tasks this person is not shown */
  orgLoad: readonly LoadRow[]
  /** the projects, to tell which are live */
  projects: RowMap<Row<'projects'>>
  /** the people, to tell which organization each belongs to */
  profiles: RowMap<Row<'profiles'>>
  hiddenSubtaskParents: ReadonlySet<string>
  hiddenParentTasks: ReadonlySet<string>
  /** the home organization, whose tasks go by their display key */
  homeOrg: string
  /** the signed-in person's profiles */
  mine: ReadonlySet<string>
  /** each person's plannable hours a week */
  capacity: ReadonlyMap<string, number>
  /** the plannable hours of a person without an entry */
  defaultCapacity: number
}

/** What changed since the last build: the task, link, attachment, project
    and person ids ('all' for every one), and whether the label rows, the
    label and follow lists, the load rows and the hidden flags changed. */
export type TaskChanges = {
  issues: ReadonlySet<string> | 'all'
  links: ReadonlySet<string> | 'all'
  attachments: ReadonlySet<string> | 'all'
  projects: ReadonlySet<string> | 'all'
  profiles: ReadonlySet<string> | 'all'
  labels: boolean
  issueLabels: boolean
  issueSubs: boolean
  orgLoad: boolean
  flags: boolean
}

/* Issue keys are "QN-<num>" (planner.ts ISSUE_PREFIX). */
const ISSUE_PREFIX = 'QN'

const REVERSE: Record<string, string> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates: 'relates',
}

/** -1, 0 or 1 as `a` sorts before, with or after `b`: by `a` and `b`, then
    by their ids. */
const byThenId = (a: string, aId: string, b: string, bId: string) =>
  a < b ? -1 : a > b ? 1 : aId < bId ? -1 : aId > bId ? 1 : 0

/** Creates an empty index. `loadMoved` hears each owner whose load spans an
    update changed (P.weekLoadOf's cache). */
export function createTaskIndex(loadMoved: (owner: string) => void = () => {}) {
  // handles: a home organization task goes by its key, any other by uuid
  const keyToUuid = new Map<string, string>()
  const uuidToKey = new Map<string, string>()
  const uuidToDisplayKey = new Map<string, string>()
  const keyByOrg = new Map<string, Map<string, string>>()
  // the organization each task's display key is filed under in keyByOrg
  const filedOrg = new Map<string, string>()
  // the indexes the view models are shaped from
  const parentOf = new Map<string, string>()
  const children = new Map<string, Set<string>>()
  const linkEnds = new Map<string, [string, string]>()
  const linksOf = new Map<string, Set<string>>()
  const attachmentOf = new Map<string, string>()
  const attachmentsOf = new Map<string, Set<string>>()
  let labelsByIssue = new Map<string, string[]>()
  let subscribed = new Set<string>()
  let subtaskParents = new Set<string>()
  let hiddenParents = new Set<string>()
  // the view models and what is derived from them
  const byUuid = new Map<string, IssueVM>()
  const partial = new Set<string>()
  const delay = new Map<string, DelayInfo>()
  const ownerTasks = new Map<string, Set<string>>()
  const ownerOf = new Map<string, string>()
  // load: each owner's spans, and where they come from: the server's rows
  // of hidden tasks by owner, and the span of each shown task with load,
  // by task and by owner
  let loadByOwner = new Map<string, LoadSpan[]>()
  let hiddenLoad = new Map<string, LoadSpan[]>()
  const shownLoad = new Map<string, { owner: string; span: LoadSpan }>()
  const shownLoadOf = new Map<string, Set<string>>()
  // the live projects and each person's organization, as the fence reads them
  const liveProjects = new Set<string>()
  const orgOf = new Map<string, string>()
  let capacity: ReadonlyMap<string, number> = new Map()
  let issues: IssueVM[] = []
  let issueById: Record<string, IssueVM> = {}
  let src: TaskSources | null = null
  const sources = () => src as TaskSources

  const add = <T>(index: Map<string, Set<T>>, at: string, item: T) => {
    let set = index.get(at)
    if (!set) {
      set = new Set()
      index.set(at, set)
    }
    set.add(item)
  }
  const drop = <T>(index: Map<string, Set<T>>, at: string | undefined, item: T) => {
    if (at === undefined) return
    const set = index.get(at)
    set?.delete(item)
    if (set && !set.size) index.delete(at)
  }

  /** Files task `uuid`'s handles from `row`, or forgets them when it is
      gone. Answers its handle before when the handle moved. */
  function setHandle(uuid: string, row: Row<'issues'> | undefined): string | null {
    const before = uuidToKey.get(uuid)
    if (before !== undefined && keyToUuid.get(before) === uuid) keyToUuid.delete(before)
    const org = filedOrg.get(uuid)
    const display = uuidToDisplayKey.get(uuid)
    const filed = org === undefined ? undefined : keyByOrg.get(org)
    if (org !== undefined && filed && display !== undefined && filed.get(display) === uuid) {
      filed.delete(display)
      if (!filed.size) keyByOrg.delete(org)
    }
    if (!row) {
      uuidToKey.delete(uuid)
      uuidToDisplayKey.delete(uuid)
      filedOrg.delete(uuid)
      return null
    }
    const key = `${ISSUE_PREFIX}-${row.num}`
    const handle = row.org_id && row.org_id === sources().homeOrg ? key : uuid
    let byKey = keyByOrg.get(row.org_id)
    if (!byKey) {
      byKey = new Map()
      keyByOrg.set(row.org_id, byKey)
    }
    byKey.set(key, uuid)
    filedOrg.set(uuid, row.org_id)
    uuidToDisplayKey.set(uuid, key)
    uuidToKey.set(uuid, handle)
    keyToUuid.set(handle, uuid)
    return before !== undefined && before !== handle ? before : null
  }

  /** The handles of task `uuid`'s subtasks, by number, then id. */
  function childKeysOf(uuid: string): string[] | undefined {
    const kids = children.get(uuid)
    if (!kids) return undefined
    const rows: Row<'issues'>[] = []
    for (const id of kids) {
      const row = sources().issues.peek(id)
      if (row) rows.push(row)
    }
    if (!rows.length) return undefined
    rows.sort((a, b) => a.num - b.num || byThenId('', a.id, '', b.id))
    return rows.map((row) => uuidToKey.get(row.id) as string)
  }

  /** Task `uuid`'s links, each other task once, by creation time, then id.
      A link whose other task is not shown is left out. */
  function linkViewsOf(uuid: string): { type: string; id: string }[] | undefined {
    const ids = linksOf.get(uuid)
    if (!ids) return undefined
    const links: Row<'issue_links'>[] = []
    for (const id of ids) {
      const link = sources().links.peek(id)
      if (link) links.push(link)
    }
    links.sort((a, b) => byThenId(a.created_at, a.id, b.created_at, b.id))
    const out: { type: string; id: string }[] = []
    for (const link of links) {
      const source = uuidToKey.get(link.source_id)
      const target = uuidToKey.get(link.target_id)
      if (!source || !target) continue
      const outgoing = link.source_id === uuid
      const other = outgoing ? target : source
      if (out.some((view) => view.id === other)) continue
      out.push({ type: outgoing ? link.type : REVERSE[link.type] || 'relates', id: other })
    }
    return out.length ? out : undefined
  }

  /** Task `uuid`'s attachment views, by creation time, then id. Inline
      images live in the description instead. */
  function attachmentViewsOf(uuid: string): AttachmentVM[] | undefined {
    const ids = attachmentsOf.get(uuid)
    if (!ids) return undefined
    const rows: Row<'issue_attachments'>[] = []
    for (const id of ids) {
      const row = sources().attachments.peek(id)
      if (row && !row.inline) rows.push(row)
    }
    if (!rows.length) return undefined
    rows.sort((a, b) => byThenId(a.created_at, a.id, b.created_at, b.id))
    return rows.map(shapeAttachment)
  }

  /** How many attachment rows task `uuid` has that count toward its cap,
      description images included. An image a description save took out
      (dropped_at) no longer counts (convex/model/descriptionImages.ts). */
  function attachmentCountOf(uuid: string): number | undefined {
    let count = 0
    for (const id of attachmentsOf.get(uuid) ?? []) {
      const row = sources().attachments.peek(id)
      if (row && row.dropped_at === undefined) count++
    }
    return count || undefined
  }

  /** Every task's label ids, by label name, then id. */
  function labelIndex(): Map<string, string[]> {
    const { issueLabels, labels } = sources()
    const out = new Map<string, string[]>()
    for (const row of issueLabels) {
      if (!labels.has(row.label_id)) continue
      const list = out.get(row.issue_id)
      if (list) list.push(row.label_id)
      else out.set(row.issue_id, [row.label_id])
    }
    const name = (id: string) => labels.peek(id)?.name.toLowerCase() ?? ''
    for (const list of out.values())
      if (list.length > 1) list.sort((a, b) => byThenId(name(a), a, name(b), b))
    return out
  }

  /** The tasks the signed-in person follows. One person holds a profile in
      each organization they have a seat in. */
  const followed = () => {
    const { issueSubs, mine } = sources()
    return new Set(issueSubs.filter((s) => mine.has(s.profile_id)).map((s) => s.issue_id))
  }

  /** The span of load row `r`. */
  const spanOf = (r: LoadRow): LoadSpan => ({
    issueUuid: r.issue_id || null,
    start: isoToWeek(r.start_week),
    end: isoToWeek(r.end_week),
    remaining: r.remaining != null ? Number(r.remaining) : 0,
    remainingSet: r.remaining_set_at != null ? tsToWeek(r.remaining_set_at) : null,
  })

  /** The server's load spans of hidden tasks, by owner. A row naming a
      task (an older server sent those too) is left out: the shown tasks'
      load comes from their rows. */
  function hiddenIndex(): Map<string, LoadSpan[]> {
    const out = new Map<string, LoadSpan[]>()
    for (const r of sources().orgLoad) {
      if (r.issue_id) continue
      const list = out.get(r.owner_id)
      if (list) list.push(spanOf(r))
      else out.set(r.owner_id, [spanOf(r)])
    }
    return out
  }

  /** Whether project `id` is live (exists, not archived) as the rows show it. */
  const isLive = (id: string) => {
    const project = sources().projects.peek(id)
    return project !== undefined && !project.archived_at
  }

  /** Files shown task `uuid`'s load span from its row and view model, or
      none. Adds the owners whose load it moved to `moved`. */
  function fileLoad(uuid: string, moved: Set<string>) {
    const row = sources().issues.peek(uuid)
    const it = byUuid.get(uuid)
    const next =
      row && it
        ? loadRowFor(row, {
            isGroup: isIssueGroup(it),
            projectLive: liveProjects.has(row.project_id),
            ownerInOrg: (id) => orgOf.get(id) === row.org_id,
            visible: true,
            staff: false,
            meId: '',
          })
        : null
    const before = shownLoad.get(uuid)
    const span = next && spanOf(next)
    if (before && next && before.owner === next.owner_id && sameData(before.span, span)) return
    if (before) {
      drop(shownLoadOf, before.owner, uuid)
      shownLoad.delete(uuid)
      moved.add(before.owner)
    }
    if (next && span) {
      shownLoad.set(uuid, { owner: next.owner_id, span })
      add(shownLoadOf, next.owner_id, uuid)
      moved.add(next.owner_id)
    }
  }

  /** Owner `owner`'s load spans, hidden and shown, in canonical order. */
  function loadOfOwner(owner: string): LoadSpan[] {
    const spans = [...(hiddenLoad.get(owner) ?? [])]
    for (const uuid of shownLoadOf.get(owner) ?? []) {
      const own = shownLoad.get(uuid)
      if (own) spans.push(own.span)
    }
    return canonicalLoad(spans)
  }

  const shapeCtx = {
    uuidToKey,
    uuidToDisplayKey,
    hiddenSubtaskParents: { has: (uuid: string) => subtaskParents.has(uuid) },
    hiddenParentTasks: { has: (uuid: string) => hiddenParents.has(uuid) },
    linkViews: { get: linkViewsOf },
    childKeys: { get: childKeysOf },
    labelsByIssue: { get: (uuid: string) => labelsByIssue.get(uuid) },
    attByIssue: { get: attachmentViewsOf },
    attachmentCounts: { get: attachmentCountOf },
    subscribedIssues: { has: (uuid: string) => subscribed.has(uuid) },
  }

  /** Task `row`'s view model, before a group's dates (span). */
  const shape = (row: Row<'issues'>) => shapeIssue(row, shapeCtx)

  /** Gives group `it` the span of its visible scheduled leaves at any
      depth (groupSpan, `byId` by handle), so every reader gets those dates.
      The group's stored dates stay dormant in its row, like its status, and
      apply again once its last subtask leaves. A group with subtasks outside
      the view is partial, which limits its delay verdict. */
  function span(it: IssueVM, byId: Readonly<Record<string, IssueVM>>) {
    partial.delete(it.uuid)
    const dates = groupSpan(it, byId)
    if (!dates) return
    it.start = dates.start
    it.end = dates.end
    if (dates.partial) partial.add(it.uuid)
  }

  /** The delay of each task in `uuids`, null for none (`byId` by handle). */
  function judge(uuids: Iterable<string>, byId: Readonly<Record<string, IssueVM>>) {
    const project = delayProjector((owner) => loadByOwner.get(owner) || [], TODAY_WEEK)
    const out = new Map<string, DelayInfo | null>()
    for (const uuid of uuids) {
      const it = byUuid.get(uuid)
      if (!it) continue
      out.set(
        uuid,
        project({
          uuid: it.uuid,
          status: it.status,
          isGroup: isIssueGroup(it),
          isDone: isIssueDone(it, byId),
          partial: partial.has(it.uuid),
          owner: it.owner,
          start: it.start,
          end: it.end,
          dueWeek: it.due ? isoToWeek(it.due) : null,
          duePast: !!it.due && it.due < TODAY_ISO,
          remaining: it.remaining,
          remainingSet: it.remainingSet,
          capacity: (it.owner && capacity.get(it.owner)) || sources().defaultCapacity,
        }),
      )
    }
    return out
  }

  /** Files task `uuid` under its owner, or under none. */
  function fileOwner(uuid: string, owner: string | null | undefined) {
    const before = ownerOf.get(uuid)
    if (before === (owner || undefined)) return
    drop(ownerTasks, before, uuid)
    if (owner) {
      ownerOf.set(uuid, owner)
      add(ownerTasks, owner, uuid)
    } else ownerOf.delete(uuid)
  }

  /** `changed` with every task above, below and linked to it: views read
      a task's family through P (isDone, remainingOf, a blocker's row). */
  function family(changed: Iterable<string>, byId: Readonly<Record<string, IssueVM>>): Set<string> {
    const fresh = new Set<string>()
    const up = new Set<string>()
    const down = new Set<string>()
    const uuidOf = (handle: string | null | undefined) =>
      handle ? (byId[handle]?.uuid ?? null) : null
    for (const id of changed) {
      fresh.add(id)
      // each walk stops where an earlier one went on, so this is linear
      for (let at = uuidOf(byUuid.get(id)?.parent); at && !up.has(at); ) {
        up.add(at)
        fresh.add(at)
        at = uuidOf(byUuid.get(at)?.parent)
      }
      const stack = [id]
      while (stack.length) {
        const at = stack.pop() as string
        if (down.has(at)) continue
        down.add(at)
        fresh.add(at)
        for (const child of byUuid.get(at)?.children ?? []) {
          const uuid = uuidOf(child)
          if (uuid) stack.push(uuid)
        }
      }
    }
    // links are mirrored, so a changed blocker reaches the task it blocks;
    // a copy, because the tasks linked to a linked task did not change
    for (const id of Array.from(fresh))
      for (const link of byUuid.get(id)?.links ?? []) {
        const uuid = uuidOf(link.id)
        if (uuid) fresh.add(uuid)
      }
    return fresh
  }

  /** `list` by number, then organization and id. */
  const sortTasks = (list: IssueVM[]) =>
    list
      .map((it) => ({ it, num: sources().issues.peek(it.uuid)?.num ?? 0 }))
      .sort((a, b) => a.num - b.num || byThenId(a.it.org, a.it.uuid, b.it.org, b.it.uuid))
      .map(({ it }) => it)

  return {
    keyToUuid: keyToUuid as ReadonlyMap<string, string>,
    uuidToKey: uuidToKey as ReadonlyMap<string, string>,
    uuidToDisplayKey: uuidToDisplayKey as ReadonlyMap<string, string>,
    keyByOrg: keyByOrg as ReadonlyMap<string, ReadonlyMap<string, string>>,
    /** The task view models, by number. */
    issues: () => issues,
    /** The task view models by handle. */
    issueById: () => issueById,
    /** Every task's delay, by uuid. */
    delays: delay as ReadonlyMap<string, DelayInfo>,
    /** Each owner's organization-wide load spans. */
    loads: () => loadByOwner as ReadonlyMap<string, LoadSpan[]>,

    /** Builds everything from `from`. A task keeps its view model while
        it, its delay and every task above, below and linked to it hold the
        same data. Answers the handles that moved, old to new. */
    full(from: TaskSources): Map<string, string> {
      src = from
      const handlesBefore = new Map(uuidToKey)
      const before = byUuid.size ? new Map(byUuid) : null
      const delayBefore = new Map(delay)
      for (const map of [keyToUuid, uuidToKey, uuidToDisplayKey, keyByOrg, filedOrg]) map.clear()
      for (const map of [parentOf, children, linkEnds, linksOf, attachmentOf, attachmentsOf])
        map.clear()
      for (const [uuid, row] of from.issues) {
        setHandle(uuid, row)
        if (row.parent_id) {
          parentOf.set(uuid, row.parent_id)
          add(children, row.parent_id, uuid)
        }
      }
      for (const [id, link] of from.links) {
        linkEnds.set(id, [link.source_id, link.target_id])
        add(linksOf, link.source_id, id)
        add(linksOf, link.target_id, id)
      }
      for (const [id, att] of from.attachments) {
        attachmentOf.set(id, att.issue_id)
        add(attachmentsOf, att.issue_id, id)
      }
      labelsByIssue = labelIndex()
      subscribed = followed()
      subtaskParents = new Set(from.hiddenSubtaskParents)
      hiddenParents = new Set(from.hiddenParentTasks)
      capacity = from.capacity
      byUuid.clear()
      partial.clear()
      for (const [uuid, row] of from.issues) byUuid.set(uuid, shape(row))
      const byId: Record<string, IssueVM> = {}
      for (const it of byUuid.values()) byId[it.id] = it
      for (const it of byUuid.values()) span(it, byId)
      liveProjects.clear()
      for (const id of from.projects.keys()) if (isLive(id)) liveProjects.add(id)
      orgOf.clear()
      for (const [id, person] of from.profiles) orgOf.set(id, person.org_id)
      hiddenLoad = hiddenIndex()
      shownLoad.clear()
      shownLoadOf.clear()
      const loaded = new Set<string>(hiddenLoad.keys())
      for (const uuid of byUuid.keys()) fileLoad(uuid, loaded)
      loadByOwner = new Map()
      for (const owner of loaded) loadByOwner.set(owner, loadOfOwner(owner))
      const judged = judge(byUuid.keys(), byId)
      delay.clear()
      for (const [uuid, info] of judged) if (info) delay.set(uuid, info)
      ownerTasks.clear()
      ownerOf.clear()
      for (const it of byUuid.values()) fileOwner(it.uuid, it.owner)
      const sorted = sortTasks([...byUuid.values()])
      if (before) {
        const changed = sorted
          .filter((it) => {
            const prev = before.get(it.uuid)
            return (
              !prev ||
              !sameData(prev, it) ||
              !sameData(delayBefore.get(it.uuid), delay.get(it.uuid))
            )
          })
          .map((it) => it.uuid)
        const fresh = family(changed, byId)
        for (const [uuid, prev] of before)
          if (byUuid.has(uuid) && !fresh.has(uuid)) byUuid.set(uuid, prev)
        const kept = sorted.map((it) => byUuid.get(it.uuid) as IssueVM)
        if (kept.length !== issues.length || kept.some((it, i) => it !== issues[i])) {
          issues = kept
          issueById = {}
          for (const it of issues) issueById[it.id] = it
        }
      } else {
        issues = sorted
        issueById = byId
      }
      const moved = new Map<string, string>()
      for (const [uuid, handle] of handlesBefore) {
        const now = uuidToKey.get(uuid)
        if (now && now !== handle) moved.set(handle, now)
      }
      return moved
    },

    /** Brings everything up to date with `changes` since the last build,
        reshaping only the tasks they reach. Answers the handles that moved,
        old to new, or null without a change when it takes a full build
        (`full`) instead. */
    update(from: TaskSources, changes: TaskChanges): Map<string, string> | null {
      if (!src || from.homeOrg !== src.homeOrg) return null
      if (changes.issues === 'all' || changes.links === 'all' || changes.attachments === 'all')
        return null
      // more than this many changed tasks shape faster in one full build
      const most = Math.max(64, byUuid.size / 4)
      if (changes.issues.size > most) return null
      src = from
      const moved = new Map<string, string>()
      // the tasks to shape again
      const dirty = new Set<string>()
      /** Marks the tasks that name task `uuid`: its parent, subtasks and
          linked tasks. */
      const namers = (uuid: string) => {
        const parent = parentOf.get(uuid)
        if (parent) dirty.add(parent)
        for (const child of children.get(uuid) ?? []) dirty.add(child)
        for (const id of linksOf.get(uuid) ?? [])
          for (const end of linkEnds.get(id) ?? []) dirty.add(end)
      }
      // the tasks gone first, so a handle that passed to another task
      // ends up with that one
      const ordered = [...changes.issues].sort(
        (a, b) => Number(from.issues.has(a)) - Number(from.issues.has(b)),
      )
      for (const uuid of ordered) {
        const row = from.issues.peek(uuid)
        dirty.add(uuid)
        const parent = row?.parent_id
        const oldParent = parentOf.get(uuid)
        if (oldParent !== parent) {
          if (oldParent) dirty.add(oldParent)
          drop(children, oldParent, uuid)
          if (parent) {
            parentOf.set(uuid, parent)
            add(children, parent, uuid)
            dirty.add(parent)
          } else parentOf.delete(uuid)
        }
        const had = uuidToKey.has(uuid)
        const from_ = setHandle(uuid, row)
        if (from_ !== null) moved.set(from_, uuidToKey.get(uuid) as string)
        if (from_ !== null || had !== !!row) namers(uuid)
      }
      for (const id of changes.links) {
        const ends = linkEnds.get(id)
        if (ends) {
          for (const end of ends) {
            drop(linksOf, end, id)
            dirty.add(end)
          }
          linkEnds.delete(id)
        }
        const link = from.links.peek(id)
        if (link) {
          linkEnds.set(id, [link.source_id, link.target_id])
          add(linksOf, link.source_id, id)
          add(linksOf, link.target_id, id)
          dirty.add(link.source_id)
          dirty.add(link.target_id)
        }
      }
      for (const id of changes.attachments) {
        const task = attachmentOf.get(id)
        if (task !== undefined) {
          drop(attachmentsOf, task, id)
          attachmentOf.delete(id)
          dirty.add(task)
        }
        const att = from.attachments.peek(id)
        if (att) {
          attachmentOf.set(id, att.issue_id)
          add(attachmentsOf, att.issue_id, id)
          dirty.add(att.issue_id)
        }
      }
      if (changes.labels || changes.issueLabels) {
        const next = labelIndex()
        for (const uuid of new Set([...labelsByIssue.keys(), ...next.keys()]))
          if (!sameData(labelsByIssue.get(uuid), next.get(uuid))) dirty.add(uuid)
        labelsByIssue = next
      }
      if (changes.issueSubs) {
        const next = followed()
        for (const uuid of next) if (!subscribed.has(uuid)) dirty.add(uuid)
        for (const uuid of subscribed) if (!next.has(uuid)) dirty.add(uuid)
        subscribed = next
      }
      if (changes.flags) {
        const pairs = [
          [from.hiddenSubtaskParents, subtaskParents],
          [from.hiddenParentTasks, hiddenParents],
        ] as const
        for (const [now, before] of pairs) {
          for (const uuid of now) if (!before.has(uuid)) dirty.add(uuid)
          for (const uuid of before) if (!now.has(uuid)) dirty.add(uuid)
        }
        subtaskParents = new Set(from.hiddenSubtaskParents)
        hiddenParents = new Set(from.hiddenParentTasks)
      }
      // the owners whose load may have moved, and the shown tasks whose
      // load row may have changed beside the reshaped ones
      const loadOwners = new Set<string>()
      const recheck = new Set<string>()
      if (changes.orgLoad) {
        const next = hiddenIndex()
        for (const owner of new Set([...hiddenLoad.keys(), ...next.keys()]))
          if (!sameData(hiddenLoad.get(owner), next.get(owner))) loadOwners.add(owner)
        hiddenLoad = next
      }
      // a project that turned live or stopped being so moves its tasks' load
      const projectIds = changes.projects === 'all' ? from.projects.keys() : changes.projects
      const turned = new Set<string>()
      for (const id of [...projectIds, ...(changes.projects === 'all' ? liveProjects : [])]) {
        if (isLive(id) === liveProjects.has(id)) continue
        turned.add(id)
        if (liveProjects.has(id)) liveProjects.delete(id)
        else liveProjects.add(id)
      }
      if (turned.size)
        for (const [uuid, row] of from.issues) if (turned.has(row.project_id)) recheck.add(uuid)
      // so does a person who joined or left an organization
      const personIds =
        changes.profiles === 'all' ? [...orgOf.keys(), ...from.profiles.keys()] : changes.profiles
      for (const id of personIds) {
        const org = from.profiles.peek(id)?.org_id
        if (org === orgOf.get(id)) continue
        if (org === undefined) orgOf.delete(id)
        else orgOf.set(id, org)
        for (const uuid of ownerTasks.get(id) ?? []) recheck.add(uuid)
      }
      // the owners whose delays move with their load or capacity
      const owners = new Set<string>()
      if (from.capacity !== capacity) {
        for (const owner of new Set([...capacity.keys(), ...from.capacity.keys()]))
          if (capacity.get(owner) !== from.capacity.get(owner)) owners.add(owner)
        capacity = from.capacity
      }
      // a group's dates, completion and delay follow its subtasks
      for (const uuid of Array.from(dirty))
        for (let at = parentOf.get(uuid); at && !dirty.has(at); at = parentOf.get(at)) dirty.add(at)
      if (!dirty.size && !owners.size && !recheck.size && !loadOwners.size) return moved

      // shape the dirty tasks again, against a copy of the handle index
      const byId: Record<string, IssueVM> = { ...issueById }
      const shaped = new Map<string, IssueVM>()
      const before = new Map<string, IssueVM | undefined>()
      // tasks came or went, or one's number changed (a create's preview
      // number), so the order by number must be taken again
      let reorder = false
      for (const uuid of dirty) {
        const prev = byUuid.get(uuid)
        before.set(uuid, prev)
        if (prev && byId[prev.id] === prev) delete byId[prev.id]
        const row = from.issues.peek(uuid)
        if (!row) {
          if (prev) reorder = true
          byUuid.delete(uuid)
          partial.delete(uuid)
          delay.delete(uuid)
          fileOwner(uuid, undefined)
          continue
        }
        const it = shape(row)
        if (!prev || prev.key !== it.key) reorder = true
        shaped.set(uuid, it)
        byUuid.set(uuid, it)
      }
      for (const it of shaped.values()) byId[it.id] = it
      for (const it of shaped.values()) span(it, byId)
      for (const it of shaped.values()) fileOwner(it.uuid, it.owner)
      // load: the reshaped and gone tasks' rows, and those a project or
      // person change reaches
      for (const uuid of dirty) fileLoad(uuid, loadOwners)
      for (const uuid of recheck) if (!dirty.has(uuid)) fileLoad(uuid, loadOwners)
      for (const owner of loadOwners) {
        const now = loadOfOwner(owner)
        const before = loadByOwner.get(owner)
        if (before ? sameData(before, now) : !now.length) continue
        if (now.length) loadByOwner.set(owner, now)
        else loadByOwner.delete(owner)
        owners.add(owner)
        loadMoved(owner)
      }
      // delays: the reshaped tasks, and every task of an owner that moved
      const judged = new Set(shaped.keys())
      for (const owner of owners) for (const uuid of ownerTasks.get(owner) ?? []) judged.add(uuid)
      const changed = new Set<string>()
      for (const [uuid, info] of judge(judged, byId)) {
        if (!sameData(delay.get(uuid), info ?? undefined)) changed.add(uuid)
        if (info) delay.set(uuid, info)
        else delay.delete(uuid)
      }
      for (const [uuid, it] of shaped) {
        const prev = before.get(uuid)
        if (!prev || !sameData(prev, it)) changed.add(uuid)
      }
      if (!changed.size && !reorder) {
        // nothing a view reads changed: every task keeps its object
        for (const [uuid, prev] of before) if (prev) byUuid.set(uuid, prev)
        return moved
      }
      // every task above, below and linked to a changed one takes a new
      // object; the other reshaped ones keep theirs
      const fresh = family(changed, byId)
      const reshaped: IssueVM[] = []
      for (const uuid of fresh) {
        if (shaped.has(uuid) || !byUuid.has(uuid)) continue
        const row = from.issues.peek(uuid)
        if (!row) continue
        const it = shape(row)
        shaped.set(uuid, it)
        byUuid.set(uuid, it)
        byId[it.id] = it
        reshaped.push(it)
      }
      for (const it of reshaped) span(it, byId)
      for (const [uuid, prev] of before) {
        if (!prev || fresh.has(uuid) || !byUuid.has(uuid)) continue
        byUuid.set(uuid, prev)
        byId[prev.id] = prev
      }
      issues = reorder
        ? sortTasks([...byUuid.values()])
        : issues.map((it) => byUuid.get(it.uuid) as IssueVM)
      issueById = byId
      return moved
    },

    /** Forgets every task (a disposed demo). */
    clear() {
      for (const map of [
        keyToUuid,
        uuidToKey,
        uuidToDisplayKey,
        keyByOrg,
        filedOrg,
        parentOf,
        children,
        linkEnds,
        linksOf,
        attachmentOf,
        attachmentsOf,
        byUuid,
        delay,
        ownerTasks,
        ownerOf,
        loadByOwner,
        hiddenLoad,
        shownLoad,
        shownLoadOf,
        orgOf,
      ] as Map<string, unknown>[])
        map.clear()
      liveProjects.clear()
      labelsByIssue = new Map()
      subscribed = new Set()
      subtaskParents = new Set()
      hiddenParents = new Set()
      capacity = new Map()
      partial.clear()
      issues = []
      issueById = {}
      src = null
    },
  }
}

export type TaskIndex = ReturnType<typeof createTaskIndex>
