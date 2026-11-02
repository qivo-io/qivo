/* REST GET /v1/tasks and MCP list_tasks active lists page with a cursor
 * (lib/activeTaskPage.ts): in created_at and number order, merged side by
 * side across the caller's readable projects, within a budget that never
 * follows what the caller cannot read, and with each row's delay from the
 * owner reader (lib/machineDelay.ts pageForecaster). */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ACTIVE_PAGE, TASK_LIST_UNREADABLE } from '../lib/activeTaskPage'
import {
  ARCHIVE_LABELS,
  archiveCursorText,
  cursorAfter,
  scopeCursorText,
} from '../lib/archivedTasks'
import type { Refusal } from '../lib/functions'
import { listCursorText } from '../lib/listCursor'
import { namedCursor } from '../lib/namedPages'
import { ONE_LEVEL_SINCE } from '../lib/viewReads'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'
import { lowered, mcpPage, mcpPages, restPage, restPages } from './taskPages.setup'

type Fx = OrgFixture & { t: T }

/* withOrg, with the agent holding User access on TBED (FW and PCB). */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
  })
  return { t, ...f }
}

/** Expects `p` refused with a bad_request of exactly `sentence`. */
async function refused(p: Promise<unknown>, sentence: string): Promise<void> {
  const e = await expectRefusal(p, 'bad_request')
  expect((e.data as Refusal).message).toBe(sentence)
}

const CURSOR = 'cursor must be the next_cursor of an earlier page'
const ACTIVE_OFFSET = 'offset does not apply to active tasks; pass next_cursor as cursor'

/* An instant `i` minutes after NOW, as a created_at. */
const at = (i: number) => new Date(Date.parse(NOW) + i * 60_000).toISOString()

/* The ids of the active tasks of `projectIds` in list order. */
const listOrder = (fx: Fx, projectIds: readonly string[]) =>
  fx.t.run(async (ctx) => {
    const rows = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
      .collect()
    return rows
      .filter((r) => r.archived_at === undefined && projectIds.includes(r.project_id))
      .sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.num - b.num,
      )
      .map((r) => r.id)
  })

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('order and paging', () => {
  it('concatenated pages hold the list in created_at and number order, on both surfaces', async () => {
    const fx = await setup()
    // created_at out of insertion order, as a restored or seeded task has,
    // ties at one instant, and tasks of both sub-projects interleaved
    for (let i = 0; i < 60; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: i % 2 === 0 ? fx.sub.id : fx.sub2.id,
        title: `Task ${i}`,
        created_at: at(i % 7 === 0 ? 5 : 100 - i),
      })
    }
    // an archived one and one of a project the agent cannot read stay out
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, archived_at: NOW })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.hidden.id })
    const expected = await listOrder(fx, [fx.meta.id, fx.sub.id, fx.sub2.id])
    expect(expected).toHaveLength(60)
    for (const limit of [1, 7, 50, 200]) {
      const rest = await restPages(fx.t, {
        callerId: fx.agent.id,
        access: 'read',
        limit: String(limit),
      })
      expect(ids(rest.rows), `REST limit ${limit}`).toEqual(expected)
      expect(rest.sizes.slice(0, -1).every((n) => n === limit)).toBe(true)
      const mcp = await mcpPages(fx.t, { callerId: fx.agent.id, access: 'read', limit })
      expect(ids(mcp.rows), `MCP limit ${limit}`).toEqual(expected)
    }
  })

  it('pages through 300 tasks created at one instant, 50 a page', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: fx.org.id,
          project_id: i % 3 === 0 ? fx.sub2.id : fx.sub.id,
          num: 50_000 + i,
          title: `Tied ${i}`,
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
      }
    })
    const got = await restPages(fx.t, { callerId: fx.agent.id, access: 'read', limit: '50' })
    expect(got.sizes).toEqual([50, 50, 50, 50, 50, 50])
    expect(ids(got.rows)).toEqual(await listOrder(fx, [fx.sub.id, fx.sub2.id]))
  })

  it('a page after one the filters thinned neither repeats nor skips', async () => {
    const fx = await setup()
    for (let i = 0; i < 30; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        created_at: at(i),
        status: i % 3 === 0 ? 'todo' : 'done',
      })
    }
    const all = await fx.t.run(async (ctx) =>
      (
        await ctx.db
          .query('issues')
          .withIndex('by_project_archived_created', (q) =>
            q.eq('project_id', fx.sub.id).eq('archived_at', undefined),
          )
          .collect()
      )
        .filter((r) => r.status === 'todo')
        .map((r) => r.id),
    )
    const got = await restPages(fx.t, {
      callerId: fx.agent.id,
      access: 'read',
      status: 'todo',
      limit: '3',
    })
    expect(ids(got.rows)).toEqual(all)
    expect(got.sizes).toEqual([3, 3, 3, 1])
  })

  it('ends with a null cursor when the last page is full, and an empty list is one page', async () => {
    const fx = await setup()
    const empty = await restPage(fx.t, { callerId: fx.agent.id, access: 'read' })
    expect(empty).toEqual({ next_cursor: null, tasks: [] })
    for (let i = 0; i < 4; i++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, created_at: at(i) })
    }
    const got = await restPages(fx.t, { callerId: fx.agent.id, access: 'read', limit: '2' })
    expect(got.sizes).toEqual([2, 2])
    expect(got.cursors).toHaveLength(1)
  })
})

describe('cursor and offset', () => {
  it('takes offset 0 or none, and refuses any other with the sentence that says to pass the cursor', async () => {
    const fx = await setup()
    for (let i = 0; i < 3; i++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, created_at: at(i) })
    }
    const base = { callerId: fx.agent.id, access: 'read' as const, limit: '1' }
    const first = await restPage(fx.t, { ...base, offset: '0' })
    expect(first.tasks).toHaveLength(1)
    const second = await restPage(fx.t, {
      ...base,
      offset: '0',
      cursor: first.next_cursor ?? undefined,
    })
    expect(second.tasks[0].id).not.toBe(first.tasks[0].id)
    for (const offset of ['1', '-1', 'abc', '1.5', ' ', '']) {
      await refused(restPage(fx.t, { ...base, offset }), ACTIVE_OFFSET)
    }
    for (const offset of [1, -1, 1000]) {
      await refused(mcpPage(fx.t, { callerId: fx.agent.id, access: 'read', offset }), ACTIVE_OFFSET)
    }
    expect(
      (await mcpPage(fx.t, { callerId: fx.agent.id, access: 'read', offset: 0 })).tasks,
    ).toHaveLength(3)
  })

  it('opens a cursor only for its list, scope, filters, surface, organization and caller', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: fx.meta.id,
        profile_id: fx.user.id,
        level: 'user',
      })
    })
    for (let i = 0; i < 4; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        created_at: at(i),
        title: `alpha ${i}`,
      })
    }
    const base = { callerId: fx.agent.id, access: 'read' as const, limit: '1' }
    const plain = (await restPage(fx.t, base)).next_cursor as string
    const searched = (await restPage(fx.t, { ...base, search: 'alpha' })).next_cursor as string
    const scoped = (await restPage(fx.t, { ...base, project: 'TBED' })).next_cursor as string
    expect([plain, searched, scoped].every((c) => typeof c === 'string')).toBe(true)
    // each opens for itself
    expect((await restPage(fx.t, { ...base, cursor: plain })).tasks).toHaveLength(1)
    expect(
      (await restPage(fx.t, { ...base, search: 'alpha', cursor: searched })).tasks,
    ).toHaveLength(1)
    // the same project named another way is the same scope
    expect((await restPage(fx.t, { ...base, project: 'tbed', cursor: scoped })).tasks).toHaveLength(
      1,
    )
    // another scope, filter or search
    await refused(restPage(fx.t, { ...base, cursor: searched }), CURSOR)
    await refused(restPage(fx.t, { ...base, search: 'alpha', cursor: plain }), CURSOR)
    await refused(restPage(fx.t, { ...base, search: 'alph', cursor: searched }), CURSOR)
    await refused(restPage(fx.t, { ...base, project: 'FW', cursor: scoped }), CURSOR)
    await refused(restPage(fx.t, { ...base, cursor: scoped }), CURSOR)
    await refused(restPage(fx.t, { ...base, status: 'todo', cursor: plain }), CURSOR)
    await refused(restPage(fx.t, { ...base, priority: 'high', cursor: plain }), CURSOR)
    await refused(restPage(fx.t, { ...base, assignee: fx.user.id, cursor: plain }), CURSOR)
    await refused(restPage(fx.t, { ...base, owner: fx.user.id, cursor: plain }), CURSOR)
    // another surface, with the same search
    await refused(
      mcpPage(fx.t, {
        callerId: fx.agent.id,
        access: 'read',
        limit: 1,
        search: 'alpha',
        cursor: searched,
      }),
      CURSOR,
    )
    // another caller, who reads the same tasks
    await refused(restPage(fx.t, { ...base, callerId: fx.user.id, cursor: plain }), CURSOR)
    // a changed cursor, other kinds of cursor and plain text
    const changed = `${plain.slice(0, -2)}${plain.endsWith('00') ? '11' : '00'}`
    const lead = await fx.t.run(async (ctx) => ctx.db.query('issues').first())
    const archived = await archiveCursorText(
      cursorAfter({ ...(lead as Doc<'issues'>), archived_at: NOW }),
      fx.sub.id,
    )
    const app = await scopeCursorText(
      cursorAfter({ ...(lead as Doc<'issues'>), archived_at: NOW }),
      {
        kind: 'all',
        orgId: fx.org.id,
      },
    )
    const labels = await namedCursor('labels.settings', [fx.org.id], { key: 'a', tie: ['x'] })
    const otherList = await listCursorText(
      'tasks.active.mcp',
      [fx.org.id, fx.agent.id, 'all', 'x'],
      {
        key: NOW,
        tie: [1],
      },
    )
    for (const cursor of [changed, archived, app, labels, otherList, 's1~abc', 'abc', '1~1~x']) {
      await refused(restPage(fx.t, { ...base, cursor }), CURSOR)
    }
    // an active cursor sent to an archived list
    await refused(
      restPage(fx.t, { ...base, archived: 'true', project: 'FW', cursor: plain }),
      CURSOR,
    )
  })

  it('refuses a cursor of another organization', async () => {
    const fx = await setup()
    for (let i = 0; i < 2; i++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, created_at: at(i) })
    }
    const cursor = (await restPage(fx.t, { callerId: fx.admin.id, access: 'read', limit: '1' }))
      .next_cursor as string
    await plantIssue(fx.t, { org_id: fx.otherOrg.id, project_id: fx.otherProject.id })
    await plantIssue(fx.t, { org_id: fx.otherOrg.id, project_id: fx.otherProject.id })
    await refused(
      restPage(fx.t, { callerId: fx.otherAdmin.id, access: 'read', limit: '1', cursor }),
      CURSOR,
    )
  })
})

describe('the page budget', () => {
  it('stops a page after looking at ACTIVE_PAGE.tasks tasks, and goes on from there', async () => {
    const fx = await setup()
    for (let i = 0; i < 24; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: i % 2 === 0 ? fx.sub.id : fx.sub2.id,
        created_at: at(i),
        priority: i % 3 === 0 ? 'high' : 'low',
      })
    }
    const high = (await listOrder(fx, [fx.sub.id, fx.sub2.id])).filter((_, i) => i % 3 === 0)
    const args = { callerId: fx.agent.id, access: 'read' as const, priority: 'high', limit: '200' }
    // a filter that leaves out tasks without a read looks at three a page
    const first = await lowered({ page: { tasks: 3 } }, () => restPage(fx.t, args))
    expect(ids(first.tasks)).toEqual(high.slice(0, 1))
    expect(typeof first.next_cursor).toBe('string')
    const got = await lowered({ page: { tasks: 3 } }, () => restPages(fx.t, args))
    expect(ids(got.rows)).toEqual(high)
    expect(got.sizes).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })

  it('stops a page early with a cursor and goes on from it with no gap or repeat', async () => {
    const fx = await setup()
    for (let i = 0; i < 40; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: i % 2 === 0 ? fx.sub.id : fx.sub2.id,
        created_at: at(i),
      })
    }
    const expected = await listOrder(fx, [fx.sub.id, fx.sub2.id])
    // rows of about four reads each, so a page holds a handful
    const got = await lowered({ page: { ranges: ACTIVE_PAGE.delays.ranges + 30 } }, () =>
      restPages(fx.t, { callerId: fx.agent.id, access: 'read', limit: '200' }),
    )
    expect(ids(got.rows)).toEqual(expected)
    expect(got.sizes.length).toBeGreaterThan(3)
    expect(got.sizes.slice(0, -1).every((n) => n > 0 && n < 40)).toBe(true)
  })

  it('refuses a request without room for the whole budget, rather than answer it short', async () => {
    const fx = await setup(newT({ transactionLimits: { databaseQueries: 1000 } }))
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await refused(restPage(fx.t, { callerId: fx.agent.id, access: 'read' }), TASK_LIST_UNREADABLE)
    const fits = await lowered(
      { page: { ranges: 800, delays: { ...ACTIVE_PAGE.delays, ranges: 100 } } },
      () => restPage(fx.t, { callerId: fx.agent.id, access: 'read' }),
    )
    expect(fits.tasks).toHaveLength(1)
  })
})

describe('search', () => {
  it('reads labels by the task once the organization holds more labels than one scan', async () => {
    const fx = await setup()
    const label = {
      id: uuid(),
      org_id: fx.org.id,
      name: 'Firmware bug',
      color: '#ff0000',
      created_at: NOW,
    }
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('labels', { ...label, name_lower: label.name.toLowerCase() })
    })
    const tagged = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      created_at: at(1),
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, created_at: at(2) })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', {
        issue_id: tagged.id,
        label_id: label.id,
        org_id: fx.org.id,
      })
    })
    const search = { callerId: fx.agent.id, access: 'read' as const, search: 'bug' }
    expect(ids((await restPage(fx.t, search)).tasks)).toEqual([tagged.id])
    const scan = ARCHIVE_LABELS.scan
    ARCHIVE_LABELS.scan = 0
    try {
      expect(ids((await restPage(fx.t, search)).tasks)).toEqual([tagged.id])
    } finally {
      ARCHIVE_LABELS.scan = scan
    }
  })
})

describe('visibility', () => {
  it('lists for each caller exactly the active tasks of the projects they can read', async () => {
    const fx = await setup()
    const shelf = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      key: 'SHELF',
      archived_at: NOW,
    })
    const plant = (project_id: string, i: number) =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id, created_at: at(i) })
    // a task older code stored on a top-level project stays listed
    const onMeta = await plant(fx.meta.id, 0)
    const fw = await plant(fx.sub.id, 1)
    const pcb = await plant(fx.sub2.id, 2)
    const skunk = await plant(fx.hidden.id, 3)
    const shelved = await plant(shelf.id, 4)
    await plantIssue(fx.t, { org_id: fx.otherOrg.id, project_id: fx.otherProject.id })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, archived_at: NOW })
    const family = [onMeta.id, fw.id, pcb.id]
    // the user leads TBED and SKNK; the viewer and the guest hold grants on TBED
    const expected: [Doc<'profiles'>, string[]][] = [
      [fx.admin, [...family, skunk.id]],
      [fx.user, [...family, skunk.id]],
      [fx.viewer, family],
      [fx.guest, family],
      [fx.agent, family],
    ]
    for (const [person, rows] of expected) {
      const rest = await restPages(fx.t, { callerId: person.id, access: 'read', limit: '2' })
      expect(ids(rest.rows), person.name).toEqual(rows)
      const mcp = await mcpPages(fx.t, { callerId: person.id, access: 'read', limit: 2 })
      expect(ids(mcp.rows), person.name).toEqual(rows)
    }
    // an archived project's tasks come only when the call names it
    for (const person of [fx.admin, fx.agent, fx.guest]) {
      const named = await restPage(fx.t, { callerId: person.id, access: 'read', project: 'SHELF' })
      expect(ids(named.tasks), person.name).toEqual([shelved.id])
    }
    // the guest cannot name SKNK
    await expectRefusal(
      restPage(fx.t, { callerId: fx.guest.id, access: 'read', project: 'SKNK' }),
      'not_found',
    )
  })

  it("pages the same whatever the caller's hidden projects hold, also where its budget stops them", async () => {
    /* An organization where the agent reads FW, with a parent and subtasks
     * in SKNK, which it cannot read. `heavy` gives those hidden tasks long
     * titles and adds 300 more hidden tasks with long texts; `distinct`
     * gives each of the rows with a hidden parent a parent of its own. */
    const build = async (heavy: boolean, distinct = false) => {
      const fx = await setup()
      const long = '€'.repeat(255)
      const parent = await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.hidden.id,
        title: heavy ? long : 'Hidden parent',
        created_at: at(0),
      })
      for (let i = 0; i < 24; i++) {
        const row = await plantIssue(fx.t, {
          org_id: fx.org.id,
          project_id: fx.sub.id,
          title: `Row ${i}`,
          created_at: at(1 + i),
          ...(i % 6 === 0
            ? {
                parent_id: distinct
                  ? (
                      await plantIssue(fx.t, {
                        org_id: fx.org.id,
                        project_id: fx.hidden.id,
                        title: `Hidden parent ${i}`,
                        created_at: at(0),
                      })
                    ).id
                  : parent.id,
              }
            : {}),
        })
        // a subtask stored in a project the agent cannot read, as before
        // the family rule
        if (i % 4 === 1)
          await plantIssue(fx.t, {
            org_id: fx.org.id,
            project_id: fx.hidden.id,
            parent_id: row.id,
            title: heavy ? long : 'Hidden subtask',
            created_at: at(100 + i),
          })
      }
      if (heavy)
        for (let i = 0; i < 300; i++)
          await plantIssue(fx.t, {
            org_id: fx.org.id,
            project_id: fx.hidden.id,
            title: long,
            description: '€'.repeat(2000),
            created_at: at(i % 30),
          })
      return fx
    }
    const shape = async (fx: Fx) => {
      const got = await restPages(fx.t, { callerId: fx.agent.id, access: 'read', limit: '200' })
      return {
        rows: got.rows.map((row) => [row.title, row.is_group, row.has_hidden_parent, row.progress]),
        sizes: got.sizes,
      }
    }
    const light = await build(false)
    const heavy = await build(true)
    expect(await shape(heavy)).toEqual(await shape(light))
    // a budget that stops pages every few rows
    const page = { ranges: ACTIVE_PAGE.delays.ranges + 20 }
    const lightPages = await lowered({ page }, () => shape(light))
    const heavyPages = await lowered({ page }, () => shape(heavy))
    expect(lightPages.sizes.length).toBeGreaterThan(2)
    expect(heavyPages).toEqual(lightPages)
    // rows with a hidden parent each answer the same whether those parents
    // are one task or several; where a page stops can move by a row at its
    // budget's margin (lib/machineSubtree.ts lists that channel)
    const distinct = await build(false, true)
    expect(await shape(distinct)).toEqual(await shape(light))
    expect((await lowered({ page }, () => shape(distinct))).rows).toEqual(lightPages.rows)
  })
})

describe('groups created under the rule of one level', () => {
  it("answers their rows' group facts without a check of their subtasks", async () => {
    const fx = await setup()
    // created after ONE_LEVEL_SINCE, as every task a release from v0.1.98 on
    // writes, so its subtasks hold no subtasks of their own
    const later = (i: number) => new Date(Date.parse(ONE_LEVEL_SINCE) + i * 60_000).toISOString()
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Group',
      created_at: later(0),
    })
    for (const [i, status] of (['done', 'todo'] as const).entries())
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: i === 0 ? fx.sub.id : fx.sub2.id,
        parent_id: group.id,
        status,
        start_week: '2026-11-02',
        end_week: '2026-11-09',
        created_at: later(1 + i),
      })
    const rows = (await restPages(fx.t, { callerId: fx.agent.id, access: 'read' })).rows
    expect(rows.map((row) => [row.title, row.is_group, row.progress])).toEqual([
      ['Group', true, { done: 1, total: 2, percent: 50, partial: false }],
      ['Planted task', false, null],
      ['Planted task', false, null],
    ])
    expect(rows[0]).toMatchObject({ start_week: '2026-11-02', end_week: '2026-11-09' })
  })
})

describe('delays', () => {
  /* withOrg with delay tracking on FW, and planned tasks of the user and
   * the viewer there, a few of each, that need their owner's other work. */
  async function planned() {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.sub._id, { track_delay: true })
    })
    const plan = (owner: Doc<'profiles'>, i: number, project_id = fx.sub.id) =>
      plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id,
        created_at: at(i),
        status: 'progress',
        assignee_id: owner.id,
        start_week: '2026-01-05',
        end_week: '2026-01-12',
        remaining_hours: 30 + i,
        remaining_set_at: NOW,
        due_date: '2026-01-14',
      })
    for (let i = 0; i < 6; i++) await plan(i % 2 === 0 ? fx.user : fx.viewer, i)
    return { fx, plan }
  }
  const single = (fx: Fx, callerId: string, ref: string) =>
    fx.t.query(internal.machine.rest.getIssue, { today: TODAY, callerId, access: 'read', ref })

  it("gives staff every owner's load the share holds, each row's verdict the single read's", async () => {
    const { fx } = await planned()
    const page = await restPage(fx.t, { callerId: fx.admin.id, access: 'read' })
    expect(page.tasks).toHaveLength(6)
    for (const row of page.tasks) {
      expect(row.delay?.status).not.toBe('unavailable')
      expect(row.delay).toEqual((await single(fx, fx.admin.id, row.id)).delay)
    }
  })

  it('gives a guest one owner a page, and the rest unavailable whatever their hidden work', async () => {
    const { fx, plan } = await planned()
    const read = async () =>
      (await restPage(fx.t, { callerId: fx.guest.id, access: 'read' })).tasks.map((row) => [
        row.assignee_id,
        row.delay,
      ])
    const rows = await read()
    // the guest reads all six tasks, three of each owner
    expect(rows.map(([owner]) => owner).sort()).toEqual(
      [fx.user.id, fx.user.id, fx.user.id, fx.viewer.id, fx.viewer.id, fx.viewer.id].sort(),
    )
    // the user's tasks come first in the page, so theirs is the load read
    for (const [owner, delay] of rows) {
      if (owner === fx.user.id) expect(delay).not.toEqual(UNAVAILABLE)
      else expect(delay).toEqual(UNAVAILABLE)
    }
    const page = await restPage(fx.t, { callerId: fx.guest.id, access: 'read' })
    for (const row of page.tasks.filter((r) => r.assignee_id === fx.user.id))
      expect(row.delay).toEqual((await single(fx, fx.guest.id, row.id)).delay)
    // the viewer's work in SKNK, which the guest cannot read, moves nothing
    for (let i = 0; i < 20; i++) await plan(fx.viewer, 50 + i, fx.hidden.id)
    expect(await read()).toEqual(rows)
    // an Organization Viewer reads one owner a page too
    const viewerRows = (await restPage(fx.t, { callerId: fx.viewer.id, access: 'read' })).tasks
    expect(viewerRows.filter((r) => r.delay?.status === 'unavailable')).toHaveLength(3)
  })

  it('answers unavailable for rows past the share, never a verdict without the load', async () => {
    const { fx } = await planned()
    const page = await lowered({ page: { delays: { ranges: 1, documents: 1, bytes: 1 } } }, () =>
      restPage(fx.t, { callerId: fx.admin.id, access: 'read' }),
    )
    expect(page.tasks.map((row) => row.delay)).toEqual(page.tasks.map(() => UNAVAILABLE))
  })
})

const UNAVAILABLE = { status: 'unavailable', projected_end_week: null }
