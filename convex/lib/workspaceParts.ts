/* The readers behind the workspace parts (workspace.ts), which together
 * send what the app shows of every organization the caller holds a seat in.
 *
 * The long sections come in windows (lib/idWindows.ts): a window [from,
 * to) of the organization's people holds those whose id falls in it, and
 * one of its tasks or projects those whose window key does. The server
 * picks a task's or project's window key at random when it inserts the row
 * (lib/db.ts newWindowKey), so no writer can crowd rows into one window,
 * and the ids writers choose say nothing about where a row lands. The app
 * chooses the windows from the organization's counts of the rows they read
 * (lib/idWindows.ts startWindows), so each window stays far inside
 * Convex's limits per query (4,096 index ranges, 32,000 documents, 16 MiB
 * read, 1 s) and a change re-sends only the window that holds it. A
 * window reads its rows, and each kind of their relation rows, in one
 * index range, by organization and key, not one range per row (a
 * relation row carries its task's key as task_key). A window keeps its
 * bounds while rows come and go. One that grew past PAGE's soft budget answers `split: true`, and the
 * app cuts it in two (lib/idWindows.ts halve) while it keeps answering.
 * One whose reads would pass the hard budget stops early and answers
 * `overflow` instead, before Convex would refuse the read, so the app cuts
 * it before it shows it: into the pieces the answer names when its own rows
 * did not fit in one read, so a large window, such as the one window the
 * people of an organization start in, reaches its size in one round. A window that cannot be cut further and still does
 * not fit answers `refused` with a sentence the app shows. Bounds are fixed
 * points of the id space, so no bound says anything about the rows.
 *
 * No answer holds a value of its own run, such as the server's clock, and
 * nothing logs on a normal run, so Convex sends a part again only when what
 * it says changed (an unchanged rerun is not re-sent). */

import type { IndexRange } from 'convex/server'
import type { Doc, TableNames } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { descriptionsOf } from '../model/descriptions'
import { shownLabelColor } from '../model/labels'
import {
  countersRow,
  type LiveCounts,
  liveCountsOf,
  numbersOf,
  type OrgCounters,
} from '../model/orgs'
import { shownAvatarColor } from '../model/people'
import { stampOfRow } from '../model/syncStamps'
import { type Access, accessOf, isOrgStaff } from './access'
import { chunkLists } from './arrayLimit'
import { orgCreateFor, seatlessState } from './billingAccess'
import { byId } from './db'
import { cutPieces, halve, type IdWindow, roundedCounts } from './idWindows.ts'
import { loadInbox, newestFirst, recentlyReadFirst } from './inbox'
import { INBOX_LIMIT } from './limits'
import { loadRowFor, type OrgLoadRow } from './loadRows'
import { taskOwnerId } from './review'
import { parentLink } from './workingSet'

type AppRow<T extends TableNames> = Omit<Doc<T>, '_id' | '_creationTime'>

/** `doc` without its Convex system fields. */
export function rowOf<D extends { _id: unknown; _creationTime: number }>(
  doc: D,
): Omit<D, '_id' | '_creationTime'> {
  const { _id, _creationTime, ...row } = doc
  return row
}

/* A team or project as the app receives it, without the legacy icon and
 * its color. Nothing writes or shows them now, and a value stored before
 * they were dropped has no length limit. */
type IconFree<T extends 'teams' | 'projects'> = Omit<AppRow<T>, 'icon' | 'icon_color'>

function iconFree<
  D extends { _id: unknown; _creationTime: number; icon?: string; icon_color?: string },
>(doc: D) {
  const { icon: _icon, icon_color: _iconColor, ...row } = rowOf(doc)
  return row
}

/* A row without its name key, which only serves name-ordered index reads
 * (schema.ts name_key). */
type KeyFree<R> = Omit<R, 'name_key'>

function keyFree<R extends { name_key?: string }>(row: R): KeyFree<R> {
  const { name_key: _key, ...rest } = row
  return rest
}

/** A relation row as the app receives it, without the organization id,
 * the archive mark and the task's window key, which only serve index
 * reads. */
function relationRow<
  D extends {
    _id: unknown
    _creationTime: number
    org_id?: string
    task_archived?: true
    task_key?: string
  },
>(doc: D) {
  const { org_id: _orgId, task_archived: _mark, task_key: _key, ...row } = rowOf(doc)
  return row
}

/* An organization as the app receives it. Billing is admin-only; the
 * counters and the live counts, once counted, come from org_counters
 * (model/orgs.ts numbersOf, liveCountsOf). The retired gravatar_avatars
 * setting stays out. */
type OrgRow = Omit<AppRow<'organizations'>, 'billing' | 'gravatar_avatars'> &
  OrgCounters &
  LiveCounts & { billing?: Doc<'organizations'>['billing'] }

const orgRowFor = (
  doc: Doc<'organizations'>,
  counters: OrgCounters & LiveCounts,
  isAdmin: boolean,
): OrgRow => {
  const { _id, _creationTime, billing, gravatar_avatars: _gravatar, ...rest } = doc
  const row = { ...rest, ...counters }
  return isAdmin && billing !== undefined ? { ...row, billing } : row
}

/* A person as the app receives it, without the name key, with their Team
 * sync stamp (model/syncStamps.ts) as sync_at and sync_since. */
type ProfileRow = KeyFree<AppRow<'profiles'>> & { sync_at?: string; sync_since?: string }

/* A task as the app receives it. The parent id goes out only when the
 * reader is shown the parent (lib/workingSet.ts parentLink), and the text
 * comes from the task's description row (model/descriptions.ts
 * descriptionOf). */
type TaskRow = Omit<AppRow<'issues'>, 'relations_marked' | 'parent_id' | 'window_key'> & {
  parent_id?: string
  /** always sent; absent reads as false, as in rows the app makes */
  has_subtasks?: boolean
  has_hidden_subtasks: boolean
  has_hidden_parent: boolean
}

/** The windowed kinds. */
export type Kind = 'tasks' | 'people' | 'projects'

/* A read budget, as Convex counts a transaction's reads. */
type Budget = { bytes: number; documents: number; ranges: number }

/** The budgets of the windowed parts. A part holding more than `split`
 * rows, or that read past `soft`, answers `split`. A part that would read
 * more than `most` rows, or past `hard`, stops and answers `overflow`. The
 * app starts each kind with about lib/idWindows.ts WINDOW_ROWS rows a
 * window. Tests lower them. */
export const PAGE = {
  tasks: { split: 300, most: 1500 },
  people: { split: 1000, most: 1200 },
  projects: { split: 600, most: 1200 },
  soft: { bytes: 4 * 1024 * 1024, documents: 8000, ranges: 2000 } satisfies Budget,
  hard: { bytes: 8 * 1024 * 1024, documents: 16_000, ranges: 3200 } satisfies Budget,
  /** how many rows a part reads the per-row reads of at once, checking
   * PAGE.hard before each batch: one batch reads at most this many task
   * bodies (64 of the largest hold about 4 MiB) or about six ranges a row,
   * so it stays inside Convex's 16 MiB and 4,096 past PAGE.hard */
  batch: 64,
  /** how many new subtasks of each of PAGE.kids parents one step of kidsOf
   * reads, so a step reads about PAGE.kids² task bodies (64, about 4 MiB),
   * plus those it reads again at the time it resumes from */
  kids: 8,
  /** the most relation rows of one kind (labels, attachments, links,
   * follows) a tasks window reads, and a flagged task by its own indexes;
   * past half of it the window asks to be cut, so it is cut while it still
   * shows, before it would answer overflow */
  relations: 2000,
  /** how many new tasks the inbox reads between checks of PAGE.hard: 32 of
   * the largest hold about 2 MiB */
  inboxCheck: 32,
}

/* Reads that cost every part of the caller the same, whatever its window
 * holds (lib/access.ts projectLevelsOf shared). */
type Shared = { ranges: number; documents: number; bytes: number }
const NONE: Shared = { ranges: 0, documents: 0, bytes: 0 }

/** Whether the transaction has read past `limit`, not counting `shared`. */
async function readPast(ctx: QueryCtx, limit: Budget, shared: Shared = NONE): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics()
  return (
    m.bytesRead.used - shared.bytes > limit.bytes ||
    m.documentsRead.used - shared.documents > limit.documents ||
    m.databaseQueries.used - shared.ranges > limit.ranges
  )
}

/* What a part whose window cannot be cut any further answers. */
const TOO_MUCH =
  'One part of this organization holds more than Qivo can load at once. Contact support so we can help reduce it.'

/** The answer of a part over its hard budget: cut its window, or, when it
 * cannot be cut, refuse. A window whose own rows did not fit in one read
 * also says how many pieces to cut it into, from `last`, the key or id of
 * the last row the read took (lib/idWindows.ts cutPieces), so a large one
 * reaches its size in one round. Without, the app halves it. */
const overflow = (w: IdWindow, last?: string) =>
  halve(w) === null
    ? { state: 'refused' as const, message: TOO_MUCH }
    : last === undefined
      ? { state: 'overflow' as const }
      : { state: 'overflow' as const, pieces: cutPieces(w, last) }

/** `{split: true}` when `over` or the part read past PAGE.soft, not
 * counting `shared`, and its window can be cut, else nothing. Halving a
 * window does not shrink what every part of the caller reads alike, so
 * that never asks for a cut. */
async function softSplit(ctx: QueryCtx, w: IdWindow, over: boolean, shared: Shared = NONE) {
  if (halve(w) === null) return {}
  return over || (await readPast(ctx, PAGE.soft, shared)) ? { split: true as const } : {}
}

/* Index range bounds of a window on an index whose next field is `field`. */
type IdBounded<F extends string> = IndexRange & {
  gte(field: F, value: string): IndexRange & { lt(field: F, value: string): IndexRange }
  lt(field: F, value: string): IndexRange
}
function ids<F extends string>(q: IdBounded<F>, field: F, w: IdWindow): IndexRange {
  // The first window has no lower bound, so it also holds the rows without
  // the field: a task or project stored before window keys sorts first.
  if (w.from === '') return w.to === null ? q : q.lt(field, w.to)
  const from = q.gte(field, w.from)
  return w.to === null ? from : from.lt(field, w.to)
}

/** One page of a window's own rows, at most `most` and PAGE.soft.bytes of
 * them, in one system call (a stream costs one per row). `complete` says
 * the page holds every row, and `split` that Convex suggests cutting it.
 * Convex ends a rerun of a subscribed query's page where its first run
 * ended, so a rerun may hold more than `most` rows, or stop short at the
 * bytes; neither counts as complete. */
async function pageOf<R>(
  query: {
    paginate(opts: { cursor: null; numItems: number; maximumBytesRead: number }): Promise<{
      page: R[]
      isDone: boolean
      pageStatus?: 'SplitRecommended' | 'SplitRequired' | null
    }>
  },
  most: number,
): Promise<{ rows: R[]; complete: boolean; split: boolean }> {
  const { page, isDone, pageStatus } = await query.paginate({
    cursor: null,
    numItems: most,
    maximumBytesRead: PAGE.soft.bytes,
  })
  return {
    rows: page,
    complete: isDone && pageStatus !== 'SplitRequired' && page.length <= most,
    split: pageStatus === 'SplitRecommended',
  }
}

/** Runs `step` over `rows` in batches of PAGE.batch, checking PAGE.hard
 * before each batch, the first included, as the reads before it may have
 * used the room. Answers whether it read them all. */
async function inBatches<R>(
  ctx: QueryCtx,
  rows: readonly R[],
  step: (row: R, at: number) => Promise<void>,
): Promise<boolean> {
  for (let at = 0; at < rows.length; at += PAGE.batch) {
    if (await readPast(ctx, PAGE.hard)) return false
    await Promise.all(rows.slice(at, at + PAGE.batch).map((row, i) => step(row, at + i)))
  }
  return true
}

/** The rows of `query`, or null when it holds more than PAGE.relations. */
async function atMost<D>(query: { take(n: number): Promise<D[]> }): Promise<D[] | null> {
  const rows = await query.take(PAGE.relations + 1)
  return rows.length > PAGE.relations ? null : rows
}

/** `step` of each of `rows`, in inBatches' batches, or null once the reads
 * pass PAGE.hard. */
async function mapInBatches<R, T>(
  ctx: QueryCtx,
  rows: readonly R[],
  step: (row: R) => Promise<T>,
): Promise<T[] | null> {
  const out: T[] = []
  const done = await inBatches(ctx, rows, async (row, at) => {
    out[at] = await step(row)
  })
  return done ? out : null
}

// --- root -------------------------------------------------------------------

/** The caller's seats and organizations, with when the login may create an
 * organization (lib/billingAccess.ts OrgCreate). With no seat it can open,
 * null when it may create one and no deletion holds it, else the seatless
 * answer (lib/billingAccess.ts seatlessState): whether a running
 * organization deletion holds its seats, and the create state. That answer
 * names no organization and no rows, only the reason and when the login may
 * create an organization. Without `deactivated`, a login whose seat an
 * organization deactivated, and that no deletion holds, gets null instead,
 * as an app from before that answer expects (workspace.ts root). */
export async function readRoot(
  ctx: QueryCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> },
  deactivated: boolean,
) {
  /* Signed in but seatless is the app's "create your organization" signal,
   * unless an organization the login cannot open holds a seat, as one being
   * deleted or one that deactivated it. A failed read throws instead, so it
   * never looks like no seat. */
  if (ctx.myProfiles.size === 0) {
    const seatless = await seatlessState(ctx, ctx.authUserId)
    return seatless?.deleting || deactivated ? seatless : null
  }
  const orgs: OrgRow[] = []
  for (const me of ctx.myProfiles.values()) {
    const org = await byId(ctx, 'organizations', me.org_id)
    if (org === null) continue // a seat in a vanished org contributes nothing
    const counters = await countersRow(ctx, org.id)
    /* Staff see hidden work counted anonymously (capacity views). Guests
     * and Viewers may not learn how much there is, so they get the counts
     * rounded up to the windows they start. */
    const live = liveCountsOf(counters)
    orgs.push(
      orgRowFor(
        org,
        { ...numbersOf(counters), ...(isOrgStaff(me) ? live : roundedCounts(live)) },
        me.org_role === 'admin',
      ),
    )
  }
  return {
    auth_user_id: ctx.authUserId,
    myProfileIds: [...ctx.myProfiles.values()].map((p) => p.id),
    orgs,
    create: await orgCreateFor(ctx, ctx.authUserId),
  }
}

// --- catalog ------------------------------------------------------------------

/** The organization's teams and labels, which every member sees. Clients
 * paint a label color as a CSS background, so an older non-hex value goes
 * out as gray. */
export async function readCatalog(ctx: QueryCtx, me: Doc<'profiles'>) {
  const [teams, labels] = await Promise.all([
    ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .collect(),
    ctx.db
      .query('labels')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .collect(),
  ])
  return {
    state: 'ok' as const,
    ...chunkLists({
      teams: teams.map((team): KeyFree<IconFree<'teams'>> => keyFree(iconFree(team))),
      labels: labels.map(
        (l): AppRow<'labels'> => ({ ...rowOf(l), color: shownLabelColor(l.color) }),
      ),
    }),
  }
}

// --- people -------------------------------------------------------------------

/** The people of window `w`, inactive, agent and unclaimed ones included,
 * each with their Team sync stamp and team memberships. Clients paint the
 * avatar color as a CSS background, so an older non-hex value goes out as
 * gray. One range for the people and one for their stamps, and one per
 * person for their memberships. */
export async function readPeople(ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow) {
  const read = await pageOf(
    ctx.db.query('profiles').withIndex('by_org_id', (q) => ids(q.eq('org_id', me.org_id), 'id', w)),
    PAGE.people.most,
  )
  if (!read.complete) return overflow(w, read.rows.at(-1)?.id)
  const people = read.rows
  const stamps = new Map(
    (
      await ctx.db
        .query('sync_stamps')
        .withIndex('by_org_profile', (q) => ids(q.eq('org_id', me.org_id), 'profile_id', w))
        .collect()
    ).map((row) => [row.profile_id, stampOfRow(row)]),
  )
  const memberships: Doc<'team_members'>[][] = people.map(() => [])
  const done = await inBatches(ctx, people, async (p, at) => {
    memberships[at] = await ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', p.id))
      .collect()
  })
  if (!done) return overflow(w)
  const profiles = people.map((p): ProfileRow => {
    const stamp = stamps.get(p.id)
    return {
      ...keyFree(rowOf(p)),
      color: shownAvatarColor(p.color),
      ...(stamp === undefined
        ? {}
        : stamp.since === undefined
          ? { sync_at: stamp.at }
          : { sync_at: stamp.at, sync_since: stamp.since }),
    }
  })
  return {
    state: 'ok' as const,
    ...chunkLists({
      profiles,
      teamMembers: memberships.flat().map((m) => keyFree(rowOf(m))),
    }),
    ...(await softSplit(ctx, w, read.split || people.length > PAGE.people.split)),
  }
}

// --- projects -----------------------------------------------------------------

/** The projects of window `w` (by window key) the caller can see, archived
 * ones included for navigation, oldest first, with every grant on them,
 * their team grants, and the milestones of the active ones. It reads the
 * window's projects in one range, the caller's levels on each and on its
 * parent, and up to three ranges per shown project. */
export async function readProjects(ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow) {
  const read = await pageOf(
    ctx.db
      .query('projects')
      .withIndex('by_org_window', (q) => ids(q.eq('org_id', me.org_id), 'window_key', w)),
    PAGE.projects.most,
  )
  if (!read.complete) return overflow(w, read.rows.at(-1)?.window_key)
  const caller = accessOf(ctx, me, read.rows)
  const seen = await mapInBatches(ctx, read.rows, (p) => caller.visible(p.id))
  if (seen === null) return overflow(w)
  const shown = read.rows
    .filter((_, i) => seen[i])
    .sort((a, b) => a._creationTime - b._creationTime)
  const access: Doc<'project_access'>[][] = shown.map(() => [])
  const teamAccess: Doc<'project_team_access'>[][] = shown.map(() => [])
  const milestones: Doc<'milestones'>[][] = shown.map(() => [])
  const done = await inBatches(ctx, shown, async (p, at) => {
    ;[access[at], teamAccess[at], milestones[at]] = await Promise.all([
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', p.id))
        .collect(),
      ctx.db
        .query('project_team_access')
        .withIndex('by_project', (q) => q.eq('project_id', p.id))
        .collect(),
      // milestones belong to the active working set
      p.archived_at === undefined
        ? ctx.db
            .query('milestones')
            .withIndex('by_project', (q) => q.eq('project_id', p.id))
            .collect()
        : [],
    ])
  })
  if (!done) return overflow(w)
  return {
    state: 'ok' as const,
    ...chunkLists({
      projects: shown.map(
        (p): Omit<IconFree<'projects'>, 'window_key' | 'name_key' | 'archive_state'> => {
          const { window_key: _window, name_key: _key, archive_state: _state, ...row } = iconFree(p)
          return row
        },
      ),
      // Every grant on a shown project, other members' too. The app shows
      // only those of people it holds (lib/workspaceJoin.ts), as a removed
      // person's grants can outlive their profile for a moment
      // (model/cascade.ts removeProfile).
      access: access.flat().map((g) => keyFree(rowOf(g))),
      teamAccess: teamAccess.flat().map((g) => keyFree(rowOf(g))),
      milestones: milestones.flat().map(rowOf),
    }),
    ...(await softSplit(ctx, w, read.split || shown.length > PAGE.projects.split, caller.shared)),
  }
}

// --- tasks --------------------------------------------------------------------

/** Whether the caller is shown the task with this id, each read at most
 * once by id. */
function shownById(ctx: QueryCtx, me: Doc<'profiles'>, access: Access) {
  const answers = new Map<string, Promise<boolean>>()
  return (id: string): Promise<boolean> => {
    let answer = answers.get(id)
    if (answer === undefined) {
      answer = byId(ctx, 'issues', id).then(
        async (t) => t !== null && t.org_id === me.org_id && (await access.holds(t)),
      )
      answers.set(id, answer)
    }
    return answer
  }
}

/** The active tasks of window `w` (by window key), every project's, at
 * most `most`. */
const windowTasks = (ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow, most: number) =>
  pageOf(
    ctx.db
      .query('issues')
      .withIndex('by_org_archived_window', (q) =>
        ids(q.eq('org_id', me.org_id).eq('archived_at', undefined), 'window_key', w),
      ),
    most,
  )

/** The active subtasks of `parents` in live projects, by parent, or null
 * once the reads pass PAGE.hard. A subtask is a whole task body and a task
 * holds up to LIMITS.subtasks active ones, so this reads at most one
 * subtask of each parent first, in inBatches' batches, and then the rest of
 * those that have one, PAGE.kids parents at a time and PAGE.kids subtasks
 * each, checking PAGE.hard before each step. Every task is asked, as a
 * subtask stored before the rule of one level may have subtasks too. */
async function kidsOf(ctx: QueryCtx, parents: readonly Doc<'issues'>[], access: Access) {
  /* the active subtasks of the task with this id, from `from` on */
  const activeKids = (id: string, from?: number) =>
    ctx.db.query('issues').withIndex('by_parent_archived', (q) => {
      const active = q.eq('parent_id', id).eq('archived_at', undefined)
      return from === undefined ? active : active.gte('_creationTime', from)
    })
  const firsts = await mapInBatches(ctx, parents, (task) => activeKids(task.id).first())
  if (firsts === null) return null
  const kids = firsts.filter((kid) => kid !== null)
  // The parents that may have more, each from the time of the last subtask
  // read, that time included, as Convex does not make _creationTime unique;
  // `seen` holds the subtasks at that time read already.
  let open = kids.map((kid) => ({
    id: kid.parent_id as string,
    from: kid._creationTime,
    seen: new Set([kid._id]),
  }))
  while (open.length > 0) {
    if (await readPast(ctx, PAGE.hard)) return null
    const step = open.slice(0, PAGE.kids)
    const got = await Promise.all(
      step.map((p) => activeKids(p.id, p.from).take(PAGE.kids + p.seen.size)),
    )
    open = open.slice(PAGE.kids)
    for (const [i, rows] of got.entries()) {
      const p = step[i]
      kids.push(...rows.filter((kid) => !p.seen.has(kid._id)))
      const last = rows.at(-1)
      if (rows.length < PAGE.kids + p.seen.size || last === undefined) continue
      const at = rows.filter((kid) => kid._creationTime === last._creationTime)
      const seen = new Set(at.map((kid) => kid._id))
      if (last._creationTime === p.from) for (const id of p.seen) seen.add(id)
      open.push({ id: p.id, from: last._creationTime, seen })
    }
  }
  const live = await mapInBatches(ctx, kids, (kid) => access.live(kid.project_id))
  if (live === null) return null
  const byParent = new Map<string, Doc<'issues'>[]>()
  for (const [i, kid] of kids.entries()) {
    if (kid.parent_id === undefined || !live[i]) continue
    byParent.set(kid.parent_id, [...(byParent.get(kid.parent_id) ?? []), kid])
  }
  return byParent
}

/** Groups `rows` by `key`. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row])
  return groups
}

/** The tasks of the caller's working set (lib/workingSet.ts) in window
 * `w`, with their links as source whose target the caller is shown, label
 * assignments, attachments and the caller's follows.
 *
 * It reads the window's active tasks, and the unmarked label assignments,
 * attachments and links of their window keys and the caller's unmarked
 * follows of them, each kind in one range by organization (or person) and
 * task_key, and answers overflow past PAGE.relations rows of one kind. Rows
 * of an archived task carry a mark (model/archiveMarks.ts) and stay out; a
 * task restored before its marks were cleared (relations_marked) reads its
 * own rows by its own indexes, marked ones included, with the marked links
 * to it, and shows its marked follow. A task outside the window that a
 * shown task names (its parent, a link's target) is read by id to see
 * whether the caller is shown it. The window's active subtasks (kidsOf)
 * give has_subtasks, which tells a group before its subtasks in other
 * windows arrive, has_hidden_subtasks and the load rows of the window's
 * tasks the caller is not shown (orgLoad, hiddenLoadOf). Each project these
 * tasks are in is read once, with the caller's levels on it (lib/access.ts
 * accessOf). Each shown task's text is one more read, of its description
 * row, and a window whose texts do not fit in PAGE.hard answers overflow. */
export async function readTasks(ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow) {
  const read = await windowTasks(ctx, me, w, PAGE.tasks.most)
  if (!read.complete) return overflow(w, read.rows.at(-1)?.window_key)
  const access = accessOf(ctx, me)
  const held = await mapInBatches(ctx, read.rows, (t) => access.holds(t))
  if (held === null) return overflow(w)
  const tasks = read.rows.filter((_, i) => held[i])
  const inPage = new Set(tasks.map((t) => t.id))
  const byIdShown = shownById(ctx, me, access)
  const shown = async (id: string) => inPage.has(id) || (await byIdShown(id))
  const flagged = new Map(read.rows.map((t) => [t.id, t.relations_marked === true]))
  /* whether the task with this id is shown and carries no relations_marked */
  const unflaggedShownSource = async (id: string) => {
    if (!(await shown(id))) return false
    const known = flagged.get(id)
    if (known !== undefined) return !known
    return (await byId(ctx, 'issues', id))?.relations_marked !== true
  }
  // The window's relation rows, each kind in one range and at most
  // PAGE.relations of them.
  const [labels, attachments, links, follows] = await Promise.all([
    atMost(
      ctx.db
        .query('issue_labels')
        .withIndex('by_org_task_archived_key', (q) =>
          ids(q.eq('org_id', me.org_id).eq('task_archived', undefined), 'task_key', w),
        ),
    ),
    atMost(
      ctx.db
        .query('issue_attachments')
        .withIndex('by_org_task_archived_key', (q) =>
          ids(q.eq('org_id', me.org_id).eq('task_archived', undefined), 'task_key', w),
        ),
    ),
    atMost(
      ctx.db
        .query('issue_links')
        .withIndex('by_org_task_archived_key', (q) =>
          ids(q.eq('org_id', me.org_id).eq('task_archived', undefined), 'task_key', w),
        ),
    ),
    atMost(
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_profile_task_archived_key', (q) =>
          ids(q.eq('profile_id', me.id).eq('task_archived', undefined), 'task_key', w),
        ),
    ),
  ])
  if (labels === null || attachments === null || links === null || follows === null)
    return overflow(w)
  const kids = await kidsOf(ctx, read.rows, access)
  if (kids === null) return overflow(w)
  // a kid in a live project the caller cannot see
  const allKids = [...kids.values()].flat()
  const kidHidden = await mapInBatches(
    ctx,
    allKids,
    async (kid) => !(await access.visible(kid.project_id)),
  )
  if (kidHidden === null) return overflow(w)
  const hiddenKid = new Map(allKids.map((kid, i) => [kid.id, kidHidden[i]]))
  const labelsOf = groupBy(labels, (r) => r.issue_id)
  const attachmentsOf = groupBy(attachments, (r) => r.issue_id)
  const linksOf = groupBy(links, (r) => r.source_id)
  const followOf = new Map(follows.map((f) => [f.issue_id, f]))
  // Each shown task's own rows. A flagged task reads them from its own
  // indexes, which hold its marked rows too, with the marked links to it: a
  // marked link from a source without the flag is in no range its source
  // reads, so it goes out with this task. One from a flagged source goes
  // out with that source.
  const ownRows = await mapInBatches(ctx, tasks, async (task) => {
    if (task.relations_marked !== true)
      return {
        labels: labelsOf.get(task.id) ?? [],
        attachments: attachmentsOf.get(task.id) ?? [],
        links: linksOf.get(task.id) ?? [],
        incoming: [],
        follow: followOf.get(task.id) ?? null,
      }
    const [ls, as, lk, incoming, follow] = await Promise.all([
      atMost(ctx.db.query('issue_labels').withIndex('by_issue', (q) => q.eq('issue_id', task.id))),
      atMost(
        ctx.db.query('issue_attachments').withIndex('by_issue', (q) => q.eq('issue_id', task.id)),
      ),
      atMost(ctx.db.query('issue_links').withIndex('by_source', (q) => q.eq('source_id', task.id))),
      atMost(ctx.db.query('issue_links').withIndex('by_target', (q) => q.eq('target_id', task.id))),
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_profile', (q) => q.eq('issue_id', task.id).eq('profile_id', me.id))
        .unique(),
    ])
    if (ls === null || as === null || lk === null || incoming === null) return null
    return {
      labels: ls,
      attachments: as,
      links: lk,
      incoming: incoming.filter((link) => link.task_archived === true),
      follow,
    }
  })
  const own = ownRows?.filter((rows) => rows !== null) ?? []
  if (own.length !== tasks.length) return overflow(w)
  // Whether the caller is shown each task the rows name outside the window
  // (a parent, a link's target) and each source of a marked link to a
  // flagged task, each read at most once and in batches, as one task can
  // name thousands.
  const named = [
    ...new Set([
      ...tasks.flatMap((task) => (task.parent_id === undefined ? [] : [task.parent_id])),
      ...own.flatMap((rows) => rows.links.map((link) => link.target_id)),
    ]),
  ]
  const sources = [...new Set(own.flatMap((rows) => rows.incoming.map((link) => link.source_id)))]
  const namedShown = await mapInBatches(ctx, named, shown)
  const sourcesShown = await mapInBatches(ctx, sources, unflaggedShownSource)
  if (namedShown === null || sourcesShown === null) return overflow(w)
  const isShown = new Map(named.map((id, i) => [id, namedShown[i]]))
  const sourceShown = new Map(sources.map((id, i) => [id, sourcesShown[i]]))
  // The shown tasks' texts, from their description rows. A row can come
  // close to Convex's document size limit, so they are read by bytes
  // within PAGE.hard (model/descriptions.ts descriptionsOf), not in
  // PAGE.batch batches.
  const texts = await descriptionsOf(ctx, tasks, PAGE.hard)
  if (texts === null) return overflow(w)
  const issues = tasks.map((task): TaskRow => {
    const {
      parent_id: parent,
      relations_marked: _marks,
      window_key: _window,
      description: _stored,
      ...row
    } = rowOf(task)
    return {
      ...row,
      description: texts.get(task.id) ?? '',
      ...parentLink(task, () => parent !== undefined && isShown.get(parent) === true),
      // an active subtask in a live project makes this task a group, which
      // the app tells while subtasks in later windows are still to come
      has_subtasks: (kids.get(task.id)?.length ?? 0) > 0,
      // one the caller cannot see makes it a group whose subtasks they are
      // not all shown
      has_hidden_subtasks: (kids.get(task.id) ?? []).some((kid) => hiddenKid.get(kid.id)),
    }
  })
  const orgLoad = await hiddenLoadOf(ctx, me, access, read.rows, kids)
  if (orgLoad === null) return overflow(w)
  return {
    state: 'ok' as const,
    ...chunkLists({
      issues,
      orgLoad,
      // A link goes out with its source, once, when the caller is shown both
      // ends. The other end may be archived, deleted or hidden, and its id
      // must not leave this query.
      links: own
        .flatMap((rows) => [
          ...rows.links.filter((link) => isShown.get(link.target_id) === true),
          ...rows.incoming.filter((link) => sourceShown.get(link.source_id) === true),
        ])
        .map(relationRow),
      issueLabels: own.flatMap((rows) => rows.labels).map(relationRow),
      attachments: own.flatMap((rows) => rows.attachments).map(relationRow),
      // A follow outlives access, so a manager can still remove it, and one
      // of an archived task is marked in the background and stays stored, to
      // return with a restore.
      issueSubs: own.flatMap((rows) => (rows.follow === null ? [] : [relationRow(rows.follow)])),
    }),
    ...(await softSplit(
      ctx,
      w,
      read.split ||
        read.rows.length > PAGE.tasks.split ||
        [labels, attachments, links, follows].some((rows) => rows.length > PAGE.relations / 2),
      access.shared,
    )),
  }
}

// --- hidden load --------------------------------------------------------------

/* Hidden load rows in one total order, so an answer never depends on the
 * order the reads gave them and never tells which project or creation order
 * they came from. */
function byLoad(a: OrgLoadRow, b: OrgLoadRow): number {
  const keys = (r: OrgLoadRow) => [r.owner_id, r.start_week, r.end_week, r.remaining_set_at ?? '']
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return a.remaining - b.remaining
}

/** The load rows of the tasks of `read`, a window's active tasks, that
 * the caller is not shown (planning.ts, the fence in lib/loadRows.ts
 * loadRowFor), anonymized. Staff get every such row; anyone else only their
 * own. The app derives the rows of the tasks it shows itself. `kids` holds
 * the window's live active subtasks by parent, which make a task a group,
 * and the owner fence reads each owner once by id. */
async function hiddenLoadOf(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  access: Access,
  read: readonly Doc<'issues'>[],
  kids: ReadonlyMap<string, readonly Doc<'issues'>[]>,
): Promise<OrgLoadRow[] | null> {
  const staff = isOrgStaff(me)
  const loaded = read.filter(
    (task) =>
      task.start_week !== undefined &&
      !task.paused &&
      task.status !== 'done' &&
      (task.remaining_hours ?? 0) > 0 &&
      (staff || taskOwnerId(task) === me.id),
  )
  const hidden = await mapInBatches(
    ctx,
    loaded,
    async (task) =>
      (await access.live(task.project_id)) && !(await access.visible(task.project_id)),
  )
  if (hidden === null) return null
  const candidates = loaded.filter((_, i) => hidden[i])
  const owners = new Map<string, Promise<boolean>>()
  // the 0065 owner fence: the owner is a profile of this organization
  const ownerInOrg = (id: string) => {
    let known = owners.get(id)
    if (known === undefined) {
      known = byId(ctx, 'profiles', id).then((p) => p !== null && p.org_id === me.org_id)
      owners.set(id, known)
    }
    return known
  }
  const rows = await mapInBatches(ctx, candidates, async (task) => {
    const owner = taskOwnerId(task)
    if (owner === undefined || !(await ownerInOrg(owner))) return null
    return loadRowFor(task, {
      isGroup: (kids.get(task.id) ?? []).length > 0,
      projectLive: true,
      ownerInOrg: () => true,
      visible: false,
      staff,
      meId: me.id,
    })
  })
  return rows === null ? null : rows.filter((row) => row !== null).sort(byLoad)
}

// --- inbox --------------------------------------------------------------------

/** The caller's inbox in this organization: its kept unread rows, newest
 * first, and read rows, most recently read first, each read within
 * lib/inbox.ts's bounds (INBOX_LIMIT of each) and about tasks of the
 * caller's working set. Each task a message names is read once by id. The
 * app blends every seat's answer (lib/inbox.ts blendInbox). Rows about an
 * archived task, a task in an archived project or a task the caller can no
 * longer access stay stored and return if the task or access does, unless
 * they were removed meanwhile. An archive marks the rows about its tasks
 * read in the background (model/messages.ts), so the retention sweep and
 * removeRead delete them like any read row.
 *
 * A task read costs its whole body, and the messages can name 2,000 tasks,
 * more than 16 MiB of the largest ones. So once the reads pass PAGE.hard,
 * checked every PAGE.inboxCheck new tasks, a message about a task not read
 * yet counts as not shown, and the answer says it was cut (truncated, and
 * both bulk actions stay available). */
export async function readInbox(ctx: QueryCtx, me: Doc<'profiles'>) {
  const byIdShown = shownById(ctx, me, accessOf(ctx, me))
  const asked = new Set<string>()
  let cut = false
  const shown = async (id: string) => {
    if (!asked.has(id)) {
      if (cut) return false
      if (asked.size % PAGE.inboxCheck === 0 && (await readPast(ctx, PAGE.hard))) {
        cut = true
        return false
      }
      asked.add(id)
    }
    return await byIdShown(id)
  }
  const inbox = await loadInbox(ctx, me.id, shown, INBOX_LIMIT, INBOX_LIMIT)
  return {
    state: 'ok' as const,
    unread: inbox.unread.sort(newestFirst).map((m): AppRow<'messages'> => rowOf(m)),
    read: inbox.read.sort(recentlyReadFirst).map((m): AppRow<'messages'> => rowOf(m)),
    // The read rows kept minus snoozed ones, which removeRead leaves alone.
    // removeRead also deletes read rows about tasks the caller is not shown,
    // which are not counted because the caller cannot see them.
    readMessageCount: inbox.read.reduce((n, m) => n + (m.snoozed_until === undefined ? 1 : 0), 0),
    unreadTruncated: cut || inbox.unreadTruncated,
    readTruncated: cut || inbox.readTruncated,
    truncated: cut || inbox.truncated,
  }
}
