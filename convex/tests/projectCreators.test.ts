/* Tests for lib/projectCreators.ts, the rule projects.create and the planner
 * share for who may create a top-level project, the sentence a refusal
 * carries, and the value a profile update stores for the per-user right.
 * These are pure functions over profile-shaped objects, so no backend is
 * needed. The schema refuses an unknown stored setting, so
 * unknown values (a later release's, or a forged one) are cast here to prove
 * the rule fails closed. */
import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { type OrgRole, PROJECT_CREATORS, type ProjectCreators } from '../lib/enums'
import {
  canCreateProjects,
  isProjectCreators,
  projectCreationRefusal,
  projectRightAfterUpdate,
} from '../lib/projectCreators'

type Setting = Doc<'organizations'>['project_creators']
type Creator = Pick<Doc<'profiles'>, 'org_role' | 'kind' | 'can_create_projects'>
type Kind = Creator['kind']

const UNKNOWN = 'everyone' as unknown as Setting
const SETTINGS: Setting[] = [undefined, ...PROJECT_CREATORS, UNKNOWN]

const seat = (kind: Kind, org_role: OrgRole, can_create_projects?: boolean): Creator => ({
  org_role,
  kind,
  can_create_projects,
})
const person = (org_role: OrgRole, can_create_projects?: boolean) =>
  seat('person', org_role, can_create_projects)
const agent = (org_role: OrgRole, can_create_projects?: boolean) =>
  seat('agent', org_role, can_create_projects)

describe('canCreateProjects', () => {
  it('an org admin may create under every setting, unknown ones included', () => {
    for (const setting of SETTINGS) {
      expect(canCreateProjects(person('admin'), setting)).toBe(true)
    }
  })

  it('a standard user, person or agent, follows the setting; missing reads as users', () => {
    for (const kind of ['person', 'agent'] as const) {
      const plain = seat(kind, 'user')
      const flagged = seat(kind, 'user', true)
      expect(canCreateProjects(plain, undefined), kind).toBe(true)
      expect(canCreateProjects(plain, 'users'), kind).toBe(true)
      expect(canCreateProjects(flagged, 'users'), kind).toBe(true)
      expect(canCreateProjects(plain, 'selected'), kind).toBe(false)
      expect(canCreateProjects(seat(kind, 'user', false), 'selected'), kind).toBe(false)
      expect(canCreateProjects(flagged, 'selected'), kind).toBe(true)
      expect(canCreateProjects(plain, 'admins'), kind).toBe(false)
      expect(canCreateProjects(flagged, 'admins'), kind).toBe(false)
    }
  })

  it('an unknown setting lets nobody but admins create', () => {
    for (const creator of [person('user'), person('user', true), agent('user', true)]) {
      expect(canCreateProjects(creator, UNKNOWN)).toBe(false)
    }
  })

  it('viewers, Viewer agents, guests and unknown roles never qualify, even with the right on', () => {
    const never = [
      person('viewer', true),
      agent('viewer', true),
      person('guest', true),
      person('superuser' as OrgRole, true),
      agent('superuser' as OrgRole, true),
    ]
    for (const setting of SETTINGS) {
      for (const creator of never) {
        expect(canCreateProjects(creator, setting), `${creator.kind} ${creator.org_role}`).toBe(
          false,
        )
      }
    }
  })
})

describe('projectCreationRefusal', () => {
  it('names who can create projects under each setting', () => {
    const sentences: Record<ProjectCreators, string> = {
      admins: 'only org admins can create projects',
      users: 'only org admins and standard users can create projects',
      selected: 'only org admins and selected standard users can create projects',
    }
    for (const setting of PROJECT_CREATORS) {
      expect(projectCreationRefusal(setting)).toBe(sentences[setting])
    }
    expect(projectCreationRefusal(undefined)).toBe(sentences.users)
  })

  it('reads an unknown setting as admins only', () => {
    expect(projectCreationRefusal(UNKNOWN)).toBe('only org admins can create projects')
  })
})

describe('isProjectCreators', () => {
  it('accepts exactly the stored settings', () => {
    for (const setting of PROJECT_CREATORS) expect(isProjectCreators(setting)).toBe(true)
    for (const value of ['everyone', 'Users', '', 'toString', 'constructor', undefined, null, 1]) {
      expect(isProjectCreators(value)).toBe(false)
    }
  })
})

describe('projectRightAfterUpdate', () => {
  it('turns the right on and off for a standard user, person or agent', () => {
    for (const kind of ['person', 'agent'] as const) {
      expect(projectRightAfterUpdate(seat(kind, 'user'), { can_create_projects: true })).toBe(true)
      expect(
        projectRightAfterUpdate(seat(kind, 'user', true), { can_create_projects: false }),
      ).toBeUndefined()
    }
    // a stored false is off too, and the next write stores it as absent
    expect(
      projectRightAfterUpdate(person('user', false), { can_create_projects: false }),
    ).toBeUndefined()
  })

  it('keeps the stored value when the update neither changes the role nor names the right', () => {
    for (const stored of [true, false, undefined]) {
      const row = person('user', stored)
      expect(projectRightAfterUpdate(row, {})).toBe(stored)
      // the role select sends the unchanged role
      expect(projectRightAfterUpdate(row, { org_role: 'user' })).toBe(stored)
    }
  })

  it('a role change clears the right unless the same update turns it on for a standard user', () => {
    for (const org_role of ['admin', 'viewer', 'guest'] as const) {
      expect(projectRightAfterUpdate(person('user', true), { org_role })).toBeUndefined()
      expect(
        projectRightAfterUpdate(person('user', true), { org_role, can_create_projects: true }),
      ).toBeUndefined()
    }
    const staleViewer = person('viewer', true)
    expect(projectRightAfterUpdate(staleViewer, { org_role: 'user' })).toBeUndefined()
    expect(
      projectRightAfterUpdate(staleViewer, { org_role: 'user', can_create_projects: true }),
    ).toBe(true)
  })

  it('never stores the right on a Viewer agent or another non-standard role', () => {
    expect(projectRightAfterUpdate(agent('viewer'), { can_create_projects: true })).toBeUndefined()
    // making a Standard user agent a Viewer clears its right
    expect(projectRightAfterUpdate(agent('user', true), { org_role: 'viewer' })).toBeUndefined()
    for (const org_role of ['admin', 'viewer', 'guest'] as const) {
      expect(
        projectRightAfterUpdate(person(org_role), { can_create_projects: true }),
      ).toBeUndefined()
    }
  })
})
