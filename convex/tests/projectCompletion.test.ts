/* REST and MCP project completion from the counts every task writer keeps
 * (lib/core.ts projectCompletion over model/overviewCounts.ts
 * familyCounts). It counts the leaves of the sub-projects the caller can
 * read, by the stored leaf rule, the Overview's figure, answers `counting`
 * while the counts are not whole and `unavailable` where the request has
 * no room left to read them, never failing the read or the update that
 * answers it, and reads no task at all. Every fixture is counted first (overviewCounts.setup.ts
 * countOrg), as every organization is on a deployment. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  COUNTING_COMPLETION,
  type CompletionJson,
  loadCatalogue,
  NO_TASKS,
  projectCompletion,
  UNAVAILABLE_COMPLETION,
} from '../lib/core'
import { byId } from '../lib/db'
import { getProject } from '../machine/rest'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  settleScheduled,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { countOrg, countStep } from './overviewCounts.setup'

type Fx = OrgFixture & { t: T; fwOnly: Doc<'profiles'> }

/* withOrg, with the agent holding User access on TBED, and a person who
 * holds it on FW alone, so PCB is hidden from them. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withReadingAdmin(t)
  const fwOnly = await plantLogin(
    t,
    await plantSeat(t, { org_id: f.org.id, name: 'Firmware only' }),
  )
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
    await ctx.db.insert('project_access', {
      project_id: f.sub.id,
      profile_id: fwOnly.id,
      level: 'user',
    })
  })
  return { t, ...f, fwOnly }
}

/* REST GET /v1/projects/{ref}'s completion for `callerId`. */
const restCompletion = async (fx: Pick<Fx, 't'>, callerId: string, ref: string) =>
  (await fx.t.query(internal.machine.rest.getProject, { callerId, access: 'read', ref })).completion

/* MCP get_project's completion for `callerId`. */
const mcpCompletion = async (fx: Pick<Fx, 't'>, callerId: string, project: string) =>
  (
    JSON.parse(
      await fx.t.query(internal.machine.projects.mcpGetProject, {
        callerId,
        access: 'read',
        project,
      }),
    ) as { completion: CompletionJson | null }
  ).completion

/* REST PATCH /v1/projects/{ref} and MCP update_project for `callerId`,
 * each changing the description, answering the completion they send. */
async function updates(fx: Fx, callerId: string, ref: string) {
  const rest = await fx.t.mutation(internal.machine.projects.restUpdateProject, {
    callerId,
    access: 'write',
    keyName: 'drive',
    ref,
    body: JSON.stringify({ description: `Changed over REST ${uuid().slice(0, 4)}` }),
  })
  const mcp = JSON.parse(
    await fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
      callerId,
      access: 'write',
      project: ref,
      description: `Changed over MCP ${uuid().slice(0, 4)}`,
    }),
  ) as { completion: CompletionJson | null }
  return { rest: rest.completion, mcp: mcp.completion }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> & { project_id: string }) =>
  plantIssue(fx.t, { org_id: fx.org.id, ...over })

/* FW holds a Done leaf, a To Do leaf, a group whose one subtask is in PCB,
 * and a task whose one subtask is in SKNK, another top-level project, which
 * makes it a group by the stored rule. PCB holds the group's subtask and a
 * Done leaf. */
async function plantFamily(fx: Fx) {
  await task(fx, { project_id: fx.sub.id, status: 'done' })
  await task(fx, { project_id: fx.sub.id })
  const group = await task(fx, { project_id: fx.sub.id, title: 'Group' })
  await task(fx, { project_id: fx.sub2.id, parent_id: group.id })
  await task(fx, { project_id: fx.sub2.id, status: 'done' })
  const legacy = await task(fx, { project_id: fx.sub.id, title: 'Legacy parent' })
  await task(fx, { project_id: fx.hidden.id, parent_id: legacy.id })
}

const ok = (done: number, total: number): CompletionJson => ({
  status: 'ok',
  done,
  total,
  percent: total === 0 ? 0 : Math.round((done / total) * 100),
})

/* A handler run inside `ctx`, so a test can read the metrics after it. */
const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

/* What `run` read, by Convex's counts. */
async function readsOf<R>(ctx: QueryCtx, run: () => Promise<R>) {
  const before = await ctx.meta.getTransactionMetrics()
  const out = await run()
  const after = await ctx.meta.getTransactionMetrics()
  return {
    out,
    ranges: after.databaseQueries.used - before.databaseQueries.used,
    documents: after.documentsRead.used - before.documentsRead.used,
  }
}

/* The ranges REST GET /v1/projects/{ref} reads for `callerId`. */
const rangesOfGet = (t: T, callerId: string, ref: string) =>
  t.query(async (ctx) => {
    await handlerOf<{ callerId: string; access: 'read'; ref: string }, unknown>(getProject)(ctx, {
      callerId,
      access: 'read',
      ref,
    })
    return (await ctx.meta.getTransactionMetrics()).databaseQueries.used
  })

/* setup, with AWAY, a sub-project of SKNK that the user leads, archived
 * or not, and in FW a To Do parent whose only subtask older code stored in
 * AWAY, beside a Done leaf, counted. */
async function legacyFamily(archived: boolean) {
  const fx = await setup()
  const away = await plantProject(fx.t, {
    org_id: fx.org.id,
    type: 'project',
    parent_id: fx.hidden.id,
    key: 'AWAY',
    ...(archived ? { archived_at: NOW } : {}),
  })
  const legacy = await task(fx, { project_id: fx.sub.id, title: 'Legacy parent' })
  await task(fx, { project_id: away.id, parent_id: legacy.id })
  await task(fx, { project_id: fx.sub.id, status: 'done' })
  await countOrg(fx.t, fx.org.id)
  return { ...fx, away }
}

/* FW's and TBED's completion for the agent, over REST and MCP. */
async function legacyReads(fx: Fx) {
  const out: Record<string, CompletionJson | null> = {}
  for (const ref of ['FW', 'TBED']) {
    out[`rest ${ref}`] = await restCompletion(fx, fx.agent.id, ref)
    out[`mcp ${ref}`] = await mcpCompletion(fx, fx.agent.id, ref)
  }
  return out
}

/* What legacyReads answers when every read is `c`. */
const everywhere = (c: CompletionJson) => ({
  'rest FW': c,
  'mcp FW': c,
  'rest TBED': c,
  'mcp TBED': c,
})

/* REST PATCH /v1/projects/{ref} archiving or restoring `project` as the
 * user, who leads TBED and SKNK. */
const restArchive = (fx: Fx, project: Doc<'projects'>, archived: boolean) =>
  fx.t.mutation(internal.machine.projects.restUpdateProject, {
    callerId: fx.user.id,
    access: 'write',
    keyName: 'drive',
    ref: project.key,
    body: JSON.stringify({ archived }),
  })

describe('project completion from the counts', () => {
  it('counts the leaves of the sub-projects each reader can read, on both reads and both updates', async () => {
    const fx = await setup()
    await plantFamily(fx)
    await countOrg(fx.t, fx.org.id)
    // FW counts the Done and the To Do leaf, PCB the subtask and its Done leaf
    const fw = ok(1, 2)
    const whole = ok(2, 4)
    for (const [caller, ref, want] of [
      [fx.agent, 'TBED', whole],
      [fx.agent, 'FW', fw],
      [fx.agent, 'PCB', ok(1, 2)],
      // the reader of FW alone counts FW only, also under TBED
      [fx.fwOnly, 'FW', fw],
      [fx.fwOnly, 'TBED', fw],
    ] as const) {
      expect(await restCompletion(fx, caller.id, ref), `${caller.name} ${ref}`).toEqual(want)
      expect(await mcpCompletion(fx, caller.id, ref), `${caller.name} ${ref}`).toEqual(want)
    }
    // the updates answer the same, and the change commits
    expect(await updates(fx, fx.user.id, 'TBED')).toEqual({ rest: whole, mcp: whole })
    expect(await updates(fx, fx.user.id, 'FW')).toEqual({ rest: fw, mcp: fw })
    expect((await fx.t.run((ctx) => byId(ctx, 'projects', fx.sub.id)))?.description).toMatch(
      /^Changed over MCP/,
    )
  })

  it('equals the Overview summary’s Completion for the same scope', async () => {
    const fx = await setup()
    await plantFamily(fx)
    await countOrg(fx.t, fx.org.id)
    for (const me of [fx.user, fx.guest, fx.fwOnly])
      for (const project of [fx.meta, fx.sub]) {
        const scope = { kind: 'project', org_id: fx.org.id, project_id: project.id } as const
        const summary = await as(fx.t, me).query(api.overview.summary, {
          scope,
          day: '2026-09-09',
        })
        if (summary.state !== 'ok' || summary.counts.state !== 'ok')
          throw new Error(JSON.stringify(summary))
        const leaves = summary.counts.leaves
        const total = Object.values(leaves).reduce((n, c) => n + c, 0)
        expect(await restCompletion(fx, me.id, project.key), `${me.name} ${project.key}`).toEqual(
          ok(leaves.done, total),
        )
      }
  })

  it('keeps a parent whose only subtask is hidden or in another top-level project a group', async () => {
    const fx = await setup()
    // FW holds a parent whose one subtask is in PCB, which fwOnly cannot read,
    // one whose one subtask is in SKNK, and one leaf
    const hidden = await task(fx, { project_id: fx.sub.id, title: 'Hidden subtask' })
    await task(fx, { project_id: fx.sub2.id, parent_id: hidden.id })
    const away = await task(fx, { project_id: fx.sub.id, title: 'Away subtask' })
    const sknkSub = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.hidden.id,
    })
    await task(fx, { project_id: sknkSub.id, parent_id: away.id })
    await task(fx, { project_id: fx.sub.id, status: 'done' })
    await countOrg(fx.t, fx.org.id)
    for (const caller of [fx.fwOnly, fx.agent, fx.admin])
      expect(await restCompletion(fx, caller.id, 'FW'), caller.name).toEqual(ok(1, 1))
  })

  it('answers counting while the counts are not whole, and the figure once they are', async () => {
    const fx = await setup()
    await plantFamily(fx)
    // not counted yet, as before the backfill
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual(COUNTING_COMPLETION)
    expect(await mcpCompletion(fx, fx.agent.id, 'FW')).toEqual(COUNTING_COMPLETION)
    // while the backfill counts it
    const first = await countStep(fx.t, fx.org.id)
    expect(first.done).toBe(false)
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(COUNTING_COMPLETION)
    await countOrg(fx.t, fx.org.id)
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual(ok(2, 4))
    // a sub-project archived starts a regroup of its family in the same
    // transaction, so its siblings count again once its steps have run
    const setArchived = (archived: boolean) =>
      fx.t.mutation(internal.machine.projects.restUpdateProject, {
        callerId: fx.user.id,
        access: 'write',
        keyName: 'drive',
        ref: 'PCB',
        body: JSON.stringify({ archived }),
      })
    expect((await setArchived(true)).completion).toBeNull()
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(COUNTING_COMPLETION)
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual(COUNTING_COMPLETION)
    await fx.t.finishAllScheduledFunctions(() => {})
    // the group's subtask is archived away, so the group is a leaf again
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(ok(1, 3))
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual(ok(1, 3))
    // a restore answers counting in its own answer, on both surfaces
    const restored = JSON.parse(
      await fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        callerId: fx.user.id,
        access: 'write',
        project: 'PCB',
        archived: false,
      }),
    ) as { completion: CompletionJson | null }
    expect(restored.completion).toEqual(COUNTING_COMPLETION)
    await fx.t.finishAllScheduledFunctions(() => {})
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual(ok(2, 4))
    // archived again and restored over REST
    expect((await setArchived(true)).completion).toBeNull()
    await fx.t.finishAllScheduledFunctions(() => {})
    expect((await setArchived(false)).completion).toEqual(COUNTING_COMPLETION)
    await fx.t.finishAllScheduledFunctions(() => {})
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual(ok(2, 4))
    // a count row below zero, which a bug would leave, until a recount
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('overview_counts')
        .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
        .first()
      if (row !== null) await ctx.db.patch(row._id, { leaves: { ...row.leaves, todo: -1 } })
    })
    expect([
      await restCompletion(fx, fx.agent.id, 'FW'),
      await restCompletion(fx, fx.agent.id, 'PCB'),
    ]).toContainEqual(COUNTING_COMPLETION)
  })

  it('answers counting in the family of a parent whose only subtask is in another family, from that family’s archive until its steps have run', async () => {
    const fx = await legacyFamily(false)
    // the parent is a group while its subtask's project is live
    expect(await legacyReads(fx)).toEqual(everywhere(ok(1, 1)))
    // archived: TBED's counts still hold the parent a group until SKNK's
    // regroup reaches it, so they answer counting, never the stale figure
    expect((await restArchive(fx, fx.away, true)).completion).toBeNull()
    expect(await legacyReads(fx)).toEqual(everywhere(COUNTING_COMPLETION))
    await fx.t.finishAllScheduledFunctions(() => {})
    // its only subtask archived away, the parent is a To Do leaf
    expect(await legacyReads(fx)).toEqual(everywhere(ok(1, 2)))
  })

  it('answers counting in the family of a parent whose only subtask is in another family, from that family’s restore until its steps have run', async () => {
    const fx = await legacyFamily(true)
    // the parent is a leaf while its subtask's project is archived
    expect(await legacyReads(fx)).toEqual(everywhere(ok(1, 2)))
    // restored: TBED's counts still hold the parent a leaf until SKNK's
    // regroup reaches it, so they answer counting, as the restore's own
    // answer does
    expect((await restArchive(fx, fx.away, false)).completion).toEqual(COUNTING_COMPLETION)
    expect(await legacyReads(fx)).toEqual(everywhere(COUNTING_COMPLETION))
    await fx.t.finishAllScheduledFunctions(() => {})
    expect(await legacyReads(fx)).toEqual(everywhere(ok(1, 1)))
  })

  it('answers unavailable where the request has no room for the counts, and the update commits', async () => {
    // the ranges the read and the update take with 30 sub-projects under
    // TBED, the most one project holds at the design size
    const plant = async (t: T) => {
      const fx = await setup(t)
      for (let i = 0; i < 28; i++)
        await plantProject(t, { org_id: fx.org.id, type: 'project', parent_id: fx.meta.id })
      await plantFamily(fx)
      await countOrg(t, fx.org.id)
      return fx
    }
    const free = await plant(newT())
    const get = await rangesOfGet(free.t, free.agent.id, 'TBED')
    expect(await restCompletion(free, free.agent.id, 'TBED')).toEqual(ok(2, 4))
    // a request limit below what the read takes with its completion but
    // above what it takes without, which COMPLETION_RESERVE leaves no room in
    const limited = await plant(newT({ transactionLimits: { databaseQueries: get - 10 } }))
    expect(await restCompletion(limited, limited.agent.id, 'TBED')).toEqual(UNAVAILABLE_COMPLETION)
    expect(await mcpCompletion(limited, limited.agent.id, 'TBED')).toEqual(UNAVAILABLE_COMPLETION)
    expect(await updates(limited, limited.user.id, 'TBED')).toEqual({
      rest: UNAVAILABLE_COMPLETION,
      mcp: UNAVAILABLE_COMPLETION,
    })
    expect(
      (await limited.t.run((ctx) => byId(ctx, 'projects', limited.meta.id)))?.description,
    ).toMatch(/^Changed over MCP/)
  })

  it('reads no task, 33 ranges for a project of 30 sub-projects, however many tasks they hold', async () => {
    const fx = await setup()
    const subs = [fx.sub, fx.sub2]
    for (let i = 0; i < 28; i++)
      subs.push(
        await plantProject(fx.t, { org_id: fx.org.id, type: 'project', parent_id: fx.meta.id }),
      )
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: fx.org.id,
          project_id: (subs[i % 30] as Doc<'projects'>).id,
          num: 50_000 + i,
          title: `Check the supplier quotes against the budget, step ${i}`,
          status: i % 3 === 0 ? 'done' : 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
    })
    await countOrg(fx.t, fx.org.id)
    const read = () =>
      fx.t.query(async (ctx) => {
        const me = (await byId(ctx, 'profiles', fx.agent.id)) as Doc<'profiles'>
        const cat = await loadCatalogue(ctx, me)
        const project = (await byId(ctx, 'projects', fx.meta.id)) as Doc<'projects'>
        return await readsOf(ctx, () =>
          projectCompletion(ctx, project, { cat, readable: () => true }),
        )
      })
    const before = await read()
    expect(before.out).toEqual(ok(100, 300))
    expect(before.ranges).toBe(33)
    expect(before.documents).toBeLessThanOrEqual(3 + 4 * 30)
    // 300 tasks more, written past the counts, are never read
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: fx.org.id,
          project_id: (subs[i % 30] as Doc<'projects'>).id,
          num: 60_000 + i,
          title: `Unread ${i}`,
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
    })
    expect(await read()).toEqual(before)
  })

  it('answers null for an archived project, zeros for a new one without a read, and NO_TASKS where it counts nothing', async () => {
    const fx = await setup()
    await plantFamily(fx)
    await countOrg(fx.t, fx.org.id)
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.sub2._id, { archived_at: NOW })
    })
    expect(await restCompletion(fx, fx.agent.id, 'PCB')).toBeNull()
    const created = JSON.parse(
      await fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        callerId: fx.user.id,
        access: 'write',
        name: 'Optics',
        parent: 'TBED',
      }),
    ) as { completion: CompletionJson | null }
    expect(created.completion).toEqual(NO_TASKS)
    // a top-level project without a live sub-project counts none
    const empty = await plantProject(fx.t, { org_id: fx.org.id, key: 'EMPTY', lead_id: fx.user.id })
    expect(await restCompletion(fx, fx.user.id, empty.key)).toEqual(NO_TASKS)
    await settleScheduled(fx.t)
  })
})
