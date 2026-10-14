import { describe, expect, it } from 'vitest'
import type { Row } from '../store/rows'
import { shapeUser } from '../store/viewModels'
import { namePhrase, offersProjectRight, projectCreatorsIn } from './projectCreators'

/* A home-org member as the roster holds it; a standard user who is an active
   person unless `extra` says otherwise. */
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

const names = (users: { name: string }[]) => users.map((user) => user.name)
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
    member('Atlas', { kind: 'agent', can_create_projects: true }),
    member('Gus', { org_role: 'guest' }),
    member('Ola', { org_role: 'admin' }),
  ]

  it('names org admins first, then every active standard user who is a person', () => {
    expect(names(projectCreatorsIn(roster, 'users'))).toEqual([
      'Nora',
      'Ola',
      'Leo',
      'Aisha',
      'Mira',
    ])
  })

  it('names only the selected standard users beside the admins, pending invitations included', () => {
    expect(names(projectCreatorsIn(roster, 'selected'))).toEqual(['Nora', 'Ola', 'Aisha', 'Mira'])
  })

  it('names only org admins under admins', () => {
    expect(names(projectCreatorsIn(roster, 'admins'))).toEqual(['Nora', 'Ola'])
  })

  it('never names inactive members, viewers, agents or guests', () => {
    const left = names(projectCreatorsIn(roster, 'users'))
    for (const name of ['Emil', 'Ingrid', 'Atlas', 'Gus']) expect(left).not.toContain(name)
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

describe('offersProjectRight', () => {
  it('offers the checkbox to active standard users who are people under Selected users', () => {
    expect(offersProjectRight(member('Leo'), 'selected')).toBe(true)
    expect(offersProjectRight(member('Mira', { auth_user_id: undefined }), 'selected')).toBe(true)
  })

  it('offers it to nobody under the other settings', () => {
    expect(offersProjectRight(member('Leo'), 'users')).toBe(false)
    expect(offersProjectRight(member('Leo'), 'admins')).toBe(false)
  })

  it('offers it to no admin, viewer, guest, agent or inactive member', () => {
    for (const extra of [
      { org_role: 'admin' },
      { org_role: 'viewer' },
      { org_role: 'guest' },
      { kind: 'agent' },
      { active: false },
    ] as const) {
      expect(offersProjectRight(member('Leo', extra), 'selected')).toBe(false)
    }
  })
})
