/* Main Search, the search that Search in the left menu opens, on the
 * server. Nothing in the app calls it yet. The palette switches to it in a
 * later release, which ships only once a dry run of
 * internal/descriptionsBackfill reports zero on development, staging,
 * production and the demo (docs/deployment.md), as this query trusts the
 * description rows' project and archived copies to narrow its candidates.
 *
 * - page: one page of up to 25 task results for a search text, ranked
 *   together across every organization where the login holds a seat, or
 *   the narrower scope given (one organization, and in it one project).
 *   Archived tasks come in only with `include_archived`. It reads the
 *   caller's profiles, the tasks a text's task numbers name (issues
 *   by_org_num), title and description matches from two Convex search
 *   indexes (issues search_title, issue_descriptions search_description),
 *   at most 512 a source in each place searched, the projects and access
 *   rows that decide what the caller may see, and for each result its task,
 *   its projects and a first subtask (lib/mainSearch.ts). Its reads stay
 *   within a budget, and `coverage` says when they stopped before covering
 *   everything; `next_cursor` says that more results follow.
 *
 * The app calls it once per page, never as a subscription, so a hidden tab
 * reads nothing. Project results join the same ranking in the next stage. */

import { v } from 'convex/values'
import { authedQuery } from './lib/functions'
import { mainSearchPage } from './lib/mainSearch'

export const page = authedQuery({
  args: {
    text: v.string(),
    include_archived: v.boolean(),
    scope: v.optional(v.object({ org_id: v.string(), project_id: v.optional(v.string()) })),
    cursor: v.optional(v.string()),
  },
  handler: (ctx, a) => mainSearchPage(ctx, ctx.myProfiles, a),
})
