/* A one-time migration of activity rows written before October 2026, when
 * insertActivity numbered each subject's history in `seq` and kept only its
 * newest 500 rows. Since then a subject keeps its whole history and nothing
 * reads or writes `seq` (model/activity.ts). This removes `seq` from every
 * row that has it, so the field can leave the schema, and gives each task row
 * stored before named_task_nums existed the list its text names
 * (namedTaskNums below), because the visibility rule now reads only the list
 * and shows a task row without one to organization admins only
 * (lib/activityVisibility.ts memberSeesActivity). A row whose text names
 * tasks in wording the parser does not know keeps no list, as before.
 *
 * `check` reports and changes nothing; `run` changes the rows and reports
 * the same counts. Each reads one page of the table from `cursor` and
 * answers the next cursor, null at the end, so repeat a call with
 * `{"cursor": "<cursor>"}` until it answers null. Running it twice, or while
 * the app writes, is safe: new rows have no `seq` and carry their list.
 *
 * Run it once per deployment after the deploy that stops writing `seq`, and
 * only with the user's approval, through the private helper that names the
 * deployment, for example on development:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/activityRows:check
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/activityRows:run
 *
 * Remove this module and the schema's `seq` once every deployment has run it
 * and `check` answers 0 numbered and 0 unlisted rows. */

import type { PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server'
import { ISSUE_PREFIX } from '../lib/taskRefs'

/* Rows per call, and the most bytes one call reads, as Convex counts a
 * document's size. A row's label and detail have no cap, so a page also
 * ends early on bytes, at most one row past them, which leaves room under
 * Convex's 16 MiB read limit. Tests lower them. */
export const ACTIVITY_ROWS_PAGE = { rows: 4_000, bytes: 8 * 1024 * 1024 }

/* The task numbers a task row stored before named_task_nums existed names
 * by key, read from its text: a parent change written by model/issues.ts
 * browserVerbDetail ('moved' under QN-n (from QN-m), 'detached' from QN-m)
 * and a link written by model/links.ts addLinkCore ('linked' (blocks QN-n)).
 * A REST or MCP write appended its provenance (model/activity.ts
 * machineDetail), which names no task. Returns [] when the row names none,
 * and null when the wording is not one those writers produced, so the row
 * keeps no list and reaches organization admins only. Newer rows store the
 * numbers, so their wording no longer needs to match this parser.
 *
 * Rows written before October 2026 joined the provenance with ' — ' and
 * wrote a link as '— blocks QN-n'; later ones use ', ' and '(blocks QN-n)'.
 * Stored rows keep their text, so both forms are read. */
const KEY = `${ISSUE_PREFIX}-(\\d+)`
const SIGNED = '(?:(?: —|,) via (?:MCP|the REST API(?: \\(.*\\))?))?'
const NAMED_PARENT_CHANGE = new RegExp(
  `^under (?:${KEY}|its parent)(?: \\(from ${KEY}\\))?${SIGNED}$`,
)
const NAMED_DETACH = new RegExp(`^from (?:${KEY}|its parent)${SIGNED}$`)
const NAMED_LINK = new RegExp(
  `^(?:— (?:blocks|relates to) ${KEY}|\\((?:blocks|relates to) ${KEY}\\))${SIGNED}$`,
)
/** The task numbers a stored row's text names (above), or null. */
export function namedTaskNums(
  ev: Pick<Doc<'activity_events'>, 'target_type' | 'verb' | 'detail'>,
): number[] | null {
  if (ev.target_type !== 'issue') return []
  const detail = ev.detail ?? ''
  const grammar =
    ev.verb === 'moved' && detail.startsWith('under ')
      ? NAMED_PARENT_CHANGE
      : ev.verb === 'detached'
        ? NAMED_DETACH
        : ev.verb === 'linked'
          ? NAMED_LINK
          : undefined
  if (grammar === undefined) return []
  const m = grammar.exec(detail)
  if (m === null) return null
  return m
    .slice(1)
    .filter((n): n is string => n !== undefined)
    .map(Number)
}

/** What one page holds: rows read, rows with `seq`, task rows without
 * named_task_nums, and of those the ones whose wording the parser does not
 * know, which keep no list. */
type Counts = { scanned: number; numbered: number; unlisted: number; unparsed: number }

/* The change one row needs: whether it has `seq`, and for a task row
 * without a list, the list its text names (null when unparsed). */
function plan(ev: Doc<'activity_events'>): { numbered: boolean; named?: number[] | null } {
  const numbered = ev.seq !== undefined
  if (ev.target_type !== 'issue' || ev.named_task_nums !== undefined) return { numbered }
  return { numbered, named: namedTaskNums(ev) }
}

/* One page of the table from `cursor`, oldest first. */
const page = (
  ctx: QueryCtx,
  cursor: string | undefined,
): Promise<PaginationResult<Doc<'activity_events'>>> =>
  ctx.db.query('activity_events').paginate({
    cursor: cursor ?? null,
    numItems: ACTIVITY_ROWS_PAGE.rows,
    maximumBytesRead: ACTIVITY_ROWS_PAGE.bytes,
  })

const counted = (rows: Doc<'activity_events'>[]): Counts => {
  const out: Counts = { scanned: rows.length, numbered: 0, unlisted: 0, unparsed: 0 }
  for (const ev of rows) {
    const p = plan(ev)
    if (p.numbered) out.numbered += 1
    if (p.named !== undefined) out.unlisted += 1
    if (p.named === null) out.unparsed += 1
  }
  return out
}

/** Reports one page of rows the migration would change, and the next cursor. */
export const check = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Counts & { cursor: string | null }> => {
    const p = await page(ctx, a.cursor)
    return { ...counted(p.page), cursor: p.isDone ? null : p.continueCursor }
  },
})

/** Removes `seq` from one page of rows and gives their task rows without a
 * list the list their text names, then reports as `check` does. */
export const run = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Counts & { cursor: string | null }> => {
    const p = await page(ctx, a.cursor)
    for (const ev of p.page) {
      const { numbered, named } = plan(ev)
      const listed = named !== undefined && named !== null
      if (!numbered && !listed) continue
      await ctx.db.patch(ev._id, {
        ...(numbered ? { seq: undefined } : {}),
        ...(listed ? { named_task_nums: named } : {}),
      })
    }
    return { ...counted(p.page), cursor: p.isDone ? null : p.continueCursor }
  },
})
