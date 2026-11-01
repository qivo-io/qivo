/* REST and MCP project completion within a read budget (lib/core.ts
 * projectCompletion): a reader of the whole family counts from the
 * family's tasks, any other reader from the tasks it can read with a check
 * of each for subtasks, and past COMPLETION_READS the completion says it is
 * unavailable, never failing the read or the update that answers it. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  COMPLETION_CHECK_READS,
  COMPLETION_READS,
  type CompletionJson,
  UNAVAILABLE_COMPLETION,
} from '../lib/core'
import { ONE_LEVEL_SINCE } from '../lib/viewReads'
import { getProject } from '../machine/rest'
import {
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  withOrg,
} from './helpers.setup'

const READS = structuredClone(COMPLETION_READS)
const CHECK_READS = structuredClone(COMPLETION_CHECK_READS)
afterEach(() => {
  Object.assign(COMPLETION_READS, structuredClone(READS))
  Object.assign(COMPLETION_CHECK_READS, structuredClone(CHECK_READS))
})

type Fx = OrgFixture & { t: T; fwOnly: Doc<'profiles'> }

/* withOrg, with the agent holding User access on TBED, and a person who
 * holds it on FW alone, so PCB is hidden from them. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  const fwOnly = await plantSeat(t, { org_id: f.org.id, name: 'Firmware only' })
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
const restCompletion = async (fx: Fx, callerId: string, ref: string) =>
  (await fx.t.query(internal.machine.rest.getProject, { callerId, access: 'read', ref })).completion

/* MCP get_project's completion for `callerId`. */
const mcpCompletion = async (fx: Fx, callerId: string, project: string) =>
  (
    JSON.parse(
      await fx.t.query(internal.machine.projects.mcpGetProject, {
        callerId,
        access: 'read',
        project,
      }),
    ) as { completion: CompletionJson | null }
  ).completion

/* What REST GET /v1/projects/{ref} read in documents for `callerId`. */
const documentsRead = (fx: Fx, callerId: string, ref: string) =>
  fx.t.query(async (ctx) => {
    const handler = (
      getProject as unknown as {
        _handler: (
          ctx: QueryCtx,
          a: { callerId: string; access: 'read'; ref: string },
        ) => Promise<unknown>
      }
    )._handler
    await handler(ctx, { callerId, access: 'read', ref })
    return (await ctx.meta.getTransactionMetrics()).documentsRead.used
  })

const task = (fx: Fx, over: Partial<Doc<'issues'>> & { project_id: string }) =>
  plantIssue(fx.t, { org_id: fx.org.id, ...over })

/* FW holds a Done leaf, a To Do leaf, a group whose one subtask is in PCB,
 * and a task whose one subtask is in SKNK, another family, which makes it
 * no group. PCB holds the group's subtask and a leaf. */
async function plantFamily(fx: Fx) {
  await task(fx, { project_id: fx.sub.id, status: 'done' })
  await task(fx, { project_id: fx.sub.id })
  const group = await task(fx, { project_id: fx.sub.id, title: 'Group' })
  await task(fx, { project_id: fx.sub2.id, parent_id: group.id })
  await task(fx, { project_id: fx.sub2.id, status: 'done' })
  const legacy = await task(fx, { project_id: fx.sub.id, title: 'Legacy parent' })
  await task(fx, { project_id: fx.hidden.id, parent_id: legacy.id })
}

describe('project completion', () => {
  it('counts the same from the family for a reader of all of it and from checks for a reader of part', async () => {
    const fx = await setup()
    await plantFamily(fx)
    const fw = { status: 'ok', done: 1, total: 3, percent: 33 }
    // the agent reads TBED's whole family; FW's leaves and PCB's two
    expect(await restCompletion(fx, fx.agent.id, 'TBED')).toEqual({
      status: 'ok',
      done: 2,
      total: 5,
      percent: 40,
    })
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(fw)
    // the reader of FW alone counts the group as one, though its subtask is
    // hidden, and the parent of a subtask in another family as a leaf
    expect(await restCompletion(fx, fx.fwOnly.id, 'FW')).toEqual(fw)
    expect(await mcpCompletion(fx, fx.fwOnly.id, 'FW')).toEqual(fw)
    expect(await restCompletion(fx, fx.fwOnly.id, 'TBED')).toEqual(fw)
  })

  it("reads none of a hidden sub-project's other tasks for a reader of part of the family", async () => {
    const fx = await setup()
    await plantFamily(fx)
    const before = await documentsRead(fx, fx.fwOnly.id, 'FW')
    const wholeBefore = await documentsRead(fx, fx.agent.id, 'FW')
    for (let i = 0; i < 50; i++) await task(fx, { project_id: fx.sub2.id, title: `Hidden ${i}` })
    expect(await documentsRead(fx, fx.fwOnly.id, 'FW')).toBe(before)
    // the reader of the whole family reads PCB's tasks too
    expect(await documentsRead(fx, fx.agent.id, 'FW')).toBe(wholeBefore + 50)
    // and whether the partial count fits follows only what it reads, as a
    // whole reader's does once the family does not fit beside FW's checks
    COMPLETION_READS.documents = 9
    const fw = { status: 'ok', done: 1, total: 3, percent: 33 }
    expect(await restCompletion(fx, fx.fwOnly.id, 'FW')).toEqual(fw)
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(fw)
  })

  it('counts a small sub-project of a large family for an admin by checks, and a top-level project from its family', async () => {
    const fx = await setup()
    await plantFamily(fx)
    for (let i = 0; i < 300; i++) await task(fx, { project_id: fx.sub2.id, title: `Sibling ${i}` })
    const fw = { status: 'ok', done: 1, total: 3, percent: 33 }
    // the family fits: one read of it
    expect(await restCompletion(fx, fx.admin.id, 'FW')).toEqual(fw)
    // a budget FW's own tasks and checks fit and PCB's 300 tasks do not
    COMPLETION_READS.documents = 100
    expect(await restCompletion(fx, fx.admin.id, 'FW')).toEqual(fw)
    expect(await mcpCompletion(fx, fx.admin.id, 'FW')).toEqual(fw)
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(fw)
    // a top-level project counts PCB's tasks itself, which do not fit
    expect(await restCompletion(fx, fx.admin.id, 'TBED')).toEqual(UNAVAILABLE_COMPLETION)
  })

  it('answers unavailable past its budget on both reads and both updates, and the update commits', async () => {
    const fx = await setup()
    for (let i = 0; i < 20; i++) await task(fx, { project_id: fx.sub.id })
    COMPLETION_READS.documents = 10
    expect(await restCompletion(fx, fx.user.id, 'FW')).toEqual(UNAVAILABLE_COMPLETION)
    expect(await mcpCompletion(fx, fx.user.id, 'FW')).toEqual(UNAVAILABLE_COMPLETION)
    const rest = await fx.t.mutation(internal.machine.projects.restUpdateProject, {
      callerId: fx.user.id,
      access: 'write',
      keyName: 'drive',
      ref: 'FW',
      body: JSON.stringify({ name: 'Firmware renamed' }),
    })
    expect(rest).toMatchObject({ name: 'Firmware renamed', completion: UNAVAILABLE_COMPLETION })
    const mcp = JSON.parse(
      await fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        callerId: fx.user.id,
        access: 'write',
        project: 'FW',
        description: 'Changed by MCP',
      }),
    )
    expect(mcp).toMatchObject({ description: 'Changed by MCP', completion: UNAVAILABLE_COMPLETION })
    const stored = await fx.t.run((ctx) => ctx.db.get(fx.sub._id))
    expect(stored).toMatchObject({ name: 'Firmware renamed', description: 'Changed by MCP' })
    Object.assign(COMPLETION_READS, structuredClone(READS))
    expect(await restCompletion(fx, fx.user.id, 'FW')).toEqual({
      status: 'ok',
      done: 0,
      total: 20,
      percent: 0,
    })
  })

  it("counts a whole reader's family that fits its budget, however many subtasks its tasks keep in an archived sibling", async () => {
    const fx = await setup()
    // FW's 20 tasks each keep six active subtasks in a sibling archived
    // since, which make no task a group, beside 100 tasks in PCB
    const shelf = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      archived_at: NOW,
    })
    for (let i = 0; i < 20; i++) {
      const parent = await task(fx, { project_id: fx.sub.id })
      for (let k = 0; k < 6; k++) await task(fx, { project_id: shelf.id, parent_id: parent.id })
    }
    for (let i = 0; i < 100; i++) await task(fx, { project_id: fx.sub2.id })
    // the family's 120 live tasks fit, though the subtasks a check of each
    // of FW's tasks would read do not fit beside them
    COMPLETION_READS.documents = 130
    const fw = { status: 'ok', done: 0, total: 20, percent: 0 }
    expect(await restCompletion(fx, fx.admin.id, 'FW')).toEqual(fw)
    expect(await mcpCompletion(fx, fx.agent.id, 'FW')).toEqual(fw)
    // a family that does not fit counts by checks, which read those 120
    // subtasks within COMPLETION_CHECK_READS, and past it says unavailable
    COMPLETION_READS.documents = 60
    expect(await restCompletion(fx, fx.admin.id, 'FW')).toEqual(fw)
    COMPLETION_CHECK_READS.documents = 100
    expect(await restCompletion(fx, fx.admin.id, 'FW')).toEqual(UNAVAILABLE_COMPLETION)
  })

  it('counts groups created under the rule of one level the same on both reads', async () => {
    const fx = await setup()
    // created after ONE_LEVEL_SINCE, so a subtask holds no subtasks of its own
    const later = (i: number) => new Date(Date.parse(ONE_LEVEL_SINCE) + i * 60_000).toISOString()
    const group = await task(fx, { project_id: fx.sub.id, created_at: later(0) })
    await task(fx, {
      project_id: fx.sub.id,
      parent_id: group.id,
      status: 'done',
      created_at: later(1),
    })
    // a group whose one subtask is in PCB, which the reader of FW alone cannot read
    const away = await task(fx, { project_id: fx.sub.id, created_at: later(2) })
    await task(fx, { project_id: fx.sub2.id, parent_id: away.id, created_at: later(3) })
    await task(fx, { project_id: fx.sub.id, created_at: later(4) })
    const fw = { status: 'ok', done: 1, total: 2, percent: 50 }
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(fw)
    expect(await restCompletion(fx, fx.fwOnly.id, 'FW')).toEqual(fw)
    // a whole reader counts by checks too, once PCB does not fit beside them
    for (let i = 0; i < 20; i++) await task(fx, { project_id: fx.sub2.id })
    COMPLETION_READS.documents = 12
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(fw)
  })

  it('answers null for an archived project and ok zeros for an empty one', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.sub2._id, { archived_at: NOW })
    })
    expect(await restCompletion(fx, fx.agent.id, 'PCB')).toBeNull()
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual({
      status: 'ok',
      done: 0,
      total: 0,
      percent: 0,
    })
  })
})
