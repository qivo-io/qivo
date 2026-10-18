/* Teams over REST and MCP: listing teams with their members, creating and
 * renaming teams, and adding, removing, making and unmaking members and
 * leaders.
 *
 * TEAM_TOOLS and TEAM_ROUTES are registry entries (machine/registry.ts) that
 * machine/mcp.ts TOOLS and machine/rest.ts ROUTES spread in, like
 * machine/projects.ts. This module imports only types from those two, so
 * neither is loaded through it. The provenance, key name validator, body
 * parsers and MCP text it shares with them come from machine/shared.ts.
 * MCP's list_teams keeps its internal function in machine/mcp.ts and answers
 * model/teams.ts teamsJson like GET /v1/teams.
 *
 * Each action is one shared model function the app runs too (model/teams.ts
 * createTeamCore, updateTeamCore, addTeamMemberCore, setTeamLeaderCore and
 * removeTeamMemberCore). The internal functions below are thin per-surface
 * wrappers, `mcp*` and `rest*`: each starts from asMachineCaller, which
 * refuses a read-only credential before anything resolves, parses its
 * surface's input, calls the model and encodes the result.
 *
 * Teams are named by uuid only, because team names are not unique. Every
 * member of an organization sees its teams and their members, so a team or
 * user outside the organization is simply not found. Only a person changes
 * membership or leadership (lib/access.ts canChangeAccess), and only a person
 * leads a team (canLeadTeams). */

import { type ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { isTeamLeader } from '../lib/access'
import { asMachineCaller, type Caller } from '../lib/core'
import { vCredentialAccess } from '../lib/enums'
import { badRequest, notFound, type Refusal } from '../lib/functions'
import { NAME_MAX } from '../lib/textLimits'
import { newUuid } from '../model/orgs'
import {
  type AccessRemoval,
  type HeldTasks,
  ON_HELD_TASKS_SCHEMA,
  parseHeldTasks,
  vHeldTasks,
} from '../model/projectAccess'
import {
  addTeamMemberCore,
  createTeamCore,
  removeTeamMemberCore,
  setTeamLeaderCore,
  teamJson,
  teamsJson,
  updateTeamCore,
} from '../model/teams'
import type { TOOLS } from './mcp'
import { orgProfile, orgTeam, removalJson } from './projects'
import type { ROUTES, route as restRoute } from './rest'
import {
  MCP_PROVENANCE,
  needJson,
  optionalJson,
  pretty,
  refuseUnknownFields,
  restProvenance,
  vKeyName,
} from './shared'

type McpTool = (typeof TOOLS)[number]
type RestRoute = (typeof ROUTES)[number]

/* machine/rest.ts route(), which types each `run`'s params from its path.
 * Only its type is imported, so this module does not load rest.ts. */
const route: typeof restRoute = (declared) => declared

/* ---------------------------------------------------------------- shared */

/* Adds `member` to `team` when missing and, with `leader`, makes or unmakes
 * them a leader, in one transaction. Returns whether anything changed and
 * whether they lead the team afterwards. */
async function putMember(
  ctx: MutationCtx,
  a: {
    me: Caller
    team: Doc<'teams'>
    member: Doc<'profiles'>
    leader: boolean | undefined
    provenance: string
  },
): Promise<{ changed: boolean; leader: boolean }> {
  const now = new Date().toISOString()
  const base = { me: a.me, team: a.team, profileId: a.member.id, now, provenance: a.provenance }
  const added = await addTeamMemberCore(ctx, base)
  const promoted =
    a.leader === undefined
      ? { changed: false }
      : await setTeamLeaderCore(ctx, { ...base, isLeader: a.leader })
  return {
    changed: added.changed || promoted.changed,
    leader: await isTeamLeader(ctx, a.member, a.team.id),
  }
}

/* Removes `member` from `team`, settling their open tasks by `held`. */
const removeMember = (
  ctx: MutationCtx,
  a: {
    me: Caller
    team: Doc<'teams'>
    member: Doc<'profiles'>
    held: HeldTasks
    provenance: string
  },
): Promise<AccessRemoval> =>
  removeTeamMemberCore(ctx, {
    me: a.me,
    team: a.team,
    profileId: a.member.id,
    held: a.held,
    now: new Date().toISOString(),
    provenance: a.provenance,
  })

/* A team or person as results name them, by id and name only. */
const named = (row: { id: string; name: string }) => ({ id: row.id, name: row.name })

/* --------------------------------------------------------- MCP internals */

/* MCP's sentences for a team or user ref that matches nothing in the caller's organization. */
const mcpTeamMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`team "${ref}" not found in your organization`)
const mcpUserMissing = (ref: string): ConvexError<Refusal> =>
  badRequest(`user "${ref}" not found in your organization`)

/* set_team: create a team, or rename one. */
export const mcpSetTeam = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    team_id: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    if (a.team_id === undefined) {
      const now = new Date().toISOString()
      const team = await createTeamCore(ctx, { me, id: newUuid(), name: a.name, now })
      return pretty({ ...(await teamJson(ctx, team)), created: true })
    }
    const found = await orgTeam(ctx, me, a.team_id)
    if (found === null) throw mcpTeamMissing(a.team_id)
    const team = await updateTeamCore(ctx, { me, team: found, patch: { name: a.name } })
    return pretty({ ...(await teamJson(ctx, team)), created: false })
  },
})

/* set_team_member: add or remove one member, and make or unmake a leader. A
 * removal is an access removal for the read-only gate (asMachineCaller), as
 * in the app. */
export const mcpSetTeamMember = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    team_id: v.string(),
    user_id: v.string(),
    member: v.boolean(),
    leader: v.optional(v.boolean()),
    on_held_tasks: v.optional(vHeldTasks),
  },
  handler: async (ctx, a): Promise<string> => {
    const write = a.member ? 'change' : 'access_removal'
    const me = await asMachineCaller(ctx, a.callerId, a.access, write)
    if (!a.member && a.leader !== undefined) {
      throw badRequest('leader applies only when member is true')
    }
    if (a.member && a.on_held_tasks !== undefined) {
      throw badRequest('on_held_tasks applies only when member is false')
    }
    const team = await orgTeam(ctx, me, a.team_id)
    if (team === null) throw mcpTeamMissing(a.team_id)
    const member = await orgProfile(ctx, me, a.user_id)
    if (member === null) throw mcpUserMissing(a.user_id)
    const base = { team: named(team), user: named(member) }
    if (a.member) {
      const put = await putMember(ctx, {
        me,
        team,
        member,
        leader: a.leader,
        provenance: MCP_PROVENANCE,
      })
      return pretty({ ...base, member: true, leader: put.leader, changed: put.changed })
    }
    const removal = await removeMember(ctx, {
      me,
      team,
      member,
      held: a.on_held_tasks ?? 'leave',
      provenance: MCP_PROVENANCE,
    })
    return pretty({
      ...base,
      member: false,
      leader: false,
      changed: removal.removed,
      ...removalJson(removal),
    })
  },
})

/* -------------------------------------------------------- REST internals */

/* A REST team path ref in the caller's organization, else the one 404. */
async function restTeam(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'teams'>> {
  const team = await orgTeam(ctx, me, ref)
  if (team === null) throw notFound('team not found')
  return team
}

/* A REST member path ref in the caller's organization, else the one 404. */
async function restUser(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'profiles'>> {
  const profile = await orgProfile(ctx, me, ref)
  if (profile === null) throw notFound('user not found')
  return profile
}

/* A REST body's team name: a string when present. */
function restName(b: Record<string, unknown>): string | undefined {
  if (!('name' in b)) return undefined
  if (typeof b.name !== 'string') throw badRequest('name must be a string')
  return b.name
}

/* GET /v1/teams: every team with its members. */
export const restListTeams = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return await teamsJson(ctx, me)
  },
})

/* GET /v1/teams/{ref}: one team with its members. */
export const restGetTeam = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return await teamJson(ctx, await restTeam(ctx, me, a.ref))
  },
})

/* POST /v1/teams {name}. */
export const restCreateTeam = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, body: v.string() },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const name = restName(needJson(a.body))
    if (name === undefined) throw badRequest('name is required')
    const now = new Date().toISOString()
    return await teamJson(ctx, await createTeamCore(ctx, { me, id: newUuid(), name, now }))
  },
})

/* PATCH /v1/teams/{ref} {name}. Unknown fields are ignored. */
export const restUpdateTeam = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const team = await restTeam(ctx, me, a.ref)
    const name = restName(needJson(a.body))
    if (name === undefined) throw badRequest('no recognized fields to update')
    return await teamJson(ctx, await updateTeamCore(ctx, { me, team, patch: { name } }))
  },
})

/* PUT /v1/teams/{ref}/members/{user}, with an optional body {leader}. Any
 * other body field is refused (refuseUnknownFields). The body is checked
 * before the path, as on DELETE. */
export const restPutMember = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    user: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const b = optionalJson(a.body)
    refuseUnknownFields(b, ['leader'])
    if ('leader' in b && typeof b.leader !== 'boolean') {
      throw badRequest('leader must be a boolean')
    }
    const team = await restTeam(ctx, me, a.ref)
    const member = await restUser(ctx, me, a.user)
    const put = await putMember(ctx, {
      me,
      team,
      member,
      leader: b.leader as boolean | undefined,
      provenance: restProvenance(a.keyName),
    })
    return { team_id: team.id, user: named(member), leader: put.leader, changed: put.changed }
  },
})

/* DELETE /v1/teams/{ref}/members/{user}, with an optional body
 * {on_held_tasks}. Any other body field is refused (refuseUnknownFields),
 * so a misspelled choice never falls back to `leave`. An access removal for
 * the read-only gate (asMachineCaller), as in the app. */
export const restDeleteMember = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    keyName: vKeyName,
    ref: v.string(),
    user: v.string(),
    body: v.string(),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access, 'access_removal')
    const b = optionalJson(a.body)
    refuseUnknownFields(b, ['on_held_tasks'])
    const held = parseHeldTasks(b.on_held_tasks)
    const team = await restTeam(ctx, me, a.ref)
    const member = await restUser(ctx, me, a.user)
    const removal = await removeMember(ctx, {
      me,
      team,
      member,
      held,
      provenance: restProvenance(a.keyName),
    })
    return {
      team_id: team.id,
      user: named(member),
      removed: removal.removed,
      ...removalJson(removal),
    }
  },
})

/* ------------------------------------------------------- registry entries */

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

/** The MCP tools of this domain, in tools/list order after the projects'. */
export const TEAM_TOOLS: McpTool[] = [
  {
    access: 'write',
    def: {
      name: 'set_team',
      title: 'Set team',
      description:
        'Without `team_id`, create a team called `name`, which only an organization admin may do. With `team_id` (from list_teams), rename that team, which an organization admin or a leader of the team may do.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          team_id: {
            type: 'string',
          },
          name: {
            type: 'string',
            maxLength: NAME_MAX,
          },
        },
        required: ['name'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.teams.mcpSetTeam, {
        callerId,
        access,
        ...(args as { team_id?: string; name: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'set_team_member',
      title: 'Set team member',
      description:
        'Add a user to a team (`member: true`) or remove them (`member: false`); with `member: true`, `leader` makes or unmakes them a leader. Needs a person who is an organization admin or a leader of the team, and only people lead teams. On removal, `on_held_tasks` settles open tasks the user can no longer see: `leave` (the default; the result lists them), `keep_as_viewer`, or `{"reassign_to": user id or null}`.',
      inputSchema: {
        type: 'object',
        $schema: SCHEMA,
        properties: {
          team_id: {
            type: 'string',
          },
          user_id: {
            type: 'string',
          },
          member: {
            type: 'boolean',
          },
          leader: {
            type: 'boolean',
          },
          on_held_tasks: ON_HELD_TASKS_SCHEMA,
        },
        required: ['team_id', 'user_id', 'member'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { on_held_tasks, ...rest } = args as {
        team_id: string
        user_id: string
        member: boolean
        leader?: boolean
        on_held_tasks?: unknown
      }
      return r.runMutation(internal.machine.teams.mcpSetTeamMember, {
        callerId,
        access,
        ...rest,
        ...(on_held_tasks === undefined ? {} : { on_held_tasks: parseHeldTasks(on_held_tasks) }),
      })
    },
  },
]

/** The REST routes of this domain, matched after the projects'. */
export const TEAM_ROUTES: RestRoute[] = [
  route({
    method: 'GET',
    path: 'teams',
    access: 'read',
    status: 200,
    run: (r, { callerId, access }) =>
      r.runQuery(internal.machine.teams.restListTeams, { callerId, access }),
  }),
  route({
    method: 'GET',
    path: 'teams/:ref',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runQuery(internal.machine.teams.restGetTeam, { callerId, access, ref: param('ref') }),
  }),
  route({
    method: 'POST',
    path: 'teams',
    access: 'write',
    status: 201,
    run: (r, { callerId, access, body }) =>
      r.runMutation(internal.machine.teams.restCreateTeam, { callerId, access, body }),
  }),
  route({
    method: 'PATCH',
    path: 'teams/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.teams.restUpdateTeam, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'PUT',
    path: 'teams/:ref/members/:user',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.teams.restPutMember, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        user: param('user'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'teams/:ref/members/:user',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, keyName, param, body }) =>
      r.runMutation(internal.machine.teams.restDeleteMember, {
        callerId,
        access,
        keyName,
        ref: param('ref'),
        user: param('user'),
        body,
      }),
  }),
]
