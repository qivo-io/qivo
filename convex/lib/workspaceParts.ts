/* The readers behind the workspace parts (workspace.ts), which together
 * send what the app shows of every organization the caller holds a seat in.
 *
 * The long sections come in windows of row ids (lib/idWindows.ts): a
 * window [from, to) of the organization's tasks, people or projects holds
 * the rows whose id falls in it. The app chooses them from the
 * organization's counters, so each window stays far inside Convex's limits
 * per query (4,096 index ranges, 32,000 documents, 16 MiB read, 1 s) and a
 * change re-sends only the window that holds it. A window reads its rows
 * and their relation rows each in one index range, by organization and id,
 * not one range per task. A window keeps its bounds while rows come and
 * go. One that grew past PAGE's soft budget answers `split: true`, and the
 * app cuts it in two (lib/idWindows.ts halve) while it keeps answering.
 * One whose reads would pass the hard budget stops early and answers
 * `overflow` instead, before Convex would refuse the read, so the app cuts
 * it before it shows it. A window that cannot be cut further and still does
 * not fit answers `refused` with a sentence the app shows. Bounds are fixed
 * points of the id space, so no bound says anything about the rows.
 *
 * No answer holds a value of its own run, such as the server's clock, and
 * nothing logs on a normal run, so Convex sends a part again only when what
 * it says changed (an unchanged rerun is not re-sent). */

import type { IndexRange } from 'convex/server'
import type { Doc, TableNames } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { shownLabelColor } from '../model/labels'
import { countersOf, type OrgCounters } from '../model/orgs'
import { shownAvatarColor } from '../model/people'
import { stampOfRow } from '../model/syncStamps'
import { isOrgStaff, projectLevelsOf } from './access'
import { chunkLists } from './arrayLimit'
import { byId } from './db'
import { halve, type IdWindow } from './idWindows.ts'
import { loadInbox, newestFirst, recentlyReadFirst } from './inbox'
import { INBOX_LIMIT } from './limits'
import { loadRowFor, type OrgLoadRow } from './loadRows'
import { taskOwnerId } from './review'
import { inWorkingSet, parentLink } from './workingSet'

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

/** A relation row as the app receives it, without the organization id and
 * the archive mark, which only serve index reads. */
function relationRow<
  D extends { _id: unknown; _creationTime: number; org_id?: string; task_archived?: true },
>(doc: D) {
  const { org_id: _orgId, task_archived: _mark, ...row } = rowOf(doc)
  return row
}

/* An organization as the app receives it. Billing is admin-only; the
 * counters come from org_counters (model/orgs.ts countersOf). The retired
 * gravatar_avatars setting stays out. */
type OrgRow = Omit<AppRow<'organizations'>, 'billing' | 'gravatar_avatars'> &
  OrgCounters & { billing?: Doc<'organizations'>['billing'] }

const orgRowFor = (doc: Doc<'organizations'>, counters: OrgCounters, isAdmin: boolean): OrgRow => {
  const { _id, _creationTime, billing, gravatar_avatars: _gravatar, ...rest } = doc
  const row = { ...rest, ...counters }
  return isAdmin && billing !== undefined ? { ...row, billing } : row
}

/* A person as the app receives it, with their Team sync stamp
 * (model/syncStamps.ts) as sync_at and sync_since. */
type ProfileRow = AppRow<'profiles'> & { sync_at?: string; sync_since?: string }

/* A task as the app receives it. The parent id goes out only when the
 * reader is shown the parent (lib/workingSet.ts parentLink). */
type TaskRow = Omit<AppRow<'issues'>, 'relations_marked' | 'parent_id'> & {
  parent_id?: string
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
  /** how many rows a part reads the per-row reads of at once */
  batch: 256,
}

/** Whether the transaction has read past `limit`. */
async function readPast(ctx: QueryCtx, limit: Budget): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics()
  return (
    m.bytesRead.used > limit.bytes ||
    m.documentsRead.used > limit.documents ||
    m.databaseQueries.used > limit.ranges
  )
}

/* What a part whose window cannot be cut any further answers. */
const TOO_MUCH =
  'One part of this organization holds more than Qivo can load at once. Contact support so we can help reduce it.'

/** The answer of a part over its hard budget: cut its window, or, when it
 * cannot be cut, refuse. */
const overflow = (w: IdWindow) =>
  halve(w) === null
    ? { state: 'refused' as const, message: TOO_MUCH }
    : { state: 'overflow' as const }

/** `{split: true}` when `over` or the part read past PAGE.soft and its
 * window can be cut, else nothing. */
async function softSplit(ctx: QueryCtx, w: IdWindow, over: boolean) {
  if (halve(w) === null) return {}
  return over || (await readPast(ctx, PAGE.soft)) ? { split: true as const } : {}
}

/* Index range bounds of a window on an index whose next field is `field`. */
type IdBounded<F extends string> = {
  gte(field: F, value: string): IndexRange & { lt(field: F, value: string): IndexRange }
}
function ids<F extends string>(q: IdBounded<F>, field: F, w: IdWindow): IndexRange {
  const from = q.gte(field, w.from)
  return w.to === null ? from : from.lt(field, w.to)
}

/** One page of a window's own rows, at most `most` and PAGE.soft.bytes of
 * them, in one system call (a stream costs one per row). `complete` says
 * the page holds every row. */
async function pageOf<R>(
  query: {
    paginate(opts: {
      cursor: null
      numItems: number
      maximumBytesRead: number
    }): Promise<{ page: R[]; isDone: boolean }>
  },
  most: number,
): Promise<{ rows: R[]; complete: boolean }> {
  const { page, isDone } = await query.paginate({
    cursor: null,
    numItems: most,
    maximumBytesRead: PAGE.soft.bytes,
  })
  return { rows: page, complete: isDone }
}

/** Runs `step` over `rows` in batches of PAGE.batch, checking PAGE.hard
 * before each batch after the first. Answers whether it read them all. */
async function inBatches<R>(
  ctx: QueryCtx,
  rows: readonly R[],
  step: (row: R, at: number) => Promise<void>,
): Promise<boolean> {
  for (let at = 0; at < rows.length; at += PAGE.batch) {
    if (at > 0 && (await readPast(ctx, PAGE.hard))) return false
    await Promise.all(rows.slice(at, at + PAGE.batch).map((row, i) => step(row, at + i)))
  }
  return true
}

// --- root -------------------------------------------------------------------

/** The caller's seats and organizations, or null with no seat. */
export async function readRoot(
  ctx: QueryCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> },
) {
  /* Signed in but seatless is the app's "create your organization" signal.
   * A failed read throws instead, so it never looks like no seat. */
  if (ctx.myProfiles.size === 0) return null
  const orgs: OrgRow[] = []
  for (const me of ctx.myProfiles.values()) {
    const org = await byId(ctx, 'organizations', me.org_id)
    if (org === null) continue // a seat in a vanished org contributes nothing
    orgs.push(orgRowFor(org, await countersOf(ctx, org), me.org_role === 'admin'))
  }
  return {
    auth_user_id: ctx.authUserId,
    myProfileIds: [...ctx.myProfiles.values()].map((p) => p.id),
    orgs,
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
      teams: teams.map((team): IconFree<'teams'> => iconFree(team)),
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
  if (!read.complete) return overflow(w)
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
      ...rowOf(p),
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
    ...chunkLists({ profiles, teamMembers: memberships.flat().map(rowOf) }),
    ...(await softSplit(ctx, w, people.length > PAGE.people.split)),
  }
}

// --- access -------------------------------------------------------------------

/** The caller's access as one part asks it, project by project, each
 * project and its levels read once (lib/access.ts projectLevelsOf). A part
 * reads only the projects its rows name, not every project of the
 * organization, so thousands of projects and hundreds of teams of the
 * caller cost each part only its own, and a change to a project re-runs only
 * the parts that read it. `read` holds projects the part already read. */
function accessOf(ctx: QueryCtx, me: Doc<'profiles'>, read: readonly Doc<'projects'>[] = []) {
  const levels = projectLevelsOf(ctx, me, read)
  /* the project of the caller's organization with this id */
  const projectOf = async (id: string) => {
    const p = await levels.project(id)
    return p !== null && p.org_id === me.org_id ? p : undefined
  }
  const visible = async (id: string) => (await levels.level(id)) !== null
  return {
    /** Whether the caller can see the project with this id
     * (canSeeProject). */
    visible,
    /** Whether the project with this id is one of the organization's and
     * is not archived (lib/liveTasks.ts liveIn). */
    live: async (id: string) => {
      const p = await projectOf(id)
      return p !== undefined && p.archived_at === undefined
    },
    /** Whether `task` is in the caller's working set (lib/workingSet.ts). */
    holds: async (task: Doc<'issues'>) => {
      const p = await projectOf(task.project_id)
      if (p === undefined || p.archived_at !== undefined) return false
      return inWorkingSet(task, p, await visible(p.id))
    },
  }
}

/* What accessOf answers. */
type Access = ReturnType<typeof accessOf>

// --- projects -----------------------------------------------------------------

/** The projects of window `w` the caller can see, archived ones included
 * for navigation, oldest first, with every grant on them, their team grants,
 * and the milestones of the active ones. It reads the window's projects in
 * one range, the caller's levels on each and on its parent, and up to three
 * ranges per shown project. */
export async function readProjects(ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow) {
  const read = await pageOf(
    ctx.db.query('projects').withIndex('by_org_id', (q) => ids(q.eq('org_id', me.org_id), 'id', w)),
    PAGE.projects.most,
  )
  if (!read.complete) return overflow(w)
  const caller = accessOf(ctx, me, read.rows)
  const seen = await Promise.all(read.rows.map((p) => caller.visible(p.id)))
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
      projects: shown.map((p): IconFree<'projects'> => iconFree(p)),
      // Every grant on a shown project, other members' too. The app shows
      // only those of people it holds (lib/workspaceJoin.ts), as a removed
      // person's grants can outlive their profile for a moment
      // (model/cascade.ts removeProfile).
      access: access.flat().map(rowOf),
      teamAccess: teamAccess.flat().map(rowOf),
      milestones: milestones.flat().map(rowOf),
    }),
    ...(await softSplit(ctx, w, shown.length > PAGE.projects.split)),
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

/** The active tasks of window `w`, every project's, at most `most`. */
const windowTasks = (ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow, most: number) =>
  pageOf(
    ctx.db
      .query('issues')
      .withIndex('by_org_archived_id', (q) =>
        ids(q.eq('org_id', me.org_id).eq('archived_at', undefined), 'id', w),
      ),
    most,
  )

/** The active subtasks of the tasks of window `w`, by parent, in live
 * projects: one range. */
async function liveKids(ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow, access: Access) {
  const kids = await ctx.db
    .query('issues')
    .withIndex('by_org_archived_parent', (q) =>
      ids(q.eq('org_id', me.org_id).eq('archived_at', undefined), 'parent_id', w),
    )
    .collect()
  const live = await Promise.all(kids.map((kid) => access.live(kid.project_id)))
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
 * It reads the window's active tasks, the unmarked label assignments,
 * attachments and links of its ids, and the caller's unmarked follows of
 * them, each in one range by organization (or person) and id. Rows of an
 * archived task carry a mark (model/archiveMarks.ts) and stay out; a task
 * restored before its marks were cleared (relations_marked) reads its own
 * rows, marked ones included, and shows its marked follow. A task outside
 * the window that a shown task names (its parent, a link's target) is read
 * by id to see whether the caller is shown it. The window's active subtasks
 * are read in one more range, for has_hidden_subtasks and for the load rows
 * of the window's tasks the caller is not shown (orgLoad, hiddenLoadOf).
 * Each project these tasks are in is read once, with the caller's levels on
 * it (accessOf). */
export async function readTasks(ctx: QueryCtx, me: Doc<'profiles'>, w: IdWindow) {
  const read = await windowTasks(ctx, me, w, PAGE.tasks.most)
  if (!read.complete) return overflow(w)
  const access = accessOf(ctx, me)
  const held = await Promise.all(read.rows.map((t) => access.holds(t)))
  const tasks = read.rows.filter((_, i) => held[i])
  const inPage = new Set(tasks.map((t) => t.id))
  const byIdShown = shownById(ctx, me, access)
  const shown = async (id: string) => inPage.has(id) || (await byIdShown(id))
  const [labels, attachments, links, follows, kids] = await Promise.all([
    ctx.db
      .query('issue_labels')
      .withIndex('by_org_task_archived_issue', (q) =>
        ids(q.eq('org_id', me.org_id).eq('task_archived', undefined), 'issue_id', w),
      )
      .collect(),
    ctx.db
      .query('issue_attachments')
      .withIndex('by_org_task_archived_issue', (q) =>
        ids(q.eq('org_id', me.org_id).eq('task_archived', undefined), 'issue_id', w),
      )
      .collect(),
    ctx.db
      .query('issue_links')
      .withIndex('by_org_task_archived_source', (q) =>
        ids(q.eq('org_id', me.org_id).eq('task_archived', undefined), 'source_id', w),
      )
      .collect(),
    ctx.db
      .query('issue_subscriptions')
      .withIndex('by_profile_task_archived_issue', (q) =>
        ids(q.eq('profile_id', me.id).eq('task_archived', undefined), 'issue_id', w),
      )
      .collect(),
    liveKids(ctx, me, w, access),
  ])
  // a kid in a live project the caller cannot see
  const hiddenKid = new Map<string, boolean>()
  await Promise.all(
    [...kids.values()].flat().map(async (kid) => {
      hiddenKid.set(kid.id, !(await access.visible(kid.project_id)))
    }),
  )
  const labelsOf = groupBy(labels, (r) => r.issue_id)
  const attachmentsOf = groupBy(attachments, (r) => r.issue_id)
  const linksOf = groupBy(links, (r) => r.source_id)
  const followOf = new Map(follows.map((f) => [f.issue_id, f]))
  const issues: TaskRow[] = []
  const rows = {
    links: [] as Doc<'issue_links'>[][],
    labels: [] as Doc<'issue_labels'>[][],
    attachments: [] as Doc<'issue_attachments'>[][],
    follows: [] as (Doc<'issue_subscriptions'> | null)[],
  }
  const done = await inBatches(ctx, tasks, async (task, at) => {
    let own = {
      labels: labelsOf.get(task.id) ?? [],
      attachments: attachmentsOf.get(task.id) ?? [],
      links: linksOf.get(task.id) ?? [],
      follow: followOf.get(task.id) ?? null,
    }
    if (task.relations_marked === true) {
      // its own indexes hold its marked rows too
      const [ls, as, lk, f] = await Promise.all([
        ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
          .collect(),
        ctx.db
          .query('issue_attachments')
          .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
          .collect(),
        ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', task.id))
          .collect(),
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_profile', (q) => q.eq('issue_id', task.id).eq('profile_id', me.id))
          .unique(),
      ])
      own = { labels: ls, attachments: as, links: lk, follow: f }
    }
    const parentShown = task.parent_id !== undefined && (await shown(task.parent_id))
    const targetsShown = await Promise.all(own.links.map((link) => shown(link.target_id)))
    const { parent_id: _parentId, relations_marked: _marks, ...row } = rowOf(task)
    issues[at] = {
      ...row,
      ...parentLink(task, () => parentShown),
      // an active subtask in a live project the caller cannot see makes
      // this task a group whose subtasks they are not all shown
      has_hidden_subtasks: (kids.get(task.id) ?? []).some((kid) => hiddenKid.get(kid.id)),
    }
    // A link goes out with its source, once, when the caller is shown both
    // ends. The other end may be archived, deleted or hidden, and its id must
    // not leave this query.
    rows.links[at] = own.links.filter((_, i) => targetsShown[i])
    rows.labels[at] = own.labels
    rows.attachments[at] = own.attachments
    // A follow outlives access, so a manager can still remove it, and one of
    // an archived task is marked in the background and stays stored, to
    // return with a restore.
    rows.follows[at] = own.follow
  })
  if (!done) return overflow(w)
  return {
    state: 'ok' as const,
    ...chunkLists({
      issues,
      orgLoad: await hiddenLoadOf(ctx, me, access, read.rows, kids),
      links: rows.links.flat().map(relationRow),
      issueLabels: rows.labels.flat().map(relationRow),
      attachments: rows.attachments.flat().map(relationRow),
      issueSubs: rows.follows.flatMap((f) => (f === null ? [] : [relationRow(f)])),
    }),
    ...(await softSplit(ctx, w, read.rows.length > PAGE.tasks.split)),
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
): Promise<OrgLoadRow[]> {
  const staff = isOrgStaff(me)
  const loaded = read.filter(
    (task) =>
      task.start_week !== undefined &&
      !task.paused &&
      task.status !== 'done' &&
      (task.remaining_hours ?? 0) > 0 &&
      (staff || taskOwnerId(task) === me.id),
  )
  const hidden = await Promise.all(
    loaded.map(
      async (task) =>
        (await access.live(task.project_id)) && !(await access.visible(task.project_id)),
    ),
  )
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
  const rows = await Promise.all(
    candidates.map(async (task) => {
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
    }),
  )
  return rows.filter((row) => row !== null).sort(byLoad)
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
 * removeRead delete them like any read row. */
export async function readInbox(ctx: QueryCtx, me: Doc<'profiles'>) {
  const access = accessOf(ctx, me)
  const inbox = await loadInbox(ctx, me.id, shownById(ctx, me, access), INBOX_LIMIT, INBOX_LIMIT)
  return {
    state: 'ok' as const,
    unread: inbox.unread.sort(newestFirst).map((m): AppRow<'messages'> => rowOf(m)),
    read: inbox.read.sort(recentlyReadFirst).map((m): AppRow<'messages'> => rowOf(m)),
    // The read rows kept minus snoozed ones, which removeRead leaves alone.
    // removeRead also deletes read rows about tasks the caller is not shown,
    // which are not counted because the caller cannot see them.
    readMessageCount: inbox.read.reduce((n, m) => n + (m.snoozed_until === undefined ? 1 : 0), 0),
    unreadTruncated: inbox.unreadTruncated,
    readTruncated: inbox.readTruncated,
    truncated: inbox.truncated,
  }
}
