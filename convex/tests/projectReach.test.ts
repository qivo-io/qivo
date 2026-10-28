/* Tests of the project navigation data: archive states and project_reach
 * rows (model/projectNav.ts), every writer that keeps them, the tree change
 * budget (LIMITS.projectTreeChange), Deleted items moves, restores and
 * purges, the teardowns, and the backfill (internal/navBackfill.ts).
 *
 * withOrg plants its rows without archive states or reach rows, as rows
 * stored before this release are, so most tests first bring it in line
 * with the backfill (ready). Every expectation of the rows goes through
 * tests/projectReach.setup.ts, which works the rows out from the sources
 * and from lib/access.ts projectLevel, not from model/projectNav.ts. Fake
 * timers keep every scheduled step from running until a test releases it
 * (trash.setup.ts installTrashTimers). */
/// <reference types="vite/client" />

import { type FunctionArgs, makeFunctionReference } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { NAV_STEP, RUN } from '../internal/navBackfill'
import { byId } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import type { OrgExportPage, OrgExportSection } from '../lib/orgExport'
import { ACCESS_FIRST_PASS, deleteOrgDeep, REMOVAL_BUDGET } from '../model/cascade'
import {
  clearOrgTrash,
  meterDb,
  REVEAL_RANGES_PER_PROJECT,
  runStep,
  TRASH_BUDGET,
} from '../model/deletedItems'
import { ARCHIVED_READ_PROJECTS } from '../model/messages'
import { deleteOrgStep } from '../model/orgDeletion'
import { countersRow, insertOrgRows, newOrgDefaults } from '../model/orgs'
import {
  grantBatch,
  grantee,
  navReady,
  syncReach,
  TREE_READ,
  TREE_TOO_LARGE,
} from '../model/projectNav'
import { createProjectCore } from '../model/projects'
import {
  as,
  expectLiveCounts,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
import {
  expectedReach,
  expectReachExact,
  expectReachMatchesAccess,
  reachRows,
} from './projectReach.setup'
import { assertNoDanglingRefs } from './refs.setup'
import { installTrashTimers, itemFor, jobFor, runSteps, step } from './trash.setup'

installTrashTimers()

const STEP_DEFAULTS = { ...NAV_STEP }
const RUN_DEFAULTS = { ...RUN }
const TREE_DEFAULTS = { ...TREE_READ }
const PASS_DEFAULTS = { ...ACCESS_FIRST_PASS }
const REMOVAL_DEFAULTS = { ...REMOVAL_BUDGET }
const DEFAULT_ROWS = TRASH_BUDGET.rows
afterEach(() => {
  Object.assign(NAV_STEP, STEP_DEFAULTS)
  Object.assign(RUN, RUN_DEFAULTS)
  Object.assign(TREE_READ, TREE_DEFAULTS)
  Object.assign(ACCESS_FIRST_PASS, PASS_DEFAULTS)
  Object.assign(REMOVAL_BUDGET, REMOVAL_DEFAULTS)
})

/** Where a call of the backfill goes on, as the last call answered it. */
type Cursor = FunctionArgs<typeof internal.internal.navBackfill.run>['cursor']

const backfill = (t: T, dry_run: boolean, cursor?: Cursor) =>
  t.action(internal.internal.navBackfill.run, { dry_run, ...(cursor ? { cursor } : {}) })

/** The backfill's audit rows, oldest first. */
const audits = (t: T) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'nav_backfill'))
        .collect()
    ).map((row) => row.detail),
  )

/** withOrg with its archive states and reach rows written by the backfill,
 * checked against the oracle, and a person without access, `pia`. */
async function ready(t: T) {
  const f = await withOrg(t)
  const pia = await plantSeat(t, { org_id: f.org.id, name: 'Pia Lund', email: 'pia@testbed.test' })
  await backfill(t, false)
  await expectReachExact(t)
  return { ...f, pia }
}

/** Every check of the rows: exact against the sources, and against
 * projectLevel for the people of the fixture's organization. */
async function expectAll(t: T, f: OrgFixture): Promise<void> {
  await expectReachExact(t)
  await expectReachMatchesAccess(t, f.org.id)
}

const rowsOf = async (t: T, granteeId: string) =>
  (await reachRows(t)).filter((row) => row.grantee_id === granteeId)

const projectOf = (t: T, id: string) => t.run((ctx) => byId(ctx, 'projects', id))

const states = async (t: T, ids: string[]) =>
  Promise.all(ids.map(async (id) => (await projectOf(t, id))?.archive_state))

describe('reach rows follow ordinary access', () => {
  it('reaches a whole tree through a top-level grant and only the parent of a granted sub-project', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      user_id: f.pia.id,
      level: 'user',
    })
    expect(await rowsOf(t, f.pia.id)).toEqual([
      expect.objectContaining({ kind: 'root', project_id: f.meta.id, on_root: true }),
    ])
    const ole = await plantSeat(t, { org_id, name: 'Ole Berg', email: 'ole@testbed.test' })
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: ole.id,
      level: 'viewer',
    })
    // the parent for navigation only, the sub-project itself, never its sibling
    expect(await rowsOf(t, ole.id)).toEqual([
      expect.objectContaining({ kind: 'child', project_id: f.sub.id, root_id: f.meta.id }),
      expect.objectContaining({ kind: 'root', project_id: f.meta.id, on_root: false }),
    ])
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub2.id,
      team_id: f.team.id,
      level: 'user',
    })
    expect(await rowsOf(t, f.team.id)).toEqual([
      expect.objectContaining({ grantee_kind: 'team', kind: 'child', project_id: f.sub2.id }),
      expect.objectContaining({ grantee_kind: 'team', kind: 'root', on_root: false }),
    ])
    await expectAll(t, f)
  })

  it('writes no row for admin status alone', async () => {
    const t = newT()
    const f = await ready(t)
    const id = uuid()
    // the admin names someone else as lead and declines their own grant
    await as(t, f.admin).mutation(api.projects.create, {
      org_id: f.org.id,
      id,
      type: 'meta',
      key: 'ADM',
      name: 'Admin made',
      lead_id: f.user.id,
      sort_order: 9,
      access: { [f.admin.id]: null },
    })
    expect(await rowsOf(t, f.admin.id)).toEqual([])
    expect((await rowsOf(t, f.user.id)).map((row) => row.project_id)).toContain(id)
    await expectAll(t, f)
  })

  it('writes no row outside a top-level meta tree or across organizations', async () => {
    const t = newT()
    const f = await ready(t)
    const legacy = await plantProject(t, { org_id: f.org.id, type: 'project' })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: legacy.id,
        profile_id: f.pia.id,
        level: 'user',
      })
      // a grant of another organization's seat, which no writer allows
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.otherAdmin.id,
        level: 'user',
      })
      await syncReach(ctx, grantee.profile(f.pia.id), legacy.id)
      await syncReach(ctx, grantee.profile(f.otherAdmin.id), f.meta.id)
    })
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    expect(await rowsOf(t, f.otherAdmin.id)).toEqual([])
    await expectAll(t, f)
  })
})

describe('archive states', () => {
  it('never leave the server: the workspace, the export, REST and MCP', async () => {
    const t = newT()
    const f = await ready(t)
    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: f.hidden.id })
    expect(await states(t, [f.meta.id, f.hidden.id])).toEqual(['live', 'listed'])
    const snap = (await workspaceOf(as(t, f.user)))!
    expect(snap.projects.length).toBeGreaterThan(0)
    for (const row of snap.projects) expect(row).not.toHaveProperty('archive_state')
    const page = makeFunctionReference<
      'query',
      { org_id: string; section: OrgExportSection; cursor: string | null },
      OrgExportPage
    >('orgExport:page')
    const exported = await as(t, f.admin).query(page, {
      org_id: f.org.id,
      section: 'projects',
      cursor: null,
    })
    expect(exported.rows.length).toBeGreaterThan(0)
    for (const row of exported.rows) expect(row).not.toHaveProperty('archive_state')
    const caller = { callerId: f.user.id, access: 'read' as const }
    const rest = await t.query(internal.machine.rest.getProject, { ...caller, ref: f.meta.key })
    expect(rest).not.toHaveProperty('archive_state')
    for (const archived of [false, true]) {
      const listed = await t.query(internal.machine.rest.listProjects, {
        ...caller,
        archived: String(archived),
      })
      expect(listed.length).toBeGreaterThan(0)
      for (const row of listed) expect(row).not.toHaveProperty('archive_state')
      const mcp = await t.query(internal.machine.mcp.listProjects, { ...caller, archived })
      expect(JSON.stringify(mcp)).not.toContain('archive_state')
    }
  })
})

describe('projects outside every tree', () => {
  it("leaves the parent's row of a grantee who also holds a source on a project nested under it", async () => {
    const t = newT()
    const f = await ready(t)
    // a project under a sub-project, which no writer makes now, led by Pia,
    // who also holds a grant on the sub-project above it
    const nested = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.sub.id,
      lead_id: f.pia.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: f.pia.id,
        level: 'user',
      })
      await ctx.db.insert('project_access', {
        project_id: nested.id,
        profile_id: f.viewer.id,
        level: 'viewer',
      })
    })
    await backfill(t, false)
    await expectAll(t, f)
    expect(await rowsOf(t, f.pia.id)).toEqual([
      expect.objectContaining({ kind: 'child', project_id: f.sub.id }),
      expect.objectContaining({ kind: 'root', project_id: f.meta.id, on_root: false }),
    ])
    // a recompute on the nested project leaves the sub-project's row alone
    await t.run((ctx) => syncReach(ctx, grantee.profile(f.pia.id), nested.id))
    await expectReachExact(t)
    expect(await backfill(t, true)).toMatchObject({
      archive_state: { missing: 0, stale: 0 },
      reach: { missing: 0, extra: 0, stale: 0 },
    })
  })
})

describe('grants given together', () => {
  it("read each project's reach rows once, however many sub-projects they go to", async () => {
    const t = newT()
    const f = await ready(t)
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 8; i++)
      subs.push(await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id }))
    const people: string[] = []
    for (let i = 0; i < 60; i++)
      people.push(
        (await plantSeat(t, { org_id: f.org.id, name: `G${i}`, email: `g${i}@testbed.test` })).id,
      )
    const read = await t.run(async (ctx) => {
      let rows = 0
      const counted = meterDb(ctx, {
        range: () => {},
        doc: (doc) => {
          if (typeof doc === 'object' && doc !== null && 'grantee_kind' in doc) rows += 1
        },
      })
      const batch = grantBatch(counted)
      for (const sub of subs)
        for (const id of people)
          await batch.grant(sub, { project_id: sub.id, profile_id: id, level: 'viewer' })
      await batch.finish()
      return rows
    })
    // one read of the product's rows, which the first sub-project's grants
    // fill, not one a sub-project
    expect(read).toBeLessThan(people.length)
    await expectAll(t, f)
  })

  it('keep the reach rows of a removal that keeps people as Viewers on several sub-projects exact', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    const people: Doc<'profiles'>[] = []
    for (let i = 0; i < 12; i++)
      people.push(await plantSeat(t, { org_id, name: `K${i}`, email: `k${i}@testbed.test` }))
    await t.run(async (ctx) => {
      for (const p of people)
        await ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: p.id,
          is_leader: false,
        })
    })
    for (const id of [f.sub.id, f.sub2.id])
      await admin.mutation(api.projects.setAccess, {
        org_id,
        id,
        team_id: f.team.id,
        level: 'user',
      })
    for (const p of people)
      for (const project_id of [f.sub.id, f.sub2.id])
        await plantIssue(t, { org_id, project_id, status: 'todo', assignee_id: p.id })
    for (const id of [f.sub.id, f.sub2.id])
      await admin.mutation(api.projects.removeAccess, {
        org_id,
        id,
        team_id: f.team.id,
        on_held_tasks: 'keep_as_viewer',
      })
    for (const p of people)
      expect((await rowsOf(t, p.id)).map((row) => row.kind).sort()).toEqual([
        'child',
        'child',
        'root',
      ])
    await expectAll(t, f)
  }, 60_000)

  it('give a new project many grants for a few index ranges each', async () => {
    const t = newT()
    const f = await ready(t)
    const people: string[] = []
    for (let i = 0; i < 80; i++)
      people.push(
        (await plantSeat(t, { org_id: f.org.id, name: `C${i}`, email: `c${i}@testbed.test` })).id,
      )
    const ranges = await t.run(async (ctx) => {
      let count = 0
      const counted = meterDb(ctx, {
        range: () => {
          count += 1
        },
      })
      const admin = await byId(ctx, 'profiles', f.admin.id)
      await createProjectCore(counted, {
        me: admin!,
        now: NOW,
        project: {
          id: uuid(),
          type: 'meta',
          name: 'Many grants',
          lead_id: f.user.id,
          access: Object.fromEntries(people.map((id) => [id, 'viewer' as const])),
        },
      })
      return count
    })
    // the grantee's profile a grant checks, and no recompute a grant
    expect(ranges).toBeLessThan(people.length * 2)
    await expectAll(t, f)
  })
})

/* Source text through the ?raw eager glob, as tests/manifest.test.ts reads
 * it, so the scan needs no fs in the edge runtime. */
const sources = import.meta.glob(['../**/*.ts', '!../_generated/**', '!../tests/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

describe('the one way to write a grant, a share or a lead', () => {
  const INSERT = /\.insert\(\s*['"]project_(team_)?access['"]/

  it('inserts grants and shares only in model/projectNav.ts, which writes their reach rows', () => {
    // the scan sees the file that inserts them, so its silence means something
    expect(sources['../model/projectNav.ts']).toMatch(INSERT)
    const others = Object.entries(sources)
      .filter(([path, source]) => path !== '../model/projectNav.ts' && INSERT.test(source))
      .map(([path]) => path)
    expect(others).toEqual([])
  })

  /* A grant or share read, or taken as a row, and deleted in one
   * declaration, the shape a direct delete takes; the declaration ends at
   * the next one that starts a line. Any `.delete(` counts, whatever its
   * receiver is called and across a line break, except on a Set or Map the
   * file declares with `new`, such as a set of the ids it read. Only the
   * helpers and the teardowns, which delete the reach rows themselves, may. */
  const READ =
    /\.query\(\s*['"]project_(team_)?access['"]|tagged\(\s*['"]project_(team_)?access['"]|Doc<\s*['"]project_(team_)?access['"]\s*>/g
  // the receiver's name, as `ids` in ids.delete( or uncountedWriter in
  // uncountedWriter(ctx.db).delete(
  const DELETE = /([\w$]+)(?:\([^()]*\))?\s*\.\s*delete\(/g
  const COLLECTION = /\b(?:const|let)\s+([\w$]+)\b[^=\n]*=\s*new\s+(?:Set|Map)\b/g
  const NEXT = /^(\}|export |async function |function |const |type |\/\*)/m
  const deletesGrants = (source: string) => {
    const collections = new Set([...source.matchAll(COLLECTION)].map((m) => m[1]))
    return [...source.matchAll(READ)].some((read) => {
      const rest = source.slice((read.index ?? 0) + read[0].length)
      const end = NEXT.exec(rest)
      return [...rest.slice(0, end?.index ?? rest.length).matchAll(DELETE)].some(
        (del) => !collections.has(del[1]),
      )
    })
  }
  const TEARDOWNS = new Set([
    '../model/projectNav.ts',
    // team deletion and the deep organization delete, which delete the rows
    '../model/cascade.ts',
    '../model/orgDeletion.ts',
    '../internal/demoCleanup.ts',
    '../model/deletedItems.ts',
  ])

  it('deletes grants and shares only through the helpers or in a teardown', () => {
    // the scan sees the deletes it allows, so its silence means something
    for (const path of [
      '../model/projectNav.ts',
      '../model/cascade.ts',
      '../internal/demoCleanup.ts',
    ])
      expect(deletesGrants(sources[path])).toBe(true)
    const read = "for (const row of await ctx.db.query('project_access').collect())"
    expect(deletesGrants(`${read} await ctx.db.delete(row._id)`)).toBe(true)
    expect(deletesGrants(`${read} await uncountedWriter(ctx.db).delete(row._id)`)).toBe(true)
    expect(deletesGrants("async (row: Doc<'project_team_access'>) => db.delete(row._id)")).toBe(
      true,
    )
    // a writer under another name, and a delete across a line break
    expect(deletesGrants(`const writer = ctx.db\n  ${read} await writer.delete(row._id)`)).toBe(
      true,
    )
    expect(deletesGrants(`${read} await ctx.db\n      .delete(row._id)`)).toBe(true)
    // a set of the ids it read, as a milestone read's navigation check keeps
    const ids = 'const ids = new Set<string>()\n  '
    expect(deletesGrants(`${ids}${read} ids.delete(row.project_id)`)).toBe(false)
    // the same name taken by a writer is not taken for a set
    expect(deletesGrants(`${read} ids.delete(row._id)`)).toBe(true)
    const others = Object.entries(sources)
      .filter(([path, source]) => !TEARDOWNS.has(path) && deletesGrants(source))
      .map(([path]) => path)
    expect(others).toEqual([])
  })

  /* A project row inserted, or a lead written, outside a module that
   * brings the lead's rows in line (syncLeads). */
  const LEAD =
    /insert\(\s*['"]projects['"]|insertUnique\(\s*ctx,\s*['"]projects['"]|\.patch\([^)]*\{\s*lead_id|\bdb\.lead_id\s*=|lead_id: undefined/
  const LEADLESS = new Set([
    // its projects have no lead
    '../internal/guestOrg.ts',
    // a removal clears the leads of a person whose rows it deletes
    '../model/cascade.ts',
  ])

  it('writes a lead only where its reach rows follow', () => {
    expect(sources['../model/projects.ts']).toMatch(LEAD)
    const others = Object.entries(sources)
      .filter(
        ([path, source]) =>
          !LEADLESS.has(path) && LEAD.test(source) && !source.includes('syncLeads('),
      )
      .map(([path]) => path)
    expect(others).toEqual([])
  })
})

describe('every writer keeps the rows exact', () => {
  it('creates a project and a sub-project with their lead, grants and shares', async () => {
    const t = newT()
    const f = await ready(t)
    const id = uuid()
    await as(t, f.admin).mutation(api.projects.create, {
      org_id: f.org.id,
      id,
      type: 'meta',
      key: 'NEW',
      name: 'New product',
      lead_id: f.user.id,
      sort_order: 9,
      access: { [f.pia.id]: 'viewer' },
      team_access: { [f.team.id]: 'user' },
    })
    expect((await projectOf(t, id))?.archive_state).toBe('live')
    // the lead of the new product creates a sub-project led by Pia
    const sub = uuid()
    await as(t, f.user).mutation(api.projects.create, {
      org_id: f.org.id,
      id: sub,
      type: 'project',
      parent_id: id,
      key: 'NSUB',
      name: 'New sub',
      lead_id: f.pia.id,
      sort_order: 0,
    })
    expect(await rowsOf(t, f.pia.id)).toContainEqual(
      expect.objectContaining({ kind: 'child', project_id: sub, root_id: id }),
    )
    await expectAll(t, f)
  })

  it('follows a rename, a key change, a lead handover and the access maps', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const ole = await plantSeat(t, { org_id, name: 'Ole Berg', email: 'ole@testbed.test' })
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: ole.id,
      level: 'user',
    })
    const lead = as(t, f.user)
    await lead.mutation(api.projects.update, {
      org_id,
      id: f.meta.id,
      patch: { name: '  Testbed   Platform Two ', key: 'TB2' },
    })
    // the navigation-only row of Ole follows too
    expect(await rowsOf(t, ole.id)).toContainEqual(
      expect.objectContaining({ kind: 'root', name_key: 'testbed platform two', key: 'TB2' }),
    )
    await expectAll(t, f)
    await lead.mutation(api.projects.update, {
      org_id,
      id: f.sub.id,
      patch: { name: 'Firmware Next' },
    })
    await expectAll(t, f)
    // the lead hands the product over to Pia and keeps User access
    await lead.mutation(api.projects.update, {
      org_id,
      id: f.meta.id,
      patch: { lead_id: f.pia.id },
    })
    expect(await rowsOf(t, f.pia.id)).toEqual([
      expect.objectContaining({ kind: 'root', project_id: f.meta.id, on_root: true }),
    ])
    await expectAll(t, f)
    // a sub-project lead of its own
    await as(t, f.admin).mutation(api.projects.update, {
      org_id,
      id: f.sub2.id,
      patch: { lead_id: ole.id },
    })
    expect(await rowsOf(t, ole.id)).toContainEqual(
      expect.objectContaining({ kind: 'child', project_id: f.sub2.id }),
    )
    await expectAll(t, f)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id,
      id: f.hidden.id,
      patch: { access: { [ole.id]: 'viewer' }, team_access: { [f.team.id]: 'viewer' } },
    })
    await expectAll(t, f)
  }, 60_000)

  it('keeps the rows through a level change and takes them away with the grant or share', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'user',
    })
    const before = await rowsOf(t, f.pia.id)
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'viewer',
    })
    expect(await rowsOf(t, f.pia.id)).toEqual(before)
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      team_id: f.team.id,
      level: 'viewer',
    })
    await admin.mutation(api.projects.removeAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      on_held_tasks: 'leave',
    })
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await admin.mutation(api.projects.removeAccess, {
      org_id,
      id: f.meta.id,
      team_id: f.team.id,
      on_held_tasks: 'leave',
    })
    expect(await rowsOf(t, f.team.id)).toEqual([])
    await expectAll(t, f)
  })

  it('writes the rows of the Viewer grants a removal keeps', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    await t.run((ctx) =>
      ctx.db.insert('team_members', { team_id: f.team.id, profile_id: f.pia.id, is_leader: false }),
    )
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub2.id,
      team_id: f.team.id,
      level: 'user',
    })
    await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      status: 'todo',
      assignee_id: f.pia.id,
    })
    await admin.mutation(api.projects.removeAccess, {
      org_id,
      id: f.sub2.id,
      team_id: f.team.id,
      on_held_tasks: 'keep_as_viewer',
    })
    expect(await rowsOf(t, f.pia.id)).toContainEqual(
      expect.objectContaining({ kind: 'child', project_id: f.sub2.id }),
    )
    expect(await rowsOf(t, f.team.id)).toEqual([])
    await expectAll(t, f)
  })

  it("writes a new guest's rows", async () => {
    const t = newT()
    const f = await ready(t)
    const { id } = await as(t, f.user).mutation(api.projects.inviteGuest, {
      org_id: f.org.id,
      project_id: f.sub.id,
      email: 'visitor@elsewhere.test',
      level: 'user',
    })
    expect((await rowsOf(t, id)).map((row) => row.kind)).toEqual(['child', 'root'])
    await expectAll(t, f)
  })

  it('writes nothing for a membership change, which teams already cover', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id: f.hidden.id,
      team_id: f.team.id,
      level: 'user',
    })
    const before = await reachRows(t)
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id,
      team_id: f.team.id,
      profile_id: f.pia.id,
    })
    expect(await reachRows(t)).toEqual(before)
    await expectAll(t, f)
    await as(t, f.admin).mutation(api.teams.removeMember, {
      org_id,
      team_id: f.team.id,
      profile_id: f.pia.id,
      on_held_tasks: 'leave',
    })
    expect(await reachRows(t)).toEqual(before)
    await expectAll(t, f)
  })
})

describe('archiving and restoring a tree', () => {
  it('keeps the states and the live copies right in every order', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const ids = [f.meta.id, f.sub.id, f.sub2.id]
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'user',
    })
    const lead = as(t, f.user)
    expect(await states(t, ids)).toEqual(['live', 'live', 'live'])
    await lead.mutation(api.projects.archive, { org_id, id: f.sub.id })
    expect(await states(t, ids)).toEqual(['live', 'listed', 'live'])
    await expectAll(t, f)
    // a later instant, so the parent's stamp is not the sub-project's
    vi.setSystemTime(Date.now() + 60_000)
    await lead.mutation(api.projects.archive, { org_id, id: f.meta.id })
    expect(await states(t, ids)).toEqual(['listed', 'under', 'under'])
    await expectAll(t, f)
    // the parent brings back the sub-project archived with it, not the other
    await lead.mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    expect(await states(t, ids)).toEqual(['live', 'listed', 'live'])
    await expectAll(t, f)
    await lead.mutation(api.projects.unarchive, { org_id, id: f.sub.id })
    expect(await states(t, ids)).toEqual(['live', 'live', 'live'])
    await expectAll(t, f)
    // a sub-project restored under an archived parent surfaces the parent
    // only, and its sibling then stands as its own entry
    await lead.mutation(api.projects.archive, { org_id, id: f.meta.id })
    await lead.mutation(api.projects.unarchive, { org_id, id: f.sub.id })
    expect(await states(t, ids)).toEqual(['live', 'live', 'listed'])
    await expectAll(t, f)
  })

  it(`refuses a change past ${LIMITS.projectTreeChange.max} sub-projects and entries before it writes`, async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const lead = as(t, f.user)
    const refusal = new RegExp(`^${LIMITS.projectTreeChange.refusal.replace(/[.,]/g, '\\$&')}$`)
    const onMeta = async () =>
      (await reachRows(t)).filter((row) => row.project_id === f.meta.id).length
    // planted entries on the product up to the budget, one for each
    // sub-project an archive writes left free
    const plant = (n: number) =>
      t.run(async (ctx) => {
        for (let i = 0; i < n; i++)
          await ctx.db.insert('project_reach', {
            org_id,
            grantee_kind: 'profile',
            grantee_id: uuid(),
            kind: 'root',
            project_id: f.meta.id,
            root_id: f.meta.id,
            name_key: nameKey(f.meta.name),
            key: f.meta.key,
            live: true,
            on_root: false,
          })
      })
    const { max } = LIMITS.projectTreeChange
    for (let left = max - 2 - (await onMeta()); left > 0; left -= 500)
      await plant(Math.min(left, 500))
    expect(await onMeta()).toBe(max - 2)
    // 1,998 entries and two sub-projects fit an archive
    await lead.mutation(api.projects.archive, { org_id, id: f.meta.id })
    await lead.mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    await plant(1)
    const before = await reachRows(t)
    await expectRefusal(
      lead.mutation(api.projects.archive, { org_id, id: f.meta.id }),
      'rule',
      refusal,
    )
    expect(await states(t, [f.meta.id, f.sub.id, f.sub2.id])).toEqual(['live', 'live', 'live'])
    // a rename writes no sub-project, so 1,999 entries fit it and 2,001 do not
    await lead.mutation(api.projects.update, { org_id, id: f.meta.id, patch: { name: 'Renamed' } })
    await plant(2)
    await expectRefusal(
      lead.mutation(api.projects.update, { org_id, id: f.meta.id, patch: { name: 'Again' } }),
      'rule',
      refusal,
    )
    expect((await projectOf(t, f.meta.id))?.name).toBe('Renamed')
    expect((await reachRows(t)).length).toBe(before.length + 2)
  }, 120_000)

  it('refuses a tree whose sub-projects pass the bytes a change reads', async () => {
    const t = newT()
    const f = await ready(t)
    TREE_READ.bytes = 600
    const e = await expectRefusal(
      as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id }),
      'rule',
    )
    // its own sentence, which names the cause, not the 2,000 entries
    expect((e.data as Refusal).message).toBe(TREE_TOO_LARGE)
    expect((await projectOf(t, f.meta.id))?.archived_at).toBeUndefined()
  })

  it('archives a project with more than 1,000 live sub-projects within the scheduler limit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    for (let from = 0; from < 1_100; from += 275)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 275; i++)
          await ctx.db.insert('projects', {
            id: uuid(),
            org_id: f.org.id,
            type: 'project',
            parent_id: f.meta.id,
            key: `S${i}`,
            name: `Sub ${i}`,
            description: '',
            sort_order: i,
            num: 100 + i,
            track_delay: false,
            created_at: NOW,
          })
      })
    // one step a sub-project would schedule more than Convex's 1,000
    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    expect((await projectOf(t, f.meta.id))?.archive_state).toBe('listed')
    const scheduled = await t.run(
      async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).filter(
          (job) => job.name === 'messages:readArchivedProject',
        ).length,
    )
    expect(scheduled).toBe(Math.ceil(1_103 / ARCHIVED_READ_PROJECTS))
  }, 120_000)

  it('shares one budget between the archive and the rename of one REST update', async () => {
    const t = newT()
    const f = await ready(t)
    // 1,200 entries on the product: an archive or a rename alone fits, both
    // in one transaction do not
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_200; i++)
        await ctx.db.insert('project_reach', {
          org_id: f.org.id,
          grantee_kind: 'profile',
          grantee_id: uuid(),
          kind: 'root',
          project_id: f.meta.id,
          root_id: f.meta.id,
          name_key: nameKey(f.meta.name),
          key: f.meta.key,
          live: true,
          on_root: false,
        })
    })
    const update = (body: object) =>
      t.mutation(internal.machine.projects.restUpdateProject, {
        callerId: f.user.id,
        access: 'write',
        keyName: null,
        ref: f.meta.key,
        body: JSON.stringify(body),
      })
    await expectRefusal(update({ archived: true, name: 'Both' }), 'rule', /at most 2,000/)
    expect(await projectOf(t, f.meta.id)).toMatchObject({ name: f.meta.name })
    expect((await projectOf(t, f.meta.id))?.archived_at).toBeUndefined()
    await update({ archived: true })
    await update({ name: 'One at a time' })
    expect(await projectOf(t, f.meta.id)).toMatchObject({ archive_state: 'listed' })
  }, 60_000)
})

describe('Deleted items', () => {
  it('deletes the rows of a moved sub-project and writes them again before its reveal', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'user',
    })
    const pia = await rowsOf(t, f.pia.id)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.sub.id })
    await runSteps(t)
    // the sub-project's row goes, and with it Pia's way to its parent
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await expectAll(t, f)
    const item = await itemFor(t, f.sub.id)
    // the call writes Pia's grant back with its rows, spends its one row
    // and leaves the reveal to the steps
    TRASH_BUDGET.rows = 1
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_access' })
    expect(await projectOf(t, f.sub.id)).toBeNull()
    expect(await rowsOf(t, f.pia.id)).toEqual(pia)
    await runSteps(t)
    expect(await jobFor(t, item.id)).toBeNull()
    await expectAll(t, f)
    await assertNoDanglingRefs(t, 'after a sub-project restore')
  })

  it('keeps a parent that a grant reached while its sub-project moved', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'user',
    })
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.sub.id })
    // between the delete and the steps that drain the sub-project's rows
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.meta.id,
      user_id: f.pia.id,
      level: 'viewer',
    })
    await runSteps(t)
    expect(await rowsOf(t, f.pia.id)).toEqual([
      expect.objectContaining({ kind: 'root', project_id: f.meta.id, on_root: true }),
    ])
    await expectAll(t, f)
  })

  it('gives a restored tree its archive states again', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.user).mutation(api.projects.archive, { org_id, id: f.sub.id })
    await as(t, f.user).mutation(api.projects.archive, { org_id, id: f.meta.id })
    // copies stored without states, as before this release
    for (const id of [f.meta.id, f.sub.id, f.sub2.id])
      await t.run(async (ctx) => {
        const row = await byId(ctx, 'projects', id)
        if (row !== null) await ctx.db.patch(row._id, { archive_state: undefined })
      })
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    await runSteps(t)
    expect((await reachRows(t)).filter((row) => row.root_id === f.meta.id)).toEqual([])
    await expectAll(t, f)
    const item = await itemFor(t, f.meta.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    await runSteps(t)
    expect(await states(t, [f.meta.id, f.sub.id, f.sub2.id])).toEqual(['listed', 'under', 'under'])
    await expectAll(t, f)
  })

  it('never lets a project that takes a purged id adopt its rows', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id, ids: [item.id] })
    await runSteps(t)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
    // the other organization's admin creates a project with the freed id
    await as(t, f.otherAdmin).mutation(api.projects.create, {
      org_id: f.otherOrg.id,
      id: f.meta.id,
      type: 'meta',
      key: 'REUSE',
      name: 'Reused',
      sort_order: 1,
    })
    expect((await reachRows(t)).filter((row) => row.project_id === f.meta.id)).toEqual([
      expect.objectContaining({ org_id: f.otherOrg.id, grantee_id: f.otherAdmin.id }),
    ])
    await expectAll(t, f)
  })

  it('leaves nothing for a sub-project that takes a purged id in the same organization', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'user',
    })
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.sub.id })
    await runSteps(t)
    const item = await itemFor(t, f.sub.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id, ids: [item.id] })
    await runSteps(t)
    await as(t, f.user).mutation(api.projects.create, {
      org_id,
      id: f.sub.id,
      type: 'project',
      parent_id: f.meta.id,
      key: 'FW2',
      name: 'Firmware again',
      sort_order: 5,
    })
    // Pia's grant went with the purged sub-project, and her rows with it
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await expectAll(t, f)
  })

  it('deletes the rows of a project a teardown takes from Deleted items before its move drained them', async () => {
    const t = newT()
    const f = await ready(t)
    // the delete hides the tree and, with one row of budget, leaves the rows
    // to its steps, which wait
    TRASH_BUDGET.rows = 1
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    expect((await reachRows(t)).some((row) => row.root_id === f.meta.id)).toBe(true)
    await t.run((ctx) => clearOrgTrash(ctx, f.org.id, { left: Number.POSITIVE_INFINITY }))
    expect((await reachRows(t)).filter((row) => row.root_id === f.meta.id)).toEqual([])
  })
})

describe('a restore and the work around it', () => {
  /** Pia's grant on Firmware, its move to Deleted items finished, and a
   * restore whose call writes her grant back with its rows and stops there,
   * one row of budget spent, the reveal left to the steps. */
  async function halfRestored(t: T) {
    const f = await ready(t)
    const org_id = f.org.id
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      user_id: f.pia.id,
      level: 'user',
    })
    const pia = await rowsOf(t, f.pia.id)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.sub.id })
    await runSteps(t)
    const item = await itemFor(t, f.sub.id)
    TRASH_BUDGET.rows = 1
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_access' })
    expect(await projectOf(t, f.sub.id)).toBeNull()
    expect(await rowsOf(t, f.pia.id)).toEqual(pia)
    return { f, item, pia }
  }

  it('keeps through a backfill the rows a restore wrote before its reveal', async () => {
    const t = newT()
    const { f, pia } = await halfRestored(t)
    expect(await backfill(t, false)).toMatchObject({ done: true })
    expect(await rowsOf(t, f.pia.id)).toEqual(pia)
    await runSteps(t)
    await expectAll(t, f)
    expect((await backfill(t, true)).reach).toEqual({ missing: 0, extra: 0, stale: 0 })
  })

  it('writes after its reveal the rows an earlier release left out', async () => {
    const t = newT()
    const { f } = await halfRestored(t)
    // as a job of the base release, which wrote grants back without rows
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('project_reach').collect())
        if (row.grantee_id === f.pia.id) await ctx.db.delete(row._id)
    })
    await runSteps(t)
    await expectAll(t, f)
  })

  it('takes the rows back when the reveal sends the item back', async () => {
    const t = newT()
    const { f, item } = await halfRestored(t)
    // the restorer's seat is switched off, so the reveal refuses
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'profiles', f.user.id)
      if (row !== null) await ctx.db.patch(row._id, { active: false })
    })
    await runSteps(t)
    expect((await t.run((ctx) => byId(ctx, 'deleted_items', item.id)))?.state).toBe('ready')
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await expectReachExact(t)
  })

  it('leaves the rows of a sub-project its restore has not revealed when its parent is archived', async () => {
    const t = newT()
    const { f, pia } = await halfRestored(t)
    const org_id = f.org.id
    const onSub = async () => (await rowsOf(t, f.pia.id)).find((row) => row.project_id === f.sub.id)
    // the parent goes to the archive with its other sub-project and back,
    // while Firmware waits for its reveal
    await as(t, f.user).mutation(api.projects.archive, { org_id, id: f.meta.id })
    expect(await onSub()).toMatchObject({ live: true })
    vi.setSystemTime(Date.now() + 60_000)
    await as(t, f.user).mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    expect(await rowsOf(t, f.pia.id)).toEqual(pia)
    await runSteps(t)
    expect(await onSub()).toMatchObject({ live: true })
    await expectAll(t, f)
  })

  it('writes again after the reveal a row whose copy differs from the revealed project', async () => {
    const t = newT()
    const { f } = await halfRestored(t)
    // a copy that went stale while Firmware waited for its reveal
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('project_reach').collect())
        if (row.grantee_id === f.pia.id && row.project_id === f.sub.id)
          await ctx.db.patch(row._id, { live: false, name_key: 'stale' })
    })
    await runSteps(t)
    expect((await rowsOf(t, f.pia.id)).find((row) => row.project_id === f.sub.id)).toMatchObject({
      live: true,
      name_key: nameKey(f.sub.name),
    })
    await expectAll(t, f)
  })

  it('reveals many sub-projects with leads under a parent with a large legacy icon', async () => {
    const t = newT({ transactionLimits: true })
    const f = await ready(t)
    const org_id = f.org.id
    // a legacy icon on the top-level project, under the size a stored row
    // may hold, and 24 sub-projects with a lead of their own each
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'projects', f.meta.id)
      if (row !== null) await ctx.db.patch(row._id, { icon: 'i'.repeat(950_000) })
    })
    for (let i = 0; i < 22; i++)
      await plantProject(t, {
        org_id,
        type: 'project',
        parent_id: f.meta.id,
        lead_id: f.user.id,
      })
    await backfill(t, false)
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.projects).toHaveLength(25)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    await runSteps(t)
    // the reveal and every step after it finished
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
    // the check reads the parent for each person and project in one
    // transaction, so the icon goes first
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'projects', f.meta.id)
      if (row !== null) await ctx.db.patch(row._id, { icon: undefined })
    })
    await expectAll(t, f)
  }, 120_000)

  /** `ctx` whose reads `count` counts as a step's budget does (meterDb),
   * and each delete or patch as one more, for the row it reads, as
   * REVEAL_RANGES_PER_PROJECT counts the stored row's delete. */
  const counting = (ctx: MutationCtx, count: () => void): MutationCtx => {
    const metered = meterDb(ctx, { range: count })
    const db = new Proxy(metered.db, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (key !== 'delete' && key !== 'patch' && key !== 'replace') return value.bind(target)
        return (...args: unknown[]) => {
          count()
          return value.apply(target, args)
        }
      },
    })
    return { ...metered, db }
  }

  /** What the step that reveals Testbed platform with `subs` more
   * sub-projects reads (counting). Each sub-project has a legacy team and
   * a lead of its own, whose reach rows restore_access writes back and who
   * becomes a Viewer before the reveal, so the reveal leaves them out and
   * takes their rows. The organization is counted, as every organization
   * since live counts is (model/orgs.ts insertOrgRows), so the reveal also
   * patches its live_projects (tallyRow). */
  async function demotedReveal(subs: number): Promise<number> {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const leads: string[] = []
    for (let i = 0; i < subs; i++) {
      const lead = await plantSeat(t, { org_id, name: `Lead ${i}`, email: `lead${i}@testbed.test` })
      const team = uuid()
      await t.run((ctx) =>
        ctx.db.insert('teams', {
          id: team,
          org_id,
          name: `Legacy ${i}`,
          track_delay_default: false,
          created_at: NOW,
        }),
      )
      await plantProject(t, {
        org_id,
        type: 'project',
        parent_id: f.meta.id,
        lead_id: lead.id,
        team_id: team,
      })
      leads.push(lead.id)
    }
    await t.run(async (ctx) => {
      const counters = await countersRow(ctx, org_id)
      if (counters === null) throw new Error(`no counters for ${org_id}`)
      const tasks = await ctx.db
        .query('issues')
        .withIndex('by_org_archived', (q) => q.eq('org_id', org_id).eq('archived_at', undefined))
        .collect()
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org_id))
        .collect()
      await ctx.db.patch(counters._id, {
        active_tasks: tasks.length,
        live_projects: projects.length,
      })
    })
    await backfill(t, false)
    const ofLeads = async () => (await reachRows(t)).filter((row) => leads.includes(row.grantee_id))
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    // a row a step, so restore_access writes the rows back over steps and
    // the reveal waits for a step of its own
    TRASH_BUDGET.rows = 1
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    for (let steps = 0; (await jobFor(t, item.id))?.phase !== 'restore_reveal'; steps++) {
      expect(steps).toBeLessThan(100)
      await step(t, item.id)
    }
    TRASH_BUDGET.rows = DEFAULT_ROWS
    // a child row and a root row on Testbed platform for each lead
    expect(await ofLeads()).toHaveLength(2 * subs)
    await t.run(async (ctx) => {
      for (const id of leads) {
        const row = await byId(ctx, 'profiles', id)
        if (row !== null) await ctx.db.patch(row._id, { org_role: 'viewer' })
      }
    })
    let ranges = 0
    await t.run((ctx) =>
      runStep(
        counting(ctx, () => {
          ranges += 1
        }),
        item.id,
      ),
    )
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
    expect(await ofLeads()).toEqual([])
    await expectAll(t, f)
    await expectLiveCounts(t, org_id)
    return ranges
  }

  it('admits a project reveal by an estimate that holds leads who became Viewers after their rows came back', async () => {
    const [five, ten] = [await demotedReveal(5), await demotedReveal(10)]
    // what each sub-project adds stays within what revealFits counts for it
    expect((ten - five) / 5).toBeLessThanOrEqual(REVEAL_RANGES_PER_PROJECT)
  }, 300_000)

  it('deletes the rows of a stuck restoring item it purges', async () => {
    const t = newT()
    const { f, item } = await halfRestored(t)
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'deleted_items', item.id)
      if (row !== null) await ctx.db.patch(row._id, { state: 'stuck' })
    })
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] })
    await runSteps(t)
    expect(await t.run((ctx) => byId(ctx, 'deleted_items', item.id))).toBeNull()
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await expectReachExact(t)
  })

  /** Board rev led by Pia, moved to Deleted items, and a restore whose
   * call wrote her lead's rows and stops before its reveal. */
  async function ledAndRestoring(t: T, extra: Partial<Doc<'projects'>> = {}) {
    const f = await ready(t)
    const org_id = f.org.id
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'projects', f.sub2.id)
      if (row !== null) await ctx.db.patch(row._id, { lead_id: f.pia.id, ...extra })
    })
    await backfill(t, false)
    // Pia leads Board rev now, so the admin deletes and restores it
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id, id: f.sub2.id })
    await runSteps(t)
    return { f, item: await itemFor(t, f.sub2.id) }
  }

  it("brings a lead's rows in line with the lead its reveal writes", async () => {
    const t = newT()
    const { f, item } = await ledAndRestoring(t)
    // few ranges, so the call stops after the lead's rows, before the reveal
    TRASH_BUDGET.ranges = 40
    await as(t, f.admin).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] })
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_reveal' })
    expect((await rowsOf(t, f.pia.id)).length).toBe(2)
    // a viewer leads nothing, so the reveal writes the project without her
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'profiles', f.pia.id)
      if (row !== null) await ctx.db.patch(row._id, { org_role: 'viewer' })
    })
    await runSteps(t)
    expect((await projectOf(t, f.sub2.id))?.lead_id).toBeUndefined()
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await expectAll(t, f)
  })

  it("counts the bytes of the stored projects its lead's rows read", async () => {
    const t = newT()
    // a legacy icon, stored with the project
    const { f, item } = await ledAndRestoring(t, { icon: 'i'.repeat(900_000) })
    // a call's quarter of a step holds less than the icon
    TRASH_BUDGET.bytes = 2 * 1024 * 1024
    await as(t, f.admin).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] })
    // the lead's rows read the icon, so the call stops before the reveal,
    // where a call that missed the icon's bytes would have revealed
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_reveal' })
    await runSteps(t)
    await expectAll(t, f)
  })

  it('leaves alone a live project that took the id of a project its move dropped', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    // past what a stored row may hold, so the move drops it and frees its id
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'projects', f.sub.id)
      if (row !== null) await ctx.db.patch(row._id, { icon: 'i'.repeat(1_000_100) })
    })
    TRASH_BUDGET.rows = 1
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id: f.meta.id })
    const item = await itemFor(t, f.meta.id)
    // a new sub-project takes the freed id, with a lead whose row stays.
    // withOrg plants its projects without used_ids rows, so the create can
    // take it, as one by a release before used_ids can after a rollback;
    // with the row every create refuses it (the next test)
    await as(t, f.user).mutation(api.projects.create, {
      org_id,
      id: f.sub.id,
      type: 'project',
      parent_id: f.hidden.id,
      key: 'NEWFW',
      name: 'New firmware',
      sort_order: 1,
    })
    TRASH_BUDGET.rows = DEFAULT_ROWS
    for (let steps = 0; (await jobFor(t, item.id)) !== null; steps++) {
      expect(steps).toBeLessThan(50)
      await step(t, item.id)
    }
    expect(await projectOf(t, f.sub.id)).toMatchObject({ parent_id: f.hidden.id })
    expect((await rowsOf(t, f.user.id)).some((row) => row.project_id === f.sub.id)).toBe(true)
    await expectAll(t, f)
  })

  it('refuses every create of the id of a project its move dropped, and drains its grants and tasks', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    // a sub-project made in the app, which records its id in used_ids,
    // with a grant and a task
    const id = uuid()
    const create = (key: string) =>
      as(t, f.user).mutation(api.projects.create, {
        org_id,
        id,
        type: 'project',
        parent_id: f.meta.id,
        key,
        name: 'Big',
        sort_order: 1,
      })
    await create('BIG')
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id,
      id,
      user_id: f.pia.id,
      level: 'user',
    })
    const task = await plantIssue(t, { org_id, project_id: id })
    const grants = () =>
      t.run((ctx) =>
        ctx.db
          .query('project_access')
          .withIndex('by_project_profile', (q) => q.eq('project_id', id))
          .collect(),
      )
    // past what a stored row may hold, so the move drops it
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'projects', id)
      if (row !== null) await ctx.db.patch(row._id, { icon: 'i'.repeat(1_000_100) })
    })
    TRASH_BUDGET.rows = 1
    await as(t, f.user).mutation(api.projects.deleteDeep, { org_id, id })
    const item = await itemFor(t, id)
    expect(await projectOf(t, id)).toBeNull()
    expect(await grants()).toHaveLength(1)
    expect(await t.run((ctx) => byId(ctx, 'issues', task.id))).not.toBeNull()
    // no create takes the id while the move has the grant and the task
    // left: not the app's, nor REST's or MCP's should the server pick it
    const taken = /with this id already exists/
    await expectRefusal(create('AGAIN'), 'bad_request', taken)
    const machine = { callerId: f.admin.id, access: 'write' as const }
    const serverPicks = () =>
      vi
        .spyOn(crypto, 'randomUUID')
        .mockImplementationOnce(() => id as ReturnType<typeof crypto.randomUUID>)
    serverPicks()
    await expectRefusal(
      t.mutation(internal.machine.projects.restCreateProject, {
        ...machine,
        keyName: null,
        body: JSON.stringify({ name: 'Again' }),
      }),
      'bad_request',
      taken,
    )
    serverPicks()
    await expectRefusal(
      t.mutation(internal.machine.projects.mcpCreateProject, { ...machine, name: 'Again' }),
      'bad_request',
      taken,
    )
    vi.restoreAllMocks()
    expect(await projectOf(t, id)).toBeNull()
    TRASH_BUDGET.rows = DEFAULT_ROWS
    for (let steps = 0; (await jobFor(t, item.id)) !== null; steps++) {
      expect(steps).toBeLessThan(50)
      await step(t, item.id)
    }
    // the move took the grant and the task, and no row is left on the id
    expect(await grants()).toEqual([])
    expect(await t.run((ctx) => byId(ctx, 'issues', task.id))).toBeNull()
    expect((await reachRows(t)).filter((row) => row.project_id === id)).toEqual([])
    await expectAll(t, f)
    // the item keeps the project's history until a purge, which takes it
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id, ids: [item.id] })
    await runSteps(t)
    await expectAll(t, f)
    await assertNoDanglingRefs(t, 'after the purge of a dropped project')
  })
})

describe('fixtures and migrations', () => {
  it("writes the guest fixture's rows, also when it plants them again", async () => {
    const t = newT()
    const zz = () => t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    const { org_id } = await zz()
    expect(await t.run((ctx) => navReady(ctx, org_id))).toBe(true)
    await expectReachExact(t)
    await expectReachMatchesAccess(t, org_id)
    expect((await zz()).torn_down).toBe(true)
    await expectReachExact(t)
  })

  it('keeps the rows of a project whose name the over-cap fix cuts', async () => {
    const t = newT()
    const f = await ready(t)
    // 80 code points that are 81 UTF-16 units, a name valid before names
    // counted units
    const long = `${'n'.repeat(79)}😀`
    await t.run(async (ctx) => {
      const row = await byId(ctx, 'projects', f.meta.id)
      if (row !== null) await ctx.db.patch(row._id, { name: long, name_key: nameKey(long) })
    })
    await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    expect((await projectOf(t, f.meta.id))?.name).not.toBe(long)
    await expectAll(t, f)
  })

  it('leaves for a later run the project names whose reach rows a page has no room for', async () => {
    const t = newT()
    const f = await ready(t)
    const long = `${'n'.repeat(79)}😀`
    // two long names on one page whose rows fit one budget alone, and a
    // third with more rows than any change may update
    const [a, b, c] = [f.meta.id, f.hidden.id, f.otherProject.id]
    const sizes = { [a]: 1_200, [b]: 1_200, [c]: LIMITS.projectTreeChange.max }
    for (const id of [a, b, c]) {
      const project = (await projectOf(t, id))!
      await t.run(async (ctx) => {
        await ctx.db.patch(project._id, { name: long, name_key: nameKey(long) })
        const have = (
          await ctx.db
            .query('project_reach')
            .withIndex('by_project_grantee', (q) => q.eq('project_id', id))
            .collect()
        ).length
        for (let i = have; i < sizes[id]; i++)
          await ctx.db.insert('project_reach', {
            org_id: project.org_id,
            grantee_kind: 'profile',
            grantee_id: uuid(),
            kind: 'root',
            project_id: id,
            root_id: id,
            name_key: nameKey(long),
            key: project.key,
            live: true,
            on_root: false,
          })
      })
    }
    const outcomes = (got: {
      rows: { table: string; id: string; field: string; outcome: string }[]
    }) =>
      Object.fromEntries(
        got.rows
          .filter((row) => row.table === 'projects' && row.field === 'name')
          .map((row) => [row.id, row.outcome]),
      )
    const ids = async () =>
      Object.fromEntries(
        await Promise.all([a, b, c].map(async (id) => [(await projectOf(t, id))!._id, id])),
      ) as Record<string, string>
    const byDoc = await ids()
    const run = async () => {
      const got = outcomes(await t.action(internal.internal.overCapRows.fix, { dry_run: false }))
      return Object.fromEntries(Object.entries(got).map(([doc, o]) => [byDoc[doc], o]))
    }
    // the fix answers instead of throwing; the first name fits the page,
    // the others wait for a run with room
    expect(await run()).toEqual({ [a]: 'fixed', [b]: 'skipped', [c]: 'skipped' })
    expect(await run()).toEqual({ [b]: 'fixed', [c]: 'skipped' })
    // first on a page of its own, and still too many rows
    expect(await run()).toEqual({ [c]: 'reported' })
    expect((await projectOf(t, c))?.name).toBe(long)
    for (const id of [a, b]) {
      const project = (await projectOf(t, id))!
      expect(project.name).not.toBe(long)
      const rows = (await reachRows(t)).filter((row) => row.project_id === id)
      expect(new Set(rows.map((row) => row.name_key))).toEqual(new Set([nameKey(project.name)]))
    }
  }, 120_000)
})

describe('the over-cap fix and its page budget', () => {
  const long = `${'n'.repeat(79)}😀`

  /** A project with a name over NAME_MAX and `rows` reach rows. */
  async function longNamed(t: T, org_id: string, rows: number): Promise<Doc<'projects'>> {
    const project = await plantProject(t, { org_id, name: long })
    await t.run(async (ctx) => {
      for (let n = 0; n < rows; n++)
        await ctx.db.insert('project_reach', {
          org_id,
          grantee_kind: 'profile',
          grantee_id: uuid(),
          kind: 'root',
          project_id: project.id,
          root_id: project.id,
          name_key: nameKey(long),
          key: project.key,
          live: true,
          on_root: false,
        })
    })
    return project
  }

  /** A run of the fix, answering the outcome of each project's name, or
   * undefined for a name it no longer finds. */
  const fixRun = (t: T, projects: Doc<'projects'>[]) => async () => {
    const got = await t.action(internal.internal.overCapRows.fix, { dry_run: false })
    return projects.map(
      (p) =>
        got.rows.find((row) => row.table === 'projects' && row.id === p._id && row.field === 'name')
          ?.outcome,
    )
  }

  it('charges the reach rows of a name it skips and defers the rest without a read', async () => {
    // a page that read each skipped name's rows again would read more
    // than this
    const t = newT({ transactionLimits: { documentsRead: 4_500 } })
    const f = await withOrg(t)
    const projects: Doc<'projects'>[] = []
    for (let i = 0; i < 6; i++) projects.push(await longNamed(t, f.org.id, 1_500))
    const run = fixRun(t, projects)
    // one name a run fits; the next reads what is left and waits, the
    // others wait without a read
    const waiting = Array(4).fill('skipped')
    expect(await run()).toEqual(['fixed', 'skipped', ...waiting])
    expect(await run()).toEqual([undefined, 'fixed', ...waiting])
    for (let i = 0; i < 4; i++) await run()
    for (const p of projects) {
      const after = (await projectOf(t, p.id))!
      expect(after.name).not.toBe(long)
      const keys = await t.run(async (ctx) =>
        (
          await ctx.db
            .query('project_reach')
            .withIndex('by_project_grantee', (q) => q.eq('project_id', p.id))
            .collect()
        ).map((row) => row.name_key),
      )
      expect(new Set(keys)).toEqual(new Set([nameKey(after.name)]))
    }
  }, 120_000)

  it('fixes the names after one a person must shorten, and reads four of those a page', async () => {
    // a page that read a fifth such name would read more than this
    const t = newT({ transactionLimits: { documentsRead: 9_500 } })
    const f = await withOrg(t)
    const max = LIMITS.projectTreeChange.max
    const projects: Doc<'projects'>[] = []
    for (const rows of [max, 100, 100, max, max, max, max, 100])
      projects.push(await longNamed(t, f.org.id, rows))
    const run = fixRun(t, projects)
    // each name's outcome, or none once it is fixed or shortened
    const [R, F, S, N] = ['reported', 'fixed', 'skipped', undefined]
    // the first name has more rows than one change may update, and the two
    // after it still fit; the fourth reads what is left and waits
    expect(await run()).toEqual([R, F, F, S, S, S, S, S])
    // four such names a page, and the names after them wait
    expect(await run()).toEqual([R, N, N, R, R, R, S, S])
    // until a person shortens two of them
    await t.run(async (ctx) => {
      for (const p of [projects[0], projects[3]])
        await ctx.db.patch(p._id, { name: 'Shortened', name_key: nameKey('Shortened') })
    })
    expect(await run()).toEqual([N, N, N, N, R, R, R, F])
  }, 120_000)
})

describe('teardowns', () => {
  it('deletes a deleted team’s rows, and counts them against the deletion', async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    const admin = as(t, f.admin)
    // a second team, so the first is not the last
    await admin.mutation(api.teams.create, { org_id, id: uuid(), name: 'Other team' })
    await admin.mutation(api.projects.setAccess, {
      org_id,
      id: f.sub.id,
      team_id: f.team.id,
      level: 'user',
    })
    // 2 memberships, 1 share and 2 rows, then planted rows up to the max
    await t.run(async (ctx) => {
      for (let i = 0; i < LIMITS.teamDeleteRows.max - 4; i++)
        await ctx.db.insert('project_reach', {
          org_id,
          grantee_kind: 'team',
          grantee_id: f.team.id,
          kind: 'child',
          project_id: uuid(),
          root_id: f.meta.id,
          name_key: 'x',
          key: 'X',
          live: true,
          on_root: false,
        })
    })
    await expectRefusal(
      admin.mutation(api.teams.deleteDeep, { org_id, id: f.team.id, on_held_tasks: 'leave' }),
      'rule',
      /at most 3,000 of its memberships, project shares and access entries/,
    )
    await t.run(async (ctx) => {
      const one = await ctx.db
        .query('project_reach')
        .withIndex('by_grantee_list', (q) =>
          q.eq('grantee_kind', 'team').eq('grantee_id', f.team.id).eq('kind', 'child'),
        )
        .first()
      if (one !== null) await ctx.db.delete(one._id)
    })
    await admin.mutation(api.teams.deleteDeep, { org_id, id: f.team.id, on_held_tasks: 'leave' })
    expect(await rowsOf(t, f.team.id)).toEqual([])
    await expectAll(t, f)
  }, 120_000)

  it("deletes a removed person's rows, the rest in the background steps", async () => {
    const t = newT()
    const f = await ready(t)
    const org_id = f.org.id
    for (const id of [f.meta.id, f.hidden.id])
      await as(t, f.admin).mutation(api.projects.setAccess, {
        org_id,
        id,
        user_id: f.pia.id,
        level: 'user',
      })
    ACCESS_FIRST_PASS.rows = 1
    await as(t, f.admin).mutation(api.profiles.remove, { org_id, id: f.pia.id })
    expect((await rowsOf(t, f.pia.id)).length).toBeGreaterThan(0)
    await runSteps(t)
    expect(await rowsOf(t, f.pia.id)).toEqual([])
    await expectAll(t, f)
  })

  it('deletes an organization’s rows with it, in one transaction or in steps', async () => {
    const t = newT()
    const f = await ready(t)
    await t.run(async (ctx) => {
      const org = await byId(ctx, 'organizations', f.org.id)
      if (org !== null) await deleteOrgDeep(ctx, org)
    })
    expect((await reachRows(t)).filter((row) => row.org_id === f.org.id)).toEqual([])
    await expectReachExact(t)
  })

  it('deletes them in the projects phase of a deletion in steps, before the projects', async () => {
    const t = newT()
    const f = await ready(t)
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.sub.id,
      team_id: f.team.id,
      level: 'user',
    })
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        created_at: NOW,
        phase: 'profiles',
      }),
    )
    // a few rows a step, so the phases spread over many steps
    REMOVAL_BUDGET.rows = 3
    let steps = 0
    for (;;) {
      const done = await t.run(async (ctx) => {
        const removal = await ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        return removal === null ? true : await deleteOrgStep(ctx, removal)
      })
      // no step leaves a row of a person whose id it freed
      const orphans = await t.run(async (ctx) => {
        const out: string[] = []
        for (const row of await ctx.db.query('project_reach').collect())
          if (
            row.grantee_kind === 'profile' &&
            (await byId(ctx, 'profiles', row.grantee_id)) === null
          )
            out.push(row.grantee_id)
        return out
      })
      expect(orphans).toEqual([])
      if (done) break
      expect(++steps).toBeLessThan(400)
    }
    expect(await t.run((ctx) => byId(ctx, 'organizations', f.org.id))).toBeNull()
    expect((await reachRows(t)).filter((row) => row.org_id === f.org.id)).toEqual([])
    await expectReachExact(t)
  })
})

describe('the backfill', () => {
  it('reports what an organization from before this release lacks, writes it and stamps it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const dry = await backfill(t, true)
    // the five projects of the two organizations, each without a state;
    // the product lead's, the guest's and the viewer's root rows, and the
    // hidden project lead's
    expect(dry).toMatchObject({
      archive_state: { missing: 5, stale: 0 },
      done: true,
      unstamped: expect.arrayContaining([f.org.id, f.otherOrg.id]),
    })
    expect(dry.reach.missing).toBeGreaterThanOrEqual(4)
    expect(await reachRows(t)).toEqual([])
    const run = await backfill(t, false)
    expect(run).toMatchObject({ done: true, stamped: 2 })
    await expectAll(t, f)
    expect(await states(t, [f.meta.id, f.sub.id, f.hidden.id])).toEqual(['live', 'live', 'live'])
    const ready = await t.run((ctx) =>
      ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique(),
    )
    expect(ready?.nav_at).toBeDefined()
    // name-ordered lists need the name keys as well
    expect(await t.run((ctx) => navReady(ctx, f.org.id))).toBe(false)
    await t.action(internal.internal.nameKeysBackfill.run, { dry_run: false })
    expect(await t.run((ctx) => navReady(ctx, f.org.id))).toBe(true)
    expect(await backfill(t, true)).toMatchObject({
      archive_state: { missing: 0, stale: 0 },
      reach: { missing: 0, extra: 0, stale: 0 },
      to_fix: [],
      unstamped: [],
    })
  })

  it('finds and mends what an earlier release leaves after a rollback', async () => {
    const t = newT()
    const f = await ready(t)
    const ole = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Ole Berg',
      email: 'ole@testbed.test',
    })
    await t.run(async (ctx) => {
      const patch = async (id: string, fields: Partial<Doc<'projects'>>) => {
        const row = await byId(ctx, 'projects', id)
        if (row !== null) await ctx.db.patch(row._id, fields)
      }
      // a rename and an archive without their copies, a grant without its
      // rows, a removed grant that left its rows, and a row of nothing
      await patch(f.meta.id, { name: 'Renamed meanwhile' })
      await patch(f.hidden.id, { archived_at: NOW })
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: ole.id,
        level: 'user',
      })
      const guest = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (guest !== null) await ctx.db.delete(guest._id)
      await ctx.db.insert('project_reach', {
        org_id: f.org.id,
        grantee_kind: 'team',
        grantee_id: f.team.id,
        kind: 'root',
        project_id: f.hidden.id,
        root_id: f.hidden.id,
        name_key: 'skunkworks',
        key: f.hidden.key,
        live: true,
        on_root: true,
      })
    })
    const dry = await backfill(t, true)
    expect(dry.archive_state).toEqual({ missing: 0, stale: 1 })
    expect(dry.reach.missing).toBeGreaterThanOrEqual(2)
    expect(dry.reach.extra).toBeGreaterThanOrEqual(2)
    expect(dry.reach.stale).toBeGreaterThanOrEqual(2)
    expect(dry.to_fix).toEqual([f.org.id])
    await backfill(t, false)
    await expectAll(t, f)
    expect((await projectOf(t, f.hidden.id))?.archive_state).toBe('listed')
  })

  it('goes on from its cursor one row and one stamp a call while writers change the rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    NAV_STEP.rows = 1
    // every call is past its time after its first step
    RUN.ms = 0
    let cursor: Cursor
    let calls = 0
    const stamping: string[] = []
    for (;;) {
      const got = await backfill(t, false, cursor)
      calls++
      if (got.cursor?.table === 'organizations' && got.cursor.after !== null)
        stamping.push(got.cursor.after)
      // a writer between two calls
      if (calls === 3)
        await as(t, f.admin).mutation(api.projects.setAccess, {
          org_id: f.org.id,
          id: f.sub2.id,
          user_id: f.agent.id,
          level: 'user',
        })
      if (got.done) break
      cursor = got.cursor ?? undefined
      expect(calls).toBeLessThan(200)
    }
    expect(calls).toBeGreaterThan(10)
    // the stamping stopped between the two organizations
    expect(stamping).toEqual([[f.org.id, f.otherOrg.id].sort()[0]])
    await expectAll(t, f)
    expect(await expectedReach(t)).toEqual(await reachRows(t))
    expect((await audits(t)).length).toBe(calls)
  })

  it('records what committed when a step throws, and goes on from that step', async () => {
    // withOrg writes 20 documents in one transaction
    const t = newT({ transactionLimits: { documentsWritten: 20 } })
    const f = await withOrg(t)
    // 24 grants on the product, whose rows one step writes at once
    const people: string[] = []
    for (let i = 0; i < 24; i++)
      people.push(
        (await plantSeat(t, { org_id: f.org.id, name: `P${i}`, email: `p${i}@testbed.test` })).id,
      )
    for (const half of [people.slice(0, 12), people.slice(12)])
      await t.run(async (ctx) => {
        for (const id of half)
          await ctx.db.insert('project_access', {
            project_id: f.meta.id,
            profile_id: id,
            level: 'user',
          })
      })
    const failed = await backfill(t, false)
    expect(failed).toMatchObject({
      done: false,
      error: expect.any(String),
      cursor: { dry_run: false, table: 'project_access' },
    })
    expect(await audits(t)).toEqual([
      {
        stamped: 0,
        archive_states: failed.archive_state.missing,
        reach_missing: failed.reach.missing,
        reach_extra: 0,
        reach_stale: 0,
        done: false,
        cursor: failed.cursor,
        error: failed.error,
      },
    ])
    // the projects committed, the grants' step did not, and no organization
    // is stamped while its rows are missing
    expect((await projectOf(t, f.meta.id))?.archive_state).toBe('live')
    expect(await rowsOf(t, people[0])).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('org_ready').collect())).toEqual([])
    // smaller steps fit
    NAV_STEP.rows = 5
    let last = await backfill(t, false, failed.cursor ?? undefined)
    while (!last.done) last = await backfill(t, false, last.cursor ?? undefined)
    expect(last.error).toBeUndefined()
    await expectAll(t, f)
  })

  it("refuses to resume a run that writes from a dry run's cursor", async () => {
    const t = newT()
    await withOrg(t)
    RUN.ms = 0
    const first = await backfill(t, true)
    expect(first.cursor).toMatchObject({ dry_run: true })
    await expect(backfill(t, false, first.cursor ?? undefined)).rejects.toThrow('other dry_run')
  })

  it('walks projects with icons near 1 MiB inside the limits of a transaction', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // legacy icons, each project a document near Convex's 1 MiB, without
    // an archive state, so every row walked is patched and read again
    for (let i = 0; i < 12; i++)
      await plantProject(t, { org_id: f.org.id, lead_id: f.user.id, icon: 'i'.repeat(1_020_000) })
    let got = await backfill(t, false)
    for (let calls = 0; !got.done; calls++) {
      expect(got.error).toBeUndefined()
      expect(calls).toBeLessThan(20)
      got = await backfill(t, false, got.cursor ?? undefined)
    }
    expect(got.error).toBeUndefined()
    await expectAll(t, f)
  }, 120_000)

  it('stamps an organization created since this release at its creation', async () => {
    const t = newT()
    const orgId = uuid()
    await t.run((ctx) =>
      insertOrgRows(ctx, { id: orgId, name: 'Fresh', slug: 'fresh', ...newOrgDefaults(NOW) }),
    )
    expect(await t.run((ctx) => navReady(ctx, orgId))).toBe(true)
  })
})
