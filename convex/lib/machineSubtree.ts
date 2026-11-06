/* The group and parent reads of REST and MCP task rows, by the machine
 * visibility rule: a row is a task in a project the caller can read
 * (lib/core.ts accessFlags `read`), archived projects included when a call
 * names one. The app's views follow the working-set rule instead
 * (lib/viewReads.ts), so the two keep their own reads.
 *
 * The active task list (lib/activeTaskPage.ts) reads through them.
 * subtreeReads answers from the catalogue's flags, which it reads nothing
 * for, so the single-task read (lib/core.ts taskOut), which asks the
 * caller's access project by project through lib/access.ts accessOf, keeps
 * its own walk (lib/core.ts subtreeIndex) and uses readTally for its first
 * pages, an archived task's subtask page among them (lib/core.ts
 * subtasksByNumber). Project completion reads the stored counts instead
 * (lib/core.ts projectCompletion).
 *
 * - readTally counts what a read makes against its own budget, every
 *   document at its size as Convex counts it (getDocumentSize), or at a
 *   fixed size for one the caller may not be shown;
 * - subtreeReads reads which tasks are groups, the subtrees a group's facts
 *   walk (lib/core.ts groupFacts) and rows' parents by id.
 *
 * A document the caller may not be shown, a subtask in a project they
 * cannot read or a parent by id until it turns out readable, counts at
 * lib/limits.ts TASK_ROW_MAX_BYTES in every budget decision, so a hidden
 * title's length moves no answer. What still follows hidden data is how
 * many documents those reads return, which can move where a read stops at
 * its budget's margin only:
 *
 * - how many active subtasks a task has in projects the caller cannot read,
 *   at most LIMITS.subtasks.max a task, which a group check reads whole;
 * - how many distinct parents the caller cannot read a page's rows have,
 *   since each is read once for all its rows (subtreeReads `parent`), and
 *   whether such a parent is gone, which reads a second range and no
 *   document where an existing one reads one range and one document;
 * - and the real bytes of those documents where they pass the caps, which
 *   only a row stored over them or a hidden task's copy of its text (which
 *   only a rollback writes) can do, at the real-bytes stop (readTally
 *   `hard`). */

import type { TransactionMetrics } from 'convex/server'
import { getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { ReadCeiling } from './archivedTasks'
import { byId } from './db'
import { TASK_ROW_MAX_BYTES } from './limits'
import { countsAsSubtask, layerOf, type ProjectLive } from './liveTasks'
import { ONE_LEVEL_SINCE, withoutSubtasks } from './viewReads'

/* How many reads a tally counts itself before it looks at the request's
 * totals again, so what it cannot see, such as a read inside a helper,
 * counts within that many reads. */
const LOOK_EVERY = 256

/** The request's totals a read keeps to, as Convex counts them. */
export type ReadTotals = ReadCeiling

/** The request's totals from its metrics. */
export const totalsOf = (m: TransactionMetrics): ReadTotals => ({
  ranges: m.databaseQueries.used,
  documents: m.documentsRead.used,
  bytes: m.bytesRead.used,
})

/** What readTally answers. */
export type ReadTally = Awaited<ReturnType<typeof readTally>>

/**
 * A count of the request's reads, in index ranges, documents and bytes as
 * Convex counts them, kept by the reader itself between looks at the
 * request's metrics (ctx.meta.getTransactionMetrics), since each look costs
 * about as much as an index range. Each range and each document a read
 * returns is counted as it is read; a look every LOOK_EVERY of them, and
 * one the reader asks for (look), sets the count to the request's own,
 * which also holds the reads made out of the reader's sight. A document the
 * reader may not be shown is counted at a fixed size in every decision
 * (`doc` with a size), its real size only against `hard`, the request's
 * limits less a reserve, which no read passes by more than its last
 * document.
 */
export async function readTally(ctx: QueryCtx, hard: ReadTotals) {
  let used: ReadTotals = { ranges: 0, documents: 0, bytes: 0 }
  // the fixed charges less the real sizes of the documents they stand for
  let extra = 0
  let since = 0
  const look = async () => {
    used = totalsOf(await ctx.meta.getTransactionMetrics())
    since = 0
  }
  await look()
  return {
    look,
    /** Counts one index range started. */
    range: (): void => {
      used.ranges++
      since++
    },
    /** Counts `doc`, which a read returned, at its size, or at `size` in
     * every decision when the reader may not be shown it. */
    doc: (doc: Record<string, unknown>, size?: number): void => {
      const real = getDocumentSize(doc as Parameters<typeof getDocumentSize>[0])
      used.documents++
      used.bytes += real
      if (size !== undefined) extra += size - real
      since++
    },
    /** What the reads may still take under `ceiling`, with the fixed
     * charges, and under `hard` in real bytes, on each count. */
    left: (ceiling: ReadTotals): ReadTotals => ({
      ranges: Math.min(ceiling.ranges, hard.ranges) - used.ranges,
      documents: Math.min(ceiling.documents, hard.documents) - used.documents,
      bytes: Math.min(ceiling.bytes - used.bytes - extra, hard.bytes - used.bytes),
    }),
    /** Whether the reads keep under `ceiling` on every count, with the
     * fixed charges, and under `hard` in real bytes. */
    under: async (ceiling: ReadTotals): Promise<boolean> => {
      if (since >= LOOK_EVERY) await look()
      return (
        used.ranges < Math.min(ceiling.ranges, hard.ranges) &&
        used.documents < Math.min(ceiling.documents, hard.documents) &&
        used.bytes + extra < ceiling.bytes &&
        used.bytes < hard.bytes
      )
    },
  }
}

/** What the group and parent reads know of the caller and the
 * organization: the caller's read flags (lib/core.ts accessFlags) and the
 * organization's projects (lib/core.ts Catalogue), so they ask nothing of
 * the database about projects. */
export type MachineView = {
  me: Doc<'profiles'>
  readable: (projectId: string) => boolean
  projectOf: (projectId: string) => Doc<'projects'> | undefined
  live: ProjectLive
}

/* The active subtasks of the task with id `taskId`. */
const activeKids = (ctx: QueryCtx, taskId: string) =>
  ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) => q.eq('parent_id', taskId).eq('archived_at', undefined))

/** What subtreeReads answers. */
export type SubtreeReads = ReturnType<typeof subtreeReads>

/**
 * The group and parent reads of a list's rows, all counted by `tally`. It
 * keeps the active subtasks of each task it read, by parent (`kids`, a
 * lib/core.ts ChildIndex for issueOut), and the tasks the list read by id
 * (`tasks`, its rows and their parents), so nothing is read twice.
 *
 * A task is a group when it has an active subtask that makes it one
 * (lib/liveTasks.ts countsAsSubtask, with the catalogue's liveness): for a
 * task in a live project an active subtask in a live project, and for one
 * in an archived project any active subtask. Its check reads its active
 * subtasks whole (issues by_parent_archived), at most LIMITS.subtasks.max,
 * so the group's facts need no other read of them, and reads nothing for a
 * subtask created under the rule of one level (lib/viewReads.ts
 * withoutSubtasks).
 */
export function subtreeReads(ctx: QueryCtx, view: MachineView, tally: ReadTally) {
  const kids = new Map<string, Doc<'issues'>[]>()
  const tasks = new Map<string, Doc<'issues'>>()
  const shown = (task: Doc<'issues'>) =>
    task.org_id === view.me.org_id && view.readable(task.project_id)
  /* reads the active subtasks of `task` into `kids` whole, each counted,
   * and answers false, keeping none, once `ceiling` stops the read */
  const readKids = async (task: Doc<'issues'>, ceiling: ReadTotals): Promise<boolean> => {
    if (kids.has(task.id)) return true
    if (withoutSubtasks(task)) {
      kids.set(task.id, [])
      return true
    }
    if (!(await tally.under(ceiling))) return false
    tally.range()
    const out: Doc<'issues'>[] = []
    for await (const kid of activeKids(ctx, task.id)) {
      tally.doc(kid, shown(kid) ? undefined : TASK_ROW_MAX_BYTES)
      out.push(kid)
      if (!(await tally.under(ceiling))) return false
    }
    kids.set(task.id, out)
    return true
  }
  /* whether `task`, whose subtasks are read, is a group */
  const isGroup = (task: Doc<'issues'>): boolean => {
    const parent = layerOf(task, view.live)
    return (kids.get(task.id) ?? []).some((kid) => countsAsSubtask(parent, layerOf(kid, view.live)))
  }
  return {
    kids,
    tasks,
    /** Whether the subtasks of `task` are read, or need none. */
    known: (task: Doc<'issues'>): boolean => kids.has(task.id) || withoutSubtasks(task),
    /** Whether `task` is a group, reading its active subtasks within
     * `ceiling` first, or null when `ceiling` stopped that read. */
    group: async (task: Doc<'issues'>, ceiling: ReadTotals): Promise<boolean | null> =>
      (await readKids(task, ceiling)) ? isGroup(task) : null,
    /** Whether `task`, whose subtasks are read, is a group. */
    isGroup,
    /**
     * Reads, within `ceiling`, the subtree group `root`'s facts walk
     * (lib/core.ts groupFacts over groupCounter with the caller's flags):
     * the active subtasks of each task under it that counts, a level at a
     * time, the seen set stopping a corrupt cycle. A subtask created under
     * the rule of one level, or one of a group created then, has no
     * subtasks and reads nothing (lib/viewReads.ts ONE_LEVEL_SINCE), so
     * only groups stored before it read deeper than one level. False when
     * `ceiling` stopped the walk, so the row's facts are those of a subtree
     * too large to read.
     */
    walk: async (root: Doc<'issues'>, ceiling: ReadTotals): Promise<boolean> => {
      if (!(await readKids(root, ceiling))) return false
      const rootLive = view.live(root.project_id)
      // groupCounter's rule with the caller's flags, which reads nothing
      const counts = (task: Doc<'issues'>) => {
        if (task.org_id !== view.me.org_id || task.archived_at !== undefined) return false
        const project = view.projectOf(task.project_id)
        if (project === undefined || (rootLive && project.archived_at !== undefined)) return false
        return view.readable(project.id)
      }
      const seen = new Set([root.id])
      let frontier = [root]
      while (frontier.length > 0) {
        const next: Doc<'issues'>[] = []
        for (const task of frontier) {
          if (task !== root) {
            if (root.created_at >= ONE_LEVEL_SINCE && !kids.has(task.id)) kids.set(task.id, [])
            if (!(await readKids(task, ceiling))) return false
            // a leaf, which the facts count and enter no further
            if (!isGroup(task)) continue
          }
          const above = layerOf(task, view.live)
          for (const kid of kids.get(task.id) ?? []) {
            if (!countsAsSubtask(above, layerOf(kid, view.live))) continue
            if (seen.has(kid.id) || !counts(kid)) continue
            seen.add(kid.id)
            next.push(kid)
          }
        }
        frontier = next
      }
      return true
    },
    /** Reads the parent of `task` by id unless the list holds it, counted
     * at the fixed size unless the caller can read it, and keeps it in
     * `tasks`, where issueOut finds it (lib/core.ts parentOut). A parent
     * that is gone is read again there, one range more, counted here. */
    parent: async (task: Doc<'issues'>): Promise<void> => {
      if (task.parent_id === undefined || tasks.has(task.parent_id)) return
      tally.range()
      const parent = await byId(ctx, 'issues', task.parent_id)
      if (parent === null) {
        tally.range()
        return
      }
      tally.doc(parent, shown(parent) ? undefined : TASK_ROW_MAX_BYTES)
      tasks.set(parent.id, parent)
    },
  }
}
