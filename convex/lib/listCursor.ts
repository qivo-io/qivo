/* Continuation cursors of REST and MCP lists, and the refusal of an offset
 * on a list that pages with them.
 *
 * REST GET /v1/tasks and MCP list_tasks page their active tasks with these
 * (lib/activeTaskPage.ts). REST GET /v1/inbox and MCP list_inbox
 * (t3/limits-machine-inbox) and REST GET /v1/workload and MCP get_workload
 * (t3/limits-workload-pages) are to page with them too. A cursor is a
 * position in one list's order, sealed with the list's name and its scope
 * (lib/namedPages.ts namedCursor over lib/archiveCursorSeal.ts), so it shows
 * nothing and opens only for the list and scope it came from: another list,
 * surface, organization, caller or filter, or a changed cursor, opens to
 * null and is refused with CURSOR_REFUSAL. A cursor never grants access by
 * itself: every page checks the caller's access again. Archived task lists
 * keep their own `2~` cursors (lib/archivedTasks.ts). */

import { digestText } from './archiveCursorSeal'
import { badRequest } from './functions'
import { type NamedAt, namedCursor, openNamedCursor } from './namedPages'

/** The refusal of a cursor that is not the next_cursor of an earlier page
 * of the same list, scope and caller. */
export const CURSOR_REFUSAL = 'cursor must be the next_cursor of an earlier page'

/** The refusal of an `offset` other than 0 on a list of `noun` that pages
 * with a cursor, such as `active tasks` or `archived tasks`. */
export const offsetRefusal = (noun: string): string =>
  `offset does not apply to ${noun}; pass next_cursor as cursor`

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
