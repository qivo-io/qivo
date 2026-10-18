/* What a profile can hold on the withOrg fixture's projects, planted shape
 * by shape. The batched access reads (lib/access.ts projectLevelsForOrg and
 * projectLevelsForProfiles) are checked against the per-project predicates
 * over every shape here, in accessFlags.test.ts and projectUsers.test.ts. */
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { GRANT_LEVELS, type GrantLevel } from '../lib/enums'
import { NOW, type OrgFixture, uuid } from './helpers.setup'

const grant = (
  ctx: MutationCtx,
  project: Doc<'projects'>,
  me: Doc<'profiles'>,
  level: GrantLevel,
) => ctx.db.insert('project_access', { project_id: project.id, profile_id: me.id, level })

const join = (ctx: MutationCtx, teamId: string, me: Doc<'profiles'>, is_leader = false) =>
  ctx.db.insert('team_members', { team_id: teamId, profile_id: me.id, is_leader })

const share = (ctx: MutationCtx, project: Doc<'projects'>, teamId: string, level: GrantLevel) =>
  ctx.db.insert('project_team_access', { project_id: project.id, team_id: teamId, level })

/* A new team of organization `orgId`, without members. */
export async function newTeam(ctx: MutationCtx, orgId: string): Promise<string> {
  const id = uuid()
  await ctx.db.insert('teams', {
    id,
    org_id: orgId,
    name: 'Second',
    stale_days: 14,
    archive_days: 30,
    track_delay_default: false,
    created_at: NOW,
  })
  return id
}

/* What the subject holds, planted over the withOrg fixture: the TBED meta
 * (led by `user`) with sub-projects FW and PCB, and SKNK, which no shape
 * touches. */
export type Shape = [
  name: string,
  plant: (ctx: MutationCtx, f: OrgFixture, me: Doc<'profiles'>) => Promise<unknown>,
]

export const SHAPES: Shape[] = [
  ['no grant', async () => {}],
  ...GRANT_LEVELS.flatMap((level): Shape[] => [
    [`${level} grant on the parent`, (ctx, f, me) => grant(ctx, f.meta, me, level)],
    [`${level} grant on a sub-project`, (ctx, f, me) => grant(ctx, f.sub, me, level)],
    [
      `${level} team share on the parent`,
      async (ctx, f, me) => {
        await join(ctx, f.team.id, me)
        await share(ctx, f.meta, f.team.id, level)
      },
    ],
    [
      `${level} team share on a sub-project`,
      async (ctx, f, me) => {
        await join(ctx, f.team.id, me)
        await share(ctx, f.sub, f.team.id, level)
      },
    ],
  ]),
  [
    'viewer grant on the parent and user grant on a sub-project',
    async (ctx, f, me) => {
      await grant(ctx, f.meta, me, 'viewer')
      await grant(ctx, f.sub, me, 'user')
    },
  ],
  [
    'viewer team share and user grant on the parent',
    async (ctx, f, me) => {
      await join(ctx, f.team.id, me)
      await share(ctx, f.meta, f.team.id, 'viewer')
      await grant(ctx, f.meta, me, 'user')
    },
  ],
  [
    'user team share and viewer grant on a sub-project',
    async (ctx, f, me) => {
      await join(ctx, f.team.id, me)
      await share(ctx, f.sub, f.team.id, 'user')
      await grant(ctx, f.sub, me, 'viewer')
    },
  ],
  [
    'viewer and user shares on the parent through two teams',
    async (ctx, f, me) => {
      const other = await newTeam(ctx, f.org.id)
      await join(ctx, f.team.id, me)
      await join(ctx, other, me)
      await share(ctx, f.meta, f.team.id, 'viewer')
      await share(ctx, f.meta, other, 'user')
    },
  ],
  [
    'viewer grant on one sub-project and user grant on the other',
    async (ctx, f, me) => {
      await grant(ctx, f.sub, me, 'viewer')
      await grant(ctx, f.sub2, me, 'user')
    },
  ],
  [
    'a share through a team whose row is gone',
    async (ctx, f, me) => {
      const gone = uuid()
      await join(ctx, gone, me)
      await share(ctx, f.meta, gone, 'user')
    },
  ],
  [
    'a share on the parent to a team the subject is not in',
    (ctx, f) => share(ctx, f.meta, f.team.id, 'user'),
  ],
  [
    "another organization's team shared on the parent",
    async (ctx, f, me) => {
      const teamId = await newTeam(ctx, f.otherOrg.id)
      await join(ctx, teamId, me)
      await share(ctx, f.meta, teamId, 'user')
    },
  ],
  ['leader of a team without shares', (ctx, f, me) => join(ctx, f.team.id, me, true)],
  ['lead of the parent', (ctx, f, me) => ctx.db.patch(f.meta._id, { lead_id: me.id })],
  [
    'lead of the parent while someone else leads a sub-project',
    async (ctx, f, me) => {
      await ctx.db.patch(f.meta._id, { lead_id: me.id })
      await ctx.db.patch(f.sub2._id, { lead_id: f.user.id })
    },
  ],
  ['lead of a sub-project', (ctx, f, me) => ctx.db.patch(f.sub._id, { lead_id: me.id })],
  [
    'user grant on an archived sub-project',
    async (ctx, f, me) => {
      await ctx.db.patch(f.sub._id, { archived_at: NOW })
      await grant(ctx, f.sub, me, 'user')
    },
  ],
  [
    "user grant on another organization's project",
    (ctx, f, me) => grant(ctx, f.otherProject, me, 'user'),
  ],
]
