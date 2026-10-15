import { describe, expect, it } from 'vitest'
import type { Row } from '../store/rows'
import { shapeUser } from '../store/viewModels'
import { creatorName, namePhrase, projectCreatorsIn, projectRightBox } from './projectCreators'

/* A home-org member as the roster holds it; a standard user who is an active
   person unless `extra` says otherwise. An agent has no login or email. */
const member = (name: string, extra: Partial<Row<'profiles'>> = {}) =>
  shapeUser(
    {
      id: name.toLowerCase(),
      org_id: 'org',
      name,
      initials: name.slice(0, 2).toUpperCase(),
      color: '#335577',
      org_role: 'user',
      active: true,
      kind: 'person',
      auth_user_id: `account-${name}`,
      created_at: '2026-09-14T08:00:00.000Z',
      ...extra,
    },
    [],
    [],
    null,
    false,
  )

/* The extra fields of an agent row: no login, no email. */
const agent = (extra: Partial<Row<'profiles'>> = {}): Partial<Row<'profiles'>> => ({
  kind: 'agent',
  auth_user_id: undefined,
  email: undefined,
  ...extra,
})

const names = (users: { name: string }[]) => users.map((user) => user.name)
const roster3 = [member('Leo'), member('Nora', { org_role: 'admin' }), member('Atlas', agent())]
const phrase = (list: string[]) =>
  namePhrase(list)
    .map((part) => part.text)
    .join('')

describe('projectCreatorsIn', () => {
  const roster = [
    member('Leo'),
    member('Nora', { org_role: 'admin' }),
    member('Aisha', { can_create_projects: true }),
    member('Mira', { auth_user_id: undefined, can_create_projects: true }),
    member('Emil', { active: false, can_create_projects: true }),
    member('Ingrid', { org_role: 'viewer', can_create_projects: true }),
    member('Atlas', agent({ can_create_projects: true })),
    member('Relay', agent()),
    member('Ledger', agent({ org_role: 'viewer', can_create_projects: true })),
    member('Gus', { org_role: 'guest' }),
    member('Ola', { org_role: 'admin' }),
  ]

  it('names org admins first, then every active standard user, people and agents alike', () => {
    expect(names(projectCreatorsIn(roster, 'users'))).toEqual([
      'Nora',
      'Ola',
      'Leo',
      'Aisha',
      'Mira',
      'Atlas',
      'Relay',
    ])
  })

  it('names only the selected standard users beside the admins, pending invitations included', () => {
    expect(names(projectCreatorsIn(roster, 'selected'))).toEqual([
      'Nora',
      'Ola',
      'Aisha',
      'Mira',
      'Atlas',
    ])
  })

  it('names only org admins under admins', () => {
    expect(names(projectCreatorsIn(roster, 'admins'))).toEqual(['Nora', 'Ola'])
  })

  it('never names inactive members, viewers, Viewer agents or guests', () => {
    for (const setting of ['users', 'selected'] as const) {
      const left = names(projectCreatorsIn(roster, setting))
      for (const name of ['Emil', 'Ingrid', 'Ledger', 'Gus']) expect(left).not.toContain(name)
    }
  })
})

describe('creatorName', () => {
  it('marks agents and leaves people as they are', () => {
    expect(creatorName(member('Atlas', agent()))).toBe('Atlas (agent)')
    expect(creatorName(member('Leo'))).toBe('Leo')
    expect(phrase(projectCreatorsIn(roster3, 'users').map(creatorName))).toBe(
      'Nora, Leo and Atlas (agent)',
    )
  })
})

describe('namePhrase', () => {
  it('writes up to three names in full', () => {
    expect(phrase(['Nora'])).toBe('Nora')
    expect(phrase(['Nora', 'Leo'])).toBe('Nora and Leo')
    expect(phrase(['Nora', 'Leo', 'Aisha'])).toBe('Nora, Leo and Aisha')
  })

  it('cuts four or more to the first two and a count', () => {
    expect(phrase(['Nora', 'Leo', 'Aisha', 'Mira'])).toBe('Nora, Leo and 2 more')
    expect(phrase(['Nora', 'Leo', 'Aisha', 'Mira', 'Daniel', 'Ben'])).toBe('Nora, Leo and 4 more')
  })

  it('keeps the names apart from the joining words', () => {
    expect(namePhrase(['Nora', 'Leo', 'Aisha', 'Mira'])).toEqual([
      { text: 'Nora', name: true },
      { text: ', ', name: false },
      { text: 'Leo', name: true },
      { text: ' and 2 more', name: false },
    ])
    expect(namePhrase(['Nora', 'Leo']).filter((part) => part.name)).toHaveLength(2)
  })
})

describe('projectRightBox', () => {
  it('gives active standard users, people and agents, a checkbox under Selected users', () => {
    expect(projectRightBox(member('Leo'), 'selected')).toBe('editable')
    expect(projectRightBox(member('Mira', { auth_user_id: undefined }), 'selected')).toBe(
      'editable',
    )
    expect(projectRightBox(member('Atlas', agent()), 'selected')).toBe('editable')
  })

  it('gives active org admins a locked one, pending invitations included', () => {
    expect(projectRightBox(member('Nora', { org_role: 'admin' }), 'selected')).toBe('locked')
    const invited = member('Elin', { org_role: 'admin', auth_user_id: undefined })
    expect(projectRightBox(invited, 'selected')).toBe('locked')
  })

  it('gives nobody one under the other settings', () => {
    for (const setting of ['users', 'admins', undefined] as const) {
      expect(projectRightBox(member('Leo'), setting)).toBeNull()
      expect(projectRightBox(member('Nora', { org_role: 'admin' }), setting)).toBeNull()
    }
  })

  it('gives no viewer, Viewer agent, guest or inactive member one', () => {
    for (const extra of [
      { org_role: 'viewer' },
      agent({ org_role: 'viewer' }),
      { org_role: 'guest' },
      { active: false },
      agent({ active: false }),
      { org_role: 'admin', active: false },
    ] as const) {
      expect(projectRightBox(member('Leo', extra), 'selected')).toBeNull()
    }
  })
})
