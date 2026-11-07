/* Projects over REST and MCP (machine/projects.ts) and the shared project
 * rules the app runs too (model/projects.ts, model/projectAccess.ts,
 * model/milestones.ts, lib/projectGrants.ts).
 *
 *   1. Creating projects and sub-projects: the creation setting per kind of
 *      caller, Lead on the parent, a hidden parent read as missing, the
 *      creator's own grant, who may name another lead, and where a create
 *      without a sort order places a new project and what reading its
 *      siblings costs.
 *   2. Changing a project: settings with Lead access, archive and restore as
 *      a field, and the lead handover that keeps the old lead as User.
 *   3. Access one user or team at a time, and what a removal does with the
 *      open tasks it hides (leave, keep_as_viewer, reassign_to), all at once.
 *   4. Milestones folded to the top-level project, with real dates.
 *   5. Reading one project, and the refusals that reveal nothing, and a
 *      project an admin manages without reading it. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { ACCESS_NEEDS_A_PERSON } from '../lib/access'
import { byId } from '../lib/db'
import type { Refusal, RefusalCode } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { creatorGrant, grantsAfterHandover } from '../lib/projectGrants'
import { sha256hex } from '../machine/auth'
import { meterDb } from '../model/deletedItems'
import {
  HELD_TASKS_SHAPE,
  type HeldTasks,
  LEAD_ACCESS_RULE,
  parseHeldTasks,
  removeProjectGrantCore,
} from '../model/projectAccess'
import { createProjectCore, SORT_ORDER_SHAPE } from '../model/projects'
import {
  activityFor,
  as,
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
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { countOrg } from './overviewCounts.setup'

const VIA_REST = 'via the REST API (drive)'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

type Json = Record<string, unknown>
const parsed = async (p: Promise<string>): Promise<Json> => JSON.parse(await p) as Json

type Fx = OrgFixture & { t: T; pia: Doc<'profiles'> }

/* withOrg plus Pia, a standard user with User on FW. The fixture's user
 * leads TBED (FW, PCB) and SKNK; the agent holds User on TBED. */
async function setup(): Promise<Fx> {
  const t = newT()
  const f = await withOrg(t)
  const pia = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Pia',
    email: 'pia@testbed.test',
    auth_user_id: `auth_pia_${f.org.id}`,
    accepted_at: NOW,
  })
  await grant(t, f.sub.id, pia.id, 'user')
  await grant(t, f.meta.id, f.agent.id, 'user')
  return { ...f, t, pia }
}

const grant = (t: T, project_id: string, profile_id: string, level: 'user' | 'viewer') =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level })
  })

/* The individual grants on a project, by profile id. */
const grants = (t: T, projectId: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('project_access')
      .withIndex('by_project', (q) => q.eq('project_id', projectId))
      .collect()
    return Object.fromEntries(rows.map((r) => [r.profile_id, r.level]))
  })

const projectRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const taskRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const lastEvent = async (t: T, orgId: string) => (await activityFor(t, orgId)).at(-1)

/* MCP and REST internal calls as a profile, with a credential that writes. */
const as_ = (p: Doc<'profiles'>) => ({ callerId: p.id, access: 'write' as const })
const rest = (p: Doc<'profiles'>) => ({ ...as_(p), keyName: 'drive' })

const setCreators = (fx: Fx, setting: 'admins' | 'users' | 'selected') =>
  fx.t.run(async (ctx) => {
    await ctx.db.patch(fx.org._id, { project_creators: setting })
  })

/* Ledger, a Viewer agent beside the fixture's Standard user agent Relay. */
const plantViewerAgent = (fx: Fx) =>
  plantSeat(fx.t, {
    org_id: fx.org.id,
    name: 'Ledger',
    kind: 'agent',
    org_role: 'viewer',
    plannable_hours: undefined,
  })

/* A new key of `agent`, as the bearer secret. */
async function mintAgentKey(fx: Fx, agent: Doc<'profiles'>): Promise<string> {
  const key = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  await fx.t.run(async (ctx) => {
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'CI key',
      key_prefix: key.slice(0, 11),
      key_hash: await sha256hex(key),
      created_at: NOW,
    })
  })
  return key
}

/* A POST through the deployment's HTTP routes. */
const httpPost = (fx: Fx, path: string, headers: Record<string, string>, body: unknown) =>
  (
    fx.t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })

/* POST /v1/projects {name} over HTTP with a new key of `agent`. */
async function restCreate(fx: Fx, agent: Doc<'profiles'>, name: string) {
  const key = await mintAgentKey(fx, agent)
  const res = await httpPost(
    fx,
    '/v1/projects',
    { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    { name },
  )
  return { status: res.status, body: JSON.parse(await res.text()) as Json }
}

/* A new personal token of `person` that writes, as the bearer secret. */
async function mintToken(fx: Fx, person: Doc<'profiles'>): Promise<string> {
  const token = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  await fx.t.run(async (ctx) => {
    await ctx.db.insert('mcp_tokens', {
      id: uuid(),
      profile_id: person.id,
      name: 'Lead token',
      token_prefix: token.slice(0, 11),
      token_hash: await sha256hex(token),
      access: 'write',
      created_at: NOW,
    })
  })
  return token
}

/* One MCP tools/call over HTTP with `bearer`, answering the tool's result
 * text and whether it is an error. The HTTP route, unlike the internal
 * function, refuses arguments the tool's schema does not know. */
async function mcpCall(fx: Fx, bearer: string, name: string, args: Json) {
  const res = await httpPost(
    fx,
    '/mcp',
    {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  )
  const body = JSON.parse(await res.text()) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return { text: body.result.content[0].text, isError: body.result.isError === true }
}

/* ---------------------------------------------------- 1. creating projects */

describe('creating projects and sub-projects', () => {
  it('creates a project led by its creator, keyed from its name, signed via MCP', async () => {
    const fx = await setup()
    const out = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: '  Luma Mount ',
        description: 'Housing',
      }),
    )
    const row = await projectRow(fx.t, out.id as string)
    expect(out).toEqual({
      id: row?.id,
      key: 'LM',
      num: 6,
      name: 'Luma Mount',
      type: 'meta',
      parent_id: null,
      team_id: null,
      description: 'Housing',
      archived: false,
      archived_at: null,
      access: { read: true, write: true },
      lead_id: fx.admin.id,
      lead_name: 'admin',
      review_hours: null,
      effective_review_hours: 2,
      track_delay: true,
      completion: { status: 'ok', done: 0, total: 0, percent: 0 },
      milestones: [],
      grants: { users: [], teams: [] },
    })
    // one past Skunkworks at 4, the later of both existing top-level projects
    expect(row).toMatchObject({ sort_order: 5, track_delay: true })
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
      verb: 'created',
      target_id: out.id,
      detail: 'via MCP',
    })
  })

  for (const { setting, user, refusal } of [
    {
      setting: 'users',
      user: true,
      refusal: 'only org admins and standard users can create projects',
    },
    {
      setting: 'selected',
      user: false,
      refusal: 'only org admins and selected standard users can create projects',
    },
    { setting: 'admins', user: false, refusal: 'only org admins can create projects' },
  ] as const) {
    it(`under ${setting}, admins${user ? ', standard users and Standard user agents' : ''} create projects; viewers never do`, async () => {
      const fx = await setup()
      await setCreators(fx, setting)
      const viewerAgent = await plantViewerAgent(fx)
      const create = (p: Doc<'profiles'>, name: string) =>
        fx.t.mutation(internal.machine.projects.mcpCreateProject, { ...as_(p), name })
      expect((await parsed(create(fx.admin, 'By admin'))).lead_id).toBe(fx.admin.id)
      // a Standard user agent counts as a standard user, over REST as over MCP
      if (user) {
        expect((await parsed(create(fx.user, 'By user'))).lead_id).toBe(fx.user.id)
        const byAgent = await parsed(create(fx.agent, 'By agent'))
        expect(byAgent).toMatchObject({ lead_id: fx.agent.id, lead_name: 'Relay' })
        expect(await grants(fx.t, byAgent.id as string)).toEqual({})
        expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
          actor_id: fx.agent.id,
          verb: 'created',
          target_id: byAgent.id,
          detail: 'via MCP',
        })
        const res = await restCreate(fx, fx.agent, 'By agent over REST')
        expect(res.status).toBe(201)
        expect(res.body).toMatchObject({ lead_id: fx.agent.id, type: 'meta' })
      } else {
        await refused(create(fx.user, 'By user'), 'forbidden', refusal)
        await refused(create(fx.agent, 'By agent'), 'forbidden', refusal)
        expect(await restCreate(fx, fx.agent, 'By agent over REST')).toEqual({
          status: 403,
          body: { error: refusal },
        })
      }
      // a viewer never creates, person or agent, even with the right on;
      // a Viewer agent's key can only read (lib/projectCreators.ts refuses
      // its role too, see projectCreators.test.ts)
      await fx.t.run(async (ctx) => {
        await ctx.db.patch(fx.viewer._id, { can_create_projects: true })
        await ctx.db.patch(viewerAgent._id, { can_create_projects: true })
      })
      await refused(create(fx.viewer, 'By viewer'), 'forbidden', refusal)
      await refused(
        create(viewerAgent, 'By Viewer agent'),
        'forbidden',
        'this agent is a Viewer and can only read',
      )
      expect(await restCreate(fx, viewerAgent, 'By Viewer agent over REST')).toEqual({
        status: 403,
        body: { error: 'this agent is a Viewer and can only read' },
      })
    })
  }

  it('a standard user or Standard user agent ticked under selected creates projects', async () => {
    const fx = await setup()
    await setCreators(fx, 'selected')
    for (const p of [fx.user, fx.agent]) {
      await fx.t.run((ctx) => ctx.db.patch(p._id, { can_create_projects: true }))
      const out = await parsed(
        fx.t.mutation(internal.machine.projects.mcpCreateProject, {
          ...as_(p),
          name: `Ticked ${p.name}`,
        }),
      )
      expect(out.lead_id).toBe(p.id)
    }
    // unticking takes the right away again
    await fx.t.run((ctx) => ctx.db.patch(fx.agent._id, { can_create_projects: undefined }))
    await refused(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.agent),
        name: 'Unticked',
      }),
      'forbidden',
      'only org admins and selected standard users can create projects',
    )
  })

  it('an agent leads what it creates, cannot hand it over, and must hand nothing to become a Viewer', async () => {
    const fx = await setup()
    const out = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.agent),
        name: 'Bot home',
      }),
    )
    await refused(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.agent),
        project: out.key as string,
        lead_id: fx.user.id,
      }),
      'forbidden',
      ACCESS_NEEDS_A_PERSON,
    )
    // the Viewer switch waits for a person to hand the project over
    await expectRefusal(
      as(fx.t, fx.admin).mutation(api.profiles.update, {
        org_id: fx.org.id,
        id: fx.agent.id,
        patch: { org_role: 'viewer' },
      }),
      'rule',
      /^Relay leads 1 project\(s\)\. Hand those over before making them a viewer\.$/,
    )
    // Inactive stops it at once, while it still leads the project
    await as(fx.t, fx.admin).mutation(api.profiles.deactivate, {
      org_id: fx.org.id,
      id: fx.agent.id,
    })
    await refused(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.agent),
        project: out.key as string,
        name: 'Still here',
      }),
      'forbidden',
      'this agent has been deactivated',
    )
    expect((await projectRow(fx.t, out.id as string))?.lead_id).toBe(fx.agent.id)
    // once a person hands the project over, the agent can become a Viewer;
    // the admin, who manages the project without reading it, does in the app
    await as(fx.t, fx.admin).mutation(api.projects.update, {
      org_id: fx.org.id,
      id: out.id as string,
      patch: { lead_id: fx.user.id },
    })
    await as(fx.t, fx.admin).mutation(api.profiles.update, {
      org_id: fx.org.id,
      id: fx.agent.id,
      patch: { org_role: 'viewer' },
    })
    expect((await projectRow(fx.t, out.id as string))?.lead_id).toBe(fx.user.id)
  })

  it('a sub-project needs Lead on a top-level parent the caller can read', async () => {
    const fx = await setup()
    const sub = (p: Doc<'profiles'>, parent: string) =>
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(p),
        name: 'Optics',
        parent,
      })
    const out = await parsed(sub(fx.user, 'tbed'))
    expect(out).toMatchObject({ type: 'project', parent_id: fx.meta.id, lead_id: fx.user.id })
    // Edit on the parent is not Lead
    await refused(sub(fx.agent, 'TBED'), 'forbidden', 'requires lead access to this project')
    // a parent the agent cannot read answers like an unknown one
    await refused(
      sub(fx.agent, 'SKNK'),
      'not_found',
      'parent project "SKNK" not found (or not visible to you)',
    )
    await refused(
      sub(fx.agent, 'NOPE'),
      'not_found',
      'parent project "NOPE" not found (or not visible to you)',
    )
    await refused(
      sub(fx.user, 'FW'),
      'rule',
      'sub-projects live directly under a project, never under another sub-project',
    )
    await fx.t.run((ctx) => ctx.db.patch(fx.hidden._id, { archived_at: NOW }))
    await refused(sub(fx.user, 'SKNK'), 'rule', 'the project is archived, so restore it first')
    // REST: an unknown and an unreadable parent read alike
    for (const parent of ['SKNK', 'NOPE']) {
      await refused(
        fx.t.mutation(internal.machine.projects.restCreateProject, {
          ...rest(fx.agent),
          body: JSON.stringify({ name: 'Optics', parent }),
        }),
        'bad_request',
        'parent project not found',
      )
    }
  })

  it('a creator naming another lead keeps User access, an admin as anyone', async () => {
    const fx = await setup()
    const byUser = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.user),
        name: 'Handed',
        lead_id: fx.pia.id.toUpperCase(),
      }),
    )
    expect(byUser.lead_id).toBe(fx.pia.id)
    expect(await grants(fx.t, byUser.id as string)).toEqual({ [fx.user.id]: 'user' })
    // admin status gives no access to the project's work, so the admin
    // keeps it in sight by the same default grant, and leading their own
    // project gives them none
    const byAdmin = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Given',
        lead_id: fx.pia.id,
      }),
    )
    expect(await grants(fx.t, byAdmin.id as string)).toEqual({ [fx.admin.id]: 'user' })
    expect(byAdmin.access).toEqual({ read: true, write: true })
    const ownAdmin = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Kept',
      }),
    )
    expect(await grants(fx.t, ownAdmin.id as string)).toEqual({})
    // and the app's create stores the same
    const inApp = await as(fx.t, fx.admin).mutation(api.projects.create, {
      org_id: fx.org.id,
      id: uuid(),
      type: 'meta',
      key: 'APPG',
      name: 'App given',
      sort_order: 9,
      lead_id: fx.pia.id,
    })
    expect(await grants(fx.t, inApp.id)).toEqual({ [fx.admin.id]: 'user' })
    // a lead must be someone who can lead
    await refused(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Viewed',
        lead_id: fx.viewer.id,
      }),
      'rule',
      'a viewer cannot lead a project, so make them a standard user first',
    )
    await refused(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Elsewhere',
        lead_id: fx.otherAdmin.id,
      }),
      'bad_request',
      `user "${fx.otherAdmin.id}" not found in your organization`,
    )
  })

  it('only a person may name another lead; an agent leads what it creates', async () => {
    const fx = await setup()
    const led = await plantProject(fx.t, { org_id: fx.org.id, key: 'BOT', lead_id: fx.agent.id })
    const sub = (lead_id?: string) =>
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.agent),
        name: 'Agent work',
        parent: 'BOT',
        ...(lead_id === undefined ? {} : { lead_id }),
      })
    await refused(sub(fx.user.id), 'forbidden', ACCESS_NEEDS_A_PERSON)
    const out = await parsed(sub())
    expect(out).toMatchObject({ parent_id: led.id, lead_id: fx.agent.id })
    expect((await parsed(sub(fx.agent.id))).lead_id).toBe(fx.agent.id)
  })

  it('refuses a blank name, grant maps and a key in a REST body', async () => {
    const fx = await setup()
    await refused(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, { ...as_(fx.admin), name: '  ' }),
      'rule',
      'a project name cannot be blank',
    )
    const post = (body: unknown) =>
      fx.t.mutation(internal.machine.projects.restCreateProject, {
        ...rest(fx.admin),
        body: JSON.stringify(body),
      })
    await refused(post({}), 'bad_request', 'name is required')
    await refused(
      post({ name: 'X', access: {} }),
      'bad_request',
      'give access one user or team at a time, under /v1/projects/{ref}/access',
    )
    await refused(
      post({ name: 'X', key: 'XX' }),
      'bad_request',
      "a project's key comes from its name and cannot be written",
    )
    const made = await post({ name: 'Rest made', description: null })
    expect(made).toMatchObject({ key: 'RM', access: { read: true, write: true }, description: '' })
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({ verb: 'created', detail: VIA_REST })
  })

  it("the app's create stores the creator's grant by the same rule; null declines it", async () => {
    const fx = await setup()
    const create = (key: string, access: Record<string, 'user' | null>) =>
      as(fx.t, fx.user).mutation(api.projects.create, {
        org_id: fx.org.id,
        id: uuid(),
        type: 'meta',
        key,
        name: key,
        sort_order: 9,
        lead_id: fx.pia.id,
        access,
      })
    const kept = await create('KEPT', {})
    expect(await grants(fx.t, kept.id)).toEqual({ [fx.user.id]: 'user' })
    const declined = await create('NONE', { [fx.user.id]: null })
    expect(await grants(fx.t, declined.id)).toEqual({})
  })

  it('places a project created without a sort order after every sibling, archived, hidden and gapped ones included, over the app, REST and MCP, and keeps a place the app sends', async () => {
    const fx = await setup()
    // an archived top-level project, one the user cannot see and an
    // archived sub-project of TBED, which all count, each placed at its
    // number, far past how many siblings there are
    const archivedTop = await plantProject(fx.t, { org_id: fx.org.id, archived_at: NOW })
    const hiddenTop = await plantProject(fx.t, { org_id: fx.org.id })
    await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      archived_at: NOW,
    })
    // a sub-project of TBED deleted below the others leaves a gap, as
    // Deleted items leaves its siblings' places
    await fx.t.run((ctx) => ctx.db.delete(fx.sub._id))
    /* One past the largest place among the organization's stored top-level
     * metas and among TBED's sub-projects, and how many each are. */
    const stored = () =>
      fx.t.run(async (ctx) => {
        const rows = await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
          .collect()
        const tops = rows.filter((p) => p.type === 'meta' && p.parent_id === undefined)
        const subs = rows.filter((p) => p.type === 'project' && p.parent_id === fx.meta.id)
        const pastLast = (ps: Doc<'projects'>[]) => Math.max(0, ...ps.map((p) => p.sort_order + 1))
        return { tops: pastLast(tops), subs: pastLast(subs), counts: [tops.length, subs.length] }
      })
    let keys = 0
    const appCreate = async (name: string, parent?: string) =>
      (
        await as(fx.t, fx.user).mutation(api.projects.create, {
          org_id: fx.org.id,
          id: uuid(),
          type: parent === undefined ? 'meta' : 'project',
          ...(parent === undefined ? {} : { parent_id: parent }),
          key: `APP${keys++}`,
          name,
        })
      ).id
    const restCreate = async (name: string, parent?: string) =>
      (
        (await fx.t.mutation(internal.machine.projects.restCreateProject, {
          ...rest(fx.user),
          body: JSON.stringify({ name, ...(parent === undefined ? {} : { parent }) }),
        })) as Json
      ).id as string
    const mcpCreate = async (name: string, parent?: string) =>
      (
        await parsed(
          fx.t.mutation(internal.machine.projects.mcpCreateProject, {
            ...as_(fx.user),
            name,
            ...(parent === undefined ? {} : { parent }),
          }),
        )
      ).id as string
    const first = await stored()
    // the places run past the counts, so a count would land among them
    expect(first.tops).toBeGreaterThan(first.counts[0])
    expect(first.subs).toBeGreaterThan(first.counts[1])
    /* Moves top-level project `p` past every other one with a gap, so the
     * next top-level create lands after it only if it reads `p`. Each
     * surface lifts one, the archived project on the app and over MCP and
     * the hidden one over REST, so each is the largest place at its own
     * step; the archived sub-project, planted last, is TBED's largest at
     * the app's. */
    const lift = async (p: Doc<'projects'>) => {
      const past = (await stored()).tops + 10
      await fx.t.run((ctx) => ctx.db.patch(p._id, { sort_order: past }))
    }
    for (const [surface, create, parent, lifted] of [
      ['app', appCreate, fx.meta.id, archivedTop],
      ['REST', restCreate, 'TBED', hiddenTop],
      ['MCP', mcpCreate, 'TBED', archivedTop],
    ] as const) {
      await lift(lifted)
      const before = await stored()
      const top = await create(`Top over ${surface}`)
      expect((await projectRow(fx.t, top))?.sort_order, `${surface}, top-level`).toBe(before.tops)
      const sub = await create(`Sub over ${surface}`, parent)
      expect((await projectRow(fx.t, sub))?.sort_order, `${surface}, sub-project`).toBe(before.subs)
    }
    expect((await stored()).counts).toEqual([first.counts[0] + 3, first.counts[1] + 3])
    // an app from before the server placed its creates sends its own place,
    // which is stored as sent, whatever the siblings
    const app = await as(fx.t, fx.user).mutation(api.projects.create, {
      org_id: fx.org.id,
      id: uuid(),
      type: 'meta',
      key: 'APP',
      name: 'App placed',
      sort_order: 1,
    })
    expect((await projectRow(fx.t, app.id))?.sort_order).toBe(1)
  })

  it('refuses a sort order that is not a finite number and stores nothing, and places past a stored one by the finite places alone', async () => {
    const fx = await setup()
    for (const sort_order of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const id = uuid()
      await refused(
        as(fx.t, fx.user).mutation(api.projects.create, {
          org_id: fx.org.id,
          id,
          type: 'meta',
          key: 'BAD',
          name: 'Bad place',
          sort_order,
        }),
        'bad_request',
        SORT_ORDER_SHAPE,
      )
      expect(await projectRow(fx.t, id), String(sort_order)).toBeNull()
    }
    // a top-level project and a sub-project of TBED stored with NaN, as an
    // older backend stored a create's place as sent; the next creates land
    // one past the finite places alone
    await plantProject(fx.t, { org_id: fx.org.id, sort_order: Number.NaN })
    await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      sort_order: Number.NaN,
    })
    const pastLast = async (pick: (p: Doc<'projects'>) => boolean) =>
      fx.t.run(async (ctx) => {
        const rows = await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
          .collect()
        const places = rows.filter(pick).map((p) => p.sort_order)
        return Math.max(0, ...places.filter(Number.isFinite).map((place) => place + 1))
      })
    const tops = await pastLast((p) => p.type === 'meta' && p.parent_id === undefined)
    const subs = await pastLast((p) => p.type === 'project' && p.parent_id === fx.meta.id)
    const top = (await fx.t.mutation(internal.machine.projects.restCreateProject, {
      ...rest(fx.user),
      body: JSON.stringify({ name: 'Past the gap' }),
    })) as Json
    expect((await projectRow(fx.t, top.id as string))?.sort_order).toBe(tops)
    const sub = (await fx.t.mutation(internal.machine.projects.restCreateProject, {
      ...rest(fx.user),
      body: JSON.stringify({ name: 'Sub past the gap', parent: 'TBED' }),
    })) as Json
    expect((await projectRow(fx.t, sub.id as string))?.sort_order).toBe(subs)
  })

  it('places a top-level project by the top-level metas only, not a meta stored with a parent', async () => {
    const fx = await setup()
    // createProjectCore refuses a meta with a parent; only bad data has
    // one, here placed after every top-level project
    await fx.t.run((ctx) => ctx.db.patch(fx.sub._id, { type: 'meta', sort_order: 9 }))
    const out = (await fx.t.mutation(internal.machine.projects.restCreateProject, {
      ...rest(fx.admin),
      body: JSON.stringify({ name: 'Optics' }),
    })) as Json
    // one past SKNK at 4, where a read of every project of the
    // organization would also have taken the meta under TBED at 9
    expect((await projectRow(fx.t, out.id as string))?.sort_order).toBe(5)
  })

  it("reads a new top-level project's siblings from the top-level projects alone", async () => {
    const fx = await setup()
    /* The project documents a top-level create by the admin reads, and the
     * organization's top-level projects stored before it. Each create
     * stays, so each names its own key and reads no other key's row. */
    const measure = async (key: string) =>
      await fx.t.run(async (ctx) => {
        const tops = (
          await ctx.db
            .query('projects')
            .withIndex('by_org_parent', (q) => q.eq('org_id', fx.org.id).eq('parent_id', undefined))
            .collect()
        ).length
        let reads = 0
        const counted = meterDb(ctx, {
          range: () => {},
          doc: (doc) => {
            if (ctx.db.normalizeId('projects', (doc as { _id: string })._id) !== null) reads += 1
          },
        })
        const admin = await byId(ctx, 'profiles', fx.admin.id)
        if (admin === null) throw new Error('the admin is gone')
        await createProjectCore(counted, {
          me: admin,
          now: NOW,
          project: { id: uuid(), type: 'meta', name: `Counted ${key}`, key },
        })
        return { tops, reads }
      })
    const base = await measure('CNTA')
    // 20 top-level projects the admin holds nothing on
    const parents: Doc<'projects'>[] = []
    for (let i = 0; i < 20; i++) parents.push(await plantProject(fx.t, { org_id: fx.org.id }))
    const withTops = await measure('CNTB')
    expect(withTops.tops - base.tops).toBe(21)
    expect(withTops.reads - base.reads).toBe(21)
    // three sub-projects under each, the everyday shape, which the count of
    // the organization's every project read too
    for (const parent of parents)
      for (let i = 0; i < 3; i++)
        await plantProject(fx.t, { org_id: fx.org.id, type: 'project', parent_id: parent.id })
    const withSubs = await measure('CNTC')
    expect(withSubs.tops - withTops.tops).toBe(1)
    expect(withSubs.reads - withTops.reads).toBe(1)
  })

  it('creatorGrant: an own entry decides, else User for a creator naming another lead', () => {
    const base = { creator: 'me', lead: 'leo', own: undefined }
    expect(creatorGrant(base)).toBe('user')
    expect(creatorGrant({ ...base, lead: 'me' })).toBeNull()
    expect(creatorGrant({ ...base, own: null })).toBeNull()
    expect(creatorGrant({ ...base, own: 'viewer' })).toBe('viewer')
    expect(creatorGrant({ ...base, lead: 'me', own: 'user' })).toBe('user')
  })
})

/* ----------------------------------------------------- 2. changing projects */

describe('changing a project', () => {
  /* The writes a project's Settings page and Settings › Projects offer from
   * management (model/projectSettings.ts settingsRights), through the app's
   * own functions: the fixture's admin holds no lead, grant or team share
   * in the organization, so only management lets them through; Pia sees FW
   * through a grant and TBED for navigation without leading either, and
   * Sam sees nothing. */
  it('an admin who takes part in no project manages it through every write the Settings pages offer', async () => {
    const fx = await setup()
    const sam = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Sam',
      email: 'sam@testbed.test',
      auth_user_id: `auth_sam_${fx.org.id}`,
      accepted_at: NOW,
    })
    // the lead picker answers once the organization's rows hold name keys
    await keyOrg(fx.t, fx.org.id)
    const app = (p: Doc<'profiles'>) => as(fx.t, p)
    const org_id = fx.org.id
    const update = (p: Doc<'profiles'>, id: string, patch: Json) =>
      app(p).mutation(api.projects.update, { org_id, id, patch })
    const archive = (p: Doc<'profiles'>, id: string) =>
      app(p).mutation(api.projects.archive, { org_id, id })
    const unarchive = (p: Doc<'profiles'>, id: string) =>
      app(p).mutation(api.projects.unarchive, { org_id, id })
    const summary = (p: Doc<'profiles'>, id: string) =>
      app(p).query(api.projects.removalSummary, { org_id, id })
    const remove = (p: Doc<'profiles'>, id: string) =>
      app(p).mutation(api.projects.deleteDeep, { org_id, id })
    const createSub = (p: Doc<'profiles'>, parent_id: string, key: string) =>
      app(p).mutation(api.projects.create, {
        org_id,
        id: uuid(),
        type: 'project',
        parent_id,
        key,
        name: key,
        lead_id: fx.user.id,
      })
    const leads = (p: Doc<'profiles'>, parent_id: string) =>
      app(p).query(api.projectSettings.leadCandidates, { org_id, parent_id })
    const LEAD = 'requires lead access to this project'

    // a member who sees the project without leading it is refused each,
    // with the sentences these writes have always had
    await refused(update(fx.pia, fx.sub.id, { review_hours: 2 }), 'forbidden', LEAD)
    await refused(update(fx.pia, fx.sub.id, { lead_id: fx.pia.id }), 'forbidden', LEAD)
    await refused(archive(fx.pia, fx.sub.id), 'forbidden', LEAD)
    await refused(summary(fx.pia, fx.sub.id), 'rule', 'requires the project lead')
    await refused(remove(fx.pia, fx.sub.id), 'rule', 'requires the project lead')
    await refused(createSub(fx.pia, fx.meta.id, 'PIA'), 'forbidden', LEAD)
    expect(await leads(fx.pia, fx.meta.id)).toEqual({ state: 'refused', message: LEAD })
    // one who sees nothing reads the parent as missing, as before
    await refused(createSub(sam, fx.hidden.id, 'SAM'), 'rule', 'parent project not found')
    expect(await leads(sam, fx.hidden.id)).toEqual({ state: 'unavailable' })
    await refused(update(sam, fx.hidden.id, { review_hours: 2 }), 'forbidden', LEAD)

    // the admin's every write goes through
    await update(fx.admin, fx.hidden.id, { review_hours: 2 })
    expect((await projectRow(fx.t, fx.hidden.id))?.review_hours).toBe(2)
    await update(fx.admin, fx.sub.id, { lead_id: fx.pia.id })
    expect((await projectRow(fx.t, fx.sub.id))?.lead_id).toBe(fx.pia.id)
    expect((await leads(fx.admin, fx.hidden.id)).state).toBe('ready')
    const made = await createSub(fx.admin, fx.hidden.id, 'OPT')
    expect(await projectRow(fx.t, made.id)).toMatchObject({
      parent_id: fx.hidden.id,
      lead_id: fx.user.id,
    })
    // archive the sub-project, then its parent, and restore the
    // sub-project under the archived parent, which restores that too
    await archive(fx.admin, fx.sub2.id)
    await archive(fx.admin, fx.meta.id)
    await unarchive(fx.admin, fx.sub2.id)
    expect((await projectRow(fx.t, fx.sub2.id))?.archived_at).toBeUndefined()
    expect((await projectRow(fx.t, fx.meta.id))?.archived_at).toBeUndefined()
    expect(await summary(fx.admin, fx.hidden.id)).toMatchObject({
      sub_projects: [{ id: made.id, key: 'OPT' }],
    })
    await remove(fx.admin, fx.hidden.id)
    expect(await projectRow(fx.t, fx.hidden.id)).toBeNull()
  })

  it('changes settings with Lead access only, signed via the REST API', async () => {
    const fx = await setup()
    const patch = (p: Doc<'profiles'>, body: unknown) =>
      fx.t.mutation(internal.machine.projects.restUpdateProject, {
        ...rest(p),
        ref: 'TBED',
        body: JSON.stringify(body),
      })
    const out = await patch(fx.user, {
      name: ' Testbed ',
      description: ' Rig\n',
      review_hours: 1.25,
      track_delay: true,
    })
    expect(out).toMatchObject({
      name: 'Testbed',
      description: 'Rig',
      review_hours: 1.3,
      effective_review_hours: 1.3,
      track_delay: true,
    })
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
      verb: 'renamed',
      detail: `from “Testbed platform”, ${VIA_REST}`,
    })
    // Edit on the project is not Lead; the fields a body cannot write
    await refused(
      patch(fx.agent, { name: 'Mine' }),
      'forbidden',
      'requires lead access to this project',
    )
    await refused(patch(fx.user, {}), 'bad_request', 'no recognized fields to update')
    await refused(
      patch(fx.user, { name: 'Testbed', unknown: 1 }),
      'bad_request',
      'unknown field "unknown"; this request takes name, description, review_hours, track_delay, lead_id, archived, expected',
    )
    await refused(patch(fx.user, { name: ' ' }), 'rule', 'a project name cannot be blank')
    // review hours outside 0 to 999, or not a number, are refused alike
    for (const review_hours of ['2', -1, LIMITS.reviewHours.max + 1]) {
      await refused(patch(fx.user, { review_hours }), 'rule', LIMITS.reviewHours.refusal)
    }
    await refused(
      patch(fx.user, { parent_id: fx.hidden.id }),
      'bad_request',
      "a project's parent is set when it is created, with parent",
    )
    // `parent` is create's field; on a change it is refused, never dropped
    await refused(
      patch(fx.user, { parent: 'SKNK', name: 'Moved' }),
      'bad_request',
      "a project's parent is set when it is created, with parent",
    )
    expect((await projectRow(fx.t, fx.meta.id))?.name).toBe('Testbed')
    await refused(
      patch(fx.user, { description: 'x'.repeat(LIMITS.projectDescription.max + 1) }),
      'rule',
      LIMITS.projectDescription.refusal,
    )
    expect(await projectRow(fx.t, fx.meta.id)).toMatchObject({
      description: 'Rig',
      review_hours: 1.3,
    })
    expect((await patch(fx.user, { review_hours: LIMITS.reviewHours.max })).review_hours).toBe(
      LIMITS.reviewHours.max,
    )
    expect((await patch(fx.user, { review_hours: null })).review_hours).toBeNull()
  })

  it('archives and restores with the archived field, carrying the sub-projects', async () => {
    const fx = await setup()
    await countOrg(fx.t, fx.org.id)
    const update = (args: Json) =>
      parsed(
        fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
          ...as_(fx.user),
          project: 'TBED',
          ...args,
        }),
      )
    const archived = await update({ archived: true })
    const stored = await projectRow(fx.t, fx.meta.id)
    expect(stored?.archived_at).toEqual(expect.any(String))
    // the whole answer, so a field added or lost on the way out shows
    const tbed = {
      id: fx.meta.id,
      key: 'TBED',
      num: fx.meta.num,
      name: 'Testbed platform',
      type: 'meta',
      parent_id: null,
      team_id: null,
      description: fx.meta.description,
      access: { read: true, write: true },
      lead_id: fx.user.id,
      lead_name: 'user',
      review_hours: null,
      effective_review_hours: 2,
      track_delay: false,
      milestones: [],
      grants: {
        users: [
          { id: fx.guest.id, name: 'guest', level: 'user' },
          { id: fx.agent.id, name: 'Relay', level: 'user' },
          { id: fx.viewer.id, name: 'viewer', level: 'user' },
        ],
        teams: [],
      },
    }
    // an archived project's tasks are outside the plan, so it has no completion
    expect(archived).toEqual({
      ...tbed,
      archived: true,
      archived_at: stored?.archived_at,
      completion: null,
    })
    expect((await projectRow(fx.t, fx.sub.id))?.archived_at).toBe(archived.archived_at)
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
      verb: 'archived',
      detail: 'with 2 sub-projects, via MCP',
    })
    // one call restores first, so the rename lands on the active project;
    // the restore starts its family's regroup in the same transaction, so
    // its answer's completion is counting until the regroup's steps end
    const back = await update({ archived: false, name: 'Back' })
    expect(back).toEqual({
      ...tbed,
      name: 'Back',
      archived: false,
      archived_at: null,
      completion: { status: 'counting', done: null, total: null, percent: null },
    })
    expect((await projectRow(fx.t, fx.sub.id))?.archived_at).toBeUndefined()
    const verbs = (await activityFor(fx.t, fx.org.id)).slice(-2).map((e) => e.verb)
    expect(verbs).toEqual(['restored', 'renamed'])
    await refused(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.user),
        project: 'TBED',
      }),
      'bad_request',
      'no fields to update',
    )
  })

  it('takes no archive reason, which only tasks have, and both surfaces refuse it', async () => {
    const fx = await setup()
    const patch = (body: unknown) =>
      fx.t.mutation(internal.machine.projects.restUpdateProject, {
        ...rest(fx.user),
        ref: 'TBED',
        body: JSON.stringify(body),
      })
    await refused(
      patch({ archived: true, archive_reason: 'Shipped' }),
      'bad_request',
      'only tasks take an archive reason; archive a project with archived alone',
    )
    expect((await projectRow(fx.t, fx.meta.id))?.archived_at).toBeUndefined()
    expect((await patch({ archived: true })).archived_at).not.toBeNull()
    // the tool's schema does not know the argument, so the call changes nothing
    const bot = await plantProject(fx.t, { org_id: fx.org.id, key: 'BOT', lead_id: fx.agent.id })
    const key = await mintAgentKey(fx, fx.agent)
    expect(
      await mcpCall(fx, key, 'update_project', {
        project: 'BOT',
        archived: true,
        archive_reason: 'Shipped',
      }),
    ).toEqual({
      text: 'Input validation error: Invalid arguments for tool update_project: Unrecognized key: "archive_reason"',
      isError: true,
    })
    expect((await projectRow(fx.t, bot.id))?.archived_at).toBeUndefined()
    const archived = await mcpCall(fx, key, 'update_project', { project: 'BOT', archived: true })
    expect(archived.isError).toBe(false)
    expect(JSON.parse(archived.text)).toMatchObject({ key: 'BOT', archived: true })
    expect(JSON.parse(archived.text)).not.toHaveProperty('ignored_arguments')
  })

  it('hands over the lead; the old lead keeps User, the new one loses their own grant', async () => {
    const fx = await setup()
    await grant(fx.t, fx.meta.id, fx.pia.id, 'viewer')
    // the app's update with the lead alone runs the same rule
    await as(fx.t, fx.user).mutation(api.projects.update, {
      org_id: fx.org.id,
      id: fx.meta.id,
      patch: { lead_id: fx.pia.id },
    })
    expect(await grants(fx.t, fx.meta.id)).toMatchObject({ [fx.user.id]: 'user' })
    expect((await grants(fx.t, fx.meta.id))[fx.pia.id]).toBeUndefined()
    // and over MCP, back again
    const out = await parsed(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.pia),
        project: 'TBED',
        lead_id: fx.user.id,
      }),
    )
    expect(out.lead_id).toBe(fx.user.id)
    const after = await grants(fx.t, fx.meta.id)
    expect(after[fx.pia.id]).toBe('user')
    expect(after[fx.user.id]).toBeUndefined()
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
      verb: 'changed the lead of',
      detail: 'to user (was Pia), via MCP',
    })
    expect(grantsAfterHandover({ a: 'viewer', b: 'viewer' }, 'a', 'b')).toEqual({ a: 'user' })
    expect(grantsAfterHandover({ a: 'viewer' }, 'a', 'a')).toEqual({ a: 'viewer' })
  })

  it('a lead who is not an admin archives and hands over the lead in one call', async () => {
    const fx = await setup()
    const out = await parsed(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.user),
        project: 'TBED',
        lead_id: fx.pia.id,
        archived: true,
      }),
    )
    expect(out).toMatchObject({ lead_id: fx.pia.id })
    expect(out.archived_at).not.toBeNull()
    expect((await grants(fx.t, fx.meta.id))[fx.user.id]).toBe('user')
    const verbs = (await activityFor(fx.t, fx.org.id)).slice(-2).map((e) => e.verb)
    expect(verbs).toEqual(['archived', 'changed the lead of'])
    // the outgoing lead holds User now, so restoring is no longer theirs
    await refused(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.user),
        project: 'TBED',
        archived: false,
      }),
      'forbidden',
      'requires lead access to this project',
    )
  })

  it('only a person may hand over the lead', async () => {
    const fx = await setup()
    await plantProject(fx.t, { org_id: fx.org.id, key: 'BOT', lead_id: fx.agent.id })
    const handover = (lead_id: string) =>
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.agent),
        project: 'BOT',
        lead_id,
      })
    await refused(handover(fx.user.id), 'forbidden', ACCESS_NEEDS_A_PERSON)
    // resending its own lead is no handover, and other settings stay its own
    expect((await parsed(handover(fx.agent.id))).lead_id).toBe(fx.agent.id)
    const renamed = await parsed(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.agent),
        project: 'BOT',
        name: 'Bot work',
      }),
    )
    expect(renamed.name).toBe('Bot work')
  })
})

/* ------------------------------------------------------------- 3. access */

describe('project access, one user or team at a time', () => {
  const setAccess = (fx: Fx, p: Doc<'profiles'>, args: Json) =>
    parsed(
      fx.t.mutation(internal.machine.projects.mcpSetProjectAccess, {
        ...as_(p),
        project: 'FW',
        level: null,
        ...args,
      } as never),
    )

  it('gives and changes a grant; refuses the lead, viewers above Viewer, non-leads and agents', async () => {
    const fx = await setup()
    const ben = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Ben' })
    const give = (level: 'user' | 'viewer') => setAccess(fx, fx.user, { user_id: ben.id, level })
    expect(await give('user')).toMatchObject({
      project: 'FW',
      user: { id: ben.id, name: 'Ben' },
      level: 'user',
      changed: true,
    })
    expect((await give('user')).changed).toBe(false)
    expect((await give('viewer')).changed).toBe(true)
    expect((await grants(fx.t, fx.sub.id))[ben.id]).toBe('viewer')
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
      verb: 'changed access on',
      detail: 'via MCP',
    })
    expect(await setAccess(fx, fx.user, { team_id: fx.team.id, level: 'viewer' })).toMatchObject({
      team: { id: fx.team.id, name: 'Hardware' },
      level: 'viewer',
      changed: true,
    })
    await refused(
      setAccess(fx, fx.user, { user_id: fx.viewer.id, level: 'user' }),
      'forbidden',
      'a viewer can only receive a viewer grant',
    )
    // FW has no lead of its own, so its parent's lead leads it
    await refused(
      setAccess(fx, fx.admin, { user_id: fx.user.id, level: 'viewer' }),
      'rule',
      LEAD_ACCESS_RULE,
    )
    await refused(
      setAccess(fx, fx.pia, { user_id: ben.id, level: 'user' }),
      'forbidden',
      'no permission to manage users on this project',
    )
    await refused(
      setAccess(fx, fx.agent, { user_id: ben.id, level: 'user' }),
      'forbidden',
      ACCESS_NEEDS_A_PERSON,
    )
    await refused(
      setAccess(fx, fx.user, { level: 'user' }),
      'bad_request',
      'name exactly one of user_id and team_id',
    )
    await refused(
      setAccess(fx, fx.user, { user_id: ben.id, level: 'user', on_held_tasks: 'leave' }),
      'bad_request',
      'on_held_tasks applies only when level is null',
    )
  })

  /* Pia holds User on FW only, and works on three FW tasks. */
  async function held(fx: Fx) {
    const open = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      assignee_id: fx.pia.id,
    })
    const reviewing = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      status: 'review',
      assignee_id: fx.user.id,
      reviewer_id: fx.pia.id,
    })
    const done = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      status: 'done',
      assignee_id: fx.pia.id,
    })
    return { open, reviewing, done }
  }

  it('a removal leaves the tasks it hides by default, and lists them', async () => {
    const fx = await setup()
    const { open, reviewing, done } = await held(fx)
    const out = await setAccess(fx, fx.user, { user_id: fx.pia.id })
    expect(out).toMatchObject({ level: null, changed: true, kept_as_viewer: [], reassigned: [] })
    expect((out.stranded as Json[]).map((h) => [h.id, h.user_id, h.role])).toEqual([
      [open.id, fx.pia.id, 'assignee'],
      [reviewing.id, fx.pia.id, 'reviewer'],
    ])
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBeUndefined()
    expect((await taskRow(fx.t, open.id))?.assignee_id).toBe(fx.pia.id)
    expect((await taskRow(fx.t, done.id))?.assignee_id).toBe(fx.pia.id)
    expect(out.hidden).toEqual({ tasks: 0, user_ids: [] })
    // nothing left to remove changes nothing
    expect(await setAccess(fx, fx.user, { user_id: fx.pia.id })).toMatchObject({
      changed: false,
      stranded: [],
    })
  })

  it('counts the tasks a remover cannot see in hidden with their holders, never naming them', async () => {
    const fx = await setup()
    const { open, reviewing } = await held(fx)
    // the admin, who takes part in no project, manages FW and sees none of
    // its tasks, over MCP and over REST
    const viaMcp = await setAccess(fx, fx.admin, { user_id: fx.pia.id })
    expect(viaMcp).toMatchObject({ changed: true, stranded: [], reassigned: [] })
    expect(viaMcp.hidden).toEqual({ tasks: 2, user_ids: [fx.pia.id] })
    await grant(fx.t, fx.sub.id, fx.pia.id, 'user')
    const viaRest = await fx.t.mutation(internal.machine.projects.restRemoveUserAccess, {
      ...rest(fx.admin),
      ref: 'FW',
      subject: fx.pia.id,
      body: '',
    })
    expect(viaRest).toMatchObject({
      removed: true,
      stranded: [],
      reassigned: [],
      hidden: { tasks: 2, user_ids: [fx.pia.id] },
    })
    for (const out of [viaMcp, viaRest])
      for (const task of [open, reviewing]) {
        expect(JSON.stringify(out)).not.toContain(task.id)
        expect(JSON.stringify(out)).not.toContain(`QN-${task.num}`)
      }
    // the lead, who reads FW, sees them listed and nothing hidden
    await grant(fx.t, fx.sub.id, fx.pia.id, 'user')
    const byLead = await setAccess(fx, fx.user, { user_id: fx.pia.id })
    expect((byLead.stranded as Json[]).map((h) => h.id)).toEqual([open.id, reviewing.id])
    expect(byLead.hidden).toEqual({ tasks: 0, user_ids: [] })
  })

  it('judges sight after the write, so a caller removing their own access counts what they no longer see', async () => {
    const fx = await setup()
    // the admin reads FW by a grant, holds a task there and removes the grant
    await grant(fx.t, fx.sub.id, fx.admin.id, 'user')
    const mine = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      assignee_id: fx.admin.id,
    })
    const out = await setAccess(fx, fx.admin, { user_id: fx.admin.id })
    expect(out).toMatchObject({ changed: true, stranded: [] })
    expect(out.hidden).toEqual({ tasks: 1, user_ids: [fx.admin.id] })
    expect(JSON.stringify(out)).not.toContain(mine.id)
  })

  /* `ctx` with every task document its queries return pushed to `seen`. */
  function recordingTasks(ctx: MutationCtx, seen: Doc<'issues'>[]): MutationCtx {
    const record = <D>(d: D): D => {
      if (d !== null) seen.push(d as Doc<'issues'>)
      return d
    }
    const wrap = (query: object): object =>
      new Proxy(query, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop)
          if (prop === Symbol.asyncIterator) {
            return async function* () {
              for await (const d of target as AsyncIterable<unknown>) yield record(d)
            }
          }
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            const out: unknown = value.apply(target, args)
            if (prop === 'collect' || prop === 'take') {
              return (out as Promise<unknown[]>).then((ds) => ds.map(record))
            }
            if (prop === 'first' || prop === 'unique') return (out as Promise<unknown>).then(record)
            return typeof out === 'object' && out !== null && !('then' in out) ? wrap(out) : out
          }
        },
      })
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop)
        if (prop === 'query') {
          return (table: 'issues') =>
            table === 'issues' ? wrap(target.query(table)) : target.query(table)
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { ...ctx, db } as MutationCtx
  }

  it('a removal reads only open tasks, whatever the archive holds', async () => {
    const fx = await setup()
    const { open, reviewing } = await held(fx)
    for (let i = 0; i < 40; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        assignee_id: fx.pia.id,
        archived_at: NOW,
      })
    }
    // a group's reviewer is dormant, so Pia does not hold this one
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      reviewer_id: fx.pia.id,
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, parent_id: group.id })
    const seen: Doc<'issues'>[] = []
    const out = await fx.t.run((ctx) =>
      removeProjectGrantCore(recordingTasks(ctx, seen), {
        me: fx.user,
        project: fx.sub,
        subject: { profile: fx.pia },
        held: 'leave',
        now: NOW,
      }),
    )
    expect(out.stranded.map((h) => [h.task.id, h.role])).toEqual([
      [open.id, 'assignee'],
      [reviewing.id, 'reviewer'],
    ])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter((d) => d.archived_at !== undefined)).toEqual([])
  })

  it('keep_as_viewer keeps the people as Viewers; a Viewer grant cannot be kept', async () => {
    const fx = await setup()
    await held(fx)
    const out = await setAccess(fx, fx.user, {
      user_id: fx.pia.id,
      on_held_tasks: 'keep_as_viewer',
    })
    expect(out).toMatchObject({ changed: true, stranded: [], kept_as_viewer: [fx.pia.id] })
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBe('viewer')
    await refused(
      setAccess(fx, fx.user, { user_id: fx.pia.id, on_held_tasks: 'keep_as_viewer' }),
      'rule',
      'a Viewer grant cannot be kept as Viewer; leave the tasks or reassign them',
    )
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBe('viewer')
  })

  it('reassign_to hands every hidden task over at once, or changes nothing', async () => {
    const fx = await setup()
    const { open, reviewing } = await held(fx)
    // someone who cannot work there is refused, and the grant stays
    await refused(
      setAccess(fx, fx.user, { user_id: fx.pia.id, on_held_tasks: { reassign_to: fx.viewer.id } }),
      'rule',
      'a task can only be assigned to an active user with Edit permission or higher on its project',
    )
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBe('user')
    expect((await taskRow(fx.t, open.id))?.assignee_id).toBe(fx.pia.id)
    const out = await setAccess(fx, fx.user, {
      user_id: fx.pia.id,
      on_held_tasks: { reassign_to: fx.agent.id },
    })
    expect((out.reassigned as Json[]).map((h) => h.id)).toEqual([open.id, reviewing.id])
    expect(out.stranded).toEqual([])
    expect((await taskRow(fx.t, open.id))?.assignee_id).toBe(fx.agent.id)
    expect((await taskRow(fx.t, reviewing.id))?.reviewer_id).toBe(fx.agent.id)
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBeUndefined()
  })

  it('a team removal keeps its members as Viewers of the project', async () => {
    const fx = await setup()
    const sam = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Sam' })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: fx.team.id,
        profile_id: sam.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: fx.sub.id,
        team_id: fx.team.id,
        level: 'user',
      })
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, assignee_id: sam.id })
    const out = await setAccess(fx, fx.user, {
      team_id: fx.team.id,
      on_held_tasks: 'keep_as_viewer',
    })
    expect(out).toMatchObject({ team: { id: fx.team.id }, changed: true, kept_as_viewer: [sam.id] })
    expect((await grants(fx.t, fx.sub.id))[sam.id]).toBe('viewer')
  })

  it("the app's removal window runs the same function", async () => {
    const fx = await setup()
    const { open } = await held(fx)
    const remove = (p: Doc<'profiles'>, user_id: string, on_held_tasks: HeldTasks) =>
      as(fx.t, p).mutation(api.projects.removeAccess, {
        org_id: fx.org.id,
        id: fx.sub.id,
        user_id,
        on_held_tasks,
      })
    // the app tells a refused reassignment from a refused removal
    const reassigning = await expectRefusal(
      remove(fx.user, fx.pia.id, { reassign_to: fx.viewer.id }),
      'rule',
    )
    // src/store/planner.ts reads this reason (HELD_TASKS_REFUSED)
    expect((reassigning.data as Refusal).reason).toBe('held_tasks')
    const removing = await expectRefusal(
      remove(fx.admin, fx.user.id, { reassign_to: null }),
      'rule',
    )
    expect(removing.data).toEqual({ code: 'rule', message: LEAD_ACCESS_RULE })
    await remove(fx.user, fx.pia.id, { reassign_to: null })
    expect((await taskRow(fx.t, open.id))?.assignee_id).toBeUndefined()
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBeUndefined()
  })

  it('REST takes PUT {level} and DELETE with an optional on_held_tasks body over HTTP', async () => {
    const fx = await setup()
    await held(fx)
    const token = await mintToken(fx, fx.user)
    const call = async (method: string, path: string, body?: string) => {
      const res = await (
        fx.t as unknown as {
          fetch(
            path: string,
            init: { method: string; headers: Record<string, string>; body?: string },
          ): Promise<{ status: number; text(): Promise<string> }>
        }
      ).fetch(path, { method, headers: { Authorization: `Bearer ${token}` }, body })
      return { status: res.status, body: JSON.parse(await res.text()) as Json }
    }
    const path = `/v1/projects/FW/access/users/${fx.pia.id}`
    expect(await call('PUT', path, '{"level":"viewer"}')).toMatchObject({
      status: 200,
      body: { level: 'viewer', changed: true },
    })
    expect(await call('PUT', path, '{"level":"lead"}')).toEqual({
      status: 400,
      body: { error: 'level must be user or viewer; DELETE removes access' },
    })
    expect(await call('DELETE', path, '{"on_held_tasks":"later"}')).toEqual({
      status: 400,
      body: { error: HELD_TASKS_SHAPE },
    })
    // handing the tasks back to the person losing sight of them is refused
    expect(
      await call('DELETE', path, JSON.stringify({ on_held_tasks: { reassign_to: fx.pia.id } })),
    ).toEqual({
      status: 400,
      body: {
        error:
          'a task can only be assigned to an active user with Edit permission or higher on its project',
      },
    })
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBe('viewer')
    const removed = await call(
      'DELETE',
      path,
      JSON.stringify({ on_held_tasks: { reassign_to: null } }),
    )
    expect(removed.status).toBe(200)
    expect(removed.body).toMatchObject({ project_id: fx.sub.id, removed: true, stranded: [] })
    expect((removed.body.reassigned as Json[]).length).toBe(2)
    // an empty DELETE body leaves the tasks, and a team is named by its id
    expect(await call('DELETE', `/v1/projects/FW/access/teams/${fx.team.id}`)).toMatchObject({
      status: 200,
      body: { removed: false },
    })
    expect(await call('DELETE', `/v1/projects/FW/access/teams/${uuid()}`)).toEqual({
      status: 404,
      body: { error: 'team not found' },
    })
  })

  it('refuses a body field or an argument the change does not take, so nothing falls back to leave', async () => {
    const fx = await setup()
    await held(fx)
    const token = await mintToken(fx, fx.user)
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await (
        fx.t as unknown as {
          fetch(
            path: string,
            init: { method: string; headers: Record<string, string>; body?: string },
          ): Promise<{ status: number; text(): Promise<string> }>
        }
      ).fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: JSON.parse(await res.text()) as Json }
    }
    // a misspelled on_held_tasks would otherwise remove Pia and leave her tasks
    expect(
      await mcpCall(fx, token, 'set_project_access', {
        project: 'FW',
        user_id: fx.pia.id,
        level: null,
        on_held_task: 'keep_as_viewer',
      }),
    ).toEqual({
      text: 'Input validation error: Invalid arguments for tool set_project_access: Unrecognized key: "on_held_task"',
      isError: true,
    })
    const path = `/v1/projects/FW/access/users/${fx.pia.id}`
    expect(await call('DELETE', path, { on_held_task: 'keep_as_viewer' })).toEqual({
      status: 400,
      body: { error: 'unknown field "on_held_task"; this request takes on_held_tasks' },
    })
    expect(await call('PUT', path, { level: 'viewer', levle: 'user' })).toEqual({
      status: 400,
      body: { error: 'unknown field "levle"; this request takes level, expected' },
    })
    const team = `/v1/projects/FW/access/teams/${fx.team.id}`
    expect(await call('PUT', team, { level: 'viewer', on_held_tasks: 'leave' })).toEqual({
      status: 400,
      body: { error: 'unknown field "on_held_tasks"; this request takes level, expected' },
    })
    expect(await call('DELETE', team, { level: null })).toEqual({
      status: 400,
      body: { error: 'unknown field "level"; this request takes on_held_tasks' },
    })
    // both routes check the body before the path, so a bad body and an
    // unknown project or user answer the body's 400 on either
    const unknown = `/v1/projects/NOPE/access/users/${uuid()}`
    expect(await call('PUT', unknown, { levle: 'user' })).toEqual({
      status: 400,
      body: { error: 'unknown field "levle"; this request takes level, expected' },
    })
    expect(await call('PUT', unknown, { level: 'lead' })).toEqual({
      status: 400,
      body: { error: 'level must be user or viewer; DELETE removes access' },
    })
    expect(await call('DELETE', unknown, { on_held_task: 'leave' })).toEqual({
      status: 400,
      body: { error: 'unknown field "on_held_task"; this request takes on_held_tasks' },
    })
    // an array is no body, so it is no field list either
    for (const method of ['PUT', 'DELETE']) {
      expect(await call(method, path, ['x'])).toEqual({
        status: 400,
        body: { error: 'request body must be JSON' },
      })
    }
    expect(await grants(fx.t, fx.sub.id)).toEqual({ [fx.pia.id]: 'user' })
    expect(await activityFor(fx.t, fx.org.id)).toEqual([])
    // the field each route takes still passes, and an empty object is no field
    expect(await call('DELETE', team, {})).toMatchObject({ status: 200, body: { removed: false } })
    expect(await call('DELETE', path, { on_held_tasks: 'leave' })).toMatchObject({
      status: 200,
      body: { removed: true, kept_as_viewer: [] },
    })
    expect((await grants(fx.t, fx.sub.id))[fx.pia.id]).toBeUndefined()
  })

  it('parseHeldTasks takes the three choices and refuses anything else', () => {
    expect(parseHeldTasks(undefined)).toBe('leave')
    expect(parseHeldTasks(null)).toBe('leave')
    expect(parseHeldTasks('keep_as_viewer')).toBe('keep_as_viewer')
    expect(parseHeldTasks({ reassign_to: 'ABC' })).toEqual({ reassign_to: 'abc' })
    expect(parseHeldTasks({ reassign_to: null })).toEqual({ reassign_to: null })
    for (const bad of ['reassign', 1, [], { reassign_to: 1 }, { reassign_to: null, x: 1 }, {}]) {
      expect(() => parseHeldTasks(bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'bad_request', message: HELD_TASKS_SHAPE }),
        }),
      )
    }
  })
})

/* --------------------------------------------------------- 4. milestones */

describe('milestones', () => {
  const setMilestone = (fx: Fx, p: Doc<'profiles'>, args: Json) =>
    parsed(
      fx.t.mutation(internal.machine.projects.mcpSetMilestone, {
        ...as_(p),
        project: 'FW',
        ...args,
      } as never),
    )

  it('adds to the top-level project, checks the date, renames, moves and deletes', async () => {
    const fx = await setup()
    // Pia's grant on FW alone does not reach the top-level project
    await refused(
      setMilestone(fx, fx.pia, { name: 'Gate', date: '2026-03-02' }),
      'forbidden',
      'no write access to this project',
    )
    await refused(
      setMilestone(fx, fx.agent, { name: 'Gate', date: '2026-02-30' }),
      'bad_request',
      'date must be a valid calendar date',
    )
    await refused(
      setMilestone(fx, fx.agent, { name: ' ', date: '2026-03-02' }),
      'rule',
      'a milestone name cannot be blank',
    )
    await refused(
      setMilestone(fx, fx.agent, { name: 'Gate' }),
      'bad_request',
      'a new milestone needs name and date',
    )
    const made = await setMilestone(fx, fx.agent, { name: 'Gate', date: '2026-03-02' })
    expect(made).toMatchObject({
      name: 'Gate',
      date: '2026-03-02',
      project_id: fx.meta.id,
      created: true,
    })
    expect((await lastEvent(fx.t, fx.org.id))?.detail).toMatch(/^at W10, .*, via MCP$/)
    const renamed = await setMilestone(fx, fx.agent, { milestone: made.id, name: 'Freeze' })
    expect(renamed).toMatchObject({ name: 'Freeze', date: '2026-03-02', created: false })
    expect((await lastEvent(fx.t, fx.org.id))?.verb).toBe('renamed milestone')
    await refused(
      setMilestone(fx, fx.agent, { milestone: made.id, name: '  ' }),
      'rule',
      'a milestone name cannot be blank',
    )
    expect(
      await fx.t.mutation(internal.machine.projects.restUpdateMilestone, {
        ...rest(fx.agent),
        ref: 'FW',
        milestone: made.id as string,
        body: JSON.stringify({ name: ' Freeze ' }),
      }),
    ).toMatchObject({ name: 'Freeze' })
    await setMilestone(fx, fx.agent, { milestone: made.id, date: '2026-03-09' })
    expect((await lastEvent(fx.t, fx.org.id))?.verb).toBe('moved milestone')
    // REST shows it on the project and on its sub-projects
    const project = await fx.t.query(internal.machine.rest.getProject, {
      ...as_(fx.agent),
      ref: 'PCB',
    })
    expect(project.milestones).toEqual([{ id: made.id, name: 'Freeze', date: '2026-03-09' }])
    // a milestone named through a project that does not store it reads as missing
    await refused(
      fx.t.mutation(internal.machine.projects.restDeleteMilestone, {
        ...rest(fx.user),
        ref: 'SKNK',
        milestone: made.id as string,
      }),
      'not_found',
      'milestone not found',
    )
    expect(
      await fx.t.mutation(internal.machine.projects.restDeleteMilestone, {
        ...rest(fx.agent),
        ref: 'TBED',
        milestone: made.id as string,
      }),
    ).toEqual({ deleted: true, id: made.id })
    expect((await lastEvent(fx.t, fx.org.id))?.detail).toBe(VIA_REST)
  })

  it('refuses an archived project and a REST date that is no calendar day', async () => {
    const fx = await setup()
    await refused(
      fx.t.mutation(internal.machine.projects.restAddMilestone, {
        ...rest(fx.agent),
        ref: 'FW',
        body: JSON.stringify({ name: 'Gate', date: '2026-3-2' }),
      }),
      'bad_request',
      'date must be YYYY-MM-DD',
    )
    await fx.t.run((ctx) => ctx.db.patch(fx.meta._id, { archived_at: NOW }))
    await refused(
      setMilestone(fx, fx.agent, { name: 'Gate', date: '2026-03-02' }),
      'rule',
      'that project is archived, so restore it first',
    )
  })

  it("the app's milestone writes refuse a blank name and trim a padded one", async () => {
    const fx = await setup()
    await refused(
      as(fx.t, fx.user).mutation(api.projects.addMilestone, {
        org_id: fx.org.id,
        id: uuid(),
        project_id: fx.meta.id,
        name: '   ',
        week: '2026-03-02',
      }),
      'rule',
      'a milestone name cannot be blank',
    )
    // the roadmap's batch adds and changes milestones by the same rule
    const change = (operation: Json) =>
      as(fx.t, fx.user).mutation(api.roadmap.change, {
        session_id: uuid(),
        operations: [operation as never],
      })
    const add = (id: string, name: string) =>
      change({ kind: 'milestone_create', id, project_id: fx.sub.id, name, week: '2026-03-02' })
    const id = uuid()
    await refused(add(id, '  '), 'rule', 'a milestone name cannot be blank')
    await add(id, ' Gate ')
    const stored = () => fx.t.run((ctx) => ctx.db.query('milestones').collect())
    expect(await stored()).toMatchObject([{ id, name: 'Gate', project_id: fx.meta.id }])
    const rename = (name: string) => change({ kind: 'milestone_update', id, patch: { name } })
    await refused(rename(' '), 'rule', 'a milestone name cannot be blank')
    await rename(' Freeze ')
    expect(await stored()).toMatchObject([{ id, name: 'Freeze' }])
  })
})

/* ------------------------------------------------------- 5. reading one */

describe('reading one project', () => {
  it('shows the lead, review time, delay tracking, milestones and grants', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.meta._id, { review_hours: 4 })
      await ctx.db.insert('project_team_access', {
        project_id: fx.sub.id,
        team_id: fx.team.id,
        level: 'viewer',
      })
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: fx.meta.id,
        name: 'Launch',
        week: '2026-06-01',
        created_at: NOW,
      })
    })
    const out = await parsed(
      fx.t.query(internal.machine.projects.mcpGetProject, { ...as_(fx.agent), project: 'fw' }),
    )
    expect(out).toMatchObject({
      key: 'FW',
      type: 'project',
      // the agent's User grant on the parent reaches the sub-project
      access: { read: true, write: true },
      // a sub-project without a lead of its own is led by its parent's
      lead_id: fx.user.id,
      lead_name: 'user',
      review_hours: null,
      effective_review_hours: 4,
      track_delay: false,
      milestones: [{ name: 'Launch', date: '2026-06-01' }],
      grants: {
        users: [{ id: fx.pia.id, name: 'Pia', level: 'user' }],
        teams: [{ id: fx.team.id, name: 'Hardware', level: 'viewer' }],
      },
    })
    const restOut = await fx.t.query(internal.machine.rest.getProject, {
      ...as_(fx.agent),
      ref: 'FW',
    })
    expect(restOut).toMatchObject({
      access: { read: true, write: true },
      lead_id: fx.user.id,
      grants: out.grants,
    })
  })

  it('an admin who takes part in no project reads its management data without its planning data, and manages it', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.meta._id, { review_hours: 4 })
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: fx.meta.id,
        name: 'Launch',
        week: '2026-06-01',
        created_at: NOW,
      })
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await countOrg(fx.t, fx.org.id)
    const mcpGet = (p: Doc<'profiles'>, project: string) =>
      parsed(fx.t.query(internal.machine.projects.mcpGetProject, { ...as_(p), project }))
    const restGet = (p: Doc<'profiles'>, ref: string) =>
      fx.t.query(internal.machine.rest.getProject, { ...as_(p), ref })
    // the agent, who reads TBED, gets its planning data
    expect(await mcpGet(fx.agent, 'FW')).toMatchObject({
      access: { read: true, write: true },
      completion: { status: 'ok', done: 0, total: 1, percent: 0 },
      milestones: [{ name: 'Launch', date: '2026-06-01' }],
    })
    // the admin, who reads neither, gets each project's row, lead, settings
    // and grants, with completion unavailable and no milestones, never 0 of 0
    for (const ref of ['TBED', 'FW']) {
      const out = await mcpGet(fx.admin, ref)
      expect(out, ref).toMatchObject({
        key: ref,
        access: { read: false, write: false },
        lead_id: fx.user.id,
        effective_review_hours: 4,
        completion: { status: 'unavailable', done: null, total: null, percent: null },
        milestones: null,
      })
      expect(await restGet(fx.admin, ref)).toEqual(out)
    }
    expect((await mcpGet(fx.admin, 'FW')).grants).toEqual({
      users: [{ id: fx.pia.id, name: 'Pia', level: 'user' }],
      teams: [],
    })
    // the admin changes its settings over MCP and REST
    const renamed = await parsed(
      fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
        ...as_(fx.admin),
        project: 'FW',
        name: 'Firmware two',
      }),
    )
    expect(renamed).toMatchObject({ name: 'Firmware two', milestones: null })
    await fx.t.mutation(internal.machine.projects.restUpdateProject, {
      ...rest(fx.admin),
      ref: 'FW',
      body: '{"description":"Managed"}',
    })
    expect((await projectRow(fx.t, fx.sub.id))?.description).toBe('Managed')
    // archives and restores it; an archived project has no completion for anyone
    const archived = await fx.t.mutation(internal.machine.projects.restUpdateProject, {
      ...rest(fx.admin),
      ref: 'FW',
      body: '{"archived":true}',
    })
    expect(archived).toMatchObject({ archived: true, completion: null, milestones: null })
    expect(await restGet(fx.admin, 'FW')).toMatchObject({ completion: null })
    await fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
      ...as_(fx.admin),
      project: 'FW',
      archived: false,
    })
    expect((await projectRow(fx.t, fx.sub.id))?.archived_at).toBeUndefined()
    // changes its access over MCP and REST
    await fx.t.mutation(internal.machine.projects.mcpSetProjectAccess, {
      ...as_(fx.admin),
      project: 'FW',
      user_id: fx.pia.id,
      level: 'viewer',
    })
    await fx.t.mutation(internal.machine.projects.restSetUserAccess, {
      ...rest(fx.admin),
      ref: 'PCB',
      subject: fx.pia.id,
      body: '{"level":"user"}',
    })
    expect(await grants(fx.t, fx.sub.id)).toEqual({ [fx.pia.id]: 'viewer' })
    expect(await grants(fx.t, fx.sub2.id)).toEqual({ [fx.pia.id]: 'user' })
    await fx.t.mutation(internal.machine.projects.restRemoveUserAccess, {
      ...rest(fx.admin),
      ref: 'PCB',
      subject: fx.pia.id,
      body: '',
    })
    expect(await grants(fx.t, fx.sub2.id)).toEqual({})
    // a milestone, planning data, answers like an unknown project for them
    await refused(
      fx.t.mutation(internal.machine.projects.restAddMilestone, {
        ...rest(fx.admin),
        ref: 'TBED',
        body: '{"name":"Beta","date":"2026-07-01"}',
      }),
      'not_found',
      'project not found',
    )
    await refused(
      fx.t.mutation(internal.machine.projects.mcpSetMilestone, {
        ...as_(fx.admin),
        project: 'TBED',
        name: 'Beta',
        date: '2026-07-01',
      }),
      'not_found',
      'project "TBED" not found (or not visible to you)',
    )
    // and creates a sub-project under it, which they lead and so read, and
    // which shows them TBED for navigation from then on
    const made = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Managed child',
        parent: 'TBED',
      }),
    )
    expect(made).toMatchObject({ parent_id: fx.meta.id, access: { read: true } })
    const viaRest = await fx.t.mutation(internal.machine.projects.restCreateProject, {
      ...rest(fx.admin),
      body: JSON.stringify({ name: 'Managed REST child', parent: 'TBED' }),
    })
    expect(viaRest).toMatchObject({ parent_id: fx.meta.id })
    // Pia, who reads FW and manages nothing, finds SKNK nowhere
    await refused(
      mcpGet(fx.pia, 'SKNK'),
      'not_found',
      'project "SKNK" not found (or not visible to you)',
    )
    await refused(restGet(fx.pia, 'SKNK'), 'not_found', 'project not found')
    await refused(
      fx.t.mutation(internal.machine.projects.mcpSetProjectAccess, {
        ...as_(fx.pia),
        project: 'SKNK',
        user_id: fx.viewer.id,
        level: 'viewer',
      }),
      'not_found',
      'project "SKNK" not found (or not visible to you)',
    )
    await refused(
      fx.t.mutation(internal.machine.projects.restCreateProject, {
        ...rest(fx.pia),
        body: JSON.stringify({ name: 'Under SKNK', parent: 'SKNK' }),
      }),
      'bad_request',
      'parent project not found',
    )
    // the other organization's admin finds TBED nowhere
    await refused(restGet(fx.otherAdmin, 'TBED'), 'not_found', 'project not found')
    await refused(
      mcpGet(fx.otherAdmin, fx.meta.id),
      'not_found',
      `project "${fx.meta.id}" not found (or not visible to you)`,
    )
  })

  it('a project the caller cannot read answers like an unknown one', async () => {
    const fx = await setup()
    for (const ref of ['SKNK', 'NOPE']) {
      await refused(
        fx.t.query(internal.machine.projects.mcpGetProject, { ...as_(fx.agent), project: ref }),
        'not_found',
        `project "${ref}" not found (or not visible to you)`,
      )
      await refused(
        fx.t.mutation(internal.machine.projects.restUpdateProject, {
          ...rest(fx.agent),
          ref,
          body: '{"name":"x"}',
        }),
        'not_found',
        'project not found',
      )
    }
  })
})
