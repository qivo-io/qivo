/* The reader behind the workspace's one part (workspace.ts root), which
 * sends the caller's seats, organizations and own rows, and the row helpers
 * the task reads share (lib/taskWindow.ts, lib/viewReads.ts,
 * lib/relationPicker.ts). No part sends another person's profile,
 * membership or Team sync stamp, a team the caller is not in, a label, a
 * message, a task or a project with its grants; the app reads those by id
 * or a batch at a time, every task from its view's or its window's own
 * answer and every project through the navigation reads and
 * projectNav.byIds (projectNav.ts).
 *
 * No answer holds a value of its own run, such as the server's clock, and
 * nothing logs on a normal run, so Convex sends the part again only when
 * what it says changed (an unchanged rerun is not re-sent). */

import type { Doc, TableNames } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { countersRow, numbersOf, type OrgCounters } from '../model/orgs'
import { shownAvatarColor } from '../model/people'
import { accessUnchecked, OWN_READS } from './access'
import { orgCreateFor, seatlessState } from './billingAccess'
import { byId } from './db'

type AppRow<T extends TableNames> = Omit<Doc<T>, '_id' | '_creationTime'>

/** `doc` without its Convex system fields. */
export function rowOf<D extends { _id: unknown; _creationTime: number }>(
  doc: D,
): Omit<D, '_id' | '_creationTime'> {
  const { _id, _creationTime, ...row } = doc
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
export function relationRow<
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

/* An organization as the app receives it. Billing is admin-only; the task
 * number comes from org_counters (model/orgs.ts numbersOf), which the
 * creates preview the next number from. No count of tasks goes out. The
 * retired gravatar_avatars setting stays out. */
type OrgRow = Omit<AppRow<'organizations'>, 'billing' | 'gravatar_avatars'> &
  Pick<OrgCounters, 'next_issue_num'> & { billing?: Doc<'organizations'>['billing'] }

const orgRowFor = (
  doc: Doc<'organizations'>,
  counters: Pick<OrgCounters, 'next_issue_num'>,
  isAdmin: boolean,
): OrgRow => {
  const { _id, _creationTime, billing, gravatar_avatars: _gravatar, ...rest } = doc
  const row = { ...rest, ...counters }
  return isAdmin && billing !== undefined ? { ...row, billing } : row
}

/** A task as the app receives it. The parent id goes out only when the
 * reader is shown the parent (lib/workingSet.ts parentLink), and the text
 * comes from the task's description row (model/descriptions.ts
 * descriptionOf). */
export type TaskRow = Omit<AppRow<'issues'>, 'relations_marked' | 'parent_id' | 'window_key'> & {
  parent_id?: string
  /** always sent; absent reads as false, as in rows the app makes */
  has_subtasks?: boolean
  has_hidden_subtasks: boolean
  has_hidden_parent: boolean
}

/** The fields of task `task` that every app row of it carries: its stored
 * fields without the server-owned ones, its parent and its text, which each
 * read adds as its rules allow (TaskRow, lib/taskWindow.ts ShortRow). */
export function taskFields(task: Doc<'issues'>) {
  const {
    parent_id: _parent,
    relations_marked: _marks,
    window_key: _window,
    description: _stored,
    ...row
  } = rowOf(task)
  return row
}

// --- root -------------------------------------------------------------------

/* The caller's own rows the root part sends: each profile without its name
 * key and with its color as clients paint it (model/people.ts
 * shownAvatarColor), each membership and each team without its name key. */
type OwnProfile = KeyFree<AppRow<'profiles'>>
type OwnMembership = KeyFree<AppRow<'team_members'>>
type OwnTeam = KeyFree<AppRow<'teams'>>

/** The memberships of the caller's profile `me` and the teams they name of
 * `me`'s organization, each once: one range for the memberships, read with
 * take(OWN_READS.teams + 1), and one lookup a membership. A membership whose
 * team is gone or of another organization names no team. Past
 * OWN_READS.teams memberships it throws accessUnchecked's refusal rather
 * than send part of them, as the plannable hours write refuses past the
 * same bound (model/orgs.ts). That refusal is the root part's own, and it
 * is wider than the access layer's: on most paths the access layer skips
 * the team shares past the bound or asks team by team (lib/access.ts), so
 * such a person passes most checks, while this refusal fails the workspace
 * of every organization of the login. */
async function ownTeamsOf(ctx: QueryCtx, me: Doc<'profiles'>) {
  const most = OWN_READS.teams
  const memberships = await ctx.db
    .query('team_members')
    .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
    .take(most + 1)
  if (memberships.length > most) throw accessUnchecked()
  const teams: Doc<'teams'>[] = []
  for (const m of memberships) {
    const team = await byId(ctx, 'teams', m.team_id)
    if (team !== null && team.org_id === me.org_id && !teams.some((t) => t.id === team.id))
      teams.push(team)
  }
  return { memberships, teams }
}

/** The caller's seats and organizations, their own rows and when the login
 * may create an organization (lib/billingAccess.ts OrgCreate). With no seat
 * it can open, null when it may create one and no deletion holds it, else
 * the seatless answer (lib/billingAccess.ts seatlessState): whether a
 * running organization deletion holds its seats, and the create state. That
 * answer names no organization and no rows, only the reason and when the
 * login may create an organization.
 *
 * With a seat it answers, in seat order, the caller's active profiles
 * (`profiles`), every team membership of each (`teamMembers`) and the teams
 * those name (`teams`, ownTeamsOf), and nothing of another person: no other
 * profile, membership, Team sync stamp, team or label. So it reruns on the
 * caller's seat and membership changes and on a change to one of their
 * teams, beside the organization settings and counters. Past
 * OWN_READS.teams memberships of one seat it throws accessUnchecked's
 * refusal, which the app shows as the workspace's failure (ownTeamsOf).
 *
 * It reads the same in an organization at the design size's people as at
 * everyday values, and more only with a seat's teams and seats. The
 * closing review's report in qivo-internal
 * (evaluations/limits/closing-review-2026-11-09/closing-report.md, "Task
 * windows retirement" and "Projects part removal") holds its timed
 * figures, before and after the parts went. */
export async function readRoot(
  ctx: QueryCtx & { authUserId: string; myProfiles: Map<string, Doc<'profiles'>> },
) {
  /* Signed in but seatless is the app's "create your organization" signal,
   * unless an organization the login cannot open holds a seat, as one being
   * deleted or one that deactivated it. A failed read throws instead, so it
   * never looks like no seat. */
  if (ctx.myProfiles.size === 0) return await seatlessState(ctx, ctx.authUserId)
  const orgs: OrgRow[] = []
  const profiles: OwnProfile[] = []
  const teamMembers: OwnMembership[] = []
  const teams: OwnTeam[] = []
  for (const me of ctx.myProfiles.values()) {
    const org = await byId(ctx, 'organizations', me.org_id)
    if (org === null) continue // a seat in a vanished org contributes nothing
    profiles.push({ ...keyFree(rowOf(me)), color: shownAvatarColor(me.color) })
    const own = await ownTeamsOf(ctx, me)
    for (const m of own.memberships) teamMembers.push(keyFree(rowOf(m)))
    for (const team of own.teams) teams.push(keyFree(rowOf(team)))
    /* The task number alone, for every role: no count of tasks or
     * projects goes out, so a project create changes no seat's root answer
     * and nobody learns how much hidden work there is. */
    const counters = await countersRow(ctx, org.id)
    orgs.push(
      orgRowFor(
        org,
        { next_issue_num: numbersOf(counters).next_issue_num },
        me.org_role === 'admin',
      ),
    )
  }
  return {
    auth_user_id: ctx.authUserId,
    myProfileIds: [...ctx.myProfiles.values()].map((p) => p.id),
    orgs,
    profiles,
    teamMembers,
    teams,
    create: await orgCreateFor(ctx, ctx.authUserId),
  }
}
