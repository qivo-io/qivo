/* A read-only count of the subtasks stored in another sub-project than
 * their parent task's, from before the rule that a subtask stays in its
 * parent's own sub-project (owner, 18 November 2026; model/issues.ts
 * sameSubProject). It writes nothing. It shows, on each deployment, that no
 * task has a parent in another sub-project once the old data is gone
 * (docs/deployment.md, the release after v0.1.168).
 *
 * It reads the tasks that have a parent, a page at a time, in the order of
 * the by_parent index, over every organization of the deployment. A page
 * reads each task, its parent and their projects once. A task is
 *
 * - `sibling` when its parent is in another sub-project of the same
 *   top-level project;
 * - `other_project` when its parent is in another top-level project, or,
 *   in rows no write makes, in another organization;
 * - `missing_parent` when its parent is not a live task, such as one in
 *   Deleted items;
 * - `held` when its own project or its parent's has no live row, because
 *   Deleted items holds it while a project item moves or restores;
 * - otherwise in its parent's sub-project, and counted only as scanned.
 *
 * `count` answers one page of those figures, with a few example task ids of
 * each, and a cursor. `run`, an internal action, counts page after page for
 * at most RUN.ms, well inside Convex's action time limit, and answers the
 * totals with `done: false` and a `cursor` to go on from, or `done: true`.
 * Call it again with that `cursor` until `done` is true. With the private
 * helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/olderFamilies:run '{}'
 * On the demo, whose stored key cannot run internal functions, the private
 * with-temp-deploy-key helper runs it with a short-lived key; `run` needs
 * deployment:functions:runInternalActions. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalAction, internalQuery, type QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'

/** The tasks one page reads and the example ids a page or a run lists of
 * each kind. A page of ordinary tasks reads a few hundred kilobytes. Tests
 * lower them. */
export const OLDER_FAMILIES = { page: 100, examples: 5 }

/** How long one call of run goes on before it answers where to go on
 * from. Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

/** Where a task stands against the subtask rule (see the header). */
type Kind = 'ok' | 'sibling' | 'other_project' | 'missing_parent' | 'held'

/** The kinds a page counts, each with its example ids. */
const COUNTED = ['sibling', 'other_project', 'missing_parent', 'held'] as const
type Counted = (typeof COUNTED)[number]

/** What one page answers: how many tasks with a parent it read, how many of
 * each kind with a few example ids, and the cursor of the next page, null
 * after the last. */
export type CountPage = {
  scanned: number
  counts: Record<Counted, number>
  examples: Record<Counted, string[]>
  cursor: string | null
}

/* No task counted yet. */
const empty = (): Omit<CountPage, 'cursor'> => ({
  scanned: 0,
  counts: { sibling: 0, other_project: 0, missing_parent: 0, held: 0 },
  examples: { sibling: [], other_project: [], missing_parent: [], held: [] },
})

/** Reads each row once per page. */
function pageReads(ctx: QueryCtx) {
  const tasks = new Map<string, Promise<Doc<'issues'> | null>>()
  const projects = new Map<string, Promise<Doc<'projects'> | null>>()
  const once = <T>(seen: Map<string, Promise<T>>, id: string, read: () => Promise<T>) => {
    let found = seen.get(id)
    if (found === undefined) {
      found = read()
      seen.set(id, found)
    }
    return found
  }
  return {
    task: (id: string) => once(tasks, id, () => byId(ctx, 'issues', id)),
    project: (id: string) => once(projects, id, () => byId(ctx, 'projects', id)),
  }
}

/** Where `task`, a task with a parent, stands against the subtask rule. */
async function kindOf(task: Doc<'issues'>, reads: ReturnType<typeof pageReads>): Promise<Kind> {
  if (task.parent_id === undefined) return 'ok'
  const parent = await reads.task(task.parent_id)
  if (parent === null) return 'missing_parent'
  if (parent.org_id === task.org_id && parent.project_id === task.project_id) return 'ok'
  const own = await reads.project(task.project_id)
  const theirs = await reads.project(parent.project_id)
  if (own === null || theirs === null) return 'held'
  if (parent.org_id !== task.org_id) return 'other_project'
  return (own.parent_id ?? own.id) === (theirs.parent_id ?? theirs.id) ? 'sibling' : 'other_project'
}

/** Counts one page of the tasks with a parent, from `cursor` on, and writes
 * nothing (see the header). Undefined sorts before every string, so tasks
 * without a parent are not in the range. */
export const count = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<CountPage> => {
    const page = await ctx.db
      .query('issues')
      .withIndex('by_parent', (q) => q.gt('parent_id', ''))
      .paginate({ cursor: cursor ?? null, numItems: OLDER_FAMILIES.page })
    const reads = pageReads(ctx)
    const out: CountPage = { ...empty(), cursor: page.isDone ? null : page.continueCursor }
    for (const task of page.page) {
      out.scanned += 1
      const kind = await kindOf(task, reads)
      if (kind === 'ok') continue
      out.counts[kind] += 1
      if (out.examples[kind].length < OLDER_FAMILIES.examples) out.examples[kind].push(task.id)
    }
    return out
  },
})

const countRef = makeFunctionReference<'query', { cursor: string | null }, CountPage>(
  'internal/olderFamilies:count',
)

/** Counts page after page from `cursor` on for at most RUN.ms, and answers
 * the figures of every page it read with up to OLDER_FAMILIES.examples
 * example ids of each kind, `done`, and while not done the `cursor` to go
 * on from. */
export const run = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const until = Date.now() + RUN.ms
    const totals = empty()
    let cursor: string | null = a.cursor ?? null
    let done = false
    while (!done) {
      const page = await ctx.runQuery(countRef, { cursor })
      totals.scanned += page.scanned
      for (const kind of COUNTED) {
        totals.counts[kind] += page.counts[kind]
        const room = OLDER_FAMILIES.examples - totals.examples[kind].length
        totals.examples[kind].push(...page.examples[kind].slice(0, Math.max(0, room)))
      }
      done = page.cursor === null
      cursor = page.cursor
      if (Date.now() >= until) break
    }
    return { ...totals, done, cursor: done ? null : cursor }
  },
})
