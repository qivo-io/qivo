/* The groups a view shows its scope in, from the view's own answer: the
   Board's lanes and side-boards and the Roadmap's tracks. The store holds
   no list of a scope's sub-projects (store/planner.ts P.scopeInfo answers
   only the scope's identity and state), so each view takes them from the
   answer the server decided by ordinary access, which names them whole,
   empty ones and refusals included, and names each through the project
   cache, which the store names the answer's projects with
   (store/planner.ts BOARD_QUERY, ROADMAP_QUERY `projects`). A group whose project the
   cache has not answered keeps its rows under a heading that says it is
   loading (`proj` null), never drops them and never shows as complete. */

import type { ProjectFacts } from './viewModels'

/** One group of a view: the project its heading names, a sub-project in a
    top-level project's scope, the scope itself for a sub-project, or a
    top-level project in My view, with the sub-projects whose rows it
    holds. */
export type ScopeGroup = {
  /** the project the heading names */
  id: string
  /** its facts, or null while the project cache has not answered for it,
      when the heading says it is loading */
  proj: ProjectFacts | null
  /** the sub-projects whose rows the group holds, in the answer's order */
  subIds: string[]
}

/** The scope a view groups, as P.scopeInfo answers it. */
export type GroupedScope = { mine: boolean; id: string; isMeta: boolean }

/** What a view's answer names for its groups: a project selection's
    sub-projects (`projects`: the Board's and the Roadmap's `projects`, the
    Overview summary's `sub_projects`), and in My view the top-level
    projects it keeps (`tops`, the Board's held_projects) and the
    sub-projects to fold under theirs (`subs`, the Roadmap's
    held_sub_projects and the projects of the rows on screen). */
export type GroupSource = {
  projects?: readonly string[]
  tops?: readonly string[]
  subs?: readonly string[]
}

/**
 * The groups of `scope` from `source`, each named through `facts` (the
 * project cache's P.project), in the answer's order:
 *
 * - a top-level project's scope: one group a sub-project the answer's
 *   `projects` names, none before an answer;
 * - a sub-project's scope: the scope itself, whatever the answer says;
 * - My view: one group a top-level project, `tops` first in their order,
 *   then the parents of `subs` as they first come, each holding its
 *   sub-projects among `subs`; a sub-project whose parent the cache has
 *   not answered stands for itself in a loading group until it does, so its
 *   rows show, never under a wrong heading.
 *
 * Each view orders the groups itself: the Board keeps the answer's order
 * for a project's selection and in My view puts the home organization
 * first, then by organization name and number (views/board/useBoardView.ts),
 * and the Roadmap sorts its tracks by name.
 */
export function scopeGroups(
  scope: GroupedScope,
  source: GroupSource | null,
  facts: (id: string) => ProjectFacts | undefined,
): ScopeGroup[] {
  const known = (id: string) => facts(id) ?? null
  if (!scope.mine) {
    if (!scope.isMeta) return [{ id: scope.id, proj: known(scope.id), subIds: [scope.id] }]
    return [...new Set(source?.projects ?? [])].map((id) => ({
      id,
      proj: known(id),
      subIds: [id],
    }))
  }
  const groups = new Map<string, ScopeGroup>()
  for (const top of source?.tops ?? [])
    if (!groups.has(top)) groups.set(top, { id: top, proj: known(top), subIds: [] })
  const loading: ScopeGroup[] = []
  for (const sub of new Set(source?.subs ?? [])) {
    const parent = facts(sub)?.parent
    if (parent === undefined) {
      // a sub-project the cache has not answered, or a top-level project a
      // row names, stands for itself
      const own = facts(sub)
      if (own && own.type === 'meta') {
        if (!groups.has(sub)) groups.set(sub, { id: sub, proj: own, subIds: [] })
        continue
      }
      loading.push({ id: sub, proj: null, subIds: [sub] })
      continue
    }
    let group = groups.get(parent)
    if (!group) {
      group = { id: parent, proj: known(parent), subIds: [] }
      groups.set(parent, group)
    }
    if (!group.subIds.includes(sub)) group.subIds.push(sub)
  }
  return [...groups.values(), ...loading]
}
