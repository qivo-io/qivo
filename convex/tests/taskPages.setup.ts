/* Paging helpers for REST GET /v1/tasks and MCP list_tasks active lists
 * (lib/activeTaskPage.ts), which answer `{next_cursor, tasks}` pages. Named
 * *.setup.ts so the Convex CLI skips it (see helpers.setup.ts). */

import type { FunctionArgs } from 'convex/server'
import { internal } from '../_generated/api'
import { ACTIVE_PAGE, ACTIVE_RESERVE } from '../lib/activeTaskPage'
import type { McpIssueOut, RestIssueJson } from '../lib/core'
import { type T, TODAY } from './helpers.setup'

/** A page as both surfaces answer it. */
export type Page<Row> = { next_cursor: string | null; tasks: Row[] }

/** The arguments of REST GET /v1/tasks, the day TODAY unless given. */
export type RestArgs = Omit<FunctionArgs<typeof internal.machine.rest.listIssues>, 'today'> & {
  today?: string
}

/** The arguments of MCP list_tasks, the day TODAY unless given. */
export type McpArgs = Omit<FunctionArgs<typeof internal.machine.mcp.listIssues>, 'today'> & {
  today?: string
}

/** One page of REST GET /v1/tasks. */
export const restPage = (t: T, args: RestArgs): Promise<Page<RestIssueJson>> =>
  t.query(internal.machine.rest.listIssues, { today: TODAY, ...args })

/** One page of MCP list_tasks, parsed. */
export const mcpPage = async (t: T, args: McpArgs): Promise<Page<McpIssueOut>> =>
  JSON.parse(await t.query(internal.machine.mcp.listIssues, { today: TODAY, ...args }))

/** Every page of a list from the first, the rows in the order they came,
 * the pages' sizes and their cursors. Fails a list that pages more than
 * `most` times, so a list that never ends cannot hang a test. */
export async function everyPage<Row>(
  page: (cursor: string | undefined) => Promise<Page<Row>>,
  most = 1000,
): Promise<{ rows: Row[]; sizes: number[]; cursors: string[] }> {
  const rows: Row[] = []
  const sizes: number[] = []
  const cursors: string[] = []
  let cursor: string | undefined
  do {
    const got = await page(cursor)
    rows.push(...got.tasks)
    sizes.push(got.tasks.length)
    cursor = got.next_cursor ?? undefined
    if (cursor !== undefined) cursors.push(cursor)
    if (sizes.length > most) throw new Error('a list did not end')
  } while (cursor !== undefined)
  return { rows, sizes, cursors }
}

/** Every page of REST GET /v1/tasks for `args`. */
export const restPages = (t: T, args: RestArgs, most?: number) =>
  everyPage((cursor) => restPage(t, { ...args, cursor }), most)

/** Every page of MCP list_tasks for `args`. */
export const mcpPages = (t: T, args: McpArgs, most?: number) =>
  everyPage((cursor) => mcpPage(t, { ...args, cursor }), most)

/* The page budget and reserve as they load, which lowered() sets back. */
const PAGE = structuredClone(ACTIVE_PAGE)
const RESERVE = structuredClone(ACTIVE_RESERVE)

/** Runs `fn` with the active page's budget and reserve changed by `page`
 * and `reserve`, and sets both back after it. */
export async function lowered<R>(
  change: { page?: Partial<typeof ACTIVE_PAGE>; reserve?: Partial<typeof ACTIVE_RESERVE> },
  fn: () => Promise<R>,
): Promise<R> {
  Object.assign(ACTIVE_PAGE, change.page ?? {})
  Object.assign(ACTIVE_RESERVE, change.reserve ?? {})
  try {
    return await fn()
  } finally {
    Object.assign(ACTIVE_PAGE, structuredClone(PAGE))
    Object.assign(ACTIVE_RESERVE, structuredClone(RESERVE))
  }
}
