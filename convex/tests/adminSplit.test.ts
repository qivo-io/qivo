/* The admin access split's parity: an organization admin's levels are a
 * standard user's with the same rows, in every reader of the level rule
 * (lib/access.ts) and in Deleted items' role gate. Admin status adds no
 * level anywhere, and only the management predicates know the role
 * (tests/projectParity.test.ts holds those).
 *
 * Each shape is one organization with an admin and their twin, a standard
 * user who holds the same rows: no rows at all, a User grant on a
 * top-level project, a Viewer grant on a sub-project, a team share on a
 * top-level project of a team both belong to, the lead of a sub-project, a
 * sub-project grant that shows its parent only for navigation, and a grant
 * on a project outside any meta tree. A sub-project has one lead, so in that
 * shape each seat leads a sub-project of its own, and each is compared on
 * the other's too. Every reader is asked about every project of the
 * organization for both seats. The three cases below each read the readers
 * one of the level rule's former admin branches reached (levelUnder,
 * projectLevelsOf's sees and levelsFrom), so restoring any one branch
 * fails its case. Everyday sizes. */

import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  accessOf,
  canAccessProject,
  canBeAssignedFor,
  canSeeProject,
  canSeeProjectFor,
  hasProjectLevel,
  projectLevel,
  projectLevelsForOrg,
  projectLevelsForProfiles,
  projectSightForProfiles,
} from '../lib/access'
import type { AccessLevel, GrantLevel } from '../lib/enums'
import { newT, plantProject, plantSeat, type T, uuid } from './helpers.setup'

type Seat = 'admin' | 'twin'

/* One shape's organization: both seats, and the projects each seat is
 * asked about under a label, `admin` the copy the admin is asked about and
 * `twin` the twin's. They are the same project except where each seat
 * holds rows of its own. */
type World = {
  seats: Record<Seat, Doc<'profiles'>>
  projects: { label: string; admin: Doc<'projects'>; twin: Doc<'projects'> }[]
}

const SHAPES = [
  'none',
  'user grant on a top-level project',
  'viewer grant on a sub-project',
  'team share on a top-level project',
  'lead of a sub-project',
  'navigation only',
  'outside a meta tree',
] as const
type Shape = (typeof SHAPES)[number]

const grantOf = (t: T, project: Doc<'projects'>, profile: Doc<'profiles'>, level: GrantLevel) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: project.id, profile_id: profile.id, level }),
  )

/* An organization of `shape`: a top-level project Top led by Owen with the
 * sub-projects Left and Right, a second top-level project Other with one
 * sub-project Beyond that nobody gives either seat, a top-level project
 * outside a meta tree (Loose, which is not a meta) and the rows of
 * `shape`, given to both seats alike. */
async function worldOf(t: T, shape: Shape): Promise<World> {
  const orgId = uuid()
  await t.run((ctx) =>
    ctx.db.insert('organizations', {
      id: orgId,
      name: `Split ${shape}`,
      slug: `split-${orgId.slice(0, 8)}`,
      created_at: '2026-01-01T00:00:00.000Z',
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
    }),
  )
  const owen = await plantSeat(t, { org_id: orgId, name: 'Owen' })
  const admin = await plantSeat(t, { org_id: orgId, name: 'Ada', org_role: 'admin' })
  const twin = await plantSeat(t, { org_id: orgId, name: 'Tom', org_role: 'user' })
  const top = await plantProject(t, { org_id: orgId, name: 'Top', lead_id: owen.id })
  const left = await plantProject(t, {
    org_id: orgId,
    name: 'Left',
    type: 'project',
    parent_id: top.id,
  })
  const right = await plantProject(t, {
    org_id: orgId,
    name: 'Right',
    type: 'project',
    parent_id: top.id,
  })
  const other = await plantProject(t, { org_id: orgId, name: 'Other', lead_id: owen.id })
  const beyond = await plantProject(t, {
    org_id: orgId,
    name: 'Beyond',
    type: 'project',
    parent_id: other.id,
  })
  const loose = await plantProject(t, { org_id: orgId, name: 'Loose', type: 'project' })
  const same = (label: string, p: Doc<'projects'>) => ({ label, admin: p, twin: p })
  const projects = [
    same('Top', top),
    same('Left', left),
    same('Right', right),
    same('Other', other),
    same('Beyond', beyond),
    same('Loose', loose),
  ]
  for (const seat of [admin, twin]) {
    if (shape === 'user grant on a top-level project') await grantOf(t, top, seat, 'user')
    if (shape === 'viewer grant on a sub-project') await grantOf(t, left, seat, 'viewer')
    if (shape === 'navigation only') await grantOf(t, right, seat, 'user')
    if (shape === 'outside a meta tree') await grantOf(t, loose, seat, 'user')
  }
  if (shape === 'team share on a top-level project') {
    const teamId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('teams', {
        id: teamId,
        org_id: orgId,
        name: 'Crew',
        track_delay_default: false,
        created_at: '2026-01-01T00:00:00.000Z',
      })
      for (const seat of [admin, twin])
        await ctx.db.insert('team_members', {
          team_id: teamId,
          profile_id: seat.id,
          is_leader: false,
        })
      await ctx.db.insert('project_team_access', {
        project_id: top.id,
        team_id: teamId,
        level: 'user',
      })
    })
  }
  if (shape === 'lead of a sub-project') {
    const lead = async (seat: Doc<'profiles'>, name: string) =>
      await plantProject(t, {
        org_id: orgId,
        name,
        type: 'project',
        parent_id: top.id,
        lead_id: seat.id,
      })
    const mine = await lead(admin, 'Led by Ada')
    const theirs = await lead(twin, 'Led by Tom')
    // each seat on the sub-project it leads, and on the one the other leads
    projects.push(
      { label: 'own led', admin: mine, twin: theirs },
      { label: "other's led", admin: theirs, twin: mine },
    )
  }
  return { seats: { admin, twin }, projects }
}

/* `p` with its parent, when it has one, as a read that already read both
 * passes them to accessOf. */
const withParent = async (ctx: QueryCtx, p: Doc<'projects'>): Promise<Doc<'projects'>[]> => {
  const parentId = p.parent_id
  if (parentId === undefined) return [p]
  const parent = await ctx.db
    .query('projects')
    .withIndex('by_uuid', (q) => q.eq('id', parentId))
    .unique()
  return parent === null ? [p] : [p, parent]
}

/* Every answer one group of readers gives `me` about `p`. */
type Answers = Record<string, AccessLevel | boolean | null>

/* What levelUnder decides: the per-project predicates and accessOf's
 * level, and a top-level project's visible and accessible, which ask it. */
async function levelUnderReaders(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<Answers> {
  const read = await withParent(ctx, p)
  const out: Answers = {
    projectLevel: await projectLevel(ctx, me, p),
    'projectLevel without navigation': await projectLevel(ctx, me, p, false),
    canSeeProject: await canSeeProject(ctx, me, p),
    canAccessProject: await canAccessProject(ctx, me, p),
    'hasProjectLevel user': await hasProjectLevel(ctx, me, p.id, 'user'),
    'hasProjectLevel lead': await hasProjectLevel(ctx, me, p.id, 'lead'),
    'accessOf level, read': await accessOf(ctx, me, read).level(p.id),
    'accessOf level': await accessOf(ctx, me).level(p.id),
  }
  if (p.parent_id === undefined) {
    out['accessOf visible, read'] = await accessOf(ctx, me, read).visible(p.id)
    out['accessOf accessible, read'] = await accessOf(ctx, me, read).accessible(p.id)
  }
  return out
}

/* What projectLevelsOf's sees decides: accessOf's visible and accessible
 * of a sub-project, with its projects already read and without. */
async function seesReaders(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<Answers> {
  if (p.parent_id === undefined) return {}
  const read = await withParent(ctx, p)
  return {
    'visible, read': await accessOf(ctx, me, read).visible(p.id),
    'accessible, read': await accessOf(ctx, me, read).accessible(p.id),
    visible: await accessOf(ctx, me).visible(p.id),
    accessible: await accessOf(ctx, me).accessible(p.id),
  }
}

/* What levelsFrom decides: the organization's levels, every profile's
 * levels and sight from a project's side, and Deleted items' role gate. */
async function levelsFromReaders(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  p: Doc<'projects'>,
): Promise<Answers> {
  const org = await projectLevelsForOrg(ctx, me)
  return {
    'projectLevelsForOrg levelOf': org.levelOf(p),
    'projectLevelsForOrg navigationOnly': org.navigationOnly(p.id),
    projectLevelsForProfiles: (await projectLevelsForProfiles(ctx, p))(me),
    canBeAssignedFor: (await canBeAssignedFor(ctx, p))(me),
    canSeeProjectFor: (await canSeeProjectFor(ctx, p))(me),
    projectSightForProfiles: await (await projectSightForProfiles(ctx, p))(me),
  }
}

type Readers = (ctx: QueryCtx, me: Doc<'profiles'>, p: Doc<'projects'>) => Promise<Answers>

/* Each shape's answers of `readers` for both seats, by project label. */
async function answersOf(readers: Readers) {
  const t = newT()
  const out: { shape: Shape; label: string; admin: Answers; twin: Answers }[] = []
  for (const shape of SHAPES) {
    const world = await worldOf(t, shape)
    for (const { label, admin, twin } of world.projects) {
      out.push({
        shape,
        label,
        admin: await t.run((ctx) => readers(ctx, world.seats.admin, admin)),
        twin: await t.run((ctx) => readers(ctx, world.seats.twin, twin)),
      })
    }
  }
  return out
}

/* Every answer of the shape without rows is no level. */
const nothing = (answers: Answers) => Object.values(answers).every((a) => a === null || a === false)

describe('the level rule judges an organization admin by their own rows', () => {
  for (const [branch, readers] of [
    ['levelUnder (projectLevel, the per-project predicates, accessOf level)', levelUnderReaders],
    ["projectLevelsOf's sees (accessOf visible and accessible of a sub-project)", seesReaders],
    [
      'levelsFrom (projectLevelsForOrg, projectLevelsForProfiles, canBeAssignedFor, canSeeProjectFor, projectSightForProfiles)',
      levelsFromReaders,
    ],
  ] as const) {
    it(`gives the admin the twin's answers in every shape: ${branch}`, async () => {
      const answers = await answersOf(readers)
      for (const a of answers) expect({ ...a, admin: a.admin }).toEqual({ ...a, admin: a.twin })
      for (const a of answers.filter((x) => x.shape === 'none')) {
        expect(nothing(a.admin), `${a.label}: ${JSON.stringify(a.admin)}`).toBe(true)
      }
      // the rows give a level somewhere, so equal answers are not all empty
      expect(answers.some((a) => !nothing(a.twin))).toBe(true)
    })
  }

  it('answers the shapes as the ordinary rule does', async () => {
    const answers = await answersOf(async (ctx, me, p) => ({
      level: await projectLevel(ctx, me, p),
    }))
    const level = (shape: Shape, label: string) =>
      answers.find((a) => a.shape === shape && a.label === label)?.admin.level
    expect(level('user grant on a top-level project', 'Top')).toBe('user')
    expect(level('user grant on a top-level project', 'Left')).toBe('user')
    expect(level('viewer grant on a sub-project', 'Left')).toBe('viewer')
    expect(level('viewer grant on a sub-project', 'Right')).toBeNull()
    expect(level('team share on a top-level project', 'Right')).toBe('user')
    expect(level('lead of a sub-project', 'own led')).toBe('lead')
    expect(level('lead of a sub-project', "other's led")).toBeNull()
    expect(level('navigation only', 'Top')).toBe('viewer')
    expect(level('outside a meta tree', 'Loose')).toBeNull()
    expect(level('none', 'Other')).toBeNull()
  })
})
