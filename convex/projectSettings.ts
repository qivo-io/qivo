/* A project's Settings page, read from the server: the project's fields and
 * the caller's rights on it, its Users and Teams access lists, the Add team
 * or user picker, the lead pickers and the invite form's lookup of one
 * address. The readers and their rules are in model/projectSettings.ts.
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
 *
 * Whoever sees a project or manages it reads its settings and lists; a
 * picker refuses, with the write's sentence, a caller the write would
 * refuse. An unknown id, a project of another organization, one in Deleted
 * items and one the caller neither sees nor manages answer `unavailable`
 * alike. get addresses a project by id alone and resolves the caller's seat
 * in its organization; the others take the organization from the app, which
 * has it from get. They are live queries, like the page they serve, and
 * read no task, comment, file or milestone. The lists answer `not_ready`
 * until the organization's rows hold their name keys, and every list cursor
 * opens only for the list, arguments and search it came from.
 *
 * The app does not call these yet; t3/limits-project-settings-ui moves the
 * Settings page and the New project and New sub-project dialogs onto them.
 * The writes stay in projects.ts. */

import { v } from 'convex/values'
import { authedQuery, orgQuery } from './lib/functions'
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

/** The arguments every list takes: an optional search, and the cursors of
 * the batch's start (`after`, none for the first batch) and, to keep a
 * loaded batch live, its end (`through`). */
const vListArgs = {
  search: v.optional(v.string()),
  after: v.optional(v.string()),
  through: v.optional(v.string()),
}

/** The settings of project `id` for the caller's seat in its organization
 * (model/projectSettings.ts projectSettingsOf): `unavailable`, `archived`
 * with the project's and its parent's names, or `ok` with the project's
 * stored fields, its parent, `inherited_review_hours`, the effective `lead`
 * (`inherited` for a legacy sub-project led by its parent's lead), the
 * caller's `level` and the `can_*` rights (SettingsRights). */
export const get = authedQuery({
  args: { id: v.string() },
  handler: (ctx, { id }): Promise<ProjectSettings> => projectSettingsOf(ctx, ctx.myProfiles, id),
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
