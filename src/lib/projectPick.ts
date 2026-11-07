/* What the shared project picker (components/ProjectPicker.tsx) picks, and
   the rules each caller picks by. It imports nothing from the store, so
   node tests and later callers share it.

   A pick is All projects of every organization (Search), All projects of
   one organization, or one or more projects and sub-projects of one
   organization, in the order picked. The rows come from the navigation
   reads (convex/projectNav.ts), which judge each one by ordinary access;
   a pick goes only to reads that check access themselves
   (issues.archivedPage, search.page, deletedItems.page), so a project that
   was picked and is later archived, deleted or hidden answers there like
   any project the person cannot see.

   These reads take a top-level project with its sub-projects, the first
   two its live ones and Deleted items its live and archived ones, so in
   many mode a picked top-level project covers its sub-projects: their rows
   show included, a pick of one of them is refused, and picking the project
   drops their earlier picks. Each pick counts one of PICK_MOST. In one
   mode every pick replaces the last, so a sub-project of the picked
   project narrows the pick to it.

   Beside them are the bounds of the other lists on the navigation reads,
   the All projects directory's expanded list (DIRECTORY_MOST) and the
   sidebar's project tree (SIDEBAR_MOST). */

import type { NavProject } from '../../convex/model/projectNavReads'

/** The most projects one pick holds, issues.archivedPage's
    ARCHIVED_SCOPE.ids (convex/lib/archivedTasks.ts) and Deleted items' 50
    `scope.project_ids`, which src/lib/projectPick.test.ts pins. */
export const PICK_MOST = 50

/** The most rows the picker's browse or search list holds (eight batches,
    the projects figure of the design size), and the most sub-projects of
    one project it lists (the design size is 30). Tests lower them and set
    them back. */
export const PROJECT_PICKER_MOST = { list: 200, children: 50 }

/** The most sub-projects the All projects directory's expanded list
    gathers (components/ProjectDirectory.tsx): four batches, past the
    design size's 30 live sub-projects under one project, then it asks for
    a search, as Settings' open lists do. Tests lower it and set it back. */
export const DIRECTORY_MOST = { children: 100 }

/** The most rows the sidebar's project tree gathers
    (components/SidebarProjects.tsx): its top-level list holds the design
    size's 200 live top-level projects of one organization, eight batches
    as the picker's list, then points to All projects; the one expanded
    project's list holds four batches, past the design size's 30 live
    sub-projects under one project, as the directory's and Settings' do,
    then asks for a search. The tree grows to these bounds and keeps what
    it read, a fixed bound at the design size rather than a window that
    drops rows. Tests lower them and set them back. */
export const SIDEBAR_MOST = { list: 200, children: 100 }

/** A project as the picker picks it: a navigation row with its top-level
    project, null for a top-level one. */
export type PickedProject = NavProject & { parent: NavProject | null }

/** What the picker has picked: All projects of every organization
    (`every`), All projects of one organization (`org`), or projects of one
    organization in the order picked (`projects`), never empty. */
export type ProjectPick =
  | { kind: 'every' }
  | { kind: 'org'; org_id: string }
  | { kind: 'projects'; org_id: string; projects: readonly PickedProject[] }

/** How a caller picks: several projects (`many`) or one, at most `most`
    (PICK_MOST by default), all of one organization (`oneOrg`), and which
    fixed rows it offers (`all`): All projects of every organization and of
    each one (`every`), All projects of each organization (`org`), or none. */
export type PickRules = {
  many: boolean
  most?: number
  oneOrg: boolean
  all: 'every' | 'org' | 'none'
}

/** Why a row cannot be picked now: the pick holds `most` projects, it is
    of another organization than the pick under `oneOrg`, or a picked
    top-level project covers it. */
export type PickRefusal = 'most' | 'org' | 'covered'

/** A fixed row of the picker: All projects of every organization, or of
    one. */
export type FixedPick = { kind: 'every' } | { kind: 'org'; org_id: string }

/** The projects `pick` holds, none for a fixed row's pick. */
export const pickedProjects = (pick: ProjectPick | null): readonly PickedProject[] =>
  pick?.kind === 'projects' ? pick.projects : []

/** Whether `row` is picked itself (`picked`), included in a picked
    top-level project (`included`), or neither (null), for its checked and
    disabled state. */
export function covered(
  pick: ProjectPick | null,
  row: PickedProject,
): 'picked' | 'included' | null {
  const picked = pickedProjects(pick)
  if (picked.some((p) => p.id === row.id)) return 'picked'
  if (row.parent !== null && picked.some((p) => p.id === row.parent?.id)) return 'included'
  return null
}

/** Why `row` cannot be added to `pick` under `rules`, or null when it can.
    One mode refuses nothing, as a press there replaces the pick. In many
    mode a row already picked is never refused, as a press then takes it
    off. */
export function refusalOf(
  pick: ProjectPick | null,
  row: PickedProject,
  rules: PickRules,
): PickRefusal | null {
  if (!rules.many) return null
  const state = covered(pick, row)
  if (state === 'picked') return null
  if (state === 'included') return 'covered'
  if (pick?.kind !== 'projects') return null
  if (rules.oneOrg && row.org_id !== pick.org_id) return 'org'
  // a top-level project that drops its sub-projects' picks frees their room
  const kept = pick.projects.filter((p) => p.parent?.id !== row.id)
  return kept.length >= (rules.most ?? PICK_MOST) ? 'most' : null
}

/**
 * The pick after a press on `row`, or the reason it is refused. In one mode
 * the row replaces the pick. In many mode a picked row is taken off, which
 * leaves null when it was the last; another is added after the earlier
 * picks, and a top-level project drops the picks of its sub-projects. A
 * project replaces a fixed row's pick.
 */
export function pickRow(
  pick: ProjectPick | null,
  row: PickedProject,
  rules: PickRules,
): { pick: ProjectPick | null } | { refused: PickRefusal } {
  const plain: PickedProject = {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    num: row.num,
    parent: row.parent,
  }
  if (!rules.many) return { pick: { kind: 'projects', org_id: row.org_id, projects: [plain] } }
  if (covered(pick, row) === 'picked') return { pick: unpick(pick, row.id) }
  const refused = refusalOf(pick, row, rules)
  if (refused !== null) return { refused }
  const earlier = pick?.kind === 'projects' ? pick.projects : []
  const kept = earlier.filter((p) => p.parent?.id !== row.id)
  const orgId = pick?.kind === 'projects' ? pick.org_id : row.org_id
  return { pick: { kind: 'projects', org_id: orgId, projects: [...kept, plain] } }
}

/** `pick` without project `id`, null once no project is left. A fixed
    row's pick stays as it is. */
export function unpick(pick: ProjectPick | null, id: string): ProjectPick | null {
  if (pick?.kind !== 'projects') return pick
  const projects = pick.projects.filter((p) => p.id !== id)
  return projects.length === 0 ? null : { ...pick, projects }
}

/** Whether `pick` is fixed row `fixed`'s pick. */
export const isFixedPick = (pick: ProjectPick | null, fixed: FixedPick): boolean =>
  fixed.kind === 'every'
    ? pick?.kind === 'every'
    : pick?.kind === 'org' && pick.org_id === fixed.org_id

/** Main Search's scope (search.page `scope`), one organization and in it
    one project. */
export type PickSearchScope = { org_id: string; project_id?: string }

/** The scope search.page reads for `pick`: none for All projects of every
    organization, the organization, or the organization with its one
    project. Undefined for a pick Search cannot take, several projects. */
export function searchScopeOf(pick: ProjectPick): PickSearchScope | null | undefined {
  if (pick.kind === 'every') return null
  if (pick.kind === 'org') return { org_id: pick.org_id }
  const [only] = pick.projects
  return pick.projects.length === 1 && only
    ? { org_id: pick.org_id, project_id: only.id }
    : undefined
}

/** Archived tasks' scope (store/planner.ts ArchivedScope). */
export type PickArchivedScope = { org: string; projectIds: string[] } | { org: string; all: true }

/** The scope issues.archivedPage reads for `pick`: All projects of the
    organization, or its projects in pick order. Undefined for All projects
    of every organization, which it cannot take. */
export function archivedScopeOf(pick: ProjectPick): PickArchivedScope | undefined {
  if (pick.kind === 'every') return undefined
  if (pick.kind === 'org') return { org: pick.org_id, all: true }
  return { org: pick.org_id, projectIds: pick.projects.map((p) => p.id) }
}

/** Deleted items' scope (deletedItems.page `scope`). */
export type PickDeletedScope =
  | { org_id: string; project_ids: string[] }
  | { org_id: string; all: true }

/** The scope deletedItems.page reads for `pick`: All projects of the
    organization, or its projects in pick order. Undefined for All projects
    of every organization, which Deleted items does not offer. */
export function deletedScopeOf(pick: ProjectPick): PickDeletedScope | undefined {
  if (pick.kind === 'every') return undefined
  if (pick.kind === 'org') return { org_id: pick.org_id, all: true }
  return { org_id: pick.org_id, project_ids: pick.projects.map((p) => p.id) }
}

/** A project's name for a label, after its top-level project's for a
    sub-project: "Luma Sensor › Firmware". */
export const placeName = (p: PickedProject): string =>
  p.parent ? `${p.parent.name} › ${p.name}` : p.name

/** What the picker's trigger says for `pick`, naming an organization with
    `orgName`: "All projects", "All projects in Partner Co", "Luma Sensor",
    "Luma Sensor › Firmware" or "Luma Sensor and 2 more". `none` for no pick. */
export function pickLabel(
  pick: ProjectPick | null,
  orgName: (orgId: string) => string | null,
  none = 'Choose projects…',
): string {
  if (pick === null) return none
  if (pick.kind === 'every') return 'All projects'
  if (pick.kind === 'org') {
    const name = orgName(pick.org_id)
    return name ? `All projects in ${name}` : 'All projects'
  }
  const [first, ...rest] = pick.projects
  if (!first) return none
  return rest.length === 0 ? placeName(first) : `${placeName(first)} and ${rest.length} more`
}
