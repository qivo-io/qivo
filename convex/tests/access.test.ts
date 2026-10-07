/* Unit tests for the access family (lib/access.ts) — the phase-1 gate.
 * No public functions exist yet, so every predicate is driven through
 * t.run(ctx => …) over the withOrg mini-Testbed fixture. Each test gets a
 * fresh backend: the tests that plant hostile rows (a viewer leader row, a
 * cross-org leader row, a dangling parent) never leak into each other. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  canSeeProject,
  canWriteOrgLabels,
  cappedLevel,
  hasProjectLevel,
  isOrgStaff,
  isTeamLeader,
  levelRank,
  profileCanSeeProject,
  rootMetaOf,
} from '../lib/access'
import { ACCESS_LEVELS, type AccessLevel, type OrgRole } from '../lib/enums'
import { expectRefusal, newT, type OrgFixture, type T, uuid, withOrg } from './helpers.setup'

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
})
