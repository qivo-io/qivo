/* The scope the parity oracles group by, from the server's whole: what the
   store's scopeInfo answered while it held every project the person sees
   (its groups, sub-projects and top-level projects), judged by the
   navigation reads' rule (store/projectNavStandIn.setup.ts byIds), for the
   tests that hold the server's view reads to the store's own rules over
   every task (store/overviewOracle.setup.ts, roadmapOracle.setup.ts and the
   parity tests). The store holds no project now, and each view takes its
   groups from its own answer (store/scopeGroups.ts); these oracles keep the
   reference the answers are checked against. */

import type { NavByIds } from '../../convex/model/projectNavReads'
import type { Whole } from './guard/liveDouble.setup'
import { P, type ScopeInfo } from './planner'
import { projectNavStandIn } from './projectNavStandIn.setup'
import type { Row } from './rows'
import type { ProjectFacts } from './viewModels'

/** A scope as the oracles read it: the store's ScopeInfo with the groups,
    sub-projects and top-level projects it held while it held every
    project, and `wide`, My view. */
export type OracleScope = ScopeInfo & {
  wide: boolean
  metas: ProjectFacts[]
  groups: { proj: ProjectFacts; subIds: string[] }[]
  subIds: string[]
  subIdSet: Set<string>
}

/** A stored project as the store's facts. */
export const factsOf = (p: Row<'projects'>): ProjectFacts => ({
  id: p.id,
  org: p.org_id,
  name: p.name,
  num: p.num,
  parent: p.parent_id ?? undefined,
  type: p.type === 'meta' ? 'meta' : 'project',
  trackDelay: p.track_delay !== false,
  lead: p.lead_id ?? undefined,
  reviewHours: p.review_hours,
})

/* Projects by their sort order, then creation and id, as the store's
   lists ordered them. */
const byOrder = (a: Row<'projects'>, b: Row<'projects'>) =>
  a.sort_order - b.sort_order ||
  a.created_at.localeCompare(b.created_at) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The live projects of `whole` the caller sees for navigation, by id with
    the level byIds answers. */
export function oracleLevels(whole: Whole): Map<string, string> {
  const live = whole.projects.filter((p) => !p.archived_at)
  const levels = new Map<string, string>()
  for (let at = 0; at < live.length; at += 100) {
    const answer = projectNavStandIn(whole, 'projectNav:byIds', {
      ids: live.slice(at, at + 100).map((p) => p.id),
    }) as NavByIds
    for (const row of answer.rows) levels.set(row.id, row.level)
  }
  return levels
}

/** The scope `scopeId` of the person `whole` is published for, as the
    store's scopeInfo answered it while it held every project, or null for
    a project the caller does not see, as it answered then. */
export function oracleScope(whole: Whole, scopeId: string): OracleScope | null {
  const levels = oracleLevels(whole)
  const live = whole.projects.filter((p) => !p.archived_at && levels.has(p.id))
  const childrenOf = (id: string) =>
    live.filter((p) => p.parent_id === id && p.type === 'project').sort(byOrder)
  if (scopeId === P.MINE_SCOPE) {
    const orgName = (org: string) => whole.orgs.find((o) => o.id === org)?.name ?? ''
    const home = whole.orgs[0]?.id
    const metas = live
      .filter((p) => p.type === 'meta')
      .sort(
        (a, b) =>
          (a.org_id === home ? 0 : 1) - (b.org_id === home ? 0 : 1) ||
          (a.org_id === b.org_id
            ? byOrder(a, b)
            : orgName(a.org_id).localeCompare(orgName(b.org_id))),
      )
    const groups = metas.map((m) => ({
      proj: factsOf(m),
      subIds: childrenOf(m.id).map((p) => p.id),
    }))
    const subIds = groups.flatMap((g) => g.subIds)
    return {
      mine: true,
      wide: true,
      only: P.isMine,
      id: scopeId,
      name: 'My view',
      proj: null,
      isMeta: false,
      meta: null,
      topId: null,
      state: 'ok',
      metas: metas.map(factsOf),
      groups,
      subIds,
      subIdSet: new Set(subIds),
    }
  }
  const p = live.find((x) => x.id === scopeId)
  if (!p) return null
  const isMeta = p.type === 'meta'
  const meta = isMeta ? p : live.find((x) => x.id === p.parent_id)
  const groups = isMeta
    ? childrenOf(p.id).map((sp) => ({ proj: factsOf(sp), subIds: [sp.id] }))
    : [{ proj: factsOf(p), subIds: [p.id] }]
  const subIds = groups.flatMap((g) => g.subIds)
  return {
    mine: false,
    wide: false,
    only: null,
    id: p.id,
    name: p.name,
    proj: factsOf(p),
    isMeta,
    meta: meta ? factsOf(meta) : null,
    topId: p.parent_id ?? p.id,
    state: 'ok',
    metas: meta ? [factsOf(meta)] : [],
    groups,
    subIds,
    subIdSet: new Set(subIds),
  }
}

/** A live project as the store held it while it held every project the
    person sees: its facts, key and sub-projects. */
export type OracleProject = ProjectFacts & { key: string; children: string[] | undefined }

/**
 * The projects the person `whole` is published for sees, as the store
 * listed them while it held every project (P.projects, P.visibleProjects,
 * P.canSee, P.canManageOwnProjectAccess), for the parity tests that hold
 * the navigation and Settings reads to that view. Levels follow the
 * navigation reads' rule (oracleLevels).
 */
export function oracleStore(whole: Whole) {
  const levels = oracleLevels(whole)
  const live = whole.projects.filter((p) => !p.archived_at && levels.has(p.id))
  const projects: OracleProject[] = live.sort(byOrder).map((p) => ({
    ...factsOf(p),
    key: p.key,
    children:
      p.type === 'meta' ? live.filter((c) => c.parent_id === p.id).map((c) => c.id) : undefined,
  }))
  const byId = new Map(projects.map((p) => [p.id, p]))
  const mine = oracleScope(whole, P.MINE_SCOPE)
  const admins = new Set(
    whole.profiles
      .filter((u) => whole.myProfileIds.includes(u.id) && u.org_role === 'admin' && u.active)
      .map((u) => u.org_id),
  )
  return {
    projects,
    project: (id: string) => byId.get(id),
    canSee: (id: string) => levels.has(id),
    visibleProjects: () => (mine?.metas ?? []).map((m) => byId.get(m.id) as OracleProject),
    canManage: (id: string) => {
      const p = byId.get(id)
      return !!p && (admins.has(p.org) || levels.get(id) === 'lead')
    },
  }
}

/** Opens scope `scopeId` the way App does from a navigation row: names the
    project and its top-level project with the store's project cache under
    `scope` and seeds their facts from the server's whole, so a view a test
    mounts on the scope asks at once, before the cache's read answers. My
    view names nothing. */
export function openScope(
  store: { seedProjects: typeof P.seedProjects; nameProjects: typeof P.nameProjects },
  whole: Whole,
  scopeId: string,
) {
  if (scopeId === P.MINE_SCOPE) return
  const p = whole.projects.find((x) => x.id === scopeId)
  if (!p) return
  const parent = p.parent_id ? whole.projects.find((x) => x.id === p.parent_id) : undefined
  const seed = (x: Row<'projects'>) => ({
    id: x.id,
    org_id: x.org_id,
    name: x.name,
    num: x.num,
    parent_id: x.parent_id ?? null,
  })
  store.seedProjects(parent ? [seed(p), seed(parent)] : [seed(p)])
  store.nameProjects('scope', parent ? [p.id, parent.id] : [p.id])
}

/** Names every live project of `whole` with the store's project cache under
    `test`, as the views, dialogs and task window of the app name the
    projects they show, and waits until the cache answers each of them
    (projectNav.byIds, which the test double answers from the whole), so a
    store test writes and creates into them as the app does once a view
    shows them. */
export async function nameProjects(
  store: { nameProjects: typeof P.nameProjects; projectState: typeof P.projectState },
  whole: Whole,
) {
  const ids = whole.projects.filter((p) => !p.archived_at).map((p) => p.id)
  store.nameProjects('test', ids)
  const levels = oracleLevels(whole)
  const until = Date.now() + 5_000
  while (ids.some((id) => levels.has(id) && store.projectState(id) !== 'ok')) {
    if (Date.now() > until) throw new Error('the project cache did not answer')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
