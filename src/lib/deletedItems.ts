/* What the Deleted items page says about its rows, kept out of the page so it
   stays pure: the deleter line, the suffix after a title, the sentence of a
   row that cannot be restored, the Deleted by options, the search filter, the
   item a search hit stands for when no list holds it, the order of rows and
   search hits, and how a long run of one person's deletes folds. Types come
   from the deletedItems functions, so the page follows the server's
   projection (convex/model/deletedItemsList.ts). */

import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import { dayInSentence, stretch, timeSpan } from './deletedTime'

export type DeletedList = FunctionReturnType<typeof api.deletedItems.list>
export type DeletedRow = DeletedList['items'][number]
export type DeletedMatch = FunctionReturnType<typeof api.deletedItems.matches>[number]
export type Deleter = DeletedRow['deleter']
export type BlockDetail = NonNullable<DeletedRow['blocked']>
/** Why the server refused to restore one item. */
export type RestoreRefusal = FunctionReturnType<
  typeof api.deletedItems.restore
>['refused'][number]['reason']
/** Why the server refused to delete one item for good. */
export type PurgeRefusal = FunctionReturnType<
  typeof api.deletedItems.purge
>['refused'][number]['reason']

/** An item the page acts on. It is a row of a list, or the item of a search
    hit that no list holds (hitItem), which carries that `hit`. */
export type ItemRow = DeletedRow & { hit?: DeletedMatch }

/** One line of the list: an item, or a task the search found that can only
    come back with an item the line does not show. That is a task inside a
    deleted project, or a subtask of a task item that no list holds, whose
    hit names the item's root (`root_key`). A match acts on its item, `item`.
    Any other task item that the search found is an item line, its own row. */
export type Line =
  | { kind: 'item'; row: ItemRow }
  | { kind: 'match'; match: DeletedMatch; item: ItemRow }

/** The item a line acts on. */
export const lineItem = (line: Line): ItemRow => (line.kind === 'item' ? line.row : line.item)

/** The item of a search hit, as far as the hit tells it, for a hit whose item
    no list holds. A capped list can stop before older items that the search
    still finds. The item has the hit's organization, deleter, time and
    restore state, and no counts or Delete now, which the hit does not carry.
    A task item found by its root is that task, with its key, title and
    place, and shows as an ordinary task row, redacted when the hit is. A
    task item found by a subtask is named after its root, which the hit
    names, without a place, and shows as the hit's match line, since its
    Restore brings back the root and every subtask. A project item has no
    name, so the page names it through `hit`. */
export function hitItem(match: DeletedMatch): ItemRow {
  const item: ItemRow = {
    id: match.item_id,
    org_id: match.org_id,
    org_name: match.org_name,
    kind: 'project',
    key: '',
    title: '',
    counts: { tasks: 0, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
    projects: [],
    path: [],
    archived: false,
    deleted_at: match.deleted_at,
    deleter: match.deleter,
    state: match.state,
    can_restore: match.can_restore,
    blocked: match.blocked,
    can_purge: false,
    hit: match,
  }
  if (match.item_kind !== 'task') return item
  if (match.root_key !== undefined)
    return { ...item, kind: 'task', key: match.root_key, title: match.root_title ?? '' }
  return {
    ...item,
    kind: 'task',
    key: match.key,
    title: match.title,
    path: match.path,
    archived: match.archived,
    ...(match.redacted ? { redacted: true } : {}),
  }
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
        : `You can only view ${project} now. Ask an organization admin to restore it.`
    case 'not_lead':
      // the server names no lead when none passes today's lead rule
      return blocked.lead
        ? `${project} has its own lead, ${blocked.lead}. Ask them or an organization admin to restore it.`
        : `${project} has no lead now. Ask an organization admin to restore it.`
    case 'subtask_project':
      return "A subtask is in a project you can't edit. Ask an organization admin to restore it."
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
      return "A subtask is in a project you can't edit. Ask an organization admin to restore it."
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

/* ------------------------------------------------------------ filtering */

/** The rows a kind control choice keeps. */
export type KindFilter = 'all' | 'task' | 'project'

/** One choice of the Deleted by select. */
export type ByOption = { value: string; label: string }

/** The value of "Deleted by anyone", which filters nothing. */
export const ANYONE = 'any'

/** What a Deleted by choice is about: a row's organization and deleter. */
type DeletedBy = Pick<DeletedRow, 'org_id' | 'deleter'>

/** Someone in the roster of an organization the viewer administers, whom
    Deleted by offers whether or not the list holds their deletes. */
export type RosterPerson = {
  org_id: string
  org_name: string
  profile_id: string
  name: string
  /** the viewer's own seat */
  you: boolean
}

/* A person choice names the organization and the deleter's profile. Every
   removed deleter of one organization has no profile and is one "Someone"
   choice. A "via" choice names the organization and the opaque `who` key of
   one credential. The organization keeps the "Someone" of two organizations
   apart, and their shared `who` keys too. */
const personValue = (org: string, profile: string | undefined) => `person:${org}:${profile ?? ''}`
const whoValue = (row: DeletedBy) => `who:${row.org_id}:${row.deleter.who}`

/** A choice's organization and the rest of its value, or null for anyone. */
function parseChoice(value: string): { kind: 'person' | 'who'; org: string; rest: string } | null {
  const kind = value.startsWith('person:') ? 'person' : value.startsWith('who:') ? 'who' : null
  if (kind === null) return null
  const tail = value.slice(kind.length + 1)
  const cut = tail.indexOf(':')
  return cut < 0 ? null : { kind, org: tail.slice(0, cut), rest: tail.slice(cut + 1) }
}

/** The profile a Deleted by choice names, which the server can filter by, or
    undefined for anyone and for "Someone". */
export function chosenProfile(value: string, rows: DeletedRow[]): string | undefined {
  const choice = parseChoice(value)
  if (choice === null) return undefined
  if (choice.kind === 'person') return choice.rest || undefined
  return rows.find((row) => row.org_id === choice.org && row.deleter.who === choice.rest)?.deleter
    .profile_id
}

/**
 * The Deleted by choices for these rows: "Deleted by anyone" first, then each
 * person ("You" first, the rest by name, "Someone" last), each followed by
 * one "<person> via <credential>" choice per credential they deleted with,
 * when they deleted in more than one way. A credential whose name the viewer
 * may not see is one choice per kind ("Daniel Berg via a personal token"),
 * as its `who` key is. `roster` adds the people the rows do not name, with
 * no "via" choices. With `orgNames`, a label ends with the person's
 * organization ("You via Claude, Northstar Labs"), since one login can hold
 * a seat in several.
 */
export function deletedByOptions(
  rows: DeletedRow[],
  orgNames: boolean,
  roster: readonly RosterPerson[] = [],
): ByOption[] {
  type Person = {
    value: string
    name: string
    you: boolean
    /** a removed deleter, "Someone" */
    gone: boolean
    org_name: string
    ways: Map<string, DeletedRow>
  }
  const people = new Map<string, Person>()
  for (const row of rows) {
    const { deleter } = row
    const value = personValue(row.org_id, deleter.profile_id)
    const person = people.get(value) ?? {
      value,
      name: deleterName(deleter),
      you: deleter.you,
      gone: deleter.name === undefined,
      org_name: row.org_name,
      ways: new Map(),
    }
    person.ways.set(deleter.who, row)
    people.set(value, person)
  }
  for (const p of roster) {
    const value = personValue(p.org_id, p.profile_id)
    if (!people.has(value))
      people.set(value, {
        value,
        name: p.you ? 'You' : p.name,
        you: p.you,
        gone: false,
        org_name: p.org_name,
        ways: new Map(),
      })
  }
  const label = (person: Person, via = '') =>
    `${person.name}${via}${orgNames ? `, ${person.org_name}` : ''}`
  const sorted = [...people.values()].sort(
    (a, b) =>
      Number(b.you) - Number(a.you) ||
      Number(a.gone) - Number(b.gone) ||
      label(a).localeCompare(label(b)),
  )
  const options: ByOption[] = [{ value: ANYONE, label: 'Deleted by anyone' }]
  for (const person of sorted) {
    options.push({ value: person.value, label: label(person) })
    if (person.ways.size < 2) continue
    const ways = [...person.ways.values()]
      .filter((way) => way.deleter.kind !== 'app')
      .map((way) => ({
        value: whoValue(way),
        label: label(person, viaText(way.deleter, 'short')),
      }))
    options.push(...ways.sort((a, b) => a.label.localeCompare(b.label)))
  }
  return options
}

/** Whether a row's delete passes the Deleted by choice `value`. */
export function deletedBy(row: DeletedBy, value: string): boolean {
  if (value === ANYONE) return true
  const choice = parseChoice(value)
  if (choice === null || choice.org !== row.org_id) return false
  return choice.kind === 'who'
    ? row.deleter.who === choice.rest
    : (row.deleter.profile_id ?? '') === choice.rest
}

/** Whether a row's text holds the search text, lowercased: its key, title,
    place, deleter, credential, reason and organization. */
export function rowHasText(row: DeletedRow, text: string): boolean {
  const deleter = row.deleter
  return [
    row.key,
    row.title,
    row.path.join(' '),
    deleterName(deleter),
    deleter.credential_name ?? '',
    row.reason ?? '',
    row.org_name,
  ]
    .join('\n')
    .toLowerCase()
    .includes(text)
}

/** Whether a search hit shows the search text, lowercased, in its key or
    title. It keeps a hit of the previous text on screen until the new
    answer arrives. */
export function matchHasText(match: DeletedMatch, text: string): boolean {
  return `${match.key}\n${match.title}`.toLowerCase().includes(text)
}

/** Lines newest first. A search hit sits right after its project item, which
    has the same time, or where that item would be. */
export function byTime(a: Line, b: Line): number {
  const ia = lineItem(a)
  const ib = lineItem(b)
  if (ia.deleted_at !== ib.deleted_at) return ia.deleted_at < ib.deleted_at ? 1 : -1
  if (ia.id !== ib.id) return ia.id < ib.id ? 1 : -1
  if (a.kind !== b.kind) return a.kind === 'item' ? -1 : 1
  return a.kind === 'match' && b.kind === 'match' ? a.match.key.localeCompare(b.match.key) : 0
}

/* -------------------------------------------------------------- folding */

/** A run folds when it holds this many task rows or more, shows `shown` of
    them, and holds rows at most `gapMs` apart. */
export const FOLD = { min: 11, shown: 7, gapMs: 10 * 60_000 }

/** What the list draws: a line, the fold line of a run that hides its rest,
    or the Show fewer line after an open run. */
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
 * or a search hit ends a run. A closed run shows its first FOLD.shown rows
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

/** What a group of items is called: tasks, projects, or items when the
    kinds mix. */
export function restoreNoun(rows: DeletedRow[]): string {
  const n = rows.length
  if (rows.every((row) => row.kind === 'task')) return plural(n, 'task')
  if (rows.every((row) => row.kind === 'project')) return plural(n, 'project')
  return plural(n, 'item')
}

/**
 * The first sentence of the bulk restore window when one person deleted
 * every item the same way on the same day: "Daniel Berg deleted them via
 * Cursor (personal token) today, 14:02 to 14:09." Null otherwise.
 */
export function deleterSentence(rows: DeletedRow[], now: Date): string | null {
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
 * A project item known only from a search hit is named by where the hit's
 * task sat and by that task ("project with QN-12"). A task item known only
 * from a hit on a subtask is named by its root, whose place the hit does not
 * tell ("QN-12 Calibrate the rig", "task and its subtasks"), after the rest.
 */
export function destinations(rows: ItemRow[]): Destination[] {
  const projects: Destination[] = rows
    .filter((row) => row.kind === 'project')
    .map((row) => {
      if (row.hit)
        return {
          key: row.id,
          kind: 'project',
          name: row.hit.path.filter(Boolean).join(' › '),
          count: `project with ${row.hit.key}`,
        }
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
  const roots: Destination[] = []
  for (const row of rows) {
    if (row.kind !== 'task') continue
    if (row.hit?.root_key !== undefined) {
      roots.push({
        key: row.id,
        kind: 'task',
        name: `${row.key} ${row.title}`,
        count: 'task and its subtasks',
      })
      continue
    }
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
  return [...projects, ...tasks, ...roots]
}

/* ------------------------------------------------------------ Delete now */

/**
 * How many other items Delete now on `item` deletes with it. Deleting a
 * project item for good also deletes the ready and stuck items that wait for
 * one of its projects, and those that wait for them in turn (the server's
 * purgeDependents in convex/model/deletedItems.ts). A ready row names the
 * item it waits for, but a stuck row does not, so `exact` holds only while
 * `rows` is the whole uncapped list, as an admin's is, and no other row of
 * the item's organization is stuck. A task item takes nothing else along.
 */
export function deletedAlong(
  item: DeletedRow,
  rows: DeletedRow[],
  capped: boolean,
): { count: number; exact: boolean } {
  if (item.kind === 'task') return { count: 0, exact: true }
  const along = new Set([item.id])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      const holder = row.blocked?.item_id
      if (holder === undefined || !along.has(holder) || along.has(row.id)) continue
      along.add(row.id)
      grew = true
    }
  }
  const unsure = rows.some(
    (row) => row.org_id === item.org_id && row.state === 'stuck' && !along.has(row.id),
  )
  return { count: along.size - 1, exact: !capped && !unsure }
}
