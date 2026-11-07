/* What the Deleted items page says about what the server answers, kept out
   of the page so it stays pure: the lines of a page in the server's order,
   the subtitle from each seat's role, the notes and end lines, the row
   texts (the deleter line, the suffix after a title, the sentence of a row
   that cannot be restored), how a long run of one person's deletes folds
   within a page, the Restore window's texts and plan, and the sentences of
   a restore or Delete now as the store runs it (store/planner.ts
   runDeletedItems). Nothing here sorts, filters or counts entries; types
   come from deletedItems.page, roles, people, purgeSummary and item, so
   the page follows the server's projection
   (convex/model/deletedItemsPage.ts, deletedItemsList.ts and
   deletedItemsChoices.ts). It imports nothing from the store. */

import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { roundsOf } from './batchRunner'
import { dayInSentence, stretch, timeSpan } from './deletedTime'

/** One page of Deleted items (deletedItems.page). */
export type DeletedPage = FunctionReturnType<typeof api.deletedItems.page>
/** One entry of a page: an item, or a task the search or the assignee
    filter found inside one. */
export type DeletedEntry = DeletedPage['entries'][number]
/** The task an entry found, where its item's row does not show it. */
export type DeletedHit = NonNullable<DeletedEntry['task']>
/** One item's row, as a page's `items` and deletedItems.item give it. */
export type DeletedRow = DeletedPage['items'][number]
export type Deleter = DeletedRow['deleter']
export type BlockDetail = NonNullable<DeletedRow['blocked']>
/** One seat's role in Deleted items (deletedItems.roles). */
export type DeletedRole = FunctionReturnType<typeof api.deletedItems.roles>[number]
/** One batch of an organization's people (deletedItems.people). */
export type DeletedPeople = FunctionReturnType<typeof api.deletedItems.people>
export type DeletedPerson = Extract<DeletedPeople, { state: 'ready' }>['rows'][number]
/** What Delete now deletes with a project item (deletedItems.purgeSummary). */
export type PurgeSummary = NonNullable<FunctionReturnType<typeof api.deletedItems.purgeSummary>>
/** Why the server refused to restore one item. */
export type RestoreRefusal = FunctionReturnType<
  typeof api.deletedItems.restore
>['refused'][number]['reason']
/** Why the server refused to delete one item for good. */
export type PurgeRefusal = FunctionReturnType<
  typeof api.deletedItems.purge
>['refused'][number]['reason']

/** The most entries one page holds, the server's DELETED_PAGE.rows, which
    src/lib/deletedItems.test.ts pins. A page with fewer and a cursor
    stopped early. */
export const PAGE_ROWS = 25

/** The most items one selection holds, kept across the pages of one list:
    the open and Done tasks of one project with all its sub-projects at the
    design size, 40 calls of 25. A mutable object, so tests can lower it. */
export const SELECT_MOST = { items: 1_000 }

/** One line of the list: an item, or a task an entry found inside an item
    (`hit`), a task of a project item or a subtask of a task item, which
    acts on that item. */
export type Line =
  | { kind: 'item'; row: DeletedRow }
  | { kind: 'hit'; hit: DeletedHit; item: DeletedRow }

/** The item a line acts on. */
export const lineItem = (line: Line): DeletedRow => (line.kind === 'item' ? line.row : line.item)

/** The key of a line, which also names it for focus. */
export const lineKey = (line: Line): string =>
  line.kind === 'item' ? line.row.id : `${line.item.id}:${line.hit.key}`

/** The lines of `page` in the server's order. An entry without a task is
    its item's line, one with a task a hit line. An entry whose item the
    page's `items` lacks is left out, never shown without its row. */
export function linesOf(
  page: { entries: readonly DeletedEntry[]; items: readonly DeletedRow[] } | null,
): Line[] {
  if (page === null) return []
  const rows = new Map(page.items.map((row) => [row.id, row]))
  return page.entries.flatMap((entry): Line[] => {
    const row = rows.get(entry.item_id)
    if (row === undefined) return []
    return entry.task === undefined
      ? [{ kind: 'item', row }]
      : [{ kind: 'hit', hit: entry.task, item: row }]
  })
}

/** "2 subtasks", "1 task", "2,000 items". */
export function plural(n: number, noun: string, many = `${noun}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun : many}`
}

/** "A", "A and B", "A, B and C". */
export function andList(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/* ------------------------------------------------- what the page says */

/** The storage sentence of an admin's subtitle (billing storage, row 421). */
const STORAGE = 'Their files count toward its storage until they are deleted for good.'

/**
 * The page's subtitle for the roles of the seats it reads, one seat's, or
 * with a scope its organization's, or for several seats of different roles
 * one sentence for all. Empty while no role is known.
 */
export function subtitleOf(roles: readonly Pick<DeletedRole, 'role'>[]): string {
  const has = new Set(roles.map((r) => r.role))
  if (has.size === 0) return ''
  if (has.size === 1) {
    if (has.has('admin')) return `Tasks and projects deleted in your organization. ${STORAGE}`
    if (has.has('lead'))
      return 'Tasks and projects you deleted, and those deleted in projects you lead.'
    return 'Tasks and projects you deleted.'
  }
  if (!has.has('admin'))
    return 'Tasks and projects you deleted, and those deleted in projects you lead.'
  const what = has.has('lead')
    ? 'Tasks and projects deleted in the organizations you administer, those you deleted and those deleted in projects you lead.'
    : 'Tasks and projects deleted in the organizations you administer, and those you deleted.'
  return `${what} Files of items deleted in an organization you administer count toward its storage until they are deleted for good.`
}

/** The notes above a page, from its answer: a page without a scope, a
    scope too wide to list, entries a stopped read may have missed, the
    standing note of a search that does not read every task, and rows from
    before this release. Each one only where the answer says it. */
export function notesOf(
  page: Pick<DeletedPage, 'entries' | 'scope_needed' | 'missing' | 'legacy'> | null,
  searching: boolean,
): { key: string; text: string }[] {
  if (page === null) return []
  const notes: { key: string; text: string }[] = []
  if (page.scope_needed && (page.entries.length > 0 || searching))
    notes.push({ key: 'scope', text: 'Deleted tasks show once you choose projects.' })
  if (page.missing === 'reads' && page.entries.length > 0)
    notes.push({
      key: 'reads',
      text: 'Qivo checked part of Deleted items, so some items on this page may be missing.',
    })
  if (page.missing === 'matches')
    notes.push({ key: 'matches', text: 'Some matching tasks might not be listed.' })
  if (page.legacy)
    notes.push({
      key: 'legacy',
      text: 'Tasks deleted before this version of Qivo are found by their key or title only, and Assigned to may miss them.',
    })
  return notes
}

/** The line of a page whose answer holds no rows to show: a scope too wide
    to list, without Retry, or a part Qivo could not check, with it. */
export function heldOf(page: Pick<DeletedPage, 'too_wide'> | null): {
  line: string
  retry: boolean
} {
  if (page?.too_wide)
    return {
      line: "Qivo can't list the deleted items of these projects together. Choose fewer projects.",
      retry: false,
    }
  return { line: "Qivo couldn't check the deleted items here. Choose fewer projects.", retry: true }
}

/** Whether an answer has no rows to show (usePagedPages `batch` null): a
    scope too wide to list, or a first part whose sources Qivo could not
    open, which answers no entry, no cursor and missing reads. */
export const heldAnswer = (
  page: Pick<DeletedPage, 'entries' | 'next_cursor' | 'too_wide' | 'missing'>,
): boolean =>
  page.too_wide === true ||
  (page.entries.length === 0 && page.next_cursor === null && page.missing === 'reads')

/** What Delete now says of the items deleted from a project earlier, from
    its count (deletedItems.purgeSummary): undefined while counting, null
    or 'failed' when it could not count. `ready` says Delete for good may
    be pressed. */
export function alongText(summary: PurgeSummary | null | undefined | 'failed'): {
  text: string
  ready: boolean
} {
  if (summary === undefined)
    return { text: ' Counting the items deleted from the project earlier…', ready: false }
  if (summary === null || summary === 'failed')
    return {
      text: " Qivo couldn't count the items deleted from the project earlier. Deleting it for good deletes them too.",
      ready: true,
    }
  if (summary.exact)
    return {
      text:
        summary.along === 0
          ? ''
          : ` It also deletes ${plural(summary.along, 'item')} deleted from the project earlier.`,
      ready: true,
    }
  return {
    text:
      summary.along === 0
        ? ' It also deletes any items deleted from the project earlier.'
        : ` It also deletes at least ${plural(summary.along, 'item')} deleted from the project earlier.`,
    ready: true,
  }
}

const CREDENTIALS: Record<Exclude<Deleter['kind'], 'app'>, { noun: string; article: string }> = {
  agent_keys: { noun: 'agent key', article: 'an' },
  mcp_tokens: { noun: 'personal token', article: 'a' },
  oauth_connections: { noun: 'connected app', article: 'a' },
}

/** "You", the deleter's name, or "Someone" once their profile is gone. */
export function deleterName(deleter: Deleter): string {
  if (deleter.you) return 'You'
  return deleter.name ?? 'Someone'
}

/** The name inside a sentence, where "you" and "someone" lose their capital. */
export function deleterInSentence(deleter: Deleter): string {
  const name = deleterName(deleter)
  return deleter.you || deleter.name === undefined ? name.toLowerCase() : name
}

/**
 * How the deleter reached Qivo, after their name, for a delete over REST or
 * MCP: " via Cursor, personal token" on a row, " via Cursor (personal token)"
 * in a sentence, " via Cursor" where the kind is said elsewhere. A name the
 * viewer may not see reads " via a personal token" in every form. Empty for
 * a delete in the app.
 */
export function viaText(deleter: Deleter, form: 'row' | 'sentence' | 'short'): string {
  if (deleter.kind === 'app') return ''
  const { noun, article } = CREDENTIALS[deleter.kind]
  const name = deleter.credential_name
  if (name === undefined) return ` via ${article} ${noun}`
  if (form === 'short') return ` via ${name}`
  return form === 'row' ? ` via ${name}, ${noun}` : ` via ${name} (${noun})`
}

/** Whether a project item is a sub-project. Its path names the parent. */
export const isSubProject = (row: DeletedRow): boolean =>
  row.kind === 'project' && row.path.length > 0

/** What a row says a project item holds, after "project" or after its name:
    "with 2 sub-projects and 48 tasks", "and its 12 tasks" for a
    sub-project, or nothing for an empty one. */
export function projectHolds(row: DeletedRow): string {
  const { tasks, sub_projects } = row.counts
  if (isSubProject(row))
    return tasks === 0 ? '' : tasks === 1 ? 'and its task' : `and its ${plural(tasks, 'task')}`
  const parts = [
    sub_projects > 0 ? plural(sub_projects, 'sub-project') : '',
    tasks > 0 ? plural(tasks, 'task') : '',
  ].filter(Boolean)
  return parts.length ? `with ${parts.join(' and ')}` : ''
}

/** The text after a row's title: "and 2 subtasks" for a task with subtasks,
    what a project holds for a project. A redacted row says nothing. */
export function itemSuffix(row: DeletedRow): string {
  if (row.redacted) return ''
  if (row.kind === 'task')
    return row.counts.subtasks > 0 ? `and ${plural(row.counts.subtasks, 'subtask')}` : ''
  return projectHolds(row)
}

/** The second line's place: "Luma Sensor › Firmware" for a task, "Sub-project
    in Website" for a sub-project, nothing for a top-level project. */
export function placeText(row: DeletedRow): string {
  if (row.kind === 'project') return isSubProject(row) ? `Sub-project in ${row.path[0]}` : ''
  return row.path.filter(Boolean).join(' › ')
}

/** A row or window's name for an item: a task's key, a project's name. */
export const itemName = (row: DeletedRow): string => (row.kind === 'task' ? row.key : row.title)

/**
 * The sentence of a ready row its viewer cannot restore (design 5.3).
 * `holder` names the deleted project that a project_deleted or
 * parent_deleted item waits for, when the list holds it. Null for the
 * redacted row, which says so in its own words.
 */
export function blockedText(blocked: BlockDetail, holder?: string): string | null {
  const project = blocked.project ?? 'its project'
  switch (blocked.reason) {
    case 'view_only':
      return blocked.lead
        ? `You can only view ${project} now. Ask its lead, ${blocked.lead}, to restore it.`
        : `You can only view ${project} now. Ask someone who can edit it to restore it.`
    case 'not_lead':
      // the server names no lead when none passes today's lead rule
      return blocked.lead
        ? `${blocked.project ?? 'This project'} has its own lead, ${blocked.lead}. Ask them or an organization admin to restore it.`
        : `${blocked.project ?? 'This project'} has no lead now. Ask an organization admin to restore it.`
    case 'subtask_project':
      return "A subtask is in a project you can't edit. Ask someone who can edit it to restore it."
    case 'project_archived':
    case 'parent_archived':
      return `Restore ${project} from Archived projects first.`
    case 'project_deleted':
    case 'parent_deleted':
      return holder
        ? `Its project, ${holder}, is in Deleted items too.`
        : 'Its project is in Deleted items too.'
    case 'no_access':
      return null
    default:
      return refusalText(blocked.reason)
  }
}

/** Why one item was not restored or deleted for good, when the row itself
    does not say it (the server answered with a reason the list had not
    shown yet). */
export function refusalText(reason: RestoreRefusal | PurgeRefusal | 'not_found'): string {
  switch (reason) {
    case 'read_only':
      return 'Restoring is paused while the organization is read-only.'
    case 'view_only':
      return 'You can only view its project now.'
    case 'not_lead':
      return "Only the project's lead or an organization admin can restore it."
    case 'subtask_project':
      return "A subtask is in a project you can't edit. Ask someone who can edit it to restore it."
    case 'project_archived':
      return 'Restore its project from Archived projects first.'
    case 'parent_archived':
      return 'Restore its parent project from Archived projects first.'
    case 'project_deleted':
    case 'parent_deleted':
      return 'Its project is in Deleted items too.'
    case 'no_access':
      return "It is in a project you can't open."
    case 'conflict':
      return 'Something now uses its key, so it cannot come back.'
    case 'moving':
      return 'It is still moving to Deleted items.'
    case 'restoring':
      return 'Someone is restoring it.'
    case 'stuck':
      return STUCK_TEXT
    case 'purging':
    case 'not_found':
      return 'It is no longer in Deleted items.'
  }
}

/** The line of an item whose move stopped after its retries (design 3). */
export const STUCK_TEXT = "Couldn't finish moving this item. Delete it now, or contact support."

/** The line of a row whose background steps still run, or null when ready. */
export function stateText(state: DeletedRow['state']): string | null {
  if (state === 'moving') return 'Moving to Deleted items…'
  if (state === 'restoring') return 'Restoring…'
  if (state === 'stuck') return STUCK_TEXT
  return null
}

/** The entries a kind control choice asks for. */
export type KindFilter = 'all' | 'task' | 'project'

/* -------------------------------------------------------------- folding */

/** A run folds when it holds this many task rows or more, shows `shown` of
    them, and holds rows at most `gapMs` apart. */
export const FOLD = { min: 11, shown: 7, gapMs: 10 * 60_000 }

/** What the list draws: a line, the fold line of a run that hides its rest,
    or the Show fewer line after an open run. A page folds its own lines
    only, so a fold never hides rows of another page. */
export type Piece =
  | { kind: 'line'; line: Line }
  | { kind: 'fold'; key: string; run: DeletedRow[]; hidden: DeletedRow[] }
  | { kind: 'fewer'; key: string; run: DeletedRow[] }

const isTaskItem = (line: Line): line is { kind: 'item'; row: DeletedRow } =>
  line.kind === 'item' && line.row.kind === 'task'
const at = (row: DeletedRow) => new Date(row.deleted_at).getTime()

/** The key that keeps a run open across live updates: its `who` and its
    oldest item. */
export const runKey = (run: DeletedRow[]): string =>
  `${run[0]?.deleter.who ?? ''}|${run[run.length - 1]?.id ?? ''}`

/**
 * The list with long runs folded. A run is FOLD.min or more consecutive task
 * rows with the same `who`, each within FOLD.gapMs of the next. A project row
 * or a hit line ends a run. A closed run shows its first FOLD.shown rows
 * and a fold line; a run in `open` shows every row and a Show fewer line.
 */
export function fold(lines: Line[], open: ReadonlySet<string>): Piece[] {
  const pieces: Piece[] = []
  let i = 0
  while (i < lines.length) {
    const first = lines[i]
    if (!isTaskItem(first)) {
      pieces.push({ kind: 'line', line: first })
      i++
      continue
    }
    const run = [first.row]
    let j = i + 1
    for (; j < lines.length; j++) {
      const next = lines[j]
      if (!isTaskItem(next)) break
      const previous = run[run.length - 1]
      if (next.row.deleter.who !== first.row.deleter.who) break
      if (at(previous) - at(next.row) > FOLD.gapMs) break
      run.push(next.row)
    }
    if (run.length < FOLD.min) {
      for (const row of run) pieces.push({ kind: 'line', line: { kind: 'item', row } })
    } else {
      const key = runKey(run)
      const shown = open.has(key) ? run : run.slice(0, FOLD.shown)
      for (const row of shown) pieces.push({ kind: 'line', line: { kind: 'item', row } })
      pieces.push(
        open.has(key)
          ? { kind: 'fewer', key, run }
          : { kind: 'fold', key, run, hidden: run.slice(FOLD.shown) },
      )
    }
    i = j
  }
  return pieces
}

/** The fold line: "and 179 more tasks Daniel Berg deleted via Cursor, today
    14:02 to 14:08". */
export function foldText(hidden: DeletedRow[], now: Date): string {
  const deleter = hidden[0]?.deleter
  if (!deleter) return ''
  const times = hidden.map((row) => new Date(row.deleted_at))
  const span = stretch(times[times.length - 1], times[0], now)
  return `and ${plural(hidden.length, 'more task', 'more tasks')} ${deleterInSentence(deleter)} deleted${viaText(deleter, 'short')}, ${span}`
}

/* ------------------------------------------------------- bulk restoring */

/**
 * The first sentence of the bulk restore window when one person deleted
 * every item the same way on the same day: "Daniel Berg deleted them via
 * Cursor (personal token) today, 14:02 to 14:09." Null otherwise.
 */
export function deleterSentence(rows: readonly DeletedRow[], now: Date): string | null {
  const first = rows[0]
  if (!first) return null
  const times = rows.map((row) => new Date(row.deleted_at))
  const day = dayInSentence(times[0], now)
  if (
    rows.some(
      (row, i) => row.deleter.who !== first.deleter.who || dayInSentence(times[i], now) !== day,
    )
  )
    return null
  const earliest = new Date(Math.min(...times.map((t) => t.getTime())))
  const latest = new Date(Math.max(...times.map((t) => t.getTime())))
  return `${deleterName(first.deleter)} deleted ${rows.length === 1 ? 'it' : 'them'}${viaText(first.deleter, 'sentence')} ${day}, ${timeSpan(earliest, latest)}.`
}

/** One line of the bulk restore window's list, a place items go back to. */
export type Destination = { key: string; kind: 'task' | 'project'; name: string; count: string }

/**
 * Where restored items go, for the bulk restore window: each project item on
 * its own line ("Field trial Q3", "project with 2 sub-projects and 48
 * tasks"), then the task items grouped by the project they go back to, most
 * first ("Luma Sensor › Firmware", "74 tasks" or "3 tasks and 2 subtasks").
 */
export function destinations(rows: readonly DeletedRow[]): Destination[] {
  const projects: Destination[] = rows
    .filter((row) => row.kind === 'project')
    .map((row) => {
      const sub = isSubProject(row)
      const { tasks } = row.counts
      const holds = sub ? (tasks > 0 ? `with ${plural(tasks, 'task')}` : '') : projectHolds(row)
      const noun = sub ? 'sub-project' : 'project'
      return {
        key: row.id,
        kind: 'project',
        name: sub ? `${row.path[0]} › ${row.title}` : row.title,
        count: holds ? `${noun} ${holds}` : noun,
      }
    })
  const groups = new Map<string, { name: string; tasks: number; subtasks: number }>()
  for (const row of rows) {
    if (row.kind !== 'task') continue
    const name = placeText(row)
    const key = `${row.org_id}|${name}`
    const group = groups.get(key) ?? { name, tasks: 0, subtasks: 0 }
    group.tasks++
    group.subtasks += row.counts.subtasks
    groups.set(key, group)
  }
  const tasks: Destination[] = [...groups.entries()]
    .sort(([, a], [, b]) => b.tasks - a.tasks || a.name.localeCompare(b.name))
    .map(([key, group]) => ({
      key,
      kind: 'task',
      name: group.name,
      count: group.subtasks
        ? `${plural(group.tasks, 'task')} and ${plural(group.subtasks, 'subtask')}`
        : plural(group.tasks, 'task'),
    }))
  return [...projects, ...tasks]
}

/* ------------------------------------------------- restoring in steps */

/** What one restore or Delete now did over every call it took (P.restoreDeletedItems,
    P.purgeDeletedItems): the ids the server restored or deleted for good, the
    ids it refused with their reason, the ids it deferred until a project item
    of the same call is back, and the ids of calls it refused whole, with the
    sentence to show for them. `stepping` are the restored ids that go on in
    steps; a purge has none. `unsent` are the ids a stop left unsent, and
    the deferred ids past the watches one action keeps (DEFERRED_MOST);
    `unknown` the ids of a call in flight when a fault ended the action,
    whose answer nobody heard. `paused` says the pause refused the action
    before it sent anything or stopped one of its lanes, so the ids it
    left are worth sending again once edits resume. */
export type DeletedItemsOutcome<Reason> = {
  done: string[]
  stepping: string[]
  refused: { id: string; reason: Reason }[]
  deferred: string[]
  failed: string[]
  unsent: string[]
  unknown: string[]
  error: string | null
  paused: boolean
}

/** An item a restore or Delete now sends, as the page knows it. Only `id`
    and `org_id` are sent; `kind` and `path` order a call (planOf), and
    `key` and `title` name the item in a sentence. */
export type DeletedTarget = {
  id: string
  org_id: string
  org_name?: string
  kind?: DeletedRow['kind']
  path?: readonly string[]
  key?: string
  title?: string
  archived?: boolean
}

/** The most deferred items one action watches until they can be sent
    again; the rest count as not sent. One call defers at most this many. */
export const DEFERRED_MOST = 25

/** One organization's calls of an action, each at most the call's limit
    of ids, in the order they go. */
export type DeletedLane = Readonly<{ org_id: string; calls: readonly (readonly string[])[] }>

/** How an action runs, one lane an organization, every id once, and
    whether it takes more than one round of the shared runner
    (lib/batchRunner.ts roundsOf), which asks the person to keep Qivo open
    before it starts. */
export type DeletedPlan = Readonly<{ lanes: readonly DeletedLane[]; total: number; long: boolean }>

/** The tier an item goes in within its organization's calls: project items
    of top-level projects, of sub-projects, then task items, as the server
    orders one call (convex/model/deletedItems.ts restoreItems). */
const tierOf = (row: DeletedTarget) =>
  row.kind === 'project' ? ((row.path?.length ?? 0) === 0 ? 0 : 1) : 2

/**
 * The plan of a restore or Delete now of `rows` in calls of at most `max`
 * ids (LIMITS.restoreBatch or LIMITS.purgeBatch): each id once, grouped by
 * organization in the order the rows first name it, each organization's
 * items in the server's tiers and in their order within a tier, so a
 * project item goes in a call no later than the items that wait for it.
 * The Restore window and the store take the same plan, so the window's
 * keep-open paragraph and the store's progress agree.
 */
export function planOf(rows: readonly DeletedTarget[], max: number): DeletedPlan {
  const byOrg = new Map<string, DeletedTarget[]>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const list = byOrg.get(row.org_id) ?? []
    list.push(row)
    byOrg.set(row.org_id, list)
  }
  const lanes = [...byOrg].map(([org_id, list]) => {
    const ids = [...list].sort((a, b) => tierOf(a) - tierOf(b)).map((row) => row.id)
    const calls: string[][] = []
    for (let at = 0; at < ids.length; at += max) calls.push(ids.slice(at, at + max))
    return { org_id, calls }
  })
  return {
    lanes,
    total: seen.size,
    long: roundsOf(lanes.map((lane) => lane.calls.length)) > 1,
  }
}

/** An organization a stop ended, with what was done there: the items its
    answers confirmed, those refused (one by one or with their call), those
    never sent, and the refusal's sentence, the pause's when `paused`. */
export type DeletedStop = Readonly<{
  org_id: string
  org_name: string
  total: number
  done: number
  refused: number
  unsent: number
  reason: string
  paused: boolean
}>

/** A restore or Delete now as the store runs it (P.deletedAction). It lives
    in the store, not on the page, so leaving Deleted items loses nothing
    while it runs. `noun` names what it acts on ("180 tasks"); `done` and
    `refused` count what the answers confirmed; `lanes` are its
    organizations and `lanesDone` those that finished; `pending` the ids no
    answer has spoken for yet. `finished` says every lane finished;
    `stopped` that a refusal, the pause or a fault stopped one. */
export type DeletedAction = Readonly<{
  kind: 'restore' | 'purge'
  state: 'running' | 'finished' | 'stopped'
  long: boolean
  noun: string
  total: number
  done: number
  refused: number
  lanes: number
  lanesDone: number
  pending: readonly string[]
  stops: readonly DeletedStop[]
}>

/** Whether `action` still runs, so no other restore or Delete now starts. */
export const deletedBusy = (action: DeletedAction | null): boolean => action?.state === 'running'

/** What a group of items is called: tasks, projects, or items when the
    kinds mix or are not known. */
export function itemsNoun(rows: readonly DeletedTarget[], n = rows.length): string {
  if (rows.length > 0 && rows.every((row) => row.kind === 'task')) return plural(n, 'task')
  if (rows.length > 0 && rows.every((row) => row.kind === 'project')) return plural(n, 'project')
  return plural(n, 'item')
}

/** One item's name in a sentence: a task's key, a project's name in
    quotes, or "an item" when the page did not know it. */
export function targetName(row: DeletedTarget | undefined): string {
  if (row?.kind === 'task' && row.key) return row.key
  if (row?.title) return `“${row.title}”`
  return row?.key || 'an item'
}

/** The names of `rows` in a sentence: "QN-12", "QN-12 and QN-13",
    "QN-12, QN-13 and 4 more". */
export function namesOf(rows: readonly (DeletedTarget | undefined)[], most = 3): string {
  const names = rows.map(targetName)
  if (names.length <= most) return andList(names)
  return `${names.slice(0, most - 1).join(', ')} and ${(names.length - most + 1).toLocaleString('en-US')} more`
}

/** The progress line while `action` runs: "Restoring 180 tasks, 75 done",
    with ", 1 of 2 organizations finished" when it runs in several. */
export function progressText(action: DeletedAction): string {
  const doing = action.kind === 'restore' ? 'Restoring' : 'Deleting'
  const line = `${doing} ${action.noun}${action.kind === 'purge' ? ' for good' : ''}, ${action.done.toLocaleString('en-US')} done`
  return action.lanes > 1
    ? `${line}, ${action.lanesDone} of ${action.lanes} organizations finished`
    : line
}

/** "1 follows once its project is back", "3 follow once their project is
    back", with `who` in place of the count. */
const follows = (n: number, who = n.toLocaleString('en-US')) =>
  n === 1 ? `${who} follows once its project is back.` : `${who} follow once their project is back.`

/** "1 of them finishes restoring in the background.", "3 of them finish
    restoring in the background." */
const background = (n: number) =>
  n === 1
    ? '1 of them finishes restoring in the background.'
    : `${n.toLocaleString('en-US')} of them finish restoring in the background.`

/** What a whole action did, for its end toast (endText). */
export type DeletedTally = {
  kind: 'restore' | 'purge'
  /** what the person asked for */
  asked: readonly DeletedTarget[]
  done: number
  stepping: number
  refused: number
  /** deferred items the store watches */
  following: readonly (DeletedTarget | undefined)[]
  /** items never sent, the deferred past DEFERRED_MOST among them */
  unsent: readonly (DeletedTarget | undefined)[]
}

/**
 * The toast at the end of an action of more than one round that no stop
 * ended, whether or not the page shows: "Restored 180 tasks.", with " 3
 * of them finish restoring in the background." for items that go on in
 * steps, the deferred items as following, never as restored, and the
 * refused and unsent ones counted apart, which makes it an error that
 * stays.
 */
export function endText(t: DeletedTally): { text: string; tone: 'success' | 'error' } {
  const total = t.asked.length
  const did = t.kind === 'restore' ? 'Restored' : 'Deleted'
  const what =
    t.done === total
      ? `${did} ${itemsNoun(t.asked)}${t.kind === 'purge' ? ' for good' : ''}.`
      : `${did} ${t.done.toLocaleString('en-US')} of ${itemsNoun(t.asked)}${t.kind === 'purge' ? ' for good' : ''}.`
  const parts = [what]
  if (t.stepping > 0) parts.push(background(t.stepping))
  if (t.following.length > 0) parts.push(follows(t.following.length))
  if (t.refused > 0)
    parts.push(
      `${t.refused.toLocaleString('en-US')} couldn't be ${t.kind === 'restore' ? 'restored' : 'deleted for good'}.`,
    )
  if (t.unsent.length > 0)
    parts.push(
      `${namesOf(t.unsent)} ${t.unsent.length === 1 ? 'was' : 'were'} not sent and stay in Deleted items.`,
    )
  return {
    text: parts.join(' '),
    tone: t.refused > 0 || t.unsent.length > 0 ? 'error' : 'success',
  }
}

/** "25 couldn't be restored and 55 were not sent." for a stop. */
function leftText(kind: 'restore' | 'purge', refused: number, unsent: number): string {
  const parts = [
    refused > 0
      ? `${refused.toLocaleString('en-US')} couldn't be ${kind === 'restore' ? 'restored' : 'deleted for good'}`
      : '',
    unsent > 0 ? `${unsent.toLocaleString('en-US')} ${unsent === 1 ? 'was' : 'were'} not sent` : '',
  ].filter(Boolean)
  return parts.length === 0 ? '' : ` ${andList(parts)}. They stay in Deleted items.`
}

/**
 * The sticky toast of an organization a refusal stopped: what was done
 * there out of its items, what was refused and what was never sent, then
 * the refusal's sentence. "Restoring stopped after 100 of 180 tasks in
 * Northstar Labs. 25 couldn't be restored and 55 were not sent. They stay
 * in Deleted items. Restoring is paused while the organization is
 * read-only."
 */
export function stopText(
  kind: 'restore' | 'purge',
  stop: DeletedStop,
  noun: (n: number) => string,
): string {
  const doing = kind === 'restore' ? 'Restoring' : 'Deleting for good'
  const did = kind === 'restore' ? 'restored' : 'deleted'
  const what =
    stop.done === 0
      ? `${doing} stopped in ${stop.org_name} before it ${did} any item.`
      : `${doing} stopped after ${stop.done.toLocaleString('en-US')} of ${noun(stop.total)} in ${stop.org_name}.`
  return `${what}${leftText(kind, stop.refused, stop.unsent)} ${stop.reason}`
}

/** What one organization's lane of an action did, as its answers
    confirmed: the items done, those of them that go on in the background
    (`stepping`) and the deferred ones the store watches (`following`),
    those refused, one by one or with their call, and those never sent. */
export type LaneTally = Readonly<{
  org_name: string
  done: number
  stepping: number
  following: number
  refused: number
  unsent: number
}>

/**
 * The one toast of the pause, which stops every organization. `lanes`
 * holds every organization of the action, whether it finished, a refusal
 * stopped it or the pause did. The toast names the organizations where
 * something was done and how much, then counts apart what goes on in the
 * background or follows, what was refused and what was never sent, and
 * ends with the pause's sentence `reason`. A refused organization's lane
 * leaves out the refusals and unsent calls that its own toast counts
 * (stopText).
 * "Restoring stopped after 100 tasks in Northstar Labs and 25 in Partner
 * Co. 55 were not sent. They stay in Deleted items. Qivo is offline."
 */
export function pauseText(
  kind: 'restore' | 'purge',
  lanes: readonly LaneTally[],
  noun: (n: number) => string,
  reason: string,
): string {
  const doing = kind === 'restore' ? 'Restoring' : 'Deleting for good'
  const did = kind === 'restore' ? 'restored' : 'deleted'
  const worked = lanes.filter((lane) => lane.done > 0)
  const what =
    worked.length === 0
      ? `${doing} stopped before it ${did} any item.`
      : `${doing} stopped after ${andList(
          worked.map(
            (lane, i) =>
              `${i === 0 ? noun(lane.done) : lane.done.toLocaleString('en-US')} in ${lane.org_name}`,
          ),
        )}.`
  const sum = (count: (lane: LaneTally) => number) => lanes.reduce((n, lane) => n + count(lane), 0)
  const parts = [what]
  const stepping = sum((lane) => lane.stepping)
  if (stepping > 0) parts.push(background(stepping))
  const following = sum((lane) => lane.following)
  if (following > 0) parts.push(follows(following))
  const left = leftText(
    kind,
    sum((lane) => lane.refused),
    sum((lane) => lane.unsent),
  )
  return `${parts.join(' ')}${left} ${reason}`.trim()
}

/** The toast of an action a fault in Qivo ended. */
export const faultText = (kind: 'restore' | 'purge'): string =>
  `${kind === 'restore' ? 'Restoring' : 'Deleting for good'} stopped after a fault in Qivo. What it already did stays done.`

/**
 * The toast after a restore of one round, which the page shows, since such
 * an action never toasts from the store: one item by name, many by count,
 * and a partial failure as an error that counts what failed. A deferred
 * item follows, never counted as restored; `name` stands for the one
 * asked item's own name. Null when nothing is left to say.
 */
export function restoreToast(
  asked: readonly DeletedTarget[],
  outcome: DeletedItemsOutcome<RestoreRefusal>,
  name?: string,
  others: readonly DeletedTarget[] = [],
): { text: string; tone?: 'error' } {
  const done = new Set(outcome.done)
  const back = asked.filter((row) => done.has(row.id))
  const known = new Map([...asked, ...others].map((row) => [row.id, row]))
  const following = outcome.deferred.map((id) => known.get(id) ?? { id, org_id: '' })
  const unsent = outcome.unsent.map((id) => known.get(id) ?? { id, org_id: '' })
  const tail = [
    following.length > 0 ? follows(following.length, namesOf(following)) : '',
    unsent.length > 0
      ? `${namesOf(unsent)} ${unsent.length === 1 ? 'was' : 'were'} not sent and stay in Deleted items.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
  const withTail = (text: string) => (tail ? `${text} ${tail}` : text)
  // the items asked for and deferred themselves, which follow
  const waiting = new Set(outcome.deferred)
  const missed = asked.filter((row) => !done.has(row.id) && !waiting.has(row.id))
  if (missed.length === 0) {
    if (back.length === 0) return { text: tail }
    if (back.length !== 1) return { text: withTail(`Restored ${itemsNoun(back)}.`) }
    const [row] = back
    // an item too large for one call goes on in steps, as the server says
    const stepping = outcome.stepping.includes(row.id)
    const label = name ?? targetName(row)
    if (stepping) return { text: withTail(`Restoring ${label}…`) }
    const archived =
      row.archived === true
        ? row.kind === 'task'
          ? ' to Archived tasks'
          : ' to Archived projects'
        : ''
    return { text: withTail(`Restored ${label}${name === undefined ? archived : ''}.`) }
  }
  if (asked.length === 1) {
    const [row] = asked
    const reason = outcome.refused.find((r) => r.id === row.id)?.reason
    const label = name ?? targetName(row)
    return {
      text: reason
        ? `Couldn't restore ${label}. ${refusalText(reason)}`
        : (outcome.error ?? `Couldn't restore ${label}.`),
      tone: 'error',
    }
  }
  if (back.length === 0 && outcome.deferred.length === 0)
    return { text: outcome.error ?? `Couldn't restore ${itemsNoun(asked)}.`, tone: 'error' }
  return {
    text: withTail(
      `Restored ${back.length.toLocaleString('en-US')} of ${itemsNoun(asked)}. ${missed.length.toLocaleString('en-US')} couldn't be restored.`,
    ),
    tone: 'error',
  }
}
