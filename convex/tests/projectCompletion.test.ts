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
import { COMPLETION_READS, type CompletionJson, UNAVAILABLE_COMPLETION } from '../lib/core'
import { getProject } from '../machine/rest'
import { NOW, newT, type OrgFixture, plantIssue, plantSeat, type T, withOrg } from './helpers.setup'

const READS = structuredClone(COMPLETION_READS)
afterEach(() => {
  Object.assign(COMPLETION_READS, structuredClone(READS))
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
    // and whether the partial count fits follows only what it reads
    COMPLETION_READS.documents = 8
    expect(await restCompletion(fx, fx.fwOnly.id, 'FW')).toEqual({
      status: 'ok',
      done: 1,
      total: 3,
      percent: 33,
    })
    expect(await restCompletion(fx, fx.agent.id, 'FW')).toEqual(UNAVAILABLE_COMPLETION)
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
