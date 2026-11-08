/* The oracle and helpers of the REST and MCP project list suite
 * (machineProjects.test.ts). The oracle is the read the lists made before
 * they paged: the organization's whole catalogue (lib/core.ts
 * loadCatalogue) with the caller's flags on every project (accessFlags),
 * kept in production for the task routes, and the old list over it
 * (listProjectsCore), sorted here into tree order. A stage that moves the
 * task routes off the catalogue moves this oracle onto a test-only reader,
 * such as orgProjectView.setup.ts. Two dots in the basename keep the Convex
 * CLI from deploying this module, as helpers.setup.ts. */

import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  accessFlags,
  type Caller,
  type Catalogue,
  type CompletionJson,
  loadCatalogue,
  NO_TASKS,
  projectJson,
} from '../lib/core'
import { type CredentialAccess, ISSUE_STATUSES } from '../lib/enums'
import { compareNamed, type NamedAt } from '../lib/namedPages'
import { type ProjectsPageJson, projectDetailJson } from '../machine/projects'
import { familyCounts } from '../model/overviewCounts'
import type { T } from './helpers.setup'

/** A row of the project list. */
export type ProjectRow = ReturnType<typeof projectJson>

/** The catalogue's readable projects on ONE side of the archived axis,
 * (archived_at set) === archived, ordered by key, as REST GET /v1/projects
 * and MCP list_projects listed them before they paged. */
export function listProjectsCore(
  cat: Catalogue,
  archived: boolean,
  readable: (projectId: string) => boolean,
): Doc<'projects'>[] {
  return cat.projects
    .filter((p) => (p.archived_at !== undefined) === archived && readable(p.id))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Where `p` sits in tree order: its top-level project's key and id, then,
 * for a sub-project, its own key and id. */
export function treeAt(cat: Catalogue, p: Doc<'projects'>): NamedAt {
  const root = p.parent_id === undefined ? p : cat.byUuid.get(p.parent_id)
  if (root === undefined) throw new Error(`no parent for ${p.key}`)
  return p.parent_id === undefined
    ? { key: p.key, tie: [p.id, '', ''] }
    : { key: root.key, tie: [root.id, p.key, p.id] }
}

/** The old list's rows for `me` on one side, in tree order. */
export async function oracleRows(
  ctx: QueryCtx,
  me: Caller,
  access: CredentialAccess,
  archived: boolean,
): Promise<ProjectRow[]> {
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat, access)
  return listProjectsCore(cat, archived, (id) => flags.get(id)?.read === true)
    .sort((a, b) => compareNamed(treeAt(cat, a), treeAt(cat, b)))
    .map((p) => projectJson(p, flags.get(p.id) ?? { read: false, write: false }))
}

/** The completion the single read answered over the catalogue before it
 * read one project's access: the live sub-projects the caller reads, or a
 * readable sub-project itself, counted from the stored counts. Inside the
 * design size it never met its room check, which this leaves out. */
async function oracleCompletion(
  ctx: QueryCtx,
  cat: Catalogue,
  readable: (id: string) => boolean,
  project: Doc<'projects'>,
): Promise<CompletionJson | null> {
  if (project.archived_at !== undefined) return null
  const subs =
    project.parent_id === undefined
      ? cat.projects.filter(
          (c) => c.parent_id === project.id && c.archived_at === undefined && readable(c.id),
        )
      : readable(project.id)
        ? [project]
        : []
  if (subs.length === 0) return NO_TASKS
  const counts = await familyCounts(ctx.db, project.org_id, project.parent_id ?? project.id, subs)
  if (counts === null) return { status: 'counting', done: null, total: null, percent: null }
  let done = 0
  let total = 0
  for (const c of counts.values()) {
    done += c.leaves.done
    for (const status of ISSUE_STATUSES) total += c.leaves[status]
  }
  return { status: 'ok', done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** The single read of `project` as the catalogue answered it before
 * (machine/projects.ts projectOut, as it was). */
export async function oracleRead(
  ctx: QueryCtx,
  me: Caller,
  project: Doc<'projects'>,
  access: CredentialAccess,
) {
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat, access)
  const readable = (id: string) => flags.get(id)?.read === true
  return await projectDetailJson(
    ctx,
    me,
    project,
    flags.get(project.id) ?? { read: false, write: false },
    () => oracleCompletion(ctx, cat, readable, project),
  )
}

/** What one list call is asked on both surfaces. */
export type ListAsk = {
  archived?: boolean
  search?: string
  limit?: number
  cursor?: string
}

/** One REST page, `ask` sent as REST's query parameters are. */
export const restPage = (
  t: T,
  me: Caller,
  access: CredentialAccess,
  ask: ListAsk = {},
): Promise<ProjectsPageJson> =>
  t.query(internal.machine.rest.listProjects, {
    callerId: me.id,
    access,
    ...(ask.archived === undefined ? {} : { archived: String(ask.archived) }),
    ...(ask.search === undefined ? {} : { search: ask.search }),
    ...(ask.limit === undefined ? {} : { limit: String(ask.limit) }),
    ...(ask.cursor === undefined ? {} : { cursor: ask.cursor }),
  })

/** One MCP page, parsed. */
export const mcpPage = async (
  t: T,
  me: Caller,
  access: CredentialAccess,
  ask: ListAsk = {},
): Promise<ProjectsPageJson> =>
  JSON.parse(
    await t.query(internal.machine.mcp.listProjects, { callerId: me.id, access, ...ask }),
  ) as ProjectsPageJson

/** Every page of one list from its start, `read` answering the page after
 * a cursor, failing past `most` pages or on a cursor that does not move. */
export async function everyPage(
  read: (cursor: string | undefined) => Promise<ProjectsPageJson>,
  most = 200,
): Promise<{ rows: ProjectRow[]; pages: ProjectsPageJson[] }> {
  const rows: ProjectRow[] = []
  const pages: ProjectsPageJson[] = []
  let cursor: string | undefined
  for (let n = 0; n < most; n++) {
    const page = await read(cursor)
    pages.push(page)
    rows.push(...page.projects)
    if (page.next_cursor === null) return { rows, pages }
    if (page.next_cursor === cursor) throw new Error('a page answered its own cursor')
    cursor = page.next_cursor
  }
  throw new Error(`the list did not end in ${most} pages`)
}
