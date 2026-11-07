/* A stand-in for the project navigation reads (convex/projectNav.ts page,
   children, search and resolve) that answers from a workspace the app
   holds, for the jsdom tests of the shared project picker and its callers,
   the All projects directory and the sidebar's project tree, and for the
   browser benchmark's server (scripts/perf/server.mjs), as
   store/labelPagesStandIn.setup.ts answers Settings › Labels.

   It applies the reads' rule (convex/model/projectNavReads.ts) to the
   workspace's projects, grants, team shares and memberships, judging every
   seat by ordinary access, so an organization admin's lists hold only the
   projects their own leads, grants and team shares reach, as on the server
   (lib/access.ts ordinaryOf). A top-level project shows when it is a live
   meta of the seat's organization that the seat leads or holds a grant or
   a team share on, or under which a live sub-project gives the seat a
   level; a sub-project shows when it and its parent are live and the seat
   holds a level on it, its own or its parent's. The workspace sends every
   project a seat sees, and every project of the organization to an admin,
   with every grant and team share on each, so the rule finds every row
   the reads would show.

   The lists come in the reads' order: page and search put the favorites
   first, then the rest, each by the name key's bytes (convex/lib/nameKey.ts,
   compared as Convex compares strings), then the project id and then the
   organization; children by the name key and then the id. The search
   matches every word of the search's name key anywhere in each project's
   own name key (convex/lib/search.ts allWordsMatcher), top-level projects
   and sub-projects together, each sub-project with its parent, across
   every seat or in the one `org_id` names. It refuses a search past
   LIMITS.search with that limit's sentence, a search with nothing to match
   and an empty org_id with bad_request, as the server does, and resolve
   any form but `project_id` alone or `org_id` with `num`.

   A batch holds LIST_BATCH rows, or with `through` every row up to it and
   at most four times that, stopping short past them, and `next` null at
   the list's end. Its cursors are plain JSON of the list, its scope and
   the position, so equal positions give equal text, as the server's sealed
   cursors do, and a cursor of another list or scope is refused with
   bad_request. The workspace carries no favorites, and the stand-in reads
   no read budget and no readiness stamp, so favorites, `not_ready`, the
   access_unchecked refusal, a stopped batch, a failing read and a smaller
   batch answer only when `force` asks for them. `force.favorites` may be a
   set the caller keeps, which setFavoriteStandIn changes as
   projectNav.setFavorite changes a seat's rows (model/projectFavorites.ts
   setFavoriteCore), so the reads' next answers move a starred project
   between their groups, for the All projects directory's jsdom tests and
   the benchmark's star.
   src/store/projectNavParity.test.ts compares it with the real reads and
   the real star. It imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type {
  NavBatch,
  NavChildRow,
  NavChildren,
  NavPage,
  NavPageRow,
  NavProject,
  NavResolve,
  NavSearch,
  NavSearchRow,
} from '../../convex/model/projectNavReads'

/** The workspace sections the reads' rule reads. */
export type NavWorkspace = Pick<
  Workspace,
  | 'auth_user_id'
  | 'myProfileIds'
  | 'profiles'
  | 'projects'
  | 'access'
  | 'teamAccess'
  | 'teams'
  | 'teamMembers'
>

/** States the stand-in answers whatever the workspace says: `not_ready`
    from every list (`notReady`), the access_unchecked refusal from every
    read with this sentence (`unchecked`), an open batch whose read stops
    after this many projects looked at (`stop`, at least one, as the server
    always reads its first), a read that fails (`fail`), a smaller batch
    (`batch`), and the top-level projects that are favorites of their
    seat (`favorites`, by id), read at every answer, so a set the caller
    keeps and setFavoriteStandIn changes moves a project at the next. */
export type ForcedProjectNav = {
  notReady?: boolean
  unchecked?: string
  stop?: number
  fail?: boolean
  batch?: number
  favorites?: Iterable<string>
}

/** The access_unchecked refusal's sentence, as convex/lib/access.ts
    accessUnchecked words it. */
export const NAV_UNCHECKED =
  'Qivo could not finish checking which projects you can see in one request. Contact support@qivo.io so we can help.'

/* The server's refusals (convex/model/projectNavReads.ts), which
   src/store/projectNavParity.test.ts holds to the server's own. */
export const NAV_BLANK_SEARCH =
  'search must hold a character besides spaces and accents; browse with projectNav.page'
export const NAV_EMPTY_ORG = 'org_id must name an organization, or be left out to search every seat'
export const NAV_RESOLVE_FORM =
  'resolve takes project_id alone, or org_id with num, a whole number of at least 1'
const NOT_A_CURSOR =
  'after and through must be cursors from an earlier answer of this list; start again from the first batch'

type Project = Workspace['projects'][number]
type Profile = Workspace['profiles'][number]
type Level = 'lead' | 'user' | 'viewer'

/* A place in a list: the key, then the tie (the project id and, for page
   and search, the seat's organization). */
type Position = readonly string[]

const LEVEL_RANK: Record<Level, number> = { viewer: 1, user: 2, lead: 3 }
const higher = (a: Level | null, b: Level | null): Level | null =>
  (a ? LEVEL_RANK[a] : 0) >= (b ? LEVEL_RANK[b] : 0) ? a : b

/** The rule of the reads over `w`, for its active seats. */
function navRule(w: NavWorkspace, favorites: ReadonlySet<string>) {
  const byId = new Map(w.projects.map((p) => [p.id, p]))
  const teamOrg = new Map(w.teams.map((t) => [t.id, t.org_id]))
  const seats = w.profiles.filter((p) => w.myProfileIds.includes(p.id) && p.active !== false)
  const seatIn = (orgId: string) => seats.find((s) => s.org_id === orgId)

  /* The seat's role as ordinary access judges it, an admin as a user. */
  const roleOf = (me: Profile) => (me.org_role === 'admin' ? 'user' : me.org_role)
  /* Whether `me` leads `p`, whose top-level project is `root`. */
  const leads = (me: Profile, p: Project, root: Project) => {
    const role = roleOf(me)
    return (role === 'user' || role === 'guest') && (p.lead_id ?? root.lead_id) === me.id
  }
  /* The seat's own grant and team share on `p`. */
  const direct = (me: Profile, p: Project): Level | null => {
    let level: Level | null = null
    for (const g of w.access)
      if (g.project_id === p.id && g.profile_id === me.id) level = higher(level, g.level)
    if (roleOf(me) === 'guest') return level
    for (const g of w.teamAccess) {
      if (g.project_id !== p.id || teamOrg.get(g.team_id) !== me.org_id) continue
      if (w.teamMembers.some((m) => m.team_id === g.team_id && m.profile_id === me.id))
        level = higher(level, g.level)
    }
    return level
  }
  /* The seat's level on `p` without navigation (lib/access.ts levelUnder
     of ordinaryOf(seat)), null outside a meta's tree or the organization. */
  const levelOf = (me: Profile, p: Project): Level | null => {
    const root = p.parent_id === undefined ? p : byId.get(p.parent_id)
    if (!root || p.org_id !== me.org_id || root.org_id !== me.org_id) return null
    if (root.parent_id !== undefined || root.type !== 'meta') return null
    if (p.id !== root.id && p.parent_id !== root.id) return null
    if (leads(me, p, root)) return 'lead'
    let level = direct(me, p)
    if (p.id !== root.id) level = higher(level, leads(me, root, root) ? 'user' : direct(me, root))
    return roleOf(me) === 'viewer' && level ? 'viewer' : level
  }
  const live = (p: Project | undefined): p is Project => !!p && p.archived_at === undefined
  /* The live sub-projects of `parent` in its organization. */
  const liveChildren = (parent: Project) =>
    w.projects.filter((c) => c.parent_id === parent.id && live(c) && c.org_id === parent.org_id)
  /** Whether `me` sees `p` at all through ordinary access, as a star
      asks (lib/access.ts accessOf visible): a level of its own, or for a
      top-level meta one on any of its sub-projects, live or archived. */
  const visible = (me: Profile, p: Project): boolean => {
    if (p.org_id !== me.org_id) return false
    if (levelOf(me, p) !== null) return true
    return (
      p.parent_id === undefined &&
      p.type === 'meta' &&
      w.projects.some((c) => c.parent_id === p.id && levelOf(me, c) !== null)
    )
  }
  /** Whether `me` sees `p` for navigation by the reads' rule. */
  const sees = (me: Profile, p: Project): boolean => {
    if (p.org_id !== me.org_id || !live(p)) return false
    if (p.parent_id !== undefined) {
      const parent = byId.get(p.parent_id)
      if (!live(parent) || parent.type !== 'meta' || parent.parent_id !== undefined) return false
      return parent.org_id === p.org_id && levelOf(me, p) !== null
    }
    if (p.type !== 'meta') return false
    return levelOf(me, p) !== null || liveChildren(p).some((c) => levelOf(me, c) !== null)
  }
  const nav = (p: Project): NavProject => ({ id: p.id, org_id: p.org_id, name: p.name, num: p.num })
  return {
    byId,
    seats,
    seatIn,
    sees,
    visible,
    liveChildren,
    nav,
    starred: (p: Project) => favorites.has(p.id),
  }
}

/* The cursor of `position` in list `list` with scope `scope`. */
const seal = (list: string, scope: readonly string[], position: Position) =>
  JSON.stringify([list, scope, position])

/* The position cursor `text` holds for list `list` with scope `scope`, or
   null for none; refuses a cursor of another list, scope or shape. */
function open(
  list: string,
  scope: readonly string[],
  size: number,
  text: string | undefined,
): Position | null {
  if (text === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const [name, of, at] = Array.isArray(parsed) ? parsed : []
  if (
    name !== list ||
    JSON.stringify(of) !== JSON.stringify(scope) ||
    !Array.isArray(at) ||
    at.length !== size ||
    at.some((part) => typeof part !== 'string')
  )
    throw new ConvexError({ code: 'bad_request', message: NOT_A_CURSOR })
  return at as string[]
}

/* One batch of `candidates`, in order by position, after `after` and up
   to `through`, keeping each candidate `keep` answers a row for, as
   convex/lib/namedPages.ts readBatch and listBatch read one. */
function batchOf<Row>(
  list: string,
  scope: readonly string[],
  candidates: readonly { at: Position; row: Row | null }[],
  after: Position | null,
  through: Position | null,
  force: ForcedProjectNav,
): NavBatch<Row> {
  const size = force.batch ?? LIST_BATCH
  const limit = through === null ? size : 4 * size
  const rows: Row[] = []
  let at: Position | null = after
  let read = 0
  const answer = (next: Position | null, stopped: boolean): NavBatch<Row> => ({
    state: 'ok',
    rows,
    next: next === null ? null : seal(list, scope, next),
    stopped,
  })
  for (const c of candidates) {
    if (after !== null && compareValues([...c.at], [...after]) <= 0) continue
    // a batch kept live between two cursors ends at its own
    if (through !== null && compareValues([...c.at], [...through]) > 0)
      return answer(through, false)
    // a full batch reads one row more, so a batch that ends with the list
    // says so; past four batches a pinned one stops short of its end
    if (rows.length >= limit && at !== null)
      return answer(at, through !== null && compareValues([...at], [...through]) < 0)
    if (force.stop !== undefined && through === null && read >= Math.max(1, force.stop) && at)
      return answer(at, true)
    read++
    at = c.at
    if (c.row !== null) rows.push(c.row)
  }
  return answer(null, false)
}

const byPosition = <C extends { at: Position }>(list: C[]) =>
  list.sort((a, b) => compareValues([...a.at], [...b.at]))

/** The four reads' names, as the app calls them. */
export const PROJECT_NAV_READS = [
  'projectNav:page',
  'projectNav:children',
  'projectNav:search',
  'projectNav:resolve',
] as const
export type ProjectNavRead = (typeof PROJECT_NAV_READS)[number]

/** The arguments of the four reads. */
export type ProjectNavArgs = {
  after?: string
  through?: string
  project_id?: string
  org_id?: string
  num?: number
  search?: string
}

/**
 * What read `name` answers for `args` while the server holds `workspace`,
 * read by the login the workspace belongs to. Throws as the server
 * refuses: a search past LIMITS.search, a blank search, an empty org_id, a
 * cursor this list did not give for the same scope, and any other form of
 * resolve's arguments; and with `force.fail` as a failing read.
 */
export function projectNavStandIn(
  workspace: NavWorkspace,
  name: 'projectNav:page',
  args: ProjectNavArgs,
  options?: { force?: ForcedProjectNav },
): NavPage
export function projectNavStandIn(
  workspace: NavWorkspace,
  name: 'projectNav:children',
  args: ProjectNavArgs,
  options?: { force?: ForcedProjectNav },
): NavChildren
export function projectNavStandIn(
  workspace: NavWorkspace,
  name: 'projectNav:search',
  args: ProjectNavArgs,
  options?: { force?: ForcedProjectNav },
): NavSearch
export function projectNavStandIn(
  workspace: NavWorkspace,
  name: 'projectNav:resolve',
  args: ProjectNavArgs,
  options?: { force?: ForcedProjectNav },
): NavResolve
export function projectNavStandIn(
  workspace: NavWorkspace,
  name: ProjectNavRead,
  args: ProjectNavArgs,
  options?: { force?: ForcedProjectNav },
): NavPage | NavChildren | NavSearch | NavResolve
export function projectNavStandIn(
  workspace: NavWorkspace,
  name: ProjectNavRead,
  args: ProjectNavArgs,
  options: { force?: ForcedProjectNav } = {},
): NavPage | NavChildren | NavSearch | NavResolve {
  const force = options.force ?? {}
  const rule = navRule(workspace, new Set(force.favorites ?? []))
  const unchecked =
    force.unchecked === undefined
      ? null
      : ({ state: 'unavailable', reason: 'access_unchecked', message: force.unchecked } as const)

  if (name === 'projectNav:resolve') {
    const byNumber = args.org_id !== undefined || args.num !== undefined
    const whole = args.num !== undefined && Number.isInteger(args.num) && args.num >= 1
    if (args.project_id !== undefined ? byNumber : !whole || args.org_id === undefined)
      throw new ConvexError({ code: 'bad_request', message: NAV_RESOLVE_FORM })
    if (force.fail) throw new Error('the navigation read fails, as the stand-in was asked')
    const p =
      args.project_id !== undefined
        ? rule.byId.get(args.project_id)
        : workspace.projects.find((x) => x.org_id === args.org_id && x.num === args.num)
    const seat = p ? rule.seatIn(p.org_id) : undefined
    if (!p || !seat) return { state: 'unavailable' }
    if (unchecked) return unchecked
    if (!rule.sees(seat, p)) return { state: 'unavailable' }
    const parent = p.parent_id === undefined ? null : rule.byId.get(p.parent_id)
    return {
      state: 'ok',
      project: {
        ...rule.nav(p),
        parent: parent ? rule.nav(parent) : null,
        favorite: parent ? null : rule.starred(p),
      },
    }
  }

  if (name === 'projectNav:search') {
    const text = (args.search ?? '').trim()
    if (overText(LIMITS.search, text))
      throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
    const term = nameKey(text)
    if (term === '') throw new ConvexError({ code: 'bad_request', message: NAV_BLANK_SEARCH })
    if (args.org_id === '') throw new ConvexError({ code: 'bad_request', message: NAV_EMPTY_ORG })
    const scope = [workspace.auth_user_id ?? '', args.org_id ?? '', term]
    const list = 'projectNav.search'
    const after = open(list, scope, 3, args.after)
    const through = open(list, scope, 3, args.through)
    if (force.fail) throw new Error('the navigation read fails, as the stand-in was asked')
    if (force.notReady) return { state: 'not_ready' }
    if (unchecked) return unchecked
    const matches = allWordsMatcher(term)
    const candidates: { at: Position; row: NavSearchRow | null }[] = []
    for (const seat of rule.seats) {
      if (args.org_id !== undefined && seat.org_id !== args.org_id) continue
      for (const p of workspace.projects) {
        if (!rule.sees(seat, p)) continue
        const parent = p.parent_id === undefined ? null : (rule.byId.get(p.parent_id) ?? null)
        const favorite = parent ? null : rule.starred(p)
        const key = nameKey(p.name)
        candidates.push({
          at: [`${favorite ? '0' : '1'}${key}`, p.id, seat.org_id],
          row: matches(key)
            ? { ...rule.nav(p), parent: parent ? rule.nav(parent) : null, favorite }
            : null,
        })
      }
    }
    return batchOf(list, scope, byPosition(candidates), after, through, force)
  }

  if (name === 'projectNav:children') {
    const list = 'projectNav.children'
    const scope = [args.project_id ?? '']
    const after = open(list, scope, 2, args.after)
    const through = open(list, scope, 2, args.through)
    if (force.fail) throw new Error('the navigation read fails, as the stand-in was asked')
    const p = args.project_id === undefined ? undefined : rule.byId.get(args.project_id)
    const seat = p ? rule.seatIn(p.org_id) : undefined
    if (!p || !seat) return { state: 'unavailable' }
    if (unchecked) return unchecked
    if (!rule.sees(seat, p)) return { state: 'unavailable' }
    if (p.parent_id !== undefined) return { state: 'ok', rows: [], next: null, stopped: false }
    if (force.notReady) return { state: 'not_ready' }
    const candidates = rule
      .liveChildren(p)
      .filter((c) => rule.sees(seat, c))
      .map((c) => ({
        at: [nameKey(c.name), c.id] as Position,
        row: { ...rule.nav(c), parent_id: p.id } satisfies NavChildRow,
      }))
    return batchOf(list, scope, byPosition(candidates), after, through, force)
  }

  const list = 'projectNav.page'
  const after = open(list, [], 3, args.after)
  const through = open(list, [], 3, args.through)
  if (force.fail) throw new Error('the navigation read fails, as the stand-in was asked')
  if (force.notReady) return { state: 'not_ready' }
  if (unchecked) return unchecked
  const candidates: { at: Position; row: NavPageRow }[] = []
  for (const seat of rule.seats)
    for (const p of workspace.projects) {
      if (p.parent_id !== undefined || !rule.sees(seat, p)) continue
      const favorite = rule.starred(p)
      candidates.push({
        at: [`${favorite ? '0' : '1'}${nameKey(p.name)}`, p.id, seat.org_id],
        row: { ...rule.nav(p), favorite },
      })
    }
  return batchOf(list, [], byPosition(candidates), after, through, force)
}

/** Whether `name` is one of the four reads. */
export const isProjectNavRead = (name: string): name is ProjectNavRead =>
  (PROJECT_NAV_READS as readonly string[]).includes(name)

/** The star's name, as the app sends it. */
export const PROJECT_NAV_STAR = 'projectNav:setFavorite'

/** The refusals of a star (model/projectFavorites.ts), which
    src/store/projectNavParity.test.ts holds to the server's own. */
export const NAV_NOT_FOUND = 'project not found'
export const NAV_TOP_LEVEL_ONLY = 'only a top-level project can be a favorite'

/**
 * What projectNav.setFavorite does to `favorites`, the starred top-level
 * projects by id, for `args` while the server holds `workspace`, by
 * setFavoriteCore's rule: a star of an unknown project, one of another
 * organization or one the seat does not see through ordinary access is
 * refused alike with not_found, one of a sub-project the seat sees with
 * bad_request; an unstar always goes through. A login without a seat in
 * `org_id` is refused as orgMutation refuses it. It knows no billing
 * state, so a read-only refusal comes from the caller's double. Answers
 * null, as the server does.
 */
export function setFavoriteStandIn(
  workspace: NavWorkspace,
  favorites: Set<string>,
  args: { org_id: string; project_id: string; favorite: boolean },
): null {
  const rule = navRule(workspace, favorites)
  const seat = rule.seatIn(args.org_id)
  if (!seat)
    throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  if (!args.favorite) {
    favorites.delete(args.project_id)
    return null
  }
  const p = rule.byId.get(args.project_id)
  if (!p || !rule.visible(seat, p))
    throw new ConvexError({ code: 'not_found', message: NAV_NOT_FOUND })
  if (p.parent_id !== undefined)
    throw new ConvexError({ code: 'bad_request', message: NAV_TOP_LEVEL_ONLY })
  favorites.add(p.id)
  return null
}

/** Answers a test double's subscription to one of the four reads with
    `args` over `workspace` through `next`, or through `fail` where the
    stand-in refuses or fails, as answerLabelPages answers Settings ›
    Labels'. */
export function answerProjectNav(
  workspace: NavWorkspace,
  name: ProjectNavRead,
  args: unknown,
  next: (value: unknown) => void,
  fail?: (error: unknown) => void,
  options?: { force?: ForcedProjectNav },
) {
  let answer: unknown
  try {
    answer = projectNavStandIn(workspace, name, args as ProjectNavArgs, options)
  } catch (error) {
    fail?.(error)
    return
  }
  next(structuredClone(answer))
}

/** What a test double's one-shot query of one of the four reads, such as
    P.resolveProject's projectNav:resolve, resolves with, or rejects with
    where the stand-in refuses or fails. */
export const queryProjectNav = (
  workspace: NavWorkspace,
  name: ProjectNavRead,
  args: unknown,
  options?: { force?: ForcedProjectNav },
): Promise<unknown> => {
  try {
    return Promise.resolve(
      structuredClone(projectNavStandIn(workspace, name, args as ProjectNavArgs, options)),
    )
  } catch (error) {
    return Promise.reject(error)
  }
}
