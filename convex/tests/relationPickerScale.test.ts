/* The task window's relation pickers (lib/relationPicker.ts) under
 * Convex's real transaction limits at the design size, with ordinary text.
 * Each case raises one figure and keeps the others at everyday values (a
 * person in 3 teams, 20 sub-projects a team, 3 sub-projects a project, 30
 * open tasks a sub-project): the open tasks of one project, of one
 * sub-project, the sub-projects under one project with the archived ones
 * at their sum, a project's Done tasks, the catalogue at its sum for a
 * member and an admin, one batch at its full scan, the teams a person is
 * in, the sub-projects one person reads, the teams a project is shared
 * with and a team's shares. Each case prints what each first batch read,
 * the figures RELATION_PICKER's docstring quotes, and checks that it
 * answered whole within the default budgets. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { newWindowKey } from '../lib/db'
import { MIB } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import {
  RELATION_PICKER,
  type RelationArgs,
  type RelationCandidates,
  type RelationKind,
  readRelationCandidates,
} from '../lib/relationPicker'
import type { Reads } from '../lib/viewReads'
import {
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { pageOrg } from './pageOrg.setup'

/* What one batch read: the request's reads as Convex counts them, the
 * batch's own count (lib/relationPicker.ts batchCount), and what it
 * answered. */
type Figures = {
  ranges: number
  documents: number
  mib: number
  batch: { ranges: number; documents: number; mib: number } | null
  rows: number
  stopped: boolean
  end: boolean
}

/* MiB to two decimals. */
const mibOf = (bytes: number) => Math.round((bytes / MIB) * 100) / 100

/** One batch of `me`'s picker read in one transaction, with what it read. */
async function measure(t: T, me: Doc<'profiles'>, args: RelationArgs) {
  return await t.run(async (ctx) => {
    let batch: Reads | null = null
    const answer: RelationCandidates = await readRelationCandidates(ctx, me, args, {
      measured: (used) => {
        batch = used
      },
    })
    const m = await ctx.meta.getTransactionMetrics()
    const counted = batch as Reads | null
    const ok = answer.state === 'ok' ? answer : null
    const figures: Figures = {
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      mib: mibOf(m.bytesRead.used),
      batch:
        counted === null
          ? null
          : { ranges: counted.ranges, documents: counted.documents, mib: mibOf(counted.bytes) },
      rows: ok?.rows.length ?? -1,
      stopped: ok?.stopped ?? false,
      end: ok !== null && ok.next === null,
    }
    return { answer, figures }
  })
}

/* Prints what a batch read, and checks it stays inside Convex's limits and
 * the batch's own budget. */
function record(name: string, f: Figures) {
  console.log(`relation picker figures, ${name}:`, JSON.stringify(f))
  expect(f.ranges, name).toBeLessThan(4096)
  expect(f.documents, name).toBeLessThan(32_000)
  expect(f.mib, name).toBeLessThan(16)
  if (f.batch !== null) {
    expect(f.batch.ranges, name).toBeLessThanOrEqual(RELATION_PICKER.reads.ranges)
    expect(f.batch.documents, name).toBeLessThanOrEqual(RELATION_PICKER.reads.documents)
    expect(f.batch.mib, name).toBeLessThanOrEqual(RELATION_PICKER.reads.bytes / MIB)
  }
}

/** The first batches of `me`'s three pickers for `open`: a blank search,
 * which fills a batch, and a rare word, which reads the family to its end,
 * then for Linked tasks the rare word past the family after Search all
 * your projects. Each answers whole within the default budgets. */
async function pickers(
  t: T,
  name: string,
  me: Doc<'profiles'>,
  open: Doc<'issues'>,
  eligible = 25,
) {
  for (const kind of ['parent', 'subtask', 'link'] as RelationKind[]) {
    const blank = await measure(t, me, { issue_id: open.id, kind })
    record(`${name}, ${kind}, no search`, blank.figures)
    expect(blank.figures.rows, `${name}, ${kind}`).toBe(Math.min(25, eligible))
    expect(blank.figures.stopped).toBe(false)
    const rare = await measure(t, me, { issue_id: open.id, kind, search: 'quokka' })
    record(`${name}, ${kind}, a rare word`, rare.figures)
    expect(rare.figures).toMatchObject({ rows: 0, stopped: false, end: true })
    if (kind === 'link' && rare.answer.state === 'ok') {
      const cursor = rare.answer.all_projects as string
      const beyond = await measure(t, me, { issue_id: open.id, kind, search: 'quokka', cursor })
      record(`${name}, link, a rare word in all your projects`, beyond.figures)
      expect(beyond.figures).toMatchObject({ rows: 0, stopped: false, end: true })
    }
  }
}

/* An ordinary title of about 80 characters and a short text, the text of
 * the design size. */
const title = (i: number) =>
  `Check the power rails of board ${i} before the firmware team flashes the first build`
const TEXT = 'Measure each rail under load and note any that drift from nominal.'

/* The number of the next task the organizations plant. */
let nextNum = 2_000_000

/** Plants `n` active tasks in `project` with `fields(i)`, a thousand a
 * transaction, each with its description row. */
async function plant(
  t: T,
  project: Doc<'projects'>,
  n: number,
  fields: (i: number) => Partial<Doc<'issues'>> = () => ({}),
): Promise<Doc<'issues'>[]> {
  const out: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += 1000)
    out.push(
      ...(await t.run(async (ctx) => {
        const rows: Doc<'issues'>[] = []
        for (let i = from; i < Math.min(n, from + 1000); i++) {
          const doc = {
            id: uuid(),
            org_id: project.org_id,
            project_id: project.id,
            num: nextNum++,
            title: title(i),
            status: 'progress' as const,
            priority: 'medium' as const,
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            status_at: NOW,
            window_key: newWindowKey(),
            ...fields(i),
          }
          const _id = await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            description: TEXT,
            org_id: doc.org_id,
            project_id: doc.project_id,
          })
          rows.push((await ctx.db.get(_id)) as Doc<'issues'>)
        }
        return rows
      })),
    )
  return out
}

/** The sizes of a picker organization. Unset, each is its everyday value. */
type Sizes = {
  /** the family's live sub-projects, 3 */
  familySubs?: number
  /** the family's archived sub-projects, none */
  familyArchived?: number
  /** the open tasks of the family's sub-project of this index, 30 */
  familyOpen?: (sub: number) => number
  /** Done tasks not yet archived in the family, spread over its
   * sub-projects, none */
  familyDone?: number
  /** the member's teams, 3 */
  teams?: number
  /** every team of the member shares the family, else one */
  everyTeamOnFamily?: boolean
  /** teams the member is not in that share the family too, none */
  familyTeams?: number
}

/**
 * An organization of the everyday values with one figure raised in the
 * family, the first of 20 top-level projects of 3 sub-projects each, every
 * sub-project with 30 open tasks. The member's teams share the top-level
 * projects in turn, so the member reads 60 sub-projects at User, and the
 * open task is the first task of the family's first sub-project.
 */
async function pickerOrg(o: Sizes = {}) {
  const t = newT({ transactionLimits: true })
  const f: OrgFixture = await withOrg(t)
  const familySubs = o.familySubs ?? 3
  const tops: Doc<'projects'>[] = []
  const subs: Doc<'projects'>[][] = []
  for (let i = 0; i < 20; i++) {
    const top = await plantProject(t, {
      org_id: f.org.id,
      ...named(`Programme ${i}`),
      archive_state: 'live',
    })
    tops.push(top)
    const mine: Doc<'projects'>[] = []
    for (let s = 0; s < (i === 0 ? familySubs : 3); s++)
      mine.push(
        await plantProject(t, {
          org_id: f.org.id,
          type: 'project',
          parent_id: top.id,
          ...named(`Workstream ${i}.${s}`),
          archive_state: 'live',
        }),
      )
    subs.push(mine)
  }
  const family = tops[0] as Doc<'projects'>
  for (let s = 0; s < (o.familyArchived ?? 0); s++)
    await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: family.id,
      ...named(`Finished workstream ${s}`),
      archived_at: NOW,
      archive_state: 'under',
    })
  const member = await plantSeat(t, { org_id: f.org.id, name: 'Member', accepted_at: NOW })
  await t.run(async (ctx) => {
    const team = async (name: string, mine: boolean) => {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        ...named(name),
        track_delay_default: false,
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
    for (const [i, top] of tops.entries()) {
      if (i === 0 && o.everyTeamOnFamily === true) for (const one of teams) await share(top, one)
      else await share(top, teams[i % teams.length] as { id: string; name: string })
    }
    for (let i = 0; i < (o.familyTeams ?? 0); i++)
      await share(family, await team(`Other ${i}`, false))
  })
  const opens: Doc<'issues'>[] = []
  for (const [i, mine] of subs.entries())
    for (const [s, sub] of mine.entries()) {
      const planted = await plant(t, sub, i === 0 ? (o.familyOpen?.(s) ?? 30) : 30)
      if (i === 0 && s === 0) opens.push(planted[0] as Doc<'issues'>)
    }
  const done = o.familyDone ?? 0
  for (const [s, sub] of subs[0]?.entries() ?? [])
    await plant(t, sub, Math.floor(done / familySubs) + (s < done % familySubs ? 1 : 0), () => ({
      status: 'done',
      done_at: NOW,
    }))
  return { t, f, member, open: opens[0] as Doc<'issues'>, family, subs }
}

describe('relation picker reads at the design size', () => {
  it('reads a family at everyday values', async () => {
    const e = await pickerOrg()
    await pickers(e.t, 'everyday', e.member, e.open)
  })

  it('reads one project of 3 sub-projects with 800 open tasks', async () => {
    const e = await pickerOrg({ familyOpen: (s) => (s === 0 ? 266 : 267) })
    await pickers(e.t, 'a project of 800 open tasks', e.member, e.open)
  })

  it('reads one sub-project of 300 open tasks beside two everyday ones', async () => {
    const e = await pickerOrg({ familyOpen: (s) => (s === 0 ? 300 : 30) })
    await pickers(e.t, 'a sub-project of 300 open tasks', e.member, e.open)
  })

  it('reads one project of 30 live sub-projects of 20 tasks each and 40 archived ones', async () => {
    const e = await pickerOrg({ familySubs: 30, familyArchived: 40, familyOpen: () => 20 })
    await pickers(e.t, 'a project of 30 and 40 sub-projects', e.member, e.open)
  })

  it('reads one project with 200 Done tasks not yet archived', async () => {
    const e = await pickerOrg({ familyDone: 200 })
    await pickers(e.t, 'a project with 200 Done tasks', e.member, e.open)
  })

  it('reads a member in 5 teams that each share the family', async () => {
    const e = await pickerOrg({ teams: 5, everyTeamOnFamily: true })
    await pickers(e.t, 'a member in 5 teams', e.member, e.open)
  })

  it('reads a family shared with 5 teams', async () => {
    const e = await pickerOrg({ familyTeams: 4 })
    await pickers(e.t, 'a family shared with 5 teams', e.member, e.open)
  })

  it('reads Search all your projects over a catalogue of 2,000 projects, for a member and an admin', async () => {
    // 200 and 500 live, 300 and 1,000 archived, with withOrg's four, 2
    // tasks a live sub-project, and a member who reads 60 sub-projects
    const e = await pageOrg({
      tops: 198,
      subs: 498,
      archivedTops: 300,
      archivedSubs: 1000,
      memberSubs: 60,
      tasks: 1000,
      archived: 0,
    })
    const open = await e.t.run(
      async (ctx) =>
        (await ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', (e.subs[0] as Doc<'projects'>).id))
          .first()) as Doc<'issues'>,
    )
    for (const [who, me] of [
      ['a member of 60 sub-projects', e.member],
      ['an admin of 700 live projects', e.admin],
    ] as const) {
      const family = await measure(e.t, me, { issue_id: open.id, kind: 'link', search: 'quokka' })
      record(`the catalogue, ${who}, the family`, family.figures)
      const cursor = family.answer.state === 'ok' ? (family.answer.all_projects as string) : ''
      const all = await measure(e.t, me, {
        issue_id: open.id,
        kind: 'link',
        search: 'quokka',
        cursor,
      })
      record(`the catalogue, ${who}, a rare word in all your projects`, all.figures)
      expect(all.figures).toMatchObject({ rows: 0, stopped: false, end: true })
      // the family holds fewer than a batch, so a blank search reaches its end
      const first = await measure(e.t, me, { issue_id: open.id, kind: 'link' })
      record(`the catalogue, ${who}, no search in the family`, first.figures)
      expect(first.figures).toMatchObject({ stopped: false, end: true })
      const next = first.answer.state === 'ok' ? (first.answer.all_projects as string) : ''
      const blank = await measure(e.t, me, { issue_id: open.id, kind: 'link', cursor: next })
      record(`the catalogue, ${who}, no search in all your projects`, blank.figures)
      expect(blank.figures).toMatchObject({ rows: 25, stopped: false, end: false })
    }
  })

  it('reads one batch of Search all your projects at its full scan, for an admin', async () => {
    // 167 sub-projects of about 30 tasks, groups' subtasks included, about
    // half the organization's open tasks, every one the admin's to see
    const e = await pageOrg({ tops: 56, subs: 167, tasks: 5000, archived: 0 })
    const open = await e.t.run(
      async (ctx) =>
        (await ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', (e.subs[0] as Doc<'projects'>).id))
          .first()) as Doc<'issues'>,
    )
    const family = await measure(e.t, e.admin, {
      issue_id: open.id,
      kind: 'link',
      search: 'quokka',
    })
    const cursor = family.answer.state === 'ok' ? (family.answer.all_projects as string) : ''
    const all = await measure(e.t, e.admin, {
      issue_id: open.id,
      kind: 'link',
      search: 'quokka',
      cursor,
    })
    record('an admin, a rare word at the full scan', all.figures)
    expect(all.figures).toMatchObject({ rows: 0, stopped: true, end: false })
  })

  it('reads Search all your projects for a member who reads 200 sub-projects, and for one whose team shares 50 live and 150 archived projects', async () => {
    for (const [who, sizes] of [
      ['200 sub-projects', { tops: 70, subs: 206, memberSubs: 200, tasks: 1000, archived: 0 }],
      [
        'a team of 50 live and 150 archived shares',
        { tops: 50, subs: 60, archivedTops: 150, oneTeam: true, tasks: 600, archived: 0 },
      ],
    ] as const) {
      const e = await pageOrg(sizes)
      const open = await e.t.run(
        async (ctx) =>
          (await ctx.db
            .query('issues')
            .withIndex('by_project', (q) =>
              q.eq('project_id', (e.readable[0] as Doc<'projects'>).id),
            )
            .first()) as Doc<'issues'>,
      )
      const family = await measure(e.t, e.member, {
        issue_id: open.id,
        kind: 'link',
        search: 'quokka',
      })
      record(`${who}, the family`, family.figures)
      const cursor = family.answer.state === 'ok' ? (family.answer.all_projects as string) : ''
      const all = await measure(e.t, e.member, {
        issue_id: open.id,
        kind: 'link',
        search: 'quokka',
        cursor,
      })
      record(`${who}, a rare word in all your projects`, all.figures)
      expect(all.figures).toMatchObject({ rows: 0, stopped: false, end: true })
    }
  })
})
