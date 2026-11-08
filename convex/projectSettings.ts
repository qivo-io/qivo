/* A project's Settings page, read from the server: the project's fields and
 * the caller's rights on it, its Users and Teams access lists, the Add team
 * or user picker, the lead pickers and the invite form's lookup of one
 * address. The readers and their rules are in model/projectSettings.ts.
 * Beside them, the project lists of Settings, whose readers and rules are
 * in model/projectSettingsLists.ts.
 *
 * - get: the project's fields, its parent, its effective lead, what an empty
 *   Review time means, the caller's level and their rights, each the outcome
 *   of the write it names. An archived project answers its names only.
 * - users, teams: one batch of the project's explicit user grants or team
 *   shares in name order, 25 at a time, with search and Load more. A first
 *   batch of users also names the effective lead, outside its rows.
 * - candidates: the Add team or user picker of a project, or of the New
 *   project dialog without one, 25 choices at a time across teams and then
 *   people.
 * - leadCandidates: the people a lead write accepts, for a project's Lead
 *   field, a new sub-project or a new top-level project.
 * - inviteTarget: the seat an address names and its grant on the project.
 * - projects, subProjects: Settings › Projects, the top-level projects the
 *   caller's seat lists in one organization 25 at a time in name order,
 *   with search across projects and sub-projects, and one project's live
 *   sub-projects on expand.
 * - archived, archivedSubProjects: Archived projects, newest archived first
 *   25 at a time, with search, and the archived sub-projects beneath one
 *   archived project on request.
 *
 * The project lists judge an organization admin's seat by management, every
 * project of the organization, and any other seat by what it sees for
 * navigation, as today; each row's rights are the writes' rule. They answer
 * the access_unchecked refusal where a check the bounds of the caller's own
 * reads stopped, as the navigation reads do.
 *
 * Whoever sees a project or manages it reads its settings and lists; a
 * picker refuses, with the write's sentence, a caller the write would
 * refuse. An unknown id, a project of another organization, one in Deleted
 * items and one the caller neither sees nor manages answer `unavailable`
 * alike, as does one whose access check the bounds of the caller's own
 * reads stopped (lib/access.ts accessUnchecked). get addresses a project by
 * id, or by its organization and number for a numbered Settings address
 * the app's workspace does not hold, and judges it with the caller's seat
 * in that organization either way, so a free number answers as a hidden
 * one does; the others take the organization from the app, which has it
 * from get. They are live queries, like the page they serve, and
 * read no task, comment, file or milestone. The lists answer `not_ready`
 * until the organization's rows hold their name keys, and every list cursor
 * opens only for the list, arguments and search it came from.
 *
 * A project's Settings page in the app reads all six
 * (src/panels/settings/ProjectSettings.tsx) and subProjects for its
 * Sub-projects section; Settings › Projects and Archived projects read the
 * four project lists (src/panels/settings/ProjectLists.tsx). The New
 * project dialog reads leadCandidates and candidates without a project,
 * and the New sub-project dialog get for its parent, projects with
 * sub_project_parents for another parent and leadCandidates with
 * `parent_id` (src/panels/Modals.tsx). The writes stay in projects.ts. */

import { v } from 'convex/values'
import { authedQuery, orgQuery } from './lib/functions'
import type { NavChildRow } from './model/projectNavReads'
import {
  type AccessListAnswer,
  type CandidateRow,
  candidatesOf,
  type InviteTarget,
  inviteTargetOf,
  type LeadRow,
  leadCandidatesOf,
  type PersonRow,
  type PickerAnswer,
  type ProjectSettings,
  projectSettingsOf,
  projectTeamsOf,
  projectUsersOf,
  type TeamShareRow,
  type UserGrantRow,
} from './model/projectSettings'
import {
  type ArchivedChildRow,
  type ArchivedProjectRow,
  type SettingsListAnswer,
  type SettingsProjectRow,
  settingsArchivedChildrenOf,
  settingsArchivedOf,
  settingsProjectsOf,
  settingsSubProjectsOf,
} from './model/projectSettingsLists'

/** The arguments every list takes: an optional search, and the cursors of
 * the batch's start (`after`, none for the first batch) and, to keep a
 * loaded batch live, its end (`through`). */
const vListArgs = {
  search: v.optional(v.string()),
  after: v.optional(v.string()),
  through: v.optional(v.string()),
}

/** The settings of the project `id` names, or `num` in organization
 * `org_id`, for the caller's seat in its organization
 * (model/projectSettings.ts projectSettingsOf): `unavailable`, `archived`
 * with the project's and its parent's names, or `ok` with the project's
 * stored fields, its parent, `inherited_review_hours`, the effective `lead`
 * (`inherited` for a legacy sub-project led by its parent's lead), the
 * caller's `level` and the `can_*` rights (SettingsRights). Any form but
 * `id` alone and `org_id` with `num`, a whole number of at least 1, is a
 * bad_request. */
export const get = authedQuery({
  args: {
    id: v.optional(v.string()),
    org_id: v.optional(v.string()),
    num: v.optional(v.number()),
  },
  handler: (ctx, a): Promise<ProjectSettings> => projectSettingsOf(ctx, ctx.myProfiles, a),
})

/** One batch of the user grants on project `project_id`, in name order,
 * each with the person's level, the levels they may be given and whether
 * they may lead; in a first batch also `lead`, the effective lead when
 * their name matches the search (model/projectSettings.ts projectUsersOf).
 * Every row may be edited exactly when get answers `can_manage_users`. */
export const users = orgQuery({
  args: { project_id: v.string(), ...vListArgs },
  handler: (ctx, a): Promise<AccessListAnswer<UserGrantRow> & { lead?: LeadRow | null }> =>
    projectUsersOf(ctx, ctx.me, a),
})

/** One batch of the team shares on project `project_id`, in name order
 * (model/projectSettings.ts projectTeamsOf). Every row may be edited
 * exactly when get answers `can_manage_teams`. */
export const teams = orgQuery({
  args: { project_id: v.string(), ...vListArgs },
  handler: (ctx, a): Promise<AccessListAnswer<TeamShareRow>> => projectTeamsOf(ctx, ctx.me, a),
})

/** One batch of the Add team or user picker of project `project_id`, or
 * without it of a new top-level project, where `lead_id` names the lead the
 * dialog has chosen: teams and then people in name order, 25 in all
 * (model/projectSettings.ts candidatesOf). */
export const candidates = orgQuery({
  args: { project_id: v.optional(v.string()), lead_id: v.optional(v.string()), ...vListArgs },
  handler: (ctx, a): Promise<PickerAnswer<CandidateRow>> => candidatesOf(ctx, ctx.me, a),
})

/** One batch of the people a lead write accepts, for the Lead field of
 * project `project_id`, a new sub-project under `parent_id` or with neither
 * a new top-level project (model/projectSettings.ts leadCandidatesOf). */
export const leadCandidates = orgQuery({
  args: { project_id: v.optional(v.string()), parent_id: v.optional(v.string()), ...vListArgs },
  handler: (ctx, a): Promise<PickerAnswer<PersonRow>> => leadCandidatesOf(ctx, ctx.me, a),
})

/** The seat `email` names in the organization and its grant on project
 * `project_id`, for the invite form's `expected`, for a caller who may
 * invite (model/projectSettings.ts inviteTargetOf). */
export const inviteTarget = orgQuery({
  args: { project_id: v.string(), email: v.string() },
  handler: (ctx, a): Promise<InviteTarget> => inviteTargetOf(ctx, ctx.me, a),
})

/** One batch of Settings › Projects for the caller's seat in `org_id`
 * (model/projectSettingsLists.ts settingsProjectsOf): the organization's
 * live top-level projects for an admin, or those the seat sees, in name key
 * order with the id breaking ties, 25 a batch, each with whether the caller
 * may create a sub-project under it. With `search`, the matching live
 * projects and sub-projects together, each sub-project with its parent.
 * With `sub_project_parents`, only the projects under which the caller may
 * create a sub-project. */
export const projects = orgQuery({
  args: { ...vListArgs, sub_project_parents: v.optional(v.boolean()) },
  handler: (ctx, a): Promise<SettingsListAnswer<SettingsProjectRow>> =>
    settingsProjectsOf(ctx, ctx.me, a),
})

/** One batch of the live sub-projects of top-level project `project_id`
 * for Settings (model/projectSettingsLists.ts settingsSubProjectsOf): every
 * one for an admin, or those the seat sees, as projectNav.children answers
 * them, 25 a batch. */
export const subProjects = orgQuery({
  args: { project_id: v.string(), after: v.optional(v.string()), through: v.optional(v.string()) },
  handler: (ctx, a): Promise<SettingsListAnswer<NavChildRow>> =>
    settingsSubProjectsOf(ctx, ctx.me, a),
})

/** One batch of Archived projects for the caller's seat
 * (model/projectSettingsLists.ts settingsArchivedOf): the entries, an
 * archived top-level project or an archived sub-project of a live parent,
 * newest archived first, 25 a batch, each with its parent, whether the
 * caller may restore and delete it and whether archived sub-projects sit
 * beneath it. With `search`, also the matching sub-projects beneath an
 * archived parent, each with that parent. */
export const archived = orgQuery({
  args: vListArgs,
  handler: (ctx, a): Promise<SettingsListAnswer<ArchivedProjectRow>> =>
    settingsArchivedOf(ctx, ctx.me, a),
})

/** One batch of the archived sub-projects beneath archived top-level
 * project `project_id`, the chips of its entry, in name key order, each
 * with whether it was archived with it (model/projectSettingsLists.ts
 * settingsArchivedChildrenOf). */
export const archivedSubProjects = orgQuery({
  args: { project_id: v.string(), after: v.optional(v.string()), through: v.optional(v.string()) },
  handler: (ctx, a): Promise<SettingsListAnswer<ArchivedChildRow>> =>
    settingsArchivedChildrenOf(ctx, ctx.me, a),
})
