/* Unit tests for the access family (lib/access.ts) — the phase-1 gate.
 * No public functions exist yet, so every predicate is driven through
 * t.run(ctx => …) over the withOrg mini-Testbed fixture. Each test gets a
 * fresh backend: the tests that plant hostile rows (a viewer leader row, a
 * cross-org leader row, a dangling parent) never leak into each other. */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import {
  canAccessProject,
  canLeadTeams,
  canManageOrgLabels,
  canSeeProject,
  canWriteOrgLabels,
  cappedLevel,
  hasProjectLevel,
  isOrgStaff,
  isTeamLeader,
  LABEL_WRITE_READ,
  levelRank,
  profileCanSeeProject,
  projectSightForProfiles,
  rootMetaOf,
  SIGHT_READ,
} from '../lib/access'
import { ACCESS_LEVELS, type AccessLevel, type OrgRole } from '../lib/enums'
import { orgProjectView } from '../lib/visibility'
import {
  expectRefusal,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

let t: T
let f: OrgFixture

beforeEach(async () => {
  t = newT()
  f = await withOrg(t)
})

const LEVELS: (AccessLevel | null)[] = [...ACCESS_LEVELS, null]

describe('levelRank', () => {
  it('ranks admin=lead=3 > user=2 > viewer=1, and null is 0', () => {
    expect(levelRank('admin')).toBe(3)
    expect(levelRank('lead')).toBe(3)
    expect(levelRank('user')).toBe(2)
    expect(levelRank('viewer')).toBe(1)
    expect(levelRank(null)).toBe(0)
  })
})

describe('cappedLevel', () => {
  it('a viewer org-role clamps every level above viewer down to viewer', () => {
    expect(cappedLevel('viewer', 'admin')).toBe('viewer')
    expect(cappedLevel('viewer', 'lead')).toBe('viewer')
    expect(cappedLevel('viewer', 'user')).toBe('viewer')
    expect(cappedLevel('viewer', 'viewer')).toBe('viewer')
  })

  it('null passes through for every role — the cap can never grant', () => {
    for (const role of ['admin', 'user', 'guest', 'viewer'] as OrgRole[]) {
      expect(cappedLevel(role, null)).toBeNull()
    }
  })

  it('non-viewer roles pass every level through untouched', () => {
    for (const role of ['admin', 'user', 'guest'] as OrgRole[]) {
      for (const level of LEVELS) {
        expect(cappedLevel(role, level)).toBe(level)
      }
    }
  })
})

describe('isOrgStaff', () => {
  it('admin and user are staff — an agent counts by its org_role', () => {
    expect(isOrgStaff(f.admin)).toBe(true)
    expect(isOrgStaff(f.user)).toBe(true)
    expect(isOrgStaff(f.agent)).toBe(true)
  })

  it('guest and viewer are not staff', () => {
    expect(isOrgStaff(f.guest)).toBe(false)
    expect(isOrgStaff(f.viewer)).toBe(false)
  })

  it('is a POSITIVE test: an unknown 5th role gets nothing', () => {
    expect(isOrgStaff({ ...f.guest, org_role: 'superuser' as OrgRole })).toBe(false)
  })
})

describe('rootMetaOf', () => {
  it('resolves a sub to its meta and a meta to itself', async () => {
    await t.run(async (ctx) => {
      expect((await rootMetaOf(ctx, f.sub)).id).toBe(f.meta.id)
      expect((await rootMetaOf(ctx, f.sub2)).id).toBe(f.meta.id)
      expect((await rootMetaOf(ctx, f.meta)).id).toBe(f.meta.id)
    })
  })

  it('a dangling parent fails closed with not_found', async () => {
    const dangling = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: f.org.id,
        type: 'project',
        parent_id: uuid(),
        key: 'DGL',
        name: 'Dangling',
        description: '',
        sort_order: 9,
        num: 9,
        track_delay: false,
        created_at: f.sub.created_at,
      })
      return (await ctx.db.get(_id))!
    })
    await expectRefusal(
      t.run((ctx) => rootMetaOf(ctx, dangling)),
      'not_found',
      /project not found/,
    )
  })
})

describe('canSeeProject', () => {
  it('admin sees every project in the org, including the hidden control', async () => {
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.admin, f.meta)).toBe(true)
      expect(await canSeeProject(ctx, f.admin, f.sub)).toBe(true)
      expect(await canSeeProject(ctx, f.admin, f.hidden)).toBe(true)
    })
  })

  it('admin does NOT see another org (the org fence beats the admin branch)', async () => {
    expect(await t.run((ctx) => canSeeProject(ctx, f.admin, f.otherProject))).toBe(false)
  })

  it('the named lead sees the product and its sub-projects', async () => {
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.user, f.hidden)).toBe(true) // lead_id
      expect(await canSeeProject(ctx, f.user, f.meta)).toBe(true) // project lead
      expect(await canSeeProject(ctx, f.user, f.sub)).toBe(true) // via root meta
    })
  })

  it('a plain org user with no grant, lead, or team sees nothing', async () => {
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.agent, f.meta)).toBe(false)
      expect(await canSeeProject(ctx, f.agent, f.sub)).toBe(false)
      expect(await canSeeProject(ctx, f.agent, f.hidden)).toBe(false)
    })
  })

  it('viewer sees the granted meta and its subs, never the hidden control', async () => {
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.viewer, f.meta)).toBe(true)
      expect(await canSeeProject(ctx, f.viewer, f.sub)).toBe(true)
      expect(await canSeeProject(ctx, f.viewer, f.hidden)).toBe(false)
    })
  })

  it('for a viewer the grant is the ONLY way in — a leader row grants nothing', async () => {
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.viewer.id),
        )
        .unique()
      await ctx.db.delete(grant!._id)
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.viewer.id,
        is_leader: true,
      })
    })
    expect(await t.run((ctx) => canSeeProject(ctx, f.viewer, f.meta))).toBe(false)
    expect(await t.run((ctx) => canSeeProject(ctx, f.viewer, f.sub))).toBe(false)
  })

  it('guest sees only the granted meta+subs; hidden and foreign projects stay dark', async () => {
    await t.run(async (ctx) => {
      expect(await canSeeProject(ctx, f.guest, f.meta)).toBe(true)
      expect(await canSeeProject(ctx, f.guest, f.sub)).toBe(true)
      expect(await canSeeProject(ctx, f.guest, f.sub2)).toBe(true)
      expect(await canSeeProject(ctx, f.guest, f.hidden)).toBe(false)
      expect(await canSeeProject(ctx, f.guest, f.otherProject)).toBe(false)
    })
  })
})

describe('hasProjectLevel', () => {
  it("viewer with a 'user' grant is still capped to viewer — writes refuse", async () => {
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, f.viewer, f.meta.id, 'user')).toBe(false)
      expect(await hasProjectLevel(ctx, f.viewer, f.sub.id, 'user')).toBe(false)
      expect(await hasProjectLevel(ctx, f.viewer, f.meta.id, 'lead')).toBe(false)
    })
  })

  it("guest's 'user' grant reaches min 'user' and stops below 'lead'", async () => {
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, f.guest, f.meta.id, 'user')).toBe(true)
      expect(await hasProjectLevel(ctx, f.guest, f.sub.id, 'user')).toBe(true)
      expect(await hasProjectLevel(ctx, f.guest, f.meta.id, 'lead')).toBe(false)
      expect(await hasProjectLevel(ctx, f.guest, f.meta.id, 'admin')).toBe(false)
    })
  })

  it("a named lead resolves to level 'lead' on its product and sub-projects", async () => {
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, f.user, f.hidden.id, 'lead')).toBe(true) // lead_id
      expect(await hasProjectLevel(ctx, f.user, f.meta.id, 'lead')).toBe(true) // project lead
      expect(await hasProjectLevel(ctx, f.user, f.sub.id, 'lead')).toBe(true) // via root
      expect(await hasProjectLevel(ctx, f.user, f.meta.id, 'user')).toBe(true) // rank order
    })
  })

  it("admin's lead branch satisfies even min 'admin' (rank 3 = rank 3)", async () => {
    expect(await t.run((ctx) => hasProjectLevel(ctx, f.admin, f.meta.id, 'admin'))).toBe(true)
  })

  it('no grant, no standing: a plain org user has no level at all', async () => {
    await t.run(async (ctx) => {
      expect(await hasProjectLevel(ctx, f.agent, f.meta.id, 'user')).toBe(false)
      expect(await hasProjectLevel(ctx, f.agent, f.hidden.id, 'user')).toBe(false)
    })
  })

  it('an unknown project id answers false, like the empty SQL join', async () => {
    expect(await t.run((ctx) => hasProjectLevel(ctx, f.admin, uuid(), 'user'))).toBe(false)
  })

  it('a foreign-org project answers false even for an admin', async () => {
    expect(await t.run((ctx) => hasProjectLevel(ctx, f.admin, f.otherProject.id, 'user'))).toBe(
      false,
    )
  })
})

describe('profileCanSeeProject', () => {
  it('mirrors canSeeProject for a recipient', async () => {
    await t.run(async (ctx) => {
      expect(await profileCanSeeProject(ctx, f.guest, f.sub)).toBe(true)
      expect(await profileCanSeeProject(ctx, f.viewer, f.meta)).toBe(true)
      expect(await profileCanSeeProject(ctx, f.viewer, f.hidden)).toBe(false)
      expect(await profileCanSeeProject(ctx, f.agent, f.meta)).toBe(false)
    })
  })

  it('fences a cross-org recipient', async () => {
    expect(await t.run((ctx) => profileCanSeeProject(ctx, f.otherAdmin, f.meta))).toBe(false)
  })

  it('carries NO active fence — that gate belongs to the caller wrappers', async () => {
    await t.run((ctx) => ctx.db.patch(f.guest._id, { active: false }))
    const inactive = await t.run((ctx) => ctx.db.get(f.guest._id))
    expect(await t.run((ctx) => profileCanSeeProject(ctx, inactive!, f.sub))).toBe(true)
  })
})

describe('projectSightForProfiles', () => {
  it('answers canSeeProject for every profile at once, team shares and navigation included', async () => {
    await t.run(async (ctx) => {
      // The agent reaches sub2 through a team share alone, so it sees the
      // meta only for navigation. The viewer loses its own meta grant and
      // sees the meta through a team share instead.
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.agent.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.viewer.id),
        )
        .unique()
      await ctx.db.delete(grant!._id)
      const viewers = uuid()
      await ctx.db.insert('teams', {
        id: viewers,
        org_id: f.org.id,
        name: 'Viewers',
        track_delay_default: false,
        created_at: f.team.created_at,
      })
      await ctx.db.insert('team_members', {
        team_id: viewers,
        profile_id: f.viewer.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: viewers,
        level: 'viewer',
      })
      const people = [f.admin, f.user, f.agent, f.viewer, f.guest, f.otherAdmin]
      // read in full, each profile asked alone, and a mix of the two
      const saved = SIGHT_READ.max
      try {
        for (const max of [saved, 0, 2]) {
          SIGHT_READ.max = max
          for (const project of [f.meta, f.sub, f.sub2, f.hidden, f.otherProject]) {
            const sees = await projectSightForProfiles(ctx, project)
            for (const person of people) {
              const expected = await canSeeProject(ctx, person, project)
              expect([max, project.name, person.name, await sees(person)]).toEqual([
                max,
                project.name,
                person.name,
                expected,
              ])
            }
          }
        }
      } finally {
        SIGHT_READ.max = saved
      }
      expect(await (await projectSightForProfiles(ctx, f.meta))(f.agent)).toBe(true)
      expect(await (await projectSightForProfiles(ctx, f.sub))(f.agent)).toBe(false)
      expect(await (await projectSightForProfiles(ctx, f.sub2))(f.agent)).toBe(true)
      expect(await (await projectSightForProfiles(ctx, f.sub))(f.viewer)).toBe(true)
      expect(await (await projectSightForProfiles(ctx, f.hidden))(f.viewer)).toBe(false)
    })
  })
})

describe('canAccessProject', () => {
  it('excludes a parent seen only for navigation and agrees with the snapshot view', async () => {
    const seat = (name: string, org_role: OrgRole = 'user') =>
      plantSeat(t, { org_id: f.org.id, name, org_role })
    const subOnly = await seat('sub only')
    const subLeadGuest = await seat('sub lead guest', 'guest')
    const teamSib = await seat('team sibling')
    const metaTeamGuest = await seat('meta team guest', 'guest')
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subOnly.id,
        level: 'user',
      })
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: subLeadGuest.id,
        level: 'user',
      })
      await ctx.db.patch(f.sub2._id, { lead_id: subLeadGuest.id })
      const sibTeam = uuid()
      await ctx.db.insert('teams', {
        id: sibTeam,
        org_id: f.org.id,
        name: 'Sibling team',
        track_delay_default: false,
        created_at: '2026-01-01T00:00:00.000Z',
      })
      await ctx.db.insert('team_members', {
        team_id: sibTeam,
        profile_id: teamSib.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: sibTeam,
        level: 'user',
      })
      // guests never receive team access, even on the parent itself
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: metaTeamGuest.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await t.run(async (ctx) => {
      const project = async (p: Doc<'projects'>) => (await ctx.db.get(p._id)) as Doc<'projects'>
      const [meta, sub, sub2] = [await project(f.meta), await project(f.sub), await project(f.sub2)]
      for (const p of [f.admin, f.user, f.guest, f.viewer]) {
        expect(await canAccessProject(ctx, p, meta)).toBe(true)
      }
      for (const p of [subOnly, subLeadGuest, teamSib]) {
        expect(await canSeeProject(ctx, p, meta)).toBe(true)
        expect(await canAccessProject(ctx, p, meta)).toBe(false)
      }
      expect(await canAccessProject(ctx, metaTeamGuest, meta)).toBe(false)
      expect(await canAccessProject(ctx, subOnly, sub)).toBe(true)
      expect(await canAccessProject(ctx, subOnly, sub2)).toBe(false)
      expect(await canAccessProject(ctx, teamSib, sub2)).toBe(true)
      // one rule, two forms: per profile and per snapshot view
      const people = [f.admin, f.user, f.guest, f.viewer, f.agent, subOnly, subLeadGuest, teamSib]
      for (const p of people) {
        const view = await orgProjectView(ctx, p)
        for (const proj of [meta, sub, sub2, f.hidden]) {
          expect(await canAccessProject(ctx, p, proj)).toBe(view.accessible(proj.id))
        }
      }
    })
  })
})

describe('isTeamLeader', () => {
  it('true for the leader row, false for a plain member or a stranger', async () => {
    await t.run(async (ctx) => {
      expect(await isTeamLeader(ctx, f.user, f.team.id)).toBe(true)
      expect(await isTeamLeader(ctx, f.admin, f.team.id)).toBe(false)
      expect(await isTeamLeader(ctx, f.guest, f.team.id)).toBe(false)
    })
  })

  it('a missing team id is never led', async () => {
    await t.run(async (ctx) => {
      expect(await isTeamLeader(ctx, f.user, undefined)).toBe(false)
      expect(await isTeamLeader(ctx, f.user, null)).toBe(false)
      expect(await isTeamLeader(ctx, f.user, uuid())).toBe(false)
    })
  })

  it('a viewer is never a team leader, even with a leader row planted', async () => {
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.viewer.id,
        is_leader: true,
      }),
    )
    expect(await t.run((ctx) => isTeamLeader(ctx, f.viewer, f.team.id))).toBe(false)
  })

  it("a leader row on another org's team grants nothing (org fence)", async () => {
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.otherAdmin.id,
        is_leader: true,
      }),
    )
    expect(await t.run((ctx) => isTeamLeader(ctx, f.otherAdmin, f.team.id))).toBe(false)
  })

  it('a Standard user agent is never a team leader, even with a leader row', async () => {
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.agent.id,
        is_leader: true,
      }),
    )
    expect(f.agent.org_role).toBe('user')
    expect(await t.run((ctx) => isTeamLeader(ctx, f.agent, f.team.id))).toBe(false)
  })
})

describe('canLeadTeams', () => {
  it('admits people with a staff role', () => {
    expect(canLeadTeams(f.admin)).toBe(true)
    expect(canLeadTeams(f.user)).toBe(true)
  })

  it('refuses agents, viewers, guests and kinds it does not know', () => {
    expect(canLeadTeams(f.agent)).toBe(false)
    expect(canLeadTeams(f.viewer)).toBe(false)
    expect(canLeadTeams(f.guest)).toBe(false)
    const unknownKind = { ...f.user, kind: 'robot' } as unknown as Doc<'profiles'>
    expect(canLeadTeams(unknownKind)).toBe(false)
  })
})

describe('canWriteOrgLabels', () => {
  it('admin yes; a staff user leading a meta yes', async () => {
    await t.run(async (ctx) => {
      expect(await canWriteOrgLabels(ctx, f.admin)).toBe(true)
      expect(await canWriteOrgLabels(ctx, f.user)).toBe(true) // lead of hidden, a meta
    })
  })

  it('staff with neither lead nor grant: no', async () => {
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBe(false)
  })

  it("non-staff never qualify — a guest's 'user' grant is excluded", async () => {
    await t.run(async (ctx) => {
      expect(await canWriteOrgLabels(ctx, f.guest)).toBe(false)
      expect(await canWriteOrgLabels(ctx, f.viewer)).toBe(false)
    })
  })

  it("a staff 'user' grant qualifies; a 'viewer' grant does not", async () => {
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'viewer',
      }),
    )
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBe(false)
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.agent.id),
        )
        .unique()
      await ctx.db.patch(grant!._id, { level: 'user' })
    })
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBe(true)
  })

  it('answers null, neither yes nor no, once the rows it reads pass LABEL_WRITE_READ', async () => {
    await t.run(async (ctx) => {
      for (const project_id of [f.sub.id, f.sub2.id, f.hidden.id]) {
        await ctx.db.insert('project_access', {
          project_id,
          profile_id: f.agent.id,
          level: 'viewer',
        })
      }
    })
    const before = LABEL_WRITE_READ.rows
    LABEL_WRITE_READ.rows = 2
    try {
      expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBeNull()
      // a proof found first still answers, and non-staff never read
      expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.user))).toBe(true)
      expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.viewer))).toBe(false)
    } finally {
      LABEL_WRITE_READ.rows = before
    }
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBe(false)
  })
})

describe('canManageOrgLabels', () => {
  it('an active org admin yes', () => {
    expect(canManageOrgLabels(f.admin)).toBe(true)
  })

  it('everyone else no, including a label creator and an inactive admin', async () => {
    // `user` leads a meta, so it may add labels but not rename or delete them
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.user))).toBe(true)
    for (const me of [f.user, f.agent, f.guest, f.viewer]) {
      expect(canManageOrgLabels(me)).toBe(false)
    }
    expect(canManageOrgLabels({ ...f.admin, active: false })).toBe(false)
  })
})
