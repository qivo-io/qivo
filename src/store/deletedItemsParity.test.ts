/* The Deleted items stand-in (store/deletedItemsStandIn.setup.ts), which
 * the page's jsdom tests and the browser benchmark read, held to the real
 * reads (convex/deletedItems.ts page, item, roles and people) on the trash
 * fixture of the server's suites (convex/tests/trash.setup.ts). The
 * organization's tasks are deleted through the real mutations, as an
 * admin, a guest who holds a grant on the top-level project and an agent
 * through a personal token: one task item with a subtask, one sub-project
 * item with its tasks, one task item deleted before its sub-project, which
 * only the admin sees, hidden, and one item whose deleter is gone. The
 * stand-in's fixture is built from what the server stored and from each
 * viewer's own rows, deletedItems.item over every stored item. For an
 * admin, the project's lead and a member, every shape walks both page by
 * page with limit 5 to the end and compares the entries, the rows and the
 * notes; roles and the first people batches compare too, and for the
 * admin the same again once the sub-project is back, restored by the
 * server and by the stand-in. Everyday values: a handful of items, no
 * figure at its design size. */
/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { canLeadProjects } from '../../convex/lib/access'
import { byId } from '../../convex/lib/db'
import { sightOf } from '../../convex/model/deletedItems'
import type { DeletedPage, PageArgs } from '../../convex/model/deletedItemsPage'
import type { DeletedRow } from '../../convex/model/deletedItemsRows'
import {
  as,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withReadingAdmin,
} from '../../convex/tests/helpers.setup'
import { keyOrg } from '../../convex/tests/nameKeys.setup'
import { installTrashTimers, itemFor, runSteps } from '../../convex/tests/trash.setup'
import {
  type DeletedFixture,
  deletedItemOf,
  deletedPageOf,
  deletedPeopleOf,
  deletedRestore,
  deletedRolesOf,
  type ProjectBack,
  waitingBlock,
} from './deletedItemsStandIn.setup'

vi.hoisted(() => {
  // the page's cursors are sealed with a key derived from it
  process.env.BETTER_AUTH_SECRET ??= 'deleted-items-parity-secret-not-a-deployment-key'
})

installTrashTimers()

const later = () => vi.setSystemTime(Date.now() + 60_000)

/** The trash fixture with its deletes: what each test reads. With
    `archived`, Board rev is archived before it is deleted. */
async function world(o: { archived?: boolean } = {}) {
  const t = newT()
  const f = await withReadingAdmin(t)
  const org_id = f.org.id
  // the people batches read the name keys
  await keyOrg(t, org_id)
  const task = (project: Doc<'projects'>, title: string, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id, project_id: project.id, title, ...extra })
  const flash = await task(f.sub, 'Flash the bootloader', { assignee_id: f.guest.id })
  const order = await task(f.sub, 'Order sensor housings', {
    assignee_id: f.user.id,
    description: 'Ask the supplier for the chamber quote',
  })
  const calibrate = await task(f.sub, 'Calibrate the humidity sensor')
  const log = await task(f.sub, 'Log chamber readings', { parent_id: calibrate.id })
  const notes = await task(f.sub, 'Write release notes')
  await task(f.sub2, 'Route the power plane', { assignee_id: f.user.id })
  await task(f.sub2, 'Check antenna clearance')
  // the only deleted task of the viewer's
  const solder = await task(f.sub2, 'Solder the test points', { assignee_id: f.viewer.id })
  const del = (who: Doc<'profiles'>, id: string, subtask_ids?: string[]) =>
    as(t, who).mutation(api.issues.deleteDeep, {
      org_id,
      id,
      ...(subtask_ids ? { subtask_ids } : {}),
    })
  await del(f.admin, flash.id)
  later()
  await del(f.guest, order.id)
  later()
  await del(f.admin, calibrate.id, [log.id])
  later()
  await del(f.admin, solder.id)
  later()
  if (o.archived) await as(t, f.user).mutation(api.projects.archive, { org_id, id: f.sub2.id })
  await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id, id: f.sub2.id })
  later()
  await del(f.admin, notes.id)
  await runSteps(t)
  // the agent deleted the bootloader through a personal token, and the
  // person who deleted the release notes has left (Someone)
  const viaToken = await itemFor(t, flash.id)
  const gone = await itemFor(t, notes.id)
  await t.run(async (ctx) => {
    await ctx.db.patch(viaToken._id, {
      deleted_by: f.agent.id,
      via: { table: 'mcp_tokens', id: uuid(), name: 'Cursor' },
    })
    await ctx.db.patch(gone._id, { deleted_by: uuid() })
  })
  return { t, f, log, solder }
}

/** The stand-in's fixture for `who`, from what the server stored and the
    rows deletedItems.item gives them for every stored item, the rows the
    page builds its entries with. */
async function fixtureFor(t: T, f: OrgFixture, who: Doc<'profiles'>): Promise<DeletedFixture> {
  const stored = await t.run((ctx) => ctx.db.query('deleted_items').collect())
  const rows = []
  for (const d of stored) {
    const row = await as(t, who).query(api.deletedItems.item, { id: d.id })
    if (row !== null) rows.push(row)
  }
  const { docs, tasks, profiles, seen } = await t.run(async (ctx) => {
    const sight = await sightOf(ctx, who)
    return {
      docs: await ctx.db.query('deleted_items').collect(),
      tasks: await ctx.db.query('deleted_tasks').collect(),
      profiles: await ctx.db.query('profiles').collect(),
      seen: [...sight.projects.values()].filter((p) => sight.levels.levelOf(p) !== null),
    }
  })
  const admin = who.org_role === 'admin'
  const leads = seen.some((p) => p.lead_id === who.id)
  const byId = new Map(docs.map((d) => [d.id, d]))
  return {
    seats: [
      {
        org_id: who.org_id,
        org_name: f.org.name,
        me: who.id,
        role: admin ? 'admin' : leads ? 'lead' : 'user',
        can_purge: admin,
      },
    ],
    items: rows.map((row) => {
      const doc = byId.get(row.id)
      if (doc === undefined) throw new Error(`no stored item ${row.id}`)
      const deleter = profiles.find((p) => p.id === doc.deleted_by)
      const names = doc.via !== undefined && (admin || doc.deleted_by === who.id)
      return {
        // a hidden row keeps the item's title, status and reason, which the
        // stand-in leaves out while it is hidden
        row:
          row.hidden === true
            ? {
                ...row,
                title: doc.name,
                ...(doc.status === undefined ? {} : { status: doc.status }),
                ...(doc.reason === undefined ? {} : { reason: doc.reason }),
              }
            : row,
        order: doc._creationTime,
        ...(deleter ? { deleted_by: deleter.id } : {}),
        how:
          doc.via === undefined
            ? 'app'
            : names || doc.via.table === 'agent_keys'
              ? `${doc.via.table}:${doc.via.id}`
              : doc.via.table,
        scope: admin
          ? [doc.project_id, doc.parent_project_id ?? '', ...doc.projects.map((p) => p.id)]
          : row.projects.map((p) => p.id),
        ...(doc.kind === 'project' && doc.parent_project_id
          ? { parent: doc.parent_project_id }
          : {}),
        tasks: tasks
          .filter((x) => x.item_id === doc.id)
          .map((x) => {
            const head = `${x.title}\n`
            const text = x.search_text ?? x.title
            const project = doc.projects.find((p) => p.id === x.project_id)
            return {
              num: x.num,
              title: x.title,
              description: text.startsWith(head) ? text.slice(head.length) : '',
              project_id: x.project_id,
              ...(x.assignee_id ? { assignee_id: x.assignee_id } : {}),
              archived: x.archived,
              path:
                doc.kind === 'project'
                  ? [
                      x.project_id === doc.target_id ? (row.path[0] ?? '') : doc.name,
                      project?.name ?? '',
                    ]
                  : row.path,
            }
          }),
      }
    }),
    projects: seen.map((p) => ({
      id: p.id,
      org_id: p.org_id,
      ...(p.parent_id === undefined ? {} : { parent_id: p.parent_id }),
    })),
    people: profiles
      .filter((p) => p.org_id === who.org_id)
      .map((p) => ({
        org_id: p.org_id,
        id: p.id,
        name: p.name,
        org_role: p.org_role,
        kind: p.kind,
        active: p.active,
        pending: p.kind === 'person' && !p.auth_user_id,
        you: false,
      })),
  }
}

/** How `who` holds each project of project item `row` now that the
    server's restore brought it back (ProjectBack), as the server says: the
    level its sight gives them, whether it came back archived, and the lead
    a view-only block names (model/deletedItems.ts blockDetail). */
function backFrom(t: T, who: Doc<'profiles'>, row: DeletedRow): Promise<ProjectBack[]> {
  return t.run(async (ctx) => {
    const sight = await sightOf(ctx, who)
    const back: ProjectBack[] = []
    for (const entry of row.projects) {
      const p = await byId(ctx, 'projects', entry.id)
      if (p === null) throw new Error(`${entry.name} is not back`)
      const level = sight.levels.levelOf(p)
      const top = p.parent_id === undefined ? null : await byId(ctx, 'projects', p.parent_id)
      const leadId = p.lead_id ?? top?.lead_id
      const lead = leadId === undefined ? null : await byId(ctx, 'profiles', leadId)
      back.push({
        id: p.id,
        name: p.name,
        ...(p.parent_id === undefined ? {} : { parent_id: p.parent_id }),
        level: level === null ? 'none' : level === 'viewer' ? 'viewer' : 'edit',
        archived: p.archived_at !== undefined,
        ...(lead !== null && canLeadProjects(lead) ? { lead: lead.name } : {}),
      })
    }
    return back
  })
}

/** Every page of `args` from both, limit 5, to the end. */
async function both(t: T, who: Doc<'profiles'>, fx: DeletedFixture, args: PageArgs) {
  const walk = async (read: (a: PageArgs) => Promise<DeletedPage> | DeletedPage) => {
    const pages: DeletedPage[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const page = await read({ ...args, limit: 5, ...(cursor === undefined ? {} : { cursor }) })
      pages.push(page)
      if (page.next_cursor === null) break
      cursor = page.next_cursor
    }
    return pages.map(({ next_cursor, ...rest }) => ({ ...rest, more: next_cursor !== null }))
  }
  const real = await walk((a) => as(t, who).query(api.deletedItems.page, a))
  const stand = await walk((a) => deletedPageOf(fx, a))
  return { real, stand }
}

describe('the Deleted items stand-in against the real reads', () => {
  it('answers each shape of the page as the server does, for an admin, the lead and a member', async () => {
    const { t, f, log, solder } = await world()
    const org_id = f.org.id
    const shapes: PageArgs[] = [
      {},
      { kind: 'project' },
      { scope: { org_id, all: true } },
      { scope: { org_id, project_ids: [f.meta.id] } },
      { scope: { org_id, project_ids: [f.sub.id] } },
      { scope: { org_id, all: true }, kind: 'task' },
      { scope: { org_id, all: true }, search: 'sensor' },
      { scope: { org_id, all: true }, search: 'chamber' },
      { scope: { org_id, all: true }, search: 'anten' },
      { search: 'board' },
      { search: `QN-${log.num}` },
      { scope: { org_id, all: true }, deleted_by: f.admin.id },
      { scope: { org_id, all: true }, deleted_by: f.agent.id, via: 'mcp_tokens' },
      { scope: { org_id, all: true }, deleted_by: f.admin.id, via: 'app' },
      { scope: { org_id, all: true }, someone: true },
      { scope: { org_id, all: true }, assignee: f.user.id },
      { scope: { org_id, project_ids: [f.meta.id] }, assignee: f.guest.id },
      { scope: { org_id, all: true }, search: 'solder' },
      { search: `QN-${solder.num}` },
      { scope: { org_id, all: true }, assignee: f.viewer.id },
    ]
    // what the admin's pages held, so no shape compares two empty answers
    const held = new Map<number, { entries: number; hits: string[]; notes: string[] }>()
    for (const who of [f.admin, f.user, f.guest]) {
      const fx = await fixtureFor(t, f, who)
      for (const [i, args] of shapes.entries()) {
        const { real, stand } = await both(t, who, fx, args)
        expect(stand, `${who.name} ${JSON.stringify(args)}`).toEqual(real)
        if (who === f.admin)
          held.set(i, {
            entries: real.reduce((n, p) => n + p.entries.length, 0),
            hits: real.flatMap((p) => p.entries.flatMap((e) => (e.task ? [e.task.title] : []))),
            notes: real.flatMap((p) =>
              (['scope_needed', 'missing'] as const).filter((k) => k in p),
            ),
          })
      }
    }
    // without a scope, the sub-project item and the scope note
    expect(held.get(0)).toMatchObject({ entries: 1, notes: ['scope_needed'] })
    // All projects: the sub-project item, then the five task items, the one
    // deleted before its sub-project among them
    expect(held.get(2)?.entries).toBe(6)
    // a subtask's word finds its task item with the subtask as its hit
    expect(held.get(7)?.hits).toEqual(['Log chamber readings'])
    // a task's word inside the deleted sub-project is an entry of its own
    expect(held.get(8)?.hits).toEqual(['Check antenna clearance'])
    expect(held.get(10)?.hits).toEqual(['Log chamber readings'])
    expect(held.get(12)?.entries).toBe(1)
    expect(held.get(14)?.entries).toBe(1)
    // a task item and a task inside the sub-project item
    expect(held.get(15)?.entries).toBe(2)
    // the hidden item's tasks are not the admin's to read
    expect(held.get(17)?.entries).toBe(0)
    expect(held.get(18)?.entries).toBe(0)
    expect(held.get(19)?.entries).toBe(0)
  })

  it('holds the roles and the people of both filters to the server’s', async () => {
    const { t, f } = await world()
    for (const who of [f.admin, f.user, f.guest]) {
      const fx = await fixtureFor(t, f, who)
      expect(deletedRolesOf(fx), who.name).toEqual(
        await as(t, who).query(api.deletedItems.roles, {}),
      )
      for (const of of ['deleters', 'assignees'] as const)
        for (const search of [undefined, 'us', 'relay', 'viewer']) {
          const args = { org_id: f.org.id, of, ...(search === undefined ? {} : { search }) }
          expect(deletedPeopleOf(fx, args), `${who.name} ${of} ${search}`).toEqual(
            await as(t, who).query(api.deletedItems.people, args),
          )
        }
    }
  })

  /* What the admin holds on Board rev once it is back decides how the task
     deleted before it shows: their grant on Testbed, which a restore does
     not touch, gives them Edit, Viewer or nothing there, and an archived
     Board rev comes back archived. */
  it.each([
    { name: 'Edit', grant: 'user', archived: false, row: { can_restore: true }, listed: true },
    {
      name: 'Viewer only',
      grant: 'viewer',
      archived: false,
      row: { can_restore: false, blocked: { reason: 'view_only' } },
      listed: true,
    },
    {
      name: 'no access',
      grant: null,
      archived: false,
      row: { hidden: true, can_restore: false, blocked: { reason: 'no_access' } },
      listed: false,
    },
    {
      name: 'Edit on a sub-project that comes back archived',
      grant: 'user',
      archived: true,
      row: { can_restore: false, blocked: { reason: 'project_archived' } },
      listed: true,
    },
  ] as const)(
    'shows the admin a task deleted before its sub-project as the server does once the sub-project is back, with $name',
    async (o) => {
      const { t, f, solder } = await world({ archived: o.archived })
      const org_id = f.org.id
      const admin = f.admin
      await t.run(async (ctx) => {
        const grant = await ctx.db
          .query('project_access')
          .withIndex('by_project_profile', (q) =>
            q.eq('project_id', f.meta.id).eq('profile_id', admin.id),
          )
          .unique()
        if (grant === null) throw new Error('the admin holds no grant on Testbed')
        if (o.grant === null) await ctx.db.delete(grant._id)
        else await ctx.db.patch(grant._id, { level: o.grant })
      })
      // the stand-in's fixture, which its own restore of the sub-project
      // changes, and one rebuilt from what the server holds after its restore
      const stand = await fixtureFor(t, f, admin)
      const project = await itemFor(t, f.sub2.id)
      const hidden = await itemFor(t, solder.id)
      const waiting = stand.items.find((i) => i.row.id === hidden.id)?.row
      expect(waiting).toMatchObject({
        hidden: true,
        can_restore: false,
        blocked: { reason: 'project_deleted', item_id: project.id },
      })
      await as(t, admin).mutation(api.deletedItems.restore, { org_id, ids: [project.id] })
      await runSteps(t)
      const held = stand.items.find((i) => i.row.id === project.id)
      if (held === undefined) throw new Error('no Board rev item')
      held.back = await backFrom(t, admin, held.row)
      // the server's with_project before the restore is the stand-in's
      expect(waiting?.blocked).toEqual(waitingBlock(stand, project.id, f.sub2.id))
      expect(deletedRestore(stand, { org_id, ids: [project.id] }).restored).toEqual([project.id])
      const rebuilt = await fixtureFor(t, f, admin)
      const shapes: PageArgs[] = [
        { scope: { org_id, all: true } },
        { scope: { org_id, all: true }, search: 'solder' },
        { scope: { org_id, all: true }, assignee: f.viewer.id },
        // the sub-project the restore brought back
        { scope: { org_id, project_ids: [f.sub2.id] } },
      ]
      const people = { org_id, of: 'assignees' as const }
      for (const [name, fx] of [
        ['restored by the stand-in', stand],
        ['rebuilt', rebuilt],
      ] as const) {
        for (const args of shapes) {
          const { real, stand: page } = await both(t, admin, fx, args)
          expect(page, `${name} ${JSON.stringify(args)}`).toEqual(real)
        }
        expect(deletedPeopleOf(fx, people), name).toEqual(
          await as(t, admin).query(api.deletedItems.people, people),
        )
        expect(deletedItemOf(fx, hidden.id), name).toEqual(
          await as(t, admin).query(api.deletedItems.item, { id: hidden.id }),
        )
      }
      // the server's own outcome: the row, whether the restored sub-project
      // lists the task, and whether its holder is a choice
      expect(await as(t, admin).query(api.deletedItems.item, { id: hidden.id })).toMatchObject(
        o.row,
      )
      const { real } = await both(t, admin, rebuilt, shapes[3])
      expect(real.flatMap((p) => p.entries.map((e) => e.item_id))).toEqual(
        o.listed ? [hidden.id] : [],
      )
      const choices = (await as(t, admin).query(api.deletedItems.people, people)).rows
      expect(choices.map((p) => p.id).includes(f.viewer.id)).toBe(o.listed)
    },
  )
})
