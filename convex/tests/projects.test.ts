/* projects.ts — create/update/archive/unarchive/deleteDeep/inviteGuest +
 * milestones. Sentences asserted VERBATIM: they are
 * the SQL trigger/RPC prose the client toasts byte-for-byte. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import { PROJECT_DESCRIPTION_MAX } from '../lib/projectLimits'
import { weekLabel } from '../model/orgs'
import {
  activityFor,
  as,
  expectRefusal,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

const createArgs = (f: OrgFixture, extra: Record<string, unknown> = {}) => ({
  org_id: f.org.id,
  id: uuid(),
  type: 'meta' as const,
  key: 'NEW',
  name: 'New project',
  sort_order: 9,
  ...extra,
})

const lastEvent = async (t: T, orgId: string) => {
  const events = await activityFor(t, orgId)
  return events[events.length - 1]
}

describe('projects.create', () => {
  it('admin creates a teamless meta: counter num returned, created narration', async () => {
    const t = newT()
    const f = await withOrg(t)
    const res = await as(t, f.admin).mutation(api.projects.create, createArgs(f))
    expect(res.num).toBe(6) // fixture next_project_num 5 → bump
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', res.id))
        .unique(),
    )
    expect(row?.track_delay).toBe(true) // teamless projects use the neutral default
    expect(row?.description).toBe('')
    expect(row?.archived_at).toBeUndefined()
    expect(row?.icon).toBeUndefined()
    expect(row?.icon_color).toBeUndefined()
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'created',
      target_type: 'project',
      target_id: res.id,
      label: 'New project',
      project_id: res.id,
    })
    expect(e.detail).toBeUndefined()
  })

  it('persists the selected icon and color in the creation mutation', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const [key, icon, icon_color] of [
      ['GLYPH', 'rocket', '#0366D6'],
      ['EMOJI', '🚀', 'rainbow'],
      ['EMPTY', '', ''],
      ['CLEAR', null, null],
    ]) {
      const created = await as(t, f.admin).mutation(
        api.projects.create,
        createArgs(f, { key, icon, icon_color }),
      )
      const row = await t.run((ctx) =>
        ctx.db
          .query('projects')
          .withIndex('by_uuid', (q) => q.eq('id', created.id))
          .unique(),
      )
      expect(row?.icon).toBe(icon ?? undefined)
      expect(row?.icon_color).toBe(icon_color === '' ? undefined : (icon_color ?? undefined))
    }
  })

  it('refuses malformed creation colors without inserting the project, shares or consuming a number', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = createArgs(f, { icon: 'rocket', icon_color: 'red' })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, args),
      'bad_request',
      /^an icon color must be a #rrggbb hex$/,
    )
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query('projects')
          .withIndex('by_uuid', (q) => q.eq('id', args.id))
          .unique(),
      ).toBeNull()
      expect(await ctx.db.query('project_team_access').collect()).toEqual([])
    })
    const created = await as(t, f.admin).mutation(api.projects.create, createArgs(f))
    expect(created.num).toBe(6)
  })

  it('refuses sub-project creation with icon fields, while null fields remain absent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = createArgs(f, {
      type: 'project',
      parent_id: f.meta.id,
    })
    for (const extra of [
      { icon: 'rocket' },
      { icon_color: '#0366d6' },
      { icon: '' },
      { icon_color: '' },
    ]) {
      await expectRefusal(
        as(t, f.admin).mutation(api.projects.create, { ...args, ...extra }),
        'bad_request',
        /^sub-projects carry no icon$/,
      )
    }
    const created = await as(t, f.admin).mutation(api.projects.create, {
      ...args,
      icon: null,
      icon_color: null,
    })
    const row = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', created.id))
        .unique(),
    )
    expect(row?.icon).toBeUndefined()
    expect(row?.icon_color).toBeUndefined()
  })

  it('organization staff may create products; viewer and guest may not', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ok = await as(t, f.user).mutation(api.projects.create, createArgs(f, { key: 'LEAD1' }))
    expect(ok.num).toBe(6)
    await expectRefusal(
      as(t, f.viewer).mutation(api.projects.create, createArgs(f, { key: 'VW1' })),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.create, createArgs(f, { key: 'GU1' })),
      'forbidden',
    )
  })

  it('sub creation: lead standing required; parent fenced with the hierarchy sentences', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subArgs = (parent: string, key: string) =>
      createArgs(f, { type: 'project' as const, parent_id: parent, key })
    const res = await as(t, f.user).mutation(api.projects.create, subArgs(f.meta.id, 'SUB1'))
    expect(res.num).toBe(6)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, subArgs(f.otherProject.id, 'SUB2')),
      'rule',
      new RegExp(`^parent project ${f.otherProject.id} not found$`),
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, subArgs(f.sub.id, 'SUB3')),
      'rule',
      /^sub-projects live directly under a project, never under another sub-project$/,
    )
    const archived = await plantProject(t, {
      org_id: f.org.id,
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, subArgs(archived.id, 'SUB4')),
      'rule',
      /^the project is archived — restore it first$/,
    )
    // lead standing on the parent, not mere visibility: guest holds 'user'
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.create, subArgs(f.meta.id, 'SUB5')),
      'forbidden',
    )
  })

  it('key shape and per-org uniqueness are checked; replayed uuid refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { key: 'toolong' })),
      'bad_request',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { key: 'TBED' })),
      'bad_request',
      /already exists/,
    )
    const args = createArgs(f, { key: 'ONCE' })
    await as(t, f.admin).mutation(api.projects.create, args)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, { ...args, key: 'TWICE' }),
      'bad_request',
      /id already exists/,
    )
  })

  it('lead rules: a viewer or a foreign profile cannot lead', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { lead_id: f.viewer.id })),
      'rule',
      /^a viewer cannot lead a project — make them a standard user first$/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.create, createArgs(f, { lead_id: f.otherAdmin.id })),
      'rule',
      /^the lead must be a member of the project's organization$/,
    )
  })

  it("the access map lands as grant rows; 'lead' entries are dropped", async () => {
    const t = newT()
    const f = await withOrg(t)
    const res = await as(t, f.admin).mutation(
      api.projects.create,
      createArgs(f, { access: { [f.guest.id]: 'viewer', [f.user.id]: 'lead' } }),
    )
    const grants = await t.run(async (ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', res.id))
        .collect(),
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ profile_id: f.guest.id, level: 'viewer' })
  })
})

describe('projects.update', () => {
  it('rename narrates with the old name; a same-value rename is a silent no-op', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Platform 2' },
    })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'renamed',
      label: 'Platform 2',
      detail: 'from “Testbed platform”',
    })
    const before = (await activityFor(t, f.org.id)).length
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Platform 2' },
    })
    expect((await activityFor(t, f.org.id)).length).toBe(before)
  })

  /* icon_color reaches the browser as SVG paint on the project glyph, so the
     write allowlists it. Before this it took any string at all: no length cap,
     no shape, straight into the document. */
  it('icon_color takes a #rrggbb hex or the legacy rainbow, and nothing else', async () => {
    const t = newT()
    const f = await withOrg(t)
    const colorOf = async () =>
      (
        await t.run(async (ctx) =>
          ctx.db
            .query('projects')
            .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
            .unique(),
        )
      )?.icon_color
    for (const ok of ['#0366D6', '#0366d6', 'rainbow']) {
      await as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { icon_color: ok },
      })
      expect(await colorOf()).toBe(ok)
    }
    for (const bad of [
      '" onclick=alert(1) ',
      '"/><animate onbegin="alert(1)"',
      'red',
      '#abc',
      '#GGGGGG',
      'x'.repeat(64),
    ]) {
      await expectRefusal(
        as(t, f.admin).mutation(api.projects.update, {
          org_id: f.org.id,
          id: f.meta.id,
          patch: { icon_color: bad },
        }),
        'bad_request',
        /^an icon color must be a #rrggbb hex$/,
      )
    }
    expect(await colorOf()).toBe('rainbow') // the last good write still stands
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { icon_color: null },
    })
    expect(await colorOf()).toBeUndefined()
  })

  it('lead handovers narrate both sides and a project lead cannot be cleared', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { lead_id: f.admin.id },
    })
    let e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'changed the lead of', detail: 'to admin (was user)' })
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { lead_id: f.user.id },
    })
    e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'changed the lead of', detail: 'to user (was admin)' })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { lead_id: null },
      }),
      'bad_request',
      /^a project must have a lead$/,
    )
  })

  it('access diff upserts and removes in one mutation and outranks the rename event', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: 'Renamed too', access: { [f.guest.id]: 'viewer' } },
    })
    const grants = await t.run(async (ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
        .collect(),
    )
    expect(grants).toHaveLength(1) // viewer's row removed, guest's updated
    expect(grants[0]).toMatchObject({ profile_id: f.guest.id, level: 'viewer' })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'changed access on', label: 'Renamed too' })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
    )
    expect(row?.name).toBe('Renamed too')
  })

  it('grants on a sub-project are scoped there; viewer grantees stay capped', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.sub.id,
      patch: { access: { [f.guest.id]: 'user' } },
    })
    const grant = await t.run((ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub.id).eq('profile_id', f.guest.id),
        )
        .unique(),
    )
    expect(grant?.level).toBe('user')
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.sub.id,
        patch: { access: { [f.viewer.id]: 'user' } },
      }),
      'forbidden',
      /^a viewer can only receive a viewer grant$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.hidden.id,
        patch: { access: { [f.viewer.id]: 'user' } },
      }),
      'forbidden',
    )
  })

  it('who may grant: organization admins and project leads; the grantee must hold a seat in the org', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a 'user' grant on the meta is visibility, not lead standing
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { [f.guest.id]: 'viewer' } },
      }),
      'forbidden',
    )
    // the project lead qualifies — and an access patch ALWAYS narrates, even
    // when the diff is empty (lead handovers ride this branch, as before)
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { access: { [f.guest.id]: 'user', [f.viewer.id]: 'user' } },
    })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'changed access on',
      actor_id: f.user.id,
      target_id: f.meta.id,
    })
    // someone from a third org does not qualify as a grantee
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { [f.otherAdmin.id]: 'user' } },
      }),
      'forbidden',
    )
  })

  it("the access map speaks vGrantLevel (plus the dropped 'lead') only — anything else dies in the validator", async () => {
    const t = newT()
    const f = await withOrg(t)
    // forged wire values a typed client could never send
    const admin = 'admin' as unknown as 'user'
    const member = 'member' as unknown as 'user' // the pre-0098 word is DEAD
    await expect(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { access: { [f.guest.id]: admin } },
      }),
    ).rejects.toThrowError(/Validator error/)
    await expect(
      as(t, f.admin).mutation(
        api.projects.create,
        createArgs(f, { key: 'BADLV', access: { [f.guest.id]: member } }),
      ),
    ).rejects.toThrowError(/Validator error/)
  })

  it('key change is allowed with shape + uniqueness revalidated; non-lead callers are refused', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { key: 'TBED2' },
    })
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
    )
    expect(row?.key).toBe('TBED2')
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { key: 'SKNK' },
      }),
      'bad_request',
      /already exists/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.meta.id,
        patch: { name: 'X' },
      }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.otherProject.id,
        patch: { name: 'X' },
      }),
      'not_found',
      /^project not found$/,
    )
  })
})

describe('project review time', () => {
  const REVIEW_HOURS_SENTENCE = /^review_hours must be a number of hours from 0 to 999, or null$/
  const setReviewHours = (
    t: T,
    f: OrgFixture,
    id: string,
    review_hours: number | null,
    caller = f.user,
  ) =>
    as(t, caller).mutation(api.projects.update, { org_id: f.org.id, id, patch: { review_hours } })
  const stored = async (t: T, id: string) =>
    await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
    )

  it('the lead sets it on a project or sub-project at the 0.1 h grain; null clears it; no narration', async () => {
    const t = newT()
    const f = await withOrg(t)
    await setReviewHours(t, f, f.meta.id, 2.25)
    expect((await stored(t, f.meta.id))?.review_hours).toBe(2.3)
    await setReviewHours(t, f, f.sub.id, 0)
    expect((await stored(t, f.sub.id))?.review_hours).toBe(0)
    await setReviewHours(t, f, f.meta.id, 999)
    expect((await stored(t, f.meta.id))?.review_hours).toBe(999)
    await setReviewHours(t, f, f.meta.id, null)
    expect('review_hours' in ((await stored(t, f.meta.id)) ?? {})).toBe(false)
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('refuses out-of-range values and non-leads; a new project inherits (absent)', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const bad of [-1, 1000]) {
      await expectRefusal(setReviewHours(t, f, f.sub.id, bad), 'bad_request', REVIEW_HOURS_SENTENCE)
    }
    await expectRefusal(setReviewHours(t, f, f.meta.id, 3, f.guest), 'forbidden')
    expect((await stored(t, f.sub.id))?.review_hours).toBeUndefined()
    expect((await stored(t, f.meta.id))?.review_hours).toBeUndefined()
    const created = await as(t, f.admin).mutation(api.projects.create, createArgs(f))
    expect('review_hours' in ((await stored(t, created.id)) ?? {})).toBe(false)
  })
})

describe('project description limits', () => {
  const snapshot = (t: T) =>
    t.run(async (ctx) => ({
      projects: await ctx.db.query('projects').collect(),
      organizations: await ctx.db.query('organizations').collect(),
      access: await ctx.db.query('project_access').collect(),
      teamAccess: await ctx.db.query('project_team_access').collect(),
      activity: await ctx.db.query('activity_events').collect(),
    }))

  it.each(['meta', 'project'] as const)(
    'creates %s descriptions through the 500-unit boundary without trimming, including null and omission',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      expect(PROJECT_DESCRIPTION_MAX).toBe(500)
      const boundary = ` \n${'x'.repeat(496)}\n `
      const unicodeBoundary = '😀'.repeat(250)
      for (const [index, description] of [
        undefined,
        null,
        '',
        boundary,
        unicodeBoundary,
      ].entries()) {
        const created = await as(t, f.admin).mutation(
          api.projects.create,
          createArgs(f, {
            type,
            key: `DESC${index}`,
            ...(type === 'project' ? { parent_id: f.meta.id } : {}),
            ...(description === undefined ? {} : { description }),
          }),
        )
        const row = await t.run((ctx) =>
          ctx.db
            .query('projects')
            .withIndex('by_uuid', (q) => q.eq('id', created.id))
            .unique(),
        )
        expect(row?.description).toBe(description ?? '')
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'refuses oversized %s creation without consuming a number or creating rows',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const before = await snapshot(t)
      for (const description of ['x'.repeat(501), `${'😀'.repeat(250)}x`]) {
        await expectRefusal(
          as(t, f.admin).mutation(
            api.projects.create,
            createArgs(f, {
              type,
              ...(type === 'project' ? { parent_id: f.meta.id } : {}),
              description,
              access: { [f.guest.id]: 'viewer' },
              team_access: { [f.team.id]: 'user' },
            }),
          ),
          'bad_request',
          /^a project description must be 500 characters or fewer$/,
        )
        expect(await snapshot(t)).toEqual(before)
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'updates %s descriptions at the boundary and preserves empty-string semantics',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const project = type === 'meta' ? f.meta : f.sub
      for (const description of [` \n${'x'.repeat(496)}\n `, '😀'.repeat(250), '', null]) {
        await as(t, f.admin).mutation(api.projects.update, {
          org_id: f.org.id,
          id: project.id,
          patch: { description },
        })
        expect((await t.run((ctx) => ctx.db.get(project._id)))?.description).toBe(description ?? '')
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'refuses an oversized %s description atomically with other settings and grants',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const project = type === 'meta' ? f.meta : f.sub
      const before = await snapshot(t)
      for (const description of ['x'.repeat(501), `${'😀'.repeat(250)}x`]) {
        await expectRefusal(
          as(t, f.admin).mutation(api.projects.update, {
            org_id: f.org.id,
            id: project.id,
            patch: {
              name: 'Renamed',
              key: 'EDIT',
              lead_id: f.user.id,
              track_delay: true,
              review_hours: 4,
              ...(type === 'meta'
                ? {
                    access: { [f.guest.id]: 'viewer' as const },
                    team_access: { [f.team.id]: 'viewer' as const },
                  }
                : {}),
              description,
            },
          }),
          'bad_request',
          /^a project description must be 500 characters or fewer$/,
        )
        expect(await snapshot(t)).toEqual(before)
        expect((await t.run((ctx) => ctx.db.get(project._id)))?.review_hours).toBeUndefined()
      }
    },
  )

  it.each(['meta', 'project'] as const)(
    'leaves an existing oversized %s description untouched when omitted and accepts null to clear it',
    async (type) => {
      const t = newT()
      const f = await withOrg(t)
      const project = type === 'meta' ? f.meta : f.sub
      const existing = 'legacy text '.repeat(50)
      await t.run((ctx) => ctx.db.patch(project._id, { description: existing }))
      await as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: project.id,
        patch: { name: 'Renamed' },
      })
      expect((await t.run((ctx) => ctx.db.get(project._id)))?.description).toBe(existing)
      await as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: project.id,
        patch: { description: null },
      })
      expect((await t.run((ctx) => ctx.db.get(project._id)))?.description).toBe('')
    },
  )

  it('keeps permission and organization fences ahead of description validation', async () => {
    const t = newT()
    const f = await withOrg(t)
    const patch = { description: 'x'.repeat(501) }
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.update, { org_id: f.org.id, id: f.meta.id, patch }),
      'forbidden',
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.otherProject.id,
        patch,
      }),
      'not_found',
      /^project not found$/,
    )
  })
})

describe('projects.archive / unarchive', () => {
  it('archiving a meta stamps active subs with the SAME instant and counts them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    const rows = await t.run(async (ctx) => ({
      meta: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
      sub: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.id))
        .unique(),
      sub2: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique(),
    }))
    expect(rows.meta?.archived_at).toBeDefined()
    expect(rows.sub?.archived_at).toBe(rows.meta?.archived_at)
    expect(rows.sub2?.archived_at).toBe(rows.meta?.archived_at)
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'archived', detail: 'with 2 sub-projects' })
    // already archived ⇒ silent no-op
    const before = (await activityFor(t, f.org.id)).length
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    expect((await activityFor(t, f.org.id)).length).toBe(before)
  })

  it('restoring a meta brings back exactly the subs its own archiving carried down', async () => {
    const t = newT()
    const f = await withOrg(t)
    // sub2 archived on its own instant first — it must NOT ride the restore.
    // tick() forces the meta's archive onto a strictly later millisecond: the
    // restore matches subs by archived_at EQUALITY (0106), so a same-ms
    // coincidence would wrongly carry sub2 back (it flaked under suite load)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.sub2.id })
    await tick()
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'archived', detail: 'with 1 sub-project' })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.meta.id })
    const rows = await t.run(async (ctx) => ({
      meta: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
      sub: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.id))
        .unique(),
      sub2: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique(),
    }))
    expect(rows.meta?.archived_at).toBeUndefined()
    expect(rows.sub?.archived_at).toBeUndefined()
    expect(rows.sub2?.archived_at).toBeDefined()
    expect(await lastEvent(t, f.org.id)).toMatchObject({
      verb: 'restored',
      detail: 'from the archive',
    })
  })

  it('restoring a sub surfaces its parent and nothing else', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub.id })
    const rows = await t.run(async (ctx) => ({
      meta: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.meta.id))
        .unique(),
      sub: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub.id))
        .unique(),
      sub2: await ctx.db
        .query('projects')
        .withIndex('by_uuid', (q) => q.eq('id', f.sub2.id))
        .unique(),
    }))
    expect(rows.sub?.archived_at).toBeUndefined()
    expect(rows.meta?.archived_at).toBeUndefined()
    expect(rows.sub2?.archived_at).toBeDefined() // the sibling stays put
  })
})

describe('projects.deleteDeep', () => {
  it('guards: uniform not-found for foreign rows, the RPC sentence for missing rights', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.otherProject.id }),
      'not_found',
      /^project not found$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id }),
      'rule',
      /^requires the project lead$/,
    )
  })

  it("a project's delete event has no owning-team branch", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.sub.id })
    let e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'deleted', label: 'Firmware', project_id: f.meta.id })
    expect(e.team_id).toBeUndefined()
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: f.meta.id })
    e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'deleted', label: 'Testbed platform' })
    expect(e.team_id).toBeUndefined()
    expect(e.project_id).toBeUndefined()
    const left = await t.run(async (ctx) => ({
      projects: await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
      issues: await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    }))
    // sub2 died with the meta's subtree — only the unrelated meta survives
    expect(left.projects.map((p) => p.id)).toEqual([f.hidden.id])
    expect(left.issues).toHaveLength(0)
  })
})

describe('projects.inviteGuest', () => {
  const invite = (t: T, f: OrgFixture, extra: Record<string, unknown> = {}) =>
    as(t, f.admin).mutation(api.projects.inviteGuest, {
      org_id: f.org.id,
      project_id: f.meta.id,
      email: 'Anna.K@Example.se',
      level: 'user',
      ...extra,
    })

  it('an unknown address gets a guest seat and a grant on the selected sub-project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pid = await invite(t, f, { project_id: f.sub.id })
    const p = await t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', pid))
        .unique(),
    )
    expect(p).toMatchObject({
      org_id: f.org.id,
      email: 'anna.k@example.se',
      name: 'anna.k',
      initials: 'AN', // upper(left(local part, 2)) — NOT nameInitials
      color: '#8A8F98',
      org_role: 'guest',
      active: true,
      kind: 'person',
      plannable_hours: 40, // the HOST org default
      message_retention_days: 7, // no sibling seat ⇒ the old column default
    })
    expect(p?.accepted_at).toBeUndefined()
    expect(p?.auth_user_id).toBeUndefined()
    const grant = await t.run(async (ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) => q.eq('project_id', f.sub.id).eq('profile_id', pid))
        .unique(),
    )
    expect(grant?.level).toBe('user')
    // inviting twice UPDATES the level, mints no second seat
    const again = await invite(t, f, { project_id: f.sub.id, level: 'viewer' })
    expect(again).toBe(pid)
    const after = await t.run(async (ctx) => ({
      seats: await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', 'anna.k@example.se'))
        .collect(),
      grant: await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) => q.eq('project_id', f.sub.id).eq('profile_id', pid))
        .unique(),
    }))
    expect(after.seats).toHaveLength(1)
    expect(after.grant?.level).toBe('viewer')
  })

  it('a known address in the org gets the grant only; retention follows a sibling seat', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pid = await invite(t, f, { email: f.guest.email })
    expect(pid).toBe(f.guest.id)
    // a sibling seat elsewhere carries retention 30 — the new guest copies it
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.otherOrg.id,
        email: 'bo@example.se',
        name: 'bo',
        initials: 'BO',
        color: '#8A8F98',
        org_role: 'user',
        active: true,
        kind: 'person',
        message_retention_days: 30,
        created_at: '2025-01-01T00:00:00.000Z',
      })
    })
    const bo = await invite(t, f, { email: 'bo@example.se' })
    const seat = await t.run(async (ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', bo))
        .unique(),
    )
    expect(seat?.message_retention_days).toBe(30)
  })

  it('refusal sentences, verbatim — including the 0098-missed level sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(
      invite(t, f, { level: 'lead' }),
      'rule',
      /^a project role is lead, member or viewer$/,
    )
    await expectRefusal(
      invite(t, f, { email: 'not-an-address' }),
      'rule',
      /^that does not look like an email address$/,
    )
    await expectRefusal(
      as(t, f.guest).mutation(api.projects.inviteGuest, {
        org_id: f.org.id,
        project_id: f.meta.id,
        email: 'x@y.se',
        level: 'user',
      }),
      'rule',
      /^no permission to manage users on this project$/,
    )
    await expectRefusal(
      invite(t, f, { project_id: f.otherProject.id }),
      'not_found',
      /^project not found$/,
    )
  })
})

describe('milestones', () => {
  it('add narrates at the org-grid week label; the arrival guard keeps its own sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'added milestone',
      target_type: 'milestone',
      target_id: id,
      label: 'Beta',
      detail: `at ${weekLabel('2026-05-11', f.org)}`,
      project_id: f.meta.id,
    })
    const archived = await plantProject(t, {
      org_id: f.org.id,
      archived_at: '2026-01-02T00:00:00.000Z',
    })
    await expectRefusal(
      as(t, f.admin).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id: uuid(),
        project_id: archived.id,
        name: 'Nope',
        week: '2026-05-11',
      }),
      'rule',
      /^that project is archived — restore it first$/,
    )
    // a viewer's capped grant never reaches 'user'
    await expectRefusal(
      as(t, f.viewer).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id: uuid(),
        project_id: f.meta.id,
        name: 'Nor this',
        week: '2026-05-11',
      }),
      'forbidden',
    )
  })

  it('update verbs name what actually changed — a pure rename must not read as a move', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    // the dialog always submits both fields
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Beta 2', week: '2026-05-18' },
    })
    let e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({
      verb: 'moved milestone',
      label: 'Beta 2',
      detail: `from ${weekLabel('2026-05-11', f.org)} to ${weekLabel('2026-05-18', f.org)} (renamed from “Beta”)`,
    })
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Beta 3', week: '2026-05-18' },
    })
    e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'renamed milestone', label: 'Beta 3', detail: 'from “Beta 2”' })
    await as(t, f.user).mutation(api.projects.updateMilestone, {
      org_id: f.org.id,
      id,
      patch: { name: 'Beta 3', week: '2026-05-18' },
    })
    e = await lastEvent(t, f.org.id)
    expect(e.verb).toBe('updated milestone')
    expect(e.detail).toBeUndefined()
  })

  it('remove deletes the row and narrates; foreign milestones read not-found', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.projects.addMilestone, {
      org_id: f.org.id,
      id,
      project_id: f.meta.id,
      name: 'Beta',
      week: '2026-05-11',
    })
    await as(t, f.user).mutation(api.projects.removeMilestone, { org_id: f.org.id, id })
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('milestones')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique(),
      ),
    ).toBeNull()
    const e = await lastEvent(t, f.org.id)
    expect(e).toMatchObject({ verb: 'deleted milestone', label: 'Beta', project_id: f.meta.id })
    expect(e.detail).toBeUndefined()
    await expectRefusal(
      as(t, f.user).mutation(api.projects.removeMilestone, { org_id: f.org.id, id: uuid() }),
      'not_found',
      /^milestone not found$/,
    )
  })
})
