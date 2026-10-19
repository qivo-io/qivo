/* A one-time backfill for organizations created before org_counters
 * existed. Such an organization keeps its task and project counters
 * (next_issue_num, next_project_num) and the retired activity_count on its
 * own row. The app works without this backfill. The first task or project
 * number an organization receives moves its counters (model/orgs.ts
 * ensureCounters). The backfill clears the legacy fields from every
 * organization, which a later change must wait for before it removes them
 * from the schema.
 *
 * `start` reads one page of organizations. For each one it moves the
 * counters to org_counters and clears the legacy fields. It then schedules the next
 * page, and the last page logs 'Org counters backfill done' with the number
 * of organizations visited and changed. `remaining` reads one page of
 * organizations and counts those still holding a legacy field, so an
 * operator can confirm a deployment is done before tightening the schema.
 *
 * Running it twice, or while the app writes, is safe. Each organization is
 * moved in one transaction with the same helper task and project creation
 * use, so a number is never handed out twice, and a second run changes
 * nothing.
 *
 * Run it once per deployment and only with the user's approval. From a Qivo
 * checkout, the private helper names the deployment and refuses to run
 * without its key, for example development:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/orgCountersBackfill:start
 *
 * The other targets are staging and production. The command returns once
 * the first page is done. Follow the progress in the deployment's logs, then
 * check with `remaining`, passing each returned cursor back until `isDone`:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     development npx convex run internal/orgCountersBackfill:remaining
 *
 * The demo backend's stored key cannot run internal functions or read logs,
 * so on the demo the private with-temp-deploy-key helper runs each command
 * with a short-lived key that allows only the listed actions, then deletes
 * it (qivo-internal docs/public-demo-operations.md). `start` is an internal
 * mutation, `remaining` an internal query, and `npx convex logs` needs
 * deployment:logs:view:
 *
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-temp-deploy-key" \
 *     demo --allow deployment:functions:runInternalMutations \
 *     --purpose org-counters -- npx convex run internal/orgCountersBackfill:start
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-temp-deploy-key" \
 *     demo --allow deployment:functions:runInternalQueries \
 *     --purpose org-counters -- npx convex run internal/orgCountersBackfill:remaining */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { countersRow, ensureCounters, hasLegacyFields } from '../model/orgs'

/* Organizations per `start` step. Each one costs a few reads and writes. */
const ORG_PAGE = 64

/* Organizations per `remaining` page. It only reads them. */
const CHECK_PAGE = 1_000

type StartArgs = { cursor?: string; page?: number; orgs?: number; changed?: number }

const startRef = makeFunctionReference<'mutation', StartArgs, null>(
  'internal/orgCountersBackfill:start',
)

/** Moves one page of organizations from `cursor` (absent to begin), then
 * schedules the next. `orgs` and `changed` count what earlier pages did, for
 * the final log. `page` lowers the page size in tests. */
export const start = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    page: v.optional(v.number()),
    orgs: v.optional(v.number()),
    changed: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<null> => {
    const result = await ctx.db
      .query('organizations')
      .paginate({ cursor: a.cursor ?? null, numItems: Math.max(1, a.page ?? ORG_PAGE) })
    let changed = a.changed ?? 0
    for (const org of result.page) {
      const unmoved = (await countersRow(ctx, org.id)) === null
      await ensureCounters(ctx, org)
      // ensureCounters leaves activity_count, and legacy counters on an
      // organization whose org_counters row already wins (countersOf).
      if (hasLegacyFields(org)) {
        await ctx.db.patch(org._id, {
          next_issue_num: undefined,
          next_project_num: undefined,
          activity_count: undefined,
        })
      }
      if (unmoved || hasLegacyFields(org)) changed++
    }
    const orgs = (a.orgs ?? 0) + result.page.length
    if (result.isDone) {
      console.info('Org counters backfill done', { orgs, changed })
      return null
    }
    await ctx.scheduler.runAfter(0, startRef, {
      cursor: result.continueCursor,
      page: a.page,
      orgs,
      changed,
    })
    return null
  },
})

/** How many organizations in one page from `cursor` still hold a legacy
 * field (next_issue_num, next_project_num or activity_count), and the cursor
 * of the next page. Read-only. */
export const remaining = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query('organizations')
      .paginate({ cursor: cursor ?? null, numItems: CHECK_PAGE })
    return {
      remaining: result.page.filter(hasLegacyFields).length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    }
  },
})
