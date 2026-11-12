/* The view filter's Assignee menu's people (pickers.viewOwners,
 * model/pickers.ts viewOwnersOf): the owners of the tasks of the project a
 * Board or a Roadmap selects, and nobody else of the organization (the
 * owner's decision of 12 November 2026). It holds who is an owner, the
 * selection a caller reads, the rows and the match, the states and the
 * read budget, and closes with the reads at the design size's tasks of one
 * project. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { LIMITS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { VIEW_OWNERS, type ViewOwnersAnswer, viewOwnersOf } from '../model/pickers'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const DEFAULT_READS = structuredClone(VIEW_OWNERS.reads)
afterEach(() => {
  Object.assign(VIEW_OWNERS.reads, DEFAULT_READS)
})

type Ready = Extract<ViewOwnersAnswer, { state: 'ready' }>

const owners = (t: T, caller: Doc<'profiles'>, projectId: string, search?: string) =>
  as(t, caller).query(api.pickers.viewOwners, {
    org_id: caller.org_id,
    project_id: projectId,
    ...(search === undefined ? {} : { search }),
  })

function ready(answer: ViewOwnersAnswer): Ready {
  if (answer.state !== 'ready') throw new Error(`expected rows, got ${JSON.stringify(answer)}`)
  return answer
}

const idsOf = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort()

/* withOrg, whose `user` leads TBED with the sub-projects Firmware and Board
 * rev, with planters for a person and a task. */
async function base(t: T = newT()) {
  const f = await withOrg(t)
  const person = (name: string, extra: Partial<Doc<'profiles'>> = {}) =>
    plantSeat(t, {
      org_id: f.org.id,
      name,
      initials: name
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .toUpperCase(),
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@testbed.test`,
      accepted_at: NOW,
      auth_user_id: uuid(),
      ...extra,
    })
  const task = (project: Doc<'projects'>, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: project.org_id, project_id: project.id, ...extra })
  return { t, f, person, task }
}

describe('who the Assignee menu offers', () => {
  it("offers the owners of the selected sub-project's tasks, and nobody else", async () => {
    const b = await base()
    const { t, f } = b
    const anna = await b.person('Anna Fält')
    const bo = await b.person('Bo Winter')
    const cy = await b.person('Cy Reviewer')
    const dan = await b.person('Dan Done')
    const eve = await b.person('Eve Elsewhere')
    const gone = await b.person('Gil Archived')
    const idle = await b.person('Ida Idle')
    await b.task(f.sub, { assignee_id: anna.id })
    await b.task(f.sub, { assignee_id: anna.id, status: 'progress' })
    // In review the reviewer owns the task, as the filter matches it
    await b.task(f.sub, { assignee_id: bo.id, reviewer_id: cy.id, status: 'review' })
    // a reviewer who does not own yet, and a Done task not yet archived
    await b.task(f.sub, { assignee_id: dan.id, reviewer_id: idle.id, status: 'done' })
    await b.task(f.sub)
    // an archived task, and a task of the sibling sub-project
    await b.task(f.sub, { assignee_id: gone.id, archived_at: NOW })
    await b.task(f.sub2, { assignee_id: eve.id })

    const rows = ready(await owners(t, f.user, f.sub.id)).rows
    expect(idsOf(rows)).toEqual(idsOf([anna, cy, dan]))
    // in the order of the name keys
    const keys = rows.map((r) => nameKey(r.name))
    expect(keys).toEqual([...keys].sort())
    expect(ready(await owners(t, f.user, f.sub2.id)).rows.map((r) => r.id)).toEqual([eve.id])
    // the top-level project selects both sub-projects
    expect(idsOf(ready(await owners(t, f.user, f.meta.id)).rows)).toEqual(
      idsOf([anna, cy, dan, eve]),
    )
  })

  it('reads only the sub-projects the caller can see under a top-level project', async () => {
    const b = await base()
    const { t, f } = b
    const anna = await b.person('Anna Fält')
    const eve = await b.person('Eve Elsewhere')
    // Lin reaches Firmware alone
    const lin = await b.person('Lin Park')
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: lin.id,
        level: 'viewer',
      }),
    )
    await b.task(f.sub, { assignee_id: anna.id })
    await b.task(f.sub2, { assignee_id: eve.id })
    expect(ready(await owners(t, lin, f.meta.id)).rows.map((r) => r.id)).toEqual([anna.id])
    expect(ready(await owners(t, lin, f.sub.id)).rows.map((r) => r.id)).toEqual([anna.id])
    expect(await owners(t, lin, f.sub2.id)).toEqual({ state: 'unavailable' })
  })

  it('leaves out an owner the organization does not hold', async () => {
    const b = await base()
    const { t, f } = b
    const anna = await b.person('Anna Fält')
    await b.task(f.sub, { assignee_id: anna.id })
    await b.task(f.sub, { assignee_id: f.otherAdmin.id })
    await b.task(f.sub, { assignee_id: uuid() })
    expect(ready(await owners(t, f.user, f.sub.id)).rows.map((r) => r.id)).toEqual([anna.id])
  })
})

describe("the Assignee menu's rows and match", () => {
  it('answers the name, initials and color, never an email, and finds nobody by an email', async () => {
    const b = await base()
    const { t, f } = b
    const anna = await b.person('Anna Fält', { color: 'teal', email: 'anna@qivo.test' })
    const erik = await b.person('Erik Holm')
    await b.task(f.sub, { assignee_id: anna.id })
    await b.task(f.sub, { assignee_id: erik.id })
    const answer = ready(await owners(t, f.guest, f.sub.id, 'anna'))
    expect(answer).toEqual({
      state: 'ready',
      rows: [{ id: anna.id, name: 'Anna Fält', initials: 'AF', color: '#8A8F98' }],
      next: null,
      stopped: false,
    })
    // reordered fragments, case and blanks, initials; accents stay
    for (const search of ['ält ann', '  FÄ\tNA ', 'af'])
      expect(idsOf(ready(await owners(t, f.user, f.sub.id, search)).rows), search).toEqual([
        anna.id,
      ])
    for (const search of ['anna@qivo.test', 'qivo.test', 'qivo anna', 'falt', 'anna erik'])
      expect(ready(await owners(t, f.user, f.sub.id, search)).rows, search).toEqual([])
  })

  it('refuses a search past LIMITS.search with its sentence', async () => {
    const { t, f } = await base()
    const e = await expectRefusal(
      owners(t, f.user, f.sub.id, 'x'.repeat(LIMITS.search.max + 1)),
      'rule',
    )
    expect(e.data.message).toBe(LIMITS.search.refusal)
  })
})

describe("the Assignee menu's states", () => {
  it('answers unavailable alike for a project the caller’s views do not select', async () => {
    const b = await base()
    const { t, f } = b
    const anna = await b.person('Anna Fält')
    await b.task(f.hidden, { assignee_id: anna.id })
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    for (const [caller, project] of [
      [f.user, uuid()],
      [f.user, f.otherProject.id],
      [f.user, archived.id],
      // the guest holds nothing on Skunkworks, and the admin nothing at all
      [f.guest, f.hidden.id],
      [f.admin, f.sub.id],
    ] as const)
      expect(await owners(t, caller, project), project).toEqual({ state: 'unavailable' })
  })

  it('refuses a login without a seat in the organization', async () => {
    const { t, f } = await base()
    await expectRefusal(
      as(t, f.otherAdmin).query(api.pickers.viewOwners, {
        org_id: f.org.id,
        project_id: f.sub.id,
      }),
      'forbidden',
    )
  })

  it('answers over_budget, with no row, past a lowered VIEW_OWNERS.reads', async () => {
    const b = await base()
    const { t, f } = b
    for (let i = 0; i < 12; i++)
      await b.task(f.sub, { assignee_id: (await b.person(`Member ${i}`)).id })
    expect(ready(await owners(t, f.user, f.sub.id)).rows).toHaveLength(12)
    VIEW_OWNERS.reads.documents = 8
    expect(await owners(t, f.user, f.sub.id)).toEqual({ state: 'over_budget' })
  })
})

describe("the Assignee menu inside Convex's limits", () => {
  it("reads the owners of a project's 800 open and 200 Done tasks", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 50 people hold the tasks of the top-level project's two sub-projects
    // and a third, three sub-projects a project being the everyday figure
    const third = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const subs = [f.sub, f.sub2, third]
    const people: Doc<'profiles'>[] = []
    for (let i = 0; i < 50; i++)
      people.push(
        await plantSeat(t, {
          org_id: f.org.id,
          name: `Member ${String(i).padStart(2, '0')}`,
          accepted_at: NOW,
          auth_user_id: uuid(),
        }),
      )
    let num = 40_000
    for (let from = 0; from < 1000; from += 250)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 250; i++)
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: subs[i % subs.length].id,
            num: num++,
            title:
              'Replace the fan controller on the bench rig and log the readings for the review',
            description: '',
            status: i < 800 ? 'todo' : 'done',
            priority: 'medium',
            paused: false,
            assignee_id: people[i % people.length].id,
            created_at: NOW,
            updated_at: NOW,
          })
      })
    const read = await t.run(async (ctx) => {
      const answer = await viewOwnersOf(ctx, f.user, { project_id: f.meta.id })
      const m = await ctx.meta.getTransactionMetrics()
      return {
        answer,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / 1024 / 1024) * 1000) / 1000,
      }
    })
    const answer = ready(read.answer)
    console.info('view owners: 1,000 active tasks of a project, 50 owners', {
      ranges: read.ranges,
      documents: read.documents,
      mib: read.mib,
      rows: answer.rows.length,
    })
    expect(idsOf(answer.rows)).toEqual(idsOf(people))
    // the tasks once, a profile an owner and the caller's access rows
    expect(read.documents).toBeLessThanOrEqual(1200)
    // the public query answers the same under the deployment's limits
    expect(ready(await owners(t, f.user, f.meta.id)).rows).toEqual(answer.rows)
  }, 60_000)
})
