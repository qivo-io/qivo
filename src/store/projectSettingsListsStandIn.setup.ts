/* A stand-in for the four Settings project lists (convex/projectSettings.ts
   projects, subProjects, archived and archivedSubProjects) that answers
   from a workspace the app holds, for the jsdom tests and the browser
   benchmark's server (scripts/perf/server.mjs), as
   store/projectSettingsStandIn.setup.ts answers a project's Settings page.

   It applies the lists' rules (convex/model/projectSettingsLists.ts) to the
   workspace's rows, by the sight the store's Settings pages had before
   them, which src/store/projectSettingsListsParity.test.ts holds equal to
   the server's:
   - an active organization admin's seat lists every project of its
     organization in a top-level meta's tree that the workspace holds, the
     ones the parts leave out included when the caller hands it the whole
     world (the benchmark's `hidden` projects under role=admin);
   - any other seat lists what it sees, by the level rule of
     convex/lib/access.ts over the workspace's grants, team shares,
     memberships and leads (projectSettingsStandIn.setup.ts levelIn): a
     live top-level project it sees for a reason of its own or through a
     live sub-project, never one it sees only through an archived one, as
     the projects part leaves it out (design specification row 403); the
     live sub-projects it sees; an archived top-level project it sees for a
     reason of its own or through a sub-project, and an archived
     sub-project it sees;
   - each row's rights by managesIn's rule, an active admin or the
     project's effective lead (projectSettingsStandIn.setup.ts manages); a
     row beneath an archived parent carries its parent's `can_restore` and
     no Delete;
   - Settings › Projects and every sub-project list in the byte order of
     the name key (convex/lib/nameKey.ts), as Convex compares strings, with
     the id to break ties; Archived projects newest archived first, equal
     archive times by creation time and then id, newest first, where the
     server ties by _creationTime and _id;
   - a search keeps the rows whose name holds every whitespace-separated
     fragment of it, ignoring case and accents (convex/lib/search.ts):
     Settings › Projects lists the matching live projects and sub-projects
     together, each sub-project with its parent, and Archived projects also
     the matching sub-projects beneath an archived parent (`under`);
   - with `sub_project_parents`, only the live top-level projects the seat
     manages;
   - at most LIST_BATCH rows a batch, or with `through` every match up to
     and including it, stopping past four batches, with `next` and
     `stopped` as lib/namedPages.ts readBatch answers them.

   Its cursors are plain JSON of the list, the scope and the position, so
   equal positions give equal text, as the server's sealed cursors do, and
   a cursor of another list, organization, project, filter or search is
   refused with bad_request. It reads no read budget, so `not_ready`, a
   stopped batch, a failure, the access_unchecked refusal, `unavailable`
   and a smaller batch answer only when `force` asks for them. It imports
   nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues } from 'convex/values'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { NavChildRow } from '../../convex/model/projectNavReads'
import type {
  ArchivedChildRow,
  ArchivedProjectRow,
  SettingsListAnswer,
  SettingsProjectRow,
} from '../../convex/model/projectSettingsLists'
import {
  inMetaTree,
  levelIn,
  manages,
  memberOf,
  readsServer,
  type SettingsWorkspace,
} from './projectSettingsStandIn.setup'

/** The reads the stand-in answers, by their function names. */
export const PROJECT_LIST_READS = [
  'projectSettings:projects',
  'projectSettings:subProjects',
  'projectSettings:archived',
  'projectSettings:archivedSubProjects',
] as const

/** Whether `name` is one of the reads the stand-in answers. */
export const isProjectListRead = (name: string): boolean =>
  (PROJECT_LIST_READS as readonly string[]).includes(name)

/** States the stand-in answers whatever the workspace says, as the perf
    page's `projectlists` parameter names them:
    - `notReady`, every list answers `not_ready`;
    - `stop`, an open batch's read stops after this many projects looked
      at (at least one, as the server always reads its first);
    - `fail`, the reads that fail, by name without the module, such as
      'archived';
    - `unchecked`, every list answers the access_unchecked refusal with
      this sentence;
    - `unavailable`, the lists of one project's sub-projects answer
      `unavailable`;
    - `batch`, a smaller batch. */
export type ForcedProjectLists = {
  notReady?: boolean
  stop?: number
  fail?: readonly string[]
  unchecked?: string
  unavailable?: boolean
  batch?: number
}

type Profile = SettingsWorkspace['profiles'][number]
type Project = SettingsWorkspace['projects'][number]

/** The access_unchecked refusal's sentence, as convex/lib/access.ts
    accessUnchecked words it. */
export const LISTS_UNCHECKED =
  'Qivo could not finish checking which projects you can see in one request. Contact support@qivo.io so we can help.'

const NOT_LIST_CURSOR =
  'after and through must be cursors from an earlier answer of this list, with the same organization, project, search and sub_project_parents; start again from the first batch'

const badRequest = (message: string) => new ConvexError({ code: 'bad_request', message })

/* ------------------------------------------------------------ the sight */

/** Whether `me` lists by management sight (convex/lib/access.ts
    managesEveryProject). */
const managesAll = (me: Profile) => me.active && me.org_role === 'admin'

const isLive = (p: Project) => p.archived_at === undefined

/** The top-level metas of `me`'s organization the workspace holds. */
const roots = (ws: SettingsWorkspace, me: Profile) =>
  ws.projects.filter((p) => p.org_id === me.org_id && inMetaTree(p, p))

/** The sub-projects in `root`'s tree. */
const childrenOf = (ws: SettingsWorkspace, root: Project) =>
  ws.projects.filter(
    (c) => c.parent_id === root.id && c.org_id === root.org_id && inMetaTree(c, root),
  )

/** Whether `me` sees `p` for a reason of its own (a level), or as an
    admin manages it. */
const sees = (ws: SettingsWorkspace, me: Profile, p: Project) =>
  managesAll(me) || levelIn(ws, me, p) !== null

/** Whether Settings › Projects lists live top-level project `root` for
    `me`: an admin every one; anyone else one it sees, or one whose live
    sub-project it sees. */
const listsLive = (ws: SettingsWorkspace, me: Profile, root: Project) =>
  isLive(root) &&
  (sees(ws, me, root) || childrenOf(ws, root).some((c) => isLive(c) && sees(ws, me, c)))

/** Whether Archived projects lists archived top-level project `root` for
    `me`: one it sees, or one with a sub-project it sees. */
const listsArchived = (ws: SettingsWorkspace, me: Profile, root: Project) =>
  !isLive(root) && (sees(ws, me, root) || childrenOf(ws, root).some((c) => sees(ws, me, c)))

/* --------------------------------------------------------- the batches */

/* A place in a list: a key, and the ties that follow it. */
type At = { key: string; tie: readonly (string | number)[] }

/** The arguments every list takes. */
type ListArgs = { search?: string; after?: string; through?: string }

/** The search and cursors of `args` checked for list `list` with `scope`,
    as model/projectSettings.ts orderedListAsk checks them, the positions
    compared by `compare`. */
function askOf(
  list: string,
  scope: readonly string[],
  args: ListArgs,
  compare: (a: At, b: At) => number,
) {
  const search = (args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const sealed = [...scope, nameKey(search)]
  const open = (text: string | undefined): At | null => {
    if (text === undefined) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const [name, of, key, ...tie] = Array.isArray(parsed) ? parsed : []
    if (
      name !== list ||
      JSON.stringify(of) !== JSON.stringify(sealed) ||
      typeof key !== 'string' ||
      tie.length === 0 ||
      !tie.every((t) => typeof t === 'string' || typeof t === 'number')
    )
      throw badRequest(NOT_LIST_CURSOR)
    return { key, tie }
  }
  const after = open(args.after)
  const through = open(args.through)
  if (after !== null && through !== null && compare(through, after) <= 0)
    throw badRequest('through must be a cursor after the one in after')
  return {
    search,
    after,
    through,
    compare,
    seal: (at: At) => JSON.stringify([list, sealed, at.key, ...at.tie]),
  }
}

type Ask = ReturnType<typeof askOf>

/** Name key order, tied by the id. */
const byName = (a: At, b: At) => compareValues([a.key, ...a.tie], [b.key, ...b.tie])
/** Newest archived first, tied by creation time and then id, newest first. */
const byArchive = (a: At, b: At) => -compareValues([a.key, ...a.tie], [b.key, ...b.tie])

const nameAt = (p: Project): At => ({ key: nameKey(p.name), tie: [p.id] })
const archiveAt = (p: Project): At => ({
  key: p.archived_at ?? '',
  tie: [p.created_at ?? '', p.id],
})

/** One batch of `items`, each at its place, after `ask.after`, keeping
    what `keep` answers, as lib/namedPages.ts listBatch reads one. */
function batchOf<Out>(
  items: readonly { at: At; project: Project }[],
  ask: Ask,
  keep: (p: Project) => Out | null,
  force: ForcedProjectLists,
): { state: 'ready'; rows: Out[]; next: string | null; stopped: boolean } {
  const size = force.batch ?? LIST_BATCH
  const limit = ask.through === null ? size : 4 * size
  const sorted = [...items].sort((a, b) => ask.compare(a.at, b.at))
  const rows: Out[] = []
  let at: At | null = null
  let read = 0
  const answer = (next: At | null, stopped: boolean) => ({
    state: 'ready' as const,
    rows,
    next: next === null ? null : ask.seal(next),
    stopped,
  })
  for (const { at: place, project } of sorted) {
    if (ask.after !== null && ask.compare(place, ask.after) <= 0) continue
    if (ask.through !== null && ask.compare(place, ask.through) > 0)
      return answer(ask.through, false)
    if (rows.length >= limit && at !== null) {
      const short = ask.through !== null && ask.compare(at, ask.through) < 0
      return answer(at, short)
    }
    if (force.stop !== undefined && ask.through === null && read >= Math.max(1, force.stop) && at)
      return answer(at, rows.length < limit)
    read++
    at = place
    const kept = keep(project)
    if (kept !== null) rows.push(kept)
  }
  return answer(null, false)
}

const refOf = (p: Project) => ({ id: p.id, name: p.name, num: p.num })

/** The refusal or `not_ready` a forced state answers before any read. */
function forced(force: ForcedProjectLists): SettingsListAnswer<never> | null {
  if (force.unchecked !== undefined)
    return { state: 'unavailable', reason: 'access_unchecked', message: force.unchecked }
  if (force.notReady) return { state: 'not_ready' }
  return null
}

/* ------------------------------------------------------------ the lists */

/** What projectSettings.projects answers. */
export function settingsProjectsStandIn(
  ws: SettingsWorkspace,
  args: ListArgs & { org_id: string; sub_project_parents?: boolean },
  force: ForcedProjectLists = {},
): SettingsListAnswer<SettingsProjectRow> {
  const me = memberOf(ws, args.org_id)
  const parents = args.sub_project_parents === true
  const ask = askOf('projectSettings.projects', [me.org_id, parents ? 'parents' : ''], args, byName)
  const early = forced(force)
  if (early) return early
  const matches = allWordsMatcher(nameKey(ask.search))
  const top = (p: Project): SettingsProjectRow => ({
    ...refOf(p),
    parent: null,
    can_create_sub_project: manages(ws, me, p),
  })
  const live = roots(ws, me).filter((p) => listsLive(ws, me, p))
  if (parents || ask.search === '') {
    const shown = parents ? live.filter((p) => manages(ws, me, p)) : live
    return batchOf(
      shown.map((p) => ({ at: nameAt(p), project: p })),
      ask,
      (p) => (matches(nameKey(p.name)) ? top(p) : null),
      force,
    )
  }
  const parentOf = new Map(live.map((p) => [p.id, p]))
  const subs = live.flatMap((root) =>
    childrenOf(ws, root).filter((c) => isLive(c) && sees(ws, me, c)),
  )
  return batchOf(
    [...live, ...subs].map((p) => ({ at: nameAt(p), project: p })),
    ask,
    (p) => {
      if (!matches(nameKey(p.name))) return null
      const parent = p.parent_id === undefined ? undefined : parentOf.get(p.parent_id)
      return parent === undefined
        ? top(p)
        : { ...refOf(p), parent: refOf(parent), can_create_sub_project: false }
    },
    force,
  )
}

/** What projectSettings.subProjects answers. */
export function settingsSubProjectsStandIn(
  ws: SettingsWorkspace,
  args: { org_id: string; project_id: string; after?: string; through?: string },
  force: ForcedProjectLists = {},
): SettingsListAnswer<NavChildRow> {
  const me = memberOf(ws, args.org_id)
  const ask = askOf('projectSettings.subProjects', [me.org_id, args.project_id], args, byName)
  const early = forced(force)
  if (early) return early
  const root = roots(ws, me).find((p) => p.id === args.project_id)
  if (force.unavailable || root === undefined || !listsLive(ws, me, root))
    return { state: 'unavailable' }
  return batchOf(
    childrenOf(ws, root)
      .filter((c) => isLive(c))
      .map((c) => ({ at: nameAt(c), project: c })),
    ask,
    (c): NavChildRow | null =>
      sees(ws, me, c) ? { ...refOf(c), org_id: c.org_id, parent_id: root.id } : null,
    force,
  )
}

/** What projectSettings.archived answers. */
export function settingsArchivedStandIn(
  ws: SettingsWorkspace,
  args: ListArgs & { org_id: string },
  force: ForcedProjectLists = {},
): SettingsListAnswer<ArchivedProjectRow> {
  const me = memberOf(ws, args.org_id)
  const ask = askOf('projectSettings.archived', [me.org_id], args, byArchive)
  const early = forced(force)
  if (early) return early
  const matches = allWordsMatcher(nameKey(ask.search))
  const searching = ask.search !== ''
  type Entry = { at: At; project: Project; row: ArchivedProjectRow }
  const entries: Entry[] = []
  for (const root of roots(ws, me)) {
    const subs = childrenOf(ws, root).filter((c) => !isLive(c))
    if (!isLive(root)) {
      if (listsArchived(ws, me, root)) {
        const may = manages(ws, me, root)
        entries.push({
          at: archiveAt(root),
          project: root,
          row: {
            ...refOf(root),
            archived_at: root.archived_at ?? '',
            parent: null,
            under: false,
            with_parent: null,
            has_sub_projects: subs.length > 0,
            can_restore: may,
            can_delete: may,
          },
        })
      }
      // the sub-projects beneath it, which only a search lists
      if (searching)
        for (const sub of subs)
          if (sees(ws, me, sub))
            entries.push({
              at: archiveAt(sub),
              project: sub,
              row: {
                ...refOf(sub),
                archived_at: sub.archived_at ?? '',
                parent: refOf(root),
                under: true,
                with_parent: sub.archived_at === root.archived_at,
                has_sub_projects: null,
                can_restore: manages(ws, me, root),
                can_delete: false,
              },
            })
      continue
    }
    for (const sub of subs)
      if (sees(ws, me, sub)) {
        const may = manages(ws, me, sub)
        entries.push({
          at: archiveAt(sub),
          project: sub,
          row: {
            ...refOf(sub),
            archived_at: sub.archived_at ?? '',
            parent: refOf(root),
            under: false,
            with_parent: null,
            has_sub_projects: null,
            can_restore: may,
            can_delete: may,
          },
        })
      }
  }
  const rowOf = new Map(entries.map((e) => [e.project.id, e.row]))
  return batchOf(
    entries,
    ask,
    (p) => (matches(nameKey(p.name)) ? (rowOf.get(p.id) ?? null) : null),
    force,
  )
}

/** What projectSettings.archivedSubProjects answers. */
export function settingsArchivedChildrenStandIn(
  ws: SettingsWorkspace,
  args: { org_id: string; project_id: string; after?: string; through?: string },
  force: ForcedProjectLists = {},
): SettingsListAnswer<ArchivedChildRow> {
  const me = memberOf(ws, args.org_id)
  const ask = askOf(
    'projectSettings.archivedSubProjects',
    [me.org_id, args.project_id],
    args,
    byName,
  )
  const early = forced(force)
  if (early) return early
  const root = roots(ws, me).find((p) => p.id === args.project_id)
  if (force.unavailable || root === undefined || !listsArchived(ws, me, root))
    return { state: 'unavailable' }
  return batchOf(
    childrenOf(ws, root)
      .filter((c) => !isLive(c))
      .map((c) => ({ at: nameAt(c), project: c })),
    ask,
    (c): ArchivedChildRow | null =>
      sees(ws, me, c) ? { ...refOf(c), with_parent: c.archived_at === root.archived_at } : null,
    force,
  )
}

/**
 * What list `name` (such as 'projectSettings:archived') answers for `args`
 * while the server holds `ws`, read by the caller the workspace belongs
 * to. Throws as the server refuses, and for a read `force.fail` names.
 */
export function projectListsStandIn(
  ws: SettingsWorkspace,
  name: string,
  args: Record<string, unknown>,
  force: ForcedProjectLists = {},
): unknown {
  const short = name.slice('projectSettings:'.length)
  if (force.fail?.includes(short)) throw new Error(`${name} fails, as the stand-in was asked`)
  // the arguments as the query's validators take them
  const a = args as never
  switch (name) {
    case 'projectSettings:projects':
      return settingsProjectsStandIn(ws, a, force)
    case 'projectSettings:subProjects':
      return settingsSubProjectsStandIn(ws, a, force)
    case 'projectSettings:archived':
      return settingsArchivedStandIn(ws, a, force)
    case 'projectSettings:archivedSubProjects':
      return settingsArchivedChildrenStandIn(ws, a, force)
    default:
      throw new Error(`the project lists stand-in does not answer ${name}`)
  }
}

/**
 * A server double for the jsdom tests: the four lists over the workspace
 * `server()` answers, with the states `force()` asks for, on the double of
 * projectSettingsStandIn.setup.ts readsServer (`watch`, `query`, `rerun`,
 * `hold` and `open`).
 */
export function projectListsServer(
  server: () => SettingsWorkspace,
  force: () => ForcedProjectLists = () => ({}),
) {
  return readsServer((name, args) => projectListsStandIn(server(), name, args, force()))
}
