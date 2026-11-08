/* Continuation cursors of REST and MCP lists, the refusals of an offset and
 * of a list in name order whose names are not ready, and the one page that
 * every REST and MCP list in name order answers.
 *
 * REST GET /v1/tasks and MCP list_tasks page their active tasks with these
 * (lib/activeTaskPage.ts), REST GET /v1/workload and MCP get_workload their
 * people (planning.ts workloadPage), REST GET /v1/users, /v1/labels,
 * /v1/teams and /v1/teams/{id}/members and MCP list_users, list_labels,
 * list_teams and list_team_members their rows (namedListPage, from
 * lib/core.ts userPage, model/labels.ts labelPage and model/teams.ts
 * teamPage and memberPage), and REST GET /v1/tasks/{ref}/subtasks, /links,
 * /followers and /attachments and MCP list_task_related a task's related
 * lists, whose first pages REST GET /v1/tasks/{ref} and MCP get_task answer
 * with a cursor each (lib/core.ts relatedPage and taskOut), REST GET
 * /v1/projects and MCP list_projects the projects a caller sees, in tree
 * order (machine/projects.ts projectPage), and REST GET
 * /v1/projects/{ref}/users, /milestones, /access/users and /access/teams
 * and MCP list_project_users and list_project_related a project's users,
 * milestones, user grants and team shares (lib/core.ts projectUserPage and
 * machine/projects.ts milestoneRows and grantRows), whose last three first
 * pages REST GET /v1/projects/{ref} and MCP get_project answer with a
 * cursor each (machine/projects.ts projectDetail). REST GET /v1/inbox and MCP
 * list_inbox (t3/limits-machine-inbox) are to page with them too. A
 * cursor is a position in one list's order, sealed with the
 * list's name and its scope (lib/namedPages.ts namedCursor over
 * lib/archiveCursorSeal.ts), so it shows nothing and opens only for the list
 * and scope it came from. A cursor of another list, organization, caller or
 * filter, or a changed cursor, opens to null and is refused with
 * CURSOR_REFUSAL. A list names each surface apart where the surfaces answer
 * different rows, as the active tasks do, whose REST search widens on `*`;
 * the workload, the lists of namedListPage and a task's related lists,
 * whose surfaces answer the same rows, name one list for both, so a cursor
 * continues on the other surface. These lists, and the later REST and MCP
 * lists in name order, take a name in `machine.`, such as `machine.users`
 * or `machine.task_links`, so none reads like an app list's, and answer
 * `{next_cursor, <rows>}`, the cursor first. The lists in name order page
 * through namedListPage after machine/shared.ts namedPaging and seal their
 * scope with namedScope. A task's related lists, machine.task_subtasks,
 * machine.task_links, machine.task_followers and machine.task_attachments,
 * check their paging with machine/shared.ts cursorPaging and seal the
 * organization, the caller, the task and, for subtasks, whether the task
 * was archived. The project list, machine.projects, checks its paging
 * with namedPaging and seals the organization, the caller, the side of the
 * archive axis and the search's name key (namedScope), at a position of
 * three strings, the top-level project's id and, inside its sub-projects,
 * a sub-project's key and id. A project's lists, machine.project_users,
 * machine.project_milestones, machine.project_user_grants and
 * machine.project_team_grants, check their paging with cursorPaging and
 * seal the organization, the caller and the project, so a cursor of the
 * details continues on the list call for the same project, at a position
 * of a name key and the holder's id (model/nameKeys.ts idTieOf), or for a
 * milestone its day, name key and id. A cursor never grants access by itself,
 * since every page checks the caller's access again. Archived task lists
 * keep their own `2~` cursors (lib/archivedTasks.ts). */

import type { GenericDocument } from 'convex/server'
import type { QueryCtx } from '../_generated/server'
import { digestText } from './archiveCursorSeal'
import { badRequest } from './functions'
import {
  indexAfter,
  listBatch,
  type NamedAt,
  type NamedIndex,
  type NamedTie,
  namedCeiling,
  namedCursor,
  openNamedCursor,
  type ReadGuard,
} from './namedPages'
import { nameKey } from './nameKey'

/** The refusal of a cursor that is not the next_cursor of an earlier page
 * of the same list, scope and caller. */
export const CURSOR_REFUSAL = 'cursor must be the next_cursor of an earlier page'

/** The refusal of an `offset` other than 0 on a list of `noun` that pages
 * with a cursor, such as `active tasks` or `archived tasks`. */
export const offsetRefusal = (noun: string): string =>
  `offset does not apply to ${noun}; pass next_cursor as cursor`

/** The refusal of a REST or MCP list in name order while its
 * organization's name keys are not all written (model/nameKeys.ts
 * nameKeysReady), so a page is never answered from rows without a key.
 * Every organization holds them from its creation or since
 * internal/nameKeysBackfill keyed it, so it is a fail-closed branch that no
 * ordinary call meets. */
export const NAMES_NOT_READY =
  "this list cannot be read until this organization's names are ready; try again in a few minutes"

/** The refusal of REST GET /v1/projects and MCP list_projects while their
 * organization's reach rows and archive states are not all written
 * (model/projectNav.ts reachReady), so a page is never answered from rows
 * that are not there yet. New organizations hold them from their creation
 * and internal/navBackfill writes them for the others, so it is a
 * fail-closed branch that no ordinary call meets. */
export const PROJECTS_NOT_READY =
  "this list cannot be read until this organization's projects are ready; try again in a few minutes"

/** A digest of a list's filters, as 64 hex characters, so a cursor's scope
 * keeps one length whatever the filters and search hold. `filters` must be
 * plain JSON, with absent filters as null so two calls that ask the same
 * list give the same digest. */
export const filtersKey = (filters: unknown): Promise<string> => digestText(JSON.stringify(filters))

/** The cursor of the list `list`, with scope `scope`, just after `at`. */
export const listCursorText = (
  list: string,
  scope: readonly string[],
  at: NamedAt,
): Promise<string> => namedCursor(list, scope, at)

/** The position cursor `text` names in the list `list` with scope
 * `scope`, whose tie holds `ties` fields, or a refusal with CURSOR_REFUSAL
 * when it is not a cursor listCursorText wrote for that list and scope. */
export async function openListCursor(
  text: string,
  list: string,
  scope: readonly string[],
  ties: number,
): Promise<NamedAt> {
  const at = await openNamedCursor(text, list, scope)
  if (at === null || at.tie.length !== ties) throw badRequest(CURSOR_REFUSAL)
  return at
}

/** The scope a list of namedListPage seals its cursors with: the caller's
 * organization and id, `more`, such as the team whose members a page
 * lists, and a digest of the search's name key (lib/nameKey.ts), so
 * "Café" and "cafe" share cursors and a long search never makes a cursor
 * too long for a URL. */
export const namedScope = async (
  caller: { org_id: string; id: string },
  search: string,
  more: readonly string[] = [],
): Promise<string[]> => [caller.org_id, caller.id, ...more, await filtersKey([nameKey(search)])]

/** One page of a REST or MCP list in name order. */
export type NamedListPage<Out> = {
  /** the cursor of the next page, null only once the index ended */
  next_cursor: string | null
  rows: Out[]
}

/**
 * One page of a REST or MCP list in name order, read through
 * lib/namedPages.ts listBatch. It holds at most `limit` rows that `keep`
 * answers, after `cursor`, the next_cursor of an earlier page of `list` with
 * `scope`, or from the start for null, and the cursor of the next page,
 * null only once the index ended. A cursor that does not open for `list`
 * and `scope`, or whose tie `tieOf` refuses, is refused with
 * CURSOR_REFUSAL. The page reads within NAMED_READ past what the call read
 * before it (namedCeiling), always reads its first row, and stops early
 * with a cursor once the read budget is spent, so a short or empty page is
 * never the end. `keep` counts its own reads with the guard it is given.
 *
 * The caller checks its arguments (machine/shared.ts namedPaging), what
 * the list names and the organization's name keys first, in that order, so
 * a refusal never depends on a cursor it did not open yet.
 */
export async function namedListPage<Row extends GenericDocument, Tie extends NamedTie, Out>(
  ctx: QueryCtx,
  o: {
    list: string
    scope: readonly string[]
    cursor: string | null
    tieOf: (at: NamedAt) => Tie | null
    index: NamedIndex<Row, Tie>
    keep: (row: Row, guard: ReadGuard) => Promise<Out | null>
    limit: number
  },
): Promise<NamedListPage<Out>> {
  let after: NamedAt<Tie> | null = null
  if (o.cursor !== null) {
    const at = await openNamedCursor(o.cursor, o.list, o.scope)
    const tie = at === null ? null : o.tieOf(at)
    if (at === null || tie === null) throw badRequest(CURSOR_REFUSAL)
    after = { key: at.key, tie }
  }
  const batch = await listBatch(
    ctx,
    { list: o.list, scope: o.scope, after, through: null },
    {
      stream: indexAfter(o.index, after),
      keep: o.keep,
      limit: o.limit,
      ceiling: await namedCeiling(ctx),
    },
  )
  return { next_cursor: batch.next, rows: batch.rows }
}
