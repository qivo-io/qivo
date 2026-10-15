/* Projects over REST and MCP (machine/projects.ts) and the shared project
 * rules the app runs too (model/projects.ts, model/projectAccess.ts,
 * model/milestones.ts, lib/projectGrants.ts).
 *
 *   1. Creating projects and sub-projects: the creation setting per kind of
 *      caller, Lead on the parent, a hidden parent read as missing, the
 *      creator's own grant and who may name another lead.
 *   2. Changing a project: settings with Lead access, archive and restore as
 *      a field, and the lead handover that keeps the old lead as User.
 *   3. Access one user or team at a time, and what a removal does with the
 *      open tasks it hides (leave, keep_as_viewer, reassign_to), all at once.
 *   4. Milestones folded to the top-level project, with real dates.
 *   5. Reading one project, and the refusals that reveal nothing. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { ACCESS_NEEDS_A_PERSON } from '../lib/access'
import type { Refusal, RefusalCode } from '../lib/functions'
import { creatorGrant, grantsAfterHandover } from '../lib/projectGrants'
import { sha256hex } from '../machine/auth'
import {
  HELD_TASKS_SHAPE,
  type HeldTasks,
  LEAD_ACCESS_RULE,
  parseHeldTasks,
  removeProjectGrantCore,
} from '../model/projectAccess'
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
    expect(out).toMatchObject({
      key: 'LM',
      num: 6,
      name: 'Luma Mount',
      type: 'meta',
      parent_id: null,
      description: 'Housing',
      lead_id: fx.admin.id,
      lead_name: 'admin',
      milestones: [],
      grants: { users: [], teams: [] },
    })
    const row = await projectRow(fx.t, out.id as string)
    // after both existing top-level projects
    expect(row).toMatchObject({ sort_order: 2, track_delay: true })
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
    it(`under ${setting}, admins${user ? ' and standard users' : ''} create projects; agents and viewers do not`, async () => {
      const fx = await setup()
      await setCreators(fx, setting)
      const create = (p: Doc<'profiles'>, name: string) =>
        fx.t.mutation(internal.machine.projects.mcpCreateProject, { ...as_(p), name })
      expect((await parsed(create(fx.admin, 'By admin'))).lead_id).toBe(fx.admin.id)
      if (user) expect((await parsed(create(fx.user, 'By user'))).lead_id).toBe(fx.user.id)
      else await refused(create(fx.user, 'By user'), 'forbidden', refusal)
      // an agent counts as no standard user here, and a viewer never creates
      await refused(create(fx.agent, 'By agent'), 'forbidden', refusal)
      await refused(create(fx.viewer, 'By viewer'), 'forbidden', refusal)
    })
  }

  it('a standard user ticked under selected creates projects', async () => {
    const fx = await setup()
    await setCreators(fx, 'selected')
    await fx.t.run((ctx) => ctx.db.patch(fx.user._id, { can_create_projects: true }))
    const out = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.user),
        name: 'Ticked',
      }),
    )
    expect(out.lead_id).toBe(fx.user.id)
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
    await refused(sub(fx.user, 'SKNK'), 'rule', 'the project is archived — restore it first')
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

  it('a creator naming another lead keeps User access, unless an admin', async () => {
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
    const byAdmin = await parsed(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Given',
        lead_id: fx.pia.id,
      }),
    )
    expect(await grants(fx.t, byAdmin.id as string)).toEqual({})
    // a lead must be someone who can lead
    await refused(
      fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        ...as_(fx.admin),
        name: 'Viewed',
        lead_id: fx.viewer.id,
      }),
      'rule',
      'a viewer cannot lead a project — make them a standard user first',
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
      'bad_request',
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

  it('creatorGrant: an own entry decides, else User for a non-admin naming another lead', () => {
    const base = { creator: 'me', lead: 'leo', own: undefined }
    expect(creatorGrant({ ...base, admin: false })).toBe('user')
    expect(creatorGrant({ ...base, admin: true })).toBeNull()
    expect(creatorGrant({ ...base, admin: false, lead: 'me' })).toBeNull()
    expect(creatorGrant({ ...base, admin: false, own: null })).toBeNull()
    expect(creatorGrant({ ...base, admin: true, own: 'viewer' })).toBe('viewer')
  })
})

/* ----------------------------------------------------- 2. changing projects */

describe('changing a project', () => {
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
      description: 'Rig',
      review_hours: 1.25,
      track_delay: true,
      unknown: 1,
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
      detail: `from “Testbed platform” — ${VIA_REST}`,
    })
    // Edit on the project is not Lead; the fields a body cannot write
    await refused(
      patch(fx.agent, { name: 'Mine' }),
      'forbidden',
      'requires lead access to this project',
    )
    await refused(patch(fx.user, {}), 'bad_request', 'no recognized fields to update')
    await refused(patch(fx.user, { name: ' ' }), 'bad_request', 'a project name cannot be blank')
    await refused(
      patch(fx.user, { review_hours: '2' }),
      'bad_request',
      'review_hours must be a number of hours from 0 to 999, or null',
    )
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
    expect((await patch(fx.user, { review_hours: null })).review_hours).toBeNull()
  })

  it('archives and restores with the archived field, carrying the sub-projects', async () => {
    const fx = await setup()
    const update = (args: Json) =>
      parsed(
        fx.t.mutation(internal.machine.projects.mcpUpdateProject, {
          ...as_(fx.user),
          project: 'TBED',
          ...args,
        }),
      )
    const archived = await update({ archived: true })
    expect(archived.archived_at).not.toBeNull()
    expect((await projectRow(fx.t, fx.sub.id))?.archived_at).toBe(archived.archived_at)
    expect(await lastEvent(fx.t, fx.org.id)).toMatchObject({
      verb: 'archived',
      detail: 'with 2 sub-projects — via MCP',
    })
    // one call restores first, so the rename lands on the active project
    const back = await update({ archived: false, name: 'Back' })
    expect(back).toMatchObject({ archived_at: null, name: 'Back' })
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
      detail: 'to user (was Pia) — via MCP',
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
    // nothing left to remove changes nothing
    expect(await setAccess(fx, fx.user, { user_id: fx.pia.id })).toMatchObject({
      changed: false,
      stranded: [],
    })
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
    const token = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: fx.user.id,
        name: 'Lead token',
        token_prefix: token.slice(0, 11),
        token_hash: await sha256hex(token),
        access: 'write',
        created_at: NOW,
      })
    })
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
      'bad_request',
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
    expect((await lastEvent(fx.t, fx.org.id))?.detail).toMatch(/^at W10, .* — via MCP$/)
    const renamed = await setMilestone(fx, fx.agent, { milestone: made.id, name: 'Freeze' })
    expect(renamed).toMatchObject({ name: 'Freeze', date: '2026-03-02', created: false })
    expect((await lastEvent(fx.t, fx.org.id))?.verb).toBe('renamed milestone')
    await refused(
      setMilestone(fx, fx.agent, { milestone: made.id, name: '  ' }),
      'bad_request',
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
      'that project is archived — restore it first',
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
      'bad_request',
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
    await refused(add(id, '  '), 'bad_request', 'a milestone name cannot be blank')
    await add(id, ' Gate ')
    const stored = () => fx.t.run((ctx) => ctx.db.query('milestones').collect())
    expect(await stored()).toMatchObject([{ id, name: 'Gate', project_id: fx.meta.id }])
    const rename = (name: string) => change({ kind: 'milestone_update', id, patch: { name } })
    await refused(rename(' '), 'bad_request', 'a milestone name cannot be blank')
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
