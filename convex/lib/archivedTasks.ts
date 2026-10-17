/* Archived tasks in archive order, read a page at a time: REST
 * GET /v1/tasks?archived=true and MCP list_tasks with `archived: true`
 * (lib/core.ts listArchivedIssuesCore). The order is the one of
 * issues.by_project_archived read backwards, most recently archived first and
 * tasks archived at the same moment newest created first, merged across the
 * projects a list covers. A cursor names a position in that order, so a page
 * reads only what follows it, whatever the size of the archive. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/** A task that has been archived. */
export type ArchivedTask = Doc<'issues'> & { archived_at: string }

const isArchived = (task: Doc<'issues'>): task is ArchivedTask => task.archived_at !== undefined

/** A position in archive order, just after the task with these keys. */
export type ArchiveCursor = { created: number; archived_at: string }

/** The cursor just after `task`. */
export const cursorAfter = (task: ArchivedTask): ArchiveCursor => ({
  created: task._creationTime,
  archived_at: task.archived_at,
})

/** A cursor as callers see it, `1~<_creationTime>~<archived_at>`. Plain text,
 * with the timestamp last and verbatim, so any stored format pages
 * correctly. It holds only a position, so a forged one shows nothing. Every
 * task still comes from the caller's readable projects. */
export const archiveCursorText = (c: ArchiveCursor): string => `1~${c.created}~${c.archived_at}`

const CURSOR_TEXT = /^1~(\d+(?:\.\d+)?)~(.{1,64})$/s

/** The cursor `text` names, or null when it is not one archiveCursorText
 * wrote. */
export function parseArchiveCursor(text: string): ArchiveCursor | null {
  const m = CURSOR_TEXT.exec(text)
  if (m === null) return null
  const created = Number(m[1])
  return Number.isFinite(created) ? { created, archived_at: m[2] } : null
}

/* Whether `a` comes before `b` in archive order. */
const before = (a: ArchivedTask, b: ArchivedTask): boolean =>
  a.archived_at !== b.archived_at
    ? a.archived_at > b.archived_at
    : a._creationTime > b._creationTime

/* One project's archived tasks after `after`, in archive order, read lazily
 * from at most two index ranges, the rest of the cursor's own moment and
 * then everything archived earlier. */
async function* projectArchive(
  ctx: QueryCtx,
  projectId: string,
  after: ArchiveCursor | null,
): AsyncGenerator<ArchivedTask> {
  if (after !== null) {
    const sameMoment = ctx.db
      .query('issues')
      .withIndex('by_project_archived', (q) =>
        q
          .eq('project_id', projectId)
          .eq('archived_at', after.archived_at)
          .lt('_creationTime', after.created),
      )
      .order('desc')
    for await (const task of sameMoment) if (isArchived(task)) yield task
  }
  const earlier = ctx.db
    .query('issues')
    .withIndex('by_project_archived', (q) => {
      const archived = q.eq('project_id', projectId).gt('archived_at', undefined)
      return after === null ? archived : archived.lt('archived_at', after.archived_at)
    })
    .order('desc')
  for await (const task of earlier) if (isArchived(task)) yield task
}

/** A merged read of several projects' archived tasks in archive order. */
export type ArchivedTaskStream = {
  /** The next task, or null once every project is read to its end. */
  next(): Promise<ArchivedTask | null>
  /** Whether a task follows the one next() returned last. */
  more(): boolean
  /** Closes every project's open query. */
  close(): Promise<void>
}

/**
 * The archived tasks of `projectIds` after `cursor`, in archive order. It
 * holds each project's next task, so it reads one task per project when it
 * opens, then one more task of a project each time it hands one out. A page
 * pays only for what it pulls, and more() needs no read. Call close() when
 * done, so no query stays open.
 */
export async function archivedTasksAfter(
  ctx: QueryCtx,
  projectIds: readonly string[],
  cursor: ArchiveCursor | null,
): Promise<ArchivedTaskStream> {
  const streams = projectIds.map((id) => projectArchive(ctx, id, cursor))
  const heads: (ArchivedTask | null)[] = []
  const pull = async (i: number) => {
    const step = await streams[i].next()
    heads[i] = step.done === true ? null : step.value
  }
  for (let i = 0; i < streams.length; i++) await pull(i)
  return {
    async next() {
      let best = -1
      heads.forEach((head, i) => {
        if (head === null) return
        const leader = best < 0 ? null : heads[best]
        if (leader === null || before(head, leader)) best = i
      })
      if (best < 0) return null
      const task = heads[best]
      await pull(best)
      return task
    },
    more: () => heads.some((head) => head !== null),
    async close() {
      for (const stream of streams) await stream.return(undefined)
    },
  }
}
