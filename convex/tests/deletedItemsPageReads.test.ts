/* The Deleted items page (model/deletedItemsPage.ts) at the design size,
 * with ordinary text, one figure raised a case: a project item of 30 live
 * and 40 archived sub-projects with the project's 800 open tasks, a
 * sub-project item with the sub-project's 300 open tasks, a lead who reads
 * 200 live and 500 archived sub-projects, a person in 5 teams, a team that
 * shares 50 live and 150 archived projects, the catalogue of 2,000
 * projects every seat's sight reads, and 1,000 people. Deleted items has
 * no figure of its own; it holds the work of these (coordinator,
 * 2026-11-05, question 13).
 *
 * Each case prints what its pages read, as convex-test counts it and as
 * the page counts it (pageFor's spend), and checks that the page answered
 * whole inside DELETED_PAGE and Convex's limits. convex-test counts a
 * search query as one range, while Convex and the page count one for each
 * result. DELETED_PAGE's docstring quotes these figures. The last case
 * deletes the largest task family at the description cap in a three-byte
 * script under Convex's real limits, as the delete now writes each text
 * twice. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { LIMITS, TEXT_MAX } from '../lib/limits'
import { DELETED_PAGE, type PageArgs, type PageSpend, pageFor } from '../model/deletedItemsPage'
import { as, NOW, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'
import { installTrashTimers, START } from './trash.setup'

installTrashTimers()

type Profile = Doc<'profiles'>

/** About 80 characters, holding `calibrate`. */
const title = (i: number) =>
  `Calibrate the torque sensor on test rig ${i} before the thermal soak run starts`
/** A few sentences. */
const DESCRIPTION =
  'Check the fixture alignment first. Record the readings in the lab notebook. ' +
  'Ask the lead if the values drift more than two percent.'

let nextNum = 10_000

/** A project row as the projects table holds it. */
const projectRow = (
  f: OrgFixture,
  fields: { type: 'meta' | 'project'; parent_id?: string; lead_id?: string; archived?: boolean },
) => {
  const num = nextNum++
  return {
    id: uuid(),
    org_id: f.org.id,
    type: fields.type,
    key: `K${num}`,
    name: `Project ${num} of the bench`,
    description: '',
    sort_order: num,
    num,
    track_delay: false,
    created_at: NOW,
    ...(fields.parent_id === undefined ? {} : { parent_id: fields.parent_id }),
    ...(fields.lead_id === undefined ? {} : { lead_id: fields.lead_id }),
    ...(fields.archived === true ? { archived_at: NOW } : {}),
  }
}

type ProjectRow = ReturnType<typeof projectRow>

/** A ready project item of `root` and `subs`, stored as a deletion keeps
 * them, deleted by `by` at START, with `tasks` open tasks spread over the
 * live ones of `subs` (or `root` without any), each with an ordinary title
 * and description and assigned to `assignee`. Answers the item's id. */
async function plantProjectItem(
  t: T,
  f: OrgFixture,
  a: {
    root: ProjectRow
    subs: ProjectRow[]
    parent?: string
    by: Profile
    tasks: number
    assignee?: string
  },
): Promise<string> {
  const id = uuid()
  const deleted_at = new Date(START).toISOString()
  const projects = [a.root, ...a.subs]
  const homes = a.subs.filter((s) => s.archived_at === undefined)
  const home = (i: number) => (homes.length === 0 ? a.root : homes[i % homes.length])
  const counts = new Map<string, number>()
  for (let i = 0; i < a.tasks; i++) counts.set(home(i).id, (counts.get(home(i).id) ?? 0) + 1)
  await t.run(async (ctx) => {
    await ctx.db.insert('deleted_items', {
      id,
      org_id: f.org.id,
      kind: 'project',
      target_id: a.root.id,
      num: a.root.num,
      name: a.root.name,
      key: a.root.key,
      archived: false,
      project_id: a.root.id,
      ...(a.parent === undefined ? {} : { parent_project_id: a.parent }),
      path: a.parent === undefined ? [] : ['Testbed platform'],
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        type: p.type,
        tasks: counts.get(p.id) ?? 0,
        archived_tasks: 0,
      })),
      counts: { tasks: a.tasks, archived_tasks: 0, subtasks: 0, sub_projects: a.subs.length },
      deleted_at,
      deleted_by: a.by.id,
      state: 'ready',
      purge_after: START + 30 * 86_400_000,
    })
    for (const p of projects)
      await ctx.db.insert('deleted_rows', {
        item_id: id,
        org_id: f.org.id,
        table: 'projects',
        owner_id: p.id,
        row_id: p.id,
        created_ts: START,
        project_key: p.key,
        ...(p.lead_id === undefined ? {} : { lead_id: p.lead_id }),
        row: { table: 'projects', doc: p },
      })
  })
  for (let from = 0; from < a.tasks; from += 400)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(a.tasks, from + 400); i++) {
        const num = nextNum++
        await ctx.db.insert('deleted_tasks', {
          org_id: f.org.id,
          item_id: id,
          task_id: uuid(),
          num,
          title: title(i),
          project_id: home(i).id,
          archived: false,
          search_text: `${title(i)}\n${DESCRIPTION}`,
          ...(a.assignee === undefined ? {} : { assignee_id: a.assignee }),
          deleted_at,
          deleted_by: a.by.id,
          item_project_id: a.root.id,
          ...(a.parent === undefined ? {} : { item_parent_id: a.parent }),
        })
      }
    })
  return id
}

/** A ready task item of one task in live sub-project `p` under `top`,
 * deleted by `by` at `at`, with its deleted_tasks row. */
async function plantTaskItem(
  t: T,
  f: OrgFixture,
  p: { id: string; name: string; key: string },
  top: string,
  by: Profile,
  at: number,
): Promise<string> {
  const id = uuid()
  const num = nextNum++
  const deleted_at = new Date(at).toISOString()
  await t.run(async (ctx) => {
    await ctx.db.insert('deleted_items', {
      id,
      org_id: f.org.id,
      kind: 'task',
      target_id: uuid(),
      num,
      name: title(num),
      archived: false,
      project_id: p.id,
      parent_project_id: top,
      path: ['Bench', p.name],
      projects: [
        { id: p.id, name: p.name, key: p.key, type: 'project', tasks: 1, archived_tasks: 0 },
      ],
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at,
      deleted_by: by.id,
      state: 'ready',
      purge_after: at + 30 * 86_400_000,
    })
    await ctx.db.insert('deleted_tasks', {
      org_id: f.org.id,
      item_id: id,
      task_id: uuid(),
      num,
      title: title(num),
      project_id: p.id,
      archived: false,
      search_text: `${title(num)}\n${DESCRIPTION}`,
      deleted_at,
      deleted_by: by.id,
      item_project_id: p.id,
      item_parent_id: top,
    })
  })
  return id
}

/** The fixture's viewer as a member (org_role user), who leads nothing
 * and is in no team yet. */
async function member(t: T, f: OrgFixture): Promise<Profile> {
  return await t.run(async (ctx) => {
    await ctx.db.patch(f.viewer._id, { org_role: 'user' })
    const me = await ctx.db.get(f.viewer._id)
    if (me === null) throw new Error('no viewer')
    return me
  })
}

/** Inserts `rows` projects in batches. */
async function insertProjects(t: T, rows: ProjectRow[]): Promise<void> {
  for (let from = 0; from < rows.length; from += 500)
    await t.run(async (ctx) => {
      for (const row of rows.slice(from, from + 500)) await ctx.db.insert('projects', row)
    })
}

/** What one page read: its answer, Convex's counts as convex-test keeps
 * them, and the page's own (pageFor's spend). */
async function readPage(t: T, me: Profile, args: PageArgs) {
  return await as(t, me).query(async (ctx) => {
    const spend: PageSpend = {}
    const page = await pageFor(ctx, new Map([[me.org_id, me]]), args, spend)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      page,
      figures: {
        entries: page.entries.length,
        next: page.next_cursor !== null,
        missing: page.missing ?? null,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / 2 ** 20) * 100) / 100,
        page: spend,
      },
    }
  })
}

type Figures = Awaited<ReturnType<typeof readPage>>['figures']

/** Prints `figures` and checks them inside Convex's limits and the page's
 * budgets. */
function record(what: string, figures: Figures): void {
  console.log(`deleted page figures, ${what}:`, JSON.stringify(figures))
  expect(figures.ranges).toBeLessThan(4096)
  expect(figures.documents).toBeLessThan(32_000)
  expect(figures.mib).toBeLessThan(16)
  const { call } = figures.page
  expect(call?.ranges ?? 0).toBeLessThan(DELETED_PAGE.call.ranges)
  expect(call?.rows ?? 0).toBeLessThan(DELETED_PAGE.call.rows)
  expect(call?.bytes ?? 0).toBeLessThan(DELETED_PAGE.call.bytes)
}

describe('the page at the design size', () => {
  it('reads a project item of 30 live and 40 archived sub-projects and 800 open tasks, for an admin and for its lead', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const lead = (await t.run((ctx) => ctx.db.get(f.user._id))) as Profile
    const root = projectRow(f, { type: 'meta', lead_id: lead.id })
    const subs = [
      ...Array.from({ length: 30 }, () => projectRow(f, { type: 'project', parent_id: root.id })),
      ...Array.from({ length: 40 }, () =>
        projectRow(f, { type: 'project', parent_id: root.id, archived: true }),
      ),
    ]
    await plantProjectItem(t, f, { root, subs, by: f.admin, tasks: 800 })
    const scope = { org_id: f.org.id, all: true as const }
    const browse = await readPage(t, f.admin, { scope })
    record('a project item of 70 sub-projects and 800 tasks, an admin browsing', browse.figures)
    expect(browse.figures.entries).toBe(1)
    const admin = await readPage(t, f.admin, { scope, search: 'calibrate' })
    record('the same, an admin searching a word every task holds', admin.figures)
    expect(admin.figures).toMatchObject({ entries: 25, next: true, missing: 'matches' })
    const second = await readPage(t, f.admin, {
      scope,
      search: 'calibrate',
      cursor: admin.page.next_cursor ?? '',
    })
    record('the same, its second page', second.figures)
    expect(second.figures.entries).toBe(25)
    const led = await readPage(t, lead, { scope, search: 'calibrate' })
    record('the same, its lead searching', led.figures)
    expect(led.figures).toMatchObject({ entries: 25, next: true, missing: 'matches' })
    const leadBrowse = await readPage(t, lead, { scope })
    record('the same, its lead browsing', leadBrowse.figures)
    expect(leadBrowse.figures.entries).toBe(1)
  })

  it("reads a sub-project item of 300 open tasks, browsing, searching and an admin's assignee filter", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const sam = (await t.run((ctx) => ctx.db.get(f.viewer._id))) as Profile
    const root = projectRow(f, { type: 'project', parent_id: f.meta.id })
    await plantProjectItem(t, f, {
      root,
      subs: [],
      parent: f.meta.id,
      by: f.user,
      tasks: 300,
      assignee: sam.id,
    })
    const scope = { org_id: f.org.id, all: true as const }
    for (const who of [f.admin, f.user]) {
      const browse = await readPage(t, who, { scope })
      record(`a sub-project item of 300 tasks, ${who.name} browsing`, browse.figures)
      expect(browse.figures.entries).toBe(1)
      const search = await readPage(t, who, { scope, search: 'calibrate' })
      record(`the same, ${who.name} searching a word every task holds`, search.figures)
      expect(search.figures).toMatchObject({ entries: 25, next: true })
    }
    const assigned = await readPage(t, f.admin, { scope, assignee: sam.id })
    record("the same, an admin's assignee filter", assigned.figures)
    expect(assigned.figures).toMatchObject({ entries: 25, next: true, missing: null })
    const scanned = await readPage(t, f.user, { scope, assignee: sam.id })
    record("the same, the lead's assignee filter", scanned.figures)
    expect(scanned.figures).toMatchObject({ entries: 25, next: true, missing: null })
  })

  it('reads for a lead of 200 live and 500 archived sub-projects, three a project, with a task item in each live one', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const lead = await member(t, f)
    const tops: ProjectRow[] = []
    const live: ProjectRow[] = []
    const rows: ProjectRow[] = []
    // 67 live projects with 200 live sub-projects, 167 archived ones with 500
    for (let i = 0; i < 234; i++) {
      const archived = i >= 67
      const top = projectRow(f, { type: 'meta', lead_id: lead.id, archived })
      tops.push(top)
      rows.push(top)
      const n = i === 66 || i === 233 ? 2 : 3
      for (let s = 0; s < n; s++) {
        const sub = projectRow(f, { type: 'project', parent_id: top.id, archived })
        rows.push(sub)
        if (!archived) live.push(sub)
      }
    }
    expect(live).toHaveLength(200)
    expect(rows.length - tops.length).toBe(700)
    await insertProjects(t, rows)
    for (const [i, sub] of live.entries()) {
      const top = sub.parent_id ?? ''
      await plantTaskItem(t, f, sub, top, f.admin, START + i * 1000)
    }
    const scope = { org_id: f.org.id, all: true as const }
    const first = await readPage(t, lead, { scope })
    record('a lead of 700 sub-projects browsing All, the first page', first.figures)
    // the project part leaves too little of the finding share to open
    // the task part's 935 ranges beside it, so the next page does
    expect(first.figures).toMatchObject({ entries: 0, next: true, missing: null })
    const second = await readPage(t, lead, { scope, cursor: first.page.next_cursor ?? '' })
    record('the same, the second page', second.figures)
    expect(second.figures).toMatchObject({ entries: 25, next: true, missing: null })
    const tasks = await readPage(t, lead, { scope, kind: 'task' })
    record('the same, task entries only', tasks.figures)
    expect(tasks.figures).toMatchObject({ entries: 25, next: true, missing: null })
    const search = await readPage(t, lead, { scope, search: 'calibrate' })
    record('the same, searching a word every task holds', search.figures)
    expect(search.figures).toMatchObject({ entries: 25, next: true, missing: 'matches' })
    // the page merges at most DELETED_PAGE.sources ranges for the lead
    expect(DELETED_PAGE.sources).toBeGreaterThan(1 + tops.length)
  })

  it('reads for a person in 5 teams that share 20 sub-projects each, with 30 of their own deletes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await member(t, f)
    const subs: ProjectRow[] = []
    const rows: ProjectRow[] = []
    for (let team = 0; team < 5; team++) {
      const top = projectRow(f, { type: 'meta' })
      rows.push(top)
      for (let s = 0; s < 20; s++) {
        const sub = projectRow(f, { type: 'project', parent_id: top.id })
        rows.push(sub)
        subs.push(sub)
      }
    }
    await insertProjects(t, rows)
    await t.run(async (ctx) => {
      for (let team = 0; team < 5; team++) {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          name: `Team ${team}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', { team_id: id, profile_id: me.id, is_leader: false })
        for (const sub of subs.slice(team * 20, team * 20 + 20))
          await ctx.db.insert('project_team_access', {
            project_id: sub.id,
            team_id: id,
            level: 'user',
          })
      }
    })
    for (let i = 0; i < 30; i++)
      await plantTaskItem(t, f, subs[i * 3], subs[i * 3].parent_id ?? '', me, START + i * 1000)
    const scope = { org_id: f.org.id, all: true as const }
    const browse = await readPage(t, me, { scope })
    record('a person in 5 teams browsing', browse.figures)
    expect(browse.figures).toMatchObject({ entries: 25, next: true, missing: null })
    const search = await readPage(t, me, { scope, search: 'calibrate' })
    record('the same, searching', search.figures)
    expect(search.figures).toMatchObject({ entries: 25, next: true, missing: 'matches' })
  })

  it('reads for a person in a team that shares 50 live and 150 archived projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const me = await member(t, f)
    const rows = Array.from({ length: 200 }, (_, i) =>
      projectRow(f, { type: 'project', parent_id: f.meta.id, archived: i >= 50 }),
    )
    await insertProjects(t, rows)
    const team = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('teams', {
        id: team,
        org_id: f.org.id,
        name: 'Field',
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: team, profile_id: me.id, is_leader: false })
      for (const p of rows)
        await ctx.db.insert('project_team_access', {
          project_id: p.id,
          team_id: team,
          level: 'user',
        })
    })
    await plantTaskItem(t, f, rows[0], f.meta.id, me, START)
    const browse = await readPage(t, me, { scope: { org_id: f.org.id, all: true } })
    record('a person whose team shares 200 projects browsing', browse.figures)
    expect(browse.figures).toMatchObject({ entries: 1, next: false, missing: null })
  })

  it('reads beside the catalogue of 2,000 projects, live and archived, with one item', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const rows: ProjectRow[] = []
    // with withOrg's two top-level projects and two sub-projects
    const live = Array.from({ length: 198 }, () => projectRow(f, { type: 'meta' }))
    const archived = Array.from({ length: 300 }, () =>
      projectRow(f, { type: 'meta', archived: true }),
    )
    rows.push(...live, ...archived)
    for (let i = 0; i < 498; i++)
      rows.push(projectRow(f, { type: 'project', parent_id: live[i % live.length].id }))
    for (let i = 0; i < 1000; i++)
      rows.push(
        projectRow(f, {
          type: 'project',
          parent_id: archived[i % archived.length].id,
          archived: true,
        }),
      )
    await insertProjects(t, rows)
    await plantTaskItem(t, f, f.sub, f.meta.id, f.guest, START)
    const scope = { org_id: f.org.id, all: true as const }
    for (const who of [f.admin, f.user, f.guest]) {
      const browse = await readPage(t, who, { scope })
      record(`a catalogue of 2,000 projects, ${who.name} browsing`, browse.figures)
      expect(browse.figures).toMatchObject({ entries: 1, next: false, missing: null })
    }
    const bare = await readPage(t, f.user, {})
    record('the same, the user without a scope', bare.figures)
  })

  it('reads beside 1,000 people with one item', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    for (let from = 0; from < 995; from += 500)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(995, from + 500); i++)
          await ctx.db.insert('profiles', {
            id: uuid(),
            org_id: f.org.id,
            name: `Person ${i} of the lab`,
            initials: 'PL',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            plannable_hours: 40,
            created_at: NOW,
            email: `person${i}@testbed.test`,
          })
      })
    await plantTaskItem(t, f, f.sub, f.meta.id, f.guest, START)
    const scope = { org_id: f.org.id, all: true as const }
    for (const who of [f.admin, f.user]) {
      const browse = await readPage(t, who, { scope })
      record(`1,000 people, ${who.name} browsing`, browse.figures)
      expect(browse.figures).toMatchObject({ entries: 1, next: false, missing: null })
      const search = await readPage(t, who, { scope, search: 'calibrate' })
      record(`1,000 people, ${who.name} searching`, search.figures)
      expect(search.figures.entries).toBe(1)
    }
  })
})

describe('a task family at the description cap', () => {
  it('deletes a task with LIMITS.subtasks.max subtasks whose descriptions are at the cap in a three-byte script, both copies written, under the real limits', async () => {
    // each task's text goes into its stored copy and into its search text
    // (deleted_tasks.search_text), so the delete writes it twice; a search
    // from 0 to 101 on 5 November 2026 found every family size up to the
    // largest the delete takes fitting
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const text = '漢'.repeat(TEXT_MAX)
    const ids = await t.run(async (ctx) => {
      const out: string[] = []
      for (let i = 0; i <= LIMITS.subtasks.max; i++) {
        const id = uuid()
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          num: nextNum++,
          project_id: f.sub.id,
          ...(i === 0 ? {} : { parent_id: out[0] }),
          title: title(i),
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
        await ctx.db.insert('issue_descriptions', {
          issue_id: id,
          org_id: f.org.id,
          project_id: f.sub.id,
          description: text,
        })
        out.push(id)
      }
      return out
    })
    await as(t, f.user).mutation(api.issues.deleteDeep, {
      org_id: f.org.id,
      id: ids[0],
      subtask_ids: ids.slice(1),
    })
    const rows = await t.run((ctx) => ctx.db.query('deleted_tasks').collect())
    expect(rows).toHaveLength(LIMITS.subtasks.max + 1)
    for (const row of rows) expect(row.search_text?.endsWith(text)).toBe(true)
    console.log(
      `deleted page figures, a family at the cap: ${LIMITS.subtasks.max} subtasks fit, ` +
        `${Math.round((rows.length * 2 * text.length * 3) / 2 ** 20)} MiB of text written`,
    )
  })
})
