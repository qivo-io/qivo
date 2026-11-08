/* The organization of the active and archived task page measurements
 * (convex/tests/activeTaskPagesScale.test.ts and
 * archivedTaskPagesScale.test.ts), built at the sizes a case asks for, at
 * most the design size, with ordinary text, and the reads of one page with
 * what it read. Named *.setup.ts so the Convex CLI skips it (see
 * helpers.setup.ts). */
/// <reference types="vite/client" />

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { rosterNames } from '../lib/archivedTasks'
import { accessFlags, asMachineCaller, loadCatalogue } from '../lib/core'
import { byId, newWindowKey } from '../lib/db'
import { MIB } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { listIssues as mcpListIssues } from '../machine/mcp'
import { listIssues } from '../machine/rest'
import {
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'
import type { McpArgs } from './taskPages.setup'

/* What one page read, as Convex counts it, and what it answered. */
export type Figures = {
  ranges: number
  documents: number
  mib: number
  rows: number
  answer_kb: number
  next: boolean
}

/* Prints what a page read, the figures ACTIVE_PAGE's docstring quotes, or
 * ARCHIVE_PAGE's for an archived page. */
export const record = (name: string, figures: Figures, list: 'active' | 'archived' = 'active') =>
  console.log(`${list} page figures, ${name}:`, JSON.stringify(figures))

/* What the query has read so far, as Convex counts it. */
async function readsSoFar(ctx: QueryCtx) {
  const m = await ctx.meta.getTransactionMetrics()
  return {
    ranges: m.databaseQueries.used,
    documents: m.documentsRead.used,
    mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
  }
}

/* A query's handler, run inside a test's own transaction so its metrics
 * can be read after it. */
export const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

export type RestArgs = {
  callerId: string
  access: 'read'
  today: string
  project?: string
  search?: string
  limit?: string
  cursor?: string
  status?: string
  archived?: string
}
export type RestPage = { next_cursor: string | null; tasks: { id: string; delay: unknown }[] }

/* One REST page read in a query of its own, with what it read before its rows (the
 * caller, the catalogue and the access rows) and in all. */
export async function readPage(t: T, args: Omit<RestArgs, 'today' | 'access'>) {
  return await t.query(async (ctx) => {
    const page = await handlerOf<RestArgs, RestPage>(listIssues)(ctx, {
      today: TODAY,
      access: 'read',
      ...args,
    })
    const figures: Figures = {
      ...(await readsSoFar(ctx)),
      rows: page.tasks.length,
      answer_kb: Math.round(JSON.stringify(page).length / 1024),
      next: page.next_cursor !== null,
    }
    return { page, figures }
  })
}

/* One MCP list_tasks page read in a query of its own, as readPage reads a
 * REST page, the answer parsed. */
export async function readMcpPage(t: T, args: Omit<McpArgs, 'today' | 'access'>) {
  return await t.query(async (ctx) => {
    const text = await handlerOf<McpArgs, string>(mcpListIssues)(ctx, {
      today: TODAY,
      access: 'read',
      ...args,
    })
    const page = JSON.parse(text) as RestPage
    const figures: Figures = {
      ...(await readsSoFar(ctx)),
      rows: page.tasks.length,
      answer_kb: Math.round(text.length / 1024),
      next: page.next_cursor !== null,
    }
    return { page, figures }
  })
}

/* What a task list reads before its page: the caller, the catalogue and
 * their access over it (machine/rest.ts catalogueAccess), which reads
 * nothing else of size. */
async function catalogueReads(ctx: QueryCtx, callerId: string) {
  const me = await asMachineCaller(ctx, callerId, 'read')
  await accessFlags(ctx, me, await loadCatalogue(ctx, me), 'read')
}

/* The reads before a page: the caller, the catalogue and their access, as
 * REST GET /v1/tasks reads them before its page. */
export async function readBefore(t: T, callerId: string) {
  return await t.query(async (ctx) => {
    await catalogueReads(ctx, callerId)
    return await readsSoFar(ctx)
  })
}

/* The reads before an archived page without a search: readBefore's, and
 * the organization's roster and row, which lib/core.ts
 * listArchivedIssuesCore reads before the page's budget starts. */
export async function readArchivedBefore(t: T, caller: Doc<'profiles'>) {
  return await t.query(async (ctx) => {
    await catalogueReads(ctx, caller.id)
    await rosterNames(ctx, caller.org_id)
    await byId(ctx, 'organizations', caller.org_id)
    return await readsSoFar(ctx)
  })
}

/* Ordinary titles and texts. */
export const TITLES = [
  'Replace the fan controller on the bench rig',
  'Write up the thermal test results for review',
  'Fix the login timeout on the field tablets',
  'Order spare connectors for the next build',
  'Update the assembly guide with the new jig',
  'Check the power budget of the sensor board',
  'Plan the firmware release for the pilot sites',
  'Answer the customer question on the export format',
]
export const TEXT =
  'The readings drift slowly through the morning, so we log them every ten minutes and compare them with the previous build. ' +
  'Once the cause is clear, write the change into the assembly guide and ask the test team to repeat the run on two boards. ' +
  'Keep the old values in the sheet so the difference stays easy to see.'

/* Task numbers clear of the fixtures'. */
let num = 1_000_000

export type PageOrg = OrgFixture & {
  t: T
  member: Doc<'profiles'>
  owners: Doc<'profiles'>[]
  tops: Doc<'projects'>[]
  subs: Doc<'projects'>[]
  /** the sub-projects `member` reads */
  readable: Doc<'projects'>[]
}

/** The sizes of an organization of pageOrg. withOrg adds two live
 * top-level projects, two live sub-projects under the first of them, five
 * people of the organization and a team, and pageOrg adds `member`. Before
 * it plants anything, pageOrg refuses with a sentence any sizes that put a
 * figure it builds past its design size (AGENTS.md, assertDesignSize),
 * those rows and each group's subtasks counted, or that put an archived
 * task figure at its design size, since tests never seed the full archived
 * task figures:
 *
 * - top-level projects (`tops`, `archivedTops`): 200 live and 300 archived;
 * - sub-projects (`subs`, `archivedSubs`): 500 live and 1,000 archived,
 *   which with the top-level projects make the catalogue's 2,000;
 * - sub-projects under one top-level project (`family`, and `subs` past it
 *   spread over the others; `archivedSubs` spread over `archivedTops`): 30
 *   live and 40 archived;
 * - people (`people` or `owners`): 1,000;
 * - teams (`teams` and `projectTeams`): 50, of them 5 that `member` belongs
 *   to (`teams`) and 5 that share one project (`projectTeams` and one of
 *   the member's);
 * - projects one team shares (`oneTeam`, or the turns of `memberSubs`, all
 *   of them for each of `projectTeams`): 50 live and 150 archived;
 * - sub-projects `member` reads (`memberSubs`, or `subs` and
 *   `archivedSubs` with `oneTeam`): 200 live and 500 archived;
 * - tasks (`tasks`, `archived`), open, Done and archived: 300, 150 and
 *   3,000 in one sub-project, 800, 200 and 10,000 in one top-level project
 *   with its sub-projects, and 10,000, 5,000 and 100,000 in the
 *   organization, the archived ones always below those figures.
 *
 * It does not check that a case raises one figure at a time and keeps the
 * others at everyday values; each case keeps to that itself. */
export type PageOrgSizes = {
  /** live top-level projects, at least 1 with any sub-project and at least
   * 2 when `subs` passes `family` */
  tops: number
  /** live sub-projects, `family` under the first top-level project and the
   * rest spread over the others, at least 1 with any task */
  subs: number
  /** sub-projects under the first top-level project, 3 by default */
  family?: number
  /** archived top-level projects, with `archivedSubs` sub-projects spread
   * over them, none by default; `archivedSubs` needs some */
  archivedTops?: number
  archivedSubs?: number
  /** how many sub-projects `member` reads at least: the member's teams
   * share whole top-level projects in turn, from the first, until they
   * hold that many. Every live one by default. */
  memberSubs?: number
  /** the member's teams, 3 by default, at least 1 when they share a
   * project */
  teams?: number
  /** teams the member is not in that share each top-level project the
   * member's teams share too, none by default, so a project is shared with
   * one team more than this */
  projectTeams?: number
  /** the member's first team shares every top-level project, live and
   * archived, instead of the turns above, and the member's other teams
   * share none */
  oneTeam?: boolean
  /** people besides withOrg's, `owners` by default */
  people?: number
  /** active tasks spread over the live sub-projects */
  tasks: number
  /** archived tasks beside them, which no active page reads, below each
   * archived task figure */
  archived: number
  /** the people who own the tasks, 50 by default, each owning every 50th
   * task; given, each owns the tasks of a few sub-projects. At least 1
   * with any active task. */
  owners?: number
}

/* Runs `fn` and logs how long it took, so a slow fixture shows where. */
async function phase<R>(name: string, fn: () => Promise<R>): Promise<R> {
  const from = Date.now()
  const out = await fn()
  console.log(`page organization phase, ${name}: ${Date.now() - from} ms`)
  return out
}

/* The index among the live top-level projects of the one live sub-project
 * `i` goes under: the first `family` under the first, the rest in turn
 * under the others. */
const topOf = (o: PageOrgSizes, family: number, i: number): number =>
  i < family ? 0 : 1 + ((i - family) % Math.max(1, o.tops - 1))

/* Whether active task `i` is Done, and whether it heads a group of
 * GROUP_SIZE subtasks, which take its project and status. */
const doneAt = (i: number): boolean => i % 5 === 0
const groupAt = (i: number): boolean => i % 50 === 0
const GROUP_SIZE = 5

/* What withOrg plants in the organization beside pageOrg's rows: TBED and
 * Skunkworks, Firmware and Board rev under TBED, five people and the team
 * Hardware. pageOrg adds `member`. */
const WITH_ORG = { tops: 2, subs: 2, people: 5, teams: 1 }

/* The design size of each figure pageOrg builds, per organization (the
 * design size paragraph of AGENTS.md), live and archived where both
 * apply. */
const DESIGN = {
  projects: { live: 200, archived: 300 },
  subProjects: { live: 500, archived: 1000 },
  underOneProject: { live: 30, archived: 40 },
  sharedWithOneTeam: { live: 50, archived: 150 },
  readByOnePerson: { live: 200, archived: 500 },
  people: 1000,
  teams: 50,
  teamsOfOnePerson: 5,
  teamsOfOneProject: 5,
  open: { subProject: 300, project: 800, org: 10_000 },
  done: { subProject: 150, project: 200, org: 5_000 },
  archived: { subProject: 3_000, project: 10_000, org: 100_000 },
}

/* A sub-project row of `top` numbered `i`, live or archived beneath an
 * archived parent. */
const subDoc = (orgId: string, lead: string, top: Doc<'projects'>, i: number) => ({
  id: uuid(),
  org_id: orgId,
  type: 'project' as const,
  parent_id: top.id,
  key: `W${i}`,
  num: 10_000 + i,
  sort_order: 10_000 + i,
  ...named(`Workstream ${i}`),
  description: '',
  lead_id: lead,
  track_delay: true,
  created_at: NOW,
  window_key: newWindowKey(),
  ...(top.archived_at === undefined
    ? { archive_state: 'live' as const }
    : { archive_state: 'under' as const, archived_at: top.archived_at }),
})

/* Throws a sentence naming the constraint of PageOrgSizes that `o` breaks,
 * before pageOrg plants anything, in place of the TypeError a missing
 * project, owner or team would raise later. `family` is o.family or its
 * default. */
function assertSizes(o: PageOrgSizes, family: number): void {
  if (o.subs > family && o.tops < 2)
    throw new Error(
      `pageOrg needs tops of at least 2 when subs (${o.subs}) passes family (${family}), because the sub-projects past the family go under the other top-level projects`,
    )
  if (o.subs > 0 && o.tops < 1)
    throw new Error(
      `pageOrg needs tops of at least 1 when subs is ${o.subs}, because the sub-projects go under the first top-level project`,
    )
  if ((o.archivedSubs ?? 0) > 0 && (o.archivedTops ?? 0) < 1)
    throw new Error(
      `pageOrg needs archivedTops of at least 1 when archivedSubs is ${o.archivedSubs}, because the archived sub-projects go under the archived top-level projects`,
    )
  if (o.tasks + o.archived > 0 && o.subs < 1)
    throw new Error(
      'pageOrg needs subs of at least 1 when tasks or archived is above 0, because the tasks go in its live sub-projects',
    )
  if (o.tasks > 0 && (o.owners ?? 50) < 1)
    throw new Error(
      `pageOrg needs owners of at least 1 when tasks is ${o.tasks}, because every active task has an owner`,
    )
  const shared =
    o.oneTeam === true
      ? o.tops + (o.archivedTops ?? 0) > 0
      : o.tops > 0 && (o.memberSubs ?? o.subs) > 0
  if (shared && (o.teams ?? 3) < 1)
    throw new Error(
      "pageOrg needs teams of at least 1, because the member's teams share the projects the member reads",
    )
}

/* Throws a sentence naming the figure `o` would put past its design size,
 * or an archived task figure it would reach (PageOrgSizes), before pageOrg
 * plants anything. It runs after assertSizes, so the projects, people and
 * teams every size needs are there. */
function assertDesignSize(o: PageOrgSizes, family: number): void {
  const most = (figure: string, size: number, design: number) => {
    if (size > design)
      throw new Error(
        `pageOrg builds at most the design size, and ${figure} would be ${size}, past ${design}`,
      )
  }
  // tests never seed the full archived task figures (AGENTS.md)
  const below = (figure: string, size: number, design: number) => {
    if (size >= design)
      throw new Error(
        `pageOrg never seeds the full archived task figures, and ${figure} would be ${size}, not below ${design}`,
      )
  }
  const archivedTops = o.archivedTops ?? 0
  const archivedSubs = o.archivedSubs ?? 0
  most(
    "the live top-level projects, withOrg's 2 included,",
    o.tops + WITH_ORG.tops,
    DESIGN.projects.live,
  )
  most('the archived top-level projects', archivedTops, DESIGN.projects.archived)
  most(
    "the live sub-projects, withOrg's 2 included,",
    o.subs + WITH_ORG.subs,
    DESIGN.subProjects.live,
  )
  most('the archived sub-projects', archivedSubs, DESIGN.subProjects.archived)
  const perTop = Array.from({ length: o.tops }, () => 0)
  for (let i = 0; i < o.subs; i++) perTop[topOf(o, family, i)]++
  most(
    'the live sub-projects under one top-level project',
    Math.max(0, ...perTop),
    DESIGN.underOneProject.live,
  )
  most(
    'the archived sub-projects under one top-level project',
    archivedTops > 0 ? Math.ceil(archivedSubs / archivedTops) : 0,
    DESIGN.underOneProject.archived,
  )
  most(
    "the people, withOrg's 5 and the member included,",
    Math.max(o.people ?? 0, o.owners ?? 50) + WITH_ORG.people + 1,
    DESIGN.people,
  )
  const teams = o.teams ?? 3
  const others = o.projectTeams ?? 0
  most("the teams, withOrg's 1 included,", teams + others + WITH_ORG.teams, DESIGN.teams)
  most('the teams the member belongs to', teams, DESIGN.teamsOfOnePerson)
  if (o.oneTeam === true) {
    most('the live projects one team shares', o.tops, DESIGN.sharedWithOneTeam.live)
    most('the archived projects one team shares', archivedTops, DESIGN.sharedWithOneTeam.archived)
    most('the live sub-projects the member reads', o.subs, DESIGN.readByOnePerson.live)
    most(
      'the archived sub-projects the member reads',
      archivedSubs,
      DESIGN.readByOnePerson.archived,
    )
  } else {
    // the member's teams share top-level projects in turn, each with every
    // one of the other teams, until the member reads memberSubs
    let shared = 0
    let reads = 0
    for (const count of perTop) {
      if (reads >= (o.memberSubs ?? o.subs)) break
      shared++
      reads += count
    }
    most('the teams that share one project', shared > 0 ? 1 + others : 0, DESIGN.teamsOfOneProject)
    most(
      'the live projects one team shares',
      others > 0 ? shared : Math.ceil(shared / Math.max(1, teams)),
      DESIGN.sharedWithOneTeam.live,
    )
    most('the live sub-projects the member reads', reads, DESIGN.readByOnePerson.live)
  }
  // the active tasks and their groups' subtasks, by sub-project, and the
  // organization's totals as they add up
  const open = Array.from({ length: o.subs }, () => 0)
  const done = Array.from({ length: o.subs }, () => 0)
  let allOpen = 0
  let allDone = 0
  for (let i = 0; i < o.tasks; i++) {
    const n = 1 + (groupAt(i) ? GROUP_SIZE : 0)
    if (doneAt(i)) {
      done[i % o.subs] += n
      allDone += n
    } else {
      open[i % o.subs] += n
      allOpen += n
    }
    most('the open tasks of the organization', allOpen, DESIGN.open.org)
    most('the Done tasks of the organization', allDone, DESIGN.done.org)
  }
  below('the archived tasks of the organization', o.archived, DESIGN.archived.org)
  // the archived tasks go to the live sub-projects in turn, so the first
  // `rest` of them hold one more than the others
  const each = o.subs > 0 ? Math.floor(o.archived / o.subs) : 0
  const rest = o.subs > 0 ? o.archived % o.subs : 0
  const archived = Array.from({ length: o.subs }, (_, s) => each + (s < rest ? 1 : 0))
  most('the open tasks of one sub-project', Math.max(0, ...open), DESIGN.open.subProject)
  most('the Done tasks of one sub-project', Math.max(0, ...done), DESIGN.done.subProject)
  below(
    'the archived tasks of one sub-project',
    Math.max(0, ...archived),
    DESIGN.archived.subProject,
  )
  const byTop = (perSub: readonly number[]) => {
    const sums = Array.from({ length: o.tops }, () => 0)
    for (const [s, n] of perSub.entries()) sums[topOf(o, family, s)] += n
    return Math.max(0, ...sums)
  }
  most(
    'the open tasks of one top-level project with its sub-projects',
    byTop(open),
    DESIGN.open.project,
  )
  most(
    'the Done tasks of one top-level project with its sub-projects',
    byTop(done),
    DESIGN.done.project,
  )
  below(
    'the archived tasks of one top-level project with its sub-projects',
    byTop(archived),
    DESIGN.archived.project,
  )
}

/**
 * An organization at `o`'s sizes: the live top-level projects and their
 * sub-projects, the archived ones, `member` in teams that share top-level
 * projects, the people, and the tasks spread over the live sub-projects,
 * every fiftieth of them the parent of a group of five subtasks stored
 * before the rule of one level, which adds a tenth to the count, planned
 * and owned by `owners` people in projects that track delay, with archived
 * tasks beside them. No project_reach rows: a
 * list takes the caller's access from their grants and team shares
 * (lib/core.ts accessFlags), so active pages never read them. Sizes that
 * PageOrgSizes rules out, or that pass the design size, throw a sentence
 * naming the constraint or the figure before anything is planted
 * (assertSizes, assertDesignSize).
 */
export async function pageOrg(o: PageOrgSizes): Promise<PageOrg> {
  const family = o.family ?? 3
  assertSizes(o, family)
  assertDesignSize(o, family)
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const tops: Doc<'projects'>[] = []
  const archived: Doc<'projects'>[] = []
  const subs: Doc<'projects'>[] = []
  await phase('projects', async () => {
    for (let i = 0; i < o.tops; i++)
      tops.push(
        await plantProject(t, {
          org_id: f.org.id,
          lead_id: f.user.id,
          ...named(`Programme ${i}`),
          description: 'A programme of work.',
          track_delay: true,
          archive_state: 'live',
        }),
      )
    for (let i = 0; i < (o.archivedTops ?? 0); i++)
      archived.push(
        await plantProject(t, {
          org_id: f.org.id,
          lead_id: f.user.id,
          ...named(`Finished programme ${i}`),
          description: 'A finished programme of work.',
          archive_state: 'listed',
          archived_at: NOW,
        }),
      )
    await t.run(async (ctx) => {
      for (let i = 0; i < o.subs; i++) {
        const top = tops[topOf(o, family, i)] as Doc<'projects'>
        const _id = await ctx.db.insert('projects', subDoc(f.org.id, f.user.id, top, i))
        subs.push((await ctx.db.get(_id)) as Doc<'projects'>)
      }
      for (let i = 0; i < (o.archivedSubs ?? 0); i++) {
        const top = archived[i % archived.length] as Doc<'projects'>
        await ctx.db.insert('projects', subDoc(f.org.id, f.user.id, top, o.subs + i))
      }
    })
  })
  const member = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Member',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: NOW,
  })
  // the member's teams share top-level projects in turn, from the first,
  // until the member reads `memberSubs` sub-projects, each with the
  // `projectTeams` other teams; or the first team shares them all
  const readable: Doc<'projects'>[] = []
  await phase('teams and shares', () =>
    t.run(async (ctx) => {
      const team = async (name: string, mine: boolean) => {
        const id = uuid()
        await ctx.db.insert('teams', {
          id,
          org_id: f.org.id,
          ...named(name),
          track_delay_default: true,
          created_at: NOW,
        })
        if (mine)
          await ctx.db.insert('team_members', {
            team_id: id,
            profile_id: member.id,
            is_leader: false,
            name_key: nameKey(member.name),
          })
        return { id, name }
      }
      const share = (project: Doc<'projects'>, by: { id: string; name: string }) =>
        ctx.db.insert('project_team_access', {
          project_id: project.id,
          team_id: by.id,
          level: 'user',
          name_key: nameKey(by.name),
        })
      const teams: { id: string; name: string }[] = []
      for (let i = 0; i < (o.teams ?? 3); i++) teams.push(await team(`Team ${i}`, true))
      const others: { id: string; name: string }[] = []
      for (let i = 0; i < (o.projectTeams ?? 0); i++)
        others.push(await team(`Other team ${i}`, false))
      if (o.oneTeam === true) {
        for (const top of [...tops, ...archived])
          await share(top, teams[0] as { id: string; name: string })
        readable.push(...subs)
        return
      }
      for (const [i, top] of tops.entries()) {
        if (readable.length >= (o.memberSubs ?? subs.length)) break
        await share(top, teams[i % teams.length] as { id: string; name: string })
        for (const other of others) await share(top, other)
        readable.push(...subs.filter((sub) => sub.parent_id === top.id))
      }
    }),
  )
  // the people, `owners` of them owning the tasks
  const owners: Doc<'profiles'>[] = []
  await phase('people', () =>
    t.run(async (ctx) => {
      for (let i = 0; i < Math.max(o.people ?? 0, o.owners ?? 50); i++) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: `Person ${i}`,
          initials: 'PP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
        })
        if (i < (o.owners ?? 50)) owners.push((await ctx.db.get(_id)) as Doc<'profiles'>)
      }
    }),
  )
  // the tasks, oldest first, in batches
  await phase(`${o.tasks} active tasks`, async () => {
    for (let from = 0; from < o.tasks; from += 1000) {
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(o.tasks, from + 1000); i++) {
          const sub = subs[i % subs.length] as Doc<'projects'>
          const id = uuid()
          // with `owners` given, each owns the tasks of a few sub-projects
          const owner = owners[
            o.owners === undefined ? i % owners.length : (i % subs.length) % owners.length
          ] as Doc<'profiles'>
          const week = `2026-0${1 + (i % 9)}-05`
          const doc = {
            id,
            org_id: f.org.id,
            project_id: sub.id,
            num: num++,
            title: TITLES[i % TITLES.length] as string,
            status: doneAt(i) ? ('done' as const) : ('progress' as const),
            priority: 'medium' as const,
            paused: false,
            assignee_id: owner.id,
            reporter_id: f.user.id,
            created_by: f.user.id,
            start_week: week,
            end_week: week,
            remaining_hours: 6,
            remaining_set_at: NOW,
            due_date: '2026-06-30',
            created_at: new Date(Date.parse('2025-01-01T00:00:00.000Z') + i * 60_000).toISOString(),
            updated_at: NOW,
            status_at: NOW,
            window_key: newWindowKey(),
          }
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: id,
            description: TEXT,
            org_id: f.org.id,
            project_id: sub.id,
          })
          // every fiftieth task heads a group of five subtasks in its
          // project, which adds a tenth to the count
          if (groupAt(i)) {
            for (let k = 0; k < GROUP_SIZE; k++) {
              const kid = uuid()
              await ctx.db.insert('issues', {
                ...doc,
                id: kid,
                num: num++,
                parent_id: id,
                window_key: newWindowKey(),
              })
              await ctx.db.insert('issue_descriptions', {
                issue_id: kid,
                description: '',
                org_id: f.org.id,
                project_id: sub.id,
              })
            }
          }
        }
      })
    }
  })
  await phase(`${o.archived} archived tasks`, async () => {
    for (let from = 0; from < o.archived; from += 1000) {
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(o.archived, from + 1000); i++) {
          const sub = subs[i % subs.length] as Doc<'projects'>
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: sub.id,
            num: num++,
            title: TITLES[i % TITLES.length] as string,
            status: 'done',
            priority: 'medium',
            paused: false,
            archived_at: NOW,
            created_at: '2024-06-01T00:00:00.000Z',
            updated_at: NOW,
          })
        }
      })
    }
  })
  return { t, ...f, member, owners, tops, subs, readable }
}

/** Puts `profile` in every team `e.member` is in, so it reads what the
 * member reads through those teams' shares. A case measures an
 * organization admin given the member's everyday access this way beside
 * the member, as admin status adds no project. */
export async function joinMemberTeams(e: PageOrg, profile: Doc<'profiles'>): Promise<void> {
  await e.t.run(async (ctx) => {
    const teams = await ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', e.member.id))
      .collect()
    for (const { team_id } of teams)
      await ctx.db.insert('team_members', {
        team_id,
        profile_id: profile.id,
        is_leader: false,
        name_key: nameKey(profile.name),
      })
  })
}
