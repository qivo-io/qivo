/* Helpers of the Board's suites (convex/tests/board.test.ts,
 * src/store/boardParity.test.ts): the query as a caller asks it, the read
 * inside one transaction with what it read, and tasks planted in bulk.
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import type { WithoutSystemFields } from 'convex/server'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { type BoardAnswer, type BoardFilters, type BoardScope, readBoard } from '../lib/board'
import { newWindowKey } from '../lib/db'
import { MIB } from '../lib/limits'
import { as, NOW, type T, uuid } from './helpers.setup'

/** A filter row with every filter off. */
export const NO_FILTERS: BoardFilters = {
  mine: false,
  owners: [],
  priority: null,
  stale_before: null,
  focus: false,
  search: '',
}

/** tasks.board for `profile`'s login, with `filters` over NO_FILTERS. */
export const boardFor = (
  t: T,
  profile: Doc<'profiles'>,
  scope: BoardScope,
  filters: Partial<BoardFilters> = {},
): Promise<BoardAnswer> =>
  as(t, profile).query(api.tasks.board, { scope, filters: { ...NO_FILTERS, ...filters } })

/** The scope of the project with id `projectId` of `profile`'s
 * organization. */
export const projectScope = (profile: Doc<'profiles'>, projectId: string): BoardScope => ({
  kind: 'project',
  org_id: profile.org_id,
  project_id: projectId,
})

/** What one read took, as Convex counts it, in MiB to two decimals,
 * documents and index ranges. */
export type ReadFigures = { mib: number; documents: number; ranges: number }

/** The Board for the login whose seats are `seats`, read in one t.run as
 * the query reads it, with what it read. */
export const boardRead = (
  t: T,
  seats: readonly Doc<'profiles'>[],
  scope: BoardScope,
  filters: Partial<BoardFilters> = {},
): Promise<{ answer: BoardAnswer; read: ReadFigures }> =>
  t.run(async (ctx) => {
    const profiles = new Map(seats.map((p) => [p.org_id, p]))
    const answer = await readBoard(ctx, profiles, { scope, filters: { ...NO_FILTERS, ...filters } })
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      read: {
        mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
        documents: m.documentsRead.used,
        ranges: m.databaseQueries.used,
      },
    }
  })

/** The answer's rows' ids, or the state when it is not ok. */
export const rowIds = (answer: BoardAnswer): string[] | string =>
  answer.state === 'ok' ? answer.rows.map((row) => row.id) : answer.state

/* The number of the next task plantTasks plants. */
let nextNum = 900_000

/** Plants `n` active tasks in `project` with `fields(i)`, `each` a
 * transaction, as raw inserts with their description rows, as the third
 * release of the description move stores them: the text in the row only,
 * unless `fields` sets issues.description too, as a rollback writes it. */
export async function plantTasks(
  t: T,
  project: Doc<'projects'>,
  n: number,
  fields: (
    i: number,
  ) => Partial<WithoutSystemFields<Doc<'issues'>>> & { text?: string } = () => ({}),
  each = 100,
): Promise<Doc<'issues'>[]> {
  const planted: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += each)
    planted.push(
      ...(await t.run(async (ctx) => {
        const out: Doc<'issues'>[] = []
        for (let i = from; i < Math.min(n, from + each); i++) {
          const { text = '', ...rest } = fields(i)
          const doc: WithoutSystemFields<Doc<'issues'>> = {
            id: uuid(),
            org_id: project.org_id,
            project_id: project.id,
            num: nextNum++,
            title: `Task ${i}`,
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...rest,
          }
          const _id = await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            description: text,
            org_id: doc.org_id,
            project_id: doc.project_id,
            ...(doc.archived_at === undefined ? {} : { archived_at: doc.archived_at }),
          })
          out.push((await ctx.db.get(_id)) as Doc<'issues'>)
        }
        return out
      })),
    )
  return planted
}
